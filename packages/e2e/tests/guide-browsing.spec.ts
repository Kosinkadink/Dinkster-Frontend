import { expect, test } from '@playwright/test'
import { auditLayout } from './ui-audit.js'
import { evidencePath } from './evidence-output.js'

const GUIDE_DIGEST = `sha256:${'a'.repeat(64)}`
const TEMPLATE_DOCUMENT = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'guide-template', root: 'g0',
  graphs: { g0: { id: 'g0', name: 'Map and Gather', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
  view: { graphs: { g0: { nodes: {} } } },
}

test('browses a fallback guide in place and opens its exact template', async ({ page }) => {
  let nodeRequests = 0
  const docsRequests: string[] = []
  const pageRequests: string[] = []
  const templateRequests: string[] = []

  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/api/nodes*', (route) => {
    nodeRequests += 1
    return route.fulfill({ json: {
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: 'guide-proof', schemaWire: 1 },
      packs: { foundation: { displayName: 'Foundation' } },
      nodes: {
        'demo.node': {
          schemaVersion: 1, displayName: 'Demo Node', category: 'demo', pack: 'foundation',
          interface: [],
        },
      },
    } })
  })
  await page.route('/api/docs?*', (route) => {
    const url = new URL(route.request().url())
    docsRequests.push(url.search)
    const query = url.searchParams.get('q') ?? ''
    return route.fulfill({ json: {
      docs: query === '' || query === 'map' ? [{
        pack: 'foundation', kind: 'guide', id: 'map-and-gather', defaultLocale: 'en',
        tags: ['map', 'subgraph'],
        locales: {
          en: {
            title: 'Map and Gather', summary: 'Process every list item and collect the results.',
            digest: GUIDE_DIGEST, assets: {},
          },
        },
      }] : [],
    } })
  })
  await page.route('**/api/packs/foundation/docs/pages/**', (route) => {
    pageRequests.push(route.request().url())
    return route.fulfill({
      contentType: 'text/markdown',
      body: '# Map and Gather\n\nUse the raw `map` and `subgraph` values from this guide.\n\n```dinkster-example\ntemplate = "map-and-gather"\ncaption = "Start from the maintained example."\n```',
    })
  })
  await page.route('/api/packs/foundation/templates/map-and-gather', (route) => {
    templateRequests.push(route.request().url())
    return route.fulfill({ json: TEMPLATE_DOCUMENT })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => Boolean(window.__dinksterTest))).toBe(true)
  await page.getByTestId('learn-toggle').click()
  const panel = page.getByTestId('learn-panel')
  await expect(panel).toBeVisible()
  const search = panel.getByRole('searchbox', { name: 'Search guides' })
  await expect(panel.getByRole('button', { name: /Map and Gather/ })).toBeVisible()
  await search.fill('map')
  await search.press('Enter')
  await expect.poll(() => docsRequests.length).toBe(2)
  await expect(search).toBeFocused()
  await search.hover()
  await expect(page.getByTestId('app-tooltip')).not.toBeVisible()
  await page.screenshot({ path: evidencePath('issue-457', 'guide-browsing-en.png'), fullPage: true })

  await panel.evaluate((element) => { element.dataset['localeIdentity'] = 'panel' })
  await panel.getByRole('button', { name: /Map and Gather/ }).evaluate((element) => { element.dataset['localeIdentity'] = 'card' })
  const requestsBeforeLocaleChange = { nodes: nodeRequests, docs: docsRequests.length }
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { readonly settings: { set(id: string, value: string): void } }
    app.settings.set('dinkster.locale', 'zh')
  })
  await expect(page.getByTestId('learn-toggle')).toContainText('\u5b66\u4e60')
  await expect(panel).toContainText('\u6b64\u6307\u5357\u6ca1\u6709\u5f53\u524d\u8bed\u8a00\u7684\u7ffb\u8bd1')
  await expect(panel).toHaveAttribute('data-locale-identity', 'panel')
  await expect(panel.getByRole('button', { name: /Map and Gather/ })).toHaveAttribute('data-locale-identity', 'card')
  expect(nodeRequests).toBe(requestsBeforeLocaleChange.nodes)
  expect(docsRequests).toHaveLength(requestsBeforeLocaleChange.docs)

  await panel.getByRole('button', { name: /Map and Gather/ }).click()
  await expect(panel.getByRole('heading', { name: 'Map and Gather' }).first()).toBeVisible()
  await expect(panel).toContainText('foundation')
  await expect(panel).toContainText('map | subgraph')
  await expect(panel).toContainText('Start from the maintained example.')
  await expect(panel.getByRole('button', { name: '\u6253\u5f00\u6a21\u677f' })).toBeVisible()
  await expect(panel.locator('article')).toHaveAttribute('lang', 'en')
  expect(pageRequests).toHaveLength(1)
  expect(decodeURIComponent(pageRequests[0]!)).toContain(`/api/packs/foundation/docs/pages/${GUIDE_DIGEST}`)
  expect(await auditLayout(page, '[data-testid="learn-panel"]')).toEqual([])
  await page.screenshot({ path: evidencePath('issue-457', 'guide-browsing-zh.png'), fullPage: true })

  await panel.getByRole('button', { name: '\u6253\u5f00\u6a21\u677f' }).click()
  await expect.poll(() => templateRequests.length).toBe(1)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.lineage)).toBe('guide-template')
  expect(nodeRequests).toBe(requestsBeforeLocaleChange.nodes)
})
