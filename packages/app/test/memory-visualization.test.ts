import { describe, expect, it } from 'vitest'
import {
  appendMemorySample,
  deviceBarSegments,
  diffHeatmapFlags,
  liveMemorySamples,
  MEMORY_HISTORY_LIMIT,
  MEMORY_LIVE_VIEWPORT_LIMIT,
  PAGE_PULSE_TICKS,
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
})

describe('memory visualization device bars', () => {
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
  it('ages page-ins and page-outs independently for exactly six samples', () => {
    const initial = diffHeatmapFlags(undefined, [0, 1])
    let cells = diffHeatmapFlags(initial, [1, 0])

    expect(cells).toEqual([
      { resident: true, pulse: 'in', age: PAGE_PULSE_TICKS },
      { resident: false, pulse: 'out', age: PAGE_PULSE_TICKS },
    ])
    for (let age = PAGE_PULSE_TICKS - 1; age > 0; age--) {
      cells = diffHeatmapFlags(cells, [1, 0])
      expect(cells.map((cell) => ({ pulse: cell.pulse, age: cell.age }))).toEqual([
        { pulse: 'in', age },
        { pulse: 'out', age },
      ])
    }
    expect(diffHeatmapFlags(cells, [1, 0])).toEqual([
      { resident: true, pulse: 'none', age: 0 },
      { resident: false, pulse: 'none', age: 0 },
    ])
  })
})
