import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { canonicalJson } from '@dinkster/core'
import { skipWithoutNativeCatalog } from './fixtures.js'

const proofDir = '/tmp/audit-wpar-proof'
const canonicalCatalogSha256 = '44707310a3e066466bc6746664dbf4f54f1df11205fbeae8666407a282531cef'
const nativeBackend = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

type CatalogInput = {
  role: string
  id: string
  widget?: Record<string, unknown>
  sourceFilename?: Record<string, unknown>
}

type CatalogNode = {
  schemaVersion: number
  interface: CatalogInput[]
}

type Catalog = {
  dinkster: Record<string, unknown> & {
    mergeableTypes: string[]
  }
  nodes: Record<string, CatalogNode>
}

async function rowPoint(page: Page, nodeId: string, inputId: string) {
  return page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + node.layout.width / 2,
      y: canvas.top + node.y + row.y + row.height / 2,
    }
  }, { nodeId, inputId })
}

async function openCombo(page: Page, nodeId: string, inputId: string) {
  const point = await rowPoint(page, nodeId, inputId)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
}

function widgets(catalog: Catalog) {
  return Object.entries(catalog.nodes).flatMap(([nodeType, node]) =>
    node.interface
      .filter((input) => input.role === 'input')
      .map((input) => ({ nodeType, input })),
  )
}

function widgetDescriptors(widget: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!widget) return []
  const representations = widget['type'] === 'REPRESENTATIONS' && Array.isArray(widget['representations'])
    ? widget['representations']
    : []
  return [widget, ...representations.flatMap((representation) => {
    if (typeof representation !== 'object' || representation === null) return []
    const nested = (representation as Record<string, unknown>)['widget']
    return typeof nested === 'object' && nested !== null
      ? widgetDescriptors(nested as Record<string, unknown>)
      : []
  })]
}

async function refreshCombo(page: Page, nodeId: string, inputId: string, route: string) {
  await openCombo(page, nodeId, inputId)
  const previousOption = await page.getByRole('option').first().elementHandle()
  expect(previousOption).not.toBeNull()
  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'GET' && new URL(response.url()).pathname === route)
  await page.getByTestId('remote-refresh').click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  await response.finished()
  await expect.poll(() => previousOption!.evaluate((option) => option.isConnected)).toBe(false)
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute('data-remote', 'ready')
  await page.keyboard.press('Escape')
}

test('standing current-wire stack proves live widget adoption and exact catalog absences', async ({ page, request }, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  await mkdir(proofDir, { recursive: true })
  const catalogResponse = await page.request.get(`${nativeBackend}/api/nodes`)
  expect(catalogResponse.ok()).toBe(true)
  const catalogBytes = await catalogResponse.body()
  const proxiedCatalogResponse = await page.request.get('/api/nodes')
  expect(proxiedCatalogResponse.ok()).toBe(true)
  expect(await proxiedCatalogResponse.body()).toEqual(catalogBytes)
  const catalog = JSON.parse(catalogBytes.toString()) as Catalog
  // Execution registers dinkster.image lazily without changing the node catalog.
  expect([
    ['comfy.IMAGE'],
    ['comfy.IMAGE', 'dinkster.image'],
  ]).toContainEqual(catalog.dinkster.mergeableTypes)
  const stableDinkster = Object.fromEntries(
    Object.entries(catalog.dinkster).filter(([key]) => key !== 'mergeableTypes'),
  )
  const stableCatalog = { ...catalog, dinkster: stableDinkster }
  const catalogDigest = createHash('sha256').update(canonicalJson(stableCatalog)).digest('hex')
  test.skip(catalogDigest !== canonicalCatalogSha256, 'requires the pinned full native catalog snapshot')
  expect(catalogDigest).toBe(canonicalCatalogSha256)
  expect(Object.keys(catalog.nodes)).toHaveLength(884)
  const inputs = widgets(catalog)
  const descriptors = inputs.flatMap(({ input }) => widgetDescriptors(input.widget))

  const roundInputs = inputs.filter(({ input }) => typeof input.widget?.['round'] === 'number')
  expect(roundInputs).toHaveLength(5)
  expect(roundInputs).toContainEqual(expect.objectContaining({
    nodeType: 'comfy.DualModelGuider',
    input: expect.objectContaining({ id: 'cfg', widget: expect.objectContaining({ round: 0.01 }) }),
  }))
  const dynamicPromptInputs = inputs.filter(({ input }) =>
    JSON.stringify(input.widget ?? {}).includes('"dynamicPrompts":true'))
  expect(dynamicPromptInputs).toHaveLength(41)
  expect(dynamicPromptInputs.map(({ nodeType, input }) => `${nodeType}.${input.id}`)).toContain('dinkster.clip_text_encode.text')
  expect(inputs.filter(({ input }) => Object.hasOwn(input.widget ?? {}, 'placeholder'))).toEqual([])
  expect(inputs.find(({ nodeType, input }) =>
    nodeType === 'dinkster.render_image_document' && input.id === 'selector',
  )?.input.widget).toEqual({ type: 'STRING', multiline: true })
  expect(descriptors.filter((widget) => widget['type'] === 'MULTI_COMBO')).toHaveLength(0)
  expect(descriptors.filter((widget) =>
    widget['type'] === 'COMBO' && Object.hasOwn(widget, 'controlAfterGenerate'))).toHaveLength(0)
  expect(inputs.filter(({ input }) => input.widget?.['type'] === 'COLOR')).toHaveLength(9)
  expect(Object.hasOwn(catalog.nodes, 'dinkster.ksampler_advanced')).toBe(true)
  expect(Object.hasOwn(catalog.nodes, 'comfy.KSamplerAdvanced')).toBe(false)

  const remoteDescriptors = descriptors.filter((widget) => typeof widget['remote'] === 'object')
  for (const widget of remoteDescriptors) {
    const remote = widget['remote'] as Record<string, unknown>
    expect(remote).not.toHaveProperty('controlAfterRefresh')
    expect(remote).not.toHaveProperty('timeoutMs')
    expect(remote).not.toHaveProperty('maxRetries')
    expect(remote).not.toHaveProperty('refreshMs')
  }
  const remoteInputs = inputs.filter(({ input }) =>
    widgetDescriptors(input.widget).some((widget) => typeof widget['remote'] === 'object'))
  expect(remoteInputs.map(({ nodeType, input }) => {
    const descriptor = widgetDescriptors(input.widget).find((widget) => typeof widget['remote'] === 'object')!
    const remote = descriptor['remote'] as Record<string, unknown>
    return {
      input: `${nodeType}.${input.id}`,
      route: remote['route'],
      refreshButton: remote['refreshButton'] ?? null,
    }
  }).sort((a, b) => a.input.localeCompare(b.input))).toEqual([
    { input: 'comfy.CheckpointLoader.config_name', route: '/api/choices/comfy.files.configs', refreshButton: true },
    { input: 'dev.gallery.widgets.combo_remote', route: '/api/choices/dev.gallery.samplers', refreshButton: true },
    { input: 'dev.gallery.widgets.combo_remote_empty', route: '/api/choices/dev.gallery.empty', refreshButton: true },
    { input: 'dinkster.detection.detect.provider', route: '/api/choices/dinkster.detection.detect.providers', refreshButton: null },
    { input: 'dinkster.detection.segment_text.provider', route: '/api/choices/dinkster.detection.segment_text.providers', refreshButton: null },
    { input: 'dinkster.detection.segment.provider', route: '/api/choices/dinkster.detection.segment.providers', refreshButton: null },
    { input: 'dinkster.detection.track.provider', route: '/api/choices/dinkster.detection.track.providers', refreshButton: null },
    { input: 'dinkster.image.upscale_model.provider', route: '/api/choices/dinkster.image.upscale_model.providers', refreshButton: null },
    { input: 'dinkster.record_audio.device', route: '/api/choices/dinkster.devices.audio_inputs', refreshButton: true },
    { input: 'dinkster.webcam_capture.device', route: '/api/choices/dinkster.devices.video_inputs', refreshButton: true },
  ].sort((a, b) => a.input.localeCompare(b.input)))

  const sourceInputs = inputs.filter(({ input }) => input.sourceFilename !== undefined)
  expect(sourceInputs.map(({ nodeType, input }) => `${nodeType}.${input.id}`).sort()).toEqual([
    'comfy.LoadAudio.audio',
    'comfy.LoadImageMask.image',
    'comfy.LoadImageOutput.image',
    'comfy.LoadVideo.file',
    'dinkster.load_audio.audio',
    'dinkster.load_latent.asset',
    'dinkster.load_mask.mask',
    'dinkster.load_video.video',
    'dinkster.load_video_value.video',
    'dinkster.read_image_metadata.image',
  ])
  expect(sourceInputs).toContainEqual({
    nodeType: 'dinkster.load_mask',
    input: expect.objectContaining({
      id: 'mask',
      widget: expect.objectContaining({ type: 'ASSET', kind: 'media/image', allowUpload: true }),
      sourceFilename: { kind: 'media/image', category: 'input' },
    }),
  })

  const choiceRequests: string[] = []
  const mediaUploads: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/choices/')) choiceRequests.push(url.pathname)
    if (request.method() === 'POST' && url.pathname === '/api/assets/media') {
      mediaUploads.push(request.url())
    }
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0,
  ), { timeout: 20_000 }).toBe(929)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-wpar-live', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        round: { id: 'round', type: 'comfy.DualModelGuider', values: { cfg: 8.0 } },
        checkpoint: { id: 'checkpoint', type: 'comfy.CheckpointLoader', values: { config_name: 'anything_v3.yaml' } },
        sampler: { id: 'sampler', type: 'dinkster.ksampler_advanced', values: { sampler_name: 'dinkster.euler', scheduler: 'dinkster.simple' } },
        media: { id: 'media', type: 'dinkster.load_mask', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 5 } },
      view: { graphs: { g0: { nodes: {
        round: { position: { x: 0, y: 80 }, size: { width: 320, height: 220 } },
        checkpoint: { position: { x: 350, y: 80 }, size: { width: 320, height: 150 } },
        sampler: { position: { x: 700, y: 80 }, size: { width: 340, height: 220 } },
        media: { position: { x: 350, y: 330 }, size: { width: 320, height: 130 } },
      } } } },
    }, 'audit widget parity live proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const cfg = await rowPoint(page, 'round', 'cfg')
  await page.mouse.click(cfg.x, cfg.y)
  const numberEditor = page.getByTestId('widget-editor').locator('input')
  await numberEditor.fill('8.129')
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.round!.values.cfg,
  )).toBe(8.13)

  const sampler = await rowPoint(page, 'sampler', 'sampler_name')
  await page.mouse.click(sampler.x, sampler.y)
  await expect(page.getByRole('option', { name: 'euler', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')

  await refreshCombo(page, 'checkpoint', 'config_name', '/api/choices/comfy.files.configs')
  await expect.poll(() => choiceRequests.filter((path) => path === '/api/choices/comfy.files.configs').length).toBeGreaterThanOrEqual(2)

  const media = await rowPoint(page, 'media', 'mask')
  await page.mouse.click(media.x, media.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const uploadResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/assets/media')
  await page.getByTestId('asset-editor').locator('input[type=file]').setInputFiles({
    name: 'audit-wpar-source.png', mimeType: 'image/png', buffer: png,
  })
  const uploadResponse = await uploadResponsePromise
  expect(uploadResponse.ok()).toBe(true)
  await expect.poll(() => mediaUploads.length).toBe(1)
  const mediaUrl = new URL(mediaUploads[0]!)
  expect(Object.fromEntries(mediaUrl.searchParams)).toEqual({
    scope: 'local', kind: 'media/image', name: 'audit-wpar-source.png',
  })
  await page.getByRole('button', { name: 'Use asset' }).click()
  const uploadedAsset = await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.media!.values.mask,
  )).toEqual(expect.objectContaining({ name: 'audit-wpar-source.png', mediaType: 'image/png', size: png.length }))
    .then(() => page.evaluate(() =>
      window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.media!.values.mask as { digest: string },
    ))
  const uploadedResponse = await page.request.get(`/api/assets/${encodeURIComponent(uploadedAsset.digest)}`)
  expect(uploadedResponse.ok()).toBe(true)
  expect(await uploadedResponse.body()).toEqual(png)
  await page.screenshot({ path: `${proofDir}/01-round-remote-media-live.png`, animations: 'disabled' })

  let submitted: Record<string, any> | undefined
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
      submitted = request.postDataJSON() as Record<string, any>
    }
  })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-wpar-dynamic-submit', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        delay: { id: 'delay', type: 'dev.util.delay', values: { value: 'builtin', seconds: 5 } },
        combo: { id: 'combo', type: 'dinkster.string_to_combo', values: {} },
        generate: {
          id: 'generate',
          type: 'dinkster.text_generate',
          values: { prompt: '{amber|violet} proof', max_length: 1 },
          dynamic: { sampling_mode: { selected: 'off' } },
        },
      }, links: {
        l0: { id: 'l0', from: { node: 'delay', port: 'value' }, to: { node: 'combo', port: 'string' } },
        l1: { id: 'l1', from: { node: 'combo', port: 'choice' }, to: { node: 'generate', port: 'provider' } },
      }, nets: {}, reroutes: {}, nextOrdinal: 4 } },
      view: { graphs: { g0: { nodes: {
        delay: { position: { x: -500, y: 160 } }, combo: { position: { x: -200, y: 160 } },
        generate: { position: { x: 180, y: 160 } },
      } } } },
    }, 'audit dynamic prompt live submit')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const submitResponsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/jobs')
  try {
    await page.evaluate(async () => {
      const app = window.__dinksterTest!.app as unknown as {
        activeTab(): unknown
        queue(
          tab: unknown,
          scope: { kind: 'partial'; targets: Array<{ instancePath: string[]; node: string }> },
          requiredRootNodes: string[],
        ): Promise<void>
      }
      const tab = app.activeTab()!
      await app.queue(tab, {
        kind: 'partial', targets: [{ instancePath: [], node: 'generate' }],
      }, ['generate'])
    })
    expect(submitted).toBeDefined()
    expect((await submitResponsePromise).ok()).toBe(true)
  } finally {
    if (submitted) {
      const jobPath = `/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`
      const cancelResponse = await page.request.delete(jobPath)
      expect(cancelResponse.ok()).toBe(true)
      await expect.poll(async () => {
        const response = await page.request.get(jobPath)
        expect(response.ok()).toBe(true)
        return (await response.json() as { state: string }).state
      }).toBe('cancelled')
    }
  }
  expect(submitted!.targets).toEqual(['generate'])
  expect(['amber proof', 'violet proof']).toContain(submitted!.graph.nodes.generate.inputs.prompt)
  expect(submitted!.graph.nodes.generate.inputs.prompt).not.toContain('{')
  expect(await page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.generate!.values.prompt,
  )).toBe('{amber|violet} proof')

  await page.evaluate(({ expanded, catalogDigest }) => {
    const banner = document.createElement('pre')
    banner.style.cssText = 'position:fixed;right:320px;top:150px;width:520px;white-space:pre-wrap;overflow-wrap:anywhere;z-index:10000;background:#102030;color:#e8f4ff;padding:16px;border:2px solid #60a5fa'
    banner.textContent = `current canonical catalog SHA-256: ${catalogDigest}\nFLOAT commit: 8.129 -> 8.13\ncanonical sampler: dinkster.ksampler_advanced\nremote COMBO routes refreshed: 1/1\nsource upload: audit-wpar-source.png\ndynamic POST: ${expanded}\nplaceholder declarers: 0\nMULTI_COMBO declarers: 0\nremote policy declarers: 0`
    document.body.appendChild(banner)
  }, { expanded: submitted!.graph.nodes.generate.inputs.prompt, catalogDigest: canonicalCatalogSha256 })
  await page.screenshot({ path: `${proofDir}/02-dynamic-submit-and-absence-accounting.png`, animations: 'disabled' })
  console.log(JSON.stringify({
    canonicalCatalogSha256,
    round: 'comfy.DualModelGuider.cfg 8.129 -> 8.13',
    sampler: 'dinkster.ksampler_advanced',
    choiceRequests,
    mediaUpload: Object.fromEntries(mediaUrl.searchParams),
    dynamicPrompt: submitted!.graph.nodes.generate.inputs.prompt,
    placeholderDeclarers: 0,
    multiComboDeclarers: 0,
    remotePolicyDeclarers: 0,
    cancelledJob: { clientId: submitted!.clientId, jobId: submitted!.jobId },
  }))
})
