import { fileURLToPath } from 'node:url'
import { expect, nativeTest as test } from './fixtures.js'

const chromeInstaller = `/@fs${fileURLToPath(new URL('../../site/src/desktop-chrome.tsx', import.meta.url))}`

for (const theme of ['dark', 'light'] as const) {
  test(`Desktop header keeps app controls clear of native buttons in ${theme} theme`, async ({ page }) => {
    await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
    await page.route('/object_info', (route) => route.fulfill({ json: {} }))
    await page.routeWebSocket('/ws*', () => {})
    await page.goto('/')
    await expect(page.getByTestId('queue-button')).toBeEnabled()
    await page.evaluate(async ({ path, theme }) => {
      const { install } = await import(/* @vite-ignore */ path)
      install({ title: 'Dinkster', platform: 'linux', theme, qa: true, development: true })
    }, { path: chromeInstaller, theme })
    await page.addStyleTag({ content: '.topbar[data-desktop-chrome] { padding-right: 148px }' })
    const bar = page.locator('.topbar')
    for (const state of ['idle', 'queued', 'running', 'pending'] as const) {
      if (state !== 'idle') {
        await page.evaluate((status) => {
          const app = window.__dinksterTest!.app
          const tab = app.activeTab()!
          const ref = { connection: app.backends.get()[0]!.id, prompt: 'desktop-header-layout' }
          if (status === 'queued') {
            const result = app.compileTab(tab)
            if (!result?.ok) throw new Error('Header fixture did not compile')
            app.store.register(ref, result.artifact, Date.now())
          } else if (status === 'running') {
            app.store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
          } else {
            const key = [...app.store.executions.get()].find(([, entry]) => entry.ref.prompt === ref.prompt)![0]
            ;(app as typeof app & { cancellingExecutions: { set(value: Set<string>): void } })
              .cancellingExecutions.set(new Set([key]))
          }
        }, state)
        await expect(bar.getByTestId('cancel-execution')).toBeVisible()
        await expect(bar.getByTestId('cancel-execution')).toHaveAttribute('aria-label', 'Cancel run')
        if (state === 'pending') await expect(bar.getByTestId('cancel-execution')).toBeDisabled()
      }
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
        await bar.screenshot({ path: `test-results/captures/desktop-app-header-${theme}-${state}-${width}.png` })
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
}
