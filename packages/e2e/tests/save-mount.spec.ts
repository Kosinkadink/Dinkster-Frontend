import { expect, test, type Page } from './fixtures.js'

async function mountPoint(page: Page) {
  return page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((node) => node.id === 'save')!
    const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'destination')!
    const viewport = renderer.getViewport()
    const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
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
  const point = await mountPoint(page)
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
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('mount-widget-choice')).toHaveText('archive')
  await page.screenshot({ path: testInfo.outputPath('mount-explicit.png') })
  await page.setViewportSize({ width: 600, height: 700 })
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
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await values()).toEqual({ prefix: 'frames/session', quality: 73, destination: 'archive' })
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes))).toEqual(['save'])
  await expect(page.getByTestId('save-target-editor')).toHaveCount(0)
})
