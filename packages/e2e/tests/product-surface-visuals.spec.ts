import { expect, appViewTest as test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.route('/api/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.route('/memory/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.route('/supervisor/**', (route) =>
    route.fulfill({ status: 502, body: 'visual fixture unavailable' }),
  )
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'visual-fixture' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.routeWebSocket('**/ws?*', () => {})
})

const screenshot = async (page: Page, name: string, immediate = false): Promise<void> => {
  if (immediate) {
    expect(await page.screenshot({ animations: 'disabled' })).toMatchSnapshot(`${name}.png`, {
      maxDiffPixelRatio: 0.002,
    })
    return
  }
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    maxDiffPixelRatio: 0.002,
  })
}

const boot = async (page: Page): Promise<void> => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
}

const closeGallery = async (page: Page): Promise<void> => {
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible()))
    await close.first().click()
  else
    await page.evaluate(() =>
      (window.__dinksterTest!.app as unknown as {
        readonly templateGalleryOpen: { set(value: boolean): void }
      }).templateGalleryOpen.set(false),
    )
  await expect(page.getByTestId('template-gallery')).toBeHidden()
}

const openDock = async (page: Page, testId: string): Promise<void> => {
  const toggle = page.getByTestId(testId)
  if ((await toggle.getAttribute('aria-pressed')) !== 'true')
    await toggle.click()
}

const openRail = async (page: Page, title: string): Promise<void> => {
  const rail = page.getByTestId('dock-zone-right')
  if (!(await rail.isVisible())) await page.getByTestId('rail-toggle').click()
  const tab = rail.getByRole('tab', { name: title, exact: true })
  if ((await tab.count()) > 0 && (await tab.first().isVisible())) {
    await tab.first().click()
    return
  }
  await rail.getByTestId('dock-zone-overflow-button').click()
  await page
    .getByRole('menuitemradio')
    .filter({ hasText: title })
    .first()
    .click()
}

const openModal = async (page: Page, id: string): Promise<void> => {
  await page.evaluate(
    (panel) => (window.__dinksterTest!.app as unknown as {
      readonly modalPanel: { set(value: string): void }
    }).modalPanel.set(panel),
    id,
  )
}

test('shell controls at desktop and compact widths', async ({ page }) => {
  await boot(page)
  expect(await page.evaluate(() => {
    const faces: string[] = []
    document.fonts.forEach((face) => {
      if (face.status === 'loaded') faces.push(`${face.family.replaceAll('"', '')}:${face.style}:${face.weight}`)
    })
    return faces.sort()
  })).toEqual([
    'Noto Sans Mono:normal:100 900',
    'Noto Sans:italic:100 900',
    'Noto Sans:normal:100 500',
    'Noto Sans:normal:600 900',
  ])
  await closeGallery(page)
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await expect(page.getByTestId('left-panel-toggle')).toBeVisible()
    await expect(page.getByTestId('backends-toggle')).toBeVisible()
    await screenshot(page, `shell-controls-${width}`)
    await page.getByTestId('dinkster-menu-button').click()
    await expect(page.getByTestId('dinkster-menu-button')).toHaveAttribute('aria-expanded', 'true')
    await screenshot(page, `shell-menu-${width}`)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('dinkster-menu-button')).toBeFocused()
  }
})

test('writable runtime argument and logging controls at desktop and compact widths', async ({ page }) => {
  const settings = {
    categories: { granted: ['worker-comfy-args', 'logging'], available: ['worker-comfy-args', 'logging'] },
    settings: {
      'worker-comfy-args': { value: ['--preview-method', 'latent2rgb'], source: 'runtime', mutability: 'on-worker-restart', writable: true, persistence: { available: true, persisted: false } },
      logging: { value: { level: 'info', overrides: { 'dinkster.engine': 'debug' } }, source: 'config', mutability: 'live', writable: true, persistence: { available: true, persisted: true } },
    },
  }
  await page.route('**/api/settings*', (route) => route.fulfill({ json: settings }))
  await boot(page)
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      addBackend(url: string, label: string, persist: boolean, protocol: string): void
    }
    app.addBackend('/runtime-visual', 'Runtime visual', false, 'dinkster')
  })
  await page.getByTestId('backends-sidebar-toggle').click()
  const runtime = page.getByTestId('runtime-settings').first()
  await runtime.locator('.runtime-settings-toggle').click()
  const argumentsCategory = runtime.locator('details[data-category="worker-comfy-args"]')
  const loggingCategory = runtime.locator('details[data-category="logging"]')
  await expect(argumentsCategory.getByRole('textbox')).toHaveCount(2)
  await expect(loggingCategory.getByRole('textbox')).toHaveCount(2)
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await loggingCategory.evaluate((element) => { element.removeAttribute('open') })
    await argumentsCategory.evaluate((element) => { element.setAttribute('open', '') })
    await argumentsCategory.locator('fieldset').scrollIntoViewIfNeeded()
    await screenshot(page, `runtime-arguments-${width}`)
    await argumentsCategory.evaluate((element) => { element.removeAttribute('open') })
    await loggingCategory.evaluate((element) => { element.setAttribute('open', '') })
    await loggingCategory.locator('fieldset').scrollIntoViewIfNeeded()
    await screenshot(page, `runtime-logging-${width}`)
  }
})

test('populated output viewer in single, grid and compare modes', async ({ page }) => {
  await page.route(/\/view(?:\?|$)/, (route) => route.fulfill({
    contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400"><rect width="640" height="400" fill="#173f6c"/><circle cx="420" cy="180" r="100" fill="#d7a86e"/></svg>',
  }))
  await boot(page)
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'OutputVisual', displayName: 'Image output', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'output', id: 'images', type: { kind: 'concrete', name: 'comfy.IMAGE' } }],
    }])
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'output-visual', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Image output', nodes: { save: { id: 'save', type: 'OutputVisual', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { save: { position: { x: 120, y: 100 } } } } } },
    }, 'Image output')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'visual-output' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, 0)
    store.apply({ kind: 'started', execution: ref, timestamp: 0 })
    store.apply({ kind: 'nodeOutput', execution: ref, runtimeNodeId: 'save', timestamp: 0,
      output: { images: [{ filename: 'coastline.png' }, { filename: 'sunset.png' }] } })
    store.apply({ kind: 'completed', execution: ref, timestamp: 0 })
  })
  await openRail(page, 'Outputs')
  await page.locator('.output-thumbnail').first().click()
  const viewer = page.getByTestId('output-viewer')
  await expect(viewer.locator('img')).toBeVisible()
  await expect(viewer.locator('.output-availability')).toContainText('Available')
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await viewer.getByRole('button', { name: 'Single', exact: true }).click()
    await screenshot(page, `output-viewer-single-${width}`)
    await viewer.getByRole('button', { name: 'Show all images' }).click()
    await expect(viewer.getByRole('listitem')).toHaveCount(2)
    await screenshot(page, `output-viewer-grid-${width}`)
    await viewer.getByRole('button', { name: 'Compare slider' }).click()
    await expect(viewer.getByRole('slider', { name: 'Compare split' })).toBeVisible()
    await screenshot(page, `output-viewer-compare-${width}`)
  }
})

test('populated compositor controls at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'CompositorVisual', displayName: 'Create Layered Image', category: 'test', source: 'v3', isOutputNode: true, editorRole: 'compositor',
      items: [{ kind: 'input', id: 'recipe', optional: true, type: { kind: 'concrete', name: 'dinkster.compositor' },
        widget: { widgetType: 'COMPOSITOR', options: {}, default: { version: 2, documentDigest: null, commands: [] } } }],
    }])
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'compositor-visual', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Compositor', nodes: { create: { id: 'create', type: 'CompositorVisual', values: { recipe: { version: 2, documentDigest: null, commands: [] } } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: { create: { position: { x: 120, y: 100 } } } } } },
    }, 'Compositor')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const tab = app.activeTab()!
    const editorApp = app as unknown as {
      compositorTargetForInput(tab: unknown, graph: string, node: string, input: string): unknown
      openCompositorEditor(target: unknown): boolean
      registerRun(tab: unknown, ref: unknown, artifact: unknown, now: number): void
    }
    const target = editorApp.compositorTargetForInput(tab, 'g0', 'create', 'recipe')!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'compositor-visual' }
    editorApp.registerRun(tab, ref, compiled.artifact, 0)
    const digest = `blake3:${'a'.repeat(64)}`
    const transform = (x: number, y: number, width: number, height: number) => ({
      a: 1_000_000, b: 0, c: 0, d: 1_000_000, tx: x * 1_000_000, ty: y * 1_000_000,
      components: { x, y, width, height, rotation: 0, flipHorizontal: false, flipVertical: false, sourceWidth: width, sourceHeight: height },
    })
    const resource = (id: string, width: number, height: number) => ({ id, kind: 'raster', digest, byteSize: 1, mediaType: 'image/png', width, height, colorSpace: 'srgb', channelDepth: 8, alphaMode: 'straight' })
    const imageDocument = {
      format: 'dinkster-image', formatVersion: 2, lineage: 'compositor-visual-state',
      canvas: { width: 320, height: 240, colorSpace: 'srgb', channelDepth: 8, compositing: 'premultiplied-alpha', background: [4112, 8224, 12336, 32768] },
      allocation: { nextOrdinal: 4 }, rootLayerIds: ['l0', 'l2'],
      layers: {
        l0: { id: 'l0', kind: 'raster', name: 'Background', visible: true, opacity: 65535, transform: transform(0, 0, 320, 240), blendMode: 'normal', clipping: 'none', maskIds: [], resourceId: 'r1', sourceRect: { x: 0, y: 0, width: 320, height: 240 }, z_index: 0 },
        l2: { id: 'l2', kind: 'raster', name: 'Overlay', visible: true, opacity: 49151, transform: transform(40, 30, 80, 60), blendMode: 'screen', clipping: 'none', maskIds: [], resourceId: 'r3', sourceRect: { x: 0, y: 0, width: 80, height: 60 }, z_index: 1 },
      },
      masks: {}, resources: { r1: resource('r1', 320, 240), r3: resource('r3', 80, 60) },
    }
    const runtimeNodeId = 'create'
    const store = app.store as unknown as { apply(event: unknown): void }
    store.apply({ kind: 'preview', execution: ref, timestamp: 0, runtimeNodeId,
      channel: 'application/vnd.dinkster.compositor-state+json', stream: 'compositor-state',
      payload: { version: 2, document: imageDocument, documentDigest: digest, stale: false, layerStreams: ['compositor.layer.0', 'compositor.layer.1'] } })
    for (const [index, color] of ['#173f6c', '#d7a86e'].entries()) {
      const canvas = document.createElement('canvas')
      canvas.width = index === 0 ? 320 : 80
      canvas.height = index === 0 ? 240 : 60
      const context = canvas.getContext('2d')!
      context.fillStyle = color
      context.fillRect(0, 0, canvas.width, canvas.height)
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), (character) => character.charCodeAt(0))
      store.apply({ kind: 'preview', execution: ref, timestamp: 0, runtimeNodeId, channel: 'image/png', stream: `compositor.layer.${index}`, payload: bytes.buffer })
    }
    if (!editorApp.openCompositorEditor(target)) throw new Error('Compositor fixture did not open')
  })
  const editor = page.getByTestId('compositor-editor')
  await expect(editor.locator('.compositor-layer-row')).toHaveCount(2)
  await expect(editor.getByTestId('compositor-preview-canvas').locator('img')).toHaveCount(2)
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await screenshot(page, `compositor-controls-${width}`)
    const flip = editor.getByRole('button', { name: 'Flip horizontal', exact: true })
    await flip.scrollIntoViewIfNeeded()
    await flip.click()
    await expect(flip).toHaveAttribute('aria-pressed', 'true')
    await screenshot(page, `compositor-controls-selected-${width}`)
    await editor.getByRole('combobox', { name: 'Blend mode' }).click()
    await expect(page.getByRole('option', { name: 'screen', exact: true })).toBeVisible()
    await screenshot(page, `compositor-controls-options-${width}`)
    await page.getByRole('option', { name: 'luminosity', exact: true }).scrollIntoViewIfNeeded()
    await expect(page.getByRole('option', { name: 'luminosity', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await flip.scrollIntoViewIfNeeded()
    await flip.click()
    await editor.locator('.compositor-properties').evaluate((element) => { element.scrollTop = 0 })
  }
})

test('populated image workspace at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.getByTestId('image-documents-button').click()
  const workspace = page.getByTestId('image-document-workspace')
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const context = canvas.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, 640, 400)
    gradient.addColorStop(0, '#173f6c')
    gradient.addColorStop(1, '#d7a86e')
    context.fillStyle = gradient
    context.fillRect(0, 0, 640, 400)
    return [...new Uint8Array(await (await fetch(canvas.toDataURL('image/png'))).arrayBuffer())]
  })
  await workspace.locator('.image-document-tabs input[type=file]').setInputFiles({
    name: 'Coastline.png', mimeType: 'image/png', buffer: Buffer.from(bytes),
  })
  await expect(page.getByTestId('image-document-editor')).toBeVisible()
  await expect(workspace.locator('.image-document-layer-row')).toHaveCount(1)
  await expect(workspace.locator('.image-document-preview canvas')).toHaveAttribute('width', '640')
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await screenshot(page, `image-workspace-${width}`)
  }
})

test('canvas chrome at desktop and compact widths', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const width of [1440, 900]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 700 })
    await expect(page.getByTestId('canvas-zoom-in')).toBeVisible()
    await screenshot(page, `canvas-chrome-${width}`)
    await page.getByTestId('minimap-settings').click()
    await expect(page.locator('.minimap-menu')).toBeVisible()
    await screenshot(page, `canvas-minimap-settings-${width}`)
    await page.keyboard.press('Escape')
    await expect(page.locator('.minimap-menu')).toBeHidden()
    await page.getByTestId('views-switcher').click()
    await expect(page.getByRole('menuitem', { name: /Noodles/ })).toBeVisible()
    await screenshot(page, `canvas-view-menu-${width}`)
    await page.getByTestId('views-switcher').click()
  }
})

test('shell and canvas visual matrix', async ({ page }) => {
  await boot(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      readonly backends: { get(): readonly { readonly templatesEnabled: { set(value: boolean): void } }[] }
      readonly templateGalleryOpen: { set(value: boolean): void }
    }
    app.backends.get()[0]!.templatesEnabled.set(true)
    app.templateGalleryOpen.set(true)
  })
  await expect(page.getByTestId('template-gallery')).toBeVisible()
  await screenshot(page, '01-starter-template-gallery')
  await closeGallery(page)
  await screenshot(page, '02-shell-and-top-bar')
  const rightRail = page.getByTestId('dock-zone-right')
  if (!(await rightRail.isVisible())) await page.getByTestId('rail-toggle').click()
  await expect(rightRail).toBeVisible()
  await screenshot(page, '03-right-rail-tabs')
  await page.getByTestId('rail-toggle').click()
  await expect(rightRail).toBeHidden()
  await page.getByTestId('minimap-settings').click()
  await expect(page.locator('.minimap-menu')).toBeVisible()
  await page.mouse.move(720, 450)
  await page.waitForTimeout(600)
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await screenshot(page, '04-canvas-toolbar')
  await page.keyboard.press('Escape')
  await expect(page.locator('.minimap-menu')).toBeHidden()
  await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([
      {
        type: 'EmptyImage',
        displayName: 'Empty Image',
        category: 'visual',
        source: 'visual',
        isOutputNode: false,
        items: [
          {
            kind: 'output',
            id: 'out0',
            type: { kind: 'concrete', name: 'IMAGE' },
          },
        ],
      },
    ])
    bridge.app.openDocument(
      bridge.syntheticWorkflow({ chains: 1, chainLength: 2, reroutes: false }),
      'Visual controls',
    )
  })
  await screenshot(page, '05-canvas-nodes')
  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  if (!canvas) throw new Error('graph canvas did not render')
  await page.mouse.click(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height / 2,
    { button: 'right' },
  )
  await screenshot(page, '06-canvas-context-menu')
  await page.keyboard.press('Escape')
  await page.getByTestId('views-switcher').click()
  await screenshot(page, '07-views-switcher')
  await page.keyboard.press('Escape')
  await page.mouse.dblclick(
    canvas.x + canvas.width / 2,
    canvas.y + canvas.height / 2,
  )
  await screenshot(page, '08-node-palette')
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
    readonly searchOpen: { set(value: boolean): void }
  }).searchOpen.set(true))
  await screenshot(page, '09-universal-search')
})

test('dock visual matrix', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  const panels = [
    ['library-toggle', '10-library'],
    ['learn-toggle', '11-learn'],
    ['assets-toggle', '12-assets'],
    ['backends-sidebar-toggle', '13-backends'],
    ['memory-sidebar-toggle', '14-memory'],
    ['logs-toggle', '16-activity'],
    ['execution-log-toggle', '17-execution-log'],
  ] as const
  for (const [testId, name] of panels) {
    await openDock(page, testId)
    if (name === '11-learn') {
      const input = page.getByLabel('Search guides')
      await input.hover()
      await input.focus()
      await page.mouse.move(720, 450)
      await page.waitForTimeout(600)
      const styles = await input.evaluate((element) => {
        const control = getComputedStyle(element)
        const body = getComputedStyle(document.body)
        return {
          font: control.fontFamily,
          bodyFont: body.fontFamily,
          radius: control.borderRadius,
          outline: control.outlineStyle,
        }
      })
      expect(styles.font).toBe(styles.bodyFont)
      expect(styles.radius).not.toBe('0px')
      expect(styles.outline).toBe('solid')
      await page.keyboard.press('Escape')
      await expect(input).toBeFocused()
      await expect(page.getByTestId('app-tooltip')).toBeHidden()
    }
    if (name === '17-execution-log')
      await page.getByTestId('execution-log-node-select').click()
    await screenshot(page, name, name === '11-learn')
  }
})

test('rail visual matrix', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const [title, name] of [
    ['Executions', '18-executions'],
    ['Outputs', '19-outputs'],
    ['Extensions', '20-extensions'],
    ['Boundary', '21-boundary'],
    ['Focused', '22-focused'],
    ['Help', '23-node-help'],
    ['Problems', '24-problems'],
  ] as const) {
    await openRail(page, title)
    await screenshot(page, name)
  }
})

test('modal visual matrix', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  for (const [id, name] of [
    ['settings', '25-settings'],
    ['customize-layout', '26-customize-layout'],
    ['projects', '27-projects'],
    ['subgraph-definitions', '28-subgraph-definitions'],
    ['collab', '29-collaboration'],
    ['desktop-management', '30-desktop-management'],
  ] as const) {
    await openModal(page, id)
    await screenshot(page, name)
    await page.evaluate(() => (window.__dinksterTest!.app as unknown as {
      readonly modalPanel: { set(value: string): void }
    }).modalPanel.set(''))
  }
})

test('populated app-view controls and arrange visuals', async ({ page }) => {
  await boot(page)
  await closeGallery(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const inputs = [
      { id: 'prompt', label: 'Prompt', widgetType: 'STRING', value: 'A quiet mountain lake' },
      { id: 'steps', label: 'Steps', widgetType: 'INT', value: 24 },
      { id: 'enabled', label: 'Enabled', widgetType: 'BOOLEAN', value: true },
      { id: 'color', label: 'Color', widgetType: 'COLOR', value: '#3498db' },
    ]
    app.registerSchemas([{
      type: 'AppViewVisual', displayName: 'Image settings', category: 'test', source: 'visual', isOutputNode: true,
      items: inputs.map((input) => ({
        kind: 'input', id: input.id, type: { kind: 'concrete', name: input.widgetType }, optional: false,
        widget: { widgetType: input.widgetType, options: {}, default: input.value },
      })),
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-visual', root: 'g0',
      meta: { title: 'Landscape studio', description: 'Set the prompt and image controls, then queue the workflow.' },
      graphs: { g0: {
        id: 'g0', name: 'root', nodes: { settings: { id: 'settings', type: 'AppViewVisual', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: { settings: { position: { x: 100, y: 100 } } } } } },
      ext: {
        'dinkster.exposed': inputs.map((input) => ({ graphId: 'g0', nodeId: 'settings', inputId: input.id, label: input.label })),
        'dinkster.appLayout': {
          version: 1,
          desktop: { items: [
            { id: 'instructions', kind: 'text', role: 'body', text: 'Choose the look for your next image.' },
            { id: 'controls', kind: 'group', title: 'Image controls', children: ['prompt', 'steps', 'enabled', 'color'] },
            ...inputs.map((input) => ({ id: input.id, kind: 'control', ref: { graphId: 'g0', nodeId: 'settings', inputId: input.id } })),
          ] },
          mobile: { customized: false, items: [], order: [] },
        },
      },
    }, 'Landscape studio')
  })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Prompt', exact: true })).toHaveValue('A quiet mountain lake')
  await expect(page.getByRole('spinbutton', { name: 'Steps', exact: true })).toHaveValue('24')
  await expect(page.getByRole('checkbox', { name: 'Toggle Enabled' })).toBeChecked()
  await expect(page.getByTestId('app-view-color')).toContainText('#3498db')
  await screenshot(page, 'app-view-controls')
  await page.setViewportSize({ width: 1440, height: 1400 })
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-layout-text-input')).toHaveValue('Choose the look for your next image.')
  await expect(page.getByTestId('app-layout-group-title')).toHaveValue('Image controls')
  await screenshot(page, 'app-view-arrange-controls')
})

test('document and app-view visual matrix', async ({ page }) => {
  const typed = (name: string) => ({ kind: 'concrete', types: [name] })
  const nodes = Object.fromEntries(
    ['make', 'retime'].map((command) => [
      `dinkster.video_document.${command}`,
      {
        schemaVersion: 1,
        nodeType: `dinkster.video_document.${command}`,
        version: 1,
        displayName: `Video document ${command}`,
        category: 'video/timeline',
        description: '',
        idempotent: true,
        outputNode: true,
        interface:
          command === 'make'
            ? [
                {
                  role: 'input',
                  id: 'params',
                  type: typed('STRING'),
                  required: false,
                  default: '{}',
                  widget: { type: 'STRING', multiline: true },
                },
                {
                  role: 'output',
                  id: 'document',
                  type: typed('dinkster.video_document'),
                },
              ]
            : [
                {
                  role: 'input',
                  id: 'document',
                  type: typed('dinkster.video_document'),
                  required: true,
                },
                {
                  role: 'input',
                  id: 'params',
                  type: typed('STRING'),
                  required: true,
                  widget: { type: 'STRING', multiline: true },
                },
                {
                  role: 'output',
                  id: 'document',
                  type: typed('dinkster.video_document'),
                },
              ],
      },
    ]),
  )
  await page.route('/api/nodes*', (route) =>
    route.fulfill({
      json: {
        schemaVersion: 1,
        epoch: 1,
        dinkster: { version: 'visual', schemaWire: 1 },
        nodes,
      },
    }),
  )
  await boot(page)
  await closeGallery(page)
  await page.getByTestId('views-switcher').click()
  const appView = page.getByRole('menuitemradio', { name: 'App view' })
  if ((await appView.count()) > 0) await appView.click()
  await screenshot(page, '32-app-view-empty')
  const arrange = page.getByTestId('app-view-arrange-toggle')
  if ((await arrange.count()) > 0) await arrange.click()
  await screenshot(page, '33-app-view-arrange')
  await page.getByTestId('image-documents-button').click()
  await screenshot(page, '31-image-document')
  await page.getByTestId('image-documents-button').click()
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Graph' }).click()
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'visual-video',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'Video document',
            nodes: {
              source: {
                id: 'source',
                type: 'dinkster.video_document.make',
                values: { params: '{}' },
              },
              edit: {
                id: 'edit',
                type: 'dinkster.video_document.retime',
                values: { params: '{"track":1,"clip":2,"scalar":0.5}' },
              },
            },
            links: {
              document: {
                id: 'document',
                from: { node: 'source', port: 'document' },
                to: { node: 'edit', port: 'document' },
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
                source: { position: { x: 60, y: 80 } },
                edit: { position: { x: 500, y: 80 } },
              },
            },
          },
        },
      },
      'Video document',
    )
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer
      .getScene()
      .nodes.find((candidate) => candidate.id === 'edit')!
    const row = node.layout.rows.find(
      (candidate) =>
        candidate.kind === 'widget' && candidate.inputId === 'params',
    )!
    const rect = document
      .querySelector('[data-testid=graph-canvas]')!
      .getBoundingClientRect()
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + row.y + row.height / 2,
    }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('video-document-editor')).toBeVisible()
  await screenshot(page, '34-video-document-editor')
})
