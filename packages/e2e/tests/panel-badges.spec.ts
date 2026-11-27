import { expect, mockProjectPacks, nativeTest as test, subgraphMarkPoint, waitForWorkspaceReady } from './fixtures.js'

test('subgraph badges count problems but never information', async ({ page }, testInfo) => {
  await page.route(/\/api\/.*/, (route) => route.fulfill({ status: 503, json: {} }))
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'badge-fixture', schemaWire: 2 }, nodes: {},
  } }))
  await mockProjectPacks(page)
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{ type: 'BadgeNode', displayName: 'Badge node', category: 'test', source: 'v3', isOutputNode: false, body: [] }])
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'badge-proof', root: 'g0', graphs: {
      g0: { id: 'g0', name: 'Workflow', nodes: { instance: { id: 'instance', type: '#sub', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
      sub: { id: 'sub', name: 'Subgraph', nodes: { node: { id: 'node', type: 'BadgeNode', values: {} } }, links: {}, nets: {}, reroutes: {}, boundary: { body: [] }, nextOrdinal: 1 },
    }, view: { graphs: { g0: { nodes: { instance: { position: { x: 120, y: 120 } } } }, sub: { nodes: { node: { position: { x: 120, y: 120 } } } } } } }, 'Badge counts')
  })
  await waitForWorkspaceReady(page)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  const mark = await subgraphMarkPoint(page, 'instance')
  await page.mouse.dblclick(mark.x, mark.y)
  await expect(page.getByTestId('graph-breadcrumb')).toBeVisible()
  await page.getByTestId('rail-resize').focus()
  await page.keyboard.press('End')
  const problemsTab = page.getByTestId('dock-zone-right').locator('[role="tab"][data-tab-id="problems"]')
  const boundaryBadge = page.getByTestId('dock-zone-right').locator('[role="tab"][data-tab-id="boundary"]').getByTestId('panel-indicator')
  const railBadge = page.getByTestId('rail-toggle').getByTestId('panel-indicator')
  const problemsBadge = problemsTab.getByTestId('panel-indicator')
  const status = page.getByTestId('status-problems')
  await problemsTab.click()
  await expect(railBadge).toHaveCount(0)
  await expect(boundaryBadge).toHaveCount(0)
  await expect(problemsBadge).toHaveCount(0)
  await expect(status).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('no-problem.png') })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.reportProblems(app.activeTab()!.id, [
      { severity: 'info', origin: 'runtime', code: 'badge.info', message: 'Subgraph information.', refs: [{ graphId: 'sub', nodeId: 'node' }] },
      { severity: 'error', origin: 'runtime', code: 'badge.problem', message: 'This node needs attention.', refs: [{ graphId: 'sub', nodeId: 'node' }] },
    ])
  })
  await expect(problemsBadge.locator('[aria-hidden="true"]')).toHaveText('1')
  await expect(railBadge.locator('[aria-hidden="true"]')).toHaveText('1')
  await expect(railBadge).toHaveAttribute('data-severity', 'error')
  await expect(status).toHaveText('1 problem')
  await expect(boundaryBadge).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('one-problem.png') })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.clearProblems(app.activeTab()!.id)
    app.reportProblems(app.activeTab()!.id, [{ severity: 'info', origin: 'runtime', code: 'badge.info', message: 'Subgraph information.', refs: [{ graphId: 'sub', nodeId: 'node' }] }])
  })
  await expect(page.getByTestId('problems-panel')).toContainText('Subgraph information.')
  await expect(railBadge).toHaveCount(0)
  await expect(problemsBadge).toHaveCount(0)
  await expect(status).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('information-only.png') })
})
