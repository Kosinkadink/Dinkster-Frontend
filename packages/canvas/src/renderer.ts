/**
 * Canvas2D renderer (initial implementation spike): draws a Scene with pan/zoom, DPR handling,
 * viewport culling, per-node execution state styling, and widget rows painted
 * through an injected WidgetPainter (registry-backed in the app; a plain
 * label/value fallback here). Framework-free; subscribes to nothing - the
 * owner pushes scene/state and the renderer repaints on a rAF dirty loop.
 */

import { atomNamesOf, canonicalTypeIdOf, cardinalityOf, effectiveWidgetDefault, formatWidgetValue, t as translate, type CanvasLayerContribution, type CanvasLayerNode, type Json, type NodeDecoration, type NodeProgress, type NodeRunState, type TypeExpr } from '@dinkster/core'
import {
  BYPASSED_BADGE,
  LAST_RUN_BADGE,
  layoutNodeBadges,
  MUTED_BADGE,
  nodeBadgeBounds,
  type BadgePlacement,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  outputRowKey,
  type BadgeMap,
  type NodeBadge,
  type ProblemKind,
  type RowProblemMap,
} from './badges.js'
import { controllerChipRect, controllerChipTextRight, CONTROLLER_CHIP_TEXT_GAP, EDGE_ACTION_GLYPH_HALF, edgeActionCenterX, widgetFieldBounds } from './controller-chip.js'
import { linkBounds, linkControlOffset, minimizeArrowRect, previewEdgeShown } from './hit.js'
import { animationFrameAt, containRect, minimizedStripContent, previewHasPanel, splitPreviewRect, type OutputTextMap, type PreviewMap } from './previews.js'
import { memberSpans, projectNodeLayoutHeight, projectPictureHeight, projectTextBoxLines, TITLE_START, widgetChromeRect, withCompactPreviewRegion, withFoldedPreviewRegion, withPreviewRegion, withTextOutputRegion, type LayoutRow, type MemberGrip, type NodeLayout, type NoteLookupLine, noteLookupRows } from './layout.js'
import {
  boundaryFieldNode,
  boundarySceneId,
  GROUP_HEADER_HEIGHT,
  previewFoldedOf,
  REROUTE_RADIUS,
  REROUTE_SOCKET_OFFSET,
  REROUTE_SOCKET_RADIUS,
  sceneEndId,
  structuralEqual,
  type Scene,
  type SceneBoundaryNode,
  type SceneGroup,
  type SceneLinkEnd,
  type SceneNetStub,
  type SceneNode,
} from './scene.js'
import {
  BOUNDARY_SELECTION_OUTLINE_OUTSET,
  MULTI_SELECTION_OUTLINE_PAD,
  MULTI_SELECTION_OUTLINE_STROKE_WIDTH,
  NODE_SELECTION_OUTLINE_OUTSET,
  SELECTION_OUTLINE_STROKE_WIDTH,
  TOOLBOX_GAP_FROM_ATTACHED_BADGE,
  toolboxLayout,
  type ToolboxLayout,
  type ToolboxRow,
} from './toolbox.js'
import { paintSeedControllerIcon, paintToolboxIcon } from './icons.js'
import { CANVAS_DETAIL_MIN_SCALE, canvasDetailLevel, canvasPaintTokens, defaultTokens, presentedType, typeColor, type CanvasDetailLevel, type DesignTokens, type RowGeometry } from './tokens.js'
import { fitText, measureWidth, shareRowWidth, wrapText } from './text-fit.js'

/**
 * Views whose editor is parked. Such a row opens nothing, so the
 * `raised-editors` look draws it as a plain inset row showing its summary,
 * with no icon, chevron or hover wash. Its icon stays in the registry
 * painter's table of raised rows for when an editor returns.
 */
export const PARKED_EDITOR_VIEWS: ReadonlySet<string> = new Set(['core.compositor'])

/** Pin color for a declared type: canonical id (closed lists included) when
 * the type is recursively closed, else the neutral default. */
const pinColorOf = (t: DesignTokens, type: TypeExpr): string =>
  presentedType(t, type).color

export interface PinSlice {
  readonly startAngle: number
  readonly endAngle: number
  readonly color: string
}

/** Generic one-line JSON display used by non-widget data panels. */
export const companionText = (value: Json): string =>
  (typeof value === 'string' ? value : JSON.stringify(value)).split('\n')[0] ?? ''

/**
 * The first MultiType divider sits perpendicular to the node border,
 * pointing at the noodle side (inputs live on the left border, outputs on
 * the right), so the split reads as a deliberate seam rather than an
 * arbitrary rotation.
 */
export const pinBaseAngle = (direction: 'in' | 'out'): number => (direction === 'in' ? Math.PI : 0)

/** Convert a finite accepted type set into one pie wedge per member. */
export const pinSlices = (
  tokens: DesignTokens,
  type: TypeExpr,
  direction: 'in' | 'out' = 'out',
): readonly PinSlice[] => {
  const names = type.kind === 'union'
    ? type.names
    : type.kind === 'variable' && type.allowedTypes !== undefined && type.allowedTypes.length > 0
      ? atomNamesOf(type)
      : undefined
  if (names === undefined || names.length === 0) return []
  const span = (Math.PI * 2) / names.length
  const base = pinBaseAngle(direction)
  return names.map((name, index) => ({
    startAngle: base + span * index,
    endAngle: base + span * (index + 1),
    color: typeColor(tokens, name),
  }))
}

export const PIN_SLICE_DIVIDER_SCREEN_PX = canvasPaintTokens.pin.dividerScreen
export const PIN_SLICE_DIVIDER_MIN_WORLD = canvasPaintTokens.pin.dividerMinWorld
export const PIN_SLICE_DIVIDER_MAX_WORLD = canvasPaintTokens.pin.dividerMaxWorld

/**
 * Diamond pins (definitely-list cardinality) scale their vertex radius up so
 * the smaller diamond area reads as the same visual weight as circle pins.
 */
export const PIN_DIAMOND_SCALE = canvasPaintTokens.pin.diamondScale

export type PinShape = 'circle' | 'diamond' | 'scalar-list'

interface PinPaint {
  readonly shape: PinShape
  readonly colors: readonly string[]
  readonly optional: boolean
  readonly x: number
  readonly y: number
  readonly radius: number
  readonly scale: number
  readonly background: string
  /** Wildcard/Any pins use a neutral body with a dashed outer identity ring. */
  readonly any?: boolean
  /** First MultiType divider angle (see pinBaseAngle). Defaults to 0. */
  readonly baseAngle?: number
}

/**
 * Shape axis of a pin: cardinality decides, everything else is fill/ring. A
 * pin that accepts a list takes one value or a list whatever its type is
 * matched to, so it keeps the one-value-or-list shape: an input's pin, or
 * the pin a subgraph's Inputs panel shows for such an input.
 */
export const pinShapeOf = (type: TypeExpr, direction: 'in' | 'out' = 'out', acceptsList = false): PinShape => {
  if (acceptsList) return 'scalar-list'
  if (cardinalityOf(type) === 'list') return 'diamond'
  if (direction === 'in' && type.kind === 'variable' &&
      (type.allowedTypes === undefined || type.allowedTypes.length === 0)) return 'scalar-list'
  return 'circle'
}

const EITHER_PIN = {
  diamond: canvasPaintTokens.pin.eitherDiamond,
  circle: canvasPaintTokens.pin.eitherCircle,
  ring: canvasPaintTokens.pin.eitherRing,
}

/** The radius of a pin's outer outline: a diamond's corner, or a circle's radius. */
const pinShapeRadius = (shape: PinShape, radius: number): number =>
  shape === 'diamond' ? radius * PIN_DIAMOND_SCALE : shape === 'scalar-list' ? radius * EITHER_PIN.diamond : radius

const pinShapeRadialScale = (shape: PinShape): number =>
  shape === 'diamond' ? PIN_DIAMOND_SCALE : shape === 'scalar-list' ? EITHER_PIN.diamond : 1

/** Trace the pin's outer outline path for the shape axis (no fill/stroke). */
const pinOutlinePath = (ctx: CanvasRenderingContext2D, shape: PinShape, x: number, y: number, r: number): void => {
  ctx.beginPath()
  if (shape === 'circle') {
    ctx.arc(x, y, r, 0, Math.PI * 2)
    return
  }
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r, y)
  ctx.closePath()
}

/** Fill one pin outline with a single color or MultiType wedges. */
const fillPinBody = (
  ctx: CanvasRenderingContext2D,
  pin: PinPaint,
  colors: readonly string[],
  shape: PinShape,
  r: number,
): void => {
  if (colors.length === 1) {
    pinOutlinePath(ctx, shape, pin.x, pin.y, r)
    ctx.fillStyle = colors[0]!
    ctx.fill()
    return
  }
  // MultiType wedges and dividers clip to the outline so ONE fill
  // implementation covers every shape; wedge arcs deliberately overshoot
  // the outline (r * 2 reaches past a diamond's corners).
  const base = pin.baseAngle ?? 0
  const span = (Math.PI * 2) / colors.length
  ctx.save()
  pinOutlinePath(ctx, shape, pin.x, pin.y, r)
  ctx.clip()
  for (const [index, color] of colors.entries()) {
    ctx.beginPath()
    ctx.moveTo(pin.x, pin.y)
    ctx.arc(pin.x, pin.y, r * 2, base + span * index, base + span * (index + 1))
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  }
  ctx.strokeStyle = pin.background
  ctx.lineWidth = Math.min(
    PIN_SLICE_DIVIDER_MAX_WORLD,
    Math.max(PIN_SLICE_DIVIDER_MIN_WORLD, PIN_SLICE_DIVIDER_SCREEN_PX / pin.scale),
  )
  for (let index = 0; index < colors.length; index += 1) {
    const angle = base + span * index
    ctx.beginPath()
    ctx.moveTo(pin.x, pin.y)
    ctx.lineTo(pin.x + Math.cos(angle) * r * 2, pin.y + Math.sin(angle) * r * 2)
    ctx.stroke()
  }
  ctx.restore()
}

/**
 * Paint a pin from independent shape, fill-pattern, and optionality axes. The
 * one-value-or-list pin is the list diamond with a smaller circle in front,
 * separated by a dark ring.
 */
const paintPin = (ctx: CanvasRenderingContext2D, pin: PinPaint): void => {
  const colors = pin.colors.length === 0 ? [pin.background] : pin.colors
  const r = pinShapeRadius(pin.shape, pin.radius)
  fillPinBody(ctx, pin, colors, pin.shape, r)
  pinOutlinePath(ctx, pin.shape, pin.x, pin.y, r)
  ctx.strokeStyle = pin.background
  ctx.lineWidth = canvasPaintTokens.pin.outlineStroke
  if (pin.any) ctx.setLineDash([...canvasPaintTokens.dash.anyPin])
  ctx.stroke()
  if (pin.any) ctx.setLineDash([])
  if (pin.shape === 'scalar-list') {
    const circle = pin.radius * EITHER_PIN.circle
    fillPinBody(ctx, pin, colors, 'circle', circle)
    pinOutlinePath(ctx, 'circle', pin.x, pin.y, circle)
    ctx.strokeStyle = pin.background
    ctx.lineWidth = pin.radius * EITHER_PIN.ring
    ctx.stroke()
  }
  if (pin.optional) {
    ctx.beginPath()
    ctx.arc(pin.x, pin.y, Math.max(canvasPaintTokens.pin.optionalMinRadius, pin.radius * canvasPaintTokens.pin.optionalRadiusRatio), 0, Math.PI * 2)
    ctx.fillStyle = pin.background
    ctx.fill()
  }
}

/** Paint one ordinary pin or its MultiType slices. */
const paintTypedPin = (
  ctx: CanvasRenderingContext2D,
  tokens: DesignTokens,
  type: TypeExpr,
  x: number,
  y: number,
  scale: number,
  optional = false,
  direction: 'in' | 'out' = 'out',
  radius = tokens.pinRadius,
  acceptsList = false,
): void => {
  // Shape carries cardinality; fill pattern, wildcard ring, and color come
  // from the ELEMENT type, so list<union<...>> segments the diamond and
  // list<Any> keeps the dashed identity ring. typeColor also peels canonical
  // 'list<...>'/'asset<...>' ids, so color always says what data flows.
  let element: TypeExpr = type
  while (element.kind === 'list' || element.kind === 'asset') element = element.element
  const slices = pinSlices(tokens, element, direction)
  paintPin(ctx, {
    shape: pinShapeOf(type, direction, acceptsList),
    colors: slices.length === 0 ? [pinColorOf(tokens, type)] : slices.map((slice) => slice.color),
    optional,
    x,
    y,
    radius,
    scale,
    background: tokens.colors.canvasBackground,
    any: element.kind === 'wildcard',
    baseAngle: pinBaseAngle(direction),
  })
}

export interface Viewport {
  readonly x: number
  readonly y: number
  readonly scale: number
}

/**
 * A companion (propagated) value for one widget row: what the link-driven
 * input WOULD execute with. Display-only - the stored dormant value stays
 * untouched underneath. `stale` marks execution-derived values whose
 * upstream has since changed (document-static literals are always exact).
 */
export interface CompanionDisplay {
  readonly value: Json
  /**
   * expected=current proof, cached=recipe-proven older run, stale=unproven,
   * estimate=locally computed from a schema-declared mirror (display only).
   */
  readonly state?: 'expected' | 'cached' | 'stale' | 'estimate'
  /** Compatibility for existing callers; new retained values use state. */
  readonly stale?: boolean
}

/** node id -> widget row valueKey -> companion. Derived, never stored. */
export type CompanionMap = Readonly<Record<string, Readonly<Record<string, CompanionDisplay>>>>

/** What a folded editor's row reads when it depends on more than the row's own value, such as a clip's length or a run's images. */
export interface EditorSummary {
  /** What the row reads in place of the view's own value text. */
  readonly text?: string
  /** The value the row draws in place of the stored one, such as what a wire brought; null when nothing is known yet. */
  readonly value?: Json
  /** Drawn in the placeholder color, for an editor that holds nothing. */
  readonly placeholder?: boolean
  /** A small picture before the text, such as the stored frame or the last 3D view. */
  readonly thumbnail?: CanvasImageSource
}

/** node id -> value key -> what that folded editor row reads. Derived by the host, never stored. */
export type EditorSummaryMap = Readonly<Record<string, Readonly<Record<string, EditorSummary>>>>

/**
 * node id -> row key -> strongest problem on that row. Widget rows key by
 * valueKey, fallback rows (unresolved schema) by their stored value key, and
 * inputs drawn without a field by their port id. Derived per scene build,
 * never stored.
 */
export type RowMarkMap = RowProblemMap

/**
 * One row of a data-lens panel: label left, text right. Tones follow the
 * companion design language ('value' = execution-derived companion color,
 * 'stale' additionally dimmed like stale companions, 'muted' = chrome).
 */
export interface DataPanelRow {
  readonly label: string
  readonly text: string
  readonly tone?: 'value' | 'muted' | 'stale'
}

/**
 * Data lens (alternate canvas view): node id -> panel rows drawn OVER the
 * node body. Undefined = lens off. Layout is untouched by contract - nodes
 * keep their size, position, pins, and header; only the body content is
 * re-skinned, so spatial memory survives switching lenses.
 */
export type DataPanelMap = Readonly<Record<string, readonly DataPanelRow[]>>

export interface WidgetRowAffordance {
  readonly active: boolean
  readonly label: string
  readonly disabled?: boolean
}

/** Renderer-facing lens capabilities. Lens ids never enter the paint path. */
export interface RendererLensCapabilities {
  readonly typeAdornments?: boolean
  readonly nodeBodyContent?: (node: SceneNode) => readonly DataPanelRow[] | null
  readonly widgetRowAffordance?: (
    node: SceneNode,
    row: Extract<LayoutRow, { kind: 'widget' }>,
  ) => WidgetRowAffordance | undefined
  readonly previewSurfaceAffordance?: (node: SceneNode) => WidgetRowAffordance | undefined
}

/** Row-local geometry shared by lens-affordance paint and interaction. */
export function widgetRowAffordanceRect(
  rowWidth: number,
  rowHeight: number,
  row: Extract<LayoutRow, { kind: 'widget' }>,
  geometry: RowGeometry,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const paint = canvasPaintTokens.lensAffordance
  const size = Math.max(paint.rowMinSize, Math.min(paint.rowMaxSize, rowHeight - paint.rowPadding))
  const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
  const trailingEdge = row.controllerMode !== undefined
    ? controllerChipRect(rowWidth, rowHeight, geometry).x - CONTROLLER_CHIP_TEXT_GAP
    : rowWidth - (numeric ? geometry.stepperZone + CONTROLLER_CHIP_TEXT_GAP : CONTROLLER_CHIP_TEXT_GAP)
  return {
    x: Math.max(
      geometry.stepperZone + CONTROLLER_CHIP_TEXT_GAP,
      trailingEdge - size,
    ),
    y: (rowHeight - size) / 2,
    width: size,
    height: size,
  }
}

/** Node-local geometry for the Exposure lens control over a preview surface. */
export function previewSurfaceAffordanceRect(
  node: SceneNode,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined {
  const region = node.layout.preview ?? node.layout.textOutput
  if (region === undefined) return undefined
  const paint = canvasPaintTokens.lensAffordance
  const size = paint.previewSize
  const caption = Math.min(region.height, defaultTokens.previewCaptionHeight)
  // Over the picture or text when there is one, else at the caption row's end.
  return {
    x: region.x + region.width - size - paint.previewInset,
    y: region.height > caption ? region.y + caption + paint.previewInset : region.y + (caption - size) / 2,
    width: size,
    height: size,
  }
}

const TYPE_ADORNMENT_MAX_TEXT = 512
const TYPE_ADORNMENT_MAX_VISIBLE = 8192

interface AdornmentBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

type TypeAdornmentDescriptor = Readonly<{
  id: string
  phase: 'over-scene'
  text: string
  textRole: 'primary'
  fontRole: 'compact-semibold' | 'compact-small-semibold'
  x: number
  y: number
  bounds: AdornmentBounds
}> & (
  | { readonly anchor: 'link-midpoint'; readonly link: Scene['links'][number] }
  | { readonly anchor: 'node'; readonly node: SceneNode }
)

/**
 * What a text result's caption says at its right end: the string's own lines,
 * line breaks plus one, not counting a final line break. Like a picture's
 * size, it does not change with the node's width.
 */
const textResultLineCount = (text: string): string => {
  const own = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  if (own.length === 0) return 'empty'
  const count = own.split('\n').length
  return `${count} ${count === 1 ? 'line' : 'lines'}`
}

const boundedAdornmentText = (text: string): string =>
  text.length <= TYPE_ADORNMENT_MAX_TEXT
    ? text
    : `${text.slice(0, TYPE_ADORNMENT_MAX_TEXT - 3)}...`

const adornmentTextColor = (
  tokens: DesignTokens,
  role: TypeAdornmentDescriptor['textRole'],
): string => {
  switch (role) {
    case 'primary': return tokens.colors.title
  }
}

const conservativeTextBounds = (
  text: string,
  fontSize: number,
  x: number,
  y: number,
  align: 'center-bottom' | 'right-middle',
): AdornmentBounds => {
  const paint = canvasPaintTokens.adornment
  const antialiasPad = paint.antialiasPadding
  const width = Math.max(fontSize, text.length * fontSize * paint.boundsFontFactor)
  const height = fontSize * paint.boundsFontFactor
  return align === 'center-bottom'
    ? {
        x: x - width / 2 - antialiasPad,
        y: y - height - antialiasPad,
        width: width + antialiasPad * 2,
        height: height + antialiasPad * 2,
      }
    : {
        x: x - width - antialiasPad,
        y: y - height / 2 - antialiasPad,
        width: width + antialiasPad * 2,
        height: height + antialiasPad * 2,
      }
}

const typeAdornmentsOf = (scene: Scene, tokens: DesignTokens): readonly TypeAdornmentDescriptor[] => {
  const descriptors: TypeAdornmentDescriptor[] = []
  for (const link of scene.links) {
    if (link.hidden === true) continue
    if (!link.typeName) continue
    const text = boundedAdornmentText(presentedType(tokens, { kind: 'concrete', name: link.typeName }).label)
    const x = 0
    const y = canvasPaintTokens.adornment.linkOffsetY
    descriptors.push({
      id: `core.types:link:${link.id}`,
      phase: 'over-scene',
      anchor: 'link-midpoint',
      link,
      text,
      textRole: 'primary',
      fontRole: 'compact-semibold',
      x,
      y,
      bounds: conservativeTextBounds(text, tokens.fontSize, x, y, 'center-bottom'),
    })
  }
  for (const node of scene.nodes) {
    for (const row of node.layout.rows) {
      if (row.kind !== 'ports' || !row.output) continue
      const solvedPin = node.layout.pins.find((pin) =>
        pin.direction === 'out' && pin.widgetTap !== true && pin.portId === row.output!.portId)
      const text = boundedAdornmentText(presentedType(tokens, solvedPin?.type ?? row.output.type).label)
      const fontSize = Math.max(canvasPaintTokens.type.adornmentMinSize, tokens.fontSize - canvasPaintTokens.type.adornmentReduction)
      const x = node.layout.width - tokens.padX - tokens.pinRadius - canvasPaintTokens.adornment.outputPinGap
      const y = row.y + row.height / 2 + canvasPaintTokens.adornment.outputOffsetY
      descriptors.push({
        id: `core.types:node-output:${node.id}:${row.output.portId}`,
        phase: 'over-scene',
        anchor: 'node',
        node,
        text,
        textRole: 'primary',
        fontRole: 'compact-small-semibold',
        x,
        y,
        bounds: conservativeTextBounds(text, fontSize, x, y, 'right-middle'),
      })
    }
  }
  return descriptors
}

export interface WidgetPaintArgs {
  readonly ctx: CanvasRenderingContext2D
  readonly row: Extract<LayoutRow, { kind: 'widget' }>
  readonly value: Json | undefined
  /** Present when a link/net drives this input: paint THIS, read-only. */
  readonly companion?: CompanionDisplay
  /** Alpha before connected-row dimming, reserved for legible companion text. */
  readonly companionAlpha?: number
  /** What the host says this editor row reads, in place of the text its view derives from the value. */
  readonly editorSummary?: EditorSummary
  /** Alpha for the subgraph mark (row.subgraphMark), which a driven row does not dim. */
  readonly markAlpha?: number
  /** Absolute content origin/size (inside node padding). */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly rowHeight: number
  readonly connected: boolean
  /** True only while the pointer is over this complete widget row. */
  readonly hovered?: boolean
  /** The row is being dragged; `value` is the value under the pointer, not yet stored. */
  readonly dragging?: boolean
  readonly tokens: DesignTokens
}

/** A row the pointer is dragging, painted with the value under the pointer until release stores it. */
export interface RowDrag {
  readonly nodeId: string
  readonly valueKey: string
  readonly value: Json
}

export type WidgetPainter = (args: WidgetPaintArgs) => void

/** In-flight link drag, drawn on top of the scene. */
export interface GhostLink {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  readonly typeName?: string
}

export interface PlacementGhost {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly title: string
}

/**
 * Structured scope-preview overlay: in-scope membership for every kind of
 * scene entity a wire can touch. Built from the core ScopeClosure (one
 * semantic source of truth) - the renderer only tests membership.
 */
export interface ScopeHighlight {
  readonly nodes: ReadonlySet<string>
  readonly reroutes: ReadonlySet<string>
}

/** Ephemeral overlay state owned by the interaction layer (never document state). */
export interface OverlayState {
  readonly selection?: ReadonlySet<string>
  readonly linkSelection?: ReadonlySet<string>
  readonly rerouteSelection?: ReadonlySet<string>
  readonly groupSelection?: ReadonlySet<string>
  readonly netViewSelection?: ReadonlySet<string>
  /** Live drag offsets by node OR reroute id (world units); committed on release. */
  readonly dragOffsets?: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>
  readonly ghostLink?: GhostLink
  /** Multi-noodle drag (an output's fan-out moving as one): drawn like ghostLink. */
  readonly ghostLinks?: readonly GhostLink[]
  /** Scene links suppressed while a rewire drag's ghost stands in for them. */
  readonly hiddenLinkIds?: ReadonlySet<string>
  /** Pins revealed as legal drop targets during a link drag: 'nodeId:portId:dir'. */
  readonly dropTargets?: ReadonlySet<string>
  /** Node whose body currently resolves to the highlighted auto-selected pin. */
  readonly bodyDropNode?: string
  /** Field row under a link drag that takes the wire when dropped. */
  readonly dropRow?: { readonly nodeId: string; readonly valueKey: string }
  /** The reroute whose ghost in/out sockets are revealed (pointer hover). */
  readonly hoveredReroute?: string
  /** Link whose midpoint handle is under the idle pointer. */
  readonly hoveredLinkMidpoint?: string
  /** Node under the idle pointer: its widget-backed input pins reveal. */
  readonly hoveredNode?: string
  /** One ordinary node pin under the idle pointer; identity is allocation-light. */
  readonly hoveredPin?: {
    readonly nodeId: string
    readonly portId: string
    readonly direction: 'in' | 'out'
    readonly widgetTap?: true
  }
  /** Keyboard-focused semantic pin. */
  readonly focusedPin?: {
    readonly nodeId: string
    readonly portId: string
    readonly direction: 'in' | 'out'
    readonly widgetTap?: true
  }
  /** One widget row under the idle pointer. */
  readonly hoveredWidget?: { readonly nodeId: string; readonly valueKey: string }
  /** A box's header, closed row or tab under the idle pointer, by box key. */
  /** A box under the pointer; `target` names the field a held wire would reach in a closed box. */
  readonly hoveredBox?: { readonly nodeId: string; readonly boxId: string; readonly target?: string }
  /** A button on a node under the idle pointer, by `growth:<group>` or `button:<id>`: its face lightens. */
  readonly hoveredButton?: { readonly nodeId: string; readonly key: string }
  /** A button on a node held down, keyed as hoveredButton: it sinks. */
  readonly pressedButton?: { readonly nodeId: string; readonly key: string }
  /** The member grip under the pointer: drawn brighter. */
  readonly hoveredGrip?: { readonly nodeId: string; readonly construct: string; readonly member: string }
  /**
   * A member being dragged by its grip: it is dimmed where it stands, and
   * `line` (node-local) marks where a release would put it.
   */
  readonly memberDrag?: {
    readonly nodeId: string
    readonly construct: string
    readonly member: string
    readonly line?: { readonly x: number; readonly y: number; readonly width: number }
  }
  readonly hoveredBadge?: { readonly nodeId: string; readonly badgeId: string }
  /** The node whose title-bar minimize arrow is under the idle pointer. */
  readonly hoveredMinimize?: string
  /** Live rubber-band selection rectangle (world coords, normalized). */
  readonly marquee?: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  /** Live text box height used only for paint; committed as view.setTextBoxLines on release. */
  readonly textBoxLines?: { readonly nodeId: string; readonly valueKey: string; readonly lines: number }
  /** Live height of an unfolded editor's picture used only for paint; committed as view.setPictureHeight on release. */
  readonly pictureHeight?: { readonly nodeId: string; readonly valueKey: string; readonly height: number }
  /** The text box edge under the pointer, being dragged, or holding keyboard focus. */
  readonly textBoxEdge?: { readonly nodeId: string; readonly valueKey: string }
  /** The node whose preview caption row is under the idle pointer. */
  readonly hoveredPreviewCaption?: string
  /** The node whose preview bar (its bottom edge) is under the pointer or being dragged. */
  readonly previewEdge?: string
  /** Live node geometry used only for paint; committed as view.setNodeSize on release. */
  readonly resizePreview?: { readonly nodeId: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Live group-drag offset (member nodes ride dragOffsets); committed as view.moveGroup. */
  readonly groupDragOffset?: { readonly groupId: string; readonly dx: number; readonly dy: number }
  /** Live group-resize preview; committed as view.setGroupBounds on release. */
  readonly groupResizeGhost?: { readonly groupId: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  /** Pending node placement preview, centered near the live pointer in world coordinates. */
  readonly placementGhost?: PlacementGhost
}

/**
 * One remote participant's ephemeral presence, projected for painting.
 * Derived by the app from presence frames (never document state, mirroring
 * OverlayState's "ephemeral, interaction-owned" posture): the renderer only
 * paints what it is handed - cursors and selection tints for actors viewing
 * the CURRENT graph; the app filters by graph before calling setPresence.
 */
export interface PresenceActor {
  readonly id: string
  /** Short human-readable tag drawn beside the cursor. */
  readonly label: string
  /** CSS color, deterministic per actor (app-side hash of the actor id). */
  readonly color: string
  /** World-space cursor position; absent while the actor's pointer is off-canvas. */
  readonly cursor?: { readonly x: number; readonly y: number }
  /** Node ids the actor has selected (current graph only). */
  readonly selection: ReadonlySet<string>
  /** Reroute ids the actor has selected (current graph only). */
  readonly rerouteSelection?: ReadonlySet<string>
  /** Node id under the actor's idle pointer (faint outline, weaker than selection). */
  readonly hover?: string
  /**
   * The actor's in-progress drag: world offsets per scene id. Dragged nodes
   * and reroutes paint dashed ghosts at the offset position; real entities
   * stay put until the op commits (presence never mutates scene layout).
   * Ids not in the current scene are ignored.
   */
  readonly drag?: ReadonlyMap<string, { readonly dx: number; readonly dy: number }>
  /** In-progress remote noodle. Resolved only for paint, never hit testing. */
  readonly link?: {
    readonly origin:
      | {
          readonly kind: 'port'
          readonly node: string
          readonly port: string
          readonly side: 'in' | 'out'
        }
      | { readonly kind: 'widgetTap'; readonly node: string; readonly input: string }
      | { readonly kind: 'reroute'; readonly reroute: string; readonly side?: 'in' | 'out' }
    readonly cursor: { readonly x: number; readonly y: number }
  }
  /**
   * The actor's visible world rectangle. The MAIN canvas deliberately does
   * not paint it (a full-viewport rectangle is noise at 1:1); the minimap
   * projects it as a colored "where are they" frame. Carried here so both
   * surfaces read presence from the one installed set.
   */
  readonly view?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

/**
 * Drop-target key for a node pin. A widget tap deliberately shares its
 * input's port id on the 'out' side, so tap pins get a distinct `:tap`
 * suffix - otherwise a real output with the same id (LoadImage 'image')
 * would collide: one compatible pin would light up/legalize both.
 */
export const dropTargetKey = (nodeId: string, portId: string, direction: 'in' | 'out', widgetTap = false): string =>
  `${nodeId}:${portId}:${direction}${widgetTap ? ':tap' : ''}`

/** Drop-target key for a reroute junction (distinct namespace from pins). */
export const rerouteTargetKey = (rerouteId: string): string => `reroute::${rerouteId}`

/** Drop-target key for a boundary pseudo-node pin (item id or the add slot). */
export const boundaryTargetKey = (side: 'inputs' | 'outputs', item: string): string =>
  `boundary::${side}::${item}`

/** Dim factor for ghost (unmaterialized dynamic) pins, labels, and widgets. */
const GHOST_ALPHA = canvasPaintTokens.opacity.ghost
const PIN_HOVER_GROWTH = canvasPaintTokens.pin.hoverGrowth
const STATUS_RING_GAP = canvasPaintTokens.pin.statusRingGap
const STATUS_RING_STROKE_WIDTH = canvasPaintTokens.pin.statusRingStroke

/** Half the widest link stroke plus the midpoint dot: pads link bounds so
 * culling and fit account for painted thickness, not just the centerline. */
const LINK_PAINT_PAD = canvasPaintTokens.link.paintPadding

const finiteScale = (scale: number): number => Math.max(scale, Number.EPSILON)

/** Keep critical structure visible without changing its world geometry. */
const screenAwareStroke = (worldWidth: number, scale: number, minScreenWidth: number): number =>
  Math.max(worldWidth, minScreenWidth / finiteScale(scale))

const screenAwareDash = (
  world: readonly number[],
  minimumScreen: readonly number[],
  scale: number,
): number[] => world.map((segment, index) =>
  Math.max(segment, (minimumScreen[index] ?? minimumScreen.at(-1) ?? 1) / finiteScale(scale)))

const nodeStateDash = (state: NodeRunState | undefined, scale: number): number[] | undefined => {
  switch (state) {
    case 'pending':
    case 'cached':
    case 'skipped':
    case 'error': {
      const dash = canvasPaintTokens.stateDash[state]
      return screenAwareDash(dash.world, dash.screen, scale)
    }
    default: return undefined
  }
}

const modeDash = (mode: 'active' | 'muted' | 'bypassed', scale: number): number[] | undefined => {
  if (mode === 'active') return undefined
  const dash = canvasPaintTokens.stateDash[mode]
  return screenAwareDash(dash.world, dash.screen, scale)
}

/** The disclosure triangle shared by section rows, the title-bar minimize arrow and the preview caption's fold arrow. */
function paintDisclosureArrow(ctx: CanvasRenderingContext2D, cx: number, cy: number, open: boolean): void {
  const paint = canvasPaintTokens.node.section
  ctx.beginPath()
  if (open) {
    ctx.moveTo(cx - paint.arrowHalfWidth, cy - paint.arrowBack)
    ctx.lineTo(cx + paint.arrowHalfWidth, cy - paint.arrowBack)
    ctx.lineTo(cx, cy + paint.arrowTip)
  } else {
    ctx.moveTo(cx - paint.arrowBack, cy - paint.arrowHalfWidth)
    ctx.lineTo(cx + paint.arrowTip, cy)
    ctx.lineTo(cx - paint.arrowBack, cy + paint.arrowHalfWidth)
  }
  ctx.closePath()
  ctx.fill()
}

const detailRadius = (radius: number, scale: number, detailLevel: CanvasDetailLevel): number =>
  detailLevel === 'overview' ? screenAwareStroke(radius, scale, canvasPaintTokens.pin.overviewMinRadius) : radius

/**
 * The painted center of a pin on a box's side at edge `x` and row center `y`.
 * Crisp edges draw the 1 px border inside the box, so the pin moves half a
 * line inward to sit centered on it, and half a pixel down so its odd
 * diameter covers whole pixel rows. Wires and hit targets keep the edge and
 * the row center, which the pin covers.
 */
const edgePinPoint = (t: DesignTokens, direction: 'in' | 'out', x: number, y: number): { x: number; y: number } => {
  if (!t.crispEdges) return { x, y }
  const inset = canvasPaintTokens.node.outline.crisp / 2
  return { x: direction === 'in' ? x + inset : x - inset, y: y + canvasPaintTokens.widget.pixelCenter }
}

/**
 * A pin's name on its row, `x` already inset from the node's edge: its
 * capitals are centered on the pin's painted center. Leaves the `middle`
 * baseline and left alignment the row loops use.
 */
const paintPinLabel = (
  ctx: CanvasRenderingContext2D,
  t: DesignTokens,
  label: string,
  x: number,
  rowCenterY: number,
  align: 'left' | 'right',
): void => {
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(label, x, edgePinPoint(t, 'in', x, rowCenterY).y + t.fontSize * canvasPaintTokens.type.capHeight / 2)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
}

/**
 * The radius of a pin's drop and warning ring: it clears the pin by the ring
 * gap, around the one-value-or-list pin's diamond corners too, and keeps that
 * gap as a pointed pin grows from `pinRadius` to `radius`.
 */
const statusRingRadius = (shape: PinShape, pinRadius: number, radius: number): number =>
  (shape === 'scalar-list' ? pinShapeRadius(shape, pinRadius) : pinRadius) + STATUS_RING_GAP +
  (radius - pinRadius) * pinShapeRadialScale(shape)

const statusRingCullPad = (radius: number, scale: number): number =>
  radius + STATUS_RING_GAP + screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH) / 2

const linkCullPad = (scale: number): number =>
  Math.max(canvasPaintTokens.link.cullMinPadding, screenAwareStroke(canvasPaintTokens.link.selectedStroke, scale, canvasPaintTokens.link.selectedMinScreenStroke) / 2)
  + canvasPaintTokens.link.cullScreenPadding / finiteScale(scale)

const structureCullPad = (scale: number, pinRadius: number, detailLevel: CanvasDetailLevel): number => {
  const radius = detailRadius(pinRadius, scale, detailLevel)
  const hoveredRingPad = statusRingCullPad(radius, scale) + PIN_HOVER_GROWTH * Math.SQRT2
  return Math.max(
    PIN_OVERHANG,
    hoveredRingPad,
    canvasPaintTokens.toolbox.nodeSelectionOutset + screenAwareStroke(SELECTION_OUTLINE_STROKE_WIDTH, scale, canvasPaintTokens.toolbox.selectionMinScreenStroke) / 2 + canvasPaintTokens.toolbox.cullScreenPadding / finiteScale(scale),
  )
}

/**
 * World-space bounds of everything the scene persistently paints: nodes,
 * boundary pseudo-nodes, reroute dots, groups,
 * net stub tags, links (control-hull - a reverse link bulges far past both
 * endpoints). Powers fitToScene so "fit" frames the
 * whole drawing, not just the plain nodes.
 */
export function sceneVisualBounds(
  scene: Scene,
  previews: PreviewMap = {},
  badgeBounds?: (node: SceneNode) => { x: number; y: number; width: number; height: number } | undefined,
): { minX: number; minY: number; maxX: number; maxY: number } | undefined {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const include = (x: number, y: number, w: number, h: number): void => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  for (const n of scene.nodes) {
    include(n.x, n.y, n.layout.width, n.layout.height)
    const bounds = badgeBounds?.(n)
    if (bounds) include(bounds.x, bounds.y, bounds.width, bounds.height)
  }
  for (const b of scene.boundaryNodes) include(b.x, b.y, b.layout.width, b.layout.height)
  for (const link of scene.links) {
    if (link.hidden === true) continue
    const b = linkBounds(link.x1, link.y1, link.x2, link.y2)
    include(
      b.minX - LINK_PAINT_PAD,
      b.minY - LINK_PAINT_PAD,
      b.maxX - b.minX + LINK_PAINT_PAD * 2,
      b.maxY - b.minY + LINK_PAINT_PAD * 2,
    )
  }
  for (const r of scene.reroutes) include(r.x - REROUTE_RADIUS, r.y - REROUTE_RADIUS, REROUTE_RADIUS * 2, REROUTE_RADIUS * 2)
  for (const g of scene.groups) include(g.x, g.y, g.width, g.height)
  for (const s of scene.netStubs) include(s.x, s.y, s.width, s.height)
  return minX === Infinity ? undefined : { minX, minY, maxX, maxY }
}

/** Core's sparse world-anchored grid uses the same layer door as packs. */
export function canvasGridLayer(tokens: DesignTokens): CanvasLayerContribution {
  let pattern: CanvasPattern | null | undefined
  let patternSpacing = 0
  let patternPixels = 0
  let patternColor = ''
  return {
    id: 'core.canvas.grid',
    position: 'background',
    order: -1000,
    draw: ({ context, viewport, colors }) => {
      const gridDot = colors?.gridDot ?? tokens.colors.gridDot
      const paint = canvasPaintTokens.grid
      let spacing: number = paint.spacing
      while (spacing * viewport.scale < paint.minScreenSpacing) spacing *= 2
      const pixels = Math.max(1, Math.ceil(spacing * viewport.scale * (globalThis.devicePixelRatio ?? 1)))
      if (pattern === undefined || spacing !== patternSpacing || pixels !== patternPixels || gridDot !== patternColor) {
        const tile = typeof OffscreenCanvas === 'undefined'
          ? context.canvas.ownerDocument.createElement('canvas')
          : new OffscreenCanvas(pixels, pixels)
        tile.width = tile.height = pixels
        const ctx = tile.getContext('2d')!
        const density = pixels / spacing
        ctx.scale(density, density)
        ctx.beginPath()
        // Each corner supplies one quarter of the world-origin dot across repeats.
        for (const y of [0, spacing]) for (const x of [0, spacing]) {
          ctx.moveTo(x + paint.dotRadius, y)
          ctx.arc(x, y, paint.dotRadius, 0, Math.PI * 2)
        }
        ctx.fillStyle = gridDot
        ctx.fill()
        pattern = context.createPattern(tile, 'repeat')
        pattern?.setTransform({ a: 1 / density, d: 1 / density })
        patternSpacing = spacing
        patternPixels = pixels
        patternColor = gridDot
      }
      if (!pattern) return
      context.fillStyle = pattern
      context.fillRect(viewport.x, viewport.y, viewport.width, viewport.height)
    },
  }
}

export class CanvasRenderer {
  private baseScene: Scene = { graphId: '', nodes: [], links: [], reroutes: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [] }
  private scene: Scene = { graphId: '', nodes: [], links: [], reroutes: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [] }
  private connectedInputPins: ReadonlySet<string> = new Set()
  /** Input pins whose wire comes from a muted node: drawn faded with that wire. */
  private mutedInputPins: ReadonlySet<string> = new Set()
  private connectedOutputPins: ReadonlySet<string> = new Set()
  private connectedWidgetTaps: ReadonlySet<string> = new Set()
  /** Inputs driven only by a boundary input drawn without its wire. */
  private wirelessBoundaryInputPins: ReadonlySet<string> = new Set()
  /** Like connectedInputPins but excluding boundary bindings (row inertness). */
  private valueDrivenInputPins: ReadonlySet<string> = new Set()
  /** Inner input (node id, input id) -> the value an Inputs panel field sends it. */
  private panelFieldValues: ReadonlyMap<string, Json> = new Map()
  private nodeStates: Readonly<Record<string, NodeProgress>> = {}
  private viewport: Viewport = { x: canvasPaintTokens.viewport.initialOffset, y: canvasPaintTokens.viewport.initialOffset, scale: 1 }
  private viewportAnimation: { from: Viewport; to: Viewport; started: number; sampled: number } | undefined
  private dirty = true
  private rafId: number | undefined
  private paintEnded = -Infinity
  private paintDuration = 0
  private disposed = false
  private hasRunningNodes = false
  private reducedMotion = false
  private animationTimeMs = 0
  private previewChecker: CanvasPattern | null | undefined
  private readonly graphTiles = new Map<string, ImageBitmap>()
  private graphTileTransform = ''
  private graphTileSurface: OffscreenCanvas | undefined
  private canvasLayers: readonly CanvasLayerContribution[] = []
  private canvasLayerNodes: readonly CanvasLayerNode[] = []
  private canvasLayerError: (id: string, error: unknown) => void = () => {}
  private readonly failedCanvasLayers = new Set<string>()

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private tokens: DesignTokens,
    private readonly paintWidget: WidgetPainter = defaultWidgetPainter,
  ) {
    this.loop = this.loop.bind(this)
    this.scheduleFrame()
  }

  private replacePaintScene(scene: Scene): void {
    const { nodes: beforeNodes, links: beforeLinks, ...before } = this.scene
    const { nodes: afterNodes, links: afterLinks, ...after } = scene
    if (!structuralEqual(before, after) ||
        !structuralEqual(beforeNodes.map((node) => node.id), afterNodes.map((node) => node.id)) ||
        !structuralEqual(beforeLinks.map((link) => link.id), afterLinks.map((link) => link.id))) {
      this.scene = scene
      this.invalidate()
      return
    }
    const changedNodes = new Set(afterNodes.filter((node, index) => !structuralEqual(node, beforeNodes[index])).map((node) => node.id))
    const changedLinks = new Set(afterLinks.filter((link, index) => !structuralEqual(link, beforeLinks[index])).map((link) => link.id))
    for (const link of [...beforeLinks, ...afterLinks]) {
      if (!changedLinks.has(link.id)) continue
      changedNodes.add(sceneEndId(link.from))
      changedNodes.add(sceneEndId(link.to))
    }
    this.invalidateNodeTiles(changedNodes)
    this.scene = scene
    this.invalidateNodeTiles(changedNodes)
    this.requestRender()
  }

  setScene(scene: Scene): void {
    this.baseScene = scene
    this.replacePaintScene(this.sceneWithBodyRegions(scene))
    this.refreshConnectivity()
    this.canvasLayerNodes = Object.freeze(this.scene.nodes.map((node) => Object.freeze({
      id: node.id,
      type: node.node.type,
      title: node.layout.title,
      x: node.x,
      y: node.y,
      width: node.layout.width,
      height: node.layout.height,
    })))
    this.refreshTypeAdornments()
    // Notify AFTER installation so listeners (gesture cancellation) observe
    // the new scene through getScene().
    for (const listener of this.sceneReplacedListeners) listener(this.scene)
  }

  setCanvasLayers(layers: readonly CanvasLayerContribution[], onError?: (id: string, error: unknown) => void): void {
    this.canvasLayers = layers
    this.canvasLayerError = onError ?? (() => {})
    this.failedCanvasLayers.clear()
    this.invalidate()
  }

  private readonly sceneReplacedListeners = new Set<(scene: Scene) => void>()

  /**
   * Observe scene replacement. Anything holding captures derived from the
   * previous scene (an in-flight gesture's ids, rows, positions) must treat
   * them as stale once this fires. Returns an unsubscribe.
   */
  onSceneReplaced(listener: (scene: Scene) => void): () => void {
    this.sceneReplacedListeners.add(listener)
    return () => this.sceneReplacedListeners.delete(listener)
  }

  private overlay: OverlayState = {}

  getOverlay(): OverlayState {
    return this.overlay
  }

  setOverlay(overlay: OverlayState): void {
    const previous = this.overlay
    if (this.getDetailLevel() === 'overview' &&
        (((this.scene.links.length >= 256 || this.scene.reroutes.length >= 256) &&
          (previous.dragOffsets === undefined) !== (overlay.dragOffsets === undefined)) ||
         (this.scene.links.length >= 256 &&
          (previous.resizePreview === undefined) !== (overlay.resizePreview === undefined)))) {
      this.overlay = overlay
      this.invalidate()
      return
    }
    const nodes = new Set<string>()
    const local = new Set<keyof OverlayState>([
      'selection', 'dragOffsets', 'resizePreview', 'bodyDropNode', 'dropRow', 'hoveredNode',
      'hoveredPin', 'focusedPin', 'hoveredWidget', 'hoveredBox', 'hoveredButton', 'pressedButton', 'hoveredGrip', 'memberDrag', 'hoveredBadge', 'hoveredMinimize', 'textBoxLines', 'pictureHeight', 'textBoxEdge', 'hoveredPreviewCaption',
      'previewEdge',
    ])
    const keys = new Set([...Object.keys(previous), ...Object.keys(overlay)] as (keyof OverlayState)[])
    for (const key of keys) {
      const before = previous[key]
      const after = overlay[key]
      if (before === after) continue
      if (key === 'selection' || key === 'linkSelection' || key === 'rerouteSelection' ||
          key === 'groupSelection' ||
          key === 'netViewSelection' || key === 'dropTargets' || key === 'hiddenLinkIds') {
        const left = previous[key]
        const right = overlay[key]
        const changed = [...left ?? [], ...right ?? []].filter((id) => !!left?.has(id) !== !!right?.has(id))
        if (changed.length === 0) continue
        if (key === 'selection') {
          for (const id of changed) nodes.add(id)
          continue
        }
      }
      if (!local.has(key)) {
        this.overlay = overlay
        this.invalidate()
        return
      }
      if (key === 'dragOffsets') {
        for (const id of new Set([...previous.dragOffsets?.keys() ?? [], ...overlay.dragOffsets?.keys() ?? []])) {
          const a = previous.dragOffsets?.get(id)
          const b = overlay.dragOffsets?.get(id)
          if (a?.dx !== b?.dx || a?.dy !== b?.dy) nodes.add(id)
        }
      } else {
        for (const state of [previous, overlay]) {
          const value = state[key]
          if (typeof value === 'string') nodes.add(value)
          else if (value && 'nodeId' in value) nodes.add(value.nodeId)
        }
      }
    }
    this.invalidateNodeTiles(nodes)
    this.overlay = overlay
    this.invalidateNodeTiles(nodes)
    this.dirty = true
    this.scheduleFrame()
  }

  getScene(): Scene {
    return this.scene
  }

  /** Measure a tab's text in the font drawBadgeTabs paints it with. */
  private measureBadgeTabText(text: string): number {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return text.length * this.tokens.badgeTab.fontSize
    const font = ctx.font
    ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${this.tokens.badgeTab.fontSize}px ${this.tokens.fontFamily}`
    const width = measureWidth(ctx, text)
    ctx.font = font
    return width
  }

  /** Measure widget-row text in the same font used by render(). */
  measureWidgetText(text: string): number {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return 0
    ctx.save()
    ctx.font = `${this.tokens.fontSize}px ${this.tokens.fontFamily}`
    const width = ctx.measureText(text).width
    ctx.restore()
    return width
  }

  /** How many lines a text box's value takes once wrapped as the box paints it. */
  textBoxContentLines(node: SceneNode, row: Extract<LayoutRow, { kind: 'widget' }>): number {
    const ctx = this.canvas.getContext('2d')
    const value = row.derivedValue !== undefined ? row.derivedValue : node.node.values[row.valueKey]
    const text = value === undefined || value === null ? '' : formatWidgetValue(value, row.spec)
    if (!ctx) return text.split('\n').length
    const t = this.tokens
    const width = (row.width ?? node.layout.width - row.inset * 2) -
      t.multilineText.scrollbarWidth - t.multilineText.scrollbarInset - t.multilineText.textInset - t.multilineText.padding
    ctx.save()
    ctx.font = `${t.multilineText.fontSize}px ${t.fontFamily}`
    const lines = text.split('\n').reduce((count, line) => count + wrapText(ctx, line, width).length, 0)
    ctx.restore()
    return lines
  }

  /** Screen -> world coordinates. */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    const { x, y, scale } = this.viewport
    return { x: (sx - x) / scale, y: (sy - y) / scale }
  }

  private updateNodePaint(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>, apply: () => void): void {
    const ids = new Set([...Object.keys(before), ...Object.keys(after)].filter((id) => !structuralEqual(before[id], after[id])))
    this.invalidateNodeTiles(ids)
    apply()
    this.invalidateNodeTiles(ids)
    this.requestRender()
  }

  setNodeStates(states: Readonly<Record<string, NodeProgress>>): void {
    this.updateNodePaint(this.nodeStates, states, () => {
      this.nodeStates = states
      this.hasRunningNodes = Object.values(states).some((state) => state.state === 'running')
    })
  }

  setReducedMotion(reduced: boolean): void {
    if (this.reducedMotion === reduced) return
    this.reducedMotion = reduced
    this.invalidate()
  }

  setColors(colors: DesignTokens['colors'], typePaint?: Pick<DesignTokens, 'typeColors' | 'typeFallbackLightness'>): void {
    this.tokens = { ...this.tokens, ...typePaint, colors, stateColors: { ...this.tokens.stateColors, pending: colors.pendingOutline, skipped: colors.skippedOutline } }
    this.previewChecker = undefined
    this.invalidate()
  }

  getTokens(): DesignTokens {
    return this.tokens
  }

  private companions: CompanionMap = {}

  /** Companion (propagated) values per node/valueKey. Derived, never stored. */
  setCompanions(companions: CompanionMap): void {
    this.updateNodePaint(this.companions, companions, () => { this.companions = companions })
  }

  private editorSummaries: EditorSummaryMap = {}

  /** What folded editor rows read, per node and value key. Derived, never stored. */
  setEditorSummaries(summaries: EditorSummaryMap): void {
    this.updateNodePaint(this.editorSummaries, summaries, () => { this.editorSummaries = summaries })
  }

  private presence: readonly PresenceActor[] = []

  /**
   * Remote participants to paint (shared sessions). Its OWN channel, not
   * OverlayState: the interaction controller replaces the overlay wholesale
   * on every gesture, which would clobber presence riding inside it - same
   * reasoning as setNodeStates/setCompanions.
   */
  setPresence(actors: readonly PresenceActor[]): void {
    this.presence = actors
    this.requestRender()
  }

  getPresence(): readonly PresenceActor[] {
    return this.presence
  }

  private rowMarks: RowMarkMap = {}

  /**
   * The strongest problem per row. A row with a problem is outlined in that
   * problem's color: the field, or the input's row when it has no field.
   * Nothing is drawn at the node's edge for it.
   */
  setRowMarks(marks: RowMarkMap): void {
    this.updateNodePaint(this.rowMarks, marks, () => { this.rowMarks = marks })
  }

  getRowMarks(): RowMarkMap {
    return this.rowMarks
  }

  private problemRowHighlight: { readonly nodeId: string; readonly row: string } | undefined

  getProblemRowHighlight(): { readonly nodeId: string; readonly row: string } | undefined {
    return this.problemRowHighlight
  }

  /** The row whose line is pointed at in the node's problem box, drawn stronger. */
  setProblemRowHighlight(highlight: { readonly nodeId: string; readonly row: string } | undefined): void {
    const previous = this.problemRowHighlight
    if (previous?.nodeId === highlight?.nodeId && previous?.row === highlight?.row) return
    const ids = new Set([previous?.nodeId, highlight?.nodeId].filter((id): id is string => id !== undefined))
    this.invalidateNodeTiles(ids)
    this.problemRowHighlight = highlight
    this.requestRender()
  }

  private paintRowProblem(
    ctx: CanvasRenderingContext2D,
    nodeId: string,
    key: string,
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly radius: number },
  ): void {
    const color = this.rowProblemColor(nodeId, key)
    if (color === undefined) return
    const highlighted = this.problemRowHighlight?.nodeId === nodeId && this.problemRowHighlight.row === key
    const paint = canvasPaintTokens.widget
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineWidth = highlighted ? paint.problemHighlightStroke : paint.diagnosticStroke
    ctx.beginPath()
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, rect.radius)
    if (highlighted) {
      const alpha = ctx.globalAlpha
      ctx.globalAlpha = alpha * paint.problemHighlightOpacity
      ctx.fill()
      ctx.globalAlpha = alpha
    }
    ctx.stroke()
  }

  private rowProblemColor(nodeId: string, key: string): string | undefined {
    const kind: ProblemKind | undefined = this.rowMarks[nodeId]?.[key]
    return kind === undefined ? undefined
      : kind === 'error' ? this.tokens.colors.error : PROBLEM_WARNING_BADGE.color
  }

  private rowDrags: Readonly<Record<string, RowDrag>> = {}

  setRowDrag(drag: RowDrag | undefined): void {
    const next = drag === undefined ? {} : { [drag.nodeId]: drag }
    this.updateNodePaint(this.rowDrags, next, () => { this.rowDrags = next })
  }

  private openRows: Readonly<Record<string, string>> = {}

  /**
   * The row whose field is open over the canvas. The canvas leaves that row
   * unpainted, so nothing of it shows around the field.
   */
  setOpenRow(row: { readonly nodeId: string; readonly valueKey: string } | undefined): void {
    const next = row === undefined ? {} : { [row.nodeId]: row.valueKey }
    this.updateNodePaint(this.openRows, next, () => { this.openRows = next })
  }

  private lensCapabilities: RendererLensCapabilities = {}
  private typeAdornments: readonly TypeAdornmentDescriptor[] = []

  setLensCapabilities(capabilities: RendererLensCapabilities): void {
    this.lensCapabilities = capabilities
    this.refreshTypeAdornments()
    this.invalidate()
  }

  private refreshTypeAdornments(): void {
    this.typeAdornments = this.lensCapabilities.typeAdornments === true
      ? typeAdornmentsOf(this.scene, this.tokens)
      : []
  }

  getLensCapabilities(): RendererLensCapabilities {
    return this.lensCapabilities
  }

  /** Whether a field row paints a value arriving by wire in place of its own (WidgetPaintArgs.companion). */
  showsArrivingValue(nodeId: string, row: Extract<LayoutRow, { kind: 'widget' }>): boolean {
    return this.panelFieldValues.has(`${nodeId}\u0000${row.inputId}`) || this.companions[nodeId]?.[row.valueKey] !== undefined
  }

  getDesignTokens(): DesignTokens {
    return this.tokens
  }

  getDetailLevel(): CanvasDetailLevel {
    return canvasDetailLevel(this.viewport.scale, this.tokens.mediaControlMinScale)
  }

  private badges: BadgeMap = {}

  /** Header badges per node (subgraph marker, error chip, extensions). */
  setBadges(badges: BadgeMap): void {
    this.updateNodePaint(this.badges, badges, () => { this.badges = badges })
  }

  getBadges(): BadgeMap {
    return this.badges
  }

  private badgeLayoutOptions(node: SceneNode) {
    const tokens = this.tokens
    const badges = this.badges[node.id] ?? []
    const state = this.nodeStates[node.id]?.state
    const missing = node.unrecognized === true || node.missingSchema === true
    const strong = missing || state === 'running' || state === 'done' || state === 'error' ||
      badges.some((badge) => badge.id === PROBLEM_ERROR_BADGE.id)
    const paint = canvasPaintTokens.node.outline
    const stroke = screenAwareStroke(missing ? paint.idle * paint.unrecognizedFactor : strong ? paint.strong : paint.idle,
      this.viewport.scale, strong ? paint.strongScreen : paint.screen)
    const selected = this.overlay.selection?.has(node.id) === true
    const hovered = this.overlay.hoveredBadge
    let outset = stroke / 2
    if (selected) outset = Math.max(outset, NODE_SELECTION_OUTLINE_OUTSET +
      screenAwareStroke(SELECTION_OUTLINE_STROKE_WIDTH, this.viewport.scale, canvasPaintTokens.toolbox.selectionMinScreenStroke) / 2)
    if (this.overlay.bodyDropNode === node.id) {
      const drop = canvasPaintTokens.node.drop
      outset = Math.max(outset, drop.outset + screenAwareStroke(drop.stroke, this.viewport.scale, drop.stroke) / 2)
    }
    if (this.scopeHighlight?.nodes.has(node.id)) {
      const scope = canvasPaintTokens.node.scope
      outset = Math.max(outset, scope.outset + screenAwareStroke(scope.stroke, this.viewport.scale, scope.minScreenStroke) / 2)
    }
    return {
      tokens, outset,
      ...(hovered?.nodeId === node.id ? { hoveredId: hovered.badgeId } : {}),
      measureLabel: (text: string) => this.measureBadgeTabText(text),
    }
  }

  /** Supply live resize/drag node geometry when computing camera/tile extents. */
  getNodeBadgeBounds(node: SceneNode) {
    return nodeBadgeBounds(node, this.badges[node.id] ?? [], this.badgeLayoutOptions(node))
  }

  /** Bounds of a node with its tabs, or undefined when it has no badges, so badge-free nodes skip the layout. */
  private badgedNodeBounds(node: SceneNode) {
    return this.badges[node.id]?.length ? this.getNodeBadgeBounds(node) : undefined
  }

  getNodeBadgeLayout(node: SceneNode): readonly BadgePlacement[] {
    return layoutNodeBadges(node, this.badges[node.id] ?? [], this.badgeLayoutOptions(node))
  }

  private nodeDecorations: Readonly<Record<string, NodeDecoration>> = {}

  setNodeDecorations(decorations: Readonly<Record<string, NodeDecoration>>): void {
    this.updateNodePaint(this.nodeDecorations, decorations, () => { this.nodeDecorations = decorations })
  }

  getNodeDecorations(): Readonly<Record<string, NodeDecoration>> {
    return this.nodeDecorations
  }

  private toolbox: readonly ToolboxRow[] = []

  /** Selection toolbox rows (host-derived, like badges). */
  setToolbox(rows: readonly ToolboxRow[]): void {
    this.toolbox = rows
    this.requestRender()
  }

  /**
   * Live toolbox placement, or undefined when hidden: no buttons, no node
   * selection, or a gesture in flight (drags/marquee/link ghosts) - chrome
   * must never sit under an active gesture. One shared answer for drawing
   * AND hit-testing, so a click can never land on an invisible button.
   */
  getToolboxLayout(): ToolboxLayout | undefined {
    if (this.toolbox.length === 0) return undefined
    if (this.getDetailLevel() === 'overview') return undefined
    const o = this.overlay
    if (o.dragOffsets || o.marquee || o.ghostLink || o.ghostLinks || o.resizePreview) return undefined
    if (!o.selection || o.selection.size === 0) return undefined
    const union = this.selectionUnionOutlineRect()
    const unionOuterTop = union
      ? union.y - MULTI_SELECTION_OUTLINE_STROKE_WIDTH / this.viewport.scale / 2
      : undefined
    let attachedBadgeTop: number | undefined
    for (const node of this.scene.nodes) {
      if (!o.selection.has(node.id)) continue
      for (const entry of this.getNodeBadgeLayout(node)) {
        if ((entry.badge.placement ?? 'above') !== 'above') continue
        attachedBadgeTop = attachedBadgeTop === undefined ? entry.y : Math.min(attachedBadgeTop, entry.y)
      }
    }
    const badgeDefinesOccupiedTop = attachedBadgeTop !== undefined &&
      (unionOuterTop === undefined || attachedBadgeTop <= unionOuterTop)
    const occupiedTop = attachedBadgeTop === undefined
      ? unionOuterTop
      : unionOuterTop === undefined ? attachedBadgeTop : Math.min(unionOuterTop, attachedBadgeTop)
    return toolboxLayout(
      this.scene,
      o.selection,
      this.toolbox,
      this.viewport.scale,
      occupiedTop,
      badgeDefinesOccupiedTop ? TOOLBOX_GAP_FROM_ATTACHED_BADGE : undefined,
    )
  }

  /** Bounds of the painted heterogeneous selection union, before stroke outset. */
  private selectionUnionOutlineRect(): { x: number; y: number; width: number; height: number } | undefined {
    const boxes: { x1: number; y1: number; x2: number; y2: number }[] = []
    const off = (id: string) => this.overlay.dragOffsets?.get(id) ?? ZERO_OFFSET
    const rerouteRadius = detailRadius(REROUTE_RADIUS, this.viewport.scale, this.getDetailLevel())
    for (const node of this.scene.nodes) {
      if (!this.overlay.selection?.has(node.id)) continue
      const o = off(node.id)
      boxes.push({ x1: node.x + o.dx, y1: node.y + o.dy, x2: node.x + o.dx + node.layout.width, y2: node.y + o.dy + node.layout.height })
    }
    for (const node of this.scene.boundaryNodes) {
      const id = boundarySceneId(node.side)
      if (!this.overlay.selection?.has(id)) continue
      const o = off(id)
      boxes.push({ x1: node.x + o.dx, y1: node.y + o.dy, x2: node.x + o.dx + node.layout.width, y2: node.y + o.dy + node.layout.height })
    }
    for (const reroute of this.scene.reroutes) {
      if (!this.overlay.rerouteSelection?.has(reroute.id)) continue
      const o = off(reroute.id)
      boxes.push({ x1: reroute.x + o.dx - rerouteRadius, y1: reroute.y + o.dy - rerouteRadius, x2: reroute.x + o.dx + rerouteRadius, y2: reroute.y + o.dy + rerouteRadius })
    }
    for (const stub of this.scene.netStubs) {
      if (!this.overlay.netViewSelection?.has(stub.id)) continue
      const o = off(stub.id)
      boxes.push({ x1: stub.x + o.dx, y1: stub.y + o.dy, x2: stub.x + o.dx + stub.width, y2: stub.y + o.dy + stub.height })
    }
    for (const group of this.scene.groups) {
      if (!this.overlay.groupSelection?.has(group.id)) continue
      const groupOffset = this.overlay.groupDragOffset
      const selectedOffset = off(group.id)
      const dx = selectedOffset.dx + (groupOffset?.groupId === group.id ? groupOffset.dx : 0)
      const dy = selectedOffset.dy + (groupOffset?.groupId === group.id ? groupOffset.dy : 0)
      boxes.push({ x1: group.x + dx, y1: group.y + dy, x2: group.x + dx + group.width, y2: group.y + dy + group.height })
    }
    if (boxes.length < 2) return undefined
    const x1 = Math.min(...boxes.map((box) => box.x1)) - MULTI_SELECTION_OUTLINE_PAD
    const y1 = Math.min(...boxes.map((box) => box.y1)) - MULTI_SELECTION_OUTLINE_PAD
    const x2 = Math.max(...boxes.map((box) => box.x2)) + MULTI_SELECTION_OUTLINE_PAD
    const y2 = Math.max(...boxes.map((box) => box.y2)) + MULTI_SELECTION_OUTLINE_PAD
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  }

  private previews: PreviewMap = {}
  private outputTexts: OutputTextMap = {}

  private outputTextLineCount(layout: NodeLayout, text: string): number {
    const maxWidth = Math.max(0, layout.width - this.tokens.padX * 2 - canvasPaintTokens.preview.outputPadding * 2)
    const canonical = text.replace(/\r\n?/g, '\n').split('\n')
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return Math.max(1, Math.min(canvasPaintTokens.node.textOutputMaxRows, canonical.length))
    ctx.save()
    ctx.font = `italic ${this.tokens.fontSize}px ${this.tokens.fontFamily}`
    const count = canonical.reduce((total, line) => total + wrapText(ctx, line, maxWidth).length, 0)
    ctx.restore()
    return Math.max(1, Math.min(canvasPaintTokens.node.textOutputMaxRows, count))
  }

  /** A decoded preview picture over the transparency checker. */
  private paintPreviewPicture(
    ctx: CanvasRenderingContext2D,
    image: CanvasImageSource,
    fit: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  ): void {
    const t = this.tokens
    if (this.previewChecker === undefined) {
      const size = canvasPaintTokens.preview.checkerSize
      const half = size / 2
      const tile = typeof OffscreenCanvas === 'undefined'
        ? this.canvas.ownerDocument.createElement('canvas')
        : new OffscreenCanvas(size, size)
      tile.width = tile.height = size
      const tileContext = tile.getContext('2d')!
      tileContext.fillStyle = t.colors.widgetBackground
      tileContext.fillRect(0, 0, size, size)
      tileContext.fillStyle = t.colors.nodeBorder
      tileContext.fillRect(0, 0, half, half)
      tileContext.fillRect(half, half, half, half)
      this.previewChecker = ctx.createPattern(tile, 'repeat')
    }
    // The checker stops one device pixel inside the picture: an edge that
    // falls part way across a pixel would otherwise show the checker through
    // the picture's partly covered edge pixels as a dashed line.
    const inset = 1 / (this.viewport.scale * (globalThis.devicePixelRatio ?? 1))
    ctx.fillStyle = this.previewChecker ?? t.colors.widgetBackground
    ctx.fillRect(fit.x + inset, fit.y + inset, Math.max(0, fit.width - inset * 2), Math.max(0, fit.height - inset * 2))
    try {
      ctx.drawImage(image, fit.x, fit.y, fit.width, fit.height)
    } catch {
      // A closed/detached ImageBitmap must never kill the frame loop.
    }
  }

  /**
   * The caption row over a preview or text result: an arrow when it folds,
   * the word, and at the right end what the region holds. Folded, a small
   * picture stands before that detail.
   */
  private paintPreviewCaption(
    ctx: CanvasRenderingContext2D,
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
    caption: {
      readonly arrow?: 'open' | 'folded' | undefined
      readonly label: string
      readonly detail: string
      readonly detailColor: string
      readonly detailFont: string
      readonly thumbnail?: CanvasImageSource
      readonly thumbnailSize?: { readonly width?: number; readonly height?: number }
      readonly hovered: boolean
    },
  ): void {
    const t = this.tokens
    const paint = canvasPaintTokens.preview.caption
    const cy = rect.y + rect.height / 2
    if (caption.hovered) {
      ctx.fillStyle = t.colors.widgetRaised
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, paint.radius)
      ctx.fill()
    }
    const ink = caption.arrow === undefined ? t.colors.valueMark : caption.hovered ? t.colors.title : t.colors.label
    let x = rect.x + paint.padLeft
    if (caption.arrow !== undefined) {
      const arrowWidth = canvasPaintTokens.node.section.arrowHalfWidth * 2
      ctx.fillStyle = ink
      paintDisclosureArrow(ctx, x + arrowWidth / 2, cy, caption.arrow === 'open')
      x += arrowWidth + paint.gap
    }
    const right = rect.x + rect.width - paint.padRight
    ctx.font = `${t.fontSize}px ${t.fontFamily}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = ink
    const label = fitText(ctx, caption.label, Math.max(0, right - x))
    ctx.fillText(label, x, cy)
    const room = Math.max(0, right - (x + measureWidth(ctx, label) + paint.gap))
    const size = caption.thumbnailSize
    const thumbWidth = caption.thumbnail === undefined
      ? 0
      : size !== undefined && (size.width ?? 0) > 0 && (size.height ?? 0) > 0
        ? Math.min(paint.thumbMaxWidth, paint.thumbHeight * size.width! / size.height!)
        : paint.thumbMaxWidth
    const thumb = thumbWidth > 0 && room >= thumbWidth
    ctx.font = caption.detailFont
    ctx.fillStyle = caption.detailColor
    ctx.textAlign = 'right'
    const detail = fitText(ctx, caption.detail, Math.max(0, room - (thumb ? thumbWidth + paint.gap : 0)))
    ctx.fillText(detail, right, cy)
    if (thumb) {
      const detailWidth = detail === '' ? 0 : measureWidth(ctx, detail) + paint.gap
      const box = { x: right - detailWidth - thumbWidth, y: cy - paint.thumbHeight / 2, width: thumbWidth, height: paint.thumbHeight }
      this.paintPreviewPicture(ctx, caption.thumbnail!, size === undefined ? box : containRect(box, size))
    }
    ctx.textAlign = 'left'
  }

  private sceneWithBodyRegions(scene: Scene): Scene {
    if (Object.keys(this.previews).length === 0 && Object.keys(this.outputTexts).length === 0 &&
        !scene.nodes.some((node) => node.previewCapable === true)) return scene
    const nodes = scene.nodes.map((node) => {
      const folded = previewFoldedOf(node)
      const preview = this.previews[node.id]
      const outputText = this.outputTexts[node.id]
      if (node.layout.minimized === true) {
        const content = minimizedStripContent(preview, outputText)
        return content === 'picture'
          ? { ...node, layout: folded ? withFoldedPreviewRegion(node.layout, this.tokens) : withPreviewRegion(node.layout, this.tokens) }
          : content === 'text'
            ? { ...node, layout: withTextOutputRegion(node.layout, this.tokens, this.outputTextLineCount(node.layout, outputText!.text), folded) }
            : node
      }
      // Only the caption row: before a picture, while it loads or failed, and folded.
      const panel = preview !== undefined && previewHasPanel(preview) && !folded
      const baseLayout = node.previewCapable === true || (preview !== undefined && !panel)
        ? withCompactPreviewRegion(node.layout, this.tokens)
        : node.layout
      if (panel) return { ...node, layout: withPreviewRegion(baseLayout, this.tokens) }
      if (preview !== undefined && folded && previewHasPanel(preview)) {
        return { ...node, layout: withFoldedPreviewRegion(baseLayout, this.tokens) }
      }
      if (preview === undefined && outputText !== undefined) {
        // The text result takes the place of the caption row a node that
        // can preview reserves before its first picture.
        return {
          ...node,
          layout: withTextOutputRegion(
            node.layout,
            this.tokens,
            this.outputTextLineCount(node.layout, outputText.text),
            folded,
          ),
        }
      }
      return baseLayout === node.layout ? node : { ...node, layout: baseLayout }
    })
    const byId = new Map(nodes.map((node) => [node.id, node]))
    const anchor = (
      end: SceneLinkEnd,
      direction: 'in' | 'out',
      fallback: { x: number; y: number },
    ): { x: number; y: number } => {
      if (end.kind !== 'port' && end.kind !== 'widgetTap') return fallback
      const node = byId.get(end.node)
      const pin = end.kind === 'widgetTap'
        ? node?.layout.pins.find((candidate) => candidate.widgetTap === true && candidate.address.port === end.input)
        : node?.layout.pins.find((candidate) =>
            candidate.direction === direction && candidate.portId === end.port && candidate.widgetTap !== true,
          )
      if (node === undefined || pin === undefined) return fallback
      return { x: direction === 'out' ? node.x + node.layout.width : node.x, y: node.y + pin.y }
    }
    const links = scene.links.map((link) => {
      const from = anchor(link.from, 'out', { x: link.x1, y: link.y1 })
      const to = anchor(link.to, 'in', { x: link.x2, y: link.y2 })
      return { ...link, x1: from.x, y1: from.y, x2: to.x, y2: to.y }
    })
    const netStubs = scene.netStubs.map((stub) => {
      const node = byId.get(stub.nodeId)
      const direction = stub.role === 'source' ? 'out' : 'in'
      const key = stub.portId
      const pin = node?.layout.pins.find((candidate) =>
        candidate.direction === direction && candidate.portId === key && candidate.widgetTap !== true,
      )
      if (node === undefined || pin === undefined) return stub
      const pinX = direction === 'out' ? node.x + node.layout.width : node.x
      const pinY = node.y + pin.y
      return stub.authored === true
        ? { ...stub, pinX, pinY }
        : { ...stub, pinX, pinY, x: pinX + (stub.x - stub.pinX), y: pinY + (stub.y - stub.pinY) }
    })
    return {
      ...scene,
      nodes,
      links,
      netStubs,
    }
  }

  /** Preview imagery/placeholders per node, allocated inside the node body. */
  setNodePreviews(previews: PreviewMap): void {
    // Canvas/video pixels can change without replacing their source object.
    this.invalidateNodeTiles(new Set(Object.keys(previews)))
    // Body regions follow which nodes have a preview and what each minimized
    // node has to show.
    const regionSignature = (map: PreviewMap): string => [
      ...Object.keys(map).sort().map((id) => `${id}:${previewHasPanel(map[id]!) ? 'panel' : 'caption'}`),
      ...this.baseScene.nodes
        .filter((node) => node.layout.minimized === true)
        .map((node) => `${node.id}:${minimizedStripContent(map[node.id], this.outputTexts[node.id]) ?? ''}`),
    ].join('\u0000')
    const before = regionSignature(this.previews)
    const after = regionSignature(previews)
    this.updateNodePaint(this.previews, previews, () => {
      this.previews = previews
      if (before !== after) {
        this.replacePaintScene(this.sceneWithBodyRegions(this.baseScene))
        this.refreshTypeAdornments()
        for (const listener of this.sceneReplacedListeners) listener(this.scene)
      }
    })
  }

  getNodePreviews(): PreviewMap {
    return this.previews
  }

  /** Automatic text and scalar results per node, allocated inside the body. */
  setNodeOutputTexts(outputTexts: OutputTextMap): void {
    const lineCounts = (texts: OutputTextMap): string => this.baseScene.nodes
      .flatMap((node) => texts[node.id] === undefined
        ? []
        : [`${node.id}\u0000${this.outputTextLineCount(node.layout, texts[node.id]!.text)}`])
      .sort()
      .join('\u0000')
    const before = lineCounts(this.outputTexts)
    const after = lineCounts(outputTexts)
    this.updateNodePaint(this.outputTexts, outputTexts, () => {
      this.outputTexts = outputTexts
      if (before !== after) {
        this.replacePaintScene(this.sceneWithBodyRegions(this.baseScene))
        this.refreshTypeAdornments()
        for (const listener of this.sceneReplacedListeners) listener(this.scene)
      }
    })
  }

  getNodeOutputTexts(): OutputTextMap {
    return this.outputTexts
  }

  private scopeHighlight: ScopeHighlight | undefined
  private inactiveNodes: ReadonlySet<string> | undefined

  /**
   * Partial-execution scope preview: everything OUTSIDE the given sets (and
   * links touching it) renders dimmed. Pure overlay state - never document
   * state, never recomputed in the draw loop.
   */
  setScopeHighlight(scope: ScopeHighlight | undefined): void {
    if (this.scopeHighlight === scope) return
    this.scopeHighlight = scope
    this.invalidate()
  }

  getScopeHighlight(): ScopeHighlight | undefined {
    return this.scopeHighlight
  }

  /** Compiler-derived lazy-selector cones; membership only, never topology. */
  setInactiveNodes(nodes: ReadonlySet<string> | undefined): void {
    const unchanged = nodes === this.inactiveNodes || (nodes !== undefined && this.inactiveNodes !== undefined &&
      nodes.size === this.inactiveNodes.size && [...nodes].every((id) => this.inactiveNodes!.has(id)))
    this.inactiveNodes = nodes
    if (!unchanged) this.invalidate()
  }

  getInactiveNodes(): ReadonlySet<string> | undefined {
    return this.inactiveNodes
  }

  /** One link end's out-of-scope verdict under the active scope highlight. */
  private endOutOfScope(end: SceneLinkEnd): boolean {
    const s = this.scopeHighlight
    switch (end.kind) {
      case 'port':
        return this.inactiveNodes?.has(end.node) === true || (s !== undefined && !s.nodes.has(end.node))
      case 'reroute':
        return s !== undefined && !s.reroutes.has(end.reroute)
      case 'widgetTap':
        return this.inactiveNodes?.has(end.node) === true || (s !== undefined && !s.nodes.has(end.node))
      case 'boundary':
        return false
    }
  }

  private viewportListeners = new Set<(vp: Viewport) => void>()
  /** User preference only; the grid remains renderer-owned presentation. */
  private gridVisible = true

  setGridVisible(visible: boolean): void {
    this.gridVisible = visible
    this.invalidate()
  }

  getGridVisible(): boolean {
    return this.gridVisible
  }

  setViewport(viewport: Viewport): void {
    this.cancelViewportAnimation()
    this.applyViewport(viewport)
    this.scheduleFrame()
  }

  /** Accumulate wheel targets and settle within 100ms of the latest input. */
  animateViewport(update: (viewport: Viewport) => Viewport): void {
    const target = this.viewportAnimation?.to ?? this.viewport
    const to = update(target)
    if (this.reducedMotion) {
      this.setViewport(to)
      return
    }
    if (to.x === target.x && to.y === target.y && to.scale === target.scale) return
    if (!this.viewportAnimation) this.paintEnded = -Infinity
    // Retarget from the last visible frame without discarding its elapsed time.
    const sampled = this.viewportAnimation?.sampled ?? performance.now()
    this.viewportAnimation = { from: { ...this.viewport }, to, started: sampled, sampled }
    this.scheduleFrame()
  }

  cancelViewportAnimation(): void {
    this.viewportAnimation = undefined
  }

  private applyViewport(viewport: Viewport): void {
    this.viewport = viewport
    this.dirty = true
    for (const cb of this.viewportListeners) cb(viewport)
  }

  /** Observe every viewport change (pan/zoom/fit/jump). Returns unsubscribe. */
  onViewportChange(cb: (vp: Viewport) => void): () => void {
    this.viewportListeners.add(cb)
    return () => this.viewportListeners.delete(cb)
  }

  getViewport(): Viewport {
    return this.viewport
  }

  private clearGraphTiles(): void {
    for (const tile of this.graphTiles.values()) tile.close()
    this.graphTiles.clear()
    this.graphTileTransform = ''
  }

  private invalidateGraphBounds(bounds: ReturnType<typeof linkBounds>): void {
    if (this.graphTiles.size === 0) return
    const [scale, densityX, densityY] = this.graphTileTransform.split('/').map(Number) as [number, number, number]
    const { tilePixels: size, bleedPixels: bleed } = canvasPaintTokens.graphCache
    for (const [key, tile] of this.graphTiles) {
      const [column, row] = key.split('/').map(Number) as [number, number]
      const x = (column * size - bleed) / (densityX * scale)
      const y = (row * size - bleed) / (densityY * scale)
      const width = (size + bleed * 2) / (densityX * scale)
      const height = (size + bleed * 2) / (densityY * scale)
      if (bounds.maxX < x || bounds.minX > x + width || bounds.maxY < y || bounds.minY > y + height) continue
      tile.close()
      this.graphTiles.delete(key)
    }
  }

  private nodePaintBounds(entry: SceneNode): ReturnType<typeof linkBounds> {
    const node = this.nodeForPaint(entry)
    const offset = this.overlay.dragOffsets?.get(node.id) ?? ZERO_OFFSET
    const layout = node.layout
    const pad = structureCullPad(this.viewport.scale, this.tokens.pinRadius, this.getDetailLevel())
    const badges = this.getDetailLevel() !== 'overview' ? this.badgedNodeBounds(node) : undefined
    return {
      minX: Math.min(node.x - pad, badges?.x ?? node.x) + offset.dx,
      maxX: Math.max(node.x + layout.width + pad, badges ? badges.x + badges.width : node.x + layout.width) + offset.dx,
      minY: Math.min(node.y - pad, badges?.y ?? node.y) + offset.dy,
      maxY: Math.max(node.y + layout.height + pad, badges ? badges.y + badges.height : node.y + layout.height) + offset.dy,
    }
  }

  private linkPaintBounds(link: Scene['links'][number]): ReturnType<typeof linkBounds> {
    const from = this.linkEndForPaint(link.from, 'out', link.x1, link.y1)
    const to = this.linkEndForPaint(link.to, 'in', link.x2, link.y2)
    const a = this.overlay.dragOffsets?.get(sceneEndId(link.from)) ?? ZERO_OFFSET
    const b = this.overlay.dragOffsets?.get(sceneEndId(link.to)) ?? ZERO_OFFSET
    const bounds = linkBounds(from.x + a.dx, from.y + a.dy, to.x + b.dx, to.y + b.dy)
    const pad = linkCullPad(this.viewport.scale)
    return { minX: bounds.minX - pad, maxX: bounds.maxX + pad, minY: bounds.minY - pad, maxY: bounds.maxY + pad }
  }

  private invalidateNodeTiles(ids: ReadonlySet<string>): void {
    if (ids.size === 0 || this.graphTiles.size === 0) return
    const nodes = this.scene.nodes.filter((node) => ids.has(node.id))
    if (nodes.length !== ids.size || this.scene.netStubs.some((stub) => ids.has(stub.nodeId))) {
      this.clearGraphTiles()
      return
    }
    for (const node of nodes) this.invalidateGraphBounds(this.nodePaintBounds(node))
    for (const link of this.scene.links) {
      if (ids.has(sceneEndId(link.from)) || ids.has(sceneEndId(link.to))) this.invalidateGraphBounds(this.linkPaintBounds(link))
    }
    const union = this.selectionUnionOutlineRect()
    if (union) {
      const pad = MULTI_SELECTION_OUTLINE_STROKE_WIDTH / this.viewport.scale
      this.invalidateGraphBounds({ minX: union.x - pad, minY: union.y - pad, maxX: union.x + union.width + pad, maxY: union.y + union.height + pad })
    }
  }

  private requestRender(): void {
    this.dirty = true
    this.scheduleFrame()
  }

  invalidate(): void {
    this.clearGraphTiles()
    this.requestRender()
  }

  /**
   * Synchronous repaint, bypassing the rAF dirty loop. For ResizeObserver
   * callbacks: they run after layout but BEFORE the frame paints, so
   * resizing the backing store and redrawing here lands in the SAME frame -
   * waiting for the next rAF tick would flash one frame of the
   * CSS-stretched stale bitmap.
   */
  renderNow(): void {
    if (this.disposed) return
    this.dirty = false
    this.render()
  }

  /** Fit everything the scene paints into the canvas (used on load). */
  fitToScene(margin: number = canvasPaintTokens.viewport.fitMargin): void {
    const bounds = sceneVisualBounds(this.scene, this.previews, (node) => this.badgedNodeBounds(node))
    if (!bounds) return
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w <= 0 || h <= 0) return
    const spanX = Math.max(1, bounds.maxX - bounds.minX)
    const spanY = Math.max(1, bounds.maxY - bounds.minY)
    const fitScale = Math.min((w - margin * 2) / spanX, (h - margin * 2) / spanY)
    const detailFits =
      (spanX + PIN_OVERHANG * 2) * CANVAS_DETAIL_MIN_SCALE <= w &&
      (spanY + PIN_OVERHANG * 2) * CANVAS_DETAIL_MIN_SCALE <= h
    const scale = Math.min(canvasPaintTokens.viewport.maxFitScale, Math.max(canvasPaintTokens.viewport.minFitScale, detailFits ? Math.max(CANVAS_DETAIL_MIN_SCALE, fitScale) : fitScale))
    this.setViewport({
      x: (w - spanX * scale) / 2 - bounds.minX * scale,
      y: (h - spanY * scale) / 2 - bounds.minY * scale,
      scale,
    })
  }

  dispose(): void {
    this.cancelViewportAnimation()
    this.disposed = true
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId)
    this.rafId = undefined
    this.sceneReplacedListeners.clear()
    this.viewportListeners.clear()
    this.clearGraphTiles()
    this.graphTileSurface = undefined
  }

  private scheduleFrame(): void {
    if (this.disposed || this.rafId !== undefined) return
    this.rafId = requestAnimationFrame(this.loop)
  }

  private loop(timestamp: number): void {
    if (this.disposed) return
    this.rafId = undefined
    const animation = this.viewportAnimation
    if (animation && !this.dirty && performance.now() - animation.started < 100 && performance.now() - this.paintEnded < this.paintDuration / 2) {
      // Leave input delivery time between expensive animated paints. Publish
      // the unchanged visible camera so host overlays and frame work stay live.
      for (const cb of this.viewportListeners) cb(this.viewport)
      this.scheduleFrame()
      return
    }
    if (animation) {
      // A frame timestamp can precede wheel delivery in this same frame.
      animation.sampled = performance.now()
      const progress = this.reducedMotion ? 1 : Math.min(1, Math.max(0, (animation.sampled - animation.started) / 100))
      const eased = 1 - (1 - progress) ** 3
      if (progress === 1) this.viewportAnimation = undefined
      // Linear transform interpolation preserves the wheel's world-space anchor.
      this.applyViewport(progress === 1 ? animation.to : {
        x: animation.from.x + (animation.to.x - animation.from.x) * eased,
        y: animation.from.y + (animation.to.y - animation.from.y) * eased,
        scale: animation.from.scale + (animation.to.scale - animation.from.scale) * eased,
      })
    }
    const animateExecution = this.hasRunningNodes && !this.reducedMotion
    if (animateExecution) {
      this.animationTimeMs = timestamp
      this.dirty = true
    }
    if (this.dirty) {
      this.dirty = false
      const started = performance.now()
      this.render()
      this.paintEnded = performance.now()
      this.paintDuration = this.paintEnded - started
    }
    if (this.dirty || animateExecution || this.viewportAnimation) this.scheduleFrame()
  }

  private refreshConnectivity(): void {
    this.mutedInputPins = new Set(this.scene.links.flatMap((link) =>
      link.sourceMuted === true && link.to.kind === 'port' ? [`${link.to.node}\u0000${link.to.port}`] : []))
    this.connectedInputPins = new Set(
      [
        ...this.scene.links
          .filter((link) => link.to.kind === 'port')
          .map((link) => {
          const to = link.to as Extract<SceneLinkEnd, { kind: 'port' }>
          return `${to.node}\u0000${to.port}`
        }),
        ...this.scene.netStubs
          .filter((stub) => stub.role === 'sink')
          .map((stub) => `${stub.nodeId}\u0000${stub.portId}`),
      ],
    )
    this.connectedOutputPins = new Set(
      [
        ...this.scene.links
          .filter((link) => link.from.kind === 'port' || link.from.kind === 'widgetTap')
          .map((link) => {
          const from = link.from as Extract<SceneLinkEnd, { kind: 'port' | 'widgetTap' }>
          return from.kind === 'port'
            ? `${from.node}\u0000${from.port}`
            : `${from.node}\u0000${from.input}`
        }),
        ...this.scene.netStubs
          .filter((stub) => stub.role === 'source')
          .map((stub) => `${stub.nodeId}\u0000${stub.portId}`),
      ],
    )
    this.connectedWidgetTaps = new Set(
      this.scene.links
        .filter((link) => link.from.kind === 'widgetTap')
        .map((link) => {
          const from = link.from as Extract<SceneLinkEnd, { kind: 'widgetTap' }>
          return `${from.node}\u0000${from.input}`
        }),
    )
    const wireless = new Set<string>()
    for (const link of this.scene.links)
      if (link.boundary === true && link.hidden === true && link.to.kind === 'port')
        wireless.add(`${link.to.node}\u0000${link.to.port}`)
    this.wirelessBoundaryInputPins = wireless
    // Boundary bindings are excluded here: a bound SELECTOR row stays the
    // occurrence-local editor (edits route to the owning instance), so it
    // must not paint inert. Pins keep using the full set - visually the
    // binding IS a connection.
    this.valueDrivenInputPins = new Set(
      this.scene.links
        .filter((link) => link.boundary !== true && link.to.kind === 'port')
        .map((link) => {
          const to = link.to as Extract<SceneLinkEnd, { kind: 'port' }>
          return `${to.node}\u0000${to.port}`
        }),
    )
    // A field on the Inputs panel sends its value down its wire, so the inner
    // field shows that value arriving rather than its own dormant one.
    const panelFieldValues = new Map<string, Json>()
    const panel = this.scene.boundaryNodes.find((bnode) => bnode.side === 'inputs' && bnode.fields !== undefined)
    const sentValue = (from: SceneLinkEnd): Json | undefined => {
      if (panel === undefined || from.kind !== 'boundary' || from.side !== 'inputs') return undefined
      const key = panel.fields!.heads[from.item]
      const row = panel.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.valueKey === key)
      // A dropdown that leads options stays the inner node's editor of the
      // occurrence's choice, as a selector row bound to the boundary does.
      if (row?.kind !== 'widget' || row.selector !== undefined) return undefined
      const wired = panel.fields!.wired
      return Object.hasOwn(wired, row.valueKey) ? wired[row.valueKey]!.value
        : panel.fields!.node.values[row.valueKey] ?? effectiveWidgetDefault(row.spec)
    }
    // Inner inputs each sent value reaches, directly or through reroutes.
    const viaReroute = new Set<string>()
    let pending = this.scene.links.flatMap((link) => {
      const value = sentValue(link.from)
      return value === undefined ? [] : [{ value, to: link.to }]
    })
    while (pending.length > 0) {
      const next: typeof pending = []
      for (const { value, to } of pending) {
        if (to.kind === 'port') panelFieldValues.set(`${to.node}\u0000${to.port}`, value)
        else if (to.kind === 'reroute' && !viaReroute.has(to.reroute)) {
          viaReroute.add(to.reroute)
          for (const link of this.scene.links) if (link.from.kind === 'reroute' && link.from.reroute === to.reroute) next.push({ value, to: link.to })
        }
      }
      pending = next
    }
    this.panelFieldValues = panelFieldValues
  }

  private render(): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    const dpr = globalThis.devicePixelRatio ?? 1
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    // A collapsed/hidden host yields zero CSS size: nothing to paint, and
    // the scale transform below would divide by zero.
    if (w <= 0 || h <= 0) return
    // The backing store is integer pixels. Compare and assign the ROUNDED
    // dimensions: at fractional devicePixelRatio, comparing against the
    // fractional product would mismatch every frame and reallocate the
    // backing store on every repaint.
    const pixelWidth = Math.max(1, Math.round(w * dpr))
    const pixelHeight = Math.max(1, Math.round(h * dpr))
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth
      this.canvas.height = pixelHeight
    }
    // Map CSS pixels exactly onto the rounded store (not the raw dpr), so
    // fills spanning [0, w] cover every backing pixel edge to edge.
    ctx.setTransform(pixelWidth / w, 0, 0, pixelHeight / h, 0, 0)
    const t = this.tokens
    ctx.fillStyle = t.colors.canvasBackground
    ctx.fillRect(0, 0, w, h)

    const { scale } = this.viewport
    // Align paint, not the logical camera, to physical pixels so camera-only
    // translation preserves sharp retained imagery without bitmap resampling.
    const vx = Math.round(this.viewport.x * pixelWidth / w) / (pixelWidth / w)
    const vy = Math.round(this.viewport.y * pixelHeight / h) / (pixelHeight / h)
    ctx.translate(vx, vy)
    ctx.scale(scale, scale)

    // Visible world rect for culling.
    const view = { x: -vx / scale, y: -vy / scale, w: w / scale, h: h / scale }
    this.drawCanvasLayers('background', ctx, view, scale)
    if (
      typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.transferToImageBitmap === 'function' &&
      !this.hasRunningNodes
    ) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      this.drawGraphTiles(ctx, pixelWidth, pixelHeight, pixelWidth / w, pixelHeight / h)
      ctx.restore()
    } else if (typeof OffscreenCanvas !== 'undefined' && !this.hasRunningNodes) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      this.drawGraphUncached(ctx, pixelWidth, pixelHeight, pixelWidth / w, pixelHeight / h)
      ctx.restore()
    } else {
      this.drawGraph(ctx, view, scale)
    }

    const tl = this.getToolboxLayout()
    if (tl) this.drawToolbox(ctx, tl)
    this.drawTypeAdornments(ctx, view)
    this.drawPresence(ctx, scale)
    this.drawCanvasLayers('foreground', ctx, view, scale)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  /** Full-scene repaints share the retained images' raster origins and alpha composition, not their candidate bins or pixels. */
  private drawGraphUncached(
    ctx: CanvasRenderingContext2D,
    pixelWidth: number,
    pixelHeight: number,
    densityX: number,
    densityY: number,
  ): void {
    const { tilePixels: size, bleedPixels: bleed } = canvasPaintTokens.graphCache
    const { x, y, scale } = this.viewport
    const pixelX = Math.round(x * densityX)
    const pixelY = Math.round(y * densityY)
    const surface = this.graphTileSurface ??= new OffscreenCanvas(size + bleed * 2, size + bleed * 2)
    for (let row = Math.floor(-pixelY / size); row < Math.ceil((pixelHeight - pixelY) / size); row++) {
      for (let column = Math.floor(-pixelX / size); column < Math.ceil((pixelWidth - pixelX) / size); column++) {
        surface.width = surface.height = size + bleed * 2
        const target = surface.getContext('2d')! as unknown as CanvasRenderingContext2D
        const originX = -column * size + bleed
        const originY = -row * size + bleed
        target.setTransform(densityX * scale, 0, 0, densityY * scale, originX, originY)
        this.drawGraph(target, {
          x: -originX / (densityX * scale),
          y: -originY / (densityY * scale),
          w: (size + bleed * 2) / (densityX * scale),
          h: (size + bleed * 2) / (densityY * scale),
        }, scale)
        ctx.drawImage(surface, bleed, bleed, size, size, column * size + pixelX, row * size + pixelY, size, size)
      }
    }
  }

  private drawGraphTiles(
    ctx: CanvasRenderingContext2D,
    pixelWidth: number,
    pixelHeight: number,
    densityX: number,
    densityY: number,
  ): void {
    const { tilePixels: size, bleedPixels: bleed } = canvasPaintTokens.graphCache
    const { x, y, scale } = this.viewport
    const pixelX = Math.round(x * densityX)
    const pixelY = Math.round(y * densityY)
    const transform = `${scale}/${densityX}/${densityY}`
    if (transform !== this.graphTileTransform) {
      this.clearGraphTiles()
      this.graphTileTransform = transform
    }
    const used = new Set<string>()
    const firstColumn = Math.floor(-pixelX / size)
    const lastColumn = Math.ceil((pixelWidth - pixelX) / size) - 1
    const firstRow = Math.floor(-pixelY / size)
    const lastRow = Math.ceil((pixelHeight - pixelY) / size) - 1
    type TileScene = { nodes: SceneNode[]; links: Scene['links'][number][] }
    let scenes: Map<string, TileScene> | undefined
    for (let row = firstRow; row <= lastRow; row++) {
      for (let column = firstColumn; column <= lastColumn; column++) {
        const key = `${column}/${row}`
        used.add(key)
        let tile = this.graphTiles.get(key)
        if (tile === undefined) {
          if (scenes === undefined) {
            scenes = new Map()
            for (let r = firstRow; r <= lastRow; r++) {
              for (let c = firstColumn; c <= lastColumn; c++) {
                const id = `${c}/${r}`
                if (!this.graphTiles.has(id)) scenes.set(id, { nodes: [], links: [] })
              }
            }
            // Bin once, including paint padding and bleed. Each tile keeps its
            // canonical origin, clipping and original scene order.
            const assign = (bounds: ReturnType<typeof linkBounds>, append: (scene: TileScene) => void) => {
              // Include neighboring bins before applying the painter's exact
              // world-space comparisons: multiplication can round an edge out.
              const left = Math.max(firstColumn, Math.floor((bounds.minX * densityX * scale - bleed) / size) - 1)
              const right = Math.min(lastColumn, Math.floor((bounds.maxX * densityX * scale + bleed) / size) + 1)
              const top = Math.max(firstRow, Math.floor((bounds.minY * densityY * scale - bleed) / size) - 1)
              const bottom = Math.min(lastRow, Math.floor((bounds.maxY * densityY * scale + bleed) / size) + 1)
              for (let r = top; r <= bottom; r++) {
                for (let c = left; c <= right; c++) {
                  const scene = scenes!.get(`${c}/${r}`)
                  if (!scene) continue
                  const x = (c * size - bleed) / (densityX * scale)
                  const y = (r * size - bleed) / (densityY * scale)
                  const w = (size + bleed * 2) / (densityX * scale)
                  const h = (size + bleed * 2) / (densityY * scale)
                  if (bounds.maxX < x || bounds.minX > x + w || bounds.maxY < y || bounds.minY > y + h) continue
                  append(scene)
                }
              }
            }
            for (const entry of this.scene.nodes) {
              assign(this.nodePaintBounds(entry), (scene) => scene.nodes.push(entry))
            }
            for (const link of this.scene.links) {
              assign(this.linkPaintBounds(link), (scene) => scene.links.push(link))
            }
          }
          const surface = this.graphTileSurface ??= new OffscreenCanvas(size + bleed * 2, size + bleed * 2)
          // Reset paint state as well as pixels before rendering another tile.
          surface.width = surface.height = size + bleed * 2
          const target = surface.getContext('2d')! as unknown as CanvasRenderingContext2D
          const originX = -column * size + bleed
          const originY = -row * size + bleed
          target.setTransform(densityX * scale, 0, 0, densityY * scale, originX, originY)
          this.drawGraph(target, {
            x: -originX / (densityX * scale),
            y: -originY / (densityY * scale),
            w: (size + bleed * 2) / (densityX * scale),
            h: (size + bleed * 2) / (densityY * scale),
          }, scale, { ...this.scene, ...scenes.get(key)! })
          tile = surface.transferToImageBitmap()
          this.graphTiles.set(key, tile)
        }
        ctx.drawImage(tile, bleed, bleed, size, size, column * size + pixelX, row * size + pixelY, size, size)
      }
    }
    // Retain only the visible working set, independent of total graph size or pan distance.
    for (const [key, tile] of this.graphTiles) {
      if (used.has(key)) continue
      tile.close()
      this.graphTiles.delete(key)
    }
  }

  private drawGraph(
    ctx: CanvasRenderingContext2D,
    view: Readonly<{ x: number; y: number; w: number; h: number }>,
    scale: number,
    scene: Scene = this.scene,
  ): void {
    const t = this.tokens
    const detailLevel = this.getDetailLevel()
    const contentDetail = detailLevel !== 'overview'
    const paintPad = linkCullPad(scale)
    const rerouteRadius = detailRadius(REROUTE_RADIUS, scale, detailLevel)
    const structurePad = structureCullPad(scale, t.pinRadius, detailLevel)
    const offsets = this.overlay.dragOffsets
    const off = (nodeId: string) => offsets?.get(nodeId) ?? ZERO_OFFSET

    // Groups draw first: rectangles UNDER links and nodes.
    for (const group of this.scene.groups) {
      const gOff = this.overlay.groupDragOffset
      const selectedOff = off(group.id)
      const gx = group.x + selectedOff.dx + (gOff?.groupId === group.id ? gOff.dx : 0)
      const gy = group.y + selectedOff.dy + (gOff?.groupId === group.id ? gOff.dy : 0)
      const selected = this.overlay.groupSelection?.has(group.id) === true
      const paint = canvasPaintTokens.group
      const stroke = selected ? paint.selectedStroke : paint.stroke
      const groupStroke = screenAwareStroke(stroke, scale, stroke)
      const groupPad = (selected ? paint.selectionOutset : 0) + groupStroke / 2 + paint.cullScreenPadding / finiteScale(scale)
      if (gx + group.width + groupPad < view.x || gx - groupPad > view.x + view.w ||
        gy + group.height + groupPad < view.y || gy - groupPad > view.y + view.h) {
        continue
      }
      this.drawGroup(ctx, group, gx, gy, detailLevel)
      if (selected) {
        ctx.save()
        ctx.strokeStyle = this.tokens.colors.nodeSelectedBorder
        ctx.lineWidth = groupStroke
        ctx.setLineDash(screenAwareDash(canvasPaintTokens.dash.groupSelection.world, canvasPaintTokens.dash.groupSelection.screen, scale))
        ctx.strokeRect(gx - paint.selectionOutset, gy - paint.selectionOutset, group.width + paint.selectionOutset * 2, group.height + paint.selectionOutset * 2)
        ctx.restore()
      }
    }

    const batchedOverviewLinks = new Set<string>()
    if (detailLevel === 'overview' && this.scene.links.length >= 256 && offsets === undefined &&
        this.overlay.resizePreview === undefined && this.scopeHighlight === undefined && this.inactiveNodes === undefined) {
      const batches = new Map<string | undefined, Array<readonly [number, number, number, number]>>()
      for (const link of scene.links) {
        if (link.hidden === true || this.overlay.hiddenLinkIds?.has(link.id) === true ||
            this.overlay.linkSelection?.has(link.id) === true || link.maybeAbsent === true || link.dimmed === true || link.mismatch === true) continue
        const bounds = linkBounds(link.x1, link.y1, link.x2, link.y2)
        if (bounds.maxX + paintPad < view.x || bounds.minX - paintPad > view.x + view.w ||
            bounds.maxY + paintPad < view.y || bounds.minY - paintPad > view.y + view.h) continue
        const batch = batches.get(link.typeName) ?? []
        batch.push([link.x1, link.y1, link.x2, link.y2])
        batches.set(link.typeName, batch)
        batchedOverviewLinks.add(link.id)
      }
      ctx.lineWidth = screenAwareStroke(canvasPaintTokens.link.stroke, scale, canvasPaintTokens.link.minScreenStroke)
      for (const [typeName, batch] of batches) {
        ctx.strokeStyle = typeName === undefined
          ? t.colors.linkDefault
          : presentedType(t, { kind: 'concrete', name: typeName }).color
        ctx.beginPath()
        for (const [x1, y1, x2, y2] of batch) this.appendLinkPath(ctx, x1, y1, x2, y2)
        ctx.stroke()
      }
    }

    for (const link of scene.links) {
      if (batchedOverviewLinks.has(link.id)) continue
      // Collapsed-net noodles exist for connectivity only; endpoint tags
      // are their visual form.
      if (link.hidden === true) continue
      // A link being rewired hides: the ghost noodle IS that connection,
      // visually moving with the cursor - the stale segment would read as
      // "still connected".
      if (this.overlay.hiddenLinkIds?.has(link.id)) continue
      const o1 = off(sceneEndId(link.from))
      const o2 = off(sceneEndId(link.to))
      const from = this.linkEndForPaint(link.from, 'out', link.x1, link.y1)
      const to = this.linkEndForPaint(link.to, 'in', link.x2, link.y2)
      const x1 = from.x + o1.dx
      const y1 = from.y + o1.dy
      const x2 = to.x + o2.dx
      const y2 = to.y + o2.dy
      // Cull on the curve's control hull (shared with hit testing), not the
      // endpoint box: a long reverse link bulges far past both endpoints.
      // Pad by paint thickness so a selected stroke or the midpoint dot
      // does not pop at the viewport edge.
      const bounds = linkBounds(x1, y1, x2, y2)
      if (
        bounds.maxX + paintPad < view.x ||
        bounds.minX - paintPad > view.x + view.w ||
        bounds.maxY + paintPad < view.y ||
        bounds.minY - paintPad > view.y + view.h
      ) {
        continue
      }
      // Scope dimming keys off BOTH ends' own membership: node ends by node,
      // reroute ends by reroute. Boundary pseudo-ends never dim a segment on
      // their own.
      const outOfScope =
        (this.scopeHighlight !== undefined || this.inactiveNodes !== undefined) &&
        (this.endOutOfScope(link.from) || this.endOutOfScope(link.to))
      if (outOfScope) ctx.globalAlpha = SCOPE_DIM
      if (link.dimmed === true) ctx.globalAlpha *= canvasPaintTokens.widget.inactiveOpacity
      // A wire out of a muted node fades with it; the mute adds no dashes.
      if (link.sourceMuted === true) ctx.globalAlpha *= canvasPaintTokens.node.modeOpacity
      if (this.overlay.linkSelection?.has(link.id)) {
        this.drawLink(ctx, x1, y1, x2, y2, link.typeName, {
          color: this.tokens.colors.nodeSelectedBorder,
          width: canvasPaintTokens.link.selectedStroke,
          minScreenWidth: canvasPaintTokens.link.selectedMinScreenStroke,
        })
      }
      // A dashed wire means only that it may carry nothing (an optional
      // producer); every other wire, including one being dragged, is solid.
      const dashed = link.maybeAbsent === true
      if (dashed) ctx.setLineDash(screenAwareDash(canvasPaintTokens.dash.maybeAbsentLink.world, canvasPaintTokens.dash.maybeAbsentLink.screen, scale))
      // A PROVEN type conflict paints the noodle in error red, overriding
      // the type color: the break must be visible where it is, not hunted
      // down from a Problems entry. Slightly wider so red never hides
      // between densely packed ok noodles.
      if (link.mismatch === true) {
        this.drawLink(ctx, x1, y1, x2, y2, link.typeName, {
          color: this.tokens.colors.error,
          width: canvasPaintTokens.link.mismatchStroke,
          minScreenWidth: canvasPaintTokens.link.mismatchMinScreenStroke,
        })
      } else {
        this.drawLink(ctx, x1, y1, x2, y2, link.typeName)
      }
      if (dashed) ctx.setLineDash([])
      // Midpoint grab dot: a visible handle for clicking the noodle (and
      // double-click reroute insertion). Boundary noodles carry it too -
      // they select and delete like any noodle (delete lowers to
      // boundary.unbind); only reroute insertion is gated at dblclick.
      // Net delivery noodles carry NO dot: splicing between a Set and a
      // Get has no defined semantics, and their midpoint is the name label.
      if (contentDetail && link.netId === undefined) {
        // Bezier t=0.5 with symmetric horizontal control offsets: the
        // offsets cancel, so the handle sits at the plain segment midpoint.
        const mx = (x1 + x2) / 2
        const my = (y1 + y2) / 2
        ctx.beginPath()
        const midpointHovered = this.overlay.hoveredLinkMidpoint === link.id
        ctx.arc(mx, my, midpointHovered ? canvasPaintTokens.link.hoveredMidpointRadius : canvasPaintTokens.link.midpointRadius, 0, Math.PI * 2)
        // The grab dot follows the noodle's paint, so a mismatch reads red
        // end to end rather than showing a healthy-looking handle mid-error.
        ctx.fillStyle =
          link.mismatch === true
            ? t.colors.error
            : link.typeName
              ? presentedType(t, { kind: 'concrete', name: link.typeName }).color
              : t.colors.linkDefault
        ctx.fill()
        ctx.strokeStyle = midpointHovered ? t.colors.dropTarget : t.colors.canvasBackground
        ctx.lineWidth = midpointHovered ? canvasPaintTokens.link.hoveredMidpointStroke : canvasPaintTokens.link.midpointStroke
        ctx.stroke()
      }
      // Net noodles carry their name at the midpoint (legible from ~50% zoom).
      if (link.netName !== undefined && contentDetail) {
        ctx.font = `${t.fontSize}px ${t.fontFamily}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle = t.colors.label
        ctx.fillText(link.netName, (x1 + x2) / 2, (y1 + y2) / 2 - canvasPaintTokens.link.nameOffset)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      }
      ctx.globalAlpha = 1
    }

    const batchedOverviewReroutes = new Set<string>()
    if (detailLevel === 'overview' && this.scene.reroutes.length >= 256 && offsets === undefined &&
        this.scopeHighlight === undefined) {
      const batches = new Map<string | undefined, Array<readonly [number, number]>>()
      for (const reroute of this.scene.reroutes) {
        if (this.overlay.rerouteSelection?.has(reroute.id) === true ||
            this.overlay.dropTargets?.has(rerouteTargetKey(reroute.id)) === true ||
            this.overlay.hoveredReroute === reroute.id) continue
        const pad = Math.max(rerouteRadius + canvasPaintTokens.reroute.cullPadding, statusRingCullPad(rerouteRadius, scale))
        if (reroute.x + pad < view.x || reroute.x - pad > view.x + view.w ||
            reroute.y + pad < view.y || reroute.y - pad > view.y + view.h) continue
        const batch = batches.get(reroute.typeName) ?? []
        batch.push([reroute.x, reroute.y])
        batches.set(reroute.typeName, batch)
        batchedOverviewReroutes.add(reroute.id)
      }
      ctx.lineWidth = screenAwareStroke(canvasPaintTokens.reroute.stroke, scale, canvasPaintTokens.reroute.stroke)
      ctx.strokeStyle = t.colors.canvasBackground
      for (const [typeName, batch] of batches) {
        ctx.fillStyle = typeName === undefined
          ? t.colors.linkDefault
          : presentedType(t, { kind: 'concrete', name: typeName }).color
        ctx.beginPath()
        for (const [x, y] of batch) {
          ctx.moveTo(x + rerouteRadius, y)
          ctx.arc(x, y, rerouteRadius, 0, Math.PI * 2)
        }
        ctx.fill()
        ctx.stroke()
      }
    }

    // Reroute dots: over their noodles, under nodes. Colored by the traced
    // effective type so a whole chain reads as one wire.
    for (const r of this.scene.reroutes) {
      if (batchedOverviewReroutes.has(r.id)) continue
      const o = off(r.id)
      const rx = r.x + o.dx
      const ry = r.y + o.dy
      // Revealed ghost sockets extend the cull pad; the hover can only be on
      // an on-screen dot, but the sockets themselves must not clip mid-reveal.
      const pad = contentDetail && this.overlay.hoveredReroute === r.id
        ? REROUTE_SOCKET_OFFSET + REROUTE_SOCKET_RADIUS + canvasPaintTokens.reroute.cullPadding
        : Math.max(rerouteRadius + canvasPaintTokens.reroute.cullPadding, statusRingCullPad(rerouteRadius, scale))
      if (rx + pad < view.x || rx - pad > view.x + view.w || ry + pad < view.y || ry - pad > view.y + view.h) continue
      if (this.scopeHighlight && !this.scopeHighlight.reroutes.has(r.id)) ctx.globalAlpha = SCOPE_DIM
      if (this.overlay.dropTargets?.has(rerouteTargetKey(r.id))) {
        ctx.beginPath()
        ctx.arc(rx, ry, rerouteRadius + STATUS_RING_GAP, 0, Math.PI * 2)
        ctx.strokeStyle = t.colors.dropTarget
        ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
        ctx.stroke()
      }
      if (this.overlay.rerouteSelection?.has(r.id)) {
        ctx.beginPath()
        ctx.arc(rx, ry, rerouteRadius + canvasPaintTokens.reroute.selectionOutset, 0, Math.PI * 2)
        ctx.fillStyle = t.colors.nodeSelectedBorder
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(rx, ry, rerouteRadius, 0, Math.PI * 2)
      const dotColor = r.typeName ? presentedType(t, { kind: 'concrete', name: r.typeName }).color : t.colors.linkDefault
      ctx.fillStyle = dotColor
      ctx.fill()
      ctx.strokeStyle = t.colors.canvasBackground
      ctx.lineWidth = screenAwareStroke(canvasPaintTokens.reroute.stroke, scale, canvasPaintTokens.reroute.stroke)
      ctx.stroke()
      // Hover reveals ghost sockets: a hollow input socket left of the dot
      // and output socket right of it, each on a short stem. They advertise
      // the drag-a-link affordance ComfyUI users expect, replacing the
      // undiscoverable Alt+drag as the visible path to new connections.
      if (contentDetail && this.overlay.hoveredReroute === r.id) {
        for (const dir of [-1, 1]) {
          const sx = rx + dir * REROUTE_SOCKET_OFFSET
          ctx.strokeStyle = dotColor
          ctx.lineWidth = canvasPaintTokens.reroute.socketStroke
          ctx.beginPath()
          ctx.moveTo(rx + dir * REROUTE_RADIUS, ry)
          ctx.lineTo(sx - dir * REROUTE_SOCKET_RADIUS, ry)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(sx, ry, REROUTE_SOCKET_RADIUS, 0, Math.PI * 2)
          ctx.fillStyle = t.colors.canvasBackground
          ctx.fill()
          ctx.stroke()
        }
      }
      ctx.globalAlpha = 1
    }

    // Collapsed-net endpoint tags: a short lead from the pin plus a rounded
    // name tag. Same band as links (under nodes never matters: tags sit
    // outside node bounds by construction).
    for (const stub of this.scene.netStubs) {
      const viewOffset = off(stub.id)
      const pinOffset = off(stub.nodeId)
      // Tags ride along with a dragged owning node (offset geometry follows
      // it on commit too); only retired absolute geometry stays put.
      const bodyOffset = this.overlay.netViewSelection?.has(stub.id)
        ? viewOffset
        : stub.authoredAbsolute === true ? ZERO_OFFSET : pinOffset
      const sx = stub.x + bodyOffset.dx
      const sy = stub.y + bodyOffset.dy
      // Cull against the tag rect UNION the lead line (pin -> tag edge): near
      // a viewport border the lead is visible while the tag is not.
      const px = stub.pinX + pinOffset.dx
      const py = stub.pinY + pinOffset.dy
      const minX = Math.min(sx, px)
      const maxX = Math.max(sx + stub.width, px)
      const paint = canvasPaintTokens.net
      const minY = Math.min(sy, py - paint.leadCullPadding)
      const maxY = Math.max(sy + stub.height, py + paint.leadCullPadding)
      if (maxX < view.x || minX > view.x + view.w || maxY < view.y || minY > view.y + view.h) {
        continue
      }
      if (this.scopeHighlight && !this.scopeHighlight.nodes.has(stub.nodeId)) ctx.globalAlpha = SCOPE_DIM
      const color = stub.mismatch === true
        ? t.colors.error
        : stub.typeName ? typeColor(t, stub.typeName) : t.colors.linkDefault
      // Lead line pin -> tag edge.
      ctx.strokeStyle = color
      ctx.lineWidth = stub.mismatch === true
        ? screenAwareStroke(paint.mismatchLeadStroke, scale, paint.mismatchMinScreenStroke)
        : screenAwareStroke(paint.leadStroke, scale, paint.leadMinScreenStroke)
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(stub.role === 'source' ? sx : sx + stub.width, sy + stub.height / 2)
      ctx.stroke()
      // Tag body.
      ctx.fillStyle = t.colors.widgetBackground
      ctx.strokeStyle = color
      ctx.lineWidth = stub.mismatch === true
        ? screenAwareStroke(paint.mismatchStroke, scale, paint.mismatchMinScreenStroke)
        : screenAwareStroke(paint.stroke, scale, paint.stroke)
      ctx.beginPath()
      ctx.roundRect(sx, sy, stub.width, stub.height, stub.height / 2)
      ctx.fill()
      ctx.stroke()
      if (this.overlay.netViewSelection?.has(stub.id)) {
        ctx.beginPath()
        ctx.roundRect(sx - paint.selectionOutset, sy - paint.selectionOutset, stub.width + paint.selectionOutset * 2, stub.height + paint.selectionOutset * 2, stub.height / 2 + paint.selectionOutset)
        ctx.strokeStyle = t.colors.nodeSelectedBorder
        ctx.lineWidth = paint.selectionStroke / this.viewport.scale
        ctx.stroke()
      }
      ctx.font = `${t.fontSize}px ${t.fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = t.colors.label
      if (contentDetail) {
        ctx.fillText(`${stub.role === 'source' ? 'Set' : 'Get'} ${stub.name}`, sx + stub.width / 2, sy + stub.height / 2 + paint.baselineOffset)
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      ctx.globalAlpha = 1
    }

    // Set-to-Get guide curves for nets in guide display mode: a dashed
    // curve from the net's Set tag to every Get tag of the same net,
    // drawn over a background-colored casing so it stays readable across
    // ordinary noodles. Anchors reuse the tag positions and drag offsets
    // computed exactly like the tag loop above, so curves track moves.
    const guideStubs = this.scene.netStubs.filter((stub) => stub.guide === true)
    if (guideStubs.length > 0) {
      const anchorOf = (stub: SceneNetStub): { x: number; y: number } => {
        const bodyOffset = this.overlay.netViewSelection?.has(stub.id)
          ? off(stub.id)
          : stub.authoredAbsolute === true ? ZERO_OFFSET : off(stub.nodeId)
        const sx = stub.x + bodyOffset.dx
        const sy = stub.y + bodyOffset.dy
        // The tag's free edge: the lead line owns the pin-facing edge.
        return { x: stub.role === 'source' ? sx + stub.width : sx, y: sy + stub.height / 2 }
      }
      const sources = new Map<string, { point: { x: number; y: number }; color: string }>()
      for (const stub of guideStubs) {
        if (stub.role !== 'source') continue
        sources.set(stub.netId, {
          point: anchorOf(stub),
          color: stub.typeName ? typeColor(t, stub.typeName) : t.colors.linkDefault,
        })
      }
      ctx.save()
      for (const stub of guideStubs) {
        if (stub.role !== 'sink') continue
        const source = sources.get(stub.netId)
        if (source === undefined) continue
        const to = anchorOf(stub)
        const cdx = linkControlOffset(source.point.x, to.x)
        const trace = (): void => {
          ctx.beginPath()
          ctx.moveTo(source.point.x, source.point.y)
          ctx.bezierCurveTo(source.point.x + cdx, source.point.y, to.x - cdx, to.y, to.x, to.y)
          ctx.stroke()
        }
        ctx.strokeStyle = t.colors.canvasBackground
        ctx.lineWidth = screenAwareStroke(canvasPaintTokens.link.guideCasingStroke, scale, canvasPaintTokens.link.guideCasingMinScreenStroke)
        trace()
        ctx.strokeStyle = source.color
        ctx.lineWidth = screenAwareStroke(canvasPaintTokens.link.guideStroke, scale, canvasPaintTokens.link.guideMinScreenStroke)
        trace()
      }
      ctx.restore()
    }

    for (const sceneNode of scene.nodes) {
      const node = this.nodeForPaint(sceneNode)
      const o = off(node.id)
      const badges = contentDetail ? this.badgedNodeBounds(node) : undefined
      // External tabs can remain visible after the body leaves the viewport.
      if (
        (badges ? Math.max(node.x + node.layout.width + structurePad, badges.x + badges.width) : node.x + node.layout.width + structurePad) + o.dx < view.x ||
        (badges ? Math.min(node.x - structurePad, badges.x) : node.x - structurePad) + o.dx > view.x + view.w ||
        (badges ? Math.max(node.y + node.layout.height + structurePad, badges.y + badges.height) : node.y + node.layout.height + structurePad) + o.dy < view.y ||
        (badges ? Math.min(node.y - structurePad, badges.y) : node.y - structurePad) + o.dy > view.y + view.h
      ) {
        continue
      }
      this.drawNode(ctx, node, detailLevel, o.dx, o.dy)
    }

    // Boundary pseudo-nodes: drawn after regular nodes (they sit at the
    // periphery and must never be buried under a dragged-over node).
    for (const bnode of this.scene.boundaryNodes) {
      const o = off(boundarySceneId(bnode.side))
      if (
        bnode.x + o.dx + bnode.layout.width + structurePad < view.x ||
        bnode.x + o.dx - structurePad > view.x + view.w ||
        bnode.y + o.dy + bnode.layout.height + structurePad < view.y ||
        bnode.y + o.dy - structurePad > view.y + view.h
      ) {
        continue
      }
      this.drawBoundaryNode(ctx, bnode, detailLevel, o.dx, o.dy)
    }

    // One enclosure makes a heterogeneous selection read as a group before
    // the drag begins; individual halos still preserve exact membership.
    const union = this.selectionUnionOutlineRect()
    if (union) {
      ctx.beginPath()
      ctx.setLineDash(screenAwareDash(canvasPaintTokens.dash.selectionUnion.world, canvasPaintTokens.dash.selectionUnion.screen, scale))
      ctx.strokeStyle = t.colors.nodeSelectedBorder
      ctx.lineWidth = MULTI_SELECTION_OUTLINE_STROKE_WIDTH / this.viewport.scale
      ctx.strokeRect(union.x, union.y, union.width, union.height)
      ctx.setLineDash([])
    }

    if (this.overlay.ghostLink) {
      const g = this.overlay.ghostLink
      ctx.save()
      this.drawLink(ctx, g.x1, g.y1, g.x2, g.y2, g.typeName)
      ctx.restore()
    }

    if (this.overlay.ghostLinks) {
      ctx.save()
      for (const g of this.overlay.ghostLinks) {
        this.drawLink(ctx, g.x1, g.y1, g.x2, g.y2, g.typeName)
      }
      ctx.restore()
    }

    if (this.overlay.marquee) {
      const m = this.overlay.marquee
      ctx.save()
      ctx.fillStyle = this.tokens.colors.selection
      ctx.globalAlpha = canvasPaintTokens.overlay.marqueeOpacity
      ctx.fillRect(m.x1, m.y1, m.x2 - m.x1, m.y2 - m.y1)
      ctx.globalAlpha = 1
      ctx.setLineDash(screenAwareDash(canvasPaintTokens.dash.marquee.world, canvasPaintTokens.dash.marquee.screen, scale))
      ctx.strokeStyle = this.tokens.colors.selection
      ctx.lineWidth = screenAwareStroke(canvasPaintTokens.overlay.marqueeStroke, scale, canvasPaintTokens.overlay.marqueeStroke)
      ctx.strokeRect(m.x1, m.y1, m.x2 - m.x1, m.y2 - m.y1)
      ctx.restore()
    }

    if (this.overlay.groupResizeGhost) {
      const g = this.overlay.groupResizeGhost
      const group = this.scene.groups.find((sg) => sg.id === g.groupId)
      if (group) {
        ctx.save()
        ctx.setLineDash(screenAwareDash(canvasPaintTokens.dash.ghost.world, canvasPaintTokens.dash.ghost.screen, scale))
        ctx.strokeStyle = this.tokens.colors.selection
        ctx.lineWidth = screenAwareStroke(canvasPaintTokens.overlay.ghostStroke, scale, canvasPaintTokens.overlay.ghostStroke)
        ctx.beginPath()
        ctx.roundRect(g.x, g.y, g.width, g.height, this.tokens.cornerRadius)
        ctx.stroke()
        ctx.restore()
      }
    }

    if (this.overlay.placementGhost) {
      const g = this.overlay.placementGhost
      ctx.save()
      ctx.globalAlpha = canvasPaintTokens.overlay.placementOpacity
      ctx.fillStyle = this.tokens.colors.nodeBody
      ctx.strokeStyle = this.tokens.colors.selection
      ctx.lineWidth = screenAwareStroke(canvasPaintTokens.overlay.ghostStroke, scale, canvasPaintTokens.overlay.ghostStroke)
      ctx.beginPath()
      ctx.roundRect(g.x, g.y, g.width, g.height, this.tokens.cornerRadius)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = this.tokens.colors.nodeHeader
      ctx.beginPath()
      ctx.roundRect(g.x, g.y, g.width, this.tokens.headerHeight, [this.tokens.cornerRadius, this.tokens.cornerRadius, 0, 0])
      ctx.fill()
      ctx.fillStyle = this.tokens.colors.title
      ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${this.tokens.titleFontSize}px ${this.tokens.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.save()
      ctx.beginPath()
      ctx.rect(g.x + this.tokens.padX, g.y, g.width - this.tokens.padX * 2, this.tokens.headerHeight)
      ctx.clip()
      ctx.fillText(g.title, g.x + this.tokens.padX, g.y + this.tokens.headerHeight / 2)
      ctx.restore()
      ctx.restore()
    }
  }

  private drawCanvasLayers(
    position: CanvasLayerContribution['position'],
    context: CanvasRenderingContext2D,
    viewport: Readonly<{ x: number; y: number; w: number; h: number }>,
    scale: number,
  ): void {
    const layers = this.canvasLayers.filter((layer) =>
      layer.position === position && (layer.id !== 'core.canvas.grid' || this.gridVisible))
    if (layers.length === 0) return
    const input = Object.freeze({
      context,
      colors: this.tokens.colors,
      viewport: Object.freeze({ x: viewport.x, y: viewport.y, width: viewport.w, height: viewport.h, scale }),
      nodes: this.canvasLayerNodes,
    })
    for (const layer of layers) {
      context.save()
      try {
        layer.draw(input)
      } catch (error) {
        if (!this.failedCanvasLayers.has(layer.id)) {
          this.failedCanvasLayers.add(layer.id)
          this.canvasLayerError(layer.id, error)
        }
      } finally {
        context.restore()
      }
    }
  }

  private drawTypeAdornments(
    ctx: CanvasRenderingContext2D,
    view: Readonly<{ x: number; y: number; w: number; h: number }>,
  ): void {
    if (this.getDetailLevel() === 'overview' || this.typeAdornments.length === 0) return
    const offset = (id: string) => this.overlay.dragOffsets?.get(id) ?? ZERO_OFFSET
    let visible = 0
    for (const descriptor of this.typeAdornments) {
      let anchorX: number
      let anchorY: number
      if (descriptor.anchor === 'link-midpoint') {
        if (this.overlay.hiddenLinkIds?.has(descriptor.link.id)) continue
        const fromOffset = offset(sceneEndId(descriptor.link.from))
        const toOffset = offset(sceneEndId(descriptor.link.to))
        anchorX = (descriptor.link.x1 + fromOffset.dx + descriptor.link.x2 + toOffset.dx) / 2
        anchorY = (descriptor.link.y1 + fromOffset.dy + descriptor.link.y2 + toOffset.dy) / 2
        if (anchorX < view.x || anchorX > view.x + view.w ||
          anchorY < view.y || anchorY > view.y + view.h) continue
      } else {
        const nodeOffset = offset(descriptor.node.id)
        anchorX = descriptor.node.x + nodeOffset.dx
        anchorY = descriptor.node.y + nodeOffset.dy
        if (anchorX + descriptor.node.layout.width < view.x || anchorX > view.x + view.w ||
          anchorY + descriptor.node.layout.height < view.y || anchorY > view.y + view.h) continue
      }
      const boundsX = anchorX + descriptor.bounds.x
      const boundsY = anchorY + descriptor.bounds.y
      const boundsWidth = descriptor.bounds.width
      const boundsHeight = descriptor.bounds.height
      if (!Number.isFinite(boundsX) || !Number.isFinite(boundsY) ||
        !Number.isFinite(boundsWidth) || !Number.isFinite(boundsHeight)) continue
      if (boundsX + boundsWidth < view.x || boundsX > view.x + view.w ||
        boundsY + boundsHeight < view.y || boundsY > view.y + view.h) continue
      if (visible >= TYPE_ADORNMENT_MAX_VISIBLE) break
      visible += 1

      ctx.save()
      ctx.beginPath()
      ctx.rect(boundsX, boundsY, boundsWidth, boundsHeight)
      ctx.clip()
      const fontSize = descriptor.fontRole === 'compact-semibold'
        ? this.tokens.fontSize
        : Math.max(canvasPaintTokens.type.adornmentMinSize, this.tokens.fontSize - canvasPaintTokens.type.adornmentReduction)
      ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${fontSize}px ${this.tokens.fontFamily}`
      ctx.fillStyle = adornmentTextColor(this.tokens, descriptor.textRole)
      ctx.textAlign = descriptor.anchor === 'link-midpoint' ? 'center' : 'right'
      ctx.textBaseline = descriptor.anchor === 'link-midpoint' ? 'bottom' : 'middle'
      ctx.fillText(descriptor.text, anchorX + descriptor.x, anchorY + descriptor.y)
      ctx.restore()
    }
  }

  /**
   * Remote participants: selection tints, then cursors on the very top.
   * Selection rings sit OUTSIDE the local halo (-3/+6) and the scope ring
   * (-5/+10) so all three read at once; cursors and labels divide by scale
   * so they keep a constant screen size at any zoom.
   */
  private drawPresence(ctx: CanvasRenderingContext2D, scale: number): void {
    if (this.presence.length === 0) return
    const t = this.tokens
    const paint = canvasPaintTokens.presence
    const rerouteSelectors = new Map<string, PresenceActor[]>()
    for (const actor of this.presence) {
      for (const id of actor.rerouteSelection ?? []) {
        const selectors = rerouteSelectors.get(id) ?? []
        selectors.push(actor)
        rerouteSelectors.set(id, selectors)
      }
    }
    const rerouteHaloRanks = new Map<string, ReadonlyMap<string, number>>()
    for (const [id, selectors] of rerouteSelectors) {
      selectors.sort((a, b) => a.id.localeCompare(b.id))
      rerouteHaloRanks.set(id, new Map(selectors.map((actor, rank) => [actor.id, rank])))
    }
    for (const actor of this.presence) {
      if (actor.link !== undefined) {
        const origin = actor.link.origin
        const start = origin.kind === 'port'
          ? (() => {
              const node = this.scene.nodes.find((candidate) => candidate.id === origin.node)
              const pin = node?.layout.pins.find((candidate) =>
                candidate.portId === origin.port && candidate.direction === origin.side && candidate.widgetTap !== true,
              )
              return node !== undefined && pin !== undefined
                ? { x: origin.side === 'out' ? node.x + node.layout.width : node.x, y: node.y + pin.y }
                : undefined
            })()
          : origin.kind === 'widgetTap'
            ? (() => {
                const node = this.scene.nodes.find((candidate) => candidate.id === origin.node)
                const pin = node?.layout.pins.find((candidate) =>
                  candidate.widgetTap === true && candidate.address.port === origin.input,
                )
                return node !== undefined && pin !== undefined
                  ? { x: node.x + node.layout.width, y: node.y + pin.y }
                  : undefined
              })()
          : (() => {
              const reroute = this.scene.reroutes.find((candidate) => candidate.id === origin.reroute)
              return reroute !== undefined ? { x: reroute.x, y: reroute.y } : undefined
            })()
        if (start !== undefined) {
          ctx.save()
          ctx.strokeStyle = actor.color
          ctx.lineWidth = paint.linkStroke
          ctx.globalAlpha = paint.ghostOpacity
          const inputOrigin = origin.kind !== 'widgetTap' && origin.side === 'in'
          this.drawLink(
            ctx,
            inputOrigin ? actor.link.cursor.x : start.x,
            inputOrigin ? actor.link.cursor.y : start.y,
            inputOrigin ? start.x : actor.link.cursor.x,
            inputOrigin ? start.y : actor.link.cursor.y,
            undefined,
            {
              color: actor.color,
              width: paint.linkStroke,
            },
          )
          ctx.restore()
        }
      }
      // Remote drag ghosts first (underneath rings): a dashed outline at the
      // dragged position while the REAL entity stays put - presence paints
      // where the peer is taking it, never scene layout itself.
      if (actor.drag !== undefined && actor.drag.size > 0) {
        ctx.save()
        ctx.strokeStyle = actor.color
        ctx.lineWidth = paint.dragStroke
        ctx.globalAlpha = paint.ghostOpacity
        ctx.setLineDash([...canvasPaintTokens.dash.remote])
        for (const node of this.scene.nodes) {
          const o = actor.drag.get(node.id)
          if (o === undefined || (o.dx === 0 && o.dy === 0)) continue
          ctx.beginPath()
          ctx.roundRect(node.x + o.dx, node.y + o.dy, node.layout.width, node.layout.height, t.cornerRadius)
          ctx.stroke()
        }
        for (const reroute of this.scene.reroutes) {
          const o = actor.drag.get(reroute.id)
          if (o === undefined || (o.dx === 0 && o.dy === 0)) continue
          ctx.beginPath()
          ctx.arc(reroute.x + o.dx, reroute.y + o.dy, REROUTE_RADIUS, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()
      }
      // Hover: a thin faint outline, deliberately weaker than the selection
      // ring so glance-attention and held-selection never read the same.
      if (actor.hover !== undefined && !actor.selection.has(actor.hover)) {
        const node = this.scene.nodes.find((n) => n.id === actor.hover)
        if (node !== undefined) {
          const o = actor.drag?.get(node.id) ?? this.overlay.dragOffsets?.get(node.id)
          ctx.save()
          ctx.strokeStyle = actor.color
          ctx.lineWidth = paint.hoverStroke
          ctx.globalAlpha = paint.hoverOpacity
          ctx.beginPath()
          ctx.roundRect(
            node.x + (o?.dx ?? 0) - paint.hoverOutset, node.y + (o?.dy ?? 0) - paint.hoverOutset,
            node.layout.width + paint.hoverOutset * 2, node.layout.height + paint.hoverOutset * 2, t.cornerRadius + paint.hoverOutset,
          )
          ctx.stroke()
          ctx.restore()
        }
      }
      if (actor.selection.size === 0 && (actor.rerouteSelection?.size ?? 0) === 0) continue
      ctx.save()
      ctx.strokeStyle = actor.color
      ctx.lineWidth = paint.selectionStroke
      ctx.globalAlpha = paint.selectionOpacity
      for (const node of this.scene.nodes) {
        if (!actor.selection.has(node.id)) continue
        // Ride the actor's OWN drag offsets when it is mid-drag (peers see
        // the ring travel with the ghost), else local drag offsets so the
        // ring tracks a node WE are dragging.
        const o = actor.drag?.get(node.id) ?? this.overlay.dragOffsets?.get(node.id)
        const nx = node.x + (o?.dx ?? 0)
        const ny = node.y + (o?.dy ?? 0)
        ctx.beginPath()
        ctx.roundRect(nx - paint.selectionOutset, ny - paint.selectionOutset, node.layout.width + paint.selectionOutset * 2, node.layout.height + paint.selectionOutset * 2, t.cornerRadius + paint.selectionOutset)
        ctx.stroke()
      }
      for (const reroute of this.scene.reroutes) {
        if (!actor.rerouteSelection?.has(reroute.id)) continue
        const o = actor.drag?.get(reroute.id) ?? this.overlay.dragOffsets?.get(reroute.id)
        const rank = rerouteHaloRanks.get(reroute.id)?.get(actor.id) ?? 0
        ctx.beginPath()
        ctx.arc(
          reroute.x + (o?.dx ?? 0), reroute.y + (o?.dy ?? 0),
          REROUTE_RADIUS + paint.rerouteOutset + rank * paint.rerouteRankGap, 0, Math.PI * 2,
        )
        ctx.stroke()
      }
      ctx.restore()
    }
    for (const actor of this.presence) {
      const c = actor.cursor
      if (c === undefined) continue
      const s = 1 / scale
      ctx.save()
      ctx.translate(c.x, c.y)
      ctx.scale(s, s)
      // Pointer triangle with a dark seam so it reads on any node color.
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, paint.cursor.tailY)
      ctx.lineTo(paint.cursor.notchX, paint.cursor.notchY)
      ctx.lineTo(paint.cursor.tip, paint.cursor.tip)
      ctx.closePath()
      ctx.fillStyle = actor.color
      ctx.strokeStyle = t.colors.canvasBackground
      ctx.lineWidth = paint.cursor.stroke
      ctx.fill()
      ctx.stroke()
      // Label pill anchored to the pointer tail.
      ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${t.fontSize}px ${t.fontFamily}`
      const label = actor.label
      const tw = ctx.measureText(label).width
      const px = paint.label.x
      const py = paint.label.y
      const padX = paint.label.paddingX
      const h = t.fontSize + paint.label.heightPadding
      ctx.beginPath()
      ctx.roundRect(px, py, tw + padX * 2, h, h / 2)
      ctx.fillStyle = actor.color
      ctx.fill()
      ctx.fillStyle = paint.label.color
      ctx.textBaseline = 'middle'
      ctx.fillText(label, px + padX, py + h / 2 + paint.label.baselineOffset)
      ctx.restore()
    }
  }

  /** Floating strip of selection actions above the selection bbox. */
  private drawToolbox(ctx: CanvasRenderingContext2D, tl: ToolboxLayout): void {
    const t = this.tokens
    const scale = this.viewport.scale
    ctx.save()
    ctx.beginPath()
    const top = tl.rows[0]?.panel
    const bottom = tl.rows[1]?.panel
    const paint = canvasPaintTokens.toolbox
    const radius = paint.panelRadius / scale
    const inner = top && bottom ? Math.min(paint.innerRadius / scale, (bottom.y - top.y) / 2) : 0
    const joined = top && bottom && bottom.width - top.width >= 2 * (radius + inner)
    if (joined) {
      ctx.moveTo(top.x + radius, top.y)
      ctx.lineTo(top.x + top.width - radius, top.y)
      ctx.quadraticCurveTo(top.x + top.width, top.y, top.x + top.width, top.y + radius)
      ctx.lineTo(top.x + top.width, bottom.y - inner)
      ctx.quadraticCurveTo(top.x + top.width, bottom.y, top.x + top.width + inner, bottom.y)
      ctx.lineTo(bottom.x + bottom.width - radius, bottom.y)
      ctx.quadraticCurveTo(bottom.x + bottom.width, bottom.y, bottom.x + bottom.width, bottom.y + radius)
      ctx.lineTo(bottom.x + bottom.width, bottom.y + bottom.height - radius)
      ctx.quadraticCurveTo(bottom.x + bottom.width, bottom.y + bottom.height, bottom.x + bottom.width - radius, bottom.y + bottom.height)
      ctx.lineTo(bottom.x + radius, bottom.y + bottom.height)
      ctx.quadraticCurveTo(bottom.x, bottom.y + bottom.height, bottom.x, bottom.y + bottom.height - radius)
      ctx.lineTo(bottom.x, bottom.y + radius)
      ctx.quadraticCurveTo(bottom.x, bottom.y, bottom.x + radius, bottom.y)
      ctx.lineTo(top.x - inner, bottom.y)
      ctx.quadraticCurveTo(top.x, bottom.y, top.x, bottom.y - inner)
      ctx.lineTo(top.x, top.y + radius)
      ctx.quadraticCurveTo(top.x, top.y, top.x + radius, top.y)
      ctx.closePath()
      for (const row of tl.rows.slice(2)) {
        ctx.roundRect(row.panel.x, row.panel.y, row.panel.width, row.panel.height, radius)
      }
    } else {
      for (const row of tl.rows) {
        ctx.roundRect(row.panel.x, row.panel.y, row.panel.width, row.panel.height, radius)
      }
    }
    ctx.fillStyle = t.colors.nodeHeader
    ctx.fill()
    ctx.strokeStyle = t.colors.nodeBorder
    ctx.lineWidth = paint.borderStroke / scale
    ctx.stroke()
    // The context is camera-scaled, so font size must return to world units
    // just like the toolbox geometry to remain stable in screen pixels.
    ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${t.fontSize / scale}px ${t.fontFamily}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const row of tl.rows) for (const entry of row.entries) {
      if (entry.kind === 'separator') {
        ctx.beginPath()
        ctx.moveTo(entry.x + entry.width / 2, entry.y)
        ctx.lineTo(entry.x + entry.width / 2, entry.y + entry.height)
        ctx.strokeStyle = t.colors.nodeBorder
        ctx.lineWidth = entry.width
        ctx.stroke()
        continue
      }
      const r = entry
      const active = r.button.active === true
      ctx.save()
      if (r.button.disabled === true) ctx.globalAlpha = paint.disabledOpacity
      ctx.beginPath()
      ctx.roundRect(r.x, r.y, r.size, r.size, paint.buttonRadius / scale)
      ctx.fillStyle = active ? t.colors.selection : t.colors.widgetBackground
      ctx.fill()
      const glyphColor = r.button.iconColor ?? (active ? t.colors.canvasBackground : t.colors.label)
      if (r.button.icon) {
        const icon = r.size * paint.iconSize / paint.buttonSize
        paintToolboxIcon(ctx, r.button.icon, r.x + (r.size - icon) / 2, r.y + (r.size - icon) / 2, icon, glyphColor)
      } else if (r.button.glyph) {
        ctx.fillStyle = glyphColor
        ctx.fillText(r.button.glyph, r.x + r.size / 2, r.y + r.size / 2 + paint.glyphBaselineOffset)
      }
      ctx.restore()
    }
    ctx.restore()
  }

  /** Group rectangle: translucent fill, title band, border, and title. */
  private drawGroup(
    ctx: CanvasRenderingContext2D,
    group: SceneGroup,
    x: number,
    y: number,
    detailLevel: CanvasDetailLevel,
  ): void {
    const t = this.tokens
    const color = group.color ?? t.colors.groupDefault
    ctx.save()
    // Body: barely-there tint so noodles/nodes stay legible on top.
    ctx.beginPath()
    ctx.roundRect(x, y, group.width, group.height, t.cornerRadius)
    ctx.globalAlpha = canvasPaintTokens.group.fillOpacity
    ctx.fillStyle = color
    ctx.fill()
    // Title band (the drag handle).
    ctx.beginPath()
    ctx.roundRect(x, y, group.width, GROUP_HEADER_HEIGHT, [t.cornerRadius, t.cornerRadius, 0, 0])
    ctx.globalAlpha = canvasPaintTokens.group.headerOpacity
    ctx.fill()
    // Border.
    ctx.globalAlpha = canvasPaintTokens.group.borderOpacity
    ctx.beginPath()
    ctx.roundRect(x, y, group.width, group.height, t.cornerRadius)
    ctx.strokeStyle = color
    ctx.lineWidth = screenAwareStroke(canvasPaintTokens.group.stroke, this.viewport.scale, canvasPaintTokens.group.stroke)
    ctx.stroke()
    // Title.
    if (detailLevel !== 'overview') {
      ctx.globalAlpha = 1
      ctx.fillStyle = t.colors.title
      ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${t.titleFontSize}px ${t.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText(group.title, x + t.padX, y + GROUP_HEADER_HEIGHT / 2, group.width - t.padX * 2)
    }
    ctx.restore()
  }

  private drawLink(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    typeName?: string,
    style?: { readonly color: string; readonly width: number; readonly minScreenWidth?: number },
  ): void {
    const t = this.tokens
    ctx.strokeStyle = style?.color ?? (typeName ? presentedType(t, { kind: 'concrete', name: typeName }).color : t.colors.linkDefault)
    ctx.lineWidth = screenAwareStroke(style?.width ?? canvasPaintTokens.link.stroke, this.viewport.scale, style?.minScreenWidth ?? canvasPaintTokens.link.minScreenStroke)
    ctx.beginPath()
    this.appendLinkPath(ctx, x1, y1, x2, y2)
    ctx.stroke()
  }

  private appendLinkPath(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ): void {
    ctx.moveTo(x1, y1)
    // Shared with hit testing and culling (hit.ts linkControlOffset).
    const dx = linkControlOffset(x1, x2)
    ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2)
  }

  /** Project a resized node's attached noodle endpoint onto the same live geometry as its painted pin. */
  private linkEndForPaint(
    end: SceneLinkEnd,
    direction: 'in' | 'out',
    fallbackX: number,
    fallbackY: number,
  ): { readonly x: number; readonly y: number } {
    if ((end.kind !== 'port' && end.kind !== 'widgetTap') ||
        (end.node !== this.overlay.resizePreview?.nodeId && end.node !== this.overlay.textBoxLines?.nodeId &&
          end.node !== this.overlay.pictureHeight?.nodeId)) {
      return { x: fallbackX, y: fallbackY }
    }
    const sceneNode = this.scene.nodes.find((candidate) => candidate.id === end.node)
    const node = sceneNode === undefined ? undefined : this.nodeForPaint(sceneNode)
    const pin = end.kind === 'widgetTap'
      ? node?.layout.pins.find((candidate) => candidate.widgetTap === true && candidate.address.port === end.input)
      : node?.layout.pins.find((candidate) =>
          candidate.direction === direction && candidate.portId === end.port && candidate.widgetTap !== true,
        )
    if (node === undefined || pin === undefined) return { x: fallbackX, y: fallbackY }
    return {
      x: node.x + (direction === 'out' ? node.layout.width : 0),
      y: node.y + pin.y,
    }
  }

  /** Paint-only projection for an in-flight resize; scene and hit geometry stay committed. */
  private nodeForPaint(node: SceneNode): SceneNode {
    const lines = this.overlay.textBoxLines
    if (lines?.nodeId === node.id) {
      return { ...node, layout: projectTextBoxLines(node.layout, lines.valueKey, lines.lines, this.tokens) }
    }
    const picture = this.overlay.pictureHeight
    if (picture?.nodeId === node.id) return { ...node, layout: projectPictureHeight(node.layout, picture.valueKey, picture.height) }
    const preview = this.overlay.resizePreview
    if (preview?.nodeId !== node.id) return node
    const layout = projectNodeLayoutHeight(node.layout, preview.height, this.tokens)
    return {
      ...node,
      x: preview.x,
      y: preview.y,
      layout: {
        ...layout,
        width: preview.width,
        ...(layout.preview === undefined ? {} : {
          preview: { ...layout.preview, width: Math.max(0, preview.width - this.tokens.padX * 2) },
        }),
        ...(layout.textOutput === undefined ? {} : {
          textOutput: { ...layout.textOutput, width: Math.max(0, preview.width - this.tokens.padX * 2) },
        }),
      },
    }
  }

  /** Let the canvas clip the outline without adding a false edge through the node. */
  private drawSelectionOutline(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    outset: number,
    radius: number,
    strokeWidth: number,
  ): void {
    ctx.save()
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.roundRect(x - outset, y - outset, width + outset * 2, height + outset * 2, radius + outset)
    ctx.strokeStyle = this.tokens.colors.nodeSelectedBorder
    ctx.lineWidth = strokeWidth
    ctx.stroke()
    ctx.restore()
  }

  /** Core mode tabs follow the theme; other badges carry their own color. */
  private badgeColor(badge: NodeBadge): string {
    const t = this.tokens
    return badge.id === MUTED_BADGE.id ? t.colors.mutedBadge
      : badge.id === BYPASSED_BADGE.id ? t.colors.bypassedBadge
        : badge.id === LAST_RUN_BADGE.id ? t.colors.label : badge.color
  }

  /** The title bar's minimize arrow: down on an open node, right on a minimized one. */
  private drawMinimizeArrow(ctx: CanvasRenderingContext2D, node: SceneNode): void {
    const rect = minimizeArrowRect(node)
    const hovered = this.overlay.hoveredMinimize === node.id
    if (hovered) {
      ctx.fillStyle = this.tokens.colors.widgetRaised
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, canvasPaintTokens.node.minimizeArrow.hoverRadius)
      ctx.fill()
    }
    ctx.fillStyle = hovered ? this.tokens.colors.title : this.tokens.colors.label
    paintDisclosureArrow(ctx, rect.x + rect.width / 2, rect.y + rect.height / 2, node.layout.minimized !== true)
  }

  /**
   * A tab: a tint of its color as fill, a 1 px line and the icon and words in
   * that color. The title mark is the same look over the title bar.
   */
  private drawBadgeTabs(ctx: CanvasRenderingContext2D, node: SceneNode, entries: readonly BadgePlacement[]): void {
    const t = this.tokens
    const paint = { ...canvasPaintTokens.badge.tab, ...t.badgeTab }
    const mark = canvasPaintTokens.badge.mark
    const hovered = this.overlay.hoveredBadge
    for (const entry of entries) {
      const { badge, x, y, width, height } = entry
      const hover = hovered?.nodeId === node.id && hovered.badgeId === badge.id
      const title = badge.placement === 'title'
      const color = this.badgeColor(badge)
      const ground = title ? t.colors.nodeHeader : t.colors.canvasBackground
      const words = tintHex(t.colors.title, color, paint.textMix)
      ctx.save()
      ctx.globalAlpha = 1
      ctx.beginPath()
      ctx.roundRect(x + paint.stroke / 2, y + paint.stroke / 2, width - paint.stroke, height - paint.stroke, canvasPaintTokens.badge.radius)
      ctx.fillStyle = tintHex(ground, color, hover ? paint.hoverFillMix : paint.fillMix)
      ctx.fill()
      ctx.lineWidth = paint.stroke
      ctx.strokeStyle = hover ? words : tintHex(ground, color, paint.lineMix)
      ctx.stroke()
      ctx.clip()
      ctx.fillStyle = words
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${paint.fontSize}px ${t.fontFamily}`
      const textY = y + height / 2 + canvasPaintTokens.badge.baselineOffset
      if (title) {
        if (badge.icon !== undefined) paintToolboxIcon(ctx, badge.icon, x + mark.padding, y + (height - mark.iconSize) / 2, mark.iconSize, words)
        if (badge.count !== undefined) ctx.fillText(String(badge.count), x + mark.padding + mark.iconSize + mark.gap, textY)
      } else if (entry.overflow) {
        ctx.textAlign = 'center'
        ctx.fillText(fitText(ctx, badge.glyph, width), x + width / 2, textY)
      } else {
        let textX = x + paint.padding
        if (badge.icon !== undefined) {
          paintToolboxIcon(ctx, badge.icon, textX, y + (height - paint.iconSize) / 2, paint.iconSize, words)
          textX += paint.iconSize + paint.iconGap
        }
        if (!entry.compact || badge.icon === undefined) {
          ctx.fillText(fitText(ctx, badge.glyph, Math.max(0, x + width - paint.padding - textX)), textX, textY)
        }
      }
      ctx.restore()
    }
  }

  /** The node whose title is being renamed, which draws no title suffix meanwhile. */
  private renamingNode: string | undefined

  setRenamingNode(nodeId: string | undefined): void {
    if (this.renamingNode === nodeId) return
    this.renamingNode = nodeId
    this.requestRender()
  }

  /**
   * A title suffix one space after the title, in the row names' dim regular
   * type. It gives way before the title: cut with an ellipsis when `cut`,
   * dropped whole when it does not fit or fewer than three characters would
   * show.
   */
  private drawTitleSuffix(ctx: CanvasRenderingContext2D, suffix: string | undefined, left: number, right: number, y: number, cut: boolean): void {
    if (suffix === undefined) return
    const t = this.tokens
    ctx.save()
    ctx.font = `${t.titleFontSize}px ${t.fontFamily}`
    const x = left + measureWidth(ctx, ' ')
    const room = right - x
    let text: string | undefined = suffix
    if (measureWidth(ctx, suffix) > room) {
      const fitted = cut ? fitText(ctx, suffix, room) : ''
      text = fitted.length - '...'.length >= 3 ? fitted : undefined
    }
    if (text !== undefined) {
      ctx.fillStyle = t.colors.label
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText(text, x, y)
    }
    ctx.restore()
  }

  private drawNode(
    ctx: CanvasRenderingContext2D,
    sceneNode: SceneNode,
    detailLevel: CanvasDetailLevel,
    dx = 0,
    dy = 0,
  ): void {
    const t = this.tokens
    const l: NodeLayout = sceneNode.layout
    const decoration = this.nodeDecorations[sceneNode.id]
    const nodeColor = decoration?.color ?? sceneNode.color
    const title = decoration?.status === undefined ? l.title : `${l.title} (${decoration.status})`
    // The declared suffix first, then an extension's; neither while the title is being renamed.
    const suffix = this.renamingNode === sceneNode.id
      ? undefined
      : [l.titleSuffix, decoration?.titleSuffix].filter((part) => part !== undefined && part !== '').join(' ') || undefined
    const progress = this.nodeStates[sceneNode.id]
    // Local alias with the drag offset applied; everything below reads node.x/y.
    const node = dx === 0 && dy === 0 ? sceneNode : { ...sceneNode, x: sceneNode.x + dx, y: sceneNode.y + dy }
    const selected = this.overlay.selection?.has(node.id) ?? false
    const unrecognized = node.unrecognized === true || node.missingSchema === true
    const scale = this.viewport.scale
    const contentDetail = detailLevel !== 'overview'
    const pinRadius = detailRadius(t.pinRadius, scale, detailLevel)
    const selectionStrokeWidth = screenAwareStroke(SELECTION_OUTLINE_STROKE_WIDTH, scale, canvasPaintTokens.toolbox.selectionMinScreenStroke)

    if (this.overlay.bodyDropNode === node.id) {
      const paint = canvasPaintTokens.node.drop
      ctx.beginPath()
      ctx.roundRect(node.x - paint.outset, node.y - paint.outset, l.width + paint.outset * 2, l.height + paint.outset * 2, t.cornerRadius + paint.outset)
      ctx.strokeStyle = t.colors.dropTarget
      ctx.globalAlpha = paint.opacity
      ctx.lineWidth = screenAwareStroke(paint.stroke, scale, paint.stroke)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Partial-queue preview uses the live-affordance accent, deliberately
    // distinct from both the white selection halo and muted-node dimming.
    if (this.scopeHighlight?.nodes.has(node.id)) {
      const paint = canvasPaintTokens.node.scope
      ctx.beginPath()
      ctx.roundRect(node.x - paint.outset, node.y - paint.outset, l.width + paint.outset * 2, l.height + paint.outset * 2, t.cornerRadius + paint.outset)
      ctx.strokeStyle = t.colors.selection
      ctx.lineWidth = screenAwareStroke(paint.stroke, scale, paint.minScreenStroke)
      ctx.stroke()
    }

    // Semantic mode, view concern here only: MUTE and BYPASS both dim the
    // node; BYPASS additionally gets a purple wash (ComfyUI's convention),
    // so the two modes remain distinguishable.
    // Out-of-scope nodes dim during a partial-execution preview.
    const mode = node.node.mode ?? 'active'
    let alpha = mode === 'muted' || mode === 'bypassed' ? canvasPaintTokens.node.modeOpacity : 1
    if ((this.scopeHighlight && !this.scopeHighlight.nodes.has(node.id)) || this.inactiveNodes?.has(node.id)) alpha *= SCOPE_DIM
    ctx.globalAlpha = alpha

    // Body/header colors are pre-mixed into one opaque color so mode alpha is
    // applied exactly once. Unrecognized paint outranks identity color.
    ctx.beginPath()
    ctx.roundRect(node.x, node.y, l.width, l.height, t.cornerRadius)
    ctx.fillStyle = unrecognized
      ? tintHex(t.colors.nodeBody, t.colors.error, canvasPaintTokens.node.errorBodyTint)
      : nodeColor === undefined ? t.colors.nodeBody : tintHex(t.colors.nodeBody, nodeColor, canvasPaintTokens.node.identityBodyTint)
    ctx.fill()
    // Header.
    ctx.beginPath()
    ctx.roundRect(node.x, node.y, l.width, l.headerHeight, [t.cornerRadius, t.cornerRadius, 0, 0])
    ctx.fillStyle = unrecognized
      ? tintHex(t.colors.nodeHeader, t.colors.error, canvasPaintTokens.node.errorHeaderTint)
      : nodeColor === undefined ? t.colors.nodeHeader : tintHex(t.colors.nodeHeader, nodeColor, canvasPaintTokens.node.identityHeaderTint)
    ctx.fill()
    paintHeaderRule(ctx, t, node.x, node.y, l.width, l.headerHeight, l.height)
    // Bypass wash: over body+header, under text, so content stays legible.
    if (mode === 'bypassed') {
      ctx.beginPath()
      ctx.roundRect(node.x, node.y, l.width, l.height, t.cornerRadius)
      ctx.fillStyle = t.colors.bypassWash
      ctx.fill()
    }
    // State border. A node with a document Error keeps an emphasized red
    // outline, the one sign that still reads zoomed out or on a minimized
    // node; a Warning adds nothing to the outline. It is solid, since a
    // dashed red node reads as one whose type is not installed. Document
    // errors and runtime errors win over running because they stop execution.
    const hasDocumentError = (this.badges[node.id] ?? []).some((badge) => badge.id === PROBLEM_ERROR_BADGE.id)
    const runtimeError = progress?.state === 'error'
    const running = progress?.state === 'running'
    const outlineColor = unrecognized
      ? t.colors.error
      : runtimeError
        ? t.stateColors.error
        : hasDocumentError
          ? t.colors.error
          : running
            ? t.stateColors.running
            : progress
              ? t.stateColors[progress.state]
              : t.colors.nodeIdleOutline
    const strongOutline = unrecognized || runtimeError || hasDocumentError || running || progress?.state === 'done'
    const outline = canvasPaintTokens.node.outline
    const outlineWidth = unrecognized ? outline.idle * outline.unrecognizedFactor : strongOutline ? outline.strong : t.crispEdges ? outline.crisp : outline.idle
    const outlineDash = unrecognized || runtimeError
      ? nodeStateDash('error', scale)
      : running
        ? undefined
        : nodeStateDash(progress?.state, scale)
    const outlineOwnsDash = unrecognized || runtimeError || hasDocumentError || running || progress !== undefined
    const dash = outlineOwnsDash ? outlineDash : modeDash(mode, scale)
    if (running) this.drawRunningGlow(ctx, node.x, node.y, l.width, l.height)
    if (dash !== undefined) ctx.setLineDash(dash)
    const outlineStroke = screenAwareStroke(outlineWidth, scale, strongOutline || unrecognized ? outline.strongScreen : outline.screen)
    // Crisp edges draw the outline inside the node's box, so a 1 px outline
    // covers whole pixels instead of straddling the box's edge.
    const outlineInset = t.crispEdges ? outlineStroke / 2 : 0
    ctx.beginPath()
    ctx.roundRect(node.x + outlineInset, node.y + outlineInset, l.width - outlineInset * 2, l.height - outlineInset * 2, Math.max(0, t.cornerRadius - outlineInset))
    ctx.strokeStyle = outlineColor
    ctx.lineWidth = outlineStroke
    ctx.stroke()
    if (dash !== undefined) ctx.setLineDash([])
    if (running && !this.reducedMotion) this.drawRunningAccent(ctx, node.x, node.y, l.width, l.height)
    if (node.regionKind !== undefined) {
      const paint = canvasPaintTokens.region
      ctx.beginPath()
      ctx.roundRect(node.x + paint.inset, node.y + paint.inset, l.width - paint.inset * 2, l.height - paint.inset * 2, Math.max(0, t.cornerRadius - paint.inset))
      ctx.strokeStyle = outlineColor
      ctx.lineWidth = screenAwareStroke(paint.stroke, scale, paint.stroke)
      ctx.stroke()
    }

    // Selection is the topmost outline so the error state cannot hide it.
    // White stays distinct from the blue live-affordance accent.
    if (selected) {
      this.drawSelectionOutline(
        ctx,
        node.x,
        node.y,
        l.width,
        l.height,
        NODE_SELECTION_OUTLINE_OUTSET,
        t.cornerRadius,
        selectionStrokeWidth,
      )
    }

    this.drawMinimizeArrow(ctx, node)
    if (!contentDetail) {
      ctx.font = `${l.titleRenamed ? 'italic ' : ''}${canvasPaintTokens.type.semiboldWeight} ${t.titleFontSize}px ${t.fontFamily}`
      if (measureWidth(ctx, title) <= l.width - TITLE_START - t.padX) {
        ctx.fillStyle = t.colors.title
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'left'
        ctx.fillText(title, node.x + TITLE_START, node.y + l.headerHeight / 2)
        this.drawTitleSuffix(ctx, suffix, node.x + TITLE_START + measureWidth(ctx, title), node.x + l.width - t.padX, node.y + l.headerHeight / 2, false)
      }
    }

    // Detailed text and chips are omitted in the overview tier; structural
    // state, fitting titles, and typed connectivity remain visible.
    if (contentDetail) {
      // Title fitting respects the space left by header marks.
      ctx.fillStyle = t.colors.title
      ctx.font = `${l.titleRenamed ? 'italic ' : ''}${canvasPaintTokens.type.semiboldWeight} ${t.titleFontSize}px ${t.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const badgeLayout = this.getNodeBadgeLayout(node)
      const markLefts = badgeLayout.filter((entry) => entry.badge.placement === 'title').map((entry) => entry.x)
      const badgeLeft = markLefts.length > 0 ? Math.min(...markLefts) : node.x + l.width - t.padX
      let titleX = node.x + TITLE_START
      if (node.regionKind !== undefined) {
        const paint = canvasPaintTokens.region
        const glyphX = titleX + paint.glyphInset
        const glyphY = node.y + l.headerHeight / 2
        ctx.beginPath()
        ctx.arc(glyphX, glyphY, paint.glyphRadius, Math.PI * paint.glyphStartAngle, Math.PI * paint.glyphEndAngle)
        ctx.strokeStyle = t.colors.title
        ctx.lineWidth = paint.glyphStroke
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(glyphX + paint.arrow.startX, glyphY + paint.arrow.startY)
        ctx.lineTo(glyphX + paint.arrow.tipX, glyphY + paint.arrow.tipY)
        ctx.lineTo(glyphX + paint.arrow.endX, glyphY + paint.arrow.endY)
        ctx.fillStyle = t.colors.title
        ctx.fill()
        ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${Math.max(paint.fontMinSize, t.titleFontSize - paint.fontReduction)}px ${t.fontFamily}`
        ctx.fillText(node.regionKind, titleX + paint.labelInset, glyphY)
        titleX += paint.labelInset + ctx.measureText(node.regionKind).width + paint.titleGap
        ctx.font = `${l.titleRenamed ? 'italic ' : ''}${canvasPaintTokens.type.semiboldWeight} ${t.titleFontSize}px ${t.fontFamily}`
      }
      const titleRoom = Math.max(0, badgeLeft - titleX - canvasPaintTokens.node.titleBadgeGap)
      const titleWidth = measureWidth(ctx, title)
      if (t.titleOverflow === 'ellipsis') {
        ctx.fillText(fitText(ctx, title, titleRoom), titleX, node.y + l.headerHeight / 2)
      } else {
        ctx.fillText(title, titleX, node.y + l.headerHeight / 2, titleRoom)
      }
      if (titleWidth <= titleRoom) {
        this.drawTitleSuffix(ctx, suffix, titleX + titleWidth, titleX + titleRoom, node.y + l.headerHeight / 2, true)
      }

      this.drawBadgeTabs(ctx, node, badgeLayout)
    }

    // Progress bar just under the header while running. Injected values are
    // external data: a non-finite or negative value must not mint a NaN or
    // reverse-width fill.
    if (progress?.state === 'running' && progress.value !== undefined && Number.isFinite(progress.value)) {
      const paint = canvasPaintTokens.node.progress
      const progressHeight = detailLevel === 'overview'
        ? Math.min(l.headerHeight, screenAwareStroke(paint.height, scale, paint.minScreenHeight))
        : paint.height
      ctx.fillStyle = t.progressBar
      ctx.fillRect(
        node.x,
        node.y + l.headerHeight - progressHeight,
        l.width * Math.min(1, Math.max(0, progress.value)),
        progressHeight,
      )
    }

    // Compact rows are content-tier detail; their pins paint independently.
    if (contentDetail) {
      ctx.font = `${t.fontSize}px ${t.fontFamily}`
      const boxPaint = canvasPaintTokens.node.box
      const closedHeight = t.rowHeight - t.rowGeometry.fieldInsetY * 2
      const boxHovered = (id: string): boolean =>
        this.overlay.hoveredBox?.nodeId === sceneNode.id && this.overlay.hoveredBox.boxId === id
      // A button stands raised: a lighter face than the node with a lit top
      // edge and a dark line under it. Pointed at, the face lightens; pressed,
      // it sinks to a field's dark; disabled, the whole button fades.
      const paintButton = (x: number, rowY: number, width: number, height: number, label: string, key: string, enabled: boolean): void => {
        const paint = canvasPaintTokens.widget.button
        const chrome = widgetChromeRect(x, rowY, width, height, t.rowGeometry.fieldInsetY)
        const at = (state: OverlayState['hoveredButton']): boolean => enabled && state?.nodeId === sceneNode.id && state.key === key
        const pressed = at(this.overlay.pressedButton)
        const hovered = !pressed && at(this.overlay.hoveredButton)
        const rowAlpha = ctx.globalAlpha
        if (!enabled) ctx.globalAlpha = rowAlpha * paint.disabledOpacity
        const radius = chrome.radius
        if (!pressed) {
          ctx.fillStyle = t.colors.buttonShade
          ctx.beginPath()
          ctx.roundRect(chrome.x, chrome.y + paint.stroke, chrome.width, chrome.height, radius)
          ctx.fill()
        }
        ctx.fillStyle = pressed ? t.colors.buttonPressed : hovered ? t.colors.buttonHover : t.colors.buttonFace
        ctx.beginPath()
        ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, radius)
        ctx.fill()
        const half = paint.stroke / 2
        const left = chrome.x + half
        const top = chrome.y + half
        const right = chrome.x + chrome.width - half
        const inner = Math.max(0, radius - half)
        ctx.strokeStyle = t.colors.boxOutline
        ctx.lineWidth = paint.stroke
        ctx.beginPath()
        ctx.roundRect(left, top, right - left, chrome.height - paint.stroke, inner)
        ctx.stroke()
        if (!pressed) {
          // The top line and the upper half of both corners.
          ctx.strokeStyle = t.colors.buttonLitEdge
          ctx.beginPath()
          ctx.moveTo(left, top + inner)
          ctx.arcTo(left, top, left + inner, top, inner)
          ctx.lineTo(right - inner, top)
          ctx.arcTo(right, top, right, top + inner, inner)
          ctx.stroke()
        }
        ctx.fillStyle = pressed ? t.colors.label : t.colors.value
        ctx.textAlign = 'center'
        ctx.fillText(label, chrome.x + chrome.width / 2, rowY + height / 2, chrome.width - paint.textPadding)
        ctx.textAlign = 'left'
        ctx.globalAlpha = rowAlpha
      }
      // Outlines first, outer boxes before the boxes inside them.
      for (const box of l.boxes ?? []) {
        const half = boxPaint.stroke / 2
        const x = node.x + box.x + half
        const y = node.y + box.y + half
        const width = box.width - boxPaint.stroke
        const height = box.height - boxPaint.stroke
        const radius = boxPaint.radius
        if (box.closed && boxHovered(box.id)) {
          ctx.fillStyle = t.colors.boxHover
          ctx.beginPath()
          ctx.roundRect(x, y, width, height, radius)
          ctx.fill()
        }
        ctx.strokeStyle = box.depth === 1 ? t.colors.boxOutline : t.colors.boxInnerOutline
        ctx.lineWidth = boxPaint.stroke
        ctx.beginPath()
        if (box.kind === 'option') {
          // Joined to the underside of the dropdown: no top line, square top corners.
          ctx.moveTo(x, y)
          ctx.lineTo(x, y + height - radius)
          ctx.arcTo(x, y + height, x + radius, y + height, radius)
          ctx.lineTo(x + width - radius, y + height)
          ctx.arcTo(x + width, y + height, x + width, y + height - radius, radius)
          ctx.lineTo(x + width, y)
        } else {
          ctx.roundRect(x, y, width, height, radius)
        }
        ctx.stroke()
      }
      const paintArrow = (cx: number, cy: number, open: boolean, color: string): void => {
        const arrow = boxPaint.arrow
        ctx.fillStyle = color
        ctx.beginPath()
        if (open) {
          ctx.moveTo(cx - arrow.halfWidth, cy - arrow.length / 2)
          ctx.lineTo(cx + arrow.halfWidth, cy - arrow.length / 2)
          ctx.lineTo(cx, cy + arrow.length / 2)
        } else {
          ctx.moveTo(cx - arrow.length / 2, cy - arrow.halfWidth)
          ctx.lineTo(cx + arrow.length / 2, cy)
          ctx.lineTo(cx - arrow.length / 2, cy + arrow.halfWidth)
        }
        ctx.closePath()
        ctx.fill()
      }
      /** A remove cross centered on `cy`, its right edge at `right`. */
      const paintCross = (right: number, cy: number): void => {
        const cross = boxPaint.cross
        const cx = right - cross.size / 2
        ctx.strokeStyle = t.colors.boxCount
        ctx.lineWidth = cross.stroke
        ctx.beginPath()
        ctx.moveTo(cx - cross.size / 2, cy - cross.size / 2)
        ctx.lineTo(cx + cross.size / 2, cy + cross.size / 2)
        ctx.moveTo(cx + cross.size / 2, cy - cross.size / 2)
        ctx.lineTo(cx - cross.size / 2, cy + cross.size / 2)
        ctx.stroke()
      }
      /** Six dots in two columns: a member's grip, centered on (`cx`, `cy`). */
      const paintGrip = (grip: MemberGrip, cx: number, cy: number): void => {
        const paint = boxPaint.grip
        const gripAlpha = ctx.globalAlpha
        const hovered = this.overlay.hoveredGrip?.nodeId === sceneNode.id &&
          this.overlay.hoveredGrip.construct === grip.construct && this.overlay.hoveredGrip.member === grip.member
        if (grip.alone === true) ctx.globalAlpha = gripAlpha * canvasPaintTokens.widget.inactiveOpacity
        ctx.fillStyle = hovered ? t.colors.title : t.colors.label
        const dx = boxPaint.gripWidth / 2 - paint.dot
        const dy = paint.height / 2 - paint.dot
        ctx.beginPath()
        for (const x of [cx - dx, cx + dx]) {
          for (const y of [cy - dy, cy, cy + dy]) {
            ctx.moveTo(x + paint.dot, y)
            ctx.arc(x, y, paint.dot, 0, Math.PI * 2)
          }
        }
        ctx.fill()
        ctx.globalAlpha = gripAlpha
      }
      // A member being dragged stays where it is, dimmed like an inactive row.
      const drag = this.overlay.memberDrag?.nodeId === sceneNode.id ? this.overlay.memberDrag : undefined
      const dragged = drag === undefined
        ? undefined
        : memberSpans(l, drag.construct).find((span) => span.member === drag.member)
      const rowsAlpha = ctx.globalAlpha
      for (const row of l.rows) {
        const rowY = node.y + row.y
        // A member box's header starts where its outline does.
        const rowTop = row.kind === 'member' ? row.top : row.y
        ctx.globalAlpha = dragged !== undefined && rowTop >= dragged.top && rowTop < dragged.bottom
          ? rowsAlpha * canvasPaintTokens.widget.inactiveOpacity
          : rowsAlpha
        if ((row.kind === 'widget' || row.kind === 'ports') && row.crossInset !== undefined) {
          paintCross(node.x + l.width - row.crossInset, rowY + t.rowHeight / 2)
        }
        if ((row.kind === 'widget' || row.kind === 'ports') && row.reorder !== undefined) {
          paintGrip(row.reorder, node.x + row.reorder.gripX, rowY + t.rowHeight / 2)
        }
        if (row.kind === 'section') {
          // A box's header, closed row or tab: the whole row opens or closes it.
          const hovered = boxHovered(row.sectionId)
          const left = node.x + row.inset
          const right = node.x + l.width - row.inset
          const top = node.y + row.top
          if (row.tab) {
            const tab = boxPaint.tab
            const tabX = left + tab.inset
            const tabY = top - tab.height / 2
            ctx.fillStyle = t.colors.nodeBody
            ctx.strokeStyle = hovered ? t.colors.label : t.colors.boxOutline
            ctx.lineWidth = boxPaint.stroke
            ctx.beginPath()
            ctx.roundRect(tabX, tabY, tab.width, tab.height, tab.radius)
            ctx.fill()
            ctx.stroke()
            paintArrow(tabX + tab.width / 2, tabY + tab.height / 2, true, t.colors.label)
            continue
          }
          if (hovered && !row.collapsed) {
            const inner = boxPaint.radius - boxPaint.stroke
            ctx.fillStyle = t.colors.boxHover
            ctx.beginPath()
            ctx.roundRect(left + boxPaint.stroke, top + boxPaint.stroke, right - left - boxPaint.stroke * 2, closedHeight - boxPaint.headerShrink, [inner, inner, 0, 0])
            ctx.fill()
          }
          const cy = top + closedHeight / 2
          const textColor = hovered ? t.colors.title : t.colors.label
          const arrowX = left + boxPaint.textInset + boxPaint.arrow.halfWidth
          paintArrow(arrowX, cy, !row.collapsed, textColor)
          // The count, and on a closed box the dot for a changed value.
          let textRight = right - boxPaint.textInset
          // A wire held over a closed row names the field it would reach in
          // place of the count.
          const target = hovered && row.collapsed ? this.overlay.hoveredBox?.target : undefined
          if (target !== undefined) {
            ctx.fillStyle = textColor
            ctx.textAlign = 'right'
            const text = fitText(ctx, target, (right - left) / 2)
            ctx.fillText(text, textRight, cy)
            textRight -= ctx.measureText(text).width + boxPaint.dotGap
          } else if (row.collapsed || row.box === 'group') {
            ctx.font = `${boxPaint.countFontSize}px ${t.fontFamily}`
            ctx.fillStyle = t.colors.boxCount
            ctx.textAlign = 'right'
            // A group that declares a maximum says how near it is: "3 of 16".
            const count = row.maxCount === undefined ? String(row.count) : translate('canvas.box.countOfMax', { count: row.count, max: row.maxCount })
            ctx.fillText(count, textRight, cy)
            textRight -= ctx.measureText(count).width + boxPaint.dotGap
            ctx.font = `${t.fontSize}px ${t.fontFamily}`
          }
          if (row.collapsed && row.hiddenModified !== undefined) {
            ctx.fillStyle = t.colors.boxChanged
            ctx.beginPath()
            ctx.arc(textRight - boxPaint.dotRadius, cy, boxPaint.dotRadius, 0, Math.PI * 2)
            ctx.fill()
            textRight -= boxPaint.dotRadius * 2 + boxPaint.dotGap
          }
          const textX = arrowX + boxPaint.arrow.halfWidth + boxPaint.labelGap
          ctx.fillStyle = textColor
          ctx.textAlign = 'left'
          ctx.fillText(fitText(ctx, row.label, Math.max(0, textRight - textX)), textX, cy)
        } else if (row.kind === 'member') {
          // A member's own box: its label and the remove cross.
          const rowAlpha = ctx.globalAlpha
          if (row.ghost) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
          const left = node.x + row.inset
          const right = node.x + l.width - row.inset
          const cy = node.y + row.top + closedHeight / 2
          // The grip stands as far from the outline as from the label, and
          // the cross as far from the outline as a one-row member's does.
          const textX = left + boxPaint.stroke + boxPaint.labelGap + boxPaint.gripWidth + boxPaint.labelGap
          if (row.reorder !== undefined) paintGrip(row.reorder, node.x + row.reorder.gripX, cy)
          if (t.memberRemoveCross) paintCross(right - boxPaint.stroke - boxPaint.cross.fieldGap, cy)
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'left'
          ctx.fillText(fitText(ctx, row.label, Math.max(0, right - boxPaint.cross.reserve - textX)), textX, cy)
          ctx.globalAlpha = rowAlpha
        } else if (row.kind === 'growth') {
          // A group that grows by hand ends in an Add button, as wide as a member's box.
          paintButton(node.x + row.inset, rowY, l.width - row.inset * 2, row.height, `+ ${row.label}`, `growth:${row.construct}`, true)
        } else if (row.kind === 'editorSpace') {
          this.paintEditorSpace(ctx, node.x, rowY, row, l.width)
        } else if (row.kind === 'note') {
          // A formula note's text is unknown until formulas are evaluated, so
          // it draws dimmed like any other offer that is not settled yet.
          const rowAlpha = ctx.globalAlpha
          if (row.unknown) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
          const width = row.width ?? l.width - row.inset * 2
          const textX = node.x + row.inset + canvasPaintTokens.widget.labelInset
          const room = width - canvasPaintTokens.widget.labelInset * 2
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'left'
          const unit = row.lookup === undefined ? row.height : row.height / noteLookupRows(row.lookup)
          ctx.fillText(row.text, textX, rowY + unit / 2, room)
          ctx.globalAlpha = rowAlpha
          if (row.lookup !== undefined) this.paintNoteLookup(ctx, row.lookup, textX, rowY + unit, unit, room,
            this.overlay.hoveredButton?.nodeId === node.id && this.overlay.hoveredButton.key === `lookup:${row.noteId}`)
        } else if (row.kind === 'button') {
          paintButton(node.x + row.inset, rowY, row.width ?? l.width - row.inset * 2, row.height, row.label, `button:${row.buttonId}`, row.enabled !== false)
        } else if (row.kind === 'fallback') {
          // Stored value on a schemaless node: read-only and dimmed, but
          // recognizable - the document's key and value survive the missing
          // schema even though no editor can be trusted to write them.
          const rowAlpha = ctx.globalAlpha
          ctx.fillStyle = t.colors.widgetBackground
          const paint = canvasPaintTokens.widget
          ctx.fillRect(node.x + t.padX, rowY + t.rowGeometry.fieldInsetY, l.width - t.padX * 2, row.height - t.rowGeometry.fieldInsetY * 2)
          ctx.globalAlpha = rowAlpha * paint.fallback.opacity
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'left'
          ctx.fillText(row.label, node.x + t.padX + paint.fallback.textInset, rowY + row.height / 2, (l.width - t.padX * 2) * paint.fallback.labelRatio)
          ctx.fillStyle = t.colors.value
          ctx.textAlign = 'right'
          ctx.fillText(row.text, node.x + l.width - t.padX - paint.fallback.textInset, rowY + row.height / 2, (l.width - t.padX * 2) * paint.fallback.valueRatio)
          ctx.textAlign = 'left'
          ctx.globalAlpha = rowAlpha
          // A problem on this stored value outlines its row.
          this.paintRowProblem(ctx, sceneNode.id, row.label, {
            x: node.x + t.padX, y: rowY + t.rowGeometry.fieldInsetY,
            width: l.width - t.padX * 2, height: row.height - t.rowGeometry.fieldInsetY * 2, radius: 0,
          })
        } else if (row.kind === 'ports') {
          // Ghost (dynamic affordance) labels render dimmed: connect/edit
          // materializes them; until then they are an offer, not a member.
          const rowAlpha = ctx.globalAlpha
          // An input drawn without a field, or an output, outlines its row;
          // when an input and an output share the line each outlines its half.
          const innerWidth = l.width - t.padX * 2
          const halves = row.input !== undefined && row.output !== undefined
          const outlineSide = (key: string, right: boolean): void => {
            const width = halves ? innerWidth / 2 : innerWidth
            this.paintRowProblem(ctx, sceneNode.id, key, widgetChromeRect(node.x + t.padX + (right && halves ? width : 0), rowY, width,
              row.height, t.rowGeometry.fieldInsetY))
          }
          if (row.input !== undefined) outlineSide(row.input.portId, false)
          if (row.output !== undefined) outlineSide(outputRowKey(row.output.portId), true)
          if (row.input) {
            if (row.input.ghost) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
            if (row.input.inactive) ctx.globalAlpha = rowAlpha * canvasPaintTokens.widget.inactiveOpacity
            ctx.fillStyle = t.colors.label
            paintPinLabel(ctx, t, row.input.label, node.x + t.rowGeometry.portLabelInset + (row.nameInset ?? 0), rowY + row.height / 2, 'left')
            ctx.globalAlpha = rowAlpha
          }
          if (row.output) {
            if (row.output.ghost) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
            ctx.fillStyle = t.colors.label
            paintPinLabel(ctx, t, row.output.label, node.x + l.width - t.rowGeometry.portLabelInset - (row.nameInset ?? 0), rowY + row.height / 2, 'right')
            ctx.globalAlpha = rowAlpha
          }
        } else {
          this.drawFieldRow(ctx, sceneNode, node, row)
        }
      }
      ctx.globalAlpha = rowsAlpha
      if (drag?.line !== undefined) {
        // Where releasing the dragged member puts it.
        ctx.fillStyle = t.colors.selection
        ctx.fillRect(node.x + drag.line.x, node.y + drag.line.y - boxPaint.dropLine / 2, drag.line.width, boxPaint.dropLine)
      }
    }

    const preview = this.previews[node.id]
    const outputText = this.outputTexts[node.id]
    const captionHovered = this.overlay.hoveredPreviewCaption === sceneNode.id
    const smallFont = `${Math.max(canvasPaintTokens.type.smallMinSize, t.fontSize - canvasPaintTokens.type.smallReduction)}px ${t.fontFamily}`
    const regionRadius = Math.max(canvasPaintTokens.preview.minRadius, t.cornerRadius - canvasPaintTokens.preview.radiusInset)
    if (preview !== undefined && l.preview !== undefined) {
      const rect = {
        x: node.x + l.preview.x,
        y: node.y + l.preview.y,
        width: l.preview.width,
        height: l.preview.height,
      }
      const panel = l.preview.compact === true ? undefined : splitPreviewRect(rect, t.previewCaptionHeight)
      const folded = l.preview.folded === true
      const statusLabel = preview.statusMessage ?? (preview.status === 'failed'
        ? 'failed'
        : preview.status === 'unavailable' ? 'unavailable' : 'loading...')
      if (panel !== undefined) {
        const mediaRect = panel.media
        ctx.fillStyle = t.colors.widgetBackground
        ctx.strokeStyle = t.colors.nodeBorder
        ctx.lineWidth = canvasPaintTokens.preview.stroke
        ctx.beginPath()
        ctx.roundRect(mediaRect.x, mediaRect.y, mediaRect.width, mediaRect.height, regionRadius)
        ctx.fill()
        ctx.stroke()
        const farMedia = l.minimized !== true &&
          (preview.kind === 'video' || preview.kind === 'audio') && detailLevel === 'overview'
        if (farMedia) {
          ctx.fillStyle = t.colors.nodeBody
          const label = `${preview.kind ?? 'media'}${(preview.count ?? 0) > 1 ? ` ${(preview.index ?? 0) + 1}/${preview.count}` : ''}`
          ctx.font = smallFont
          const width = Math.max(canvasPaintTokens.preview.mediaBadgeMinWidth, ctx.measureText(label).width + canvasPaintTokens.preview.mediaBadgePadding)
          const height = canvasPaintTokens.preview.mediaBadgeHeight
          ctx.fillRect(mediaRect.x + (mediaRect.width - width) / 2, mediaRect.y + (mediaRect.height - height) / 2, width, height)
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, mediaRect.x + mediaRect.width / 2, mediaRect.y + mediaRect.height / 2)
        } else if (preview.image !== undefined) {
          // Live animation cycles on the running-node frame loop; reduced
          // motion (which also stops that loop) keeps the newest still. A
          // model3d preview keeps its src for the orbit overlay but paints
          // its poster in-canvas like an image.
          const animated = preview.animation !== undefined && !this.reducedMotion
            ? animationFrameAt(preview.animation, this.animationTimeMs)
            : undefined
          this.paintPreviewPicture(ctx, animated ?? preview.image, containRect(mediaRect, preview))
        } else if (preview.status !== undefined && contentDetail) {
          // A page of a list output that is loading or failed.
          ctx.fillStyle = t.colors.label
          ctx.font = `${t.fontSize}px ${t.fontFamily}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          const alpha = ctx.globalAlpha
          ctx.globalAlpha = alpha * canvasPaintTokens.preview.placeholderOpacity
          ctx.fillText(fitText(ctx, statusLabel, Math.max(0, mediaRect.width - canvasPaintTokens.preview.labelPadding)),
            mediaRect.x + mediaRect.width / 2, mediaRect.y + mediaRect.height / 2)
          ctx.globalAlpha = alpha
        }
        // A ready video or audio player is DOM the host mounts over the media area.
      }
      if (contentDetail) {
        // The approx prefix keeps a mirror-computed estimate distinguishable
        // from real imagery even without color.
        const stateLabel = preview.state === 'cached'
          ? 'last resolved'
          : preview.state === 'estimate' ? '\u2248 estimated' : undefined
        const countLabel = (preview.count ?? 0) > 1
          ? `${(preview.index ?? 0) + 1}/${preview.count}`
          : undefined
        const dimensionsLabel = preview.status === undefined && Number.isFinite(preview.width) && (preview.width ?? 0) > 0 &&
          Number.isFinite(preview.height) && (preview.height ?? 0) > 0
          ? `${Math.round(preview.width!)} x ${Math.round(preview.height!)}`
          : undefined
        const colorLabel = preview.colorTransform === undefined ? undefined : `Preview color: ${preview.colorTransform}`
        this.paintPreviewCaption(ctx, panel?.caption ?? rect, {
          arrow: panel !== undefined ? 'open' : folded ? 'folded' : undefined,
          label: 'Preview',
          detail: panel !== undefined || folded
            ? [stateLabel, countLabel, dimensionsLabel, colorLabel].filter((label) => label !== undefined).join(' | ')
            : statusLabel,
          detailColor: preview.state === 'estimate' && (panel !== undefined || folded) ? t.colors.companionEstimate : t.colors.valueMark,
          detailFont: smallFont,
          ...(folded && preview.image !== undefined ? { thumbnail: preview.image, thumbnailSize: preview } : {}),
          hovered: captionHovered && (panel !== undefined || folded),
        })
      }
    } else if (outputText !== undefined && l.textOutput !== undefined) {
      const rect = {
        x: node.x + l.textOutput.x,
        y: node.y + l.textOutput.y,
        width: l.textOutput.width,
        height: l.textOutput.height,
      }
      const { caption, media: body } = splitPreviewRect(rect, t.previewCaptionHeight)
      const padding = canvasPaintTokens.preview.outputPadding
      const maxWidth = Math.max(0, body.width - padding * 2)
      ctx.save()
      ctx.font = `italic ${t.fontSize}px ${t.fontFamily}`
      const lines = outputText.text.replace(/\r\n?/g, '\n').split('\n').flatMap((line) => wrapText(ctx, line, maxWidth))
      ctx.restore()
      const color = outputText.stale === true
        ? t.colors.companionUnproven
        : outputText.error === true
          ? t.colors.error
          : outputText.estimate === true
            ? t.colors.companionEstimate
            : t.colors.companionValue
      const folded = l.textOutput.folded === true
      if (!folded) {
        ctx.save()
        ctx.fillStyle = t.colors.widgetBackground
        ctx.strokeStyle = t.colors.nodeBorder
        ctx.lineWidth = canvasPaintTokens.preview.stroke
        ctx.beginPath()
        ctx.roundRect(body.x, body.y, body.width, body.height, regionRadius)
        ctx.fill()
        ctx.stroke()
        ctx.clip()
        if (contentDetail) {
          // Lines keep one rhythm, so a taller region only shows more of them.
          const lineHeight = t.rowHeight - padding
          const visibleLines = Math.max(1, Math.floor((body.height - padding * 2) / lineHeight))
          ctx.font = `italic ${t.fontSize}px ${t.fontFamily}`
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          const overflow = lines.length > visibleLines
          const shown = overflow && visibleLines > 1
            ? lines.slice(0, visibleLines - 1)
            : lines.slice(0, visibleLines)
          ctx.fillStyle = color
          let textY = body.y + padding + lineHeight / 2
          for (const line of shown) {
            ctx.fillText(line, body.x + padding, textY)
            if (outputText.stale === true && line.length > 0) {
              ctx.save()
              ctx.strokeStyle = color
              ctx.lineWidth = canvasPaintTokens.preview.staleStroke
              ctx.setLineDash([...canvasPaintTokens.dash.companionUnderline])
              ctx.beginPath()
              ctx.moveTo(body.x + padding, textY + t.fontSize / 2 + canvasPaintTokens.preview.staleUnderlineOffset)
              ctx.lineTo(body.x + padding + measureWidth(ctx, line), textY + t.fontSize / 2 + canvasPaintTokens.preview.staleUnderlineOffset)
              ctx.stroke()
              ctx.restore()
            }
            textY += lineHeight
          }
          if (overflow && visibleLines > 1) {
            ctx.font = smallFont
            ctx.fillStyle = t.colors.label
            ctx.textAlign = 'right'
            ctx.fillText(`+${lines.length - shown.length} more`, body.x + body.width - padding, textY)
          }
        }
        ctx.restore()
      }
      if (contentDetail) {
        // Folded, the caption shows the start of the first line in place of a picture.
        this.paintPreviewCaption(ctx, caption, {
          arrow: folded ? 'folded' : 'open',
          label: 'Preview',
          detail: folded ? lines.find((line) => line.trim().length > 0) ?? '' : textResultLineCount(outputText.text),
          detailColor: t.colors.valueMark,
          detailFont: folded ? `${t.fontSize}px ${t.fontFamily}` : smallFont,
          hovered: captionHovered,
        })
      }
    } else if (l.preview?.compact === true && contentDetail) {
      // A node that can show a preview always says so, before its first picture too.
      this.paintPreviewCaption(ctx, {
        x: node.x + l.preview.x,
        y: node.y + l.preview.y,
        width: l.preview.width,
        height: l.preview.height,
      }, { label: 'Preview', detail: 'no picture yet', detailColor: t.colors.valueMark, detailFont: smallFont, hovered: false })
    }
    if (previewEdgeShown(node) && contentDetail) {
      // The text box's bar, on the node's bottom edge: it sizes the open
      // preview through the node's height.
      const edge = canvasPaintTokens.widget.textBoxEdge
      const hot = this.overlay.previewEdge === sceneNode.id
      const barWidth = hot ? edge.hotWidth : edge.width
      ctx.fillStyle = hot ? t.colors.widgetAffordanceActive : t.colors.widgetAffordance
      ctx.beginPath()
      ctx.roundRect(node.x + (l.width - barWidth) / 2, node.y + l.height - canvasPaintTokens.node.previewEdge.barRise,
        barWidth, edge.height, edge.radius)
      ctx.fill()
    }
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    const previewAffordance = l.minimized
      ? undefined
      : this.lensCapabilities.previewSurfaceAffordance?.(sceneNode)
    const previewAffordanceRect = previewAffordance === undefined ? undefined : previewSurfaceAffordanceRect(node)
    if (previewAffordance !== undefined && previewAffordanceRect !== undefined) {
      const rect = {
        ...previewAffordanceRect,
        x: node.x + previewAffordanceRect.x,
        y: node.y + previewAffordanceRect.y,
      }
      const alpha = ctx.globalAlpha
      const paint = canvasPaintTokens.lensAffordance
      if (previewAffordance.disabled === true) ctx.globalAlpha *= paint.disabledOpacity
      ctx.fillStyle = previewAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetBackground
      ctx.strokeStyle = previewAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetAffordance
      ctx.lineWidth = paint.stroke
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, paint.radius)
      ctx.fill()
      ctx.stroke()
      ctx.strokeStyle = previewAffordance.active ? t.colors.canvasBackground : t.colors.widgetAffordance
      ctx.lineCap = 'round'
      ctx.beginPath()
      if (previewAffordance.active) {
        ctx.moveTo(rect.x + rect.width * paint.check.startX, rect.y + rect.height * paint.check.startY)
        ctx.lineTo(rect.x + rect.width * paint.check.middleX, rect.y + rect.height * paint.check.middleY)
        ctx.lineTo(rect.x + rect.width * paint.check.endX, rect.y + rect.height * paint.check.endY)
      } else {
        ctx.moveTo(rect.x + rect.width * paint.plus.start, rect.y + rect.height / 2)
        ctx.lineTo(rect.x + rect.width * paint.plus.end, rect.y + rect.height / 2)
        ctx.moveTo(rect.x + rect.width / 2, rect.y + rect.height * paint.plus.start)
        ctx.lineTo(rect.x + rect.width / 2, rect.y + rect.height * paint.plus.end)
      }
      ctx.stroke()
      ctx.globalAlpha = alpha
    }

    // Data-lens panel: re-skins the body CONTENT over the rows just drawn
    // (widgets stay painted underneath the scrim, layout untouched). Pins
    // draw after, so connectivity stays readable in every lens.
    const panelRows = contentDetail && !l.minimized
      ? this.lensCapabilities.nodeBodyContent?.(sceneNode)
      : undefined
    if (panelRows != null) this.drawDataPanel(ctx, node.x, node.y, l, panelRows)

    // Pins (over rows).
    const nodeSelected = this.overlay.selection?.has(node.id) ?? false
    // Hovering the node also reveals its widget-backed pins: the wiring
    // affordance must be discoverable by pointing at the node, not only by
    // selecting it first.
    const nodeHovered = this.overlay.hoveredNode === node.id
    const matchVariableAt = (target: OverlayState['hoveredPin'] | OverlayState['focusedPin']): string | undefined => {
      if (target === undefined) return undefined
      return l.pins.find((pin) =>
        pin.portId === target.portId &&
        pin.direction === target.direction &&
        ('widgetTap' in target ? (pin.widgetTap === true) === (target.widgetTap === true) : true),
      )?.matchVariable
    }
    const hoveredMatchVariable = this.overlay.hoveredPin?.nodeId === node.id
      ? matchVariableAt(this.overlay.hoveredPin)
      : undefined
    const focusedMatchVariable = this.overlay.focusedPin?.nodeId === node.id
      ? matchVariableAt(this.overlay.focusedPin)
      : undefined
    if (l.minimized) {
      const connectedPins = (direction: 'in' | 'out') => l.pins.filter((pin) => {
        if (pin.direction !== direction) return false
        const key = pin.widgetTap === true ? pin.address.port as string : pin.portId
        return direction === 'in'
          ? this.connectedInputPins.has(`${node.id}\u0000${key}`)
          : this.connectedOutputPins.has(`${node.id}\u0000${key}`)
      })
      const paintAggregate = (direction: 'in' | 'out'): void => {
        const pins = connectedPins(direction)
        if (pins.length === 0) return
        const first = JSON.stringify(pins[0]!.type)
        const type = pins.every((pin) => JSON.stringify(pin.type) === first)
          ? pins[0]!.type
          : { kind: 'wildcard' } as const
        const point = edgePinPoint(t, direction, direction === 'in' ? node.x : node.x + l.width, node.y + l.headerHeight / 2)
        paintTypedPin(
          ctx,
          t,
          type,
          point.x,
          point.y,
          this.viewport.scale,
          false,
          direction,
          pinRadius,
        )
      }
      paintAggregate('in')
      paintAggregate('out')
      ctx.globalAlpha = 1
      return
    }
    for (const pin of l.pins) {
      if (pin.stacked === true) continue
      const { x: px, y: py } = edgePinPoint(t, pin.direction, pin.direction === 'in' ? node.x : node.x + l.width, node.y + pin.y)
      const targetKey = dropTargetKey(node.id, pin.portId, pin.direction, pin.widgetTap === true)
      const isLegalTarget = this.overlay.dropTargets?.has(targetKey) ?? false
      const isTarget = this.overlay.dropTargets?.has(targetKey) ?? false
      const connected = this.connectedInputPins.has(`${node.id}\u0000${pin.portId}`)
      const hovered =
        this.overlay.hoveredPin?.nodeId === node.id &&
        this.overlay.hoveredPin.portId === pin.portId &&
        this.overlay.hoveredPin.direction === pin.direction &&
        (pin.widgetTap === true) === (this.overlay.hoveredPin.widgetTap === true)
      const focused =
        this.overlay.focusedPin?.nodeId === node.id &&
        this.overlay.focusedPin.portId === pin.portId &&
        this.overlay.focusedPin.direction === pin.direction &&
        (pin.widgetTap === true) === (this.overlay.focusedPin.widgetTap === true)
      const associated = pin.matchVariable !== undefined &&
        (pin.matchVariable === hoveredMatchVariable || pin.matchVariable === focusedMatchVariable)
      const radius = hovered || focused || associated ? pinRadius + PIN_HOVER_GROWTH : pinRadius
      // A field's output pin shares its input's annotations but sends one value.
      const acceptsList = pin.direction === 'in' && pin.acceptsList === true
      const shape = pinShapeOf(pin.type, pin.direction, acceptsList)
      const ringRadius = statusRingRadius(shape, pinRadius, radius)
      if (pin.widgetTap === true &&
          !this.connectedWidgetTaps.has(`${node.id}\u0000${pin.address.port}`) &&
          !isLegalTarget && !nodeHovered)
        continue
      // A field driven by an input drawn without its wire shows no pin, even
      // on a hovered or selected node, except as a drop target.
      if (pin.widgetBacked && pin.direction === 'in' && !isLegalTarget &&
        this.wirelessBoundaryInputPins.has(`${node.id}\u0000${pin.portId}`))
        continue
      if (pin.widgetBacked && pin.direction === 'in' && !connected && !isLegalTarget && !nodeSelected && !nodeHovered)
        continue
      // A field row that takes the held wire shows its own outline, so the
      // field's pin, the node's only target then, gets no ring.
      if (isTarget && this.overlay.dropRow?.nodeId !== node.id) {
        ctx.beginPath()
        ctx.arc(px, py, ringRadius, 0, Math.PI * 2)
        ctx.strokeStyle = t.colors.dropTarget
        ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
        ctx.stroke()
      }
      const pinColor = pinColorOf(t, pin.type)
      if (pin.ghost) {
        // Ghost pins are affordances: hollow, dimmed ring in the pin's shape.
        pinOutlinePath(ctx, shape, px, py, pinShapeRadius(shape, radius))
        const pinAlpha = ctx.globalAlpha
        ctx.globalAlpha = pinAlpha * GHOST_ALPHA
        ctx.strokeStyle = pinColor
        ctx.lineWidth = screenAwareStroke(canvasPaintTokens.pin.ghostStroke, scale, canvasPaintTokens.pin.ghostMinScreenStroke)
        ctx.stroke()
        ctx.globalAlpha = pinAlpha
      } else {
        // A kept row's pin is dimmed with its row and wire; an input pin a
        // muted node's wire enters fades with that wire.
        const pinAlpha = ctx.globalAlpha
        if (pin.kept !== undefined) ctx.globalAlpha = pinAlpha * canvasPaintTokens.widget.inactiveOpacity
        else if (pin.direction === 'in' && this.mutedInputPins.has(`${node.id}\u0000${pin.portId}`)) ctx.globalAlpha = pinAlpha * canvasPaintTokens.node.modeOpacity
        if (pin.collapsedSection !== undefined) {
          // Each pin of a closed box's cluster cuts the one above it.
          ctx.fillStyle = t.colors.nodeBody
          ctx.beginPath()
          ctx.arc(px, py, radius + canvasPaintTokens.node.box.clusterRing, 0, Math.PI * 2)
          ctx.fill()
        }
        paintTypedPin(
          ctx,
          t,
          pin.type,
          px,
          py,
          this.viewport.scale,
          pin.maybeAbsent === true ||
            (pin.direction === 'in' && (pin.optional === true || pin.familyMember === true ||
              // An unwired input on a closed box's row is hollow.
              (pin.collapsedSection !== undefined && !connected))),
          pin.direction,
          radius,
          acceptsList,
        )
        ctx.globalAlpha = pinAlpha
      }
    }

    if (contentDetail && node.virtual !== undefined) {
      const paint = canvasPaintTokens.virtualNote
      const bodyX = node.x + t.padX
      const bodyY = node.y + l.headerHeight + paint.verticalPadding
      const bodyWidth = Math.max(0, l.width - t.padX * 2)
      const bodyHeight = Math.max(0, l.height - l.headerHeight - paint.verticalPadding * 2)
      ctx.fillStyle = nodeColor === undefined
        ? t.colors.nodeBody
        : tintHex(t.colors.nodeBody, nodeColor, paint.bodyTint)
      ctx.fillRect(node.x + paint.bodyInset, node.y + l.headerHeight, l.width - paint.bodyInset * 2, l.height - l.headerHeight - paint.bodyInset)
      ctx.fillStyle = t.colors.value
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      const lineHeight = Math.max(paint.minLineHeight, t.fontSize + paint.lineGap)
      let y = bodyY
      for (const sourceLine of node.virtual.text.split('\n')) {
        const heading = node.virtual.format === 'markdown' ? /^(#{1,6})\s+(.+)$/.exec(sourceLine) : null
        const listItem = node.virtual.format === 'markdown' ? /^\s*[-*+]\s+(.+)$/.exec(sourceLine) : null
        const paragraph = (heading?.[2] ?? listItem?.[1] ?? sourceLine)
          .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/__([^_]+)__/g, '$1')
          .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/^\s*>\s?/, '')
        const fontSize = heading === null ? t.fontSize : Math.max(t.fontSize, t.fontSize + paint.headingSizeOffset - heading[1]!.length)
        const weight = heading !== null || node.virtual.format === 'markdown' && /\*\*|__/.test(sourceLine) ? paint.boldWeight : paint.regularWeight
        ctx.font = `${weight} ${fontSize}px ${t.fontFamily}`
        if (listItem !== null) ctx.fillText('\u2022', bodyX, y, bodyWidth)
        const textX = listItem === null ? bodyX : bodyX + paint.listIndent
        const textWidth = Math.max(0, bodyWidth - (textX - bodyX))
        const words = paragraph.split(/\s+/).filter(Boolean)
        let line = ''
        for (const word of words) {
          const candidate = line === '' ? word : `${line} ${word}`
          if (line !== '' && ctx.measureText(candidate).width > textWidth) {
            if (y + lineHeight > bodyY + bodyHeight) break
            ctx.fillText(line, textX, y, textWidth)
            y += lineHeight
            line = word
          } else line = candidate
        }
        if (y + lineHeight > bodyY + bodyHeight) break
        ctx.fillText(line, textX, y, textWidth)
        y += Math.max(lineHeight, fontSize + paint.lineGap)
      }
    }

    ctx.globalAlpha = 1
  }

  /**
   * One field row, painted the same on a node and on a subgraph's Inputs
   * panel. `node` is `sceneNode` with any drag offset applied; `driven` is
   * set for a panel field wired outside the subgraph, with the value the
   * wire carries when the document fixes it.
   */
  private drawFieldRow(
    ctx: CanvasRenderingContext2D,
    sceneNode: SceneNode,
    node: SceneNode,
    row: Extract<LayoutRow, { kind: 'widget' }>,
    driven?: { readonly value?: Json },
  ): void {
    const t = this.tokens
    const l = node.layout
    const rowY = node.y + row.y
    if (this.openRows[sceneNode.id] === row.valueKey) return
    const arriving = driven !== undefined ? driven.value : this.panelFieldValues.get(`${sceneNode.id}\u0000${row.inputId}`)
    const companion = driven !== undefined || arriving !== undefined
      ? arriving === undefined ? undefined : { value: arriving }
      : this.companions[sceneNode.id]?.[row.valueKey]
    const widgetWidth = row.width ?? l.width - row.inset * 2
    // Selector rows ignore boundary bindings for inertness: the bound row
    // remains the occurrence-local editor.
    const linkSet = row.selector !== undefined ? this.valueDrivenInputPins : this.connectedInputPins
    const connected = driven !== undefined || companion !== undefined || linkSet.has(`${sceneNode.id}\u0000${row.inputId}`)
    const rowAlpha = ctx.globalAlpha
    if (row.ghost) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
    if (row.inactive) ctx.globalAlpha *= canvasPaintTokens.widget.inactiveOpacity
    const companionAlpha = ctx.globalAlpha
    if (connected) ctx.globalAlpha *= canvasPaintTokens.widget.connectedOpacity
    const hovered = row.viewId !== 'core.compositor' &&
      this.overlay.hoveredWidget?.nodeId === sceneNode.id &&
      this.overlay.hoveredWidget.valueKey === row.valueKey
    const drag = this.rowDrags[sceneNode.id]?.valueKey === row.valueKey ? this.rowDrags[sceneNode.id] : undefined
    // An empty field with a worked-out value shows it dimmed until edited.
    const automatic = drag === undefined && row.spec.automatic === true && node.node.values[row.valueKey] === undefined
    if (automatic) ctx.globalAlpha *= canvasPaintTokens.widget.connectedOpacity
    this.paintWidget({
      ctx,
      row,
      // Selector rows (DynamicCombo) carry their value on the row itself;
      // everything else persists under the row's value key.
      value: drag !== undefined ? drag.value
        : companion === undefined && this.editorSummaries[sceneNode.id]?.[row.valueKey]?.value !== undefined
          ? this.editorSummaries[sceneNode.id]![row.valueKey]!.value
          : row.derivedValue !== undefined ? row.derivedValue
          : automatic ? effectiveWidgetDefault(row.spec) : node.node.values[row.valueKey],
      ...(drag !== undefined ? { dragging: true } : {}),
      ...(companion !== undefined ? { companion } : {}),
      ...(companion !== undefined ? { companionAlpha } : {}),
      ...(this.editorSummaries[sceneNode.id]?.[row.valueKey] !== undefined
        ? { editorSummary: this.editorSummaries[sceneNode.id]![row.valueKey]! } : {}),
      ...(row.subgraphMark !== undefined ? { markAlpha: companionAlpha } : {}),
      x: node.x + row.inset,
      y: rowY,
      width: widgetWidth,
      rowHeight: t.rowHeight,
      connected,
      hovered,
      tokens: t,
    })
    if (hovered && !(t.widgetRowLook === 'raised-editors' && PARKED_EDITOR_VIEWS.has(row.viewId))) {
      // A neutral wash preserves the widget's own active/connected
      // styling without making value selection look like live blue data.
      const hoverAlpha = ctx.globalAlpha
      const chrome = widgetChromeRect(node.x + row.inset, rowY, widgetWidth, row.height, t.rowGeometry.fieldInsetY)
      ctx.globalAlpha = hoverAlpha * canvasPaintTokens.widget.hoverOpacity
      ctx.fillStyle = t.colors.label
      ctx.beginPath()
      ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
      ctx.fill()
      ctx.globalAlpha = hoverAlpha
    }
    // A panel field's box is sized on the subgraph node, so it has no bar.
    if (row.viewId === 'core.text' && !row.inactive && !row.ghost && sceneNode.id !== boundarySceneId('inputs')) {
      // The short bar on the box's bottom edge sizes the box in lines.
      const edge = canvasPaintTokens.widget.textBoxEdge
      const hot = this.overlay.textBoxEdge?.nodeId === sceneNode.id &&
        this.overlay.textBoxEdge.valueKey === row.valueKey
      const barWidth = hot ? edge.hotWidth : edge.width
      const edgeAlpha = ctx.globalAlpha
      ctx.globalAlpha = rowAlpha
      ctx.fillStyle = hot ? t.colors.widgetAffordanceActive : t.colors.widgetAffordance
      ctx.beginPath()
      ctx.roundRect(node.x + row.inset + (widgetWidth - barWidth) / 2, rowY + row.height - edge.bottomOffset,
        barWidth, edge.height, edge.radius)
      ctx.fill()
      ctx.globalAlpha = edgeAlpha
    }
    if (row.lead) {
      // A choice's dropdown has its own outline, joined to the box its
      // option rows hang in.
      const chrome = widgetChromeRect(node.x + row.inset, rowY, widgetWidth, row.height, t.rowGeometry.fieldInsetY)
      const half = canvasPaintTokens.node.box.stroke / 2
      ctx.strokeStyle = t.colors.boxOutline
      ctx.lineWidth = canvasPaintTokens.node.box.stroke
      ctx.beginPath()
      ctx.roundRect(chrome.x + half, chrome.y + half, chrome.width - half * 2, chrome.height - half * 2, chrome.radius)
      ctx.stroke()
    }
    // A problem on this field (out-of-range number, unknown choice, ...)
    // outlines the field, so the row shows where the user acts without
    // changing the node's height.
    this.paintRowProblem(ctx, sceneNode.id,
      this.rowMarks[sceneNode.id]?.[row.valueKey] !== undefined ? row.valueKey : row.inputId,
      widgetChromeRect(node.x + row.inset, rowY, widgetWidth, row.height, t.rowGeometry.fieldInsetY))
    if (this.overlay.dropRow?.nodeId === sceneNode.id && this.overlay.dropRow.valueKey === row.valueKey) {
      // A held wire takes this field when dropped: the drop-target
      // outline sits inside the chrome, at full strength even on a
      // wired (dimmed) row.
      const outlineAlpha = ctx.globalAlpha
      ctx.globalAlpha = rowAlpha
      const stroke = canvasPaintTokens.widget.dropStroke
      const chrome = widgetChromeRect(node.x + row.inset, rowY, widgetWidth, row.height, t.rowGeometry.fieldInsetY)
      ctx.strokeStyle = t.colors.dropTarget
      ctx.lineWidth = stroke
      ctx.beginPath()
      ctx.roundRect(chrome.x + stroke / 2, chrome.y + stroke / 2, chrome.width - stroke, chrome.height - stroke,
        Math.max(0, chrome.radius - stroke / 2))
      ctx.stroke()
      ctx.globalAlpha = outlineAlpha
    }
    const numberView = row.viewId === 'core.number' || row.viewId === 'core.slider'
    // In-row editing draws a number's mode as an icon before its value instead of the chip.
    if (row.controllerMode !== undefined && !(numberView && t.widgetEditing === 'in-row')) {
      const chip = controllerChipRect(widgetWidth, t.rowHeight, t.rowGeometry)
      const x = node.x + row.inset + chip.x
      const y = rowY + chip.y
      const chipAlpha = ctx.globalAlpha
      if (connected) ctx.globalAlpha = chipAlpha * canvasPaintTokens.widget.connectedControllerOpacity
      ctx.fillStyle = t.colors.widgetRaised
      ctx.fillRect(x, y, chip.width, chip.height)
      ctx.strokeStyle = t.colors.selection
      ctx.strokeRect(x, y, chip.width, chip.height)
      const icon = chip.width * canvasPaintTokens.controller.chipIconRatio
      paintSeedControllerIcon(ctx, row.controllerMode, x + (chip.width - icon) / 2, y + (chip.height - icon) / 2, icon, t.colors.label)
      ctx.globalAlpha = chipAlpha
    }
    const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
    if (numeric && row.derivedValue === undefined && !row.ghost) {
      // Edge glyphs reserve only the small bump zones; the broad center
      // remains the familiar editor activation target.
      const cy = rowY + t.rowHeight / 2 + (t.crispEdges ? canvasPaintTokens.widget.pixelCenter : 0)
      const glyphAlpha = ctx.globalAlpha
      const previousStrokeStyle: string | CanvasGradient | CanvasPattern = ctx.strokeStyle
      const previousLineWidth = ctx.lineWidth
      const previousLineCap = ctx.lineCap
      if (connected) ctx.globalAlpha = glyphAlpha * canvasPaintTokens.widget.connectedGlyphOpacity
      ctx.strokeStyle = t.colors.label
      ctx.lineWidth = t.rowGeometry.stepperStroke
      ctx.lineCap = 'round'
      const rowLeft = node.x + row.inset
      const rowWidth = widgetWidth
      const minusX = rowLeft + edgeActionCenterX(rowWidth, 'leading', t.rowGeometry)
      const plusX = rowLeft + edgeActionCenterX(rowWidth, 'trailing', t.rowGeometry)
      ctx.beginPath()
      ctx.moveTo(minusX - EDGE_ACTION_GLYPH_HALF, cy)
      ctx.lineTo(minusX + EDGE_ACTION_GLYPH_HALF, cy)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(plusX - EDGE_ACTION_GLYPH_HALF, cy)
      ctx.lineTo(plusX + EDGE_ACTION_GLYPH_HALF, cy)
      ctx.moveTo(plusX, cy - EDGE_ACTION_GLYPH_HALF)
      ctx.lineTo(plusX, cy + EDGE_ACTION_GLYPH_HALF)
      ctx.stroke()
      ctx.strokeStyle = previousStrokeStyle
      ctx.lineWidth = previousLineWidth
      ctx.lineCap = previousLineCap
      ctx.globalAlpha = glyphAlpha
    }
    const lensAffordance = this.lensCapabilities.widgetRowAffordance?.(sceneNode, row)
    if (lensAffordance !== undefined) {
      const rowWidth = widgetWidth
      const rect = widgetRowAffordanceRect(rowWidth, t.rowHeight, row, t.rowGeometry)
      const x = node.x + row.inset + rect.x
      const y = rowY + rect.y
      const affordanceAlpha = ctx.globalAlpha
      const paint = canvasPaintTokens.lensAffordance
      if (lensAffordance.disabled === true) ctx.globalAlpha *= paint.disabledOpacity
      ctx.fillStyle = lensAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetBackground
      ctx.strokeStyle = lensAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetAffordance
      ctx.lineWidth = paint.stroke
      ctx.beginPath()
      ctx.roundRect(x, y, rect.width, rect.height, paint.radius)
      ctx.fill()
      ctx.stroke()
      ctx.strokeStyle = lensAffordance.active ? t.colors.canvasBackground : t.colors.widgetAffordance
      ctx.lineCap = 'round'
      ctx.beginPath()
      if (lensAffordance.active) {
        ctx.moveTo(x + rect.width * paint.check.startX, y + rect.height * paint.check.startY)
        ctx.lineTo(x + rect.width * paint.check.middleX, y + rect.height * paint.check.middleY)
        ctx.lineTo(x + rect.width * paint.check.endX, y + rect.height * paint.check.endY)
      } else {
        ctx.moveTo(x + rect.width * paint.plus.start, y + rect.height / 2)
        ctx.lineTo(x + rect.width * paint.plus.end, y + rect.height / 2)
        ctx.moveTo(x + rect.width / 2, y + rect.height * paint.plus.start)
        ctx.lineTo(x + rect.width / 2, y + rect.height * paint.plus.end)
      }
      ctx.stroke()
      ctx.globalAlpha = affordanceAlpha
    }
    ctx.globalAlpha = rowAlpha
  }

  private drawRunningGlow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const paint = canvasPaintTokens.running
    const pulse = this.reducedMotion
      ? paint.reducedMotionPulse
      : (Math.sin((this.animationTimeMs / paint.pulsePeriodMs) * Math.PI * 2) + 1) / 2
    ctx.save()
    ctx.globalAlpha *= paint.glowOpacity + pulse * paint.glowPulseOpacity
    ctx.beginPath()
    ctx.roundRect(x - paint.glowOutset, y - paint.glowOutset, width + paint.glowOutset * 2, height + paint.glowOutset * 2, this.tokens.cornerRadius + paint.glowOutset)
    ctx.strokeStyle = this.tokens.stateColors.running
    ctx.lineWidth = screenAwareStroke(paint.glowStroke, this.viewport.scale, paint.glowMinScreenStroke)
    ctx.shadowColor = this.tokens.stateColors.running
    ctx.shadowBlur = paint.glowBlur + pulse * paint.glowPulseBlur
    ctx.stroke()
    ctx.restore()
  }

  private drawRunningAccent(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const scale = finiteScale(this.viewport.scale)
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(x, y, width, height, this.tokens.cornerRadius)
    ctx.strokeStyle = this.tokens.progressBar
    ctx.lineWidth = screenAwareStroke(canvasPaintTokens.running.accentStroke, scale, canvasPaintTokens.running.accentMinScreenStroke)
    ctx.setLineDash(screenAwareDash(canvasPaintTokens.dash.running.world, canvasPaintTokens.dash.running.screen, scale))
    ctx.lineDashOffset = -(this.animationTimeMs * canvasPaintTokens.running.dashSpeed) / scale
    ctx.stroke()
    ctx.restore()
  }

  /**
   * Data-lens panel over one node's body: near-opaque scrim below the
   * header, then label/text rows in the companion design language. Rows
   * that do not fit collapse into a trailing "+N more" (the node keeps its
   * layout size by contract - the panel adapts, never the node).
   */
  private drawDataPanel(
    ctx: CanvasRenderingContext2D,
    nx: number,
    ny: number,
    l: NodeLayout,
    rows: readonly DataPanelRow[],
  ): void {
    const t = this.tokens
    const paint = canvasPaintTokens.dataPanel
    const px = nx + paint.borderInset
    const py = ny + l.headerHeight
    const pw = l.width - paint.borderInset * 2
    const ph = l.height - l.headerHeight - paint.borderInset
    if (ph < paint.minHeight || pw < paint.minWidth) return
    const baseAlpha = ctx.globalAlpha
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(px, py, pw, ph, [0, 0, t.cornerRadius - paint.borderInset, t.cornerRadius - paint.borderInset])
    ctx.clip()
    ctx.globalAlpha = baseAlpha * paint.scrimOpacity
    ctx.fillStyle = t.colors.canvasBackground
    ctx.fillRect(px, py, pw, ph)
    ctx.globalAlpha = baseAlpha

    const rowH = paint.rowHeight
    const maxRows = Math.max(1, Math.floor((ph - paint.verticalPadding * 2) / rowH))
    const overflow = rows.length > maxRows
    const shown = overflow ? rows.slice(0, maxRows - 1) : rows
    const font = `${t.fontSize - canvasPaintTokens.type.smallReduction}px ${t.fontFamily}`
    ctx.textBaseline = 'middle'
    let y = py + paint.verticalPadding + rowH / 2
    const innerX = px + t.padX - paint.horizontalPaddingReduction
    const innerW = pw - (t.padX - paint.horizontalPaddingReduction) * 2
    for (const row of shown) {
      const tone = row.tone ?? 'value'
      ctx.font = font
      let labelWidth = 0
      if (row.label !== '') {
        ctx.fillStyle = t.colors.label
        ctx.textAlign = 'left'
        const maxLabel = innerW * paint.labelRatio
        ctx.fillText(row.label, innerX, y, maxLabel)
        labelWidth = Math.min(ctx.measureText(row.label).width, maxLabel)
      }
      // Values italicize like companions ("derived, not stored"); stale dims
      // with the same factor stale companions use.
      if (tone !== 'muted') ctx.font = `italic ${font}`
      if (tone === 'stale') ctx.globalAlpha = baseAlpha * paint.staleOpacity
      ctx.fillStyle = tone === 'muted' ? t.colors.label : t.colors.companionValue
      ctx.textAlign = 'right'
      ctx.fillText(row.text, innerX + innerW, y, innerW - labelWidth - paint.valueGap)
      ctx.globalAlpha = baseAlpha
      y += rowH
    }
    if (overflow) {
      ctx.font = font
      ctx.fillStyle = t.colors.label
      ctx.textAlign = 'right'
      ctx.fillText(`+${rows.length - shown.length} more`, innerX + innerW, y)
    }
    ctx.textAlign = 'left'
    ctx.restore()
  }

  /**
   * A boundary pseudo-node: same design language as drawNode (body, header
   * band, port rows, pins) but visually tagged as a derived construct with a
   * dashed border and no execution state, badges, widgets, or resize
   * affordance. dx/dy is the live drag offset.
   */
  /**
   * The unfolded editor and its row are one open box: one outline runs from
   * the row's top around the space, so the editor's own rows sit on the
   * body as the node's rows do. Its controls are the host's, laid over it;
   * the picture's place is drawn inset. `left` is the node's or panel's left
   * edge and `rowY` the space's top, in world coordinates.
   */
  /**
   * A lookup note's state line, one row under its text: the shared spinner
   * while loading (drawn still) or an info mark, and its words, dimmed; then
   * Try again on the row below when the call can be asked again.
   */
  private paintNoteLookup(ctx: CanvasRenderingContext2D, line: NoteLookupLine, x: number, top: number, unit: number, room: number, hovered: boolean): void {
    const t = this.tokens
    const alpha = ctx.globalAlpha
    const paint = canvasPaintTokens.node.lookupNote
    const cy = top + unit / 2
    const r = Math.max(paint.markMinRadius, t.fontSize * paint.markRadiusScale)
    ctx.lineWidth = paint.markStroke
    if (line.tone === 'busy') {
      ctx.strokeStyle = t.colors.boxOutline
      ctx.beginPath()
      ctx.arc(x + r, cy, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.strokeStyle = t.colors.rowLink
      ctx.beginPath()
      ctx.arc(x + r, cy, r, -Math.PI / 2, 0)
      ctx.stroke()
    } else {
      ctx.strokeStyle = t.colors.label
      ctx.beginPath()
      ctx.arc(x + r, cy, r, 0, Math.PI * 2)
      ctx.stroke()
      ctx.fillStyle = t.colors.label
      ctx.textAlign = 'center'
      const font = ctx.font
      ctx.font = `${Math.round(r * paint.glyphScale)}px ${t.fontFamily}`
      ctx.fillText('i', x + r, cy + paint.glyphNudge)
      ctx.font = font
    }
    const gap = r * 2 + paint.textGap
    ctx.globalAlpha = alpha * GHOST_ALPHA
    ctx.fillStyle = t.colors.label
    ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, line.text, Math.max(0, room - gap)), x + gap, cy)
    ctx.globalAlpha = alpha
    if (line.retry === undefined) return
    const label = translate('canvas.lookup.tryAgain')
    const ry = cy + unit
    if (hovered) {
      ctx.fillStyle = t.colors.buttonHover
      const inset = paint.hoverInset
      ctx.fillRect(x - inset, ry - unit / 2 + inset, ctx.measureText(label).width + inset * 2, unit - inset * 2)
    }
    ctx.fillStyle = t.colors.rowLink
    ctx.fillText(fitText(ctx, label, room), x, ry)
  }

  private paintEditorSpace(
    ctx: CanvasRenderingContext2D,
    left: number,
    rowY: number,
    row: Extract<LayoutRow, { kind: 'editorSpace' }>,
    layoutWidth: number,
  ): void {
    const t = this.tokens
    const space = canvasPaintTokens.node.editorSpace
    const x = left + row.inset
    const width = row.width ?? layoutWidth - row.inset * 2
    const stroke = canvasPaintTokens.node.box.stroke
    const top = rowY - row.rowAbove + t.rowGeometry.fieldInsetY
    ctx.strokeStyle = t.colors.boxOutline
    ctx.lineWidth = stroke
    ctx.beginPath()
    // The row's corners, so the outline meets the row's fill exactly.
    ctx.roundRect(x + stroke / 2, top + stroke / 2, width - stroke,
      rowY + row.height - t.rowGeometry.fieldInsetY - top - stroke, canvasPaintTokens.widget.radius)
    ctx.stroke()
    if (row.picture) {
      ctx.fillStyle = t.colors.canvasBackground
      ctx.beginPath()
      ctx.roundRect(x + space.pad, rowY + row.picture.top, width - space.pad * 2, row.picture.height, canvasPaintTokens.node.box.radius)
      ctx.fill()
    }
  }

  private drawBoundaryNode(
    ctx: CanvasRenderingContext2D,
    bnode: SceneBoundaryNode,
    detailLevel: CanvasDetailLevel,
    dx = 0,
    dy = 0,
  ): void {
    const t = this.tokens
    const paint = canvasPaintTokens.boundary
    const l = bnode.layout
    const x = bnode.x + dx
    const y = bnode.y + dy
    const scale = this.viewport.scale
    const contentDetail = detailLevel !== 'overview'
    const pinRadius = detailRadius(t.pinRadius, scale, detailLevel)
    const selectionStrokeWidth = screenAwareStroke(SELECTION_OUTLINE_STROKE_WIDTH, scale, canvasPaintTokens.toolbox.selectionMinScreenStroke)

    // Body.
    ctx.beginPath()
    ctx.roundRect(x, y, l.width, l.height, t.cornerRadius)
    ctx.fillStyle = t.colors.nodeBody
    ctx.fill()
    // Header.
    ctx.beginPath()
    ctx.roundRect(x, y, l.width, l.headerHeight, [t.cornerRadius, t.cornerRadius, 0, 0])
    ctx.fillStyle = t.colors.nodeHeader
    ctx.fill()
    paintHeaderRule(ctx, t, x, y, l.width, l.headerHeight, l.height)
    // Dashed border: the "derived, not a real node" signal.
    ctx.save()
    ctx.setLineDash(screenAwareDash(canvasPaintTokens.dash.boundary.world, canvasPaintTokens.dash.boundary.screen, scale))
    // Crisp edges draw the border like a node's: 1 px inside the box.
    const borderStroke = screenAwareStroke(t.crispEdges ? canvasPaintTokens.node.outline.crisp : paint.stroke, scale, paint.minScreenStroke)
    const borderInset = t.crispEdges ? borderStroke / 2 : 0
    ctx.beginPath()
    ctx.roundRect(x + borderInset, y + borderInset, l.width - borderInset * 2, l.height - borderInset * 2, Math.max(0, t.cornerRadius - borderInset))
    ctx.strokeStyle = t.colors.nodeOutline
    ctx.lineWidth = borderStroke
    ctx.stroke()
    ctx.restore()
    if (this.overlay.bodyDropNode === boundarySceneId(bnode.side)) {
      ctx.beginPath()
      ctx.roundRect(x - paint.dropOutset, y - paint.dropOutset, l.width + paint.dropOutset * 2, l.height + paint.dropOutset * 2, t.cornerRadius + paint.dropOutset)
      ctx.strokeStyle = t.colors.dropTarget
      ctx.lineWidth = screenAwareStroke(paint.dropStroke, scale, paint.dropStroke)
      ctx.stroke()
    }
    if (this.overlay.selection?.has(boundarySceneId(bnode.side))) {
      this.drawSelectionOutline(
        ctx,
        x,
        y,
        l.width,
        l.height,
        BOUNDARY_SELECTION_OUTLINE_OUTSET,
        t.cornerRadius,
        selectionStrokeWidth,
      )
    }

    if (contentDetail) {
      // Title.
      ctx.fillStyle = t.colors.title
      ctx.font = `${canvasPaintTokens.type.semiboldWeight} ${t.titleFontSize}px ${t.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText(l.title, x + t.padX, y + l.headerHeight / 2, l.width - t.padX * 2)
      const subtitleX = x + t.padX + ctx.measureText(l.title).width + paint.subtitleGap
      ctx.font = `${t.fontSize}px ${t.fontFamily}`
      if (l.subtitle !== undefined) {
        ctx.fillStyle = t.colors.label
        ctx.fillText(l.subtitle, subtitleX, y + l.headerHeight / 2, Math.max(0, x + l.width - t.padX - subtitleX))
      }

      // Pin rows, and on an Inputs panel the field rows of the subgraph
      // node outside. Ghost rows (the trailing "expose..." affordance)
      // render dimmed.
      const face = boundaryFieldNode(bnode)
      for (const row of l.rows) {
        if (row.kind === 'widget' && face !== undefined) {
          this.drawFieldRow(ctx, face, { ...face, x, y }, row,
            bnode.fields!.wired[row.valueKey])
          ctx.font = `${t.fontSize}px ${t.fontFamily}`
          ctx.textBaseline = 'middle'
          continue
        }
        if (row.kind === 'editorSpace') {
          this.paintEditorSpace(ctx, x, y + row.y, row, l.width)
          continue
        }
        if (row.kind !== 'ports') continue
        const rowY = y + row.y
        const slot = row.input ?? row.output
        const dim = slot?.ghost === true
        if (dim) ctx.globalAlpha = GHOST_ALPHA
        if (row.input) {
          ctx.fillStyle = t.colors.label
          paintPinLabel(ctx, t, row.input.label, x + t.rowGeometry.portLabelInset, rowY + row.height / 2, 'left')
        }
        if (row.output) {
          ctx.fillStyle = t.colors.label
          paintPinLabel(ctx, t, row.output.label, x + l.width - t.rowGeometry.portLabelInset, rowY + row.height / 2, 'right')
        }
        if (dim) ctx.globalAlpha = 1
      }
      ctx.textBaseline = 'alphabetic'
    }

    // Pins. Ghost pins draw hollow; a legal boundary drop target gets the
    // same highlight ring as regular pins.
    for (const pin of l.pins) {
      const { x: px, y: py } = edgePinPoint(t, pin.direction, pin.direction === 'in' ? x : x + l.width, y + pin.y)
      if (this.overlay.dropTargets?.has(boundaryTargetKey(bnode.side, pin.portId))) {
        ctx.beginPath()
        ctx.arc(px, py, statusRingRadius(pinShapeOf(pin.type, pin.direction, pin.acceptsList === true), pinRadius, pinRadius), 0, Math.PI * 2)
        ctx.strokeStyle = t.colors.dropTarget
        ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
        ctx.stroke()
      }
      const pinColor = pinColorOf(t, pin.type)
      if (pin.ghost) {
        const shape = pinShapeOf(pin.type, pin.direction, pin.acceptsList === true)
        pinOutlinePath(ctx, shape, px, py, pinShapeRadius(shape, pinRadius))
        ctx.globalAlpha = GHOST_ALPHA
        ctx.strokeStyle = pinColor
        ctx.lineWidth = screenAwareStroke(canvasPaintTokens.pin.ghostStroke, scale, canvasPaintTokens.pin.ghostMinScreenStroke)
        ctx.stroke()
        ctx.globalAlpha = 1
      } else {
        paintTypedPin(ctx, t, pin.type, px, py, scale, pin.maybeAbsent === true, pin.direction, pinRadius, pin.acceptsList === true)
      }
    }
  }
}

const hexRgb = (color: string): readonly [number, number, number] | undefined => {
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color)
  if (short) return [
    Number.parseInt(short[1]! + short[1]!, 16),
    Number.parseInt(short[2]! + short[2]!, 16),
    Number.parseInt(short[3]! + short[3]!, 16),
  ]
  const full = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color)
  return full
    ? [Number.parseInt(full[1]!, 16), Number.parseInt(full[2]!, 16), Number.parseInt(full[3]!, 16)]
    : undefined
}

/** One opaque CSS color, so mode alpha applies exactly once to the region. */
const tintHex = (base: string, tint: string, amount: number): string => {
  const from = hexRgb(base)
  const to = hexRgb(tint)
  if (!from || !to) return amount >= 0.5 ? tint : base
  const channel = (index: number) => Math.round(from[index]! + (to[index]! - from[index]!) * amount)
    .toString(16).padStart(2, '0')
  return `#${channel(0)}${channel(1)}${channel(2)}`
}

const ZERO_OFFSET = { dx: 0, dy: 0 } as const

/** Culling slack for pins/rings that overhang an item's bounds (world units). */
const PIN_OVERHANG = canvasPaintTokens.node.pinOverhang

/**
 * The flat-title look draws its title bar in the body's color, so a 1 px
 * rule in the title bar's last pixel row separates it from the rows. A
 * collapsed node has no rows below its title and gets no rule.
 */
function paintHeaderRule(
  ctx: CanvasRenderingContext2D,
  t: DesignTokens,
  x: number,
  y: number,
  width: number,
  headerHeight: number,
  height: number,
): void {
  if (t.nodeLook !== 'flat-title' || height <= headerHeight) return
  ctx.fillStyle = t.colors.nodeHeaderRule
  const stroke = canvasPaintTokens.node.headerRuleStroke
  ctx.fillRect(x, y + headerHeight - stroke, width, stroke)
}

/** Alpha applied to nodes/links outside a partial-execution scope preview. */
const SCOPE_DIM = canvasPaintTokens.opacity.scopeDim

/** Fallback painter: label left, formatted value right. Label and value
 * share the row deficit-proportionally (text-fit.ts) so neither overlaps
 * nor starves the other. */
export const defaultWidgetPainter: WidgetPainter = (args) => {
  const { ctx, row, value, x, y, width, rowHeight, tokens } = args
  const paint = canvasPaintTokens.widget
  ctx.fillStyle = tokens.colors.widgetBackground
  ctx.beginPath()
  ctx.roundRect(x, y + tokens.rowGeometry.fieldInsetY, width, row.height - tokens.rowGeometry.fieldInsetY * 2, paint.radius)
  ctx.fill()
  if (args.companion !== undefined) {
    const formatted = formatWidgetValue(args.companion.value, row.spec).split('\n')[0] ?? ''
    const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
    const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined, tokens.rowGeometry)
    const companionZone = shareRowWidth(field.right - field.left, measureWidth(ctx, row.label) + paint.labelWidthPadding, measureWidth(ctx, formatted) + paint.labelWidthPadding)
    ctx.fillStyle = tokens.colors.label
    ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, row.label, Math.max(0, companionZone - paint.labelClipPadding)), x + field.left + (numeric ? tokens.rowGeometry.stepperLabelInset : paint.labelInset), y + rowHeight / 2)
    paintCompanionValue(args)
    return
  }
  const text = formatWidgetValue(value, row.spec).split('\n')[0] ?? ''
  const controller = row.controllerMode !== undefined
    ? controllerChipRect(width, rowHeight, tokens.rowGeometry)
    : undefined
  const valueRight = controller === undefined ? width - paint.labelInset : controllerChipTextRight(width, rowHeight, tokens.rowGeometry)
  const usable = Math.max(0, valueRight - paint.labelInset)
  const labelZone = shareRowWidth(
    usable,
    measureWidth(ctx, row.label) + paint.labelWidthPadding,
    measureWidth(ctx, text) + paint.fallbackValueWidthPadding,
    true,
  )
  const valueWidth = Math.max(0, usable - labelZone)
  ctx.fillStyle = tokens.colors.label
  ctx.textAlign = 'left'
  ctx.fillText(fitText(ctx, row.label, Math.max(0, labelZone - paint.labelClipPadding)), x + paint.labelInset, y + rowHeight / 2)
  ctx.fillStyle = tokens.colors.value
  ctx.textAlign = 'right'
  const displayText = fitText(ctx, text, valueWidth)
  const textRight = x + valueRight
  const textY = y + rowHeight / 2
  ctx.fillText(displayText, textRight, textY)
  if (args.connected) paintStaleValueStrikethrough(ctx, displayText, textRight, textY, 'right', tokens.colors.value)
  ctx.textAlign = 'left'
}

/** Cross out a dormant stored value whose connected input has no preview. */
export function paintStaleValueStrikethrough(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  align: 'left' | 'right',
  color: string,
): void {
  if (text.length === 0) return
  const width = measureWidth(ctx, text)
  const left = align === 'right' ? x - width : x
  const right = align === 'right' ? x : x + width
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = canvasPaintTokens.widget.staleValueStroke
  ctx.beginPath()
  ctx.moveTo(left, y)
  ctx.lineTo(right, y)
  ctx.stroke()
  ctx.restore()
}

/** A color with opacity: `#rgba` or `#rrggbbaa` short of fully opaque. */
function hasOpacity(color: string): boolean {
  const alpha = /^#(?:[\da-f]{3}([\da-f])|[\da-f]{6}([\da-f]{2}))$/i.exec(color)
  return alpha !== null && !/^f+$/i.test(alpha[1] ?? alpha[2]!)
}

/** The square of a color directly before its code; opacity shows over a checker pattern, and an edge inside it keeps white and black squares visible. */
export function paintValueSwatch(ctx: CanvasRenderingContext2D, color: string, left: number, top: number, tokens: DesignTokens): void {
  const { size, radius, checkerCell, edge } = canvasPaintTokens.widget.valueSwatch
  // Whole pixels keep the square's edges and checker cells sharp.
  left = Math.round(left)
  top = Math.round(top)
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(left, top, size, size, radius)
  ctx.clip()
  if (hasOpacity(color)) {
    ctx.fillStyle = tokens.colors.swatchCheckerAlt
    ctx.fillRect(left, top, size, size)
    ctx.fillStyle = tokens.colors.swatchChecker
    let rowStartsDark = true
    for (let cellTop = top; cellTop < top + size; cellTop += checkerCell) {
      let dark = rowStartsDark
      for (let cellLeft = left; cellLeft < left + size; cellLeft += checkerCell) {
        if (dark) ctx.fillRect(cellLeft, cellTop, checkerCell, checkerCell)
        dark = !dark
      }
      rowStartsDark = !rowStartsDark
    }
  }
  ctx.fillStyle = color
  ctx.fillRect(left, top, size, size)
  ctx.restore()
  ctx.save()
  ctx.strokeStyle = tokens.colors.swatchEdge
  ctx.lineWidth = edge
  ctx.beginPath()
  ctx.roundRect(left + edge / 2, top + edge / 2, size - edge, size - edge, Math.max(0, radius - edge / 2))
  ctx.stroke()
  ctx.restore()
}

/**
 * As many of `items` as fit in `maxWidth`, separated by a comma and a space,
 * then "+N" for the rest. The first item always shows, cut if it must be.
 */
export function fitItems(ctx: CanvasRenderingContext2D, items: readonly string[], maxWidth: number): string {
  const more = (shown: number) => shown < items.length ? ` +${items.length - shown}` : ''
  // Items past the row's width cannot fit, so the search starts below them.
  let candidate = 0
  for (let used = 0; candidate < items.length && used <= maxWidth; candidate++) {
    used += measureWidth(ctx, items[candidate]!) + (candidate > 0 ? measureWidth(ctx, ', ') : 0)
  }
  for (let shown = candidate; shown >= 1; shown--) {
    const text = items.slice(0, shown).join(', ') + more(shown)
    if (measureWidth(ctx, text) <= maxWidth) return text
  }
  return fitText(ctx, items[0] ?? '', Math.max(0, maxWidth - measureWidth(ctx, more(1)))) + more(1)
}

/**
 * The text a row's own view shows for a value, with the color square before
 * it or the list items it fits.
 */
export interface CompanionSummary {
  readonly text: string
  readonly swatch?: string
  readonly items?: readonly string[]
}

/**
 * Draw a companion (propagated) value into a widget row whose chrome+label
 * are already painted: italic, companion color, right-aligned - the shared
 * "this is what flows in, not what you stored" style for every widget kind.
 * Stale/unproven companions use their own semantic color and dotted
 * underline. Full text opacity preserves AA contrast and the underline keeps
 * the state distinguishable without color. `summary`, when given, is the
 * text the row's own view shows for the value, used instead of its code.
 */
export function paintCompanionValue({ ctx, row, companion, companionAlpha, x, y, width, rowHeight, tokens }: WidgetPaintArgs, summary?: CompanionSummary): void {
  if (companion === undefined) return
  const prevFont = ctx.font
  const prevAlpha = ctx.globalAlpha
  const estimate = companion.state === 'estimate'
  // The approx prefix keeps a mirror-computed estimate distinguishable from
  // an execution-recorded value even without color.
  const prefix = estimate ? '\u2248 ' : ''
  const text = prefix + (summary?.text ?? formatWidgetValue(companion.value, row.spec).split('\n')[0] ?? '')
  const swatch = summary?.swatch
  const swatchReserve = swatch === undefined ? 0 : canvasPaintTokens.widget.valueSwatch.size + canvasPaintTokens.widget.valueSwatch.gap
  const numeric = (row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT') && row.viewId !== 'core.integerColor'
  const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined, tokens.rowGeometry)
  // The subgraph mark before the name widens the name's share, as the painter lays it out.
  const mark = row.subgraphMark === undefined ? 0 : canvasPaintTokens.widget.subgraphMark.size + canvasPaintTokens.widget.subgraphMark.gap
  const labelZone = shareRowWidth(field.right - field.left, mark + measureWidth(ctx, row.label) + canvasPaintTokens.widget.labelWidthPadding, measureWidth(ctx, text) + canvasPaintTokens.widget.labelWidthPadding)
  const availableWidth = Math.max(0, field.right - field.left - labelZone - swatchReserve)
  const unproven = companion.state === 'stale' || (companion.state === undefined && companion.stale === true)
  const color = unproven
    ? tokens.colors.companionUnproven
    : estimate ? tokens.colors.companionEstimate : tokens.colors.companionValue
  ctx.font = `italic ${prevFont}`
  ctx.globalAlpha = companionAlpha ?? prevAlpha
  const textY = y + rowHeight / 2
  const textRight = x + field.right
  const displayText = summary?.items !== undefined
    ? prefix + fitItems(ctx, summary.items, Math.max(0, availableWidth - measureWidth(ctx, prefix)))
    : fitText(ctx, text, availableWidth)
  ctx.fillStyle = color
  ctx.textAlign = 'right'
  ctx.fillText(displayText, textRight, textY)
  if (swatch !== undefined) {
    const { size, gap } = canvasPaintTokens.widget.valueSwatch
    paintValueSwatch(ctx, swatch, textRight - measureWidth(ctx, displayText) - gap - size, textY - size / 2, tokens)
  }
  if (unproven && displayText.length > 0) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = canvasPaintTokens.widget.companion.stroke
    ctx.setLineDash([...canvasPaintTokens.dash.companionUnderline])
    ctx.beginPath()
    ctx.moveTo(textRight - measureWidth(ctx, displayText), textY + canvasPaintTokens.widget.companion.underlineOffset)
    ctx.lineTo(x + field.right, textY + canvasPaintTokens.widget.companion.underlineOffset)
    ctx.stroke()
    ctx.restore()
  }
  ctx.textAlign = 'left'
  ctx.font = prevFont
  ctx.globalAlpha = prevAlpha
}
