/**
 * Native catalog presentation proofs. This spec intentionally imports the
 * Playwright base directly: the shared legacy fixture disables same-origin
 * /api/nodes and therefore cannot prove native catalog identity.
 */
import { expect, test, type Page } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

async function openPalette(page: Page): Promise<void> {
  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()
}

async function registerDuplicateName(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const original = app.backends.get()[0]!.registry.get()!.resolve('dinkster.utilities.preview_any')!
    // Canonical context is visible only for duplicate display names.
    app.registerSchemas([{ ...original, type: 'CatalogPreviewText' }])
  })
}

test.beforeEach(async ({ page, request }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND so the Vite same-origin proxy targets the native backend')
  const direct = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(3000) })
  test.skip(!direct.ok, `native backend is unavailable at ${NATIVE_BACKEND}`)
  const sameOrigin = await request.get('/api/nodes')
  expect(sameOrigin.ok()).toBe(true)
  const payload = await sameOrigin.json() as { dinkster?: { schemaWire?: number }; nodes?: Record<string, unknown> }
  expect(payload.dinkster?.schemaWire).toBe(1)
  expect(payload.nodes?.['dinkster.utilities.preview_any']).toBeDefined()
  expect(payload.nodes?.['dinkster.image.save_image']).toBeDefined()

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText('connected')
  expect(await page.evaluate(() => window.__dinksterTest!.app.backends.get()[0]!.protocol)).toBe('dinkster')
})

test('native palette exposes canonical accessible identity', async ({ page }) => {
  await registerDuplicateName(page)
  await openPalette(page)
  await page.getByTestId('palette-search').fill('Preview as Text')

  const native = page.locator('[data-node-type="dinkster.utilities.preview_any"]').getByRole('option')
  await expect(native).toBeVisible()
  await expect(native.locator('.search-result-row-detail')).toHaveText(
    'dinkster-utilities - utilities - dinkster.utilities.preview_any',
  )
  await expect(native).toHaveRole('option')
  await expect(native).toHaveAccessibleName(/Preview as Text/)
  await page.getByTestId('palette-search').press('ArrowDown')
  const activeId = await page.getByTestId('palette-search').getAttribute('aria-activedescendant')
  expect(activeId).not.toBeNull()
  await expect(page.locator(`#${activeId}`)).toHaveRole('option')
})

test('native universal search lists the canonical node', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'native-search-display', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
    view: { graphs: { g0: { nodes: {} } } },
  }, 'Native Search Display'))
  await registerDuplicateName(page)
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ Preview as Text')

  const group = page.locator('[data-provider="core.nodes"]')
  const native = group.getByRole('option', {
    name: /Preview as Text dinkster-utilities/,
  })
  await expect(native).toBeVisible()
  await expect(native).toHaveAccessibleName(/Preview as Text/)
})
