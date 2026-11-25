import { expect, test } from '@playwright/test'

test('a dropped image wire offers compatible installed nodes and blueprints and names their target inputs', async ({ page }) => {
  await page.goto('/#node-search')
  const search = page.getByTestId('node-search-wire')
  await expect(search.getByRole('listbox').getByRole('option')).toHaveText([
    'Image Batch to Listinto batch', 'Image List to Batchinto images', 'Image Statsinto image',
    'Blend Imagesinto first', 'Invert Imageinto image', 'Save Image (PGM)into image',
    'Upscale image 2xinto image', 'Rerouteinto value',
  ])
  await expect(search.getByRole('option').locator('.dinkster-search-row-icon > svg')).toHaveCount(8)
  const dot = search.locator('.dinkster-search-chip-dot')
  await expect(dot).toBeVisible()
  await expect(dot.locator('circle')).toHaveAttribute('fill', '#64B5F6')
  const field = search.getByRole('combobox', { name: 'Search nodes', exact: true })
  await field.focus()
  await field.press('Enter')
  await expect(page.getByTestId('node-search-wire-chosen')).toHaveText('Place Image Batch to List connected into batch')
  await search.getByRole('tab', { name: 'Blueprints', exact: true }).click()
  await expect(search.getByRole('listbox').getByRole('option')).toHaveText(['Upscale image 2xinto image'])
  await search.getByRole('tab', { name: 'All', exact: true }).click()
  await search.getByRole('button', { name: 'Remove image constraint' }).click()
  await field.fill('image')
  await expect(search.getByRole('option', { name: /Gradient Image/ })).toBeVisible()
  await expect(search.getByRole('option', { name: /Upscale Image with Model.*Not installed/ })).toBeVisible()
})

test('recent entries, categories, type menus and installation actions stay on the same surface', async ({ page }) => {
  await page.goto('/#node-search')
  const before = page.getByTestId('node-search-before')
  await expect(before.getByRole('group', { name: 'Recent', exact: true }).getByRole('option')).toHaveText([
    'Gradient Imagedev / image', 'Image Statsdev / image',
  ])
  await before.getByRole('group', { name: 'Categories', exact: true }).getByRole('option', { name: 'Notes 1', exact: true }).click()
  await expect(before.getByRole('listbox').getByRole('option')).toHaveText(['Number to Textdev / image'])
  await page.getByRole('button', { name: 'All categories', exact: true }).click()
  await expect(before.getByRole('group', { name: 'Categories', exact: true })).toBeVisible()

  const typed = page.getByTestId('node-search-typed')
  await typed.scrollIntoViewIfNeeded()
  // Deliver the outside scroll event before opening a menu that dismisses on scroll.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await typed.getByRole('button', { name: 'Gives type', exact: true }).click()
  await expect(typed.getByRole('menuitemcheckbox', { name: 'Any type', exact: true })).toBeChecked()
  await typed.getByRole('menuitemcheckbox', { name: 'string', exact: true }).click()
  await expect(typed.getByRole('listbox').getByRole('option')).toHaveText(['Image Statsdev / image'])
  await typed.getByRole('button', { name: 'Gives type', exact: true }).click()
  await expect(typed.getByRole('menuitemcheckbox', { name: 'string', exact: true })).toBeChecked()
  await typed.getByRole('menuitemcheckbox', { name: 'Any type', exact: true }).click()
  await typed.getByRole('option', { name: /Upscale Image with Model.*Not installed/ }).click()
  await expect(page.getByTestId('node-search-typed-chosen')).toHaveText('Install Upscale Image with Model')

  const takes = typed.getByRole('button', { name: 'Takes type', exact: true })
  await takes.click()
  await typed.getByRole('menuitemcheckbox', { name: 'image', exact: true }).click()
  await expect(typed.getByRole('option', { name: /Gradient Image/ })).toHaveCount(0)
  await expect(typed.getByRole('option', { name: /Blend Images/ })).toBeVisible()
  await takes.press('ArrowDown')
  await expect(typed.getByRole('menuitemcheckbox', { name: 'image', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(typed.getByRole('menu')).toHaveCount(0)
  await expect(takes).toBeFocused()
})
