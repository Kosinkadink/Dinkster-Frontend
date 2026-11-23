import { expect, nativeTest as test, waitForWorkspaceReady } from './fixtures.js'

declare global {
  interface Window {
    canvasWorkCounts: { armed?: string | undefined; calls: number; nextFrame?: number | undefined }
    canvasDragDrawCounts: { armed: boolean; calls: number; immediate?: number | undefined; nextFrame?: number | undefined }
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
  await waitForWorkspaceReady(page, 1)
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
      // Start at event dispatch, not the earlier Playwright arming command.
      counts.calls = 0
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
    c.nextFrame = undefined; c.armed = event
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
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.graph-canvas')!
    const ctx = canvas.getContext('2d')!
    const original = ctx.fillRect.bind(ctx)
    const counts = window.canvasDragDrawCounts = { armed: false, calls: 0 } as Window['canvasDragDrawCounts']
    ctx.fillRect = (...args) => {
      if (typeof ctx.fillStyle === 'string' && args[0] === 0 && args[1] === 0 && args[2] === canvas.clientWidth && args[3] === canvas.clientHeight) counts.calls++
      original(...args)
    }
    window.addEventListener('pointermove', () => {
      if (counts.armed) { counts.calls = 0; counts.nextFrame = undefined }
    }, { capture: true })
    window.addEventListener('pointermove', () => {
      if (!counts.armed) return
      counts.armed = false
      counts.immediate = counts.calls
      requestAnimationFrame(() => { counts.nextFrame = counts.calls })
    })
  })
  for (const offset of [1, 2, 3]) {
    await page.evaluate(() => { window.canvasDragDrawCounts.armed = true })
    await page.mouse.move(point.x + 80 * offset / 3, point.y + 50 * offset / 3)
    await expect.poll(() => page.evaluate(() => window.canvasDragDrawCounts.nextFrame)).toBe(1)
    expect(await page.evaluate(() => window.canvasDragDrawCounts.immediate)).toBe(0)
  }
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().dragOffsets?.has('n0'))).toBe(true)
  await arm('pointerup')
  await page.mouse.up()
  await check()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0?.nodes?.n0?.position)).toEqual({ x: 240, y: 230 })

  const unselected = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!, vp = r.getViewport()
    const n = r.getScene().nodes.find((node) => node.id === 'n1')!
    const c = document.querySelector('canvas.graph-canvas')!.getBoundingClientRect()
    return { x: c.left + (n.x + n.layout.width / 2) * vp.scale + vp.x, y: c.top + (n.y + 12) * vp.scale + vp.y }
  })
  await arm('pointerdown')
  await page.mouse.click(unselected.x, unselected.y, { button: 'right' })
  await check()
  await expect.poll(() => page.evaluate(() => window.canvasWorkCounts.calls)).toBeGreaterThan(0)
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.locator('[data-item-id="core.node.mode"]').hover()
  await expect(page.getByTestId('context-submenu')).toBeVisible()
  await page.screenshot({ path: info.outputPath('unselected-context-menu.png') })
})

test('numeric increments paint without synchronous whole-workflow comparison', async ({ page }, info) => {
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'numeric-counting', schemaWire: 1 },
    nodes: { 'demo.numeric': { displayName: 'Numeric node', unavailableReason: 'Comparison fixture', interface: [
      { role: 'input', id: 'scale', required: true, type: { kind: 'concrete', types: ['FLOAT'] },
        widget: { type: 'FLOAT', default: 1, step: 0.01 } },
    ] } },
  } }))
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await waitForWorkspaceReady(page, 1)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const counts = window.canvasWorkCounts = { calls: 0 } as Window['canvasWorkCounts']
    const compile = app.compileTab.bind(app)
    app.compileTab = (...args) => { counts.calls++; return compile(...args) }
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'numeric-counting', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Root', nodes: {
        n0: { id: 'n0', type: 'demo.numeric', values: { scale: 1 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 160, y: 180 } } } } } },
    }, 'Numeric counting')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    window.addEventListener('pointerup', () => {
      if (counts.armed !== 'pointerup') return
      counts.calls = 0; counts.armed = undefined
      requestAnimationFrame(() => { counts.nextFrame = counts.calls })
    }, { capture: true })
  })
  await expect.poll(() => page.evaluate(() => window.canvasWorkCounts.calls)).toBeGreaterThan(0)
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!, viewport = renderer.getViewport()
    const node = renderer.getScene().nodes[0]!
    const row = node.layout.rows.find((row) => row.kind === 'widget')!
    const rect = document.querySelector('canvas.graph-canvas')!.getBoundingClientRect()
    return { x: rect.left + (node.x + node.layout.width - (row.inset ?? 0) - 8) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y }
  })
  for (const expected of [1.01, 1.02, 1.03]) {
    await page.evaluate(() => { window.canvasWorkCounts.nextFrame = undefined; window.canvasWorkCounts.armed = 'pointerup' })
    await page.mouse.click(point.x, point.y)
    await expect.poll(() => page.evaluate(() => window.canvasWorkCounts.nextFrame)).toBe(0)
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.scale)).toBeCloseTo(expected)
  }
  await page.screenshot({ path: info.outputPath('numeric-increments.png') })
  for (const expected of [1.02, 1.01, 1]) {
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.scale)).toBeCloseTo(expected)
  }
})
