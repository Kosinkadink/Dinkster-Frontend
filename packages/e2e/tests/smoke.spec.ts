/**
 * Smoke path: connect -> schemas -> render -> queue -> live per-node state
 * -> outputs. Runs against a real ComfyUI backend through the
 * dev proxy. Uses the window.__dinksterTest bridge for state assertions instead
 * of scraping canvas pixels.
 */
import { expect, test } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('connects and loads schemas from the live backend', async ({ page }) => {
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

test('renders both tabs on the canvas', async ({ page }) => {
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  // The canvas actually painted something (not a blank surface).
  const painted = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
    const ctx = canvas.getContext('2d')!
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let nonBackground = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0x18) nonBackground++
    }
    return nonBackground
  })
  expect(painted).toBeGreaterThan(1000)
})

test('queues the basic workflow and tracks it to completion with outputs', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const execution = page.getByTestId('execution-row').first()
  await expect(execution).toBeVisible({ timeout: 10_000 })
  await expect(execution.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  await expect(page.getByTestId('outputs-panel').locator('.output-thumbnail img')).not.toHaveCount(0, {
    timeout: 10_000,
  })
  await expect(page.getByTestId('problems-panel')).toContainText('None.')
})

test('subgraph tab queues its flattened prompt and routes state by lineage', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  await page.getByTestId('queue-button').click()

  // Immediately switch BACK to the basic tab: the execution must keep
  // tracking the subgraph lineage, but its row must not bleed into Basic.
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Basic' }).click()
  await expect(page.getByTestId('execution-row')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
    return executions.sort((a, b) => b.queuedAt - a.queuedAt)[0]?.status
  }), { timeout: 30_000 }).toBe('completed')
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  const execution = page.getByTestId('execution-row').first()
  await expect(execution.locator('.execution-tab')).toHaveText('Subgraph')
  await expect(execution.locator('.execution-status')).toHaveText('Completed')

  // Bridge-level check: the flattened prompt used occurrence-key runtime ids
  // and per-node states landed under them.
  const runtimeIds = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exec = [...app.store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)[0]!
    return { prompt: Object.keys(exec.artifact!.prompt), states: Object.keys(exec.nodes) }
  })
  expect(runtimeIds.prompt.sort()).toEqual(['n0.n0', 'n1'])
  expect(runtimeIds.states).toEqual(expect.arrayContaining(['n0.n0', 'n1']))
})
