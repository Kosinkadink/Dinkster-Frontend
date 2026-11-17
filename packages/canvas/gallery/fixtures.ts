import {
  defaultValuesOf,
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
  defaultTokens,
  buildScene,
  withPreviewRegion,
  executionBlockedBadge,
  executionErrorBadge,
  executionExpandedBadge,
  layoutNode,
  logWarningBadge,
  toolboxButton,
  type BadgeMap,
  type DesignTokens,
  type OverlayState,
  type PreviewMap,
  type Scene,
  type TextMeasurer,
  type ToolboxRow,
  type WidgetMeasure,
} from '../src/index.js'
import { structuralGalleryScene } from './structure.js'

export const canvasGalleryPages = [
  ['anatomy', 'Node anatomy'],
  ['states', 'Node states'],
  ['types', 'Pins and links'],
  ['widgets', 'Widget kinds'],
  ['widget-states', 'Widget states'],
  ['structure', 'Structural parts'],
  ['boundary', 'Subgraph boundaries'],
  ['badges', 'Badges and toolbar'],
  ['previews', 'Previews'],
  ['zoom', 'Lower zoom'],
  ['minimap', 'Minimap'],
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
const schema = (type: string, items: NodeSchema['items']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items,
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
  sample.items[2] as InputSpec,
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
      element: { widgetType: 'FLOAT', options: {} },
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
  widget('asset', 'ASSET', {
    digest: 'blake3:' + 'a'.repeat(64),
    name: 'portrait-reference.png',
    size: 1234567,
    mediaType: 'image/png',
    virtualPath: 'input/portrait-reference.png',
  }),
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
  labels: readonly { text: string; x: number; y: number }[]
}

/** Fixed public renderer inputs, also reusable for frame-equivalence checks. */
export function createCanvasGalleryFixture(
  page: CanvasGalleryPage,
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
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
    width: 960,
    height: 600,
    scale: 1,
    states: {},
    badges: {},
    overlay: {},
    toolbox: [],
    previews: {},
    labels: [],
  }
  const labels: { text: string; x: number; y: number }[] = []
  const add = (
    id: string,
    definition = sample,
    values: Record<string, Json> = {},
    index = fixture.scene.nodes.length,
  ) => {
    const x = 24 + (index % 3) * 312
    const y = 54 + Math.floor(index / 3) * 250
    const document = loadDocument({
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
              type: id === 'Missing type' ? 'Uninstalled' : definition.type,
              values: { ...defaultValuesOf(definition), ...values },
              ...(id === 'Renamed' ? { title: 'Refine pass' } : {}),
              ...(id === 'Muted'
                ? { mode: 'muted' }
                : id === 'Bypassed'
                  ? { mode: 'bypassed' }
                  : {}),
            },
          },
          links: {},
          nets: {},
          reroutes: {},
        },
      },
      view: {
        graphs: {
          gallery: {
            nodes: {
              [id]: {
                position: { x, y },
                size: { width: 280, height: 0 },
                ...(id === 'Minimized' ? { collapsed: true } : {}),
              },
            },
          },
        },
      },
    }).document
    if (!document) throw new Error('Invalid canvas gallery document')
    const scene = buildScene({
      document,
      graphId: 'gallery',
      resolve: (type) => (type === definition.type ? definition : undefined),
      tokens,
      measure,
      widgetMeasure,
      seedControllerEnabled: true,
    })
    fixture.scene.nodes.push(...scene.nodes)
    labels.push({ text: id, x, y: y - 24 })
  }
  if (page === 'widgets') {
    for (let column = 0; column < 3; column++) {
      add(
        `Kinds ${column + 1}`,
        schema(
          `Kinds ${column + 1}`,
          galleryWidgetInputs.slice(column * 10, column * 10 + 10),
        ),
        {},
        column,
      )
    }
  } else if (
    page === 'structure' ||
    page === 'boundary' ||
    page === 'minimap'
  ) {
    const scene = structuralGalleryScene(
      tokens,
      measure,
      widgetMeasure,
      page === 'boundary',
    )
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
    }
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
    fixture.overlay = {
      selection: new Set(['Selected']),
      hoveredNode: 'Hovered',
      hoveredWidget: { nodeId: 'Hovered row', valueKey: 'cfg' },
    }
    fixture.scene.nodes = fixture.scene.nodes.map((n) => ({
      ...n,
      ...(n.id === 'Muted' || n.id === 'Bypassed'
        ? {
            node: {
              ...n.node,
              mode:
                n.id === 'Muted' ? ('muted' as const) : ('bypassed' as const),
            },
          }
        : {}),
      ...(n.id === 'Colored' ? { color: tokens.stateColors.running } : {}),
      ...(n.id === 'Renamed'
        ? { node: { ...n.node, title: 'Refine pass' } }
        : {}),
      ...(n.id === 'Missing type' ? { missingSchema: true } : {}),
    }))
    fixture.height = 1800
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
    fixture.height = 850
  } else if (page === 'badges') {
    const badges = [
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
      PROBLEM_BLOCKING_WARNING_BADGE,
      PROBLEM_WARNING_BADGE,
      { id: 'core.media', glyph: 'M', color: tokens.colors.selection },
    ]
    const map: Record<string, (typeof badges)[number][]> = {}
    badges.forEach((badge) => {
      add(badge.id)
      map[badge.id] = [badge]
    })
    fixture.badges = map
    fixture.overlay = { selection: new Set([badges[0]!.id]) }
    fixture.toolbox = [
      [
        ...(
          [
            'play',
            'play-to',
            'play-between',
            'play-from',
            'volume-x',
            'ban',
            'circle',
            'group',
            'boxes',
            'trash-2',
            'ellipsis-vertical',
          ] as const
        ).map((icon) => toolboxButton({ id: icon, icon, label: icon })),
      ],
    ]
    fixture.height = 1300
  } else if (page === 'widget-states') {
    for (const id of [
      'Default',
      'Hovered',
      'Driven by link',
      'Shown value',
      'Offered',
      'Invalid',
      'Empty',
    ])
      add(
        id,
        schema(id, [
          widget('value', 'FLOAT', 0.65, { min: 0, max: 1 }),
          widget('text', 'STRING', id === 'Empty' ? '' : 'A stored value'),
        ]),
      )
    fixture.overlay = {
      hoveredWidget: { nodeId: 'Hovered', valueKey: 'value' },
    }
    fixture.height = 850
  } else if (page === 'previews') {
    for (const id of [
      'Image',
      'Loading',
      'Unavailable',
      'Failed',
      'Cached',
      'Estimate',
      'Video',
      'Audio',
      'Model',
    ])
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
      Unavailable: { status: 'unavailable' },
      Failed: { status: 'failed', statusMessage: 'Preview failed' },
      Cached: { state: 'cached' },
      Estimate: { state: 'estimate' },
      Video: { kind: 'video' },
      Audio: { kind: 'audio' },
      Model: { kind: 'model3d' },
    }
    fixture.scene.nodes = fixture.scene.nodes.map((node) => ({
      ...node,
      y: 54 + Math.floor(fixture.scene.nodes.indexOf(node) / 3) * 360,
      layout: withPreviewRegion(node.layout, tokens),
      previewCapable: true,
    }))
    fixture.height = 1250
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
    if (page === 'zoom') {
      fixture.scale = 0.6
      fixture.width = 600
      fixture.height = 350
    }
  }
  fixture.labels = labels.map((label) => {
    const node = fixture.scene.nodes.find((node) => node.id === label.text)
    return node ? { ...label, x: node.x, y: node.y - 24 } : label
  })
  return fixture
}
