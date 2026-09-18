/**
 * Pure two-finger navigation math: pan follows the finger midpoint, zoom
 * follows the finger distance, and the world point under the previous
 * midpoint stays pinned to the next midpoint.
 */
import { describe, expect, it } from 'vitest'
import { touchNavViewport } from '../src/touch-nav.js'
import { MAX_SCALE, MIN_SCALE } from '../src/zoom.js'

describe('touchNavViewport', () => {
  it('translating both fingers equally pans without zooming', () => {
    const next = touchNavViewport(
      { x: 10, y: 20, scale: 2 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 5, y: 7 },
      { x: 105, y: 7 },
    )
    expect(next).toEqual({ x: 15, y: 27, scale: 2 })
  })

  it('pinching apart zooms about the finger midpoint', () => {
    const next = touchNavViewport(
      { x: 0, y: 0, scale: 1 },
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 100, y: 100 },
      { x: 300, y: 100 },
    )
    expect(next).toEqual({ x: -100, y: -100, scale: 2 })
  })

  it('keeps the world point under the previous midpoint pinned to the next midpoint', () => {
    const viewport = { x: 37, y: -12, scale: 0.8 }
    const prevA = { x: 40, y: 260 }
    const prevB = { x: 310, y: 90 }
    const nextA = { x: 90, y: 240 }
    const nextB = { x: 250, y: 120 }
    const next = touchNavViewport(viewport, prevA, prevB, nextA, nextB)
    const worldX = ((prevA.x + prevB.x) / 2 - viewport.x) / viewport.scale
    const worldY = ((prevA.y + prevB.y) / 2 - viewport.y) / viewport.scale
    expect(next.x + worldX * next.scale).toBeCloseTo((nextA.x + nextB.x) / 2, 10)
    expect(next.y + worldY * next.scale).toBeCloseTo((nextA.y + nextB.y) / 2, 10)
  })

  it('clamps zoom-in to the shared maximum scale', () => {
    const next = touchNavViewport(
      { x: 0, y: 0, scale: 3 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    )
    expect(next.scale).toBe(MAX_SCALE)
  })

  it('clamps zoom-out to the shared minimum scale', () => {
    const next = touchNavViewport(
      { x: 0, y: 0, scale: 0.06 },
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    )
    expect(next.scale).toBe(MIN_SCALE)
  })

  it('a degenerate previous distance pans without zooming', () => {
    const next = touchNavViewport(
      { x: 0, y: 0, scale: 1 },
      { x: 50, y: 50 },
      { x: 50, y: 50 },
      { x: 60, y: 70 },
      { x: 80, y: 70 },
    )
    expect(next).toEqual({ x: 20, y: 20, scale: 1 })
  })
})
