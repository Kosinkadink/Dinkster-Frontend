import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, nativeTest as test, waitForWorkspaceReady, type Page, type Route } from './fixtures.js'

const proofDir = process.env.DINKSTER_MEDIA_PROOF_DIR ?? '/tmp/dinkster-media-proof'
const fixtureDir = resolve(import.meta.dirname, '../fixtures/media-overlay')
const mp4 = readFileSync(resolve(fixtureDir, 'with_metadata.mp4'))
const webm = readFileSync(resolve(fixtureDir, 'with_metadata.webm'))
const png = readFileSync(resolve(fixtureDir, 'with_metadata.png'))
const previewCaptionHeight = 22

function wav(): Buffer {
  const rate = 8000
  const samples = rate
  const body = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index += 1) {
    body.writeInt16LE(Math.round(Math.sin(index * Math.PI * 2 * 440 / rate) * 12000), index * 2)
  }
  const out = Buffer.alloc(44 + body.length)
  out.write('RIFF', 0)
  out.writeUInt32LE(out.length - 8, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36)
  out.writeUInt32LE(body.length, 40)
  body.copy(out, 44)
  return out
}

const audio = wav()
const outputs = [
  { id: 'image', type: 'IMAGE', kind: 'image', rendition: 'png', mime: 'image/png' },
  { id: 'mp4', type: 'VIDEO', kind: 'video', rendition: 'preview', mime: 'video/mp4' },
  { id: 'webm', type: 'VIDEO', kind: 'video', rendition: 'preview', mime: 'video/webm' },
  { id: 'audio', type: 'AUDIO', kind: 'audio', rendition: 'window', mime: 'audio/wav' },
  { id: 'list', type: 'list<VIDEO>', kind: 'video', rendition: 'preview', mime: 'video/mp4' },
  { id: 'saved', type: 'VIDEO', kind: 'video', rendition: 'preview', mime: 'video/mp4' },
] as const

async function mockBackend(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: '31658bf8-proof', schemaWire: 2 },
    nodes: {},
  } }))
  await page.route('/api/assets/**', (route) => route.fulfill({
    status: 200,
    contentType: 'video/mp4',
    body: mp4,
  }))
  await page.route(/\/view(?:\?|$)/, (route) => route.fulfill({
    status: 200,
    contentType: 'image/png',
    body: png,
  }))
  await page.route('**/api/values*', async (route) => serveValue(route))
}

async function serveValue(route: Route, sound?: { waveform?: Buffer; failure?: boolean; batch?: boolean }): Promise<void> {
  const url = new URL(route.request().url())
  const output = url.searchParams.get('outputId') ?? ''
  if (output === 'failed') {
    await route.fulfill({ status: 410, json: { available: false, reason: 'evicted', error: 'proof eviction' } })
    return
  }
  const spec = outputs.find((item) => item.id === output)
  if (spec === undefined) {
    await route.fulfill({ status: 404, json: { available: false, reason: 'unknown-output', error: output } })
    return
  }
  const rendition = url.searchParams.get('rendition')
  if (rendition !== null) {
    const waveform = output === 'audio' && rendition === 'waveform'
    const body = waveform ? sound?.waveform ?? png : output === 'image' ? png : output === 'webm' ? webm : output === 'audio' ? sound?.failure ? Buffer.from('unplayable sound') : audio : mp4
    await route.fulfill({
      status: 200,
      contentType: waveform ? 'image/png' : spec.mime,
      headers: {
        'X-Dinkster-Fingerprint': `proof-${output}`,
        'X-Dinkster-Rendition': rendition,
        'X-Dinkster-Type-Id': spec.type,
        ...(waveform ? { 'X-Dinkster-Waveform': 'sampled-peak' } : {}),
      },
      body,
    })
    return
  }
  const element = url.searchParams.get('element')
  const descriptor = output === 'list' && element === null
    ? { typeId: spec.type, fingerprint: 'proof-list', length: 3 }
    : {
        typeId: output === 'list' ? 'VIDEO' : spec.type,
        fingerprint: `proof-${output}`,
        ...(output === 'audio' ? { meta: { duration: 1, sample_rate: 8000, channels: 1, ...(sound?.batch ? { batch: 4 } : {}) } } : {}),
      }
  await route.fulfill({ json: {
    available: true,
    descriptor,
    renditions: element === null && output === 'list'
      ? []
      : output === 'audio'
        ? [...(sound?.waveform ? [{ kind: 'waveform', mime: 'image/png', version: 'waveform-v1', parameters: ['waveform'], limits: { width: 512, height: 128, pixels: 65536 } }] : []), {
            kind: 'window', mime: 'audio/wav', default: true, version: 'window-v1',
            parameters: sound?.batch ? ['window', 'batch'] : ['window'], defaults: sound?.batch ? { batch: '0' } : {},
            limits: { durationSeconds: 3, sampleValues: 24_000 },
          }]
        : [{ kind: spec.rendition, mime: spec.mime, default: true }],
  } })
}

async function installGraph(page: Page, associatedImage = false): Promise<void> {
  await page.evaluate(async (associatedImage) => {
    const concrete = (name: string) => ({ kind: 'concrete', name } as const)
    const schema = (type: string, output: string, valueType: ReturnType<typeof concrete>, preview = true) => ({
      type,
      displayName: type,
      category: 'proof',
      source: 'v3' as const,
      isOutputNode: true,
      body: [{ kind: 'output' as const, id: output, type: valueType, ...(preview ? { preview: true } : {}) }],
    })
    window.__dinksterTest!.app.registerSchemas([
      schema('ProofImage', 'image', concrete('IMAGE')),
      schema('ProofMp4', 'mp4', concrete('VIDEO')),
      schema('ProofWebm', 'webm', concrete('VIDEO')),
      schema('ProofAudio', 'audio', concrete('AUDIO')),
      schema('ProofSavedVideo', 'saved', concrete('VIDEO')),
      {
        ...schema('ProofList', 'list', concrete('VIDEO')),
        body: [{ kind: 'output' as const, id: 'list', type: { kind: 'list' as const, element: concrete('VIDEO') }, preview: true }],
      },
      schema('ProofFailed', 'failed', concrete('VIDEO')),
      schema('ProofUnmarked', 'unmarked', concrete('VIDEO'), false),
      schema('ProofText', 'text', concrete('STRING'), false),
    ])
    const nodes = {
      image: { id: 'image', type: 'ProofImage', values: {} },
      mp4: { id: 'mp4', type: 'ProofMp4', values: {} },
      webm: { id: 'webm', type: 'ProofWebm', values: {} },
      audio: { id: 'audio', type: 'ProofAudio', values: {} },
      saved: { id: 'saved', type: 'ProofSavedVideo', values: {} },
      list: { id: 'list', type: 'ProofList', values: {} },
      failed: { id: 'failed', type: 'ProofFailed', values: {} },
      unmarked: { id: 'unmarked', type: 'ProofUnmarked', values: {} },
      text: { id: 'text', type: 'ProofText', values: {} },
    }
    const positions = Object.fromEntries(Object.keys(nodes).map((id, index) => [id, {
      position: { x: 50 + index % 3 * 430, y: 60 + Math.floor(index / 3) * 390 },
      size: { width: 360, height: 320 },
    }]))
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'media-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 20 } },
      view: { graphs: { g0: { nodes: positions } } },
    } as never, 'Media Overlay Proof')
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(`compile failed: ${JSON.stringify(compiled?.diagnostics)}`)
    const ref = { connection: compiled.artifact.connection, prompt: 'media-proof-job' }
    const store = app.store as unknown as {
      register(execution: { connection: string; prompt: string }, artifact: unknown, now: number): void
      apply(event: unknown): void
      hydrateArtifacts(execution: { connection: string; prompt: string }, artifacts: readonly unknown[]): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    const descriptor = (typeId: string, fingerprint: string) => ({ typeId, fingerprint })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: {
        image: { state: 'done', outputs: { image: descriptor('IMAGE', 'proof-image') } },
        mp4: { state: 'done', outputs: { mp4: descriptor('VIDEO', 'proof-mp4') } },
        webm: { state: 'done', outputs: { webm: descriptor('VIDEO', 'proof-webm') } },
        audio: { state: 'done', outputs: { audio: descriptor('AUDIO', 'proof-audio') } },
        saved: { state: 'done', outputs: { saved: descriptor('VIDEO', 'proof-saved') } },
        list: { state: 'done', outputs: { list: descriptor('list<VIDEO>', 'proof-list') } },
        failed: { state: 'done', outputs: { failed: descriptor('VIDEO', 'proof-failed') } },
        unmarked: { state: 'done', outputs: { unmarked: descriptor('VIDEO', 'proof-unmarked') } },
        text: { state: 'done', outputs: { text: { ...descriptor('STRING', 'proof-text'), value: 'Recorded text wins' } } },
      },
    })
    store.hydrateArtifacts(ref, associatedImage ? [{
      nodeId: 'saved', digest: `blake3:${'a'.repeat(64)}`, name: 'original.exr',
      size: 2 ** 30 + 1, mediaType: 'image/x-exr', virtualPath: 'output/original.exr',
      preview: { digest: `blake3:${'b'.repeat(64)}`, name: 'preview.png', size: 128,
        mediaType: 'image/png', virtualPath: `previews/${'b'.repeat(64)}/preview.png` },
    }] : [{
      nodeId: 'saved',
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'saved-result.mp4',
      size: 4043,
      mediaType: 'video/mp4',
      virtualPath: 'output/saved-result.mp4',
    }, {
      nodeId: 'saved',
      digest: `blake3:${'b'.repeat(64)}`,
      name: 'saved-result-2.mp4',
      size: 4043,
      mediaType: 'video/mp4',
      virtualPath: 'output/saved-result-2.mp4',
    }])
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, associatedImage)
}

test.beforeEach(async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await mockBackend(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined,
  )).toBe(true)
  await waitForWorkspaceReady(page)
})

async function installMediaProof(page: Page): Promise<void> {
  await installGraph(page)
  await expect(page.locator('.node-media-overlay[data-media-kind="video"]')).toHaveCount(4, { timeout: 15_000 })
  await expect(page.locator('.node-media-overlay[data-media-kind="audio"]')).toHaveCount(1)
}

test('sound controls fit the node and retain playback, seeking, looping and volume without diagnostic lines', async ({ page }, testInfo) => {
  const waveform = Buffer.from(await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 512; canvas.height = 128
    const context = canvas.getContext('2d')!
    context.fillStyle = 'white'
    for (let x = 0; x < 512; x += 4) {
      const peak = 8 + Math.abs(Math.sin(x * 0.07) * Math.cos(x * 0.019)) * 52
      context.fillRect(x, 64 - peak, 2, peak * 2)
    }
    return canvas.toDataURL('image/png').split(',')[1]!
  }), 'base64')
  for (const state of ['waveform', 'no-waveform', 'failure', 'batch'] as const) {
    if (state !== 'waveform') {
      await page.reload()
      await waitForWorkspaceReady(page)
    }
    await page.route('**/api/values*', (route) => serveValue(route, {
      ...(state === 'waveform' || state === 'batch' ? { waveform } : {}),
      failure: state === 'failure', batch: state === 'batch',
    }))
    await installGraph(page)
    await page.evaluate(() => {
      window.__dinksterTest!.renderer!.setViewport({ x: 200, y: -330, scale: 1 })
    })
    const preview = page.locator('.node-media-overlay[data-node-id="audio"]')
    const play = preview.getByRole('button', { name: 'Play audio' })
    const seek = preview.getByRole('slider', { name: 'Audio position' })
    const volume = preview.getByRole('slider', { name: 'Preview volume' })
    const loop = preview.getByRole('button', { name: 'Loop', exact: true })
    const element = preview.locator('audio')
    if (state === 'failure') {
      await expect(preview.getByRole('status')).toHaveText('This browser cannot play this sound')
      await expect(play).toBeDisabled()
      await expect(seek).toHaveAttribute('aria-disabled', 'true')
    } else {
      await expect(play).toBeEnabled()
      await expect.poll(() => element.evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThan(0)
      await loop.click()
      await expect(loop).toHaveAttribute('aria-pressed', 'true')
      await loop.focus(); await page.keyboard.press('Space')
      await expect(loop).toHaveAttribute('aria-pressed', 'false')
      await volume.click({ position: { x: 2, y: 8 } })
      await expect.poll(() => element.evaluate((audio: HTMLAudioElement) => audio.volume)).toBeLessThan(0.5)
      await volume.focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft')
      await expect(element).toHaveJSProperty('volume', 0.99)
      await seek.click({ position: { x: 10, y: 8 } })
      await expect.poll(() => seek.getAttribute('aria-valuenow')).not.toBe('0')
      await expect(play).toBeEnabled()
      await seek.focus(); await page.keyboard.press('Home')
      await expect(seek).toHaveAttribute('aria-valuenow', '0')
      await expect(play).toBeEnabled()
      for (const input of ['mouse', 'keyboard']) {
        await element.evaluate((audio: HTMLAudioElement) => {
          audio.addEventListener('playing', () => {
            audio.dataset['played'] = 'true'
            audio.closest('.audio-transport')!.querySelector<HTMLButtonElement>('[aria-label="Pause audio"]')!.click()
          }, { once: true })
          delete audio.dataset['played']
        })
        if (input === 'mouse') await play.click()
        else { await play.focus(); await page.keyboard.press('Enter') }
        await expect(element).toHaveAttribute('data-played', 'true')
        await expect(element).toHaveJSProperty('paused', true)
      }
      if (state === 'batch') {
        await preview.getByRole('button', { name: 'Next audio batch' }).click()
        await expect(preview).toContainText('2 of 4')
        await preview.getByRole('button', { name: 'Previous audio batch' }).focus()
        await page.keyboard.press('Enter')
        await expect(preview).toContainText('1 of 4')
      }
      await seek.focus(); await page.keyboard.press('Home')
      await expect(play).toBeEnabled()
    }
    await expect(preview).not.toContainText(/Not reported|Window preview|backend|Gain/)
    await page.evaluate(() => {
      const layout = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'audio')!.layout
      window.__dinksterTest!.app.activeTab()!.store.dispatch({ command: 'view.setNodeSize', params: {
        graphId: 'g0', nodeId: 'audio', size: { width: layout.minWidth, height: layout.minHeight },
      } })
    })
    await expect.poll(() => page.evaluate(() => {
      const layout = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'audio')!.layout
      return { width: layout.width - layout.minWidth, height: layout.height - layout.minHeight }
    })).toEqual({ width: 0, height: 0 })
    for (const scale of [1, 0.31]) {
      await page.evaluate((scale) => window.__dinksterTest!.renderer!.setViewport({ x: 250 - 50 * scale, y: 120 - 450 * scale, scale }), scale)
      await expect(play).toBeVisible()
      const overflow = await preview.evaluate((overlay) => {
        const bounds = overlay.getBoundingClientRect()
        return Array.from(overlay.querySelectorAll('.audio-waveform, .audio-transport-row, button, [role="slider"], .dinkster-audio-time')).filter((node) => {
          const rect = node.getBoundingClientRect()
          return rect.left < bounds.left - 0.5 || rect.right > bounds.right + 0.5 || rect.bottom > bounds.bottom + 0.5
        }).map((node) => node.className)
      })
      expect(overflow).toEqual([])
      const clip = await page.evaluate(() => {
        const renderer = window.__dinksterTest!.renderer!
        const node = renderer.getScene().nodes.find((node) => node.id === 'audio')!
        const viewport = renderer.getViewport()
        const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
        return { x: canvas.left + node.x * viewport.scale + viewport.x - 12,
          y: canvas.top + node.y * viewport.scale + viewport.y - 12,
          width: node.layout.width * viewport.scale + 24, height: node.layout.height * viewport.scale + 24 }
      })
      await page.screenshot({ path: testInfo.outputPath(`sound-${state}-${scale}.png`), animations: 'disabled', clip })
    }
  }
})

for (const previewAvailable of [true, false]) {
test(`saved files retain original downloads with ${previewAvailable ? 'available' : 'failed'} associated images`, async ({ page }, testInfo) => {
  const originalRequests: string[] = []
  await page.route('**/api/assets/**', async (route) => {
    if (route.request().url().includes('b'.repeat(64))) {
      await route.fulfill(previewAvailable
        ? { contentType: 'image/png', body: png }
        : { status: 410, body: 'Optional preview unavailable' })
    } else {
      originalRequests.push(route.request().url())
      await route.fulfill({ contentType: 'image/x-exr', body: 'original EXR bytes' })
    }
  })
  await installGraph(page, true)
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: -300, y: -300, scale: 1 })
  })
  await expect.poll(() => page.evaluate((available) => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews()['saved']
    return available
      ? preview?.image !== undefined && (preview.width ?? 0) > 0
      : preview?.status === 'failed' && preview.statusMessage === 'Preview unavailable'
  }, previewAvailable)).toBe(true)
  expect(originalRequests).toEqual([])
  const download = page.locator('a[download="original.exr"]')
  await expect(download).toHaveCount(1)
  await expect(download).toHaveAttribute('href', new RegExp('a'.repeat(64)))
  const clip = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'saved')!
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x * viewport.scale + viewport.x - 12,
      y: canvas.top + node.y * viewport.scale + viewport.y - 12,
      width: node.layout.width * viewport.scale + 24,
      height: node.layout.height * viewport.scale + 24,
    }
  })
  await page.screenshot({ path: testInfo.outputPath('saved-associated-preview.png'), animations: 'disabled', clip })
  const downloaded = page.waitForEvent('download')
  await download.click()
  expect((await downloaded).suggestedFilename()).toBe('original.exr')
  expect(originalRequests).toHaveLength(1)
})
}

test('saved execution video values use bounded renditions and shared host controls', async ({ page }, testInfo) => {
  await installMediaProof(page)
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'view.setNodeSize',
    params: { graphId: 'g0', nodeId: 'saved', size: { width: 420, height: 320 } },
  }))
  const savedOverlay = page.locator('.node-media-overlay[data-node-id="saved"]')
  const savedVideo = savedOverlay.locator('video')
  const savedControls = savedOverlay.getByRole('group', { name: 'Video preview controls' })
  await expect(savedVideo).toHaveCount(1)
  await expect(savedVideo).toHaveAttribute('src', /^blob:/)
  await expect(savedVideo).toHaveAttribute('preload', 'metadata')
  await expect(savedControls.getByRole('button', { name: 'Play video' })).toBeVisible()
  await expect(savedControls.getByRole('link', { name: 'Download preview' })).toHaveAttribute('download', 'preview.mp4')
  await expect(savedControls.getByRole('button', { name: 'Next video' })).toHaveCount(0)
  await expect.poll(() => savedVideo.evaluate((node: HTMLVideoElement) => node.duration)).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: -300, y: -300, scale: 1 }))
  const box = await savedOverlay.boundingBox()
  if (box === null) throw new Error('saved video overlay has no bounds')
  await page.screenshot({
    path: testInfo.outputPath('saved-video-rendition.png'),
    animations: 'disabled',
    clip: {
      x: Math.max(0, box.x - 4),
      y: Math.max(0, box.y - 4),
      width: Math.min(1440 - Math.max(0, box.x - 4), box.width + 8),
      height: Math.min(900 - Math.max(0, box.y - 4), box.height + 8),
    },
  })
})

test('real media, controls, zoom transitions, forwarding, clipping, and cleanup', async ({ page }) => {
  await installMediaProof(page)
  const videos = page.locator('.node-media-overlay[data-media-kind="video"] video')
  const videoControls = page.locator('.node-media-overlay[data-media-kind="video"]').getByRole('group', { name: 'Video preview controls' })
  const audioElement = page.locator('.node-media-overlay[data-media-kind="audio"] audio')
  await expect(videos).toHaveCount(4)
  await expect(audioElement).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer as unknown as {
      getNodePreviews(): Record<string, { image?: unknown }>
    }
    return renderer.getNodePreviews()['image']?.image !== undefined
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer as unknown as {
      getNodeOutputTexts(): Record<string, { text: string }>
    }
    return renderer.getNodeOutputTexts()['text']?.text
  })).toBe('Recorded text wins')
  await expect.poll(() => audioElement.evaluate((node: HTMLAudioElement) => node.duration)).toBeGreaterThan(0)
  await expect(audioElement).toHaveJSProperty('paused', true)
  await expect(page.locator('.node-media-count')).toHaveCount(0)
  const captionBoundary = await page.evaluate((captionHeight) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'list')
    const preview = node?.layout.preview
    const overlay = document.querySelector<HTMLElement>('.node-media-overlay[data-node-id="list"]')
    if (node === undefined || preview === undefined || overlay === null) throw new Error('missing list preview geometry')
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      overlayTop: overlay.getBoundingClientRect().top,
      captionBottom: canvas.top + (node.y + preview.y + captionHeight) * viewport.scale + viewport.y,
    }
  }, previewCaptionHeight)
  expect(captionBoundary.overlayTop).toBeCloseTo(captionBoundary.captionBottom, 1)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getNodePreviews()['failed']?.status,
  )).toBe('unavailable')
  await expect(page.locator('.node-media-overlay').filter({ has: page.locator('[src]') })).toHaveCount(5)
  await page.screenshot({ path: `${proofDir}/01-ready-mp4-webm-wav-list-failure.png`, animations: 'disabled' })

  // Observe playback and activate Pause in the same browser task so the
  // one-second fixture cannot end between the two transport assertions.
  const pauseOnPlayback = () => audioElement.evaluate((node: HTMLAudioElement) => {
    delete node.dataset['playingBeforePause']
    delete node.dataset['pausedByControl']
    node.addEventListener('playing', () => {
      node.dataset['playingBeforePause'] = String(!node.paused)
      const pause = node.closest('.audio-transport')?.querySelector<HTMLButtonElement>('button[aria-label="Pause audio"]')
      if (!pause?.checkVisibility()) throw new Error('playing audio has no visible Pause control')
      pause.click()
      node.dataset['pausedByControl'] = String(node.paused)
    }, { once: true })
  })
  const play = page.getByRole('button', { name: 'Play audio' })
  await pauseOnPlayback()
  await play.focus()
  await page.keyboard.press('Enter')
  await expect(audioElement).toHaveAttribute('data-playing-before-pause', 'true')
  await expect(audioElement).toHaveAttribute('data-paused-by-control', 'true')
  await expect(audioElement).toHaveJSProperty('paused', true)
  await audioElement.evaluate((node: HTMLAudioElement) => {
    node.currentTime = 0
    node.dispatchEvent(new Event('timeupdate'))
  })
  const seek = page.getByRole('slider', { name: 'Audio position' })
  let releaseWindow!: () => void
  let requestedWindow!: () => void
  const pendingWindow = new Promise<void>((resolve) => { releaseWindow = resolve })
  const windowRequested = new Promise<void>((resolve) => { requestedWindow = resolve })
  await page.route('**/api/values*', async (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('outputId') === 'audio' && Number(url.searchParams.get('window')?.split(',')[0]) > 0) {
      requestedWindow()
      await pendingWindow
    }
    await serveValue(route)
  })
  await seek.focus()
  await page.keyboard.press('ArrowRight')
  try {
    await windowRequested
    await audioElement.evaluate((node) => node.dispatchEvent(new Event('timeupdate')))
    await expect(seek).toHaveAttribute('aria-valuenow', '0.01')
    await page.screenshot({ path: `${proofDir}/02-pending-audio-seek.png`, animations: 'disabled' })
  } finally {
    releaseWindow()
  }
  await expect(page.getByRole('button', { name: 'Play audio' })).toBeEnabled()
  await expect(seek).toHaveAttribute('aria-valuenow', '0.01')
  await pauseOnPlayback()
  await page.getByRole('button', { name: 'Play audio' }).click()
  await expect(audioElement).toHaveAttribute('data-playing-before-pause', 'true')
  await expect(audioElement).toHaveAttribute('data-paused-by-control', 'true')
  await expect(audioElement).toHaveJSProperty('paused', true)
  await videoControls.first().focus()
  await expect(videoControls.first()).toBeFocused()
  const autoplay = videoControls.first().getByRole('button', { name: 'Autoplay video' })
  if (await autoplay.getAttribute('aria-pressed') === 'true') await autoplay.click()
  await videos.first().evaluate((video: HTMLVideoElement) => video.pause())
  await videoControls.first().getByRole('button', { name: 'Play video', exact: true }).click()
  await expect(videos.first()).toHaveJSProperty('paused', false)
  await page.screenshot({ path: `${proofDir}/02-keyboard-transport.png`, animations: 'disabled' })

  const beforeResize = await page.locator('.node-media-overlay[data-media-kind="video"]').first().boundingBox()
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: 'g0', nodeId: 'mp4', size: { width: 360, height: 240 } },
    })
  })
  await expect.poll(async () => (await page.locator('.node-media-overlay[data-media-kind="video"]').first().boundingBox())?.height)
    .toBeLessThan(beforeResize!.height)
  await page.screenshot({ path: `${proofDir}/03-resize-region.png`, animations: 'disabled' })

  const before = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  await page.locator('.node-media-overlay').first().dispatchEvent('wheel', { deltaY: 120, clientX: 200, clientY: 200 })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport().scale)).not.toBe(before.scale)

  for (const scale of [1.5, 1, 0.75, 0.6, 0.5, 0.3, 0.29]) {
    await page.evaluate((value) => window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 15, scale: value }), scale)
    if (scale >= 0.3) {
      await expect(videoControls.first().getByRole('button', { name: /^(Play|Pause) video$/ })).toBeVisible()
    } else {
      await expect(page.locator('.node-media-overlay')).toHaveCount(0)
    }
    await page.screenshot({ path: `${proofDir}/04-zoom-${String(scale).replace('.', '_')}.png`, animations: 'disabled' })
  }

  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: -200, y: 0, scale: 1 }))
  await expect(page.locator('.node-media-overlay').first()).not.toHaveCSS('clip-path', 'inset(0px 0px 0px 0px)')
  await page.screenshot({ path: `${proofDir}/05-clipped-overlay.png`, animations: 'disabled' })
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: -2000, y: -2000, scale: 1 }))
  await expect(page.locator('.node-media-overlay')).toHaveCount(0)
  await page.screenshot({ path: `${proofDir}/06-offscreen-cleanup.png`, animations: 'disabled' })
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await expect(page.locator('.node-media-overlay')).toHaveCount(5)

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', nodeIds: ['list'], linkIds: [] } })
  })
  await expect.poll(() => page.evaluate(() =>
    Object.hasOwn(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes, 'list'),
  )).toBe(false)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === 'list'),
  )).toBe(false)
  await expect(page.locator('.node-media-overlay[data-node-id="list"]')).toHaveCount(0)
  await page.screenshot({ path: `${proofDir}/07-node-delete-cleanup.png`, animations: 'disabled' })

  await page.getByRole('button', { name: 'Play audio' }).click()
  await expect(audioElement).toHaveJSProperty('paused', false)
  await audioElement.evaluate((node: HTMLAudioElement) => {
    (window as unknown as { proofAudio: HTMLAudioElement }).proofAudio = node
  })
  await page.evaluate(async () => {
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'media-proof-empty', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: {} } } },
    }, 'Empty Proof Tab')
  })
  await expect(page.locator('.node-media-overlay')).toHaveCount(0)
  expect(await page.evaluate(() =>
    (window as unknown as { proofAudio: HTMLAudioElement }).proofAudio.paused,
  )).toBe(true)
  await page.screenshot({ path: `${proofDir}/08-tab-switch-cleanup.png`, animations: 'disabled' })
})

test('visible media DOM stays capped while focused, playing, and selected previews remain mounted', async ({ page }, testInfo) => {
  await page.evaluate(async () => {
    const count = 30
    window.__dinksterTest!.app.registerSchemas([{
      type: 'ProofMp4', displayName: 'ProofMp4', category: 'proof', source: 'v3', isOutputNode: true,
      body: [{ kind: 'output', id: 'mp4', type: { kind: 'concrete', name: 'VIDEO' }, preview: true }],
    }])
    const nodes = Object.fromEntries(Array.from({ length: count }, (_, index) => {
      const id = `media-${index}`
      return [id, { id, type: 'ProofMp4', values: {} }]
    }))
    const positions = Object.fromEntries(Object.keys(nodes).map((id, index) => [id, {
      position: { x: 10 + index % 6 * 405, y: Math.floor(index / 6) * 285 },
      size: { width: 400, height: 280 },
      video: { loop: true, muted: true, autoplay: false },
    }]))
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dense-media-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 40 } },
      view: { graphs: { g0: { nodes: positions } } },
    } as never, 'Dense Media Proof')
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(`compile failed: ${JSON.stringify(compiled?.diagnostics)}`)
    const ref = { connection: compiled.artifact.connection, prompt: 'dense-media-proof-job' }
    const store = app.store as unknown as {
      register(execution: { connection: string; prompt: string }, artifact: unknown, now: number): void
      apply(event: unknown): void
      hydrateArtifacts(execution: { connection: string; prompt: string }, artifacts: readonly unknown[]): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: Object.fromEntries(Object.keys(nodes).map((id) => [id, {
        state: 'done',
        outputs: { mp4: { typeId: 'VIDEO', fingerprint: 'proof-mp4' } },
      }])),
    })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 20, scale: 0.5 })
  })

  const overlays = page.locator('.node-media-overlay')
  await expect.poll(() => page.evaluate(() => Object.keys(
    window.__dinksterTest!.renderer!.getNodePreviews(),
  ).filter((id) => id.startsWith('media-')).length)).toBe(30)
  await expect.poll(() => page.evaluate(() => Object.entries(
    window.__dinksterTest!.renderer!.getNodePreviews(),
  ).filter(([id, preview]) => id.startsWith('media-') && preview.src !== undefined).length)).toBe(30)
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await expect(overlays).toHaveCount(24, { timeout: 15_000 })
  const retained = page.locator('.node-media-overlay[data-node-id="media-23"]')
  const retainedVideo = retained.locator('video')
  const retainedControls = retained.getByRole('group', { name: 'Video preview controls' })
  await retainedControls.focus()
  await expect(retainedControls).toBeFocused()
  await retainedVideo.evaluate((element) => {
    (window as unknown as { retainedMediaElement: Element }).retainedMediaElement = element
  })
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['media-29']))
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.controller!.getSelection().has('media-29'),
  )).toBe(true)
  await expect(overlays).toHaveCount(24)
  await expect(retained).toHaveCount(1)
  await expect(page.locator('.node-media-overlay[data-node-id="media-29"]')).toHaveCount(1)
  await expect(page.locator('.node-media-overlay[data-node-id="media-22"]')).toHaveCount(0)

  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'view.setNodeSize',
      params: { graphId: 'g0', nodeId: 'media-23', size: { width: 180, height: 176 } },
    })
  })
  expect(await page.evaluate(() =>
    (window as unknown as { retainedMediaElement: Element }).retainedMediaElement ===
      document.querySelector('.node-media-overlay[data-node-id="media-23"] video'),
  )).toBe(true)

  await retainedVideo.evaluate((video: HTMLVideoElement) => video.play())
  await expect(retainedVideo).toHaveJSProperty('paused', false)
  await page.getByTestId('graph-canvas').focus()
  await expect(retained).toHaveCount(1)
  await expect(retainedVideo).toHaveJSProperty('paused', false)
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection([]))
  await page.screenshot({ path: testInfo.outputPath('bounded-media-overlays.png'), animations: 'disabled' })

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', nodeIds: ['media-23'], linkIds: [] } })
  })
  await expect(retained).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect(overlays).toHaveCount(24)
  await expect(retained).toHaveCount(0)
  await expect(page.locator('.node-media-overlay[data-node-id="media-22"]')).toHaveCount(1)
})

test('output pager cap retains focused, selected, and open-viewer roots without remounts or stale keys', async ({ page }) => {
  await page.route('**/api/assets/**', (route) => route.fulfill({ contentType: 'image/png', body: png }))
  await page.evaluate(async () => {
    const count = 30
    window.__dinksterTest!.app.registerSchemas([{
      type: 'ProofPagedImage', displayName: 'ProofPagedImage', category: 'test', source: 'v3', isOutputNode: true,
      body: [{ kind: 'output', id: 'images', type: { kind: 'list', element: { kind: 'asset', element: { kind: 'concrete', name: 'IMAGE' } } } }],
    }])
    const nodes = Object.fromEntries(Array.from({ length: count }, (_, index) => {
      const id = `pager-${index}`
      return [id, { id, type: 'ProofPagedImage', title: `Pager ${index}`, values: {} }]
    }))
    const positions = Object.fromEntries(Object.keys(nodes).map((id, index) => [id, {
      position: { x: 10 + index % 6 * 12, y: 30 + Math.floor(index / 6) * 12 },
      size: { width: 520, height: 420 },
    }]))
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dense-pager-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 40 } },
      view: { graphs: { g0: { nodes: positions } } },
    } as never, 'Dense Pager Proof')
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(`compile failed: ${JSON.stringify(compiled?.diagnostics)}`)
    const ref = { connection: compiled.artifact.connection, prompt: 'dense-pager-proof-job' }
    const store = app.store as unknown as {
      register(execution: { connection: string; prompt: string }, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: Object.fromEntries(Object.keys(nodes).map((id) => [id, { state: 'done' }])),
    })
    for (const id of Object.keys(nodes)) {
      store.apply({
        kind: 'nodeOutput', execution: ref, runtimeNodeId: id, timestamp: Date.now(),
        output: { images: {
          typeId: 'list<asset<IMAGE>>',
          elements: [0, 1, 2].map((pageIndex) => ({
            typeId: 'asset<IMAGE>',
            meta: {
              digest: `blake3:${(Number(id.slice('pager-'.length)) * 3 + pageIndex).toString(16).padStart(64, '0')}`,
              mediaType: 'image/png', name: `${id}-${pageIndex}.png`,
            },
          })),
        } },
      })
    }
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.75 })
  })

  const pagers = page.locator('.node-output-pager')
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await expect(pagers).toHaveCount(24, { timeout: 15_000 })
  const pagerFor = (index: number) => page.locator('.node-output-pager', {
    has: page.getByRole('group', { name: `Pager ${index} execution images` }),
  })
  const retained = pagerFor(23)
  await retained.getByRole('button', { name: 'Next image for Pager 23' }).focus()
  await retained.evaluate((element) => {
    (window as unknown as { retainedOutputPager: Element }).retainedOutputPager = element
  })
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['pager-29']))
  await expect(pagers).toHaveCount(24)
  await expect(retained).toHaveCount(1)
  await expect(pagerFor(29)).toHaveCount(1)
  await expect(pagerFor(22)).toHaveCount(0)

  await retained.getByRole('button', { name: 'Next image for Pager 23' }).press('Enter')
  await expect(retained.getByRole('button', { name: 'Open image 2 of 3 for Pager 23' })).toBeVisible()
  expect(await page.evaluate(() =>
    (window as unknown as { retainedOutputPager: Element }).retainedOutputPager ===
      Array.from(document.querySelectorAll('.node-output-pager')).find((element) =>
        element.querySelector('[aria-label="Pager 23 execution images"]') !== null),
  )).toBe(true)

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'graph.deleteItems', params: { graphId: 'g0', nodeIds: ['pager-23'], linkIds: [] } })
  })
  await expect(retained).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect(pagers).toHaveCount(24)
  await expect(retained).toHaveCount(0)
  await expect(pagerFor(22)).toHaveCount(1)

  await pagerFor(29).getByRole('button', { name: 'Open image 1 of 3 for Pager 29' }).press('Enter')
  await expect(page.getByTestId('output-viewer')).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection([]))
  await expect(pagerFor(29)).toHaveCount(1)
  await page.getByRole('button', { name: 'Close Execution outputs' }).click()
  await page.getByTestId('graph-canvas').focus()
  await expect(pagerFor(29)).toHaveCount(0)
  await expect(pagerFor(24)).toHaveCount(1)
})

test('editors and media stay usable until the configured node details cutoff', async ({ page }, info) => {
  await page.route('**/api/mounts', (route) => route.fulfill({ json: {
    activeOutputMount: 'output', mounts: [{ id: 'output', mode: 'readwrite', state: 'ready' }],
  } }))
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const concrete = (name: string) => ({ kind: 'concrete' as const, name })
    app.registerSchemas([
      { type: 'ZoomCurve', displayName: 'Curve editor', category: 'test', source: 'v3', isOutputNode: true, body: [
        { kind: 'input', id: 'curve', type: concrete('CURVE'), optional: false,
          widget: { widgetType: 'CURVE', options: { histogram: 'histogram' } } },
        { kind: 'input', id: 'histogram', type: concrete('HISTOGRAM'), optional: true },
      ] },
      { type: 'ZoomSave', displayName: 'Save target', category: 'test', source: 'v3', isOutputNode: true, body: [
        { kind: 'input', id: 'target', type: concrete('SAVE_TARGET'), optional: false,
          widget: { widgetType: 'SAVE_TARGET', options: {} } },
      ] },
    ])
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'editor-zoom', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Root', nodes: {
        curve0: { id: 'curve0', type: 'ZoomCurve', values: {
          curve: { interpolation: 'linear', points: [{ position: 0, value: 0.1 }, { position: 0.4, value: 0.6 }, { position: 1, value: 0.9 }] },
        } }, save: { id: 'save', type: 'ZoomSave', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {
        curve0: { position: { x: 40, y: 60 }, editors: { curve: { unfolded: true } } },
        save: { position: { x: 400, y: 60 }, editors: { target: { unfolded: true } } },
      } } } },
    }, 'Editor zoom')
    app.settings.set('canvas.detailMinPercent', 30)
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 20, scale: 0.4 })
  })
  const curve = page.locator('.node-editor-space-overlay[data-node-id="curve0"]')
  const save = page.locator('.node-editor-space-overlay[data-node-id="save"]')
  for (const scale of [0.75, 0.71, 0.5, 0.31, 0.3]) {
    await page.evaluate((scale) => window.__dinksterTest!.renderer!.setViewport({ x: 60, y: 60, scale }), scale)
    await page.screenshot({ path: info.outputPath(`editors-${Math.round(scale * 100)}.png`) })
    await expect(curve.locator('circle.dinkster-canvas-curve-point')).toHaveCount(3)
    const point = curve.locator('circle.dinkster-canvas-curve-point').nth(1)
    const box = await point.boundingBox()
    if (!box) throw new Error('curve point is not drawn')
    const before = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.curve0!.values.curve)
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 6, box.y + box.height / 2 - 4, { steps: 3 })
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.curve0!.values.curve)).not.toEqual(before)
    const prefix = save.getByRole('textbox')
    await prefix.fill(`zoom-${scale}`)
    await prefix.press('Enter')
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values.target)).toMatchObject({ prefix: `zoom-${scale}` })
  }
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 60, y: 60, scale: 0.29 }))
  await expect(page.locator('.node-editor-space-overlay')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('editors-29.png') })
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.detailMinPercent', 20))
  await expect(curve).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.detailMinPercent', 50))
  await expect(curve).toHaveCount(0)
  await installMediaProof(page)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.detailMinPercent', 30))
  const audio = page.locator('.node-media-overlay[data-media-kind="audio"]')
  for (const scale of [0.71, 0.5, 0.31]) {
    await page.evaluate((scale) => window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 20, scale }), scale)
    const seek = audio.getByRole('slider', { name: 'Audio position' })
    await expect(seek).toBeVisible()
    const before = await seek.getAttribute('aria-valuenow')
    await seek.focus()
    await seek.press('ArrowRight')
    await expect(seek).not.toHaveAttribute('aria-valuenow', before!)
    const video = page.locator('.node-media-overlay[data-node-id="mp4"]')
    const mute = video.getByRole('button', { name: 'Mute video', exact: true })
    const muted = await mute.getAttribute('aria-pressed')
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', muted === 'true' ? 'false' : 'true')
    await audio.getByRole('button', { name: 'Play audio', exact: true }).click()
    await expect(audio.locator('audio')).toHaveJSProperty('paused', false)
    await audio.getByRole('button', { name: 'Pause audio', exact: true }).click()
    await expect(audio.locator('audio')).toHaveJSProperty('paused', true)
    await page.screenshot({ path: info.outputPath(`media-${Math.round(scale * 100)}.png`) })
  }
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 20, scale: 0.29 }))
  await expect(page.locator('.node-media-overlay')).toHaveCount(0)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.detailMinPercent', 20))
  await expect(audio.getByRole('slider', { name: 'Audio position' })).toBeVisible()
})
