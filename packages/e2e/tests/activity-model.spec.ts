import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, mockProjectPacks, selectProductOption, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_ACTIVITY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

const long = (label: string): string => `${label}-${'0123456789abcdef'.repeat(4)}`
const digest = (character: string): string => `blake3:${character.repeat(64)}`

const records = Array.from({ length: 27 }, (_, index) => ({
  runId: long(`run-${index}`),
  scope: 'local',
  clientId: long(`client-${index % 3}`),
  jobId: long(`job-${index}`),
  state: index === 2 ? 'failed' : index === 3 ? 'cancelled' : 'completed',
  priority: 0,
  submittedAt: 1_755_345_600 - index * 20,
  startedAt: 1_755_345_602 - index * 20,
  finishedAt: 1_755_345_612 - index * 20,
  executed: index < 2 ? 0 : index % 5,
  cached: index < 2 ? 3 : index % 4,
  skipped: index % 4,
  ...(index === 4 ? {} : { sourceDocument: index < 2 ? digest('a') : digest(((index % 6) + 10).toString(16)) }),
  ...(index === 2 ? { error: { kind: 'execution', message: 'The sampler failed after preserving two exact node receipts.' } } : {}),
  nodeReceipts: [
    { nodeId: 'loader-with-long-runtime-identity', disposition: index < 2 ? 'cached' : 'executed', executionArm: 'native' },
    { nodeId: 'sampler-with-long-runtime-identity', disposition: 'cached', executionArm: 'comfyui' },
  ],
}))

async function installFixture(page: Page): Promise<void> {
  await mockProjectPacks(page)
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'fixture has no supervisor' }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/mounts', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'activity-proof', schemaWire: 1 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/history*', async (route) => {
    const request = route.request()
    if (request.method() === 'DELETE') {
      await route.fulfill({ status: 204, body: '' })
      return
    }
    const url = new URL(request.url())
    const pageRecords = url.searchParams.get('cursor') === 'activity-page-2' ? records.slice(24) : records.slice(0, 24)
    await route.fulfill({ json: {
      records: pageRecords,
      ...(url.searchParams.get('cursor') === null ? { cursor: 'activity-page-2' } : {}),
    } })
  })
}

async function seedExecutions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const document = {
      format: 'dinkster-workflow', formatVersion: 1,
      lineage: 'activity-model-long-workflow-lineage', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } },
      view: { graphs: { g0: { nodes: {} } } },
    }
    await app.openDocument(document as never, 'Workflow with a deliberately long activity identity')
    const tab = app.activeTab()!
    const connection = (app as unknown as { backendForTab(tab: unknown): { id: string } }).backendForTab(tab).id
    const artifact = {
      snapshot: tab.store.doc,
      scope: { kind: 'partial' },
      partialTargets: ['target-a', 'target-b'],
      prompt: {},
      provenance: { toSource: {}, toRuntime: {} },
      schemaHash: 'activity-proof',
    }
    const ref = (prompt: string) => ({ connection, prompt })
    const add = (prompt: string, status: 'queued' | 'running' | 'completed' | 'error' | 'interrupted') => {
      const execution = ref(prompt)
      app.store.register(execution as never, artifact as never, Date.now())
      if (status !== 'queued') app.store.apply({ kind: 'started', execution, timestamp: Date.now() + 1 } as never)
      if (status === 'running') {
        app.store.apply({ kind: 'nodeStates', execution, timestamp: Date.now() + 2, snapshot: false, nodes: {
          loader: { state: 'cached' }, sampler: { state: 'running', value: 0.63 }, preview: { state: 'done' },
        } } as never)
      } else if (status === 'completed') {
        app.store.apply({ kind: 'nodeStates', execution, timestamp: Date.now() + 2, snapshot: false, nodes: {
          loader: { state: 'cached' }, sampler: { state: 'done' }, preview: { state: 'done' },
        } } as never)
        app.store.apply({ kind: 'completed', execution, timestamp: Date.now() + 3 } as never)
      } else if (status === 'error') {
        app.store.apply({ kind: 'error', execution, timestamp: Date.now() + 3, runtimeNodeId: 'sampler', detail: {
          exceptionType: 'FixtureError', exceptionMessage: 'Fixture execution failed with retained provenance.', traceback: [],
        } } as never)
      } else if (status === 'interrupted') {
        app.store.apply({ kind: 'interrupted', execution, timestamp: Date.now() + 3 } as never)
      }
    }
    add('queued-fixture-prompt', 'queued')
    add('running-' + 'r'.repeat(64), 'running')
    add('failed-fixture-prompt', 'error')
    add('cancelled-fixture-prompt', 'interrupted')
    add('completed-fixture-prompt', 'completed')
    const removed = app.addBackend('/removed-activity-proof', 'Removed render backend', false, 'dinkster') as { id: string } | undefined
    if (removed === undefined) throw new Error('failed to create removed-backend fixture')
    const removedExecution = { connection: removed.id, prompt: 'removed-backend-fixture-prompt' }
    app.store.register(removedExecution as never, artifact as never, Date.now() + 4)
    app.store.apply({ kind: 'started', execution: removedExecution, timestamp: Date.now() + 5 } as never)
    app.store.apply({ kind: 'completed', execution: removedExecution, timestamp: Date.now() + 6 } as never)
    app.removeBackend(removed.id)
    app.store.apply({
      kind: 'started',
      execution: ref('external-incomplete-' + 'e'.repeat(64)),
      timestamp: Date.now() + 7,
    } as never)
  })
}

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) return
  const viewport = page.viewportSize()
  if (viewport !== null) await page.mouse.move(viewport.width / 2, viewport.height - 2)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page.getByTestId('app-tooltip')).toBeHidden()
  await page.screenshot({ path: join(proofDir, `${name}.png`), animations: 'disabled', fullPage: true })
}

test('activity model remains truthful and usable across wide, narrow, and zoom-equivalent states', async ({ page }) => {
  await installFixture(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest !== undefined)).toBe(true)
  await expect(page.getByTestId('status-bar')).toContainText('connected')
  await waitForWorkspaceReady(page)
  await expect(page.getByTestId('runs-panel').getByRole('img', { name: /running, .*queued/ })).toHaveCount(0)
  await seedExecutions(page)
  await capture(page, 'after-activity-workflow-counts')

  await page.getByTestId('workflow-queue-toggle').click()
  await expect(page.getByTestId('workflow-queue-summary')).toContainText('1 running, 1 queued')
  await expect(page.getByTestId('workflow-queue-entry')).toHaveCount(6)
  await expect(page.getByTestId('execution-row')).toHaveCount(6)
  await expect(page.getByTestId('runs-panel').getByRole('img', { name: '1 running, 1 queued', exact: true })).toBeVisible()
  await expect(page.getByTestId('backend-group').filter({ hasText: 'backend removed or disconnected' })).toContainText('/removed-activity-proof')
  const runningEntry = page.getByTestId('workflow-queue-entry').filter({ hasText: 'running-' })
  await expect(runningEntry).toContainText(/Running|running/)
  if (process.env['DINKSTER_ACTIVITY_EXPECT_REDESIGN'] === '1') {
    await expect(runningEntry).toContainText(/63%/)
    await runningEntry.locator('.execution-open').focus()
  } else {
    await runningEntry.focus()
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.locator('.workflow-queue-list').evaluate((element) => { element.scrollTop = 0 })
  const railScroll = page.locator('.dock-zone .product-tabpanel:not([hidden])')
  await railScroll.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect(page.getByTestId('backend-group').filter({ hasText: 'backend removed or disconnected' })).toBeInViewport()
  await capture(page, 'after-activity-wide-queue-and-executions')
  await railScroll.evaluate((element) => { element.scrollTop = 0 })

  await page.getByTestId('workflow-queue-toggle').click()
  await selectProductOption(page, page.getByTestId('runs-scope'), 'all')
  const panel = page.getByTestId('runs-panel')
  await expect(panel.getByRole('img', { name: '2 running, 1 queued', exact: true })).toBeVisible()
  const runs = panel.getByRole('listbox', { name: 'Runs results', exact: true })
  const runEntries = runs.getByTestId('collection-entry')
  await expect(panel.getByTestId('execution-row')).toHaveCount(3)
  await capture(page, 'after-activity-all-workflows-counts')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(panel.getByRole('img', { name: '2 running, 1 queued', exact: true })).toBeInViewport()
  await capture(page, 'after-activity-narrow-counts')
  await page.setViewportSize({ width: 1600, height: 950 })
  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.store
    const external = [...store.executions.get().values()].find((entry) => entry.ref.prompt.startsWith('external-incomplete-'))!
    store.apply({ kind: 'completed', execution: external.ref, timestamp: Date.now() + 8 } as never)
  })
  await expect(panel.getByRole('img', { name: '1 running, 1 queued', exact: true })).toBeVisible()
  await expect(panel.getByTestId('execution-row')).toHaveCount(2)
  await expect(runEntries).toHaveCount(23)
  const group = runEntries.filter({ hasText: /2 runs|x2/ }).first()
  await group.getByTestId('collection-expand').click()
  await expect(runs.locator('.collection-entry.collection-child')).toHaveCount(2)
  await panel.getByTestId('collection-more').click()
  await expect(runEntries).toHaveCount(28)
  const failed = runEntries.filter({ hasText: 'job-2-' }).first()
  await failed.click()
  await failed.locator('.runs-details > summary').click()
  await expect(failed.locator('.output-facts')).toContainText('The sampler failed after preserving two exact node receipts.')
  const remove = failed.locator('[data-action=delete]')
  await remove.click()
  await expect(remove).toHaveText('Confirm delete')
  await failed.scrollIntoViewIfNeeded()
  await capture(page, 'after-activity-runs-grouped-paged-confirmation')

  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await capture(page, 'after-activity-narrow-runs')

  await page.setViewportSize({ width: 720, height: 450 })
  await selectProductOption(page, page.getByTestId('runs-scope'), 'workflow')
  await page.getByTestId('workflow-queue-toggle').focus()
  await page.keyboard.press('Enter')
  await page.locator('.workflow-queue-list').evaluate((element) => { element.scrollTop = element.scrollHeight })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await capture(page, 'after-activity-200-percent-equivalent-tail')
})
