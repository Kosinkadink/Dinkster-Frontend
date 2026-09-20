/**
 * Durable run-history actions through the production library panel, against
 * a live NATIVE backend's persistent /api/history scope:
 *
 * - a completed native run lands as a durable, stamped record; entry click
 *   is select-only (details + actions), and the explicit 'Open workflow'
 *   action reopens the exact producing document;
 * - 'Delete record' removes the RECORD only: the collection re-pages
 *   without it while the sourceDocument asset bytes survive;
 * - a delete transport failure lands in Problems (history.deleteFailed)
 *   and the record stays;
 * - 'Clear all' arms to 'Confirm clear' and wipes the scope only on the
 *   second click.
 *
 * The clear test wipes the ENTIRE local history scope of the target server
 * (that is the feature); runs there are e2e-produced. Requires a NATIVE
 * Dinkster backend serving the dinkster-nodes-dev pack: the driver node
 * lives in the gated dev pack and a plain dinkster-serve does not compose it.
 * Skips loudly when no backend answers OR the dev node is absent, so the
 * suite stays runnable against ComfyUI alone or a non-dev native server.
 */
import { expect, productOption, selectProductOption, test, type Page } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

/** Register the native server as a second backend (no tab targeting yet). */
async function addNativeBackend(page: Page): Promise<void> {
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(NATIVE_BACKEND)
  await page.getByTestId('backend-add').click()
  await expect(page.getByTestId('tab-target')).toBeVisible()
}

/**
 * Open a document holding one dev.image.gradient node ('grad') and target
 * ITS tab at the native backend (schema registries are per backend and
 * resolve through the ACTIVE tab's target).
 */
async function openGradientDoc(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'run-history-e2e', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { grad: { id: 'grad', type: 'dev.image.gradient', values: { width: 8, height: 8 } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
      } },
      view: { graphs: { g0: { nodes: { grad: { position: { x: 120, y: 120 } } } } } },
    } as never, 'Run History')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await selectProductOption(page, page.getByTestId('tab-target'), NATIVE_BACKEND)
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store &&
      (tab.store.status as { get(): string }).get() === 'live' &&
      tab.store.doc.lineage === 'run-history-e2e'
  })).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes
      .find((n) => n.id === 'grad')?.layout.rows
      .some((r) => r.kind === 'widget' && r.inputId === 'width'),
  ), { timeout: 15_000 }).toBe(true)
}

/**
 * Queue the grad node through the context-menu partial-execute item (the
 * graph has no output nodes, so full-scope queue refuses it) and wait for
 * completion. Returns the run's jobId for locating its durable record.
 */
async function queueAndComplete(page: Page): Promise<string> {
  await expect(page.getByTestId('queue-button')).toBeEnabled()
  const before = await page.evaluate(() =>
    [...window.__dinksterTest!.app.store.executions.get().values()].map((execution) => execution.ref.prompt))
  const p = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((item) => item.id === 'grad')!
    const viewport = renderer.getViewport()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(p.x, p.y, { button: 'right' })
  await page.getByTestId('context-menu-item').filter({ hasText: 'Execute up to Selection' }).click()
  // Wait on the store, not on the first execution-row: an all-cached rerun
  // completes near-instantly, and with an older completed run in the rail
  // the first row matches 'completed' before the NEW execution registers.
  const newPrompt = (existing: readonly unknown[]) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => !existing.includes(execution.ref.prompt))?.ref.prompt
  await expect.poll(() => page.evaluate(newPrompt, before), { timeout: 10_000 }).not.toBe(undefined)
  const prompt = (await page.evaluate(newPrompt, before))!
  await expect.poll(() => page.evaluate((target) =>
    [...window.__dinksterTest!.app.store.executions.get().values()]
      .find((execution) => execution.ref.prompt === target)?.status, prompt),
  { timeout: 30_000 }).toBe('completed')
  return prompt
}

async function durableRecords(): Promise<readonly {
  readonly jobId: string
  readonly state: string
  readonly executed: number
  readonly cached: number
  readonly sourceDocument?: string
}[]> {
  const response = await fetch(`${NATIVE_BACKEND}/api/history?scope=local&limit=100`)
  if (!response.ok) return []
  return (await response.json() as { records: readonly {
    jobId: string; state: string; executed: number; cached: number; sourceDocument?: string
  }[] }).records
}

/** Open the library overlay on the Runs source. */
async function openRuns(page: Page): Promise<void> {
  await page.getByTestId('library-toggle').click()
  const library = page.getByTestId('library-overlay')
  await expect(library).toBeVisible()
  const runsTab = library.locator('[data-testid=collection-source][data-source=runs]')
  if (await runsTab.isVisible()) await runsTab.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), 'runs')
}

/** The runs entry whose subtitle is the run's jobId prefix. */
const entryFor = (page: Page, jobId: string) =>
  page.getByTestId('collection-entry').filter({ hasText: jobId.slice(0, 8) })

test.beforeEach(async ({ page }) => {
  // Probe outside the skip calls: test.skip signals by throwing, so a skip
  // raised inside the try would be swallowed and remapped to 'unreachable'.
  let served: Record<string, unknown> | null = null
  try {
    const history = await fetch(`${NATIVE_BACKEND}/api/history?scope=local&limit=1`, { signal: AbortSignal.timeout(2000) })
    if (history.ok) {
      const nodes = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })
      if (nodes.ok) served = (await nodes.json() as { nodes?: Record<string, unknown> }).nodes ?? {}
    }
  } catch { /* unreachable -> served stays null */ }
  test.skip(served === null, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
  // A reachable server is not enough: the driver node is dev-gated, so a
  // non-dev server answers 200 while missing the node every test queues.
  test.skip(!('dev.image.gradient' in served!),
    `native backend at ${NATIVE_BACKEND} lacks dev.image.gradient - serve the dinkster-nodes-dev pack`)
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await addNativeBackend(page)
  await openGradientDoc(page)
})

test('a durable stamped record: click selects, the open action reopens the producing workflow', async ({ page }) => {
  const jobId = await queueAndComplete(page)
  await openRuns(page)
  const entry = entryFor(page, jobId)
  await expect(entry).toHaveCount(1)
  await expect(entry.locator('.collection-badges')).toContainText('completed')
  await expect(entry.locator('.collection-badges')).toContainText('Source recorded')

  // Click selects and inspects - it must NOT open anything or close the
  // panel (that would make the delete affordance unreachable).
  await entry.click()
  await expect(page.getByTestId('library-overlay')).toBeVisible()
  await expect(entry.getByTestId('collection-details')).toContainText('source document')

  // Diverge the live document, then reopen the run: the open action must
  // restore the EXACT producing document. Tab identity is the document
  // lineage, so the reopen replaces the diverged tab rather than adding one.
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((t) => t.id === 'run-history-e2e')!
    ;(tab.store as unknown as {
      dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
    }).dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'grad', inputId: 'width', value: 99 } })
  })
  const tabsBefore = await page.evaluate(() => window.__dinksterTest!.app.tabs.get().length)
  await entry.locator('[data-testid=collection-action][data-action=open]').click()
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['grad']!.values['width'],
  )).toBe(8)
  const after = await page.evaluate(() => ({
    tabs: window.__dinksterTest!.app.tabs.get().length,
    type: window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['grad']!.type,
  }))
  expect(after.tabs).toBe(tabsBefore)
  expect(after.type).toBe('dev.image.gradient')
})

test('two cached runs collapse into one expandable no-op history row', async ({ page }) => {
  // Give this test a unique workflow digest, warm its engine cache once,
  // then clear only durable records. The next two submissions are both
  // cached while the Runs corpus starts empty and cannot inherit xN rows
  // from a previous invocation.
  await page.evaluate((width) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    ;(tab.store as unknown as {
      dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
    }).dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'grad', inputId: 'width', value: width } })
  }, 1000 + Math.floor(Math.random() * 1000))
  const warmJob = await queueAndComplete(page)
  await expect.poll(async () => (await durableRecords()).some((record) => record.jobId === warmJob)).toBe(true)
  const sourceDocument = (await durableRecords()).find((record) => record.jobId === warmJob)!.sourceDocument!
  const cleared = await fetch(
    `${NATIVE_BACKEND}/api/history?scope=local&sourceDocument=${encodeURIComponent(sourceDocument)}`,
    { method: 'DELETE' },
  )
  expect(cleared.ok).toBe(true)
  await expect.poll(async () =>
    (await durableRecords()).filter((record) => record.sourceDocument === sourceDocument).length).toBe(0)
  const firstJob = await queueAndComplete(page)
  const secondJob = await queueAndComplete(page)
  await expect.poll(async () => {
    const tested = (await durableRecords()).filter((record) =>
      record.jobId === firstJob || record.jobId === secondJob)
    return tested.length === 2 && tested.every((record) =>
      record.state === 'completed' && record.executed === 0 && record.cached > 0)
  }).toBe(true)
  await openRuns(page)

  const grouped = entryFor(page, secondJob)
  await expect(grouped).toHaveCount(1)
  await expect(grouped).toContainText('2 runs')
  await expect(grouped.getByTestId('collection-expand')).toHaveAttribute('aria-expanded', 'false')
  await grouped.getByTestId('collection-expand').click()
  await expect(grouped.getByTestId('collection-expand')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.collection-entry.collection-child')).toHaveCount(2)
  for (const child of await page.locator('.collection-entry.collection-child').all()) {
    await expect(child.locator('.collection-badges')).toContainText('0 run')
    await expect(child.locator('.collection-badges')).not.toContainText('0 cached')
  }
})

test('delete removes the record only: the collection re-pages and asset bytes survive', async ({ page }) => {
  const jobId = await queueAndComplete(page)
  await openRuns(page)
  const entry = entryFor(page, jobId)
  await expect(entry).toHaveCount(1)
  await entry.click()
  const sourceDoc = await entry.getByTestId('collection-details').locator('dd')
    .filter({ hasText: /^blake3:/ }).first().textContent()
  expect(sourceDoc).toMatch(/^blake3:[0-9a-f]{64}$/)

  const remove = entry.locator('[data-testid=collection-action][data-action=delete]')
  await remove.click()
  await expect(remove).toHaveText('Confirm delete')
  await expect(entry).toHaveCount(1)
  await remove.click()
  await expect(entry).toHaveCount(0, { timeout: 10_000 })

  // Record-only by contract: the producing document's asset bytes survive.
  const asset = await fetch(`${NATIVE_BACKEND}/api/assets/${encodeURIComponent(sourceDoc!)}`)
  expect(asset.ok).toBe(true)
  // And the record itself is durably gone, not just filtered client-side.
  const listing = await (await fetch(`${NATIVE_BACKEND}/api/history?scope=local&limit=100`)).json() as
    { records: { jobId: string }[] }
  expect(listing.records.some((r) => r.jobId === jobId)).toBe(false)
})

test('a delete failure lands in Problems and keeps the record', async ({ page }) => {
  const jobId = await queueAndComplete(page)
  await page.route('**/api/history/**', (route) =>
    route.request().method() === 'DELETE'
      ? route.fulfill({ status: 500, body: '' })
      : route.fallback())
  await openRuns(page)
  const entry = entryFor(page, jobId)
  await entry.click()
  const remove = entry.locator('[data-testid=collection-action][data-action=delete]')
  await remove.click()
  await expect(remove).toHaveText('Confirm delete')
  await remove.click()
  await expect(page.getByTestId('problems-panel')).toContainText('history.deleteFailed')
  await expect(entry).toHaveCount(1)
})

test('runs lingering through a backend switch can never clear the incoming backend', async ({ page }) => {
  // A second identity for the SAME native server (different host string =>
  // different backend id). Requires a host we know how to alias.
  test.skip(!/127\.0\.0\.1|localhost/.test(NATIVE_BACKEND), 'needs an aliasable backend host')
  const altBackend = NATIVE_BACKEND.includes('127.0.0.1')
    ? NATIVE_BACKEND.replace('127.0.0.1', 'localhost')
    : NATIVE_BACKEND.replace('localhost', '127.0.0.1')

  const jobId = await queueAndComplete(page)
  await openRuns(page)
  await expect(entryFor(page, jobId)).toHaveCount(1)

  // HOLD the alt identity's history listing: its first page never commits
  // while we probe, so the old backend's runs linger on screen while the
  // current library owner differs from the owner of the displayed entries.
  let releaseHistory!: () => void
  const historyReleased = new Promise<void>((resolve) => { releaseHistory = resolve })
  await page.route(`${altBackend}/api/history*`, async (route) => {
    await historyReleased
    await route.continue()
  })
  const clearCalls: string[] = []
  page.on('request', (r) => {
    if (r.method() === 'DELETE' && r.url().includes('/api/history')) clearCalls.push(r.url())
  })

  // Register the alt identity through the bridge (opening the Backends
  // dock panel would REPLACE the library overlay and unmount the very
  // panel whose lingering items we are probing), then retarget the active
  // tab at it: the library owner flips, the runs panel re-pages, and the
  // replacement page stalls.
  await page.evaluate((url) => {
    window.__dinksterTest!.app.addBackend(url, undefined, true, 'dinkster')
  }, altBackend)
  const target = page.getByTestId('tab-target')
  await target.click()
  await expect(await productOption(page, altBackend)).toBeVisible()
  await target.press('Escape')
  await selectProductOption(page, target, altBackend)

  // While the replacement page is in flight: the old entries still linger,
  // but the page-scoped clear is DISABLED (no committed page owner) - two
  // impatient clicks cannot route a wipe to the incoming backend.
  const clear = page.getByTestId('collection-source-action')
  await expect(clear).toBeDisabled()
  await expect(clear).toHaveText('Clear all') // never armed
  await expect(entryFor(page, jobId)).toHaveCount(1)
  expect(clearCalls).toEqual([])

  // Releasing the stall recovers: the alt page commits, its owner is
  // installed, and the clear affordance re-enables against the corpus the
  // user actually sees.
  releaseHistory()
  await expect(clear).toBeEnabled({ timeout: 10_000 })
  await page.unrouteAll({ behavior: 'wait' })
  expect(clearCalls).toEqual([])
})

test('clear arms first, wipes the whole scope on confirmation', async ({ page }) => {
  await queueAndComplete(page)
  await openRuns(page)
  await expect(page.getByTestId('collection-entry').first()).toBeVisible()

  const clear = page.getByTestId('collection-source-action')
  await expect(clear).toHaveText('Clear all')
  await clear.click()
  // Armed, not executed: entries survive the first click.
  await expect(clear).toHaveText('Confirm clear')
  await expect(page.getByTestId('collection-entry').first()).toBeVisible()

  await clear.click()
  await expect(page.getByTestId('collection-empty')).toBeVisible({ timeout: 10_000 })
  const listing = await (await fetch(`${NATIVE_BACKEND}/api/history?scope=local&limit=10`)).json() as
    { records: unknown[] }
  expect(listing.records).toHaveLength(0)
})
