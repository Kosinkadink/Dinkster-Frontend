import { describe, expect, it } from 'vitest'
import { curveInterpolator, curveKind, isCurveValue } from '../src/kinds.js'

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

  it('provides the editor node default', () => {
    expect(curveKind.defaultValue({ widgetType: 'CURVE', options: {} })).toEqual({ interpolation: 'monotone_cubic', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }] })
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

  it.each(['linear', 'monotone_cubic'] as const)(
    'keeps %s interpolation finite across extreme coordinates and values',
    (interpolation) => {
      const interpolate = curveInterpolator({
        interpolation,
        points: [
          { position: -1e308, value: -1e308 },
          { position: -1, value: 0 },
          { position: Number.MIN_VALUE, value: Number.MIN_VALUE },
          { position: 1e308, value: 1e308 },
        ],
      })
      for (const position of [-5e307, -0.5, Number.MIN_VALUE, 5e307]) {
        expect(interpolate(position)).toSatisfy(Number.isFinite)
      }
    },
  )

  it('keeps monotone interpolation finite when adjacent secants span the float range', () => {
    const interpolate = curveInterpolator({
      interpolation: 'monotone_cubic',
      points: [
        { position: 0, value: -Number.MAX_VALUE },
        { position: 0.33, value: 0 },
        { position: 0.33 + Number.EPSILON, value: Number.MIN_VALUE },
        { position: 1, value: Number.MAX_VALUE },
      ],
    })
    for (const [position, expected] of [
      [0.1, -0.6329688065225256],
      [0.2, -0.2492417285805716],
      [0.3, -0.01577761081893314],
      [0.4, 0.02069070996099908],
      [0.5, 0.11242406812008107],
      [0.75, 0.5395876487466875],
      [0.9, 0.8317944693994942],
    ] as const) {
      const value = interpolate(position)
      expect(value).toSatisfy(Number.isFinite)
      expect(value / Number.MAX_VALUE).toBeCloseTo(expected, 12)
    }
  })
})
