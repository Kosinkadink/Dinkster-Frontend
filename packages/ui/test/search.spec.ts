import { expect, test, type Locator, type Page } from '@playwright/test'

const example = (page: Page, id: string) => page.getByTestId(id)
const field = (search: Locator) => search.getByRole('combobox', { name: 'Search Dinkster' })
const current = (search: Locator) => search.locator('[role="option"][aria-selected="true"]')

test('Up and Down move the current row through every group and the "more" row, wrapping at both ends', async ({ page }) => {
  await page.goto('/#search')
  const search = example(page, 'search-typed')
  await field(search).focus()
  await expect(current(search)).toHaveText(/Image Batch to List/)
  await page.keyboard.press('ArrowDown')
  await expect(current(search)).toHaveText(/Gradient Image/)
  await page.keyboard.press('ArrowDown')
  await expect(current(search)).toHaveText('5 more nodes')
  await page.keyboard.press('ArrowDown')
  await expect(current(search)).toHaveText(/Image to video\s*Blueprint/)
  await expect(field(search)).toHaveAttribute('aria-activedescendant', (await current(search).getAttribute('id'))!)

  for (let step = 0; step < 4; step += 1) await page.keyboard.press('ArrowUp')
  await expect(current(search)).toHaveText(/Image Stats/)
  await page.keyboard.press('ArrowUp')
  await expect(current(search)).toHaveText(/Image to video\s*Edited/)
  await page.keyboard.press('ArrowDown')
  await expect(current(search)).toHaveText(/Image Stats/)
})

test('Enter chooses the current row: "more" opens the rest of its group, a command runs, a switch row flips', async ({ page }) => {
  await page.goto('/#search')
  const search = example(page, 'search-typed')
  await field(search).focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(search.getByRole('group', { name: /^Nodes/ }).getByRole('option')).toHaveCount(8)
  await expect(current(search)).toHaveText(/Image List to Batch/)

  const switchRow = search.getByRole('option', { name: /Live sampling previews/ })
  const toggle = switchRow.getByRole('switch', { name: 'Live sampling previews' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await switchRow.hover()
  await expect(switchRow).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('search-typed-chosen')).toHaveText('Nothing chosen yet')

  const before = example(page, 'search-before')
  await field(before).focus()
  for (let step = 0; step < 3; step += 1) await page.keyboard.press('ArrowDown')
  await expect(current(before)).toHaveText(/Run workflow/)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('search-before-chosen')).toHaveText('Chose Run workflow')
})

test('Tab and Shift+Tab step through the kinds, and a kind narrows the list to itself', async ({ page }) => {
  await page.goto('/#search')
  const search = example(page, 'search-typed')
  const selectedKind = search.getByRole('tab', { selected: true })
  await field(search).focus()
  await expect(selectedKind).toHaveText('All')
  await page.keyboard.press('Tab')
  await expect(selectedKind).toHaveText('Nodes 8')
  await expect(field(search)).toBeFocused()
  await expect(search.getByRole('group')).toHaveCount(1)
  await expect(search.getByRole('option')).toHaveCount(8)
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(selectedKind).toHaveText('Tabs 1')
  await expect(search.getByRole('option')).toHaveText([/Image to video\s*Edited/])
  await page.keyboard.press('Tab')
  await expect(selectedKind).toHaveText('All')
})

test('the preview floats beside the list on a node or blueprint row and is gone on any other row', async ({ page }) => {
  await page.goto('/#search')
  const search = example(page, 'search-typed')
  const preview = search.getByTestId('search-preview')
  await field(search).focus()
  await expect(preview.getByRole('heading')).toHaveText('Image Batch to List')
  await expect(preview.locator('canvas[data-ready]')).toBeVisible()
  const list = (await search.getByRole('listbox').boundingBox())!
  const panel = (await preview.boundingBox())!
  expect(panel.x).toBeGreaterThanOrEqual(list.x + list.width)

  await search.getByRole('option', { name: /Upscale image 2x\s*Blueprint/ }).hover()
  await expect(preview.getByRole('heading')).toHaveText('Upscale image 2x')
  for (const name of [/Live sampling previews/, /Image to video\s*Film grain tests/, /Image to video\s*Edited/, /5 more nodes/]) {
    await search.getByRole('option', { name }).hover()
    await expect(preview).toHaveCount(0)
  }
  await search.getByRole('option', { name: /Gradient Image/ }).hover()
  await expect(preview.getByRole('heading')).toHaveText('Gradient Image')
})

test('the typed words are marked in each result title', async ({ page }) => {
  await page.goto('/#search')
  const search = example(page, 'search-typed')
  await expect(search.getByRole('option', { name: /Gradient Image/ }).locator('mark')).toHaveText('Image')
  await field(search).fill('to vid')
  await expect(search.getByRole('option', { name: /Image to video\s*Blueprint/ }).locator('mark')).toHaveText(['to', 'vid'])
})
