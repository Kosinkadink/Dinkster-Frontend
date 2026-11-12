import { expect, nativeTest as test, waitForStartupOwnership, type Page } from './fixtures.js'

async function openComparison(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.some((entry) => entry.id === 'compare'))).toBe(true)
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'compare')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'compare_view')!
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('image-compare-editor')).toBeVisible()
}

test('compares real completed image batches with independent keyboard frame selection and local wipe state', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 20_000 })
  await waitForStartupOwnership(page)
  const openDocument = async (single = false): Promise<void> => {
    await page.evaluate(async (single) => {
      const nodes: Record<string, unknown> = {
        compare: { id: 'compare', type: 'ImageCompare', values: { compare_view: null } },
      }
      const links: Record<string, unknown> = {}
      for (const [id, color] of [['red', 0xff0000], ['green', 0x00ff00], ['blue', 0x0000ff], ['yellow', 0xffff00], ['cyan', 0x00ffff]] as const) {
        nodes[id] = { id, type: 'EmptyImage', values: { width: 64, height: 36, batch_size: 1, color } }
      }
      const link = (id: string, from: string, to: string, port: string): void => {
        links[id] = { id, from: { node: from, port: 'IMAGE' }, to: { node: to, port } }
      }
      for (const [id, first, second] of [['a', 'red', 'green'], ['b1', 'blue', 'yellow'], ['b', 'b1', 'cyan']] as const) {
        nodes[id] = { id, type: 'ImageBatch', values: {} }
        link(`link-${id}-first`, first, id, 'image1'); link(`link-${id}-second`, second, id, 'image2')
      }
      link('a-compare', 'a', 'compare', 'image_a')
      if (!single) link('b-compare', 'b', 'compare', 'image_b')
      const diagnostics = await window.__dinksterTest!.app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: single ? 'compare-single' : 'compare-paired', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'Compare', nodes, links, nets: {}, reroutes: {}, nextOrdinal: 20 } },
        view: { graphs: { g0: { nodes: Object.fromEntries(Object.keys(nodes).map((id, index) => [id,
          { position: id === 'compare' ? { x: 100, y: 100 } : { x: -1000, y: index * 300 } }])) } } },
      } as never, 'Compare')
      if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    }, single)
  }
  const run = async (): Promise<void> => {
    await page.evaluate(async () => {
      const app = window.__dinksterTest!.app
      await app.queueSelection(app.activeTab()!, ['compare'])
    })
    await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  }
  const pixel = async (x: number): Promise<number[]> => page.locator('.image-compare-preview').evaluate((element, x) =>
    [...(element as HTMLCanvasElement).getContext('2d')!.getImageData(x, 180, 1, 1).data], x)
  const capture = async (name: string): Promise<void> => {
    const path = testInfo.outputPath(`${name}.png`)
    await page.getByTestId('image-compare-editor').screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  await openDocument()
  await openComparison(page)
  await expect(page.getByRole('slider', { name: 'Wipe divider' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('combobox', { name: 'Image A frame' })).toBeDisabled()
  await capture('compare-empty')
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await run()
  await openComparison(page)
  await expect.poll(() => pixel(100)).toEqual([255, 0, 0, 255])
  await expect.poll(() => pixel(500)).toEqual([0, 0, 255, 255])
  const chooseFrame = async (side: string, end: boolean): Promise<void> => {
    const choice = page.getByRole('combobox', { name: `Image ${side} frame` })
    await choice.focus(); await page.keyboard.press('Enter')
    await page.keyboard.press(end ? 'End' : 'Home'); await page.keyboard.press('Enter')
  }
  await chooseFrame('A', true)
  await expect.poll(() => pixel(100)).toEqual([0, 255, 0, 255])
  await expect.poll(() => pixel(500)).toEqual([0, 0, 255, 255])
  await chooseFrame('B', true)
  await expect.poll(() => pixel(500)).toEqual([0, 255, 255, 255])
  await expect(page.getByRole('combobox', { name: 'Image A frame' })).toContainText('Frame 2 of 2')
  await expect(page.getByRole('combobox', { name: 'Image B frame' })).toContainText('Frame 3 of 3')
  await capture('compare-paired')
  const divider = page.getByRole('slider', { name: 'Wipe divider' })
  await divider.focus(); await page.keyboard.press('Home')
  await expect.poll(() => pixel(100)).toEqual([0, 255, 255, 255])
  await page.keyboard.press('End')
  await expect.poll(() => pixel(500)).toEqual([0, 255, 0, 255])
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.compare!.values.compare_view)).toBeNull()
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.message.includes('IMAGECOMPARE')))).toEqual([])
  await expect(page.locator('[data-editor-mode="raw"]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await openDocument(true)
  await run()
  await openComparison(page)
  await expect.poll(() => pixel(500)).toEqual([255, 0, 0, 255])
  await expect(page.getByRole('slider', { name: 'Wipe divider' })).toHaveAttribute('aria-disabled', 'true')
  await expect(page.getByRole('combobox', { name: 'Image B frame' })).toBeDisabled()
  await capture('compare-single')
})
