import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'
const histogramShape = Array.from({ length: 256 }, (_value, index) =>
  index < 128 ? index + 1 : 256 - index)

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
const testHistograms = new WeakMap<Page, readonly number[]>()

async function nodeRowPoint(page: Page, nodeId: string, inputId: string): Promise<Point> {
  return page.evaluate(({ nodeId, inputId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) throw new Error(`missing scene node '${nodeId}'`)
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.inputId === inputId)
    if (row === undefined) throw new Error(`missing widget row '${nodeId}/${inputId}'`)
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, inputId })
}

async function pinPoint(page: Page, nodeId: string, direction: 'in' | 'out', portId: string): Promise<Point> {
  return page.evaluate(({ nodeId, direction, portId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (node === undefined) throw new Error(`missing scene node '${nodeId}'`)
    const pin = node.layout.pins.find((candidate) =>
      candidate.direction === direction && candidate.address.port === portId)
    if (pin === undefined) throw new Error(`missing ${direction} pin '${nodeId}/${portId}'`)
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + (direction === 'out' ? node.layout.width : 0)) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + pin.y) * viewport.scale + viewport.y,
    }
  }, { nodeId, direction, portId })
}

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

test.beforeEach(async ({ page }) => {
  test.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1' || process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_E2E_USE_NATIVE=1 and DINKSTER_NATIVE_BACKEND to an isolated Dinkster backend')

  const errors: BrowserErrors = { page: [], console: [], responses: [] }
  browserErrors.set(page, errors)
  const nonce = randomBytes(32)
  const histogram = histogramShape.map((count, index) => count + (nonce[index % nonce.length]! & 1))
  testHistograms.set(page, histogram)
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
  test.skip(!('dinkster.curve.editor' in nodes && 'dinkster.curve.evaluate' in nodes),
    'native backend lacks the Curve Editor and Evaluate Curve nodes')

  const editorWire = nodes['dinkster.curve.editor'] as {
    readonly schemaVersion?: number
    readonly interface?: readonly { readonly id?: string; readonly widget?: unknown }[]
  }
  expect(editorWire.schemaVersion).toBe(1)
  expect(editorWire.interface?.find((item) => item.id === 'curve')?.widget).toEqual({ type: 'CURVE' })

  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ json: {
    protocol: 1,
    state: 'ready',
    detail: 'Engine healthy',
    progress: { done: 8, total: 8, phase: 'Engine healthy' },
  } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => {
    const schemas = window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas
    return schemas?.has('dinkster.curve.editor') === true && schemas.has('dinkster.curve.evaluate')
  }), { timeout: 15_000 }).toBe(true)

  await page.evaluate(({ histogram }) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'curve-editor-native-e2e', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            editor: {
              id: 'editor', type: 'dinkster.curve.editor',
              values: { histogram },
            },
            evaluate: {
              id: 'evaluate', type: 'dinkster.curve.evaluate', values: { position: 0.3 },
            },
            linked: {
              id: 'linked', type: 'dinkster.curve.editor', values: {},
            },
          },
          links: {
            evaluateCurve: {
              id: 'evaluateCurve',
              from: { node: 'editor', port: 'curve' },
              to: { node: 'evaluate', port: 'curve' },
            },
          },
          nets: {}, reroutes: {}, nextOrdinal: 2,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              editor: { position: { x: 80, y: 110 } },
              evaluate: { position: { x: 590, y: 110 } },
              linked: { position: { x: 590, y: 390 } },
            },
          },
        },
      },
    } as never, 'Native Curve Editor')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, { histogram })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'curve-editor-native-e2e'
  })).toBe(true)
})

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
  expect(await page.evaluate((value) => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      dispatchTo(tab: unknown, action: unknown): { readonly ok: boolean }
    }
    return app.dispatchTo(app.activeTab()!, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'editor', inputId: 'curve', value },
    }).ok
  }, extremeCurve)).toBe(true)

  const curveRow = await nodeRowPoint(page, 'editor', 'curve')
  await page.mouse.click(curveRow.x, curveRow.y)
  const editor = page.getByTestId('curve-editor')
  await expect(editor).toBeVisible()
  const path = await editor.locator('.curve-line').getAttribute('d')
  expect(path).toBeTruthy()
  expect(path).not.toMatch(/NaN|Infinity/)
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

test('edits, executes, reloads, previews a histogram, and refuses a linked curve', async ({ page }, testInfo) => {
  const histogram = testHistograms.get(page)
  if (histogram === undefined) throw new Error('curve histogram fixture was not installed')
  const curveRow = await nodeRowPoint(page, 'editor', 'curve')
  await page.mouse.click(curveRow.x, curveRow.y)
  const editor = page.getByTestId('curve-editor')
  const surface = page.getByTestId('curve-surface')
  await expect(editor).toBeVisible()
  await expect(page.getByLabel('Interpolation')).toHaveValue('monotone_cubic')
  expect(await storedCurve(page)).toBeUndefined()
  expect(await page.evaluate(() => {
    const target = (window.__dinksterTest!.app as unknown as {
      curveEditorTarget: { get(): { openedSchemaDefault?: unknown } | undefined }
    }).curveEditorTarget.get()
    return target?.openedSchemaDefault
  })).toEqual({
    interpolation: 'monotone_cubic',
    points: [{ position: 0, value: 0 }, { position: 1, value: 1 }],
  })

  const malformed = { points: [{ position: 1, value: 0 }, { position: 1, value: 2 }] }
  expect(await page.evaluate((value) => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      dispatchTo(tab: unknown, action: unknown): { readonly ok: boolean }
    }
    return app.dispatchTo(app.activeTab()!, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'editor', inputId: 'curve', value },
    }).ok
  }, malformed)).toBe(true)
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('alert')).toHaveText('The curve input changed or became linked while editing')
  expect(await storedCurve(page)).toEqual(malformed)
  await page.getByRole('button', { name: 'Cancel' }).click()
  await page.keyboard.press('Control+z')
  await expect.poll(() => storedCurve(page)).toBeUndefined()
  await page.mouse.click(curveRow.x, curveRow.y)
  await expect(editor).toBeVisible()
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  await page.getByLabel('Interpolation').selectOption('linear')

  const box = await surface.boundingBox()
  if (box === null) throw new Error('curve surface is not visible')
  await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.25)
  await expect(surface.locator('circle')).toHaveCount(3)
  const middle = surface.getByLabel('Curve point 2')
  const middleBox = await middle.boundingBox()
  if (middleBox === null) throw new Error('curve midpoint is not visible')
  const dragTarget = { x: box.x + box.width * 0.62, y: box.y + box.height * 0.22 }
  await drag(
    page,
    { x: middleBox.x + middleBox.width / 2, y: middleBox.y + middleBox.height / 2 },
    dragTarget,
  )
  const movedHandle = await middle.evaluate((element) => ({
    x: Number(element.getAttribute('cx')),
    y: Number(element.getAttribute('cy')),
  }))
  expect(movedHandle.x).toBeCloseTo(620, 3)
  expect(movedHandle.y).toBeCloseTo(132, 3)
  const moved = {
    position: (movedHandle.x - 18) / 964,
    value: 1 - (movedHandle.y - 18) / 564,
  }
  expect(moved.position).toBeCloseTo((620 - 18) / 964, 6)
  expect(moved.value).toBeCloseTo(1 - (132 - 18) / 564, 6)

  await page.mouse.dblclick(box.x + box.width * 0.25, box.y + box.height * 0.65)
  await expect(surface.locator('circle')).toHaveCount(4)
  await page.getByRole('button', { name: 'Delete point' }).click()
  await expect(surface.locator('circle')).toHaveCount(3)
  const expectedCurve = {
    interpolation: 'linear',
    points: [{ position: 0, value: 0 }, moved, { position: 1, value: 1 }],
  }
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(editor).toHaveCount(0)
  expect(await storedCurve(page)).toEqual(expectedCurve)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)

  await page.keyboard.press('Control+z')
  await expect.poll(() => storedCurve(page)).toBeUndefined()
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => storedCurve(page)).toEqual(expectedCurve)

  const reopened = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)
    if (exported === undefined) throw new Error('curve document export failed')
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Native Curve Editor reopened')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return app.activeTab()!.store.doc.graphs.g0!.nodes.editor!.values.curve
  })
  expect(reopened).toEqual(expectedCurve)
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'curve-editor-native-e2e'
  })).toBe(true)

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
  const evaluateHeader = await headerPoint(page, 'evaluate')
  await page.mouse.click(evaluateHeader.x, evaluateHeader.y, { button: 'right' })
  await page.getByTestId('context-menu-item').filter({ hasText: 'Execute up to Selection' }).click()
  const newPrompt = (existing: readonly unknown[]) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => !existing.includes(execution.ref.prompt))?.ref.prompt
  await expect.poll(() => page.evaluate(newPrompt, before), { timeout: 10_000 }).not.toBe(undefined)
  const prompt = (await page.evaluate(newPrompt, before))!
  await expect.poll(() => page.evaluate((target) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => execution.ref.prompt === target)?.status, prompt),
  { timeout: 30_000 }).toBe('completed')
  expect(submitted?.graph.nodes.editor).toEqual({
    nodeType: 'dinkster.curve.editor',
    inputs: { curve: expectedCurve, histogram },
  })
  expect(submitted?.graph.nodes.evaluate?.nodeType).toBe('dinkster.curve.evaluate')

  const expectedValue = moved.value * 0.3 / moved.position
  await expect.poll(() => page.evaluate((target) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === target) as unknown as {
      nodes?: Record<string, { outputs?: Record<string, { value?: number }> }>
    }
    return execution?.nodes?.evaluate?.outputs?.value?.value
  }, prompt)).toBeCloseTo(expectedValue, 12)
  await expect.poll(() => page.evaluate((target) => {
    const execution = [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((candidate) => candidate.ref.prompt === target) as unknown as {
      previews?: Record<string, Record<string, { payload?: unknown }>>
    }
    return execution?.previews?.editor?.['curve-histogram']?.payload
  }, prompt)).toEqual({ histogram })

  const editorRow = await nodeRowPoint(page, 'editor', 'curve')
  await page.mouse.click(editorRow.x, editorRow.y)
  await expect(editor).toBeVisible()
  await expect(page.getByTestId('curve-histogram-status')).toHaveText('Histogram from the selected run')
  await expect(page.getByTestId('curve-histogram')).toHaveAttribute('d', /V/)
  await surface.getByLabel('Curve point 2').click()
  await expect(page.getByTestId('curve-point-value')).toContainText('Position')
  const screenshot = await editor.screenshot({ animations: 'disabled' })
  await testInfo.attach('native-curve-editor-histogram', { body: screenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-680'), { recursive: true })
    writeFileSync(evidencePath('issue-680', 'native-curve-editor-histogram.png'), screenshot)
  }
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(editor).toHaveCount(0)

  await drag(
    page,
    await pinPoint(page, 'editor', 'out', 'curve'),
    await pinPoint(page, 'linked', 'in', 'curve'),
  )
  await expect.poll(() => page.evaluate(() => Object.values(
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.links,
  ).map((link) => ({ from: link.from, to: link.to })))).toContainEqual({
    from: { node: 'editor', tap: 'curve' },
    to: { node: 'linked', port: 'curve' },
  })
  const linkedRow = await nodeRowPoint(page, 'linked', 'curve')
  await page.mouse.click(linkedRow.x, linkedRow.y)
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      curveTargetForInput(tab: unknown, graphId: string, nodeId: string, inputId: string): unknown
    }
    const tab = app.activeTab()!
    return app.curveTargetForInput(tab, 'g0', 'linked', 'curve')
  })).toBeUndefined()

  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.severity === 'error')
    .map((problem) => `${problem.code}: ${problem.message}`))).toEqual([])
  const errors = browserErrors.get(page)
  if (errors === undefined) throw new Error('browser error collector was not installed')
  expect(errors).toEqual({ page: [], console: [], responses: [] })
})
