import { describe, expect, it } from 'vitest'
import {
  animationFrameAt,
  containRect,
  splitPreviewRect,
  type NodePreview,
  type NodePreviewAnimation,
} from '../src/previews.js'

const preview = (width: number, height: number): NodePreview =>
  ({ image: {} as CanvasImageSource, width, height })

describe('containRect', () => {
  const region = { x: 10, y: 20, width: 200, height: 100 }

  it('aspect-fits and centers in both axes', () => {
    expect(containRect(region, preview(100, 100))).toEqual({ x: 60, y: 20, width: 100, height: 100 })
    expect(containRect(region, preview(400, 100))).toEqual({ x: 10, y: 45, width: 200, height: 50 })
  })

  it('upscales a smaller source to fill the panel', () => {
    // 2:1 source in the 2:1 region fills it exactly.
    expect(containRect(region, preview(40, 20))).toEqual({ x: 10, y: 20, width: 200, height: 100 })
    // Square source fills the limiting axis and centers on the other.
    expect(containRect(region, preview(20, 20))).toEqual({ x: 60, y: 20, width: 100, height: 100 })
  })

  it('falls back to safe region geometry for invalid dimensions', () => {
    expect(containRect(region, preview(0, 50))).toEqual(region)
    expect(containRect(region, preview(Number.NaN, 50))).toEqual(region)
  })
})

describe('splitPreviewRect', () => {
  it('reserves the caption below the media without shrinking either width', () => {
    expect(splitPreviewRect({ x: 10, y: 20, width: 200, height: 202 }, 22)).toEqual({
      media: { x: 10, y: 20, width: 200, height: 180 },
      caption: { x: 10, y: 200, width: 200, height: 22 },
    })
  })
})

describe('animationFrameAt', () => {
  const f0 = { id: 0 } as unknown as CanvasImageSource
  const f1 = { id: 1 } as unknown as CanvasImageSource
  const f2 = { id: 2 } as unknown as CanvasImageSource
  const ring = (frames: (CanvasImageSource | undefined)[], fps = 2): NodePreviewAnimation =>
    ({ frames, fps })

  it('selects the slot for the elapsed time and wraps around the ring', () => {
    const a = ring([f0, f1, f2], 2) // 500ms per slot
    expect(animationFrameAt(a, 0)).toBe(f0)
    expect(animationFrameAt(a, 499)).toBe(f0)
    expect(animationFrameAt(a, 500)).toBe(f1)
    expect(animationFrameAt(a, 1000)).toBe(f2)
    expect(animationFrameAt(a, 1500)).toBe(f0) // wrapped
  })

  it('falls back to the nearest earlier filled slot when frames are missing', () => {
    const a = ring([f0, undefined, f2], 2)
    expect(animationFrameAt(a, 500)).toBe(f0) // slot 1 empty -> slot 0
    expect(animationFrameAt(a, 1000)).toBe(f2)
  })

  it('wraps backward past slot zero to find a filled slot', () => {
    const a = ring([undefined, undefined, f2], 2)
    expect(animationFrameAt(a, 0)).toBe(f2) // slot 0 empty -> wraps back to 2
  })

  it('yields undefined for an empty ring or unusable time', () => {
    expect(animationFrameAt(ring([undefined, undefined]), 100)).toBeUndefined()
    expect(animationFrameAt(ring([]), 100)).toBeUndefined()
    expect(animationFrameAt(ring([f0]), Number.NaN)).toBeUndefined()
  })

  it('clamps negative time to the first slot', () => {
    expect(animationFrameAt(ring([f0, f1]), -250)).toBe(f0)
  })
})
