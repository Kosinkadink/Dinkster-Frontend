import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { expect, test } from './fixtures.js'
import { pseudoCatalog, pseudoMessage } from './pseudo-catalog.js'
import { auditLayout } from './ui-audit.js'

const EVIDENCE = '../../docs/evidence/issue-457'
const english = JSON.parse(readFileSync(
  new URL('../../app/src/locales/en.json', import.meta.url),
  'utf8',
)) as Record<string, string>
const pseudo = pseudoCatalog(english)
const placeholders = (message: string): string[] => [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)(?=,|\})/g)]
  .map((match) => match[1]!)
  .sort()

test.beforeAll(async () => mkdir(EVIDENCE, { recursive: true }))

test('generates one expanded pseudo message for every English catalog key', () => {
  expect(Object.keys(pseudo).sort()).toEqual(Object.keys(english).sort())
  for (const [key, message] of Object.entries(english)) {
    const transformed = pseudo[key]!
    expect(transformed, key).toMatch(/^\[!! .+ ~{4,} !!\]$/s)
    expect(transformed.length, key).toBeGreaterThan(message.length)
    expect(placeholders(transformed), key).toEqual(placeholders(message))
  }
  expect(pseudoMessage('{count, plural, one {# item} other {# items}}'))
    .toContain('{count, plural, one {# item} other {# items}}')
})

test('runs mounted host surfaces through the complete pseudo catalog', async ({ page, request }) => {
  let schemaRequests = 0
  let diagnosticRequests = 0
  await page.addInitScript(() => {
    const NativeResizeObserver = window.ResizeObserver
    // Isolate CanvasHost's reactive bounds from the palette's own size observer.
    window.ResizeObserver = class extends NativeResizeObserver {
      override observe(target: Element, options?: ResizeObserverOptions): void {
        if (target instanceof HTMLElement && target.dataset['testid'] === 'node-palette') return
        super.observe(target, options)
      }
    }
  })
  await page.route('/api/nodes*', (route) => {
    schemaRequests += 1
    return route.fulfill({ json: {
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: 'full-pseudo-locale-e2e', schemaWire: 44 },
      nodes: {},
    } })
  })
  await page.route('/api/diagnostics*', (route) => {
    diagnosticRequests += 1
    return route.fulfill({ json: { diagnostics: [] } })
  })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app !== undefined)
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  await page.getByTestId('rail-toggle').click()
  await page.getByTestId('settings-button').click()

  const dialog = page.locator('[data-testid="modal-surface"][data-modal="settings"]')
  const search = dialog.locator('.settings-search')
  await search.fill('canvas.grid.visible')
  await search.focus()
  await dialog.evaluate((element) => { element.dataset['localeIdentity'] = 'settings-dialog' })
  await search.evaluate((element) => { element.dataset['localeIdentity'] = 'settings-search' })
  const stateBeforeLocale = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      storage: localStorage.getItem('dinkster.settings'),
      title: tab.title,
    }
  })
  const backendStatusBeforeLocale = await page.locator('[data-host-ui-key="core.connection"]').textContent()
  expect(backendStatusBeforeLocale).not.toBeNull()
  const requestsBeforeLocale = { schemas: schemaRequests, diagnostics: diagnosticRequests }

  const localeSource = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeSource.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  const unresolved = await page.evaluate(async ({ catalog, i18nUrl, localeUrl }) => {
    const { registerCatalog, t } = await import(i18nUrl)
    const { bindLocale } = await import(localeUrl)
    registerCatalog('en-XA', catalog)
    bindLocale({
      get: () => 'en-XA',
      changed: { subscribe: () => () => {} },
    }, document.documentElement, navigator.language)
    return Object.keys(catalog).filter((key) => !t(key).startsWith('[!! '))
  }, {
    catalog: pseudo,
    i18nUrl: new URL(i18nModule!, page.url()).href,
    localeUrl: new URL('/src/locale.ts', page.url()).href,
  })

  expect(unresolved).toEqual([])
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-XA')
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await expect(dialog).toHaveAttribute('data-locale-identity', 'settings-dialog')
  const retainedSearch = dialog.locator('[data-locale-identity="settings-search"]')
  await expect(retainedSearch).toBeFocused()
  await expect(retainedSearch).toHaveValue('canvas.grid.visible')
  await expect(retainedSearch).toHaveAttribute('placeholder', pseudo['settingsDialog.search.placeholder']!)
  await expect(dialog.locator('.dock-title')).toHaveText(pseudo['shell.panel.settings.title']!)
  await expect(dialog.locator('[data-setting-id="canvas.grid.visible"]')).toContainText(pseudo['settings.canvas.grid.visible']!)
  await expect(dialog.locator('[data-setting-id="canvas.grid.visible"] code')).toHaveText('canvas.grid.visible')
  await expect(page.locator('[data-host-ui-key="core.connection"]')).toHaveText(backendStatusBeforeLocale!)
  expect({ schemas: schemaRequests, diagnostics: diagnosticRequests }).toEqual(requestsBeforeLocale)
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      storage: localStorage.getItem('dinkster.settings'),
      title: tab.title,
    }
  })).toEqual(stateBeforeLocale)
  expect(await auditLayout(page, '[data-testid="modal-surface"][data-modal="settings"]')).toEqual([])
  await page.screenshot({ path: `${EVIDENCE}/full-pseudo-locale-wide.png`, fullPage: true })

  await page.getByTestId('modal-close').click()
  await expect(page.getByTestId('app-view-arrange-toggle')).toContainText(pseudo['appView.arrange']!)
  await expect(page.getByTestId('app-view-empty')).toContainText(pseudo['appView.empty']!)
  await expect(page.getByTestId('library-toggle')).toContainText(pseudo['shell.panel.library.title']!)
  await expect(page.getByTestId('backends-toggle')).toContainText(pseudo['shell.panel.backends.title']!)
  await expect(page.getByTestId('left-panel-toggle')).toHaveAttribute('aria-label', pseudo['shell.toggle.leftPanel']!)

  await page.getByTestId('dinkster-menu-button').click()
  await expect(page.locator('[data-item-id="workflow.open"]')).toContainText(pseudo['command.workflow.open']!)
  await page.getByTestId('dinkster-menu-button').click()
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'Graph' }).click()
  const canvas = page.getByTestId('graph-canvas')
  const box = (await canvas.boundingBox())!
  await canvas.dispatchEvent('dblclick', {
    bubbles: true,
    button: 0,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  })
  const palette = page.getByTestId('node-palette')
  await expect(palette).toBeVisible()
  await expect(page.getByTestId('palette-search')).toHaveAttribute('placeholder', pseudo['palette.search.addNodePlaceholder']!)
  await expect(palette).toContainText(pseudo['palette.results.available']!)

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('palette-search')).toBeFocused()
  await expect.poll(() => auditLayout(page, '[data-testid="node-palette"]')).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `${EVIDENCE}/full-pseudo-locale-constrained.png`, fullPage: true })
})
