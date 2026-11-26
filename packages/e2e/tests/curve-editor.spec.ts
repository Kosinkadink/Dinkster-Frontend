import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '../visual.js'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'
import { subgraphMarkPoint, unfoldNodeEditor, waitForWorkspaceReady } from './fixtures.js'
import { requireBackendNodes } from './required-nodes.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

interface Point {
  readonly x: number
  readonly y: number
}

interface BrowserErrors {
  readonly page: string[]
  readonly console: string[]
  readonly responses: string[]
}

const browserErrors = new WeakMap<Page, BrowserErrors>()

async function headerPoint(page: Page, nodeId: string): Promise<Point> {
  return page.evaluate((nodeId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) throw new Error(`missing scene node '${nodeId}'`)
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  }, nodeId)
}

async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y)
  await page.evaluate(() => new Promise(requestAnimationFrame))
  await page.mouse.up()
}

const storedCurve = (page: Page) => page.evaluate(() =>
  window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.editor!.values.curve)

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1' || process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_E2E_USE_NATIVE=1 and DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')

  const errors: BrowserErrors = { page: [], console: [], responses: [] }
  browserErrors.set(page, errors)
  page.on('pageerror', (error) => errors.page.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.console.push(`${message.text()} @ ${message.location().url}`)
  })
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.responses.push(`${response.request().method()} ${response.status()} ${response.url()}`)
    }
  })

  let table: { readonly schemaVersion?: number; readonly nodes?: Record<string, unknown> } | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) table = await response.json() as typeof table
  } catch { /* handled by the skip below */ }
  test.skip(table?.schemaVersion !== 1, `no current native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  const nodes = table!.nodes ?? {}
  requireBackendNodes(nodes, ['dinkster.utilities.curve_editor', 'dinkster.image.image_add_noise', 'dinkster.image.image_histogram'], testInfo)


  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1,
    state: 'ready',
    detail: 'Engine healthy',
    progress: { done: 8, total: 8, phase: 'Engine healthy' },
  } }))
  // The direct engine has no supervisor cache; seed it from the live catalog.
  await page.route('/api/nodes/provisional*', (route) => route.fulfill({ json: table }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const schemas = window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas
    return schemas?.has('dinkster.utilities.curve_editor') === true && schemas.has('dinkster.image.image_histogram')
  }), { timeout: 15_000 }).toBe(true)
  await waitForWorkspaceReady(page)

  await page.evaluate(async () => {
    const diagnostics = await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'curve-editor-native-e2e', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            editor: { id: 'editor', type: 'dinkster.utilities.curve_editor', values: {} },
            image: {
              id: 'image', type: 'dinkster.image.empty_image',
              values: { width: 128, height: 128, batch_size: 1, color: 0x808080 },
            },
            // Noise spreads the grey image's histogram into a bell over many bins.
            noise: { id: 'noise', type: 'dinkster.image.image_add_noise', values: { strength: 0.15, seed: 7 } },
            histogram: { id: 'histogram', type: 'dinkster.image.image_histogram', values: {} },
          },
          links: {
            imageWire: { id: 'imageWire', from: { node: 'image', port: 'IMAGE' }, to: { node: 'noise', port: 'image' } },
            noiseWire: { id: 'noiseWire', from: { node: 'noise', port: 'IMAGE' }, to: { node: 'histogram', port: 'image' } },
            histogramWire: { id: 'histogramWire', from: { node: 'histogram', port: 'rgb' }, to: { node: 'editor', port: 'histogram' } },
          },
          nets: {}, reroutes: {}, nextOrdinal: 2,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              editor: { position: { x: 80, y: 110 } },
              image: { position: { x: -900, y: 110 } },
              noise: { position: { x: -700, y: 110 } },
              histogram: { position: { x: -400, y: 110 } },
            },
          },
        },
      },
    } as never, 'Native Curve Editor')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'curve-editor-native-e2e'
  })).toBe(true)
})

// A point of the curve's plot, as a fraction of its width from the left and of its height from the bottom.
async function plotPoint(editor: Locator, position: number, value: number): Promise<Point> {
  const box = await editor.locator('.dinkster-canvas-curve-plot').boundingBox()
  if (box === null) throw new Error('curve plot is not visible')
  return { x: box.x + box.width * position, y: box.y + box.height * (1 - value) }
}

const points = (editor: Locator) => editor.locator('circle.dinkster-canvas-curve-point')

test('hides the histogram input and its wire in one undo step and keeps the override after reload', async ({ page }, testInfo) => {
  const editor = await unfoldNodeEditor(page, 'editor', 'curve')
  const openMenu = async () => {
    const point = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((node) => node.id === 'editor')!
      const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'curve')!
      const viewport = renderer.getViewport()
      const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return { x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
        y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y }
    })
    await page.mouse.click(point.x, point.y, { button: 'right' })
  }
  const hasWire = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.links.histogramWire !== undefined)
  await expect(editor.getByText('Histogram', { exact: true })).toBeVisible()
  const height = (await editor.boundingBox())!.height
  await openMenu()
  await expect(page.getByRole('menuitem', { name: 'Hide histogram input', exact: true })).toBeVisible()
  const rowMenu = await page.getByRole('menuitem').allTextContents()
  await page.keyboard.press('Escape')
  const plot = editor.locator('svg.dinkster-canvas-curve')
  await plot.click({ position: { x: 80, y: 25 } })
  await page.mouse.click(30, 300)
  await plot.click({ position: { x: 80, y: 25 } })
  await page.mouse.move(30, 300)
  await expect(plot).toHaveCSS('outline-style', 'none')
  await expect(page.locator('.app-tooltip')).toHaveCount(0)
  await plot.click({ button: 'right', position: { x: 80, y: 25 } })
  await expect(page.getByRole('menuitem')).toHaveText(rowMenu)
  const menuScreenshot = await page.screenshot({ animations: 'disabled' })
  await testInfo.attach('native-histogram-visibility-menu', { body: menuScreenshot, contentType: 'image/png' })
  await page.getByRole('menuitem', { name: 'Hide histogram input', exact: true }).click()
  await expect(editor.getByText('Histogram', { exact: true })).toHaveCount(0)
  expect(await hasWire()).toBe(false)
  expect(height - (await editor.boundingBox())!.height).toBe(26)
  const hiddenScreenshot = await page.screenshot({ animations: 'disabled' })
  await testInfo.attach('native-histogram-visibility-hidden', { body: hiddenScreenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-1268'), { recursive: true })
    writeFileSync(evidencePath('issue-1268', 'native-histogram-visibility-menu.png'), menuScreenshot)
    writeFileSync(evidencePath('issue-1268', 'native-histogram-visibility-hidden.png'), hiddenScreenshot)
  }
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect(editor.getByText('Histogram', { exact: true })).toBeVisible()
  expect(await hasWire()).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)!
    await app.openDocument(JSON.parse(JSON.stringify(exported)), 'Reopened histogram visibility')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect(editor).toBeVisible()
  await expect(editor.getByText('Histogram', { exact: true })).toHaveCount(0)
  await openMenu()
  await page.getByRole('menuitem', { name: 'Show histogram input', exact: true }).click()
  await expect(editor.getByText('Histogram', { exact: true })).toBeVisible()
  expect(await hasWire()).toBe(false)
  expect(browserErrors.get(page)).toEqual({ page: [], console: [], responses: [] })
})

for (const delivery of ['net', 'boundary', 'parent-boundary'] as const) {
  test(`hides a drilled histogram fed by ${delivery} and restores it in one undo`, async ({ page }, testInfo) => {
    await page.evaluate(async (delivery) => {
      const app = window.__dinksterTest!.app
      const original = app.activeTab()!.store.doc
      const graph = original.graphs.g0!
      const { histogramWire, ...links } = graph.links
      const document = {
        ...original, root: 'outer', graphs: {
          g0: {
            ...graph, links,
            nets: delivery === 'net' ? { feed: { id: 'feed', name: 'Histogram', source: histogramWire!.from, sinks: [histogramWire!.to] } } : {},
            ...(delivery === 'net' ? {} : { boundary: { body: [{ kind: 'input', id: 'feed', binds: { kind: 'port', node: 'editor', port: 'histogram' } }] } }),
          },
          outer: {
            id: 'outer', name: 'Outer', nextOrdinal: 1, nets: {}, reroutes: {},
            nodes: { first: { id: 'first', type: '#g0', values: {} }, second: { id: 'second', type: '#g0', values: {} }, parentHistogram: { id: 'parentHistogram', type: 'dinkster.image.image_histogram', values: {} } },
            links: delivery === 'parent-boundary' ? {
              firstWire: { id: 'firstWire', from: { node: 'parentHistogram', port: 'rgb' }, to: { node: 'first', port: 'feed' } },
              secondWire: { id: 'secondWire', from: { node: 'parentHistogram', port: 'rgb' }, to: { node: 'second', port: 'feed' } },
            } : {},
          },
        }, view: { ...original.view, graphs: { ...original.view.graphs, outer: { nodes: { first: { position: { x: 80, y: 110 } }, second: { position: { x: 500, y: 110 } } } } } },
      }
      const diagnostics = await app.openDocument(document as never, `Drilled histogram ${delivery}`)
      if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    }, delivery)
    const mark = await subgraphMarkPoint(page, 'first')
    await page.mouse.dblclick(mark.x, mark.y)
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.graphStack.get().length)).toBe(2)
    await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
    const editor = await unfoldNodeEditor(page, 'editor', 'curve')
    const before = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
    await expect(editor.getByText('Histogram', { exact: true })).toBeVisible()
    const height = (await editor.boundingBox())!.height
    const point = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((node) => node.id === 'editor')!
      const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'curve')!
      const viewport = renderer.getViewport()
      const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return { x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
        y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y }
    })
    await page.mouse.click(point.x, point.y, { button: 'right' })
    const hide = page.getByRole('menuitem', { name: 'Hide histogram input', exact: true })
    await expect(hide).toBeEnabled()
    await hide.click()
    await expect(editor.getByText('Histogram', { exact: true })).toHaveCount(0)
    expect(height - (await editor.boundingBox())!.height).toBe(26)
    expect(await page.evaluate(() => {
      const node = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'editor')!
      return node.layout.pins.some((pin) => pin.portId === 'histogram')
    })).toBe(false)
    const capture = await page.screenshot({ animations: 'disabled' })
    await testInfo.attach(`native-drilled-${delivery}-hidden`, { body: capture, contentType: 'image/png' })
    if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
      mkdirSync(evidenceGroupDir('issue-1268'), { recursive: true })
      writeFileSync(evidencePath('issue-1268', `native-drilled-${delivery}-hidden.png`), capture)
    }
    const after = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
    expect(JSON.parse(after).graphs).toEqual(JSON.parse(before).graphs)
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
    expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(before)
    await expect(editor.getByText('Histogram', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
    await expect(editor.getByText('Histogram', { exact: true })).toHaveCount(0)
    expect(browserErrors.get(page)).toEqual({ page: [], console: [], responses: [] })
  })
}

test('renders finite curve geometry across extreme float values', async ({ page }, testInfo) => {
  const extremeCurve = {
    interpolation: 'monotone_cubic',
    points: [
      { position: 0, value: -Number.MAX_VALUE },
      { position: 0.33, value: 0 },
      { position: 0.33 + Number.EPSILON, value: Number.MIN_VALUE },
      { position: 1, value: Number.MAX_VALUE },
    ],
  } as const
  expect(await page.evaluate(async (value) => {
    const app = window.__dinksterTest!.app
    return (await app.dispatchTo(app.activeTab()!, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'editor', inputId: 'curve', value },
    })).ok
  }, extremeCurve)).toBe(true)

  const editor = await unfoldNodeEditor(page, 'editor', 'curve')
  const lines = await editor.locator('.dinkster-canvas-curve-line').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('points') ?? ''))
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) expect(line).not.toMatch(/NaN|Infinity/)
  await expect(points(editor)).toHaveCount(4)
  const screenshot = await editor.screenshot({ animations: 'disabled' })
  await testInfo.attach('native-curve-editor-extreme-floats', { body: screenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-680'), { recursive: true })
    writeFileSync(evidencePath('issue-680', 'native-curve-editor-extreme-floats.png'), screenshot)
  }

  const errors = browserErrors.get(page)
  if (errors === undefined) throw new Error('browser error collector was not installed')
  expect(errors).toEqual({ page: [], console: [], responses: [] })
})

test('edits in the node, undoes, reloads, runs and draws the wired histogram of the run', async ({ page }, testInfo) => {
  const editor = await unfoldNodeEditor(page, 'editor', 'curve')
  await expect(editor.getByRole('button', { name: /^Interpolation/ })).toContainText('Monotone cubic')
  await expect(points(editor)).toHaveCount(2)
  await expect(editor.getByText('Histogram', { exact: true })).toBeVisible()
  await expect(editor.locator('.dinkster-canvas-curve-histogram')).toHaveCount(0)
  expect(await storedCurve(page)).toBeUndefined()
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  // Each change below is written at once as its own step.
  await editor.getByRole('button', { name: /^Interpolation/ }).click()
  await page.getByRole('listbox', { name: 'Interpolation options' }).getByRole('option', { name: 'Linear' }).click()
  await expect.poll(() => storedCurve(page)).toEqual({
    interpolation: 'linear', points: [{ position: 0, value: 0 }, { position: 1, value: 1 }],
  })

  const added = await plotPoint(editor, 0.5, 0.75)
  await page.mouse.dblclick(added.x, added.y)
  await expect(points(editor)).toHaveCount(3)
  await drag(page, added, await plotPoint(editor, 0.62, 0.78))
  await expect.poll(async () => ((await storedCurve(page)) as { points: unknown[] } | undefined)?.points[1])
    .toEqual({ position: expect.closeTo(0.62, 2), value: expect.closeTo(0.78, 2) })
  const moved = ((await storedCurve(page)) as { points: { position: number; value: number }[] }).points[1]!

  const extra = await plotPoint(editor, 0.25, 0.35)
  await page.mouse.dblclick(extra.x, extra.y)
  await expect(points(editor)).toHaveCount(4)
  await expect(editor.locator('circle.dinkster-canvas-curve-point[data-selected="true"]')).toHaveCount(1)
  await editor.getByRole('button', { name: 'Delete point' }).click()
  await expect(points(editor)).toHaveCount(3)
  const expectedCurve = {
    interpolation: 'linear',
    points: [{ position: 0, value: 0 }, moved, { position: 1, value: 1 }],
  }
  expect(await storedCurve(page)).toEqual(expectedCurve)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 5)

  const steps = (direction: 'undo' | 'redo') => page.evaluate((direction) => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    for (let step = 0; step < 5; step++) if (!store[direction]()) return false
    return true
  }, direction)
  expect(await steps('undo')).toBe(true)
  await expect.poll(() => storedCurve(page)).toBeUndefined()
  expect(await steps('redo')).toBe(true)
  await expect.poll(() => storedCurve(page)).toEqual(expectedCurve)

  const reopened = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)
    if (exported === undefined) throw new Error('curve document export failed')
    await app.openDocument(JSON.parse(JSON.stringify(exported)), 'Native Curve Editor reopened')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return app.activeTab()!.store.doc.graphs.g0!.nodes.editor!.values.curve
  })
  expect(reopened).toEqual(expectedCurve)
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'curve-editor-native-e2e'
  })).toBe(true)
  // The fold is kept with the document, so the reopened editor is already out.
  const shown = page.locator('.node-editor-space-overlay[data-node-id="editor"][data-value-key="curve"]')
  await expect(shown).toBeVisible()
  await expect(points(shown)).toHaveCount(3)

  let submitted: {
    readonly graph: {
      readonly nodes: Record<string, { readonly nodeType: string; readonly inputs: Record<string, unknown> }>
    }
  } | undefined
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
      submitted = request.postDataJSON() as typeof submitted
    }
  })
  const before = await page.evaluate(() =>
    [...window.__dinksterTest!.app.store.executions.get().values()].map((execution) => execution.ref.prompt))
  const editorHeader = await headerPoint(page, 'editor')
  await page.mouse.click(editorHeader.x, editorHeader.y, { button: 'right' })
  await page.getByTestId('context-menu-item').filter({ hasText: 'Execute up to selection' }).click()
  const newPrompt = (existing: readonly unknown[]) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => !existing.includes(execution.ref.prompt))?.ref.prompt
  await expect.poll(() => page.evaluate(newPrompt, before), { timeout: 10_000 }).not.toBe(undefined)
  const prompt = (await page.evaluate(newPrompt, before))!
  await expect.poll(() => page.evaluate((target) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => execution.ref.prompt === target)?.status, prompt),
  { timeout: 30_000 }).toBe('completed')
  expect(submitted?.graph.nodes.editor?.nodeType).toBe('dinkster.utilities.curve_editor')
  expect(submitted?.graph.nodes.editor?.inputs['curve']).toEqual(expectedCurve)
  await expect.poll(() => page.evaluate((target) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === target) as unknown as {
      previews?: Record<string, Record<string, { payload?: { histogram?: unknown[] } }>>
    }
    return execution?.previews?.editor?.['curve-histogram:curve']?.payload?.histogram?.length
  }, prompt)).toBe(256)

  await expect(shown).toContainText('Histogram')
  await expect.poll(() => shown.locator('.dinkster-canvas-curve-histogram').count()).toBeGreaterThan(0)
  const screenshot = await shown.screenshot({ animations: 'disabled' })
  await testInfo.attach('native-curve-editor-histogram', { body: screenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-680'), { recursive: true })
    writeFileSync(evidencePath('issue-680', 'native-curve-editor-histogram.png'), screenshot)
  }

  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.severity === 'error' && /curve|histogram|empty_image|add_noise/.test(problem.message))
    .map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  const errors = browserErrors.get(page)
  if (errors === undefined) throw new Error('browser error collector was not installed')
  expect(errors).toEqual({ page: [], console: [], responses: [] })
})
