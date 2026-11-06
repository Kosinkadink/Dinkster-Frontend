import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { NodeSchema } from '@dinkster/core'
import catalog from '../../core/fixtures/dinkster-nodes-comfy.json' with { type: 'json' }
import { expect, test } from './fixtures.js'

test('uninstalled search renders the same real preview as installed search and never places on selection', async ({ page }) => {
  const wire = { ...catalog.nodes['comfy.EmptyImage'], pack: 'image-tools', displayName: 'Catalog Image', searchTerms: ['catalog-resample'] }
  const body = JSON.stringify({ packName: 'image-tools', version: '1.10.0', schemas: [{ nodeType: 'image.catalog', schemaVersion: 1, schemaWireVersion: 1, schemaSignature: 'catalog-image', role: 'compute', schema: wire }] })
  await page.route(/\/api\/nodes(?:\?.*)?$/, (route) => route.fulfill({ json: { ...catalog, nodes: {} } }))
  await page.route('https://catalog.example/static/**', (route) => route.fulfill({
    headers: { 'Access-Control-Allow-Origin': '*' },
    body: route.request().url().endsWith('index.json') ? JSON.stringify({ schemaVersion: 1, items: [{ name: 'image-tools', publisher: 'dinkster', version: '1.10.0', displayName: 'Image Tools', platforms: ['linux', 'darwin'], url: 'packs/image-tools/1.10.0/schemas.json', digest: `sha256:${createHash('sha256').update(body).digest('hex')}` }] }) : body,
    contentType: 'application/json',
  }))
  await page.addInitScript(() => localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'search.registryUrl': 'https://catalog.example/static' } })))
  await page.goto('/')
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ catalog-resample')
  const row = page.locator('[data-provider="core.nodes"] [data-testid="search-result-row"]').first()
  await expect(row).toContainText('Image Tools - Not installed')
  const preview = page.getByTestId('search-node-preview')
  await expect(preview).toHaveAttribute('data-preview-ready', 'image.catalog')
  const uninstalledPixels = await preview.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())
  const proof = process.env['DINKSTER_SEARCH_PROOF_DIR']
  if (proof) { mkdirSync(proof, { recursive: true }); await page.screenshot({ path: join(proof, 'uninstalled-search.png') }) }
  await row.click()
  const prompt = page.locator('[data-modal="node-install"]')
  await expect(prompt).toBeVisible()
  await expect(prompt).toContainText('linux, darwin')
  await expect(page.getByTestId('graph-canvas')).not.toHaveAttribute('data-placement-ghost', 'visible')
  if (proof) await page.screenshot({ path: join(proof, 'uninstalled-prompt.png') })
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      searchCatalog: { get(): readonly { schema: NodeSchema }[] }
      registerSchemas(schemas: readonly NodeSchema[]): void
    }
    app.registerSchemas([app.searchCatalog.get()[0]!.schema])
  })
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ catalog-resample')
  await expect(row).not.toContainText('Not installed')
  await expect(preview).toHaveAttribute('data-preview-ready', 'image.catalog')
  expect(await preview.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).toBe(uninstalledPixels)
  if (proof) await page.screenshot({ path: join(proof, 'installed-search.png') })
  await page.setViewportSize({ width: 620, height: 820 })
  await expect(preview).toBeVisible()
  if (proof) await page.screenshot({ path: join(proof, 'installed-search-narrow.png') })
})
