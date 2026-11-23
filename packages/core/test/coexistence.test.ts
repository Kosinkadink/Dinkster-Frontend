/**
 * Coexistence pipeline regression: ONE document combining every construct
 * kind at once, validated end to end (load -> invariants -> solve ->
 * compile). Pairwise interactions each have focused suites; this file exists
 * because real workflows combine everything simultaneously and past bugs
 * (subgraph pseudonode input bound to a widget of a choice's option) lived
 * exactly in untested combinations.
 *
 * The document under test:
 * - a subgraph whose boundary simultaneously promotes a row of a choice's
 *   chosen option, forwards two stored members of a group, and promotes a
 *   type choice's row (type choice connected inside), each by its
 *   flattened id
 * - a root reroute CHAIN feeding one forwarded group member
 * - a named net feeding the sibling member
 * - a value source driving the promoted branch widget
 * - a selector (fixed policy) feeding a root sink
 */
import { describe, expect, it } from 'vitest'
import { compile, documentResolver, type CompileInput } from '../src/compile/compile.js'
import { loadDocument } from '../src/format/migrate.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import { solveGraphTypes } from '../src/schema/solve.js'
import type { BodyRow, InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const FLOAT: TypeExpr = { kind: 'concrete', name: 'FLOAT' }
const input = (id: string, extra?: Partial<InputSpec>): InputSpec =>
  ({ kind: 'input', id, type: IMAGE, optional: false, ...extra })
const output = (id: string, type: TypeExpr = IMAGE): OutputSpec => ({ kind: 'output', id, type })
const widget = (id: string, value: number): InputSpec => input(id, {
  type: FLOAT, optional: true, widget: { widgetType: 'FLOAT', options: {}, default: value },
})
const schemaOf = (type: string, items: BodyRow[]): NodeSchema =>
  ({ type, displayName: type, category: 'test', source: 'v3', isOutputNode: true, body: items })

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  Combo: schemaOf('Combo', [
    {
      kind: 'choice',
      id: 'mode',
      required: true,
      default: 'a',
      shared: [widget('amount', 1)],
      options: [
        { key: 'a', rows: [{ kind: 'use', id: 'amount', default: 1 }] },
        { key: 'b', rows: [{ kind: 'use', id: 'amount', default: 2 }, widget('bias', 3)] },
      ],
    },
    output('out'),
  ]),
  Fam: schemaOf('Fam', [
    {
      kind: 'group',
      id: 'images',
      value: input('img', { optional: true }),
      keys: { kind: 'numbered', prefix: 'image', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 0,
      maxMembers: 4,
    },
    output('out'),
  ]),
  Slot: schemaOf('Slot', [
    { kind: 'typeChoice', id: 'slot', type: IMAGE, rows: [widget('gain', 4)], required: false },
    output('out'),
  ]),
  Sink: schemaOf('Sink', [input('in')]),
}
const resolveBase = (type: string) => schemas[type]

/**
 * The full coexistence document, as raw JSON so loadDocument exercises the
 * real parse/migrate/invariant path rather than a pre-trusted typed value.
 */
const coexistenceJson = () => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'coexistence',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: {
        src1: { id: 'src1', type: 'Src', values: {} },
        src2: { id: 'src2', type: 'Src', values: {} },
        inst: {
          id: 'inst',
          type: '#sub',
          // The promoted type-choice row's value lives INSTANCE-side.
          values: { gain: 8 },
        },
        snk: { id: 'snk', type: 'Sink', values: {} },
        snk2: { id: 'snk2', type: 'Sink', values: {} },
      },
      links: {
        // Reroute CHAIN into a forwarded group member (image0).
        l1: { id: 'l1', from: { node: 'src1', port: 'out' }, to: { reroute: 'r1' } },
        l2: { id: 'l2', from: { reroute: 'r1' }, to: { reroute: 'r2' } },
        l3: { id: 'l3', from: { reroute: 'r2' }, to: { node: 'inst', port: 'img0' } },
        // Value source into the promoted option row.
        l4: { id: 'l4', from: { valueSource: 'vs' }, to: { node: 'inst', port: 'amount' } },
        // Instance result into a root sink.
        l5: { id: 'l5', from: { node: 'inst', port: 'result' }, to: { node: 'snk', port: 'in' } },
        // Selector branches and its resolved output.
        l6: { id: 'l6', from: { node: 'src1', port: 'out' }, to: { selector: 'sel', candidate: 'c1' } },
        l7: { id: 'l7', from: { node: 'src2', port: 'out' }, to: { selector: 'sel', candidate: 'c2' } },
        l8: { id: 'l8', from: { selector: 'sel' }, to: { node: 'snk2', port: 'in' } },
      },
      // Named net feeding the SIBLING forwarded member (image1).
      nets: {
        n1: {
          id: 'n1', name: 'feed',
          source: { node: 'src2', port: 'out' },
          sinks: [{ node: 'inst', port: 'img1' }],
        },
      },
      reroutes: { r1: { id: 'r1' }, r2: { id: 'r2' } },
      valueSources: { vs: { id: 'vs', value: 2.5, spec: { widgetType: 'FLOAT' } } },
      selectors: { sel: { id: 'sel', candidates: [{ id: 'c1' }, { id: 'c2' }], policy: { kind: 'fixed', candidate: 'c1' } } },
      nextOrdinal: 100,
    },
    sub: {
      id: 'sub',
      name: 'sub',
      nodes: {
        // The chosen option ('b') is stored DEFINITION-side, so a row of it
        // can be promoted.
        cmb2: { id: 'cmb2', type: 'Combo', values: {}, dynamic: { mode: { selected: 'b' } } },
        // Members are stored DEFINITION-side, so each one can be forwarded.
        fam: { id: 'fam', type: 'Fam', values: {}, dynamic: { images: { members: ['image0', 'image1'], seq: 2 } } },
        slot: { id: 'slot', type: 'Slot', values: {} },
      },
      // Slot connected INSIDE the definition, so its dependent is live and
      // promotable through the boundary.
      links: {
        k1: { id: 'k1', from: { node: 'fam', port: 'out' }, to: { node: 'slot', port: 'slot' } },
      },
      nets: {},
      reroutes: {},
      boundary: {
        body: [
          // promoted: the instance renders these as real widget rows (an
          // unpromoted widget-backed target derives socket-only).
          { kind: 'input', id: 'amount', promoted: true, binds: { kind: 'port', node: 'cmb2', port: 'mode.amount' } },
          { kind: 'input', id: 'img0', binds: { kind: 'port', node: 'fam', port: 'images.image0' } },
          { kind: 'input', id: 'img1', binds: { kind: 'port', node: 'fam', port: 'images.image1' } },
          { kind: 'input', id: 'gain', promoted: true, binds: { kind: 'port', node: 'slot', port: 'slot.gain' } },
          { kind: 'output', id: 'result', binds: { kind: 'port', node: 'slot', port: 'out' } },
        ],
      },
      nextOrdinal: 100,
    },
  },
  view: { graphs: { g0: { nodes: {} }, sub: { nodes: {} } } },
})

function loadCoexistence(): WorkflowDocument {
  const loaded = loadDocument(coexistenceJson())
  expect(loaded.diagnostics.filter((d) => d.severity === 'error'), JSON.stringify(loaded.diagnostics)).toEqual([])
  return loaded.document as WorkflowDocument
}

const compileInput = (document: WorkflowDocument): CompileInput => ({
  document, revision: 1, resolve: documentResolver(document, resolveBase),
  scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'coexistence-hash',
})

describe('coexistence: all constructs in one document', () => {
  it('solves cleanly: no diagnostics, no mismatch verdicts, types cross every junction', () => {
    const doc = loadCoexistence()
    const resolve = documentResolver(doc, resolveBase)
    for (const graphId of ['g0', 'sub'] as const) {
      const solved = solveGraphTypes(doc.graphs[graphId]!, resolve)
      expect(solved.diagnostics, `graph ${graphId}`).toEqual([])
      for (const [id, verdict] of solved.linkVerdicts) {
        expect(verdict, `link ${id} in ${graphId}`).not.toBe('mismatch')
      }
      for (const [key, verdict] of solved.netSinkVerdicts) {
        expect(verdict, `net sink ${key} in ${graphId}`).not.toBe('mismatch')
      }
    }
    // The boundary derives cleanly (a failed derivation would leave the
    // instance unresolvable and every check above vacuously green), and the
    // reroute chain delivers a concrete IMAGE into the forwarded member.
    expect(resolve('#sub')).toBeDefined()
    const root = solveGraphTypes(doc.graphs.g0!, resolve)
    expect(root.portTypeOf('inst' as never, 'input', 'img0')).toEqual(IMAGE)
  })

  it('compiles to the exact expected prompt with every construct lowered', () => {
    const doc = loadCoexistence()
    const before = JSON.stringify(doc)
    const result = compile(compileInput(doc))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const prompt = result.artifact.prompt

    // Choice: the definition-side key 'b' travels in slotVariants, and the
    // promoted option row takes the value-source literal (baked, not
    // linked - value sources compile away). The unpromoted row of option
    // 'b' keeps its schema default.
    expect(prompt['inst.cmb2']!.inputs).toEqual({ 'mode.amount': 2.5, 'mode.bias': 3 })
    expect(prompt['inst.cmb2']!.slotVariants).toEqual({ mode: 'b' })

    // Forwarded group members: image0 arrives through the dissolved
    // reroute chain, image1 through the compiled-away named net - both as
    // direct links under their flattened ids.
    expect(prompt['inst.fam']!.inputs).toEqual({
      'images.image0': ['src1', 0],
      'images.image1': ['src2', 0],
    })

    // Type choice connected inside the definition; its row promoted to
    // the instance and stored there.
    expect(prompt['inst.slot']!.inputs).toEqual({ slot: ['inst.fam', 0], 'slot.gain': 8 })

    // Boundary output reaches the root sink; the selector resolves to its
    // fixed candidate and records the choice in the artifact.
    expect(prompt['snk']!.inputs).toEqual({ in: ['inst.slot', 0] })
    expect(prompt['snk2']!.inputs).toEqual({ in: ['src1', 0] })
    expect(result.artifact.choices).toEqual([
      { graph: 'g0', selector: 'sel', policy: 'fixed', candidate: 'c1' },
    ])

    // Compilation is a pure read of the document.
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('a type choice with variants in the same document lowers with a slotVariants entry, changing nothing else', () => {
    // INSIDE the coexistence shape: the type choice lowers
    // construct-locally with the stored variant riding slotVariants,
    // without corrupting or silently dropping the rest of the document.
    const json = coexistenceJson()
    const g0 = json.graphs.g0 as unknown as {
      nodes: Record<string, unknown>
      links: Record<string, unknown>
    }
    g0.nodes['vslot'] = {
      id: 'vslot', type: 'VariantSlot', values: {}, dynamic: { vs: { selected: 'image' } },
    }
    g0.links['l9'] = { id: 'l9', from: { node: 'src1', port: 'out' }, to: { node: 'vslot', port: 'vs' } }
    const variantSchemas: Record<string, NodeSchema> = {
      ...schemas,
      VariantSlot: schemaOf('VariantSlot', [
        {
          kind: 'typeChoice', id: 'vs', rows: [], required: false,
          variants: [{ key: 'image', type: IMAGE, rows: [widget('strength', 1)] }],
        },
        output('out'),
      ]),
    }
    const loaded = loadDocument(json)
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const doc = loaded.document as WorkflowDocument
    const result = compile({
      ...compileInput(doc),
      resolve: documentResolver(doc, (t) => variantSchemas[t]),
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.artifact.prompt['vslot']).toEqual({
      class_type: 'VariantSlot',
      inputs: { vs: ['src1', 0], 'vs.strength': 1 },
      outputIds: ['out'],
      slotVariants: { vs: 'image' },
    })
  })
})
