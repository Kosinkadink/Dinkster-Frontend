import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

interface UploadedAsset {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

interface SubmittedJob {
  readonly clientId: string
  readonly jobId: string
  readonly graph: { readonly nodes: Readonly<Record<string, unknown>> }
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

async function openEditor(page: Page, nodeId: string, action: 'Apply mask to graph' | 'Bake to asset'): Promise<void> {
  await page.evaluate((id) => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): unknown
      openImageEditor(target: unknown): boolean
    }
    const target = app.imageTargetForInput(app.activeTab(), 'g0', id, 'image')
    if (!target || !app.openImageEditor(target)) throw new Error(`image editor refused ${id}`)
  }, nodeId)
  await expect(page.getByTestId('image-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: action })).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByText('Loading source image...')).toBeHidden({ timeout: 15_000 })
}

async function paintStroke(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('[data-testid=image-canvas-viewport]')!
    const surface = document.querySelector<HTMLCanvasElement>('[data-testid=image-mask-surface]')!
    const rect = surface.getBoundingClientRect()
    const dispatch = (type: string, x: number, y: number, buttons: number) => viewport.dispatchEvent(new PointerEvent(type, {
      pointerId: 71,
      pointerType: 'pen',
      clientX: rect.left + rect.width * x,
      clientY: rect.top + rect.height * y,
      pressure: buttons === 0 ? 0 : 0.75,
      button: type === 'pointermove' ? -1 : 0,
      buttons,
      bubbles: true,
      cancelable: true,
    }))
    dispatch('pointerdown', 0.25, 0.35, 1)
    dispatch('pointermove', 0.4, 0.5, 1)
    dispatch('pointermove', 0.55, 0.65, 1)
    dispatch('pointerup', 0.55, 0.65, 0)
    if (viewport.hasPointerCapture(71)) viewport.releasePointerCapture(71)
  })
  await expect(page.getByRole('button', { name: 'Undo mask edit' })).toBeEnabled()
  await expect.poll(() => page.getByTestId('image-mask-surface').evaluate((canvas: HTMLCanvasElement) => {
    const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] !== 0) return true
    return false
  })).toBe(true)
}

async function zoomEditorForEvidence(page: Page): Promise<void> {
  await page.getByTestId('image-canvas-viewport').evaluate((viewport) => {
    const rect = viewport.getBoundingClientRect()
    viewport.dispatchEvent(new WheelEvent('wheel', {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      deltaY: -2_000,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
  })
  await expect(page.getByTestId('image-editor').getByText('400%')).toBeVisible()
}

async function queueFlatten(page: Page): Promise<SubmittedJob> {
  let submitted: SubmittedJob | undefined
  const listener = (request: import('@playwright/test').Request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
      submitted = request.postDataJSON() as SubmittedJob
    }
  }
  page.on('request', listener)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queueSelection(app.activeTab()!, ['flatten'])
  })
  await expect(page.getByTestId('execution-row').first().locator('.execution-status'))
    .toHaveText('Completed', { timeout: 30_000 })
  page.off('request', listener)
  if (!submitted) throw new Error('flatten execution was not submitted')
  return submitted
}

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')
  let nodes: Record<string, unknown> | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(3_000) })
    if (response.ok) nodes = (await response.json() as { nodes?: Record<string, unknown> }).nodes
  } catch { /* skip below */ }
  test.skip(nodes === undefined, `no native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  test.skip(!['dinkster.load_image', 'dinkster.mask.paint', 'dinkster.layers.add', 'dinkster.layers.flatten']
    .every((id) => id in nodes!), 'native backend lacks the graph mask and layer nodes required by this acceptance')
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 15_000 })
})

test('graph mask edits execute visibly and match an explicit baked asset', async ({ page, request }, testInfo) => {
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 24
    const nonce = crypto.getRandomValues(new Uint32Array(1))[0]!
    const rgba = new Uint8ClampedArray(canvas.width * canvas.height * 4)
    for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
      const index = (y * canvas.width + x) * 4
      rgba[index] = x < canvas.width / 2 ? 220 : 24
      rgba[index + 1] = y < canvas.height / 2 ? 180 : 36
      rgba[index + 2] = y === 0 && x < 4
        ? (nonce >>> (x * 8)) & 0xff
        : ((Math.floor(x / 4) + Math.floor(y / 4)) & 1) === 0 ? 224 : 32
      rgba[index + 3] = 96 + ((x * 5 + y * 7) % 160)
    }
    canvas.getContext('2d')!.putImageData(new ImageData(rgba, canvas.width, canvas.height), 0, 0)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) =>
      value ? resolve(value) : reject(new Error('PNG encoding failed')), 'image/png'))
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  const upload = await request.post(`${NATIVE_BACKEND}/api/assets/media?scope=local&kind=media%2Fimage&name=mask-source.png`, {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(png),
  })
  expect([200, 201]).toContain(upload.status())
  const { asset } = await upload.json() as { asset: UploadedAsset }

  await page.evaluate((source) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'live-graph-mask', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          graphLoad: { id: 'graphLoad', type: 'dinkster.load_image', values: { image: source } },
          bakeLoad: { id: 'bakeLoad', type: 'dinkster.load_image', values: { image: source } },
          layers: { id: 'layers', type: 'dinkster.layers.add', values: { name: 'Edited transparency' } },
          flatten: { id: 'flatten', type: 'dinkster.layers.flatten', values: { selector: 'composite' } },
        },
        links: {
          image: { id: 'image', from: { node: 'graphLoad', port: 'image' }, to: { node: 'layers', port: 'image' } },
          mask: { id: 'mask', from: { node: 'graphLoad', port: 'mask' }, to: { node: 'layers', port: 'mask' } },
          document: { id: 'document', from: { node: 'layers', port: 'layers' }, to: { node: 'flatten', port: 'layers' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 5,
      } },
      view: { graphs: { g0: { nodes: {
        graphLoad: { position: { x: 60, y: 100 } }, bakeLoad: { position: { x: 60, y: 500 } },
        layers: { position: { x: 430, y: 100 } }, flatten: { position: { x: 800, y: 100 } },
      } } } },
    } as never, 'Live Graph Mask')
  }, asset)
  await page.waitForFunction(() => window.__dinksterTest!.app.activeTab()?.id === 'live-graph-mask')

  await openEditor(page, 'graphLoad', 'Apply mask to graph')
  await zoomEditorForEvidence(page)
  await paintStroke(page)
  const graphEditorScreenshot = await page.getByTestId('image-editor').screenshot({ animations: 'disabled' })
  await testInfo.attach('graph-mask-editor', { body: graphEditorScreenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-400'), { recursive: true })
    writeFileSync(evidencePath('issue-400', 'graph-mask-editor.png'), graphEditorScreenshot)
  }
  const graphMaskDetail = await page.locator('.image-canvas-stack').screenshot({ animations: 'disabled' })
  await testInfo.attach('graph-mask-detail', { body: graphMaskDetail, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    writeFileSync(evidencePath('issue-400', 'graph-mask-detail.png'), graphMaskDetail)
  }
  await page.getByRole('button', { name: 'Clear' }).click()
  await paintStroke(page)
  await page.getByRole('button', { name: 'Apply mask to graph' }).click()
  await expect(page.getByTestId('image-editor')).toBeHidden()
  await page.waitForFunction(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes)
    .some((node) => node.type === 'dinkster.mask.paint'))
  const graphState = await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    const paint = Object.values(graph.nodes).find((node) => node.type === 'dinkster.mask.paint')!
    return { paint, maskLink: graph.links.mask, source: graph.nodes.graphLoad!.values.image }
  })
  expect(graphState.source).toEqual(asset)
  expect(graphState.maskLink?.from).toEqual({ node: graphState.paint.id, port: 'mask' })
  const commands = JSON.parse(graphState.paint.values.operations as string).commands as Record<string, unknown>[]
  expect(commands.at(-2)).toEqual({ op: 'clear' })
  expect(commands.at(-1)).toMatchObject({ op: 'stroke', mode: 'paint' })

  await openEditor(page, 'bakeLoad', 'Bake to asset')
  await paintStroke(page)
  await testInfo.attach('explicit-bake-before-apply', {
    body: await page.getByTestId('image-editor').screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  await page.getByRole('button', { name: 'Clear' }).click()
  await paintStroke(page)
  await page.getByRole('button', { name: 'Bake to asset' }).click()
  await expect(page.getByTestId('image-editor')).toBeHidden({ timeout: 15_000 })
  const baked = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.bakeLoad!.values.image) as UploadedAsset
  expect(baked.digest).not.toBe(asset.digest)

  const submitted = await queueFlatten(page)
  expect(submitted.graph.nodes).toHaveProperty(graphState.paint.id)
  const completed = await request.get(
    `${NATIVE_BACKEND}/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`,
  )
  expect(completed.ok()).toBe(true)
  const receipt = await completed.json() as { readonly state: string; readonly executed: readonly string[] }
  expect(receipt.state).toBe('completed')
  expect(receipt.executed).toEqual(expect.arrayContaining(['graphLoad', graphState.paint.id, 'layers', 'flatten']))

  const valueQuery = (nodeId: string, outputId: string) => new URLSearchParams({
    clientId: submitted.clientId, jobId: submitted.jobId, nodeId, outputId, rendition: 'png',
  })
  const [paintMaskResponse, flattenResponse, transparencyResponse, bakedResponse] = await Promise.all([
    request.get(`${NATIVE_BACKEND}/api/values?${valueQuery(graphState.paint.id, 'mask')}`),
    request.get(`${NATIVE_BACKEND}/api/values?${valueQuery('flatten', 'image')}`),
    request.get(`${NATIVE_BACKEND}/api/values?${valueQuery('flatten', 'transparency_mask')}`),
    request.get(`${NATIVE_BACKEND}/api/assets/${encodeURIComponent(baked.digest)}`),
  ])
  for (const response of [paintMaskResponse, flattenResponse, transparencyResponse, bakedResponse]) expect(response.ok()).toBe(true)
  const [paintMask, flattened, transparency, bakedBytes] = await Promise.all([
    paintMaskResponse.body(), flattenResponse.body(), transparencyResponse.body(), bakedResponse.body(),
  ])
  const [paintPixels, flattenedPixels, transparencyPixels, bakedPixels] = await Promise.all([
    decodeRgba(page, paintMask), decodeRgba(page, flattened), decodeRgba(page, transparency), decodeRgba(page, bakedBytes),
  ])
  expect(paintPixels).toHaveLength(bakedPixels.length)
  expect(flattenedPixels).toHaveLength(bakedPixels.length)
  for (let index = 0; index < bakedPixels.length / 4; index += 1) {
    const transparencySample = 255 - bakedPixels[index * 4 + 3]!
    expect(paintPixels[index * 4]).toBe(transparencySample)
    expect(transparencyPixels[index * 4]).toBe(transparencySample)
    expect(flattenedPixels[index * 4 + 3]).toBe(bakedPixels[index * 4 + 3])
  }

  const documentRequest = page.waitForRequest((candidate) => {
    const url = new URL(candidate.url())
    return url.pathname === '/api/values' && url.searchParams.get('nodeId') === 'layers' &&
      url.searchParams.get('outputId') === 'layers' && url.searchParams.get('rendition') === 'document'
  })
  await page.getByRole('tab', { name: 'Outputs' }).click()
  await page.getByRole('button', { name: 'Open layers: layers / layers' }).click()
  await documentRequest
  const workspace = page.getByTestId('image-document-workspace')
  const rendered = workspace.getByRole('img', { name: 'Authoritative ImageDocument output' })
  await expect(rendered).toBeVisible()
  const renderedResponse = await request.get((await rendered.getAttribute('src'))!)
  expect(renderedResponse.ok()).toBe(true)
  expect(await renderedResponse.body()).toEqual(flattened)
  const workspaceScreenshot = await workspace.screenshot({ animations: 'disabled' })
  await testInfo.attach('graph-mask-authoritative-document', { body: workspaceScreenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-400'), { recursive: true })
    writeFileSync(evidencePath('issue-400', 'graph-mask-authoritative-document.png'), workspaceScreenshot)
  }
  await testInfo.attach('graph-mask-live-receipts', {
    body: JSON.stringify({ backend: NATIVE_BACKEND, submitted, receipt, paintNode: graphState.paint, baked }, null, 2),
    contentType: 'application/json',
  })
})
