import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'

const mp4 = readFileSync(new URL('../fixtures/media-overlay/with_metadata.mp4', import.meta.url))
const png = readFileSync(new URL('../fixtures/media-overlay/with_metadata.png', import.meta.url))
const meta = { effective: { duration: [1, 1], fps: [24, 1], frame_count: 24, frame_count_kind: 'exact' } }

const waitForFrameResponse = (page: Page, frame: string) => page.waitForResponse((response) => {
  const url = new URL(response.url())
  return url.pathname === '/api/values' && url.searchParams.get('frame') === frame
})

async function install(
  page: Page,
  refusal?: 'frame' | 'all' | 'unadvertised' | 'legacy-selectors',
  metadata: Record<string, unknown> = meta,
  beforeRendition?: (url: URL) => Promise<void>,
) {
  const requests: URL[] = []
  let strip = png
  await page.route('/api/**', (route) => route.fulfill({ status: 404, json: { error: 'isolated video fixture' } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated fixture' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'video-test', schemaWire: 1 }, nodes: {} } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('**/api/values?*', async (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    const kind = url.searchParams.get('rendition')
    if (kind !== null) await beforeRendition?.(url)
    if (kind !== null && (refusal === 'all' || (kind === 'frame' && refusal === 'frame'))) return route.fulfill({ status: 406, json: {
      available: false, reason: 'unavailable-rendition', error: `${kind} decoder unavailable`,
    } })
    if (kind !== null) return route.fulfill({
      contentType: kind === 'preview' ? 'video/mp4' : 'image/png', body: kind === 'preview' ? mp4 : kind === 'thumbs' ? strip : png,
      headers: { 'X-Dinkster-Rendition': kind, 'X-Dinkster-Fingerprint': 'video-fixture', 'X-Dinkster-Color-Transform': 'PQ-to-sRGB; reinhard; reference-display' },
    })
    const list = url.searchParams.get('outputId') === 'clips' && !url.searchParams.has('element')
    return route.fulfill({ json: { available: true,
      descriptor: list ? { typeId: 'list<comfy.VIDEO>', fingerprint: 'clips', length: 2 }
        : { typeId: 'comfy.VIDEO', fingerprint: 'video-fixture', meta: metadata },
      renditions: list ? [] : refusal === 'unadvertised' ? [{ kind: 'original', mime: 'video/mp4', default: true }] : [
        { kind: 'original', mime: 'video/x-matroska', default: true }, { kind: 'preview', mime: 'video/mp4' },
        { kind: 'poster', mime: 'image/png' },
        { kind: 'frame', mime: 'image/png', ...(refusal === 'legacy-selectors' ? {} : {
          version: 'frame-v1', parameters: ['frame'], defaults: { frame: '0' }, limits: { maxEdge: 1024, maxOutputFrames: 1 },
        }) },
        { kind: 'thumbs', mime: 'image/png', ...(refusal === 'legacy-selectors' ? {} : {
          version: 'thumbs-v1', parameters: ['thumbs'], defaults: { thumbs: '8' }, limits: { maxCount: 16, maxEdge: 128 },
        }) },
      ],
    } })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined,
  ), { timeout: 15_000 }).toBe(true)
  strip = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640; canvas.height = 45
    const ctx = canvas.getContext('2d')!
    for (let index = 0; index < 8; index++) {
      ctx.fillStyle = `hsl(${index * 35} 65% 35%)`
      ctx.fillRect(index * 80, 0, 80, 45)
      ctx.fillStyle = '#fff'; ctx.font = '16px sans-serif'
      ctx.fillText(String(index + 1), index * 80 + 32, 28)
    }
    return canvas.toDataURL('image/png').split(',')[1]!
  }), 'base64')
  await page.evaluate((meta) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'VideoControlsTest', displayName: 'Video inspection', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'output', id: 'clips', type: { kind: 'list', element: { kind: 'concrete', name: 'comfy.VIDEO' } }, preview: true },
        { kind: 'output', id: 'other', type: { kind: 'concrete', name: 'comfy.VIDEO' }, preview: true },
      ],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'video-controls', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Video controls', nodes: { video: { id: 'video', type: 'VideoControlsTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { video: { position: { x: 80, y: 80 }, size: { width: 640, height: 440 } } } } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'g0', nodeId: 'video' }] },
    }, 'Video controls')
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'video-controls-run' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { video: { state: 'done' } } })
    store.apply({ kind: 'nodeOutput', execution: ref, runtimeNodeId: 'video', timestamp: Date.now(), output: {
      clips: { typeId: 'list<comfy.VIDEO>', fingerprint: 'clips', length: 2 },
      other: { typeId: 'comfy.VIDEO', fingerprint: 'video-fixture', meta },
    } })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, metadata)
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
  return requests
}

for (const appView of [false, true]) test(`VIDEO scrub, frames, outputs and persisted preferences in ${appView ? 'App View' : 'Canvas'}`, async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const requests = await install(page)
  if (appView) {
    await page.getByTestId('views-switcher').click()
    await page.getByRole('menuitemradio', { name: 'App view' }).click()
  }
  const controls = page.getByRole('group', { name: 'Video preview controls', exact: true })
  await expect(controls).toBeVisible()
  await expect(controls.locator('video')).toHaveJSProperty('muted', true)
  await expect(controls.locator('video')).toHaveJSProperty('loop', true)
  await expect.poll(() => controls.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(false)
  const before = await page.evaluate(() => ({
    graphs: window.__dinksterTest!.app.activeTab()!.store.doc.graphs,
    outputs: [...window.__dinksterTest!.app.store.executions.get().values()].find((e) => e.ref.prompt === 'video-controls-run')!.outputs,
    compiled: window.__dinksterTest!.app.compileTab(window.__dinksterTest!.app.activeTab()!),
  }))
  await controls.getByRole('button', { name: 'Autoplay video', exact: true }).click()
  await controls.getByRole('slider', { name: 'Video position' }).focus()
  await page.keyboard.press('Home')
  await controls.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(controls.getByTestId('video-timing')).toContainText('Frame 0 / 24')
  await page.keyboard.press('.')
  await expect(controls.getByTestId('video-timing')).toContainText('Frame 1 / 24')
  await page.keyboard.press('.')
  await expect(controls.getByTestId('video-timing')).toContainText('Frame 2 / 24')
  await page.keyboard.press(',')
  await expect(controls.getByTestId('video-timing')).toContainText('Frame 1 / 24')
  const slider = controls.getByRole('slider', { name: 'Video position' })
  await slider.click({ position: { x: (await slider.boundingBox())!.width / 2, y: 8 } })
  await expect(controls.getByTestId('video-timing')).toContainText('0.50s / 1.00s | Frame unknown / 24 (exact)')
  await expect(controls.locator('.video-preview-frame')).toBeVisible()
  const downloaded = await controls.getByRole('link', { name: 'Download preview' }).evaluate(async (element) =>
    Array.from(new Uint8Array(await (await fetch((element as HTMLAnchorElement).href)).arrayBuffer())))
  expect(Buffer.from(downloaded)).toEqual(png)
  await controls.hover()
  await expect(controls.getByAltText('8 video timeline thumbnails')).toBeVisible()
  await expect(controls.getByTestId('video-color-transform')).toHaveText('Preview color: PQ-to-sRGB; reinhard; reference-display')
  await controls.getByRole('button', { name: 'Next video', exact: true }).click()
  await expect(controls.getByRole('button', { name: 'Video 2', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await controls.focus()
  await page.keyboard.press('ArrowRight')
  await expect(controls.getByRole('button', { name: 'Video 3', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(controls.getByRole('button', { name: 'Video 2', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await controls.getByRole('button', { name: 'Loop video', exact: true }).click()
  await controls.getByRole('button', { name: 'Mute video', exact: true }).click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0!.nodes.video!.video)).toEqual({ loop: false, muted: false, autoplay: false })
  if (!appView) {
    for (const scale of [0.5, 0.74, 1]) {
      await page.evaluate((scale) => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale }), scale)
      await expect(controls.getByRole('button', { name: 'Play video', exact: true })).toBeVisible()
      await expect(controls.locator('video')).toHaveJSProperty('muted', scale < 0.75)
      await expect(controls.locator('video')).toHaveJSProperty('loop', false)
      await controls.getByRole('button', { name: 'Next frame', exact: true }).click()
      await expect(controls.getByTestId('video-timing')).toContainText('Time unknown')
      const panel = (await controls.boundingBox())!
      const download = (await controls.getByRole('link', { name: 'Download preview' }).boundingBox())!
      expect(download.y + download.height).toBeLessThanOrEqual(panel.y + panel.height)
      await controls.screenshot({ path: testInfo.outputPath(`canvas-video-${scale}.png`) })
    }
  } else await controls.screenshot({ path: testInfo.outputPath('app-video-controls.png') })
  const after = await page.evaluate(() => ({
    graphs: window.__dinksterTest!.app.activeTab()!.store.doc.graphs,
    outputs: [...window.__dinksterTest!.app.store.executions.get().values()].find((e) => e.ref.prompt === 'video-controls-run')!.outputs,
    compiled: window.__dinksterTest!.app.compileTab(window.__dinksterTest!.app.activeTab()!),
  }))
  expect(after.graphs).toEqual(before.graphs)
  expect(after.outputs).toEqual(before.outputs)
  if (!before.compiled?.ok || !after.compiled?.ok) throw new Error('Expected successful compilation before and after inspection')
  const { snapshot: beforeSnapshot, revision: beforeRevision, ...beforeExecution } = before.compiled.artifact
  const { snapshot: afterSnapshot, revision: afterRevision, ...afterExecution } = after.compiled.artifact
  expect(afterExecution).toEqual(beforeExecution)
  expect(afterSnapshot.graphs).toEqual(beforeSnapshot.graphs)
  expect(afterRevision - beforeRevision).toBe(3)
  expect(requests.some((url) => url.searchParams.get('frame') === '2')).toBe(true)
  expect(requests.some((url) => url.searchParams.get('thumbs') === '8')).toBe(true)
  expect(requests.some((url) => url.searchParams.get('element') === '1')).toBe(true)
  expect(requests.every((url) => url.searchParams.get('jobId') === 'video-controls-run' && url.searchParams.has('clientId') &&
    [null, 'preview', 'poster', 'frame', 'thumbs'].includes(url.searchParams.get('rendition')))).toBe(true)
  const stored = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  await page.evaluate((stored) => window.__dinksterTest!.app.openDocument(JSON.parse(stored), 'Reopened video'), stored)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs.g0!.nodes.video!.video)).toEqual({ loop: false, muted: false, autoplay: false })
  expect(errors).toEqual([])
})

test('VIDEO download stays outside scrolling controls in a narrow half-zoom node', async ({ page }, testInfo) => {
  await install(page)
  const controls = page.getByRole('group', { name: 'Video preview controls', exact: true })
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({ command: 'view.setNodeSize', params: {
      graphId: 'g0', nodeId: 'video', size: { width: 420, height: 440 },
    } })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.5 })
  })
  const scrolling = controls.locator('.video-preview-controls')
  await expect.poll(() => scrolling.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await controls.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(controls.getByTestId('video-timing')).toContainText('Frame 0 / 24')
  const download = controls.getByRole('link', { name: 'Download preview' })
  const panel = (await controls.boundingBox())!
  await page.screenshot({ path: testInfo.outputPath('canvas-video-narrow.png'), clip: {
    x: panel.x - 10, y: panel.y - 40, width: panel.width + 20, height: panel.height + 60,
  } })
  const link = (await download.boundingBox())!
  expect(link.y).toBeGreaterThanOrEqual(panel.y)
  expect(link.y + link.height).toBeLessThanOrEqual(panel.y + panel.height)
  expect(await download.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === element
  })).toBe(true)
  await expect(controls.getByAltText('8 video timeline thumbnails')).toBeVisible()
  const strip = (await controls.locator('.video-preview-thumbs').boundingBox())!
  const scrubber = (await controls.getByRole('slider', { name: 'Video position' }).boundingBox())!
  expect(strip.y + strip.height).toBeLessThanOrEqual(scrubber.y)
  await controls.getByRole('button', { name: 'Next video', exact: true }).focus()
  await expect.poll(() => scrolling.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await page.keyboard.press('Tab')
  await expect(download).toBeFocused()
  const saved = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  expect((await saved).suggestedFilename()).toBe('preview.png')
  await controls.getByTestId('video-color-transform').scrollIntoViewIfNeeded()
  const metadata = (await controls.getByTestId('video-color-transform').boundingBox())!
  expect(metadata.y + metadata.height).toBeLessThanOrEqual(link.y)
  await controls.screenshot({ path: testInfo.outputPath('canvas-video-narrow-scrolled.png') })
})

for (const appView of [false, true]) for (const unknown of [false, true]) test(`VIDEO timing quality ${unknown ? 'unknown' : 'estimated'} in ${appView ? 'App View' : 'Canvas'}`, async ({ page }, testInfo) => {
  const requests = await install(page, undefined, { effective: unknown
    ? { duration: null, fps: null, frame_count: null, frame_count_kind: null }
    : { duration: [1, 1], fps: [24, 1], frame_count: 1, frame_count_kind: 'estimated' } })
  if (appView) {
    await page.getByTestId('views-switcher').click()
    await page.getByRole('menuitemradio', { name: 'App view' }).click()
  }
  const controls = page.getByRole('group', { name: 'Video preview controls', exact: true })
  const readout = controls.getByTestId('video-timing')
  if (unknown) {
    await expect(readout).toContainText('Duration unknown | Frame unknown / count unknown | FPS unknown')
    const firstFrame = waitForFrameResponse(page, '0')
    await controls.getByRole('button', { name: 'Next frame', exact: true }).click()
    await firstFrame
    await expect(readout).toContainText('Time unknown / Duration unknown | Frame 0 / count unknown | FPS unknown')
    const secondFrame = waitForFrameResponse(page, '1')
    await page.keyboard.press('.')
    await secondFrame
    await expect(readout).toContainText('Frame 1 / count unknown')
  } else {
    const slider = controls.getByRole('slider', { name: 'Video position' })
    await slider.focus()
    await page.keyboard.press('End')
    await expect(readout).toContainText('Frame unknown / 1 (estimated)')
    await expect(readout).toContainText('24.000 fps')
    await expect(readout.getByTitle('Reported FPS; not used to convert time and frame index')).toBeVisible()
    await page.keyboard.press('Home')
    await controls.getByRole('button', { name: 'Next frame', exact: true }).click()
    await expect(readout).toContainText('Frame 0 / 1 (estimated)')
    await page.keyboard.press('.')
    await expect(readout).toContainText('Frame 1 / 1 (estimated)')
    await page.keyboard.press('.')
    await expect(readout).toContainText('Frame 2 / 1 (estimated)')
    await expect(readout).toContainText('Time unknown')
  }
  expect(requests.map((url) => url.searchParams.get('frame')).filter((frame) => frame !== null && !frame.endsWith('s')))
    .toEqual(unknown ? ['0', '1'] : ['0', '1', '2'])
  await expect(controls).toContainText('Frame stepping starts at 0 after playback or time seek.')
  if (appView) {
    const thumb = (await controls.locator('.product-slider-thumb').boundingBox())!
    const button = (await controls.getByRole('button', { name: 'Next frame', exact: true }).boundingBox())!
    expect(button.y - thumb.y - thumb.height).toBeGreaterThanOrEqual(4)
  }
  await controls.screenshot({ path: testInfo.outputPath(`video-quality-${unknown ? 'unknown' : 'estimated'}-${appView ? 'app' : 'canvas'}.png`) })
})

test('frame stepping waits for the current indexed rendition before advancing', async ({ page }, testInfo) => {
  const selectors: string[] = []
  let release!: () => void
  const response = new Promise<void>((resolve) => { release = resolve })
  let received!: () => void
  const firstRequest = new Promise<void>((resolve) => { received = resolve })
  await install(page, undefined, meta, async (url) => {
    const selector = url.searchParams.get('frame')
    if (selector !== null) {
      selectors.push(selector)
      if (selector === '0') {
        received()
        await response
      }
    }
  })
  const controls = page.getByRole('group', { name: 'Video preview controls', exact: true })
  const next = controls.getByRole('button', { name: 'Next frame', exact: true })
  try {
    await next.click()
    await firstRequest
    await expect(next).toBeDisabled()
    await expect(next).toBeFocused()
    await page.keyboard.press('.')
    await page.keyboard.press(',')
    expect(selectors).toEqual(['0'])
    await controls.screenshot({ path: testInfo.outputPath('video-frame-pending.png') })
  } finally {
    release()
  }
  await expect(controls.getByTestId('video-timing')).toContainText('Frame 0 / 24')
  await next.click()
  await expect(controls.getByTestId('video-timing')).toContainText('Frame 1 / 24')
  expect(selectors).toEqual(['0', '1'])
})

test('legacy rendition kinds do not advertise frame or thumbnail selectors', async ({ page }, testInfo) => {
  const requests = await install(page, 'legacy-selectors')
  for (const appView of [false, true]) {
    if (appView) {
      await page.getByTestId('views-switcher').click()
      await page.getByRole('menuitemradio', { name: 'App view' }).click()
    }
    const controls = page.getByRole('group', { name: 'Video preview controls', exact: true })
    await controls.hover()
    await controls.focus()
    await page.keyboard.press('.')
    await expect(controls.getByRole('button', { name: 'Next frame', exact: true })).toBeDisabled()
    await expect(controls).toContainText('Frame selector unavailable: not advertised.')
    await controls.screenshot({ path: testInfo.outputPath(`video-legacy-selectors-${appView ? 'app' : 'canvas'}.png`) })
  }
  expect(requests.some((url) => ['frame', 'thumbs'].includes(url.searchParams.get('rendition') ?? ''))).toBe(false)
})

test('unshipped bounded renditions stay unavailable without original or disassemble requests', async ({ page }) => {
  const requests = await install(page, 'unadvertised')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews().video?.statusMessage))
    .toBe('Video unavailable: No bounded video preview or poster is advertised')
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await expect(page.getByTestId('app-preview-status')).toHaveText('Video unavailable: No bounded video preview or poster is advertised')
  expect(requests.every((url) => !url.searchParams.has('rendition'))).toBe(true)
})

test('shows real frame rendition refusals without an original download', async ({ page }, testInfo) => {
  const requests = await install(page, 'frame')
  const controls = page.getByRole('group', { name: 'Video preview controls', exact: true })
  await controls.getByRole('button', { name: 'Next frame', exact: true }).click()
  await expect(controls.getByRole('status')).toContainText('frame decoder unavailable (406, unavailable-rendition)')
  await controls.screenshot({ path: testInfo.outputPath('video-frame-refusal.png') })
  expect(requests.some((url) => url.searchParams.get('rendition') === 'original')).toBe(false)
})

test('keeps complete video rendition refusals visible in Canvas and App View', async ({ page }, testInfo) => {
  const requests = await install(page, 'all')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews().video?.statusMessage))
    .toContain('poster decoder unavailable (406, unavailable-rendition)')
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('video-rendition-refusal-canvas.png') })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await expect(page.getByTestId('app-preview-status')).toContainText('poster decoder unavailable (406, unavailable-rendition)')
  await page.getByTestId('app-preview-row').screenshot({ path: testInfo.outputPath('video-rendition-refusal-app.png') })
  expect(requests.some((url) => url.searchParams.get('rendition') === 'original')).toBe(false)
})

test('selected cloud-only VIDEO input explicitly waits for a bounded route in Canvas and App View', async ({ page }, testInfo) => {
  await install(page)
  const originals: string[] = []
  await page.route('**/api/assets/**', (route) => {
    originals.push(route.request().url())
    return route.fulfill({ status: 404, body: 'Original video must not be read' })
  })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'VideoInputTest', displayName: 'Cloud video input', category: 'test', source: 'v3',
      items: [{ kind: 'input', id: 'asset', type: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.VIDEO' } },
        widget: { widgetType: 'ASSET', options: { accept: ['video/*'] }, default: null } }],
    }])
    app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'video-input', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Video input', nodes: { input: { id: 'input', type: 'VideoInputTest', values: {
        asset: { digest: `blake3:${'a'.repeat(64)}`, name: 'cloud-only.mkv', mediaType: 'video/x-matroska', size: 1234, virtualPath: 'cloud/opaque-video' },
      } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { input: { position: { x: 80, y: 80 }, size: { width: 500, height: 300 } } } } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'g0', nodeId: 'input' }] },
    }, 'Cloud video input')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const before = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews().input?.statusMessage)).toBe('Video input preview pending server route')
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('video-input-unavailable-canvas.png') })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await expect(page.getByTestId('app-preview-status')).toHaveText('Video input preview pending server route')
  await page.getByTestId('app-preview-row').screenshot({ path: testInfo.outputPath('video-input-unavailable-app.png') })
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(before)
  expect(originals).toEqual([])
})
