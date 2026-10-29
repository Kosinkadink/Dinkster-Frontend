import { describe, expect, it } from 'vitest'
import {
  appendMemorySample,
  deviceBarSegments,
  diffHeatmapFlags,
  liveMemorySamples,
  MEMORY_HISTORY_LIMIT,
  MEMORY_LIVE_VIEWPORT_LIMIT,
  memoryDetailKey,
  overBudgetBytes,
  pageCellColor,
  pageFlagRanges,
  pageIsResident,
  PAGE_PULSE_TICKS,
  residencySegments,
  updateHeatmapState,
  type MemorySample,
} from '../src/memory-visualization.js'

const sample = (timestamp: number): MemorySample => ({ timestamp, footprintBytes: timestamp, reservedBytes: 0, capacityBytes: 1 })

describe('memory visualization history', () => {
  it('accepts samples exactly one second apart while rejecting a 999 ms duplicate', () => {
    const first = appendMemorySample([], sample(0))
    expect(appendMemorySample(first, sample(999))).toEqual(first)
    expect(appendMemorySample(first, sample(1000))).toEqual([sample(0), sample(1000)])
  })

  it('retains only the last two minutes after repeated wraparound', () => {
    let bounded: readonly MemorySample[] = []
    for (let timestamp = 0; timestamp <= 3000; timestamp += 1000) {
      bounded = appendMemorySample(bounded, sample(timestamp), 3)
    }
    expect(bounded.map((item) => item.timestamp)).toEqual([1000, 2000, 3000])

    let history: readonly MemorySample[] = []
    for (let timestamp = 0; timestamp <= 500_000; timestamp += 1000) {
      history = appendMemorySample(history, sample(timestamp))
      expect(history.length).toBeLessThanOrEqual(120)
    }

    expect(MEMORY_HISTORY_LIMIT).toBe(120)
    expect(MEMORY_LIVE_VIEWPORT_LIMIT).toBe(120)
    expect(history).toHaveLength(120)
    expect(history[0]?.timestamp).toBe(381_000)
    expect(history.at(-1)?.timestamp).toBe(500_000)
    expect(liveMemorySamples(history)).toEqual(history)
    expect(liveMemorySamples(history, 3).map((item) => item.timestamp)).toEqual([498_000, 499_000, 500_000])
  })

  it('expires old samples at the two-minute boundary during slow fallback polling', () => {
    expect(appendMemorySample([sample(0), sample(1)], sample(120_000))).toEqual([sample(1), sample(120_000)])
    let history: readonly MemorySample[] = []
    for (let timestamp = 0; timestamp <= 600_000; timestamp += 5000) history = appendMemorySample(history, sample(timestamp))
    expect(history).toHaveLength(24)
    expect(history[0]?.timestamp).toBe(485_000)
    expect(history.at(-1)?.timestamp).toBe(600_000)
  })
})

describe('memory visualization device bars', () => {
  it('computes non-overlapping governed and measured stacked bar segments', () => {
    const governor = {
      budgetBytes: 8 * 1024 ** 3, reservedBytes: 2 * 1024 ** 3,
      consumerFootprintBytes: 3 * 1024 ** 3, availableBytes: 3 * 1024 ** 3,
      measured: { freeBytes: 5 * 1024 ** 3, totalBytes: 12 * 1024 ** 3 },
      consumers: { models: 3 * 1024 ** 3 },
    }
    expect(deviceBarSegments(governor).map(({ key, bytes, fraction }) => ({ key, bytes, fraction }))).toEqual([
      { key: 'footprint', bytes: 3 * 1024 ** 3, fraction: 3 / 8 },
      { key: 'reserved', bytes: 2 * 1024 ** 3, fraction: 2 / 8 },
      { key: 'available', bytes: 3 * 1024 ** 3, fraction: 3 / 8 },
    ])
    const measured = deviceBarSegments({ ...governor, budgetBytes: null, availableBytes: null })
    expect(measured.map(({ key, bytes }) => ({ key, bytes }))).toEqual([
      { key: 'measured-used', bytes: 7 * 1024 ** 3 }, { key: 'measured-free', bytes: 5 * 1024 ** 3 },
    ])
    expect(residencySegments({ device: 3, pinned: 1 }).map((item) => item.fraction)).toEqual([.75, .25])
    const correctedFree = deviceBarSegments({ ...governor, budgetBytes: null, availableBytes: null, measured: { totalBytes: 10, freeBytes: 12 } })
    expect(correctedFree.reduce((sum, item) => sum + item.fraction, 0)).toBe(1)
    const over = { ...governor, budgetBytes: 1024, availableBytes: -2048 }
    expect(overBudgetBytes(over)).toBe(2048)
    expect(deviceBarSegments(over).reduce((sum, item) => sum + item.fraction, 0)).toBe(1)
  })

  it('keeps reported segments non-overlapping when reported available memory exceeds budget', () => {
    const segments = deviceBarSegments({
      budgetBytes: 8,
      consumerFootprintBytes: 5,
      reservedBytes: 4,
      availableBytes: 12,
      measured: null,
      consumers: {},
    })

    expect(segments.map((segment) => segment.bytes)).toEqual([5, 4, 12])
    expect(segments.reduce((total, segment) => total + segment.fraction, 0)).toBe(1)
    expect(segments.every((segment) => segment.fraction >= 0 && segment.fraction <= 1)).toBe(true)
  })
})

describe('memory visualization page transitions', () => {
  it('matches the reference RGB interpolation rather than fading alpha', () => {
    expect(pageCellColor({ resident: true, pulse: 'none', age: 0 })).toBe('rgb(230,126,34)')
    expect(pageCellColor({ resident: false, pulse: 'none', age: 0 })).toBe('rgb(58,58,58)')
    expect(pageCellColor({ resident: true, pulse: 'in', age: 6 })).toBe('rgb(255,220,0)')
    expect(pageCellColor({ resident: true, pulse: 'in', age: 3 })).toBe('rgb(243,173,17)')
    expect(pageCellColor({ resident: false, pulse: 'out', age: 6 })).toBe('rgb(200,60,60)')
    expect(pageCellColor({ resident: false, pulse: 'out', age: 1 })).toBe('rgb(82,58,58)')
  })

  it('ages page-ins and page-outs independently for exactly six samples', () => {
    expect(PAGE_PULSE_TICKS).toBe(6)
    expect([0, 1, 2, 3].map(pageIsResident)).toEqual([false, true, false, true])
    const initial = diffHeatmapFlags(undefined, [0, 1, 2, 3])
    expect(initial.map((cell) => cell.pulse)).toEqual(['none', 'none', 'none', 'none'])
    let cells = diffHeatmapFlags(initial, [1, 0, 3, 2])

    expect(cells).toEqual([
      { resident: true, pulse: 'in', age: PAGE_PULSE_TICKS },
      { resident: false, pulse: 'out', age: PAGE_PULSE_TICKS },
      { resident: true, pulse: 'in', age: PAGE_PULSE_TICKS },
      { resident: false, pulse: 'out', age: PAGE_PULSE_TICKS },
    ])
    for (let age = PAGE_PULSE_TICKS - 1; age > 0; age--) {
      cells = diffHeatmapFlags(cells, [1, 0, 3, 2])
      expect(cells.map((cell) => ({ pulse: cell.pulse, age: cell.age }))).toEqual([
        { pulse: 'in', age },
        { pulse: 'out', age },
        { pulse: 'in', age },
        { pulse: 'out', age },
      ])
    }
    expect(diffHeatmapFlags(cells, [1, 0, 3, 2])).toEqual([
      { resident: true, pulse: 'none', age: 0 },
      { resident: false, pulse: 'none', age: 0 },
      { resident: true, pulse: 'none', age: 0 },
      { resident: false, pulse: 'none', age: 0 },
    ])

    const details = { models: [{ itemId: 'm1', displayName: 'Flux model', bytesByResidency: { device: 2 * 1024 ** 3, host: 1024 ** 3 }, pages: { pageBytes: 1024 ** 2, pageCount: 3, flags: [1, 1, 2] } }] }
    const first = updateHeatmapState({}, details)
    const nextDetails = { models: [{ ...details.models[0]!, pages: { pageBytes: 1024, pageCount: 3, flags: [0, 1, 3] } }] }
    const second = updateHeatmapState(first, nextDetails)
    expect(second[memoryDetailKey('models', 'm1')]?.map((cell) => cell.pulse)).toEqual(['out', 'none', 'in'])
    expect(pageFlagRanges([1, 1, 2, 2, 3])).toEqual([
      { first: 0, last: 1, flag: 1, resident: true, pulse: 'none' },
      { first: 2, last: 3, flag: 2, resident: false, pulse: 'none' },
      { first: 4, last: 4, flag: 3, resident: true, pulse: 'none' },
    ])
    expect(pageFlagRanges([1, 1], [{ resident: true, pulse: 'in', age: 6 }, { resident: true, pulse: 'none', age: 0 }]).map((range) => range.pulse)).toEqual(['in', 'none'])
  })
})
