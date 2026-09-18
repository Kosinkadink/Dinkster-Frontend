import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const descriptor = { typeId: 'comfy.AUDIO', fingerprint: 'audio-source-unchanged', meta: { sample_rate: 48000, channels: 6, layout: '5.1', duration: 12, batch: 3 } }
const renditions = [
  { kind: 'original', mime: 'audio/wav', default: true },
  { kind: 'waveform', mime: 'image/png', version: 'wave-v1', parameters: ['batch', 'waveform'], defaults: { batch: '0' }, limits: { width: 2048, height: 512, pixels: 262144 } },
  { kind: 'window', mime: 'audio/wav', version: 'window-v1', parameters: ['batch', 'window'], defaults: { batch: '0' }, limits: { durationSeconds: 30, sampleValues: 8388608 } },
]
function wav(): Buffer {
  const out = Buffer.alloc(44 + 48000 * 3 * 6 * 2)
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(6, 22)
  out.writeUInt32LE(48000, 24); out.writeUInt32LE(48000 * 6 * 2, 28); out.writeUInt16LE(12, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36); out.writeUInt32LE(out.length - 44, 40)
  for (let index = 44; index < out.length; index += 2) out.writeInt16LE(Math.round(Math.sin(index / 60) * 2000), index)
  return out
}
test.beforeEach(async ({ page }) => {
  await page.route('/api/**', (route) => route.fulfill({ status: 404, json: { error: 'Not part of this isolated fixture' } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated test' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'test' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'audio-test', schemaWire: 40 }, nodes: {} } }))
  await page.route('/api/mounts*', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.routeWebSocket('**/api/events?*', () => {})
})

async function graph(page: Page, recorded = false) {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await page.evaluate(({ audioDescriptor, recorded }) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'AudioControlsTest', displayName: 'Audio waveform and recording', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'input', id: 'clip', type: { kind: 'asset', element: { kind: 'concrete', name: 'comfy.AUDIO' } }, optional: true, widget: { widgetType: 'ASSET', kind: 'media/audio', allowUpload: true, options: { accept: ['audio/wav', 'audio/flac', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'video/mp4'] } } },
        { kind: 'output', id: 'audio', type: { kind: 'concrete', name: 'comfy.AUDIO' }, preview: true },
      ],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audio-controls', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Audio controls', nodes: { audio: { id: 'audio', type: 'AudioControlsTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { audio: { position: { x: 80, y: 80 }, size: { width: 530, height: 430 } } } } } },
      ext: { 'dinkster.exposedPreviews': [{ graphId: 'g0', nodeId: 'audio' }] },
    }, 'Audio controls')
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'audio-run' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void; hydrateArtifacts(ref: unknown, artifacts: readonly unknown[]): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { audio: { state: 'done', outputs: recorded ? {} : { audio: audioDescriptor } } } })
    if (recorded) store.hydrateArtifacts(ref, [{
      nodeId: 'audio', digest: `blake3:${'c'.repeat(64)}`, name: '../recording.wav',
      size: 1728044, mediaType: 'audio/wav', virtualPath: 'output/recording.wav',
    }])
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { audioDescriptor: descriptor, recorded })
}

test('recorded audio downloads only on click in Canvas and App View', async ({ page }, info) => {
  const bytes = wav()
  let requests = 0
  let refuse = true
  await page.route(`**/api/assets/${encodeURIComponent(`blake3:${'c'.repeat(64)}`)}`, (route) => {
    if (refuse) return route.fulfill({ status: 404, body: 'Recorded bytes unavailable' })
    requests++
    return route.fulfill({ contentType: 'audio/wav', body: bytes })
  })
  await graph(page, true)
  for (const appView of [false, true]) {
    if (appView) {
      await page.getByTestId('views-switcher').click()
      await page.getByRole('menuitemradio', { name: 'App view' }).click()
    }
    const link = appView ? page.getByTestId('app-preview-download') : page.locator('.node-media-overlay .node-output-download')
    await expect(link).toBeVisible()
    expect(requests).toBe(appView ? 1 : 0)
    if (!appView) {
      await link.click()
      await expect(page.getByRole('alert')).toContainText('Recorded output request failed (404)')
      await page.locator('.node-media-overlay').screenshot({ path: info.outputPath('audio-download-refusal.png') })
      refuse = false
    }
    const pending = page.waitForEvent('download')
    await link.click()
    const download = await pending
    expect(download.suggestedFilename()).toBe('_recording.wav')
    expect(await readFile((await download.path())!)).toEqual(bytes)
    expect(requests).toBe(appView ? 2 : 1)
  }
})

test('waveform, window scrub, batch, local loop/gain and App playback', async ({ page }, info) => {
  const requests: URL[] = []
  let png: Buffer
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url()); requests.push(url)
    const kind = url.searchParams.get('rendition')
    return kind === null ? route.fulfill({ json: { available: true, descriptor, renditions } }) : route.fulfill({
      contentType: kind === 'waveform' ? 'image/png' : 'audio/wav', body: kind === 'waveform' ? png : wav(),
      headers: { 'X-Dinkster-Fingerprint': descriptor.fingerprint, 'X-Dinkster-Rendition': kind, ...(kind === 'waveform' ? { 'X-Dinkster-Waveform': 'sampled-peak' } : {}) },
    })
  })
  // Generate a fixed-size server-rendition fixture, not a client audio decode.
  await page.goto('/')
  png = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#11151b'; ctx.fillRect(0, 0, 512, 128); ctx.strokeStyle = '#77bbaa'
    for (let x = 0; x < 512; x += 2) { const h = 8 + Math.abs(Math.sin(x / 21)) * 45; ctx.beginPath(); ctx.moveTo(x, 64 - h); ctx.lineTo(x, 64 + h); ctx.stroke() }
    return canvas.toDataURL().split(',')[1]!
  }), 'base64')
  await graph(page)
  const transport = page.locator('.node-media-overlay .audio-transport')
  await expect(transport.getByRole('img', { name: 'Server audio waveform' })).toBeVisible()
  await expect(transport).toContainText('Channels: 6')
  await expect(transport).toContainText('Layout: 5.1')
  await expect(transport).toContainText('Sample rate (Hz): 48000')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await transport.getByRole('slider', { name: 'Audio position', exact: true }).click({ position: { x: 100, y: 5 } })
  await expect.poll(() => requests.some((url) => Number(url.searchParams.get('window')?.split(',')[0]) > 0)).toBe(true)
  await transport.getByRole('button', { name: 'Play audio' }).click()
  await expect(transport.getByRole('button', { name: 'Pause audio' })).toBeVisible()
  await transport.getByRole('button', { name: 'Pause audio' }).click()
  await transport.getByRole('checkbox', { name: 'Loop' }).check()
  await transport.getByRole('slider', { name: 'Audio gain', exact: true }).press('Home')
  expect(await transport.locator('audio').evaluate((el) => (el as HTMLAudioElement).volume)).toBe(0)
  await transport.getByRole('button', { name: 'Next audio batch' }).click()
  await expect(transport).toContainText('Batch 2/3')
  await expect.poll(() => requests.some((url) => url.searchParams.get('batch') === '1')).toBe(true)
  expect(requests.every((url) => !url.searchParams.has('element'))).toBe(true)
  await expect(transport).toContainText('Waveform: sampled peaks (not exhaustive)')
  await expect(transport.getByRole('button', { name: 'Play audio' })).toBeEnabled()
  await transport.screenshot({ path: info.outputPath('audio-waveform-window.png') })
  expect(requests.filter((url) => url.searchParams.has('window')).every((url) => Number(url.searchParams.get('window')!.split(',')[1]) <= 3)).toBe(true)
  expect(requests.filter((url) => url.searchParams.has('waveform')).every((url) => url.searchParams.get('waveform') === '512x128')).toBe(true)
  expect(requests.some((url) => url.searchParams.get('rendition') === 'original')).toBe(false)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.getByTestId('views-switcher').click(); await page.getByRole('menuitemradio', { name: 'App view' }).click()
  const appPreview = page.getByTestId('app-preview-surface')
  await expect(appPreview.getByRole('img', { name: 'Server audio waveform' })).toBeVisible()
  await appPreview.screenshot({ path: info.outputPath('audio-app-preview.png') })
})

test('missing audio rendition capabilities stay visible without a full download', async ({ page }, info) => {
  const requested: string[] = []
  await page.route('**/api/values?*', (route) => {
    const kind = new URL(route.request().url()).searchParams.get('rendition')
    if (kind) requested.push(kind)
    return route.fulfill({ json: { available: true, descriptor, renditions: renditions.map(({ kind, mime }) => ({ kind, mime })) } })
  })
  await graph(page)
  const transport = page.locator('.node-media-overlay .audio-transport')
  await expect(transport).toContainText('Audio waveform unavailable: backend does not advertise usable parameters, defaults, limits and version')
  await expect(transport).toContainText('Audio window unavailable: backend does not advertise usable parameters, defaults, limits and version')
  await expect(transport.getByRole('button', { name: 'Play audio' })).toBeDisabled()
  await expect(transport.getByRole('button', { name: 'Next audio batch' })).toBeDisabled()
  await expect(transport.getByRole('slider', { name: 'Audio position', exact: true })).toBeDisabled()
  expect(requested).toEqual([])
  await transport.screenshot({ path: info.outputPath('audio-capability-unavailable.png') })
})

for (const denied of [true, false]) test(`recording asset flow, permission denied ${denied}`, async ({ page }, info) => {
  await page.addInitScript((deny) => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      if (deny) throw new DOMException('Test denial', 'NotAllowedError')
      const context = new AudioContext(); const tone = context.createOscillator(); const output = context.createMediaStreamDestination()
      tone.connect(output); tone.start(); await context.resume()
      const track = output.stream.getAudioTracks()[0]!
      const stop = track.stop.bind(track)
      track.stop = () => { tone.stop(); void context.close(); stop() }
      return output.stream
    } })
  }, denied)
  let uploads = 0
  let uploadedBytes: Buffer | undefined
  let uploadedContentType: string | undefined
  const asset = { digest: `blake3:${'a'.repeat(64)}`, name: 'recording.webm', size: 100, mediaType: 'audio/webm', virtualPath: '' }
  await page.route('**/api/assets/media?*', async (route) => {
    uploads++
    uploadedBytes = route.request().postDataBuffer() ?? Buffer.alloc(0)
    uploadedContentType = route.request().headers()['content-type']
    asset.size = uploadedBytes.length
    await route.fulfill({ json: { asset, kind: 'media/audio' } })
  })
  await graph(page)
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!; const node = renderer.getScene().nodes.find((entry) => entry.id === 'audio')!
    const row = node.layout.rows.find((entry) => entry.kind === 'widget' && entry.inputId === 'clip')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.dblclick(point.x, point.y)
  const recorder = page.getByRole('region', { name: 'Record audio', exact: true })
  await expect(recorder).toBeVisible()
  expect(uploads).toBe(0)
  await recorder.getByRole('button', { name: 'Record microphone' }).click()
  if (denied) {
    await expect(recorder).toContainText('Microphone permission denied')
    await recorder.screenshot({ path: info.outputPath('audio-permission-denied.png') })
    expect(uploads).toBe(0)
  } else {
    await expect(recorder).toContainText('Recording microphone')
    await expect(recorder.getByTestId('audio-recorded-bytes')).toHaveText(/Recorded [1-9][0-9]* bytes/)
    await recorder.getByRole('button', { name: 'Stop recording' }).click()
    await expect(recorder.getByRole('button', { name: 'Save recording' })).toBeVisible()
    await recorder.getByRole('button', { name: 'Save recording' }).click()
    await expect(recorder).toContainText('Recording saved to the asset selection')
    expect(uploads).toBe(1)
    expect(uploadedBytes?.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
    expect(uploadedContentType).toBe('audio/webm')
    await page.getByTestId('asset-editor').screenshot({ path: info.outputPath('audio-record-save.png') })
    await page.getByTestId('asset-apply').click()
    const value = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['audio']!.values['clip'])
    expect(value).toEqual(asset)
  }
})
