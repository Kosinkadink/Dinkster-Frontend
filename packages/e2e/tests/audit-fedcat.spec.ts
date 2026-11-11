import { expect, test } from '@playwright/test'

test('browses local mounts without requesting a federated catalog', async ({ page }) => {
  const posts: { path: string; body: unknown }[] = []
  const localDigest = `blake3:${'c'.repeat(64)}`
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'audit-e2e', schemaWire: 1 },
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
    await route.fulfill({ json: { items: [] } })
  })
  await page.route('/api/catalog/candidates', (route) => {
    posts.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() })
    return route.fulfill({ json: { items: [] } })
  })
  await page.goto('/')
  await page.getByTestId('assets-toggle').click()
  const assetsPanel = page.getByTestId('assets-overlay')
  await expect(page.getByRole('option', { name: /local-only\.safetensors/ })).toBeVisible()
  await expect(page.getByText('alpha / fp16')).toHaveCount(0)
  await assetsPanel.getByTestId('collection-search').fill('local-only')
  await expect(page.getByRole('option', { name: /local-only\.safetensors/ })).toBeVisible()
  expect(posts).toEqual([])
})
