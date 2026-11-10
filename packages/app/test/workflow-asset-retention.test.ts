import { prepareWorkflowApp } from './fixtures/workflow-app.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as core from '@dinkster/core'
import { createComponent } from 'solid-js'
import { renderToString } from 'solid-js/web'
import {
  DINKSTER_SCHEMA_WIRE_VERSION, EMPTY_CONNECTIVITY, MASK_PAINT_SOURCE_EXT_KEY, asConnectionId, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asPromptId, asValueSourceId, coreCommandRegistry, createLocalSession, documentNodeResolver, elaborateInterface,
  serializeSelection, type GraphDef, type NodeSchema, type WorkflowDocument,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import type { DinksterConnection, RetainedAssets, RetainedAssetOwner, RetainedAssetDeclaration } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { GLSL_EDITOR_KIND } from '../src/editors.js'
import { admitWorkflowDispatch, executionAssetRoots, readAssetPreview, reconcileWorkflowRetentions, retainExecutionAssets, RetainedAssetReader, workflowAssetRoots } from '../src/workflow-asset-retention.js'
import { initializeProjectScope, scopedStorageKey } from '../src/projects.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { createPreviewLoader } from '../src/node-previews.js'
import { ProblemsPanel } from '../src/ProblemsPanel.js'
import { SharedWorkerDocumentAuthority, type WorkerPortLike } from '../src/shared-worker-authority.js'
import { SharedWorkerTabAuthority } from '../src/workspace-worker-authority.js'
import { stampAssetLocations } from '../src/workflow-asset-locations.js'

const asset = (letter: string) => ({ digest: `blake3:${letter.repeat(64)}`, name: `${letter}.bin`,
  size: 7, mediaType: 'application/octet-stream', virtualPath: '' })
const schema: NodeSchema = {
  type: 'Loader', displayName: 'Loader', category: 'test', source: 'v3', isOutputNode: false,
  items: [{ kind: 'input', id: 'files', optional: false,
    type: { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } } }],
}
const resolve = (type: string) => type === 'Loader' ? schema : undefined
function session(files = [asset('a')]) {
  const document: WorkflowDocument = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('retention'), root: asGraphDefId('g0'),
    graphs: { g0: { id: asGraphDefId('g0'), name: 'Root', nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: { files } },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } }, view: { graphs: {} },
  }
  return createLocalSession(document, coreCommandRegistry([], resolve))
}
const replace = (letter: string) => ({ command: 'node.setValue', params: {
  graphId: 'g0', nodeId: 'n0', inputId: 'files', value: [asset(letter)],
} })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('workflow retention recovery', () => {
  it.each(['acknowledged', 'lost-release', 'reused-owner', 'refused-handoff', 'disconnected'] as const)(
    'holds independent source reads until successful handoff and reconciles retirement: %s', async (scenario) => {
      const f = recoveryFixture()
      f.entries.clear()
      vi.stubGlobal('localStorage', f.storage)
      const owners = new Map<string, RetainedAssets>()
      const ack = deferred<void>()
      const handoff = deferred<boolean>()
      const entered = deferred<void>()
      const statusListeners = new Set<() => void>()
      const connection = {
        id: asConnectionId('source-reads'), assetUrl: () => 'http://test/api/assets/',
        status: { subscribe: (callback: () => void) => {
          statusListeners.add(callback)
          return () => { statusListeners.delete(callback) }
        } },
        retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
          const retained = { ...owner, ...declaration, revision: 1 }
          owners.set(owner.ownerId, retained)
          await ack.promise
          return retained
        },
        fetchRetainedAssets: async (owner: RetainedAssetOwner) => owners.get(owner.ownerId),
        releaseRetainedAssets: async (owner: RetainedAssetOwner, revision: number) => {
          const before = owners.get(owner.ownerId)!
          expect(revision).toBe(1)
          if (scenario === 'reused-owner') {
            owners.set(owner.ownerId, { ...before, revision: 3, digests: [asset('f').digest] })
            throw new Error('revision conflict')
          }
          const released = { ...before, revision: 2, digests: [], complete: true }
          owners.set(owner.ownerId, released)
          if (scenario === 'lost-release') throw new Error('lost response')
          return released
        },
      } as unknown as DinksterConnection
      let consumed = false
      const operation = readAssetPreview(connection, asset('a').digest, async () => {
        consumed = true
        return { nested: asset('b') }
      }, () => true, async (value) => {
        expect(value).toEqual({ nested: asset('b') })
        entered.resolve()
        return handoff.promise
      })
      expect(consumed).toBe(false)
      ack.resolve()
      await entered.promise
      const original = [...owners.values()][0]!
      expect(original.digests).toEqual([asset('a').digest])
      expect(original.revision).toBe(1)
      // A second read of the same digest has its own durable generation.
      await readAssetPreview(connection, asset('a').digest, async () => 'independent', () => true)
      const independent = [...owners.values()][1]!
      expect(independent.ownerId).not.toBe(original.ownerId)
      if (scenario === 'disconnected') for (const listener of statusListeners) listener()
      handoff.resolve(scenario !== 'refused-handoff')
      expect(await operation).toEqual({ nested: asset('b') })
      expect(owners.get(independent.ownerId)).toEqual(independent)
      const released = scenario === 'acknowledged' || scenario === 'lost-release'
      expect(owners.get(original.ownerId)?.revision).toBe(released ? 2 : scenario === 'reused-owner' ? 3 : 1)
      const key = scopedStorageKey(`dinkster.workflow-retentions.${original.ownerId}`)
      const intent = JSON.parse(f.storage.getItem(key)!)
      expect(intent.acknowledgedRevision).toBe(released ? 2 : 1)
      expect(intent.releaseRevision).toBe(scenario === 'refused-handoff' || scenario === 'disconnected' ? undefined : 1)
      expect(await reconcileWorkflowRetentions(connection, new AbortController().signal, f.storage))
        .toBe(scenario !== 'reused-owner')
    })

  it('journals exact source authority before claim and reconciles lost claims without replay or root substitution', async () => {
    const offer = { token: '0123456789abcdef'.repeat(2), scope: 'local', jobRef: 'original-job', attemptId: 2,
      nodeId: 'n0', outputId: 'images', publication: 3, digests: [asset('a').digest, asset('b').digest], complete: true }
    const ref = { connection: asConnectionId('source-owner'), prompt: asPromptId('job') }
    for (const response of ['acknowledged', 'lost', 'foreign-source', 'missing-root'] as const) {
      const entries = new Map<string, string>()
      const storage = {
        get length() { return entries.size }, key: (index: number) => [...entries.keys()][index] ?? null,
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => { entries.set(key, value) },
      }
      let saved!: RetainedAssets
      const claimResultAssets = vi.fn(async (owner: RetainedAssetOwner, token: string) => {
        const intent = JSON.parse([...entries.values()][0]!)
        expect(intent.sourceToken).toBe(offer.token)
        expect(intent.digests).toEqual([asset('a').digest, asset('b').digest])
        saved = { ...owner, revision: 1, sourceToken: token, digests: [...offer.digests], complete: true }
        if (response === 'foreign-source') saved = { ...saved, sourceToken: 'f'.repeat(32) }
        if (response === 'missing-root') saved = { ...saved, digests: [asset('a').digest] }
        if (response !== 'acknowledged') throw new Error('lost claim response')
        return saved
      })
      const connection = { id: ref.connection, assetUrl: () => 'http://test/api/assets/',
        claimResultAssets, fetchRetainedAssets: async () => saved } as unknown as DinksterConnection
      const pending = retainExecutionAssets(connection, ref, offer, storage)
      if (response === 'acknowledged' || response === 'lost') {
        expect(await pending).toEqual(saved)
        expect(JSON.parse([...entries.values()][0]!).acknowledgedRevision).toBe(1)
        expect(await reconcileWorkflowRetentions(connection, new AbortController().signal, storage)).toBe(true)
      } else {
        await expect(pending).rejects.toThrow('lost claim response')
        expect(JSON.parse([...entries.values()][0]!).acknowledgedRevision).toBeUndefined()
        expect(await reconcileWorkflowRetentions(connection, new AbortController().signal, storage)).toBe(false)
      }
      expect(claimResultAssets).toHaveBeenCalledTimes(1)
    }
  })

  it('closes receipt-bound reader admission but waits for every admitted body without releasing protection', async () => {
    const receipt: RetainedAssets = { scope: 'local', ownerKind: 'shown-result', ownerId: 'result-reader',
      revision: 1, complete: false, digests: [asset('a').digest] }
    const releaseRetainedAssets = vi.fn()
    const connection = { releaseRetainedAssets } as unknown as DinksterConnection
    const reader = new RetainedAssetReader(connection, receipt, () => true)
    const replacement = new RetainedAssetReader(connection, { ...receipt, ownerId: 'replacement' }, () => true)
    const bodies = [0, 1].map(() => {
      let body!: ReadableStreamDefaultController<Uint8Array>
      const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }))
      return { body, response }
    })
    const started = deferred<void>()
    let count = 0
    const reads = bodies.map(({ response }) => reader.read(async () => {
      if (++count === 2) started.resolve()
      return response.arrayBuffer()
    }).then(() => 'published', () => 'refused'))
    await started.promise
    let settled = false
    const close = reader.close().then(() => { settled = true })
    await expect(reader.read(async () => new ArrayBuffer(1))).rejects.toThrow('closed')
    bodies[0]!.body.close()
    expect(await reads[0]).toBe('refused')
    expect(settled).toBe(false)
    const live = await replacement.read(async () => new Uint8Array([17, 31]).buffer)
    expect([...new Uint8Array(live)]).toEqual([17, 31])
    bodies[1]!.body.error(new Error('body failed'))
    expect(await reads[1]).toBe('refused')
    await close
    expect(settled).toBe(true)
    expect(reader.retained).toBe(receipt)
    expect(releaseRetainedAssets).not.toHaveBeenCalled()
  })

  it('retains nested preview documents and ring resources without certifying opaque payloads', () => {
    const binary = new Uint8Array([1, 3, 7])
    const payload: Record<string, unknown> = { documentDigest: asset('c').digest,
      document: { resources: { source: { digest: asset('e').digest } } }, binary,
      unknown: { metadata: 'opaque', malformed: { digest: 'not-a-digest' } } }
    payload.cycle = payload
    const frame = { channel: 'application/json', timestamp: 3, payload }
    const roots = executionAssetRoots({ outputs: { node: { result: { meta: { digest: asset('a').digest } } } },
      artifacts: [], previews: { node: { document: frame } },
      previewRings: { node: { stream: { frameCount: 2, frames: { 1: { ...frame, payload: { digest: asset('f').digest } } } } } },
      lastPreview: { ...frame, payload: binary.buffer } }, () => undefined)
    expect(roots).toEqual({ complete: false, digests: [asset('a').digest, asset('c').digest, asset('e').digest, asset('f').digest] })
  })

  afterEach(() => {
    initializeProjectScope('default')
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  function recoveryFixture() {
    const entries = new Map<string, string>()
    const storage: Storage = {
      get length() { return entries.size },
      key: (index) => [...entries.keys()][index] ?? null,
      getItem: (key) => entries.get(key) ?? null,
      setItem: (key, value) => { entries.set(key, value) },
      removeItem: (key) => { entries.delete(key) },
      clear: () => entries.clear(),
    }
    const owner = { scope: 'local', ownerKind: 'document', ownerId: 'workflow-candidate:recovered' } as const
    const intent = { version: 3, connectionId: 'native', assetBaseUrl: 'http://native/api/assets/', owner,
      documentLineage: 'restored-document', documentRevision: 7, complete: false,
      digests: [asset('a').digest, asset('c').digest] }
    const acknowledgment: RetainedAssets = { ...owner, revision: 1, complete: false, digests: intent.digests }
    const fetchRetainedAssets = vi.fn().mockResolvedValue(acknowledgment)
    const connection = { id: 'native', assetUrl: () => intent.assetBaseUrl, fetchRetainedAssets,
      retainAssets: vi.fn(), releaseRetainedAssets: vi.fn() } as unknown as DinksterConnection
    const key = scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`)
    entries.set(key, JSON.stringify(intent))
    return { entries, storage, intent, acknowledgment, connection, fetchRetainedAssets, key }
  }

  it.each(['match', 'missing', 'revision', 'complete', 'roots', 'owner', 'scope', 'kind', 'unavailable', 'changed'])(
    'keeps the journal and reconciles only an exact observation: %s', async (scenario) => {
      const f = recoveryFixture()
      const original = f.entries.get(f.key)!
      if (scenario === 'missing') f.fetchRetainedAssets.mockResolvedValue(undefined)
      if (scenario === 'revision') f.fetchRetainedAssets.mockResolvedValue({ ...f.acknowledgment, revision: 2 })
      if (scenario === 'complete') f.fetchRetainedAssets.mockResolvedValue({ ...f.acknowledgment, complete: true })
      if (scenario === 'roots') f.fetchRetainedAssets.mockResolvedValue({ ...f.acknowledgment, digests: [asset('a').digest, asset('b').digest] })
      if (scenario === 'owner') f.fetchRetainedAssets.mockResolvedValue({ ...f.acknowledgment, ownerId: 'workflow-candidate:other' })
      if (scenario === 'scope') f.fetchRetainedAssets.mockResolvedValue({ ...f.acknowledgment, scope: 'shared' })
      if (scenario === 'kind') f.fetchRetainedAssets.mockResolvedValue({ ...f.acknowledgment, ownerKind: 'read' })
      if (scenario === 'unavailable') f.fetchRetainedAssets.mockRejectedValue(new Error('offline'))
      if (scenario === 'changed') f.fetchRetainedAssets.mockImplementation(async () => {
        f.entries.set(f.key, `${original} `)
        return f.acknowledgment
      })
      expect(await reconcileWorkflowRetentions(f.connection, new AbortController().signal, f.storage)).toBe(scenario === 'match')
      expect(f.entries.get(f.key)).toBe(scenario === 'changed' ? `${original} ` : original)
      expect(f.connection.retainAssets).not.toHaveBeenCalled()
      expect(f.connection.releaseRetainedAssets).not.toHaveBeenCalled()
    },
  )

  it.each(['json', 'version', 'owner', 'empty-owner', 'lineage', 'revision', 'acknowledgment', 'digest', 'duplicate', 'unsorted', 'complete'])(
    'does not query or discard a malformed journal: %s', async (scenario) => {
      const f = recoveryFixture()
      const intent: Record<string, unknown> = { ...f.intent }
      if (scenario === 'version') intent.version = 2
      if (scenario === 'owner') intent.owner = { ...f.intent.owner, ownerId: 'workflow-candidate:other' }
      if (scenario === 'empty-owner') intent.owner = { ...f.intent.owner, ownerId: 'workflow-candidate:' }
      if (scenario === 'lineage') intent.documentLineage = ''
      if (scenario === 'revision') intent.documentRevision = -1
      if (scenario === 'acknowledgment') intent.acknowledgedRevision = 2
      if (scenario === 'digest') intent.digests = ['blake3:invalid']
      if (scenario === 'duplicate') intent.digests = [asset('a').digest, asset('a').digest]
      if (scenario === 'unsorted') intent.digests = [asset('c').digest, asset('a').digest]
      if (scenario === 'complete') intent.complete = 'false'
      const bytes = scenario === 'json' ? '{' : JSON.stringify(intent)
      f.entries.set(f.key, bytes)
      expect(await reconcileWorkflowRetentions(f.connection, new AbortController().signal, f.storage)).toBe(false)
      expect(f.fetchRetainedAssets).not.toHaveBeenCalled()
      expect(f.entries.get(f.key)).toBe(bytes)
    },
  )

  it.each(['connection', 'endpoint', 'project'])(
    'leaves foreign journals untouched without routing requests: %s', async (scenario) => {
      const f = recoveryFixture()
      if (scenario === 'connection') f.entries.set(f.key, JSON.stringify({ ...f.intent, connectionId: 'other' }))
      if (scenario === 'endpoint') f.entries.set(f.key, JSON.stringify({ ...f.intent, assetBaseUrl: 'http://foreign/api/assets/' }))
      if (scenario === 'project') initializeProjectScope('p-other')
      const before = [...f.entries]
      expect(await reconcileWorkflowRetentions(f.connection, new AbortController().signal, f.storage)).toBe(true)
      expect(f.fetchRetainedAssets).not.toHaveBeenCalled()
      expect([...f.entries]).toEqual(before)
    },
  )

  it('reports inaccessible storage and canceled observations as unresolved', async () => {
    const f = recoveryFixture()
    vi.stubGlobal('localStorage', undefined)
    expect(await reconcileWorkflowRetentions(f.connection, new AbortController().signal)).toBe(false)
    const controller = new AbortController()
    const pending = deferred<RetainedAssets>()
    f.fetchRetainedAssets.mockReturnValue(pending.promise)
    const result = reconcileWorkflowRetentions(f.connection, controller.signal, f.storage)
    controller.abort()
    pending.resolve(f.acknowledgment)
    expect(await result).toBe(false)
    expect(f.entries.size).toBe(1)
  })

  it.each(['reconnect', 'disconnect', 'remove', 'dispose'] as const)(
    'reconciles through the socket lifecycle and ignores late results after %s', async (scenario) => {
      const f = recoveryFixture()
      f.entries.clear()
      vi.stubGlobal('localStorage', f.storage)
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      const sockets: FakeSocket[] = []
      class FakeSocket {
        binaryType = ''
        onopen: ((event: unknown) => void) | null = null
        onclose: ((event: unknown) => void) | null = null
        onmessage = null
        onerror = null
        constructor() { sockets.push(this) }
        send() {}
        close() {}
      }
      vi.stubGlobal('WebSocket', FakeSocket)
      const requests: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<Response>> }> = []
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/api/library/retentions/')) {
          expect(init?.method).toBe('GET')
          expect(init?.cache).toBe('no-store')
          const result = deferred<Response>()
          requests.push({ signal: init!.signal!, result })
          return result.promise
        }
        return new Response('{}', { status: 503 })
      }))
      const app = prepareWorkflowApp(new AppState())
      try {
        const backend = app.addBackend('http://native:8000', 'Recovery native', false, 'dinkster')!
        const intent = { ...f.intent, connectionId: backend.id, assetBaseUrl: backend.connection.assetUrl('') }
        const bytes = JSON.stringify(intent)
        f.entries.set(f.key, bytes)
        const notices = () => app.problems.get().filter((problem) => problem.code === 'workflow.retention.unresolved')
        backend.connection.connect()
        sockets.at(-1)!.onopen?.({})
        expect(requests).toHaveLength(1)
        requests[0]!.result.resolve(new Response('{}', { status: 404 }))
        await vi.waitFor(() => expect(notices()).toHaveLength(1))
        backend.connection.disconnect()
        backend.connection.connect()
        sockets.at(-1)!.onopen?.({})
        expect(requests).toHaveLength(2)
        if (scenario === 'reconnect') {
          backend.connection.disconnect()
          backend.connection.connect()
          sockets.at(-1)!.onopen?.({})
          expect(requests).toHaveLength(3)
          requests[2]!.result.resolve(new Response(JSON.stringify(f.acknowledgment)))
          await vi.waitFor(() => expect(notices()).toHaveLength(0))
        } else if (scenario === 'disconnect') backend.connection.disconnect()
        else if (scenario === 'remove') app.removeBackend(backend.id)
        else app.dispose()
        expect(requests[1]!.signal.aborted).toBe(true)
        requests[1]!.result.resolve(new Response('{}', { status: 404 }))
        await requests[1]!.result.promise
        // Drain response decoding and the reconciliation continuation without a wall-clock wait.
        await new Promise<void>((done) => setImmediate(done))
        expect(notices()).toHaveLength(scenario === 'reconnect' || scenario === 'remove' ? 0 : 1)
        expect(f.entries.get(f.key)).toBe(bytes)
      } finally {
        app.dispose()
      }
    },
  )
})

describe('retained app dispatch', () => {
  let app: AppState | undefined
  const captureDownloads = (): Blob[] => {
    const downloads: Blob[] = []
    vi.stubGlobal('document', { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } })
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      downloads.push(blob as Blob)
      return 'blob:workflow-download'
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return downloads
  }
  afterEach(() => {
    app?.dispose()
    app = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each(['acknowledged', 'lost', 'rejected', 'removed', 'missing-seal', 'unoffered-output',
    'unoffered-artifact', 'foreign-artifact', 'intermediate-offer', 'foreign-attempt'] as const)(
    'admits completed outputs and artifacts through sealed source claims: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([{ ...schema, isOutputNode: true }])
      await app.openDocument(session().doc, 'Terminal source')
      const tab = app.activeTab()!
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      backend.registry.set(app.registry.get())
      app.setTabTarget(tab.id, backend.id)
      const compiled = app.compileTab(tab)
      if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
      const ref = { connection: backend.id, prompt: asPromptId('terminal-source') }
      app.store.register(ref, compiled.artifact, 1, { jobRef: 'original-job' })
      const artifact = { ...asset('b'), nodeId: 'n0' }
      const outputs = { n0: { images: { typeId: 'ASSET', fingerprint: 'saved', meta: asset('b') } } }
      vi.spyOn(backend.connection, 'fetchJob').mockResolvedValue({ state: 'completed', jobRef: 'original-job',
        attemptId: 2, outputs: scenario === 'unoffered-output' ? { ...outputs, extra: { result: { meta: asset('c') } } } : outputs,
        artifacts: scenario === 'unoffered-artifact' ? [artifact, { ...asset('c'), nodeId: 'extra' }] : [artifact] })
      const offer = { token: 'a'.repeat(32), scope: 'local', jobRef: 'original-job', attemptId: 2,
        nodeId: 'n0', outputId: 'images', publication: 7, digests: [asset('a').digest, asset('b').digest], complete: true }
      const artifactOffer = { token: 'b'.repeat(32), scope: 'local', jobRef: 'original-job', attemptId: 2,
        nodeId: 'n0', artifact: { ...artifact, ...(scenario === 'foreign-artifact' ? { digest: asset('c').digest } : {}), index: 0 },
        publication: 1, digests: [asset('b').digest], complete: true }
      const intermediateOffer = { ...offer, token: 'c'.repeat(32), nodeId: 'region[0]/inner',
        outputId: 'scratch', digests: [asset('c').digest] }
      const sources = [offer, artifactOffer, ...(scenario === 'intermediate-offer' ? [intermediateOffer] : [])]
      vi.spyOn(backend.connection, 'fetchTerminalResultAssets').mockResolvedValue(scenario === 'missing-seal' ? undefined : {
        scope: 'local', jobRef: 'original-job', attemptId: scenario === 'foreign-attempt' ? 3 : 2,
        state: 'completed', complete: true, offers: sources })
      const admitted = deferred<void>()
      const requested = deferred<void>()
      const saved = new Map<string, RetainedAssets>()
      vi.spyOn(backend.connection, 'claimResultAssets').mockImplementation(async (owner, sourceToken) => {
        const source = sources.find((candidate) => candidate.token === sourceToken)!
        const receipt = { ...owner, sourceToken, revision: 1, digests: [...source.digests], complete: true }
        if (scenario !== 'rejected' || source === offer) saved.set(owner.ownerId, receipt)
        if (source === offer) return receipt
        requested.resolve()
        await admitted.promise
        if (scenario === 'lost' || scenario === 'rejected') throw new Error('claim response unavailable')
        return receipt
      })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => saved.get(owner.ownerId))
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) => ({ ...owner, ...declaration, revision: 1 }))
      backend.connection.ingest({ type: 'job_state', jobId: ref.prompt, state: 'completed' })
      if (['missing-seal', 'unoffered-output', 'unoffered-artifact', 'foreign-artifact', 'foreign-attempt'].includes(scenario)) {
        admitted.resolve()
        await new Promise<void>((done) => setImmediate(done))
        expect(app.store.get(ref)?.outputs).toEqual({})
        expect(app.store.get(ref)?.artifacts).toEqual([])
        return
      }
      await requested.promise
      expect(app.store.get(ref)?.outputs).toEqual({})
      expect(app.store.get(ref)?.artifacts).toEqual([])
      if (scenario === 'removed') app.removeBackend(backend.id)
      admitted.resolve()
      if (scenario === 'acknowledged' || scenario === 'lost' || scenario === 'intermediate-offer') {
        await vi.waitFor(() => expect(app!.store.get(ref)?.outputs).toEqual(outputs))
        expect(app.store.get(ref)?.artifacts).toEqual([artifact])
        const receipts = app.store.get(ref)?.assetRetentions ?? []
        for (const receipt of saved.values()) expect(receipts).toContainEqual(receipt)
        expect(new Set([...saved.values()].map((receipt) => receipt.sourceToken))).toEqual(new Set(sources.map((source) => source.token)))
        expect(new Set([...saved.values()].flatMap((receipt) => receipt.digests))).toEqual(new Set(sources.flatMap((source) => source.digests)))
      } else {
        await new Promise<void>((done) => setImmediate(done))
        expect(app.store.get(ref)?.outputs).toEqual({})
        expect(app.store.get(ref)?.artifacts).toEqual([])
      }
    },
  )

  it.each(['acknowledged', 'lost', 'rejected', 'foreign-job'] as const)(
    'admits a value through its original full parent source before publication: %s', async (scenario) => {
      const offer = { token: '0123456789abcdef'.repeat(2), scope: 'local', jobRef: 'original-job', attemptId: 2,
        nodeId: 'n0', outputId: 'images', publication: 3, digests: [asset('a').digest, asset('b').digest], complete: true }
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      vi.stubGlobal('fetch', async (url: string) => url.includes('/api/values?')
        ? new Response(JSON.stringify({ available: true, descriptor: { typeId: 'INT', fingerprint: 'child', value: 9 },
          renditions: [], resultOffer: offer }), { status: 200 })
        : new Response('{}', { status: 503 }))
      app = createWorkflowApp([{ ...schema, isOutputNode: true }])
      await app.openDocument(session().doc, 'Value source')
      const tab = app.activeTab()!
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      backend.registry.set(app.registry.get())
      app.setTabTarget(tab.id, backend.id)
      const compiled = app.compileTab(tab)
      if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
      const ref = { connection: backend.id, prompt: asPromptId('value-source') }
      app.store.register(ref, compiled.artifact, 1, { jobRef: scenario === 'foreign-job' ? 'other-job' : offer.jobRef })
      const response = deferred<RetainedAssets>()
      const requested = deferred<RetainedAssets>()
      let saved: RetainedAssets | undefined
      vi.spyOn(backend.connection, 'claimResultAssets').mockImplementation(async (owner, sourceToken) => {
        saved = { ...owner, sourceToken, revision: 1, digests: [asset('a').digest, asset('b').digest], complete: true }
        requested.resolve(saved)
        if (scenario === 'lost') throw new Error('lost response')
        if (scenario === 'rejected') throw new Error('unavailable source')
        return response.promise
      })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockImplementation(async () => scenario === 'lost' ? saved : undefined)
      let published = false
      const pending = backend.connection.values().peek({ jobId: ref.prompt, nodeId: 'n0', outputId: 'images', element: [1] })
        .then((result) => { published = result.available; return result })
      if (scenario === 'acknowledged') {
        const receipt = await requested.promise
        expect(published).toBe(false)
        response.resolve(receipt)
      }
      const result = await pending
      expect(result.available).toBe(scenario === 'acknowledged' || scenario === 'lost')
      if (result.available) expect(result.resultOffer?.digests).toEqual([asset('a').digest, asset('b').digest])
      else expect(result.reason).toBe('ownership-unconfirmed')
    },
  )

  it.each([false, true])('certifies parsed App View layout only when every stored field round-trips, unknown=%s', async (unknown) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const document: WorkflowDocument = { ...session().doc, ext: { 'dinkster.appLayout': {
      mobile: { items: [], customized: false },
      desktop: { items: [{ text: 'Instructions', role: 'heading', kind: 'text', id: 'instructions',
        ...(unknown ? { future: { nested: asset('b') } } : {}),
      }] }, version: 1,
    } } }
    expect((await app.openDocument(document, 'App View ownership'))).toEqual([])
    const tab = app.activeTab()!
    expect(workflowAssetRoots(tab.store.doc, tab.store.historySnapshot(), resolve)).toEqual({
      complete: !unknown, digests: unknown ? [asset('a').digest, asset('b').digest] : [asset('a').digest],
    })
    if (unknown) {
      expect(await app.shareActiveTab()).toBe('Workflow ownership unconfirmed. Publication and sharing remain unavailable.')
      expect(await app.saveWorkflow(tab.id)).toBe(false)
    }
    const downloads = captureDownloads()
    const before = app.exportDocument(tab.id)
    const retention = vi.mocked(app.connection.retainAssets)
    retention.mockClear()
    expect(await app.exportWorkflow(tab.id)).toBe(true)
    expect(JSON.parse(await downloads[0]!.text())).toEqual(before)
    expect(retention).not.toHaveBeenCalled()
  })

  it.each(['warning', 'error'] as const)('keeps generated-id warnings visible while shared ownership admits only valid identities: %s', async (severity) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const local = session()
    const root = local.doc.graphs.g0!
    const document: WorkflowDocument = { ...local.doc, graphs: {
      g0: { ...root, nodes: { instance: { id: asNodeId('instance'), type: '#inner', values: {},
        ...(severity === 'error' ? { dynamic: { unknown: { members: [], seq: 0 } } } : {}),
      } } },
      inner: { ...root, id: asGraphDefId('inner'), boundary: {
        inputs: [{ id: asPortId('workflow.input.files'), binds: { kind: 'port', node: asNodeId('n0'), port: asPortId('files') } }],
        outputs: [],
      } },
    } }
    const opened = await app.openDocument(document, 'Generated boundary')
    if (severity === 'error') {
      expect(opened).toContainEqual(expect.objectContaining({ code: 'workflow.open.retention' }))
      app.dispose()
      app = createWorkflowApp([schema], document)
    } else expect(opened).toEqual([])
    const tab = app.activeTab()!
    const resolveDocument = documentNodeResolver(document, app.registryForTab(tab)!.resolve)
    const instance = document.graphs.g0!.nodes.instance!
    const diagnostics = elaborateInterface(resolveDocument('g0', instance)!, instance, EMPTY_CONNECTIVITY, { includeDormant: true }).diagnostics
    expect(diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'elab.id.reserved' }))
    expect(diagnostics.some((entry) => entry.severity === 'error')).toBe(severity === 'error')
    const documents = new SharedWorkerDocumentAuthority()
    const workspace = new SharedWorkerTabAuthority()
    const channels: MessageChannel[] = []
    const connect = (authority: { connect(port: WorkerPortLike): void }) => {
      const channel = new MessageChannel()
      channels.push(channel)
      authority.connect(channel.port2)
      return channel.port1
    }
    try {
      await app.enableWorkspaceAuthority(() => connect(documents), () => connect(workspace))
      const current = app.activeTab()!
      expect('status' in current.store).toBe(severity === 'warning')
      const roots = workflowAssetRoots(current.store.doc, current.store.historySnapshot(), app.registryForTab(current)!.resolve)
      if (severity === 'warning') {
        expect(roots).toEqual({ complete: true, digests: [asset('a').digest] })
        const records = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
          .filter((key) => key.includes('dinkster.workflow-retentions.'))
          .map((key) => JSON.parse(localStorage.getItem(key)!))
        expect(records).toContainEqual(expect.objectContaining({ complete: true, digests: [asset('a').digest], acknowledgedRevision: 1 }))
      } else {
        expect(roots).toMatchObject({ complete: false, refusal: 'Workflow dynamic identities are invalid' })
        expect(app.problems.get()).toContainEqual(expect.objectContaining({
          code: 'workspace.authority.failed', message: 'Shared workspace unavailable: Workflow dynamic identities are invalid',
        }))
        const downloads = captureDownloads()
        expect(await app.exportWorkflow(current.id)).toBe(false)
        expect(downloads).toHaveLength(0)
      }
      const after = elaborateInterface(resolveDocument('g0', instance)!, instance, EMPTY_CONNECTIVITY, { includeDormant: true }).diagnostics
      expect(after).toEqual(diagnostics)
      const ownerApp = app
      const html = renderToString(() => createComponent(ProblemsPanel, {
        app: ownerApp, diagnostics: () => after, compatSkips: () => [],
      }))
      expect(html).toContain('elab.id.reserved')
      expect(html).toContain('workflow.input.files')
    } finally {
      app.dispose()
      for (const channel of channels) {
        channel.port1.close()
        channel.port2.close()
      }
    }
  })

  it('opens and executes valid active roots but keeps unsupported dormant ownership ineligible and publication refused', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    const dynamic: NodeSchema = { ...schema, items: [{
      kind: 'input', id: 'mode', optional: false, type: { kind: 'concrete', name: 'STRING' },
      dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [{ key: 'active', inputs: [{
        kind: 'input', id: 'file', optional: false, type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } },
        widget: { widgetType: 'ASSET', options: {}, default: asset('a') },
      }] }, { key: 'unsupported', inputs: [{ kind: 'input', id: 'slot', optional: true,
        type: { kind: 'concrete', name: 'STRING' }, dynamic: { kind: 'dynamicSlot', materialization: 'wire15',
          slotType: { kind: 'concrete', name: 'STRING' }, inputs: [] },
      }] }] },
    }] }
    app = createWorkflowApp([dynamic])
    const ownerApp = app
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: {}, dynamic: { mode: { selected: 'active' } } },
    } } } }
    app.backends.get()[0]!.templatesEnabled.set(true)
    vi.spyOn(app.connection, 'fetchTemplateBody').mockResolvedValue(document)
    expect(await app.openTemplate('test', 'dormant', 'Dormant ownership', app.connection.id)).toBe(true)
    const tab = app.activeTab()!
    expect(await app.shareActiveTab()).toBe('Workflow dynamic identities are invalid. Publication and sharing remain unavailable.')
    const downloads = captureDownloads()
    const before = app.exportDocument(tab.id)
    const warnings = app.problems.get().filter((problem) => problem.code === 'workflow.execution.ownershipUnconfirmed')
    expect(warnings).not.toHaveLength(0)
    const retention = vi.mocked(app.connection.retainAssets)
    retention.mockClear()
    expect(await app.exportWorkflow(tab.id)).toBe(true)
    expect(JSON.parse(await downloads[0]!.text())).toEqual(before)
    expect(retention).not.toHaveBeenCalled()
    expect(app.problems.get().filter((problem) => problem.code === 'workflow.execution.ownershipUnconfirmed')).toEqual(warnings)
    expect(await app.saveWorkflow(tab.id)).toBe(false)
    const documents = new SharedWorkerDocumentAuthority()
    const workspace = new SharedWorkerTabAuthority()
    const channels: MessageChannel[] = []
    const connect = (authority: { connect(port: WorkerPortLike): void }) => {
      const channel = new MessageChannel()
      channels.push(channel)
      authority.connect(channel.port2)
      return channel.port1
    }
    try {
      await app.enableWorkspaceAuthority(() => connect(documents), () => connect(workspace))
      const shared = app.activeTab()!
      expect(shared.id).toBe(tab.id)
      expect('status' in shared.store).toBe(true)
      vi.spyOn(app.connection, 'uploadAsset').mockResolvedValue(asset('c').digest)
      const execution = { connection: app.connection.id, prompt: asPromptId('dormant-run') }
      vi.spyOn(app.connection, 'submit').mockResolvedValue({ ok: true, execution })
      await app.queueSelection(shared, ['n0'])
      expect(app.store.get(execution)?.artifact?.snapshot).toBeDefined()
      const records = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
        .filter((key) => key.includes('dinkster.workflow-retentions.'))
        .map((key) => JSON.parse(localStorage.getItem(key)!))
      expect(records).toContainEqual(expect.objectContaining({ complete: false, digests: [asset('a').digest],
        acknowledgedRevision: 1, incompleteDiagnostics: [expect.objectContaining({ severity: 'error',
          code: 'elab.dormant.unsupported', message: expect.stringContaining('Loader (n0)'),
        })] }))
      const html = renderToString(() => createComponent(ProblemsPanel, {
        app: ownerApp, diagnostics: () => ownerApp.problems.get(), compatSkips: () => [],
      }))
      expect(html).toContain('Workflow ownership unconfirmed.')
      expect(html).toContain('Loader (n0): Dormant wire15 inputs require branch-specific identity resolution')
      expect(html).toContain('Publication and sharing remain unavailable.')
      const beforePublication = shared.store.doc
      const prepared = shared.store.prepareDispatch!(replace('b'))
      if (!prepared.ok) throw new Error('candidate rejected before retention')
      await expect(admitWorkflowDispatch(app.connection, prepared, () => dynamic, () => true))
        .rejects.toThrow('Workflow dynamic identities are invalid')
      expect(shared.store.doc).toBe(beforePublication)
      // Incomplete roots never establish cleanup eligibility, even after exact acknowledgment.
      expect(records.some((record) => record.complete && record.digests.includes(asset('a').digest))).toBe(false)
    } finally {
      app.dispose()
      for (const channel of channels) {
        channel.port1.close()
        channel.port2.close()
      }
    }
  })

  it('renders exact unresolved stored inputs after an incomplete workflow open', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const document = session().doc
    const incoming = { ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
      n0: { ...document.graphs.g0!.nodes.n0!, values: { files: [asset('a')], future: asset('b') } },
    } } } }
    expect(await app.importWorkflowFile({ name: 'unresolved.json', text: async () => JSON.stringify(incoming) })).toBe(true)
    const ownerApp = app
    const html = renderToString(() => createComponent(ProblemsPanel, {
      app: ownerApp, diagnostics: () => ownerApp.problems.get(), compatSkips: () => [],
    }))
    expect(html).toContain('Workflow ownership unconfirmed.')
    expect(html).toContain("Loader (n0): Stored input 'future' has no resolved input schema")
    expect(html).toContain('Publication and sharing remain unavailable.')
    expect(app.connection.retainAssets).toHaveBeenCalledWith(expect.anything(), {
      revision: 0, complete: false, digests: [asset('a').digest, asset('b').digest],
    })
  })

  it.each(['active', 'dormant', 'invalid', 'dormant-invalid', 'unknown'] as const)('classifies %s nested wire15 state without certifying opaque values', (variant) => {
    const codec: NodeSchema['items'][number] = {
      kind: 'input', id: 'codec', optional: false, type: { kind: 'concrete', name: 'STRING' },
      dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [{ key: 'auto', inputs: [] }] },
    }
    const dynamic: NodeSchema = { ...schema, items: [{
      kind: 'input', id: 'format', optional: false, type: { kind: 'concrete', name: 'STRING' },
      dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [
        { key: 'auto', inputs: variant === 'dormant' || variant === 'dormant-invalid' ? [] : [codec] },
        { key: 'other', inputs: variant === 'dormant' || variant === 'dormant-invalid' ? [codec] : [] },
      ] },
    }] }
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: { opaque: asset('a') }, dynamic: {
        format: { selected: 'auto' },
        [variant === 'unknown' ? 'format.unrelated' : 'format.codec']: {
          selected: variant === 'invalid' || variant === 'dormant-invalid' ? 'bad' : 'auto',
        },
      } },
    } } } }
    const history = createLocalSession(document, coreCommandRegistry([], () => dynamic)).historySnapshot()
    const roots = workflowAssetRoots(document, history, () => dynamic, [], 'admission')
    expect(roots.complete).toBe(false)
    expect(roots.digests).toEqual([asset('a').digest])
    expect(roots.refusal).toBe(variant === 'active' || variant === 'dormant' ? undefined : 'Workflow dynamic identities are invalid')
    if (variant === 'active' || variant === 'dormant') {
      const stored = elaborateInterface(dynamic, document.graphs.g0!.nodes.n0!, EMPTY_CONNECTIVITY, { includeDormant: true })
      expect(stored.diagnostics).toEqual([])
      expect(roots.incompleteDiagnostics).toEqual([expect.objectContaining({
        code: 'workflow.asset.unresolvedInput', message: "Loader (n0): Stored input 'opaque' has no resolved input schema",
      })])
    }
    expect(workflowAssetRoots(document, history, () => dynamic).refusal)
      .toBe(variant === 'active' || variant === 'dormant' ? undefined : 'Workflow dynamic identities are invalid')
  })

  it.each(['artifact', 'associated', 'output', 'model3d', 'retained'] as const)(
    'owns recorded %s fetch, decode and replacement independently of the active tab', async (route) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([schema])
      const ownerApp = app
      const ref = { connection: app.connection.id, prompt: asPromptId('recorded-reader') }
      app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
      const original = { ...asset('a'), nodeId: 'n1', mediaType: route === 'model3d' ? 'model/gltf-binary' : 'image/png' }
      if (route === 'output') app.store.hydrateOutputs(ref, { n1: { image: { typeId: 'ASSET', fingerprint: original.digest, meta: original } } })
      else app.store.hydrateArtifacts(ref, [{ ...original, ...(route === 'associated' ? {
        mediaType: 'image/x-exr', preview: { ...asset('b'), mediaType: 'image/png' },
      } : {}) }])
      const state = app.store.get(ref)!
      const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
      const ack = deferred<RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementationOnce(async (owner, declaration) => {
        requested.resolve({ owner, declaration })
        return ack.promise
      })
      const reads: Array<ReturnType<typeof deferred<void>>> = []
      const decode = async () => { const read = deferred<void>(); reads.push(read); await read.promise }
      class Image {
        src = ''
        naturalWidth = 13
        naturalHeight = 7
        decode = decode
      }
      vi.stubGlobal('Image', Image)
      const urls: string[] = []
      const loader = createPreviewLoader({
        assetUrlForInput: () => '', assetUrlForExecution: (_ref, digest) => `/assets/${digest}`,
        executionAssetReader: (execution, digests) => ownerApp.executionAssetReader(execution, digests),
        fetchRecordedOutput: async (url) => { urls.push(url); return new Response(new Uint8Array([3])) },
        renderModel3dPoster: async () => { await decode(); return { image: {} as CanvasImageSource, width: 13, height: 7 } },
        onDecoded: () => {},
      })
      try {
        expect(app.executionAssetReader(state, [asset('f').digest])).toBeUndefined()
        const presentation = route === 'retained' ? { ...state, artifacts: [...state.artifacts] } : state
        if (route === 'retained') expect(app.executionAssetReader(presentation, [asset('a').digest])).toBeUndefined()
        const source = loader.sourceFor(presentation, ['n1'], false, 0,
          route === 'retained' ? new Map([['n1', state]]) : undefined)!
        const pending = source.load()
        const { owner, declaration } = await requested.promise
        expect(declaration.digests).toEqual(route === 'associated' ? [asset('a').digest, asset('b').digest] : [asset('a').digest])
        expect(urls).toEqual([])
        expect(reads).toHaveLength(0)
        ack.resolve({ ...owner, ...declaration, revision: 1 })
        await vi.waitFor(() => expect(reads).toHaveLength(1))
        expect(urls).toEqual([`/assets/${route === 'associated' ? asset('b').digest : asset('a').digest}`])
        // Editing an unrelated workflow does not retire a result's independent reader.
        expect((await app.openDocument(session().doc, 'Unrelated'))).toEqual([])
        expect((await app.dispatchTo(app.activeTab()!, replace('c'))).ok).toBe(true)
        expect(source.current!()).toBe(true)
        app.store.hydrateArtifacts(ref, [...state.artifacts])
        reads[0]!.resolve()
        await expect(pending).rejects.toThrow('changed')
        expect(loader.resolve(source)).toBeUndefined()
        await expect(source.load()).rejects.toThrow('no longer current')
        const replacement = loader.sourceFor(app.store.get(ref)!, ['n1'], false)!
        expect(replacement.key).not.toBe(source.key)
        const live = replacement.load()
        await vi.waitFor(() => expect(reads).toHaveLength(2))
        reads[1]!.resolve()
        const result = await live
        expect(result).toMatchObject({ width: 13, height: 7 })
        if (route === 'associated') {
          expect([...new Uint8Array(await (await result.download!.load!(new AbortController().signal)).arrayBuffer())]).toEqual([3])
          expect(urls.at(-1)).toBe(`/assets/${asset('a').digest}`)
        }
        loader.resolve(replacement)
        await vi.waitFor(() => expect(reads).toHaveLength(3))
        reads[2]!.resolve()
        await vi.waitFor(() => expect(loader.resolve(replacement)).toMatchObject({ width: 13, height: 7 }))
        app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
        expect(loader.sourceFor(app.store.get(ref)!, ['n1'], false)!.key).toBe(replacement.key)
        app.connection.connect(); app.connection.disconnect()
        expect(replacement.current!()).toBe(false)
        expect(loader.resolve(replacement)).toBeUndefined()
        await expect(replacement.load()).rejects.toThrow('no longer current')
        if (route === 'associated') await expect(result.download!.load!(new AbortController().signal)).rejects.toThrow('no longer current')
        expect(reads).toHaveLength(3)
      } finally { reads.forEach((read) => read.resolve()); loader.dispose() }
    },
  )

  it.each(['refused', 'replaced', 'disconnected', 'disposed'] as const)(
    'refuses recorded work before acknowledgment when %s and permits a fresh owner', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([schema])
      const ref = { connection: app.connection.id, prompt: asPromptId('pending-recorded-reader') }
      app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
      app.store.hydrateArtifacts(ref, [{ ...asset('a'), nodeId: 'n1', mediaType: 'image/png' }])
      const state = app.store.get(ref)!
      const requested = deferred<RetainedAssets>()
      const ack = deferred<RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementationOnce(async (owner, declaration) => {
        requested.resolve({ ...owner, ...declaration, revision: 1 })
        return ack.promise
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      const consume = vi.fn(async () => 17)
      const reader = app.executionAssetReader(state, [asset('a').digest])!
      const pending = reader.read(consume)
      const receipt = await requested.promise
      if (scenario === 'replaced') app.store.hydrateArtifacts(ref, [...state.artifacts])
      if (scenario === 'disconnected') { app.connection.connect(); app.connection.disconnect() }
      if (scenario === 'disposed') app.dispose()
      ack.resolve({ ...receipt, revision: scenario === 'refused' ? 2 : 1 })
      await expect(pending).rejects.toThrow(scenario === 'refused' ? 'acknowledgment differs' : 'changed')
      expect(consume).not.toHaveBeenCalled()
      if (scenario !== 'disposed') {
        const replacement = app.executionAssetReader(app.store.get(ref)!, [asset('a').digest])!
        expect(await replacement.read(consume)).toBe(17)
      }
    },
  )

  it.each((['image', 'model3d'] as const).flatMap((kind) =>
    (['live', 'edited', 'closed', 'disconnected', 'disposed', 'refused'] as const).map((scenario) => ({ kind, scenario }))))(
    'binds input-$kind decode and cache reads to acknowledged document ownership: $scenario', async ({ kind, scenario }) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([schema])
      expect((await app.openDocument(session().doc, 'Image owner'))).toEqual([])
      const ownerApp = app
      const tab = app.activeTab()!
      const reads: Array<ReturnType<typeof deferred<void>>> = []
      class Image {
        src = ''
        naturalWidth = 13
        naturalHeight = 7
        decode() {
          const read = deferred<void>()
          reads.push(read)
          return read.promise
        }
      }
      vi.stubGlobal('Image', Image)
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
      const acknowledged = deferred<RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementationOnce(async (owner, declaration) => {
        requested.resolve({ owner, declaration })
        return acknowledged.promise
      })
      const decoded = deferred<void>()
      const loader = createPreviewLoader({
        assetUrlForExecution: () => '',
        assetUrlForInput: (digest) => ownerApp.connection.assetUrl(digest),
        inputAssetReader: (digest) => ownerApp.workflowAssetReader(tab, digest),
        renderModel3dPoster: async () => {
          const read = deferred<void>()
          reads.push(read)
          await read.promise
          return { image: {} as CanvasImageSource, width: 13, height: 7 }
        },
        onDecoded: () => decoded.resolve(),
      })
      try {
        expect(app.workflowAssetReader(tab, asset('f').digest)).toBeUndefined()
        const mime = kind === 'image' ? 'image/png' : 'model/gltf-binary'
        const source = loader.inputAssetSource!(asset('a').digest, mime, kind)!
        expect(source.assetReader?.current()).toBe(kind === 'model3d' ? true : undefined)
        const pending = source.load()
        expect(reads).toHaveLength(0)
        const { owner, declaration } = await requested.promise
        expect(declaration.digests).toEqual([asset('a').digest])
        expect(reads).toHaveLength(0)
        acknowledged.resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
        if (scenario === 'refused') {
          await expect(pending).rejects.toThrow('acknowledgment differs')
          expect(reads).toHaveLength(0)
          // A refused acknowledgment is not cached as permission; the same source can retry.
          const retry = source.load()
          await vi.waitFor(() => expect(reads).toHaveLength(1))
          reads[0]!.resolve()
          expect(await retry).toMatchObject({ width: 13, height: 7 })
          return
        }
        await vi.waitFor(() => expect(reads).toHaveLength(1))
        if (scenario === 'edited') expect((await app.dispatchTo(tab, replace('b'))).ok).toBe(true)
        if (scenario === 'closed') app.closeTab(tab.id)
        if (scenario === 'disconnected') { app.connection.connect(); app.connection.disconnect() }
        if (scenario === 'disposed') app.dispose()
        reads[0]!.resolve()
        if (scenario !== 'live') {
          await expect(pending).rejects.toThrow('changed')
          expect(loader.resolve(source)).toBeUndefined()
          await expect(source.load()).rejects.toThrow('no longer current')
          expect(reads).toHaveLength(1)
          return
        }
        expect(await pending).toMatchObject({ width: 13, height: 7 })
        loader.resolve(source)
        await vi.waitFor(() => expect(reads).toHaveLength(2))
        reads[1]!.resolve()
        await decoded.promise
        expect(loader.resolve(source)).toMatchObject({ width: 13, height: 7 })
        expect((await app.dispatchTo(tab, replace('b'))).ok).toBe(true)
        expect(loader.resolve(source)).toBeUndefined()
        if (kind === 'model3d') expect(source.assetReader!.current()).toBe(false)
        const replacement = loader.inputAssetSource!(asset('b').digest, mime, kind)!
        expect(replacement.key).not.toBe(source.key)
        const live = replacement.load()
        await vi.waitFor(() => expect(reads).toHaveLength(3))
        reads[2]!.resolve()
        expect(await live).toMatchObject({ width: 13, height: 7 })
      } finally {
        loader.dispose()
      }
    },
  )

  it.each(['accepted', 'refused', 'direct', 'prepared'] as const)(
    'requires ownership when an opaque node default makes the census incomplete: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      const opaque: NodeSchema = { ...schema, type: 'Opaque', items: [{
        kind: 'input', id: 'value', optional: false, type: { kind: 'concrete', name: 'OPAQUE' },
        ext: { default: { handle: 'unrepresented dependency' } },
      }] }
      app = createWorkflowApp([opaque])
      const tab = app.activeTab()!
      const before = tab.store.doc
      const invocation = { command: 'node.add', params: { graphId: before.root, type: 'Opaque', position: { x: 10, y: 20 } } }
      const acknowledgement = deferred<RetainedAssets>()
      let declaration: RetainedAssetDeclaration | undefined
      let owner: RetainedAssetOwner | undefined
      vi.mocked(app.connection.retainAssets).mockImplementation(async (requestedOwner, requestedDeclaration) => {
        owner = requestedOwner
        declaration = requestedDeclaration
        return acknowledgement.promise
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      if (scenario === 'direct' || scenario === 'prepared') {
        const candidate = scenario === 'prepared' ? tab.store.prepareDispatch!(invocation) : undefined
        const outcome = candidate === undefined ? tab.store.dispatch(invocation) : candidate.ok ? candidate.commit() : candidate
        expect(outcome).toMatchObject({ ok: false, diagnostics: [{ code: 'command.retention.required' }] })
        expect(tab.store.doc).toBe(before)
        expect(app.connection.retainAssets).not.toHaveBeenCalled()
        return
      }
      const operation = app.dispatchTo(tab, invocation)
      expect(tab.store.doc).toBe(before)
      await vi.waitFor(() => expect(declaration).toEqual({ revision: 0, complete: false, digests: [] }))
      expect(tab.store.canUndo).toBe(false)
      acknowledgement.resolve({ ...owner!, ...declaration!, revision: scenario === 'accepted' ? 1 : 2 })
      expect((await operation).ok).toBe(scenario === 'accepted')
      expect(Object.values(tab.store.doc.graphs[before.root]!.nodes).some((node) => node.type === 'Opaque'))
        .toBe(scenario === 'accepted')
      expect(tab.store.canUndo).toBe(scenario === 'accepted')
    },
  )

  it('admits fresh wire15 nodes as edits with incomplete ownership and a persistent warning', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    const dynamic: NodeSchema = { ...schema, items: [{
      kind: 'input', id: 'mode', optional: false, type: { kind: 'concrete', name: 'STRING' },
      dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [{ key: 'active', inputs: [{
        kind: 'input', id: 'file', optional: false, type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } },
        widget: { widgetType: 'ASSET', options: {}, default: asset('a') },
      }] }, { key: 'unsupported', inputs: [{ kind: 'input', id: 'slot', optional: true,
        type: { kind: 'concrete', name: 'STRING' }, dynamic: { kind: 'dynamicSlot', materialization: 'wire15',
          slotType: { kind: 'concrete', name: 'STRING' }, inputs: [] },
      }] }] },
    }] }
    app = createWorkflowApp([dynamic])
    const tab = app.activeTab()!
    const outcome = await app.dispatchTo(tab, { command: 'node.add', params: {
      graphId: tab.store.doc.root, type: 'Loader', position: { x: 10, y: 20 },
    } })
    expect(outcome.ok).toBe(true)
    expect(Object.values(tab.store.doc.graphs[tab.store.doc.root]!.nodes).map((node) => node.type)).toEqual(['Loader'])
    const records = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .filter((key) => key.includes('dinkster.workflow-retentions.'))
      .map((key) => JSON.parse(localStorage.getItem(key)!))
    expect(records).toContainEqual(expect.objectContaining({ complete: false, digests: [asset('a').digest],
      incompleteDiagnostics: [expect.objectContaining({ code: 'elab.dormant.unsupported' })] }))
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ severity: 'warning',
      code: 'workflow.execution.ownershipUnconfirmed' }))
    expect(await app.saveWorkflow(tab.id)).toBe(false)
    expect(await app.shareActiveTab()).toContain('Publication and sharing remain unavailable.')
  })

  it('saves a complete snapshot without certifying unknown undo history or allowing sharing', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const document = session().doc
    await app.openDocument({ ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
      ...document.graphs.g0!.nodes,
      old: { id: asNodeId('old'), type: 'Previous', values: {} },
    } } } }, 'Migrated snapshot')
    const tab = app.activeTab()!
    expect((await app.dispatchRetainedTo(tab, { command: 'node.remove', params: {
      graphId: 'g0', nodeIds: ['old'],
    } })).ok).toBe(true)
    expect(workflowAssetRoots(tab.store.doc, { revision: tab.store.revision, undo: [], redo: [] }, resolve))
      .toEqual({ complete: true, digests: [asset('a').digest] })
    expect(workflowAssetRoots(tab.store.doc, tab.store.historySnapshot(), resolve))
      .toEqual({ complete: false, digests: [asset('a').digest] })
    const records = () => Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .filter((key) => key.includes('dinkster.workflow-retentions.'))
      .map((key) => JSON.parse(localStorage.getItem(key)!))
    const before = records()
    expect(before).toContainEqual(expect.objectContaining({ complete: false, digests: [asset('a').digest] }))
    const history = tab.store.historySnapshot()
    const upload = vi.spyOn(app.connection, 'uploadAsset').mockResolvedValue(asset('c').digest)
    vi.spyOn(app.connection, 'createLibraryRecord').mockResolvedValue({
      id: 'saved', scope: 'local', name: 'Migrated snapshot', digest: asset('c').digest,
      mediaType: 'application/json', labels: [], created: 1, modified: 1, revision: 1,
    })
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(JSON.parse(upload.mock.calls[0]![0] as string).graphs).toEqual(tab.store.doc.graphs)
    expect(records()).toEqual(before)
    expect(await app.shareActiveTab()).toBe('Workflow ownership unconfirmed. Publication and sharing remain unavailable.')
    expect(records()).toEqual(before)
    expect(tab.store.historySnapshot()).toEqual(history)
  })

  it.each((['accepted', 'projection-before', 'projection-during', 'replaced', 'edited', 'registry', 'target', 'closed', 'unwanted', 'refused', 'disconnected', 'disposed'] as const)
    .flatMap((scenario) => (['explicit', 'ordinary'] as const).map((route) => ({ scenario, route }))))(
    'publishes only a current acknowledged candidate: $route $scenario', async ({ scenario, route }) => {
      const storage = new Map<string, string>()
      vi.stubGlobal('localStorage', {
        get length() { return storage.size },
        clear: () => storage.clear(),
        getItem: (key: string) => storage.get(key) ?? null,
        key: (index: number) => [...storage.keys()][index] ?? null,
        removeItem: (key: string) => { storage.delete(key) },
        setItem: (key: string, value: string) => { storage.set(key, value) },
      } satisfies Storage)
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = prepareWorkflowApp(new AppState())
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      const registry = {
        connection: backend.id, diagnostics: [], hash: 'test',
        schemas: new Map([[schema.type, schema]]), resolve,
      }
      backend.registry.set(registry)
      expect((await app.openDocument(session().doc, 'Retained workflow'))).toEqual([])
      const tab = app.activeTab()!
      app.setTabTarget(tab.id, backend.id)
      const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
      const acknowledged = deferred<RetainedAssets>()
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
        if (declaration.digests.includes(asset('c').digest)) return { ...owner, ...declaration, revision: 1 }
        requested.resolve({ owner, declaration })
        return acknowledged.promise
      })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      let wanted = true
      const before = tab.store.doc
      const accepted = scenario === 'accepted' || scenario === 'projection-before' || scenario === 'projection-during'
      if (scenario === 'projection-before') app.setTabEditorKind(tab.id, GLSL_EDITOR_KIND)
      const operation = route === 'ordinary'
        ? app.dispatchTo(tab, replace('b'))
        : app.dispatchRetainedTo(tab, replace('b'), () => wanted)
      const { owner, declaration } = await requested.promise
      expect(declaration.digests).toEqual([asset('a').digest, asset('b').digest])
      expect(tab.store.doc).toBe(before)
      expect(tab.store.canUndo).toBe(false)
      app.flushPersistTabs(true)
      const persisted = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
      expect(persisted.tabs.find((entry: { doc: WorkflowDocument }) => entry.doc.lineage === tab.id)
        .doc.graphs.g0.nodes.n0.values.files).toEqual([asset('a')])
      if (scenario === 'projection-during') app.setTabEditorKind(tab.id, GLSL_EDITOR_KIND)
      if (scenario === 'projection-before' || scenario === 'projection-during') {
        expect(app.activeTab()).not.toBe(tab)
        expect(app.activeTab()!.store).toBe(tab.store)
        expect(app.activeTab()!.editorKind).toBe(GLSL_EDITOR_KIND)
      }
      if (scenario === 'replaced') {
        expect((await app.openDocument(session([asset('c')]).doc, 'Replacement'))).toEqual([])
        app.setTabTarget(tab.id, backend.id)
        expect(app.activeTab()!.id).toBe(tab.id)
        expect(app.activeTab()!.store).not.toBe(tab.store)
      }
      if (scenario === 'edited') expect((await app.dispatchTo(tab, replace('c'))).ok).toBe(true)
      if (scenario === 'registry') backend.registry.set({ ...registry, hash: 'changed' })
      if (scenario === 'target') {
        const other = app.addBackend('http://other:8000', 'Other', false, 'dinkster')!
        other.registry.set({ ...registry, connection: other.id })
        app.setTabTarget(tab.id, other.id)
      }
      if (scenario === 'closed') app.closeTab(tab.id)
      if (scenario === 'unwanted') {
        wanted = false
        if (route === 'ordinary') app.closeTab(tab.id)
      }
      if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
      if (scenario === 'disposed') app.dispose()
      acknowledged.resolve({ ...owner, ...declaration, revision: 1,
        ...(scenario === 'refused' ? { complete: false } : {}) })
      expect((await operation).ok).toBe(accepted)
      expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(
        accepted ? 'b' : scenario === 'edited' ? 'c' : 'a',
      )])
      expect(tab.store.canUndo).toBe(accepted || scenario === 'edited')
      if (scenario === 'replaced') {
        expect(app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('c')])
        expect(app.activeTab()!.store.canUndo).toBe(false)
      }
      if (accepted) {
        expect(tab.store.undo()).toBe(true)
        expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
        expect(tab.store.redo()).toBe(true)
        expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
      }
    },
  )

  it.each(['canonical', 'workspace', 'document', 'operation', 'corrupt', 'filtered-tab', 'unknown', 'unreadable',
    'lost-key', 'locked-commit', 'lost-release', 'disconnected', 'replaced'] as const)('keeps durable snapshot roots until their source retires: %s', async (scenario) => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([schema])
      await app.openDocument(session().doc, 'Workflow')
      const tab = app.activeTab()!
      const owners = new Map<string, RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        const receipt = { ...owner, ...declaration, revision: 1 }
        owners.set(owner.ownerId, receipt)
        return receipt
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
      vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        const tombstone = { ...owners.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
        owners.set(owner.ownerId, tombstone)
        if (scenario === 'lost-release') throw new Error('response lost')
        return tombstone
      })
      expect((await app.dispatchRetainedTo(tab, replace('b'))).ok).toBe(true)
      app.flushPersistTabs()
      const snapshot = JSON.parse(localStorage.getItem(scopedStorageKey('dinkster.openTabs'))!)
      const saved = snapshot.tabs.find((entry: { doc: { lineage: string } }) => entry.doc.lineage === tab.id)
      expect(saved.doc.graphs.g0.nodes.n0.values.files).toEqual([asset('b')])
      localStorage.removeItem(scopedStorageKey('dinkster.openTabs'))
      localStorage.removeItem(scopedStorageKey(`dinkster.openTabsDocumentCandidate.${encodeURIComponent(tab.id)}`))
      const sourceKey = scopedStorageKey(scenario === 'workspace' ? 'dinkster.openTabsCandidate.peer'
        : scenario === 'document' ? `dinkster.openTabsDocumentCandidate.${encodeURIComponent(tab.id)}`
          : scenario === 'operation' ? 'dinkster.workspaceOperation.peer#0' : 'dinkster.openTabs')
      localStorage.setItem(sourceKey, scenario === 'corrupt' ? '{' : JSON.stringify(
        scenario === 'document' ? { v: 1, stageId: 'older', tab: saved }
          : scenario === 'operation' ? { opId: 'peer#0', additions: [{ id: tab.id, document: saved.doc }] }
            : scenario === 'filtered-tab' ? { ...snapshot, tabs: [null] }
              : scenario === 'unknown' ? { ...snapshot, tabs: [{ ...saved, doc: {
                ...saved.doc, ext: { unresolved: {} },
              } }] } : snapshot))
      const keys = scenario === 'unreadable' || scenario === 'lost-key' ? vi.spyOn(localStorage, 'key').mockImplementation(() => {
        if (scenario === 'lost-key') return null
        throw new Error('storage unavailable')
      }) : undefined
      tab.store.clearHistory()
      expect((await app.dispatchRetainedTo(tab, replace('c'))).ok).toBe(true)
      const previous = [...owners.values()].at(-1)!
      expect(previous.digests).toEqual([asset('b').digest, asset('c').digest])
      tab.store.clearHistory()
      expect((await app.dispatchRetainedTo(tab, replace('d'))).ok).toBe(true)
      await vi.advanceTimersByTimeAsync(0)
      const latest = [...owners.values()].at(-1)!
      expect(latest.digests).toEqual([asset('c').digest, asset('d').digest])
      expect(owners.get(previous.ownerId)).toEqual(previous)
      keys?.mockRestore()
      if (scenario === 'disconnected') { app.connection.connect(); app.connection.disconnect() }
      if (scenario === 'replaced') await app.openDocument(session([asset('f')]).doc, 'Replacement')
      let commit: (() => void) | undefined
      if (scenario === 'locked-commit') vi.stubGlobal('navigator', { locks: {
        request: async (_name: string, _options: unknown, callback: () => void) => { commit = callback },
      } })
      else localStorage.removeItem(sourceKey)
      app.flushPersistTabs()
      if (scenario === 'locked-commit') {
        expect(owners.get(previous.ownerId)).toEqual(previous)
        expect(JSON.parse(localStorage.getItem(sourceKey)!).tabs).toEqual(snapshot.tabs)
        expect(commit).toBeDefined()
        commit!()
      }
      await vi.advanceTimersByTimeAsync(0)
      if (scenario === 'disconnected' || scenario === 'replaced') expect(owners.get(previous.ownerId)).toEqual(previous)
      else {
        expect(owners.get(previous.ownerId)).toEqual({ ...previous, revision: 2, complete: true, digests: [] })
        const intent = JSON.parse(localStorage.getItem(scopedStorageKey(`dinkster.workflow-retentions.${previous.ownerId}`))!)
        expect(intent.acknowledgedRevision).toBe(2)
      }
      expect(owners.get(latest.ownerId)).toEqual(latest)
    } finally { vi.useRealTimers() }
  })

  it.each(['accepted', 'startup', 'imported', 'lost-ack', 'lost-release', 'reused-owner', 'refused', 'replaced', 'disconnected', 'incomplete'] as const)(
    'replaces only the acknowledged workflow session owner: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([schema])
      await app.openDocument(session().doc, 'Workflow')
      const tab = app.activeTab()!
      const owners = new Map<string, RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        const retained = { ...owner, ...declaration, revision: 1 }
        owners.set(owner.ownerId, retained)
        return retained
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
      if (scenario === 'startup') await app.confirmStartupOwnership()
      else if (scenario === 'imported') {
        expect(await app.importWorkflowFile({ name: 'source.json', text: async () => JSON.stringify(session().doc) })).toBe(true)
      } else expect((await app.dispatchRetainedTo(tab, replace('b'))).ok).toBe(true)
      const current = scenario === 'imported' ? app.activeTab()! : tab
      const original = [...owners.values()].find((owner) => owner.digests.includes(asset('a').digest))!
      await app.openDocument({ ...session().doc, lineage: asLineageId('independent') }, 'Independent')
      const independent = app.activeTab()!
      expect((await app.dispatchRetainedTo(independent, replace('b'))).ok).toBe(true)
      const independentOwner = [...owners.values()].at(-1)!
      const admission = deferred<void>()
      const requested = deferred<RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        const retained = { ...owner, ...declaration, revision: 1 }
        owners.set(owner.ownerId, retained)
        if (declaration.digests.includes(asset('d').digest)) return retained
        requested.resolve(retained)
        await admission.promise
        if (scenario === 'refused') {
          owners.delete(owner.ownerId)
          throw new Error('rejected')
        }
        if (scenario === 'lost-ack') throw new Error('acknowledgment lost')
        return retained
      })
      const release = deferred<void>()
      const retiring = deferred<void>()
      vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        expect(revision).toBe(original.revision)
        retiring.resolve()
        await release.promise
        const tombstone = { ...owners.get(owner.ownerId)!, revision: scenario === 'reused-owner' ? 3 : 2,
          complete: true, digests: scenario === 'reused-owner' ? [asset('f').digest] : [] }
        owners.set(owner.ownerId, tombstone)
        if (scenario === 'lost-release' || scenario === 'reused-owner') throw new Error('response lost')
        return tombstone
      })
      const operation = app.dispatchRetainedTo(current, scenario === 'incomplete' ? {
        command: 'node.add', params: { graphId: 'g0', type: 'Unknown', position: { x: 12, y: 34 } },
      } : replace('c'))
      const candidate = await requested.promise
      const fromInitial = scenario === 'startup' || scenario === 'imported'
      expect(candidate.digests).toEqual(scenario === 'incomplete'
        ? [asset('a').digest, asset('b').digest] : fromInitial
          ? [asset('a').digest, asset('c').digest] : [asset('a').digest, asset('b').digest, asset('c').digest])
      expect(owners.get(original.ownerId)).toEqual(original)
      expect(current.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(fromInitial ? 'a' : 'b')])
      if (scenario === 'replaced') await app.openDocument(session([asset('d')]).doc, 'Replacement')
      if (scenario === 'disconnected') { app.connection.connect(); app.connection.disconnect() }
      admission.resolve()
      const accepted = !['refused', 'replaced', 'disconnected'].includes(scenario)
      expect((await operation).ok).toBe(accepted)
      if (accepted && scenario !== 'incomplete') {
        await retiring.promise
        expect(owners.get(original.ownerId)).toEqual(original)
        expect(current.store.undo()).toBe(true)
        expect(current.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(fromInitial ? 'a' : 'b')])
        if (!fromInitial) {
          expect(current.store.undo()).toBe(true)
          expect(current.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
        }
        release.resolve()
        await vi.waitFor(() => expect(owners.get(original.ownerId)?.revision).toBe(scenario === 'reused-owner' ? 3 : 2))
        const key = scopedStorageKey(`dinkster.workflow-retentions.${original.ownerId}`)
        await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).acknowledgedRevision)
          .toBe(scenario === 'reused-owner' ? 1 : 2))
        expect(owners.get(candidate.ownerId)).toEqual(candidate)
      } else {
        expect(app.connection.releaseRetainedAssets).not.toHaveBeenCalled()
        expect(owners.get(original.ownerId)).toEqual(original)
      }
      expect(owners.get(independentOwner.ownerId)).toEqual(independentOwner)
      expect(independent.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
    },
  )

  it.each([
    ['ordered', 'covered'], ['ordered', 'unowned'], ['snapshot', 'covered'], ['snapshot', 'unowned'],
  ] as const)('checks a generated asset after %s rebase: %s', async (route, scenario) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    const commands = coreCommandRegistry
    vi.spyOn(core, 'coreCommandRegistry').mockImplementation((...args) => {
      const registry = new Map(commands(...args))
      registry.set('test.generatedAsset', { id: 'test.generatedAsset', run(document, _params, tx) {
        tx.set(['graphs', 'g0', 'nodes', 'n0', 'values', 'files'],
          [{ ...asset(scenario === 'unowned' && document.graphs.g0!.name === 'foreign' ? 'f' : 'a'),
            name: document.graphs.g0!.name === 'foreign' ? 'rebased.bin' : 'pending.bin' }])
        return []
      } })
      return registry
    })
    app = createWorkflowApp([schema])
    await app.openDocument(session().doc, 'Workflow')
    const documents = new SharedWorkerDocumentAuthority()
    const workspace = new SharedWorkerTabAuthority()
    const channels: MessageChannel[] = []
    let release: (() => void) | undefined
    let hold = false
    let snapshotRequired = route === 'snapshot'
    const connect = (authority: { connect(port: WorkerPortLike): void }, intercept = false) => {
      const channel = new MessageChannel()
      channels.push(channel)
      authority.connect(channel.port2)
      if (!intercept) return channel.port1
      return {
        postMessage(message: unknown) {
          const request = message as { kind?: string; id: number }
          if (hold && request.kind === 'post-op') {
            release = () => { channel.port1.postMessage(message) }
          } else if (hold && request.kind === 'fetch-ops' && snapshotRequired) {
            snapshotRequired = false
            channel.port2.postMessage({ kind: 'response', id: request.id,
              value: { kind: 'resync-required', snapshotRevision: 1 } })
          } else channel.port1.postMessage(message)
        },
        addEventListener: channel.port1.addEventListener.bind(channel.port1),
        start: () => channel.port1.start(),
        close: () => channel.port1.close(),
      }
    }
    let peer: import('../src/shared-worker-connection.js').SharedWorkerCollabConnection | undefined
    try {
      await app.enableWorkspaceAuthority(() => connect(documents, true), () => connect(workspace))
      const tab = app.activeTab()!
      const { SharedWorkerCollabConnection } = await import('../src/shared-worker-connection.js')
      peer = await SharedWorkerCollabConnection.open(tab.id, tab.store.doc, () => connect(documents), 'peer')
      hold = true
      expect(app.dispatchTo(tab, { command: 'node.setTitle', params: {
        graphId: 'g0', nodeId: 'n0', title: 'pending',
      } })).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(release).toBeDefined())
      expect(app.dispatchTo(tab, { command: 'test.generatedAsset', params: {} })).toMatchObject({ ok: true })
      const observed: string[] = []
      tab.store.document.subscribe((document) => {
        observed.push(JSON.stringify(document))
      })
      const requested = deferred<RetainedAssets>()
      const acknowledgment = deferred<RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        requested.resolve({ ...owner, ...declaration, revision: 1 })
        return acknowledgment.promise
      })
      expect(await peer.postOp({ protocolVersion: core.COLLAB_PROTOCOL_VERSION,
        actorId: 'peer', opId: 'peer#0', baseRevision: 0, patch: [{
        op: 'replace', path: ['graphs', 'g0', 'name'], value: 'foreign',
      }] })).toMatchObject({ kind: 'accepted' })
      const receipt = await requested.promise
      expect(receipt.digests).toEqual([asset('a').digest])
      expect(tab.store.doc.graphs.g0!.name).toBe('Root')
      expect(observed).toEqual([])
      acknowledgment.resolve(receipt)
      await vi.waitFor(() => expect(tab.store.doc.graphs.g0!.name).toBe('foreign'))
      if (route === 'snapshot') expect(snapshotRequired).toBe(false)
      expect(observed.join('')).not.toContain(asset('f').digest)
      expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([
        scenario === 'covered' ? { ...asset('a'), name: 'rebased.bin' } : asset('a'),
      ])
      expect(tab.store.doc.graphs.g0!.nodes.n0!.title).toBe(route === 'ordered' ? 'pending' : undefined)
      expect(app.problems.get().some((problem) => problem.code === 'command.retention.required')).toBe(scenario === 'unowned')
    } finally {
      hold = false
      release?.()
      peer?.close()
      app.dispose()
      for (const channel of channels) { channel.port1.close(); channel.port2.close() }
    }
  })

  it('keeps document and history ownership across shared workspace promotion', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const owners = new Map<string, RetainedAssets>()
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const receipt = { ...owner, ...declaration, revision: 1 }
      owners.set(owner.ownerId, receipt)
      return receipt
    })
    vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
      const tombstone = { ...owners.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
      owners.set(owner.ownerId, tombstone)
      return tombstone
    })
    await app.openDocument(session().doc, 'Workflow')
    const local = app.activeTab()!
    expect((await app.dispatchRetainedTo(local, replace('b'))).ok).toBe(true)
    const original = [...owners.values()].at(-1)!
    const documents = new SharedWorkerDocumentAuthority()
    const workspace = new SharedWorkerTabAuthority()
    const channels: MessageChannel[] = []
    const connect = (authority: { connect(port: WorkerPortLike): void }) => {
      const channel = new MessageChannel()
      channels.push(channel)
      authority.connect(channel.port2)
      return channel.port1
    }
    try {
      await app.enableWorkspaceAuthority(() => connect(documents), () => connect(workspace))
      const shared = app.activeTab()!
      expect(shared.store).not.toBe(local.store)
      await vi.waitFor(() => expect(owners.get(original.ownerId)?.revision).toBe(2))
      const promoted = [...owners.values()].at(-1)!
      expect(promoted.digests).toEqual([asset('a').digest, asset('b').digest])
      expect((await app.dispatchRetainedTo(shared, replace('c'))).ok).toBe(true)
      await vi.waitFor(() => expect(owners.get(promoted.ownerId)?.revision).toBe(2))
      expect([...owners.values()].at(-1)?.digests).toEqual([asset('a').digest, asset('b').digest, asset('c').digest])
      expect(shared.store.undo()).toBe(true)
      expect(shared.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
      expect(shared.store.undo()).toBe(true)
      expect(shared.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
    } finally {
      app.dispose()
      for (const channel of channels) { channel.port1.close(); channel.port2.close() }
    }
  })

  it('keeps the newer acknowledged session owner when an earlier candidate finishes late', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    await app.openDocument(session().doc, 'Workflow')
    const tab = app.activeTab()!
    const owners = new Map<string, RetainedAssets>()
    const delayed = deferred<void>()
    const requested = deferred<void>()
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const receipt = { ...owner, ...declaration, revision: 1 }
      owners.set(owner.ownerId, receipt)
      if (declaration.digests.includes(asset('c').digest)) {
        requested.resolve()
        await delayed.promise
      }
      return receipt
    })
    vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
    vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner) => {
      const receipt = { ...owners.get(owner.ownerId)!, revision: 2, digests: [], complete: true }
      owners.set(owner.ownerId, receipt)
      return receipt
    })
    expect((await app.dispatchRetainedTo(tab, replace('b'))).ok).toBe(true)
    const first = [...owners.values()][0]!
    const earlier = app.dispatchRetainedTo(tab, replace('c'))
    await requested.promise
    expect((await app.dispatchRetainedTo(tab, replace('d'))).ok).toBe(true)
    const latest = [...owners.values()].at(-1)!
    expect(latest.digests).toEqual([asset('a').digest, asset('b').digest, asset('d').digest])
    delayed.resolve()
    expect((await earlier).ok).toBe(false)
    await vi.waitFor(() => expect(owners.get(first.ownerId)?.revision).toBe(2))
    expect(owners.get(latest.ownerId)).toEqual(latest)
    expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('d')])
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
  })

  it.each(['dispatch', 'prepared'] as const)('refuses unadmitted local publication through %s', async (route) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    await app.openDocument(session().doc, 'Existing')
    await app.confirmStartupOwnership()
    const tab = app.activeTab()!
    vi.mocked(app.connection.retainAssets).mockClear()
    const original = tab.store.doc
    const history = tab.store.historySnapshot()
    const candidate = route === 'prepared' ? tab.store.prepareDispatch!(replace('b')) : undefined
    const outcome = route === 'dispatch' ? tab.store.dispatch(replace('b'))
      : candidate!.ok ? candidate!.commit() : candidate!
    expect(outcome).toMatchObject({ ok: false, diagnostics: [{ code: 'command.retention.required' }] })
    expect(tab.store.doc).toBe(original)
    expect(tab.store.historySnapshot()).toEqual(history)
    app.flushPersistTabs(true)
    const persisted = JSON.parse(localStorage.getItem(scopedStorageKey('dinkster.openTabs'))!)
    expect(persisted.tabs.find((entry: { doc: WorkflowDocument }) => entry.doc.lineage === original.lineage)
      .doc.graphs.g0.nodes.n0.values.files).toEqual([asset('a')])
    expect(app.connection.retainAssets).not.toHaveBeenCalled()
    expect((await app.dispatchTo(tab, replace('b'))).ok).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
    expect(tab.store.redo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
  })

  it.each(['valid', 'malformed'] as const)('keeps asset-neutral commands synchronous with %s existing identities', async (scenario) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    const document = session().doc
    const existing = scenario === 'valid' ? document : { ...document, graphs: {
      g0: { ...document.graphs.g0!, nodes: { n0: { ...document.graphs.g0!.nodes.n0!,
        values: { files: [{ digest: asset('a').digest, name: 'a.bin' }] },
      } } },
    } }
    app = createWorkflowApp([schema], existing)
    const tab = app.activeTab()!
    const outcome = app.dispatchTo(tab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n0', title: 'Renamed loader',
    } })
    expect(outcome).not.toBeInstanceOf(Promise)
    expect(outcome).toMatchObject({ ok: true })
    expect(tab.store.doc.graphs.g0!.nodes.n0!.title).toBe('Renamed loader')
    expect(app.connection.retainAssets).not.toHaveBeenCalled()
    expect(tab.store.undo()).toBe(true)
    expect(tab.store.doc.graphs.g0!.nodes.n0!.title).toBeUndefined()
  })
})

describe('retained picker consumers', () => {
  it.each(['accepted', 'closed', 'edited', 'registry', 'disconnected', 'disposed', 'refused'] as const)(
    'confirms a separate incomplete owner before a picker can publish: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      const app = createWorkflowApp([schema])
      try {
        await app.openDocument(session().doc, 'Picker source')
        const tab = app.activeTab()!
        const backend = app.backendForTab(tab)
        const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
        const response = deferred<RetainedAssets>()
        vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
          requested.resolve({ owner, declaration })
          return response.promise
        })
        vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
        const before = tab.store.doc
        const operation = app.retainPickerAssets(tab, backend, [asset('b'), asset('c')])
        const settled = operation.then(() => true, () => false)
        const { owner, declaration } = await requested.promise
        expect(declaration).toEqual({ revision: 0, complete: false, digests: [asset('b').digest, asset('c').digest] })
        expect(tab.store.doc).toBe(before)
        if (scenario === 'closed') app.closeTab(tab.id)
        if (scenario === 'edited') tab.store.dispatch({ command: 'node.setTitle', params: {
          graphId: 'g0', nodeId: 'n0', title: 'Changed while admitting picker',
        } })
        if (scenario === 'registry') backend.registry.set(undefined)
        if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
        if (scenario === 'disposed') app.dispose()
        response.resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
        expect(await settled).toBe(scenario === 'accepted')
        if (scenario !== 'edited') expect(tab.store.doc).toBe(before)
        expect(tab.store.canUndo).toBe(scenario === 'edited')
      } finally { app.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
    },
  )

  it.each(['live', 'edited', 'closed', 'registry', 'disconnected', 'disposed'] as const)(
    'binds picker reads to the admitted document without releasing protection: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      const app = createWorkflowApp([schema])
      try {
        await app.openDocument(session().doc, 'Picker source')
        const tab = app.activeTab()!
        const backend = app.backendForTab(tab)
        const release = vi.spyOn(app.connection, 'releaseRetainedAssets')
        const reader = await app.retainPickerAssets(tab, backend, asset('b'))
        expect(reader.current()).toBe(true)
        const started = deferred<void>()
        const body = deferred<number>()
        const read = reader.read(async () => { started.resolve(); return body.promise }).then(() => 'published', () => 'refused')
        await started.promise
        if (scenario === 'edited') tab.store.dispatch({ command: 'node.setTitle', params: {
          graphId: 'g0', nodeId: 'n0', title: 'Changed after picker admission',
        } })
        if (scenario === 'closed') app.closeTab(tab.id)
        if (scenario === 'registry') backend.registry.set(undefined)
        if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
        if (scenario === 'disposed') app.dispose()
        expect(reader.current()).toBe(scenario === 'live')
        body.resolve(23)
        expect(await read).toBe(scenario === 'live' ? 'published' : 'refused')
        if (scenario === 'live') expect(await reader.read(async () => 31)).toBe(31)
        else await expect(reader.read(async () => 31)).rejects.toThrow('closed')
        if (scenario === 'edited') {
          const replacement = await app.retainPickerAssets(tab, backend, asset('c'))
          expect(replacement.key).not.toBe(reader.key)
          expect(await replacement.read(async () => 47)).toBe(47)
        }
        expect(release).not.toHaveBeenCalled()
      } finally { app.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals() }
    },
  )
})

describe('retained clipboard consumers', () => {
  it.each(['accepted', 'closed', 'edited', 'refused', 'lost response', 'registry', 'disconnected', 'storage'] as const)(
    'retains the captured source and exact copy independently of the source tab: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      const app = createWorkflowApp([schema])
      try {
        const source = session().doc
        const document: WorkflowDocument = { ...source, graphs: { g0: { ...source.graphs.g0!, nextOrdinal: 2, nodes: {
          ...source.graphs.g0!.nodes, n1: { ...source.graphs.g0!.nodes.n0!, id: asNodeId('n1'), values: { files: [asset('c')] } },
        } } }, view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 } }, n1: { position: { x: 200, y: 0 } } } } } } }
        expect((await app.openDocument(document, 'Copied source'))).toEqual([])
        const tab = app.activeTab()!
        const text = JSON.stringify(serializeSelection(tab.store.doc, 'g0', { nodes: ['n0'], reroutes: [] }, 'copy-source'))
        expect(text).not.toContain(asset('c').digest)
        const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
        const response = deferred<RetainedAssets>()
        vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
          requested.resolve({ owner, declaration })
          const acknowledged = await response.promise
          if (scenario === 'lost response') throw new Error('lost')
          return acknowledged
        })
        const fetch = vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
        const release = vi.spyOn(app.connection, 'releaseRetainedAssets')
        if (scenario === 'storage') vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
        const operation = app.retainClipboardAssets(tab, text)
        if (scenario === 'storage') {
          expect(await operation).toBe(false)
          expect(app.connection.retainAssets).not.toHaveBeenCalled()
          return
        }
        const { owner, declaration } = await requested.promise
        expect(declaration).toEqual({ revision: 0, complete: false, digests: [asset('a').digest, asset('c').digest] })
        const key = scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`)
        expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ clipboardText: text, documentLineage: 'retention' })
        if (scenario === 'closed') app.closeTab(tab.id)
        if (scenario === 'edited') expect(app.dispatchTo(tab, { command: 'node.setTitle', params: {
          graphId: 'g0', nodeId: 'n0', title: 'Edited after copy',
        } })).toMatchObject({ ok: true })
        if (scenario === 'registry') app.registry.set(undefined)
        if (scenario === 'disconnected') { app.connection.connect(); app.connection.disconnect() }
        const acknowledged = { ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 }
        if (scenario === 'lost response') fetch.mockResolvedValue(acknowledged)
        response.resolve(acknowledged)
        expect(await operation).toBe(['accepted', 'closed', 'edited', 'lost response'].includes(scenario))
        if (['accepted', 'closed', 'edited', 'lost response'].includes(scenario)) {
          expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ clipboardText: text, acknowledgedRevision: 1 })
        }
        expect(release).not.toHaveBeenCalled()
      } finally {
        app.dispose()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
      }
    },
  )
})

describe('retained workflow opens', () => {
  let app: AppState | undefined
  afterEach(() => {
    app?.dispose()
    app = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each((['file', 'direct'] as const).flatMap((kind) =>
    (['accepted', 'view', 'lost', 'refused', 'edited', 'closed', 'replacement', 'registry', 'target', 'canceled', 'disposed'] as const)
      .map((scenario) => [kind, scenario] as const)))(
    'keeps the existing tab until a current %s-open acknowledgment: %s', async (kind, scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([schema])
      await app.openDocument(session().doc, 'Existing')
      const previous = app.activeTab()!
      const previousTabs = app.tabs.get()
      const incoming = { ...session([asset('c')]).doc, lineage: asLineageId('incoming') }
      const requested = deferred<RetainedAssetDeclaration>()
      const response = deferred<RetainedAssets>()
      let owner!: RetainedAssetOwner
      vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (key, declaration) => {
        if (declaration.digests.includes(asset('b').digest)) return { ...key, ...declaration, revision: 1 }
        owner = key
        const journal = JSON.parse(localStorage.getItem(scopedStorageKey(`dinkster.workflow-retentions.${key.ownerId}`))!)
        expect(journal.digests).toEqual([asset('c').digest])
        expect(journal.documentLineage).toBe('incoming')
        requested.resolve(declaration)
        const acknowledged = await response.promise
        if (scenario === 'lost') throw new Error('lost response')
        return acknowledged
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async () =>
        scenario === 'lost' ? { ...owner, ...await requested.promise, revision: 1 } : undefined)
      let wanted = true
      const operation = kind === 'direct'
        ? app.openDocument(incoming, 'Incoming').then((diagnostics) => diagnostics.length === 0)
        : app.importWorkflowFile({ name: 'incoming.json', text: async () => JSON.stringify(incoming) }, () => wanted)
      const declaration = await requested.promise
      expect(app.activeTab()).toBe(previous)
      expect(app.tabs.get()).toBe(previousTabs)
      expect(declaration).toEqual({ revision: 0, complete: true, digests: [asset('c').digest] })
      if (scenario === 'view') app.setTabAppArrange(previous.id, true)
      if (scenario === 'edited') expect((await app.dispatchTo(previous, replace('b'))).ok).toBe(true)
      if (scenario === 'closed') app.closeTab(previous.id)
      if (scenario === 'replacement') await app.openDocument(session([asset('b')]).doc, 'Replacement')
      if (scenario === 'registry') app.registry.set(undefined)
      if (scenario === 'target') app.setTabTarget(previous.id, app.addBackend('http://other:8000', 'Other', false)!.id)
      if (scenario === 'canceled') {
        wanted = false
        if (kind === 'direct') app.createWorkflow()
      }
      if (scenario === 'disposed') app.dispose()
      response.resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
      expect(await operation).toBe(scenario === 'accepted' || scenario === 'view' || scenario === 'lost')
      expect(app.tabs.get().some((tab) => tab.id === 'incoming')).toBe(scenario === 'accepted' || scenario === 'view' || scenario === 'lost')
      if (scenario === 'view') expect(app.tabs.get().find((tab) => tab.id === previous.id)?.store).toBe(previous.store)
      else if (scenario !== 'closed' && scenario !== 'replacement') expect(app.tabs.get()).toContain(previous)
      expect(previous.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(scenario === 'edited' ? 'b' : 'a')])
      expect([...Array(localStorage.length)].some((_, index) => localStorage.key(index)?.includes('workflow-retentions.'))).toBe(true)
    },
  )

  it('does not let an earlier slow file read replace a newer completed open', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const read = deferred<string>()
    const old = app.importWorkflowFile({ name: 'old.json', text: () => read.promise })
    const newer = { ...session([asset('b')]).doc, lineage: asLineageId('newer') }
    expect(await app.importWorkflowFile({ name: 'newer.json', text: async () => JSON.stringify(newer) })).toBe(true)
    read.resolve(JSON.stringify(session([asset('c')]).doc))
    expect(await old).toBe(false)
    expect(app.activeTab()!.store.doc.lineage).toBe('newer')
  })

  it('retains local files on their untargeted destination rather than the active backend', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const source = app.addBackend('http://source:8000', 'Source', false)!
    source.registry.set({ connection: source.id, schemas: new Map(), hash: 'source', diagnostics: [], resolve: () => undefined })
    app.setTabTarget(app.activeTab()!.id, source.id)
    const sourceWrite = vi.spyOn(source.connection, 'retainAssets')
    const document = { ...session([asset('c')]).doc, lineage: asLineageId('untargeted-import') }
    expect(await app.importWorkflowFile({ name: 'local.json', text: async () => JSON.stringify(document) })).toBe(true)
    expect(app.connection.retainAssets).toHaveBeenCalledWith(expect.anything(), {
      revision: 0, complete: true, digests: [asset('c').digest],
    })
    expect(sourceWrite).not.toHaveBeenCalled()
    expect(app.backendForTab(app.activeTab()!).id).toBe(app.connection.id)
  })

  it.each(['closed', 'replaced', 'lost', 'reused-owner', 'disconnected', 'disposed'] as const)(
    'retires only the explicitly removed frozen generation: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([{ ...schema, isOutputNode: true }])
      const owners = new Map<string, RetainedAssets>()
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        const retained = { ...owner, ...declaration, revision: 1 }
        owners.set(owner.ownerId, retained)
        return retained
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
      await app.openDocument(session().doc, 'Live')
      const live = app.activeTab()!
      const compiled = app.compileTab(live)
      if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
      const releaseStarted = deferred<void>()
      const releaseAck = deferred<void>()
      vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        expect(revision).toBe(1)
        releaseStarted.resolve()
        await releaseAck.promise
        const next = { ...owners.get(owner.ownerId)!, revision: scenario === 'reused-owner' ? 3 : 2,
          digests: scenario === 'reused-owner' ? [asset('f').digest] : [], complete: true }
        owners.set(owner.ownerId, next)
        if (scenario === 'lost' || scenario === 'reused-owner') throw new Error('release response lost')
        return next
      })
      const first = { connection: app.connection.id, prompt: asPromptId('frozen-first') }
      const second = { connection: app.connection.id, prompt: asPromptId('frozen-second') }
      app.registerRun(live, first, compiled.artifact)
      app.registerRun(live, second, compiled.artifact)
      expect(await app.openExecutionView(first)).toBe(true)
      const firstTab = app.activeTab()!
      const firstOwner = [...owners.values()].at(-1)!
      expect(await app.openExecutionView(second)).toBe(true)
      const secondTab = app.activeTab()!
      const secondOwner = [...owners.values()].at(-1)!
      expect(firstOwner.ownerId).not.toBe(secondOwner.ownerId)
      if (scenario === 'disconnected') { app.connection.connect(); app.connection.disconnect() }
      if (scenario === 'disposed') app.dispose()
      if (scenario === 'replaced') await app.openDocument({ ...session().doc, lineage: asLineageId(firstTab.id) }, 'Replacement')
      else app.closeTab(firstTab.id)
      if (scenario === 'disconnected' || scenario === 'disposed' || scenario === 'replaced') {
        await Promise.resolve()
        expect(app.connection.releaseRetainedAssets).not.toHaveBeenCalled()
        expect(owners.get(firstOwner.ownerId)).toEqual(firstOwner)
      } else {
        await releaseStarted.promise
        expect(owners.get(firstOwner.ownerId)).toEqual(firstOwner)
        expect(app.tabs.get()).toContain(secondTab)
        // Reopening creates a new independent owner before the old DELETE settles.
        expect(await app.openExecutionView(first)).toBe(true)
        const reopened = [...owners.values()].at(-1)!
        releaseAck.resolve()
        await vi.waitFor(() => expect(owners.get(firstOwner.ownerId)?.revision).toBe(scenario === 'reused-owner' ? 3 : 2))
        expect(owners.get(secondOwner.ownerId)).toEqual(secondOwner)
        expect(owners.get(reopened.ownerId)).toEqual(reopened)
        const key = scopedStorageKey(`dinkster.workflow-retentions.${firstOwner.ownerId}`)
        await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).acknowledgedRevision)
          .toBe(scenario === 'reused-owner' ? 1 : 2))
        expect(await reconcileWorkflowRetentions(app.connection, new AbortController().signal)).toBe(scenario !== 'reused-owner')
      }
      expect(live.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
      expect(owners.get(secondOwner.ownerId)).toEqual(secondOwner)
    },
  )

  it.each(['accepted', 'refused', 'edited', 'closed', 'disconnected', 'removed', 'disposed', 'unknown-schema', 'retired'] as const)(
    'stages a frozen snapshot without publishing early: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([{ ...schema, isOutputNode: true }])
      await app.openDocument(session().doc, 'Live')
      vi.mocked(app.connection.retainAssets).mockClear()
      const previous = app.activeTab()!
      const source = app.addBackend('http://source:8000', 'Source', false)!
      source.registry.set(app.registry.get())
      app.setTabTarget(previous.id, source.id)
      const compiled = app.compileTab(previous)
      if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
      const ref = { connection: source.id, prompt: asPromptId('frozen-open') }
      if (scenario === 'unknown-schema') app.store.register(ref, { ...compiled.artifact, schemaHash: 'unavailable' }, 1)
      else app.registerRun(previous, ref, compiled.artifact)
      const response = deferred<RetainedAssets>()
      const requested = deferred<RetainedAssetDeclaration>()
      let owner!: RetainedAssetOwner
      vi.spyOn(source.connection, 'retainAssets').mockImplementation(async (key, declaration) => {
        if (declaration.digests.includes(asset('b').digest)) return { ...key, ...declaration, revision: 1 }
        owner = key
        expect(localStorage.getItem(scopedStorageKey(`dinkster.workflow-retentions.${key.ownerId}`))).not.toBeNull()
        requested.resolve(declaration)
        return response.promise
      })
      vi.spyOn(source.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      if (scenario === 'retired') app.removeBackend(source.id)
      const opening = app.openExecutionView(ref)
      const declaration = await requested.promise
      expect(declaration).toEqual({ revision: 0, complete: scenario !== 'unknown-schema', digests: [asset('a').digest] })
      expect(app.activeTab()).toBe(previous)
      expect(app.tabs.get().some((tab) => tab.execution)).toBe(false)
      if (scenario === 'edited') expect((await app.dispatchTo(previous, replace('b'))).ok).toBe(true)
      if (scenario === 'closed') app.closeTab(previous.id)
      if (scenario === 'disconnected') {
        source.connection.connect()
        source.connection.disconnect()
      }
      if (scenario === 'removed') app.removeBackend(source.id)
      if (scenario === 'disposed') app.dispose()
      response.resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
      const accepted = scenario === 'accepted' || scenario === 'unknown-schema' || scenario === 'retired'
      expect(await opening).toBe(accepted)
      expect(app.tabs.get().some((tab) => tab.execution)).toBe(accepted)
      expect(app.connection.retainAssets).not.toHaveBeenCalled()
      if (accepted) {
        expect(app.activeTab()!.store.doc).toEqual(compiled.artifact.snapshot)
        expect(app.activeTab()!.execution).toEqual(ref)
        expect(await app.openExecutionView(ref)).toBe(true)
        expect(source.connection.retainAssets).toHaveBeenCalledOnce()
        expect(app.tabs.get().filter((tab) => tab.execution)).toHaveLength(1)
      }
    },
  )
})

describe('workflow candidate admission', () => {
  const assetType = { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } as const
  it.each(['location', 'extra-field', 'wrong-version', 'asset-value'] as const)(
    'keeps saved location hints distinct from stored asset identities: %s', (scenario) => {
      const local = session()
      const saved = stampAssetLocations(local.doc, new Map([[asset('a').digest,
        { machine: 'Original workstation', paths: ['/original/a.bin'] }]]))
      const document = JSON.parse(JSON.stringify(saved)) as WorkflowDocument
      const locations = document.meta!.ext!['dinkster.assetLocations'] as any
      if (scenario === 'extra-field') locations.observations[0].hidden = asset('b')
      if (scenario === 'wrong-version') locations.version = 2
      if (scenario === 'asset-value') (document.graphs.g0!.nodes.n0!.values as any).files = [{ digest: asset('a').digest }]
      expect(workflowAssetRoots(document, local.historySnapshot(), resolve))
        .toEqual({ complete: false, digests: scenario === 'extra-field' ? [asset('a').digest, asset('b').digest] :
          scenario === 'asset-value' ? [] : [asset('a').digest],
          ...(scenario === 'location' ? {} : { refusal: 'Workflow asset identity is malformed' }),
          ...(scenario === 'asset-value' ? { incompleteDiagnostics: [{ severity: 'error', origin: 'schema',
            code: 'workflow.asset.unresolvedInput', refs: [{ graphId: 'g0', nodeId: 'n0' }],
            message: "Loader (n0): Stored input 'files' has unresolved asset identities",
          }] } : {}) })
    })

  it('accepts parsed scalar schema metadata without treating it as asset storage', () => {
    const local = session()
    const registry = buildDinksterRegistry(asConnectionId('retention'), { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {
      Loader: { version: 3, idempotent: false, occupies: ['cpu'], ioBound: true, interface: [
        { role: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
      ] },
    } })
    expect(registry.resolve('Loader')).toBeDefined()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: { value: 11 } },
    } } } }
    expect(workflowAssetRoots(document, local.historySnapshot(), registry.resolve))
      .toEqual({ complete: true, digests: [] })
    expect(workflowAssetRoots({ ...document, ext: { dinkster: { version: 3, idempotent: false, occupies: ['cpu'], ioBound: true } } },
      local.historySnapshot(), registry.resolve).complete)
      .toBe(false)
  })

  it('retains effective parsed non-widget defaults and historical overrides', () => {
    const local = session()
    const registry = buildDinksterRegistry(asConnectionId('retention'), { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {
      Loader: { interface: [{ role: 'input', id: 'file', type: { kind: 'concrete', types: ['ASSET'] },
        forceInput: true, default: asset('b') }] },
    } })
    expect(registry.resolve('Loader')?.items[0]).toMatchObject({ ext: { default: asset('b') } })
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: {} },
    } } } }
    expect(workflowAssetRoots(document, local.historySnapshot(), registry.resolve))
      .toEqual({ complete: true, digests: [asset('b').digest] })
    const overridden: WorkflowDocument = { ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
      n0: { ...document.graphs.g0!.nodes.n0!, values: { file: asset('c') } },
    } } } }
    expect(workflowAssetRoots(overridden, local.historySnapshot(), registry.resolve))
      .toEqual({ complete: true, digests: [asset('c').digest] })
    expect(workflowAssetRoots(overridden, { revision: 1, redo: [], undo: [{ forward: [], inverse: [
      { op: 'remove', path: ['graphs', 'g0', 'nodes', 'n0', 'values', 'file'], oldValue: asset('c') },
    ] }] }, registry.resolve)).toEqual({ complete: true, digests: [asset('b').digest, asset('c').digest] })
  })

  it.each([
    { future: asset('d') },
    { dinkster: { version: 1, idempotent: true, future: asset('d') } },
    { dinkster: { version: asset('d'), idempotent: true } },
    { dinkster: { version: 1, idempotent: true, occupies: [asset('d')] } },
    { dinkster: { version: 1, idempotent: true, ioBound: asset('d') } },
  ])('refuses unknown or non-scalar schema metadata: %j', (ext) => {
    const local = session()
    expect(workflowAssetRoots(local.doc, local.historySnapshot(), () => ({ ...schema, ext })).complete).toBe(false)
  })

  it('retains region element lists using the occurrence contract', () => {
    const local = session()
    const body: NodeSchema = { ...schema, items: [
      { kind: 'input', id: 'file', optional: false, type: assetType },
      { kind: 'output', id: 'out', type: assetType },
    ] }
    const document: WorkflowDocument = { ...local.doc, graphs: {
      g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { id: asNodeId('n0'), type: '#body', values: { element: [asset('e'), asset('f')] },
          region: { kind: 'map', elementPorts: ['element'] } },
      } },
      body: { ...local.doc.graphs.g0!, id: asGraphDefId('body'), nodes: {
        n0: { id: asNodeId('n0'), type: 'Loader', values: {} },
      }, boundary: {
        inputs: [{ id: asPortId('element'), binds: { kind: 'port', node: asNodeId('n0'), port: asPortId('file') } }],
        outputs: [{ id: asPortId('result'), binds: { kind: 'port', node: asNodeId('n0'), port: asPortId('out') } }],
      } },
    } }
    expect(workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => body))
      .toEqual({ complete: true, digests: ['e', 'f'].map((letter) => asset(letter).digest) })
  })

  it.each(['NUMBER', 'opaque'])('checks numeric widget metadata without accepting unknown kinds: %s', (widgetType) => {
    const local = session()
    const numeric: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'value', optional: false,
      type: { kind: 'concrete', name: 'FLOAT' }, widget: { widgetType, options: {}, default: 3.5 },
    }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: { value: 7.25 } },
    } } } }
    expect(workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => numeric))
      .toEqual({ complete: widgetType === 'NUMBER', digests: [], ...(widgetType === 'NUMBER' ? {} : {
        incompleteDiagnostics: [{ severity: 'error', origin: 'schema', code: 'workflow.asset.unresolvedInput',
          refs: [{ graphId: 'g0', nodeId: 'n0' }],
          message: "Loader (n0): Declared input 'value' has an unsupported asset census widget binding 'opaque'",
        }],
      }) })
  })

  it.each(['default', 'selected', 'cleared', 'typed', 'unknown-widget', 'invalid-value', 'invalid-binding'] as const)(
    'counts mount selection without losing stored or historical assets: %s', (scenario) => {
      const local = session()
      const mountSchema: NodeSchema = { ...schema, items: [...schema.items, {
        kind: 'input', id: 'destination', optional: false,
        type: { kind: 'concrete', name: scenario === 'invalid-binding' ? 'FLOAT' : 'STRING' },
        widget: { widgetType: scenario === 'unknown-widget' ? 'opaque' : 'MOUNT', options: {}, default: null },
      }] }
      const destination = scenario === 'cleared' ? null : scenario === 'typed'
        ? { $typed: { type: 'STRING', value: 'output-mount' } }
        : scenario === 'invalid-value' ? asset('c') : 'output-mount'
      const opened = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { ...local.doc.graphs.g0!.nodes.n0!, values: { files: [asset('a')],
          ...(scenario === 'default' ? {} : { destination }) } },
      } } } }
      const workflow = createLocalSession(opened, coreCommandRegistry([], () => mountSchema))
      expect(workflow.dispatch(replace('b')).ok).toBe(true)
      const roots = workflowAssetRoots(workflow.doc, workflow.historySnapshot(), () => mountSchema)
      expect(roots.complete).toBe(!['unknown-widget', 'invalid-value', 'invalid-binding'].includes(scenario))
      expect([...roots.digests].sort()).toEqual((scenario === 'invalid-value'
        ? [asset('a').digest, asset('b').digest, asset('c').digest] : [asset('a').digest, asset('b').digest]).sort())
      if (scenario === 'invalid-value' || scenario === 'invalid-binding') {
        expect(roots.incompleteDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({
          code: 'workflow.asset.unresolvedInput', message: expect.stringContaining("Stored input 'destination'"),
        })]))
      }
    })

  const assetInput = (id: string, letter: string) => ({ kind: 'input' as const, id,
    type: assetType, optional: true, widget: { widgetType: 'ASSET' as const, options: {}, default: asset(letter) } })
  const dynamicSchema: NodeSchema = { ...schema, items: [
    { kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
      dynamic: { kind: 'dynamicCombo', options: [
        { key: 'a', inputs: [assetInput('file', 'a')] },
        { key: 'b', inputs: [assetInput('file', 'b')] },
      ] } },
    { kind: 'input', id: 'slot', type: assetType, optional: true,
      dynamic: { kind: 'dynamicSlot', slotType: assetType, inputs: [assetInput('file', 'c')] } },
    { kind: 'input', id: 'items', type: assetType, optional: true,
      dynamic: { kind: 'autogrow', template: [assetInput('file', 'd')],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 } } },
  ] }

  it.each(['resolved', 'conflicting', 'typed'] as const)('censuses stored wire15 branch values: %s', (scenario) => {
    const local = session()
    const candidate: NodeSchema = { ...schema, items: [{
      kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: false,
      dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [
        { key: 'a', inputs: [assetInput('file', 'a')] },
        { key: 'b', inputs: [{ ...assetInput('file', 'b'),
          type: scenario === 'resolved' ? assetType : { kind: 'concrete', name: 'STRING' } },
        assetInput('other', 'e')] },
      ] },
    }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', dynamic: { mode: { selected: 'a' } },
        values: { 'mode.file': scenario === 'typed' ? { $typed: { type: 'asset<DATA>', value: asset('c') } } : asset('c'),
          'mode.other': asset('d') } },
    } } } }
    const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => candidate)
    expect(roots.digests).toEqual([asset('c').digest, asset('d').digest])
    expect(roots.complete).toBe(scenario !== 'conflicting')
    if (scenario !== 'conflicting') expect(roots.incompleteDiagnostics).toBeUndefined()
    else expect(roots.incompleteDiagnostics).toEqual([expect.objectContaining({
      code: 'workflow.asset.ambiguousInput', message: expect.stringContaining("Stored input 'mode.file'"),
    })])
  })

  it.each(['missing-node', 'missing-input', 'opaque', 'selection-name', 'list'] as const)(
    'names exactly unresolved stored inputs and preserves known roots: %s', (scenario) => {
      const local = session()
      const candidate: NodeSchema = { ...schema, items: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: false,
        dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [
          { key: 'a', inputs: [assetInput('file', 'a')] },
          { key: 'b', inputs: [{ ...assetInput('future', 'b'),
            type: scenario === 'opaque' ? { kind: 'concrete', name: 'FUTURE' }
              : scenario === 'list' ? { kind: 'list', element: assetType } : assetType }] },
        ] },
      }] }
      const input = scenario === 'missing-input' ? 'mode.unknown' : 'mode.future'
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { id: asNodeId('n0'), type: 'Loader', dynamic: { mode: { selected: 'a' } },
          values: { 'mode.file': asset('c'), [input]: scenario === 'selection-name' ? 'unresolved.bin'
            : scenario === 'list' ? ['invalid', asset('d')] : asset('d') } },
      } } } }
      const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] },
        () => scenario === 'missing-node' ? undefined : candidate)
      expect(roots.complete).toBe(false)
      expect(roots.digests).toEqual(scenario === 'selection-name' ? [asset('c').digest] : [asset('c').digest, asset('d').digest])
      expect(roots.incompleteDiagnostics).toEqual((scenario === 'missing-node' ? ['mode.file', input] : [input]).map((key) => ({
        severity: 'error', origin: 'schema', code: 'workflow.asset.unresolvedInput',
        refs: [{ graphId: 'g0', nodeId: 'n0' }],
        message: `Loader (n0): Stored input '${key}' has ${scenario === 'missing-node' ? 'no resolved node schema'
          : scenario === 'missing-input' ? 'no resolved input schema' : 'unresolved asset identities'}`,
      })))
    },
  )

  it('censuses dormant wire15 branches in independent nested family member scopes', () => {
    const local = session()
    const candidate: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'items', type: assetType, optional: true,
      dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 }, template: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [
          { key: 'a', inputs: [assetInput('file', 'a')] },
          { key: 'b', inputs: [assetInput('file', 'b'), assetInput('other', 'e')] },
        ] },
      }] } }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: {
        'items.mode.file#m0': asset('c'), 'items.mode.other#m0': asset('d'),
        'items.mode.file#m1': asset('f'),
      }, dynamic: { items: { members: ['m0', 'm1'], memberState: {
        m0: { 'items.mode': { selected: 'a' } }, m1: { 'items.mode': { selected: 'b' } },
      } } } },
    } } } }
    expect(workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => candidate))
      .toEqual({ complete: true, digests: ['c', 'd', 'e', 'f'].map((letter) => asset(letter).digest) })
  })

  it('uses non-widget defaults only in active branches while retaining stored dormant values', () => {
    const local = session()
    const candidate: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'mode', optional: true,
      type: { kind: 'concrete', name: 'STRING' }, dynamic: { kind: 'dynamicCombo', options: ['a', 'b'].map((key) => ({
        key, inputs: [{ kind: 'input', id: 'file', type: assetType, optional: true, ext: { default: asset(key) } }],
      })) },
    }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: { 'mode.[b].file': asset('c') } },
    } } } }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => candidate))
      .toEqual({ complete: true, digests: [asset('a').digest, asset('c').digest] })
    const opaque: NodeSchema = { ...candidate, ext: { default: asset('e') } }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => opaque).complete).toBe(false)
    const unknownInput: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'files', optional: true,
      type: { kind: 'list', element: assetType }, ext: { default: [asset('a')], future: asset('d') } }] }
    expect(workflowAssetRoots(local.doc, local.historySnapshot(), () => unknownInput).complete).toBe(false)
  })

  it('retains inactive branch, disconnected slot and family values but only effective defaults', () => {
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', dynamic: { mode: { selected: 'a' }, items: { members: ['m0'] } },
        values: { 'mode.[b].file': asset('e'), 'slot.file': asset('f'), 'items.file#m0': asset('c') } },
    } } } }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => dynamicSchema))
      .toEqual({ complete: true, digests: ['a', 'c', 'e', 'f'].map((letter) => asset(letter).digest) })
  })

  it.each(['metadata', 'nested-metadata', 'unknown-value', 'unknown-dynamic', 'static-unknown', 'nested-unknown', 'stale-member', 'budget', 'wire15'] as const)(
    'keeps unsupported dynamic census incomplete: %s', (scenario) => {
      const local = session()
      const node = { id: asNodeId('n0'), type: 'Loader', values: scenario === 'unknown-value' ? { unknown: asset('e') } : {},
        dynamic: scenario === 'metadata' ? { mode: { hidden: asset('e') } }
          : scenario === 'nested-metadata' ? { items: { members: ['m0'], memberState: { m0: { mode: { hidden: asset('e') } } } } }
            : scenario === 'unknown-dynamic' || scenario === 'static-unknown' ? { future: {} }
              : scenario === 'nested-unknown' ? { items: { members: ['m0'], memberState: { m0: { future: {} } } } }
                : scenario === 'stale-member' ? { items: { members: [], memberState: { retired: { future: {} } } } }
            : scenario === 'budget' ? { items: { members: Array.from({ length: 600 }, (_, index) => `m${index}`) } } : {} }
      const document = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: { n0: node } } } } as WorkflowDocument
      const candidate: NodeSchema = scenario === 'wire15' ? { ...dynamicSchema, items: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: { kind: 'dynamicSlot', materialization: 'wire15', slotType: assetType, inputs: [assetInput('file', 'a')] },
      }] } : scenario === 'static-unknown' ? schema : dynamicSchema
      expect(workflowAssetRoots(document, local.historySnapshot(), () => candidate).complete).toBe(false)
    },
  )

  it('recognizes nested family state in its canonical member scope', () => {
    const local = session()
    const nested: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'items', type: assetType, optional: true,
      dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 }, template: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: { kind: 'dynamicCombo', options: [{ key: 'a', inputs: [assetInput('file', 'a')] },
          { key: 'b', inputs: [assetInput('file', 'b')] }] },
      }] } }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: {}, dynamic: {
        items: { members: ['m0'], memberState: { m0: { 'items.mode': { selected: 'b' } } } },
      } },
    } } } }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => nested))
      .toEqual({ complete: true, digests: [asset('b').digest] })
  })

  it.each(['undo', 'redo'] as const)('retains assets inserted before occupied array entries by %s history', (direction) => {
    const local = session([asset('b'), asset('c')])
    const path = ['graphs', 'g0', 'nodes', 'n0', 'values', 'files', 1]
    const insert = { op: 'add' as const, path, value: asset('a') }
    const remove = { op: 'remove' as const, path, oldValue: asset('a') }
    const record = direction === 'undo' ? { forward: [remove], inverse: [insert] }
      : { forward: [insert], inverse: [remove] }
    expect(workflowAssetRoots(local.doc, { revision: 1, undo: [], redo: [], [direction]: [record] }, resolve))
      .toEqual({ complete: true, digests: ['a', 'b', 'c'].map((letter) => asset(letter).digest) })
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b'), asset('c')])
  })

  it('rechecks shared dynamic nodes when historical connectivity activates slot defaults', () => {
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: {} },
      n1: { id: asNodeId('n1'), type: 'Loader', values: {} },
    } } } }
    const history = { revision: 1, redo: [], undo: [{ forward: [], inverse: [{ op: 'add' as const,
      path: ['graphs', 'g0', 'links', 'l0'], value: { id: 'l0', from: { node: 'n1', port: 'out' }, to: { node: 'n0', port: 'slot' } },
    }] }] }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => dynamicSchema).digests).toEqual([asset('a').digest])
    expect(workflowAssetRoots(document, history, () => dynamicSchema))
      .toEqual({ complete: true, digests: ['a', 'c'].map((letter) => asset(letter).digest) })
  })

  it.each(['asset', 'scalar', 'disconnected', 'unknown-port', 'mixed'] as const)(
    'requires supported types from every literal consumer: %s', (scenario) => {
      const local = session()
      const source = { id: asValueSourceId('literal'), value: scenario === 'scalar' ? 7 : [asset('e')] }
      const loader: NodeSchema = scenario === 'scalar' ? { ...schema, items: [{
        kind: 'input', id: 'files', optional: false, type: { kind: 'concrete', name: 'INT' },
      }] } : schema
      const opaque: NodeSchema = { ...schema, type: 'Opaque', items: [{
        kind: 'input', id: 'files', optional: false, type: { kind: 'wildcard' },
      }] }
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!,
        nodes: {
          n0: { id: asNodeId('n0'), type: 'Loader', values: {} },
          ...(scenario === 'mixed' ? { n1: { id: asNodeId('n1'), type: 'Opaque', values: {} } } : {}),
        },
        valueSources: { literal: source },
        links: scenario === 'disconnected' ? {} : {
          l0: { id: asLinkId('l0'), from: { valueSource: source.id },
            to: { node: asNodeId('n0'), port: asPortId(scenario === 'unknown-port' ? 'missing' : 'files') } },
          ...(scenario === 'mixed' ? { l1: { id: asLinkId('l1'), from: { valueSource: source.id },
            to: { node: asNodeId('n1'), port: asPortId('files') } } } : {}),
        },
      } } }
      const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] },
        (type) => type === 'Loader' ? loader : type === 'Opaque' ? opaque : undefined)
      expect(roots.complete).toBe(scenario === 'asset' || scenario === 'scalar')
      if (scenario === 'asset') expect(roots.digests).toEqual([asset('e').digest])
      if (scenario === 'scalar') expect(roots.digests).toEqual([])
    },
  )

  it('rechecks a shared literal source when historical node edits change its consumer type', () => {
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!,
      nodes: { n0: { id: asNodeId('n0'), type: 'Loader', values: {} } },
      valueSources: { literal: { id: asValueSourceId('literal'), value: [asset('e')] } },
      links: { l0: { id: asLinkId('l0'), from: { valueSource: asValueSourceId('literal') },
        to: { node: asNodeId('n0'), port: asPortId('files') } } },
    } } }
    const strings: NodeSchema = { ...schema, type: 'StringLoader', items: [{
      kind: 'input', id: 'files', optional: false, type: { kind: 'concrete', name: 'STRING' },
    }] }
    const schemas = (type: string) => type === 'StringLoader' ? strings : resolve(type)
    expect(workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, schemas))
      .toEqual({ complete: true, digests: [asset('e').digest] })
    expect(workflowAssetRoots(document, { revision: 1, redo: [], undo: [{ forward: [], inverse: [{
      op: 'replace', path: ['graphs', 'g0', 'nodes', 'n0', 'type'], oldValue: 'Loader', value: 'StringLoader',
    }] }] }, schemas).complete).toBe(false)
  })

  it('includes shared confirmed and pending document roots outside local history', async () => {
    const local = session()
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    const retained = { ...prepared.currentDocument, graphs: { g0: { ...prepared.currentDocument.graphs.g0!, nodes: {
      n0: { ...prepared.currentDocument.graphs.g0!.nodes.n0!, values: { files: [asset('e')] } },
    } } } }
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(declaration.digests).toEqual(['a', 'b', 'e'].map((letter) => asset(letter).digest))
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    const outcome = await admitWorkflowDispatch(connection, { ...prepared, retainedDocuments: [retained] }, resolve,
      () => true, { setItem: () => {} })
    expect(outcome.ok).toBe(true)
  })

  it.each(['acknowledged', 'lost', 'complete', 'revision', 'unavailable', 'stale'] as const)(
    'preserves incomplete ownership before candidate publication: %s', async (scenario) => {
      const local = session()
      const prepared = local.prepareDispatch!(replace('b'))
      if (!prepared.ok) throw new Error('candidate rejected')
      const opaque: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { id: asNodeId('n0'), type: 'Unavailable', values: { future: { files: [asset('e')] } } },
      } } } }
      const journal = new Map<string, string>()
      let stored: RetainedAssets | undefined
      const connection = {
        id: 'backend', assetUrl: () => 'http://assets.test/',
        retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
          expect(declaration).toEqual({ revision: 0, complete: false,
            digests: ['a', 'b', 'e'].map((letter) => asset(letter).digest) })
          expect([...journal.values()].map((value) => JSON.parse(value))).toEqual([{
            version: 3, connectionId: 'backend', assetBaseUrl: 'http://assets.test/', owner,
            digests: declaration.digests, complete: false,
            documentLineage: local.doc.lineage, documentRevision: prepared.history.revision,
            incompleteDiagnostics: [{ severity: 'error', origin: 'schema', code: 'workflow.asset.unresolvedInput',
              refs: [{ graphId: 'g0', nodeId: 'n0' }],
              message: "Unavailable (n0): Stored input 'future' has no resolved node schema",
            }],
          }])
          expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
          stored = { ...owner, ...declaration, revision: scenario === 'revision' ? 2 : 1,
            complete: scenario === 'complete' }
          if (scenario === 'lost' || scenario === 'unavailable') throw new Error('response unavailable')
          return stored
        },
        fetchRetainedAssets: async () => scenario === 'unavailable' ? undefined : stored,
      } as unknown as DinksterConnection
      const operation = admitWorkflowDispatch(connection, { ...prepared, retainedDocuments: [opaque] }, resolve,
        () => scenario !== 'stale', { setItem: (key, value) => { journal.set(key, value) } })
      const accepted = scenario === 'acknowledged' || scenario === 'lost'
      if (accepted) expect((await operation).ok).toBe(true)
      else await expect(operation).rejects.toThrow()
      expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(accepted ? 'b' : 'a')])
      expect(journal.size).toBe(1)
    },
  )

  it('acknowledges an empty known set as incomplete when every schema is unavailable', async () => {
    const local = session([])
    const prepared = local.prepareDispatch!({ command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n0', title: 'Opaque node',
    } })
    if (!prepared.ok) throw new Error('candidate rejected')
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(declaration).toEqual({ revision: 0, complete: false, digests: [] })
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    expect((await admitWorkflowDispatch(connection, prepared,
      () => undefined, () => true, { setItem: () => {} })).ok).toBe(true)
    expect(local.doc.graphs.g0!.nodes.n0!.title).toBe('Opaque node')
  })

  it('clears an asset widget while retaining its undoable asset', async () => {
    const assetSchema: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'files', optional: false,
      type: { kind: 'concrete', name: 'ASSET' }, widget: { widgetType: 'ASSET', options: {}, default: null },
    }] }
    const document = session().doc
    const local = createLocalSession({ ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
      n0: { ...document.graphs.g0!.nodes.n0!, values: { files: asset('a') } },
    } } } }, coreCommandRegistry([], () => assetSchema))
    const before = local.doc
    const prepared = local.prepareDispatch!({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'files', value: null,
    } })
    if (!prepared.ok) throw new Error('candidate rejected')
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(local.doc).toBe(before)
        expect(declaration).toEqual({ revision: 0, complete: true, digests: [asset('a').digest] })
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    expect((await admitWorkflowDispatch(connection, prepared, () => assetSchema, () => true,
      { setItem: () => {} })).ok).toBe(true)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toBeNull()
    expect(local.undo()).toBe(true)
    expect(local.doc).toEqual(before)
  })

  it.each(['widget', 'unmarked', 'typed', 'malformed-widget'] as const)('keeps only unresolved widget names admissible as incomplete: %s', async (scenario) => {
    const assetSchema: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'files', optional: false,
      type: { kind: 'concrete', name: 'ASSET' },
      ...(scenario === 'unmarked' ? {} : { widget: { widgetType: 'ASSET', options: {} } }),
    }] }
    const document = session().doc
    const local = createLocalSession({ ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
      n0: { ...document.graphs.g0!.nodes.n0!, values: { files: scenario === 'typed'
        ? { $typed: { type: 'ASSET', value: 'legacy.bin' } } : scenario === 'malformed-widget'
          ? { ...asset('a'), digest: 'not-canonical' } : 'legacy.bin' } },
    } } } }, coreCommandRegistry([], () => assetSchema))
    const before = local.doc
    const prepared = local.prepareDispatch!({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'files', value: asset('b'),
    } })
    if (!prepared.ok) throw new Error('candidate rejected')
    const journal = new Map<string, string>()
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(scenario).toBe('widget')
        expect(local.doc).toBe(before)
        expect(journal.size).toBe(1)
        expect(declaration).toEqual({ revision: 0, complete: false, digests: [asset('b').digest] })
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    const operation = admitWorkflowDispatch(connection, prepared, () => assetSchema, () => true,
      { setItem: (key, value) => { journal.set(key, value) } })
    if (scenario === 'widget') {
      expect((await operation).ok).toBe(true)
      expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual(asset('b'))
      expect(local.undo()).toBe(true)
      expect(local.doc).toEqual(before)
    } else {
      await expect(operation).rejects.toThrow('malformed')
      expect(local.doc).toBe(before)
      expect(journal.size).toBe(0)
    }
  })

  it.each(['unknown-schema', 'known-schema', 'typed', 'typed-extra'] as const)('rejects malformed stored identities: %s', async (scenario) => {
    const local = session()
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    const malformed = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { ...local.doc.graphs.g0!.nodes.n0!, values: { files: scenario === 'typed'
        ? { $typed: { type: false, value: asset('e') } } : scenario === 'typed-extra'
          ? { $typed: { type: 'asset<DATA>', value: asset('e'), hidden: 'unknown' } }
          : [{ ...asset('e'), digest: 'not-canonical' }] } },
    } } } }
    const journal = new Map<string, string>()
    await expect(admitWorkflowDispatch({} as DinksterConnection, { ...prepared, retainedDocuments: [malformed] },
      scenario === 'known-schema' ? resolve : () => undefined,
      () => true, { setItem: (key, value) => { journal.set(key, value) } }))
      .rejects.toThrow('malformed')
    expect(journal.size).toBe(0)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
  })

  it.each([false, true])('distinguishes missing historical schemas from stale replay: %s', async (stale) => {
    const local = session()
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(stale).toBe(false)
        expect(declaration).toEqual({ revision: 0, complete: false, digests: [asset('a').digest, asset('b').digest] })
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    const operation = admitWorkflowDispatch(connection, { ...prepared, currentHistory: {
      revision: 1, redo: [], undo: [{ forward: [], inverse: [{
        op: 'replace', path: ['graphs', 'g0', 'nodes', 'n0', 'type'], oldValue: stale ? 'Wrong' : 'Loader', value: 'Unavailable',
      }] }],
    } }, resolve, () => true, { setItem: () => { expect(stale).toBe(false) } })
    if (stale) await expect(operation).rejects.toThrow('stale')
    else expect((await operation).ok).toBe(true)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(stale ? 'a' : 'b')])
  })

  it('journals current and undo/redo roots before acknowledgment, then publishes once', async () => {
    const local = session()
    local.dispatch(replace('b'))
    local.dispatch(replace('c'))
    local.undo()
    const prepared = local.prepareDispatch!(replace('d'))
    if (!prepared.ok) throw new Error('candidate rejected')
    const requested = deferred<{ owner: RetainedAssetOwner; declaration: RetainedAssetDeclaration }>()
    const acknowledged = deferred<RetainedAssets>()
    const journal = new Map<string, string>()
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        requested.resolve({ owner, declaration })
        return acknowledged.promise
      },
    } as unknown as DinksterConnection
    const operation = admitWorkflowDispatch(connection, prepared, resolve, () => true,
      { setItem: (key, value) => { journal.set(key, value) } })
    const { owner, declaration } = await requested.promise
    expect(declaration.digests).toEqual(['a', 'b', 'c', 'd'].map((letter) => asset(letter).digest))
    expect([...journal.values()].map((value) => JSON.parse(value))).toEqual([{
      version: 3, connectionId: 'backend', assetBaseUrl: 'http://assets.test/', owner, digests: declaration.digests, complete: true,
      documentLineage: local.doc.lineage, documentRevision: prepared.history.revision,
    }])
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
    acknowledged.resolve({ ...owner, ...declaration, revision: 1 })
    expect((await operation).ok).toBe(true)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('d')])
    expect(local.canRedo).toBe(false)
    expect(prepared.commit().ok).toBe(false)
    expect(journal.size).toBe(1)
  })

  it('keeps mismatched, stale and lost-response ownership without replay or early publication', async () => {
    for (const scenario of ['mismatch', 'stale', 'lost', 'gone']) {
      const local = session()
      const prepared = local.prepareDispatch!(replace('b'))
      if (!prepared.ok) throw new Error('candidate rejected')
      let writes = 0
      let stored: RetainedAssets | undefined
      const journal = new Map<string, string>()
      const connection = {
        id: 'backend', assetUrl: () => 'http://assets.test/',
        retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
          writes++
          stored = { ...owner, ...declaration, revision: 1 }
          if (scenario === 'stale') local.dispatch(replace('c'))
          if (scenario === 'lost') throw new Error('response lost')
          return scenario === 'mismatch' ? { ...stored, scope: 'wrong' } : stored
        },
        fetchRetainedAssets: async () => scenario === 'mismatch' ? undefined : stored,
      } as unknown as DinksterConnection
      const operation = admitWorkflowDispatch(connection, prepared, resolve, () => scenario !== 'gone',
        { setItem: (key, value) => { journal.set(key, value) } })
      if (scenario === 'mismatch' || scenario === 'gone') await expect(operation).rejects.toThrow()
      else expect((await operation).ok).toBe(scenario === 'lost')
      expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset(
        scenario === 'lost' ? 'b' : scenario === 'stale' ? 'c' : 'a',
      )])
      expect(writes).toBe(1)
      expect(journal.size).toBe(1)
    }
  })

  it('refuses publication when durable intent cannot be written', async () => {
    const local = session()
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    let writes = 0
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async () => { writes++; throw new Error('unexpected request') },
    } as unknown as DinksterConnection
    await expect(admitWorkflowDispatch(connection, prepared, resolve, () => true,
      { setItem: () => { throw new Error('storage unavailable') } })).rejects.toThrow('storage unavailable')
    expect(writes).toBe(0)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('a')])
  })

  it('admits large documents without duplicating document bytes in the owner journal', async () => {
    const local = session()
    expect(local.dispatch({ command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n0', title: 'x'.repeat(50_000),
    } }).ok).toBe(true)
    const prepared = local.prepareDispatch!(replace('b'))
    if (!prepared.ok) throw new Error('candidate rejected')
    let stored = ''
    const connection = {
      id: 'backend', assetUrl: () => 'http://assets.test/',
      retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
        expect(JSON.parse(stored)).toMatchObject({ owner, digests: [asset('a').digest, asset('b').digest] })
        return { ...owner, ...declaration, revision: 1 }
      },
    } as unknown as DinksterConnection
    expect((await admitWorkflowDispatch(connection, prepared, resolve, () => true, { setItem: (_key, value) => {
      if (value.length > 2048) throw new Error('storage quota')
      stored = value
    } })).ok).toBe(true)
    expect(local.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
  })

  it('ignores overridden selection-name defaults but refuses unresolved effective names', () => {
    const local = session()
    const node = local.doc.graphs.g0!.nodes.n0!
    const document = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { ...node, values: { files: asset('e') } },
    } } } }
    const selectionSchema: NodeSchema = { ...schema, items: [{
      kind: 'input', id: 'files', optional: false,
      type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } },
      widget: { widgetType: 'ASSET', kind: 'model/vae', selection: true, options: {}, default: 'nested/source' },
    }] }
    const resolveSelection = () => selectionSchema
    const history = { revision: 0, undo: [], redo: [] }
    expect(workflowAssetRoots(document, history, resolveSelection)).toEqual({ complete: true, digests: [asset('e').digest] })
    const withoutOverride = { ...document, graphs: { g0: { ...document.graphs.g0, nodes: {
      n0: { ...node, values: {} },
    } } } }
    expect(workflowAssetRoots(withoutOverride, history, resolveSelection).complete).toBe(false)
  })

  it('rechecks an unchanged instance when historical graph edits change its derived schema', () => {
    const local = session()
    const root = local.doc.graphs.g0!
    const inner = { ...root, id: asGraphDefId('g1'), nodes: {
      inner: { id: asNodeId('inner'), type: 'Loader', values: {} },
    }, boundary: { inputs: [{ id: 'files', binds: { kind: 'port', node: 'inner', port: 'files' } }], outputs: [] } } as unknown as GraphDef
    const document = { ...local.doc, graphs: {
      g0: { ...root, nodes: { n0: { ...root.nodes.n0!, type: '#g1' } } }, g1: inner,
    } }
    const strings: NodeSchema = { ...schema, type: 'StringLoader', items: [{
      kind: 'input', id: 'files', optional: false, type: { kind: 'concrete', name: 'STRING' },
    }] }
    const resolveBoth = (type: string) => type === 'StringLoader' ? strings : resolve(type)
    expect(workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, resolveBoth))
      .toEqual({ complete: true, digests: [asset('a').digest] })
    expect(workflowAssetRoots(document, { revision: 1, redo: [], undo: [{ forward: [], inverse: [{
      op: 'replace', path: ['graphs', 'g1', 'nodes', 'inner', 'type'], oldValue: 'Loader', value: 'StringLoader',
    }] }] }, resolveBoth).complete).toBe(false)
  })

  it('keeps historical extensions and stale replay incomplete when node objects are shared', () => {
    const local = session()
    for (const inverse of [
      { op: 'add' as const, path: ['ext'], value: { unknown: { digest: asset('e').digest } } },
      { op: 'replace' as const, path: ['graphs', 'g0', 'nodes', 'n0', 'values', 'files'], oldValue: [], value: [asset('f')] },
    ]) {
      expect(workflowAssetRoots(local.doc, { revision: 1, redo: [], undo: [{ forward: [], inverse: [inverse] }] }, resolve).complete).toBe(false)
    }
  })

  it('includes nodes restored by history and typed sources added outside the node-only path', () => {
    const local = session()
    const roots = workflowAssetRoots(local.doc, { revision: 2, redo: [], undo: [
      { forward: [], inverse: [{ op: 'add', path: ['graphs', 'g0', 'valueSources'], value: {
        literal: { value: { $typed: { type: 'asset<DATA>', value: asset('f') } } },
      } }] },
      { forward: [], inverse: [{ op: 'add', path: ['graphs', 'g0', 'nodes', 'n1'], value: {
        id: 'n1', type: 'Loader', values: { files: [asset('e')] },
      } }] },
    ] }, resolve)
    expect(roots).toEqual({ complete: true, digests: ['a', 'e', 'f'].map((letter) => asset(letter).digest) })
  })

  it('certifies only the exact asset-free mask source association on mask nodes', () => {
    const local = session()
    const marker = { nodeId: 'source', outputId: 'mask' }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { ...local.doc.graphs.g0!.nodes.n0!, ext: { [MASK_PAINT_SOURCE_EXT_KEY]: marker } },
    } } } }
    const maskResolve = (type: string) => type === schema.type ? { ...schema, editorRole: 'mask-paint' as const } : undefined
    expect(workflowAssetRoots(document, local.historySnapshot(), maskResolve))
      .toEqual({ complete: true, digests: [asset('a').digest] })
    expect(workflowAssetRoots(document, local.historySnapshot(), resolve).complete).toBe(false)
    for (const ext of [
      { [MASK_PAINT_SOURCE_EXT_KEY]: { ...marker, hidden: asset('e') } },
      { [MASK_PAINT_SOURCE_EXT_KEY]: { ...marker, nodeId: asset('e') } },
      { [MASK_PAINT_SOURCE_EXT_KEY]: { ...marker, outputId: 'image' } },
      { [MASK_PAINT_SOURCE_EXT_KEY]: marker, unknown: asset('e') },
    ]) {
      const opaque: WorkflowDocument = { ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
        n0: { ...document.graphs.g0!.nodes.n0!, ext },
      } } } }
      expect(workflowAssetRoots(opaque, local.historySnapshot(), maskResolve).complete).toBe(false)
      expect(workflowAssetRoots(document, local.historySnapshot(), maskResolve, [opaque]).complete).toBe(false)
    }
  })

  it('does not certify unknown schemas, opaque values, dormant extensions or truncated lists', () => {
    const local = session()
    const document = local.doc
    expect(workflowAssetRoots(document, local.historySnapshot(), resolve)).toEqual({ complete: true, digests: [asset('a').digest] })
    expect(workflowAssetRoots(document, local.historySnapshot(), () => undefined).complete).toBe(false)
    expect(workflowAssetRoots({ ...document, ext: { unknown: { nested: asset('e') } } }, local.historySnapshot(), resolve).complete).toBe(false)
    local.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n0', inputId: 'files',
      value: Array.from({ length: 300 }, (_, index) => asset(index === 299 ? 'f' : 'a')) } })
    expect(workflowAssetRoots(local.doc, local.historySnapshot(), resolve).digests).toEqual([asset('a').digest, asset('f').digest])
    local.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n0', inputId: 'files', value: [{ digest: asset('a').digest }] } })
    expect(workflowAssetRoots(local.doc, local.historySnapshot(), resolve).complete).toBe(false)
  })
})
