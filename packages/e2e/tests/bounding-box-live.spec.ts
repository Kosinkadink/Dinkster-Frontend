import { expect, nativeTest as test, waitForStartupOwnership, type Page } from './fixtures.js'

async function openCrop(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'crop')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'crop_region')!
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('bounding-box-editor')).toBeVisible()
}

test('crop fields submit exact pixels, preview the source and preserve undo', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 20_000 })
  await waitForStartupOwnership(page)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'bounding-box-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'Crop',
        nodes: {
          source: { id: 'source', type: 'EmptyImage', values: { width: 64, height: 48, batch_size: 1, color: 0x28649c } },
          crop: { id: 'crop', type: 'ImageCropV2', values: { crop_region: { x: 0, y: 0, width: 32, height: 24 } } },
        },
        links: { image: { id: 'image', from: { node: 'source', port: 'IMAGE' }, to: { node: 'crop', port: 'image' } } },
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 60, y: 100 } }, crop: { position: { x: 400, y: 100 } },
      } } } },
    } as never, 'Crop')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const run = async (node: string): Promise<void> => {
    await page.evaluate(async (node) => {
      const app = window.__dinksterTest!.app
      await app.queueSelection(app.activeTab()!, [node])
    }, node)
    await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  }
  await run('source')
  await openCrop(page)
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.message.includes('BOUNDING_BOX')))).toEqual([])
  await expect(page.locator('[data-editor-mode="raw"]')).toHaveCount(0)
  const preview = page.locator('.bounding-box-preview')
  await expect(preview).toBeVisible()
  expect(await preview.evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    const context = canvas.getContext('2d')!
    return { width: canvas.width, height: canvas.height,
      inside: [...context.getImageData(8, 8, 1, 1).data], outside: [...context.getImageData(56, 40, 1, 1).data] }
  })).toEqual({ width: 64, height: 48, inside: [40, 100, 156, 255], outside: [20, 50, 78, 255] })
  const screenshot = testInfo.outputPath('crop-source.png')
  await page.getByTestId('bounding-box-editor').screenshot({ path: screenshot })
  await testInfo.attach('crop-source', { path: screenshot, contentType: 'image/png' })
  await page.locator('#bounding-box-width').fill('')
  await expect(page.getByRole('button', { name: 'Apply crop', exact: true })).toBeDisabled()
  const viewport = page.viewportSize()!
  for (const theme of ['dark', 'light']) {
    await page.evaluate((theme) => { document.documentElement.dataset['theme'] = theme }, theme)
    const contrast = await page.getByRole('button', { name: 'Apply crop', exact: true }).evaluate((button) => {
      const style = getComputedStyle(button)
      const rgb = (color: string) => color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
      const parent = rgb(getComputedStyle(button.closest('[role="dialog"]')!).backgroundColor)
      const opacity = Number(style.opacity)
      const luminance = (color: string) => rgb(color).map((value, index) => {
        const channel = (value * opacity + parent[index]! * (1 - opacity)) / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
      const foreground = luminance(style.color)
      const background = luminance(style.backgroundColor)
      return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
    })
    expect(contrast, `${theme} disabled crop action contrast`).toBeGreaterThanOrEqual(4.5)
    for (const height of [viewport.height, viewport.height - 100]) {
      await page.setViewportSize({ ...viewport, height })
      await expect.poll(() => page.getByTestId('bounding-box-editor').evaluate((editor) => {
        const bounds = editor.getBoundingClientRect()
        return Array.from(editor.querySelectorAll('button')).every((button) => {
          const rect = button.getBoundingClientRect()
          return rect.top >= bounds.top && rect.bottom <= bounds.bottom
        })
      })).toBe(true)
      const name = `crop-invalid-${theme}${height === viewport.height ? '' : '-short'}`
      const invalid = testInfo.outputPath(`${name}.png`)
      await page.getByTestId('bounding-box-editor').screenshot({ path: invalid })
      await testInfo.attach(name, { path: invalid, contentType: 'image/png' })
    }
  }
  await page.evaluate(() => { document.documentElement.dataset['theme'] = 'dark' })
  await page.setViewportSize(viewport)
  for (const [field, value] of Object.entries({ x: '61', y: '43', width: '12', height: '9' })) {
    await page.locator(`#bounding-box-${field}`).fill(value)
  }
  await page.getByRole('button', { name: 'Apply crop', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('bounding-box-editor')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.crop!.values.crop_region))
    .toEqual({ x: 61, y: 43, width: 12, height: 9 })
  await run('crop')
  const pixels = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const execution = [...app.store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)[0]!
    const artifact = execution.artifact as typeof execution.artifact & {
      provenance: { toSource: Record<string, string>; outputAliases?: Record<string, Record<string, string>> }
    }
    const runtimeId = Object.keys(artifact.provenance.toSource).find((id) => artifact.provenance.toSource[id] === 'crop')!
    const backend = app.backendForTab(tab)
    if (backend.protocol !== 'dinkster') throw new Error('Expected native backend')
    const values = (backend.connection as unknown as import('@dinkster/client').DinksterConnection).values()
    const query = { jobId: execution.ref.prompt, nodeId: runtimeId, outputId: artifact.provenance.outputAliases?.[runtimeId]?.IMAGE ?? 'IMAGE' }
    const peek = await values.peek(query)
    if (!peek.available) throw new Error('Crop output unavailable')
    const rendition = peek.renditions.find((entry) => entry.mime === 'image/png')!
    return values.read(query, peek.descriptor, async () => {
      const result = await values.rendition(query, rendition.kind, { descriptor: peek.descriptor })
      if (!result.available) throw new Error('Crop rendition unavailable')
      const image = await createImageBitmap(new Blob([result.bytes], { type: result.mime }))
      try {
        const canvas = document.createElement('canvas')
        canvas.width = image.width; canvas.height = image.height
        const context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        return { width: image.width, height: image.height, pixel: [...context.getImageData(1, 1, 1, 1).data] }
      } finally { image.close() }
    })
  })
  expect(pixels).toEqual({ width: 3, height: 5, pixel: [40, 100, 156, 255] })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.crop!.values.crop_region))
    .toEqual({ x: 0, y: 0, width: 32, height: 24 })
})
