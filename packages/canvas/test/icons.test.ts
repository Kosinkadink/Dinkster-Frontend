import { beforeAll, describe, expect, it, vi } from 'vitest'

import { paintSeedControllerIcon, paintToolboxIcon } from '../src/icons.js'

beforeAll(() => {
  vi.stubGlobal('Path2D', class Path2D {
    constructor(readonly d: string) {}
  })
})

function record() {
  const calls: { method: string; args: unknown[]; strokeStyle: string; fillStyle: string }[] = []
  const state = { strokeStyle: '', fillStyle: '' }
  const ctx = new Proxy(state as unknown as CanvasRenderingContext2D, {
    get(target, prop) {
      if (prop === 'strokeStyle') return target.strokeStyle
      return (...args: unknown[]) => calls.push({
        method: String(prop), args, strokeStyle: String(target.strokeStyle), fillStyle: String(target.fillStyle),
      })
    },
    set(target, prop, value) {
      Reflect.set(target, prop, value)
      return true
    },
  })
  return { ctx, calls }
}

describe('paintToolboxIcon', () => {
  it('scales and translates Lucide strokes inside the button rect', () => {
    const { ctx, calls } = record()
    paintToolboxIcon(ctx, 'trash-2', 10, 20, 22, '#aaa')
    expect(calls.find((c) => c.method === 'translate')?.args).toEqual([14.4, 24.4])
    const scale = calls.find((c) => c.method === 'scale')?.args[0] as number
    expect(scale).toBeCloseTo(0.55)
    expect(calls.filter((c) => c.method === 'stroke').length).toBeGreaterThan(0)
    expect(calls.find((c) => c.method === 'stroke')?.strokeStyle).toBe('#aaa')
  })

  it('uses the supplied active-state color for every stroke', () => {
    const { ctx, calls } = record()
    paintToolboxIcon(ctx, 'volume-x', 0, 0, 22, '#181818')
    expect(calls.filter((c) => c.method === 'stroke').every((c) => c.strokeStyle === '#181818')).toBe(true)
  })

  it.each([
    ['play-to', 2],
    ['play-from', 2],
    ['play-between', 3],
  ] as const)('paints every stroke in the %s partial-execution glyph', (icon, strokes) => {
    const { ctx, calls } = record()
    paintToolboxIcon(ctx, icon, 0, 0, 22, '#aaa')
    expect(calls.filter((call) => call.method === 'stroke')).toHaveLength(strokes)
  })

  it('paints every dot in the vertical-ellipsis glyph', () => {
    const { ctx, calls } = record()
    paintToolboxIcon(ctx, 'ellipsis-vertical', 0, 0, 28, '#aaa')
    expect(calls.filter((call) => call.method === 'stroke')).toHaveLength(3)
  })

  it.each([
    ['renderer fallback', '#aaaaaa'],
    ['shared selection', '#355c7d'],
    ['dark supplied color', '#181818'],
    ['light supplied color', '#ffffff'],
  ] as const)('paints the color-selector as a solid circle with the %s color', (_state, color) => {
    const { ctx, calls } = record()
    paintToolboxIcon(ctx, 'circle', 0, 0, 28, color)
    expect(calls.find((call) => call.method === 'arc')).toBeDefined()
    expect(calls.filter((call) => call.method === 'fill')).toEqual([
      expect.objectContaining({ fillStyle: color }),
    ])
    expect(calls.filter((call) => call.method === 'stroke')).toEqual([])
  })
})

describe('paintSeedControllerIcon', () => {
  it.each([
    ['fixed', 2],
    ['increment', 2],
    ['decrement', 1],
    ['randomize', 6],
  ] as const)('paints every SVG element in the %s glyph', (mode, elementCount) => {
    const { ctx, calls } = record()
    paintSeedControllerIcon(ctx, mode, 0, 0, 16, '#aaa')
    expect(calls.filter((call) => call.method === 'stroke')).toHaveLength(elementCount)
  })

  it.each(['fixed', 'increment', 'decrement', 'randomize'] as const)(
    'keeps the %s glyph stroke transform inside a 16px chip', (mode) => {
      const { ctx, calls } = record()
      paintSeedControllerIcon(ctx, mode, 0, 0, 16, '#aaa')
      const translate = calls.find((call) => call.method === 'translate')!.args
      const scale = calls.find((call) => call.method === 'scale')!.args[0] as number
      // Lucide coordinates occupy 0..24. Include half of its 2px stroke
      // after scaling when proving the transformed glyph stays in the chip.
      expect(Number(translate[0]) - scale).toBeGreaterThanOrEqual(0)
      expect(Number(translate[1]) - scale).toBeGreaterThanOrEqual(0)
      expect(Number(translate[0]) + 24 * scale + scale).toBeLessThanOrEqual(16)
      expect(Number(translate[1]) + 24 * scale + scale).toBeLessThanOrEqual(16)
    },
  )
})
