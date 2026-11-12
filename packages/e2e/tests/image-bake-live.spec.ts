import { expect, test, type Page } from '@playwright/test'
import { waitForStartupOwnership } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

interface UploadedAsset {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
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

test('image editor bakes a cleared mask through real asset upload and read routes', async ({ page, request }, testInfo) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText('connected', { timeout: 15_000 })
  await waitForStartupOwnership(page)
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
  const upload = await request.post(`${NATIVE_BACKEND}/api/assets`, {
    headers: { 'Content-Type': 'image/png' },
    data: Buffer.from(png),
  })
  expect([200, 201]).toContain(upload.status())
  const { digest } = await upload.json() as { digest: string }
  const asset: UploadedAsset = { digest, name: 'mask-source.png', size: png.length, mediaType: 'image/png', virtualPath: '' }

  const diagnostics = await page.evaluate(async (source) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'BakeImageFixture', displayName: 'Bake image fixture', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'image', optional: false,
        type: { kind: 'asset', element: { kind: 'concrete', name: 'IMAGE' } },
        widget: { widgetType: 'ASSET', kind: 'image', options: { accept: ['image/png'] } },
      }],
    }] as never)
    return await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'live-image-bake', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { loader: { id: 'loader', type: 'BakeImageFixture', values: { image: source } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { loader: { position: { x: 60, y: 100 } } } } } },
    } as never, 'Live image bake')
  }, asset)
  expect(diagnostics).toEqual([])
  await page.waitForFunction(() => window.__dinksterTest!.app.activeTab()?.id === 'live-image-bake')
  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): unknown
      openImageEditor(target: unknown): boolean
    }
    const target = app.imageTargetForInput(app.activeTab(), 'g0', 'loader', 'image')
    return target ? app.openImageEditor(target) : false
  })).toBe(true)
  await expect(page.getByRole('button', { name: 'Bake to asset' })).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Apply mask to graph' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear' }).click()
  await expect(page.getByRole('button', { name: 'Undo mask edit' })).toBeEnabled()
  await testInfo.attach('bake-before-apply', {
    body: await page.getByTestId('image-editor').screenshot({ path: testInfo.outputPath('bake-before-apply.png'), animations: 'disabled' }), contentType: 'image/png',
  })
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByRole('button', { name: 'Bake to asset' }).click()
  await expect(page.getByTestId('image-editor')).toBeHidden({ timeout: 15_000 })
  const baked = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.loader!.values.image) as UploadedAsset
  expect(baked.digest).not.toBe(asset.digest)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)
  const response = await request.get(`${NATIVE_BACKEND}/api/assets/${encodeURIComponent(baked.digest)}`)
  expect(response.ok()).toBe(true)
  const [sourcePixels, bakedPixels] = await Promise.all([
    decodeRgba(page, Buffer.from(png)), decodeRgba(page, await response.body()),
  ])
  expect(bakedPixels).toHaveLength(sourcePixels.length)
  for (let index = 0; index < bakedPixels.length; index += 4) {
    expect(bakedPixels.slice(index, index + 3)).toEqual(sourcePixels.slice(index, index + 3))
    expect(bakedPixels[index + 3]).toBe(255)
  }
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.loader!.values.image)).toEqual(asset)
})
