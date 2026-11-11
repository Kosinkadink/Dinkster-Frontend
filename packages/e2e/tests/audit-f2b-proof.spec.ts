import { expect, test } from './fixtures.js'

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-f2b-proof', schemaWire: 1 },
  packs: {},
  nodes: {},
}

test.beforeEach(async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
})

test('live-tab backend target keeps keyboard, focus, per-tab, frozen, and removal contracts', async ({ page }) => {
  await page.route('http://second.test/api/nodes*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(catalog),
  }))
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  const firstTab = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.id)
  await page.evaluate(() => window.__dinksterTest!.app.addBackend('http://second.test', 'Second', true, 'dinkster'))

  const target = page.getByRole('combobox', { name: 'Backend this tab queues to' })
  await expect(target).toBeVisible()
  await target.focus()
  await target.press('Enter')
  await target.press('End')
  await target.press('Escape')
  await expect(target).toHaveAttribute('data-selected-id', 'local')
  await expect(target).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.tabTargets.get().size)).toBe(0)

  await target.press('Enter')
  await target.press('End')
  await target.press('Enter')
  const secondId = await page.evaluate(() => window.__dinksterTest!.app.backends.get()[1]!.id)
  await expect(target).toHaveAttribute('data-selected-id', secondId)
  await expect(target).toBeFocused()
  expect(await page.evaluate((tabId) => window.__dinksterTest!.app.tabTargets.get().get(tabId), firstTab)).toBe(secondId)

  await page.getByTestId('new-tab').click()
  await expect(target).toHaveAttribute('data-selected-id', 'local')
  await page.locator(`.tab[data-tab-id="${firstTab}"] .tab-select`).click()
  await expect(target).toHaveAttribute('data-selected-id', secondId)

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const live = app.activeTab()!
    const frozen = {
      ...live,
      id: 'frozen:select-proof',
      execution: { connection: app.backends.get()[1]!.id, prompt: 'select-proof' },
    }
    app.tabs.update((tabs: readonly unknown[]) => [...tabs, frozen])
    app.activeTabId.set(frozen.id)
  })
  await expect(target).toHaveCount(0)

  await page.evaluate((tabId) => window.__dinksterTest!.app.activeTabId.set(tabId), firstTab)
  await expect(target).toHaveAttribute('data-selected-id', secondId)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.removeBackend(app.backends.get()[1]!.id, false)
  })
  await expect(target).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.tabTargets.get().size)).toBe(0)
})
