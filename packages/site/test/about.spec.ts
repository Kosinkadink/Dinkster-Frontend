import { expect, test } from '../../e2e/visual.js'

for (const theme of ['dark', 'light'] as const) {
  test(`portable About assets and live theme at ${theme}`, async ({
    page,
    baseURL,
  }) => {
    await page.emulateMedia({ colorScheme: theme })
    await page.setViewportSize({ width: 520, height: 320 })
    await page.addInitScript(() => {
      const violations: string[] = []
      Object.assign(window, { violations })
      document.addEventListener('securitypolicyviolation', (event) => {
        violations.push(event.violatedDirective)
      })
    })
    await page.route('**/portable/**', (route) =>
      route.continue({
        url: route.request().url().replace('/portable/', '/'),
      }),
    )
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await page.goto(
      '/portable/about.html?title=Dinkster%20Desktop%20%5BQA%5D&version=0.2.8',
    )
    await expect(page).toHaveTitle('Dinkster Desktop [QA]')
    const heading = page.getByRole('heading', {
      name: 'Dinkster Desktop [QA]',
      exact: true,
    })
    await expect(heading).toBeVisible()
    await expect(page.getByText('Version 0.2.8', { exact: true })).toBeVisible()
    const image = page.getByRole('img', { name: 'Dinkster', exact: true })
    await expect(image).toHaveAttribute('src', new RegExp(`color-${theme}`))
    await expect
      .poll(() =>
        image.evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0)
    for (const width of [520, 390]) {
      await page.setViewportSize({ width, height: 320 })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true)
      await page.screenshot({
        path: `test-results/captures/portable-about-${theme}-${width}.png`,
        fullPage: true,
      })
    }
    await page.emulateMedia({
      colorScheme: theme === 'dark' ? 'light' : 'dark',
    })
    await expect(image).toHaveAttribute(
      'src',
      new RegExp(`color-${theme === 'dark' ? 'light' : 'dark'}`),
    )
    expect(
      await page.evaluate(
        () => (window as unknown as { violations: string[] }).violations,
      ),
    ).toEqual([])
    expect(
      requests.every((url) => new URL(url).origin === new URL(baseURL!).origin),
    ).toBe(true)
    await page.goto(
      '/portable/about.html?title=%3Cscript%3Eexample%3C%2Fscript%3E&version=test',
    )
    await expect(page.getByRole('heading')).toHaveText(
      '<script>example</script>',
    )
    await expect(page.locator('main script')).toHaveCount(0)
  })
}
