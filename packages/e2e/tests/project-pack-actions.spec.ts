import { createHash } from 'node:crypto'
import { expect, nativeTest as test, openRailPanel, selectProductOption } from './fixtures.js'

for (const entry of ['search', 'import'] as const) {
  for (const scope of ['every-project', 'only-project'] as const) {
    test(`${entry} pack action retains ${scope} consent and enables only the current project`, async ({ page }, info) => {
      let activated = false
      let extras: string[] = []
      let revision = 1
      let preparations = 0
      let applications = 0
      const source = 'a'.repeat(32)
      const environment = () => activated && scope === 'only-project' ? 'b'.repeat(32) : source
      const project = () => ({ id: 'default', uid: '48bb018e-5b17-4e68-bd81-c6412c4bcd72', name: 'Film',
        created: '2026-01-01T00:00:00Z', revision, deleted: false, packs: { extra: extras }, accountProject: null,
        environment: { id: environment(), lastSnapshot: null, lastRunAt: null } })
      const sibling = { ...project(), id: 'sibling', uid: '7b42c8d9-2f8b-4ce9-9d87-82fc78a31457', name: 'Sibling', packs: { extra: ['image-tools'] } }
      const wire = { schemaVersion: 1, displayName: 'Catalog Image', pack: 'image-tools', signature: 'image-v1', interface: [] }
      const body = JSON.stringify({ packName: 'image-tools', version: '1.2.0', schemas: [{ nodeType: 'image.catalog', schemaVersion: 1,
        schemaWireVersion: 1, schemaSignature: 'image-v1', schema: wire }] })
      await page.addInitScript(() => {
        Object.assign(window, { dinksterDesktop: { fileCapabilities: async () => ({ nativeFolderChoice: true, reveal: true }) } })
      })
      await page.route(/\/api\/(?!library\/retention(?:s\/|-clients(?:\?|$)))/, (route) => route.fulfill({ status: 404 }))
      await page.routeWebSocket('**/api/events?*', () => {})
      await page.route('/api/nodes*', (route) => route.fulfill({ json: { schemaVersion: 1, epoch: activated ? 2 : 1,
        packs: extras.length > 0 ? { 'image-tools': { displayName: 'Image Tools', version: '1.2.0' } } : {},
        nodes: extras.length > 0 ? { 'image.catalog': wire } : {},
      } }))
      await page.route('/api/environment', (route) => route.fulfill({ json: { environment: { id: environment(), snapshot: activated ? '2' : '1' } } }))
      await page.route('/api/projects?*', (route) => route.fulfill({ json: { items: [project(), sibling], cursor: null } }))
      await page.route('/api/projects/default', (route) => {
        if (route.request().method() === 'PATCH') {
          expect(activated).toBe(true)
          expect(route.request().postDataJSON()).toEqual({ revision: 2, patch: { packs: { extra: ['image-tools'] } } })
          extras = ['image-tools']
          revision++
        } else expect(route.request().method()).toBe('GET')
        return route.fulfill({ json: { project: project() } })
      })
      await page.route('/api/projects/default/needs', (route) => route.fulfill({ json: {
        packs: [], extra: extras, unknown: [], installed: activated ? [{ pack: 'image-tools', version: '1.2.0' }] : [],
      } }))
      await page.route('/api/projects/sibling/needs', (route) => route.fulfill({ json: {
        packs: [], extra: ['image-tools'], unknown: [], installed: [],
      } }))
      await page.route('/api/packs/install/prepare', (route) => {
        preparations++
        expect(route.request().postDataJSON()).toEqual({ packs: [{ pack: 'image-tools', version: '1.2.0' }], scope })
        return route.fulfill({ json: { preparation: 'retained', state: 'ready',
          progress: { sequence: 1, stage: 'retaining-review', completed: 1, total: 1 }, result: {
            confirmation: 'retained-token', plan: { format: 'dinkster.project-pack-plan/1',
              packChanges: [{ pack: 'image-tools', kind: 'added', sourceChanged: true, dependenciesChanged: false }] },
            review: 'Install Image Tools 1.2.0', expiresInSeconds: 900,
          } } })
      })
      await page.route('/api/packs/install/apply', (route) => {
        expect(route.request().postDataJSON()).toEqual({ confirmation: 'retained-token' })
        applications++
        activated = true
        revision = 2
        return route.fulfill({ json: { generation: 2, activation: { generation: 2, epoch: 2,
          added: ['image-tools'], removed: [], reloaded: [], unchanged: [], failed: {}, rolledBack: false } } })
      })
      await page.route('https://registry.dinkster.org/static/**', (route) => route.fulfill({
        contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' },
        body: route.request().url().endsWith('index.json') ? JSON.stringify({ schemaVersion: 1, items: [{
          name: 'image-tools', publisher: 'dinkster', version: '1.2.0', displayName: 'Image Tools', platforms: ['linux'],
          url: 'packs/image-tools/1.2.0/schemas.json', digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
        }] }) : body,
      }))
      await page.goto('/?dinksterProject=default')
      await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.connection.status.get())).toBe('connected')
      if (entry === 'search') {
        await page.getByTestId('topbar-search').click()
        await page.getByTestId('universal-search-input').fill('@ Catalog Image')
        await page.locator('[data-provider="core.nodes"] [data-testid="search-result-row"]').first().click()
        const preview = page.locator('[data-modal="node-install"]')
        await expect(preview).toBeVisible()
        await page.screenshot({ path: info.outputPath('before-project-review.png') })
        await preview.getByRole('button', { name: 'Review installation', exact: true }).click()
        await expect(preview).toHaveCount(0)
      } else {
        await page.evaluate(async () => {
          const app = window.__dinksterTest!.app
          await app.openDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'saved-import', root: 'g0',
            graphs: { g0: { id: 'g0', name: 'Root', nodes: { n0: { id: 'n0', type: 'image.catalog', values: {},
              ext: { 'importer.comfyTranslation': { pack: 'image-tools', version: '1.2.0', sourceClass: 'LegacyImage' } } } },
            links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } }, view: { graphs: {} },
          }, 'Saved import')
        })
        const initial = page.getByTestId('project-needs')
        await expect(initial).toBeVisible()
        await initial.getByRole('button', { name: 'Close', exact: true }).click()
        await openRailPanel(page, 'Problems')
        const report = page.getByTestId('imported-packs-report')
        await expect(report).toContainText('LegacyImage')
        await page.screenshot({ path: info.outputPath('before-project-review.png') })
        await report.locator('[data-pack="image-tools"]').getByRole('button', { name: 'Review this pack', exact: true }).click()
      }
      const needs = page.getByTestId('project-needs')
      await expect(needs).toBeVisible()
      await expect(needs).toContainText('image-tools')
      expect(preparations).toBe(0)
      expect(applications).toBe(0)
      await expect(needs.getByRole('button', { name: 'Review installation', exact: true })).toBeDisabled()
      await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.backends.get()[0]!.registry.get()?.schemas.has('image.catalog') === false)).toBe(true)
      await page.screenshot({ path: info.outputPath('project-review-scope-required.png') })
      await selectProductOption(page, needs.getByRole('combobox'), scope)
      await needs.getByRole('button', { name: 'Review installation', exact: true }).click()
      await expect(needs).toContainText('Install Image Tools 1.2.0')
      if (scope === 'every-project') await expect(needs).toContainText('Sibling')
      else await expect(needs).not.toContainText('Sibling')
      await page.screenshot({ path: info.outputPath('retained-project-review.png') })
      await needs.getByRole('button', { name: 'Confirm installation', exact: true }).click()
      await expect(needs).toHaveCount(0)
      expect(preparations).toBe(1)
      expect(applications).toBe(1)
      expect(extras).toEqual(['image-tools'])
      expect(sibling.packs.extra).toEqual(['image-tools'])
      expect(sibling.revision).toBe(1)
      await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.backends.get()[0]!.registry.get()?.schemas.has('image.catalog'))).toBe(true)
      const facts = await page.evaluate(() => {
        const app = window.__dinksterTest!.app
        return { nodes: Object.values(app.activeTab()!.store.doc.graphs).flatMap((graph) => Object.values(graph.nodes)).map((node) => node.type),
          executions: app.store.executions.get().size }
      })
      expect(facts.nodes).toEqual(entry === 'search' ? [] : ['image.catalog'])
      expect(facts.executions).toBe(0)
      await page.screenshot({ path: info.outputPath('project-only-enabled.png') })
    })
  }
}
