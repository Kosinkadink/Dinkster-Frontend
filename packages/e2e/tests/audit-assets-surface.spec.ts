import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const PROOF = '/tmp/audit-assets-proof'
const sharedDigest = `blake3:${'a'.repeat(64)}`
const localDigest = `blake3:${'b'.repeat(64)}`
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxW8WQAAAABJRU5ErkJggg==', 'base64')

const candidate = {
  logicalId: 'federated-winner', family: 'flux', assetKind: 'model/checkpoint', variantId: 'fp16',
  dtype: 'fp16', quantization: 'none', format: 'safetensors', role: 'base',
  requirements: { loaders: [], runtimes: [], hardware: [] }, digest: sharedDigest,
  availability: { status: 'local', reason: '' }, compatibility: { status: 'compatible', reason: '' },
  assetRef: { digest: sharedDigest, name: 'Federated Winner.safetensors', size: 20, mediaType: 'application/octet-stream', virtualPath: 'models/federated.safetensors' },
  providerSources: [{ source: { providerId: 'registry', sourceId: 'primary' }, status: 'available', reason: '', requires: {} }],
}

const secondCandidate = {
  ...candidate,
  logicalId: 'federated-second',
  variantId: 'bf16',
  digest: `blake3:${'e'.repeat(64)}`,
  assetRef: { ...candidate.assetRef, digest: `blake3:${'e'.repeat(64)}`, name: 'Federated Second.safetensors', virtualPath: 'models/federated-second.safetensors' },
}

test('uses the configured All assets source while preserving curated per-mount browsing', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  let catalogRequests = 0
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'audit', schemaWire: 22 }, nodes: {} } }))
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
    return route.fulfill({ json: { contractVersion: 1, items: [secondCandidate, candidate] } })
  })
  await page.route('/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: pixel }))

  await page.goto('/')
  const firstRunNotice = page.getByTestId('p2p-first-run-notice')
  if (await firstRunNotice.waitFor({ state: 'visible', timeout: 2_000 }).then(() => true).catch(() => false)) {
    await firstRunNotice.getByRole('button', { name: 'Dismiss notice', exact: true }).last().click()
  }
  const assetsToggle = page.getByTestId('assets-toggle')
  await assetsToggle.click()
  await expect(page.getByTestId('assets-overlay')).toBeVisible()
  await expect.poll(() => page.getByRole('option').count()).toBeGreaterThan(0)
  const federated = catalogRequests > 0
  if (federated) {
    await expect(page.getByRole('option')).toHaveCount(2)
    await expect(page.getByRole('option', { name: /Federated Winner\.safetensors/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Federated Second\.safetensors/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /local\.safetensors/ })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /duplicate\.safetensors/ })).toHaveCount(0)
    const winner = page.getByRole('option', { name: /Federated Winner\.safetensors/ })
    await expect(winner.locator('.collection-subtitle')).toHaveCount(0)
    await expect(winner.locator('.collection-badge')).toHaveText(['20 B'])
    await winner.click()
    const details = page.getByTestId('asset-selection-summary')
    await details.getByTestId('asset-rail-details').locator('summary').click()
    await expect(details).toContainText('Kindmodel/checkpoint')
    await expect(details).toContainText('Virtual pathmodels/federated.safetensors')
    await expect(details).toContainText('Providerregistry')
    await expect(details).toContainText('Provider sourceprimary')
    await expect(details).toContainText('Availabilitylocal:')
    await expect(details).toContainText('Compatibilitycompatible:')
  } else {
    await expect(page.getByRole('option')).toHaveCount(4)
    await expect(page.getByRole('option', { name: /duplicate\.safetensors/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /image\.png/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /local\.safetensors/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /second\.safetensors/ })).toBeVisible()
    expect(catalogRequests).toBe(0)
  }
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
  await expect(page.getByRole('option')).toHaveCount(federated ? 2 : 4)
  if (federated) {
    await expect(page.getByRole('option', { name: /local\.safetensors/ })).toHaveCount(0)
    await expect(page.getByRole('option', { name: /Federated Winner\.safetensors/ })).toBeVisible()
  } else {
    await expect(page.getByRole('option', { name: /local\.safetensors/ })).toBeVisible()
    await expect(page.getByRole('option', { name: /Federated Winner\.safetensors/ })).toHaveCount(0)
  }

  await page.getByTestId('assets-toggle').hover()
  const description = page.getByText('Browse assets across mounted sources', { exact: true })
  await expect(description).toHaveCount(0)
  await page.getByTestId('library-toggle').click()
  await page.getByTestId('library-toggle').hover()
  await expect(page.getByText('Browse packs, execution history, and saved workflows', { exact: true })).toBeVisible()
  await page.getByTestId('assets-toggle').click()
  // Both dock tabs stay mounted once visited; scope to the assets panel.
  const assetsPanel = page.getByTestId('assets-overlay')
  await assetsPanel.getByTestId('collection-mode').click()
  await expect(assetsPanel.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
  if (federated) {
    await expect(assetsPanel.getByRole('option', { name: /Federated Winner\.safetensors/ }).locator('.collection-badge')).toHaveText(['20 B'])
  } else {
    await expect(assetsPanel.getByRole('option', { name: /local\.safetensors/ }).locator('.collection-badge').last()).toHaveText('21 B')
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.app-tooltip')).not.toBeVisible()
  await page.screenshot({ path: `${PROOF}/01-configured-all-assets-grid.png`, fullPage: true })
})
