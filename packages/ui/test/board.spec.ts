import { expect, test } from '@playwright/test'

test('pictures move and resize without changing their shape, and edits undo and redo', async ({
  page,
}) => {
  await page.goto('/#board')
  const picture = page.locator('[data-board-item="picture-1"]')
  const before = (await picture.boundingBox())!
  await page.mouse.move(before.x + 100, before.y + 100)
  await page.mouse.down()
  await page.mouse.move(before.x + 180, before.y + 130)
  await page.mouse.up()
  expect((await picture.boundingBox())!.x).toBeCloseTo(before.x + 80)
  expect((await picture.boundingBox())!.y).toBeCloseTo(before.y + 30)
  const handle = picture.getByRole('separator', { name: 'Resize item' })
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  await expect(picture).toHaveCSS('width', '320px')
  const resized = (await picture.boundingBox())!
  expect(resized.width / resized.height).toBeCloseTo(800 / 500, 2)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(picture).toHaveCSS('width', '310px')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  expect((await picture.boundingBox())!.x).toBeCloseTo(before.x)
  await page.getByRole('button', { name: 'Redo', exact: true }).click()
  expect((await picture.boundingBox())!.x).toBeCloseTo(before.x + 80)
  await picture.click()
  await page.keyboard.press('Delete')
  await expect(picture).toHaveCount(0)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(picture).toBeVisible()
})

test('moving a section moves its contents, notes edit, and a new note is undoable', async ({
  page,
}) => {
  await page.goto('/#board')
  const section = page.locator('[data-board-item="section-1"]')
  const bounds = (await section.boundingBox())!
  const picture = page.locator('[data-board-item="picture-1"]')
  const outside = page.locator('[data-board-item="picture-3"]')
  const pictureBefore = (await picture.boundingBox())!
  const outsideBefore = (await outside.boundingBox())!
  await page.mouse.move(bounds.x + 650, bounds.y + 330)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 690, bounds.y + 350)
  await page.mouse.up()
  expect((await section.boundingBox())!.x).toBeCloseTo(bounds.x + 40)
  expect((await picture.boundingBox())!.x).toBeCloseTo(pictureBefore.x + 40)
  expect((await outside.boundingBox())!.x).toBeCloseTo(outsideBefore.x)
  const name = section.getByRole('textbox', { name: 'Section name' })
  await name.fill('Rain and light')
  await name.press('Tab')
  const note = page.getByRole('textbox', { name: 'Note text' })
  await note.fill('Keep the reflections, not the camera angle.')
  await note.press('Tab')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(note).toHaveValue(/Reference for the light/)
  await page.getByRole('button', { name: 'Add note', exact: true }).click()
  const board = (await page.locator('.dinkster-board').boundingBox())!
  await page.mouse.click(board.x + board.width - 60, board.y + 640)
  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveCount(2)
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Note text' })).toHaveCount(1)
})
