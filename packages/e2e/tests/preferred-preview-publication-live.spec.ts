/**
 * Hold a real running-job refusal across terminal publication and prove
 * the producer preview still selects IMAGE rather than caching MASK.
 */
import { deflateSync } from 'node:zlib'
import type { NodeSchema } from '@dinkster/core'
import { expect, nativeTest as test, waitForStartupOwnership, type Page } from './fixtures.js'

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

async function openMidgraphDoc(page: Page, asset: { digest: string; size: number }): Promise<{ image: string; mask: string }> {
  const contract = await page.evaluate(() => {
    const schemas = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!.schemas as ReadonlyMap<string, NodeSchema>
    const load = [...schemas].find(([id]) => id.endsWith('.load_image'))!
    const output = (name: string): string => load[1].items.find((item) =>
      item.kind === 'output' && item.type.kind === 'concrete' && item.type.name.toLowerCase().split('.').at(-1) === name)!.id
    return { load: load[0], image: output('image'), mask: output('mask') }
  })
  const opened = await page.evaluate(async ({ digest, size, contract }) => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get()[0]!
    const retained = app as unknown as {
      openRetainedDocument(document: unknown, title: string, backend: unknown, stillWanted: () => boolean): Promise<unknown>
    }
    const tab = await retained.openRetainedDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'midgraph-preview-live', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          li: { id: 'li', type: contract.load, values: { image: { digest, name: 'e2e.png', size, mediaType: 'image/png', virtualPath: '' } } },
          delay: { id: 'delay', type: 'dev.execution.sleep', values: { value: 1, seconds: 2 } },
        },
        links: {},
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: { li: { position: { x: 80, y: 120 } }, delay: { position: { x: 80, y: 500 } } } } } },
    }, 'Mid-graph Tensor Preview', backend, () => true)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return tab !== undefined
  }, { ...asset, contract })
  expect(opened).toBe(true)
  await waitForStartupOwnership(page)
  return contract
}

test.use({ retentionApi: false })

test.beforeEach(async ({ page }) => {
  let served: Record<string, unknown> | null = null
  try {
    const probe = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    if (probe.ok) served = (await probe.json() as { nodes?: Record<string, unknown> }).nodes ?? {}
  } catch { /* unreachable -> served stays null */ }
  test.skip(served === null, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
  await expect.poll(async () => {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`)
    if (!response.ok) return false
    const nodes = (await response.json() as { nodes?: Record<string, unknown> }).nodes ?? {}
    return Object.keys(nodes).some((id) => id.endsWith('.load_image')) &&
      'dev.execution.sleep' in nodes
  }, {
    message: `native backend at ${NATIVE_BACKEND} must compose dinkster.load_image and dev.execution.sleep`,
    timeout: 30_000,
  }).toBe(true)

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await waitForStartupOwnership(page)
})

test('a preferred IMAGE is retried after a running-job refusal crosses terminal publication', async ({ page, request }, testInfo) => {
  const png = tinyPng()
  const uploaded = await request.post(`${NATIVE_BACKEND}/api/assets`, {
    headers: { 'Content-Type': 'application/octet-stream' },
    data: png,
  })
  expect([200, 201]).toContain(uploaded.status())
  const { digest } = (await uploaded.json()) as { digest: string }
  expect(digest).toMatch(/^blake3:[0-9a-f]{64}$/)

  const contract = await openMidgraphDoc(page, { digest, size: png.length })
  const observations: unknown[] = []
  let runningRefusal: { status: number; body: string } | undefined
  await page.route('**/api/jobs', async (route) => {
    const response = await route.fetch()
    if (!response.ok()) {
      observations.push({ submitStatus: response.status(), body: await response.text() })
      await route.fulfill({ response })
      return
    }
    const { clientId, jobId } = route.request().postDataJSON() as { clientId: string; jobId: string }
    const url = new URL(`${NATIVE_BACKEND}/api/values`)
    for (const [key, value] of Object.entries({ clientId, jobId, nodeId: 'li', outputId: contract.image })) url.searchParams.set(key, value)
    const refusal = await request.get(url.toString())
    expect(refusal.status()).toBe(409)
    runningRefusal = { status: refusal.status(), body: await refusal.text() }
    observations.push({ url: url.toString(), ...runningRefusal })
    await route.fulfill({ response })
  })
  let held = false
  let released = false
  await page.route('**/api/values?**', async (route) => {
    const url = new URL(route.request().url())
    if (held || url.searchParams.get('nodeId') !== 'li' || url.searchParams.get('outputId') !== contract.image || url.searchParams.has('rendition')) {
      await route.continue()
      return
    }
    if (runningRefusal !== undefined) {
      held = true
      await expect(page.getByTestId('execution-row').first().locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
      for (const output of [contract.image, contract.mask]) {
        url.searchParams.set('outputId', output)
        const published = await request.get(url.toString())
        expect(published.status()).toBe(200)
        observations.push({ url: url.toString(), status: published.status(), body: await published.json() })
      }
    }
    await route.fulfill({ status: runningRefusal!.status, body: runningRefusal!.body, contentType: 'application/problem+json' })
    released = true
  })
  const valueRequests: string[] = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === '/api/values') valueRequests.push(req.url())
  })
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!, { kind: 'partial', targets: [
      { instancePath: [], node: 'li' as never }, { instancePath: [], node: 'delay' as never },
    ] })
  })
  await testInfo.attach('submit-observations', { body: JSON.stringify({ observations, problems: await page.evaluate(() => window.__dinksterTest!.app.problems.get()) }, null, 2), contentType: 'application/json' })
  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get())).toEqual([])
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })

  const outputType = await page.evaluate((image) => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
    const latest = executions.sort((a, b) => b.queuedAt - a.queuedAt)[0] as unknown as {
      nodes?: Record<string, { outputs?: Record<string, { typeId?: string }> }>
    }
    return latest.nodes?.['li']?.outputs?.[image]?.typeId
  }, contract.image)
  expect(outputType?.toLowerCase().split('.').at(-1)).toBe('image')
  await expect.poll(() => held).toBe(true)
  await expect.poll(() => released).toBe(true)
  await testInfo.attach('publication-requests', { body: JSON.stringify(observations, null, 2), contentType: 'application/json' })

  await expect
    .poll(
      () => page.evaluate(() => {
        const preview = window.__dinksterTest!.renderer!.getNodePreviews()['li']
        return preview ? { width: preview.width, height: preview.height } : undefined
      }),
      { timeout: 15_000 },
    )
    .toEqual({ width: 64, height: 48 })
  await page.screenshot({ path: testInfo.outputPath('preferred-preview.png') })

  const producerRequests = valueRequests
    .map((url) => new URL(url))
    .filter((url) => url.searchParams.get('nodeId') === 'li' && url.searchParams.get('outputId') === contract.image)
  const peekAt = producerRequests.findIndex((url) => !url.searchParams.has('rendition'))
  const renditionAt = producerRequests.findIndex((url) => url.searchParams.has('rendition'))
  expect(peekAt).toBeGreaterThanOrEqual(0)
  expect(renditionAt).toBeGreaterThan(peekAt)
})
