import { expect, test } from './fixtures.js'

test('execution status stays below canvas controls when the toolbar wraps', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  await page.getByTestId('library-toggle').click()
  await expect(page.getByTestId('dock-zone-right')).toBeVisible()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as NonNullable<typeof window.__dinksterTest>['app'] & {
      store: { restoreCompleted(state: unknown): void }
      semanticHashOfTab(tab: unknown): string
      pinExecutionOverlay(tabId: string, ref: unknown): boolean
    }
    const tab = app.activeTab()!
    const connection = app.backendForTab(tab).id
    const ref = { connection, prompt: 'shell-layout-completed' }
    app.store.restoreCompleted({
      ref,
      artifact: {
        snapshot: structuredClone(tab.store.doc), revision: 0,
        semanticHash: app.semanticHashOfTab(tab), scope: { kind: 'full' },
        connection, schemaHash: 'shell-layout-fixture', prompt: {},
        provenance: { toSource: {}, fromSource: {} }, diagnostics: [],
      },
      nodes: {}, outputs: {}, artifacts: [],
      jobRef: 'shell-layout-job', sourceDocument: tab.id, queuedAt: 1, endedAt: 2,
    })
    app.pinExecutionOverlay(tab.id, ref)
  })
  const chip = page.getByTestId('sync-chip')
  await expect(chip).toHaveAttribute('data-overlay-mode', 'pinned')
  for (const width of [1440, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => {
      const toolbar = (await page.locator('.canvas-stage-toolbar').boundingBox())!
      const status = (await chip.boundingBox())!
      return status.y - (toolbar.y + toolbar.height)
    }).toBeGreaterThanOrEqual(8)
    const stage = (await page.locator('.canvas-stage').boundingBox())!
    const status = (await chip.boundingBox())!
    expect(status.x).toBeGreaterThanOrEqual(stage.x)
    expect(status.x + status.width).toBeLessThanOrEqual(stage.x + stage.width)
    for (const control of await page.locator('.canvas-stage-toolbar button').all()) {
      const box = (await control.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(stage.x)
      expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width)
    }
  }
  await page.getByTestId('sync-chip-open').click()
  const frozen = page.getByTestId('frozen-banner')
  await expect(frozen).toBeVisible()
  const toolbar = (await page.locator('.canvas-stage-toolbar').boundingBox())!
  const banner = (await frozen.boundingBox())!
  expect(banner.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height + 8)
})
