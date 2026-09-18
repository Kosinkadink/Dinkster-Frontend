import { expect, test, type Page } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

interface UploadedAsset {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

async function openLayerGraph(page: Page, asset: UploadedAsset): Promise<void> {
  await page.evaluate((source) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'live-layer-document', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          load: { id: 'load', type: 'dinkster.load_image', values: { image: source } },
          layers: { id: 'layers', type: 'dinkster.layers.add', values: { name: 'Transparent source' } },
          flatten: { id: 'flatten', type: 'dinkster.layers.flatten', values: { selector: 'composite' } },
        },
        links: {
          image: { id: 'image', from: { node: 'load', port: 'image' }, to: { node: 'layers', port: 'image' } },
          mask: { id: 'mask', from: { node: 'load', port: 'mask' }, to: { node: 'layers', port: 'mask' } },
          document: { id: 'document', from: { node: 'layers', port: 'layers' }, to: { node: 'flatten', port: 'layers' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 4,
      } },
      view: { graphs: { g0: { nodes: {
        load: { position: { x: 80, y: 180 } },
        layers: { position: { x: 430, y: 180 } },
        flatten: { position: { x: 800, y: 180 } },
      } } } },
    } as never, 'Live Layer Document')
  }, asset)
  await page.waitForFunction(() => window.__dinksterTest!.app.activeTab()?.id === 'live-layer-document')
}

async function decodeRgba(page: Page, bytes: Buffer): Promise<readonly number[]> {
  return page.evaluate(async (values) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(values)], { type: 'image/png' }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data]
  }, [...bytes])
}

async function decodeImage(page: Page, bytes: Buffer, mediaType: string): Promise<{
  readonly width: number
  readonly height: number
  readonly rgba: readonly number[]
}> {
  return page.evaluate(async ({ values, type }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(values)], { type }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    bitmap.close()
    return { width: canvas.width, height: canvas.height, rgba: [...context.getImageData(0, 0, canvas.width, canvas.height).data] }
  }, { values: [...bytes], type: mediaType })
}

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(3000) })
    if (response.ok) nodes = (await response.json() as { nodes?: Record<string, unknown> }).nodes
  } catch { /* skip below */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  test.skip(!['dinkster.load_image', 'dinkster.layers.add', 'dinkster.layers.edit', 'dinkster.layers.flatten', 'dinkster.save_image']
    .every((id) => id in nodes!),
    'native backend lacks the media and layer nodes required by this acceptance')
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 15_000 })
})

test('opens exact graph document bytes and matches the live flatten image and transparency mask', async ({ page, request }, testInfo) => {
  const rgba = [
    240, 20, 30, 255, 20, 220, 60, 192, 30, 60, 230, 96, 250, 210, 30, 0,
    30, 180, 210, 48, 170, 40, 210, 128, 80, 240, 120, 224, 210, 90, 40, 255,
    120, 30, 240, 0, 10, 130, 220, 64, 230, 80, 150, 160, 70, 210, 190, 255,
  ]
  const source = await page.evaluate(async (pixels) => {
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 3
    canvas.getContext('2d')!.putImageData(new ImageData(Uint8ClampedArray.from(pixels), 4, 3), 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) =>
      value === null ? reject(new Error('PNG encoding failed')) : resolve(value), 'image/png'))
    return [...new Uint8Array(await blob.arrayBuffer())]
  }, rgba)
  const uploaded = await request.post(`${NATIVE_BACKEND}/api/assets/media?scope=local&kind=media%2Fimage&name=layer-source.png`, {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(source),
  })
  expect([200, 201]).toContain(uploaded.status())
  const { asset } = await uploaded.json() as { asset: UploadedAsset }
  await openLayerGraph(page, asset)

  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      selectionExecutionScopes(tab: unknown, nodeIds: readonly string[]): { readonly upTo?: unknown } | undefined
    }
    const tab = app.activeTab()
    return tab !== undefined && app.selectionExecutionScopes(tab, ['flatten'])?.upTo !== undefined
  })).toBe(true)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      queueSelection(tab: unknown, nodeIds: readonly string[]): Promise<void>
    }
    await app.queueSelection(app.activeTab(), ['flatten'])
  })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status'))
    .toHaveText('Completed', { timeout: 30_000 })

  const documentRequest = page.waitForRequest((candidate) => {
    const url = new URL(candidate.url())
    return url.pathname === '/api/values' && url.searchParams.get('nodeId') === 'layers' &&
      url.searchParams.get('outputId') === 'layers' && url.searchParams.get('rendition') === 'document'
  })
  await page.getByRole('tab', { name: 'Outputs' }).click()
  await page.getByRole('button', { name: 'Open layers: layers / layers' }).click()
  const valueUrl = new URL((await documentRequest).url())
  const workspace = page.getByTestId('image-document-workspace')
  const authoritative = workspace.getByTestId('authoritative-image-document-render')
  await expect(authoritative).toContainText('composite')
  const renderedImage = authoritative.getByRole('img', { name: 'Authoritative ImageDocument output' })
  await expect(renderedImage).toBeVisible()
  await expect.poll(() => renderedImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(4)

  const query = new URLSearchParams({
    clientId: valueUrl.searchParams.get('clientId')!,
    jobId: valueUrl.searchParams.get('jobId')!,
    nodeId: 'flatten',
    outputId: 'image',
    rendition: 'png',
  })
  const flattened = await request.get(`${NATIVE_BACKEND}/api/values?${query}`)
  expect(flattened.ok()).toBe(true)
  const flattenedBytes = await flattened.body()
  const rendered = await request.get((await renderedImage.getAttribute('src'))!)
  expect(rendered.ok()).toBe(true)
  expect(await rendered.body()).toEqual(flattenedBytes)

  query.set('outputId', 'transparency_mask')
  const mask = await request.get(`${NATIVE_BACKEND}/api/values?${query}`)
  expect(mask.ok()).toBe(true)
  const compositePixels = await decodeRgba(page, flattenedBytes)
  const maskPixels = await decodeRgba(page, await mask.body())
  expect(maskPixels).toHaveLength(compositePixels.length)
  for (let index = 0; index < compositePixels.length / 4; index += 1) {
    expect(maskPixels[index * 4]).toBe(255 - compositePixels[index * 4 + 3]!)
  }

  const pngScreenshotPath = testInfo.outputPath('image-document-png-quality-disabled.png')
  await workspace.screenshot({ animations: 'disabled', path: pngScreenshotPath })
  await testInfo.attach('png-quality-disabled', { path: pngScreenshotPath, contentType: 'image/png' })

  await workspace.getByRole('spinbutton', { name: 'Crop x' }).fill('1')
  await workspace.getByRole('spinbutton', { name: 'Crop y' }).fill('1')
  await workspace.getByRole('spinbutton', { name: 'Crop width' }).fill('3')
  await workspace.getByRole('spinbutton', { name: 'Crop height' }).fill('2')
  await workspace.getByRole('button', { name: 'Apply crop' }).click()
  await workspace.getByRole('spinbutton', { name: 'Resize width' }).fill('6')
  await workspace.getByRole('spinbutton', { name: 'Resize height' }).fill('4')
  await workspace.getByRole('button', { name: 'Apply resize' }).click()
  await workspace.getByRole('combobox', { name: 'Output format' }).click()
  await page.getByRole('option', { name: 'WEBP' }).click()
  await workspace.getByRole('spinbutton', { name: 'Output quality' }).fill('73')
  await workspace.getByRole('spinbutton', { name: 'Output quality' }).press('Enter')
  await workspace.getByRole('button', { name: 'Render' }).click()
  await expect(authoritative).toContainText('6 x 4')
  await expect.poll(() => renderedImage.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(6)
  await workspace.getByRole('button', { name: 'Export editable recipe' }).click()
  await expect(page.getByTestId('status-bar')).toContainText('Exported editable image recipe')
  const recipe = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    const edit = Object.values(graph.nodes).find((node) => node.type === 'dinkster.layers.edit')!
    const save = Object.values(graph.nodes).find((node) => node.type === 'dinkster.save_image')!
    await app.queueSelection(tab, [save.id])
    return { editId: edit.id, saveId: save.id, saveValues: save.values }
  })
  expect(recipe.saveValues).toMatchObject({ format: 'webp', quality: 73 })
  await expect(page.getByTestId('execution-row')).toHaveCount(2)
  await expect(page.getByTestId('execution-row').first().locator('.execution-status'))
    .toHaveText('Completed', { timeout: 30_000 })
  const recipePrompt = await page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
    return executions.sort((left, right) => right.queuedAt - left.queuedAt)[0]!.ref.prompt
  })
  const editedQuery = new URLSearchParams({
    clientId: valueUrl.searchParams.get('clientId')!,
    jobId: recipePrompt,
    nodeId: recipe.editId,
    outputId: 'layers',
    rendition: 'document',
  })
  const assetOutput = await page.evaluate(({ prompt, saveId }) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((entry) => entry.ref.prompt === prompt)!
    return execution.outputs[saveId]?.assets
  }, { prompt: recipePrompt, saveId: recipe.saveId }) as {
    readonly typeId: string
    readonly elements: readonly [{
      readonly typeId: string
      readonly meta: UploadedAsset
    }]
  }
  expect(assetOutput.typeId).toBe('list<asset<dinkster.image>>')
  expect(assetOutput.elements).toHaveLength(1)
  const savedAsset = assetOutput.elements[0]!
  expect(savedAsset.typeId).toBe('asset<dinkster.image>')
  expect(savedAsset.meta).toEqual({
    digest: expect.stringMatching(/^blake3:[0-9a-f]{64}$/),
    name: expect.stringMatching(/^[^/]+\.webp$/),
    size: expect.any(Number),
    mediaType: 'image/webp',
    virtualPath: expect.stringMatching(/\.webp$/),
  })
  expect(savedAsset.meta.size).toBeGreaterThan(0)
  const savedResponse = await request.get(`${NATIVE_BACKEND}/api/assets/${encodeURIComponent(savedAsset.meta.digest)}`)
  expect(savedResponse.ok()).toBe(true)
  const savedBytes = await savedResponse.body()
  expect(savedBytes.byteLength).toBe(savedAsset.meta.size)
  expect(savedBytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
  expect(savedBytes.subarray(8, 12).toString('ascii')).toBe('WEBP')
  const savedImage = await decodeImage(page, savedBytes, savedAsset.meta.mediaType)
  expect(savedImage).toMatchObject({ width: 6, height: 4 })
  // A 2x nearest-neighbor layer transform samples fixture columns 1, 1, 2, 2, 3, 3
  // and rows 1, 1, 2, 2. The untransformed mask independently supplies alpha.
  const expectedPixels = [
    170, 40, 210, 255, 170, 40, 210, 192, 80, 240, 120, 96, 0, 0, 0, 0,
    210, 90, 40, 255, 210, 90, 40, 255,
    170, 40, 210, 48, 170, 40, 210, 128, 80, 240, 120, 224, 80, 240, 120, 255,
    210, 90, 40, 255, 210, 90, 40, 255,
    0, 0, 0, 0, 10, 130, 220, 64, 230, 80, 150, 160, 230, 80, 150, 255,
    70, 210, 190, 255, 70, 210, 190, 255,
    10, 130, 220, 255, 10, 130, 220, 255, 230, 80, 150, 255, 230, 80, 150, 255,
    70, 210, 190, 255, 70, 210, 190, 255,
  ]
  expect(savedImage.rgba).toHaveLength(expectedPixels.length)
  for (let index = 0; index < expectedPixels.length; index += 1) {
    expect(Math.abs(savedImage.rgba[index]! - expectedPixels[index]!)).toBeLessThanOrEqual(index % 4 === 3 ? 1 : 8)
  }

  const editedResponse = await request.get(`${NATIVE_BACKEND}/api/values?${editedQuery}`)
  expect(editedResponse.ok()).toBe(true)
  const editedDocument = await editedResponse.json() as {
    canvas: { width: number; height: number }
    layers: Record<string, { transform: Record<string, number> }>
  }
  expect(editedDocument.canvas).toMatchObject({ width: 6, height: 4 })
  expect(editedDocument.layers.l1?.transform).toMatchObject({
    a: 2_000_000, d: 2_000_000, tx: -2_000_000, ty: -2_000_000,
  })

  const screenshotPath = testInfo.outputPath('image-document-webp-output.png')
  await workspace.screenshot({ animations: 'disabled', path: screenshotPath })
  await testInfo.attach('live-graph-layer-workspace', { path: screenshotPath, contentType: 'image/png' })
})
