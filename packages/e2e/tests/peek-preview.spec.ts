/**
 * Native peek previews (GET /api/values) through the production CanvasHost:
 * a terminal NATIVE run renders imagery the event stream never carried.
 *
 * Covered browser behavior:
 * - own-output peek: a node that ran shows its recorded output, negotiated
 *   from the DECLARED renditions (nothing here names png);
 * - producer fallback: a node added and wired AFTER the run renders its
 *   producer's recorded output immediately, before ever executing;
 * - transient transport failures are NOT negative-cached (a later overlay
 *   refresh retries and succeeds);
 * - definitive refusals (structured reason, e.g. not-retained) ARE
 *   negative-cached: no refetch even after the server recovers.
 *
 * Requires a native backend serving the dinkster-nodes-dev pack: the image scaffolding
 * nodes moved to the gated dev pack (dev.image.gradient, dev.image.invert)
 * and a plain dinkster-serve no longer composes them. Skips loudly when no
 * backend answers OR the dev nodes are absent, so the suite stays runnable
 * against ComfyUI alone or a non-dev native server.
 */
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

const previews = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews())

const decodedPreview = (page: Page, nodeId: string) =>
  page.evaluate((id) => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews()[id]
    return typeof preview?.width === 'number' && typeof preview.height === 'number'
      ? { width: preview.width, height: preview.height }
      : undefined
  }, nodeId)

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

/** Register the native server as a second backend (no tab targeting yet). */
async function addNativeBackend(page: Page): Promise<void> {
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(NATIVE_BACKEND)
  await page.getByTestId('backend-add').click()
  await expect(page.getByTestId('tab-target')).toBeVisible()
}

/**
 * Open a document holding one dev.image.gradient node ('grad') and target
 * ITS tab at the native backend. Schema registries are per backend and the
 * scene resolves through the ACTIVE tab's target, so the target must be set
 * on the freshly opened tab (a new tab defaults to Local). Waits for the
 * native schema: the node materializes its INT widget rows only once
 * dev.image.gradient is decodable.
 */
async function openGradientDoc(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'peek-preview-e2e', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { grad: { id: 'grad', type: 'dev.image.gradient', values: { width: 8, height: 8 } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
      } },
      view: { graphs: { g0: { nodes: { grad: { position: { x: 120, y: 120 } } } } } },
    } as never, 'Peek Preview')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await selectProductOption(page, page.getByTestId('tab-target'), NATIVE_BACKEND)
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'peek-preview-e2e'
  })).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes
      .find((n) => n.id === 'grad')?.layout.rows
      .some((r) => r.kind === 'widget' && r.inputId === 'width'),
  ), { timeout: 15_000 }).toBe(true)
}

/**
 * Queue the grad node through the real context-menu partial-execute item
 * and wait for completion. Full-scope queue refuses this graph
 * (submit.noTargets: dev.image.gradient carries no outputNode hint), so the
 * partial path is the genuine user route for running it.
 */
async function queueAndComplete(page: Page): Promise<void> {
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  const p = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === 'grad')!
    const viewport = renderer.getViewport()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.getByTestId('context-menu-item').filter({ hasText: 'Execute up to Selection' }).click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
}

/** Center of a node's pin in page CSS px (identity viewport). */
async function pinPoint(page: Page, nodeId: string, portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, portId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => item.portId === portId)
    if (!pin) throw new Error(`no pin '${nodeId}/${portId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: rect.top + node.y + pin.y,
    }
  }, { nodeId, portId })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

/**
 * Nudge the grad node header by a few px: a scene rebuild re-runs the
 * overlay helper, which is what re-attempts non-negative-cached peeks.
 */
async function nudgeNode(page: Page): Promise<void> {
  const p = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'grad')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await drag(page, p, { x: p.x + 4, y: p.y + 4 })
}

test.beforeEach(async ({ page }) => {
  // Probe outside the skip calls: test.skip signals by throwing, so a skip
  // raised inside the try would be swallowed and remapped to 'unreachable'.
  let served: Record<string, unknown> | null = null
  try {
    const probe = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    if (probe.ok) served = (await probe.json() as { nodes?: Record<string, unknown> }).nodes ?? {}
  } catch { /* unreachable -> served stays null */ }
  test.skip(served === null, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
  // A reachable server is not enough: the image scaffolding nodes are
  // dev-gated, so a non-dev server answers 200 while missing everything
  // this suite runs.
  const missing = ['dev.image.gradient', 'dev.image.invert'].filter((id) => !(id in served!))
  test.skip(missing.length > 0,
    `native backend at ${NATIVE_BACKEND} lacks ${missing.join(', ')} - serve the dinkster-nodes-dev pack`)
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await addNativeBackend(page)
  await openGradientDoc(page)
})

test('a completed native run peeks a node\'s own recorded output into its preview', async ({ page }) => {
  const valueRequests: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/values')) valueRequests.push(r.url()) })

  await queueAndComplete(page)

  // Native runs carry no event-stream frames or /view image outputs for this
  // node: the preview can only come from the peek path.
  await expect.poll(() => decodedPreview(page, 'grad'), { timeout: 15_000 }).toBeDefined()
  const p = (await decodedPreview(page, 'grad'))!
  expect(p.width).toBeGreaterThan(0)
  expect(p.height).toBeGreaterThan(0)
  // Rendition negotiation went through GET /api/values (peek + bytes).
  expect(valueRequests.length).toBeGreaterThan(0)
})

test('a node wired after the run renders its producer\'s output before ever executing', async ({ page }) => {
  await queueAndComplete(page)
  await expect.poll(() => decodedPreview(page, 'grad'), { timeout: 15_000 }).toBeDefined()

  // Add an Invert Image node through the real palette, AFTER the run.
  await page.mouse.click(700, 600, { button: 'right' })
  await page.locator('[data-item-id="core.canvas.addNode"]').click()
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await page.getByTestId('palette-search').fill('Invert Image')
  await page.locator('[data-node-type="dev.image.invert"]').click()
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  await page.mouse.click(700, 500)
  const invId = await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.graphs['g0']!.nodes).find((n) => n.type === 'dev.image.invert')!.id
  })

  // Wire grad.image -> invert.image with a real pin drag.
  await drag(page, await pinPoint(page, 'grad', 'image'), await pinPoint(page, invId, 'image'))
  const doc = await activeDoc(page)
  const linked = Object.values(doc.graphs['g0']!.links).some((l) =>
    'node' in l.to && l.to.node === invId && l.to.port === 'image')
  expect(linked).toBe(true)

  // Producer fallback: the never-ran node shows the producer's recorded
  // output without a second queue (still exactly one execution).
  await expect.poll(() => decodedPreview(page, invId), { timeout: 15_000 }).toBeDefined()
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(1)
})

test('a transport failure is retried on the next overlay refresh, not negative-cached', async ({ page }) => {
  const valueRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/values')) valueRequests.push(request.url())
  })
  // Plain 500 with no structured body maps to reason 'http-error' in the
  // values client: fetchPeekRendition marks the miss transient.
  await page.route('**/api/values**', (route) => route.fulfill({ status: 500, body: '' }))
  await queueAndComplete(page)

  // The peek attempt fails; no decoded image is rendered. A transient miss
  // may retain its loading placeholder until the next scene refresh.
  await expect.poll(() => valueRequests.length, { timeout: 15_000 }).toBeGreaterThan(0)
  await expect.poll(() => decodedPreview(page, 'grad')).toBeUndefined()

  // Server recovers; a scene rebuild re-runs the overlay and retries.
  await page.unroute('**/api/values**')
  await nudgeNode(page)
  await expect.poll(() => decodedPreview(page, 'grad'), { timeout: 15_000 }).toBeDefined()
})

test('a definitive refusal is negative-cached: no refetch even after recovery', async ({ page }) => {
  const valueRequests: string[] = []
  page.on('request', (r) => { if (r.url().includes('/api/values')) valueRequests.push(r.url()) })
  // Structured refusal (recognized reason) -> definitive miss.
  await page.route('**/api/values**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ available: false, reason: 'not-retained', error: 'value not retained' }),
  }))
  await queueAndComplete(page)

  // Wait until the peek attempt actually happened, then let it settle.
  await expect.poll(() => valueRequests.length, { timeout: 15_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  expect((await previews(page))['grad']).toBeUndefined()

  // Server would now answer, but the miss was definitive: the source key is
  // negative-cached, so an overlay refresh must NOT refetch or render.
  await page.unroute('**/api/values**')
  const before = valueRequests.length
  await nudgeNode(page)
  await page.waitForTimeout(750)
  expect(valueRequests.length).toBe(before)
  expect((await previews(page))['grad']).toBeUndefined()
})
