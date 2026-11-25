import { expect, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'


async function rowPoint(page: Page, nodeId: string, inputId: string, at = 0.5): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId, at }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width * at) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, inputId, at })
}

async function openSampler(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'inrow-fixture', schemaWire: 1, graphFeatures: ['decimalInt'] }, nodes: {},
  } }))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForWorkspaceReady(page)
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible())) await close.first().click()
  else await page.evaluate(() => (window.__dinksterTest!.app as unknown as { templateGalleryOpen: { set(v: boolean): void } }).templateGalleryOpen.set(false))
  await page.evaluate(async () => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'Sampler', displayName: 'Sampler', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        widget('steps', 'INT', 20, { min: 1, max: 10000, step: 1, tooltip: 'How many denoising steps to run.' }),
        widget('cfg', 'FLOAT', 7, { min: 0, max: 100, step: 0.1 }),
        widget('prefix', 'STRING', 'Dinkster'),
        widget('denoise', 'FLOAT', 1, { min: 0, max: 1, step: 0.01, display: 'slider' }),
        { ...widget('seed', 'INT', 42, { min: 0, max: 9007199254740991, step: 1 }), widget: { widgetType: 'INT', options: { min: 0, max: 9007199254740991, step: 1 }, default: 42, controller: 'after_generate', controllerInitial: 'randomize' } },
        widget('notes', 'STRING', 'first', { multiline: true }),
      ],
    }] as never)
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'inrow', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n1: { id: 'n1', type: 'Sampler', values: { steps: 20, cfg: 7, prefix: 'Dinkster', denoise: 0.5, seed: 1234, notes: 'first' }, controllers: { seed: 'increment' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n1: { position: { x: 100, y: 100 } } } } } },
    } as never, 'Sampler')
    window.__dinksterTest!.renderer!.setViewport({ x: 200, y: 150, scale: 1 })
  })
}

const value = (page: Page, key: string) => page.evaluate((key) => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values[key], key)
const openLabel = (page: Page) => page.locator('.widget-in-row-field input').getAttribute('aria-label')
const field = (page: Page) => page.locator('.widget-in-row-field input')

test('a click on each other row stores the open field and opens that row', async ({ page }) => {
  await openSampler(page)
  const rows: readonly [string, string, unknown][] = [
    ['steps', '30', 30],
    ['cfg', '8.5', 8.5],
    ['prefix', 'shot', 'shot'],
    ['denoise', '0.4', 0.4],
    ['seed', '77', 77],
  ]
  let point = await rowPoint(page, 'n1', 'steps')
  await page.mouse.click(point.x, point.y)
  for (const [index, [key, typed, stored]] of rows.entries()) {
    await expect.poll(() => openLabel(page)).toBe(key)
    await page.keyboard.press('Control+a')
    await page.keyboard.type(typed)
    const next = rows[index + 1]?.[0] ?? 'notes'
    point = await rowPoint(page, 'n1', next)
    await page.mouse.click(point.x, point.y)
    await expect.poll(() => value(page, key)).toBe(stored)
  }
  await expect(page.locator('[data-editor-surface="in-node"] textarea')).toBeFocused()
  await expect(field(page)).toHaveCount(0)
})

test('past a limit the side part says what Enter stores; the field follows the canvas and flips its side part at the right edge', async ({ page }) => {
  await openSampler(page)
  const steps = await rowPoint(page, 'n1', 'steps')
  await page.mouse.click(steps.x, steps.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('20000')
  await expect(page.locator('.widget-in-row-field .dinkster-canvas-side-problem')).toContainText('10000')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'steps')).toBe(10000)
  await expect(field(page)).toHaveCount(0)
  // Pan and zoom with the field open: it stays on its row.
  await page.mouse.click(steps.x, steps.y)
  // Zoomed in, the field scales with the canvas and stays centered on its
  // row; zoomed out, it keeps its normal size from the row's top left.
  for (const viewport of [{ x: 260, y: 180, scale: 1.5 }, { x: 120, y: 90, scale: 0.75 }]) {
    await page.evaluate((next) => window.__dinksterTest!.renderer!.setViewport(next), viewport)
    const row = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((item) => item.id === 'n1')!
      const steps = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'steps')! as
        { y: number; height: number; inset: number; width?: number }
      const inset = (renderer as unknown as { getDesignTokens(): { rowGeometry: { fieldInsetY: number } } })
        .getDesignTokens().rowGeometry.fieldInsetY
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const { x, y, scale } = renderer.getViewport()
      const width = steps.width ?? node.layout.width - steps.inset * 2
      // The canvas is drawn on whole pixels from its rounded page position,
      // so its row is there, not at the element's fractional position.
      return {
        left: Math.round(rect.left) + (node.x + steps.inset) * scale + x,
        top: Math.round(rect.top) + (node.y + steps.y + inset) * scale + y,
        width: width * scale,
        height: (steps.height - inset * 2) * scale,
      }
    })
    await expect.poll(async () => {
      const box = (await page.locator('.widget-in-row-field .dinkster-canvas-field-row').boundingBox())!
      return viewport.scale > 1
        ? Math.abs(box.x + box.width / 2 - (row.left + row.width / 2)) <= 0.25 &&
          Math.abs(box.y + box.height / 2 - (row.top + row.height / 2)) <= 0.25
        : Math.abs(box.x + 1 - row.left) <= 0.5 && Math.abs(box.y + 1 - row.top) <= 0.5
    }).toBe(true)
  }
  await expect(field(page)).toBeFocused()
  await page.keyboard.press('Escape')
  // Against the right edge of the canvas the side part opens on the left.
  const width = await page.evaluate(() => document.querySelector('[data-testid=graph-canvas]')!.clientWidth)
  await page.evaluate((w) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n1')!
    window.__dinksterTest!.renderer!.setViewport({ x: w - node.x - node.layout.width - 4, y: 150, scale: 1 })
  }, width)
  const edge = await rowPoint(page, 'n1', 'steps')
  await page.mouse.click(edge.x, edge.y)
  await expect(page.getByTestId('canvas-row-field')).toHaveAttribute('data-place', 'left')
})

test('Tab stores and moves between field rows; Ctrl+Enter stores and runs', async ({ page }) => {
  await openSampler(page)
  const canUndo = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.canUndo)
  expect(await canUndo()).toBe(false)
  const steps = await rowPoint(page, 'n1', 'steps')
  // Criterion 4: Tab through every row without typing; nothing to undo.
  await page.mouse.click(steps.x, steps.y)
  expect(await openLabel(page)).toBe('steps')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('cfg')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('prefix')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('denoise')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('seed')
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-editor-surface="in-node"] textarea')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('steps')
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('[data-editor-surface="in-node"] textarea')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => openLabel(page)).toBe('seed')
  await page.keyboard.press('Escape')
  expect(await canUndo()).toBe(false)
  // Criterion 3: 6*8 then Tab stores 48 and opens the next row.
  await page.mouse.click(steps.x, steps.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('6*8')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('cfg')
  expect(await value(page, 'steps')).toBe(48)
  // Text: Tab stores the typed text.
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('prefix')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('shot')
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => openLabel(page)).toBe('cfg')
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => openLabel(page)).toBe('steps')
  expect(await value(page, 'prefix')).toBe('shot')
  // Criterion 10: Ctrl+Enter stores, then queues.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { queue: (tab: unknown) => Promise<void> }
    ;(window as unknown as { queuedSteps?: unknown }).queuedSteps = 'not run'
    app.queue = async () => { (window as unknown as { queuedSteps?: unknown }).queuedSteps = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.steps }
  })
  await page.keyboard.press('Control+a')
  await page.keyboard.type('12')
  await page.keyboard.press('Control+Enter')
  await expect(page.locator('.widget-in-row-field input')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as { queuedSteps?: unknown }).queuedSteps)).toBe(12)
})

test('a draft survives a document change such as a finishing run', async ({ page }) => {
  await openSampler(page)
  const steps = await rowPoint(page, 'n1', 'steps')
  await page.mouse.click(steps.x, steps.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('33')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'cfg', value: 9 } })
  })
  await expect.poll(() => value(page, 'cfg')).toBe(9)
  await expect(page.getByRole('textbox', { name: 'steps', exact: true })).toHaveValue('33')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'steps')).toBe(33)
  // Its own value changed by something else closes the field.
  await page.mouse.click(steps.x, steps.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('44')
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'steps', value: 55 } })
  })
  await expect(page.getByRole('textbox', { name: 'steps', exact: true })).toHaveCount(0)
  expect(await value(page, 'steps')).toBe(55)
})

test('slider: a drag puts the value under the pointer; Escape in the open field keeps it', async ({ page }) => {
  await openSampler(page)
  const at = (fraction: number) => rowPoint(page, 'n1', 'denoise', fraction)
  // The row spans the node minus its insets; aim inside it.
  const left = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n1')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'denoise')! as { inset: number; width?: number }
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    const width = row.width ?? node.layout.width - row.inset * 2
    return { x: rect.left + (node.x + row.inset) * viewport.scale + viewport.x, width: width * viewport.scale }
  })
  const mid = await at(0.5)
  await page.mouse.move(mid.x, mid.y)
  await page.mouse.down()
  await page.mouse.move(left.x + left.width * 0.8, mid.y, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => value(page, 'denoise')).toBe(0.8)
  await page.mouse.click(mid.x, mid.y)
  await expect(page.getByRole('textbox', { name: 'denoise', exact: true })).toBeVisible()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('0.25')
  await page.keyboard.press('Escape')
  expect(await value(page, 'denoise')).toBe(0.8)
})

test('seed: the mode box sets the after-run mode; new seed fills the field', async ({ page }) => {
  await openSampler(page)
  const controller = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.controllers?.seed)
  // A click on the right end of a closed seed row opens the field, not the old controller menu.
  const end = await rowPoint(page, 'n1', 'seed', 0.72)
  await page.mouse.click(end.x, end.y)
  await expect(page.getByRole('textbox', { name: 'seed', exact: true })).toBeVisible()
  await expect(page.getByRole('group', { name: 'After each run' })).toBeVisible()
  await page.getByRole('button', { name: 'fixed', exact: true }).click()
  await expect.poll(controller).toBe('fixed')
  await expect(page.getByRole('textbox', { name: 'seed', exact: true })).toBeFocused()
  await expect(page.getByRole('button', { name: 'fixed', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'new seed' }).click()
  const typed = await page.getByRole('textbox', { name: 'seed', exact: true }).inputValue()
  expect(typed).not.toBe('1234')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'seed')).toBe(Number(typed))
})

test('text keeps its suggestion list: first Tab picks, next Tab moves; Escape closes only the list', async ({ page }) => {
  await openSampler(page)
  await page.evaluate(() => {
    const registry = (window.__dinksterTest!.app as unknown as { textEditorExtensionRegistry: { register(extension: unknown): unknown } }).textEditorExtensionRegistry
    registry.register({
      id: 'test.inrow', supports: () => true,
      complete: (request: { text: string }) => request.text === 'sho'
        ? [{ id: 'one', label: 'shotgun', replacement: { start: 0, end: 3, text: 'shotgun' } }] : [],
    })
  })
  const prefix = await rowPoint(page, 'n1', 'prefix')
  await page.mouse.click(prefix.x, prefix.y)
  const field = page.getByRole('textbox', { name: 'prefix', exact: true })
  await page.keyboard.press('Control+a')
  await page.keyboard.type('sho')
  await expect(page.getByTestId('suggestion-surface')).toBeVisible()
  await expect(field).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('suggestion-surface')).toHaveCount(0)
  await expect(field).toHaveValue('sho')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('o')
  await expect(page.getByTestId('suggestion-surface')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(field).toHaveValue('shotgun')
  await expect(page.getByTestId('suggestion-surface')).toHaveCount(0)
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('denoise')
  expect(await value(page, 'prefix')).toBe('shotgun')
})

test('line break, default link, and Tab brings a hidden row into view', async ({ page }) => {
  await openSampler(page)
  // The default link stores the default.
  const steps = await rowPoint(page, 'n1', 'steps')
  await page.mouse.click(steps.x, steps.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('48')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'steps')).toBe(48)
  await page.mouse.click(steps.x, steps.y)
  await page.locator('.dinkster-canvas-side-link', { hasText: '20' }).click()
  await expect.poll(() => value(page, 'steps')).toBe(20)
  await expect(page.locator('.widget-in-row-field input')).toHaveCount(0)
  // Text with a line break opens in the multiline editor.
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.dispatchTo(app.activeTab()!, { command: 'node.setValue', params: { graphId: 'g0', nodeId: 'n1', inputId: 'prefix', value: 'a\nb' } })
  })
  const prefix = await rowPoint(page, 'n1', 'prefix')
  await page.mouse.click(prefix.x, prefix.y)
  await expect(page.locator('[data-editor-surface="in-node"] textarea')).toBeVisible()
  await expect(page.locator('.widget-in-row-field input')).toHaveCount(0)
  await page.keyboard.press('Escape')
  // Tab onto a row below the canvas edge pans just enough.
  const canvasHeight = await page.evaluate(() => document.querySelector('[data-testid=graph-canvas]')!.clientHeight)
  await page.evaluate((h) => window.__dinksterTest!.renderer!.setViewport({ x: 200, y: h - 100 - 140, scale: 1 }), canvasHeight)
  const cfg = await rowPoint(page, 'n1', 'cfg')
  await page.mouse.click(cfg.x, cfg.y)
  await page.keyboard.press('Tab')
  await expect(page.locator('[data-editor-surface="in-node"] textarea')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('denoise')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('seed')
  const seedBottom = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n1')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'seed')!
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return (node.y + row.y + row.height) * viewport.scale + viewport.y
  })
  expect(seedBottom).toBeLessThanOrEqual(canvasHeight + 0.5)
  expect(seedBottom).toBeGreaterThan(canvasHeight - 2)
})

test('multiline box: Tab stores and moves on; Ctrl+Enter stores then runs', async ({ page }) => {
  await openSampler(page)
  const notes = await rowPoint(page, 'n1', 'notes')
  await page.mouse.click(notes.x, notes.y)
  const box = page.locator('[data-editor-surface="in-node"] textarea')
  await expect(box).toBeFocused()
  await page.keyboard.press('Control+a')
  await page.keyboard.type('second')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('steps')
  expect(await value(page, 'notes')).toBe('second')
  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { queue: (tab: unknown) => Promise<void> }
    app.queue = async () => { (window as unknown as { queuedNotes?: unknown }).queuedNotes = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.notes }
  })
  await page.mouse.click(notes.x, notes.y)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('third')
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { queuedNotes?: unknown }).queuedNotes)).toBe('third')
})

async function openMixed(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'inrow-mixed', schemaWire: 1, graphFeatures: ['decimalInt'] }, nodes: {},
  } }))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForWorkspaceReady(page)
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible())) await close.first().click()
  await page.evaluate(async () => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'Mixed', displayName: 'Mixed', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { ...widget('steps', 'INT', 20, { min: 1, max: 10000, step: 1 }), tooltip: 'How many denoising steps to run.' },
        { ...widget('enabled', 'BOOLEAN', true), tooltip: 'Turn the pass on or off.' },
        widget('sampler', 'COMBO', 'euler', { options: ['euler', 'dpmpp_2m', 'uni_pc'] }),
        widget('prefix', 'STRING', 'Dinkster'),
      ],
    }] as never)
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'inrow-mixed', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n1: { id: 'n1', type: 'Mixed', values: { steps: 20, enabled: true, sampler: 'euler', prefix: 'Dinkster' } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n1: { position: { x: 100, y: 100 } } } } } },
    } as never, 'Mixed')
    window.__dinksterTest!.renderer!.setViewport({ x: 200, y: 150, scale: 1 })
  })
}

test('the keyboard on a row: toggle and choice stops, Enter and Escape keep the row', async ({ page }) => {
  await openMixed(page)
  const canUndo = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.canUndo)
  const focus = page.getByTestId('row-focus')
  const steps = await rowPoint(page, 'n1', 'steps')
  await page.mouse.click(steps.x, steps.y)
  // Criterion 4 over every kind of row: Tab all the way round, nothing to
  // undo. The toggle takes the focus; the choice opens its list.
  await page.keyboard.press('Tab')
  await expect(focus).toBeVisible()
  await expect(page.locator('.widget-in-row-field input')).toHaveCount(0)
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('sampler')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('prefix')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('steps')
  await page.keyboard.press('Escape')
  expect(await canUndo()).toBe(false)
  // Escape left the keyboard on steps; Enter opens it again.
  await expect(focus).toBeVisible()
  await page.keyboard.press('Enter')
  await expect.poll(() => openLabel(page)).toBe('steps')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('30')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'steps')).toBe(30)
  await expect(focus).toBeVisible()
  // Tab to the toggle; Space flips it and the focus stays.
  await page.keyboard.press('Tab')
  await page.keyboard.press(' ')
  await expect.poll(() => value(page, 'enabled')).toBe(false)
  await expect(focus).toBeVisible()
  // Tab to the choice opens its list; Escape closes it and keeps the row.
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('sampler')
  await expect(focus).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(focus).toBeVisible()
  expect(await value(page, 'sampler')).toBe('euler')
  // A second Escape gives the keyboard back to the canvas.
  await page.mouse.click(steps.x, steps.y)
  await page.keyboard.press('Escape')
  await expect(focus).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(focus).toHaveCount(0)
  // A click never leaves an outline: clicking the toggle flips it, no focus.
  const enabled = await rowPoint(page, 'n1', 'enabled')
  await page.mouse.click(enabled.x, enabled.y)
  await expect.poll(() => value(page, 'enabled')).toBe(true)
  await expect(focus).toHaveCount(0)
})
