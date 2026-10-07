import { expect, test } from './fixtures.js'

test('disabled features have no entry points or background requests', async ({ page }, testInfo) => {
  const featureRequests: string[] = []
  page.on('request', (request) => {
    if (/\/api\/(templates|p2p)|\/index\/templates/.test(request.url())) {
      featureRequests.push(request.url())
    }
  })
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1,
    dinkster: { version: 'disabled-feature-test', schemaWire: 1 },
    packs: {}, nodes: {},
  } }))
  await page.route('/api/settings', (route) => route.fulfill({ json: {
    features: { p2p: { enabled: false }, templates: { enabled: false } },
    categories: { granted: [], available: [] }, settings: {},
  } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined,
  )).toBe(true)
  await expect(page.getByRole('button', { name: 'Browse starter templates' })).toHaveCount(0)
  await expect(page.getByTestId('template-gallery')).toHaveCount(0)
  await expect(page.getByTestId('p2p-sidebar-toggle')).toHaveCount(0)
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return {
      p2pPanel: app.panels.get('p2p') !== undefined,
      templateCommand: app.commands.get('workflow.openTemplateGallery') !== undefined,
      registrySetting: app.settings.list().some((setting) => setting.id === 'templates.registryUrl'),
    }
  })).toEqual({ p2pPanel: false, templateCommand: false, registrySetting: false })
  await page.screenshot({ path: testInfo.outputPath('disabled-default.png'), animations: 'disabled' })
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> Open template gallery')
  await expect(page.locator('[data-provider="core.commands"]').getByRole('option', { name: 'Open template gallery' })).toHaveCount(0)
  expect(featureRequests).toEqual([])
})
