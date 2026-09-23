/**
 * Shell tabs and explicit region controls. This spec is intentionally
 * client-only: it changes persisted shell/tab view state but never submits
 * work to the shared backend.
 */
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const captureDragGhost = async (page: Page, name: string): Promise<void> => {
  if (process.env['DINKSTER_CAPTURE_ISSUE_170'] !== '1') return
  await page.screenshot({
    path: evidencePath('issue-170', `${name}.png`),
    animations: 'disabled',
  })
}

const tab = (page: Page, title: string): Locator =>
  page
    .getByTestId('tab-bar')
    .locator('.tab', { has: page.locator('.tab-select', { hasText: title }) })

const titles = (page: Page): Promise<string[]> =>
  page.getByTestId('tab-bar').locator('.tab-select').allTextContents()

const appTitles = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    window.__dinksterTest!.app.tabs.get().map((entry) => entry.title),
  )

const center = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const box = (await locator.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  await tab(page, 'Basic').locator('.tab-select').click()
  await expect
    .poll(() =>
      page.evaluate(
        () => 'status' in window.__dinksterTest!.app.activeTab()!.store,
      ),
    )
    .toBe(true)
})

test('sub-threshold movement remains an activating click', async ({ page }) => {
  const select = tab(page, 'Subgraph').locator('.tab-select')
  const point = await center(select)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x + 3, point.y)
  await page.mouse.up()

  await expect(tab(page, 'Subgraph')).toHaveClass(/active/)
  await expect(
    page.getByTestId('editor-group').locator('[role="tabpanel"]'),
  ).toHaveAttribute('aria-labelledby', (await select.getAttribute('id')) ?? '')
  expect(await titles(page)).toEqual(['Basic', 'Subgraph'])
})

test('drag reorders on release, preserves focus and active tab, and persists', async ({
  page,
}) => {
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
    return {
      content: style.content,
      left: Number.parseFloat(style.left),
      width: Number.parseFloat(style.width),
    }
  })
  expect(marker.content).not.toBe('none')
  expect(marker.left).toBeGreaterThanOrEqual(0)
  expect(marker.left + marker.width).toBeLessThanOrEqual(
    (await tab(page, 'Subgraph').boundingBox())!.width,
  )
  expect(await appTitles(page)).toEqual(['Basic', 'Subgraph'])
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await expect(draggedSelect).toBeFocused()

  await page.mouse.up()
  expect(await appTitles(page)).toEqual(['Subgraph', 'Basic'])
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await page.evaluate(() => {
    ;(
      window.__dinksterTest!.app as unknown as { flushPersistTabs(): void }
    ).flushPersistTabs()
  })

  await page.reload()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  expect(await titles(page)).toEqual(['Subgraph', 'Basic'])
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
})

test('a dragged workflow tab shows a cursor-following ghost until release', async ({
  page,
}) => {
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

test('foreign pointers cannot steal a drag and cancellation rolls back without activation', async ({
  page,
}) => {
  const bar = page.getByTestId('tab-bar')
  const draggedSelect = tab(page, 'Subgraph').locator('.tab-select')
  const from = await center(draggedSelect)
  const to = await center(tab(page, 'Basic').locator('.tab-select'))

  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x - 20, to.y, { steps: 3 })
  await expect.poll(() => titles(page)).toEqual(['Subgraph', 'Basic'])

  // A second primary pointer cannot replace the mouse-owned session.
  await tab(page, 'Basic').dispatchEvent('pointerdown', {
    pointerId: 77,
    pointerType: 'touch',
    isPrimary: false,
    button: 0,
    buttons: 1,
    clientX: to.x,
    clientY: to.y,
  })
  await expect(tab(page, 'Subgraph')).toHaveClass(/dragging/)

  const ownerPointerId = await bar.evaluate((element) => {
    for (let id = 1; id < 32; id++) if (element.hasPointerCapture(id)) return id
    return undefined
  })
  expect(ownerPointerId).toBeDefined()
  await bar.evaluate(
    (element, id) => element.releasePointerCapture(id!),
    ownerPointerId,
  )
  // Explicit capture release is a pending change the browser processes on the
  // NEXT pointer event (pointer events spec), so nudge the mouse to make
  // lostpointercapture actually fire before asserting the rollback.
  await page.mouse.move(to.x - 21, to.y)
  await expect.poll(() => titles(page)).toEqual(['Basic', 'Subgraph'])
  await expect(tab(page, 'Subgraph')).not.toHaveClass(/dragging/)
  await expect(tab(page, 'Subgraph')).not.toHaveAttribute('data-drop-index')

  // Capture loss keeps the owner session until this release, then suppresses
  // the click that would otherwise activate the dragged tab.
  const restored = await center(draggedSelect)
  await page.mouse.move(restored.x, restored.y)
  await page.mouse.up()
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  expect(await appTitles(page)).toEqual(['Basic', 'Subgraph'])

  // A browser pointercancel also rolls a live preview back.
  const syntheticPointerId = 91
  await draggedSelect.dispatchEvent('pointerdown', {
    pointerId: syntheticPointerId,
    pointerType: 'pen',
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: restored.x,
    clientY: restored.y,
  })
  await page.evaluate(
    ({ pointerId, x, y }) => {
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId,
          pointerType: 'pen',
          isPrimary: true,
          button: 0,
          buttons: 1,
          clientX: x,
          clientY: y,
        }),
      )
    },
    { pointerId: syntheticPointerId, x: to.x - 20, y: to.y },
  )
  await expect.poll(() => titles(page)).toEqual(['Subgraph', 'Basic'])
  await expect(page.getByTestId('tab-drag-ghost')).toBeVisible()
  await page.evaluate((pointerId) => {
    window.dispatchEvent(
      new PointerEvent('pointercancel', {
        pointerId,
        pointerType: 'pen',
        isPrimary: true,
        button: 0,
        buttons: 0,
      }),
    )
  }, syntheticPointerId)
  await expect.poll(() => titles(page)).toEqual(['Basic', 'Subgraph'])
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await expect(page.getByTestId('tab-drag-ghost')).toHaveCount(0)
})

test('tab close affordances retain activation semantics', async ({ page }) => {
  // Loaded tabs start dirty by design, so closing one requires the product
  // discard decision before the tab can be removed.
  await tab(page, 'Subgraph').click({ button: 'middle' })
  const confirm = page.getByRole('dialog', {
    name: 'Close "Subgraph" and discard unsaved changes?',
  })
  await expect(
    confirm.getByRole('button', { name: 'Cancel', exact: true }),
  ).toBeFocused()
  await confirm.getByRole('button', { name: 'Close and discard' }).click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(1)
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await expect(tab(page, 'Basic').locator('.tab-select')).toBeFocused()

  await page.getByTestId('new-tab').click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const untitled = window
          .__dinksterTest!.app.tabs.get()
          .find((entry) => entry.title === 'Untitled')
    return untitled !== undefined && 'status' in untitled.store
      }),
    )
    .toBe(true)
  await tab(page, 'Basic').locator('.tab-select').click()
  const untitled = tab(page, 'Untitled')
  await untitled.hover()
  await untitled.getByTestId('tab-close').click()
  await page
    .getByRole('dialog', {
      name: 'Close "Untitled" and discard unsaved changes?',
    })
    .getByRole('button', { name: 'Close and discard' })
    .click()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(1)
  await expect(tab(page, 'Basic')).toHaveClass(/active/)
  await expect(tab(page, 'Basic').locator('.tab-select')).toBeFocused()
})

test('a workflow tab moves to a new window through the context menu, not a chrome button', async ({
  page,
}) => {
  // No pop-out chrome button remains in the tab strip.
  await expect(
    page.getByTestId('tab-bar').locator('[data-testid="tab-popout"]'),
  ).toHaveCount(0)

  // Right-clicking trailing strip chrome or empty strip space opens no menu.
  const menu = page.getByTestId('context-menu')
  await page.getByTestId('new-tab').click({ button: 'right' })
  await expect(menu).toHaveCount(0)
  const bar = (await page.getByTestId('tab-bar').boundingBox())!
  await page.mouse.click(bar.x + bar.width - 12, bar.y + bar.height / 2, {
    button: 'right',
  })
  await expect(menu).toHaveCount(0)

  // Right-clicking a tab opens the styled menu with Share and the move.
  await tab(page, 'Basic').click({ button: 'right' })
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-item-id="workflow.share"]')).toContainText(
    'Share',
  )
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

test('the workflow tab context menu is keyboard reachable and Escape restores focus', async ({
  page,
}) => {
  const select = tab(page, 'Basic').locator('.tab-select')
  await select.focus()
  await page.keyboard.press('Shift+F10')
  const menu = page.getByTestId('context-menu')
  await expect(menu).toBeVisible()
  await expect(
    menu.locator('[data-item-id="workflow.openWindow"]'),
  ).toContainText('Move to new window')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(select).toBeFocused()
})

test('top-right region toggles and tab geometry match the workspace columns', async ({
  page,
}) => {
  const left = page.getByTestId('left-panel-toggle')
  const bottom = page.getByTestId('bottom-panel-toggle')
  await expect(left).toHaveAttribute('aria-pressed', 'false')
  await expect(bottom).toHaveAttribute('aria-pressed', 'false')

  await left.click()
  await expect(left).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('dock-panel')).toHaveAttribute(
    'data-active-panel',
    'library',
  )
  await left.click()
  await expect(left).toHaveAttribute('aria-pressed', 'false')
  await expect(page.getByTestId('dock-panel')).not.toBeVisible()

  await bottom.click()
  await expect(bottom).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('bottom-panel')).toHaveAttribute(
    'data-active-panel',
    'logs',
  )
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

test('topbar search stays geometrically centered and chrome order is stable', async ({
  page,
}) => {
  for (const width of [1280, 600]) {
    await page.setViewportSize({ width, height: 720 })
    const search = (await page.getByTestId('topbar-search').boundingBox())!
    expect(
      Math.abs(search.x + search.width / 2 - width / 2),
    ).toBeLessThanOrEqual(1)
  }

  await expect(page.locator('.topbar-group-right > button')).toHaveCount(6)
  expect(
    await page
      .locator('.topbar-group-right > button')
      .evaluateAll((buttons) =>
    buttons.map((button) => button.getAttribute('data-testid')),
      ),
  ).toEqual([
    'customize-layout-button',
    'left-panel-toggle',
    'bottom-panel-toggle',
    'rail-toggle',
    'projects-button',
    'collab-button',
  ])
  await expect(
    page.locator('.topbar').getByTestId('settings-button'),
  ).toHaveCount(0)

  const inactiveLeft = page.getByTestId('left-panel-toggle')
  const activeRight = page.getByTestId('rail-toggle')
  expect(
    await inactiveLeft
      .locator('[data-region="left"]')
      .evaluate((panel) => getComputedStyle(panel).fill),
  ).toBe('none')
  expect(
    await activeRight
      .locator('[data-region="right"]')
      .evaluate((panel) => getComputedStyle(panel).fill),
  ).toBe(await activeRight.evaluate((button) => getComputedStyle(button).color))
  expect(
    await activeRight.evaluate(
      (button) => getComputedStyle(button).backgroundColor,
    ),
  ).not.toBe('rgb(30, 58, 82)')
  await inactiveLeft.click()
  expect(
    await inactiveLeft
      .locator('[data-region="left"]')
      .evaluate((panel) => getComputedStyle(panel).fill),
  ).toBe(
    await inactiveLeft.evaluate((button) => getComputedStyle(button).color),
  )
})

test('center-stage view menus stay reachable without overlapping App view at narrow width', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 720 })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  const controls = (await page.locator('.canvas-view-controls').boundingBox())!
  const header = (await page.locator('.app-view-header').boundingBox())!
  expect(controls.y + controls.height).toBeLessThanOrEqual(header.y)

  await page.getByTestId('lens-switcher').click()
  const menu = (await page
    .getByRole('menu')
    .filter({ hasText: 'Lenses' })
    .boundingBox())!
  const stage = (await page.locator('.canvas-stage').boundingBox())!
  expect(menu.x).toBeGreaterThanOrEqual(stage.x)
  expect(menu.x + menu.width).toBeLessThanOrEqual(stage.x + stage.width)
  await expect(page.getByRole('menuitemradio', { name: /Data/ })).toBeVisible()
})

test('settings is pinned under the two-line label-under-icon rail controls', async ({
  page,
}) => {
  const sidebar = page.locator('.left-sidebar')
  const settings = page.getByTestId('settings-button')
  await expect(settings).toBeVisible()
  const geometry = await sidebar.evaluate((element) => {
    const rail = element.getBoundingClientRect()
    const button = element
      .querySelector<HTMLElement>('[data-testid="settings-button"]')!
      .getBoundingClientRect()
    const icon = element
      .querySelector<SVGElement>('[data-testid="settings-button"] svg')!
      .getBoundingClientRect()
    const label = element
      .querySelector<HTMLElement>(
        '[data-testid="settings-button"] .sidebar-button-label',
      )!
      .getBoundingClientRect()
    const activityLabel = element.querySelector<HTMLElement>(
      '[data-testid="logs-toggle"] .sidebar-button-label',
    )!
    const labelStyle = getComputedStyle(activityLabel)
    return {
      railWidth: rail.width,
      buttonWidth: button.width,
      buttonHeight: button.height,
      iconWidth: icon.width,
      iconAboveLabel: icon.bottom <= label.top,
      bottomGap: rail.bottom - button.bottom,
      labelFontSize: labelStyle.fontSize,
      labelTextAlign: labelStyle.textAlign,
      labelWhiteSpace: labelStyle.whiteSpace,
      labelLineClamp: labelStyle.webkitLineClamp,
      activityContained:
        activityLabel.scrollWidth <= activityLabel.clientWidth &&
        activityLabel.scrollHeight <= activityLabel.clientHeight,
    }
  })
  expect(geometry).toEqual({
    railWidth: 72,
    buttonWidth: 63,
    buttonHeight: 72,
    iconWidth: 20,
    iconAboveLabel: true,
    bottomGap: 4,
    labelFontSize: '11px',
    labelTextAlign: 'center',
    labelWhiteSpace: 'normal',
    labelLineClamp: '2',
    activityContained: true,
  })
  const buttons = sidebar.locator('.sidebar-button')
  const names = await buttons.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label')),
  )
  const standardNames = [
    'Workflow library',
    'Assets',
    'Backends',
    'Memory telemetry',
    'P2P transfers',
    'Activity',
    'Execution log',
    'Settings',
  ]
  const namesWithGuides = [
    standardNames[0]!,
    'Learning guides',
    ...standardNames.slice(1),
  ]
  expect([standardNames, namesWithGuides]).toContainEqual(names)
})

test('draggable shell edges keep a seven pixel hit target and highlight a thicker edge', async ({
  page,
}) => {
  await page.getByTestId('left-panel-toggle').click()
  await page.getByTestId('bottom-panel-toggle').click()
  for (const { id, hitDimension, edgeDimension } of [
    { id: 'dock-resize', hitDimension: 'width', edgeDimension: 'width' },
    { id: 'rail-resize', hitDimension: 'width', edgeDimension: 'width' },
    { id: 'bottom-resize', hitDimension: 'height', edgeDimension: 'height' },
  ] as const) {
    const handle = page.getByTestId(id)
    await expect(handle).toBeVisible()
    const before = await handle.evaluate(
      (element, dimensions) => ({
      hit: element.getBoundingClientRect()[dimensions.hitDimension],
      edge: getComputedStyle(element, '::after')[dimensions.edgeDimension],
      edgeColor: getComputedStyle(element, '::after').backgroundColor,
      }),
      { hitDimension, edgeDimension },
    )
    expect(before.hit).toBe(7)
    expect(before.edge).toBe('3px')
    await handle.hover()
    await expect
      .poll(() =>
        handle.evaluate(
          (element) => getComputedStyle(element, '::after').backgroundColor,
        ),
      )
      .not.toBe(before.edgeColor)
  }
})

test('shell separators expose values and resize from the keyboard', async ({
  page,
}) => {
  await page.getByTestId('left-panel-toggle').click()
  const separator = page.getByTestId('dock-resize')
  await separator.focus()
  await expect(separator).toHaveAttribute('role', 'separator')
  await expect(separator).toHaveAttribute('aria-orientation', 'vertical')
  const initial = Number(await separator.getAttribute('aria-valuenow'))

  await separator.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', String(initial + 16))
  await separator.press('Home')
  await expect(separator).toHaveAttribute(
    'aria-valuenow',
    (await separator.getAttribute('aria-valuemin')) ?? '',
  )
  await separator.press('End')
  await expect(separator).toHaveAttribute(
    'aria-valuenow',
    (await separator.getAttribute('aria-valuemax')) ?? '',
  )
})

test('tab strip suppresses vertical scrolling and retains horizontal overflow', async ({
  page,
}) => {
  for (let index = 0; index < 20; index++)
    await page.getByTestId('new-tab').click()
  const overflow = await page
    .getByRole('tablist', { name: 'Open workflows' })
    .evaluate((element) => {
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
