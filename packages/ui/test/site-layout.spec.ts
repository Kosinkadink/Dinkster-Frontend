import { expect, test } from '../../e2e/visual.js'
import axe from 'axe-core'

for (const width of [1280, 1440, 1920, 390]) {
  test(`approved site Security geometry and menus at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#site-security')
    const title = page.getByRole('heading', { name: 'Security', exact: true })
    await expect(title).toBeVisible()
    await page.addScriptTag({ content: axe.source })
    expect(
      await page.evaluate(async () =>
        (await window.axe.run()).violations.map(({ id }) => id),
      ),
    ).toEqual([])
    const geometry = await page.evaluate(() => {
      const rect = (selector: string) =>
        document.querySelector(selector)!.getBoundingClientRect()
      const style = (selector: string) =>
        getComputedStyle(document.querySelector(selector)!)
      return {
        topbar: rect('.dinkster-topbar').height,
        avatar: rect('.dinkster-avatar').width,
        trigger: rect('.dinkster-menu-trigger[data-account]').width,
        wordmark: rect('.dinkster-brand .dinkster-wordmark').height,
        panelRadius: style('.dinkster-list').borderRadius,
        rowButton: rect('.dinkster-row .dinkster-button').height,
        rowTextPadding: style('.dinkster-row').paddingTop,
        rowButtonInset:
          rect('.dinkster-row .dinkster-button').top -
          rect('.dinkster-row').top,
        panelToHelper:
          rect('section:last-of-type > .dinkster-description').top -
          rect('section:last-of-type .dinkster-list').bottom,
        titleSize: style('.dinkster-title').fontSize,
        titleToHeading:
          rect('section .dinkster-heading').top -
          rect('.dinkster-title').bottom,
        headingToPanel:
          rect('.dinkster-list').top - rect('section .dinkster-heading').bottom,
        horizontalOverflow:
          document.documentElement.scrollWidth > window.innerWidth,
      }
    })
    expect(geometry).toEqual({
      topbar: 44,
      avatar: 32,
      trigger: 32,
      wordmark: 30,
      panelRadius: '8px',
      rowButton: width < 768 ? 32 : 28,
      rowTextPadding: '12px',
      rowButtonInset: 16,
      panelToHelper: 12,
      titleSize: '20px',
      titleToHeading: 32,
      headingToPanel: 12,
      horizontalOverflow: false,
    })
    await page.screenshot({
      path: `test-results/captures/site-security-${width}.png`,
      fullPage: true,
    })
    const account = page.getByRole('button', {
      name: 'Account menu: alice',
      exact: true,
    })
    await account.click()
    const menu = page.getByRole('menu', { name: 'Account menu', exact: true })
    await expect(menu).toBeVisible()
    const anchorBox = (await account.boundingBox())!
    const menuBox = (await menu.boundingBox())!
    expect(menuBox.x + menuBox.width).toBe(anchorBox.x + anchorBox.width)
    expect(menuBox.y).toBe(anchorBox.y + anchorBox.height + 4)
    expect(menuBox.width).toBe(240)
    await page.screenshot({
      path: `test-results/captures/site-account-menu-${width}.png`,
      fullPage: true,
    })
    await page.keyboard.press('Escape')
    await expect(account).toBeFocused()
    await expect(menu).toHaveCount(0)
    if (width < 768) {
      const toggle = page.getByRole('button', { name: 'Toggle navigation' })
      const titleBox = await title.boundingBox()
      await toggle.click()
      await expect(page.getByRole('navigation')).toBeVisible()
      expect(await title.boundingBox()).toEqual(titleBox)
      const navigation = (await page
        .locator('.dinkster-sidebar')
        .boundingBox())!
      expect(navigation.x).toBe(8)
      expect(navigation.width).toBe(240)
      expect(
        (await page
          .getByRole('link', { name: 'Profile', exact: true })
          .boundingBox())!.x - navigation.x,
      ).toBe(5)
      await page.screenshot({
        path: `test-results/captures/site-navigation-${width}.png`,
        fullPage: true,
      })
      await page.mouse.click(width - 4, 300)
      await expect(page.getByRole('navigation')).toBeHidden()
      await toggle.click()
      await page.getByRole('link', { name: 'Profile', exact: true }).click()
      await expect(
        page.getByRole('heading', { name: 'Profile', exact: true }),
      ).toBeVisible()
      await expect(page.getByRole('navigation')).toBeHidden()
      await expect(page.getByRole('main')).toBeFocused()
    }
  })
}

test('site statuses and disclosure retain semantic colors and keyboard behavior', async ({
  page,
}) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#site-keys')
    for (const [label, color] of [
      ['Active', 'rgb(50, 230, 165)'],
      ['Revoked', 'rgb(255, 116, 104)'],
      ['Expired', 'rgb(245, 191, 105)'],
      ['Not published', 'rgb(164, 181, 183)'],
    ] as const) {
      const pill = page
        .locator('.dinkster-status-pill')
        .filter({ hasText: label })
      await expect(pill).toHaveCSS('color', color)
      expect((await pill.boundingBox())!.height).toBe(20)
    }
    const disclosure = page.getByText('Revoked and expired', { exact: true })
    await disclosure.focus()
    await page.keyboard.press('Enter')
    await expect(
      page.getByText('No other keys.', { exact: true }),
    ).toBeVisible()
    await page.screenshot({
      path: `test-results/captures/site-statuses-${width}.png`,
      fullPage: true,
    })
    await page.keyboard.press('Space')
    await expect(page.getByText('No other keys.', { exact: true })).toBeHidden()
  }
})

test('approved site picture slot keeps its initial for absent, refused and failed pictures', async ({
  page,
}) => {
  await page.route('**/picture-ok.svg', (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="teal" /></svg>',
    }),
  )
  await page.route('**/picture-missing.svg', (route) =>
    route.fulfill({ status: 404, body: 'Not found' }),
  )
  for (const picture of [
    '',
    'https://external.invalid/person.png',
    '/picture-missing.svg',
  ]) {
    await page.goto(`/?picture=${encodeURIComponent(picture)}#site-security`)
    const avatar = page.locator('.dinkster-avatar')
    await expect(avatar.locator('img')).toHaveCount(0)
    expect(
      await avatar.evaluate(
        (element) => getComputedStyle(element, '::before').content,
      ),
    ).toBe('"A"')
  }
  await page.goto('/?picture=%2Fpicture-ok.svg#site-security')
  const image = page.locator('.dinkster-avatar img')
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0,
      ),
    )
    .toBe(true)
})

test('approved site Profile groups fields and saves only changed values', async ({
  page,
}) => {
  await page.goto('/#site-profile')
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await page.getByLabel('Display name').fill('Alice Example')
  await expect(save).toBeEnabled()
  await save.click()
  await expect(save).toHaveAttribute('aria-disabled', 'true')
  const button = (await save.boundingBox())!
  const panel = (await page.locator('.dinkster-panel').first().boundingBox())!
  expect(button.y - panel.y - panel.height).toBe(16)
  expect(button.x + button.width).toBe(panel.x + panel.width)
  await page.screenshot({
    path: 'test-results/captures/site-profile-1280.png',
    fullPage: true,
  })
})

test('approved site centered card bundles provider logos and has no shell', async ({
  page,
}) => {
  for (const width of [1280, 1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#site-card')
    await expect(
      page.getByRole('heading', { name: 'Sign in', exact: true }),
    ).toBeVisible()
    await expect(page.locator('.dinkster-topbar')).toHaveCount(0)
    const card = page.locator('.dinkster-auth-card')
    expect(
      await card.evaluate((element) => getComputedStyle(element).padding),
    ).toBe('28px')
    for (const provider of ['GitHub', 'Google']) {
      const button = page.getByRole('button', {
        name: `Continue with ${provider}`,
      })
      const logo = button.locator('img')
      await expect(logo).toBeVisible()
      expect(
        await logo.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
      ).toBe(true)
      expect((await logo.boundingBox())!.width).toBe(20)
      expect((await button.boundingBox())!.width).toBe(220)
    }
    const rect = (await card.boundingBox())!
    expect(rect.width).toBe(width < 768 ? 358 : 440)
    expect(rect.x + rect.width / 2).toBe(width / 2)
    await page.screenshot({
      path: `test-results/captures/site-card-${width}.png`,
      fullPage: true,
    })
  }
})
