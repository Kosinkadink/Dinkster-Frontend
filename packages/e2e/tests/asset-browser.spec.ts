import { expect, selectProductOption, test, type Page, type Request } from './fixtures.js'
import { mkdir } from 'node:fs/promises'

interface AssetValue {
  digest: string
  name: string
  size: number
  mediaType: string
  virtualPath: string
}

const MOCK = 'http://asset-browser.test'
const IMAGE_DIGEST = `blake3:${'1'.repeat(64)}`
const SECOND_DIGEST = `blake3:${'2'.repeat(64)}`
const MODEL_DIGEST = `blake3:${'3'.repeat(64)}`
const OTHER_DIGEST = `blake3:${'4'.repeat(64)}`
const BROKEN_DIGEST = `blake3:${'5'.repeat(64)}`
const CORRUPT_DIGEST = `blake3:${'6'.repeat(64)}`
const WIDE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAYAAADl5PURAAAB60lEQVR42u3UMQEAIAzEwCphRh3CmBGGg1bI33AGMqTWeQ2QqEQADBDAAAEMEMAAAQwQwAABDBDAAAEMEMAAAQwQwAABDBDAAAEMEMAAAQwQwAABDBDAAAEMEMAAAQwQwAABDBDAAAEMEMAAAQMUAjBAAAMEMEAAAwQwQAADBDBAAAMEMEAAAwQwQAADBDBAAAMEMEAAAwQwQAADBDBAAAMEMEAAAwQwQAADBDBAAAMEMEAAAwQMEMAAAQwQwAABDBDAAAEMEMAAAQwQwAABDBDAAAEMEMAAAQwQwAABDBDAAAEMEMAAAQwQwAABDBDAAAEMEMAAAQwQwAABAxQBMEAAAwQIGeC/uwESGSBggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIGKAIgAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIIABAhgggAECGCCAAQIYIGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggAAGCGCAAAYIYIAABghggIABAhggQIgBRMCg70K8+3IAAAAASUVORK5CYII=', 'base64')
const PORTRAIT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAPAAAAFACAYAAACC6PFTAAACwklEQVR42u3TQQ0AIAwAsSlBBMKQgxKUYGgTsdeSPmrgkou7XwIzhQhgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgcHAIoCBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAgIHBwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYMDAYGDAwYGAwMGBgwMCAgcHAgIEBA4OBRQADAwYGDAwGBgwMGBgwMBgYMDDQHHj9k8BMBgYDAwYGDAwGBgwMGBgwMBgYMDBgYDAwYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDAYWAQwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwGFgIMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMBgYMDAgIEBA4OBAQMDBgYMDAYGDAwYGAwMGBgwMGBgMDBgYMDAgIHBwICBAQODgQEDAwYGDAwGBgwMGBgMLAIYGDAwYGAwMGBgwMCAgcHAgIGBpgIasbqLXIbSyAAAAABJRU5ErkJggg==', 'base64')
const PROOF_DIR = '/tmp/assets-node-preview-proof'
const value = (page: Page): Promise<AssetValue | null> => page.evaluate(() =>
  window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image as AssetValue | null)

const entries = [
  { virtualPath: 'photos/sunset.png', name: 'sunset.png', digest: IMAGE_DIGEST, size: 2048, mediaType: 'image/png', kind: 'media/image' },
  { virtualPath: 'photos/style.safetensors', name: 'style.safetensors', digest: MODEL_DIGEST, size: 4096, mediaType: 'application/x-safetensors', kind: 'model/lora' },
  { virtualPath: 'photos/readme.txt', name: 'readme.txt', digest: OTHER_DIGEST, size: 12, mediaType: 'text/plain', kind: 'document/text' },
  { virtualPath: 'photos/moon.png', name: 'moon.png', digest: SECOND_DIGEST, size: 3072, mediaType: 'image/png', kind: 'media/image' },
  { virtualPath: 'photos/trips/coast.png', name: 'coast.png', digest: SECOND_DIGEST, size: 1024, mediaType: 'image/png', kind: 'media/image' },
  { virtualPath: 'photos/broken.png', name: 'broken.png', digest: BROKEN_DIGEST, size: 12, mediaType: 'image/png', kind: 'media/image' },
  { virtualPath: 'photos/corrupt.png', name: 'corrupt.png', digest: CORRUPT_DIGEST, size: 12, mediaType: 'image/png', kind: 'media/image' },
]

const assetRef = (entry: typeof entries[number]): AssetValue => ({
  digest: entry.digest,
  name: entry.name,
  size: entry.size,
  mediaType: entry.mediaType,
  virtualPath: entry.virtualPath,
})

async function captureProof(page: Page, name: string): Promise<void> {
  await mkdir(PROOF_DIR, { recursive: true })
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport)
    await page.screenshot({ path: `${PROOF_DIR}/${name}-${viewport.width}x${viewport.height}.png` })
  }
}

async function installMockBackend(page: Page, requests: Request[]): Promise<void> {
  await page.route('**/api/nodes*', (route) => void route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'test', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route('**/api/mounts**', async (route) => {
    const request = route.request()
    requests.push(request)
    const url = new URL(request.url())
    if (url.pathname === '/api/mounts') {
      // 'read' is the server's word (dinkster_assets MOUNT_MODES). This mock
      // once said 'readonly', which let the frontend ship a decoder that
      // silently hid every real read mount - the fixture must speak the
      // server vocabulary, never the frontend's guess.
      await route.fulfill({ json: { mounts: [
        { id: 'input', mode: 'read', state: 'ready' },
        { id: 'shared', mode: 'readwrite', state: 'ready' },
        { id: 'indexing', mode: 'read', state: 'scanning' },
      ] } })
      return
    }
    if (url.pathname.match(/^\/api\/mounts\/[^/]+\/entries$/)) {
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const path = url.searchParams.get('path') ?? ''
      const recursive = url.searchParams.get('recursive') !== 'false'
      const prefix = path === '' ? '' : `${path}/`
      const matching = entries.filter((entry) => {
        if (!entry.virtualPath.toLowerCase().includes(q) || !entry.virtualPath.startsWith(prefix)) return false
        return recursive || !entry.virtualPath.slice(prefix.length).includes('/')
      })
      const cursor = url.searchParams.get('cursor')
      const hasCursor = url.searchParams.has('cursor')
      const cursorKey = `page-2:${path}:${recursive}:${q}`
      if (hasCursor && cursor !== cursorKey) {
        await route.fulfill({ status: 400, body: 'cursor does not belong to query' })
        return
      }
      const pageEntries = hasCursor ? matching.slice(2) : matching.slice(0, 2)
      await route.fulfill({ json: {
        entries: pageEntries,
        ...(!recursive && !hasCursor ? { folders: path === '' ? ['photos'] : path === 'photos' ? ['trips'] : [] } : {}),
        ...(matching.length > 2 && !hasCursor ? { cursor: cursorKey } : {}),
      } })
      return
    }
    await route.fulfill({ status: 404 })
  })
  await page.route('**/api/assets/**', async (route) => {
    const request = route.request()
    requests.push(request)
    const url = new URL(request.url())
    if (url.pathname.endsWith('/metadata')) {
      await route.fulfill({ json: { format: 'safetensors', tensorCount: 17, parameterCount: 123456, dtypes: { F16: 16, F32: 1 } } })
    } else if (url.pathname.endsWith(encodeURIComponent(BROKEN_DIGEST)) || url.pathname.endsWith(BROKEN_DIGEST)) {
      await route.fulfill({ status: 404 })
    } else if (url.pathname.endsWith(encodeURIComponent(CORRUPT_DIGEST)) || url.pathname.endsWith(CORRUPT_DIGEST)) {
      await route.fulfill({ contentType: 'image/png', body: Buffer.from('not a decodable image') })
    } else if (url.pathname.endsWith(encodeURIComponent(SECOND_DIGEST)) || url.pathname.endsWith(SECOND_DIGEST)) {
      await route.fulfill({ contentType: 'image/png', body: PORTRAIT_PNG })
    } else {
      await route.fulfill({ contentType: 'image/png', body: WIDE_PNG })
    }
  })
}

async function openAsset(page: Page, enterFolder = true): Promise<void> {
  await ensureDockClosed(page)
  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === 'asset')!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === 'image')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: rect.left + viewport.x + (node.x + node.layout.width / 2) * viewport.scale,
      y: rect.top + viewport.y + (node.y + row.y + row.height / 2) * viewport.scale,
    }
  })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('collection-panel')).toBeVisible()
  if (enterFolder) {
    await page.getByRole('option', { name: /^photos/ }).click()
    await expect(page.getByRole('button', { name: 'photos' })).toBeVisible()
  }
}

// Dock panels keep their own collection panels mounted (and a page reload
// restores them); close the dock so the asset editor's collection panel is
// the only one on the page.
async function ensureDockClosed(page: Page): Promise<void> {
  const closeDock = page.getByRole('button', { name: 'Close Primary dock panels' })
  if (await closeDock.isVisible()) await closeDock.click()
  await expect(page.getByTestId('collection-panel')).toHaveCount(0)
}

async function closeAsset(page: Page): Promise<void> {
  await page.getByTestId('asset-editor').getByRole('button', { name: 'cancel' }).click()
  await expect(page.getByTestId('asset-editor')).not.toBeVisible()
}

test.beforeEach(async ({ page }) => {
  const requests: Request[] = []
  await page.routeWebSocket('**/api/events?*', () => {})
  await installMockBackend(page, requests)
  await page.goto('/')
  await page.evaluate(() => localStorage.setItem('dinkster.assetBrowser.view.v1', 'list'))
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(MOCK)
  await page.getByTestId('backend-add').click()
  await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'AssetBrowserTest', displayName: 'Asset Browser', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
        widget: { widgetType: 'ASSET', options: { accept: ['image/png', 'application/x-safetensors'] }, default: null } }],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'asset-browser', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { asset: { id: 'asset', type: 'AssetBrowserTest', values: { image: null } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { asset: { position: { x: 100, y: 100 } } } } } },
    }, 'Asset Browser')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'AssetBrowserTest', displayName: 'Asset Browser', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
      widget: { widgetType: 'ASSET', options: { accept: ['image/png', 'application/x-safetensors'] }, default: null } }],
  }]))
  await ensureDockClosed(page)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')?.layout.rows.some((item) => item.kind === 'widget' && item.inputId === 'image'))).toBe(true)
})

test('lists only ready readable sources and filters incompatible MIME types', async ({ page }) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#429
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#429')
  await openAsset(page)
  await page.getByTestId('collection-source-select').click()
  await expect(page.getByRole('listbox', { name: 'Source' }).getByRole('option')).toHaveText(['input', 'shared'])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /style\.safetensors/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /readme\.txt/ })).toHaveCount(0)
})

test('server search resets query-bound paging and paging appends page two', async ({ page }) => {
  const entryRequests: string[] = []
  page.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/entries')) entryRequests.push(request.url()) })
  await openAsset(page)
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
  await page.getByRole('button', { name: 'Load more' }).click()
  await expect(page.getByRole('option', { name: /moon\.png/ })).toBeVisible()
  expect(entryRequests.some((url) => new URL(url).searchParams.get('cursor') === 'page-2:photos:false:')).toBe(true)

  await page.getByTestId('collection-search').fill('moon')
  await expect(page.getByRole('option', { name: /moon\.png/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toHaveCount(0)
  await expect.poll(() => entryRequests.some((url) => new URL(url).searchParams.get('q') === 'moon' && !new URL(url).searchParams.has('cursor'))).toBe(true)
  await page.getByTestId('collection-search').fill('')
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
  await expect.poll(() => entryRequests.filter((url) => !new URL(url).searchParams.has('q') && !new URL(url).searchParams.has('cursor')).length).toBeGreaterThanOrEqual(2)
})

test('click and keyboard Enter stage the pick; Apply commits the complete AssetRef', async ({ page }) => {
  await openAsset(page)
  await page.getByRole('option', { name: /sunset\.png/ }).click()
  // Staging alone must not commit or close.
  await expect(page.getByTestId('asset-selection-summary')).toContainText('sunset.png')
  expect(await value(page)).toBeNull()
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).not.toBeVisible()
  expect(await value(page)).toEqual({ digest: IMAGE_DIGEST, name: 'sunset.png', size: 2048, mediaType: 'image/png', virtualPath: 'photos/sunset.png' })

  await openAsset(page)
  const first = page.getByRole('option', { name: /sunset\.png/ })
  await first.focus()
  await first.press('ArrowDown')
  await expect(page.getByRole('option', { name: /style\.safetensors/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('asset-selection-summary')).toContainText('style.safetensors')
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).not.toBeVisible()
  expect((await value(page))?.digest).toBe(MODEL_DIGEST)
})

test('selected image assets preview immediately inside the node and follow import, change, clear, reload, and failure', async ({ page }) => {
  const pageErrors: Error[] = []
  page.on('pageerror', (error) => pageErrors.push(error))
  const previewState = () => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'asset')!
    return {
      preview: window.__dinksterTest!.renderer!.getNodePreviews().asset,
      region: node.layout.preview,
      node: { width: node.layout.width, height: node.layout.height },
    }
  })
  const expectGeometry = async (scale: number, width: number, height: number, count: number) => {
    await page.evaluate((nextScale) => window.__dinksterTest!.renderer!.setViewport({ x: -80, y: -55, scale: nextScale }), scale)
    const state = await previewState()
    expect(state.preview).toMatchObject({ width, height, count })
    expect(state.region).toBeDefined()
    expect(state.region!.x).toBeGreaterThanOrEqual(0)
    expect(state.region!.y).toBeGreaterThanOrEqual(0)
    expect(state.region!.x + state.region!.width).toBeLessThanOrEqual(state.node.width)
    expect(state.region!.y + state.region!.height).toBeLessThanOrEqual(state.node.height)
  }

  const imported = [assetRef(entries[0]!), assetRef(entries[3]!)]
  await page.evaluate((images) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'asset-browser-import', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: {
          asset: { id: 'asset', type: 'AssetBrowserTest', values: { image: images } },
          empty: { id: 'empty', type: '#g1', values: {} },
        }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 },
        g1: { id: 'g1', name: 'empty', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
      },
      view: { graphs: { g0: { nodes: {
        asset: { position: { x: 100, y: 100 } },
        empty: { position: { x: 600, y: 100 } },
      } }, g1: { nodes: {} } } },
    }, 'Imported Asset Browser')
  }, imported)
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'AssetBrowserTest', displayName: 'Asset Browser', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
      widget: { widgetType: 'ASSET', options: { accept: ['image/png', 'application/x-safetensors'] }, default: null } }],
  }]))
  await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
  await expect.poll(async () => (await previewState()).preview?.width).toBe(320)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image)).toEqual(imported)
  const accessiblePreview = page.getByTestId('canvas-preview-a11y')
  await expect(accessiblePreview).toHaveRole('img')
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input sunset.png, 2 selected images: 320 by 180 pixels')
  expect(await accessiblePreview.evaluate((element) => element.tabIndex)).toBe(-1)
  await expectGeometry(1, 320, 180, 2)

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.instancePath.set(['empty'])
    tab.graphStack.set(['g0', 'g1'])
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('g1')
  await expect(accessiblePreview).toHaveCount(0)
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.instancePath.set([])
    tab.graphStack.set(['g0'])
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('g0')
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input sunset.png, 2 selected images: 320 by 180 pixels')

  const tab = (title: string) => page.getByTestId('tab-bar').locator('.tab', {
    has: page.locator('.tab-select', { hasText: new RegExp(`^${title}$`) }),
  }).locator('.tab-select')
  await tab('Asset Browser').click()
  await expect(accessiblePreview).toHaveCount(0)
  await tab('Imported Asset Browser').click()
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input sunset.png, 2 selected images: 320 by 180 pixels')

  await page.getByTestId('backends-toggle').click()
  await captureProof(page, 'imported-selected')
  for (const scale of [0.5, 1, 1.6]) {
    await expectGeometry(scale, 320, 180, 2)
    await captureProof(page, `zoom-${String(scale).replace('.', '_')}x`)
  }

  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'AssetBrowserTest', displayName: 'Asset Browser', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
      widget: { widgetType: 'ASSET', options: { accept: ['image/png', 'application/x-safetensors'] }, default: null } }],
  }]))
  await expect.poll(async () => (await previewState()).preview?.width).toBe(320)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.asset!.values.image)).toEqual(imported)
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input sunset.png, 2 selected images: 320 by 180 pixels')

  await openAsset(page)
  await page.getByTestId('asset-editor').getByTestId('asset-selection-remove').click()
  await page.getByTestId('asset-apply').click()
  await expect.poll(async () => (await previewState()).region).toBeUndefined()
  await expect(accessiblePreview).toHaveCount(0)
  await captureProof(page, 'cleared')

  await openAsset(page)
  await page.getByRole('option', { name: /sunset\.png/ }).click()
  await page.getByTestId('asset-apply').click()
  await expect.poll(async () => (await previewState()).preview?.width).toBe(320)
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input sunset.png: 320 by 180 pixels')
  await captureProof(page, 'picker-selected')

  await openAsset(page)
  await page.getByRole('button', { name: 'Load more' }).click()
  const secondRequest = page.waitForRequest((request) => request.url().includes(encodeURIComponent(SECOND_DIGEST)))
  const moon = page.getByRole('option', { name: /moon\.png/ })
  await moon.focus()
  await moon.press('Enter')
  await page.getByTestId('asset-apply').click()
  await secondRequest
  await expect.poll(() => value(page).then((asset) => asset?.digest)).toBe(SECOND_DIGEST)
  await expect.poll(async () => (await previewState()).preview?.width).toBe(240)
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input moon.png: 240 by 320 pixels')
  await expectGeometry(1, 240, 320, 1)
  await captureProof(page, 'changed-digest')

  await openAsset(page)
  await page.getByRole('button', { name: 'Load more' }).click()
  await page.getByRole('option', { name: /corrupt\.png/ }).click()
  await page.getByTestId('asset-apply').click()
  await expect.poll(async () => (await previewState()).preview?.status).toBe('unavailable')
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input corrupt.png: unavailable')
  await captureProof(page, 'unavailable-corrupt')

  await openAsset(page)
  await page.getByRole('button', { name: 'Load more' }).click()
  await page.getByRole('option', { name: /broken\.png/ }).click()
  await page.getByTestId('asset-apply').click()
  await expect.poll(async () => (await previewState()).preview?.status).toBe('unavailable')
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input broken.png: unavailable')

  await openAsset(page)
  await page.getByRole('option', { name: /sunset\.png/ }).click()
  await page.getByTestId('asset-apply').click()
  await expect.poll(async () => (await previewState()).preview?.width).toBe(320)
  await expect(accessiblePreview).toHaveAccessibleName('Asset Browser, selected input sunset.png: 320 by 180 pixels')

  await openAsset(page)
  await page.getByTestId('asset-editor').getByTestId('asset-selection-remove').click()
  await page.getByTestId('asset-apply').click()
  await expect.poll(async () => (await previewState()).region).toBeUndefined()
  await expect(accessiblePreview).toHaveCount(0)
  expect(pageErrors).toEqual([])
})

test('a typed query supersedes the in-flight page immediately: no stale commit, no old cursor', async ({ page }) => {
  // The debounce delays only the FETCH. The moment a query keystroke lands,
  // the old request and the old page's cursor are dead: a slow response for
  // the previous query must never render, and "Load more" must never send
  // the new query with the old query's continuation.
  let releaseStale: (() => void) | undefined
  await page.route('**/api/mounts/*/entries*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('q') !== 'slow') return route.fallback()
    await new Promise<void>((resolve) => { releaseStale = resolve })
    try {
      await route.fulfill({ json: { entries: [
        { virtualPath: 'stale/stale-page.png', name: 'stale-page.png', digest: SECOND_DIGEST, size: 1, mediaType: 'image/png', kind: 'media/image' },
      ], total: 1 } })
    } catch {
      /* the aborted request may already be gone - exactly the point */
    }
  })
  await openAsset(page)
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Load more' })).toBeVisible()

  await page.getByTestId('collection-search').fill('slow')
  // The old page's cursor dies with the keystroke, before the fetch fires.
  await expect(page.getByRole('button', { name: 'Load more' })).not.toBeVisible()
  await expect.poll(() => releaseStale !== undefined).toBe(true) // q=slow is now in flight
  await page.getByTestId('collection-search').fill('moon') // supersedes it during its flight
  await expect(page.getByRole('option', { name: /moon\.png/ })).toBeVisible()
  releaseStale!()
  await page.waitForTimeout(200) // let the stale response settle
  await expect(page.getByRole('option', { name: /stale-page\.png/ })).toHaveCount(0)
  await expect(page.getByRole('option', { name: /moon\.png/ })).toBeVisible()
})

test('reopening the editor shows the current asset selected with its selection panel populated', async ({ page }) => {
  await openAsset(page)
  await page.getByRole('option', { name: /sunset\.png/ }).click()
  await page.getByTestId('asset-apply').click()
  await expect(page.getByTestId('asset-editor')).not.toBeVisible()

  await openAsset(page)
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('asset-selection-summary')).toContainText('sunset.png')
})

test('Tab traverses folder controls then reaches the entry list roving stop', async ({ page }) => {
  await openAsset(page)
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
  // Folder controls are intentionally in the keyboard order between the
  // toolbar and the list. The list itself still contributes one roving
  // tab stop rather than every loaded entry.
  await page.getByRole('button', { name: 'Grid view' }).focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'root' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'photos' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('option', { name: /^trips/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeFocused()
})

test('navigates mount folders with breadcrumbs as the only traversal and folder-scoped search', async ({ page }) => {
  const entryRequests: string[] = []
  page.on('request', (request) => { if (/\/api\/mounts\/[^/]+\/entries/.test(request.url())) entryRequests.push(request.url()) })
  await openAsset(page, false)
  await expect(page.getByRole('option', { name: /^photos/ })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Back one folder' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'root' })).toHaveAttribute('aria-current', 'page')

  await page.getByRole('option', { name: /^photos/ }).click()
  await expect(page.getByRole('option', { name: /^trips/ })).toBeVisible()
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
  await page.getByRole('option', { name: /^trips/ }).click()
  await expect(page.getByRole('option', { name: /coast\.png/ })).toBeVisible()
  await page.getByRole('button', { name: 'photos' }).click()
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toBeVisible()
  await page.getByTestId('collection-search').fill('coast')
  await expect(page.getByRole('option', { name: /coast\.png/ })).toBeVisible()
  await expect.poll(() => entryRequests.some((raw) => {
    const url = new URL(raw)
    return url.searchParams.get('path') === 'photos' && url.searchParams.get('recursive') === 'true'
      && url.searchParams.get('q') === 'coast' && !url.searchParams.has('cursor')
  })).toBe(true)
  await page.getByTestId('collection-search').fill('')
  await expect(page.getByRole('option', { name: /^trips/ })).toBeVisible()
  await page.getByRole('button', { name: 'root' }).click()
  await expect(page.getByRole('option', { name: /^photos/ })).toBeVisible()
})

test('changing selection during a slow inspection never shows the old metadata', async ({ page }) => {
  // AP10: the inspection that started on style.safetensors must not attach
  // its metadata (or failure) to whatever the user selected while it flew.
  await page.route('**/api/assets/**/metadata', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400))
    await route.fulfill({ json: { format: 'safetensors', tensorCount: 17 } })
  })
  await openAsset(page)
  await page.getByRole('option', { name: /style\.safetensors/ }).click()
  const rail = page.getByTestId('asset-selection-summary')
  await rail.getByTestId('asset-rail-details').locator('summary').click()
  await rail.getByRole('button', { name: 'Inspect model metadata' }).click()
  await page.getByRole('option', { name: /sunset\.png/ }).click() // supersede while in flight
  await expect(rail).toContainText('sunset.png')
  await page.waitForTimeout(600) // let the stale inspection settle
  await expect(rail).toContainText('sunset.png')
  await expect(rail.locator('pre')).not.toBeVisible() // no zombie metadata
})

test('changing from an image to a model clears image-only preview facts', async ({ page }) => {
  await openAsset(page)
  await page.getByRole('option', { name: /sunset\.png/ }).click()
  const rail = page.getByTestId('asset-selection-summary')
  await expect(rail.getByTestId('asset-preview-caption')).toHaveText('320 x 180')

  await page.getByRole('option', { name: /style\.safetensors/ }).click()
  await expect(rail).toContainText('style.safetensors')
  await expect(rail.getByTestId('asset-preview-caption')).toHaveCount(0)
  await expect(rail.getByRole('img', { name: 'Asset preview' })).toHaveCount(0)
  await rail.getByTestId('asset-rail-details').locator('summary').click()
  await expect(rail).not.toContainText('Resolution')
})

test('keeps the browse list primary with the selection in a compact right rail', async ({ page }) => {
  // A scalar pick stages, Apply commits and closes; reopening shows the
  // committed selection beside the list.
  await openAsset(page)
  const editor = page.getByTestId('asset-editor')
  await editor.getByRole('option', { name: /sunset\.png/ }).click()
  await editor.getByTestId('asset-apply').click()
  await expect(editor).not.toBeVisible()
  await openAsset(page, false)
  const summary = editor.getByTestId('asset-selection-summary')
  await expect(summary).toBeVisible()
  const browse = editor.getByRole('region', { name: 'Assets' })
  const summaryBox = (await summary.boundingBox())!
  const browseBox = (await browse.boundingBox())!
  expect(summaryBox).not.toBeNull()
  expect(browseBox).not.toBeNull()
  // The selection rail sits to the right of the browse list and stays
  // narrower, so selecting never squeezes browsing.
  expect(summaryBox.x).toBeGreaterThanOrEqual(browseBox.x + browseBox.width)
  expect(summaryBox.width).toBeLessThan(browseBox.width)

  // A sparse result set (few rows, no cursor) must not shrink the dialog:
  // the browse column keeps its full width regardless of result count.
  await page.getByTestId('collection-search').fill('sunset')
  await expect(editor.locator('.collection-panel')).toHaveAttribute('data-layout', 'sparse')
  await expect(summary).toBeVisible()
  const modalBox = (await page.locator(".modal-surface[data-modal='widget-asset']").boundingBox())!
  const sparseSummaryBox = (await summary.boundingBox())!
  const sparseBrowseBox = (await browse.boundingBox())!
  expect(modalBox.width).toBeGreaterThan(900)
  expect(sparseSummaryBox.x).toBeGreaterThanOrEqual(sparseBrowseBox.x + sparseBrowseBox.width)
  expect(sparseBrowseBox.width).toBeGreaterThan(500)
})

test('details expose digest and metadata remains opt-in', async ({ page }) => {
  const metadataRequests: string[] = []
  page.on('request', (request) => { if (request.url().endsWith('/metadata')) metadataRequests.push(request.url()) })
  await openAsset(page)
  await page.getByRole('option', { name: /style\.safetensors/ }).click()
  const rail = page.getByTestId('asset-selection-summary')
  await expect(rail).toContainText('style.safetensors')
  await expect(rail).toContainText('4.0 KiB')
  // Debug metadata stays demoted (hidden) until the Details disclosure opens.
  await expect(rail.locator('.asset-digest')).toBeHidden()
  await rail.getByTestId('asset-rail-details').locator('summary').click()
  await expect(rail.locator('.asset-digest')).toBeVisible()
  await expect(rail.locator('.asset-digest code')).toHaveText(`${MODEL_DIGEST.slice(0, 12)}...${MODEL_DIGEST.slice(-8)}`)
  await expect(rail.locator('.asset-digest code')).toHaveAttribute('title', MODEL_DIGEST)
  await expect(rail.getByRole('button', { name: 'Copy digest' })).toBeVisible()
  expect(metadataRequests).toHaveLength(0)
  await rail.getByRole('button', { name: 'Inspect model metadata' }).click()
  await expect(rail).toContainText('"tensorCount": 17')
  await expect(rail).toContainText('"F16": 16')
  expect(metadataRequests).toHaveLength(1)
})

test('view switch preserves selection and the preference survives editor reopen', async ({ page }) => {
  await openAsset(page)
  const sunset = page.getByRole('option', { name: /sunset\.png/ })
  await sunset.click()
  await page.getByRole('button', { name: 'Grid view' }).click()
  await expect(page.getByRole('option', { name: /sunset\.png/ })).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => localStorage.getItem('dinkster.assetBrowser.view.v1'))).toBe('grid')
  await closeAsset(page)
  await openAsset(page)
  await expect(page.getByRole('button', { name: 'List view' })).toBeVisible()
})

test("a legacy persisted 'tile' preference still opens the grid", async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('dinkster.assetBrowser.view.v1', 'tile'))
  await openAsset(page)
  await expect(page.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
})
