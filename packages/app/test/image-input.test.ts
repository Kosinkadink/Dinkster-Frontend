import { describe, expect, it } from 'vitest'
import {
  imagePointerSamples,
  imageWheelNavigationViewport,
  ImageTouchNavigation,
  type ImagePointerSampleSource,
} from '../src/image-input.js'

const pointer = (overrides: Partial<ImagePointerSampleSource> = {}): ImagePointerSampleSource => ({
  clientX: 10,
  clientY: 20,
  pointerType: 'pen',
  pressure: 0.5,
  tiltX: 0,
  tiltY: 0,
  twist: 0,
  timeStamp: 1,
  ...overrides,
})

const sampleBounds = {
  left: 10,
  top: 20,
  width: 200,
  height: 100,
  imageWidth: 400,
  imageHeight: 300,
}

describe('image pointer samples', () => {
  it('uses coalesced pen events in order with bounded pressure and orientation', () => {
    const samples = imagePointerSamples(pointer({
      getCoalescedEvents: () => [
        pointer({ clientX: 20, clientY: 30, timeStamp: 4, pressure: -1, tiltX: -100, tiltY: 20, twist: -3 }),
        pointer({ clientX: 40, clientY: 50, timeStamp: 5, pressure: 2, tiltX: 30, tiltY: 100, twist: 400 }),
      ],
    }), sampleBounds)
    expect(samples).toEqual([
      { x: 20, y: 30, time: 4, pressure: 0, tiltX: -90, tiltY: 20, twist: 0 },
      { x: 60, y: 90, time: 5, pressure: 1, tiltX: 30, tiltY: 90, twist: 359 },
    ])
  })

  it('uses the dispatch event as fallback and gives mouse a full-pressure round brush', () => {
    expect(imagePointerSamples(pointer({
      clientX: 110,
      clientY: 70,
      pointerType: 'mouse',
      pressure: 0,
      tiltX: 30,
      tiltY: -40,
      twist: 90,
      timeStamp: 9,
      getCoalescedEvents: () => [],
    }), sampleBounds)).toEqual([
      { x: 200, y: 150, time: 9, pressure: 1, tiltX: 0, tiltY: 0, twist: 0 },
    ])
  })
})

describe('image viewport input', () => {
  const bounds = { width: 1000, height: 800 }

  it('uses the shared line-mode pan policy on both axes', () => {
    expect(imageWheelNavigationViewport(
      { panX: 5, panY: -7, scale: 1.5 },
      {
        screenX: 200,
        screenY: 300,
        deltaX: 2,
        deltaY: -3,
        deltaMode: 1,
        pageWidth: bounds.width,
        pageHeight: bounds.height,
        ctrlKey: false,
      },
      bounds,
      'pan',
    )).toEqual({ panX: -27, panY: 41, scale: 1.5 })
  })

  it('anchors shared wheel zoom to the pointer', () => {
    const point = { x: 250, y: 300 }
    const before = { panX: 0, panY: 0, scale: 1 }
    const after = imageWheelNavigationViewport(before, {
      screenX: point.x,
      screenY: point.y,
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      pageWidth: bounds.width,
      pageHeight: bounds.height,
      ctrlKey: false,
    }, bounds, 'zoom')
    const beforeWorld = {
      x: (point.x - bounds.width / 2 - before.panX) / before.scale,
      y: (point.y - bounds.height / 2 - before.panY) / before.scale,
    }
    expect(bounds.width / 2 + after.panX + beforeWorld.x * after.scale).toBeCloseTo(point.x, 10)
    expect(bounds.height / 2 + after.panY + beforeWorld.y * after.scale).toBeCloseTo(point.y, 10)
  })

  it('pans with one finger and pinches with two while ignoring extra touches', () => {
    const nav = new ImageTouchNavigation()
    expect(nav.start(1, { x: 100, y: 100 })).toBe(true)
    expect(nav.move(1, { x: 125, y: 130 }, { panX: 0, panY: 0, scale: 1 }, bounds)).toEqual({
      panX: 25,
      panY: 30,
      scale: 1,
    })
    expect(nav.start(2, { x: 200, y: 100 })).toBe(true)
    expect(nav.start(3, { x: 300, y: 100 })).toBe(false)
    const pinched = nav.move(2, { x: 300, y: 100 }, { panX: 25, panY: 30, scale: 1 }, bounds)!
    expect(pinched.scale).toBeGreaterThan(1)
    nav.end(1)
    expect(nav.move(2, { x: 320, y: 120 }, pinched, bounds)).toEqual({
      panX: pinched.panX + 20,
      panY: pinched.panY + 20,
      scale: pinched.scale,
    })
  })
})
