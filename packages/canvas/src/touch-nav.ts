import { clampScale } from './zoom.js'

/** A finger position in canvas screen coordinates. */
export interface TouchNavPoint {
  readonly x: number
  readonly y: number
}

export interface TouchNavViewport {
  readonly x: number
  readonly y: number
  readonly scale: number
}

/**
 * Two-finger navigation step: given the previous and next screen positions of
 * both fingers, produce the viewport that pans with the midpoint and zooms
 * with the finger distance, keeping the world point under the previous
 * midpoint pinned to the next midpoint. Scale clamps to the shared wheel-zoom
 * limits; a degenerate previous distance (fingers reported at one point)
 * contributes no zoom.
 */
export function touchNavViewport(
  viewport: TouchNavViewport,
  prevA: TouchNavPoint,
  prevB: TouchNavPoint,
  nextA: TouchNavPoint,
  nextB: TouchNavPoint,
): TouchNavViewport {
  const prevDist = Math.hypot(prevB.x - prevA.x, prevB.y - prevA.y)
  const nextDist = Math.hypot(nextB.x - nextA.x, nextB.y - nextA.y)
  const factor = prevDist < 1e-6 ? 1 : nextDist / prevDist
  const scale = clampScale(viewport.scale * factor)
  const prevCX = (prevA.x + prevB.x) / 2
  const prevCY = (prevA.y + prevB.y) / 2
  const nextCX = (nextA.x + nextB.x) / 2
  const nextCY = (nextA.y + nextB.y) / 2
  return {
    x: nextCX - ((prevCX - viewport.x) / viewport.scale) * scale,
    y: nextCY - ((prevCY - viewport.y) / viewport.scale) * scale,
    scale,
  }
}
