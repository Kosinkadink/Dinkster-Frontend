/**
 * Group, choice and type-choice rendering on the canvas, and growth shaped
 * like the interaction controller's gestures.
 *
 * Contract under test: the scene lays out ELABORATED interfaces - stored
 * members, members offered up to a group's minimum, and one spare member -
 * through the normal row/pin system. Every port is addressed by its
 * flattened id (`images.image0`); an offered member's pins and rows carry
 * the MaterializeFrame that stores it. Gestures build commands from THOSE
 * annotations, never by parsing ids. A gesture that lands on an offered
 * member batches dynamic.materialize atomically with its cause: one undo
 * step, and a rejected action materializes nothing.
 *
 * Mixed integration (reroutes + value sources + nets + nested groups
 * composing in one graph) lives at the bottom.
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
  parseDinksterSchema,
  type BodyRow,
  type CommandInvocation,
  type InputSpec,
  type MaterializeFrame,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
  type WorkflowDocument,
} from '@dinkster/core'
import { hitTest } from '../src/hit.js'
import type { PinLayout } from '../src/layout.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'
import { buildScene, type Scene, type SceneLinkEnd } from '../src/scene.js'
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
const schemaOf = (type: string, items: BodyRow[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true,
  body: items,
})
const floatWidget = (def: number): Pick<InputSpec, 'widget'> => ({
  widget: { widgetType: 'FLOAT', options: {}, default: def },
})
/** A group grown by links, its members keyed `<prefix>0`, `<prefix>1`, ... */
const group = (
  id: string,
  prefix: string,
  rows: { value: InputSpec | OutputSpec } | { member: BodyRow[] },
  minMembers: number,
  maxMembers: number,
): BodyRow => ({
  kind: 'group',
  id,
  ...rows,
  keys: { kind: 'numbered', prefix, start: 0, pad: 0 },
  grows: 'link',
  minMembers,
  maxMembers,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  // Static socket + static widget, for "no dynamic annotations" baselines.
  Sink: schemaOf('Sink', [input('in'), input('gain', { optional: true, ...floatWidget(1) })]),
  // Group of one connectable value: images.image0, images.image1, ...
  Batch: schemaOf('Batch', [group('images', 'image', { value: input('image', { optional: true }) }, 0, 4), output('out')]),
  // Cap of 1: capacity-reached tests.
  Cap1: schemaOf('Cap1', [group('images', 'image', { value: input('image', { optional: true }) }, 0, 1), output('out')]),
  // Group of widget-backed values: offered widget rows, member value keys.
  Weigh: schemaOf('Weigh', [group('weights', 'w', { value: input('w', { optional: true, ...floatWidget(0.5) }) }, 0, 8), output('out')]),
  // Group of records (socket + widget).
  Duo: schemaOf('Duo', [
    group('pairs', 'pair', { member: [input('image', { optional: true }), input('gain', { optional: true, ...floatWidget(0.5) })] }, 0, 4),
    output('out'),
  ]),
  // min 2: members offered up to the minimum.
  Min2: schemaOf('Min2', [group('imgs', 'image', { value: input('image', { optional: true }) }, 2, 4), output('out')]),
  // Group in a group: items.<item> = { img, sub.<sub> }.
  Nest: schemaOf('Nest', [
    group('items', 'item', { member: [
      input('img', { optional: true }),
      group('sub', 'sub', { value: input('s', { optional: true }) }, 0, 4),
    ] }, 0, 5),
    output('out'),
  ]),
  // A member of only a group: the spare outer member has nothing to draw.
  PureNest: schemaOf('PureNest', [
    group('items', 'item', { member: [group('sub', 'sub', { value: input('s', { optional: true }) }, 0, 4)] }, 0, 5),
    output('out'),
  ]),
  // Group of outputs followed by a static output.
  Split: schemaOf('Split', [
    input('src', { optional: true }),
    group('outs', 'o', { value: output('o') }, 0, 6),
    output('last'),
  ]),
  // Top-level choice: dropdown row + rows of the chosen option.
  Mode: schemaOf('Mode', [
    {
      kind: 'choice',
      id: 'mode',
      required: true,
      shared: [],
      options: [
        { key: 'a', rows: [input('x', { optional: true, ...floatWidget(1) })] },
        { key: 'b', rows: [input('y', { optional: true, ...floatWidget(9) })] },
      ],
    },
    output('out'),
  ]),
  Slot: schemaOf('Slot', [
    {
      kind: 'typeChoice',
      id: 'slot',
      required: true,
      rows: [],
      variants: [
        { key: 'image', type: { kind: 'concrete', name: 'IMAGE' }, rows: [input('strength', { optional: true, ...floatWidget(1) })] },
        { key: 'latent', type: { kind: 'concrete', name: 'LATENT' }, rows: [] },
      ],
    },
  ]),
}

// ---------------------------------------------------------------------------
// Document builder (same dialect as core's compile-forwarding tests)
// ---------------------------------------------------------------------------

type End =
  | [node: string, port: string]
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

const end = (e: End): unknown => (Array.isArray(e) ? { node: e[0], port: e[1] } : e)

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
  frames.map((f) => ({ construct: f.construct, members: [...f.members], ...(f.seq !== undefined ? { seq: f.seq } : {}) }))

/**
 * Command-construction mirror of the interaction controller's ghost-drop
 * path: endpoint from pin.address, materialization batched atomically when
 * the pin (or a group around it) is offered but not stored.
 */
const connectToPin = (
  store: DocumentStore,
  from: Record<string, unknown>,
  nodeId: string,
  pin: PinLayout,
  graphId = 'g0',
) => {
  const to = { node: nodeId, port: pin.address.port as string }
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

/** A widget row as the pin the controller would connect a value source to. */
const rowAsPin = (row: ReturnType<typeof widgetRowsOf>[number]): PinLayout => ({
  portId: row.inputId,
  direction: 'in',
  y: 0,
  type: row.type,
  address: row.address,
  ...(row.materialize !== undefined ? { materialize: row.materialize } : {}),
})

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
// Elaborated layout on plain nodes
// ---------------------------------------------------------------------------

describe('dynamic layout on plain nodes', () => {
  it('a fresh group shows one spare member pin with its flattened id and frame', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { b: { type: 'Batch' } } } }))
    const ghosts = ghostPinsOf(scene, 'b')
    expect(ghosts).toHaveLength(1)
    const ghost = ghosts[0]!
    expect(ghost.direction).toBe('in')
    expect(ghost.portId).toBe('images.image0')
    expect(ghost.address).toEqual({ port: 'images.image0' })
    expect(ghost.materialize).toEqual([{ construct: 'images', members: ['image0'], seq: 1 }])
    // The spare member's port row is annotated identically and labeled by position.
    const row = portRowsOf(scene, 'b').find((r) => r.input?.portId === 'images.image0')!
    expect(row.input!.ghost).toBe(true)
    expect(row.input!.label).toBe('image 1')
  })

  it('stored members render as real pins; the spare continues from seq, never reusing keys', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, b: { type: 'Batch', dynamic: { images: { members: ['image3'], seq: 4 } } } },
          links: [[['a', 'out'], ['b', 'images.image3']]],
        },
      }),
    )
    const pins = pinsOf(scene, 'b', 'in')
    expect(pins.map((p) => p.portId)).toEqual(['images.image3', 'images.image4'])
    const member = pins[0]!
    expect(member.ghost).toBeUndefined()
    expect(member.materialize).toBeUndefined()
    const ghost = pins[1]!
    expect(ghost.ghost).toBe(true)
    expect(ghost.materialize).toEqual([{ construct: 'images', members: ['image4'], seq: 5 }])
  })

  it('capacity reached: no spare member', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, c: { type: 'Cap1', dynamic: { images: { members: ['image0'], seq: 1 } } } },
          links: [[['a', 'out'], ['c', 'images.image0']]],
        },
      }),
    )
    expect(pinsOf(scene, 'c', 'in').map((p) => p.portId)).toEqual(['images.image0'])
    expect(ghostPinsOf(scene, 'c')).toHaveLength(0)
  })

  it('members offered up to the minimum carry cumulative frames', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { m: { type: 'Min2' } } } }))
    const pins = pinsOf(scene, 'm', 'in')
    expect(pins.map((p) => p.portId)).toEqual(['imgs.image0', 'imgs.image1'])
    expect(pins.map((p) => p.ghost ?? false)).toEqual([true, true])
    expect(pins[0]!.materialize).toEqual([{ construct: 'imgs', members: ['image0'], seq: 1 }])
    expect(pins[1]!.materialize).toEqual([{ construct: 'imgs', members: ['image0', 'image1'], seq: 2 }])
  })

  it('nested groups: an inner spare under a stored member; none under the outer spare', () => {
    const scene = sceneOf(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, n: { type: 'Nest', dynamic: { items: { members: ['item0'], seq: 1 } } } },
          links: [[['a', 'out'], ['n', 'items.item0.img']]],
        },
      }),
    )
    const pins = pinsOf(scene, 'n', 'in')
    const inner = pins.find((p) => p.address.port === 'items.item0.sub.sub0')
    expect(inner).toBeDefined()
    expect(inner!.ghost).toBe(true)
    expect(inner!.materialize).toEqual([{ construct: 'items.item0.sub', members: ['sub0'], seq: 1 }])
    // The outer spare (item1) shows its own input but no inner group members.
    expect(pins.some((p) => p.address.port === 'items.item1.img')).toBe(true)
    expect(pins.some((p) => p.address.port.startsWith('items.item1.sub.'))).toBe(false)
  })

  it('a member of only a group: a growth row stands in for the spare member', () => {
    // The spare outer member has no row of its own and its inner group
    // offers nothing, so a fresh node has no pins to grab. The elaborator
    // replaces that member with an explicit growth row carrying the frame
    // that stores it.
    const fresh = sceneOf(docOf({ g0: { nodes: { p: { type: 'PureNest' } } } }))
    expect(pinsOf(fresh, 'p', 'in')).toHaveLength(0)
    const rows = growthRowsOf(fresh, 'p')
    expect(rows).toEqual([
      expect.objectContaining({
        kind: 'growth',
        construct: 'items',
        label: 'items',
        frames: [{ construct: 'items', members: ['item0'], seq: 1 }],
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
    if (hit.kind === 'growth') expect(hit.row.frames).toEqual([{ construct: 'items', members: ['item0'], seq: 1 }])
  })

  it('activating the growth row stores the member; undo restores the offer (one step)', () => {
    const store = makeStore(docOf({ g0: { nodes: { p: { type: 'PureNest' } } } }))
    const offer = growthRowsOf(sceneFrom(store), 'p')[0]!
    store.dispatch({
      command: 'dynamic.materialize',
      params: { graphId: 'g0', nodeId: 'p', frames: framesParam(offer.frames) },
    })
    expect(dynOf(store, 'p')).toEqual({ items: { members: ['item0'], seq: 1 } })
    const grown = sceneFrom(store)
    // The stored member's inner group offers its spare member now.
    const inner = pinsOf(grown, 'p', 'in').find((p) => p.address.port === 'items.item0.sub.sub0')
    expect(inner).toBeDefined()
    expect(inner!.ghost).toBe(true)
    store.undo()
    const back = sceneFrom(store)
    expect(pinsOf(back, 'p', 'in')).toHaveLength(0)
    // The offer is back, but member keys are never reused: the allocation
    // cursor survives undo, so the re-offered member is item1, not item0.
    expect(growthRowsOf(back, 'p')[0]!.frames).toEqual([{ construct: 'items', members: ['item1'], seq: 2 }])
  })

  it('a group of outputs offers its spare symmetrically, in its own box', () => {
    const scene = sceneOf(docOf({ g0: { nodes: { s: { type: 'Split' } } } }))
    const outs = pinsOf(scene, 's', 'out')
    // The node's own output pairs with its own input row; the group's
    // members sit in the group's box below it.
    expect(outs.map((p) => p.portId)).toEqual(['last', 'outs.o0'])
    const ghost = outs[1]!
    expect(ghost.ghost).toBe(true)
    expect(ghost.address).toEqual({ port: 'outs.o0' })
    expect(ghost.materialize).toEqual([{ construct: 'outs', members: ['o0'], seq: 1 }])
    expect(outs[0]!.address).toEqual({ port: 'last' })
    expect(nodeOf(scene, 's').layout.boxes).toMatchObject([{ id: 'group:outs', kind: 'group' }])
  })

  it("a choice renders its dropdown row (derivedValue, selector routing) plus the chosen option's widgets", () => {
    const scene = sceneOf(docOf({ g0: { nodes: { m: { type: 'Mode' } } } }))
    const rows = widgetRowsOf(scene, 'm')
    const selector = rows.find((r) => r.selector !== undefined)!
    expect(selector.selector!.construct).toBe('mode')
    expect(selector.derivedValue).toBe('a')
    // The option's row stores under its flattened id: construct.input.
    const branch = rows.find((r) => r.valueKey === 'mode.x')
    expect(branch).toBeDefined()
    expect(branch!.selector).toBeUndefined()
  })

  it.each([false, true])('respects choice visibility hidden=%s while retaining execution', (hidden) => {
    const schema = parseDinksterSchema('HiddenSelector', {
      outputNode: true,
      body: [{ kind: 'choice', id: 'codec', hidden, options: [
        { key: 'auto', rows: [] },
        { key: 'custom', rows: [
          { kind: 'input', id: 'quality', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
          { kind: 'input', id: 'internal', type: { kind: 'concrete', types: ['INT'] }, default: 13, hidden: true },
        ] },
      ] }],
    }).schema!
    const doc = docOf({ g0: { nodes: { m: {
      type: 'HiddenSelector', values: { 'codec.quality': 29, 'codec.internal': 31 },
      dynamic: { codec: { selected: 'custom' } },
    } } } })
    const before = JSON.stringify(doc)
    const resolve = (type: string) => type === schema.type ? schema : undefined
    const scene = buildScene({ document: doc, graphId: 'g0', resolve, tokens: defaultTokens, measure, widgetMeasure })
    expect(widgetRowsOf(scene, 'm').map((row) => row.inputId)).toEqual(hidden ? [] : ['codec', 'codec.quality'])
    // The dropdown has no socket; only the option's field does.
    expect(pinsOf(scene, 'm', 'in').map((pin) => pin.address.port)).toEqual(hidden ? [] : ['codec.quality'])
    const result = compile({ document: doc, revision: 0, resolve, scope: { kind: 'full' }, connection: asConnectionId('hidden-selector'), schemaHash: 'hidden-selector' })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('hidden selector compilation failed')
    expect(result.artifact.prompt.m!.inputs).toEqual({ 'codec.quality': 29, 'codec.internal': 31 })
    expect(result.artifact.prompt.m!.slotVariants).toEqual({ codec: 'custom' })
    expect(JSON.stringify(doc)).toBe(before)
  })

  it.each(['local', 'promoted', 'promoted-member'] as const)('routes authored menu edits to the %s stored scope', (mode) => {
    const choice = input('choice', { widget: { widgetType: 'COMBO', editableOptions: true, options: { options: ['schema'] } } })
    const menu = schemaOf('EditableMenu', mode === 'promoted' ? [choice] : [group('items', 'item', { member: [choice] }, 0, 4)])
    const doc = docOf({
      g0: { nodes: { instance: { type: '#sub', values: mode === 'promoted-member' ? { menu: 'outer value' } : {} } } },
      sub: { nodes: { n: { type: menu.type, values: { choice: 'outside' },
        dynamic: mode === 'promoted' ? {} : { items: { members: ['item0'], seq: 1 } },
      } }, boundary: { inputs: mode === 'local' ? [] : [{ id: 'menu', promoted: true,
        binds: { kind: 'port', node: 'n', port: mode === 'promoted-member' ? 'items.item0.choice' : 'choice' },
      }] } },
    })
    const resolve = documentResolver(doc, (type) => type === menu.type ? menu : undefined)
    const occurrenceView = occurrenceDynamicView(doc, resolve, ['instance'])
    if (mode === 'promoted-member') expect(occurrenceView.values.get('n')).toMatchObject({ 'items.item0.choice': 'outer value' })
    const scene = buildScene({ document: doc, graphId: 'sub', resolve, tokens: defaultTokens, measure, widgetMeasure,
      occurrenceView,
    })
    const rows = widgetRowsOf(scene, 'n')
    const row = rows.find((candidate) => !candidate.ghost)!
    const target = row.optionsTarget!
    expect(target).toBeDefined()
    const owner = target.owner ?? { graphId: 'sub', nodeId: 'n', ...target }
    // A group member's state lives under its flattened id, with no member nesting.
    expect(owner).toEqual(mode.startsWith('promoted')
      ? { graphId: 'g0', nodeId: 'instance', construct: 'menu' }
      : { graphId: 'sub', nodeId: 'n', construct: 'items.item0.choice' })
    const store = new DocumentStore(doc, coreCommandRegistry([], resolve))
    const result = store.dispatch({ command: 'dynamic.setOptions', params: { ...owner, options: [false, 0, 'duplicate', 'duplicate'] } })
    expect(result.ok).toBe(true)
    const node = store.doc.graphs[owner.graphId]!.nodes[owner.nodeId]!
    expect(node.dynamic?.[owner.construct]?.options).toEqual([false, 0, 'duplicate', 'duplicate'])
    expect(store.doc.graphs.sub!.nodes.n!.values).toEqual({ choice: 'outside' })
    if (mode === 'local') {
      // The edited menu is what the row offers.
      const edited = widgetRowsOf(buildScene({ document: store.doc, graphId: 'sub', resolve: documentResolver(store.doc, (type) => type === menu.type ? menu : undefined),
        tokens: defaultTokens, measure, widgetMeasure }), 'n').find((candidate) => candidate.valueKey === 'items.item0.choice')!
      expect(edited.spec.options['options']).toEqual([false, 0, 'duplicate', 'duplicate'])
    }
    store.undo()
    expect(store.doc).toEqual(doc)
  })

  it('solver diagnostics surface on the scene: a stale specialization is user-visible', () => {
    // Src produces IMAGE; a stored 'latent' variant is stale the moment the
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
    expect(stale.diagnostics.find((d) => d.code === 'solve.slot.staleSpecialization')?.anchor?.port?.port).toBe('slot')
    // Compatible choice: the same graph shape produces a clean scene.
    const fixed = sceneOf(docWith('image'))
    expect(fixed.diagnostics).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Subgraph instances (boundary-derived schemas)
// ---------------------------------------------------------------------------

describe('subgraph instance endpoints', () => {
  it('keeps a dotted endpoint unique and its exact label through connect, open, undo, and redo', () => {
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
    expect(portRowsOf(sceneFrom(store), 'instance')[0]!.input!.label).toBe('in')

    const { outcome } = connectToPin(store, { node: 'src', port: 'out' }, 'instance', instancePin)
    expect(outcome.ok).toBe(true)
    expect(Object.values(store.doc.graphs.g0!.links)[0]!.to).toEqual({ node: 'instance', port: 'images.images_m0' })
    expect(pinsOf(sceneFrom(store), 'instance', 'in')).toHaveLength(1)

    const opened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
    expect(Object.values(opened.graphs.g0!.links)[0]!.to).toEqual({ node: 'instance', port: 'images.images_m0' })
    expect(portRowsOf(sceneOf(opened), 'instance')[0]!.input!.label).toBe('in')

    expect(store.undo()).toBe(true)
    expect(Object.keys(store.doc.graphs.g0!.links)).toEqual([])
    expect(store.redo()).toBe(true)
    expect(Object.values(store.doc.graphs.g0!.links)[0]!.to).toEqual({ node: 'instance', port: 'images.images_m0' })
    expect(portRowsOf(sceneFrom(store), 'instance')[0]!.input!.label).toBe('in')
  })
})

// ---------------------------------------------------------------------------
// Boundary pseudo-nodes
// ---------------------------------------------------------------------------

describe('boundary pseudo-nodes', () => {
  it('a forwarded group member renders one Inputs pin whose noodle anchors at that member pin', () => {
    const scene = sceneOf(
      docOf({
        sub: {
          nodes: { n: { type: 'Batch', dynamic: { images: { members: ['image0', 'image1'], seq: 2 } } } },
          boundary: { inputs: [{ id: 'second', binds: { kind: 'port', node: 'n', port: 'images.image1' } }], outputs: [] },
        },
      }),
      'sub',
    )
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    expect(inputs.layout.pins.map((p) => p.portId)).toEqual(['second', '__add__'])
    const bind = scene.links.find((l) => l.id === 'boundary:inputs:second')!
    expect(bind.boundary).toBe(true)
    expect(bind.from).toEqual({ kind: 'boundary', side: 'inputs', item: 'second' })
    expect(bind.to).toMatchObject({ kind: 'port', node: 'n', port: 'images.image1' })
    const n = nodeOf(scene, 'n')
    const pin = n.layout.pins.find((p) => p.direction === 'in' && p.address.port === 'images.image1')!
    expect(bind.x2).toBe(n.x)
    expect(bind.y2).toBe(n.y + pin.y)
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
    expect(row.kind === 'ports' && row.output?.label).toBe('in')
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
      sub: {
        nodes: { n: { type: 'Sink' } },
        boundary: { inputs: [{ id: 'in', binds: { kind: 'port', node: 'n', port: 'in' } }], outputs: [] },
      },
    })
    expect(sceneOf(doc).boundaryNodes).toEqual([])
    expect(sceneOf(doc, 'sub').boundaryNodes.map((b) => b.side).sort()).toEqual(['inputs', 'outputs'])
  })
})

// ---------------------------------------------------------------------------
// Interaction-shaped growth: commands built from pin annotations
// ---------------------------------------------------------------------------

describe('spare-member interactions dispatch atomic commands', () => {
  it('connecting into a spare member stores it and connects in ONE step', () => {
    const store = makeStore(docOf({ g0: { nodes: { a: { type: 'Src' }, b: { type: 'Batch' } } } }))
    const ghost = ghostPinsOf(sceneFrom(store), 'b')[0]!
    const { outcome, to } = connectToPin(store, { node: 'a', port: 'out' }, 'b', ghost)
    expect(outcome.ok).toBe(true)
    expect(to).toEqual({ node: 'b', port: 'images.image0' })
    expect(dynOf(store, 'b')).toEqual({ images: { members: ['image0'], seq: 1 } })

    const scene = sceneFrom(store)
    expect(scene.links).toHaveLength(1)
    expect(scene.links[0]!.to).toEqual({ kind: 'port', node: 'b', port: 'images.image0' })
    expect(scene.links[0]!.typeName).toBe('IMAGE')
    // The member pin is real now; a NEW spare follows.
    const pins = pinsOf(scene, 'b', 'in')
    expect(pins.map((p) => [p.portId, p.ghost ?? false])).toEqual([
      ['images.image0', false],
      ['images.image1', true],
    ])
    expectNoDanglingEndpoints(scene)

    // ONE undo step reverts both the link and the stored member. Undo
    // leaves only the allocation cursor (hash-neutral bookkeeping), so the
    // next offered member is image1 -- keys are never reused.
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'b')).toEqual({ images: { seq: 1 } })
    const reverted = sceneFrom(store)
    expect(reverted.links).toHaveLength(0)
    expect(ghostPinsOf(reverted, 'b')[0]!.address.port).toBe('images.image1')
  })

  it('a rejected connect stores NOTHING (batch is atomic)', () => {
    const store = makeStore(docOf({ g0: { nodes: { b: { type: 'Batch' } } } }))
    const ghost = ghostPinsOf(sceneFrom(store), 'b')[0]!
    const { outcome } = connectToPin(store, { node: 'ghostville', port: 'out' }, 'b', ghost)
    expect(outcome.ok).toBe(false)
    expect(dynOf(store, 'b')).toBeUndefined()
    expect(store.canUndo).toBe(false)
  })

  it('reroute -> spare member: traced type survives, the member endpoint lands by flattened id', () => {
    const store = makeStore(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, b: { type: 'Batch' } },
          reroutes: ['r0'],
          links: [[['a', 'out'], { reroute: 'r0' }]],
        },
      }),
    )
    const ghost = ghostPinsOf(sceneFrom(store), 'b')[0]!
    const { outcome } = connectToPin(store, { reroute: 'r0' }, 'b', ghost)
    expect(outcome.ok).toBe(true)
    const scene = sceneFrom(store)
    const hop = scene.links.find((l) => l.from.kind === 'reroute')!
    expect(hop.to).toEqual({ kind: 'port', node: 'b', port: 'images.image0' })
    expect(hop.typeName).toBe('IMAGE')
    expect(ghostPinsOf(scene, 'b')[0]!.address.port).toBe('images.image1')
    expectNoDanglingEndpoints(scene)
  })

  it('value source -> spare widget member: spec derives from the member consumer', () => {
    const store = makeStore(
      docOf({
        g0: { nodes: { w: { type: 'Weigh' } }, valueSources: { v0: 0.75 } },
      }),
    )
    const row = widgetRowsOf(sceneFrom(store), 'w')[0]!
    expect(row.ghost).toBe(true)
    // Connect from the source into the spare member (widget rows expose the
    // same address as pins).
    const { outcome } = connectToPin(store, { valueSource: 'v0' }, 'w', rowAsPin(row))
    expect(outcome.ok).toBe(true)

    const scene = sceneFrom(store)
    expect(scene.valueSources).toHaveLength(1)
    const vs = scene.valueSources[0]!
    // Effective spec derives through the MEMBER consumer.
    expect(vs.specState).toBe('derived')
    expect(vs.effective.spec?.widgetType).toBe('FLOAT')
    const link = scene.links[0]!
    expect(link.from).toEqual({ kind: 'valueSource', valueSource: 'v0' })
    expect(link.to).toEqual({ kind: 'port', node: 'w', port: 'weights.w0' })
    // The connected member widget input keeps a pin so the noodle anchors.
    expectNoDanglingEndpoints(scene)
  })

  it('editing a spare widget member batches materialize + setValue as one undo step', () => {
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
    expect(dynOf(store, 'w')).toEqual({ weights: { members: ['w0'], seq: 1 } })
    expect(store.doc.graphs['g0']!.nodes['w']!.values['weights.w0']).toBe(0.9)

    const scene = sceneFrom(store)
    const rows = widgetRowsOf(scene, 'w')
    expect(rows.map((r) => [r.valueKey, r.ghost ?? false])).toEqual([
      ['weights.w0', false],
      ['weights.w1', true],
    ])

    // Undo reverts member + value in one step; only the allocation cursor
    // remains (never-reuse bookkeeping, hash-neutral).
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 'w')).toEqual({ weights: { seq: 1 } })
    expect(store.doc.graphs['g0']!.nodes['w']!.values['weights.w0']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Named nets with group-member endpoints
// ---------------------------------------------------------------------------

describe('named nets over group members', () => {
  const netDoc = (view?: Record<string, unknown>) =>
    docOf(
      {
        g0: {
          nodes: {
            a: { type: 'Src' },
            b: { type: 'Batch', dynamic: { images: { members: ['image0'], seq: 1 } } },
          },
          nets: { latents: { source: ['a', 'out'], sinks: [['b', 'images.image0']] } },
        },
      },
      view,
    )

  it('expanded: the net renders as a noodle anchored at the member pin', () => {
    const scene = sceneOf(netDoc())
    const net = scene.links.find((l) => l.netId === 'latents')!
    expect(net.to).toEqual({ kind: 'port', node: 'b', port: 'images.image0' })
    const node = nodeOf(scene, 'b')
    const pin = node.layout.pins.find((p) => p.portId === 'images.image0')!
    expect(net.y2).toBe(node.y + pin.y)
    expectNoDanglingEndpoints(scene)
  })

  it('net commands round-trip member ids: create from a member output, delete a member sink', () => {
    // A group-of-outputs member as a net source (the promote-to-net path).
    const store = makeStore(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            sp: { type: 'Split', dynamic: { outs: { members: ['o0'], seq: 1 } } },
            b: { type: 'Batch', dynamic: { images: { members: ['image0'], seq: 1 } } },
          },
          nets: { latents: { source: ['a', 'out'], sinks: [['b', 'images.image0']] } },
        },
      }),
    )
    const created = store.dispatch({
      command: 'net.create',
      params: { graphId: 'g0', name: 'branches', source: { node: 'sp', port: 'outs.o0' } },
    } as unknown as CommandInvocation)
    expect(created.ok).toBe(true)
    const nets = Object.values(store.doc.graphs['g0']!.nets)
    const branches = nets.find((n) => n.name === 'branches')!
    expect(branches.source).toEqual({ node: 'sp', port: 'outs.o0' })

    // Deleting a member sink passes the full PortRef.
    const deleted = store.dispatch({
      command: 'graph.deleteItems',
      params: {
        graphId: 'g0',
        nodeIds: [],
        linkIds: [],
        netSinks: [{ node: 'b', port: 'images.image0' }],
        rerouteIds: [],
        valueSourceIds: [],
      },
    } as unknown as CommandInvocation)
    expect(deleted.ok).toBe(true)
    const latents = Object.values(store.doc.graphs['g0']!.nets).find((n) => n.name === 'latents')
    expect(latents?.sinks ?? []).toHaveLength(0)
  })

  it('collapsed: the sink stub carries the member flattened id and anchors at the member pin', () => {
    const scene = sceneOf(netDoc({ g0: { nodes: {}, collapsedNets: ['latents'] } }))
    // Collapsed: the delivery stays a (hidden) scene link for connectivity.
    expect(scene.links.filter((l) => l.netId === 'latents').map((l) => l.hidden)).toEqual([true])
    const sink = scene.netStubs.find((st) => st.role === 'sink')!
    expect(sink.portId).toBe('images.image0')
    const node = nodeOf(scene, 'b')
    const pin = node.layout.pins.find((p) => p.portId === 'images.image0')!
    expect(sink.pinY).toBe(node.y + pin.y)
    expect(sink.typeName).toBe('IMAGE')
  })
})

// ---------------------------------------------------------------------------
// Mixed robustness: everything composing in one graph
// ---------------------------------------------------------------------------

describe('mixed dynamic robustness', () => {
  it('reroutes + value sources + nets + nested groups compose without dangling state', () => {
    const store = makeStore(
      docOf({
        g0: {
          nodes: {
            a: { type: 'Src' },
            s: { type: 'Batch' },
            t: { type: 'Batch' },
            n: { type: 'Nest', dynamic: { items: { members: ['item0'], seq: 1 } } },
            w: { type: 'Weigh' },
          },
          reroutes: ['r0'],
          valueSources: { v0: 0.25 },
          links: [[['a', 'out'], { reroute: 'r0' }]],
          nets: { pipe: { source: ['a', 'out'], sinks: [] } },
        },
      }),
    )

    // 1) Grow s through the reroute; t must not move.
    const g1 = ghostPinsOf(sceneFrom(store), 's')[0]!
    expect(connectToPin(store, { reroute: 'r0' }, 's', g1).outcome.ok).toBe(true)
    expect(dynOf(store, 's')).toEqual({ images: { members: ['image0'], seq: 1 } })
    expect(dynOf(store, 't')).toBeUndefined()

    // 2) Grow the NESTED group on n (inner spare under the stored item0).
    const nested = pinsOf(sceneFrom(store), 'n', 'in').find((p) => p.address.port === 'items.item0.sub.sub0')!
    expect(connectToPin(store, { node: 'a', port: 'out' }, 'n', nested).outcome.ok).toBe(true)
    expect(dynOf(store, 'n')).toEqual({
      items: { members: ['item0'], seq: 1 },
      'items.item0.sub': { members: ['sub0'], seq: 1 },
    })

    // 3) Value source into a spare widget member on w.
    const row = widgetRowsOf(sceneFrom(store), 'w')[0]!
    expect(connectToPin(store, { valueSource: 'v0' }, 'w', rowAsPin(row)).outcome.ok).toBe(true)

    // The composed scene: every noodle anchored, every spare advanced.
    const scene = sceneFrom(store)
    expectNoDanglingEndpoints(scene)
    expect(ghostPinsOf(scene, 's')[0]!.address.port).toBe('images.image1')
    expect(ghostPinsOf(scene, 't')[0]!.address.port).toBe('images.image0')
    // n grew its INNER group: a fresh inner spare sub1 under item0.
    const nPins = pinsOf(scene, 'n', 'in')
    expect(nPins.some((p) => p.address.port === 'items.item0.sub.sub1' && p.ghost)).toBe(true)
    // Reroute noodles keep the traced IMAGE type through the member endpoint.
    expect(scene.links.find((l) => l.from.kind === 'reroute')!.typeName).toBe('IMAGE')

    // Unwind EVERYTHING: each grow was exactly one undo step. Allocation
    // cursors survive undo (never-reuse), so cursor-only skeletons remain.
    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(true)
    expect(dynOf(store, 's')).toEqual({ images: { seq: 1 } })
    expect(dynOf(store, 'n')).toEqual({
      items: { members: ['item0'], seq: 1 },
      'items.item0.sub': { seq: 1 },
    })
    expect(dynOf(store, 'w')).toEqual({ weights: { seq: 1 } })
    expectNoDanglingEndpoints(sceneFrom(store))
  })
})

// ---------------------------------------------------------------------------
// Full stored-member lifecycle matrix
// ---------------------------------------------------------------------------

describe('group stored-member lifecycle matrix', () => {
  const cases = [
    { name: 'group of values', type: 'Batch', construct: 'images', port: 'images.image0', member: 'image0', next: 'image1', ghostPorts: ['images.image0'], grouped: false },
    { name: 'group of records', type: 'Duo', construct: 'pairs', port: 'pairs.pair0.image', member: 'pair0', next: 'pair1', ghostPorts: ['pairs.pair0.image', 'pairs.pair0.gain'], grouped: true },
  ] as const

  for (const testCase of cases) {
    it(`${testCase.name}: automatic disconnect compaction is one undo step and never reuses keys`, () => {
      const node = 'target'
      const store = makeStore(docOf({ g0: { nodes: { source: { type: 'Src' }, [node]: { type: testCase.type } } } }))
      const memberOf = (port: string): string => port.slice(testCase.construct.length + 1).split('.')[0]!
      const firstGhosts = ghostPinsOf(sceneFrom(store), node).filter((pin) => pin.direction === 'in')
      expect(firstGhosts.map((pin) => pin.address.port)).toEqual(testCase.ghostPorts)

      const landing = firstGhosts.find((pin) => pin.address.port === testCase.port)!
      expect(connectToPin(store, { node: 'source', port: 'out' }, node, landing).outcome.ok).toBe(true)
      expect(dynOf(store, node)).toEqual({ [testCase.construct]: { members: [testCase.member], seq: 1 } })
      const connected = sceneFrom(store)
      expect(pinsOf(connected, node, 'in').filter((pin) =>
        !pin.ghost && memberOf(pin.address.port) === testCase.member)).toHaveLength(testCase.grouped ? 2 : 1)
      expectNoDanglingEndpoints(connected)
      expect(new Set(pinsOf(connected, node, 'in').map((pin) => pin.portId)).size)
        .toBe(pinsOf(connected, node, 'in').length)
      expect(ghostPinsOf(connected, node).filter((pin) => pin.direction === 'in').map((pin) => memberOf(pin.address.port)))
        .toEqual(Array.from({ length: testCase.grouped ? 2 : 1 }, () => testCase.next))
      expect(Object.values(store.doc.graphs.g0!.links)).toHaveLength(1)
      expect(Object.values(store.doc.graphs.g0!.links)[0]!.to).toEqual({ node, port: testCase.port })

      // Save/export/open is canonical JSON through the real loader. The
      // stored member, its link and exactly one spare survive.
      const saved = JSON.parse(JSON.stringify(store.doc))
      const reopened = loadDocument(saved)
      expect(reopened.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
      const reopenedStore = makeStore(reopened.document!)
      expect(dynOf(reopenedStore, node)).toEqual(dynOf(store, node))
      expect(Object.values(reopenedStore.doc.graphs.g0!.links)[0]!.to).toEqual(
        Object.values(store.doc.graphs.g0!.links)[0]!.to,
      )
      expectNoDanglingEndpoints(sceneFrom(reopenedStore))

      const linkId = Object.keys(reopenedStore.doc.graphs.g0!.links)[0]!
      expect(reopenedStore.dispatch({
        command: 'batch',
        params: {
          invocations: [
            { command: 'link.disconnect', params: { graphId: 'g0', linkId } },
            { command: 'dynamic.compact', params: { graphId: 'g0', nodeId: node } },
          ],
        },
      }).ok).toBe(true)
      expect(dynOf(reopenedStore, node)).toEqual({ [testCase.construct]: { seq: 1 } })
      const compacted = sceneFrom(reopenedStore)
      expect(ghostPinsOf(compacted, node).filter((pin) => pin.direction === 'in').map((pin) => memberOf(pin.address.port)))
        .toEqual(Array.from({ length: testCase.grouped ? 2 : 1 }, () => testCase.next))
      expectNoDanglingEndpoints(compacted)

      // A stale endpoint cannot recreate the removed member. Growth must go
      // through the offered spare and its materialization batch.
      expect(reopenedStore.dispatch({
        command: 'link.connect',
        params: {
          graphId: 'g0', from: { node: 'source', port: 'out' },
          to: { node, port: testCase.port },
        },
      }).ok).toBe(false)
      expect(dynOf(reopenedStore, node)).toEqual({ [testCase.construct]: { seq: 1 } })

      // Disconnect and compact are one history entry. Undo restores the exact
      // member and link together but never rewinds the allocator cursor.
      expect(reopenedStore.undo()).toBe(true)
      expect(dynOf(reopenedStore, node)).toEqual({ [testCase.construct]: { members: [testCase.member], seq: 1 } })
      expect(Object.values(reopenedStore.doc.graphs.g0!.links)[0]!.to).toEqual({ node, port: testCase.port })
      expect(reopenedStore.redo()).toBe(true)
      expect(dynOf(reopenedStore, node)).toEqual({ [testCase.construct]: { seq: 1 } })

      // Compile never sends the spare member. With no live link after redo,
      // no member of the group appears in the artifact.
      const compiled = compile({
        document: reopenedStore.doc, revision: reopenedStore.revision,
        resolve: (type) => schemas[type], scope: { kind: 'full' },
        connection: asConnectionId('c0'), schemaHash: 'group-lifecycle',
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (compiled.ok) {
        expect(JSON.stringify(compiled.artifact.prompt)).not.toContain(testCase.member)
        expect(JSON.stringify(compiled.artifact.prompt)).not.toContain(testCase.next)
      }
    })
  }
})
