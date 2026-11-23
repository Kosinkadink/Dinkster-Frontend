/**
 * Shell tabs and explicit region controls. This spec is intentionally
 * client-only: it changes persisted shell/tab view state but never submits
 * work to the shared backend.
 */
import type { Locator, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { expect, appViewTest as test, waitForWorkspaceReady } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const captureDragGhost = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_170'] !== '1') return
  await page.screenshot({ path: evidencePath('issue-170', `${name}.png`), animations: 'disabled' })
}

const tab = (page: Page, title: string): Locator =>
  page.getByTestId('tab-bar').locator('.tab', { has: page.getByText(title, { exact: true }) })

const titles = (page: Page): Promise<string[]> =>
  page.getByTestId('tab-bar').locator('.tab-select').allTextContents()

const appTitles = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__dinksterTest!.app.tabs.get().map((entry) => entry.title))

const center = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  await waitForWorkspaceReady(page)
  await tab(page, 'Basic').locator('.tab-select').click()
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
})

test('sub-threshold movement remains an activating click', async ({ page }) => {
  const select = tab(page, 'Subgraph').locator('.tab-select')
  const point = await center(select)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 3, point.y)
  await page.mouse.up()

  await expect(tab(page, 'Subgraph')).toHaveClass(/active/)
  await expect(page.getByTestId('editor-group').locator('[role="tabpanel"]')).toHaveAttribute('aria-labelledby', await select.getAttribute('id') ?? '')
  expect(await titles(page)).toEqual(['Basic', 'Subgraph'])
})

test('drag reorders on release, preserves focus and active tab, and persists', async ({ page }) => {
  const draggedSelect = tab(page, 'Subgraph').locator('.tab-select')
  const from = await center(draggedSelect)
  const to = await center(tab(page, 'Basic').locator('.tab-select'))

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 4, from.y)
  await expect.poll(() => titles(page)).toEqual(['Basic', 'Subgraph'])
  await expect(tab(page, 'Subgraph')).toHaveClass(/dragging/)
  await expect(tab(page, 'Subgraph')).toHaveAttribute('data-drop-index', '1')
  await page.mouse.move(to.x - 20, to.y, { steps: 3 })

  // The DOM previews the move, but the persisted AppState order is untouched
  // until the owning pointer releases.
  await expect.poll(() => titles(page)).toEqual(['Subgraph', 'Basic'])
  await expect(tab(page, 'Subgraph')).toHaveClass(/dragging/)
  await expect(tab(page, 'Subgraph')).toHaveAttribute('data-drop-index', '0')
  const marker = await tab(page, 'Subgraph').evaluate((element) => {
    const style = getComputedStyle(element, '::before')
    return { content: style.content, left: Number.parseFloat(style.left), width: Number.parseFloat(style.width) }
  })
  expect(marker.content).not.toBe('none')
  expect(marker.left).toBeGreaterThanOrEqual(0)
  expect(marker.left + marker.width).toBeLessThanOrEqual((await tab(page, 'Subgraph').boundingBox())!.width)
  expect(await appTitles(page)).toEqual(['Basic', 'Subgraph'])
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await expect(draggedSelect).toBeFocused()

  await page.mouse.up()
  expect(await appTitles(page)).toEqual(['Subgraph', 'Basic'])
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await page.evaluate(() => {
    ;(window.__dinksterTest!.app as unknown as { flushPersistTabs(): void }).flushPersistTabs()
  })

  await page.reload()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  expect(await titles(page)).toEqual(['Subgraph', 'Basic'])
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
})

test('a dragged workflow tab shows a cursor-following ghost until release', async ({ page }) => {
  const draggedSelect = tab(page, 'Subgraph').locator('.tab-select')
  const from = await center(draggedSelect)
  const to = await center(tab(page, 'Basic').locator('.tab-select'))
  const ghost = page.getByTestId('tab-drag-ghost')

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Sub-threshold movement is still a click, so nothing follows the cursor.
  await page.mouse.move(from.x + 3, from.y)
  await expect(ghost).toHaveCount(0)

  await page.mouse.move(to.x - 20, to.y, { steps: 3 })
  await expect(ghost).toBeVisible()
  await expect(ghost.locator('.tab-drag-ghost-title')).toHaveText('Subgraph')
  const box = (await ghost.boundingBox())!
  expect(box.x).toBeGreaterThan(to.x - 20)
  expect(box.y).toBeGreaterThan(to.y)
  await captureDragGhost(page, 'central-tab-drag-ghost')

  await page.mouse.up()
  await expect(ghost).toHaveCount(0)
})

test('tab close affordances retain activation semantics', async ({ page }) => {
  // Loaded tabs start dirty by design, so closing one requires the product
  // discard decision before the tab can be removed.
  await tab(page, 'Subgraph').click({ button: 'middle' })
  const confirm = page.getByRole('dialog', { name: 'Close "Subgraph" and discard unsaved changes?' })
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await confirm.getByRole('button', { name: 'Close and discard' }).click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(1)
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await expect(tab(page, 'Basic').locator('.tab-select')).toBeFocused()

  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => {
    const untitled = window.__dinksterTest!.app.tabs.get().find((entry) => entry.title === 'Untitled')
    return untitled !== undefined && 'status' in untitled.store
  })).toBe(true)
  await tab(page, 'Basic').locator('.tab-select').click()
  const untitled = tab(page, 'Untitled')
  await untitled.hover()
  await untitled.getByTestId('tab-close').click()
  await page.getByRole('dialog', { name: 'Close "Untitled" and discard unsaved changes?' })
    .getByRole('button', { name: 'Close and discard' }).click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(1)
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await expect(tab(page, 'Basic').locator('.tab-select')).toBeFocused()
})

test('a workflow tab moves to a new window through the context menu, not a chrome button', async ({ page }) => {
  // No pop-out chrome button remains in the tab strip.
  await expect(page.getByTestId('tab-bar').locator('[data-testid="tab-popout"]')).toHaveCount(0)

  // Right-clicking trailing strip chrome or empty strip space opens no menu.
  const menu = page.getByTestId('context-menu')
  await page.getByTestId('new-tab').click({ button: 'right' })
  await expect(menu).toHaveCount(0)
  const bar = (await page.getByTestId('tab-bar').boundingBox())!
  await page.mouse.click(bar.x + bar.width - 12, bar.y + bar.height / 2, { button: 'right' })
  await expect(menu).toHaveCount(0)

  // Right-clicking a tab opens the styled menu with Share and the move.
  await tab(page, 'Basic').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-item-id="workflow.share"]')).toContainText('Share')
  const move = menu.locator('[data-item-id="workflow.openWindow"]')
  await expect(move).toContainText('Move to new window')

  // Invoking the entry moves the workflow to a pop-out window, as the
  // button did; closing the pop-out returns it.
  const popupPromise = page.waitForEvent('popup')
  await move.click()
  const popup = await popupPromise
  await popup.waitForLoadState('domcontentloaded')
  await expect(tab(page, 'Basic')).toHaveCount(0)
  await popup.close()
  await expect(tab(page, 'Basic')).toBeVisible()
})

test('the workflow tab context menu is keyboard reachable and Escape restores focus', async ({ page }) => {
  const select = tab(page, 'Basic').locator('.tab-select')
  await select.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-item-id="workflow.openWindow"]')).toContainText('Move to new window')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(select).toBeFocused()
})

test('top-right region toggles and tab geometry match the workspace columns', async ({ page }) => {
  const left = page.getByTestId('left-panel-toggle')
  const bottom = page.getByTestId('bottom-panel-toggle')
  await expect(left).toHaveAttribute('aria-pressed', 'false')
  await expect(bottom).toHaveAttribute('aria-pressed', 'false')

  await left.click()
  await expect(left).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('dock-panel')).toHaveAttribute('data-active-panel', 'library')
  await left.click()
  await expect(left).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('dock-panel')).not.toBeVisible()

  await bottom.click()
  await expect(bottom).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('bottom-panel')).toHaveAttribute('data-active-panel', 'logs')
  await bottom.click()
  await expect(bottom).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('bottom-panel')).not.toBeVisible()

  const sidebar = (await page.locator('.left-sidebar').boundingBox())!
  const pane = (await page.locator('.canvas-pane').boundingBox())!
  const barBefore = (await page.getByTestId('tab-bar').boundingBox())!
  expect(barBefore.x).toBeGreaterThanOrEqual(pane.x)
  expect(barBefore.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width)

  await left.click()
  const dock = (await page.getByTestId('dock-panel').boundingBox())!
  const paneWithDock = (await page.locator('.canvas-pane').boundingBox())!
  const barWithDock = (await page.getByTestId('tab-bar').boundingBox())!
  expect(barWithDock.x).toBeGreaterThanOrEqual(paneWithDock.x)
  expect(barWithDock.x).toBeGreaterThanOrEqual(dock.x + dock.width - 1)
})

test('center-stage view menus stay reachable without overlapping App view at narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 720 })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  const controls = (await page.locator('.canvas-view-controls').boundingBox())!
  const header = (await page.locator('.app-view-header').boundingBox())!
  expect(controls.y + controls.height).toBeLessThanOrEqual(header.y)

  await page.getByTestId('lens-switcher').click()
  const menu = (await page.getByRole('menu').filter({ hasText: 'Lenses' }).boundingBox())!
  const stage = (await page.locator('.canvas-stage').boundingBox())!
  expect(menu.x).toBeGreaterThanOrEqual(stage.x)
  expect(menu.x + menu.width).toBeLessThanOrEqual(stage.x + stage.width)
  await expect(page.getByRole('menuitemradio', { name: /Data/ })).toBeVisible()
})

test('shell separators expose values and resize from the keyboard', async ({ page }) => {
  await page.getByTestId('left-panel-toggle').click()
  const separator = page.getByTestId('dock-resize')
  await separator.focus()
  await expect(separator).toHaveAttribute('role', 'separator')
  await expect(separator).toHaveAttribute('aria-orientation', 'vertical')
  const initial = Number(await separator.getAttribute('aria-valuenow'))

  await separator.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', String(initial + 16))
  await separator.press('Home')
  await expect(separator).toHaveAttribute('aria-valuenow', await separator.getAttribute('aria-valuemin') ?? '')
  await separator.press('End')
  await expect(separator).toHaveAttribute('aria-valuenow', await separator.getAttribute('aria-valuemax') ?? '')
})

test('tab strip suppresses vertical scrolling and retains horizontal overflow', async ({ page }) => {
  for (let index = 0; index < 20; index++) await page.getByTestId('new-tab').click()
  await page.evaluate(() => document.fonts.ready)
  // Tab publication can replace DOM nodes between a locator query and evaluation.
  const titleWidths = await page.evaluate(() => {
    const titles = document.querySelectorAll('[data-testid="tab-bar"] .tab-title')
    const context = document.createElement('canvas').getContext('2d')!
    return Array.from(titles, (title) => {
      context.font = getComputedStyle(title).font
      return {
        title: title.textContent!,
        width: title.getBoundingClientRect().width,
        minimum: Math.min(
          context.measureText(title.textContent!).width,
          context.measureText(`${title.textContent!.slice(0, 3)}\u2026`).width,
        ),
      }
    })
  })
  expect(titleWidths).toHaveLength(22)
  for (const title of titleWidths) expect(title.width, title.title).toBeGreaterThanOrEqual(title.minimum)
  const overflow = await page.getByTestId('tab-bar').locator('.workflow-tablist').evaluate((element) => {
    const style = getComputedStyle(element)
    const before = element.scrollLeft
    element.scrollLeft = element.scrollWidth
    return {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      hasHorizontalOverflow: element.scrollWidth > element.clientWidth,
      scrolledHorizontally: element.scrollLeft > before,
    }
  })
  expect(overflow).toEqual({
    overflowX: 'auto',
    overflowY: 'hidden',
    hasHorizontalOverflow: true,
    scrolledHorizontally: true,
  })
})

const actionsTest = test.extend({
  page: async ({ page }, use) => {
    await page.routeWebSocket('**/api/events?*', () => {})
    await page.route('**/api/**', (route) => route.fulfill({ status: 404 }))
    await page.route('**/supervisor/**', (route) =>
      route.fulfill({ status: 502 }),
    )
    await page.route('**/api/nodes*', (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          epoch: 1,
          dinkster: { version: 'e2e', schemaWire: 2 },
          packs: {},
          nodes: {
            Relay: { displayName: 'Relay', category: 'test', interface: [] },
          },
        },
      }),
    )
    await use(page)
  },
})

actionsTest.describe('workflow tab actions', () => {
  actionsTest.beforeEach(async ({ page }) => {
    const schemas = JSON.parse(
      readFileSync(
        new URL(
          '../../core/test/fixtures/historical-schemas.json',
          import.meta.url,
        ),
        'utf8',
      ),
    )
    await page.evaluate(
      (schemas) =>
        window.__dinksterTest!.app.registerSchemas(Object.values(schemas)),
      schemas,
    )
  })

  const tabAction = async (
    page: Page,
    title: string,
    action: string,
  ): Promise<void> => {
    await tab(page, title).click({ button: 'right' })
    await page
      .getByTestId('context-menu')
      .locator(`[data-item-id="workflow.${action}"]`)
      .click()
  }

  actionsTest(
    'inline workflow rename commits on Enter, Tab and blur, but cancels Escape and blanks',
    async ({ page }) => {
      const input = page.getByRole('textbox', { name: 'Rename', exact: true })
      await tabAction(page, 'Basic', 'rename')
      await expect(page.getByTestId('context-menu')).toHaveCount(0)
      await expect(input).toBeFocused()
      await expect(input.locator('..').locator('.dinkster-run-icon')).toBeVisible()
      expect(
        await input.evaluate((element) => {
          const field = element as HTMLInputElement
          return [field.selectionStart, field.selectionEnd]
        }),
      ).toEqual([0, 5])
      await input.fill('Enter name')
      await input.press('Enter')
      await expect(tab(page, 'Enter name')).toBeVisible()
      await tab(page, 'Enter name').locator('.dinkster-run-icon').dblclick()
      await expect(input).toHaveCount(0)
      await tab(page, 'Enter name').locator('.tab-title').dblclick()
      await input.fill('Tab name')
      await input.press('Tab')
      await expect(tab(page, 'Tab name')).toBeVisible()
      await tabAction(page, 'Tab name', 'rename')
      await input.fill('Blur name')
      await tab(page, 'Subgraph').locator('.tab-select').click()
      await expect(tab(page, 'Blur name')).toBeVisible()
      await tabAction(page, 'Blur name', 'rename')
      await input.fill('Cancelled name')
      await input.press('Escape')
      await expect(tab(page, 'Blur name')).toBeVisible()
      await tabAction(page, 'Blur name', 'rename')
      await input.fill('   ')
      await input.press('Enter')
      await expect(tab(page, 'Blur name')).toBeVisible()
      await expect(input).toHaveCount(0)
      await tab(page, 'Blur name').click({ button: 'right' })
      await page.getByTestId('status-bar').click()
      await expect(page.getByTestId('context-menu')).toHaveCount(0)
      await tab(page, 'Blur name').click({ button: 'right' })
      await page.keyboard.press('Escape')
      await expect(page.getByTestId('context-menu')).toHaveCount(0)
      await expect(tab(page, 'Blur name').locator('.tab-select')).toBeFocused()
    },
  )

  actionsTest(
    'workflow copies follow their source in its group and do not share document edits',
    async ({ page }) => {
      await tabAction(page, 'Basic', 'duplicate')
      await expect
        .poll(() => titles(page))
        .toEqual(['Basic', 'Basic copy', 'Subgraph'])
      await expect(tab(page, 'Basic copy')).toHaveClass(/active/)
      const before = await page.evaluate(() => {
        const app = window.__dinksterTest!.app
        const source = app.tabs.get().find((entry) => entry.title === 'Basic')!
        const copy = app.activeTab()!
        return {
          source: app.exportDocument(source.id),
          copy: app.exportDocument(copy.id),
          sameBackend:
            app.backendForTab(source).id === app.backendForTab(copy).id,
          undo: copy.store.canUndo,
        }
      })
      expect(before.sameBackend).toBe(true)
      expect(before.undo).toBe(false)
      expect(before.copy).toEqual({
        ...(before.source as object),
        lineage: (before.copy as { lineage: string }).lineage,
      })
      expect((before.copy as { lineage: string }).lineage).not.toBe(
        (before.source as { lineage: string }).lineage,
      )
      expect(
        await page.evaluate(async () => {
          const app = window.__dinksterTest!.app
          const copy = app.activeTab()!
          return (
            await app.dispatchTo(copy, {
              command: 'node.move',
              params: {
                graphId: copy.store.doc.root,
                positions: { n0: { x: 719, y: 293 } },
              },
            })
          ).ok
        }),
      ).toBe(true)
      expect(
        await page.evaluate(() => {
          const app = window.__dinksterTest!.app
          return app.exportDocument(
            app.tabs.get().find((entry) => entry.title === 'Basic')!.id,
          )
        }),
      ).toEqual(before.source)
      await tabAction(page, 'Basic', 'duplicate')
      await expect
        .poll(() => titles(page))
        .toEqual(['Basic', 'Basic copy 2', 'Basic copy', 'Subgraph'])
    },
  )

  actionsTest(
    'Close others confirms once, cancels without closing, and discards only its split group',
    async ({ page }) => {
      await tabAction(page, 'Subgraph', 'splitRight')
      await expect(page.getByTestId('editor-group')).toHaveCount(2)
      await tabAction(page, 'Basic', 'duplicate')
      await expect(tab(page, 'Basic copy')).toBeVisible()
      await tabAction(page, 'Basic', 'duplicate')
      await expect(tab(page, 'Basic copy 2')).toBeVisible()
      await expect
        .poll(() =>
          page
            .getByTestId('editor-group')
            .filter({ has: tab(page, 'Basic') })
            .locator('.tab-select')
            .allTextContents(),
        )
        .toEqual(['Basic', 'Basic copy 2', 'Basic copy'])
      await tabAction(page, 'Basic', 'closeOthers')
      const dialog = page.getByRole('dialog', {
        name: 'Close others',
        exact: true,
      })
      await expect(dialog).toHaveCount(1)
      await expect
        .poll(async () => (await dialog.locator('li').allTextContents()).sort())
        .toEqual(['Basic copy', 'Basic copy 2'])
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect
        .poll(() => appTitles(page))
        .toEqual(['Basic', 'Subgraph', 'Basic copy', 'Basic copy 2'])
      await tabAction(page, 'Basic', 'closeOthers')
      await dialog
        .getByRole('button', { name: 'Close and discard', exact: true })
        .click()
      await expect(dialog).toHaveCount(0)
      await expect.poll(() => appTitles(page)).toEqual(['Basic', 'Subgraph'])
      await expect(page.getByTestId('editor-group')).toHaveCount(2)
      await expect(tab(page, 'Subgraph')).toBeVisible()
    },
  )
})
