import { describe, expect, it } from 'vitest'
import { AppState, GLOBAL_PROBLEMS_OWNER } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

describe('activity log state', () => {
  it('retains the latest 500 semantic entries and clears only the log', () => {
    const app = new AppState()
    for (let index = 0; index < 501; index += 1) {
      app.reportProblems(GLOBAL_PROBLEMS_OWNER, [{
        severity: 'warning',
        origin: 'schema',
        code: `activity.fixture.${index}`,
        message: `Activity fixture ${index}`,
      }])
    }

    expect(app.logs.get()).toHaveLength(500)
    expect(app.logs.get()[0]).toMatchObject({
      severity: 'warn',
      source: 'schema',
      message: 'Activity fixture 1 (activity.fixture.1)',
    })
    expect(app.logs.get()[499]).toMatchObject({
      severity: 'warn',
      source: 'schema',
      message: 'Activity fixture 500 (activity.fixture.500)',
    })
    expect(Number.isFinite(app.logs.get()[499]!.timestamp)).toBe(true)
    expect(app.problems.get()).toHaveLength(501)

    app.clearLogs()
    expect(app.logs.get()).toEqual([])
    expect(app.problems.get()).toHaveLength(501)
  })
})
