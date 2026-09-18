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
  it('does not show before the show delay', () => {
    const h = harness()
    let shown = false
    startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => { shown = true },
    })
    h.runTo(149)
    expect(shown).toBe(false)
  })

  it('shows after 150ms by default', () => {
    const h = harness()
    let shown = false
    startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => { shown = true },
    })
    h.runTo(150)
    expect(shown).toBe(true)
  })

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

  it('hide cancels both timers', () => {
    const h = harness()
    const hide = startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => {},
      onShowMessage: () => {},
    })
    hide()
    expect(h.cancelled).toHaveLength(2)
  })

  it('shows the waiting message after 3000ms by default', () => {
    const h = harness()
    let messaged = false
    startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => {},
      onShowMessage: () => { messaged = true },
    })
    h.runTo(3000)
    expect(messaged).toBe(true)
  })

  it('does not show the waiting message if hidden before 3000ms', () => {
    const h = harness()
    let messaged = false
    const hide = startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => {},
      onShowMessage: () => { messaged = true },
    })
    h.runTo(150)
    hide()
    h.runTo(3000)
    expect(messaged).toBe(false)
  })

  it('calls onHide only if the indicator was shown', () => {
    const h = harness()
    let hidden = false
    const hide = startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => {},
      onHide: () => { hidden = true },
    })
    // Hide before show: onHide should NOT fire (no DOM was created).
    hide()
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

  it('hide is idempotent', () => {
    const h = harness()
    let hidden = 0
    const hide = startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      onShow: () => {},
      onHide: () => { hidden++ },
    })
    h.runTo(150)
    hide()
    hide()
    hide()
    expect(hidden).toBe(1)
  })

  it('honors custom delays', () => {
    const h = harness()
    let shown = false
    let messaged = false
    startBootIndicator({
      schedule: h.schedule,
      cancel: h.cancel,
      showDelayMs: 500,
      messageDelayMs: 2000,
      onShow: () => { shown = true },
      onShowMessage: () => { messaged = true },
    })
    h.runTo(499)
    expect(shown).toBe(false)
    h.runTo(500)
    expect(shown).toBe(true)
    expect(messaged).toBe(false)
    h.runTo(2000)
    expect(messaged).toBe(true)
  })
})
