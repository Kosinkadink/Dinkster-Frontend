/**
 * Camera bookmarks (RTS-style numbered view shortcuts): Shift+digit saves the
 * current camera into a numbered slot, plain digit jumps back. Slots live in
 * document VIEW state (undoable, persisted) and never touch semantic graph
 * data. The minimap shows slot digits at their saved world positions, behind
 * a presentation-only toggle. Navigation-context validation (nested subgraph
 * occurrences, orphaned bookmarks) is unit-tested in the core package; this
 * verifies the live keyboard/camera/minimap wiring.
 */
import { expect, test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

const viewport = (page: Page) => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
const setViewport = (page: Page, vp: { x: number; y: number; scale: number }) =>
  page.evaluate((v) => window.__dinksterTest!.renderer!.setViewport(v), vp)
const bookmarks = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.view.bookmarks)
const minimapSnap = (page: Page) =>
  page.evaluate(() => document.querySelector<HTMLCanvasElement>('[data-testid=minimap]')!.toDataURL())

test('Shift+digit saves the camera, plain digit restores it; semantic graphs untouched', async ({
  page,
}) => {
  const graphsBefore = await page.evaluate(() =>
    JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc.graphs),
  )

  const saved = { x: -321, y: 87, scale: 1.25 }
  await setViewport(page, saved)
  const savedSize = await page.getByTestId('graph-canvas').evaluate((el) => ({
    width: el.clientWidth,
    height: el.clientHeight,
  }))
  await page.keyboard.press('Shift+Digit1')

  const bms = await bookmarks(page)
  expect(bms?.['1']).toBeDefined()
  expect(bms!['1']!.view).toEqual({
    x: -saved.x / saved.scale,
    y: -saved.y / saved.scale,
    width: savedSize.width / saved.scale,
    height: savedSize.height / saved.scale,
  })
  expect(bms!['1']!.instancePath).toEqual([])

  // Semantic graph data is byte-identical; only view state changed.
  expect(
    await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc.graphs)),
  ).toBe(graphsBefore)

  // Wander off, change aspect ratio, then jump back: the complete saved
  // world rectangle is centered and contained in the current canvas.
  await setViewport(page, { x: 1000, y: -500, scale: 0.4 })
  await page.setViewportSize({ width: 900, height: 1200 })
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await page.keyboard.press('Digit1')
  await expect.poll(async () => {
    const current = await viewport(page)
    const size = await page.getByTestId('graph-canvas').evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }))
    const view = bms!['1']!.view!
    const corners = [
      [view.x, view.y],
      [view.x + view.width, view.y],
      [view.x, view.y + view.height],
      [view.x + view.width, view.y + view.height],
    ]
    const contained = corners.every(([x, y]) => {
      const cx = x! * current.scale + current.x
      const cy = y! * current.scale + current.y
      return cx >= -1e-6 && cx <= size.width + 1e-6 && cy >= -1e-6 && cy <= size.height + 1e-6
    })
    const centerX = (view.x + view.width / 2) * current.scale + current.x
    const centerY = (view.y + view.height / 2) * current.scale + current.y
    return contained && Math.abs(centerX - size.width / 2) < 1e-6 && Math.abs(centerY - size.height / 2) < 1e-6
  }).toBe(true)
  // Jumping is pure camera movement: no document revision.
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(
    revisionBefore,
  )
})

test('slot 0 maps to slot 10; saving is undoable; empty slots are inert', async ({ page }) => {
  const saved = { x: 50, y: 60, scale: 2 }
  await setViewport(page, saved)
  const size = await page.getByTestId('graph-canvas').evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }))
  await page.keyboard.press('Shift+Digit0')
  expect((await bookmarks(page))?.['10']?.view).toEqual({
    x: -saved.x / saved.scale,
    y: -saved.y / saved.scale,
    width: size.width / saved.scale,
    height: size.height / saved.scale,
  })

  // A plain digit with no bookmark does nothing (no throw, no camera move).
  await page.keyboard.press('Digit7')
  expect(await viewport(page)).toEqual(saved)

  // Saving went through the command pipeline: one undo removes the slot.
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())
  expect((await bookmarks(page))?.['10']).toBeUndefined()
})

test('minimap shows slot digits at saved cameras behind the marker toggle', async ({ page }) => {
  await setViewport(page, { x: 0, y: 0, scale: 1 })
  const before = await minimapSnap(page)
  await page.keyboard.press('Shift+Digit2')
  const withMarker = await minimapSnap(page)
  expect(withMarker).not.toBe(before) // the marker chip painted

  // Presentation-only toggle hides the digits and shows them again.
  await page.getByTestId('minimap-settings').click()
  const toggle = page.getByTestId('minimap-marker-toggle')
  await expect(toggle).toBeChecked()
  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  expect(await minimapSnap(page)).not.toBe(withMarker)
  await toggle.check()
  expect(await minimapSnap(page)).toBe(withMarker)
})

test('a same-lineage tab replacement does not inherit the save press: no phantom double-press delete', async ({ page }) => {
  // Tab ids are document lineages: opening a document with the SAME lineage
  // replaces the Tab object while reusing its id. Press memory is scoped to
  // the exact Tab object, so a quick Shift+1 before and after
  // the replacement is two FIRST presses (save twice), never a double press
  // (which would delete the replacement's bookmark). The replacement doc
  // ships with slot 1 pre-saved so delete-vs-save is observable.
  const openReplaceable = () =>
    page.evaluate(() => {
      const diagnostics = window.__dinksterTest!.app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'bookmark-replace', root: 'g0',
        graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
        view: {
          graphs: { g0: { nodes: {} } },
          bookmarks: { '1': { graphStack: ['g0'], instancePath: [], viewport: { x: 5, y: 6, scale: 1 } } },
        },
      }, 'Bookmark Replace')
      if (diagnostics.length > 0) throw new Error(`open failed: ${JSON.stringify(diagnostics)}`)
    })

  await openReplaceable() // tab instance one
  const started = Date.now()
  await page.keyboard.press('Shift+Digit1') // arms press memory on instance one
  await openReplaceable() // same lineage: same tab id, NEW Tab object
  await page.keyboard.press('Shift+Digit1') // must be a first press here
  const elapsed = Date.now() - started
  const bms = await bookmarks(page)
  // The hazard only exists inside the 500ms double-press window; if this
  // run was too slow to stay inside it, the assertion proves nothing -
  // fail loudly so the proof is never silently vacuous.
  expect(elapsed, 'press sequence must fit the 500ms double-press window').toBeLessThan(500)
  expect(bms?.['1']).toBeDefined()
})

test('digits typed into a text field never trigger bookmarks', async ({ page }) => {
  // The palette search input is a real text field over the canvas.
  await page.mouse.dblclick(700, 600)
  const search = page.getByTestId('palette-search')
  await expect(search).toBeVisible()
  await search.press('Shift+Digit3')
  await search.press('Digit3')
  expect((await bookmarks(page))?.['3']).toBeUndefined()
  await search.press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
})

test('shortcuts from a focused context menu never trigger bookmarks', async ({ page }) => {
  // The context menu owns keyboard focus (tabindex, no menu role): global
  // canvas shortcuts must abstain while the event target sits inside it,
  // under the same contract as text fields above.
  await page.mouse.click(700, 600, { button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await menu.press('Shift+Digit4')
  await menu.press('Digit4')
  expect((await bookmarks(page))?.['4']).toBeUndefined()
  await menu.press('Escape')
  await expect(menu).not.toBeVisible()
})
