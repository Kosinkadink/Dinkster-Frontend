import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const PROOF = '/tmp/assets-picker-facets-logical-model-proof'
const LOCAL = `blake3:${'a'.repeat(64)}`
const REMOTE = `blake3:${'b'.repeat(64)}`

async function installRoutes(page: Page, onCandidateRequest: () => void): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'proof', schemaWire: 22 }, nodes: {} } }))
  await page.route('**/api/mounts', (route) => route.fulfill({ json: { mounts: [
    { id: 'comfy-input', mode: 'read', state: 'ready', kind: 'media/image' },
    { id: 'comfy-output', mode: 'read', state: 'ready', kind: 'media/image' },
    { id: 'custom-library', mode: 'read', state: 'ready' },
    { id: 'models', mode: 'read', state: 'ready', kind: 'model/checkpoint' },
  ] } }))
  await page.route('**/api/mounts/*/entries?*', async (route) => {
    const mount = new URL(route.request().url()).pathname.match(/^\/api\/mounts\/([^/]+)\/entries$/)?.[1] ?? ''
    const rows: Record<string, object[]> = {
      'comfy-input': [{ digest: `blake3:${'1'.repeat(64)}`, name: 'imported.png', size: 11, mediaType: 'image/png', kind: 'media/image', virtualPath: 'input/imported.png' }],
      'comfy-output': [{ digest: `blake3:${'2'.repeat(64)}`, name: 'generated.png', size: 12, mediaType: 'image/png', kind: 'media/image', virtualPath: 'output/generated.png' }],
      'custom-library': [{ digest: `blake3:${'3'.repeat(64)}`, name: 'custom.png', size: 13, mediaType: 'image/png', kind: 'media/image', virtualPath: 'custom/custom.png' }],
      models: [{ digest: LOCAL, name: 'local.safetensors', size: 100, mediaType: 'application/x-safetensors', kind: 'model/checkpoint', virtualPath: 'models/local.safetensors' }],
    }
    await route.fulfill({ json: { entries: rows[mount] ?? [] } })
  })
  await page.route('**/api/assets/**', (route) => route.fulfill({ status: 404 }))
  await page.route('**/api/catalog/candidates', async (route) => {
    onCandidateRequest()
    expect((route.request().postDataJSON() as { context: unknown }).context).toEqual({
      assetKind: 'model/checkpoint',
      schema: { nodeType: 'PickerModel', inputId: 'model' },
      accept: ['application/x-safetensors'],
    })
    const common = {
      logicalId: 'proof/model', family: 'Proof model', assetKind: 'model/checkpoint', variantId: 'fp16',
      dtype: 'float16', quantization: 'none', format: 'safetensors', role: 'base',
      requirements: { loaders: [], runtimes: [], hardware: [] }, mediaType: 'application/x-safetensors',
      compatibility: { status: 'compatible', reason: '' },
    }
    await route.fulfill({ json: { contractVersion: 1, status: 'ambiguous', items: [
      { ...common, digest: LOCAL, size: 100, availability: { status: 'local', reason: '' }, assetRef: { digest: LOCAL, name: 'local.safetensors', size: 100, mediaType: 'application/x-safetensors', virtualPath: 'models/local.safetensors' }, providerSources: [{ source: { providerId: 'proof', sourceId: 'local' }, status: 'available', reason: '', requires: {} }] },
      { ...common, digest: REMOTE, size: 200, availability: { status: 'downloadable', reason: 'remote' }, providerSources: [{ source: { providerId: 'proof', sourceId: 'remote' }, status: 'available', reason: '', requires: {} }] },
    ] } })
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

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
  test(`model candidate source and media facets at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const pageErrors: string[] = []
    let candidateRequests = 0
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await mkdir(PROOF, { recursive: true })
    await page.setViewportSize(viewport)
    await installRoutes(page, () => { candidateRequests += 1 })
    await page.goto('/')
    await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
    await page.evaluate(() => {
      window.__dinksterTest!.app.registerSchemas([
        { type: 'PickerModel', displayName: 'Picker model', category: 'proof', source: 'v3', isOutputNode: false, items: [{ kind: 'input', id: 'model', type: { kind: 'concrete', name: 'ASSET' }, optional: false, widget: { widgetType: 'ASSET', kind: 'model/checkpoint', options: { accept: ['application/x-safetensors'] }, default: null } }] },
        { type: 'PickerMedia', displayName: 'Picker media', category: 'proof', source: 'v3', isOutputNode: false, items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false, widget: { widgetType: 'ASSET', kind: 'media/image', options: { accept: ['image/png'] }, default: null } }] },
      ])
      window.__dinksterTest!.app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'picker-proof', root: 'g0', graphs: { g0: { id: 'g0', name: 'root', nodes: { model: { id: 'model', type: 'PickerModel', values: { model: null } }, media: { id: 'media', type: 'PickerMedia', values: { image: null } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 3 } }, view: { graphs: { g0: { nodes: { model: { position: { x: 100, y: 100 } }, media: { position: { x: 500, y: 100 } } } } } } }, 'Picker proof')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    })
    await openWidget(page, 'model', 'model')
    const modelEditor = page.getByTestId('asset-editor')
    await expect(modelEditor.getByTestId('collection-panel')).toBeVisible()
    await expect(modelEditor.getByTestId('collection-items')).toHaveAttribute('data-mode', 'list')
    await expect(modelEditor.getByTestId('collection-search')).toBeVisible()
    await expect(modelEditor.getByTestId('collection-group')).toHaveCount(candidateRequests > 0 ? 1 : 0)
    await expect(modelEditor.getByTestId('collection-entry')).toHaveCount(candidateRequests > 0 ? 2 : 1)
    if (candidateRequests > 0) await expect(modelEditor.getByText('downloadable')).toBeVisible()
    else await expect(modelEditor.getByText('downloadable')).toHaveCount(0)
    await expect(modelEditor.getByTestId('asset-upload-trigger')).toBeDisabled()
    await expect(modelEditor).not.toContainText(/\bcompatible\b/i)
    await expect(page.getByText('Auto', { exact: true })).toHaveCount(0)
    const localModel = modelEditor.getByTestId('collection-entry').filter({ hasText: 'local.safetensors' })
    await localModel.click()
    await expect(localModel).toHaveClass(/selected/)
    await modelEditor.getByTestId('logical-model-variant-details').locator('summary').click()
    await page.screenshot({ path: `${PROOF}/logical-${viewport.width}x${viewport.height}.png`, fullPage: true })
    await page.reload()
    await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
    await page.evaluate(() => {
      window.__dinksterTest!.app.registerSchemas([{ type: 'PickerMedia', displayName: 'Picker media', category: 'proof', source: 'v3', isOutputNode: false, items: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'ASSET' }, optional: false, widget: { widgetType: 'ASSET', kind: 'media/image', options: { accept: ['image/png'] }, default: null } }] }])
      window.__dinksterTest!.app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'media-picker-proof', root: 'g0', graphs: { g0: { id: 'g0', name: 'root', nodes: { media: { id: 'media', type: 'PickerMedia', values: { image: null } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } }, view: { graphs: { g0: { nodes: { media: { position: { x: 100, y: 100 } } } } } } }, 'Media picker proof')
      window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    })
    await openWidget(page, 'media', 'image')
    const mediaEditor = page.getByTestId('asset-editor')
    await expect(mediaEditor.getByTestId('collection-items')).toHaveAttribute('data-mode', 'grid')
    await expect(mediaEditor.getByTestId('asset-upload-trigger')).toBeEnabled()
    await expect(mediaEditor.getByTestId('collection-entry')).toHaveCount(3)
    await expect(mediaEditor.getByText('custom.png', { exact: true })).toBeVisible()
    await mediaEditor.getByTestId('collection-source-select').click()
    await expect(page.getByRole('option', { name: 'Imported', exact: true })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Generated', exact: true })).toBeVisible()
    await page.getByRole('option', { name: 'Imported', exact: true }).click()
    await expect(mediaEditor.getByTestId('collection-entry')).toHaveCount(1)
    await expect(mediaEditor.getByText('imported.png', { exact: true })).toBeVisible()
    await expect(mediaEditor.getByText('custom.png', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: `${PROOF}/media-imported-${viewport.width}x${viewport.height}.png`, fullPage: true })
    await mediaEditor.getByTestId('collection-source-select').click()
    await page.getByRole('option', { name: 'Generated', exact: true }).click()
    await expect(mediaEditor.getByTestId('collection-entry')).toHaveCount(1)
    await expect(mediaEditor.getByText('generated.png', { exact: true })).toBeVisible()
    await expect(mediaEditor.getByText('imported.png', { exact: true })).toHaveCount(0)
    await expect(mediaEditor.getByText('custom.png', { exact: true })).toHaveCount(0)
    await page.screenshot({ path: `${PROOF}/media-generated-${viewport.width}x${viewport.height}.png`, fullPage: true })
    expect(pageErrors).toEqual([])
  })
}
