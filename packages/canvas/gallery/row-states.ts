import {
  asNodeId,
  decodeStep,
  defaultValuesOf,
  documentResolver,
  loadDocument,
  occurrenceDynamicView,
  type AskRequest,
  type InputSpec,
  type Json,
  type NodeProgress,
  type NodeSchema,
  type Step,
  type TypeExpr,
  type WidgetRepresentationsSpec,
} from '@dinkster/core'
import {
  buildScene,
  type DesignTokens,
  type ButtonPaintMap,
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
const schema = (type: string, body: NodeSchema['body']): NodeSchema => ({
  type,
  displayName: type,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  body,
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
  { ...field('readonlyMix', 'FLOAT', 0.65, { min: 0, max: 1, step: 0.01 }),
    displayName: 'mix', readOnly: true, tooltip: 'Value is read-only. Its representation can still change.' },
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

function promotedOccurrenceScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  inside: boolean,
): Scene {
  const document = loadDocument({
    format: 'dinkster-workflow', formatVersion: 1,
    lineage: 'gallery-promoted-occurrences', root: 'root',
    graphs: {
      root: {
        id: 'root', name: 'Instances', nextOrdinal: 3,
        nodes: {
          first: { id: 'first', type: '#outer', title: 'Soften 12', values: { radius: 12 } },
          second: { id: 'second', type: '#outer', title: 'Soften 24', values: { radius: 24 } },
        }, links: {}, nets: {}, reroutes: {},
      },
      outer: {
        id: 'outer', name: 'Soften', nextOrdinal: 2,
        nodes: { nested: { id: 'nested', type: '#inner', values: { innerRadius: 6 } } },
        links: {}, nets: {}, reroutes: {},
        boundary: { inputs: [{ id: 'radius', binds: { kind: 'port', node: 'nested', port: 'innerRadius' }, promoted: true, wireHidden: true }], outputs: [] },
      },
      inner: {
        id: 'inner', name: 'Inner soften', nextOrdinal: 2,
        nodes: { soften: { id: 'soften', type: soften.type, values: { radius: 7, mix: 0.65 } } },
        links: {}, nets: {}, reroutes: {},
        boundary: { inputs: [{ id: 'innerRadius', displayName: 'Inner radius', binds: { kind: 'port', node: 'soften', port: 'radius' }, promoted: true, wireHidden: true }], outputs: [] },
      },
    },
    view: { graphs: {
      root: { nodes: { first: { position: { x: 0, y: 0 } }, second: { position: { x: 280, y: 0 } } } },
      outer: { nodes: { nested: { position: { x: 350, y: 0 } } } },
      inner: { nodes: { soften: { position: { x: 350, y: 0 } } } },
    } },
  }).document
  if (!document) throw new Error('Invalid promoted occurrence gallery document')
  const resolve = documentResolver(document, (type) => type === soften.type ? soften : undefined)
  const path = inside ? [asNodeId('second'), asNodeId('nested')] : []
  return buildScene({
    document, graphId: inside ? 'inner' : 'root', resolve, tokens, measure, widgetMeasure,
    ...(inside ? { occurrence: { owner: { instancePath: [asNodeId('second')], node: asNodeId('nested') }, plannerAvailable: false } } : {}),
    occurrenceView: occurrenceDynamicView(document, resolve, path),
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
  readonly buttons?: ButtonPaintMap
  readonly focus?: { readonly button: string; readonly help?: string }
  readonly result?: { readonly button: string; readonly tone: 'info' | 'warn'; readonly message: string }
  readonly pick?: { readonly button: string; readonly state: 'ready' | 'empty' | 'failed' }
  readonly ask?: { readonly button: string; readonly request: AskRequest }
}

/** The canvas examples of the page, by section, in the order it shows them. */
export function rowStateExamples(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
): { readonly nothing: readonly RowStateExample[]; readonly promoted: readonly RowStateExample[]; readonly buttons: readonly RowStateExample[] } {
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
      rowMarks: { soften: { radius: 'error' } },
    },
    {
      id: 'unknown',
      caption: 'Wired but value not yet known. radius keeps its stored 12 struck through in its own widget look. Nothing is reserved for a finished run that gave nothing.',
      scene: feed(),
    },
    {
      id: 'unknown-narrow',
      caption: 'The same on a narrow node. The stored 12 stays struck through and is used again when the wire is removed.',
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
      caption: 'Inside a subgraph. strength has no drawn wire: the cyan subgraph icon sits before its name and the value of the entered instance is quiet. radius has a drawn wire from the Inputs panel: the ordinary wired look, no icon.',
      scene: structuralGalleryScene(tokens, measure, widgetMeasure, true),
    },
    {
      id: 'promoted-outside',
      caption: 'Outside, on two instances of the same subgraph. Each radius shows its own stored value, 12 or 24, with no promotion mark. These are real subgraph occurrences, not ordinary nodes with a subgraph badge.',
      scene: promotedOccurrenceScene(tokens, measure, widgetMeasure, false),
    },
    {
      id: 'promoted-nested',
      caption: 'Two levels deep, entered through Soften 24. Inner radius and the quiet inner field show 24, not the nested definition 6 or leaf default 7. The cyan mark names only this graph boundary, Inner radius; there is no depth badge.',
      scene: promotedOccurrenceScene(tokens, measure, widgetMeasure, true),
    },
  ]
  const buttonNode = schema('Prepare image', [
    field('strength', 'FLOAT', 0.65, { min: 0, max: 1 }),
    { kind: 'button', id: 'prepare', label: 'Prepare', steps: [{ step: 'set', field: 'radius', value: { value: 24 } }] },
    field('radius', 'INT', 12, { min: 0, max: 64 }),
  ])
  const buttons: RowStateExample[] = [
    {
      id: 'button-ready-focus',
      caption: 'Ready Button, keyboard focus. Tab and Shift+Tab keep its place between strength and radius. Enter or Space presses it once; holding a key does not repeat the press.',
      scene: sceneOf([{ id: 'prepare', schema: buttonNode, x: 0, y: 0 }], [], tokens, measure, widgetMeasure),
      focus: { button: 'prepare' },
    },
    {
      id: 'button-disabled-focus',
      caption: 'Disabled Button, keyboard focus. The same shared outline and side part as a disabled field show the reason. It is announced disabled; Enter and Space do nothing.',
      scene: sceneOf([{ id: 'prepare', schema: schema('Prepare image', buttonNode.body.map((row) => row.kind !== 'button' ? row : {
        ...row, enabled: false, disabledReason: 'Choose a preset before using this button.',
      })), x: 0, y: 0 }], [], tokens, measure, widgetMeasure),
      buttons: { prepare: { prepare: { kind: 'off' } } },
      focus: { button: 'prepare', help: 'Choose a preset before using this button.' },
    },
    {
      id: 'button-busy-focus',
      caption: 'Busy Button, keyboard focus. Reported progress replaces the label and Cancel stays visible. Enter or Space cancels without storing any staged edits; the Button keeps its row-cycle place.',
      scene: sceneOf([{ id: 'prepare', schema: buttonNode, x: 0, y: 0 }], [], tokens, measure, widgetMeasure),
      buttons: { prepare: { prepare: { kind: 'busy', text: 'Preparing 40%' } } },
      focus: { button: 'prepare' },
    },
    {
      id: 'button-unknown-focus',
      caption: 'A required argument is not known until a run. The host disables the Button, but its keyboard stop still shows the reason without starting the action.',
      scene: sceneOf([{ id: 'prepare', schema: schema('Prepare image', [
        { kind: 'input', id: 'image', type: concrete('IMAGE'), optional: false },
        ...buttonNode.body.map((row) => row.kind !== 'button' ? row : {
          ...row, steps: [{ step: 'call', function: 'image.radius', args: ['image'], writes: ['radius'] }],
        }),
      ]), x: 200, y: 0 },
      { id: 'load', schema: loadImage, x: 0, y: 0, width: 160 },
      ], [{ from: ['load', 'IMAGE'], to: ['prepare', 'image'] }], tokens, measure, widgetMeasure),
      buttons: { prepare: { prepare: { kind: 'off' } } },
      focus: { button: 'prepare', help: 'Needs image, which is not known until a run.' },
    },
    {
      id: 'button-wired-focus',
      caption: 'Every write target has a wire. The host disables the Button and its keyboard stop explains why. Inspecting the reason changes no wire or value.',
      scene: sceneOf([
        { id: 'prepare', schema: buttonNode, x: 200, y: 0 },
        { id: 'measure', schema: measureNode, x: 0, y: 0, width: 160 },
      ], [{ from: ['measure', 'radius'], to: ['prepare', 'radius'] }], tokens, measure, widgetMeasure),
      buttons: { prepare: { prepare: { kind: 'off' } } },
      focus: { button: 'prepare', help: 'Every field this would set has a wire.' },
    },
  ]
  buttons.push(
    ...(['hoveredButton', 'pressedButton'] as const).map((state) => ({
      id: `button-${state === 'hoveredButton' ? 'hover' : 'pressed'}`,
      caption: state === 'hoveredButton' ? 'Ready under the pointer. The raised face uses the ordinary hover fill.' : 'Pointer held down. The same Button sinks until release; no second control is introduced.',
      scene: sceneOf([{ id: 'prepare', schema: buttonNode, x: 0, y: 0 }], [], tokens, measure, widgetMeasure),
      overlay: { [state]: { nodeId: 'prepare', key: 'button:prepare' } },
    })),
    ...([
      ['button-success', 'Successful, no skipped writes. The Button returns quietly to ready; no result box is invented.', undefined],
      ['button-cancelled', 'Cancelled. The Button returns to ready and the discarded answer stores nothing.', undefined],
      ['button-skipped-write', 'Done with a skipped write. The information box stays until the next press; the wired field is unchanged.', { tone: 'info', message: 'Set 1 field. radius has a wire and was left as it is.' }],
      ['button-failed', 'Failed. The warning triangle uses the existing warning color; the failed press stores nothing.', { tone: 'warn', message: 'Nothing was changed. No sheet named video in this file.' }],
    ] as const).map(([id, caption, result]) => ({
      id, caption,
      scene: id === 'button-skipped-write'
        ? sceneOf([
          { id: 'prepare', schema: schema('Prepare image', buttonNode.body.map((row) => row.kind !== 'button' ? row : {
            ...row, steps: [
              { step: 'set', field: 'strength', value: { value: 0.8 } },
              { step: 'set', field: 'radius', value: { value: 24 } },
            ],
          })), x: 200, y: 0, values: { strength: 0.8 } },
          { id: 'measure', schema: measureNode, x: 0, y: 0, width: 160 },
        ], [{ from: ['measure', 'radius'], to: ['prepare', 'radius'] }], tokens, measure, widgetMeasure)
        : sceneOf([{ id: 'prepare', schema: buttonNode, x: 0, y: 0, ...(id === 'button-success' ? { values: { radius: 24 } } : {}) }], [], tokens, measure, widgetMeasure),
      ...(result === undefined ? {} : { result: { button: 'prepare', ...result } }),
    })),
    ...(['ready', 'empty', 'loading', 'failed'] as const).map((state) => ({
      id: `button-pick-${state}`,
      caption: state === 'loading' ? 'Pick waits for its lookup. The Button says Loading and exposes Cancel; its list opens only after that lookup answers.' : `Pick, ${state}. The Button opens the same filtered list as a choice field, not a separate Button picker.`,
      scene: sceneOf([{ id: 'prepare', schema: schema('Prepare image', buttonNode.body.map((row) => row.kind !== 'button' ? row : {
        ...row, steps: [{ step: 'pick', name: 'preset', options: state === 'loading' || state === 'failed'
          ? { lookup: 'image.presets', args: [] }
          : { value: state === 'empty' ? [] : ['Portrait', 'Landscape', 'Line art'] } }],
      })), x: 0, y: 0 }], [], tokens, measure, widgetMeasure),
      ...(state === 'loading'
        ? { buttons: { prepare: { prepare: { kind: 'busy' as const, text: 'Loading' } } } }
        : { pick: { button: 'prepare', state } }),
    })),
  )
  const askStep = { step: 'ask', title: 'Fill', rows: [
    { id: 'start', type: { kind: 'concrete', types: ['FLOAT'] }, required: true, default: 0 },
    { id: 'end', type: { kind: 'concrete', types: ['FLOAT'] }, required: true, default: 1 },
    { id: 'count', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 5, widget: { type: 'NUMBER', min: 1 } },
  ] } as const
  const askRows = (decodeStep(askStep) as Extract<Step, { step: 'ask' }>).rows
  buttons.push({
    id: 'button-ask',
    caption: 'Ask uses the existing side part. Start, end and count are ordinary fields; Cancel discards the answer and Apply returns it to the Button.',
    scene: sceneOf([{ id: 'floats', schema: schema('Float list', [
      { kind: 'button', id: 'fill', label: 'Fill', steps: [askStep] },
    ]), x: 0, y: 0 }], [], tokens, measure, widgetMeasure),
    ask: { button: 'fill', request: { target: { graphId: 'root', nodeId: 'floats' }, title: 'Fill', rows: askRows } },
  })
  return { nothing, promoted, buttons }
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
    body: representationSchema.body.filter((item) => item.kind !== 'input' || only.includes(item.id)),
  }
  return sceneOf(
    [{ id: 'Soften', schema: definition, x: position.x, y: position.y, width, views }],
    [],
    tokens,
    measure,
    widgetMeasure,
  )
}
