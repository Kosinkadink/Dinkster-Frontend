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
  await expect(one).toHaveText('1')
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

test('solid buttons keep readable text from the first enabled frame', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/#controls')
  const luminance = (color: string) => {
    const channels = color.match(/[\d.]+/g)!.slice(0, 3).map((channel) => {
      const value = Number(channel) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  for (const theme of ['dark', 'light']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value }, theme)
    for (const role of ['Add', 'Remove', 'Neutral']) {
      const button = page.getByRole('button', { name: `${role} solid disabled`, exact: true })
      await expect(button).toBeDisabled()
      const samples = await button.evaluate(async (element: HTMLButtonElement) => {
        const samples: { color: string; background: string }[] = []
        // Flush the disabled style before enabling, then include the same frame.
        getComputedStyle(element).backgroundColor
        element.disabled = false
        for (let frame = 0; frame < 10; frame++) {
          const style = getComputedStyle(element)
          samples.push({ color: style.color, background: style.backgroundColor })
          await new Promise(requestAnimationFrame)
        }
        element.disabled = true
        return samples
      })
      for (const sample of samples) {
        const colors = [luminance(sample.color), luminance(sample.background)]
        expect((Math.max(...colors) + 0.05) / (Math.min(...colors) + 0.05), `${theme} ${role}: ${JSON.stringify(sample)}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  }
})

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
      if (section === 'lists') {
        const heading = page.locator('.storage-folder-heading').first()
        const name = await heading.locator('strong').boundingBox()
        const actions = await heading.getByRole('button', { name: 'Folder actions' }).boundingBox()
        expect(name!.x + name!.width).toBeLessThan(actions!.x)
        expect(actions!.width).toBeLessThanOrEqual(40)
        await expect(page.locator('.dinkster-empty img')).toHaveCount(0)
        await expect(
          page.getByText('No API keys yet.', { exact: true }),
        ).toBeVisible()
        await expect(
          page.getByRole('button', { name: 'Create key', exact: true }),
        ).toBeEnabled()
      }
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

test('setup feedback exposes known fractions, unknown progress and non-dismissable notice tones', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await page.goto(`/?theme=${theme}#setup-components`)
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
    for (const [label, fraction] of [['Not started', 0], ['Downloading', 0.37], ['Complete', 1]] as const) {
      const progress = page.getByRole('progressbar', { name: label, exact: true })
      await expect(progress).toHaveAttribute('aria-valuemin', '0')
      await expect(progress).toHaveAttribute('aria-valuemax', '1')
      await expect(progress).toHaveAttribute('aria-valuenow', String(fraction))
      const box = await progress.boundingBox()
      const fill = await progress.locator('rect').boundingBox()
      expect(box!.height).toBe(4)
      expect(fill!.width / box!.width).toBeCloseTo(fraction, 2)
    }
    const unknown = page.getByRole('progressbar', { name: 'Preparing', exact: true })
    await expect(unknown).not.toHaveAttribute('aria-valuenow')
    const notices = page.getByRole('heading', { name: 'Standing notices' }).locator('..')
    await expect(notices.getByRole('note')).toHaveCount(2)
    await expect(notices.getByRole('alert')).toHaveText('Setup failed. Check the connection, then try again.')
    await expect(notices.getByRole('button')).toHaveCount(0)
    for (const motion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion: motion })
      await expect(unknown.locator('svg')).toHaveCSS('animation-name', motion === 'reduce' ? 'none' : 'dinkster-progress-sweep')
      await expect(unknown.locator('svg')).toHaveCSS('opacity', motion === 'reduce' ? '0.45' : '1')
      await expect(page.getByRole('progressbar', { name: 'Complete', exact: true }).locator('svg')).toHaveCSS('opacity', '1')
      const widths = await unknown.evaluate((element) => [element.getBoundingClientRect().width, element.querySelector('svg')!.getBoundingClientRect().width])
      expect(widths[1]! / widths[0]!).toBeCloseTo(motion === 'reduce' ? 1 : 0.36, 2)
      await expect(page).toHaveScreenshot(`setup-feedback-${theme}-${motion}.png`, { fullPage: true })
    }
    await expectNoAxeViolations(page)
  }
})

test('described menu choices keep separate accessible descriptions, checks and ordinary item behavior', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(`/?theme=${theme}#setup-components`)
      await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
      const trigger = page.getByRole('button', { name: 'Change build', exact: true })
      await trigger.scrollIntoViewIfNeeded()
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      await trigger.click()
      const selected = page.getByRole('menuitemcheckbox', { name: 'Recommended build', exact: true })
      const alternative = page.getByRole('menuitemcheckbox', { name: 'Alternative build', exact: true })
      const plain = page.getByRole('menuitem', { name: 'View build information', exact: true })
      await expect(selected).toBeChecked()
      await expect(selected).toHaveAccessibleDescription('Matches the detected graphics card.')
      await expect(alternative).not.toBeChecked()
      await expect(alternative).toHaveAccessibleDescription('Use this build when your driver requires an earlier runtime.')
      await expect(plain).not.toHaveAttribute('aria-describedby')
      await expect(plain).toHaveAccessibleName('View build information')
      const labelLefts = await Promise.all([selected, alternative, plain].map((item) => item.locator('.dinkster-menu-item-label').evaluate((label) => label.getBoundingClientRect().left)))
      expect(Math.max(...labelLefts) - Math.min(...labelLefts)).toBeLessThanOrEqual(0.5)
      const text = alternative.locator('.dinkster-menu-item-description')
      const row = await alternative.boundingBox()
      const description = await text.boundingBox()
      expect(description!.y + description!.height).toBeLessThanOrEqual(row!.y + row!.height)
      await expect(page).toHaveScreenshot(`setup-menu-${theme}-${width}.png`, { fullPage: true })
      await page.keyboard.press('ArrowDown')
      await expect(alternative).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(page.getByRole('menu', { name: 'Change build' })).toHaveCount(0)
      await expect(trigger).toBeFocused()
      await expect(page.getByRole('status', { exact: true }).filter({ hasText: 'Alternative build selected' })).toBeVisible()
      await trigger.press('ArrowDown')
      await page.keyboard.press('Escape')
      await expect(trigger).toBeFocused()
    }
  }
})

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
  const frame = (await page.locator('.dinkster-shell').boundingBox())!
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
  await field.click()
  await expect(field).toHaveCSS('border-top-width', '1px')
  await expect(field).toHaveCSS(
    'border-top-color',
    await token(page, '--dinkster-text-secondary'),
  )
  await expect(field).toHaveCSS('outline-width', '0px')
  await field.press('a')
  await expect(field).toHaveCSS('outline-width', '0px')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Shift+Tab')
  await expect(field).toBeFocused()
  await expect(field).toHaveCSS('outline-width', '0px')
  await expect(field).toHaveCSS(
    'border-top-color',
    await token(page, '--dinkster-text-secondary'),
  )
  await field.click()
  await expect(field).toHaveCSS('outline-width', '0px')
  await expect(field).toHaveCSS(
    'border-top-color',
    await token(page, '--dinkster-text-secondary'),
  )
  await page.keyboard.press('Tab')
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

test('gallery field borders show focus without adopting the trial on pages', async ({
  page,
}) => {
  for (const theme of ['dark', 'light']) {
    await page.goto(`/?theme=${theme}#controls`)
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme
    }, theme)
    await page.keyboard.press('Tab')
    for (const [label, name, invalid] of [
      ['Display name', 'text', false],
      ['Notes', 'textarea', false],
      ['Access', 'select', false],
      ['Project ID', 'invalid', true],
    ] as const) {
      const field = page.getByLabel(label, { exact: true })
      await field.focus()
      await field.hover()
      await expect(field).toHaveCSS('border-top-width', '1px')
      await expect(field).toHaveCSS(
        'border-top-color',
        await token(
          page,
          invalid ? '--dinkster-danger-border' : '--dinkster-text-secondary',
        ),
      )
      await expect(field).toHaveCSS('outline-width', '0px')
      await expect(
        field.locator('xpath=ancestor::div[@class="dinkster-field"][1]'),
      ).toHaveScreenshot(`field-focus-${theme}-${name}.png`)
    }
    const disabled = page.getByLabel('Unavailable field', { exact: true })
    await disabled.focus()
    await expect(disabled).not.toBeFocused()
    await expect(disabled).toHaveCSS(
      'border-top-color',
      await token(page, '--dinkster-border-subtle'),
    )
    await page.evaluate(() => {
      delete document.documentElement.dataset.fieldFocusMark
    })
    const field = page.getByLabel('Display name', { exact: true })
    await field.focus()
    await expect(field).toHaveCSS('outline-width', '2px')
    await expect(field).toHaveCSS(
      'border-top-color',
      await token(page, '--dinkster-border-subtle'),
    )
  }
})

test('quiet text menus keep shared focus, checked selection and dismissal without a resting outline', async ({ page }) => {
  for (const theme of ['dark', 'light']) {
    await page.goto(`/?theme=${theme}#messages`)
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme }, theme)
    const section = page.getByRole('heading', { name: 'Menus', exact: true }).locator('..')
    const trigger = section.getByRole('button', { name: /^Type:/ })
    await expect(trigger).toHaveAccessibleName('Type: any type')
    await section.scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    await page.mouse.move(0, 0)
    await expect(trigger).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
    await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const outlined = page.getByRole('button', { name: 'Package actions', exact: true })
    await expect(outlined).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
    for (const property of ['min-height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'color']) {
      await expect(trigger).toHaveCSS(property, await outlined.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property))
    }
    await expect(trigger.locator('svg')).toHaveCount(1)
    await expect(page).toHaveScreenshot(`quiet-menu-${theme}-rest.png`)
    await trigger.hover()
    await expect(trigger).toHaveCSS('background-color', await token(page, '--dinkster-interaction-hover'))
    await expect(page).toHaveScreenshot(`quiet-menu-${theme}-hover.png`)
    await trigger.click()
    const any = section.getByRole('menuitemcheckbox', { name: 'Any type', exact: true })
    await expect(any).toBeChecked()
    await expect(any).toBeFocused()
    await any.hover()
    await expect(any).toHaveCSS('background-color', await token(page, '--dinkster-surface-raised'))
    await expect(trigger).toHaveCSS('background-color', await token(page, '--dinkster-interaction-hover'))
    await expect(page).toHaveScreenshot(`quiet-menu-${theme}-open.png`)
    await page.keyboard.press('Escape')
    await expect(section.getByRole('menu')).toHaveCount(0)
    await expect(trigger).toBeFocused()
    await page.mouse.move(0, 0)
    await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveCSS('outline-style', 'solid')
    await expect(page).toHaveScreenshot(`quiet-menu-${theme}-focus.png`)
    await page.keyboard.press('ArrowDown')
    await expect(any).toBeFocused()
    await expect(trigger).toHaveCSS('background-color', await token(page, '--dinkster-interaction-hover'))
    await expect(page).toHaveScreenshot(`quiet-menu-${theme}-keyboard-open.png`)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(trigger).toHaveText('Type: image')
    await expect(trigger).toBeFocused()
    await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await trigger.click()
    await expect(section.getByRole('menuitemcheckbox', { name: 'Image', exact: true })).toBeChecked()
    await trigger.hover()
    await page.mouse.down()
    await expect(trigger).toHaveCSS('background-color', await token(page, '--dinkster-interaction-pressed'))
    await page.mouse.up()
    await expect(section.getByRole('menu')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await trigger.click()
    await section.getByRole('heading').click()
    await expect(section.getByRole('menu')).toHaveCount(0)
    await expect(trigger).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await outlined.click()
    await page.mouse.move(0, 0)
    await expect(section.getByRole('menu')).toBeVisible()
    await expect(outlined).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await page.keyboard.press('Escape')
  }
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

test('wide dialogs use their own width and preserve narrow margins and dismissal', async ({
  page,
}) => {
  await page.goto('/#confirmations')
  for (const width of [1280, 800, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await page.getByRole('button', { name: 'Review removal' }).click()
    const regular = page.getByRole('dialog', { name: 'Remove item?' })
    await expect(regular).toHaveAttribute('data-size', 'default')
    const regularBounds = (await regular.boundingBox())!
    if (width >= 800) expect(regularBounds.width).toBe(480)
    else {
      expect(regularBounds.x).toBeGreaterThanOrEqual(16)
      expect(regularBounds.width).toBeGreaterThanOrEqual(width - 36)
    }
    await page.keyboard.press('Escape')
    const opener = page.getByRole('button', { name: 'Open wide dialog' })
    await opener.click()
    const wide = page.getByRole('dialog', { name: 'Diagnostics' })
    await expect(wide).toHaveAttribute('data-size', 'wide')
    const bounds = (await wide.boundingBox())!
    if (width === 1280) expect(bounds.width).toBe(960)
    else expect(bounds.width).toBeGreaterThanOrEqual(width - 36)
    expect(bounds.x).toBeGreaterThanOrEqual(16)
    expect(width - bounds.x - bounds.width).toBeGreaterThanOrEqual(16)
    expect(
      await wide.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true)
    await expect(wide.getByRole('button', { name: 'Close' })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(wide.getByRole('button', { name: 'Close' })).toBeFocused()
    await expectNoAxeViolations(page)
    if (width !== 800)
      await expect(page).toHaveScreenshot(`dialog-wide-${width}.png`)
    await page.keyboard.press('Escape')
    await expect(wide).toHaveCount(0)
    await expect(opener).toBeFocused()
    await opener.click()
    await wide.getByRole('button', { name: 'Close' }).click()
    await expect(wide).toHaveCount(0)
    await expect(opener).toBeFocused()
  }
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

test('context menus keep 12 px sides, one label column and a check column only where an item can be checked', async ({
  page,
}) => {
  await page.goto('/#context-menus')
  await page.evaluate(() => document.fonts.ready)
  const menus = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid^="context-menu-example-"]')].map((figure) => {
      const panel = figure.querySelector<HTMLElement>('[data-testid="context-menu"]')!
      const inner = panel.getBoundingClientRect()
      const border = parseFloat(getComputedStyle(panel).borderLeftWidth)
      const left = inner.left + border
      const right = inner.right - border
      const rows = [...panel.querySelectorAll<HTMLElement>('[data-testid="context-menu-item"]')]
      return {
        id: figure.dataset['testid']!.replace('context-menu-example-', ''),
        starts: [...new Set(rows.map((row) => row.firstElementChild!.getBoundingClientRect().left - left))],
        labels: [...new Set(rows.map((row) => row.querySelector('.menu-label')!.getBoundingClientRect().left - left))],
        // Rows that end in a shortcut or a submenu arrow reach the right side.
        ends: [...new Set(rows
          .filter((row) => row.querySelector('.menu-shortcut, .menu-submenu-caret'))
          .map((row) => right - row.lastElementChild!.getBoundingClientRect().right))],
        checks: panel.querySelectorAll('.menu-check').length,
        // Separators line up with the content on both sides.
        separators: [...new Set([...panel.querySelectorAll<HTMLElement>('.menu-separator')].flatMap((line) => {
          const box = line.getBoundingClientRect()
          return [box.left - left, right - box.right]
        }))],
      }
    }),
  )
  expect(menus).toEqual([
    { id: 'icons', starts: [12], labels: [34], ends: [12], checks: 0, separators: [12] },
    { id: 'no-icons', starts: [12], labels: [12], ends: [12], checks: 0, separators: [12] },
    { id: 'mixed', starts: [12], labels: [34], ends: [12], checks: 0, separators: [12] },
    { id: 'checkable', starts: [12], labels: [26], ends: [], checks: 5, separators: [] },
  ])
  await expect(
    page.getByRole('heading', { name: 'Context menus' }).locator('xpath=ancestor::section[1]'),
  ).toHaveScreenshot('context-menus.png')
})

test('the canvas corner bar keeps one width right-justified under the minimap, its menus open straight above it, and the runs list beside Run takes the outline of the bars', async ({
  page,
}) => {
  await page.goto('/#canvas-chrome')
  await page.evaluate(() => document.fonts.ready)
  await expect(page.getByTestId('canvas-chrome-gallery')).toHaveAttribute('data-ready', 'true')
  const corners = await page.evaluate(() =>
    Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-testid^="canvas-chrome-corner-"]')].map((figure) => {
      const box = (selector: string) => figure.querySelector(selector)?.getBoundingClientRect()
      const bar = box('.canvas-corner-bar')!
      const map = figure.querySelector<HTMLElement>('.minimap')!
      const menu = box('.minimap-menu, .canvas-zoom-menu')
      return [figure.dataset['testid']!.replace('canvas-chrome-corner-', ''), {
        barWidth: Math.round(bar.width),
        barHeight: Math.round(bar.height),
        barRightToMap: map.offsetParent === null ? null : Math.round(map.getBoundingClientRect().right - bar.right),
        menuGap: menu === undefined ? null : Math.round(bar.top - menu.bottom),
        menuRight: menu === undefined ? null : Math.round(bar.right - menu.right),
        mapOpacity: getComputedStyle(map).opacity,
      }]
    })),
  )
  const width = corners['small']!.barWidth
  expect(corners).toEqual({
    small: { barWidth: width, barHeight: 36, barRightToMap: 0, menuGap: null, menuRight: null, mapOpacity: '1' },
    medium: { barWidth: width, barHeight: 36, barRightToMap: 0, menuGap: null, menuRight: null, mapOpacity: '1' },
    large: { barWidth: width, barHeight: 36, barRightToMap: 0, menuGap: null, menuRight: null, mapOpacity: '1' },
    hidden: { barWidth: width, barHeight: 36, barRightToMap: null, menuGap: null, menuRight: null, mapOpacity: '1' },
    settings: { barWidth: width, barHeight: 36, barRightToMap: 0, menuGap: 6, menuRight: 0, mapOpacity: '0.4' },
    quiet: { barWidth: width, barHeight: 36, barRightToMap: 0, menuGap: null, menuRight: null, mapOpacity: '1' },
    zoom: { barWidth: width, barHeight: 36, barRightToMap: 0, menuGap: 6, menuRight: 0, mapOpacity: '0.4' },
  })
  const outlines = await page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
    const run = (id: string) => ({
      run: style(`[data-testid="canvas-chrome-run-${id}"] .workflow-queue-submit`).borderTopColor,
      list: style(`[data-testid="canvas-chrome-run-${id}"] .workflow-queue-toggle`).borderTopColor,
      runBackground: style(`[data-testid="canvas-chrome-run-${id}"] .workflow-queue-submit`).backgroundColor,
      listBackground: style(`[data-testid="canvas-chrome-run-${id}"] .workflow-queue-toggle`).backgroundColor,
    })
    return {
      bar: style('[data-testid="canvas-chrome-corner-small"] .canvas-corner-bar').borderTopColor,
      menu: style('[data-testid="canvas-chrome-corner-settings"] .minimap-menu').borderTopColor,
      fitColor: style('[data-testid="canvas-chrome-corner-small"] [data-testid="canvas-fit-view"]').color,
      listColor: style('[data-testid="canvas-chrome-run-ready"] .workflow-queue-toggle').color,
      ready: run('ready'),
      off: run('off'),
    }
  })
  expect(outlines.ready.list).toBe(outlines.bar)
  expect(outlines.menu).toBe(outlines.bar)
  expect(outlines.listColor).toBe(outlines.fitColor)
  expect(outlines.ready.run).not.toBe(outlines.bar)
  expect(outlines.off.list).toBe(outlines.ready.list)
  expect(outlines.off.listBackground).toBe(outlines.ready.listBackground)
  expect(outlines.off.run).toBe(outlines.bar)
  expect(outlines.off.runBackground).toBe('rgba(0, 0, 0, 0)')
  expect(Math.round((await page.getByTestId('canvas-chrome-run-off').locator('.workflow-queue-buttons').boundingBox())!.height)).toBe(36)
  await expect(
    page.getByRole('heading', { name: 'Canvas corner, view bar and Run' }).locator('xpath=ancestor::section[1]'),
  ).toHaveScreenshot('canvas-chrome.png')

  const zoomCell = page.getByTestId('canvas-chrome-corner-zoom')
  const zoomMenu = zoomCell.getByTestId('canvas-zoom-menu')
  await zoomMenu.getByRole('button', { name: 'Zoom in' }).click()
  await expect(zoomMenu).toBeVisible()
  await expect(zoomCell.getByTestId('canvas-zoom-level')).toHaveText('45%')
  await zoomMenu.getByRole('button', { name: 'Zoom: 45%' }).click()
  await expect(zoomCell.getByTestId('canvas-zoom-input')).toBeFocused()
  await expect(zoomCell.getByTestId('canvas-zoom-input')).toHaveValue('45')
  await page.keyboard.press('Escape')
  await expect(zoomCell.getByTestId('canvas-zoom-menu')).toBeHidden()
  const settingsCell = page.getByTestId('canvas-chrome-corner-settings')
  await page.getByRole('heading', { name: 'Canvas corner, view bar and Run' }).click()
  await expect(settingsCell.locator('.minimap-menu')).toBeHidden()
  await page.getByTestId('canvas-chrome-corner-small').getByTestId('minimap-settings').click()
  await expect(page.getByTestId('canvas-chrome-corner-small').getByTestId('minimap-toggle-nodes')).toBeInViewport()
  await page.getByTestId('canvas-chrome-corner-small').getByTestId('minimap-toggle-nodes').click()
  await expect(page.getByTestId('canvas-chrome-corner-small').getByTestId('minimap-toggle-nodes')).toHaveAttribute('aria-checked', 'false')
})
