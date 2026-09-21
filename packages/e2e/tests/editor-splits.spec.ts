/**
 * Center-region editor splits (#165): multiple editor groups visible side by
 * side, driven by the pure split tree in editor-layout.ts. Client-only: the
 * spec changes persisted layout state but never submits work to the backend.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const capture = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_165'] !== '1') return
  await page.screenshot({ path: evidencePath('issue-165', `${name}.png`), animations: 'disabled' })
}

const groups = (page: Page): Locator => page.getByTestId('editor-group')

const groupById = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="editor-group"][data-group-id="${id}"]`)

const tabIn = (group: Locator, title: string): Locator =>
  group.locator('.tab', { has: group.page().locator('.tab-select', { hasText: title }) })

const stripTitles = (group: Locator): Promise<string[]> =>
  group.locator('.tab-select').allTextContents()

const laidOutBox = async (locator: Locator): Promise<NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>> => {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box!
}

const center = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = await laidOutBox(locator)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const activeTitle = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const id = app.activeTabId.get()
    return app.tabs.get().find((entry) => entry.id === id)?.title
  })

const contextMenuAction = async (group: Locator, title: string, itemId: string): Promise<void> => {
  const page = group.page()
  await tabIn(group, title).click({ button: 'right' })
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await menu.locator(`[data-item-id="${itemId}"]`).click()
  await expect(menu).toHaveCount(0)
}

/** Drag a tab from its strip to a client point, asserting the drop preview. */
const dragTabTo = async (
  page: Page,
  tab: Locator,
  to: { x: number; y: number },
): Promise<void> => {
  const from = await center(tab.locator('.tab-select'))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 4, from.y)
  await page.mouse.move(to.x, to.y, { steps: 5 })
  await expect(page.getByTestId('split-drop-preview')).toBeVisible()
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  await expect(groups(page)).toHaveCount(1)
})

test('split right renders two groups side by side; unsplit merges them back', async ({ page }) => {
  await contextMenuAction(groups(page), 'Subgraph', 'workflow.splitRight')

  await expect(groups(page)).toHaveCount(2)
  const first = groupById(page, 'group-1')
  const second = groupById(page, 'group-2')
  expect(await stripTitles(first)).toEqual(['Basic'])
  expect(await stripTitles(second)).toEqual(['Subgraph'])
  await expect(second).toHaveAttribute('data-focused', 'true')
  await expect(first).toHaveAttribute('data-focused', 'false')

  // Both panes render their editors simultaneously, side by side.
  await expect(first.locator('[role="tabpanel"]')).toBeVisible()
  await expect(second.locator('[role="tabpanel"]')).toBeVisible()
  const firstBox = (await first.boundingBox())!
  const secondBox = (await second.boundingBox())!
  expect(firstBox.x + firstBox.width).toBeLessThanOrEqual(secondBox.x)
  expect(Math.abs(firstBox.y - secondBox.y)).toBeLessThanOrEqual(1)

  const divider = page.getByTestId('editor-split-divider')
  await expect(divider).toHaveAttribute('role', 'separator')
  await expect(divider).toHaveAttribute('aria-orientation', 'vertical')
  await expect(divider).toHaveAttribute('aria-valuenow', '50')
  await capture(page, 'side-by-side-canvases')

  await contextMenuAction(second, 'Subgraph', 'workflow.unsplit')
  await expect(groups(page)).toHaveCount(1)
  expect(await stripTitles(groups(page))).toEqual(['Basic', 'Subgraph'])
  await expect(divider).toHaveCount(0)
})

test('divider drag and keyboard arrows change the split ratio', async ({ page }) => {
  await contextMenuAction(groups(page), 'Subgraph', 'workflow.splitRight')
  const divider = page.getByTestId('editor-split-divider')
  const start = await center(divider)
  const widthBefore = (await groupById(page, 'group-1').boundingBox())!.width

  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x - 200, start.y, { steps: 4 })
  // The preview restyles panes mid-gesture, before release commits.
  const mid = Number(await divider.getAttribute('aria-valuenow'))
  expect(mid).toBeLessThan(50)
  await capture(page, 'ratio-drag')
  await page.mouse.up()

  const committed = Number(await divider.getAttribute('aria-valuenow'))
  expect(committed).toBe(mid)
  const widthAfter = (await groupById(page, 'group-1').boundingBox())!.width
  expect(widthAfter).toBeLessThan(widthBefore - 100)

  await divider.focus()
  await page.keyboard.press('ArrowRight')
  await expect(divider).toHaveAttribute('aria-valuenow', String(committed + 2))
  await page.keyboard.press('ArrowLeft')
  await expect(divider).toHaveAttribute('aria-valuenow', String(committed))
})

test('dragging a tab moves it into a pane center or splits at a pane edge', async ({ page }) => {
  await contextMenuAction(groups(page), 'Subgraph', 'workflow.splitRight')
  await page.getByTestId('new-tab').click()
  const second = groupById(page, 'group-2')
  await expect.poll(() => stripTitles(second)).toEqual(['Subgraph', 'Untitled'])

  // Center drop moves the tab into the other group and focuses it.
  const first = groupById(page, 'group-1')
  await dragTabTo(page, tabIn(second, 'Untitled'), await center(first.locator('[role="tabpanel"]')))
  await expect.poll(() => stripTitles(first)).toEqual(['Basic', 'Untitled'])
  expect(await stripTitles(second)).toEqual(['Subgraph'])
  await expect(first).toHaveAttribute('data-focused', 'true')
  expect(await activeTitle(page)).toBe('Untitled')

  // Edge drop splits the pane, putting the tab in a new group.
  const firstPane = await laidOutBox(first.locator('[role="tabpanel"]'))
  await dragTabTo(page, tabIn(first, 'Untitled'), {
    x: firstPane.x + firstPane.width - 20,
    y: firstPane.y + firstPane.height / 2,
  })
  await expect(groups(page)).toHaveCount(3)
  const created = groupById(page, 'group-3')
  expect(await stripTitles(created)).toEqual(['Untitled'])
  await expect(created).toHaveAttribute('data-focused', 'true')
  expect(await stripTitles(first)).toEqual(['Basic'])
})

test('the split survives reload and repairs itself when a tab closes', async ({ page }) => {
  await contextMenuAction(groups(page), 'Subgraph', 'workflow.splitRight')
  const divider = page.getByTestId('editor-split-divider')
  const start = await center(divider)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x - 150, start.y, { steps: 4 })
  await page.mouse.up()
  const ratio = await divider.getAttribute('aria-valuenow')

  await page.reload()
  await expect(groups(page)).toHaveCount(2)
  expect(await stripTitles(groupById(page, 'group-1'))).toEqual(['Basic'])
  expect(await stripTitles(groupById(page, 'group-2'))).toEqual(['Subgraph'])
  await expect(groupById(page, 'group-2')).toHaveAttribute('data-focused', 'true')
  await expect(page.getByTestId('editor-split-divider')).toHaveAttribute('aria-valuenow', ratio ?? '')

  // Closing the second group's only tab needs no split-aware code: the
  // read-boundary repair prunes the emptied group and collapses the split.
  await tabIn(groupById(page, 'group-2'), 'Subgraph').click({ button: 'middle' })
  await page.getByRole('dialog', { name: 'Close "Subgraph" and discard unsaved changes?' })
    .getByRole('button', { name: 'Close and discard' }).click()
  await expect(groups(page)).toHaveCount(1)
  expect(await stripTitles(groups(page))).toEqual(['Basic'])
  await expect(page.getByTestId('editor-split-divider')).toHaveCount(0)
})

test('per-group activation moves focus and F6 cycles between groups', async ({ page }) => {
  await contextMenuAction(groups(page), 'Subgraph', 'workflow.splitRight')
  const first = groupById(page, 'group-1')
  const second = groupById(page, 'group-2')
  await expect(second).toHaveAttribute('data-focused', 'true')
  expect(await activeTitle(page)).toBe('Subgraph')

  // Activating a tab in the other group moves focus and the global active tab.
  await tabIn(first, 'Basic').locator('.tab-select').click()
  await expect(first).toHaveAttribute('data-focused', 'true')
  await expect(second).toHaveAttribute('data-focused', 'false')
  expect(await activeTitle(page)).toBe('Basic')

  await page.keyboard.press('F6')
  await expect(second).toHaveAttribute('data-focused', 'true')
  expect(await activeTitle(page)).toBe('Subgraph')
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('editor-panel-group-2')

  await page.keyboard.press('Shift+F6')
  await expect(first).toHaveAttribute('data-focused', 'true')
  expect(await activeTitle(page)).toBe('Basic')
})

test('the legacy canvas test bridge follows the focused editor group', async ({ page }) => {
  await contextMenuAction(groups(page), 'Subgraph', 'workflow.splitRight')
  const first = groupById(page, 'group-1')
  const second = groupById(page, 'group-2')

  await expect(second).toHaveAttribute('data-focused', 'true')
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 222, y: 22, scale: 1 }))

  await tabIn(first, 'Basic').locator('.tab-select').click()
  await expect(first).toHaveAttribute('data-focused', 'true')
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 111, y: 11, scale: 1 }))

  await tabIn(second, 'Subgraph').locator('.tab-select').click()
  await expect(second).toHaveAttribute('data-focused', 'true')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport()))
    .toEqual({ x: 222, y: 22, scale: 1 })
})

test('a narrow App View pane renders mobile while its wide sibling stays desktop', async ({ page }) => {
  // Wide enough that a 50/50 split leaves both panes above the App View
  // mobile breakpoint even with the sidebar and right rail visible.
  await page.setViewportSize({ width: 1800, height: 800 })
  await contextMenuAction(groups(page), 'Subgraph', 'workflow.splitRight')
  const first = groupById(page, 'group-1')
  const second = groupById(page, 'group-2')

  for (const group of [second, first]) {
    await group.getByTestId('views-switcher').click()
    await page.getByRole('menuitemradio', { name: 'App view' }).click()
  }
  await expect(first.locator('[data-app-breakpoint]')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await expect(second.locator('[data-app-breakpoint]')).toHaveAttribute('data-app-breakpoint', 'desktop')

  // Narrow the first pane below the App View mobile breakpoint (640px).
  const divider = page.getByTestId('editor-split-divider')
  const start = await center(divider)
  const region = (await page.getByTestId('editor-split-region').boundingBox())!
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(region.x + 420, start.y, { steps: 4 })
  await page.mouse.up()

  expect((await first.boundingBox())!.width).toBeLessThan(640)
  expect((await second.boundingBox())!.width).toBeGreaterThanOrEqual(640)
  await expect(first.locator('[data-app-breakpoint]')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await expect(second.locator('[data-app-breakpoint]')).toHaveAttribute('data-app-breakpoint', 'desktop')
  await capture(page, 'app-view-mobile-next-to-desktop')
})
