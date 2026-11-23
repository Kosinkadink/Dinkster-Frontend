import {
  defaultValuesOf,
  loadDocument,
  type InputSpec,
  type Json,
  type NodeProgress,
  type NodeSchema,
  type TypeExpr,
  type WidgetRepresentationsSpec,
} from '@dinkster/core'
import {
  buildScene,
  type DesignTokens,
  type OverlayState,
  type RowMarkMap,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'
import { structuralGalleryScene } from './structure.js'

/**
 * Fixed scenes for the page of row states the editor knows today: a node a
 * finished run skipped and the nothing it gives, a wire whose value is not
 * known yet, promoted fields, and the fields whose look can be switched.
 */

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
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
const schema = (type: string, items: NodeSchema['items']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items,
})

const measureNode = schema('Measure mask', [
  { kind: 'input', id: 'mask', type: concrete('MASK'), optional: false },
  { kind: 'output', id: 'radius', type: concrete('INT') },
  { kind: 'output', id: 'mask', type: concrete('MASK') },
])
const applyMask = schema('Apply mask', [
  { kind: 'input', id: 'image', type: concrete('IMAGE'), optional: false },
  { kind: 'input', id: 'mask', type: concrete('MASK'), optional: false },
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
  field('feather', 'INT', 4, { min: 0, max: 64 }),
])
const loadImage = schema('Load image', [
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
])
const soften = schema('Soften', [
  { kind: 'input', id: 'image', type: concrete('IMAGE'), optional: false },
  { kind: 'output', id: 'IMAGE', type: concrete('IMAGE') },
  field('radius', 'INT', 12, { min: 0, max: 64 }),
  field('mix', 'FLOAT', 0.65, { min: 0, max: 1, step: 0.01 }),
])

/** Look sets for the representation examples: locked, and a slider whose range is not known. */
const mixLooks = (userSwitchable: boolean, range: boolean, initial: 'number' | 'slider'): WidgetRepresentationsSpec => {
  const options = (display: string): Record<string, Json> => ({ ...(range ? { min: 0, max: 1 } : {}), step: 0.01, display })
  return {
    default: initial,
    userSwitchable,
    representations: [
      { id: 'number', displayName: 'Number', widget: { widgetType: 'FLOAT', options: options('number'), default: 0.65 } },
      { id: 'slider', displayName: 'Slider', widget: { widgetType: 'FLOAT', options: options('slider'), default: 0.65 } },
    ],
  }
}
const looked = (id: string, tooltip: string, looks: WidgetRepresentationsSpec): InputSpec => ({
  ...field(id, 'FLOAT', 0.65, looks.representations[0]!.widget.options as Record<string, Json>),
  displayName: 'mix',
  tooltip,
  widget: { ...looks.representations[0]!.widget, representations: looks },
})

/**
 * The node of the representation examples: `mix` switches between Number
 * and Slider, `caption` between Single line and Multiline; `locked` cannot
 * be switched; `pending` is a Slider whose range is not known yet.
 */
export const representationSchema = schema('Soften', [
  { ...field('mix', 'FLOAT', 0.65, { min: 0, max: 1, step: 0.01 }), tooltip: 'Amount of the result.' },
  { ...field('caption', 'STRING', 'soft edge'), tooltip: 'Text written under the image.' },
  looked('locked', 'Amount of the result.', mixLooks(false, true, 'number')),
  looked('pending', 'Range waits for width.', mixLooks(true, false, 'slider')),
])

interface NodePlace {
  readonly id: string
  readonly schema: NodeSchema
  readonly x: number
  readonly y: number
  readonly width?: number
  readonly values?: Record<string, Json>
  readonly views?: Record<string, string>
}

function sceneOf(
  nodes: readonly NodePlace[],
  links: readonly { readonly from: readonly [string, string]; readonly to: readonly [string, string] }[],
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): Scene {
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery-row-states',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery',
        name: 'Gallery',
        nextOrdinal: 2,
        nodes: Object.fromEntries(nodes.map((node) => [node.id, {
          id: node.id,
          type: node.schema.type,
          values: { ...defaultValuesOf(node.schema), ...node.values },
        }])),
        links: Object.fromEntries(links.map((link, index) => [`link-${index}`, {
          id: `link-${index}`,
          from: { node: link.from[0], port: link.from[1] },
          to: { node: link.to[0], port: link.to[1] },
        }])),
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: Object.fromEntries(nodes.map((node) => [node.id, {
            position: { x: node.x, y: node.y },
            size: { width: node.width ?? 240, height: 0 },
            ...(node.views === undefined ? {} : { views: node.views }),
          }])),
        },
      },
    },
  })
  if (!loaded.document) throw new Error(`Invalid row states document: ${JSON.stringify(loaded)}`)
  const schemas = new Map(nodes.map((node) => [node.schema.type, node.schema]))
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) => schemas.get(type),
    tokens,
    measure,
    widgetMeasure,
    seedControllerEnabled: true,
  })
}

/** One drawn example of the page: a scene with its run states, row marks and overlay. */
export interface RowStateExample {
  readonly id: string
  readonly caption: string
  readonly scene: Scene
  readonly states?: Readonly<Record<string, NodeProgress>>
  readonly rowMarks?: RowMarkMap
  readonly overlay?: OverlayState
}

/** The canvas examples of the page, by section, in the order it shows them. */
export function rowStateExamples(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): { readonly nothing: readonly RowStateExample[]; readonly promoted: readonly RowStateExample[] } {
  const feed = () => sceneOf(
    [
      { id: 'measure', schema: measureNode, x: 0, y: 0, width: 160 },
      { id: 'soften', schema: soften, x: 220, y: 0 },
    ],
    [{ from: ['measure', 'radius'], to: ['soften', 'radius'] }],
    tokens,
    measure,
    widgetMeasure,
  )
  const skipped = { measure: { state: 'skipped' } } as const
  const nothing: RowStateExample[] = [
    {
      id: 'retained-nothing',
      caption: 'Retained pin and wire give nothing. A finished run skipped Measure mask, so radius reads Nothing, quiet; both pins are hollow and the wire keeps its route and color with the skipped dots. The stored 12 is kept underneath. No red error.',
      scene: feed(),
      states: skipped,
    },
    {
      id: 'skipped-node',
      caption: 'A skipped node. Apply mask did not run because its mask gave nothing: quiet rows and the dotted outline, and Skipped stays a run-status tab under the node, not a title badge. Its output gives nothing in turn, so that pin is hollow; the image that did arrive keeps its ordinary wire.',
      scene: sceneOf(
        [
          { id: 'source', schema: measureNode, x: 0, y: 0, width: 160 },
          { id: 'load', schema: loadImage, x: 0, y: 110, width: 160 },
          { id: 'apply', schema: applyMask, x: 220, y: 0 },
        ],
        [
          { from: ['source', 'mask'], to: ['apply', 'mask'] },
          { from: ['load', 'IMAGE'], to: ['apply', 'image'] },
        ],
        tokens,
        measure,
        widgetMeasure,
      ),
      states: { source: { state: 'skipped' }, load: { state: 'done' }, apply: { state: 'skipped' } },
    },
    {
      id: 'skipped-selected',
      caption: 'A skipped node, selected. The usual selection outline stays over the dotted outline and the quiet rows.',
      scene: feed(),
      states: skipped,
      overlay: { selection: new Set(['measure']) },
    },
    {
      id: 'nothing-problem',
      caption: 'A row that gives nothing and has a problem. The problem outline keeps full contrast beside the absence. Absence alone never makes a problem.',
      scene: feed(),
      states: skipped,
      rowMarks: { soften: new Set(['radius']) },
    },
    {
      id: 'unknown',
      caption: 'Wired but value not yet known. radius reads Known after a run: never Nothing, and never the stored 12 as if it arrived.',
      scene: feed(),
    },
    {
      id: 'unknown-narrow',
      caption: 'The same on a narrow node. The words end in an ellipsis rather than growing the node; the readout on pointing gives them in full with the stored 12, used again when the wire is removed. The Link-driven widgets page showed the stored value struck through here before.',
      scene: sceneOf(
        [
          { id: 'measure', schema: measureNode, x: 0, y: 0, width: 120 },
          { id: 'soften', schema: soften, x: 170, y: 0, width: 130 },
        ],
        [{ from: ['measure', 'radius'], to: ['soften', 'radius'] }],
        tokens,
        measure,
        widgetMeasure,
      ),
    },
  ]
  const promoted: RowStateExample[] = [
    {
      id: 'promoted-inside',
      caption: 'Inside a subgraph. strength has no drawn wire: the cyan subgraph icon sits before its name and the value of the entered instance is quiet. radius has a drawn wire from the Inputs panel: the ordinary wired look, no icon. Two levels deep the same mark names only the boundary of the graph being looked at; there is no depth badge.',
      scene: structuralGalleryScene(tokens, measure, widgetMeasure, true),
    },
    {
      id: 'promoted-outside',
      caption: 'Outside, on the subgraph node. A subgraph is an ordinary node from outside: radius carries no promotion mark.',
      scene: (() => {
        const scene = sceneOf([{ id: 'soften-node', schema: soften, x: 0, y: 0 }], [], tokens, measure, widgetMeasure)
        return { ...scene, nodes: scene.nodes.map((node) => ({ ...node, isSubgraph: true })) }
      })(),
    },
  ]
  return { nothing, promoted }
}

/** A whole-number field declared with the color display: Color is its declared look, Number the raw number. */
export const tintSchema = schema('Tint', [
  { ...field('tint', 'INT', 0x4f86c6, { min: 0, max: 0xffffff, display: 'color' }), tooltip: 'Packed RGB color of the edge.' },
])

/**
 * The same tint field both ways: the first node shows it as Number, the
 * second, below, in its declared Color look. The stored value is the same.
 */
export function createTintRepresentationScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  width: number,
): Scene {
  return sceneOf(
    [
      { id: 'Tint', schema: tintSchema, x: position.x, y: position.y, width, views: { tint: 'number' } },
      { id: 'Tint declared', schema: tintSchema, x: position.x, y: position.y + 136, width },
    ],
    [],
    tokens,
    measure,
    widgetMeasure,
  )
}

/** The node of one representation example, with the look chosen for each field. */
export function createRepresentationScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  width: number,
  views: Record<string, string> = {},
  only?: readonly string[],
): Scene {
  const definition = only === undefined ? representationSchema : {
    ...representationSchema,
    items: representationSchema.items.filter((item) => item.kind !== 'input' || only.includes(item.id)),
  }
  return sceneOf(
    [{ id: 'Soften', schema: definition, x: position.x, y: position.y, width, views }],
    [],
    tokens,
    measure,
    widgetMeasure,
  )
}
