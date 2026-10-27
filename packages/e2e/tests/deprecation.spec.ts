import { expect, test, type Page } from './fixtures.js'

async function badgePoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width - 22 + 7) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

test('native deprecation badges show guidance without graph replacement controls', async ({ page }, testInfo) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'deprecation-fixture', schemaWire: 1 },
    nodes: {
      AuthoredNode: { deprecation: { message: 'Use CurrentNode for new workflows', since: '2.0', replacement: 'CurrentNode' }, interface: [] },
      CurrentNode: { interface: [] },
      NoSuccessor: { deprecation: { message: 'This node is deprecated' }, interface: [] },
    },
  } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/3 node schemas/, { timeout: 30_000 })
  expect(await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    nodes: [{ id: 1, type: 'AuthoredNode', pos: [120, 120] }, { id: 2, type: 'NoSuccessor', pos: [450, 120] }], links: [],
  }, 'Deprecation guidance'))).toEqual([])
  // The workspace handoff dismisses popovers attached to the local session.
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  for (const [id, text, filename] of [
    ['n1', "Successor: 'CurrentNode'", 'deprecation-successor.png'],
    ['n2', 'No successor is declared.', 'deprecation-no-successor.png'],
  ]) {
    await page.keyboard.press('Escape')
    const point = await badgePoint(page, id!)
    await page.mouse.click(point.x, point.y)
    const popover = page.getByTestId('badge-popover')
    await expect(popover).toBeVisible()
    await expect(popover).toContainText(text!)
    await expect(popover.getByRole('button')).toHaveCount(0)
    await popover.screenshot({ path: testInfo.outputPath(filename!) })
  }
  expect(await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.fromEntries(Object.values(doc.graphs[doc.root]!.nodes).map((n) => [n.id, n.type]))
  })).toEqual({ n1: 'AuthoredNode', n2: 'NoSuccessor' })
})
