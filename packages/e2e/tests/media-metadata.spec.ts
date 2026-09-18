import { expect, test, type WebSocketRoute } from '@playwright/test'

const PROOF = '../../docs/evidence/issue-457'

const descriptors = {
  image: { typeId: 'comfy.IMAGE', fingerprint: 'image-source', meta: { channels: { layout: 'rgba', alpha: 'straight' }, dtype: 'float32', color: { primaries: 1, transfer: 13, range: 2 }, storage_dtype: 'fp32' } },
  mask: { typeId: 'comfy.MASK', fingerprint: 'mask-source', meta: { polarity: 'coverage', semantic: 'selection', dtype: 'float32', storage_dtype: 'fp32' } },
  audio: { typeId: 'comfy.AUDIO', fingerprint: 'audio-source', meta: { sample_rate: 48000, channels: 2, layout: 'stereo', duration: 3.5, dtype: 'float32', storage_dtype: 'fp32' } },
  video: { typeId: 'comfy.VIDEO', fingerprint: 'video-source', meta: { container: 'mkv', probe: { video_codec: 'hevc', pix_fmt: 'yuv420p10le', alpha: false, bit_depth: 10, color_space: 'HDR PQ' }, effective: { duration: [7, 2], fps: [30000, 1001], frame_count: 105 } } },
  scalar: { typeId: 'core.float', fingerprint: 'scalar-source' },
  list: { typeId: 'list<comfy.IMAGE>', fingerprint: 'list-source' },
}

test.beforeEach(async ({ page }) => {
  await page.route('/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Not part of this isolated fixture' } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated test' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'media-test', schemaWire: 40 }, nodes: {} } }))
  await page.routeWebSocket('**/api/events?*', () => {})
})

test('inspects every media kind through the owning value API without mutating the graph or values', async ({ page, request }, testInfo) => {
  let socket: WebSocketRoute | undefined
  const backendRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/') || url.pathname === '/system_stats' || url.pathname === '/supervisor/status') backendRequests.push(`${request.method()} ${url.pathname}${url.search}`)
  })
  await page.routeWebSocket('**/api/events?*', (route) => { socket = route })
  await page.setViewportSize({ width: 1400, height: 1400 })
  const requests: URL[] = []
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    const descriptor = descriptors[url.searchParams.get('outputId') as keyof typeof descriptors]
    return route.fulfill({ json: { available: true, descriptor, renditions: [] } })
  })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await page.evaluate((outputs) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'MediaMetadataTest', displayName: 'Media metadata', category: 'test', source: 'v3', isOutputNode: true,
      items: Object.entries(outputs).map(([id, value]) => ({ kind: 'output', id, type: { kind: 'concrete', name: value.typeId } })),
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'media-metadata', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Media metadata', nodes: { media: { id: 'media', type: 'MediaMetadataTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { media: { position: { x: 100, y: 100 }, size: { width: 360, height: 280 } } } } } },
    }, 'Media metadata')
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'media-metadata-run' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { media: { state: 'done', outputs } } })
    store.apply({ kind: 'nodeOutput', execution: ref, runtimeNodeId: 'media', timestamp: Date.now(), output: {
      image: outputs.image, mask: outputs.mask, audio: outputs.audio,
    } })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
  }, descriptors)
  await page.locator('.dock-zone').getByRole('tab', { name: 'Outputs' }).click()
  await expect(page.locator('.media-value-inspector')).toHaveCount(4)
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const outputs = await page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'media-metadata-run')!.outputs)
  for (const [kind, expected] of [['image', 'straight'], ['mask', 'coverage'], ['audio', '48000'], ['video', 'HDR PQ']]) {
    const inspector = page.locator('.media-value-inspector').filter({ has: page.locator('summary', { hasText: `Inspect media / ${kind}` }) })
    await inspector.locator('summary').click()
    await expect(inspector).toContainText(expected!)
    await expect(inspector).toContainText(`${kind}-source`)
    if (kind === 'image') for (const [label, value] of [['Primaries', '1'], ['Transfer', '13'], ['Range', '2']]) {
      await expect(inspector.locator('dl > div').filter({ has: page.locator('dt', { hasText: label! }) }).locator('dd')).toHaveText(value!)
    }
    expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await inspector.screenshot({ path: testInfo.outputPath(`${kind}-inspector.png`) })
    if (kind !== 'video') await inspector.locator('summary').click()
  }
  expect(requests.every((url) => !url.searchParams.has('rendition') && url.searchParams.get('jobId') === 'media-metadata-run' && url.searchParams.get('nodeId') === 'media')).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.getByTestId('outputs-panel').screenshot({ path: testInfo.outputPath('media-output-inspection.png') })
  await expect.poll(() => socket !== undefined).toBe(true)
  const receipt = JSON.stringify({ type: 'value_diagnostics', jobId: 'media-metadata-run', nodeId: 'media', detail: { diagnostics: [
      { code: 'alpha_dropped', nodeId: 'media', outputId: 'image', inputId: 'rgba' },
      { code: 'alpha_dropped', nodeId: 'media', outputId: 'image', inputIds: ['rgba'] },
      { code: 'mask_polarity_mismatch', nodeId: 'media', inputId: 'mask', expected: 'coverage', actual: 'transparency' },
  ] } })
  socket!.send(receipt)
  socket!.send(receipt)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  const diagnostics = page.getByRole('status').filter({ has: page.getByRole('heading', { name: 'Media diagnostics' }) })
  await expect(diagnostics).toContainText('alpha_dropped')
  await expect(diagnostics).toContainText('rgba')
  await expect(diagnostics.locator('dl').nth(0)).toContainText('Coerced input')
  await expect(diagnostics.locator('dl').nth(1)).toContainText('Alpha inputs')
  await expect(diagnostics).toContainText('mask_polarity_mismatch')
  await expect(diagnostics).toContainText('transparency')
  await expect(diagnostics.locator('dl')).toHaveCount(3)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getBadges()['media']?.map((badge) => badge.id))).toEqual(['core.media.alpha_dropped.media.image', 'core.media.mask_polarity_mismatch.media.mask'])
  await diagnostics.screenshot({ path: testInfo.outputPath('media-diagnostics.png') })
  await page.screenshot({ path: testInfo.outputPath('media-warning-badges.png') })
  const videoInspector = page.locator('.media-value-inspector').filter({ has: page.locator('summary', { hasText: 'Inspect media / video' }) })
  const summary = videoInspector.locator('summary')
  await videoInspector.evaluate((element) => { element.setAttribute('data-mounted-identity', 'video-inspector') })
  await summary.evaluate((element) => { element.setAttribute('data-mounted-identity', 'video-summary') })
  await diagnostics.evaluate((element) => { element.setAttribute('data-mounted-identity', 'diagnostics') })
  await diagnostics.locator('dl').nth(0).evaluate((element) => { element.setAttribute('data-mounted-identity', 'diagnostic-row') })
  await summary.focus()
  const mountedInspector = page.locator('[data-mounted-identity="video-inspector"]')
  const mountedSummary = page.locator('[data-mounted-identity="video-summary"]')
  const mountedDiagnostics = page.locator('[data-mounted-identity="diagnostics"]')
  const beforeLocaleRequests = [...backendRequests]
  const beforeLocaleValueRequests = requests.length
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.getByTestId('outputs-panel').screenshot({ path: `${PROOF}/media-inspector-i18n-en.png` })

  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'mediaInspector.diagnostics.actualPolarity': '[Tatsachliche Polaritat]',
      'mediaInspector.diagnostics.alphaInputs': '[Alpha-Eingaben]',
      'mediaInspector.diagnostics.coercedInput': '[Umgewandelte Eingabe]',
      'mediaInspector.diagnostics.diagnostic': '[Diagnose]',
      'mediaInspector.diagnostics.expectedPolarity': '[Erwartete Polaritat]',
      'mediaInspector.diagnostics.inputId': '[Eingabe-ID]',
      'mediaInspector.diagnostics.title': '[Mediendialog]',
      'mediaInspector.fact.fingerprint': '[Fingerabdruck]',
      'mediaInspector.fact.outputId': '[Ausgabe-ID]',
      'mediaInspector.fact.runtimeNode': '[Laufzeitknoten]',
      'mediaInspector.metadata.alpha': '[Alpha]',
      'mediaInspector.metadata.bitDepth': '[Bittiefe]',
      'mediaInspector.metadata.codec': '[Codec]',
      'mediaInspector.metadata.colorSpace': '[Farbraum]',
      'mediaInspector.metadata.container': '[Behalter]',
      'mediaInspector.metadata.durationSeconds': '[Dauer (s)]',
      'mediaInspector.metadata.fps': '[Bilder/s]',
      'mediaInspector.metadata.frameCount': '[Bildanzahl]',
      'mediaInspector.metadata.no': '[Nein]',
      'mediaInspector.metadata.notReported': '[Nicht gemeldet]',
      'mediaInspector.metadata.pixelFormat': '[Pixelformat]',
      'mediaInspector.metadata.storageDtype': '[Speichertyp]',
      'mediaInspector.summary.inspect': '[Pruefe {nodeId} :: {outputId}]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(mountedSummary).toHaveText('[Pruefe media :: video]')
  await expect(mountedInspector).toHaveCount(1)
  await expect(mountedSummary).toHaveCount(1)
  await expect(mountedDiagnostics).toHaveCount(1)
  await expect(mountedDiagnostics.locator('dl').nth(0)).toHaveAttribute('data-mounted-identity', 'diagnostic-row')
  await expect(mountedSummary).toBeFocused()
  await expect(mountedInspector).toContainText('[Speichertyp]')
  await expect(mountedInspector).toContainText('[Nein]')
  await expect(mountedInspector).toContainText('Type')
  await expect(mountedInspector).toContainText('comfy.VIDEO')
  await expect(mountedInspector).toContainText('video-source')
  await expect(mountedInspector).toContainText('HDR PQ')
  await expect(mountedDiagnostics).toContainText('[Mediendialog]')
  await expect(mountedDiagnostics).toContainText('alpha_dropped')
  await expect(mountedDiagnostics).toContainText('mask_polarity_mismatch')
  await expect(mountedDiagnostics).toContainText('rgba')
  await expect(mountedDiagnostics).toContainText('coverage')
  await expect(mountedDiagnostics).toContainText('transparency')
  expect(backendRequests).toEqual(beforeLocaleRequests)
  expect(requests).toHaveLength(beforeLocaleValueRequests)
  await page.getByTestId('outputs-panel').screenshot({ path: `${PROOF}/media-inspector-i18n-de-DE.png` })
  expect(await page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'media-metadata-run')!.status)).toBe('completed')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  expect(await page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'media-metadata-run')!.outputs)).toEqual(outputs)
})

for (const [colorTransform, video] of [[undefined, false], ['PQ to sRGB', false], [undefined, true]] as const)
test(`shows transparent pixels without changing source bytes, server conversion ${colorTransform ?? 'absent'}, video poster ${video}`, async ({ page }, testInfo) => {
  if (video) await page.addInitScript(() => { Object.defineProperty(window, 'OffscreenCanvas', { value: undefined }) })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 200
    const context = canvas.getContext('2d')!
    context.fillStyle = '#f43f5e'
    context.fillRect(60, 40, 120, 120)
    context.fillStyle = '#3b82f680'
    context.fillRect(140, 70, 120, 90)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.route(/\/view(?:\?|$)/, (route) => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }))
  const requests: string[] = []
  const descriptor = video ? descriptors.video : descriptors.image
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url())
    const kind = url.searchParams.get('rendition')
    if (kind !== null) requests.push(kind)
    if (video && kind === 'preview') return route.fulfill({ status: 406, json: {
      available: false, reason: 'unavailable-rendition', error: 'Preview encoder unavailable',
    } })
    return url.searchParams.has('rendition')
      ? route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'), headers: {
          'X-Dinkster-Fingerprint': descriptor.fingerprint, 'X-Dinkster-Rendition': video ? 'poster' : 'png',
          ...(colorTransform === undefined ? {} : { 'X-Dinkster-Color-Transform': colorTransform }),
        } })
      : route.fulfill({ json: { available: true, descriptor, renditions: video ? [
          { kind: 'original', mime: 'video/x-matroska', default: true },
          { kind: 'preview', mime: 'video/mp4' }, { kind: 'poster', mime: 'image/png' },
        ] : [{ kind: 'png', mime: 'image/png', default: true }] } })
  })
  await page.evaluate(({ converted, descriptor }) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'TransparentMediaTest', displayName: 'Transparent image', category: 'test', source: 'v3', isOutputNode: true,
      emitsPreviews: true,
      items: [{ kind: 'output', id: 'images', type: { kind: 'concrete', name: descriptor.typeId }, preview: true }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'transparent-media', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Transparent media', nodes: { image: { id: 'image', type: 'TransparentMediaTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { image: { position: { x: 80, y: 80 }, size: { width: 400, height: 320 } } } } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'g0', nodeId: 'image' }] },
    }, 'Transparent media')
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'transparent-media-run' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { image: { state: 'done' } } })
    store.apply({ kind: 'nodeOutput', execution: ref, runtimeNodeId: 'image', timestamp: Date.now(), output: { images: converted ? descriptor : [{ filename: 'transparent.png' }] } })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { converted: colorTransform !== undefined || video, descriptor })
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const outputs = await page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'transparent-media-run')!.outputs)
  await page.locator('.dock-zone').getByRole('tab', { name: 'Outputs' }).click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews()['image']?.width)).toBe(320)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews()['image']?.colorTransform)).toBe(colorTransform)
  await page.screenshot({ path: testInfo.outputPath('transparent-canvas-output.png') })
  if (colorTransform === undefined && !video) {
    await expect(page.locator('.output-thumbnail img')).toBeVisible()
    await page.locator('.output-thumbnail').click()
    await expect(page.getByTestId('output-viewer-image')).toBeVisible()
    await page.getByTestId('output-viewer').screenshot({ path: testInfo.outputPath('transparent-viewer.png') })
    await page.keyboard.press('Escape')
  }
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  const preview = page.getByTestId('app-preview-image')
  await expect(preview).toBeVisible()
  await expect(preview).toHaveCSS('background-image', /conic-gradient/)
  const alpha = await preview.evaluate((element) => (element as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 1, 1).data[3])
  expect(alpha).toBe(0)
  if (colorTransform !== undefined) await expect(page.getByTestId('app-preview-color-transform')).toHaveText(`Preview color: ${colorTransform}`)
  if (colorTransform !== undefined || video) {
    await expect(page.getByTestId('app-preview-download')).toHaveText('Download preview')
    const downloaded = await page.getByTestId('app-preview-download').evaluate(async (element) =>
      Array.from(new Uint8Array(await (await fetch((element as HTMLAnchorElement).href)).arrayBuffer())))
    expect(Buffer.from(downloaded).toString('base64')).toBe(png)
  }
  if (video) {
    expect(requests).toContain('preview')
    expect(requests).toContain('poster')
    expect(requests.every((kind) => kind === 'preview' || kind === 'poster')).toBe(true)
  }
  await page.getByTestId('app-preview-row').screenshot({ path: testInfo.outputPath('transparent-app-view.png') })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  expect(await page.evaluate(() => [...window.__dinksterTest!.app.store.executions.get().values()].find((entry) => entry.ref.prompt === 'transparent-media-run')!.outputs)).toEqual(outputs)
  expect(errors).toEqual([])
})
