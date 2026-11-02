import { expect, test, type Page } from '@playwright/test'

async function openPainter(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'paint')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'mask')!
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('painter-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
}

test('Painter uploads real painted bytes, executes with their grant, reopens and undoes', async ({ page }, testInfo) => {
  test.skip(!process.env['DINKSTER_NATIVE_BACKEND'], 'requires an isolated native backend')
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 20_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'painter-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'Painting',
        nodes: { paint: { id: 'paint', type: 'Painter', values: { width: 128, height: 64, bg_color: '#000000' } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { paint: { position: { x: 100, y: 100 }, size: { width: 400, height: 360 } } } } } },
    } as never, 'Painter')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => window.__dinksterTest!.renderer!.getScene().nodes.some((node) =>
    node.id === 'paint' && node.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'mask')))
  await openPainter(page)
  const canvas = page.locator('.painter-canvas')
  await page.locator('#painter-color').fill('#e12668')
  const bounds = (await canvas.boundingBox())!
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  const pixels = () => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext('2d')!
    return { painted: [...context.getImageData(64, 32, 1, 1).data], clear: [...context.getImageData(0, 0, 1, 1).data] }
  })
  expect(await pixels()).toEqual({ painted: [225, 38, 104, 255], clear: [0, 0, 0, 0] })
  const upload = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/assets/media')
  await page.getByRole('button', { name: 'Apply', exact: true }).click()
  const uploaded = await upload
  expect(uploaded.ok(), await uploaded.text()).toBe(true)
  await expect(page.getByTestId('painter-editor')).toHaveCount(0)
  const asset = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.paint!.values.mask)
  expect(asset).toMatchObject({ name: expect.stringMatching(/^painting(?:_[0-9]+)?\.png$/), mediaType: 'image/png' })
  await openPainter(page)
  expect(await pixels()).toEqual({ painted: [225, 38, 104, 255], clear: [0, 0, 0, 0] })
  const screenshot = testInfo.outputPath('reopened-painting.png')
  await page.getByTestId('painter-editor').screenshot({ path: screenshot })
  await testInfo.attach('reopened-painting', { path: screenshot, contentType: 'image/png' })
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['paint'])
  })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.paint!.values.mask)).toBeUndefined()
})
