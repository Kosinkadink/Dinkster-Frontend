import { describe, expect, it } from 'vitest'
import { placeFloatingSurface } from '../src/floating-surface.js'

const bounds = { left: 0, top: 0, right: 800, bottom: 600 }

describe('floating surface placement', () => {
  it('places block surfaces on the larger side and clamps long content', () => {
    expect(placeFloatingSurface({
      surface: { width: 240, height: 500 },
      anchor: { left: 700, top: 450, right: 760, bottom: 482 },
      bounds,
      direction: 'block',
      margin: 8,
      gap: 4,
      maxHeight: 280,
      preferredHeight: 160,
    })).toEqual({ left: 552, top: 166, width: 240, maxWidth: 784, maxHeight: 280 })
  })

  it('flips inline surfaces and keeps them inside narrow bounds', () => {
    expect(placeFloatingSurface({
      surface: { width: 320, height: 200 },
      anchor: { left: 310, top: 160, right: 350, bottom: 190 },
      bounds: { left: 0, top: 0, right: 360, bottom: 240 },
      direction: 'inline',
      margin: 8,
      gap: 4,
    })).toEqual({ left: 8, top: 32, width: 320, maxWidth: 344, maxHeight: 224 })
  })

  it('centers point surfaces horizontally on the anchor when align is center', () => {
    expect(placeFloatingSurface({
      surface: { width: 300, height: 200 },
      anchor: { left: 400, top: 100, right: 400, bottom: 100 },
      bounds,
      direction: 'point',
      align: 'center',
      margin: 8,
      gap: 0,
    })).toEqual({ left: 250, top: 100, width: 300, maxWidth: 784, maxHeight: 584 })
  })

  it('clamps center-aligned point surfaces at the bounds edges', () => {
    expect(placeFloatingSurface({
      surface: { width: 300, height: 200 },
      anchor: { left: 40, top: 100, right: 40, bottom: 100 },
      bounds,
      direction: 'point',
      align: 'center',
      margin: 8,
      gap: 0,
    }).left).toBe(8)
    expect(placeFloatingSurface({
      surface: { width: 300, height: 200 },
      anchor: { left: 780, top: 100, right: 780, bottom: 100 },
      bounds,
      direction: 'point',
      align: 'center',
      margin: 8,
      gap: 0,
    }).left).toBe(492)
  })

  it('clamps point surfaces to offset bounds', () => {
    expect(placeFloatingSurface({
      surface: { width: 300, height: 400 },
      anchor: { left: 620, top: 490, right: 620, bottom: 490 },
      bounds: { left: 100, top: 50, right: 700, bottom: 550 },
      direction: 'point',
      margin: 8,
      gap: 0,
      maxHeight: 280,
    })).toEqual({ left: 392, top: 262, width: 300, maxWidth: 584, maxHeight: 280 })
  })
})
