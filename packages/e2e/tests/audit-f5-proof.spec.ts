import { expect, openRailPanel, test, type Page } from './fixtures.js'

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-f5-proof', schemaWire: 1 },
  packs: {},
  nodes: {},
}

async function prepare(page: Page): Promise<void> {
  await page.route('/api/**', (route) => { throw new Error(`unexpected unmocked API request: ${route.request().url()}`) })
  await page.route('/api/settings', (route) => route.fulfill({ json: { categories: { granted: [], available: [] }, settings: {} } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/composition', (route) => route.fulfill({ json: { packs: {} } }))
  await page.route('/api/mounts', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
}

test('checkboxes and radios preserve keyboard, disabled, focus, and mutation boundaries', async ({ page, request }) => {
  await prepare(page)
  const revision = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

  await page.getByTestId('settings-button').click()
  await page.locator('.settings-categories').getByRole('button', { name: 'Canvas Grid' }).click()
  const setting = page.locator('[data-setting-id]', { hasText: 'Show dot grid' }).getByRole('checkbox')
  await page.keyboard.press('Tab')
  await setting.focus()
  await expect(setting).toBeFocused()
  await expect(setting).toHaveCSS('outline-style', 'solid')
  await setting.press('Enter')
  await expect(setting).toHaveAttribute('aria-checked', 'true')
  await setting.press('Space')
  await expect(setting).toHaveAttribute('aria-checked', 'false')
  await page.keyboard.press('Escape')

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    ;(app.extensions as any).policy = { deny: ['proof.blocked'] }
    app.extensions.register({
      id: 'proof.blocked', displayName: 'Blocked proof pack',
      contributions: [{ id: 'proof.blocked.setting', category: 'setting', label: 'Blocked setting' }],
    }, (api) => api.setting('proof.blocked.setting', {
      id: 'proof.blocked.setting', name: 'Blocked setting', type: 'boolean', defaultValue: false,
    }))
  })
  const pack = page.locator('[data-pack="proof.blocked"]')
  await expect(pack.getByTestId('extension-pack-toggle')).toBeDisabled()
  await expect(pack.getByTestId('extension-contribution-toggle')).toBeDisabled()
  await expect(pack.getByTestId('extension-pack-toggle')).toHaveAttribute('aria-checked', 'true')

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.importAssetResolution.set({
      matches: [{
        query: 'legacy.safetensors',
        candidates: [
          { digest: `blake3:${'a'.repeat(64)}`, name: 'Incomplete', confidence: 'path', held: true },
          { digest: `blake3:${'b'.repeat(64)}`, name: 'Complete', confidence: 'stem', held: true, size: 10, mediaType: 'application/octet-stream', virtualPath: 'models/complete.safetensors' },
          { digest: `blake3:${'b'.repeat(64)}`, name: 'Complete duplicate', confidence: 'stem', held: true, size: 10, mediaType: 'application/octet-stream', virtualPath: 'other/complete.safetensors' },
        ],
      }],
      reasons: { 'legacy.safetensors': 'weak-match' },
      accept: () => {},
      cancel: () => app.importAssetResolution.set(undefined),
    })
  })
  const group = page.getByTestId('import-asset-row').filter({ hasText: 'legacy.safetensors' })
  await expect(group).toHaveRole('radiogroup')
  await expect(group).toHaveAccessibleName('Original imported value legacy.safetensors')
  const unresolved = group.getByRole('radio', { name: 'Leave unresolved' })
  const incomplete = group.getByRole('radio', { name: /^Incomplete.*Incomplete asset metadata/ })
  const complete = group.getByRole('radio', { name: /^Complete(?! duplicate).*Different extension/ })
  await expect(unresolved).toHaveAttribute('aria-checked', 'true')
  await expect(incomplete).toHaveAccessibleName(/path match.*Local.*Incomplete asset metadata - cannot select/)
  await expect(complete).toHaveAccessibleName(/extension differs.*Local.*10 B.*Different extension - verify this is the right asset/)
  await expect(incomplete).toBeDisabled()
  await complete.focus()
  await complete.press('Enter')
  await expect(unresolved).toHaveAttribute('aria-checked', 'true')
  await unresolved.focus()
  await unresolved.press('ArrowRight')
  await expect(complete).toBeFocused()
  await expect(complete).toHaveAttribute('aria-checked', 'true')
  await expect(group.locator('[role="radio"][aria-checked="true"]')).toHaveCount(1)
  await complete.press('ArrowUp')
  await expect(unresolved).toBeFocused()
  await unresolved.press('ArrowDown')
  await expect(complete).toBeFocused()
  await complete.press('ArrowLeft')
  await expect(unresolved).toBeFocused()

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const current = app.importAssetResolution.get()!
    app.importAssetResolution.set({
      ...current,
      matches: current.matches.map((match: any) => ({ ...match, candidates: match.candidates.slice(0, 2) })),
    })
  })
  const dialog = page.getByTestId('import-asset-resolution-dialog')
  await dialog.screenshot({ path: '../../docs/evidence/issue-457/import-asset-resolution-i18n-en.png' })
  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'importAssetResolution.action.accept': '[Auswahl annehmen]',
      'importAssetResolution.action.skip': '[Uberspringen]',
      'importAssetResolution.ariaLabel': '[Importierte Workflow-Assets auflosen]',
      'importAssetResolution.availability.local': '[Lokal]',
      'importAssetResolution.confidence.path': '[Pfad stimmt]',
      'importAssetResolution.confidence.stem': '[Erweiterung weicht ab]',
      'importAssetResolution.eyebrow': '[Importierter Workflow]',
      'importAssetResolution.fact.digest': '[Hash]',
      'importAssetResolution.fact.mediaType': '[Medientyp]',
      'importAssetResolution.fact.notProvided': '[Nicht angegeben]',
      'importAssetResolution.fact.path': '[Pfad]',
      'importAssetResolution.intro': '[Wahle lokale Ersatzwerte. Anderungen gelten erst nach Annahme.]',
      'importAssetResolution.leaveUnresolved.detail': '[Originalen Importwert unverandert lassen.]',
      'importAssetResolution.leaveUnresolved.title': '[Nicht auflosen]',
      'importAssetResolution.notice': '[Reihenfolge und Vertrauen kommen vom Backend. Hash und Pfad vor Annahme prufen.]',
      'importAssetResolution.originalValue': '[Originaler Importwert]',
      'importAssetResolution.reason.weakMatch.detail': '[Nur eine schwache Dateinamenubereinstimmung ist verfugbar.]',
      'importAssetResolution.reason.weakMatch.heading': '[Schwache Ubereinstimmung prufen]',
      'importAssetResolution.selectionStatus': '[{selected, plural, one {# Ersatz} other {# Ersetzungen}} ausgewahlt; {unresolved, plural, one {# Name bleibt} other {# Namen bleiben}} unaufgelost.]',
      'importAssetResolution.summary.needsReview': '[Zu prufen]',
      'importAssetResolution.summary.selected': '[Ausgewahlt]',
      'importAssetResolution.summary.unresolved': '[Unaufgelost]',
      'importAssetResolution.title': '[Importierte Assets auflosen]',
      'importAssetResolution.warning.extension': '[Andere Erweiterung - Asset prufen.]',
      'importAssetResolution.warning.incomplete': '[Unvollstandige Asset-Metadaten - nicht auswahlbar.]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })
  await expect(dialog).toHaveAttribute('aria-label', '[Importierte Workflow-Assets auflosen]')
  await expect(dialog).toContainText('[Importierte Assets auflosen]')
  await expect(dialog).toContainText('[Schwache Ubereinstimmung prufen]')
  await expect(dialog).toContainText('[Pfad stimmt]')
  await expect(dialog).toContainText('[Erweiterung weicht ab]')
  await expect(dialog).toContainText('legacy.safetensors')
  await expect(dialog).toContainText(`blake3:${'b'.repeat(64)}`)
  await expect(dialog).toContainText('models/complete.safetensors')
  await expect(page.getByTestId('import-assets-selection-status')).toHaveText('[0 Ersetzungen ausgewahlt; 1 Name bleibt unaufgelost.]')
  await expect(page.getByTestId('import-assets-accept')).toHaveText('[Auswahl annehmen]')
  await dialog.screenshot({ path: '../../docs/evidence/issue-457/import-asset-resolution-i18n-de-DE.png' })
  await page.evaluate(async ({ i18nModule }) => {
    const { setLocale } = await import(i18nModule)
    setLocale('en')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })
  await expect(dialog).toContainText('Resolve imported assets')

  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revision)

  await page.keyboard.press('Escape')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const socket = (id: string) => ({ kind: 'input', id, type: { kind: 'concrete', name: 'IMAGE' }, optional: true })
    app.registerSchemas([{
      type: 'ToggleProof', displayName: 'Toggle proof', category: 'proof', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [socket('tag'), {
            kind: 'input', id: 'sub', type: { kind: 'wildcard' }, optional: false,
            dynamic: { kind: 'autogrow', template: [socket('x'), socket('y')], naming: { kind: 'prefix', prefix: 'sub', min: 0, max: 4 } },
          }],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
        },
      }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'toggle-proof', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: { occurrence: { id: 'occurrence', type: '#subgraph', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 },
        subgraph: {
          id: 'subgraph', name: 'subgraph', nodes: { node: { id: 'node', type: 'ToggleProof', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          boundary: { inputs: [{ id: 'items', binds: { kind: 'family', node: 'node', port: 'items' } }], outputs: [] },
        },
      },
      view: { graphs: { g0: { nodes: { occurrence: { position: { x: 120, y: 120 } } } }, subgraph: { nodes: { node: { position: { x: 120, y: 120 } } } } } },
    }, 'Toggle proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  const header = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === 'occurrence')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.dblclick(header.x, header.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await page.getByTestId('boundary-pin').click()
  await page.locator('[data-testid="slot-toggle"][data-slot-path="sub.x"]').click()
  const parent = page.locator('[data-testid="slot-toggle"][data-slot-path="sub"]')
  await expect(parent).toHaveAttribute('data-state', 'narrowed')
  await expect(parent).toHaveAttribute('aria-checked', 'mixed')
  const beforeEnter = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  await parent.focus()
  await parent.press('Enter')
  await expect(parent).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(beforeEnter + 1)
})
