import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const PROOF = '/tmp/audit-assets-m1-proof'
const digest = (character: string): string => `blake3:${character.repeat(64)}`
const ZETA_DIGEST = `blake3:${'0123456789abcdef'.repeat(4)}`
const AMBER_DIGEST = digest('b')

const mounted = {
  alpha: [
    { virtualPath: 'models/zeta.safetensors', name: 'zeta.safetensors', digest: ZETA_DIGEST, size: 20, mediaType: 'application/x-safetensors', kind: 'model/checkpoint' },
    { virtualPath: 'images/amber.png', name: 'amber.png', digest: AMBER_DIGEST, size: 10, mediaType: 'image/png', kind: 'media/image' },
  ],
  beta: [
    { virtualPath: 'images/blue.png', name: 'blue.png', digest: digest('c'), size: 12, mediaType: 'image/png', kind: 'media/image' },
  ],
} as const

test('global Assets browse surface is aggregated, honest, persistent, and read-only', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  await page.route('/supervisor/status', (route) => void route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => void route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => void route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'assets-menu-e2e', schemaWire: 16 },
    nodes: {},
  } }))
  await page.route('**/api/mounts', (route) => void route.fulfill({ json: { mounts: [
    { id: 'alpha', mode: 'read', state: 'ready' },
    { id: 'beta', mode: 'read', state: 'ready' },
    { id: 'offline', mode: 'read', state: 'offline' },
  ] } }))
  await page.route('**/api/mounts/*/entries?*', (route) => {
    const url = new URL(route.request().url())
    const mount = decodeURIComponent(url.pathname.split('/')[3]!) as keyof typeof mounted
    const query = (url.searchParams.get('q') ?? '').toLowerCase()
    const entries = (mounted[mount] ?? []).filter((entry) => entry.name.toLowerCase().includes(query))
    return void route.fulfill({ json: { entries } })
  })
  await page.route('**/api/assets/*/metadata', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await route.fulfill({ json: { tensorCount: 2, dtypes: { F16: 2 } } })
  })
  await page.route('**/api/assets/*', (route) => void route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAgUlEQVR42u3YsRUAEBBEwWtCrFf1qUcgoQNibgLhBSb6b2P2sk6vtnF8r98HAAAAAAAAkBjg9w/e7gEAAAAAAIDMAEoQAAAAAAAAsAcoQQAAAAAAAMAeoAQBAAAAAAAAe4ASBAAAAAAAAOwBShAAAAAAAACwByhBAAAAAAAA4DuADXYIgobovTz/AAAAAElFTkSuQmCC', 'base64'),
  }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.protocol ?? 'pending')).toBe('dinkster')
  const initialRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await expect(page.getByTestId('assets-toggle')).toBeVisible()
  await page.getByTestId('assets-toggle').click()
  const assetsPanel = page.getByTestId('assets-overlay')
  await expect(assetsPanel).toBeVisible()
  await page.screenshot({ path: `${PROOF}/01-assets-dock-open.png`, fullPage: true })

  const sourceSelect = assetsPanel.getByTestId('asset-source-select')
  await expect(sourceSelect).toHaveAttribute('data-selected-id', 'all-assets')
  const titles = await page.locator('[data-testid="collection-entry"] .collection-title').allTextContents()
  expect(titles.slice(0, 3)).toEqual(['amber.png', 'blue.png', 'zeta.safetensors'])
  await page.screenshot({ path: `${PROOF}/02-all-assets-interleaved.png`, fullPage: true })

  await sourceSelect.click()
  await page.getByRole('listbox', { name: 'Asset source' }).getByRole('option', { name: 'Other / Alpha', exact: true }).click()
  await expect(page.getByRole('option', { name: /amber\.png/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /blue\.png/ })).toHaveCount(0)
  await page.screenshot({ path: `${PROOF}/03-single-mount.png`, fullPage: true })

  await sourceSelect.click()
  await page.getByRole('listbox', { name: 'Asset source' }).getByRole('option', { name: 'All assets', exact: true }).click()
  await assetsPanel.getByTestId('collection-search').fill('blue')
  await expect(page.getByRole('option', { name: /blue\.png/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /amber\.png/ })).toHaveCount(0)
  await page.screenshot({ path: `${PROOF}/04-search-narrowed.png`, fullPage: true })

  await assetsPanel.getByTestId('collection-search').fill('')
  await assetsPanel.getByTestId('collection-mode').click()
  await expect(assetsPanel.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(initialRevision)
  await page.reload()
  await expect(page.getByTestId('assets-toggle')).toBeVisible()
  if (!await assetsPanel.isVisible()) await page.getByTestId('assets-toggle').click()
  await expect(assetsPanel).toBeVisible()
  await expect(assetsPanel.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
  await expect(assetsPanel.getByTestId('asset-selection-empty')).toContainText('Click an asset')
  const reloadRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.screenshot({ path: `${PROOF}/05-grid-persists-reload.png`, fullPage: true })

  await page.getByRole('option', { name: /zeta\.safetensors/ }).click()
  const selection = assetsPanel.getByTestId('asset-selection-summary')
  await expect(selection.getByRole('heading', { name: 'zeta.safetensors' })).toBeVisible()
  await expect(selection.getByTestId('asset-rail-details')).not.toHaveAttribute('open', '')
  await selection.getByTestId('asset-rail-details').locator('summary').focus()
  await page.mouse.move(1000, 700)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${PROOF}/06-selection-panel.png`, fullPage: true })
  await selection.getByTestId('asset-rail-details').locator('summary').click()
  await expect(selection).toContainText(`${ZETA_DIGEST.slice(0, 12)}...${ZETA_DIGEST.slice(-8)}`)
  await expect(selection.locator('.asset-digest code')).toHaveAttribute('title', ZETA_DIGEST)
  await expect(selection.getByRole('button', { name: 'Copy digest' })).toBeVisible()
  await page.mouse.move(1000, 700)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${PROOF}/06a-digest-details.png`, fullPage: true })
  await selection.getByRole('button', { name: 'Inspect model metadata' }).click()
  await page.getByRole('option', { name: /amber\.png/ }).click()
  await expect(selection.getByRole('heading', { name: 'amber.png' })).toBeVisible()
  await expect(selection.getByRole('img', { name: 'Preview of amber.png' })).toBeVisible()
  await expect(selection.getByTestId('asset-preview-caption')).toHaveText('64 x 64')
  await page.waitForTimeout(400)
  await expect(selection.locator('pre')).toHaveCount(0)
  await selection.getByTestId('asset-rail-details').locator('summary').focus()
  await page.mouse.move(1000, 700)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${PROOF}/06b-image-selection.png`, fullPage: true })

  const health = page.getByTestId('asset-source-health')
  await health.locator('summary').click()
  const unavailable = health.locator('[data-source="mount:offline"]')
  await expect(unavailable).toHaveAttribute('data-state', 'offline')
  await expect(unavailable.locator('strong')).toHaveText('Offline')
  await expect(unavailable.locator(':scope > span')).toHaveText('offline')
  await expect(unavailable.locator('small')).toHaveText('Mount offline')
  await page.screenshot({ path: `${PROOF}/07-offline-reason.png`, fullPage: true })

  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(reloadRevision)
  await page.screenshot({ path: `${PROOF}/08-read-only-final.png`, fullPage: true })
})

test('mount scan progress stays visible while the scan is active', async ({ page }) => {
  const proof = '/tmp/dinkster-116-proof/mount-scan-progress.png'
  await mkdir('/tmp/dinkster-116-proof', { recursive: true })
  await page.route('/supervisor/status', (route) => void route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => void route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => void route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'mount-scan-progress-e2e', schemaWire: 22 },
    nodes: {},
  } }))
  await page.route('**/api/mounts', (route) => void route.fulfill({ json: { mounts: [{
    id: 'checkpoints',
    mode: 'read',
    state: 'scanning',
    entryCount: 37,
    scanProgress: {
      filesDone: 37,
      filesTotal: 120,
      bytesDone: 4_831_838_208,
      bytesTotal: 19_327_352_832,
      elapsedSeconds: 48.7,
    },
  }] } }))
  await page.route('**/api/mounts/checkpoints/entries?*', (route) => void route.fulfill({ json: { entries: [{
    virtualPath: 'models/indexed.ckpt',
    name: 'indexed.ckpt',
    digest: digest('d'),
    size: 2048,
    mediaType: 'application/octet-stream',
    kind: 'model/checkpoint',
  }] } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.protocol ?? 'pending')).toBe('dinkster')
  await page.getByTestId('assets-toggle').click()
  await expect(page.getByRole('option', { name: /indexed\.ckpt/ })).toBeVisible()
  const health = page.getByTestId('asset-source-health')
  await health.locator('summary').click()
  const scanning = health.locator('[data-source="mount:checkpoints"]')
  await expect(scanning).toHaveAttribute('data-state', 'scanning')
  await expect(scanning).toContainText('Indexed 37/120 files, 4.5 GiB/18 GiB, 48s elapsed')
  await page.screenshot({ path: proof, fullPage: true })
})
