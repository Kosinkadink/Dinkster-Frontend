import { expect, test } from '@playwright/test'

test('project menu lists the current project, at most eight others, and its actions', async ({
  page,
}) => {
  await page.goto('/#editor-bar')
  const bar = page.getByRole('region', { name: 'Editor' }).locator('header')
  const trigger = bar.getByRole('button', {
    name: 'Film grain tests',
    exact: true,
  })
  const menu = page.getByRole('menu', { name: 'Projects', exact: true })
  const status = page.getByRole('status')

  await page.getByLabel('Other projects').selectOption('many')
  await trigger.click()
  await expect(
    menu.getByRole('menuitemcheckbox', { name: 'Film grain tests' }),
  ).toHaveAttribute('aria-checked', 'true')
  // Twelve other projects exist; the menu lists the first eight in order.
  await expect(
    menu.locator('[role="menuitem"]:not(.dinkster-menu-row-action)'),
  ).toHaveText([
    'Teapot product shots',
    'Valley matte paintings',
    'Bookshop diorama',
    'Audio experiments',
    'Storyboard frames',
    'Character turnarounds',
    'Lighting studies',
    'Texture library',
    'All projects',
    'New project',
  ])
  const open = menu.getByRole('menuitem', {
    name: 'Open in a new window: Valley matte paintings',
  })
  await expect(open).toHaveCSS('opacity', '0')
  await menu
    .getByRole('menuitem', { name: 'Valley matte paintings', exact: true })
    .hover()
  await expect(open).toHaveCSS('opacity', '1')
  await open.click()
  await expect(menu).toBeHidden()
  await expect(status).toHaveText('Opened p-1 in a window')

  // The row's action is reached with the arrow keys and shows while focused.
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(
    menu.getByRole('menuitem', { name: 'Teapot product shots', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(
    menu.getByRole('menuitem', {
      name: 'Open in a new window: Teapot product shots',
    }),
  ).toBeFocused()
  await expect(
    menu.getByRole('menuitem', {
      name: 'Open in a new window: Teapot product shots',
    }),
  ).toHaveCSS('opacity', '1')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await expect(status).toHaveText('Switched to p-0')

  await page.getByLabel('Other projects').selectOption('loading')
  await trigger.click()
  await expect(menu.getByRole('menuitem')).toHaveText([
    'All projects',
    'New project',
  ])
  await page.keyboard.press('Escape')

  await page.getByLabel('Other projects').selectOption('failed')
  await trigger.click()
  await expect(menu).toContainText('Projects could not be loaded')
  await menu.getByRole('menuitem', { name: 'All projects' }).click()
  await expect(status).toHaveText('All projects opened')
})

test('a long project name ends in an ellipsis at 160 px and keeps its full name', async ({
  page,
}) => {
  await page.goto('/#editor-bar')
  const name = 'An exceptionally long project name beyond the visible limit'
  await page.getByLabel('Project name').fill(name)
  const trigger = page
    .getByRole('region', { name: 'Editor' })
    .getByRole('button', { name, exact: true })
  await expect(trigger).toHaveAttribute('title', name)
  const text = trigger.locator('.dinkster-project-name')
  await expect(text).toHaveCSS('text-overflow', 'ellipsis')
  expect((await text.boundingBox())!.width).toBe(160)
})

test('the left bar account menu opens beside the bar, upward from its trigger', async ({
  page,
}) => {
  await page.goto('/#editor-bar')
  const rail = page
    .getByRole('region', { name: 'Editor' })
    .getByRole('navigation', { name: 'Primary navigation' })
  for (const [state, name, menuName] of [
    ['signed-in', 'Account menu: Alex Rivers', 'Account menu'],
    ['signing-in', 'Signing in', 'Signing in'],
  ] as const) {
    await page.getByLabel('Account', { exact: true }).selectOption(state)
    const trigger = rail.getByRole('button', { name, exact: true })
    await trigger.click()
    const menu = page.getByRole('menu', { name: menuName, exact: true })
    await expect(menu).toBeVisible()
    const anchor = (await trigger.boundingBox())!
    const surface = (await menu.boundingBox())!
    expect(surface.x).toBeGreaterThanOrEqual(anchor.x + anchor.width)
    expect(surface.y + surface.height).toBeCloseTo(anchor.y + anchor.height, 0)
    await page.keyboard.press('Escape')
    await expect(trigger).toBeFocused()
  }
})

test('the logo sits over the left bar and the panel switches sit at the right end', async ({
  page,
}) => {
  await page.goto('/#editor-bar')
  const editor = page.getByRole('region', { name: 'Editor' })
  const bar = editor.locator('header')
  const logo = bar.getByRole('button', { name: 'Dinkster menu', exact: true })
  const project = bar.getByRole('button', {
    name: 'Film grain tests',
    exact: true,
  })
  const rail = (await editor
    .getByRole('navigation', { name: 'Primary navigation' })
    .boundingBox())!
  // The logo draws only the D symbol; the project keeps its arrow.
  await expect(logo.locator('svg')).toHaveCount(0)
  await expect(project.locator('svg')).toHaveCount(2)
  for (const platform of ['browser', 'win32', 'linux', 'darwin']) {
    await page.getByLabel('Platform', { exact: true }).selectOption(platform)
    const mark = (await logo.boundingBox())!
    const start = (await project.boundingBox())!.x
    if (platform === 'darwin') {
      expect(mark.x).toBeGreaterThan(rail.x + rail.width)
      expect(start).toBeGreaterThan(mark.x + mark.width)
    } else {
      expect(mark.x + mark.width / 2).toBeCloseTo(rail.x + rail.width / 2, 0)
      expect(start).toBeCloseTo(rail.x + rail.width, 0)
    }
    expect(
      await bar
        .locator('.dinkster-window-toolbar-actions button')
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('aria-label')),
        ),
    ).toEqual([
      'Collaboration',
      'Customize layout',
      'Left panel',
      'Bottom panel',
      'Right panel',
    ])
  }
  const arrow = project.locator('svg').last()
  const rest = await arrow.evaluate((node) => getComputedStyle(node).color)
  await project.hover()
  await expect(arrow).not.toHaveCSS('color', rest)
})
