import { expect, test, type Locator, type Page } from '../../e2e/visual.js'
import axe from 'axe-core'

declare global {
  interface Window {
    axe: typeof axe
  }
}

const expectNoAxeViolations = async (page: Page) => {
  await page.addScriptTag({ content: axe.source })
  expect(
    await page.evaluate(async () =>
      (await window.axe.run()).violations.map(({ id, nodes }) => ({
        id,
        elements: nodes.map((node) => node.html),
      })),
    ),
  ).toEqual([])
}
test('run activity distinguishes concurrent running jobs from queued jobs and respects reduced motion', async ({ page }) => {
  await page.goto('/#controls')
  const one = page.getByRole('img', { name: '1 running', exact: true })
  const many = page.getByRole('img', { name: '3 running', exact: true })
  const queued = page.getByRole('img', { name: '2 queued', exact: true })
  const mixed = page.getByRole('img', { name: '3 running, 1 queued', exact: true })
  await expect(one).toBeVisible()
  await expect(one).toHaveText('')
  await expect(many).toHaveText('3')
  await expect(queued).toHaveText('2')
  await expect(mixed).toHaveText('31')
  const ring = one.locator('svg')
  const clock = queued.locator('svg')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await expect.poll(() => ring.evaluate((element) => getComputedStyle(element).animationName)).toBe('dinkster-spin')
  expect(await clock.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  expect(await ring.evaluate((element) => getComputedStyle(element).color))
    .not.toBe(await clock.evaluate((element) => getComputedStyle(element).color))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expect.poll(() => ring.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
})

test('portable site geometry follows the site scale without changing app density', async ({
  page,
}) => {
  await page.goto('/#controls')
  for (const width of [1280, 1440, 1920, 390]) {
    await page.setViewportSize({ width, height: 900 })
    const values = await page.evaluate(() => {
      const root = document.documentElement
      root.dataset.density = 'site'
      const style = getComputedStyle(root)
      const site = Object.fromEntries(
        [
          'navigation-width',
          'row-button-height',
          'row-button-mobile-height',
          'field-height',
          'main-button-height',
          'panel-radius',
          'control-radius',
          'mobile-top-bar-padding',
          'status-tint-opacity',
        ].map((name) => [
          name,
          name === 'status-tint-opacity'
            ? Number(style.getPropertyValue(`--dinkster-site-${name}`))
            : style.getPropertyValue(`--dinkster-site-${name}`).trim(),
        ]),
      )
      root.dataset.density = 'app'
      const app = {
        siteField: getComputedStyle(root)
          .getPropertyValue('--dinkster-site-field-height')
          .trim(),
        input: getComputedStyle(root)
          .getPropertyValue('--dinkster-input-primary-height')
          .trim(),
        body: getComputedStyle(document.body).fontSize,
      }
      root.dataset.density = 'site'
      return { site, app }
    })
    expect(values).toEqual({
      site: {
        'navigation-width': '220px',
        'row-button-height': '28px',
        'row-button-mobile-height': '32px',
        'field-height': '36px',
        'main-button-height': '36px',
        'panel-radius': '8px',
        'control-radius': '6px',
        'mobile-top-bar-padding': '8px',
        'status-tint-opacity': 0.14,
      },
      app: { siteField: '', input: '40px', body: '13px' },
    })
  }
})

const background = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).backgroundColor)
const token = (page: Page, name: string) =>
  page.evaluate((name) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${name})`
    document.body.append(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  }, name)

for (const width of [1280, 390]) {
  for (const section of [
    'controls',
    'forms',
    'lists',
    'messages',
    'confirmations',
    'account-data',
    'signed-out',
  ]) {
    test(`${section} at ${width}px`, async ({ page }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/#${section}`)
      await page.evaluate(() => document.fonts.ready)
      await expect(page.getByRole('main')).toBeVisible()
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true)
      await expect(page).toHaveScreenshot(`${section}-${width}.png`, {
        fullPage: true,
      })
      await expectNoAxeViolations(page)
      expect(errors).toEqual([])
    })
  }
}

test('account values copy exactly, history expands by keyboard and signed-out shell has no empty navigation', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/#account-data')
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(
    page.locator('.dinkster-toast').filter({ hasText: 'Copied.' }),
  ).toBeVisible()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'dk_sample_not_a_credential_abcdefghijklmnopqrstuvwxyz0123456789_abcdefghijklmnopqrstuvwxyz0123456789',
  )
  const history = page.getByText('Revoked tokens (1)', { exact: true })
  await expect(
    page.getByText('Old publishing token', { exact: true }),
  ).toBeHidden()
  await history.focus()
  await page.keyboard.press('Enter')
  await expect(
    page.getByText('Old publishing token', { exact: true }),
  ).toBeVisible()
  await page.keyboard.press('Space')
  await expect(
    page.getByText('Old publishing token', { exact: true }),
  ).toBeHidden()
  await expect(page.getByText('Release token', { exact: true })).toBeVisible()
  const image = page.getByRole('img', { name: /Example QR code/ })
  expect(
    await image.evaluate(
      (node: HTMLImageElement) => node.complete && node.naturalWidth > 0,
    ),
  ).toBe(true)
  await page
    .getByRole('link', { name: 'View shell without account navigation' })
    .click()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: 'Toggle navigation' }),
  ).toHaveCount(0)
  const frame = (await page.locator('.dinkster-shell-body').boundingBox())!
  const content = (await page.getByRole('main').boundingBox())!
  expect(content.x).toBe(frame.x)
  expect(content.width).toBe(frame.width)
  await page.getByRole('link', { name: 'Return to the gallery' }).click()
  await expect(page.getByRole('navigation')).toHaveCount(1)
})

test('copy retains focus while the clipboard is pending', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.addInitScript(() => {
    navigator.clipboard.writeText = () =>
      new Promise<void>((resolve) => window.setTimeout(resolve, 600))
  })
  await page.goto('/#account-data')
  await page.evaluate(() => document.fonts.ready)
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
  const copy = page.getByRole('button', { name: 'Copy', exact: true })
  await copy.focus()
  await page.keyboard.press('Enter')
  await expect(copy).toBeFocused()
  await expect(copy).toHaveAttribute('aria-busy', 'true')
  await expect(copy).toBeDisabled()
  await expect(page).toHaveScreenshot('account-copy-pending.png', {
    fullPage: true,
  })
  await page.clock.runFor(600)
  await expect(copy).toBeFocused()
  await expect(copy).toBeEnabled()
  await expect(page.locator('.dinkster-toast')).toHaveText('Copied.')
})

test('clipboard refusal keeps the value selectable and reports no success', async ({
  page,
}) => {
  await page.addInitScript(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Clipboard refused')
    }
  })
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/#account-data')
  await page.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText(/Could not copy/)
  await expect(
    page.locator('.dinkster-toast').filter({ hasText: 'Copied.' }),
  ).toHaveCount(0)
  await page
    .getByRole('region', { name: 'Example API key', exact: true })
    .locator('code')
    .evaluate((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      window.getSelection()!.removeAllRanges()
      window.getSelection()!.addRange(range)
    })
  expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(
    'dk_sample_not_a_credential_abcdefghijklmnopqrstuvwxyz0123456789_abcdefghijklmnopqrstuvwxyz0123456789',
  )
  await page.evaluate(() => window.getSelection()!.removeAllRanges())
  await page.evaluate(() => document.fonts.ready)
  await expect(page).toHaveScreenshot('account-copy-refused-390.png', {
    fullPage: true,
  })
  await expectNoAxeViolations(page)
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('enabled controls expose actual hover, keyboard focus and pressed states', async ({
  page,
}) => {
  await page.goto('/#controls')
  await expect(
    page.getByRole('button', { name: 'Add item', exact: true }),
  ).toHaveAttribute('title', 'Add item')
  const samples = page.getByRole('region', {
    name: 'Button roles and fills',
    exact: true,
  })
  const button = page.getByRole('button', { name: 'Add outline', exact: true })
  await page.mouse.move(0, 0)
  const rest = await background(button)
  await button.hover()
  const hovered = await background(button)
  expect(hovered).not.toBe(rest)
  await expect(samples).toHaveScreenshot('buttons-hover.png')
  await page.keyboard.press('Tab')
  await button.focus()
  expect(
    await button.evaluate((element) => element.matches(':focus-visible')),
  ).toBe(true)
  await expect(button).toHaveCSS('outline-width', '2px')
  await expect(samples).toHaveScreenshot('buttons-focus.png')
  await button.hover()
  await page.mouse.down()
  expect(await button.evaluate((element) => element.matches(':active'))).toBe(
    true,
  )
  expect(await background(button)).not.toBe(hovered)
  await expect(samples).toHaveScreenshot('buttons-pressed.png')
  await page.mouse.up()
  await page.mouse.move(0, 0)
  const solid = page.getByRole('button', { name: 'Add solid', exact: true })
  const solidRest = await background(solid)
  await solid.focus()
  await page.keyboard.down('Space')
  expect(await background(solid)).toBe(solidRest)
  expect(
    await solid.evaluate((element) => getComputedStyle(element).filter),
  ).not.toBe('none')
  await page.keyboard.up('Space')
  expect(
    await page
      .getByPlaceholder('Enter a name')
      .evaluate((element) => getComputedStyle(element, '::placeholder').color),
  ).toBe(await token(page, '--dinkster-text-muted'))
  await expect(
    page.getByRole('link', { name: 'link to another page' }),
  ).toHaveCSS('color', await token(page, '--dinkster-accent-foreground'))
  const field = page.getByLabel('Display name', { exact: true })
  await field.focus()
  await expect(field).toHaveCSS('outline-width', '2px')
  await page.getByLabel('Unchecked option').focus()
  await page.keyboard.press('Space')
  await expect(page.getByLabel('Unchecked option')).toBeChecked()
  await page.getByLabel('First choice').focus()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByLabel('Second choice')).toBeChecked()
  await page
    .getByLabel('Access', { exact: true })
    .selectOption({ label: 'Mint only' })
  await expect(page.getByLabel('Access', { exact: true })).toHaveValue(
    'Mint only',
  )
  await page.getByLabel('Selected unavailable radio').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(900)
  await expect(page.getByRole('banner')).toBeInViewport()
  await expect(
    page.getByRole('link', { name: 'Forms', exact: true }),
  ).toBeInViewport()
  await expect(page).toHaveScreenshot('frame-stays-when-scrolled.png')
})

test('menus support pointer dismissal, keyboard navigation and immediate sign out', async ({
  page,
}) => {
  await page.goto('/#messages')
  const trigger = page.getByRole('button', {
    name: 'Package actions',
    exact: true,
  })
  await trigger.click()
  await expect(
    page.getByRole('menuitem', { name: 'View package' }),
  ).toBeFocused()
  expect((await page.getByRole('menu').boundingBox())!.x).toBe(
    (await trigger.boundingBox())!.x,
  )
  await expectNoAxeViolations(page)
  await page.getByRole('menu').focus()
  await page.keyboard.press('ArrowUp')
  await expect(
    page.getByRole('menuitem', { name: 'Remove package' }),
  ).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitem', { name: 'Add version' }),
  ).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(
    page.getByRole('menuitem', { name: 'Remove package' }),
  ).toBeFocused()
  await expect(page).toHaveScreenshot('menu-open.png', { fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(trigger).toBeFocused()
  const unavailable = page.getByRole('button', {
    name: 'Unavailable actions',
    exact: true,
  })
  await unavailable.click()
  await expect(
    page.getByRole('menu', { name: 'Unavailable actions' }),
  ).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(unavailable).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await trigger.click()
  await page.getByRole('heading', { level: 1 }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await trigger.click()
  await trigger.click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await trigger.focus()
  await page.keyboard.press('ArrowUp')
  await expect(
    page.getByRole('menuitem', { name: 'Remove package' }),
  ).toBeFocused()
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(
    page.getByText('Package viewed', { exact: true }).first(),
  ).toBeVisible()
  const account = page
    .getByRole('banner')
    .getByRole('button', { name: 'Account menu: Alex Morgan' })
  await expect(account).toContainText('Alex Morgan')
  await account.click()
  const accountMenu = page.getByRole('menu', { name: 'Account menu' })
  await expect(accountMenu).toHaveAccessibleDescription(
    'Alex Morgan alex@example.test',
  )
  const accountBounds = (await accountMenu.boundingBox())!
  const accountTrigger = (await account.boundingBox())!
  expect(accountBounds.x + accountBounds.width).toBe(
    accountTrigger.x + accountTrigger.width,
  )
  await expect(page).toHaveScreenshot('account-menu-open.png')
  await expectNoAxeViolations(page)
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(
    page.getByText('Signed out', { exact: true }).first(),
  ).toBeVisible()
  await page.setViewportSize({ width: 390, height: 900 })
  await trigger.click()
  const bounds = await page.getByRole('menu').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await expect(page).toHaveScreenshot('mobile-menu-open.png', {
    fullPage: true,
  })
})

test('forms retain edits after refusal and disable save after undo and successful save', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
  await page.goto('/#forms')
  const name = page.getByLabel('Display name', { exact: true })
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await expect(save).toBeDisabled()
  await name.fill('New name')
  await expect(save).toBeEnabled()
  await name.fill('Alex Morgan')
  await expect(save).toBeDisabled()
  await name.fill('Another name')
  await page.getByRole('button', { name: 'Undo changes' }).click()
  await expect(name).toHaveValue('Alex Morgan')
  await expect(save).toBeDisabled()
  await page.getByLabel('Reject the next save').check()
  await name.fill('Retained name')
  await save.focus()
  await page.keyboard.press('Enter')
  await expect(save).toBeDisabled()
  await expect(save).toBeFocused()
  await page.clock.runFor(600)
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(name).toHaveValue('Retained name')
  await expect(save).toBeEnabled()
  await expect(save).toBeFocused()
  await expect(page).toHaveScreenshot('form-rejected.png', { fullPage: true })
  await page.getByLabel('Reject the next save').uncheck()
  await page.getByLabel('Refuse the next name as taken').check()
  await save.click()
  await page.clock.runFor(600)
  await expect(page.getByText('That name is taken.')).toBeVisible()
  await expect(page.getByText('Changes could not be saved')).toHaveCount(1)
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await save.click()
  await page.clock.runFor(600)
  await expect(page.getByText('Changes could not be saved')).toHaveCount(0)
  await expect(name).toHaveValue('Retained name')
  await expect(save).toBeEnabled()
  await expect(page).toHaveScreenshot('form-field-refused.png', {
    fullPage: true,
  })
  await page.getByLabel('Refuse the next name as taken').uncheck()
  await save.focus()
  await page.keyboard.press('Enter')
  await page.clock.runFor(600)
  await expect(page.getByText('No unsaved changes')).toBeVisible()
  await expect(save).toBeDisabled()
  await expect(save).toBeFocused()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByLabel('Show my email on my profile').check()
  await expect(save).toBeEnabled()
  await page.getByLabel('Show my email on my profile').uncheck()
  await expect(save).toBeDisabled()
})

test('toasts expire and can be dismissed; notices cannot be dismissed', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.goto('/#messages')
  await expect(page.getByRole('note').getByRole('button')).toHaveCount(0)
  const region = page.locator('.dinkster-toast')
  await expect(region).toHaveRole('status')
  await expect(region).toBeEmpty()
  await page.getByRole('button', { name: 'Show success toast' }).click()
  await expect(region).toHaveText('Changes saved')
  await expect(page).toHaveScreenshot('toast-visible.png', { fullPage: true })
  await expectNoAxeViolations(page)
  await page.getByRole('button', { name: 'Dismiss notification' }).focus()
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
  await page.clock.fastForward(6000)
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toBeFocused()
  await page.getByRole('button', { name: 'Show success toast' }).focus()
  await page.clock.fastForward(4000)
  await expect(region).toHaveText('Changes saved')
  await page.clock.fastForward(1000)
  await expect(region).toBeEmpty()
  await page.getByRole('button', { name: 'Show success toast' }).click()
  await region.hover()
  await page.clock.fastForward(6000)
  await expect(region).toHaveText('Changes saved')
  await page.mouse.move(0, 0)
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await page.getByRole('button', { name: 'Dismiss error' }).click()
  await expect(page.getByRole('alert')).toHaveCount(1)
  await page.getByRole('button', { name: 'Show success toast' }).click()
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toBeVisible()
  await page.clock.fastForward(4000)
  await page.getByRole('button', { name: 'Show success toast' }).click()
  await page.clock.fastForward(4999)
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toBeVisible()
  await page.clock.fastForward(1)
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Show success toast' }).click()
  await page.getByRole('button', { name: 'Dismiss notification' }).click()
  await expect(
    page.getByRole('button', { name: 'Dismiss notification' }),
  ).toHaveCount(0)
})

test('dialog contains focus, Escape restores its opener and removal requires confirmation', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
  await page.goto('/#confirmations')
  const opener = page.getByRole('button', { name: 'Review removal' })
  await opener.click()
  const dialog = page.getByRole('dialog', { name: 'Remove item?' })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Remove item', exact: true }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('dialog-open.png', { fullPage: true })
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  expect(
    await dialog.evaluate((element) =>
      element.contains(document.activeElement),
    ),
  ).toBe(true)
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await opener.click()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toHaveCount(0)
  await opener.click()
  const remove = dialog.getByRole('button', {
    name: 'Remove item',
    exact: true,
  })
  await remove.focus()
  await page.keyboard.press('Enter')
  await expect(remove).toBeDisabled()
  await expect(remove).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  for (let press = 0; press < 4; press += 1) await page.keyboard.press('Escape')
  await expect(dialog).toBeVisible()
  await expect(page).toHaveScreenshot('dialog-pending.png', { fullPage: true })
  await page.clock.runFor(600)
  await expect(dialog).toHaveCount(0)
  await expect(
    page.getByText('Item removed', { exact: true }).first(),
  ).toBeVisible()
  await page.clock.runFor(5000)
  await expect(page.locator('.dinkster-toast')).toBeEmpty()
  await page.setViewportSize({ width: 390, height: 900 })
  await opener.click()
  await expect(dialog).toBeVisible()
  await expect(page).toHaveScreenshot('dialog-open-390.png')
})

test('a refused save and an open dialog have no accessibility violations', async ({
  page,
}) => {
  await page.goto('/#forms')
  await page.getByLabel('Reject the next save').check()
  await page.getByLabel('Refuse the next name as taken').check()
  await page.getByLabel('Display name', { exact: true }).fill('Taken name')
  const save = page.getByRole('button', { name: 'Save', exact: true })
  await save.click()
  await expect(page.getByText('Changes could not be saved')).toBeVisible()
  await page.getByLabel('Reject the next save').uncheck()
  await save.click()
  await expect(page.getByText('That name is taken.')).toBeVisible()
  await expectNoAxeViolations(page)
  await page.goto('/#confirmations')
  await page.getByRole('button', { name: 'Keep the key' }).click()
  await expect(page.getByText('Key kept').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Review removal' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await expectNoAxeViolations(page)
})

test('mobile keyboard navigation moves focus into the page while desktop navigation keeps its link focused', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/#controls')
  await page.getByRole('button', { name: 'Toggle navigation' }).click()
  const forms = page.getByRole('link', { name: 'Forms', exact: true })
  await forms.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('navigation')).toBeHidden()
  await expect(page.getByRole('main')).toBeFocused()
  await expect(
    page.getByRole('heading', { name: 'Forms', exact: true }),
  ).toBeVisible()
  await expect(
    page.getByText('Loading selected page', { exact: true }),
  ).toBeHidden()
  await expect(page.getByRole('main')).toBeFocused()
  await page.screenshot({
    path: 'test-results/captures/mobile-navigation-page-focus.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  const controls = page.getByRole('link', {
    name: 'Buttons and fields',
    exact: true,
  })
  await controls.focus()
  await page.keyboard.press('Enter')
  await expect(controls).toBeFocused()
})

test('mobile navigation selects immediately and closes; desktop selection does not change label weight', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'))
  await page.setViewportSize({ width: 390, height: 900 })
  await page.goto('/#controls')
  const toggle = page.getByRole('button', { name: 'Toggle navigation' })
  await toggle.click()
  await expect(page.getByRole('navigation')).toBeVisible()
  const toggleBounds = (await toggle.boundingBox())!
  const navigationBounds = (await page
    .locator('.dinkster-sidebar')
    .boundingBox())!
  expect(navigationBounds.y - (toggleBounds.y + toggleBounds.height)).toBe(4)
  await expect(page).toHaveScreenshot('mobile-navigation.png', {
    fullPage: true,
  })
  await page.keyboard.press('Escape')
  await expect(toggle).toBeFocused()
  await expect(page.getByRole('navigation')).toBeHidden()
  await toggle.click()
  await page.getByRole('link', { name: 'Confirmations', exact: true }).click()
  await page.clock.runFor(600)
  await toggle.click()
  const panel = (await page.locator('.dinkster-sidebar').boundingBox())!
  const links = (await page.getByRole('navigation').boundingBox())!
  expect(panel.height).toBeLessThan(links.height + 40)
  await page.getByRole('button', { name: 'Review removal' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await page.getByRole('link', { name: 'Forms', exact: true }).click()
  await expect(
    page.getByText('Loading selected page', { exact: true }),
  ).toBeVisible()
  await expect(page).toHaveScreenshot('mobile-page-loading.png', {
    fullPage: true,
  })
  await page.clock.runFor(600)
  await expect(
    page.getByRole('heading', { name: 'Forms', exact: true }),
  ).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('navigation')).toBeHidden()
  await page.setViewportSize({ width: 1280, height: 900 })
  const forms = page.getByRole('link', { name: 'Forms', exact: true })
  const lists = page.getByRole('link', { name: 'Lists and tables' })
  await expect(forms).toHaveAttribute('aria-current', 'page')
  const weight = await forms.evaluate(
    (element) => getComputedStyle(element).fontWeight,
  )
  expect(
    await lists.evaluate((element) => getComputedStyle(element).fontWeight),
  ).toBe(weight)
})
