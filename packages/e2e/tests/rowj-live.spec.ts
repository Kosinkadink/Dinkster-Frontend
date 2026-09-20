import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { DINKSTER_SCHEMA_WIRE_VERSION } from '@dinkster/core'
import { skipWithoutNativeCatalog } from './fixtures.js'

const PROOF = '/tmp/audit-rowj-proof'
const RANGE_FILL = 'rgba(90, 176, 255, 0.14)'

async function rowGeometry(page: Page, nodeId: string, inputId: string) {
  return page.evaluate(({ nodeId, inputId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + (node.x + row.inset!) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y) * viewport.scale + viewport.y,
      width: (node.layout.width - row.inset! * 2) * viewport.scale,
      height: row.height * viewport.scale,
      scale: viewport.scale,
    }
  }, { nodeId, inputId })
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${PROOF}/${name}`, animations: 'disabled' })
}

async function paintMask(page: Page, start: { x: number; y: number }, end: { x: number; y: number }) {
  await page.evaluate(({ start, end }) => {
    const viewport = document.querySelector<HTMLElement>('[data-testid=image-canvas-viewport]')!
    const surface = document.querySelector<HTMLCanvasElement>('[data-testid=image-mask-surface]')!
    const rect = surface.getBoundingClientRect()
    const dispatch = (type: string, point: { x: number; y: number }, buttons: number) => viewport.dispatchEvent(new PointerEvent(type, {
      pointerId: 71,
      pointerType: 'pen',
      clientX: rect.left + rect.width * point.x,
      clientY: rect.top + rect.height * point.y,
      pressure: buttons === 0 ? 0 : 0.75,
      button: type === 'pointermove' ? -1 : 0,
      buttons,
      bubbles: true,
      cancelable: true,
    }))
    dispatch('pointerdown', start, 1)
    dispatch('pointermove', end, 1)
    dispatch('pointerup', end, 0)
  }, { start, end })
  await expect(page.getByRole('button', { name: 'Undo mask edit' })).toBeEnabled()
}

test('live current-wire row J acceptance proof', async ({ page, request }, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  await mkdir(PROOF, { recursive: true })
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const failedResponses: string[] = []
  const wires: number[] = []
  let assetPosts = 0
  let jobPosts = 0
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', async (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`)
    if (/\/api\/nodes(?:\?|$)/.test(response.url()) && response.ok()) {
      const body = await response.json().catch(() => null) as { dinkster?: { schemaWire?: number } } | null
      if (body?.dinkster?.schemaWire !== undefined) wires.push(body.dinkster.schemaWire)
    }
  })
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    assetPosts += 1
    await route.fulfill({ status: 200, json: { digest: `blake3:${'d'.repeat(64)}` } })
  })
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    jobPosts += 1
    await route.fulfill({ status: 202, json: { jobRef: 'rowj-mocked-job' } })
  })

  await page.goto('/')
  // Installed packs vary by host; this bound distinguishes the complete
  // production catalog from a partial or fallback catalog.
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0), { timeout: 20_000 }).toBeGreaterThan(400)
  expect(wires).toContain(DINKSTER_SCHEMA_WIRE_VERSION)

  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'rowj-live', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        sampler: { id: 'sampler', type: 'dinkster.ksampler', values: { seed: 7, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'simple', denoise: 1 }, controllers: { seed: 'fixed' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { sampler: { position: { x: 140, y: 90 }, size: { width: 360, height: 220 } } } } } },
    }, 'Row J live proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 10, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'sampler')?.layout.rows.filter((row) => row.kind === 'widget').length)).toBeGreaterThanOrEqual(5)
  const ordinaryFills = await page.evaluate((rangeFill) => {
    const renderer = window.__dinksterTest!.renderer! as unknown as { renderNow(): void }
    let fills = 0
    const original = CanvasRenderingContext2D.prototype.fillRect
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) {
      if (String(this.fillStyle) === rangeFill) fills += 1
      return original.call(this, x, y, width, height)
    }
    try { renderer.renderNow() } finally { CanvasRenderingContext2D.prototype.fillRect = original }
    return fills
  }, RANGE_FILL)
  expect(ordinaryFills).toBe(0)
  await screenshot(page, '01-ksampler-widgets.png')

  const steps = await rowGeometry(page, 'sampler', 'steps')
  const initialSteps = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.sampler!.values.steps)
  for (let index = 1; index <= 4; index += 1) {
    await page.mouse.click(steps.x + steps.width - 6, steps.y + steps.height / 2)
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.sampler!.values.steps)).toBe((initialSteps as number) + index)
  }
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.sampler!.values.steps)).toBe(initialSteps)
  await screenshot(page, '02-int-step-undo.png')

  const text = Array.from({ length: 18 }, (_, index) => `overflow line ${index + 1} keeps enough words to wrap at narrow widths`).join('\n')
  await page.evaluate((value) => {
    const test = window.__dinksterTest!
    const tab = test.app.activeTab()!
    tab.store.dispatch({ command: 'node.add', params: { graphId: 'g0', type: 'dinkster.clip_text_encode', values: { text: value }, position: { x: 570, y: 90 } } })
  }, text)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  const clipId = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id !== 'sampler')!.id)
  await page.evaluate((nodeId) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'view.setNodeSize', params: { graphId: 'g0', nodeId, size: { width: 310, height: 240 } } })
  }, clipId)
  let textRow = await rowGeometry(page, clipId, 'text')
  await page.mouse.move(20, 850)
  const idle = await page.screenshot({ path: `${PROOF}/03-multiline-idle.png`, animations: 'disabled' })
  await page.mouse.move(textRow.x + textRow.width / 2, textRow.y + textRow.height / 2)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().hoveredWidget?.valueKey)).toBe('text')
  const hover = await page.screenshot({ path: `${PROOF}/04-multiline-hover.png`, animations: 'disabled' })
  expect(idle.subarray(0, 32).equals(hover.subarray(0, 32))).toBe(true)
  await page.mouse.click(textRow.x + textRow.width / 2, textRow.y + textRow.height / 2)
  const textarea = page.getByTestId('widget-editor').locator('textarea')
  await expect(textarea).toBeVisible()
  expect(await textarea.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(Number.parseFloat(await textarea.evaluate((element) => getComputedStyle(element, '::-webkit-scrollbar').width))).toBeGreaterThan(0)
  await screenshot(page, '05-multiline-focus.png')
  await page.keyboard.press('Escape')
  await page.evaluate((nodeId) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'view.setNodeSize', params: { graphId: 'g0', nodeId, size: { width: 430, height: 330 } } })
    window.__dinksterTest!.renderer!.setViewport({ x: 10, y: 5, scale: 0.8 })
  }, clipId)
  await screenshot(page, '06-multiline-resize-zoom.png')
  textRow = await rowGeometry(page, clipId, 'text')
  await page.mouse.move(textRow.x + textRow.width / 2, textRow.y + textRow.height / 2)
  await screenshot(page, '07-hover-geometry.png')

  const entriesResponse = await request.get('/api/mounts/comfy-input/entries?kind=media/image')
  test.skip(!entriesResponse.ok(), 'live library has no comfy-input mount for image-mask proof')
  expect(entriesResponse.ok()).toBe(true)
  const entries = await entriesResponse.json() as { entries: Array<{ digest: string; name: string; mediaType: string }> }
  const image = entries.entries.find((record) => record.mediaType.startsWith('image/'))
  expect(image, 'live library must contain a read-only image for mask proof').toBeTruthy()
  const assetResponse = await request.get(`/api/assets/${encodeURIComponent(image!.digest)}`)
  expect(assetResponse.ok()).toBe(true)
  const bytes = await assetResponse.body()
  await page.evaluate(({ image, size }) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'node.add', params: { graphId: 'g0', type: 'dinkster.load_image', values: { image: { digest: image!.digest, name: image!.name, mediaType: image!.mediaType, size, virtualPath: '' } }, position: { x: 180, y: 430 } } })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { image, size: bytes.length })
  const loadId = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((node) => !['sampler'].includes(node.id) && node.layout.rows.some((row) => row.inputId === 'image'))!.id)
  const beforeImageEdit = await page.evaluate((nodeId) => { const tab = window.__dinksterTest!.app.activeTab()!; return { revision: tab.store.revision, value: tab.store.doc.graphs.g0!.nodes[nodeId]!.values.image } }, loadId)
  await page.evaluate((nodeId) => {
    const app = window.__dinksterTest!.app as unknown as { activeTab(): unknown; imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): unknown; openImageEditor(target: unknown): boolean }
    const target = app.imageTargetForInput(app.activeTab(), 'g0', nodeId, 'image')
    if (!target || !app.openImageEditor(target)) throw new Error('real image ASSET did not expose the image editor entry path')
  }, loadId)
  await expect(page.getByTestId('image-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bake to asset' })).toBeEnabled({ timeout: 15_000 })
  await screenshot(page, '08-image-editor-open.png')
  await paintMask(page, { x: 0.2, y: 0.2 }, { x: 0.6, y: 0.6 })
  await page.getByRole('button', { name: 'Undo mask edit' }).click(); await page.getByRole('button', { name: 'Redo mask edit' }).click()
  await page.getByRole('button', { name: 'Cancel' }).click()
  expect(await page.evaluate((nodeId) => { const tab = window.__dinksterTest!.app.activeTab()!; return { revision: tab.store.revision, value: tab.store.doc.graphs.g0!.nodes[nodeId]!.values.image } }, loadId)).toEqual(beforeImageEdit)
  await screenshot(page, '09-image-edit-cancel.png')
  await page.evaluate((nodeId) => {
    const app = window.__dinksterTest!.app as unknown as { activeTab(): unknown; imageTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): unknown; openImageEditor(target: unknown): boolean }
    const target = app.imageTargetForInput(app.activeTab(), 'g0', nodeId, 'image')
    if (!target || !app.openImageEditor(target)) throw new Error('real image ASSET could not reopen the image editor')
  }, loadId)
  await expect(page.getByRole('button', { name: 'Bake to asset' })).toBeEnabled({ timeout: 15_000 })
  await paintMask(page, { x: 0.35, y: 0.35 }, { x: 0.5, y: 0.5 })
  await page.getByRole('button', { name: 'Bake to asset' }).click()
  await expect.poll(() => assetPosts).toBe(1)
  await expect.poll(() => page.evaluate((nodeId) =>
    window.__dinksterTest!.app.activeTab()!.store.revision, loadId),
  ).toBe(beforeImageEdit.revision + 1)
  const afterImageEdit = await page.evaluate((nodeId) => { const tab = window.__dinksterTest!.app.activeTab()!; return { revision: tab.store.revision, value: tab.store.doc.graphs.g0!.nodes[nodeId]!.values.image } }, loadId)
  expect(afterImageEdit.revision).toBe(beforeImageEdit.revision + 1)
  expect(afterImageEdit.value).not.toEqual(beforeImageEdit.value)
  await screenshot(page, '10-image-edit-apply-mocked.png')

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'node.add', params: { graphId: 'g0', type: 'dinkster.mask.make', values: { width: 512, height: 512, batch_size: 1, invert: false, operation: 'solid', foreground: 1 }, position: { x: 920, y: 430 } } })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.layout.rows.some((row) => row.inputId === 'width')))).toBe(true)
  const explicitFills = await page.evaluate((rangeFill) => {
    const renderer = window.__dinksterTest!.renderer! as unknown as { renderNow(): void }
    let fills = 0; const original = CanvasRenderingContext2D.prototype.fillRect
    CanvasRenderingContext2D.prototype.fillRect = function (x, y, width, height) { if (String(this.fillStyle) === rangeFill) fills += 1; return original.call(this, x, y, width, height) }
    try { renderer.renderNow() } finally { CanvasRenderingContext2D.prototype.fillRect = original }
    return fills
  }, RANGE_FILL)
  expect(explicitFills).toBe(0)
  await screenshot(page, '11-display-number-ordinary.png')

  expect(jobPosts).toBe(0)
  expect(pageErrors).toEqual([])
  const unexpectedConsole = consoleErrors.filter((message) => !/proxy|favicon|Failed to load resource: the server responded with a status of (404|500)/i.test(message))
  expect(unexpectedConsole).toEqual([])
  console.log(`ROWJ wire=${wires.join(',')} assetPosts=${assetPosts} jobPosts=${jobPosts} consoleErrors=${JSON.stringify(consoleErrors)} failedResponses=${JSON.stringify(failedResponses)} pageErrors=${JSON.stringify(pageErrors)}`)
})
