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
import { DinksterConnection, buildDinksterRegistry, type RetainedAssets } from '@dinkster/client'
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
  vi.spyOn(DinksterConnection.prototype, 'retainAssets').mockImplementation(async (owner, declaration) =>
    ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
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

  it('keeps a reused source receipt live when an older canonical admission publishes first', async () => {
    let commits = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: LockOptions, callback: () => unknown) => {
      const next = commits.then(callback)
      commits = next.catch(() => undefined)
      return next
    } } })
    const events = new EventTarget()
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
    const app = createEditableApp()
    app.registerSchemas([primitive('X', 'FLOAT')])
    const local = app.tabs.get()[0]!
    const peer = { v: 1, active: local.id, workspaceRevision: 1, incorporatedWorkspaceStages: [], tabs: [
      { title: local.title, doc: local.store.doc, documentRevision: 0 },
      { title: 'Peer workflow', doc: workflow(), documentRevision: 0 },
    ], assetRetention: { stageId: 'peer-stage', acknowledged: true, complete: true, owners: [local.store.doc, workflow()].map((doc) => ({
      connectionId: app.connection.id, assetBaseUrl: app.connection.assetUrl(''), documentLineage: doc.lineage,
      retained: { scope: 'local', ownerKind: 'document', ownerId: `peer-${doc.lineage}`, revision: 1, complete: true, digests: [] },
    })) } }
    const canonical = JSON.stringify(peer)
    localStorage.setItem('dinkster.openTabs', canonical)
    const receipts = new Map<string, RetainedAssets>()
    const held: { readonly receipt: RetainedAssets; readonly finish: () => void }[] = []
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const receipt = { ...owner, ...declaration, revision: 1 }
      receipts.set(owner.ownerId, receipt)
      await new Promise<void>((finish) => held.push({ receipt, finish }))
      return receipt
    })
    vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
      const receipt = { ...receipts.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
      receipts.set(owner.ownerId, receipt)
      return receipt
    })
    app.flushPersistTabs(true)
    await drainTasks()
    expect(held).toHaveLength(3)
    expect(localStorage.getItem('dinkster.openTabs')).toBe(canonical)
    const source = held[0]!
    source.finish()
    await drainTasks()
    const sourceKey = [...Array(localStorage.length)].map((_, index) => localStorage.key(index)!)
      .find((key) => key.startsWith('dinkster.openTabsCandidate.'))!
    expect(JSON.parse(localStorage.getItem(sourceKey)!).assetRetention).toMatchObject({ acknowledged: true, complete: true })
    app.tabs.set([...app.tabs.get()])
    events.dispatchEvent(Object.assign(new Event('storage'), { key: 'dinkster.openTabs', newValue: canonical }))
    await drainTasks()
    expect(held).toHaveLength(4)
    held[1]!.finish()
    held[2]!.finish()
    await drainTasks()
    expect(localStorage.getItem(sourceKey)).toBeNull()
    expect(receipts.get(source.receipt.ownerId)).toEqual(source.receipt)
    held[3]!.finish()
    await drainTasks()
    expect(receipts.get(source.receipt.ownerId)).toEqual(source.receipt)
    expect(localStorage.getItem('dinkster.openTabs')).toBe(canonical)
  })

  it('keeps a quota-blocked edit in memory, reports recovery failure, and saves it on retry', async () => {
    let commits = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: LockOptions, callback: () => unknown) => {
      const next = commits.then(callback)
      commits = next.catch(() => undefined)
      return next
    } } })
    const app = createEditableApp()
    app.registerSchemas([primitive('X', 'FLOAT')])
    await app.openDocument(workflow(), 'Quota workflow')
    app.flushPersistTabs(true)
    await drainTasks()
    const original = localStorage.getItem('dinkster.openTabs')!
    const tab = app.tabs.get().find((open) => open.id === 'multi-window-workflow')!
    const title = `Unsaved edit ${'x'.repeat(4096)}`
    expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title,
    } })).ok).toBe(true)
    const size = (): number => [...Array(localStorage.length)].reduce((sum, _, index) => {
      const key = localStorage.key(index)!
      return sum + key.length + localStorage.getItem(key)!.length
    }, 0)
    let capacity = size() + 128
    const write = localStorage.setItem.bind(localStorage)
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      const previous = localStorage.getItem(key)
      const next = size() - (previous === null ? 0 : key.length + previous.length) + key.length + value.length
      if (next > capacity) throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      write(key, value)
    })
    for (let attempt = 0; attempt < 2; attempt += 1) {
      app.flushPersistTabs(true)
      await drainTasks()
      expect(localStorage.getItem('dinkster.openTabs')).toBe(original)
      expect(tab.store.doc.graphs.g0!.nodes.n1!.title).toBe(title)
      expect(app.problems.get().some((problem) => problem.code === 'workspace.recovery.storageFailed')).toBe(true)
    }
    capacity = Infinity
    const acknowledgments: (() => void)[] = []
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      await new Promise<void>((resolve) => acknowledgments.push(resolve))
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    app.flushPersistTabs(true)
    await drainTasks()
    expect(acknowledgments.length).toBeGreaterThan(0)
    expect(app.problems.get().some((problem) => problem.code === 'workspace.recovery.storageFailed')).toBe(true)
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) =>
      ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
    for (const acknowledge of acknowledgments) acknowledge()
    await drainTasks()
    const saved = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
    expect(saved.assetRetention).toMatchObject({ acknowledged: true, complete: true })
    expect(saved.tabs.find((entry: { doc: WorkflowDocument }) => entry.doc.lineage === tab.id).doc).toEqual(tab.store.doc)
    expect(app.problems.get().some((problem) => problem.code === 'workspace.recovery.storageFailed')).toBe(false)
  })

  it('keeps settled unchanged document ownership stable across persistence flushes', async () => {
    let commits = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (
      _name: string, _options: LockOptions, callback: () => unknown,
    ) => {
      const next = commits.then(callback)
      commits = next.catch(() => undefined)
      return next
    } } })
    const app = createEditableApp()
    const schema = primitive('X', 'FLOAT')
    app.registry.set({ connection: app.connection.id, schemas: new Map([['X', schema]]),
      diagnostics: [], hash: 'stable-ownership', resolve: (type) => type === 'X' ? schema : undefined })
    expect(await app.openDocument(workflow(), 'Unchanged workflow')).toEqual([])
    const factory = authorityFactories()
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    app.flushPersistTabs(true)
    await drainTasks()
    const intents = () => [...Array(localStorage.length)].map((_, index) => localStorage.key(index)!)
      .filter((key) => key.startsWith('dinkster.workflow-retentions.'))
      .map((key) => JSON.parse(localStorage.getItem(key)!))
      .filter((intent) => intent.documentLineage === 'multi-window-workflow')
      .map((intent) => intent.owner.ownerId).sort()
    const settled = intents()
    expect(settled.length).toBeGreaterThan(0)
    const canonical = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
    expect(canonical.assetRetention).toMatchObject({ acknowledged: true, complete: true })
    for (let repeat = 0; repeat < 12; repeat += 1) {
      app.flushPersistTabs(true)
      await drainTasks()
    }
    expect(intents()).toEqual(settled)
    expect(app.tabs.get().find((tab) => tab.id === 'multi-window-workflow')?.store.doc).toEqual(workflow())
    expect(JSON.parse(localStorage.getItem('dinkster.openTabs')!).assetRetention)
      .toMatchObject({ acknowledged: true, complete: true })
  })

  it.each(['covered', 'newer-document'] as const)('Close reuses unchanged surviving ownership without losing recovery: %s', async (scenario) => {
    let commits = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: LockOptions, callback: () => unknown) => {
      const next = commits.then(callback)
      commits = next.catch(() => undefined)
      return next
    } } })
    const app = createEditableApp()
    const schema = primitive('X', 'FLOAT')
    app.registry.set({ connection: app.connection.id, schemas: new Map([['X', schema]]),
      diagnostics: [], hash: 'close-unchanged', resolve: (type) => type === 'X' ? schema : undefined })
    await app.openDocument(workflow(), 'Closing workflow')
    const factory = authorityFactories()
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    const tab = app.tabs.get().find((open) => open.id === 'multi-window-workflow')!
    expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title: 'Admitted before close',
    } })).ok).toBe(true)
    app.flushPersistTabs(true)
    await drainTasks()
    const key = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(tab.id)}`
    const candidate = JSON.parse(localStorage.getItem(key)!)
    expect(candidate.assetRetention).toMatchObject({ acknowledged: true, complete: true })
    if (scenario === 'newer-document') {
      candidate.tab.doc.graphs.g0.nodes.n1.title = 'Independent newer recovery'
      localStorage.setItem(key, JSON.stringify(candidate))
    }
    const puts: string[] = []
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner) => {
      puts.push(owner.ownerId)
      throw new Error('No new ownership should be needed')
    })
    expect(app.requestCloseTab(tab.id, () => true)).toBe(true)
    await drainTasks()
    app.flushPersistTabs(true)
    await drainTasks()
    expect(puts).toEqual([])
    expect(app.tabs.get().some((open) => open.id === tab.id)).toBe(false)
    const canonical = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
    expect(canonical.assetRetention).toMatchObject({ acknowledged: true, complete: true })
    expect(canonical.tabs.map((saved: { doc: WorkflowDocument }) => saved.doc))
      .toEqual(app.tabs.get().filter((open) => !open.execution).map((open) => open.store.doc))
    if (scenario === 'covered') expect(localStorage.getItem(key)).toBeNull()
    else expect(localStorage.getItem(key)).toBe(JSON.stringify(candidate))
  })

  it.each([false, true])('does not admit unchanged documents for newer peer metadata, document revision=%s', async (advanceRevision) => {
    let commits = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: LockOptions, callback: () => unknown) => {
      const next = commits.then(callback)
      commits = next.catch(() => undefined)
      return next
    } } })
    const events = new EventTarget()
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
    const app = createEditableApp()
    app.flushPersistTabs(true)
    await drainTasks()
    const initial = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
    const puts: string[] = []
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner) => {
      puts.push(owner.ownerId)
      throw new Error('Unchanged roots must reuse their admission')
    })
    const key = 'dinkster.openTabsCandidate.peer'
    for (let revision = 1; revision <= 3; revision += 1) {
      const peer = { ...initial, workspaceRevision: (initial.workspaceRevision ?? 0) + revision,
        tabs: initial.tabs.map((tab: { title: string; documentRevision?: number }) => ({ ...tab, title: `Peer title ${revision}`,
          ...(advanceRevision ? { documentRevision: (tab.documentRevision ?? 0) + revision } : {}),
        })),
      }
      localStorage.setItem(key, JSON.stringify(peer))
      for (let repeat = 0; repeat < 3; repeat += 1) events.dispatchEvent(Object.assign(new Event('storage'), {
        key, newValue: localStorage.getItem(key),
      }))
      await drainTasks()
      const committed = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
      expect(committed.workspaceRevision).toBe(peer.workspaceRevision)
      expect(committed.tabs).toEqual(peer.tabs)
      expect(committed.assetRetention).toMatchObject({ acknowledged: true, complete: true })
      expect(localStorage.getItem(key)).toBeNull()
    }
    expect(puts).toEqual([])
  })

  it.each(['unchanged', 'newer'] as const)('duplicate notifications do not block admission or replace newer data: %s', async (scenario) => {
    let lock = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: () => unknown) => {
      const next = lock.then(callback)
      lock = next.catch(() => undefined)
      return next
    } } })
    const events = new EventTarget()
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
    const app = createEditableApp()
    const document = workflow()
    await app.openDocument({ ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {} } } }, 'Admission')
    app.flushPersistTabs(true)
    await drainTasks()
    const saved = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
    expect(saved.assetRetention.acknowledged).toBe(true)
    const releases: Array<() => void> = []
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      await new Promise<void>((resolve) => releases.push(resolve))
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    const key = 'dinkster.openTabsCandidate.peer'
    const peer = { ...saved, workspaceRevision: (saved.workspaceRevision ?? 0) + 1,
      tabs: saved.tabs.map((tab: { doc: WorkflowDocument; documentRevision?: number }) => ({ ...tab,
        documentRevision: (tab.documentRevision ?? 0) + 1, doc: { ...tab.doc,
          graphs: { ...tab.doc.graphs, [tab.doc.root]: { ...tab.doc.graphs[tab.doc.root], name: 'Changed document' } },
        },
      })),
    }
    localStorage.setItem(key, JSON.stringify(peer))
    const notify = (): void => { events.dispatchEvent(Object.assign(new Event('storage'), {
      key, newValue: localStorage.getItem(key),
    })) }
    notify()
    await drainTasks()
    const first = releases.splice(0)
    expect(JSON.parse(localStorage.getItem('dinkster.openTabs')!).assetRetention.acknowledged).toBe(false)
    if (scenario === 'newer') localStorage.setItem(key, JSON.stringify({ ...peer,
      workspaceRevision: peer.workspaceRevision + 1,
      tabs: peer.tabs.map((tab: { title: string }) => ({ ...tab, title: 'Newer peer snapshot' })),
    }))
    const intents = (): string[] => [...Array(localStorage.length)].map((_, index) => localStorage.key(index)!)
      .filter((entry) => entry.startsWith('dinkster.workflow-retentions.')).sort()
    const pendingIntents = intents()
    for (let repeat = 0; repeat < 12; repeat += 1) {
      notify()
      await drainTasks()
    }
    if (scenario === 'unchanged') expect(intents()).toEqual(pendingIntents)
    for (const release of first) release()
    await drainTasks()
    try {
      const committed = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
      if (scenario === 'unchanged') {
        expect(committed.assetRetention.acknowledged).toBe(true)
        expect(committed.assetRetention.complete).toBe(true)
        expect(localStorage.getItem(key)).toBeNull()
      } else {
        expect(committed.workspaceRevision).toBe(peer.workspaceRevision + 1)
        expect(committed.tabs.every((tab: { title: string }) => tab.title === 'Newer peer snapshot')).toBe(true)
        expect(committed.assetRetention.acknowledged).toBe(false)
        expect(localStorage.getItem(key)).not.toBeNull()
      }
    } finally {
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) =>
        ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
      for (const release of releases) release()
      await drainTasks()
    }
    expect(JSON.parse(localStorage.getItem('dinkster.openTabs')!).assetRetention.complete).toBe(true)
    expect(localStorage.getItem(key)).toBeNull()
  })

  it('a complete renderer retries when an identical incomplete canonical admission publishes first', async () => {
    let lock = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: () => unknown) => {
      const next = lock.then(callback)
      lock = next.catch(() => undefined)
      return next
    } } })
    const events = new EventTarget()
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
    const incomplete = createEditableApp()
    const complete = createEditableApp()
    complete.registerSchemas([primitive('X', 'FLOAT')])
    await incomplete.openDocument(workflow(), 'Incomplete schema')
    incomplete.flushPersistTabs(true)
    await drainTasks()
    const saved = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
    const held: Array<Array<() => void>> = [[], []]
    for (const [index, app] of [incomplete, complete].entries()) {
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        await new Promise<void>((resolve) => held[index]!.push(resolve))
        return { ...owner, ...declaration, revision: declaration.revision + 1 }
      })
    }
    const key = 'dinkster.openTabsCandidate.peer'
    const peer = JSON.stringify({ ...saved, workspaceRevision: (saved.workspaceRevision ?? 0) + 1 })
    localStorage.setItem(key, peer)
    events.dispatchEvent(Object.assign(new Event('storage'), { key, newValue: peer }))
    await drainTasks()
    expect(JSON.parse(localStorage.getItem('dinkster.openTabs')!).assetRetention.acknowledged).toBe(false)
    for (const release of held[0]!) release()
    await drainTasks()
    expect(JSON.parse(localStorage.getItem('dinkster.openTabs')!).assetRetention).toMatchObject({
      acknowledged: true, complete: false,
    })
    vi.mocked(complete.connection.retainAssets).mockImplementation(async (owner, declaration) =>
      ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
    for (const release of held[1]!) release()
    await drainTasks()
    expect(JSON.parse(localStorage.getItem('dinkster.openTabs')!).assetRetention).toMatchObject({
      acknowledged: true, complete: true,
    })
    expect(localStorage.getItem(key)).toBeNull()
  })

  it.each(['promoted', 'publication-close'] as const)('retires incoming-tab admission after %s without releasing an independent holder', async (scenario) => {
    let lock = Promise.resolve()
    vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: () => unknown) => {
      const next = lock.then(callback)
      lock = next.then(() => undefined, () => undefined)
      return next
    } } })
    const factory = authorityFactories()
    const author = createEditableApp()
    const viewer = createEditableApp()
    const independentApp = createEditableApp()
    const digest = `blake3:${'a'.repeat(64)}`
    const schema: NodeSchema = { type: 'X', displayName: 'X', category: 'test', source: 'v3', isOutputNode: false,
      body: [{ kind: 'input', id: 'held', optional: false,
        type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } }] }
    author.registerSchemas([schema])
    viewer.registerSchemas([schema])
    independentApp.registerSchemas([schema])
    const receipts = new Map<string, RetainedAssets>()
    const independentOwners = new Set<string>()
    const viewerOwners = new Set<string>()
    for (const app of [author, viewer, independentApp]) {
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        const receipt = { ...owner, ...declaration, revision: 1 }
        receipts.set(owner.ownerId, receipt)
        if (app === viewer) viewerOwners.add(owner.ownerId)
        if (app === independentApp) independentOwners.add(owner.ownerId)
        return receipt
      })
      vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        const receipt = { ...receipts.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
        receipts.set(owner.ownerId, receipt)
        return receipt
      })
      vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => receipts.get(owner.ownerId))
    }
    await author.enableWorkspaceAuthority(factory.document, factory.workspace)
    await viewer.enableWorkspaceAuthority(factory.document, factory.workspace)
    await vi.waitFor(() => expect([author, viewer].every((app) => app.tabs.get().every((tab) => 'status' in tab.store))).toBe(true))
    const document = workflow()
    let closed = false
    const unsubscribe = viewer.tabs.subscribe((tabs) => {
      if (scenario === 'publication-close' && !closed && tabs.some((tab) => tab.id === document.lineage)) {
        closed = true
        expect(viewer.requestCloseTab(document.lineage, () => true)).toBe(true)
      }
    })
    await author.openDocument({ ...document, graphs: { g0: { ...document.graphs.g0!, nodes: {
      n1: { ...document.graphs.g0!.nodes.n1!, values: { held: {
        digest, name: 'held.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '',
      } } },
    } } } }, 'Retained incoming workflow')
    await independentApp.openDocument({ ...author.activeTab()!.store.doc, lineage: asLineageId('independent-window') }, 'Independent holder')
    const independent = [...independentOwners].map((id) => receipts.get(id)!).filter((receipt) => receipt.digests.includes(digest))
    expect(independent.length).toBeGreaterThan(0)
    if (scenario === 'promoted') {
      await vi.waitFor(() => expect(viewer.tabs.get().some((tab) => tab.id === document.lineage && 'status' in tab.store)).toBe(true))
      expect([...viewerOwners].some((id) => receipts.get(id)?.digests.includes(digest))).toBe(true)
      expect(viewer.requestCloseTab(document.lineage, () => true)).toBe(true)
    } else await vi.waitFor(() => expect(closed).toBe(true))
    unsubscribe()
    await vi.waitFor(() => expect(author.tabs.get().some((tab) => tab.id === document.lineage)).toBe(false))
    await vi.waitFor(() => expect([...viewerOwners].filter((id) => receipts.get(id)?.digests.includes(digest))).toEqual([]))
    expect(independentApp.tabs.get().some((tab) => tab.id === 'independent-window')).toBe(true)
    for (const receipt of independent) expect(receipts.get(receipt.ownerId)).toEqual(receipt)
  })

  it.each(['settled', 'before-persistence', 'document-observer', 'local-retry'] as const)(
    'retires remote-edit owners after close from %s without releasing an independent workflow', async (scenario) => {
      let lock = Promise.resolve()
      vi.stubGlobal('navigator', { locks: { request: (_name: string, _options: unknown, callback: () => unknown) => {
        const next = lock.then(callback)
        lock = next.then(() => undefined, () => undefined)
        return next
      } } })
      const factory = authorityFactories()
      const author = createEditableApp()
      const viewer = createEditableApp()
      const independentApp = createEditableApp()
      const digest = `blake3:${'b'.repeat(64)}`
      const asset = { digest, name: 'remote.bin', size: 13, mediaType: 'application/octet-stream', virtualPath: '' }
      const schema: NodeSchema = { type: 'X', displayName: 'X', category: 'test', source: 'v3', isOutputNode: false,
        body: [{ kind: 'input', id: 'held', optional: true,
          type: { kind: 'asset', element: { kind: 'concrete', name: 'DATA' } } }] }
      const receipts = new Map<string, RetainedAssets>()
      const viewerOwners = new Set<string>()
      const independentOwners = new Set<string>()
      let holdConfirmations = scenario === 'local-retry'
      const confirmations: { retained: RetainedAssets; acknowledge: () => void }[] = []
      for (const app of [author, viewer, independentApp]) {
        app.registerSchemas([schema])
        vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
          const retained = { ...owner, ...declaration, revision: 1 }
          receipts.set(owner.ownerId, retained)
          if (app === viewer) viewerOwners.add(owner.ownerId)
          if (app === independentApp) independentOwners.add(owner.ownerId)
          if (app === viewer && holdConfirmations && declaration.digests.includes(digest)) {
            await new Promise<void>((resolve) => { confirmations.push({ retained, acknowledge: resolve }) })
          }
          return retained
        })
        vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
          const retained = { ...receipts.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
          receipts.set(owner.ownerId, retained)
          return retained
        })
        vi.spyOn(app.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => receipts.get(owner.ownerId))
      }
      const document = workflow()
      await author.openDocument(document, 'Author')
      await viewer.openDocument(document, 'Viewer')
      await author.enableWorkspaceAuthority(factory.document, factory.workspace)
      await viewer.enableWorkspaceAuthority(factory.document, factory.workspace)
      await independentApp.openDocument({ ...document, lineage: asLineageId('independent-remote-edit'), graphs: {
        g0: { ...document.graphs.g0!, nodes: { n1: { ...document.graphs.g0!.nodes.n1!, values: { held: asset } } } },
      } }, 'Independent workflow')
      const independent = [...independentOwners].map((id) => receipts.get(id)!).filter((receipt) => receipt.digests.includes(digest))
      expect(independent.length).toBeGreaterThan(0)
      let closed = false
      const received = viewer.tabs.get().find((tab) => tab.id === document.lineage)!
      const stop = received.store.document.subscribe((incoming) => {
        if (scenario === 'document-observer' && !closed && incoming.graphs.g0!.nodes.n1!.values.held !== undefined) {
          closed = viewer.requestCloseTab(document.lineage, () => true)
        }
      })
      const authorTab = author.tabs.get().find((tab) => tab.id === document.lineage)!
      expect((await author.dispatchRetainedTo(authorTab, { command: 'node.setValue', params: {
        graphId: 'g0', nodeId: 'n1', inputId: 'held', value: asset,
      } })).ok).toBe(true)
      await (authorTab.store as unknown as { settle(): Promise<void> }).settle()
      if (scenario === 'local-retry') {
        await vi.waitFor(() => expect(confirmations.length).toBeGreaterThan(0))
        const first = confirmations[0]!
        expect((await viewer.dispatchTo(received, { command: 'node.setTitle', params: {
          graphId: 'g0', nodeId: 'n1', title: 'Local edit during remote admission',
        } })).ok).toBe(true)
        first.acknowledge()
        await vi.waitFor(() => expect(confirmations.length).toBeGreaterThan(1))
        expect((await viewer.dispatchRetainedTo(received, { command: 'node.setTitle', params: {
          graphId: 'g0', nodeId: 'n1', title: 'Acknowledged local replacement',
        } })).ok).toBe(true)
        await drainTasks()
        expect(receipts.get(first.retained.ownerId)).toEqual(first.retained)
        holdConfirmations = false
        for (const confirmation of confirmations) confirmation.acknowledge()
      }
      if (scenario === 'document-observer') await vi.waitFor(() => expect(closed).toBe(true))
      else {
        await vi.waitFor(() => expect(received.store.doc.graphs.g0!.nodes.n1!.values.held).toEqual(asset))
        await (received.store as unknown as { settle(): Promise<void> }).settle()
        if (scenario === 'settled') await vi.waitFor(() => {
          const canonical = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
          expect(canonical.assetRetention.complete).toBe(true)
          expect(canonical.tabs.find((tab: { doc: WorkflowDocument }) => tab.doc.lineage === document.lineage)
            ?.doc.graphs.g0.nodes.n1.values.held).toEqual(asset)
        })
        expect(viewer.requestCloseTab(document.lineage, () => true)).toBe(true)
      }
      stop()
      await vi.waitFor(() => expect(author.tabs.get().some((tab) => tab.id === document.lineage)).toBe(false))
      await vi.waitFor(() => expect([...viewerOwners].filter((id) => receipts.get(id)?.digests.includes(digest))).toEqual([]))
      expect(independentApp.tabs.get().some((tab) => tab.id === 'independent-remote-edit')).toBe(true)
      for (const receipt of independent) expect(receipts.get(receipt.ownerId)).toEqual(receipt)
    },
  )

  it.each(['accepted', 'refused', 'retargeted', 'registry', 'disposed'] as const)(
    'retains incoming shared edits before publishing confirmed ground: %s', async (scenario) => {
      const factory = authorityFactories()
      const author = createEditableApp()
      const viewer = createEditableApp()
      await author.openDocument(workflow(), 'Shared workflow')
      await viewer.openDocument(workflow(), 'Shared workflow')
      await Promise.all([author.enableWorkspaceAuthority(factory.document, factory.workspace),
        viewer.enableWorkspaceAuthority(factory.document, factory.workspace)])
      const received = () => viewer.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!
      const original = received().store.doc
      const digest = `blake3:${'d'.repeat(64)}`
      const refreshedDigest = `blake3:${'f'.repeat(64)}`
      let acknowledge!: () => void
      let requested!: () => void
      const request = new Promise<void>((resolve) => { requested = resolve })
      let acknowledgeFresh!: () => void
      let requestedFresh!: () => void
      const freshRequest = new Promise<void>((resolve) => { requestedFresh = resolve })
      vi.spyOn(viewer.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
        if (!declaration.digests.includes(digest)) return { ...owner, ...declaration, revision: 1 }
        if (declaration.digests.includes(refreshedDigest)) {
          expect(declaration.complete).toBe(true)
          requestedFresh()
          return new Promise((resolve) => { acknowledgeFresh = () => resolve({ ...owner, ...declaration, revision: 1 }) })
        }
        expect(declaration.complete).toBe(false)
        expect(localStorage.getItem(`dinkster.workflow-retentions.${owner.ownerId}`)).not.toBeNull()
        requested()
        return new Promise((resolve) => { acknowledge = () => resolve({ ...owner, ...declaration,
          revision: scenario === 'refused' ? 2 : 1 }) })
      })
      vi.spyOn(viewer.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      const tab = author.tabs.get().find((tab) => tab.id === 'multi-window-workflow')!
      expect((await author.dispatchTo(tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1',
        inputId: 'held', value: { digest, name: 'remote.bin', size: 11, mediaType: 'application/octet-stream', virtualPath: '' } } })).ok).toBe(true)
      await request
      expect(received().store.doc).toBe(original)
      if (scenario === 'retargeted') viewer.setTabTarget(received().id, viewer.addBackend('http://other.test', 'Other', false, 'dinkster')!.id)
      if (scenario === 'registry') {
        const schema: NodeSchema = { type: 'X', displayName: 'X', category: 'test', source: 'v3', isOutputNode: false,
          body: [
            { kind: 'input', id: 'held', optional: true, type: { kind: 'concrete', name: 'ASSET' } },
            { kind: 'input', id: 'newDefault', optional: true, type: { kind: 'concrete', name: 'ASSET' },
              widget: { widgetType: 'ASSET', options: {}, default: { digest: refreshedDigest, name: 'default.bin',
                size: 17, mediaType: 'application/octet-stream', virtualPath: '' } } },
          ] }
        viewer.registry.set({ connection: viewer.connection.id, schemas: new Map([['X', schema]]),
          diagnostics: [], hash: 'changed', resolve: (type) => type === 'X' ? schema : undefined })
      }
      if (scenario === 'disposed') viewer.dispose()
      acknowledge()
      if (scenario === 'registry') {
        await freshRequest
        expect(received().store.doc).toBe(original)
        acknowledgeFresh()
      }
      if (scenario === 'accepted' || scenario === 'registry') {
        await vi.waitFor(() => expect(received().store.doc.graphs.g0!.nodes.n1!.values.held).toMatchObject({ digest }))
        if (scenario === 'registry') {
          expect((await viewer.dispatchTo(received(), { command: 'node.setTitle', params: {
            graphId: 'g0', nodeId: 'n1', title: 'Editable after schema refresh',
          } })).ok).toBe(true)
          await vi.waitFor(() => expect(tab.store.doc.graphs.g0!.nodes.n1!.title).toBe('Editable after schema refresh'))
        }
      } else {
        if (scenario !== 'disposed') await vi.waitFor(() => expect(viewer.problems.get().some(
          (problem) => problem.message.includes('sync failed'))).toBe(true))
        expect(received().store.doc).toBe(original)
      }
    },
  )

  it.each(['accepted', 'refused', 'edited', 'retargeted', 'disposed', 'registry', 'disconnected', 'superseded', 'running-accepted', 'running-refused'] as const)(
    'retains incoming tab records before publishing the inventory: %s', async (scenario) => {
      const factory = authorityFactories()
      const author = createEditableApp()
      const digest = `blake3:${'c'.repeat(64)}`
      const document = workflow()
      const incomingDocument = { ...document, ext: { held: { digest, name: 'incoming.bin', size: 11,
        mediaType: 'application/octet-stream', virtualPath: '' } } }
      const running = scenario.startsWith('running-')
      if (!running) await author.openDocument(incomingDocument, 'Incoming workflow')
      await author.enableWorkspaceAuthority(factory.document, factory.workspace)
      vi.stubGlobal('localStorage', memoryStorage())
      const viewer = createEditableApp()
      if (running) await viewer.enableWorkspaceAuthority(factory.document, factory.workspace)
      const previous = viewer.tabs.get()
      const active = viewer.activeTabId.get()
      let released = false
      const incomingReceipts = new Map<string, RetainedAssets>()
      vi.spyOn(viewer.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        const receipt = { ...incomingReceipts.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
        incomingReceipts.set(owner.ownerId, receipt)
        return receipt
      })
      const acknowledgments: (() => void)[] = []
      let requested!: () => void
      const request = new Promise<void>((resolve) => { requested = resolve })
      vi.spyOn(viewer.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
        if (!declaration.digests.includes(digest)) return { ...owner, ...declaration, revision: 1 }
        expect(declaration).toEqual({ revision: 0, complete: false, digests: [digest] })
        expect(localStorage.getItem(`dinkster.workflow-retentions.${owner.ownerId}`)).not.toBeNull()
        if (!released) await new Promise<void>((resolve) => { acknowledgments.push(resolve); requested() })
        const receipt = { ...owner, ...declaration, revision: scenario.endsWith('refused') ? 2 : 1 }
        incomingReceipts.set(owner.ownerId, receipt)
        return receipt
      })
      vi.spyOn(viewer.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      const opening = running
        ? Promise.resolve((await author.openDocument(incomingDocument, 'Incoming workflow'))).then(drainTasks)
        : viewer.enableWorkspaceAuthority(factory.document, factory.workspace)
      await request
      expect(viewer.tabs.get()).toBe(previous)
      expect(viewer.activeTabId.get()).toBe(active)
      if (scenario === 'edited') await viewer.dispatchTo(previous[0]!, { command: 'node.add',
        params: { graphId: previous[0]!.store.doc.root, type: 'LocalEdit', position: { x: 1, y: 2 } } })
      if (scenario === 'retargeted') viewer.setTabTarget(previous[0]!.id,
        viewer.addBackend('http://new-target.test', 'New target', false, 'dinkster')!.id)
      if (scenario === 'disposed') viewer.dispose()
      if (scenario === 'registry') viewer.registry.set({ connection: viewer.connection.id, schemas: new Map(),
        diagnostics: [], hash: 'changed', resolve: () => undefined })
      if (scenario === 'disconnected') { viewer.connection.connect(); viewer.connection.disconnect() }
      if (scenario === 'superseded') {
        author.closeTab(document.lineage)
        await drainTasks()
      }
      released = true
      for (const acknowledge of acknowledgments) acknowledge()
      await opening
      await drainTasks()
      const incoming = viewer.tabs.get().find((tab) => tab.id === document.lineage)
      if (scenario === 'accepted' || scenario === 'running-accepted') {
        expect(incoming?.store.doc.ext?.held).toMatchObject({ digest })
        expect(incoming?.title).toBe('Incoming workflow')
      } else if (scenario === 'superseded') {
        expect(incoming).toBeUndefined()
        expect(viewer.tabs.get().map((tab) => tab.id)).toEqual(author.tabs.get().map((tab) => tab.id))
        expect(incomingReceipts.size).toBeGreaterThan(0)
        await vi.waitFor(() => expect([...incomingReceipts.values()].every((receipt) =>
          receipt.revision === 2 && receipt.complete && receipt.digests.length === 0)).toBe(true))
      } else {
        expect(incoming).toBeUndefined()
        expect(viewer.tabs.get().map((tab) => tab.id)).toEqual(previous.map((tab) => tab.id))
        if (scenario === 'edited') expect(Object.values(viewer.tabs.get()[0]!.store.doc.graphs[previous[0]!.store.doc.root]!.nodes)
          .some((node) => node.type === 'LocalEdit')).toBe(true)
      }
    },
  )

  it.each(['accepted', 'refused', 'edited', 'closed', 'retargeted', 'removed', 'disposed', 'registry', 'disconnected', 'metadata', 'remote', 'locale'] as const)(
    'retains a canonical workspace snapshot before replacing the local store: %s', async (scenario) => {
      const factory = authorityFactories()
      const app = createEditableApp()
      await app.openDocument(workflow(), 'Shared workflow')
      const tab = app.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
      const backend = app.addBackend('http://workspace.test', 'Workspace source', false, 'dinkster')!
      backend.registry.set(app.registry.get())
      app.setTabTarget(tab.id, backend.id)
      if (scenario === 'locale') {
        setLocale('en')
        vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
          const url = String(input)
          if (url.endsWith('/api/library/retention-clients')) return new Response('{}', { status: 404 })
          const displayName = url.endsWith(encodeURIComponent(`sha256:${'b'.repeat(64)}`))
            ? 'Changed label' : 'English label'
          return new Response(JSON.stringify(url.includes('/api/nodes') ? {
            schemaVersion: 1, dinkster: { version: 'locale-test', schemaWire: 2 },
            packs: { demo: { displayName: 'Demo', locales: { en: `sha256:${'a'.repeat(64)}`, zh: `sha256:${'b'.repeat(64)}` } } },
            nodes: { 'demo.localized': { schemaVersion: 2, displayName: 'Raw node', pack: 'demo', body: [] } },
          } : { nodes: { 'demo.localized': { displayName } } }),
          { status: 200, headers: { 'Content-Type': 'application/json' } })
        })
        await app.refreshBackendSchemas(backend)
        await vi.waitFor(() => expect(backend.registry.get()?.resolve('demo.localized')?.displayName).toBe('English label'))
      }
      const digest = `blake3:${'a'.repeat(64)}`
      const previousDigest = `blake3:${'b'.repeat(64)}`
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
        ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
      expect((await app.dispatchTo(tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1',
        inputId: 'held', value: { digest: previousDigest, name: 'previous.bin', size: 9, mediaType: 'application/octet-stream', virtualPath: '' } } })).ok).toBe(true)
      expect((await app.dispatchTo(tab, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1',
        inputId: 'held', value: { digest, name: 'held.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '' } } })).ok).toBe(true)
      let acknowledge!: () => void
      let requested!: () => void
      let released = false
      const request = new Promise<void>((resolve) => { requested = resolve })
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
        if (released || !declaration.digests.includes(digest)) return { ...owner, ...declaration, revision: declaration.revision + 1 }
        expect(declaration).toEqual({ revision: 0, complete: false, digests: [digest, previousDigest] })
        expect(localStorage.getItem(`dinkster.workflow-retentions.${owner.ownerId}`)).not.toBeNull()
        requested()
        return new Promise((resolve) => { acknowledge = () => {
          released = true
          resolve({ ...owner, ...declaration,
            revision: scenario === 'refused' ? declaration.revision + 2 : declaration.revision + 1 })
        } })
      })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
      const promotion = app.enableWorkspaceAuthority(factory.document, factory.workspace)
      await request
      expect(app.tabs.get().find((candidate) => candidate.id === tab.id)?.store).toBe(tab.store)
      if (scenario === 'edited') tab.store.dispatch({ command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'New local title' } })
      if (scenario === 'closed') app.closeTab(tab.id)
      if (scenario === 'retargeted') app.setTabTarget(tab.id, app.addBackend('http://other.test', 'Other', false, 'dinkster')!.id)
      if (scenario === 'removed') app.removeBackend(backend.id)
      if (scenario === 'disposed') app.dispose()
      if (scenario === 'registry') backend.registry.set({ connection: backend.id, schemas: new Map(), diagnostics: [], hash: 'changed', resolve: () => undefined })
      if (scenario === 'locale') {
        setLocale('zh')
        await vi.waitFor(() => expect(backend.registry.get()?.resolve('demo.localized')?.displayName).toBe('Changed label'))
      }
      if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
      if (scenario === 'metadata') {
        app.settings.set('features.appView.enabled', true)
        app.setTabEditorKind(tab.id, 'app')
      }
      if (scenario === 'remote') {
        const other = await connectSharedWorkerSession(tab.id, tab.store.doc, coreCommandRegistry(),
          { actorId: 'remote-editor' }, factory.document)
        expect(other.dispatch({ command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Remote title' } }).ok).toBe(true)
        await other.settle()
        other.close()
      }
      acknowledge()
      await promotion
      const current = app.tabs.get().find((candidate) => candidate.id === tab.id)
      if (scenario === 'accepted' || scenario === 'metadata' || scenario === 'locale') {
        expect(current?.store).not.toBe(tab.store)
        expect(current?.store.doc).toEqual(tab.store.doc)
        expect(current?.store.canUndo).toBe(true)
        expect(app.backendForTab(current!)).toBe(backend)
        if (scenario === 'metadata') expect(current?.editorKind).toBe('app')
        expect(current?.store.undo()).toBe(true)
        await (current!.store as unknown as { settle(): Promise<void> }).settle()
        expect(current?.store.doc.graphs.g0!.nodes.n1!.values.held).toMatchObject({ digest: previousDigest })
      } else if (scenario !== 'closed') expect(current?.store).toBe(tab.store)
      if (scenario === 'locale') setLocale('en')
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

  it.each(['covered', 'incorporated-after-close', 'newer', 'different-content', 'refused'] as const)(
    'confirmed close retires only the incorporated recovery stage: %s', async (scenario) => {
      let commits = Promise.resolve<unknown>(undefined)
      vi.stubGlobal('navigator', { locks: { request: (
        _name: string, _options: LockOptions, callback: () => unknown,
      ) => {
        const next = commits.then(callback)
        commits = next.catch(() => undefined)
        return next
      } } })
      const factory = authorityFactories()
      const app = createEditableApp()
      const schema = primitive('X', 'FLOAT')
      app.registry.set({ connection: app.connection.id, schemas: new Map([['X', schema]]),
        diagnostics: [], hash: 'close-test', resolve: (type) => type === 'X' ? schema : undefined })
      await app.openDocument(workflow(), 'Closing workflow')
      await app.enableWorkspaceAuthority(factory.document, factory.workspace)
      const tab = app.tabs.get().find((open) => open.id === 'multi-window-workflow')!
      expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
        graphId: 'g0', nodeId: 'n1', title: 'Saved before close',
      } })).ok).toBe(true)
      await drainTasks()
      app.flushPersistTabs(true)
      await drainTasks()
      const key = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(tab.id)}`
      const before = localStorage.getItem(key)
      expect(before).not.toBeNull()
      const candidate = JSON.parse(before!)
      const canonical = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
      expect(canonical.documentCandidateStages[tab.id]).toBe(candidate.stageId)
      if (scenario === 'newer') candidate.stageId = 'newer-stage'
      if (scenario === 'different-content') candidate.tab.doc = {
        ...candidate.tab.doc, ext: { unsaved: 'keep this recovery source' },
      }
      if (scenario !== 'covered') localStorage.setItem(key, JSON.stringify(candidate))
      if (scenario === 'incorporated-after-close') {
        localStorage.setItem('dinkster.openTabs', JSON.stringify({ ...canonical,
          documentCandidateStages: {}, documentCandidateDigests: {},
        }))
      }
      if (scenario === 'refused') {
        const surviving = app.tabs.get().find((open) => !open.execution && open.id !== tab.id)!
        await app.dispatchTo(surviving, { command: 'node.add', params: {
          graphId: surviving.store.doc.root, type: 'X', position: { x: 13, y: 29 },
        } })
        vi.spyOn(app.connection, 'retainAssets').mockRejectedValue(new Error('Admission refused'))
      }
      app.closeTab(tab.id)
      if (scenario === 'incorporated-after-close') localStorage.setItem('dinkster.openTabs', JSON.stringify(canonical))
      await drainTasks()
      app.flushPersistTabs(true)
      await drainTasks()
      expect(app.tabs.get().some((open) => open.id === tab.id)).toBe(false)
      if (scenario === 'covered' || scenario === 'incorporated-after-close') expect(localStorage.getItem(key)).toBeNull()
      else expect(localStorage.getItem(key)).toBe(JSON.stringify(candidate))
    },
  )

  it.each(['ordinary', 'canonical-first', 'notification-burst', 'worker-preparation', 'worker-in-flight'] as const)('confirmed Close retires its own recovery without waiting to remove the tab: %s', async (timing) => {
    const events = new EventTarget()
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
    const commits = new Map<string, Promise<unknown>>()
    const pending: LockInfo[] = []
    const held: LockInfo[] = []
    vi.stubGlobal('navigator', { locks: { query: async () => ({ pending: [...pending], held: [...held] }), request: (
      name: string, options: LockOptions | (() => unknown), callback?: () => unknown,
    ) => {
      const consume = typeof options === 'function' ? options : callback!
      const lock: LockInfo = { name, mode: typeof options === 'function' ? 'exclusive' : options.mode ?? 'exclusive', clientId: 'test-renderer' }
      pending.push(lock)
      const next = (commits.get(name) ?? Promise.resolve()).then(async () => {
        pending.splice(pending.indexOf(lock), 1)
        held.push(lock)
        try { return await consume() } finally { held.splice(held.indexOf(lock), 1) }
      })
      commits.set(name, next.catch(() => undefined))
      return next
    } } })
    const app = createEditableApp()
    const schema = primitive('X', 'FLOAT')
    app.registry.set({ connection: app.connection.id, schemas: new Map([['X', schema]]),
      diagnostics: [], hash: 'immediate-close', resolve: (type) => type === 'X' ? schema : undefined })
    await app.openDocument(workflow(), 'Immediate close')
    const factory = authorityFactories()
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    await drainTasks()
    const tab = app.tabs.get().find((open) => open.id === 'multi-window-workflow')!
    expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title: 'Saved before Close',
    } })).ok).toBe(true)
    app.flushPersistTabs(true)
    await drainTasks()
    expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title: 'Last edit before confirmed Close',
    } })).ok).toBe(true)
    expect(tab.store.undo()).toBe(true)
    await (tab.store as unknown as { settle(): Promise<void> }).settle()
    const key = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(tab.id)}`
    const admissions: Array<() => void> = []
    vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
      await new Promise<void>((resolve) => admissions.push(resolve))
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    let releaseCommit = () => {}
    if (timing === 'canonical-first' || timing === 'notification-burst') {
      void navigator.locks.request('dinkster.openTabs.commit', {}, () => new Promise<void>((resolve) => { releaseCommit = resolve }))
      await drainTasks()
      const notify = () => events.dispatchEvent(Object.assign(new Event('storage'), {
        key: 'dinkster.openTabs', newValue: localStorage.getItem('dinkster.openTabs'),
      }))
      notify()
      await drainTasks()
      if (timing === 'notification-burst') {
        for (let repeat = 0; repeat < 12; repeat += 1) {
          notify()
          await drainTasks()
        }
        expect((await navigator.locks.query()).pending).toHaveLength(1)
      }
    }
    const workerResponses: (() => void)[] = []
    let holdWorker = timing === 'worker-in-flight'
    if (timing === 'worker-preparation' || holdWorker) vi.stubGlobal('Worker', class {
      onmessage: ((event: MessageEvent) => void) | undefined
      postMessage(message: { id: number; value?: unknown; json?: string }): void {
        const data = structuredClone(message)
        const respond = () => {
          const value: unknown = data.json === undefined ? data.value : JSON.parse(data.json)
          this.onmessage?.({ data: { id: data.id, value, prepared: preparePersistenceValue(value),
            ...(data.json === undefined ? {} : { json: data.json }) } } as MessageEvent)
        }
        if (holdWorker && workerResponses.length === 0) workerResponses.push(respond)
        else queueMicrotask(respond)
      }
      terminate(): void {}
    })
    if (holdWorker) {
      await vi.waitFor(() => expect(workerResponses.length).toBeGreaterThan(0))
      expect(app.retentionActivity().preparations).toBeGreaterThan(0)
      expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
        graphId: 'g0', nodeId: 'n1', title: 'Newer edit at Close',
      } })).ok).toBe(true)
    }
    expect(app.requestCloseTab(tab.id, () => true)).toBe(true)
    expect(app.tabs.get().some((open) => open.id === tab.id)).toBe(false)
    await drainTasks()
    if (timing === 'canonical-first' || timing === 'notification-burst') {
      app.flushPersistTabs(true)
      await drainTasks()
      releaseCommit()
      await drainTasks()
      const canonical = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
      expect(canonical.tabs.some((saved: { doc: WorkflowDocument }) => saved.doc.lineage === tab.id)).toBe(false)
      expect(canonical.documentCandidateStages?.[tab.id]).not.toBe(JSON.parse(localStorage.getItem(key)!).stageId)
    }
    expect(JSON.parse(localStorage.getItem(key)!).assetRetention.acknowledged).toBe(false)
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) =>
      ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
    for (const resolve of admissions) resolve()
    await drainTasks()
    app.flushPersistTabs(true)
    await drainTasks()
    expect(localStorage.getItem(key)).toBeNull()
    holdWorker = false
    for (const respond of workerResponses.splice(0)) respond()
    await drainTasks()
    expect(app.retentionActivity().preparations).toBe(0)
    expect(localStorage.getItem(key)).toBeNull()
    expect(JSON.parse(localStorage.getItem('dinkster.openTabs')!).tabs.some(
      (saved: { doc: WorkflowDocument }) => saved.doc.lineage === tab.id)).toBe(false)
  })

  it.each(['staging-lock', 'admission'] as const)('Close distinguishes unpublished recovery edits from written stages awaiting acknowledgment: %s', async (pending) => {
    let commits = Promise.resolve<unknown>(undefined)
    const request = (_name: string, _options: LockOptions, callback: () => unknown): Promise<unknown> => {
      const next = commits.then(callback)
      commits = next.catch(() => undefined)
      return next
    }
    vi.stubGlobal('navigator', { locks: { request } })
    const app = createEditableApp()
    const schema = primitive('X', 'FLOAT')
    app.registry.set({ connection: app.connection.id, schemas: new Map([['X', schema]]),
      diagnostics: [], hash: 'close-race', resolve: (type) => type === 'X' ? schema : undefined })
    await app.openDocument(workflow(), 'Recovery race')
    const factory = authorityFactories()
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    const tab = app.tabs.get().find((open) => open.id === 'multi-window-workflow')!
    expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title: 'Already saved',
    } })).ok).toBe(true)
    await drainTasks()
    app.flushPersistTabs(true)
    await drainTasks()
    const key = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(tab.id)}`
    const before = localStorage.getItem(key)
    expect(before).not.toBeNull()
    let release: () => void = () => {}
    if (pending === 'staging-lock') {
      void request('dinkster.openTabs.commit', { mode: 'exclusive' }, () =>
        new Promise<void>((resolve) => { release = resolve }))
      await drainTasks()
    }
    expect((await app.dispatchTo(tab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title: 'New edit while another renderer holds the lock',
    } })).ok).toBe(true)
    const admissions: Array<() => void> = []
    if (pending === 'admission') vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
      await new Promise<void>((resolve) => admissions.push(resolve))
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    app.flushPersistTabs(true)
    await drainTasks()
    if (pending === 'staging-lock') expect(localStorage.getItem(key)).toBe(before)
    else {
      expect(localStorage.getItem(key)).not.toBe(before)
      expect(JSON.parse(localStorage.getItem(key)!).assetRetention.acknowledged).toBe(false)
    }
    const recoveryKeys: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const candidate = localStorage.key(index)!
      if (candidate.startsWith('dinkster.openTabsCandidate.') && !recoveryKeys.includes(candidate)) recoveryKeys.push(candidate)
    }
    expect(recoveryKeys.some((candidate) => JSON.parse(localStorage.getItem(candidate)!).tabs.some(
      (saved: { doc: WorkflowDocument; documentDirty?: boolean }) => saved.documentDirty === true &&
        saved.doc.graphs.g0?.nodes.n1?.title === 'New edit while another renderer holds the lock'))).toBe(true)
    if (pending === 'admission') {
      const canonical = JSON.parse(localStorage.getItem('dinkster.openTabs')!)
      localStorage.setItem('dinkster.openTabs', JSON.stringify({ ...canonical,
        documentCandidateStages: {}, documentCandidateDigests: {},
      }))
    }
    app.closeTab(tab.id)
    if (pending === 'admission') {
      vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) =>
        ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
      for (const resolve of admissions) resolve()
    }
    release()
    await drainTasks()
    app.flushPersistTabs(true)
    await drainTasks()
    expect(app.tabs.get().some((open) => open.id === tab.id)).toBe(false)
    if (pending === 'admission') expect(localStorage.getItem(key)).toBeNull()
    else expect(JSON.parse(localStorage.getItem(key)!).tab.doc.graphs.g0.nodes.n1.title)
      .toBe('New edit while another renderer holds the lock')
  })

  it.each(['settled', 'peer-canonical'] as const)('confirmed close retires its live receipt without releasing another workflow of the same asset: %s', async (scenario) => {
    let commits = Promise.resolve<unknown>(undefined)
    vi.stubGlobal('navigator', { locks: { request: (
      _name: string, _options: LockOptions, callback: () => unknown,
    ) => {
      const next = commits.then(callback)
      commits = next.catch(() => undefined)
      return next
    } } })
    const events = new EventTarget()
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
    const app = createEditableApp()
    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'shared.png', size: 17,
      mediaType: 'image/png', virtualPath: '' }
    const schema: NodeSchema = { ...primitive('X', 'FLOAT'), body: [
      { kind: 'input', id: 'held', optional: true, type: { kind: 'concrete', name: 'ASSET' } },
    ] }
    app.registry.set({ connection: app.connection.id, schemas: new Map([['X', schema]]),
      diagnostics: [], hash: 'close-assets', resolve: (type) => type === 'X' ? schema : undefined })
    const receipts = new Map<string, { revision: number; digests: readonly string[] }>()
    vi.spyOn(app.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
      const receipt = { ...owner, ...declaration, revision: declaration.revision + 1 }
      receipts.set(owner.ownerId, receipt)
      return receipt
    })
    vi.spyOn(app.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
      const receipt = { ...owner, revision: revision + 1, complete: true, digests: [] }
      receipts.set(owner.ownerId, receipt)
      return receipt
    })
    const original = workflow()
    const document = { ...original, graphs: { g0: { ...original.graphs.g0!, nodes: {
      n1: { ...original.graphs.g0!.nodes.n1!, values: { held: asset } },
    } } } }
    await app.openDocument(document, 'Closing asset')
    await app.openDocument({ ...document, lineage: asLineageId('independent-workflow') }, 'Independent asset')
    const factory = authorityFactories()
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    const closing = app.tabs.get().find((tab) => tab.id === original.lineage)!
    const independentTab = app.tabs.get().find((tab) => tab.id === 'independent-workflow')!
    await drainTasks()
    expect((await app.dispatchRetainedTo(independentTab, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title: 'Keep this independent document',
    } })).ok).toBe(true)
    await drainTasks()
    const liveBefore = new Set(receipts.keys())
    expect((await app.dispatchRetainedTo(closing, { command: 'node.setTitle', params: {
      graphId: 'g0', nodeId: 'n1', title: 'Closed document',
    } })).ok).toBe(true)
    const liveOwners = [...receipts.keys()].filter((id) => !liveBefore.has(id))
    expect(liveOwners.length).toBeGreaterThan(0)
    app.flushPersistTabs(true)
    await drainTasks()
    const candidateKey = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(closing.id)}`
    const recovery = JSON.parse(localStorage.getItem(candidateKey)!).assetRetention.owners
    expect(recovery.every((entry: { retained: { digests: string[] } }) => entry.retained.digests.includes(asset.digest))).toBe(true)
    const independentKey = 'dinkster.openTabsDocumentCandidate.independent-workflow'
    const independentStage = localStorage.getItem(independentKey)!
    const independent = JSON.parse(independentStage).assetRetention.owners.map(
      (entry: { retained: { ownerId: string } }) => [entry.retained.ownerId, receipts.get(entry.retained.ownerId)] as const)
    expect(independent.length).toBeGreaterThan(0)
    let finishRead!: () => void
    const beforeRead = new Set(receipts.keys())
    const reader = app.workflowAssetReader(independentTab, asset.digest, {})!
    const pendingRead = reader.read(async () => new Promise<void>((resolve) => { finishRead = resolve }))
    await drainTasks()
    const readOwners = [...receipts].filter(([id]) => !beforeRead.has(id))
    expect(readOwners).toHaveLength(1)
    const write = localStorage.setItem.bind(localStorage)
    let peerCanonical: string | undefined
    if (scenario === 'peer-canonical') vi.spyOn(localStorage, 'setItem').mockImplementation((key, raw) => {
      if (key === 'dinkster.openTabs' && JSON.parse(raw).assetRetention?.complete === true) {
        const snapshot = JSON.parse(raw)
        snapshot.assetRetention.stageId = 'peer-canonical-stage'
        peerCanonical = JSON.stringify(snapshot)
        write(key, peerCanonical)
      } else write(key, raw)
    })
    app.closeTab(closing.id)
    await drainTasks()
    app.flushPersistTabs(true)
    await drainTasks()
    if (scenario === 'peer-canonical') {
      expect(peerCanonical).toBeDefined()
      vi.mocked(localStorage.setItem).mockImplementation(write)
      events.dispatchEvent(Object.assign(new Event('storage'), {
        key: 'dinkster.openTabs', newValue: peerCanonical,
      }))
      await drainTasks()
      expect(localStorage.getItem('dinkster.openTabs')).toBe(peerCanonical)
    }
    expect(localStorage.getItem(candidateKey)).toBeNull()
    for (const id of liveOwners) expect(receipts.get(id)).toMatchObject({ revision: 2, digests: [] })
    for (const entry of recovery) expect(receipts.get(entry.retained.ownerId)).toMatchObject({ revision: 2, digests: [] })
    for (const [id, receipt] of [...independent, ...readOwners]) expect(receipts.get(id)).toEqual(receipt)
    expect(localStorage.getItem(independentKey)).toBe(independentStage)
    expect(app.tabs.get().some((tab) => tab.id === 'independent-workflow')).toBe(true)
    finishRead()
    await pendingRead
  })

  it.each([false, true])('keeps a newly opened workflow through independent changes when addition is refused: %s', async (refuseAddition) => {
    const initial = { ...workflow(), lineage: asLineageId('basic') }
    localStorage.setItem('dinkster.openTabs', JSON.stringify({ v: 1, active: initial.lineage,
      tabs: [{ title: 'Basic', doc: initial }] }))
    const factory = authorityFactories()
    const app = createEditableApp()
    app.registerSchemas([primitive('X', 'FLOAT')])
    let refused = false
    vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const values = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
        .filter((key) => key.startsWith('dinkster.workflow-retentions.') || key.startsWith('dinkster.workspaceOperation.'))
        .map((key) => ({ key, value: JSON.parse(localStorage.getItem(key)!) }))
      const intent = values.find(({ value }) => value.owner?.ownerId === owner.ownerId)?.value
      if (refuseAddition && !refused && intent?.documentLineage === 'opened-workflow' && values.some(({ key, value }) =>
        key.startsWith('dinkster.workspaceOperation.') && value.assetRetention?.acknowledged === false &&
        value.additions?.some((tab: { id: string }) => tab.id === 'opened-workflow'))) {
        refused = true
        throw new Error('Opened workflow addition ownership refused')
      }
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    const observer = await SharedWorkerTabConnection.open([], factory.workspace)
    const snapshots = [observer.snapshot]
    observer.connection.onSnapshot((snapshot) => snapshots.push(snapshot))
    try {
      expect(await app.openDocument({ ...initial, lineage: asLineageId('opened-workflow') }, 'Opened workflow')).toEqual([])
      await drainTasks()
      expect(refused).toBe(refuseAddition)
      // The focus-only successor really reached the authority, even without the addition.
      expect(snapshots.at(-1)!.revision).toBeGreaterThan(observer.snapshot.revision)
      expect(snapshots.at(-1)!.tabs.some((tab) => tab.id === 'opened-workflow')).toBe(!refuseAddition)
      expect(app.tabs.get().some((tab) => tab.id === 'opened-workflow')).toBe(true)
      expect(app.activeTab()?.id).toBe('opened-workflow')
      if (refuseAddition) expect(app.problems.get().some((problem) =>
        problem.code === 'workspace.tabs.mutationFailed' && problem.message.includes('ownership refused'))).toBe(true)

      expect((await app.dispatchRetainedTo(app.activeTab()!, { command: 'node.setTitle', params: {
        graphId: 'g0', nodeId: 'n1', title: 'Unsaved local edit',
      } })).ok).toBe(true)
      app.tabs.set(app.tabs.get().map((tab) => tab.id === 'basic' ? { ...tab, title: 'Renamed independently' } : tab))
      await vi.waitFor(() => expect(snapshots.at(-1)!.tabs.find((tab) => tab.id === 'basic')?.title).toBe('Renamed independently'))
      await drainTasks()
      expect(app.tabs.get().find((tab) => tab.id === 'opened-workflow')?.store.doc.graphs.g0?.nodes.n1?.title).toBe('Unsaved local edit')

      // A peer's admitted removal still removes an acknowledged tab.
      await observer.connection.mutate({ opId: 'peer-close-basic', actorId: 'peer', sequence: 0,
        baseRevision: snapshots.at(-1)!.revision, additions: [], removals: ['basic'], updates: [],
        order: ['opened-workflow'], active: 'opened-workflow' })
      await vi.waitFor(() => expect(app.tabs.get().some((tab) => tab.id === 'basic')).toBe(false))
      expect(app.tabs.get().some((tab) => tab.id === 'opened-workflow')).toBe(true)
      expect(app.requestCloseTab('opened-workflow', () => true)).toBe(true)
      await drainTasks()
      expect(app.tabs.get().some((tab) => tab.id === 'opened-workflow')).toBe(false)
    } finally {
      observer.connection.close()
    }
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

  it.each(['after', 'during'] as const)('keeps a local frozen view active when promotion lands %s admission', async (promotionTiming) => {
    const factory = authorityFactories()
    const first = createEditableApp()
    const second = prepareWorkflowApp(new AppState())
    await first.openDocument(workflow(), 'Shared workflow')
    await second.openDocument(workflow(), 'Shared workflow')
    first.registry.set(buildDinksterRegistry(asConnectionId('local'), {
      schemaVersion: 1,
      dinkster: { version: 'test', schemaWire: 2 },
      nodes: {
        X: {
          schemaVersion: 2, displayName: 'X', outputNode: true,
          body: [{ kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } }],
        },
      },
    }))
    const tab = first.tabs.get().find((candidate) => candidate.id === 'multi-window-workflow')!
    const result = first.compileTab(tab)
    if (!result?.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    const ref = { connection: asConnectionId('local'), prompt: asPromptId('frozen-local') }
    first.registerRun(tab, ref, result.artifact)

    let acknowledge!: () => void
    if (promotionTiming === 'during') {
      vi.spyOn(first.connection, 'retainAssets').mockImplementationOnce((owner, declaration) =>
        new Promise((resolve) => { acknowledge = () => resolve({ ...owner, ...declaration,
          revision: declaration.revision + 1 }) }))
    }
    const opening = first.openExecutionView(ref)
    if (promotionTiming === 'after') expect(await opening).toBe(true)
    await Promise.all([
      first.enableWorkspaceAuthority(factory.document, factory.workspace),
      second.enableWorkspaceAuthority(factory.document, factory.workspace),
    ])
    if (promotionTiming === 'during') {
      acknowledge()
      expect(await opening).toBe(true)
    }
    await drainTasks()

    expect(first.activeTab()?.execution).toEqual(ref)
    expect(second.activeTab()?.execution).toBeUndefined()
    expect(second.activeTabId.get()).toBe('multi-window-workflow')

    first.activeTabId.set('multi-window-workflow')
    expect(await first.openExecutionView(ref)).toBe(true)
    await drainTasks()
    expect(first.activeTab()?.execution).toEqual(ref)
    expect(second.activeTabId.get()).toBe('multi-window-workflow')
  })

  it.each([false, true].flatMap((opaque) => ['nodeOutput', 'preview'].flatMap((kind) =>
    ['accepted', 'refused'].map((scenario) => ({ opaque, kind, scenario })),
  )))('admits received $kind identities before later events, opaque=$opaque: $scenario', async ({ opaque, kind, scenario }) => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    editableApps.push(app)
    const ref = { connection: app.connection.id, prompt: asPromptId('received-output') }
    const digest = `blake3:${'b'.repeat(64)}`
    const output = { image: { typeId: 'IMAGE', meta: opaque ? { fingerprint: 'opaque-source' } : { digest } } }
    const send = (event: unknown) => left.postMessage({ source: 'foreign-window', kind: 'event', event })
    send({ kind: 'started', execution: ref, timestamp: 1 })
    let requested = 0
    let acknowledge!: () => void
    vi.spyOn(app.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
    vi.spyOn(app.connection, 'retainAssets').mockImplementation((owner, declaration) => {
      requested += 1
      expect(declaration.digests).toEqual(opaque ? [] : [digest])
      expect(declaration.complete).toBe(false)
      return new Promise((resolve, reject) => {
        acknowledge = () => scenario === 'refused' ? reject(new Error('ownership refused'))
          : resolve({ ...owner, ...declaration, revision: 1 })
      })
    })
    send({ kind, execution: ref, timestamp: 2, runtimeNodeId: 'image',
      ...(kind === 'nodeOutput' ? { output } : { channel: 'application/json', stream: 'structured', payload: output }) })
    const bytes = new ArrayBuffer(3)
    send({ kind: 'preview', execution: ref, timestamp: 3, runtimeNodeId: 'image', channel: 'image/png', payload: bytes })
    send({ kind: 'completed', execution: ref, timestamp: 4 })
    const other = { ...ref, prompt: asPromptId('unrelated') }
    send({ kind: 'started', execution: other, timestamp: 5 })
    await drainTasks()
    expect(app.store.get(ref)).toMatchObject({ status: 'running', outputs: {}, previews: {} })
    expect(requested).toBe(1)
    expect(app.store.get(other)?.status).toBe('running')
    acknowledge()
    await drainTasks()
    expect(app.store.get(ref)).toMatchObject({ status: 'completed',
      outputs: scenario === 'accepted' && kind === 'nodeOutput' ? { image: output } : {} })
    expect(app.store.get(ref)?.previews.image?.structured?.payload).toEqual(
      scenario === 'accepted' && kind === 'preview' ? output : undefined)
    expect(app.store.get(ref)?.previews.image?.['']?.payload).toEqual(bytes)
    expect(right.sent).toEqual([])
  })

  it.each(['buffer', 'blob'])('publishes self-contained preview bytes without ownership admission: %s', async (kind) => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    editableApps.push(app)
    const ref = { connection: app.connection.id, prompt: asPromptId('inline-preview') }
    vi.spyOn(app.connection, 'retainAssets').mockRejectedValue(new Error('Inline bytes have no backend roots'))
    const bytes = new Uint8Array([7, 3, 11])
    const payload = kind === 'buffer' ? bytes.buffer : new Blob([bytes], { type: 'image/png' })
    left.postMessage({ source: 'foreign-window', kind: 'event', event: {
      kind: 'preview', execution: ref, timestamp: 1, runtimeNodeId: 'image', channel: 'image/png', payload,
    } })
    const actual = app.store.get(ref)?.previews.image?.['']?.payload
    expect(actual).toBeDefined()
    expect(new Uint8Array(actual instanceof Blob ? await actual.arrayBuffer() : actual as ArrayBuffer)).toEqual(bytes)
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

  it.each(['accepted', 'refused', 'disposed', 'disconnected', 'removed', 'superseded', 'registry', 'opaque-accepted', 'opaque-refused', 'source-accepted', 'source-refused'] as const)('retains mirrored registration snapshots before publication: %s', async (scenario) => {
    const left = new EventChannel()
    const right = new EventChannel()
    left.peer = right
    right.peer = left
    const app = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
    editableApps.push(app)
    const backend = scenario === 'removed'
      ? app.addBackend('http://registration.test', 'Registration source', false, 'dinkster')!
      : app.backends.get()[0]!
    const registry = buildDinksterRegistry(backend.id, {
      schemaVersion: 1,
      dinkster: { version: 'test', schemaWire: 2 },
      nodes: {
        X: {
          schemaVersion: 2, displayName: 'X', outputNode: true,
          body: [{ kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } }],
        },
      },
    })
    backend.registry.set(registry)
    const digest = `blake3:${'e'.repeat(64)}`
    const opaque = scenario.startsWith('opaque-')
    const sourceDocument = scenario.startsWith('source-') ? `blake3:${'f'.repeat(64)}` : undefined
    const result = compile({
      document: sourceDocument === undefined ? { ...workflow(), ext: { held: opaque ? { token: 'opaque-registration' }
        : { digest, name: 'registration.bin', size: 17, mediaType: 'application/octet-stream', virtualPath: '' } } } : workflow(),
      revision: 0, resolve: registry.resolve, scope: { kind: 'full' },
      connection: backend.id, schemaHash: registry.hash,
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    let acknowledge!: () => void
    const retain = vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
      new Promise((resolve) => { acknowledge = () => resolve({ ...owner, ...declaration,
        revision: scenario.endsWith('refused') ? 2 : 1 }) }))
    vi.spyOn(backend.connection, 'fetchRetainedAssets').mockResolvedValue(undefined)
    const ref = { connection: backend.id, prompt: asPromptId(`held-registration-${scenario}`) }
    left.postMessage({ source: 'peer', kind: 'register', ref, artifact: result.artifact, timestamp: 13,
      ...(sourceDocument === undefined ? {} : { sourceDocument }) })
    expect(app.store.get(ref)).toBeUndefined()
    await vi.waitFor(() => expect(retain).toHaveBeenCalled())
    expect(retain.mock.calls.at(-1)?.[1]).toEqual({ revision: 0, complete: false,
      digests: sourceDocument === undefined ? opaque ? [] : [digest] : [sourceDocument] })
    left.postMessage({ source: 'peer', kind: 'event', event: { kind: 'completed', execution: ref, timestamp: 19 } })
    expect(app.store.get(ref)).toBeUndefined()
    if (scenario === 'disposed') app.dispose()
    if (scenario === 'disconnected') { backend.connection.connect(); backend.connection.disconnect() }
    if (scenario === 'removed') app.removeBackend(backend.id)
    if (scenario === 'registry') backend.registry.set({ ...registry })
    if (scenario === 'superseded') left.postMessage({ source: 'peer', kind: 'register', ref,
      artifact: { ...result.artifact, revision: 1 }, timestamp: 29 })
    acknowledge()
    if (scenario.endsWith('accepted')) {
      await vi.waitFor(() => expect(app.store.get(ref)?.status).toBe('completed'))
      expect(app.store.get(ref)?.artifact?.snapshot.ext?.held).toEqual(result.artifact.snapshot.ext?.held)
      expect(app.store.get(ref)?.queuedAt).toBe(13)
      expect(app.store.get(ref)?.sourceDocument).toBe(sourceDocument)
    } else {
      if (scenario.endsWith('refused')) await vi.waitFor(() => expect(app.problems.get().some(
        (problem) => problem.code === 'execution.registrationRetentionFailed')).toBe(true))
      await drainTasks()
      expect(app.store.get(ref)).toBeUndefined()
    }
  })

  it.each(['covered', 'uncovered', 'missing-seal'] as const)(
    'replaces only covered interim result holds after late submit registration: %s', async (scenario) => {
      const left = new EventChannel()
      const right = new EventChannel()
      left.peer = right
      right.peer = left
      const app = prepareWorkflowApp(new AppState({ workspaceEvents: right }))
      editableApps.push(app)
      const backend = app.backends.get()[0]!
      const registry = buildDinksterRegistry(backend.id, {
        schemaVersion: 1, dinkster: { version: 'test', schemaWire: 2 }, nodes: {
          X: { schemaVersion: 2, displayName: 'X', outputNode: true,
            body: [{ kind: 'output', id: 'out', type: { kind: 'concrete', types: ['INT'] } }] },
        },
      })
      backend.registry.set(registry)
      const compiled = compile({ document: workflow(), revision: 0, resolve: registry.resolve,
        scope: { kind: 'full' }, connection: backend.id, schemaHash: registry.hash })
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
      const ref = { connection: backend.id, prompt: asPromptId('late-submit') }
      const sourceDocument = `blake3:${'a'.repeat(64)}`
      const digest = `blake3:${'b'.repeat(64)}`
      const extra = `blake3:${'c'.repeat(64)}`
      const outputs = { n1: { out: { typeId: 'IMAGE', meta: { digest } } } }
      const owners = new Map<string, import('@dinkster/client').RetainedAssets>()
      vi.spyOn(backend.connection, 'retainAssets').mockImplementation(async (owner, declaration) => {
        const receipt = { ...owner, ...declaration, revision: 1 }
        owners.set(owner.ownerId, receipt)
        return receipt
      })
      vi.spyOn(backend.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
      vi.spyOn(backend.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        const receipt = { ...owners.get(owner.ownerId)!, revision: revision + 1, complete: true, digests: [] }
        owners.set(owner.ownerId, receipt)
        return receipt
      })
      const job = { state: 'completed' as const, jobRef: 'backend-job', attemptId: 1,
        sourceDocument, outputs, artifacts: [] }
      vi.spyOn(backend.connection, 'fetchJob').mockResolvedValue(job)
      const offer = { token: 'a'.repeat(32), scope: 'local' as const, jobRef: job.jobRef,
        attemptId: 1, nodeId: 'n1', outputId: 'out', publication: 1, complete: true, digests: [digest] }
      vi.spyOn(backend.connection, 'fetchTerminalResultAssets').mockResolvedValue(scenario === 'missing-seal'
        ? undefined : { scope: 'local', jobRef: job.jobRef, attemptId: 1, state: 'completed', complete: true, offers: [offer] })
      vi.spyOn(backend.connection, 'claimResultAssets').mockImplementation(async (owner, sourceToken) => {
        const receipt = { ...owner, sourceToken, revision: 1, complete: true, digests: [digest] }
        owners.set(owner.ownerId, receipt)
        return receipt
      })
      const send = (event: unknown) => left.postMessage({ source: 'peer', kind: 'event', event })
      send({ kind: 'started', execution: ref, timestamp: 1 })
      send({ kind: 'nodeOutput', execution: ref, timestamp: 2, runtimeNodeId: 'n1',
        output: scenario === 'uncovered' ? { ...outputs.n1, extra: { digest: extra } } : outputs.n1 })
      send({ kind: 'completed', execution: ref, timestamp: 3 })
      await vi.waitFor(() => expect(app.store.get(ref)?.status).toBe('completed'))
      await drainTasks()
      expect(app.store.get(ref)?.artifactsHydrated).toBe(false)
      const interim = [...owners.values()].filter((receipt) => receipt.ownerKind === 'shown-result' && !receipt.complete)
      expect(interim.length).toBeGreaterThan(0)
      left.postMessage({ source: 'peer', kind: 'register', ref, artifact: compiled.artifact, timestamp: 0,
        jobRef: job.jobRef, sourceDocument })
      if (scenario === 'missing-seal') {
        await drainTasks()
        expect(app.store.get(ref)?.artifactsHydrated).toBe(false)
        for (const receipt of interim) expect(owners.get(receipt.ownerId)).toEqual(receipt)
        return
      }
      await vi.waitFor(() => expect(app.store.get(ref)?.artifactsHydrated).toBe(true))
      if (scenario === 'covered') {
        await vi.waitFor(() => expect([...owners.values()].filter((receipt) =>
          receipt.ownerKind === 'shown-result').every((receipt) => receipt.complete)).toBe(true))
        expect(app.store.get(ref)?.outputs).toEqual(outputs)
      } else {
        expect(owners.get(interim[0]!.ownerId)).toEqual(interim[0])
        expect(owners.get(interim[0]!.ownerId)?.digests).toContain(extra)
      }
    },
  )

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

  it('admits peer edits against the current backend after a shared tab is retargeted', async () => {
    const factories = authorityFactories()
    const first = createEditableApp()
    const second = createEditableApp()
    await first.openDocument(workflow(), 'Shared workflow')
    await second.openDocument(workflow(), 'Shared workflow')
    await Promise.all([first, second].map((app) => app.enableWorkspaceAuthority(factories.document, factories.workspace)))
    const target = second.addBackend('http://other:8000', 'Other', false, 'dinkster', false)!
    target.registry.set(second.registry.get())
    vi.spyOn(target.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
      ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
    const right = second.activeTab()!
    second.setTabTarget(right.id, target.id)
    expect((await first.dispatchTo(first.activeTab()!, {
      command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n1', title: 'Received on current target' },
    })).ok).toBe(true)
    await vi.waitFor(() => expect(second.activeTab()!.store.doc.graphs.g0!.nodes.n1!.title).toBe('Received on current target'))
    expect((right.store as unknown as { status: { get(): string } }).status.get()).toBe('live')
  })

  it('resolves imported assets in the promoted document without stranding its local session', async () => {
    const app = createEditableApp()
    const backend = app.backends.get()[0]!
    backend.registry.set(buildDinksterRegistry(backend.id, {
      schemaVersion: 2,
      nodes: { AssetLoader: { body: [
        { kind: 'input', id: 'file', type: { kind: 'concrete', types: ['ASSET'] }, widget: { type: 'ASSET', accept: [] } },
      ] } },
    }))
    const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'known.png',
      virtualPath: 'imports/known.png', size: 17, mediaType: 'image/png' }
    vi.spyOn(backend.connection, 'guessAssets').mockImplementation(async (names) => names.map((query) => ({
      query, candidates: [{ ...asset, confidence: 'path' as const, held: true }],
    })))
    const factory = authorityFactories()
    await app.enableWorkspaceAuthority(factory.document, factory.workspace)
    let incomplete = 0
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    vi.mocked(backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      if (!declaration.complete && ++incomplete > 1) await held
      return { ...owner, ...declaration, revision: declaration.revision + 1 }
    })
    try {
      expect(await app.openDocument({ version: 0.4, nodes: [
        { id: 1, type: 'AssetLoader', pos: [100, 100], widgets_values: [asset.name] },
      ], links: [] }, 'Imported asset')).toEqual([])
      const id = app.activeTab()!.id
      await vi.waitFor(() => expect(incomplete).toBeGreaterThan(1))
      await drainTasks()
      expect(app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.file).toBe(asset.name)
      release()
      await vi.waitFor(() => {
        const tab = app.tabs.get().find((candidate) => candidate.id === id)!
        expect('status' in tab.store).toBe(true)
        expect(tab.store.doc.graphs.g0!.nodes.n1!.values.file).toEqual(asset)
      })
      expect(app.problems.get().filter((problem) => problem.code === 'workspace.authority.failed')).toEqual([])
      expect(await app.activeTab()!.store.undo()).toBe(true)
      expect(app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.file).toBe(asset.name)
    } finally {
      release()
    }
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

  it.each(['accepted', 'refused', 'closed', 'live-peer', 'newer-record', 'candidate-only'] as const)(
    'recovers staged edits when replay restores tab membership: %s', async (scenario) => {
      const factories = authorityFactories()
      const base = workflow()
      const initial = { ...workflow(), lineage: asLineageId('replayed-workflow'), graphs: {
        g0: { ...workflow().graphs.g0!, nodes: {}, nextOrdinal: 1 },
      } }
      const digest = `blake3:${'a'.repeat(64)}`
      const recovered = { ...workflow(), lineage: initial.lineage, ext: { held: {
        digest, name: 'recovered.bin', size: 7, mediaType: 'application/octet-stream', virtualPath: '',
      } } }
      const live = { ...recovered, graphs: { g0: { ...recovered.graphs.g0!, name: 'fresher live peer' } } }
      localStorage.setItem('dinkster.openTabs', JSON.stringify({ v: 1, workspaceRevision: 0,
        active: base.lineage, tabs: [{ title: 'Base', doc: base },
          ...(scenario === 'candidate-only' ? [] : [{ title: 'Recovered', doc: recovered }])] }))
      localStorage.setItem('dinkster.openTabsCandidate.stale', JSON.stringify({ v: 1, workspaceRevision: 0,
        active: base.lineage, tabs: [{ title: 'Base', doc: base }] }))
      localStorage.setItem(`dinkster.openTabsDocumentCandidate.${initial.lineage}`, JSON.stringify({
        v: 1, stageId: 'edited-after-create', tab: { title: 'Recovered', doc: recovered, documentDirty: true },
      }))
      const addition = { opId: 'creator#0', actorId: 'creator', sequence: 0, baseRevision: 0,
        additions: [{ id: initial.lineage, title: 'Created', document: initial }], removals: [], updates: [],
        order: [base.lineage, initial.lineage], active: initial.lineage }
      localStorage.setItem('dinkster.workspaceOperation.creator#0', JSON.stringify(addition))
      if (scenario === 'closed') localStorage.setItem('dinkster.workspaceOperation.creator#1', JSON.stringify({
        ...addition, opId: 'creator#1', sequence: 1, additions: [], removals: [initial.lineage],
        order: [base.lineage], active: base.lineage,
      }))
      const peer = scenario === 'live-peer'
        ? await SharedWorkerCollabConnection.open(initial.lineage, live, factories.document, 'live-peer') : undefined
      const inventory = scenario === 'newer-record' ? await SharedWorkerTabConnection.open([
        { id: base.lineage, title: 'Base', document: base },
        { id: initial.lineage, title: 'Updated', document: live },
      ], factories.workspace, 2, base.lineage, { creator: 0 }) : undefined
      const app = createEditableApp()
      expect(app.tabs.get().map((tab) => tab.id)).toEqual([base.lineage])
      if (scenario === 'refused') vi.mocked(app.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        if (declaration.digests.includes(digest)) throw new Error('Recovered workflow ownership refused')
        return { ...owner, ...declaration, revision: declaration.revision + 1 }
      })
      try {
        await app.enableWorkspaceAuthority(factories.document, factories.workspace)
        await drainTasks()
        const tab = app.tabs.get().find((entry) => entry.id === initial.lineage)
        if (scenario === 'closed' || scenario === 'refused') expect(tab).toBeUndefined()
        else expect(tab!.store.doc).toEqual(scenario === 'live-peer' || scenario === 'newer-record' ? live : recovered)
      } finally {
        app.dispose()
        peer?.close()
        inventory?.connection.close()
      }
    },
  )

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
