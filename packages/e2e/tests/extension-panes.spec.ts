import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { expect, test, type Page, type Locator } from './fixtures.js'

const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const proofDir = process.env['DINKSTER_EXTENSION_EDITOR_PROOF_DIR']
const group = (page: Page, number: number) => page.locator(`[data-group-id="group-${number}"][data-testid="editor-group"]`)
const painted = (pane: Locator) => pane.locator('canvas[data-extension-world]')

async function capture(page: Page, name: string) {
  if (!proofDir) return
  mkdirSync(proofDir, { recursive: true })
  await page.screenshot({ path: `${proofDir}/${name}.png`, animations: 'disabled' })
}

async function backend(page: Page, base: string, initial: string) {
  let version = initial
  await page.route(`${base}/api/**`, async (route) => {
    const source = `export const frontendExtension = { activate(ctx) {
      ctx.widgetKind('pane-proof.kind', {
        type: 'pane-proof.kind', valueSchema: { version: 1, validate: value => typeof value === 'number' },
        defaultValue: () => 7, validate: () => [], defaultView: () => 'pane-proof.view${version}'
      });
      ctx.widgetView('pane-proof.view${version}', {
        id: 'pane-proof.view${version}', kind: 'pane-proof.kind', isCompatible: () => true,
        measure: () => ({ rows: 1 }),
        drawCompact(builder) { builder.text(0, 0, 'World ${version}', {}); builder.hitRegion(0, 0, 1, 1, 'widget.edit') },
        editorUi: () => ({ version: 1, root: { kind: 'text', key: 'world', text: 'Editor world ${version}' } })
      });
    } }`
    const moduleDigest = hash(source)
    const moduleUrl = `/api/extension-assets/pane-proof/${moduleDigest}/pane-proof.frontend.js`
    const body = JSON.stringify({ format: 'dinkster.extension-snapshot', version: 1, frontendApi: '1.0.0', extensions: [{
      id: 'pane-proof', version: '1.0.0', packageDigest: hash(version), contributionIds: [], selectorResolutions: [],
      serviceProviders: [], capabilities: [], behaviorConfiguration: [],
      frontend: [{ id: 'pane-proof.frontend', moduleUrl, moduleDigest, authorizedPrivileges: ['schema-widget'], contributions: [
        { id: 'pane-proof.kind', kind: 'widgetKind' }, { id: `pane-proof.view${version}`, kind: 'widgetView' },
      ] }],
    }] })
    const path = new URL(route.request().url()).pathname
    if (path === `${base}/api/nodes`) return route.fulfill({ json: {
      schemaVersion: 1, epoch: 1, dinkster: { version: 'proof', schemaWire: 40 }, extensionSnapshotDigest: hash(body), nodes: {},
    } })
    if (path === `${base}/api/extensions/snapshot`) return route.fulfill({ body, contentType: 'application/json' })
    if (path === `${base}${moduleUrl}`) return route.fulfill({ body: source, contentType: 'text/javascript', headers: { 'Cache-Control': 'private, immutable' } })
    return route.fulfill({ status: 404 })
  })
  await page.evaluate(async (base) => {
    const app = window.__dinksterTest!.app
    const backend = app.addBackend(base, base, false, 'dinkster', false)!
    await app.refreshBackendSchemas(backend)
    if (backend.schemaState.get().status !== 'ready') throw new Error(JSON.stringify(app.problems.get()))
  }, base)
  return async (next: string) => {
    version = next
    await page.evaluate(async (base) => {
      const app = window.__dinksterTest!.app
      await app.refreshBackendSchemas(app.backends.get().find((backend) => backend.baseUrl === base)!)
    }, base)
  }
}

async function open(page: Page, base: string, title: string) {
  await page.evaluate(({ base, title }) => {
    const app = window.__dinksterTest!.app
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: title, root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { preview: { id: 'preview', type: 'PaneProof', values: { value: 7 } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { preview: { position: { x: 40, y: 80 } } } } } },
      ext: { 'dinkster.exposed': [{ graphId: 'g0', nodeId: 'preview', inputId: 'value' }] },
    }, title)
    app.setTabTarget(title, base)
  }, { base, title })
  await page.waitForFunction((title) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((tab) => tab.id === title)
    return tab !== undefined && 'status' in tab.store
  }, title)
}

async function split(page: Page, title: string) {
  await page.locator('.tab').filter({ has: page.locator('.tab-select', { hasText: title }) }).click({ button: 'right' })
  await page.locator('[data-item-id="workflow.splitRight"]').click()
  await expect(page.getByTestId('editor-group')).toHaveCount(2)
}

async function selectView(pane: Locator, name: 'Graph' | 'App view') {
  await pane.getByTestId('views-switcher').click()
  await pane.page().getByRole('menuitemradio', { name, exact: true }).click()
}

async function focusGraph(pane: Locator, title: string) {
  await pane.locator('.tab-select', { hasText: title }).click()
  await pane.page().evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 16, y: 16, scale: 1 }))
}

test.beforeEach(async ({ page }) => {
  // Observe actual paint calls, not registry getters, without changing the painter.
  await page.addInitScript(() => {
    const fillRect = CanvasRenderingContext2D.prototype.fillRect
    CanvasRenderingContext2D.prototype.fillRect = function(x, y, width, height) {
      if (x === 0 && y === 0 && width >= this.canvas.clientWidth && height >= this.canvas.clientHeight) {
        delete (this.canvas as HTMLCanvasElement).dataset['extensionWorld']
      }
      fillRect.call(this, x, y, width, height)
    }
    const clearRect = CanvasRenderingContext2D.prototype.clearRect
    CanvasRenderingContext2D.prototype.clearRect = function(x, y, width, height) {
      delete (this.canvas as HTMLCanvasElement).dataset['extensionWorld']
      clearRect.call(this, x, y, width, height)
    }
    const fillText = CanvasRenderingContext2D.prototype.fillText
    CanvasRenderingContext2D.prototype.fillText = function(text, x, y, maxWidth) {
      if (text.startsWith('World ')) (this.canvas as HTMLCanvasElement).dataset['extensionWorld'] = text
      if (maxWidth === undefined) fillText.call(this, text, x, y)
      else fillText.call(this, text, x, y, maxWidth)
    }
  })
  await page.routeWebSocket('**/ws*', () => {})
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'PaneProof', displayName: 'Snapshot widget', category: 'test', source: 'v3', isOutputNode: true,
    items: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'pane-proof.kind', options: {}, default: 7 } }],
  }]))
})

test('simultaneous split panes paint and edit their own connection worlds regardless of focus', async ({ page }) => {
  await backend(page, '/pane-a', 'A')
  await backend(page, '/pane-b', 'B')
  await open(page, '/pane-a', 'Pane A')
  await open(page, '/pane-b', 'Pane B')
  await split(page, 'Pane B')
  const a = group(page, 1)
  const b = group(page, 2)
  await focusGraph(a, 'Pane A')
  await expect(painted(a)).toHaveAttribute('data-extension-world', 'World A')
  await expect(painted(b)).toHaveAttribute('data-extension-world', 'World B')
  await focusGraph(b, 'Pane B')
  await expect(painted(a)).toHaveAttribute('data-extension-world', 'World A')
  await expect(painted(b)).toHaveAttribute('data-extension-world', 'World B')
  await capture(page, 'extension-split-graph-worlds')
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((node) => node.id === 'preview')!
    const row = node.layout.rows.find((row) => row.kind === 'widget')!
    const viewport = renderer.getViewport()
    const rect = document.querySelector('[data-group-id="group-2"] [data-testid="graph-canvas"]')!.getBoundingClientRect()
    return { x: rect.left + viewport.x + (node.x + node.layout.width / 2) * viewport.scale,
      y: rect.top + viewport.y + (node.y + row.y + row.height / 2) * viewport.scale }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByText('Editor world B', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await selectView(a, 'App view')
  await selectView(b, 'App view')
  await expect(a.getByTestId('app-view-widget-preview')).toHaveAttribute('data-widget-view', 'pane-proof.viewA')
  await expect(b.getByTestId('app-view-widget-preview')).toHaveAttribute('data-widget-view', 'pane-proof.viewB')
  await a.locator('.tab-select', { hasText: 'Pane A' }).click()
  await expect(painted(a)).toHaveAttribute('data-extension-world', 'World A')
  await expect(painted(b)).toHaveAttribute('data-extension-world', 'World B')
  await capture(page, 'extension-split-app-worlds')
})

test('a frozen pane keeps snapshot A widgets while its live sibling advances to snapshot B', async ({ page }) => {
  const refresh = await backend(page, '/pane-a', 'A')
  await open(page, '/pane-a', 'Live pane')
  const frozenTitle = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('fixture did not compile')
    const ref = { connection: '/pane-a', prompt: 'pinned' }
    app.registerRun(tab, ref, compiled.artifact)
    if (!app.openExecutionView(ref)) throw new Error('missing frozen execution')
    return app.activeTab()!.title
  })
  await split(page, frozenTitle)
  const live = group(page, 1)
  const frozen = group(page, 2)
  await focusGraph(live, 'Live pane')
  await refresh('B')
  await expect(painted(live)).toHaveAttribute('data-extension-world', 'World B')
  await expect(painted(frozen)).toHaveAttribute('data-extension-world', 'World A')
  await focusGraph(frozen, frozenTitle)
  await expect(painted(live)).toHaveAttribute('data-extension-world', 'World B')
  await expect(painted(frozen)).toHaveAttribute('data-extension-world', 'World A')
  await page.setViewportSize({ width: 2200, height: 1000 })
  await capture(page, 'extension-split-frozen-live-worlds')
})
