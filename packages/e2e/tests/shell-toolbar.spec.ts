import { expect, test } from './fixtures.js'

test('execution status stays below canvas controls when the toolbar wraps', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  await page.getByTestId('library-toggle').click()
  await expect(page.getByTestId('dock-zone-right')).toBeVisible()
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as NonNullable<typeof window.__dinksterTest>['app'] & {
      store: { restoreCompleted(state: unknown): void }
      semanticHashOfTab(tab: unknown): string
      pinExecutionOverlay(tabId: string, ref: unknown): boolean
    }
    const tab = app.activeTab()!
    const connection = app.backendForTab(tab).id
    const ref = { connection, prompt: 'shell-layout-completed' }
    app.store.restoreCompleted({
      ref,
      artifact: {
        snapshot: structuredClone(tab.store.doc), revision: 0,
        semanticHash: app.semanticHashOfTab(tab), scope: { kind: 'full' },
        connection, schemaHash: 'shell-layout-fixture', prompt: {},
        provenance: { toSource: {}, fromSource: {} }, diagnostics: [],
      },
      nodes: {}, outputs: {}, artifacts: [],
      jobRef: 'shell-layout-job', sourceDocument: tab.id, queuedAt: 1, endedAt: 2,
    })
    app.pinExecutionOverlay(tab.id, ref)
  })
  const chip = page.getByTestId('sync-chip')
  await expect(chip).toHaveAttribute('data-overlay-mode', 'pinned')
  for (const width of [1440, 1100, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect.poll(async () => {
      const toolbar = (await page.locator('.canvas-stage-toolbar').boundingBox())!
      const status = (await chip.boundingBox())!
      return status.y - (toolbar.y + toolbar.height)
    }).toBeGreaterThanOrEqual(8)
    const stage = (await page.locator('.canvas-stage').boundingBox())!
    const status = (await chip.boundingBox())!
    expect(status.x).toBeGreaterThanOrEqual(stage.x)
    expect(status.x + status.width).toBeLessThanOrEqual(stage.x + stage.width)
    for (const control of await page.locator('.canvas-stage-toolbar button').all()) {
      const box = (await control.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(stage.x)
      expect(box.x + box.width).toBeLessThanOrEqual(stage.x + stage.width)
    }
  }
  await page.getByTestId('sync-chip-open').click()
  const frozen = page.getByTestId('frozen-banner')
  await expect(frozen).toBeVisible()
  const toolbar = (await page.locator('.canvas-stage-toolbar').boundingBox())!
  const banner = (await frozen.boundingBox())!
  expect(banner.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height + 8)
})

test('narrow shell preserves canvas space and keeps search clear of layout controls', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  await page.getByTestId('library-toggle').click()
  const dock = page.getByTestId('dock-panel')
  const rail = page.getByTestId('dock-zone-right')
  const canvas = page.locator('.canvas-pane')
  await expect(dock).toBeVisible()
  await expect(rail).toBeVisible()
  const searchTrigger = page.getByTestId('topbar-search')
  const shortcut = searchTrigger.locator('kbd')
  await expect(shortcut).toBeVisible()
  const expandedSearch = (await searchTrigger.boundingBox())!
  const expandedControls = (await page.locator('.dinkster-window-toolbar-actions').boundingBox())!
  const expandedShortcut = (await shortcut.boundingBox())!
  expect(expandedSearch.x + expandedSearch.width).toBeLessThanOrEqual(expandedControls.x)
  expect(expandedShortcut.x + expandedShortcut.width).toBeLessThanOrEqual(expandedSearch.x + expandedSearch.width)
  await page.setViewportSize({ width: 900, height: 700 })
  await expect(rail).toBeHidden()
  await expect(dock).toBeVisible()
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(320)
  const search = (await page.getByTestId('topbar-search').boundingBox())!
  const controls = (await page.locator('.dinkster-window-toolbar-actions').boundingBox())!
  expect(search.x + search.width).toBeLessThanOrEqual(controls.x)
  await expect(shortcut).toBeHidden()
  await expect(searchTrigger).toHaveAccessibleName('Search Dinkster')
  await expect(searchTrigger.locator('svg')).toBeVisible()

  await page.getByTestId('rail-toggle').click()
  await expect(rail).toBeVisible()
  await expect(dock).toBeHidden()
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(320)
  await page.getByTestId('library-toggle').click()
  await expect(dock).toBeVisible()
  await expect(rail).toBeHidden()

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.settings.set('shell.layout.left.width', 640)
    app.settings.set('shell.layout.right.width', 560)
  })
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(320)
  await page.getByTestId('rail-toggle').click()
  await expect(rail).toBeVisible()
  await expect(dock).toBeHidden()
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(320)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect.poll(async () => (await page.locator('.rail').boundingBox())!.width).toBe(560)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.settings.set('shell.layout.left.width', 380)
    app.settings.set('shell.layout.right.width', 300)
  })
  await page.getByTestId('library-toggle').click()
  await expect(dock).toBeVisible()
  await expect(rail).toBeVisible()
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThanOrEqual(320)
  await page.setViewportSize({ width: 1072, height: 700 })
  await expect(rail).toBeVisible()
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBe(320)
  await page.setViewportSize({ width: 1071, height: 700 })
  await expect(rail).toBeHidden()
  await expect(dock).toBeVisible()
  await page.setViewportSize({ width: 480, height: 800 })
  for (const id of ['left-panel-toggle', 'bottom-panel-toggle', 'rail-toggle']) await expect(page.getByTestId(id)).toHaveCount(0)
  await page.getByRole('button', { name: 'Customize layout' }).click()
  const layout = page.getByRole('menu', { name: 'Customize layout' })
  // Right panel carries the right panel's attention count when the engine reports problems.
  await expect(layout.getByRole('menuitemcheckbox')).toHaveText(['Left panel', 'Bottom panel', /^Right panel\d*$/, 'Left bar', 'Status bar'])
  await layout.getByRole('menuitemcheckbox', { name: 'Right panel' }).click()
  await expect(rail).toBeVisible()
  await expect(dock).toBeVisible()
  await expect(page.getByTestId('tab-bar')).toBeVisible()
  await expect(page.getByTestId('status-bar')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(480)
})

test('toolbar activity counts all workflows and excludes terminal history', async ({ page }) => {
  const reconciled = new Set<string>()
  let completed = false
  await page.routeWebSocket('**/api/events?*', () => {})
  // Synthetic store entries need matching server records when schema refresh reconciles them.
  await page.route('/api/jobs/*/toolbar-*', (route) => {
    const jobId = new URL(route.request().url()).pathname.split('/').at(-1)!
    reconciled.add(jobId)
    return route.fulfill({ json: {
      jobId, state: jobId === 'toolbar-waiting' ? 'queued' : completed ? 'completed' : 'running',
      nodeStates: {}, outputs: {}, artifacts: [],
    } })
  })
  await page.goto('/')
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  const activity = page.locator('.dinkster-window-toolbar-actions .dinkster-run-activity')
  await expect(activity).toHaveCount(0)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    for (const [index, prompt] of ['toolbar-running-current', 'toolbar-running-other', 'toolbar-waiting'].entries()) {
      const artifact = {
        snapshot: structuredClone(tab.store.doc), revision: 0,
        semanticHash: 'toolbar-activity', scope: { kind: 'full' },
        connection: app.backendForTab(tab).id, schemaHash: 'toolbar-activity', prompt: {},
        provenance: { toSource: {}, fromSource: {} }, diagnostics: [],
      }
      if (index > 0) artifact.snapshot.lineage = 'toolbar-other-workflow'
      const ref = { connection: artifact.connection, prompt }
      app.store.register(ref, artifact, index + 1)
      if (index < 2) app.store.apply({ kind: 'started', execution: ref, timestamp: index + 10 })
    }
  })
  await expect(activity).toHaveAccessibleName('2 running, 1 queued')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.backends.get()[0]!.connection.status.get())).toBe('connected')
  await page.evaluate(() => {
    const backend = window.__dinksterTest!.app.backends.get()[0]!
    backend.registry.set({ ...backend.registry.get()! } as unknown as Parameters<typeof backend.registry.set>[0])
  })
  await expect.poll(() => reconciled.size).toBe(3)
  await expect(activity).toHaveAccessibleName('2 running, 1 queued')
  await expect(activity.locator('.dinkster-run-activity-running')).toHaveText('2')
  await expect(activity.locator('.dinkster-run-activity-waiting')).toHaveText('1')
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const control of await page.locator('.dinkster-window-toolbar-host button:visible, .dinkster-window-toolbar-host .dinkster-run-activity').all()) {
      const bounds = (await control.boundingBox())!
      expect(bounds.x).toBeGreaterThanOrEqual(12)
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 12)
    }
    await page.locator('.dinkster-window-toolbar-host').screenshot({ path: `test-results/captures/app-toolbar-activity-${width}.png` })
  }
  completed = true
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    for (const execution of app.store.executions.get().values()) {
      if (execution.ref.prompt.startsWith('toolbar-running-')) {
        app.store.apply({ kind: 'completed', execution: execution.ref, timestamp: 20 })
      }
    }
  })
  await expect(activity).toHaveCount(0)
})
