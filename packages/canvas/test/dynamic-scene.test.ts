/**
 * Dynamic-family canvas rendering and interaction-shaped growth.
 *
 * Contract under test: the scene lays out ELABORATED interfaces - persisted
 * members, min-fill synthetics, and one trailing ghost - through the normal
 * row/pin system, on plain nodes AND subgraph instances (boundary-derived
 * schemas. Pins/rows carry structural addresses ({port,
 * members}) plus MaterializeFrame annotations; gestures build commands from
 * THOSE, never by parsing elab keys. Ghost-landing actions batch
 * dynamic.materialize atomically with their cause: one undo
 * step, and a rejected action materializes nothing.
 *
 * Mixed integration (reroutes + value sources + nets + nested subgraph
 * dynamics composing in one graph) lives at the bottom.
 */
import { describe, expect, it } from 'vitest'
import {
  asConnectionId,
  compile,
  DocumentStore,
  coreCommandRegistry,
  documentResolver,
  loadDocument,
  occurrenceDynamicView,
  type CommandInvocation,
  type InputSpec,
  type MaterializeFrame,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
  type WorkflowDocument,
} from '@dinkster/core'
import { hitTest, hitTestPin } from '../src/hit.js'
import type { PinLayout } from '../src/layout.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'
import { buildScene, portEndKey, type Scene, type SceneLinkEnd } from '../src/scene.js'
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
const output = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })
const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  items,
})
const floatWidget = (def: number): Pick<InputSpec, 'widget'> => ({
  widget: { widgetType: 'FLOAT', options: {}, default: def },
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  // Static socket + static widget, for "no dynamic annotations" baselines.
  Sink: schemaOf('Sink', [input('in'), input('gain', { optional: true, ...floatWidget(1) })]),
  // Single-slot connectable family: image0, image1, ...
  Batch: schemaOf('Batch', [
    {
      ...input('images'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image', { optional: true })],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
      },
    },
    output('out'),
  ]),
  // Cap of 1: capacity-reached tests.
  Cap1: schemaOf('Cap1', [
    {
      ...input('images'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image', { optional: true })],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 1 },
      },
    },
    output('out'),
  ]),
  // Widget-backed family: ghost widget rows, member value keys.
  Weigh: schemaOf('Weigh', [
    {
      ...input('weights'),
      dynamic: {
        kind: 'autogrow',
        template: [input('w', { optional: true, ...floatWidget(0.5) })],
        naming: { kind: 'prefix', prefix: 'w', min: 0, max: 8 },
      },
    },
    output('out'),
  ]),
  NamedRoute: schemaOf('NamedRoute', [
    {
      ...input('values'),
      dynamic: {
        kind: 'autogrow',
        template: [input('value', { optional: true })],
        naming: { kind: 'prefix', prefix: 'value', min: 0, max: 8 },
      },
    },
    input('name', {
      type: { kind: 'concrete', name: 'core.string' },
      widget: { widgetType: 'COMBO', options: {}, optionSource: { inputFamily: 'values' } },
    }),
    output('out'),
  ]),
  // Grouped template (socket + widget) for slot-selective forwarding.
  Duo: schemaOf('Duo', [
    {
      ...input('pairs'),
      dynamic: {
        kind: 'autogrow',
        template: [
          input('image', { optional: true }),
          input('gain', { optional: true, ...floatWidget(0.5) }),
        ],
        naming: { kind: 'prefix', prefix: 'pair', min: 0, max: 4 },
      },
    },
    output('out'),
  ]),
  // min 2: min-fill synthetics below the trailing ghost.
  Min2: schemaOf('Min2', [
    {
      ...input('imgs'),
      dynamic: {
        kind: 'autogrow',
        template: [input('image', { optional: true })],
        naming: { kind: 'prefix', prefix: 'image', min: 2, max: 4 },
      },
    },
    output('out'),
  ]),
  // Autogrow-in-Autogrow: items[m] = { img, sub[k] } (static slot + construct).
  Nest: schemaOf('Nest', [
    {
      ...input('items'),
      dynamic: {
        kind: 'autogrow',
        template: [
          input('img', { optional: true }),
          {
            ...input('sub', { optional: true }),
            dynamic: {
              kind: 'autogrow',
              template: [input('s', { optional: true })],
              naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 4 },
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 5 },
      },
    },
    output('out'),
  ]),
  // Template is ONLY a nested construct: the outer ghost has nothing static
  // to render (single-ghost rule suppresses the inner tree).
  PureNest: schemaOf('PureNest', [
    {
      ...input('items'),
      dynamic: {
        kind: 'autogrow',
        template: [
          {
            ...input('sub', { optional: true }),
            dynamic: {
              kind: 'autogrow',
              template: [input('s', { optional: true })],
              naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 4 },
            },
          },
        ],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 5 },
      },
    },
    output('out'),
  ]),
  // Dynamic OUTPUT family followed by a static output.
  Split: schemaOf('Split', [
    input('src', { optional: true }),
    {
      ...output('outs'),
      dynamic: {
        kind: 'autogrow',
        template: [input('o', { optional: true })],
        naming: { kind: 'prefix', prefix: 'o', min: 0, max: 6 },
      },
    } as OutputSpec,
    output('last'),
  ]),
  Counted: schemaOf('Counted', [
    input('count', {
      type: { kind: 'concrete', name: 'core.int' },
      widget: { widgetType: 'INT', options: {}, default: 3 },
    }),
    {
      ...output('results'),
      dynamic: {
        kind: 'autogrow',
        template: [input('result', { optional: true })],
        materialization: 'wire15',
        naming: { kind: 'prefix', prefix: '', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    } as OutputSpec,
  ]),
  // Top-level DynamicCombo: selector row + branch-local values.
  Mode: schemaOf('Mode', [
    {
      kind: 'input',
      id: 'mode',
      type: { kind: 'concrete', name: 'COMBO' },
      optional: true,
      dynamic: {
        kind: 'dynamicCombo',
        options: [
          { key: 'a', inputs: [input('x', { optional: true, ...floatWidget(1) })] },
          { key: 'b', inputs: [input('y', { optional: true, ...floatWidget(9) })] },
        ],
      },
    },
    output('out'),
  ]),
  Slot: schemaOf('Slot', [
    {
      ...input('slot'),
      dynamic: {
        kind: 'dynamicSlot',
        slotType: { kind: 'wildcard' },
        variants: [
          { key: 'image', type: { kind: 'concrete', name: 'IMAGE' }, inputs: [input('strength', { optional: true, ...floatWidget(1) })] },
          { key: 'latent', type: { kind: 'concrete', name: 'LATENT' }, inputs: [] },
        ],
        inputs: [],
      },
    },
  ]),
}

// ---------------------------------------------------------------------------
// Document builder (same dialect as core's compile-forwarding tests)
// ---------------------------------------------------------------------------

type End =
  | [node: string, port: string, members?: string[]]
  | { reroute: string }
  | { valueSource: string }
type NodeSpec = {
  type: string
  values?: Record<string, unknown>
  dynamic?: Record<string, unknown>
}
type GraphSpec = {
  nodes: Record<string, NodeSpec>
  links?: [from: End, to: End][]
  reroutes?: string[]
  valueSources?: Record<string, unknown>
  nets?: Record<string, { source: End; sinks: End[] }>
  boundary?: { inputs?: unknown[]; outputs?: unknown[] }
}

const end = (e: End): unknown =>
  Array.isArray(e) ? { node: e[0], port: e[1], ...(e[2] ? { members: e[2] } : {}) } : e

const docOf = (
  graphs: Record<string, GraphSpec>,
  view?: Record<string, unknown>,
): WorkflowDocument => {
  const defs: Record<string, unknown> = {}
  for (const [id, g] of Object.entries(graphs)) {
    defs[id] = {
      id,
      name: id,
      nodes: Object.fromEntries(
        Object.entries(g.nodes).map(([nid, n]) => [
          nid,
          {
            id: nid,
            type: n.type,
            values: n.values ?? {},
            ...(n.dynamic ? { dynamic: n.dynamic } : {}),
          },
        ]),
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
      ...(g.valueSources
        ? {
            valueSources: Object.fromEntries(
              Object.entries(g.valueSources).map(([vid, value]) => [vid, { id: vid, value }]),
            ),
          }
        : {}),
      nextOrdinal: 100,
      ...(g.boundary
        ? { boundary: { inputs: g.boundary.inputs ?? [], outputs: g.boundary.outputs ?? [] } }
        : {}),
    }
  }
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'test-lineage',
    root: 'g0',
    graphs: defs,
    view: { graphs: view ?? {} },
  } as unknown as WorkflowDocument
}

/** Forwarding subgraph over one inner node: boundary input family + out port. */
const famSub = (
  innerType: string,
  innerFamily: string,
  opts?: { innerDynamic?: Record<string, unknown> },
): GraphSpec => ({
  nodes: { n: { type: innerType, ...(opts?.innerDynamic ? { dynamic: opts.innerDynamic } : {}) } },
  boundary: {
    inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: innerFamily } }],
    outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
  },
})

// ---------------------------------------------------------------------------
// Scene + store plumbing
// ---------------------------------------------------------------------------

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = (spec) =>
  spec.options['multiline'] === true ? { viewId: 'core.text', rows: 2 } : { viewId: 'core.line', rows: 1 }

const sceneOf = (doc: WorkflowDocument, graphId = 'g0'): Scene =>
  buildScene({
    document: doc,
    graphId,
    resolve: documentResolver(doc, (t) => schemas[t]),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })

const makeStore = (doc: WorkflowDocument) => new DocumentStore(doc, coreCommandRegistry())
const sceneFrom = (store: DocumentStore, graphId = 'g0'): Scene => sceneOf(store.doc, graphId)

const nodeOf = (scene: Scene, id: string) => {
  const n = scene.nodes.find((x) => x.id === id)
  expect(n, `scene node '${id}'`).toBeDefined()
  return n!
}
const pinsOf = (scene: Scene, id: string, direction: 'in' | 'out') =>
  nodeOf(scene, id).layout.pins.filter((p) => p.direction === direction)
const ghostPinsOf = (scene: Scene, id: string) =>
  nodeOf(scene, id).layout.pins.filter((p) => p.ghost)
const widgetRowsOf = (scene: Scene, id: string) =>
  nodeOf(scene, id).layout.rows.filter((r) => r.kind === 'widget')
const growthRowsOf = (scene: Scene, id: string) =>
  nodeOf(scene, id).layout.rows.filter((r) => r.kind === 'growth')
const portRowsOf = (scene: Scene, id: string) =>
  nodeOf(scene, id).layout.rows.filter((r) => r.kind === 'ports')

/** Plain frames for command params (structural copies of pin annotations). */
const framesParam = (frames: readonly MaterializeFrame[]) =>
  frames.map((f) => ({ construct: f.construct, members: [...f.members] }))

/**
 * Command-construction mirror of the interaction controller's ghost-drop
 * path: structural endpoint from pin.address, materialization batched
 * atomically when the pin (or an ancestor) is synthetic.
 */
const connectToPin = (
  store: DocumentStore,
  from: Record<string, unknown>,
  nodeId: string,
  pin: PinLayout,
  graphId = 'g0',
) => {
  const to = {
    node: nodeId,
    port: pin.address.port as string,
    ...(pin.address.members !== undefined ? { members: [...pin.address.members] } : {}),
  }
  const action = { command: 'link.connect', params: { graphId, from, to } }
  const invocation =
    pin.materialize !== undefined
      ? {
          command: 'batch',
          params: {
            invocations: [
              {
                command: 'dynamic.materialize',
                params: { graphId, nodeId, frames: framesParam(pin.materialize) },
              },
              action,
            ],
          },
        }
      : action
  return { outcome: store.dispatch(invocation as unknown as CommandInvocation), to }
}

const dynOf = (store: DocumentStore, nodeId: string, graphId = 'g0') =>
  store.doc.graphs[graphId]!.nodes[nodeId]!.dynamic

/** Every port endpoint of every scene link must anchor at a real laid-out pin. */
const expectNoDanglingEndpoints = (scene: Scene): void => {
  for (const link of scene.links) {
    // Boundary binding noodles are derived visuals: a family bind points at
    // the construct port on purpose (its anchor resolves dynamically).
    if (link.boundary) continue
    const ends: SceneLinkEnd[] = [link.from, link.to]
    for (const e of ends) {
      if (e.kind !== 'port') continue
      const node = nodeOf(scene, e.node)
      const direction = e === link.from ? 'out' : 'in'
      expect(
        node.layout.pins.some((p) => p.direction === direction && p.portId === portEndKey(e)),
        `link ${link.id}: ${direction} pin ${portEndKey(e)} on ${e.node}`,
      ).toBe(true)
    }
  }
}

// ---------------------------------------------------------------------------
// Elaborated layout on plain nodes
// ---------------------------------------------------------------------------

describe('dynamic layout on plain nodes', () => {
  it('fresh autogrow family shows one trailing ghost pin with structural address + frames', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { b: { type: 'Batch' } } } }))
    const ghosts = ghostPinsOf(scene, 'b')
    expect(ghosts).toHaveLength(1)
    const ghost = ghosts[0]!
    expect(ghost.direction).toBe('in')
    expect(ghost.portId).toBe('images.image#m0')
    expect(ghost.address).toEqual({ port: 'images.image', members: ['m0'] })
    expect(ghost.materialize).toEqual([{ construct: 'images', members: ['m0'] }])
    // The ghost's port row is annotated identically and labeled by ordinal.
    const row = portRowsOf(scene, 'b').find((r) => r.input?.portId === 'images.image#m0')!
    expect(row.input!.ghost).toBe(true)
    expect(row.input!.label).toBe('image0')
  })

  it('static pins and widget rows carry raw addresses and no dynamic annotations', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { k: { type: 'Sink' } } } }))
    const pin = pinsOf(scene, 'k', 'in').find((p) => p.portId === 'in')!
    expect(pin.address).toEqual({ port: 'in' })
    expect(pin.ghost).toBeUndefined()
    expect(pin.materialize).toBeUndefined()
    const row = widgetRowsOf(scene, 'k').find((r) => r.inputId === 'gain')!
    expect(row.valueKey).toBe('gain')
    expect(row.ghost).toBeUndefined()
    expect(row.materialize).toBeUndefined()
  })

  it('persisted members render as real pins; the ghost continues from seq, never recycling ids', () => {
    const scene = sceneOf(
      docOf({
        g0: { nodes: { b: { type: 'Batch', dynamic: { images: { members: ['m3'], seq: 4 } } } } },
      }),
    )
    const pins = pinsOf(scene, 'b', 'in')
    expect(pins.map((p) => p.portId)).toEqual(['images.image#m3', 'images.image#m4'])
    const member = pins[0]!
    expect(member.ghost).toBeUndefined()
    expect(member.materialize).toBeUndefined()
    const ghost = pins[1]!
    expect(ghost.ghost).toBe(true)
    expect(ghost.materialize).toEqual([{ construct: 'images', members: ['m4'] }])
  })

  it('capacity reached: no trailing ghost', () => {
    const scene = sceneOf(
      docOf({
        g0: { nodes: { c: { type: 'Cap1', dynamic: { images: { members: ['m0'], seq: 1 } } } } },
      }),
    )
    expect(pinsOf(scene, 'c', 'in').map((p) => p.portId)).toEqual(['images.image#m0'])
    expect(ghostPinsOf(scene, 'c')).toHaveLength(0)
  })

  it('ghost widget rows key values by the elaborated id (valueKeyOf), with frames attached', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { w: { type: 'Weigh' } } } }))
    const rows = widgetRowsOf(scene, 'w')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.ghost).toBe(true)
    expect(row.inputId).toBe('weights.w#m0')
    expect(row.valueKey).toBe('weights.w#m0')
    expect(row.spec.widgetType).toBe('FLOAT')
    expect(row.materialize).toEqual([{ construct: 'weights', members: ['m0'] }])
  })

  it('min-fill synthetics render un-ghosted with cumulative sibling frames; the ghost includes all', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { m: { type: 'Min2' } } } }))
    const pins = pinsOf(scene, 'm', 'in')
    expect(pins.map((p) => p.portId)).toEqual(['imgs.image#m0', 'imgs.image#m1', 'imgs.image#m2'])
    expect(pins.map((p) => p.ghost ?? false)).toEqual([false, false, true])
    expect(pins[0]!.materialize).toEqual([{ construct: 'imgs', members: ['m0'] }])
    expect(pins[1]!.materialize).toEqual([{ construct: 'imgs', members: ['m0', 'm1'] }])
    expect(pins[2]!.materialize).toEqual([{ construct: 'imgs', members: ['m0', 'm1', 'm2'] }])
  })

  it('nested families: inner ghost under a persisted member; none under the outer ghost (single-ghost rule)', () => {
    const scene = sceneOf(
      docOf({
        g0: { nodes: { n: { type: 'Nest', dynamic: { items: { members: ['m0'], seq: 1 } } } } },
      }),
    )
    const pins = pinsOf(scene, 'n', 'in')
    const inner = pins.find((p) => p.address.port === 'items.sub.s' && !p.ghost === false)
    expect(inner).toBeDefined()
    expect(inner!.address).toEqual({ port: 'items.sub.s', members: ['m0', 'm0'] })
    expect(inner!.materialize).toEqual([
      { construct: 'items', members: ['m0'] },
      { construct: 'items.sub', members: ['m0'] },
    ])
    // The outer trailing ghost (m1) shows its static slot but emits NO inner
    // ghost tree (single-ghost rule: at most one ghost ancestor per address).
    expect(pins.some((p) => p.address.members?.[0] === 'm1' && p.address.members.length === 1)).toBe(true)
    expect(pins.some((p) => p.address.members?.[0] === 'm1' && p.address.members.length > 1)).toBe(false)
  })

  it('nested-only template: a growth row stands in for the invisible ghost', () => {
    // The outer ghost member has no static slot and its inner ghost tree is
    // suppressed (single-ghost rule), so a fresh node has no pins to grab.
    // The elaborator replaces that ghost with an explicit growth affordance
    // row carrying the frames that persist the offered member.
    const fresh = sceneOf(docOf({ g0: { nodes: { p: { type: 'PureNest' } } } }))
    expect(pinsOf(fresh, 'p', 'in')).toHaveLength(0)
    const rows = growthRowsOf(fresh, 'p')
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'growth',
        construct: 'items',
        label: 'items',
        frames: [{ construct: 'items', members: ['m0'] }],
      }),
    ])
    // The row occupies real vertical space inside the node body, and a
    // pointer landing on it resolves to a growth hit (the click target the
    // interaction controller turns into dynamic.materialize).
    const node = nodeOf(fresh, 'p')
    expect(rows[0]!.height).toBeGreaterThan(0)
    expect(rows[0]!.y).toBeGreaterThanOrEqual(node.layout.headerHeight)
    const hit = hitTest(fresh, node.x + node.layout.width / 2, node.y + rows[0]!.y + rows[0]!.height / 2)
    expect(hit.kind).toBe('growth')
    if (hit.kind === 'growth') expect(hit.row.frames).toEqual([{ construct: 'items', members: ['m0'] }])
  })

  it('activating the growth row grows the family; undo restores the offer (one step)', () => {
    const store = makeStore(docOf({ g0: { nodes: { p: { type: 'PureNest' } } } }))
    const offer = growthRowsOf(sceneFrom(store), 'p')[0]!
    store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'p', frames: framesParam(offer.frames) },
    })
    const grown = sceneFrom(store)
    // The persisted member's inner family ghosts normally now...
    const inner = pinsOf(grown, 'p', 'in').find((p) => p.address.port === 'items.sub.s')
    expect(inner).toBeDefined()
    expect(inner!.address.members).toEqual(['m0', 'm0'])
    // ...and the NEXT outer member is offered (never recycling m0), plus the
    // inner family's own growth is reachable through its ghost pin instead.
    expect(growthRowsOf(grown, 'p')).toEqual([
      expect.objectContaining({ construct: 'items', frames: [{ construct: 'items', members: ['m1'] }] }),
    ])
    store.undo()
    const back = sceneFrom(store)
    expect(pinsOf(back, 'p', 'in')).toHaveLength(0)
    // The offer is back, but member ids are never recycled: the allocation
    // cursor survives undo, so the re-offered member is m1, not m0.
    expect(growthRowsOf(back, 'p')[0]!.frames).toEqual([{ construct: 'items', members: ['m1'] }])
  })

  it('growth rows never appear when the ghost renders slots (Nest has a static slot)', () => {
    const fresh = sceneOf(docOf({ g0: { nodes: { n: { type: 'Nest' } } } }))
    expect(growthRowsOf(fresh, 'n')).toHaveLength(0)
    expect(ghostPinsOf(fresh, 'n').length).toBeGreaterThan(0)
  })

  it('dynamic OUTPUT families ghost symmetrically, before trailing static outputs', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { s: { type: 'Split' } } } }))
    const outs = pinsOf(scene, 's', 'out')
    expect(outs.map((p) => p.portId)).toEqual(['outs.o#m0', 'last'])
    const ghost = outs[0]!
    expect(ghost.ghost).toBe(true)
    expect(ghost.address).toEqual({ port: 'outs.o', members: ['m0'] })
    expect(ghost.materialize).toEqual([{ construct: 'outs', members: ['m0'] }])
    expect(outs[1]!.address).toEqual({ port: 'last' })
  })

  it('count edits re-elaborate, re-layout, rerun solving, and preserve departing links through undo', () => {
    const document = docOf({
      g0: {
        nodes: { split: { type: 'Counted', values: { count: 3 } }, sink: { type: 'Sink' } },
        links: [[['split', 'results', ['2']], ['sink', 'in']]],
      },
    })
    const store = new DocumentStore(document, coreCommandRegistry([], (type) => schemas[type]))
    const before = sceneFrom(store)
    expect(pinsOf(before, 'split', 'out')
      .filter((pin) => pin.address.port === 'results')
      .map((pin) => pin.address.members)).toEqual([['0'], ['1'], ['2']])
    const beforeHeight = nodeOf(before, 'split').layout.height

    expect(store.dispatch({
      command: 'node.setOutputCount',
      params: {
        graphId: 'g0', nodeId: 'split', inputId: 'count', value: 1, removedLinks: 'preserve',
      },
    }).ok).toBe(true)
    const reduced = sceneFrom(store)
    expect(pinsOf(reduced, 'split', 'out')
      .filter((pin) => pin.address.port === 'results')
      .map((pin) => pin.address.members)).toEqual([['0']])
    expect(nodeOf(reduced, 'split').layout.height).toBeLessThan(beforeHeight)
    expect(reduced.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'solve.portMissing', message: expect.stringContaining("member '2'") }),
    ]))
    expect(store.doc.graphs.g0!.links.l0).toBeDefined()

    expect(store.undo()).toBe(true)
    const restored = sceneFrom(store)
    expect(pinsOf(restored, 'split', 'out')
      .filter((pin) => pin.address.port === 'results')
      .map((pin) => pin.address.members)).toEqual([['0'], ['1'], ['2']])
    expect(restored.diagnostics.some((diagnostic) => diagnostic.code === 'solve.portMissing')).toBe(false)
    expect(store.doc.graphs.g0!.links.l0).toBeDefined()
  })

  it('DynamicCombo renders a selector row (derivedValue, selectOption routing) plus branch widgets', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { m: { type: 'Mode' } } } }))
    const rows = widgetRowsOf(scene, 'm')
    const selector = rows.find((r) => r.selector !== undefined)!
    expect(selector.selector!.construct).toBe('mode')
    expect(selector.derivedValue).toBe('a')
    // Branch-local value key: construct.[option].input - switching preserves values.
    const branch = rows.find((r) => r.valueKey === 'mode.[a].x')
    expect(branch).toBeDefined()
    expect(branch!.selector).toBeUndefined()
  })

  it('renders occurrence selector state and edit ownership', () => {
    const doc = docOf({ g0: { nodes: {} }, sub: { nodes: { m: { type: 'Mode' } } } })
    const scene = buildScene({
      document: doc,
      graphId: 'sub',
      resolve: documentResolver(doc, (type) => schemas[type]),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      occurrenceView: {
        dynamic: new Map([['m', { mode: { selected: 'b' } }]]),
        selectorOwners: new Map([['m', new Map([['mode', { graphId: 'g0', nodeId: 'instance', boundaryId: 'choice' }]])]]),
      },
    })
    const selector = widgetRowsOf(scene, 'm').find((row) => row.selector !== undefined)!
    expect(selector.derivedValue).toBe('b')
    expect(selector.selector!.owner).toEqual({ graphId: 'g0', nodeId: 'instance', construct: 'choice' })
  })

  it('keeps an occurrence input-family option source bound to its persisted owner', () => {
    const doc = docOf({
      g0: { nodes: { instance: {
        type: '#sub',
        dynamic: { branches: { members: ['m0'], memberLabels: { m0: 'Primary' } } },
      } } },
      sub: {
        nodes: { route: {
          type: 'NamedRoute',
          dynamic: { values: { members: ['d0'], memberLabels: { d0: 'Default' } } },
        } },
        boundary: {
          inputs: [{ id: 'branches', binds: { kind: 'family', node: 'route', port: 'values' } }],
        },
      },
    })
    const resolve = documentResolver(doc, (type) => schemas[type])
    const occurrence = buildScene({
      document: doc,
      graphId: 'sub',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      occurrenceView: occurrenceDynamicView(doc, resolve, ['instance']),
    })

    const selector = widgetRowsOf(occurrence, 'route').find((row) => row.valueKey === 'name')!
    expect(selector.inputFamilyOwner).toEqual({
      graphId: 'g0', nodeId: 'instance', construct: 'branches', memberIds: { '\u0000m0': 'm0' },
    })
    expect(selector.familyOwner).toBeUndefined()
    expect(selector.spec.options['options']).toEqual([
      { value: 'd0', label: 'Default' },
      { value: '\u0000m0', label: 'Primary' },
    ])

    const store = makeStore(doc)
    const result = store.dispatch({
      command: 'dynamic.labelMembers',
      params: {
        graphId: selector.inputFamilyOwner!.graphId,
        nodeId: selector.inputFamilyOwner!.nodeId,
        construct: selector.inputFamilyOwner!.construct,
        labels: { [selector.inputFamilyOwner!.memberIds['\u0000m0']!]: 'Renamed' },
      },
    })
    expect(result.ok).toBe(true)
    const updatedResolve = documentResolver(store.doc, (type) => schemas[type])
    const updated = buildScene({
      document: store.doc,
      graphId: 'sub',
      resolve: updatedResolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      occurrenceView: occurrenceDynamicView(store.doc, updatedResolve, ['instance']),
    })
    expect(widgetRowsOf(updated, 'route').find((row) => row.valueKey === 'name')!.spec.options['options'])
      .toEqual([{ value: 'd0', label: 'Default' }, { value: '\u0000m0', label: 'Renamed' }])
  })

  it('renders merged occurrence family rows and annotates only suffix ownership', () => {
    const doc = docOf({
      g0: { nodes: {} },
      sub: { nodes: { n: { type: 'Weigh', dynamic: { weights: { members: ['d0'] } } } } },
    })
    const occurrenceView = {
      dynamic: new Map([['n', { weights: { members: ['d0', '\u0000s0'] } }]]),
      selectorOwners: new Map(),
      familyOwners: new Map([['n', new Map([['weights', {
        graphId: 'g0', nodeId: 'instance', boundaryId: 'forwarded',
        occurrence: { instancePath: [], node: 'instance' },
        familyPath: 'weights',
        ghostOwner: {
          graphId: 'g0', nodeId: 'instance', boundaryId: 'forwarded',
          occurrence: { instancePath: [], node: 'instance' }, sourceMember: 'm0',
          route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'weights' } }],
        },
        route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'weights' } }],
        suffixMembers: new Map([['\u0000s0', 's0']]),
        suffixOwners: new Map([['\u0000s0', {
          graphId: 'g0', nodeId: 'instance', boundaryId: 'forwarded',
          occurrence: { instancePath: [], node: 'instance' }, sourceMember: 's0',
          route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'weights' } }],
        }]]),
      }]])]]),
    }
    const occurrence = buildScene({
      document: doc, graphId: 'sub', resolve: documentResolver(doc, (type) => schemas[type]),
      tokens: defaultTokens, measure, widgetMeasure, occurrenceView: occurrenceView as any,
      occurrence: { owner: { instancePath: [], node: 'instance' as any }, plannerAvailable: true },
    })
    const rows = widgetRowsOf(occurrence, 'n').filter((row) => !row.ghost)
    expect(rows.map((row) => row.address.members?.[0])).toEqual(['d0', '\u0000s0'])
    expect(rows[0]!.familyOwner).toBeUndefined()
    expect(rows[1]!.familyOwner).toEqual({
      graphId: 'g0', nodeId: 'instance', construct: 'forwarded', valueKey: 'forwarded.w#s0',
    })
    const pins = pinsOf(occurrence, 'n', 'in')
    const prefixPin = pins.find((pin) => pin.address.members?.[0] === 'd0')!
    const suffixPin = pins.find((pin) => pin.address.members?.[0] === '\u0000s0')!
    const ghostPin = pins.find((pin) => pin.ghost)!
    expect(prefixPin.familyOwner).toBeUndefined()
    expect(suffixPin.familyOwner).toEqual({
      graphId: 'g0', nodeId: 'instance', construct: 'forwarded',
      occurrence: { instancePath: [], node: 'instance' }, familyPath: 'weights', sourceMember: 's0',
      route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'weights' } }],
      sourceEndpoint: {
        kind: 'boundary', occurrence: { instancePath: [], node: 'instance' },
        address: { port: 'forwarded.w', members: ['s0'] },
        route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'weights' } }],
      },
      socketed: true,
    })
    expect(ghostPin.familyOwner).toEqual({
      graphId: 'g0', nodeId: 'instance', construct: 'forwarded',
      occurrence: { instancePath: [], node: 'instance' }, familyPath: 'weights',
      route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'weights' } }],
      sourceEndpoint: {
        kind: 'boundary', occurrence: { instancePath: [], node: 'instance' },
        address: { port: 'forwarded.w', members: ['m0'] },
        route: [{ graph: 'sub', boundaryId: 'forwarded', binding: { kind: 'family', node: 'n', port: 'weights' } }],
      },
      socketed: true,
    })

    const definition = buildScene({
      document: doc, graphId: 'sub', resolve: documentResolver(doc, (type) => schemas[type]),
      tokens: defaultTokens, measure, widgetMeasure,
    })
    expect(widgetRowsOf(definition, 'n').filter((row) => !row.ghost).map((row) => row.address.members?.[0])).toEqual(['d0'])
  })

  it('matches compiled structural input order to canvas-visible definition prefixes and occurrence suffixes', () => {
    const doc = docOf({
      g0: {
        nodes: { suffixSource: { type: 'Src' }, s: { type: '#sub', dynamic: { forwarded: { members: ['s0'] } } } },
        links: [[['suffixSource', 'out'], ['s', 'forwarded.image', ['s0']]]],
      },
      sub: {
        nodes: {
          prefixSource: { type: 'Src' },
          n: { type: 'Batch', dynamic: { images: { members: ['d0'] } } },
        },
        links: [[['prefixSource', 'out'], ['n', 'images.image', ['d0']]]],
        boundary: {
          inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'images' } }],
          outputs: [],
        },
      },
    })
    const resolver = documentResolver(doc, (type) => schemas[type])
    const occurrenceView = occurrenceDynamicView(doc, resolver, ['s'])
    expect(occurrenceView.dynamic.get('n')?.images?.members).toEqual(['d0', '\u0000s0'])
    const scene = buildScene({
      document: doc, graphId: 'sub', resolve: resolver, tokens: defaultTokens,
      measure, widgetMeasure, occurrenceView,
    })
    const visible = pinsOf(scene, 'n', 'in')
      .filter((pin) => !pin.ghost)
      .map((pin) => ({ port: pin.address.port, members: pin.address.members }))
    expect(visible).toEqual([
      { port: 'images.image', members: ['d0'] },
      { port: 'images.image', members: ['\u0000s0'] },
    ])

    const result = compile({
      document: doc, revision: 1, resolve: (type) => schemas[type], scope: { kind: 'full' },
      connection: asConnectionId('c0'), schemaHash: 'canvas-parity',
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const compiled = Object.values(result.artifact.provenance.inputSources?.['s.n'] ?? {})
      .map((ref) => ({ port: ref.port, members: ref.members }))
    expect(compiled).toEqual(visible)
  })

  it.each([
    ['whole', undefined],
    ['grouped', ['w']],
  ] as const)('projects an occurrence-local link through the %s forwarded family route', (_name, slots) => {
    const binding = { kind: 'family' as const, node: 'n', port: 'weights', ...(slots !== undefined ? { slots } : {}) }
    const doc = docOf({
      g0: { nodes: { s: { type: '#sub', dynamic: { forwarded: { members: ['s0'] } } } } },
      sub: {
        nodes: { source: { type: 'Src' }, n: { type: 'Weigh' } },
        boundary: { inputs: [{ id: 'forwarded', binds: binding }], outputs: [] },
      },
    }) as any
    doc.occurrenceTopologies = {
      s: {
        owner: { instancePath: [], node: 's' }, bodyGraph: 'sub', nextOrdinal: 1,
        links: {
          local: {
            id: 'local',
            from: { kind: 'body', endpoint: { node: 'source', port: 'out' } },
            to: {
              kind: 'boundary', occurrence: { instancePath: [], node: 's' },
              address: { port: 'forwarded.w', members: ['s0'] },
              route: [{ graph: 'sub', boundaryId: 'forwarded', binding }],
            },
          },
        },
      },
    }
    const resolve = documentResolver(doc, (type) => schemas[type])
    const scene = buildScene({
      document: doc,
      graphId: 'sub',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      occurrenceView: occurrenceDynamicView(doc, resolve, ['s']),
      occurrence: { owner: { instancePath: [], node: 's' }, plannerAvailable: true },
    } as any)
    const link = scene.links.find((candidate) => candidate.effectiveIdentity?.kind === 'occurrence')
    expect(link?.effectiveIdentity).toEqual({ kind: 'occurrence', owner: { instancePath: [], node: 's' }, linkId: 'local' })
    expect(link?.to).toEqual({ kind: 'port', node: 'n', port: 'weights.w', members: ['\u0000s0'] })
  })

  it('keeps definition-owned links on ordinary scene ids without effective identities', () => {
    const binding = { kind: 'family' as const, node: 'n', port: 'weights' }
    const doc = docOf({
      g0: { nodes: { s: { type: '#sub', dynamic: { forwarded: { members: ['s0'] } } } } },
      sub: {
        nodes: { source: { type: 'Src' }, sink: { type: 'Sink' }, n: { type: 'Weigh' } },
        links: [[['source', 'out'], ['sink', 'in']]],
        boundary: { inputs: [{ id: 'forwarded', binds: binding }], outputs: [] },
      },
    }) as any
    doc.occurrenceTopologies = {
      s: {
        owner: { instancePath: [], node: 's' }, bodyGraph: 'sub', nextOrdinal: 1,
        links: {
          local: {
            id: 'local',
            from: { kind: 'body', endpoint: { node: 'source', port: 'out' } },
            to: {
              kind: 'boundary', occurrence: { instancePath: [], node: 's' },
              address: { port: 'forwarded.w', members: ['s0'] },
              route: [{ graph: 'sub', boundaryId: 'forwarded', binding }],
            },
          },
        },
      },
    }
    const resolve = documentResolver(doc, (type) => schemas[type])
    const drilled = buildScene({
      document: doc,
      graphId: 'sub',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      occurrenceView: occurrenceDynamicView(doc, resolve, ['s']),
      occurrence: { owner: { instancePath: [], node: 's' }, plannerAvailable: true },
    } as any)
    // The body definition's own link keeps its ordinary id and no effective
    // identity even while drilled, so it stays on definition command paths.
    const drilledDefLink = drilled.links.find((candidate) => candidate.id === 'l0')
    expect(drilledDefLink).toBeDefined()
    expect(drilledDefLink?.effectiveIdentity).toBeUndefined()
    expect(drilledDefLink?.effectiveIdentities).toBeUndefined()
    // Occurrence-owned links keep their planner-routed identity.
    const occurrenceLink = drilled.links.find((candidate) => candidate.effectiveIdentity !== undefined)
    expect(occurrenceLink?.effectiveIdentity?.kind).toBe('occurrence')
    expect(occurrenceLink?.id.startsWith('@effective:')).toBe(true)
    // A plain root scene carries no effective identities at all.
    const rootDoc = docOf({
      g0: { nodes: { source: { type: 'Src' }, sink: { type: 'Sink' } }, links: [[['source', 'out'], ['sink', 'in']]] },
    })
    const root = buildScene({
      document: rootDoc, graphId: 'g0', resolve: documentResolver(rootDoc, (type) => schemas[type]),
      tokens: defaultTokens, measure, widgetMeasure,
    })
    const rootLink = root.links.find((candidate) => candidate.id === 'l0')
    expect(rootLink).toBeDefined()
    expect(root.links.every((candidate) => candidate.effectiveIdentity === undefined && candidate.effectiveIdentities === undefined)).toBe(true)
  })

  it('DynamicSlot carries variant choice metadata through layout to its pin', () => {
    const scene = sceneOf(docOf({
      g0: {
        nodes: { s: { type: 'Slot', dynamic: { slot: { selected: 'image' } } }, p: { type: 'One' } },
        links: [[['p', 'out'], ['s', 'slot']]],
      },
    }))
    const pin = pinsOf(scene, 's', 'in').find((candidate) => candidate.address.port === 'slot')!
    expect(pin.dynamicSlot).toEqual({
      construct: 'slot',
      selected: 'image',
      ancestors: [],
      variants: [
        { key: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
        { key: 'latent', type: { kind: 'concrete', name: 'LATENT' } },
      ],
    })
  })

  it('solver diagnostics surface on the scene: a stale specialization is user-visible', () => {
    // Src produces IMAGE; a persisted 'latent' choice is stale the moment the
    // build runs. The scene must carry the advisory (replaced per build, so
    // fixing the document clears it) rather than dropping solver output.
    const docWith = (selected: string) => docOf({
      g0: {
        nodes: { s: { type: 'Slot', dynamic: { slot: { selected } } }, p: { type: 'Src' } },
        links: [[['p', 'out'], ['s', 'slot']]],
      },
    })
    const stale = sceneOf(docWith('latent'))
    expect(stale.diagnostics.map((d) => d.code)).toContain('solve.slot.staleSpecialization')
    // The diagnostic anchors to the slot pin, so the pin itself warns on
    // canvas - the user sees the ring where the problem lives, not only a
    // Problems-panel row.
    const stalePin = pinsOf(stale, 's', 'in').find((p) => p.address.port === 'slot')!
    expect(stalePin.warn).toBe(true)
    // Compatible choice: the same graph shape produces a clean scene.
    const fixed = sceneOf(docWith('image'))
    expect(fixed.diagnostics).toEqual([])
    const fixedPin = pinsOf(fixed, 's', 'in').find((p) => p.address.port === 'slot')!
    expect(fixedPin.warn).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Subgraph instances (boundary-derived schemas)
// ---------------------------------------------------------------------------

describe('dynamic layout on subgraph instances', () => {
  it('a forwarded family ghosts on a fresh instance exactly like a plain node', () => {
    const scene = sceneOf(
      docOf({
        g0: { nodes: { s: { type: '#sub' } } },
        sub: famSub('Batch', 'images'),
      }),
    )
    const instance = nodeOf(scene, 's')
    expect(instance.isSubgraph).toBe(true)
    const ghosts = ghostPinsOf(scene, 's')
    expect(ghosts).toHaveLength(1)
    expect(ghosts[0]!.address).toEqual({ port: 'fam.image', members: ['m0'] })
    expect(ghosts[0]!.materialize).toEqual([{ construct: 'fam', members: ['m0'] }])
  })

  it('definition prefix numbers first; instance suffix labels and ghost continue after it', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'], seq: 1 } } },
          },
          links: [[['a', 'out'], ['s', 'fam.image', ['m0']]]],
        },
        sub: famSub('Batch', 'images', { innerDynamic: { images: { members: ['mA'], seq: 1 } } }),
      }),
    )
    const pins = pinsOf(scene, 's', 'in')
    // The definition's prefix member is definition-local: not an instance pin.
    expect(pins.map((p) => p.portId)).toEqual(['fam.image#m0', 'fam.image#m1'])
    const rows = portRowsOf(scene, 's')
    expect(rows.find((r) => r.input?.portId === 'fam.image#m0')!.input!.label).toBe('image1')
    expect(rows.find((r) => r.input?.portId === 'fam.image#m1')!.input!.label).toBe('image2')
    // The suffix link anchors at the member pin.
    expect(scene.links).toHaveLength(1)
    expect(scene.links[0]!.to).toEqual({ kind: 'port', node: 's', port: 'fam.image', members: ['m0'] })
    const instance = nodeOf(scene, 's')
    const memberPin = pins[0]!
    expect(scene.links[0]!.y2).toBe(instance.y + memberPin.y)
  })

  it('two instances of one shared definition ghost independently', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: {
            s1: { type: '#sub', dynamic: { fam: { members: ['m0'], seq: 1 } } },
            s2: { type: '#sub' },
          },
        },
        sub: famSub('Batch', 'images'),
      }),
    )
    expect(ghostPinsOf(scene, 's1')[0]!.address).toEqual({ port: 'fam.image', members: ['m1'] })
    expect(ghostPinsOf(scene, 's2')[0]!.address).toEqual({ port: 'fam.image', members: ['m0'] })
  })

  it('autogrow-in-autogrow forwards: nested ghost under a persisted instance member', () => {
    const scene = sceneOf(
      docOf({
        g0: { nodes: { s: { type: '#sub', dynamic: { fam: { members: ['m0'], seq: 1 } } } } },
        sub: famSub('Nest', 'items'),
      }),
    )
    const inner = pinsOf(scene, 's', 'in').find((p) => p.address.port === 'fam.sub.s')
    expect(inner).toBeDefined()
    expect(inner!.address).toEqual({ port: 'fam.sub.s', members: ['m0', 'm0'] })
    expect(inner!.ghost).toBe(true)
    expect(inner!.materialize).toEqual([
      { construct: 'fam', members: ['m0'] },
      { construct: 'fam.sub', members: ['m0'] },
    ])
  })

  it('slot-selective forwarding ghosts ONLY the selected slots (hazard F10)', () => {
    const selectedSub = (slots?: string[]): GraphSpec => ({
      nodes: { n: { type: 'Duo' } },
      boundary: {
        inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'pairs', ...(slots ? { slots } : {}) } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
      },
    })
    // Whole forwarding: the ghost member stamps the socket AND the widget
    // (widget-backed inputs pin too).
    const whole = sceneOf(docOf({ g0: { nodes: { s: { type: '#sub' } } }, sub: selectedSub() }))
    expect(ghostPinsOf(whole, 's').map((p) => p.address.port)).toEqual(['fam.image', 'fam.gain'])
    expect(widgetRowsOf(whole, 's')).toHaveLength(1)
    // Selection ['image']: same ghost pin, NO widget row for the hidden gain.
    const picked = sceneOf(docOf({ g0: { nodes: { s: { type: '#sub' } } }, sub: selectedSub(['image']) }))
    expect(ghostPinsOf(picked, 's').map((p) => p.address.port)).toEqual(['fam.image'])
    expect(widgetRowsOf(picked, 's')).toHaveLength(0)
  })

  it('connecting a selected ghost slot grows the instance; hidden slots stay hidden', () => {
    const store = makeStore(
      docOf({
        g0: { nodes: { a: { type: 'Src' }, s: { type: '#sub' } } },
        sub: {
          nodes: { n: { type: 'Duo' } },
          boundary: {
            inputs: [{ id: 'fam', binds: { kind: 'family', node: 'n', port: 'pairs', slots: ['image'] } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    const ghost = ghostPinsOf(sceneFrom(store), 's')[0]!
    const { outcome } = connectToPin(store, { node: 'a', port: 'out' }, 's', ghost)
    expect(outcome.ok).toBe(true)
    expect(dynOf(store, 's')).toEqual({ fam: { members: ['m0'], seq: 1 } })
    // The definition is untouched; the grown member renders the selected
    // socket (plus a fresh trailing ghost) and still no widget rows.
    expect(store.doc.graphs['sub']!.nodes['n']!.dynamic).toBeUndefined()
    const scene = sceneFrom(store)
    const inPins = pinsOf(scene, 's', 'in').map((p) => ({ port: p.address.port, ghost: p.ghost }))
    expect(inPins).toEqual([
      { port: 'fam.image', ghost: undefined },
      { port: 'fam.image', ghost: true },
    ])
    expect(widgetRowsOf(scene, 's')).toHaveLength(0)
    expectNoDanglingEndpoints(scene)
  })

  it('keeps a dotted endpoint unique and its schema label friendly through connect, open, undo, and redo', () => {
    const store = makeStore(docOf({
      g0: { nodes: { src: { type: 'Src' }, instance: { type: '#sub' } } },
      sub: {
        nodes: { sink: { type: 'Sink' } },
        boundary: {
          inputs: [{ id: 'images.images_m0', binds: { kind: 'port', node: 'sink', port: 'in' } }],
          outputs: [],
        },
      },
    }))
    const instancePin = pinsOf(sceneFrom(store), 'instance', 'in')[0]!
    expect(instancePin.address).toEqual({ port: 'images.images_m0' })
    expect(portRowsOf(sceneFrom(store), 'instance')[0]!.input!.label).toBe('In')

    const { outcome } = connectToPin(store, { node: 'src', port: 'out' }, 'instance', instancePin)
    expect(outcome.ok).toBe(true)
    expect(Object.values(store.doc.graphs.g0!.links)[0]!.to).toEqual({ node: 'instance', port: 'images.images_m0' })
    expect(pinsOf(sceneFrom(store), 'instance', 'in')).toHaveLength(1)

    const opened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
    expect(Object.values(opened.graphs.g0!.links)[0]!.to).toEqual({ node: 'instance', port: 'images.images_m0' })
    expect(portRowsOf(sceneOf(opened), 'instance')[0]!.input!.label).toBe('In')

    expect(store.undo()).toBe(true)
    expect(Object.keys(store.doc.graphs.g0!.links)).toEqual([])
    expect(store.redo()).toBe(true)
    expect(Object.values(store.doc.graphs.g0!.links)[0]!.to).toEqual({ node: 'instance', port: 'images.images_m0' })
    expect(portRowsOf(sceneFrom(store), 'instance')[0]!.input!.label).toBe('In')
  })
})

// ---------------------------------------------------------------------------
// Boundary pseudo-nodes over dynamic definitions
// ---------------------------------------------------------------------------

describe('boundary pseudo-nodes with dynamic boundaries', () => {
  it('a forwarded family renders one Inputs pin whose noodle anchors at the live family pin', () => {
    const scene = sceneOf(docOf({ sub: famSub('Batch', 'images') }), 'sub')
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    // ONE pin for the whole family (plus the trailing blank expose slot),
    // marked with the family suffix.
    expect(inputs.layout.pins.map((p) => p.portId)).toEqual(['fam', '__add__'])
    const row = inputs.layout.rows.find((r) => r.kind === 'ports')!
    expect((row.kind === 'ports' && row.output?.label) || undefined).toBe('Images []')

    const bind = scene.links.find((l) => l.id === 'boundary:inputs:fam')!
    expect(bind.boundary).toBe(true)
    expect(bind.from).toEqual({ kind: 'boundary', side: 'inputs', item: 'fam' })
    expect(bind.to).toMatchObject({ kind: 'port', node: 'n', port: 'images' })
    // The fresh definition family elaborates one trailing ghost; the noodle
    // anchors there instead of dangling or inventing a construct pin.
    const n = nodeOf(scene, 'n')
    const ghost = n.layout.pins.find((p) => p.ghost && p.direction === 'in')!
    expect(ghost.address.port).toBe('images.image')
    expect(bind.x2).toBe(n.x)
    expect(bind.y2).toBe(n.y + ghost.y)
  })

  it('the anchor follows persisted members (first matching member pin wins)', () => {
    const scene = sceneOf(
      docOf({
        sub: famSub('Batch', 'images', { innerDynamic: { images: { members: ['mA', 'mB'], seq: 2 } } }),
      }),
      'sub',
    )
    const n = nodeOf(scene, 'n')
    const first = n.layout.pins.find(
      (p) => p.direction === 'in' && p.address.port === 'images.image' && !p.ghost,
    )!
    expect(first.address.members).toEqual(['mA'])
    const bind = scene.links.find((l) => l.id === 'boundary:inputs:fam')!
    expect(bind.y2).toBe(n.y + first.y)
  })

  it('boundary item ids stay opaque: dots in ids never split identity', () => {
    const scene = sceneOf(
      docOf({
        sub: {
          nodes: { n: { type: 'Sink' } },
          boundary: {
            inputs: [{ id: 'weird.id', binds: { kind: 'port', node: 'n', port: 'in' } }],
            outputs: [],
          },
        },
      }),
      'sub',
    )
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    expect(inputs.layout.pins.map((p) => p.portId)).toEqual(['weird.id', '__add__'])
    const row = inputs.layout.rows.find((candidate) => candidate.kind === 'ports')!
    expect(row.kind === 'ports' && row.output?.label).toBe('In')
    const bind = scene.links.find((l) => l.boundary)!
    expect(bind.id).toBe('boundary:inputs:weird.id')
    expect(bind.from).toEqual({ kind: 'boundary', side: 'inputs', item: 'weird.id' })
    expect(bind.to).toMatchObject({ kind: 'port', node: 'n', port: 'in' })
  })

  it('an empty definition still places both panels at finite defaults', () => {
    const scene = sceneOf(
      docOf({ sub: { nodes: {}, boundary: { inputs: [], outputs: [] } } }),
      'sub',
    )
    expect(scene.boundaryNodes.map((b) => b.side).sort()).toEqual(['inputs', 'outputs'])
    for (const b of scene.boundaryNodes) {
      expect(Number.isFinite(b.x)).toBe(true)
      expect(Number.isFinite(b.y)).toBe(true)
    }
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    const outputs = scene.boundaryNodes.find((b) => b.side === 'outputs')!
    expect(inputs.x + inputs.layout.width).toBeLessThan(outputs.x)
  })

  it('instances never show boundary panels; the definition scene always does', () => {
    const doc = docOf({
      g0: { nodes: { s: { type: '#sub' } } },
      sub: famSub('Batch', 'images'),
    })
    expect(sceneOf(doc).boundaryNodes).toEqual([])
    expect(sceneOf(doc, 'sub').boundaryNodes.map((b) => b.side).sort()).toEqual(['inputs', 'outputs'])
  })
})

// ---------------------------------------------------------------------------
// Interaction-shaped growth: commands built from pin annotations
// ---------------------------------------------------------------------------

describe('ghost interactions dispatch structural, atomic commands', () => {
  it('connecting into an instance ghost materializes + connects in ONE step; the definition is untouched', () => {
    const store = makeStore(
      docOf({
        g0: { nodes: { a: { type: 'Src' }, s: { type: '#sub' } } },
        sub: famSub('Batch', 'images'),
      }),
    )
    const ghost = ghostPinsOf(sceneFrom(store), 's')[0]!
    const { outcome, to } = connectToPin(store, { node: 'a', port: 'out' }, 's', ghost)
    expect(outcome.ok).toBe(true)
    expect(to).toEqual({ node: 's', port: 'fam.image', members: ['m0'] })
    expect(dynOf(store, 's')).toEqual({ fam: { members: ['m0'], seq: 1 } })
    // Shared definition untouched: growing an instance never mutates it.
    expect(dynOf(store, 'n', 'sub')).toBeUndefined()

    const scene = sceneFrom(store)
    expect(scene.links).toHaveLength(1)
    expect(scene.links[0]!.to).toEqual({ kind: 'port', node: 's', port: 'fam.image', members: ['m0'] })
    expect(scene.links[0]!.typeName).toBe('IMAGE')
    // The member pin is real now; a NEW trailing ghost follows.
    const pins = pinsOf(scene, 's', 'in')
    expect(pins.map((p) => [p.portId, p.ghost ?? false])).toEqual([
      ['fam.image#m0', false],
      ['fam.image#m1', true],
    ])
    expectNoDanglingEndpoints(scene)

    // ONE undo step reverts both the link and the materialization. Undo
    // leaves only the allocation cursor (hash-neutral bookkeeping), so the
    // next offered member is m1 -- ids are never reused.
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 's')).toEqual({ fam: { seq: 1 } })
    const reverted = sceneFrom(store)
    expect(reverted.links).toHaveLength(0)
    expect(ghostPinsOf(reverted, 's')[0]!.address.members).toEqual(['m1'])
  })

  it('a rejected connect materializes NOTHING (batch is atomic)', () => {
    const store = makeStore(
      docOf({
        g0: { nodes: { s: { type: '#sub' } } },
        sub: famSub('Batch', 'images'),
      }),
    )
    const ghost = ghostPinsOf(sceneFrom(store), 's')[0]!
    const { outcome } = connectToPin(store, { node: 'ghostville', port: 'out' }, 's', ghost)
    expect(outcome.ok).toBe(false)
    expect(dynOf(store, 's')).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

  it('reroute -> forwarded ghost: traced type survives, member endpoint lands structurally', () => {
    const store = makeStore(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, s: { type: '#sub' } },
          reroutes: ['r0'],
          links: [[['a', 'out'], { reroute: 'r0' }]],
        },
        sub: famSub('Batch', 'images'),
      }),
    )
    const ghost = ghostPinsOf(sceneFrom(store), 's')[0]!
    const { outcome } = connectToPin(store, { reroute: 'r0' }, 's', ghost)
    expect(outcome.ok).toBe(true)
    const scene = sceneFrom(store)
    const hop = scene.links.find((l) => l.from.kind === 'reroute')!
    expect(hop.to).toEqual({ kind: 'port', node: 's', port: 'fam.image', members: ['m0'] })
    expect(hop.typeName).toBe('IMAGE')
    expect(ghostPinsOf(scene, 's')[0]!.address.members).toEqual(['m1'])
    expectNoDanglingEndpoints(scene)
  })

  it('value source -> ghost widget member: spec derives from the member consumer', () => {
    const store = makeStore(
      docOf({
        g0: { nodes: { w: { type: 'Weigh' } }, valueSources: { v0: 0.75 } },
      }),
    )
    const scene0 = sceneFrom(store)
    const row = widgetRowsOf(scene0, 'w')[0]!
    expect(row.ghost).toBe(true)
    // Connect from the source into the ghost member (widget rows expose the
    // same structural address as pins).
    const asPin: PinLayout = {
      portId: row.inputId,
      direction: 'in',
      y: 0,
      type: row.type,
      address: row.address,
      ...(row.materialize !== undefined ? { materialize: row.materialize } : {}),
    }
    const { outcome } = connectToPin(store, { valueSource: 'v0' }, 'w', asPin)
    expect(outcome.ok).toBe(true)

    const scene = sceneFrom(store)
    expect(scene.valueSources).toHaveLength(1)
    const vs = scene.valueSources[0]!
    // Effective spec derives through the MEMBER consumer (member-aware lookup).
    expect(vs.specState).toBe('derived')
    expect(vs.effective.spec?.widgetType).toBe('FLOAT')
    const link = scene.links[0]!
    expect(link.from).toEqual({ kind: 'valueSource', valueSource: 'v0' })
    expect(link.to).toEqual({ kind: 'port', node: 'w', port: 'weights.w', members: ['m0'] })
    // The connected member widget input keeps a pin so the noodle anchors.
    expectNoDanglingEndpoints(scene)
  })

  it('editing a ghost widget batches materialize + setValue as one undo step', () => {
    const store = makeStore(docOf({ g0: { nodes: { w: { type: 'Weigh' } } } }))
    const row = widgetRowsOf(sceneFrom(store), 'w')[0]!
    const outcome = store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'dynamic.materialize',
            params: { graphId: 'g0', nodeId: 'w', frames: framesParam(row.materialize!) },
          },
          {
            command: 'node.setValue',
            params: { graphId: 'g0', nodeId: 'w', inputId: row.valueKey, value: 0.9 },
          },
        ],
      },
    } as unknown as CommandInvocation)
    expect(outcome.ok).toBe(true)
    expect(dynOf(store, 'w')).toEqual({ weights: { members: ['m0'], seq: 1 } })
    expect(store.doc.graphs['g0']!.nodes['w']!.values['weights.w#m0']).toBe(0.9)

    const scene = sceneFrom(store)
    const rows = widgetRowsOf(scene, 'w')
    expect(rows.map((r) => [r.valueKey, r.ghost ?? false])).toEqual([
      ['weights.w#m0', false],
      ['weights.w#m1', true],
    ])

    // Undo reverts member + value in one step; only the allocation cursor
    // remains (never-reuse bookkeeping, hash-neutral).
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'w')).toEqual({ weights: { seq: 1 } })
    expect(store.doc.graphs['g0']!.nodes['w']!.values['weights.w#m0']).toBeUndefined()
  })

  it('hit testing a ghost pin surfaces its address + frames for the gesture', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { b: { type: 'Batch' } } } }))
    const node = nodeOf(scene, 'b')
    const ghost = ghostPinsOf(scene, 'b')[0]!
    const hit = hitTestPin(scene, node.x, node.y + ghost.y)
    expect(hit).toBeDefined()
    expect(hit!.pin.address).toEqual({ port: 'images.image', members: ['m0'] })
    expect(hit!.pin.ghost).toBe(true)
    expect(hit!.pin.materialize).toEqual([{ construct: 'images', members: ['m0'] }])
  })
})

// ---------------------------------------------------------------------------
// Named nets with member endpoints
// ---------------------------------------------------------------------------

describe('named nets over dynamic members', () => {
  const netDoc = (view?: Record<string, unknown>) =>
    docOf(
      {
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'], seq: 1 } } },
          },
          nets: { latents: { source: ['a', 'out'], sinks: [['s', 'fam.image', ['m0']]] } },
        },
        sub: famSub('Batch', 'images'),
      },
      view,
    )

  it('expanded: the net renders as a noodle anchored at the member pin', () => {
    const scene = sceneOf(netDoc())
    const net = scene.links.find((l) => l.netId === 'latents')!
    expect(net.to).toEqual({ kind: 'port', node: 's', port: 'fam.image', members: ['m0'] })
    const instance = nodeOf(scene, 's')
    const pin = instance.layout.pins.find((p) => p.portId === 'fam.image#m0')!
    expect(net.y2).toBe(instance.y + pin.y)
    expectNoDanglingEndpoints(scene)
  })

  it('net commands round-trip member paths: create from a member output, delete a member sink', () => {
    // Dynamic OUTPUT member as a net source (the promote-to-net path).
    const store = makeStore(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            sp: { type: 'Split', dynamic: { outs: { members: ['m0'], seq: 1 } } },
            s: { type: '#sub', dynamic: { fam: { members: ['m0'], seq: 1 } } },
          },
          nets: { latents: { source: ['a', 'out'], sinks: [['s', 'fam.image', ['m0']]] } },
        },
        sub: famSub('Batch', 'images'),
      }),
    )
    const created = store.dispatch({
      command: 'net.create',
      params: { graphId: 'g0', name: 'branches', source: { node: 'sp', port: 'outs.o', members: ['m0'] } },
    } as unknown as CommandInvocation)
    expect(created.ok).toBe(true)
    const nets = Object.values(store.doc.graphs['g0']!.nets)
    const branches = nets.find((n) => n.name === 'branches')!
    expect(branches.source).toEqual({ node: 'sp', port: 'outs.o', members: ['m0'] })

    // Deleting a member sink must pass the FULL PortRef (node+port+members).
    const deleted = store.dispatch({
      command: 'graph.deleteItems',
      params: {
        graphId: 'g0',
        nodeIds: [],
        linkIds: [],
        netSinks: [{ node: 's', port: 'fam.image', members: ['m0'] }],
        rerouteIds: [],
        valueSourceIds: [],
      },
    } as unknown as CommandInvocation)
    expect(deleted.ok).toBe(true)
    const latents = Object.values(store.doc.graphs['g0']!.nets).find((n) => n.name === 'latents')
    expect(latents?.sinks ?? []).toHaveLength(0)
  })

  it('collapsed: the sink stub carries the member path and anchors at the member pin', () => {
    const scene = sceneOf(netDoc({ g0: { nodes: {}, collapsedNets: ['latents'] } }))
    // Collapsed: the delivery stays a (hidden) scene link for connectivity.
    expect(scene.links.filter((l) => l.netId === 'latents').map((l) => l.hidden)).toEqual([true])
    const sink = scene.netStubs.find((st) => st.role === 'sink')!
    expect(sink.portId).toBe('fam.image')
    expect(sink.members).toEqual(['m0'])
    const instance = nodeOf(scene, 's')
    const pin = instance.layout.pins.find((p) => p.portId === 'fam.image#m0')!
    expect(sink.pinY).toBe(instance.y + pin.y)
    expect(sink.typeName).toBe('IMAGE')
  })
})

// ---------------------------------------------------------------------------
// Mixed robustness: everything composing in one graph
// ---------------------------------------------------------------------------

describe('mixed dynamic robustness', () => {
  it('reroutes + value sources + nets + nested subgraph dynamics compose without dangling state', () => {
    const store = makeStore(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: '#batchSub' },
            t: { type: '#batchSub' },
            n: { type: '#nestSub', dynamic: { fam: { members: ['m0'], seq: 1 } } },
            w: { type: 'Weigh' },
          },
          reroutes: ['r0'],
          valueSources: { v0: 0.25 },
          links: [[['a', 'out'], { reroute: 'r0' }]],
          nets: { pipe: { source: ['a', 'out'], sinks: [] } },
        },
        batchSub: famSub('Batch', 'images'),
        nestSub: famSub('Nest', 'items'),
      }),
    )

    // 1) Grow instance s through the reroute; instance t must not move.
    const g1 = ghostPinsOf(sceneFrom(store), 's')[0]!
    expect(connectToPin(store, { reroute: 'r0' }, 's', g1).outcome.ok).toBe(true)
    expect(dynOf(store, 's')).toEqual({ fam: { members: ['m0'], seq: 1 } })
    expect(dynOf(store, 't')).toBeUndefined()

    // 2) Grow the NESTED forwarded family on n (inner ghost under member m0).
    const nested = pinsOf(sceneFrom(store), 'n', 'in').find((p) => p.address.port === 'fam.sub.s')!
    expect(connectToPin(store, { node: 'a', port: 'out' }, 'n', nested).outcome.ok).toBe(true)
    expect(dynOf(store, 'n')).toEqual({
      fam: { members: ['m0'], seq: 1, memberState: { m0: { 'fam.sub': { members: ['m0'], seq: 1 } } } },
    })

    // 3) Value source into a ghost widget member on w.
    const row = widgetRowsOf(sceneFrom(store), 'w')[0]!
    const rowPin: PinLayout = {
      portId: row.inputId,
      direction: 'in',
      y: 0,
      type: row.type,
      address: row.address,
      ...(row.materialize !== undefined ? { materialize: row.materialize } : {}),
    }
    expect(connectToPin(store, { valueSource: 'v0' }, 'w', rowPin).outcome.ok).toBe(true)

    // The composed scene: every noodle anchored, every ghost advanced.
    const scene = sceneFrom(store)
    expectNoDanglingEndpoints(scene)
    expect(ghostPinsOf(scene, 's')[0]!.address.members).toEqual(['m1'])
    expect(ghostPinsOf(scene, 't')[0]!.address.members).toEqual(['m0'])
    // n grew its INNER family: outer ghost m1 plus fresh inner ghost m1 under m0.
    const nPins = pinsOf(scene, 'n', 'in')
    expect(nPins.some((p) => p.address.port === 'fam.sub.s' && p.address.members?.[1] === 'm1' && p.ghost)).toBe(true)
    // Reroute noodles keep the traced IMAGE type through the member endpoint.
    expect(scene.links.find((l) => l.from.kind === 'reroute')!.typeName).toBe('IMAGE')

    // Unwind EVERYTHING: each grow was exactly one undo step. Allocation
    // cursors survive undo (never-reuse), so cursor-only skeletons remain.
    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 's')).toEqual({ fam: { seq: 1 } })
    // n's undone INNER growth leaves a nested cursor-only skeleton too.
    expect(dynOf(store, 'n')).toEqual({
      fam: { members: ['m0'], seq: 1, memberState: { m0: { 'fam.sub': { seq: 1 } } } },
    })
    expect(dynOf(store, 'w')).toEqual({ weights: { seq: 1 } })
    expectNoDanglingEndpoints(sceneFrom(store))
  })
})

// ---------------------------------------------------------------------------
// Full persisted-member lifecycle matrix
// ---------------------------------------------------------------------------

describe('autogrow persisted-member lifecycle matrix', () => {
  const cases = [
    { name: 'direct whole', type: 'Batch', node: 'target', construct: 'images', port: 'images.image', grouped: false, forwarded: false },
    { name: 'direct grouped', type: 'Duo', node: 'target', construct: 'pairs', port: 'pairs.image', grouped: true, forwarded: false },
    { name: 'forwarded whole', type: 'Batch', node: 'target', construct: 'fam', port: 'fam.image', grouped: false, forwarded: true },
    { name: 'forwarded grouped', type: 'Duo', node: 'target', construct: 'fam', port: 'fam.image', grouped: true, forwarded: true },
  ] as const

  for (const testCase of cases) {
    it(`${testCase.name}: automatic disconnect compaction is one undo step and never reuses identity`, () => {
      const document = testCase.forwarded
        ? docOf({
            g0: { nodes: { source: { type: 'Src' }, target: { type: '#sub' } } },
            sub: famSub(testCase.type, testCase.type === 'Batch' ? 'images' : 'pairs'),
          })
        : docOf({ g0: { nodes: { source: { type: 'Src' }, target: { type: testCase.type } } } })
      const store = makeStore(document)
      const firstScene = sceneFrom(store)
      const firstGhosts = ghostPinsOf(firstScene, testCase.node)
      expect(firstGhosts.map((pin) => pin.address.members)).toEqual(
        Array.from({ length: testCase.grouped ? 2 : 1 }, () => ['m0']),
      )

      const landing = firstGhosts.find((pin) => pin.address.port === testCase.port)!
      expect(connectToPin(store, { node: 'source', port: 'out' }, testCase.node, landing).outcome.ok).toBe(true)
      expect(dynOf(store, testCase.node)).toEqual({
        [testCase.construct]: { members: ['m0'], seq: 1 },
      })
      const connected = sceneFrom(store)
      expect(pinsOf(connected, testCase.node, 'in').filter((pin) =>
        !pin.ghost && pin.address.members?.[0] === 'm0')).toHaveLength(testCase.grouped ? 2 : 1)
      expectNoDanglingEndpoints(connected)
      expect(new Set(pinsOf(connected, testCase.node, 'in').map((pin) => pin.portId)).size)
        .toBe(pinsOf(connected, testCase.node, 'in').length)
      expect(ghostPinsOf(connected, testCase.node).map((pin) => pin.address.members)).toEqual(
        Array.from({ length: testCase.grouped ? 2 : 1 }, () => ['m1']),
      )
      expect(Object.values(store.doc.graphs.g0!.links)).toHaveLength(1)
      expect(Object.values(store.doc.graphs.g0!.links)[0]!.to).toEqual({
        node: testCase.node, port: testCase.port, members: ['m0'],
      })

      // Save/export/open is canonical JSON through the real loader. The
      // persisted member/link identity and exactly one trailing ghost survive.
      const saved = JSON.parse(JSON.stringify(store.doc))
      const reopened = loadDocument(saved)
      expect(reopened.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
      const reopenedStore = makeStore(reopened.document!)
      expect(dynOf(reopenedStore, testCase.node)).toEqual(dynOf(store, testCase.node))
      expect(Object.values(reopenedStore.doc.graphs.g0!.links)[0]!.to).toEqual(
        Object.values(store.doc.graphs.g0!.links)[0]!.to,
      )
      expectNoDanglingEndpoints(sceneFrom(reopenedStore))

      // Drill into a forwarded definition and back out without changing the
      // owner-side id. Occurrence rebasing is view-only (NUL-prefixed inside).
      if (testCase.forwarded) {
        const resolver = documentResolver(reopenedStore.doc, (type) => schemas[type])
        const occurrence = occurrenceDynamicView(reopenedStore.doc, resolver, ['target'])
        const inner = buildScene({
          document: reopenedStore.doc, graphId: 'sub', resolve: resolver, tokens: defaultTokens,
          measure, widgetMeasure, occurrenceView: occurrence,
        })
        expect(pinsOf(inner, 'n', 'in').some((pin) => pin.address.members?.[0] === '\u0000m0')).toBe(true)
        expect(Object.values(reopenedStore.doc.graphs.g0!.links)[0]!.to).toMatchObject({ members: ['m0'] })
        expectNoDanglingEndpoints(sceneFrom(reopenedStore))
      }

      const linkId = Object.keys(reopenedStore.doc.graphs.g0!.links)[0]!
      expect(reopenedStore.dispatch({
        command: 'batch',
        params: {
          invocations: [
            { command: 'link.disconnect', params: { graphId: 'g0', linkId } },
            { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: testCase.node } },
          ],
        },
      }).ok).toBe(true)
      expect(dynOf(reopenedStore, testCase.node)).toEqual({ [testCase.construct]: { seq: 1 } })
      const compacted = sceneFrom(reopenedStore)
      expect(ghostPinsOf(compacted, testCase.node).map((pin) => pin.address.members)).toEqual(
        Array.from({ length: testCase.grouped ? 2 : 1 }, () => ['m1']),
      )
      expectNoDanglingEndpoints(compacted)

      // A stale endpoint cannot recreate the retired socket. Growth must go
      // through the offered m1 ghost and its materialization batch.
      expect(reopenedStore.dispatch({
        command: 'link.connect',
        params: {
          graphId: 'g0', from: { node: 'source', port: 'out' },
          to: { node: testCase.node, port: testCase.port, members: ['m0'] },
        },
      }).ok).toBe(false)
      expect(dynOf(reopenedStore, testCase.node)).toEqual({ [testCase.construct]: { seq: 1 } })

      // Disconnect and compact are one history entry. Undo restores the exact
      // member and link together but never rewinds the allocator cursor.
      expect(reopenedStore.undo()).toBe(true)
      expect(dynOf(reopenedStore, testCase.node)).toEqual({
        [testCase.construct]: { members: ['m0'], seq: 1 },
      })
      expect(Object.values(reopenedStore.doc.graphs.g0!.links)[0]!.to).toMatchObject({ members: ['m0'] })
      expect(reopenedStore.redo()).toBe(true)
      expect(dynOf(reopenedStore, testCase.node)).toEqual({ [testCase.construct]: { seq: 1 } })

      // Compile never promotes the nonpersisted trailing ghost. With no live
      // link after redo, no m1 API input may appear in the artifact.
      const compiled = compile({
        document: reopenedStore.doc, revision: reopenedStore.revision,
        resolve: (type) => schemas[type], scope: { kind: 'full' },
        connection: asConnectionId('c0'), schemaHash: 'autogrow-lifecycle',
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (compiled.ok)
        expect(JSON.stringify(compiled.artifact.prompt)).not.toContain('m1')
    })
  }
})
