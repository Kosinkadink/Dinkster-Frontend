/**
 * Boundary-editing commands: `boundary.setSlots` / `boundary.clearSlots`
 * are the deterministic, undoable write path for slot-selective family
 * forwarding (`binds.slots`, hazard F10).
 *
 * The contract under test: commands are schema-blind (structural validation
 * only - grammar, prefix conflicts, binding kind; template-aware errors are
 * derivation's job), selections canonicalize (dedupe + lexicographic sort)
 * so click order never churns the document, identical selections are
 * no-ops, undo restores the exact previous selection, and selection edits
 * never touch node identity, values, or dynamic state.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { BoundaryItem, GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId, asPortId, asRerouteId } from '../src/ids.js'
import { documentResolver } from '../src/compile/compile.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import type { NodeSchema } from '../src/schema/model.js'
import { createMenuRegistry, type MenuActionItem } from '../src/menus/contract.js'
import { coreMenuContributions } from '../src/menus/core-items.js'

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

const familyItem = (id: string, slots?: readonly string[]): BoundaryItem => ({
  id,
  binds: {
    kind: 'family',
    node: asNodeId('n1'),
    port: asPortId('items'),
    ...(slots !== undefined ? { slots } : {}),
  },
})

const portItem = (id: string, slots?: readonly string[]): BoundaryItem => ({
  id,
  binds: {
    kind: 'port',
    node: asNodeId('n1'),
    port: asPortId('items.tag'),
    members: [asNodeId('m0') as unknown as never],
    ...(slots !== undefined ? { slots } : {}),
  },
})

const makeStore = (d: WorkflowDocument) => new DocumentStore(d, coreCommandRegistry())

const slotsOf = (store: DocumentStore, itemId: string, side: 'inputs' | 'outputs' = 'inputs') =>
  store.doc.graphs.sub!.boundary![side].find((b) => b.id === itemId)!.binds.slots

const setSlots = (store: DocumentStore, itemId: string, slots: Json, side = 'inputs') =>
  store.dispatch({ command: 'boundary.setSlots', params: { graphId: 'sub', side, itemId, slots } })

const clearSlots = (store: DocumentStore, itemId: string, side = 'inputs') =>
  store.dispatch({ command: 'boundary.clearSlots', params: { graphId: 'sub', side, itemId } })

// ---------------------------------------------------------------------------
// boundary.setSlots
// ---------------------------------------------------------------------------

describe('boundary.setSlots', () => {
  it('writes a canonical (deduped, sorted) selection', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const out = setSlots(store, 'fwd', ['tag', 'sub.s', 'tag'])
    expect(out.ok).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s', 'tag'])
  })

  it('replaces an existing selection and undo restores it exactly', () => {
    const store = makeStore(subDoc([familyItem('fwd', ['tag'])]))
    expect(setSlots(store, 'fwd', ['sub.s']).ok).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s'])
    expect(store.undo()).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['tag'])
    expect(store.redo()).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s'])
  })

  it('is a no-op for a semantically identical selection (no revision, nothing to undo)', () => {
    const store = makeStore(subDoc([familyItem('fwd', ['a', 'b'])]))
    const before = store.revision
    const out = setSlots(store, 'fwd', ['b', 'a', 'b'])
    expect(out.ok).toBe(true)
    expect(store.revision).toBe(before)
    expect(store.canUndo).toBe(false)
  })

  it('rejects a prefix conflict (whole subtree + narrowed descendant)', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const out = setSlots(store, 'fwd', ['sub', 'sub.s'])
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.slotConflict')
    expect(slotsOf(store, 'fwd')).toBeUndefined()
  })

  it("rejects a 'port' binding (selection applies to family forwarding only)", () => {
    const store = makeStore(subDoc([portItem('p')]))
    const out = setSlots(store, 'p', ['tag'])
    expect(out.ok).toBe(false)
    expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.bindKind')
  })

})

// ---------------------------------------------------------------------------
// boundary.clearSlots
// ---------------------------------------------------------------------------

describe('boundary.clearSlots', () => {
  it('removes the selection and undo restores it', () => {
    const store = makeStore(subDoc([familyItem('fwd', ['sub.s', 'tag'])]))
    expect(clearSlots(store, 'fwd').ok).toBe(true)
    expect(slotsOf(store, 'fwd')).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(slotsOf(store, 'fwd')).toEqual(['sub.s', 'tag'])
  })

})

// ---------------------------------------------------------------------------
// batch atomicity
// ---------------------------------------------------------------------------

describe('boundary commands in a batch', () => {
  it('a failing sub-command rolls back the whole batch', () => {
    const store = makeStore(subDoc([familyItem('fwd')]))
    const out = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'boundary.setSlots',
            params: { graphId: 'sub', side: 'inputs', itemId: 'fwd', slots: ['tag'] },
          },
          {
            command: 'boundary.setSlots',
            params: { graphId: 'sub', side: 'inputs', itemId: 'missing', slots: ['tag'] },
          },
        ],
      },
    })
    expect(out.ok).toBe(false)
    expect(slotsOf(store, 'fwd')).toBeUndefined()
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
      { ...replacement, bindingKind: 'slot' },
      { ...replacement, bindingKind: 'dynamicCombo' },
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
      { graphId: 'sub', side: 'outputs', node: 'n1', tap: 'value', members: ['m0'] },
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

  it('keeps port and family spellings of the same input address mutually exclusive', () => {
    const family: BoundaryItem = {
      id: 'family',
      binds: {
        kind: 'family', node: asNodeId('n1'), port: asPortId('items.tag'),
        members: [asNodeId('m0') as unknown as never],
      },
    }
    const addStore = makeStore(subDoc([family]))
    const add = addStore.dispatch({
      command: 'boundary.addItem',
      params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'items.tag', members: ['m0'] },
    })
    expect(add.ok).toBe(false)
    expect(!add.ok && add.diagnostics[0]!.code).toBe('boundary.duplicateBind')

    const setStore = makeStore(subDoc([family, portItem('other')]))
    const set = setStore.dispatch({
      command: 'boundary.setBinding',
      params: { graphId: 'sub', side: 'inputs', itemId: 'other', node: 'n1', port: 'items.tag', members: ['m0'] },
    })
    expect(set.ok).toBe(false)
    expect(!set.ok && set.diagnostics[0]!.code).toBe('boundary.duplicateBind')
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
    const item = { ...portItem('p', ['invalid']), alsoBinds: [{ kind: 'port' as const, node: asNodeId('n1'), port: asPortId('other') }] }
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

  it('keeps ordinary family bindings addressable by port-shaped unbind commands', () => {
    const store = makeStore(subDoc([familyItem('family')]))
    const outcome = store.dispatch({
      command: 'boundary.unbind',
      params: { graphId: 'sub', side: 'inputs', itemId: 'family', node: 'n1', port: 'items' },
    })
    expect(outcome.ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([])
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([familyItem('family')])
  })
})

describe('showing a field on the subgraph node', () => {
  const int = { kind: 'concrete', name: 'INT' } as const
  const image = { kind: 'concrete', name: 'IMAGE' } as const
  const schemas: Record<string, NodeSchema> = {
    Blur: {
      type: 'Blur', displayName: 'Blur', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'input', id: 'image', type: image, optional: false },
        { kind: 'input', id: 'radius', type: int, optional: false, widget: { widgetType: 'INT', options: {}, default: 4 } },
        { kind: 'output', id: 'IMAGE', type: image },
      ],
    },
    Weigh: {
      type: 'Weigh', displayName: 'Weigh', category: 'test', source: 'v3', isOutputNode: true,
      items: [{
        kind: 'input', id: 'weights', type: int, optional: true,
        dynamic: { kind: 'autogrow', template: [{ kind: 'input', id: 'w', type: int, optional: true, widget: { widgetType: 'INT', options: {}, default: 1 } }], naming: { kind: 'prefix', prefix: 'w', max: 4 } },
      }],
    },
    Modal: {
      type: 'Modal', displayName: 'Modal', category: 'test', source: 'v3', isOutputNode: true,
      items: [{
        kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: true,
        dynamic: { kind: 'dynamicCombo', options: [{ key: 'a', inputs: [] }, { key: 'b', inputs: [] }] },
      }],
    },
    IntSource: {
      type: 'IntSource', displayName: 'IntSource', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'out', type: int }],
    },
  }
  const resolve = (type: string): NodeSchema | undefined => schemas[type]
  const fieldDoc = (boundary: { inputs: BoundaryItem[]; outputs: BoundaryItem[] } = { inputs: [], outputs: [] }, links: GraphDef['links'] = {}): WorkflowDocument => doc({
    g0: graph({ id: 'g0', name: 'root', nodes: {
      s: { id: asNodeId('s'), type: '#sub', values: { radius: 9 } },
      top: { id: asNodeId('top'), type: 'Blur', values: { radius: 1 } },
    } }),
    sub: graph({
      id: 'sub', name: 'sub', links, boundary,
      nodes: {
        blur: { id: asNodeId('blur'), type: 'Blur', values: { radius: 6 } },
        weigh: { id: asNodeId('weigh'), type: 'Weigh', values: { 'weights.w#m0': 2 }, dynamic: { weights: { members: ['m0'], seq: 1 } } },
        modal: { id: asNodeId('modal'), type: 'Modal', values: {}, dynamic: { mode: { selected: 'a' } } },
        source: { id: asNodeId('source'), type: 'IntSource', values: {} },
      },
    }),
  })
  const schemaStore = (document: WorkflowDocument) =>
    new DocumentStore(document, coreCommandRegistry(), 200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => resolve }))
  const show = (store: DocumentStore, params: Record<string, Json>) =>
    store.dispatch({ command: 'boundary.showOnSubgraphNode', params: { graphId: 'sub', ...params } })
  const derivedInput = (store: DocumentStore, id: string) =>
    deriveBoundarySchema(store.doc.graphs.sub!, documentResolver(store.doc, resolve)).schema?.items.find((item) => item.kind === 'input' && item.id === id)

  it('adds the field as a promoted input drawn without a wire, in one undo step', () => {
    const store = schemaStore(fieldDoc())
    const before = store.doc
    expect(show(store, { node: 'blur', port: 'radius' }).ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([
      { id: 'radius', binds: { kind: 'port', node: 'blur', port: 'radius' }, promoted: true, wireHidden: true },
    ])
    expect(derivedInput(store, 'radius')).toMatchObject({ widget: { default: 6 } })
    expect(store.doc.graphs.g0!.nodes.s!.values).toEqual({ radius: 9 })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('shows a dropdown that leads options through its selector binding', () => {
    const store = schemaStore(fieldDoc())
    expect(show(store, { node: 'modal', port: 'mode' }).ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([
      { id: 'mode', binds: { kind: 'dynamicCombo', node: 'modal', port: 'mode' }, wireHidden: true },
    ])
  })

  it.each([
    ['the top-level workflow', 'boundary.topLevel', fieldDoc(), { graphId: 'g0', node: 'top', port: 'radius' }],
    ['a field with a wire coming in', 'boundary.inputDriven',
      fieldDoc(undefined, { l: { id: 'l', from: { node: asNodeId('source'), port: asPortId('out') }, to: { node: asNodeId('blur'), port: asPortId('radius') } } } as unknown as GraphDef['links']),
      { node: 'blur', port: 'radius' }],
    ['a field already on the subgraph node', 'boundary.duplicateBind',
      fieldDoc({ inputs: [{ id: 'r', binds: { kind: 'port', node: asNodeId('blur'), port: asPortId('radius') }, promoted: true }], outputs: [] }),
      { node: 'blur', port: 'radius' }],
    ['a member of a forwarded group', 'boundary.inputDriven',
      fieldDoc({ inputs: [{ id: 'all', binds: { kind: 'family', node: asNodeId('weigh'), port: asPortId('weights') } }], outputs: [] }),
      { node: 'weigh', port: 'weights.w', members: ['m0'] }],
    ['a row with no stored value', 'boundary.notField', fieldDoc(), { node: 'weigh', port: 'weights.w', members: ['m9'] }],
    ['a construct', 'boundary.notField', fieldDoc(), { node: 'weigh', port: 'weights' }],
    ['a socket without a field', 'boundary.notField', fieldDoc(), { node: 'blur', port: 'image' }],
    ['a selector bound as a plain field', 'boundary.selectorPromoted', fieldDoc(), { node: 'modal', port: 'mode', bindingKind: 'port' }],
  ] as const)('refuses %s without changing the document', (_case, code, document, params) => {
    const store = schemaStore(document)
    const before = store.doc
    const outcome = show(store, params as unknown as Record<string, Json>)
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.diagnostics[0]!.code).toBe(code)
    expect(store.doc).toBe(before)
  })

  it('makes a field, not a pin, from an Inputs panel wire, and draws the wire of a field shown without one', () => {
    const store = schemaStore(fieldDoc())
    const addItem = (port: string) => store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'blur', port } })
    expect(addItem('image').ok).toBe(true)
    expect(addItem('radius').ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs.map((item) => [item.id, item.promoted])).toEqual([['image', undefined], ['radius', true]])
    expect(derivedInput(store, 'radius')).toMatchObject({ widget: { default: 6 } })

    const hidden = schemaStore(fieldDoc())
    expect(show(hidden, { node: 'blur', port: 'radius' }).ok).toBe(true)
    expect(hidden.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'blur', port: 'radius' } }).ok).toBe(true)
    expect(hidden.doc.graphs.sub!.boundary!.inputs).toEqual([{ id: 'radius', binds: { kind: 'port', node: 'blur', port: 'radius' }, promoted: true }])
    expect(hidden.doc.graphs.g0!.nodes.s!.values).toEqual({ radius: 9 })
  })

  it('hides and draws the wire of a field row, keeping its id', () => {
    const store = makeStore(fieldDoc({ inputs: [
      { id: 'r', binds: { kind: 'port', node: asNodeId('blur'), port: asPortId('radius') }, promoted: true },
      { id: 'img', binds: { kind: 'port', node: asNodeId('blur'), port: asPortId('image') } },
    ], outputs: [] }))
    const setHidden = (itemId: string, hidden: boolean) => store.dispatch({ command: 'boundary.setWireHidden', params: { graphId: 'sub', itemId, hidden } })
    expect(setHidden('r', true).ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs[0]).toMatchObject({ id: 'r', wireHidden: true })
    expect(setHidden('r', false).ok).toBe(true)
    expect('wireHidden' in store.doc.graphs.sub!.boundary!.inputs[0]!).toBe(false)
    const pin = setHidden('img', true)
    expect(!pin.ok && pin.diagnostics[0]!.code).toBe('boundary.notField')
  })

  it('offers the entries on a field inside a subgraph and runs them', () => {
    const registry = createMenuRegistry()
    for (const contribution of coreMenuContributions()) registry.register(contribution)
    const entries = (store: DocumentStore, graphId: string, nodeId: string, port: string) => registry.resolve({
      doc: store.doc, graphId,
      target: { kind: 'widget', nodeId, inputId: port, address: { port } },
      selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] }, worldX: 0, worldY: 0,
    }).flatMap((group) => group.items).filter((item) => item.id.startsWith('core.widget.subgraphNode')) as MenuActionItem[]
    const run = (store: DocumentStore, item: MenuActionItem) => {
      if (item.action.kind !== 'command') throw new Error('expected a command')
      return store.dispatch(item.action.invocation)
    }
    const store = schemaStore(fieldDoc())
    expect(entries(store, 'g0', 'top', 'radius')).toEqual([])
    const [showEntry] = entries(store, 'sub', 'blur', 'radius')
    expect(showEntry!.label).toBe('Show on subgraph node')
    expect(run(store, showEntry!).ok).toBe(true)
    const shown = entries(store, 'sub', 'blur', 'radius')
    expect(shown.map((item) => item.label)).toEqual(['Remove from subgraph node'])
    expect(run(store, shown[0]!).ok).toBe(true)
    expect(store.doc.graphs.sub!.boundary!.inputs).toEqual([])

    const wired = schemaStore(fieldDoc({ inputs: [{ id: 'r', binds: { kind: 'port', node: asNodeId('blur'), port: asPortId('radius') }, promoted: true }], outputs: [] }))
    const wiredEntries = entries(wired, 'sub', 'blur', 'radius')
    expect(wiredEntries.map((item) => item.label)).toEqual(['Remove from subgraph node', 'Hide wire'])
    expect(run(wired, wiredEntries[1]!).ok).toBe(true)
    expect(wired.doc.graphs.sub!.boundary!.inputs[0]).toMatchObject({ id: 'r', wireHidden: true })

    const linked = schemaStore(fieldDoc(undefined, { l: { id: 'l', from: { node: asNodeId('source'), port: asPortId('out') }, to: { node: asNodeId('blur'), port: asPortId('radius') } } } as unknown as GraphDef['links']))
    expect(entries(linked, 'sub', 'blur', 'radius')).toEqual([])
  })

  it('replays in a shared session without a schema', () => {
    const original = fieldDoc()
    const command = coreCommandRegistry().get('boundary.showOnSubgraphNode')!
    const prepared = command.prepareForSharedReplay!(original, { graphId: 'sub', node: 'modal', port: 'mode' }, { kind: 'initial', schemaResolverFor: () => resolve }, undefined)!
    expect(prepared.ok).toBe(true)
    const replay = new DocumentStore(original, coreCommandRegistry(), 200, undefined, () => ({ kind: 'shared-replay' }))
    expect(replay.dispatch({ command: 'boundary.showOnSubgraphNode', params: prepared.ok ? prepared.params : null }).ok).toBe(true)
    expect(replay.doc.graphs.sub!.boundary!.inputs[0]!.binds.kind).toBe('dynamicCombo')
  })
})
