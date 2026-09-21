import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asNodeId, type DinksterNodesPayload, type NodeData } from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import { AppState, type Tab } from '../src/app-state.js'
import { inactiveSceneNodesFor, lazyInactiveSceneNodes, runOnMachineMenuGroup } from '../src/CanvasHost.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const nodesPayload = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/dinkster-nodes-comfy.json'), 'utf8'),
) as DinksterNodesPayload
const payloadWithTransform = structuredClone(nodesPayload) as unknown as {
  nodes: Record<string, unknown>
}
payloadWithTransform.nodes['comfy.ImageInvert'] = {
  schemaVersion: 1,
  nodeType: 'comfy.ImageInvert',
  version: 1,
  displayName: 'Image Invert',
  category: 'comfy/image',
  description: '',
  idempotent: true,
  interface: [
    { role: 'input', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, required: true },
    { role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } },
  ],
  aliases: ['ImageInvert'],
  pack: 'comfy',
  signature: 'test-image-invert',
}
payloadWithTransform.nodes['comfy.MultiPreview'] = {
  schemaVersion: 1,
  nodeType: 'comfy.MultiPreview',
  version: 1,
  displayName: 'Multi Preview',
  category: 'comfy/image',
  description: '',
  idempotent: false,
  interface: [
    { role: 'input', id: 'main', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, required: true },
    { role: 'input', id: 'side', type: { kind: 'concrete', types: ['comfy.IMAGE'] }, required: true },
  ],
  aliases: ['MultiPreview'],
  outputNode: true,
  pack: 'comfy',
  signature: 'test-multi-preview',
}

let app: AppState
let basic: Tab

beforeEach(() => {
  app = new AppState()
  basic = app.tabs.get()[0]!
  const backend = app.backends.get()[0]!
  backend.registry.set(buildDinksterRegistry(backend.id, payloadWithTransform as unknown as DinksterNodesPayload))
})

describe('directed partial-execution scopes', () => {
  it('offers connected workers that route every selected ordinary node', () => {
    const selectedTypes = ['n0', 'n1'].map((nodeId) => basic.store.doc.graphs[basic.store.doc.root]!.nodes[nodeId]!.type)
    const group = runOnMachineMenuGroup({
      document: basic.store.doc,
      graphId: basic.store.doc.root,
      nodeIds: ['n0', 'n1'],
      frozen: false,
      catalog: {
        status: 'ready',
        workers: [
          { name: 'local', status: 'connected', routedNodeTypes: selectedTypes, deviceQualifiers: [] },
          { name: 'offline', status: 'disconnected', routedNodeTypes: selectedTypes, deviceQualifiers: [] },
          { name: 'limited', status: 'connected', routedNodeTypes: [], deviceQualifiers: [] },
        ],
      },
    })
    const submenu = group?.items[0]
    expect(submenu?.label).toBe('Run on machine')
    expect(submenu?.children?.map((item) => [item.label, item.disabled])).toEqual([
      ['local - connected', undefined],
      ['offline - disconnected', true],
      ['limited - connected', true],
    ])
  })

  it('does not treat inherited object names as graph nodes', () => {
    const catalog = {
      status: 'ready' as const,
      workers: [{ name: 'local', status: 'connected', routedNodeTypes: [], deviceQualifiers: [] }],
    }
    for (const nodeId of ['constructor', 'toString', '__proto__']) {
      expect(runOnMachineMenuGroup({
        document: basic.store.doc,
        graphId: basic.store.doc.root,
        nodeIds: [nodeId],
        frozen: false,
        catalog,
      })).toBeUndefined()
    }
  })

  it('keeps regions placeable without claiming body routability and excludes plain subgraphs', () => {
    const document = structuredClone(basic.store.doc)
    const nodes = document.graphs[document.root]!.nodes as Record<string, typeof document.graphs[typeof document.root]['nodes'][string]>
    const node = nodes['n0']!
    nodes['n0'] = {
      ...node,
      type: '#g1',
      region: { kind: 'map', elementPorts: [] },
    }
    const catalog = {
      status: 'ready' as const,
      workers: [{ name: 'remote', status: 'connected', routedNodeTypes: [], deviceQualifiers: [] }],
    }
    expect(runOnMachineMenuGroup({
      document,
      graphId: document.root,
      nodeIds: ['n0'],
      frozen: false,
      catalog,
    })?.items[0]?.children?.[0]?.disabled).toBeUndefined()

    nodes['n0'] = { ...node, type: '#g1' }
    expect(runOnMachineMenuGroup({
      document,
      graphId: document.root,
      nodeIds: ['n0'],
      frozen: false,
      catalog,
    })).toBeUndefined()
    expect(runOnMachineMenuGroup({
      document,
      graphId: 'g1',
      nodeIds: ['n0'],
      frozen: false,
      catalog,
    })).toBeUndefined()
  })

  it('projects inactive-exclusive occurrences onto root and drilled subgraph scenes', () => {
    const inactive = new Map([
      ['left.selector', new Set(['left.source', 'left.inner.deep'])],
      ['right.selector', new Set(['right.source'])],
    ])
    expect([...inactiveSceneNodesFor(inactive, [])].sort()).toEqual(['left', 'right'])
    expect([...inactiveSceneNodesFor(inactive, ['left'])].sort()).toEqual(['inner', 'source'])
  })

  it('caches a full would-run closure across overlay refreshes', () => {
    // Selector-less documents skip the full would-run compile entirely: the
    // inactive-exclusive overlay is provably empty, so no closure is derived.
    expect(app.scopeClosureCached(basic)).toBeUndefined()
    // Once any document node resolves to a lazy-selector schema, the closure
    // is derived and cached per revision/registry identity.
    const empty = app.registryForTab(basic)!.resolve('EmptyImage')!
    const selector = { input: 'color', branches: { false: 'width', true: 'height' } } as const
    app.registerSchemas([{ ...empty, selector }])
    const first = app.scopeClosureCached(basic)
    expect(first).toBeDefined()
    expect(app.scopeClosureCached(basic)).toBe(first)
    app.registerSchemas([{ ...empty, selector, displayName: 'Layered empty image' }])
    expect(app.scopeClosureCached(basic)).not.toBe(first)
  })

  it('keeps NUL-containing graph-feature sequences distinct in the closure cache', () => {
    const empty = app.registryForTab(basic)!.resolve('EmptyImage')!
    app.registerSchemas([{
      ...empty,
      selector: { input: 'color', branches: { false: 'width', true: 'height' } },
    }])
    const original = app.compileInputForTab.bind(app)
    let graphFeatures: readonly string[] = ['typedLiteral', 'x']
    vi.spyOn(app, 'compileInputForTab').mockImplementation((tab, scope) => {
      const input = original(tab, scope)
      return input === undefined ? undefined : { ...input, graphFeatures }
    })

    const first = app.scopeClosureCached(basic)
    expect(first).toBeDefined()
    expect(app.scopeClosureCached(basic)).toBe(first)
    graphFeatures = ['typedLiteral\u0000x']
    expect(app.scopeClosureCached(basic)).not.toBe(first)
  })

  it('clears lazy-cone overlays for frozen, invalid, and desynchronized views', () => {
    const closure = {
      scope: { kind: 'full' as const },
      revision: 1,
      included: new Set<string>(),
      inactiveExclusive: new Map([['selector', new Set(['inactive'])]]),
      structural: new Map(),
    }
    expect([...lazyInactiveSceneNodes({ frozen: false, closure, instancePath: [] })!]).toEqual(['inactive'])
    expect(lazyInactiveSceneNodes({ frozen: true, closure, instancePath: [] })).toBeUndefined()
    expect(lazyInactiveSceneNodes({ frozen: false, closure: undefined, instancePath: [] })).toBeUndefined()
    expect(lazyInactiveSceneNodes({ frozen: false, closure, instancePath: undefined })).toBeUndefined()
  })

  it('maps up-to to selection minima and from-onwards to reachable outputs', () => {
    const scopes = app.selectionExecutionScopes(basic, ['n0'])!
    expect(scopes.analysis.first).toEqual(['n0'])
    expect(scopes.analysis.last).toEqual(['n0'])
    expect(scopes.upTo).toEqual({
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n0') }],
    })
    expect(scopes.fromOnwards).toEqual({
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    })
    expect(scopes.between).toBeUndefined()
    expect(scopes.betweenReason).toBe('requires a contiguous multi-node selection')
  })

  it('ignores registered virtual notes when deriving execution scopes', () => {
    const document = structuredClone(basic.store.doc) as unknown as {
      graphs: Record<string, { nodes: Record<string, NodeData> }>
      root: string
    }
    document.graphs[document.root]!.nodes['note'] = {
      id: asNodeId('note'),
      type: 'dinkster.note',
      virtual: true,
      values: { text: 'not executable' },
    }
    expect(app.openDocument(document, 'Virtual selection')).toEqual([])
    const tab = app.activeTab()!
    const mixed = app.selectionExecutionScopes(tab, ['note', 'n0'])!
    expect([...mixed.analysis.selected]).toEqual(['n0'])
    expect(mixed.upTo).toEqual({
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n0') }],
    })
    const noteOnly = app.selectionExecutionScopes(tab, ['note'])!
    expect([...noteOnly.analysis.selected]).toEqual([])
    expect(noteOnly.upTo).toBeUndefined()
  })

  it('maps between to direct in-selection sinks for a contiguous range', () => {
    const scopes = app.selectionExecutionScopes(basic, ['n0', 'n1'])!
    expect(scopes.analysis.sinks).toEqual(['n1'])
    expect(scopes.betweenReason).toBeUndefined()
    expect(scopes.between).toEqual({
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    })
  })

  it('expands a selected subgraph instance to executable descendant occurrences', () => {
    const subgraph = app.tabs.get().find((tab) => tab.store.doc.graphs[tab.store.doc.root]?.nodes['n0']?.type === '#g1')!
    const scopes = app.selectionExecutionScopes(subgraph, ['n0'])!
    expect(scopes.upTo).toEqual({
      kind: 'partial',
      targets: [{ instancePath: [asNodeId('n0')], node: asNodeId('n0') }],
    })
  })

  it('from-onwards expands subgraphs to backend outputs, not boundary-only producers', () => {
    const source = app.tabs.get().find((tab) => tab.store.doc.graphs[tab.store.doc.root]?.nodes['n0']?.type === '#g1')!
    const doc = structuredClone(source.store.doc) as unknown as {
      graphs: { g1: { nodes: Record<string, unknown>; nextOrdinal: number } }
    }
    doc.graphs.g1.nodes['n1'] = { id: 'n1', type: 'PreviewImage', values: {} }
    doc.graphs.g1.nextOrdinal = 2
    expect(app.openDocument(doc, 'Mixed subgraph outputs')).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0'])!
    expect(scopes.upTo).toEqual({
      kind: 'partial',
      targets: [
        { instancePath: [asNodeId('n0')], node: asNodeId('n0') },
        { instancePath: [asNodeId('n0')], node: asNodeId('n1') },
      ],
    })
    expect(scopes.fromOnwards).toEqual({
      kind: 'partial',
      targets: [
        { instancePath: [asNodeId('n0')], node: asNodeId('n1') },
        { instancePath: [], node: asNodeId('n1') },
      ],
    })
  })

  it('offers no from-onwards scope when no backend output is reachable', () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    delete doc.graphs.g0.nodes['n1']
    doc.graphs.g0.links = {}
    expect(app.openDocument(doc, 'No output')).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0'])!
    expect(scopes.upTo).toBeDefined()
    expect(scopes.fromOnwards).toBeUndefined()
    expect(scopes.fromOnwardsReason).toBe('no output node is downstream of the selection')
  })

  it('keeps both executable scopes when an unrelated component is cyclic', () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    doc.graphs.g0.nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    doc.graphs.g0.links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleB', port: 'image' } }
    doc.graphs.g0.links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'image' }, to: { node: 'cycleA', port: 'image' } }
    expect(app.openDocument(doc, 'Unrelated cycle')).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0'])!
    expect([...scopes.analysis.cyclicNodes].sort()).toEqual(['cycleA', 'cycleB'])
    expect(scopes.upTo).toBeDefined()
    expect(scopes.fromOnwards).toBeDefined()
  })

  it('disables up-to when the selection upstream closure contains a cycle', () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    doc.graphs.g0.nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    doc.graphs.g0.links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleB', port: 'image' } }
    doc.graphs.g0.links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'image' }, to: { node: 'cycleA', port: 'image' } }
    delete doc.graphs.g0.links['l2']
    doc.graphs.g0.links['cycleToSelection'] = { id: 'cycleToSelection', from: { node: 'cycleA', port: 'image' }, to: { node: 'n1', port: 'images' } }
    expect(app.openDocument(doc, 'Upstream cycle')).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n1'])!
    expect(scopes.upTo).toBeUndefined()
    expect(scopes.upToReason).toBe('upstream of the selection contains a cycle')
  })

  it('disables between with a cycle reason when selected nodes participate in a cycle', () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    doc.graphs.g0.nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    doc.graphs.g0.links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleB', port: 'image' } }
    doc.graphs.g0.links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'image' }, to: { node: 'cycleA', port: 'image' } }
    expect(app.openDocument(doc, 'Selected cycle')).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['cycleA', 'cycleB'])!
    expect(scopes.between).toBeUndefined()
    expect(scopes.betweenReason).toBe('the selected range execution closure contains a cycle')
  })

  it('disables scopes whose nested subgraph instance occurrence participates in a cycle', () => {
    const source = app.tabs.get().find((tab) => tab.store.doc.graphs[tab.store.doc.root]?.nodes['n0']?.type === '#g1')!
    const doc = structuredClone(source.store.doc) as unknown as {
      graphs: {
        g0: { nodes: Record<string, { values: Record<string, unknown> }> }
        g1: {
          nodes: Record<string, { type: string; values: Record<string, unknown> }>
          links: Record<string, unknown>
          boundary: {
            inputs: { id: string; binds: { node: string; port: string }; promoted?: boolean }[]
            outputs: { id: string; binds: { node: string; port: string } }[]
          }
        }
        g2?: unknown
      }
    }
    doc.graphs.g0.nodes['n0']!.values = {}
    doc.graphs.g1.nodes['n0']!.type = '#g2'
    doc.graphs.g1.nodes['n0']!.values = {}
    doc.graphs.g1.boundary.inputs = [{ id: 'source', binds: { node: 'n0', port: 'image' }, promoted: true }]
    doc.graphs.g1.boundary.outputs[0]!.binds.port = 'result'
    doc.graphs.g1.links['selfCycle'] = {
      id: 'selfCycle',
      from: { node: 'n0', port: 'result' },
      to: { node: 'n0', port: 'image' },
    }
    doc.graphs.g2 = {
      id: 'g2',
      name: 'Nested transform',
      nodes: { leaf: { id: 'leaf', type: 'ImageInvert', values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      boundary: {
        inputs: [{ id: 'image', binds: { kind: 'port', node: 'leaf', port: 'image' } }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'leaf', port: 'image' } }],
      },
      nextOrdinal: 1,
    }
    app.openDocument(doc, 'Cyclic subgraph')
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0'])!
    expect(scopes.upTo).toBeUndefined()
    expect(scopes.upToReason).toBe('upstream of the selection contains a cycle')
  })

  it('disables a between target that cannot survive node-mode lowering', () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, { mode?: string }> } }
    }
    doc.graphs.g0.nodes['n1']!.mode = 'muted'
    expect(app.openDocument(doc, 'Muted between sink')).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0', 'n1'])!
    expect(scopes.between).toBeUndefined()
    expect(scopes.betweenReason).toBe('selection has no executable targets')
  })

  it('disables from-onwards when an output plan closure contains a cycle', () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    doc.graphs.g0.nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleOutput'] = { id: 'cycleOutput', type: 'MultiPreview', values: {} }
    doc.graphs.g0.links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleB', port: 'image' } }
    doc.graphs.g0.links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'image' }, to: { node: 'cycleA', port: 'image' } }
    doc.graphs.g0.links['selectedToOutput'] = { id: 'selectedToOutput', from: { node: 'n0', port: 'out0' }, to: { node: 'cycleOutput', port: 'main' } }
    doc.graphs.g0.links['cycleToOutput'] = { id: 'cycleToOutput', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleOutput', port: 'side' } }
    expect(app.openDocument(doc, 'Output closure cycle')).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0'])!
    expect(scopes.fromOnwards).toBeUndefined()
    expect(scopes.fromOnwardsReason).toBe('the downstream output execution closure contains a cycle')
  })

  it('wires each public action to its exact derived scope', async () => {
    const queue = vi.spyOn(app, 'queue').mockResolvedValue()
    await app.queueSelection(basic, ['n0', 'n1'])
    await app.queueSelectionBetween(basic, ['n0', 'n1'])
    await app.queueSelectionOnwards(basic, ['n0', 'n1'])
    expect(queue.mock.calls[0]).toEqual([basic, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n0') }],
    }])
    expect(queue.mock.calls[1]).toEqual([basic, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    }])
    expect(queue.mock.calls[2]).toEqual([basic, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    }, ['n1']])
  })

  it('refuses submission when a required selected maximum was lowered away', async () => {
    const backend = app.backends.get()[0]!
    const submit = vi.spyOn(backend.connection, 'submit')
    await app.queue(basic, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    }, ['not-in-artifact'])
    expect(submit).not.toHaveBeenCalled()
    expect(app.problems.get().some((problem) => problem.code === 'compile.scope.inactiveSelection')).toBe(true)
  })
})
