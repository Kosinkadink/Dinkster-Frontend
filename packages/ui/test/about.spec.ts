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
      await expect(chrome).toHaveText('Dinkster Desktop [QA]')
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
