import { prepareWorkflowApp } from './fixtures/workflow-app.js'
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
import { asConnectionId, asPromptId, resolveImportedNodePacks, setLocale, type ComfyTranslation, type DinksterNodesPayload, type ExecutionRef, type NodeSchema } from '@dinkster/core'
import { buildDinksterRegistry, EngineNotReadyError, type DinksterJobRecord, type SchemaRegistry, type WorkerInfo } from '@dinkster/client'
import { buildScene, defaultTokens } from '@dinkster/canvas'
import { AppState, type Backend, type Tab } from '../src/app-state.js'
import { historicalSchemas } from './historical-schemas.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const root = join(dirname(fileURLToPath(import.meta.url)), '../../core')
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

function registerNativeRun(backend: Backend, ref: ExecutionRef): void {
  registryFor(backend)
  app.setTabTarget(basic.id, backend.id)
  const compiled = app.compileTab(basic)
  if (!compiled?.ok) throw new Error('Native run fixture did not compile')
  app.store.register(ref, compiled.artifact, 0, { jobRef: `job-${ref.prompt}` })
}

function sealedCompletion(
  backend: Backend, ref: ExecutionRef, job: DinksterJobRecord & { readonly state: 'completed' }, digests: readonly string[] = [],
): DinksterJobRecord {
  const jobRef = `job-${ref.prompt}`
  const outputs = job.outputs as Record<string, Record<string, unknown>> | undefined
  const sources = [
    ...Object.entries(outputs ?? {}).flatMap(([nodeId, values]) =>
      Object.keys(values).map((outputId) => ({ nodeId, outputId }))),
    ...(job.artifacts ?? []).map((artifact, index) => ({ nodeId: artifact.nodeId, artifact: { ...artifact, index } })),
  ]
  const offers = sources.map((source, index) => ({ ...source, scope: 'local' as const, jobRef, attemptId: 1,
    token: (index + 1).toString(16).padStart(32, '0'), publication: 1, complete: true, digests }))
  vi.spyOn(backend.connection, 'fetchTerminalResultAssets').mockResolvedValue({
    scope: 'local', jobRef, attemptId: 1, state: job.state, complete: true, offers,
  })
  return { ...job, jobRef, attemptId: 1 }
}

beforeEach(async () => {
  app = createWorkflowApp(null)
  for (const name of ['basic', 'subgraph']) {
    await app.openDocument(JSON.parse(readFileSync(join(root, `fixtures/workflows/seed-${name}.json`), 'utf8')), name)
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

  it('is not removable', () => {
    const def = app.backends.get()[0]!
    app.removeBackend(def.id)
    expect(app.backends.get()[0]).toBe(def)
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
    const translations = (version: string): readonly ComfyTranslation[] => [{
      pack: 'dinkster-image', version, schema: choiceSchema([]),
      rule: { from: 'LegacyChoice', cases: [{ to: 'Choice', inputs: {}, outputs: {} }] },
    }]
    const olderTranslations = translations('0.0.1')
    const newestTranslations = translations('0.0.2')
    vi.spyOn(backend.connection, 'fetchComfyTranslations')
      .mockResolvedValueOnce(olderTranslations)
      .mockResolvedValueOnce(newestTranslations)
    const importedVersions: (string | undefined)[] = []
    const imports: Promise<void>[] = []
    backend.registry.subscribe(() => {
      imports.push(app.openDocument({ nodes: [{ id: 1, type: 'LegacyChoice' }], links: [] }, 'First open', backend).then((diagnostics) => {
        expect(diagnostics).toEqual([])
        const tab = app.activeTab()!
        expect(tab.store.doc.graphs.g0!.nodes.n1!.type).toBe('Choice')
        importedVersions.push(resolveImportedNodePacks(tab.store.doc, backend.registry.get()!.resolve)[0]?.version)
      }))
    })

    const first = app.refreshBackendSchemas(backend)
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'))
    const second = app.refreshBackendSchemas(backend)
    await vi.waitFor(() => expect(resolveSecond).toBeTypeOf('function'))
    const newest = buildDinksterRegistry(backend.id, nodesPayload)
    resolveSecond(newest)
    await second
    resolveFirst(buildDinksterRegistry(backend.id, nodesPayload))
    await first
    await Promise.all(imports)

    expect(backend.registry.get()).toBe(newest)
    expect(backend.schemaState.get()).toEqual({ status: 'ready' })
    expect(backend.comfyTranslations.get()).toBe(newestTranslations)
    expect(importedVersions).toEqual(['0.0.2'])
  })

  it.each(['available', 'empty', 'unavailable'] as const)('publishes installed schemas before advisory metadata becomes %s', async (outcome) => {
    const backend = app.addBackend('/advisory', 'Native', false, 'dinkster', false)!
    let resolve!: (records: readonly ComfyTranslation[]) => void
    let reject!: (error: Error) => void
    vi.spyOn(backend.connection, 'fetchComfyTranslations').mockReturnValue(new Promise((done, fail) => {
      resolve = done
      reject = fail
    }))
    const registry = buildDinksterRegistry(backend.id, nodesPayload)
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(registry)
    vi.spyOn(backend, 'refreshDiagnostics').mockImplementation(() => {})
    await app.refreshBackendSchemas(backend)
    expect(backend.registry.get()).toBe(registry)
    expect(backend.schemaState.get()).toEqual({ status: 'ready' })
    expect(backend.comfyTranslationsUnavailable.get()).toBe(true)
    const records: readonly ComfyTranslation[] = outcome === 'available' ? [{
      pack: 'dinkster-image', version: '0.0.2', schema: choiceSchema([]),
      rule: { from: 'LegacyChoice', cases: [{ to: 'Choice', inputs: {}, outputs: {} }] },
    }] : []
    if (outcome === 'unavailable') reject(new Error('metadata offline'))
    else resolve(records)
    await vi.waitFor(() => {
      if (outcome === 'unavailable') expect(app.logs.get()).toContainEqual(expect.objectContaining({ message: expect.stringContaining('metadata offline') }))
      else expect(backend.comfyTranslationsUnavailable.get()).toBe(false)
    })
    expect(backend.registry.get()).toBe(registry)
    expect(backend.comfyTranslations.get()).toEqual(records)
    if (outcome === 'available') {
      expect(await app.openDocument({ nodes: [{ id: 1, type: 'LegacyChoice' }], links: [] }, 'Late metadata', backend)).toEqual([])
      expect(app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.type).toBe('Choice')
    }
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
    expect((await app.openDocument({
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
    }, 'Choice refresh'))).toEqual([])
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
    await vi.waitFor(() => expect(rejectRequest).toBeTypeOf('function'))
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





  it('reconciles again when schema refresh supersedes a pending job read', async () => {
    const backend = addOffline('http://native:8000', 'Native')
    registryFor(backend)
    const ref = { connection: backend.id, prompt: asPromptId('refreshing-job') }
    registerNativeRun(backend, ref)
    app.store.apply({ kind: 'started', execution: ref, timestamp: 0 })
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    type Job = NonNullable<Awaited<ReturnType<typeof backend.connection.fetchJob>>>
    const reads: Array<(job: Job) => void> = []
    vi.spyOn(backend.connection, 'fetchJob').mockImplementation(() =>
      new Promise((resolve) => reads.push(resolve)))

    registryFor(backend)
    await vi.waitFor(() => expect(reads).toHaveLength(1))
    registryFor(backend)
    reads[0]!(sealedCompletion(backend, ref, { state: 'completed', outputs: { producer: { value: 7 } }, artifacts: [] }))
    await vi.waitFor(() => expect(reads).toHaveLength(2))
    expect(app.store.get(ref)).toMatchObject({ status: 'running', outputs: {} })

    reads[1]!(sealedCompletion(backend, ref, { state: 'completed', outputs: { producer: { value: 42 } }, artifacts: [] }))
    await vi.waitFor(() => expect(app.store.get(ref)).toMatchObject({
      status: 'completed', outputs: { producer: { value: 42 } }, artifactsHydrated: true,
    }))
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

  it('replacing a tab document clears its target', async () => {
    const b = addOffline('http://other:8188')
    app.setTabTarget(basic.id, b.id)
    const json = JSON.parse(
      readFileSync(join(root, 'fixtures/workflows/seed-basic.json'), 'utf8'),
    ) as unknown
    expect((await app.openDocument(json, 'Basic'))).toEqual([])
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


  it.each((['live', 'removed'] as const).flatMap((owner) =>
    [false, true].map((local) => ({ owner, local }))))(
    'cancels pending original-model response bodies through the $owner owner, local=$local', async ({ owner, local }) => {
      const backend = addOffline('http://model-owner:8188')
      const ref = foreignRun(String(backend.id), 'model-read')
      if (owner === 'removed') app.removeBackend(backend.id)
      const requests: string[] = []
      let transportSignal: AbortSignal | null | undefined
      let finish!: () => void
      let bodyStarted!: () => void
      const started = new Promise<void>((resolve) => { bodyStarted = resolve })
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (String(url).endsWith('/api/library/retention-clients')) return new Response('{}', { status: 404 })
        requests.push(String(url))
        transportSignal = init?.signal
        return { ok: true, status: 200, arrayBuffer: () => {
          bodyStarted()
          return new Promise<ArrayBuffer>((resolve, reject) => {
            finish = () => resolve(new Uint8Array([1, 7, 3]).buffer)
            transportSignal?.addEventListener('abort', () => reject(transportSignal!.reason), { once: true })
          })
        } } as Response
      })
      const abort = new AbortController()
      const pending = app.readFile3dAssetForExecution(ref, local
        ? { verification: 'unverified', localBinding: 'model-grant' }
        : { digest: `blake3:${'a'.repeat(64)}` }, abort.signal)
      const result = pending.then(() => 'published', (error: unknown) => error instanceof Error ? error.name : 'refused')
      try {
        await started
        abort.abort()
        expect(transportSignal?.aborted).toBe(true)
        expect(await result).toBe('AbortError')
        expect(requests).toEqual([local ? 'http://model-owner:8188/api/assets/local/model-grant'
          : `http://model-owner:8188/api/assets/blake3%3A${'a'.repeat(64)}`])
      } finally { finish(); await result }
    },
  )


  it('keeps cached and pending value reads available after their execution ages out', async () => {
    const backend = addOffline('http://ended-value-owner:8188')
    const ref = foreignRun(String(backend.id), 'ended-value-read')
    const query = { jobId: ref.prompt, nodeId: 'audio', outputId: 'result' }
    let body!: ReadableStreamDefaultController<Uint8Array>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/api/library/retention-clients')) return new Response('{}', { status: 404 })
      const selector = url.searchParams.get('rendition')
      if (selector === null) return Response.json({ available: true,
        descriptor: { typeId: 'AUDIO', fingerprint: 'ended-audio', meta: {} },
        renditions: [{ kind: 'window', mime: 'audio/wav', cacheKey: 'ended-window' }] })
      if (!url.searchParams.has('frame')) return new Response(new Uint8Array([23, 41]))
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller } }))
    })
    const values = app.valuesForExecution(ref)!
    const peek = await values.peek(query)
    if (!peek.available) throw new Error('Expected admitted descriptor')
    const cached = await values.rendition(query, 'window', { descriptor: peek.descriptor })
    if (!cached.available) throw new Error('Expected live bytes')
    expect([...new Uint8Array(cached.bytes)]).toEqual([23, 41])
    expect(await values.rendition(query, 'window', { descriptor: peek.descriptor })).toEqual(cached)
    const pending = values.rendition(query, 'window', { descriptor: peek.descriptor, frame: 3 })
    await vi.waitFor(() => expect(body).toBeDefined())
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 1 })
    for (let index = 0; index < 201; index++) {
      const next = foreignRun(String(backend.id), `pressure-${index}`)
      app.store.apply({ kind: 'completed', execution: next, timestamp: index + 2 })
    }
    expect(app.store.get(ref)).toBeUndefined()
    body.enqueue(new Uint8Array([17, 31]))
    body.close()
    expect(await pending).toMatchObject({ available: true })
    expect(await values.rendition(query, 'window', { descriptor: peek.descriptor })).toMatchObject({ available: true })
  })

  it('historical asset URLs and bytes use the execution backend, not the default', async () => {
    const b = addOffline('http://other:8188')
    vi.spyOn(b.connection, 'fetchAssetBytes').mockResolvedValue(new Uint8Array([53, 19]).buffer)
    vi.spyOn(app.connection, 'fetchAssetBytes').mockResolvedValue(new Uint8Array([1]).buffer)
    const digest = 'blake3:' + 'ab'.repeat(32)
    const onB: ExecutionRef = { connection: b.id, prompt: asPromptId('p1') }
    expect(app.assetUrlForExecution(onB, digest)).toBe(
      `http://other:8188/api/assets/${encodeURIComponent(digest)}`,
    )
    const onDefault: ExecutionRef = { connection: app.connection.id, prompt: asPromptId('p2') }
    expect(app.assetUrlForExecution(onDefault, digest)).not.toContain('http://other:8188')
    expect(new Uint8Array((await app.readAssetForExecution(onB, digest))!)).toEqual(new Uint8Array([53, 19]))
    expect(new Uint8Array((await app.readAssetForExecution(onDefault, digest))!)).toEqual(new Uint8Array([1]))
    app.removeBackend(b.id)
    expect(new Uint8Array((await app.readAssetForExecution(onB, digest))!)).toEqual(new Uint8Array([53, 19]))
    expect(await app.readAssetForExecution({ ...onB, connection: asConnectionId('unknown') }, digest)).toBeUndefined()
  })

  it('historical asset routes and native value ownership survive backend removal', async () => {
    const requests: URL[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/api/library/retention-clients')) return new Response('{}', { status: 404 })
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
