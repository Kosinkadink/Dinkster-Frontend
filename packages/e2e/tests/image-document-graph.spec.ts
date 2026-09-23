import { expect, test } from '@playwright/test'

const mime = 'application/vnd.dinkster.image-document+json'

test.beforeEach(async ({ page }) => {
  await page.route('/api/**', (route) =>
    route.fulfill({ status: 404, json: { error: 'isolated fixture' } }),
  )
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, body: 'isolated fixture' }),
  )
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'test' }, devices: [] } }),
  )
  await page.route('/api/nodes*', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        epoch: 1,
        dinkster: { version: 'layer-document-test', schemaWire: 1 },
        nodes: {},
      },
    }),
  )
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__dinksterTest?.app.backends.get()[0]?.registry.get() !==
          undefined,
      ),
    )
    .toBe(true)
})

test('opens graph layers, recovers edits and explicitly exports an asset-backed snapshot', async ({
  page,
}, testInfo) => {
  const fixture = await page.evaluate(async () => {
    const modulePath = '/src/image-document-local.ts'
    const { ImageDocumentLocalStore, importSingleRaster } = await import(
      modulePath
    )
    const corePath = '/@id/@dinkster/core'
    const { serializeImageDocument } = await import(corePath)
    const store = new ImageDocumentLocalStore('fixture-only')
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const context = canvas.getContext('2d')!
    context.fillStyle = '#155e75'
    context.fillRect(0, 0, 640, 360)
    context.fillStyle = '#67e8f9'
    context.fillRect(80, 70, 220, 220)
    context.fillStyle = '#fb718580'
    context.fillRect(220, 120, 330, 170)
    const png = await (await fetch(canvas.toDataURL('image/png'))).blob()
    const draft = await importSingleRaster(
      new File([png], 'Graph raster.png', { type: 'image/png' }),
      store,
      { lineage: 'graph-image-fixture' },
    )
    const resource = (await store.getResource(
      draft.document.resources.r0.digest,
    ))!
    await store.close()
    return {
      canonical: serializeImageDocument(draft.document) as string,
      document: draft.document,
      bytes: Array.from(resource.bytes) as number[],
    }
  })
  const requests: URL[] = []
  const phases: string[] = []
  await page.route('**/api/values?*', (route) => {
    const url = new URL(route.request().url())
    requests.push(url)
    if (url.searchParams.has('rendition')) phases.push('document')
    return url.searchParams.has('rendition')
      ? route.fulfill({
          contentType: mime,
          body: fixture.canonical,
          headers: {
            'X-Dinkster-Type-Id': 'dinkster.layers',
            'X-Dinkster-Fingerprint': 'graph-document',
            'X-Dinkster-Rendition': 'document',
          },
        })
      : route.fulfill({
          json: {
            available: true,
            descriptor: {
              typeId: 'dinkster.layers',
              fingerprint: 'graph-document',
            },
            renditions: [{ kind: 'document', mime }],
          },
        })
  })
  let exported: unknown
  await page.route(/\/api\/assets(?:\/.*)?(?:\?.*)?$/, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const resources = fixture.document.resources as Record<
      string,
      Record<string, unknown> & { id: string; digest: string }
    >
    if (request.method() === 'GET') {
      phases.push('asset')
      return route.fulfill({
        contentType: 'image/png',
        body: Buffer.from(fixture.bytes),
      })
    }
    if (url.pathname.endsWith('/render')) {
      phases.push('render')
      const selector = (request.postDataJSON() as { selector: string }).selector
      const resource = Object.values(resources)[0]!
      return route.fulfill({
        status: 201,
        json: {
          cacheKey: `blake3:${'e'.repeat(64)}`,
          cached: false,
          asset: {
            digest: resource.digest,
            name: 'composite.png',
            size: fixture.bytes.length,
            mediaType: 'image/png',
            virtualPath: '',
          },
          provenance: {
            documentDigest: decodeURIComponent(url.pathname.split('/').at(-2)!),
            selector,
            profile: 'dinkster-image-document-v2-cpu-reference',
            rendererContract: 'fixture-renderer',
            encoding: 'image/png;dinkster-canonical=1',
            source: {
              digest: decodeURIComponent(url.pathname.split('/').at(-2)!),
              mediaType: mime,
              dependencies: Object.values(resources).map((entry) => {
                const { id, kind: _kind, ...fields } = entry
                return { resourceId: id, ...fields }
              }),
            },
            output: {
              digest: resource.digest,
              byteSize: fixture.bytes.length,
              mediaType: 'image/png',
              width: (fixture.document.canvas as { width: number }).width,
              height: (fixture.document.canvas as { height: number }).height,
              encoding: 'image/png;dinkster-canonical=1',
            },
          },
        },
      })
    }
    const digest = await request.headerValue('x-dinkster-digest')
    if (url.pathname === '/api/assets/media')
      return route.fulfill({
        status: 201,
        json: {
          kind: 'media/image',
          asset: {
            digest,
            name: 'resource.png',
            size: request.postDataBuffer()!.length,
            mediaType: 'image/png',
            virtualPath: '',
          },
        },
      })
    phases.push('adopt')
    const document = request.postDataJSON()
    exported = document
    return route.fulfill({
      status: 201,
      json: {
        digest,
        mediaType: mime,
        byteSize: request.postDataBuffer()!.length,
        dependencies: Object.values(
          document.resources as Record<string, Record<string, unknown>>,
        ).map((resource) => {
          const { id, kind: _kind, ...fields } = resource
          return { resourceId: id, ...fields }
        }),
      },
    })
  })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'LayerDocumentTest',
        displayName: 'Layer document',
        category: 'test',
        source: 'v3',
        isOutputNode: true,
        items: [
          {
            kind: 'output',
            id: 'layers',
            type: { kind: 'concrete', name: 'dinkster.layers' },
          },
        ],
      },
      {
        type: 'dinkster.layers.load',
        displayName: 'Load Layers',
        category: 'image',
        source: 'v3',
        isOutputNode: false,
        items: [
          {
            kind: 'input',
            id: 'document',
            type: { kind: 'concrete', name: 'dinkster.asset' },
            optional: false,
            widget: { widgetType: 'ASSET', options: {} },
          },
          {
            kind: 'output',
            id: 'layers',
            type: { kind: 'concrete', name: 'dinkster.layers' },
          },
        ],
      },
      {
        type: 'dinkster.layers.flatten',
        displayName: 'Flatten Layers',
        category: 'image',
        source: 'v3',
        isOutputNode: false,
        items: [
          {
            kind: 'input',
            id: 'layers',
            type: { kind: 'concrete', name: 'dinkster.layers' },
            optional: false,
          },
          {
            kind: 'input',
            id: 'selector',
            type: { kind: 'concrete', name: 'core.string' },
            optional: true,
            widget: { widgetType: 'STRING', options: {}, default: 'composite' },
          },
          {
            kind: 'output',
            id: 'image',
            type: { kind: 'concrete', name: 'dinkster.image' },
          },
        ],
      },
      {
        type: 'dinkster.layers.edit',
        displayName: 'Edit Layers',
        category: 'image',
        source: 'v3',
        isOutputNode: false,
        items: [
          {
            kind: 'input',
            id: 'layers',
            type: { kind: 'concrete', name: 'dinkster.layers' },
            optional: false,
          },
          {
            kind: 'input',
            id: 'commands',
            type: { kind: 'concrete', name: 'core.string' },
            optional: false,
            widget: { widgetType: 'STRING', options: { multiline: true } },
          },
          {
            kind: 'output',
            id: 'layers',
            type: { kind: 'concrete', name: 'dinkster.layers' },
          },
        ],
      },
      {
        type: 'dinkster.save_image',
        displayName: 'Save Image',
        category: 'image',
        source: 'v3',
        isOutputNode: true,
        items: [
          {
            kind: 'input',
            id: 'images',
            type: { kind: 'concrete', name: 'dinkster.image' },
            optional: false,
          },
          {
            kind: 'input',
            id: 'format',
            type: { kind: 'concrete', name: 'core.combo' },
            optional: true,
            widget: {
              widgetType: 'COMBO',
              options: { options: ['png', 'jpeg', 'webp'] },
              default: 'png',
            },
          },
          {
            kind: 'input',
            id: 'quality',
            type: { kind: 'concrete', name: 'core.int' },
            optional: true,
            widget: {
              widgetType: 'INT',
              options: { min: 0, max: 100, step: 1 },
              default: 90,
            },
          },
          {
            kind: 'output',
            id: 'assets',
            type: {
              kind: 'list',
              element: {
                kind: 'asset',
                element: { kind: 'concrete', name: 'dinkster.image' },
              },
            },
          },
        ],
      },
    ])
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'graph-layer-workflow',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'Layers',
            nodes: {
              source: { id: 'source', type: 'LayerDocumentTest', values: {} },
            },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 2,
          },
        },
        view: { graphs: {} },
      },
      'Layer workflow',
    )
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = {
      connection: compiled.artifact.connection,
      prompt: 'graph-layer-run',
    }
    const store = app.store as unknown as {
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeOutput',
      execution: ref,
      runtimeNodeId: 'source',
      timestamp: Date.now(),
      output: {
        layers: { typeId: 'dinkster.layers', fingerprint: 'graph-document' },
      },
    })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
  })
  await page.locator('.dock-zone').getByRole('tab', { name: 'Outputs' }).click()
  await page
    .getByRole('button', { name: 'Open layers: source / layers' })
    .click()
  const workspace = page.getByTestId('image-document-workspace')
  await expect(
    workspace.getByRole('button', { name: /Graph raster/ }),
  ).toBeVisible()
  const authoritative = workspace.getByTestId(
    'authoritative-image-document-render',
  )
  await expect(authoritative).toContainText('composite')
  await expect(
    authoritative.getByRole('img', {
      name: 'Authoritative ImageDocument output',
    }),
  ).toBeVisible()
  await expect
    .poll(() =>
      authoritative
        .getByRole('img')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(640)
  expect(phases.slice(0, 5)).toEqual([
    'document',
    'adopt',
    'render',
    'asset',
    'asset',
  ])
  await workspace.screenshot({
    path: testInfo.outputPath('graph-layer-open-authoritative.png'),
  })
  await expect(workspace).not.toContainText('Preview failed')
  await workspace.getByRole('slider', { name: 'Layer opacity' }).press('Home')
  await workspace.getByRole('button', { name: 'Undo', exact: true }).click()
  await workspace.getByRole('spinbutton', { name: 'Crop x' }).fill('80')
  await workspace.getByRole('spinbutton', { name: 'Crop y' }).fill('40')
  await workspace.getByRole('spinbutton', { name: 'Crop width' }).fill('480')
  await workspace.getByRole('spinbutton', { name: 'Crop height' }).fill('280')
  await workspace.getByRole('button', { name: 'Apply crop' }).click()
  await expect(workspace.locator('.image-document-identity')).toContainText(
    '480 x 280',
  )
  await workspace
    .getByTestId('image-document-crop-controls')
    .screenshot({ path: testInfo.outputPath('graph-layer-crop.png') })
  await workspace.getByRole('spinbutton', { name: 'Resize width' }).fill('320')
  await workspace.getByRole('spinbutton', { name: 'Resize height' }).fill('200')
  await workspace.getByRole('button', { name: 'Apply resize' }).click()
  await expect(workspace.locator('.image-document-identity')).toContainText(
    '320 x 200',
  )
  await workspace
    .getByTestId('image-document-resize-controls')
    .screenshot({ path: testInfo.outputPath('graph-layer-resize.png') })
  await workspace.getByRole('combobox', { name: 'Output format' }).click()
  await page.getByRole('option', { name: 'WEBP' }).click()
  await workspace.getByRole('spinbutton', { name: 'Output quality' }).fill('73')
  await workspace
    .getByRole('spinbutton', { name: 'Output quality' })
    .press('Enter')
  await workspace
    .getByTestId('image-document-output-controls')
    .screenshot({ path: testInfo.outputPath('graph-layer-output-policy.png') })
  await workspace
    .getByRole('button', { name: 'Export editable recipe' })
    .click()
  await expect(page.getByTestId('status-bar')).toContainText(
    'Exported editable image recipe',
  )
  const recipeGraph = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!,
  )
  const editor = Object.values(recipeGraph.nodes).find(
    (node) => node.type === 'dinkster.layers.edit',
  )!
  const saver = Object.values(recipeGraph.nodes).find(
    (node) => node.type === 'dinkster.save_image',
  )!
  expect(JSON.parse(String(editor.values.commands))).toEqual([
    { changes: { height: 200, width: 320 }, op: 'canvas' },
    {
      changes: {
        transform: {
          a: 666667,
          b: 0,
          c: 0,
          d: 714286,
          tx: -53333333,
          ty: -28571429,
        },
      },
      id: 'l1',
      op: 'layer',
    },
  ])
  expect(saver.values).toEqual({ format: 'webp', quality: 73 })
  expect(
    Object.values(recipeGraph.links).some(
      (link) =>
        'node' in link.from &&
        'node' in link.to &&
        link.from.node === 'source' &&
        link.to.node === editor.id,
    ),
  ).toBe(true)
  await workspace.getByRole('button', { name: 'Save draft' }).click()
  await workspace
    .getByRole('button', { name: 'Export snapshot to graph' })
    .click()
  await expect(page.getByTestId('status-bar')).toContainText(
    'Exported image document snapshot',
  )
  expect(exported).toMatchObject({
    canvas: { width: 320, height: 200 },
    extensions: { 'dinkster.outputPolicy': { format: 'webp', quality: 73 } },
    resources: fixture.document.resources,
  })
  expect(
    requests.every(
      (url) =>
        url.searchParams.get('jobId') === 'graph-layer-run' &&
        url.searchParams.get('nodeId') === 'source',
    ),
  ).toBe(true)
  const graph = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!,
  )
  const loaders = Object.values(graph.nodes).filter(
    (node) => node.type === 'dinkster.layers.load',
  )
  const flatteners = Object.values(graph.nodes).filter(
    (node) => node.type === 'dinkster.layers.flatten',
  )
  expect(loaders).toHaveLength(1)
  expect(flatteners).toHaveLength(2)
  expect(Object.keys(graph.nodes)).toHaveLength(6)
  expect(Object.keys(graph.links)).toHaveLength(4)
  expect(
    Object.values(graph.links).some((link) => {
      if (
        !('node' in link.from) ||
        !('node' in link.to) ||
        link.from.node !== loaders[0]!.id
      )
        return false
      const destinationNode = link.to.node
      return flatteners.some((node) => node.id === destinationNode)
    }),
  ).toBe(true)
  expect(graph.nodes.source?.values).toEqual({})
  await workspace
    .getByRole('button', { name: 'Wrap in group', exact: true })
    .click()
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(2)
  await workspace
    .getByRole('checkbox', { name: 'Clip layer to previous' })
    .click()
  await expect(workspace.getByRole('alert')).toContainText(
    'no previous sibling to clip to',
  )
  await expect(
    workspace.getByRole('checkbox', { name: 'Clip layer to previous' }),
  ).not.toBeChecked()
  await workspace.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(1)
  await workspace.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(2)
  const width = workspace.getByRole('spinbutton', { name: 'Canvas width' })
  await width.fill('700')
  await width.press('Enter')
  await expect(workspace.locator('.image-document-identity')).toContainText(
    '700 x 200',
  )
  await workspace.getByRole('button', { name: 'Save draft' }).click()
  await workspace.screenshot({
    path: testInfo.outputPath('graph-layer-workspace.png'),
  })
  await workspace
    .getByRole('checkbox', { name: 'Linear color compositing' })
    .click()
  await expect(workspace.getByRole('alert')).toContainText(
    'Canvas color or background requires the authoritative CPU render',
  )
  const alpha = await workspace
    .getByTestId('image-document-preview')
    .evaluate(
      (canvas: HTMLCanvasElement) =>
        canvas.getContext('2d')!.getImageData(100, 100, 1, 1).data[3],
    )
  expect(alpha).toBe(0)
  await workspace
    .locator('.image-document-layer-row')
    .filter({ hasText: 'group -' })
    .click()
  await workspace.getByRole('checkbox', { name: 'Pass-through group' }).click()
  await workspace.getByRole('button', { name: 'Save draft' }).click()
  await workspace.screenshot({
    path: testInfo.outputPath('graph-layer-cpu-refusal.png'),
  })
  await page.reload()
  await page.locator('.tab[data-tab-id^="image:"] .tab-select').click()
  await expect(
    workspace.getByRole('button', { name: /Graph raster/ }),
  ).toBeVisible()
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(2)
  await expect(workspace.locator('.image-document-identity')).toContainText(
    '700 x 200',
  )
  await expect(
    workspace.getByRole('checkbox', { name: 'Linear color compositing' }),
  ).toBeChecked()
  await expect(
    workspace.getByRole('checkbox', { name: 'Pass-through group' }),
  ).toBeChecked()
})

test('layer rows and structural edits respect explicit z order', async ({
  page,
}, testInfo) => {
  await page.evaluate(async () => {
    const localPath = '/src/image-document-local.ts'
    const projectPath = '/src/projects.ts'
    const { ImageDocumentLocalStore, importSingleRaster } = await import(
      localPath
    )
    const { activeProjectId } = await import(projectPath)
    const store = new ImageDocumentLocalStore(activeProjectId())
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const context = canvas.getContext('2d')!
    context.fillStyle = '#155e75'
    context.fillRect(0, 0, 640, 360)
    const png = await (await fetch(canvas.toDataURL('image/png'))).blob()
    const draft = await importSingleRaster(
      new File([png], 'Front.png', { type: 'image/png' }),
      store,
      { lineage: 'z-order-document' },
    )
    const value = structuredClone(draft.document)
    value.allocation.nextOrdinal = 4
    value.layers.l3 = { ...value.layers.l1, id: 'l3', name: 'Back' }
    value.layers.l1.z_index = 10
    value.rootLayerIds.push('l3')
    await store.saveDraft(value, 'Z order')
    await store.close()
  })
  await page.locator('.tab[data-tab-id^="image:"] .tab-select').click()
  const workspace = page.getByTestId('image-document-workspace')
  const names = workspace.locator('.image-document-layer-row strong')
  await expect(names).toHaveText(['Front', 'Back'])
  await workspace
    .locator('.image-document-layer-row')
    .filter({ hasText: 'Front' })
    .click()
  const zOrder = workspace.getByRole('spinbutton', { name: 'Layer z order' })
  const numericError = workspace.locator('.image-document-error')
  const storedZ = () =>
    page.evaluate(async () => {
      const localPath = '/src/image-document-local.ts'
      const projectPath = '/src/projects.ts'
      const { ImageDocumentLocalStore } = await import(localPath)
      const { activeProjectId } = await import(projectPath)
      const store = new ImageDocumentLocalStore(activeProjectId())
      try {
        return (await store.recoverDraft('z-order-document'))!.document.layers
          .l1.z_index
      } finally {
        await store.close()
      }
    })
  for (const invalid of [
    '',
    '   ',
    'bad',
    '1.5',
    'Infinity',
    '9007199254740992',
  ]) {
    await zOrder.fill(invalid)
    await zOrder.blur()
    await expect(numericError).toContainText('Enter a whole number')
    await expect(names).toHaveText(['Front', 'Back'])
    expect(await storedZ()).toBe(10)
  }
  await workspace.screenshot({
    path: testInfo.outputPath('graph-layer-number-refusal.png'),
  })
  await zOrder.fill('10')
  await zOrder.press('Enter')
  await expect(numericError).toHaveCount(0)
  await zOrder.fill('')
  await zOrder.press('Enter')
  await expect(numericError).toBeVisible()
  await zOrder.press('Escape')
  await expect(zOrder).toHaveValue('10')
  await expect(numericError).toHaveCount(0)
  expect(await storedZ()).toBe(10)
  const width = workspace.getByRole('spinbutton', { name: 'Canvas width' })
  await width.fill('')
  await width.press('Enter')
  await expect(numericError).toBeVisible()
  await width.fill('640')
  await width.press('Enter')
  await expect(numericError).toHaveCount(0)
  await expect(
    workspace.getByRole('button', { name: 'Undo', exact: true }),
  ).toBeDisabled()
  await workspace.getByRole('button', { name: 'Lower', exact: true }).click()
  await expect(names).toHaveText(['Back', 'Front'])
  await workspace.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(names).toHaveText(['Front', 'Back'])
  await workspace
    .getByRole('button', { name: 'Group with below', exact: true })
    .click()
  await expect(names).toHaveText(['Group', 'Front', 'Back'])
  expect(
    await workspace
      .locator('.image-document-layer-row')
      .evaluateAll((rows) =>
        rows.map((row) => Number.parseFloat(getComputedStyle(row).paddingLeft)),
      ),
  ).toEqual([10, 24, 24])
  await expect(workspace.getByRole('alert')).toContainText(
    'authoritative CPU render',
  )
  await workspace.getByRole('button', { name: 'Save draft' }).click()
  await workspace.screenshot({
    path: testInfo.outputPath('graph-layer-z-order.png'),
  })
  await page.reload()
  await page.locator('.tab[data-tab-id^="image:"] .tab-select').click()
  await expect(names).toHaveText(['Group', 'Front', 'Back'])
})

test('mask editing offers explicit bake and cancel without silently modifying the graph', async ({
  page,
}, testInfo) => {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const context = canvas.getContext('2d')!
    context.fillStyle = '#155e75'
    context.fillRect(0, 0, 640, 360)
    context.fillStyle = '#67e8f9'
    context.fillRect(100, 60, 200, 240)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  await page.route('**/api/assets/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from(png, 'base64'),
    }),
  )
  await page.evaluate((size) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'MaskAssetTest',
        displayName: 'Load Image',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [
          {
            kind: 'input',
            id: 'image',
            type: {
              kind: 'asset',
              element: { kind: 'concrete', name: 'dinkster.image' },
            },
            optional: false,
            widget: {
              widgetType: 'ASSET',
              kind: 'image',
              options: { accept: ['image/png'] },
            },
          },
        ],
      },
    ])
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'explicit-mask-bake',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'Mask',
            nodes: {
              source: {
                id: 'source',
                type: 'MaskAssetTest',
                values: {
                  image: {
                    digest: `blake3:${'1'.repeat(64)}`,
                    name: 'source.png',
                    size,
                    mediaType: 'image/png',
                    virtualPath: '',
                  },
                },
              },
            },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 2,
          },
        },
        view: { graphs: {} },
      },
      'Mask editing',
    )
    const tab = app.activeTab()!
    const imageApp = app as unknown as {
      imageTargetForInput(
        tab: unknown,
        graphId: string,
        nodeId: string,
        inputId: string,
      ): unknown
      openImageEditor(target: unknown): boolean
    }
    const target = imageApp.imageTargetForInput(tab, 'g0', 'source', 'image')
    if (!target || !imageApp.openImageEditor(target))
      throw new Error('Image editor refused the typed PNG input')
  }, Buffer.from(png, 'base64').byteLength)
  const editor = page.getByTestId('image-editor')
  await expect(
    editor.getByRole('button', { name: 'Bake to asset' }),
  ).toBeEnabled()
  const original = await page.evaluate(() =>
    JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  )
  await editor.getByRole('button', { name: 'Clear', exact: true }).click()
  const surface = await page.getByTestId('image-mask-surface').boundingBox()
  await page.mouse.move(
    surface!.x + surface!.width * 0.25,
    surface!.y + surface!.height * 0.5,
  )
  await page.mouse.down()
  await page.mouse.move(
    surface!.x + surface!.width * 0.7,
    surface!.y + surface!.height * 0.5,
    { steps: 12 },
  )
  await page.mouse.up()
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
    ),
  ).toBe(original)
  await editor.screenshot({
    path: testInfo.outputPath('mask-explicit-bake.png'),
  })
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(editor).toBeHidden()
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
    ),
  ).toBe(original)
})
