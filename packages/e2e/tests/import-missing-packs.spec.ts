import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, nativeTest as test, openRailPanel } from './fixtures.js'

test('reports missing packs and preserves edits as the active registry gains their nodes', async ({ page }) => {
  let installed = false
  let applyCount = 0
  let refuse = true
  let releaseApply: (() => void) | undefined
  const plans: unknown[] = []
  await page.route('/api/**', (route) => route.fulfill({ status: 503 }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 503 }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: installed ? 2 : 1, nodes: installed ? {
      'dinkster.image.save_image': { schemaVersion: 1, displayName: 'SaveImage', interface: [] },
    } : {},
  } }))
  await page.route('/api/comfy-translations', (route) => route.fulfill({ json: {
    schemaVersion: 1, items: [
      ['SaveImage', 'dinkster-image', 'dinkster.image.save_image'],
      ['KSampler', 'dinkster-sampling', 'dinkster.sampling.k_sampler'],
    ].map(([from, pack, type]) => ({ pack, version: '0.0.1',
      schema: { nodeType: type, schemaVersion: 1, displayName: from, interface: [] },
      rule: { from, cases: [{ to: type, inputs: {}, outputs: {} }] },
    })),
  } }))
  await page.route('/api/packs/install/plan', (route) => {
    plans.push(route.request().postDataJSON())
    return refuse ? route.fulfill({ status: 404, json: { detail: 'Pack installation is not enabled on this host.' } })
      : route.fulfill({ json: { confirmation: 'server-confirmation', plan: { format: 'dinkster.plan/1' },
        review: 'Install dinkster-image@0.0.1\nActivate a new generation on this backend.', expiresInSeconds: 900 } })
  })
  await page.route('/api/packs/install/apply', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ confirmation: 'server-confirmation' })
    applyCount++
    if (applyCount === 1) return route.fulfill({ status: 409, json: { detail: 'Plan expired. Review a new plan.' } })
    await new Promise<void>((resolve) => { releaseApply = resolve })
    installed = true
    return route.fulfill({ json: { generation: 2, activation: { generation: 2, epoch: 2,
      added: ['dinkster-image'], removed: [], reloaded: [], unchanged: [], failed: {}, rolledBack: false } } })
  })
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)
  await page.waitForFunction(() => window.__dinksterTest?.app.backends.get()[0]?.comfyTranslations.get().length === 2)
  const opened = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const backend = app.backends.get()[0]!
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
  const reviewImage = report.locator('[data-pack="dinkster-image"]').getByRole('button', { name: 'Review this pack' })
  await reviewImage.click()
  await expect(report).toContainText('Pack installation is not enabled on this host.')
  await capture('install-unavailable')
  expect(applyCount).toBe(0)
  refuse = false
  await reviewImage.click()
  await expect(report.getByTestId('pack-install-review')).toContainText('Install dinkster-image@0.0.1')
  await capture('install-review')
  await page.setViewportSize({ width: 780, height: 900 })
  await capture('install-review-narrow')
  await page.setViewportSize({ width: 1440, height: 900 })
  await report.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(report.getByTestId('pack-install-review')).toHaveCount(0)
  expect(applyCount).toBe(0)
  await reviewImage.click()
  await expect(report.getByRole('button', { name: 'Confirm installation' })).toBeVisible()
  const edited = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const result = tab.store.dispatch({ command: 'node.setTitle', params: { graphId: 'g0', nodeId: 'n4', title: 'Keep this edit' } })
    return { ok: result.ok, document: JSON.stringify(tab.store.doc) }
  })
  expect(edited.ok).toBe(true)
  await expect(report.getByRole('button', { name: 'Confirm installation' })).toHaveCount(0)
  expect(applyCount).toBe(0)
  await reviewImage.click()
  await report.getByRole('button', { name: 'Confirm installation' }).click()
  await expect(report).toContainText('Plan expired. Review a new plan.')
  expect(applyCount).toBe(1)
  await capture('install-apply-failed')
  await reviewImage.click()
  await report.getByRole('button', { name: 'Confirm installation' }).click()
  await expect(report).toContainText('Installing and activating packs...')
  await expect(reviewImage).toBeDisabled()
  await capture('install-applying')
  releaseApply!()
  await expect(report.locator('[data-pack]')).toHaveCount(1)
  expect(applyCount).toBe(2)
  expect(plans).toEqual(Array.from({ length: 5 }, () => ({ packs: [{ pack: 'dinkster-image', version: '0.0.1' }] })))
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(edited.document)
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
