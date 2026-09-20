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

async function openNativeSaveTarget(page: Page): Promise<void> {
  await page.route('/api/mounts*', (route) => void route.fulfill({
    json: { mounts: [{ id: 'comfy-output', mode: 'readwrite', state: 'ready' }] },
  }))
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'native-save-target-display', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { save: { id: 'save', type: 'dinkster.save_image', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { save: { position: { x: 100, y: 100 } } } } } },
    }, 'Native Save Target Display')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'save')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'target')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('save-target-editor')).toBeVisible()
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
  expect(payload.nodes?.['dinkster.preview_any']).toBeDefined()
  expect(payload.nodes?.['dinkster.save_image']).toBeDefined()

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText('connected')
  expect(await page.evaluate(() => window.__dinksterTest!.app.backends.get()[0]!.protocol)).toBe('dinkster')
})

test('native palette exposes canonical accessible identity', async ({ page }) => {
  await openPalette(page)
  await page.getByTestId('palette-search').fill('Preview as Text')

  const native = page.locator('[data-node-type="dinkster.preview_any"]').getByRole('option')
  await expect(native).toBeVisible()
  await expect(native.locator('.search-result-row-detail')).toHaveText(
    'dinkster-nodes-foundation - utilities - dinkster.preview_any',
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
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ Preview as Text')

  const group = page.locator('[data-provider="core.nodes"]')
  const native = group.getByRole('option', {
    name: /Preview as Text dinkster-nodes-foundation/,
  })
  await expect(native).toBeVisible()
  await expect(native).toHaveAccessibleName(/Preview as Text/)
})

test('native SAVE_TARGET editor shows canonical type and generic output format', async ({ page }) => {
  await openNativeSaveTarget(page)
  await expect(page.getByTestId('save-target-editor')).toHaveAttribute('data-mounts', 'ready')
  await expect(page.getByTestId('save-target-editor').getByTestId('widget-editor-type')).toHaveText('dinkster.save_target')
  await expect(page.getByTestId('save-target-output-format')).toHaveText('generic')
  await expect(page.getByTestId('save-target-suffix')).toHaveCount(0)
  await expect(page.getByTestId('save-target-prefix')).toHaveValue('ComfyUI')
})
