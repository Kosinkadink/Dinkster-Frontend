import {
  defaultValuesOf,
  loadDocument,
  type Json,
  type NodeSchema,
} from '@dinkster/core'
import {
  buildScene,
  type CompanionMap,
  type DesignTokens,
  type Scene,
  type TextMeasurer,
  type WidgetMeasure,
} from '../src/index.js'

/** The node the color page opens its field on. */
export const colorEditingSchema: NodeSchema = {
  type: 'Solid color',
  displayName: 'Solid color',
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items: [
    { kind: 'output', id: 'IMAGE', type: { kind: 'concrete', name: 'IMAGE' } },
    {
      kind: 'input',
      id: 'color',
      type: { kind: 'concrete', name: 'COLOR' },
      optional: false,
      tooltip: 'The color that fills the image.',
      widget: { widgetType: 'COLOR', options: {}, default: '#3366cc' },
    },
    {
      kind: 'input',
      id: 'width',
      type: { kind: 'concrete', name: 'INT' },
      optional: false,
      widget: { widgetType: 'INT', options: { min: 1, max: 16384 }, default: 1024 },
    },
    {
      kind: 'input',
      id: 'height',
      type: { kind: 'concrete', name: 'INT' },
      optional: false,
      widget: { widgetType: 'INT', options: { min: 1, max: 16384 }, default: 768 },
    },
  ],
}

/** The same node with its color stored as a whole number, as an integer color view shows it. */
const integerColorSchema: NodeSchema = {
  ...colorEditingSchema,
  items: colorEditingSchema.items.map((item) =>
    item.kind === 'input' && item.id === 'color'
      ? {
          ...item,
          type: { kind: 'concrete', name: 'INT' },
          widget: {
            widgetType: 'INT',
            options: { min: 0, max: 0xffffff, display: 'color' },
            default: 0x3366cc,
          },
        }
      : item,
  ),
}

const SOURCE = 'Color source'
const sourceSchema: NodeSchema = {
  type: SOURCE,
  displayName: SOURCE,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items: [{ kind: 'output', id: 'color', type: { kind: 'concrete', name: 'COLOR' } }],
}

/**
 * The color node laid out by the production scene builder, its color
 * stored as `stored`. A wired node takes its color from a source left of
 * the canvas, so only the wire coming in shows.
 */
export function createColorEditingScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  stored: string,
  wired = false,
  width = 280,
  integer = false,
): Scene {
  const id = colorEditingSchema.type
  const loaded = loadDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'canvas-gallery',
    root: 'gallery',
    graphs: {
      gallery: {
        id: 'gallery',
        name: 'Gallery',
        nextOrdinal: 3,
        nodes: {
          [id]: {
            id,
            type: id,
            values: {
              ...defaultValuesOf(colorEditingSchema),
              color: integer ? Number.parseInt(stored.slice(1), 16) : stored,
            },
          },
          ...(wired ? { [SOURCE]: { id: SOURCE, type: SOURCE, values: {} } } : {}),
        },
        links: wired
          ? {
              wire: {
                id: 'wire',
                from: { node: SOURCE, port: 'color' },
                to: { node: id, port: 'color' },
              },
            }
          : {},
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: {
            [id]: { position, size: { width, height: 0 } },
            ...(wired
              ? {
                  [SOURCE]: {
                    position: { x: -400, y: position.y },
                    size: { width: 160, height: 0 },
                  },
                }
              : {}),
          },
        },
      },
    },
  })
  if (!loaded.document)
    throw new Error(`Invalid gallery document: ${JSON.stringify(loaded)}`)
  return buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) =>
      type === id
        ? integer
          ? integerColorSchema
          : colorEditingSchema
        : type === SOURCE
          ? sourceSchema
          : undefined,
    tokens,
    measure,
    widgetMeasure,
  })
}

/** The value a wire brings to the wired example's color. */
export const wiredColorCompanions = (arriving: Json): CompanionMap => ({
  [colorEditingSchema.type]: { color: { value: arriving, state: 'expected' } },
})

/**
 * One labeled state of the color page. Colors are fixed examples; what the
 * field shows for them comes from the product's own color parsing.
 */
export interface ColorEditingExample {
  readonly id: string
  readonly caption: string
  /** The saved color. */
  readonly stored: string
  /** What is typed in the open field; none when nothing is open. */
  readonly text?: string
  /** The last valid color of the edit, which the preview holds while the text is not a color. */
  readonly lastValid?: string
  /** The hue the edit was last at, kept for a grey, white or black. */
  readonly hue?: number
  /** The field declares opacity. */
  readonly opacity?: boolean
  /** The color is stored as a whole number, as an integer color view shows it. */
  readonly integer?: boolean
  /** Colors already stored in the workflow, one entry per field. */
  readonly used?: readonly string[]
  /** The swatch the keyboard is on. */
  readonly candidate?: number
  /** The picker control the keyboard is on. */
  readonly keyboard?: 'square' | 'swatches'
  readonly pending?: boolean
  readonly refused?: string
  /** Nothing is open; the keyboard is on the color row. */
  readonly rowFocus?: boolean
  /** A wire brings this color to the field. */
  readonly arriving?: string
  /**
   * Where the canvas leaves room: no room right of the node, so the side
   * part opens on its left; the canvas ending just under the node, so the
   * picker opens above its field; or ending so close to the field that the
   * picker fits neither under nor over it and scrolls.
   */
  readonly room?: 'left' | 'above' | 'constrained'
  readonly scale?: number
}

const workflowColors = ['#cc6633', '#cc6633', '#008080', '#141c1d', '#ffffff']

export const colorEditingGroups: readonly {
  readonly title: string
  readonly examples: readonly ColorEditingExample[]
}[] = [
  {
    title: 'Closed and opened',
    examples: [
      {
        id: 'closed',
        caption: 'Nothing is open. The color square sits directly before the code, on the right.',
        stored: '#3366cc',
      },
      {
        id: 'open',
        caption: 'Just opened. The saved square stays by the name; a live square sits before the typed code. Both rings start at the saved color, and Enter keeps it.',
        stored: '#3366cc',
        text: '#3366cc',
        used: workflowColors,
      },
    ],
  },
  {
    title: 'A draft',
    examples: [
      {
        id: 'pick',
        caption: 'Dragged in the picker: the text, the live square and the rings follow. Nothing is stored and the saved square stays blue.',
        stored: '#3366cc',
        text: '#cc6633',
        used: workflowColors,
      },
      {
        id: 'swatch',
        caption: 'Clicked a workflow swatch: the same draft. The default comes first, then colors used in the workflow.',
        stored: '#3366cc',
        text: '#cc6633',
        used: workflowColors,
      },
      {
        id: 'invalid',
        caption: 'Typed cc6x after picking #cc6633. The preview and rings hold #cc6633; Enter keeps the stored #3366cc.',
        stored: '#3366cc',
        text: 'cc6x',
        lastValid: '#cc6633',
        used: workflowColors,
      },
      {
        id: 'named',
        caption: 'Typed teal. Names, rgb(51, 102, 204), 51, 102, 204 and hex without # are colors too; Enter stores lower-case hex.',
        stored: '#3366cc',
        text: 'teal',
        used: workflowColors,
      },
      {
        id: 'empty',
        caption: 'Cleared the text. An empty color is not a color: Enter keeps the stored color and the last valid point stays.',
        stored: '#3366cc',
        text: '',
        lastValid: '#3366cc',
        used: workflowColors,
      },
    ],
  },
  {
    title: 'Opacity',
    examples: [
      {
        id: 'alpha',
        caption: 'A field that declares opacity has a third strip, clear on the left and opaque on the right; squares show it over a checker.',
        stored: '#3366cc',
        text: '#3366cc80',
        opacity: true,
        used: workflowColors,
      },
      {
        id: 'clear',
        caption: 'Fully transparent: the ring sits inside the clear end, and the color keeps its RGB.',
        stored: '#3366cc',
        text: '#3366cc00',
        opacity: true,
        used: workflowColors,
      },
      {
        id: 'drop',
        caption: 'Pasted #3366cc80 into a field without opacity. It takes the color, drops the opacity and says so; it is not an error.',
        stored: '#cc6633',
        text: '#3366cc80',
        used: workflowColors,
      },
      {
        id: 'wired',
        caption: 'A wire brings #3366cc80 to a field without opacity. No field opens; the side part shows the color that arrives and the color used.',
        stored: '#3366cc',
        arriving: '#3366cc80',
      },
    ],
  },
  {
    title: 'A whole-number color',
    examples: [
      {
        id: 'integer-closed',
        caption: 'A color stored as a whole number is drawn like any color, with no minus and plus: a click anywhere on the row opens it.',
        stored: '#3366cc',
        integer: true,
      },
      {
        id: 'integer-open',
        caption: 'Opened, it is the same field and picker without opacity. The field shows #3366cc; the stored value stays the whole number 3368652.',
        stored: '#3366cc',
        text: '#3366cc',
        integer: true,
        used: workflowColors,
      },
    ],
  },
  {
    title: 'Rings at the edges',
    examples: [
      {
        id: 'black',
        caption: 'Black: the ring sits wholly inside the corner, and the hue strip keeps the hue the edit was at.',
        stored: '#3366cc',
        text: '#000000',
        hue: 220,
        used: workflowColors,
      },
      {
        id: 'white',
        caption: 'White, after red: the square ring at the top-left corner and the hue ring at the red end both stay inside.',
        stored: '#3366cc',
        text: '#ffffff',
        hue: 0,
        used: workflowColors,
      },
    ],
  },
  {
    title: 'Storing',
    examples: [
      {
        id: 'done',
        caption: 'Stored with Enter, or left with Escape: the picker closes and the keyboard stays on the row.',
        stored: '#cc6633',
        rowFocus: true,
      },
      {
        id: 'pending',
        caption: 'Waiting for the store: the field and the picker cannot change until it completes.',
        stored: '#3366cc',
        text: '#cc6633',
        used: workflowColors,
        pending: true,
      },
      {
        id: 'refused',
        caption: 'The store was refused: the refusal comes first, and the draft, live square and rings stay.',
        stored: '#3366cc',
        text: '#cc6633',
        used: workflowColors,
        refused: 'The field is no longer editable.',
      },
    ],
  },
  {
    title: 'Room on the canvas',
    examples: [
      {
        id: 'above',
        caption: 'The canvas ends just under the node: the picker opens above its field, and the side part moves up beside them.',
        stored: '#3366cc',
        text: '#3366cc',
        used: workflowColors,
        room: 'above',
      },
      {
        id: 'left',
        caption: 'No room right of the node: the side part opens on its left, beside the field and its picker.',
        stored: '#3366cc',
        text: '#3366cc',
        used: workflowColors,
        room: 'left',
      },
      {
        id: 'constrained',
        caption: 'The canvas ends close under the field and there is no room over it: the picker takes the room under it and scrolls.',
        stored: '#3366cc',
        text: '#3366cc',
        used: workflowColors,
        room: 'constrained',
      },
      {
        id: 'stacked',
        caption: 'At 50 percent the field and picker keep their normal size and the side part goes under them, in one outline.',
        stored: '#3366cc',
        text: '#3366cc',
        used: workflowColors,
        scale: 0.5,
      },
    ],
  },
  {
    title: 'The keyboard and swatches',
    examples: [
      {
        id: 'keyboard',
        caption: 'Alt+Down put the keyboard on the square; arrows change saturation and value. Alt+Up goes back, and Tab still moves to the next row.',
        stored: '#3366cc',
        text: '#3366cc',
        used: workflowColors,
        keyboard: 'square',
      },
      {
        id: 'eight',
        caption: 'Eight swatches: the default once, then the workflow colors by use, ties in code order.',
        stored: '#3366cc',
        text: '#3366cc',
        used: [
          '#cc6633', '#cc6633', '#cc6633', '#008080', '#008080', '#ff7468',
          '#32e6c5', '#000000', '#ffffff', '#141c1d', 'not a color', '#3366CC',
        ],
        keyboard: 'swatches',
        candidate: 2,
      },
    ],
  },
]
