/**
 * The boundary as one ordered body: inputs and outputs at their places among
 * sections and lines of fields. Layout is set by boundary.arrange in one undo
 * step and never changes a value, a wire or the semantic hash; new rows land
 * where the Inputs panel drops them; the subgraph node's schema follows the
 * stored order.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { documentResolver } from '../src/compile/compile.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { Boundary, BoundaryEntry, GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { asGraphDefId, asLineageId, asNodeId, asPortId } from '../src/ids.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import type { NodeSchema } from '../src/schema/model.js'

const FLOAT = { kind: 'concrete', name: 'FLOAT' } as const
const IMAGE = { kind: 'concrete', name: 'IMAGE' } as const
const field = (id: string, value: number) =>
  ({ kind: 'input', id, type: FLOAT, optional: false, widget: { widgetType: 'FLOAT', options: {}, default: value } }) as const
const inner: NodeSchema = {
  type: 'Inner', displayName: 'Inner', category: 'test', source: 'v3', isOutputNode: false,
  body: [
    { kind: 'input', id: 'image', type: IMAGE, optional: false },
    { kind: 'input', id: 'mask', type: IMAGE, optional: false },
    field('radius', 4), field('strength', 0.45), field('feather', 3), field('steps', 20),
    { kind: 'output', id: 'IMAGE', type: IMAGE },
    { kind: 'output', id: 'PREVIEW', type: IMAGE },
  ],
} as unknown as NodeSchema
const resolve = (type: string) => (type === 'Inner' ? inner : undefined)

const input = (id: string, promoted = false): BoundaryEntry =>
  ({ kind: 'input', id, binds: { kind: 'port', node: asNodeId('n1'), port: asPortId(id) }, ...(promoted ? { promoted: true } : {}) }) as BoundaryEntry
const output = (id: string, port: string): BoundaryEntry =>
  ({ kind: 'output', id, binds: { kind: 'port', node: asNodeId('n1'), port: asPortId(port) } }) as BoundaryEntry

/** A flat boundary: image, mask, radius, strength, feather, then result and preview. */
const flat: Boundary = {
  body: [input('image'), input('mask'), input('radius', true), input('strength', true), input('feather', true),
    output('result', 'IMAGE'), output('preview', 'PREVIEW')],
}

function docOf(boundary: Boundary): WorkflowDocument {
  const graph = (id: string, extra: Partial<GraphDef>): GraphDef =>
    ({ id: asGraphDefId(id), name: id, nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 100, ...extra }) as GraphDef
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: graph('g0', { nodes: { s: { id: asNodeId('s'), type: '#sub', values: { strength: 0.8 } } } }),
      sub: graph('sub', { nodes: { n1: { id: asNodeId('n1'), type: 'Inner', values: {} } }, boundary }),
    },
    view: { graphs: {} },
  }
}

const storeOf = (boundary: Boundary) => new DocumentStore(docOf(boundary), coreCommandRegistry(), 200, undefined,
  () => ({ kind: 'initial', schemaResolverFor: () => resolve }))
const arrange = (store: DocumentStore, body: readonly Json[]) =>
  store.dispatch({ command: 'boundary.arrange', params: { graphId: 'sub', body: body as Json[] } })
const ids = (entries: readonly BoundaryEntry[]): unknown[] => entries.map((entry) =>
  entry.kind === 'section' ? { section: entry.id, rows: ids(entry.rows) } : entry.kind === 'line' ? { line: ids(entry.rows) } : entry.id)

/** The Look face: result kept apart, a Look section holding a line of three fields. */
const lookBody: Json[] = [
  { kind: 'input', id: 'image' },
  { kind: 'input', id: 'mask' },
  { kind: 'output', id: 'result', ownRow: true },
  { kind: 'section', id: 'look', displayName: 'Look', collapsedByDefault: true, rows: [
    { kind: 'line', rows: [{ kind: 'input', id: 'radius' }, { kind: 'input', id: 'strength' }, { kind: 'input', id: 'feather' }] },
  ] },
  { kind: 'output', id: 'preview' },
]

describe('boundary.arrange', () => {
  it('sets sections, lines and own rows in one undo step without changing what runs', () => {
    const store = storeOf(flat)
    const before = structuredClone(store.doc)
    const hash = semanticHashOf(store.doc)
    expect(arrange(store, lookBody).ok).toBe(true)
    const body = store.doc.graphs.sub!.boundary!.body
    expect(ids(body)).toEqual(['image', 'mask', 'result', { section: 'look', rows: [{ line: ['radius', 'strength', 'feather'] }] }, 'preview'])
    // Every item keeps its binding and promotion where it moved to.
    const look = body[3] as Extract<BoundaryEntry, { kind: 'section' }>
    expect(look).toMatchObject({ displayName: 'Look', collapsedByDefault: true })
    expect((look.rows[0] as Extract<BoundaryEntry, { kind: 'line' }>).rows[1]).toEqual(input('strength', true))
    expect(body[2]).toEqual({ ...output('result', 'IMAGE'), ownRow: true })
    expect(semanticHashOf(store.doc)).toBe(hash)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('refuses an arrangement that drops, repeats or invents an item, and leaves the document alone', () => {
    const cases: Json[][] = [
      lookBody.filter((entry) => (entry as { id?: string }).id !== 'preview'),
      [...lookBody, { kind: 'input', id: 'image' }],
      [...lookBody, { kind: 'input', id: 'steps' }],
      // An output id named as an input is not that output.
      lookBody.map((entry) => (entry as { id?: string }).id === 'preview' ? { kind: 'input', id: 'preview' } : entry),
    ]
    for (const body of cases) {
      const store = storeOf(flat)
      const before = structuredClone(store.doc)
      const out = arrange(store, body)
      expect(!out.ok && out.diagnostics[0]!.code).toBe('boundary.arrangeItems')
      expect(store.doc).toEqual(before)
      expect(store.canUndo).toBe(false)
    }
  })

  it('refuses a line of one or five fields, an output on a line and two sections with one id', () => {
    const lineOf = (...rows: Json[]): Json => ({ kind: 'line', rows })
    const cases: Json[][] = [
      [lineOf({ kind: 'input', id: 'image' }), { kind: 'input', id: 'mask' }, { kind: 'input', id: 'radius' }, { kind: 'input', id: 'strength' }, { kind: 'input', id: 'feather' }, { kind: 'output', id: 'result' }, { kind: 'output', id: 'preview' }],
      [lineOf(...['image', 'mask', 'radius', 'strength', 'feather'].map((id) => ({ kind: 'input', id }))), { kind: 'output', id: 'result' }, { kind: 'output', id: 'preview' }],
      [{ kind: 'input', id: 'image' }, lineOf({ kind: 'input', id: 'mask' }, { kind: 'output', id: 'result' }), { kind: 'input', id: 'radius' }, { kind: 'input', id: 'strength' }, { kind: 'input', id: 'feather' }, { kind: 'output', id: 'preview' }],
      [{ kind: 'section', id: 'a', rows: [{ kind: 'input', id: 'image' }, { kind: 'section', id: 'a', rows: [{ kind: 'input', id: 'mask' }] }] },
        { kind: 'input', id: 'radius' }, { kind: 'input', id: 'strength' }, { kind: 'input', id: 'feather' }, { kind: 'output', id: 'result' }, { kind: 'output', id: 'preview' }],
    ]
    for (const body of cases) {
      const store = storeOf(flat)
      const before = structuredClone(store.doc)
      const out = arrange(store, body)
      expect(out.ok).toBe(false)
      expect(store.doc).toEqual(before)
    }
  })
})

describe('where a new row lands', () => {
  const faced: Boundary = {
    body: [input('image'), input('mask'),
      { kind: 'section', id: 'look', rows: [{ kind: 'line', rows: [input('radius', true), input('strength', true)] as never }] },
      output('result', 'IMAGE')],
  }

  it('a new input goes after the box that follows the last input, before the outputs that end the face', () => {
    const store = storeOf(faced)
    expect(store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'inputs', node: 'n1', port: 'steps' } }).ok).toBe(true)
    expect(ids(store.doc.graphs.sub!.boundary!.body)).toEqual(['image', 'mask', { section: 'look', rows: [{ line: ['radius', 'strength'] }] }, 'steps', 'result'])
    expect(store.undo()).toBe(true)
    expect(ids(store.doc.graphs.sub!.boundary!.body)).toEqual(['image', 'mask', { section: 'look', rows: [{ line: ['radius', 'strength'] }] }, 'result'])
  })

  it('a new output goes at the very end, and a line left with one field becomes that field', () => {
    const store = storeOf(faced)
    expect(store.dispatch({ command: 'boundary.addItem', params: { graphId: 'sub', side: 'outputs', node: 'n1', port: 'PREVIEW' } }).ok).toBe(true)
    expect(ids(store.doc.graphs.sub!.boundary!.body).at(-1)).toBe('PREVIEW')
    expect(store.dispatch({ command: 'boundary.unbind', params: { graphId: 'sub', side: 'inputs', itemId: 'radius', node: 'n1', port: 'radius' } }).ok).toBe(true)
    expect(ids(store.doc.graphs.sub!.boundary!.body)).toEqual(['image', 'mask', { section: 'look', rows: ['strength'] }, 'result', 'PREVIEW'])
  })
})

describe('the subgraph node schema follows the body', () => {
  it('draws sections, lines and outputs kept apart where the boundary stores them', () => {
    const store = storeOf(flat)
    expect(arrange(store, lookBody).ok).toBe(true)
    const doc = store.doc
    const derived = deriveBoundarySchema(doc.graphs.sub!, documentResolver(doc, resolve))
    expect(derived.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const shape = (rows: readonly unknown[]): unknown[] => rows.map((row) => {
      const r = row as { kind: string; id?: string; rows?: unknown[]; ownRow?: true }
      if (r.kind === 'section') return { section: r.id, rows: shape(r.rows!) }
      if (r.kind === 'row') return { line: shape(r.rows!) }
      return r.ownRow ? `${r.id} (own row)` : r.id
    })
    expect(shape(derived.schema!.body)).toEqual(['image', 'mask', 'result (own row)',
      { section: 'look', rows: [{ line: ['radius', 'strength', 'feather'] }] }, 'preview'])
    const section = derived.schema!.body[3] as { displayName?: string; collapsedByDefault?: boolean }
    expect(section).toMatchObject({ displayName: 'Look', collapsedByDefault: true })
  })
})
