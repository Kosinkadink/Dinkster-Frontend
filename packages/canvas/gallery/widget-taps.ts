import {
  companionSourcesOf,
  defaultValuesOf,
  loadDocument,
  type InputSpec,
  type Json,
  type LinkEndpoint,
  type NodeSchema,
  type TypeExpr,
} from '@dinkster/core'
import {
  buildScene,
  dropTargetKey,
  pinPosition,
  type CompanionMap,
  type DesignTokens,
  type OverlayState,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

/** One card of the field output page: its nodes and what the pointer is doing. */
export interface WidgetTapExample {
  readonly caption: string
  readonly nodes: readonly number[]
  readonly overlay?: OverlayState
}

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const field = (
  id: string,
  displayName: string,
  widgetType: string,
  value: Json,
  options: Record<string, Json> = {},
): InputSpec => ({
  kind: 'input',
  id,
  displayName,
  type: concrete(widgetType),
  optional: false,
  widget: { widgetType, options, default: value },
})
const socket = (id: string, type: string): InputSpec => ({
  kind: 'input',
  id,
  type: concrete(type),
  optional: false,
})
const schema = (type: string, body: NodeSchema['body']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body,
})

const steps = field('steps', 'steps', 'INT', 20, { min: 1, max: 10000 })
const cfg = field('cfg', 'cfg', 'FLOAT', 7.5, { min: 0, max: 100, step: 0.1 })
const sampler = schema('Sampler', [
  socket('model', 'MODEL'),
  { kind: 'output', id: 'LATENT', type: concrete('LATENT') },
  steps,
  cfg,
])
const scheduler = schema('Scheduler', [
  socket('steps', 'INT'),
  { kind: 'output', id: 'SIGMAS', type: concrete('SIGMAS') },
])
const fieldScheduler = schema('Scheduler with a steps field', [
  { kind: 'output', id: 'SIGMAS', type: concrete('SIGMAS') },
  steps,
])
const guider = schema('Guider', [
  socket('cfg', 'FLOAT'),
  { kind: 'output', id: 'GUIDER', type: concrete('GUIDER') },
])
const blend = schema('Blend', [
  socket('factor', 'FLOAT'),
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
])
const float = schema('Float', [
  { kind: 'output', id: 'FLOAT', type: concrete('FLOAT') },
  field('value', 'value', 'FLOAT', 6.5, { min: 0, max: 100, step: 0.5 }),
])
const rowKinds = schema('Row kinds', [
  field('number', 'number', 'INT', 20, { min: 1, max: 10000 }),
  field('slider', 'slider', 'FLOAT', 0.65, {
    min: 0,
    max: 1,
    step: 0.01,
    display: 'slider',
  }),
  {
    ...field('list', 'list', 'LIST', [1, 0.5, 0.25]),
    widget: {
      widgetType: 'LIST',
      options: {},
      default: [1, 0.5, 0.25],
      element: { widgetType: 'FLOAT', options: {} },
    },
  },
  field('choice', 'choice', 'COMBO', 'euler', {
    options: ['euler', 'dpmpp_2m_sde'],
  }),
  field('switch', 'switch', 'BOOLEAN', true),
  field('color', 'color', 'COLOR', '#3366cc'),
  field('text', 'text', 'STRING', 'A fox in tall grass'),
  {
    ...field('seed', 'seed', 'INT', 123456789, { min: 0, max: 999999999 }),
    widget: {
      widgetType: 'INT',
      options: { min: 0, max: 999999999 },
      default: 123456789,
      controller: 'after_generate',
    },
  },
])
const foldedSampler = schema('Sampler with a folded section', [
  socket('model', 'MODEL'),
  { kind: 'output', id: 'LATENT', type: concrete('LATENT') },
  steps,
  {
    kind: 'section',
    id: 'advanced',
    displayName: 'Advanced',
    collapsedByDefault: true,
    rows: [
      field('denoise', 'denoise', 'FLOAT', 0.6, {
        min: 0,
        max: 1,
        step: 0.01,
      }),
    ],
  },
])
const weight = field('weight', 'weight', 'FLOAT', 0.5, {
  min: 0,
  max: 1,
  step: 0.05,
})
const grouped = schema('Weights in a group', [
  field('scale', 'scale', 'FLOAT', 1, { min: 0, max: 10, step: 0.1 }),
  {
    kind: 'group',
    id: 'weights',
    value: { ...weight, optional: true },
    keys: { kind: 'numbered', prefix: 'weight', start: 0, pad: 0 },
    grows: 'link',
    minMembers: 1,
    maxMembers: 4,
  },
])
const chosen = schema('Strength under a choice', [
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
  {
    kind: 'choice',
    id: 'mode',
    displayName: 'mode',
    required: true,
    shared: [],
    options: [
      {
        key: 'fixed',
        rows: [
          field('strength', 'strength', 'FLOAT', 0.8, {
            min: 0,
            max: 1,
            step: 0.05,
          }),
        ],
      },
      {
        key: 'ramp',
        rows: [
          field('start', 'start', 'FLOAT', 0),
          field('end', 'end', 'FLOAT', 1),
        ],
      },
    ],
  },
])
const typeLed = schema('Resize by input type', [
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
  {
    kind: 'typeChoice',
    id: 'input',
    displayName: 'input',
    required: false,
    rows: [],
    variants: [
      {
        key: 'IMAGE',
        type: concrete('IMAGE'),
        rows: [field('width', 'width', 'FLOAT', 512)],
      },
      {
        key: 'LATENT',
        type: concrete('LATENT'),
        rows: [
          field('scale', 'scale', 'FLOAT', 1.5, { min: 0, max: 8, step: 0.25 }),
        ],
      },
    ],
  },
])
const schemas = [
  typeLed,
  sampler,
  scheduler,
  fieldScheduler,
  guider,
  blend,
  float,
  rowKinds,
  foldedSampler,
  grouped,
  chosen,
]

interface Placed {
  readonly id: string
  readonly schema: NodeSchema
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly values?: Record<string, Json>
  readonly dynamic?: Record<string, Json>
}
interface Wire {
  readonly from: LinkEndpoint
  readonly to: { readonly node: string; readonly port: string }
}
interface Card {
  readonly caption: string
  readonly nodes: readonly Placed[]
  readonly wires?: readonly Wire[]
}

/** Gap between a card's producer and the node its wire reaches. */
const WIRE_GAP = 80
/** Room between cards in the page's world, so no card's wires reach another. */
const CARD_GAP = 400
const NODE_WIDTH = 280
/** Nodes that only receive or only give a value are narrower, so a card of three fits the page. */
const SMALL_WIDTH = 180

/**
 * A field's output pin (a widget tap, docs/architecture.md section 5c) on
 * every kind of row, painted from real documents: the pins, wires and the
 * receiving row's value all come from the product's scene and companion
 * derivation, not from drawing.
 */
export function widgetTapGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): {
  scene: Scene
  companions: CompanionMap
  examples: readonly WidgetTapExample[]
} {
  let top = 0
  const card = (
    caption: string,
    nodes: readonly Omit<Placed, 'y'>[],
    wires: readonly Wire[] = [],
    offsets: readonly number[] = [],
  ): Card => {
    const placed = nodes.map((node, i) => ({
      ...node,
      y: top + (offsets[i] ?? 0),
    }))
    top += CARD_GAP
    return { caption, nodes: placed, wires }
  }
  const right = NODE_WIDTH + WIRE_GAP
  const small = { width: SMALL_WIDTH }
  const tap = (node: string, input: string): LinkEndpoint =>
    ({ node, tap: input }) as LinkEndpoint
  const port = (node: string, output: string): LinkEndpoint =>
    ({ node, port: output }) as LinkEndpoint
  const cards: Card[] = [
    card('At rest: the pin is hidden.', [
      { id: 'rest', schema: sampler, x: 0 },
    ]),
    card('Pointed at: every field shows its pin, and the pointed pin grows.', [
      { id: 'pointed', schema: sampler, x: 0 },
    ]),
    card(
      'A fitting wire dragged from an input and held on the steps pin: its end is at the pin\'s center.',
      [
        { id: 'dragged', schema: sampler, x: 0 },
        { id: 'dragged scheduler', schema: scheduler, x: right, ...small },
      ],
      [],
      [0, 60],
    ),
    card(
      'The same wire held over the steps row: the row is outlined and takes it on release.',
      [
        { id: 'held', schema: sampler, x: 0 },
        { id: 'held scheduler', schema: scheduler, x: right, ...small },
      ],
      [],
      [0, 60],
    ),
    card(
      'Wired: the wire leaves from the steps pin.',
      [
        { id: 'wired', schema: sampler, x: 0 },
        { id: 'wired scheduler', schema: scheduler, x: right, ...small },
      ],
      [
        {
          from: tap('wired', 'steps'),
          to: { node: 'wired scheduler', port: 'steps' },
        },
      ],
      [0, 60],
    ),
    card(
      'The pin beside each kind of row, with the node pointed at. An automatic value is not built yet; it gets its row here when it is.',
      [{ id: 'kinds', schema: rowKinds, x: 0 }],
    ),
    card(
      "The cfg field is driven by a wire, and its pin is live: it passes the field's source on to the next node.",
      [
        { id: 'source float', schema: float, x: 0, ...small },
        { id: 'passing', schema: sampler, x: SMALL_WIDTH + WIRE_GAP },
        {
          id: 'passing guider',
          schema: guider,
          x: SMALL_WIDTH + WIRE_GAP + right,
          ...small,
        },
      ],
      [
        {
          from: port('source float', 'FLOAT'),
          to: { node: 'passing', port: 'cfg' },
        },
        {
          from: tap('passing', 'cfg'),
          to: { node: 'passing guider', port: 'cfg' },
        },
      ],
      [60, 0, 60],
    ),
    card(
      "A folded section: the wire leaves from the section's header.",
      [
        { id: 'folded', schema: foldedSampler, x: 0 },
        { id: 'folded blend', schema: blend, x: right, ...small },
      ],
      [
        {
          from: tap('folded', 'denoise'),
          to: { node: 'folded blend', port: 'factor' },
        },
      ],
      [0, 60],
    ),
    card(
      'The receiving row shows, dimmed, the value it will get from the other field.',
      [
        { id: 'giving', schema: sampler, x: 0 },
        {
          id: 'receiving',
          schema: fieldScheduler,
          x: right,
          values: { steps: 30 },
        },
      ],
      [
        {
          from: tap('giving', 'steps'),
          to: { node: 'receiving', port: 'steps' },
        },
      ],
      [0, 60],
    ),
    card(
      "A field in a group's member has its own pin, like every other field.",
      [
        {
          id: 'grouped',
          schema: grouped,
          x: 0,
          dynamic: { weights: { members: ['weight0'] } },
        },
      ],
    ),
    card(
      "A field under a choice's option has its own pin. Its wire survives copy and paste and replacing the node, and a subgraph's face can offer it.",
      [
        { id: 'chosen', schema: chosen, x: 0 },
        { id: 'chosen blend', schema: blend, x: right, ...small },
      ],
      [
        {
          from: tap('chosen', 'mode.strength'),
          to: { node: 'chosen blend', port: 'factor' },
        },
      ],
      [0, 60],
    ),
    card(
      "Kept row under an option not chosen: the wire stays on strength, dimmed, after the chosen option's rows. It cannot be edited and gives nothing until it is unplugged or 'fixed' is chosen again.",
      [
        {
          id: 'kept option',
          schema: chosen,
          x: 0,
          dynamic: { mode: { selected: 'ramp' } },
        },
        { id: 'kept option blend', schema: blend, x: right, ...small },
      ],
      [
        {
          from: tap('kept option', 'mode.strength'),
          to: { node: 'kept option blend', port: 'factor' },
        },
      ],
      [0, 60],
    ),
    card(
      'Kept row under a type-led pin: the input now takes an IMAGE, and the LATENT row scale stays, dimmed, after the IMAGE rows, with its wire.',
      [
        {
          id: 'kept type',
          schema: typeLed,
          x: 0,
          dynamic: { input: { selected: 'IMAGE' } },
        },
        { id: 'kept type blend', schema: blend, x: right, ...small },
      ],
      [
        {
          from: tap('kept type', 'input.scale'),
          to: { node: 'kept type blend', port: 'factor' },
        },
      ],
      [0, 60],
    ),
    card(
      'Kept member: the document names weight 2, which the group does not store. The whole member stays, dimmed, at the end of the group before its spare row, with its wire.',
      [
        {
          id: 'kept member',
          schema: grouped,
          x: 0,
          values: { 'weights.weight0': 0.25, 'weights.weight1': 0.75 },
          dynamic: { weights: { members: ['weight0'], seq: 2 } },
        },
        { id: 'kept member blend', schema: blend, x: right, ...small },
      ],
      [
        {
          from: tap('kept member', 'weights.weight1'),
          to: { node: 'kept member blend', port: 'factor' },
        },
      ],
      [0, 60],
    ),
  ]
  const placed = cards.flatMap((card) => card.nodes)
  const wires = cards.flatMap((card) => card.wires ?? [])
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery',
        name: 'Gallery',
        nextOrdinal: 2,
        nodes: Object.fromEntries(
          placed.map((node) => [
            node.id,
            {
              id: node.id,
              type: node.schema.type,
              values: { ...defaultValuesOf(node.schema), ...node.values },
              ...(node.dynamic ? { dynamic: node.dynamic } : {}),
            },
          ]),
        ),
        links: Object.fromEntries(
          wires.map((wire, i) => [
            `wire ${i}`,
            { id: `wire ${i}`, from: wire.from, to: wire.to },
          ]),
        ),
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: Object.fromEntries(
            placed.map((node) => [
              node.id,
              {
                position: { x: node.x, y: node.y },
                size: { width: node.width ?? NODE_WIDTH, height: 0 },
              },
            ]),
          ),
        },
      },
    },
  })
  const document = loaded.document
  if (!document)
    throw new Error(
      `Invalid field output gallery document: ${JSON.stringify(loaded)}`,
    )
  const resolve = (type: string) => schemas.find((item) => item.type === type)
  const scene = buildScene({
    document,
    graphId: 'gallery',
    resolve,
    tokens,
    measure,
    widgetMeasure,
    seedControllerEnabled: true,
  })
  const companions: Record<string, Record<string, { value: Json }>> = {}
  for (const [node, ports] of companionSourcesOf(
    document.graphs['gallery']!,
    undefined,
    undefined,
    resolve,
  ))
    for (const [input, source] of ports)
      if (source.kind === 'literal')
        (companions[node] ??= {})[input] = { value: source.value }
  const indexOf = (id: string) =>
    scene.nodes.findIndex((node) => node.id === id)
  const nodeOf = (id: string) => scene.nodes[indexOf(id)]!
  const pin = pinPosition(nodeOf('dragged'), 'steps', 'out', true)!
  const anchor = pinPosition(nodeOf('dragged scheduler'), 'steps', 'in')!
  const heldPin = pinPosition(nodeOf('held'), 'steps', 'out', true)!
  const heldAnchor = pinPosition(nodeOf('held scheduler'), 'steps', 'in')!
  const overlays: Record<number, OverlayState> = {
    1: {
      hoveredNode: 'pointed',
      hoveredPin: {
        nodeId: 'pointed',
        portId: 'steps',
        direction: 'out',
        widgetTap: true,
      },
    },
    // The pointer went down on the scheduler's steps pin and is held on the
    // steps field's pin, the one output the wire fits.
    2: {
      hoveredNode: 'dragged scheduler',
      ghostLink: {
        x1: pin.x,
        y1: pin.y,
        x2: anchor.x,
        y2: anchor.y,
        typeName: 'INT',
      },
      dropTargets: new Set([dropTargetKey('dragged', 'steps', 'out', true)]),
    },
    // Over the row, the wire ends on the field's pin and only the row is
    // outlined.
    3: {
      ghostLink: {
        x1: heldPin.x,
        y1: heldPin.y,
        x2: heldAnchor.x,
        y2: heldAnchor.y,
        typeName: 'INT',
      },
      dropTargets: new Set([dropTargetKey('held', 'steps', 'out', true)]),
      dropRow: { nodeId: 'held', valueKey: 'steps' },
    },
    5: { hoveredNode: 'kinds' },
    9: { hoveredNode: 'grouped' },
  }
  return {
    scene,
    companions,
    examples: cards.map((card, i) => ({
      caption: card.caption,
      nodes: card.nodes.map((node) => indexOf(node.id)),
      ...(overlays[i] ? { overlay: overlays[i] } : {}),
    })),
  }
}
