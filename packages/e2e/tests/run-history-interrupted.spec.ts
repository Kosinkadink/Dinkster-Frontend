/**
 * Interrupted durable-history records through the production library panel,
 * against a fully route-stubbed page-origin backend (no live server):
 *
 * - restart-swept records (state 'interrupted', Dinkster #556) render with the
 *   sweep phase ('was running' / 'never started') as a badge and detail row;
 * - only a STAMPED interrupted record offers 'Resubmit'; an unstamped one
 *   (no sourceDocument) has nothing to resubmit and must not offer it;
 * - 'Resubmit' reopens the exact producing document and queues it through
 *   the normal compile/submit pipeline as a FRESH submission: the POST
 *   /api/jobs body carries a NEW job identity, never the interrupted one.
 *   Nothing auto-resumes, by contract.
 */
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const DIGEST = `blake3:${'a'.repeat(64)}`

const nativeTable = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'interrupted-history-e2e', schemaWire: 1 },
  packs: { test: { displayName: 'Test' } },
  nodes: {
    'test.ImageSource': {
      schemaVersion: 1,
      nodeType: 'test.ImageSource',
      displayName: 'Image Source',
      category: 'test',
      interface: [{ role: 'output', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } }],
      signature: 'image-source-e2e',
    },
    'test.ImageSink': {
      schemaVersion: 1,
      nodeType: 'test.ImageSink',
      displayName: 'Image Sink',
      category: 'test',
      outputNode: true,
      interface: [{ role: 'input', id: 'image', type: { kind: 'concrete', types: ['comfy.IMAGE'] } }],
      signature: 'image-sink-e2e',
    },
  },
}

/** The exact producing document the stamped record points at. */
const producingDoc = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'interrupted-resubmit-e2e',
  root: 'g0',
  meta: { title: 'Interrupted Producer' },
  graphs: {
    g0: {
      id: 'g0',
      name: 'root',
      nodes: {
        source: { id: 'source', type: 'test.ImageSource', values: {} },
        sink: { id: 'sink', type: 'test.ImageSink', values: {} },
      },
      links: {
        l1: { id: 'l1', from: { node: 'source', port: 'image' }, to: { node: 'sink', port: 'image' } },
      },
      nets: {},
      reroutes: {},
      nextOrdinal: 3,
    },
  },
  view: { graphs: { g0: { nodes: {
    source: { position: { x: 40, y: 120 } },
    sink: { position: { x: 320, y: 120 } },
  } } } },
}

const INTERRUPTED_JOB_ID = 'job-int-stamped-1'

/** Swept mid-execution; stamped, so resubmission is possible. */
const stampedRecord = {
  runId: 'run-int-stamped',
  jobRef: 'run-int-stamped',
  scope: 'local',
  clientId: 'client-e2e',
  jobId: INTERRUPTED_JOB_ID,
  state: 'interrupted',
  priority: 0,
  submittedAt: 1_755_345_600,
  startedAt: 1_755_345_650,
  finishedAt: 1_755_345_700,
  executed: 0,
  cached: 0,
  skipped: 0,
  sourceDocument: DIGEST,
  nodeReceipts: [],
  error: {
    kind: 'interrupted',
    phase: 'running',
    message: 'the server exited (while this job was running); it was not re-run - resubmit it to run it',
  },
}

/** Swept before it started AND unstamped: no producing document recorded. */
const unstampedRecord = {
  runId: 'run-int-queued',
  jobRef: 'run-int-queued',
  scope: 'local',
  clientId: 'client-e2e',
  jobId: 'job-int-queued-2',
  state: 'interrupted',
  priority: 0,
  submittedAt: 1_755_345_500,
  finishedAt: 1_755_345_700,
  executed: 0,
  cached: 0,
  skipped: 0,
  nodeReceipts: [],
  error: {
    kind: 'interrupted',
    phase: 'queued',
    message: 'the server exited (before this job started); it was not re-run - resubmit it to run it',
  },
}

/** Route-stub the page-origin backend: catalog, quiet library, history. */
async function installFixture(page: Page): Promise<{ submitted(): Record<string, unknown> | undefined }> {
  let submitted: Record<string, unknown> | undefined
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: nativeTable }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/library*', (route) => route.fulfill({ json: { records: [] } }))
  await page.route('/api/templates*', (route) => route.fulfill({ json: { templates: [] } }))
  // Durable history list: path is exactly /api/history (query carries scope).
  await page.route((url) => url.pathname === '/api/history', (route) =>
    route.fulfill({ json: { records: [stampedRecord, unstampedRecord] } }))
  await page.route((url) => url.pathname === `/api/history/${stampedRecord.runId}`, (route) =>
    route.fulfill({ json: stampedRecord }))
  // Content-addressed vault: GET serves the producing document's bytes;
  // POST (the resubmission's stamp upload) acknowledges the same digest.
  // The client percent-encodes the digest (blake3%3A...) in the asset path.
  await page.route((url) => url.pathname === `/api/assets/${encodeURIComponent(DIGEST)}`, (route) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(producingDoc) }))
  await page.route('/api/assets', async (route) => {
    if (route.request().method() === 'POST') await route.fulfill({ status: 201, json: { digest: DIGEST } })
    else await route.fulfill({ status: 404, json: { error: 'no library' } })
  })
  await page.route('/api/jobs', async (route) => {
    submitted = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
    await route.fulfill({
      status: 202,
      json: { clientId: submitted['clientId'], jobId: submitted['jobId'], state: 'queued' },
    })
  })
  return { submitted: () => submitted }
}

async function bootAndOpenRuns(page: Page): Promise<void> {
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('test.ImageSink') ?? false,
  )).toBe(true)
  await page.getByTestId('library-toggle').click()
  const library = page.getByTestId('library-overlay')
  await expect(library).toBeVisible()
  const runsTab = library.locator('[data-testid=collection-source][data-source=runs]')
  if (await runsTab.isVisible()) await runsTab.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), 'runs')
}

const entryFor = (page: Page, jobId: string) =>
  page.getByTestId('collection-entry').filter({ hasText: jobId })

test('interrupted records render the sweep phase; only stamped ones offer Resubmit', async ({ page }) => {
  await installFixture(page)
  await bootAndOpenRuns(page)

  const stamped = entryFor(page, INTERRUPTED_JOB_ID)
  await expect(stamped).toHaveCount(1)
  await expect(stamped).toContainText('Interrupted run')
  await expect(stamped.locator('.collection-badges')).toContainText('interrupted')
  await expect(stamped.locator('.collection-badges')).toContainText('was running')
  await expect(stamped.locator('.collection-badges')).toContainText('Source recorded')

  const unstamped = entryFor(page, unstampedRecord.jobId)
  await expect(unstamped).toHaveCount(1)
  await expect(unstamped.locator('.collection-badges')).toContainText('never started')
  await expect(unstamped.locator('.collection-badges')).toContainText('Source unavailable')

  // Selecting the stamped entry exposes the phase detail and the explicit
  // Resubmit action alongside Open workflow.
  await stamped.click()
  await expect(stamped.getByTestId('collection-details')).toContainText('was running')
  await expect(stamped.getByTestId('collection-details')).toContainText('it was not re-run')
  await expect(stamped.locator('[data-testid=collection-action][data-action=resubmit]')).toBeVisible()
  await expect(stamped.locator('[data-testid=collection-action][data-action=open]')).toBeVisible()

  // The unstamped record has no producing document: no Resubmit, no Open.
  await unstamped.click()
  await expect(unstamped.getByTestId('collection-details')).toContainText('none (unstamped submission)')
  await expect(unstamped.locator('[data-testid=collection-action][data-action=delete]')).toBeVisible()
  await expect(unstamped.locator('[data-testid=collection-action][data-action=resubmit]')).toHaveCount(0)
  await expect(unstamped.locator('[data-testid=collection-action][data-action=open]')).toHaveCount(0)
})

test('Resubmit reopens the producing document and queues a FRESH submission', async ({ page }) => {
  const fixture = await installFixture(page)
  await bootAndOpenRuns(page)

  const stamped = entryFor(page, INTERRUPTED_JOB_ID)
  await stamped.click()
  await stamped.locator('[data-testid=collection-action][data-action=resubmit]').click()

  // The producing document opened as the active tab and the panel closed.
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest?.app.activeTab()?.store.doc
    return doc?.graphs['g0']?.nodes['sink']?.type
  })).toBe('test.ImageSink')

  // The queue went through the normal pipeline with a NEW job identity.
  await expect.poll(() => fixture.submitted()).toBeDefined()
  const submitted = fixture.submitted()!
  expect(typeof submitted['jobId']).toBe('string')
  expect(submitted['jobId']).not.toBe(INTERRUPTED_JOB_ID)
  const graph = submitted['graph'] as { nodes?: Record<string, unknown> } | undefined
  expect(graph?.nodes?.['sink']).toMatchObject({ nodeType: 'test.ImageSink' })
})
