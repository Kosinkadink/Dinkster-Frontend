/**
 * Boundary-editing commands: the deterministic, undoable write path for a
 * subgraph definition's boundary items. Commands are schema-blind
 * (structural validation only), identical edits are no-ops, and undo
 * restores the exact previous boundary.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { BoundaryItem, GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId, asPortId, asRerouteId } from '../src/ids.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id: asNodeId(id),
  type: 'Batch',
  values: {},
  ...extra,
})

/** Subgraph def 'sub' with one inner node and the given boundary inputs. */
function subDoc(inputs: BoundaryItem[], outputs: BoundaryItem[] = []): WorkflowDocument {
  return doc({
    g0: graph({ id: 'g0', name: 'root' }),
    sub: graph({
      id: 'sub',
      name: 'sub',
      nodes: { n1: node('n1', { dynamic: { items: { members: ['m0'], seq: 1 } } }) },
      boundary: { inputs, outputs },
    }),
  })
}

const portItem = (id: string): BoundaryItem => ({
  id,
  binds: {
    kind: 'port',
    node: asNodeId('n1'),
    port: asPortId('items.m0.tag'),
  },
})

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())

// ---------------------------------------------------------------------------
// batch atomicity
// ---------------------------------------------------------------------------

describe('boundary commands in a batch', () => {
  it('a failing sub-command rolls back the whole batch', () => {
    const store = makeStore(subDoc([portItem('p')]))
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'boundary.renameItem',
            params: { graphId: 'sub', side: 'inputs', itemId: 'p', displayName: 'Label' },
          },
          {
            command: 'boundary.renameItem',
            params: { graphId: 'sub', side: 'inputs', itemId: 'missing', displayName: 'Label' },
          },
        ],
      },
    })
    expect(out.ok).toBe(false)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.displayName).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

})

// ---------------------------------------------------------------------------
// boundary item lifecycle
// ---------------------------------------------------------------------------

describe('boundary item lifecycle commands', () => {
  it('preserves explicit junction attachments through add, rebind, undo, and redo', () => {
    const initial = subDoc([])
    const sub = initial.graphs.sub!
    const store = makeStore({ ...initial, graphs: { ...initial.graphs, sub: {
      ...sub,
      reroutes: { first: { id: asRerouteId('first') }, second: { id: asRerouteId('second') } },
      links: {
        firstLeg: { id: 'firstLeg' as never, from: { reroute: asRerouteId('first') }, to: { node: asNodeId('n1'), port: asPortId('left') } },
        secondLeg: { id: 'secondLeg' as never, from: { reroute: asRerouteId('second') }, to: { node: asNodeId('n1'), port: asPortId('right') } },
      },
    } } })
    const authoredLinks = store.doc.graphs.sub!.links
    const params = { graphId: 'sub', side: 'inputs', itemId: 'junction', node: 'n1', port: 'left', viaReroute: 'first' }
    expect(store.dispatch({ command: 'boundary.addItem', params }).ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'left', viaReroute: 'first' })
    const revision = store.revision
    expect(store.dispatch({ command: 'boundary.setBinding', params }).ok).toBe(true)
    expect(store.revision).toBe(revision)
    const replacement = { ...params, port: 'right', viaReroute: 'second' }
    expect(store.dispatch({ command: 'boundary.setBinding', params: replacement }).ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'right', viaReroute: 'second' })
    expect(store.doc.graphs.sub!.links).toEqual(authoredLinks)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds.viaReroute).toBe('first')
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds.viaReroute).toBe('second')
    const additional = { graphId: 'sub', itemId: 'junction', node: 'n1', port: 'left', viaReroute: 'first' }
    for (const viaReroute of ['', 7]) {
      const before = JSON.stringify(store.doc)
      expect(store.dispatch({ command: 'boundary.addBinding', params: { ...additional, viaReroute } }).ok).toBe(false)
      expect(JSON.stringify(store.doc)).toBe(before)
    }
    expect(store.dispatch({ command: 'boundary.addBinding', params: additional }).ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.alsoBinds).toEqual([{ kind: 'port', node: 'n1', port: 'left', viaReroute: 'first' }])
    expect(store.doc.graphs.sub!.links).toEqual(authoredLinks)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.alsoBinds).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.alsoBinds?.[0]?.viaReroute).toBe('first')
    const before = JSON.stringify(store.doc)
    for (const invalid of [
      { ...replacement, viaReroute: '' },
      { ...replacement, viaReroute: 7 },
      { ...replacement, side: 'outputs' },
      { graphId: 'sub', side: 'outputs', itemId: 'junction', node: 'n1', tap: 'right', viaReroute: 'second' },
    ]) {
      const outcome = store.dispatch({ command: 'boundary.setBinding', params: invalid as unknown as Json })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.diagnostics[0]!.code).toBe('params.invalid')
      expect(JSON.stringify(store.doc)).toBe(before)
    }
  })

  it('adds, re-points, unbinds, and restores an output-side widget tap atomically', () => {
    const store = makeStore(subDoc([], [portItem('out')]))
    const add = store.dispatch({
      command: 'boundary.addItem',
      params: { graphId: 'sub', side: 'outputs', node: 'n1', tap: 'value', itemId: 'widget' },
    })
    expect(add.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[1]).toEqual({
      id: 'widget',
      binds: { kind: 'widgetTap', node: 'n1', tap: 'value' },
    })

    const set = store.dispatch({
      command: 'boundary.setBinding',
      params: { graphId: 'sub', side: 'outputs', itemId: 'out', node: 'n1', tap: 'other' },
    })
    expect(set.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n1', tap: 'other' })

    const unbind = store.dispatch({
      command: 'boundary.unbind',
      params: { graphId: 'sub', side: 'outputs', itemId: 'out', node: 'n1', tap: 'other' },
    })
    expect(unbind.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs.map((item) => item.id)).toEqual(['widget'])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n1', tap: 'other' })
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs.map((item) => item.id)).toEqual(['widget'])
  })

  it('removes and restores a widget-tap boundary item with its node', () => {
    const tapItem = {
      id: 'widget',
      binds: { kind: 'widgetTap', node: asNodeId('n1'), tap: asPortId('value') },
    } as BoundaryItem
    const store = makeStore(subDoc([], [tapItem]))

    const outcome = store.dispatch({
      command: 'graph.deleteItems',
      params: { graphId: 'sub', nodeIds: ['n1'] },
    })
    expect(outcome.ok).toBe(true)
    expect(store.doc.graphs.sub!.nodes.n1).toBeUndefined()
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.nodes.n1).toBeDefined()
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([tapItem])
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([])
  })

  it('rejects widget taps on inputs and mixed tap/port parameter shapes without mutation', () => {
    const store = makeStore(subDoc([]))
    const before = store.doc
    for (const params of [
      { graphId: 'sub', side: 'inputs', node: 'n1', tap: 'value' },
      { graphId: 'sub', side: 'outputs', node: 'n1', tap: 'value', port: 'value' },
    ]) {
      const outcome = store.dispatch({ command: 'boundary.addItem', params })
      expect(outcome.ok).toBe(false)
      expect(!outcome.ok && outcome.diagnostics[0]!.code).toBe('params.invalid')
    }
    expect(store.doc).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('rejects an explicit item ID used on the other side without changing the document', () => {
    const store = makeStore(subDoc([], [portItem('shared')]))
    const before = structuredClone(store.doc)
    const out = store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'new', itemId: 'shared' } })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.duplicateId')
    expect(store.doc).toEqual(before)
    expect(store.canUndo).toBe(false)
  })

  it('generated item ids avoid ids on BOTH sides (one global namespace)', () => {
    // An existing OUTPUT id 'new' must push the generated INPUT id for
    // port 'new' to 'new_2': derivation treats boundary item ids as one
    // global namespace, so cross-side collisions corrupt derived boundaries.
    const store = makeStore(subDoc([], [portItem('new')]))
    const out = store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'new' } })
    expect(out.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([
      expect.objectContaining({ id: 'new_2' }),
    ])
  })

  it('rejects an added binding already owned by another input without changing the document', () => {
    const binding = (port: string) => ({ kind: 'port' as const, node: asNodeId('n1'), port: asPortId(port) })
    const store = makeStore(subDoc([
      { id: 'first', binds: binding('used') },
      { id: 'second', binds: binding('other') },
    ]))
    const before = structuredClone(store.doc)
    const out = store.dispatch({ command: 'boundary.addBinding', params: { graphId: 'sub', itemId: 'second', node: 'n1', port: 'used' } })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.duplicateBind')
    expect(store.doc).toEqual(before)
    expect(store.canUndo).toBe(false)
  })

  it('adds items with deterministic IDs and creates an absent boundary', () => {
    const d = subDoc([])
    const sub = d.graphs.sub!
    const { boundary: _boundary, ...subWithoutBoundary } = sub
    const withoutBoundary = doc({ g0: d.graphs.g0!, sub: graph({ ...subWithoutBoundary, id: 'sub' }) })
    const store = makeStore(withoutBoundary)
    const add = (itemId?: string) => store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'outputs', node: 'n1', port: 'value', ...(itemId ? { itemId } : {}) } })
    expect(add().ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary).toEqual({ inputs: [], outputs: [expect.objectContaining({ id: 'value' })] })
    expect(add().ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs[1]!.id).toBe('value_2')
    const duplicate = add('value')
    expect(duplicate.ok).toBe(false)
    expect(!duplicate.ok && duplicate.diagnostics[0]!.code).toBe('boundary.duplicateId')
  })

  it('renames, clears canonically, and does not churn identical values', () => {
    const store = makeStore(subDoc([portItem('p')]))
    const rename = (displayName: string) => store.dispatch({ command: 'boundary.renameItem', params: { graphId: 'sub', side: 'inputs', itemId: 'p', displayName } })
    expect(rename('Label').ok).toBe(true)
    const revision = store.revision
    expect(rename('Label').ok).toBe(true)
    expect(store.revision).toBe(revision)
    expect(rename('').ok).toBe(true)
    expect('displayName' in store.doc.graphs.sub!.boundary!.inputs[0]!).toBe(false)
  })

  it('re-points a primary, preserves fan-out, rejects duplicates, and no-ops', () => {
    const item = { ...portItem('p'), alsoBinds: [{ kind: 'port' as const, node: asNodeId('n1'), port: asPortId('other') }] }
    const store = makeStore(subDoc([item]))
    const set = (port: string) => store.dispatch({ command: 'boundary.setBinding', params: { graphId: 'sub', side: 'inputs', itemId: 'p', node: 'n1', port } })
    expect(set('new').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.alsoBinds).toEqual(item.alsoBinds)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'new' })
    const revision = store.revision
    expect(set('new').ok).toBe(true)
    expect(store.revision).toBe(revision)
    const duplicate = set('other')
    expect(duplicate.ok).toBe(false)
    expect(!duplicate.ok && duplicate.diagnostics[0]!.code).toBe('boundary.duplicateBind')
  })

  it('unbinds fan-out, promotes the primary, removes whole items, and reports misses', () => {
    const binding = (port: string) => ({ kind: 'port' as const, node: asNodeId('n1'), port: asPortId(port) })
    const store = makeStore(subDoc([
      { id: 'fan', binds: binding('a'), alsoBinds: [binding('b')] },
      { id: 'remove', binds: binding('c') },
    ], [{ id: 'out', binds: binding('d') }]))
    const unbind = (side: string, itemId: string, port: string) => store.dispatch({ command: 'boundary.unbind', params: { graphId: 'sub', side, itemId, node: 'n1', port } })
    expect(unbind('inputs', 'fan', 'b').ok).toBe(true)
    expect('alsoBinds' in store.doc.graphs.sub!.boundary!.inputs[0]!).toBe(false)
    expect(store.undo()).toBe(true)
    expect(unbind('inputs', 'fan', 'a').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]!.binds.port).toBe('b')
    expect('alsoBinds' in store.doc.graphs.sub!.boundary!.inputs[0]!).toBe(false)
    expect(unbind('inputs', 'remove', 'c').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs.some((item) => item.id === 'remove')).toBe(false)
    expect(unbind('outputs', 'out', 'd').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.outputs).toEqual([])
    const missing = unbind('inputs', 'fan', 'missing')
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.diagnostics[0]!.code).toBe('boundary.bindMissing')
  })
})
