import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { expect, test, type Page, type Request } from '@playwright/test'

interface AssetRef {
  digest: string
  name: string
  size: number
  mediaType: string
  virtualPath: string
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, checksum])
}

/** Deterministic valid 512x512 RGB PNG whose stored IDAT is greater than 256 KiB. */
function largePng(): Buffer {
  const width = 512
  const height = 512
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((width * 3 + 1) * height)
  let state = 0x1322b00b
  for (let row = 0; row < height; row += 1) {
    const start = row * (width * 3 + 1)
    raw[start] = 0
    for (let index = start + 1; index < start + width * 3 + 1; index += 1) {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      raw[index] = state & 0xff
    }
  }
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 0 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  if (png.length <= 256 * 1024) throw new Error(`proof PNG is only ${png.length} bytes`)
  return png
}

async function recordOriginalInPage(page: Page, bytes: Buffer): Promise<{ length: number; sha256: string }> {
  return page.evaluate(async (numbers) => {
    const original = Uint8Array.from(numbers)
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', original))
    const record = { length: original.byteLength, sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('') }
    ;(window as unknown as { __imageByteProof: typeof record }).__imageByteProof = record
    return record
  }, [...bytes])
}

function waitForUpload(page: Page, path: '/api/assets/media' | '/api/assets'): Promise<Request> {
  return page.waitForRequest((request) =>
    request.method() === 'POST' && new URL(request.url()).pathname === path)
}

async function assertUploadAndVault(
  page: Page,
  request: Request,
  bytes: Buffer,
  expectedPageRecord: { length: number; sha256: string },
): Promise<string> {
  expect(await request.headerValue('content-type')).toBe(
    new URL(request.url()).pathname === '/api/assets/media' ? 'image/png' : 'application/octet-stream',
  )
  const response = await request.response()
  expect(response).not.toBeNull()
  expect([200, 201]).toContain(response!.status())
  const payload = await response!.json() as { asset?: AssetRef; digest?: string }
  const digest = payload.asset?.digest ?? payload.digest
  expect(digest).toMatch(/^blake3:[0-9a-f]{64}$/)
  const fetched = await page.evaluate(async (digest) => {
    const response = await fetch(`/api/assets/${encodeURIComponent(digest)}`)
    if (!response.ok) throw new Error(`GET asset failed: ${response.status}`)
    const body = new Uint8Array(await response.arrayBuffer())
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', body))
    return { length: body.byteLength, sha256: [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join(''), bytes: [...body] }
  }, digest!)
  expect(fetched.length).toBe(bytes.length)
  expect(fetched.sha256).toBe(expectedPageRecord.sha256)
  expect(Buffer.from(fetched.bytes)).toEqual(bytes)
  return digest!
}

async function openDocument(page: Page, lineage: string, includeOutput: boolean, includeLoad = true): Promise<void> {
  await page.evaluate(({ lineage, includeOutput, includeLoad }) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage, root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          ...(includeLoad ? { load: { id: 'load', type: 'dinkster.load_image', values: { image: null } } } : {}),
          ...(includeOutput ? { output: { id: 'output', type: 'dinkster.save_image', values: {} } } : {}),
        },
        links: includeOutput && includeLoad
          ? { image: { id: 'image', from: { node: 'load', port: 'image' }, to: { node: 'output', port: 'images' } } }
          : {},
        nets: {}, reroutes: {}, nextOrdinal: 1 + Number(includeLoad) + Number(includeOutput),
      } },
      view: { graphs: { g0: { nodes: {
        ...(includeLoad ? { load: { position: { x: 100, y: 100 } } } : {}),
        ...(includeOutput ? { output: { position: { x: 500, y: 100 } } } : {}),
      } } } },
    } as never, 'Image byte proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { lineage, includeOutput, includeLoad })
}

async function openLoadImageAssetEditor(page: Page): Promise<void> {
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'load')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'image')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

async function assetRef(page: Page): Promise<AssetRef> {
  return page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    const load = Object.values(graph.nodes).find((node) => node.type === 'dinkster.load_image')!
    return load.values.image as unknown as AssetRef
  })
}

async function assertExportReopen(page: Page): Promise<void> {
  const before = await assetRef(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)
    if (exported === undefined) throw new Error('image byte proof export failed')
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Reopened image byte proof')
  })
  expect(await assetRef(page)).toEqual(before)
}

async function connectOutputAndRun(page: Page): Promise<void> {
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const reopened = JSON.parse(JSON.stringify(tab.store.doc))
    const graph = reopened.graphs[reopened.root]
    const load = (Object.values(graph.nodes) as Array<{ id: string; type: string }>)
      .find((node) => node.type === 'dinkster.load_image')!
    graph.nodes.output = { id: 'output', type: 'dinkster.save_image', values: {} }
    graph.links.image = { id: 'image', from: { node: load.id, port: 'image' }, to: { node: 'output', port: 'images' } }
    graph.nextOrdinal += 1
    reopened.view.graphs[reopened.root].nodes.output = { position: { x: 500, y: 100 } }
    window.__dinksterTest!.app.openDocument(reopened, 'Runnable image byte proof')
  })
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  await expect(row.locator('.execution-status')).not.toContainText(/error|failed/i)
}

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND so Vite serves the live native catalog on the same origin')
  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/)
  const required = await page.evaluate(() => {
    const schemas = window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas
    return schemas?.has('dinkster.load_image') === true && schemas.has('dinkster.save_image')
  })
  test.skip(!required, 'same-origin live catalog lacks dinkster.load_image or dinkster.save_image')
})

test('real ASSET Upload preserves a greater-than-256-KiB PNG through graph, vault, reopen, and execution', async ({ page }) => {
  const png = largePng()
  const sha256 = createHash('sha256').update(png).digest('hex')
  const pageRecord = await recordOriginalInPage(page, png)
  expect(pageRecord).toEqual({ length: png.length, sha256 })
  await openDocument(page, 'widget-image-byte-proof', false)
  await openLoadImageAssetEditor(page)
  const upload = waitForUpload(page, '/api/assets/media')
  await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles({
    name: 'widget-byte-proof.png', mimeType: 'image/png', buffer: png,
  })
  const request = await upload
  const digest = await assertUploadAndVault(page, request, png, pageRecord)
  const editor = page.getByTestId('asset-editor')
  await expect(editor).toBeVisible()
  await expect(editor.getByTestId('asset-upload-trigger')).toBeFocused()
  await editor.getByTestId('asset-apply').click()
  await expect(editor).not.toBeVisible()
  expect(await assetRef(page)).toEqual({
    digest, name: 'widget-byte-proof.png', size: png.length, mediaType: 'image/png', virtualPath: '',
  })
  await assertExportReopen(page)
  await connectOutputAndRun(page)
})

test('real canvas image drop preserves a greater-than-256-KiB PNG through graph, vault, reopen, and execution', async ({ page }) => {
  const png = largePng()
  const sha256 = createHash('sha256').update(png).digest('hex')
  const pageRecord = await recordOriginalInPage(page, png)
  expect(pageRecord).toEqual({ length: png.length, sha256 })
  await openDocument(page, 'canvas-image-byte-proof', false, false)
  const upload = waitForUpload(page, '/api/assets')
  await page.getByTestId('graph-canvas').evaluate((canvas, numbers) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File([Uint8Array.from(numbers)], 'private-canvas-name.png', { type: 'image/png' }))
    canvas.dispatchEvent(new DragEvent('drop', {
      bubbles: true, cancelable: true, clientX: 420, clientY: 320, dataTransfer: transfer,
    }))
  }, [...png])
  const request = await upload
  const digest = await assertUploadAndVault(page, request, png, pageRecord)
  await expect.poll(() => assetRef(page)).toEqual({
    digest, name: 'dropped-image.png', size: png.length, mediaType: 'image/png', virtualPath: '',
  })
  await assertExportReopen(page)
  await connectOutputAndRun(page)
})
