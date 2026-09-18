import { expect, test } from './fixtures.js'

test('the named-nets setting still disables net menus as an escape hatch', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'features.namedNets.enabled': false } })))
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const point = await page.evaluate(() => {
    const test = window.__dinksterTest! as any
    const sceneNode = test.renderer.getScene().nodes[0]
    const schema = test.app.registry.get().resolve(sceneNode.node.type)
    const input = schema.items.find((item: any) => item.kind === 'input' && item.widget)
    test.app.registerSchemas([{ ...schema, items: schema.items.map((item: any) =>
      item === input ? { ...item, widget: { ...item.widget, controller: 'after_generate' } } : item,
    ) }])
    const refreshed = test.renderer.getScene().nodes[0]
    const row = refreshed.layout.rows.find((item: any) => item.kind === 'widget' && item.inputId === input.id)
    if (row.controllerMode !== 'randomize') throw new Error('seed controller was not laid out')
    const pin = refreshed.layout.pins.find((item: any) => item.direction === 'out')
    if (!pin) throw new Error('fixture has no output pin')
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const vp = test.renderer.getViewport()
    return { x: rect.left + (refreshed.x + refreshed.layout.width) * vp.scale + vp.x, y: rect.top + (refreshed.y + pin.y) * vp.scale + vp.y }
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.pin.promoteToNet"]')).toHaveCount(0)
})

test('control surfaces panel is absent by default', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await expect(page.getByTestId('surface-panel')).toHaveCount(0)
})
