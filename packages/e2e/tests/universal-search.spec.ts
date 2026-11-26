import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, setShellRegion, waitForWorkspaceReady, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_SEARCH_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

async function capture(page: Page, name: string): Promise<void> {
  if (proofDir === undefined) return
  await page.screenshot({ path: join(proofDir, `${name}.png`), animations: 'disabled' })
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
})

test('opens universal search and runs a command', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('topbar-search').click()
  const input = page.getByTestId('universal-search-input')
  await expect(input).toBeFocused()
  await input.fill('> Open settings')
  await page.locator('[data-group="core.commands"]').getByRole('option', { name: /Open settings/ }).click()
  await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible()
})

test('Ctrl+K opens from the canvas but remains suppressed while typing', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('graph-canvas').focus()
  await page.keyboard.press('Control+K')
  await expect(page.getByTestId('universal-search-input')).toBeFocused()
  await page.keyboard.press('Escape')

  await page.getByTestId('settings-button').click()
  const settingsSearch = page.getByRole('region', { name: 'Settings', exact: true }).getByRole('combobox', { name: 'Search settings', exact: true })
  await settingsSearch.focus()
  await page.keyboard.press('Control+K')
  await expect(page.getByTestId('universal-search-input')).toHaveCount(0)
})

test('node search ghost appears at the selection cursor with zero movement and Escape clears placement affordances', async ({ page }) => {
  await page.goto('/')
  // Placement needs the app bridge and node schemas; wait for readiness.
  await waitForWorkspaceReady(page)
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'KSampler', displayName: 'KSampler', category: 'sampling', source: 'e2e', isOutputNode: false, body: [],
  }]))
  const nodeCount = () => page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes).length)
  const ghost = () => page.evaluate(() => (window.__dinksterTest!.renderer!.getOverlay() as { placementGhost?: { x: number; y: number } }).placementGhost)
  const before = await nodeCount()
  const canvas = page.getByTestId('graph-canvas')

  // Selecting a result whose row sits over the canvas region shows the
  // ghost at that cursor position immediately: zero mouse movement and no
  // canvas click. Focus returns to the canvas the search opened over.
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ KSampler')
  await page.locator('[data-group="core.nodes"] [role="option"]', { hasText: 'KSampler' }).first().click()
  await expect(canvas).toHaveAttribute('data-placement-ghost', 'visible')
  await expect(page.getByTestId('placement-status')).toHaveCount(0)
  await expect(canvas).toBeFocused()
  expect(await ghost()).toBeDefined()
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.7)
  const firstGhost = await ghost()
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.6)
  const secondGhost = await ghost()
  expect(secondGhost?.x).not.toBe(firstGhost?.x)
  expect(secondGhost?.y).not.toBe(firstGhost?.y)
  await page.mouse.click(700, 600)
  await expect.poll(nodeCount).toBe(before + 1)
  await expect(canvas).not.toHaveAttribute('data-placement-ghost', 'visible')

  // Arming while the pointer rests outside the canvas (on the topbar search
  // trigger, activating with Enter) falls back to the textual status until
  // the pointer enters the canvas - no click required - and Escape cancels
  // without any prior canvas click.
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ KSampler')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('placement-status')).toHaveText('Placing KSampler - click the canvas to place, Esc to cancel')
  await expect(canvas).not.toHaveAttribute('data-placement-ghost', 'visible')
  await page.evaluate(() => (window.__dinksterTest!.app as unknown as { shell: { statusBarVisible: { set(value: boolean): void } } }).shell.statusBarVisible.set(false))
  await expect(page.getByTestId('status-bar')).toBeVisible()
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await expect(canvas).toHaveAttribute('data-placement-ghost', 'visible')
  await expect(page.getByTestId('placement-status')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('placement-status')).toHaveCount(0)
  await expect(canvas).not.toHaveAttribute('data-placement-ghost', 'visible')
  await page.mouse.click(760, 620)
  await expect.poll(nodeCount).toBe(before + 1)

  await page.evaluate(() => (window.__dinksterTest!.app as unknown as { shell: { statusBarVisible: { set(value: boolean): void } } }).shell.statusBarVisible.set(true))
  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('@ KSampler')
  await page.locator('[data-group="core.nodes"] [role="option"]', { hasText: 'KSampler' }).first().click()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      createWorkflow(): { id: string }
      activeTabId: { set(id: string): void }
    }
    const other = app.createWorkflow()
    app.activeTabId.set(other.id)
  })
  await expect(page.getByTestId('placement-status')).toHaveCount(0)
  await expect(canvas).not.toHaveAttribute('data-placement-ghost', 'visible')
})

test('search states, grouped overflow, and long results stay reachable and contained', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  await page.getByTestId('topbar-search').click()
  const input = page.getByTestId('universal-search-input')
  const dialog = page.locator('.search-dialog')
  const listbox = page.getByRole('listbox', { name: 'Search Dinkster' })
  await expect(input).toBeFocused()
  await capture(page, '01-after-zero-query-1600x950')

  await page.evaluate(() => {
    type ProofResult = {
      readonly id: string
      readonly title: string
      readonly detail?: string
      readonly score: number
      readonly action: {
        readonly kind: 'host'
        readonly action: 'settings.open'
        readonly params: { readonly category: string }
      }
    }
    type ProofProvider = {
      readonly id: string
      readonly label: string
      readonly prefix: string
      readonly priority: number
      readonly async?: boolean
      query(query: string): readonly ProofResult[] | Promise<readonly ProofResult[]>
    }
    const registry = (window.__dinksterTest!.app as unknown as {
      readonly searchRegistry: { register(provider: ProofProvider): () => void }
    }).searchRegistry
    const action = { kind: 'host' as const, action: 'settings.open' as const, params: { category: 'General' } }
    registry.register({
      id: 'visual.long', label: 'Long results', prefix: '?', priority: 200,
      query: (query) => query === 'none' ? [] : Array.from({ length: 12 }, (_, index) => ({
        id: `long-${index}`,
        title: `A deliberately long result name ${index + 1} that must wrap without colliding with its surrounding search surface`,
        detail: `Provider detail ${index + 1} / canonical.identity.${index + 1} / a long path that remains readable`,
        score: 12 - index,
        action,
      })),
    })
    registry.register({
      id: 'visual.secondary', label: 'Secondary actions', prefix: '?', priority: 190,
      query: (query) => query === 'none' ? [] : [{ id: 'secondary', title: 'Secondary grouped result', detail: 'Ctrl+Shift+P', score: 1, action }],
    })
    registry.register({
      id: 'visual.loading', label: 'Streaming provider', prefix: '%', priority: 200, async: true,
      query: () => new Promise(() => {}),
    })
    registry.register({
      id: 'visual.sync', label: 'Immediate results', prefix: '%', priority: 190,
      query: () => [{ id: 'immediate', title: 'Available while another provider loads', detail: 'Synchronous group', score: 1, action }],
    })
    registry.register({
      id: 'visual.failure', label: 'Unavailable extension', prefix: '!', priority: 200,
      query: () => { throw new Error('private provider failure') },
    })
  })

  await input.fill('? long')
  const long = page.locator('[data-group="visual.long"]')
  await expect(long.locator('[role="option"][data-kind="result"]')).toHaveCount(3)
  await expect(page.locator('[data-group="visual.secondary"]')).toBeVisible()
  const more = long.locator('[role="option"][data-kind="more"]')
  await expect(more).toHaveText(/9 more long results/)
  await input.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-activedescendant', await long.locator('[role="option"]').nth(1).getAttribute('id') ?? '')
  await capture(page, '02-after-populated-long-active-1600x950')

  for (let index = 0; index < 2; index += 1) await input.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-activedescendant', await more.getAttribute('id') ?? '')
  await input.press('Enter')
  await expect(more).toHaveCount(0)
  await expect(long.locator('[role="option"]')).toHaveCount(12)
  await expect(input).toBeFocused()
  for (let index = 0; index < 8; index += 1) await input.press('ArrowDown')
  const activeId = await input.getAttribute('aria-activedescendant')
  expect(activeId).not.toBeNull()
  await expect(page.locator(`[id="${activeId}"]`)).toBeInViewport()
  await capture(page, '03-after-show-more-tail-1600x950')
  await input.press('Enter')
  const settings = page.getByRole('region', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await expect(input).toHaveCount(0)
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click()
  await expect(settings).toHaveCount(0)
  await page.getByTestId('topbar-search').click()
  await expect(input).toBeFocused()

  await input.fill('? none')
  await expect(page.locator('.dinkster-search-empty')).toContainText('No matches')
  await capture(page, '04-after-no-matches-1600x950')

  await input.fill('% wait')
  await expect(page.locator('[data-group="visual.loading"] .dinkster-search-note')).toHaveText('Searching streaming provider')
  await expect(page.locator('[data-group="visual.sync"] [role="option"]')).toBeVisible()
  await capture(page, '05-after-streaming-loading-1600x950')

  await input.fill('! fail')
  await expect(page.locator('[data-group="visual.failure"] .dinkster-search-note')).toHaveText('Unavailable extension could not be searched.')
  await expect(listbox).not.toContainText('private provider failure')
  await capture(page, '06-after-provider-failure-1600x950')

  for (const viewport of [
    { name: '07-after-populated-long-1366x768', width: 1366, height: 768 },
    { name: '08-after-populated-long-360x640', width: 360, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    await input.fill('? long')
    await expect(long).toBeVisible()
    if (viewport.width === 360) {
      await long.locator('[role="option"][data-kind="more"]').click()
      for (let index = 0; index < 11; index += 1) await input.press('ArrowDown')
      const narrowActiveId = await input.getAttribute('aria-activedescendant')
      expect(narrowActiveId).not.toBeNull()
      await expect(page.locator(`[id="${narrowActiveId}"]`)).toBeInViewport()
    }
    const box = await dialog.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.y).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    await capture(page, viewport.name)
  }
})

test('manifest-gated extension providers are kinds of their own, show no preview, act, and tear down live', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  await expect(page.getByTestId('topbar-search')).toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.backends.get()[0]?.schemaState.get().status,
  )).toBe('ready')
  expect(await page.evaluate(() => window.__dinksterTest!.app.extensions.register({
    id: 'demo', displayName: 'Demo search pack', contributions: [
      { id: 'demo.search.workflows', category: 'searchProvider' },
      { id: 'demo.search.actions', category: 'searchProvider' },
    ],
  }, (api) => {
    api.searchProvider('demo.search.workflows', {
      id: 'demo.search.workflows', label: 'Demo workflows', prefix: '?', priority: 300,
      query: () => [{
        id: 'inspect-workflow',
        title: 'Inspect a deliberately long extension workflow result without contributing markup or styles',
        detail: 'demo.pack / workflow.inspect / typed action descriptor',
        score: 2,
        action: { kind: 'host', action: 'settings.open', params: { category: 'General' } },
        preview: { version: 1, title: 'Workflow inspection', description: 'Extension preview data the search host does not draw beside non-node rows.' },
      }],
    })
    api.searchProvider('demo.search.actions', {
      id: 'demo.search.actions', label: 'Demo actions', prefix: '?', priority: 200,
      query: () => [{
        id: 'secondary', title: 'Secondary extension action', detail: 'Lower-priority provider group', score: 1,
        action: { kind: 'host', action: 'settings.open', params: { category: 'General' } },
      }],
    })
  }))).toEqual([])
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()?.store.doc))
  await page.getByTestId('topbar-search').click()
  const input = page.getByTestId('universal-search-input')
  await input.fill('? extension')
  await expect(input).toBeFocused()
  await expect(page.locator('.dinkster-search-group-heading > span:first-child')).toHaveText(['Demo workflows', 'Demo actions'])
  await expect(page.getByRole('tab', { name: /Demo workflows/ })).toBeVisible()
  await expect(page.getByTestId('search-preview')).toHaveCount(0)
  await input.press('Tab')
  await expect(page.getByRole('tab', { name: /Demo workflows/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('[data-group="demo.search.actions"]')).toHaveCount(0)
  await input.press('Shift+Tab')
  await expect(input).toBeFocused()

  for (const viewport of [
    { name: '09-extension-provider-1600x950', width: 1600, height: 950 },
    { name: '10-extension-provider-360x640', width: 360, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    const dialogBox = (await page.locator('.search-dialog').boundingBox())!
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(viewport.width)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    await expect(page.locator('[data-group="demo.search.actions"] [role="option"]')).toBeVisible()
    await capture(page, viewport.name)
  }

  await page.evaluate(() => window.__dinksterTest!.app.extensions.setContributionEnabled('demo.search.workflows', false))
  await expect(page.locator('[data-group="demo.search.workflows"]')).toHaveCount(0)
  await expect(page.locator('[data-group="demo.search.actions"]')).toBeVisible()
  await page.evaluate(() => {
    const extensions = window.__dinksterTest!.app.extensions
    extensions.setContributionEnabled('demo.search.workflows', true)
    extensions.setContributionEnabled('demo.search.actions', false)
  })
  await expect(page.locator('[data-group="demo.search.workflows"]')).toBeVisible()
  await expect(page.locator('[data-group="demo.search.actions"]')).toHaveCount(0)
  await page.locator('[data-group="demo.search.workflows"] [aria-selected="true"]').click()
  for (const region of ['left', 'right', 'bottom'] as const) await setShellRegion(page, region, false)
  await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click()
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()?.store.doc))).toBe(documentBefore)
})

test('Search Dinkster keeps the node title center under the placement click at every canvas zoom', async ({ page }) => {
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'auditSearchPlacementTest', displayName: 'audit Search Node', category: 'test', source: 'v3', isOutputNode: false,
      body: [],
    }])
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-search-placement', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
      view: { graphs: { g0: { nodes: {} } } },
    }, 'audit Search Placement')
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'audit-search-placement'
  })).toBe(true)
  const canvas = page.getByTestId('graph-canvas')
  const box = (await canvas.boundingBox())!
  const target = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.65 }

  for (const scale of [0.5, 1, 2]) {
    await page.evaluate((scale) => window.__dinksterTest!.renderer!.setViewport({ x: 45, y: -30, scale }), scale)
    const before = await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes))
    await page.getByTestId('topbar-search').click()
    await page.getByTestId('universal-search-input').fill('@ audit Search Node')
    await page.locator('[data-group="core.nodes"] [role="option"]', { hasText: 'audit Search Node' }).click()
    expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes))).toEqual(before)

    await page.mouse.move(target.x, target.y)
    const ghost = await page.evaluate(() => (window.__dinksterTest!.renderer!.getOverlay() as {
      placementGhost: { x: number; y: number; width: number; height: number }
    }).placementGhost)
    await page.mouse.click(target.x, target.y)
    await expect.poll(() => page.evaluate((before) => {
      const renderer = window.__dinksterTest!.renderer!
      return renderer.getScene().nodes.find((node) => !before.includes(node.id))
    }, before)).not.toBeUndefined()
    const proof = await page.evaluate((before) => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((candidate) => !before.includes(candidate.id))!
      const viewport = renderer.getViewport()
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return {
        x: node.x,
        y: node.y,
        width: node.layout.width,
        headerHeight: node.layout.headerHeight,
        titleCenterCss: {
          x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
          y: rect.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
        },
      }
    }, before)
    expect(proof.x).toBe(Math.round(ghost.x))
    expect(proof.y).toBe(Math.round(ghost.y))
    expect(proof.width).toBe(ghost.width)
    expect(Math.abs(proof.titleCenterCss.x - target.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(proof.titleCenterCss.y - target.y)).toBeLessThanOrEqual(1)
  }
})
