import { expect, test } from './fixtures.js'

test.beforeEach(async ({ page }) => { await page.goto('/') })

test('opening Library dismisses its focused activity-bar tooltip', async ({ page }) => {
  const library = page.getByTestId('library-toggle')
  if (await library.getAttribute('aria-pressed') === 'true') await library.click()
  await page.mouse.move(600, 400)
  await library.focus()
  await expect(page.getByTestId('app-tooltip')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(library).toBeFocused()
  await expect(library).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await library.hover()
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await page.keyboard.press('Enter')
  await expect(library).toHaveAttribute('aria-pressed', 'false')
  await page.mouse.move(600, 400)
  await library.blur()
  await library.focus()
  await expect(page.getByTestId('app-tooltip')).toBeVisible()
})

test('DOM chrome tooltip observes delay, Alt detail, and hover-out', async ({ page }) => {
  const settings = page.getByTestId('settings-button')
  await settings.hover()
  await expect(page.getByTestId('app-tooltip')).toHaveText('Settings', { timeout: 1_500 })
  await page.mouse.move(600, 400)
  await expect(page.getByTestId('app-tooltip')).toBeHidden()

  await page.keyboard.down('Alt')
  await settings.hover()
  await expect(page.getByTestId('app-tooltip')).toContainText('Ctrl+,', { timeout: 250 })
  await page.keyboard.up('Alt')
  await expect(page.getByTestId('app-tooltip')).not.toContainText('Ctrl+,')
})

test('node palette port product tooltip preserves hover and keyboard wording', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'UaTooltipProof', displayName: 'UA tooltip proof', category: 'test', source: 'v3', isOutputNode: false,
    items: [
      { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'STRING' }, optional: false, tooltip: 'Exact input tooltip wording.' },
      { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'STRING' }, tooltip: 'Exact output tooltip wording.' },
    ],
  }]))
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.mouse.dblclick(700, 600)
  await page.getByTestId('palette-search').fill('UA tooltip proof')
  const type = page.getByTestId('preview-input').locator('.preview-port-type')
  const wording = await type.getAttribute('data-tooltip-label')
  expect(wording).toBe('STRING')
  await expect(type).not.toHaveAttribute('title')
  await type.hover()
  await expect(page.getByTestId('app-tooltip')).toHaveText(wording!, { timeout: 1_500 })
  await type.focus()
  await expect(page.getByTestId('app-tooltip')).toHaveText(wording!)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('shell and minimap seams use product tooltips without document writes', async ({ page }) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'shell-tooltip-fixture', schemaWire: 1 }, nodes: {},
  } }))
  await page.reload()
  await expect(page.getByTestId('left-panel-toggle')).toBeEnabled()
  await page.getByTestId('minimap-settings').click()
  const minimapToggle = page.getByTestId('minimap-marker-toggle')
  const shellToggle = page.getByTestId('left-panel-toggle')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  const proveTooltip = async (target: typeof shellToggle, wording: string) => {
    await page.getByTestId('graph-canvas').focus()
    await expect(target).not.toHaveAttribute('title')
    await expect(target).toHaveAttribute('data-tooltip-label', wording)
    await target.hover()
    await expect(page.getByTestId('app-tooltip')).toHaveText(wording, { timeout: 1_500 })
    await page.mouse.move(700, 500)
    await expect(page.getByTestId('app-tooltip')).toBeHidden()
    await target.focus()
    await expect(target).toBeFocused()
    await expect(page.getByTestId('app-tooltip')).toHaveText(wording)
    await page.keyboard.press('Tab')
  }

  await proveTooltip(
    shellToggle,
    'Toggle left panel',
  )
  await expect(shellToggle).toHaveAccessibleName('Toggle left panel')
  await expect(shellToggle).toHaveAttribute('aria-pressed', /true|false/)
  await proveTooltip(minimapToggle, 'Show bookmark numbers on the minimap')
  await expect(minimapToggle).toHaveAccessibleName('Bookmarks. Show bookmark numbers on the minimap')

  const checked = await minimapToggle.getAttribute('aria-checked')
  await minimapToggle.click()
  await expect(minimapToggle).toHaveAttribute('aria-checked', checked === 'true' ? 'false' : 'true')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('stateful control tooltip re-reads its label after the click toggles state', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const toggle = page.getByTestId('minimap-toggle')
  await expect(toggle).toHaveAttribute('data-tooltip-label', 'Hide minimap')
  await toggle.hover()
  await expect(page.getByTestId('app-tooltip')).toHaveText('Hide minimap', { timeout: 1_500 })
  await toggle.click()
  await expect(toggle).toHaveAttribute('data-tooltip-label', 'Show minimap')
  await expect(page.getByTestId('app-tooltip')).toHaveText('Show minimap')
})

test('canvas pin and widget tooltips use scene coordinates and hide on mouse-down', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const points = await page.evaluate(() => {
    const test = window.__dinksterTest!
    const renderer = test.renderer!
    const node = renderer.getScene().nodes.find((candidate) =>
      candidate.layout.pins.length > 0 && candidate.layout.rows.some((row) => row.kind === 'widget'))
    if (!node) throw new Error('fixture has no node with a pin and widget')
    const pin = node.layout.pins[0]! as any
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget')! as any
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const vp = renderer.getViewport()
    const pagePoint = (worldX: number, worldY: number) => ({
      x: rect.left + worldX * vp.scale + vp.x,
      y: rect.top + worldY * vp.scale + vp.y,
    })
    return {
      pin: pagePoint(node.x + (pin.direction === 'in' ? 0 : node.layout.width), node.y + pin.y),
      pinName: pin.label ?? pin.portId,
      pinType: pin.type.name ?? pin.type.kind,
      widget: pagePoint(node.x + node.layout.width / 2, node.y + row.y + row.height / 2),
    }
  })

  await page.mouse.move(points.pin.x, points.pin.y)
  const tooltip = page.getByTestId('app-tooltip')
  await expect(tooltip).toContainText(points.pinName, { timeout: 1_500 })
  await expect(tooltip).toContainText(points.pinType)

  await page.keyboard.down('Alt')
  await page.mouse.move(points.widget.x, points.widget.y)
  await expect(tooltip).toBeVisible({ timeout: 250 })
  await expect(tooltip).toContainText(/min:|max:|step:|sampling|seed|value/i)
  await page.mouse.down()
  await expect(tooltip).toBeHidden()
  await page.mouse.up()
  await page.keyboard.up('Alt')
})

test('mismatch noodle midpoint grab-dot tooltip shows the retained solver diagnostic', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const point = await page.evaluate(async () => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([
      {
        type: 'TooltipImage', displayName: 'Image source', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'IMAGE' } }],
      },
      {
        type: 'TooltipLatent', displayName: 'Latent sink', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'input', type: { kind: 'concrete', name: 'LATENT' }, optional: false }],
      },
    ])
    await test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'tooltip-mismatch', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        source: { id: 'source', type: 'TooltipImage', values: {} },
        target: { id: 'target', type: 'TooltipLatent', values: {} },
      }, links: {
        bad: { id: 'bad', from: { node: 'source', port: 'out' }, to: { node: 'target', port: 'input' } },
      }, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 80, y: 180 } },
        target: { position: { x: 520, y: 180 } },
      } } } },
    }, 'Tooltip mismatch')
    const renderer = test.renderer!
    const link = renderer.getScene().links.find((candidate) => candidate.id === 'bad')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const world = { x: (link.x1 + link.x2) / 2, y: (link.y1 + link.y2) / 2 }
    renderer.setViewport({ x: canvas.width / 2 - world.x, y: canvas.height / 2 - world.y, scale: 1 })
    return { x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 }
  })

  await page.mouse.move(point.x, point.y)
  const tooltip = page.getByTestId('app-tooltip')
  await expect(tooltip).toContainText('Type mismatch', { timeout: 1_500 })
  await expect(tooltip).toContainText('target.input: IMAGE cannot feed LATENT')
})
