/**
 * Clean-startup composition proof: a fresh load of the app against an
 * origin that fronts a NATIVE engine selects the native protocol for the
 * same-origin default backend - no manual add, no protocol picker, no
 * stored state. This is the "just works" path that discovery.spec (client
 * unit tests) and the app default-option tests prove separately; here the
 * full composition runs in the real browser: AppState native default ->
 * native client fetch, without a stock ComfyUI discovery fallback.
 */
import { expect, test } from '../visual.js'

const nativeFrontend = process.env['DINKSTER_E2E_NATIVE_FRONTEND']
if (!nativeFrontend) throw new Error('DINKSTER_E2E_NATIVE_FRONTEND must identify the native-only frontend')
test.use({ baseURL: nativeFrontend })

const NATIVE_TABLE = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'e2e', schemaWire: 2 },
  packs: { demo: { displayName: 'Demo Pack' } },
  nodes: {
    'demo.node': { schemaVersion: 2, displayName: 'Demo Node', pack: 'demo', signature: 's', body: [] },
  },
}

test('slow font startup shows the boot message before the native shell', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const load = document.fonts.load.bind(document.fonts)
    const startupReady = new Promise<void>((resolve) => { Reflect.set(window, 'releaseStartupFonts', resolve) })
    document.fonts.load = async (...args) => {
      const fonts = await load(...args)
      await startupReady
      return fonts
    }
  })
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/api/*', (route) => route.fulfill({ status: 503 }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: NATIVE_TABLE }))
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('.boot-indicator-waiting')).toHaveText('Starting Dinkster...')
    await expect(page.locator('.boot-indicator-waiting')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('native-font-startup.png') })
  } finally {
    await page.evaluate(() => Reflect.get(window, 'releaseStartupFonts')())
  }
  await expect(page.getByTestId('status-bar')).toContainText('1 node schemas')
  await expect(page.locator('.boot-indicator')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('native-startup-ready.png') })
})

test('same-origin native mode has an explicit cascading hover/menu smoke path', async ({ page }) => {
  // The menu uses the mocked catalog, not the hosted engine's event stream.
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'no supervisor' }),
  )
  await page.route('/api/nodes*', (route) => route.fulfill({ json: NATIVE_TABLE }))
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.protocol ?? 'pending'))
    .toBe('dinkster')
  await expect.poll(() => page.evaluate(() => {
    const backend = window.__dinksterTest?.app.backends.get()[0]
    return backend?.connection.status.get() === 'connected' && backend.registry.get()?.schemas.has('demo.node')
  })).toBe(true)

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const result = tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'demo.node', values: {}, position: { x: 80, y: 120 } },
    })
    if (!result.ok) throw new Error(`node.add refused: ${JSON.stringify(result.diagnostics)}`)
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)

  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes[0]
    if (!node) throw new Error('native menu smoke requires one scene node')
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.locator('[data-item-id="core.node.mode"]').hover()
  await expect(page.getByTestId('context-submenu')).toBeVisible()
  await expect(page.locator('[role="menu"]')).toHaveCount(1)
  await expect(page.getByTestId('context-submenu')).toHaveAttribute('role', 'group')
})
