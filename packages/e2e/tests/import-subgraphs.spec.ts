import { readFileSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const readJson = (path: string): any => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const schemas = readJson('../../core/fixtures/object_info.json')
// Import results stay independent of the current backend catalog; see the
// fixture's _provenance for the graph and diagnostic goldens.
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

async function expectSchemasReady(page: Page): Promise<void> {
  let schemaCount = Object.keys(schemas).length
  if (inAuditLane()) {
    const response = await page.request.get('/api/nodes')
    expect(response.ok()).toBe(true)
    const catalog = await response.json()
    schemaCount = Object.keys(catalog.nodes).length
  }
  expect(schemaCount).toBeGreaterThan(0)
  await expect(page.getByTestId('status-bar')).toContainText(new RegExp(`(?<!\\d)${schemaCount} node schemas`))
}

test('draws and extracts an imported input boundary with its retained reroute fanout', async ({ page }, testInfo) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'junction-scene-test', schemaWire: 1 }, packs: {},
    nodes: { Relay: { displayName: 'Relay', category: 'test', interface: [
      { role: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 7 },
      { role: 'output', id: 'result', type: { kind: 'concrete', types: ['INT'] } },
    ] } },
  } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('Relay') ?? false)).toBe(true)
  const failures = await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    nodes: [{ id: 10, type: 'junction-body', pos: [100, 100],
      inputs: [{ name: 'value', widget: { name: 'value' } }], outputs: [{ name: 'result' }], widgets_values: [19] }], links: [],
    definitions: { subgraphs: [{ id: 'junction-body', name: 'Junction fanout', version: 1,
      inputs: [{ id: 'in', name: 'value', type: 'INT', linkIds: [1] }],
      outputs: [{ id: 'out', name: 'result', type: 'INT', linkIds: [5] }],
      nodes: [
        { id: 1, type: 'Relay', pos: [420, 80], inputs: [{ name: 'value', widget: { name: 'value' }, link: 3 }], outputs: [{ name: 'result' }], widgets_values: [7] },
        { id: 2, type: 'Relay', pos: [420, 320], inputs: [{ name: 'value', widget: { name: 'value' }, link: 4 }], outputs: [{ name: 'result' }], widgets_values: [11] },
        { id: 3, type: 'Reroute', pos: [170, 180], inputs: [{ name: '', link: 1 }], outputs: [{ name: '' }] },
        { id: 4, type: 'Reroute', pos: [310, 180], inputs: [{ name: '', link: 2 }], outputs: [{ name: '' }] },
      ],
      links: [[1, -10, 0, 3, 0, 'INT'], [2, 3, 0, 4, 0, 'INT'], [3, 4, 0, 1, 0, 'INT'],
        [4, 3, 0, 2, 0, 'INT'], [5, 2, 0, -20, 0, 'INT']],
    }] },
  }, 'Junction fanout'))
  expect(failures).toEqual([])
  const before = await page.evaluate(() => window.__dinksterTest!.app.exportDocument(window.__dinksterTest!.app.activeTab()!.id))
  await enterInstance(page, 'n10')
  await expect(page.getByTestId('graph-breadcrumb').getByRole('button')).toHaveCount(2)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 150, y: 100, scale: 1 }))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().reroutes.length)).toBe(2)
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('junction-boundary.png') })
  const scene = await page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    return { links: scene.links.map(({ id, from, to }) => ({ id, from, to })),
      reroutes: scene.reroutes.map(({ id, x, y }) => ({ id, x, y })) }
  })
  expect(scene.links.find((link) => link.id === 'boundary:inputs:in')?.to).toEqual({ kind: 'reroute', reroute: 'r3' })
  expect(scene.links.filter((link) => link.from.kind === 'reroute')).toHaveLength(3)
  expect(scene.reroutes).toEqual([{ id: 'r3', x: 170, y: 180 }, { id: 'r4', x: 310, y: 180 }])
  const after = await page.evaluate(() => window.__dinksterTest!.app.exportDocument(window.__dinksterTest!.app.activeTab()!.id))
  expect(after).toEqual(before)
  await page.getByTestId('graph-canvas').focus()
  await page.keyboard.press('Control+a')
  const graphCount = await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).length)
  await page.keyboard.press('Control+Shift+E')
  await expect.poll(() => page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).length)).toBe(graphCount + 1)
  const extracted = await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const body = doc.graphs['junction-body']!
    const occurrence = Object.values(body.nodes)[0]!
    const nested = doc.graphs[occurrence.type.slice(1)]!
    return { occurrence: occurrence.id, boundary: nested.boundary, reroutes: Object.keys(nested.reroutes), links: Object.keys(nested.links) }
  })
  expect(extracted.reroutes).toHaveLength(2)
  expect(extracted.links).toHaveLength(3)
  expect(extracted.boundary!.inputs[0]!.binds).toMatchObject({ viaReroute: extracted.reroutes[0] })
  await enterInstance(page, extracted.occurrence)
  await expect(page.getByTestId('graph-breadcrumb').getByRole('button')).toHaveCount(3)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 500, y: 350, scale: 1 }))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().reroutes.length)).toBe(2)
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('junction-extracted.png') })
  const exported = await page.evaluate(() => window.__dinksterTest!.app.exportDocument(window.__dinksterTest!.app.activeTab()!.id))
  const reopened = await page.evaluate((doc) => {
    const app = window.__dinksterTest!.app
    const failures = app.openDocument(doc, 'Extracted fanout')
    return { failures, exported: app.exportDocument(app.activeTab()!.id) }
  }, exported)
  expect(reopened.failures).toEqual([])
  expect(reopened.exported).toEqual(exported)
})

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
  await expectSchemasReady(page)
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
  await expectSchemasReady(page)
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
