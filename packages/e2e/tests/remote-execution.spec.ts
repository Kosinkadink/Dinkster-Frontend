import { expect, test, type Page } from '@playwright/test'

const nativeTable = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: {
    version: 'remote-execution-e2e',
    schemaWire: 1,
    graphFeatures: ['placement'],
  },
  packs: { test: { displayName: 'Test' } },
  nodes: {
    'test.ImageSource': {
      schemaVersion: 1,
      nodeType: 'test.ImageSource',
      displayName: 'Image Source',
      category: 'test',
      interface: [{ role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } }],
      signature: 'remote-execution-source',
    },
    'test.ImageSink': {
      schemaVersion: 1,
      nodeType: 'test.ImageSink',
      displayName: 'Image Sink',
      category: 'test',
      outputNode: true,
      interface: [{ role: 'input', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } }],
      signature: 'remote-execution-sink',
    },
  },
}

const workflow = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'remote-execution-e2e',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: {
        source: { id: 'source', type: 'test.ImageSource', values: {} },
        sink: { id: 'sink', type: 'test.ImageSink', values: {} },
      },
      links: {
        l1: { id: 'l1', from: { node: 'source', port: 'image' }, to: { node: 'sink', port: 'image' } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 3,
    },
  },
  view: { graphs: { g0: { nodes: {
    source: { position: { x: 40, y: 80 } },
    sink: { position: { x: 320, y: 80 } },
  } } } },
}

async function headerPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const renderer = window.__dinksterTest!.renderer!
    const viewport = renderer.getViewport()
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === id)
    if (node === undefined) throw new Error(`no scene node '${id}'`)
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  }, nodeId)
}

test('runs selected root nodes on an explicitly chosen machine without changing the workflow', async ({ page }, testInfo) => {
  let submitted: Record<string, unknown> | undefined
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: nativeTable }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/assets', (route) => route.fulfill({ status: 404, json: { error: 'no library' } }))
  await page.route('/api/workers', (route) => route.fulfill({ json: { workers: [
    {
      name: 'local',
      status: 'connected',
      routedNodeTypes: ['test.ImageSource', 'test.ImageSink'],
      deviceQualifiers: [],
    },
    {
      name: 'render-box',
      status: 'connected',
      routedNodeTypes: ['test.ImageSink'],
      deviceQualifiers: ['@render-box'],
    },
    {
      name: 'offline-box',
      status: 'disconnected',
      routedNodeTypes: ['test.ImageSink'],
      deviceQualifiers: [],
    },
  ] } }))
  await page.route('/api/jobs', async (route) => {
    submitted = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 202, json: {
      clientId: submitted['clientId'],
      jobId: submitted['jobId'],
      state: 'queued',
    } })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.workerCatalog.get().status,
  )).toBe('ready')
  await page.evaluate((document) => {
    window.__dinksterTest!.app.openDocument(document as never, 'Remote execution')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, workflow)
  const before = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))

  const point = await headerPoint(page, 'sink')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.locator('[data-item-id="core.node.runOnMachine"]').hover()
  await expect(page.getByTestId('context-submenu').last()).toBeVisible()
  await expect(page.locator('[data-item-id="core.node.runOnMachine.render-box"]')).toBeEnabled()
  await expect(page.locator('[data-item-id="core.node.runOnMachine.offline-box"]')).toBeDisabled()

  const screenshotPath = testInfo.outputPath('run-on-machine-menu.png')
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('run-on-machine-menu', { path: screenshotPath, contentType: 'image/png' })

  await page.locator('[data-item-id="core.node.runOnMachine.render-box"]').click()
  await expect.poll(() => submitted?.['placement']).toEqual({ sink: 'render-box' })
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(before)
  expect(pageErrors).toEqual([])
})
