import {
  asPortId,
  defaultValuesOf,
  loadDocument,
  type Json,
  type NodeSchema,
} from '@dinkster/core'
import {
  buildScene,
  canvasPaintTokens,
  type CompanionMap,
  type DesignTokens,
  type Scene,
  type PinLayout,
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
  options: { readonly optional?: boolean; readonly wired?: boolean; readonly unfolded?: boolean; readonly wiredParts?: readonly string[]; readonly nameOffset?: number } = {},
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
  const scene = buildScene({
    document: loaded.document,
    graphId: 'gallery',
    resolve: (type) => (type === id ? schema : type === SOURCE ? sourceSchema : undefined),
    tokens,
    measure,
    widgetMeasure,
  })
  if (options.unfolded === undefined) return scene
  const node = scene.nodes.find((item) => item.id === id)!
  const header = node.layout.rows.find((row) => row.kind === 'widget' && row.valueKey === 'target')!
  const space = node.layout.rows.find((row) => row.kind === 'editorSpace' && row.valueKey === 'target')
  const parts = ['mount', 'name'].filter((part) => space !== undefined || options.wiredParts?.includes(part))
  const pins: PinLayout[] = parts.map((part, index) => ({
    portId: part, address: { port: asPortId(part) }, direction: 'in', label: part === 'mount' ? 'Mount' : 'Name', optional: true,
    type: { kind: 'concrete', name: part === 'mount' ? 'MOUNT' : 'STRING' },
    y: space === undefined
      ? header.y + tokens.rowHeight / 2 + (index - (parts.length - 1) / 2) * canvasPaintTokens.node.box.clusterPitch.two
      : space.y + canvasPaintTokens.node.editorSpace.pad + (part === 'name' ? options.nameOffset ?? tokens.rowHeight : 0) + tokens.rowHeight / 2,
    ...(space === undefined ? { collapsedSection: 'target' } : {}),
  }))
  // These two example pins do not declare engine inputs. The engine contract is separate.
  return {
    ...scene,
    nodes: scene.nodes.map((item) => item.id === id ? { ...item, layout: { ...item.layout, pins: [...item.layout.pins, ...pins] } } : item),
    links: [...scene.links, ...pins.filter((pin) => options.wiredParts?.includes(pin.portId)).map((pin) => ({
      id: `part-${pin.portId}`, from: { kind: 'port' as const, node: SOURCE, port: pin.portId }, to: { kind: 'port' as const, node: id, port: pin.portId },
      x1: -100, y1: node.y + pin.y, x2: node.x, y2: node.y + pin.y,
      typeName: pin.type.kind === 'concrete' ? pin.type.name : 'STRING',
    }))],
  }
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
  readonly wiredParts?: readonly ('mount' | 'name')[]
}

/** A target on Project default names only the prefix. */
const portrait = { prefix: 'renders/portrait' }
const onOutput = { mount: 'output', prefix: 'renders/portrait' }
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
      { id: 'foldout-mount-wired', caption: 'Example data only: Mount wired while Name stays editable. No engine input is added.', stored: portrait, open: { mount: 'archive', prefix: 'renders/portrait' }, foldout: true, resting: true, wiredParts: ['mount'] },
      { id: 'foldout-name-wired', caption: 'Example data only: Name wired while Mount stays editable.', stored: portrait, open: { mount: null, prefix: 'shots/shot_042' }, foldout: true, resting: true, wiredParts: ['name'] },
      { id: 'foldout-both-folded', caption: 'Example data only: connected Mount and Name pins gather at the closed header on the node edge.', stored: portrait, foldout: true, wiredParts: ['mount', 'name'] },
      { id: 'foldout-missing', caption: 'A missing mount stays stored. Details opens the explanation and project-default action.', stored: onUsb, open: { mount: 'usb1', prefix: 'renders/portrait' }, foldout: true, resting: true },
      { id: 'foldout-no-default', caption: 'Project default has no output mount. The error stays inside the editor.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, noDefault: true, foldout: true, resting: true },
      { id: 'foldout-missing-no-default', caption: 'The stored mount is missing and this project has no default output mount.', stored: onUsb, open: { mount: 'usb1', prefix: 'renders/portrait' }, noDefault: true, foldout: true, resting: true },
      { id: 'foldout-none', caption: 'No ready writable mount. The message grows the editor only by its content height.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, mounts: 'none', foldout: true, resting: true },
      { id: 'foldout-changed', caption: 'A changed target offers Reset to default in the shared editor button row.', stored: portrait, open: { mount: 'archive', prefix: 'renders/final' }, foldout: true, resting: true },
    ],
  },
  {
    title: 'Opening, picking a mount and leaving',
    examples: [
      { id: 'closed-default', caption: 'Closed, on Project default: the row names the mount it means here in italics, then the name.', stored: portrait },
      { id: 'closed', caption: 'Closed, on a named mount: the mount is upright, as stored.', stored: onOutput },
      { id: 'open', caption: 'Open on Project default, where a new target starts: the dropdown says Project default and stores no mount; the row and the side part name the mount it means here. The default is a link.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' } },
      { id: 'open-rest', caption: 'The existing open editor at rest: the Name field has its ordinary dim border, not the brighter typing border.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, resting: true },
      { id: 'list', caption: 'The dropdown open: Project default first, naming the mount it means here, then this machine\'s writable mounts. The list lies over the box and past its lower edge.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, listOn: '' },
      { id: 'changed', caption: 'archive picked and a new name typed: the row and the side part show what leaving would store. Escape would keep the stored target.', stored: portrait, open: { mount: 'archive', prefix: 'renders/final' } },
      { id: 'left', caption: 'Left with Enter, Tab or a click outside: the new target is stored as one undo step.', stored: { mount: 'archive', prefix: 'renders/final' } },
    ],
  },
  {
    title: 'Mounts that cannot be used',
    examples: [
      { id: 'loading', caption: 'The mounts are still being read: the prefix can already be typed, and the row reads Project default until the mount it means is known.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, mounts: 'loading' },
      { id: 'none', caption: 'No writable mount is ready: no mount can be picked.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, mounts: 'none' },
      { id: 'failed', caption: 'The mounts could not be read: the dropdown says Could not load and the error\'s own sentence leads the side part.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, mounts: 'failed' },
      { id: 'not-here-closed', caption: 'Closed, with a stored mount this machine lacks: it is struck through, followed by the mount the run uses in italics. Nothing has to be changed.', stored: onUsb },
      { id: 'not-here', caption: 'The stored mount is not on this machine: the run saves to the project default and the stored mount stays. The side part says so and offers Use project default.', stored: onUsb, open: { mount: 'usb1', prefix: 'renders/portrait' } },
      { id: 'no-default-closed', caption: 'Closed, on Project default in a project with no default output mount: the row says so in italics, unlike the row whose mounts are still being read.', stored: portrait, noDefault: true },
      { id: 'no-default', caption: 'Open, in a project with no default output mount: the list entry reads Project default (no output mount), and the side part leads with why a run cannot save, in the error color. Nothing is refused.', stored: portrait, open: { mount: null, prefix: 'renders/portrait' }, noDefault: true },
      { id: 'not-here-no-default-closed', caption: 'Closed, with a stored mount this machine lacks and no default output mount: the mount is struck through, followed by no output mount in italics.', stored: onUsb, noDefault: true },
      { id: 'not-here-no-default', caption: 'Open, with a stored mount this machine lacks and no default output mount: the side part names both facts in the error color.', stored: onUsb, open: { mount: 'usb1', prefix: 'renders/portrait' }, noDefault: true },
      { id: 'not-here-list', caption: 'The same mount in the list: dimmed, marked not on this machine, and it cannot be picked.', stored: onUsb, open: { mount: 'usb1', prefix: 'renders/portrait' }, listOn: '' },
    ],
  },
  {
    title: 'Names, tooltips and wires',
    examples: [
      { id: 'invalid', caption: 'A name that cannot be used: the field is outlined, the sentence stands under it and Enter keeps the stored target.', stored: portrait, open: { mount: null, prefix: '../escape' } },
      { id: 'no-tooltip', caption: 'An input with no tooltip: only the naming help shows under the divider.', stored: onOutput, open: { mount: 'output', prefix: 'renders/portrait' }, optional: true },
      { id: 'wired', caption: 'The row has a wire: it shows the target that arrives and does not open.', stored: onOutput, arriving: { mount: 'archive', prefix: 'from/upstream' } },
    ],
  },
]
