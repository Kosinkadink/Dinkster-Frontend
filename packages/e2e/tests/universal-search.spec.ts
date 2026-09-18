import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures.js'

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
  await page.locator('[data-provider="core.commands"]').getByRole('option', { name: /Open settings/ }).click()
  await expect(page.getByTestId('modal-surface')).toHaveAttribute('data-modal', 'settings')
})

test('Ctrl+K opens from the canvas but remains suppressed while typing', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('graph-canvas').focus()
  await page.keyboard.press('Control+K')
  await expect(page.getByTestId('universal-search-input')).toBeFocused()
  await page.keyboard.press('Escape')

  await page.getByTestId('settings-button').click()
  const settingsSearch = page.locator('.settings-search')
  await settingsSearch.focus()
  await page.keyboard.press('Control+K')
  await expect(page.getByTestId('universal-search-input')).toHaveCount(0)
})

test('node search ghost appears at the selection cursor with zero movement and Escape clears placement affordances', async ({ page }) => {
  await page.goto('/')
  // Placement needs the app bridge and node schemas; wait for readiness.
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => window.__dinksterTest!.app.registerSchemas([{
    type: 'KSampler', displayName: 'KSampler', category: 'sampling', source: 'e2e', isOutputNode: false, items: [],
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
  await page.locator('[data-provider="core.nodes"] [data-testid="search-result-row"]', { hasText: 'KSampler' }).first().click()
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
  await page.locator('[data-provider="core.nodes"] [data-testid="search-result-row"]', { hasText: 'KSampler' }).first().click()
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
  const results = page.locator('.search-results')
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
  await expect(page.locator('[data-provider="visual.long"] [data-testid="search-result-row"]')).toHaveCount(5)
  await expect(page.locator('[data-provider="visual.secondary"]')).toBeVisible()
  const listbox = page.getByRole('listbox', { name: 'Search results' })
  expect(await listbox.ariaSnapshot()).toContain('option "Show 7 more"')
  await input.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-activedescendant', /option-1$/)
  await capture(page, '02-after-populated-long-active-1600x950')

  const showMore = page.locator('[data-provider="visual.long"] .search-show-more')
  for (let index = 0; index < 4; index += 1) await input.press('ArrowDown')
  await expect(input).toHaveAttribute('aria-activedescendant', await showMore.getAttribute('id') ?? '')
  await input.press('Enter')
  await expect(showMore).toHaveCount(0)
  await expect(input).toBeFocused()
  for (let index = 0; index < 10; index += 1) await input.press('ArrowDown')
  const activeId = await input.getAttribute('aria-activedescendant')
  expect(activeId).not.toBeNull()
  await expect(page.locator(`#${activeId}`)).toBeInViewport()
  await expect(results).toBeVisible()
  await capture(page, '03-after-show-more-tail-1600x950')
  await input.press('Enter')
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings).toBeVisible()
  await expect(input).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await page.getByTestId('topbar-search').click()
  await expect(input).toBeFocused()

  await input.fill('? none')
  await expect(page.locator('[data-search-state="empty"]')).toContainText('No matches')
  expect(await listbox.ariaSnapshot()).not.toContain('No matches')
  await capture(page, '04-after-no-matches-1600x950')

  await input.fill('% wait')
  await expect(page.locator('[data-provider="visual.loading"] [data-search-state="loading"]')).toBeVisible()
  await expect(page.locator('[data-provider="visual.sync"] [data-testid="search-result-row"]')).toBeVisible()
  expect(await listbox.ariaSnapshot()).not.toContain('Searching Streaming provider')
  await capture(page, '05-after-streaming-loading-1600x950')

  await input.fill('! fail')
  await expect(page.locator('[data-provider="visual.failure"] [data-search-state="error"]')).toContainText('Provider unavailable')
  expect(await listbox.ariaSnapshot()).not.toContain('Provider unavailable')
  await capture(page, '06-after-provider-failure-1600x950')

  for (const viewport of [
    { name: '07-after-populated-long-1366x768', width: 1366, height: 768 },
    { name: '08-after-populated-long-360x640', width: 360, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    await input.fill('? long')
    await expect(page.locator('[data-provider="visual.long"]')).toBeVisible()
    if (viewport.width === 360) {
      await page.locator('[data-provider="visual.long"] .search-show-more').click()
      for (let index = 0; index < 11; index += 1) await input.press('ArrowDown')
      const narrowActiveId = await input.getAttribute('aria-activedescendant')
      expect(narrowActiveId).not.toBeNull()
      await expect(page.locator(`#${narrowActiveId}`)).toBeInViewport()
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

test('manifest-gated extension providers use host groups, previews, actions, and live teardown', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  await expect(page.getByTestId('topbar-search')).toBeVisible()
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
        preview: {
          version: 1,
          title: 'Workflow inspection',
          description: 'This long static description is extension data rendered entirely by the search host and must wrap without clipping or changing the dialog focus model.',
          fields: [
            { label: 'Source', value: 'Demo search pack' },
            { label: 'Action', value: 'Open host settings' },
            { label: 'Ownership', value: 'Host markup, semantic tokens, layout, focus, ARIA, and lifecycle' },
          ],
        },
      }, {
        id: 'title-only', title: 'Title-only result', score: 1.5,
        action: { kind: 'host', action: 'settings.open', params: { category: 'General' } },
        preview: { version: 1, title: 'Supplemental preview title' },
      }, {
        id: 'repeated-title', title: 'Repeated preview title', score: 1.25,
        action: { kind: 'host', action: 'settings.open', params: { category: 'General' } },
        preview: { version: 1, title: 'Repeated preview title' },
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
  const headings = page.locator('.search-result-group-header h2')
  await expect(headings).toHaveText(['Demo workflows', 'Demo actions'])
  const preview = page.getByTestId('search-result-preview')
  await expect(preview).toHaveAccessibleName('Workflow inspection')
  await expect(preview).toContainText('Host markup, semantic tokens, layout, focus, ARIA, and lifecycle')
  await expect(page.getByRole('listbox', { name: 'Search results' }).locator('[data-testid="search-result-preview"]')).toHaveCount(0)
  const previewId = await preview.getAttribute('id') ?? ''
  const activeOption = page.locator('[data-provider="demo.search.workflows"] [aria-selected="true"]')
  await expect(activeOption).toHaveAttribute('aria-describedby', `${previewId}-heading ${previewId}-content`)
  await input.press('ArrowDown')
  await expect(preview).toHaveAccessibleName('Supplemental preview title')
  await expect(activeOption).toHaveAttribute('aria-describedby', `${previewId}-heading`)
  await input.press('ArrowDown')
  await expect(preview).toHaveAccessibleName('Repeated preview title')
  expect(await activeOption.getAttribute('aria-describedby')).toBeNull()
  await input.press('ArrowUp')
  await input.press('ArrowUp')
  await expect(preview).toHaveAccessibleName('Workflow inspection')
  await expect(activeOption).toHaveAttribute('aria-describedby', `${previewId}-heading ${previewId}-content`)
  await expect(input).toBeFocused()
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()?.store.doc))).toBe(documentBefore)

  for (const viewport of [
    { name: '09-extension-provider-preview-1600x950', width: 1600, height: 950 },
    { name: '10-extension-provider-preview-1366x768', width: 1366, height: 768 },
    { name: '11-extension-provider-preview-360x640', width: 360, height: 640 },
  ]) {
    await page.setViewportSize(viewport)
    const dialogBox = await page.locator('.search-dialog').boundingBox()
    const previewBox = await preview.boundingBox()
    expect(dialogBox).not.toBeNull()
    expect(previewBox).not.toBeNull()
    expect(previewBox!.x).toBeGreaterThanOrEqual(dialogBox!.x)
    expect(previewBox!.y).toBeGreaterThanOrEqual(dialogBox!.y)
    expect(previewBox!.x + previewBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width)
    expect(previewBox!.y + previewBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
    if (viewport.width === 360) {
      const lastFieldBox = await preview.locator('dd').last().boundingBox()
      expect(lastFieldBox).not.toBeNull()
      expect(lastFieldBox!.y + lastFieldBox!.height).toBeLessThanOrEqual(previewBox!.y + previewBox!.height)
      await expect(page.locator('[data-provider="demo.search.actions"] [role="option"]')).toBeVisible()
    }
    await capture(page, viewport.name)
  }

  await page.evaluate(() => window.__dinksterTest!.app.extensions.setContributionEnabled('demo.search.workflows', false))
  await expect(page.locator('[data-provider="demo.search.workflows"]')).toHaveCount(0)
  await expect(page.locator('[data-provider="demo.search.actions"]')).toBeVisible()
  await expect(preview).toHaveCount(0)
  await page.evaluate(() => {
    const extensions = window.__dinksterTest!.app.extensions
    extensions.setContributionEnabled('demo.search.workflows', true)
    extensions.setContributionEnabled('demo.search.actions', false)
  })
  await expect(page.locator('[data-provider="demo.search.workflows"]')).toBeVisible()
  await expect(page.locator('[data-provider="demo.search.actions"]')).toHaveCount(0)
  await expect(preview).toBeVisible()
  await page.locator('[data-provider="demo.search.workflows"] [aria-selected="true"]').click()
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible()
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()?.store.doc))).toBe(documentBefore)
})

test('Search Dinkster keeps the node title center under the placement click at every canvas zoom', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'auditSearchPlacementTest', displayName: 'audit Search Node', category: 'test', source: 'v3', isOutputNode: false,
      items: [],
    }])
    window.__dinksterTest!.app.openDocument({
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
    await page.locator('[data-provider="core.nodes"] [data-testid="search-result-row"]', { hasText: 'audit Search Node' }).click()
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
