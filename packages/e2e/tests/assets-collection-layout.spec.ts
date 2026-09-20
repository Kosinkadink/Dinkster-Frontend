import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const PROOF = '/tmp/assets-collection-layout-proof'
const FOLLOWUP_PROOF = '/tmp/assets-picker-layout-followup-proof'
const PAGE_SIZE = 24
type Scenario = 'overflow' | 'sparse' | 'sparse-three' | 'empty' | 'loading' | 'error' | 'catalog-error'

test.beforeEach(({}, testInfo) => {
  test.skip(
    !['http://127.0.0.1:5323', 'http://127.0.0.1:5378', 'http://127.0.0.1:5383'].includes(String(testInfo.project.use.baseURL)),
    'requires an isolated collection layout server',
  )
})

const candidate = (index: number) => {
  const suffix = String(index).padStart(2, '0')
  const digest = `blake3:${index.toString(16).padStart(64, '0')}`
  return {
    logicalId: `layout-asset-${suffix}`,
    family: 'layout-proof',
    assetKind: 'model/checkpoint',
    variantId: 'fp16',
    dtype: 'fp16',
    quantization: 'none',
    format: 'safetensors',
    role: 'base',
    requirements: { loaders: [], runtimes: [], hardware: [] },
    digest,
    availability: { status: 'local', reason: '' },
    compatibility: { status: 'compatible', reason: '' },
    assetRef: {
      digest,
      name: index === 2
        ? 'Layout asset 02 with a deliberately long name and path that must remain readable.safetensors'
        : `Layout asset ${suffix}.safetensors`,
      size: 1024 + index,
      mediaType: 'application/octet-stream',
      virtualPath: `models/layout/asset-${suffix}.safetensors`,
    },
    providerSources: [{
      source: { providerId: 'layout-proof', sourceId: 'catalog' },
      status: 'available',
      reason: '',
      requires: {},
    }],
  }
}

async function installBaseRoutes(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'assets-collection-layout', schemaWire: 22 },
    nodes: {},
  } }))
}

async function installGlobalRoutes(page: Page, scenario: Scenario = 'overflow'): Promise<() => void> {
  const rows = Array.from({ length: PAGE_SIZE * 2 }, (_, index) => candidate(index + 1))
  await installBaseRoutes(page)
  await page.route('**/api/mounts', (route) => scenario === 'error'
    ? route.fulfill({ status: 500, body: 'layout mount discovery failed' })
    : route.fulfill({ json: { mounts: [] } }))
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/catalog', async (route) => {
    if (scenario === 'loading') await delayed
    if (scenario === 'catalog-error') {
      await route.fulfill({ status: 503, json: { contractVersion: 1, error: { code: 'service-unavailable', reason: 'layout catalog unavailable' } } })
      return
    }
    const request = route.request().postDataJSON() as { cursor?: string; query?: string }
    const secondPage = request.cursor === 'layout-page-2'
    const matching = rows.filter((row) => row.assetRef.name.toLowerCase().includes((request.query ?? '').toLowerCase()))
    const items = scenario === 'empty' ? [] : scenario === 'sparse' ? matching.slice(0, 1) : secondPage ? matching.slice(PAGE_SIZE) : matching.slice(0, PAGE_SIZE)
    await route.fulfill({ json: {
      contractVersion: 1,
      items,
      ...(scenario === 'overflow' && matching.length > PAGE_SIZE && !secondPage ? { nextCursor: 'layout-page-2' } : {}),
    } })
  })
  return release
}

test('global Assets remains operable at a genuine narrow width and 200% zoom', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await installGlobalRoutes(page)
  await page.goto('/')
  await openAssetsDock(page)

  const assets = page.getByTestId('assets-overlay')
  const search = assets.getByTestId('collection-search')
  const source = assets.getByTestId('asset-source-select')
  await expect(search).toBeVisible()
  await expect(source).toBeDisabled()
  await expect(assets.getByTestId('asset-source-health')).toContainText('Available')
  await expect(assets.locator('[data-testid="asset-entry-fallback"][data-kind="model"]').first()).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await search.dispatchEvent('pointerdown', { pointerType: 'touch' })
  await search.fill('not-present')
  await expect(assets.getByTestId('collection-empty')).toContainText('No matching assets')
  await search.focus()
  await page.screenshot({ path: `${PROOF}/global-390x844-no-match-focus.png`, fullPage: true })

  await assets.getByTestId('collection-search-clear').click()
  const longEntry = assets.getByRole('option', { name: /deliberately long name and path/ })
  await longEntry.click()
  const selectionDetails = assets.getByTestId('asset-rail-details')
  await selectionDetails.locator('summary').click()
  await expect(selectionDetails).toHaveAttribute('open', '')
  await longEntry.scrollIntoViewIfNeeded()
  await search.evaluate((element) => element.focus({ preventScroll: true }))
  await page.screenshot({ path: `${PROOF}/global-390x844-selected.png`, fullPage: true })
  await selectionDetails.locator('dd').last().scrollIntoViewIfNeeded()
  await expect(selectionDetails.locator('dd').last()).toBeInViewport()
  await search.evaluate((element) => element.focus({ preventScroll: true }))
  await page.screenshot({ path: `${PROOF}/global-390x844-selected-details-tail.png`, fullPage: true })

  await page.setViewportSize({ width: 1366, height: 768 })
  await page.evaluate(() => { document.documentElement.style.zoom = '2' })
  await expect(search).toBeVisible()
  await search.focus()
  await expect(assets.getByTestId('collection-mode')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.screenshot({ path: `${PROOF}/global-1366x768-zoom-200.png`, fullPage: true })
})

test('global Assets separates a catalog failure from asset results', async ({ page }) => {
  await mkdir(PROOF, { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await installGlobalRoutes(page, 'catalog-error')
  await page.goto('/')
  await openAssetsDock(page)

  const assets = page.getByTestId('assets-overlay')
  await expect(assets.locator('[data-collection-state="error"]')).toContainText('Assets unavailable')
  await expect(assets.locator('[data-collection-state="error"]')).toContainText('503')
  const health = assets.getByTestId('asset-source-health')
  await expect(health).toContainText('1 issue')
  await health.locator('summary').click()
  await expect(health).toContainText('Federated catalog')
  await expect(health).toContainText('503')
  await page.screenshot({ path: `${PROOF}/global-1366x768-source-error.png`, fullPage: true })
})

test('open Assets source and health chrome update when the active locale changes', async ({ page, request }) => {
  await mkdir('../../docs/evidence/issue-457', { recursive: true })
  await page.setViewportSize({ width: 1600, height: 950 })
  await installBaseRoutes(page)
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [
    { id: 'RAW-checkpoints', mode: 'read', state: 'ready', kind: 'model/checkpoint', entryCount: 1 },
    { id: 'RAW-custom-source', mode: 'read', state: 'ready', entryCount: 1 },
    { id: 'RAW-empty-cache', mode: 'read', state: 'ready', kind: 'model/lora', entryCount: 0 },
    { id: 'RAW-offline-cache', mode: 'read', state: 'offline', kind: 'model/vae', entryCount: 9 },
  ] } }))
  await page.route('**/api/mounts/*/entries?*', (route) => route.fulfill({ json: { entries: [] } }))
  let catalogRequests = 0
  await page.route('**/api/catalog', (route) => {
    catalogRequests += 1
    return route.fulfill({ json: { contractVersion: 1, items: [] } })
  })
  await page.goto('/')
  await openAssetsDock(page)
  await page.getByTestId('dock-resize').focus()
  await page.keyboard.press('End')

  const assets = page.getByTestId('assets-overlay')
  const source = assets.getByTestId('asset-source-select')
  const health = assets.getByTestId('asset-source-health')
  await expect(assets.locator('[data-collection-state="empty"]')).toContainText('No assets yet')
  await source.click()
  await expect(page.locator('[data-option-id="mount:RAW-checkpoints"]')).toHaveText('Models / Checkpoints')
  await expect(page.locator('[data-option-id="mount:RAW-custom-source"]')).toHaveText('Other / RAW Custom Source')
  await health.evaluate((element: HTMLDetailsElement) => { element.open = true })
  await expect(health).toContainText('2 issues')
  await expect(health.locator('[data-source="mount:RAW-empty-cache"]')).toContainText('LoRAs')
  await expect(health.locator('[data-source="mount:RAW-offline-cache"]')).toContainText('offline')
  await page.screenshot({ path: '../../docs/evidence/issue-457/assets-source-i18n-en.png', fullPage: true })
  const requestsBeforeLocale = catalogRequests

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'assets.search': '[Assets durchsuchen]',
      'assets.source.all': '[Alle Assets]',
      'assets.source.ariaLabel': '[Assetquelle]',
      'assets.source.health.issues': '[{count, plural, one {# Problem} other {# Probleme}}]',
      'assets.source.health.title': '[Quellenzustand mit langem Namen]',
      'assets.source.kind.checkpoint': '[Prufpunkte]',
      'assets.source.kind.lora': '[LoRAs DE]',
      'assets.source.kind.vae': '[VAEs DE]',
      'assets.source.label': '[Quelle]',
      'assets.source.mountDetail': '[Mount {id}]',
      'assets.source.section.models': '[Modelle]',
      'assets.source.section.other': '[Andere]',
      'assets.state.empty.detail': '[Keine Assets in {source}.]',
      'assets.state.empty.title': '[Noch keine Assets]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(source).toHaveAttribute('aria-label', '[Assetquelle]')
  await expect(source).toContainText('[Alle Assets]')
  await expect(assets.getByTestId('collection-search')).toHaveAttribute('placeholder', '[Assets durchsuchen]')
  await expect(page.locator('[data-option-id="mount:RAW-checkpoints"]')).toHaveText('[Modelle] / [Prufpunkte]')
  await expect(page.locator('[data-option-id="mount:RAW-custom-source"]')).toHaveText('[Andere] / RAW Custom Source')
  await expect(health).toContainText('[Quellenzustand mit langem Namen]')
  await expect(health).toContainText('[2 Probleme]')
  await expect(health.locator('[data-source="mount:RAW-empty-cache"]')).toContainText('[LoRAs DE]')
  await expect(health.locator('[data-source="mount:RAW-empty-cache"]')).toContainText('empty')
  await expect(health.locator('[data-source="mount:RAW-empty-cache"]')).toContainText('RAW-empty-cache')
  await expect(health.locator('[data-source="mount:RAW-offline-cache"]')).toContainText('[VAEs DE]')
  await expect(health.locator('[data-source="mount:RAW-offline-cache"]')).toContainText('offline')
  await expect(health.locator('[data-source="mount:RAW-offline-cache"]')).toContainText('RAW-offline-cache')
  await expect(assets.locator('[data-collection-state="empty"]')).toContainText('[Noch keine Assets]')
  await expect(assets.locator('[data-collection-state="empty"]')).toContainText('[Keine Assets in [Alle Assets].]')
  expect(catalogRequests).toBe(requestsBeforeLocale)
  await page.screenshot({ path: '../../docs/evidence/issue-457/assets-source-i18n-de-DE.png', fullPage: true })
})

test('open Assets selection details update when the active locale changes', async ({ page, request }) => {
  await mkdir('../../docs/evidence/issue-457', { recursive: true })
  await page.setViewportSize({ width: 1600, height: 950 })
  await installWidgetRoutes(page, 'sparse', 'RAW-layout-images')
  await page.route('**/api/catalog', (route) => route.fulfill({ body: '' }))
  await page.goto('/')
  await openAssetsDock(page)
  await page.getByTestId('dock-resize').focus()
  await page.keyboard.press('End')

  const assets = page.getByTestId('assets-overlay')
  const source = assets.getByTestId('asset-source-select')
  await source.click()
  await page.locator('[data-option-id="mount:RAW-layout-images"]').click()
  await expect(source).toHaveAttribute('data-selected-id', 'mount:RAW-layout-images')
  await assets.getByTestId('collection-entry').first().click()
  const selection = assets.getByTestId('asset-selection-summary')
  const details = selection.getByTestId('asset-rail-details')
  await details.locator('summary').click()
  await expect(details).toHaveAttribute('open', '')
  await expect(details).toContainText('Kindmedia/image')
  await expect(details).toContainText('MountRAW-layout-images')
  await expect(details.getByRole('button', { name: 'Copy digest' })).toBeVisible()
  await page.screenshot({ path: '../../docs/evidence/issue-457/assets-detail-i18n-en.png', fullPage: true })

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'assets.details.forAsset': '[Details fur {name}]',
      'assets.details.title': '[Details mit langem Namen]',
      'assets.digest.copy': '[Digestwert kopieren]',
      'assets.digest.copyLabel': '[Digest kopieren]',
      'assets.fact.digest': '[Digest DE]',
      'assets.fact.kind': '[Asset-Art]',
      'assets.fact.mediaType': '[Medientyp]',
      'assets.fact.mount': '[Mount DE]',
      'assets.fact.name': '[Asset-Name]',
      'assets.fact.resolution': '[Auflosung]',
      'assets.fact.size': '[Dateigrosse]',
      'assets.fact.source': '[Asset-Quelle]',
      'assets.fact.virtualPath': '[Virtueller Asset-Pfad]',
      'assets.selection.title': '[Ausgewahltes Asset]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(details).toHaveAttribute('open', '')
  await expect(selection).toHaveAttribute('aria-label', '[Ausgewahltes Asset]')
  await expect(details.locator('summary')).toHaveText('[Details mit langem Namen]')
  await expect(details.locator('summary')).toHaveAttribute('aria-label', '[Details fur layout-01.png]')
  await expect(details).toContainText('[Asset-Art]media/image')
  await expect(details).toContainText('[Virtueller Asset-Pfad]images/layout-01.png')
  await expect(details).toContainText('RAW-layout-images')
  await expect(details.getByRole('button', { name: '[Digest kopieren]' })).toHaveText('[Digestwert kopieren]')
  await page.screenshot({ path: '../../docs/evidence/issue-457/assets-detail-i18n-de-DE.png', fullPage: true })
})

const mountEntry = (index: number) => {
  const suffix = String(index).padStart(2, '0')
  return {
    virtualPath: `images/layout-${suffix}.png`,
    name: index === 2 ? 'layout-02-with-a-deliberately-long-filename-that-must-wrap-across-more-than-two-visible-lines-for-clamping-proof.png' : `layout-${suffix}.png`,
    digest: `blake3:${index.toString(16).padStart(64, '0')}`,
    size: 2048 + index,
    mediaType: 'image/png',
    kind: 'media/image',
  }
}

async function installWidgetRoutes(page: Page, scenario: Scenario = 'overflow', mountId = 'layout-images'): Promise<() => void> {
  const rows = Array.from({ length: PAGE_SIZE * 2 }, (_, index) => mountEntry(index + 1))
  await installBaseRoutes(page)
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [
    { id: mountId, mode: 'read', state: 'ready', kind: 'media/image', entryCount: scenario === 'empty' ? 0 : scenario === 'sparse' ? 1 : rows.length },
  ] } }))
  let release!: () => void
  const delayed = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/mounts/*/entries?*', async (route) => {
    if (scenario === 'loading') await delayed
    if (scenario === 'error') {
      await route.fulfill({ status: 500, body: 'layout source listing failed' })
      return
    }
    const url = new URL(route.request().url())
    const secondPage = url.searchParams.get('cursor') === 'layout-page-2'
    const query = (url.searchParams.get('q') ?? '').toLowerCase()
    const source = scenario === 'empty' ? [] : scenario === 'sparse' ? rows.slice(0, 1) : scenario === 'sparse-three' ? rows.slice(0, 3) : rows
    const filtered = source.filter((entry) => entry.name.toLowerCase().includes(query))
    const entries = secondPage ? filtered.slice(PAGE_SIZE) : filtered.slice(0, PAGE_SIZE)
    await route.fulfill({ json: {
      entries,
      ...(!secondPage && query === '' && scenario === 'overflow' ? { folders: ['archive'] } : {}),
      ...(scenario === 'overflow' && filtered.length > PAGE_SIZE && !secondPage ? { cursor: 'layout-page-2' } : {}),
      total: filtered.length + (query === '' && scenario === 'overflow' ? 1 : 0),
    } })
  })
  await page.route('**/api/assets/**', (route) => route.fulfill({
    contentType: 'image/png',
    body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAgUlEQVR42u3YsRUAEBBEwWtCrFf1qUcgoQNibgLhBSb6b2P2sk6vtnF8r98HAAAAAAAAkBjg9w/e7gEAAAAAAIDMAEoQAAAAAAAAsAcoQQAAAAAAAMAeoAQBAAAAAAAAe4ASBAAAAAAAAOwBShAAAAAAAACwByhBAAAAAAAA4DuADXYIgobovTz/AAAAAElFTkSuQmCC', 'base64'),
  }))
  return release
}

async function openWidgetPicker(page: Page, selected: ReturnType<typeof mountEntry> | null = null): Promise<void> {
  // The app exposes __dinksterTest during boot; on a cold dev server the first
  // page.evaluate can otherwise run before the hook exists.
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)
  if (await page.getByTestId('assets-overlay').isVisible().catch(() => false)) {
    await page.getByTestId('assets-toggle').click()
  }
  await page.evaluate((selected) => {
    localStorage.setItem('dinkster.assetBrowser.view.v1', 'list')
    window.__dinksterTest!.app.registerSchemas([{
      type: 'CollectionLayoutAsset', displayName: 'Collection layout asset', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null, kind: 'media/image' } }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'collection-layout', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { asset: { id: 'asset', type: 'CollectionLayoutAsset', values: { image: selected } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { asset: { position: { x: 100, y: 100 } } } } } },
    }, 'Collection layout')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, selected)
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')
    return node?.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'image') === true
  })).toBe(true)
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'image')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

async function installTwoNodeAssetDocument(page: Page, viewportWidth: number): Promise<{ first: { x: number; y: number }, second: { x: number; y: number } }> {
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)
  await page.evaluate((viewportWidth) => {
    const schema = (type: string, label: string) => ({
      type, displayName: type, category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', displayName: label, type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null, kind: 'media/image' } }],
    })
    window.__dinksterTest!.app.registerSchemas([schema('FirstAsset', 'First image'), schema('SecondAsset', 'Second image')])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'asset-handoff', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        first: { id: 'first', type: 'FirstAsset', values: { image: null } },
        second: { id: 'second', type: 'SecondAsset', values: { image: null } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        first: { position: { x: Math.min(500, viewportWidth / 2), y: 100 } },
        second: { position: { x: 0, y: 100 } },
      } } } },
    }, 'Asset handoff')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, viewportWidth)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(2)
  return page.evaluate(() => {
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const point = (nodeId: string) => {
      const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
      const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'image')!
      // Click near the node's left edge so the point stays clear of the
      // centered dialog even on narrow viewports.
      return { x: rect.left + node.x + Math.min(node.layout.width / 2, 12), y: rect.top + node.y + row.y + row.height / 2 }
    }
    return { first: point('first'), second: point('second') }
  })
}

async function openAssetsDock(page: Page): Promise<void> {
  if (!(await page.getByTestId('assets-overlay').isVisible().catch(() => false))) {
    await page.getByTestId('assets-toggle').click()
  }
  await expect(page.getByTestId('assets-overlay')).toBeVisible()
}

const rect = async (locator: Locator) => {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return box!
}

const intersects = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y

const containsVertically = (outer: { y: number; height: number }, inner: { y: number; height: number }): boolean =>
  inner.y >= outer.y - 1 && inner.y + inner.height <= outer.y + outer.height + 1

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
  test(`global Assets list owns overflow and keeps its footer clear at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await mkdir(PROOF, { recursive: true })
    await page.setViewportSize(viewport)
    await installGlobalRoutes(page)
    await page.goto('/')
    await openAssetsDock(page)

    const panel = page.getByTestId('assets-overlay').getByTestId('collection-panel')
    const list = panel.getByTestId('collection-items')
    const footer = panel.locator('.collection-footer')
    const loadMore = page.getByTestId('collection-more')
    await expect(list.getByRole('option')).toHaveCount(PAGE_SIZE)
    await expect(loadMore).toBeVisible()

    const overflow = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
    }))
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight)
    expect(overflow.overflowY).toBe('auto')
    expect(intersects(await rect(list), await rect(footer))).toBe(false)
    expect(intersects(await rect(list.getByRole('option').last()), await rect(loadMore))).toBe(false)
    await page.screenshot({ path: `${PROOF}/global-${viewport.width}x${viewport.height}-overflow-top.png`, fullPage: true })

    const listBox = await rect(list)
    await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2)
    await page.mouse.wheel(0, 800)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)

    await loadMore.click()
    await expect(list.getByRole('option')).toHaveCount(PAGE_SIZE * 2)
    const first = list.getByRole('option').first()
    const last = list.getByRole('option').last()
    await first.focus()
    await first.press('End')
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport()
    expect(containsVertically(await rect(list), await rect(last))).toBe(true)
    expect(intersects(await rect(last), await rect(footer))).toBe(false)
    await panel.getByTestId('collection-search').focus()
    const bottomListBox = await rect(list)
    await page.mouse.move(bottomListBox.x + bottomListBox.width - 4, bottomListBox.y + bottomListBox.height / 2)
    await page.mouse.wheel(0, -1)
    await page.mouse.wheel(0, 1)
    await page.screenshot({ path: `${PROOF}/global-${viewport.width}x${viewport.height}-overflow-bottom.png`, fullPage: true })
  })

  test(`Widget picker list owns overflow between distinct footers at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await mkdir(PROOF, { recursive: true })
    await page.setViewportSize(viewport)
    await installWidgetRoutes(page)
    await page.goto('/')
    await openWidgetPicker(page)

    const editor = page.getByTestId('asset-editor')
    const list = editor.getByTestId('collection-items')
    const footer = editor.locator('.collection-footer')
    const outerActions = editor.locator(':scope > .product-action-footer')
    const loadMore = editor.getByTestId('collection-more')
    await expect(list.getByRole('option')).toHaveCount(PAGE_SIZE + 1)
    await expect(loadMore).toBeVisible()
    expect(await editor.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')
    expect(await editor.evaluate((element) => element.scrollHeight)).toBe(await editor.evaluate((element) => element.clientHeight))
    expect(await editor.locator('.collection-content').evaluate((element) => getComputedStyle(element).overflowY)).toBe('hidden')
    expect(await list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(await list.evaluate((element) => element.clientHeight))
    expect(intersects(await rect(list), await rect(footer))).toBe(false)
    expect(intersects(await rect(footer), await rect(outerActions))).toBe(false)
    await page.screenshot({ path: `${PROOF}/widget-${viewport.width}x${viewport.height}-overflow-top.png`, fullPage: true })

    const source = editor.getByTestId('collection-source-select')
    await source.click()
    await expect(page.getByRole('listbox', { name: 'Source' })).toBeVisible()
    await page.keyboard.press('Escape')
    await editor.getByRole('option', { name: 'archive' }).click()
    await expect(editor.getByRole('button', { name: 'archive' })).toBeVisible()
    await editor.getByRole('button', { name: 'root' }).click()
    await editor.getByTestId('collection-search').fill('layout-48')
    await expect(editor.getByRole('option', { name: /layout-48\.png/ })).toBeVisible()
    await editor.getByTestId('collection-search-clear').click()
    await expect(loadMore).toBeVisible()
    await loadMore.click()
    await expect(list.getByRole('option')).toHaveCount(PAGE_SIZE * 2 + 1)
    const first = list.getByRole('option').first()
    const last = list.getByRole('option').last()
    await first.focus()
    await first.press('End')
    await expect(last).toBeFocused()
    await expect(last).toBeInViewport()
    expect(containsVertically(await rect(list), await rect(last))).toBe(true)
    expect(intersects(await rect(last), await rect(footer))).toBe(false)
    expect(intersects(await rect(footer), await rect(outerActions))).toBe(false)
    await editor.getByTestId('collection-search').focus()
    const bottomListBox = await rect(list)
    await page.mouse.move(bottomListBox.x + bottomListBox.width - 4, bottomListBox.y + bottomListBox.height / 2)
    await page.mouse.wheel(0, -1)
    await page.mouse.wheel(0, 1)
    await page.screenshot({ path: `${PROOF}/widget-${viewport.width}x${viewport.height}-overflow-bottom.png`, fullPage: true })

    await last.click()
    await expect(editor.getByTestId('asset-apply')).toBeEnabled()
    await editor.getByTestId('asset-apply').click()
    await expect(editor).not.toBeVisible()
  })

  test(`Widget picker grid keeps useful cards and a reachable tail at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await mkdir(FOLLOWUP_PROOF, { recursive: true })
    await page.setViewportSize(viewport)
    await installWidgetRoutes(page)
    await page.goto('/')
    await openWidgetPicker(page)

    const editor = page.getByTestId('asset-editor')
    const items = editor.getByTestId('collection-items')
    await editor.getByTestId('collection-mode').click()
    await expect(items).toHaveAttribute('data-mode', 'grid')
    await expect(items.getByRole('option')).toHaveCount(PAGE_SIZE + 1)

    const metrics = await items.getByRole('option').evaluateAll((entries) => entries.map((entry) => {
      const media = entry.querySelector<HTMLElement>('.collection-thumb, .collection-initials, .asset-entry-fallback')!
      const title = entry.querySelector<HTMLElement>('.collection-title')!
      const mediaRect = media.getBoundingClientRect()
      const titleRect = title.getBoundingClientRect()
      const entryRect = entry.getBoundingClientRect()
      return {
        mediaRatio: mediaRect.width / mediaRect.height,
        titleHeight: titleRect.height,
        titleContained: titleRect.top >= entryRect.top && titleRect.bottom <= entryRect.bottom,
        lineClamp: getComputedStyle(title).webkitLineClamp,
      }
    }))
    expect(metrics.every((metric) => metric.mediaRatio > 1.25 && metric.mediaRatio < 1.42)).toBe(true)
    expect(metrics.every((metric) => metric.titleHeight >= 30 && metric.titleHeight <= 36 && metric.titleContained && metric.lineClamp === '2')).toBe(true)
    const longTitle = items.locator('.collection-title').filter({ hasText: 'deliberately-long-filename' })
    await expect(longTitle).toHaveCount(1)
    expect(await longTitle.evaluate((element) => {
      const clone = element.cloneNode(true) as HTMLElement
      clone.style.cssText = `position:fixed;visibility:hidden;width:${element.getBoundingClientRect().width}px;display:block;min-height:0;height:auto;white-space:normal;-webkit-line-clamp:unset;`
      document.body.append(clone)
      const naturalHeight = clone.getBoundingClientRect().height
      clone.remove()
      return naturalHeight > element.getBoundingClientRect().height
    })).toBe(true)
    expect(await items.evaluate((element) => element.scrollHeight)).toBeGreaterThan(await items.evaluate((element) => element.clientHeight))
    await page.screenshot({ path: `${FOLLOWUP_PROOF}/widget-grid-${viewport.width}x${viewport.height}-top.png`, fullPage: true })

    await editor.getByTestId('collection-more').click()
    await expect(items.getByRole('option')).toHaveCount(PAGE_SIZE * 2 + 1)
    const last = items.getByRole('option').last()
    await items.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(last).toBeInViewport()
    const itemsBox = await rect(items)
    const lastBox = await rect(last)
    expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(itemsBox.y + itemsBox.height - 3)
    expect(intersects(lastBox, await rect(editor.locator('.collection-footer')))).toBe(false)
    expect(intersects(await rect(editor.locator('.collection-footer')), await rect(editor.locator(':scope > .product-action-footer')))).toBe(false)
    await page.screenshot({ path: `${FOLLOWUP_PROOF}/widget-grid-${viewport.width}x${viewport.height}-end.png`, fullPage: true })
  })

  test(`Widget picker sparse grid keeps the full-width dialog and selection rail at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await mkdir(FOLLOWUP_PROOF, { recursive: true })
    await page.setViewportSize(viewport)
    await installWidgetRoutes(page, 'sparse')
    await page.goto('/')
    await openWidgetPicker(page)

    const dialog = page.locator('.modal-surface[data-modal="widget-asset"]')
    const editor = page.getByTestId('asset-editor')
    const panel = editor.getByTestId('collection-panel')
    const items = editor.getByTestId('collection-items')
    await editor.getByTestId('collection-mode').click()
    await expect(panel).toHaveAttribute('data-layout', 'sparse')
    await expect(items).toHaveAttribute('data-mode', 'grid')
    await expect(items.getByRole('option')).toHaveCount(1)
    await expect(editor.getByTestId('collection-total')).toHaveCount(0)
    await items.getByRole('option').click()
    const summary = editor.getByTestId('asset-selection-summary')
    await expect(summary).toBeVisible()

    // A sparse result set keeps the full-width dialog: the browse column
    // stays wide and the selection rail stays on the right.
    const dialogBox = await rect(dialog)
    const itemsBox = await rect(items)
    const summaryBox = await rect(summary)
    expect(dialogBox.width).toBeGreaterThan(900)
    expect(itemsBox.width).toBeGreaterThan(500)
    expect(summaryBox.x).toBeGreaterThanOrEqual(itemsBox.x + itemsBox.width)
    expect(await items.evaluate((element) => element.scrollHeight)).toBe(await items.evaluate((element) => element.clientHeight))
    expect(intersects(await rect(items), await rect(editor.locator('.collection-footer')))).toBe(false)
    expect(intersects(await rect(editor.locator('.collection-footer')), await rect(editor.locator(':scope > .product-action-footer')))).toBe(false)
    await page.screenshot({ path: `${FOLLOWUP_PROOF}/widget-sparse-${viewport.width}x${viewport.height}.png`, fullPage: true })
  })

  test(`global and Widget states remain legible at ${viewport.width}x${viewport.height}`, async ({ context }) => {
    await mkdir(PROOF, { recursive: true })
    for (const scenario of ['sparse', 'empty', 'loading', 'error'] as const) {
      const globalPage = await context.newPage()
      await globalPage.setViewportSize(viewport)
      const releaseGlobal = await installGlobalRoutes(globalPage, scenario)
      await globalPage.goto('/')
      await openAssetsDock(globalPage)
      const global = globalPage.getByTestId('assets-overlay')
      if (scenario === 'sparse') await expect(global.getByRole('option')).toHaveCount(1)
      if (scenario === 'empty') await expect(global.getByTestId('collection-empty')).toContainText('No assets yet')
      if (scenario === 'loading') await expect(global.getByTestId('collection-empty')).toContainText('Loading assets')
      if (scenario === 'error') await expect(global.getByTestId('assets-error')).toContainText('500')
      await globalPage.screenshot({ path: `${PROOF}/global-${viewport.width}x${viewport.height}-${scenario}.png`, fullPage: true })
      releaseGlobal()
      await globalPage.close()

      const widgetPage = await context.newPage()
      await widgetPage.setViewportSize(viewport)
      const releaseWidget = await installWidgetRoutes(widgetPage, scenario)
      await widgetPage.goto('/')
      await openWidgetPicker(widgetPage)
      const widget = widgetPage.getByTestId('asset-editor')
      if (scenario === 'sparse') await expect(widget.getByRole('option')).toHaveCount(1)
      if (scenario === 'empty') await expect(widget.getByTestId('collection-empty')).toContainText('No assets yet')
      if (scenario === 'loading') await expect(widget.getByTestId('collection-empty')).toContainText('Loading assets')
      if (scenario === 'error') await expect(widget.getByTestId('collection-error')).toContainText('500')
      await widgetPage.screenshot({ path: `${PROOF}/widget-${viewport.width}x${viewport.height}-${scenario}.png`, fullPage: true })
      releaseWidget()
      await widgetPage.close()
    }
  })
}

test('selected preview leaves one complete Generated grid card visible at 1366x768', async ({ page }) => {
  await mkdir('/tmp/issue5-closure-proof', { recursive: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await installWidgetRoutes(page, 'overflow', 'comfy-output')
  await page.goto('/')
  await openWidgetPicker(page, mountEntry(1))
  await expect(page.getByRole('img', { name: 'Asset preview' })).toBeVisible()

  const editor = page.getByTestId('asset-editor')
  await editor.getByTestId('collection-source-select').click()
  await page.getByRole('option', { name: 'Generated', exact: true }).click()
  await editor.getByTestId('collection-mode').click()
  const items = editor.getByTestId('collection-items')
  const first = items.getByRole('option').first()
  await items.evaluate((element) => { element.scrollTop = 0 })
  const itemsBox = await rect(items)
  const firstBox = await rect(first)
  await page.screenshot({ path: '/tmp/issue5-closure-proof/selected-preview-grid-1366x768.png', fullPage: true })
  expect(firstBox.y).toBeGreaterThanOrEqual(itemsBox.y)
  expect(firstBox.y + firstBox.height).toBeLessThanOrEqual(itemsBox.y + itemsBox.height)
  expect(await first.locator('.collection-title').evaluate((element) => getComputedStyle(element).webkitLineClamp)).toBe('2')
  const collectionFooter = editor.locator('.collection-footer')
  const assetActions = editor.locator(':scope > .product-action-footer')
  expect(intersects(await rect(collectionFooter), await rect(assetActions))).toBe(false)
  await expect(collectionFooter).toBeInViewport()
  await expect(assetActions).toBeInViewport()
})

test('Widget picker keeps its search-first hierarchy at desktop, narrow, and 200% zoom', async ({ page }) => {
  await mkdir(FOLLOWUP_PROOF, { recursive: true })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1600, height: 950 })
  await installWidgetRoutes(page, 'overflow', 'comfy-output')
  await page.goto('/')
  await openWidgetPicker(page, mountEntry(2))

  const dialog = page.locator('.modal-surface[data-modal="widget-asset"]')
  const editor = page.getByTestId('asset-editor')
  const context = editor.getByTestId('asset-schema-metadata')
  const selection = editor.getByTestId('asset-selection-summary')
  const browser = editor.getByRole('region', { name: 'Assets' })
  const search = editor.getByTestId('collection-search')
  const actions = editor.locator(':scope > .product-action-footer')
  // Wait for the browse content to render before measuring: the context
  // strip wraps tall while the dialog is still settling.
  await expect(search).toBeVisible()
  await expect(editor.locator('[data-testid="asset-entry-fallback"][data-kind="folder"]')).toBeVisible()
  const contextBox = await rect(context)
  const selectionBox = await rect(selection)
  const browserBox = await rect(browser)
  // Browse stays primary on the left; the compact selection rail sits to
  // its right and both live below the context strip.
  expect(browserBox.y).toBeGreaterThanOrEqual(contextBox.y + contextBox.height)
  expect(selectionBox.y).toBeGreaterThanOrEqual(contextBox.y + contextBox.height)
  expect(selectionBox.x).toBeGreaterThanOrEqual(browserBox.x + browserBox.width)
  expect(selectionBox.width).toBeLessThan(browserBox.width)
  await page.screenshot({ path: `${FOLLOWUP_PROOF}/widget-selected-1600x950.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await search.scrollIntoViewIfNeeded()
  await expect(search).toBeInViewport()
  const narrowDialog = await rect(dialog)
  expect(narrowDialog.x).toBeGreaterThanOrEqual(0)
  expect(narrowDialog.y).toBeGreaterThanOrEqual(0)
  expect(narrowDialog.x + narrowDialog.width).toBeLessThanOrEqual(390)
  expect(narrowDialog.y + narrowDialog.height).toBeLessThanOrEqual(844)
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await search.fill('not-present')
  await expect(editor.getByTestId('collection-empty')).toContainText('No matching assets')
  await search.focus()
  await page.screenshot({ path: `${FOLLOWUP_PROOF}/widget-no-match-390x844.png`, fullPage: true })

  await editor.getByTestId('collection-search-clear').click()
  await actions.scrollIntoViewIfNeeded()
  await expect(actions).toBeInViewport()
  await expect(editor.getByTestId('asset-upload-trigger')).toBeEnabled()
  await page.screenshot({ path: `${FOLLOWUP_PROOF}/widget-actions-390x844.png`, fullPage: true })

  await page.setViewportSize({ width: 683, height: 384 })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 683,
    height: 384,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await search.scrollIntoViewIfNeeded()
  await expect(search).toBeInViewport()
  expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await editor.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await dialog.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const cancel = actions.getByRole('button', { name: 'Cancel' })
  await cancel.focus()
  await expect(cancel).toBeFocused()
  await page.screenshot({ path: `${FOLLOWUP_PROOF}/widget-1366x768-zoom-200.png`, fullPage: true })
  await expect(cancel).toBeInViewport()
})

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
  test(`one ASSET backdrop press opens the intended second node at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await mkdir('/tmp/issue5-closure-proof', { recursive: true })
    await page.setViewportSize(viewport)
    await installWidgetRoutes(page)
    await page.goto('/')
    const points = await installTwoNodeAssetDocument(page, viewport.width)
    const before = await page.evaluate(() => ({
      revision: window.__dinksterTest!.app.activeTab()!.store.revision,
      document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
    }))
    await page.mouse.click(points.first.x, points.first.y)
    await expect(page.getByRole('dialog', { name: 'Edit First image asset' })).toBeVisible()
    const firstDialogBox = await rect(page.getByRole('dialog', { name: 'Edit First image asset' }))
    expect(points.second.x).toBeLessThan(firstDialogBox.x)

    await page.mouse.click(points.second.x, points.second.y)
    await expect(page.getByRole('dialog', { name: 'Edit First image asset' })).not.toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Edit Second image asset' })).toBeVisible()
    expect(await page.evaluate(() => ({
      revision: window.__dinksterTest!.app.activeTab()!.store.revision,
      document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
    }))).toEqual(before)
    await page.screenshot({ path: `/tmp/issue5-closure-proof/backdrop-handoff-${viewport.width}x${viewport.height}.png`, fullPage: true })
  })
}

test('ASSET backdrop handoff ignores a trusted secondary press', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await installWidgetRoutes(page)
  await page.goto('/')
  const points = await installTwoNodeAssetDocument(page, 1920)
  const before = await page.evaluate(() => ({
    revision: window.__dinksterTest!.app.activeTab()!.store.revision,
    document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  }))
  await page.mouse.click(points.first.x, points.first.y)
  await expect(page.getByRole('dialog', { name: 'Edit First image asset' })).toBeVisible()

  await page.mouse.click(points.second.x, points.second.y, { button: 'right' })
  await expect(page.getByRole('dialog', { name: 'Edit First image asset' })).not.toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit Second image asset' })).not.toBeVisible()
  expect(await page.evaluate(() => ({
    revision: window.__dinksterTest!.app.activeTab()!.store.revision,
    document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  }))).toEqual(before)
})

test('ASSET backdrop handoff ignores a canvas widget occluded by floating chrome', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 })
  await installWidgetRoutes(page)
  await page.goto('/')
  const points = await installTwoNodeAssetDocument(page, 1920)
  const before = await page.evaluate(() => ({
    revision: window.__dinksterTest!.app.activeTab()!.store.revision,
    document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  }))
  await page.mouse.click(points.first.x, points.first.y)
  await expect(page.getByRole('dialog', { name: 'Edit First image asset' })).toBeVisible()
  await page.evaluate((point) => {
    const occluder = document.createElement('div')
    occluder.dataset.testid = 'asset-handoff-occluder'
    Object.assign(occluder.style, {
      position: 'fixed', left: `${point.x - 20}px`, top: `${point.y - 20}px`,
      width: '40px', height: '40px', zIndex: '10000',
    })
    document.body.append(occluder)
  }, points.second)

  await page.mouse.click(points.second.x, points.second.y)
  await expect(page.getByRole('dialog', { name: 'Edit First image asset' })).not.toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Edit Second image asset' })).not.toBeVisible()
  expect(await page.evaluate(() => ({
    revision: window.__dinksterTest!.app.activeTab()!.store.revision,
    document: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  }))).toEqual(before)
})

test('Widget picker remains usable when its selection panel and footers stack at narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 640 })
  await installWidgetRoutes(page)
  await page.goto('/')
  await openWidgetPicker(page)

  const dialog = page.locator('.modal-surface[data-modal="widget-asset"]')
  const editor = page.getByTestId('asset-editor')
  const content = editor.locator('.collection-content')
  const list = editor.getByTestId('collection-items')
  const footer = editor.locator('.collection-footer')
  const outerActions = editor.locator(':scope > .product-action-footer')
  await editor.getByRole('option', { name: /layout-01\.png/ }).click()
  const summary = editor.getByTestId('asset-selection-summary')
  await expect(summary).toBeVisible()
  await page.screenshot({ path: '/tmp/assets-picker-layout-followup-proof/widget-narrow-detail-640x640.png', fullPage: true })

  const dialogBox = await rect(dialog)
  expect(dialogBox.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(640)
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(640)
  const contentBox = await rect(content)
  const listRect = await rect(list)
  const summaryRect = await rect(summary)
  expect(listRect.width).toBeGreaterThan(180)
  expect(listRect.height).toBeGreaterThan(48)
  // At narrow width the compact selection strip stacks above the browse
  // list so the list keeps most of the height.
  expect(summaryRect.y + summaryRect.height).toBeLessThanOrEqual(listRect.y)
  expect(containsVertically(contentBox, listRect)).toBe(true)
  await expect(editor.getByRole('option', { name: /layout-01\.png/ })).toBeInViewport()
  await summary.getByRole('heading', { name: 'layout-01.png' }).scrollIntoViewIfNeeded()
  await expect(summary.getByRole('heading', { name: 'layout-01.png' })).toBeInViewport()
  expect(await list.evaluate((element) => element.scrollHeight)).toBeGreaterThan(await list.evaluate((element) => element.clientHeight))
  await footer.scrollIntoViewIfNeeded()
  expect(containsVertically(await rect(dialog), await rect(footer))).toBe(true)
  await outerActions.scrollIntoViewIfNeeded()
  expect(containsVertically(await rect(dialog), await rect(outerActions))).toBe(true)
  await expect(editor.getByTestId('asset-apply')).toBeEnabled()
  await expect(editor.getByTestId('asset-upload-trigger')).toBeEnabled()
})

test('Widget sparse grid fits a short dialog without inner scrollboxes', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 520 })
  await installWidgetRoutes(page, 'sparse-three')
  await page.goto('/')
  await openWidgetPicker(page)

  const dialog = page.locator('.modal-surface[data-modal="widget-asset"]')
  const editor = page.getByTestId('asset-editor')
  const items = editor.getByTestId('collection-items')
  await editor.getByTestId('collection-mode').click()
  await expect(editor.getByTestId('collection-panel')).toHaveAttribute('data-layout', 'sparse')
  await expect(items.getByRole('option')).toHaveCount(3)
  // The sparse grid never grows its own scrollbox, and the editor body
  // scales down with the viewport instead of spilling: any residual
  // overflow belongs to the editor scroller, not the grid.
  expect(await items.evaluate((element) => element.scrollHeight)).toBe(await items.evaluate((element) => element.clientHeight))
  expect(await editor.evaluate((element) => getComputedStyle(element).overflowY)).toBe('auto')

  await items.getByRole('option').last().scrollIntoViewIfNeeded()
  await expect(items.getByRole('option').last()).toBeInViewport()
  const collectionFooter = editor.locator('.collection-footer')
  const actionFooter = editor.locator(':scope > .product-action-footer')
  await collectionFooter.scrollIntoViewIfNeeded()
  expect(containsVertically(await rect(dialog), await rect(collectionFooter))).toBe(true)
  await actionFooter.scrollIntoViewIfNeeded()
  expect(containsVertically(await rect(dialog), await rect(actionFooter))).toBe(true)
  // Browse content never paints over either footer. The collection footer
  // lives inside the browse section, so compare it against the items grid.
  expect(intersects(await rect(items), await rect(collectionFooter))).toBe(false)
  expect(intersects(await rect(editor.locator('.asset-browser-section')), await rect(actionFooter))).toBe(false)
})
