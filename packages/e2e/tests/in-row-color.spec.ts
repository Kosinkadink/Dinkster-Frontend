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

/**
 * A Paint node with a color, a color with opacity, an integer color and a
 * number, and a second Paint node whose colors feed the swatches.
 */
async function openPaint(page: Page): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'color-fixture', schemaWire: 1 }, nodes: {},
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
      type: 'Paint', displayName: 'Paint', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        widget('fill', 'COLOR', '#336699', { tooltip: 'The fill color.' }),
        widget('tint', 'COLOR', '#ffffff', { alpha: true }),
        widget('code', 'INT', 0, { min: 0, max: 16777215, step: 1, display: 'color' }),
        widget('size', 'INT', 8, { min: 1, max: 64, step: 1 }),
      ],
    }] as never)
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'color', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n1: { id: 'n1', type: 'Paint', values: { fill: '#336699', tint: '#ff000080', code: 66051, size: 8 } },
        n2: { id: 'n2', type: 'Paint', values: { fill: '#cc3300', tint: '#cc3300', code: 0x00ff00, size: 8 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: { n1: { position: { x: 100, y: 100 } }, n2: { position: { x: 100, y: 420 } } } } } },
    } as never, 'Paint')
    window.__dinksterTest!.renderer!.setViewport({ x: 200, y: 50, scale: 1 })
  })
}

const value = (page: Page, key: string) => page.evaluate((key) => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values[key], key)
const revision = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
const editor = (page: Page) => page.locator('.widget-in-row-field')
const field = (page: Page) => page.locator('.widget-in-row-field input')
const side = (page: Page) => page.locator('.widget-in-row-field .dinkster-canvas-field-side')

async function open(page: Page, key: string): Promise<void> {
  const point = await rowPoint(page, 'n1', key)
  await page.mouse.click(point.x, point.y)
  await expect(field(page)).toBeFocused()
}

test('typed colors: the code is selected, half-typed text holds the last color, Enter stores a normalized code as one undo step', async ({ page }) => {
  await openPaint(page)
  await open(page, 'fill')
  await expect(field(page)).toHaveValue('#336699')
  expect(await field(page).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 7])
  // The picker hangs under the field with its handles inside each control.
  await expect(page.getByTestId('color-picker-square')).toBeVisible()
  await expect(page.getByTestId('color-picker-opacity')).toHaveCount(0)
  for (const control of ['color-picker-square', 'color-picker-hue']) {
    const inside = await page.getByTestId(control).evaluate((element) => {
      const box = element.getBoundingClientRect()
      const handle = element.querySelector('.dinkster-canvas-color-handle')!.getBoundingClientRect()
      return handle.left >= box.left && handle.right <= box.right && handle.top >= box.top && handle.bottom <= box.bottom
    })
    expect(inside, control).toBe(true)
  }
  // Text that is not a color keeps the last valid color in the preview, and
  // leaving keeps the stored color.
  await page.keyboard.type('#12')
  await expect(side(page)).toContainText('Not a color.')
  await expect(side(page)).toContainText('Preview holds #336699')
  await expect(field(page)).toHaveAttribute('aria-invalid', 'true')
  const before = await revision(page)
  await page.keyboard.press('Enter')
  await expect(field(page)).toHaveCount(0)
  expect(await value(page, 'fill')).toBe('#336699')
  expect(await revision(page)).toBe(before)
  // A CSS name is stored as its code; one undo restores the color.
  await open(page, 'fill')
  // The saved color is listed beside the field only once the draft differs from it.
  await expect(side(page)).not.toContainText('saved')
  await page.keyboard.type('Tomato')
  await expect(side(page)).toContainText('Enter stores #ff6347')
  await expect(side(page)).toContainText(/saved\s*#336699/)
  // The saved color is a link that puts it back in the field, storing nothing.
  const kept = await revision(page)
  await page.locator('[data-color-link="saved"] .dinkster-canvas-side-link').click()
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue('#336699')
  await expect(side(page)).not.toContainText('saved')
  expect(await revision(page)).toBe(kept)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('Tomato')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'fill')).toBe('#ff6347')
  await expect(field(page)).toHaveCount(0)
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect(await value(page, 'fill')).toBe('#336699')
  // Another spelling of the stored color writes nothing.
  await open(page, 'fill')
  await page.keyboard.type('rgb(51, 102, 153)')
  await expect(side(page)).toContainText('Enter keeps #336699')
  const unchanged = await revision(page)
  await page.keyboard.press('Enter')
  await expect(field(page)).toHaveCount(0)
  expect(await revision(page)).toBe(unchanged)
})

test('picker and swatches change only the draft; Escape keeps the stored color, a press elsewhere stores it', async ({ page }) => {
  await openPaint(page)
  await open(page, 'fill')
  // A drag past the square's top right corner keeps the hue at full
  // saturation and value: #336699 is at 210 degrees.
  const square = (await page.getByTestId('color-picker-square').boundingBox())!
  await page.mouse.move(square.x + square.width / 2, square.y + square.height / 2)
  await page.mouse.down()
  await page.mouse.move(square.x + square.width + 30, square.y - 30)
  await page.mouse.up()
  await expect(field(page)).toHaveValue('#0080ff')
  await expect(field(page)).toBeFocused()
  expect(await value(page, 'fill')).toBe('#336699')
  await page.keyboard.press('Escape')
  await expect(field(page)).toHaveCount(0)
  expect(await value(page, 'fill')).toBe('#336699')
  // The swatches: the default first, then the workflow's colors, most used
  // first and ties in code order; tint's #ff000080 counts as #ff0000.
  await open(page, 'fill')
  const swatches = page.getByTestId('color-picker-swatches').getByRole('option')
  expect(await swatches.evaluateAll((options) => options.map((option) => option.getAttribute('aria-label'))))
    .toEqual(['#336699, default', '#cc3300', '#00ff00', '#010203', '#ff0000'])
  await swatches.nth(1).click()
  await expect(field(page)).toHaveValue('#cc3300')
  expect(await value(page, 'fill')).toBe('#336699')
  // A press on the canvas stores the draft.
  await page.mouse.click(1000, 700)
  await expect.poll(() => value(page, 'fill')).toBe('#cc3300')
  await expect(field(page)).toHaveCount(0)
})

test('the keyboard: Alt+Down walks the picker, Enter returns to the text, Tab stores and moves, Ctrl+Enter stores and runs', async ({ page }) => {
  await openPaint(page)
  await open(page, 'fill')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByTestId('color-picker-square')).toBeFocused()
  await expect(side(page)).toContainText('Arrows change the square.')
  await page.keyboard.press('Shift+ArrowLeft')
  await expect(field(page)).not.toHaveValue('#336699')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByTestId('color-picker-hue')).toBeFocused()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.getByTestId('color-picker-swatches')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Enter')
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue('#cc3300')
  // Alt+Up from the text reaches the default link, then the saved color's
  // link above it; the default link fills the field.
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.locator('[data-color-link="default"] .dinkster-canvas-side-link')).toBeFocused()
  await page.keyboard.press('Alt+ArrowUp')
  await expect(page.locator('[data-color-link="saved"] .dinkster-canvas-side-link')).toBeFocused()
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('[data-color-link="default"] .dinkster-canvas-side-link')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(field(page)).toBeFocused()
  await expect(field(page)).toHaveValue('#336699')
  await page.keyboard.press('Control+a')
  await page.keyboard.type('#abcdef')
  await page.keyboard.press('Tab')
  await expect.poll(() => field(page).getAttribute('aria-label')).toBe('tint')
  expect(await value(page, 'fill')).toBe('#abcdef')
  // A key pressed while composing is the input method's.
  await field(page).evaluate((input: HTMLInputElement) => {
    input.value = '#00ff00'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }))
  })
  await expect(field(page)).toBeFocused()
  expect(await value(page, 'tint')).toBe('#ff000080')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { queue: (tab: unknown) => Promise<void> }
    ;(window as unknown as { queuedTint?: unknown }).queuedTint = 'not run'
    app.queue = async () => { (window as unknown as { queuedTint?: unknown }).queuedTint = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.tint }
  })
  await page.keyboard.press('Control+Enter')
  await expect(field(page)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as { queuedTint?: unknown }).queuedTint)).toBe('#00ff00')
})

test('opacity: a field that declares it keeps it, another drops it with a note; an integer color has no steppers and stores a whole number', async ({ page }) => {
  await openPaint(page)
  await open(page, 'tint')
  await expect(page.getByTestId('color-picker-opacity')).toBeVisible()
  await expect(page.getByTestId('color-picker-opacity')).toHaveAttribute('aria-valuenow', '50')
  await page.keyboard.type('rgba(0, 0, 255, 0.25)')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'tint')).toBe('#0000ff40')
  await open(page, 'fill')
  await page.keyboard.type('#11223344')
  await expect(side(page)).toContainText('This field does not use opacity.')
  await expect(side(page)).toContainText('Enter stores #112233')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'fill')).toBe('#112233')
  // An integer color has no steppers: a click where a number's minus would
  // be opens the color field and changes nothing.
  const edge = await rowPoint(page, 'n1', 'code', 0.1)
  await page.mouse.click(edge.x, edge.y)
  await expect(field(page)).toBeFocused()
  expect(await value(page, 'code')).toBe(66051)
  await expect(field(page)).toHaveValue('#010203')
  await expect(page.getByTestId('color-picker-opacity')).toHaveCount(0)
  await page.keyboard.type('#ab1203')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'code')).toBe(0xab1203)
  await expect(editor(page)).toHaveCount(0)
})

test('a wired color whose opacity the field drops: the row paints the color used, and a click explains it without opening a field', async ({ page }) => {
  await openPaint(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'ColorSource', displayName: 'Color source', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'source', type: { kind: 'concrete', name: 'COLOR' }, optional: false, widget: { widgetType: 'COLOR', options: {}, default: '#000000' } },
        { kind: 'output', id: 'color', type: { kind: 'concrete', name: 'COLOR' }, knownValue: { input: 'source' } },
      ],
    }] as never)
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'wired-color', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        src: { id: 'src', type: 'ColorSource', values: { source: '#3366cc80' } },
        n1: { id: 'n1', type: 'Paint', values: { fill: '#000000', tint: '#000000', code: 0, size: 8 } },
      }, links: {
        l1: { id: 'l1', from: { node: 'src', port: 'color' }, to: { node: 'n1', port: 'fill' } },
        l2: { id: 'l2', from: { node: 'src', port: 'color' }, to: { node: 'n1', port: 'tint' } },
      }, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: { src: { position: { x: -200, y: 100 } }, n1: { position: { x: 100, y: 100 } } } } } },
    } as never, 'Wired color')
    window.__dinksterTest!.renderer!.setViewport({ x: 300, y: 50, scale: 1 })
  })
  const companions = () => page.evaluate(() =>
    structuredClone((window.__dinksterTest!.renderer as unknown as { companions: Record<string, Record<string, { value: unknown }>> }).companions['n1']))
  // The field without opacity paints #3366cc; the field with opacity paints what arrives.
  await expect.poll(async () => [(await companions())?.['fill']?.value, (await companions())?.['tint']?.value]).toEqual(['#3366cc', '#3366cc80'])
  const note = page.getByTestId('row-focus')
  const fill = await rowPoint(page, 'n1', 'fill')
  await page.mouse.click(fill.x, fill.y)
  await expect(note).toContainText('The wire brings #3366cc80.')
  await expect(note).toContainText('This field does not use opacity, so #3366cc is used.')
  await expect(note.locator('[data-testid="canvas-row-focus"]')).toHaveAttribute('data-neutral', 'true')
  await expect(field(page)).toHaveCount(0)
  // Enter does not open the wired row; Escape closes the note.
  await page.keyboard.press('Enter')
  await expect(field(page)).toHaveCount(0)
  await expect(note).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)
  // A second click on the row closes the note it opened.
  await page.mouse.click(fill.x, fill.y)
  await expect(note).toBeVisible()
  await page.mouse.click(fill.x, fill.y)
  await expect(note).toHaveCount(0)
  // A wired color with nothing to say opens nothing.
  const tint = await rowPoint(page, 'n1', 'tint')
  await page.mouse.click(tint.x, tint.y)
  await expect(note).toHaveCount(0)
  await expect(field(page)).toHaveCount(0)
  expect(await value(page, 'fill')).toBe('#000000')
})
