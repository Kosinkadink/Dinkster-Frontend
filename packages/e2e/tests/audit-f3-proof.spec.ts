import { expect, test } from './fixtures.js'

test('proves product numeric, slider, and color controls without native chrome', async ({ page, request }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'audit-f3-proof', schemaWire: 1 },
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
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    app.registerSchemas([{
      type: 'NumericProof', displayName: 'Numeric proof', category: 'proof', source: 'v3', isOutputNode: false,
      items: [widget('count', 'INT', 5, { min: 0, max: 100, step: 5 }), widget('color', 'COLOR', '#112233')],
    }])
    app.openDocument({
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

  const mainModule = await (await request.get('/src/main.tsx')).text()
  const renderModule = mainModule.match(/from "([^"]*solid-js_web[^"]*)"/)?.[1]
  expect(renderModule).toBeDefined()
  await page.evaluate(async ({ renderModule }) => {
    const { render } = await import(renderModule)
    const runtimeSettingsModule = '/src/RuntimeSettingsPanel.tsx'
    const { RuntimeSettingsPanel } = await import(runtimeSettingsModule)
    const host = document.createElement('section')
    host.id = 'runtime-proof'
    document.body.append(host)
    const updates: unknown[] = []
    const section = { value: { 'cuda:0': 512 * 1024 ** 2 }, source: 'default', mutability: 'live', writable: true, persistence: { available: true, persisted: true } }
    const connection = {
      fetchRuntimeSettings: async () => ({ categories: { granted: ['memory-budgets'], available: ['memory-budgets'] }, settings: { 'memory-budgets': section } }),
      updateRuntimeSetting: async (category: string, value: unknown) => { updates.push([category, value]); return { ...section, value } },
    }
    render(() => RuntimeSettingsPanel({ connection, alwaysOpen: true, memoryControls: true }), host)
    ;(window as any).__numericProofUpdates = updates
  }, { renderModule: new URL(renderModule!, page.url()).href })

  const budget = page.locator('#runtime-proof [role="spinbutton"]')
  const budgetSlider = page.locator('#runtime-proof [role="slider"]')
  await expect(budget).toHaveValue('512')
  await budget.fill('768')
  await expect(budgetSlider).toHaveAttribute('aria-valuenow', '768')
  expect(await page.evaluate(() => (window as any).__numericProofUpdates.length)).toBe(0)
  await budgetSlider.press('ArrowRight')
  await expect(budget).toHaveValue('832')
  await budget.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__numericProofUpdates.length)).toBe(1)

  const chrome = await page.locator('[data-testid="app-view-number"], [data-testid="app-view-color"], #runtime-proof [role="slider"]').evaluateAll((elements) => elements.map((element) => ({
    tag: element.tagName,
    type: element.getAttribute('type'),
    appearance: getComputedStyle(element).appearance,
  })))
  expect(chrome.every((item) => item.type !== 'number' && item.type !== 'range' && item.type !== 'color' && item.appearance !== 'auto')).toBe(true)
})
