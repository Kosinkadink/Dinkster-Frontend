import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const readJson = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const schemas = readJson('../../core/fixtures/object_info.json')
// Exact values derived once from the served dev-pack catalog; see the
// fixture's _provenance. The audit lane serves that catalog instead of the
// V1-style object_info fixture the route-mocked lanes use.
const nativeCatalog = readJson('./fixtures/native-catalog.json')
// test.info() is only valid inside a running test, so this stays a function.
const inAuditLane = () => (test.info().config.configFile ?? '').includes('audit-assets')
const templates = [
  'image_netayume_lumina_t2i.json',
  'image_flux2_klein_image_edit_4b_distilled.json',
  'video_wan_vace_flf2v.json',
]

const subgraphChildren = (doc: any): Record<string, string[]> => Object.fromEntries(Object.entries(doc.graphs).map(([id, graph]: [string, any]) => [
  id,
  Object.values(graph.nodes).map((node: any) => node.type as string).filter((type) => type.startsWith('#')).map((type) => type.slice(1)),
]))

async function enterInstance(page: Page, id: string): Promise<void> {
  const point = await page.evaluate((id) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === id)!
    renderer.setViewport({ x: 300 - node.x, y: 200 - node.y, scale: 1 })
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + 300 + node.layout.width / 2, y: canvas.top + 200 + node.layout.headerHeight / 2 }
  }, id)
  await page.mouse.dblclick(point.x, point.y)
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: schemas }))
  await page.route('/queue', (route) => route.fulfill({ json: { queue_running: [], queue_pending: [] } }))
  await page.route('/history*', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
})

for (const name of templates) test(`imports and drills into official nested subgraphs: ${name}`, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(new RegExp(`${inAuditLane() ? nativeCatalog.schemaCount : Object.keys(schemas).length} node schemas`))
  const workflow = readJson(`../../core/fixtures/workflows/official-subgraphs/${name}`)
  const result = await page.evaluate(({ workflow, name }) => {
    const app = window.__dinksterTest!.app
    const failures = app.openDocument(workflow, name)
    const tab = app.activeTab()!
    const doc = tab.store.doc
    const root = doc.graphs[doc.root]!
    const outer = Object.values(root.nodes).find((node) => node.type.startsWith('#') &&
      Object.values(doc.graphs[node.type.slice(1)]!.nodes).some((child) => child.type.startsWith('#')))
    const inner = outer && Object.values(doc.graphs[outer.type.slice(1)]!.nodes).find((node) => node.type.startsWith('#'))
    return {
      failures,
      doc: JSON.parse(JSON.stringify(doc)),
      outer: outer?.id,
      inner: inner?.id,
      problems: app.problems.get().map(({ code, message, severity }) => ({ code, message, severity })),
    }
  }, { workflow, name })
  expect(result.failures).toEqual([])
  expect(result.doc.format).toBe('dinkster-workflow')
  expect(result.outer).toBeDefined()
  expect(result.inner).toBeDefined()
  if (inAuditLane()) {
    const expected = nativeCatalog.importSubgraphs[name]
    expect(Object.keys(result.doc.graphs)).toEqual(expected.graphIds)
    expect(subgraphChildren(result.doc)).toEqual(expected.subgraphChildren)
    const counts = Object.fromEntries(Object.keys(expected.problemCounts).map((code) => [
      code,
      result.problems.filter((problem: any) => problem.code === code).length,
    ]))
    expect(counts).toEqual(expected.problemCounts)
  }
  const assetResolution = page.getByTestId('import-asset-resolution-dialog')
  if (await assetResolution.waitFor({ state: 'visible', timeout: 1_000 }).then(() => true).catch(() => false)) await page.getByTestId('import-assets-cancel').click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBeGreaterThan(0)
  await page.screenshot({ path: testInfo.outputPath('imported.png') })
  await enterInstance(page, result.outer!)
  await expect(page.getByTestId('graph-breadcrumb').getByRole('button')).toHaveCount(2)
  await enterInstance(page, result.inner!)
  await expect(page.getByTestId('graph-breadcrumb').getByRole('button')).toHaveCount(3)
  await page.screenshot({ path: testInfo.outputPath('nested.png') })
  const reopened = await page.evaluate((doc) => {
    const app = window.__dinksterTest!.app
    const failures = app.openDocument(doc, 'Reopened nested workflow')
    return { failures, doc: JSON.parse(JSON.stringify(app.activeTab()!.store.doc)) }
  }, result.doc)
  expect(reopened.failures).toEqual([])
  expect(reopened.doc.graphs).toEqual(result.doc.graphs)
  expect(errors).toEqual([])
})

test('reports an unrepresentable structural boundary without opening a lossy document', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(new RegExp(`${inAuditLane() ? nativeCatalog.schemaCount : Object.keys(schemas).length} node schemas`))
  const result = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const before = app.activeTab()!
    const failures = app.openDocument({ nodes: [
      ...[1, 2].map((id) => ({ id, type: 'primitive-subgraph', pos: [100, id * 250],
        widgets_values: [`Prompt ${id}`], properties: { proxyWidgets: [['1', 'value']] },
        inputs: [], outputs: [{ name: 'text' }] })),
      ...[3, 4].map((id) => ({ id, type: 'CLIPTextEncode', pos: [550, (id - 2) * 250],
        inputs: [{ name: 'clip' }, { name: 'text', widget: { name: 'text' } }], outputs: [{ name: 'CONDITIONING' }], widgets_values: [''] })),
    ], links: [[1, 1, 0, 3, 1, 'STRING'], [2, 2, 0, 4, 1, 'STRING']], definitions: { subgraphs: [{
      id: 'primitive-subgraph', name: 'Text', inputs: [], outputs: [{ id: 'text', name: 'text', type: 'STRING', linkIds: [1] }],
      nodes: [{ id: 1, type: 'PrimitiveNode', pos: [0, 0], outputs: [{ name: 'STRING', type: 'STRING' }], widgets_values: ['Default'] }],
      links: [{ id: 1, origin_id: 1, origin_slot: 0, target_id: -20, target_slot: 0, type: 'STRING' }],
    }] } }, 'Unsupported subgraph boundary')
    return {
      failures: failures.map((failure: any) => ({ code: failure.code, severity: failure.severity })),
      problems: app.problems.get().map(({ code, severity }) => ({ code, severity })),
      activeTabUnchanged: app.activeTab()!.id === before.id,
    }
  })
  expect(result.failures).toContainEqual({ code: 'import.subgraphs.boundaryUnsupported', severity: 'error' })
  expect(result.problems).toContainEqual({ code: 'import.subgraphs.boundaryUnsupported', severity: 'error' })
  expect(result.activeTabUnchanged).toBe(true)
  expect(errors).toEqual([])
})
