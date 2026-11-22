import { fileURLToPath } from 'node:url'
import { expect, nativeTest as test } from './fixtures.js'

const chromeInstaller = `/@fs${fileURLToPath(new URL('../../site/src/desktop-chrome.tsx', import.meta.url))}`

test('Desktop header keeps app controls and identity clear of native buttons', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  await page.evaluate(async (path) => {
    const { install } = await import(/* @vite-ignore */ path)
    install({ title: 'Dinkster', platform: 'linux', theme: 'dark', qa: true, development: true })
  }, chromeInstaller)
  await page.addStyleTag({ content: '.topbar[data-desktop-chrome] { padding-right: 148px }' })
  const bar = page.locator('.topbar')
  for (const width of [1100, 769, 768, 600, 521, 520, 390]) {
    await page.setViewportSize({ width, height: 700 })
    expect((await bar.boundingBox())!.height).toBe(56)
    for (const id of ['topbar-search', 'rail-toggle', 'image-documents-button', 'projects-button', 'collab-button'])
      await expect(bar.getByTestId(id)).toBeVisible()
    expect((await bar.getByTestId('topbar-search').boundingBox())!.width).toBeGreaterThanOrEqual(32)
    await expect(bar.locator('.dinkster-window-identity')).toHaveText('[QA]Development')
    const controls = await bar.locator('button:visible, .dinkster-window-identity').evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
      }),
    )
    await bar.screenshot({ path: `test-results/captures/desktop-app-header-${width}.png` })
    for (const [index, control] of controls.entries()) {
      expect(control.left).toBeGreaterThanOrEqual(12)
      expect(control.right).toBeLessThanOrEqual(width - 148)
      expect(control.top).toBeGreaterThanOrEqual(0)
      expect(control.bottom).toBeLessThanOrEqual(56)
      for (const previous of controls.slice(0, index))
        expect(control.right <= previous.left || control.left >= previous.right ||
          control.bottom <= previous.top || control.top >= previous.bottom).toBe(true)
    }
  }
  await page.getByTestId('topbar-search').click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await bar.locator('.app-menu-button').click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
})
