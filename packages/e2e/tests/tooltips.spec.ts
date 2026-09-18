import { expect, openRailPanel, test } from './fixtures.js'

test.beforeEach(async ({ page }) => { await page.goto('/') })

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

test('DOM product tooltips appear immediately for keyboard focus', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const settings = page.getByTestId('settings-button')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await settings.focus()
  await expect(page.getByTestId('app-tooltip')).toHaveText('Settings')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('DOM tooltip hover and focus ownership compose without nested-control leakage', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.evaluate(() => {
    const target = document.createElement('div')
    target.dataset['testid'] = 'tooltip-ownership-target'
    target.dataset['tooltipLabel'] = 'Entry detail'
    target.tabIndex = 0
    target.style.cssText = 'position:fixed;left:500px;top:300px;width:120px;height:60px;z-index:100'
    const nested = document.createElement('button')
    nested.dataset['testid'] = 'tooltip-nested-button'
    nested.textContent = 'Nested action'
    target.append(nested)
    document.querySelector('.shell')!.append(target)
  })
  const target = page.getByTestId('tooltip-ownership-target')
  const nested = page.getByTestId('tooltip-nested-button')
  await target.focus()
  await expect(target).toBeFocused()
  await target.hover()
  await page.mouse.move(800, 500)
  await expect(target).toBeFocused()
  await expect(page.getByTestId('app-tooltip')).toHaveText('Entry detail')
  await target.hover()
  await nested.focus()
  await expect(page.getByTestId('app-tooltip')).toHaveText('Entry detail')
  await page.mouse.move(800, 500)
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await nested.focus()
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
})

test('runtime diagnostic code product tooltip preserves exact support wording', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const revision = await page.evaluate(() => {
    const code = document.createElement('span')
    code.className = 'runtime-error-hint-code'
    code.dataset['testid'] = 'runtime-hint-tooltip-proof'
    code.dataset['tooltipLabel'] = 'Diagnostic code: cuda-oom'
    code.setAttribute('aria-label', 'Diagnostic code: cuda-oom')
    code.tabIndex = 0
    code.textContent = '[cuda-oom]'
    document.querySelector('.shell')!.append(code)
    return window.__dinksterTest!.app.activeTab()!.store.revision
  })
  const code = page.getByTestId('runtime-hint-tooltip-proof')
  await expect(code).not.toHaveAttribute('title')
  await code.focus()
  await expect(page.getByTestId('app-tooltip')).toHaveText('Diagnostic code: cuda-oom')
  await page.mouse.move(800, 500)
  await expect(page.getByTestId('app-tooltip')).toHaveText('Diagnostic code: cuda-oom')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('node palette port product tooltip preserves hover and keyboard wording', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'UaTooltipProof', displayName: 'UA tooltip proof', category: 'test', source: 'v3', isOutputNode: false,
    items: [
      { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'core.string' }, optional: false, tooltip: 'Exact input tooltip wording.' },
      { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'core.string' }, tooltip: 'Exact output tooltip wording.' },
    ],
  }]))
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.mouse.dblclick(700, 600)
  await page.getByTestId('palette-search').fill('UA tooltip proof')
  const type = page.getByTestId('preview-input').locator('.preview-port-type')
  const wording = await type.getAttribute('data-tooltip-label')
  expect(wording).toBe('core.string')
  await expect(type).not.toHaveAttribute('title')
  await type.hover()
  await expect(page.getByTestId('app-tooltip')).toHaveText(wording!, { timeout: 1_500 })
  await type.focus()
  await expect(page.getByTestId('app-tooltip')).toHaveText(wording!)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
})

test('shell, surface, and minimap seams use product tooltips without document writes', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dinkster.settings', JSON.stringify({
    v: 1,
    values: { 'features.controlSurfaces.enabled': true },
  })))
  await page.reload()
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await openRailPanel(page, 'Control surfaces')
  await page.getByTestId('surface-add').click()
  const surface = page.locator('[data-testid^="surface-"]').filter({ has: page.locator('.surface-header') }).first()
  const surfaceRemove = surface.locator('[data-testid^="surface-remove-"]')
  await page.getByTestId('minimap-settings').click()
  const minimapToggle = page.getByTestId('minimap-marker-toggle')
  const shellToggle = page.getByTestId('review-upgrades-toggle')
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  const proveTooltip = async (target: typeof shellToggle, wording: string) => {
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
    'When on, deprecated nodes are never upgraded automatically on open - review each via its badge (debug aid).',
  )
  await expect(shellToggle).toHaveAccessibleName(/^Review upgrades: (on|off)\./)
  await expect(shellToggle).toHaveAttribute('aria-pressed', /true|false/)
  await proveTooltip(surfaceRemove, 'Delete surface')
  await expect(surfaceRemove).toHaveAccessibleName('Delete surface')
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

test('canvas pin and widget hover identities follow the pointer and clear on leave', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const points = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) =>
      candidate.layout.pins.some((pin) => (pin as any).widgetTap !== true) &&
      candidate.layout.rows.some((row) => row.kind === 'widget'))
    if (!node) throw new Error('fixture has no ordinary pin and widget row')
    const pin = node.layout.pins.find((candidate) => (candidate as any).widgetTap !== true)! as any
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget')! as any
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const vp = renderer.getViewport()
    const pagePoint = (worldX: number, worldY: number) => ({
      x: rect.left + worldX * vp.scale + vp.x,
      y: rect.top + worldY * vp.scale + vp.y,
    })
    return {
      pin: pagePoint(node.x + (pin.direction === 'in' ? 0 : node.layout.width), node.y + pin.y),
      pinIdentity: { nodeId: node.id, portId: pin.portId, direction: pin.direction },
      widget: pagePoint(node.x + node.layout.width / 2, node.y + row.y + row.height / 2),
      widgetIdentity: { nodeId: node.id, valueKey: row.valueKey },
      outside: { x: rect.right + 2, y: rect.bottom + 2 },
    }
  })

  await page.mouse.move(points.pin.x, points.pin.y)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().hoveredPin))
    .toEqual(points.pinIdentity)
  await page.mouse.move(points.widget.x, points.widget.y)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().hoveredWidget))
    .toEqual(points.widgetIdentity)
  await page.mouse.move(points.outside.x, points.outside.y)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().hoveredWidget))
    .toBeUndefined()
})

test('mismatch noodle midpoint grab-dot tooltip shows the retained solver diagnostic', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  const point = await page.evaluate(() => {
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
    test.app.openDocument({
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
  await expect(tooltip).toContainText(/output type 'IMAGE'.*input type 'LATENT'/)
})
