/**
 * Native imagery end to end against a REAL Dinkster backend: upload a png
 * asset (POST /api/assets/media), execute dinkster.load_image -> dinkster.save_image,
 * and prove ACTUAL DECODED PIXELS land in both imagery surfaces:
 *
 * - the outputs panel <img> resolves the produced asset by CAS digest
 *   through /api/assets/{digest} and decodes (naturalWidth > 0, not
 *   merely a URL);
 * - the on-canvas node preview panel decodes the same digest at the true
 *   image dimensions (renderer.getNodePreviews()).
 *
 * This is the native counterpart of previews-remote.spec.ts's v1 output-
 * thumbnail proof: v1 imagery rides /view file refs; native imagery rides
 * output value descriptors carrying asset digests. This file intentionally
 * uses native same-origin startup so browser requests and event sockets both
 * exercise Vite's DINKSTER_NATIVE_BACKEND proxy without requiring backend CORS.
 *
 * Skips loudly without a reachable native backend (DINKSTER_NATIVE_BACKEND,
 * default http://127.0.0.1:8765) serving the comfy pack ports.
 */
import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'

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
  ihdr.writeUInt8(8, 8) // bit depth
  ihdr.writeUInt8(2, 9) // color type rgb
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, Buffer.from([200, 60, 30]))])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Two disjoint load_image -> save_image branches referencing one uploaded asset. */
interface UploadedAsset {
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly virtualPath: string
}

async function openImageryDoc(page: Page, asset: UploadedAsset): Promise<void> {
  await page.evaluate((asset) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'native-imagery-e2e', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          li: { id: 'li', type: 'dinkster.load_image', values: { image: asset } },
          si: { id: 'si', type: 'dinkster.save_image', values: {} },
          li2: { id: 'li2', type: 'dinkster.load_image', values: { image: asset } },
          si2: { id: 'si2', type: 'dinkster.save_image', values: {} },
        },
        links: {
          l1: { id: 'l1', from: { node: 'li', port: 'image' }, to: { node: 'si', port: 'images' } },
          l2: { id: 'l2', from: { node: 'li2', port: 'image' }, to: { node: 'si2', port: 'images' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 5,
      } },
      view: { graphs: { g0: { nodes: {
        li: { position: { x: 80, y: 120 } }, si: { position: { x: 420, y: 120 } },
        li2: { position: { x: 80, y: 520 } }, si2: { position: { x: 420, y: 520 } },
      } } } },
    } as never, 'Native Imagery')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, asset)
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.id === 'native-imagery-e2e' && 'status' in tab.store
  })
}

async function openNumericBranches(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'native-partial-values-e2e', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          source1: { id: 'source1', type: 'dinkster.string.length', values: { text: 'one' } },
          sink1: { id: 'sink1', type: 'dinkster.int', values: { value: 8 } },
          source2: { id: 'source2', type: 'dinkster.string.length', values: { text: 'three' } },
          sink2: { id: 'sink2', type: 'dinkster.int', values: { value: 9 } },
        },
        links: {
          branch1: { id: 'branch1', from: { node: 'source1', port: 'length' }, to: { node: 'sink1', port: 'value' } },
          branch2: { id: 'branch2', from: { node: 'source2', port: 'length' }, to: { node: 'sink2', port: 'value' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 5,
      } },
      view: { graphs: { g0: { nodes: {
        source1: { position: { x: 80, y: 120 } }, sink1: { position: { x: 380, y: 120 } },
        source2: { position: { x: 80, y: 420 } }, sink2: { position: { x: 380, y: 420 } },
      } } } },
    } as never, 'Native Partial Values')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.id === 'native-partial-values-e2e' && 'status' in tab.store
  })
}

async function queueSelection(page: Page, nodeIds: readonly string[]): Promise<void> {
  await page.evaluate(async (ids) => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      queueSelection(tab: unknown, nodeIds: readonly string[]): Promise<void>
    }
    await app.queueSelection(app.activeTab(), ids)
  }, nodeIds)
  await expect(page.getByTestId('execution-row').first().locator('.execution-status'))
    .toHaveText('Completed', { timeout: 30_000 })
}

test.beforeEach(async ({ page }) => {
  // Probe outside the skip calls: test.skip signals by throwing, so a skip
  // raised inside the try would be swallowed and remapped to 'unreachable'.
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND so the Vite same-origin proxy targets this native backend')
  let served: Record<string, unknown> | null = null
  try {
    const probe = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    if (probe.ok) served = (await probe.json() as { nodes?: Record<string, unknown> }).nodes ?? {}
  } catch { /* unreachable -> served stays null */ }
  test.skip(served === null, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
  test.skip(!(served !== null && 'dinkster.load_image' in served && 'dinkster.save_image' in served),
    `native backend at ${NATIVE_BACKEND} lacks dinkster.load_image/save_image - compose the comfy pack (--comfy-root)`)

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText('connected')
})

test('a disjoint native partial run retains only the omitted numeric branch as last resolved', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await openNumericBranches(page)

  await queueSelection(page, ['sink1', 'sink2'])
  const companions = () => page.evaluate(() => structuredClone(
    (window.__dinksterTest!.renderer as unknown as { companions: unknown }).companions,
  ))
  await expect.poll(companions).toEqual({
    sink1: { value: { value: 3 } },
    sink2: { value: { value: 5 } },
  })
  const geometry = () => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'sink1')!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === 'value')!
    return { width: node.layout.width, row: { y: row.y, height: row.height, inset: row.inset } }
  })
  const currentGeometry = await geometry()
  await test.info().attach('native-current-expected-value', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })

  await queueSelection(page, ['sink2'])
  await expect.poll(companions).toEqual({
    sink1: { value: { value: 3, state: 'cached' } },
    sink2: { value: { value: 5 } },
  })
  expect(await geometry()).toEqual(currentGeometry)

  const retained = page.getByTestId('canvas-widget-a11y')
    .filter({ has: page.getByText('Int, Value', { exact: true }) })
    .first()
  await retained.focus()
  await expect(page.getByTestId('app-tooltip')).toContainText('Retained last-resolved value: 3')
  await expect(page.getByTestId('app-tooltip')).toContainText('Dormant stored value under connection: 8')
  await test.info().attach('native-retained-last-resolved-value', {
    body: await page.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  })
  expect(pageErrors).toEqual([])
})

test('a native run decodes real pixels into the outputs panel and the node preview', async ({ page, request }) => {
  // Upload the source asset FIRST, so the submit needs no consent round.
  const png = tinyPng()
  const uploaded = await request.post(`${NATIVE_BACKEND}/api/assets/media?scope=local&kind=media%2Fimage&name=e2e.png`, {
    headers: { 'Content-Type': 'image/png' },
    data: png,
  })
  expect([200, 201]).toContain(uploaded.status()) // 200: bytes already stored (CAS dedupe)
  const { asset } = (await uploaded.json()) as { asset: UploadedAsset }
  expect(asset.digest).toMatch(/^blake3:[0-9a-f]{64}$/)

  await openImageryDoc(page, asset)

  // Queue the full document (save_image is an output node) and complete.
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })

  // Outputs panel: the produced asset's digest URL decoded - real pixels,
  // not just an <img> with a src.
  await page.getByRole('tab', { name: 'Outputs' }).click()
  const outputImg = page.getByTestId('outputs-panel').locator('.output-thumbnail img').first()
  await expect(outputImg).toBeVisible({ timeout: 15_000 })
  expect(await outputImg.getAttribute('src')).toContain('/api/assets/')
  await expect
    .poll(() => outputImg.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 })
    .toBe(64)
  expect(await outputImg.evaluate((el) => (el as HTMLImageElement).naturalHeight)).toBe(48)

  // On-canvas preview: the save node's panel decoded the same content at
  // its true dimensions. (load_image is not a target; its tensor output
  // renders only once the backend ships a comfy.IMAGE rendition.)
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const p = window.__dinksterTest!.renderer!.getNodePreviews()['si']
          return p ? { width: p.width, height: p.height } : undefined
        }),
      { timeout: 15_000 },
    )
    .toEqual({ width: 64, height: 48 })
})

test('a disjoint native partial run retains the unchanged digest preview as last resolved', async ({ page, request }) => {
  const png = tinyPng()
  const uploaded = await request.post(`${NATIVE_BACKEND}/api/assets/media?scope=local&kind=media%2Fimage&name=e2e.png`, {
    headers: { 'Content-Type': 'image/png' },
    data: png,
  })
  const { asset } = (await uploaded.json()) as { asset: UploadedAsset }
  await openImageryDoc(page, asset)

  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews().si?.width),
    { timeout: 15_000 }).toBe(64)

  const header = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'si2')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.click(header.x, header.y, { button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="core.node.queueSelection"]').click()
  await expect(page.getByTestId('execution-row').first().locator('.execution-status'))
    .toHaveText('Completed', { timeout: 30_000 })

  await expect.poll(() => page.evaluate(() => {
    const previews = window.__dinksterTest!.renderer!.getNodePreviews()
    return { retained: previews.si?.state, current: previews.si2?.state ?? 'current' }
  }), { timeout: 15_000 }).toEqual({ retained: 'cached', current: 'current' })
})
