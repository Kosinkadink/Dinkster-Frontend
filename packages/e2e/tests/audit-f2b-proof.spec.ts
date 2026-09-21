import { expect, openRailPanel, test } from './fixtures.js'

const catalog = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'audit-f2b-proof', schemaWire: 1 },
  packs: {},
  nodes: {},
}

test.beforeEach(async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: catalog }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
})

test('live-tab backend target keeps keyboard, focus, per-tab, frozen, and removal contracts', async ({ page }) => {
  await page.route('http://second.test/api/nodes*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(catalog),
  }))
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  const firstTab = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.id)
  await page.evaluate(() => window.__dinksterTest!.app.addBackend('http://second.test', 'Second', true, 'dinkster'))

  const target = page.getByRole('combobox', { name: 'Backend this tab queues to' })
  await expect(target).toBeVisible()
  await target.focus()
  await target.press('Enter')
  await target.press('End')
  await target.press('Escape')
  await expect(target).toHaveAttribute('data-selected-id', 'local')
  await expect(target).toBeFocused()
  expect(await page.evaluate(() => window.__dinksterTest!.app.tabTargets.get().size)).toBe(0)

  await target.press('Enter')
  await target.press('End')
  await target.press('Enter')
  const secondId = await page.evaluate(() => window.__dinksterTest!.app.backends.get()[1]!.id)
  await expect(target).toHaveAttribute('data-selected-id', secondId)
  await expect(target).toBeFocused()
  expect(await page.evaluate((tabId) => window.__dinksterTest!.app.tabTargets.get().get(tabId), firstTab)).toBe(secondId)

  await page.getByTestId('new-tab').click()
  await expect(target).toHaveAttribute('data-selected-id', 'local')
  await page.locator(`.tab[data-tab-id="${firstTab}"] .tab-select`).click()
  await expect(target).toHaveAttribute('data-selected-id', secondId)

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const live = app.activeTab()!
    const frozen = {
      ...live,
      id: 'frozen:select-proof',
      execution: { connection: app.backends.get()[1]!.id, prompt: 'select-proof' },
    }
    app.tabs.update((tabs: readonly unknown[]) => [...tabs, frozen])
    app.activeTabId.set(frozen.id)
  })
  await expect(target).toHaveCount(0)

  await page.evaluate((tabId) => window.__dinksterTest!.app.activeTabId.set(tabId), firstTab)
  await expect(target).toHaveAttribute('data-selected-id', secondId)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    app.removeBackend(app.backends.get()[1]!.id, false)
  })
  await expect(target).toHaveCount(0)
  expect(await page.evaluate(() => window.__dinksterTest!.app.tabTargets.get().size)).toBe(0)
})

test('surface group action restores focus, escapes without commit, resets, and repeats', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('dinkster.settings', JSON.stringify({
    v: 1,
    values: { 'features.controlSurfaces.enabled': true },
  })))
  await page.goto('/')
  await expect(page.getByTestId('settings-button')).toBeVisible()
  const diagnostics = await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'select-proof',
    root: 'g0',
    graphs: {
      g0: {
        id: 'g0', name: 'root',
        nodes: {
          n0: { id: 'n0', type: 'proof.unknown', values: {} },
          n1: { id: 'n1', type: 'proof.unknown', values: {} },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
      },
    },
    view: { graphs: { g0: {
      nodes: { n0: { position: { x: 50, y: 50 } }, n1: { position: { x: 500, y: 500 } } },
      groups: { group: { id: 'group', title: 'Proof group', bounds: { x: 0, y: 0, width: 400, height: 400 } } },
    } } },
  } as never, 'Surface proof'))
  expect(diagnostics).toEqual([])
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store
  })
  await openRailPanel(page, 'Control surfaces')
  await page.getByTestId('surface-add').click()
  const surfaceId = await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.surfaces ?? {})[0]!)
  const control = page.getByRole('combobox', { name: 'Bind group to surface' })

  await control.focus()
  await control.press('Enter')
  await control.press('Escape')
  await expect(control).toBeFocused()
  await expect(control).toHaveAttribute('data-selected-id', '')
  await expect(page.locator(`[data-testid^="surface-binding-${surfaceId}-"]`)).toHaveCount(0)

  await control.press('Enter')
  await control.press('Enter')
  await expect(control).toBeFocused()
  await expect(control).toHaveAttribute('data-selected-id', '')
  await expect(page.locator(`[data-testid^="surface-binding-${surfaceId}-"]`)).toHaveCount(1)

  // A bound group leaves the option list, so the binding cannot be duplicated.
  await control.press('Enter')
  const listbox = page.getByRole('listbox', { name: 'Bind group to surface' })
  await expect(listbox).toBeVisible()
  await expect(listbox.locator('[role="option"][data-option-id="group"]')).toHaveCount(0)
  await control.press('Escape')
  await expect(control).toBeFocused()
  await expect(page.locator(`[data-testid^="surface-binding-${surfaceId}-"]`)).toHaveCount(1)

  // Removing the binding restores the group, and the reset control rebinds it.
  await page.getByTestId(`surface-unbind-${surfaceId}-0`).click()
  await expect(page.locator(`[data-testid^="surface-binding-${surfaceId}-"]`)).toHaveCount(0)
  await control.press('Enter')
  await control.press('Enter')
  await expect(control).toBeFocused()
  await expect(control).toHaveAttribute('data-selected-id', '')
  await expect(page.locator(`[data-testid^="surface-binding-${surfaceId}-"]`)).toHaveCount(1)

  await page.getByTestId(`surface-apply-muted-${surfaceId}`).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.mode)).toBe('muted')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n1!.mode)).toBeUndefined()
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'node.move', params: { graphId: 'g0', positions: { n0: { x: 600, y: 600 } } },
  }))
  await page.getByTestId(`surface-apply-bypassed-${surfaceId}`).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n0!.mode)).toBe('muted')
})
