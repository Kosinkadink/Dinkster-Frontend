import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const pathSchema = {
  schemaVersion: 41, nodeType: 'comfy.VHS_LoadVideoPath', displayName: 'VHS_LoadVideoPath',
  interface: [{ role: 'input', id: 'video', required: true,
    type: { kind: 'concrete', types: ['core.string'] },
    widget: { type: 'STRING', placeholder: 'X://insert/path/here.mp4' },
  }],
}
const schemas = [
  ...JSON.parse(readFileSync(new URL('../../core/fixtures/dinkster-wire41.json', import.meta.url), 'utf8')) as { nodeType: string }[],
  pathSchema,
]

test('loads wire41 serializer fixtures and the native path widget without browser chunk transport', async ({ page }, testInfo) => {
  const valueRequests: string[] = []
  await page.route('/api/**', (route) => {
    if (route.request().url().includes('/api/values')) valueRequests.push(route.request().url())
    return route.fulfill({ status: 404, json: { error: 'isolated schema fixture' } })
  })
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated fixture' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'schema41-fixture', schemaWire: 41 },
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
  await page.evaluate((types) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    for (const [index, type] of types.entries()) {
      const result = tab.store.dispatch({ command: 'node.add', params: {
        graphId: tab.store.doc.root, type, values: {}, position: { x: 120 + (index % 2) * 380, y: 110 + Math.floor(index / 2) * 240 },
      } })
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    }
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, schemas.map((schema) => schema.nodeType))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(5)
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    const source = renderer.getScene().nodes.find((node) => graph.nodes[node.id]?.type === 'test.stream_source')!
    const pin = source.layout.pins.find((pin) => pin.direction === 'out')!
    if (JSON.stringify(pin.type) !== JSON.stringify({ kind: 'stream', element: { kind: 'concrete', name: 'dinkster.image' } })) throw new Error('Stream type lost in scene')
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return { x: canvas.left + source.x + source.layout.width, y: canvas.top + source.y + pin.y }
  })
  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('app-tooltip')).toContainText('stream<IMAGE>')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.every((node) => !node.unrecognized))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('wire41-stream-catalog.png') })
  expect(valueRequests).toEqual([])
})
