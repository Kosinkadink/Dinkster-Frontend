import { expect, test } from '../visual.js'
import { evidencePath } from './evidence-output.js'

test('a post-ready engine death surfaces restart and returns to ready', async ({ page }) => {
  let state: 'ready' | 'failed' | 'starting' = 'ready'
  let probes = 0
  let restarts = 0
  await page.route('**/supervisor/status', (route) => {
    probes += 1
    void route.fulfill({ json: {
      protocol: 1,
      state,
      ...(state === 'failed' ? { detail: 'engine exited with code 3', engine: { exitCode: 3 } } : {}),
    } })
  })
  await page.route('**/supervisor/engine/restart', async (route) => {
    restarts += 1
    state = 'starting'
    await route.fulfill({ status: 202 })
    setTimeout(() => { state = 'ready' }, 100)
  })
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'desktop-recovery-test', schemaWire: 2 },
    nodes: {},
  } }))
  await page.route('**/api/**', (route) => route.fulfill({ json: {} }))

  await page.goto('/')
  await expect.poll(() => probes).toBeGreaterThan(0)
  const editor = page.locator('.canvas-stage').first()
  await expect(editor).toBeVisible()
  const readyBounds = await editor.boundingBox()
  state = 'failed'

  const engine = page.getByTestId('engine-run-control')
  await expect(engine).toHaveAttribute('data-state', 'failed', { timeout: 7000 })
  await expect(page.getByTestId('engine-banner')).toHaveCount(0)
  expect(await editor.boundingBox()).toEqual(readyBounds)
  await page.getByTestId('engine-failed').click()
  await expect(page.getByRole('dialog', { name: 'Engine failed' })).toContainText('engine exited with code 3')
  await page.screenshot({ path: evidencePath('issue-92', 'desktop-engine-recovery.png'), fullPage: true })
  await page.getByTestId('engine-restart').click()
  await expect.poll(() => restarts).toBe(1)
  await expect(engine).toHaveCount(0, { timeout: 7000 })
  await expect(page.getByTestId('queue-button')).toBeVisible()
  expect(await editor.boundingBox()).toEqual(readyBounds)
  expect(state).toBe('ready')
})

test('with no engine open the status bar and Run say so until an engine opens', async ({ page }) => {
  let status: Record<string, unknown> = { protocol: 1, state: 'stopped', role: 'home', installations: 1 }
  await page.route('**/supervisor/status', (route) => route.fulfill({ json: status }))
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'engine-not-ready', state: 'stopped', status: '/supervisor/status' } }))

  await page.goto('/')
  const connection = page.getByTestId('status-connection')
  await expect(connection).toHaveAttribute('data-state', 'no-engine')
  await expect(connection).toHaveAttribute('aria-label', 'Local: no engine')
  await expect(connection).toContainText('no engine')
  await expect(page.getByTestId('status-bar')).not.toContainText('Loading schemas')
  await expect(page.getByTestId('engine-start')).toHaveText('Start engine')
  await expect(page.getByTestId('queue-button')).toHaveCount(0)
  await expect(page.getByTestId('workflow-queue-toggle')).toBeVisible()

  status = { protocol: 1, state: 'starting', role: 'home', installations: 1, open: { root: '/installs/a', engine: 'main' } }
  await expect(connection).not.toHaveAttribute('data-state', 'no-engine', { timeout: 7000 })
  await expect(page.getByTestId('engine-run-control')).toContainText('Starting engine')
  await expect(page.getByTestId('workflow-queue-toggle')).toBeVisible()
  await expect(page.getByTestId('status-bar')).toContainText('Loading schemas')
})
