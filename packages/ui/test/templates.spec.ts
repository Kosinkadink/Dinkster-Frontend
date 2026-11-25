import { expect, test } from '@playwright/test'

test('one click selects a template, a double click or Enter opens it, and the arrow keys move across and down', async ({
  page,
}) => {
  await page.goto('/#templates')
  const tiles = page.getByRole('listbox', { name: 'Templates' })
  const detail = page.getByRole('heading', { level: 2 }).first()
  const status = page.getByRole('status')
  await expect(detail).toHaveText('Inpaint a region')

  await tiles.getByRole('option', { name: /Text to image/ }).click()
  await expect(detail).toHaveText('Text to image')
  await expect(status).toHaveText('No action yet')

  // Three tiles to a row at this width: down moves three, right moves one.
  await page.keyboard.press('ArrowDown')
  await expect(detail).toHaveText('Upscale 2x')
  await expect(tiles.getByRole('option', { name: /Upscale 2x/ })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(detail).toHaveText('Text to video')
  await page.keyboard.press('Enter')
  await expect(status).toHaveText('Opened Text to video')

  await tiles.getByRole('option', { name: /Image to image/ }).dblclick()
  await expect(status).toHaveText('Opened Image to image')
  await page.getByRole('button', { name: 'Use template' }).click()
  await expect(status).toHaveText('Opened Image to image')
  await page.getByRole('button', { name: 'Blank workflow' }).click()
  await expect(status).toHaveText('Blank workflow opened')
})

test('a group and the search narrow the tiles, and each group counts its templates', async ({
  page,
}) => {
  await page.goto('/#templates')
  const tiles = page.getByRole('listbox', { name: 'Templates' })
  const makes = page.getByRole('listbox', { name: 'Makes' })
  const families = page.getByRole('listbox', { name: 'Model family' })
  await expect(makes.getByRole('option', { name: 'Video 2' })).toBeVisible()
  await expect(families.getByRole('option', { name: 'No models 3' })).toBeVisible()

  await makes.getByRole('option', { name: /Video/ }).click()
  await expect(tiles.getByRole('option')).toHaveText([/Text to video/, /Image to video/])
  await page.keyboard.press('ArrowDown')
  await expect(makes.getByRole('option', { name: /Audio/ })).toHaveAttribute('aria-selected', 'true')
  await expect(tiles.getByRole('option')).toHaveText([/Song from lyrics/])

  await families.getByRole('option', { name: /SDXL/ }).click()
  await expect(makes.getByRole('option', { selected: true })).toHaveCount(0)
  await expect(tiles.getByRole('option')).toHaveCount(3)
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('sketch')
  await expect(tiles.getByRole('option')).toHaveText([/Sketch to image/])
  await page.getByRole('searchbox', { name: 'Search templates' }).fill('zebra')
  await expect(tiles).toHaveCount(0)
  await expect(page.getByText('No template matches. Try other words or another group.')).toBeVisible()
})

test('a tile shows what is left to download, then how far it is, and a template without a picture shows its workflow', async ({
  page,
}) => {
  await page.goto('/#templates')
  const tiles = page.getByRole('listbox', { name: 'Templates' })
  const ready = tiles.getByRole('option', { name: /Text to image/ })
  const missing = tiles.getByRole('option', { name: /Inpaint a region/ })
  const downloading = tiles.getByRole('option', { name: /Portrait with a control picture/ })
  const drawn = tiles.getByRole('option', { name: /Run a workflow over a list/ })

  await expect(ready.locator('.dinkster-template-mark')).toHaveCount(0)
  await expect(missing.locator('.dinkster-template-mark')).toHaveText('6.4 GB')
  await expect(downloading.locator('.dinkster-template-mark')).toHaveText('41%')
  const line = await downloading.locator('.dinkster-template-progress').boundingBox()
  const picture = await downloading.locator('.dinkster-template-picture').boundingBox()
  expect(Math.abs(line!.width / picture!.width - 0.41)).toBeLessThan(0.01)
  await expect(drawn.locator('canvas')).toHaveCount(1)
  await expect(drawn.locator('img')).toHaveCount(0)

  // The detail of a template with missing models lists each one and offers their download.
  const needs = page.getByRole('region', { name: 'Needs' })
  await expect(needs).toContainText('1 of 3 on this computer')
  await expect(needs.getByRole('listitem')).toHaveText([
    /sd_xl_base_1\.0\.safetensors.*6\.9 GB.*Here/,
    /sd_xl_inpaint_0\.1\.safetensors.*5\.1 GB.*Missing/,
    /sdxl_vae\.safetensors.*1\.3 GB.*Missing/,
  ])
  await page.getByRole('button', { name: /Download 2 models/ }).click()
  await expect(missing.locator('.dinkster-template-mark')).toHaveText('12%')
  await expect(page.getByRole('button', { name: /Download 2 models/ })).toHaveCount(0)

  // The switch shows the workflow in place of the result.
  const view = page.locator('.dinkster-template-detail > .dinkster-template-picture')
  await expect(view.locator('img')).toHaveCount(1)
  await page.getByRole('tab', { name: 'Workflow' }).click()
  await expect(view.locator('canvas')).toHaveCount(1)
  await expect(view.locator('img')).toHaveCount(0)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'Result' })).toHaveAttribute('aria-selected', 'true')
  await expect(view.locator('img')).toHaveCount(1)
})
