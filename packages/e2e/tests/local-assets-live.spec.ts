import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const nativeFrontend = process.env['DINKSTER_E2E_NATIVE_FRONTEND']
if (!nativeFrontend) throw new Error('Native frontend is required')
test.use({ baseURL: nativeFrontend })

async function openPicker(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((entry) => entry.id === 'asset')?.layout.rows.some((entry) => entry.kind === 'widget' && entry.inputId === 'file'))).toBe(true)
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'asset')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'file')!
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: bounds.left + node.x + node.layout.width / 2, y: bounds.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

for (const fixture of [
  { name: 'catalog-image.png', mime: 'image/png', kind: 'media/image', path: 'with_metadata.png' },
  { name: 'catalog-video.webm', mime: 'video/webm', kind: 'media/video' },
  { name: 'catalog-model.safetensors', mime: 'application/octet-stream', kind: 'asset/file' },
] as const) {
  test(`uploaded ${fixture.kind} remains searchable and byte-exact in dock and picker`, async ({ page, request }, info) => {
    const name = fixture.name.replace('catalog-', `catalog-${Date.now()}-`)
    const header = Buffer.from(JSON.stringify({ weight: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }))
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(header.length))
    let bytes = 'path' in fixture
      ? await readFile(new URL(`../fixtures/media-overlay/${fixture.path}`, import.meta.url))
      : Buffer.concat([length, header, Buffer.alloc(4)])
    await page.goto('/')
    if (fixture.kind === 'media/video') {
      bytes = Buffer.from(await page.evaluate(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 32
        canvas.height = 32
        const stream = canvas.captureStream(10)
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
        const chunks: Blob[] = []
        recorder.ondataavailable = (event) => chunks.push(event.data)
        const complete = new Promise<void>((resolve) => { recorder.onstop = () => resolve() })
        recorder.start()
        canvas.getContext('2d')!.fillRect(0, 0, 32, 32)
        await new Promise((resolve) => setTimeout(resolve, 300))
        recorder.stop()
        await complete
        stream.getTracks().forEach((track) => track.stop())
        return [...new Uint8Array(await new Blob(chunks).arrayBuffer())]
      }))
    }
    await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.protocol)).toBe('dinkster')
    await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/)
    await page.evaluate(({ kind, mime }) => {
      const app = window.__dinksterTest!.app
      app.registerSchemas([{
        type: 'LocalCatalogProof', displayName: 'Local catalog proof', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'file', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
          widget: { widgetType: 'ASSET', kind, options: { accept: [mime] }, default: null } }],
      }])
      app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'local-catalog-proof', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'root', nodes: { asset: { id: 'asset', type: 'LocalCatalogProof', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
        view: { graphs: { g0: { nodes: { asset: { position: { x: 100, y: 100 } } } } } },
      } as never, 'Local catalog proof')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    }, fixture)
    await openPicker(page)
    const editor = page.getByTestId('asset-editor')
    const uploaded = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/api/assets'))
    await editor.locator('input[type=file]').setInputFiles({ name, mimeType: fixture.mime, buffer: bytes })
    const response = await uploaded
    expect(response.status(), await response.text()).toBe(201)
    const { asset } = await response.json() as { asset: { digest: string; name: string; virtualPath: string } }
    expect(asset.virtualPath).toMatch(/^mounts\/imports\//)
    await expect(editor).toContainText(asset.virtualPath)
    await editor.getByTestId('asset-apply').click()
    await expect(editor).toHaveCount(0)
    const saved = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['asset']!.values['file'])
    expect(saved).toEqual(asset)
    const fetched = await request.get(`${process.env['DINKSTER_NATIVE_BACKEND']}/api/assets/${encodeURIComponent(asset.digest)}`)
    expect(fetched.ok()).toBe(true)
    expect(createHash('sha256').update(await fetched.body()).digest('hex')).toBe(createHash('sha256').update(bytes).digest('hex'))
    await page.getByTestId('assets-toggle').click()
    const dock = page.getByTestId('assets-overlay')
    await dock.getByTestId('collection-search').fill(name)
    await expect(dock.getByTestId('collection-entry').filter({ hasText: name })).toHaveCount(1)
    await page.getByTestId('assets-toggle').click()
    await openPicker(page)
    await editor.getByTestId('collection-search').fill(name)
    await expect(editor.getByTestId('collection-entry').filter({ hasText: name })).toHaveCount(1)
    await page.screenshot({ path: info.outputPath(`${fixture.kind.replace('/', '-')}-catalog.png`) })
  })
}
