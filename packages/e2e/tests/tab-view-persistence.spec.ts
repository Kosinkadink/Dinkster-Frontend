import { expect, test, type Page } from './fixtures.js'

const selectTab = (page: Page, title: string) =>
  page.getByTestId('tab-bar').locator('.tab-select', { hasText: title })

const setViewport = (page: Page, viewport: { x: number; y: number; scale: number }) =>
  page.evaluate((value) => window.__dinksterTest!.renderer!.setViewport(value), viewport)

const viewport = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())

const flushTabs = (page: Page) => page.evaluate(() => {
  ;(window.__dinksterTest!.app as unknown as { flushPersistTabs(): void }).flushPersistTabs()
})

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
})

test('refresh restores each graph tab viewport and the active tab', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('graph-canvas')).toBeVisible()
  await expect(page.getByTestId('tab-bar').locator('.tab')).toHaveCount(2)
  const basic = { x: -321.5, y: 187.25, scale: 1.75 }
  const subgraph = { x: 48, y: -96, scale: 0.65 }

  await setViewport(page, basic)
  await selectTab(page, 'Subgraph').click()
  await setViewport(page, subgraph)
  await flushTabs(page)

  await page.reload()
  await expect(selectTab(page, 'Subgraph')).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => viewport(page)).toEqual(subgraph)

  await selectTab(page, 'Basic').click()
  await expect.poll(() => viewport(page)).toEqual(basic)
})

test('refresh restores App View scroll position', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.evaluate(() => {
    const items = Array.from({ length: 32 }, (_, index) => ({
      id: `text-${index}`,
      kind: 'text',
      role: 'body',
      text: `Persisted app view row ${index + 1}`,
    }))
    const app = window.__dinksterTest!.app
    app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'app-scroll-persistence',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
      },
      view: { graphs: { g0: { nodes: {} } } },
      ext: {
        'dinkster.appLayout': {
          version: 1,
          desktop: { items },
          mobile: { customized: false, items: [] },
        },
      },
    }, 'Scrollable App')
    ;(app as unknown as { setTabEditorKind(tabId: string, editorKind: string): void })
      .setTabEditorKind('app-scroll-persistence', 'app')
  })
  await expect(page.getByTestId('app-view')).toBeVisible()
  await expect(page.getByTestId('app-layout-text')).toHaveCount(32)
  const savedScrollTop = await page.getByTestId('app-view').evaluate((element) => {
    const target = Math.min(700, element.scrollHeight - element.clientHeight)
    if (target <= 0) throw new Error('App View fixture did not overflow')
    element.scrollTop = target
    element.dispatchEvent(new Event('scroll'))
    return element.scrollTop
  })
  expect(savedScrollTop).toBeGreaterThan(0)
  await flushTabs(page)

  await page.reload()
  await expect(page.getByTestId('app-view')).toBeVisible()
  await expect(page.getByTestId('app-layout-text')).toHaveCount(32)
  await expect.poll(() => page.getByTestId('app-view').evaluate((element) => element.scrollTop)).toBe(savedScrollTop)
})
