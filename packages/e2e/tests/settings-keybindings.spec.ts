import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, setShellRegion, waitForWorkspaceReady, mockProjectPacks } from './fixtures.js'

const proofDir = process.env['DINKSTER_I18N_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

test.beforeEach(async ({ page }) => {
  await mockProjectPacks(page)
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'e2e', schemaWire: 2 }, packs: {}, nodes: {},
  } }))
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await waitForWorkspaceReady(page, 0)
  await expect(page.getByTestId('settings-button')).toBeVisible()
})

test('settings opens once in a tab and search spans groups without selecting one', async ({ page }) => {
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('region', { name: 'Settings', exact: true })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Control+Comma')
  await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toHaveCount(1)
  await expect(dialog.getByRole('link', { name: 'General', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(dialog.getByRole('link', { name: 'Shortcuts', exact: true })).toBeVisible()
  const search = dialog.getByRole('combobox', { name: 'Search settings', exact: true })
  await search.fill('minimap')
  await expect(dialog.getByRole('link').and(dialog.locator('[aria-current]'))).toHaveCount(0)
  await expect(dialog.getByRole('option').and(dialog.locator('[data-key]'))).toHaveCount(7)
  await expect(dialog.getByRole('combobox', { name: 'Size', exact: true })).toBeVisible()
  await expect(dialog.getByRole('switch', { name: 'Bookmark numbers', exact: true })).toBeVisible()
  await search.fill('language')
  await expect(dialog.getByRole('combobox', { name: 'Language', exact: true })).toBeVisible()
  await search.press('Escape')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(dialog).toBeVisible()
})

test('captured chord dispatches, conflicts are surfaced, and reset restores the default', async ({ page }) => {
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('region', { name: 'Settings', exact: true }).and(page.locator('.dinkster-settings'))
  await dialog.getByRole('link', { name: 'Shortcuts', exact: true }).click()
  const openRow = dialog.locator('[data-command-id="workflow.open"]')
  const capture = openRow.locator('[id="keybinding-workflow.open"]')

  await capture.click()
  await page.keyboard.press('Escape')
  await expect(capture).toHaveAttribute('aria-label', /: ctrl\+o$/)
  await expect(dialog).toBeVisible()
  await capture.click()
  await page.keyboard.down('Control')
  await expect(capture).toHaveAttribute('aria-label', /: ctrl$/)
  await page.keyboard.press('Shift+o')
  await page.keyboard.up('Control')
  await expect(capture).toHaveAttribute('aria-label', /: ctrl\+shift\+o$/)

  await page.getByRole('button', { name: 'Close Settings', exact: true }).click()
  await page.keyboard.press('Control+Shift+o')
  await expect(page.getByRole('tabpanel', { name: 'Library', exact: true })).toBeVisible()
  await page.getByTestId('library-toggle').click()

  await page.getByTestId('settings-button').click()
  await dialog.getByRole('link', { name: 'Shortcuts', exact: true }).click()
  const reboundRow = dialog.locator('[data-command-id="workflow.open"]')
  await capture.click()
  await page.keyboard.press('Control+s')
  await expect(reboundRow.getByRole('status')).toContainText('Save')
  await reboundRow.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(capture).toHaveAttribute('aria-label', /: ctrl\+o$/)
  await expect(reboundRow.getByRole('status')).toHaveCount(0)
  await reboundRow.getByRole('button', { name: /^Actions for / }).click()
  await expect(page.getByRole('menuitem', { name: 'Reset to default', exact: true })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Remove shortcut', exact: true }).click()
  await expect(capture).toHaveText('None')
  await reboundRow.getByRole('button', { name: /^Actions for / }).click()
  await expect(page.getByRole('menuitem', { name: 'Remove shortcut', exact: true })).toHaveCount(0)
  await page.getByRole('menuitem', { name: 'Copy command ID', exact: true }).press('Escape')
  await page.reload()
  await page.getByTestId('settings-button').click()
  const search = dialog.getByRole('combobox', { name: 'Search settings', exact: true })
  await search.fill('workflow.open')
  await expect(capture).toHaveText('None')
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(capture).toHaveAttribute('aria-label', /: ctrl\+o$/)
  await dialog.getByRole('button', { name: /^Actions for / }).click()
  await page.getByRole('menuitem', { name: 'Remove shortcut', exact: true }).click()
  await expect(capture).toHaveText('None')
  await expect(search).toHaveValue('workflow.open')
  await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(capture).toHaveAttribute('aria-label', /: ctrl\+o$/)
})

test('a changed setting persists through reload', async ({ page }) => {
  // Grid defaults on, and the live renderer holds the preference.
  const rendererGrid = () => page.evaluate(() => window.__dinksterTest!.renderer?.getGridVisible())
  await expect.poll(rendererGrid).toBe(true)
  await page.getByTestId('settings-button').click()
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('link', { name: 'Canvas', exact: true }).click()
  const row = page.locator('[data-setting-id]', { hasText: 'Show dot grid' })
  const toggle = row.getByRole('switch')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click()
  // The toggle must actually reach the renderer, not only localStorage:
  // grid paint itself is pinned by canvas renderer-paint unit tests.
  await expect.poll(rendererGrid).toBe(false)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.settings'))).toContain('canvas.grid.visible')
  await page.reload()
  await expect.poll(rendererGrid).toBe(false)
  await page.getByTestId('settings-button').click()
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('link', { name: 'Canvas', exact: true }).click()
  await expect(page.locator('[data-setting-id]', { hasText: 'Show dot grid' }).getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})

test('frame-rate diagnostics default off and persist with an optional status readout', async ({ page }, info) => {
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'e2e', schemaWire: 2 }, packs: {}, nodes: {},
  } }))
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.reload()
  await expect(page.getByTestId('frame-rate')).toHaveCount(0)
  await page.screenshot({ path: info.outputPath('frame-rate-default-off.png') })
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('region', { name: 'Settings', exact: true })
  await dialog.getByRole('link', { name: 'Advanced', exact: true }).click()
  const toggle = dialog.locator('[data-setting-id="diagnostics.frameRate"]').getByRole('switch')
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await page.screenshot({ path: info.outputPath('frame-rate-settings-on.png') })
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click()
  const readout = page.getByTestId('frame-rate')
  await expect(readout).toHaveText(/^\d+ FPS \/ slowest \d+\.\d ms$/)
  await page.screenshot({ path: info.outputPath('frame-rate-on.png') })
  await page.setViewportSize({ width: 900, height: 700 })
  await expect(readout).toBeVisible()
  await page.screenshot({ path: info.outputPath('frame-rate-narrow.png') })
  await page.reload()
  await expect(readout).toHaveText(/^\d+ FPS \/ slowest \d+\.\d ms$/)
  await page.getByTestId('settings-button').click()
  const restored = page.getByRole('region', { name: 'Settings', exact: true })
  await restored.getByRole('link', { name: 'Advanced', exact: true }).click()
  const restoredToggle = restored.locator('[data-setting-id="diagnostics.frameRate"]').getByRole('switch')
  await expect(restoredToggle).toBeChecked()
  await restoredToggle.uncheck()
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click()
  await expect(readout).toHaveCount(0)
  await page.reload()
  await expect(readout).toHaveCount(0)
})

test('language setting updates the document language and persists', async ({ page }, testInfo) => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('region', { name: 'Settings', exact: true })
  const row = dialog.locator('[data-setting-id="dinkster.locale"]')
  await expect(row).toContainText('Choose the language used by Dinkster.')
  await row.getByRole('combobox').selectOption({ label: 'Chinese' })
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
  const chineseDialog = page.getByRole('region', { name: '\u8bbe\u7f6e', exact: true })
  await expect(chineseDialog).toBeVisible()
  await expect(chineseDialog.locator('[data-setting-id="dinkster.locale"]')).toContainText('\u9009\u62e9 Dinkster \u4f7f\u7528\u7684\u8bed\u8a00\u3002')
  const chineseSearch = chineseDialog.getByRole('combobox', { name: '\u641c\u7d22\u8bbe\u7f6e', exact: true })
  await chineseSearch.fill('\u5c0f\u5730\u56fe')
  await expect(chineseDialog.getByRole('option').and(chineseDialog.locator('[data-key]'))).toHaveCount(7)
  await expect(chineseDialog.locator('.dinkster-search-row-detail').first()).toContainText('\u5c0f\u5730\u56fe')

  if (proofDir) {
    const settingsScreenshot = join(proofDir, 'settings-dialog-i18n-zh.png')
    await page.screenshot({ path: settingsScreenshot })
    await testInfo.attach('settings-dialog-i18n-zh', { path: settingsScreenshot, contentType: 'image/png' })
  }
  await chineseSearch.fill('')

  const screenshot = proofDir
    ? join(proofDir, 'language-setting-zh.png')
    : testInfo.outputPath('language-setting-zh.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('language-setting-zh', { path: screenshot, contentType: 'image/png' })

  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
})

test('settings search and controls remain reachable in a narrow viewport', async ({ page }) => {
  for (const side of ['left', 'right', 'bottom'] as const) await setShellRegion(page, side, false)
  await page.setViewportSize({ width: 360, height: 640 })
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('region', { name: 'Settings', exact: true })

  const lastCategory = dialog.getByRole('link', { name: 'Advanced', exact: true })
  await lastCategory.scrollIntoViewIfNeeded()
  await expect(lastCategory).toBeVisible()
  await dialog.getByRole('combobox', { name: 'Search settings', exact: true }).fill('minimap')
  const size = dialog.getByRole('combobox', { name: 'Size', exact: true })
  await size.scrollIntoViewIfNeeded()
  await size.selectOption({ label: 'Large' })
  await expect(size).toHaveValue('large')
  const lastRow = dialog.getByRole('option').and(dialog.locator('[data-key]')).last()
  await lastRow.scrollIntoViewIfNeeded()
  await expect(lastRow.getByRole('switch')).toBeVisible()

  const containment = await dialog.evaluate((element) => {
    const content = element.querySelector<HTMLElement>('.dinkster-search-list')!
    const controls = Array.from(element.querySelectorAll<HTMLElement>('[role="option"] button, [role="option"] input, [role="option"] select'))
    const dialogRect = element.getBoundingClientRect()
    return {
      contentFits: content.scrollWidth <= content.clientWidth,
      controlsFit: controls.every((control) => {
        const rect = control.getBoundingClientRect()
        return rect.left >= dialogRect.left && rect.right <= dialogRect.right
      }),
      scrollTailFits: (() => {
        const tail = element.querySelector<HTMLElement>('[role="option"]:last-child')?.getBoundingClientRect()
        const contentRect = content.getBoundingClientRect()
        return tail !== undefined && tail.top >= contentRect.top && tail.bottom <= contentRect.bottom
      })(),
      documentFits: document.documentElement.scrollWidth <= window.innerWidth,
    }
  })
  expect(containment).toEqual({ contentFits: true, controlsFit: true, scrollTailFits: true, documentFits: true })
})
