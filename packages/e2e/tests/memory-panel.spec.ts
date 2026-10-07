import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WebSocketRoute } from '@playwright/test'
import { expect, test, type Locator, type Page } from './fixtures.js'

const PRIMARY = 'http://memory.test'
const SECONDARY = 'http://memory-secondary.test'
const proofDir = process.env['DINKSTER_MEMORY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

async function capture(page: Page, name: string): Promise<Buffer> {
  return page.screenshot({ ...(proofDir ? { path: join(proofDir, name) } : {}), fullPage: true, animations: 'disabled' })
}

async function captureAt(page: Page, locator: Locator, name: string): Promise<Buffer> {
  await locator.scrollIntoViewIfNeeded()
  return capture(page, name)
}

const section = (value: unknown, mutability: 'live' | 'on-worker-restart' = 'live', writable = true) => ({
  value,
  source: 'default',
  mutability,
  writable,
  persistence: { available: true, persisted: true },
})

const settings = {
  categories: { granted: ['memory-budgets', 'memory-headroom', 'aimdo-policy'], available: ['memory-budgets', 'memory-headroom', 'aimdo-policy'] },
  settings: {
    'memory-budgets': section({ 'cuda:0': '8G', 'very-long-device-identity-that-must-wrap-without-colliding:1': '12G' }),
    'memory-headroom': section('256M'),
    'aimdo-policy': section('auto', 'on-worker-restart'),
  },
}

const baseStatus = {
  devices: {
    'cuda:0': { executionCapacity: 2, executionInUse: 1 },
    'very-long-device-identity-that-must-wrap-without-colliding:1': { executionCapacity: 1, executionInUse: 1 },
  },
  queue: { queued: 3, running: ['job-1', 'job-2'], maxRunningJobs: 2, paused: false },
  memoryGovernor: {
    'cuda:0': {
      budgetBytes: 8589934592, reservedBytes: 2147483648, consumerFootprintBytes: 7516192768, availableBytes: -1073741824,
      peakUsedBytes: 9 * 2 ** 30,
      measured: { freeBytes: 5 * 2 ** 30, totalBytes: 12 * 2 ** 30,
        torchAllocatedBytes: 2 * 2 ** 30, torchReservedBytes: 3 * 2 ** 30,
        gpuName: 'NVIDIA GeForce RTX 3060', gpuUtilizationPercent: 75, gpuTemperatureCelsius: 62,
        gpuPowerMilliwatts: 120000, processRssBytes: 8 * 2 ** 30, pinnedHostBytes: 2 * 2 ** 30 },
      consumers: { 'models/flux/very-long-consumer-name-that-wraps': 7516192768 },
    },
    'very-long-device-identity-that-must-wrap-without-colliding:1': {
      budgetBytes: null, reservedBytes: 0, consumerFootprintBytes: 0, availableBytes: null,
      measured: null, consumers: {},
    },
  },
  acceleratorPolicy: { physicalHeadroomBytes: 256 * 2 ** 20, aimdoConfiguredPolicy: 'auto',
    aimdoPoliciesByWorker: { 'worker-one': 'off' },
    devices: { 'cuda:0': { governorAdmission: { budgetBytes: 8 * 2 ** 30, effectiveBudgetBytes: 8 * 2 ** 30 }, residencyApplied: { budgetsByWorker: {} } } },
  },
  leases: [{ reservationId: 'reservation-with-a-long-authoritative-id', device: 'cuda:0', bytes: 1073741824, expiresInSeconds: 30 }],
}

const detailedStatus = {
  ...baseStatus,
  consumerDetails: {
    'models/flux/very-long-consumer-name-that-wraps': [{
      itemId: 'model-1', displayName: 'Flux model with a long descriptive residency label',
      bytesByResidency: { device: 6442450944, host: 1073741824 },
      pages: { pageBytes: 1048576, pageCount: 700, flags: Array.from({ length: 700 }, (_, index) => index % 5 < 3 ? 1 : 0) },
    }],
  },
}

async function addBackend(page: Page, address: string): Promise<void> {
  const input = page.getByTestId('backend-url-input')
  if (!await input.isVisible()) await page.getByTestId('backends-sidebar-toggle').click()
  await input.fill(address)
  await page.getByTestId('backend-add').click()
  await expect(page.getByTestId('backend-row').filter({ hasText: address })).toBeVisible({ timeout: 10_000 })
}

async function scrollPanelToTop(page: Page): Promise<void> {
  await page.locator('.product-tabpanel:has(> .memory-panels)').evaluate((element) => { element.scrollTop = 0 })
}

test('Memory and Aimdo surface covers wide lifecycle, details, settings, and multiple backends', async ({ page }, testInfo) => {
  let detailRequests = 0
  let baseFails = false
  let rejectHeadroom = true
  let primarySocket: WebSocketRoute | undefined
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.route(`${PRIMARY}/supervisor/status`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${PRIMARY}/system_stats`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${PRIMARY}/api/nodes*`, (route) => route.fulfill({ json: { schemaVersion: 1, dinkster: { version: 'test', schemaWire: 1 }, nodes: {} } }))
  await page.route(`${PRIMARY}/api/settings`, (route) => route.fulfill({ json: settings }))
  await page.route(`${PRIMARY}/api/settings/memory-headroom`, (route) => rejectHeadroom ? route.fulfill({ status: 400, json: {
    error: 'invalid-settings', category: 'memory-headroom', message: 'Headroom exceeds server policy.', offendingFlag: '--reserve-vram', owner: 'host-policy',
  } }) : route.fulfill({ json: section(route.request().postDataJSON()) }))
  await page.route(`${PRIMARY}/memory/status*`, (route) => {
    const details = new URL(route.request().url()).searchParams.get('details') === '1'
    if (details) detailRequests++
    if (!details && baseFails) return route.fulfill({ status: 503, body: 'telemetry unavailable' })
    return route.fulfill({ json: details ? detailedStatus : baseStatus })
  })
  await page.route(`${SECONDARY}/supervisor/status`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${SECONDARY}/system_stats`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${SECONDARY}/api/nodes*`, (route) => route.fulfill({ json: { schemaVersion: 1, dinkster: { version: 'test', schemaWire: 1 }, nodes: {} } }))
  await page.route(`${SECONDARY}/api/settings`, (route) => route.fulfill({ json: { categories: { granted: [], available: [] }, settings: {} } }))
  await page.route(`${SECONDARY}/memory/status*`, (route) => route.fulfill({ json: { ...baseStatus, devices: { cpu: { executionCapacity: 1, executionInUse: 0 } }, memoryGovernor: null, leases: null } }))
  await page.routeWebSocket(`${PRIMARY.replace('http', 'ws')}/api/events*`, (socket) => { primarySocket = socket })
  await page.routeWebSocket(`${SECONDARY.replace('http', 'ws')}/api/events*`, () => {})

  await page.goto('/')
  await addBackend(page, PRIMARY)
  await addBackend(page, SECONDARY)
  await page.getByTestId('memory-sidebar-toggle').click()
  if (await page.getByTestId('rail-toggle').getAttribute('aria-pressed') === 'true') await page.getByTestId('rail-toggle').click()

  const primary = page.getByTestId('memory-panel').filter({ hasText: PRIMARY })
  const secondary = page.getByTestId('memory-panel').filter({ hasText: SECONDARY })
  await expect(primary.locator('.memory-telemetry-state')).toHaveText('Live')
  await expect(secondary).toContainText('Memory governor telemetry is unsupported')
  await expect(primary.getByTestId('memory-queue')).toContainText('Queued3')
  await expect(primary).toContainText('Over budget by 1.0 GiB')
  await expect(primary).toContainText('No consumers')
  await expect(primary.locator('[data-device]')).toHaveCount(2)
  await expect(page.getByTestId('memory-panel')).toHaveCount(2)
  await expect(primary).toContainText('Flux model with a long descriptive residency label')
  expect(detailRequests).toBe(1)

  const consumer = primary.locator('.memory-consumer > button')
  await consumer.focus()
  await page.keyboard.press('Enter')
  await expect(consumer).toHaveAttribute('aria-expanded', 'false')
  await page.keyboard.press('Enter')
  await expect(primary).toContainText('Flux model with a long descriptive residency label')
  await expect(primary.locator('canvas[aria-label^="Page residency heatmap"]')).toBeVisible()
  expect(detailRequests).toBe(2)
  await primary.getByText('History data').click()
  await primary.getByText('Page flag data').click()
  await expect(primary.locator('[aria-label="Memory history table"]')).toBeVisible()
  await expect(primary.locator('[aria-label="Page flag ranges table"]')).toBeVisible()
  await primary.locator('[aria-label="Page flag ranges table"]').focus()
  await expect(primary.locator('[aria-label="Page flag ranges table"]')).toBeFocused()

  const deviceNode = await primary.locator('[data-device="cuda:0"]').elementHandle()
  const itemNode = await primary.locator('.memory-consumer-item').elementHandle()
  for (let update = 1; update <= 100; update++) {
    primarySocket!.send(JSON.stringify({ type: 'memory_status', ...baseStatus, queue: { ...baseStatus.queue, queued: update } }))
    await expect(primary.getByTestId('memory-queue')).toContainText(`Queued${update}`)
    await expect(primary.locator('.memory-data-disclosure[open]')).toHaveCount(2)
    await expect(primary.locator('[aria-label="Page flag ranges table"]')).toBeFocused()
  }
  expect(await deviceNode!.evaluate(node => node.isConnected)).toBe(true)
  expect(await itemNode!.evaluate(node => node.isConnected)).toBe(true)

  if (proofDir) {
    await primary.locator('.memory-consumer-item').screenshot({ path: join(proofDir, 'memory-pages-open.png') })
    await primary.locator('.memory-graph').screenshot({ path: join(proofDir, 'memory-history-open.png') })
  }
  await scrollPanelToTop(page)
  await testInfo.attach('memory-wide-telemetry.png', { body: await capture(page, 'memory-wide-telemetry.png'), contentType: 'image/png' })

  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const headroom = primary.getByRole('spinbutton', { name: 'Headroom (MiB)' })
  await headroom.fill('512')
  await expect(primary).toContainText('Unsaved changes')
  primarySocket!.send(JSON.stringify({ type: 'memory_status', ...baseStatus }))
  await expect(headroom).toHaveValue('512')
  const apply = primary.locator('form[data-category="memory-headroom"] button[type="submit"]')
  await expect(apply).toBeEnabled()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await apply.click()
  await expect(primary).toContainText('Headroom exceeds server policy.')
  await expect(primary).toContainText('Rejected flag: --reserve-vram (owned by host-policy).')

  await testInfo.attach('memory-settings-rejected.png', { body: await capture(page, 'memory-settings-rejected.png'), contentType: 'image/png' })
  if (proofDir) await primary.locator('.runtime-setting-category[data-category="memory-headroom"]').screenshot({ path: join(proofDir, 'memory-headroom-validation.png') })
  await primary.locator('form[data-category="memory-headroom"]').getByRole('button', { name: 'Revert' }).click()
  await expect(headroom).toHaveValue('256')
  await expect(primary.getByText('Headroom exceeds server policy.')).toHaveCount(0)
  rejectHeadroom = false
  await headroom.fill('384')
  await headroom.press('Enter')
  await expect(primary.locator('.runtime-setting-category[data-category="memory-headroom"]')).toContainText('Current setting384 MiB')
  await expect(apply).toBeDisabled()
  if (proofDir) await primary.locator('.runtime-setting-category[data-category="memory-headroom"]').screenshot({ path: join(proofDir, 'memory-headroom-applied.png') })
  if (proofDir) await primary.locator('.runtime-setting-category[data-category="aimdo-policy"]').screenshot({ path: join(proofDir, 'memory-aimdo-applied.png') })

  baseFails = true
  await expect(primary.locator('.memory-telemetry-state')).toHaveText('Stale', { timeout: 12_000 })
  await expect(primary).toContainText('Retained values remain visible')
  if (proofDir) await captureAt(page, primary.locator('.memory-telemetry-state'), 'memory-stale-error.png')

  primarySocket!.send(JSON.stringify({ type: 'memory_status', ...baseStatus }))
  await expect(primary.locator('.memory-telemetry-state')).toHaveText('Live')
  const samplesBefore = Number(await primary.locator('.memory-graph canvas').getAttribute('data-samples'))
  await page.waitForTimeout(1100)
  primarySocket!.send(JSON.stringify({
    type: 'memory_status', ...baseStatus,
    memoryGovernor: {
      ...baseStatus.memoryGovernor,
      'cuda:0': { ...baseStatus.memoryGovernor['cuda:0'], consumerFootprintBytes: 6442450944, availableBytes: 0 },
    },
  }))
  await expect(primary.locator('[data-device="cuda:0"]')).toContainText('Footprint6.0 GiB')
  await expect(primary.locator('.memory-graph canvas')).toHaveAttribute('data-samples', String(samplesBefore + 1))
  await expect(primary.locator('.memory-graph-state')).toHaveCount(0)
  primarySocket!.send(JSON.stringify({
    type: 'memory_status', ...baseStatus,
    memoryGovernor: Object.fromEntries(Object.entries(baseStatus.memoryGovernor).map(([device, governor]) => [device, { ...governor, consumers: {} }])),
    leases: [],
  }))
  await expect(primary).toContainText('No active leases')
  await expect(primary.locator('.memory-empty-state', { hasText: 'No consumers' })).toHaveCount(2)
  if (proofDir) await captureAt(page, primary.locator('.memory-empty-state', { hasText: 'No active leases' }), 'memory-empty.png')

  primarySocket!.send(JSON.stringify({ type: 'memory_status', ...baseStatus, memoryGovernor: null, leases: null }))
  await expect(primary).toContainText('Memory governor telemetry is unsupported')
  await expect(primary).toContainText('Lease telemetry is unsupported')
  if (proofDir) await captureAt(page, primary.getByText('Memory governor telemetry is unsupported'), 'memory-unsupported.png')
})

test('Memory surface remains usable on touch, narrow layout, reduced motion, and 200 percent equivalent zoom', async ({ browser, baseURL }, testInfo) => {
  const context = await browser.newContext({ baseURL: baseURL!, hasTouch: true, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.route('/api/nodes*', (route) => route.fulfill({ status: 502, body: 'no native same-origin backend' }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.route(`${PRIMARY}/supervisor/status`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${PRIMARY}/system_stats`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${PRIMARY}/api/nodes*`, (route) => route.fulfill({ json: { schemaVersion: 1, dinkster: { version: 'test', schemaWire: 1 }, nodes: {} } }))
  await page.route(`${PRIMARY}/api/settings`, (route) => route.fulfill({ json: settings }))
  await page.route(`${PRIMARY}/memory/status*`, (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.get('details') === '1' ? detailedStatus : baseStatus }))
  await page.routeWebSocket(`${PRIMARY.replace('http', 'ws')}/api/events*`, () => {})
  await page.goto('/')
  await addBackend(page, PRIMARY)
  await page.getByTestId('memory-sidebar-toggle').tap()
  if (await page.getByTestId('rail-toggle').getAttribute('aria-pressed') === 'true') await page.getByTestId('rail-toggle').tap()
  const panel = page.getByTestId('memory-panel').filter({ hasText: PRIMARY })
  await expect(panel).toContainText('Flux model with a long descriptive residency label')
  await panel.locator('.memory-consumer > button').tap()
  await expect(panel.locator('.memory-consumer > button')).toHaveAttribute('aria-expanded', 'false')
  await panel.locator('.memory-consumer > button').tap()
  await expect(panel).toContainText('Flux model with a long descriptive residency label')
  await expect(panel.locator('.memory-consumer > button')).toHaveCSS('min-height', '40px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await testInfo.attach('memory-narrow.png', { body: await capture(page, 'memory-narrow.png'), contentType: 'image/png' })

  await page.setViewportSize({ width: 720, height: 450 })
  await expect(panel).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await panel.getByText('Page flag data').tap()
  await expect(panel.locator('[aria-label="Page flag ranges table"]')).toBeVisible()
  await testInfo.attach('memory-zoom-200.png', { body: await capture(page, 'memory-zoom-200.png'), contentType: 'image/png' })
  await context.close()
})
