import { mkdir } from 'node:fs/promises'
import { expect, test } from './fixtures.js'
import { auditLayout } from './ui-audit.js'

const EVIDENCE = '../../docs/evidence/issue-457'

test.beforeAll(async () => mkdir(EVIDENCE, { recursive: true }))

test('an expanded RTL pseudo-locale updates the mounted host without changing app state', async ({ page, request }) => {
  let schemaRequests = 0
  let diagnosticRequests = 0
  await page.route('/api/nodes*', (route) => {
    schemaRequests += 1
    return route.fulfill({ json: {
      schemaVersion: 1,
      epoch: 1,
      dinkster: { version: 'rtl-pseudo-locale-e2e', schemaWire: 1 },
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
  await page.getByTestId('settings-button').click()
  const dialog = page.locator('[data-testid="modal-surface"][data-modal="settings"]')
  const search = dialog.locator('.settings-search')
  await search.fill('canvas.minimap.visible')
  await search.focus()
  await dialog.evaluate((element) => { element.dataset['localeIdentity'] = 'settings-dialog' })
  await search.evaluate((element) => { element.dataset['localeIdentity'] = 'settings-search' })
  const stateBeforeLocale = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      storage: localStorage.getItem('dinkster.settings'),
    }
  })
  const requestsBeforeLocale = { schemas: schemaRequests, diagnostics: diagnosticRequests }
  await page.screenshot({ path: `${EVIDENCE}/rtl-pseudo-locale-en.png`, fullPage: true })

  const localeSource = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeSource.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nUrl, localeUrl }) => {
    const { registerCatalog } = await import(i18nUrl)
    const { bindLocale } = await import(localeUrl)
    registerCatalog('ar-XB', {
      'settings.canvas.minimap.visible': '[\u0625\u0638\u0647\u0627\u0631 \u0627\u0644\u062e\u0631\u064a\u0637\u0629 \u0627\u0644\u0645\u0635\u063a\u0631\u0629 \u0639\u0644\u0649 \u0645\u0633\u0627\u062d\u0629 \u0627\u0644\u0639\u0645\u0644]',
      'settingsDialog.action.clear': '[\u0645\u0633\u062d \u0646\u062a\u0627\u0626\u062c \u0627\u0644\u0628\u062d\u062b]',
      'settingsDialog.category.canvas_minimap': '[\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062e\u0631\u064a\u0637\u0629 \u0627\u0644\u0645\u0635\u063a\u0631\u0629 \u0627\u0644\u0645\u0648\u0633\u0639\u0629]',
      'settingsDialog.category.regionAria': '[\u0641\u0626\u0627\u062a \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0637\u0628\u064a\u0642]',
      'settingsDialog.search.allResults': '[\u0643\u0644 \u0627\u0644\u0646\u062a\u0627\u0626\u062c \u0627\u0644\u0645\u062a\u0627\u062d\u0629]',
      'settingsDialog.search.allResultsAria': '[\u0643\u0644 \u0627\u0644\u0646\u062a\u0627\u0626\u062c\u060c {count} \u0646\u062a\u0627\u0626\u062c]',
      'settingsDialog.search.clearAria': '[\u0645\u0633\u062d \u0628\u062d\u062b \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0637\u0628\u064a\u0642]',
      'settingsDialog.search.label': '[\u0627\u0644\u0628\u062d\u062b \u0641\u064a \u062c\u0645\u064a\u0639 \u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0637\u0628\u064a\u0642]',
      'settingsDialog.search.placeholder': '[\u0627\u0628\u062d\u062b \u0641\u064a \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0628\u0627\u0644\u0627\u0633\u0645 \u0623\u0648 \u0627\u0644\u0645\u0639\u0631\u0641]',
      'settingsDialog.search.regionAria': '[\u0623\u062f\u0648\u0627\u062a \u0627\u0644\u0628\u062d\u062b \u0641\u064a \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a]',
      'settingsDialog.search.summary': '[{count} \u0646\u062a\u0627\u0626\u062c \u0645\u0637\u0627\u0628\u0642\u0629 \u0644\u0644\u0628\u062d\u062b "{query}"]',
      'shell.panel.settings.title': '[\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0627\u0644\u0645\u0648\u0633\u0639\u0629]',
    })
    bindLocale({
      get: () => 'ar-XB',
      changed: { subscribe: () => () => {} },
    }, document.documentElement, navigator.language)
  }, {
    i18nUrl: new URL(i18nModule!, page.url()).href,
    localeUrl: new URL('/src/locale.ts', page.url()).href,
  })

  await expect(page.locator('html')).toHaveAttribute('lang', 'ar-XB')
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl')
  await expect(dialog).toHaveAttribute('data-locale-identity', 'settings-dialog')
  const retainedSearch = dialog.locator('[data-locale-identity="settings-search"]')
  await expect(retainedSearch).toBeFocused()
  await expect(retainedSearch).toHaveValue('canvas.minimap.visible')
  await expect(retainedSearch).toHaveAttribute('placeholder', '[\u0627\u0628\u062d\u062b \u0641\u064a \u0627\u0644\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0628\u0627\u0644\u0627\u0633\u0645 \u0623\u0648 \u0627\u0644\u0645\u0639\u0631\u0641]')
  await expect(dialog.locator('.dock-title')).toHaveText('[\u0625\u0639\u062f\u0627\u062f\u0627\u062a \u0627\u0644\u062a\u0637\u0628\u064a\u0642 \u0627\u0644\u0645\u0648\u0633\u0639\u0629]')
  await expect(dialog.locator('[data-setting-id="canvas.minimap.visible"]')).toContainText('[\u0625\u0638\u0647\u0627\u0631 \u0627\u0644\u062e\u0631\u064a\u0637\u0629 \u0627\u0644\u0645\u0635\u063a\u0631\u0629 \u0639\u0644\u0649 \u0645\u0633\u0627\u062d\u0629 \u0627\u0644\u0639\u0645\u0644]')
  await expect(dialog.locator('[data-setting-id="canvas.minimap.visible"] code')).toHaveText('canvas.minimap.visible')
  expect({ schemas: schemaRequests, diagnostics: diagnosticRequests }).toEqual(requestsBeforeLocale)
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      document: JSON.stringify(tab.store.doc),
      revision: tab.store.revision,
      storage: localStorage.getItem('dinkster.settings'),
    }
  })).toEqual(stateBeforeLocale)
  expect(await auditLayout(page, '[data-testid="modal-surface"][data-modal="settings"]')).toEqual([])
  await page.screenshot({ path: `${EVIDENCE}/rtl-pseudo-locale-wide.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(retainedSearch).toBeFocused()
  await expect(retainedSearch).toHaveValue('canvas.minimap.visible')
  await expect(dialog.locator('[data-setting-id="canvas.minimap.visible"]')).toBeVisible()
  expect(await auditLayout(page, '.settings-content')).toEqual([])
  expect(await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const categories = element.querySelector<HTMLElement>('.settings-categories')!
    return {
      dialogFits: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
      categoriesContained: categories.getBoundingClientRect().width <= rect.width,
      documentFits: document.documentElement.scrollWidth <= window.innerWidth,
    }
  })).toEqual({ dialogFits: true, categoriesContained: true, documentFits: true })
  await page.screenshot({ path: `${EVIDENCE}/rtl-pseudo-locale-constrained.png`, fullPage: true })
})
