import { readFile } from 'node:fs/promises'
import { expect, test } from '../../e2e/visual.js'
import type { DesktopChromeOptions } from '../src/desktop-chrome.js'

const distribution = new URL('../dist/', import.meta.url)

declare global {
  interface Window {
    DinksterDesktopChrome: {
      install(options: DesktopChromeOptions): void
    }
  }
}

for (const existing of [false, true]) {
  test(`portable Desktop chrome preserves content with ${existing ? 'an existing' : 'a fallback'} bar`, async ({
    page,
  }) => {
    const artifact = JSON.parse(
      await readFile(new URL('desktop-chrome.json', distribution), 'utf8'),
    )
    const installer = await readFile(
      new URL(artifact.installer, distribution),
      'utf8',
    )
    expect(artifact.format).toBe('dinkster.desktop-chrome/1')
    expect(artifact.native).toEqual({
      overlay: {
        dark: { color: '#1C1F23', symbolColor: '#F2F4F5', height: 56 },
        light: { color: '#FFFFFF', symbolColor: '#20252A', height: 56 },
      },
      trafficLightPosition: { x: 14, y: 16 },
    })
    const requests: string[] = []
    page.on('request', (request) => requests.push(request.url()))
    await page.route('**/*', (route) => route.abort())
    await page.setContent(
      `<!doctype html><html><head><style>body {margin:0} main {font:31px serif} header {display:flex} button {margin-left:auto}</style></head><body>${existing ? '<header class="topbar"><span>Engine title</span><button type="button" onclick="this.textContent=\'Clicked\'">Existing control</button></header>' : ''}<main>Original content</main></body></html>`,
    )
    await page.addStyleTag({ content: artifact.css })
    await page.addStyleTag({
      content: '.topbar {display:grid;grid-template-columns:1fr 1fr;padding:8px;min-height:48px;background:white}',
    })
    await page.addScriptTag({ content: installer })
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const theme of ['dark', 'light'] as const) {
        for (const width of [1100, 390]) {
          await page.setViewportSize({ width, height: 700 })
          await page.evaluate(
            ({ platform, theme }) =>
              window.DinksterDesktopChrome.install({
                title: 'Dinkster <Desktop>',
                platform,
                theme,
                qa: true,
                development: true,
              }),
            { platform, theme },
          )
          const bar = page.locator('[data-desktop-chrome]')
          await expect(bar).toHaveCount(1)
          await expect(bar).toHaveCSS('min-height', '56px')
          await expect(bar).toHaveCSS(
            'background-color',
            theme === 'dark' ? 'rgb(28, 31, 35)' : 'rgb(255, 255, 255)',
          )
          await expect(bar).toHaveCSS('font-family', '"Noto Sans", sans-serif')
          await expect(bar).toHaveCSS('-webkit-app-region', 'drag')
          await expect(bar).toHaveCSS(
            'padding-left',
            platform === 'darwin' ? '92px' : '12px',
          )
          await expect(bar.locator('.dinkster-window-identity')).toHaveText(
            '[QA]Development',
          )
          const bounds = (await bar.boundingBox())!
          expect(bounds.height).toBe(56)
          await expect(bar).toHaveCSS('padding-top', '0px')
          await expect(bar).toHaveCSS('padding-bottom', '0px')
          const identity = (await bar
            .locator('.dinkster-window-identity')
            .boundingBox())!
          expect(identity.x).toBeGreaterThanOrEqual(bounds.x)
          expect(identity.x + identity.width).toBeLessThanOrEqual(
            bounds.x + bounds.width,
          )
          expect(identity.y + identity.height).toBeLessThanOrEqual(
            bounds.y + bounds.height,
          )
          await expect(page.locator('main')).toHaveCSS('font-size', '31px')
          if (existing) {
            await expect(page.getByText('Engine title')).toBeVisible()
            const control = page.getByRole('button')
            await control.click()
            await expect(control).toHaveText('Clicked')
          } else {
            await expect(bar.locator('.dinkster-brand-title')).toHaveText(
              'Dinkster <Desktop>',
            )
            await expect
              .poll(() =>
                bar
                  .locator('img')
                  .evaluate(
                    (image) => (image as HTMLImageElement).naturalWidth,
                  ),
              )
              .toBeGreaterThan(0)
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth,
            ),
          ).toBe(true)
          if (platform === 'darwin')
            await page.screenshot({
              path: `test-results/captures/chrome-${existing ? 'existing' : 'fallback'}-${theme}-${width}.png`,
            })
        }
      }
    }
    await page.evaluate(() => {
      document.querySelector('.topbar')?.remove()
      const late = document.createElement('header')
      late.className = 'topbar'
      late.textContent = 'Late application bar'
      document.body.prepend(late)
    })
    await expect(page.locator('.topbar[data-desktop-chrome]')).toHaveCount(1)
    await expect(page.locator('.dinkster-window-fallback')).toHaveCount(0)
    await page.locator('.topbar').evaluate((bar) => {
      bar.textContent = 'Updated application bar'
    })
    await expect(page.locator('.topbar .dinkster-window-identity')).toHaveText(
      '[QA]Development',
    )
    await page.screenshot({
      path: `test-results/captures/chrome-late-${existing ? 'existing' : 'fallback'}.png`,
    })
    await page.locator('.topbar').evaluate((bar) => bar.remove())
    await expect(page.locator('.dinkster-window-fallback')).toHaveCount(1)
    await page.evaluate(() =>
      window.DinksterDesktopChrome.install({
        title: 'Production',
        platform: 'linux',
        theme: 'dark',
      }),
    )
    await expect(page.locator('.dinkster-window-identity')).toHaveCount(0)
    await expect(page.locator('[data-desktop-chrome]')).toHaveCount(1)
    expect(requests).toEqual([])
  })
}
