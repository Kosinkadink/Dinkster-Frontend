/**
 * UI layout audit: opens every widget editor surface against real layout
 * (real browser, real stylesheet) and asserts the geometry invariants in
 * ui-audit.ts, saving a full-page screenshot of each surface so an agent or
 * human can visually scrutinize the result without driving the app.
 *
 * Screenshots land in the test output dir (test-results/...): after a run,
 * inspect them with any image viewer. A failing audit prints exactly which
 * element violates which invariant.
 *
 * This suite exists because behavioral e2e coverage proved blind to total
 * visual wreckage (2026-07-25 asset editor field failure): Playwright
 * happily clicks sliver-width and overlapping controls. Every new editor or
 * overlay surface should gain an audited, screenshotted state here.
 */
import { expect, selectProductOption, test, type Page } from './fixtures.js'
import { auditLayout } from './ui-audit.js'

const MOCK = 'http://ui-audit.test'
const IMAGE_DIGEST = `blake3:${'1'.repeat(64)}`
const SECOND_DIGEST = `blake3:${'2'.repeat(64)}`

async function rowPoint(page: Page, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'widgets')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, inputId)
}

async function openEditor(page: Page, inputId: string): Promise<void> {
  const point = await rowPoint(page, inputId)
  await page.mouse.click(point.x, point.y)
}

/** Audit + screenshot one opened editor surface, then close it. */
async function auditSurface(page: Page, name: string, rootSelector: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) })
  expect(await auditLayout(page, rootSelector), `layout audit of ${name}`).toEqual([])
  await page.keyboard.press('Escape')
}

test.describe('universal search surfaces', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('topbar-search')).toBeVisible()
  })

  test('topbar search field passes the layout audit', async ({ page }) => {
    await auditSurface(page, 'search-topbar-closed', '[data-testid=topbar-search]')
  })

  test('Customize layout topbar button passes the layout audit', async ({ page }) => {
    await expect(page.getByTestId('customize-layout-button')).toBeVisible()
    await auditSurface(page, 'customize-layout-topbar-closed', '.topbar')
  })

  test('open universal search palette passes the layout audit', async ({ page }) => {
    await page.getByTestId('topbar-search').click()
    await expect(page.getByTestId('universal-search-input')).toBeFocused()
    await auditSurface(page, 'search-palette-open', '.search-dialog')
  })
})

test.describe('plain widget editors', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
    await page.evaluate(() => {
      const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
        kind: 'input', id, type: { kind: 'concrete', name: widgetType === 'COMBO' ? 'core.combo' : widgetType }, optional: false,
        widget: { widgetType, options, default: defaultValue },
      })
      window.__dinksterTest!.app.registerSchemas([{
        type: 'UiAuditTest', displayName: 'UI Audit', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          widget('count', 'INT', 5, { min: 0, max: 100, step: 5 }),
          widget('amount', 'FLOAT', 1.5, { min: 0, max: 10 }),
          widget('title', 'STRING', 'old'),
          widget('notes', 'STRING', 'first', { multiline: true }),
          widget('color', 'COLOR', '#11223380'),
          widget('choice', 'COMBO', 'alpha', { options: ['alpha', 'beta', 'gamma'] }),
        ],
      }])
      window.__dinksterTest!.app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'ui-audit', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'root', nodes: { widgets: { id: 'widgets', type: 'UiAuditTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
        view: { graphs: { g0: { nodes: { widgets: { position: { x: 100, y: 100 } } } } } },
      }, 'UI Audit')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    })
  })

  test('INT editor passes the layout audit', async ({ page }) => {
    await openEditor(page, 'count')
    await expect(page.getByTestId('widget-editor')).toBeVisible()
    await auditSurface(page, 'editor-int', '[data-testid=widget-editor]')
  })

  test('FLOAT editor passes the layout audit', async ({ page }) => {
    await openEditor(page, 'amount')
    await expect(page.getByTestId('widget-editor')).toBeVisible()
    await auditSurface(page, 'editor-float', '[data-testid=widget-editor]')
  })

  test('STRING editor passes the layout audit', async ({ page }) => {
    await openEditor(page, 'title')
    await expect(page.getByTestId('widget-editor')).toBeVisible()
    await auditSurface(page, 'editor-string', '[data-testid=widget-editor]')
  })

  test('multiline STRING editor passes the layout audit', async ({ page }) => {
    await openEditor(page, 'notes')
    await expect(page.getByTestId('widget-editor')).toBeVisible()
    await auditSurface(page, 'editor-string-multiline', '[data-testid=widget-editor]')
  })

  test('COLOR editor passes the layout audit', async ({ page }) => {
    await openEditor(page, 'color')
    await expect(page.getByTestId('color-editor')).toBeVisible()
    await auditSurface(page, 'editor-color', '[data-testid=color-editor]')
  })

  test('COMBO dropdown passes the layout audit', async ({ page }) => {
    await openEditor(page, 'choice')
    await expect(page.getByTestId('combo-dropdown')).toBeVisible()
    await auditSurface(page, 'editor-combo', '[data-testid=combo-dropdown]')
  })
})

test.describe('asset and save-target editors (mock dinkster backend)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(`${MOCK}/api/nodes*`, (route) => void route.fulfill({ json: {
      schemaVersion: 1, epoch: 1, dinkster: { version: 'test', schemaWire: 22 }, nodes: {},
    } }))
    await page.route('**/api/mounts**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname === '/api/mounts') {
        await route.fulfill({ json: { mounts: [
          { id: 'input', mode: 'read', state: 'ready' },
          { id: 'output', mode: 'readwrite', state: 'ready' },
        ] } })
        return
      }
      if (url.pathname.match(/^\/api\/mounts\/[^/]+\/entries$/)) {
        await route.fulfill({ json: { entries: [
          { virtualPath: 'photos/sunset.png', name: 'sunset.png', digest: IMAGE_DIGEST, size: 2048, mediaType: 'image/png', kind: 'media/image' },
          { virtualPath: 'photos/moon.png', name: 'moon.png', digest: SECOND_DIGEST, size: 3072, mediaType: 'image/png', kind: 'media/image' },
        ], total: 2 } })
        return
      }
      await route.fulfill({ status: 404 })
    })
    await page.route('**/api/assets/**', (route) => void route.fulfill({ contentType: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') }))
    await page.goto('/')
    await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
    await page.getByTestId('backends-toggle').click()
    await page.getByTestId('backend-url-input').fill(MOCK)
    await page.getByTestId('backend-add').click()
    await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
    await expect.poll(() => page.evaluate((url) =>
      window.__dinksterTest!.app.backends.get().find((backend) => backend.baseUrl === url)?.registry.get() !== undefined,
    MOCK)).toBe(true)
    await page.evaluate(() => {
      window.__dinksterTest!.app.registerSchemas([{
        type: 'UiAuditAsset', displayName: 'UI Audit Asset', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
            widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } },
          { kind: 'input', id: 'target', type: { kind: 'concrete', name: 'SAVE_TARGET' }, optional: false,
            widget: { widgetType: 'SAVE_TARGET', options: {}, default: null } },
        ],
      }])
      window.__dinksterTest!.app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'ui-audit-asset', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'root', nodes: { widgets: { id: 'widgets', type: 'UiAuditAsset', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
        view: { graphs: { g0: { nodes: { widgets: { position: { x: 100, y: 100 } } } } } },
      }, 'UI Audit Asset')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    })
    // The opened tab targets the default backend; retarget it to the mock.
    // Changing protocols replaces backend-discovered schemas, so re-register
    // the synthetic schema after the mock connection settles.
    await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
    await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
      type: 'UiAuditAsset', displayName: 'UI Audit Asset', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
          widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null } },
        { kind: 'input', id: 'target', type: { kind: 'concrete', name: 'SAVE_TARGET' }, optional: false,
          widget: { widgetType: 'SAVE_TARGET', options: {}, default: null } },
      ],
    }]))
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'widgets')?.layout.rows.some((item) => item.kind === 'widget' && item.inputId === 'image'))).toBe(true)
  })

  test('ASSET editor with a populated browser passes the layout audit', async ({ page }) => {
    await openEditor(page, 'image')
    const asset = page.getByTestId('asset-editor')
    await expect(asset).toBeVisible()
    await expect(asset.getByTestId('collection-panel')).toBeVisible()
    // Populated list: at least one row/tile rendered before auditing.
    await expect(asset.getByTestId('collection-entry').first()).toBeVisible()
    await auditSurface(page, 'editor-asset', '[data-testid=widget-modal-surface]')
  })

  test('ASSET editor with a staged selection passes the layout audit', async ({ page }) => {
    await openEditor(page, 'image')
    const asset = page.getByTestId('asset-editor')
    await expect(asset.getByTestId('collection-panel')).toBeVisible()
    await asset.getByTestId('collection-entry').first().click()
    await expect(page.getByTestId('asset-selection-summary')).toBeVisible()
    await auditSurface(page, 'editor-asset-selected', '[data-testid=widget-modal-surface]')
  })

  // Narrow viewport: the product dialog is clamped by the viewport, and the
  // selection panel must stack vertically instead of squeezing the item
  // list into a sliver (the original field failure mode).
  test('ASSET editor passes the layout audit on a narrow viewport', async ({ page }) => {
    await page.setViewportSize({ width: 460, height: 720 })
    // At this width the Backends panel and right rail (opened by the
    // fixture) cover the whole canvas; close them to expose the node.
    await page.getByRole('button', { name: 'Close Primary dock panels' }).click()
    await page.getByRole('button', { name: 'Toggle right rail' }).click()
    await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
    await openEditor(page, 'image')
    const asset = page.getByTestId('asset-editor')
    await expect(asset.getByTestId('collection-panel')).toBeVisible()
    await asset.getByTestId('collection-entry').first().click()
    await expect(page.getByTestId('asset-selection-summary')).toBeVisible()
    await auditSurface(page, 'editor-asset-narrow', '[data-testid=widget-modal-surface]')
  })

  test('SAVE_TARGET editor passes the layout audit', async ({ page }) => {
    await openEditor(page, 'target')
    await expect(page.getByTestId('save-target-editor')).toBeVisible()
    await auditSurface(page, 'editor-save-target', '[data-testid=save-target-editor]')
  })

  // Sensitivity pin: the audit must DETECT the 2026-07-25 wreckage, not just
  // bless the fixed layout. Reinstate the broken rules (280px body, fixed
  // two-column grid squeezing the list) and require the audit to report
  // findings. If someone weakens the invariants until this passes silently,
  // this test fails first.
  test('the audit detects the 2026-07-25 asset editor wreckage', async ({ page }) => {
    await page.addStyleTag({ content: `
      .asset-editor { width: 280px !important; }
      .asset-editor .collection-panel { display: grid !important; grid-template-columns: minmax(0, 1fr) 220px !important; }
      .asset-editor .collection-content { display: contents !important; }
      .asset-editor .collection-footer { display: contents !important; }
      .asset-editor .collection-items { min-width: 0 !important; }
    ` })
    await openEditor(page, 'image')
    const asset = page.getByTestId('asset-editor')
    await expect(asset).toBeVisible()
    const findings = await auditLayout(page, '[data-testid=widget-modal-surface]')
    expect(findings.length, `expected the audit to flag the broken layout, got: ${JSON.stringify(findings)}`).toBeGreaterThan(0)
  })
})
