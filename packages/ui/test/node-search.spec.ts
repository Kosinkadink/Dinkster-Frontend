import { expect, test } from '@playwright/test'

test('catalog recovery replaces empty-search announcements until nodes return', async ({ page }) => {
  await page.goto('/#node-search')
  const search = page.getByTestId('node-search-disabled')
  const input = search.getByRole('combobox')
  await expect(input).toHaveValue('image')
  await expect(search.getByRole('status')).not.toContainText('No matches')
  await expect(search.getByRole('note')).toContainText('No packs are enabled in this project')
  await input.press('Enter')
  await expect(search.getByRole('option')).toHaveCount(0)
  const action = search.getByRole('button', { name: 'Enable all installed packs', exact: true })
  for (let step = 0; step < 8 && !await action.evaluate((element) => element === document.activeElement); step++) {
    await page.keyboard.press('Tab')
  }
  await expect(action).toBeFocused()
  await action.press('Enter')
  await expect(input).toHaveValue('image')
  await expect(search.getByRole('option').first()).toBeVisible()
  await input.fill('not-a-node')
  await expect(search.getByRole('status')).toHaveText('No matches')
})

test('a dropped image wire offers compatible installed nodes and blueprints and names their target inputs', async ({ page }) => {
  await page.goto('/#node-search')
  const search = page.getByTestId('node-search-wire')
  await expect(search.getByRole('listbox').getByRole('option')).toHaveText([
    'Image Batch to Listinto batch', 'Image Statsinto image',
    'Blend Imagesinto first', 'Invert Imageinto image', 'Save Image (PGM)into image',
    'Upscale image 2xinto image', 'Rerouteinto value',
  ])
  await expect(search.getByRole('option').locator('.dinkster-search-row-icon > svg')).toHaveCount(7)
  const dot = search.locator('.dinkster-search-chip .dinkster-search-chip-dot')
  await expect(dot).toBeVisible()
  await expect(dot.locator('circle')).toHaveAttribute('fill', '#64B5F6')
  const chip = search.getByRole('group', { name: 'Takes image', exact: true })
  await expect(chip).toHaveAttribute('title', 'Takes image')
  await expect(chip).toHaveText('image')
  expect(await chip.evaluate((element) => {
    const dot = element.querySelector('svg')!.getBoundingClientRect()
    const word = element.querySelector('.dinkster-search-type-label > span')!.getBoundingClientRect()
    return word.left - dot.right
  })).toBe(8)
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
  for (const direction of ['Takes', 'Gives'] as const) {
    const trigger = typed.getByRole('button', { name: direction, exact: true })
    await expect(trigger).toHaveAttribute('title', direction)
    await expect(trigger).toHaveText(direction)
    await trigger.click()
    const labels = typed.getByRole('menu').locator('.dinkster-search-type-label')
    await expect(labels).toHaveCount(5)
    const positions = await labels.evaluateAll((elements) => elements.map((element) => {
      const dot = element.querySelector('svg')!.getBoundingClientRect()
      const word = element.querySelector('span')!.getBoundingClientRect()
      return {
        side: dot.right < word.left ? 'before' : dot.left > word.right ? 'after' : 'overlap',
        gap: Math.max(word.left - dot.right, dot.left - word.right),
        minimumGap: getComputedStyle(element).gap,
      }
    }))
    for (const position of positions) {
      expect(position.side).toBe(direction === 'Takes' ? 'before' : 'after')
      expect(position.gap).toBeGreaterThanOrEqual(8)
      expect(position.minimumGap).toBe('8px')
    }
    await expect(typed.getByRole('menuitemcheckbox', { name: `${direction} image`, exact: true }).locator('circle')).toHaveAttribute('fill', '#64B5F6')
    await expect(typed.getByRole('menuitemcheckbox', { name: `${direction} Any type`, exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
  }
  await typed.getByRole('button', { name: 'Gives', exact: true }).click()
  await typed.getByRole('menuitemcheckbox', { name: 'Gives string', exact: true }).click()
  await expect(typed.getByRole('listbox').getByRole('option')).toHaveText(['Image Statsdev / image'])
  await typed.getByRole('button', { name: 'Gives', exact: true }).click()
  await expect(typed.getByRole('menuitemcheckbox', { name: 'Gives string', exact: true })).toBeChecked()
  await typed.getByRole('menuitemcheckbox', { name: 'Gives string', exact: true }).click()
  await typed.getByRole('option', { name: /Upscale Image with Model.*Not installed/ }).click()
  await expect(page.getByTestId('node-search-typed-chosen')).toHaveText('Install Upscale Image with Model')

  const takes = typed.getByRole('button', { name: 'Takes', exact: true })
  await takes.click()
  await typed.getByRole('menuitemcheckbox', { name: 'Takes image', exact: true }).click()
  await expect(typed.getByRole('option', { name: /Gradient Image/ })).toHaveCount(0)
  await expect(typed.getByRole('option', { name: /Blend Images/ })).toBeVisible()
  await takes.press('ArrowDown')
  await expect(typed.getByRole('menuitemcheckbox', { name: 'Takes image', exact: true })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(typed.getByRole('menu')).toHaveCount(0)
  await expect(takes).toBeFocused()
})

test('type menus open on the first click and align their right edge inside wide and narrow searches', async ({ page }) => {
  for (const width of [1280, 600, 390, 360, 240]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const direction of ['Takes', 'Gives']) {
      await page.goto('/#node-search')
      await page.reload()
      const search = page.getByTestId('node-search-typed')
      const trigger = search.getByRole('button', { name: direction, exact: true })
      await trigger.click()
      const menu = search.locator('.dinkster-menu-popover')
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('textbox')).toHaveAttribute('placeholder', 'Find a type')
      const bounds = (await menu.boundingBox())!
      const anchor = (await trigger.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(8)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8)
      expect(bounds.x + bounds.width).toBeCloseTo(Math.min(width - 8, Math.max(8 + bounds.width, anchor.x + anchor.width)), 1)
      const searchBounds = (await search.boundingBox())!
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(searchBounds.x + searchBounds.width)
      if (direction === 'Gives') {
        const dots = await menu.locator('.dinkster-search-chip-dot').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right))
        expect(dots).toHaveLength(5)
        expect(Math.max(...dots) - Math.min(...dots)).toBeLessThan(0.5)
      }
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
  }
})

test('list filters keep plain names, directional pin shapes and whole-list input admission', async ({ page }) => {
  await page.goto('/#node-search')
  const search = page.getByTestId('node-search-typed')
  for (const direction of ['Takes', 'Gives']) {
    await search.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await search.getByRole('button', { name: direction, exact: true }).click()
    const menu = search.getByRole('menu')
    await expect(menu.getByRole('menuitemcheckbox')).toHaveText(['image', 'image list', 'image file', 'int', 'string'])
    await expect(menu.getByRole('menuitemcheckbox', { name: `${direction} image list`, exact: true }).locator('.dinkster-search-chip-dot')).toHaveAttribute('data-shape', 'diamond')
    await expect(menu.getByRole('menuitemcheckbox', { name: `${direction} image`, exact: true }).locator('.dinkster-search-chip-dot')).toHaveAttribute('data-shape', 'circle')
    await menu.getByRole('menuitemcheckbox', { name: `${direction} image list`, exact: true }).click()
    await expect(search.getByRole('listbox').getByRole('option')).toHaveText(direction === 'Takes'
      ? ['Image List to Batchdev / image', 'Image Statsdev / image']
      : ['Image Batch to Listdev / image'])
    await search.getByRole('button', { name: `Remove ${direction} image list`, exact: true }).click()
  }
  const wire = page.getByTestId('node-search-list-wire')
  await expect(wire.getByRole('group', { name: 'Takes image list', exact: true })).toHaveText('image list')
  await expect(wire.locator('.dinkster-search-chip .dinkster-search-chip-dot')).toHaveAttribute('data-shape', 'diamond')
  await expect(wire.getByRole('option')).toHaveText(['Image List to Batchinto images', 'Image Statsinto image'])
})

test('picked requirements keep order, require all types and support individual or empty-query Backspace removal', async ({ page }, testInfo) => {
  await page.goto('/#node-search')
  const search = page.getByTestId('node-search-typed')
  await search.scrollIntoViewIfNeeded()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const choose = async (direction: string, type: string) => {
    await search.getByRole('button', { name: direction, exact: true }).click()
    const filter = search.getByRole('textbox', { name: direction === 'Takes' ? 'Filter input types' : 'Filter output types', exact: true })
    await expect(filter).toBeFocused()
    await expect(filter).toHaveValue('')
    await filter.fill(type.toUpperCase())
    await expect(search.getByRole('menuitemcheckbox', { name: `${direction} ${type}`, exact: true })).toBeVisible()
    await filter.press('Enter')
    await expect(search.getByRole('menu')).toHaveCount(0)
    await expect(search.getByRole('combobox')).toBeFocused()
  }
  await choose('Gives', 'string')
  await choose('Takes', 'image list')
  const chips = search.locator('.dinkster-search-field > [role="group"]')
  await expect(chips).toHaveText(['string', 'image list'])
  await expect(chips.nth(0)).toHaveAccessibleName('Gives string')
  await expect(chips.nth(1)).toHaveAccessibleName('Takes image list')
  await expect(search.getByRole('option')).toHaveText(['Image Statsdev / image'])
  const field = search.getByRole('combobox')
  await expect(field).toHaveValue('image')
  await field.focus()
  await field.press('Home')
  await field.press('Backspace')
  await expect(chips).toHaveCount(2)
  await search.screenshot({ path: testInfo.outputPath('requirements-two-chips-dark.png') })
  await search.getByRole('button', { name: 'Takes', exact: true }).click()
  await expect(search.getByRole('menuitemcheckbox', { name: 'Takes image list', exact: true })).toBeChecked()
  await expect(search.getByRole('menuitemcheckbox', { name: 'Takes int', exact: true })).toBeVisible()
  const diamond = search.getByRole('menuitemcheckbox', { name: 'Takes image list', exact: true }).locator('.dinkster-search-chip-dot')
  await expect(diamond).toHaveCSS('width', '13.75px')
  await expect(chips.nth(1).locator('.dinkster-search-chip-dot')).toHaveCSS('width', '13.75px')
  await search.screenshot({ path: testInfo.outputPath('requirements-list-menu-dark.png') })
  await page.keyboard.press('Escape')
  await field.fill('')
  await field.press('Backspace')
  await expect(chips).toHaveCount(1)
  await expect(chips).toHaveAccessibleName('Gives string')
  await expect(field).toBeFocused()
  await choose('Takes', 'image')
  await search.getByRole('button', { name: 'Remove Gives string', exact: true }).click()
  await expect(chips).toHaveAccessibleName('Takes image')
  await expect(field).toBeFocused()
  await choose('Takes', 'image')
  await expect(chips).toHaveCount(0)
  await choose('Gives', 'image')
  await choose('Gives', 'string')
  await expect(search.getByRole('option')).toHaveCount(0)
  await choose('Gives', 'image')
  await expect(search.getByRole('option')).toHaveText(['Image Statsdev / image', 'Number to Textdev / image'])
  await choose('Gives', 'string')
  await choose('Takes', 'image file')
  await expect(search.getByRole('option', { name: /Blend Images/ })).toBeVisible()
  await choose('Gives', 'image list')
  await choose('Takes', 'int')
  await expect(chips).toHaveText(['image file', 'image list', 'int'])
  await expect(search.getByRole('option')).toHaveCount(0)
  for (const width of [600, 360, 240]) {
    await page.setViewportSize({ width, height: 900 })
    const panel = (await search.locator('.dinkster-search-panel').boundingBox())!
    for (const control of [field, chips.nth(0), chips.nth(1), chips.nth(2)]) {
      const bounds = (await control.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(panel.x)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(panel.x + panel.width)
    }
    await search.screenshot({ path: testInfo.outputPath(`requirements-chips-${width}-dark.png`) })
  }
})

test('custom menu content keeps string names, separate descriptions and selection behavior', async ({ page }) => {
  for (const width of [240, 360, 600]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#node-search')
    const trigger = page.getByRole('button', { name: 'Choose example type', exact: true })
    await expect(trigger).toHaveText('image')
    await expect(trigger).toHaveAttribute('title', 'Choose an example type')
    await trigger.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    await trigger.click()
    const menu = page.getByRole('menu', { name: 'Type label examples', exact: true })
    const bounds = (await menu.boundingBox())!
    expect(bounds.x).toBeGreaterThanOrEqual(8)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8)
    const plain = menu.getByRole('menuitem', { name: 'Image input', exact: true })
    const described = menu.getByRole('menuitem', { name: 'Image output', exact: true })
    await expect(plain).toHaveText('image')
    await expect(plain).not.toHaveAttribute('aria-describedby')
    await expect(described).toHaveAccessibleDescription('Accepts a picture from the node.')
    await expect(described.locator('.dinkster-menu-item-label')).toHaveText('image')
    await described.click()
    await expect(page.getByTestId('custom-menu-chosen')).toHaveText('Image output')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await trigger.press('ArrowDown')
    await plain.click()
    await expect(page.getByTestId('custom-menu-chosen')).toHaveText('Image input')
    await page.setViewportSize({ width, height: 180 })
    await trigger.scrollIntoViewIfNeeded()
    await trigger.focus()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const scroll = await page.evaluate(() => [window.scrollX, window.scrollY])
    for (const key of ['ArrowDown', 'ArrowUp']) {
      await trigger.press(key)
      const target = key === 'ArrowDown' ? plain : described
      await expect(target).toBeFocused()
      await expect(target).toBeInViewport({ ratio: 1 })
      await expect(menu.getByRole('menuitem', { name: 'Unavailable image type', exact: true })).toBeDisabled()
      expect(await page.evaluate(() => [window.scrollX, window.scrollY])).toEqual(scroll)
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
  }
})
