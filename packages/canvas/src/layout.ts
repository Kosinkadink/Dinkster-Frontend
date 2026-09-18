/**
 * Node layout (initial implementation rows + subgraph implementation dynamics): the row model from architecture
 * section 12, computed over the node's ELABORATED interface.
 *
 * Committed rules implemented here:
 * - Input/output pairing on one line is the default: outputs fill slots
 *   opposite connection-input rows top-down.
 * - Widgets always own the full row width; an output is NEVER beside a
 *   widget row. Overflow outputs (more outputs than pairable socket rows)
 *   get dedicated rows.
 * - Rows have fixed type-appropriate heights (a multiline string previews a
 *   few lines; depth lives in the expanded editor).
 * - Auto-size: a node's natural size is a pure function of its row stack +
 *   tokens. Manual overrides are editing implementation (stored in view state, min-clamped).
 *
 * Dynamics: rows/pins come from `elaborateInterface`, so autogrow
 * members, min-fill, trailing ghosts, combo selectors/branches, and slot
 * dependents all render through ONE path - and because subgraph instances
 * resolve to boundary-derived schemas (documentResolver), a forwarded
 * family's suffix ghost appears on the instance with zero special-casing.
 * Row/pin ids are ELAB KEYS (elabKeyOf packing, unique per node); document
 * identity travels separately as `address` so gestures never parse keys.
 * Ghost rows carry `materialize` frames: the UI batches dynamic.materialize
 * with whatever action lands on the ghost (hazard N3).
 *
 * Layout is pure and renderer-agnostic; text measurement is injected.
 */

import {
  elaborateInterface,
  hiddenConditionalWidgets,
  materializeFramesOf,
  resettableWidgetsOf,
  resolveWidgetRepresentation,
  selectorBranchDisplay,
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
import { type DesignTokens } from './tokens.js'

/** Injected text measurement (canvas measureText in the app; approximate in tests). */
export type TextMeasurer = (text: string, role: 'title' | 'renamedTitle' | 'label' | 'value') => number

/** Resolves the widget view for a spec: view id + compact row count. */
export type WidgetMeasure = (spec: WidgetSpec) => { viewId: string; rows: number } | undefined

export interface DynamicEditOwner {
  readonly graphId: string
  readonly nodeId: string
  readonly construct: string
  readonly ancestors?: readonly { readonly construct: string; readonly member: string }[]
}

/**
 * Dynamic-family annotations shared by port slots, widget rows, and pins.
 * `portId`/`inputId` are elab keys (unique per node, presentation/lookup);
 * `address` is document identity ({port, members}) for command params.
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
  /** Occurrence-local instance that owns this derived row or pin. */
  readonly familyOwner?: {
    readonly graphId: string
    readonly nodeId: string
    readonly construct: string
    readonly valueKey?: string
    readonly occurrence?: OccurrenceRef
    readonly familyPath?: string
    readonly sourceMember?: string
    readonly route?: readonly BoundaryRouteLeg[]
    readonly sourceEndpoint?: import('@dinkster/core').OccurrenceLinkEndpoint
    /** Present only when an occurrence mutation planner can consume this route. */
    readonly socketed?: true
  }
  /** Occurrence-local owner of a COMBO option source's input family. */
  readonly inputFamilyOwner?: {
    readonly graphId: string
    readonly nodeId: string
    readonly construct: string
    /** Derived option value -> persisted member id on the owner. */
    readonly memberIds: Readonly<Record<string, string>>
  }
  /** DynamicSlot choice metadata used by connect gestures and pin menus. */
  readonly dynamicSlot?: {
    readonly construct: string
    readonly variants: readonly { readonly key: string; readonly type: TypeExpr }[]
    readonly selected?: string
    readonly ancestors: readonly { readonly construct: string; readonly member: string }[]
    readonly owner?: DynamicEditOwner
  }
  /** Inactive branch of a document-time selector; display-only. */
  readonly inactive?: true
  /** Derived source for the immediate enclosing region's iteration index. */
  readonly regionIndex?: true
}

export interface PortSlot extends DynamicAnnotations {
  readonly portId: string
  readonly label: string
  readonly type: TypeExpr
  readonly optional?: boolean
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
      /** Symmetric clearance from node-border pins to widget chrome. */
      readonly inset: number
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
      /** Wire-15 family literal that keeps an always-visible input socket. */
      readonly familyLiteral?: true
      /** Wire-22 execution binding retained from the elaborated input. */
      readonly sourceFilename?: SourceFilenameSpec
      /** Effective named representation selected for this row (wire 17). */
      readonly representationId?: string
      /** Effective controller mode. Absent document state defaults to randomize. */
      readonly controllerMode?: 'fixed' | 'increment' | 'decrement' | 'randomize'
      readonly optional?: boolean
      /**
       * Value not stored in node.values (DynamicCombo selector: the selected
       * option key). Renderers/editors read this instead of values.
       */
      readonly derivedValue?: Json
      /**
       * Set for a DynamicCombo selector row: edits dispatch
       * dynamic.selectOption with these params, never node.setValue.
       */
      readonly selector?: {
        readonly construct: string
        readonly ancestors: readonly { readonly construct: string; readonly member: string }[]
        readonly owner?: DynamicEditOwner
      }
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
      readonly familyOwner?: { readonly graphId: string; readonly nodeId: string; readonly construct: string; readonly valueKey?: string }
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
  /** Center y, node-local. x is 0 (in) or layout.width (out). */
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
   * a collapsed section. Proxies share the section header row's center;
   * scene-audit treats same-section co-location as intentional.
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
  readonly headerHeight: number
  readonly title: string
  /** True only when an override differs from the schema/fallback display name. */
  readonly titleRenamed?: boolean
  readonly rows: readonly LayoutRow[]
  readonly pins: readonly PinLayout[]
  /** Body rows are hidden while title, compact preview, and endpoint anchors remain visible. */
  readonly minimized?: true
  /** Expanded Advanced enclosure, including the header and every member row. */
  readonly advancedGroup?: {
    readonly y: number
    readonly height: number
  }
  /** Optional imagery area appended inside the node body after all rows. */
  readonly preview?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    /** Discoverable pre-execution surface without preview content. */
    readonly compact?: true
  }
  /** Optional recorded string result appended inside the body after all rows. */
  readonly textOutput?: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

/** Shared visible bounds for registry widget chrome and its overlay states. */
export function widgetChromeRect(x: number, rowY: number, width: number, rowHeight: number): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly radius: number
} {
  return { x, y: rowY + 2, width, height: rowHeight - 4, radius: 4 }
}

/** Floating label band plus padded multiline content rows. */
export function multilineWidgetHeight(rows: number, tokens: DesignTokens): number {
  // The content budget lives inside widgetChromeRect's 2px top/bottom inset.
  return 4 + tokens.multilineText.labelHeight +
    rows * tokens.multilineText.lineHeight + tokens.multilineText.padding * 2
}

const previewPanelMinHeight = (tokens: DesignTokens): number =>
  tokens.previewMinHeight + tokens.previewCaptionHeight

const previewPanelDefaultHeight = (tokens: DesignTokens): number =>
  tokens.previewDefaultHeight + tokens.previewCaptionHeight

const flexibleTextRowIndexes = (layout: NodeLayout): number[] => layout.rows
  .map((row, index) => row.kind === 'widget' && row.viewId === 'core.text' && !row.inactive ? index : -1)
  .filter((index) => index >= 0)

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
  if (layout.minimized) {
    const height = layout.minHeight + tokens.previewGap + tokens.rowHeight
    return {
      ...layout,
      height,
      minHeight: height,
      preview: {
        x: tokens.padX,
        y: layout.headerHeight + tokens.previewGap,
        width: Math.max(0, layout.width - tokens.padX * 2),
        height: tokens.rowHeight,
        compact: true,
      },
    }
  }
  const flexibleIndexes = flexibleTextRowIndexes(layout)
  const compactHeight = tokens.rowHeight
  const defaultHeight = previewPanelDefaultHeight(tokens)
  const panelFloor = flexibleIndexes.length > 0 ? defaultHeight : previewPanelMinHeight(tokens)
  const defaultActiveHeight = layout.minHeight + tokens.previewGap + defaultHeight
  const activeHeight = layout.height > layout.minHeight
    ? Math.max(layout.minHeight + tokens.previewGap + panelFloor, layout.height)
    : defaultActiveHeight
  const bodyExtra = Math.max(0, activeHeight - defaultActiveHeight)
  const activePanelHeight = activeHeight - layout.minHeight - tokens.previewGap - bodyExtra
  const minHeight = layout.minHeight + tokens.previewGap + compactHeight
  const height = minHeight + bodyExtra
  const share = flexibleIndexes.length === 0 ? 0 : Math.floor(bodyExtra / flexibleIndexes.length)
  const remainder = flexibleIndexes.length === 0 ? 0 : bodyExtra - share * flexibleIndexes.length
  const flexible = new Set(flexibleIndexes)
  let flexibleIndex = 0
  let y = layout.headerHeight
  const rows = layout.rows.map((row, index): LayoutRow => {
    const rowHeight = flexible.has(index)
      ? multilineWidgetHeight((row as Extract<LayoutRow, { kind: 'widget' }>).rows, tokens) +
        share + (flexibleIndex === flexibleIndexes.length - 1 ? remainder : 0)
      : row.height
    if (flexible.has(index)) flexibleIndex += 1
    const projected = { ...row, y, height: rowHeight } as LayoutRow
    y += rowHeight
    return projected
  })
  const pins = layout.pins.map((pin) => {
    const rowIndex = layout.rows.findIndex((row) => pin.y >= row.y && pin.y < row.y + row.height)
    if (rowIndex < 0) return pin
    return { ...pin, y: rows[rowIndex]!.y + pin.y - layout.rows[rowIndex]!.y }
  })
  return {
    ...layout,
    height,
    minHeight,
    resizeHeightOffset: compactHeight - activePanelHeight,
    rows,
    pins,
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

/**
 * Activate the in-body preview region while preserving the persisted total
 * size as a request. Multiline text keeps first claim on resize surplus;
 * only nodes without an active text row grow the preview itself.
 */
export function withPreviewRegion(layout: NodeLayout, tokens: DesignTokens): NodeLayout {
  if (layout.minimized) return withCompactPreviewRegion(layout, tokens)
  if (layout.preview?.compact === true) {
    const flexible = flexibleTextRowIndexes(layout).length > 0
    const compactHeight = tokens.rowHeight
    const panelMinHeight = flexible ? previewPanelDefaultHeight(tokens) : previewPanelMinHeight(tokens)
    const compactSurplus = flexible ? 0 : Math.max(0, layout.height - layout.minHeight)
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
  const flexibleIndexes = flexibleTextRowIndexes(layout)
  // Preview-only nodes can shrink the panel down to its hard floor; nodes
  // with flexible text rows keep the default panel because surplus height
  // belongs to the text, so the panel itself never resizes.
  const panelMinHeight = flexibleIndexes.length === 0
    ? previewPanelMinHeight(tokens)
    : previewPanelDefaultHeight(tokens)
  const minHeight = layout.minHeight + tokens.previewGap + panelMinHeight
  // A layout without manual-resize surplus carries no size request for the
  // panel: open it at the default height rather than the shrink floor.
  const height = layout.height > layout.minHeight
    ? Math.max(minHeight, layout.height)
    : layout.minHeight + tokens.previewGap + previewPanelDefaultHeight(tokens)
  const extra = Math.max(0, height - minHeight)
  const share = flexibleIndexes.length === 0 ? 0 : Math.floor(extra / flexibleIndexes.length)
  const remainder = flexibleIndexes.length === 0 ? 0 : extra - share * flexibleIndexes.length
  const flexible = new Set(flexibleIndexes)
  let flexibleIndex = 0
  let y = layout.headerHeight
  const rows = layout.rows.map((row, index): LayoutRow => {
    const rowHeight = flexible.has(index)
      ? multilineWidgetHeight((row as Extract<LayoutRow, { kind: 'widget' }>).rows, tokens) +
        share + (flexibleIndex === flexibleIndexes.length - 1 ? remainder : 0)
      : row.height
    if (flexible.has(index)) flexibleIndex += 1
    const projected = { ...row, y, height: rowHeight } as LayoutRow
    y += rowHeight
    return projected
  })
  const pins = layout.pins.map((pin) => {
    const rowIndex = layout.rows.findIndex((row) => pin.y >= row.y && pin.y < row.y + row.height)
    if (rowIndex < 0) return pin
    return { ...pin, y: rows[rowIndex]!.y + pin.y - layout.rows[rowIndex]!.y }
  })
  const previewHeight = panelMinHeight + (flexibleIndexes.length === 0 ? extra : 0)
  return {
    ...layout,
    height,
    minHeight,
    rows,
    pins,
    ...projectedAdvancedGroup(layout, rows),
    preview: {
      x: tokens.padX,
      y: y + tokens.previewGap,
      width: Math.max(0, layout.width - tokens.padX * 2),
      height: previewHeight,
    },
  }
}

/**
 * Activate the capped Standard-view string result region. Image previews use
 * their separate region and take precedence before this helper is called.
 */
export function withTextOutputRegion(layout: NodeLayout, tokens: DesignTokens, lineCount = 6): NodeLayout {
  if (layout.textOutput !== undefined) return layout
  if (layout.minimized) {
    const compact = withCompactPreviewRegion(layout, tokens)
    const { preview, ...base } = compact
    return {
      ...base,
      textOutput: {
        x: preview!.x,
        y: preview!.y,
        width: preview!.width,
        height: preview!.height,
      },
    }
  }
  const regionHeight = tokens.rowHeight * Math.max(1, Math.min(6, Math.trunc(lineCount)))
  if (layout.preview?.compact === true) {
    const expansion = regionHeight - tokens.rowHeight
    const { preview: compactPreview, ...base } = layout
    return {
      ...base,
      height: layout.height + expansion,
      minHeight: layout.minHeight + expansion,
      resizeHeightOffset: regionHeight - previewPanelDefaultHeight(tokens),
      textOutput: {
        x: compactPreview.x,
        y: compactPreview.y,
        width: compactPreview.width,
        height: compactPreview.height + expansion,
      },
    }
  }
  const minHeight = layout.minHeight + tokens.previewGap + regionHeight
  const height = Math.max(minHeight, layout.height)
  const flexibleIndexes = flexibleTextRowIndexes(layout)
  const extra = Math.max(0, height - minHeight)
  const share = flexibleIndexes.length === 0 ? 0 : Math.floor(extra / flexibleIndexes.length)
  const remainder = flexibleIndexes.length === 0 ? 0 : extra - share * flexibleIndexes.length
  const flexible = new Set(flexibleIndexes)
  let flexibleIndex = 0
  let y = layout.headerHeight
  const rows = layout.rows.map((row, index): LayoutRow => {
    const rowHeight = flexible.has(index)
      ? multilineWidgetHeight((row as Extract<LayoutRow, { kind: 'widget' }>).rows, tokens) +
        share + (flexibleIndex === flexibleIndexes.length - 1 ? remainder : 0)
      : row.height
    if (flexible.has(index)) flexibleIndex += 1
    const projected = { ...row, y, height: rowHeight } as LayoutRow
    y += rowHeight
    return projected
  })
  const pins = layout.pins.map((pin) => {
    const rowIndex = layout.rows.findIndex((row) => pin.y >= row.y && pin.y < row.y + row.height)
    if (rowIndex < 0) return pin
    return { ...pin, y: rows[rowIndex]!.y + pin.y - layout.rows[rowIndex]!.y }
  })
  return {
    ...layout,
    height,
    minHeight,
    rows,
    pins,
    ...projectedAdvancedGroup(layout, rows),
    textOutput: {
      x: tokens.padX,
      y: y + tokens.previewGap,
      width: Math.max(0, layout.width - tokens.padX * 2),
      height: regionHeight,
    },
  }
}

/**
 * Reflow only height-flexible multiline rows for an in-flight resize preview.
 * The scene remains committed; the renderer uses this projected layout until
 * the pointer gesture commits the same size through view.setNodeSize.
 */
export function projectNodeLayoutHeight(
  layout: NodeLayout,
  requestedHeight: number,
  tokens: DesignTokens,
): NodeLayout {
  const height = Math.max(layout.minHeight, requestedHeight)
  if (height === layout.height) return layout
  const flexibleIndexes = layout.rows
    .map((row, index) => row.kind === 'widget' && row.viewId === 'core.text' && !row.inactive ? index : -1)
    .filter((index) => index >= 0)
  if (flexibleIndexes.length === 0) {
    if (layout.preview === undefined) return { ...layout, height }
    if (layout.preview.compact === true) {
      const extra = Math.max(0, height - layout.minHeight)
      return {
        ...layout,
        height,
        preview: {
          ...layout.preview,
          y: layout.minHeight - tokens.rowHeight - tokens.padBottom + extra,
          height: tokens.rowHeight,
        },
      }
    }
    const extra = Math.max(0, height - layout.minHeight)
    return {
      ...layout,
      height,
      preview: {
        ...layout.preview,
        height: previewPanelMinHeight(tokens) + extra,
      },
    }
  }

  const extra = Math.max(0, height - layout.minHeight)
  const share = Math.floor(extra / flexibleIndexes.length)
  const remainder = extra - share * flexibleIndexes.length
  const flexible = new Set(flexibleIndexes)
  let flexibleIndex = 0
  let y = layout.headerHeight
  const rows = layout.rows.map((row, index): LayoutRow => {
    const rowHeight = flexible.has(index)
      ? multilineWidgetHeight((row as Extract<LayoutRow, { kind: 'widget' }>).rows, tokens) +
        share + (flexibleIndex === flexibleIndexes.length - 1 ? remainder : 0)
      : row.height
    if (flexible.has(index)) flexibleIndex += 1
    const projected = { ...row, y, height: rowHeight } as LayoutRow
    y += rowHeight
    return projected
  })
  const pins = layout.pins.map((pin) => {
    const rowIndex = layout.rows.findIndex((row) => pin.y >= row.y && pin.y < row.y + row.height)
    if (rowIndex < 0) return pin
    return { ...pin, y: rows[rowIndex]!.y + pin.y - layout.rows[rowIndex]!.y }
  })
  const preview = layout.preview === undefined
    ? undefined
    : { ...layout.preview, y: rows.reduce((bottom, row) => Math.max(bottom, row.y + row.height), layout.headerHeight) + tokens.previewGap }
  const textOutput = layout.textOutput === undefined
    ? undefined
    : { ...layout.textOutput, y: rows.reduce((bottom, row) => Math.max(bottom, row.y + row.height), layout.headerHeight) + tokens.previewGap }
  return {
    ...layout,
    height,
    rows,
    pins,
    ...projectedAdvancedGroup(layout, rows),
    ...(preview === undefined ? {} : { preview }),
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
  ...(a.familyOwner !== undefined ? { familyOwner: a.familyOwner } : {}),
  ...(a.dynamicSlot !== undefined ? { dynamicSlot: a.dynamicSlot } : {}),
  ...(a.inactive ? { inactive: true } : {}),
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
    kind: 'ports' | 'widget' | 'section' | 'growth'
    input?: PortSlot
    output?: PortSlot & { index: number }
    widget?: Extract<LayoutRow, { kind: 'widget' }> extends infer R
      ? Omit<R, 'kind' | 'y' | 'height' | 'inset'>
      : never
    section?: { sectionId: string; label: string; collapsed: boolean; hiddenModified?: number }
    growth?: { construct: string; label: string; frames: readonly MaterializeFrame[] }
    sectionId?: string
  }
  const pending: PendingRow[] = []
  const outputs: {
    slot: PortSlot & { index: number }
    sectionId?: string
  }[] = []

  const elaborated = options.elaborated ?? elaborateInterface(schema, node)
  const items = elaborated.items
  const selectorDisplay = selectorBranchDisplay(schema, node.values)
  const advancedSectionId = 'advanced'
  const advancedSectionDeclared = items.some((item) =>
    item.kind === 'section' && item.spec.id === advancedSectionId)
  const hasUngroupedAdvanced = items.some((item) =>
    item.kind === 'input' && item.spec.hidden !== true && item.spec.advanced === true && item.spec.section === undefined)
  const inputSection = (spec: InputSpec): string | undefined =>
    spec.section ?? (spec.advanced === true ? advancedSectionId : undefined)

  // Effective collapse per DECLARED section: view override beats the default.
  const collapsed = new Map<string, boolean>()
  for (const item of items) {
    if (item.kind !== 'section') continue
    collapsed.set(
      item.spec.id,
      options.sectionOverrides?.[item.spec.id] ?? item.spec.collapsedByDefault ?? false,
    )
  }
  if (hasUngroupedAdvanced && !advancedSectionDeclared) {
    collapsed.set(advancedSectionId, options.sectionOverrides?.[advancedSectionId] ?? true)
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
  const conditionallyHidden = hiddenConditionalWidgets(schema, node, isConnected)

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
          ancestors: (item.ancestry ?? []).map((a) => ({ construct: a.construct, member: a.member as string })),
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
    }
  }

  // Connected ports hidden by a collapsed section: pins anchor to the header.
  const collapsedPins: ({ sectionId: string; portId: string; direction: 'in' | 'out'; type: TypeExpr; optional?: true; maybeAbsent?: true; widgetTap?: true; staticWidgetTap?: true } & DynamicAnnotations)[] = []
  const staticWidgetInputs = new Set<string>()

  const familyLiteralWidget = (item: ElaboratedInput): WidgetSpec | undefined => {
    if (!item.wire15Materialization || item.origin.kind !== 'member' || item.origin.wire15Naming !== 'names') {
      return undefined
    }
    if (item.spec.forceInput) return undefined
    const declared = item.spec.widget
    if (declared !== undefined && ['INT', 'FLOAT', 'BOOLEAN'].includes(declared.widgetType)) return declared
    if (declared !== undefined || item.spec.type.kind !== 'union') return undefined
    const names = new Set(item.spec.type.names)
    if (![...names].every((name) => ['core.int', 'core.float', 'core.boolean'].includes(name))) return undefined
    return names.has('core.float') || names.has('core.int')
      ? { widgetType: 'FLOAT', options: {} }
      : undefined
  }

  let outputIndex = 0
  let advancedSectionEmitted = false
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
    if (item.kind === 'output') {
      const spec = item.spec
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
    if (spec.advanced === true && spec.section === undefined && !advancedSectionDeclared && !advancedSectionEmitted) {
      const count = hiddenModified.get(advancedSectionId)
      pending.push({
        kind: 'section',
        section: {
          sectionId: advancedSectionId,
          label: 'Advanced',
          collapsed: collapsed.get(advancedSectionId)!,
          ...(count !== undefined ? { hiddenModified: count } : {}),
        },
      })
      advancedSectionEmitted = true
    }
    const familyWidget = familyLiteralWidget(item)
    const widget = familyWidget ?? spec.widget
    const familyLiteral = familyWidget !== undefined
    if (spec.widget && item.origin.kind === 'static') staticWidgetInputs.add(spec.id)
    if (options.minimized !== true && spec.widget && item.origin.kind === 'static' && conditionallyHidden.has(spec.id)) continue
    if (isHidden(section)) {
      if (isConnected('in', spec.id)) {
        collapsedPins.push({
          sectionId: section!, portId: spec.id, direction: 'in', type: spec.type,
          ...(spec.optional ? { optional: true as const } : {}), ...annotate(item),
        })
      }
      // A connected widget tap (the producer affordance of a memberless
      // widget input) keeps its anchor too - otherwise collapsing the
      // section silently drops the outgoing noodle from the scene.
      if (widget && !spec.forceInput && !familyLiteral && item.address.members === undefined && isConnected('out', spec.id)) {
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
    const w = {
      ...measured,
      rows: Number.isFinite(measured.rows) ? Math.max(1, Math.floor(measured.rows)) : 1,
    }
    const selector =
      item.origin.kind === 'selector'
        ? {
            construct: item.origin.construct,
            ancestors: (item.ancestry ?? []).map((a) => ({ construct: a.construct, member: a.member as string })),
          }
        : undefined
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
        ...(familyLiteral ? { familyLiteral: true as const } : {}),
        ...(spec.sourceFilename !== undefined ? { sourceFilename: spec.sourceFilename } : {}),
        ...(representation.id !== undefined ? { representationId: representation.id } : {}),
        ...(options.seedControllerEnabled !== false && representation.spec.controller !== undefined
          ? { controllerMode: node.controllers?.[valueKey] ?? representation.spec.controllerInitial ?? 'randomize' as const }
          : {}),
        ...(spec.optional ? { optional: true } : {}),
        ...(item.derivedValue !== undefined ? { derivedValue: item.derivedValue } : {}),
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

  const naturalRowsHeight = pending.reduce((height, row) => {
    if (row.kind !== 'widget') return height + tokens.rowHeight
    return height + (row.widget!.viewId === 'core.text'
      ? multilineWidgetHeight(row.widget!.rows, tokens)
      : row.widget!.rows * tokens.rowHeight)
  }, 0)
  const naturalHeight = tokens.headerHeight + naturalRowsHeight + tokens.padBottom
  const requestedExtra = options.size === undefined
    ? 0
    : Math.max(0, options.size.height - naturalHeight)
  const flexibleRows = pending.filter((row) =>
    row.kind === 'widget' && row.widget!.viewId === 'core.text' && !row.widget!.inactive,
  )
  const flexibleShare = flexibleRows.length === 0 ? 0 : Math.floor(requestedExtra / flexibleRows.length)
  const flexibleRemainder = flexibleRows.length === 0
    ? 0
    : requestedExtra - flexibleShare * flexibleRows.length
  let flexibleIndex = 0

  // Vertical placement.
  const rows: LayoutRow[] = []
  const pins: PinLayout[] = []
  const sectionRowY = new Map<string, number>() // header CENTER y by section id
  let advancedBounds: { y: number; bottom: number } | undefined
  let y = tokens.headerHeight
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
    } else if (row.kind === 'ports') {
      const height = tokens.rowHeight
      rows.push({
        kind: 'ports',
        y,
        height,
        ...(row.input ? { input: row.input } : {}),
        ...(row.output ? { output: row.output } : {}),
      })
      if (row.input) pins.push({ ...annotationsOf(row.input), portId: row.input.portId, label: row.input.label, direction: 'in', y: y + height / 2, type: row.input.type, ...(row.input.optional ? { optional: true as const } : {}) })
      if (row.output) pins.push({ ...annotationsOf(row.output), portId: row.output.portId, label: row.output.label, direction: 'out', y: y + height / 2, type: row.output.type, ...(row.output.maybeAbsent ? { maybeAbsent: true as const } : {}) })
      if (row.sectionId === advancedSectionId && advancedBounds !== undefined) {
        advancedBounds.bottom = y + height
      }
      y += height
    } else {
      const w = row.widget!
      const flexible = w.viewId === 'core.text' && !w.inactive
      const baseHeight = w.viewId === 'core.text'
        ? multilineWidgetHeight(w.rows, tokens)
        : w.rows * tokens.rowHeight
      const height = baseHeight + (flexible
        ? flexibleShare + (flexibleIndex === flexibleRows.length - 1 ? flexibleRemainder : 0)
        : 0)
      if (flexible) flexibleIndex += 1
      // Keep the capsule and its edge controls clear of sockets on either
      // border. The symmetric side also reserves space for output widgets.
      const inset = tokens.pinRadius + WIDGET_PIN_GAP
      rows.push({ kind: 'widget', y, height, inset, ...w })
      // Widget-backed inputs are connectable: pin at the first row line.
      pins.push({
        ...annotationsOf(w), portId: w.inputId, label: w.label, direction: 'in', y: y + tokens.rowHeight / 2, type: w.type,
        ...(w.optional ? { optional: true as const } : {}),
        ...(w.familyLiteral ? {} : { widgetBacked: true as const }),
      })
      // A static memberless widget can also produce its effective value. The
      // duplicate right-edge anchor deliberately shares the input's elab key.
      if (!w.familyLiteral && w.address.members === undefined)
        pins.push({
          ...annotationsOf(w), portId: w.inputId, label: w.label, direction: 'out', y: y + tokens.rowHeight / 2, type: w.type, widgetTap: true,
          ...(staticWidgetInputs.has(w.inputId) ? { staticWidgetTap: true as const } : {}),
        })
      if (row.sectionId === advancedSectionId && advancedBounds !== undefined) {
        advancedBounds.bottom = y + height
      }
      y += height
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
  let width = Math.max(tokens.nodeMinWidth, titleWidth + tokens.padX * 2 + 8)
  for (const row of rows) {
    let content = 0
    if (row.kind === 'ports') {
      const inW = row.input ? measure(row.input.label, 'label') + tokens.pinRadius * 2 + 6 : 0
      const outW = row.output ? measure(row.output.label, 'label') + tokens.pinRadius * 2 + 6 : 0
      content = inW + outW + (row.input && row.output ? 24 : 0)
    } else if (row.kind === 'section') {
      // Label + the disclosure triangle.
      content = measure(row.label, 'label') + 18
    } else if (row.kind === 'growth') {
      // '+ label' text plus capsule padding.
      content = measure(`+ ${row.label}`, 'label') + 18
    } else {
      // Label + a value area floor; widget content depth lives in the
      // expanded editor, so rows never force extreme widths.
      content = measure(row.label, 'label') + 12 + 90
    }
    width = Math.max(width, content + tokens.padX * 2)
  }
  width = Math.min(width, tokens.nodeMaxAutoWidth)

  // Manual override: width may shrink to the global floor (content
  // truncates), height may only grow (rows never compress).
  const minHeight = naturalHeight
  const sizeOverride = options.size
  if (sizeOverride) {
    width = Math.max(tokens.nodeMinWidth, sizeOverride.width)
  }
  const height = sizeOverride ? Math.max(minHeight, sizeOverride.height) : naturalHeight

  if (options.minimized) {
    const minimizedHeight = tokens.headerHeight + tokens.padBottom
    const minimizedWidth = Math.min(
      tokens.nodeMaxAutoWidth,
      Math.max(MINIMIZED_NODE_MIN_WIDTH, titleWidth + tokens.padX * 2 + 8),
    )
    return {
      width: minimizedWidth,
      height: minimizedHeight,
      minWidth: MINIMIZED_NODE_MIN_WIDTH,
      minHeight: minimizedHeight,
      headerHeight: tokens.headerHeight,
      title,
      titleRenamed,
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
    minWidth: tokens.nodeMinWidth,
    minHeight,
    headerHeight: tokens.headerHeight,
    title,
    titleRenamed,
    rows,
    pins,
    ...(advancedBounds !== undefined
      ? { advancedGroup: { y: advancedBounds.y, height: advancedBounds.bottom - advancedBounds.y } }
      : {}),
  }
}

/** Minimized nodes may be narrower than ordinary editable node bodies. */
export const MINIMIZED_NODE_MIN_WIDTH = 80

/** Visual gap between a pin circle and widget chrome. */
export const WIDGET_PIN_GAP = 4

/** One boundary item rendered as a pseudo-node row (scene supplies these). */
export interface BoundarySlotInfo {
  /** Boundary item id (pin portId; NEVER split - boundary ids may contain dots). */
  readonly id: string
  readonly label: string
  /** Derived instance-facing type, when the boundary schema derives cleanly. */
  readonly type?: TypeExpr
  /** Whole-family forwarding: rendered with a family marker. */
  readonly family?: true
  /** Derived source for the immediate enclosing region's iteration index. */
  readonly regionIndex?: true
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
): NodeLayout {
  const direction = side === 'inputs' ? 'out' : 'in'
  const title = side === 'inputs' ? 'Inputs' : 'Outputs'
  const rows: LayoutRow[] = []
  const pins: PinLayout[] = []
  let y = tokens.headerHeight
  for (const slot of slots) {
    const height = tokens.rowHeight
    const label = slot.family ? `${slot.label} []` : slot.label
    const type: TypeExpr = slot.type ?? { kind: 'wildcard' }
    const portSlot: PortSlot = { portId: slot.id, label, type, address: { port: slot.id }, ...(slot.regionIndex ? { regionIndex: true } : {}) }
    rows.push({
      kind: 'ports',
      y,
      height,
      ...(direction === 'in' ? { input: portSlot } : { output: { ...portSlot, index: pins.length } }),
    })
    pins.push({ address: { port: slot.id }, portId: slot.id, direction, y: y + height / 2, type, ...(slot.regionIndex ? { regionIndex: true } : {}) })
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

  let width = Math.max(tokens.nodeMinWidth, measure(title, 'title') + tokens.padX * 2 + 8)
  for (const row of rows) {
    if (row.kind !== 'ports') continue
    const slot = row.input ?? row.output
    if (!slot) continue
    width = Math.max(width, measure(slot.label, 'label') + tokens.pinRadius * 2 + 6 + tokens.padX * 2)
  }
  width = Math.min(width, tokens.nodeMaxAutoWidth)

  const height = y + tokens.padBottom
  return {
    width,
    height,
    minWidth: tokens.nodeMinWidth,
    minHeight: height,
    headerHeight: tokens.headerHeight,
    title,
    rows,
    pins,
  }
}
