import { expect, nativeAppViewTest as test, type Page } from './fixtures.js'

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-f7-proof', schemaWire: 1 },
  packs: {},
  nodes: {},
}

async function prepare(page: Page): Promise<void> {
  await page.route(/\/api\/(?!library\/retentions\/).*/, (route) => { throw new Error(`unexpected unmocked API request: ${route.request().url()}`) })
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.route('/api/settings', (route) => route.fulfill({ json: { categories: { granted: [], available: [] }, settings: {} } }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/composition', (route) => route.fulfill({ json: { packs: {} } }))
  await page.route('/api/mounts', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route('/api/docs?kind=guide&limit=1', (route) => route.fulfill({ json: { docs: [] } }))
  await page.route('/api/mounts/locations*', (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.has('digest')
    ? { locations: [] } : { mounts: [], activeMounts: [], importMount: null } }))
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
}

const tabClose = (page: Page, tabId: string) =>
  page.locator(`.tab[data-tab-id="${tabId}"]`).getByTestId('tab-close')

async function activeSnapshot(page: Page) {
  return page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return { id: tab.id, title: tab.title, revision: tab.store.revision, document: JSON.stringify(tab.store.doc) }
  })
}

test('product close confirmation preserves every decision boundary and keyboard path', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.markTabDirty(app.activeTab()!.id)
  })
  const dirty = await activeSnapshot(page)
  const close = tabClose(page, dirty.id)
  const dialogName = `Close "${dirty.title}" and discard unsaved changes?`
  const dirtyGeometry = await page.locator(`.tab[data-tab-id="${dirty.id}"]`).evaluate((tab) => {
    const affordance = tab.querySelector('.tab-affordance')!.getBoundingClientRect()
    const dot = tab.querySelector('.tab-dirty')!.getBoundingClientRect()
    return { affordanceCenter: affordance.left + affordance.width / 2, dotCenter: dot.left + dot.width / 2 }
  })
  expect(dirtyGeometry.dotCenter).toBe(dirtyGeometry.affordanceCenter)

  await close.focus()
  await close.press('Enter')
  const dialog = page.getByRole('dialog', { name: dialogName, exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.dock-title')).toHaveText(`Close "${dirty.title}"?`)
  await expect(dialog.locator('.close-tab-confirm > p')).toHaveText(`Close "${dirty.title}" and discard unsaved changes?`)
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true })
  const confirm = dialog.getByRole('button', { name: 'Close and discard', exact: true })
  await expect(cancel).toBeFocused()
  for (const button of [cancel, confirm]) {
    expect(await button.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(32)
  }
  await expect(cancel).toHaveCSS('outline-style', 'solid')
  await cancel.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.click()
  await expect(dialog).toBeVisible()
  await dialog.getByTestId('modal-close').click()
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.press('Enter')
  await expect(dialog).toBeVisible()
  await page.mouse.click(5, 5)
  await expect(dialog).toHaveCount(0)
  await expect(close).toBeFocused()
  expect(await activeSnapshot(page)).toEqual(dirty)

  await close.press('Enter')
  await expect(dialog).toBeVisible()
  await page.evaluate((id) => (window.__dinksterTest!.app as any).closeTab(id), dirty.id)
  await expect(dialog).toHaveCount(0)
  await expect(page.locator(`.tab[data-tab-id="${dirty.id}"]`)).toHaveCount(0)

  const confirmTarget = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.createWorkflow()
    const original = app.requestCloseTab.bind(app)
    ;(window as unknown as { __closeRequests?: number }).__closeRequests = 0
    app.requestCloseTab = (id: string, decide: () => boolean) => {
      ;(window as unknown as { __closeRequests?: number }).__closeRequests!++
      return original(id, decide)
    }
    return { id: tab.id, title: tab.title }
  })
  await page.waitForFunction((tabId) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === tabId)
    return tab !== undefined && 'status' in tab.store
  }, confirmTarget.id)
  const confirmClose = tabClose(page, confirmTarget.id)
  await confirmClose.focus()
  await confirmClose.press('Enter')
  const confirmDialog = page.getByRole('dialog', {
    name: `Close "${confirmTarget.title}" and discard unsaved changes?`, exact: true,
  })
  await expect(confirmDialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await page.keyboard.press('Enter')
  await expect(confirmDialog).toHaveCount(0)
  await expect(page.locator(`.tab[data-tab-id="${confirmTarget.id}"]`)).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __closeRequests?: number }).__closeRequests)).toBe(1)

  const cleanId = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const tab = app.createWorkflow()
    return tab.id
  })
  await page.waitForFunction((tabId) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === tabId)
    return tab !== undefined && 'status' in tab.store
  }, cleanId)
  await page.evaluate((tabId) => (window.__dinksterTest!.app as any).markTabClean(tabId), cleanId)
  await tabClose(page, cleanId).click()
  await expect(page.locator(`.tab[data-tab-id="${cleanId}"]`)).toHaveCount(0)
  await expect(page.locator('dialog[data-modal="close-tab"]')).toHaveCount(0)
})

test('a pending close decision does not transfer to a same-id replacement document', async ({ page }) => {
  await prepare(page)
  const workflow = (title: string) => ({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'replace-proof', root: 'g0',
    graphs: { g0: { id: 'g0', name: title, nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
    view: { graphs: { g0: { nodes: {} } } },
  })
  const first = await page.evaluate(async (doc) => {
    const app = window.__dinksterTest!.app as any
    await app.openDocument(doc, 'Replace proof')
    const tab = app.activeTab()!
    return { id: tab.id, title: tab.title }
  }, workflow('original'))
  await page.waitForFunction((tabId) => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === tabId)
    return tab !== undefined && 'status' in tab.store
  }, first.id)
  const close = tabClose(page, first.id)
  await close.focus()
  await close.press('Enter')
  const dialog = page.getByRole('dialog', { name: `Close "${first.title}" and discard unsaved changes?`, exact: true })
  await expect(dialog).toBeVisible()

  // An editor-kind switch replaces the Tab object but keeps the same
  // document session: the confirmation must survive it.
  await page.evaluate((tabId) => {
    ;(window.__dinksterTest!.app as any).setTabEditorKind(tabId, 'app')
  }, first.id)
  await expect(dialog).toBeVisible()

  await page.evaluate(async (doc) => {
    await window.__dinksterTest!.app.openDocument(doc, 'Replacement document')
  }, workflow('replacement'))
  await expect(page.locator('dialog[data-modal="close-tab"]')).toHaveCount(0)
  const survivor = page.locator(`.tab[data-tab-id="${first.id}"]`)
  await expect(survivor).toHaveCount(1)
  await expect(survivor).toContainText('Replacement document')
})
