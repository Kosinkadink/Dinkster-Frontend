import { expect, test } from '@playwright/test'

test('pages open once, share the workflow strip, and keep page data across selection', async ({
  page,
}) => {
  await page.goto('/#page-tabs')
  const tabs = page.getByRole('tab')
  await expect(tabs).toHaveText(['Diner shot', 'Templates', 'Board'])
  await page.getByRole('textbox', { name: 'Board note' }).fill('Frame 43')
  await expect(
    page.getByRole('tab', { name: 'Board, unsaved changes' }),
  ).toBeVisible()
  await page
    .getByRole('button', { name: 'Open Templates', exact: true })
    .click()
  await expect(page.getByRole('tabpanel')).toContainText('Image templates')
  await page.getByRole('button', { name: 'Open Board', exact: true }).click()
  await expect(tabs).toHaveCount(3)
  await expect(page.getByRole('textbox', { name: 'Board note' })).toHaveValue(
    'Frame 43',
  )
  await page.getByRole('button', { name: 'Save note', exact: true }).click()
  await expect(
    page.getByRole('button', { name: 'Save note', exact: true }),
  ).toBeDisabled()
  await expect(
    page.getByRole('tab', { name: 'Board', exact: true }),
  ).toBeVisible()
})

test('a template or blank workflow replaces the page in the same active position', async ({
  page,
}) => {
  await page.goto('/#page-tabs')
  await page.getByRole('tab', { name: 'Templates', exact: true }).click()
  await page
    .getByRole('button', { name: 'Use example template', exact: true })
    .click()
  await expect(page.getByRole('tab')).toHaveText([
    'Diner shot',
    'Teapot shots',
    'Board',
  ])
  await expect(
    page.getByRole('tab', { name: 'Teapot shots', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('tabpanel')).toContainText(
    'Workflow editor example',
  )
  await page
    .getByRole('button', { name: 'Open Templates', exact: true })
    .click()
  await page
    .getByRole('button', { name: 'Blank workflow', exact: true })
    .click()
  await expect(page.getByRole('tab')).toHaveText([
    'Diner shot',
    'Teapot shots',
    'Board',
    'Untitled',
  ])
  await expect(
    page.getByRole('tab', { name: 'Untitled', exact: true }),
  ).toHaveAttribute('aria-selected', 'true')
})

test('pages omit workflow-only actions, close by keyboard, and close when disabled', async ({
  page,
}) => {
  await page.goto('/#page-tabs')
  await page
    .getByRole('tab', { name: 'Templates', exact: true })
    .click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Close', exact: true }),
  ).toBeVisible()
  await expect(
    page
      .getByRole('menuitem')
      .filter({ hasText: /Share|Duplicate|Live previews|Queue/ }),
  ).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('tab', { name: 'Templates', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(
    page.getByRole('tab', { name: 'Board', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('Delete')
  await expect(page.getByRole('tab')).toHaveText(['Diner shot', 'Templates'])
  await expect(
    page.getByRole('tab', { name: 'Templates', exact: true }),
  ).toBeFocused()
  await page.getByText('Templates enabled', { exact: true }).click()
  await expect(
    page.getByRole('checkbox', { name: 'Templates enabled', exact: true }),
  ).not.toBeChecked()
  await expect(page.getByRole('tab')).toHaveText(['Diner shot'])
  await expect(
    page.getByRole('button', { name: 'Open Templates', exact: true }),
  ).toBeDisabled()
  await expect(page.getByRole('tabpanel')).toContainText('Diner shot')
  await page
    .getByRole('tab', { name: 'Diner shot', exact: true })
    .click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: 'Duplicate', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByRole('menuitem', { name: 'Share', exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Escape')
})
