import { expect, test, type Page } from './fixtures.js'

async function mountPoint(page: Page, inputId = 'destination') {
  return page.evaluate((inputId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((node) => node.id === 'save')!
    const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === inputId)!
    if (row.kind !== 'widget') throw new Error('Missing widget')
    const viewport = renderer.getViewport()
    const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + row.inset! + (row.width ?? node.layout.width - row.inset! * 2) / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, inputId)
}

test('schema adjacency keeps separate prefix and mount controls through selection, default reset and undo', async ({ page }, testInfo) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'mount-contract-fixture', schemaWire: 1 },
    nodes: { SaveContractFixture: {
      schemaVersion: 1, displayName: 'Save contract fixture', outputNode: true,
      interface: [
        { role: 'input', id: 'prefix', type: { kind: 'concrete', types: ['STRING'] }, default: 'frames/session' },
        { role: 'input', id: 'quality', type: { kind: 'concrete', types: ['INT'] }, default: 73 },
        { role: 'input', id: 'destination', displayName: 'Mount', type: { kind: 'concrete', types: ['STRING'] }, required: false, default: null, widget: { type: 'MOUNT' }, adjacentTo: 'prefix' },
      ],
    } },
  } }))
  await page.route('/api/mounts*', (route) => route.fulfill({ json: { outputMount: 'primary', mounts: [
    { id: 'primary', mode: 'readwrite', state: 'ready' },
    { id: 'archive', mode: 'readwrite', state: 'ready' },
    { id: 'reference', mode: 'read', state: 'ready' },
    { id: 'offline', mode: 'readwrite', state: 'missing' },
  ] } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 30_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'mount-contract', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        save: { id: 'save', type: 'SaveContractFixture', values: { prefix: 'frames/session', quality: 73 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { save: { position: { x: 60, y: 60 } } } } } },
    }, 'Save mount contract')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'save')
    return node?.layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)
  })).toEqual(['prefix', 'destination', 'quality'])
  const prefixPoint = await mountPoint(page, 'prefix')
  const point = await mountPoint(page)
  expect(point.y).toBe(prefixPoint.y)
  expect(point.x).toBeGreaterThan(prefixPoint.x)
  await page.mouse.click(prefixPoint.x, prefixPoint.y)
  await expect(page.locator('[data-testid="widget-editor"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: testInfo.outputPath('mount-row-default.png') })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('mount-widget-editor')).toHaveAttribute('data-mounts', 'ready')
  await expect(page.getByTestId('mount-widget-choice')).toHaveText('Default output mount')
  await page.getByTestId('mount-widget-choice').click()
  await expect(page.getByRole('option')).toHaveText(['Default output mount', 'primary', 'archive'])
  await page.screenshot({ path: testInfo.outputPath('mount-default.png') })
  await page.locator('[data-option-id="archive"]').click()
  await page.getByTestId('mount-widget-apply').click()
  const values = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values)
  expect(await values()).toEqual({ prefix: 'frames/session', quality: 73, destination: 'archive' })
  await page.screenshot({ path: testInfo.outputPath('mount-row-explicit.png') })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('mount-widget-choice')).toHaveText('archive')
  await page.screenshot({ path: testInfo.outputPath('mount-explicit.png') })
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 600, height: 700 })
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  const narrowPoint = await mountPoint(page)
  expect(narrowPoint.y).toBe((await mountPoint(page, 'prefix')).y)
  await page.mouse.click(narrowPoint.x, narrowPoint.y)
  const editor = page.getByTestId('mount-widget-editor')
  await expect.poll(async () => {
    const rect = await editor.boundingBox()
    return rect !== null && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= 600 && rect.y + rect.height <= 700
  }).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mount-narrow.png') })
  await page.getByTestId('mount-widget-choice').click()
  await page.locator('[data-option-id=""]').click()
  await page.getByTestId('mount-widget-apply').click()
  expect(await values()).toEqual({ prefix: 'frames/session', quality: 73, destination: null })
  await page.screenshot({ path: testInfo.outputPath('mount-row-narrow-default.png') })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await values()).toEqual({ prefix: 'frames/session', quality: 73, destination: 'archive' })
  await page.screenshot({ path: testInfo.outputPath('mount-row-narrow-explicit.png') })
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes))).toEqual(['save'])
  await expect(page.getByTestId('save-target-editor')).toHaveCount(0)
  await page.setViewportSize({ width: 1440, height: 900 })
  const connectedDiagnostics = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const doc = app.activeTab()!.store.doc
    const graph = doc.graphs.g0!
    return app.openDocument(JSON.parse(JSON.stringify({
      ...doc,
      lineage: 'connected-mount-contract',
      graphs: { g0: { ...graph,
        nextOrdinal: 2,
        nodes: { ...graph.nodes, source: { ...graph.nodes.save!, id: 'source' } },
        links: { l1: { id: 'l1', from: { node: 'source', tap: 'prefix' }, to: { node: 'save', port: 'destination' } } },
      } },
      view: { graphs: { g0: { nodes: {
        save: { position: { x: 60, y: 60 } }, source: { position: { x: 540, y: 260 } },
      } } } },
    })), 'Connected mount contract')
  })
  expect(connectedDiagnostics).toEqual([])
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const source = scene.nodes.find((node) => node.id === 'source')
    const sink = scene.nodes.find((node) => node.id === 'save')
    const from = source?.layout.pins.find((pin) => pin.widgetTap && pin.portId === 'prefix')
    const to = sink?.layout.pins.find((pin) => pin.direction === 'in' && pin.portId === 'destination')
    const link = scene.links[0]
    return !!source && !!sink && !!from && !!to && !!link &&
      link.x1 === source.x + source.layout.width && link.y1 === source.y + from.y &&
      link.x2 === sink.x && link.y2 === sink.y + to.y
  })).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mount-row-connected.png') })
})

test('nested save presentation qualifies adjacent controls without reordering stored inputs', async ({ page }, testInfo) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'nested-mount-contract-fixture', schemaWire: 1 },
    nodes: { NestedSaveFixture: {
      schemaVersion: 1, displayName: 'Nested save contract fixture', outputNode: true,
      interface: [{ role: 'dynamicCombo', id: 'mode', options: [{ key: 'save', inputs: [
        { role: 'input', id: 'prefix', type: { kind: 'concrete', types: ['STRING'] }, default: 'nested/session' },
        { role: 'input', id: 'quality', type: { kind: 'concrete', types: ['INT'] }, default: 73 },
        { role: 'input', id: 'destination', displayName: 'Mount', type: { kind: 'concrete', types: ['STRING'] }, required: false, default: null, widget: { type: 'MOUNT' }, adjacentTo: 'prefix' },
      ] }] }],
    } },
  } }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 30_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'nested-mount-contract', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        save: { id: 'save', type: 'NestedSaveFixture', values: { 'mode.prefix': 'nested/session', 'mode.quality': 73 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { save: { position: { x: 60, y: 60 } } } } } },
    }, 'Nested save contract')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'save')
    return node?.layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId)
  })).toEqual(['mode', 'mode.prefix', 'mode.destination', 'mode.quality'])
  await page.screenshot({ path: testInfo.outputPath('mount-nested.png') })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values))
    .toEqual({ 'mode.prefix': 'nested/session', 'mode.quality': 73 })
})
