import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-f2-proof'

async function widgetPoint(page: Page, nodeId: string, inputId: string) {
  return page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId })
}

async function waitForWorkspacePromotion(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
}

test('proves product select semantics across the five replacement sites', async ({ page, request }) => {
  await mkdir(proofDir, { recursive: true })
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'audit-f2-proof', schemaWire: 21 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/mounts*', (route) => route.fulfill({ json: { mounts: [
    { id: 'output', mode: 'readwrite', state: 'ready' },
    { id: 'renders', mode: 'readwrite', state: 'ready' },
  ] } }))

  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.registerSchemas([{
      type: 'SelectProof', displayName: 'Select Proof', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'choice', displayName: 'Choice', type: { kind: 'concrete', name: 'core.combo' }, optional: false,
        widget: { widgetType: 'COMBO', options: { options: [[1, 'One'], [7, 'Seven'], [12, 'Twelve']] }, default: 1 },
      }],
    }, {
      type: 'SaveProof', displayName: 'Save Proof', category: 'proof', source: 'v3', isOutputNode: true,
      items: [{
        kind: 'input', id: 'target', displayName: 'Target', type: { kind: 'concrete', name: 'dinkster.save_target' }, optional: true,
        widget: { widgetType: 'SAVE_TARGET', options: { suffix: '.png' }, default: { mount: 'output', prefix: 'proof' } },
      }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'select-proof\u0000', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { n0: { id: 'n0', type: 'SelectProof', values: { choice: 99 } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 160, y: 120 } } } } } },
      ext: { 'dinkster.exposed': [{ graphId: 'g0', nodeId: 'n0', inputId: 'choice' }] },
    }, 'Select Proof')
    app.setTabEditorKind(app.activeTab()!.id, 'app')
  })
  await waitForWorkspacePromotion(page)

  const combo = page.getByTestId('app-view-combo')
  await expect(page.getByRole('combobox', { name: 'Choice' })).toBeVisible()
  await expect(combo).toHaveText(/99/)
  await combo.click()
  await expect(page.getByRole('option', { name: '99' })).toHaveAttribute('aria-disabled', 'true')
  const beforeEscape = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await combo.press('Escape')
  await expect(combo).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeEscape)
  await combo.press('s')
  await combo.press('Enter')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.choice)).toBe(7)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeEscape + 1)
  await expect(combo).toBeFocused()
  await combo.click()
  await page.getByRole('option', { name: 'Twelve' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.values.choice)).toBe(12)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeEscape + 2)
  await expect(combo).toBeFocused()
  await page.screenshot({ path: `${proofDir}/01-app-view-typed-oov-keyboard.png`, animations: 'disabled' })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.setTabEditorKind(app.activeTab()!.id, 'graph')
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'save-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { save: { id: 'save', type: 'SaveProof', values: { target: { mount: 'legacy', prefix: 'old' } } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { save: { position: { x: 180, y: 160 } } } } } },
    }, 'Save Proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await waitForWorkspacePromotion(page)
  const point = await widgetPoint(page, 'save', 'target')
  await page.mouse.click(point.x, point.y)
  const mount = page.getByTestId('save-target-mount')
  await expect(mount).toHaveText(/legacy \(unavailable\)/)
  const beforeMount = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await mount.click()
  await mount.press('Escape')
  await expect(mount).toBeFocused()
  await expect(page.getByTestId('save-target-editor')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeMount)
  await mount.click()
  await page.getByRole('option', { name: 'renders' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeMount)
  await page.getByTestId('save-target-save').click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.save!.values.target)).toEqual({ mount: 'renders', prefix: 'old' })
  await page.screenshot({ path: `${proofDir}/02-save-target-staged-unavailable.png`, animations: 'disabled' })

  await page.evaluate(() => {
    ;(window.__dinksterTest!.app as any).settings.register({
      id: 'proof.quality', name: 'Proof quality', category: 'proof', type: 'combo', defaultValue: 'balanced',
      options: [{ value: 'balanced', label: 'Balanced' }, { value: 'quality', label: 'Quality' }],
    })
  })
  await page.getByTestId('settings-button').click()
  const proofCategory = page.locator('.settings-categories button', { hasText: 'proof' })
  await proofCategory.click()
  const setting = page.locator('[data-setting-id="proof.quality"] [role="combobox"]')
  await setting.click()
  await page.getByRole('option', { name: 'Quality' }).click()
  expect(await page.evaluate(() => (window.__dinksterTest!.app as any).settings.get('proof.quality'))).toBe('quality')
  await expect(setting).toBeFocused()
  await page.screenshot({ path: `${proofDir}/03-settings-immediate-focus.png`, animations: 'disabled' })
  await page.getByTestId('modal-close').click()

  const mainModule = await (await request.get('/src/main.tsx')).text()
  const renderModule = mainModule.match(/from "([^"]*solid-js_web[^"]*)"/)?.[1]
  expect(renderModule).toBeDefined()
  await page.evaluate(async ({ renderModule }) => {
    const { render } = await import(renderModule)
    const collectionModule = '/src/CollectionPanel.tsx'
    const { CollectionPanel } = await import(collectionModule)
    const host = document.createElement('section')
    host.id = 'collection-proof-host'
    host.style.cssText = 'position:fixed;inset:80px 80px 40px;z-index:1000;background:#181818;padding:16px'
    document.body.append(host)
    const requests: unknown[] = []
    const source = (id: string) => ({
      id,
      label: id === 'one' ? 'Source one' : 'Source two',
      filters: [{ id: 'kind', label: 'Kind', options: () => [{ value: 'image', label: 'Image' }] }],
      page: async (request: unknown) => { requests.push(request); return { items: [] } },
    })
    const dispose = render(() => CollectionPanel({ sources: [source('one'), source('two')], variant: 'select', initialFilters: { kind: 'future-kind' } }), host)
    ;(window as any).__auditCollectionProof = { requests, dispose }
  }, { renderModule: new URL(renderModule!, page.url()).href })
  const source = page.locator('#collection-proof-host [data-testid="collection-source-select"]')
  const filter = page.locator('#collection-proof-host [data-testid="collection-filter-kind"]')
  await expect(filter).toHaveText(/future-kind/)
  await filter.click()
  await expect(page.getByRole('option', { name: 'future-kind' })).toHaveAttribute('aria-selected', 'true')
  await filter.press('Escape')
  const requestsBeforeSource = await page.evaluate(() => (window as any).__auditCollectionProof.requests.length)
  await source.press('ArrowDown')
  expect(await page.evaluate(() => (window as any).__auditCollectionProof.requests.length)).toBe(requestsBeforeSource)
  await source.press('Enter')
  await expect.poll(() => page.evaluate(() => (window as any).__auditCollectionProof.requests.length)).toBeGreaterThan(requestsBeforeSource)
  await page.screenshot({ path: `${proofDir}/04-collection-open-vocabulary.png`, animations: 'disabled' })

  const chrome = await page.locator('#collection-proof-host [role="combobox"]').evaluateAll((elements) => elements.map((element) => ({
    tag: element.tagName,
    appearance: getComputedStyle(element).appearance,
  })))
  expect(chrome).toEqual([
    { tag: 'BUTTON', appearance: 'auto' },
    { tag: 'BUTTON', appearance: 'auto' },
    { tag: 'INPUT', appearance: 'none' },
  ])
  await page.evaluate(() => {
    const proof = (window as any).__auditCollectionProof
    proof.dispose()
    document.getElementById('collection-proof-host')?.remove()
  })
})
