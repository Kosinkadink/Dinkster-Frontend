import { expect, test } from '@playwright/test'

test.use({ hasTouch: true })

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
  await picture.click()
  const anchored = (await picture.boundingBox())!
  await picture.getByRole('separator', { name: 'Resize top left' }).focus()
  await page.keyboard.press('ArrowLeft')
  const expanded = (await picture.boundingBox())!
  expect(expanded.width).toBeCloseTo(anchored.width + 10)
  expect(expanded.x + expanded.width).toBeCloseTo(anchored.x + anchored.width)
  expect(expanded.y + expanded.height).toBeCloseTo(anchored.y + anchored.height)
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
  const memberBeforeResize = (await picture.boundingBox())!
  const topLeft = (await section
    .getByRole('separator', { name: 'Resize top left' })
    .boundingBox())!
  await page.mouse.move(topLeft.x + 4, topLeft.y + 4)
  await page.mouse.down()
  await page.mouse.move(topLeft.x - 16, topLeft.y - 16)
  expect((await picture.boundingBox())!.x).toBeCloseTo(memberBeforeResize.x)
  await page.mouse.up()
  expect((await picture.boundingBox())!.y).toBeCloseTo(memberBeforeResize.y)
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

test('sound and video play in place, and media can move, resize and undo removal', async ({
  page,
}) => {
  await page.goto('/#board')
  const sound = page.locator('[data-board-item="sound-1"]')
  await expect(
    sound
      .getByRole('img', { name: 'Waveform of Reference chimes' })
      .locator('path'),
  ).not.toHaveAttribute('d', '')
  await expect(sound).toContainText('0:04')
  for (const [id, name] of [
    ['sound-1', 'Reference chimes'],
    ['video-1', 'Rain on the window'],
  ]) {
    const item = page.locator(`[data-board-item="${id}"]`)
    await item.scrollIntoViewIfNeeded()
    const before = (await item.boundingBox())!
    await item
      .getByRole('button', { name: `Play ${name}`, exact: true })
      .click()
    await expect
      .poll(() =>
        item
          .locator('audio, video')
          .evaluate((element) => (element as HTMLMediaElement).currentTime),
      )
      .toBeGreaterThan(0)
    await item
      .getByRole('button', { name: `Pause ${name}`, exact: true })
      .click()
    expect((await item.boundingBox())!.x).toBeCloseTo(before.x)
    await page.mouse.move(before.x + 20, before.y + 20)
    await page.mouse.down()
    await page.mouse.move(before.x + 60, before.y + 40)
    await page.mouse.up()
    expect((await item.boundingBox())!.x).toBeCloseTo(before.x + 40)
    await item.getByRole('separator', { name: 'Resize item' }).focus()
    await page.keyboard.press('ArrowRight')
    expect((await item.boundingBox())!.width).toBeCloseTo(before.width + 10)
    await page.keyboard.press('Delete')
    await expect(item).toHaveCount(0)
    await page.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(item).toBeVisible()
  }
})

test('two fingers pan and zoom the board without moving its items', async ({
  page,
  context,
}) => {
  await page.goto('/#board')
  const picture = page.locator('[data-board-item="picture-1"]')
  const before = (await picture.boundingBox())!
  const board = (await page.locator('.dinkster-board').boundingBox())!
  const session = await context.newCDPSession(page)
  const x = board.x + board.width - 180
  const y = board.y + 200
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x, y, id: 1 },
      { x: x + 80, y, id: 2 },
    ],
  })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: x + 20, y: y + 30, id: 1 },
      { x: x + 180, y: y + 30, id: 2 },
    ],
  })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  const after = (await picture.boundingBox())!
  expect(after.width).toBeCloseTo(before.width * 2)
  expect(after.x).toBeCloseTo((before.x - (x + 40)) * 2 + x + 100)
  await page.getByRole('button', { name: 'Fit board', exact: true }).click()
  await expect(picture).toBeVisible()
  expect((await picture.boundingBox())!.width).toBeLessThanOrEqual(before.width)
})

test('unreadable audio reports the missing waveform without inventing one', async ({
  page,
}) => {
  await page.route('**/board/chimes.wav', (route) =>
    route.fulfill({ contentType: 'audio/wav', body: 'not audio' }),
  )
  await page.goto('/#board')
  const sound = page.locator('[data-board-item="sound-1"]')
  await expect(sound.getByText('Waveform unavailable')).toBeVisible()
  await expect(sound.getByRole('img').locator('path')).toHaveAttribute('d', '')
  await sound
    .getByRole('button', { name: 'Play Reference chimes', exact: true })
    .click()
  await expect(sound.getByRole('status')).toHaveText('Playback unavailable')
})
