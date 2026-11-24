import { expect, nativeTest as test, unfoldNodeEditor, waitForWorkspaceReady, type Locator } from './fixtures.js'

test('compares real completed image batches in the node with independent keyboard frame selection and local wipe state', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-connection')).toHaveAttribute('data-state', 'connected', { timeout: 20_000 })
  await waitForWorkspaceReady(page)
  const openDocument = async (single = false): Promise<void> => {
    await page.evaluate(async (single) => {
      const nodes: Record<string, unknown> = {
        compare: { id: 'compare', type: 'dinkster.image.image_compare', values: {} },
      }
      const links: Record<string, unknown> = {}
      for (const [id, color] of [['red', 0xff0000], ['green', 0x00ff00], ['blue', 0x0000ff], ['yellow', 0xffff00], ['cyan', 0x00ffff]] as const) {
        nodes[id] = { id, type: 'dinkster.image.empty_image', values: { width: 64, height: 36, batch_size: 1, color } }
      }
      const link = (id: string, from: string, to: string, port: string): void => {
        links[id] = { id, from: { node: from, port: 'IMAGE' }, to: { node: to, port } }
      }
      for (const [id, first, second] of [['a', 'red', 'green'], ['b1', 'blue', 'yellow'], ['b', 'b1', 'cyan']] as const) {
        nodes[id] = { id, type: 'dinkster.image.image_batch', values: {} }
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
  let editor!: Locator
  const picture = () => editor.getByRole('img', { name: 'Image A on the left and image B on the right of the wipe divider' })
  // The color at a fraction of the picture's width, halfway down.
  const pixel = async (at: number): Promise<number[]> => picture().evaluate((element, at) => {
    const canvas = element as HTMLCanvasElement
    return [...canvas.getContext('2d')!.getImageData(Math.round(canvas.width * at), Math.round(canvas.height / 2), 1, 1).data]
  }, at)
  const capture = async (name: string): Promise<void> => {
    const path = testInfo.outputPath(`${name}.png`)
    await editor.screenshot({ path })
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  await openDocument()
  editor = await unfoldNodeEditor(page, 'compare', 'comparison')
  await expect(picture()).toHaveAttribute('data-images', '0')
  await expect(editor).toContainText('Run to compare')
  await expect(editor.getByRole('button', { name: /^Image A frame/ })).toContainText('No images')
  await capture('compare-empty')
  await run()
  await expect(picture()).toHaveAttribute('data-images', '2')
  await expect.poll(() => pixel(0.3)).toEqual([255, 0, 0, 255])
  await expect.poll(() => pixel(0.7)).toEqual([0, 0, 255, 255])
  // Opening a side's frame choice and stepping up from the first entry picks its last frame.
  const chooseLastFrame = async (side: string): Promise<void> => {
    await editor.getByRole('button', { name: new RegExp(`^Image ${side} frame`) }).click()
    await expect(page.getByRole('listbox', { name: `Image ${side} frame options` })).toBeVisible()
    await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter')
  }
  await chooseLastFrame('A')
  await expect.poll(() => pixel(0.3)).toEqual([0, 255, 0, 255])
  await expect.poll(() => pixel(0.7)).toEqual([0, 0, 255, 255])
  await chooseLastFrame('B')
  await expect.poll(() => pixel(0.7)).toEqual([0, 255, 255, 255])
  await expect(editor.getByRole('button', { name: /^Image A frame/ })).toContainText('2 of 2')
  await expect(editor.getByRole('button', { name: /^Image B frame/ })).toContainText('3 of 3')
  await capture('compare-paired')
  const setDivider = async (value: number): Promise<void> => {
    await editor.getByRole('button', { name: /^Wipe divider \(%\):/ }).click()
    await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.type(String(value)); await page.keyboard.press('Enter')
  }
  await setDivider(0)
  await expect.poll(() => pixel(0.3)).toEqual([0, 255, 255, 255])
  await setDivider(100)
  await expect.poll(() => pixel(0.7)).toEqual([0, 255, 0, 255])
  // The divider and the frames are not stored.
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.compare!.values)).toEqual({})
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get().filter((problem) => problem.message.includes('IMAGECOMPARE')))).toEqual([])
  await openDocument(true)
  await run()
  editor = await unfoldNodeEditor(page, 'compare', 'comparison')
  await expect(picture()).toHaveAttribute('data-images', '1')
  await expect.poll(() => pixel(0.7)).toEqual([255, 0, 0, 255])
  await expect(editor.getByRole('button', { name: /^Image B frame/ })).toContainText('No images')
  await capture('compare-single')
})
