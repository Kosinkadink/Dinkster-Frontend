import {
  defaultValuesOf,
  loadDocument,
  type Diagnostic,
  type InputSpec,
  type Json,
  type NodeProgress,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '@dinkster/core'
import {
  buildScene,
  canvasPaintTokens,
  executionErrorBadge,
  LAST_RUN_BADGE,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  problemBadge,
  UNAVAILABLE_BADGE,
  type BadgeMap,
  type DesignTokens,
  type NodeBadge,
  type RowMarkMap,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

/** One line of an open box, worded as the editor words it. */
export interface ProblemBoxGalleryLine {
  readonly key: string
  readonly kind: 'error' | 'warning'
  readonly row?: string
  readonly rowName?: string
  readonly message: string
  /** Action labels, each a button under the message. */
  readonly actions: readonly string[]
}

export interface ProblemBoxGalleryBox {
  readonly nodeId: string
  readonly nodeTitle: string
  readonly lines: readonly ProblemBoxGalleryLine[]
  /** The line drawn highlighted, as if the pointer were on it. */
  readonly highlighted?: string
}

/** One card of the problem box page: a scene with its tabs, row outlines and open boxes. */
export interface ProblemBoxGalleryCard {
  readonly id: string
  readonly caption: string
  readonly scene: Scene
  readonly badges: BadgeMap
  readonly rowMarks: RowMarkMap
  /** Run states, for a node that failed in the run. */
  readonly states?: Readonly<Record<string, NodeProgress>>
  readonly boxes: readonly ProblemBoxGalleryBox[]
  /** Real solver problems, shown in both the panel and the node's box. */
  readonly diagnostics?: readonly Diagnostic[]
  /** The row drawn highlighted with its line. */
  readonly highlight?: { readonly nodeId: string; readonly row: string }
  readonly width: number
  /** Zoom the card is drawn at; 1 when absent. */
  readonly scale?: number
}

const NODE_WIDTH = 260
const NARROW = 200
const WIDE = 420
/** The widest an open box gets, so the long-line card leaves room for the narrow node's box. */
const BOX_MAX = canvasPaintTokens.badge.tab.problemBox.maxWidth
const LONG_MISSING = 'sdxl_base.safetensors is not in any model folder on this machine, and no download source is declared for it in the workflow or in its node pack.'
const GAP = 72
const TOP = 16
const LEFT = 16

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
const pin = (id: string, type: string, displayName: string, optional = false): InputSpec => ({
  kind: 'input',
  id,
  displayName,
  type: concrete(type),
  optional,
})
const out = (id: string, type: string, displayName: string): OutputSpec => ({
  kind: 'output',
  id,
  displayName,
  type: concrete(type),
})
const schema = (type: string, displayName: string, body: NodeSchema['body']): NodeSchema => ({
  type,
  displayName,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body,
})

/** Generate image: width and height with no lower limit, steps with an upper limit of 10000. */
const generateImage = schema('GalleryGenerateImage', 'Generate image', [
  out('image', 'IMAGE', 'image'),
  field('width', 'width', 'INT', 1024),
  field('height', 'height', 'INT', 1024),
  field('steps', 'steps', 'INT', 20, { min: 1, max: 10000 }),
])
// Image inputs are optional here so an unwired one adds no problem of its own.
const resizeImage = schema('GalleryResizeImage', 'Resize image', [
  pin('image', 'IMAGE', 'image', true),
  out('image_out', 'IMAGE', 'IMAGE'),
  field('width', 'width', 'INT', 1024),
  field('height', 'height', 'INT', 768),
  field('method', 'method', 'COMBO', 'lanczos', { options: ['lanczos', 'bilinear', 'nearest'] }),
])
const loadModel = schema('GalleryLoadModel', 'Load model', [
  out('model', 'MODEL', 'MODEL'),
  field('model', 'model', 'COMBO', 'sdxl_base.safetensors', { options: ['sdxl_base.safetensors'] }),
])
const loadImage = schema('GalleryLoadImage', 'Load image', [
  out('image', 'IMAGE', 'IMAGE'),
  field('file', 'file', 'COMBO', 'portrait.png', { options: ['portrait.png'] }),
])
const blurImage = schema('GalleryBlurImage', 'Blur image', [
  pin('image', 'IMAGE', 'image'),
  out('image_out', 'IMAGE', 'IMAGE'),
  field('radius', 'radius', 'INT', 4),
])
const saveImage = schema('GallerySaveImage', 'Save image', [
  pin('image', 'IMAGE', 'image'),
  field('prefix', 'prefix', 'STRING', 'blurred'),
])
const captionImage = schema('GalleryCaptionImage', 'Caption image', [
  out('text', 'STRING', 'TEXT'),
  pin('image', 'IMAGE', 'image'),
  pin('mask', 'MASK', 'mask', true),
  field('style', 'style', 'COMBO', 'short', { options: ['short', 'long'] }),
])
const upscaleImage: NodeSchema = {
  ...schema('GalleryUpscaleImage', 'Upscale image', [
    pin('image', 'IMAGE', 'image', true),
    out('image_out', 'IMAGE', 'IMAGE'),
    field('scale', 'scale', 'FLOAT', 2, { min: 1, max: 8, step: 0.5 }),
  ]),
  unavailableReason: 'This node needs a graphics card, and this machine has none.',
}

interface Placed {
  readonly id: string
  readonly schema: NodeSchema
  readonly x: number
  readonly values?: Record<string, Json>
  readonly dynamic?: Readonly<Record<string, { readonly selected?: string; readonly members?: readonly string[] }>>
  readonly minimized?: true
  /** Node width; NODE_WIDTH when absent. */
  readonly width?: number
  readonly mode?: 'muted'
}

/** A wire from one node's output to another node's input. */
type Wire = readonly [from: readonly [node: string, port: string], to: readonly [node: string, port: string]]

function sceneOf(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  nodes: readonly Placed[],
  wires: readonly Wire[] = [],
): Scene {
  const schemas = new Map(nodes.map((node) => [node.schema.type, node.schema]))
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery-problem-box',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery',
        name: 'Gallery',
        nextOrdinal: 100,
        nodes: Object.fromEntries(nodes.map((node) => [node.id, {
          id: node.id,
          type: node.schema.type,
          values: { ...defaultValuesOf(node.schema), ...node.values },
          ...(node.dynamic ? { dynamic: node.dynamic } : {}),
          ...(node.mode ? { mode: node.mode } : {}),
        }])),
        links: Object.fromEntries(wires.map(([from, to], index) => [`w${index}`, {
          id: `w${index}`, from: { node: from[0], port: from[1] }, to: { node: to[0], port: to[1] },
        }])),
        nets: {},
        reroutes: {},
      },
    },
    view: { graphs: { gallery: { nodes: Object.fromEntries(nodes.map((node) => [node.id, {
      position: { x: node.x, y: TOP },
      size: { width: node.width ?? NODE_WIDTH, height: 0 },
      ...(node.minimized ? { collapsed: true } : {}),
    }])) } } },
  })
  if (!loaded.document) throw new Error(`Invalid problem box gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) => schemas.get(type),
    tokens,
    measure,
    widgetMeasure,
  })
}

const column = (index: number): number => LEFT + index * (NODE_WIDTH + GAP)
const widthOf = (columns: number): number => LEFT * 2 + columns * NODE_WIDTH + (columns - 1) * GAP
/** A one-node card with an open box: room for the box at its widest. */
const BOXED = LEFT * 2 + BOX_MAX

const errors = (count: number): NodeBadge => problemBadge(PROBLEM_ERROR_BADGE, count)
const warnings = (count: number): NodeBadge => problemBadge(PROBLEM_WARNING_BADGE, count)

const line = (
  kind: 'error' | 'warning',
  row: string | undefined,
  message: string,
  actions: readonly string[] = [],
): ProblemBoxGalleryLine => ({
  key: `${row ?? ''}:${message}`,
  kind,
  ...(row === undefined ? {} : { row, rowName: row }),
  message,
  actions,
})

const EDIT = 'Edit field'
const BROKEN = { width: 0, height: 0, steps: 12000 }
const brokenLines = [
  line('error', 'width', 'Width must be positive.', [EDIT]),
  line('error', 'height', 'Height must be positive.', [EDIT]),
  line('warning', 'steps', 'Steps exceeds 10000.', [EDIT]),
]
const brokenMarks = { width: 'error', height: 'error', steps: 'warning' } as const

/** The cards of the problem box page, in page order. */
export function problemBoxGallery(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): readonly ProblemBoxGalleryCard[] {
  const scene = (nodes: readonly Placed[], wires: readonly Wire[] = []) => sceneOf(tokens, measure, widgetMeasure, nodes, wires)
  const solverCard = (id: string, caption: string, nodes: readonly Placed[], wires: readonly Wire[]): ProblemBoxGalleryCard => {
    const drawn = scene(nodes, wires)
    const scale = nodes.length > 2 ? 0.65 : 1
    return {
      id, caption, scene: drawn, diagnostics: drawn.diagnostics.filter((diagnostic) => diagnostic.code.startsWith('solve.')),
      badges: {}, rowMarks: {}, boxes: [], scale, width: column(nodes.length - 1) * scale + BOX_MAX + LEFT,
    }
  }
  const latentSink = schema('GalleryDecode', 'Decode', [pin('samples', 'LATENT', 'samples')])
  const matched = { kind: 'variable', templateId: 'T' } as const
  const matchNode = schema('GalleryMatch', 'Switch', [
    { ...pin('image', 'IMAGE', 'image'), type: matched },
    { ...out('out', 'IMAGE', 'image'), type: matched },
  ])
  const groupType: TypeExpr = { kind: 'tuple', elements: [concrete('IMAGE'), concrete('MASK')] }
  const groupSource = schema('GalleryGroupSource', 'Make group', [{ ...out('values', 'IMAGE', 'values'), type: groupType }])
  const switchNode: NodeSchema = {
    ...schema('GalleryPickSwitch', 'Switch', [
      field('pick', 'pick', 'INT', 1),
      { kind: 'group', id: 'branch', value: { ...pin('branch', 'IMAGE', 'branch'), type: matched }, keys: { kind: 'numbered', prefix: 'branch', start: 0, pad: 0 }, grows: 'link', minMembers: 1, maxMembers: 8 },
      { ...out('image', 'IMAGE', 'image'), type: matched },
    ]),
    selector: { input: 'pick', group: 'branch' },
  }
  const switchInputs: readonly Placed[] = [
    { id: 'load', schema: loadImage, x: column(0) },
    { id: 'latent', schema: schema('GalleryLoadLatent', 'Load latent', [out('samples', 'LATENT', 'samples')]), x: column(1) },
  ]
  const switchWires: readonly Wire[] = [[['load', 'image'], ['switch', 'branch.branch0']], [['latent', 'samples'], ['switch', 'branch.branch1']]]
  return [
    solverCard('type-warning', 'An image sent to samples that needs latent data. The same warning names the node in Problems and the row once in its own box. The wire and its handle are warning yellow.', [
      { id: 'load', schema: loadImage, x: column(0) },
      { id: 'decode', schema: latentSink, x: column(1) },
    ], [[['load', 'image'], ['decode', 'samples']]]),
    solverCard('type-matched', 'The matched type on Switch cannot satisfy both Load image and Decode. Both contributing wires warn; the problem belongs to Switch, with no type-variable name in its sentence.', [
      { id: 'load', schema: loadImage, x: column(0) },
      { id: 'switch', schema: matchNode, x: column(1) },
      { id: 'decode', schema: latentSink, x: column(2) },
    ], [[['load', 'image'], ['switch', 'image']], [['switch', 'out'], ['decode', 'samples']]]),
    solverCard('type-list-error', 'A list sent to an input that needs one image stops the run. Its wire and handle, the receiving row and its Error tab use error red; the sentence is the same problem in both surfaces.', [
      { id: 'load', schema: schema('GalleryLoadImages', 'Load images', [{ ...out('images', 'IMAGE', 'images'), type: { kind: 'list', element: concrete('IMAGE') } }]), x: column(0) },
      { id: 'blur', schema: blurImage, x: column(1) },
    ], [[['load', 'images'], ['blur', 'image']]]),
    solverCard('type-list-needed', 'One image cannot fill an input that needs a list. The receiving row, wire and midpoint handle use error red.', [
      { id: 'load', schema: loadImage, x: column(0) },
      { id: 'combine', schema: schema('GalleryCombineImages', 'Combine images', [{ ...pin('images', 'IMAGE', 'images'), type: { kind: 'list', element: concrete('IMAGE') } }]), x: column(1) },
    ], [[['load', 'image'], ['combine', 'images']]]),
    solverCard('type-missing-row', 'A saved wire still points at an input that no longer exists. The sentence describes the missing input without exposing its stored id.', [
      { id: 'load', schema: loadImage, x: column(0) },
      { id: 'resize', schema: schema('GalleryChangedResize', 'Resize image', [field('scale', 'scale', 'FLOAT', 2)]), x: column(1) },
    ], [[['load', 'image'], ['resize', 'old_image']]]),
    solverCard('type-group-warning', 'Different group lengths warn without blocking the run. The message names both lengths, without tuple syntax.', [
      { id: 'group', schema: groupSource, x: column(0) },
      { id: 'combine', schema: schema('GalleryCombine', 'Combine values', [{ ...pin('values', 'IMAGE', 'values'), type: { kind: 'tuple', elements: [concrete('IMAGE'), concrete('MASK'), concrete('INT')] } }]), x: column(1) },
    ], [[['group', 'values'], ['combine', 'values']]]),
    solverCard('type-selected', 'The stored image choice no longer agrees with Load latent. The shown source row and selected type appear in both surfaces, not the stored variant key.', [
      { id: 'latent', schema: schema('GallerySelectedLatent', 'Load latent', [out('samples', 'LATENT', 'samples')]), x: column(0) },
      { id: 'choose', schema: schema('GalleryChooseModel', 'Choose model', [{ kind: 'typeChoice', id: 'source', displayName: 'source', required: true, rows: [], variants: [{ key: 'image', type: concrete('IMAGE'), rows: [] }] }]), dynamic: { source: { selected: 'image' } }, x: column(1) },
    ], [[['latent', 'samples'], ['choose', 'source']]]),
    solverCard('type-group-position', 'A position beyond the group stops the run on the shown value output. The message explains the chosen position and actual group length.', [
      { id: 'group', schema: groupSource, x: column(0) },
      { id: 'pick', schema: schema('GalleryPickValue', 'Pick value', [
        { ...pin('tuple', 'IMAGE', 'group'), type: { kind: 'variable', templateId: 'Tuple' } },
        field('index', 'position', 'INT', 3),
        { ...out('item', 'IMAGE', 'value'), type: { kind: 'tuple_element', input: 'tuple', index: 'index' } },
      ]), x: column(1) },
    ], [[['group', 'values'], ['pick', 'tuple']]]),
    solverCard('type-optional', 'Find face may send nothing to a required input. The node warns while its optional output keeps the existing type-coloured dashed wire.', [
      { id: 'find', schema: schema('GalleryFindFace', 'Find face', [{ ...out('image', 'IMAGE', 'image'), optional: true }]), x: column(0) },
      { id: 'blur', schema: schema('GalleryRequiredBlur', 'Blur image', [{ ...pin('image', 'IMAGE', 'image'), onAbsent: 'fail' }]), x: column(1) },
    ], [[['find', 'image'], ['blur', 'image']]]),
    solverCard('type-switch-stored', 'The stored Switch pick chooses one branch. Different branch types warn rather than stop the run; both rows are named in plain words.', [
      ...switchInputs,
      { id: 'switch', schema: switchNode, dynamic: { branch: { members: ['branch0', 'branch1'] } }, x: column(2) },
    ], switchWires),
    solverCard('type-switch-runtime', 'A run-time Switch pick can choose either branch, so different branch types stop the run. The same sentence now has error paint.', [
      ...switchInputs.map((node) => node.id === 'latent' ? { ...node, schema: { ...node.schema, body: [...node.schema.body, out('pick', 'INT', 'position')] } } : node),
      { id: 'switch', schema: switchNode, dynamic: { branch: { members: ['branch0', 'branch1'] } }, x: column(2) },
    ], [...switchWires, [['latent', 'pick'], ['switch', 'pick']]]),
    {
      id: 'at-rest',
      caption: 'At rest. Width and height are 0 and steps is 12000: two rows are outlined red and steps yellow, and nothing is drawn at the node\'s edge. The tabs read Error 2 and Warning. Selecting the node or pointing at it opens nothing. This part offers only actions that change no stored value, such as Edit field; fix buttons such as "Use 10000" on the steps line come with the later part that adds fixes.',
      scene: scene([{ id: 'gen', schema: generateImage, x: column(0), values: BROKEN }]),
      badges: { gen: [errors(2), warnings(1)] },
      rowMarks: { gen: brokenMarks },
      boxes: [],
      width: widthOf(1),
    },
    {
      id: 'open',
      caption: 'Error 2 clicked: the box hangs below the node and its tabs, one line per problem, each starting with its row\'s name, rows top to bottom. The pointer is on the height line, so the height row is drawn stronger; while the box is open, pointing at a row lights its line the same way.',
      scene: scene([{ id: 'gen', schema: generateImage, x: column(0), values: BROKEN }]),
      badges: { gen: [errors(2), warnings(1)] },
      rowMarks: { gen: brokenMarks },
      boxes: [{ nodeId: 'gen', nodeTitle: 'Generate image', lines: brokenLines, highlighted: brokenLines[1]!.key }],
      highlight: { nodeId: 'gen', row: 'height' },
      width: BOXED,
    },
    {
      id: 'two-causes',
      caption: 'Two causes on one row: each has its own line and the tab counts both. The strongest comes first on a row.',
      scene: scene([{ id: 'resize', schema: resizeImage, x: column(0), values: { width: 0 } }]),
      badges: { resize: [errors(2)] },
      rowMarks: { resize: { width: 'error' } },
      boxes: [{ nodeId: 'resize', nodeTitle: 'Resize image', lines: [
        line('error', 'width', 'Width is required.', [EDIT]),
        line('error', 'width', 'Width could not be inferred from the image.', [EDIT]),
      ] }],
      width: BOXED,
    },
    {
      id: 'whole-node',
      caption: 'A rule about the node as a whole reads two fields, so its line has no row name, comes first, and lights no row. A rule that reads one field is that field\'s problem.',
      scene: scene([{ id: 'gen', schema: generateImage, x: column(0), values: { width: 32, height: 32, steps: 12000 } }]),
      badges: { gen: [errors(1), warnings(1)] },
      rowMarks: { gen: { steps: 'warning' } },
      boxes: [{ nodeId: 'gen', nodeTitle: 'Generate image', lines: [
        line('error', undefined, 'Width times height must be at least 4096 pixels.'),
        line('warning', 'steps', 'Steps exceeds 10000.', [EDIT]),
      ] }],
      width: BOXED,
    },
    {
      id: 'minimized',
      caption: 'A minimized node keeps its tabs and its red outline. A tab click opens the same box; pointing at a line lights nothing, and Edit field opens the node and shows the row.',
      scene: scene([{ id: 'gen', schema: generateImage, x: column(0), values: BROKEN, minimized: true }]),
      badges: { gen: [errors(2), warnings(1)] },
      rowMarks: { gen: brokenMarks },
      boxes: [{ nodeId: 'gen', nodeTitle: 'Generate image', lines: brokenLines }],
      width: BOXED,
    },
    {
      id: 'outline',
      caption: 'A node with an Error keeps a solid red outline, the one sign that reads zoomed out or on a minimized node. A node with only Warnings has a plain outline.',
      scene: scene([
        { id: 'error', schema: generateImage, x: column(0), values: { width: 0 } },
        { id: 'warning', schema: generateImage, x: column(1), values: { steps: 12000 } },
      ]),
      badges: { error: [errors(1)], warning: [warnings(1)] },
      rowMarks: { error: { width: 'error' }, warning: { steps: 'warning' } },
      boxes: [],
      width: widthOf(2),
    },
    {
      id: 'stops-a-run',
      caption: 'What stops a run. A missing model offers Download models and Locate or replace. Download models opens the review without a run. A required input never connected reads "Image is required."; mask is optional with nothing plugged in, so it has no outline and no line. A value failing a check with no fix offers Edit field.',
      scene: scene([
        { id: 'load', schema: loadModel, x: column(0) },
        { id: 'caption', schema: captionImage, x: column(1) },
        { id: 'resize', schema: resizeImage, x: column(2), values: { width: 0 } },
      ]),
      badges: { load: [errors(1)], caption: [errors(1)], resize: [errors(1)] },
      rowMarks: { load: { model: 'error' }, caption: { image: 'error' }, resize: { width: 'error' } },
      boxes: [
        { nodeId: 'load', nodeTitle: 'Load model', lines: [line('error', 'model', 'Model file is missing.', ['Download models', 'Locate or replace'])] },
        { nodeId: 'caption', nodeTitle: 'Caption image', lines: [line('error', 'image', 'Image is required.')] },
        { nodeId: 'resize', nodeTitle: 'Resize image', lines: [line('error', 'width', 'Width must be positive.', [EDIT])] },
      ],
      width: widthOf(3),
    },
    {
      id: 'skipped',
      caption: 'A node the run will skip. Load image is muted, so its output gives nothing; Blur image needs it, so Blur image is skipped and reads Warning, its line saying why in the reason\'s words. Save image, which needs what Blur image would have made, is skipped too but carries no warning: only the first affected node warns. A warning does not stop the run: the rest of the workflow runs. When every output a run asks for would be skipped, the run is not queued, and the notice says nothing would run.',
      scene: scene([
        { id: 'load', schema: loadImage, x: column(0), mode: 'muted' },
        { id: 'blur', schema: blurImage, x: column(1) },
        { id: 'save', schema: saveImage, x: column(2) },
      ], [[['load', 'image'], ['blur', 'image']], [['blur', 'image_out'], ['save', 'image']]]),
      badges: { blur: [warnings(1)] },
      rowMarks: { blur: { image: 'warning' } },
      boxes: [{ nodeId: 'blur', nodeTitle: 'Blur image', lines: [line('warning', 'image', "Receives nothing because 'Load image' is muted, so this node is skipped in the run.")] }],
      width: widthOf(3),
    },
    {
      id: 'last-run',
      caption: 'A run failed on method. Left, as run: the node keeps its run outline, the method row is outlined red and the tab reads Error. Right, method changed to bilinear since that run: the outline is ordinary, the row has no outline, and the tab reads Last run without color. Clicking it opens the run\'s details under the line "From the last run. Changed since." A seed the next queue draws anew is not a change, and undo back to the document that ran brings the color back.',
      scene: scene([
        { id: 'ran', schema: resizeImage, x: column(0) },
        { id: 'changed', schema: resizeImage, x: column(1), values: { method: 'bilinear' } },
      ]),
      states: { ran: { state: 'error' } },
      badges: { ran: [executionErrorBadge(1)], changed: [LAST_RUN_BADGE] },
      rowMarks: { ran: { method: 'error' } },
      boxes: [],
      width: widthOf(2),
    },
    {
      id: 'unavailable',
      caption: 'A node that cannot run here reads Unavailable with no count. Its box gives the reason first with no row name, then any other problems.',
      scene: scene([{ id: 'upscale', schema: upscaleImage, x: column(0), values: { scale: 12 } }]),
      badges: { upscale: [UNAVAILABLE_BADGE, warnings(1)] },
      rowMarks: { upscale: { scale: 'warning' } },
      boxes: [{ nodeId: 'upscale', nodeTitle: 'Upscale image', lines: [
        line('error', undefined, 'This node needs a graphics card, and this machine has none.'),
        line('warning', 'scale', 'Scale exceeds 8.', [EDIT]),
      ] }],
      width: BOXED,
    },
    {
      id: 'widths',
      caption: 'A long line: the box takes the most it may, 400 px on screen, and the line wraps there, so the box is the same under a narrow node and a wide one; under the narrow node it reaches past the node\'s right edge. Its left edge stays under the node\'s. The box grows downward; nothing is cut. Its text stays one screen size whatever the zoom, and the limit does not depend on the node or the zoom.',
      scene: scene([
        { id: 'narrow', schema: loadModel, x: LEFT, width: NARROW },
        { id: 'wide', schema: loadModel, x: LEFT + BOX_MAX + GAP, width: WIDE },
      ]),
      badges: { narrow: [errors(1)], wide: [errors(1)] },
      rowMarks: { narrow: { model: 'error' }, wide: { model: 'error' } },
      boxes: [
        { nodeId: 'narrow', nodeTitle: 'Load model', lines: [line('error', 'model', LONG_MISSING, ['Locate or replace'])] },
        { nodeId: 'wide', nodeTitle: 'Load model', lines: [line('error', 'model', LONG_MISSING, ['Locate or replace'])] },
      ],
      width: LEFT * 2 + BOX_MAX + GAP + WIDE,
    },
    ...[
      {
        id: 'model-missing-review',
        caption: 'A missing model with a download source to review. Download models opens the review for this model only; it does not queue the workflow. Locate or replace opens the field.',
        message: 'sdxl_base.safetensors is not in a model folder this project uses on Local engine.',
        actions: ['Download models', 'Locate or replace'],
      },
      {
        id: 'model-missing-no-source',
        caption: 'A missing model with no download source. Download models opens the review to choose a source. Locate or replace opens the field.',
        message: 'sdxl_base.safetensors is not in a model folder this project uses on Local engine.',
        actions: ['Download models', 'Locate or replace'],
      },
      {
        id: 'model-hidden',
        caption: 'A model hidden in this project. Open model management goes to the hidden models section; it does not unhide the model.',
        message: 'sdxl_base.safetensors is hidden in this project.',
        actions: ['Open model management', 'Locate or replace'],
      },
      {
        id: 'model-folder-disabled',
        caption: 'A model in folders this project does not use. The line names the first Storage folder and counts the others. Open Storage navigates without enabling a folder.',
        message: 'sdxl_base.safetensors is in a folder this project does not use: Archive and 1 more.',
        actions: ['Open Storage', 'Locate or replace'],
      },
      {
        id: 'model-duplicate',
        caption: 'Two model files have the same name in this project. The row is an error and offers Locate or replace, not a download.',
        message: 'Two files named sdxl_base.safetensors are in this project\'s model folders.',
        actions: ['Locate or replace'],
      },
      {
        id: 'model-invalid',
        caption: 'A model name that cannot be looked up. Locate or replace opens the field; no download is offered.',
        message: '../sdxl_base.safetensors is not a plain file name, so the model cannot be looked up.',
        actions: ['Locate or replace'],
      },
    ].map(({ id, caption, message, actions }): ProblemBoxGalleryCard => ({
      id,
      caption,
      scene: scene([{ id: 'load', schema: loadModel, x: LEFT }]),
      badges: { load: [errors(1)] },
      rowMarks: { load: { model: 'error' } },
      boxes: [{ nodeId: 'load', nodeTitle: 'Load model', lines: [line('error', 'model', message, actions)] }],
      width: BOXED,
    })),
    {
      id: 'short-line',
      caption: 'A short line: the box is only as wide as its longest line needs, so under a wide node it is narrower than the node. Its left edge stays under the node\'s, it is never narrower than the node\'s row of tabs, and each line\'s action sits at the box\'s right end. When the canvas is narrow, the most the box takes is the canvas width less 16 px at each side.',
      scene: scene([{ id: 'wide', schema: resizeImage, x: LEFT, width: WIDE, values: { width: 0 } }]),
      badges: { wide: [errors(1)] },
      rowMarks: { wide: { width: 'error' } },
      boxes: [{ nodeId: 'wide', nodeTitle: 'Resize image', lines: [line('error', 'width', 'Width must be positive.', [EDIT])] }],
      width: LEFT * 2 + WIDE,
    },
    {
      id: 'zoomed-out',
      caption: 'Zoomed out to 55%, the node is 143 px wide on screen and its box keeps its own width, as wide as its line needs, so it reaches past the node; its text stays one screen size. Below 50%, where tabs are no longer drawn, an open box is not drawn either, and it returns with the tabs.',
      scene: scene([{ id: 'load', schema: loadModel, x: LEFT }]),
      badges: { load: [errors(1)] },
      rowMarks: { load: { model: 'error' } },
      boxes: [{ nodeId: 'load', nodeTitle: 'Load model', lines: [line('error', 'model', 'Model file is missing.', ['Locate or replace'])] }],
      scale: 0.55,
      width: BOXED,
    },
  ]
}
