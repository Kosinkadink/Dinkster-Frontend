/**
 * Control surfaces: mode panels in the rail. Covers create/undo,
 * binding the canvas selection, group bindings with invocation-time
 * membership capture, one-undo-step bulk applies, broken-binding display,
 * and the invariant that surface chrome never touches semantic state.
 */
import { expect, openRailPanel, selectProductOption, test, type Page } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a node's header center (assumes identity viewport). */
async function headerPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
const revision = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

const surfacesInDoc = async (page: Page) => (await activeDoc(page)).surfaces ?? {}
const nodeMode = async (page: Page, nodeId: string, graphId = 'g0') =>
  (await activeDoc(page)).graphs[graphId]?.nodes[nodeId]?.mode

const semanticGraphs = (page: Page) =>
  page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc.graphs))

/** Add a mode panel through the rail and return its surface id. */
async function addPanel(page: Page): Promise<string> {
  await openRailPanel(page, 'Control surfaces')
  await page.getByTestId('surface-add').click()
  const surfaces = await surfacesInDoc(page)
  const ids = Object.keys(surfaces)
  expect(ids.length).toBeGreaterThan(0)
  return ids[ids.length - 1]!
}

/** Select node(s) on canvas and bind them to the panel. */
async function bindNode(page: Page, surfaceId: string, nodeId: string): Promise<void> {
  await page.mouse.click(...xy(await headerPoint(page, nodeId)))
  await page.getByTestId(`surface-bind-selection-${surfaceId}`).click()
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  // Control surfaces are disabled by default pending rework (rework-queue.md).
  await page.addInitScript(() => localStorage.setItem('dinkster.settings', JSON.stringify({ v: 1, values: { 'features.controlSurfaces.enabled': true } })))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await identityViewport(page)
})

test('mounted Control Surfaces chrome localizes without changing raw data or panel state', async ({ page, request }) => {
  let backendRequests = 0
  page.on('request', (sent) => {
    const path = new URL(sent.url()).pathname
    if (path === '/object_info' || path === '/system_stats' || path.startsWith('/api/')) backendRequests += 1
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  const id = await addPanel(page)
  await bindNode(page, id, 'n0')
  const panel = page.getByTestId('surface-panel')
  const surface = page.getByTestId(`surface-${id}`)
  const binding = page.getByTestId(`surface-binding-${id}-0`)
  const groupSelect = page.getByTestId(`surface-bind-group-${id}`)
  await panel.evaluate((element) => { element.dataset['localeIdentity'] = 'panel' })
  await surface.evaluate((element) => { element.dataset['localeIdentity'] = 'surface' })
  await binding.evaluate((element) => { element.dataset['localeIdentity'] = 'binding' })
  await page.screenshot({ path: evidencePath('issue-457', 'control-surfaces-i18n-en.png'), fullPage: true })
  await groupSelect.focus()
  await groupSelect.click()
  const listbox = page.getByRole('listbox', { name: 'Bind group to surface' })
  await expect(listbox).toBeVisible()
  await listbox.evaluate((element) => { element.dataset['localeIdentity'] = 'listbox' })
  await expect(groupSelect).toBeFocused()
  const revisionBeforeLocale = await revision(page)
  const requestsBeforeLocale = backendRequests

  const localeModule = await (await request.get('/src/locale.ts')).text()
  const i18nModule = localeModule.match(/from "([^"]*packages\/core\/src\/index\.ts)"/)?.[1]
  expect(i18nModule).toBeDefined()
  await page.evaluate(async ({ i18nModule }) => {
    const { registerCatalog, setLocale } = await import(i18nModule)
    registerCatalog('de-DE', {
      'controlSurfaces.action.addModePanel': '[MODUSFELD HINZUFUGEN MIT LANGEM TEXT]',
      'controlSurfaces.action.bindGroup': '[GRUPPE AN OBERFLACHE BINDEN]',
      'controlSurfaces.action.bindSelection': '[AUSWAHL BINDEN]',
      'controlSurfaces.action.deleteSurface': '[OBERFLACHE LOSCHEN]',
      'controlSurfaces.action.removeBinding': '[BINDUNG ENTFERNEN]',
      'controlSurfaces.binding.empty': '[KEINE BINDUNGEN]',
      'controlSurfaces.binding.group': '[GRUPPE: {title}]',
      'controlSurfaces.binding.unknown': '[UNBEKANNTE BINDUNG]',
      'controlSurfaces.config.invalid': '[KONFIGURATION UNGULTIG]',
      'controlSurfaces.config.unknownType': '[UNBEKANNTER OBERFLACHENTYP {type}]',
      'controlSurfaces.empty': '[KEINE OBERFLACHEN]',
      'controlSurfaces.mode.active': '[AKTIV]',
      'controlSurfaces.mode.bypass': '[UMGEHEN]',
      'controlSurfaces.mode.mute': '[STUMM]',
      'controlSurfaces.placeholder.bindGroup': '[GRUPPE BINDEN...]',
      'controlSurfaces.title': '[STEUEROBERFLACHEN]',
      'Mode Panel': '[NICHT UBERSETZEN]',
    })
    setLocale('de-DE')
  }, { i18nModule: new URL(i18nModule!, page.url()).href })

  await expect(page.locator('[data-locale-identity="panel"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="surface"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="binding"]')).toHaveCount(1)
  await expect(page.locator('[data-locale-identity="listbox"]')).toHaveCount(1)
  await expect(panel.locator('h2')).toHaveText('[STEUEROBERFLACHEN]')
  await expect(page.getByTestId('surface-add')).toHaveText('[MODUSFELD HINZUFUGEN MIT LANGEM TEXT]')
  await expect(surface.locator('.surface-title')).toHaveText('Mode Panel')
  await expect(groupSelect).toHaveAttribute('aria-label', '[GRUPPE AN OBERFLACHE BINDEN]')
  await expect(groupSelect).toContainText('[GRUPPE BINDEN...]')
  await expect(page.getByTestId(`surface-apply-active-${id}`)).toHaveText('[AKTIV]')
  await expect(page.getByTestId(`surface-apply-muted-${id}`)).toHaveText('[STUMM]')
  await expect(page.getByTestId(`surface-apply-bypassed-${id}`)).toHaveText('[UMGEHEN]')
  await expect(groupSelect).toBeFocused()
  expect(await revision(page)).toBe(revisionBeforeLocale)
  expect(backendRequests).toBe(requestsBeforeLocale)

  await page.keyboard.press('Escape')
  await page.screenshot({ path: evidencePath('issue-457', 'control-surfaces-i18n-de-DE.png'), fullPage: true })
  await page.getByTestId(`surface-apply-muted-${id}`).click()
  expect(await nodeMode(page, 'n0')).toBe('muted')
})

test('Add Mode Panel creates a serialized surface; undo removes it; semantics untouched', async ({ page }) => {
  const semanticBefore = await semanticGraphs(page)
  const id = await addPanel(page)
  const surfaces = await surfacesInDoc(page)
  expect(surfaces[id]).toMatchObject({ id, type: 'core.modePanel' })
  await expect(page.getByTestId(`surface-${id}`)).toBeVisible()
  expect(await semanticGraphs(page)).toBe(semanticBefore)

  await page.keyboard.press('Control+z')
  expect(Object.keys(await surfacesInDoc(page))).toHaveLength(0)
  await expect(page.getByTestId(`surface-${id}`)).not.toBeVisible()
})

test('bind selection + apply mute/bypass/active: bulk change, one undo step each', async ({ page }) => {
  const id = await addPanel(page)
  await bindNode(page, id, 'n0')
  await bindNode(page, id, 'n1')
  await expect(page.getByTestId(`surface-binding-${id}-0`)).toBeVisible()
  await expect(page.getByTestId(`surface-binding-${id}-1`)).toBeVisible()

  const before = await revision(page)
  await page.getByTestId(`surface-apply-muted-${id}`).click()
  expect(await nodeMode(page, 'n0')).toBe('muted')
  expect(await nodeMode(page, 'n1')).toBe('muted')
  expect(await revision(page)).toBe(before + 1) // ONE transaction for the bulk apply

  await page.getByTestId(`surface-apply-bypassed-${id}`).click()
  expect(await nodeMode(page, 'n0')).toBe('bypassed')

  await page.getByTestId(`surface-apply-active-${id}`).click()
  expect(await nodeMode(page, 'n0')).toBe('active')

  // Undo unwinds one bulk apply at a time.
  await page.keyboard.press('Control+z')
  expect(await nodeMode(page, 'n0')).toBe('bypassed')
  await page.keyboard.press('Control+z')
  expect(await nodeMode(page, 'n0')).toBe('muted')
  expect(await nodeMode(page, 'n1')).toBe('muted')
  await page.keyboard.press('Control+z')
  expect(await nodeMode(page, 'n0')).toBeUndefined()
})

test('group binding captures membership at invocation time, not at bind time', async ({ page }) => {
  // Group around n0 via the canvas menu.
  await page.mouse.click(...xy(await headerPoint(page, 'n0')))
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await page.locator('[data-item-id="core.node.groupSelection"]').click()
  const groups = await page.evaluate(
    () => window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs['g0']?.groups ?? {},
  )
  const groupId = Object.keys(groups)[0]!

  const id = await addPanel(page)
  const groupSelect = page.getByTestId(`surface-bind-group-${id}`)
  await selectProductOption(page, groupSelect, groupId, '')
  await expect(groupSelect).toHaveAttribute('data-selected-id', '')
  await expect(page.getByTestId(`surface-binding-${id}-0`)).toContainText('Group')
  // A bound group leaves the option list, so the binding cannot be duplicated.
  await groupSelect.click()
  const groupListbox = page.getByRole('listbox', { name: 'Bind group to surface' })
  await expect(groupListbox).toBeVisible()
  await expect(groupListbox.locator(`[role="option"][data-option-id="${groupId}"]`)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator(`[data-testid^="surface-binding-${id}-"]`)).toHaveCount(1)

  await page.getByTestId(`surface-apply-muted-${id}`).click()
  expect(await nodeMode(page, 'n0')).toBe('muted')
  expect(await nodeMode(page, 'n1')).toBeUndefined() // outside the rectangle

  // Drag n0 OUT of the group; the next apply must not touch it (membership
  // is geometric at invocation, and mode changes are never retroactive).
  const from = await headerPoint(page, 'n0')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 600, from.y + 300)
  await page.mouse.move(from.x + 620, from.y + 320)
  await page.mouse.up()
  await page.getByTestId(`surface-apply-bypassed-${id}`).click()
  expect(await nodeMode(page, 'n0')).toBe('muted') // untouched: no longer inside
})

test('broken bindings render struck-through and skip; intact bindings still apply', async ({ page }) => {
  const id = await addPanel(page)
  await bindNode(page, id, 'n0')
  await bindNode(page, id, 'n1')

  // Delete n0: its binding must show broken, and applies must still hit n1.
  await page.mouse.click(...xy(await headerPoint(page, 'n0')))
  await page.keyboard.press('Delete')
  await expect(page.getByTestId(`surface-binding-${id}-0`)).toHaveAttribute('data-status', 'missingNode')
  await expect(page.getByTestId(`surface-binding-${id}-1`)).toHaveAttribute('data-status', 'ok')

  await page.getByTestId(`surface-apply-muted-${id}`).click()
  expect(await nodeMode(page, 'n1')).toBe('muted')
})

test('unbind removes one binding; surface delete removes the panel', async ({ page }) => {
  const id = await addPanel(page)
  await bindNode(page, id, 'n0')
  await bindNode(page, id, 'n1')
  await page.getByTestId(`surface-unbind-${id}-0`).click()
  await expect(page.getByTestId(`surface-binding-${id}-1`)).not.toBeVisible()
  await expect(page.getByTestId(`surface-binding-${id}-0`)).toBeVisible()

  await page.getByTestId(`surface-remove-${id}`).click()
  expect(Object.keys(await surfacesInDoc(page))).toHaveLength(0)
})
