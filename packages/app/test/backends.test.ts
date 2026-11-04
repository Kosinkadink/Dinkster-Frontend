/**
 * Multi-backend tests: several ComfyUI servers behind ONE shared
 * ExecutionStore. Each backend owns its connection, schema registry, and
 * scoped client; a live tab targets one backend (view state), a frozen tab
 * follows its execution's connection. Nothing here is serialized.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asConnectionId,
  asPromptId,
  executionKey,
  setLocale,
  type DinksterNodesPayload,
  type ExecutionRef,
  type NodeSchema,
} from '@dinkster/core'
import {
  buildDinksterRegistry,
  DinksterConnection,
  EngineNotReadyError,
  reconcileDinksterExecutions,
  type SchemaRegistry,
  type WorkerInfo,
} from '@dinkster/client'
import { buildScene, defaultTokens } from '@dinkster/canvas'
import { AppState, type Backend, type Tab } from '../src/app-state.js'
import { historicalSchemas } from './historical-schemas.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { reconcileWorkflowRetentions } from '../src/workflow-asset-retention.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(readFileSync(join(root, 'fixtures/dinkster-nodes-comfy.json'), 'utf8')) as DinksterNodesPayload

let app: AppState
let basic: Tab

/** Add a backend without connecting; drive its registry directly. */
const addOffline = (url: string, label?: string): Backend => {
  const backend = app.addBackend(url, label, false)
  if (!backend) throw new Error('addBackend rejected')
  vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
    ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
  return backend
}

const registryFor = (backend: Backend): void => {
  backend.registry.set({
    connection: backend.id,
    hash: 'historical-routing-schemas',
    schemas: historicalSchemas,
    diagnostics: [],
    resolve: (type) => historicalSchemas.get(type),
  })
}

const choiceSchema = (options: readonly string[]): NodeSchema => ({
  type: 'Choice',
  displayName: 'Choice',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [{
    kind: 'input',
    id: 'choice',
    type: { kind: 'concrete', name: 'STRING' },
    optional: false,
    widget: { widgetType: 'COMBO', options: { options } },
  }],
})

const choiceRegistry = (backend: Backend, options: readonly string[]): SchemaRegistry => {
  const schema = choiceSchema(options)
  return {
    connection: backend.id,
    hash: options.join(','),
    schemas: new Map([[schema.type, schema]]),
    diagnostics: [],
    resolve: (type) => type === schema.type ? schema : undefined,
  }
}

/** Register a completed-shape execution on a connection (no artifact). */
const foreignRun = (connection: string, prompt: string): ExecutionRef => {
  const ref: ExecutionRef = { connection: asConnectionId(connection), prompt: asPromptId(prompt) }
  app.store.apply({ kind: 'started', execution: ref, timestamp: 0 })
  return ref
}

beforeEach(() => {
  app = createWorkflowApp(null)
  for (const name of ['basic', 'subgraph']) {
    app.openDocument(JSON.parse(readFileSync(join(root, `fixtures/workflows/seed-${name}.json`), 'utf8')), name)
  }
  basic = app.tabs.get().find((tab) => tab.id === 'lineage-seed-basic')!
})

// The FR8 tests spy on global fetch and superviseBackend; restore even when
// an assertion fails mid-test so a leaked spy cannot poison later tests.
afterEach(() => {
  app.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('default backend', () => {
  it('is backends[0] and backs the single-backend aliases', () => {
    const def = app.backends.get()[0]!
    expect(app.connection).toBe(def.connection)
    expect(app.registry).toBe(def.registry)
    expect(app.scopedClient).toBe(def.scopedClient)
  })

  it('is not removable', () => {
    const def = app.backends.get()[0]!
    app.removeBackend(def.id)
    expect(app.backends.get()[0]).toBe(def)
  })

  it('resolves every tab that has no explicit target', () => {
    expect(app.backendForTab(basic)).toBe(app.backends.get()[0])
  })
})

// Scope preview and execution share one CompileInput builder so their
// capability-dependent closure decisions cannot diverge.
describe('compileInputForTab capabilities', () => {
  /** The fixture payload with the typedLiteral capability stamped on. */
  const withTypedLiteral = (payload: DinksterNodesPayload): DinksterNodesPayload => ({
    ...payload,
    dinkster: { ...(payload.dinkster as Record<string, unknown>), graphFeatures: ['typedLiteral'] },
  })

  it('threads the target registry graphFeatures into the shared compile input', () => {
    const def = app.backends.get()[0]!
    def.registry.set(buildDinksterRegistry(def.id, withTypedLiteral(nodesPayload)))
    const input = app.compileInputForTab(basic, { kind: 'full' })
    expect(input?.graphFeatures).toEqual(['typedLiteral'])
    expect(input?.connection).toBe(def.id)
    expect(input?.schemaHash).toBe(def.registry.get()!.hash)
  })

  it('omits graphFeatures when the target backend does not advertise any', () => {
    const def = app.backends.get()[0]!
    def.registry.set(buildDinksterRegistry(def.id, nodesPayload))
    const input = app.compileInputForTab(basic, { kind: 'full' })
    expect(input).toBeDefined()
    expect(input && 'graphFeatures' in input).toBe(false)
  })

  it('uses the tab TARGET backend\'s capabilities, not the default backend\'s', () => {
    const def = app.backends.get()[0]!
    def.registry.set(buildDinksterRegistry(def.id, nodesPayload)) // default: no features
    const other = addOffline('http://other:8188', 'Other')
    other.registry.set(buildDinksterRegistry(other.id, withTypedLiteral(nodesPayload)))
    app.setTabTarget(basic.id, other.id)
    const input = app.compileInputForTab(basic, { kind: 'full' })
    expect(input?.connection).toBe(other.id)
    expect(input?.graphFeatures).toEqual(['typedLiteral'])
  })
})

describe('addBackend / removeBackend', () => {
  it('creates an independent connection, registry, and scoped client', () => {
    const def = app.backends.get()[0]!
    const b = addOffline('http://other:8188', 'Other')
    expect(b.id).not.toBe(def.id)
    expect(b.connection).not.toBe(def.connection)
    expect(b.registry).not.toBe(def.registry)
    expect(b.scopedClient).not.toBe(def.scopedClient)
    expect(app.backends.get()).toHaveLength(2)
  })

  it('uses a distinct execution client id for each backend connection', () => {
    const def = app.backends.get()[0]!
    const b = addOffline('/b2', 'Alias')
    const clientId = (backend: Backend): string =>
      (backend.connection as unknown as { clientId: string }).clientId
    expect(clientId(b)).not.toBe(clientId(def))
  })

  it('rejects a duplicate url with a diagnostic instead of a second entry', () => {
    addOffline('http://other:8188')
    expect(app.addBackend('http://other:8188/', undefined, false)).toBeUndefined()
    expect(app.backends.get()).toHaveLength(2)
    expect(app.problems.get().some((d) => d.code === 'backend.duplicate')).toBe(true)
  })

  it('remove drops the entry and any tab targets pointing at it', () => {
    const b = addOffline('http://other:8188')
    app.setTabTarget(basic.id, b.id)
    app.removeBackend(b.id)
    expect(app.backends.get()).toHaveLength(1)
    expect(app.tabTargets.get().size).toBe(0)
    expect(app.backendForTab(basic)).toBe(app.backends.get()[0]) // back on default
  })

  it('re-adding the same url after removal yields a fresh live entry', () => {
    const b = addOffline('http://other:8188')
    app.removeBackend(b.id)
    const revived = addOffline('http://other:8188')
    expect(revived.id).toBe(b.id)
    expect(revived).not.toBe(b)
    expect(app.backendFor(revived.id)).toBe(revived)
  })

  it('FR8 removed backend restart cannot replace a re-added backend supervisor poll', async () => {
    let resolveRestart!: (response: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveRestart = resolve }),
    )
    const retired = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (!retired) throw new Error('addBackend rejected')
    const supervise = vi.spyOn(app as unknown as { superviseBackend(backend: Backend): void }, 'superviseBackend')
    const restart = app.restartEngine(retired)
    app.removeBackend(retired.id)
    const replacement = app.addBackend('http://native:8000', 'Replacement', false, 'dinkster')
    if (!replacement) throw new Error('re-add rejected')
    resolveRestart(new Response(null, { status: 200 }))
    await restart
    expect(app.backendFor(replacement.id)).toBe(replacement)
    expect(supervise).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('FR8 a failed restart on a removed backend reports nothing against the replacement', async () => {
    let resolveRestart!: (response: Response) => void
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
      () => new Promise<Response>((resolve) => { resolveRestart = resolve }),
    )
    const retired = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (!retired) throw new Error('addBackend rejected')
    const supervise = vi.spyOn(app as unknown as { superviseBackend(backend: Backend): void }, 'superviseBackend')
    const restart = app.restartEngine(retired)
    app.removeBackend(retired.id)
    const replacement = app.addBackend('http://native:8000', 'Replacement', false, 'dinkster')
    if (!replacement) throw new Error('re-add rejected')
    const problemsBefore = app.problems.get().length
    const logsBefore = app.logs.get().length
    resolveRestart(new Response(null, { status: 500 }))
    await restart
    expect(supervise).not.toHaveBeenCalled()
    expect(app.problems.get()).toHaveLength(problemsBefore)
    // "Reports nothing" includes the activity log: no failure line may be
    // emitted under the replacement's label (or at all) for the stale restart.
    expect(app.logs.get().slice(logsBefore).some((entry) => entry.message.includes('engine restart failed'))).toBe(false)
    fetchSpy.mockRestore()
  })

  it('keeps the newest schema request when an older request finishes last', async () => {
    const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')
    let resolveFirst!: (value: ReturnType<typeof buildDinksterRegistry>) => void
    let resolveSecond!: (value: ReturnType<typeof buildDinksterRegistry>) => void
    vi.spyOn(backend.connection, 'fetchSchemas')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSecond = resolve }))

    const first = app.refreshBackendSchemas(backend)
    const second = app.refreshBackendSchemas(backend)
    const newest = buildDinksterRegistry(backend.id, nodesPayload)
    resolveSecond(newest)
    await second
    resolveFirst(buildDinksterRegistry(backend.id, nodesPayload))
    await first

    expect(backend.registry.get()).toBe(newest)
    expect(backend.schemaState.get()).toEqual({ status: 'ready' })
  })

  // ComfyUI_frontend 2dde8ae00c36b43e0ec84bc6f3a60caad5119303:
  // app.ts reloadNodeDefs replaces widget.options.values, not widget.value.
  it.each([
    ['replacement', ['new-option-a', 'new-option-b']],
    ['empty', []],
  ] as const)('refreshes %s choice options in root and subgraph scenes without rewriting stored choices', async (_label, refreshedOptions) => {
    const backend = app.backends.get()[0]!
    const oldOptions = ['old-option']
    backend.registry.set(choiceRegistry(backend, oldOptions))
    expect(app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'choice-refresh',
      root: 'root',
      graphs: {
        root: {
          id: 'root',
          name: 'Root',
          nodes: {
            rootChoice: { id: 'rootChoice', type: 'Choice', values: { choice: 'retained-root' } },
            subgraph: { id: 'subgraph', type: '#body', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 2,
        },
        body: {
          id: 'body',
          name: 'Body',
          nodes: {
            nestedChoice: { id: 'nestedChoice', type: 'Choice', values: { choice: 'retained-nested' } },
          },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {},
          boundary: { inputs: [], outputs: [] },
          nextOrdinal: 1,
        },
      },
      view: { graphs: { root: { nodes: {} }, body: { nodes: {} } } },
    }, 'Choice refresh')).toEqual([])
    const tab = app.activeTab()!
    const storedBefore = JSON.stringify(tab.store.doc)
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(choiceRegistry(backend, refreshedOptions))

    await app.refreshBackendSchemas(backend)

    const root = buildScene({
      document: tab.store.doc,
      graphId: 'root',
      resolve: app.registryForTab(tab)!.resolve,
      tokens: defaultTokens,
      measure: (text) => text.length * 7,
      widgetMeasure: () => ({ viewId: 'core.select', rows: 1 }),
    })
    const nested = buildScene({
      document: tab.store.doc,
      graphId: 'body',
      resolve: app.registryForTab(tab)!.resolve,
      tokens: defaultTokens,
      measure: (text) => text.length * 7,
      widgetMeasure: () => ({ viewId: 'core.select', rows: 1 }),
    })

    expect(root.nodes.find((node) => node.id === 'rootChoice')?.layout.rows
      .find((row) => row.kind === 'widget')?.spec.options['options']).toEqual(refreshedOptions)
    expect(nested.nodes.find((node) => node.id === 'nestedChoice')?.layout.rows
      .find((row) => row.kind === 'widget')?.spec.options['options']).toEqual(refreshedOptions)
    expect(tab.store.doc.graphs.root!.nodes.rootChoice!.values.choice).toBe('retained-root')
    expect(tab.store.doc.graphs.body!.nodes.nestedChoice!.values.choice).toBe('retained-nested')
    expect(JSON.stringify(tab.store.doc)).toBe(storedBefore)
  })

  it('publishes pack locale overlays live without refetching the schema catalog', async () => {
    const digest = (character: string): string => `sha256:${character.repeat(64)}`
    const requests: string[] = []
    let releaseGerman!: () => void
    let germanReturned = false
    const germanResponse = new Promise<void>((resolve) => { releaseGerman = resolve })
    const localeCatalogs: Record<string, unknown> = {
      [digest('a')]: { nodes: { 'demo.localized': { displayName: 'English pack node' } } },
      [digest('b')]: { nodes: { 'demo.localized': { displayName: 'Deutscher Packknoten' } } },
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/api/nodes')) return new Response(JSON.stringify({
        schemaVersion: 1,
        dinkster: { version: 'locale-test', schemaWire: 1 },
        packs: { demo: { displayName: 'Demo', locales: { en: digest('a'), de: digest('b') } } },
        nodes: {
          'demo.localized': {
            schemaVersion: 1,
            displayName: 'RAW pack node',
            pack: 'demo',
            interface: [],
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      const localeDigest = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
      if (url.includes('/locales/')) {
        if (localeDigest === digest('b')) {
          await germanResponse
          germanReturned = true
        }
        return new Response(JSON.stringify(localeCatalogs[localeDigest]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    setLocale('en')
    const nativeApp = new AppState()
    const backend = nativeApp.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')

    await nativeApp.refreshBackendSchemas(backend)
    await vi.waitFor(() => expect(backend.registry.get()?.resolve('demo.localized')?.displayName)
      .toBe('English pack node'))
    setLocale('de-DE')
    await vi.waitFor(() => expect(requests.some((url) => url.endsWith(encodeURIComponent(digest('b'))))).toBe(true))
    setLocale('fr-FR')
    await vi.waitFor(() => expect(backend.registry.get()?.resolve('demo.localized')?.displayName)
      .toBe('English pack node'))
    releaseGerman()
    await vi.waitFor(() => expect(germanReturned).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(backend.registry.get()?.resolve('demo.localized')?.displayName).toBe('English pack node')
    setLocale('de-DE')
    await vi.waitFor(() => expect(backend.registry.get()?.resolve('demo.localized')?.displayName)
      .toBe('Deutscher Packknoten'))

    expect(requests.filter((url) => url.includes('/api/nodes'))).toHaveLength(1)
    expect(requests.filter((url) => url.includes('/locales/'))).toHaveLength(2)
    expect(backend.registry.get()?.hash).toBe(backend.connection.currentRegistry?.hash)
    setLocale('en')
    nativeApp.dispose()
  })

  it('preserves the registry when locale changes have no pack catalogs', async () => {
    const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')
    const registry = buildDinksterRegistry(backend.id, nodesPayload)
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(registry)

    await app.refreshBackendSchemas(backend)
    await new Promise((resolve) => setTimeout(resolve, 0))
    const invalidateRemoteChoices = vi.spyOn(backend, 'invalidateRemoteChoices')
    setLocale('de-DE')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(backend.registry.get()).toBe(registry)
    expect(invalidateRemoteChoices).not.toHaveBeenCalled()
    setLocale('en')
  })

  it('loads workers only for placement-capable schemas and rejects stale catalog responses', async () => {
    const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')
    const placementRegistry = buildDinksterRegistry(backend.id, {
      ...nodesPayload,
      dinkster: { ...(nodesPayload.dinkster as Record<string, unknown>), graphFeatures: ['placement'] },
    })
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(placementRegistry)
    let resolveFirst!: (workers: readonly WorkerInfo[]) => void
    vi.spyOn(backend.connection, 'fetchWorkers')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce([{
        name: 'new-worker',
        status: 'connected',
        routedNodeTypes: ['EmptyImage'],
        deviceQualifiers: [],
      }])

    await app.refreshBackendSchemas(backend)
    expect(backend.workerCatalog.get()).toEqual({ status: 'loading' })
    await app.refreshBackendSchemas(backend)
    await vi.waitFor(() => expect(backend.workerCatalog.get()).toEqual({
      status: 'ready',
      workers: [{
        name: 'new-worker',
        status: 'connected',
        routedNodeTypes: ['EmptyImage'],
        deviceQualifiers: [],
      }],
    }))

    resolveFirst([{
      name: 'stale-worker',
      status: 'connected',
      routedNodeTypes: ['PreviewImage'],
      deviceQualifiers: [],
    }])
    await Promise.resolve()
    expect(backend.workerCatalog.get()).toMatchObject({
      status: 'ready',
      workers: [{ name: 'new-worker' }],
    })

    vi.mocked(backend.connection.fetchSchemas).mockResolvedValue(buildDinksterRegistry(backend.id, nodesPayload))
    await app.refreshBackendSchemas(backend)
    expect(backend.workerCatalog.get()).toEqual({ status: 'unsupported' })
    expect(backend.connection.fetchWorkers).toHaveBeenCalledTimes(2)
  })

  it('reports schemas as waiting when the engine gate refuses the request', async () => {
    const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')
    vi.spyOn(backend.connection, 'fetchSchemas').mockRejectedValue(new EngineNotReadyError('starting'))

    await app.refreshBackendSchemas(backend)

    expect(backend.schemaState.get()).toEqual({ status: 'waiting' })
  })

  it('refuses a removed backend schema result after the address is re-added', async () => {
    const retired = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (retired?.protocol !== 'dinkster') throw new Error('native backend rejected')
    let rejectRequest!: (reason: Error) => void
    vi.spyOn(retired.connection, 'fetchSchemas').mockImplementation(() => new Promise((_resolve, reject) => { rejectRequest = reject }))
    const request = app.refreshBackendSchemas(retired)
    app.removeBackend(retired.id)
    const replacement = app.addBackend('http://native:8000', 'Replacement', false, 'dinkster')!
    const problemsBefore = app.problems.get().length
    rejectRequest(new Error('retired request failed'))
    await request

    expect(app.backendFor(replacement.id)).toBe(replacement)
    expect(replacement.schemaState.get()).toEqual({ status: 'idle' })
    expect(app.problems.get()).toHaveLength(problemsBefore)
  })
})

describe('backend protocols', () => {
  it('default backend and protocol-less addBackend speak native Dinkster', () => {
    expect(app.backends.get()[0]!.protocol).toBe('dinkster')
    expect(app.connection).toBeInstanceOf(DinksterConnection)
    const b = addOffline('http://other:8188')
    expect(b.protocol).toBe('dinkster')
    expect(b.connection).toBeInstanceOf(DinksterConnection)
  })

  it("addBackend with protocol 'dinkster' builds a native connection", () => {
    const b = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (!b) throw new Error('addBackend rejected')
    expect(b.protocol).toBe('dinkster')
    expect(b.connection).toBeInstanceOf(DinksterConnection)
    // Independent registry/scoped client, same as v1 backends.
    expect(b.registry).not.toBe(app.registry)
    expect(app.backends.get()).toHaveLength(2)
  })

  it.each(['live', 'removed', 'replaced', 'disconnected', 'disposed'] as const)(
    'accepts delayed cached outputs only from the unchanged live owner: %s', async (scenario) => {
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('cached-job') }
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
        ({ ...owner, ...declaration, revision: 1 }))
      const outputs = { image: { result: { typeId: 'asset<media/image>',
        meta: { digest: `blake3:${'e'.repeat(64)}`, mediaType: 'image/png' } } } }
      let finish!: (value: typeof outputs) => void
      vi.spyOn(backend.connection, 'fetchJobOutputs').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
      app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
      app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
      expect(app.store.get(ref)?.outputs).toEqual({})
      if (scenario === 'removed' || scenario === 'replaced') app.removeBackend(backend.id)
      if (scenario === 'replaced') app.addBackend('http://native:8000', 'Replacement', false, 'dinkster')
      if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
      if (scenario === 'disposed') app.dispose()
      finish(outputs)
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(app.store.get(ref)?.outputs).toEqual(scenario === 'live' ? outputs : {})
      if (scenario === 'live') {
        app.removeBackend(backend.id)
        expect(app.store.get(ref)?.outputs).toEqual(outputs)
      } else if (scenario !== 'disposed') {
        const live = app.backendFor(backend.id) ?? app.addBackend('http://native:8000', 'Replacement', false, 'dinkster')!
        const fresh = { image: { result: { typeId: 'INT', value: 37 } } }
        vi.spyOn(live.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
          ({ ...owner, ...declaration, revision: 1 }))
        vi.spyOn(live.connection, 'fetchJobOutputs').mockResolvedValue(fresh)
        app.store.apply({ kind: 'started', execution: { ...ref, prompt: asPromptId('next-job') }, timestamp: 3 })
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(app.store.get(ref)?.outputs).toEqual(fresh)
      }
    },
  )

  it.each(['accepted', 'refused', 'removed', 'disconnected', 'disposed'] as const)(
    'journals and confirms cached result ownership before publication: %s', async (scenario) => {
      const backend = app.backends.get()[0]!
      const ownerBackend = scenario === 'removed' ? addOffline('http://native:8000', 'Native') : backend
      const ref: ExecutionRef = { connection: ownerBackend.id, prompt: asPromptId('held-cache') }
      const digest = (letter: string) => `blake3:${letter.repeat(64)}`
      const outputs = { image: { result: { typeId: 'list<ASSET>', elementsTruncated: true,
        elements: [{ typeId: 'ASSET', meta: { digest: digest('e') } },
          { typeId: 'ASSET', meta: { digest: digest('f') } }] } } }
      vi.spyOn(ownerBackend.connection, 'fetchJobOutputs').mockResolvedValue(outputs)
      let acknowledge!: () => void
      let requested!: () => void
      const request = new Promise<void>((resolve) => { requested = resolve })
      let journalKey = ''
      let acknowledgment: Awaited<ReturnType<typeof ownerBackend.connection.retainAssets>>
      vi.spyOn(ownerBackend.connection, 'retainAssets').mockImplementation((owner, declaration) => {
        journalKey = `dinkster.workflow-retentions.${owner.ownerId}`
        acknowledgment = { ...owner, ...declaration, revision: 1 }
        requested()
        return new Promise((resolve, reject) => {
          acknowledge = () => scenario === 'refused' ? reject(new Error('retention refused')) : resolve(acknowledgment)
        })
      })
      vi.spyOn(ownerBackend.connection, 'fetchRetainedAssets').mockImplementation(async () =>
        scenario === 'refused' ? undefined : acknowledgment)
      app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
      app.store.hydrateArtifacts(ref, [{ nodeId: 'image', digest: digest('a'), name: 'result.bin', size: 7,
        mediaType: 'application/octet-stream', virtualPath: '', preview: { digest: digest('c'), name: 'preview.png',
          size: 3, mediaType: 'image/png', virtualPath: '' } }])
      app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
      await request
      expect(JSON.parse(localStorage.getItem(journalKey)!)).toMatchObject({
        owner: { ownerKind: 'shown-result' }, executionKey: executionKey(ref),
        digests: [digest('a'), digest('c'), digest('e'), digest('f')], complete: false,
      })
      expect(acknowledgment!).toMatchObject({ ownerKind: 'shown-result', revision: 1, complete: false,
        digests: [digest('a'), digest('c'), digest('e'), digest('f')] })
      expect(app.store.get(ref)?.outputs).toEqual({})
      if (scenario === 'removed') app.removeBackend(ownerBackend.id)
      if (scenario === 'disconnected') { ownerBackend.connection.connect(); ownerBackend.connection.disconnect() }
      if (scenario === 'disposed') app.dispose()
      acknowledge()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(app.store.get(ref)?.outputs).toEqual(scenario === 'accepted' ? outputs : {})
      expect(localStorage.getItem(journalKey)).not.toBeNull()
      if (scenario === 'accepted') {
        vi.spyOn(ownerBackend.connection, 'clearHistory').mockResolvedValue(1)
        expect(await app.clearRunHistory(ownerBackend.id)).toBe(1)
        expect(app.store.get(ref)?.outputs).toEqual(outputs)
        expect(await reconcileWorkflowRetentions(ownerBackend.connection, new AbortController().signal)).toBe(true)
        expect(localStorage.getItem(journalKey)).not.toBeNull()
      }
    },
  )

  it.each(['accepted', 'refused', 'removed', 'disconnected', 'registry-changed', 'disposed'] as const)(
    'admits fetched completion outputs and artifacts before publication: %s', async (scenario) => {
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('owned-completion') }
      const digest = (letter: string) => `blake3:${letter.repeat(64)}`
      const live = { live: { value: { typeId: 'INT', value: 17 } } }
      const outputs = { save: { image: { typeId: 'IMAGE', meta: { digest: digest('e') } } } }
      const artifact = { nodeId: 'save', digest: digest('a'), name: 'result.png', size: 7,
        mediaType: 'image/png', virtualPath: '', preview: { digest: digest('c'), name: 'preview.png',
          size: 3, mediaType: 'image/png', virtualPath: '' } }
      app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
      app.store.hydrateOutputs(ref, live)
      vi.spyOn(backend.connection, 'fetchJob').mockResolvedValue({ state: 'completed', outputs, artifacts: [artifact] })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      let requested = 0
      let acknowledge!: () => void
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation((owner, declaration) => {
        requested += 1
        expect(declaration.digests).toEqual([digest('a'), digest('c'), digest('e')])
        return new Promise((resolve, reject) => {
          acknowledge = () => scenario === 'refused' ? reject(new Error('ownership refused'))
            : resolve({ ...owner, ...declaration, revision: 1 })
        })
      })
      backend.connection.ingest({ type: 'job_state', jobId: ref.prompt, state: 'completed' })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(requested).toBe(1)
      expect(app.store.get(ref)).toMatchObject({ outputs: live, artifacts: [], artifactsHydrated: false })
      if (scenario === 'removed') app.removeBackend(backend.id)
      if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
      if (scenario === 'registry-changed') registryFor(backend)
      if (scenario === 'disposed') app.dispose()
      acknowledge()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(app.store.get(ref)).toMatchObject(scenario === 'accepted'
        ? { outputs: { ...live, ...outputs }, artifacts: [artifact], artifactsHydrated: true }
        : { outputs: live, artifacts: [], artifactsHydrated: false })
    },
  )

  it.each(['accepted', 'refused', 'removed', 'disconnected', 'registry-changed', 'disposed'] as const)(
    'admits live preview identities before ordered publication: %s', async (scenario) => {
      const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')!
      const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('owned-preview') }
      const digest = (letter: string) => `blake3:${letter.repeat(64)}`
      backend.connection.ingest({ type: 'run_started', jobId: ref.prompt })
      app.store.hydrateArtifacts(ref, [{ nodeId: 'held', digest: digest('a'), name: 'held.png', size: 7,
        mediaType: 'image/png', virtualPath: '' }])
      let acknowledge!: () => void
      let requested = 0
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation((owner, declaration) => {
        requested += 1
        expect(declaration).toMatchObject({ complete: false, digests: [digest('a'), digest('c'), digest('e')] })
        return new Promise((resolve, reject) => {
          acknowledge = () => scenario === 'refused' ? reject(new Error('ownership refused'))
            : resolve({ ...owner, ...declaration, revision: 1 })
        })
      })
      backend.connection.ingest({ type: 'node_event', event: 'preview', jobId: ref.prompt, nodeId: 'image',
        data: { mime: 'application/json', documentDigest: digest('c'), document: {
          layers: { image: { source: { digest: digest('e') } } } } } })
      backend.connection.ingest({ type: 'run_finished', jobId: ref.prompt })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(requested).toBe(1)
      expect(app.store.get(ref)?.previews).toEqual({})
      expect(app.store.get(ref)?.status).toBe('running')
      if (scenario === 'removed') app.removeBackend(backend.id)
      if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
      if (scenario === 'registry-changed') registryFor(backend)
      if (scenario === 'disposed') app.dispose()
      acknowledge()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(app.store.get(ref)?.previews.image?.['']?.payload).toEqual(scenario === 'accepted'
        ? { mime: 'application/json', documentDigest: digest('c'), document: {
          layers: { image: { source: { digest: digest('e') } } } } } : undefined)
      expect(app.store.get(ref)?.status).toBe(scenario === 'accepted' || scenario === 'refused' ? 'completed' : 'running')
    },
  )

  it('hydrates saved artifacts after a normal live Dinkster completion', async () => {
    const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')
    vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
      ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
    const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('saved-job') }
    const outputs = { save: { video: { typeId: 'VIDEO', fingerprint: 'live-output' } } }
    app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
    app.store.hydrateOutputs(ref, outputs)
    const artifact = {
      nodeId: 'save',
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'result.mp4',
      size: 4043,
      mediaType: 'video/mp4',
      virtualPath: 'output/result.mp4',
    }
    const fetchJob = vi.spyOn(backend.connection, 'fetchJob').mockResolvedValue({
      state: 'completed',
      artifacts: [artifact],
    })

    backend.connection.ingest({ type: 'run_finished', jobId: 'saved-job' })
    expect(app.store.get(ref)?.status).toBe('completed')
    expect(app.store.get(ref)?.artifactsHydrated).toBe(false)
    expect(fetchJob).not.toHaveBeenCalled()
    backend.connection.ingest({ type: 'job_state', jobId: 'saved-job', state: 'completed' })
    await vi.waitFor(() => expect(app.store.get(ref)?.artifacts).toEqual([artifact]))
    expect(app.store.get(ref)?.artifactsHydrated).toBe(true)
    expect(app.store.get(ref)?.status).toBe('completed')
    expect(app.store.get(ref)?.outputs).toEqual(outputs)
    expect(fetchJob).toHaveBeenCalledOnce()
    expect(fetchJob).toHaveBeenCalledWith('saved-job')
  })

  it('retries a failed live completion artifact read on reconnect', async () => {
    const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')
    const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('retry-job') }
    const artifact = {
      nodeId: 'save',
      digest: `blake3:${'b'.repeat(64)}`,
      name: 'retry.mp4',
      size: 4043,
      mediaType: 'video/mp4',
      virtualPath: 'output/retry.mp4',
    }
    const fetchJob = vi.spyOn(backend.connection, 'fetchJob')
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ state: 'completed', artifacts: [artifact] })

    app.store.apply({ kind: 'started', execution: ref, timestamp: 1 })
    app.store.hydrateOutputs(ref, { save: { video: { typeId: 'VIDEO', fingerprint: 'live-output' } } })
    backend.connection.ingest({ type: 'run_finished', jobId: 'retry-job' })
    backend.connection.ingest({ type: 'job_state', jobId: 'retry-job', state: 'completed' })
    await vi.waitFor(() => expect(fetchJob).toHaveBeenCalledOnce())
    expect(app.store.get(ref)).toMatchObject({ status: 'completed', artifactsHydrated: false })

    await reconcileDinksterExecutions(backend.connection, app.store)

    expect(fetchJob).toHaveBeenCalledTimes(2)
    expect(app.store.get(ref)).toMatchObject({
      status: 'completed',
      artifacts: [artifact],
      artifactsHydrated: true,
    })
  })

  it('a native backend resolves tabs and routes asset URLs', () => {
    const b = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (!b) throw new Error('addBackend rejected')
    app.setTabTarget(basic.id, b.id)
    expect(app.backendForTab(basic)).toBe(b)
    const ref: ExecutionRef = { connection: b.id, prompt: asPromptId('j1') }
    expect(app.assetUrlForExecution(ref, 'blake3:00')).toBe(
      'http://native:8000/api/assets/blake3%3A00',
    )
  })

})

describe('per-tab backend targeting (view state)', () => {
  it('setTabTarget switches the tab; other tabs stay on default', () => {
    const other = app.tabs.get().find((tab) => tab.id !== basic.id)!
    const b = addOffline('http://other:8188')
    app.setTabTarget(basic.id, b.id)
    expect(app.backendForTab(basic)).toBe(b)
    expect(app.backendForTab(other)).toBe(app.backends.get()[0])
  })

  it('rejects unknown backends and frozen tabs', async () => {
    const b = addOffline('http://other:8188')
    registryFor(b)
    app.setTabTarget(basic.id, asConnectionId('nope'))
    expect(app.tabTargets.get().size).toBe(0)

    const ref = foreignRun(String(b.id), 'p-frozen')
    app.setTabTarget(basic.id, b.id) // only b has a registry in this test
    const result = app.compileTab(basic)
    if (!result?.ok) throw new Error('compile failed')
    app.store.register(ref, result.artifact, 1)
    expect(await app.openExecutionView(ref)).toBe(true)
    const frozen = app.tabs.get().find((t) => t.execution)!
    app.setTabTarget(frozen.id, app.backends.get()[0]!.id)
    expect(app.tabTargets.get().has(frozen.id)).toBe(false)
  })

  it('a frozen tab resolves its execution connection, not any target', async () => {
    const b = addOffline('http://other:8188')
    registryFor(b)
    app.setTabTarget(basic.id, b.id)
    const result = app.compileTab(basic) // compiles against b's registry/id
    if (!result?.ok) throw new Error('compile failed')
    const ref: ExecutionRef = { connection: b.id, prompt: asPromptId('p1') }
    app.store.register(ref, result.artifact, 1)
    expect(await app.openExecutionView(ref)).toBe(true)
    const frozen = app.tabs.get().find((t) => t.execution)!
    expect(app.backendForTab(frozen)).toBe(b)
  })

  it('replacing a tab document clears its target', () => {
    const b = addOffline('http://other:8188')
    app.setTabTarget(basic.id, b.id)
    const json = JSON.parse(
      readFileSync(join(root, 'fixtures/workflows/seed-basic.json'), 'utf8'),
    ) as unknown
    expect(app.openDocument(json, 'Basic')).toEqual([])
    const replaced = app.tabs.get().find((t) => t.id === basic.id)!
    expect(app.backendForTab(replaced)).toBe(app.backends.get()[0])
    expect(app.tabTargets.get().has(basic.id)).toBe(false)
  })
})

describe('compile and registry routing', () => {
  it('compileTab records the TARGET backend identity in the artifact', () => {
    const b = addOffline('http://other:8188')
    registryFor(b)
    app.setTabTarget(basic.id, b.id)
    const result = app.compileTab(basic)
    if (!result?.ok) throw new Error('compile failed')
    expect(result.artifact.connection).toBe(b.id)
  })

  it('registryForTab is the tab backend registry - never another backend', () => {
    const b = addOffline('http://other:8188')
    registryFor(b)
    expect(app.registryForTab(basic)).toBe(app.registry.get()) // default (unset)
    app.setTabTarget(basic.id, b.id)
    expect(app.registryForTab(basic)).toBe(b.registry.get())
  })

  it('frontend-only schemas layer over EVERY backend registry', () => {
    const b = addOffline('http://other:8188')
    registryFor(b)
    const extra: NodeSchema = {
      type: 'DinksterTestOnly',
      displayName: 'Test Only',
      category: 'test',
      source: 'v3',
      items: [],
      isOutputNode: false,
    }
    app.registerSchemas([extra])
    expect(b.registry.get()!.resolve('DinksterTestOnly')).toBe(extra)
    // Backend schemas still resolve underneath the layer.
    expect(b.registry.get()!.resolve('EmptyImage')).toBe(historicalSchemas.get('EmptyImage'))
  })
})

describe('execution output routing', () => {
  it.each((['live', 'removed', 'replaced', 'refused', 'disposed', 'aborted'] as const).flatMap((mode) =>
    [false, true].map((opaque) => ({ mode, opaque }))))(
    'admits newly read descriptor roots before publication through the $mode owner, opaque=$opaque', async ({ mode, opaque }) => {
      const backend = addOffline('http://value-owner:8188')
      const ref = foreignRun(String(backend.id), 'value-read')
      const digest = `blake3:${'c'.repeat(64)}`
      const descriptor = opaque
        ? { typeId: 'OPAQUE', fingerprint: 'opaque-result', meta: { handle: 'unrepresented dependency' } }
        : { typeId: 'asset<media/image>', fingerprint: 'new-result', meta: { digest } }
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ available: true, descriptor, renditions: [] }))
      let accept!: () => void
      const barrier = new Promise<void>((resolve) => { accept = resolve })
      const retain = vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
        await barrier
        if (mode === 'refused') throw new Error('retention refused')
        return { ...owner, ...declaration, revision: declaration.revision + 1 }
      })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      if (mode === 'removed') app.removeBackend(backend.id)
      const controller = new AbortController()
      let published = false
      const pending = app.valuesForExecution(ref)!.peek(
        { jobId: ref.prompt, nodeId: 'image', outputId: 'result' }, { signal: controller.signal },
      ).then((result) => { published = true; return result })
      await vi.waitFor(() => expect(retain).toHaveBeenCalledOnce())
      expect(published).toBe(false)
      expect(retain.mock.calls[0]![1]).toEqual({ revision: 0, complete: false, digests: opaque ? [] : [digest] })
      if (mode === 'replaced') {
        app.removeBackend(backend.id)
        addOffline('http://value-owner:8188')
      }
      if (mode === 'disposed') app.dispose()
      if (mode === 'aborted') controller.abort()
      accept()
      expect(await pending).toMatchObject(mode === 'live' || mode === 'removed'
        ? { available: true, descriptor } : { available: false })
      if (mode === 'refused') {
        retain.mockImplementation(async (owner, declaration) => ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
        expect(await app.valuesForExecution(ref)!.peek({ jobId: ref.prompt, nodeId: 'image', outputId: 'result' }))
          .toMatchObject({ available: true, descriptor })
      }
    },
  )

  it('assetUrlForExecution uses the execution backend, not the default', () => {
    const b = addOffline('http://other:8188')
    const digest = 'blake3:' + 'ab'.repeat(32)
    const onB: ExecutionRef = { connection: b.id, prompt: asPromptId('p1') }
    expect(app.assetUrlForExecution(onB, digest)).toBe(
      `http://other:8188/api/assets/${encodeURIComponent(digest)}`,
    )
    const onDefault: ExecutionRef = { connection: app.connection.id, prompt: asPromptId('p2') }
    expect(app.assetUrlForExecution(onDefault, digest)).not.toContain('http://other:8188')
  })

  it('historical asset routes and native value ownership survive backend removal', async () => {
    const requests: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requests.push(new URL(String(input)))
      return Response.json({ available: true, descriptor: { typeId: 'IMAGE', fingerprint: 'recorded-image' }, renditions: [] })
    })
    const b = addOffline('http://other:8188')
    const ref = foreignRun(String(b.id), 'p1')
    await app.valuesForExecution(ref)!.peek({ jobId: ref.prompt, nodeId: 'n0', outputId: 'IMAGE' })
    app.removeBackend(b.id)
    expect(app.assetUrlForExecution(ref, 'blake3:00')).toBe(
      'http://other:8188/api/assets/blake3%3A00',
    )
    expect(await app.valuesForExecution(ref)!.peek({ jobId: ref.prompt, nodeId: 'n1', outputId: 'images' })).toMatchObject({
      available: true, descriptor: { typeId: 'IMAGE', fingerprint: 'recorded-image' },
    })
    expect(requests.map((url) => url.origin)).toEqual(['http://other:8188', 'http://other:8188'])
    expect(requests.map((url) => url.searchParams.get('jobId'))).toEqual(['p1', 'p1'])
    expect(requests[1]!.searchParams.get('clientId')).toBe(requests[0]!.searchParams.get('clientId'))
    expect(requests[1]!.searchParams.get('nodeId')).toBe('n1')
    expect(app.valuesForExecution({ ...ref, connection: asConnectionId('unknown') })).toBeUndefined()
  })
})
