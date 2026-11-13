import { describe, expect, it } from 'vitest'
import { curveInterpolator, isCurveValue } from '../src/kinds.js'

describe('CURVE values', () => {
  it('accepts legacy linear records and both authored interpolation modes', () => {
    expect(isCurveValue({ points: [{ position: 0, value: 2 }] })).toBe(true)
    expect(isCurveValue({ interpolation: 'linear', points: [{ position: 0, value: 0 }] })).toBe(true)
    expect(isCurveValue({ interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] })).toBe(true)
  })

  it('requires finite strictly increasing object points within cardinality bounds', () => {
    expect(isCurveValue({ points: [] })).toBe(false)
    expect(isCurveValue({ points: [[0, 0]] })).toBe(false)
    expect(isCurveValue({ points: [{ position: 1, value: 0 }, { position: 1, value: 1 }] })).toBe(false)
    expect(isCurveValue({ points: [{ position: 0, value: Number.NaN }] })).toBe(false)
    expect(isCurveValue({ points: [{ position: 0, value: 0, extra: true }] })).toBe(false)
    expect(isCurveValue({ points: [{ position: 0, value: 0 }], extra: true })).toBe(false)
  })

  it.each([
    [[{ position: 0, value: 0 }, { position: 1, value: 2 }, { position: 3, value: 3 }], 0.5, 1.09375],
    [[{ position: 0, value: 0 }, { position: 1, value: 2 }, { position: 3, value: 3 }], 2, 2.6875],
    [[{ position: 0, value: 0 }, { position: 1, value: 2 }, { position: 2, value: 0 }], 0.5, 1.25],
    [[{ position: 0, value: 1 }, { position: 1, value: 1 }, { position: 2, value: 3 }], 1.5, 1.75],
    [[{ position: -2, value: -4 }, { position: -1, value: -1 }, { position: 2, value: 2 }], 0, 0.4444444444444444],
  ] as const)('matches the maintained monotone cubic reference', (points, position, expected) => {
    expect(curveInterpolator({ interpolation: 'monotone_cubic', points })(position)).toBeCloseTo(expected)
  })

  it('preserves legacy linear interpolation and clamps outside the point domain', () => {
    const interpolate = curveInterpolator({ points: [{ position: 2, value: 4 }, { position: 4, value: 10 }] })
    expect(interpolate(3)).toBe(7)
    expect(interpolate(-1)).toBe(4)
    expect(interpolate(20)).toBe(10)
  })

})
