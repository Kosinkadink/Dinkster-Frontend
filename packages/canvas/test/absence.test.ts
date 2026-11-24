/**
 * Maybe-absent rendering plumbing (Dinkster first-class absence, wire v3).
 *
 * Contract under test: OutputSpec.optional flows layout -> pins -> scene
 * links so the renderer can dash "this value may legitimately not exist"
 * noodles - distinctly from error/mismatch styling, because skipped is a
 * NORMAL state. Propagation must survive the same indirections everything
 * else does: reroute chains, named-net fan-out, and selectors (any
 * maybe-absent candidate marks the selector's output). And 'skipped' ranks
 * between pending and cached in subgraph state aggregation.
 */
import { describe, expect, it } from 'vitest'
import {
  documentResolver,
  type InputSpec,
  type NodeProgress,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
  type WorkflowDocument,
} from '@dinkster/core'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'
import { buildScene, nodeStatesForGraph, type Scene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const MASK: TypeExpr = { kind: 'concrete', name: 'MASK' }
const INT: TypeExpr = { kind: 'concrete', name: 'INT' }
const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const output = (id: string, extra?: Partial<OutputSpec>): OutputSpec => ({
  kind: 'output',
  id,
  type: IMAGE,
  ...extra,
})
const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  body: items,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  MaybeSrc: schemaOf('MaybeSrc', [output('out', { optional: true })]),
  Sink: schemaOf('Sink', [input('in')]),
  Sink2: schemaOf('Sink2', [input('a'), input('b')]),
  /** Two inputs of different types; bypassed, its MASK output passes on the MASK input. */
  Blend: schemaOf('Blend', [input('image'), input('mask', { type: MASK }), output('out', { type: MASK })]),
  MaskSrc: schemaOf('MaskSrc', [output('out', { type: MASK })]),
  MaskSink: schemaOf('MaskSink', [input('in', { type: MASK })]),
  Pass: schemaOf('Pass', [input('in'), output('out')]),
  IntSrc: schemaOf('IntSrc', [output('out', { type: INT })]),
  IntSink: schemaOf('IntSink', [input('in', { type: INT })]),
  /** Passes on its field's value, like a Primitive. */
  Prim: schemaOf('Prim', [
    input('value', { type: INT, widget: { widgetType: 'INT', options: {}, default: 0 } }),
    output('out', { type: INT, knownValue: { input: 'value' } }),
  ]),
}

// ---------------------------------------------------------------------------
// Document builder (same dialect as dynamic-scene.test.ts, plus selectors)
// ---------------------------------------------------------------------------

type End =
  | [node: string, port: string]
  | { reroute: string }
  | { selector: string; candidate?: string }
type GraphSpec = {
  nodes: Record<string, { type: string; mode?: 'muted' | 'bypassed' }>
  links?: [from: End, to: End][]
  reroutes?: string[]
  nets?: Record<string, { source: End; sinks: End[] }>
  /** Selector id -> candidate ids (policy: fixed on the first). */
  selectors?: Record<string, string[]>
  /** Boundary output id -> the inner node port it shows. */
  outputs?: Record<string, [node: string, port: string]>
}

const end = (e: End): unknown => (Array.isArray(e) ? { node: e[0], port: e[1] } : e)

const docOf = (graphs: Record<string, GraphSpec>): WorkflowDocument => {
  const defs: Record<string, unknown> = {}
  for (const [id, g] of Object.entries(graphs)) {
    defs[id] = {
      id,
      name: id,
      nodes: Object.fromEntries(
        Object.entries(g.nodes).map(([nid, n]) => [nid, { id: nid, type: n.type, values: {}, ...(n.mode ? { mode: n.mode } : {}) }]),
      ),
      links: Object.fromEntries(
        (g.links ?? []).map((l, i) => [`l${i}`, { id: `l${i}`, from: end(l[0]), to: end(l[1]) }]),
      ),
      nets: Object.fromEntries(
        Object.entries(g.nets ?? {}).map(([name, n]) => [
          name,
          { id: name, name, source: end(n.source), sinks: n.sinks.map(end) },
        ]),
      ),
      reroutes: Object.fromEntries((g.reroutes ?? []).map((r) => [r, { id: r }])),
      ...(g.selectors
        ? {
            selectors: Object.fromEntries(
              Object.entries(g.selectors).map(([sid, candidates]) => [
                sid,
                {
                  id: sid,
                  candidates: candidates.map((c) => ({ id: c })),
                  policy: { kind: 'fixed', candidate: candidates[0] },
                },
              ]),
            ),
          }
        : {}),
      ...(g.outputs
        ? {
            boundary: {
              inputs: [],
              outputs: Object.entries(g.outputs).map(([id, [node, port]]) => ({
                id,
                binds: { kind: 'port', node, port },
              })),
            },
          }
        : {}),
      nextOrdinal: 100,
    }
  }
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'test-lineage',
    root: 'g0',
    graphs: defs,
    view: { graphs: {} },
  } as unknown as WorkflowDocument
}

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = () => ({ viewId: 'core.line', rows: 1 })

const sceneOf = (doc: WorkflowDocument, graphId = 'g0'): Scene =>
  buildScene({
    document: doc,
    graphId,
    resolve: documentResolver(doc, (t) => schemas[t]),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })

// ---------------------------------------------------------------------------
// Scene links: traced through every indirection
// ---------------------------------------------------------------------------

describe('maybe-absent scene links', () => {
  it('a direct link from an optional output is marked; from an ordinary output it is not', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: { m: { type: 'MaybeSrc' }, s: { type: 'Src' }, k: { type: 'Sink2' } },
          links: [
            [['m', 'out'], ['k', 'a']],
            [['s', 'out'], ['k', 'b']],
          ],
        },
      }),
    )
    expect(scene.links.find((l) => l.id === 'l0')!.maybeAbsent).toBe(true)
    expect(scene.links.find((l) => l.id === 'l1')!.maybeAbsent).toBeUndefined()
  })

  it('every segment of a reroute chain from an optional output is marked', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: { m: { type: 'MaybeSrc' }, k: { type: 'Sink' } },
          links: [
            [['m', 'out'], { reroute: 'r0' }],
            [{ reroute: 'r0' }, { reroute: 'r1' }],
            [{ reroute: 'r1' }, ['k', 'in']],
          ],
          reroutes: ['r0', 'r1'],
        },
      }),
    )
    expect(scene.links).toHaveLength(3)
    for (const link of scene.links) expect(link.maybeAbsent, link.id).toBe(true)
  })

  it('named-net fan-out noodles from an optional source are all marked', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: { m: { type: 'MaybeSrc' }, k1: { type: 'Sink' }, k2: { type: 'Sink' } },
          nets: { latents: { source: ['m', 'out'], sinks: [['k1', 'in'], ['k2', 'in']] } },
        },
      }),
    )
    const netLinks = scene.links.filter((l) => l.netId === 'latents')
    expect(netLinks).toHaveLength(2)
    for (const link of netLinks) expect(link.maybeAbsent, link.id).toBe(true)
  })

  it('a selector output is marked when ANY driven candidate may be absent, unmarked otherwise', () => {
    const graph = (srcForC0: string): GraphSpec => ({
      nodes: { p: { type: srcForC0 }, q: { type: 'Src' }, k: { type: 'Sink' } },
      links: [
        [['p', 'out'], { selector: 's0', candidate: 'c0' }],
        [['q', 'out'], { selector: 's0', candidate: 'c1' }],
        [{ selector: 's0' }, ['k', 'in']],
      ],
      selectors: { s0: ['c0', 'c1'] },
    })
    const mixed = sceneOf(docOf({ g0: graph('MaybeSrc') }))
    const outLink = (s: Scene) => s.links.find((l) => l.from.kind === 'selector')!
    expect(outLink(mixed).maybeAbsent).toBe(true)
    // Feed links into the candidates reflect their own producers.
    expect(mixed.links.find((l) => l.id === 'l0')!.maybeAbsent).toBe(true)
    expect(mixed.links.find((l) => l.id === 'l1')!.maybeAbsent).toBeUndefined()

    const allSolid = sceneOf(docOf({ g0: graph('Src') }))
    expect(outLink(allSolid).maybeAbsent).toBeUndefined()
  })

  it('crosses subgraph boundaries at every level of nesting', () => {
    // g0 holds a subgraph node of 'outer', which holds one of 'inner'. Each
    // level shows 'maybe' (from an optional output) and 'plain' (from an
    // ordinary one) on its Outputs panel.
    const doc = docOf({
      g0: {
        nodes: { o: { type: '#outer' }, k1: { type: 'Sink' }, k2: { type: 'Sink' } },
        links: [
          [['o', 'maybe'], ['k1', 'in']],
          [['o', 'plain'], ['k2', 'in']],
        ],
      },
      outer: {
        nodes: { i: { type: '#inner' } },
        outputs: { maybe: ['i', 'maybe'], plain: ['i', 'plain'] },
      },
      inner: {
        nodes: { m: { type: 'MaybeSrc' }, s: { type: 'Src' } },
        outputs: { maybe: ['m', 'out'], plain: ['s', 'out'] },
      },
    })
    for (const graphId of ['inner', 'outer']) {
      const scene = sceneOf(doc, graphId)
      const intoPanel = (item: string) => scene.links.find((l) => l.id === `boundary:outputs:${item}`)!
      expect(intoPanel('maybe').maybeAbsent, graphId).toBe(true)
      expect(intoPanel('plain').maybeAbsent, graphId).toBeUndefined()
    }
    const outerPins = sceneOf(doc, 'outer').nodes.find((n) => n.id === 'i')!.layout.pins
    expect(outerPins.find((p) => p.portId === 'maybe')!.maybeAbsent).toBe(true)
    expect(outerPins.find((p) => p.portId === 'plain')!.maybeAbsent).toBeUndefined()
    const root = sceneOf(doc)
    const pins = root.nodes.find((n) => n.id === 'o')!.layout.pins
    expect(pins.find((p) => p.portId === 'maybe')!.maybeAbsent).toBe(true)
    expect(pins.find((p) => p.portId === 'plain')!.maybeAbsent).toBeUndefined()
    expect(root.links.find((l) => l.id === 'l0')!.maybeAbsent).toBe(true)
    expect(root.links.find((l) => l.id === 'l1')!.maybeAbsent).toBeUndefined()
  })
})

describe('wires out of muted nodes', () => {
  it('marks a wire out of a muted node through reroutes and named nets, and out of a muted subgraph node', () => {
    const doc = docOf({
      g0: {
        nodes: {
          m: { type: 'Src', mode: 'muted' },
          a: { type: 'Src' },
          b: { type: 'Src', mode: 'bypassed' },
          o: { type: '#sub', mode: 'muted' },
          n: { type: 'MaybeSrc', mode: 'muted' },
          k1: { type: 'Sink' },
          k2: { type: 'Sink' },
          k3: { type: 'Sink' },
          k4: { type: 'Sink' },
          k5: { type: 'Sink', mode: 'muted' },
          k6: { type: 'Sink' },
          k7: { type: 'Sink' },
        },
        links: [
          [['m', 'out'], { reroute: 'r0' }],
          [{ reroute: 'r0' }, ['k1', 'in']],
          [['a', 'out'], ['k2', 'in']],
          [['b', 'out'], ['k3', 'in']],
          [['o', 'out'], ['k4', 'in']],
          [['a', 'out'], ['k5', 'in']],
        ],
        reroutes: ['r0'],
        nets: { faces: { source: ['n', 'out'], sinks: [['k6', 'in'], ['k7', 'in']] } },
      },
      sub: { nodes: { s: { type: 'Src' } }, outputs: { out: ['s', 'out'] } },
    })
    const muted = (id: string) => sceneOf(doc).links.find((l) => l.id === id)!.sourceMuted
    expect(muted('l0'), 'into a reroute').toBe(true)
    expect(muted('l1'), 'out of a reroute').toBe(true)
    expect(muted('l2'), 'active').toBeUndefined()
    expect(muted('l3'), 'bypassed').toBeUndefined()
    expect(muted('l4'), 'muted subgraph node').toBe(true)
    expect(muted('l5'), 'into a muted node').toBeUndefined()
    const net = sceneOf(doc).links.filter((l) => l.netId === 'faces')
    expect(net).toHaveLength(2)
    for (const link of net) {
      expect(link.sourceMuted, link.id).toBe(true)
      expect(link.maybeAbsent, link.id).toBe(true)
    }
  })

  it('follows a bypassed node to the input its passthrough takes', () => {
    // Blend's MASK output passes on its MASK input, not the IMAGE one.
    const blendFedBy = (image: GraphSpec['nodes'][string], mask: GraphSpec['nodes'][string]) => sceneOf(docOf({
      g0: {
        nodes: { i: image, m: mask, b: { type: 'Blend', mode: 'bypassed' }, k: { type: 'MaskSink' } },
        links: [
          [['i', 'out'], ['b', 'image']],
          [['m', 'out'], ['b', 'mask']],
          [['b', 'out'], ['k', 'in']],
        ],
      },
    })).links.find((l) => l.id === 'l2')!.sourceMuted
    expect(blendFedBy({ type: 'Src' }, { type: 'MaskSrc', mode: 'muted' })).toBe(true)
    expect(blendFedBy({ type: 'Src', mode: 'muted' }, { type: 'MaskSrc' })).toBeUndefined()
    // Two bypassed nodes in a row, and the may-be-nothing hint the same way.
    const chain = sceneOf(docOf({
      g0: {
        nodes: {
          a: { type: 'Src', mode: 'muted' }, b1: { type: 'Pass', mode: 'bypassed' }, b2: { type: 'Pass', mode: 'bypassed' },
          m: { type: 'MaybeSrc' }, b3: { type: 'Pass', mode: 'bypassed' },
          k1: { type: 'Sink' }, k2: { type: 'Sink' },
        },
        links: [
          [['a', 'out'], ['b1', 'in']],
          [['b1', 'out'], ['b2', 'in']],
          [['b2', 'out'], ['k1', 'in']],
          [['m', 'out'], ['b3', 'in']],
          [['b3', 'out'], ['k2', 'in']],
        ],
      },
    }))
    const link = (id: string) => chain.links.find((l) => l.id === id)!
    expect(link('l2').sourceMuted).toBe(true)
    expect(link('l2').maybeAbsent).toBeUndefined()
    expect(link('l4').maybeAbsent).toBe(true)
    expect(link('l4').sourceMuted).toBeUndefined()
  })

  it('follows a node that passes on its field\'s value to the wire into that field', () => {
    const fromPrim = (feed: GraphSpec['nodes'][string] | undefined) => sceneOf(docOf({
      g0: {
        nodes: { ...(feed ? { f: feed } : {}), p: { type: 'Prim' }, k: { type: 'IntSink' } },
        links: [...(feed ? [[['f', 'out'], ['p', 'value']] as [End, End]] : []), [['p', 'out'], ['k', 'in']]],
      },
    })).links.find((l) => 'node' in l.from && l.from.node === 'p')!.sourceMuted
    expect(fromPrim({ type: 'IntSrc', mode: 'muted' })).toBe(true)
    expect(fromPrim({ type: 'IntSrc' })).toBeUndefined()
    expect(fromPrim(undefined)).toBeUndefined()
  })

  it('marks the wire into Outputs from a muted node inside a subgraph', () => {
    const doc = docOf({
      g0: { nodes: { o: { type: '#sub' } } },
      sub: {
        nodes: { s: { type: 'Src', mode: 'muted' }, t: { type: 'Src' } },
        outputs: { quiet: ['s', 'out'], loud: ['t', 'out'] },
      },
    })
    const scene = sceneOf(doc, 'sub')
    expect(scene.links.find((l) => l.id === 'boundary:outputs:quiet')!.sourceMuted).toBe(true)
    expect(scene.links.find((l) => l.id === 'boundary:outputs:loud')!.sourceMuted).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Skipped state aggregation
// ---------------------------------------------------------------------------

describe('skipped in subgraph state aggregation', () => {
  const scene = (() => {
    // A subgraph instance is not needed to exercise precedence directly, but
    // nodeStatesForGraph aggregates by instance prefix - reuse the smallest
    // doc that has one inner occurrence per instance.
    const doc = docOf({
      g0: { nodes: { s: { type: '#sub' } } },
      sub: { nodes: { a: { type: 'Src' }, b: { type: 'Sink' } } },
    })
    return sceneOf(doc)
  })()

  it('skipped outranks cached/done but yields to pending/running/error', () => {
    const states = (a: NodeProgress, b: NodeProgress): Record<string, NodeProgress> => ({
      's.a': a,
      's.b': b,
    })
    const agg = (a: NodeProgress, b: NodeProgress) => nodeStatesForGraph(states(a, b), scene)['s']
    expect(agg({ state: 'skipped' }, { state: 'done' })).toEqual({ state: 'skipped' })
    expect(agg({ state: 'skipped' }, { state: 'cached' })).toEqual({ state: 'skipped' })
    expect(agg({ state: 'skipped' }, { state: 'pending' })).toEqual({ state: 'pending' })
    expect(agg({ state: 'skipped' }, { state: 'running' })).toEqual({ state: 'running' })
    expect(agg({ state: 'skipped' }, { state: 'error' })).toEqual({ state: 'error' })
  })
})
