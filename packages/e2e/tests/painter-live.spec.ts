import { expect, test, type Page } from '@playwright/test'
import { selectProductOption } from './fixtures.js'

async function openPainter(page: Page, nodeId = 'paint'): Promise<void> {
  const point = await page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === nodeId)!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'mask')!
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
  }, nodeId)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('painter-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
}

for (const connected of [false, true]) test(`Painter ${connected ? 'connected first frame' : 'background'} uploads, reopens, executes and undoes`, async ({ page }, testInfo) => {
  test.skip(!process.env['DINKSTER_NATIVE_BACKEND'], 'requires an isolated native backend')
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 20_000 })
  await page.evaluate((connected) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'painter-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'Painting',
        nodes: {
          paint: { id: 'paint', type: 'Painter', values: { width: 128, height: 64, bg_color: '#123456' } },
          ...(connected ? { source: { id: 'source', type: 'EmptyImage', values: { width: 64, height: 128, batch_size: 2, color: 0x28649c } } } : {}),
        },
        links: connected ? { image: { id: 'image', from: { node: 'source', port: 'IMAGE' }, to: { node: 'paint', port: 'image' } } } : {},
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: { paint: { position: { x: 100, y: 100 }, size: { width: 400, height: 360 } } } } } },
    } as never, 'Painter')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, connected)
  await page.waitForFunction(() => window.__dinksterTest!.renderer!.getScene().nodes.some((node) =>
    node.id === 'paint' && node.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'mask')))
  if (connected) {
    await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      await app.queueSelection(app.activeTab()!, ['source'])
    })
    await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  }
  await openPainter(page)
  expect(await page.locator('.painter-base').evaluate((element) => {
    const base = element as HTMLCanvasElement
    return { width: base.width, height: base.height, pixel: [...base.getContext('2d')!.getImageData(0, 0, 1, 1).data] }
  })).toEqual(connected ? { width: 64, height: 128, pixel: [40, 100, 156, 255] } : { width: 128, height: 64, pixel: [18, 52, 86, 255] })
  const canvas = page.locator('.painter-canvas')
  await page.locator('#painter-color').fill('#e12668')
  const bounds = (await canvas.boundingBox())!
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  const pixels = () => canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const context = canvas.getContext('2d')!
    return { painted: [...context.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data], clear: [...context.getImageData(0, 0, 1, 1).data] }
  })
  expect(await pixels()).toEqual({ painted: [225, 38, 104, 255], clear: [0, 0, 0, 0] })
  await selectProductOption(page, page.getByTestId('upload-destination-mount'), 'output')
  await page.getByTestId('upload-destination-folder').fill('paintings')
  const upload = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/assets/media')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  const uploaded = await upload
  expect(uploaded.ok(), await uploaded.text()).toBe(true)
  expect(new URL(uploaded.url()).searchParams.get('mount')).toBe('output')
  expect(new URL(uploaded.url()).searchParams.get('folder')).toBe('paintings')
  await expect(page.getByTestId('painter-editor')).toHaveCount(0)
  const asset = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.paint!.values.mask)
  expect(asset).toMatchObject({ name: expect.stringMatching(/^painting(?:_[0-9]+)?\.png$/), mediaType: 'image/png' })
  await openPainter(page)
  expect(await pixels()).toEqual({ painted: [225, 38, 104, 255], clear: [0, 0, 0, 0] })
  const screenshot = testInfo.outputPath('reopened-painting.png')
  await page.getByTestId('painter-editor').screenshot({ path: screenshot })
  await testInfo.attach('reopened-painting', { path: screenshot, contentType: 'image/png' })
  await page.setViewportSize({ width: 430, height: 900 })
  const narrow = testInfo.outputPath('narrow-painting.png')
  await page.getByTestId('painter-editor').screenshot({ path: narrow })
  await testInfo.attach('narrow-painting', { path: narrow, contentType: 'image/png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['paint'])
  })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.paint!.values.mask)).toBeUndefined()
  if (!connected) {
    const imported = await page.evaluate((asset) => {
      const app = window.__dinksterTest!.app
      const workflow = (mask: string) => ({ version: 0.4, nodes: [{ id: 1, type: 'Painter', pos: [100, 100], size: [400, 360],
        widgets_values: [mask, 128, 64, '#123456'] }], links: [] })
      const emptyErrors = app.openDocument(workflow(''), 'Empty imported painting')
      const emptyValues = app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values
      const errors = app.openDocument(workflow(asset.name), 'Imported painting filename')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
      return { emptyErrors, emptyValues, errors }
    }, asset as { name: string })
    expect(imported).toEqual({ emptyErrors: [], emptyValues: { width: 128, height: 64, bg_color: '#123456' }, errors: [] })
    await expect.poll(() => page.evaluate(() => {
      const app = window.__dinksterTest!.app
      return document.querySelector('[data-testid=import-assets-accept]') !== null || typeof app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.mask === 'object'
    })).toBe(true)
    if (await page.getByTestId('import-assets-accept').isVisible()) await page.getByTestId('import-assets-accept').click()
    await openPainter(page, 'n1')
    expect(await pixels()).toEqual({ painted: [225, 38, 104, 255], clear: [0, 0, 0, 0] })
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      await app.queueSelection(app.activeTab()!, ['n1'])
    })
    await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  } else {
    await page.evaluate(() => {
      const app = window.__dinksterTest!.app
      app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'source', inputId: 'color', value: 0x12ab34 } })
    })
    await openPainter(page)
    await expect(page.getByTestId('painter-editor').getByRole('alert').filter({ hasText: 'Run the connected image source' })).toBeVisible()
    await page.getByRole('button', { name: 'Clear paint' }).click()
    await page.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(page.getByTestId('painter-editor').getByRole('alert').filter({ hasText: 'Run the connected image source' })).toBeVisible()
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.paint!.values.mask)).toBeUndefined()
    const stale = testInfo.outputPath('stale-source.png')
    await page.getByTestId('painter-editor').screenshot({ path: stale })
    await testInfo.attach('stale-source', { path: stale, contentType: 'image/png' })
  }
})
