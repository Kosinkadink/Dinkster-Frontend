/**
 * execution UX implementation reconnect + reconciliation suite, against a REAL backend:
 *
 *  - transport death -> 'reconnecting' -> 'connected', driven through the
 *    connection's own simulateConnectionLoss() (same codepath as a real drop)
 *  - a ghost execution (in-flight in the store, unknown to the server) is
 *    marked interrupted with an `execution.lost` diagnostic after reconnect
 *  - a real run whose events were missed during the gap still reaches
 *    'completed' (live resumption or history replay - both must converge)
 */
import { expect, test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
})

const executionByPrompt = (page: Page, prompt: string) =>
  page.evaluate((prompt) => {
    const execs = window.__dinksterTest!.app.store.executions.get()
    for (const state of execs.values()) {
      if (state.ref.prompt === prompt) {
        return { status: state.status, errors: state.errors as { code?: string; severity?: string }[] }
      }
    }
    return undefined
  }, prompt)

test('recovers the connection after a socket drop', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.app.connection.simulateConnectionLoss())
  // 500ms backoff makes the intermediate state observable.
  await expect(page.locator('.conn-status')).toHaveText('reconnecting')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
})

test('marks a server-unknown in-flight execution lost after reconnect', async ({ page }) => {
  await page.evaluate(() => {
    const t = window.__dinksterTest!
    // A run the server has never heard of: no /history entry, not in /queue.
    t.app.store.apply({
      kind: 'started',
      execution: { connection: 'local', prompt: 'ghost-e2e-reconnect' },
      timestamp: Date.now(),
    })
    t.app.connection.simulateConnectionLoss()
  })
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect
    .poll(async () => (await executionByPrompt(page, 'ghost-e2e-reconnect'))?.status, { timeout: 10_000 })
    .toBe('interrupted')
  const state = await executionByPrompt(page, 'ghost-e2e-reconnect')
  expect(state!.errors).toHaveLength(1)
  expect(state!.errors[0]!.code).toBe('execution.lost')
  expect(state!.errors[0]!.severity).toBe('warning')
})

test('a run queued right before a drop still converges to completed', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  // Kill the transport while the run is (likely) in flight. Whether the run
  // finishes during the gap (history replay) or after reconnect (live events
  // resume - same clientId re-associates the session), it must complete.
  await page.evaluate(() => window.__dinksterTest!.app.connection.simulateConnectionLoss())
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
})
