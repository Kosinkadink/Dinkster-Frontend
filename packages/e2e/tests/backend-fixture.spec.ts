import { expect, nativeTest, test } from './fixtures.js'

test('shared fixture loads native schemas without stock discovery', async ({ page }) => {
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
    schemaVersion: 1, epoch: 1, dinkster: { version: 'fixture-test', schemaWire: 1 },
    nodes: { shared: { schemaVersion: 1, displayName: 'Shared native fixture', interface: [] } },
  } }))
  await page.routeWebSocket('**/ws?*', () => {})
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const backend = window.__dinksterTest?.app.backends.get()[0]
    return { protocol: backend?.protocol, schemas: backend?.registry.get()?.schemas.size }
  })).toEqual({ protocol: 'dinkster', schemas: 1 })
  expect(schemaRequests).toBe(0)
  expect(discoveryRequests).toBe(0)
})

nativeTest('native fixture loads schemas without a stock transport', async ({ page }) => {
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
