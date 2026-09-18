/**
 * Minimap: corner overview painted from the SAME installed scene and
 * occurrence-aware states the main canvas renders - no parallel state
 * derivation, so live and frozen tabs both depict exactly what the big
 * canvas shows (error red included). drawMinimap is a pure function; this
 * factory owns only the DPR backing store, the paint schedule, and the
 * pointer/wheel wiring.
 *
 * Framework-free by design: the host supplies the reactive context and
 * decides when to call
 * paint() (scene installs, overlay refreshes, resizes, settings toggles)
 * and computes bookmark markers with whatever signal-tracking discipline
 * its call site needs. This module never subscribes to anything except the
 * renderer's viewport.
 */

import {
  drawMinimap,
  minimapToWorld,
  minimapWheelViewport,
  defaultTokens,
  type CanvasRenderer,
  type MinimapTransform,
} from '@dinkster/canvas'
import type { NodeProgress } from '@dinkster/core'
import type { SettingsRegistry } from './settings.js'

const MINIMAP_W = 250
const MINIMAP_H = 200

/** Where the minimap settings popover opens relative to the corner cluster. */
export interface MinimapMenuPlacement {
  readonly above: boolean
  /** Height cap (CSS px) when the popover opens above the cluster. */
  readonly maxHeight?: number
}

/**
 * The settings popover prefers the space beside (left of) the corner cluster
 * and opens above it when the stage leaves no room there - a narrow window
 * and an open side panel both shrink the stage the cluster floats in, so the
 * decision is measured, not keyed on viewport width. Above placement caps
 * the popover height to the space between the usable stage top and the
 * cluster so it never covers the minimap or escapes the stage's clipping
 * box. Coordinates are viewport CSS px; `stage.top` is the highest edge the
 * popover may reach (the caller lowers it below any floating top toolbar).
 */
export function minimapMenuPlacement(
  controls: { readonly left: number; readonly top: number },
  stage: { readonly left: number; readonly top: number },
): MinimapMenuPlacement {
  const menuWidth = 210 // .minimap-menu border-box width
  const gap = 8 // clearance between the popover and the cluster
  const margin = 8 // minimum clearance from the stage edge
  if (controls.left - stage.left >= menuWidth + gap + margin) return { above: false }
  return { above: true, maxHeight: Math.max(120, controls.top - stage.top - gap - margin) }
}

/** Bookmark slot digit at a saved camera's world center. */
export interface MinimapMarker {
  readonly x: number
  readonly y: number
  readonly label: string
}

export interface MinimapHandle {
  /** Repaint synchronously from the renderer's installed scene. */
  paint(): void
  /** Replace the projected execution states used for node tinting. */
  setStates(states: Readonly<Record<string, NodeProgress>>): void
  dispose(): void
}

export function setupMinimap(deps: {
  /** The minimap canvas element. */
  canvas: HTMLCanvasElement
  /** The main canvas: viewport centering + zoom limits use its CSS size. */
  mainCanvas: HTMLCanvasElement
  renderer: CanvasRenderer
  settings: SettingsRegistry
  /** Bookmark markers for the CURRENT view; evaluated on every paint. */
  markers: () => readonly MinimapMarker[]
}): MinimapHandle {
  const { canvas, mainCanvas, renderer, settings } = deps
  let states: Readonly<Record<string, NodeProgress>> = {}
  let tf: MinimapTransform | undefined

  function paint(): void {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const width = canvas.clientWidth || MINIMAP_W
    const height = canvas.clientHeight || MINIMAP_H
    const backingWidth = Math.round(width * dpr)
    const backingHeight = Math.round(height * dpr)
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth
      canvas.height = backingHeight
    }
    ctx.save()
    ctx.scale(dpr, dpr)
    const sc = renderer.getScene()
    tf = drawMinimap(ctx, {
      markers: [...deps.markers()],
      width,
      height,
      nodes: sc.nodes.map((n) => {
        const state = states[n.id]?.state
        return {
          x: n.x,
          y: n.y,
          width: n.layout.width,
          height: n.layout.height,
          bypassed: n.node.mode === 'bypassed',
          ...(n.color !== undefined ? { color: n.color } : {}),
          ...(state !== undefined ? { state } : {}),
        }
      }),
      groups: sc.groups.map((g) => ({
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
        ...(g.color !== undefined ? { color: g.color } : {}),
      })),
      nodeColors: settings.get<boolean>('canvas.minimap.nodes'),
      renderBypassState: settings.get<boolean>('canvas.minimap.bypass'),
      renderErrorState: settings.get<boolean>('canvas.minimap.errors'),
      visibility: { groups: settings.get<boolean>('canvas.minimap.groups') },
      links: settings.get<boolean>('canvas.minimap.noodles') ? sc.links.filter((link) => link.hidden !== true).map((link) => ({
        from: { x: link.x1, y: link.y1 },
        to: { x: link.x2, y: link.y2 },
      })) : [],
      reroutes: settings.get<boolean>('canvas.minimap.reroutes') ? sc.reroutes.map((r) => ({ x: r.x, y: r.y })) : [],
      viewport: {
        ...renderer.getViewport(),
        canvasWidth: mainCanvas.clientWidth,
        canvasHeight: mainCanvas.clientHeight,
      },
      // Remote participants' viewports (shared sessions): read from the same
      // installed presence set the main canvas paints cursors from, so the
      // two surfaces can never disagree about who is where.
      remoteViewports: renderer.getPresence().flatMap((a) =>
        a.view !== undefined ? [{ ...a.view, color: a.color }] : [],
      ),
      tokens: defaultTokens,
    })
    ctx.restore()
  }

  let frame = 0
  const schedule = (): void => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; paint() })
  }
  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : undefined
  resizeObserver?.observe(canvas)
  const unsubscribeViewport = renderer.onViewportChange(schedule)

  const localPoint = (e: Pick<MouseEvent, 'clientX' | 'clientY'>): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect()
    return {
      x: e.clientX - rect.left - canvas.clientLeft,
      y: e.clientY - rect.top - canvas.clientTop,
    }
  }

  /** Center the clicked/dragged minimap point in the main canvas, keeping zoom. */
  function jump(e: PointerEvent): void {
    if (!tf) return
    const point = localPoint(e)
    const w = minimapToWorld(tf, point.x, point.y)
    const vp = renderer.getViewport()
    renderer.setViewport({
      x: mainCanvas.clientWidth / 2 - w.x * vp.scale,
      y: mainCanvas.clientHeight / 2 - w.y * vp.scale,
      scale: vp.scale,
    })
  }
  let dragging = false
  const onPointerDown = (e: PointerEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragging = true
    canvas.setPointerCapture(e.pointerId)
    jump(e)
  }
  const onPointerMove = (e: PointerEvent): void => {
    if (dragging) jump(e)
  }
  const onPointerUp = (e: PointerEvent): void => {
    dragging = false
    if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
  }
  // Browser-cancelled gestures deliver no pointerup, so both cancellation
  // and capture loss must end the drag explicitly.
  const onPointerCancel = (): void => { dragging = false }
  const onLostPointerCapture = (): void => { dragging = false }
  // A minimap wheel first jumps to the pointed world location, then zooms
  // around the now-centered point with the main canvas curve and limits.
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (!tf) return
    const point = localPoint(e)
    renderer.setViewport(minimapWheelViewport(
      tf,
      point.x,
      point.y,
      renderer.getViewport(),
      mainCanvas.clientWidth,
      mainCanvas.clientHeight,
      e.deltaY,
    ))
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerCancel)
  canvas.addEventListener('lostpointercapture', onLostPointerCapture)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  paint()

  return {
    paint,
    setStates(next) {
      states = next
    },
    dispose() {
      if (frame) cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      unsubscribeViewport()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('lostpointercapture', onLostPointerCapture)
      canvas.removeEventListener('wheel', onWheel)
    },
  }
}
