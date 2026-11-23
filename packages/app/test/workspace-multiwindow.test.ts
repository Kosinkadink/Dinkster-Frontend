import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asNodeId,
  asPromptId,
  compile,
  compositorRecipeFingerprint,
  coreCommandRegistry,
  setLocale,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState } from '../src/app-state.js'
import { SharedWorkerDocumentAuthority, type WorkerPortLike } from '../src/shared-worker-authority.js'
import {
  SharedWorkerCollabConnection,
  connectSharedWorkerSession,
  type SharedWorkerPortFactory,
} from '../src/shared-worker-connection.js'
import { SharedWorkerTabAuthority } from '../src/workspace-worker-authority.js'
import { SharedWorkerTabConnection, type WorkspaceWorkerPortFactory } from '../src/workspace-worker-connection.js'
import { CURVE_EDITOR_KIND } from '../src/editors.js'
import { prepareWorkflowApp } from './fixtures/workflow-app.js'
import { preparePersistenceValue } from '../src/workflow-persistence-value.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

class MemoryPort implements WorkerPortLike {
  peer: MemoryPort | undefined
  paused = false
  private readonly queued: unknown[] = []
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()
  postMessage(message: unknown): void {
    const data = structuredClone(message)
    queueMicrotask(() => {
      if (this.peer?.paused) {
        this.peer.queued.push(data)
        return
      }
      for (const listener of this.peer?.listeners ?? []) listener({ data } as MessageEvent<unknown>)
    })
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener)
  }
  release(): void {
    this.paused = false
    for (const data of this.queued.splice(0)) {
      for (const listener of this.listeners) listener({ data } as MessageEvent<unknown>)
    }
  }
}

const memoryStorage = (reverseKeys = false): Storage => {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: (index) => (reverseKeys ? [...values.keys()].reverse() : [...values.keys()])[index] ?? null,
    get length() { return values.size },
  } as Storage
}

const editableApps: AppState[] = []
const createEditableApp = (): AppState => {
  const app = prepareWorkflowApp(new AppState())
  editableApps.push(app)
  return app
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage())
})
afterEach(() => {
  for (const app of editableApps.splice(0)) app.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const drainTasks = async (): Promise<void> => {
  for (let count = 0; count < 5; count += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const authorityFactories = (): {
  readonly document: SharedWorkerPortFactory
  readonly workspace: WorkspaceWorkerPortFactory
} => {
  const documents = new SharedWorkerDocumentAuthority()
  const workspace = new SharedWorkerTabAuthority()
  const connect = (authority: { connect(port: WorkerPortLike): void }): MemoryPort => {
    const renderer = new MemoryPort()
    const worker = new MemoryPort()
    renderer.peer = worker
    worker.peer = renderer
    authority.connect(worker)
    return renderer
  }
  return {
    document: () => connect(documents),
    workspace: () => connect(workspace),
  }
}

const workflow = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('multi-window-workflow'),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'), name: 'root',
      nodes: { n1: { id: asNodeId('n1'), type: 'X', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
    },
  },
  view: { graphs: {} },
})

const primitive = (type: string, name: 'FLOAT' | 'BOOLEAN'): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: [
    {
      kind: 'input', id: 'value', type: { kind: 'concrete', name }, optional: false,
      ...(name === 'FLOAT' ? { widget: { widgetType: 'NUMBER', options: { step: 0.1 }, default: 0 } } : {}),
    },
    { kind: 'output', id: name, type: { kind: 'concrete', name } },
  ],
})

class EventChannel {
  peer: EventChannel | undefined
  readonly sent: unknown[] = []
  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>()
  postMessage(message: unknown): void {
    const data = structuredClone(message)
    this.sent.push(data)
    for (const listener of this.peer?.listeners ?? []) listener({ data } as MessageEvent<unknown>)
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener)
  }
}

describe('AppState multi-window workspace', () => {
  it.each(['unchanged', 'edited', 'asset', 'registry', 'extensions', 'target', 'remote', 'replacement'] as const)(
    'keeps comparison proof only for an equivalent authority continuation: %s', async (scenario) => {
      vi.stubGlobal('requestAnimationFrame', () => 1)
      vi.stubGlobal('cancelAnimationFrame', () => undefined)
      const app = createEditableApp()
      app.registerSchemas([primitive('X', 'FLOAT')])
      expect(await app.openDocument(workflow(), 'Comparison continuity')).toEqual([])
      const local = app.activeTab()!
      expect((await app.dispatchTo(local, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n1', inputId: 'value', value: 7,
      } })).ok).toBe(true)
      const ready = app.compileTabCached(local)
      expect(ready?.ok).toBe(true)
      if (scenario === 'edited') {
        expect((await app.dispatchTo(local, { command: 'node.setValue', params: {
          graphId: 'g0', nodeId: 'n1', inputId: 'value', value: 13,
        } })).ok).toBe(true)
      }
      if (scenario === 'asset') {
        expect((await app.dispatchTo(local, { command: 'node.setValue', params: {
          graphId: 'g0', nodeId: 'n1', inputId: 'held', value: {
            digest: `blake3:${'c'.repeat(64)}`, name: 'changed.bin', size: 11,
            mediaType: 'application/octet-stream', virtualPath: '',
          },
        } })).ok).toBe(true)
      }
      if (scenario === 'registry') app.registerSchemas([primitive('X', 'BOOLEAN')])
      if (scenario === 'extensions') app.extensionRevision.update((revision) => revision + 1)
      if (scenario === 'target') {
        const other = app.addBackend('http://continuation.test', 'Other target', false, 'dinkster')!
        other.registry.set(app.registry.get())
        app.setTabTarget(local.id, other.id)
      }
      const factory = authorityFactories()
      const remote = scenario === 'remote' ? await connectSharedWorkerSession(local.id, local.store.doc,
        coreCommandRegistry(), { actorId: 'established-peer' }, factory.document) : undefined
      if (remote) {
        expect(remote.dispatch({ command: 'node.setTitle', params: {
          graphId: 'g0', nodeId: 'n1', title: 'Different shared document',
        } }).ok).toBe(true)
        await remote.settle()
      }
      const observed: unknown[] = []
      const unsubscribe = app.tabs.subscribe(() => {
        const current = app.activeTab()
        if (current?.id === local.id && current.store !== local.store) observed.push(app.previewComparisonCompile(current))
      })
      await app.enableWorkspaceAuthority(factory.document, factory.workspace)
      remote?.close()
      unsubscribe()
      const current = app.activeTab()!
      expect(current.store).not.toBe(local.store)
      if (scenario === 'remote') expect(current.store.doc.graphs.g0!.nodes.n1!.title).toBe('Different shared document')
      else expect(current.store.doc).toEqual(local.store.doc)
      expect(observed.length).toBeGreaterThan(0)
      if (scenario === 'unchanged' || scenario === 'replacement') {
        expect(observed.every((result) => result === ready)).toBe(true)
        expect(app.previewComparisonCompile(current)).toBe(ready)
        const full = app.compileTabCached(current)
        expect(full).not.toBe(ready)
        expect(full).toEqual(app.compileTab(current))
        if (!full?.ok) throw new Error('promoted workflow did not compile')
        expect(full.artifact.snapshot).toStrictEqual(current.store.doc)
        expect(full.artifact.revision).toBe(current.store.revision)
        if (scenario === 'replacement') {
          expect(await app.openDocument(workflow(), 'Unrelated replacement')).toEqual([])
          expect(app.activeTab()).not.toBe(current)
          expect(app.previewComparisonCompile(app.activeTab()!)).toBeUndefined()
        } else {
          expect((await app.dispatchTo(current, { command: 'node.setValue', params: {
            graphId: 'g0', nodeId: 'n1', inputId: 'value', value: 29,
          } })).ok).toBe(true)
          expect(app.previewComparisonCompile(current)).toBeUndefined()
        }
      } else {
        expect(observed.every((result) => result === undefined)).toBe(true)
        expect(app.previewComparisonCompile(current)).toBeUndefined()
      }
    },
  )













  it('opens incoming App tabs as Graph while preserving exposure in a default-off window', async () => {
    const factory = authorityFactories()
    const author = prepareWorkflowApp(new AppState())
    author.settings.set('features.appView.enabled', true)
    const exposed = [{ graphId: 'g0', nodeId: 'n1', inputId: 'amount', label: 'Amount' }]
    await author.openDocument({ ...workflow(), ext: { 'dinkster.exposed': exposed } }, 'Shared app')
    author.setTabEditorKind('multi-window-workflow', 'app')
    await author.enableWorkspaceAuthority(factory.document, factory.workspace)
    const viewer = prepareWorkflowApp(new AppState())
    viewer.settings.set('features.appView.enabled', false)
    await viewer.enableWorkspaceAuthority(factory.document, factory.workspace)
    await drainTasks()
    const received = () => viewer.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!
    expect(received().editorKind).toBe('graph')
    expect(received().store.doc.ext?.['dinkster.exposed']).toEqual(exposed)
    author.setTabEditorKind('multi-window-workflow', 'graph')
    await drainTasks()
    author.setTabEditorKind('multi-window-workflow', 'app')
    await drainTasks()
    expect(received().editorKind).toBe('graph')
    expect(received().store.doc.ext?.['dinkster.exposed']).toEqual(exposed)
    author.dispose()
    viewer.dispose()
  })

  it('uses one authoritative document with shared edit and undo visibility', async () => {
    const factory = authorityFactories()
    const first = createEditableApp()
    const second = createEditableApp()
    await first.openDocument(workflow(), 'Shared workflow')
    await second.openDocument(workflow(), 'Shared workflow')
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])
    const firstTab = first.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!
    const secondTab = second.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!

    expect((await first.dispatchTo(firstTab, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Edited in first window' },
    })).ok).toBe(true)
    await (firstTab.store as unknown as { settle(): Promise<void> }).settle()
    expect(secondTab.store.doc.graphs.g0!.nodes.n1!.title).toBe('Edited in first window')
    expect(firstTab.store.undo()).toBe(true)
    await (firstTab.store as unknown as { settle(): Promise<void> }).settle()
    expect(secondTab.store.doc.graphs.g0!.nodes.n1!.title).toBeUndefined()
  })






  it('converges create, reorder, close, and persistence snapshots across windows', async () => {
    const factory = authorityFactories()
    const first = prepareWorkflowApp(new AppState())
    const second = prepareWorkflowApp(new AppState())
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])

    const created = first.createWorkflow()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(second.tabs.get().map((tab) => tab.id)).toContain(created.id)

    second.tabs.set([...second.tabs.get()].reverse())
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(first.tabs.get().map((tab) => tab.id)).toEqual(second.tabs.get().map((tab) => tab.id))

    second.closeTab(created.id)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(first.tabs.get().some((tab) => tab.id === created.id)).toBe(false)
    first.flushPersistTabs()
    second.flushPersistTabs()
    expect(first.tabs.get().map((tab) => tab.id)).toEqual(second.tabs.get().map((tab) => tab.id))
  })

  it('preserves a local curve editor when another window publishes tab metadata', async () => {
    const factory = authorityFactories()
    const first = prepareWorkflowApp(new AppState())
    const second = prepareWorkflowApp(new AppState())
    await first.openDocument(workflow(), 'Shared workflow')
    await second.openDocument(workflow(), 'Shared workflow')
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])
    const tab = first.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const target = {
      tabId: tab.id,
      graphId: 'g0',
      nodeId: 'n1',
      inputId: 'curve',
      instancePath: [],
      openedStoredValue: undefined,
      openedSchemaDefault: undefined,
      openedValue: { points: [{ position: 0, value: 0 }] },
    }
    first.curveEditorTarget.set(target)
    first.setTabEditorKind(tab.id, CURVE_EDITOR_KIND)

    second.createWorkflow()
    await drainTasks()

    expect(first.tabs.get().find((candidate) => candidate.id === tab.id)?.editorKind).toBe(CURVE_EDITOR_KIND)
    expect(first.curveEditorTarget.get()).toBe(target)
  })




  it('mirrors live execution events between window stores', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const first = prepareWorkflowApp(new AppState({ workspaceEvents: left }))
    const second = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('run-1') }

    left.postMessage({
      source: 'another-window',
      kind: 'event',
      event: { kind: 'started', execution: ref, timestamp: 42 },
    })

    const diagnostics = [
      { code: 'alpha_dropped', nodeId: 'nested.image', outputId: 'rgba', inputIds: ['source'] },
      { code: 'mask_polarity_mismatch', nodeId: 'nested.image', inputId: 'mask', expected: 'coverage', actual: 'transparency' },
      { code: 'alpha_dropped', nodeId: 'nested.image', outputId: 'rgba', inputId: 'source' },
    ]
    for (const timestamp of [43, 44]) {
      left.postMessage({
        source: 'another-window', kind: 'event',
        event: { kind: 'valueDiagnostics', execution: ref, timestamp, diagnostics },
      })
    }
    expect(second.store.get(ref)?.valueDiagnostics).toEqual(diagnostics)
    for (const diagnostic of [
      { ...diagnostics[0], inputIds: [123] },
      { ...diagnostics[1], actual: 'guessed' },
      { ...diagnostics[2], inputId: '' },
      { code: 'unknown_diagnostic' },
    ]) {
      left.postMessage({
        source: 'another-window', kind: 'event',
        event: { kind: 'valueDiagnostics', execution: ref, timestamp: 45, diagnostics: [diagnostic] },
      })
    }
    expect(second.store.get(ref)?.valueDiagnostics).toEqual(diagnostics)
    expect(second.store.get(ref)?.status).toBe('running')
    expect(first.store.get(ref)).toBeUndefined()
  })

  it('preserves worker attribution in node progress mirrored between windows', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const second = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('run-worker') }

    left.postMessage({
      source: 'another-window',
      kind: 'event',
      event: {
        kind: 'nodeStates',
        execution: ref,
        timestamp: 42,
        nodes: { n1: { state: 'running', worker: 'render-box' } },
      },
    })

    expect(second.store.get(ref)?.nodes.n1).toEqual({ state: 'running', worker: 'render-box' })
  })



  it('rebuilds valid registrations and rejects malformed peer artifacts', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    const registry = buildDinksterRegistry(asConnectionId('local'), {
      schemaVersion: 1,
      dinkster: { version: 'test', schemaWire: 2 },
      nodes: {
        X: {
          schemaVersion: 2, displayName: 'X', outputNode: true,
          body: [{ kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } }],
        },
      },
    })
    const result = compile({
      document: workflow(), revision: 0, resolve: registry.resolve, scope: { kind: 'full' },
      connection: asConnectionId('local'), schemaHash: registry.hash,
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    const accepted = { connection: asConnectionId('local'), prompt: asPromptId('run-register-valid') }
    left.postMessage({
      source: 'peer', kind: 'register', ref: accepted, artifact: result.artifact, timestamp: 7,
    })
    expect(app.store.get(accepted)).toBeUndefined()
    app.registry.set(registry)
    expect(app.store.get(accepted)?.artifact).toEqual(result.artifact)
    expect(app.store.get(accepted)?.queuedAt).toBe(7)

    const missing = { connection: asConnectionId('local'), prompt: asPromptId('run-register-missing') }
    left.postMessage({ source: 'hostile-window', kind: 'register', ref: missing, artifact: {}, timestamp: 1 })
    expect(app.store.get(missing)).toBeUndefined()

    const corrupted = { connection: asConnectionId('local'), prompt: asPromptId('run-register-corrupted') }
    left.postMessage({
      source: 'hostile-window', kind: 'register', ref: corrupted,
      artifact: { ...result.artifact, prompt: {} }, timestamp: 1,
    })
    expect(app.store.get(corrupted)).toBeUndefined()
  })

  it('retries a registration after a same-hash reconnect registry restores graph features', async () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    const connection = asConnectionId('local')
    const schemas = new Map([
      ['dinkster.utilities.primitive_float', primitive('dinkster.utilities.primitive_float', 'FLOAT')],
      ['dinkster.utilities.primitive_boolean', primitive('dinkster.utilities.primitive_boolean', 'BOOLEAN')],
    ])
    const registry = {
      connection,
      hash: 'same-hash-region-registry',
      schemas,
      diagnostics: [],
      resolve: (type: string) => schemas.get(type),
      graphFeatures: ['regions'],
    }
    const author = createEditableApp()
    author.registry.set(registry)
    const tab = author.createWorkflow()
    expect((await author.createRegion(tab, tab.store.doc.root, { x: 0, y: 0 }, 'map')).ok).toBe(true)
    const result = author.compileTab(tab)
    if (!result?.ok) throw new Error(JSON.stringify(result?.diagnostics))
    const ref = { connection, prompt: asPromptId('run-register-region-reconnect') }

    app.registry.set(registry)
    app.registry.set({
      connection,
      hash: registry.hash,
      schemas,
      diagnostics: [],
      resolve: registry.resolve,
    })
    left.postMessage({ source: 'peer', kind: 'register', ref, artifact: result.artifact, timestamp: 7 })
    expect(app.store.get(ref)).toBeUndefined()

    app.registry.set(registry)
    expect(app.store.get(ref)?.artifact?.dinksterGraph).toEqual(result.artifact.dinksterGraph)
    expect(app.store.get(ref)?.queuedAt).toBe(7)
  })

  it('keeps a locally opened workflow active while the shared inventory is opening', async () => {
    const authority = new SharedWorkerTabAuthority()
    const renderer = new MemoryPort()
    const worker = new MemoryPort()
    renderer.peer = worker
    worker.peer = renderer
    renderer.paused = true
    authority.connect(worker)
    const app = createEditableApp()
    const opening = app.enableWorkspaceAuthority(authorityFactories().document, () => renderer)
    await app.openDocument(workflow(), 'Opened during startup')
    const selected = app.activeTab()!
    renderer.release()
    await opening
    await drainTasks()
    expect(app.activeTab()!.id).toBe(selected.id)
    expect(app.activeTab()!.store.doc).toEqual(selected.store.doc)
    expect(app.tabs.get().some((tab) => tab.title === 'Opened during startup')).toBe(true)
  })



  it('keeps an unchanged needs review usable after document authority promotion', async () => {
    const app = createEditableApp()
    const backend = app.backends.get()[0]!
    const project = { id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Film', created: '2026-11-19T00:00:00Z', revision: 1, deleted: false }
    vi.spyOn(backend.connection.status, 'get').mockReturnValue('connected')
    vi.spyOn(backend.connection, 'getProject').mockResolvedValue(project)
    vi.spyOn(backend.connection, 'projectNeeds').mockResolvedValue({ packs: [], extra: [], unknown: [], installed: [{ pack: 'film-tools', version: '2.1' }] })
    vi.spyOn(backend.connection, 'planWorkflowRequirements').mockResolvedValue({ packs: [], assets: [], errors: [] })
    await app.openDocument({ ...workflow(), environment: {
      packs: { 'film-tools': { version: '2.1' } }, nodes: { X: { pack: 'film-tools', signature: 'x' } },
    } }, 'Film')
    await app.checkProjectNeeds(backend)
    const review = app.projectNeedsReview.get()!
    expect(review.enable).toEqual(['film-tools'])
    const factories = authorityFactories()
    await app.enableWorkspaceAuthority(factories.document, factories.workspace)
    let enabled: readonly string[] = []
    vi.spyOn(backend.connection, 'setProjectExtraPacks').mockImplementation(async (_id, extra) => {
      enabled = extra
      return { ...project, revision: 2 }
    })
    vi.spyOn(app, 'refreshBackendSchemas').mockResolvedValue()
    await app.enableReviewedProjectPacks(review)
    expect(enabled).toEqual(['film-tools'])
    expect(app.projectNeedsReview.get()).toBeUndefined()
  })

  it('confirms ownership on the current target after authority promotion opens', async () => {
    const authority = new SharedWorkerDocumentAuthority()
    const renderers: MemoryPort[] = []
    const factory: SharedWorkerPortFactory = () => {
      const renderer = new MemoryPort()
      const worker = new MemoryPort()
      renderer.peer = worker
      worker.peer = renderer
      renderer.paused = true
      renderers.push(renderer)
      authority.connect(worker)
      return renderer
    }
    const app = createEditableApp()
    await app.openDocument(workflow(), 'Shared workflow')
    const tab = app.activeTab()!
    const target = app.addBackend('http://other:8000', 'Other', false, 'dinkster', false)!
    target.registry.set(app.registry.get())
    const promotion = app.enableWorkspaceAuthority(factory, authorityFactories().workspace)
    await vi.waitFor(() => expect(renderers.length).toBeGreaterThan(0))
    app.setTabTarget(tab.id, target.id)
    renderers.forEach((renderer) => renderer.release())
    await promotion
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    expect('status' in promoted.store && (promoted.store.status as { get(): string }).get()).toBe('live')
    expect(promoted.store.doc).toEqual(tab.store.doc)
    expect(app.backendForTab(promoted)).toBe(target)
    expect(app.problems.get().filter((problem) => problem.code === 'workspace.authority.failed')).toEqual([])
  })

  it('keeps a local edit made while authority promotion is opening', async () => {
    const authority = new SharedWorkerDocumentAuthority()
    const renderers: MemoryPort[] = []
    let pause = true
    const factory: SharedWorkerPortFactory = () => {
      const renderer = new MemoryPort()
      renderers.push(renderer)
      const worker = new MemoryPort()
      renderer.paused = pause
      renderer.peer = worker
      worker.peer = renderer
      authority.connect(worker)
      return renderer
    }
    const app = createEditableApp()
    await app.openDocument(workflow(), 'Shared workflow')
    const tab = app.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const workspaceFactory = authorityFactories().workspace
    const promotion = app.enableWorkspaceAuthority(factory, workspaceFactory)
    expect((await app.dispatchTo(tab, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Kept locally' },
    })).ok).toBe(true)
    setTimeout(() => renderers.forEach((renderer) => renderer.release()), 0)
    await promotion
    pause = false
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    expect(promoted.store.doc.graphs.g0!.nodes.n1!.title).toBe('Kept locally')
    expect('status' in promoted.store).toBe(true)
    const other = await connectSharedWorkerSession(
      tab.id, workflow(), coreCommandRegistry(), { actorId: 'other' }, factory,
    )
    expect(other.doc.graphs.g0!.nodes.n1!.title).toBe('Kept locally')
  })

  it('keeps edits and undo when switching editor while authority promotion is opening', async () => {
    const authority = new SharedWorkerDocumentAuthority()
    const renderers: MemoryPort[] = []
    let opened!: () => void
    const openResponse = new Promise<void>((resolve) => { opened = resolve })
    let pause = true
    const factory: SharedWorkerPortFactory = () => {
      const renderer = new MemoryPort()
      const worker = new MemoryPort()
      renderer.paused = pause
      renderer.peer = worker
      worker.peer = renderer
      const post = worker.postMessage.bind(worker)
      worker.postMessage = (message) => {
        post(message)
        if (isRecord(message) && message['kind'] === 'response' && message['id'] === 1) opened()
      }
      renderers.push(renderer)
      authority.connect(worker)
      return renderer
    }
    const app = prepareWorkflowApp(new AppState())
    app.settings.set('features.appView.enabled', true)
    await app.openDocument(workflow(), 'Shared workflow')
    const tab = app.activeTab()!
    const workspace = authorityFactories().workspace
    const promotion = app.enableWorkspaceAuthority(factory, workspace)
    try {
      await openResponse
      expect(tab.store.dispatch({
        command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount', value: 23.976 },
      }).ok).toBe(true)
      expect(tab.store.dispatch({
        command: 'params.expose', params: { graphId: 'g0', nodeId: 'n1', inputId: 'amount' },
      }).ok).toBe(true)
      app.setTabEditorKind(tab.id, 'app')
      pause = false
      for (const renderer of renderers) renderer.release()
      await promotion
      await app.enableWorkspaceAuthority(factory, workspace)
      const live = app.activeTab()!
      expect('status' in live.store).toBe(true)
      expect(live.editorKind).toBe('app')
      expect(live.store.doc.graphs.g0!.nodes.n1!.values.amount).toBe(23.976)
      expect(live.store.doc.ext?.['dinkster.exposed']).toEqual([
        { graphId: 'g0', nodeId: 'n1', inputId: 'amount' },
      ])
      expect(live.store.undo()).toBe(true)
      expect(live.store.doc.ext?.['dinkster.exposed']).toBeUndefined()
      expect(live.store.doc.graphs.g0!.nodes.n1!.values.amount).toBe(23.976)
      expect(live.store.undo()).toBe(true)
      expect(live.store.doc.graphs.g0!.nodes.n1!.values.amount).toBeUndefined()
    } finally {
      app.dispose()
    }
  })

  it('keeps the undo history of a local edit made while authority promotion is opening', async () => {
    const authority = new SharedWorkerDocumentAuthority()
    const renderers: MemoryPort[] = []
    let pause = true
    const factory: SharedWorkerPortFactory = () => {
      const renderer = new MemoryPort()
      renderers.push(renderer)
      const worker = new MemoryPort()
      renderer.paused = pause
      renderer.peer = worker
      worker.peer = renderer
      authority.connect(worker)
      return renderer
    }
    const app = createEditableApp()
    await app.openDocument(workflow(), 'Shared workflow')
    const tab = app.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const workspaceFactory = authorityFactories().workspace
    const promotion = app.enableWorkspaceAuthority(factory, workspaceFactory)
    expect((await app.dispatchTo(tab, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Edited before promotion' },
    })).ok).toBe(true)
    setTimeout(() => renderers.forEach((renderer) => renderer.release()), 0)
    await promotion
    pause = false
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    expect('status' in promoted.store).toBe(true)
    expect(promoted.store.canUndo).toBe(true)
    expect(promoted.store.undo()).toBe(true)
    await (promoted.store as unknown as { settle(): Promise<void> }).settle()
    expect(promoted.store.doc.graphs.g0!.nodes.n1!.title).toBeUndefined()
    // The undo is authoritative: a later joiner sees the reverted document.
    const other = await connectSharedWorkerSession(
      tab.id, workflow(), coreCommandRegistry(), { actorId: 'other' }, factory,
    )
    expect(other.doc.graphs.g0!.nodes.n1!.title).toBeUndefined()
  })

  it('keeps the shared session alive when a tab is replaced with new metadata', async () => {
    const factory = authorityFactories()
    const app = createEditableApp()
    app.settings.set('features.appView.enabled', true)
    await app.openDocument(workflow(), 'Shared workflow')
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    const promoted = app.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!
    expect('status' in promoted.store).toBe(true)

    // Metadata-only mutations replace the Tab object but keep the session
    // store; a later promotion sweep must not close that session.
    app.setTabEditorKind(promoted.id, 'app')
    const replaced = app.tabs.get().find((tab) => tab.id === promoted.id)!
    expect(replaced).not.toBe(promoted)
    expect(replaced.store).toBe(promoted.store)
    await (app as unknown as { promoteWorkspaceTabs(): Promise<void> }).promoteWorkspaceTabs()

    expect((replaced.store as unknown as { status: { get(): string } }).status.get()).toBe('live')
    expect((await app.dispatchTo(replaced, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Edited after replacement' },
    })).ok).toBe(true)
    await (replaced.store as unknown as { settle(): Promise<void> }).settle()
    expect(replaced.store.doc.graphs.g0!.nodes.n1!.title).toBe('Edited after replacement')

    // Falling back to local tabs adopts the latest metadata, even when the
    // recorded session entry lags a metadata-only replacement.
    app.setTabAppArrange(replaced.id, true)
    ;(app as unknown as { disableWorkspaceAuthority(keepLocalTabs: boolean): void }).disableWorkspaceAuthority(true)
    const local = app.tabs.get().find((tab) => tab.id === replaced.id)!
    expect('status' in local.store).toBe(false)
    expect(local.editorKind).toBe('app')
    expect(local.appArrange).toBe(true)
    expect(local.store.doc.graphs.g0!.nodes.n1!.title).toBe('Edited after replacement')
  })

  it('publishes a same-lineage replacement before a delayed old session closes', async () => {
    const documentAuthority = new SharedWorkerDocumentAuthority()
    const tabAuthority = new SharedWorkerTabAuthority()
    const documentWorkers: MemoryPort[] = []
    const connect = (authority: { connect(port: WorkerPortLike): void }, workers?: MemoryPort[]): MemoryPort => {
      const renderer = new MemoryPort()
      const worker = new MemoryPort()
      renderer.peer = worker
      worker.peer = renderer
      authority.connect(worker)
      workers?.push(worker)
      return renderer
    }
    const documentFactory: SharedWorkerPortFactory = () => connect(documentAuthority, documentWorkers)
    const tabFactory: WorkspaceWorkerPortFactory = () => connect(tabAuthority)
    const app = prepareWorkflowApp(new AppState())
    await app.openDocument(workflow(), 'Shared workflow')
    await app.enableWorkspaceAuthority(documentFactory, tabFactory)
    const replacement: WorkflowDocument = {
      ...workflow(),
      graphs: { ...workflow().graphs, g0: { ...workflow().graphs.g0!, name: 'replacement' } },
    }

    documentWorkers[0]!.paused = true
    try {
      expect((await app.openDocument(replacement, 'Reopened replacement'))).toEqual([])
      await app.enableWorkspaceAuthority(documentFactory, tabFactory)
      const reopened = app.tabs.get().find((tab) => tab.id === replacement.lineage)!
      expect('status' in reopened.store).toBe(true)
      expect(reopened.store.doc.graphs.g0!.name).toBe('replacement')

      const peer = await connectSharedWorkerSession(
        replacement.lineage, workflow(), coreCommandRegistry(), { actorId: 'replacement-peer' }, documentFactory,
      )
      expect(peer.doc.graphs.g0!.name).toBe('replacement')
      peer.close()
    } finally {
      documentWorkers[0]!.release()
      app.dispose()
      await drainTasks()
    }
  })

  it('releases every document session when its window state is disposed', async () => {
    const documentAuthority = new SharedWorkerDocumentAuthority()
    const tabAuthority = new SharedWorkerTabAuthority()
    const connect = (authority: { connect(port: WorkerPortLike): void }): MemoryPort => {
      const renderer = new MemoryPort()
      const worker = new MemoryPort()
      renderer.peer = worker
      worker.peer = renderer
      authority.connect(worker)
      return renderer
    }
    const documentFactory: SharedWorkerPortFactory = () => connect(documentAuthority)
    const tabFactory: WorkspaceWorkerPortFactory = () => connect(tabAuthority)
    const app = prepareWorkflowApp(new AppState())
    await app.openDocument(workflow(), 'Shared workflow')
    await app.enableWorkspaceAuthority(documentFactory, tabFactory)
    const appTab = app.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!
    expect('status' in appTab.store).toBe(true)
    const peer = await SharedWorkerCollabConnection.open(
      'multi-window-workflow',
      workflow(),
      documentFactory,
      'remaining-window',
    )
    const initial = workflow()
    const changed: WorkflowDocument = {
      ...initial,
      graphs: { ...initial.graphs, g0: { ...initial.graphs.g0!, name: 'adopted after close' } },
    }

    expect(await peer.adoptExclusive(changed)).toBe(false)
    app.dispose()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    expect(await peer.adoptExclusive(changed)).toBe(true)
    peer.close()
  })


  it('replays create and close operations after final-window crashes', async () => {
    const globals = globalThis as { localStorage?: Storage }
    globals.localStorage = memoryStorage()
    try {
      const firstFactory = authorityFactories()
      const first = prepareWorkflowApp(new AppState())
      first.flushPersistTabs()
      await first.enableWorkspaceAuthority(firstFactory.document, firstFactory.workspace)
      const created = first.createWorkflow()
      first.dispose()
      await drainTasks()

      const secondFactory = authorityFactories()
      const second = prepareWorkflowApp(new AppState())
      await second.enableWorkspaceAuthority(secondFactory.document, secondFactory.workspace)
      await drainTasks()
      expect(second.tabs.get().some((tab) => tab.id === created.id)).toBe(true)
      second.flushPersistTabs()

      second.closeTab(created.id)
      second.dispose()
      await drainTasks()

      const thirdFactory = authorityFactories()
      const third = prepareWorkflowApp(new AppState())
      await third.enableWorkspaceAuthority(thirdFactory.document, thirdFactory.workspace)
      await drainTasks()
      expect(third.tabs.get().some((tab) => tab.id === created.id)).toBe(false)
      third.dispose()
    } finally {
      delete globals.localStorage
    }
  })

  it('replays outstanding same-window operations in causal order', async () => {
    const globals = globalThis as { localStorage?: Storage }
    globals.localStorage = memoryStorage(true)
    try {
      const firstFactory = authorityFactories()
      const first = prepareWorkflowApp(new AppState())
      first.flushPersistTabs()
      await first.enableWorkspaceAuthority(firstFactory.document, firstFactory.workspace)
      const created = first.createWorkflow()
      first.closeTab(created.id)
      first.dispose()
      await drainTasks()

      const restartedFactory = authorityFactories()
      const restarted = prepareWorkflowApp(new AppState())
      await restarted.enableWorkspaceAuthority(restartedFactory.document, restartedFactory.workspace)
      await drainTasks()
      expect(restarted.tabs.get().some((tab) => tab.id === created.id)).toBe(false)
      restarted.dispose()
    } finally {
      delete globals.localStorage
    }
  })

  it('deduplicates identical activity mirrored by multiple backend sockets', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('run-duplicate') }
    const message = {
      source: 'peer',
      kind: 'event',
      event: {
        kind: 'activity', execution: ref, timestamp: 42,
        activity: { kind: 'cache_miss', nodeId: 'node-1', reason: 'first-seen' },
      },
    }
    left.postMessage(message)
    left.postMessage({ ...message, source: 'other-peer' })
    expect(app.store.get(ref)?.activities).toHaveLength(1)
  })
})

describe('advancement plans survive workspace-authority promotion', () => {
  // Promotion swaps every live tab's store for a SharedWorker-backed session
  // that adopts the same document. Plans captured against the pre-promotion
  // store (queued run completions, in-flight combo refreshes) must land in
  // the promoted session instead of silently dropping.
  const seedSchema: NodeSchema = {
    type: 'SeedTest', displayName: 'Seed Test', category: 'test', source: 'v3', isOutputNode: true,
    body: [
      { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' } },
      { kind: 'input', id: 'up', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: { min: 10, max: 20, step: 3 }, default: 10, controller: 'after_generate' } },
      { kind: 'input', id: 'down', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: { step: 2 }, default: 10, controller: 'after_generate' } },
    ],
  }
  const resolveSeed = (type: string) => (type === seedSchema.type ? seedSchema : undefined)
  const seedFixture = () => ({
    format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'promotion-seed-test', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {
      seed: { id: 'seed', type: 'SeedTest', values: { up: 11, down: 11 },
        controllers: { up: 'increment', down: 'decrement' } },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {} } } },
  })

  it('advances run-completion controllers in the promoted session', async () => {
    const factory = authorityFactories()
    const app = createEditableApp()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'promotion-test' })
    app.registerSchemas([seedSchema])
    expect((await app.openDocument(seedFixture(), 'Promotion Seed'))).toEqual([])
    const tab = app.activeTab()!
    const result = compile({
      document: tab.store.doc, revision: 0, resolve: resolveSeed, scope: { kind: 'full' },
      connection: asConnectionId('local'), schemaHash: 'test',
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('promotion-run') }
    app.registerRun(tab, ref, result.artifact, 1)

    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    await drainTasks()
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    expect(promoted.store).not.toBe(tab.store)

    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    await expect.poll(() => promoted.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 14, down: 9 })
  })

  it('preserves editor-role schema resolution in the promoted command registry', async () => {
    const compositorSchema: NodeSchema = {
      ...seedSchema,
      type: 'SyntheticCompositor',
      editorRole: 'compositor',
      body: [
        { kind: 'input', id: 'recipe', type: { kind: 'concrete', name: 'COMPOSITOR' }, optional: true,
          widget: { widgetType: 'COMPOSITOR', options: {} } },
      ],
    }
    const factory = authorityFactories()
    const app = createEditableApp()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'promotion-test' })
    app.registerSchemas([seedSchema, compositorSchema])
    const fixture = seedFixture()
    fixture.graphs.g0.nodes.seed.type = compositorSchema.type
    expect((await app.openDocument(fixture, 'Promotion Roles'))).toEqual([])
    const tab = app.activeTab()!

    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    await drainTasks()
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    const recipe = { version: 2, documentDigest: null, commands: [] }
    const result = await app.dispatchTo(promoted, {
      command: 'image.compositorApply',
      params: {
        graphId: 'g0',
        nodeId: 'seed',
        inputId: 'recipe',
        instancePath: [],
        expectedRecipeFingerprint: compositorRecipeFingerprint(undefined)!,
        recipe,
      },
    })

    expect(result.ok).toBe(true)
    expect(promoted.store.doc.graphs.g0!.nodes.seed!.values.recipe).toEqual(recipe)
  })

  it('an edit restored through the promoted session still suppresses its advancement (ABA)', async () => {
    const factory = authorityFactories()
    const app = createEditableApp()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'promotion-test' })
    app.registerSchemas([seedSchema])
    expect((await app.openDocument(seedFixture(), 'Promotion Seed'))).toEqual([])
    const tab = app.activeTab()!
    const result = compile({
      document: tab.store.doc, revision: 0, resolve: resolveSeed, scope: { kind: 'full' },
      connection: asConnectionId('local'), schemaHash: 'test',
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('promotion-aba') }
    app.registerRun(tab, ref, result.artifact, 1)

    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    await drainTasks()
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    expect(promoted.store).not.toBe(tab.store)

    // Manual edit and revert AFTER promotion: value equality would pass the
    // compare-and-set, so only continued generation tracking catches it.
    promoted.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 15 } })
    promoted.store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'seed', inputId: 'up', value: 11 } })
    await drainTasks()
    app.store.apply({ kind: 'completed', execution: ref, timestamp: 2 })
    await expect.poll(() => promoted.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 11, down: 9 })
  })

  const comboRoute = '/remote/options'
  const comboInput = (id: string) => ({
    kind: 'input' as const,
    id,
    type: { kind: 'concrete' as const, name: 'COMBO' },
    optional: false,
    widget: {
      widgetType: 'COMBO', options: {}, default: 'a', controller: 'after_refresh' as const,
      remote: { route: comboRoute, refreshButton: true, controlAfterRefresh: 'first' as const },
    },
  })
  const comboSchema: NodeSchema = {
    type: 'RefreshCombo', displayName: 'Refresh Combo', category: 'test', source: 'v3', isOutputNode: false,
    body: [comboInput('up'), comboInput('down')],
  }
  const comboFixture = () => ({
    format: 'dinkster-workflow' as const, formatVersion: 1 as const, lineage: 'promotion-combo-test', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {
      combo: {
        id: 'combo', type: 'RefreshCombo',
        values: { up: 'c', down: 'a' },
        controllers: { up: 'increment', down: 'decrement' },
      },
    }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
    view: { graphs: { g0: { nodes: {} } } },
  })

  it('applies an in-flight combo refresh to the promoted session', async () => {
    const factory = authorityFactories()
    const app = createEditableApp()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'promotion-test' })
    app.registerSchemas([comboSchema])
    expect((await app.openDocument(comboFixture(), 'Promotion Combo'))).toEqual([])
    const tab = app.activeTab()!
    const plan = app.prepareComboRefresh(tab, comboRoute)
    expect(plan).toBeDefined()

    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    await drainTasks()
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    expect(promoted.store).not.toBe(tab.store)

    await app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0.5)
    expect(promoted.store.doc.graphs.g0!.nodes.combo!.values).toEqual({ up: 'a', down: 'c' })
  })
})
