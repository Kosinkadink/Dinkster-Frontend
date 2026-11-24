import {
  defaultValuesOf,
  loadDocument,
  type InputSpec,
  type Json,
  type NodeSchema,
  type OutputSpec,
  type TypeExpr,
} from '@dinkster/core'
import {
  buildScene,
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
  readonly boxes: readonly ProblemBoxGalleryBox[]
  /** The row drawn highlighted with its line. */
  readonly highlight?: { readonly nodeId: string; readonly row: string }
  /** Canvas height below the nodes left for the open boxes, in px. */
  readonly room: number
  readonly width: number
}

const NODE_WIDTH = 260
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
  readonly minimized?: true
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
      size: { width: NODE_WIDTH, height: 0 },
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
  return [
    {
      id: 'at-rest',
      caption: 'At rest. Width and height are 0 and steps is 12000: two rows are outlined red and steps yellow, and nothing is drawn at the node\'s edge. The tabs read Error 2 and Warning. Selecting the node or pointing at it opens nothing. This part offers only actions that change no stored value, such as Edit field; fix buttons such as "Use 10000" on the steps line come with the later part that adds fixes.',
      scene: scene([{ id: 'gen', schema: generateImage, x: column(0), values: BROKEN }]),
      badges: { gen: [errors(2), warnings(1)] },
      rowMarks: { gen: brokenMarks },
      boxes: [],
      room: 24,
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
      room: 126,
      width: widthOf(1) + 160,
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
      room: 96,
      width: widthOf(1) + 160,
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
      room: 96,
      width: widthOf(1) + 160,
    },
    {
      id: 'minimized',
      caption: 'A minimized node keeps its tabs and its red outline. A tab click opens the same box; pointing at a line lights nothing, and Edit field opens the node and shows the row.',
      scene: scene([{ id: 'gen', schema: generateImage, x: column(0), values: BROKEN, minimized: true }]),
      badges: { gen: [errors(2), warnings(1)] },
      rowMarks: { gen: brokenMarks },
      boxes: [{ nodeId: 'gen', nodeTitle: 'Generate image', lines: brokenLines }],
      room: 126,
      width: widthOf(1) + 160,
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
      room: 24,
      width: widthOf(2),
    },
    {
      id: 'stops-a-run',
      caption: 'What stops a run. A missing model offers Locate or replace; Review download replaces it when the download review can open without a run. A required input never connected reads "Image is required."; mask is optional with nothing plugged in, so it has no outline and no line. A value failing a check with no fix offers Edit field.',
      scene: scene([
        { id: 'load', schema: loadModel, x: column(0) },
        { id: 'caption', schema: captionImage, x: column(1) },
        { id: 'resize', schema: resizeImage, x: column(2), values: { width: 0 } },
      ]),
      badges: { load: [errors(1)], caption: [errors(1)], resize: [errors(1)] },
      rowMarks: { load: { model: 'error' }, caption: { image: 'error' }, resize: { width: 'error' } },
      boxes: [
        { nodeId: 'load', nodeTitle: 'Load model', lines: [line('error', 'model', 'Model file is missing.', ['Locate or replace'])] },
        { nodeId: 'caption', nodeTitle: 'Caption image', lines: [line('error', 'image', 'Image is required.')] },
        { nodeId: 'resize', nodeTitle: 'Resize image', lines: [line('error', 'width', 'Width must be positive.', [EDIT])] },
      ],
      room: 76,
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
      room: 76,
      width: widthOf(3),
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
      room: 96,
      width: widthOf(1) + 160,
    },
    {
      id: 'widths',
      caption: 'The box is drawn at one screen size whatever the zoom. It is at least 240 px wide, as for a short message with its button, and at most 400 px, where a long message wraps.',
      scene: scene([
        { id: 'short', schema: resizeImage, x: column(0), values: { width: 0 } },
        { id: 'long', schema: loadModel, x: column(1) + 40 },
      ]),
      badges: { short: [errors(1)], long: [errors(1)] },
      rowMarks: { short: { width: 'error' }, long: { model: 'error' } },
      boxes: [
        { nodeId: 'short', nodeTitle: 'Resize image', lines: [line('error', 'width', 'Width must be positive.', [EDIT])] },
        { nodeId: 'long', nodeTitle: 'Load model', lines: [line('error', 'model', 'sdxl_base.safetensors is not in any model folder on this machine, and no download source is declared for it in the workflow or in its node pack.', ['Locate or replace'])] },
      ],
      room: 116,
      width: widthOf(2) + 200,
    },
  ]
}
