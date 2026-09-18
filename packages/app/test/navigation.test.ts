import { beforeAll, describe, expect, it } from 'vitest'
import { createSignal } from '@dinkster/core'
import {
  currentGraphId,
  diagnosticFocusPlan,
  diagnosticFocusTarget,
  editedSubgraphDefinition,
  AppState,
  pushGraph,
  truncateGraphStack,
  viewInstancePath,
  type Tab,
} from '../src/app-state.js'

beforeAll(() => { Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true }) })

const makeTab = (): Tab =>
  ({
    graphStack: createSignal<readonly string[]>(['root']),
    instancePath: createSignal<readonly string[]>([]),
    store: { doc: {
      root: 'root',
      graphs: {
        root: { id: 'root', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
        child: {
          id: 'child', name: 'child', nodes: {}, links: {}, nets: {}, reroutes: {},
          boundary: { inputs: [], outputs: [] }, nextOrdinal: 1,
        },
      },
    } },
  }) as unknown as Tab

describe('graph navigation helpers', () => {
  it('pushes a graph definition and its instance path segment', () => {
    const tab = makeTab()
    pushGraph(tab, 'child', 'instance')
    expect(tab.graphStack.get()).toEqual(['root', 'child'])
    expect(viewInstancePath(tab)).toEqual(['instance'])
    expect(currentGraphId(tab)).toBe('child')
  })

  it('truncates navigation back to the root', () => {
    const tab = makeTab()
    pushGraph(tab, 'child', 'instance')
    truncateGraphStack(tab, 1)
    expect(tab.graphStack.get()).toEqual(['root'])
    expect(tab.instancePath.get()).toEqual([])
    expect(viewInstancePath(tab)).toEqual([])
  })

  it('keeps one instance segment after a partial breadcrumb truncation', () => {
    const tab = makeTab()
    pushGraph(tab, 'child', 'instance')
    pushGraph(tab, 'grandchild', 'nested-instance')
    truncateGraphStack(tab, 2)
    expect(tab.graphStack.get()).toEqual(['root', 'child'])
    expect(tab.instancePath.get()).toEqual(['instance'])
    expect(viewInstancePath(tab)).toEqual(['instance'])
  })

  it('returns undefined when graph stack and instance path are desynchronized', () => {
    const tab = makeTab()
    tab.graphStack.update((stack) => [...stack, 'sub'])
    expect(viewInstancePath(tab)).toBeUndefined()
  })

  it('returns an empty instance path at the root', () => {
    expect(viewInstancePath(makeTab())).toEqual([])
  })

  it('identifies only the subgraph definition currently being edited', () => {
    const tab = makeTab()
    expect(editedSubgraphDefinition(tab)).toBeUndefined()
    pushGraph(tab, 'child', 'instance')
    expect(editedSubgraphDefinition(tab)?.id).toBe('child')
    truncateGraphStack(tab, 1)
    expect(editedSubgraphDefinition(tab)).toBeUndefined()
    expect(editedSubgraphDefinition(undefined)).toBeUndefined()
  })

  it('creates an empty subgraph, drills into it, and one undo removes it and repairs navigation', () => {
    const app = new AppState()
    const tab = app.createWorkflow()
    const root = tab.store.doc.root
    const outcome = app.createEmptySubgraph(tab, root, { x: 12, y: 34 })
    expect(outcome.ok).toBe(true)
    expect(tab.graphStack.get()).toEqual([root, 'g0'])
    expect(tab.instancePath.get()).toEqual(['n1'])
    expect(tab.store.doc.graphs.g0?.boundary).toEqual({ inputs: [], outputs: [] })
    expect(tab.store.doc.graphs[root]!.nodes.n1).toMatchObject({ type: '#g0', values: {} })
    app.commands.get('edit.undo')!.run()
    expect(tab.store.doc.graphs.g0).toBeUndefined()
    expect(tab.store.doc.graphs[root]!.nodes.n1).toBeUndefined()
    expect(tab.graphStack.get()).toEqual([root])
    expect(tab.instancePath.get()).toEqual([])
  })

  it('opens F1 help only for one selected documented node', () => {
    const app = new AppState({ defaultProtocol: 'dinkster' })
    const schema = {
      type: 'test.documented', displayName: 'Documented', category: 'testing', pack: 'test-pack',
      inputs: [], outputs: [], items: [], hasDocs: true,
    }
    app.registry.set({
      connection: '', hash: 'test', schemas: new Map([[schema.type, schema]]), diagnostics: [],
      resolve: (type: string) => type === schema.type ? schema : undefined,
    } as never)
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'node-help-command', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'root',
          nodes: { n1: { id: 'n1', type: 'test.documented', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        },
      },
      view: { graphs: { root: { nodes: { n1: { position: { x: 0, y: 0 } } } } } },
    }, 'Help')
    app.canvasBridge.set({ selectedNodes: () => ['n1'] } as never)

    expect(app.commands.get('node.help')?.enabled?.()).toBe(true)
    app.commands.get('node.help')!.run()
    expect(app.nodeHelpRequest.get()).toEqual({ backendId: 'local', pack: 'test-pack', nodeType: 'test.documented' })

    app.canvasBridge.set({ selectedNodes: () => ['n1', 'n2'] } as never)
    expect(app.commands.get('node.help')?.enabled?.()).toBe(false)
  })
})

describe('diagnostic focus navigation', () => {
  const document = {
    root: 'root',
    graphs: {
      root: { nodes: { instance: { id: 'instance', type: '#child' }, rootNode: { id: 'rootNode', type: 'Plain' } } },
      child: { nodes: { nested: { id: 'nested', type: 'Plain' } } },
    },
  } as unknown as Tab['store']['doc']

  it('resolves root port anchors and qualified subgraph occurrences', () => {
    expect(diagnosticFocusPlan(document, { port: { node: 'rootNode' as any, port: 'in' as any } })).toEqual({
      graphStack: ['root'], instancePath: [], nodeId: 'rootNode',
    })
    expect(diagnosticFocusPlan(document, { occurrence: { instancePath: ['instance' as any], node: 'nested' as any } })).toEqual({
      graphStack: ['root', 'child'], instancePath: ['instance'], nodeId: 'nested',
    })
    expect(diagnosticFocusPlan(
      document,
      { port: { node: 'nested' as any, port: 'in' as any } },
      ['instance'],
    )).toEqual({ graphStack: ['root', 'child'], instancePath: ['instance'], nodeId: 'nested' })
  })

  it('silently rejects stale nodes and stale drill-in paths', () => {
    expect(diagnosticFocusPlan(document, { occurrence: { instancePath: [], node: 'gone' as any } })).toBeUndefined()
    expect(diagnosticFocusPlan(document, { occurrence: { instancePath: ['gone' as any], node: 'nested' as any } })).toBeUndefined()
  })

  it('chooses the diagnostic owner tab instead of the active tab', () => {
    const tab = (id: string): Tab => ({
      id,
      graphStack: createSignal<readonly string[]>(['root']),
      instancePath: createSignal<readonly string[]>([]),
      store: { doc: document },
    }) as unknown as Tab
    const active = tab('active')
    const owner = tab('owner')
    const target = diagnosticFocusTarget([active, owner], active.id, {
      owner: owner.id,
      severity: 'warning', origin: 'compile', code: 'test', message: 'test',
      anchor: { occurrence: { instancePath: [], node: 'rootNode' as any } },
    })
    expect(target?.tab).toBe(owner)
    expect(target?.plan.nodeId).toBe('rootNode')
  })
})
