/**
 * Rows of choices and type choices crossing subgraph boundaries.
 *
 * These tests intentionally assert exact prompt inputs. A boundary item
 * forwards one inner input by its flattened id; slot connectivity is an
 * occurrence-local compile input, not a mutation of a shared subgraph
 * definition.
 */
import { describe, expect, it } from 'vitest'
import { compile, type CompileInput } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import type { BodyRow, ChoiceSpec, InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const FLOAT: TypeExpr = { kind: 'concrete', name: 'FLOAT' }
const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({ kind: 'input', id, type: IMAGE, optional: false, ...extra })
const output = (id: string, type: TypeExpr = IMAGE): OutputSpec => ({ kind: 'output', id, type })
const widget = (id: string, value: number): InputSpec => input(id, {
  type: FLOAT,
  optional: true,
  widget: { widgetType: 'FLOAT', options: {}, default: value },
})
const schemaOf = (type: string, items: BodyRow[]): NodeSchema => ({
  type, displayName: type, category: 'test', source: 'v3', isOutputNode: true, body: items,
})
const combo = (id = 'mode'): ChoiceSpec => ({
  kind: 'choice',
  id,
  required: true,
  shared: [],
  options: [
    { key: 'a', rows: [widget('amount', 1)] },
    { key: 'b', rows: [widget('amount', 2), widget('bias', 3)] },
  ],
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  FloatSrc: schemaOf('FloatSrc', [output('out', FLOAT)]),
  Combo: schemaOf('Combo', [combo(), output('out')]),
  Slot: schemaOf('Slot', [
    { kind: 'typeChoice', id: 'slot', type: IMAGE, rows: [widget('gain', 4)], required: false },
    output('out'),
  ]),
}
const resolve = (type: string) => schemas[type]

type End = [node: string, port: string]
type NodeSpec = { type: string; values?: Record<string, unknown>; dynamic?: Record<string, unknown> }
type GraphSpec = {
  nodes: Record<string, NodeSpec>
  links?: [from: End, to: End][]
  boundary?: { inputs?: unknown[]; outputs?: unknown[] }
}
const end = (e: End) => ({ node: e[0], port: e[1] })
const docOf = (graphs: Record<string, GraphSpec>): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'test-lineage',
  root: 'g0',
  graphs: Object.fromEntries(Object.entries(graphs).map(([id, g]) => [id, {
    id,
    name: id,
    nodes: Object.fromEntries(Object.entries(g.nodes).map(([nid, n]) => [nid, {
      id: nid, type: n.type, values: n.values ?? {}, ...(n.dynamic ? { dynamic: n.dynamic } : {}),
    }])),
    links: Object.fromEntries((g.links ?? []).map((l, i) => [`l${i}`, { id: `l${i}`, from: end(l[0]), to: end(l[1]) }])),
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...(g.boundary ? { boundary: { inputs: g.boundary.inputs ?? [], outputs: g.boundary.outputs ?? [] } } : {}),
  }])),
  view: { graphs: {} },
} as unknown as WorkflowDocument)
const inputOf = (document: WorkflowDocument): CompileInput => ({
  document, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'test-schema-hash',
})
const run = (doc: WorkflowDocument) => compile(inputOf(doc))
const okPrompt = (doc: WorkflowDocument) => {
  const result = run(doc)
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.artifact.prompt
}
describe('choice boundary lowering', () => {
  it('promotes a widget beneath the chosen option as a value or link', () => {
    const sub: GraphSpec = {
      nodes: { n: { type: 'Combo', dynamic: { mode: { selected: 'b' } } } },
      boundary: { inputs: [{ id: 'amount', binds: { kind: 'port', node: 'n', port: 'mode.amount' } }], outputs: [] },
    }
    const byValue = run(docOf({ g0: { nodes: { s: { type: '#sub', values: { amount: 9 } } } }, sub }))
    expect(byValue.ok, JSON.stringify(!byValue.ok && byValue.diagnostics)).toBe(true)
    if (!byValue.ok) return
    expect(byValue.artifact.prompt['s.n']!.inputs).toEqual({ 'mode.amount': 9, 'mode.bias': 3 })
    expect(byValue.artifact.prompt['s.n']!.slotVariants).toEqual({ mode: 'b' })
    expect(okPrompt(docOf({
      g0: { nodes: { src: { type: 'FloatSrc' }, s: { type: '#sub' } }, links: [[['src', 'out'], ['s', 'amount']]] }, sub,
    }))['s.n']!.inputs).toEqual({ 'mode.amount': ['src', 0], 'mode.bias': 3 })
  })
})

describe('type choice boundary lowering', () => {
  it('reveals dependents only when the forwarded slot is connected', () => {
    const sub: GraphSpec = {
      nodes: { n: { type: 'Slot', values: { 'slot.gain': 7 } } },
      boundary: { inputs: [{ id: 'slot', binds: { kind: 'port', node: 'n', port: 'slot' } }], outputs: [] },
    }
    expect(okPrompt(docOf({ g0: { nodes: { s: { type: '#sub' } } }, sub }))['s.n']!.inputs).toEqual({})
    expect(okPrompt(docOf({
      g0: { nodes: { src: { type: 'Src' }, s: { type: '#sub' } }, links: [[['src', 'out'], ['s', 'slot']]] }, sub,
    }))['s.n']!.inputs).toEqual({ slot: ['src', 0], 'slot.gain': 7 })
  })

  it('promotes a dependent when the slot is connected inside the definition', () => {
    const sub: GraphSpec = {
      nodes: { src: { type: 'Src' }, n: { type: 'Slot' } },
      links: [[['src', 'out'], ['n', 'slot']]],
      boundary: { inputs: [{ id: 'gain', binds: { kind: 'port', node: 'n', port: 'slot.gain' } }], outputs: [] },
    }
    expect(okPrompt(docOf({ g0: { nodes: { s: { type: '#sub', values: { gain: 8 } } } }, sub }))['s.n']!.inputs)
      .toEqual({ slot: ['s.src', 0], 'slot.gain': 8 })
    expect(okPrompt(docOf({
      g0: { nodes: { f: { type: 'FloatSrc' }, s: { type: '#sub' } }, links: [[['f', 'out'], ['s', 'gain']]] }, sub,
    }))['s.n']!.inputs).toEqual({ slot: ['s.src', 0], 'slot.gain': ['f', 0] })
  })
})
