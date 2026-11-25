import { expect, nativeAppViewTest as test, waitForWorkspaceReady } from './fixtures.js'

test('proves product numeric and color controls without native chrome', async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'audit-f3-proof', schemaWire: 2 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  // The test bridge appears asynchronously during boot; evaluating before it
  // exists races and fails with "Cannot read properties of undefined".
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await waitForWorkspaceReady(page)

  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app as any
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    app.registerSchemas([{
      type: 'NumericProof', displayName: 'Numeric proof', category: 'proof', source: 'v3', isOutputNode: false,
      body: [widget('count', 'INT', 5, { min: 0, max: 100, step: 5 }), widget('color', 'COLOR', '#112233')],
    }])
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'numeric-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { proof: { id: 'proof', type: 'NumericProof', values: { count: 5, color: 'not-a-color' } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { proof: { position: { x: 100, y: 100 } } } } } },
      ext: { 'dinkster.exposed': [{ graphId: 'g0', nodeId: 'proof', inputId: 'count' }, { graphId: 'g0', nodeId: 'proof', inputId: 'color' }] },
    }, 'Numeric Proof')
    app.setTabEditorKind(app.activeTab()!.id, 'app')
  })
  // The workspace authority asynchronously replaces the tab's store with a
  // shared session whose revision counter starts fresh; revision arithmetic
  // across that swap is meaningless. Wait for the promoted store first.
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })

  const number = page.getByTestId('app-view-number')
  const initialRevision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await number.fill('35')
  await number.press('Escape')
  await expect(number).toHaveValue('5')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(initialRevision)
  await number.fill('35')
  await number.press('Enter')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(initialRevision + 1)
  await number.press('ArrowUp')
  await expect(number).toHaveValue('40')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(initialRevision + 2)
  await number.fill('45')
  const beforeStepper = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.getByRole('button', { name: 'Increase value' }).click()
  await expect(number).toHaveValue('50')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeStepper + 1)

  const color = page.getByTestId('app-view-color')
  await expect(color).toContainText('#ffffff')
  const beforeColor = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await color.click()
  const untouchedHex = page.getByRole('textbox', { name: 'Hex color' })
  await expect(untouchedHex).toHaveValue('not-a-color')
  await untouchedHex.press('Enter')
  await expect(page.getByRole('button', { name: 'Apply color' })).toBeDisabled()
  await expect(page.getByRole('dialog', { name: 'Choose color' })).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeColor)
  await untouchedHex.press('Escape')
  await expect(color).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeColor)
  await color.click()
  const hex = page.getByRole('textbox', { name: 'Hex color' })
  await hex.fill('invalid')
  await expect(page.getByRole('button', { name: 'Apply color' })).toBeDisabled()
  await hex.press('Escape')
  await expect(color).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeColor)
  await color.click()
  await page.getByRole('textbox', { name: 'Hex color' }).fill('#Ab12Cd')
  await page.getByRole('button', { name: 'Apply color' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.proof!.values.color)).toBe('#Ab12Cd')

  const chrome = await page.locator('[data-testid="app-view-number"], [data-testid="app-view-color"]').evaluateAll((elements) => elements.map((element) => ({
    tag: element.tagName,
    type: element.getAttribute('type'),
    appearance: getComputedStyle(element).appearance,
  })))
  expect(chrome.every((item) => item.type !== 'number' && item.type !== 'range' && item.type !== 'color' && item.appearance !== 'auto')).toBe(true)
})
