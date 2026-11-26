import { expect, test } from '../visual.js'
import { evidencePath } from './evidence-output.js'

test('setup owns engine controls until its registered installation has completed', async ({ page }) => {
  const root = '/install/nightly'
  const plan = {
    id: 'reviewed-plan', root, channel: 'nightly', variant: 'linux-cpu', buildLabel: 'CPU only',
    buildReason: 'Does not use the graphics card and is much slower.', engineRelease: 'release', baseId: 'base',
    detectedCards: [], choices: [], gpus: [], downloadBytes: 2048, runtimeDownloadBytes: 2048,
    freeBytes: 9000, refusal: null,
  }
  let installations = 0
  let job = {
    id: 'setup-job', root, channel: 'nightly', variant: 'linux-cpu', state: 'running',
    progress: null, error: null, installation: null as null | { root: string; engine: string },
  }
  await page.route('**/supervisor/status', (route) => {
    return route.fulfill({ json: { protocol: 1, role: 'home', state: 'stopped', installations } })
  })
  await page.route('**/supervisor/installations', (route) => route.fulfill({ json: {
    installations: installations ? [{ root }] : [],
  } }))
  await page.route('**/supervisor/setup**', (route) => route.fulfill({ json:
    route.request().url().includes('/setup/setup-job') ? job : { plan, activeJob: job },
  }))
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: {
    error: 'engine-not-ready', state: 'stopped', status: '/supervisor/status',
  } }))

  await page.goto('/?dinksterProject=default')
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()
  installations = 1
  await expect(page.getByTestId('status-connection')).toContainText('no engine', { timeout: 7000 })
  await expect(page.getByTestId('engine-restart')).toBeHidden()
  await expect(page.getByTestId('engine-banner')).toBeHidden()
  await expect(page.getByText('Setting up Dinkster', { exact: true })).toBeVisible()
  await page.screenshot({ path: evidencePath('issue-1364', 'editor-registered-running.png') })

  job = { ...job, state: 'cancelling' }
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
  await expect(page.getByTestId('engine-restart')).toBeHidden()

  job = { ...job, state: 'completed', installation: { root, engine: 'main' } }
  await expect(page.getByTestId('setup-form')).toBeHidden()
  await expect(page.getByTestId('engine-restart')).toBeVisible()
  await page.screenshot({ path: evidencePath('issue-1364', 'editor-completed-stopped.png') })
})

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
  state = 'failed'

  const banner = page.getByTestId('engine-banner')
  await expect(banner).toHaveAttribute('data-state', 'failed', { timeout: 7000 })
  await expect(banner).toContainText('Engine failed - engine exited with code 3')
  await page.screenshot({ path: evidencePath('issue-92', 'desktop-engine-recovery.png'), fullPage: true })
  await page.getByTestId('engine-restart').click()
  await expect.poll(() => restarts).toBe(1)
  await expect(banner).toBeHidden({ timeout: 7000 })
  expect(state).toBe('ready')
})

test('with no engine open the status bar and Run say so until an engine opens', async ({ page }) => {
  let status: Record<string, unknown> = { protocol: 1, state: 'stopped', role: 'home', installations: 1 }
  await page.route('**/supervisor/status', (route) => route.fulfill({ json: status }))
  await page.route('**/supervisor/installations', (route) => route.fulfill({ json: { installations: [{ root: '/installs/a' }] } }))
  await page.route('**/supervisor/setup**', (route) => route.fulfill({ json: { activeJob: null } }))
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: { error: 'engine-not-ready', state: 'stopped', status: '/supervisor/status' } }))

  await page.goto('/?dinksterProject=default')
  const connection = page.getByTestId('status-connection')
  await expect(connection).toHaveAttribute('data-state', 'no-engine')
  await expect(connection).toHaveAttribute('aria-label', 'Local: no engine')
  await expect(connection).toContainText('no engine')
  await expect(page.getByTestId('status-bar')).not.toContainText('Loading schemas')
  const run = page.getByTestId('queue-button')
  await expect(run).toHaveAttribute('data-tooltip-label', 'No engine is running')
  await run.hover()
  await expect(page.getByText('No engine is running')).toBeVisible()

  status = { protocol: 1, state: 'starting', role: 'home', installations: 1, open: { root: '/installs/a', engine: 'main' } }
  await expect(connection).not.toHaveAttribute('data-state', 'no-engine', { timeout: 7000 })
  await expect(run).toHaveAttribute('data-tooltip-label', 'The engine is still starting')
  await expect(page.getByTestId('status-bar')).toContainText('Loading schemas')
})
