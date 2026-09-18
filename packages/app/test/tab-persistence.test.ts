/**
 * Open-tab persistence: a refresh must never lose working documents, saved
 * or not. AppState mirrors live tabs (title + document) and the active tab
 * id into localStorage (versioned envelope) and restores them on startup;
 * absent/corrupt/mismatched snapshots use a protocol-safe clean start.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_SCALE, MIN_SCALE } from '@dinkster/canvas'
import { AppState } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

/** Minimal in-memory localStorage; installed per test, removed after. */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

const TABS_KEY = 'dinkster.openTabs'
const g = globalThis as { localStorage?: Storage }

beforeEach(() => {
  vi.useFakeTimers()
  g.localStorage = fakeStorage()
})

afterEach(() => {
  vi.useRealTimers()
  delete g.localStorage
  Reflect.deleteProperty(globalThis.navigator, 'locks')
})

/** Flush the debounced persistence write. */
const flush = (): void => void vi.advanceTimersByTime(500)

describe('open-tab persistence', () => {
  it('rechecks workspace revision inside the cross-window commit lock', async () => {
    const seed = new AppState({ defaultProtocol: 'dinkster' })
    flush()
    const first = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as Record<string, unknown>
    g.localStorage!.setItem(TABS_KEY, JSON.stringify({ ...first, workspaceRevision: 1 }))
    const stale = new AppState({ defaultProtocol: 'dinkster' })
    flush()
    const newer = {
      ...JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as Record<string, unknown>,
      active: 'newer-window',
      workspaceRevision: 2,
    }

    let enterLock: (() => void) | undefined
    const request = vi.fn((
      _name: string,
      _options: LockOptions,
      callback: (lock: Lock | null) => void,
    ) => new Promise<void>((resolve) => {
      enterLock = () => {
        callback(null)
        resolve()
      }
    }))
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request } as unknown as LockManager,
    })
    stale.createWorkflow()
    flush()
    expect(request).toHaveBeenCalledWith('dinkster.openTabs.commit', { mode: 'exclusive' }, expect.any(Function))
    expect(enterLock).toBeDefined()
    g.localStorage!.setItem(TABS_KEY, JSON.stringify(newer))
    enterLock!()
    await vi.waitFor(() => expect(request).toHaveReturned())
    expect(JSON.parse(g.localStorage!.getItem(TABS_KEY)!)).toEqual(newer)
    seed.dispose()
    stale.dispose()
  })

  it('starts native mode with one schema-independent blank workflow', () => {
    const app = new AppState({ defaultProtocol: 'dinkster' })
    expect(app.tabs.get().map((tab) => tab.title)).toEqual(['Untitled'])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)).toEqual([])
    expect(app.problems.get().map((problem) => problem.code)).not.toContain('schema.unresolvedType')
  })

  it('keeps a new edited tab dirty through close cancellation and discards it without persistence', () => {
    const app = new AppState()
    const tab = app.createWorkflow()
    expect(app.isTabDirty(tab.id)).toBe(true)
    const outcome = app.dispatchTo(tab, {
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'TestNode', position: { x: 10, y: 20 } },
    })
    expect(outcome.ok).toBe(true)
    expect(app.isTabDirty(tab.id)).toBe(true)
    flush()
    const persisted = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      tabs: ReadonlyArray<{ doc: { lineage: string; root: string; graphs: Record<string, { nodes: Record<string, unknown> }> } }>
    }
    const persistedTab = persisted.tabs.find((candidate) => candidate.doc.lineage === tab.id)!
    expect(Object.keys(persistedTab.doc.graphs[persistedTab.doc.root]!.nodes)).toHaveLength(1)

    const cancel = vi.fn(() => false)
    expect(app.requestCloseTab(tab.id, cancel)).toBe(false)
    expect(cancel).toHaveBeenCalledOnce()
    expect(app.tabs.get()).toContain(tab)
    expect(app.isTabDirty(tab.id)).toBe(true)

    expect(app.requestCloseTab(tab.id, () => true)).toBe(true)
    expect(app.tabs.get()).not.toContain(tab)
    flush()
    expect(new AppState().tabs.get().some((candidate) => candidate.id === tab.id)).toBe(false)
  })

  it('protects dirty closes and permits an explicit discard', () => {
    const app = new AppState()
    const tab = app.tabs.get()[0]!
    expect(app.isTabDirty(tab.id)).toBe(true)

    const reject = vi.fn(() => false)
    expect(app.requestCloseTab(tab.id, reject)).toBe(false)
    expect(reject).toHaveBeenCalledOnce()
    expect(app.tabs.get()).toContain(tab)

    expect(app.requestCloseTab(tab.id, () => true)).toBe(true)
    expect(app.tabs.get()).not.toContain(tab)
  })

  it('creates and activates a dirty empty workflow tab', () => {
    const app = new AppState()
    const before = app.tabs.get().length
    const tab = app.createWorkflow()
    expect(app.tabs.get()).toHaveLength(before + 1)
    expect(app.activeTabId.get()).toBe(tab.id)
    expect(tab.title).toBe('Untitled')
    expect(Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)).toEqual([])
    expect(app.isTabDirty(tab.id)).toBe(true)
  })

  it('round-trips unsaved document mutations and tab set across a restart', () => {
    const first = new AppState()
    expect(first.tabs.get().length).toBe(2) // fixture seed (Basic, Subgraph)
    const basic = first.tabs.get()[0]!
    const out = first.dispatchTo(basic, {
      command: 'node.setTitle',
      params: { graphId: basic.store.doc.root, nodeId: 'n0', title: 'renamed by test' },
    })
    expect(out.ok).toBe(true)
    flush()
    expect(g.localStorage!.getItem(TABS_KEY)).toBeTruthy()

    const second = new AppState() // "refresh"
    expect(second.tabs.get().length).toBe(2)
    const restored = second.tabs.get().find((t) => t.id === basic.id)!
    expect(restored).toBeDefined()
    expect(restored.title).toBe(basic.title)
    const graphs = restored.store.doc.graphs as Record<string, { nodes: Record<string, { title?: string }> }>
    expect(graphs[restored.store.doc.root]!.nodes.n0!.title).toBe('renamed by test')
  })

  it('restores the active tab id', () => {
    const first = new AppState()
    const secondTabId = first.tabs.get()[1]!.id
    first.activeTabId.set(secondTabId)
    flush()

    const second = new AppState()
    expect(second.activeTabId.get()).toBe(secondTabId)
  })

  it('round-trips browser-local graph and app view positions without changing the document', () => {
    const first = new AppState()
    const [basic, subgraph] = first.tabs.get()
    if (!basic || !subgraph) throw new Error('fixture needs two tabs')
    const basicDocument = JSON.stringify(basic.store.doc)
    const basicViewport = { x: -321.5, y: 187.25, scale: 1.75 }
    const subgraphViewport = { x: 42, y: -88, scale: 0.6 }
    const subgraphIds = Object.keys(subgraph.store.doc.graphs)
    if (subgraphIds.length < 2) throw new Error('fixture needs a nested graph')
    const nestedViewport = { x: -17, y: 29, scale: 2.25 }

    first.setGraphViewport(basic.id, basic.store.doc.root, basicViewport)
    first.setAppScrollTop(basic.id, 640)
    first.setGraphViewport(subgraph.id, subgraph.store.doc.root, subgraphViewport)
    first.setGraphViewport(subgraph.id, subgraphIds[1]!, nestedViewport)
    expect(JSON.stringify(basic.store.doc)).toBe(basicDocument)
    flush()

    const stored = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      tabs: Array<{
        doc: { lineage: string }
        viewState?: {
          graphViewports: Record<string, unknown>
          appScroll?: unknown
        }
      }>
    }
    const storedBasic = stored.tabs.find((tab) => tab.doc.lineage === basic.id)!
    expect(storedBasic.viewState).toEqual({
      graphViewports: {
        [basic.store.doc.root]: {
          ...basicViewport,
          update: {
            updatedAt: expect.any(Number),
            sequence: expect.any(Number),
            actorId: expect.any(String),
          },
        },
      },
      appScroll: {
        scrollTop: 640,
        update: {
          updatedAt: expect.any(Number),
          sequence: expect.any(Number),
          actorId: expect.any(String),
        },
      },
    })
    expect('viewState' in storedBasic.doc).toBe(false)

    const second = new AppState()
    expect(second.graphViewport(basic.id, basic.store.doc.root)).toEqual(basicViewport)
    expect(second.appScrollTop(basic.id)).toBe(640)
    expect(second.graphViewport(subgraph.id, subgraph.store.doc.root)).toEqual(subgraphViewport)
    expect(second.graphViewport(subgraph.id, subgraphIds[1]!)).toEqual(nestedViewport)
    expect(second.appScrollTop(subgraph.id)).toBe(0)
  })

  it('merges stale-window view updates per graph and resolves same-view updates by recency', () => {
    const seed = new AppState()
    const seedTab = seed.tabs.get()[1]!
    const [rootGraph, nestedGraph] = Object.keys(seedTab.store.doc.graphs)
    if (!rootGraph || !nestedGraph) throw new Error('fixture needs a nested graph')
    const initialViewport = { x: 1, y: 2, scale: 1 }
    seed.setGraphViewport(seedTab.id, rootGraph, initialViewport)
    seed.setAppScrollTop(seedTab.id, 300)
    flush()

    const first = new AppState()
    const stale = new AppState()
    const newerViewport = { x: 30, y: 40, scale: 1.5 }
    const nestedViewport = { x: -50, y: 60, scale: 0.75 }
    first.setGraphViewport(seedTab.id, rootGraph, newerViewport)
    first.setAppScrollTop(seedTab.id, 600)
    flush()
    stale.setGraphViewport(seedTab.id, nestedGraph, nestedViewport)
    flush()

    const merged = new AppState()
    expect(merged.graphViewport(seedTab.id, rootGraph)).toEqual(newerViewport)
    expect(merged.graphViewport(seedTab.id, nestedGraph)).toEqual(nestedViewport)
    expect(merged.appScrollTop(seedTab.id)).toBe(600)

    const latestViewport = { x: 70, y: -80, scale: 2 }
    stale.setGraphViewport(seedTab.id, rootGraph, latestViewport)
    stale.setAppScrollTop(seedTab.id, 0)
    flush()
    const latest = new AppState()
    expect(latest.graphViewport(seedTab.id, rootGraph)).toEqual(latestViewport)
    expect(latest.graphViewport(seedTab.id, nestedGraph)).toEqual(nestedViewport)
    expect(latest.appScrollTop(seedTab.id)).toBe(0)
    seed.dispose()
    first.dispose()
    stale.dispose()
    merged.dispose()
    latest.dispose()
  })

  it('rejects persisted graph viewports outside the canvas zoom bounds', () => {
    const first = new AppState()
    const [basic, subgraph] = first.tabs.get()
    if (!basic || !subgraph) throw new Error('fixture needs two tabs')
    const [subgraphRoot, nestedGraph] = Object.keys(subgraph.store.doc.graphs)
    if (!subgraphRoot || !nestedGraph) throw new Error('fixture needs a nested graph')
    first.setGraphViewport(basic.id, basic.store.doc.root, { x: 1, y: 2, scale: 1 })
    first.setGraphViewport(subgraph.id, subgraphRoot, { x: 3, y: 4, scale: 1 })
    first.setGraphViewport(subgraph.id, nestedGraph, { x: 5, y: 6, scale: 2 })
    flush()

    const stored = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      tabs: Array<{
        doc: { lineage: string }
        viewState?: { graphViewports: Record<string, { x: number; y: number; scale: number }> }
      }>
    }
    stored.tabs.find((tab) => tab.doc.lineage === basic.id)!.viewState!
      .graphViewports[basic.store.doc.root]!.scale = MIN_SCALE / 2
    stored.tabs.find((tab) => tab.doc.lineage === subgraph.id)!.viewState!
      .graphViewports[subgraphRoot]!.scale = MAX_SCALE * 2
    g.localStorage!.setItem(TABS_KEY, JSON.stringify(stored))

    const restored = new AppState()
    expect(restored.graphViewport(basic.id, basic.store.doc.root)).toBeUndefined()
    expect(restored.graphViewport(subgraph.id, subgraphRoot)).toBeUndefined()
    expect(restored.graphViewport(subgraph.id, nestedGraph)).toEqual({ x: 5, y: 6, scale: 2 })
    first.dispose()
    restored.dispose()
  })

  it('persists tabs opened from a document (unsaved), and closed tabs stay closed', () => {
    const first = new AppState()
    const basic = first.tabs.get()[0]!
    const doc = JSON.parse(JSON.stringify(basic.store.doc)) as { lineage: string }
    doc.lineage = 'lineage-imported'
    expect(first.openDocument(doc, 'Imported')).toEqual([])
    first.closeTab(first.tabs.get()[1]!.id) // close Subgraph
    flush()

    const second = new AppState()
    const titles = second.tabs.get().map((t) => t.title)
    expect(titles).toEqual(['Basic', 'Imported'])
    expect(second.activeTabId.get()).toBe('lineage-imported')
  })

  it('falls back to fixture tabs on a corrupt payload', () => {
    g.localStorage!.setItem(TABS_KEY, '{not json')
    const app = new AppState()
    expect(app.tabs.get().map((t) => t.title)).toEqual(['Basic', 'Subgraph'])
  })

  it('falls back to fixture tabs on an unknown envelope version', () => {
    g.localStorage!.setItem(TABS_KEY, JSON.stringify({ v: 2, active: '', tabs: [] }))
    const app = new AppState()
    expect(app.tabs.get().map((t) => t.title)).toEqual(['Basic', 'Subgraph'])
  })

  it('falls back to a blank workflow for a corrupt native snapshot', () => {
    g.localStorage!.setItem(TABS_KEY, '{not json')
    const app = new AppState({ defaultProtocol: 'dinkster' })
    expect(app.tabs.get().map((t) => t.title)).toEqual(['Untitled'])
    const tab = app.activeTab()!
    expect(Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes)).toEqual([])
  })

  it('skips unloadable documents but keeps loadable siblings', () => {
    const first = new AppState()
    flush() // write the seed tabs
    const raw = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      v: 1
      active: string
      tabs: { title: string; doc: unknown }[]
    }
    raw.tabs[0]!.doc = { format: 'not-a-workflow' }
    g.localStorage!.setItem(TABS_KEY, JSON.stringify(raw))

    const second = new AppState()
    expect(second.tabs.get().map((t) => t.title)).toEqual(['Subgraph'])
  })

  it('AP3: edits to a same-lineage replacement tab still persist (watcher rebinds)', () => {
    const first = new AppState()
    const basic = first.tabs.get()[0]!
    const doc = JSON.parse(JSON.stringify(basic.store.doc)) as { lineage: string }
    // Replace the Basic tab: same lineage, same id, NEW session.
    expect(first.openDocument(doc, 'Basic (replaced)')).toEqual([])
    const replacement = first.tabs.get().find((t) => t.id === basic.id)!
    expect(replacement.store).not.toBe(basic.store)
    flush() // settle the replacement write

    // An edit to the REPLACEMENT session must reach storage; a watcher
    // still bound to the old session would drop it silently.
    const out = first.dispatchTo(replacement, {
      command: 'node.setTitle',
      params: { graphId: replacement.store.doc.root, nodeId: 'n0', title: 'edited after replace' },
    })
    expect(out.ok).toBe(true)
    flush()

    const second = new AppState()
    const restored = second.tabs.get().find((t) => t.id === basic.id)!
    expect(restored.store.doc.graphs[restored.store.doc.root]!.nodes['n0']!.title).toBe(
      'edited after replace',
    )
  })

  it('persists a same-lineage replacement that has no subsequent command', () => {
    const first = new AppState()
    flush()
    const original = first.tabs.get()[0]!
    const cloned = JSON.parse(JSON.stringify(original.store.doc)) as typeof original.store.doc
    const replacement = {
      ...cloned,
      graphs: {
        ...cloned.graphs,
        [cloned.root]: { ...cloned.graphs[cloned.root]!, name: 'replacement-without-command' },
      },
    }

    expect(first.openDocument(replacement, 'Replacement')).toEqual([])
    flush()

    const restored = new AppState().tabs.get().find((tab) => tab.id === original.id)!
    expect(restored.store.doc.graphs[restored.store.doc.root]!.name).toBe('replacement-without-command')
    first.dispose()
  })

  it('AP3: an edit made inside the debounce window survives pagehide', () => {
    // Give the constructor a window to hang its pagehide listener on.
    const w = globalThis as { window?: EventTarget }
    w.window = new EventTarget()
    const request = vi.fn(() => new Promise<void>(() => undefined))
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request } as unknown as LockManager,
    })
    let basicId = ''
    try {
      const first = new AppState()
      const basic = first.tabs.get()[0]!
      basicId = basic.id
      flush() // settle startup writes
      const out = first.dispatchTo(basic, {
        command: 'node.setTitle',
        params: { graphId: basic.store.doc.root, nodeId: 'n0', title: 'last-second edit' },
      })
      expect(out.ok).toBe(true)
      // No timer advance: the page goes away INSIDE the 400ms debounce.
      w.window.dispatchEvent(new Event('pagehide'))
      expect(request).toHaveBeenCalled()
    } finally {
      delete w.window
    }

    const second = new AppState()
    const restored = second.tabs.get().find((t) => t.id === basicId)!
    expect(restored.store.doc.graphs[restored.store.doc.root]!.nodes['n0']!.title).toBe(
      'last-second edit',
    )
  })

  it('keeps the newest document at an equal workspace membership revision', () => {
    const fresh = new AppState()
    flush()
    const stale = new AppState()
    const freshTab = fresh.tabs.get()[0]!
    const staleTab = stale.tabs.get().find((tab) => tab.id === freshTab.id)!

    const out = fresh.dispatchTo(freshTab, {
      command: 'node.setTitle',
      params: { graphId: freshTab.store.doc.root, nodeId: 'n0', title: 'newer document' },
    })
    expect(out.ok).toBe(true)
    flush()
    stale.activeTabId.set(staleTab.id)
    flush()

    const restored = new AppState().tabs.get().find((tab) => tab.id === freshTab.id)!
    expect(restored.store.doc.graphs[restored.store.doc.root]!.nodes['n0']!.title).toBe('newer document')
    fresh.dispose()
    stale.dispose()
  })

  it('uses one overwrite register per dirty document so the actual later stage wins', () => {
    const seed = new AppState()
    flush()
    const canonical = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      tabs: Array<{
        doc: { lineage: string; root: string; graphs: Record<string, { name: string }> }
        documentRevision?: number
        documentDirty?: true
      }>
    }
    const lineage = canonical.tabs[0]!.doc.lineage
    const candidate = (name: string, stageId: string): unknown => {
      const tab = structuredClone(canonical.tabs.find((entry) => entry.doc.lineage === lineage)!)
      tab.doc.graphs[tab.doc.root]!.name = name
      tab.documentRevision = 0
      tab.documentDirty = true
      return { v: 1, stageId, tab }
    }
    const key = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(lineage)}`
    g.localStorage!.setItem(key, JSON.stringify(candidate('earlier-B', 'stage-B')))
    g.localStorage!.setItem(key, JSON.stringify(candidate('later-A', 'stage-A')))

    const restored = new AppState()
    const tab = restored.tabs.get().find((entry) => entry.id === lineage)!
    expect(tab.store.doc.graphs[tab.store.doc.root]!.name).toBe('later-A')
    flush()

    const persisted = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as typeof canonical
    const persistedTab = persisted.tabs.find((entry) => entry.doc.lineage === lineage)!
    expect(persistedTab.doc.graphs[persistedTab.doc.root]!.name).toBe('later-A')
    expect(persistedTab.documentRevision).toBe(1)
    expect(JSON.parse(g.localStorage!.getItem(key)!)).toEqual(candidate('later-A', 'stage-A'))
    expect([...Array(g.localStorage!.length).keys()]
      .map((index) => g.localStorage!.key(index))
      .filter((key) => key?.startsWith('dinkster.openTabsCandidate.'))).toEqual([])
    seed.dispose()
    restored.dispose()
  })

  it('keeps independently staged edits for different document lineages', () => {
    const seed = new AppState()
    flush()
    const canonical = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      tabs: Array<{
        doc: { lineage: string; root: string; graphs: Record<string, { name: string }> }
        documentRevision?: number
        documentDirty?: true
      }>
    }
    for (const [index, original] of canonical.tabs.slice(0, 2).entries()) {
      const tab = structuredClone(original)
      tab.doc.graphs[tab.doc.root]!.name = `independent-${index}`
      tab.documentDirty = true
      const key = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(tab.doc.lineage)}`
      g.localStorage!.setItem(key, JSON.stringify({ v: 1, stageId: `stage-${index}`, tab }))
    }

    const restored = new AppState()
    expect(restored.tabs.get().slice(0, 2).map((tab) =>
      tab.store.doc.graphs[tab.store.doc.root]!.name)).toEqual(['independent-0', 'independent-1'])
    seed.dispose()
    restored.dispose()
  })

  it('keeps a newer document stage that arrives during canonical reconciliation', () => {
    const seed = new AppState()
    flush()
    const canonical = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      tabs: Array<{
        doc: { lineage: string; root: string; graphs: Record<string, { name: string }> }
        documentDirty?: true
      }>
    }
    const lineage = canonical.tabs[0]!.doc.lineage
    const candidate = (name: string, stageId: string): string => {
      const tab = structuredClone(canonical.tabs[0]!)
      tab.doc.graphs[tab.doc.root]!.name = name
      tab.documentDirty = true
      return JSON.stringify({ v: 1, stageId, tab })
    }
    const candidateKey = `dinkster.openTabsDocumentCandidate.${encodeURIComponent(lineage)}`
    g.localStorage!.setItem(candidateKey, candidate('first', 'stage-first'))
    const committing = new AppState()
    const storage = g.localStorage!
    const setItem = storage.setItem.bind(storage)
    let injected = false
    storage.setItem = (key, value) => {
      if (key === TABS_KEY && !injected) {
        injected = true
        setItem(candidateKey, candidate('arrived-during-commit', 'stage-later'))
      }
      setItem(key, value)
    }
    flush()

    const restored = new AppState()
    const tab = restored.tabs.get().find((entry) => entry.id === lineage)!
    expect(tab.store.doc.graphs[tab.store.doc.root]!.name).toBe('arrived-during-commit')
    seed.dispose()
    committing.dispose()
    restored.dispose()
  })

  it('AP3: duplicate lineages in a stored snapshot restore last-wins, never twin ids', () => {
    const first = new AppState()
    flush()
    const raw = JSON.parse(g.localStorage!.getItem(TABS_KEY)!) as {
      v: 1
      active: string
      tabs: { title: string; doc: unknown }[]
    }
    // Corrupt/hand-edited snapshot: the Basic document appears twice.
    raw.tabs.push({ title: 'Basic (duplicate)', doc: raw.tabs[0]!.doc })
    g.localStorage!.setItem(TABS_KEY, JSON.stringify(raw))

    const second = new AppState()
    const ids = second.tabs.get().map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length) // ids stay unique
    expect(second.tabs.get().map((t) => t.title)).toEqual(['Subgraph', 'Basic (duplicate)'])
  })
})
