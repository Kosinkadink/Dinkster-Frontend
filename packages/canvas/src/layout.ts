/**
 * Node layout (initial implementation rows + subgraph implementation dynamics): the row model from architecture
 * section 12, computed over the node's ELABORATED interface.
 *
 * Committed rules implemented here:
 * - Input/output pairing on one line is the default: outputs fill slots
 *   opposite connection-input rows top-down.
 * - Widgets own the full row width unless sibling placement shares a line;
 *   outputs never pair with widgets. Overflow outputs
 *   get dedicated rows.
 * - Rows have fixed type-appropriate heights. A multiline text box is as
 *   many lines tall as the user sized it, else as its widget declares.
 * - Auto-size: a node's natural size is a pure function of its row stack +
 *   tokens. Manual overrides are editing implementation (stored in view state, min-clamped).
 *
 * Dynamics: rows/pins come from `elaborateInterface`, so autogrow
 * members, min-fill, trailing ghosts, combo selectors/branches, and slot
 * dependents all render through ONE path, subgraph instances included
 * (they resolve to boundary-derived schemas through documentResolver).
 * Row/pin ids are the rows' flattened ids (unique per node); document
 * identity also travels as `address` for command params.
 * Ghost rows carry `materialize` frames: the UI batches dynamic.materialize
 * with whatever action lands on the ghost (hazard N3).
 *
 * Layout is pure and renderer-agnostic; text measurement is injected.
 */

import {
  elaborateInterface,
  groupBoxKey,
  lineKeyOf,
  materializeFramesOf,
  resettableWidgetsOf,
  resolveWidgetRepresentation,
  selectorBranchDisplay,
  selectorMembersOf,
  valueKeyOf,
  type BoundaryRouteLeg,
  type ElaboratedInput,
  type ElaboratedInterface,
  type ElaboratedItem,
  type ElaboratedOutput,
  type InputSpec,
  type Json,
  type MaterializeFrame,
  type NodeData,
  type NodeSchema,
  type OccurrenceRef,
  type OutputSpec,
  type PortAddress,
  type SourceFilenameSpec,
  type TypeExpr,
  type WidgetParts,
  type WidgetSpec,
} from '@dinkster/core'
import { IN_NODE_EDITORS, canvasPaintTokens, type DesignTokens } from './tokens.js'

/** Injected text measurement (canvas measureText in the app; approximate in tests). */
export type TextMeasurer = (text: string, role: 'title' | 'renamedTitle' | 'label' | 'value') => number

/** Resolves the widget view for a spec: view id + compact row count. */
/**
 * How the host draws a widget: its view and rows. `editorControls`, for an
 * editor shown in the node, is the height its own controls take when the
 * host knows they differ from the editor's fixed rows, such as a recorder on
 * a backend that cannot take uploads, which shows one sentence instead.
 */
export type WidgetMeasure = (spec: WidgetSpec) => { viewId: string; rows: number; editorControls?: number } | undefined

export interface DynamicEditOwner {
  readonly graphId: string
  readonly nodeId: string
  readonly construct: string
}

/**
 * Dynamic-family annotations shared by port slots, widget rows, and pins.
 * `portId`/`inputId` are flattened ids (unique per node, presentation/lookup);
 * `address` is document identity ({port}) for command params.
 */
export interface DynamicAnnotations {
  readonly address: PortAddress
  /** Backend-facing name after dynamic family naming has been resolved. */
  readonly apiName?: string
  /** Trailing ghost affordance (or beneath one): render dimmed/dashed. */
  readonly ghost?: true
  /** Materialized member of an Autogrow family; retains the growth-ring visual. */
  readonly familyMember?: true
  /**
   * Present when the port has synthetic (unpersisted) ancestors: any action
   * landing here must batch `dynamic.materialize` with these frames first.
   */
  readonly materialize?: readonly MaterializeFrame[]
  /** DynamicSlot choice metadata used by connect gestures and pin menus. */
  readonly dynamicSlot?: {
    readonly construct: string
    readonly variants: readonly { readonly key: string; readonly type: TypeExpr }[]
    readonly selected?: string
  }
  /** Inactive branch of a document-time selector; display-only. */
  readonly inactive?: true
  /**
   * A row no longer part of the node, kept only for the wire on its output
   * (ElaboratedInput.kept): drawn inactive, not editable, no new wire starts
   * or ends on it. The text says why.
   */
  readonly kept?: string
  /** Input that takes one value or a whole list (InputSpec.acceptsList), whatever its matched type. */
  readonly acceptsList?: true
  /** Derived source for the immediate enclosing region's iteration index. */
  readonly regionIndex?: true
}

export interface PortSlot extends DynamicAnnotations {
  readonly portId: string
  readonly label: string
  readonly type: TypeExpr
  readonly optional?: boolean
  readonly socketless?: true
  /** Output slot whose producer may deliberately emit no value. */
  readonly maybeAbsent?: true
}

/** The grip of a whole member of a group whose members can be put in another order. */
export interface MemberGrip {
  /** Group flattened id. */
  readonly construct: string
  /** The member's stored key. */
  readonly member: string
  /** Node-local x of the grip's center. */
  readonly gripX: number
  /** The group's only member: the grip is dimmed and does nothing. */
  readonly alone?: true
}

export type LayoutRow =
  | {
      readonly kind: 'ports'
      readonly y: number
      readonly height: number
      /** How far both names move in, for the boxes around the row. Pins stay on the node's edge. */
      readonly nameInset?: number
      readonly input?: PortSlot
      readonly output?: PortSlot & { readonly index: number }
      /**
       * The row is a whole member of a group that grows by hand: a remove
       * cross ends it, its right edge this far from the node's right edge.
       */
      readonly crossInset?: number
      /** The row is a whole member that can be moved: its grip. */
      readonly reorder?: MemberGrip
    }
  | ({
      readonly kind: 'widget'
      readonly y: number
      readonly height: number
      /** Left clearance from the node origin to widget chrome. */
      readonly inset: number
      /** Explicit cell width for widgets sharing a horizontal line, or beside a remove cross. */
      readonly width?: number
      /** An editor shown in the node is unfolded under this row (its caret points down). */
      readonly unfolded?: true
      /**
       * The row is a whole member of a group that grows by hand: a remove
       * cross ends it, its right edge this far from the node's right edge.
       */
      readonly crossInset?: number
      /** The row is a whole member that can be moved: its grip. */
      readonly reorder?: MemberGrip
      readonly inputId: string
      /**
       * The node.values key this widget's value lives under (valueKeyOf):
       * raw port id for top-level statics, elaborated id for dynamics.
       * Renderers/editors read and write THIS, never inputId.
       */
      readonly valueKey: string
      readonly label: string
      readonly type: TypeExpr
      readonly viewId: string
      readonly rows: number
      /** The schema widget spec, so painters are self-contained. */
      readonly spec: WidgetSpec
      /** Keep the editor and outgoing value tap without an incoming socket. */
      readonly socketless?: true
      /** Wire-22 execution binding retained from the elaborated input. */
      readonly sourceFilename?: SourceFilenameSpec
      /** Effective named representation selected for this row (wire 17). */
      readonly representationId?: string
      /** Effective controller mode. Absent document state defaults to randomize. */
      readonly controllerMode?: 'fixed' | 'increment' | 'decrement' | 'randomize'
      /**
       * Inside a subgraph: this field is on the subgraph node without a wire
       * (BoundaryItem.wireHidden, or a value source shown as a field). Names
       * the boundary input it became and that input's name on the subgraph
       * node; painted as the cyan subgraph icon before the field's name.
       */
      readonly subgraphMark?: { readonly item: string; readonly label: string }
      readonly optional?: boolean
      /**
       * Value not stored in node.values (DynamicCombo selector: the selected
       * option key). Renderers/editors read this instead of values.
       */
      readonly derivedValue?: Json
      /** Structural menu state coordinate, independent of the selected value. */
      readonly optionsTarget?: {
        readonly construct: string
        readonly owner?: DynamicEditOwner
        readonly materialize?: readonly MaterializeFrame[]
      }
      /**
       * Set for a DynamicCombo selector row: edits dispatch
       * dynamic.selectOption with these params, never node.setValue.
       */
      readonly selector?: {
        readonly construct: string
      }
      /** A choice's dropdown: it reaches the outline of the box its option rows hang in, and has its own outline. */
      readonly lead?: true
      /** Instance whose promoted boundary input owns this row's stored value. */
      readonly familyOwner?: {
        readonly graphId: string
        readonly nodeId: string
        readonly construct: string
        readonly valueKey: string
      }
      /** The rows its widget's `writes` and `reads` name (flattened ids). */
      readonly parts?: WidgetParts
      /**
       * An editor row: a widget with no value of its own. It has no label and
       * no pin; `inputId` and `valueKey` are its layout id, which stores nothing.
       */
      readonly editor?: true
      /**
       * Set for an Inputs panel field whose value is a value source's own
       * value: edits dispatch valueSource.setValue and
       * valueSource.setController, never node.setValue.
       */
      readonly valueSourceOwner?: { readonly graphId: string; readonly valueSourceId: string }
    } & DynamicAnnotations)
  | {
      /**
       * The space an unfolded editor takes in the node, under the whole line
       * of its editor button row. The canvas paints its panel; the editor's
       * own controls are laid over it by the host.
       */
      readonly kind: 'editorSpace'
      readonly y: number
      /** With the band under the editor's outline, `fieldInsetY` high, that its controls leave free. */
      readonly height: number
      /** The editor row's left edge; the space is as wide as that row. */
      readonly inset: number
      /** The editor row's width when it is narrower than the node less both insets. */
      readonly width?: number
      /** How far above the space its editor row starts: the row and the space are one box. */
      readonly rowAbove: number
      readonly inputId: string
      readonly valueKey: string
      readonly viewId: string
      /** The picture's top and height within the space; absent for an editor without one. */
      readonly picture?: { readonly top: number; readonly height: number }
      /** The editor's own sections that are open, by section id. */
      readonly openSections?: readonly string[]
      /** The editor's input named by its `wiredLine` has a wire, and the editor has a row for it. */
      readonly wiredLine?: true
    }
  | {
      /**
       * Grow-family affordance (ElaboratedGrowth): a nested-only autogrow
       * template whose trailing ghost renders no pins/widgets. Click
       * dispatches dynamic.materialize with `frames`; no pin, never wired.
       */
      readonly kind: 'growth'
      readonly y: number
      readonly height: number
      /** Distance of the add control from the node's left edge: as wide as a member's box. */
      readonly inset: number
      /** Family construct value key (diagnostic/test identity). */
      readonly construct: string
      readonly label: string
      readonly frames: readonly MaterializeFrame[]
    }
  | {
      /** A note (ElaboratedNote): read-only text, inert to hit-testing. */
      readonly kind: 'note'
      readonly y: number
      readonly height: number
      /** Distance of the row's box from the node's left edge. */
      readonly inset: number
      /** Box width when the row shares its line; else the node's width less both insets. */
      readonly width?: number
      readonly noteId: string
      readonly text: string
      /** The text is the note's "while unknown" answer. */
      readonly unknown?: true
    }
  | {
      /** A button (ElaboratedButton): drawn and inert; its steps never run here. */
      readonly kind: 'button'
      readonly y: number
      readonly height: number
      readonly inset: number
      readonly width?: number
      readonly buttonId: string
      readonly label: string
      /** The button's `enabled` worked out to false: drawn faded. */
      readonly enabled?: false
    }
  | {
      /**
       * Read-only stored-value row on a node whose schema is unavailable
       * (missing/unresolved type). Shows the document's `node.values` entry
       * so the node stays recognizable; never editable (no spec to trust),
       * inert to hit-testing (body behavior).
       */
      readonly kind: 'fallback'
      readonly y: number
      readonly height: number
      /** The node.values key. */
      readonly label: string
      /** Safe single-line rendering of the stored JSON value. */
      readonly text: string
    }
  | {
      /**
       * The row that opens and closes a section's or a group's box: its
       * header while open, the whole box while closed, or the tab on the top
       * edge of an open box that shows no name.
       */
      readonly kind: 'section'
      readonly y: number
      readonly height: number
      /** The box's key: a section's flattened id, or `group:<id>`; keys the saved open state. */
      readonly sectionId: string
      readonly box: 'section' | 'group'
      readonly label: string
      /** Effective state: view override if present, else collapsedByDefault. */
      readonly collapsed: boolean
      /** An open box that shows no name: the row is the tab strip above its rows. */
      readonly tab?: true
      /** Distance of the box's outline from the node's left edge. */
      readonly inset: number
      /** Top of the header or the closed row, node-local; its name is centered below it. */
      readonly top: number
      /** How many rows a section holds, or how many members a group shows. */
      readonly count: number
      /** A group that declares a maximum: that maximum, shown after its count. */
      readonly maxCount?: number
      /**
       * Count of MODIFIED widget values this box hides while collapsed
       * (derived via resettableWidgetsOf, never stored). Present only when
       * collapsed and > 0; expanded boxes show the widgets themselves.
       */
      readonly hiddenModified?: number
      /**
       * Every port a closed box hides, in declared order, connected or not:
       * a wire dropped on the closed row takes the first that fits.
       */
      readonly hiddenPorts?: readonly HiddenPort[]
    }
  | {
      /** The header of a group member's own box: its label and a remove cross. */
      readonly kind: 'member'
      readonly y: number
      readonly height: number
      /** Group flattened id. */
      readonly construct: string
      /** Box key, `member:<group>.<key>`. */
      readonly memberId: string
      readonly label: string
      readonly ordinal: number
      readonly ghost?: true
      readonly inset: number
      readonly top: number
      /** The member can be moved: its grip in the header. */
      readonly reorder?: MemberGrip
    }

/** A port inside a closed box: a pin once a wire reaches it. */
export type HiddenPort = Omit<PinLayout, 'y'>

export interface PinLayout extends DynamicAnnotations {
  readonly portId: string
  /** Human-readable port label retained when rows are hidden. */
  readonly label?: string
  readonly direction: 'in' | 'out'
  /** Center y, node-local. */
  readonly y: number
  readonly type: TypeExpr
  /** Declared match identity retained after the displayed type resolves. */
  readonly matchVariable?: string
  /** Declared finite match constraint, including list/asset wrappers, retained after inference. */
  readonly matchConstraint?: TypeExpr
  /** The displayed type came from graph inference rather than a fixed declaration. */
  readonly inferred?: true
  /** Input belongs to a widget row rather than a forced socket row. */
  readonly widgetBacked?: true
  /** A field's output: the value the field's node runs with. */
  readonly widgetTap?: true
  /** Optional input (InputSpec.optional): renders as a donut, not a filled dot. */
  readonly optional?: true
  /** Output pin whose producer may deliberately emit no value (OutputSpec.optional). */
  readonly maybeAbsent?: true
  /**
   * Present when this pin stands on a closed box's row for a port inside
   * it; the pins of one side press together around the row's middle.
   */
  readonly collapsedSection?: string
  /** A wire's end under the last drawn pin of a full closed-box cluster: not drawn and not grabbed. */
  readonly stacked?: true
  /** Pin belongs to a minimized node and is represented by an aggregate side proxy. */
  readonly minimized?: true
}

/** One box's outline, node-local. */
export interface LayoutBox {
  /** Box key: a section's flattened id, `group:`, `member:` or `option:` and the flattened id. */
  readonly id: string
  readonly kind: 'section' | 'group' | 'member' | 'option'
  /** 1 for a box in no other box. */
  readonly depth: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** A closed box is its closed row. */
  readonly closed?: true
  /** An open box that shows no name. */
  readonly tab?: true
  /** Indexes of the box's first and last rows, so a reflow can move the box with them. */
  readonly first: number
  readonly last: number
}

export interface NodeLayout {
  readonly width: number
  readonly height: number
  /** Resize floor: manual sizes clamp here (rows never compress). */
  readonly minWidth: number
  readonly minHeight: number
  /** Difference between visible height and the persisted expanded-view request. */
  readonly resizeHeightOffset?: number
  /** The manual size stored in view state, when the user resized the node. */
  readonly sizeOverride?: { readonly width: number; readonly height: number }
  readonly headerHeight: number
  readonly title: string
  /** Quieter text after the title of a subgraph's Inputs panel ("of Soften", "defaults"). */
  readonly subtitle?: string
  /** True only when an override differs from the schema/fallback display name. */
  readonly titleRenamed?: boolean
  /** The declared title suffix, drawn dim after the title; never counted in the width. */
  readonly titleSuffix?: string
  readonly rows: readonly LayoutRow[]
  readonly pins: readonly PinLayout[]
  /** Body rows are hidden while title, compact preview, and endpoint anchors remain visible. */
  readonly minimized?: true
  /** On a minimized node: the preview region's height on the open node, which a caption-opened preview takes. */
  readonly openPreviewHeight?: number
  /** Boxes drawn around rows, outer boxes before the boxes inside them. */
  readonly boxes?: readonly LayoutBox[]
  /**
   * Optional imagery area appended inside the node body after all rows: the
   * "Preview" caption row on top, then the picture.
   */
  readonly preview?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    /** Only the caption row: no picture yet, or a folded preview. */
    readonly compact?: true
    /** A preview with a picture, folded to its caption row, which opens it again. */
    readonly folded?: true
  }
  /** Optional recorded string result appended inside the body after all rows, under its caption row. */
  readonly textOutput?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    /** Folded to its caption row, which opens it again. */
    readonly folded?: true
  }
}

/** Offset from a node's left edge to its title, past the minimize arrow's target. */
export const TITLE_START: number = canvasPaintTokens.node.minimizeArrow.left + canvasPaintTokens.node.minimizeArrow.target

/** Where one stored member of a group that can be reordered lies, node-local. */
export interface MemberSpan {
  readonly member: string
  readonly top: number
  readonly bottom: number
  /** The span's left edge and width: its member box, or its row's field. */
  readonly x: number
  readonly width: number
}

/** The stored members of a group that can be reordered, top to bottom, as the node shows them. */
export function memberSpans(layout: NodeLayout, construct: string): MemberSpan[] {
  const box = canvasPaintTokens.node.box
  const group = layout.boxes?.find((candidate) => candidate.id === groupBoxKey(construct))
  const spans: MemberSpan[] = []
  for (const row of layout.rows) {
    if ((row.kind !== 'member' && row.kind !== 'widget' && row.kind !== 'ports') || row.reorder?.construct !== construct) continue
    const own = row.kind === 'member' ? layout.boxes?.find((candidate) => candidate.id === row.memberId) : undefined
    const x = own?.x ?? (row.kind === 'widget' ? row.inset : (group?.x ?? 0) + box.stroke + box.fieldGap)
    // One span per member, however many rows it draws.
    const last = spans.at(-1)
    if (last?.member === row.reorder.member) {
      spans[spans.length - 1] = { ...last, bottom: own === undefined ? row.y + row.height : own.y + own.height }
      continue
    }
    spans.push({
      member: row.reorder.member,
      top: own?.y ?? row.y,
      bottom: own === undefined ? row.y + row.height : own.y + own.height,
      x,
      width: own?.width ?? layout.width - x * 2,
    })
  }
  return spans
}

/** The innermost member that can be moved under node-local `y`, with its place in its group. */
export function memberAt(layout: NodeLayout, y: number): { construct: string; member: string; index: number; count: number } | undefined {
  let best: { construct: string; member: string; index: number; count: number; height: number } | undefined
  const constructs = new Set(layout.rows.flatMap((row) =>
    (row.kind === 'member' || row.kind === 'widget' || row.kind === 'ports') && row.reorder !== undefined ? [row.reorder.construct] : []))
  for (const construct of constructs) {
    const spans = memberSpans(layout, construct)
    for (const [index, span] of spans.entries()) {
      const height = span.bottom - span.top
      if (y >= span.top && y < span.bottom && (best === undefined || height < best.height))
        best = { construct, member: span.member, index, count: spans.length, height }
    }
  }
  if (best === undefined) return undefined
  const { height: _height, ...found } = best
  return found
}

/** Shared visible bounds for registry widget chrome and its overlay states. */
export function widgetChromeRect(x: number, rowY: number, width: number, rowHeight: number, insetY: number): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
} {
  const paint = canvasPaintTokens.widget
  return { x, y: rowY + insetY, width, height: rowHeight - insetY * 2, radius: paint.radius }
}

/** Floating label band plus padded multiline content rows. */
export function multilineWidgetHeight(rows: number, tokens: DesignTokens): number {
  // The content budget lives inside widgetChromeRect's top/bottom inset.
  return tokens.rowGeometry.fieldInsetY * 2 + tokens.multilineText.labelHeight +
    rows * tokens.multilineText.lineHeight + tokens.multilineText.padding * 2
}

const previewPanelMinHeight = (tokens: DesignTokens): number =>
  tokens.previewMinHeight + tokens.previewCaptionHeight

const previewPanelDefaultHeight = (tokens: DesignTokens): number =>
  tokens.previewDefaultHeight + tokens.previewCaptionHeight

/** A text box the user sizes stays within its line limits. */
export const clampTextBoxLines = (lines: number): number => Math.min(
  canvasPaintTokens.widget.textBoxEdge.maxLines,
  Math.max(canvasPaintTokens.widget.textBoxEdge.minLines, Math.round(lines)),
)

const isTextBoxRow = (row: LayoutRow): row is Extract<LayoutRow, { kind: 'widget' }> =>
  row.kind === 'widget' && row.viewId === 'core.text'

/**
 * Indexes of the rows the node's own bottom edge sizes. A node with a
 * preview gives that height to the preview, so none of its text boxes take
 * it; otherwise only the last text box does. Every other text box keeps the
 * height it was given in lines.
 */
const flexibleTextRowIndexes = (layout: NodeLayout): number[] => {
  if (layout.preview !== undefined) return []
  let last = -1
  const lines = new Set<number>()
  for (const [index, row] of layout.rows.entries()) {
    if (!isTextBoxRow(row) || row.inactive || lines.has(row.y)) continue
    lines.add(row.y)
    last = index
  }
  return last < 0 ? [] : [last]
}

const flexibleLineHeight = (layout: NodeLayout, row: LayoutRow, tokens: DesignTokens): number =>
  Math.max(...layout.rows.filter((sibling) => sibling.y === row.y).map((sibling) =>
    isTextBoxRow(sibling) ? multilineWidgetHeight(sibling.rows, tokens) : sibling.height))

/** Reflow text boxes back to their own heights, without any resize surplus. */
const ownHeightRows = (layout: NodeLayout, tokens: DesignTokens): LayoutRow[] =>
  reflowRows(layout, (row) => isTextBoxRow(row) ? flexibleLineHeight(layout, row, tokens) : row.height)

const remappedPins = (layout: NodeLayout, rows: readonly LayoutRow[]): PinLayout[] =>
  layout.pins.map((pin) => {
    const rowIndex = layout.rows.findIndex((row) => pin.y >= row.y && pin.y < row.y + row.height)
    if (rowIndex < 0) return pin
    return { ...pin, y: rows[rowIndex]!.y + pin.y - layout.rows[rowIndex]!.y }
  })

/**
 * The layout after one text box takes `lines` lines, while every other row,
 * the preview, and the text output keep their heights. Used for the live
 * drag of a text box's bottom edge; the committed layout is the same.
 */
export function projectTextBoxLines(
  layout: NodeLayout,
  valueKey: string,
  lines: number,
  tokens: DesignTokens,
): NodeLayout {
  const index = layout.rows.findIndex((row) => isTextBoxRow(row) && row.valueKey === valueKey)
  if (index < 0) return layout
  const target = multilineWidgetHeight(lines, tokens)
  const reflowed = reflowRows(layout, (row, rowIndex) => rowIndex === index ? target : row.height)
  const row = reflowed[index] as Extract<LayoutRow, { kind: 'widget' }>
  const rows = reflowed.map((candidate, rowIndex) => rowIndex === index ? { ...row, rows: lines } : candidate)
  const bottom = (rs: readonly LayoutRow[]): number =>
    rs.reduce((max, candidate) => Math.max(max, candidate.y + candidate.height), layout.headerHeight)
  const delta = bottom(rows) - bottom(layout.rows)
  if (delta === 0 && row.rows === lines) return layout
  return {
    ...layout,
    height: layout.height + delta,
    // The node's own resize surplus on this box is replaced, not kept.
    minHeight: layout.minHeight + bottom(rows) - bottom(ownHeightRows(layout, tokens)),
    rows,
    pins: remappedPins(layout, rows),
    ...projectedBoxes(layout, rows),
    ...(layout.preview === undefined ? {} : { preview: { ...layout.preview, y: layout.preview.y + delta } }),
    ...(layout.textOutput === undefined ? {} : { textOutput: { ...layout.textOutput, y: layout.textOutput.y + delta } }),
  }
}

/** A dragged editor picture's height, in whole units within the editor space's bounds. */
export function clampPictureHeight(height: number): number {
  const space = canvasPaintTokens.node.editorSpace
  return Math.min(space.pictureMax, Math.max(space.pictureMin, Math.round(height)))
}

/**
 * The height an unfolded editor takes under its row, and its picture's place
 * within it. `pictureHeight` is the height the user dragged the picture to,
 * `controls` the host's measure of the controls' height, and `openSections`
 * the editor's own sections that are open.
 */
export function unfoldedEditorSpace(
  editor: (typeof IN_NODE_EDITORS)[string],
  tokens: DesignTokens,
  at: {
    readonly pictureHeight?: number
    readonly controls?: number
    readonly openSections?: readonly { readonly rows: number }[]
    readonly wiredLine?: boolean
  } = {},
): { readonly height: number; readonly picture?: { readonly top: number; readonly height: number } } {
  const space = canvasPaintTokens.node.editorSpace
  const pictureHeight = editor.picture === undefined ? undefined
    : at.pictureHeight !== undefined && Number.isFinite(at.pictureHeight) ? clampPictureHeight(at.pictureHeight)
    : editor.picture
  const controls = at.controls ??
    (editor.controlRows + (at.wiredLine === true ? 1 : 0) + (at.openSections ?? []).reduce((sum, section) => sum + section.rows, 0)) * tokens.rowHeight
  return {
    // The editor's outline stops `fieldInsetY` above the space's bottom, as
    // every row's box does; its controls fill the space above that.
    height: space.pad * 2 + controls + (pictureHeight === undefined ? 0 : pictureHeight + space.gap) + tokens.rowGeometry.fieldInsetY,
    ...(pictureHeight !== undefined ? { picture: { top: space.pad, height: pictureHeight } } : {}),
  }
}

/**
 * The layout after one unfolded editor's picture takes `height`, while every
 * other row, the preview, and the text output keep their heights. Used for
 * the live drag of a picture's bottom edge; the committed layout is the same.
 */
export function projectPictureHeight(layout: NodeLayout, valueKey: string, height: number): NodeLayout {
  const index = layout.rows.findIndex((row) => row.kind === 'editorSpace' && row.valueKey === valueKey)
  const space = layout.rows[index]
  if (space?.kind !== 'editorSpace' || space.picture === undefined) return layout
  const delta = clampPictureHeight(height) - space.picture.height
  if (delta === 0) return layout
  const reflowed = reflowRows(layout, (row, rowIndex) => rowIndex === index ? row.height + delta : row.height)
  const rows = reflowed.map((row, rowIndex) => rowIndex === index && row.kind === 'editorSpace' && row.picture !== undefined
    ? { ...row, picture: { ...row.picture, height: row.picture.height + delta } } : row)
  return {
    ...layout,
    height: layout.height + delta,
    minHeight: layout.minHeight + delta,
    rows,
    pins: remappedPins(layout, rows),
    ...projectedBoxes(layout, rows),
    ...(layout.preview === undefined ? {} : { preview: { ...layout.preview, y: layout.preview.y + delta } }),
    ...(layout.textOutput === undefined ? {} : { textOutput: { ...layout.textOutput, y: layout.textOutput.y + delta } }),
  }
}

/**
 * Reflow physical lines without separating widgets that share one line. The
 * space between lines, where a box's outline and padding sit, is kept.
 */
function reflowRows(layout: NodeLayout, heightOf: (row: LayoutRow, index: number) => number): LayoutRow[] {
  let sourceY = -1
  let sourceBottom = layout.headerHeight
  let lineY = layout.headerHeight
  let bottom = lineY
  let nextSourceBottom = sourceBottom
  return layout.rows.map((row, index) => {
    if (sourceY !== row.y) {
      sourceBottom = nextSourceBottom
      lineY = bottom + Math.max(0, row.y - sourceBottom)
      sourceY = row.y
    }
    const height = heightOf(row, index)
    nextSourceBottom = Math.max(nextSourceBottom, row.y + row.height)
    bottom = Math.max(bottom, lineY + height)
    return row.kind === 'section' || row.kind === 'member'
      ? { ...row, y: lineY, height, top: row.top + lineY - row.y }
      : { ...row, y: lineY, height }
  })
}

/** Move each box with its first and last rows after a reflow. */
const projectedBoxes = (
  layout: NodeLayout,
  rows: readonly LayoutRow[],
): Pick<NodeLayout, 'boxes'> => {
  if (layout.boxes === undefined) return {}
  return {
    boxes: layout.boxes.map((box) => {
      const first = layout.rows[box.first]!
      const last = layout.rows[box.last]!
      const top = box.y + rows[box.first]!.y - first.y
      const bottom = box.y + box.height + (rows[box.last]!.y + rows[box.last]!.height) - (last.y + last.height)
      return { ...box, y: top, height: bottom - top }
    }),
  }
}

/** Reserve the one-line preview surface available before execution. */
export function withCompactPreviewRegion(layout: NodeLayout, tokens: DesignTokens): NodeLayout {
  if (layout.preview !== undefined) return layout
  const compactHeight = tokens.previewCaptionHeight
  if (layout.minimized) {
    const height = layout.minHeight + tokens.previewGap + compactHeight
    return {
      ...layout,
      height,
      minHeight: height,
      preview: {
        x: tokens.padX,
        y: layout.headerHeight + tokens.previewGap,
        width: Math.max(0, layout.width - tokens.padX * 2),
        height: compactHeight,
        compact: true,
      },
    }
  }
  // The node's resize surplus is the preview's: its text boxes keep their
  // own heights, and the request opens the panel at that size later.
  const defaultHeight = previewPanelDefaultHeight(tokens)
  const baseHeight = boxedMinHeight(layout, tokens)
  const defaultActiveHeight = baseHeight + tokens.previewGap + defaultHeight
  const activeHeight = layout.height > layout.minHeight
    ? Math.max(baseHeight + tokens.previewGap + previewPanelMinHeight(tokens), layout.height)
    : defaultActiveHeight
  const bodyExtra = Math.max(0, activeHeight - defaultActiveHeight)
  const activePanelHeight = activeHeight - baseHeight - tokens.previewGap - bodyExtra
  const minHeight = baseHeight + tokens.previewGap + compactHeight
  const height = minHeight + bodyExtra
  const rows = ownHeightRows(layout, tokens)
  return {
    ...layout,
    height,
    minHeight,
    resizeHeightOffset: compactHeight - activePanelHeight,
    rows,
    pins: remappedPins(layout, rows),
    ...projectedBoxes(layout, rows),
    preview: {
      x: tokens.padX,
      y: height - tokens.padBottom - compactHeight,
      width: Math.max(0, layout.width - tokens.padX * 2),
      height: compactHeight,
      compact: true,
    },
  }
}

/** Fold a preview that has a picture to its caption row. */
export function withFoldedPreviewRegion(layout: NodeLayout, tokens: DesignTokens): NodeLayout {
  const compact = withCompactPreviewRegion(layout, tokens)
  return { ...compact, preview: { ...compact.preview!, folded: true } }
}

/**
 * Activate the in-body preview region while preserving the persisted total
 * size as a request. The preview takes all of the node's resize surplus;
 * text boxes keep their own heights.
 */
export function withPreviewRegion(layout: NodeLayout, tokens: DesignTokens): NodeLayout {
  if (layout.minimized) {
    // Opened by its caption, a minimized node's preview takes the height it
    // has on the open node.
    const compact = withCompactPreviewRegion(layout, tokens)
    const height = layout.openPreviewHeight ?? previewPanelDefaultHeight(tokens)
    const extra = height - compact.preview!.height
    const { compact: _compact, ...preview } = compact.preview!
    return { ...compact, height: compact.height + extra, minHeight: compact.minHeight + extra, preview: { ...preview, height } }
  }
  if (layout.preview?.compact === true) {
    const compactHeight = tokens.previewCaptionHeight
    const panelMinHeight = previewPanelMinHeight(tokens)
    const compactSurplus = Math.max(0, layout.height - layout.minHeight)
    const requestedPanelHeight = Math.max(panelMinHeight, compactHeight - (layout.resizeHeightOffset ?? 0))
    const { resizeHeightOffset: _resizeHeightOffset, ...base } = layout
    const { compact: _compact, ...preview } = layout.preview
    return {
      ...base,
      height: layout.height + requestedPanelHeight - compactHeight,
      minHeight: layout.minHeight + panelMinHeight - compactHeight,
      preview: {
        ...preview,
        y: preview.y - compactSurplus,
        height: requestedPanelHeight + compactSurplus,
      },
    }
  }
  if (layout.preview !== undefined) return layout
  const panelMinHeight = previewPanelMinHeight(tokens)
  const minHeight = boxedMinHeight(layout, tokens) + tokens.previewGap + panelMinHeight
  // A layout without manual-resize surplus carries no size request for the
  // panel: open it at the default height rather than the shrink floor.
  const height = layout.height > layout.minHeight
    ? Math.max(minHeight, layout.height)
    : boxedMinHeight(layout, tokens) + tokens.previewGap + previewPanelDefaultHeight(tokens)
  const rows = ownHeightRows(layout, tokens)
  const y = rows.reduce((bottom, row) => Math.max(bottom, row.y + row.height), layout.headerHeight)
  return {
    ...layout,
    height,
    minHeight,
    rows,
    pins: remappedPins(layout, rows),
    ...projectedBoxes(layout, rows),
    preview: {
      x: tokens.padX,
      y: y + tokens.previewGap,
      width: Math.max(0, layout.width - tokens.padX * 2),
      height: panelMinHeight + Math.max(0, height - minHeight),
    },
  }
}

/**
 * Activate the Standard-view string result region. Image previews use their
 * separate region and take precedence before this helper is called. Open, the
 * region takes the node's resize surplus in whole rows, at least
 * `textOutputMinRows`; without a size request it fits the result up to
 * `textOutputMaxRows`. Folded, it is only its caption row. Text boxes keep
 * their own heights.
 */
export function withTextOutputRegion(
  layout: NodeLayout,
  tokens: DesignTokens,
  lineCount: number = canvasPaintTokens.node.textOutputMaxRows,
  folded = false,
): NodeLayout {
  if (layout.textOutput !== undefined) return layout
  const { textOutputMinRows: minRows, textOutputMaxRows: maxRows } = canvasPaintTokens.node
  if (layout.minimized) {
    const regionHeight = tokens.previewCaptionHeight + (folded
      ? 0
      : tokens.rowHeight * Math.max(minRows, Math.min(maxRows, Math.trunc(lineCount))))
    const { preview, ...base } = withCompactPreviewRegion(layout, tokens)
    const extra = regionHeight - preview!.height
    return {
      ...base,
      height: base.height + extra,
      minHeight: base.minHeight + extra,
      textOutput: { x: preview!.x, y: preview!.y, width: preview!.width, height: regionHeight, ...(folded ? { folded: true as const } : {}) },
    }
  }
  const { preview: _preview, resizeHeightOffset: _resizeHeightOffset, ...open } = layout
  const captionBottom = boxedMinHeight(open, tokens) + tokens.previewGap + tokens.previewCaptionHeight
  const rowCount = folded
    ? 0
    : open.height > open.minHeight
      ? Math.max(minRows, Math.floor((open.height - captionBottom) / tokens.rowHeight))
      : Math.max(minRows, Math.min(maxRows, Math.trunc(lineCount)))
  const regionHeight = tokens.previewCaptionHeight + tokens.rowHeight * rowCount
  const rows = ownHeightRows(open, tokens)
  const y = rows.reduce((bottom, row) => Math.max(bottom, row.y + row.height), open.headerHeight)
  return {
    ...open,
    height: captionBottom + tokens.rowHeight * rowCount,
    minHeight: captionBottom + (folded ? 0 : tokens.rowHeight * minRows),
    rows,
    pins: remappedPins(open, rows),
    ...projectedBoxes(open, rows),
    textOutput: {
      x: tokens.padX,
      y: y + tokens.previewGap,
      width: Math.max(0, open.width - tokens.padX * 2),
      height: regionHeight,
      ...(folded ? { folded: true as const } : {}),
    },
  }
}

/**
 * Reflow the row the node's bottom edge sizes for an in-flight resize
 * preview. The scene remains committed; the renderer uses this projected
 * layout until the pointer gesture commits the same size through
 * view.setNodeSize.
 */
export function projectNodeLayoutHeight(
  layout: NodeLayout,
  requestedHeight: number,
  tokens: DesignTokens,
): NodeLayout {
  const height = Math.max(layout.minHeight, requestedHeight)
  if (height === layout.height) return layout
  const extra = Math.max(0, height - layout.minHeight)
  if (layout.preview?.compact === true) {
    return {
      ...layout,
      height,
      preview: {
        ...layout.preview,
        y: layout.minHeight - tokens.previewCaptionHeight - tokens.padBottom + extra,
        height: tokens.previewCaptionHeight,
      },
    }
  }
  if (layout.preview !== undefined) {
    return {
      ...layout,
      height,
      preview: {
        ...layout.preview,
        height: previewPanelMinHeight(tokens) + extra,
      },
    }
  }
  if (layout.textOutput !== undefined && layout.textOutput.folded !== true) {
    // An open text result takes the height in whole rows.
    const rowsTall = Math.floor(extra / tokens.rowHeight)
    return {
      ...layout,
      height: layout.minHeight + rowsTall * tokens.rowHeight,
      textOutput: {
        ...layout.textOutput,
        height: tokens.previewCaptionHeight + (canvasPaintTokens.node.textOutputMinRows + rowsTall) * tokens.rowHeight,
      },
    }
  }
  const flexibleIndexes = flexibleTextRowIndexes(layout)
  if (flexibleIndexes.length === 0) return { ...layout, height }
  const rows = reflowRows(layout, (row, index) => isTextBoxRow(row)
    ? flexibleLineHeight(layout, row, tokens) + (flexibleIndexes.includes(index) ? extra : 0)
    : row.height)
  const textOutput = layout.textOutput === undefined
    ? undefined
    : { ...layout.textOutput, y: rows.reduce((bottom, row) => Math.max(bottom, row.y + row.height), layout.headerHeight) + tokens.previewGap }
  return {
    ...layout,
    height,
    rows,
    pins: remappedPins(layout, rows),
    ...projectedBoxes(layout, rows),
    ...(textOutput === undefined ? {} : { textOutput }),
  }
}

/** Manual size override from view state (view.setNodeSize). */
export interface SizeOverride {
  readonly width: number
  readonly height: number
}

/** Key for LayoutOptions.connectedPorts ('in:image', 'out:LATENT'). */
export const connectedPortKey = (direction: 'in' | 'out', portId: string): string =>
  `${direction}:${portId}`

export interface LayoutOptions {
  /** Whether after-generate controller chips are exposed in layout. */
  readonly seedControllerEnabled?: boolean
  /** Manual size override from view state (view.setNodeSize). */
  readonly size?: SizeOverride
  /** Persisted minimized presentation state. */
  readonly minimized?: true
  /** Per-section collapse overrides from view state (view.setSectionCollapsed). */
  readonly sectionOverrides?: Readonly<Record<string, boolean>>
  /** Client-owned named widget representation selections by value key. */
  readonly widgetRepresentations?: Readonly<Record<string, string>>
  /** Height in lines of each text box the user sized, by value key (view.setTextBoxLines). */
  readonly textBoxLines?: Readonly<Record<string, number>>
  /** Per-editor fold overrides by value key (view.setEditorUnfolded). */
  readonly editorUnfolded?: Readonly<Record<string, boolean>>
  /** Editors start folded whatever their declaration says, as on the Inputs panel. */
  readonly editorsStartFolded?: true
  /** Height of each unfolded editor's picture the user dragged, by value key (view.setPictureHeight). */
  readonly pictureHeights?: Readonly<Record<string, number>>
  /**
   * Ports with a link/net attached, keyed by connectedPortKey over ELAB
   * KEYS. A CONNECTED port inside a collapsed section keeps a pin (anchored
   * on the section header row) so its noodle never dangles; unconnected
   * hidden ports lose their pins entirely.
   */
  readonly connectedPorts?: ReadonlySet<string>
  /**
   * The node's elaborated interface (scene supplies it, built with graph
   * connectivity and ghost promotion). When absent, layout elaborates from
   * the schema alone - identical for static schemas, but dynamic families
   * then see no connections.
   */
  readonly elaborated?: ElaboratedInterface
}

const displayLabel = (spec: InputSpec | OutputSpec): string => spec.displayName ?? spec.id

/** Pick just the DynamicAnnotations fields (pins copy them from their slot/row). */
const annotationsOf = (a: DynamicAnnotations): DynamicAnnotations => ({
  address: a.address,
  ...(a.apiName !== undefined ? { apiName: a.apiName } : {}),
  ...(a.ghost ? { ghost: true } : {}),
  ...(a.familyMember ? { familyMember: true } : {}),
  ...(a.materialize !== undefined ? { materialize: a.materialize } : {}),
  ...(a.dynamicSlot !== undefined ? { dynamicSlot: a.dynamicSlot } : {}),
  ...(a.inactive ? { inactive: true } : {}),
  ...(a.kept !== undefined ? { kept: a.kept } : {}),
  ...(a.acceptsList ? { acceptsList: true } : {}),
})

/**
 * Compute a node's layout from its elaborated interface. Pure.
 *
 * Boxes: a section, a group, a member of more than one row and the rows of
 * a choice's chosen option are drawn as boxes (NodeLayout.boxes). Each row
 * names the boxes around it (`item.boxes`); a row in a closed box is hidden.
 * A section's or group's open state is the view override when present, else
 * collapsedByDefault (a group starts open). A row naming an UNDECLARED box
 * renders normally (schema bug, not a rendering hole).
 */
export function layoutNode(
  schema: NodeSchema,
  node: NodeData,
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  options: LayoutOptions = {},
): NodeLayout {
  /** A box the elaborated interface declares. */
  interface BoxDecl {
    readonly id: string
    readonly kind: LayoutBox['kind']
    readonly label: string
    readonly closed: boolean
    readonly tab: boolean
    /** Keys of the declared boxes around this one, outermost first. */
    readonly parents: readonly string[]
    readonly members?: number
    readonly maxMembers?: number
    readonly construct?: string
    readonly ordinal?: number
    readonly ghost?: true
    readonly byHand?: true
    readonly reorderable?: true
    readonly member?: string
  }
  /** A whole member's grip before its place is known. */
  type PendingGrip = Omit<MemberGrip, 'gripX'>
  interface PendingRow {
    kind: 'ports' | 'widget' | 'section' | 'member' | 'growth' | 'note' | 'button' | 'editorSpace'
    /** Keys of the declared boxes around the row, outermost first. */
    boxes: readonly string[]
    input?: PortSlot
    output?: PortSlot & { index: number }
    removable?: true
    reorder?: PendingGrip
    /** The spare member of a group that can be reordered: room where a grip would stand, none drawn. */
    gripSpace?: true
    widget?: Extract<LayoutRow, { kind: 'widget' }> extends infer R
      ? Omit<R, 'kind' | 'y' | 'height' | 'inset'>
      : never
    header?: BoxDecl
    growth?: { construct: string; label: string; frames: readonly MaterializeFrame[] }
    note?: { noteId: string; text: string; unknown?: true }
    button?: { buttonId: string; label: string; enabled?: false }
    editorSpace?: Omit<Extract<LayoutRow, { kind: 'editorSpace' }>, 'kind' | 'y' | 'inset' | 'width' | 'rowAbove'>
  }
  /** A `Row` cell's text, which sets its share of the line's width. */
  const cellLabel = (row: PendingRow): string =>
    row.widget?.label ?? row.note?.text ?? row.button?.label ?? ''
  const pending: PendingRow[] = []
  const editorControlHeights = new Map<string, number>()
  const outputs: {
    slot: PortSlot & { index: number }
    boxes: readonly string[]
  }[] = []

  const elaborated = options.elaborated ?? elaborateInterface(schema, node)
  const items = elaborated.items
  const selectorDisplay = schema.selector === undefined
    ? undefined
    : selectorBranchDisplay(
        schema,
        node.values,
        selectorMembersOf(schema.selector, items.filter((item): item is ElaboratedInput => item.kind === 'input')),
      )
  const advancedSectionId = 'advanced'
  const box = canvasPaintTokens.node.box
  const verticalInset = tokens.rowGeometry.fieldInsetY
  const closedHeight = tokens.rowHeight - verticalInset * 2
  const headerHeight = closedHeight - box.headerShrink
  /**
   * Left edge of the outline of a box `depth` boxes deep. The outermost
   * outline's inner side is where a field outside any box starts, which
   * keeps it past the pins.
   */
  const outlineX = (depth: number): number =>
    tokens.rowGeometry.fieldInsetX - box.stroke + (depth - 1) * (box.stroke + box.step)
  /** Left edge of a field inside `depth` boxes. */
  const fieldInset = (depth: number): number =>
    depth === 0 ? tokens.rowGeometry.fieldInsetX : outlineX(depth) + box.stroke + box.fieldGap
  /**
   * A one-row member's remove cross stands as far inside its group's outline
   * as it stands from the field: its right edge's distance from the node's.
   */
  const crossInset = (depth: number): number => fieldInset(depth) - box.fieldGap + box.cross.fieldGap
  /** How far a pin row's names move in inside `depth` boxes. */
  const nameInset = (depth: number): number => depth * (box.stroke + box.step)

  // Declared boxes. A section's or group's open state: view override, else
  // its default; members and option boxes have no closed state.
  const decls = new Map<string, BoxDecl>()
  for (const item of items) {
    if (item.kind === 'section') {
      decls.set(item.spec.id, {
        id: item.spec.id,
        kind: 'section',
        label: item.spec.displayName ?? item.spec.id,
        closed: options.sectionOverrides?.[item.spec.id] ?? item.spec.collapsedByDefault ?? false,
        tab: item.spec.openName === false,
        parents: item.boxes ?? (item.section !== undefined ? [item.section] : []),
      })
    } else if (item.kind === 'box') {
      decls.set(item.id, {
        id: item.id,
        kind: item.box,
        label: item.label,
        closed: item.box === 'group' && (options.sectionOverrides?.[item.id] ?? false),
        tab: item.box === 'group' && item.openName === false,
        parents: item.boxes ?? [],
        construct: item.construct,
        ...(item.members !== undefined ? { members: item.members } : {}),
        ...(item.maxMembers !== undefined ? { maxMembers: item.maxMembers } : {}),
        ...(item.ordinal !== undefined ? { ordinal: item.ordinal } : {}),
        ...(item.ghost ? { ghost: true as const } : {}),
        ...(item.byHand ? { byHand: true as const } : {}),
        ...(item.reorderable ? { reorderable: true as const } : {}),
        ...(item.member !== undefined ? { member: item.member } : {}),
      })
    }
  }
  const declared = (chain: readonly string[]): readonly string[] => chain.filter((id) => decls.has(id))
  const chainOf = (item: ElaboratedItem): readonly string[] => {
    if (item.kind === 'input' || item.kind === 'output') {
      return declared(item.boxes ?? (item.spec.section !== undefined ? [item.spec.section] : []))
    }
    if (item.kind === 'note' || item.kind === 'button' || item.kind === 'growth' || item.kind === 'editor') {
      return declared(item.boxes ?? (item.section !== undefined ? [item.section] : []))
    }
    return []
  }
  /** The outermost closed box of a chain: a hidden row's pins gather on its closed row. */
  const closedAt = (chain: readonly string[]): string | undefined =>
    options.minimized === true ? undefined : chain.find((id) => decls.get(id)!.closed)
  const isHidden = (chain: readonly string[]): boolean => closedAt(chain) !== undefined
  /** A row that is a whole member of a group growing by hand, with no member box of its own. */
  const removable = (item: ElaboratedInput, chain: readonly string[]): boolean =>
    tokens.memberRemoveCross && item.origin.kind === 'member' && chain.at(-1) === groupBoxKey(item.origin.construct) &&
    decls.get(chain.at(-1)!)!.byHand === true
  /** A stored member of a group that can be reordered, from its group's declaration. */
  const gripOf = (construct: string, member: string): PendingGrip | undefined => {
    const group = decls.get(groupBoxKey(construct))
    if (group?.reorderable !== true) return undefined
    // Only stored members move: offered ones the group shows to reach its least count do not.
    const stored = node.dynamic?.[construct]?.members?.length ?? 0
    return { construct, member, ...(stored === 1 ? { alone: true as const } : {}) }
  }
  /** A row that is a whole stored member, with no member box of its own. */
  const rowGrip = (item: ElaboratedInput, chain: readonly string[]): PendingGrip | undefined =>
    item.origin.kind === 'member' && item.origin.ghost !== true && chain.at(-1) === groupBoxKey(item.origin.construct)
      ? gripOf(item.origin.construct, item.origin.key)
      : undefined
  const withGrip = (grip: PendingGrip | undefined): { reorder?: PendingGrip } => grip === undefined ? {} : { reorder: grip }
  const spareGrip = (item: ElaboratedInput, chain: readonly string[]): { gripSpace?: true } =>
    item.origin.kind === 'member' && item.origin.ghost === true && chain.at(-1) === groupBoxKey(item.origin.construct) &&
      decls.get(groupBoxKey(item.origin.construct))?.reorderable === true
      ? { gripSpace: true }
      : {}
  const chainKey = (chain: readonly string[]): string => chain.join('\n')

  // Modified widget values hidden by each closed box (derived, never
  // stored): the closed row shows a dot so tuned values in a loaded
  // workflow are discoverable without opening everything.
  const hiddenModified = new Map<string, number>()
  if ([...decls.values()].some((decl) => decl.closed)) {
    for (const r of resettableWidgetsOf(elaborated, node.values)) {
      const at = closedAt(chainOf(r.item))
      if (r.modified && at !== undefined) hiddenModified.set(at, (hiddenModified.get(at) ?? 0) + 1)
    }
  }

  const isConnected = (direction: 'in' | 'out', portId: string): boolean =>
    options.connectedPorts?.has(connectedPortKey(direction, portId)) ?? false

  /** Ghost/address/materialize annotations shared by every emitted shape. */
  const annotate = (item: ElaboratedInput | ElaboratedOutput): DynamicAnnotations => {
    const ghost =
      (item.origin.kind === 'member' && item.origin.ghost === true) ||
      item.ancestry?.some((a) => a.ghost) === true
    const frames = materializeFramesOf(items, item)
    const dynamicSlot = item.origin.kind === 'slot' && item.origin.variants !== undefined
      ? {
          construct: item.origin.construct,
          variants: item.origin.variants,
          ...(item.origin.selected !== undefined ? { selected: item.origin.selected } : {}),
        }
      : undefined
    return {
      address: item.address,
      ...(item.kind === 'input' && item.apiName !== undefined ? { apiName: item.apiName } : {}),
      ...(ghost ? { ghost: true } : {}),
      ...(item.origin.kind === 'member' || (item.ancestry?.length ?? 0) > 0 ? { familyMember: true } : {}),
      ...(frames !== undefined ? { materialize: frames } : {}),
      ...(dynamicSlot !== undefined ? { dynamicSlot } : {}),
      ...(selectorDisplay?.[item.address.port] === 'inactive' || (item.kind === 'input' && item.kept !== undefined) ? { inactive: true } : {}),
      ...(item.kind === 'input' && item.kept !== undefined ? { kept: item.kept } : {}),
      ...(item.kind === 'input' && item.spec.acceptsList ? { acceptsList: true } : {}),
    }
  }

  // Ports hidden by a closed box whose pins the open box shows at rest:
  // they gather on its closed row.
  const collapsedPins: ({ sectionId: string; portId: string; label: string; direction: 'in' | 'out'; type: TypeExpr; connected: boolean; optional?: true; maybeAbsent?: true; widgetTap?: true } & DynamicAnnotations)[] = []
  const hiddenPorts = new Map<string, HiddenPort[]>()
  const hidePort = (at: string, port: HiddenPort): void => {
    hiddenPorts.set(at, [...(hiddenPorts.get(at) ?? []), port])
  }
  /** Rows each box holds directly, a box inside it counting as one: the closed row's count. */
  const held = new Map<string, number>()
  const hold = (chain: readonly string[]): void => {
    const parent = chain.at(-1)
    if (parent !== undefined) held.set(parent, (held.get(parent) ?? 0) + 1)
  }
  const portsHeld = new Map<string, { inputs: number; outputs: number }>()
  const holdPort = (chain: readonly string[], side: 'inputs' | 'outputs'): void => {
    const parent = chain.at(-1)
    if (parent === undefined) return
    const counts = portsHeld.get(parent) ?? { inputs: 0, outputs: 0 }
    counts[side] += 1
    portsHeld.set(parent, counts)
  }

  let outputIndex = 0
  /** Top-level boxes that hold a row other than an output. */
  const holdsMoreThanOutputs = new Set<string>()
  for (const item of items) {
    if (item.kind === 'section' || item.kind === 'box') {
      const decl = decls.get(item.kind === 'section' ? item.spec.id : item.id)!
      hold(decl.parents)
      // An option's rows hang under the dropdown that picks it: no header.
      if (decl.kind === 'option') continue
      if (isHidden(decl.parents)) continue
      pending.push({ kind: decl.kind === 'member' ? 'member' : 'section', boxes: decl.parents, header: decl })
      continue
    }
    const chain = chainOf(item)
    if (chain.length > 0 && item.kind !== 'output' && !(item.kind === 'input' && item.spec.hidden === true))
      holdsMoreThanOutputs.add(chain[0]!)
    if (item.kind === 'growth') {
      // Grow-family affordance: hides with its box like the family's own
      // rows would; no pin, so a closed box needs no anchor.
      hold(chain)
      if (isHidden(chain)) continue
      pending.push({
        kind: 'growth',
        boxes: chain,
        growth: { construct: item.construct, label: item.label, frames: item.frames },
      })
      continue
    }
    if (item.kind === 'editor') {
      hold(chain)
      if (isHidden(chain)) continue
      const measured = widgetMeasure(item.widget) ?? { viewId: 'core.unknown', rows: 1 }
      // The compact view shows the one row the editor writes, when it writes exactly one.
      const written = Object.values(item.parts.writes)
      const shown = written.length === 1 ? node.values[written[0]!] : undefined
      const ghost = (item.origin.kind === 'member' && item.origin.ghost === true) || item.ancestry?.some((a) => a.ghost) === true
      pending.push({
        kind: 'widget',
        boxes: chain,
        widget: {
          inputId: item.id,
          valueKey: item.id,
          label: '',
          type: { kind: 'wildcard' },
          viewId: measured.viewId,
          rows: Number.isFinite(measured.rows) ? Math.max(1, Math.floor(measured.rows)) : 1,
          spec: item.widget,
          socketless: true,
          ...(shown !== undefined ? { derivedValue: shown } : {}),
          parts: item.parts,
          editor: true,
          address: { port: item.id },
          ...(ghost ? { ghost: true } : {}),
          ...(item.origin.kind === 'member' || (item.ancestry?.length ?? 0) > 0 ? { familyMember: true } : {}),
          ...(item.materialize !== undefined ? { materialize: item.materialize } : {}),
        },
        })
        continue
      }
    if (item.kind === 'note' || item.kind === 'button') {
      if (item.adjacentTo === undefined) hold(chain)
      if (isHidden(chain)) continue
      pending.push({
        kind: item.kind,
        boxes: chain,
        ...(item.kind === 'note'
          ? { note: { noteId: item.id, text: item.text, ...(item.unknown ? { unknown: true as const } : {}) } }
          : { button: { buttonId: item.id, label: item.label, ...(item.enabled === false ? { enabled: false as const } : {}) } }),
      })
      continue
    }
    if (item.kind === 'output') {
      const spec = item.spec
      if (spec.hidden === true) continue
      holdPort(chain, 'outputs')
      if (isHidden(chain)) {
        hidePort(closedAt(chain)!, {
          ...annotate(item), portId: spec.id, label: displayLabel(spec), direction: 'out', type: spec.type,
          ...(spec.optional ? { maybeAbsent: true as const } : {}),
        })
        collapsedPins.push({
          sectionId: closedAt(chain)!, portId: spec.id, label: displayLabel(spec), direction: 'out', type: spec.type,
          connected: isConnected('out', spec.id), ...(spec.optional ? { maybeAbsent: true as const } : {}), ...annotate(item),
        })
        continue
      }
      outputs.push({
        boxes: chain,
        slot: {
          portId: spec.id,
          label: displayLabel(spec),
          type: spec.type,
          index: outputIndex++,
          ...(spec.optional ? { maybeAbsent: true as const } : {}),
          ...annotate(item),
        },
      })
      continue
    }
    // input
    const spec = item.spec
    if (spec.hidden === true) continue
    const widget = spec.widget
    const asSocket = !widget || spec.forceInput
    if (asSocket) holdPort(chain, 'inputs')
    else if (spec.adjacentTo === undefined) hold(chain)
    if (isHidden(chain)) {
      const at = closedAt(chain)!
      if (!spec.socketless) {
        hidePort(at, {
          ...annotate(item), portId: spec.id, label: displayLabel(spec), direction: 'in', type: spec.type,
          ...(spec.optional ? { optional: true as const } : {}),
          ...(widget && !spec.forceInput ? { widgetBacked: true as const } : {}),
        })
      }
      // A field's input pin shows at rest only while wired; a socket's always.
      const inputWired = isConnected('in', spec.id)
      if (!spec.socketless && (asSocket || inputWired)) {
        collapsedPins.push({
          sectionId: at, portId: spec.id, label: displayLabel(spec), direction: 'in', type: spec.type, connected: inputWired,
          ...(spec.optional ? { optional: true as const } : {}), ...annotate(item),
        })
      }
      // A connected widget tap (the producer affordance of a widget input)
      // keeps its anchor too - otherwise closing the box silently drops the
      // outgoing noodle from the scene.
      if (widget && !spec.forceInput && isConnected('out', spec.id)) {
        collapsedPins.push({
          sectionId: at, portId: spec.id, label: displayLabel(spec), direction: 'out', type: spec.type, connected: true, widgetTap: true,
          ...annotate(item),
        })
      }
      continue
    }
    if (asSocket) {
      pending.push({
        kind: 'ports',
        boxes: chain,
        input: {
          portId: spec.id,
          label: displayLabel(spec),
          type: spec.type,
          ...(spec.socketless ? { socketless: true as const } : {}),
          ...(spec.optional ? { optional: true } : {}),
          ...annotate(item),
        },
        ...(removable(item, chain) ? { removable: true as const } : {}),
        ...withGrip(rowGrip(item, chain)),
        ...spareGrip(item, chain),
      })
      continue
    }
    const valueKey = valueKeyOf(item)
    const representation = resolveWidgetRepresentation(
      widget,
      options.widgetRepresentations?.[valueKey],
    )
    const { editorControls, ...measured } = widgetMeasure(representation.spec) ?? { viewId: 'core.unknown', rows: 1 }
    if (editorControls !== undefined && Number.isFinite(editorControls)) editorControlHeights.set(valueKey, Math.max(0, editorControls))
    // Widget measures are host-supplied: a zero, negative, fractional, or
    // non-finite row count would fold rows onto each other and poison every
    // downstream y coordinate. Normalize to a positive whole number of rows.
    // A text box the user sized keeps that height in lines.
    const storedLines = measured.viewId === 'core.text' ? options.textBoxLines?.[valueKey] : undefined
    const w = {
      ...measured,
      rows: storedLines !== undefined && Number.isFinite(storedLines)
        ? clampTextBoxLines(storedLines)
        : Number.isFinite(measured.rows) ? Math.max(1, Math.floor(measured.rows)) : 1,
    }
    const selector = item.origin.kind === 'selector' ? { construct: item.origin.construct } : undefined
    pending.push({
      kind: 'widget',
      boxes: chain,
      ...(removable(item, chain) ? { removable: true as const } : {}),
      ...withGrip(rowGrip(item, chain)),
      ...spareGrip(item, chain),
      widget: {
        inputId: spec.id,
        valueKey,
        label: displayLabel(spec),
        type: spec.type,
        viewId: w.viewId,
        rows: w.rows,
        spec: representation.spec,
        ...(spec.socketless ? { socketless: true as const } : {}),
        ...(spec.sourceFilename !== undefined ? { sourceFilename: spec.sourceFilename } : {}),
        ...(representation.id !== undefined ? { representationId: representation.id } : {}),
        ...(options.seedControllerEnabled !== false && representation.spec.controller !== undefined
          ? { controllerMode: node.controllers?.[valueKey] ?? representation.spec.controllerInitial ?? 'randomize' as const }
          : {}),
        ...(spec.optional ? { optional: true } : {}),
        ...(item.derivedValue !== undefined ? { derivedValue: item.derivedValue } : {}),
        // A menu's state lives under its flattened id, members included.
        ...(representation.spec.editableOptions === true ? { optionsTarget: { construct: item.address.port } } : {}),
        ...(selector !== undefined ? { selector, lead: true as const } : {}),
        ...(item.parts !== undefined ? { parts: item.parts } : {}),
        ...annotate(item),
      },
    })
  }
  for (const [id, counts] of portsHeld) held.set(id, (held.get(id) ?? 0) + Math.max(counts.inputs, counts.outputs))

  // Pair outputs into the pin rows of the same box top-down, in the order
  // written. An output never pairs into a row of another box, so it is
  // drawn inside the box that holds it.
  const outputsByBox = new Map<string, typeof outputs>()
  for (const output of outputs) {
    const key = chainKey(output.boxes)
    outputsByBox.set(key, [...(outputsByBox.get(key) ?? []), output])
  }
  for (const [key, list] of outputsByBox) {
    let next = 0
    for (const row of pending) {
      if (next >= list.length) break
      if (row.kind === 'ports' && row.output === undefined && chainKey(row.boxes) === key) row.output = list[next++]!.slot
    }
    const rest = list.slice(next)
    if (rest.length === 0) continue
    const chain = rest[0]!.boxes
    const extra = rest.map((output): PendingRow => ({ kind: 'ports', boxes: chain, output: output.slot }))
    if (chain.length === 0) {
      // A node's own outputs beyond its pin rows get rows of their own after
      // every row, but before the boxes ending the node that hold only outputs.
      const outputsOnly = (row: PendingRow): boolean => {
        const top = row.boxes[0] ?? (row.header !== undefined ? row.header.id : undefined)
        return top !== undefined && !holdsMoreThanOutputs.has(top)
      }
      let at = pending.length
      while (at > 0 && outputsOnly(pending[at - 1]!)) at -= 1
      pending.splice(at, 0, ...extra)
    } else {
      // Inside a box: after the last row the box holds.
      let at = -1
      for (const [index, row] of pending.entries()) {
        if (row.header?.id === chain.at(-1) || chainKey(row.boxes.slice(0, chain.length)) === key) at = index
      }
      pending.splice(at < 0 ? pending.length : at + 1, 0, ...extra)
    }
  }

  // Advanced stays after every ordinary row in both states.
  const advancedHeader = pending.find((row) =>
    row.kind === 'section' && row.header?.id === advancedSectionId && row.boxes.length === 0)
  if (advancedHeader !== undefined) {
    const advancedMembers = pending.filter((row) => row.boxes[0] === advancedSectionId)
    const grouped = new Set([advancedHeader, ...advancedMembers])
    const ungrouped = pending.filter((row) => !grouped.has(row))
    pending.splice(0, pending.length, ...ungrouped, advancedHeader, ...advancedMembers)
  }

  // Placement hints affect rows, never the elaborated interface or values.
  const adjacentRows = new Map<PendingRow, PendingRow[]>()
  const attached = new Set<PendingRow>()
  const lineKey = (row: PendingRow): string | undefined => row.widget?.inputId ??
    (row.note ? `note:${row.note.noteId}` : row.button ? `button:${row.button.buttonId}` : undefined)
  for (const item of items) {
    const adjacentTo = item.kind === 'input' ? item.spec.adjacentTo
      : item.kind === 'note' || item.kind === 'button' ? item.adjacentTo : undefined
    if (adjacentTo === undefined) continue
    const key = lineKeyOf(item)
    const row = pending.find((row) => lineKey(row) === key)
    const anchor = pending.find((row) => lineKey(row) === adjacentTo)
    if (!row || !anchor || row === anchor || chainKey(row.boxes) !== chainKey(anchor.boxes)) continue
    adjacentRows.set(anchor, [...(adjacentRows.get(anchor) ?? []), row])
    attached.add(row)
  }
  const positioned: PendingRow[] = []
  const lines = new Map<PendingRow, PendingRow[]>()
  const emitted = new Set<PendingRow>()
  const emit = (row: PendingRow, line: PendingRow[] = []): void => {
    if (emitted.has(row)) return
    emitted.add(row)
    positioned.push(row)
    line.push(row)
    lines.set(row, line)
    for (const child of adjacentRows.get(row) ?? []) emit(child, line)
  }
  for (const row of pending) if (!attached.has(row)) emit(row)
  for (const row of pending) emit(row)
  pending.splice(0, pending.length, ...positioned)

  // An unfolded editor takes its space under the whole line of its row. A
  // declaration may start it unfolded; a growing group's members start folded.
  const withSpaces: PendingRow[] = []
  for (const row of pending) {
    withSpaces.push(row)
    const line = lines.get(row)!
    if (line.at(-1) !== row) continue
    for (const cell of line) {
      const w = cell.widget
      const editor = w === undefined ? undefined : IN_NODE_EDITORS[w.viewId]
      if (w === undefined || editor === undefined) continue
      const declared = options.editorsStartFolded !== true && w.familyMember !== true && w.spec.options['unfolded'] === true
      if (!(options.editorUnfolded?.[w.valueKey] ?? declared)) continue
      // Unfolded, the row is the editor's one-row header: what the folded row
      // shows in small (the curve's sketch) is the editor itself under it.
      cell.widget = { ...w, unfolded: true, rows: 1 }
      const openSections = (editor.sections ?? []).filter((section) =>
        options.sectionOverrides?.[`${w.valueKey}.${section.id}`] === false)
      const wiredLine = editor.wiredLine !== undefined && isConnected('in', editor.wiredLine)
      const pictureHeight = options.pictureHeights?.[w.valueKey]
      const controls = editorControlHeights.get(w.valueKey)
      const spaceRow: PendingRow = {
        kind: 'editorSpace',
        boxes: cell.boxes,
        editorSpace: {
          inputId: w.inputId,
          valueKey: w.valueKey,
          viewId: w.viewId,
          ...(openSections.length > 0 ? { openSections: openSections.map((section) => section.id) } : {}),
          ...(wiredLine ? { wiredLine: true as const } : {}),
          ...unfoldedEditorSpace(editor, tokens, {
            ...(pictureHeight !== undefined ? { pictureHeight } : {}),
            ...(controls !== undefined ? { controls } : {}),
            openSections,
            wiredLine,
          }),
        },
      }
      lines.set(spaceRow, [spaceRow])
      withSpaces.push(spaceRow)
    }
  }
  pending.splice(0, pending.length, ...withSpaces)

  const rowBaseHeight = (row: PendingRow): number => row.kind === 'ports'
    ? tokens.rowGeometry.portRowHeight
    : row.kind !== 'widget' || row.widget === undefined
    ? tokens.rowHeight
    : (row.widget!.viewId === 'core.text'
      ? multilineWidgetHeight(row.widget!.rows, tokens)
      : row.widget!.rows * tokens.rowHeight)
  const lineBaseHeight = (line: PendingRow[]): number => Math.max(
    ...line.map(rowBaseHeight),
    line.length > 1 ? line.length * (tokens.pinRadius * 2 + WIDGET_PIN_GAP * 2) : 0,
  )
  // Only the last text box takes the node's resize surplus; every other text
  // box keeps the height it was given in lines.
  const flexibleRows = pending.filter((row) =>
    row.kind === 'widget' && row.widget!.viewId === 'core.text' && !row.widget!.inactive &&
      lines.get(row)!.find((sibling) => sibling.widget?.viewId === 'core.text' && !sibling.widget.inactive) === row,
  ).slice(-1)
  const stackInsets = rowStackInsets(pending[0]?.kind, pending.at(-1)?.kind, tokens)

  /**
   * Vertical placement. A row's field sits `verticalInset` inside its slot,
   * so `slack` is how far the last thing placed ends above `y`: a field's
   * slot leaves `verticalInset`, an outline or a header leaves none.
   */
  const place = (flexibleShare: number, flexibleRemainder: number) => {
    const rows: LayoutRow[] = []
    const pins: PinLayout[] = []
    const boxes: LayoutBox[] = []
    const rowDepth: number[] = []
    const anchorY = new Map<string, number>() // closed row CENTER y by box key
    const lineBottoms = new Map<PendingRow[], number>()
    const rowIndex = new Map<PendingRow, number>()
    const open: { decl: BoxDecl; top: number; first: number }[] = []
    let flexibleIndex = 0
    let y = tokens.headerHeight + stackInsets.top
    let slack = 0
    // Room under the last thing placed before the outline closing below it:
    // as much as at a box's sides, so a field's inset under a field and a
    // box's step under an outline (an inner box or an add row).
    let under: number = box.bottomGap
    const push = (row: LayoutRow, depth: number): void => {
      rows.push(row)
      rowDepth.push(depth)
    }
    const close = (depth: number): void => {
      while (open.length > depth) {
        const done = open.pop()!
        const bottom = y + under - slack + box.stroke
        boxes.push({
          id: done.decl.id,
          kind: done.decl.kind,
          depth: open.length + 1,
          x: outlineX(open.length + 1),
          y: done.top,
          width: 0,
          height: bottom - done.top,
          ...(done.decl.tab ? { tab: true as const } : {}),
          first: done.first,
          last: rows.length - 1,
        })
        y = bottom
        slack = 0
        under = box.step
      }
    }
    /** Close the boxes the row is not in and open the option boxes it is in. */
    const enter = (chain: readonly string[]): void => {
      let shared = 0
      while (shared < open.length && shared < chain.length && open[shared]!.decl.id === chain[shared]) shared++
      close(shared)
      for (const id of chain.slice(shared)) {
        const decl = decls.get(id)!
        if (decl.kind === 'option') {
          // Joined to the underside of the dropdown placed just before.
          open.push({ decl, top: y - slack - box.optionOverlap, first: rows.length })
          y = y - slack + box.optionPad - verticalInset
        } else {
          open.push({ decl, top: y + verticalInset - slack, first: rows.length })
        }
        slack = 0
      }
    }
    for (const row of pending) {
      if (row.header !== undefined) {
        const decl = row.header
        enter(row.boxes)
        const depth = open.length + 1
        const index = rows.length
        if (decl.kind === 'member') {
          const top = y + verticalInset - slack
          const height = top + box.stroke + headerHeight - y
          const grip = decl.member !== undefined && !decl.ghost ? gripOf(decl.construct!, decl.member) : undefined
          push({
            kind: 'member', y, height, construct: decl.construct!, memberId: decl.id, label: decl.label,
            ordinal: decl.ordinal ?? 0, ...(decl.ghost ? { ghost: true as const } : {}), inset: outlineX(depth), top,
            ...(grip ? { reorder: { ...grip, gripX: outlineX(depth) + box.stroke + box.labelGap + box.gripWidth / 2 } } : {}),
          }, depth)
          open.push({ decl, top, first: index })
          y += height
          under = box.bottomGap
          slack = 0
          continue
        }
        const count = decl.kind === 'group' ? decl.members ?? 0 : held.get(decl.id) ?? 0
        const modified = hiddenModified.get(decl.id)
        const header = {
          kind: 'section' as const,
          sectionId: decl.id,
          box: decl.kind === 'group' ? 'group' as const : 'section' as const,
          label: decl.label,
          collapsed: decl.closed,
          inset: outlineX(depth),
          count,
          ...(decl.kind === 'group' && decl.maxMembers !== undefined ? { maxCount: decl.maxMembers } : {}),
          ...(decl.closed && modified !== undefined ? { hiddenModified: modified } : {}),
          ...(decl.closed && hiddenPorts.has(decl.id) ? { hiddenPorts: hiddenPorts.get(decl.id)! } : {}),
        }
        if (decl.closed) {
          const top = y + verticalInset - slack
          push({ ...header, y, height: top + closedHeight - y, top }, depth)
          boxes.push({
            id: decl.id, kind: decl.kind, depth, x: outlineX(depth), y: top, width: 0, height: closedHeight,
            closed: true, first: index, last: index,
          })
          anchorY.set(decl.id, top + closedHeight / 2)
          y = top + closedHeight
          under = box.step
          slack = 0
          continue
        } else if (decl.tab) {
          const top = y + box.tabGap - slack
          push({ ...header, y, height: top + box.stroke + box.tabPad - y, top, tab: true }, depth)
          open.push({ decl, top, first: index })
          y = top + box.stroke + box.tabPad
        } else {
          const top = y + verticalInset - slack
          push({ ...header, y, height: top + box.stroke + headerHeight - y, top }, depth)
          open.push({ decl, top, first: index })
          y = top + box.stroke + headerHeight
        }
        under = box.bottomGap
        slack = 0
        continue
      }
      enter(row.boxes)
      const depth = open.length
      if (row.kind === 'editorSpace') {
        const editorSpace = row.editorSpace!
        push({ kind: 'editorSpace', y, inset: fieldInset(depth), rowAbove: 0, ...editorSpace }, depth)
        y += editorSpace.height
      } else if (row.kind === 'growth') {
        const g = row.growth!
        const height = tokens.rowHeight
        push({ kind: 'growth', y, height, inset: outlineX(depth + 1), construct: g.construct, label: g.label, frames: g.frames }, depth)
        y += height
      } else if (row.kind === 'note' || row.kind === 'button') {
        const line = lines.get(row)!
        const height = lineBaseHeight(line)
        const inset = fieldInset(depth)
        rowIndex.set(row, rows.length)
        push(row.note
          ? { kind: 'note', y, height, inset, ...row.note }
          : { kind: 'button', y, height, inset, ...row.button! }, depth)
        lineBottoms.set(line, Math.max(lineBottoms.get(line) ?? y, y + height))
        if (line.at(-1) === row) y = lineBottoms.get(line)!
      } else if (row.kind === 'ports') {
        const height = tokens.rowGeometry.portRowHeight
        rowIndex.set(row, rows.length)
        push({
          kind: 'ports',
          y,
          height,
          ...(depth > 0 ? { nameInset: nameInset(depth) } : {}),
          ...(row.input ? { input: row.input } : {}),
          ...(row.output ? { output: row.output } : {}),
          ...(row.removable && !row.output ? { crossInset: crossInset(depth) } : {}),
          // The grip's place on the row is set once the node's width is known.
          ...(row.reorder && !row.output ? { reorder: { ...row.reorder, gripX: 0 } } : {}),
        }, depth)
        if (row.input && !row.input.socketless) pins.push({ ...annotationsOf(row.input), portId: row.input.portId, label: row.input.label, direction: 'in', y: y + height / 2, type: row.input.type, ...(row.input.optional ? { optional: true as const } : {}) })
        if (row.output) pins.push({ ...annotationsOf(row.output), portId: row.output.portId, label: row.output.label, direction: 'out', y: y + height / 2, type: row.output.type, ...(row.output.maybeAbsent ? { maybeAbsent: true as const } : {}) })
        y += height
      } else {
        const w = row.widget!
        const flexible = flexibleRows.includes(row)
        const baseHeight = lineBaseHeight(lines.get(row)!)
        const height = baseHeight + (flexible
          ? flexibleShare + (flexibleIndex === flexibleRows.length - 1 ? flexibleRemainder : 0)
          : 0)
        if (flexible) flexibleIndex += 1
        // Keep the capsule and its edge controls clear of sockets on either
        // border. The symmetric side also reserves space for output widgets.
        // A choice's dropdown reaches the outline of its option box instead.
        const inset = w.lead ? outlineX(depth + 1) : fieldInset(depth)
        rowIndex.set(row, rows.length)
        // A member drawn as one line of fields has its grip once, before the
        // line, and its cross once, after it.
        const line = lines.get(row)!
        push({
          kind: 'widget', y, height, inset, ...w, ...(row.removable && line.at(-1) === row ? { crossInset: crossInset(depth) } : {}),
          ...(row.reorder && line[0] === row ? { reorder: { ...row.reorder, gripX: 0 } } : {}),
        }, depth)
        // Socketless controls keep their editor and outgoing value tap; an
        // editor row has no pin.
        if (!w.socketless && w.editor !== true && w.kept === undefined) pins.push({
          ...annotationsOf(w), portId: w.inputId, label: w.label, direction: 'in', y: y + tokens.rowHeight / 2, type: w.type,
          ...(w.optional ? { optional: true as const } : {}),
          widgetBacked: true as const,
        })
        // A widget can also produce its effective value. The duplicate
        // right-edge anchor deliberately shares the input's flattened id.
        if (w.editor !== true) pins.push({
          ...annotationsOf(w), portId: w.inputId, label: w.label, direction: 'out', y: y + tokens.rowHeight / 2, type: w.type, widgetTap: true,
        })
        lineBottoms.set(line, Math.max(lineBottoms.get(line) ?? y, y + height))
        if (line.at(-1) === row) y = lineBottoms.get(line)!
      }
      slack = verticalInset
      under = row.kind === 'growth' ? box.step : box.bottomGap
    }
    const endsInBox = open.length > 0
    close(0)
    return { rows, pins, boxes, rowDepth, anchorY, rowIndex, bottom: y, endsInBox }
  }

  const natural = place(0, 0)
  const naturalHeight = natural.bottom + (natural.endsInBox ? boxEndInset(tokens) : stackInsets.bottom)
  const requestedExtra = options.size === undefined
    ? 0
    : Math.max(0, options.size.height - naturalHeight)
  const flexibleShare = flexibleRows.length === 0 ? 0 : Math.floor(requestedExtra / flexibleRows.length)
  const flexibleRemainder = flexibleRows.length === 0
    ? 0
    : requestedExtra - flexibleShare * flexibleRows.length
  const placed = requestedExtra > 0 && flexibleRows.length > 0 ? place(flexibleShare, flexibleRemainder) : natural
  const { rows, pins, rowDepth, anchorY, rowIndex } = placed

  // A closed box's row carries the pins of the fields inside it, each side
  // pressed together around the row's middle. Wired pins come first and at
  // most `clusterMax` are drawn; a further wire ends on the last drawn pin.
  const clusters = new Map<string, typeof collapsedPins>()
  for (const p of collapsedPins) {
    const key = `${p.sectionId}\n${p.direction}`
    clusters.set(key, [...(clusters.get(key) ?? []), p])
  }
  for (const all of clusters.values()) {
    const center = anchorY.get(all[0]!.sectionId)
    if (center === undefined) continue
    const ordered = [...all.filter((p) => p.connected), ...all.filter((p) => !p.connected)]
    const drawn = Math.min(ordered.length, box.clusterMax)
    const pitch = drawn === 2 ? box.clusterPitch.two : box.clusterPitch.three
    for (const [index, p] of ordered.entries()) {
      const stacked = index >= drawn
      if (stacked && !p.connected) break
      const slot = Math.min(index, drawn - 1)
      pins.push({
        ...annotationsOf(p), portId: p.portId, label: p.label, direction: p.direction, y: center + (slot - (drawn - 1) / 2) * pitch, type: p.type, collapsedSection: p.sectionId,
        ...(stacked ? { stacked: true as const } : {}),
        ...(p.optional ? { optional: true as const } : {}), ...(p.maybeAbsent ? { maybeAbsent: true as const } : {}),
        ...(p.widgetTap ? { widgetTap: true as const } : {}),
      })
    }
  }

  // Width: pure function of content. A row in boxes needs its insets too.
  const titleRenamed = node.title !== undefined && node.title !== schema.displayName
  const title = node.title ?? schema.displayName
  const titleWidth = measure(title, titleRenamed ? 'renamedTitle' : 'title')
  let width = Math.max(tokens.nodeMinWidth, titleWidth + TITLE_START + tokens.padX + canvasPaintTokens.node.titleWidthPadding)
  let fieldDepth = 0
  for (const [index, row] of rows.entries()) {
    const depth = rowDepth[index]!
    const extra = (fieldInset(depth) - fieldInset(0)) * 2
    let content = 0
    if (row.kind === 'ports') {
      const inW = row.input ? measure(row.input.label, 'label') + tokens.pinRadius * 2 + canvasPaintTokens.node.portLabelPadding : 0
      const outW = row.output ? measure(row.output.label, 'label') + tokens.pinRadius * 2 + canvasPaintTokens.node.portLabelPadding : 0
      content = inW + outW + (row.input && row.output ? canvasPaintTokens.node.pairedPortGap : 0) + nameInset(depth) * 2
    } else if (row.kind === 'section' || row.kind === 'member') {
      // Arrow or grip, the name, and the count or the remove cross.
      content = measure(row.label, 'label') + box.widthPadding + (row.inset - tokens.padX) * 2
    } else if (row.kind === 'growth') {
      // '+ label' text plus capsule padding.
      content = measure(`+ ${row.label}`, 'label') + canvasPaintTokens.node.growthWidthPadding + (row.inset - tokens.padX) * 2
    } else if (row.kind === 'note') {
      content = measure(row.text, 'label') + row.inset * 2
    } else if (row.kind === 'button') {
      content = measure(row.label, 'label') + canvasPaintTokens.node.growthWidthPadding + extra
    } else if (row.kind === 'editorSpace') {
      // The space is as wide as its row, which a member's grip and cross shorten.
      const editorRow = rows.find((candidate) => candidate.kind === 'widget' && candidate.valueKey === row.valueKey)
      const room = editorRow?.kind !== 'widget' ? 0
        : (editorRow.crossInset === undefined ? 0 : box.cross.size + box.cross.fieldGap) +
          (editorRow.reorder === undefined ? 0 : box.gripWidth + box.cross.fieldGap)
      content = canvasPaintTokens.node.editorSpace.minWidth + extra + room
    } else {
      // Label + a value area floor; widget content depth lives in the
      // expanded editor, so rows never force extreme widths.
      content = measure(row.label, 'label') + canvasPaintTokens.node.widgetLabelPadding + canvasPaintTokens.node.widgetValueMinWidth + extra
      if (row.kind === 'widget' && row.viewId === 'core.curve' && !row.unfolded && tokens.widgetRowLook === 'raised-editors') {
        // A folded curve's square comes before its opener icon and name, and
        // how the points are joined sits under both.
        const curve = canvasPaintTokens.widget.curve
        const label = measure(row.label, 'label')
        content += widgetChromeRect(0, 0, 0, row.height, tokens.rowGeometry.fieldInsetY).height - curve.inset + curve.gap +
          Math.max(canvasPaintTokens.widget.opener.iconReserve + label, canvasPaintTokens.node.widgetValueMinWidth) - label
      }
    }
    if (row.kind === 'widget' || row.kind === 'note' || row.kind === 'button') fieldDepth = Math.max(fieldDepth, depth)
    width = Math.max(width, content + tokens.padX * 2)
  }
  width = Math.min(width, tokens.nodeMaxAutoWidth)

  // Manual override: width may shrink to the global floor (content
  // truncates), height may only grow (rows never compress). The floor grows
  // with the nesting, so the innermost field is never narrower than a field
  // on a node of the least width.
  const depthExtra = (fieldInset(fieldDepth) - fieldInset(0)) * 2
  const columns = Math.max(1, ...[...lines.values()].map((line) => line.length))
  const cellGap = canvasPaintTokens.node.widgetColumnGap
  const minWidth = columns * tokens.nodeMinWidth + (columns - 1) * cellGap + depthExtra
  for (const line of new Set(lines.values())) {
    if (line.length < 2) continue
    const lineExtra = (fieldInset(rowDepth[rowIndex.get(line[0]!)!]!) - fieldInset(0)) * 2
    width = Math.max(width, line.reduce((sum, row) => sum + measure(cellLabel(row), 'label') + canvasPaintTokens.node.widgetLabelPadding + canvasPaintTokens.node.widgetValueMinWidth + tokens.padX * 2, 0) + (line.length - 1) * cellGap + lineExtra)
  }
  width = Math.max(minWidth, width)
  const minHeight = naturalHeight
  const sizeOverride = options.size
  if (sizeOverride) {
    width = Math.max(minWidth, sizeOverride.width)
  }
  const height = sizeOverride ? Math.max(minHeight, sizeOverride.height) : naturalHeight

  for (const line of new Set(lines.values())) {
    if (line.length < 2) continue
    const gap = cellGap
    const compactWidth = tokens.nodeMinWidth
    // Cells share the width between the boxes around the line.
    const boxInset = fieldInset(rowDepth[rowIndex.get(line[0]!)!]!) - fieldInset(0)
    const lineWidth = width - boxInset * 2
    let left = boxInset
    for (const [column, pendingRow] of line.entries()) {
      const index = rowIndex.get(pendingRow)!
      const row = rows[index] as Extract<LayoutRow, { kind: 'widget' | 'note' | 'button' }>
      const cellInset = row.inset - boxInset
      const cellWidth = column === 0 ? lineWidth - (line.length - 1) * (compactWidth + gap) : compactWidth
      rows[index] = { ...row, inset: left + cellInset, width: cellWidth - cellInset * 2 }
      for (const [index, pin] of pins.entries()) {
        if (row.kind === 'widget' && pin.portId === row.inputId && (pin.direction === 'in' || pin.widgetTap === true))
          // Border sockets keep noodles outside the node body. Distinct slots
          // retain independent hit targets while the controls share a line.
          pins[index] = { ...pin, y: row.y + (column + 0.5) * lineBaseHeight(line) / line.length }
      }
      left += cellWidth + gap
    }
  }
  // A member that can be moved has its grip at the left end, and its field
  // or name starts after it; a field that is a whole member ends before its
  // remove cross. Each stands as far from the group's outline as from the
  // field. A spare member starts where the members' fields do.
  const gripSpaces = new Set(pending.flatMap((row) =>
    row.gripSpace && lines.get(row)![0] === row ? [rowIndex.get(row)] : []))
  const gap = box.cross.fieldGap
  for (const [index, row] of rows.entries()) {
    if (row.kind !== 'widget' && row.kind !== 'ports') continue
    const gripRoom = row.reorder === undefined && !gripSpaces.has(index) ? 0 : gap + box.gripWidth + gap - box.fieldGap
    if (row.crossInset === undefined && gripRoom === 0) continue
    // The inner side of the group's outline.
    const outline = (row.kind === 'widget' ? row.inset : fieldInset(rowDepth[index]!)) - box.fieldGap
    const reorder = row.reorder === undefined ? {} : { reorder: { ...row.reorder, gripX: outline + gap + box.gripWidth / 2 } }
    if (row.kind === 'ports') {
      rows[index] = { ...row, nameInset: (row.nameInset ?? 0) + gripRoom, ...reorder }
      continue
    }
    const right = row.crossInset === undefined
      ? row.inset + (row.width ?? width - row.inset * 2)
      : width - row.crossInset - box.cross.size - gap
    rows[index] = { ...row, inset: row.inset + gripRoom, width: right - row.inset - gripRoom, ...reorder }
  }
  // An unfolded editor and its row are one box: the space takes the row's
  // place and width, so a member's grip and cross stay beside both.
  const editorRows = new Map<string, Extract<LayoutRow, { kind: 'widget' }>>()
  for (const [index, row] of rows.entries()) {
    if (row.kind === 'widget' && row.unfolded) editorRows.set(row.valueKey, row)
    const editorRow = row.kind === 'editorSpace' ? editorRows.get(row.valueKey) : undefined
    if (row.kind !== 'editorSpace' || editorRow === undefined) continue
    rows[index] = {
      ...row, inset: editorRow.inset, rowAbove: row.y - editorRow.y,
      ...(editorRow.width !== undefined ? { width: editorRow.width } : {}),
    }
  }

  if (options.minimized) {
    // Minimizing only hides the body, so the node keeps its open width. The
    // open layout is measured separately because this pass also lays out
    // rows the open node hides (collapsed sections, hidden widgets) to keep
    // their pins, and those rows must not widen it.
    const { minimized: _minimized, ...openOptions } = options
    const open = layoutNode(schema, node, tokens, measure, widgetMeasure, openOptions)
    const minimizedHeight = tokens.headerHeight + tokens.padBottom
    return {
      width: open.width,
      height: minimizedHeight,
      minWidth: open.minWidth,
      minHeight: minimizedHeight,
      openPreviewHeight: withPreviewRegion(open, tokens).preview!.height,
      headerHeight: tokens.headerHeight,
      title,
      titleRenamed,
      ...(elaborated.titleSuffix !== undefined ? { titleSuffix: elaborated.titleSuffix } : {}),
      rows: [],
      pins: pins.map((pin) => ({
        ...pin,
        y: tokens.headerHeight / 2,
        minimized: true as const,
      })),
      minimized: true,
    }
  }

  // Outer boxes first, so a box inside a box draws over it.
  const boxes = placed.boxes
    .map((b) => ({ ...b, width: width - b.x * 2 }))
    .sort((a, b) => a.depth - b.depth || a.first - b.first)
  return {
    width,
    height,
    minWidth,
    minHeight,
    ...(sizeOverride ? { sizeOverride: { width: sizeOverride.width, height: sizeOverride.height } } : {}),
    headerHeight: tokens.headerHeight,
    title,
    titleRenamed,
    ...(elaborated.titleSuffix !== undefined ? { titleSuffix: elaborated.titleSuffix } : {}),
    rows,
    pins,
    ...(boxes.length > 0 ? { boxes } : {}),
  }
}

/** Visual gap between a pin circle and widget chrome. */
export const WIDGET_PIN_GAP = canvasPaintTokens.node.widgetPinGap

/**
 * Space above the first row and below the last. A pin row's text has space
 * of its own inside the row, while a boxed row's edge is the first thing
 * seen, so the node's inset depends on the kind of row at each end.
 */
export function rowStackInsets(
  first: LayoutRow['kind'] | undefined,
  last: LayoutRow['kind'] | undefined,
  tokens: DesignTokens,
): { readonly top: number; readonly bottom: number } {
  const geometry = tokens.rowGeometry
  return {
    top: first === undefined ? 0 : first === 'ports' ? geometry.pinTopInset : geometry.boxedTopInset,
    bottom: last === 'ports' ? geometry.pinBottomInset : tokens.padBottom,
  }
}

/** Shift rows and pins below the header by the top inset of the row stack. */
export function insetRowStack(
  rows: LayoutRow[],
  pins: PinLayout[],
  tokens: DesignTokens,
): { readonly top: number; readonly bottom: number } {
  const insets = rowStackInsets(rows[0]?.kind, rows.at(-1)?.kind, tokens)
  if (insets.top !== 0) {
    rows.splice(0, rows.length, ...rows.map((row) => ({ ...row, y: row.y + insets.top })))
    pins.splice(0, pins.length, ...pins.map((pin) => ({ ...pin, y: pin.y + insets.top })))
  }
  return insets
}

/**
 * Minimum height of a layout as if its rows ended in a boxed region, so a
 * preview or text output placed after the rows keeps the boxed bottom inset.
 */
function boxedMinHeight(layout: NodeLayout, tokens: DesignTokens): number {
  const endsInBox = layout.boxes?.some((b) => b.depth === 1 && b.last === layout.rows.length - 1) === true
  const bottom = endsInBox ? boxEndInset(tokens) : rowStackInsets(undefined, layout.rows.at(-1)?.kind, tokens).bottom
  return layout.minHeight - bottom + tokens.padBottom
}

/** A box that ends a node stands as far above its bottom edge as from its side edges. */
function boxEndInset(tokens: DesignTokens): number {
  return tokens.rowGeometry.fieldInsetX - canvasPaintTokens.node.box.stroke
}

/** One boundary item rendered as a pseudo-node row (scene supplies these). */
export interface BoundarySlotInfo {
  /** Boundary item id (pin portId; NEVER split - boundary ids may contain dots). */
  readonly id: string
  readonly label: string
  /** Derived instance-facing type, when the boundary schema derives cleanly. */
  readonly type?: TypeExpr
  /** Derived source for the immediate enclosing region's iteration index. */
  readonly regionIndex?: true
  /**
   * Inputs panel only: the field rows the subgraph node outside shows for
   * this input (a dropdown that leads options brings its option's fields).
   * The panel shows the same fields, with the input's pin on the right of
   * the first.
   */
  readonly fields?: readonly Omit<Extract<LayoutRow, { kind: 'widget' }>, 'kind' | 'y' | 'height' | 'inset' | 'width'>[]
  /** Inputs panel only: the space of each unfolded editor among the fields, by its row's value key. */
  readonly editorSpaces?: Readonly<Record<string, Omit<Extract<LayoutRow, { kind: 'editorSpace' }>, 'kind' | 'y' | 'inset' | 'width' | 'rowAbove'>>>
  /** Fields drawn without their wire, or a value source's field: no pin. */
  readonly pinless?: true
  /** Inputs panel only: the input takes one value or a whole list. */
  readonly acceptsList?: true
}

/**
 * Layout for a boundary pseudo-node: the node-like Inputs/Outputs panel
 * shown while editing a subgraph definition. Same design language as
 * layoutNode (header + port rows + pins) but built straight from boundary
 * items - these panels are DERIVED view constructs, never NodeData, so they
 * must not travel through schema/elaboration paths.
 *
 * The Inputs panel FEEDS the graph, so its pins face right (direction
 * 'out'); the Outputs panel consumes, pins face left ('in'). Pin portId is
 * the boundary item id; the address mirrors it for annotation symmetry but
 * boundary pins never dispatch port commands.
 */
/**
 * Reserved pin/row id for the trailing blank slot on a boundary pseudo-node:
 * dragging from (or dropping on) it exposes a NEW boundary port. Never a
 * real boundary item id (item ids come from inner port names).
 */
export const BOUNDARY_ADD_SLOT = '__add__'
export const REGION_INDEX_SLOT = '@region:index'

export function layoutBoundaryNode(
  side: 'inputs' | 'outputs',
  slots: readonly BoundarySlotInfo[],
  tokens: DesignTokens,
  measure: TextMeasurer,
  subtitle?: string,
): NodeLayout {
  const direction = side === 'inputs' ? 'out' : 'in'
  const title = side === 'inputs' ? 'Inputs' : 'Outputs'
  const rows: LayoutRow[] = []
  const pins: PinLayout[] = []
  let y = tokens.headerHeight
  for (const slot of slots) {
    const type: TypeExpr = slot.type ?? { kind: 'wildcard' }
    if (slot.fields !== undefined && slot.fields.length > 0 && direction === 'out') {
      if (slot.pinless !== true) pins.push({ address: { port: slot.id }, portId: slot.id, label: slot.label, direction, y: y + tokens.rowHeight / 2, type, ...(slot.acceptsList ? { acceptsList: true } : {}) })
      for (const [index, field] of slot.fields.entries()) {
        const height = field.viewId === 'core.text' ? multilineWidgetHeight(field.rows, tokens) : field.rows * tokens.rowHeight
        rows.push({ ...field, ...(index === 0 ? { label: slot.label } : {}), kind: 'widget', y, height, inset: tokens.rowGeometry.fieldInsetX })
        y += height
        // An unfolded editor hangs under its field, and the panel grows downward.
        const space = slot.editorSpaces?.[field.valueKey]
        if (space !== undefined) {
          rows.push({ ...space, kind: 'editorSpace', y, inset: tokens.rowGeometry.fieldInsetX, rowAbove: height })
          y += space.height
        }
      }
      continue
    }
    const height = tokens.rowHeight
    const label = slot.label
    const portSlot: PortSlot = { portId: slot.id, label, type, address: { port: slot.id }, ...(slot.regionIndex ? { regionIndex: true } : {}) }
    rows.push({
      kind: 'ports',
      y,
      height,
      ...(direction === 'in' ? { input: portSlot } : { output: { ...portSlot, index: pins.length } }),
    })
    if (slot.pinless !== true) pins.push({ address: { port: slot.id }, portId: slot.id, direction, y: y + height / 2, type, ...(slot.regionIndex ? { regionIndex: true } : {}), ...(slot.acceptsList ? { acceptsList: true } : {}) })
    y += height
  }
  {
    // Trailing blank slot (ComfyUI-style): an always-open ghost pin that
    // exposes a new boundary port when a noodle connects through it.
    const height = tokens.rowHeight
    const label = side === 'inputs' ? 'expose input...' : 'expose output...'
    const addSlot: PortSlot = {
      portId: BOUNDARY_ADD_SLOT,
      label,
      type: { kind: 'wildcard' },
      address: { port: BOUNDARY_ADD_SLOT },
      ghost: true,
    }
    rows.push({
      kind: 'ports',
      y,
      height,
      ...(direction === 'in' ? { input: addSlot } : { output: { ...addSlot, index: pins.length } }),
    })
    pins.push({
      address: { port: BOUNDARY_ADD_SLOT },
      portId: BOUNDARY_ADD_SLOT,
      direction,
      y: y + height / 2,
      type: { kind: 'wildcard' },
      ghost: true,
    })
    y += height
  }

  const titleWidth = measure(title, 'title') +
    (subtitle === undefined ? 0 : canvasPaintTokens.boundary.subtitleGap + measure(subtitle, 'label'))
  let width = Math.max(tokens.nodeMinWidth, titleWidth + tokens.padX * 2 + canvasPaintTokens.node.titleWidthPadding)
  for (const row of rows) {
    if (row.kind === 'widget') {
      const mark = row.subgraphMark === undefined ? 0 : canvasPaintTokens.widget.subgraphMark.size + canvasPaintTokens.widget.subgraphMark.gap
      width = Math.max(width, mark + measure(row.label, 'label') + canvasPaintTokens.node.widgetLabelPadding + canvasPaintTokens.node.widgetValueMinWidth + tokens.padX * 2)
      continue
    }
    if (row.kind === 'editorSpace') {
      width = Math.max(width, canvasPaintTokens.node.editorSpace.minWidth + row.inset * 2)
      continue
    }
    if (row.kind !== 'ports') continue
    const slot = row.input ?? row.output
    if (!slot) continue
    width = Math.max(width, measure(slot.label, 'label') + tokens.pinRadius * 2 + canvasPaintTokens.node.portLabelPadding + tokens.padX * 2)
  }
  width = Math.min(width, tokens.nodeMaxAutoWidth)

  const stackInsets = insetRowStack(rows, pins, tokens)
  const height = y + stackInsets.top + stackInsets.bottom
  return {
    width,
    height,
    minWidth: tokens.nodeMinWidth,
    minHeight: height,
    headerHeight: tokens.headerHeight,
    title,
    ...(subtitle !== undefined ? { subtitle } : {}),
    rows,
    pins,
  }
}
