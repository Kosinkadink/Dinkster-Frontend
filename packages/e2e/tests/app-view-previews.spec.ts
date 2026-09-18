import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/app-view-preview-promotion'
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxW8WQAAAABJRU5ErkJggg==', 'base64')

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

async function selectView(page: Page, name: 'Graph' | 'App view'): Promise<void> {
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name }).click()
}

async function canvasPoint(page: Page, target: 'count' | 'preview', nodeId = 'widgets'): Promise<{ x: number; y: number }> {
  return page.evaluate(({ target, nodeId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const bounds = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const local = target === 'preview'
      ? node.layout.preview!
      : node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'count')!
    return {
      x: bounds.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: bounds.top + (node.y + local.y + local.height / 2) * viewport.scale + viewport.y,
    }
  }, { target, nodeId })
}

async function exposeInput(page: Page): Promise<void> {
  const point = await canvasPoint(page, 'count')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await page.locator('[data-item-id="core.widget.expose.toggle"]').click()
}

async function exposePreview(page: Page, nodeId = 'widgets'): Promise<void> {
  const point = await canvasPoint(page, 'preview', nodeId)
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const item = page.locator('[data-item-id="core.node.preview.expose.toggle"]')
  await expect(item).toContainText('Promote to App View')
  await item.click()
}

async function injectLiveFrame(page: Page, width: number, height: number, label: string): Promise<void> {
  await page.evaluate(async ({ width, height, label }) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const store = app.store as unknown as {
      executions: { get(): ReadonlyMap<string, { ref: unknown }> }
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    let ref = [...store.executions.get().values()].find((execution) =>
      (execution.ref as { prompt?: string }).prompt === 'app-view-preview-live')?.ref
    if (ref === undefined) {
      const compiled = app.compileTab(tab)
      if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
      ref = { connection: compiled.artifact.connection, prompt: 'app-view-preview-live' }
      store.register(ref, compiled.artifact, Date.now())
      store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
      store.apply({
        kind: 'nodeStates',
        execution: ref,
        timestamp: Date.now(),
        nodes: { widgets: { state: 'running' } },
      })
    }
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')!
    const gradient = context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#0f766e')
    gradient.addColorStop(1, '#2563eb')
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
    context.fillStyle = '#ffffff'
    context.font = `600 ${Math.max(18, Math.round(width / 12))}px sans-serif`
    context.textAlign = 'center'
    context.fillText(label, width / 2, height / 2 + 10)
    const payload = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    store.apply({
      kind: 'preview',
      execution: ref,
      timestamp: Date.now(),
      runtimeNodeId: 'widgets',
      channel: 'image/png',
      payload,
    })
  }, { width, height, label })
}

test.beforeEach(async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AppViewPreviewTest', displayName: 'Image Result', category: 'test', source: 'v3', isOutputNode: false,
      emitsPreviews: true,
      items: [
        widget('count', 'INT', 5, { min: 0, max: 100, step: 1 }),
        widget('prompt', 'STRING', 'A multiline prompt', { multiline: true }),
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-preview-test', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          widgets: { id: 'widgets', type: 'AppViewPreviewTest', values: {} },
          other: { id: 'other', type: 'AppViewPreviewTest', values: {} },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: {
        widgets: { position: { x: 20, y: 80 }, size: { width: 460, height: 420 } },
        other: { position: { x: 500, y: 80 } },
      } } } },
    }, 'App View Preview Test')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'app-view-preview-test')
    return tab !== undefined && 'status' in tab.store
  })
  await injectLiveFrame(page, 240, 135, 'Canvas preview')
  await expect.poll(() => page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    return renderer.getScene().nodes.find((node) => node.id === 'widgets')?.layout.preview !== undefined &&
      renderer.getNodePreviews()['widgets'] !== undefined
  }), { timeout: 10_000 }).toBe(true)
})

test('a compact pre-execution surface promotes to App View', async ({ page }) => {
  const screenshotGraph = async (name: string): Promise<void> => {
    const bounds = await page.getByTestId('graph-canvas').boundingBox()
    if (bounds === null) throw new Error('graph canvas is unavailable')
    const topInset = 64
    await page.screenshot({
      path: `${proofDir}/${name}`,
      animations: 'disabled',
      clip: { x: bounds.x, y: bounds.y + topInset, width: bounds.width, height: bounds.height - topInset },
    })
  }
  const compact = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'other')!
    return { compact: node.layout.preview?.compact, height: node.layout.preview?.height }
  })
  expect(compact).toEqual({ compact: true, height: 24 })
  await screenshotGraph('00-pre-execution-compact.png')

  const widgetPoint = await canvasPoint(page, 'count', 'other')
  await page.mouse.click(widgetPoint.x, widgetPoint.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.node.preview.expose.toggle"]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  const point = await canvasPoint(page, 'preview', 'other')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.node.preview.expose.toggle"]')).toContainText('Promote to App View')
  await screenshotGraph('00-pre-execution-promotion.png')
  await page.locator('[data-item-id="core.node.preview.expose.toggle"]').click()
  await selectView(page, 'App view')
  await expect(page.getByTestId('app-preview-status')).toContainText('Preview appears after execution.')
  await page.screenshot({ path: `${proofDir}/00-pre-execution-app-view.png`, animations: 'disabled' })
})

test('multiline sizing survives preview appearance, zoom, and removal', async ({ page }) => {
  const result = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const snapshot = () => {
      const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'other')!
      const prompt = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'prompt')!
      return { nodeHeight: node.layout.height, promptHeight: prompt.height, compact: node.layout.preview?.compact }
    }
    const before = snapshot()
    const image = document.createElement('canvas')
    image.width = 320
    image.height = 180
    renderer.setNodePreviews({ ...renderer.getNodePreviews(), other: { image, width: 320, height: 180, state: 'cached' } })
    const active = snapshot()
    renderer.setViewport({ x: 0, y: 0, scale: 0.6 })
    const zoomed = snapshot()
    const remaining = { ...renderer.getNodePreviews() }
    delete remaining['other']
    renderer.setNodePreviews(remaining)
    const cleared = snapshot()
    return { before, active, zoomed, cleared }
  })
  expect(result.active.promptHeight).toBe(result.before.promptHeight)
  expect(result.zoomed).toEqual(result.active)
  expect(result.cleared).toEqual(result.before)
  expect(result.active.nodeHeight).toBeGreaterThan(result.before.nodeHeight)
})

test('promoted preview follows input rows, updates live, and keeps authoring tools in arrange mode', async ({ page }) => {
  await exposeInput(page)
  await exposePreview(page)
  expect((await activeDoc(page)).ext?.['dinkster.exposedPreviews']).toEqual([
    { graphId: 'g0', nodeId: 'widgets' },
  ])

  await selectView(page, 'App view')
  const orderedRows = page.locator('[data-testid="app-view-row"], [data-testid="app-preview-row"]')
  await expect(orderedRows).toHaveCount(2)
  await expect(orderedRows.nth(0)).toHaveAttribute('data-testid', 'app-view-row')
  await expect(orderedRows.nth(1)).toHaveAttribute('data-testid', 'app-preview-row')
  await expect(page.getByTestId('app-preview-image')).toBeVisible()
  await expect(page.getByTestId('app-preview-remove')).toHaveCount(0)

  await injectLiveFrame(page, 320, 180, 'Live output preview')
  await expect(page.getByTestId('app-preview-image')).toHaveAttribute('width', '320')
  await expect(page.getByTestId('app-preview-image')).toHaveAttribute('height', '180')
  await page.screenshot({ path: `${proofDir}/01-use-mode-live-preview.png`, animations: 'disabled' })

  await page.locator('.canvas-stage').evaluate((element) => {
    element.style.width = '600px'
  })
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  expect(await page.getByTestId('app-preview-row').evaluate((element) => {
    const mobile = element.closest('[data-testid="app-layout-mobile"]')!.getBoundingClientRect()
    return Math.abs(element.getBoundingClientRect().width - mobile.width) < 1
  })).toBe(true)
  await page.locator('.canvas-stage').evaluate((element) => {
    element.style.width = '900px'
  })
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'desktop')

  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-preview-remove')).toBeVisible()
  await expect(page.getByTestId('app-preview-drag-handle')).toBeVisible()
  await page.getByTestId('app-preview-rename-start').click()
  await page.getByTestId('app-preview-rename').fill('Rendered result')
  await page.getByTestId('app-preview-rename').press('Enter')
  await expect(page.getByTestId('app-preview-label')).toContainText('Rendered result')
  await page.screenshot({ path: `${proofDir}/02-arrange-mode-preview.png`, animations: 'disabled' })
})

test('an uncommitted text draft survives a live preview tick', async ({ page }) => {
  await exposePreview(page)
  await selectView(page, 'App view')
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-layout-add-text').click()
  const editor = page.getByTestId('app-layout-text-input')
  await editor.fill('Draft still being edited')

  expect(await page.evaluate(() => {
    const layout = window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'] as {
      desktop: { items: { kind: string; text?: string }[] }
    }
    return layout.desktop.items.find((item) => item.kind === 'text')?.text
  })).toBe('Add instructions here.')

  await injectLiveFrame(page, 360, 200, 'Updated while typing')
  await expect(page.getByTestId('app-preview-image')).toHaveAttribute('width', '360')
  await expect(editor).toHaveValue('Draft still being edited')
})

test('a promoted preview whose node was deleted stays visible and removable', async ({ page }) => {
  await exposePreview(page)
  await selectView(page, 'App view')
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.remove',
      params: { graphId: 'g0', nodeIds: ['widgets'] },
    })
  })

  await expect(page.getByTestId('app-preview-stale')).toContainText('node no longer exists')
  await page.getByTestId('app-preview-remove').click()
  await expect(page.getByTestId('app-preview-row')).toHaveCount(0)
})

test('a promoted preview retains its resolved output after a disjoint partial run', async ({ page }) => {
  await page.route('**/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: pixel }))
  await exposePreview(page)
  await selectView(page, 'App view')

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].find((candidate) =>
      candidate.ref.prompt === 'app-view-preview-live')!
    app.store.apply({
      kind: 'nodeStates', execution: execution.ref, timestamp: Date.now(),
      nodes: { widgets: { state: 'done' } },
    } as never)
    const digest = `blake3:${'a'.repeat(64)}`
    app.store.apply({
      kind: 'nodeOutput', execution: execution.ref, runtimeNodeId: 'widgets', timestamp: Date.now(),
      output: { image: { typeId: 'dinkster.asset', meta: { digest, mediaType: 'image/png', name: 'result.png' } } },
    } as never)
    app.store.apply({ kind: 'completed', execution: execution.ref, timestamp: Date.now() })
  })
  await expect(page.getByTestId('app-preview-image')).toBeVisible()

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('full comparison compile failed')
    const artifact = compiled.artifact as unknown as { connection: string; prompt: Record<string, unknown> }
    if (artifact.prompt.widgets === undefined || artifact.prompt.other === undefined) {
      throw new Error('full comparison compile did not include both disjoint nodes')
    }
    const ref = { connection: artifact.connection, prompt: 'app-view-preview-partial' }
    const partial = {
      ...compiled.artifact,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: 'other' }] },
      prompt: { other: artifact.prompt.other },
      partialTargets: ['other'],
    }
    app.store.register(ref, partial as never, Date.now() + 100)
    app.store.apply({ kind: 'started', execution: ref, timestamp: Date.now() + 101 })
    app.store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now() + 102,
      nodes: { other: { state: 'running' } },
    } as never)
  })

  // The disjoint proven preview stays visible while the partial run is in flight.
  await expect(page.getByTestId('app-preview-image')).toBeVisible()
  await expect(page.getByTestId('app-preview-stale')).toHaveCount(0)

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const ref = [...app.store.executions.get().values()].find((candidate) =>
      candidate.ref.prompt === 'app-view-preview-partial')!.ref
    app.store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now() + 103,
      nodes: { other: { state: 'done' } },
    } as never)
    app.store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() + 104 })
  })

  await expect(page.getByTestId('app-preview-image')).toBeVisible()
  await expect(page.getByTestId('app-preview-stale')).toHaveCount(0)
})
