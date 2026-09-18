import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, test, type Page, type Route } from '@playwright/test'

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
  { id: 'image', type: 'core.image', kind: 'image', rendition: 'png', mime: 'image/png' },
  { id: 'mp4', type: 'core.video', kind: 'video', rendition: 'preview', mime: 'video/mp4' },
  { id: 'webm', type: 'core.video', kind: 'video', rendition: 'preview', mime: 'video/webm' },
  { id: 'audio', type: 'core.audio', kind: 'audio', rendition: 'window', mime: 'audio/wav' },
  { id: 'list', type: 'list<core.video>', kind: 'video', rendition: 'preview', mime: 'video/mp4' },
  { id: 'saved', type: 'core.video', kind: 'video', rendition: 'preview', mime: 'video/mp4' },
] as const

async function mockBackend(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: '31658bf8-proof', schemaWire: 22 },
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
  await page.route('/api/values*', async (route) => serveValue(route))
}

async function serveValue(route: Route): Promise<void> {
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
    const body = output === 'image' ? png : output === 'webm' ? webm : output === 'audio' ? audio : mp4
    await route.fulfill({
      status: 200,
      contentType: spec.mime,
      headers: {
        'X-Dinkster-Fingerprint': `proof-${output}`,
        'X-Dinkster-Rendition': spec.rendition,
        'X-Dinkster-Type-Id': spec.type,
      },
      body,
    })
    return
  }
  const element = url.searchParams.get('element')
  const descriptor = output === 'list' && element === null
    ? { typeId: spec.type, fingerprint: 'proof-list', length: 3 }
    : {
        typeId: output === 'list' ? 'core.video' : spec.type,
        fingerprint: `proof-${output}`,
        ...(output === 'audio' ? { meta: { duration: 1, sample_rate: 8000, channels: 1 } } : {}),
      }
  await route.fulfill({ json: {
    available: true,
    descriptor,
    renditions: element === null && output === 'list'
      ? []
      : output === 'audio'
        ? [{
            kind: 'window', mime: 'audio/wav', default: true, version: 'window-v1',
            parameters: ['window'], defaults: { window: '0,1' },
            limits: { maxSeconds: 3, maxSampleValues: 24_000 },
          }]
        : [{ kind: spec.rendition, mime: spec.mime, default: true }],
  } })
}

async function installGraph(page: Page): Promise<void> {
  await page.evaluate(() => {
    const concrete = (name: string) => ({ kind: 'concrete', name } as const)
    const schema = (type: string, output: string, valueType: ReturnType<typeof concrete>, preview = true) => ({
      type,
      displayName: type,
      category: 'proof',
      source: 'v3' as const,
      isOutputNode: true,
      items: [{ kind: 'output' as const, id: output, type: valueType, ...(preview ? { preview: true } : {}) }],
    })
    window.__dinksterTest!.app.registerSchemas([
      schema('ProofImage', 'image', concrete('core.image')),
      schema('ProofMp4', 'mp4', concrete('core.video')),
      schema('ProofWebm', 'webm', concrete('core.video')),
      schema('ProofAudio', 'audio', concrete('core.audio')),
      schema('ProofSavedVideo', 'saved', concrete('core.video')),
      {
        ...schema('ProofList', 'list', concrete('core.video')),
        items: [{ kind: 'output' as const, id: 'list', type: { kind: 'list' as const, element: concrete('core.video') }, preview: true }],
      },
      schema('ProofFailed', 'failed', concrete('core.video')),
      schema('ProofUnmarked', 'unmarked', concrete('core.video'), false),
      schema('ProofText', 'text', concrete('core.string'), false),
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
    window.__dinksterTest!.app.openDocument({
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
        image: { state: 'done', outputs: { image: descriptor('core.image', 'proof-image') } },
        mp4: { state: 'done', outputs: { mp4: descriptor('core.video', 'proof-mp4') } },
        webm: { state: 'done', outputs: { webm: descriptor('core.video', 'proof-webm') } },
        audio: { state: 'done', outputs: { audio: descriptor('core.audio', 'proof-audio') } },
        saved: { state: 'done', outputs: { saved: descriptor('core.video', 'proof-saved') } },
        list: { state: 'done', outputs: { list: descriptor('list<core.video>', 'proof-list') } },
        failed: { state: 'done', outputs: { failed: descriptor('core.video', 'proof-failed') } },
        unmarked: { state: 'done', outputs: { unmarked: descriptor('core.video', 'proof-unmarked') } },
        text: { state: 'done', outputs: { text: { ...descriptor('core.string', 'proof-text'), value: 'Recorded text wins' } } },
      },
    })
    store.hydrateArtifacts(ref, [{
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
  })
}

async function duplicateSceneNode(page: Page, nodeId: string, count: number): Promise<void> {
  await page.evaluate(({ nodeId, count }) => {
    const bridge = window.__dinksterTest!
    const scene = bridge.renderer!.getScene()
    const node = scene.nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) throw new Error(`missing scene node ${nodeId}`)
    const nodes = scene.nodes as unknown as Array<(typeof scene.nodes)[number]>
    nodes.push(...Array.from({ length: count }, () => node))
    const store = bridge.app.store as unknown as {
      executions: { get(): Map<string, { queuedAt: number; ref: DinksterBridgeExecutionRef }> }
      apply(event: unknown): void
    }
    const execution = [...store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)[0]
    if (execution === undefined) throw new Error('missing execution')
    store.apply({
      kind: 'nodeStates',
      execution: execution.ref,
      timestamp: Date.now(),
      nodes: { [nodeId]: { state: 'done', outputs: { saved: { typeId: 'core.video', fingerprint: 'proof-saved' } } } },
    })
  }, { nodeId, count })
}

test.beforeEach(async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await mockBackend(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined,
  )).toBe(true)
})

async function installMediaProof(page: Page): Promise<void> {
  await installGraph(page)
  await expect(page.locator('.node-media-overlay[data-media-kind="video"]')).toHaveCount(4, { timeout: 15_000 })
  await expect(page.locator('.node-media-overlay[data-media-kind="audio"]')).toHaveCount(1)
}

test('painted preview indicators stay readable on multi-image and cached previews', async ({ page }, testInfo) => {
  await installMediaProof(page)
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
  if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'view.setNodeSize',
    params: { graphId: 'g0', nodeId: 'image', size: { width: 180, height: 320 } },
  }))
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'image')?.layout.width,
  )).toBe(180)

  const screenshot = async (name: string, preview: { count?: number; index?: number; state?: 'cached' }): Promise<void> => {
    const clip = await page.evaluate((next) => {
      const bridge = window.__dinksterTest!
      const renderer = bridge.renderer!
      const image = document.createElement('canvas')
      image.width = 640
      image.height = 480
      const context = image.getContext('2d')!
      const gradient = context.createLinearGradient(0, 0, image.width, image.height)
      gradient.addColorStop(0, '#164e63')
      gradient.addColorStop(0.5, '#7c3aed')
      gradient.addColorStop(1, '#db2777')
      context.fillStyle = gradient
      context.fillRect(0, 0, image.width, image.height)
      renderer.setNodePreviews({
        ...renderer.getNodePreviews(),
        image: { image, width: image.width, height: image.height, ...next },
      })
      renderer.setViewport({ x: 30, y: 20, scale: 1 })
      const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'image')
      if (node === undefined) throw new Error('missing image scene node')
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
      const viewport = renderer.getViewport()
      return {
        x: Math.max(0, canvas.left + node.x * viewport.scale + viewport.x - 12),
        y: Math.max(0, canvas.top + node.y * viewport.scale + viewport.y - 12),
        width: node.layout.width * viewport.scale + 24,
        height: node.layout.height * viewport.scale + 24,
      }
    }, preview)
    await page.screenshot({ path: testInfo.outputPath(name), animations: 'disabled', clip })
  }

  await screenshot('multi-image-preview.png', { count: 4, index: 1 })
  await screenshot('cached-preview.png', { state: 'cached' })
  await screenshot('cached-multi-image-preview.png', { count: 4, index: 1, state: 'cached' })
})

test('duplicate source entries produce unique bounded media and pager roots', async ({ page }) => {
  await installMediaProof(page)
  const savedMedia = page.locator('.node-media-overlay[data-node-id="saved"]')
  const savedPager = page.locator('.node-output-pager', {
    has: page.getByRole('group', { name: 'ProofSavedVideo execution videos' }),
  })
  await expect(savedMedia).toHaveCount(1)
  await expect(savedPager).toHaveCount(0)

  await duplicateSceneNode(page, 'saved', 30)

  await expect(savedMedia).toHaveCount(1)
  await expect(savedPager).toHaveCount(0)
  const roots = await page.evaluate(() => ({
    media: Array.from(document.querySelectorAll<HTMLElement>('.node-media-overlay'), (element) => element.dataset['nodeId']),
    pagers: Array.from(document.querySelectorAll<HTMLElement>('.node-output-pager'), (element) => element.dataset['outputKey']),
  }))
  expect(roots.media.length).toBeLessThanOrEqual(24)
  expect(new Set(roots.media).size).toBe(roots.media.length)
  expect(roots.pagers.length).toBeLessThanOrEqual(24)
  expect(new Set(roots.pagers).size).toBe(roots.pagers.length)
})

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
      overlayBottom: overlay.getBoundingClientRect().bottom,
      captionTop: canvas.top + (node.y + preview.y + preview.height - captionHeight) * viewport.scale + viewport.y,
    }
  }, previewCaptionHeight)
  expect(captionBoundary.overlayBottom).toBeCloseTo(captionBoundary.captionTop, 1)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getNodePreviews()['failed']?.status,
  )).toBe('unavailable')
  await expect(page.locator('.node-media-overlay').filter({ has: page.locator('[src]') })).toHaveCount(5)
  await page.screenshot({ path: `${proofDir}/01-ready-mp4-webm-wav-list-failure.png`, animations: 'disabled' })

  const play = page.getByRole('button', { name: 'Play audio' })
  await play.focus()
  await page.keyboard.press('Enter')
  await expect(audioElement).toHaveJSProperty('paused', false)
  await page.getByRole('button', { name: 'Pause audio' }).click()
  await expect(audioElement).toHaveJSProperty('paused', true)
  const seek = page.getByRole('slider', { name: 'Audio position' })
  await seek.focus()
  await page.keyboard.press('ArrowRight')
  await expect.poll(async () => Number(await seek.getAttribute('aria-valuenow'))).toBeGreaterThan(0)
  await page.getByRole('button', { name: 'Play audio' }).click()
  await expect(page.getByRole('button', { name: 'Pause audio' })).toBeVisible()
  await page.getByRole('button', { name: 'Pause audio' }).click()
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

  for (const scale of [1.5, 1, 0.75, 0.6, 0.5, 0.49]) {
    await page.evaluate((value) => window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 15, scale: value }), scale)
    if (scale >= 0.5) {
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
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
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
  await page.evaluate(() => {
    const count = 30
    window.__dinksterTest!.app.registerSchemas([{
      type: 'ProofMp4', displayName: 'ProofMp4', category: 'proof', source: 'v3', isOutputNode: true,
      items: [{ kind: 'output', id: 'mp4', type: { kind: 'concrete', name: 'core.video' }, preview: true }],
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
    window.__dinksterTest!.app.openDocument({
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
        outputs: { mp4: { typeId: 'core.video', fingerprint: 'proof-mp4' } },
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
  await page.evaluate(() => {
    const count = 30
    window.__dinksterTest!.app.registerSchemas([{
      type: 'ProofPagedImage', displayName: 'ProofPagedImage', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'output', id: 'images', type: { kind: 'concrete', name: 'comfy.IMAGE' } }],
    }])
    const nodes = Object.fromEntries(Array.from({ length: count }, (_, index) => {
      const id = `pager-${index}`
      return [id, { id, type: 'ProofPagedImage', title: `Pager ${index}`, values: {} }]
    }))
    const positions = Object.fromEntries(Object.keys(nodes).map((id, index) => [id, {
      position: { x: 10 + index % 6 * 12, y: 30 + Math.floor(index / 6) * 12 },
      size: { width: 520, height: 420 },
    }]))
    window.__dinksterTest!.app.openDocument({
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
        output: { images: [0, 1, 2].map((pageIndex) => ({ filename: `${id}-${pageIndex}.png` })) },
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
