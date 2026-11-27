import { expect, test } from '@playwright/test'

test('a form dialog tabs from Cancel to its action and Cancel dismisses it', async ({ page }) => {
  await page.goto('/#projects')
  await page.getByRole('button', { name: 'Project actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Rename project' })
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const save = dialog.getByRole('button', { name: 'Save', exact: true })
  await expect(dialog).toBeVisible()
  await cancel.focus()
  await page.keyboard.press('Tab')
  await expect(save).toBeFocused()
  await cancel.click()
  await expect(dialog).toHaveCount(0)
})

test('the project list selects by pointer and arrow keys and the detail follows', async ({
  page,
}) => {
  await page.goto('/#projects')
  const list = page.getByRole('listbox', { name: 'Projects' })
  const detail = page.getByRole('heading', { level: 2 })
  await expect(detail).toHaveText('Film grain tests')
  await list.getByRole('option', { name: /Valley matte paintings/ }).click()
  await expect(detail).toHaveText('Valley matte paintings')
  await page.keyboard.press('ArrowDown')
  await expect(detail).toHaveText('Bookshop diorama')
  await expect(
    list.getByRole('option', { name: /Bookshop diorama/ }),
  ).toBeFocused()
  await page.keyboard.press('Home')
  await expect(detail).toHaveText('Film grain tests')
  await page.keyboard.press('End')
  await expect(detail).toHaveText('Default')
})

test("each fact's action ends at the right edge of the box that holds the fact", async ({
  page,
}) => {
  await page.goto('/#projects')
  const facts = page.getByRole('group', { name: 'About this project' })
  for (const [fact, action] of [
    ['Outputs', 'Show in folder'],
    ['Runs on', 'Change'],
  ] as const) {
    const term = page.getByRole('term').filter({ hasText: fact })
    const box = facts.locator('dl').filter({ has: term })
    const button = box.getByRole('button', { name: action, exact: true })
    await expect(button).toBeVisible()
    const outer = (await box.boundingBox())!
    const inner = (await button.boundingBox())!
    const termBox = (await term.boundingBox())!
    expect(Math.abs(inner.y + inner.height / 2 - (termBox.y + termBox.height / 2))).toBeLessThan(4)
    expect(outer.x + outer.width - (inner.x + inner.width)).toBeCloseTo(16, 0)
  }
})

test('latest outputs hide and show per project', async ({ page }) => {
  await page.goto('/#projects')
  const outputs = page.getByRole('region', { name: 'Latest outputs' })
  await expect(outputs.getByRole('button', { name: /Output 1/ })).toBeVisible()
  await outputs.getByRole('button', { name: 'Hide', exact: true }).click()
  await expect(outputs.getByText('Hidden on this page')).toBeVisible()
  await expect(outputs.getByRole('button', { name: /Output 1/ })).toHaveCount(0)
  await page.getByRole('option', { name: /Teapot product shots/ }).click()
  await expect(outputs.getByRole('button', { name: /Output 1/ })).toBeVisible()
  await page.getByRole('option', { name: /Film grain tests/ }).click()
  await outputs.getByRole('button', { name: 'Show', exact: true }).click()
  await expect(outputs.getByRole('button', { name: /Output 1/ })).toBeVisible()
})

test('deleting a project asks first, and the default project cannot be deleted', async ({
  page,
}) => {
  await page.goto('/#projects')
  await page.getByRole('button', { name: 'Project actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete "Film grain tests"?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await page.getByRole('button', { name: 'Project actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await dialog.getByRole('button', { name: 'Delete project' }).click()
  const list = page.getByRole('listbox', { name: 'Projects' })
  const detail = page.getByRole('heading', { level: 2 })
  await expect(list.getByRole('option', { name: /Film grain tests/ })).toHaveCount(0)
  await expect(detail).not.toHaveText('Film grain tests')
  await page.getByText('Deleted projects (3)').click()
  const deleted = page.getByRole('list', { name: 'Deleted projects (3)' })
  await deleted
    .getByRole('listitem')
    .filter({ hasText: 'Film grain tests' })
    .getByRole('button', { name: 'Restore' })
    .click()
  await expect(detail).toHaveText('Film grain tests')
  await expect(
    list.getByRole('option', { name: /Film grain tests/ }),
  ).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('option', { name: /Default/ }).click()
  await page.getByRole('button', { name: 'Project actions' }).click()
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeDisabled()
})
