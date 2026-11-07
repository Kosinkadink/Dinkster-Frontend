import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { Page } from '@playwright/test'
import catalog from '../../core/fixtures/dinkster-nodes-comfy.json' with { type: 'json' }
import { expect, test } from './fixtures.js'

test('uninstalled search renders the same real preview as installed search and never places on selection', async ({ page }) => {
  const wire = { ...catalog.nodes['comfy.EmptyImage'], pack: 'image-tools', displayName: 'Catalog Image', searchTerms: ['catalog-resample'] }
  const body = JSON.stringify({ packName: 'image-tools', version: '1.10.0', schemas: [{ nodeType: 'image.catalog', schemaVersion: 1, schemaWireVersion: 1, schemaSignature: 'catalog-image', role: 'compute', schema: wire }] })
  let installed = false
  let plans = 0
  let applies = 0
  await page.route(/\/api\/nodes(?:\?.*)?$/, (route) => route.fulfill({ json: { ...catalog, nodes: installed ? { 'image.catalog': wire } : {} } }))
  await page.route('**/api/packs/install/plan', (route) => {
    expect(route.request().postDataJSON()).toEqual({ packs: [{ pack: 'image-tools', version: '1.10.0' }] })
    plans++
    return plans === 1 ? route.fulfill({ status: 404, json: { error: 'not-found' } }) : route.fulfill({ json: {
      confirmation: 'server-confirmation', plan: { format: 'dinkster.plan/1' },
      review: 'Install image-tools 1.10.0\nAdd isolated image dependencies; keep existing packs unchanged.', expiresInSeconds: 900,
    } })
  })
  await page.route('**/api/packs/install/apply', (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmation: 'server-confirmation' })
    applies++
    installed = true
    return route.fulfill({ json: { generation: 2, activation: { generation: 2, epoch: 3, added: ['image-tools'], removed: [], reloaded: [], unchanged: [], failed: {}, rolledBack: false } } })
  })
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
  expect(applies).toBe(0)
  await prompt.getByRole('button', { name: 'Review installation', exact: true }).click()
  await expect(prompt).toContainText('Pack installation is not available')
  if (proof) await page.screenshot({ path: join(proof, 'unavailable-prompt.png') })
  await prompt.getByRole('button', { name: 'Review installation', exact: true }).click()
  await expect(prompt).toContainText('keep existing packs unchanged')
  expect(applies).toBe(0)
  if (proof) await page.screenshot({ path: join(proof, 'review-prompt.png') })
  await prompt.getByRole('button', { name: 'Confirm installation', exact: true }).click()
  await expect(prompt).toContainText('Installed. Close this prompt')
  expect(applies).toBe(1)
  await expect(page.getByTestId('graph-canvas')).not.toHaveAttribute('data-placement-ghost', 'visible')
  if (proof) await page.screenshot({ path: join(proof, 'installed-prompt.png') })
  await prompt.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ catalog-resample')
  await expect(row).not.toContainText('Not installed')
  await expect(preview).toHaveAttribute('data-preview-ready', 'image.catalog')
  expect(await preview.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).toBe(uninstalledPixels)
  if (proof) await page.screenshot({ path: join(proof, 'installed-search.png') })
  await page.setViewportSize({ width: 620, height: 820 })
  await expect(preview).toBeVisible()
  if (proof) await page.screenshot({ path: join(proof, 'installed-search-narrow.png') })
  await row.click()
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-placement-ghost', 'visible')
})

async function openInstallPrompt(page: Page) {
  const state = { installed: false }
  const wire = { ...catalog.nodes['comfy.EmptyImage'], pack: 'image-tools', displayName: 'Catalog Image', searchTerms: ['catalog-resample'] }
  const body = JSON.stringify({ packName: 'image-tools', version: '1.10.0', schemas: [{ nodeType: 'image.catalog', schemaVersion: 1, schemaWireVersion: 1, schemaSignature: 'catalog-image', role: 'executing', schema: wire }] })
  await page.route(/\/api\/nodes(?:\?.*)?$/, (route) => route.fulfill({ json: { ...catalog, nodes: state.installed ? { 'image.catalog': wire } : {} } }))
  await page.route('https://catalog.example/static/**', (route) => route.fulfill({
    headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json',
    body: route.request().url().endsWith('index.json') ? JSON.stringify({ schemaVersion: 1, items: [{ name: 'image-tools', publisher: 'dinkster', version: '1.10.0', displayName: 'Image Tools', platforms: ['linux'], url: 'packs/image-tools/1.10.0/schemas.json', digest: `sha256:${createHash('sha256').update(body).digest('hex')}` }] }) : body,
  }))
  await page.addInitScript(() => localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'search.registryUrl': 'https://catalog.example/static' } })))
  await page.goto('/')
  const open = async () => {
    await page.getByTestId('topbar-search').click()
    await page.getByTestId('universal-search-input').fill('@ catalog-resample')
    await page.locator('[data-provider="core.nodes"] [data-testid="search-result-row"]').first().click()
    await expect(page.locator('[data-modal="node-install"]')).toBeVisible()
  }
  await open()
  return { state, open, prompt: page.locator('[data-modal="node-install"]') }
}

const reviewPlan = { confirmation: 'review-token', plan: { format: 'dinkster.plan/1' }, review: 'Install Image Tools 1.10.0', expiresInSeconds: 900 }

for (const outcome of ['lost-response', 'malformed-success', 'cancel-waiting'] as const) {
  test(`installation ${outcome} cannot be retried and reconciles through the installed catalog`, async ({ page }) => {
    const { state, open, prompt } = await openInstallPrompt(page)
    let applies = 0
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    await page.route('**/api/packs/install/plan', (route) => route.fulfill({ json: reviewPlan }))
    await page.route('**/api/packs/install/apply', async (route) => {
      applies++
      if (outcome === 'cancel-waiting') { await gate; return }
      state.installed = true
      if (outcome === 'lost-response') await route.abort('failed')
      else await route.fulfill({ json: { generation: 2, activation: null } })
    })
    await prompt.getByRole('button', { name: 'Review installation', exact: true }).click()
    await prompt.getByRole('button', { name: 'Confirm installation', exact: true }).click()
    if (outcome === 'cancel-waiting') {
      await expect.poll(() => applies).toBe(1)
      await expect(prompt).toContainText('Installation may continue')
      const proof = process.env['DINKSTER_SEARCH_PROOF_DIR']
      if (proof) await page.screenshot({ path: join(proof, 'cancel-waiting-prompt.png') })
      await prompt.getByRole('button', { name: 'Cancel waiting', exact: true }).click()
      release()
      await expect(prompt).not.toBeVisible()
      await open()
      state.installed = true
    }
    await expect(prompt).toContainText('Do not install again')
    await expect(prompt.getByRole('button', { name: 'Review installation', exact: true })).toHaveCount(0)
    await expect(prompt.getByRole('button', { name: 'Confirm installation', exact: true })).toHaveCount(0)
    if (outcome !== 'cancel-waiting') {
      const proof = process.env['DINKSTER_SEARCH_PROOF_DIR']
      if (proof) await page.screenshot({ path: join(proof, `unknown-${outcome}.png`) })
    }
    await prompt.getByRole('button', { name: 'Refresh installed catalog', exact: true }).click()
    await expect(prompt).toContainText('Installed. Close this prompt')
    expect(applies).toBe(1)
    await expect(page.getByTestId('graph-canvas')).not.toHaveAttribute('data-placement-ghost', 'visible')
  })
}

test('hanging installation planning can be dismissed and expired review cannot be confirmed', async ({ page }) => {
  const { open, prompt } = await openInstallPrompt(page)
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/packs/install/plan', async (route) => { await gate; await route.fulfill({ json: reviewPlan }) })
  const request = page.waitForRequest('**/api/packs/install/plan')
  await prompt.getByRole('button', { name: 'Review installation', exact: true }).click()
  await request
  await prompt.getByRole('button', { name: 'Cancel waiting', exact: true }).click()
  release()
  await expect(prompt).not.toBeVisible()
  await page.unroute('**/api/packs/install/plan')
  await page.route('**/api/packs/install/plan', (route) => route.fulfill({ json: { ...reviewPlan, expiresInSeconds: 2 } }))
  await open()
  await page.clock.install()
  await prompt.getByRole('button', { name: 'Review installation', exact: true }).click()
  await expect(prompt.getByRole('button', { name: 'Confirm installation', exact: true })).toBeVisible()
  await page.clock.fastForward(2_001)
  await expect(prompt).toContainText('This installation review expired')
  await expect(prompt.getByRole('button', { name: 'Confirm installation', exact: true })).toHaveCount(0)
  await expect(prompt.getByRole('button', { name: 'Review installation', exact: true })).toBeEnabled()
  const proof = process.env['DINKSTER_SEARCH_PROOF_DIR']
  if (proof) await page.screenshot({ path: join(proof, 'expired-prompt.png') })
})
