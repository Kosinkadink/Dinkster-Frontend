import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { evidencePath } from './evidence-output.js'

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
    items: [
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
    items: [
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
    items: [
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
    items: [
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
    items: [
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
    dinkster: { version: 'palette-proof', schemaWire: 1 },
    nodes: {},
  } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await page.evaluate((fixtureSchemas) => {
    const app = window.__dinksterTest!.app
    app.registerSchemas(fixtureSchemas)
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'node-palette-surface-proof',
      root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
      view: { graphs: { g0: { nodes: {} } } },
    }, 'Node palette surface proof')
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

test('semantic result ownership, filters, focus, and placement stay mutation free until activation', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  const canvas = page.getByTestId('graph-canvas')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await openPalette(page, true)

  const palette = page.getByRole('dialog', { name: 'Add a node', exact: true })
  const input = page.getByTestId('palette-search')
  const listbox = page.getByRole('listbox', { name: 'Node results' })
  await expect(input).toBeFocused()
  await expect(palette).toHaveClass(/floating-surface/)
  expect(await listbox.ariaSnapshot()).toContain('group "Available nodes"')
  expect(await listbox.ariaSnapshot()).toContain('option "Palette')
  await expect(page.getByTestId('palette-preview')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await capture(page, '01-after-zero-query-edge-1600x950')

  await input.fill('Palette schema preview')
  await expect(page.locator('[data-node-type="PaletteRichPreview"]')).toBeVisible()
  await expect(page.getByTestId('palette-preview')).toContainText('required')
  await expect(page.getByTestId('palette-preview')).toContainText('optional')
  await expect(page.getByTestId('palette-preview')).toContainText('IMAGE')
  await expect(page.getByTestId('palette-preview')).toContainText('MODEL')
  const activeId = await input.getAttribute('aria-activedescendant')
  expect(activeId).not.toBeNull()
  await expect(page.locator(`#${activeId}`)).toHaveAttribute('role', 'option')
  await capture(page, '02-after-long-schema-preview-1600x950')

  await input.fill('no node can match this query')
  await expect(page.locator('[data-search-state="empty"]')).toContainText('No matching nodes')
  expect(await listbox.ariaSnapshot()).not.toContain('No matching nodes')
  await expect(input).not.toHaveAttribute('aria-activedescendant')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await capture(page, '03-after-no-matches-1600x950')

  await input.fill('Palette transform')
  const categories = page.getByRole('navigation', { name: 'Node categories' })
  const imageCategory = categories.getByTestId('palette-category').filter({ hasText: /^Image\d+$/ })
  await imageCategory.click()
  await expect(imageCategory).toHaveAttribute('aria-pressed', 'true')
  const inputFilter = page.getByTestId('palette-input-filter').locator('.palette-type-trigger')
  await inputFilter.click()
  const filterDialog = page.getByRole('dialog', { name: 'Input type filters' })
  await expect(filterDialog).toHaveClass(/floating-surface/)
  await filterDialog.getByRole('searchbox').fill('image')
  await expect(filterDialog.getByRole('checkbox', { name: 'IMAGE' })).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await capture(page, '04-after-category-type-filter-1600x950')
  await filterDialog.getByRole('searchbox').press('Escape')
  await expect(inputFilter).toBeFocused()

  await categories.getByRole('button', { name: 'Most relevant' }).click()
  await input.fill('Palette image')
  await inputFilter.click()
  await filterDialog.getByRole('searchbox').fill('image')
  await filterDialog.getByRole('checkbox', { name: 'IMAGE', exact: true }).click()
  await expect(page.locator('[data-node-type="PaletteImageConsumer"]')).toBeVisible()
  await expect(page.locator('[data-node-type="PaletteImageProducer"]')).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await filterDialog.getByRole('searchbox').press('Escape')
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
    listbox.locator('.search-result-group-header').boundingBox(),
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

  await openPalette(page)
  const category = page.getByTestId('palette-category').first()
  await category.focus()
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
      const railToggle = page.getByRole('button', { name: 'Toggle right rail' })
      if (await railToggle.getAttribute('aria-pressed') === 'true') await railToggle.click()
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
    const activeBox = (await active.boundingBox())!
    const resultBox = (await page.getByRole('listbox', { name: 'Node results' }).boundingBox())!
    expect(activeBox.y).toBeGreaterThanOrEqual(resultBox.y)
    expect(activeBox.y + activeBox.height).toBeLessThanOrEqual(resultBox.y + resultBox.height)

    const inputFilter = page.getByTestId('palette-input-filter').locator('.palette-type-trigger')
    await inputFilter.click()
    const filterDialog = page.getByRole('dialog', { name: 'Input type filters' })
    await expect(filterDialog).toBeVisible()
    const paletteBox = (await palette.boundingBox())!
    const filterBox = (await filterDialog.boundingBox())!
    expect(filterBox.x).toBeGreaterThanOrEqual(paletteBox.x)
    expect(filterBox.y).toBeGreaterThanOrEqual(paletteBox.y)
    expect(filterBox.x + filterBox.width).toBeLessThanOrEqual(paletteBox.x + paletteBox.width)
    expect(filterBox.y + filterBox.height).toBeLessThanOrEqual(paletteBox.y + paletteBox.height)
    if (viewport.width === 360) {
      await page.setViewportSize({ width: 240, height: viewport.height })
      await expect.poll(async () => (await filterDialog.boundingBox())?.width ?? Number.POSITIVE_INFINITY).toBeLessThan(filterBox.width)
      await page.setViewportSize({ width: 600, height: viewport.height })
      await expect.poll(async () => (await filterDialog.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(filterBox.width)
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await expect.poll(async () => (await filterDialog.boundingBox())?.width ?? 0).toBe(filterBox.width)
    }
    await filterDialog.getByRole('searchbox').press('Escape')

    if (viewport.width === 360) {
      const lastVisibleCategory = palette.getByTestId('palette-category').last()
      await lastVisibleCategory.focus()
      await page.keyboard.press('Tab')
      await expect(input).toBeFocused()
      await input.press('Shift+Tab')
      await expect(lastVisibleCategory).toBeFocused()
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

test('an open palette and type filter update when the active locale changes', async ({ page, request }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await openPalette(page)
  const palette = page.getByTestId('node-palette')
  const search = page.getByTestId('palette-search')
  const inputFilter = page.getByTestId('palette-input-filter').locator('.palette-type-trigger')
  await search.fill('Palette schema preview')
  await inputFilter.click()
  await expect(palette).toHaveAttribute('aria-label', 'Add a node')
  await expect(search).toHaveAttribute('placeholder', 'Add a node...')
  await expect(inputFilter).toContainText('Input: Any type')
  await expect(page.getByRole('dialog', { name: 'Input type filters' })).toBeVisible()
  await page.getByRole('dialog', { name: 'Input type filters' }).getByRole('searchbox').press('Escape')
  await search.fill('PaletteImageConsumer')
  await page.screenshot({ path: evidencePath('issue-457', 'node-palette-i18n-en.png'), fullPage: true })
  await search.fill('Palette schema preview')
  await inputFilter.click()

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'palette.action.addNode': '[Knoten hinzufugen]',
      'palette.category.mostRelevant': '[Beste Treffer]',
      'palette.category.navigation': '[Knotenkategorien]',
      'palette.filter.input': '[Eingang]',
      'palette.filter.output': '[Ausgang]',
      'palette.filter.resultKinds': '[Ergebnisarten]',
      'palette.kind.nodes': '[Knotenarten mit langem Namen]',
      'palette.kind.utilities': '[Werkzeuge mit langem Namen]',
      'palette.port.optional': '[wahlweise]',
      'palette.port.required': '[erforderlich]',
      'palette.ports.inputs': '[Eingange]',
      'palette.ports.outputs': '[Ausgange]',
      'palette.results.available': '[Verfugbare Knoten]',
      'palette.search.addNodePlaceholder': '[Knoten suchen und hinzufugen...]',
      'palette.typeFilter.any': '[Alle Typen]',
      'palette.typeFilter.dialog': '[Typfilter: {label}]',
      'palette.typeFilter.search': '[Suche Typen: {direction}]',
      'palette.typeFilter.searchPlaceholder': '[Typen durchsuchen...]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(palette).toHaveAttribute('aria-label', '[Knoten hinzufugen]')
  await expect(search).toHaveAttribute('placeholder', '[Knoten suchen und hinzufugen...]')
  await expect(page.getByTestId('palette-categories')).toHaveAttribute('aria-label', '[Knotenkategorien]')
  await expect(page.getByTestId('palette-kinds')).toHaveAttribute('aria-label', '[Ergebnisarten]')
  await expect(inputFilter).toContainText('[Eingang]: [Alle Typen]')
  await expect(page.getByRole('dialog', { name: '[Typfilter: [Eingang]]', exact: true })).toBeVisible()
  await expect(page.getByRole('searchbox', { name: '[Suche Typen: [eingang]]' })).toHaveAttribute('placeholder', '[Typen durchsuchen...]')
  await expect(page.getByTestId('palette-preview')).toContainText('[Eingange]')
  await expect(page.getByTestId('palette-preview')).toContainText('[Ausgange]')
  await expect(page.getByTestId('palette-preview')).toContainText('[erforderlich]')
  await expect(page.getByTestId('palette-preview')).toContainText('[wahlweise]')
  await page.getByRole('dialog', { name: '[Typfilter: [Eingang]]', exact: true }).getByRole('searchbox').press('Escape')
  await search.fill('PaletteImageConsumer')
  await page.screenshot({ path: evidencePath('issue-457', 'node-palette-i18n-de-DE.png'), fullPage: true })
})
