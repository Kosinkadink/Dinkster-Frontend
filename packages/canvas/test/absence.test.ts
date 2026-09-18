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
  items,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  MaybeSrc: schemaOf('MaybeSrc', [output('out', { optional: true })]),
  Sink: schemaOf('Sink', [input('in')]),
  Sink2: schemaOf('Sink2', [input('a'), input('b')]),
}

// ---------------------------------------------------------------------------
// Document builder (same dialect as dynamic-scene.test.ts, plus selectors)
// ---------------------------------------------------------------------------

type End =
  | [node: string, port: string]
  | { reroute: string }
  | { selector: string; candidate?: string }
type GraphSpec = {
  nodes: Record<string, { type: string }>
  links?: [from: End, to: End][]
  reroutes?: string[]
  nets?: Record<string, { source: End; sinks: End[] }>
  /** Selector id -> candidate ids (policy: fixed on the first). */
  selectors?: Record<string, string[]>
}

const end = (e: End): unknown => (Array.isArray(e) ? { node: e[0], port: e[1] } : e)

const docOf = (graphs: Record<string, GraphSpec>): WorkflowDocument => {
  const defs: Record<string, unknown> = {}
  for (const [id, g] of Object.entries(graphs)) {
    defs[id] = {
      id,
      name: id,
      nodes: Object.fromEntries(
        Object.entries(g.nodes).map(([nid, n]) => [nid, { id: nid, type: n.type, values: {} }]),
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

const sceneOf = (doc: WorkflowDocument): Scene =>
  buildScene({
    document: doc,
    graphId: 'g0',
    resolve: documentResolver(doc, (t) => schemas[t]),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })

// ---------------------------------------------------------------------------
// Layout: optional outputs mark their pins
// ---------------------------------------------------------------------------

describe('maybe-absent pins', () => {
  it('an optional output pin carries maybeAbsent; ordinary outputs do not', () => {
    const scene = sceneOf(
      docOf({ g0: { nodes: { m: { type: 'MaybeSrc' }, s: { type: 'Src' } } } }),
    )
    const pin = (id: string) =>
      scene.nodes.find((n) => n.id === id)!.layout.pins.find((p) => p.direction === 'out')!
    expect(pin('m').maybeAbsent).toBe(true)
    expect(pin('s').maybeAbsent).toBeUndefined()
  })
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
