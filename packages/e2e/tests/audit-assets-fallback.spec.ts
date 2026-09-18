import { expect, test } from '@playwright/test'

test('keeps the no-contract All assets fan-out behavior', async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'audit-fallback', schemaWire: 22 }, nodes: {} } }))
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [
    { id: 'alpha', mode: 'read', state: 'ready', kind: 'media/image', entryCount: 1 },
    { id: 'beta', mode: 'read', state: 'ready', kind: 'media/image', entryCount: 1 },
  ] } }))
  await page.route('**/api/mounts/*/entries?*', (route) => {
    const url = new URL(route.request().url())
    const mount = decodeURIComponent(url.pathname.split('/')[3]!)
    const query = url.searchParams.get('q') ?? ''
    const name = mount === 'alpha' ? 'amber.png' : 'blue.png'
    const entries = name.includes(query) ? [{ virtualPath: name, name, digest: `blake3:${mount === 'alpha' ? 'a' : 'b'.repeat(64)}`, size: 1, mediaType: 'image/png', kind: 'media/image' }] : []
    return route.fulfill({ json: { entries } })
  })
  let catalogRequests = 0
  await page.route('/api/catalog', (route) => { catalogRequests += 1; return route.abort() })
  await page.goto('/')
  await page.getByTestId('assets-toggle').click()
  const assets = page.getByTestId('assets-overlay')
  await expect(assets).toBeVisible()
  await expect(assets.getByRole('option', { name: /amber\.png/ })).toBeVisible()
  await expect(assets.getByRole('option', { name: /blue\.png/ })).toBeVisible()
  await assets.getByTestId('collection-search').fill('blue')
  await expect(assets.getByRole('option', { name: /amber\.png/ })).toHaveCount(0)
  await expect(assets.getByRole('option', { name: /blue\.png/ })).toBeVisible()
  expect(catalogRequests).toBe(0)
})
