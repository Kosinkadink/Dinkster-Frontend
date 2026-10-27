/**
 * Structured palette filters: kind:/in:/out: tokens and the kind chip row.
 * Kind filters split nodes from subgraphs; port filters consult declared
 * type structure (subgraphs via their boundary-derived schema); residual
 * text still ranks through the shared scorer.
 */
import { expect, nativeTest, test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

const openPalette = async (page: Page): Promise<void> => {
  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()
}

const gotoSubgraphTab = async (page: Page): Promise<void> => {
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
}

test('kind:node hides subgraph entries; kind:subgraph shows only them', async ({ page }) => {
  await gotoSubgraphTab(page)
  await openPalette(page)
  const search = page.getByTestId('palette-search')

  await search.fill('kind:subgraph')
  await expect(page.getByTestId('palette-item')).toHaveCount(1)
  await expect(page.locator('[data-node-type="#g1"]')).toBeVisible()

  await search.fill('kind:node image')
  await expect(page.getByTestId('palette-item').first()).toBeVisible()
  await expect(page.locator('[data-node-type="#g1"]')).not.toBeVisible()
})

test('in: filters by declared input type with residual text ranking', async ({ page }) => {
  await openPalette(page)
  const search = page.getByTestId('palette-search')

  await search.fill('in:latent decode')
  await expect(page.locator('[data-node-type="VAEDecode"]')).toBeVisible()
  // LoadImage has no latent input; "decode" text alone must not revive it.
  await expect(page.locator('[data-node-type="LoadImage"]')).not.toBeVisible()

  await search.fill('in:latent')
  await expect(page.locator('[data-node-type="KSampler"]')).toBeVisible()
})

nativeTest('long node names do not overlap their pack badge', async ({ page }) => {
  nativeTest.skip(process.env['DINKSTER_E2E_USE_NATIVE'] !== '1', 'requires the native multi-pack catalog')
  await openPalette(page)
  await page.getByTestId('palette-search').fill('Convert Text to Lowercase')
  const row = page.locator('[data-node-type="comfy.TextToLowercase"]')
  const name = row.locator('.search-result-row-title')
  const pack = row.locator('.search-result-row-badge')
  await expect(row).toBeVisible()
  await expect(pack).toHaveText('ComfyUI Compat')

  const [nameBox, packBox] = await Promise.all([name.boundingBox(), pack.boundingBox()])
  expect(nameBox).not.toBeNull()
  expect(packBox).not.toBeNull()
  expect(nameBox!.x + nameBox!.width).toBeLessThanOrEqual(packBox!.x)
})

test('out: filters match subgraphs through their boundary-derived schema', async ({ page }) => {
  await gotoSubgraphTab(page)
  await openPalette(page)
  const search = page.getByTestId('palette-search')

  // "Image source" wraps EmptyImage; its boundary output is an IMAGE.
  await search.fill('out:image kind:subgraph')
  await expect(page.locator('[data-node-type="#g1"]')).toBeVisible()

  // It produces no latent, so the same subgraph fails out:latent.
  await search.fill('out:latent kind:subgraph')
  await expect(page.getByTestId('palette-item')).toHaveCount(0)
})

test('kind chips filter and toggle; the utility kind always offers a choice', async ({ page }) => {
  // The synthetic Reroute utility entry means every document offers at
  // least node + utility kinds, so the chip row is always present.
  await openPalette(page)
  await expect(page.getByTestId('palette-kinds')).toBeVisible()
  const utilityChip = page.locator('[data-testid="palette-kind"][data-kind="utility"]')
  await utilityChip.click()
  await expect(page.locator('[data-node-type="__dinkster.reroute"]')).toBeVisible()
  await expect(page.locator('[data-node-type="KSampler"]')).toHaveCount(0)
  // Toggling the last active chip clears the filter again.
  await utilityChip.click()
  expect(await page.getByTestId('palette-item').count()).toBeGreaterThan(1)
  await page.getByTestId('palette-search').press('Escape')

  await gotoSubgraphTab(page)
  await openPalette(page)
  await expect(page.getByTestId('palette-kinds')).toBeVisible()

  const subgraphChip = page.locator('[data-testid="palette-kind"][data-kind="subgraph"]')
  await subgraphChip.click()
  await expect(page.getByTestId('palette-item')).toHaveCount(1)
  await expect(page.locator('[data-node-type="#g1"]')).toBeVisible()
  // The chip must not steal focus from the search input (palette stays open).
  await expect(page.getByTestId('node-palette')).toBeVisible()

  // Toggling the last active chip clears the filter.
  await subgraphChip.click()
  await expect(page.getByTestId('palette-item').first()).toBeVisible()
  const count = await page.getByTestId('palette-item').count()
  expect(count).toBeGreaterThan(1)
})

test('highlighted entry shows a schema preview: ports with types, keyboard-driven', async ({ page }) => {
  await openPalette(page)
  const search = page.getByTestId('palette-search')
  await search.fill('VAEDecode')

  // Hovering an entry highlights it; its interface renders beside the list.
  const preview = page.getByTestId('palette-preview')
  await expect(preview).toBeVisible()
  await page.locator('[data-node-type="VAEDecode"]').hover()
  const canvas = preview.getByTestId('palette-node-preview')
  await expect(canvas).toHaveAttribute('data-preview-ready', 'VAEDecode')
  const painted = await canvas.evaluate((element: HTMLCanvasElement) => ({
    width: element.width,
    height: element.height,
    nonBlank: element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data.some((value) => value !== 0),
  }))
  expect(painted.width).toBeGreaterThan(0)
  expect(painted.height).toBeGreaterThan(0)
  expect(painted.nonBlank).toBe(true)
  await expect(preview.locator('.preview-title')).toHaveText('VAE Decode')
  await expect(preview.getByTestId('preview-input')).toHaveCount(2) // samples + vae
  await expect(preview.getByTestId('preview-input').first()).toContainText('LATENT')
  await expect(preview.getByTestId('preview-output')).toHaveCount(1)
  await expect(preview.getByTestId('preview-output')).toContainText('IMAGE')
  const portType = preview.locator('.preview-port-type[data-tooltip-label]').first()
  const tooltipText = await portType.getAttribute('data-tooltip-label')
  expect(tooltipText).toBeTruthy()
  await expect(portType).not.toHaveAttribute('title')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await portType.hover()
  await expect(page.getByTestId('app-tooltip')).toHaveText(tooltipText!, { timeout: 1_500 })
  await portType.focus()
  await expect(page.getByTestId('app-tooltip')).toHaveText(tooltipText!)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  // Arrow keys move the highlight and the preview follows.
  await search.fill('image')
  const first = await page.getByTestId('palette-item').first().locator('.search-result-row-title').textContent()
  const firstType = await canvas.getAttribute('data-preview-ready')
  expect(firstType).toBeTruthy()
  await search.press('ArrowDown')
  await expect(preview.locator('.preview-title')).not.toHaveText(first!)
  await expect(canvas).not.toHaveAttribute('data-preview-ready', firstType!)
})

test('subgraph entries preview their boundary-derived interface', async ({ page }) => {
  await gotoSubgraphTab(page)
  await openPalette(page)
  await page.getByTestId('palette-search').fill('kind:subgraph')
  const preview = page.getByTestId('palette-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('.preview-meta')).toContainText('subgraph')
  await expect(preview.getByTestId('palette-node-preview')).toHaveAttribute('data-preview-ready', '#g1')
  // "Image source" wraps EmptyImage: boundary output is an IMAGE.
  await expect(preview.getByTestId('preview-output')).toContainText('IMAGE')
})

test('closing the palette resets chip filters', async ({ page }) => {
  await gotoSubgraphTab(page)
  await openPalette(page)
  await page.locator('[data-testid="palette-kind"][data-kind="subgraph"]').click()
  await expect(page.getByTestId('palette-item')).toHaveCount(1)
  await page.getByTestId('palette-search').press('Escape')

  await openPalette(page)
  await expect(page.locator('[data-testid="palette-kind"][data-kind="subgraph"]')).not.toHaveClass(/active/)
  const count = await page.getByTestId('palette-item').count()
  expect(count).toBeGreaterThan(1)
})

test('product type disclosures are independent, keyboard complete, and mutation free', async ({ page }) => {
  await openPalette(page)
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const input = page.getByTestId('palette-input-filter')
  const output = page.getByTestId('palette-output-filter')
  const inputTrigger = input.locator('.palette-type-trigger')
  const outputTrigger = output.locator('.palette-type-trigger')
  await expect(inputTrigger).toHaveText('Input: Any type')
  await expect(outputTrigger).toHaveText('Output: Any type')

  await inputTrigger.focus()
  await inputTrigger.press('Enter')
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'true')
  await expect(outputTrigger).toHaveAttribute('aria-expanded', 'false')
  const inputPanel = page.locator(`#${await inputTrigger.getAttribute('aria-controls')}`)
  const inputSearch = inputPanel.getByLabel('Search input types')
  await expect(inputSearch).toBeFocused()
  await inputSearch.fill('definitely-no-type')
  await expect(inputPanel).toContainText('No matching types')
  await inputSearch.fill('latent')
  const latent = inputPanel.getByRole('checkbox', { name: 'LATENT', exact: true })
  await expect(latent).toHaveAttribute('aria-checked', 'false')
  await inputSearch.press('ArrowDown')
  await expect(latent).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  const resultCount = await page.getByTestId('palette-item').count()
  await latent.press('Space')
  await expect(latent).toHaveAttribute('aria-checked', 'true')
  await expect(inputTrigger).toHaveText('Input: 1 selected')
  expect(await page.getByTestId('palette-item').count()).toBeLessThan(resultCount)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  await expect(outputTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(outputTrigger).toHaveText('Output: Any type')

  await latent.press('Escape')
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(inputTrigger).toBeFocused()
  await inputTrigger.press('Space')
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('palette-search').click()
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('palette-search')).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  await outputTrigger.focus()
  await outputTrigger.press('Enter')
  await expect(outputTrigger).toHaveAttribute('aria-expanded', 'true')
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'false')
  await page.getByLabel('Search output types').press('Escape')
  await expect(outputTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(outputTrigger).toBeFocused()
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await outputTrigger.press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()

  await openPalette(page)
  await expect(page.getByTestId('palette-input-filter')).toHaveAttribute('data-expanded', 'false')
  await page.getByTestId('palette-search').press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
})

test('backdrop pointerdown dismisses without reaching or panning the canvas', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  const viewportBefore = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  const selectionBefore = await canvas.getAttribute('data-selection')
  await openPalette(page)

  const backdrop = page.getByTestId('palette-backdrop')
  const box = (await backdrop.boundingBox())!
  await page.mouse.move(box.x + 8, box.y + box.height / 2)
  await page.mouse.down()
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  await page.mouse.move(box.x + 80, box.y + box.height / 2)
  await page.mouse.up()

  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())).toEqual(viewportBefore)
  await expect(canvas).toHaveAttribute('data-selection', selectionBefore!)
})

test('Escape closes globally after an inside category control receives focus', async ({ page }) => {
  await openPalette(page)
  const category = page.getByTestId('palette-category').first()
  await category.click()
  await expect(category).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
})
