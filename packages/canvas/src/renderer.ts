/**
 * Canvas2D renderer (initial implementation spike): draws a Scene with pan/zoom, DPR handling,
 * viewport culling, per-node execution state styling, and widget rows painted
 * through an injected WidgetPainter (registry-backed in the app; a plain
 * label/value fallback here). Framework-free; subscribes to nothing - the
 * owner pushes scene/state and the renderer repaints on a rAF dirty loop.
 */

import { atomNamesOf, canonicalTypeIdOf, cardinalityOf, formatWidgetValue, selectorCandidateKey, type Json, type NodeProgress, type NodeRunState, type TypeExpr } from '@dinkster/core'
import {
  BADGE_SIZE,
  badgeRect,
  headerBadgeLaneWidth,
  PROBLEM_BLOCKING_WARNING_BADGE,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  type BadgeMap,
  type PortProblemMap,
} from './badges.js'
import { controllerChipRect, controllerChipTextRight, CONTROLLER_CHIP_TEXT_GAP, EDGE_ACTION_GLYPH_HALF, edgeActionCenterX, WIDGET_EDGE_CONTROL_WIDTH, widgetFieldBounds } from './controller-chip.js'
import { linkBounds, linkControlOffset } from './hit.js'
import { animationFrameAt, containRect, splitPreviewRect, type OutputTextMap, type PreviewMap } from './previews.js'
import { projectNodeLayoutHeight, widgetChromeRect, withCompactPreviewRegion, withPreviewRegion, withTextOutputRegion, type LayoutRow, type NodeLayout } from './layout.js'
import {
  boundarySceneId,
  GROUP_HEADER_HEIGHT,
  portEndKey,
  REROUTE_RADIUS,
  REROUTE_SOCKET_OFFSET,
  REROUTE_SOCKET_RADIUS,
  sceneEndId,
  selectorBadgeRect,
  selectorCandidatePinPosition,
  selectorOutPinPosition,
  valueSourceBadgeRect,
  type Scene,
  type SceneBoundaryNode,
  type SceneGroup,
  type SceneLinkEnd,
  type SceneNetStub,
  type SceneNode,
  type SceneSelector,
  type SceneValueSource,
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
import { canvasDetailLevel, presentedType, typeColor, type CanvasDetailLevel, type DesignTokens } from './tokens.js'
import { fitText, measureWidth, shareRowWidth, wrapText } from './text-fit.js'

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

export const PIN_SLICE_DIVIDER_SCREEN_PX = 1
export const PIN_SLICE_DIVIDER_MIN_WORLD = 0.75
export const PIN_SLICE_DIVIDER_MAX_WORLD = 4

/**
 * Diamond pins (definitely-list cardinality) scale their vertex radius up so
 * the smaller diamond area reads as the same visual weight as circle pins.
 */
export const PIN_DIAMOND_SCALE = 1.25

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

/** Shape axis of a pin: cardinality decides, everything else is fill/ring. */
export const pinShapeOf = (type: TypeExpr, direction: 'in' | 'out' = 'out'): PinShape => {
  if (cardinalityOf(type) === 'list') return 'diamond'
  if (direction === 'in' && type.kind === 'variable' &&
      (type.allowedTypes === undefined || type.allowedTypes.length === 0)) return 'scalar-list'
  return 'circle'
}

const pinShapeRadius = (shape: PinShape, radius: number): number =>
  shape === 'diamond' ? radius * PIN_DIAMOND_SCALE : radius

const pinShapeRadialScale = (shape: PinShape): number =>
  shape === 'diamond' ? PIN_DIAMOND_SCALE : shape === 'scalar-list' ? Math.SQRT2 : 1

/** Trace the pin outline path for the shape axis (no fill/stroke). */
const pinOutlinePath = (ctx: CanvasRenderingContext2D, shape: PinShape, x: number, y: number, r: number): void => {
  ctx.beginPath()
  if (shape === 'circle' || shape === 'scalar-list')
    ctx.arc(x, y, r, 0, Math.PI * 2)
  if (shape === 'diamond') {
    ctx.moveTo(x, y - r)
    ctx.lineTo(x + r, y)
    ctx.lineTo(x, y + r)
    ctx.lineTo(x - r, y)
    ctx.closePath()
  } else if (shape === 'scalar-list') {
    ctx.moveTo(x - r, y - r)
    ctx.lineTo(x + r, y - r)
    ctx.lineTo(x + r, y + r)
    ctx.lineTo(x - r, y + r)
    ctx.closePath()
  }
}

/** Paint a pin from independent shape, fill-pattern, and optionality axes. */
const paintPin = (ctx: CanvasRenderingContext2D, pin: PinPaint): void => {
  const colors = pin.colors.length === 0 ? [pin.background] : pin.colors
  const r = pinShapeRadius(pin.shape, pin.radius)
  if (colors.length === 1) {
    pinOutlinePath(ctx, pin.shape, pin.x, pin.y, r)
    ctx.fillStyle = colors[0]!
    ctx.fill()
  } else {
    // MultiType wedges and dividers clip to the outline so ONE fill
    // implementation covers every shape; wedge arcs deliberately overshoot
    // the outline (r * 2 reaches past a diamond's corners).
    const base = pin.baseAngle ?? 0
    const span = (Math.PI * 2) / colors.length
    ctx.save()
    pinOutlinePath(ctx, pin.shape, pin.x, pin.y, r)
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
  pinOutlinePath(ctx, pin.shape, pin.x, pin.y, r)
  ctx.strokeStyle = pin.background
  ctx.lineWidth = 1
  if (pin.any) ctx.setLineDash([2, 1.75])
  ctx.stroke()
  if (pin.any) ctx.setLineDash([])
  if (pin.optional) {
    ctx.beginPath()
    ctx.arc(pin.x, pin.y, Math.max(1.5, pin.radius * 0.32), 0, Math.PI * 2)
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
): void => {
  // Shape carries cardinality; fill pattern, wildcard ring, and color come
  // from the ELEMENT type, so list<union<...>> segments the diamond and
  // list<Any> keeps the dashed identity ring. typeColor also peels canonical
  // 'list<...>'/'asset<...>' ids, so color always says what data flows.
  let element: TypeExpr = type
  while (element.kind === 'list' || element.kind === 'asset') element = element.element
  const slices = pinSlices(tokens, element, direction)
  paintPin(ctx, {
    shape: pinShapeOf(type, direction),
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

/**
 * node id -> value keys of rows carrying an anchored diagnostic. Widget rows
 * key by valueKey; fallback rows (unresolved schema) key by their stored
 * value key. Derived per scene build, never stored.
 */
export type RowMarkMap = Readonly<Record<string, ReadonlySet<string>>>

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
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const size = Math.max(10, Math.min(14, rowHeight - 8))
  const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
  const trailingEdge = row.controllerMode !== undefined
    ? controllerChipRect(rowWidth, rowHeight).x - CONTROLLER_CHIP_TEXT_GAP
    : rowWidth - (numeric ? WIDGET_EDGE_CONTROL_WIDTH + CONTROLLER_CHIP_TEXT_GAP : CONTROLLER_CHIP_TEXT_GAP)
  return {
    x: Math.max(
      WIDGET_EDGE_CONTROL_WIDTH + CONTROLLER_CHIP_TEXT_GAP,
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
  const size = 16
  return {
    x: region.x + region.width - size - 8,
    y: region.y + 8,
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
  const antialiasPad = 2
  const width = Math.max(fontSize, text.length * fontSize * 2)
  const height = fontSize * 2
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
    const y = -7
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
      const fontSize = Math.max(8, tokens.fontSize - 2)
      const x = node.layout.width - tokens.padX - tokens.pinRadius - 4
      const y = row.y + row.height / 2 + 10
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
  /** Absolute content origin/size (inside node padding). */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly rowHeight: number
  readonly connected: boolean
  /** True only while the pointer is over this complete widget row. */
  readonly hovered?: boolean
  readonly tokens: DesignTokens
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
  readonly selectors: ReadonlySet<string>
  /** selectorCandidateKey(selector, candidate) entries: in-scope branch feeds. */
  readonly selectorCandidates: ReadonlySet<string>
  readonly valueSources: ReadonlySet<string>
}

/** Ephemeral overlay state owned by the interaction layer (never document state). */
export interface OverlayState {
  readonly selection?: ReadonlySet<string>
  readonly linkSelection?: ReadonlySet<string>
  readonly rerouteSelection?: ReadonlySet<string>
  readonly valueSourceSelection?: ReadonlySet<string>
  readonly selectorSelection?: ReadonlySet<string>
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
  /** Live rubber-band selection rectangle (world coords, normalized). */
  readonly marquee?: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
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

/** Drop-target key for a value source's output pin (distinct namespace). */
export const valueSourceTargetKey = (valueSourceId: string): string => `valueSource::${valueSourceId}`

/** Drop-target key for one selector candidate's branch input pin. */
export const selectorInTargetKey = (selectorId: string, candidateId: string): string =>
  `selectorIn::${selectorId}::${candidateId}`

/** Drop-target key for a selector's single output pin. */
export const selectorOutTargetKey = (selectorId: string): string => `selectorOut::${selectorId}`

/** Drop-target key for a boundary pseudo-node pin (item id or the add slot). */
export const boundaryTargetKey = (side: 'inputs' | 'outputs', item: string): string =>
  `boundary::${side}::${item}`

/** Dim factor for ghost (unmaterialized dynamic) pins, labels, and widgets. */
const GHOST_ALPHA = 0.45
const PIN_HOVER_SCALE = 1.35
const STATUS_RING_GAP = 3.5
const STATUS_RING_STROKE_WIDTH = 2

/** Half the widest link stroke plus the midpoint dot: pads link bounds so
 * culling and fit account for painted thickness, not just the centerline. */
const LINK_PAINT_PAD = 4

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
    case 'pending': return screenAwareDash([2, 3], [2, 3], scale)
    case 'cached': return screenAwareDash([7, 3], [5, 3], scale)
    case 'skipped': return screenAwareDash([2, 4], [2, 4], scale)
    case 'error': return screenAwareDash([4, 2], [4, 2], scale)
    default: return undefined
  }
}

const modeDash = (mode: 'active' | 'muted' | 'bypassed', scale: number): number[] | undefined => {
  if (mode === 'muted') return screenAwareDash([2, 3], [2, 3], scale)
  if (mode === 'bypassed') return screenAwareDash([8, 3], [5, 3], scale)
  return undefined
}

const detailRadius = (radius: number, scale: number, detailLevel: CanvasDetailLevel): number =>
  detailLevel === 'overview' ? screenAwareStroke(radius, scale, 2) : radius

const statusRingCullPad = (radius: number, scale: number): number =>
  radius + STATUS_RING_GAP + screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH) / 2

const linkCullPad = (scale: number): number =>
  Math.max(5, screenAwareStroke(5.5, scale, 2) / 2) + 1 / finiteScale(scale)

const structureCullPad = (scale: number, pinRadius: number, detailLevel: CanvasDetailLevel): number => {
  const radius = detailRadius(pinRadius, scale, detailLevel)
  const hoveredRingPad = statusRingCullPad(radius, scale) + radius * (PIN_HOVER_SCALE - 1) * Math.SQRT2
  return Math.max(
    PIN_OVERHANG,
    hoveredRingPad,
    3 + screenAwareStroke(SELECTION_OUTLINE_STROKE_WIDTH, scale, 2) / 2 + 1 / finiteScale(scale),
  )
}

/**
 * World-space bounds of everything the scene persistently paints: nodes,
 * boundary pseudo-nodes, reroute dots, value sources, selectors, groups,
 * net stub tags, links (control-hull - a reverse link bulges far past both
 * endpoints). Powers fitToScene so "fit" frames the
 * whole drawing, not just the plain nodes.
 */
export function sceneVisualBounds(
  scene: Scene,
  previews: PreviewMap = {},
  badges: BadgeMap = {},
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
    const nodeBadges = badges[n.id] ?? []
    for (const [index, badge] of nodeBadges.entries()) {
      // Header badges sit inside node bounds; only the external lanes
      // (above and below the node) extend the drawing.
      if (badge.placement !== 'above' && badge.placement !== 'below') continue
      const rect = badgeRect(n, index, nodeBadges)
      include(rect.x, rect.y, rect.width, rect.height)
    }
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
  for (const v of scene.valueSources) include(v.x, v.y, v.width, v.height)
  for (const s of scene.selectors) include(s.x, s.y, s.width, s.height)
  for (const g of scene.groups) include(g.x, g.y, g.width, g.height)
  for (const s of scene.netStubs) include(s.x, s.y, s.width, s.height)
  return minX === Infinity ? undefined : { minX, minY, maxX, maxY }
}

export class CanvasRenderer {
  private baseScene: Scene = { graphId: '', nodes: [], links: [], reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [] }
  private scene: Scene = { graphId: '', nodes: [], links: [], reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [] }
  private connectedInputPins: ReadonlySet<string> = new Set()
  private connectedOutputPins: ReadonlySet<string> = new Set()
  private connectedWidgetTaps: ReadonlySet<string> = new Set()
  /** Like connectedInputPins but excluding boundary bindings (row inertness). */
  private valueDrivenInputPins: ReadonlySet<string> = new Set()
  private nodeStates: Readonly<Record<string, NodeProgress>> = {}
  private viewport: Viewport = { x: 40, y: 40, scale: 1 }
  private dirty = true
  private rafId: number | undefined
  private disposed = false
  private hasRunningNodes = false
  private reducedMotion = false
  private animationTimeMs = 0
  private previewChecker: CanvasPattern | null | undefined

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly tokens: DesignTokens,
    private readonly paintWidget: WidgetPainter = defaultWidgetPainter,
  ) {
    this.loop = this.loop.bind(this)
    this.scheduleFrame()
  }

  setScene(scene: Scene): void {
    this.baseScene = scene
    this.scene = this.sceneWithBodyRegions(scene)
    this.refreshTypeAdornments()
    this.invalidate()
    // Notify AFTER installation so listeners (gesture cancellation) observe
    // the new scene through getScene().
    for (const listener of this.sceneReplacedListeners) listener(this.scene)
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
    this.overlay = overlay
    this.invalidate()
  }

  getScene(): Scene {
    return this.scene
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

  /** Screen -> world coordinates. */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    const { x, y, scale } = this.viewport
    return { x: (sx - x) / scale, y: (sy - y) / scale }
  }

  setNodeStates(states: Readonly<Record<string, NodeProgress>>): void {
    this.nodeStates = states
    this.hasRunningNodes = false
    for (const nodeId in states) {
      if (states[nodeId]?.state === 'running') {
        this.hasRunningNodes = true
        break
      }
    }
    this.invalidate()
  }

  setReducedMotion(reduced: boolean): void {
    if (this.reducedMotion === reduced) return
    this.reducedMotion = reduced
    this.invalidate()
  }

  private companions: CompanionMap = {}

  /** Companion (propagated) values per node/valueKey. Derived, never stored. */
  setCompanions(companions: CompanionMap): void {
    this.companions = companions
    this.invalidate()
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
    this.invalidate()
  }

  getPresence(): readonly PresenceActor[] {
    return this.presence
  }

  private rowMarks: RowMarkMap = {}

  /**
   * Diagnostic-anchored row marks per node/valueKey (fallback rows key by
   * their stored value key). A marked row paints a red outline so the
   * Problems entry is actionable at the widget the user must fix -
   * mirroring (not replacing) the panel entry, like the pin warn ring.
   * Derived per scene build, never stored.
   */
  setRowMarks(marks: RowMarkMap): void {
    this.rowMarks = marks
    this.invalidate()
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

  getDesignTokens(): DesignTokens {
    return this.tokens
  }

  getDetailLevel(): CanvasDetailLevel {
    return canvasDetailLevel(this.viewport.scale, this.tokens.mediaControlMinScale)
  }

  private badges: BadgeMap = {}

  private portProblems: PortProblemMap = {}

  /** Exact input-pin problem rings, projected by the host's shared resolver. */
  setPortProblems(problems: PortProblemMap): void {
    this.portProblems = problems
    this.invalidate()
  }

  /** Header badges per node (subgraph marker, error chip, extensions). */
  setBadges(badges: BadgeMap): void {
    const laneSignature = (badgeMap: BadgeMap): string => this.baseScene.nodes
      .filter((node) => node.layout.minimized)
      .map((node) => `${node.id}\u0000${headerBadgeLaneWidth(badgeMap[node.id] ?? [])}`)
      .join('\u0000')
    const before = laneSignature(this.badges)
    const after = laneSignature(badges)
    this.badges = badges
    if (before !== after) {
      this.scene = this.sceneWithBodyRegions(this.baseScene)
      this.refreshTypeAdornments()
      for (const listener of this.sceneReplacedListeners) listener(this.scene)
    }
    this.invalidate()
  }

  getBadges(): BadgeMap {
    return this.badges
  }

  private toolbox: readonly ToolboxRow[] = []

  /** Selection toolbox rows (host-derived, like badges). */
  setToolbox(rows: readonly ToolboxRow[]): void {
    this.toolbox = rows
    this.invalidate()
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
      const badges = this.badges[node.id] ?? []
      for (const [index, badge] of badges.entries()) {
        if (badge.placement !== 'above') continue
        const badgeTop = badgeRect(node, index, badges).y
        attachedBadgeTop = attachedBadgeTop === undefined ? badgeTop : Math.min(attachedBadgeTop, badgeTop)
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
    for (const item of [...this.scene.valueSources, ...this.scene.selectors]) {
      const selected =
        ('effective' in item ? this.overlay.valueSourceSelection : this.overlay.selectorSelection)?.has(item.id) ?? false
      if (!selected) continue
      const o = off(item.id)
      boxes.push({ x1: item.x + o.dx, y1: item.y + o.dy, x2: item.x + o.dx + item.width, y2: item.y + o.dy + item.height })
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
    const maxWidth = Math.max(0, layout.width - this.tokens.padX * 2 - 8)
    const canonical = text.replace(/\r\n?/g, '\n').split('\n')
    const ctx = this.canvas.getContext('2d')
    if (ctx === null) return Math.max(1, Math.min(6, canonical.length))
    ctx.save()
    ctx.font = `italic ${this.tokens.fontSize}px ${this.tokens.fontFamily}`
    const count = canonical.reduce((total, line) => total + wrapText(ctx, line, maxWidth).length, 0)
    ctx.restore()
    return Math.max(1, Math.min(6, count))
  }

  private sceneWithBodyRegions(scene: Scene): Scene {
    if (Object.keys(this.previews).length === 0 && Object.keys(this.outputTexts).length === 0 &&
        !scene.nodes.some((node) => node.previewCapable === true || node.layout.minimized === true)) return scene
    const nodes = scene.nodes.map((node) => {
      const badgeWidth = node.layout.minimized
        ? headerBadgeLaneWidth(this.badges[node.id] ?? [])
        : 0
      const badgeAwareLayout = badgeWidth === 0
        ? node.layout
        : {
            ...node.layout,
            width: node.layout.width + badgeWidth,
            minWidth: node.layout.minWidth + badgeWidth,
          }
      const baseLayout = node.previewCapable === true || node.layout.minimized === true
        ? withCompactPreviewRegion(badgeAwareLayout, this.tokens)
        : badgeAwareLayout
      if (this.previews[node.id] !== undefined) {
        return { ...node, layout: withPreviewRegion(baseLayout, this.tokens) }
      }
      const outputText = this.outputTexts[node.id]
      if (outputText !== undefined) {
        return {
          ...node,
          layout: withTextOutputRegion(
            baseLayout,
            this.tokens,
            this.outputTextLineCount(baseLayout, outputText.text),
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
      familyBind: boolean,
    ): { x: number; y: number } => {
      if (end.kind !== 'port' && end.kind !== 'widgetTap') return fallback
      const node = byId.get(end.node)
      const pin = end.kind === 'widgetTap'
        ? node?.layout.pins.find((candidate) => candidate.widgetTap === true && candidate.address.port === end.input)
        : node?.layout.pins.find((candidate) =>
            candidate.direction === direction && candidate.portId === portEndKey(end) && candidate.widgetTap !== true,
          )
      if (node === undefined) return fallback
      if (pin === undefined && familyBind && end.kind === 'port') {
        const prefix = end.members ?? []
        const familyPin = node.layout.pins.find((candidate) =>
          candidate.direction === direction && candidate.widgetTap !== true &&
          (candidate.address.port === end.port || candidate.address.port.startsWith(`${end.port}.`)) &&
          prefix.length <= (candidate.address.members?.length ?? 0) &&
          prefix.every((member, index) => candidate.address.members?.[index] === member),
        )
        return {
          x: direction === 'out' ? node.x + node.layout.width : node.x,
          y: node.y + (familyPin?.y ?? node.layout.headerHeight / 2),
        }
      }
      if (pin === undefined) return fallback
      return { x: direction === 'out' ? node.x + node.layout.width : node.x, y: node.y + pin.y }
    }
    const links = scene.links.map((link) => {
      const from = anchor(link.from, 'out', { x: link.x1, y: link.y1 }, link.boundaryFamily === true)
      const to = anchor(link.to, 'in', { x: link.x2, y: link.y2 }, link.boundaryFamily === true)
      return { ...link, x1: from.x, y1: from.y, x2: to.x, y2: to.y }
    })
    const netStubs = scene.netStubs.map((stub) => {
      const node = byId.get(stub.nodeId)
      const direction = stub.role === 'source' ? 'out' : 'in'
      const key = portEndKey({ port: stub.portId, ...(stub.members === undefined ? {} : { members: stub.members }) })
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
    const before = Object.keys(this.previews).sort().join('\u0000')
    const after = Object.keys(previews).sort().join('\u0000')
    this.previews = previews
    if (before !== after) {
      this.scene = this.sceneWithBodyRegions(this.baseScene)
      this.refreshTypeAdornments()
      for (const listener of this.sceneReplacedListeners) listener(this.scene)
    }
    this.invalidate()
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
    this.outputTexts = outputTexts
    if (before !== after) {
      this.scene = this.sceneWithBodyRegions(this.baseScene)
      this.refreshTypeAdornments()
      for (const listener of this.sceneReplacedListeners) listener(this.scene)
    }
    this.invalidate()
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
    this.scopeHighlight = scope
    this.invalidate()
  }

  getScopeHighlight(): ScopeHighlight | undefined {
    return this.scopeHighlight
  }

  /** Compiler-derived lazy-selector cones; membership only, never topology. */
  setInactiveNodes(nodes: ReadonlySet<string> | undefined): void {
    this.inactiveNodes = nodes
    this.invalidate()
  }

  getInactiveNodes(): ReadonlySet<string> | undefined {
    return this.inactiveNodes
  }

  private selectorResolutions: ReadonlyMap<string, string> | undefined

  /**
   * Execution-recorded selector choices (selector id -> candidate id) for
   * the displayed graph: what a frozen/execution view shows as the branch
   * that ACTUALLY ran. Overlay only - the document's policy is untouched; a
   * random selector renders its recorded roll instead of '?'.
   */
  setSelectorResolutions(resolutions: ReadonlyMap<string, string> | undefined): void {
    this.selectorResolutions = resolutions
    this.invalidate()
  }

  getSelectorResolutions(): ReadonlyMap<string, string> | undefined {
    return this.selectorResolutions
  }

  /** One link end's out-of-scope verdict under the active scope highlight. */
  private endOutOfScope(end: SceneLinkEnd): boolean {
    const s = this.scopeHighlight
    switch (end.kind) {
      case 'port':
        return this.inactiveNodes?.has(end.node) === true || (s !== undefined && !s.nodes.has(end.node))
      case 'reroute':
        return s !== undefined && !s.reroutes.has(end.reroute)
      case 'valueSource':
        return s !== undefined && !s.valueSources.has(end.valueSource)
      case 'widgetTap':
        return this.inactiveNodes?.has(end.node) === true || (s !== undefined && !s.nodes.has(end.node))
      case 'selector':
        return s !== undefined && (end.candidate !== undefined
          ? !s.selectorCandidates.has(selectorCandidateKey(end.selector, end.candidate))
          : !s.selectors.has(end.selector))
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
    this.viewport = viewport
    this.invalidate()
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

  invalidate(): void {
    this.dirty = true
    this.scheduleFrame()
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
  fitToScene(margin = 60): void {
    const bounds = sceneVisualBounds(this.scene, this.previews, this.badges)
    if (!bounds) return
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w <= 0 || h <= 0) return
    const spanX = Math.max(1, bounds.maxX - bounds.minX)
    const spanY = Math.max(1, bounds.maxY - bounds.minY)
    const scale = Math.min(2, Math.max(0.1, Math.min((w - margin * 2) / spanX, (h - margin * 2) / spanY)))
    this.setViewport({
      x: (w - spanX * scale) / 2 - bounds.minX * scale,
      y: (h - spanY * scale) / 2 - bounds.minY * scale,
      scale,
    })
  }

  dispose(): void {
    this.disposed = true
    if (this.rafId !== undefined) cancelAnimationFrame(this.rafId)
    this.rafId = undefined
    this.sceneReplacedListeners.clear()
    this.viewportListeners.clear()
  }

  private scheduleFrame(): void {
    if (this.disposed || this.rafId !== undefined) return
    this.rafId = requestAnimationFrame(this.loop)
  }

  private loop(timestamp: number): void {
    if (this.disposed) return
    this.rafId = undefined
    const animateExecution = this.hasRunningNodes && !this.reducedMotion
    if (animateExecution) {
      this.animationTimeMs = timestamp
      this.dirty = true
    }
    if (this.dirty) {
      this.dirty = false
      this.render()
    }
    if (this.dirty || animateExecution) this.scheduleFrame()
  }

  private render(): void {
    const ctx = this.canvas.getContext('2d')
    if (!ctx) return
    this.connectedInputPins = new Set(
      [
        ...this.scene.links
          .filter((link) => link.to.kind === 'port')
          .map((link) => {
          const to = link.to as Extract<SceneLinkEnd, { kind: 'port' }>
          return `${to.node}\u0000${portEndKey(to)}`
        }),
        ...this.scene.netStubs
          .filter((stub) => stub.role === 'sink')
          .map((stub) => `${stub.nodeId}\u0000${portEndKey({
            port: stub.portId,
            ...(stub.members === undefined ? {} : { members: stub.members }),
          })}`),
      ],
    )
    this.connectedOutputPins = new Set(
      [
        ...this.scene.links
          .filter((link) => link.from.kind === 'port' || link.from.kind === 'widgetTap')
          .map((link) => {
          const from = link.from as Extract<SceneLinkEnd, { kind: 'port' | 'widgetTap' }>
          return from.kind === 'port'
            ? `${from.node}\u0000${portEndKey(from)}`
            : `${from.node}\u0000${from.input}`
        }),
        ...this.scene.netStubs
          .filter((stub) => stub.role === 'source')
          .map((stub) => `${stub.nodeId}\u0000${portEndKey({
            port: stub.portId,
            ...(stub.members === undefined ? {} : { members: stub.members }),
          })}`),
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
    // Boundary bindings are excluded here: a bound SELECTOR row stays the
    // occurrence-local editor (edits route to the owning instance), so it
    // must not paint inert. Pins keep using the full set - visually the
    // binding IS a connection.
    this.valueDrivenInputPins = new Set(
      this.scene.links
        .filter((link) => link.boundary !== true && link.to.kind === 'port')
        .map((link) => {
          const to = link.to as Extract<SceneLinkEnd, { kind: 'port' }>
          return `${to.node}\u0000${portEndKey(to)}`
        }),
    )
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

    const { x: vx, y: vy, scale } = this.viewport
    ctx.translate(vx, vy)
    ctx.scale(scale, scale)
    const detailLevel = this.getDetailLevel()
    const contentDetail = detailLevel !== 'overview'
    const paintPad = linkCullPad(scale)
    const rerouteRadius = detailRadius(REROUTE_RADIUS, scale, detailLevel)
    const structurePad = structureCullPad(scale, t.pinRadius, detailLevel)

    // Visible world rect for culling.
    const view = { x: -vx / scale, y: -vy / scale, w: w / scale, h: h / scale }
    if (this.gridVisible) this.drawGrid(ctx, view, scale)

    const offsets = this.overlay.dragOffsets
    const off = (nodeId: string) => offsets?.get(nodeId) ?? ZERO_OFFSET

    // Groups draw first: rectangles UNDER links and nodes.
    for (const group of this.scene.groups) {
      const gOff = this.overlay.groupDragOffset
      const selectedOff = off(group.id)
      const gx = group.x + selectedOff.dx + (gOff?.groupId === group.id ? gOff.dx : 0)
      const gy = group.y + selectedOff.dy + (gOff?.groupId === group.id ? gOff.dy : 0)
      const selected = this.overlay.groupSelection?.has(group.id) === true
      const groupStroke = screenAwareStroke(selected ? 2 : 1, scale, selected ? 2 : 1)
      const groupPad = (selected ? 2 : 0) + groupStroke / 2 + 1 / finiteScale(scale)
      if (gx + group.width + groupPad < view.x || gx - groupPad > view.x + view.w ||
        gy + group.height + groupPad < view.y || gy - groupPad > view.y + view.h) {
        continue
      }
      this.drawGroup(ctx, group, gx, gy, detailLevel)
      if (selected) {
        ctx.save()
        ctx.strokeStyle = this.tokens.colors.nodeSelectedBorder
        ctx.lineWidth = groupStroke
        ctx.setLineDash(screenAwareDash([6, 4], [4, 3], scale))
        ctx.strokeRect(gx - 2, gy - 2, group.width + 4, group.height + 4)
        ctx.restore()
      }
    }

    const batchedOverviewLinks = new Set<string>()
    if (detailLevel === 'overview' && this.scene.links.length >= 256 && offsets === undefined &&
        this.overlay.resizePreview === undefined && this.scopeHighlight === undefined && this.inactiveNodes === undefined) {
      const batches = new Map<string | undefined, Array<readonly [number, number, number, number]>>()
      for (const link of this.scene.links) {
        if (link.hidden === true || this.overlay.hiddenLinkIds?.has(link.id) === true ||
            this.overlay.linkSelection?.has(link.id) === true || link.maybeAbsent === true || link.mismatch === true) continue
        const bounds = linkBounds(link.x1, link.y1, link.x2, link.y2)
        if (bounds.maxX + paintPad < view.x || bounds.minX - paintPad > view.x + view.w ||
            bounds.maxY + paintPad < view.y || bounds.minY - paintPad > view.y + view.h) continue
        const batch = batches.get(link.typeName) ?? []
        batch.push([link.x1, link.y1, link.x2, link.y2])
        batches.set(link.typeName, batch)
        batchedOverviewLinks.add(link.id)
      }
      ctx.lineWidth = screenAwareStroke(2.5, scale, 1)
      for (const [typeName, batch] of batches) {
        ctx.strokeStyle = typeName === undefined
          ? t.colors.linkDefault
          : presentedType(t, { kind: 'concrete', name: typeName }).color
        ctx.beginPath()
        for (const [x1, y1, x2, y2] of batch) this.appendLinkPath(ctx, x1, y1, x2, y2)
        ctx.stroke()
      }
    }

    for (const link of this.scene.links) {
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
      // reroute ends by reroute, selector ends by selector/branch - so an
      // unchosen candidate's whole feed chain dims while the chosen branch
      // stays lit. Boundary pseudo-ends never dim a segment on their own.
      const outOfScope =
        (this.scopeHighlight !== undefined || this.inactiveNodes !== undefined) &&
        (this.endOutOfScope(link.from) || this.endOutOfScope(link.to))
      if (outOfScope) ctx.globalAlpha = SCOPE_DIM
      if (this.overlay.linkSelection?.has(link.id)) {
        this.drawLink(ctx, x1, y1, x2, y2, link.typeName, {
          color: this.tokens.colors.nodeSelectedBorder,
          width: 5.5,
          minScreenWidth: 2,
        })
      }
      // Maybe-absent (optional producer) links dash long-and-slow: a calm
      // "this value might legitimately not exist" cue, deliberately distinct
      // from the short [6,4] ghost-drag dash and from any error styling.
      if (link.maybeAbsent === true) ctx.setLineDash(screenAwareDash([9, 5], [5, 3], scale))
      // A PROVEN type conflict paints the noodle in error red, overriding
      // the type color: the break must be visible where it is, not hunted
      // down from a Problems entry. Slightly wider so red never hides
      // between densely packed ok noodles.
      if (link.mismatch === true) {
        this.drawLink(ctx, x1, y1, x2, y2, link.typeName, {
          color: this.tokens.colors.error,
          width: 3,
          minScreenWidth: 1.5,
        })
      } else {
        this.drawLink(ctx, x1, y1, x2, y2, link.typeName)
      }
      if (link.maybeAbsent === true) ctx.setLineDash([])
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
        ctx.arc(mx, my, midpointHovered ? 5 : 3.5, 0, Math.PI * 2)
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
        ctx.lineWidth = midpointHovered ? 1.5 : 1
        ctx.stroke()
      }
      // Net noodles carry their name at the midpoint (legible from ~50% zoom).
      if (link.netName !== undefined && contentDetail) {
        ctx.font = `${t.fontSize}px ${t.fontFamily}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle = t.colors.label
        ctx.fillText(link.netName, (x1 + x2) / 2, (y1 + y2) / 2 - 3)
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
        const pad = Math.max(rerouteRadius + 6, statusRingCullPad(rerouteRadius, scale))
        if (reroute.x + pad < view.x || reroute.x - pad > view.x + view.w ||
            reroute.y + pad < view.y || reroute.y - pad > view.y + view.h) continue
        const batch = batches.get(reroute.typeName) ?? []
        batch.push([reroute.x, reroute.y])
        batches.set(reroute.typeName, batch)
        batchedOverviewReroutes.add(reroute.id)
      }
      ctx.lineWidth = screenAwareStroke(1, scale, 1)
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
        ? REROUTE_SOCKET_OFFSET + REROUTE_SOCKET_RADIUS + 6
        : Math.max(rerouteRadius + 6, statusRingCullPad(rerouteRadius, scale))
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
        ctx.arc(rx, ry, rerouteRadius + 3, 0, Math.PI * 2)
        ctx.fillStyle = t.colors.nodeSelectedBorder
        ctx.fill()
      }
      ctx.beginPath()
      ctx.arc(rx, ry, rerouteRadius, 0, Math.PI * 2)
      const dotColor = r.typeName ? presentedType(t, { kind: 'concrete', name: r.typeName }).color : t.colors.linkDefault
      ctx.fillStyle = dotColor
      ctx.fill()
      ctx.strokeStyle = t.colors.canvasBackground
      ctx.lineWidth = screenAwareStroke(1, scale, 1)
      ctx.stroke()
      // Hover reveals ghost sockets: a hollow input socket left of the dot
      // and output socket right of it, each on a short stem. They advertise
      // the drag-a-link affordance ComfyUI users expect, replacing the
      // undiscoverable Alt+drag as the visible path to new connections.
      if (contentDetail && this.overlay.hoveredReroute === r.id) {
        for (const dir of [-1, 1]) {
          const sx = rx + dir * REROUTE_SOCKET_OFFSET
          ctx.strokeStyle = dotColor
          ctx.lineWidth = 2
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
      const minY = Math.min(sy, py - 1)
      const maxY = Math.max(sy + stub.height, py + 1)
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
        ? screenAwareStroke(3, scale, 1.5)
        : screenAwareStroke(2, scale, 1)
      ctx.beginPath()
      ctx.moveTo(px, py)
      ctx.lineTo(stub.role === 'source' ? sx : sx + stub.width, sy + stub.height / 2)
      ctx.stroke()
      // Tag body.
      ctx.fillStyle = t.colors.widgetBackground
      ctx.strokeStyle = color
      ctx.lineWidth = stub.mismatch === true
        ? screenAwareStroke(2, scale, 1.5)
        : screenAwareStroke(1, scale, 1)
      ctx.beginPath()
      ctx.roundRect(sx, sy, stub.width, stub.height, stub.height / 2)
      ctx.fill()
      ctx.stroke()
      if (this.overlay.netViewSelection?.has(stub.id)) {
        ctx.beginPath()
        ctx.roundRect(sx - 3, sy - 3, stub.width + 6, stub.height + 6, stub.height / 2 + 3)
        ctx.strokeStyle = t.colors.nodeSelectedBorder
        ctx.lineWidth = 2 / this.viewport.scale
        ctx.stroke()
      }
      ctx.font = `${t.fontSize}px ${t.fontFamily}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = t.colors.label
      if (contentDetail) {
        ctx.fillText(`${stub.role === 'source' ? 'Set' : 'Get'} ${stub.name}`, sx + stub.width / 2, sy + stub.height / 2 + 0.5)
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
      ctx.setLineDash(screenAwareDash([7, 5], [7, 5], scale))
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
        ctx.lineWidth = screenAwareStroke(4.5, scale, 3)
        trace()
        ctx.strokeStyle = source.color
        ctx.lineWidth = screenAwareStroke(2.5, scale, 1.5)
        trace()
      }
      ctx.restore()
    }

    for (const sceneNode of this.scene.nodes) {
      const node = this.nodeForPaint(sceneNode)
      const o = off(node.id)
      // Pad culling by the pin overhang plus target/warn halo rings: pins
      // protrude past the body rect, and clipping them at the view edge
      // makes connections silently vanish while their node is half-visible.
      if (
        node.x + o.dx + node.layout.width + structurePad < view.x ||
        node.x + o.dx - structurePad > view.x + view.w ||
        node.y + o.dy + node.layout.height + structurePad < view.y ||
        node.y + o.dy - structurePad > view.y + view.h
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

    // Value source pills: same band as nodes (they produce into the same
    // noodle layer), drawn after so a compact pill is never buried.
    for (const vs of this.scene.valueSources) {
      const o = off(vs.id)
      const vx = vs.x + o.dx
      const vy = vs.y + o.dy
      if (
        vx + vs.width + structurePad < view.x ||
        vx - structurePad > view.x + view.w ||
        vy + vs.height + structurePad < view.y ||
        vy - structurePad > view.y + view.h
      ) {
        continue
      }
      if (this.scopeHighlight && !this.scopeHighlight.valueSources.has(vs.id)) ctx.globalAlpha = SCOPE_DIM
      this.drawValueSource(ctx, vs, vx, vy, detailLevel)
      ctx.globalAlpha = 1
    }

    // Selectors: compact node-like boxes in the same band as nodes/value
    // sources (their pins anchor real noodles), drawn after so they are
    // never buried.
    for (const sel of this.scene.selectors) {
      const o = off(sel.id)
      const sx = sel.x + o.dx
      const sy = sel.y + o.dy
      if (
        sx + sel.width + structurePad < view.x ||
        sx - structurePad > view.x + view.w ||
        sy + sel.height + structurePad < view.y ||
        sy - structurePad > view.y + view.h
      ) {
        continue
      }
      if (this.scopeHighlight && !this.scopeHighlight.selectors.has(sel.id)) ctx.globalAlpha = SCOPE_DIM
      this.drawSelector(ctx, sel, sx, sy, detailLevel)
      ctx.globalAlpha = 1
    }

    // One enclosure makes a heterogeneous selection read as a group before
    // the drag begins; individual halos still preserve exact membership.
    const union = this.selectionUnionOutlineRect()
    if (union) {
      ctx.beginPath()
      ctx.setLineDash(screenAwareDash([5, 4], [4, 3], scale))
      ctx.strokeStyle = t.colors.nodeSelectedBorder
      ctx.lineWidth = MULTI_SELECTION_OUTLINE_STROKE_WIDTH / this.viewport.scale
      ctx.strokeRect(union.x, union.y, union.width, union.height)
      ctx.setLineDash([])
    }

    if (this.overlay.ghostLink) {
      const g = this.overlay.ghostLink
      ctx.save()
      ctx.setLineDash(screenAwareDash([6, 4], [4, 3], scale))
      this.drawLink(ctx, g.x1, g.y1, g.x2, g.y2, g.typeName)
      ctx.restore()
    }

    if (this.overlay.ghostLinks) {
      ctx.save()
      ctx.setLineDash(screenAwareDash([6, 4], [4, 3], scale))
      for (const g of this.overlay.ghostLinks) {
        this.drawLink(ctx, g.x1, g.y1, g.x2, g.y2, g.typeName)
      }
      ctx.restore()
    }

    if (this.overlay.marquee) {
      const m = this.overlay.marquee
      ctx.save()
      ctx.fillStyle = this.tokens.colors.selection
      ctx.globalAlpha = 0.08
      ctx.fillRect(m.x1, m.y1, m.x2 - m.x1, m.y2 - m.y1)
      ctx.globalAlpha = 1
      ctx.setLineDash(screenAwareDash([4, 3], [3, 2], scale))
      ctx.strokeStyle = this.tokens.colors.selection
      ctx.lineWidth = screenAwareStroke(1, scale, 1)
      ctx.strokeRect(m.x1, m.y1, m.x2 - m.x1, m.y2 - m.y1)
      ctx.restore()
    }

    if (this.overlay.groupResizeGhost) {
      const g = this.overlay.groupResizeGhost
      const group = this.scene.groups.find((sg) => sg.id === g.groupId)
      if (group) {
        ctx.save()
        ctx.setLineDash(screenAwareDash([6, 4], [4, 3], scale))
        ctx.strokeStyle = this.tokens.colors.selection
        ctx.lineWidth = screenAwareStroke(1.5, scale, 1.5)
        ctx.beginPath()
        ctx.roundRect(g.x, g.y, g.width, g.height, this.tokens.cornerRadius)
        ctx.stroke()
        ctx.restore()
      }
    }

    if (this.overlay.placementGhost) {
      const g = this.overlay.placementGhost
      ctx.save()
      ctx.globalAlpha = 0.6
      ctx.fillStyle = this.tokens.colors.nodeBody
      ctx.strokeStyle = this.tokens.colors.selection
      ctx.lineWidth = screenAwareStroke(1.5, scale, 1.5)
      ctx.beginPath()
      ctx.roundRect(g.x, g.y, g.width, g.height, this.tokens.cornerRadius)
      ctx.fill()
      ctx.stroke()
      ctx.fillStyle = this.tokens.colors.nodeHeader
      ctx.beginPath()
      ctx.roundRect(g.x, g.y, g.width, this.tokens.headerHeight, [this.tokens.cornerRadius, this.tokens.cornerRadius, 0, 0])
      ctx.fill()
      ctx.fillStyle = this.tokens.colors.title
      ctx.font = `600 ${this.tokens.titleFontSize}px ${this.tokens.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.save()
      ctx.beginPath()
      ctx.rect(g.x + this.tokens.padX, g.y, g.width - this.tokens.padX * 2, this.tokens.headerHeight)
      ctx.clip()
      ctx.fillText(g.title, g.x + this.tokens.padX, g.y + this.tokens.headerHeight / 2)
      ctx.restore()
      ctx.restore()
    }
    const tl = this.getToolboxLayout()
    if (tl) this.drawToolbox(ctx, tl)

    this.drawTypeAdornments(ctx, view)

    this.drawPresence(ctx, scale)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
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
        : Math.max(8, this.tokens.fontSize - 2)
      ctx.font = `600 ${fontSize}px ${this.tokens.fontFamily}`
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
                ? { x: node.x + (origin.side === 'out' ? node.layout.width : 0), y: node.y + pin.y }
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
          ctx.lineWidth = 2.5
          ctx.globalAlpha = 0.55
          ctx.setLineDash([6, 4])
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
              width: 2.5,
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
        ctx.lineWidth = 1.5
        ctx.globalAlpha = 0.55
        ctx.setLineDash([6, 4])
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
          ctx.lineWidth = 1
          ctx.globalAlpha = 0.5
          ctx.beginPath()
          ctx.roundRect(
            node.x + (o?.dx ?? 0) - 4, node.y + (o?.dy ?? 0) - 4,
            node.layout.width + 8, node.layout.height + 8, t.cornerRadius + 4,
          )
          ctx.stroke()
          ctx.restore()
        }
      }
      if (actor.selection.size === 0 && (actor.rerouteSelection?.size ?? 0) === 0) continue
      ctx.save()
      ctx.strokeStyle = actor.color
      ctx.lineWidth = 2
      ctx.globalAlpha = 0.9
      for (const node of this.scene.nodes) {
        if (!actor.selection.has(node.id)) continue
        // Ride the actor's OWN drag offsets when it is mid-drag (peers see
        // the ring travel with the ghost), else local drag offsets so the
        // ring tracks a node WE are dragging.
        const o = actor.drag?.get(node.id) ?? this.overlay.dragOffsets?.get(node.id)
        const nx = node.x + (o?.dx ?? 0)
        const ny = node.y + (o?.dy ?? 0)
        ctx.beginPath()
        ctx.roundRect(nx - 7, ny - 7, node.layout.width + 14, node.layout.height + 14, t.cornerRadius + 7)
        ctx.stroke()
      }
      for (const reroute of this.scene.reroutes) {
        if (!actor.rerouteSelection?.has(reroute.id)) continue
        const o = actor.drag?.get(reroute.id) ?? this.overlay.dragOffsets?.get(reroute.id)
        const rank = rerouteHaloRanks.get(reroute.id)?.get(actor.id) ?? 0
        ctx.beginPath()
        ctx.arc(
          reroute.x + (o?.dx ?? 0), reroute.y + (o?.dy ?? 0),
          REROUTE_RADIUS + 6 + rank * 3, 0, Math.PI * 2,
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
      ctx.lineTo(0, 16)
      ctx.lineTo(4.6, 12.2)
      ctx.lineTo(11, 11)
      ctx.closePath()
      ctx.fillStyle = actor.color
      ctx.strokeStyle = t.colors.canvasBackground
      ctx.lineWidth = 1.25
      ctx.fill()
      ctx.stroke()
      // Label pill anchored to the pointer tail.
      ctx.font = `600 ${t.fontSize}px ${t.fontFamily}`
      const label = actor.label
      const tw = ctx.measureText(label).width
      const px = 12
      const py = 18
      const padX = 5
      const h = t.fontSize + 7
      ctx.beginPath()
      ctx.roundRect(px, py, tw + padX * 2, h, h / 2)
      ctx.fillStyle = actor.color
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, px + padX, py + h / 2 + 0.5)
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
    const radius = 8 / scale
    const inner = top && bottom ? Math.min(3 / scale, (bottom.y - top.y) / 2) : 0
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
    ctx.lineWidth = 1 / scale
    ctx.stroke()
    // The context is camera-scaled, so font size must return to world units
    // just like the toolbox geometry to remain stable in screen pixels.
    ctx.font = `600 ${t.fontSize / scale}px ${t.fontFamily}`
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
      if (r.button.disabled === true) ctx.globalAlpha = 0.4
      ctx.beginPath()
      ctx.roundRect(r.x, r.y, r.size, r.size, 5 / scale)
      ctx.fillStyle = active ? t.colors.selection : t.colors.widgetBackground
      ctx.fill()
      const glyphColor = r.button.iconColor ?? (active ? t.colors.canvasBackground : t.colors.label)
      if (r.button.icon) {
        paintToolboxIcon(ctx, r.button.icon, r.x, r.y, r.size, glyphColor)
      } else if (r.button.glyph) {
        ctx.fillStyle = glyphColor
        ctx.fillText(r.button.glyph, r.x + r.size / 2, r.y + r.size / 2 + 0.5)
      }
      ctx.restore()
    }
    ctx.restore()
  }

  /**
   * Sparse world-anchored reference grid. Spacing grows geometrically when
   * zoomed out, bounding both visual density and arc count to screen area
   * rather than the potentially enormous visible world rectangle.
   */
  private drawGrid(
    ctx: CanvasRenderingContext2D,
    view: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
    scale: number,
  ): void {
    let spacing = 32
    while (spacing * scale < 12) spacing *= 2
    const minX = Math.floor(view.x / spacing) * spacing
    const minY = Math.floor(view.y / spacing) * spacing
    const maxX = view.x + view.w
    const maxY = view.y + view.h
    ctx.beginPath()
    for (let y = minY; y <= maxY; y += spacing) {
      for (let x = minX; x <= maxX; x += spacing) {
        ctx.moveTo(x + 1.5, y)
        ctx.arc(x, y, 1.5, 0, Math.PI * 2)
      }
    }
    ctx.fillStyle = this.tokens.colors.gridDot
    ctx.fill()
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
    ctx.globalAlpha = 0.14
    ctx.fillStyle = color
    ctx.fill()
    // Title band (the drag handle).
    ctx.beginPath()
    ctx.roundRect(x, y, group.width, GROUP_HEADER_HEIGHT, [t.cornerRadius, t.cornerRadius, 0, 0])
    ctx.globalAlpha = 0.45
    ctx.fill()
    // Border.
    ctx.globalAlpha = 0.8
    ctx.beginPath()
    ctx.roundRect(x, y, group.width, group.height, t.cornerRadius)
    ctx.strokeStyle = color
    ctx.lineWidth = screenAwareStroke(1, this.viewport.scale, 1)
    ctx.stroke()
    // Title.
    if (detailLevel !== 'overview') {
      ctx.globalAlpha = 1
      ctx.fillStyle = t.colors.title
      ctx.font = `600 ${t.titleFontSize}px ${t.fontFamily}`
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
    ctx.lineWidth = screenAwareStroke(style?.width ?? 2.5, this.viewport.scale, style?.minScreenWidth ?? 1)
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
    const preview = this.overlay.resizePreview
    if (preview === undefined || (end.kind !== 'port' && end.kind !== 'widgetTap') || end.node !== preview.nodeId) {
      return { x: fallbackX, y: fallbackY }
    }
    const sceneNode = this.scene.nodes.find((candidate) => candidate.id === end.node)
    const node = sceneNode === undefined ? undefined : this.nodeForPaint(sceneNode)
    const pin = end.kind === 'widgetTap'
      ? node?.layout.pins.find((candidate) => candidate.widgetTap === true && candidate.address.port === end.input)
      : node?.layout.pins.find((candidate) =>
          candidate.direction === direction && candidate.portId === portEndKey(end) && candidate.widgetTap !== true,
        )
    if (pin === undefined) return { x: fallbackX, y: fallbackY }
    return {
      x: preview.x + (direction === 'out' ? preview.width : 0),
      y: preview.y + pin.y,
    }
  }

  /** Paint-only projection for an in-flight resize; scene and hit geometry stay committed. */
  private nodeForPaint(node: SceneNode): SceneNode {
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

  private drawNode(
    ctx: CanvasRenderingContext2D,
    sceneNode: SceneNode,
    detailLevel: CanvasDetailLevel,
    dx = 0,
    dy = 0,
  ): void {
    const t = this.tokens
    const l: NodeLayout = sceneNode.layout
    const progress = this.nodeStates[sceneNode.id]
    // Local alias with the drag offset applied; everything below reads node.x/y.
    const node = dx === 0 && dy === 0 ? sceneNode : { ...sceneNode, x: sceneNode.x + dx, y: sceneNode.y + dy }
    const selected = this.overlay.selection?.has(node.id) ?? false
    const unrecognized = node.unrecognized === true || node.missingSchema === true
    const scale = this.viewport.scale
    const contentDetail = detailLevel !== 'overview'
    const pinRadius = detailRadius(t.pinRadius, scale, detailLevel)
    const selectionStrokeWidth = screenAwareStroke(SELECTION_OUTLINE_STROKE_WIDTH, scale, 2)

    if (this.overlay.bodyDropNode === node.id) {
      ctx.beginPath()
      ctx.roundRect(node.x - 2, node.y - 2, l.width + 4, l.height + 4, t.cornerRadius + 2)
      ctx.strokeStyle = t.colors.dropTarget
      ctx.globalAlpha = 0.65
      ctx.lineWidth = screenAwareStroke(1.5, scale, 1.5)
      ctx.stroke()
      ctx.globalAlpha = 1
    }

    // Partial-queue preview uses the live-affordance accent, deliberately
    // distinct from both the white selection halo and muted-node dimming.
    if (this.scopeHighlight?.nodes.has(node.id)) {
      ctx.beginPath()
      ctx.roundRect(node.x - 5, node.y - 5, l.width + 10, l.height + 10, t.cornerRadius + 5)
      ctx.strokeStyle = t.colors.selection
      ctx.lineWidth = screenAwareStroke(2.5, scale, 2)
      ctx.stroke()
    }

    // Semantic mode, view concern here only: MUTE and BYPASS both dim the
    // node; BYPASS additionally gets a purple wash (ComfyUI's convention),
    // so the two modes remain distinguishable.
    // Out-of-scope nodes dim during a partial-execution preview.
    const mode = node.node.mode ?? 'active'
    let alpha = mode === 'muted' || mode === 'bypassed' ? 0.45 : 1
    if ((this.scopeHighlight && !this.scopeHighlight.nodes.has(node.id)) || this.inactiveNodes?.has(node.id)) alpha *= SCOPE_DIM
    ctx.globalAlpha = alpha

    // Body/header colors are pre-mixed into one opaque color so mode alpha is
    // applied exactly once. Unrecognized paint outranks identity color.
    ctx.beginPath()
    ctx.roundRect(node.x, node.y, l.width, l.height, t.cornerRadius)
    ctx.fillStyle = unrecognized
      ? tintHex(t.colors.nodeBody, t.colors.error, 0.2)
      : node.color === undefined ? t.colors.nodeBody : tintHex(t.colors.nodeBody, node.color, 0.18)
    ctx.fill()
    // Header.
    ctx.beginPath()
    ctx.roundRect(node.x, node.y, l.width, l.headerHeight, [t.cornerRadius, t.cornerRadius, 0, 0])
    ctx.fillStyle = unrecognized
      ? tintHex(t.colors.nodeHeader, t.colors.error, 0.35)
      : node.color === undefined ? t.colors.nodeHeader : tintHex(t.colors.nodeHeader, node.color, 0.72)
    ctx.fill()
    // Bypass wash: over body+header, under text, so content stays legible.
    if (mode === 'bypassed') {
      ctx.beginPath()
      ctx.roundRect(node.x, node.y, l.width, l.height, t.cornerRadius)
      ctx.fillStyle = t.colors.bypassWash
      ctx.fill()
    }
    // State/problem border. Problem kinds come from the same host-derived
    // badge layer used below; the renderer only chooses paint precedence.
    // Running stays visible over a blocking warning, while document errors
    // and runtime errors remain stronger execution-stopping signals.
    const badges = this.badges[node.id] ?? []
    const hasDocumentError = badges.some((badge) => badge.id === PROBLEM_ERROR_BADGE.id)
    const hasBlockingWarning = badges.some((badge) => badge.id === PROBLEM_BLOCKING_WARNING_BADGE.id)
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
            : hasBlockingWarning
              ? t.colors.blockingWarning
              : progress
                ? t.stateColors[progress.state]
                : t.colors.nodeOutline
    const strongOutline = unrecognized || runtimeError || hasDocumentError || running || hasBlockingWarning || progress?.state === 'done'
    const outlineWidth = unrecognized ? 1.25 * 3 : strongOutline ? 2.5 : 1.25
    const outlineDash = unrecognized || runtimeError || hasDocumentError
      ? nodeStateDash('error', scale)
      : running
        ? undefined
        : hasBlockingWarning
          ? screenAwareDash([1, 3], [1, 3], scale)
          : nodeStateDash(progress?.state, scale)
    const outlineOwnsDash = unrecognized || runtimeError || hasDocumentError || running || hasBlockingWarning || progress !== undefined
    const dash = outlineOwnsDash ? outlineDash : modeDash(mode, scale)
    if (running) this.drawRunningGlow(ctx, node.x, node.y, l.width, l.height)
    if (dash !== undefined) ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.roundRect(node.x, node.y, l.width, l.height, t.cornerRadius)
    ctx.strokeStyle = outlineColor
    ctx.lineWidth = screenAwareStroke(outlineWidth, scale, strongOutline || unrecognized ? 2 : 1)
    ctx.stroke()
    if (dash !== undefined) ctx.setLineDash([])
    if (running && !this.reducedMotion) this.drawRunningAccent(ctx, node.x, node.y, l.width, l.height)
    if (node.regionKind !== undefined) {
      ctx.beginPath()
      ctx.roundRect(node.x + 3, node.y + 3, l.width - 6, l.height - 6, Math.max(0, t.cornerRadius - 3))
      ctx.strokeStyle = outlineColor
      ctx.lineWidth = screenAwareStroke(1, scale, 1)
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

    // Text and chips are omitted in the overview tier; structural state and
    // typed connectivity remain visible without paying per-node text cost.
    if (contentDetail) {
      // Title (truncated only for badges that occupy the header lane).
      ctx.fillStyle = t.colors.title
      ctx.font = `${l.titleRenamed ? 'italic ' : ''}600 ${t.titleFontSize}px ${t.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const headerBadgeLefts = badges
        .map((badge, index) => badge.placement !== undefined ? undefined : badgeRect(node, index, badges).x)
        .filter((x): x is number => x !== undefined)
      const badgeLeft = headerBadgeLefts.length > 0
        ? Math.min(...headerBadgeLefts)
        : node.x + l.width - t.padX
      let titleX = node.x + t.padX
      if (node.regionKind !== undefined) {
        const glyphX = titleX + 6
        const glyphY = node.y + l.headerHeight / 2
        ctx.beginPath()
        ctx.arc(glyphX, glyphY, 5, Math.PI * 0.25, Math.PI * 1.8)
        ctx.strokeStyle = t.colors.title
        ctx.lineWidth = 1.4
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(glyphX + 5, glyphY - 2)
        ctx.lineTo(glyphX + 7, glyphY + 2)
        ctx.lineTo(glyphX + 2, glyphY + 1)
        ctx.fillStyle = t.colors.title
        ctx.fill()
        ctx.font = `600 ${Math.max(9, t.titleFontSize - 2)}px ${t.fontFamily}`
        ctx.fillText(node.regionKind, titleX + 16, glyphY)
        titleX += 16 + ctx.measureText(node.regionKind).width + 8
        ctx.font = `${l.titleRenamed ? 'italic ' : ''}600 ${t.titleFontSize}px ${t.fontFamily}`
      }
      ctx.fillText(l.title, titleX, node.y + l.headerHeight / 2, Math.max(0, badgeLeft - titleX - 4))

      // Node badges; each placement lane lays out index 0 rightmost.
      // Positions come from badgeRect so hit-testing and drawing agree.
      for (const [index, badge] of badges.entries()) {
        const r = badgeRect(node, index, badges)
        const nodeAlpha = ctx.globalAlpha
        if (badge.placement !== undefined) ctx.globalAlpha = 1
        // Core blocking warnings share the active theme token with their node
        // outline. Extension badge colors remain badge-owned plain data.
        ctx.fillStyle = badge.id === PROBLEM_BLOCKING_WARNING_BADGE.id
          ? t.colors.blockingWarning
          : badge.id === 'core.mode.muted'
            ? t.colors.mutedBadge
            : badge.id === 'core.mode.bypassed'
              ? t.colors.bypassedBadge
              : badge.color
        ctx.beginPath()
        ctx.roundRect(r.x, r.y, r.width, r.height, badge.placement === 'above' ? [3, 3, 0, 0] : badge.placement === 'below' ? [0, 0, 3, 3] : 3)
        ctx.fill()
        let badgeIconPainted = false
        if (badge.icon !== undefined) {
          const iconSize = Math.min(BADGE_SIZE, r.height)
          try {
            paintToolboxIcon(ctx, badge.icon, r.x + 1, r.y, iconSize, t.colors.title)
            badgeIconPainted = true
            if (badge.variant !== 'label') {
              ctx.globalAlpha = nodeAlpha
              continue
            }
          } catch {
            ctx.restore()
          }
        }
        ctx.fillStyle = t.colors.title
        ctx.font = `600 9px ${t.fontFamily}`
        ctx.textAlign = 'center'
        const textCenter = r.x + r.width / 2 + (badgeIconPainted ? 5 : 0)
        ctx.fillText(badgeIconPainted ? badge.glyph : (badge.fallbackGlyph ?? badge.glyph), textCenter, r.y + r.height / 2 + 0.5)
        ctx.textAlign = 'left'
        ctx.globalAlpha = nodeAlpha
      }
    }

    // Progress bar just under the header while running. Injected values are
    // external data: a non-finite or negative value must not mint a NaN or
    // reverse-width fill.
    if (progress?.state === 'running' && progress.value !== undefined && Number.isFinite(progress.value)) {
      const progressHeight = detailLevel === 'overview'
        ? Math.min(l.headerHeight, screenAwareStroke(3, scale, 1.5))
        : 3
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
      if (l.advancedGroup !== undefined) {
        const group = l.advancedGroup
        const groupY = node.y + group.y
        ctx.fillStyle = 'rgba(255, 255, 255, 0.035)'
        ctx.fillRect(node.x, groupY, l.width, group.height)
        ctx.strokeStyle = t.colors.nodeOutline
        ctx.lineWidth = 1
        ctx.strokeRect(node.x + 0.5, groupY + 0.5, l.width - 1, group.height - 1)
      }
      for (const row of l.rows) {
        const rowY = node.y + row.y
        if (row.kind === 'section') {
          // Header strip + disclosure triangle; click toggles collapse.
          ctx.fillStyle = t.colors.widgetBackground
          ctx.fillRect(node.x + 1, rowY + 2, l.width - 2, row.height - 4)
          const cx = node.x + t.padX + 4
          const cy = rowY + row.height / 2
          ctx.fillStyle = t.colors.label
          ctx.beginPath()
          if (row.collapsed) {
            ctx.moveTo(cx - 2.5, cy - 4)
            ctx.lineTo(cx + 3.5, cy)
            ctx.lineTo(cx - 2.5, cy + 4)
          } else {
            ctx.moveTo(cx - 4, cy - 2.5)
            ctx.lineTo(cx + 4, cy - 2.5)
            ctx.lineTo(cx, cy + 3.5)
          }
          ctx.closePath()
          ctx.fill()
          ctx.textAlign = 'left'
          ctx.fillText(row.label, cx + 9, cy, l.width - t.padX * 2 - 13)
          // Subtle dot: this collapsed section hides non-default values.
          if (row.collapsed && row.hiddenModified !== undefined) {
            ctx.fillStyle = t.colors.modifiedIndicator
            ctx.beginPath()
            ctx.arc(node.x + l.width - t.padX - 3, cy, 2.5, 0, Math.PI * 2)
            ctx.fill()
          }
        } else if (row.kind === 'growth') {
          // Grow-family affordance: dashed ghost-alpha capsule with '+ label'.
          // It reads as an offer (like ghost pins), but is click-to-add because
          // a nested-only template leaves the ghost nothing to connect or edit.
          const rowAlpha = ctx.globalAlpha
          ctx.globalAlpha = rowAlpha * GHOST_ALPHA
          ctx.strokeStyle = t.colors.label
          ctx.lineWidth = 1
          ctx.setLineDash([3, 3])
          ctx.strokeRect(node.x + t.padX, rowY + 3, l.width - t.padX * 2, row.height - 6)
          ctx.setLineDash([])
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'center'
          ctx.fillText(`+ ${row.label}`, node.x + l.width / 2, rowY + row.height / 2, l.width - t.padX * 2 - 8)
          ctx.textAlign = 'left'
          ctx.globalAlpha = rowAlpha
        } else if (row.kind === 'fallback') {
          // Stored value on a schemaless node: read-only and dimmed, but
          // recognizable - the document's key and value survive the missing
          // schema even though no editor can be trusted to write them.
          const rowAlpha = ctx.globalAlpha
          ctx.fillStyle = t.colors.widgetBackground
          ctx.fillRect(node.x + t.padX, rowY + 2, l.width - t.padX * 2, row.height - 4)
          ctx.globalAlpha = rowAlpha * 0.75
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'left'
          ctx.fillText(row.label, node.x + t.padX + 4, rowY + row.height / 2, (l.width - t.padX * 2) * 0.45)
          ctx.fillStyle = t.colors.value
          ctx.textAlign = 'right'
          ctx.fillText(row.text, node.x + l.width - t.padX - 4, rowY + row.height / 2, (l.width - t.padX * 2) * 0.5)
          ctx.textAlign = 'left'
          ctx.globalAlpha = rowAlpha
          if (this.rowMarks[sceneNode.id]?.has(row.label) === true) {
            // Anchored diagnostic on this stored value: red outline mirrors
            // the Problems entry at the row (same contract as widget rows).
            ctx.strokeStyle = t.colors.error
            ctx.lineWidth = 1.5
            ctx.strokeRect(node.x + t.padX, rowY + 2, l.width - t.padX * 2, row.height - 4)
          }
        } else if (row.kind === 'ports') {
          // Ghost (dynamic affordance) labels render dimmed: connect/edit
          // materializes them; until then they are an offer, not a member.
          const rowAlpha = ctx.globalAlpha
          if (row.input) {
            if (row.input.ghost) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
            if (row.input.inactive) ctx.globalAlpha = rowAlpha * 0.45
            ctx.fillStyle = t.colors.label
            ctx.textAlign = 'left'
            ctx.fillText(row.input.label, node.x + t.padX + t.pinRadius + 4, rowY + row.height / 2)
            ctx.globalAlpha = rowAlpha
          }
          if (row.output) {
            if (row.output.ghost) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
            ctx.fillStyle = t.colors.label
            ctx.textAlign = 'right'
            ctx.fillText(row.output.label, node.x + l.width - t.padX - t.pinRadius - 4, rowY + row.height / 2)
            ctx.textAlign = 'left'
            ctx.globalAlpha = rowAlpha
          }
        } else {
          const companion = this.companions[sceneNode.id]?.[row.valueKey]
          // Selector rows ignore boundary bindings for inertness: the bound row
          // remains the occurrence-local editor.
          const linkSet = row.selector !== undefined ? this.valueDrivenInputPins : this.connectedInputPins
          const connected = companion !== undefined || linkSet.has(`${sceneNode.id}\u0000${row.inputId}`)
          const rowAlpha = ctx.globalAlpha
          if (row.ghost) ctx.globalAlpha = rowAlpha * GHOST_ALPHA
          if (row.inactive) ctx.globalAlpha *= 0.45
          const companionAlpha = ctx.globalAlpha
          if (connected) ctx.globalAlpha *= 0.45
          const hovered = this.overlay.hoveredWidget?.nodeId === sceneNode.id &&
            this.overlay.hoveredWidget.valueKey === row.valueKey
          this.paintWidget({
            ctx,
            row,
            // Selector rows (DynamicCombo) carry their value on the row itself;
            // everything else persists under the row's value key.
            value: row.derivedValue !== undefined ? row.derivedValue : node.node.values[row.valueKey],
            ...(companion !== undefined ? { companion } : {}),
            ...(companion !== undefined ? { companionAlpha } : {}),
            x: node.x + row.inset,
            y: rowY,
            width: l.width - row.inset * 2,
            rowHeight: t.rowHeight,
            connected,
            hovered,
            tokens: t,
          })
          if (hovered) {
            // A neutral wash preserves the widget's own active/connected
            // styling without making value selection look like live blue data.
            const hoverAlpha = ctx.globalAlpha
            const chrome = widgetChromeRect(node.x + row.inset, rowY, l.width - row.inset * 2, row.height)
            ctx.globalAlpha = hoverAlpha * 0.12
            ctx.fillStyle = t.colors.label
            ctx.beginPath()
            ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
            ctx.fill()
            ctx.globalAlpha = hoverAlpha
          }
          if (this.rowMarks[sceneNode.id]?.has(row.valueKey) === true) {
            // Anchored widget-value diagnostic (out-of-range INT, unknown
            // COMBO option, ...): a red row outline makes the Problems entry
            // actionable at the widget the user must fix, mirroring (not
            // replacing) the panel entry - same contract as the pin warn ring.
            const chrome = widgetChromeRect(node.x + row.inset, rowY, l.width - row.inset * 2, row.height)
            ctx.strokeStyle = t.colors.error
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.roundRect(chrome.x, chrome.y, chrome.width, chrome.height, chrome.radius)
            ctx.stroke()
          }
          if (row.controllerMode !== undefined) {
            const chip = controllerChipRect(l.width - row.inset * 2, t.rowHeight)
            const x = node.x + row.inset + chip.x
            const y = rowY + chip.y
            const chipAlpha = ctx.globalAlpha
            if (connected) ctx.globalAlpha = chipAlpha * 0.5
            ctx.fillStyle = t.colors.nodeHeader
            ctx.fillRect(x, y, chip.width, chip.height)
            ctx.strokeStyle = t.colors.selection
            ctx.strokeRect(x, y, chip.width, chip.height)
            paintSeedControllerIcon(ctx, row.controllerMode, x, y, chip.width, t.colors.label)
            ctx.globalAlpha = chipAlpha
          }
          const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
          if (numeric && row.derivedValue === undefined && !row.ghost) {
            // Edge glyphs reserve only the small bump zones; the broad center
            // remains the familiar editor activation target.
            const cy = rowY + t.rowHeight / 2
            const glyphAlpha = ctx.globalAlpha
            const previousStrokeStyle: string | CanvasGradient | CanvasPattern = ctx.strokeStyle
            const previousLineWidth = ctx.lineWidth
            const previousLineCap = ctx.lineCap
            if (connected) ctx.globalAlpha = glyphAlpha * 0.35
            ctx.strokeStyle = t.colors.label
            ctx.lineWidth = 1.5
            ctx.lineCap = 'round'
            const rowLeft = node.x + row.inset
            const rowWidth = l.width - row.inset * 2
            const minusX = rowLeft + edgeActionCenterX(rowWidth, 'leading')
            const plusX = rowLeft + edgeActionCenterX(rowWidth, 'trailing')
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
            const rowWidth = l.width - row.inset * 2
            const rect = widgetRowAffordanceRect(rowWidth, t.rowHeight, row)
            const x = node.x + row.inset + rect.x
            const y = rowY + rect.y
            const affordanceAlpha = ctx.globalAlpha
            if (lensAffordance.disabled === true) ctx.globalAlpha *= 0.45
            ctx.fillStyle = lensAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetBackground
            ctx.strokeStyle = lensAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetAffordance
            ctx.lineWidth = 1.5
            ctx.beginPath()
            ctx.roundRect(x, y, rect.width, rect.height, 3)
            ctx.fill()
            ctx.stroke()
            ctx.strokeStyle = lensAffordance.active ? t.colors.canvasBackground : t.colors.widgetAffordance
            ctx.lineCap = 'round'
            ctx.beginPath()
            if (lensAffordance.active) {
              ctx.moveTo(x + rect.width * 0.25, y + rect.height * 0.52)
              ctx.lineTo(x + rect.width * 0.43, y + rect.height * 0.7)
              ctx.lineTo(x + rect.width * 0.76, y + rect.height * 0.32)
            } else {
              ctx.moveTo(x + rect.width * 0.3, y + rect.height / 2)
              ctx.lineTo(x + rect.width * 0.7, y + rect.height / 2)
              ctx.moveTo(x + rect.width / 2, y + rect.height * 0.3)
              ctx.lineTo(x + rect.width / 2, y + rect.height * 0.7)
            }
            ctx.stroke()
            ctx.globalAlpha = affordanceAlpha
          }
          ctx.globalAlpha = rowAlpha
        }
      }
    }

    const preview = this.previews[node.id]
    const outputText = this.outputTexts[node.id]
    if (preview !== undefined && l.preview !== undefined) {
      const rect = {
        x: node.x + l.preview.x,
        y: node.y + l.preview.y,
        width: l.preview.width,
        height: l.preview.height,
      }
      ctx.fillStyle = t.colors.widgetBackground
      ctx.strokeStyle = t.colors.nodeBorder
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, Math.max(2, t.cornerRadius - 1))
      ctx.fill()
      ctx.stroke()
      const minimizedPreview = l.minimized === true
      const farMedia = !minimizedPreview &&
        (preview.kind === 'video' || preview.kind === 'audio') && detailLevel === 'overview'
      const panel = splitPreviewRect(rect, t.previewCaptionHeight)
      const mediaRect = farMedia || minimizedPreview ? rect : panel.media
      if (farMedia) {
        // Badge-only below the media visibility threshold.
      } else if (preview.src !== undefined && (preview.kind === 'video' || preview.kind === 'audio')) {
        // DOM owns ready audio/video at detail zoom. Canvas owns its caption
        // below. A model3d preview keeps its src for the orbit overlay but
        // paints its poster in-canvas like an image.
      } else if (preview.image !== undefined && preview.status === undefined) {
        // Live animation cycles on the running-node frame loop; reduced
        // motion (which also stops that loop) keeps the newest still.
        const animated = preview.animation !== undefined && !this.reducedMotion
          ? animationFrameAt(preview.animation, this.animationTimeMs)
          : undefined
        const fit = containRect(mediaRect, preview)
        if (this.previewChecker === undefined) {
          const tile = typeof OffscreenCanvas === 'undefined'
            ? this.canvas.ownerDocument.createElement('canvas')
            : new OffscreenCanvas(16, 16)
          tile.width = tile.height = 16
          const tileContext = tile.getContext('2d')!
          tileContext.fillStyle = t.colors.widgetBackground
          tileContext.fillRect(0, 0, 16, 16)
          tileContext.fillStyle = t.colors.nodeBorder
          tileContext.fillRect(0, 0, 8, 8)
          tileContext.fillRect(8, 8, 8, 8)
          this.previewChecker = ctx.createPattern(tile, 'repeat')
        }
        ctx.fillStyle = this.previewChecker ?? t.colors.widgetBackground
        ctx.fillRect(fit.x, fit.y, fit.width, fit.height)
        try {
          ctx.drawImage(animated ?? preview.image, fit.x, fit.y, fit.width, fit.height)
        } catch {
          // A closed/detached ImageBitmap must never kill the frame loop.
        }
      } else if (contentDetail) {
        ctx.fillStyle = t.colors.label
        ctx.font = `${t.fontSize}px ${t.fontFamily}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const alpha = ctx.globalAlpha
        ctx.globalAlpha = alpha * 0.65
        const media = preview.kind === 'video'
          ? 'video'
          : preview.kind === 'audio'
            ? 'audio'
            : preview.kind === 'model3d' ? '3D model' : undefined
        const label = preview.statusMessage === undefined ? (media === undefined
          ? preview.status === 'unavailable'
            ? minimizedPreview ? 'No preview' : 'preview unavailable'
            : minimizedPreview ? 'Loading' : 'loading preview...'
          : preview.status === 'unavailable'
            ? minimizedPreview ? 'No preview' : 'Preview unavailable'
            : preview.status === 'failed'
              ? minimizedPreview ? 'No preview' : `${media[0]!.toUpperCase()}${media.slice(1)} unavailable`
              : minimizedPreview ? 'Loading' : `Loading ${media}`)
          : fitText(ctx, preview.statusMessage, Math.max(0, mediaRect.width - 8))
        ctx.fillText(label, mediaRect.x + mediaRect.width / 2, mediaRect.y + mediaRect.height / 2)
        ctx.globalAlpha = alpha
      }
      if (farMedia) {
        ctx.fillStyle = t.colors.nodeBody
        const label = `${preview.kind ?? 'media'}${(preview.count ?? 0) > 1 ? ` ${(preview.index ?? 0) + 1}/${preview.count}` : ''}`
        ctx.font = `${Math.max(9, t.fontSize - 1)}px ${t.fontFamily}`
        const width = Math.max(48, ctx.measureText(label).width + 12)
        ctx.fillRect(rect.x + (rect.width - width) / 2, rect.y + (rect.height - 20) / 2, width, 20)
        ctx.fillStyle = t.colors.label
        ctx.textAlign = 'center'
        ctx.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2)
      }
      if (minimizedPreview && preview.src !== undefined &&
          (preview.kind === 'video' || preview.kind === 'audio')) {
        const label = `${preview.kind === 'video' ? 'Video' : 'Audio'}${(preview.count ?? 0) > 1 ? ` ${(preview.index ?? 0) + 1}/${preview.count}` : ''}`
        ctx.fillStyle = t.colors.label
        ctx.font = `${Math.max(9, t.fontSize - 1)}px ${t.fontFamily}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2, Math.max(0, rect.width - 8))
      }
      if (!farMedia && !minimizedPreview) {
        const caption = panel.caption
        ctx.fillStyle = t.colors.nodeBody
        ctx.fillRect(caption.x, caption.y, caption.width, caption.height)
        ctx.strokeStyle = t.colors.nodeBorder
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(caption.x, caption.y)
        ctx.lineTo(caption.x + caption.width, caption.y)
        ctx.stroke()
      }
      if (!farMedia && !minimizedPreview && contentDetail) {
        const caption = panel.caption
        const provenanceY = caption.y + caption.height * 0.25
        const metadataY = caption.y + caption.height * 0.75
        // The approx prefix keeps a mirror-computed estimate distinguishable
        // from real imagery even without color.
        const stateLabel = preview.state === 'cached'
          ? 'last resolved'
          : preview.state === 'estimate' ? '\u2248 estimated' : undefined
        const countLabel = (preview.count ?? 0) > 1
          ? `${(preview.index ?? 0) + 1}/${preview.count}`
          : undefined
        const dimensionsLabel = preview.status === undefined &&
          Number.isFinite(preview.width) && (preview.width ?? 0) > 0 &&
          Number.isFinite(preview.height) && (preview.height ?? 0) > 0
          ? `${Math.round(preview.width!)} x ${Math.round(preview.height!)}`
          : undefined
        const metadataLabel = [dimensionsLabel, preview.colorTransform === undefined
          ? undefined : `Preview color: ${preview.colorTransform}`].filter((label) => label !== undefined).join(' | ')
        ctx.font = `${Math.max(9, t.fontSize - 1)}px ${t.fontFamily}`
        ctx.fillStyle = t.colors.label
        ctx.textBaseline = 'middle'
        const padding = 8
        if (stateLabel !== undefined) {
          if (preview.state === 'estimate') ctx.fillStyle = t.colors.companionEstimate
          ctx.textAlign = 'left'
          ctx.fillText(stateLabel, caption.x + padding, provenanceY, caption.width - padding * 2)
          ctx.fillStyle = t.colors.label
        }
        if (countLabel !== undefined) {
          ctx.textAlign = 'right'
          ctx.fillText(countLabel, caption.x + caption.width - padding, provenanceY)
        }
        if (metadataLabel !== '') {
          ctx.textAlign = 'center'
          ctx.fillText(metadataLabel, caption.x + caption.width / 2, metadataY, caption.width - padding * 2)
        }
      }
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
    } else if (contentDetail && outputText !== undefined && l.textOutput !== undefined) {
      const rect = {
        x: node.x + l.textOutput.x,
        y: node.y + l.textOutput.y,
        width: l.textOutput.width,
        height: l.textOutput.height,
      }
      ctx.save()
      ctx.fillStyle = t.colors.widgetBackground
      ctx.strokeStyle = t.colors.nodeBorder
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, Math.max(2, t.cornerRadius - 1))
      ctx.fill()
      ctx.stroke()
      ctx.clip()
      const padding = 4
      const visibleLines = Math.max(1, Math.min(6, Math.round(rect.height / t.rowHeight)))
      const lineHeight = (rect.height - padding * 2) / visibleLines
      const maxWidth = Math.max(0, rect.width - padding * 2)
      ctx.font = `italic ${t.fontSize}px ${t.fontFamily}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const lines = outputText.text.replace(/\r\n?/g, '\n').split('\n').flatMap((line) => wrapText(ctx, line, maxWidth))
      const overflow = lines.length > visibleLines
      const shown = overflow && visibleLines > 1
        ? lines.slice(0, visibleLines - 1)
        : lines.slice(0, visibleLines)
      const color = outputText.stale === true
        ? t.colors.companionUnproven
        : outputText.error === true
          ? t.colors.error
          : outputText.estimate === true
            ? t.colors.companionEstimate
            : t.colors.companionValue
      ctx.fillStyle = color
      let textY = rect.y + padding + lineHeight / 2
      for (const line of shown) {
        ctx.fillText(line, rect.x + padding, textY)
        if (outputText.stale === true && line.length > 0) {
          ctx.save()
          ctx.strokeStyle = color
          ctx.lineWidth = 1
          ctx.setLineDash([1, 2])
          ctx.beginPath()
          ctx.moveTo(rect.x + padding, textY + t.fontSize / 2 + 1)
          ctx.lineTo(rect.x + padding + measureWidth(ctx, line), textY + t.fontSize / 2 + 1)
          ctx.stroke()
          ctx.restore()
        }
        textY += lineHeight
      }
      if (overflow && visibleLines > 1) {
        ctx.font = `${Math.max(9, t.fontSize - 1)}px ${t.fontFamily}`
        ctx.fillStyle = t.colors.label
        ctx.textAlign = 'right'
        ctx.fillText(`+${lines.length - shown.length} more`, rect.x + rect.width - padding, textY)
      }
      ctx.restore()
    } else if (l.preview?.compact === true) {
      const rect = {
        x: node.x + l.preview.x,
        y: node.y + l.preview.y,
        width: l.preview.width,
        height: l.preview.height,
      }
      ctx.fillStyle = t.colors.widgetBackground
      ctx.strokeStyle = t.colors.nodeBorder
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, Math.max(2, t.cornerRadius - 1))
      ctx.fill()
      ctx.stroke()
      if (contentDetail) {
        ctx.fillStyle = t.colors.title
        ctx.font = `600 ${t.fontSize}px ${t.fontFamily}`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const label = l.minimized ? 'Preview' : 'Preview - right-click'
        ctx.textAlign = l.minimized ? 'center' : 'left'
        ctx.fillText(
          label,
          l.minimized ? rect.x + rect.width / 2 : rect.x + 8,
          rect.y + t.rowHeight / 2,
          Math.max(0, rect.width - 16),
        )
        ctx.textBaseline = 'alphabetic'
      }
    }

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
      if (previewAffordance.disabled === true) ctx.globalAlpha *= 0.45
      ctx.fillStyle = previewAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetBackground
      ctx.strokeStyle = previewAffordance.active ? t.colors.widgetAffordanceActive : t.colors.widgetAffordance
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, 3)
      ctx.fill()
      ctx.stroke()
      ctx.strokeStyle = previewAffordance.active ? t.colors.canvasBackground : t.colors.widgetAffordance
      ctx.lineCap = 'round'
      ctx.beginPath()
      if (previewAffordance.active) {
        ctx.moveTo(rect.x + rect.width * 0.25, rect.y + rect.height * 0.52)
        ctx.lineTo(rect.x + rect.width * 0.43, rect.y + rect.height * 0.7)
        ctx.lineTo(rect.x + rect.width * 0.76, rect.y + rect.height * 0.32)
      } else {
        ctx.moveTo(rect.x + rect.width * 0.3, rect.y + rect.height / 2)
        ctx.lineTo(rect.x + rect.width * 0.7, rect.y + rect.height / 2)
        ctx.moveTo(rect.x + rect.width / 2, rect.y + rect.height * 0.3)
        ctx.lineTo(rect.x + rect.width / 2, rect.y + rect.height * 0.7)
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
        paintTypedPin(
          ctx,
          t,
          type,
          direction === 'in' ? node.x : node.x + l.width,
          node.y + l.headerHeight / 2,
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
      const px = pin.direction === 'in' ? node.x : node.x + l.width
      const py = node.y + pin.y
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
      const radius = hovered || focused || associated ? pinRadius * PIN_HOVER_SCALE : pinRadius
      const shapeScale = pinShapeRadialScale(pinShapeOf(pin.type, pin.direction))
      // Preserve the normal glyph-to-ring gap as a hovered glyph grows.
      const statusRingRadius = pinRadius + STATUS_RING_GAP + (radius - pinRadius) * shapeScale
      const problemKind = pin.direction === 'in' ? this.portProblems[node.id]?.[pin.portId] : undefined
      if (pin.widgetTap === true &&
          !this.connectedWidgetTaps.has(`${node.id}\u0000${pin.address.port}`) &&
          !isLegalTarget && !nodeHovered)
        continue
      if (pin.widgetBacked && pin.direction === 'in' && !connected && !isLegalTarget && !nodeSelected && !nodeHovered && problemKind === undefined)
        continue
      if (pin.familyOwner !== undefined && pin.familyOwner.socketed !== true) continue
      if (isTarget) {
        ctx.beginPath()
        ctx.arc(px, py, statusRingRadius, 0, Math.PI * 2)
        ctx.strokeStyle = t.colors.dropTarget
        ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
        ctx.stroke()
      }
      if (pin.warn === true && !isTarget) {
        // Anchored solver warning (e.g. stale specialization): an error ring
        // makes the advisory actionable at the pin the user must fix,
        // mirroring (not replacing) the Problems entry. Drop-target rings
        // win during a drag - the gesture needs the affordance more.
        ctx.beginPath()
        ctx.arc(px, py, statusRingRadius, 0, Math.PI * 2)
        ctx.strokeStyle = t.colors.error
        ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
        ctx.stroke()
      }
      if (problemKind !== undefined && !isTarget) {
        // Host-resolved document problems share the pin-ring channel with
        // solver warnings. Paint after the legacy solver ring so exact
        // severity wins; selection/hover affect pin visibility, not this
        // independent diagnostic signal.
        ctx.beginPath()
        ctx.arc(px, py, statusRingRadius, 0, Math.PI * 2)
        ctx.strokeStyle = problemKind === 'error'
          ? t.colors.error
          : problemKind === 'blocking-warning'
            ? t.colors.blockingWarning
            : PROBLEM_WARNING_BADGE.color
        ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
        ctx.stroke()
      }
      const pinColor = pinColorOf(t, pin.type)
      if (pin.ghost) {
        // Ghost pins are affordances: hollow, dimmed ring in the pin's shape.
        const shape = pinShapeOf(pin.type, pin.direction)
        pinOutlinePath(ctx, shape, px, py, pinShapeRadius(shape, radius))
        const pinAlpha = ctx.globalAlpha
        ctx.globalAlpha = pinAlpha * GHOST_ALPHA
        ctx.strokeStyle = pinColor
        ctx.lineWidth = screenAwareStroke(1.5, scale, 1)
        ctx.stroke()
        ctx.globalAlpha = pinAlpha
      } else {
        paintTypedPin(
          ctx,
          t,
          pin.type,
          px,
          py,
          this.viewport.scale,
          pin.maybeAbsent === true ||
            (pin.direction === 'in' && (pin.optional === true || pin.familyMember === true)),
          pin.direction,
          radius,
        )
      }
    }

    if (contentDetail && node.virtual !== undefined) {
      const bodyX = node.x + t.padX
      const bodyY = node.y + l.headerHeight + 8
      const bodyWidth = Math.max(0, l.width - t.padX * 2)
      const bodyHeight = Math.max(0, l.height - l.headerHeight - 16)
      ctx.fillStyle = node.color === undefined
        ? t.colors.nodeBody
        : tintHex(t.colors.nodeBody, node.color, 0.28)
      ctx.fillRect(node.x + 1, node.y + l.headerHeight, l.width - 2, l.height - l.headerHeight - 1)
      ctx.fillStyle = t.colors.value
      ctx.textBaseline = 'top'
      ctx.textAlign = 'left'
      const lineHeight = Math.max(16, t.fontSize + 5)
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
        const fontSize = heading === null ? t.fontSize : Math.max(t.fontSize, t.fontSize + 4 - heading[1]!.length)
        const weight = heading !== null || node.virtual.format === 'markdown' && /\*\*|__/.test(sourceLine) ? '700' : '400'
        ctx.font = `${weight} ${fontSize}px ${t.fontFamily}`
        if (listItem !== null) ctx.fillText('\u2022', bodyX, y, bodyWidth)
        const textX = listItem === null ? bodyX : bodyX + 16
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
        y += Math.max(lineHeight, fontSize + 5)
      }
    }

    ctx.globalAlpha = 1
  }

  private drawRunningGlow(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    const pulse = this.reducedMotion
      ? 0.5
      : (Math.sin((this.animationTimeMs / 1400) * Math.PI * 2) + 1) / 2
    ctx.save()
    ctx.globalAlpha *= 0.48 + pulse * 0.22
    ctx.beginPath()
    ctx.roundRect(x - 2, y - 2, width + 4, height + 4, this.tokens.cornerRadius + 2)
    ctx.strokeStyle = this.tokens.stateColors.running
    ctx.lineWidth = screenAwareStroke(4.5, this.viewport.scale, 3)
    ctx.shadowColor = this.tokens.stateColors.running
    ctx.shadowBlur = 8 + pulse * 5
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
    ctx.lineWidth = screenAwareStroke(1.5, scale, 1.5)
    ctx.setLineDash(screenAwareDash([13, 9], [9, 6], scale))
    ctx.lineDashOffset = -(this.animationTimeMs * 0.032) / scale
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
    const px = nx + 1
    const py = ny + l.headerHeight
    const pw = l.width - 2
    const ph = l.height - l.headerHeight - 1
    if (ph < 10 || pw < 20) return
    const baseAlpha = ctx.globalAlpha
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(px, py, pw, ph, [0, 0, t.cornerRadius - 1, t.cornerRadius - 1])
    ctx.clip()
    ctx.globalAlpha = baseAlpha * 0.92
    ctx.fillStyle = t.colors.canvasBackground
    ctx.fillRect(px, py, pw, ph)
    ctx.globalAlpha = baseAlpha

    const rowH = 17
    const maxRows = Math.max(1, Math.floor((ph - 6) / rowH))
    const overflow = rows.length > maxRows
    const shown = overflow ? rows.slice(0, maxRows - 1) : rows
    const font = `${t.fontSize - 1}px ${t.fontFamily}`
    ctx.textBaseline = 'middle'
    let y = py + 3 + rowH / 2
    const innerX = px + t.padX - 2
    const innerW = pw - (t.padX - 2) * 2
    for (const row of shown) {
      const tone = row.tone ?? 'value'
      ctx.font = font
      let labelWidth = 0
      if (row.label !== '') {
        ctx.fillStyle = t.colors.label
        ctx.textAlign = 'left'
        const maxLabel = innerW * 0.45
        ctx.fillText(row.label, innerX, y, maxLabel)
        labelWidth = Math.min(ctx.measureText(row.label).width, maxLabel)
      }
      // Values italicize like companions ("derived, not stored"); stale dims
      // with the same factor stale companions use.
      if (tone !== 'muted') ctx.font = `italic ${font}`
      if (tone === 'stale') ctx.globalAlpha = baseAlpha * 0.55
      ctx.fillStyle = tone === 'muted' ? t.colors.label : t.colors.companionValue
      ctx.textAlign = 'right'
      ctx.fillText(row.text, innerX + innerW, y, innerW - labelWidth - 8)
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
  private drawBoundaryNode(
    ctx: CanvasRenderingContext2D,
    bnode: SceneBoundaryNode,
    detailLevel: CanvasDetailLevel,
    dx = 0,
    dy = 0,
  ): void {
    const t = this.tokens
    const l = bnode.layout
    const x = bnode.x + dx
    const y = bnode.y + dy
    const scale = this.viewport.scale
    const contentDetail = detailLevel !== 'overview'
    const pinRadius = detailRadius(t.pinRadius, scale, detailLevel)
    const selectionStrokeWidth = screenAwareStroke(SELECTION_OUTLINE_STROKE_WIDTH, scale, 2)

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
    // Dashed border: the "derived, not a real node" signal.
    ctx.save()
    ctx.setLineDash(screenAwareDash([5, 3], [4, 3], scale))
    ctx.beginPath()
    ctx.roundRect(x, y, l.width, l.height, t.cornerRadius)
    ctx.strokeStyle = t.colors.nodeOutline
    ctx.lineWidth = screenAwareStroke(1.25, scale, 1)
    ctx.stroke()
    ctx.restore()
    if (this.overlay.bodyDropNode === boundarySceneId(bnode.side)) {
      ctx.beginPath()
      ctx.roundRect(x - 2, y - 2, l.width + 4, l.height + 4, t.cornerRadius + 2)
      ctx.strokeStyle = t.colors.dropTarget
      ctx.lineWidth = screenAwareStroke(2, scale, 2)
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
      ctx.font = `600 ${t.titleFontSize}px ${t.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText(l.title, x + t.padX, y + l.headerHeight / 2, l.width - t.padX * 2)

      // Port rows (boundary layouts only emit 'ports' rows). Ghost rows (the
      // trailing "expose..." affordance) render dimmed.
      ctx.font = `${t.fontSize}px ${t.fontFamily}`
      for (const row of l.rows) {
        if (row.kind !== 'ports') continue
        const rowY = y + row.y
        const slot = row.input ?? row.output
        const dim = slot?.ghost === true
        if (dim) ctx.globalAlpha = GHOST_ALPHA
        if (row.input) {
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'left'
          ctx.fillText(row.input.label, x + t.padX + t.pinRadius + 4, rowY + row.height / 2)
        }
        if (row.output) {
          ctx.fillStyle = t.colors.label
          ctx.textAlign = 'right'
          ctx.fillText(row.output.label, x + l.width - t.padX - t.pinRadius - 4, rowY + row.height / 2)
          ctx.textAlign = 'left'
        }
        if (dim) ctx.globalAlpha = 1
      }
      ctx.textBaseline = 'alphabetic'
    }

    // Pins. Ghost pins draw hollow; a legal boundary drop target gets the
    // same highlight ring as regular pins.
    for (const pin of l.pins) {
      const px = pin.direction === 'in' ? x : x + l.width
      const py = y + pin.y
      if (this.overlay.dropTargets?.has(boundaryTargetKey(bnode.side, pin.portId))) {
        ctx.beginPath()
        ctx.arc(px, py, pinRadius + STATUS_RING_GAP, 0, Math.PI * 2)
        ctx.strokeStyle = t.colors.dropTarget
        ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
        ctx.stroke()
      }
      const pinColor = pinColorOf(t, pin.type)
      if (pin.ghost) {
        const shape = pinShapeOf(pin.type, pin.direction)
        pinOutlinePath(ctx, shape, px, py, pinShapeRadius(shape, pinRadius))
        ctx.globalAlpha = GHOST_ALPHA
        ctx.strokeStyle = pinColor
        ctx.lineWidth = screenAwareStroke(1.5, scale, 1)
        ctx.stroke()
        ctx.globalAlpha = 1
      } else {
        paintTypedPin(ctx, t, pin.type, px, py, scale, pin.maybeAbsent === true, pin.direction, pinRadius)
      }
    }
  }

  /**
   * A value source pill: rounded body, title + value text, spec badge
   * (declared: filled dot / derived: hollow dot / conflict: warning), one
   * output pin. `x`/`y` are the drag-offset top-left (world coords).
   */
  private drawValueSource(
    ctx: CanvasRenderingContext2D,
    vs: SceneValueSource,
    x: number,
    y: number,
    detailLevel: CanvasDetailLevel,
  ): void {
    const t = this.tokens
    const r = vs.height / 2
    const selected = this.overlay.valueSourceSelection?.has(vs.id) ?? false
    const conflictColor = t.stateColors.error
    const scale = this.viewport.scale
    const contentDetail = detailLevel !== 'overview'
    const pinRadius = detailRadius(t.pinRadius, scale, detailLevel)

    // Body.
    ctx.beginPath()
    ctx.roundRect(x, y, vs.width, vs.height, r)
    ctx.fillStyle = t.colors.nodeBody
    ctx.fill()
    ctx.strokeStyle = selected ? t.colors.nodeSelectedBorder : vs.conflict ? conflictColor : t.colors.nodeOutline
    ctx.lineWidth = screenAwareStroke(
      selected || vs.conflict ? 2 : 1,
      scale,
      selected || vs.conflict ? 2 : 1,
    )
    if (vs.conflict) ctx.setLineDash(screenAwareDash([4, 2], [4, 2], scale))
    ctx.stroke()
    if (vs.conflict) ctx.setLineDash([])

    const badge = valueSourceBadgeRect(vs)
    if (contentDetail) {
      // Title + value on one line: title in label color, value in value color.
      const textRight = x + (badge.x - vs.x) - 4 // keep clear of the badge
      ctx.font = `${t.fontSize}px ${t.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const titleX = x + t.padX
      ctx.fillStyle = t.colors.label
      ctx.fillText(vs.title, titleX, y + vs.height / 2 + 0.5, Math.max(0, textRight - titleX))
      const titleW = ctx.measureText(vs.title).width
      const valueX = titleX + titleW + 8
      if (valueX < textRight) {
        ctx.fillStyle = t.colors.value
        ctx.fillText(vs.valueText, valueX, y + vs.height / 2 + 0.5, textRight - valueX)
      }
      ctx.textBaseline = 'alphabetic'

      // Spec badge: filled = declared (pinned), hollow = derived, '!' = conflict.
      const bx = x + (badge.x - vs.x) + badge.width / 2
      const by = y + (badge.y - vs.y) + badge.height / 2
      const badgeR = badge.width / 2 - 2
      ctx.beginPath()
      ctx.arc(bx, by, badgeR, 0, Math.PI * 2)
      if (vs.conflict) {
        ctx.fillStyle = conflictColor
        ctx.fill()
        ctx.fillStyle = t.colors.title
        ctx.font = `700 ${t.fontSize - 2}px ${t.fontFamily}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('!', bx, by + 0.5)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'alphabetic'
      } else if (vs.specState === 'declared') {
        ctx.fillStyle = t.colors.selection
        ctx.fill()
      } else {
        ctx.strokeStyle = t.colors.label
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    // Output pin (drop-target ring during input-seeking drags).
    const px = x + vs.width
    const py = y + vs.height / 2
    if (this.overlay.dropTargets?.has(valueSourceTargetKey(vs.id))) {
      ctx.beginPath()
      ctx.arc(px, py, pinRadius + STATUS_RING_GAP, 0, Math.PI * 2)
      ctx.strokeStyle = t.colors.dropTarget
      ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, scale, STATUS_RING_STROKE_WIDTH)
      ctx.stroke()
    }
    paintPin(ctx, {
      shape: 'circle', colors: [vs.typeName ? typeColor(t, vs.typeName) : t.colors.linkDefault], optional: false,
      x: px, y: py, radius: pinRadius, scale, background: t.colors.canvasBackground,
    })
  }

  /**
   * A selector: node design language (body, header band, title) at compact
   * scale. Header carries the policy badge plus the single output pin; one
   * row per candidate with its branch input pin, label, and (under a fixed
   * policy) an active-branch marker.
   */
  private drawSelector(
    ctx: CanvasRenderingContext2D,
    sel: SceneSelector,
    x: number,
    y: number,
    detailLevel: CanvasDetailLevel,
  ): void {
    const t = this.tokens
    const selected = this.overlay.selectorSelection?.has(sel.id) ?? false
    const scale = this.viewport.scale
    const contentDetail = detailLevel !== 'overview'
    const pinRadius = detailRadius(t.pinRadius, scale, detailLevel)

    // Selection halo behind the body (same treatment as nodes: white).
    if (selected) {
      ctx.beginPath()
      ctx.roundRect(x - 3, y - 3, sel.width + 6, sel.height + 6, t.cornerRadius + 3)
      ctx.strokeStyle = t.colors.nodeSelectedBorder
      ctx.lineWidth = screenAwareStroke(2, scale, 2)
      ctx.stroke()
    }

    // Body + header band.
    ctx.beginPath()
    ctx.roundRect(x, y, sel.width, sel.height, t.cornerRadius)
    ctx.fillStyle = t.colors.nodeBody
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(x, y, sel.width, sel.headerHeight, [t.cornerRadius, t.cornerRadius, 0, 0])
    ctx.fillStyle = t.colors.nodeHeader
    ctx.fill()
    ctx.beginPath()
    ctx.roundRect(x, y, sel.width, sel.height, t.cornerRadius)
    ctx.strokeStyle = t.colors.nodeOutline
    ctx.lineWidth = screenAwareStroke(1.25, scale, 1)
    ctx.stroke()

    const badge = selectorBadgeRect(sel)
    const resolved = this.selectorResolutions?.get(sel.id)
    const activeId = resolved ?? (sel.random ? undefined : sel.activeCandidate)
    if (contentDetail) {
      // Title (truncated to leave room for the policy badge).
      ctx.fillStyle = t.colors.title
      ctx.font = `600 ${t.titleFontSize}px ${t.fontFamily}`
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      ctx.fillText(sel.title, x + t.padX, y + sel.headerHeight / 2, Math.max(0, badge.x - sel.x - t.padX - 4))

      // Policy badge: fixed shows the active candidate's 1-based ordinal,
      // random shows '?'. An execution-recorded resolution (frozen/execution
      // views) shows the branch that ACTUALLY ran.
      const bx = x + (badge.x - sel.x)
      const by = y + (badge.y - sel.y)
      ctx.beginPath()
      ctx.roundRect(bx, by, badge.width, badge.height, 3)
      ctx.fillStyle = sel.random ? t.colors.selection : t.colors.widgetBackground
      ctx.fill()
      if (!sel.random) {
        ctx.strokeStyle = t.colors.label
        ctx.lineWidth = 1
        ctx.stroke()
      }
      const activeIndex = sel.candidates.findIndex((c) => c.id === activeId)
      ctx.fillStyle = t.colors.title
      ctx.font = `600 9px ${t.fontFamily}`
      ctx.textAlign = 'center'
      ctx.fillText(activeIndex < 0 ? (sel.random ? '?' : '0') : `${activeIndex + 1}`, bx + badge.width / 2, by + badge.height / 2 + 0.5)
      ctx.textAlign = 'left'
    }

    // Candidate rows: active-branch accent bar, label, branch input pin.
    // Under a scope highlight, rows whose branch is out of scope dim like
    // their feed noodles (the box itself already carries selector-level dim).
    const scope = this.scopeHighlight
    ctx.font = `${t.fontSize}px ${t.fontFamily}`
    for (const c of sel.candidates) {
      const cy = y + c.y
      const active = c.id === activeId
      const rowDim =
        scope !== undefined &&
        scope.selectors.has(sel.id) &&
        !scope.selectorCandidates.has(selectorCandidateKey(sel.id, c.id))
      if (rowDim) ctx.globalAlpha = SCOPE_DIM
      if (active) {
        ctx.fillStyle = t.colors.selection
        ctx.fillRect(x + 1.5, cy - (t.rowHeight / 2 - 3), 2.5, t.rowHeight - 6)
      }
      if (contentDetail) {
        ctx.fillStyle = active ? t.colors.title : t.colors.label
        ctx.textAlign = 'left'
        ctx.fillText(c.label, x + t.padX + t.pinRadius + 4, cy + 0.5, sel.width - t.padX * 2 - t.pinRadius - 4)
      }
      this.drawSelectorPin(
        ctx,
        x,
        cy,
        c.typeName,
        this.overlay.dropTargets?.has(selectorInTargetKey(sel.id, c.id)) ?? false,
        pinRadius,
      )
      if (rowDim) ctx.globalAlpha = 1
    }

    // Single output pin on the header band's right edge.
    const out = selectorOutPinPosition(sel)
    this.drawSelectorPin(
      ctx,
      x + (out.x - sel.x),
      y + (out.y - sel.y),
      sel.typeName,
      this.overlay.dropTargets?.has(selectorOutTargetKey(sel.id)) ?? false,
      pinRadius,
    )
    ctx.textBaseline = 'alphabetic'
  }

  private drawSelectorPin(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    typeName: string | undefined,
    dropTarget: boolean,
    pinRadius: number,
  ): void {
    const t = this.tokens
    if (dropTarget) {
      ctx.beginPath()
      ctx.arc(px, py, pinRadius + STATUS_RING_GAP, 0, Math.PI * 2)
      ctx.strokeStyle = t.colors.dropTarget
      ctx.lineWidth = screenAwareStroke(STATUS_RING_STROKE_WIDTH, this.viewport.scale, STATUS_RING_STROKE_WIDTH)
      ctx.stroke()
    }
    paintPin(ctx, {
      shape: 'circle', colors: [typeName ? typeColor(t, typeName) : t.colors.linkDefault], optional: false,
      x: px, y: py, radius: pinRadius, scale: this.viewport.scale, background: t.colors.canvasBackground,
    })
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
const PIN_OVERHANG = 12

/** Alpha applied to nodes/links outside a partial-execution scope preview. */
const SCOPE_DIM = 0.72

/** Fallback painter: label left, formatted value right. Label and value
 * share the row deficit-proportionally (text-fit.ts) so neither overlaps
 * nor starves the other. */
export const defaultWidgetPainter: WidgetPainter = (args) => {
  const { ctx, row, value, x, y, width, rowHeight, tokens } = args
  ctx.fillStyle = tokens.colors.widgetBackground
  ctx.beginPath()
  ctx.roundRect(x, y + 2, width, row.height - 4, 4)
  ctx.fill()
  if (args.companion !== undefined) {
    const formatted = formatWidgetValue(args.companion.value, row.spec).split('\n')[0] ?? ''
    const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
    const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined)
    const companionZone = shareRowWidth(field.right - field.left, measureWidth(ctx, row.label) + 12, measureWidth(ctx, formatted) + 12)
    ctx.fillStyle = tokens.colors.label
    ctx.textAlign = 'left'
    ctx.fillText(fitText(ctx, row.label, Math.max(0, companionZone - 8)), x + field.left + 6, y + rowHeight / 2)
    paintCompanionValue(args)
    return
  }
  const text = formatWidgetValue(value, row.spec).split('\n')[0] ?? ''
  const controller = row.controllerMode !== undefined
    ? controllerChipRect(width, rowHeight)
    : undefined
  const valueRight = controller === undefined ? width - 6 : controllerChipTextRight(width, rowHeight)
  const usable = Math.max(0, valueRight - 6)
  const labelZone = shareRowWidth(
    usable,
    measureWidth(ctx, row.label) + 12,
    measureWidth(ctx, text) + 8,
    true,
  )
  const valueWidth = Math.max(0, usable - labelZone)
  ctx.fillStyle = tokens.colors.label
  ctx.textAlign = 'left'
  ctx.fillText(fitText(ctx, row.label, Math.max(0, labelZone - 8)), x + 6, y + rowHeight / 2)
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
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(left, y)
  ctx.lineTo(right, y)
  ctx.stroke()
  ctx.restore()
}

/**
 * Draw a companion (propagated) value into a widget row whose chrome+label
 * are already painted: italic, companion color, right-aligned - the shared
 * "this is what flows in, not what you stored" style for every widget kind.
 * Stale/unproven companions use their own semantic color and dotted
 * underline. Full text opacity preserves AA contrast and the underline keeps
 * the state distinguishable without color.
 */
export function paintCompanionValue({ ctx, row, companion, companionAlpha, x, y, width, rowHeight, tokens }: WidgetPaintArgs): void {
  if (companion === undefined) return
  const prevFont = ctx.font
  const prevAlpha = ctx.globalAlpha
  const estimate = companion.state === 'estimate'
  // The approx prefix keeps a mirror-computed estimate distinguishable from
  // an execution-recorded value even without color.
  const text = (estimate ? '\u2248 ' : '') + (formatWidgetValue(companion.value, row.spec).split('\n')[0] ?? '')
  const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
  const field = widgetFieldBounds(width, rowHeight, numeric, row.controllerMode !== undefined)
  const labelZone = shareRowWidth(field.right - field.left, measureWidth(ctx, row.label) + 12, measureWidth(ctx, text) + 12)
  const availableWidth = Math.max(0, field.right - field.left - labelZone)
  const unproven = companion.state === 'stale' || (companion.state === undefined && companion.stale === true)
  const color = unproven
    ? tokens.colors.companionUnproven
    : estimate ? tokens.colors.companionEstimate : tokens.colors.companionValue
  ctx.font = `italic ${prevFont}`
  ctx.globalAlpha = companionAlpha ?? prevAlpha
  const displayText = fitText(ctx, text, availableWidth)
  ctx.fillStyle = color
  ctx.textAlign = 'right'
  const textRight = x + field.right
  const textY = y + rowHeight / 2
  ctx.fillText(displayText, textRight, textY)
  if (unproven && displayText.length > 0) {
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.setLineDash([1, 2])
    ctx.beginPath()
    ctx.moveTo(textRight - measureWidth(ctx, displayText), textY + 4)
    ctx.lineTo(textRight, textY + 4)
    ctx.stroke()
    ctx.restore()
  }
  ctx.textAlign = 'left'
  ctx.font = prevFont
  ctx.globalAlpha = prevAlpha
}
