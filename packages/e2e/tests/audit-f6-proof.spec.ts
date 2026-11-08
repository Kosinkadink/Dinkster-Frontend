import { expect, test } from './fixtures.js'

test('proves both product type disclosures and mutation-free interaction', async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ status: 502, body: 'no v1 backend' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'audit-f6-proof', schemaWire: 1 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  // The test bridge appears asynchronously during boot; evaluating before it
  // exists races and fails with "Cannot read properties of undefined".
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.registerSchemas([{
      type: 'LatentConsumer', displayName: 'Latent Consumer', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'latent', type: { kind: 'concrete', name: 'LATENT' }, optional: false }],
    }, {
      type: 'ImageConsumer', displayName: 'Image Consumer', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
    }, {
      type: 'ImageProducer', displayName: 'Image Producer', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } }],
    }, ...Array.from({ length: 12 }, (_, index) => ({
      type: `TypeConsumer${index}`, displayName: `Type Consumer ${index}`, category: 'proof', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: `TYPE_${index}` }, optional: false }],
    }))])
  })

  // The workspace authority asynchronously replaces the tab's store with a
  // shared session whose revision counter starts fresh; revision arithmetic
  // across that swap is meaningless. Wait for the promoted store first.
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()
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
  await page.getByLabel('Search input types').press('Shift+Tab')
  await expect(inputTrigger).toBeFocused()
  await inputTrigger.press('Escape')
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(inputTrigger).toBeFocused()
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await inputTrigger.press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()

  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await inputTrigger.press('Space')
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'true')
  await page.getByTestId('palette-search').click()
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('palette-search')).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  await inputTrigger.focus()
  await inputTrigger.press('Enter')
  await outputTrigger.focus()
  await expect(outputTrigger).toBeFocused()
  await expect(inputTrigger).toHaveAttribute('aria-expanded', 'false')

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

  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await expect(page.getByTestId('palette-input-filter')).toHaveAttribute('data-expanded', 'false')
  await page.getByTestId('palette-search').press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()

  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await page.setViewportSize({ width: 700, height: 260 })
  await page.getByTestId('palette-input-filter').locator('.palette-type-trigger').click()
  const geometry = await page.evaluate(() => {
    const palette = document.querySelector('.node-palette')!.getBoundingClientRect()
    const panel = document.querySelector('.palette-type-popover')!.getBoundingClientRect()
    return { paletteTop: palette.top, paletteBottom: palette.bottom, panelTop: panel.top, panelBottom: panel.bottom }
  })
  expect(geometry.panelTop).toBeGreaterThanOrEqual(geometry.paletteTop)
  expect(geometry.panelBottom).toBeLessThanOrEqual(geometry.paletteBottom)

  await page.setViewportSize({ width: 700, height: 100 })
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('.node-palette')!.style.width = '8px'
    window.dispatchEvent(new Event('resize'))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
  const tiny = await page.evaluate(() => {
    const palette = document.querySelector('.node-palette')!.getBoundingClientRect()
    const panel = document.querySelector('.palette-type-popover')!.getBoundingClientRect()
    return {
      paletteTop: palette.top, paletteLeft: palette.left, paletteRight: palette.right,
      panelTop: panel.top, panelLeft: panel.left, panelRight: panel.right, panelWidth: panel.width,
    }
  })
  expect(tiny.panelTop).toBeGreaterThanOrEqual(tiny.paletteTop)
  expect(tiny.panelWidth).toBeGreaterThanOrEqual(0)
  expect(tiny.panelLeft).toBeGreaterThanOrEqual(Math.max(0, tiny.paletteLeft))
  expect(tiny.panelLeft).toBeLessThanOrEqual(Math.min(700, tiny.paletteRight))
  expect(Number.isFinite(tiny.panelRight)).toBe(true)
})
