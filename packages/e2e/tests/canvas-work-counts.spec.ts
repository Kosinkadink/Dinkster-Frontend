import { expect, nativeTest as test } from './fixtures.js'

declare global {
  interface Window {
    canvasWorkCounts: { armed?: string | undefined; calls: number; nextFrame?: number | undefined }
  }
}

test('select, context menu and drag release do not compile availability before the next frame', async ({ page }, info) => {
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'e2e', schemaWire: 1 },
    packs: { demo: { displayName: 'Demo' } }, nodes: {
      'demo.node': { schemaVersion: 1, displayName: 'Demo node', pack: 'demo', signature: 's', interface: [] },
    },
  } }))
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('1 node schemas')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{ type: 'demo.node', displayName: 'Demo node', category: 'test', source: 'v3', isOutputNode: true, items: [] }])
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'canvas-counting', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Root', nodes: {
        n0: { id: 'n0', type: 'demo.node', values: {} },
        n1: { id: 'n1', type: 'demo.node', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 160, y: 180 } }, n1: { position: { x: 500, y: 300 } } } } } },
    }, 'Canvas counting')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    const counts = window.canvasWorkCounts = { calls: 0 } as Window['canvasWorkCounts']
    const original = app.selectionExecutionScopes.bind(app)
    app.selectionExecutionScopes = (...args) => { counts.calls += 1; return original(...args) }
    for (const type of ['pointerdown', 'pointerup']) window.addEventListener(type, () => {
      if (counts.armed !== type) return
      counts.armed = undefined
      requestAnimationFrame(() => { counts.nextFrame = counts.calls })
    }, { capture: true })
  })
  const point = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!, vp = r.getViewport()
    const n = r.getScene().nodes.find((node) => node.id === 'n0')!
    const c = document.querySelector('canvas.graph-canvas')!.getBoundingClientRect()
    return { x: c.left + (n.x + n.layout.width / 2) * vp.scale + vp.x, y: c.top + (n.y + 12) * vp.scale + vp.y }
  })
  const arm = (event: string) => page.evaluate((event) => {
    const c = window.canvasWorkCounts
    c.calls = 0; c.nextFrame = undefined; c.armed = event
  }, event)
  const check = async () => {
    await expect.poll(() => page.evaluate(() => window.canvasWorkCounts.nextFrame)).toBe(0)
  }
  await page.mouse.move(point.x, point.y)
  await arm('pointerdown')
  await page.mouse.click(point.x, point.y)
  await check()
  await page.screenshot({ path: info.outputPath('selection.png') })
  await arm('pointerdown')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await check()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.screenshot({ path: info.outputPath('context-menu.png') })
  await page.keyboard.press('Escape')
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 80, point.y + 50, { steps: 3 })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().dragOffsets?.has('n0'))).toBe(true)
  await arm('pointerup')
  await page.mouse.up()
  await check()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0?.nodes?.n0?.position)).toEqual({ x: 240, y: 230 })
})
