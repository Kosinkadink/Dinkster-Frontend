import { describe, expect, it } from 'vitest'
import { appendMemorySample, deviceBarSegments, liveMemorySamples, overBudgetBytes, residencySegments, type MemorySample } from '../src/memory-visualization.js'

const sample = (timestamp: number): MemorySample => ({ timestamp, footprintBytes: timestamp, reservedBytes: 0, capacityBytes: 1 })

describe('memory visualization history', () => {

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

    expect(history).toHaveLength(120)
    expect(history[0]?.timestamp).toBe(381_000)
    expect(history.at(-1)?.timestamp).toBe(500_000)
    expect(liveMemorySamples(history)).toEqual(history)
    expect(liveMemorySamples(history, 3).map((item) => item.timestamp)).toEqual([498_000, 499_000, 500_000])
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
