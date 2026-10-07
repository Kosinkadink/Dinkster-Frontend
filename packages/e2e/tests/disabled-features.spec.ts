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
  await page.routeWebSocket('**/api/events*', () => {})
  await page.route('/api/docs*', (route) => route.fulfill({ json: { docs: [{
    pack: 'foundation', kind: 'guide', id: 'loops', defaultLocale: 'en',
    locales: { en: { title: 'Loop guide', summary: 'Learn loops without templates.', digest: `sha256:${'1'.repeat(64)}`, assets: {} } },
  }] } }))
  await page.route('/api/packs/foundation/docs/pages/*', (route) => route.fulfill({
    contentType: 'text/markdown', body: '# Loop guide\n\n```dinkster-example\ntemplate = "loop"\ncaption = "Open this workflow"\n```',
  }))
  await page.route('/api/packs', (route) => route.fulfill({ json: { packs: [] } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined,
  )).toBe(true)
  await expect(page.getByRole('button', { name: 'Browse starter templates' })).toHaveCount(0)
  await expect(page.getByTestId('template-gallery')).toHaveCount(0)
  await expect(page.getByTestId('p2p-sidebar-toggle')).toHaveCount(0)
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      panels: { get(id: string): unknown }
      commands: { get(id: string): unknown }
      settings: { list(): readonly { id: string }[] }
    }
    return {
      p2pPanel: app.panels.get('p2p') !== undefined,
      templateCommand: app.commands.get('workflow.openTemplateGallery') !== undefined,
      registrySetting: app.settings.list().some((setting) => setting.id === 'templates.registryUrl'),
    }
  })).toEqual({ p2pPanel: false, templateCommand: false, registrySetting: false })
  await page.screenshot({ path: testInfo.outputPath('disabled-default.png'), animations: 'disabled' })
  await page.getByTestId('library-toggle').click()
  await expect(page.getByTestId('library-overlay')).toBeVisible()
  await expect(page.locator('[data-source="templates"]')).toHaveCount(0)
  await page.getByTestId('library-source-select').click()
  await expect(page.getByRole('option', { name: 'Templates', exact: true })).toHaveCount(0)
  await page.mouse.move(800, 450)
  await page.screenshot({ path: testInfo.outputPath('disabled-library.png'), animations: 'disabled' })
  await page.keyboard.press('Escape')
  await page.getByTestId('learn-toggle').click()
  await expect(page.getByTestId('learn-panel')).toBeVisible()
  await page.locator('.learn-guide-card').click()
  await expect(page.getByTestId('learn-panel').locator('header').getByRole('heading', { name: 'Loop guide' })).toBeVisible()
  await expect(page.locator('.dinkster-markdown-template')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('disabled-learn.png'), animations: 'disabled' })
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> Open template gallery')
  await expect(page.locator('[data-provider="core.commands"]').getByRole('option', { name: 'Open template gallery' })).toHaveCount(0)
  expect(featureRequests).toEqual([])
})
