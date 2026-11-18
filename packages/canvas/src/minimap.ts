/**
 * Minimap: a pure overview renderer for one graph view. Deliberately a
 * FUNCTION over geometry + overlay state, not a widget wired into the live
 * canvas: the same call that paints the corner minimap can paint a
 * thumbnail of any document snapshot (e.g. a past execution's frozen
 * graph), because nothing here reads live state - callers pass boxes,
 * states, and an optional viewport.
 *
 * Design language matches the main canvas: node boxes tint with the same
 * stateColors the node borders use (error red is the "where did it fail"
 * affordance), groups render as translucent color washes underneath, and
 * the viewport rectangle strokes in the selection color.
 *
 * All coordinates are CSS pixels; callers own devicePixelRatio scaling.
 */

import type { NodeRunState } from '@dinkster/core'
import type { Viewport } from './renderer.js'
import { canvasPaintTokens, type DesignTokens } from './tokens.js'
import { wheelZoomScale } from './zoom.js'

const paint = canvasPaintTokens.minimap

/** World -> minimap transform: mini = world * scale + offset. */
export interface MinimapTransform {
  readonly scale: number
  readonly offsetX: number
  readonly offsetY: number
}

export interface MinimapBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MinimapNode extends MinimapBox {
  readonly state?: NodeRunState
  readonly bypassed?: boolean
  readonly color?: string
}

export interface MinimapGroup extends MinimapBox {
  readonly color?: string
}

/** A labeled point of interest (e.g. a camera bookmark's world center). */
export interface MinimapMarker {
  readonly x: number
  readonly y: number
  /** Short label rendered inside the marker chip (a slot digit). */
  readonly label: string
}

export interface MinimapLink {
  readonly from: { readonly x: number; readonly y: number }
  readonly to: { readonly x: number; readonly y: number }
}

export interface MinimapPoint { readonly x: number; readonly y: number }

export interface MinimapInput {
  /** Target size in CSS pixels. */
  readonly width: number
  readonly height: number
  readonly nodes: readonly MinimapNode[]
  readonly groups?: readonly MinimapGroup[]
  /** Use scene identity colors; false paints every node with the token fallback. */
  readonly nodeColors?: boolean
  /** Give bypassed nodes their state fill instead of their ordinary node fill. */
  readonly renderBypassState?: boolean
  /** Paint error outlines; running and done outlines are never hidden. */
  readonly renderErrorState?: boolean
  /** Group paint toggle only; all node/group boxes still participate in fitting. */
  readonly visibility?: {
    readonly groups?: boolean
  }
  /** Straight world-coordinate segments drawn underneath nodes. */
  readonly links?: readonly MinimapLink[]
  readonly reroutes?: readonly MinimapPoint[]
  /**
   * Main-canvas viewport + its CSS size: when present, the visible world
   * rectangle strokes on top (the classic "where am I" affordance).
   */
  readonly viewport?: {
    readonly x: number
    readonly y: number
    readonly scale: number
    readonly canvasWidth: number
    readonly canvasHeight: number
  }
  /**
   * Labeled markers drawn on top (camera bookmark positions). They do NOT
   * join the fit bounds - they mark cameras, not content - and are clamped
   * into the panel so an off-content bookmark stays visible at the edge.
   */
  readonly markers?: readonly MinimapMarker[]
  /**
   * Remote participants' visible world rectangles (shared sessions): each
   * paints a thin colored frame in that actor's presence color, underneath
   * the local viewport rectangle (the local "where am I" affordance stays
   * dominant). Plain world rects - already world-space, unlike `viewport`
   * which arrives as a canvas transform. They do NOT join the fit bounds:
   * a peer parked off-content must not zoom everyone's overview out.
   */
  readonly remoteViewports?: readonly {
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
    readonly color: string
  }[]
  readonly tokens: DesignTokens
}

/**
 * Fit transform: every box visible, aspect preserved, centered, never
 * zoomed IN past 1:4 (tiny graphs stay recognizably small instead of
 * ballooning to fill the panel). Undefined when there is nothing to show.
 */
export function minimapTransform(
  boxes: readonly MinimapBox[],
  width: number,
  height: number,
  margin: number = paint.margin,
): MinimapTransform | undefined {
  if (boxes.length === 0) return undefined
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.width)
    maxY = Math.max(maxY, b.y + b.height)
  }
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  const scale = Math.min(paint.maxScale, (width - margin * 2) / w, (height - margin * 2) / h)
  // A panel no larger than its margins (or non-finite scene bounds) has no
  // usable drawing area: a zero/negative/non-finite scale would mirror or
  // blow up every minimap<->world mapping downstream.
  if (!Number.isFinite(scale) || scale <= 0) return undefined
  return {
    scale,
    offsetX: (width - w * scale) / 2 - minX * scale,
    offsetY: (height - h * scale) / 2 - minY * scale,
  }
}

/** Minimap CSS pixel -> world coordinates (click/drag-to-jump). */
export function minimapToWorld(t: MinimapTransform, mx: number, my: number): { x: number; y: number } {
  return { x: (mx - t.offsetX) / t.scale, y: (my - t.offsetY) / t.scale }
}

/** Center a minimap point in the main viewport, then apply one wheel step. */
export function minimapWheelViewport(
  t: MinimapTransform,
  mx: number,
  my: number,
  viewport: Viewport,
  canvasWidth: number,
  canvasHeight: number,
  deltaY: number,
): Viewport {
  const world = minimapToWorld(t, mx, my)
  const scale = wheelZoomScale(viewport.scale, deltaY)
  return {
    x: canvasWidth / 2 - world.x * scale,
    y: canvasHeight / 2 - world.y * scale,
    scale,
  }
}

export function minimapViewportRect(
  t: MinimapTransform,
  viewport: NonNullable<MinimapInput['viewport']>,
  panelWidth?: number,
  panelHeight?: number,
  inset: number = paint.viewportInset,
): MinimapBox {
  const x = (-viewport.x / viewport.scale) * t.scale + t.offsetX
  const y = (-viewport.y / viewport.scale) * t.scale + t.offsetY
  const right = x + (viewport.canvasWidth / viewport.scale) * t.scale
  const bottom = y + (viewport.canvasHeight / viewport.scale) * t.scale
  if (panelWidth === undefined || panelHeight === undefined) {
    return { x, y, width: right - x, height: bottom - y }
  }
  const clampX = (value: number) => Math.min(panelWidth - inset, Math.max(inset, value))
  const clampY = (value: number) => Math.min(panelHeight - inset, Math.max(inset, value))
  const clampedX = clampX(x)
  const clampedY = clampY(y)
  return {
    x: clampedX,
    y: clampedY,
    width: Math.max(0, clampX(right) - clampedX),
    height: Math.max(0, clampY(bottom) - clampedY),
  }
}

/** Persisted node colors are opaque presets; all other strings fall back safely. */
function minimapNodeColor(color: string | undefined, fallback: string): string {
  return color !== undefined && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color) ? color : fallback
}

/**
 * Paint the overview into any 2D context and return the transform used
 * (callers need it to map pointer events back to world space). Clears the
 * full target rectangle first; returns undefined for an empty scene.
 */
export function drawMinimap(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, input: MinimapInput): MinimapTransform | undefined {
  const tf = drawMinimapGraph(ctx, input)
  if (tf) drawMinimapOverlay(ctx, tf, input)
  return tf
}

/** Paint graph geometry without camera or bookmark overlays. */
export function drawMinimapGraph(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, input: MinimapInput): MinimapTransform | undefined {
  const t = input.tokens
  const { width, height } = input
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = t.colors.canvasBackground
  ctx.fillRect(0, 0, width, height)

  const boxes: MinimapBox[] = [...input.nodes, ...(input.groups ?? [])]
  if (boxes.length === 0 && input.viewport) {
    boxes.push({
      x: -input.viewport.x / input.viewport.scale,
      y: -input.viewport.y / input.viewport.scale,
      width: input.viewport.canvasWidth / input.viewport.scale,
      height: input.viewport.canvasHeight / input.viewport.scale,
    })
  }
  const tf = minimapTransform(boxes, width, height)
  if (!tf) return undefined
  const px = (wx: number) => wx * tf.scale + tf.offsetX
  const py = (wy: number) => wy * tf.scale + tf.offsetY

  if (input.visibility?.groups !== false) {
    for (const g of input.groups ?? []) {
      ctx.fillStyle = g.color ?? t.colors.nodeHeader
      ctx.fillRect(px(g.x), py(g.y), g.width * tf.scale, g.height * tf.scale)
    }
  }

  ctx.strokeStyle = t.colors.linkDefault
  ctx.fillStyle = t.colors.linkDefault
  ctx.lineWidth = paint.linkStroke
  for (const link of input.links ?? []) {
    ctx.beginPath()
    ctx.moveTo(px(link.from.x), py(link.from.y))
    ctx.lineTo(px(link.to.x), py(link.to.y))
    ctx.stroke()
    for (const point of [link.from, link.to]) {
      ctx.beginPath()
      ctx.arc(px(point.x), py(point.y), Math.max(tf.scale, paint.minPointRadius), 0, Math.PI * 2)
      ctx.fill()
    }
  }

  for (const n of input.nodes) {
    const ordinaryFill = input.nodeColors === false
      ? t.colors.widgetAffordance
      : minimapNodeColor(n.color, t.colors.widgetAffordance)
    ctx.fillStyle = n.bypassed && input.renderBypassState !== false
      ? paint.bypassFill
      : ordinaryFill
    // Boxes stay at least 2px so no node ever vanishes at overview scale.
    const x = px(n.x)
    const y = py(n.y)
    const w = Math.max(paint.minNodeSize, n.width * tf.scale)
    const h = Math.max(paint.minNodeSize, n.height * tf.scale)
    ctx.fillRect(x, y, w, h)
    if (
      (n.state === 'error' && input.renderErrorState !== false)
      || n.state === 'running'
      || n.state === 'done'
    ) {
      ctx.strokeStyle = t.stateColors[n.state]
      ctx.lineWidth = paint.stateStroke
      ctx.strokeRect(x, y, w, h)
    }
  }

  for (const r of input.reroutes ?? []) {
    ctx.beginPath()
    ctx.arc(px(r.x), py(r.y), Math.max(tf.scale, paint.minPointRadius), 0, Math.PI * 2)
    ctx.fillStyle = t.colors.linkDefault
    ctx.fill()
  }

  return tf
}

/** Paint camera rectangles and bookmarks over the retained graph drawing. */
export function drawMinimapOverlay(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  tf: MinimapTransform,
  input: Pick<MinimapInput, 'tokens' | 'width' | 'height' | 'viewport' | 'remoteViewports' | 'markers'>,
): void {
  const t = input.tokens
  const { width, height } = input
  const px = (wx: number) => wx * tf.scale + tf.offsetX
  const py = (wy: number) => wy * tf.scale + tf.offsetY
  // Remote frames first, local rectangle on top: at overview scale
  // overlapping viewports are common, and "where am I" must stay readable.
  for (const rv of input.remoteViewports ?? []) {
    ctx.strokeStyle = rv.color
    ctx.lineWidth = paint.remoteStroke
    ctx.globalAlpha = paint.remoteOpacity
    ctx.strokeRect(px(rv.x), py(rv.y), rv.w * tf.scale, rv.h * tf.scale)
    ctx.globalAlpha = 1
  }

  const vp = input.viewport
  if (vp) {
    const rect = minimapViewportRect(tf, vp, width, height)
    if (rect.width > 0 && rect.height > 0) {
      ctx.fillStyle = t.colors.nodeSelectedBorder
      ctx.globalAlpha = paint.viewportFillOpacity
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
      ctx.strokeStyle = t.colors.nodeSelectedBorder
      ctx.globalAlpha = paint.viewportStrokeOpacity
      ctx.lineWidth = paint.viewportStroke
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
      ctx.globalAlpha = 1
    }
  }

  const R = paint.markerRadius
  for (const m of input.markers ?? []) {
    // Clamped into the panel: an off-content camera still shows AT the edge
    // in its true direction instead of silently vanishing.
    const mx = Math.min(width - R - paint.markerInset, Math.max(R + paint.markerInset, px(m.x)))
    const my = Math.min(height - R - paint.markerInset, Math.max(R + paint.markerInset, py(m.y)))
    ctx.beginPath()
    ctx.arc(mx, my, R, 0, Math.PI * 2)
    ctx.fillStyle = t.colors.selection
    ctx.fill()
    ctx.fillStyle = t.colors.canvasBackground
    ctx.font = `${paint.markerFontWeight} ${paint.markerFontSize}px ${t.fontFamily}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(m.label, mx, my)
  }
}
