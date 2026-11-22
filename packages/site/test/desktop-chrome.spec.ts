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

test('portable Desktop chrome keeps host identity inside a shared toolbar', async ({
  page,
}) => {
  const artifact = JSON.parse(
    await readFile(new URL('desktop-chrome.json', distribution), 'utf8'),
  )
  const installer = await readFile(
    new URL(artifact.installer, distribution),
    'utf8',
  )
  const content =
    '<div class="dinkster-window-toolbar"><div class="dinkster-window-toolbar-brand"><button type="button" aria-label="Menu">M</button></div><div class="dinkster-window-toolbar-search"><button type="button" aria-label="Search">S</button></div><div class="dinkster-window-toolbar-actions"><button type="button" onclick="this.textContent=\'Clicked\'">Action</button></div><span class="dinkster-window-toolbar-service">QA services</span></div>'
  await page.route('**/*', (route) => route.abort())
  const requests: string[] = []
  page.on('request', (request) => requests.push(request.url()))
  await page.setContent(
    `<!doctype html><html><head><style>body {margin:0}</style></head><body><div id="application"><header class="dinkster-desktop-bar dinkster-window-toolbar-host" data-platform="linux" data-theme="light">${content}</header></div><main>Original content</main></body></html>`,
  )
  await page.addStyleTag({ content: artifact.css })
  await page.addStyleTag({
    content:
      '.dinkster-window-toolbar-host[data-platform="win32"] { padding-right:148px }',
  })
  await page.addScriptTag({ content: installer })
  const bar = page.locator('header')
  for (const platform of ['win32', 'linux', 'darwin'] as const) {
    for (const theme of ['dark', 'light'] as const) {
      for (const width of [1100, 390]) {
        await page.setViewportSize({ width, height: 300 })
        await page.evaluate(
          ({ platform, theme }) =>
            window.DinksterDesktopChrome.install({
              title: 'Host toolbar',
              platform,
              theme,
              qa: true,
              development: true,
            }),
          { platform, theme },
        )
        await expect(page.locator('header')).toHaveCount(1)
        await expect(page.locator('.dinkster-window-fallback')).toHaveCount(0)
        await expect(bar.locator('.dinkster-window-identity')).toHaveCount(1)
        await expect(
          bar.locator('.dinkster-window-toolbar .dinkster-window-identity'),
        ).toHaveText('[QA]Development')
        const bounds = (await bar.boundingBox())!
        expect(bounds.height).toBe(56)
        const identity = (await bar
          .locator('.dinkster-window-identity')
          .boundingBox())!
        const service = (await bar.getByText('QA services').boundingBox())!
        const action = (await bar
          .getByRole('button', { name: 'Action', exact: true })
          .boundingBox())!
        const left = platform === 'darwin' ? 92 : 12
        for (const rect of [identity, service, action]) {
          expect(rect.x).toBeGreaterThanOrEqual(left)
          expect(rect.x + rect.width).toBeLessThanOrEqual(
            width - (platform === 'win32' ? 148 : 12),
          )
          expect(rect.y).toBeGreaterThanOrEqual(bounds.y)
          expect(rect.y + rect.height).toBeLessThanOrEqual(bounds.y + 56)
        }
        expect(service.x + service.width).toBeLessThanOrEqual(identity.x)
        if (width === 390) {
          expect(identity.y + identity.height).toBeLessThanOrEqual(action.y)
          expect(service.y + service.height).toBeLessThanOrEqual(action.y)
        } else expect(identity.y + identity.height).toBeGreaterThan(action.y)
        await page.screenshot({
          path: `test-results/captures/chrome-toolbar-${platform}-${theme}-${width}.png`,
        })
        await bar.getByRole('button', { name: 'Action', exact: true }).click()
        await expect(bar.getByRole('button', { name: 'Clicked' })).toBeVisible()
        await bar
          .locator('.dinkster-window-toolbar')
          .evaluate((grid, content) => {
            grid.outerHTML = content
          }, content)
        await expect(
          bar.locator('.dinkster-window-toolbar .dinkster-window-identity'),
        ).toHaveText('[QA]Development')
      }
    }
  }
  await bar.evaluate((node) => node.remove())
  await expect(page.locator('.dinkster-window-fallback')).toHaveCount(1)
  await page.evaluate((content) => {
    const replacement = document.createElement('header')
    replacement.className = 'dinkster-desktop-bar dinkster-window-toolbar-host'
    replacement.innerHTML = content
    document.body.append(replacement)
  }, content)
  await expect(page.locator('.dinkster-window-fallback')).toHaveCount(0)
  await expect(
    page.locator('.dinkster-window-toolbar .dinkster-window-identity'),
  ).toHaveText('[QA]Development')
  await expect(page.locator('main')).toHaveText('Original content')
  expect(requests).toEqual([])
})

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
        dark: { color: '#141C1D', symbolColor: '#F0F5F5', height: 56 },
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
