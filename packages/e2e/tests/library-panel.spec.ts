import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_LIBRARY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

type TemplateMode = 'ready' | 'loading' | 'empty' | 'error'

const packs = Object.fromEntries(Array.from({ length: 32 }, (_, index) => {
  const suffix = String(index + 1).padStart(2, '0')
  const id = index === 15 ? `pack-${suffix}-${'long-identity-'.repeat(5)}tail` : `pack-${suffix}`
  return [id, {
    displayName: index === 15 ? `Fixture Pack ${suffix} with a deliberately long identity and descriptive title` : `Fixture Pack ${suffix}`,
    abbr: `P${suffix}`,
    version: `1.${index}.0`,
    source: 'registry:fixture',
    publisher: 'Dinkster visual fixture',
    artifactDigest: `blake3:${(index + 1).toString(16).padStart(64, '0')}`,
    assets: [{ id: 'model', name: `Fixture model ${suffix}`, digest: `blake3:${(index + 40).toString(16).padStart(64, '0')}`, kind: 'model/checkpoint', size: 4096 + index }],
  }]
}))

const nodes = Object.fromEntries(Object.keys(packs).map((pack, index) => [`fixture.node.${index}`, {
  displayName: `Fixture Node ${index + 1}`,
  pack,
  signature: `fixture-${index}`,
  interface: [],
}]))

const templates = Array.from({ length: 32 }, (_, index) => {
  const suffix = String(index + 1).padStart(2, '0')
  return {
    pack: index === 15 ? Object.keys(packs)[15] : `pack-${suffix}`,
    id: index === 15 ? `template/${'long-identity-'.repeat(5)}tail` : `template-${suffix}`,
    name: index === 15 ? `Fixture Template ${suffix} with a deliberately long title for containment proof` : `Fixture Template ${suffix}`,
    description: index === 15 ? 'Long metadata remains readable and selectable without overlapping the action or source controls.' : `Template fixture ${suffix}`,
    tags: ['fixture', index % 2 === 0 ? 'image' : 'audio'],
    assets: ['model'],
    digest: `blake3:${(index + 80).toString(16).padStart(64, '0')}`,
  }
})

async function installFixture(page: Page): Promise<{
  setTemplateMode(mode: TemplateMode): void
  releaseTemplates(): void
  templateRequestCount(): number
}> {
  let templateMode: TemplateMode = 'ready'
  let templateRequests = 0
  let release: (() => void) | undefined

  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'fixture has no supervisor' }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/history/runs*', (route) => route.fulfill({ json: { records: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'library-panel-proof', schemaWire: 22 },
    packs,
    nodes,
  } }))
  await page.route('/api/library*', (route) => route.fulfill({ json: { records: [
    {
      id: `workflow/${'long-identity-'.repeat(4)}tail`,
      scope: 'local',
      name: 'Saved workflow with exact provenance',
      digest: `blake3:${'d'.repeat(64)}`,
      mediaType: 'application/vnd.dinkster.workflow+json',
      labels: ['workflow', 'fixture'],
      created: 1_755_345_600,
      modified: 1_755_349_200,
      revision: 7,
      folder: 'proof/long/folder',
    },
  ] } }))
  await page.route('/api/templates*', async (route) => {
    templateRequests += 1
    if (templateMode === 'loading') {
      await new Promise<void>((resolve) => { release = resolve })
    }
    if (templateMode === 'error') {
      await route.fulfill({ status: 503, body: 'fixture template catalog unavailable' })
      return
    }
    const url = new URL(route.request().url())
    const query = (url.searchParams.get('q') ?? '').toLocaleLowerCase()
    const pack = url.searchParams.get('pack')
    const filtered = templateMode === 'empty'
      ? []
      : templates.filter((template) =>
          (pack === null || template.pack === pack) && JSON.stringify(template).toLocaleLowerCase().includes(query),
        )
    const secondPage = url.searchParams.get('cursor') === 'template-page-2'
    await route.fulfill({ json: {
      templates: secondPage ? filtered.slice(24) : filtered.slice(0, 24),
      ...(!secondPage && filtered.length > 24 ? { cursor: 'template-page-2' } : {}),
    } })
  })

  return {
    setTemplateMode(mode) { templateMode = mode },
    releaseTemplates() { release?.(); release = undefined },
    templateRequestCount() { return templateRequests },
  }
}

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) return
  await page.mouse.move(1200, 400)
  await page.evaluate(() => {
    document.querySelector('.shell')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await page.screenshot({ path: join(proofDir, `${name}.png`), animations: 'disabled', fullPage: true })
}

async function selectSource(page: Page, id: string): Promise<void> {
  await page.locator(`[data-testid="collection-source"][data-source="${id}"]`).click()
}

test('Library direct content preserves provenance, states, overflow, and responsive access', async ({ page }) => {
  const fixture = await installFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  const library = page.getByTestId('library-overlay')
  if (!await library.isVisible()) await page.getByTestId('library-toggle').click()
  await expect(library).toBeVisible()
  await page.getByTestId('dock-resize').focus()
  await page.keyboard.press('End')
  await expect(library.locator('.library-backend-context')).toContainText(/Dinkster - (connected|reconnecting)/)
  await expect(library.getByTestId('collection-entry')).toHaveCount(24)
  await library.getByTestId('collection-more').click()
  await expect(library.getByTestId('collection-entry')).toHaveCount(32)

  const pack = library.getByRole('option', { name: /deliberately long identity/ })
  await pack.scrollIntoViewIfNeeded()
  await pack.click()
  await pack.focus()
  await expect(pack).toHaveAttribute('aria-selected', 'true')
  await pack.evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await expect(library.getByTestId('library-detail-rail')).toContainText('registry:fixture')
  await expect(library.getByTestId('library-detail-rail')).toContainText(/long-identity-.*tail/)
  const panelScroll = page.getByTestId('dock-zone-left').locator('.product-tabpanel:not([hidden])')
  expect(await panelScroll.evaluate((element) => element.scrollTop > 0)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await library.getByTestId('collection-search').focus()
  await capture(page, 'after-library-packs-selected-overflow-1600x950')

  await page.setViewportSize({ width: 1366, height: 768 })
  fixture.setTemplateMode('loading')
  await selectSource(page, 'templates')
  await expect(library.getByTestId('library-source-transition')).toContainText('Loading templates')
  await expect(library.getByRole('option', { name: /Fixture Pack 01/ })).toBeHidden()
  const transitionSearch = library.getByTestId('collection-search')
  await expect(transitionSearch).toHaveAttribute('aria-label', 'Search templates')
  const transitionDescriptionId = await transitionSearch.getAttribute('aria-describedby')
  const transitionResultsId = await transitionSearch.getAttribute('aria-controls')
  expect(transitionDescriptionId).not.toBeNull()
  expect(transitionResultsId).not.toBeNull()
  await expect(library.locator(`[id="${transitionDescriptionId}"]`)).toContainText('Loading templates')
  await expect(library.locator(`[id="${transitionDescriptionId}"]`)).not.toContainText('entry in Templates')
  await expect(library.locator(`[id="${transitionResultsId}"]`)).toHaveAttribute('aria-label', 'Templates results')
  await expect(library.locator(`[id="${transitionResultsId}"]`)).toHaveAttribute('aria-busy', 'true')
  await expect(library.locator(`[id="${transitionResultsId}"]`)).not.toContainText('Fixture Pack 01')
  await expect(library.getByTestId('collection-items')).toHaveAttribute('aria-hidden', 'true')
  await capture(page, 'after-library-source-transition-1366x768')
  fixture.setTemplateMode('ready')
  fixture.releaseTemplates()
  await expect(library.getByTestId('collection-entry')).toHaveCount(24)
  await expect(transitionSearch).not.toHaveAttribute('aria-describedby', transitionDescriptionId!)
  await expect(transitionSearch).not.toHaveAttribute('aria-controls', transitionResultsId!)
  await expect(library.getByTestId('collection-items')).not.toHaveAttribute('aria-hidden', 'true')
  await library.getByTestId('collection-more').click()
  await expect(library.getByTestId('collection-entry')).toHaveCount(32)
  const template = library.getByRole('option', { name: /deliberately long title/ })
  await template.scrollIntoViewIfNeeded()
  await template.click()
  await template.focus()
  await template.evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await expect(library.getByTestId('library-detail-action')).toHaveText('Open template')
  await expect(library.getByTestId('library-detail-rail')).toContainText(`blake3:${(95).toString(16).padStart(64, '0')}`)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await library.getByTestId('collection-search').focus()
  await capture(page, 'after-library-templates-selected-1366x768')
  await panelScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(library.getByTestId('library-detail-action')).toBeInViewport()
  await library.getByTestId('library-detail-action').focus()
  await capture(page, 'after-library-templates-detail-tail-1366x768')

  await selectSource(page, 'workflows')
  const workflow = library.getByRole('option', { name: /Saved workflow with exact provenance/ })
  await expect(workflow).toBeVisible()
  await workflow.focus()
  await workflow.press('Home')
  await expect(workflow).toHaveAttribute('aria-selected', 'true')
  await expect(library.getByTestId('library-detail-rail')).toContainText('application/vnd.dinkster.workflow+json')
  await expect(library.getByTestId('library-detail-rail')).toContainText('rev 7')
  await capture(page, 'after-library-workflow-provenance-1366x768')

  await selectSource(page, 'templates')
  await expect(library.getByTestId('collection-entry')).toHaveCount(24)

  const search = library.getByTestId('collection-search')
  await search.fill('definitely-no-template')
  await expect(library.locator('[data-collection-state="no-match"]')).toContainText('No matching templates')
  await search.focus()
  await capture(page, 'after-library-no-match-1366x768')

  fixture.setTemplateMode('loading')
  await search.fill('')
  await expect(library.locator('[data-collection-state="loading"]')).toContainText('Loading templates')
  await capture(page, 'after-library-loading-1366x768')
  fixture.setTemplateMode('ready')
  fixture.releaseTemplates()
  await expect(library.getByTestId('collection-entry')).toHaveCount(24)

  fixture.setTemplateMode('error')
  await selectSource(page, 'packs')
  await selectSource(page, 'templates')
  await expect(library.locator('[data-collection-state="error"]')).toContainText('GET /api/templates failed: 503')
  await capture(page, 'after-library-error-1366x768')

  fixture.setTemplateMode('empty')
  await selectSource(page, 'packs')
  await selectSource(page, 'templates')
  await expect(library.locator('[data-collection-state="empty"]')).toContainText('No templates available')
  await capture(page, 'after-library-empty-1366x768')
  fixture.setTemplateMode('ready')

  await selectSource(page, 'packs')
  await selectSource(page, 'templates')
  await expect(library.getByTestId('collection-entry')).toHaveCount(24)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { connection: { disconnect(): void } }
    app.connection.disconnect()
  })
  await expect(library.locator('.library-backend-context')).toContainText('disconnected')
  await expect(library).toHaveAttribute('data-source', 'templates')
  await expect(library.locator('[data-testid="collection-source"][data-source="templates"]')).toHaveAttribute('aria-pressed', 'true')
  await page.setViewportSize({ width: 390, height: 844 })
  const compactSource = library.getByTestId('library-source-select')
  await expect(compactSource).toBeVisible()
  await expect(library.locator('.library-source-tabs')).toBeHidden()
  await compactSource.dispatchEvent('pointerdown', { pointerType: 'touch' })
  await expect(library.locator('.library-backend-context')).toContainText('Dinkster - disconnected')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await capture(page, 'after-library-disconnected-narrow-390x844')

  await page.setViewportSize({ width: 1366, height: 768 })
  await page.getByTestId('dock-resize').focus()
  await page.keyboard.press('Home')
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await expect(compactSource).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await capture(page, 'after-library-zoom-200-1366x768')
})

test('an open Library panel updates host chrome when the active locale changes', async ({ page, request }) => {
  const fixture = await installFixture(page)
  fixture.setTemplateMode('empty')
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  const library = page.getByTestId('library-overlay')
  if (!await library.isVisible()) await page.getByTestId('library-toggle').click()
  await page.getByTestId('dock-resize').focus()
  await page.keyboard.press('End')
  await selectSource(page, 'templates')
  await expect(library.locator('[data-collection-state="empty"]')).toContainText('No templates available')
  await expect(library.locator('.library-backend-context')).toContainText('Backend')
  await expect(library.getByTestId('collection-search')).toHaveAttribute('aria-label', 'Search templates')
  await page.screenshot({ path: '../../docs/evidence/issue-457/library-panel-i18n-en.png', fullPage: true })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'library.backend': '[Backend-Bezug]',
      'library.detail.empty.description': '[Wahle einen Eintrag fur Identitat, Herkunft und Aktionen.]',
      'library.detail.empty.title': '[Eintragsdetails]',
      'library.search': '[Suche in {source}]',
      'library.source.collections': '[Bibliothekssammlungen mit langem Namen]',
      'library.state.noTemplates.detail': '[Keine Vorlagen von {backend} verfugbar.]',
      'library.state.noTemplates.title': '[Keine Vorlagen verfugbar]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(library.locator('[data-collection-state="empty"]')).toContainText('[Keine Vorlagen verfugbar]')
  await expect(library.locator('[data-collection-state="empty"]')).toContainText('[Keine Vorlagen von Local verfugbar.]')
  await expect(library.locator('.library-backend-context')).toContainText('[Backend-Bezug]')
  await expect(library.locator('.library-source-tabs')).toHaveAttribute('aria-label', '[Bibliothekssammlungen mit langem Namen]')
  await expect(library.getByTestId('collection-search')).toHaveAttribute('aria-label', '[Suche in templates]')
  await expect(library.getByTestId('library-detail-rail')).toContainText('[Eintragsdetails]')
  await expect(library.getByTestId('library-detail-rail')).toContainText('[Wahle einen Eintrag fur Identitat, Herkunft und Aktionen.]')
  await expect(library.locator('[data-testid="collection-source"][data-source="templates"]')).toContainText('Templates')
  await expect(library.locator('.library-backend-context')).toContainText('Local')
  await page.screenshot({ path: '../../docs/evidence/issue-457/library-panel-i18n-de-DE.png', fullPage: true })
})

test('an open generic collection keeps content and paging state across a locale change', async ({ page, request }) => {
  const fixture = await installFixture(page)
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  const library = page.getByTestId('library-overlay')
  if (!await library.isVisible()) await page.getByTestId('library-toggle').click()
  await page.getByTestId('dock-resize').focus()
  await page.keyboard.press('End')
  await selectSource(page, 'templates')
  const entries = library.getByTestId('collection-entry')
  await expect(entries).toHaveCount(24)
  await expect(library.getByTestId('collection-mode')).toHaveAttribute('aria-label', 'Grid view')
  await expect(library.getByTestId('collection-more')).toHaveText('Load more')
  await expect(library.getByTestId('collection-items')).toHaveAttribute('aria-label', 'Templates results')
  await entries.first().click()
  await expect(entries.first()).toHaveAttribute('aria-selected', 'true')
  const requestsBeforeLocale = fixture.templateRequestCount()
  await entries.first().click()
  await expect(entries.first()).toHaveAttribute('aria-selected', 'false')
  await page.getByTestId('dock-zone-left').locator('.product-tabpanel:not([hidden])').evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(library.getByTestId('collection-more')).toBeInViewport()
  await page.screenshot({ path: '../../docs/evidence/issue-457/collection-panel-i18n-en.png', fullPage: true })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'collection.action.loadMore': '[Weitere Sammlungseintrage laden]',
      'collection.mode.grid': '[Rasteransicht der Sammlung]',
      'collection.result.ariaLabel': '[Ergebnisse fur {source}]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(library.getByTestId('collection-mode')).toHaveAttribute('aria-label', '[Rasteransicht der Sammlung]')
  await expect(library.getByTestId('collection-more')).toHaveText('[Weitere Sammlungseintrage laden]')
  await expect(library.getByTestId('collection-items')).toHaveAttribute('aria-label', '[Ergebnisse fur Templates]')
  await expect(entries).toHaveCount(24)
  await expect(entries.first()).toHaveAttribute('aria-selected', 'false')
  await expect(entries.first()).toContainText('Fixture Template 01')
  expect(fixture.templateRequestCount()).toBe(requestsBeforeLocale)
  await expect(library.getByTestId('collection-more')).toBeInViewport()
  await page.screenshot({ path: '../../docs/evidence/issue-457/collection-panel-i18n-de-DE.png', fullPage: true })
})
