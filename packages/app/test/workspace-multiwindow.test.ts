import { describe, expect, it } from 'vitest'
import {
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asNodeId,
  asPromptId,
  compile,
  coreCommandRegistry,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, orderWorkspaceOperations } from '../src/app-state.js'
import { SharedWorkerDocumentAuthority, type WorkerPortLike } from '../src/shared-worker-authority.js'
import {
  SharedWorkerCollabConnection,
  connectSharedWorkerSession,
  type SharedWorkerPortFactory,
} from '../src/shared-worker-connection.js'
import { SharedWorkerTabAuthority } from '../src/workspace-worker-authority.js'
import type { WorkspaceWorkerPortFactory } from '../src/workspace-worker-connection.js'
import { IMAGE_EDITOR_KIND } from '../src/editors.js'

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

const sameIdPrimitive = (type: string, name: 'core.float' | 'core.boolean'): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input', id: 'value', type: { kind: 'concrete', name }, optional: false,
      ...(name === 'core.float' ? { widget: { widgetType: 'NUMBER', options: { step: 0.1 }, default: 0 } } : {}),
    },
    { kind: 'output', id: 'value', type: { kind: 'concrete', name } },
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
  it('uses one authoritative document with shared edit and undo visibility', async () => {
    const factory = authorityFactories()
    const first = new AppState()
    const second = new AppState()
    first.openDocument(workflow(), 'Shared workflow')
    second.openDocument(workflow(), 'Shared workflow')
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])
    const firstTab = first.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!
    const secondTab = second.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!

    expect(first.dispatchTo(firstTab, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Edited in first window' },
    }).ok).toBe(true)
    await (firstTab.store as unknown as { settle(): Promise<void> }).settle()
    expect(secondTab.store.doc.graphs.g0!.nodes.n1!.title).toBe('Edited in first window')
    expect(firstTab.store.undo()).toBe(true)
    await (firstTab.store as unknown as { settle(): Promise<void> }).settle()
    expect(secondTab.store.doc.graphs.g0!.nodes.n1!.title).toBeUndefined()
  })

  it('converges create, reorder, close, and persistence snapshots across windows', async () => {
    const factory = authorityFactories()
    const first = new AppState()
    const second = new AppState()
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

  it('preserves a local image editor when another window publishes tab metadata', async () => {
    const factory = authorityFactories()
    const first = new AppState()
    const second = new AppState()
    first.openDocument(workflow(), 'Shared workflow')
    second.openDocument(workflow(), 'Shared workflow')
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])
    const tab = first.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const target = {
      tabId: tab.id,
      graphId: 'g0',
      nodeId: 'n1',
      inputId: 'image',
      sourceRef: {
        digest: `blake3:${'a'.repeat(64)}`,
        name: 'source.png',
        size: 10,
        mediaType: 'image/png',
        virtualPath: '',
      },
    }
    first.imageEditorTarget.set(target)
    first.setTabEditorKind(tab.id, IMAGE_EDITOR_KIND)

    second.createWorkflow()
    await drainTasks()

    expect(first.tabs.get().find((candidate) => candidate.id === tab.id)?.editorKind).toBe(IMAGE_EDITOR_KIND)
    expect(first.imageEditorTarget.get()).toBe(target)
  })

  it('keeps a local frozen view active without publishing it as shared workspace focus', async () => {
    const factory = authorityFactories()
    const first = new AppState()
    const second = new AppState()
    first.openDocument(workflow(), 'Shared workflow')
    second.openDocument(workflow(), 'Shared workflow')
    first.registry.set(buildDinksterRegistry(asConnectionId('local'), {
      schemaVersion: 16,
      dinkster: { version: 'test', schemaWire: 16 },
      nodes: {
        X: {
          schemaVersion: 16, displayName: 'X', outputNode: true,
          interface: [{ role: 'output', id: 'out', type: { kind: 'concrete', types: ['core.int'] } }],
        },
      },
    }))
    const tab = first.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const result = first.compileTab(tab)
    if (!result?.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('frozen-local') }
    first.registerRun(tab, ref, result.artifact)

    expect(first.openExecutionView(ref)).toBe(true)
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])
    await drainTasks()

    expect(first.activeTab()?.execution).toEqual(ref)
    expect(second.activeTab()?.execution).toBeUndefined()
    expect(second.activeTabId.get()).toBe('multi-window-workflow')

    first.activeTabId.set('multi-window-workflow')
    expect(first.openExecutionView(ref)).toBe(true)
    await drainTasks()
    expect(first.activeTab()?.execution).toEqual(ref)
    expect(second.activeTabId.get()).toBe('multi-window-workflow')
  })

  it('a shared live tab whose lineage collides with a local frozen view displaces it and releases the pin', async () => {
    const factory = authorityFactories()
    const first = new AppState()
    const second = new AppState()
    first.openDocument(workflow(), 'Shared workflow')
    second.openDocument(workflow(), 'Shared workflow')
    first.registry.set(buildDinksterRegistry(asConnectionId('local'), {
      schemaVersion: 16,
      dinkster: { version: 'test', schemaWire: 16 },
      nodes: {
        X: {
          schemaVersion: 16, displayName: 'X', outputNode: true,
          interface: [{ role: 'output', id: 'out', type: { kind: 'concrete', types: ['core.int'] } }],
        },
      },
    }))
    const tab = first.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const result = first.compileTab(tab)
    if (!result?.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('frozen-collision') }
    first.registerRun(tab, ref, result.artifact)
    first.store.apply({ kind: 'completed', execution: ref, timestamp: 1 })
    expect(first.openExecutionView(ref)).toBe(true)
    const frozenId = first.tabs.get().find((candidate) => candidate.execution)!.id
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])
    await drainTasks()
    expect(first.tabs.get().filter((candidate) => candidate.id === frozenId)).toHaveLength(1)

    // Lineages are unrestricted strings, so another window can publish a live
    // document whose lineage equals the local frozen tab id.
    second.openDocument({ ...workflow(), lineage: asLineageId(frozenId) }, 'Impostor')
    await drainTasks()

    const matching = first.tabs.get().filter((candidate) => candidate.id === frozenId)
    expect(matching).toHaveLength(1) // never [live, frozen] duplicates
    expect(matching[0]!.execution).toBeUndefined()

    // The displaced frozen view released its pin: the run is evictable again.
    const base = Date.now()
    for (let i = 0; i < 201; i++) {
      const churn = { connection: asConnectionId('local'), prompt: asPromptId(`churn${i}`) }
      first.store.apply({ kind: 'started', execution: churn, timestamp: base + i })
      first.store.apply({ kind: 'completed', execution: churn, timestamp: base + i })
    }
    expect(first.store.get(ref)).toBeUndefined()
  })

  it('mirrors live execution events between window stores', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const first = new AppState({ workspaceEvents: left })
    const second = new AppState({ workspaceEvents: right })
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
    const second = new AppState({ workspaceEvents: right })
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

  it('rejects malformed worker attribution from the workspace channel', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = new AppState({ workspaceEvents: right })
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('run-hostile-worker') }

    for (const worker of ['', { name: 'render-box' }]) {
      left.postMessage({
        source: 'hostile-window',
        kind: 'event',
        event: {
          kind: 'nodeStates',
          execution: ref,
          timestamp: 42,
          nodes: { n1: { state: 'running', worker } },
        },
      })
    }

    expect(app.store.get(ref)).toBeUndefined()
  })

  it('rebuilds valid registrations and rejects malformed peer artifacts', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = new AppState({ workspaceEvents: right })
    const registry = buildDinksterRegistry(asConnectionId('local'), {
      schemaVersion: 16,
      dinkster: { version: 'test', schemaWire: 16 },
      nodes: {
        X: {
          schemaVersion: 16, displayName: 'X', outputNode: true,
          interface: [{ role: 'output', id: 'out', type: { kind: 'concrete', types: ['core.int'] } }],
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

  it('retries a registration after a same-hash reconnect registry restores graph features', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = new AppState({ workspaceEvents: right })
    const connection = asConnectionId('local')
    const schemas = new Map([
      ['dinkster.float', sameIdPrimitive('dinkster.float', 'core.float')],
      ['dinkster.boolean', sameIdPrimitive('dinkster.boolean', 'core.boolean')],
    ])
    const registry = {
      connection,
      hash: 'same-hash-region-registry',
      schemas,
      diagnostics: [],
      resolve: (type: string) => schemas.get(type),
      graphFeatures: ['regions'],
    }
    const author = new AppState()
    author.registry.set(registry)
    const tab = author.createWorkflow()
    expect(author.createRegion(tab, tab.store.doc.root, { x: 0, y: 0 }, 'map').ok).toBe(true)
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

  it('rejects impossible region expansion combinations from workspace peers', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = new AppState({ workspaceEvents: right })

    for (const [prompt, regionKind, iterations] of [
      ['run-map-null', 'map', null],
      ['run-while-counted', 'while', 1],
    ] as const) {
      const ref = { connection: asConnectionId('local'), prompt: asPromptId(prompt) }
      left.postMessage({
        source: 'hostile-window', kind: 'event',
        event: {
          kind: 'regionExpanded', execution: ref, timestamp: 42,
          runtimeNodeId: 'region', regionKind, binding: 'zip', iterations,
        },
      })
      expect(app.store.get(ref)).toBeUndefined()
    }
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
    const app = new AppState()
    app.openDocument(workflow(), 'Shared workflow')
    const tab = app.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const workspaceFactory = authorityFactories().workspace
    const promotion = app.enableWorkspaceAuthority(factory, workspaceFactory)
    expect(app.dispatchTo(tab, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Kept locally' },
    }).ok).toBe(true)
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
    const app = new AppState()
    app.openDocument(workflow(), 'Shared workflow')
    const tab = app.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const workspaceFactory = authorityFactories().workspace
    const promotion = app.enableWorkspaceAuthority(factory, workspaceFactory)
    expect(app.dispatchTo(tab, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Edited before promotion' },
    }).ok).toBe(true)
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
    const app = new AppState()
    app.openDocument(workflow(), 'Shared workflow')
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
    expect(app.dispatchTo(replaced, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Edited after replacement' },
    }).ok).toBe(true)
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
    const app = new AppState()
    app.openDocument(workflow(), 'Shared workflow')
    await app.enableWorkspaceAuthority(documentFactory, tabFactory)
    const replacement: WorkflowDocument = {
      ...workflow(),
      graphs: { ...workflow().graphs, g0: { ...workflow().graphs.g0!, name: 'replacement' } },
    }

    documentWorkers[0]!.paused = true
    try {
      expect(app.openDocument(replacement, 'Reopened replacement')).toEqual([])
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
    const app = new AppState()
    app.openDocument(workflow(), 'Shared workflow')
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
      const first = new AppState({ defaultProtocol: 'dinkster' })
      first.flushPersistTabs()
      await first.enableWorkspaceAuthority(firstFactory.document, firstFactory.workspace)
      const created = first.createWorkflow()
      first.dispose()
      await drainTasks()

      const secondFactory = authorityFactories()
      const second = new AppState({ defaultProtocol: 'dinkster' })
      await second.enableWorkspaceAuthority(secondFactory.document, secondFactory.workspace)
      await drainTasks()
      expect(second.tabs.get().some((tab) => tab.id === created.id)).toBe(true)
      second.flushPersistTabs()

      second.closeTab(created.id)
      second.dispose()
      await drainTasks()

      const thirdFactory = authorityFactories()
      const third = new AppState({ defaultProtocol: 'dinkster' })
      await third.enableWorkspaceAuthority(thirdFactory.document, thirdFactory.workspace)
      await drainTasks()
      expect(third.tabs.get().some((tab) => tab.id === created.id)).toBe(false)
      third.dispose()
    } finally {
      delete globals.localStorage
    }
  })

  it('persists every tab at its committed document revision regardless of tab position', async () => {
    const globals = globalThis as { localStorage?: Storage }
    globals.localStorage = memoryStorage()
    try {
      const factory = authorityFactories()
      const app = new AppState({ defaultProtocol: 'dinkster' })
      app.flushPersistTabs()
      await app.enableWorkspaceAuthority(factory.document, factory.workspace)
      app.createWorkflow()
      app.createWorkflow()
      await drainTasks()
      app.flushPersistTabs(true)
      await drainTasks()
      const persisted = JSON.parse(globals.localStorage.getItem('dinkster.openTabs')!) as {
        tabs: ReadonlyArray<{ documentRevision?: number }>
      }
      expect(persisted.tabs.length).toBeGreaterThan(1)
      // Pristine documents commit at revision 0 at EVERY index: a snapshot
      // must never stamp a tab's array position as its document revision.
      for (const tab of persisted.tabs) expect(tab.documentRevision ?? 0).toBe(0)
      app.dispose()
      await drainTasks()
    } finally {
      delete globals.localStorage
    }
  })

  it('replays outstanding same-window operations in causal order', async () => {
    const globals = globalThis as { localStorage?: Storage }
    globals.localStorage = memoryStorage(true)
    try {
      const firstFactory = authorityFactories()
      const first = new AppState({ defaultProtocol: 'dinkster' })
      first.flushPersistTabs()
      await first.enableWorkspaceAuthority(firstFactory.document, firstFactory.workspace)
      const created = first.createWorkflow()
      first.closeTab(created.id)
      first.dispose()
      await drainTasks()

      const restartedFactory = authorityFactories()
      const restarted = new AppState({ defaultProtocol: 'dinkster' })
      await restarted.enableWorkspaceAuthority(restartedFactory.document, restartedFactory.workspace)
      await drainTasks()
      expect(restarted.tabs.get().some((tab) => tab.id === created.id)).toBe(false)
      restarted.dispose()
    } finally {
      delete globals.localStorage
    }
  })

  it('keeps same-actor causality around retained operations from another window', () => {
    const makeOperation = (
      opId: string,
      actorId: string,
      sequence: number,
      baseRevision: number,
    ) => ({
      opId,
      actorId,
      sequence,
      baseRevision,
      additions: [],
      removals: [],
      updates: [],
      order: [],
      active: '',
    })
    const create = makeOperation('create', 'actor-a', 0, 10)
    const close = makeOperation('close', 'actor-a', 1, 10)
    const retained = makeOperation('retained', 'actor-c', 0, 5)

    expect(orderWorkspaceOperations([close, retained, create]).map((operation) => operation.opId))
      .toEqual(['retained', 'create', 'close'])
  })

  it('deduplicates identical activity mirrored by multiple backend sockets', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = new AppState({ workspaceEvents: right })
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
    items: [
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

  it('keeps controller planning provenance out of mirrored run registrations', () => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const first = new AppState({ workspaceEvents: left })
    const second = new AppState({ workspaceEvents: right })
    expect(first.openDocument(seedFixture(), 'Workspace Seed')).toEqual([])
    const tab = first.activeTab()!
    const schemas = new Map([[seedSchema.type, seedSchema]])
    second.registry.set({
      connection: asConnectionId('local'),
      schemas,
      diagnostics: [],
      resolve: resolveSeed,
      hash: 'test',
    })
    const result = compile({
      document: tab.store.doc, revision: 0, resolve: resolveSeed, scope: { kind: 'full' },
      connection: asConnectionId('local'), schemaHash: 'test',
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    expect(result.artifact.provenance.controllerInputs).toHaveLength(2)
    const artifact = { ...result.artifact, futureCompileMetadata: 'local-only' }
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('mirrored-controller-run') }

    first.registerRun(tab, ref, artifact, 1)

    expect(first.store.get(ref)?.artifact).toBe(artifact)
    const posted = left.sent.find((message) => isRecord(message) && message['kind'] === 'register')
    expect(posted).toBeDefined()
    const postedArtifact = isRecord(posted) && isRecord(posted['artifact']) ? posted['artifact'] : undefined
    const postedProvenance = isRecord(postedArtifact?.['provenance']) ? postedArtifact['provenance'] : undefined
    expect(postedProvenance).toBeDefined()
    expect(postedProvenance).not.toHaveProperty('controllerInputs')
    expect(postedArtifact).not.toHaveProperty('futureCompileMetadata')
    expect(second.store.get(ref)?.artifact?.provenance.controllerInputs).toBeUndefined()
    expect(second.store.get(ref)?.artifact?.semanticHash).toBe(result.artifact.semanticHash)

    const oldRef = { connection: asConnectionId('local'), prompt: asPromptId('old-full-controller-run') }
    left.postMessage({ source: 'old-window', kind: 'register', ref: oldRef, artifact })
    expect(second.store.get(oldRef)?.artifact?.semanticHash).toBe(result.artifact.semanticHash)
    expect(second.store.get(oldRef)?.artifact?.provenance.controllerInputs).toBeUndefined()
    expect(second.store.get(oldRef)?.artifact).not.toHaveProperty('futureCompileMetadata')

    const nestedRef = { connection: asConnectionId('local'), prompt: asPromptId('nested-future-run') }
    left.postMessage({
      source: 'future-window',
      kind: 'register',
      ref: nestedRef,
      artifact: {
        ...artifact,
        scope: {
          kind: 'full',
          controllerInputs: [{ ownerPriority: 99 }],
          ownerPriority: 99,
          futureScopeMetadata: true,
        },
      },
    })
    expect(second.store.get(nestedRef)?.artifact?.scope).toEqual({ kind: 'full' })

    const partialRef = { connection: asConnectionId('local'), prompt: asPromptId('nested-partial-run') }
    const partial = compile({
      document: tab.store.doc,
      revision: 0,
      resolve: resolveSeed,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('seed') }] },
      connection: asConnectionId('local'),
      schemaHash: 'test',
    })
    if (!partial.ok) throw new Error(JSON.stringify(partial.diagnostics))
    left.postMessage({
      source: 'future-window',
      kind: 'register',
      ref: partialRef,
      artifact: {
        ...partial.artifact,
        scope: {
          kind: 'partial',
          targets: [{ instancePath: [], node: 'seed', ownerPriority: 99 }],
          futureScopeMetadata: true,
        },
      },
    })
    expect(second.store.get(partialRef)?.artifact?.scope).toEqual({
      kind: 'partial', targets: [{ instancePath: [], node: 'seed' }],
    })

    const nestedIncompleteRef = { connection: asConnectionId('local'), prompt: asPromptId('nested-incomplete-run') }
    left.postMessage({
      source: 'future-window', kind: 'register', ref: nestedIncompleteRef, artifact: { ...artifact, scope: {} },
    })
    expect(second.store.get(nestedIncompleteRef)).toBeUndefined()

    const invalidTargetRef = { connection: asConnectionId('local'), prompt: asPromptId('invalid-target-run') }
    left.postMessage({
      source: 'future-window', kind: 'register', ref: invalidTargetRef,
      artifact: { ...artifact, scope: { kind: 'partial', targets: [{ node: 'seed' }] } },
    })
    expect(second.store.get(invalidTargetRef)).toBeUndefined()

    const sparsePathRef = { connection: asConnectionId('local'), prompt: asPromptId('sparse-path-run') }
    left.postMessage({
      source: 'future-window', kind: 'register', ref: sparsePathRef,
      artifact: {
        ...artifact,
        scope: { kind: 'partial', targets: [{ node: 'seed', instancePath: new Array<string>(1) }] },
      },
    })
    expect(second.store.get(sparsePathRef)).toBeUndefined()

    const sparseTargetsRef = { connection: asConnectionId('local'), prompt: asPromptId('sparse-targets-run') }
    left.postMessage({
      source: 'future-window', kind: 'register', ref: sparseTargetsRef,
      artifact: { ...artifact, scope: { kind: 'partial', targets: new Array(1) } },
    })
    expect(second.store.get(sparseTargetsRef)).toBeUndefined()

    const futureRef = { connection: asConnectionId('local'), prompt: asPromptId('incomplete-future-run') }
    left.postMessage({ source: 'future-window', kind: 'register', ref: futureRef, artifact: { revision: 1 } })
    expect(second.store.get(futureRef)).toBeUndefined()
  })

  it('advances run-completion controllers in the promoted session', async () => {
    const factory = authorityFactories()
    const app = new AppState()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'promotion-test' })
    app.registerSchemas([seedSchema])
    expect(app.openDocument(seedFixture(), 'Promotion Seed')).toEqual([])
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
    expect(promoted.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 14, down: 9 })
  })

  it('an edit restored through the promoted session still suppresses its advancement (ABA)', async () => {
    const factory = authorityFactories()
    const app = new AppState()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'promotion-test' })
    app.registerSchemas([seedSchema])
    expect(app.openDocument(seedFixture(), 'Promotion Seed')).toEqual([])
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
    expect(promoted.store.doc.graphs.g0!.nodes.seed!.values).toMatchObject({ up: 11, down: 9 })
  })

  const comboRoute = '/remote/options'
  const comboInput = (id: string) => ({
    kind: 'input' as const,
    id,
    type: { kind: 'concrete' as const, name: 'core.combo' },
    optional: false,
    widget: {
      widgetType: 'COMBO', options: {}, default: 'a', controller: 'after_refresh' as const,
      remote: { route: comboRoute, refreshButton: true, controlAfterRefresh: 'first' as const },
    },
  })
  const comboSchema: NodeSchema = {
    type: 'RefreshCombo', displayName: 'Refresh Combo', category: 'test', source: 'v3', isOutputNode: false,
    items: [comboInput('up'), comboInput('down')],
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
    const app = new AppState()
    ;(app.registry as unknown as { set(value: unknown): void }).set({ schemas: new Map(), resolve: () => undefined, hash: 'promotion-test' })
    app.registerSchemas([comboSchema])
    expect(app.openDocument(comboFixture(), 'Promotion Combo')).toEqual([])
    const tab = app.activeTab()!
    const plan = app.prepareComboRefresh(tab, comboRoute)
    expect(plan).toBeDefined()

    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    await drainTasks()
    const promoted = app.tabs.get().find((candidate) => candidate.id === tab.id)!
    expect(promoted.store).not.toBe(tab.store)

    app.completeComboRefresh(plan, ['a', 'b', 'c'], () => 0.5)
    expect(promoted.store.doc.graphs.g0!.nodes.combo!.values).toEqual({ up: 'a', down: 'c' })
  })
})
