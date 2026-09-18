/**
 * DynamicCombo selector editing on a plain node (no boundary forwarding).
 *
 * The forwarded/boundary path is covered by boundary-conditional.spec.ts
 * and coexistence.spec.ts; this suite pins the DIRECT interaction the
 * audit matrix marked untested: clicking the selector row of an ordinary
 * node opens the production combo editor, switching dispatches
 * dynamic.selectOption (never node.setValue), the active branch's inputs
 * swap in the scene, branch-local widget values survive round trips, and
 * one undo restores the previous selection atomically.
 */
import { expect, test, type Page } from './fixtures.js'

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const problems = (page: Page) => page.getByTestId('problems-panel')

/** Widget/selector row ids currently laid out for the sizer node. */
const rowIds = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'sizer')!
    // The bridge types rows loosely (inputId optional on the union), so
    // filter to strings explicitly for a clean string[] return.
    return node.layout.rows
      .flatMap((row) => (row.kind === 'widget' ? [row.inputId] : []))
      .filter((id): id is string => typeof id === 'string')
  })

async function clickRow(page: Page, inputId: string): Promise<void> {
  const point = await page.evaluate((inputId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'sizer')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)
    if (!row) throw new Error(`no widget row '${inputId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, inputId)
  await page.mouse.click(point.x, point.y)
}

async function selectOption(page: Page, option: string): Promise<void> {
  await clickRow(page, 'size')
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toBeVisible()
  await dropdown.getByRole('option', { name: option, exact: true }).click()
}

const selectedOf = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => {
    const node = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.sizer as unknown as {
      dynamic?: Record<string, { selected?: string }>
    }
    return node.dynamic?.size?.selected
  })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const concrete = (name: string) => ({ kind: 'concrete', name })
    const widget = (id: string, widgetType: string, defaultValue: number) => ({
      kind: 'input', id, type: concrete(widgetType), optional: true,
      widget: { widgetType, options: {}, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'ComboNodeTest', displayName: 'Combo Node', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'size', type: concrete('STRING'), optional: true,
        dynamic: {
          kind: 'dynamicCombo', defaultOption: 'fit',
          options: [
            { key: 'fit', inputs: [widget('width', 'INT', 512)] },
            { key: 'crop', inputs: [widget('ratio', 'FLOAT', 1)] },
          ],
        },
      }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'dynamic-combo', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { sizer: { id: 'sizer', type: 'ComboNodeTest', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { sizer: { position: { x: 120, y: 120 } } } } } },
    }, 'Dynamic Combo')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
})

test('default branch renders only its own inputs; switching swaps them and stores the selection', async ({ page }) => {
  // Default 'fit': the selector row plus the fit branch's width, no ratio.
  let ids = await rowIds(page)
  expect(ids).toContain('size')
  expect(ids.some((id) => id.includes('width'))).toBe(true)
  expect(ids.some((id) => id.includes('ratio'))).toBe(false)

  await selectOption(page, 'crop')
  // The selection is dynamic state on the node, never a stored value.
  expect(await selectedOf(page)).toBe('crop')
  const doc = await activeDoc(page)
  expect(doc.graphs.g0!.nodes.sizer!.values.size).toBeUndefined()

  ids = await rowIds(page)
  expect(ids.some((id) => id.includes('ratio'))).toBe(true)
  expect(ids.some((id) => id.includes('width'))).toBe(false)
  await expect(problems(page)).not.toContainText(/constructUnsupported|not supported yet/)
})

test('branch-local widget values persist across selector round trips', async ({ page }) => {
  // Edit the fit branch's width through the real editor.
  const widthRow = (await rowIds(page)).find((id) => id.includes('width'))!
  await clickRow(page, widthRow)
  const int = page.getByTestId('widget-editor').locator('input')
  await int.fill('777'); await int.press('Enter')

  // Switch to crop and edit ratio.
  await selectOption(page, 'crop')
  const ratioRow = (await rowIds(page)).find((id) => id.includes('ratio'))!
  await clickRow(page, ratioRow)
  const float = page.getByTestId('widget-editor').locator('input')
  await float.fill('2.5'); await float.press('Enter')

  // Both branches' values coexist in node.values under their elaborated
  // keys - the inactive branch's value is dormant, not destroyed.
  const values = (await activeDoc(page)).graphs.g0!.nodes.sizer!.values
  expect(Object.values(values)).toContain(777)
  expect(Object.values(values)).toContain(2.5)

  // Round trip back to fit: width still displays its edited value.
  await selectOption(page, 'fit')
  const restored = (await activeDoc(page)).graphs.g0!.nodes.sizer!.values
  expect(Object.values(restored)).toContain(777)
  expect((await rowIds(page)).some((id) => id.includes('width'))).toBe(true)
})

test('one undo reverts a selector switch atomically', async ({ page }) => {
  await selectOption(page, 'crop')
  expect(await selectedOf(page)).toBe('crop')
  await page.keyboard.press('Control+z')
  // Selection AND the derived rows revert together in a single step.
  expect(await selectedOf(page)).not.toBe('crop')
  const ids = await rowIds(page)
  expect(ids.some((id) => id.includes('width'))).toBe(true)
  expect(ids.some((id) => id.includes('ratio'))).toBe(false)
})
