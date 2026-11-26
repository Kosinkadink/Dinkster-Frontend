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
    const trigger = typed.getByRole('button', { name: `${direction} type`, exact: true })
    await expect(trigger).toHaveAttribute('title', `${direction}: Any type`)
    await expect(trigger).toHaveText('Any type')
    await trigger.click()
    const labels = trigger.locator('.dinkster-search-type-label').or(typed.getByRole('menu').locator('.dinkster-search-type-label'))
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
    const anyDot = typed.getByRole('menuitemcheckbox', { name: `${direction} Any type`, exact: true }).locator('svg.dinkster-search-chip-dot')
    await expect(anyDot).toHaveCSS('color', 'rgb(116, 136, 139)')
    await page.keyboard.press('Escape')
  }
  await typed.getByRole('button', { name: 'Gives type', exact: true }).click()
  await expect(typed.getByRole('menuitemcheckbox', { name: 'Gives Any type', exact: true })).toBeChecked()
  await typed.getByRole('menuitemcheckbox', { name: 'Gives string', exact: true }).click()
  await expect(typed.getByRole('listbox').getByRole('option')).toHaveText(['Image Statsdev / image'])
  await typed.getByRole('button', { name: 'Gives type', exact: true }).click()
  await expect(typed.getByRole('menuitemcheckbox', { name: 'Gives string', exact: true })).toBeChecked()
  await typed.getByRole('menuitemcheckbox', { name: 'Gives Any type', exact: true }).click()
  await typed.getByRole('option', { name: /Upscale Image with Model.*Not installed/ }).click()
  await expect(page.getByTestId('node-search-typed-chosen')).toHaveText('Install Upscale Image with Model')

  const takes = typed.getByRole('button', { name: 'Takes type', exact: true })
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

test('type menus retain start alignment and keep end-aligned output dots inside wide and narrow searches', async ({ page }) => {
  for (const width of [1440, 600, 390, 360, 240]) {
    await page.setViewportSize({ width, height: 1000 })
    await page.goto('/#node-search')
    const search = page.getByTestId('node-search-typed')
    await search.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    for (const direction of ['Takes', 'Gives']) {
      const trigger = search.getByRole('button', { name: `${direction} type`, exact: true })
      await trigger.scrollIntoViewIfNeeded()
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      await trigger.click()
      const menu = search.getByRole('menu')
      const bounds = (await menu.boundingBox())!
      const anchor = (await trigger.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(8)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 8)
      if (direction === 'Takes' && width === 1440) expect(bounds.x).toBeCloseTo(anchor.x, 1)
      if (direction === 'Gives') {
        expect(bounds.x + bounds.width).toBeCloseTo(Math.min(width - 8, Math.max(8 + bounds.width, anchor.x + anchor.width)), 1)
        const searchBounds = (await search.boundingBox())!
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(searchBounds.x + searchBounds.width)
        const dots = await menu.locator('.dinkster-search-chip-dot').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().right))
        expect(dots).toHaveLength(4)
        expect(Math.max(...dots) - Math.min(...dots)).toBeLessThan(0.5)
      }
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
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
  }
})
