import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, nativeTest as test, openRailPanel } from './fixtures.js'

test('reports missing packs and preserves edits as the active registry gains their nodes', async ({ page }) => {
  await page.route('/api/**', (route) => route.fulfill({ status: 503 }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 503 }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, nodes: {},
  } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)
  const opened = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get()[0]!
    // Ordinary import interfaces, not installed runtime or producer snapshots.
    backend.comfyTranslations.set([
      ['SaveImage', 'dinkster-image', 'dinkster.image.save_image'],
      ['KSampler', 'dinkster-sampling', 'dinkster.sampling.k_sampler'],
    ].map(([from, pack, type]) => ({
      pack: pack!, version: '0.0.1', schema: { type: type!, displayName: from!, items: [],
        source: 'v3' as const, category: 'import', isOutputNode: false },
      rule: { from: from!, cases: [{ to: type!, inputs: {}, outputs: {} }] },
    })))
    app.openDocument({ nodes: [
      { id: 1, type: 'SaveImage', pos: [20, 40] },
      { id: 2, type: 'SaveImage', pos: [20, 240] },
      { id: 3, type: 'KSampler', pos: [340, 40] },
      { id: 4, type: 'UnknownExample', pos: [340, 240], widgets_values: [81, 'keep me'] },
    ], links: [] }, 'Imported workflow', backend)
    const tab = app.activeTab()!
    app.setTabTarget(tab.id, backend.id)
    return Object.values(tab.store.doc.graphs.g0!.nodes).map((node) => node.type)
  })
  expect(opened).toEqual(['dinkster.image.save_image', 'dinkster.image.save_image', 'dinkster.sampling.k_sampler', 'UnknownExample'])
  await openRailPanel(page, 'Problems')
  const report = page.getByTestId('imported-packs-report')
  await expect(report.locator('[data-pack]')).toHaveCount(2)
  await expect(report.locator('[data-pack="dinkster-image"] li')).toHaveCount(2)
  await expect(report).toContainText('g0/n2')
  await expect(page.getByTestId('problems-panel')).toContainText('UnknownExample')
  const evidence = process.env['DINKSTER_IMPORT_PACK_EVIDENCE']
  if (evidence) mkdirSync(evidence, { recursive: true })
  const capture = async (name: string) => {
    if (evidence) await page.getByTestId('problems-panel').screenshot({ path: resolve(evidence, `${name}.png`) })
  }
  await capture('missing-packs')
  await page.setViewportSize({ width: 780, height: 900 })
  await expect(report.locator('[data-pack="dinkster-image"]')).toBeVisible()
  await capture('missing-packs-narrow')
  await page.setViewportSize({ width: 1440, height: 900 })
  const edited = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const result = tab.store.dispatch({ command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n4', title: 'Keep this edit' } })
    const backend = app.backends.get()[0]!
    const registry = backend.registry.get()!
    const schema = backend.comfyTranslations.get()[0]!.schema
    backend.registry.set({ ...registry, connection: backend.id as import('@dinkster/core').ConnectionId,
      hash: 'one-installed', schemas: new Map([[schema.type, schema]]), diagnostics: [],
      resolve: (type) => type === schema.type ? schema : undefined })
    return { ok: result.ok, document: JSON.stringify(tab.store.doc) }
  })
  expect(edited.ok).toBe(true)
  await expect(report.locator('[data-pack]')).toHaveCount(1)
  await expect(report.locator('[data-pack="dinkster-sampling"]')).toBeVisible()
  await capture('one-pack-resolved')
  const after = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get()[0]!
    const registry = backend.registry.get()!
    const schemas = new Map(backend.comfyTranslations.get().map((record) => [record.schema.type, record.schema]))
    backend.registry.set({ ...registry, connection: backend.id as import('@dinkster/core').ConnectionId,
      hash: 'all-installed', schemas, diagnostics: [], resolve: (type) => schemas.get(type) })
    return { document: JSON.stringify(app.activeTab()!.store.doc), canUndo: app.activeTab()!.store.canUndo }
  })
  expect(after.document).toBe(edited.document)
  expect(after.canUndo).toBe(true)
  await expect(report).toHaveCount(0)
  await expect(page.getByTestId('problems-panel')).toContainText('UnknownExample')
  await expect(page.getByTestId('problems-panel')).not.toContainText('dinkster.image.save_image')
  await expect(page.getByTestId('problems-panel')).not.toContainText('dinkster.sampling.k_sampler')
  await capture('all-packs-resolved')
})
