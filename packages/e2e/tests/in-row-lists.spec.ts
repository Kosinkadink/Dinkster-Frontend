import { expect, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

async function rowPoint(page: Page, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'n1')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, inputId)
}

// Labels and values differ, so a test that stores a label instead of the
// option's value fails; "Portrait" appears twice with two values.
const STYLES = [
  { value: 'style-portrait-a', label: 'Portrait', info: 'sd15' },
  { value: 'style-landscape', label: 'Landscape' },
  { value: 'style-line', label: 'Line art' },
  { value: 'style-portrait-b', label: 'Portrait', info: 'sdxl' },
]
// Over the 300-entry render window, with numbers for values.
const MANY = Array.from({ length: 1000 }, (_, index) => ({ value: index * 10, label: `item ${index}` }))

async function openLists(page: Page, values: Record<string, unknown> = {}): Promise<void> {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'inrow-lists', schemaWire: 2, graphFeatures: ['decimalInt'] }, nodes: {},
  } }))
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await waitForWorkspaceReady(page)
  const close = page.locator('.template-gallery-close')
  if ((await close.count()) > 0 && (await close.first().isVisible())) await close.first().click()
  else await page.evaluate(() => (window.__dinksterTest!.app as unknown as { templateGalleryOpen: { set(v: boolean): void } }).templateGalleryOpen.set(false))
  await page.evaluate(async ({ styles, many, values }) => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'Lists', displayName: 'Lists', category: 'test', source: 'v3', isOutputNode: false,
      body: [
        { ...widget('style', 'COMBO', 'style-landscape', { options: styles }), tooltip: 'The look to apply.' },
        widget('steps', 'INT', 20, { min: 1, max: 10000, step: 1 }),
        widget('enabled', 'BOOLEAN', true),
        widget('many', 'COMBO', 0, { options: many }),
        widget('sampler', 'COMBO', 'missing-default', { options: ['euler', 'dpmpp_2m'] }),
      ],
    }] as never)
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'inrow-lists', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n1: { id: 'n1', type: 'Lists', values: { style: 'style-portrait-a', steps: 20, enabled: true, many: 0, sampler: 'euler', ...values } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n1: { position: { x: 100, y: 100 } } } } } },
    } as never, 'Lists')
    window.__dinksterTest!.renderer!.setViewport({ x: 200, y: 150, scale: 1 })
  }, { styles: STYLES, many: MANY, values })
}

const value = (page: Page, key: string) => page.evaluate((key) => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values[key], key)
const canUndo = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.canUndo)
const undo = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
const filter = (page: Page) => page.locator('[data-editor-surface="in-row-list"] input')
const options = (page: Page) => page.locator('[data-editor-surface="in-row-list"] [role=option]')
const active = (page: Page) => page.locator('[data-editor-surface="in-row-list"] [role=option][data-active="true"]')
const openLabel = (page: Page) => page.locator('.widget-in-row-field input').getAttribute('aria-label')

test('a choice opens one list in its row; a pick stores the option value once and keeps the row', async ({ page }) => {
  await openLists(page)
  const style = await rowPoint(page, 'style')
  await page.mouse.click(style.x, style.y)
  await expect(filter(page)).toBeFocused()
  await expect(filter(page)).toHaveValue('')
  await expect(filter(page)).toHaveAttribute('role', 'combobox')
  // Opening stores nothing; the saved option is checked and highlighted.
  expect(await canUndo(page)).toBe(false)
  await expect(options(page)).toHaveCount(4)
  await expect(active(page)).toContainText('Portrait')
  await expect(active(page).locator('[aria-label=saved]')).toHaveCount(1)
  // The two Portraits are told apart by their information.
  await expect(options(page).nth(3)).toContainText('sdxl')
  await page.keyboard.type('LINE')
  await expect(options(page)).toHaveCount(1)
  await expect(active(page)).toContainText('Line art')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'style')).toBe('style-line')
  await expect(filter(page)).toHaveCount(0)
  await expect(page.getByTestId('row-focus')).toBeVisible()
  // One undo restores the old value.
  await undo(page)
  expect(await value(page, 'style')).toBe('style-portrait-a')
  expect(await canUndo(page)).toBe(false)
  // A click on the second Portrait stores its own value, not its label.
  await page.mouse.click(style.x, style.y)
  await options(page).nth(3).click()
  await expect.poll(() => value(page, 'style')).toBe('style-portrait-b')
  // One click on the number opens it.
  const steps = await rowPoint(page, 'steps')
  await page.mouse.click(steps.x, steps.y)
  await expect.poll(() => openLabel(page)).toBe('steps')
})

test('walking with Tab and Shift+Tab through an open list never changes the choice', async ({ page }) => {
  await openLists(page)
  const style = await rowPoint(page, 'style')
  await page.mouse.click(style.x, style.y)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(active(page)).toContainText('Line art')
  await page.keyboard.type('xyz')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('steps')
  await page.keyboard.press('Shift+Tab')
  await expect.poll(() => openLabel(page)).toBe('style')
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Tab')
  // From the first stop Shift+Tab wraps to the last row, the sampler choice.
  await expect.poll(() => openLabel(page)).toBe('sampler')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Tab')
  await expect.poll(() => openLabel(page)).toBe('style')
  await page.keyboard.press('Escape')
  expect(await value(page, 'style')).toBe('style-portrait-a')
  expect(await value(page, 'sampler')).toBe('euler')
  expect(await canUndo(page)).toBe(false)
})

test('a saved value missing from the options is kept and marked, never offered as an option', async ({ page }) => {
  await openLists(page, { style: 'style-retired' })
  const style = await rowPoint(page, 'style')
  await page.mouse.click(style.x, style.y)
  await expect(options(page)).toHaveCount(4)
  await expect(page.locator('[data-editor-surface="in-row-list"] [aria-label=saved]')).toHaveCount(0)
  await expect(page.locator('.widget-in-row-field .dinkster-canvas-side-problem')).toContainText('Not in the current list')
  await expect(page.locator('.widget-in-row-field .dinkster-canvas-side-facts')).toContainText('style-retired')
  // No saved entry is visible, so the first option is the candidate.
  await expect(active(page)).toContainText('Portrait')
  await page.keyboard.press('Escape')
  expect(await value(page, 'style')).toBe('style-retired')
})

test('Escape, Ctrl+Enter and composition never pick the highlight', async ({ page }) => {
  await openLists(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { queue: (tab: unknown) => Promise<void> }
    app.queue = async () => { (window as unknown as { queued?: unknown }).queued = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.values.style }
  })
  const style = await rowPoint(page, 'style')
  await page.mouse.click(style.x, style.y)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  await expect(filter(page)).toHaveCount(0)
  await expect(page.getByTestId('row-focus')).toBeVisible()
  expect(await value(page, 'style')).toBe('style-portrait-a')
  await page.mouse.click(style.x, style.y)
  await page.keyboard.press('ArrowDown')
  // An Enter that ends a composition picks nothing.
  await filter(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expect(filter(page)).toHaveCount(1)
  await page.keyboard.press('Control+Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { queued?: unknown }).queued)).toBe('style-portrait-a')
  await expect(filter(page)).toHaveCount(0)
  expect(await canUndo(page)).toBe(false)
})

test('a long list reaches its last entry past the render window and stores its exact value', async ({ page }) => {
  await openLists(page)
  const many = await rowPoint(page, 'many')
  await page.mouse.click(many.x, many.y)
  // Never more than the window is rendered; the rest is one press away.
  await expect(options(page).first()).toBeVisible()
  expect(await options(page).count()).toBeLessThanOrEqual(300)
  await page.keyboard.press('End')
  await expect(active(page)).toContainText('item 999')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'many')).toBe(9990)
  await page.mouse.click(many.x, many.y)
  await page.keyboard.type('item 99')
  // item 99 and item 990..999 match, in source order.
  await expect(options(page)).toHaveCount(11)
  await expect(options(page).first()).toContainText('item 99')
  // Clear filter, reached with Alt+Down, gives the keyboard back to the list.
  await page.keyboard.type('zzz')
  await expect(options(page)).toHaveCount(0)
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('Enter')
  await expect(filter(page)).toHaveValue('')
  await expect(active(page)).toContainText('item 999')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'many')).toBe(9980)
})

test('a pending pick blocks a second store and a refusal keeps the list open; the default link stores the declared default even when the list lacks it', async ({ page }) => {
  await openLists(page)
  // Hold the next store so its pending and refused states can be seen.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as Record<string, unknown> & { dispatchTo: (...args: unknown[]) => unknown }
    const state = window as unknown as { heldCalls: number; refuseHeld?: () => void }
    state.heldCalls = 0
    app.dispatchTo = () => {
      state.heldCalls += 1
      return new Promise((resolve) => { state.refuseHeld = () => resolve({ ok: false, diagnostics: [{ severity: 'error', message: 'Refused for this test' }] }) })
    }
  })
  const sampler = await rowPoint(page, 'sampler')
  await page.mouse.click(sampler.x, sampler.y)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-editor-surface="in-row-list"] [role=status]')).toContainText('Storing dpmpp_2m')
  // Nothing reaches a second store while the first is pending: not Enter, Tab or a click on another option.
  await page.keyboard.press('Enter')
  await page.keyboard.press('Tab')
  await options(page).first().dispatchEvent('click')
  expect(await page.evaluate(() => (window as unknown as { heldCalls: number }).heldCalls)).toBe(1)
  await page.evaluate(() => (window as unknown as { refuseHeld: () => void }).refuseHeld())
  await expect(page.locator('.widget-in-row-field .dinkster-canvas-side-problem')).toContainText('Refused for this test')
  await expect(filter(page)).toHaveCount(1)
  expect(await value(page, 'sampler')).toBe('euler')
  expect(await canUndo(page)).toBe(false)
  await page.evaluate(() => { delete (window.__dinksterTest!.app as unknown as Record<string, unknown>).dispatchTo })
  // Alt+Down reaches the default link; Enter stores the declared default although no option holds it.
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.widget-in-row-field .dinkster-canvas-side-link[data-focused="true"]')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect.poll(() => value(page, 'sampler')).toBe('missing-default')
  await expect(filter(page)).toHaveCount(0)
  await page.mouse.click(sampler.x, sampler.y)
  await expect(page.locator('.widget-in-row-field .dinkster-canvas-side-problem')).toContainText('Not in the current list')
  await expect(options(page)).toHaveCount(2)
})
