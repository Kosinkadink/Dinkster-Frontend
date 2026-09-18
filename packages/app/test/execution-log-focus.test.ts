/**
 * Execution log focus requests (bottom-badge popover "Open in Execution
 * log"): tokens must stay monotonic across the whole session, including
 * after a request is consumed. If a consumed request let the next one
 * reuse its token, a mounted panel remembering the applied token would
 * ignore every later request.
 */
import { describe, expect, it } from 'vitest'
import { AppState } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

describe('executionLogFocus tokens', () => {
  it('request -> consume -> request yields strictly increasing tokens', () => {
    const app = new AppState()

    app.requestExecutionLogFocus(['node-a'])
    const first = app.executionLogFocus.get()
    expect(first?.runtimeNodeIds).toEqual(['node-a'])
    expect(first?.token).toBe(1)

    app.consumeExecutionLogFocus(first!.token)
    expect(app.executionLogFocus.get()).toBeUndefined()

    app.requestExecutionLogFocus(['node-a'])
    const second = app.executionLogFocus.get()
    expect(second?.token).toBe(2)
  })

  it('consuming with a stale token leaves a newer pending request intact', () => {
    const app = new AppState()

    app.requestExecutionLogFocus(['node-a'])
    const first = app.executionLogFocus.get()!
    app.requestExecutionLogFocus(['node-b', 'node-c'])
    const second = app.executionLogFocus.get()!
    expect(second.token).toBeGreaterThan(first.token)

    app.consumeExecutionLogFocus(first.token)
    expect(app.executionLogFocus.get()).toBe(second)

    app.consumeExecutionLogFocus(second.token)
    expect(app.executionLogFocus.get()).toBeUndefined()
  })
})
