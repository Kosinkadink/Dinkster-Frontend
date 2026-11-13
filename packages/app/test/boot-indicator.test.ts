/**
 * Boot indicator timing logic tests. The DOM mount/unmount is presentation
 * (E2E-covered); these tests pin the show-after-delay and hide-cancels
 * contract via an injected scheduler, matching supervisor-poll's pattern.
 */
import { describe, expect, it } from 'vitest'
import { startBootIndicator } from '../src/boot-indicator.js'

interface Scheduled { fn: () => void; ms: number }

const harness = () => {
  const scheduled: Scheduled[] = []
  const cancelled: number[] = []
  let next = 0
  const schedule = (fn: () => void, ms: number): number => {
    const id = next++
    scheduled[id] = { fn, ms }
    return id
  }
  const cancel = (h: unknown): void => {
    cancelled.push(h as number)
  }
  /** Run every scheduled callback whose delay is <= elapsed. */
  const runTo = (ms: number): void => {
    for (const entry of scheduled) {
      if (entry && entry.ms <= ms) entry.fn()
    }
  }
  return { scheduled, cancelled, schedule, cancel, runTo }
}

describe('startBootIndicator', () => {

  it('does not flash on a fast boot (hide before show)', () => {
    const h = harness()
    let shown = false
    let hidden = false
    const hide = startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => { shown = true },
      onHide: () => { hidden = true },
    })
    // Fast boot: hide before the show timer fires.
    hide()
    h.runTo(150)
    expect(shown).toBe(false)
    expect(hidden).toBe(false)
  })

  it('calls onHide when hidden after show', () => {
    const h = harness()
    let hidden = false
    const hide = startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => {},
      onHide: () => { hidden = true },
    })
    h.runTo(150)
    hide()
    expect(hidden).toBe(true)
  })

})
