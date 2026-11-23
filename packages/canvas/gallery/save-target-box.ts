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

const saveTargetInput = (optional: boolean, tooltip?: string) =>
  ({
    kind: 'input',
    id: 'target',
    type: { kind: 'concrete', name: 'dinkster.save_target' },
    optional,
    ...(tooltip === undefined ? {} : { tooltip }),
    widget: { widgetType: 'SAVE_TARGET', options: { suffix: '.png' } },
  }) as const

/** The node the save target page opens its row on; its target declares a tooltip. */
export const saveTargetSchema: NodeSchema = {
  type: 'Save image',
  displayName: 'Save image',
  category: 'gallery',
  source: 'v3',
  isOutputNode: true,
  items: [
    { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
    saveTargetInput(false, 'Where the saved images are written.'),
  ],
}

/** A node whose save target may be left empty, which writes to the default output. Its target has no tooltip. */
export const optionalSaveTargetSchema: NodeSchema = {
  ...saveTargetSchema,
  type: 'Gallery',
  displayName: 'Gallery',
  items: [
    { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
    saveTargetInput(true),
  ],
}

const SOURCE = 'Target source'
const sourceSchema: NodeSchema = {
  type: SOURCE,
  displayName: SOURCE,
  category: 'gallery',
  source: 'v3',
  isOutputNode: false,
  items: [{ kind: 'output', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' } }],
}

/**
 * The save node laid out by the production scene builder, its target
 * stored as `stored`. A wired node takes its target from a source left of
 * the canvas, so only the wire coming in shows.
 */
export function createSaveTargetScene(
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  position: { x: number; y: number },
  stored: Json,
  options: { readonly optional?: boolean; readonly wired?: boolean } = {},
): Scene {
  const schema = options.optional === true ? optionalSaveTargetSchema : saveTargetSchema
  const id = schema.type
  const wired = options.wired === true
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
          [id]: { id, type: id, values: { ...defaultValuesOf(schema), target: stored } },
          ...(wired ? { [SOURCE]: { id: SOURCE, type: SOURCE, values: {} } } : {}),
        },
        links: wired
          ? { wire: { id: 'wire', from: { node: SOURCE, port: 'target' }, to: { node: id, port: 'target' } } }
          : {},
        nets: {},
        reroutes: {},
      },
    },
    view: {
      graphs: {
        gallery: {
          nodes: {
            [id]: { position, size: { width: 280, height: 0 } },
            ...(wired ? { [SOURCE]: { position: { x: -400, y: position.y }, size: { width: 160, height: 0 } } } : {}),
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
    resolve: (type) => (type === id ? schema : type === SOURCE ? sourceSchema : undefined),
    tokens,
    measure,
    widgetMeasure,
  })
}

/** The target a wire brings to the wired example. */
export const wiredTargetCompanions = (node: string, arriving: Json): CompanionMap => ({
  [node]: { target: { value: arriving, state: 'expected' } },
})

/** How an example's mounts stand. */
export type SaveTargetMountState = 'loading' | 'none' | 'failed' | 'ready'

/** One labeled state of the save target page. */
export interface SaveTargetExample {
  readonly id: string
  readonly caption: string
  /** The stored target, or null for Default output. */
  readonly stored: Json
  /** The box is open with this mount picked and this prefix typed. */
  readonly open?: { readonly mount: string; readonly prefix: string }
  readonly mounts?: SaveTargetMountState
  /** The mount list is open, its candidate on this mount. */
  readonly listOn?: string
  /** Clear destination was pressed. */
  readonly cleared?: boolean
  readonly optional?: boolean
  /** A wire brings this target. */
  readonly arriving?: Json
}

const portrait = { mount: 'output', prefix: 'renders/portrait' }

/** The ready writable mounts every example offers. */
export const galleryMounts = ['output', 'archive', 'shared-nas'] as const

export const saveTargetGroups: readonly {
  readonly title: string
  readonly examples: readonly SaveTargetExample[]
}[] = [
  {
    title: 'Opening, picking a mount and leaving',
    examples: [
      { id: 'closed', caption: 'Closed: the row shows mount and prefix together, as stored.', stored: portrait },
      { id: 'open', caption: 'Open: a box under the row with the mount dropdown and the prefix; the side part says what Enter would do, then the input\'s tooltip and the naming help.', stored: portrait, open: portrait },
      { id: 'list', caption: 'The dropdown open: its list lies over the box and past its lower edge.', stored: portrait, open: portrait, listOn: 'archive' },
      { id: 'changed', caption: 'archive picked and a new name typed: the row and the side part show what leaving would store.', stored: portrait, open: { mount: 'archive', prefix: 'renders/final' } },
      { id: 'left', caption: 'Left with Enter, Tab or a click outside: the new target is stored as one undo step.', stored: { mount: 'archive', prefix: 'renders/final' } },
      { id: 'escaped', caption: 'Escape instead: the box closes and the stored target stays.', stored: portrait },
    ],
  },
  {
    title: 'Mounts that cannot be used',
    examples: [
      { id: 'loading', caption: 'The mounts are still being read: the prefix can already be typed; nothing can be stored.', stored: portrait, open: portrait, mounts: 'loading' },
      { id: 'none', caption: 'No writable mount is ready: nothing can be stored.', stored: portrait, open: portrait, mounts: 'none' },
      { id: 'failed', caption: 'The mounts could not be read: the dropdown says Could not load and the error\'s own sentence leads the side part.', stored: portrait, open: portrait, mounts: 'failed' },
      { id: 'gone', caption: 'The stored mount is gone: it stays, dimmed, until another mount is picked.', stored: { mount: 'usb1', prefix: 'renders/portrait' }, open: { mount: 'usb1', prefix: 'renders/portrait' } },
      { id: 'gone-list', caption: 'The gone mount in the list: dimmed, and it cannot be picked.', stored: { mount: 'usb1', prefix: 'renders/portrait' }, open: { mount: 'usb1', prefix: 'renders/portrait' }, listOn: 'output' },
    ],
  },
  {
    title: 'Names, empty targets and wires',
    examples: [
      { id: 'invalid', caption: 'A name that cannot be used: the field is outlined and Enter keeps the stored target.', stored: portrait, open: { mount: 'output', prefix: '../escape' } },
      { id: 'optional', caption: 'A target that may be empty: Clear destination on the footer line. This input has no tooltip, so only the naming help shows.', stored: portrait, open: portrait, optional: true },
      { id: 'cleared', caption: 'After Clear destination: leaving stores Default output.', stored: portrait, open: { mount: 'output', prefix: '' }, optional: true, cleared: true },
      { id: 'default', caption: 'Stored as Default output, closed.', stored: null, optional: true },
      { id: 'wired', caption: 'The row has a wire: it shows the target that arrives and does not open.', stored: portrait, arriving: { mount: 'archive', prefix: 'from/upstream' } },
    ],
  },
]
