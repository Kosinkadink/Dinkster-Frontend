import { describe, expect, it } from 'vitest'
import { timelineSeek, timelineTicks, timelineTimeLabel } from '../src/timeline-view.js'

describe('timeline view coordinates', () => {
  it('bounds tick allocation for long and zoomed timelines', () => {
    for (const duration of [0.01, 12, 3600, 86400]) {
      const ticks = timelineTicks(duration, 1_000_000)
      expect(ticks.length).toBeLessThanOrEqual(101)
      expect(ticks[0]).toBe(0)
      expect(ticks.every((time) => Number.isFinite(time) && time <= duration)).toBe(true)
    }
    expect(timelineTicks(12, 600)).toEqual([0, 2, 4, 6, 8, 10, 12])
    expect(timelineTicks(0, 600)).toEqual([])
    expect(timelineTicks(NaN, 600)).toEqual([])
  })

  it('seeks on the supplied frame grid without assuming integer fps', () => {
    const frame = 1001 / 30000
    expect(timelineSeek(5 * frame + 0.001, 10, frame)).toBe(5 * frame)
    expect(timelineSeek(-1, 10, frame)).toBe(0)
    expect(timelineSeek(99, 10, frame)).toBeLessThanOrEqual(10)
    expect(timelineSeek(12, 12, 1 / 24)).toBe(12)
    expect(timelineSeek(12.001, 12.001, 1 / 24)).toBe(12.001)
    expect(timelineTimeLabel(0.125)).toBe('0.125 s')
    expect(timelineTimeLabel(3600)).toBe('3600 s')
  })
})
