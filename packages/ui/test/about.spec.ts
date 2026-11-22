import { expect, test } from '../../e2e/visual.js'
import axe from 'axe-core'

for (const width of [1280, 390]) {
  test(`About identity and bundled wordmarks at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/#desktop-about')
    await page.addStyleTag({
      content:
        '.dinkster-window-chrome { display:grid; padding:8px; min-height:48px }',
    })
    for (const platform of ['win32', 'linux', 'darwin']) {
      const chrome = page.locator(
        `.dinkster-window-chrome[data-platform="${platform}"]`,
      )
      await expect(chrome).toHaveText('Dinkster Desktop[QA]Development')
      const preview = chrome.locator('..')
      const marking = chrome.locator('.dinkster-window-identity')
      await expect(marking).toBeVisible()
      const markBounds = (await marking.boundingBox())!
      const toastBounds = (await preview.getByRole('status').boundingBox())!
      expect(markBounds.y + markBounds.height).toBeLessThan(toastBounds.y)
      await expect(preview.getByRole('alert')).toBeVisible()
      expect((await chrome.boundingBox())?.height).toBe(56)
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
  for (const width of [1440, 929, 928, 873, 872, 793, 792, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const section of await sections.all()) {
      const bar = section.locator('header')
      const platform = await bar.getAttribute('data-platform')
      const left = platform === 'darwin' ? 92 : 12
      const right = width - (platform === 'win32' ? 148 : 12)
      const compact = right - left <= 768
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
      expect((await bar.boundingBox())!.height).toBe(56)
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
  for (const width of [1440, 390]) {
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
    path: 'test-results/captures/window-toolbar-wordmark-pending-390.png',
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

test('Window toolbar keeps actions and identity inside native reservations', async ({
  page,
}) => {
  await page.goto('/#window-toolbar')
  await page.addStyleTag({
    content:
      '.dinkster-window-toolbar-host[data-platform="win32"] { padding-right:148px }',
  })
  const sections = page.locator('section[aria-label]')
  await expect(sections).toHaveCount(18)
  for (const state of ['idle', 'running', 'pending']) {
    await page.getByLabel('Execution state').selectOption(state)
    for (const width of [1440, 929, 928, 873, 872, 793, 792, 390]) {
      await page.setViewportSize({ width, height: 900 })
      for (const section of await sections.all()) {
        if (
          width !== 1440 &&
          width !== 390 &&
          !(await section.getAttribute('aria-label'))!.startsWith('qa dark ')
        )
          continue
        const bar = section.locator('header')
        const bounds = (await bar.boundingBox())!
        expect(bounds.height).toBe(56)
        const platform = await bar.getAttribute('data-platform')
        const left = platform === 'darwin' ? 92 : 12
        const right = width - (platform === 'win32' ? 148 : 12)
        const search = bar.getByRole('button', { name: 'Search', exact: true })
        const compact = right - left <= 768
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
        for (const metadata of await bar
          .locator(
            '.dinkster-window-identity, .dinkster-window-toolbar-service',
          )
          .all()) {
          const rect = (await metadata.boundingBox())!
          const action = (await search.boundingBox())!
          if (compact)
            expect(rect.y + rect.height).toBeLessThanOrEqual(action.y)
          else expect(rect.y + rect.height).toBeGreaterThan(action.y)
        }
        const controls = bar.locator(
          'button, .dinkster-window-identity, .dinkster-window-toolbar-service',
        )
        const rectangles = await controls.evaluateAll((nodes) =>
          nodes.map((node) => {
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
          expect(rect.bottom).toBeLessThanOrEqual(bounds.y + 56)
          for (const previous of rectangles.slice(0, index))
            expect(
              rect.right <= previous.left ||
                rect.left >= previous.right ||
                rect.bottom <= previous.top ||
                rect.top >= previous.bottom,
              JSON.stringify({ state, width, platform, rect, previous }),
            ).toBe(true)
        }
        if (width === 390 || width === 1440)
          for (const label of [
            'Dinkster',
            'Search',
            'Projects',
            'Images',
            'Collaboration',
            'Toggle panels',
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
      if ((state === 'idle' && width === 1440) || width === 390) {
        const name =
          state === 'idle'
            ? 'production dark win32'
            : state === 'running'
              ? 'qa dark win32'
              : 'custom light win32'
        await page.getByRole('region', { name, exact: true }).screenshot({
          path: `test-results/captures/window-toolbar-${state}-${width}.png`,
        })
        if (width === 390 && state === 'pending')
          await page
            .getByRole('region', { name: 'custom light darwin', exact: true })
            .screenshot({
              path: 'test-results/captures/window-toolbar-mac-pending-390.png',
            })
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
