import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const fixture = JSON.parse(readFileSync(new URL('../../client/test/fixtures/federated-assets-v1.json', import.meta.url), 'utf8'))

test('honors configured federated routes and otherwise stays on local mounts', async ({ page }) => {
  const posts: { path: string; body: unknown }[] = []
  const localDigest = `blake3:${'c'.repeat(64)}`
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'audit-e2e', schemaWire: 22 },
    nodes: {},
  } }))
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [
    { id: 'local-models', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
  ] } }))
  await page.route('**/api/mounts/*/entries?*', (route) => route.fulfill({ json: { entries: [{
    digest: localDigest,
    name: 'local-only.safetensors',
    size: 64,
    mediaType: 'application/x-safetensors',
    kind: 'model/checkpoint',
    virtualPath: 'models/local-only.safetensors',
  }] } }))
  await page.route('/api/catalog', async (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    await route.fulfill({ json: fixture.catalogResponse })
  })
  await page.route('/api/catalog/candidates', (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    return route.fulfill({ json: fixture.candidatesResponse })
  })
  await page.goto('/')
  await page.getByTestId('assets-toggle').click()
  const assetsPanel = page.getByTestId('assets-overlay')
  await expect.poll(async () => posts.length > 0 || await page.getByRole('option', { name: /local-only\.safetensors/ }).count() > 0).toBe(true)
  if (posts.length > 0) {
    const alpha = assetsPanel.getByRole('option', { name: /alpha\.safetensors/ })
    await expect(alpha.locator('.collection-badge').last()).toHaveText('alpha / local')
    await alpha.click()
    const details = alpha.getByTestId('collection-details')
    await expect(details.locator('dt').nth(0)).toHaveText('Logical ID')
    await expect(details.locator('dd').nth(0)).toHaveText('alpha')
    await expect(details.locator('dt').nth(1)).toHaveText('Variant ID')
    await expect(details.locator('dd').nth(1)).toHaveText('fp16')
    await expect(details.locator('dt').nth(2)).toHaveText('Provider')
    await expect(details.locator('dd').nth(2)).toHaveText('alpha')
    await expect(details.locator('dt').nth(3)).toHaveText('Source')
    await expect(details.locator('dd').nth(3)).toHaveText('local')
    expect(posts.every((post) => post.path === '/api/catalog')).toBe(true)
    expect(posts.every((post) => JSON.stringify(post.body) === JSON.stringify({ contractVersion: 1, query: '', limit: 24 }))).toBe(true)

    await page.unroute('/api/catalog')
    await page.route('/api/catalog', (route) => route.fulfill({ status: 401, json: fixture.errors.authentication401 }))
    await assetsPanel.getByTestId('collection-search').fill('auth')
    await expect(assetsPanel).toContainText('Assets unavailable')
    await expect(assetsPanel).toContainText('Authentication required')
  } else {
    expect(posts).toEqual([])
    await expect(page.getByRole('option', { name: /local-only\.safetensors/ })).toBeVisible()
    await expect(page.getByText('alpha / fp16')).toHaveCount(0)
    await assetsPanel.getByTestId('collection-search').fill('local-only')
    await expect(page.getByRole('option', { name: /local-only\.safetensors/ })).toBeVisible()
    expect(posts).toEqual([])
  }
})
