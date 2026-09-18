import { expect, selectProductOption, test, type Page } from './fixtures.js'

const MOCK = 'http://logical-model-picker.test'
const A = `blake3:${'a'.repeat(64)}`
const B = `blake3:${'b'.repeat(64)}`
const C = `blake3:${'c'.repeat(64)}`
const IMAGE = `blake3:${'d'.repeat(64)}`

const mountEntries = {
  left: [
    { digest: A, name: 'zeta.safetensors', size: 100, mediaType: 'application/x-safetensors', kind: 'model/checkpoint', virtualPath: 'models/zeta.safetensors' },
    { digest: B, name: 'shared.safetensors', size: 200, mediaType: 'application/x-safetensors', kind: 'model/checkpoint', virtualPath: 'models/a/shared.safetensors' },
    { digest: IMAGE, name: 'photo.png', size: 10, mediaType: 'image/png', kind: 'media/image', virtualPath: 'images/photo.png' },
  ],
  right: [
    { digest: A, name: 'alpha.safetensors', size: 100, mediaType: 'application/x-safetensors', kind: 'model/checkpoint', virtualPath: 'renamed/alpha.safetensors' },
    { digest: C, name: 'shared.safetensors', size: 300, mediaType: 'application/x-safetensors', kind: 'model/checkpoint', virtualPath: 'models/b/shared.safetensors' },
  ],
} as const

async function installRoutes(page: Page): Promise<void> {
  await page.route('**/api/nodes*', (route) => void route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'test', schemaWire: 22 },
    nodes: {},
  } }))
  await page.route('**/api/mounts**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/mounts') {
      await route.fulfill({ json: { mounts: [
        { id: 'left', mode: 'read', state: 'ready' },
        { id: 'right', mode: 'read', state: 'ready' },
      ] } })
      return
    }
    const match = url.pathname.match(/^\/api\/mounts\/(left|right)\/entries$/)
    if (match !== null) {
      const kind = url.searchParams.get('kind')
      const entries = mountEntries[match[1] as 'left' | 'right'].filter((entry) => kind === null || entry.kind === kind)
      await route.fulfill({ json: { entries } })
      return
    }
    await route.fulfill({ status: 404 })
  })
}

async function openWidget(page: Page, nodeId: string, inputId: string): Promise<void> {
  const point = await page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId })
  await page.mouse.click(point.x, point.y)
  await expect(page.getByTestId('asset-editor')).toBeVisible()
}

test('uses one collection shell for grouped models and media', async ({ page }) => {
  await installRoutes(page)
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(MOCK)
  await page.getByTestId('backend-add').click()
  await selectProductOption(page, page.getByTestId('tab-target'), MOCK)
  await expect.poll(() => page.evaluate((url) =>
    window.__dinksterTest!.app.backends.get().find((backend) => backend.baseUrl === url)?.registry.get() !== undefined, MOCK)).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'ModelPickerProof', displayName: 'Model picker proof', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'model', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
          widget: { widgetType: 'ASSET', kind: 'model/checkpoint', options: { accept: ['application/x-safetensors'] }, default: null } }],
      },
      {
        type: 'MediaPickerProof', displayName: 'Media picker proof', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false,
          widget: { widgetType: 'ASSET', kind: 'media/image', options: { accept: ['image/png'] }, default: null } }],
      },
    ])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'logical-model-picker', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        model: { id: 'model', type: 'ModelPickerProof', values: { model: null } },
        media: { id: 'media', type: 'MediaPickerProof', values: { image: null } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } },
      view: { graphs: { g0: { nodes: {
        model: { position: { x: 100, y: 100 } },
        media: { position: { x: 500, y: 100 } },
      } } } },
    }, 'Logical model picker')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.id === 'logical-model-picker' && 'status' in tab.store
  })

  await openWidget(page, 'model', 'model')
  const modelEditor = page.getByTestId('asset-editor')
  await expect(modelEditor.getByTestId('collection-panel')).toBeVisible()
  await expect(modelEditor.getByTestId('collection-items')).toHaveAttribute('data-mode', 'list')
  await expect(modelEditor.getByTestId('collection-entry')).toHaveCount(3)
  await expect(modelEditor.getByTestId('collection-group')).toHaveCount(1)
  const search = modelEditor.getByTestId('collection-search')
  await expect(search).toBeVisible()
  await expect(search).toHaveAttribute('placeholder', 'Search models')
  await search.fill('zeta')
  await expect(modelEditor.getByTestId('collection-entry')).toHaveCount(1)
  await expect(modelEditor.getByTestId('collection-group')).toHaveCount(0)
  await expect(modelEditor.getByText('alpha.safetensors', { exact: true })).toBeVisible()
  await search.fill('shared')
  await expect(modelEditor.getByTestId('collection-group')).toHaveCount(1)
  await expect(modelEditor.getByTestId('collection-entry')).toHaveCount(2)
  await search.fill('')
  await expect(modelEditor.getByTestId('collection-entry')).toHaveCount(3)

  const alpha = modelEditor.getByTestId('collection-entry').filter({ hasText: 'alpha.safetensors' })
  const shared = modelEditor.getByTestId('collection-group').filter({ hasText: 'shared.safetensors' })
  await expect(shared.getByTestId('collection-entry')).toHaveCount(2)
  await expect(shared.getByTestId('logical-model-conflict')).toHaveCount(0)
  await expect(modelEditor.getByTestId('asset-upload-trigger')).toBeDisabled()
  await expect(modelEditor).not.toContainText(/\bcompatible\b/i)

  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await alpha.click()
  await expect(alpha).toHaveClass(/selected/)
  await expect(alpha).toHaveAttribute('aria-selected', 'true')
  const selection = modelEditor.getByTestId('asset-selection-summary')
  await expect(selection).toContainText('alpha.safetensors')
  await selection.getByTestId('logical-model-variant-details').locator('summary').click()
  const providers = selection.locator('.logical-model-providers')
  await expect(providers).toHaveAttribute('aria-label', 'Providers')
  await expect(providers).toContainText('left')
  await expect(providers).toContainText('right')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.model!.values.model)).toBeNull()

  await page.getByTestId('logical-model-refresh').click()
  await expect(modelEditor.getByTestId('collection-entry')).toHaveCount(3)
  await expect(modelEditor.getByTestId('collection-group')).toHaveCount(1)

  await shared.getByTestId('collection-entry').nth(1).click()
  await page.getByTestId('asset-apply').click()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.model!.values.model)).toEqual({
    digest: C,
    name: 'shared.safetensors',
    size: 300,
    mediaType: 'application/x-safetensors',
    virtualPath: 'models/b/shared.safetensors',
  })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision + 1)

  await openWidget(page, 'media', 'image')
  const mediaEditor = page.getByTestId('asset-editor')
  await expect(mediaEditor.getByTestId('collection-panel')).toBeVisible()
  await expect(mediaEditor.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
  await expect(mediaEditor.getByTestId('asset-upload-trigger')).toBeEnabled()
  await expect(mediaEditor.getByRole('status')).toContainText('Uploads up to 256 MiB per file')
  await expect(mediaEditor.getByRole('option', { name: /photo\.png/ })).toBeVisible()
})
