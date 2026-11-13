import { prepareWorkflowApp } from './fixtures/workflow-app.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as core from '@dinkster/core'
import { createComponent } from 'solid-js'
import { renderToString } from 'solid-js/web'
import { DINKSTER_SCHEMA_WIRE_VERSION, EMPTY_CONNECTIVITY, asConnectionId, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asPromptId, asValueSourceId, coreCommandRegistry, createLocalSession, documentNodeResolver, elaborateInterface, serializeSelection, type NodeSchema, type WorkflowDocument } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import type { DinksterConnection, RetainedAssets, RetainedAssetOwner, RetainedAssetDeclaration } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { GLSL_EDITOR_KIND } from '../src/editors.js'
import { admitWorkflowDispatch, executionAssetRoots, reconcileWorkflowRetentions, retainWorkflowAssets, workflowAssetRoots } from '../src/workflow-asset-retention.js'
import { imageDocumentDigest } from '../src/image-document-local.js'
import { initializeProjectScope, scopedStorageKey } from '../src/projects.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { createPreviewLoader } from '../src/node-previews.js'
import { ProblemsPanel } from '../src/ProblemsPanel.js'
import { SharedWorkerDocumentAuthority, type WorkerPortLike } from '../src/shared-worker-authority.js'
import { SharedWorkerTabAuthority } from '../src/workspace-worker-authority.js'

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
  it.each(['resolved', 'dormant', 'dormant-missing', 'missing-resource', 'wrong-resource', 'wrong-size', 'missing-document', 'wrong-document', 'noncanonical-document', 'invalid-command', 'invalid-known-command', 'opaque-extension', 'comfy-inputs', 'comfy-empty', 'comfy-output-policy', 'comfy-short', 'comfy-long', 'comfy-uppercase', 'comfy-newline', 'comfy-nonstring', 'comfy-missing', 'comfy-null', 'comfy-array', 'comfy-extra', 'comfy-unknown', 'disconnected'] as const)(
    'resolves configured compositor inventory under independent ownership: %s', async (scenario) => {
      const f = recoveryFixture()
      f.entries.clear()
      vi.stubGlobal('localStorage', f.storage)
      const bytes = new Uint8Array([7, 19, 23])
      const resourceDigest = imageDocumentDigest(bytes)
      const comfyExtensions: Record<string, core.Json> = {
        'comfy-inputs': { inputs: ['0123456789abcdef', 'fedcba9876543210'] },
        'comfy-empty': { inputs: [] },
        'comfy-output-policy': { inputs: ['0123456789abcdef'] },
        'comfy-short': { inputs: ['0123456789abcde'] },
        'comfy-long': { inputs: ['0123456789abcdef0'] },
        'comfy-uppercase': { inputs: ['0123456789abcdeF'] },
        'comfy-newline': { inputs: ['0123456789abcdef\n'] },
        'comfy-nonstring': { inputs: [16] },
        'comfy-missing': {},
        'comfy-null': null,
        'comfy-array': [],
        'comfy-extra': { inputs: ['0123456789abcdef'], hidden: asset('d') },
        'comfy-unknown': { inputs: ['0123456789abcdef'] },
      }
      const image = {
        format: 'dinkster-image', formatVersion: 2, lineage: 'compositor-inventory',
        canvas: { width: 3, height: 2, colorSpace: 'srgb', channelDepth: 8, compositing: 'premultiplied-alpha' },
        allocation: { nextOrdinal: 1 }, rootLayerIds: [], layers: {}, masks: {},
        resources: { r0: { id: 'r0', kind: 'raster', digest: resourceDigest, byteSize: bytes.length + (scenario === 'wrong-size' ? 1 : 0),
          mediaType: 'image/png', width: 2, height: 1, colorSpace: 'srgb', channelDepth: 8, alphaMode: 'opaque' } },
        ...(scenario === 'opaque-extension' ? { extensions: { future: asset('d') } }
          : Object.hasOwn(comfyExtensions, scenario) ? { extensions: { comfy: comfyExtensions[scenario],
            ...(scenario === 'comfy-output-policy' ? { 'dinkster.outputPolicy': { format: 'jpeg', quality: 73 } } : {}),
            ...(scenario === 'comfy-unknown' ? { future: asset('d') } : {}),
          } } : {}),
      }
      const imageBytes = new TextEncoder().encode(core.canonicalJson(image) + (scenario === 'noncanonical-document' ? '\n' : ''))
      const documentDigest = imageDocumentDigest(imageBytes)
      const recipe = { version: 2, documentDigest, commands: scenario === 'invalid-command' ? [{ op: 'future' }]
        : scenario === 'invalid-known-command' ? [{ op: 'canvas', changes: { width: 0 } }] : [] }
      const compositorInput = { kind: 'input' as const, id: 'compositor', optional: false,
        type: { kind: 'concrete' as const, name: 'COMPOSITOR' }, widget: { widgetType: 'COMPOSITOR', options: {}, default: {} } }
      const dormant = scenario === 'dormant' || scenario === 'dormant-missing'
      const compositorSchema: NodeSchema = { ...schema, items: dormant ? [{
        kind: 'input', id: 'mode', optional: false, type: { kind: 'concrete', name: 'STRING' },
        dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [
          { key: 'active', inputs: [] }, { key: 'dormant', inputs: [compositorInput] },
        ] },
      }] : [compositorInput] }
      const workflow = session([]).doc
      const document: WorkflowDocument = { ...workflow, graphs: { g0: { ...workflow.graphs.g0!, nodes: {
        n0: { ...workflow.graphs.g0!.nodes.n0!, ...(dormant ? { dynamic: { mode: { selected: 'active' } } } : {}),
          values: { [dormant ? 'mode.compositor' : 'compositor']: recipe } },
      } } } }
      const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => compositorSchema)
      expect(roots.complete).toBe(false)
      const owners = new Map<string, RetainedAssets>()
      const listeners = new Set<() => void>()
      const candidateAck = deferred<void>()
      const candidateEntered = deferred<void>()
      const connection = {
        id: asConnectionId('compositor-inventory'), assetUrl: () => 'http://test/api/assets/',
        status: { subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
        retainAssets: async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
          if (owner.ownerKind === 'document') { candidateEntered.resolve(); await candidateAck.promise }
          const retained = { ...owner, ...declaration, revision: 1 }
          owners.set(owner.ownerId, retained)
          return retained
        },
        fetchRetainedAssets: async (owner: RetainedAssetOwner) => owners.get(owner.ownerId),
        releaseRetainedAssets: async (owner: RetainedAssetOwner) => {
          const before = owners.get(owner.ownerId)!
          const released = { ...before, revision: 2, digests: [], complete: true }
          owners.set(owner.ownerId, released)
          return released
        },
        checkAssetAvailability: async (digests: readonly string[]) => digests.map((digest) => ({ digest,
          status: (digest === documentDigest ? scenario === 'missing-document'
            : scenario === 'missing-resource' || scenario === 'dormant-missing') ? 'missing' : 'available',
        })),
        fetchAssetBytes: async (digest: string) => {
          expect([...owners.values()].some((owner) => owner.ownerKind === 'preview' && owner.revision === 1 && !owner.complete)).toBe(true)
          if (scenario === 'disconnected') for (const listener of listeners) listener()
          if (digest === documentDigest) return scenario === 'missing-document' ? undefined
            : scenario === 'wrong-document' ? bytes.buffer : imageBytes.buffer
          expect(digest).toBe(resourceDigest)
          return scenario === 'missing-resource' || scenario === 'dormant-missing' ? undefined
            : scenario === 'wrong-resource' ? imageBytes.buffer : bytes.buffer
        },
      } as unknown as DinksterConnection
      const operation = retainWorkflowAssets(connection, document.lineage, 0, roots, f.storage)
      if (scenario === 'disconnected') {
        await expect(operation).rejects.toThrow('changed during read')
        expect([...owners.values()].every((owner) => owner.ownerKind === 'preview' && owner.revision === 1)).toBe(true)
        return
      }
      await candidateEntered.promise
      expect([...owners.values()].every((owner) => owner.ownerKind === 'preview' && owner.revision === 1)).toBe(true)
      candidateAck.resolve()
      const retained = await operation
      expect(retained.complete).toBe(['resolved', 'dormant', 'comfy-inputs', 'comfy-empty', 'comfy-output-policy'].includes(scenario))
      expect(retained.digests).toEqual((['missing-document', 'wrong-document', 'noncanonical-document'].includes(scenario)
        ? [documentDigest] : ['opaque-extension', 'comfy-extra', 'comfy-unknown'].includes(scenario) ? [documentDigest, resourceDigest, asset('d').digest]
        : [documentDigest, resourceDigest]).sort())
      expect([...owners.values()].filter((owner) => owner.ownerKind === 'preview'))
        .toEqual([expect.objectContaining({ revision: 2, digests: [], complete: true })])
      expect([...owners.values()].filter((owner) => owner.ownerKind === 'document')).toEqual([retained])
      expect(roots.complete).toBe(false)
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
        type: { kind: 'concrete', name: 'LOAD_3D' }, widget: { widgetType: 'LOAD_3D', options: {} },
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
    expect(await app.shareActiveTab()).toBe('Workflow ownership unconfirmed. Publication and sharing remain unavailable.')
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
          code: 'workflow.asset.unresolvedInput', message: expect.stringContaining('Loader (n0)'),
        })] }))
      const html = renderToString(() => createComponent(ProblemsPanel, {
        app: ownerApp, diagnostics: () => ownerApp.problems.get(), compatSkips: () => [],
      }))
      expect(html).toContain('Workflow ownership unconfirmed.')
      expect(html).toContain("Loader (n0): Declared input 'mode.slot' has an unsupported asset census widget binding 'LOAD_3D'")
      expect(html).toContain('Publication and sharing remain unavailable.')
      const beforePublication = shared.store.doc
      const prepared = shared.store.prepareDispatch!(replace('b'))
      if (!prepared.ok) throw new Error('candidate rejected before retention')
      expect(await admitWorkflowDispatch(app.connection, prepared, () => dynamic, () => true))
        .toMatchObject({ ok: false, diagnostics: [{ code: 'command.retention.required' }] })
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
        executionAssetReader: (execution, digests, holder) => ownerApp.executionAssetReader(execution, digests, holder),
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
        expect(owner.ownerKind).toBe('preview')
        expect(declaration.complete).toBe(true)
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
        inputAssetReader: (digest, holder) => ownerApp.workflowAssetReader(tab, digest, holder),
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
        expect(owner.ownerKind).toBe('preview')
        expect(declaration.complete).toBe(true)
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
        type: { kind: 'concrete', name: 'LOAD_3D' }, widget: { widgetType: 'LOAD_3D', options: {} },
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
      incompleteDiagnostics: [expect.objectContaining({ code: 'workflow.asset.unresolvedInput' })] }))
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ severity: 'warning',
      code: 'workflow.execution.ownershipUnconfirmed' }))
    expect(await app.saveWorkflow(tab.id)).toBe(false)
    expect(await app.shareActiveTab()).toContain('Publication and sharing remain unavailable.')
  })

  it('admits changed compositor commands with the same document identity and saves the resolved snapshot', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    const compositorSchema: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'compositor', optional: false,
      type: { kind: 'concrete', name: 'COMPOSITOR' }, widget: { widgetType: 'COMPOSITOR', options: {}, default: {} } }] }
    app = createWorkflowApp([compositorSchema])
    const image = { format: 'dinkster-image', formatVersion: 2, lineage: 'saved-compositor',
      canvas: { width: 3, height: 2, colorSpace: 'srgb', channelDepth: 8, compositing: 'premultiplied-alpha' },
      allocation: { nextOrdinal: 0 }, rootLayerIds: [], layers: {}, masks: {}, resources: {},
    }
    const imageBytes = new TextEncoder().encode(core.canonicalJson(image))
    const documentDigest = imageDocumentDigest(imageBytes)
    vi.spyOn(app.connection, 'checkAssetAvailability').mockImplementation(async (digests) =>
      digests.map((digest) => ({ digest, status: 'available' })))
    vi.spyOn(app.connection, 'fetchAssetBytes').mockResolvedValue(imageBytes.buffer)
    vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) =>
      ({ ...owner, revision: revision + 1, complete: true, digests: [] }))
    const workflow = session([]).doc
    await app.openDocument({ ...workflow, graphs: { g0: { ...workflow.graphs.g0!, nodes: {
      n0: { ...workflow.graphs.g0!.nodes.n0!, values: { compositor: { version: 2, documentDigest, commands: [] } } },
    } } } }, 'Configured compositor')
    const tab = app.activeTab()!
    const recipe = { version: 2, documentDigest, commands: [{ op: 'canvas', changes: { width: 5 } }] }
    expect(tab.store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'compositor', value: recipe,
    } }).ok).toBe(false)
    expect((await app.dispatchTo(tab, { command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'compositor', value: recipe,
    } })).ok).toBe(true)
    const upload = vi.spyOn(app.connection, 'uploadAsset').mockResolvedValue(asset('c').digest)
    vi.spyOn(app.connection, 'createLibraryRecord').mockResolvedValue({
      id: 'saved-compositor', scope: 'local', name: 'Configured compositor', digest: asset('c').digest,
      mediaType: 'application/json', labels: [], created: 1, modified: 1, revision: 1,
    })
    expect(await app.saveWorkflow(tab.id)).toBe(true)
    expect(JSON.parse(upload.mock.calls[0]![0] as string).graphs.g0.nodes.n0.values.compositor).toEqual(recipe)
    expect(app.problems.get().filter((problem) => problem.code === 'workflow.execution.ownershipUnconfirmed')).toEqual([])
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

  it.each(['acknowledged', 'lost', 'refused', 'reused-owner', 'pending-intent'] as const)(
    'recovers saved ownership after renderer restart without replaying old owners: %s', async (scenario) => {
      vi.useFakeTimers()
      try {
        vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
        app = createWorkflowApp([schema])
        const owners = new Map<string, RetainedAssets>()
        const retain = async (owner: RetainedAssetOwner, declaration: RetainedAssetDeclaration) => {
          const receipt = { ...owner, ...declaration, revision: 1 }
          owners.set(owner.ownerId, receipt)
          return receipt
        }
        const release = async (owner: RetainedAssetOwner, revision: number) => {
          const receipt = { ...owners.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
          owners.set(owner.ownerId, receipt)
          return receipt
        }
        vi.mocked(app.connection.retainAssets).mockImplementation(retain)
        vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(release)
        expect(await app.openDocument(session().doc, 'Before restart')).toEqual([])
        expect((await app.dispatchRetainedTo(app.activeTab()!, replace('b'))).ok).toBe(true)
        app.flushPersistTabs(true)
        await vi.advanceTimersByTimeAsync(0)
        const canonical = JSON.parse(localStorage.getItem(scopedStorageKey('dinkster.openTabs'))!)
        const original: RetainedAssets = canonical.assetRetention.owners.find((entry: { documentLineage: string }) =>
          entry.documentLineage === 'retention').retained
        expect(original.digests).toEqual([asset('b').digest])
        app.dispose()
        const oldOwners = new Map(owners)
        const oldIntents = new Map([...oldOwners.keys()].map((id) => {
          const key = scopedStorageKey(`dinkster.workflow-retentions.${id}`)
          if (scenario === 'pending-intent' && id === original.ownerId) {
            const { acknowledgedRevision: _acknowledged, ...pending } = JSON.parse(localStorage.getItem(key)!)
            localStorage.setItem(key, JSON.stringify(pending))
          }
          return [key, localStorage.getItem(key)!] as const
        }))
        app = prepareWorkflowApp(new AppState())
        const schemas = new Map([[schema.type, schema]])
        app.registry.set({ connection: app.connection.id, schemas, diagnostics: [], hash: 'restarted',
          resolve: (type) => schemas.get(type) })
        const admitted = deferred<void>()
        const restoredOwners: RetainedAssetOwner[] = []
        vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
          expect(oldOwners.has(owner.ownerId)).toBe(false)
          const restored = declaration.digests.includes(asset('b').digest)
          if (restored) {
            restoredOwners.push(owner)
            await admitted.promise
            if (scenario === 'refused') throw new Error('restart admission refused')
          }
          const receipt = await retain(owner, declaration)
          if (restored && scenario === 'reused-owner') owners.set(owner.ownerId, { ...receipt, revision: 3 })
          if (restored && (scenario === 'lost' || scenario === 'reused-owner')) throw new Error('restart acknowledgment lost')
          return receipt
        })
        vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
        vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(release)
        expect(await reconcileWorkflowRetentions(app.connection, new AbortController().signal)).toBe(true)
        for (const [key, raw] of oldIntents) expect(localStorage.getItem(key)).toBe(raw)
        let settled = false
        const startup = app.confirmStartupOwnership().then(() => true, () => false)
          .finally(() => { settled = true })
        await vi.advanceTimersByTimeAsync(0)
        expect(settled).toBe(false)
        for (const [id, receipt] of oldOwners) expect(owners.get(id)).toEqual(receipt)
        admitted.resolve()
        expect(await startup).toBe(scenario !== 'refused' && scenario !== 'reused-owner')
        expect(app.tabs.get().find((tab) => tab.id === 'retention')!.store.doc.graphs.g0!.nodes.n0!.values.files)
          .toEqual([asset('b')])
        expect(restoredOwners).toHaveLength(1)
        const restoredOwner = restoredOwners[0]!
        const restoredReceipt = owners.get(restoredOwner.ownerId)
        expect(restoredReceipt).toEqual(scenario === 'refused' ? undefined : {
          ...restoredOwner, complete: true, digests: [asset('b').digest],
          revision: scenario === 'reused-owner' ? 3 : 1,
        })
        const replacementAdmitted = deferred<void>()
        vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
          expect(oldOwners.has(owner.ownerId)).toBe(false)
          expect(owner.ownerId).not.toBe(restoredOwner.ownerId)
          await replacementAdmitted.promise
          return retain(owner, declaration)
        })
        const restoredTab = app.tabs.get().find((tab) => tab.id === 'retention')!
        let replaced = false
        const replacement = app.dispatchRetainedTo(restoredTab, replace('c')).finally(() => { replaced = true })
        await vi.advanceTimersByTimeAsync(0)
        expect(replaced).toBe(false)
        expect(restoredTab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('b')])
        expect(owners.get(restoredOwner.ownerId)).toEqual(restoredReceipt)
        replacementAdmitted.resolve()
        expect((await replacement).ok).toBe(true)
        await vi.advanceTimersByTimeAsync(0)
        expect(restoredTab.store.doc.graphs.g0!.nodes.n0!.values.files).toEqual([asset('c')])
        expect(owners.get(restoredOwner.ownerId)).toEqual(scenario === 'refused' || scenario === 'reused-owner'
          ? restoredReceipt : { ...restoredReceipt!, revision: 2, complete: true, digests: [] })
        for (const [id, receipt] of oldOwners) expect(owners.get(id)).toEqual(receipt)
        for (const [key, raw] of oldIntents) expect(localStorage.getItem(key)).toBe(raw)
      } finally { vi.useRealTimers() }
    },
  )

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
    'confirms a separate complete selection owner before a picker can publish: %s', async (scenario) => {
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
        expect(declaration).toEqual({ revision: 0, complete: true, digests: [asset('b').digest, asset('c').digest] })
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

  it.each(['missing', 'out-of-range', 'linked'] as const)('opens a %s output count for repair without certifying its roots', async (variant) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    const counted: NodeSchema = { ...schema, items: [...schema.items,
      { kind: 'input', id: 'count', optional: false, type: { kind: 'concrete', name: 'INT' } },
      { kind: 'output', id: 'count', type: { kind: 'concrete', name: 'INT' } },
      { kind: 'output', id: 'outs', type: { kind: 'concrete', name: 'DATA' }, dynamic: {
        kind: 'autogrow', materialization: 'wire15', count: { input: 'count', suffix: 'index' },
        template: [{ kind: 'input', id: 'item', optional: false, type: { kind: 'concrete', name: 'DATA' } }],
        naming: { kind: 'prefix', prefix: '', min: 1, max: 4 },
      } },
    ] }
    const original = session().doc
    const document: WorkflowDocument = { ...original, graphs: { g0: { ...original.graphs.g0!,
      nodes: { n0: { ...original.graphs.g0!.nodes.n0!, values: {
        files: [asset('a')], ...(variant === 'missing' ? {} : { count: variant === 'linked' ? 2 : 5 }),
      } } },
      links: variant === 'linked' ? { l0: { id: asLinkId('l0'),
        from: { node: asNodeId('n0'), port: asPortId('count') },
        to: { node: asNodeId('n0'), port: asPortId('count') },
      } } : {},
    } } }
    app = createWorkflowApp([counted])
    expect(await app.openDocument(document, 'Repair output count')).toEqual([])
    const tab = app.activeTab()!
    const roots = workflowAssetRoots(tab.store.doc, tab.store.historySnapshot(), () => counted, [], 'admission')
    expect(roots).toMatchObject({ complete: false, digests: [asset('a').digest] })
    expect(roots.refusal).toBeUndefined()
    expect(workflowAssetRoots(tab.store.doc, tab.store.historySnapshot(), () => counted).refusal)
      .toBe('Workflow dynamic identities are invalid')
    expect(await app.saveWorkflow(tab.id)).toBe(false)
    expect(app.connection.retainAssets).toHaveBeenCalledWith(expect.anything(), {
      revision: 0, complete: false, digests: [asset('a').digest],
    })
  })

  it.each((['file', 'direct'] as const).flatMap((kind) =>
    (['accepted', 'view', 'lost', 'refreshed-registry', 'changed-schema', 'changed-capabilities', 'refused', 'edited', 'closed', 'replacement', 'registry', 'target', 'canceled', 'disposed'] as const)
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
      if (scenario === 'refreshed-registry' || scenario === 'changed-schema' || scenario === 'changed-capabilities') {
        const registry = app.registry.get()!
        const schemas = new Map([...registry.schemas].map(([type, schema]) => [type, structuredClone(schema)]))
        if (scenario === 'changed-schema') schemas.set(schema.type, { ...schema, items: [] })
        app.registry.set({ ...registry, schemas, resolve: (type) => schemas.get(type),
          ...(scenario === 'changed-capabilities' ? { graphFeatures: ['typedLiteral'] } : {}) })
      }
      if (scenario === 'target') app.setTabTarget(previous.id, app.addBackend('http://other:8000', 'Other', false)!.id)
      if (scenario === 'canceled') {
        wanted = false
        if (kind === 'direct') app.createWorkflow()
      }
      if (scenario === 'disposed') app.dispose()
      response.resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
      const accepted = scenario === 'accepted' || scenario === 'view' || scenario === 'lost' || scenario === 'refreshed-registry'
      expect(await operation).toBe(accepted)
      expect(app.tabs.get().some((tab) => tab.id === 'incoming')).toBe(accepted)
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
      expect(vi.mocked(app.connection.retainAssets).mock.calls.flatMap(([, declaration]) => declaration.digests))
        .not.toContain(asset('a').digest)
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

  it.each(['default', 'stored', 'embedded-asset', 'extra-target-field', 'wrong-list-socket'] as const)(
    'censuses real retained widget declarations without guessing ownership: %s', (scenario) => {
      const local = session([])
      const registry = buildDinksterRegistry(asConnectionId('retention'), { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {
        Loader: { version: 1, idempotent: true, interface: [
          { role: 'input', id: 'selections', required: true,
            type: { kind: 'list', element: { kind: 'concrete', types: ['COMBO'] } },
            default: ['red', 'blue'], widget: { type: 'MULTI_COMBO', options: ['red', 'green', 'blue'] } },
          { role: 'input', id: 'markdown', required: true, type: { kind: 'concrete', types: ['STRING'] },
            default: '# Try Markdown', widget: { type: 'MARKDOWN' } },
          { role: 'input', id: 'colors', required: true,
            type: { kind: 'list', element: { kind: 'concrete', types: [scenario === 'wrong-list-socket' ? 'ASSET' : 'STRING'] } },
            default: ['#ff6600', '#2255aa'], widget: { type: 'COLORS' } },
          { role: 'input', id: 'button', required: true, type: { kind: 'concrete', types: ['STRING'] },
            default: '', widget: { type: 'BUTTON', display_name: 'Open node help', command: 'node.help' } },
          { role: 'input', id: 'items', required: true,
            type: { kind: 'list', element: { kind: 'concrete', types: ['STRING'] } },
            default: ['first', 'second'], widget: { type: 'STRING', multiline: true } },
          { role: 'input', id: 'target', required: true, type: { kind: 'concrete', types: ['SAVE_TARGET'] },
            default: null, widget: { type: 'SAVE_TARGET', suffix: '.pgm' } },
        ] },
      } })
      expect(registry.resolve('Loader')?.items).toHaveLength(6)
      const values = scenario === 'default' ? {} : {
        selections: ['green'], markdown: '**Edited**', colors: ['#123456'], button: null,
        items: scenario === 'embedded-asset' ? [asset('c')] : ['third'],
        target: { mount: 'outputs', prefix: 'gallery/image',
          ...(scenario === 'extra-target-field' ? { hidden: asset('d') } : {}) },
      }
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { id: asNodeId('n0'), type: 'Loader', values },
      } } } }
      const roots = workflowAssetRoots(document, local.historySnapshot(), registry.resolve)
      expect(roots.complete).toBe(scenario === 'default' || scenario === 'stored')
      expect(roots.digests).toEqual(scenario === 'embedded-asset' ? [asset('c').digest]
        : scenario === 'extra-target-field' ? [asset('d').digest] : [])
    },
  )

  it.each(['recorded', 'cleared', 'foreign-socket', 'wrong-media', 'unknown-field'] as const)(
    'censuses the served AUDIO recording declaration: %s', (scenario) => {
      const local = session([])
      const audioAssetRef = { ...asset('a'), name: 'recording.webm', mediaType: 'audio/webm', virtualPath: 'imports/recording.webm' }
      const registry = buildDinksterRegistry(asConnectionId('retention'), { schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: {
        Recorder: { interface: [
          { role: 'input', id: 'audio', type: { kind: 'concrete', types: [scenario === 'foreign-socket' ? 'FOREIGN' : 'AUDIO'] },
            widget: { type: 'AUDIO_RECORD' } },
        ] },
      } })
      const value = scenario === 'cleared' ? null : {
        ...audioAssetRef,
        ...(scenario === 'wrong-media' ? { mediaType: 'image/png' } : {}),
        ...(scenario === 'unknown-field' ? { hidden: asset('b') } : {}),
      }
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { id: asNodeId('n0'), type: 'Recorder', values: { audio: value } },
      } } } }
      const roots = workflowAssetRoots(document, local.historySnapshot(), registry.resolve)
      expect(roots.complete).toBe(scenario === 'recorded' || scenario === 'cleared')
      expect(roots.digests).toEqual(scenario === 'cleared' ? [] : scenario === 'unknown-field'
        ? [asset('b').digest] : [audioAssetRef.digest])
    },
  )

  it.each([
    { widgetType: 'AUDIO_RECORD', value: { ...asset('a'), mediaType: 'audio/wav' }, complete: true, digests: [asset('a').digest] },
    { widgetType: 'WEBCAM', value: { ...asset('b'), mediaType: 'image/png' }, complete: true, digests: [asset('b').digest] },
    { widgetType: 'AUDIO_RECORD', value: null, complete: true, digests: [] },
    { widgetType: 'WEBCAM', value: { ...asset('b'), mediaType: 'audio/wav' }, complete: false, digests: [asset('b').digest] },
    { widgetType: 'IMAGECOMPARE', value: null, complete: true, digests: [] },
    { widgetType: 'RESOLUTION_PREVIEW', value: null, complete: true, digests: [] },
    { widgetType: 'BOUNDING_BOX', value: { x: 7, y: 13, width: 64, height: 32 }, complete: true, digests: [] },
    { widgetType: 'BOUNDING_BOX', value: { x: 7, y: 13, width: 64, height: 32, hidden: asset('c') }, complete: false, digests: [asset('c').digest] },
    { widgetType: 'LOAD_3D', value: undefined, complete: false, digests: [] },
    { widgetType: 'VIDEO_EDIT', value: undefined, complete: false, digests: [] },
    { widgetType: 'LOAD_3D', value: { model: asset('d') }, complete: false, digests: [asset('d').digest] },
    { widgetType: 'VIDEO_EDIT', value: { trim: { start_time: 1, duration: 3 }, hidden: asset('e') }, complete: false, digests: [asset('e').digest] },
  ])('keeps $widgetType ownership closed for $value', ({ widgetType, value, complete, digests }) => {
    const local = session([])
    const candidate: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'value', optional: true,
      type: { kind: 'concrete', name: widgetType }, widget: { widgetType, options: {} },
    }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', values: value === undefined ? {} : { value: value as core.Json } },
    } } } }
    const roots = workflowAssetRoots(document, local.historySnapshot(), () => candidate)
    expect(roots.complete).toBe(complete)
    expect(roots.digests).toEqual(digests)
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

  it.each([
    { name: 'objects', value: { interpolation: 'linear', points: [{ position: 0, value: 0.2 }, { position: 1, value: 0.8 }] }, valid: true },
    { name: 'pairs', value: { interpolation: 'monotone_cubic', points: [[0, 0.2], [1, 0.8]] }, valid: true },
    { name: 'implicit interpolation', value: { points: [[0, 0.2], [1, 0.8]] }, valid: true },
    { name: 'bare pairs', value: [[0, 0.2], [1, 0.8]], valid: true },
    { name: 'empty points', value: { points: [] }, valid: true },
    { name: 'unordered finite points', value: { points: [[1.5, -0.2], [-0.25, 2.8]] }, valid: true },
    { name: 'unknown interpolation', value: { interpolation: 'future', points: [[0, 0.2], [1, 0.8]] }, valid: false },
    { name: 'extra curve fields', value: { points: [[0, 0.2], [1, 0.8]], resource: asset('c') }, valid: false },
    { name: 'extra point fields', value: { points: [{ position: 0, value: 0.2, resource: asset('c') }] }, valid: false },
    { name: 'asset point', value: { points: [[0, asset('c')]] }, valid: false },
    { name: 'oversized pair', value: { points: [[0, 0.2, 0.8]] }, valid: false },
    { name: 'string coordinate', value: { points: [['0', 0.2]] }, valid: false },
    { name: 'infinite coordinate', value: { points: [[0, Infinity]] }, valid: false },
    { name: 'NaN coordinate', value: { points: [[NaN, 0.2]] }, valid: false },
    { name: 'null', value: null, valid: false },
  ])('classifies closed CURVE values without discarding opaque roots: $name', ({ value, valid }) => {
    const local = session()
    const curveSchema: NodeSchema = { ...schema, items: [...schema.items, {
      kind: 'input', id: 'curve', optional: false, type: { kind: 'concrete', name: 'CURVE' },
      widget: { widgetType: 'CURVE', options: {}, default: { points: [[0, 0], [1, 1]] } },
    }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { ...local.doc.graphs.g0!.nodes.n0!, values: { files: [asset('a')], curve: value as core.Json } },
    } } } }
    const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => curveSchema)
    expect(roots.complete).toBe(valid)
    expect(roots.digests).toEqual(JSON.stringify(value).includes(asset('c').digest)
      ? [asset('a').digest, asset('c').digest] : [asset('a').digest])
    if (!valid) expect(roots.incompleteDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'workflow.asset.unresolvedInput', message: expect.stringContaining("'curve'") }),
    ]))
  })

  it.each(['COLOR', 'STRING'].flatMap((socket) =>
    ['default', 'default-number', 'default-null', 'default-opaque', 'stored', 'empty', 'typed', 'typed-number', 'socket', 'invalid-value', 'number', 'null', 'typed-mismatch', 'invalid-binding', 'unknown-widget']
      .map((scenario) => ({ socket, scenario }))))(
    'counts $socket-backed colors without inventing assets: $scenario', ({ socket, scenario }) => {
      const local = session()
      const colorSchema: NodeSchema = { ...schema, items: [...schema.items, {
        kind: 'input', id: 'color', optional: false,
        type: { kind: 'concrete', name: scenario === 'invalid-binding' ? 'FLOAT' : socket },
        ...(scenario === 'socket' ? {} : { widget: {
          widgetType: scenario === 'unknown-widget' ? 'opaque' : 'COLOR', options: {},
          default: scenario === 'default-number' ? 123 : scenario === 'default-null' ? null
            : scenario === 'default-opaque' ? asset('c') : '#c1375a',
        } }),
      }] }
      const color = scenario === 'typed' ? { $typed: { type: socket, value: '#179a4f' } }
        : scenario === 'typed-number' ? { $typed: { type: socket, value: 123 } }
        : scenario === 'typed-mismatch' ? { $typed: { type: socket === 'COLOR' ? 'STRING' : 'COLOR', value: '#179a4f' } }
        : scenario === 'number' ? 123 : scenario === 'null' ? null : scenario === 'empty' ? ''
        : scenario === 'invalid-value' ? asset('c') : '#179a4f'
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { ...local.doc.graphs.g0!.nodes.n0!, values: { files: [asset('a')],
          ...(scenario.startsWith('default') ? {} : { color }) } },
      } } } }
      const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => colorSchema)
      const invalid = ['default-number', 'default-null', 'default-opaque', 'invalid-value', 'number', 'null', 'typed-number', 'typed-mismatch', 'invalid-binding', 'unknown-widget'].includes(scenario)
      expect(roots.complete).toBe(!invalid)
      expect(roots.digests).toEqual(['invalid-value', 'default-opaque'].includes(scenario)
        ? [asset('a').digest, asset('c').digest] : [asset('a').digest])
      if (invalid) expect(roots.incompleteDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'workflow.asset.unresolvedInput', message: expect.stringContaining("'color'") }),
      ]))
    })

  it.each(['default', 'normalized-default', 'empty-object', 'empty', 'typed', 'configured', 'malformed', 'typed-mismatch', 'commands-without-document', 'unknown-command', 'invalid-binding', 'unknown-widget'] as const)(
    'retains compositor document identities without certifying unresolved resources: %s', (scenario) => {
      const local = session()
      const recipe = { version: 2, documentDigest: null, commands: [] }
      const compositorSchema: NodeSchema = { ...schema, items: [...schema.items, {
        kind: 'input', id: 'compositor', optional: false,
        type: { kind: 'concrete', name: scenario === 'invalid-binding' ? 'STRING' : 'COMPOSITOR' },
        widget: { widgetType: scenario === 'unknown-widget' ? 'opaque' : 'COMPOSITOR', options: {},
          default: scenario === 'default' ? {} : recipe },
      }] }
      const value = scenario === 'configured' ? { ...recipe, documentDigest: asset('c').digest }
        : scenario === 'empty-object' ? {}
        : scenario === 'malformed' ? { ...recipe, documentDigest: asset('c').digest, commands: null }
        : scenario === 'typed' ? { $typed: { type: 'COMPOSITOR', value: recipe } }
        : scenario === 'typed-mismatch' ? { $typed: { type: 'STRING', value: '' } }
        : scenario === 'commands-without-document' ? { ...recipe, commands: [{ op: 'reorder', ids: [] }] }
        : scenario === 'unknown-command' ? { ...recipe, documentDigest: asset('c').digest, commands: [{ op: 'future', value: asset('d') }] }
        : recipe
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { ...local.doc.graphs.g0!.nodes.n0!, values: { files: [asset('a')],
          ...(['default', 'normalized-default'].includes(scenario) ? {} : { compositor: value }) } },
      } } } }
      const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => compositorSchema)
      expect(roots.complete).toBe(['default', 'normalized-default', 'empty-object', 'empty', 'typed'].includes(scenario))
      expect(roots.digests).toEqual(scenario === 'unknown-command'
        ? [asset('a').digest, asset('c').digest, asset('d').digest]
        : ['configured', 'malformed'].includes(scenario) ? [asset('a').digest, asset('c').digest] : [asset('a').digest])
      if (!roots.complete) expect(roots.incompleteDiagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'workflow.asset.unresolvedInput', message: expect.stringContaining("'compositor'") }),
      ]))
    })

  it('keeps configured compositor document roots after clearing an undoable recipe', () => {
    const local = session()
    const empty = { version: 2, documentDigest: null, commands: [] }
    const compositorSchema: NodeSchema = { ...schema, items: [...schema.items, {
      kind: 'input', id: 'compositor', optional: false, type: { kind: 'concrete', name: 'COMPOSITOR' },
      widget: { widgetType: 'COMPOSITOR', options: {}, default: empty },
    }] }
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { ...local.doc.graphs.g0!.nodes.n0!, values: {
        files: [asset('a')], compositor: { ...empty, documentDigest: asset('c').digest },
      } },
    } } } }
    const workflow = createLocalSession(document, coreCommandRegistry([], () => compositorSchema))
    expect(workflow.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'n0', inputId: 'compositor', value: empty,
    } }).ok).toBe(true)
    expect(workflowAssetRoots(workflow.doc, { revision: workflow.revision, undo: [], redo: [] }, () => compositorSchema))
      .toEqual({ complete: true, digests: [asset('a').digest] })
    const roots = workflowAssetRoots(workflow.doc, workflow.historySnapshot(), () => compositorSchema)
    expect(roots.complete).toBe(false)
    expect(roots.digests).toEqual([asset('a').digest, asset('c').digest])
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

  it.each(['known', 'ambiguous', 'typed', 'foreign-typed', 'invalid-choice', 'unknown-state'] as const)(
    'retains dormant slot dependents without guessing branch types: %s', (scenario) => {
      const candidate: NodeSchema = { ...schema, items: [{ kind: 'input', id: 'source', optional: false,
        type: { kind: 'concrete', name: 'STRING' }, dynamic: {
          kind: 'dynamicSlot', materialization: 'wire15', slotType: { kind: 'concrete', name: 'STRING' }, inputs: [],
          variants: [
            { key: 'text', type: { kind: 'concrete', name: 'STRING' }, inputs: [assetInput('shared', 'a')] },
            { key: 'integer', type: { kind: 'concrete', name: 'INT' }, inputs: [
              { ...assetInput('shared', 'b'), type: scenario === 'known' ? assetType : { kind: 'concrete', name: 'STRING' } },
              assetInput('dormant', 'e'),
            ] },
          ],
        },
      }] }
      const local = session()
      const value = scenario === 'typed' ? { $typed: { type: 'asset<DATA>', value: asset('c') } }
        : scenario === 'foreign-typed' ? { $typed: { type: 'INT', value: 5 } } : asset('c')
      const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
        n0: { id: asNodeId('n0'), type: 'Loader', values: { source: 'selected', 'source.shared': value, 'source.dormant': asset('d') },
          dynamic: { source: { selected: scenario === 'invalid-choice' ? 'gone' : 'text' },
            ...(scenario === 'unknown-state' ? { 'source.unknown': { selected: 'text' } } : {}) } },
      } } } }
      const roots = workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, () => candidate)
      expect(roots.complete).toBe(scenario === 'known' || scenario === 'typed')
      expect(roots.digests).toEqual((scenario === 'foreign-typed' ? ['d'] : ['c', 'd']).map((letter) => asset(letter).digest))
      expect(roots.refusal).toBe(scenario === 'invalid-choice' || scenario === 'unknown-state' ? 'Workflow dynamic identities are invalid' : undefined)
      if (scenario === 'ambiguous') expect(roots.incompleteDiagnostics).toContainEqual(expect.objectContaining({ code: 'workflow.asset.ambiguousInput' }))
      if (scenario === 'foreign-typed') expect(roots.incompleteDiagnostics).toContainEqual(expect.objectContaining({ code: 'workflow.asset.unresolvedInput' }))
    },
  )

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

  it('retains inactive branch, disconnected slot and family values but only effective defaults', () => {
    const local = session()
    const document: WorkflowDocument = { ...local.doc, graphs: { g0: { ...local.doc.graphs.g0!, nodes: {
      n0: { id: asNodeId('n0'), type: 'Loader', dynamic: { mode: { selected: 'a' }, items: { members: ['m0'] } },
        values: { 'mode.[b].file': asset('e'), 'slot.file': asset('f'), 'items.file#m0': asset('c') } },
    } } } }
    expect(workflowAssetRoots(document, local.historySnapshot(), () => dynamicSchema))
      .toEqual({ complete: true, digests: ['a', 'c', 'e', 'f'].map((letter) => asset(letter).digest) })
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
