import { readFileSync } from 'node:fs'
import { expect, nativeTest as test } from './fixtures.js'

const pathSchema = {
  schemaVersion: 1, nodeType: 'comfy.VHS_LoadVideoPath', displayName: 'VHS_LoadVideoPath',
  interface: [{ role: 'input', id: 'video', required: true,
    type: { kind: 'concrete', types: ['STRING'] },
    widget: { type: 'STRING', placeholder: 'X://insert/path/here.mp4' },
  }],
}
const schemas = [
  ...JSON.parse(readFileSync(new URL('../../core/fixtures/dinkster-wire41.json', import.meta.url), 'utf8')) as { nodeType: string }[],
  pathSchema,
]

test('loads wire41 serializer fixtures and the native path widget without browser chunk transport', async ({ page }, testInfo) => {
  const valueRequests: string[] = []
  await page.route(/\/api\/(?!library\/retentions\/)/, (route) => {
    if (route.request().url().includes('/api/values')) valueRequests.push(route.request().url())
    return route.fulfill({ status: 404, json: { error: 'isolated schema fixture' } })
  })
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated fixture' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'schema41-fixture', schemaWire: 1 },
    nodes: Object.fromEntries(schemas.map((schema) => [schema.nodeType, schema])),
  } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(5)
  expect(await page.evaluate(() => {
    const schema = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!.schemas.get('comfy.VHS_LoadVideoPath')
    if (!schema || typeof schema !== 'object' || !('items' in schema) || !Array.isArray(schema.items)) {
      throw new Error('Native path schema is missing its interface')
    }
    return schema.items[0]
  })).toMatchObject({
    id: 'video', widget: { widgetType: 'STRING', options: { placeholder: 'X://insert/path/here.mp4' } },
  })
  await page.evaluate(async (types) => {
    // Wire15 dormant identities are displayable but cannot authorize publication.
    const diagnostics = (await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wire41-display', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: Object.fromEntries(types.map((type, index) =>
        [`node-${index}`, { id: `node-${index}`, type, values: {} }])), links: {}, nets: {}, reroutes: {}, nextOrdinal: 5 } },
      view: { graphs: { g0: { nodes: Object.fromEntries(types.map((_, index) =>
        [`node-${index}`, { position: { x: 120 + (index % 2) * 380, y: 110 + Math.floor(index / 2) * 240 } }])) } } },
    }, 'Wire41 display'))
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, schemas.map((schema) => schema.nodeType))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(5)
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    const source = renderer.getScene().nodes.find((node) => graph.nodes[node.id]?.type === 'test.stream_source')!
    const pin = source.layout.pins.find((pin) => pin.direction === 'out')!
    if (JSON.stringify(pin.type) !== JSON.stringify({ kind: 'stream', element: { kind: 'concrete', name: 'IMAGE' } })) throw new Error('Stream type lost in scene')
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return { x: canvas.left + source.x + source.layout.width, y: canvas.top + source.y + pin.y }
  })
  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('app-tooltip')).toContainText('stream<IMAGE>')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.every((node) => !node.unrecognized))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('wire41-stream-catalog.png') })
  expect(valueRequests).toEqual([])
})
