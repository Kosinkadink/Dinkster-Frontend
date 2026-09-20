/**
 * Mid-graph tensor preview against a REAL Dinkster backend: upload a png asset,
 * execute dinkster.load_image -> comfy.PreviewImage, and prove the load node's
 * non-asset comfy.IMAGE output is fetched through /api/values rendition
 * negotiation and decoded into an on-canvas preview at its true dimensions.
 *
 * Unlike native-imagery-live.spec.ts, no save node turns the intermediate
 * tensor into an ASSET output. The only persisted asset is the input literal.
 * Skips loudly if the shared backend is absent or lacks the catalog nodes.
 */
import { deflateSync } from 'node:zlib'
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

/** Deterministic 64x48 solid-red png, built raw (no canvas, no deps). */
function tinyPng(): Buffer {
  const crc = (buf: Buffer): number => {
    let c = ~0
    for (const byte of buf) {
      c ^= byte
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
    }
    return ~c >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const [w, h] = [64, 48]
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(2, 9)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([200, 60, 30]))])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

async function addNativeBackend(page: Page): Promise<void> {
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(NATIVE_BACKEND)
  await page.getByTestId('backend-add').click()
  await expect(page.getByTestId('tab-target')).toBeVisible()
}

async function openMidgraphDoc(page: Page, asset: { digest: string; size: number }): Promise<void> {
  await page.evaluate(({ digest, size }) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'midgraph-preview-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          li: { id: 'li', type: 'dinkster.load_image', values: { image: { digest, name: 'e2e.png', size, mediaType: 'image/png' } } },
          pi: { id: 'pi', type: 'comfy.SaveImage', values: {} },
        },
        links: { l1: { id: 'l1', from: { node: 'li', port: 'image' }, to: { node: 'pi', port: 'images' } } },
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: { li: { position: { x: 80, y: 120 } }, pi: { position: { x: 420, y: 120 } } } } } },
    } as never, 'Mid-graph Tensor Preview')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, asset)
  await selectProductOption(page, page.getByTestId('tab-target'), NATIVE_BACKEND)
}

test.beforeEach(async ({ page }) => {
  let served: Record<string, unknown> | null = null
  try {
    const probe = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    if (probe.ok) served = (await probe.json() as { nodes?: Record<string, unknown> }).nodes ?? {}
  } catch { /* unreachable -> served stays null */ }
  test.skip(served === null, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
  test.skip(!(served !== null && 'dinkster.load_image' in served && 'comfy.SaveImage' in served),
    `native backend at ${NATIVE_BACKEND} lacks dinkster.load_image/comfy.SaveImage - compose the comfy pack (--comfy-root)`)

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await addNativeBackend(page)
})

test('a mid-graph comfy.IMAGE rendition decodes real pixels into the producer node preview', async ({ page, request }) => {
  const png = tinyPng()
  const uploaded = await request.post(`${NATIVE_BACKEND}/api/assets`, {
    headers: { 'Content-Type': 'application/octet-stream' },
    data: png,
  })
  expect([200, 201]).toContain(uploaded.status())
  const { digest } = (await uploaded.json()) as { digest: string }
  expect(digest).toMatch(/^blake3:[0-9a-f]{64}$/)

  await openMidgraphDoc(page, { digest, size: png.length })
  const valueRequests: string[] = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/values') valueRequests.push(req.url())
  })
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })

  const outputType = await page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
    const latest = executions.sort((a, b) => b.queuedAt - a.queuedAt)[0] as unknown as {
      nodes?: Record<string, { outputs?: Record<string, { typeId?: string }> }>
    }
    return latest.nodes?.['li']?.outputs?.['image']?.typeId
  })
  expect(outputType).toBe('comfy.IMAGE')

  await expect
    .poll(
      () => page.evaluate(() => {
        const preview = window.__dinksterTest!.renderer!.getNodePreviews()['li']
        return preview ? { width: preview.width, height: preview.height } : undefined
      }),
      { timeout: 15_000 },
    )
    .toEqual({ width: 64, height: 48 })

  const producerRequests = valueRequests
    .map((url) => new URL(url))
    .filter((url) => url.searchParams.get('nodeId') === 'li' && url.searchParams.get('outputId') === 'image')
  const peekAt = producerRequests.findIndex((url) => !url.searchParams.has('rendition'))
  const renditionAt = producerRequests.findIndex((url) => url.searchParams.get('rendition') === 'png')
  expect(peekAt).toBeGreaterThanOrEqual(0)
  expect(renditionAt).toBeGreaterThan(peekAt)
})
