import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, mockProjectPacks, nativeTest as test, waitForWorkspaceReady } from './fixtures.js'

const proof = process.env['DINKSTER_STATUS_PROOF_DIR']

test('status readings follow workflow state and open their explanatory panels', async ({ page }) => {
  await mockProjectPacks(page)
  await page.route('/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.includes('/library/retention')) return route.fallback()
    if (path === '/api/nodes') return route.fulfill({ json: { schemaVersion: 1, epoch: 1, dinkster: { version: 'status-fixture', schemaWire: 1 }, nodes: {}, packs: {} } })
    if (path === '/api/workflows/plan') return route.fulfill({ json: { packs: [], assets: [], errors: [] } })
    if (path === '/api/mounts') return route.fulfill({ json: { mounts: [] } })
    if (path === '/api/models/downloads') return route.fulfill({ json: { instance: 'status-fixture', jobs: [] } })
    if (path === '/api/history/runs') return route.fulfill({ json: { records: [] } })
    if (path === '/api/docs') return route.fulfill({ json: { docs: [] } })
    if (path.startsWith('/api/projects/')) return route.fallback()
    return route.fulfill({ status: 503, body: 'Not provided by status fixture' })
  })
  await page.route('/supervisor/**', (route) => route.fulfill({ status: 404 }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/memory/status*', (route) => route.fulfill({ json: {
    devices: { 'cuda:0': { executionCapacity: 1, executionInUse: 0 } },
    queue: { queued: 0, running: [], maxRunningJobs: 1, paused: false }, leases: [],
    memoryGovernor: { 'cuda:0': { budgetBytes: 8000000000, reservedBytes: 0, consumerFootprintBytes: 2000000000,
      availableBytes: 6000000000, consumers: {}, measured: { totalBytes: 8000000000, freeBytes: 6000000000, gpuName: 'Fixture GPU' } } },
  } }))
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.backends.get()[0]!.connection.status.get()
    const tab = app.createWorkflow()
    app.renameTab(tab.id, 'Portrait')
  })
  const capture = async (name: string) => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.mouse.move(700, 50)
    await expect(page.getByTestId('app-tooltip')).toBeHidden()
    if (proof) { mkdirSync(proof, { recursive: true }); await page.screenshot({ path: join(proof, `${name}.png`), animations: 'disabled' }) }
  }
  await expect(page.getByTestId('status-connection')).toHaveAttribute('data-state', 'connected')
  await expect(page.getByTestId('status-run')).toContainText('Idle')
  await expect(page.getByTestId('status-workflow-context')).toContainText('0 nodes, 0 selected')
  await expect(page.getByTestId('status-memory')).toBeVisible()
  await capture('idle-workflow')
  await page.getByTestId('status-connection').click()
  await expect(page.getByTestId('backends-panel')).toBeVisible()
  await page.getByTestId('status-memory').click()
  await expect(page.getByTestId('memory-panel')).toBeVisible()
  await page.getByTestId('left-panel-toggle').click()
  const workflowId = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const ref = { connection: app.backends.get()[0]!.id, prompt: 'status-running' }
    const artifact = { snapshot: tab.store.doc, scope: { kind: 'full' }, prompt: { first: {}, second: {} },
      provenance: { toSource: {}, toRuntime: {} }, schemaHash: 'status-fixture' }
    app.store.register(ref, artifact as never, 100)
    app.store.register({ connection: ref.connection, prompt: 'status-queued' }, artifact as never, 103)
    app.store.apply({ kind: 'started', execution: ref, timestamp: 101 } as never)
    app.store.apply({ kind: 'nodeStates', execution: ref, timestamp: 102, snapshot: true,
      nodes: { first: { state: 'done' }, second: { state: 'running', value: 0.5 } } } as never)
    const foreignTab = app.createWorkflow()
    app.renameTab(foreignTab.id, 'Landscape')
    const foreign = { ...artifact, snapshot: foreignTab.store.doc }
    app.store.register({ connection: ref.connection, prompt: 'foreign-queued' }, foreign as never, 104)
    const other = app.addBackend('/status-other', 'Other backend', false, 'dinkster')!
    for (const prompt of ['other-running-one', 'other-running-two']) {
      const execution = { connection: other.id, prompt }
      app.store.register(execution, foreign as never, 105)
      app.store.apply({ kind: 'started', execution, timestamp: 106 } as never)
    }
    app.activeTabId.set(tab.id)
    return tab.id
  })
  await expect(page.getByTestId('status-run')).toContainText('75%')
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveAccessibleName('1 running, 1 queued')
  await page.getByTestId('status-run').click()
  await expect(page.getByTestId('runs-panel')).toBeVisible()
  await expect(page.getByTestId('runs-scope')).toHaveAttribute('data-selected-id', 'workflow')
  await capture('running')
  await page.locator('.tab', { has: page.locator('.tab-select', { hasText: 'Landscape' }) }).click({ button: 'right' })
  await page.getByTestId('context-menu').locator('[data-item-id="workflow.splitRight"]').click()
  await expect(page.getByTestId('editor-group')).toHaveCount(2)
  await expect(page.getByTestId('status-run')).toContainText('Landscape')
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveAccessibleName('2 running, 1 queued')
  await page.locator('.tab-select', { hasText: 'Portrait' }).click()
  await expect(page.getByTestId('status-run')).toContainText('Portrait')
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveAccessibleName('1 running, 1 queued')
  await capture('split-focused-workflow')
  await page.setViewportSize({ width: 390, height: 900 })
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveAccessibleName('1 running, 1 queued')
  expect(await page.getByTestId('status-run').evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true)
  await capture('running-compact')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.reportProblems(app.activeTab()!.id, [{ severity: 'error', origin: 'runtime', code: 'status.fixture', message: 'Status fixture failure' }])
  })
  await expect(page.getByTestId('status-problems')).toHaveAttribute('data-severity', 'error')
  await page.getByTestId('status-problems').click()
  await expect(page.getByTestId('problems-panel')).toBeVisible()
  await capture('problem')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { backends: { get(): { composition: { set(value: unknown): void } }[] } }
    app.backends.get()[0]!.composition.set({ done: 2, total: 5, phase: 'Loading packs' })
  })
  await expect(page.getByTestId('status-background')).toContainText('2/5')
  await page.getByTestId('status-background').click()
  await expect(page.getByTestId('log-scope')).toHaveAttribute('data-selected-id', 'app')
  await capture('background')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const first = app.executionsForTab(app.activeTab()!).find((run) => run.status === 'running')!
    const second = { connection: first.ref.connection, prompt: 'status-second-running' }
    app.store.register(second, first.artifact!, 107)
    app.store.apply({ kind: 'started', execution: second, timestamp: 108 } as never)
  })
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveAccessibleName('2 running, 1 queued')
  await expect(page.getByTestId('status-run')).toContainText('Portrait')
  await expect(page.getByTestId('status-run')).not.toContainText('%')
  await capture('several-running')
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    return app.openExecutionView({ connection: app.backends.get()[0]!.id, prompt: 'status-running' })
  })).toBe(true)
  await expect(page.getByTestId('status-run')).toContainText('Frozen')
  await expect(page.getByTestId('status-run')).toContainText('75%')
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveAccessibleName('1 running, 0 queued')
  await capture('frozen-running')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.store.apply({ kind: 'completed', execution: app.activeTab()!.execution!, timestamp: 48_101 } as never)
  })
  await expect(page.getByTestId('status-run')).toContainText('Frozen')
  await expect(page.getByTestId('status-run')).toContainText('completed in 48 s')
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveCount(0)
  await capture('frozen-completed')
  await page.evaluate((workflowId) => {
    const app = window.__dinksterTest!.app
    app.activeTabId.set(workflowId)
    app.store.apply({ kind: 'completed', execution: { connection: app.backends.get()[0]!.id, prompt: 'status-second-running' }, timestamp: 48_102 } as never)
  }, workflowId)
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveAccessibleName('0 running, 1 queued')
  await expect(page.getByTestId('status-run')).toContainText('Portrait')
  await expect(page.getByTestId('status-run')).not.toContainText('%')
  await page.getByTestId('status-run').click()
  await expect(page.getByTestId('runs-scope')).toHaveAttribute('data-selected-id', 'workflow')
  await capture('queued-position-unknown')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.store.apply({ kind: 'completed', execution: { connection: app.backends.get()[0]!.id, prompt: 'status-queued' }, timestamp: 48_103 } as never)
  })
  await expect(page.getByTestId('status-run')).toContainText('Idle')
  await expect(page.getByTestId('status-run')).toHaveAccessibleName('Portrait: nothing running or queued')
  await expect(page.getByTestId('status-run').getByRole('img')).toHaveCount(0)
  await capture('idle-with-other-workflows-running')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { activeTab(): { id: string }; setTabEditorKind(id: string, kind: string): void }
    app.setTabEditorKind(app.activeTab().id, 'glsl')
  })
  await expect(page.getByTestId('status-workflow-context')).toHaveCount(0)
  await expect(page.getByTestId('status-run')).toHaveCount(0)
  await capture('other-tab')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { activeTab(): { id: string }; setTabEditorKind(id: string, kind: string): void }
    app.setTabEditorKind(app.activeTab().id, 'graph')
  })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as { backends: { get(): { connection: { status: { set(value: string): void } } }[] }; backendsTick: { update(fn: (value: number) => number): void } }
    app.backends.get()[0]!.connection.status.set('disconnected')
    app.backendsTick.update((value) => value + 1)
  })
  await expect(page.getByTestId('status-connection')).toContainText('disconnected')
  await expect(page.getByTestId('status-memory')).toHaveCount(0)
  await expect(page.getByTestId('status-background')).toHaveCount(0)
  await capture('disconnected')
  await page.setViewportSize({ width: 520, height: 900 })
  await expect(page.getByTestId('status-problems')).toBeVisible()
  await expect(page.getByTestId('status-run')).toBeVisible()
  await capture('compact')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.keyboard.press('Control+,')
  const settings = page.getByRole('dialog')
  await settings.getByRole('button', { name: 'Execution', exact: true }).click()
  const review = settings.locator('[id="setting-execution.reviewUpgrades"]')
  await expect(review).toHaveAttribute('aria-checked', 'false')
  await review.click()
  await expect(review).toHaveAttribute('aria-checked', 'true')
  expect(await page.evaluate(() => window.__dinksterTest!.app.settings.get('execution.reviewUpgrades'))).toBe(true)
  await capture('review-upgrades-settings')
})
