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
  body: [
    { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
    saveTargetInput(false, 'Where the saved images are written.'),
  ],
}

/** A node whose save target may be left empty. Its target has no tooltip. */
export const optionalSaveTargetSchema: NodeSchema = {
  ...saveTargetSchema,
  type: 'Gallery',
  displayName: 'Gallery',
  body: [
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
  body: [{ kind: 'output', id: 'target', type: { kind: 'concrete', name: 'dinkster.save_target' } }],
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
  options: { readonly optional?: boolean; readonly wired?: boolean; readonly unfolded?: boolean } = {},
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
            [id]: { position, size: { width: 280, height: 0 }, ...(options.unfolded === undefined ? {} : { editors: { target: { unfolded: options.unfolded } } }) },
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
  /** The stored target: a named mount, or only a prefix for Project default. */
  readonly stored: Json
  /** The box is open with this mount picked, null for Project default, and this prefix typed. */
  readonly open?: { readonly mount: string | null; readonly prefix: string }
  readonly mounts?: SaveTargetMountState
  /** The mount list is open, its candidate on this mount, '' for Project default. */
  readonly listOn?: string
  readonly optional?: boolean
  /** The project has no default output mount. */
  readonly noDefault?: boolean
  /** A wire brings this target. */
  readonly arriving?: Json
  /** The shared in-node fold-out rather than the hanging-box examples. */
  readonly foldout?: true
  /** Show the text field without a host-managed keyboard highlight. */
  readonly resting?: true
}

/** A target on Project default names only the prefix. */
const portrait = { prefix: 'renders/portrait' }
const onUsb = { mount: 'usb1', prefix: 'renders/portrait' }

/** The ready writable mounts every example offers; the first is the project's default output mount. */
export const galleryMounts = ['output', 'archive', 'scratch'] as const

/** The node's own default: Project default with the node's default name. */
export const galleryDefault = { prefix: 'ComfyUI' }

export const saveTargetGroups: readonly {
  readonly title: string
  readonly examples: readonly SaveTargetExample[]
}[] = [
  {
    title: 'Shared fold-out editor',
    examples: [
      { id: 'foldout-folded', caption: 'Folded: the shared editor header keeps its icon, target name, save location and opener.', stored: portrait, foldout: true },
      { id: 'foldout-folded-missing', caption: 'Folded with a missing mount: the header keeps the warning outline and triangle.', stored: onUsb, foldout: true },
      { id: 'foldout-folded-no-default', caption: 'Folded without an output mount: the header keeps the error outline and triangle.', stored: portrait, noDefault: true, foldout: true },
      { id: 'foldout-rest', caption: 'Open, at rest: the header stays in place; Mount and Name have ordinary dim borders. Neither field has the keyboard.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, foldout: true, resting: true },
      { id: 'foldout-typing', caption: 'Open, typing in Name: its own 1 px secondary-text border, with no cyan or second ring inside. The Mount border remains dim.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, foldout: true },
      { id: 'foldout-wired', caption: 'Whole target wired: folded, quiet, with the shared frame, icon and opener retained.', stored: portrait, arriving: { mount: 'archive', prefix: 'from/upstream' }, foldout: true },
      { id: 'foldout-wired-open', caption: 'Whole target wired, reopened to read what arrives. Neither Mount nor Name can change.', stored: portrait, arriving: { mount: 'archive', prefix: 'from/upstream' }, open: { mount: 'archive', prefix: 'from/upstream' }, foldout: true, resting: true },
      { id: 'foldout-invalid', caption: 'A refused Name keeps the Mount row visible. The name cannot leave the mount.', stored: portrait, open: { mount: null, prefix: '../escape' }, foldout: true },
      { id: 'foldout-missing', caption: 'A missing mount stays stored. Details opens the explanation and project-default action.', stored: onUsb, open: { mount: 'usb1', prefix: 'renders/portrait' }, foldout: true, resting: true },
      { id: 'foldout-no-default', caption: 'Project default has no output mount. The error stays inside the editor.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, noDefault: true, foldout: true, resting: true },
      { id: 'foldout-missing-no-default', caption: 'The stored mount is missing and this project has no default output mount.', stored: onUsb, open: { mount: 'usb1', prefix: 'renders/portrait' }, noDefault: true, foldout: true, resting: true },
      { id: 'foldout-none', caption: 'No ready writable mount. The message grows the editor only by its content height.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, mounts: 'none', foldout: true, resting: true },
      { id: 'foldout-loading', caption: 'Mounts are loading. Name stays editable inside the shared editor.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, mounts: 'loading', foldout: true, resting: true },
      { id: 'foldout-failed', caption: 'Mounts could not be read. The problem note stays inside the shared editor.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, mounts: 'failed', foldout: true, resting: true },
      { id: 'foldout-list', caption: 'The Mount list opens over the canvas without a side part.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, listOn: '', foldout: true, resting: true },
      { id: 'foldout-changed', caption: 'A changed target offers Reset to default in the shared editor button row.', stored: portrait, open: { mount: 'archive', prefix: 'renders/final' }, foldout: true, resting: true },
    ],
  },
]
