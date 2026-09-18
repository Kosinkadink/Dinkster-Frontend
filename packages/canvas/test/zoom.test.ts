import { describe, expect, it } from 'vitest'
import { MAX_SCALE, MIN_SCALE, wheelNavigationViewport, wheelZoomScale } from '../src/zoom.js'

describe('wheelNavigationViewport', () => {
  it('keeps the default cursor-anchored zoom behavior and ignores horizontal delta', () => {
    const viewport = { x: 20, y: -10, scale: 1.25 }
    const input = {
      screenX: 300,
      screenY: 180,
      deltaX: 90,
      deltaY: 120,
      deltaMode: 2,
      pageWidth: 640,
      pageHeight: 480,
      ctrlKey: false,
    }
    const scale = wheelZoomScale(viewport.scale, input.deltaY)

    expect(wheelNavigationViewport(viewport, input, 'zoom')).toEqual({
      x: input.screenX - ((input.screenX - viewport.x) / viewport.scale) * scale,
      y: input.screenY - ((input.screenY - viewport.y) / viewport.scale) * scale,
      scale,
    })
  })

  it('pans by both ordinary wheel deltas without changing scale', () => {
    expect(wheelNavigationViewport(
      { x: 20, y: -10, scale: 1.25 },
      {
        screenX: 300,
        screenY: 180,
        deltaX: 40,
        deltaY: -60,
        deltaMode: 0,
        pageWidth: 640,
        pageHeight: 480,
        ctrlKey: false,
      },
      'pan',
    )).toEqual({ x: -20, y: 50, scale: 1.25 })
  })

  it('normalizes line and page deltas for pan mode', () => {
    const viewport = { x: 20, y: -10, scale: 1.25 }
    const input = {
      screenX: 300,
      screenY: 180,
      deltaX: 2,
      deltaY: 3,
      deltaMode: 1,
      pageWidth: 640,
      pageHeight: 480,
      ctrlKey: false,
    }

    expect(wheelNavigationViewport(viewport, input, 'pan')).toEqual({ x: -12, y: -58, scale: 1.25 })
    expect(wheelNavigationViewport(viewport, {
      ...input,
      deltaX: 1,
      deltaY: -1,
      deltaMode: 2,
    }, 'pan')).toEqual({ x: -620, y: 470, scale: 1.25 })
  })

  it('uses cursor-anchored clamped zoom for Ctrl+wheel in pan mode', () => {
    const viewport = { x: 10, y: 20, scale: 3 }
    const input = {
      screenX: 200,
      screenY: 100,
      deltaX: 75,
      deltaY: -10_000,
      deltaMode: 0,
      pageWidth: 640,
      pageHeight: 480,
      ctrlKey: true,
    }
    const next = wheelNavigationViewport(viewport, input, 'pan')

    expect(next.scale).toBe(MAX_SCALE)
    expect((input.screenX - next.x) / next.scale).toBeCloseTo((input.screenX - viewport.x) / viewport.scale)
    expect((input.screenY - next.y) / next.scale).toBeCloseTo((input.screenY - viewport.y) / viewport.scale)
    expect(wheelNavigationViewport(viewport, { ...input, deltaY: 10_000 }, 'pan').scale).toBe(MIN_SCALE)
  })
})
