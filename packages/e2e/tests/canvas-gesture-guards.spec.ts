/**
 * Canvas gesture guards: stray selected shell text must never
 * hijack a canvas drag as a native browser text drag. The guard clears a
 * non-collapsed selection living outside the canvas at canvas pointerdown,
 * refuses native dragstart from the canvas, and the canvas itself is not
 * text-selectable. Unit coverage pins the handler branches
 * (app/test/canvas-gesture-guards.dom.test.tsx); this proves the real
 * browser wiring: selection state + computed style + an actual page.mouse
 * canvas drag.
 */
import { expect, test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

const selectionState = (page: Page) =>
  page.evaluate(() => {
    const selection = document.getSelection()
    return { rangeCount: selection?.rangeCount ?? 0, collapsed: selection?.isCollapsed ?? true }
  })

test('a canvas drag clears stray shell text selection instead of dragging it', async ({ page }) => {
  // Select shell text outside the canvas the way a user accidentally would.
  await page.evaluate(() => {
    const target = document.querySelector('[data-testid=status-bar]')!
    const range = document.createRange()
    range.selectNodeContents(target)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
  })
  expect(await selectionState(page)).toEqual({ rangeCount: 1, collapsed: false })

  // The canvas never allows text selection (backstop for gesture-created
  // selections and native drag affordances).
  const userSelect = await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid=graph-canvas]')!
    return getComputedStyle(canvas).userSelect
  })
  expect(userSelect).toBe('none')

  // A real mouse drag on empty canvas (marquee gesture) proceeds as a canvas
  // gesture: the stray selection is cleared at pointerdown, not dragged.
  const box = (await page.getByTestId('graph-canvas').boundingBox())!
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 120, cy + 90, { steps: 6 })
  await page.mouse.up()

  const after = await selectionState(page)
  expect(after.collapsed).toBe(true)
})
