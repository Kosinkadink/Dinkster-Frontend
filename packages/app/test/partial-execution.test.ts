import { prepareWorkflowApp } from './fixtures/workflow-app.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asNodeId, type NodeData, type NodeSchema } from '@dinkster/core'
import { AppState, type Tab } from '../src/app-state.js'
import { inactiveSceneNodesFor, runOnMachineMenuGroup } from '../src/CanvasHost.js'
import { historicalRegistry } from './historical-schemas.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const scopeSchemas: readonly NodeSchema[] = [{
  type: 'ImageInvert',
  displayName: 'Image Invert',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
    { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
  ],
}, {
  type: 'MultiPreview',
  displayName: 'Multi Preview',
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  items: [
    { kind: 'input', id: 'main', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
    { kind: 'input', id: 'side', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
  ],
}]

let app: AppState
let basic: Tab

beforeEach(async () => {
  app = prepareWorkflowApp(new AppState())
  for (const name of ['basic', 'subgraph']) {
    await app.openDocument(JSON.parse(readFileSync(join(coreRoot, `fixtures/workflows/seed-${name}.json`), 'utf8')), name)
  }
  basic = app.tabs.get().find((tab) => tab.id === 'lineage-seed-basic')!
  const backend = app.backends.get()[0]!
  backend.registry.set(historicalRegistry(backend.id))
  app.registerSchemas(scopeSchemas)
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

  it('ignores registered virtual notes when deriving execution scopes', async () => {
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
    expect((await app.openDocument(document, 'Virtual selection'))).toEqual([])
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

  it('from-onwards expands subgraphs to backend outputs, not boundary-only producers', async () => {
    const source = app.tabs.get().find((tab) => tab.store.doc.graphs[tab.store.doc.root]?.nodes['n0']?.type === '#g1')!
    const doc = structuredClone(source.store.doc) as unknown as {
      graphs: { g1: { nodes: Record<string, unknown>; nextOrdinal: number } }
    }
    doc.graphs.g1.nodes['n1'] = { id: 'n1', type: 'PreviewImage', values: {} }
    doc.graphs.g1.nextOrdinal = 2
    expect((await app.openDocument(doc, 'Mixed subgraph outputs'))).toEqual([])
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

  it('offers no from-onwards scope when no backend output is reachable', async () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    delete doc.graphs.g0.nodes['n1']
    doc.graphs.g0.links = {}
    expect((await app.openDocument(doc, 'No output'))).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0'])!
    expect(scopes.upTo).toBeDefined()
    expect(scopes.fromOnwards).toBeUndefined()
    expect(scopes.fromOnwardsReason).toBe('no output node is downstream of the selection')
  })

  it('keeps both executable scopes when an unrelated component is cyclic', async () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    doc.graphs.g0.nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    doc.graphs.g0.links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleB', port: 'image' } }
    doc.graphs.g0.links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'image' }, to: { node: 'cycleA', port: 'image' } }
    expect((await app.openDocument(doc, 'Unrelated cycle'))).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0'])!
    expect([...scopes.analysis.cyclicNodes].sort()).toEqual(['cycleA', 'cycleB'])
    expect(scopes.upTo).toBeDefined()
    expect(scopes.fromOnwards).toBeDefined()
  })

  it('disables up-to when the selection upstream closure contains a cycle', async () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    doc.graphs.g0.nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    doc.graphs.g0.links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleB', port: 'image' } }
    doc.graphs.g0.links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'image' }, to: { node: 'cycleA', port: 'image' } }
    delete doc.graphs.g0.links['l2']
    doc.graphs.g0.links['cycleToSelection'] = { id: 'cycleToSelection', from: { node: 'cycleA', port: 'image' }, to: { node: 'n1', port: 'images' } }
    expect((await app.openDocument(doc, 'Upstream cycle'))).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n1'])!
    expect(scopes.upTo).toBeUndefined()
    expect(scopes.upToReason).toBe('upstream of the selection contains a cycle')
  })

  it('disables between with a cycle reason when selected nodes participate in a cycle', async () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, unknown>; links: Record<string, unknown> } }
    }
    doc.graphs.g0.nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    doc.graphs.g0.nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    doc.graphs.g0.links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'image' }, to: { node: 'cycleB', port: 'image' } }
    doc.graphs.g0.links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'image' }, to: { node: 'cycleA', port: 'image' } }
    expect((await app.openDocument(doc, 'Selected cycle'))).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['cycleA', 'cycleB'])!
    expect(scopes.between).toBeUndefined()
    expect(scopes.betweenReason).toBe('the selected range execution closure contains a cycle')
  })

  it('disables a between target that cannot survive node-mode lowering', async () => {
    const doc = structuredClone(basic.store.doc) as unknown as {
      graphs: { g0: { nodes: Record<string, { mode?: string }> } }
    }
    doc.graphs.g0.nodes['n1']!.mode = 'muted'
    expect((await app.openDocument(doc, 'Muted between sink'))).toEqual([])
    const scopes = app.selectionExecutionScopes(app.activeTab()!, ['n0', 'n1'])!
    expect(scopes.between).toBeUndefined()
    expect(scopes.betweenReason).toBe('selection has no executable targets')
  })

  it('disables from-onwards when an output plan closure contains a cycle', async () => {
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
    expect((await app.openDocument(doc, 'Output closure cycle'))).toEqual([])
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
