import { expect, test } from '@playwright/test'

for (const nested of [false, true]) for (const batchSupported of [false, true]) test(`IMAGE batch in Canvas and App View (nested list: ${nested}, batch capability: ${batchSupported})`, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Isolated fixture' } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'image-test', schemaWire: 1 }, nodes: {} } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  const pngs = await page.evaluate((grayAlpha) => Array.from({ length: 9 }, (_, index) => {
    const canvas = document.createElement('canvas')
    canvas.width = 480; canvas.height = 300
    const context = canvas.getContext('2d')!
    context.fillStyle = (grayAlpha ? ['#333333cc', '#555555cc', '#777777cc'] : ['#0f766e', '#1d4ed8', '#9f1239'])[index % 3]!
    context.fillRect(0, 0, 480, 300)
    context.fillStyle = '#ffffff'; context.font = 'bold 42px sans-serif'
    context.fillText(`Batch image ${index + 1}`, 65, 160)
    return canvas.toDataURL('image/png').split(',')[1]!
  }), nested)
  const imageDescriptor = { typeId: 'comfy.IMAGE', fingerprint: 'immutable-batch', meta: {
    shape: nested ? [9, 6000, 9600, 2] : [9, 300, 480, 3],
    channels: nested ? { layout: 'gray_alpha', alpha: 'straight' } : { layout: 'rgb', alpha: 'none' },
    dtype: 'float32', storage_dtype: 'fp32', color: { primaries: 9, transfer: 16, range: 2 },
  } }
  const descriptor = nested ? { typeId: 'list<comfy.IMAGE>', fingerprint: 'immutable-list', length: 2, elements: [imageDescriptor, imageDescriptor] } : imageDescriptor
  const colorTransform = 'PQ-to-sRGB; reinhard; reference-display'
  const requests: URL[] = []
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url()); requests.push(url)
    const element = url.searchParams.get('element')
    if (!url.searchParams.has('rendition')) return route.fulfill({ json: { available: true,
      descriptor: nested && element === null ? descriptor : imageDescriptor,
      renditions: [{ kind: 'png', mime: 'image/png', default: true, ...(batchSupported ? {
        version: 'png-test-v1', parameters: ['batch'], defaults: { batch: '0' }, limits: { maxEdge: 1024 },
      } : {}) }],
    } })
    const index = Number(url.searchParams.get('batch') ?? 0)
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(pngs[index]!, 'base64'), headers: {
      ETag: `"immutable-${element}-${index}"`, 'X-Dinkster-Fingerprint': imageDescriptor.fingerprint,
      'X-Dinkster-Rendition': 'png', 'X-Dinkster-Color-Transform': colorTransform, 'X-Dinkster-Preview-Color-Space': 'sRGB',
    } })
  })
  await page.evaluate((descriptor) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'ImageBatchTest', displayName: 'Image batch', category: 'test', source: 'v3', isOutputNode: true, emitsPreviews: true,
      items: [{ kind: 'output', id: 'image', type: { kind: 'concrete', name: 'comfy.IMAGE' }, preview: true }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'image-batch', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Image batch', nodes: { image: { id: 'image', type: 'ImageBatchTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { image: { position: { x: 80, y: 80 }, size: { width: 460, height: 380 } } } } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'g0', nodeId: 'image' }] },
    }, 'Image batch')
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'image-batch-run' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { image: { state: 'done', outputs: { image: descriptor } } } })
    store.apply({ kind: 'nodeOutput', execution: ref, runtimeNodeId: 'image', timestamp: Date.now(), output: { image: descriptor } })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, descriptor)
  const before = await page.evaluate(() => ({
    doc: window.__dinksterTest!.app.activeTab()!.store.doc,
    outputs: [...window.__dinksterTest!.app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'image-batch-run')!.outputs,
  }))
  const pager = page.getByTestId('node-output-pager')
  if (!batchSupported) {
    const reason = 'IMAGE batch preview unavailable: backend does not advertise the PNG batch parameter.'
    await expect(pager.getByRole('alert')).toHaveText(reason)
    await expect(pager.getByRole('button')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath('canvas-unsupported-batch.png') })
    await page.getByTestId('views-switcher').click()
    await page.getByRole('menuitemradio', { name: 'App view' }).click()
    await expect(page.getByTestId('app-preview-row').getByRole('alert')).toHaveText(reason)
    await expect(page.getByRole('button', { name: 'Open image viewer' })).toHaveCount(0)
    await page.getByTestId('app-preview-row').screenshot({ path: testInfo.outputPath('app-unsupported-batch.png') })
    expect(requests.some((url) => url.searchParams.has('rendition') || url.searchParams.has('batch'))).toBe(false)
    expect(errors).toEqual([])
    return
  }
  await expect(pager).toContainText('1/9')
  const nextImage = pager.getByRole('button', { name: 'Next image for Image batch' })
  await nextImage.click()
  await expect(pager).toContainText('2/9')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews()['image']?.index)).toBe(1)
  await expect(nextImage).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(pager).toContainText('3/9')
  await expect(nextImage).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('canvas-batch-pager.png') })
  for (const scale of [0.75, 0.5, 1]) {
    await page.evaluate((scale) => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale }), scale)
    await expect(pager.getByRole('button', { name: 'Open image 3 of 9 for Image batch' })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`canvas-batch-zoom-${scale}.png`) })
  }
  await pager.getByRole('button', { name: 'Open image 3 of 9 for Image batch' }).click()
  for (const view of ['Canvas', 'App View']) {
    const viewer = page.getByTestId('output-viewer')
    await expect(viewer).toBeVisible()
    await expect(viewer.locator('.output-preview-color')).toContainText(colorTransform)
    await viewer.getByRole('button', { name: 'Show all images' }).click()
    await expect(viewer.getByTestId('output-viewer-grid').getByRole('listitem')).toHaveCount(4)
    await expect(viewer.getByTestId('output-viewer-grid').locator('img')).toHaveCount(4)
    if (nested && view === 'App View') await expect(viewer.getByTestId('output-viewer-grid').getByRole('listitem').last()).toBeInViewport({ ratio: 1 })
    await viewer.screenshot({ path: testInfo.outputPath(`${view}-batch-grid.png`) })
    await viewer.getByRole('button', { name: 'Next grid page' }).click()
    await expect(viewer.getByRole('button', { name: /Image 5 of 9/ })).toBeVisible()
    await viewer.getByRole('button', { name: /Image 5 of 9/ }).click()
    await expect(viewer.getByTestId('output-viewer-position')).toHaveText('5 / 9')
    await viewer.getByRole('button', { name: 'Compare slider' }).click()
    await viewer.getByRole('spinbutton', { name: 'Left image number' }).fill('2')
    await viewer.getByRole('spinbutton', { name: 'Left image number' }).press('Tab')
    await viewer.getByRole('spinbutton', { name: 'Right image number' }).fill('7')
    await viewer.getByRole('spinbutton', { name: 'Right image number' }).press('Tab')
    await expect(viewer.getByRole('img', { name: 'Left image 2', exact: true })).toBeVisible()
    await expect(viewer.getByRole('img', { name: 'Right image 7', exact: true })).toBeVisible()
    await viewer.getByRole('slider', { name: 'Compare split' }).fill('35')
    await expect(viewer.getByTestId('output-compare-stage').locator('figure').first()).toHaveCSS('clip-path', 'inset(0px 65% 0px 0px)')
    await viewer.screenshot({ path: testInfo.outputPath(`${view}-compare-slider.png`) })
    await viewer.getByRole('button', { name: 'Side by side' }).click()
    await viewer.getByRole('button', { name: 'Next right image' }).press('ArrowLeft')
    await expect(viewer.getByRole('spinbutton', { name: 'Left image number' })).toHaveValue('2')
    await expect(viewer.getByRole('spinbutton', { name: 'Right image number' })).toHaveValue('6')
    await expect(viewer.getByRole('img', { name: 'Right image 6', exact: true })).toBeVisible()
    await viewer.screenshot({ path: testInfo.outputPath(`${view}-side-by-side.png`) })
    await page.keyboard.press('Escape')
    await expect(viewer).toHaveCount(0)
    if (view === 'Canvas') {
      await page.getByTestId('views-switcher').click()
      await page.getByRole('menuitemradio', { name: 'App view' }).click()
      const controls = page.getByRole('group', { name: 'Image batch controls' })
      await expect(controls).toContainText('1 / 9')
      await controls.getByRole('button', { name: 'Next image', exact: true }).press('ArrowRight')
      await expect(controls).toContainText('2 / 9')
      await expect(page.getByTestId('app-preview-color-transform')).toHaveText(`Preview color: ${colorTransform}`)
      await page.getByTestId('app-preview-row').screenshot({ path: testInfo.outputPath('app-batch-pager.png') })
      if (nested) {
        await page.getByRole('button', { name: 'Toggle right rail' }).click()
        await page.setViewportSize({ width: 390, height: 844 })
      }
      await controls.getByRole('button', { name: 'Open image viewer' }).click()
    }
  }
  const after = await page.evaluate(() => ({
    doc: window.__dinksterTest!.app.activeTab()!.store.doc,
    outputs: [...window.__dinksterTest!.app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'image-batch-run')!.outputs,
  }))
  expect(after).toEqual(before)
  const renditions = requests.filter((url) => url.searchParams.has('rendition'))
  expect(renditions.length).toBeGreaterThan(5)
  expect(renditions.every((url) => url.searchParams.get('rendition') === 'png' && url.searchParams.get('jobId') === 'image-batch-run' && url.searchParams.get('nodeId') === 'image' && url.searchParams.get('outputId') === 'image')).toBe(true)
  expect(renditions.every((url) => url.searchParams.get('element') === (nested ? '0' : null) && /^[0-8]$/.test(url.searchParams.get('batch')!))).toBe(true)
  expect(errors).toEqual([])
})
