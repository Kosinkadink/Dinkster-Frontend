import {
  defaultValuesOf,
  formatWidgetValue,
  loadDocument,
  t,
  type InputSpec,
  type Json,
  type LinkEndpoint,
  type NodeSchema,
  type SceneBuilder,
  type TypeExpr,
  type WidgetRegistry,
  type WidgetSpec,
  type WidgetView,
} from '@dinkster/core'
import {
  buildScene,
  type CompanionMap,
  type DesignTokens,
  type RowMarkMap,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

/** One card of the closed row summaries page: its nodes, by index in the scene. */
export interface RowSummaryExample {
  readonly caption: string
  readonly nodes: readonly number[]
}

/** A row whose whole-value readout the page lists under its cards. */
export interface RowSummaryReadout {
  readonly label: string
  readonly spec: WidgetSpec
  readonly value: Json
}

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const field = (
  id: string,
  widgetType: string,
  value: Json,
  options: Record<string, Json> = {},
  extra: Partial<NonNullable<InputSpec['widget']>> = {},
): InputSpec => ({
  kind: 'input',
  id,
  displayName: id,
  type: concrete(widgetType),
  optional: false,
  widget: { widgetType, options, default: value, ...extra },
})
const schema = (type: string, items: NodeSchema['items']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items,
})

const asset = (name: string, mediaType = 'image/png', fill = 'a'): Json => ({
  digest: `blake3:${fill.repeat(64)}`,
  name,
  size: 120417,
  mediaType,
  virtualPath: `input/${name}`,
})
const portraits = [
  asset('portrait_final_2026.png'),
  asset('portrait_final_2026.png', 'image/png', 'b'),
  asset('beach.png', 'image/png', 'c'),
]
const nineColors = [
  '#32e6c5',
  '#ff7468',
  '#ffd166',
  '#3366cc',
  '#cc66ff',
  '#7d8792',
  '#2ec4b6',
  '#ff9f1c',
  '#8a5cf6',
]
const samplers = [
  { value: 'euler', label: 'Euler' },
  { value: 'dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'ddim', label: 'DDIM' },
]
const imageAccept = { accept: ['image/png', 'image/jpeg', 'image/webp'] }

/**
 * One kind of field: its name on the page, how it is declared, its empty or
 * initial value, a populated value, and the width of a node narrow enough
 * that the populated value must give way.
 */
interface KindCase {
  readonly title: string
  readonly widgetType: string
  readonly options?: Record<string, Json>
  readonly extra?: Partial<NonNullable<InputSpec['widget']>>
  readonly empty: Json
  readonly populated: Json
  readonly narrow: number
  /** Width of the node with the empty and populated rows, when not NODE_WIDTH. */
  readonly wide?: number
}

const kindCases: readonly KindCase[] = [
  {
    title: 'Multiple choices',
    widgetType: 'MULTI_COMBO',
    options: { options: samplers },
    empty: [],
    populated: ['dpmpp_2m_sde', 'euler', 'dpmpp_2m'],
    narrow: 168,
  },
  {
    title: 'List',
    widgetType: 'LIST',
    extra: { element: { widgetType: 'FLOAT', options: { step: 0.1 } } },
    empty: [],
    populated: [0.30000000000000004, 0.25, 12.5],
    narrow: 166,
  },
  {
    title: 'Colors',
    widgetType: 'COLORS',
    empty: [],
    populated: nineColors,
    narrow: 124,
  },
  {
    title: 'Markdown',
    widgetType: 'MARKDOWN',
    empty: '  \n',
    populated: '\n# Heading\nBody text',
    narrow: 172,
  },
  {
    title: 'Files',
    widgetType: 'ASSET',
    options: imageAccept,
    empty: null,
    populated: portraits,
    narrow: 156,
  },
  {
    title: 'Audio recording',
    widgetType: 'AUDIO_RECORD',
    empty: null,
    populated: asset('take_03.wav', 'audio/wav', 'd'),
    narrow: 150,
  },
  {
    title: 'Webcam capture',
    widgetType: 'WEBCAM',
    empty: null,
    populated: asset('capture_01.png', 'image/png', 'e'),
    narrow: 150,
  },
  {
    title: 'Output mount',
    widgetType: 'MOUNT',
    empty: null,
    populated: 'renders',
    narrow: 150,
  },
  {
    title: '3D viewport',
    widgetType: 'LOAD_3D',
    empty: {},
    populated: { camera: { fov: 35, position: [0, 1.5, 4] } },
    narrow: 160,
  },
  {
    title: 'Bounding box',
    widgetType: 'BOUNDING_BOX',
    empty: { x: 0, y: 0, width: 512, height: 512 },
    populated: { x: 8, y: 12, width: 512, height: 768 },
    narrow: 236,
  },
  {
    title: 'Image comparison',
    widgetType: 'IMAGECOMPARE',
    empty: null,
    populated: null,
    narrow: 180,
  },
  {
    title: 'Camera angle',
    widgetType: 'CAMERA_ANGLE_VIEW',
    empty: '',
    populated: 'front',
    narrow: 170,
  },
  {
    title: 'Resolution preview',
    widgetType: 'RESOLUTION_PREVIEW',
    empty: null,
    populated: null,
    narrow: 170,
  },
  {
    title: 'Save target',
    widgetType: 'SAVE_TARGET',
    empty: null,
    populated: { mount: 'renders', prefix: 'session/frame' },
    narrow: 212,
  },
  {
    title: 'Video trim and crop',
    widgetType: 'VIDEO_EDIT',
    options: { features: ['trim', 'crop'] },
    empty: {},
    populated: {
      trim: { start_time: 1.5, duration: 2 },
      crop: { x: 8, y: 12, width: 512, height: 768 },
    },
    narrow: 200,
    wide: 380,
  },
  {
    title: 'Color',
    widgetType: 'COLOR',
    empty: '#ffffff',
    populated: '#32e6c5',
    narrow: 140,
  },
]

const hardest = schema('Load images', [
  field('images', 'ASSET', null, imageAccept),
  field('palette', 'COLORS', []),
])

const invalid = schema('Saved values with problems', [
  field('selection', 'MULTI_COMBO', [], { options: samplers }),
  field('bounds', 'BOUNDING_BOX', { x: 0, y: 0, width: 512, height: 512 }),
  field('edit', 'VIDEO_EDIT', {}, { features: ['trim', 'crop'] }),
])

const trims = schema('Video edits', [
  field('trimmed', 'VIDEO_EDIT', {}, { features: ['trim', 'crop'] }),
  field('no_duration', 'VIDEO_EDIT', {}, { features: ['trim', 'crop'] }),
])

/** A crop field whose default the side part names while its row has the keyboard. */
export const rowSummaryFocusSchema = schema('Crop image', [
  {
    ...field('crop', 'BOUNDING_BOX', { x: 0, y: 0, width: 1024, height: 768 }),
    tooltip: 'The part of the image to keep.',
  },
])

const specOf = (node: NodeSchema, id: string) =>
  (node.items.find((item) => item.kind === 'input' && item.id === id) as InputSpec)
    .widget!

/** Rows whose readout, what pointing at the row shows, the page lists under its cards. */
export const rowSummaryReadouts: readonly RowSummaryReadout[] = [
  { label: 'images', spec: specOf(hardest, 'images'), value: portraits },
  { label: 'palette', spec: specOf(hardest, 'palette'), value: nineColors },
  {
    label: 'selection',
    spec: specOf(invalid, 'selection'),
    value: ['euler', 'lms_karras'],
  },
  {
    label: 'list',
    spec: {
      widgetType: 'LIST',
      options: {},
      element: { widgetType: 'STRING', options: {} },
    },
    value: ['', '0.25', 'a, b'],
  },
  {
    label: 'trim and crop',
    spec: specOf(trims, 'trimmed'),
    value: {
      trim: { start_time: 1.5, duration: 2 },
      crop: { x: 8, y: 12, width: 512, height: 768 },
    },
  },
]

interface Placed {
  readonly id: string
  readonly schema: NodeSchema
  readonly x: number
  readonly y: number
  readonly width: number
  readonly values?: Record<string, Json>
}
interface Wire {
  readonly from: LinkEndpoint
  readonly to: { readonly node: string; readonly port: string }
}

const NODE_WIDTH = 280
const SOURCE_WIDTH = 160
const WIRE_GAP = 60
/** Room between cards in the page's world; each card draws only its own nodes. */
const CARD_GAP = 400
/** Room between the two nodes of a kind's card. */
const NODE_GAP = 108

/**
 * Closed row summaries for the 16 kinds of field, painted from real
 * documents by the product's renderer: each kind empty or initial,
 * populated, and in a node too narrow for the whole value, then the hardest
 * case and the states every value row shares.
 */
export function rowSummariesGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): {
  scene: Scene
  companions: CompanionMap
  rowMarks: RowMarkMap
  examples: readonly RowSummaryExample[]
} {
  const schemas: NodeSchema[] = []
  const cards: { caption: string; nodes: Placed[] }[] = []
  const wires: Wire[] = []
  let top = 0
  const card = (caption: string, nodes: readonly Omit<Placed, 'y'>[], offsets: readonly number[] = []) => {
    for (const node of nodes)
      if (!schemas.includes(node.schema)) schemas.push(node.schema)
    cards.push({
      caption,
      nodes: nodes.map((node, i) => ({ ...node, y: top + (offsets[i] ?? 0) })),
    })
    top += CARD_GAP
  }

  card('The hardest case: long and repeated names and nine colors in little room', [
    {
      id: 'hardest',
      schema: hardest,
      x: 0,
      width: 240,
      values: { images: portraits, palette: nineColors },
    },
  ])

  for (const kind of kindCases) {
    const declared = (id: string, value: Json) =>
      field(id, kind.widgetType, value, kind.options, kind.extra)
    const pair = schema(kind.title, [
      declared('empty', kind.empty),
      declared('populated', kind.populated),
    ])
    const narrow = {
      ...schema(`${kind.title}, narrow`, [declared('populated', kind.populated)]),
      displayName: 'Little room',
    }
    card(
      `${kind.title} (${kind.widgetType})`,
      [
        { id: kind.widgetType, schema: pair, x: 0, width: kind.wide ?? NODE_WIDTH },
        { id: `${kind.widgetType} narrow`, schema: narrow, x: 0, width: kind.narrow },
      ],
      [0, NODE_GAP],
    )
  }

  // A value that arrives down a wire is drawn with the same summary, in the
  // incoming style: grey when known, green when estimated, teal and
  // underlined when unproven. The stored values under it are not shown.
  const incoming = schema('Incoming values', [
    field('images', 'ASSET', null, imageAccept),
    field('selection', 'MULTI_COMBO', [], { options: samplers }),
    field('palette', 'COLORS', []),
  ])
  const source = schema('Image source', [
    { kind: 'output', id: 'images', type: concrete('ASSET') },
    { kind: 'output', id: 'selection', type: concrete('MULTI_COMBO') },
    { kind: 'output', id: 'palette', type: concrete('COLORS') },
  ])
  card(
    'Known, estimated and unproven incoming values',
    [
      { id: 'incoming source', schema: source, x: 0, width: SOURCE_WIDTH },
      {
        id: 'incoming',
        schema: incoming,
        x: SOURCE_WIDTH + WIRE_GAP,
        width: NODE_WIDTH,
        values: {
          images: [portraits[2]!],
          selection: ['euler', 'ddim'],
          palette: nineColors.slice(0, 2),
        },
      },
    ],
    [24, 0],
  )
  for (const port of ['images', 'selection', 'palette'])
    wires.push({
      from: { node: 'incoming source', port } as LinkEndpoint,
      to: { node: 'incoming', port },
    })

  card('Saved values with problems keep their data and their outline', [
    {
      id: 'invalid',
      schema: invalid,
      x: 0,
      width: NODE_WIDTH,
      values: {
        selection: ['euler', 'lms_karras'],
        bounds: { x: -4, y: 12, width: 0, height: 768 },
        edit: { crop: { x: 8, y: 12, width: 512.5, height: 768 } },
      },
    },
  ])

  const blanks = schema('Blank is not absent', [
    {
      ...field('empty_list', 'LIST', []),
      widget: {
        widgetType: 'LIST',
        options: {},
        default: [],
        element: { widgetType: 'STRING', options: {} },
      },
    },
    {
      ...field('blank_item', 'LIST', ['']),
      widget: {
        widgetType: 'LIST',
        options: {},
        default: [''],
        element: { widgetType: 'STRING', options: {} },
      },
    },
    field('image', 'ASSET', null, imageAccept),
    field('notes', 'MARKDOWN', ''),
    field('enabled', 'BOOLEAN', false),
    field('count', 'INT', 0, { min: 0, max: 10 }),
  ])
  card('Empty values each say what they are', [
    { id: 'blanks', schema: blanks, x: 0, width: NODE_WIDTH },
  ])

  card('A trim without its duration names the trim', [
    {
      id: 'trims',
      schema: trims,
      x: 0,
      width: NODE_WIDTH,
      values: {
        trimmed: { trim: { start_time: 1.5, duration: 2 } },
        no_duration: { trim: { start_time: 1.5 } },
      },
    },
  ])

  const placed = cards.flatMap((item) => item.nodes)
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
                size: { width: node.width, height: 0 },
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
      `Invalid row summaries gallery document: ${JSON.stringify(loaded)}`,
    )
  const scene = buildScene({
    document,
    graphId: 'gallery',
    resolve: (type) => schemas.find((item) => item.type === type),
    tokens,
    measure,
    widgetMeasure,
    seedControllerEnabled: true,
  })
  const indexOf = (id: string) => scene.nodes.findIndex((node) => node.id === id)
  return {
    scene,
    companions: {
      incoming: {
        images: { value: portraits, state: 'expected' },
        selection: { value: ['dpmpp_2m', 'euler', 'dpmpp_2m_sde'], state: 'estimate' },
        palette: { value: nineColors, state: 'stale' },
      },
    },
    rowMarks: { invalid: new Set(['selection', 'bounds', 'edit']) },
    examples: cards.map((item) => ({
      caption: item.caption,
      nodes: item.nodes.map((node) => indexOf(node.id)),
    })),
  }
}

/**
 * The page's Before: wraps a registry so the views it summarizes write what
 * they wrote before closed row summaries, for side by side comparison. Only
 * gallery pages use it.
 */
export function earlierRowSummaries(registry: WidgetRegistry): WidgetRegistry {
  // What each view wrote before, with the list items it fitted; views and
  // values not listed here draw as they do now.
  const earlier = (view: WidgetView, value: Json, spec: WidgetSpec): { text: string; items?: string[] } | undefined => {
    const record = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, Json>)
      : undefined
    switch (view.id) {
      case 'core.multiSelect':
        return { text: `${Array.isArray(value) ? value.length : 0} selected` }
      case 'core.list': {
        if (!Array.isArray(value) || value.length === 0) return undefined
        const items = value.map((item) =>
          typeof item === 'number' ? String(item) : typeof item === 'string' ? item : JSON.stringify(item),
        )
        return { text: items.join(', '), items }
      }
      case 'core.markdown':
        return { text: formatWidgetValue(value, spec).split('\n')[0] ?? '' }
      case 'core.asset':
        return Array.isArray(value) && value.length > 1 ? { text: `${value.length} assets` } : undefined
      case 'core.load3d':
        return { text: '3D viewport' }
      case 'core.boundingBox':
        return {
          text: record !== undefined &&
            ['x', 'y', 'width', 'height'].every((key) => typeof record[key] === 'number')
            ? `${record['x']}, ${record['y']} / ${record['width']} x ${record['height']}`
            : t('boundingBoxWidget.invalid'),
        }
      case 'core.imageCompare':
        return { text: 'Compare executed images' }
      case 'core.cameraAngle':
        return { text: t('cameraAngleWidget.title') }
      case 'core.videoEdit': {
        const sections = [
          record?.['trim'] === undefined ? undefined : 'trim',
          record?.['crop'] === undefined ? undefined : 'crop',
        ].filter(Boolean)
        return sections.length === 0 ? undefined : { text: sections.join(' + ') }
      }
      default:
        return undefined
    }
  }
  const earlierView = (view: WidgetView): WidgetView => ({
    ...view,
    drawCompact(ctx, value, spec, state) {
      const scene: SceneBuilder = {
        rect: (x, y, w, h, style) => ctx.rect(x, y, w, h, style),
        hitRegion: (x, y, w, h, action) => ctx.hitRegion(x, y, w, h, action),
        text: (x, y, run, style) => {
          if (style['role'] !== 'widgetValue') return ctx.text(x, y, run, style)
          // No view gave a count, a kept suffix or a shorter form before.
          const { count: _count, suffix: _suffix, shorter: _shorter, ...kept } = style
          const before = earlier(view, value, spec)
          if (before === undefined) return ctx.text(x, y, run, kept)
          const { items: _items, placeholder: _placeholder, ...plain } = kept
          ctx.text(x, y, before.text, before.items === undefined ? plain : { ...plain, items: before.items })
        },
      }
      view.drawCompact(scene, value, spec, state)
    },
  })
  return {
    ...registry,
    viewsFor: (kind) => registry.viewsFor(kind).map(earlierView),
  }
}
