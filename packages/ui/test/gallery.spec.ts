import { expect, test } from '@playwright/test'

for (const width of [1280, 390]) {
  for (const section of [
    'controls',
    'forms',
    'lists',
    'messages',
    'confirmations',
  ]) {
    test(`${section} at ${width}px`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/#${section}`)
      await page.evaluate(() => document.fonts.ready)
      await expect(page.getByRole('main')).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)
      await expect(page).toHaveScreenshot(`${section}-${width}.png`, {
        fullPage: true,
      })
      expect(errors).toEqual([])
    })
  }
}

test('menus support pointer dismissal, keyboard navigation and immediate sign out', async ({
  page,
}) => {
  await page.goto('/#messages')
  const trigger = page.getByRole('button', {
    name: 'Package actions',
    exact: true,
  })
  await trigger.click()
  await expect(
    page.getByRole('menuitem', { name: 'View package' }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitem', { name: 'Add version' }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitem', { name: 'Remove package' }),
  ).toBeFocused()
  await expect(page).toHaveScreenshot('menu-open.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await page.getByRole('heading', { level: 1 }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await trigger.click()
  await trigger.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await trigger.focus()
  await page.keyboard.press('ArrowUp')
  await expect(
    page.getByRole('menuitem', { name: 'Remove package' }),
  ).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(
    page.getByText('Package viewed', { exact: true }).first(),
  ).toBeVisible()
  await page
    .getByRole('banner')
    .getByRole('button', { name: 'Account menu' })
    .click()
  await expect(page.getByRole('menu').getByText('Alex Morgan')).toBeVisible()
  await expect(
    page.getByRole('menu').getByText('alex@example.test'),
  ).toBeVisible()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.getByText('Signed out', { exact: true }).first(),
  ).toBeVisible()
})

test('forms retain edits after refusal and disable save after undo and successful save', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
  await page.goto('/#forms')
  const name = page.getByLabel('Display name', { exact: true })
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await name.fill('New name')
  await expect(save).toBeEnabled()
  await name.fill('Alex Morgan')
  await expect(save).toBeDisabled()
  await name.fill('Another name')
  await page.getByRole('button', { name: 'Undo changes' }).click()
  await expect(name).toHaveValue('Alex Morgan')
  await expect(save).toBeDisabled()
  await page.getByLabel('Reject the next save').check()
  await name.fill('Retained name')
  await save.click()
  await expect(save).toBeDisabled()
  await page.clock.runFor(600)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(name).toHaveValue('Retained name')
  await expect(save).toBeEnabled()
  await expect(page).toHaveScreenshot('form-rejected.png', { fullPage: true })
  await page.getByLabel('Reject the next save').uncheck()
  await save.click()
  await page.clock.runFor(600)
  await expect(page.getByText('No unsaved changes')).toBeVisible()
  await expect(save).toBeDisabled()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('toasts expire and can be dismissed; notices cannot be dismissed', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('/#messages')
  await expect(page.getByRole('note').getByRole('button')).toHaveCount(0)
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await page.getByRole('button', { name: 'Show success toast' }).click()
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toBeVisible()
  await page.clock.fastForward(4999)
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toBeVisible()
  await page.clock.fastForward(1)
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Show success toast' }).click()
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toHaveCount(0)
})

test('dialog contains focus, Escape restores its opener and removal requires confirmation', async ({
  page,
}) => {
  await page.goto('/#confirmations')
  const opener = page.getByRole('button', { name: 'Review removal' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Remove item?' })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Remove item', exact: true }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('dialog-open.png', { fullPage: true })
  await page.keyboard.press('Shift+Tab')
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await opener.click()
  await dialog.getByRole('button', { name: 'Remove item', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByText('Item removed', { exact: true }).first(),
  ).toBeVisible()
})

test('mobile navigation selects immediately and closes; desktop selection does not change label weight', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/#controls')
  const toggle = page.getByRole('button', { name: 'Toggle navigation' })
  await toggle.click()
  await expect(page.getByRole('navigation')).toBeVisible()
  await expect(page).toHaveScreenshot('mobile-navigation.png', {
    fullPage: true,
  })
  await page.getByRole('link', { name: 'Forms', exact: true }).click()
  await expect(
    page.getByRole('heading', { name: 'Forms', exact: true }),
  ).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('navigation')).toBeHidden()
  await page.setViewportSize({ width: 1280, height: 900 })
  const forms = page.getByRole('link', { name: 'Forms', exact: true })
  const lists = page.getByRole('link', { name: 'Lists and tables' })
  await expect(forms).toHaveAttribute('aria-current', 'page')
  const weight = await forms.evaluate(
    (element) => getComputedStyle(element).fontWeight,
  )
  expect(
    await lists.evaluate((element) => getComputedStyle(element).fontWeight),
  ).toBe(weight)
})
