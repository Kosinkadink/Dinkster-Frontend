import { expect, mockProjectPacks, nativeTest as test, waitForWorkspaceReady } from './fixtures.js'

test('keyboard list marks its node and pin, reveals only offscreen targets, and clears on close', async ({ page }, info) => {
  await mockProjectPacks(page)
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'e2e', schemaWire: 2 }, nodes: {},
  } }))
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await waitForWorkspaceReady(page, 0)
  expect(await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{ type: 'demo.node', displayName: 'Ring target', category: 'test', source: 'v3',
      body: [{ kind: 'output', id: 'value', label: 'Value', type: { kind: 'concrete', name: 'INT' } }],
    }])
    return app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'keyboard-ring', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Root', nodes: {
        n0: { id: 'n0', type: 'demo.node', values: {} },
        n1: { id: 'n1', type: 'demo.node', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {
        n0: { position: { x: 160, y: 180 } }, n1: { position: { x: 2400, y: 300 } },
      } } } },
    }, 'Keyboard ring')
  })).toEqual([])
  await expect(page.getByTestId('tab-bar').locator('.tab', { hasText: 'Keyboard ring' })).toBeVisible()
  await waitForWorkspaceReady(page)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer?.getScene().nodes.length)).toBe(2)
  await page.mouse.move(0, 0)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  const pixels = () => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    ;(renderer as unknown as { renderNow(): void }).renderNow()
    return document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!.toDataURL()
  })
  const viewport = () => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  const before = await pixels()
  await page.screenshot({ path: info.outputPath('before.png') })
  const navigator = page.getByRole('listbox', { name: 'Canvas scene navigator' })
  const active = navigator.locator('[data-active=true]')
  await navigator.focus()
  await expect(active).toHaveAttribute('data-kind', 'node')
  await page.screenshot({ path: info.outputPath('node-ring.png') })
  await expect.poll(async () => (await pixels()) !== before).toBe(true)
  const nodeRing = await pixels()
  expect(await viewport()).toEqual({ x: 0, y: 0, scale: 1 })
  for (let step = 0; step < 5 && await active.getAttribute('data-kind') !== 'port'; step++) await page.keyboard.press('ArrowDown')
  await expect(active).toHaveAttribute('data-kind', 'port')
  await expect.poll(async () => (await pixels()) !== nodeRing).toBe(true)
  expect((await pixels()) !== before).toBe(true)
  expect(await viewport()).toEqual({ x: 0, y: 0, scale: 1 })
  await page.screenshot({ path: info.outputPath('pin-ring.png') })
  await page.keyboard.press('Escape')
  await expect(navigator.getByRole('option')).toHaveCount(0)
  await expect.poll(async () => (await pixels()) === before).toBe(true)
  await navigator.focus()
  await page.keyboard.press('End')
  await expect.poll(viewport).not.toEqual({ x: 0, y: 0, scale: 1 })
  expect((await viewport()).scale).toBe(1)
  expect(await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((node) => node.id === 'n1')!
    const pin = node.layout.pins[0]!
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=graph-canvas]')!
    const x = viewport.x + (node.x + node.layout.width) * viewport.scale
    const y = viewport.y + (node.y + pin.y) * viewport.scale
    return x > 0 && x < canvas.clientWidth && y > 0 && y < canvas.clientHeight
  })).toBe(true)
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '0')
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)
})
