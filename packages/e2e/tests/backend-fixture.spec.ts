import { expect, nativeTest, test } from './fixtures.js'

test('shared fixture selects its configured backend without stock discovery', async ({ page }) => {
  const legacy = process.env['DINKSTER_E2E_FIXTURE_MODE'] === 'legacy' || process.env['DINKSTER_E2E_USE_NATIVE'] !== '1'
  let schemaRequests = 0
  let discoveryRequests = 0
  await page.route('/system_stats', (route) => {
    discoveryRequests += 1
    return route.fulfill({ json: { system: {}, devices: [] } })
  })
  await page.route('/object_info', (route) => {
    schemaRequests += 1
    return route.fulfill({ json: {} })
  })
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'fixture-test', schemaWire: 1 }, nodes: {},
  } }))
  await page.routeWebSocket('**/ws?*', () => {})
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const backend = window.__dinksterTest?.app.backends.get()[0]
    return { protocol: backend?.protocol, schemas: backend?.registry.get()?.schemas.size }
  })).toEqual({ protocol: legacy ? 'v1' : 'dinkster', schemas: 0 })
  expect(schemaRequests).toBe(legacy ? 1 : 0)
  expect(discoveryRequests).toBe(0)
})

nativeTest('native fixture stays native on the compatibility-enabled test server', async ({ page }) => {
  let legacyRequests = 0
  await page.route('/object_info', (route) => {
    legacyRequests += 1
    return route.fulfill({ json: {} })
  })
  await page.route('/api/**', (route) => route.fulfill({ status: 503 }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'fixture-test', schemaWire: 1 }, nodes: {},
  } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const backend = window.__dinksterTest?.app.backends.get()[0]
    return { protocol: backend?.protocol, schemas: backend?.registry.get()?.schemas.size }
  })).toEqual({ protocol: 'dinkster', schemas: 0 })
  expect(legacyRequests).toBe(0)
})
