import { mkdirSync, writeFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { evidencePath, evidenceGroupDir } from './evidence-output.js'

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

async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

const storedRecipe = (page: Page) => page.evaluate(() =>
  window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.create!.values.compositor)

const latestStatus = (page: Page) => page.evaluate(() =>
  [...window.__dinksterTest!.app.store.executions.get().values()]
    .sort((left, right) => right.queuedAt - left.queuedAt)[0]?.status)

async function queueAndComplete(page: Page): Promise<void> {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const executionCount = await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)
  await page.getByTestId('queue-button').click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size),
    { timeout: 15_000 }).toBeGreaterThan(executionCount)
  await expect.poll(() => latestStatus(page), { timeout: 30_000 }).toBe('completed')
}

test.beforeEach(async ({ page }) => {
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

  let table: {
    readonly schemaVersion?: number
    readonly nodes?: Record<string, {
      readonly schemaVersion?: number
      readonly idempotent?: boolean
      readonly interface?: readonly {
        readonly id?: string
        readonly default?: unknown
        readonly widget?: unknown
      }[]
    }>
  } | undefined
  try {
    const response = await fetch(`${NATIVE_BACKEND}/api/nodes?wire=41`, { signal: AbortSignal.timeout(2_000) })
    if (response.ok) table = await response.json() as typeof table
  } catch { /* handled by the skip below */ }
  test.skip(table?.schemaVersion !== 1, `no wire-41 native Dinkster backend reachable at ${NATIVE_BACKEND}`)
  const nodes = table!.nodes ?? {}
  const required = [
    'dinkster.image.generate',
    'dinkster.layers.add',
    'dinkster.layers.from_bounding_boxes',
    'dinkster.image.create_layered',
  ]
  test.skip(required.some((nodeType) => !(nodeType in nodes)),
    'native backend lacks the image generator and graph-native compositor nodes')
  const createWire = nodes['dinkster.image.create_layered']!
  expect(createWire.schemaVersion).toBe(41)
  expect(createWire.idempotent).toBe(false)
  const compositorInput = createWire.interface?.find((item) => item.id === 'compositor')
  expect(compositorInput?.default).toEqual({ version: 2, documentDigest: null, commands: [] })
  expect(compositorInput?.widget).toEqual({ type: 'COMPOSITOR' })
  expect(nodes['dinkster.layers.from_bounding_boxes']).toBeDefined()

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
    return schemas?.has('dinkster.image.generate') === true &&
      schemas.has('dinkster.layers.add') && schemas.has('dinkster.image.create_layered')
  }), { timeout: 15_000 }).toBe(true)

  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'compositor-editor-native-e2e', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            red: {
              id: 'red', type: 'dinkster.image.generate',
              dynamic: { color_source: { selected: 'hex' }, operation: { selected: 'solid' } },
              values: {
                width: 64, height: 48, batch_size: 1, channels: 'rgb',
                'color_source.color_a': '#ff0000',
              },
            },
            blue: {
              id: 'blue', type: 'dinkster.image.generate',
              dynamic: { color_source: { selected: 'hex' }, operation: { selected: 'solid' } },
              values: {
                width: 16, height: 16, batch_size: 1, channels: 'rgb',
                'color_source.color_a': '#0000ff',
              },
            },
            bottom: {
              id: 'bottom', type: 'dinkster.layers.add',
              values: { name: 'Red base', x: 0, y: 0 },
            },
            top: {
              id: 'top', type: 'dinkster.layers.add',
              values: { name: 'Blue accent', x: 8, y: 4 },
            },
            create: {
              id: 'create', type: 'dinkster.image.create_layered', values: { color_space: 'linear' },
            },
          },
          links: {
            redImage: { id: 'redImage', from: { node: 'red', port: 'image' }, to: { node: 'bottom', port: 'image' } },
            blueImage: { id: 'blueImage', from: { node: 'blue', port: 'image' }, to: { node: 'top', port: 'image' } },
            bottomLayers: { id: 'bottomLayers', from: { node: 'bottom', port: 'layers' }, to: { node: 'top', port: 'layers' } },
            finalLayers: { id: 'finalLayers', from: { node: 'top', port: 'layers' }, to: { node: 'create', port: 'layers' } },
          },
          nets: {}, reroutes: {}, nextOrdinal: 5,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              red: { position: { x: 50, y: 50 } },
              blue: { position: { x: 50, y: 410 } },
              bottom: { position: { x: 400, y: 50 } },
              top: { position: { x: 720, y: 230 } },
              create: { position: { x: 1040, y: 230 } },
            },
          },
        },
      },
    } as never, 'Native Compositor Editor')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.72 })
  })
})

test('edits, executes, persists, and falls back safely when compositor sources change', async ({ page }, testInfo) => {
  const submissions: Array<{
    readonly graph: {
      readonly nodes: Record<string, { readonly nodeType: string; readonly inputs: Record<string, unknown> }>
    }
  }> = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') {
      submissions.push(request.postDataJSON() as typeof submissions[number])
    }
  })

  await queueAndComplete(page)
  expect(submissions[0]?.graph.nodes.red).toEqual({
    nodeType: 'dinkster.image.generate',
    inputs: {
      width: 64,
      height: 48,
      batch_size: 1,
      channels: 'rgb',
      'color_source.color_a': '#ff0000',
    },
    slotVariants: { color_source: 'hex', operation: 'solid' },
  })
  expect(submissions[0]?.graph.nodes.blue).toEqual({
    nodeType: 'dinkster.image.generate',
    inputs: {
      width: 16,
      height: 16,
      batch_size: 1,
      channels: 'rgb',
      'color_source.color_a': '#0000ff',
    },
    slotVariants: { color_source: 'hex', operation: 'solid' },
  })
  expect(submissions[0]?.graph.nodes.create).toEqual({
    nodeType: 'dinkster.image.create_layered',
    inputs: {
      layers: { $link: { node: 'top', output: 'layers' } },
      compositor: { version: 2, documentDigest: null, commands: [] },
      color_space: 'linear',
    },
  })
  expect(await storedRecipe(page)).toBeUndefined()
  await expect.poll(() => page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
      .sort((left, right) => right.queuedAt - left.queuedAt) as unknown as Array<{
        previews?: Record<string, Record<string, unknown>>
      }>
    const preview = executions[0]?.previews
    return Object.values(preview ?? {}).some((streams) => 'compositor-state' in streams)
  })).toBe(true)

  await queueAndComplete(page)
  expect(submissions[1]?.graph.nodes.create).toEqual(submissions[0]?.graph.nodes.create)
  await expect.poll(() => page.evaluate(() => {
    const executions = [...window.__dinksterTest!.app.store.executions.get().values()]
      .sort((left, right) => right.queuedAt - left.queuedAt) as unknown as Array<{
        previews?: Record<string, Record<string, unknown>>
      }>
    const preview = executions[0]?.previews
    return Object.values(preview ?? {}).some((streams) => 'compositor-state' in streams)
  })).toBe(true)

  const row = await nodeRowPoint(page, 'create', 'compositor')
  await page.mouse.click(row.x, row.y)
  const editor = page.getByTestId('compositor-editor')
  const canvas = page.getByTestId('compositor-preview-canvas')
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Red base' })).toBeVisible()
  await expect(editor.getByRole('button', { name: 'Blue accent' })).toBeVisible()
  await expect(canvas.locator('img')).toHaveCount(2)

  const accent = canvas.locator('img').nth(1)
  const accentBox = await accent.boundingBox()
  if (accentBox === null) throw new Error('accent preview is not visible')
  await drag(page,
    { x: accentBox.x + accentBox.width / 2, y: accentBox.y + accentBox.height / 2 },
    { x: accentBox.x + accentBox.width / 2 + 24, y: accentBox.y + accentBox.height / 2 + 12 })
  const draggedX = Number(await editor.getByRole('spinbutton', { name: 'X', exact: true }).inputValue())
  expect(draggedX).toBeGreaterThan(8)

  await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('Accent layer')
  await editor.getByRole('combobox').selectOption('screen')
  await editor.getByRole('spinbutton', { name: 'X', exact: true }).fill('16')
  await editor.getByRole('spinbutton', { name: 'Y', exact: true }).fill('8')
  await editor.getByRole('spinbutton', { name: 'Rotation (degrees)', exact: true }).fill('12.5')
  await editor.getByRole('button', { name: 'Flip horizontal', exact: true }).click()
  await editor.getByRole('button', { name: 'Lower', exact: true }).click()
  await editor.getByRole('button', { name: 'Raise', exact: true }).click()
  await editor.getByLabel('Background', { exact: true }).check()
  await editor.getByLabel('Color', { exact: true }).fill('#102030')
  await editor.getByLabel('Background opacity', { exact: true }).fill('0.25')

  const screenshot = await editor.screenshot({ animations: 'disabled' })
  await testInfo.attach('native-compositor-editor', { body: screenshot, contentType: 'image/png' })
  if (process.env['DINKSTER_CAPTURE_EVIDENCE'] === '1') {
    mkdirSync(evidenceGroupDir('issue-400'), { recursive: true })
    writeFileSync(`evidencePath('issue-400', 'graph-native-compositor.png')`, screenshot)
  }

  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await editor.getByRole('button', { name: 'Apply', exact: true }).click()
  await expect(editor).toHaveCount(0)
  const recipe = await storedRecipe(page) as {
    readonly version: number
    readonly documentDigest: string
    readonly commands: readonly Record<string, unknown>[]
  }
  expect(recipe.version).toBe(2)
  expect(recipe.documentDigest).toMatch(/^blake3:[0-9a-f]{64}$/)
  const reorder = recipe.commands.find((command) => command['op'] === 'reorder') as { readonly ids: readonly string[] }
  expect(reorder.ids).toHaveLength(2)
  expect(recipe.commands).toContainEqual({
    op: 'canvas', changes: { width: 64, height: 48, background: [4112, 8224, 12336, 16_384] },
  })
  expect(recipe.commands).toContainEqual({
    op: 'layer', id: reorder.ids[0],
    changes: { name: 'Red base', visible: true, opacity: 65_535, blendMode: 'normal' },
  })
  expect(recipe.commands).toContainEqual({
    op: 'layer', id: reorder.ids[1],
    changes: { name: 'Accent layer', visible: true, opacity: 65_535, blendMode: 'screen' },
  })
  expect(recipe.commands).toContainEqual({
    op: 'transform', id: reorder.ids[1],
    components: {
      x: 16, y: 8, width: 16, height: 16, rotation: 12.5 * Math.PI / 180,
      flipHorizontal: true, flipVertical: false, sourceWidth: 16, sourceHeight: 16,
    },
  })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)

  await page.keyboard.press('Control+z')
  await expect.poll(() => storedRecipe(page)).toBeUndefined()
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => storedRecipe(page)).toEqual(recipe)

  const reopened = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const exported = app.exportDocument(app.activeTab()!.id)
    if (exported === undefined) throw new Error('compositor document export failed')
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Native Compositor Editor reopened')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 0.72 })
    return app.activeTab()!.store.doc.graphs.g0!.nodes.create!.values.compositor
  })
  expect(reopened).toEqual(recipe)

  await queueAndComplete(page)
  expect(submissions.at(-1)?.graph.nodes.create).toEqual({
    nodeType: 'dinkster.image.create_layered',
    inputs: {
      layers: { $link: { node: 'top', output: 'layers' } },
      compositor: recipe,
      color_space: 'linear',
    },
  })
  await expect.poll(() => page.evaluate(() => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews().create
    return preview ? { width: preview.width, height: preview.height, hasImage: preview.image !== undefined } : undefined
  }), { timeout: 15_000 }).toEqual({ width: 64, height: 48, hasImage: true })

  const pixels = await page.evaluate(() => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews().create
    if (!preview?.image || preview.width === undefined || preview.height === undefined) {
      throw new Error('compositor output preview is unavailable')
    }
    const output = document.createElement('canvas')
    output.width = preview.width
    output.height = preview.height
    const context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(preview.image, 0, 0)
    return {
      base: [...context.getImageData(2, 2, 1, 1).data],
      overlap: [...context.getImageData(20, 12, 1, 1).data],
    }
  })
  expect(pixels.base).toEqual([255, 0, 0, 255])
  expect(pixels.overlap[0]).toBeGreaterThan(245)
  expect(pixels.overlap[1]).toBeLessThan(10)
  expect(pixels.overlap[2]).toBeGreaterThan(245)
  expect(pixels.overlap[3]).toBe(255)

  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      dispatchTo(tab: unknown, action: unknown): { readonly ok: boolean }
    }
    return app.dispatchTo(app.activeTab()!, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'blue', inputId: 'color_source.color_a', value: '#00ff00' },
    }).ok
  })).toBe(true)
  await queueAndComplete(page)
  const staleRow = await nodeRowPoint(page, 'create', 'compositor')
  await page.mouse.click(staleRow.x, staleRow.y)
  await expect(editor).toBeVisible()
  await expect(editor.getByRole('status')).toHaveText(
    'Sources changed. Native placements are shown and the stored recipe was not replayed.')
  await expect(editor.getByRole('button', { name: 'Blue accent' })).toBeVisible()
  expect(await storedRecipe(page)).toEqual(recipe)
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click()

  expect(await page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .map((problem) => `${problem.severity} ${problem.code}: ${problem.message}`))).toEqual([])
  const errors = browserErrors.get(page)
  if (errors === undefined) throw new Error('browser error collector was not installed')
  expect(errors).toEqual({ page: [], console: [], responses: [] })
})
