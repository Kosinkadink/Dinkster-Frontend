import type { WebSocketRoute } from '@playwright/test'
import { expect, nativeTest as test } from './fixtures.js'

const BACKEND = 'http://resources.test'
const section = (value: unknown) => ({ value, source: 'default', mutability: 'live', writable: true, persistence: { available: true, persisted: true } })
const card = (name: string, total: number, free: number) => ({
  budgetBytes: total - 2e9, reservedBytes: 0, consumerFootprintBytes: 3e9, availableBytes: 2e9,
  peakUsedBytes: total - free + 1e9, consumers: { models: 3e9 },
  measured: { gpuName: name, totalBytes: total, freeBytes: free, torchReservedBytes: 4e9, torchAllocatedBytes: 3.5e9, gpuUtilizationPercent: 73 },
})
const initial = {
  devices: {}, queue: { queued: 3, running: ['job'], maxRunningJobs: 2, paused: false }, leases: null,
  memoryGovernor: { 'vram:cuda:0': card('First GPU', 12e9, 5e9) },
  acceleratorPolicy: { physicalHeadroomBytes: 1e9, devices: {} },
  consumerDetails: { models: [{ itemId: 'flux', displayName: 'Flux model', bytesByResidency: { 'vram:cuda:0': 3e9, 'vram:cuda:1': 1e9, ram: 2e9 } }] },
}

test('Resources isolates card residency, preserves refresh focus and confirms actions', async ({ page }, testInfo) => {
  let payload = initial
  let socket: WebSocketRoute | undefined
  const unloads: unknown[] = []
  const writes: { category: string; value: unknown }[] = []
  let rejected = true
  const settings = { categories: { granted: ['memory-budgets', 'memory-headroom'], available: ['memory-budgets', 'memory-headroom'] }, settings: { 'memory-budgets': section({}), 'memory-headroom': section(1e9) } }
  await page.route(`${BACKEND}/supervisor/status`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${BACKEND}/system_stats`, (route) => route.fulfill({ status: 404 }))
  await page.route(`${BACKEND}/api/nodes*`, (route) => route.fulfill({ json: { schemaVersion: 1, dinkster: { version: 'test', schemaWire: 1 }, nodes: {} } }))
  await page.route(`${BACKEND}/api/mounts`, (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route(`${BACKEND}/api/settings`, (route) => route.fulfill({ json: settings }))
  await page.route(`${BACKEND}/api/settings/*`, (route) => {
    const category = new URL(route.request().url()).pathname.split('/').at(-1)!
    const value: unknown = route.request().postDataJSON()
    writes.push({ category, value })
    if (rejected) return route.fulfill({ status: 400, json: { error: 'invalid-settings', category, message: 'Server policy refused the limit.' } })
    return route.fulfill({ json: section(value) })
  })
  await page.route(`${BACKEND}/memory/status*`, (route) => route.fulfill({ json: payload }))
  await page.route(`${BACKEND}/cache/trim`, (route) => {
    unloads.push(route.request().postDataJSON())
    return route.fulfill({ json: { requestedBytes: 3e9, freedBytes: 3e9 } })
  })
  await page.route(`${BACKEND}/memory/reset-peak`, (route) => route.fulfill({ json: { ok: true } }))
  await page.routeWebSocket(`${BACKEND.replace('http', 'ws')}/api/events*`, (next) => { socket = next })
  await page.goto('/')
  await page.getByTestId('backends-sidebar-toggle').click()
  await page.getByTestId('backend-url-input').fill(BACKEND)
  await page.getByTestId('backend-add').click()
  await expect(page.getByTestId('backend-row').filter({ hasText: BACKEND })).toBeVisible()
  await page.getByTestId('memory-sidebar-toggle').click()
  const backendId = await page.evaluate((address) => window.__dinksterTest!.app.backends.get().find((backend) => backend.baseUrl === address)!.id, BACKEND)
  const backend = page.locator(`[data-testid="resources-panel"] [data-backend="${backendId}"]`)
  await page.evaluate((id) => {
    const app = window.__dinksterTest!.app
    app.setTabTarget(app.activeTab()!.id, id)
  }, backendId)
  await page.getByTestId('status-memory').click()
  await expect(backend).toContainText('7.0 GB of 12.0 GB')
  const backendToggle = backend.locator(':scope > .dinkster-resource-backend-toggle button')
  await backendToggle.click()
  await expect(backendToggle).toHaveAttribute('aria-expanded', 'false')
  await page.getByTestId('status-memory').click()
  await expect(backendToggle).toHaveAttribute('aria-expanded', 'true')
  const model = backend.locator('.dinkster-resource-model')
  await expect(model).toContainText('3.0 GB')
  await expect(backend.locator('.dinkster-resource-bar')).toHaveAttribute('aria-label', 'Models: 3.0 GB, Held, unused: 0.5 GB, Other memory: 3.5 GB')
  const unload = model.getByRole('button', { name: 'Unload Flux model' })
  await unload.focus()
  await expect.poll(() => socket !== undefined).toBe(true)
  socket!.send(JSON.stringify({ type: 'memory_status', ...payload }))
  await expect(unload).toBeFocused()
  await unload.click()
  expect(unloads).toEqual([])
  await backend.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(unloads).toEqual([])
  await unload.click()
  await backend.getByRole('button', { name: 'Unload', exact: true }).click()
  await expect.poll(() => unloads).toEqual([{ device: 'vram:cuda:0', consumers: ['models'], items: ['flux'] }])
  await backend.getByText('Details', { exact: true }).click()
  await expect(backend).toContainText('Peak since reset')
  const peak = backend.locator('.dinkster-resource-peak')
  await expect(peak.getByRole('button', { name: 'Reset', exact: true })).toBeVisible()
  await backend.getByText('Limits', { exact: true }).click()
  const limit = backend.getByRole('slider', { name: 'Memory limit, vram:cuda:0' })
  await limit.focus(); await limit.press('ArrowLeft')
  await expect(backend.getByRole('alert')).toContainText('Server policy refused the limit.')
  rejected = false
  await limit.press('ArrowLeft')
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]!.category).toBe('memory-budgets')
  const second = card('Second GPU', 24e9, 8e9)
  payload = { ...initial, memoryGovernor: { ...initial.memoryGovernor, 'vram:cuda:1': second } } as typeof initial
  socket!.send(JSON.stringify({ type: 'memory_status', ...payload }))
  await expect(backend.locator('.dinkster-resource-card')).toHaveCount(2)
  await expect(backend.locator('.dinkster-resource-card').nth(1).locator('.dinkster-resource-model')).toContainText('1.0 GB')
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: 1000 })
    await testInfo.attach(`Resources two cards ${width}`, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' })
  }
})
