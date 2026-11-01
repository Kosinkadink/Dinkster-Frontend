import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { canonicalJson } from '@dinkster/core'
import { selectProductOption, skipWithoutNativeCatalog } from './fixtures.js'

// Native catalog from the pinned backend 2fc14a13824d6958057785ce18db3979a8bbe21a.
const canonicalCatalogSha256 =
  '3b4a4a7c7eb78f43a4e7d8c2c5de3ae34cfbd1126b2df622c5ef9afdfddef8de'
const nativeBackend =
  process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

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
  packs: Record<string, Record<string, unknown>>
  nodes: Record<string, CatalogNode>
}

async function rowPoint(page: Page, nodeId: string, inputId: string) {
  return page.evaluate(
    ({ nodeId, inputId }) => {
      const node = window
        .__dinksterTest!.renderer!.getScene()
        .nodes.find((item) => item.id === nodeId)!
      const row = node.layout.rows.find(
        (item) => item.kind === 'widget' && item.inputId === inputId,
      )!
      const canvas = document
        .querySelector('[data-testid=graph-canvas]')!
        .getBoundingClientRect()
      return {
        x: canvas.left + node.x + node.layout.width / 2,
        y: canvas.top + node.y + row.y + row.height / 2,
      }
    },
    { nodeId, inputId },
  )
}

async function openCombo(page: Page, nodeId: string, inputId: string) {
  const point = await rowPoint(page, nodeId, inputId)
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute(
    'data-remote',
    'ready',
  )
}

function widgets(catalog: Catalog) {
  return Object.entries(catalog.nodes).flatMap(([nodeType, node]) =>
    node.interface
      .filter((input) => input.role === 'input')
      .map((input) => ({ nodeType, input })),
  )
}

function widgetDescriptors(
  widget: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  if (!widget) return []
  const representations =
    widget['type'] === 'REPRESENTATIONS' &&
    Array.isArray(widget['representations'])
      ? widget['representations']
      : []
  return [
    widget,
    ...representations.flatMap((representation) => {
      if (typeof representation !== 'object' || representation === null)
        return []
      const nested = (representation as Record<string, unknown>)['widget']
      return typeof nested === 'object' && nested !== null
        ? widgetDescriptors(nested as Record<string, unknown>)
        : []
    }),
  ]
}

async function refreshCombo(
  page: Page,
  nodeId: string,
  inputId: string,
  route: string,
) {
  await openCombo(page, nodeId, inputId)
  const previousOption = await page.getByRole('option').first().elementHandle()
  expect(previousOption).not.toBeNull()
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'GET' &&
      new URL(response.url()).pathname === route,
  )
  await page.getByTestId('remote-refresh').click()
  const response = await responsePromise
  expect(response.ok()).toBe(true)
  await response.finished()
  await expect
    .poll(() => previousOption!.evaluate((option) => option.isConnected))
    .toBe(false)
  await expect(page.getByTestId('combo-dropdown')).toHaveAttribute(
    'data-remote',
    'ready',
  )
  await page.keyboard.press('Escape')
}

test('hosted native stack proves live widget adoption and exact catalog absences', async ({
  page,
  request,
}, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  const proofDir = testInfo.outputPath('widget-parity-proof')
  await mkdir(proofDir, { recursive: true })
  const catalogResponse = await page.request.get(`${nativeBackend}/api/nodes`)
  expect(catalogResponse.ok()).toBe(true)
  const catalogBytes = await catalogResponse.body()
  const proxiedCatalogResponse = await page.request.get('/api/nodes')
  expect(proxiedCatalogResponse.ok()).toBe(true)
  expect(await proxiedCatalogResponse.body()).toEqual(catalogBytes)
  const catalog = JSON.parse(catalogBytes.toString()) as Catalog
  expect(catalog.dinkster.mergeableTypes).toEqual(['IMAGE'])
  const stableDinkster = Object.fromEntries(
    Object.entries(catalog.dinkster).filter(
      ([key]) => key !== 'mergeableTypes',
    ),
  )
  // A local pack retains its identity, not the runner's absolute checkout path.
  const stablePacks = Object.fromEntries(
    Object.entries(catalog.packs).map(([id, info]) => [
      id,
      {
        ...info,
        ...(typeof info['source'] === 'string' &&
        info['source'].startsWith('local:')
          ? { source: `local:${basename(info['source'].slice(6))}` }
          : {}),
      },
    ]),
  )
  const stableCatalog = {
    ...catalog,
    dinkster: stableDinkster,
    packs: stablePacks,
  }
  const catalogDigest = createHash('sha256')
    .update(canonicalJson(stableCatalog))
    .digest('hex')
  expect(catalogDigest).toBe(canonicalCatalogSha256)
  expect(Object.keys(catalog.nodes)).toHaveLength(852)
  const inputs = widgets(catalog)
  const descriptors = inputs.flatMap(({ input }) =>
    widgetDescriptors(input.widget),
  )

  const roundInputs = inputs.filter(
    ({ input }) => typeof input.widget?.['round'] === 'number',
  )
  expect(roundInputs).toHaveLength(18)
  expect(roundInputs).toContainEqual(
    expect.objectContaining({
      nodeType: 'DualModelGuider',
      input: expect.objectContaining({
        id: 'cfg',
        widget: expect.objectContaining({ round: 0.01 }),
      }),
    }),
  )
  const dynamicPromptInputs = inputs.filter(({ input }) =>
    JSON.stringify(input.widget ?? {}).includes('"dynamicPrompts":true'),
  )
  expect(dynamicPromptInputs).toHaveLength(51)
  expect(
    dynamicPromptInputs.map(({ nodeType, input }) => `${nodeType}.${input.id}`),
  ).toContain('CLIPTextEncode.text')
  expect(
    inputs.filter(({ input }) =>
      Object.hasOwn(input.widget ?? {}, 'placeholder'),
    ),
  ).toEqual([])
  expect(
    inputs.find(
      ({ nodeType, input }) =>
        nodeType === 'dinkster.render_image_document' &&
        input.id === 'selector',
    )?.input.widget,
  ).toEqual({ type: 'STRING', multiline: true })
  expect(
    descriptors.filter((widget) => widget['type'] === 'MULTI_COMBO'),
  ).toHaveLength(0)
  expect(
    descriptors.filter(
      (widget) =>
        widget['type'] === 'COMBO' &&
        Object.hasOwn(widget, 'controlAfterGenerate'),
    ),
  ).toHaveLength(0)
  expect(
    inputs.filter(({ input }) => input.widget?.['type'] === 'COLOR'),
  ).toHaveLength(7)
  expect(Object.hasOwn(catalog.nodes, 'dinkster.ksampler_advanced')).toBe(false)
  expect(Object.hasOwn(catalog.nodes, 'comfy.KSamplerAdvanced')).toBe(false)
  expect(Object.hasOwn(catalog.nodes, 'KSamplerAdvanced')).toBe(true)

  const remoteDescriptors = descriptors.filter(
    (widget) => typeof widget['remote'] === 'object',
  )
  for (const widget of remoteDescriptors) {
    const remote = widget['remote'] as Record<string, unknown>
    expect(remote).not.toHaveProperty('controlAfterRefresh')
    expect(remote).not.toHaveProperty('timeoutMs')
    expect(remote).not.toHaveProperty('maxRetries')
    expect(remote).not.toHaveProperty('refreshMs')
  }
  const remoteInputs = inputs.filter(({ input }) =>
    widgetDescriptors(input.widget).some(
      (widget) => typeof widget['remote'] === 'object',
    ),
  )
  expect(
    remoteInputs
      .map(({ nodeType, input }) => {
        const descriptor = widgetDescriptors(input.widget).find(
          (widget) => typeof widget['remote'] === 'object',
        )!
        const remote = descriptor['remote'] as Record<string, unknown>
        return {
          input: `${nodeType}.${input.id}`,
          route: remote['route'],
          refreshButton: remote['refreshButton'] ?? null,
        }
      })
      .sort((a, b) => a.input.localeCompare(b.input)),
  ).toEqual(
    [
      {
        input: 'dev.gallery.widgets.combo_remote',
        route: '/api/choices/dev.gallery.samplers',
        refreshButton: true,
      },
      {
        input: 'dev.gallery.widgets.combo_remote_empty',
        route: '/api/choices/dev.gallery.empty',
        refreshButton: true,
      },
      {
        input: 'dinkster.detection.detect.provider',
        route: '/api/choices/dinkster.detection.detect.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.detection.segment_text.provider',
        route: '/api/choices/dinkster.detection.segment_text.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.detection.segment.provider',
        route: '/api/choices/dinkster.detection.segment.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.detection.track.provider',
        route: '/api/choices/dinkster.detection.track.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.image.matte.provider',
        route: '/api/choices/dinkster.image.matte.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.image.upscale_model.provider',
        route: '/api/choices/dinkster.image.upscale_model.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.anyline.provider',
        route: '/api/choices/dinkster.preprocess.anyline.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.lineart_anime.provider',
        route: '/api/choices/dinkster.preprocess.lineart_anime.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.lineart_manga.provider',
        route: '/api/choices/dinkster.preprocess.lineart_manga.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.lineart_realistic.provider',
        route: '/api/choices/dinkster.preprocess.lineart_realistic.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.mlsd.provider',
        route: '/api/choices/dinkster.preprocess.mlsd.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.model_depth.provider',
        route: '/api/choices/dinkster.preprocess.model_depth.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.model_edges.provider',
        route: '/api/choices/dinkster.preprocess.model_edges.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.preprocess.teed.provider',
        route: '/api/choices/dinkster.preprocess.teed.providers',
        refreshButton: null,
      },
      {
        input: 'dinkster.record_audio.device',
        route: '/api/choices/dinkster.devices.audio_inputs',
        refreshButton: true,
      },
      {
        input: 'dinkster.webcam_capture.device',
        route: '/api/choices/dinkster.devices.video_inputs',
        refreshButton: true,
      },
      {
        input: 'SelectCLIPDevice.device',
        route: '/api/choices/devices.gpu',
        refreshButton: null,
      },
      {
        input: 'SelectModelDevice.device',
        route: '/api/choices/devices.gpu',
        refreshButton: null,
      },
      {
        input: 'SelectVAEDevice.device',
        route: '/api/choices/devices.vae',
        refreshButton: null,
      },
    ].sort((a, b) => a.input.localeCompare(b.input)),
  )

  const sourceInputs = inputs.filter(
    ({ input }) => input.sourceFilename !== undefined,
  )
  expect(
    sourceInputs.map(({ nodeType, input }) => `${nodeType}.${input.id}`).sort(),
  ).toEqual([
    'LoadAudio.audio',
    'LoadImage.image',
    'LoadImageMask.image',
    'LoadImageOutput.image',
    'LoadLatent.latent',
    'LoadVideo.file',
    'dinkster.load_audio.audio',
    'dinkster.load_gaussian_splat.splat',
    'dinkster.load_image.image',
    'dinkster.load_image_output.image',
    'dinkster.load_mask.mask',
    'dinkster.load_model3d.model',
    'dinkster.load_video.video',
    'dinkster.load_video_value.video',
    'dinkster.read_image_metadata.image',
  ])
  expect(sourceInputs).toContainEqual({
    nodeType: 'LoadImageMask',
    input: expect.objectContaining({
      id: 'image',
      widget: expect.objectContaining({
        type: 'ASSET',
        kind: 'media/image',
        allowUpload: true,
      }),
      sourceFilename: { kind: 'media/image', category: 'input' },
    }),
  })

  const choiceRequests: string[] = []
  const mediaUploads: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/choices/'))
      choiceRequests.push(url.pathname)
    if (request.method() === 'POST' && url.pathname === '/api/assets/media') {
      mediaUploads.push(request.url())
    }
  })

  await page.setViewportSize({ width: 1800, height: 1100 })
  await page.goto('/')
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            window.__dinksterTest?.app.backends.get()[0]?.registry.get()
              ?.schemas.size ?? 0,
        ),
      { timeout: 20_000 },
    )
    .toBe(852)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'audit-wpar-live',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              round: {
                id: 'round',
                type: 'DualModelGuider',
                values: { cfg: 8.0 },
              },
              checkpoint: {
                id: 'checkpoint',
                type: 'dev.gallery.widgets',
                values: { combo_remote: 'euler' },
              },
              sampler: {
                id: 'sampler',
                type: 'KSamplerAdvanced',
                values: {
                  sampler_name: 'euler',
                  scheduler: 'simple',
                },
              },
              media: { id: 'media', type: 'LoadImageMask', values: {} },
            },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 5,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                round: {
                  position: { x: 0, y: 80 },
                  size: { width: 320, height: 220 },
                },
                checkpoint: {
                  position: { x: 1050, y: 80 },
                  size: { width: 320, height: 150 },
                },
                sampler: {
                  position: { x: 700, y: 80 },
                  size: { width: 340, height: 220 },
                },
                media: {
                  position: { x: 350, y: 330 },
                  size: { width: 320, height: 130 },
                },
              },
            },
          },
        },
      },
      'audit widget parity live proof',
    )
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const cfg = await rowPoint(page, 'round', 'cfg')
  await page.mouse.click(cfg.x, cfg.y)
  const numberEditor = page.getByTestId('widget-editor').locator('input')
  await numberEditor.fill('8.129')
  await page.keyboard.press('Enter')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
            .round!.values.cfg,
      ),
    )
    .toBe(8.13)

  const sampler = await rowPoint(page, 'sampler', 'sampler_name')
  await page.mouse.click(sampler.x, sampler.y)
  await expect(
    page.getByRole('option', { name: 'euler', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')

  await refreshCombo(
    page,
    'checkpoint',
    'combo_remote',
    '/api/choices/dev.gallery.samplers',
  )
  await expect
    .poll(
      () =>
        choiceRequests.filter(
          (path) => path === '/api/choices/dev.gallery.samplers',
        ).length,
    )
    .toBeGreaterThanOrEqual(2)

  const media = await rowPoint(page, 'media', 'image')
  await page.mouse.click(media.x, media.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
  await selectProductOption(
    page,
    page.getByTestId('upload-destination-mount'),
    'output',
  )
  const uploadFolder = `widget-parity-${testInfo.repeatEachIndex}`
  await page.getByTestId('upload-destination-folder').fill(uploadFolder)
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  )
  const uploadResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/assets/media',
  )
  await page
    .getByTestId('asset-editor')
    .locator('input[type=file]')
    .setInputFiles({
      name: 'audit-wpar-source.png',
      mimeType: 'image/png',
      buffer: png,
    })
  const uploadResponse = await uploadResponsePromise
  expect(uploadResponse.ok(), await uploadResponse.text()).toBe(true)
  await expect.poll(() => mediaUploads.length).toBe(1)
  const mediaUrl = new URL(mediaUploads[0]!)
  expect(Object.fromEntries(mediaUrl.searchParams)).toEqual({
    scope: 'local',
    kind: 'media/image',
    name: 'audit-wpar-source.png',
    mount: 'output',
    folder: uploadFolder,
    project: 'default',
  })
  await page.getByRole('button', { name: 'Use asset' }).click()
  const uploadedAsset = await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
            .media!.values.image,
      ),
    )
    .toEqual(
      expect.objectContaining({
        name: 'audit-wpar-source.png',
        mediaType: 'image/png',
        size: png.length,
      }),
    )
    .then(() =>
      page.evaluate(
        () =>
          window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
            .media!.values.image as { digest: string },
      ),
    )
  const uploadedResponse = await page.request.get(
    `/api/assets/${encodeURIComponent(uploadedAsset.digest)}`,
  )
  expect(uploadedResponse.ok()).toBe(true)
  expect(await uploadedResponse.body()).toEqual(png)
  await page.screenshot({
    path: `${proofDir}/01-round-remote-media-live.png`,
    animations: 'disabled',
  })

  // Admission is tested while paused; these bytes must never be executed as weights.
  const clipUpload = await page.request.post(
    '/api/assets?scope=local&mount=output&name=queue-admission.bin',
    {
      data: Buffer.from('bounded queue admission fixture, not model weights\n'),
      headers: { 'Content-Type': 'application/octet-stream' },
    },
  )
  expect(clipUpload.ok()).toBe(true)
  const { asset: clipAsset } = (await clipUpload.json()) as {
    asset: {
      digest: string
      name: string
      size: number
      mediaType: string
      virtualPath: string
    }
  }
  let submitted: Record<string, any> | undefined
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      new URL(request.url()).pathname === '/api/jobs'
    ) {
      submitted = request.postDataJSON() as Record<string, any>
    }
  })
  await page.evaluate((clipAsset) => {
    const app = window.__dinksterTest!.app
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'audit-wpar-dynamic-submit',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              clip: {
                id: 'clip',
                type: 'CLIPLoader',
                values: {
                  clip_name: clipAsset,
                  type: 'minimax',
                  device: 'cpu',
                },
              },
              encode: {
                id: 'encode',
                type: 'CLIPTextEncode',
                values: { text: '{amber|violet} proof' },
              },
            },
            links: {
              l0: {
                id: 'l0',
                from: { node: 'clip', port: 'CLIP' },
                to: { node: 'encode', port: 'clip' },
              },
            },
            nets: {},
            reroutes: {},
            nextOrdinal: 3,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                clip: { position: { x: -200, y: 160 } },
                encode: { position: { x: 180, y: 160 } },
              },
            },
          },
        },
      },
      'audit dynamic prompt live submit',
    )
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, clipAsset)
  const pauseResponse = await page.request.post('/api/queue/pause')
  expect(pauseResponse.ok()).toBe(true)
  expect(((await pauseResponse.json()) as { paused: boolean }).paused).toBe(
    true,
  )
  const submitResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/jobs',
  )
  try {
    await page.evaluate(async () => {
      const app = window.__dinksterTest!.app as unknown as {
        activeTab(): unknown
        queue(
          tab: unknown,
          scope: {
            kind: 'partial'
            targets: Array<{ instancePath: string[]; node: string }>
          },
          requiredRootNodes: string[],
        ): Promise<void>
      }
      const tab = app.activeTab()!
      await app.queue(
        tab,
        {
          kind: 'partial',
          targets: [{ instancePath: [], node: 'encode' }],
        },
        ['encode'],
      )
    })
    expect(submitted).toBeDefined()
    expect((await submitResponsePromise).ok()).toBe(true)
    const jobPath = `/api/jobs/${encodeURIComponent(submitted!.clientId)}/${encodeURIComponent(submitted!.jobId)}`
    const queuedResponse = await page.request.get(jobPath)
    expect(queuedResponse.ok()).toBe(true)
    expect(((await queuedResponse.json()) as { state: string }).state).toBe(
      'queued',
    )
  } finally {
    if (submitted) {
      const jobPath = `/api/jobs/${encodeURIComponent(submitted.clientId)}/${encodeURIComponent(submitted.jobId)}`
      const cancelResponse = await page.request.delete(jobPath)
      expect(cancelResponse.ok()).toBe(true)
      await expect
        .poll(async () => {
          const response = await page.request.get(jobPath)
          expect(response.ok()).toBe(true)
          return ((await response.json()) as { state: string }).state
        })
        .toBe('cancelled')
    }
    const resumeResponse = await page.request.post('/api/queue/resume')
    expect(resumeResponse.ok()).toBe(true)
    expect(((await resumeResponse.json()) as { paused: boolean }).paused).toBe(
      false,
    )
  }
  expect(submitted!.targets).toEqual(['encode'])
  expect(['amber proof', 'violet proof']).toContain(
    submitted!.graph.nodes.encode.inputs.text,
  )
  expect(submitted!.graph.nodes.encode.inputs.text).not.toContain('{')
  expect(
    await page.evaluate(
      () =>
        window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes
          .encode!.values.text,
    ),
  ).toBe('{amber|violet} proof')

  await page.evaluate(
    ({ expanded, catalogDigest }) => {
      const banner = document.createElement('pre')
      banner.style.cssText =
        'position:fixed;right:320px;top:150px;width:520px;white-space:pre-wrap;overflow-wrap:anywhere;z-index:10000;background:#102030;color:#e8f4ff;padding:16px;border:2px solid #60a5fa'
      banner.textContent = `current canonical catalog SHA-256: ${catalogDigest}\nFLOAT commit: 8.129 -> 8.13\ncanonical sampler: KSamplerAdvanced\nremote COMBO routes refreshed: 1/1\nsource upload: audit-wpar-source.png\ndynamic POST: ${expanded}\nplaceholder declarers: 0\nMULTI_COMBO declarers: 0\nremote policy declarers: 0`
      document.body.appendChild(banner)
    },
    {
      expanded: submitted!.graph.nodes.encode.inputs.text,
      catalogDigest: canonicalCatalogSha256,
    },
  )
  await page.screenshot({
    path: `${proofDir}/02-dynamic-submit-and-absence-accounting.png`,
    animations: 'disabled',
  })
  console.log(
    JSON.stringify({
      canonicalCatalogSha256,
      round: 'DualModelGuider.cfg 8.129 -> 8.13',
      sampler: 'KSamplerAdvanced',
      choiceRequests,
      mediaUpload: Object.fromEntries(mediaUrl.searchParams),
      dynamicPrompt: submitted!.graph.nodes.encode.inputs.text,
      placeholderDeclarers: 0,
      multiComboDeclarers: 0,
      remotePolicyDeclarers: 0,
      cancelledJob: { clientId: submitted!.clientId, jobId: submitted!.jobId },
    }),
  )
})
