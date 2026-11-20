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
  executionNodePresentation,
  nodeStatesForGraph,
  logWarningBadge,
  toolboxButton,
  type BadgeMap,
  type NodeBadge,
  type CompanionMap,
  type RowMarkMap,
  type DesignTokens,
  type OverlayState,
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

export const canvasGalleryPages = [
  ['anatomy', 'Node anatomy'],
  ['idle-outline', 'Idle outline'],
  ['titles', 'Node titles'],
  ['titles-content', 'Node titles at content zoom'],
  ['tabs', 'Attached tabs proposal'],
  ['tabs-content', 'Attached tabs at content zoom'],
  ['states', 'Node states'],
  ['run-editable', 'Editable workflow run states'],
  ['run-frozen', 'Frozen run states'],
  ['types', 'Pins and links'],
  ['widgets', 'Widget kinds'],
  ['core-rows', 'Core widget rows'],
  ['row-editing', 'Editing in the row proposal'],
  ['collection-rows', 'Collection widget rows proposal'],
  ['widget-driven', 'Link-driven widgets'],
  ['widget-offered', 'Offered widgets'],
  ['widget-companions', 'Propagated values'],
  ['widget-states', 'Widget states'],
  ['structure', 'Structural parts'],
  ['boundary', 'Subgraph boundaries'],
  ['boundary-names', 'Subgraph names'],
  ['badges', 'Badges and toolbar'],
  ['previews', 'Previews'],
  ['zoom', 'Controls zoom'],
  ['zoom-content', 'Content zoom'],
  ['zoom-overview', 'Overview zoom'],
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
  companions: CompanionMap
  rowMarks: RowMarkMap
  labels: readonly { text: string; x: number; y: number }[]
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
    companions: {},
    rowMarks: {},
    labels: [],
  }
  const labels: { text: string; x: number; y: number }[] = []
  const add = (
    id: string,
    definition = sample,
    values: Record<string, Json> = {},
    index = fixture.scene.nodes.length,
    driven = false,
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
      definition.items.flatMap((item) =>
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
                definition.items.flatMap((item, i) =>
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
                size: { width: id === 'Narrow' ? 112 : 280, height: 0 },
                ...(id === 'Minimized' || id === 'Long minimized'
                  ? { collapsed: true }
                  : {}),
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
    fixture.scene.nodes.push(...scene.nodes)
    fixture.scene.links.push(...scene.links)
    labels.push({ text: id, x, y: y - 24 })
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
                kind: 'input',
                id: `${item.id}_family`,
                type: item.type,
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  naming: { kind: 'prefix', prefix: item.id, min: 0, max: 8 },
                  template: [item],
                },
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
    if (page === 'boundary-names') {
      labels.push({ text: 'Inside the subgraph', x: 24, y: 40 })
      labels.push({ text: 'Collapsed occurrence', x: 360, y: 340 })
    }
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
      map[id] = [
        SUBGRAPH_BADGE,
        {
          ...DEPRECATED_BADGE,
          glyph: 'Deprecated',
          placement: 'above',
          icon: 'clock',
          variant: 'label',
        },
      ]
      const state = states[id as keyof typeof states]
      if (state) {
        fixture.states[id] = { state }
        map[id]!.push({
          id: `gallery.run.${state}`,
          glyph: id,
          variant: 'label',
          placement: 'below',
          icon:
            state === 'running'
              ? 'play'
              : state === 'done'
                ? 'check'
                : state === 'error'
                  ? 'triangle-alert'
                  : state === 'cached'
                    ? 'database'
                    : 'clock',
          color: tokens.stateColors[state],
        })
      }
    }
    map['Document error']!.push(PROBLEM_ERROR_BADGE)
    map['Blocking warning']!.push(PROBLEM_BLOCKING_WARNING_BADGE)
    map.Muted!.push({ ...MUTED_BADGE, placement: 'above', icon: 'volume-x' })
    map.Bypassed!.push({ ...BYPASSED_BADGE, placement: 'above', icon: 'ban' })
    const crowded = Array.from(
      { length: 9 },
      (_, index): NodeBadge => ({
        id: `gallery.detail.${index}`,
        glyph: `Detail ${index + 1}`,
        variant: 'label',
        placement: 'below',
        icon: 'info',
        color: tokens.colors.nodeHeader,
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
    fixture.rowMarks = { 'Invalid value': new Set(['steps']) }
    fixture.scene.nodes = fixture.scene.nodes.map((node) => ({
      ...node,
      ...(node.id === 'Colored' ? { color: tokens.stateColors.running } : {}),
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
      PROBLEM_BLOCKING_WARNING_BADGE,
      PROBLEM_WARNING_BADGE,
      {
        id: 'core.media.alpha_dropped.image.IMAGE',
        glyph: 'Alpha dropped: IMAGE',
        variant: 'label',
        placement: 'below',
        interactive: false,
        color: PROBLEM_WARNING_BADGE.color,
      },
      {
        id: 'core.media.mask_polarity.mask.mask',
        glyph: 'Mask polarity: mask',
        variant: 'label',
        placement: 'below',
        interactive: false,
        color: PROBLEM_WARNING_BADGE.color,
      },
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
                kind: 'input',
                id: 'values',
                type: value.type,
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  naming: { kind: 'prefix', prefix: 'value', min: 0, max: 8 },
                  template: [value],
                },
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
            },
            { ...widget('amount', 'FLOAT', 0.75), section: 'advanced' },
            {
              kind: 'input',
              id: 'mask',
              type: concrete('MASK'),
              optional: true,
              section: 'advanced',
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
  fixture.labels = labels.map((label) => {
    const node = fixture.scene.nodes.find((node) => node.id === label.text)
    return node ? { ...label, x: node.x, y: node.y - 24 } : label
  })
  return fixture
}

/** The node the row-editing page opens fields on: a number, a slider, a seed and a single-line text. */
export const rowEditingSchema: NodeSchema = schema('Sample image', [
  { kind: 'input', id: 'model', type: concrete('MODEL'), optional: false },
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
  {
    ...widget('seed', 'INT', 123456789, { min: 0, max: 4294967295 }),
    tooltip: 'Starting point of the noise.',
    widget: {
      widgetType: 'INT',
      options: { min: 0, max: 4294967295 },
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

/** One node of the row-editing page, laid out by the production scene builder. */
export function createRowEditingScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  values: Record<string, Json> = {},
): Scene {
  const id = 'Sample image'
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
            type: rowEditingSchema.type,
            values: {
              ...defaultValuesOf(rowEditingSchema),
              seed: 123456789,
              denoise: 0.65,
              ...values,
            },
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
            [id]: { position, size: { width: 280, height: 0 } },
          },
        },
      },
    },
  })
  if (!loaded.document)
    throw new Error(`Invalid row editing document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) =>
      type === rowEditingSchema.type ? rowEditingSchema : undefined,
    tokens,
    measure,
    widgetMeasure,
    seedControllerEnabled: true,
  })
}
