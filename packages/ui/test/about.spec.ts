import { expect, test } from '../../e2e/visual.js'
import axe from 'axe-core'

for (const width of [1280, 390]) {
  test(`About identity and bundled wordmarks at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#desktop-about')
    for (const platform of ['win32', 'linux', 'darwin']) {
      const chrome = page.locator(
        `.dinkster-window-chrome[data-platform="${platform}"]`,
      )
      await expect(chrome.locator('.dinkster-brand-title')).toHaveText(
        'Dinkster Desktop',
      )
      await expect(chrome.locator('.dinkster-window-identity-wide')).toHaveText(
        '[QA]Development',
      )
      const preview = chrome.locator('..')
      const marking = chrome.locator('.dinkster-window-identity')
      await expect(marking).toBeVisible()
      const markBounds = (await marking.boundingBox())!
      const toastBounds = (await preview.getByRole('status').boundingBox())!
      expect(markBounds.y + markBounds.height).toBeLessThan(toastBounds.y)
      await expect(preview.getByRole('alert')).toBeVisible()
      expect((await chrome.boundingBox())?.height).toBe(44)
      await expect(chrome).toHaveCSS(
        'padding-left',
        platform === 'darwin' ? '92px' : '12px',
      )
    }
    for (const [theme, title] of [
      ['dark', 'Dinkster Desktop'],
      ['light', 'Dinkster Desktop [QA]'],
    ] as const) {
      const region = page.getByRole('region', { name: title, exact: true })
      await expect(region.getByRole('heading')).toHaveText(title)
      await expect(
        region.getByText('Version 0.2.8', { exact: true }),
      ).toBeVisible()
      const wordmark = region.getByRole('img', {
        name: 'Dinkster',
        exact: true,
      })
      await expect
        .poll(() =>
          wordmark.evaluate((image) => {
            const element = image as HTMLImageElement
            return element.complete && element.naturalWidth > 0
          }),
        )
        .toBe(true)
      await expect(wordmark).toHaveAttribute(
        'src',
        new RegExp(`color-${theme}`),
      )
      expect(await region.getByRole('button').count()).toBe(0)
      await region.screenshot({
        path: `test-results/captures/about-${theme}-${width}.png`,
      })
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true)
    await page.evaluate(() => window.scrollTo(0, 0))
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
    await page.screenshot({
      path: `test-results/captures/desktop-gallery-${width}.png`,
      fullPage: true,
    })
    const firstPreview = page.locator('.dinkster-desktop-preview').first()
    await firstPreview.getByRole('button', { name: 'Dismiss error' }).click()
    await expect(firstPreview.getByRole('alert')).toHaveCount(0)
    await firstPreview
      .getByRole('button', { name: 'Dismiss notification' })
      .click()
    await expect(firstPreview.getByRole('status')).toBeEmpty()
    await page.addScriptTag({ content: axe.source })
    expect(
      await page.evaluate(
        async () =>
          (await (window as unknown as { axe: typeof axe }).axe.run())
            .violations,
      ),
    ).toEqual([])
  })
}

test('account menu identifies a session without a name or profile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/#window-toolbar')
  const bar = page
    .getByRole('region', { name: 'custom dark linux', exact: true })
    .locator('header')
  for (const [state, primary, secondary] of [
    ['signed-in', 'Alex Rivers', 'alex@example.test'],
    ['signed-in-email', 'alex@example.test', ''],
    ['signed-in-empty', 'Signed in', ''],
  ]) {
    await page.getByLabel('Account state').selectOption(state!)
    const trigger = bar.getByRole('button', {
      name: `Account menu: ${primary}`,
      exact: true,
    })
    await trigger.scrollIntoViewIfNeeded()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    )
    await bar.screenshot({
      path: `test-results/captures/toolbar-account-${state}.png`,
    })
    await trigger.click()
    const menu = bar.getByRole('menu', { name: 'Account menu', exact: true })
    await expect(menu).toHaveAccessibleDescription(
      secondary ? `${primary} ${secondary}` : primary!,
    )
    await menu.screenshot({
      path: `test-results/captures/toolbar-account-menu-${state}.png`,
    })
    await menu.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(page.getByRole('status')).toHaveText('Signed out')
    await expect(trigger).toBeFocused()
  }
})

test('narrow toolbar keeps region switches in the checked layout menu', async ({
  page,
}) => {
  await page.goto('/#window-toolbar')
  await page.getByLabel('Account state').selectOption('signed-out')
  const bar = page
    .getByRole('region', { name: 'custom dark linux', exact: true })
    .locator('header')
  for (const state of ['idle', 'running', 'pending']) {
    await page.getByLabel('Execution state').selectOption(state)
    await page.setViewportSize({ width: 484, height: 900 })
    for (const name of ['Left panel', 'Bottom panel', 'Right panel'])
      await expect(bar.getByRole('button', { name, exact: true })).toBeVisible()
    await bar
      .getByRole('button', { name: 'Customize layout', exact: true })
      .click()
    await expect(bar.getByRole('menuitemcheckbox')).toHaveText([
      'Left bar',
      'Status bar',
    ])
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 483, height: 900 })
    for (const name of ['Left panel', 'Bottom panel', 'Right panel'])
      await expect(bar.getByRole('button', { name, exact: true })).toHaveCount(
        0,
      )
  }
  await page.setViewportSize({ width: 390, height: 900 })
  const trigger = bar.getByRole('button', {
    name: 'Customize layout',
    exact: true,
  })
  await trigger.scrollIntoViewIfNeeded()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  )
  await trigger.focus()
  await page.keyboard.press('ArrowDown')
  const menu = bar.getByRole('menu', { name: 'Customize layout', exact: true })
  await expect(menu.getByRole('menuitemcheckbox')).toHaveText([
    'Left panel',
    'Bottom panel',
    'Right panel',
    'Left bar',
    'Status bar',
  ])
  await expect(
    menu.getByRole('menuitemcheckbox', { name: 'Left panel', exact: true }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  const bottom = menu.getByRole('menuitemcheckbox', {
    name: 'Bottom panel',
    exact: true,
  })
  await expect(bottom).toBeFocused()
  await expect(bottom).not.toBeChecked()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(bottom).toBeChecked()
  await page.keyboard.press('Escape')
  await page.setViewportSize({ width: 484, height: 900 })
  await expect(
    bar.getByRole('button', { name: 'Bottom panel', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
  await page.setViewportSize({ width: 390, height: 900 })
  await trigger.click()
  await menu
    .getByRole('menuitem', { name: 'Reset layout', exact: true })
    .click()
  await trigger.click()
  await expect(bottom).not.toBeChecked()
  await page
    .getByRole('heading', { name: 'Window toolbar', exact: true })
    .click()
  await expect(menu).toHaveCount(0)
})

test('44px toolbar keeps account and full compact metadata in one row', async ({
  page,
}) => {
  await page.goto('/#window-toolbar')
  await page.getByLabel('Brand presentation').selectOption('wordmark')
  await page.getByLabel('Account state').selectOption('signed-in')
  const section = page.getByRole('region', {
    name: 'custom dark linux',
    exact: true,
  })
  const bar = section.locator('header')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const state of ['idle', 'pending']) {
      await page.getByLabel('Execution state').selectOption(state)
      await expect(bar).toHaveCSS('height', '44px')
      const account = bar.getByRole('button', {
        name: 'Account menu: Alex Rivers',
        exact: true,
      })
      await expect(account).toHaveCSS('height', '32px')
      await expect(account).toHaveCSS('width', '32px')
      const wordmark = bar.getByRole('img', { name: 'Dinkster', exact: true })
      await expect(wordmark).toHaveCSS('height', '30px')
      const marking = bar.locator('.dinkster-window-identity-compact')
      if (width === 390) {
        await expect(marking).toBeVisible()
        await expect(marking).toHaveText('Custom Dev')
        await expect(marking).toHaveAttribute(
          'title',
          'Custom services, Development project - unpublished sources',
        )
        await expect(marking).toHaveAccessibleName(
          'Custom services, Development project - unpublished sources',
        )
      } else await expect(marking).toBeHidden()
      const bounds = (await bar.boundingBox())!
      for (const button of await bar.getByRole('button').all()) {
        const rect = (await button.boundingBox())!
        expect(rect.x).toBeGreaterThanOrEqual(bounds.x + 12)
        expect(rect.x + rect.width).toBeLessThanOrEqual(
          bounds.x + bounds.width - 12,
        )
        expect(rect.y - bounds.y).toBe(6)
        expect(rect.height).toBe(32)
      }
      await page.keyboard.press('Tab')
      await account.focus()
      await expect(account).toHaveCSS('outline-width', '2px')
      await expect(account).toHaveCSS('outline-offset', '2px')
    }
  }
  await bar
    .getByRole('button', { name: 'Account menu: Alex Rivers', exact: true })
    .click()
  await bar.getByRole('menuitem', { name: 'Sign out', exact: true }).click()
  await expect(page.getByRole('status', { exact: true })).toHaveText(
    'Signed out',
  )
  await page.getByLabel('Account state').selectOption('signed-out')
  await bar.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('status', { exact: true })).toHaveText(
    'Sign in opened',
  )
})

test('Rich toolbar labels preserve branding, compact geometry and pending focus', async ({
  page,
}) => {
  let release!: () => void
  const imagesReady = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/*wordmark*.svg', async (route) => {
    await imagesReady
    await route.continue()
  })
  await page.goto('/#window-toolbar')
  await page.addStyleTag({
    content:
      '.dinkster-window-toolbar-host[data-platform="win32"] { padding-right:148px }',
  })
  await page.getByLabel('Brand presentation').selectOption('wordmark')
  const sections = page.locator('section[aria-label]')
  for (const fixtureWidth of [1440, 929, 928, 873, 872, 793, 792, 390]) {
    for (const section of await sections.all()) {
      const bar = section.locator('header')
      const platform = await bar.getAttribute('data-platform')
      const width =
        fixtureWidth === 390
          ? platform === 'win32'
            ? 512
            : platform === 'darwin'
              ? 456
              : 390
          : fixtureWidth
      await page.setViewportSize({ width, height: 900 })
      const left = platform === 'darwin' ? 92 : 12
      const right = width - (platform === 'win32' ? 148 : 12)
      await expect(bar.locator('button[aria-pressed]')).toHaveCount(
        right - left < 460 ? 0 : 3,
      )
      const compact = right - left < 945
      const action = bar.getByRole('button', { name: 'Dinkster', exact: true })
      await expect(action).toHaveAttribute('title', 'Dinkster')
      const image = action.locator('img')
      const light = (await section.getAttribute('aria-label'))!.includes(
        ' light ',
      )
      await expect(image).toHaveAttribute(
        'src',
        new RegExp(`wordmark-color-${light ? 'light' : 'dark'}`),
      )
      expect(
        await image.evaluate((node: HTMLImageElement) => node.complete),
      ).toBe(false)
      const bounds = (await action.boundingBox())!
      const label = action.locator('.dinkster-window-action-label')
      if (compact) {
        await expect(action.locator('svg')).toBeVisible()
        await expect(label).toHaveCSS('clip-path', 'inset(50%)')
        expect(bounds.width).toBe(32)
      } else {
        await expect(action.locator('svg')).toBeHidden()
        await expect(label).toHaveCSS('clip-path', 'none')
        const geometry = (await image.boundingBox())!
        expect(geometry.width).toBe(99)
        expect(geometry.height).toBe(30)
        expect(bounds.width).toBeGreaterThan(99)
      }
      expect((await bar.boundingBox())!.height).toBe(44)
      for (const button of await bar.getByRole('button').all()) {
        const rect = (await button.boundingBox())!
        expect(rect.x).toBeGreaterThanOrEqual(left)
        expect(rect.x + rect.width).toBeLessThanOrEqual(right)
      }
    }
  }
  release()
  await expect
    .poll(() =>
      sections
        .first()
        .locator('img')
        .evaluate((node: HTMLImageElement) => node.naturalWidth),
    )
    .toBeGreaterThan(0)
  for (const width of [1440, 512]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ['dark', 'light'])
      await page
        .getByRole('region', { name: `qa ${theme} win32`, exact: true })
        .locator('header')
        .screenshot({
          path: `test-results/captures/window-toolbar-wordmark-${theme}-${width}.png`,
        })
  }
  const action = sections
    .first()
    .getByRole('button', { name: 'Dinkster', exact: true })
  await action.click()
  await expect(page.getByRole('status')).toHaveText('Dinkster opened')
  await sections
    .first()
    .getByRole('button', { name: 'Search', exact: true })
    .click()
  await action.focus()
  await page.getByLabel('Execution state').selectOption('pending')
  await expect(action).toBeFocused()
  await expect(action).toBeDisabled()
  await expect(action).toHaveAttribute('aria-busy', 'true')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect(page.getByRole('status')).toHaveText('Search opened')
  await expect(action.locator('svg')).toBeHidden()
  await sections.first().locator('header').screenshot({
    path: 'test-results/captures/window-toolbar-wordmark-pending-512.png',
  })
  await page.getByLabel('Execution state').selectOption('idle')
  await expect(action).toBeEnabled()
  await page.getByLabel('Brand presentation').selectOption('menu')
  await expect(
    sections
      .first()
      .getByRole('button', { name: 'Dinkster', exact: true })
      .locator('img'),
  ).toHaveCount(0)
})

for (const state of ['running', 'pending'])
  test(`expanded toolbar caps project text and gives spare width to Search when ${state}`, async ({
    page,
  }) => {
    await page.goto('/#window-toolbar')
    await page.addStyleTag({
      content:
        '.dinkster-window-toolbar-host[data-platform="win32"] { padding-right:148px }',
    })
    await page.getByLabel('Execution state').selectOption(state)
    await page.getByLabel('Account state').selectOption('signed-out')
    await page.getByLabel('Brand presentation').selectOption('wordmark')
    const name = 'An exceptionally long project name beyond the visible limit'
    await page.getByLabel('Project name').fill(name)
    await page.evaluate(() => document.fonts.ready)
    for (const platform of ['linux', 'darwin', 'win32']) {
      const reservation =
        platform === 'win32' ? 160 : platform === 'darwin' ? 104 : 24
      const bar = page
        .getByRole('region', { name: `custom dark ${platform}`, exact: true })
        .locator('header')
      const search = bar.getByRole('button', { name: 'Search', exact: true })
      const project = bar.getByRole('button', { name, exact: true })
      for (const contentWidth of [1045, 945, 944.5, 944, 769]) {
        // A fractional container width must not leave a gap between the two forms.
        await page.setViewportSize({
          width: Math.ceil(contentWidth + reservation),
          height: 900,
        })
        await bar.evaluate((node, width) => {
          node.style.width = `${width}px`
        }, contentWidth + reservation)
        await expect(project).toHaveAttribute('title', name)
        const text = project.locator('.dinkster-window-project-name')
        if (contentWidth >= 945) {
          await expect(search.locator('kbd')).toBeVisible()
          await expect(text).toHaveCSS('text-overflow', 'ellipsis')
          expect((await text.boundingBox())!.width).toBe(160)
          expect(
            await text.evaluate((node) => node.scrollWidth > node.clientWidth),
          ).toBe(true)
          const searchBounds = (await search.boundingBox())!
          expect(searchBounds.width).toBeGreaterThanOrEqual(116)
          if (state === 'running')
            expect(searchBounds.width).toBe(contentWidth === 945 ? 116 : 216)
          const layoutBounds = (await bar
            .getByRole('button', { name: 'Customize layout', exact: true })
            .boundingBox())!
          expect(layoutBounds.x - searchBounds.x - searchBounds.width).toBe(4)
        } else {
          await expect(search.locator('kbd')).toBeHidden()
          expect((await project.boundingBox())!.width).toBe(32)
        }
        const bounds = await bar.evaluate((node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          return {
            left: rect.left + parseFloat(style.paddingLeft),
            right: rect.right - parseFloat(style.paddingRight),
          }
        })
        const controls = await bar
          .locator(
            'button, .dinkster-window-identity, .dinkster-window-toolbar-service',
          )
          .evaluateAll((nodes) =>
            nodes
              .filter((node) => node.getClientRects().length)
              .map((node) => {
                const rect = node.getBoundingClientRect()
                return { left: rect.left, right: rect.right }
              }),
          )
        for (const [index, rect] of controls.entries()) {
          expect(rect.left).toBeGreaterThanOrEqual(bounds.left)
          expect(rect.right).toBeLessThanOrEqual(bounds.right)
          for (const previous of controls.slice(0, index))
            expect(
              rect.right <= previous.left || rect.left >= previous.right,
            ).toBe(true)
        }
        if (contentWidth === 945 || contentWidth === 769)
          await bar.screenshot({
            path: `test-results/captures/toolbar-expanded-${platform}-${contentWidth}-${state}.png`,
          })
      }
    }
  })

test('Window toolbar keeps actions and identity inside native reservations', async ({
  page,
}) => {
  await page.goto('/#window-toolbar')
  await page.addStyleTag({
    content:
      '.dinkster-window-toolbar-host[data-platform="win32"] { padding-right:148px }',
  })
  await page.getByLabel('Account state').selectOption('signed-out')
  const sections = page.locator('section[aria-label]')
  await expect(sections).toHaveCount(18)
  for (const state of ['idle', 'running', 'pending']) {
    await page.getByLabel('Execution state').selectOption(state)
    for (const fixtureWidth of [1440, 929, 928, 873, 872, 793, 792, 390]) {
      for (const section of await sections.all()) {
        if (
          fixtureWidth !== 1440 &&
          fixtureWidth !== 390 &&
          !(await section.getAttribute('aria-label'))!.startsWith('qa dark ')
        )
          continue
        const bar = section.locator('header')
        const platform = await bar.getAttribute('data-platform')
        const width =
          fixtureWidth === 390
            ? platform === 'win32'
              ? 512
              : platform === 'darwin'
                ? 456
                : 390
            : fixtureWidth
        await page.setViewportSize({ width, height: 900 })
        const bounds = (await bar.boundingBox())!
        expect(bounds.height).toBe(44)
        const left = platform === 'darwin' ? 92 : 12
        const right = width - (platform === 'win32' ? 148 : 12)
        await expect(bar.locator('button[aria-pressed]')).toHaveCount(
          right - left < 460 ? 0 : 3,
        )
        const search = bar.getByRole('button', { name: 'Search', exact: true })
        const compact = right - left < 945
        await expect(search).toHaveAttribute('title', 'Search (Ctrl+K)')
        await expect(search).toHaveAccessibleDescription('Search (Ctrl+K)')
        if (compact) {
          await expect(search.locator('svg')).toBeVisible()
          await expect(search.locator('kbd')).toBeHidden()
        } else {
          await expect(search.locator('svg')).toBeHidden()
          await expect(search.locator('kbd')).toBeVisible()
          const hint = (await search.locator('kbd').boundingBox())!
          const action = (await search.boundingBox())!
          expect(hint.x + hint.width).toBeLessThanOrEqual(
            action.x + action.width,
          )
        }
        const serviceLabel = bar.locator('.dinkster-window-toolbar-service')
        if (compact) {
          await expect(serviceLabel).toBeHidden()
          for (const marking of await bar
            .locator('.dinkster-window-identity-compact')
            .all()) {
            await expect(marking).toBeVisible()
            const rect = (await marking.boundingBox())!
            const action = (await search.boundingBox())!
            expect(rect.y).toBeGreaterThanOrEqual(action.y)
            expect(rect.y + rect.height).toBeLessThanOrEqual(
              action.y + action.height,
            )
          }
        } else {
          for (const metadata of await bar
            .locator(
              '.dinkster-window-identity, .dinkster-window-toolbar-service',
            )
            .all()) {
            const rect = (await metadata.boundingBox())!
            expect(rect.y + rect.height).toBeGreaterThan(
              (await search.boundingBox())!.y,
            )
          }
        }
        const controls = bar.locator(
          'button, .dinkster-window-identity, .dinkster-window-toolbar-service',
        )
        const rectangles = await controls.evaluateAll((nodes) =>
          nodes
            .filter((node) => node.getClientRects().length > 0)
            .map((node) => {
              const rect = node.getBoundingClientRect()
              return {
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
              }
            }),
        )
        for (const [index, rect] of rectangles.entries()) {
          expect(rect.left).toBeGreaterThanOrEqual(left)
          expect(rect.right).toBeLessThanOrEqual(right)
          expect(rect.top).toBeGreaterThanOrEqual(bounds.y)
          expect(rect.bottom).toBeLessThanOrEqual(bounds.y + 44)
          for (const previous of rectangles.slice(0, index))
            expect(
              rect.right <= previous.left ||
                rect.left >= previous.right ||
                rect.bottom <= previous.top ||
                rect.top >= previous.bottom,
              JSON.stringify({ state, width, platform, rect, previous }),
            ).toBe(true)
        }
        if (fixtureWidth === 390 || width === 1440)
          for (const label of [
            'Dinkster',
            'Search',
            'Sample project',
            'Collaboration',
            'Customize layout',
          ])
            await expect(
              bar.getByRole('button', { name: label, exact: true }),
            ).toBeVisible()
        const cancel = bar.getByRole('button', {
          name: 'Cancel run',
          exact: true,
        })
        if (state === 'idle') await expect(cancel).toHaveCount(0)
        else if (state === 'pending') {
          await expect(cancel).toBeDisabled()
          await expect(cancel).toHaveAttribute('aria-busy', 'true')
        } else await expect(cancel).toBeEnabled()
      }
      if ((state === 'idle' && fixtureWidth === 1440) || fixtureWidth === 390) {
        const width = fixtureWidth === 390 ? 512 : fixtureWidth
        await page.setViewportSize({ width, height: 900 })
        const name =
          state === 'idle'
            ? 'production dark win32'
            : state === 'running'
              ? 'qa dark win32'
              : 'custom light win32'
        await page.getByRole('region', { name, exact: true }).screenshot({
          path: `test-results/captures/window-toolbar-${state}-${width}.png`,
        })
        if (fixtureWidth === 390 && state === 'pending') {
          await page.setViewportSize({ width: 456, height: 900 })
          await page
            .getByRole('region', { name: 'custom light darwin', exact: true })
            .screenshot({
              path: 'test-results/captures/window-toolbar-mac-pending-456.png',
            })
        }
      }
    }
  }
  await page.getByLabel('Execution state').selectOption('running')
  const first = sections.first()
  const search = first.getByRole('button', { name: 'Search', exact: true })
  await page.getByLabel('Search shortcut').selectOption('Alt+K')
  await expect(search).toHaveAccessibleDescription('Search (Alt+K)')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(search.locator('kbd')).toHaveText('Alt+K')
  await expect(search.locator('kbd')).toBeVisible()
  await page.getByLabel('Search shortcut').selectOption('')
  await expect(search.locator('kbd')).toHaveCount(0)
  await expect(search).toHaveAttribute('title', 'Search')
  await search.click()
  await expect(page.getByRole('status')).toHaveText('Search opened')
  await first.getByRole('button', { name: 'Cancel run' }).click()
  await expect(page.getByRole('status')).toHaveText('Run cancelled')
  const trigger = first.getByRole('button', { name: 'Dinkster', exact: true })
  await trigger.click()
  await expect(first.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(first.getByRole('menu')).toBeHidden()
  await trigger.click()
  await first.getByRole('menuitem', { name: 'Projects' }).click()
  await expect(first.getByRole('menu')).toBeHidden()
  await expect(page.getByRole('status')).toHaveText('Projects opened')
  await page.addScriptTag({ content: axe.source })
  expect(
    await page.evaluate(
      async () =>
        (await (window as unknown as { axe: typeof axe }).axe.run()).violations,
    ),
  ).toEqual([])
})
