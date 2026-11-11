import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const PROOF = '/tmp/audit-assets-proof'
const sharedDigest = `blake3:${'a'.repeat(64)}`
const localDigest = `blake3:${'b'.repeat(64)}`
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxW8WQAAAABJRU5ErkJggg==', 'base64')

test('uses the configured All assets source while preserving curated per-mount browsing', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  let catalogRequests = 0
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'audit', schemaWire: 1 }, nodes: {} } }))
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [
    { id: 'comfy-model-checkpoints-1', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 2 },
    { id: 'comfy-model-checkpoints-2', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
    { id: 'comfy-input', mode: 'read', state: 'ready', kind: 'media/image', entryCount: 1 },
    { id: 'empty-loras', mode: 'read', state: 'ready', kind: 'model/lora', entryCount: 0 },
    { id: 'failed-checkpoints', mode: 'read', state: 'failed', kind: 'model/checkpoint', entryCount: 1 },
  ] } }))
  await page.route('**/api/mounts/*/entries?*', (route) => {
    const mount = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]!)
    const rows = mount === 'comfy-model-checkpoints-1'
      ? [
          { virtualPath: 'models/duplicate.safetensors', name: 'duplicate.safetensors', digest: sharedDigest, size: 20, mediaType: 'application/octet-stream', kind: 'model/checkpoint' },
          { virtualPath: 'models/local.safetensors', name: 'local.safetensors', digest: localDigest, size: 21, mediaType: 'application/octet-stream', kind: 'model/checkpoint' },
        ]
      : mount === 'comfy-model-checkpoints-2'
        ? [{ virtualPath: 'models/second.safetensors', name: 'second.safetensors', digest: `blake3:${'c'.repeat(64)}`, size: 22, mediaType: 'application/octet-stream', kind: 'model/checkpoint' }]
        : mount === 'comfy-input'
          ? [{ virtualPath: 'image.png', name: 'image.png', digest: `blake3:${'d'.repeat(64)}`, size: 23, mediaType: 'image/png', kind: 'media/image' }]
          : []
    return route.fulfill({ json: { entries: rows } })
  })
  await page.route('/api/catalog', (route) => {
    catalogRequests += 1
    return route.fulfill({ json: { items: [] } })
  })
  await page.route('/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: pixel }))
  await page.route('**/api/assets/catalog?*', (route) => route.fulfill({ json: { assets: [] } }))

  await page.goto('/')
  const assetsToggle = page.getByTestId('assets-toggle')
  await assetsToggle.focus()
  await expect(page.getByText('Browse assets across mounted sources', { exact: true })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.getByText('Browse assets across mounted sources', { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('assets-overlay')).toBeVisible()
  await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(0)
  await expect(page.getByRole('option')).toHaveCount(4)
  await expect(page.getByRole('option', { name: /duplicate\.safetensors/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /image\.png/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /local\.safetensors/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /second\.safetensors/ })).toBeVisible()
  expect(catalogRequests).toBe(0)
  const sourceSelect = page.getByTestId('asset-source-select')
  await expect(sourceSelect).toHaveAttribute('data-selected-id', 'all-assets')
  await sourceSelect.click()
  const sourceList = page.getByRole('listbox', { name: 'Asset source' })
  await expect(sourceList.getByRole('option', { name: 'Models / Checkpoints 2' })).toBeVisible()
  await expect(sourceList.getByRole('option', { name: 'Input/Output / Input' })).toBeVisible()
  await expect(sourceList.getByRole('option', { name: /LoRAs/ })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const health = page.getByTestId('asset-source-health')
  await expect(health).toContainText('2 issues')
  await health.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(health.locator('[data-source="mount:empty-loras"]')).toContainText('empty')
  await expect(health.locator('[data-source="mount:failed-checkpoints"]')).toContainText('failed')

  await sourceSelect.click()
  await sourceList.getByRole('option', { name: 'Models / Checkpoints 2' }).click()
  await expect(sourceSelect).toHaveAttribute('data-selected-id', 'mount:comfy-model-checkpoints-2')
  await expect(page.getByRole('option', { name: /second\.safetensors/ })).toBeVisible()

  await sourceSelect.click()
  await sourceList.getByRole('option', { name: 'Models / Checkpoints', exact: true }).click()
  await expect(page.getByRole('option', { name: /local\.safetensors/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /duplicate\.safetensors/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /local\.safetensors/ }).locator('.collection-badge').last()).toHaveText('21 B')

  await sourceSelect.click()
  await sourceList.getByRole('option', { name: 'All assets', exact: true }).click()
  await expect(page.getByRole('option')).toHaveCount(4)
  await expect(page.getByRole('option', { name: /local\.safetensors/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /Federated Winner\.safetensors/ })).toHaveCount(0)

  await page.getByTestId('assets-toggle').hover()
  const description = page.getByText('Browse assets across mounted sources', { exact: true })
  await expect(description).toHaveCount(0)
  await page.getByTestId('library-toggle').click()
  await page.getByTestId('library-toggle').hover()
  const libraryDescription = page.getByText('Browse packs, execution history, and saved workflows', { exact: true })
  await expect(page.getByTestId('library-toggle')).toHaveAttribute('aria-pressed', 'true')
  await expect(libraryDescription).toHaveCount(0)
  await page.getByTestId('library-toggle').click()
  await page.getByTestId('graph-canvas').hover()
  await page.getByTestId('library-toggle').hover()
  await expect(page.getByTestId('library-toggle')).toHaveAttribute('aria-pressed', 'false')
  await expect(libraryDescription).toBeVisible()
  await page.getByTestId('assets-toggle').click()
  // Both dock tabs stay mounted once visited; scope to the assets panel.
  const assetsPanel = page.getByTestId('assets-overlay')
  await assetsPanel.getByTestId('collection-mode').click()
  await expect(assetsPanel.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
  await expect(assetsPanel.getByRole('option', { name: /local\.safetensors/ }).locator('.collection-badge').last()).toHaveText('21 B')
  await page.keyboard.press('Escape')
  await expect(page.locator('.app-tooltip')).not.toBeVisible()
  await page.screenshot({ path: `${PROOF}/01-configured-all-assets-grid.png`, fullPage: true })
})
