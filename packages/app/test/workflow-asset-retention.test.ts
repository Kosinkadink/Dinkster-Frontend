import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DINKSTER_SCHEMA_WIRE_VERSION, MASK_PAINT_SOURCE_EXT_KEY, asConnectionId, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asPromptId, asValueSourceId, coreCommandRegistry, createLocalSession,
  serializeSelection, type GraphDef, type NodeSchema, type WorkflowDocument,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import type { DinksterConnection, RetainedAssets, RetainedAssetOwner, RetainedAssetDeclaration } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { GLSL_EDITOR_KIND } from '../src/editors.js'
import { admitWorkflowDispatch, executionAssetRoots, reconcileWorkflowRetentions, workflowAssetRoots } from '../src/workflow-asset-retention.js'
import { initializeProjectScope, scopedStorageKey } from '../src/projects.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

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
      const app = new AppState()
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
  afterEach(() => {
    app?.dispose()
    app = undefined
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
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
      app = new AppState()
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      const registry = {
        connection: backend.id, diagnostics: [], hash: 'test',
        schemas: new Map([[schema.type, schema]]), resolve,
      }
      backend.registry.set(registry)
      expect(app.openDocument(session().doc, 'Retained workflow')).toEqual([])
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
        expect(app.openDocument(session([asset('c')]).doc, 'Replacement')).toEqual([])
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

  it.each(['dispatch', 'prepared'] as const)('refuses unadmitted local publication through %s', async (route) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    app.openDocument(session().doc, 'Existing')
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

  it.each(['valid', 'malformed'] as const)('keeps asset-neutral commands synchronous with %s existing identities', (scenario) => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    app = createWorkflowApp([schema])
    const document = session().doc
    const existing = scenario === 'valid' ? document : { ...document, graphs: {
      g0: { ...document.graphs.g0!, nodes: { n0: { ...document.graphs.g0!.nodes.n0!,
        values: { files: [{ digest: asset('a').digest, name: 'a.bin' }] },
      } } },
    } }
    app.openDocument(existing, 'Existing')
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
  it.each(['accepted', 'closed', 'registry', 'disconnected', 'refused'] as const)(
    'confirms a separate incomplete owner before a picker can publish: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      const app = createWorkflowApp([schema])
      try {
        app.openDocument(session().doc, 'Picker source')
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
        if (scenario === 'registry') backend.registry.set(undefined)
        if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
        response.resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
        expect(await settled).toBe(scenario === 'accepted')
        expect(tab.store.doc).toBe(before)
        expect(tab.store.canUndo).toBe(false)
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
        expect(app.openDocument(document, 'Copied source')).toEqual([])
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

  it.each(['accepted', 'refused', 'edited', 'closed', 'replacement', 'registry', 'target', 'canceled', 'disposed'] as const)(
    'keeps the existing tab until a current file-open acknowledgment: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([schema])
      app.openDocument(session().doc, 'Existing')
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
        return response.promise
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      let wanted = true
      const operation = app.importWorkflowFile({ name: 'incoming.json', text: async () => JSON.stringify(incoming) }, () => wanted)
      const declaration = await requested.promise
      expect(app.activeTab()).toBe(previous)
      expect(app.tabs.get()).toBe(previousTabs)
      expect(declaration).toEqual({ revision: 0, complete: true, digests: [asset('c').digest] })
      if (scenario === 'edited') expect((await app.dispatchTo(previous, replace('b'))).ok).toBe(true)
      if (scenario === 'closed') app.closeTab(previous.id)
      if (scenario === 'replacement') app.openDocument(session([asset('b')]).doc, 'Replacement')
      if (scenario === 'registry') app.registry.set(undefined)
      if (scenario === 'target') app.setTabTarget(previous.id, app.addBackend('http://other:8000', 'Other', false)!.id)
      if (scenario === 'canceled') wanted = false
      if (scenario === 'disposed') app.dispose()
      response.resolve({ ...owner, ...declaration, revision: scenario === 'refused' ? 2 : 1 })
      expect(await operation).toBe(scenario === 'accepted')
      expect(app.tabs.get().some((tab) => tab.id === 'incoming')).toBe(scenario === 'accepted')
      if (scenario !== 'closed' && scenario !== 'replacement') expect(app.tabs.get()).toContain(previous)
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

  it.each(['accepted', 'refused', 'edited', 'closed', 'disconnected', 'removed', 'disposed', 'unknown-schema', 'retired'] as const)(
    'stages a frozen snapshot without publishing early: %s', async (scenario) => {
      vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
      app = createWorkflowApp([{ ...schema, isOutputNode: true }])
      app.openDocument(session().doc, 'Live')
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
      .toEqual({ complete: widgetType === 'NUMBER', digests: [] })
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
        dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [{ key: 'a', inputs: [assetInput('file', 'a')] }] },
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
