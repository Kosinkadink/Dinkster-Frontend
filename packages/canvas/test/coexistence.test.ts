/**
 * Coexistence scene regression: the SAME maximal document as
 * core/test/coexistence.test.ts (kept as a structural twin - core owns the
 * pipeline contract, this file owns the visuals), rendered through
 * buildScene. Every construct must appear simultaneously - instance pins for
 * forwarded group members, promoted widget rows, reroutes,
 * a value-source pill, a selector box, net stubs, boundary pseudo-nodes in
 * the definition - with zero diagnostics and no swallowed elements: every
 * noodle anchors at a real laid-out pin.
 */
import { describe, expect, it } from 'vitest'
import {
  documentResolver,
  loadDocument,
  type BodyRow,
  type InputSpec,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildScene, type Scene, type SceneLinkEnd } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

// ---------------------------------------------------------------------------
// Schemas + document: structural twin of core/test/coexistence.test.ts.
// Change one, change both - the core test proves the document loads, solves,
// and compiles; this one proves the same document RENDERS.
// ---------------------------------------------------------------------------

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
          values: { gain: 8 },
        },
        snk: { id: 'snk', type: 'Sink', values: {} },
        snk2: { id: 'snk2', type: 'Sink', values: {} },
      },
      links: {
        l1: { id: 'l1', from: { node: 'src1', port: 'out' }, to: { reroute: 'r1' } },
        l2: { id: 'l2', from: { reroute: 'r1' }, to: { reroute: 'r2' } },
        l3: { id: 'l3', from: { reroute: 'r2' }, to: { node: 'inst', port: 'img0' } },
        l4: { id: 'l4', from: { valueSource: 'vs' }, to: { node: 'inst', port: 'amount' } },
        l5: { id: 'l5', from: { node: 'inst', port: 'result' }, to: { node: 'snk', port: 'in' } },
        l6: { id: 'l6', from: { node: 'src1', port: 'out' }, to: { selector: 'sel', candidate: 'c1' } },
        l7: { id: 'l7', from: { node: 'src2', port: 'out' }, to: { selector: 'sel', candidate: 'c2' } },
        l8: { id: 'l8', from: { selector: 'sel' }, to: { node: 'snk2', port: 'in' } },
      },
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
        cmb2: { id: 'cmb2', type: 'Combo', values: {}, dynamic: { mode: { selected: 'b' } } },
        fam: { id: 'fam', type: 'Fam', values: {}, dynamic: { images: { members: ['image0', 'image1'], seq: 2 } } },
        slot: { id: 'slot', type: 'Slot', values: {} },
      },
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

// ---------------------------------------------------------------------------
// Scene plumbing (same conventions as dynamic-scene.test.ts)
// ---------------------------------------------------------------------------

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = (spec) =>
  spec.options['multiline'] === true ? { viewId: 'core.text', rows: 2 } : { viewId: 'core.line', rows: 1 }

function loadCoexistence(): WorkflowDocument {
  const loaded = loadDocument(coexistenceJson())
  expect(loaded.diagnostics.filter((d) => d.severity === 'error'), JSON.stringify(loaded.diagnostics)).toEqual([])
  return loaded.document as WorkflowDocument
}

const sceneOf = (doc: WorkflowDocument, graphId: string): Scene =>
  buildScene({
    document: doc,
    graphId,
    resolve: documentResolver(doc, (t) => schemas[t]),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })

const nodeOf = (scene: Scene, id: string) => {
  const n = scene.nodes.find((x) => x.id === id)
  expect(n, `scene node '${id}'`).toBeDefined()
  return n!
}
const pinsOf = (scene: Scene, id: string, direction: 'in' | 'out') =>
  nodeOf(scene, id).layout.pins.filter((p) => p.direction === direction)
const widgetRowsOf = (scene: Scene, id: string) =>
  nodeOf(scene, id).layout.rows.filter((r) => r.kind === 'widget')

/** Every port endpoint of every scene link must anchor at a real laid-out pin. */
const expectNoDanglingEndpoints = (scene: Scene): void => {
  for (const link of scene.links) {
    // Boundary binding noodles are derived visuals, checked separately.
    if (link.boundary) continue
    const ends: SceneLinkEnd[] = [link.from, link.to]
    for (const e of ends) {
      if (e.kind !== 'port') continue
      const node = nodeOf(scene, e.node)
      const direction = e === link.from ? 'out' : 'in'
      expect(
        node.layout.pins.some((p) => p.direction === direction && p.portId === e.port),
        `link ${link.id}: ${direction} pin ${e.port} on ${e.node}`,
      ).toBe(true)
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('coexistence: every construct renders in one scene', () => {
  const doc = loadCoexistence()
  const root = sceneOf(doc, 'g0')
  const sub = sceneOf(doc, 'sub')

  it('no scene noodle dangles: every port endpoint anchors at a laid-out pin', () => {
    expectNoDanglingEndpoints(root)
    expectNoDanglingEndpoints(sub)
  })

  it('the instance renders via its derived boundary schema with all promoted surfaces at once', () => {
    const inst = nodeOf(root, 'inst')
    expect(inst.isSubgraph).toBe(true)
    expect(inst.missingSchema).toBeUndefined()

    // Forwarded group members: each stored member is one plain pin under
    // its boundary id, with no offered member beside them.
    const inPins = pinsOf(root, 'inst', 'in')
    expect(inPins.filter((p) => p.portId === 'img0' || p.portId === 'img1').map((p) => p.portId)).toEqual(['img0', 'img1'])
    expect(inPins.filter((p) => p.ghost)).toEqual([])

    // The promoted option row and the promoted type-choice row are real
    // widget rows storing under the boundary id.
    const rows = widgetRowsOf(root, 'inst')
    expect(rows.find((r) => r.inputId === 'amount')?.valueKey).toBe('amount')
    expect(rows.find((r) => r.inputId === 'gain')?.valueKey).toBe('gain')

    // Boundary output is a real out pin feeding the root sink.
    expect(pinsOf(root, 'inst', 'out').some((p) => p.portId === 'result')).toBe(true)
    expect(root.links.find((l) => l.id === 'l5')!.from).toMatchObject({ kind: 'port', node: 'inst', port: 'result' })
  })

  it('reroute chain, value-source pill, selector box, and net stubs all coexist', () => {
    // Reroute chain: both hops render and the final hop lands on the
    // forwarded member image0's pin, carrying the traced IMAGE type.
    expect(root.reroutes.map((r) => r.id).sort()).toEqual(['r1', 'r2'])
    const l3 = root.links.find((l) => l.id === 'l3')!
    expect(l3.from).toEqual({ kind: 'reroute', reroute: 'r2' })
    expect(l3.to).toMatchObject({ kind: 'port', node: 'inst', port: 'img0' })
    expect(l3.typeName).toBe('IMAGE')

    // Value source: a FLOAT pill with its declared spec and literal text,
    // wired into the promoted option row.
    expect(root.valueSources.map((v) => v.id)).toEqual(['vs'])
    const vs = root.valueSources[0]!
    expect(vs.effective.spec?.widgetType).toBe('FLOAT')
    expect(vs.valueText).toBe('2.5')
    expect(root.links.find((l) => l.id === 'l4')!.to).toMatchObject({ kind: 'port', node: 'inst', port: 'amount' })

    // Selector: both candidates driven (homogeneous IMAGE), fixed policy
    // marks the active candidate, output feeds the second sink.
    expect(root.selectors.map((s) => s.id)).toEqual(['sel'])
    const sel = root.selectors[0]!
    expect(sel.candidates.map((c) => c.typeName)).toEqual(['IMAGE', 'IMAGE'])
    expect(sel.typeName).toBe('IMAGE')
    expect(sel.activeCandidate).toBe('c1')
    expect(sel.random).toBe(false)
    expect(root.links.find((l) => l.id === 'l8')!.from).toEqual({ kind: 'selector', selector: 'sel' })

    // Named net (uncollapsed): renders as a real tagged noodle into the
    // instance's img1 pin - coexisting with the DIRECT link into sibling
    // img0.
    const netLink = root.links.find((l) => l.netId === 'n1')!
    expect(netLink.netName).toBe('feed')
    expect(netLink.from).toMatchObject({ kind: 'port', node: 'src2', port: 'out' })
    expect(netLink.to).toEqual({ kind: 'port', node: 'inst', port: 'img1' })
    expect(netLink.typeName).toBe('IMAGE')
  })

  it('collapsing the net swaps its noodle for endpoint tags without disturbing anything else', () => {
    const collapsedDoc = {
      ...doc,
      view: { ...doc.view, graphs: { ...doc.view.graphs, g0: { nodes: {}, collapsedNets: ['n1'] } } },
    } as WorkflowDocument
    const scene = sceneOf(collapsedDoc, 'g0')
    expect(scene.diagnostics).toEqual([])
    // The delivery stays a scene link, flagged hidden so tags paint instead.
    expect(scene.links.filter((l) => l.netId === 'n1').map((l) => l.hidden)).toEqual([true])
    const stubs = scene.netStubs.filter((s) => s.netId === 'n1')
    expect(stubs.map((s) => [s.role, s.nodeId] as const).sort()).toEqual([
      ['sink', 'inst'],
      ['source', 'src2'],
    ])
    for (const stub of stubs) expect(stub.name).toBe('feed')
    // Everything else survives the view change untouched.
    expectNoDanglingEndpoints(scene)
    expect(scene.selectors).toHaveLength(1)
    expect(scene.valueSources).toHaveLength(1)
    expect(scene.reroutes).toHaveLength(2)
  })

  it('the definition scene shows boundary pseudo-nodes binding a row of every construct kind', () => {
    const inputs = sub.boundaryNodes.find((b) => b.side === 'inputs')!
    expect(inputs.layout.pins.map((p) => p.portId)).toEqual(['amount', 'img0', 'img1', 'gain', '__add__'])
    const outputs = sub.boundaryNodes.find((b) => b.side === 'outputs')!
    expect(outputs.layout.pins.map((p) => p.portId)).toContain('result')

    // Each binding noodle reaches its inner target node.
    const bindTargets = sub.links
      .filter((l) => l.boundary && l.id.startsWith('boundary:inputs:'))
      .map((l) => [l.id, (l.to as { node?: string }).node] as const)
      .sort()
    expect(bindTargets).toEqual([
      ['boundary:inputs:amount', 'cmb2'],
      ['boundary:inputs:gain', 'slot'],
      ['boundary:inputs:img0', 'fam'],
      ['boundary:inputs:img1', 'fam'],
    ])

    // cmb2 keeps the rows of its definition-side option 'b' (flattened
    // value keys), while the type choice's row is revealed by the INSIDE
    // connection.
    const cmb2Rows = widgetRowsOf(sub, 'cmb2')
    expect(cmb2Rows.some((r) => r.valueKey === 'mode.amount')).toBe(true)
    expect(cmb2Rows.some((r) => r.valueKey === 'mode.bias')).toBe(true)
    expect(widgetRowsOf(sub, 'slot').some((r) => r.inputId === 'slot.gain')).toBe(true)
    const k1 = sub.links.find((l) => l.id === 'k1')!
    expect(k1.to).toMatchObject({ kind: 'port', node: 'slot', port: 'slot' })
  })
})
