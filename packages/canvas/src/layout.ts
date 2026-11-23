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
  type WidgetSpec,
} from '@dinkster/core'
import { canvasPaintTokens, type DesignTokens } from './tokens.js'

/** Injected text measurement (canvas measureText in the app; approximate in tests). */
export type TextMeasurer = (text: string, role: 'title' | 'renamedTitle' | 'label' | 'value') => number

/** Resolves the widget view for a spec: view id + compact row count. */
export type WidgetMeasure = (spec: WidgetSpec) => { viewId: string; rows: number } | undefined

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

export type LayoutRow =
  | {
      readonly kind: 'ports'
      readonly y: number
      readonly height: number
      readonly input?: PortSlot
      readonly output?: PortSlot & { readonly index: number }
    }
  | ({
      readonly kind: 'widget'
      readonly y: number
      readonly height: number
      /** Left clearance from the node origin to widget chrome. */
      readonly inset: number
      /** Explicit cell width for widgets sharing a horizontal line. */
      readonly width?: number
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
      /** Instance whose promoted boundary input owns this row's stored value. */
      readonly familyOwner?: {
        readonly graphId: string
        readonly nodeId: string
        readonly construct: string
        readonly valueKey: string
      }
      /**
       * Set for an Inputs panel field whose value is a value source's own
       * value: edits dispatch valueSource.setValue and
       * valueSource.setController, never node.setValue.
       */
      readonly valueSourceOwner?: { readonly graphId: string; readonly valueSourceId: string }
    } & DynamicAnnotations)
  | {
      /**
       * Grow-family affordance (ElaboratedGrowth): a nested-only autogrow
       * template whose trailing ghost renders no pins/widgets. Click
       * dispatches dynamic.materialize with `frames`; no pin, never wired.
       */
      readonly kind: 'growth'
      readonly y: number
      readonly height: number
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
      readonly kind: 'section'
      readonly y: number
      readonly height: number
      readonly sectionId: string
      readonly label: string
      /** Effective state: view override if present, else collapsedByDefault. */
      readonly collapsed: boolean
      /**
       * Count of MODIFIED widget values this section hides while collapsed
       * (derived via resettableWidgetsOf, never stored). Present only when
       * collapsed and > 0; expanded sections show the widgets themselves.
       */
      readonly hiddenModified?: number
    }

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
  /** Producer affordance for a static memberless widget input. */
  readonly widgetTap?: true
  /** Proven by elaboration to originate from a static schema input. */
  readonly staticWidgetTap?: true
  /** Optional input (InputSpec.optional): renders as a donut, not a filled dot. */
  readonly optional?: true
  /** Output pin whose producer may deliberately emit no value (OutputSpec.optional). */
  readonly maybeAbsent?: true
  /**
   * Present when this pin is a visible proxy for a connected port hidden by
   * a collapsed section. Proxies share the section header row's center.
   */
  readonly collapsedSection?: string
  /** Pin belongs to a minimized node and is represented by an aggregate side proxy. */
  readonly minimized?: true
  /**
   * A port-anchored solver diagnostic points here (e.g. a stale DynamicSlot
   * specialization). Set during scene build, never by layout itself; the
   * renderer paints a warning ring so the advisory is actionable at the pin.
   */
  readonly warn?: true
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
  /** Expanded Advanced enclosure, including the header and every member row. */
  readonly advancedGroup?: {
    readonly y: number
    readonly height: number
  }
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
    ...projectedAdvancedGroup(layout, rows),
    ...(layout.preview === undefined ? {} : { preview: { ...layout.preview, y: layout.preview.y + delta } }),
    ...(layout.textOutput === undefined ? {} : { textOutput: { ...layout.textOutput, y: layout.textOutput.y + delta } }),
  }
}

/** Reflow physical lines without separating widgets that share one line. */
function reflowRows(layout: NodeLayout, heightOf: (row: LayoutRow, index: number) => number): LayoutRow[] {
  let sourceY = -1
  let lineY = layout.rows[0]?.y ?? layout.headerHeight
  let bottom = lineY
  return layout.rows.map((row, index) => {
    if (sourceY !== row.y) {
      sourceY = row.y
      lineY = bottom
    }
    const height = heightOf(row, index)
    bottom = Math.max(bottom, lineY + height)
    return { ...row, y: lineY, height }
  })
}

const projectedAdvancedGroup = (
  layout: NodeLayout,
  rows: readonly LayoutRow[],
): Pick<NodeLayout, 'advancedGroup'> => {
  const group = layout.advancedGroup
  if (group === undefined) return {}
  const bottom = group.y + group.height
  let first = -1
  let last = -1
  for (const [index, row] of layout.rows.entries()) {
    if (row.y < group.y || row.y + row.height > bottom) continue
    if (first < 0) first = index
    last = index
  }
  if (first < 0 || last < 0) return { advancedGroup: group }
  return {
    advancedGroup: {
      y: rows[first]!.y,
      height: rows[last]!.y + rows[last]!.height - rows[first]!.y,
    },
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
    ...projectedAdvancedGroup(layout, rows),
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
    ...projectedAdvancedGroup(layout, rows),
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
    ...projectedAdvancedGroup(open, rows),
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
    ...projectedAdvancedGroup(layout, rows),
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
  ...(a.acceptsList ? { acceptsList: true } : {}),
})

/**
 * Compute a node's layout from its elaborated interface. Pure.
 *
 * Sections: a SectionSpec item emits a header row at its declared position;
 * items referencing it (`item.section`) hide while it is collapsed. The
 * effective state is the view override when present, else collapsedByDefault.
 * Members referencing an UNDECLARED section id render normally (schema bug,
 * not a rendering hole).
 */
export function layoutNode(
  schema: NodeSchema,
  node: NodeData,
  tokens: DesignTokens,
  measure: TextMeasurer,
  widgetMeasure: WidgetMeasure,
  options: LayoutOptions = {},
): NodeLayout {
  interface PendingRow {
    kind: 'ports' | 'widget' | 'section' | 'growth' | 'note' | 'button'
    input?: PortSlot
    output?: PortSlot & { index: number }
    widget?: Extract<LayoutRow, { kind: 'widget' }> extends infer R
      ? Omit<R, 'kind' | 'y' | 'height' | 'inset'>
      : never
    section?: { sectionId: string; label: string; collapsed: boolean; hiddenModified?: number }
    growth?: { construct: string; label: string; frames: readonly MaterializeFrame[] }
    note?: { noteId: string; text: string; unknown?: true }
    button?: { buttonId: string; label: string }
    sectionId?: string
  }
  /** A `Row` cell's text, which sets its share of the line's width. */
  const cellLabel = (row: PendingRow): string =>
    row.widget?.label ?? row.note?.text ?? row.button?.label ?? ''
  const pending: PendingRow[] = []
  const outputs: {
    slot: PortSlot & { index: number }
    sectionId?: string
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
  const inputSection = (spec: InputSpec): string | undefined => spec.section

  // Effective collapse per DECLARED section: view override beats the default.
  const collapsed = new Map<string, boolean>()
  for (const item of items) {
    if (item.kind !== 'section') continue
    collapsed.set(
      item.spec.id,
      options.sectionOverrides?.[item.spec.id] ?? item.spec.collapsedByDefault ?? false,
    )
  }
  const isHidden = (section: string | undefined): boolean =>
    options.minimized !== true && section !== undefined && collapsed.get(section) === true

  // Modified widget values hidden by each COLLAPSED section (derived, never
  // stored): the collapsed header renders a subtle indicator so tuned values
  // in a loaded workflow are discoverable without expanding everything.
  const hiddenModified = new Map<string, number>()
  if ([...collapsed.values()].some(Boolean)) {
    for (const r of resettableWidgetsOf(elaborated, node.values)) {
      const section = inputSection(r.item.spec)
      if (r.modified && isHidden(section))
        hiddenModified.set(section!, (hiddenModified.get(section!) ?? 0) + 1)
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
      ...(selectorDisplay?.[item.address.port] === 'inactive' ? { inactive: true } : {}),
      ...(item.kind === 'input' && item.spec.acceptsList ? { acceptsList: true } : {}),
    }
  }

  // Connected ports hidden by a collapsed section: pins anchor to the header.
  const collapsedPins: ({ sectionId: string; portId: string; direction: 'in' | 'out'; type: TypeExpr; optional?: true; maybeAbsent?: true; widgetTap?: true; staticWidgetTap?: true } & DynamicAnnotations)[] = []
  const staticWidgetInputs = new Set<string>()

  let outputIndex = 0
  for (const item of items) {
    if (item.kind === 'section') {
      const count = hiddenModified.get(item.spec.id)
      pending.push({
        kind: 'section',
        section: {
          sectionId: item.spec.id,
          label: item.spec.displayName ?? item.spec.id,
          collapsed: collapsed.get(item.spec.id)!,
          ...(count !== undefined ? { hiddenModified: count } : {}),
        },
      })
      continue
    }
    if (item.kind === 'growth') {
      // Grow-family affordance: hides with its section like the family's
      // own rows would; no pin, so a collapsed section needs no anchor.
      if (isHidden(item.section)) continue
      pending.push({
        kind: 'growth',
        ...(item.section !== undefined ? { sectionId: item.section } : {}),
        growth: { construct: item.construct, label: item.label, frames: item.frames },
      })
      continue
    }
    if (item.kind === 'note' || item.kind === 'button') {
      if (isHidden(item.section)) continue
      pending.push({
        kind: item.kind,
        ...(item.section !== undefined ? { sectionId: item.section } : {}),
        ...(item.kind === 'note'
          ? { note: { noteId: item.id, text: item.text, ...(item.unknown ? { unknown: true as const } : {}) } }
          : { button: { buttonId: item.id, label: item.label } }),
      })
      continue
    }
    if (item.kind === 'output') {
      const spec = item.spec
      if (spec.hidden === true) continue
      if (isHidden(spec.section)) {
        if (isConnected('out', spec.id)) {
          collapsedPins.push({ sectionId: spec.section!, portId: spec.id, direction: 'out', type: spec.type, ...(spec.optional ? { maybeAbsent: true as const } : {}), ...annotate(item) })
        }
        continue
      }
      outputs.push({
        ...(spec.section !== undefined ? { sectionId: spec.section } : {}),
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
    const section = inputSection(spec)
    const widget = spec.widget
    if (spec.widget && item.origin.kind === 'static') staticWidgetInputs.add(spec.id)
    if (isHidden(section)) {
      if (!spec.socketless && isConnected('in', spec.id)) {
        collapsedPins.push({
          sectionId: section!, portId: spec.id, direction: 'in', type: spec.type,
          ...(spec.optional ? { optional: true as const } : {}), ...annotate(item),
        })
      }
      // A connected widget tap (the producer affordance of a widget input)
      // keeps its anchor too - otherwise collapsing the section silently
      // drops the outgoing noodle from the scene.
      if (widget && !spec.forceInput && isConnected('out', spec.id)) {
        collapsedPins.push({
          sectionId: section!, portId: spec.id, direction: 'out', type: spec.type, widgetTap: true,
          ...(item.origin.kind === 'static' ? { staticWidgetTap: true as const } : {}), ...annotate(item),
        })
      }
      continue
    }
    const asSocket = !widget || spec.forceInput
    if (asSocket) {
      pending.push({
        kind: 'ports',
        ...(section !== undefined ? { sectionId: section } : {}),
        input: {
          portId: spec.id,
          label: displayLabel(spec),
          type: spec.type,
          ...(spec.socketless ? { socketless: true as const } : {}),
          ...(spec.optional ? { optional: true } : {}),
          ...annotate(item),
        },
      })
      continue
    }
    const valueKey = valueKeyOf(item)
    const representation = resolveWidgetRepresentation(
      widget,
      options.widgetRepresentations?.[valueKey],
    )
    const measured = widgetMeasure(representation.spec) ?? { viewId: 'core.unknown', rows: 1 }
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
      ...(section !== undefined ? { sectionId: section } : {}),
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
        ...(selector !== undefined ? { selector } : {}),
        ...annotate(item),
      },
    })
  }

  const advancedOutputs = outputs.filter((output) => output.sectionId === advancedSectionId)
  let nextAdvancedOutput = 0
  for (const row of pending) {
    if (row.kind === 'ports' && row.sectionId === advancedSectionId && nextAdvancedOutput < advancedOutputs.length) {
      row.output = advancedOutputs[nextAdvancedOutput++]!.slot
    }
  }
  while (nextAdvancedOutput < advancedOutputs.length) {
    pending.push({
      kind: 'ports',
      sectionId: advancedSectionId,
      output: advancedOutputs[nextAdvancedOutput++]!.slot,
    })
  }

  // Pair outputs into primary socket rows top-down; Advanced owns complete
  // rows, so unrelated outputs stay outside its enclosure.
  const primaryOutputs = outputs.filter((output) => output.sectionId !== advancedSectionId)
  let nextOutput = 0
  for (const row of pending) {
    if (row.kind === 'ports' && row.sectionId !== advancedSectionId && nextOutput < primaryOutputs.length) {
      row.output = primaryOutputs[nextOutput++]!.slot
    }
  }
  while (nextOutput < primaryOutputs.length) {
    pending.push({ kind: 'ports', output: primaryOutputs[nextOutput++]!.slot })
  }

  // Advanced stays after every ordinary input and output row in both states.
  // Reorder after output pairing so collapsing the group cannot leave output-
  // only rows below its header and make the toggle appear to jump.
  const advancedHeader = pending.find((row) =>
    row.kind === 'section' && row.section?.sectionId === advancedSectionId)
  if (advancedHeader !== undefined) {
    const advancedMembers = pending.filter((row) => row.sectionId === advancedSectionId)
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
    if (!row || !anchor || row === anchor || row.sectionId !== anchor.sectionId) continue
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
  const naturalRowsHeight = [...new Set(lines.values())].reduce((height, line) =>
    height + lineBaseHeight(line), 0)
  const stackInsets = rowStackInsets(pending[0]?.kind, pending.at(-1)?.kind, tokens)
  const naturalHeight = tokens.headerHeight + stackInsets.top + naturalRowsHeight + stackInsets.bottom
  const requestedExtra = options.size === undefined
    ? 0
    : Math.max(0, options.size.height - naturalHeight)
  // Only the last text box takes the node's resize surplus; every other text
  // box keeps the height it was given in lines.
  const flexibleRow = pending.filter((row) =>
    row.kind === 'widget' && row.widget!.viewId === 'core.text' && !row.widget!.inactive &&
      lines.get(row)!.find((sibling) => sibling.widget?.viewId === 'core.text' && !sibling.widget.inactive) === row,
  ).at(-1)

  // Vertical placement.
  const rows: LayoutRow[] = []
  const pins: PinLayout[] = []
  const sectionRowY = new Map<string, number>() // header CENTER y by section id
  let advancedBounds: { y: number; bottom: number } | undefined
  const lineBottoms = new Map<PendingRow[], number>()
  const rowIndex = new Map<PendingRow, number>()
  let y = tokens.headerHeight + stackInsets.top
  for (const row of pending) {
    if (row.kind === 'section') {
      const s = row.section!
      const height = tokens.rowHeight
      rows.push({
        kind: 'section',
        y,
        height,
        sectionId: s.sectionId,
        label: s.label,
        collapsed: s.collapsed,
        ...(s.hiddenModified !== undefined ? { hiddenModified: s.hiddenModified } : {}),
      })
      sectionRowY.set(s.sectionId, y + height / 2)
      if (!s.collapsed && s.sectionId === advancedSectionId) {
        advancedBounds = { y, bottom: y + height }
      }
      y += height
    } else if (row.kind === 'growth') {
      const g = row.growth!
      const height = tokens.rowHeight
      rows.push({ kind: 'growth', y, height, construct: g.construct, label: g.label, frames: g.frames })
      if (row.sectionId === advancedSectionId && advancedBounds !== undefined) {
        advancedBounds.bottom = y + height
      }
      y += height
    } else if (row.kind === 'note' || row.kind === 'button') {
      const line = lines.get(row)!
      const height = lineBaseHeight(line)
      const inset = tokens.rowGeometry.fieldInsetX
      rowIndex.set(row, rows.length)
      rows.push(row.note
        ? { kind: 'note', y, height, inset, ...row.note }
        : { kind: 'button', y, height, inset, ...row.button! })
      if (row.sectionId === advancedSectionId && advancedBounds !== undefined) {
        advancedBounds.bottom = Math.max(advancedBounds.bottom, y + height)
      }
      lineBottoms.set(line, Math.max(lineBottoms.get(line) ?? y, y + height))
      if (line.at(-1) === row) y = lineBottoms.get(line)!
    } else if (row.kind === 'ports') {
      const height = tokens.rowGeometry.portRowHeight
      rows.push({
        kind: 'ports',
        y,
        height,
        ...(row.input ? { input: row.input } : {}),
        ...(row.output ? { output: row.output } : {}),
      })
      if (row.input && !row.input.socketless) pins.push({ ...annotationsOf(row.input), portId: row.input.portId, label: row.input.label, direction: 'in', y: y + height / 2, type: row.input.type, ...(row.input.optional ? { optional: true as const } : {}) })
      if (row.output) pins.push({ ...annotationsOf(row.output), portId: row.output.portId, label: row.output.label, direction: 'out', y: y + height / 2, type: row.output.type, ...(row.output.maybeAbsent ? { maybeAbsent: true as const } : {}) })
      if (row.sectionId === advancedSectionId && advancedBounds !== undefined) {
        advancedBounds.bottom = y + height
      }
      y += height
    } else {
      const w = row.widget!
      const height = lineBaseHeight(lines.get(row)!) + (row === flexibleRow ? requestedExtra : 0)
      // Keep the capsule and its edge controls clear of sockets on either
      // border. The symmetric side also reserves space for output widgets.
      const inset = tokens.rowGeometry.fieldInsetX
      rowIndex.set(row, rows.length)
      rows.push({ kind: 'widget', y, height, inset, ...w })
      // Socketless controls keep their editor and outgoing value tap.
      if (!w.socketless) pins.push({
        ...annotationsOf(w), portId: w.inputId, label: w.label, direction: 'in', y: y + tokens.rowHeight / 2, type: w.type,
        ...(w.optional ? { optional: true as const } : {}),
        widgetBacked: true as const,
      })
      // A widget can also produce its effective value. The duplicate
      // right-edge anchor deliberately shares the input's flattened id.
      pins.push({
        ...annotationsOf(w), portId: w.inputId, label: w.label, direction: 'out', y: y + tokens.rowHeight / 2, type: w.type, widgetTap: true,
        ...(staticWidgetInputs.has(w.inputId) ? { staticWidgetTap: true as const } : {}),
      })
      if (row.sectionId === advancedSectionId && advancedBounds !== undefined) {
        advancedBounds.bottom = Math.max(advancedBounds.bottom, y + height)
      }
      const line = lines.get(row)!
      lineBottoms.set(line, Math.max(lineBottoms.get(line) ?? y, y + height))
      if (line.at(-1) === row) y = lineBottoms.get(line)!
    }
  }

  // Connected-but-hidden ports keep a pin on their section header row.
  for (const p of collapsedPins) {
    const anchorY = sectionRowY.get(p.sectionId)
    if (anchorY === undefined) continue
    pins.push({
      ...annotationsOf(p), portId: p.portId, direction: p.direction, y: anchorY, type: p.type, collapsedSection: p.sectionId,
      ...(p.optional ? { optional: true as const } : {}), ...(p.maybeAbsent ? { maybeAbsent: true as const } : {}),
      ...(p.widgetTap ? { widgetTap: true as const } : {}),
      ...(p.staticWidgetTap ? { staticWidgetTap: true as const } : {}),
    })
  }

  // Width: pure function of content.
  const titleRenamed = node.title !== undefined && node.title !== schema.displayName
  const title = node.title ?? schema.displayName
  const titleWidth = measure(title, titleRenamed ? 'renamedTitle' : 'title')
  let width = Math.max(tokens.nodeMinWidth, titleWidth + TITLE_START + tokens.padX + canvasPaintTokens.node.titleWidthPadding)
  for (const row of rows) {
    let content = 0
    if (row.kind === 'ports') {
      const inW = row.input ? measure(row.input.label, 'label') + tokens.pinRadius * 2 + canvasPaintTokens.node.portLabelPadding : 0
      const outW = row.output ? measure(row.output.label, 'label') + tokens.pinRadius * 2 + canvasPaintTokens.node.portLabelPadding : 0
      content = inW + outW + (row.input && row.output ? canvasPaintTokens.node.pairedPortGap : 0)
    } else if (row.kind === 'section') {
      // Label + the disclosure triangle.
      content = measure(row.label, 'label') + canvasPaintTokens.node.sectionWidthPadding
    } else if (row.kind === 'growth') {
      // '+ label' text plus capsule padding.
      content = measure(`+ ${row.label}`, 'label') + canvasPaintTokens.node.growthWidthPadding
    } else if (row.kind === 'note') {
      content = measure(row.text, 'label') + row.inset * 2
    } else if (row.kind === 'button') {
      content = measure(row.label, 'label') + canvasPaintTokens.node.growthWidthPadding
    } else {
      // Label + a value area floor; widget content depth lives in the
      // expanded editor, so rows never force extreme widths.
      content = measure(row.label, 'label') + canvasPaintTokens.node.widgetLabelPadding + canvasPaintTokens.node.widgetValueMinWidth
    }
    width = Math.max(width, content + tokens.padX * 2)
  }
  width = Math.min(width, tokens.nodeMaxAutoWidth)

  // Manual override: width may shrink to the global floor (content
  // truncates), height may only grow (rows never compress).
  const columns = Math.max(1, ...[...lines.values()].map((line) => line.length))
  const cellGap = canvasPaintTokens.node.widgetColumnGap
  const minWidth = columns * tokens.nodeMinWidth + (columns - 1) * cellGap
  for (const line of new Set(lines.values())) {
    if (line.length < 2) continue
    width = Math.max(width, line.reduce((sum, row) => sum + measure(cellLabel(row), 'label') + canvasPaintTokens.node.widgetLabelPadding + canvasPaintTokens.node.widgetValueMinWidth + tokens.padX * 2, 0) + (line.length - 1) * cellGap)
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
    let left = 0
    for (const [column, pendingRow] of line.entries()) {
      const index = rowIndex.get(pendingRow)!
      const row = rows[index] as Extract<LayoutRow, { kind: 'widget' | 'note' | 'button' }>
      const cellWidth = column === 0 ? width - (line.length - 1) * (compactWidth + gap) : compactWidth
      rows[index] = { ...row, inset: left + row.inset, width: cellWidth - row.inset * 2 }
      for (const [index, pin] of pins.entries()) {
        if (row.kind === 'widget' && pin.portId === row.inputId && (pin.direction === 'in' || pin.widgetTap === true))
          // Border sockets keep noodles outside the node body. Distinct slots
          // retain independent hit targets while the controls share a line.
          pins[index] = { ...pin, y: row.y + (column + 0.5) * lineBaseHeight(line) / line.length }
      }
      left += cellWidth + gap
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
    ...(advancedBounds !== undefined
      ? { advancedGroup: { y: advancedBounds.y, height: advancedBounds.bottom - advancedBounds.y } }
      : {}),
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
  return layout.minHeight - rowStackInsets(undefined, layout.rows.at(-1)?.kind, tokens).bottom + tokens.padBottom
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
