import { expect, nativeTest as test } from './fixtures.js'
import { mkdirSync } from 'node:fs'
import { evidenceGroupDir, evidencePath } from './evidence-output.js'

const exposed = [{ graphId: 'root', nodeId: 'input', inputId: 'steps', label: 'Steps' }]
const workflow = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'flagged-app-view', root: 'root',
  graphs: { root: {
    id: 'root', name: 'Workflow', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
    nodes: { input: { id: 'input', type: 'FlagInput', values: { steps: 7 } } },
  } },
  view: { graphs: { root: { nodes: { input: { position: { x: 100, y: 100 } } } } } },
  ext: { 'dinkster.exposed': exposed },
}

test.beforeEach(async ({ page }) => {
  await page.route('/api/**', (route) => route.fulfill({ status: 502, body: 'isolated fixture' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'app-view-flag-test', schemaWire: 1 }, packs: {}, nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated fixture' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.addInitScript(({ workflow }) => {
    if (localStorage.getItem('dinkster.openTabs')) return
    localStorage.setItem('dinkster.openTabs', JSON.stringify({
      v: 1, activeTabId: workflow.lineage,
      tabs: [{ title: 'Flagged workflow', doc: workflow, editorKind: 'app' }],
    }))
  }, { workflow })
  await page.goto('/')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/)
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'FlagInput', displayName: 'Flag input', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'steps', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: { min: 0, max: 100, step: 1 }, default: 7 } }],
    }])
  })
})

test('default-off restores app tabs as Graph and hides every App View entry point', async ({ page }) => {
  expect(await page.evaluate(() => ({
    enabled: window.__dinksterTest!.app.appViewEnabled,
    editor: window.__dinksterTest!.app.activeTab()!.editorKind,
    command: window.__dinksterTest!.app.commands.get('view.toggleAppView')?.id,
    registered: window.__dinksterTest!.app.editors.get('app')?.id,
    exposed: window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.exposed'],
  }))).toEqual({ enabled: false, editor: 'graph', command: undefined, registered: undefined, exposed })
  await page.keyboard.press('Alt+v')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('app-view')).toHaveCount(0)
  await page.getByTestId('views-switcher').click()
  await expect(page.getByRole('menuitemradio', { name: 'App view' })).toHaveCount(0)
  await expect(page.getByRole('menuitemradio', { name: 'Graph', exact: true })).toBeVisible()
  mkdirSync(evidenceGroupDir('app-view-feature-flag'), { recursive: true })
  await page.screenshot({ path: evidencePath('app-view-feature-flag', 'default-off.png') })
  await page.keyboard.press('Escape')
  await page.getByTestId('lens-switcher').click()
  await expect(page.getByRole('menuitemradio', { name: /Exposure/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  const promotionItems = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const context = { doc: tab.store.doc as import('@dinkster/core').WorkflowDocument, graphId: 'root',
      selection: { nodes: [], links: [], reroutes: [], valueSources: [], selectors: [] }, worldX: 0, worldY: 0 }
    return [
      ...app.menuRegistry.resolve({ ...context, target: { kind: 'widget', nodeId: 'input', inputId: 'steps' } }),
      ...app.menuRegistry.resolve({ ...context, target: { kind: 'node', nodeId: 'input', previewSurface: true } }),
    ].flatMap((group) => group.items).map((item) => item.id)
  })
  expect(promotionItems).not.toContain('core.widget.expose.toggle')
  expect(promotionItems).not.toContain('core.node.preview.expose.toggle')
  await page.evaluate(() => window.__dinksterTest!.app.flushPersistTabs())
  await page.reload()
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.exposed'])).toEqual(exposed)
})

test('opting in restores authored controls and disabling returns to Graph without deleting exposure', async ({ page }) => {
  await page.getByTestId('settings-button').click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await settings.locator('.settings-categories').getByRole('button', { name: 'Features App View', exact: true }).click()
  const toggle = settings.getByRole('checkbox', { name: 'Enable App View (experimental)' })
  await expect(toggle).not.toBeChecked()
  mkdirSync(evidenceGroupDir('app-view-feature-flag'), { recursive: true })
  await page.screenshot({ path: evidencePath('app-view-feature-flag', 'settings-off.png') })
  await toggle.check()
  await expect(toggle).toBeChecked()
  await page.screenshot({ path: evidencePath('app-view-feature-flag', 'settings-on.png') })
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await page.getByTestId('views-switcher').click()
  await expect(page.getByRole('menuitemradio', { name: 'App view' })).toBeVisible()
  mkdirSync(evidenceGroupDir('app-view-feature-flag'), { recursive: true })
  await page.screenshot({ path: evidencePath('app-view-feature-flag', 'enabled.png') })
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await expect(page.getByTestId('app-view')).toBeVisible()
  await expect(page.getByTestId('app-view-row')).toHaveCount(1)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('features.appView.enabled', false))
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('app-view')).toHaveCount(0)
  await page.keyboard.press('Alt+v')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.exposed'])).toEqual(exposed)
  await page.getByTestId('settings-button').click()
  await settings.locator('.settings-categories').getByRole('button', { name: 'Keybindings', exact: true }).click()
  await expect(settings.locator('[data-command-id="view.toggleAppView"]')).toHaveCount(0)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('features.appView.enabled', true))
  await expect(settings.locator('[data-command-id="view.toggleAppView"]')).toHaveCount(1)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('features.appView.enabled', false))
  await expect(settings.locator('[data-command-id="view.toggleAppView"]')).toHaveCount(0)
  await settings.getByRole('button', { name: 'Close settings' }).click()
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('features.appView.enabled', true))
  await page.keyboard.press('Alt+v')
  await expect(page.getByTestId('app-view')).toBeVisible()
  await page.keyboard.press('Alt+v')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  const widgetPoint = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'input')!
    const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'steps')!
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return { x: canvas.left + viewport.x + (node.x + node.layout.width / 2) * viewport.scale,
      y: canvas.top + viewport.y + (node.y + row.y + row.height / 2) * viewport.scale }
  })
  await page.mouse.click(widgetPoint.x, widgetPoint.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.widget.expose.toggle"]')).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('features.appView.enabled', false))
  await expect(page.locator('[data-item-id="core.widget.expose.toggle"]')).toHaveCount(0)
})
