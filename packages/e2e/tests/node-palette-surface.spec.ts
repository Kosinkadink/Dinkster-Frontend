import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, mockProjectPacks, nativeTest as test, setShellRegion, waitForWorkspaceReady, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_PALETTE_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

const schemas = [
  {
    type: 'PaletteRichPreview',
    displayName: 'Palette schema preview with a deliberately long descriptive title',
    category: 'Image/Loaders',
    description: 'Loads a source image and exposes required, optional, and output interface details without mutating the document.',
    source: 'v3',
    pack: 'palette-proof-pack',
    isOutputNode: false,
    body: [
      { kind: 'input', id: 'model', displayName: 'Model', type: { kind: 'concrete', name: 'MODEL' }, optional: false },
      { kind: 'input', id: 'image', displayName: 'Optional source image', type: { kind: 'concrete', name: 'IMAGE' }, optional: true },
      { kind: 'output', id: 'image', displayName: 'Image', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  {
    type: 'PaletteLatentSampler',
    displayName: 'Palette latent sampler',
    category: 'Latent/Sampling',
    description: 'A deterministic palette fixture with latent and model inputs.',
    source: 'v3',
    pack: 'palette-proof-pack',
    isOutputNode: false,
    body: [
      { kind: 'input', id: 'model', type: { kind: 'concrete', name: 'MODEL' }, optional: false },
      { kind: 'input', id: 'latent', type: { kind: 'concrete', name: 'LATENT' }, optional: false },
      { kind: 'output', id: 'latent', type: { kind: 'concrete', name: 'LATENT' } },
    ],
  },
  {
    type: 'PaletteImageConsumer',
    displayName: 'Palette image consumer',
    category: 'Type filters',
    description: 'Consumes an IMAGE without producing one.',
    source: 'v3',
    pack: 'palette-proof-pack',
    isOutputNode: false,
    body: [
      { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
      { kind: 'output', id: 'latent', type: { kind: 'concrete', name: 'LATENT' } },
    ],
  },
  {
    type: 'PaletteImageProducer',
    displayName: 'Palette image producer',
    category: 'Type filters',
    description: 'Produces an IMAGE without consuming one.',
    source: 'v3',
    pack: 'palette-proof-pack',
    isOutputNode: false,
    body: [
      { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  ...Array.from({ length: 28 }, (_, index) => ({
    type: `PaletteTransform${String(index).padStart(2, '0')}`,
    displayName: `Palette transform ${String(index + 1).padStart(2, '0')} with a long searchable name`,
    category: index % 2 === 0 ? 'Image/Transforms/Color' : 'Image/Transforms/Geometry',
    description: `Deterministic result ${index + 1} exercises long descriptions, keyboard scrolling, and edge containment.`,
    source: 'v3',
    pack: 'palette-proof-pack',
    isOutputNode: false,
    body: [
      { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: index % 3 === 0 },
      { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  })),
]

async function capture(page: Page, name: string): Promise<void> {
  if (proofDir === undefined) return
  await page.screenshot({ path: join(proofDir, `${name}.png`), animations: 'disabled' })
}

async function installPaletteFixture(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated palette proof' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'palette-proof', schemaWire: 2 },
    nodes: {},
  } }))
  await mockProjectPacks(page, ['palette-proof-pack'])
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await waitForWorkspaceReady(page)
  await page.evaluate(async (fixtureSchemas) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas(fixtureSchemas)
    const diagnostics = (await app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'node-palette-surface-proof',
      root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
      view: { graphs: { g0: { nodes: {} } } },
    }, 'Node palette surface proof'))
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
  }, schemas)
}

async function openPalette(page: Page, edge = false): Promise<void> {
  const canvas = page.getByTestId('graph-canvas')
  const box = (await canvas.boundingBox())!
  const point = edge
    ? { x: box.x + Math.max(1, box.width - 12), y: box.y + Math.max(1, box.height - 12) }
    : { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await canvas.dispatchEvent('dblclick', {
    bubbles: true,
    button: 0,
    clientX: point.x,
    clientY: point.y,
  })
  await expect(page.getByTestId('node-palette')).toBeVisible()
}

test.beforeEach(async ({ page }) => installPaletteFixture(page))

test('palette insertion awaits acceptance without stealing newer selection or navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1366, height: 768 })
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const dispatch = app.dispatchTo.bind(app)
    app.dispatchTo = (tab: any, invocation: any) => {
      if (invocation.command !== 'node.add') return dispatch(tab, invocation)
      return new Promise((resolve) => {
        ;(window as any).__completePalette = (accepted: boolean) => resolve(accepted
          ? dispatch(tab, invocation)
          : { ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.rejected', message: 'Palette insertion refused for test' }] })
      })
    }
  })
  const state = () => page.evaluate(() => ({
    nodes: Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes),
    selection: [...window.__dinksterTest!.controller!.getSelection()],
  }))
  const insert = async () => {
    await openPalette(page, true)
    await page.getByTestId('palette-search').fill('Palette image producer')
    await expect(page.locator('canvas.palette-node-preview')).toHaveAttribute('data-preview-ready', 'PaletteImageProducer')
    await capture(page, 'app-node-search-typed')
    await page.getByTestId('palette-search').press('Enter')
    const canvas = page.getByTestId('graph-canvas')
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + 250, box.y + 200)
    await expect(canvas).toHaveAttribute('data-placement-ghost', 'visible')
    await page.mouse.click(box.x + 250, box.y + 200)
    await expect(canvas).not.toHaveAttribute('data-placement-ghost', 'visible')
  }
  await page.screenshot({ path: testInfo.outputPath('palette-default.png') })
  await insert()
  expect(await state()).toEqual({ nodes: [], selection: [] })
  await page.screenshot({ path: testInfo.outputPath('palette-pending.png') })
  await page.evaluate(() => (window as any).__completePalette(false))
  await expect(page.getByTestId('gesture-refusal-toast')).toContainText('Palette insertion refused for test')
  expect(await state()).toEqual({ nodes: [], selection: [] })
  await page.screenshot({ path: testInfo.outputPath('palette-refused.png') })
  await page.getByTestId('gesture-refusal-toast').getByRole('button').click()

  const firstId = await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store as any).predictedNodeId('g0'))
  expect(firstId).toBeTruthy()
  await insert()
  await page.evaluate(() => (window as any).__completePalette(true))
  await expect.poll(state).toEqual({ nodes: [firstId], selection: [firstId] })
  await page.screenshot({ path: testInfo.outputPath('palette-accepted.png') })
  const secondId = await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store as any).predictedNodeId('g0'))
  await insert()
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection([]))
  await page.evaluate(() => (window as any).__completePalette(true))
  await expect.poll(state).toEqual({ nodes: [firstId, secondId], selection: [] })

  await insert()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const original = app.activeTab()!
    app.createWorkflow()
    app.activeTabId.set(original.id)
  })
  await page.evaluate(() => (window as any).__completePalette(false))
  await expect(page.getByTestId('gesture-refusal-toast')).toHaveCount(0)
  expect(await state()).toEqual({ nodes: [firstId, secondId], selection: [] })
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect.poll(state).toEqual({ nodes: [firstId], selection: [] })

  const thirdId = await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store as any).predictedNodeId('g0'))
  await insert()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const original = app.activeTab()!
    app.createWorkflow()
    app.activeTabId.set(original.id)
  })
  await page.evaluate(() => (window as any).__completePalette(true))
  await expect.poll(state).toEqual({ nodes: [firstId, thirdId], selection: [] })
})

test('semantic result ownership, filters, focus, and placement stay mutation free until activation', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  const canvas = page.getByTestId('graph-canvas')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openPalette(page, true)

  const palette = page.getByRole('dialog', { name: 'Add a node', exact: true })
  const input = page.getByTestId('palette-search')
  const listbox = palette.getByRole('listbox', { name: 'Add a node' })
  await expect(input).toBeFocused()
  expect(await listbox.ariaSnapshot()).toContain('group "Node categories"')
  await expect(listbox.locator('[data-key="category:Image"]')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await capture(page, '01-after-zero-query-edge-1600x950')

  await input.fill('Palette schema preview')
  await expect(listbox.locator('[data-key="entry:PaletteRichPreview"]')).toBeVisible()
  await expect(page.getByTestId('search-preview')).toContainText(schemas[0]!.displayName)
  await expect(page.getByTestId('search-preview')).toContainText(schemas[0]!.description)
  await expect(page.locator('canvas.palette-node-preview')).toHaveAttribute('data-preview-ready', 'PaletteRichPreview')
  const activeId = await input.getAttribute('aria-activedescendant')
  expect(activeId).not.toBeNull()
  await expect(page.locator(`#${activeId}`)).toHaveAttribute('role', 'option')
  await capture(page, '02-after-long-schema-preview-1600x950')

  await input.fill('no node can match this query')
  await expect(palette.locator('.dinkster-search-empty')).toContainText('No matching nodes')
  expect(await listbox.ariaSnapshot()).not.toContain('No matching nodes')
  await expect(input).not.toHaveAttribute('aria-activedescendant')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await capture(page, '03-after-no-matches-1600x950')

  await input.fill('')
  const imageCategory = listbox.locator('[data-key="category:Image"]')
  await imageCategory.click()
  await expect(palette.getByRole('button', { name: 'All categories' })).toBeVisible()
  await input.fill('Palette transform')
  const inputFilter = palette.getByRole('button', { name: 'Takes', exact: true })
  await inputFilter.click()
  const filterMenu = palette.getByRole('menu')
  await expect(filterMenu.getByRole('menuitemcheckbox', { name: 'Takes IMAGE', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await capture(page, '04-after-category-type-filter-1600x950')
  await page.keyboard.press('Escape')
  await expect(filterMenu).toHaveCount(0)
  await expect(palette).toBeVisible()
  await expect(inputFilter).toBeFocused()

  await palette.getByRole('button', { name: 'All categories' }).click()
  await input.fill('Palette image')
  await inputFilter.click()
  const takesField = palette.getByRole('textbox', { name: 'Filter input types', exact: true })
  await expect(takesField).toHaveAttribute('placeholder', 'Find a type')
  const takesBox = (await palette.locator('.dinkster-menu-popover').boundingBox())!
  const takesAnchor = (await inputFilter.boundingBox())!
  expect(takesBox.x + takesBox.width).toBeCloseTo(takesAnchor.x + takesAnchor.width, 1)
  await capture(page, 'app-takes-menu')
  await takesField.fill('image')
  await expect(filterMenu.locator('[data-active]')).toHaveAccessibleName('Takes IMAGE')
  await capture(page, 'app-typed-takes')
  await takesField.press('Enter')
  await expect(input).toBeFocused()
  await expect(listbox.locator('[data-key="entry:PaletteImageConsumer"]')).toBeVisible()
  await expect(listbox.locator('[data-key="entry:PaletteImageProducer"]')).toHaveCount(0)
  await palette.getByRole('button', { name: 'Gives', exact: true }).click()
  const givesField = palette.getByRole('textbox', { name: 'Filter output types', exact: true })
  await capture(page, 'app-gives-menu')
  await givesField.fill('latent')
  await expect(filterMenu.locator('[data-active]')).toHaveAccessibleName('Gives LATENT')
  await capture(page, 'app-typed-gives')
  await givesField.press('Enter')
  await expect(input).toBeFocused()
  await expect(palette.locator('.dinkster-search-chip')).toHaveText(['IMAGE', 'LATENT'])
  await expect(listbox.getByRole('option')).toHaveCount(1)
  await capture(page, 'app-menu-picked-requirements')
  await palette.getByRole('button', { name: 'Remove Gives LATENT', exact: true }).click()
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Palette image')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await input.fill('Palette transform')
  await input.focus()

  for (let index = 0; index < 24; index += 1) await input.press('ArrowDown')
  const tailId = await input.getAttribute('aria-activedescendant')
  expect(tailId).not.toBeNull()
  const activeTail = page.locator(`#${tailId}`)
  await expect(activeTail).toContainText('Palette transform 25')
  await expect(activeTail).toBeInViewport()
  const [activeTailBox, groupHeaderBox, resultListboxBox] = await Promise.all([
    activeTail.boundingBox(),
    listbox.locator('.dinkster-search-group-heading').boundingBox(),
    listbox.boundingBox(),
  ])
  expect(activeTailBox).not.toBeNull()
  expect(groupHeaderBox).not.toBeNull()
  expect(resultListboxBox).not.toBeNull()
  expect(activeTailBox!.y).toBeGreaterThanOrEqual(groupHeaderBox!.y + groupHeaderBox!.height)
  expect(activeTailBox!.y + activeTailBox!.height).toBeLessThanOrEqual(resultListboxBox!.y + resultListboxBox!.height)
  await expect(input).toBeFocused()
  await capture(page, '05-after-keyboard-tail-1600x950')

  const paletteBox = (await palette.boundingBox())!
  const canvasBox = (await canvas.boundingBox())!
  expect(paletteBox.x).toBeGreaterThanOrEqual(canvasBox.x)
  expect(paletteBox.y).toBeGreaterThanOrEqual(canvasBox.y)
  expect(paletteBox.x + paletteBox.width).toBeLessThanOrEqual(canvasBox.x + canvasBox.width)
  expect(paletteBox.y + paletteBox.height).toBeLessThanOrEqual(canvasBox.y + canvasBox.height)

  await input.press('Enter')
  await expect(palette).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2)
  await expect(canvas).toHaveAttribute('data-placement-ghost', 'visible')
  await page.keyboard.press('Escape')
  await expect(canvas).not.toHaveAttribute('data-placement-ghost', 'visible')

  await canvas.click({ button: 'right', position: { x: 200, y: 180 } })
  await page.getByRole('menuitem', { name: 'Add node...', exact: true }).click()
  await expect(palette).toBeVisible()
  await expect(input).toBeFocused()
  await palette.getByRole('tab', { name: 'Blueprints', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('node-palette')).toHaveCount(0)
  await expect(canvas).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('result hierarchy, preview, scrolling, and popovers remain contained at desktop and narrow sizes', async ({ page }) => {
  for (const viewport of [
    { name: '06-after-populated-edge-1366x768', width: 1366, height: 768 },
    { name: '07-after-populated-edge-360x640', width: 360, height: 640 },
  ]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })
    if (viewport.width === 360) {
      await setShellRegion(page, 'right', false)
    }
    await openPalette(page, true)
    const palette = page.getByTestId('node-palette')
    const input = page.getByTestId('palette-search')
    await input.fill('Palette transform')
    for (let index = 0; index < 26; index += 1) await input.press('ArrowDown')
    const activeId = await input.getAttribute('aria-activedescendant')
    expect(activeId).not.toBeNull()
    const active = page.locator(`#${activeId}`)
    await expect(active).toBeInViewport()
    const title = active.locator('.dinkster-search-row-title')
    expect(await title.evaluate((element) => {
      const context = document.createElement('canvas').getContext('2d')!
      context.font = getComputedStyle(element).font
      return element.getBoundingClientRect().width - context.measureText('Palette').width
    })).toBeGreaterThanOrEqual(0)
    const activeBox = (await active.boundingBox())!
    const resultBox = (await palette.getByRole('listbox', { name: 'Add a node' }).boundingBox())!
    expect(activeBox.y).toBeGreaterThanOrEqual(resultBox.y)
    expect(activeBox.y + activeBox.height).toBeLessThanOrEqual(resultBox.y + resultBox.height)

    const outputFilter = palette.getByRole('button', { name: 'Gives', exact: true })
    await outputFilter.click()
    const filterMenu = palette.locator('.dinkster-menu-popover')
    await expect(filterMenu).toBeVisible()
    const paletteBox = (await palette.boundingBox())!
    const filterBox = (await filterMenu.boundingBox())!
    expect(filterBox.x).toBeGreaterThanOrEqual(paletteBox.x)
    expect(filterBox.y).toBeGreaterThanOrEqual(paletteBox.y)
    expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(paletteBox.x + paletteBox.width)
    expect(filterBox.y + filterBox.height).toBeLessThanOrEqual(paletteBox.y + paletteBox.height)
    if (viewport.width === 360) {
      await page.setViewportSize({ width: 240, height: viewport.height })
      await expect(filterMenu).toHaveCount(0)
      await outputFilter.click()
      await expect.poll(async () => (await filterMenu.boundingBox())?.x ?? -1).toBeGreaterThanOrEqual(0)
      expect((await filterMenu.boundingBox())!.x + (await filterMenu.boundingBox())!.width).toBeLessThanOrEqual(240)
      await page.setViewportSize({ width: 600, height: viewport.height })
      await expect(filterMenu).toHaveCount(0)
      await outputFilter.click()
      await expect.poll(async () => (await filterMenu.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(filterBox.width)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await expect(filterMenu).toHaveCount(0)
      await outputFilter.click()
      await expect.poll(async () => (await filterMenu.boundingBox())?.width ?? 0).toBe(filterBox.width)
    }
    await page.keyboard.press('Escape')
    await expect(outputFilter).toBeFocused()
    await expect(palette).toBeVisible()

    if (viewport.width === 360) {
      await expect(page.getByTestId('search-preview')).toBeHidden()
      await outputFilter.focus()
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()
      await expect(input).toHaveAttribute('aria-controls', await palette.getByRole('listbox').getAttribute('id') as string)
    }

    const box = (await palette.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width)
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    await capture(page, viewport.name)
    await input.press('Escape')
  }
})

test('a dropped wire keeps compatible results and atomic insertion while its chip can cancel only the constraint', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  const sourceId = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const outcome = await app.dispatchTo(tab, { command: 'node.add', params: {
      graphId: 'g0', type: 'PaletteImageProducer', position: { x: 80, y: 80 }, values: {},
    } })
    if (!outcome.ok) throw new Error(JSON.stringify(outcome.diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return Object.keys(tab.store.doc.graphs.g0!.nodes)[0]!
  })
  await expect.poll(() => page.evaluate((id) => window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === id), sourceId)).toBe(true)
  const dropWire = async () => {
    const start = await page.evaluate((id) => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((node) => node.id === id)!
      const pin = node.layout.pins.find((pin) => pin.direction === 'out' && pin.portId === 'image')!
      const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
      return { x: rect.left + node.x + node.layout.width, y: rect.top + node.y + pin.y }
    }, sourceId)
    const box = (await canvas.boundingBox())!
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + 30, start.y + 30)
    await page.mouse.move(box.x + box.width - 30, box.y + box.height - 30)
    await page.mouse.up()
    await expect(page.getByTestId('node-palette')).toHaveAttribute('data-link-drop', 'in')
  }
  const input = page.getByTestId('palette-search')
  const palette = page.getByTestId('node-palette')
  const nodes = () => page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes))
  await dropWire()
  await input.fill('Palette image')
  await expect(palette.locator('[data-key="entry:PaletteImageConsumer"]')).toBeVisible()
  await expect(palette.locator('[data-key="entry:PaletteImageProducer"]')).toHaveCount(0)
  await expect(palette.getByRole('group', { name: 'Takes IMAGE', exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().ghostLink !== undefined)).toBe(true)
  await capture(page, 'app-wire-compatible')
  await palette.getByRole('button', { name: 'Remove connection constraint' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().ghostLink)).toBeUndefined()
  await expect(palette).not.toHaveAttribute('data-link-drop')
  await expect(input).toHaveValue('Palette image')
  await expect(palette.locator('[data-key="entry:PaletteImageProducer"]')).toBeVisible()
  expect(await nodes()).toEqual([sourceId])
  await input.press('Escape')

  await dropWire()
  await input.fill('Palette image consumer')
  await input.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect.poll(nodes).toHaveLength(2)
  const added = (await nodes()).find((id) => id !== sourceId)!
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.links))).toEqual([
    expect.objectContaining({ from: { node: sourceId, port: 'image' }, to: { node: added, port: 'image' } }),
  ])
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  await expect.poll(nodes).toEqual([sourceId])
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.links))).toEqual([])
})

test('type-menu selections require every input and output type and agree with typed filters', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'PaletteBothDirections', displayName: 'Palette both directions', category: 'Types', source: 'v3', isOutputNode: false,
    body: [
      { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
      { kind: 'input', id: 'model', type: { kind: 'concrete', name: 'MODEL' }, optional: false },
      { kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } },
      { kind: 'output', id: 'latent', type: { kind: 'concrete', name: 'LATENT' } },
    ],
  }]))
  await openPalette(page)
  const palette = page.getByTestId('node-palette')
  const field = page.getByTestId('palette-search')
  await field.fill('Palette')
  const choose = async (direction: string, type: string) => {
    await palette.getByRole('button', { name: direction, exact: true }).click()
    const filter = palette.getByRole('textbox', { name: direction === 'Takes' ? 'Filter input types' : 'Filter output types', exact: true })
    await expect(filter).toBeFocused()
    await expect(filter).toHaveValue('')
    await expect(filter).toHaveAttribute('placeholder', 'Find a type')
    await filter.fill(type.toLowerCase())
    await expect(palette.getByRole('menuitemcheckbox', { name: `${direction} ${type}`, exact: true })).toBeVisible()
    await filter.press('Enter')
    await expect(palette.getByRole('menu')).toHaveCount(0)
    await expect(field).toHaveValue('Palette')
    await expect(field).toBeFocused()
  }
  await choose('Takes', 'IMAGE')
  await choose('Takes', 'MODEL')
  await expect(palette.getByRole('option')).toHaveCount(2)
  await expect(palette.locator('[data-key="entry:PaletteRichPreview"]')).toBeVisible()
  await expect(palette.locator('[data-key="entry:PaletteBothDirections"]')).toBeVisible()
  await choose('Gives', 'IMAGE')
  await choose('Gives', 'LATENT')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByRole('option')).toHaveAttribute('data-key', 'entry:PaletteBothDirections')
  await capture(page, 'app-all-type-filters')
  for (const name of ['Takes IMAGE', 'Takes MODEL', 'Gives IMAGE', 'Gives LATENT']) {
    await palette.getByRole('button', { name: `Remove ${name}`, exact: true }).click()
  }
  await field.fill('Palette in:IMAGE in:MODEL out:IMAGE out:LATENT')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByRole('option')).toHaveAttribute('data-key', 'entry:PaletteBothDirections')
  await field.fill('Palette image consumer in:asset<image>')
  await expect(palette.getByRole('option')).toHaveCount(1)
  await expect(palette.getByRole('option')).toHaveAttribute('data-key', 'entry:PaletteImageConsumer')
  await field.fill('Palette image consumer in:asset<latent>')
  await expect(palette.getByRole('option')).toHaveCount(0)
})

test('a dropped list wire offers either-value inputs, excludes scalar-only inputs and connects in one undo step', async ({ page }) => {
  const sourceId = await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      { type: 'PaletteListProducer', displayName: 'Palette list producer', category: 'Lists', source: 'v3', isOutputNode: false,
        body: [{ kind: 'output', id: 'images', type: { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } } }] },
      { type: 'PaletteEitherConsumer', displayName: 'Palette either consumer', category: 'Lists', source: 'v3', isOutputNode: false,
        body: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, acceptsList: true, optional: false }] },
      { type: 'PaletteWrongListConsumer', displayName: 'Palette wrong list consumer', category: 'Lists', source: 'v3', isOutputNode: false,
        body: [{ kind: 'input', id: 'mask', type: { kind: 'concrete', name: 'MASK' }, acceptsList: true, optional: false }] },
    ])
    const result = await app.dispatchTo(app.activeTab()!, { command: 'node.add', params: {
      graphId: 'g0', type: 'PaletteListProducer', position: { x: 80, y: 80 }, values: {},
    } })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return Object.keys(app.activeTab()!.store.doc.graphs.g0!.nodes)[0]!
  })
  await expect.poll(() => page.evaluate((id) => window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === id), sourceId)).toBe(true)
  const start = await page.evaluate((id) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === id)!
    const pin = node.layout.pins.find((pin) => pin.direction === 'out')!
    const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width, y: rect.top + node.y + pin.y }
  }, sourceId)
  const canvas = (await page.getByTestId('graph-canvas').boundingBox())!
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 30, start.y + 30)
  await page.mouse.move(canvas.x + canvas.width - 30, canvas.y + canvas.height - 30)
  await page.mouse.up()
  const palette = page.getByTestId('node-palette')
  await expect(palette).toHaveAttribute('data-link-drop', 'in')
  await page.getByTestId('palette-search').fill('Palette')
  const either = palette.locator('[data-key="entry:PaletteEitherConsumer"]')
  await expect(either).toBeVisible()
  await expect(palette.locator('[data-key="entry:PaletteImageConsumer"]')).toHaveCount(0)
  await expect(palette.locator('[data-key="entry:PaletteWrongListConsumer"]')).toHaveCount(0)
  await expect(palette.getByRole('group', { name: 'Takes IMAGE list', exact: true })).toHaveText('IMAGE list')
  await expect(palette.locator('.dinkster-search-chip .dinkster-search-chip-dot')).toHaveAttribute('data-shape', 'diamond')
  await capture(page, 'app-list-wire')
  await either.click()
  await expect(palette).toHaveCount(0)
  const graph = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!)
  await expect.poll(async () => Object.keys((await graph()).nodes)).toHaveLength(2)
  const added = Object.keys((await graph()).nodes).find((id) => id !== sourceId)!
  expect(Object.values((await graph()).links)).toEqual([
    expect.objectContaining({ from: { node: sourceId, port: 'images' }, to: { node: added, port: 'image' } }),
  ])
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(Object.keys((await graph()).nodes)).toEqual([sourceId])
  expect(Object.keys((await graph()).links)).toEqual([])
  await openPalette(page)
  await page.getByTestId('palette-search').fill('Palette')
  await palette.getByRole('button', { name: 'Takes', exact: true }).click()
  const listType = palette.getByRole('menuitemcheckbox', { name: 'Takes IMAGE list', exact: true })
  await expect(listType).toBeVisible()
  await expect(palette.getByRole('menuitemcheckbox', { name: 'Takes IMAGE', exact: true }).locator('.dinkster-search-chip-dot')).toHaveAttribute('data-shape', 'circle')
  const filter = palette.getByRole('textbox', { name: 'Filter input types', exact: true })
  await filter.fill('image list')
  await expect(listType.locator('.dinkster-search-chip-dot')).toHaveCSS('width', '13.75px')
  await capture(page, 'app-typed-list-menu')
  await filter.press('Enter')
  await expect(either).toBeVisible()
  await expect(palette.locator('[data-key="entry:PaletteImageConsumer"]')).toHaveCount(0)
  await expect(palette.locator('[data-key="entry:PaletteWrongListConsumer"]')).toHaveCount(0)
})

test('Insert node opens both port constraints and splices a compatible choice in one undo step', async ({ page }) => {
  await page.evaluate(async () => {
    const diagnostics = await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'palette-splice', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        source: { id: 'source', type: 'PaletteImageProducer', values: {} },
        sink: { id: 'sink', type: 'PaletteImageConsumer', values: {} },
      }, links: { original: { id: 'original', from: { node: 'source', port: 'image' }, to: { node: 'sink', port: 'image' } } },
      nets: {}, reroutes: {}, nextOrdinal: 0 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 40, y: 100 } }, sink: { position: { x: 700, y: 100 } },
      } } } },
    }, 'Palette splice')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().links.some((link) => link.id === 'original'))).toBe(true)
  const midpoint = await page.evaluate(() => {
    const link = window.__dinksterTest!.renderer!.getScene().links.find((link) => link.id === 'original')!
    const rect = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return { x: rect.left + (link.x1 + link.x2) / 2, y: rect.top + (link.y1 + link.y2) / 2 }
  })
  await page.mouse.dblclick(midpoint.x, midpoint.y)
  await page.getByTestId('link-double-click-menu').getByRole('button', { name: 'Insert node...' }).click()
  const palette = page.getByTestId('node-palette')
  await expect(palette.getByRole('group', { name: 'Takes IMAGE', exact: true })).toBeVisible()
  await expect(palette.getByRole('group', { name: 'Gives IMAGE', exact: true })).toBeVisible()
  await page.getByTestId('palette-search').fill('Palette image')
  await expect(palette.locator('[data-key="entry:PaletteImageProducer"]')).toHaveCount(0)
  await expect(palette.locator('[data-key="entry:PaletteImageConsumer"]')).toHaveCount(0)
  await page.getByTestId('palette-search').fill('Palette transform 01')
  await expect(palette.getByRole('option').first()).toHaveAttribute('data-key', 'entry:PaletteTransform00')
  await capture(page, 'app-splice-compatible')
  await page.getByTestId('palette-search').press('Enter')
  await expect(palette).toHaveCount(0)
  const graph = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!)
  await expect.poll(async () => Object.keys((await graph()).nodes)).toHaveLength(3)
  const added = Object.keys((await graph()).nodes).find((id) => id !== 'source' && id !== 'sink')!
  expect(Object.values((await graph()).links)).toEqual(expect.arrayContaining([
    expect.objectContaining({ from: { node: 'source', port: 'image' }, to: { node: added, port: 'image' } }),
    expect.objectContaining({ from: { node: added, port: 'image' }, to: { node: 'sink', port: 'image' } }),
  ]))
  expect(Object.keys((await graph()).links)).toHaveLength(2)
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(Object.keys((await graph()).nodes)).toEqual(['source', 'sink'])
  expect(Object.keys((await graph()).links)).toEqual(['original'])
})

test('type menus open into their field without scrolling their host, reveal keyboard choices and dismiss on outside scroll', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'PaletteTypeChoices', displayName: 'Palette type choices', category: 'Types', source: 'v3', isOutputNode: false,
    body: Array.from({ length: 24 }, (_, index) => ({
      kind: 'output' as const, id: `value${index}`, type: { kind: 'concrete' as const, name: `TYPE_${String(index).padStart(2, '0')}` },
    })),
  }]))
  await setShellRegion(page, 'right', false)
  for (const width of [240, 360, 600]) {
    await page.setViewportSize({ width, height: 640 })
    await openPalette(page, true)
    const palette = page.getByTestId('node-palette')
    const search = page.getByTestId('palette-search')
    await search.fill('Palette transform')
    const trigger = palette.getByRole('button', { name: 'Gives', exact: true })
    const menu = palette.locator('.dinkster-menu-popover')
    const filter = palette.getByRole('textbox', { name: 'Filter output types', exact: true })
    const scroll = () => palette.evaluate((element) => {
      const nodes = [element, ...Array.from(element.querySelectorAll('.dinkster-search-panel, .dinkster-search-list'))]
      return nodes.map((node) => [node.scrollLeft, node.scrollTop])
    })
    for (const key of ['ArrowDown', 'ArrowUp']) {
      await trigger.focus()
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const before = await scroll()
      await trigger.press(key)
      const items = menu.getByRole('menuitemcheckbox')
      await expect(filter).toBeFocused()
      await expect(items.first()).toHaveAttribute('data-active', '')
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await expect(menu).toBeVisible()
      await expect(items.first()).toBeInViewport()
      expect(await scroll()).toEqual(before)
      const bounds = (await menu.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(8)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8)
      expect(bounds.y).toBeGreaterThanOrEqual(8)
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(632)
      await capture(page, `app-menu-${width}-${key}`)
      if (width === 600) {
        await filter.fill('TYPE_')
        await filter.press('Home')
        expect(await filter.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(0)
        await filter.press('End')
        expect(await filter.evaluate((element: HTMLInputElement) => element.selectionStart)).toBe(5)
        await filter.press('ArrowUp')
        await expect(items.last()).toHaveAttribute('data-active', '')
        await expect(items.last()).toBeInViewport({ ratio: 1 })
        expect(await menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
        await filter.press('ArrowUp')
        await expect(items.nth(await items.count() - 2)).toHaveAttribute('data-active', '')
        await expect(filter).toBeFocused()
      }
      await page.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await expect(trigger).toBeFocused()
    }
    await trigger.press('ArrowDown')
    await expect(menu).toBeVisible()
    await palette.getByRole('listbox').evaluate((element) => { element.scrollTop += 40 })
    await expect(menu).toHaveCount(0)
    await search.press('Escape')
    await expect(palette).toHaveCount(0)
  }
})
