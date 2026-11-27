import { expect, test, type Page } from '@playwright/test'
import type { WidgetSpec } from '@dinkster/core'

async function controls(page: Page, width: number) {
  await page.setViewportSize({ width, height: 1500 })
  await page.route('**/api/**', (route) => route.fulfill({ status: 503, json: {} }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get()[0]!
    backend.registry.set({ connection: app.connection.id, hash: 'controls', schemas: new Map(), diagnostics: [], resolve: () => undefined })
    const specs: Record<string, WidgetSpec> = {
      Count: { widgetType: 'INT', options: { min: 1, max: 100 }, default: 19 },
      Enabled: { widgetType: 'BOOLEAN', options: {}, default: true },
      Colour: { widgetType: 'COLOR', options: {}, default: '#32e6c5' },
      Tags: { widgetType: 'LIST', options: {}, element: { widgetType: 'STRING', options: {} }, default: ['lake', 'morning'] },
      Integers: { widgetType: 'LIST', options: {}, element: { widgetType: 'INT', options: {} }, default: [7, 19] },
      Floats: { widgetType: 'LIST', options: {}, element: { widgetType: 'FLOAT', options: { round: 0.25, precision: 2 } }, default: [1.25, -3.5] },
      Video: { widgetType: 'VIDEO_EDIT', options: {}, default: {} },
    }
    app.registerSchemas([
      { type: 'Controls', displayName: 'Controls', category: 'test', source: 'v3', isOutputNode: false,
        body: Object.entries(specs).map(([id, widget]) => ({ kind: 'input', id, type: { kind: 'concrete', name: widget.widgetType }, optional: false, widget })) },
      { type: 'Source', displayName: 'Source', category: 'test', source: 'v3', isOutputNode: false,
        body: Object.entries(specs).map(([id, widget]) => ({ kind: 'output', id, type: { kind: 'concrete', name: widget.widgetType } })) },
    ])
    await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: `controls-${innerWidth}`, root: 'root',
      graphs: { root: { id: 'root', name: 'Workflow', nextOrdinal: 30, nets: {}, reroutes: {},
        nodes: { editable: { id: 'editable', type: 'Controls', values: {} }, connected: { id: 'connected', type: 'Controls', values: {} }, source: { id: 'source', type: 'Source', values: {} } },
        links: Object.fromEntries(Object.keys(specs).map((id) => [id, { id, from: { node: 'source', port: id }, to: { node: 'connected', port: id } }])) } },
      view: { graphs: {} }, ext: { 'dinkster.exposed': ['editable', 'connected'].flatMap((nodeId) => Object.keys(specs).map((inputId) => ({ graphId: 'root', nodeId, inputId, label: `${nodeId} ${inputId}` }))) },
    }, 'Controls')
    await app.enableWorkspaceAuthority()
    app.settings.set('features.appView.enabled', true)
    app.setTabEditorKind(app.activeTab()!.id, 'app')
  })
  if (width === 390) await page.getByRole('button', { name: 'Close Inspector panels', exact: true }).click()
  await expect(page.getByTestId('app-view-row')).toHaveCount(14)
  return (label: string) => page.getByTestId('app-view-row').filter({ has: page.getByTestId('app-view-label').filter({ hasText: label }) })
}

const stored = (page: Page, key: string) => page.evaluate((key) => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes.editable!.values[key], key)

test('number buttons decrease then increase with the same field-button glyph size and colour', async ({ page }) => {
  for (const width of [1440, 390]) {
    const row = (await controls(page, width))('editable Count')
    const buttons = row.getByRole('button')
    await expect(buttons.nth(0)).toHaveAccessibleName('Decrease value')
    await expect(buttons.nth(1)).toHaveAccessibleName('Increase value')
    await buttons.nth(0).click()
    await expect.poll(() => stored(page, 'Count')).toBe(18)
    await buttons.nth(1).click()
    await expect.poll(() => stored(page, 'Count')).toBe(19)
    const glyph = await buttons.nth(0).locator('svg').evaluate((element) => ({ width: element.getBoundingClientRect().width, colour: getComputedStyle(element).color }))
    expect(glyph.width).toBeGreaterThanOrEqual(12)
    expect(glyph.colour).toBe(await row.locator('input').evaluate((element) => getComputedStyle(element).color))
  }
})

test('checkbox, label and node name share one line aligned with the other fields', async ({ page }) => {
  for (const width of [1440, 390]) {
    const row = await controls(page, width)
    const checkbox = row('editable Enabled').getByRole('checkbox')
    const box = (await checkbox.boundingBox())!
    const label = (await row('editable Enabled').getByTestId('app-view-label').boundingBox())!
    const number = (await row('editable Count').locator('.product-number').boundingBox())!
    const square = (await checkbox.locator('span').boundingBox())!
    expect(Math.abs(square.x - number.x)).toBeLessThanOrEqual(1)
    expect(label.x).toBeGreaterThanOrEqual(box.x + box.width)
    expect(Math.abs(box.y + box.height / 2 - label.y - label.height / 2)).toBeLessThanOrEqual(3)
    await expect(row('editable Enabled').getByTestId('app-view-label')).toContainText('Controls')
    await checkbox.click()
    await expect.poll(() => stored(page, 'Enabled')).toBe(false)
    await expect(row('connected Enabled').getByRole('checkbox')).toBeDisabled()
    await expect(row('connected Enabled').getByRole('checkbox')).toBeChecked()
  }
})

test('colour swatch and code start at the left of the field', async ({ page }) => {
  for (const width of [1440, 390]) {
    const row = (await controls(page, width))('editable Colour')
    const field = row.getByTestId('app-view-color')
    const box = (await field.boundingBox())!
    const swatch = (await field.locator('span').first().boundingBox())!
    expect(swatch.x - box.x).toBeLessThan(20)
    await field.click()
    await page.getByRole('textbox', { name: 'Hex color' }).fill('#336699')
    await page.getByRole('button', { name: 'Apply color' }).click()
    await expect.poll(() => stored(page, 'Colour')).toBe('#336699')
  }
})

test('lists use typed lines, preserve an invalid draft with its line error and render connected items without JSON', async ({ page }) => {
  for (const width of [1440, 390]) {
    const row = await controls(page, width)
    const tags = row('editable Tags').getByRole('textbox')
    await expect(tags).toHaveValue('lake\nmorning')
    await tags.fill('lake, dusk\n"quoted"\n')
    await tags.press('Tab')
    await expect.poll(() => stored(page, 'Tags')).toEqual(['lake, dusk', '"quoted"', ''])
    await expect(row('connected Tags').getByTestId('app-view-readonly')).toContainText('lake, morning')
    const integers = row('editable Integers').getByRole('textbox')
    await integers.fill('7\n18446744073709551615')
    await integers.press('Tab')
    await expect.poll(() => stored(page, 'Integers')).toEqual([7, '18446744073709551615'])
    await integers.fill('7\n1.5')
    await integers.press('Tab')
    await expect(row('editable Integers').getByTestId('app-view-error')).toContainText('Line 2:')
    expect(await stored(page, 'Integers')).toEqual([7, '18446744073709551615'])
    await expect(integers).toHaveValue('7\n1.5')
    await integers.press('Escape')
    await expect(integers).toHaveValue('7\n18446744073709551615')
    const floats = row('editable Floats').getByRole('textbox')
    await floats.fill('2.3\n-1.8')
    await floats.press('Tab')
    await expect.poll(() => stored(page, 'Floats')).toEqual([2.25, -1.75])
    await floats.fill('')
    await floats.press('Tab')
    await expect.poll(() => stored(page, 'Floats')).toEqual([])
  }
})

test('video painting opens its editor by click and keyboard while a connected row stays nonoperable', async ({ page }) => {
  for (const width of [1440, 390]) {
    const row = await controls(page, width)
    const editable = row('editable Video')
    const editor = editable.getByRole('button', { name: 'Edit editable Video video' })
    await expect(editor.locator('canvas')).toHaveCount(1)
    await expect(editor).toHaveCSS('border-top-width', '0px')
    await expect(editable).not.toContainText('Edit trim/crop')
    for (const method of ['click', 'Enter', 'Space']) {
      if (method === 'click') await editor.click()
      else { await editor.focus(); await page.keyboard.press(method) }
      await expect(page.getByTestId('widget-editor')).toHaveAttribute('data-editor-mode', 'VIDEO_EDIT')
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('widget-editor')).toHaveCount(0)
    }
    await expect(row('connected Video').getByRole('button')).toHaveCount(0)
    await expect(row('connected Video').getByTestId('app-view-readonly')).toContainText('Driven by a link')
    expect(await stored(page, 'Video')).toBeUndefined()
  }
})
