import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

const proofDir = process.env['DINKSTER_I18N_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
})

test('settings dialog opens, lists categories, and search spans all categories', async ({ page }) => {
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.settings-categories')).toContainText('Canvas Grid')
  await expect(dialog.locator('.settings-categories')).toContainText('Keybindings')
  await expect(dialog.locator('[data-setting-id]')).toContainText('Show dot grid')
  await dialog.locator('.settings-categories').getByRole('button', { name: 'Canvas Grid' }).click()
  const search = dialog.getByPlaceholder('Search settings')
  await search.fill('minimap')
  await expect(dialog.locator('.settings-categories').getByRole('button', { name: /All results, 8 results/ })).toBeVisible()
  await expect(dialog.locator('.settings-result-heading')).toContainText('Canvas Minimap')
  await expect(dialog.locator('[data-setting-id]')).toHaveCount(8)
  // Presence, not ordering: ranking semantics are unit-pinned in
  // settings-search.test.ts; the E2E proves the cross-category span.
  await expect(dialog.locator('[data-setting-id]', { hasText: 'Show bookmark numbers on minimap' })).toHaveCount(1)
  await dialog.locator('.settings-result-heading').first().focus()
  await page.keyboard.press('Escape')
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(dialog).toBeVisible()
})

test('captured chord dispatches, conflicts are surfaced, and reset restores the default', async ({ page }) => {
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.locator('.settings-categories').getByRole('button', { name: 'Keybindings' }).click()
  const openRow = dialog.locator('[data-command-id]', { hasText: 'Open workflow library' })
  const capture = openRow.locator('.binding-capture')

  await capture.click()
  await page.keyboard.down('Control')
  await expect(capture).toHaveText('ctrl')
  await page.keyboard.press('k')
  await page.keyboard.up('Control')
  await expect(capture).toHaveText('ctrl+k')

  await dialog.getByRole('button', { name: 'Close settings' }).click()
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('library-overlay')).toBeVisible()
  await page.getByTestId('library-toggle').click()

  await page.getByTestId('settings-button').click()
  await page.getByRole('dialog', { name: 'Settings' }).locator('.settings-categories').getByRole('button', { name: 'Keybindings' }).click()
  const reboundRow = page.getByRole('dialog', { name: 'Settings' }).locator('[data-command-id]', { hasText: 'Open workflow library' })
  await reboundRow.locator('.binding-capture').click()
  await page.keyboard.press('Control+s')
  await expect(reboundRow.locator('.product-field-message')).toContainText('workflow.save')
  await reboundRow.getByRole('button', { name: 'Reset Open workflow library shortcut to default' }).click()
  await expect(reboundRow.locator('.binding-capture')).toHaveText('ctrl+o')
  await expect(reboundRow.locator('.product-field-message')).toHaveCount(0)
})

test('a changed setting persists through reload', async ({ page }) => {
  // Grid defaults on, and the live renderer holds the preference.
  const rendererGrid = () => page.evaluate(() => window.__dinksterTest!.renderer!.getGridVisible())
  await expect.poll(rendererGrid).toBe(true)
  await page.getByTestId('settings-button').click()
  await page.locator('.settings-categories').getByRole('button', { name: 'Canvas Grid' }).click()
  const row = page.locator('[data-setting-id]', { hasText: 'Show dot grid' })
  const toggle = row.getByRole('checkbox')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  // The toggle must actually reach the renderer, not only localStorage:
  // grid paint itself is pinned by canvas renderer-paint unit tests.
  await expect.poll(rendererGrid).toBe(false)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.settings'))).toContain('canvas.grid.visible')
  await page.reload(); await page.getByTestId('settings-button').click()
  await page.locator('.settings-categories').getByRole('button', { name: 'Canvas Grid' }).click()
  await expect(page.locator('[data-setting-id]', { hasText: 'Show dot grid' }).getByRole('checkbox')).toHaveAttribute('aria-checked', 'false')
  // The persisted preference reaches the fresh renderer too.
  await expect.poll(rendererGrid).toBe(false)
})

test('language setting updates the document language and persists', async ({ page }, testInfo) => {
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-US')
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.locator('.settings-categories').getByRole('button', { name: 'Dinkster' }).click()
  const row = dialog.locator('[data-setting-id="dinkster.locale"]')
  await expect(row).toContainText('Choose the language used by Dinkster.')
  await row.getByRole('combobox').click()
  await page.getByRole('option', { name: 'Chinese' }).click()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
  const chineseDialog = page.getByRole('dialog', { name: '\u8bbe\u7f6e' })
  await expect(chineseDialog).toBeVisible()
  await expect(chineseDialog.locator('[data-setting-id="dinkster.locale"]')).toContainText('\u9009\u62e9 Dinkster \u4f7f\u7528\u7684\u8bed\u8a00\u3002')
  const chineseSearch = chineseDialog.getByRole('searchbox', { name: '\u641c\u7d22\u8bbe\u7f6e' })
  await chineseSearch.fill('\u5c0f\u5730\u56fe')
  await expect(chineseDialog.locator('.settings-categories').getByRole('button', { name: '\u5168\u90e8\u7ed3\u679c\uff0c3 \u4e2a\u7ed3\u679c' })).toBeVisible()
  await expect(chineseDialog.locator('.settings-result-heading')).toContainText('\u753b\u5e03\u5c0f\u5730\u56fe')

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
  await page.setViewportSize({ width: 360, height: 640 })
  await page.getByTestId('settings-button').click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('searchbox', { name: 'Search settings' }).fill('minimap')

  const lastCategory = dialog.locator('.settings-categories button').last()
  await lastCategory.scrollIntoViewIfNeeded()
  await expect(lastCategory).toBeVisible()
  const visibleRow = dialog.locator('[data-setting-id]').first()
  await expect(visibleRow.getByRole('checkbox')).toBeVisible()
  const lastRow = dialog.locator('[data-setting-id]').last()
  await lastRow.scrollIntoViewIfNeeded()
  await expect(lastRow.getByRole('checkbox')).toBeVisible()

  const containment = await dialog.evaluate((element) => {
    const content = element.querySelector<HTMLElement>('.settings-content')!
    const controls = Array.from(element.querySelectorAll<HTMLElement>('[data-setting-id] button, [data-setting-id] input'))
    const dialogRect = element.getBoundingClientRect()
    return {
      contentFits: content.scrollWidth <= content.clientWidth,
      controlsFit: controls.every((control) => {
        const rect = control.getBoundingClientRect()
        return rect.left >= dialogRect.left && rect.right <= dialogRect.right
      }),
      scrollTailFits: (() => {
        const tail = element.querySelector<HTMLElement>('[data-setting-id]:last-child')?.getBoundingClientRect()
        const contentRect = content.getBoundingClientRect()
        return tail !== undefined && tail.top >= contentRect.top && tail.bottom <= contentRect.bottom
      })(),
      documentFits: document.documentElement.scrollWidth <= window.innerWidth,
    }
  })
  expect(containment).toEqual({ contentFits: true, controlsFit: true, scrollTailFits: true, documentFits: true })
})
