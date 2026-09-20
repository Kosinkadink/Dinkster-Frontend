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
  setLocale,
  type DinksterNodesPayload,
  type ExecutionRef,
  type NodeSchema,
} from '@dinkster/core'
import {
  BackendConnection,
  buildDinksterRegistry,
  DinksterConnection,
  EngineNotReadyError,
  reconcileDinksterExecutions,
  type WorkerInfo,
} from '@dinkster/client'
import { AppState, type Backend, type Tab } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')
// The stock tabs are authored against native namespaced schemas.
const nodesPayload = JSON.parse(readFileSync(join(root, 'fixtures/dinkster-nodes-comfy.json'), 'utf8')) as DinksterNodesPayload

let app: AppState
let basic: Tab

/** Add a backend without connecting; drive its registry directly. */
const addOffline = (url: string, label?: string): Backend => {
  const backend = app.addBackend(url, label, false)
  if (!backend) throw new Error('addBackend rejected')
  return backend
}

const registryFor = (backend: Backend): void => {
  backend.registry.set(buildDinksterRegistry(backend.id, nodesPayload))
}

/** Register a completed-shape execution on a connection (no artifact). */
const foreignRun = (connection: string, prompt: string): ExecutionRef => {
  const ref: ExecutionRef = { connection: asConnectionId(connection), prompt: asPromptId(prompt) }
  app.store.apply({ kind: 'started', execution: ref, timestamp: 0 })
  return ref
}

beforeEach(() => {
  app = new AppState()
  basic = app.tabs.get()[0]!
})

// The FR8 tests spy on global fetch and superviseBackend; restore even when
// an assertion fails mid-test so a leaked spy cannot poison later tests.
afterEach(() => vi.restoreAllMocks())

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
  it('default backend and protocol-less addBackend speak v1', () => {
    expect(app.backends.get()[0]!.protocol).toBe('v1')
    const b = addOffline('http://other:8188')
    expect(b.protocol).toBe('v1')
    expect(b.connection).toBeInstanceOf(BackendConnection)
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

  it('hydrates saved artifacts after a normal live Dinkster completion', async () => {
    const backend = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (backend?.protocol !== 'dinkster') throw new Error('native backend rejected')
    const ref: ExecutionRef = { connection: backend.id, prompt: asPromptId('saved-job') }
    const outputs = { save: { video: { typeId: 'comfy.VIDEO', fingerprint: 'live-output' } } }
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
    app.store.hydrateOutputs(ref, { save: { video: { typeId: 'comfy.VIDEO', fingerprint: 'live-output' } } })
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

  it('a native backend resolves tabs and viewUrlForExecution stays total', () => {
    const b = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
    if (!b) throw new Error('addBackend rejected')
    app.setTabTarget(basic.id, b.id)
    expect(app.backendForTab(basic)).toBe(b)
    // /view is V1-only, but URL construction must stay total for any ref.
    const ref: ExecutionRef = { connection: b.id, prompt: asPromptId('j1') }
    expect(app.viewUrlForExecution(ref, { filename: 'x.png' })).toBe(
      'http://native:8000/view?filename=x.png&subfolder=&type=output',
    )
  })

})

describe('per-tab backend targeting (view state)', () => {
  it('setTabTarget switches the tab; other tabs stay on default', () => {
    const other = app.tabs.get()[1]!
    const b = addOffline('http://other:8188')
    app.setTabTarget(basic.id, b.id)
    expect(app.backendForTab(basic)).toBe(b)
    expect(app.backendForTab(other)).toBe(app.backends.get()[0])
  })

  it('rejects unknown backends and frozen tabs', () => {
    const b = addOffline('http://other:8188')
    registryFor(b)
    app.setTabTarget(basic.id, asConnectionId('nope'))
    expect(app.tabTargets.get().size).toBe(0)

    const ref = foreignRun(String(b.id), 'p-frozen')
    app.setTabTarget(basic.id, b.id) // only b has a registry in this test
    const result = app.compileTab(basic)
    if (!result?.ok) throw new Error('compile failed')
    app.store.register(ref, result.artifact, 1)
    expect(app.openExecutionView(ref)).toBe(true)
    const frozen = app.tabs.get().find((t) => t.execution)!
    app.setTabTarget(frozen.id, app.backends.get()[0]!.id)
    expect(app.tabTargets.get().has(frozen.id)).toBe(false)
  })

  it('a frozen tab resolves its execution connection, not any target', () => {
    const b = addOffline('http://other:8188')
    registryFor(b)
    app.setTabTarget(basic.id, b.id)
    const result = app.compileTab(basic) // compiles against b's registry/id
    if (!result?.ok) throw new Error('compile failed')
    const ref: ExecutionRef = { connection: b.id, prompt: asPromptId('p1') }
    app.store.register(ref, result.artifact, 1)
    expect(app.openExecutionView(ref)).toBe(true)
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
    expect(b.registry.get()!.resolve('comfy.EmptyImage')).toBeDefined()
  })
})

describe('execution output routing', () => {
  const file = { filename: 'x.png' }

  it('viewUrlForExecution uses the execution backend, not the default', () => {
    const b = addOffline('http://other:8188')
    const onB: ExecutionRef = { connection: b.id, prompt: asPromptId('p1') }
    expect(app.viewUrlForExecution(onB, file)).toContain('http://other:8188/view')
    const onDefault: ExecutionRef = { connection: app.connection.id, prompt: asPromptId('p2') }
    expect(app.viewUrlForExecution(onDefault, file)).not.toContain('http://other:8188')
  })

  it('a REMOVED backend still resolves its historical executions', () => {
    const b = addOffline('http://other:8188')
    const ref = foreignRun(String(b.id), 'p1')
    app.removeBackend(b.id)
    expect(app.store.get(ref)).toBeDefined() // history survives removal
    expect(app.viewUrlForExecution(ref, file)).toContain('http://other:8188/view')
  })

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

  it('assetUrlForExecution survives backend removal (historical outputs)', () => {
    const b = addOffline('http://other:8188')
    const ref = foreignRun(String(b.id), 'p1')
    app.removeBackend(b.id)
    expect(app.assetUrlForExecution(ref, 'blake3:00')).toBe(
      'http://other:8188/api/assets/blake3%3A00',
    )
  })
})
