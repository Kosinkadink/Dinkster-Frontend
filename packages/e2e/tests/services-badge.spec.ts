import { DINKSTER_SCHEMA_WIRE_VERSION } from '@dinkster/core'
import { expect, nativeTest as test } from './fixtures.js'

for (const panel of [false, true]) {
  test(`services badge follows the engine in ${panel ? 'panel' : 'main'} windows`, async ({ page }) => {
    let name = 'qa'
    await page.route('/supervisor/status', (route) => route.fulfill({ status: 404, body: 'no supervisor' }))
    await page.route('/api/nodes*', (route) => route.fulfill({ json: {
      epoch: 1, dinkster: { version: 'services-test', schemaWire: DINKSTER_SCHEMA_WIRE_VERSION, services: { name } }, nodes: {},
    } }))
    await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
    await page.routeWebSocket('/api/events*', () => {})
    const url = panel ? '/?dinksterPanel=problems' : '/'
    for (const [services, label] of [['qa', 'QA services'], ['custom', 'Custom services'], ['production', undefined]] as const) {
      name = services
      await page.goto(url)
      await expect.poll(() => page.evaluate(() => (window.__dinksterTest?.app.backends.get()[0]?.registry.get() as { server?: { services?: { name: string } } } | undefined)?.server?.services?.name)).toBe(services)
      await page.evaluate(() => (window.__dinksterTest!.app as unknown as { shell: { statusBarVisible: { set(value: boolean): void } } }).shell.statusBarVisible.set(false))
      const badge = page.getByTestId('services-badge')
      if (label === undefined) await expect(badge).toHaveCount(0)
      else {
        await expect(badge).toBeVisible()
        await expect(badge).toHaveText(label)
        await expect(badge.locator('..').locator('.brand-wordmark, .brand-symbol')).toBeVisible()
        const brand = await badge.locator('..').locator('.brand-wordmark, .brand-symbol').boundingBox()
        const bounds = await badge.boundingBox()
        expect(bounds!.x).toBeGreaterThanOrEqual(brand!.x + brand!.width)
      }
      await expect(page.getByTestId('status-bar')).toBeHidden()
    }
  })
}
