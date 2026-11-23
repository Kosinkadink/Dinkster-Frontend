import {
  defaultValuesOf,
  documentResolver,
  loadDocument,
  occurrenceDynamicView,
  type BodyRow,
  type DynamicPortState,
  type InputSpec,
  type Json,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '@dinkster/core'
import {
  buildScene,
  type DesignTokens,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

/** One card of the Subgraph boundary tree page: a scene of its own. */
export interface BoundaryTreeCard {
  readonly caption: string
  readonly scene: Scene
}

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const pin = (id: string, type: string): InputSpec => ({
  kind: 'input',
  id,
  type: concrete(type),
  optional: false,
})
const field = (
  id: string,
  widgetType: string,
  value: Json,
  options: Record<string, Json> = {},
): InputSpec => ({
  kind: 'input',
  id,
  type: concrete(widgetType),
  optional: false,
  widget: { widgetType, options, default: value },
})
const out = (
  id: string,
  type: string,
  extra: Partial<OutputSpec> = {},
): OutputSpec => ({
  kind: 'output',
  id,
  type: concrete(type),
  ...extra,
})
/** The schema a subgraph node draws: its boundary, in the author's order. */
const face = (type: string, body: readonly BodyRow[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'subgraph',
  isOutputNode: false,
  body,
})
const plain = (type: string, body: readonly BodyRow[]): NodeSchema => ({
  ...face(type, body),
  source: 'v3',
})

interface Placed {
  readonly schema: NodeSchema
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly values?: Record<string, Json>
  readonly dynamic?: Record<string, DynamicPortState>
}

function sceneOf(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  nodes: Record<string, Placed>,
  links: readonly (readonly [string, string, string, string])[] = [],
): Scene {
  const schemas = new Map(
    Object.values(nodes).map((node) => [node.schema.type, node.schema]),
  )
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery-boundary-tree',
    root: 'root',
    graphs: {
      root: {
        id: 'root',
        name: 'root',
        nextOrdinal: 100,
        nodes: Object.fromEntries(
          Object.entries(nodes).map(([id, node]) => [
            id,
            {
              id,
              type: node.schema.type,
              values: { ...defaultValuesOf(node.schema), ...node.values },
              ...(node.dynamic ? { dynamic: node.dynamic } : {}),
            },
          ]),
        ),
        links: Object.fromEntries(
          links.map((link, i) => [
            `l${i}`,
            {
              id: `l${i}`,
              from: { node: link[0], port: link[1] },
              to: { node: link[2], port: link[3] },
            },
          ]),
        ),
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        root: {
          nodes: Object.fromEntries(
            Object.entries(nodes).map(([id, node]) => [
              id,
              {
                position: { x: node.x, y: node.y },
                size: { width: node.width ?? 240, height: 0 },
              },
            ]),
          ),
        },
      },
    },
  } as unknown as Json)
  const doc = loaded.document
  if (!doc)
    throw new Error(
      `Invalid boundary tree gallery document: ${JSON.stringify(loaded)}`,
    )
  const resolve = documentResolver(doc, (type) => schemas.get(type))
  return buildScene({
    document: doc,
    resolve,
    tokens,
    measure,
    widgetMeasure,
    graphId: 'root',
    occurrenceView: occurrenceDynamicView(doc, resolve, [], 'root'),
  })
}

const source = plain('Load', [out('image', 'IMAGE'), out('mask', 'MASK')])
const viewer = plain('Preview', [pin('image', 'IMAGE')])
const numbers = plain('Show number', [pin('value', 'INT')])

const look = (closed: boolean): BodyRow => ({
  kind: 'section',
  id: 'look',
  displayName: 'Look',
  collapsedByDefault: closed,
  rows: [
    {
      kind: 'row',
      rows: [
        field('radius', 'FLOAT', 4, { min: 0, max: 64, step: 0.5 }),
        field('strength', 'FLOAT', 0.45, { min: 0, max: 1, step: 0.05 }),
        field('feather', 'INT', 3, { min: 0, max: 16 }),
      ],
    },
    field('mode', 'COMBO', 'soft', { options: ['soft', 'hard'] }),
    {
      kind: 'section',
      id: 'advanced',
      displayName: 'Advanced',
      collapsedByDefault: true,
      rows: [
        field('grain', 'FLOAT', 0.4, { min: 0, max: 1, step: 0.05 }),
        field('seed', 'INT', 7, { min: 0, max: 99999 }),
      ],
    },
  ],
})

/** The subgraph node faces the Boundary panel's tree arranges. */
export function boundaryTreeGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): readonly BoundaryTreeCard[] {
  const scene = (
    nodes: Record<string, Placed>,
    links: readonly (readonly [string, string, string, string])[] = [],
  ) => sceneOf(tokens, measure, widgetMeasure, nodes, links)

  const tree = face('Detail pass', [
    pin('image', 'IMAGE'),
    pin('mask', 'MASK'),
    out('result', 'IMAGE'),
    look(false),
    out('preview', 'IMAGE'),
  ])
  const paired = (ownRow: boolean) =>
    face(ownRow ? 'Kept apart' : 'Paired', [
      pin('image', 'IMAGE'),
      field('strength', 'FLOAT', 0.45, { min: 0, max: 1, step: 0.05 }),
      pin('mask', 'MASK'),
      out('preview', 'IMAGE', ownRow ? { ownRow: true } : {}),
    ])
  const added = face('Detail pass, steps added', [
    pin('image', 'IMAGE'),
    pin('mask', 'MASK'),
    look(true),
    field('steps', 'INT', 20, { min: 1, max: 100 }),
    out('result', 'IMAGE'),
  ])
  const images = face('Portrait fix', [
    pin('base', 'IMAGE'),
    {
      kind: 'group',
      id: 'images',
      displayName: 'Images',
      member: [
        pin('image', 'IMAGE'),
        field('strength', 'FLOAT', 0.5, { min: 0, max: 1, step: 0.05 }),
        out('out', 'IMAGE', { displayName: 'image out' }),
      ],
      keys: { kind: 'numbered', prefix: 'image', start: 0, pad: 0 },
      grows: 'button',
      minMembers: 0,
      maxMembers: 6,
      addLabel: 'Add image',
      interiorNote: '2 members inside the definition come first',
    },
    out('result', 'IMAGE'),
  ])
  const split = face('Split', [
    pin('image', 'IMAGE'),
    { ...field('count', 'INT', 3, { min: 1, max: 4 }), socketless: true },
    {
      kind: 'group',
      id: 'parts',
      displayName: 'Parts',
      value: out('part', 'INT'),
      keys: { kind: 'numbered', prefix: 'part', start: 1, pad: 0 },
      grows: { count: 'count' },
      minMembers: 1,
      maxMembers: 4,
    },
  ])

  return [
    {
      caption:
        'The face of the tree: result shares the line of mask, the pin-only input above it; preview follows a section, so it takes a line of its own',
      scene: scene(
        {
          load: { schema: source, x: 24, y: 70, width: 140 },
          detail: { schema: tree, x: 220, y: 40, width: 260 },
          view: { schema: viewer, x: 740, y: 40, width: 140 },
        },
        [
          ['load', 'image', 'detail', 'image'],
          ['load', 'mask', 'detail', 'mask'],
          ['detail', 'result', 'view', 'image'],
        ],
      ),
    },
    {
      caption:
        'An output added after a pin-only input shares its line; kept on a line of its own, it does not',
      scene: scene({
        paired: { schema: paired(false), x: 24, y: 40 },
        apart: { schema: paired(true), x: 300, y: 40 },
      }),
    },
    {
      caption:
        'An input added to a face that ends with a section and an output: steps lands after the closed section, before result',
      scene: scene({ added: { schema: added, x: 24, y: 40, width: 260 } }),
    },
    {
      caption:
        "A whole group on a subgraph node: a quiet line for the definition's own members, then this node's members",
      scene: scene({
        fix: {
          schema: images,
          x: 24,
          y: 40,
          width: 260,
          values: {
            'images.image0.strength': 0.2,
            'images.image1.strength': 0.8,
          },
          dynamic: { images: { members: ['image0', 'image1'] } },
        },
      }),
    },
    {
      caption:
        'A count that shrinks while part 3 is wired: at 1, part 3 stays drawn after the counted parts, dimmed and outside the count, and keeps its wire',
      scene: scene(
        {
          three: { schema: split, x: 24, y: 40, values: { count: 3 } },
          sink: { schema: numbers, x: 320, y: 120, width: 150 },
          one: { schema: split, x: 24, y: 240, values: { count: 1 } },
          sink1: { schema: numbers, x: 320, y: 300, width: 150 },
        },
        [
          ['three', 'parts.part3', 'sink', 'value'],
          ['one', 'parts.part3', 'sink1', 'value'],
        ],
      ),
    },
  ]
}
