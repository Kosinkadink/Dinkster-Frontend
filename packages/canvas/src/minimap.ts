/**
 * Minimap: a pure overview renderer for one graph view. Deliberately a
 * FUNCTION over geometry + overlay state, not a widget wired into the live
 * canvas: the same call that paints the corner minimap can paint a
 * thumbnail of any document snapshot (e.g. a past execution's frozen
 * graph), because nothing here reads live state - callers pass boxes,
 * states, and an optional viewport.
 *
 * It draws like a small picture of the graph: rounded node boxes with a
 * title line, wires as the main canvas's curves in their type colors, and
 * groups as a soft frame. Run states outline a box in the same stateColors
 * the node borders use (error red is the "where did it fail" affordance).
 * Outside the current view the picture is dimmed under a light frame.
 *
 * All coordinates are CSS pixels; callers own devicePixelRatio scaling.
 */

import type { NodeRunState } from '@dinkster/core'
import type { Viewport } from './renderer.js'
import { linkControlOffset } from './hit.js'
import { canvasPaintTokens, typeColor, type DesignTokens } from './tokens.js'
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
  /** Concrete type name: the wire takes that type's color. */
  readonly typeName?: string
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
  /** Wires drawn underneath nodes, as the main canvas's curves. */
  readonly links?: readonly MinimapLink[]
  /**
   * Wires in their type colors and nodes with a title line; false draws
   * every wire in one grey and no title lines.
   */
  readonly linkColors?: boolean
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
  const linkColors = input.linkColors !== false

  if (input.visibility?.groups !== false) {
    ctx.lineWidth = paint.groupStroke
    for (const g of input.groups ?? []) {
      const color = g.color ?? t.colors.groupDefault
      ctx.beginPath()
      ctx.roundRect(px(g.x), py(g.y), g.width * tf.scale, g.height * tf.scale, paint.groupRadius)
      ctx.fillStyle = color
      ctx.globalAlpha = paint.groupFillOpacity
      ctx.fill()
      ctx.strokeStyle = color
      ctx.globalAlpha = paint.groupStrokeOpacity
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // Box geometry first: whether most boxes are too small to read decides
  // between the drawn look and plain blocks with straight wires.
  const nodes = input.nodes.map((n) => {
    const w = Math.max(paint.minNodeSize, n.width * tf.scale)
    const h = Math.max(paint.minNodeSize, n.height * tf.scale)
    return { n, x: px(n.x), y: py(n.y), w, h, rounded: w >= paint.roundedMinSize && h >= paint.roundedMinSize }
  })
  const curved = nodes.filter((box) => box.rounded).length * 2 >= nodes.length
  const nodeRadius = (box: { readonly w: number; readonly h: number }): number =>
    Math.min(paint.nodeRadius, box.w * paint.nodeRadiusShare, box.h * paint.nodeRadiusShare)

  // One path per wire color keeps a large graph to a handful of strokes.
  const wires = new Map<string, MinimapLink[]>()
  for (const link of input.links ?? []) {
    const color = linkColors && link.typeName !== undefined ? typeColor(t, link.typeName) : t.colors.linkDefault
    const list = wires.get(color)
    if (list) list.push(link)
    else wires.set(color, [link])
  }
  ctx.lineWidth = paint.linkStroke
  ctx.lineCap = 'round'
  ctx.globalAlpha = linkColors ? paint.linkOpacity : paint.quietLinkOpacity
  for (const [color, links] of wires) {
    ctx.strokeStyle = color
    ctx.beginPath()
    for (const link of links) {
      const x1 = px(link.from.x)
      const y1 = py(link.from.y)
      const x2 = px(link.to.x)
      const y2 = py(link.to.y)
      ctx.moveTo(x1, y1)
      if (curved) {
        // The main canvas's curve, scaled: the same bend at overview size.
        const dx = linkControlOffset(link.from.x, link.to.x) * tf.scale
        ctx.bezierCurveTo(x1 + dx, y1, x2 - dx, y2, x2, y2)
      } else ctx.lineTo(x2, y2)
    }
    ctx.stroke()
  }
  ctx.globalAlpha = 1
  ctx.lineCap = 'butt'

  const fills = new Map<string, typeof nodes>()
  for (const box of nodes) {
    const n = box.n
    const fill = n.bypassed && input.renderBypassState !== false
      ? paint.bypassFill
      : input.nodeColors === false
        ? t.colors.widgetRaised
        : minimapNodeColor(n.color, t.colors.widgetRaised)
    const list = fills.get(fill)
    if (list) list.push(box)
    else fills.set(fill, [box])
  }
  for (const [fill, list] of fills) {
    ctx.fillStyle = fill
    ctx.beginPath()
    for (const box of list) {
      if (box.rounded) ctx.roundRect(box.x, box.y, box.w, box.h, nodeRadius(box))
      else ctx.rect(box.x, box.y, box.w, box.h)
    }
    ctx.fill()
  }

  const outlined = (box: (typeof nodes)[number]): string | undefined => {
    const state = box.n.state
    if ((state === 'error' && input.renderErrorState !== false) || state === 'running' || state === 'done') {
      return t.stateColors[state]
    }
    return box.rounded ? t.colors.nodeOutline : undefined
  }
  const outlines = new Map<string, typeof nodes>()
  for (const box of nodes) {
    const color = outlined(box)
    if (color === undefined) continue
    const list = outlines.get(color)
    if (list) list.push(box)
    else outlines.set(color, [box])
  }
  for (const [color, list] of outlines) {
    ctx.strokeStyle = color
    ctx.lineWidth = color === t.colors.nodeOutline ? paint.nodeStroke : paint.stateStroke
    ctx.beginPath()
    for (const box of list) {
      if (box.rounded) ctx.roundRect(box.x, box.y, box.w, box.h, nodeRadius(box))
      else ctx.rect(box.x, box.y, box.w, box.h)
    }
    ctx.stroke()
  }

  if (linkColors) {
    const titled = nodes.filter((box) => box.w >= paint.titleMinWidth && box.h >= paint.titleMinHeight)
    if (titled.length > 0) {
      ctx.fillStyle = t.colors.valueMark
      ctx.beginPath()
      for (const box of titled) {
        ctx.roundRect(
          box.x + paint.titleInset,
          box.y + paint.titleInset,
          Math.max(paint.titleInset + 1, (box.w - paint.titleInset * 2) * paint.titleWidthRatio),
          paint.titleHeight,
          paint.titleHeight / 2,
        )
      }
      ctx.fill()
    }
  }

  if ((input.reroutes ?? []).length > 0) {
    ctx.fillStyle = t.colors.linkDefault
    ctx.beginPath()
    for (const r of input.reroutes ?? []) {
      const radius = Math.max(tf.scale, paint.minPointRadius)
      ctx.moveTo(px(r.x) + radius, py(r.y))
      ctx.arc(px(r.x), py(r.y), radius, 0, Math.PI * 2)
    }
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
      // Everything outside the view is dimmed, so the frame reads as a window.
      ctx.beginPath()
      ctx.rect(0, 0, width, height)
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, paint.viewportRadius)
      ctx.fillStyle = t.colors.canvasBackground
      ctx.globalAlpha = paint.outsideViewOpacity
      ctx.fill('evenodd')
      ctx.beginPath()
      ctx.roundRect(rect.x, rect.y, rect.width, rect.height, paint.viewportRadius)
      ctx.strokeStyle = t.colors.title
      ctx.globalAlpha = paint.viewportStrokeOpacity
      ctx.lineWidth = paint.viewportStroke
      ctx.stroke()
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
