import {
  defaultValuesOf,
  documentResolver,
  loadDocument,
  type InputSpec,
  type Json,
  type NodeSchema,
  type NodeProgress,
  type TypeExpr,
} from '@dinkster/core'
import {
  BYPASSED_BADGE,
  DEPRECATED_BADGE,
  ERROR_BADGE,
  LOG_INFO_BADGE,
  MUTED_BADGE,
  PROBLEM_BLOCKING_WARNING_BADGE,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  SUBGRAPH_BADGE,
  UNAVAILABLE_BADGE,
  defaultTokens,
  buildScene,
  dropTargetKey,
  pinPosition,
  executionBlockedBadge,
  executionErrorBadge,
  executionExpandedBadge,
  executionNodePresentation,
  nodeStatesForGraph,
  logWarningBadge,
  mediaDiagnosticBadge,
  regionIterationBadge,
  subgraphBadge,
  partialExecutionButtons,
  toolboxButton,
  toolboxSeparator,
  type BadgeMap,
  type PortProblemMap,
  type NodeBadge,
  type CompanionMap,
  type RowMarkMap,
  type DesignTokens,
  type OverlayState,
  type OutputTextMap,
  type PreviewMap,
  type Scene,
  type TextMeasurer,
  type ToolboxRow,
  type WidgetMeasure,
} from '../src/index.js'
import {
  boundaryNamesGalleryScene,
  structuralGalleryScene,
} from './structure.js'
import { smallFlowNodesGallery } from './small-flow-nodes.js'
import { switchPrimitiveGallery } from './switch-primitive.js'
import { typeConflictGallery } from './type-conflict.js'
import { widgetTapGallery } from './widget-taps.js'

export const canvasGalleryPages = [
  ['anatomy', 'Node anatomy'],
  ['idle-outline', 'Idle outline'],
  ['titles', 'Node titles'],
  ['titles-content', 'Node titles at content zoom'],
  ['tabs', 'Tabs'],
  ['tabs-content', 'Tabs at content zoom'],
  ['states', 'Node states'],
  ['run-editable', 'Editable workflow run states'],
  ['run-frozen', 'Frozen run states'],
  ['types', 'Pins and links'],
  ['widgets', 'Widget kinds'],
  ['core-rows', 'Core widget rows'],
  ['row-editing', 'Editing in the row proposal'],
  ['row-lists', 'Lists in the row proposal'],
  ['color-editing', 'Color in the row'],
  ['node-look', 'Original and new node look'],
  ['collection-rows', 'Collection widget rows'],
  ['editor-rows', 'Rows that open an editor'],
  ['widget-driven', 'Link-driven widgets'],
  ['widget-offered', 'Offered widgets'],
  ['widget-companions', 'Propagated values'],
  ['widget-taps', 'Widget output pins'],
  ['widget-states', 'Widget states'],
  ['text-boxes', 'Text box heights'],
  ['structure', 'Structural parts'],
  ['boundary', 'Subgraph boundaries'],
  ['boundary-names', 'Subgraph names'],
  ['badges', 'Badges and toolbar'],
  ['previews', 'Previews'],
  ['zoom', 'Controls zoom'],
  ['zoom-content', 'Content zoom'],
  ['zoom-overview', 'Overview zoom'],
  ['minimap', 'Minimap'],
  ['switch-primitive', 'Switch and Primitive'],
  ['small-flow-nodes', 'Or else, Has value and Only if'],
  ['type-conflict', 'Type conflicts'],
] as const
export type CanvasGalleryPage = (typeof canvasGalleryPages)[number][0]

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const widget = (
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
const schema = (type: string, body: NodeSchema['body']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body,
})
const sample = schema('Sampling', [
  { kind: 'input', id: 'model', type: concrete('MODEL'), optional: false },
  { kind: 'output', id: 'LATENT', type: concrete('LATENT') },
  {
    ...widget('seed', 'INT', 123456789, { min: 0, max: 999999999 }),
    widget: {
      widgetType: 'INT',
      options: { min: 0, max: 999999999 },
      default: 123456789,
      controller: 'after_generate',
    },
  },
  widget('steps', 'INT', 20, { min: 1, max: 10000 }),
  widget('cfg', 'FLOAT', 7.5, { min: 0, max: 100, step: 0.1 }),
  widget('sampler_name', 'COMBO', 'euler', {
    options: ['euler', 'dpmpp_2m_sde'],
  }),
])

export const galleryWidgetInputs: readonly InputSpec[] = [
  widget('integer', 'INT', 20, { min: 1, max: 10000 }),
  sample.body[2] as InputSpec,
  widget('float', 'FLOAT', 7.5, { min: 0, max: 100, step: 0.1 }),
  widget('slider', 'FLOAT', 0.65, {
    min: 0,
    max: 1,
    step: 0.01,
    display: 'slider',
  }),
  widget('integer_color', 'INT', 3368652, {
    display: 'color',
    min: 0,
    max: 16777215,
  }),
  widget('text', 'STRING', 'A deterministic compact string value'),
  widget('prompt', 'STRING', 'A red fox in tall grass, golden hour', {
    multiline: true,
  }),
  widget('toggle', 'BOOLEAN', true),
  widget('choice', 'COMBO', 'euler', { options: ['euler', 'dpmpp_2m_sde'] }),
  widget('multi_choice', 'MULTI_COMBO', ['red', 'alpha'], {
    options: ['red', 'green', 'blue', 'alpha'],
  }),
  {
    ...widget('list', 'LIST', [1, 0.5, 0.25]),
    widget: {
      widgetType: 'LIST',
      options: {},
      default: [1, 0.5, 0.25],
      element: { widgetType: 'FLOAT', options: { step: 0.1 } },
    },
  },
  widget('color', 'COLOR', '#3366cc80'),
  widget('colors', 'COLORS', ['#32E6C5', '#FF7468', '#FFD166']),
  widget('curve', 'CURVE', {
    points: [
      { position: 0, value: 0 },
      { position: 0.4, value: 0.8 },
      { position: 1, value: 1 },
    ],
  }),
  widget('compositor', 'COMPOSITOR', null),
  widget(
    'asset',
    'ASSET',
    {
      digest: 'blake3:' + 'a'.repeat(64),
      name: 'portrait-reference.png',
      size: 1234567,
      mediaType: 'image/png',
      virtualPath: 'input/portrait-reference.png',
    },
    { accept: ['image/png', 'image/jpeg', 'image/webp'] },
  ),
  widget('recording', 'AUDIO_RECORD', null),
  widget('webcam', 'WEBCAM', null),
  widget('mount', 'MOUNT', null),
  widget('model', 'LOAD_3D', {}),
  widget('button', 'BUTTON', null, { display_name: 'Refresh list' }),
  widget('markdown', 'MARKDOWN', '# Heading\nBody text'),
  widget('compare', 'IMAGECOMPARE', null),
  widget('camera_angle', 'CAMERA_ANGLE_VIEW', ''),
  widget('resolution', 'RESOLUTION_PREVIEW', null),
  widget('save_target', 'SAVE_TARGET', null),
  widget('bounding_box', 'BOUNDING_BOX', {
    x: 8,
    y: 16,
    width: 512,
    height: 384,
  }),
  widget('video_edit', 'VIDEO_EDIT', {}),
  widget('uninstalled', 'pack.unknownKind', 'Stored value'),
]

export interface CanvasGalleryFixture {
  scene: {
    -readonly [K in keyof Scene]: Scene[K] extends readonly (infer T)[]
      ? T[]
      : Scene[K]
  }
  width: number
  height: number
  scale: number
  states: Record<string, NodeProgress>
  badges: BadgeMap
  overlay: OverlayState
  toolbox: readonly ToolboxRow[]
  previews: PreviewMap
  outputTexts: OutputTextMap
  companions: CompanionMap
  rowMarks: RowMarkMap
  labels: readonly { text: string; x: number; y: number }[]
  /** Cards to draw: each lists its nodes' indexes in the scene, or covers the whole scene when it lists none, and may have its own overlay. */
  examples: readonly {
    caption: string
    nodes?: readonly number[]
    overlay?: OverlayState
    /** A card drawn from a scene of its own instead of the page's scene, with its own run states, values, marks and dimmed nodes. */
    scene?: Scene
    states?: Readonly<Record<string, NodeProgress>>
    companions?: CompanionMap
    rowMarks?: RowMarkMap
    inactive?: ReadonlySet<string>
    badges?: BadgeMap
    portProblems?: PortProblemMap
  }[]
}

/**
 * One node with an input that accepts a list beside an ordinary input of the
 * same type variable, shown open, matched by one image and matched by a list
 * of images; a node whose input that accepts a list has the fixed type INT;
 * an input that accepts a list with the union type IMAGE or MASK, open, fed
 * one image and fed a list of images; and a growing group of inputs that
 * accept a list and share one type variable, fed a list of images and one
 * image, then limited to IMAGE or MASK and left open. Built and solved the
 * way the app builds a graph.
 */
function acceptsListScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): Scene {
  const variable: TypeExpr = { kind: 'variable', templateId: 'T' }
  const image = concrete('IMAGE')
  const group = (type: TypeExpr): NodeSchema['body'] => [
    {
      kind: 'group',
      id: 'items',
      value: { kind: 'input', id: 'item', type, optional: true, acceptsList: true },
      keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
      grows: 'link',
      minMembers: 0,
      maxMembers: 8,
    },
    { kind: 'output', id: 'list', type: { kind: 'list', element: type } },
  ]
  const schemas = new Map<string, NodeSchema>([
    ['Join', schema('Join', [
      { kind: 'input', id: 'items', type: variable, optional: false, acceptsList: true },
      { kind: 'input', id: 'value', type: variable, optional: false },
      { kind: 'output', id: 'list', type: { kind: 'list', element: variable } },
    ])],
    ['Count', schema('Count', [
      { kind: 'input', id: 'items', type: concrete('INT'), optional: false, acceptsList: true },
      { kind: 'input', id: 'value', type: concrete('INT'), optional: false },
    ])],
    ['Either', schema('Either', [
      { kind: 'input', id: 'items', type: { kind: 'union', names: ['IMAGE', 'MASK'] }, optional: false, acceptsList: true },
    ])],
    ['Group', schema('Group', group(variable))],
    ['Limited', schema('Limited', group({ kind: 'variable', templateId: 'T', allowedTypes: [image, concrete('MASK')] }))],
    ['Image', schema('Image', [{ kind: 'output', id: 'IMAGE', type: image }])],
    ['Images', schema('Images', [{ kind: 'output', id: 'IMAGE', displayName: 'list of IMAGE', type: { kind: 'list', element: image } }])],
  ])
  const nodes: Record<string, { type: string; title?: string; x: number; y: number; members?: number }> = {
    open: { type: 'Join', title: 'Open', x: 240, y: 0 },
    image: { type: 'Image', x: 0, y: 130 },
    one: { type: 'Join', title: 'One image', x: 240, y: 130 },
    images: { type: 'Images', x: 0, y: 260 },
    list: { type: 'Join', title: 'A list of images', x: 240, y: 260 },
    fixed: { type: 'Count', title: 'Fixed type', x: 240, y: 390 },
    unionOpen: { type: 'Either', title: 'Union, open', x: 240, y: 500 },
    unionImage: { type: 'Image', x: 0, y: 590 },
    unionOne: { type: 'Either', title: 'Union, one image', x: 240, y: 590 },
    unionImages: { type: 'Images', x: 0, y: 680 },
    unionList: { type: 'Either', title: 'Union, a list of images', x: 240, y: 680 },
    groupImages: { type: 'Images', x: 0, y: 790 },
    groupImage: { type: 'Image', x: 0, y: 880 },
    group: { type: 'Group', title: 'Group, a list and one image', x: 240, y: 790, members: 2 },
    limited: { type: 'Limited', title: 'Group, IMAGE or MASK, open', x: 240, y: 960, members: 1 },
  }
  const member = (node: string, index: number) => ({ node, port: `items.item${index}` })
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery-accepts-list',
    root: 'root',
    graphs: {
      root: {
        id: 'root',
        name: 'Root',
        nextOrdinal: 20,
        nets: {},
        reroutes: {},
        nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [
          id,
          {
            id,
            type: node.type,
            values: {},
            ...(node.title ? { title: node.title } : {}),
            ...(node.members
              ? { dynamic: { items: { members: Array.from({ length: node.members }, (_, i) => `item${i}`), seq: node.members } } }
              : {}),
          },
        ])),
        links: {
          'one image': { id: 'one image', from: { node: 'image', port: 'IMAGE' }, to: { node: 'one', port: 'items' } },
          'list of images': { id: 'list of images', from: { node: 'images', port: 'IMAGE' }, to: { node: 'list', port: 'items' } },
          'union one': { id: 'union one', from: { node: 'unionImage', port: 'IMAGE' }, to: { node: 'unionOne', port: 'items' } },
          'union list': { id: 'union list', from: { node: 'unionImages', port: 'IMAGE' }, to: { node: 'unionList', port: 'items' } },
          'group list': { id: 'group list', from: { node: 'groupImages', port: 'IMAGE' }, to: member('group', 0) },
          'group one': { id: 'group one', from: { node: 'groupImage', port: 'IMAGE' }, to: member('group', 1) },
        },
      },
    },
    view: {
      graphs: {
        root: {
          nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [
            id,
            { position: { x: node.x, y: node.y } },
          ])),
        },
      },
    },
  })
  const document = loaded.document
  if (!document) throw new Error(`Invalid accepts-list gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document,
    graphId: 'root',
    resolve: documentResolver(document, (type) => schemas.get(type)),
    tokens,
    measure,
    widgetMeasure,
  })
}

/**
 * A subgraph with two inputs: `lists` feeds only an input that accepts a
 * list, and `mixed` also feeds an input that takes one image. Drawn from
 * outside, with a list of images wired to `lists`, and from inside, where
 * the Inputs panel shows the same two pins.
 */
function subgraphAcceptsListScenes(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): { readonly outside: Scene; readonly inside: Scene } {
  const image = concrete('IMAGE')
  const schemas = new Map<string, NodeSchema>([
    ['Join', schema('Join', [
      { kind: 'input', id: 'items', type: image, optional: false, acceptsList: true },
      { kind: 'output', id: 'list', type: { kind: 'list', element: image } },
    ])],
    ['Single', schema('Single', [{ kind: 'input', id: 'image', type: image, optional: false }])],
    ['Image', schema('Image', [{ kind: 'output', id: 'IMAGE', type: image }])],
    ['Images', schema('Images', [{ kind: 'output', id: 'IMAGE', displayName: 'list of IMAGE', type: { kind: 'list', element: image } }])],
  ])
  const nodes = (entries: Record<string, { type: string; title?: string }>) =>
    Object.fromEntries(Object.entries(entries).map(([id, node]) => [
      id,
      { id, type: node.type, values: {}, ...(node.title ? { title: node.title } : {}) },
    ]))
  const positions = (entries: Record<string, readonly [number, number]>) =>
    Object.fromEntries(Object.entries(entries).map(([id, [x, y]]) => [id, { position: { x, y } }]))
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery-subgraph-accepts-list',
    root: 'root',
    graphs: {
      root: {
        id: 'root',
        name: 'Root',
        nextOrdinal: 10,
        nets: {},
        reroutes: {},
        nodes: nodes({ images: { type: 'Images' }, image: { type: 'Image' }, sub: { type: '#body', title: 'Subgraph' } }),
        links: {
          'list in': { id: 'list in', from: { node: 'images', port: 'IMAGE' }, to: { node: 'sub', port: 'lists' } },
          'image in': { id: 'image in', from: { node: 'image', port: 'IMAGE' }, to: { node: 'sub', port: 'mixed' } },
        },
      },
      body: {
        id: 'body',
        name: 'Subgraph',
        nextOrdinal: 10,
        nets: {},
        reroutes: {},
        links: {},
        nodes: nodes({
          lists: { type: 'Join', title: 'Join lists' },
          mixed: { type: 'Join', title: 'Join mixed' },
          single: { type: 'Single', title: 'One image' },
        }),
        boundary: {
          inputs: [
            { id: 'lists', displayName: 'lists', binds: { kind: 'port', node: 'lists', port: 'items' } },
            { id: 'mixed', displayName: 'mixed', binds: { kind: 'port', node: 'mixed', port: 'items' }, alsoBinds: [{ kind: 'port', node: 'single', port: 'image' }] },
          ],
          outputs: [],
        },
      },
    },
    view: {
      graphs: {
        root: { nodes: positions({ images: [0, 0], image: [0, 130], sub: [260, 40] }) },
        body: {
          nodes: positions({ lists: [260, 0], mixed: [260, 110], single: [260, 220] }),
          boundary: { inputs: { position: { x: 0, y: 40 } }, outputs: { position: { x: 520, y: 40 } } },
        },
      },
    },
  })
  const document = loaded.document
  if (!document) throw new Error(`Invalid subgraph accepts-list gallery document: ${JSON.stringify(loaded)}`)
  const base = { document, resolve: documentResolver(document, (type) => schemas.get(type)), tokens, measure, widgetMeasure }
  return {
    outside: buildScene({ ...base, graphId: 'root' }),
    inside: buildScene({ ...base, graphId: 'body' }),
  }
}

/** Fixed public renderer inputs, also reusable for frame-equivalence checks. */
export function createCanvasGalleryFixture(
  page: CanvasGalleryPage,
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  widgetInput: InputSpec = galleryWidgetInputs[2]!,
  boundaryNames: 'current' | 'ids' = 'ids',
): CanvasGalleryFixture {
  const fixture: CanvasGalleryFixture = {
    scene: {
      graphId: 'gallery',
      nodes: [],
      links: [],
      reroutes: [],
      valueSources: [],
      selectors: [],
      netStubs: [],
      groups: [],
      boundaryNodes: [],
      diagnostics: [],
    },
    width: 944,
    height: 600,
    scale: 1,
    states: {},
    badges: {},
    overlay: {},
    toolbox: [],
    previews: {},
    outputTexts: {},
    companions: {},
    rowMarks: {},
    labels: [],
    examples: [],
  }
  const examples: CanvasGalleryFixture['examples'][number][] = []
  const add = (
    id: string,
    definition = sample,
    values: Record<string, Json> = {},
    index = fixture.scene.nodes.length,
    driven = false,
    view: { textLines?: Record<string, number>; height?: number } = {},
  ) => {
    const x = driven ? 244 : 24 + (index % 3) * 312
    const y = driven
      ? Math.max(
          54,
          ...fixture.scene.nodes.map(
            (node) => node.y + node.layout.height + 64,
          ),
        )
      : 54 + Math.floor(index / 3) * 250
    const producer = schema(
      'Source',
      definition.body.flatMap((item) =>
        item.kind === 'input' && item.widget
          ? [{ kind: 'output' as const, id: item.id, type: item.type }]
          : [],
      ),
    )
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
          nodes: {
            ...(driven
              ? {
                  [`${id} source`]: {
                    id: `${id} source`,
                    type: producer.type,
                    values: {},
                  },
                }
              : {}),
            [id]: {
              id,
              type: id === 'Missing type' ? 'Uninstalled' : definition.type,
              values: { ...defaultValuesOf(definition), ...values },
              ...(id === 'Renamed' ? { title: 'Refine pass' } : {}),
              ...(id === 'Long renamed'
                ? { title: 'A deliberately long custom refinement pass title' }
                : {}),
              ...(id === 'Muted'
                ? { mode: 'muted' }
                : id === 'Bypassed'
                  ? { mode: 'bypassed' }
                  : {}),
            },
          },
          links: driven
            ? Object.fromEntries(
                definition.body.flatMap((item, i) =>
                  item.kind === 'input' && item.widget
                    ? [
                        [
                          `${id}-${i}`,
                          {
                            id: `${id}-${i}`,
                            from: { node: `${id} source`, port: item.id },
                            to: { node: id, port: item.id },
                          },
                        ],
                      ]
                    : [],
                ),
              )
            : {},
          nets: {},
          reroutes: {},
        },
      },
      view: {
        graphs: {
          gallery: {
            nodes: {
              ...(driven
                ? {
                    [`${id} source`]: {
                      position: { x: 24, y },
                      size: { width: 160, height: 0 },
                    },
                  }
                : {}),
              [id]: {
                position: { x, y },
                size: { width: id === 'Narrow' ? 112 : 280, height: view.height ?? 0 },
                ...(view.textLines !== undefined ? { textLines: view.textLines } : {}),
                ...(id.startsWith('Minimized') || id === 'Long minimized'
                  ? { collapsed: true }
                  : {}),
                ...(id === 'Folded' || id === 'Text folded' ? { previewFolded: true } : {}),
                ...(id === 'Minimized opened' ? { minimizedPreviewOpen: true } : {}),
              },
            },
          },
        },
      },
    })
    const document = loaded.document
    if (!document)
      throw new Error(
        `Invalid canvas gallery document: ${JSON.stringify(loaded)}`,
      )
    const scene = buildScene({
      document,
      graphId: 'gallery',
      resolve: (type) =>
        type === definition.type
          ? definition
          : type === producer.type
            ? producer
            : undefined,
      tokens,
      measure,
      widgetMeasure,
      seedControllerEnabled: true,
    })
    examples.push({
      caption: id,
      nodes: scene.nodes.map((_, i) => fixture.scene.nodes.length + i),
    })
    fixture.scene.nodes.push(...scene.nodes)
    fixture.scene.links.push(...scene.links)
  }
  if (page === 'collection-rows') {
    const collection = galleryWidgetInputs.filter((item) =>
      ['multi_choice', 'list', 'colors', 'curve'].includes(item.id),
    )
    const definition = schema('Collection widgets', collection)
    add('Selected values', definition)
    add('Empty and minimal values', definition, {
      multi_choice: [],
      list: [],
      colors: [],
      curve: { points: [{ position: 0, value: 0.25 }] },
    })
    add('Long and varied values', definition, {
      multi_choice: ['red', 'green', 'blue', 'alpha'],
      list: [0.125, 1.5, 12.75, 256.25, 4096.875],
      colors: [
        '#32e6c5',
        '#ff7468',
        '#ffd166',
        '#3366cc80',
        '#cc66ff',
        '#ffffff',
      ],
      curve: {
        interpolation: 'monotone_cubic',
        points: [
          { position: 0, value: 0.8 },
          { position: 0.2, value: 0.1 },
          { position: 0.7, value: 0.65 },
          { position: 1, value: 0.3 },
        ],
      },
    })
  } else if (page === 'text-boxes') {
    const definition = schema('Prompt', [
      widget('positive', 'STRING', 'a red fox in deep snow, early morning light,\nlong shadows, shallow depth of field,\n85mm, film grain, muted colors', {
        multiline: true,
      }),
      widget('negative', 'STRING', 'blurry, low quality, text, watermark,\nextra limbs, oversaturated, cropped,\njpeg artifacts, duplicate', {
        multiline: true,
      }),
      widget('strength', 'FLOAT', 1, { min: 0, max: 2, step: 0.01 }),
    ])
    add('Declared height', definition)
    add('Each box its own height', definition, {}, undefined, false, {
      textLines: { positive: 5, negative: 2 },
    })
    add('Node made taller', definition, {}, undefined, false, {
      textLines: { positive: 5, negative: 2 },
      height: 400,
    })
    const sized = fixture.scene.nodes[1]!
    fixture.overlay = { textBoxEdge: { nodeId: sized.id, valueKey: 'positive' } }
    fixture.height = Math.max(
      320,
      ...fixture.scene.nodes.map((node) => node.y + node.layout.height + 24),
    )
  } else if (page === 'editor-rows') {
    const opener = galleryWidgetInputs.filter((item) =>
      [
        'asset',
        'recording',
        'webcam',
        'model',
        'bounding_box',
        'compare',
        'save_target',
        'video_edit',
        'list',
        'colors',
        'curve',
        'camera_angle',
        'resolution',
      ].includes(item.id),
    )
    const checkpoint: InputSpec = {
      kind: 'input',
      id: 'checkpoint',
      type: concrete('ASSET'),
      optional: false,
      widget: {
        widgetType: 'ASSET',
        kind: 'model/checkpoints',
        options: {},
        default: null,
      },
    }
    const definition = schema('Editor rows', [checkpoint, ...opener])
    const audio = {
      digest: 'blake3:' + 'b'.repeat(64),
      name: 'voice-take-2.wav',
      size: 482304,
      mediaType: 'audio/wav',
      virtualPath: 'input/voice-take-2.wav',
    }
    add('Chosen values', definition, {
      checkpoint: {
        digest: 'blake3:' + 'c'.repeat(64),
        name: 'sd_xl_base_1.0.safetensors',
        size: 6938078334,
        mediaType: 'application/octet-stream',
        virtualPath: 'models/checkpoints/sd_xl_base_1.0.safetensors',
      },
      recording: audio,
      webcam: {
        digest: 'blake3:' + 'd'.repeat(64),
        name: 'webcam-frame.png',
        size: 90211,
        mediaType: 'image/png',
        virtualPath: 'input/webcam-frame.png',
      },
      save_target: { mount: 'output', prefix: 'portraits/take' },
      video_edit: { trim: { start_time: 2, duration: 5 } },
    })
    add('Empty values', definition, {
      checkpoint: null,
      asset: null,
      recording: null,
      webcam: null,
      save_target: null,
      video_edit: {},
      list: [],
      colors: [],
      curve: {
        points: [
          { position: 0, value: 0 },
          { position: 1, value: 1 },
        ],
      },
    })
  } else if (page === 'core-rows') {
    const core = galleryWidgetInputs.filter((item) =>
      [
        'integer',
        'seed',
        'float',
        'text',
        'prompt',
        'toggle',
        'choice',
        'color',
        'asset',
      ].includes(item.id),
    )
    const definition = schema('Core widgets', core)
    const empty = {
      text: '',
      prompt: '',
      toggle: false,
      color: '#00000000',
      asset: null,
    }
    const longAsset = {
      ...(galleryWidgetInputs.find((item) => item.id === 'asset')!.widget!
        .default as Record<string, Json>),
      name: 'a-deliberately-long-reference-image-name-for-review.png',
    }
    add('Selected values', definition)
    add('Empty values', definition, empty)
    add('Long values', definition, {
      text: 'A deliberately long single-line value that must stay inside its field',
      choice: 'dpmpp_2m_sde',
      asset: longAsset,
    })
    fixture.height = Math.max(
      600,
      ...fixture.scene.nodes.map((node) => node.y + node.layout.height + 24),
    )
  } else if (
    page === 'widgets' ||
    page === 'widget-driven' ||
    page === 'widget-offered' ||
    page === 'widget-companions'
  ) {
    const companions: Record<
      string,
      Record<
        string,
        { value: Json; state: 'expected' | 'cached' | 'estimate' | 'stale' }
      >
    > = {}
    for (let column = 0; column < 3; column++) {
      const id = `Kinds ${column + 1}`
      const items = galleryWidgetInputs.slice(column * 10, column * 10 + 10)
      add(
        id,
        schema(
          id,
          page === 'widget-offered'
            ? items.map((item) => ({
                kind: 'group',
                id: `${item.id}_family`,
                value: item,
                keys: { kind: 'numbered', prefix: item.id, start: 1, pad: 0 },
                grows: 'link',
                minMembers: 0,
                maxMembers: 8,
              }))
            : items,
        ),
        {},
        column,
        page === 'widget-driven' || page === 'widget-companions',
      )
      if (page === 'widget-companions')
        companions[id] = Object.fromEntries(
          items.map((item, i) => [
            item.id,
            {
              value: (item.widget?.default ?? null) as Json,
              state: (['expected', 'cached', 'estimate', 'stale'] as const)[
                i % 4
              ]!,
            },
          ]),
        )
    }
    fixture.companions = companions
    fixture.height = Math.max(
      600,
      ...fixture.scene.nodes.map((node) => node.y + node.layout.height + 24),
    )
  } else if (
    page === 'structure' ||
    page === 'boundary' ||
    page === 'boundary-names' ||
    page === 'minimap'
  ) {
    const scene =
      page === 'boundary-names'
        ? boundaryNamesGalleryScene(
            tokens,
            measure,
            widgetMeasure,
            boundaryNames === 'ids',
          )
        : structuralGalleryScene(
            tokens,
            measure,
            widgetMeasure,
            page === 'boundary',
          )
    if (page === 'boundary-names')
      fixture.labels = [
        { text: 'Inside the subgraph', x: 24, y: 40 },
        { text: 'Collapsed occurrence', x: 360, y: 340 },
      ]
    examples.push({ caption: '' })
    fixture.scene = {
      ...scene,
      nodes: [...scene.nodes],
      links: [...scene.links],
      reroutes: [...scene.reroutes],
      valueSources: [...scene.valueSources],
      selectors: [...scene.selectors],
      netStubs: [...scene.netStubs],
      groups: [...scene.groups],
      boundaryNodes: [...scene.boundaryNodes],
      diagnostics: [...scene.diagnostics],
    }
    fixture.height = 650
    if (page === 'minimap') {
      fixture.width = 210
      fixture.height = 122
      const states = [
        'running',
        'error',
        'done',
        'pending',
        'skipped',
        'cached',
      ] as const
      fixture.scene.nodes = fixture.scene.nodes.map((node, index) => {
        fixture.states[node.id] = { state: states[index % states.length]! }
        return {
          ...node,
          ...(node.id === 'note'
            ? { node: { ...node.node, mode: 'bypassed' as const } }
            : {}),
          ...(node.id === 'markdown'
            ? { color: tokens.stateColors.running }
            : {}),
        }
      })
    }
  } else if (page === 'switch-primitive') {
    const cards = switchPrimitiveGallery(tokens, measure, widgetMeasure)
    // Each card draws its own scene; the page's scene is the first card's,
    // for checks that read one scene per page.
    const first = cards[0]!.scene
    fixture.scene.nodes = [...first.nodes]
    fixture.scene.links = [...first.links]
    fixture.scene.boundaryNodes = [...first.boundaryNodes]
    examples.push(...cards)
  } else if (page === 'small-flow-nodes') {
    const cards = smallFlowNodesGallery(tokens, measure, widgetMeasure)
    const first = cards[0]!.scene
    fixture.scene.nodes = [...first.nodes]
    fixture.scene.links = [...first.links]
    fixture.scene.boundaryNodes = [...first.boundaryNodes]
    examples.push(...cards)
  } else if (page === 'type-conflict') {
    const cards = typeConflictGallery(tokens, measure, widgetMeasure)
    const first = cards[0]!.scene
    fixture.scene.nodes = [...first.nodes]
    fixture.scene.links = [...first.links]
    examples.push(...cards)
  } else if (page === 'widget-taps') {
    const gallery = widgetTapGallery(tokens, measure, widgetMeasure)
    fixture.scene.nodes = [...gallery.scene.nodes]
    fixture.scene.links = [...gallery.scene.links]
    fixture.companions = gallery.companions
    examples.push(...gallery.examples)
  } else if (page === 'titles' || page === 'titles-content') {
    const long = {
      ...sample,
      displayName: 'A long node title that does not fit the title bar',
    }
    add('Fits', sample)
    add('Long ordinary', long)
    add('Renamed', sample)
    add('Long renamed', sample)
    add('Minimized', sample)
    add('Long minimized', {
      ...sample,
      displayName:
        'A long minimized node title that exceeds the maximum automatic node width and must end in an ellipsis',
    })
    fixture.width = Math.max(
      fixture.width,
      ...fixture.scene.nodes.map((node) => node.x + node.layout.width + 24),
    )
    fixture.badges = {
      'Long ordinary': [SUBGRAPH_BADGE, DEPRECATED_BADGE],
    }
    fixture.height = 550
    fixture.scale =
      page === 'titles-content' ? 0.5 : tokens.mediaControlMinScale
    fixture.width *= fixture.scale
    fixture.height *= fixture.scale
  } else if (page === 'tabs' || page === 'tabs-content') {
    const ids = [
      'Idle',
      'Selected',
      'Running',
      'Finished',
      'Queued',
      'Cached',
      'Skipped',
      'Failed',
      'Document error',
      'Blocking warning',
      'Missing type',
      'Muted',
      'Bypassed',
      'Minimized',
      'Crowded',
      'Narrow',
      'Empty',
      'Long words',
    ]
    ids.forEach((id) => add(id, sample))
    const states = {
      Running: 'running',
      Finished: 'done',
      Queued: 'pending',
      Cached: 'cached',
      Skipped: 'skipped',
      Failed: 'error',
    } as const
    const map: Record<string, NodeBadge[]> = {}
    for (const id of ids) {
      if (id === 'Empty') continue
      map[id] = [id === 'Idle' ? subgraphBadge(3) : SUBGRAPH_BADGE, DEPRECATED_BADGE]
      const state = states[id as keyof typeof states]
      if (state) {
        fixture.states[id] = { state }
        map[id]!.push(
          ...executionNodePresentation({ [id]: { state } }, true, tokens).badges[id]!,
        )
      }
    }
    map['Document error']!.push(PROBLEM_ERROR_BADGE)
    map['Blocking warning']!.push(PROBLEM_BLOCKING_WARNING_BADGE)
    map.Muted!.push(MUTED_BADGE)
    map.Bypassed!.push(BYPASSED_BADGE)
    const crowded = Array.from(
      { length: 9 },
      (_, index): NodeBadge => ({
        id: `gallery.detail.${index}`,
        glyph: `Detail ${index + 1}`,
        placement: 'below',
        icon: 'info',
        color: LOG_INFO_BADGE.color,
      }),
    )
    map.Crowded!.push(...crowded)
    map.Narrow!.push(...crowded)
    map.Minimized!.push(...crowded)
    map['Long words']!.push({
      ...executionErrorBadge(3),
      glyph: 'A deliberately long diagnostic message that must stay bounded',
    })
    fixture.badges = map
    fixture.overlay = { selection: new Set(['Selected']) }
    fixture.height = 1540
    fixture.scale = page === 'tabs-content' ? 0.5 : tokens.mediaControlMinScale
    fixture.width *= fixture.scale
    fixture.height *= fixture.scale
  } else if (page === 'idle-outline') {
    for (const id of ['Idle', 'Hovered', 'Selected']) add(id, sample)
    fixture.overlay = {
      selection: new Set(['Selected']),
      hoveredNode: 'Hovered',
    }
    fixture.height = 440
  } else if (page === 'run-editable' || page === 'run-frozen') {
    const progress: Record<string, NodeProgress> = {
      Queued: { state: 'pending' },
      Running: { state: 'running', value: 0.45 },
      Finished: { state: 'done' },
      Cached: { state: 'cached' },
      Skipped: { state: 'skipped' },
      Failed: { state: 'error' },
      active: { state: 'running', value: 0.3 },
      complete: { state: 'done', value: 1 },
      failed: { state: 'error' },
    }
    const ids = [
      'Queued',
      'Running',
      'Finished',
      'Cached',
      'Skipped',
      'Failed',
      'No execution',
      'Collapsed running + done',
      'Collapsed done + failed',
    ]
    ids.forEach((id) => add(id, sample))
    fixture.scene.nodes = fixture.scene.nodes.map((node) => ({
      ...node,
      isSubgraph: node.id.startsWith('Collapsed'),
    }))
    const projected = nodeStatesForGraph(progress, fixture.scene, (id) =>
      id === 'Collapsed running + done'
        ? ['active', 'complete']
        : id === 'Collapsed done + failed'
          ? ['complete', 'failed']
          : [id],
    )
    const presentation = executionNodePresentation(
      projected,
      page === 'run-frozen',
      tokens,
    )
    fixture.states = presentation.states
    fixture.badges = presentation.badges
    fixture.height = 800
  } else if (page === 'states') {
    const ids = [
      'Default',
      'Hovered',
      'Selected',
      'Queued',
      'Running',
      'Finished',
      'Cached',
      'Skipped',
      'Failed',
      'Document error',
      'Blocking warning',
      'Warning',
      'Muted',
      'Bypassed',
      'Colored',
      'Renamed',
      'Missing type',
      'Minimized',
      'Minimize arrow hovered',
      'Invalid value',
      'Hovered row',
    ]
    ids.forEach((id) =>
      add(id, sample, id === 'Invalid value' ? { steps: 0 } : {}),
    )
    const states = [
      'pending',
      'running',
      'done',
      'cached',
      'skipped',
      'error',
    ] as const
    states.forEach((state, i) => {
      fixture.states[ids[i + 3]!] = {
        state,
        ...(state === 'running' ? { value: 0.45 } : {}),
      }
    })
    fixture.badges = {
      'Document error': [PROBLEM_ERROR_BADGE],
      'Blocking warning': [PROBLEM_BLOCKING_WARNING_BADGE],
      Warning: [PROBLEM_WARNING_BADGE],
      Failed: [executionErrorBadge(1)],
      Muted: [MUTED_BADGE],
      Bypassed: [BYPASSED_BADGE],
    }
    // One card: a FLOAT wire held from a value node over the cfg field it
    // fits, so the row shows it takes the wire on release.
    const held = 'Wire held over a row'
    add('Value', schema('Value', [{ kind: 'output', id: 'FLOAT', type: concrete('FLOAT') }]))
    add(held, sample)
    const heldY = 54 + 7 * 250
    fixture.scene.nodes = fixture.scene.nodes.map((node) =>
      node.id === 'Value' ? { ...node, x: 24, y: heldY + 120 }
        : node.id === held ? { ...node, x: 424, y: heldY } : node)
    const valueNode = fixture.scene.nodes.at(-2)!
    const heldNode = fixture.scene.nodes.at(-1)!
    examples.splice(-2, 2, { caption: held, nodes: [fixture.scene.nodes.length - 2, fixture.scene.nodes.length - 1] })
    const from = pinPosition(valueNode, 'FLOAT', 'out')!
    const to = pinPosition(heldNode, 'cfg', 'in')!
    fixture.overlay = {
      selection: new Set(['Selected']),
      hoveredNode: 'Hovered',
      hoveredWidget: { nodeId: 'Hovered row', valueKey: 'cfg' },
      hoveredMinimize: 'Minimize arrow hovered',
      ghostLink: { x1: from.x, y1: from.y, x2: to.x, y2: to.y, typeName: 'FLOAT' },
      dropTargets: new Set([dropTargetKey(held, 'cfg', 'in')]),
      dropRow: { nodeId: held, valueKey: 'cfg' },
    }
    fixture.rowMarks = { 'Invalid value': new Set(['steps']) }
    fixture.scene.nodes = fixture.scene.nodes.map((node) => ({
      ...node,
      ...(node.id === 'Colored' ? { color: tokens.stateColors.running } : {}),
    }))
    fixture.height = 2100
  } else if (page === 'types') {
    const types: TypeExpr[] = Object.keys(defaultTokens.typeColors).map(
      concrete,
    )
    types.push(
      { kind: 'list', element: concrete('IMAGE') },
      { kind: 'union', names: ['IMAGE', 'MASK'] },
      { kind: 'wildcard' },
      { kind: 'variable', templateId: 'T' },
    )
    add(
      'Outputs',
      schema(
        'Outputs',
        types.map((type, i) => ({
          kind: 'output',
          id: `type_${i}`,
          displayName: type.kind === 'concrete' ? type.name : type.kind,
          type,
        })),
      ),
      {},
      0,
    )
    add(
      'Inputs',
      schema(
        'Inputs',
        types.map((type, i) => ({
          kind: 'input',
          id: `type_${i}`,
          displayName: type.kind === 'concrete' ? type.name : type.kind,
          type,
          optional: i % 2 === 1,
        })),
      ),
      {},
      2,
    )
    // The linked pair is one example.
    examples.splice(0, examples.length, { caption: '', nodes: [0, 1] })
    const [source, target] = fixture.scene.nodes
    source!.layout.pins
      .filter((pin) => pin.direction === 'out')
      .forEach((pin, i) => {
        const to = target!.layout.pins.filter((pin) => pin.direction === 'in')[
          i
        ]!
        fixture.scene.links.push({
          id: `link_${i}`,
          from: { kind: 'port', node: source!.id, port: pin.portId },
          to: { kind: 'port', node: target!.id, port: to.portId },
          x1: source!.x + source!.layout.width,
          y1: source!.y + pin.y,
          x2: target!.x,
          y2: target!.y + to.y,
          fromType: types[i]!,
          toType: types[i]!,
          ...(types[i]!.kind === 'concrete'
            ? { typeName: (types[i] as { name: string }).name }
            : {}),
        })
      })
    examples.push({
      caption:
        'An input that accepts a list keeps the one-value-or-list pin while its type is open, after one image matches it, after a list of images matches it, when its type is the fixed type INT, and when its type is the union IMAGE or MASK, open, with one image and with a list of images. In a growing group whose members share one type, a list of images and one image are both accepted, and a group limited to IMAGE or MASK shows both colors while open. Value, an ordinary input of the same type, is a plain circle once its type is known.',
      scene: acceptsListScene(tokens, measure, widgetMeasure),
    })
    const subgraph = subgraphAcceptsListScenes(tokens, measure, widgetMeasure)
    examples.push(
      {
        caption:
          'A subgraph input keeps the one-value-or-list pin when every input it feeds inside accepts a list, so a list of images wires to lists. Mixed also feeds an input that takes one image, so it keeps the plain pin.',
        scene: subgraph.outside,
      },
      {
        caption: 'Inside the same subgraph, the Inputs panel draws the same two pins.',
        scene: subgraph.inside,
      },
    )
    fixture.height = 850
  } else if (page === 'badges') {
    const badges: NodeBadge[] = [
      ERROR_BADGE,
      executionErrorBadge(2),
      executionBlockedBadge('Missing image'),
      executionExpandedBadge(3),
      logWarningBadge(2),
      LOG_INFO_BADGE,
      SUBGRAPH_BADGE,
      DEPRECATED_BADGE,
      MUTED_BADGE,
      BYPASSED_BADGE,
      PROBLEM_ERROR_BADGE,
      UNAVAILABLE_BADGE,
      PROBLEM_BLOCKING_WARNING_BADGE,
      PROBLEM_WARNING_BADGE,
      mediaDiagnosticBadge('core.media.alpha_dropped.image.IMAGE', 'Alpha dropped: IMAGE'),
      mediaDiagnosticBadge('core.media.mask_polarity.mask.mask', 'Mask polarity: mask'),
      regionIterationBadge('iteration 2 of 3'),
    ]
    const map: Record<string, (typeof badges)[number][]> = {}
    // Some core badges share an id and differ in their words, such as Error and Error 2.
    badges.forEach((badge) => {
      const id = `${badge.id}: ${badge.glyph}`
      add(id)
      map[id] = [badge]
    })
    fixture.badges = map
    fixture.overlay = { selection: new Set([`${badges[0]!.id}: ${badges[0]!.glyph}`]) }
    // The rows CanvasHost builds for one ordinary node in the root graph.
    fixture.toolbox = [
      partialExecutionButtons({
        between: 'requires a contiguous multi-node selection',
      }).map(toolboxButton),
      [
        toolboxButton({ id: 'core.delete', icon: 'trash-2', label: 'Delete' }),
        toolboxSeparator(),
        toolboxButton({
          id: 'core.mode',
          icon: 'sliders-horizontal',
          label: 'Choose mode',
        }),
        toolboxButton({
          id: 'core.extractSubgraph',
          icon: 'group',
          label: 'Extract as subgraph',
        }),
        toolboxButton({
          id: 'core.flattenSubgraph',
          icon: 'ungroup',
          label: 'Flatten subgraph one level',
          disabled: true,
          reason: 'Select exactly one subgraph occurrence.',
        }),
        toolboxSeparator(),
        toolboxButton({
          id: 'core.color',
          icon: 'circle',
          label: 'Choose color',
        }),
        toolboxSeparator(),
        toolboxButton({
          id: 'core.more',
          icon: 'ellipsis-vertical',
          label: 'More actions',
        }),
      ],
    ]
    fixture.height = 1300
  } else if (page === 'widget-states') {
    for (const [index, id] of [
      'Default',
      'Hovered',
      'Offered',
      'Invalid',
      'Empty',
    ].entries()) {
      const value = widgetInput
      add(
        id,
        schema(id, [
          id === 'Offered'
            ? {
                kind: 'group',
                id: 'values',
                value,
                // The offered row reads the kind's name and position: "text 1".
                keys: { kind: 'numbered', prefix: value.id, start: 1, pad: 0 },
                grows: 'link',
                minMembers: 0,
                maxMembers: 8,
              }
            : value,
        ]),
        id === 'Empty'
          ? {
              [value.id]:
                typeof value.widget?.default === 'string'
                  ? ''
                  : Array.isArray(value.widget?.default)
                    ? []
                    : null,
            }
          : {},
        index,
      )
    }
    fixture.overlay = {
      hoveredWidget: { nodeId: 'Hovered', valueKey: widgetInput.id },
    }
    fixture.rowMarks = { Invalid: new Set([widgetInput.id]) }
    fixture.height = 850
  } else if (page === 'previews') {
    // Rows of three: each row's height in the gallery.
    const rows: readonly (readonly [number, readonly string[]])[] = [
      [300, ['No picture yet', 'Image', 'Folded']],
      [90, ['Loading', 'Failed', 'Video']],
      [300, ['Cached', 'Estimate', 'Text result']],
      [90, ['Text folded', 'Minimized', 'Minimized loading']],
      [270, ['Minimized image', 'Minimized opened', 'Minimized text']],
    ]
    for (const [, ids] of rows)
      for (const id of ids)
        add(
          id,
          schema(id, [
            {
              kind: 'input',
              id: 'images',
              type: concrete('IMAGE'),
              optional: false,
            },
          ]),
        )
    fixture.previews = {
      Loading: { status: 'loading' },
      Failed: { status: 'failed' },
      Video: { kind: 'video', status: 'loading' },
      'Minimized loading': { status: 'loading' },
    }
    const text = 'A red fox in deep snow, early morning light,\nlong shadows, shallow depth of field'
    fixture.outputTexts = {
      'Text result': { text },
      'Text folded': { text },
      'Minimized text': { text },
    }
    fixture.overlay = { hoveredPreviewCaption: 'Folded' }
    const rowY = rows.map((_, index) => 54 + rows.slice(0, index).reduce((y, [height]) => y + height, 0))
    fixture.scene.nodes = fixture.scene.nodes.map((node) => ({
      ...node,
      y: rowY[rows.findIndex(([, ids]) => ids.includes(node.id))]!,
      previewCapable: true,
    }))
    fixture.height = rowY[rowY.length - 1]! + rows[rows.length - 1]![0]
  } else {
    add('Ordinary node')
    add('Long title', {
      ...sample,
      displayName: 'A long node title that does not fit the title bar',
    })
    add('Subgraph')
    fixture.scene.nodes = fixture.scene.nodes.map((node) => ({
      ...node,
      isSubgraph: node.id === 'Subgraph',
    }))
    fixture.badges = { ...fixture.badges, Subgraph: [SUBGRAPH_BADGE] }
    if (page === 'anatomy') {
      for (const collapsed of [false, true]) {
        add(
          collapsed ? 'Collapsed section' : 'Expanded section',
          schema('Section example', [
            {
              kind: 'input',
              id: 'image',
              type: concrete('IMAGE'),
              optional: true,
            },
            { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
            {
              kind: 'section',
              id: 'advanced',
              displayName: 'Advanced',
              collapsedByDefault: collapsed,
              rows: [
                widget('amount', 'FLOAT', 0.75),
                {
                  kind: 'input',
                  id: 'mask',
                  type: concrete('MASK'),
                  optional: true,
                },
              ],
            },
          ]),
        )
      }
      add('Missing type')
    }
    if (
      page === 'zoom' ||
      page === 'zoom-content' ||
      page === 'zoom-overview'
    ) {
      fixture.scale =
        page === 'zoom'
          ? tokens.mediaControlMinScale
          : page === 'zoom-content'
            ? 0.5
            : 0.49
      fixture.width = 960 * fixture.scale
      fixture.height = 350 * fixture.scale
    }
  }
  fixture.examples = examples
  return fixture
}

/** The node the row-editing page opens fields on: a number, a slider, a seed and a single-line text. */
export const rowEditingSchema: NodeSchema = schema('Sample image', [
  { kind: 'input', id: 'model', type: concrete('MODEL'), optional: false },
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
  {
    ...widget('seed', 'INT', 123456789, {
      min: 0,
      max: '18446744073709551615',
    }),
    tooltip: 'Starting point of the noise.',
    widget: {
      widgetType: 'INT',
      options: { min: 0, max: '18446744073709551615' },
      default: 0,
      controller: 'after_generate',
    },
  },
  {
    ...widget('steps', 'INT', 20, { min: 1, max: 10000 }),
    tooltip: 'Number of denoising steps.',
  },
  {
    ...widget('cfg', 'FLOAT', 7, { min: 0, max: 100, step: 0.01 }),
    tooltip: 'How closely the image follows the prompt.',
  },
  {
    ...widget('denoise', 'FLOAT', 1, {
      min: 0,
      max: 1,
      step: 0.01,
      display: 'slider',
    }),
    tooltip: 'How much of the input image is replaced.',
  },
  {
    ...widget('filename_prefix', 'STRING', 'Dinkster'),
    tooltip: 'Start of every saved file name.',
  },
])

/** A document holding one node, laid out by the production scene builder. */
function singleNodeScene(
  definition: NodeSchema,
  node: Record<string, Json>,
  view: Record<string, Json>,
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): Scene {
  const id = definition.type
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
        nodes: {
          [id]: {
            id,
            type: definition.type,
            ...node,
            values: {
              ...defaultValuesOf(definition),
              ...((node['values'] as Record<string, Json> | undefined) ?? {}),
            },
          },
        },
        links: {},
        nets: {},
        reroutes: {},
      },
    },
    view: { graphs: { gallery: { nodes: { [id]: view } } } },
  })
  if (!loaded.document)
    throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) => (type === definition.type ? definition : undefined),
    tokens,
    measure,
    widgetMeasure,
    seedControllerEnabled: true,
  })
}

/** One node of the row-editing page, laid out by the production scene builder. */
export function createRowEditingScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  width = 280,
): Scene {
  return singleNodeScene(
    rowEditingSchema,
    { values: { seed: 123456789, denoise: 0.65 } },
    { position, size: { width, height: 0 } },
    tokens,
    measure,
    widgetMeasure,
  )
}

/** A node with a toggle and a choice beside a number, for the keyboard's focus on a row. */
export const rowFocusSchema: NodeSchema = schema('Sample settings', [
  {
    ...widget('steps', 'INT', 20, { min: 1, max: 10000 }),
    tooltip: 'Number of denoising steps.',
  },
  {
    ...widget('enabled', 'BOOLEAN', true),
    tooltip: 'Turn the pass on or off.',
  },
  {
    ...widget('sampler_name', 'COMBO', 'euler', {
      options: ['euler', 'euler_ancestral', 'dpmpp_2m'],
    }),
    tooltip: 'The sampling method.',
  },
])

/** The node of the row-editing page's keyboard examples. */
export function createRowFocusScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  width = 280,
): Scene {
  return singleNodeScene(
    rowFocusSchema,
    {},
    { position, size: { width, height: 0 } },
    tokens,
    measure,
    widgetMeasure,
  )
}

const coreInput = (id: string): InputSpec =>
  galleryWidgetInputs.find((item) => item.id === id)!

/** The nodes of the node look page, each shown in every look. */
export const nodeLookExamples = [
  [
    'sample',
    'Sample image',
    'A pin row, a seed, two numbers, a slider and a text.',
  ],
  ['pins', 'Pins only', 'Three inputs and two outputs, no widgets.'],
  [
    'raised',
    'Raised rows',
    'An asset and a color open a picker; a toggle, a dropdown and a multiline text.',
  ],
  [
    'sections',
    'Sections',
    'A collapsed section with a changed value, and the open Advanced section with its wash.',
  ],
  ['collapsed', 'Collapsed', 'A collapsed node is its title bar alone.'],
  ['selected', 'Selected', 'The selection outline.'],
  ['running', 'Running', 'Running, 45 percent done.'],
  ['error', 'Error', 'The run failed on this node.'],
  ['muted', 'Muted', 'A muted node is dimmed.'],
  ['bypassed', 'Bypassed', 'A bypassed node is dimmed under a purple wash.'],
  [
    'subgraph',
    'Subgraph instance',
    'An instance of a subgraph, with its badge.',
  ],
] as const
export type NodeLookExample = (typeof nodeLookExamples)[number][0]

const nodeLookSchemas: Record<
  'pins' | 'raised' | 'sections' | 'subgraph',
  NodeSchema
> = {
  pins: schema('Image blend', [
    { kind: 'input', id: 'image', type: concrete('IMAGE'), optional: false },
    { kind: 'input', id: 'overlay', type: concrete('IMAGE'), optional: false },
    { kind: 'input', id: 'mask', type: concrete('MASK'), optional: true },
    { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
    { kind: 'output', id: 'MASK', type: concrete('MASK') },
  ]),
  raised: schema(
    'Load reference',
    ['asset', 'color', 'toggle', 'choice', 'prompt'].map(coreInput),
  ),
  sections: schema('Save video', [
    { kind: 'input', id: 'images', type: concrete('IMAGE'), optional: false },
    widget('fps', 'FLOAT', 24, { min: 1, max: 120, step: 1 }),
    {
      kind: 'section',
      id: 'output',
      displayName: 'Output',
      collapsedByDefault: true,
      rows: [
        widget('filename_prefix', 'STRING', 'video/Dinkster'),
        widget('format', 'COMBO', 'mp4', { options: ['mp4', 'webm'] }),
      ],
    },
    {
      kind: 'section',
      id: 'advanced',
      displayName: 'Advanced',
      collapsedByDefault: true,
      rows: [
        widget('crf', 'INT', 19, { min: 0, max: 51 }),
        widget('preset', 'COMBO', 'medium', {
          options: ['fast', 'medium', 'slow'],
        }),
      ],
    },
  ]),
  subgraph: schema('Upscale and sharpen', [
    { kind: 'input', id: 'image', type: concrete('IMAGE'), optional: false },
    { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
    widget('scale', 'FLOAT', 2, { min: 1, max: 4, step: 0.5 }),
    widget('sharpen', 'FLOAT', 0.35, {
      min: 0,
      max: 1,
      step: 0.05,
      display: 'slider',
    }),
  ]),
}

/** One node of the node look page with its run state, badges and selection. */
export function createNodeLookFixture(
  example: NodeLookExample,
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  width = 280,
): Pick<CanvasGalleryFixture, 'states' | 'badges' | 'overlay'> & {
  scene: Scene
} {
  const size = { width, height: 0 }
  if (example === 'sample')
    return {
      scene: createRowEditingScene(
        tokens,
        measure,
        widgetMeasure,
        position,
        width,
      ),
      states: {},
      badges: {},
      overlay: {},
    }
  if (
    example === 'pins' ||
    example === 'raised' ||
    example === 'sections' ||
    example === 'subgraph'
  ) {
    const definition = nodeLookSchemas[example]
    const scene = singleNodeScene(
      definition,
      example === 'sections' ? { values: { format: 'webm' } } : {},
      {
        position,
        size,
        ...(example === 'sections'
          ? { sections: { advanced: { collapsed: false } } }
          : {}),
      },
      tokens,
      measure,
      widgetMeasure,
    )
    return {
      scene:
        example === 'subgraph'
          ? {
              ...scene,
              nodes: scene.nodes.map((node) => ({ ...node, isSubgraph: true })),
            }
          : scene,
      states: {},
      badges:
        example === 'subgraph' ? { [definition.type]: [SUBGRAPH_BADGE] } : {},
      overlay: {},
    }
  }
  const scene = singleNodeScene(
    sample,
    example === 'muted' || example === 'bypassed' ? { mode: example } : {},
    { position, size, ...(example === 'collapsed' ? { collapsed: true } : {}) },
    tokens,
    measure,
    widgetMeasure,
  )
  return {
    scene,
    states:
      example === 'running'
        ? { [sample.type]: { state: 'running', value: 0.45 } }
        : example === 'error'
          ? { [sample.type]: { state: 'error' } }
          : {},
    badges:
      example === 'error' ? { [sample.type]: [executionErrorBadge(1)] } : {},
    overlay:
      example === 'selected' ? { selection: new Set([sample.type]) } : {},
  }
}
