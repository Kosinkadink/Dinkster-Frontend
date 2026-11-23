/**
 * Interrupted durable-history records through the production Runs panel,
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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, mockProjectPacks, openRailPanel, selectProductOption, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

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
async function installFixture(page: Page, records: readonly unknown[] = [stampedRecord, unstampedRecord]): Promise<{ submitted(): Record<string, unknown> | undefined }> {
  let submitted: Record<string, unknown> | undefined
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: nativeTable }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/api/mounts*', (route) => route.fulfill({ json: { mounts: [] } }))
  await page.route('/api/library*', (route) => route.fulfill({ json: { records: [] } }))
  await page.route('/api/templates*', (route) => route.fulfill({ json: { templates: [] } }))
  // Durable history list: path is exactly /api/history (query carries scope).
  await page.route((url) => url.pathname === '/api/history', (route) =>
    route.fulfill({ json: { records } }))
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
  await waitForWorkspaceReady(page)
  await openRailPanel(page, 'Runs')
  await selectProductOption(page, page.getByTestId('runs-scope'), 'all')
}

const entryFor = (page: Page, jobId: string) =>
  page.getByTestId('runs-panel').getByTestId('collection-entry').filter({ hasText: jobId })

test('unseen stored image/video rows show thumbnails without loading jobs, absent and unavailable media show none', async ({ page }) => {
  const asset = (char: string, mediaType: string) => ({ digest: `blake3:${char.repeat(64)}`, name: '', size: 1, mediaType, virtualPath: '' })
  const image = asset('b', 'image/png'), video = asset('c', 'video/webm'), missing = asset('d', 'image/png')
  const records = [image, video, undefined, missing].map((thumbnail, index) => ({
    ...unstampedRecord, runId: `stored-${index}`, jobRef: `stored-${index}`, jobId: ['Image output', 'Video output', 'No media output', 'Unavailable image'][index],
    state: 'completed', executed: 1, finishedAt: 1_755_345_700 - index, ...(thumbnail === undefined ? {} : { thumbnail }),
  }))
  await mockProjectPacks(page)
  await installFixture(page, records)
  await page.route('/api/models/downloads*', (route) => route.fulfill({ json: { instance: 'thumbnail-fixture', jobs: [] } }))
  await page.route((url) => url.pathname === `/api/assets/${encodeURIComponent(image.digest)}`, (route) =>
    route.fulfill({ path: join(import.meta.dirname, '../fixtures/media-overlay/with_metadata.png'), contentType: 'image/png' }))
  await page.route((url) => url.pathname === `/api/assets/${encodeURIComponent(video.digest)}`, (route) =>
    route.fulfill({ path: join(import.meta.dirname, '../fixtures/media-overlay/visible-2s.webm'), contentType: 'video/webm' }))
  let missingRequests = 0
  await page.route((url) => url.pathname === `/api/assets/${encodeURIComponent(missing.digest)}`, (route) => {
    missingRequests++
    return route.fulfill({ status: 404 })
  })
  const hydrated: string[] = []
  await page.route((url) => /^\/api\/(history\/stored-|jobs\/)/.test(url.pathname), (route) => {
    hydrated.push(route.request().url())
    return route.fulfill({ status: 404 })
  })
  await bootAndOpenRuns(page)
  const panel = page.getByTestId('runs-panel')
  const row = (label: string) => panel.getByTestId('collection-entry').filter({ hasText: label })
  await expect(row('Image output').locator('img.run-thumbnail')).toHaveAttribute('data-ready', 'true')
  await expect(row('Video output').locator('video.run-thumbnail')).toHaveAttribute('data-ready', 'true')
  expect(await row('Image output').locator('img').evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  expect(await row('Video output').locator('video').evaluate((element) => (element as HTMLVideoElement).paused)).toBe(true)
  await expect.poll(() => missingRequests).toBe(1)
  await expect(row('Unavailable image').getByTestId('run-thumbnail')).toHaveCount(0)
  await expect(row('No media output').getByTestId('run-thumbnail')).toHaveCount(0)
  expect(hydrated).toEqual([])
  expect(await page.evaluate(() => window.__dinksterTest!.app.store.executions.get().size)).toBe(0)
  const proof = process.env['DINKSTER_THUMBNAIL_PROOF_DIR']
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect(row('Image output').getByTestId('run-thumbnail')).toBeVisible()
    await expect(row('Video output').getByTestId('run-thumbnail')).toBeVisible()
    if (proof) {
      mkdirSync(proof, { recursive: true })
      await page.mouse.move(10, 10)
      await page.screenshot({ path: join(proof, `stored-thumbnails-${width}.png`), animations: 'disabled' })
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await row('Image output').click()
  await expect(row('Image output').getByTestId('collection-action').filter({ hasText: 'Delete record' })).toBeVisible()
  await expect.poll(() => hydrated.length).toBe(1)
  await expect(row('Image output').getByTestId('run-thumbnail')).toBeVisible()

  await page.evaluate(async ({ doc, image, video }) => {
    const app = window.__dinksterTest!.app
    await app.openDocument(doc, 'Retained outputs')
    const tab = app.activeTab()!, compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('Thumbnail workflow did not compile')
    const store = app.store as unknown as Pick<import('@dinkster/client').ExecutionStore, 'hydrateArtifacts'>
    for (const [index, asset] of [image, video, undefined].entries()) {
      const ref = { connection: compiled.artifact.connection, prompt: `thumbnail-live-${index}` }
      app.registerRun(tab, ref, compiled.artifact)
      store.hydrateArtifacts(ref as never, asset === undefined ? [] : [{ ...asset, nodeId: 'sink' }])
      app.store.apply({ kind: 'completed', execution: ref, timestamp: index + 10 })
    }
  }, { doc: producingDoc, image, video })
  await selectProductOption(page, page.getByTestId('runs-scope'), 'workflow')
  const live = page.getByTestId('execution-row')
  await expect(live).toHaveCount(3)
  await expect(live.locator('.runs-row-heading img.run-thumbnail')).toHaveAttribute('data-ready', 'true')
  await expect(live.locator('.runs-row-heading video.run-thumbnail')).toHaveAttribute('data-ready', 'true')
  await expect(live.locator('.runs-row-heading .execution-open')).toHaveCount(3)
  if (proof) await page.screenshot({ path: join(proof, 'workflow-thumbnails-1440.png'), animations: 'disabled' })
  await live.filter({ has: page.locator('video.run-thumbnail') }).locator('.execution-open').click()
  await expect(page.getByTestId('frozen-banner')).toBeVisible()

  await page.route('**/thumbnail-owner/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api/nodes')) return route.fulfill({ json: nativeTable })
    if (path.endsWith('/api/history')) return route.fulfill({ json: { records } })
    if (path.endsWith(`/api/assets/${encodeURIComponent(image.digest)}`)) return route.fulfill({
      path: join(import.meta.dirname, '../fixtures/media-overlay/with_metadata.png'), contentType: 'image/png',
    })
    if (path.endsWith(`/api/assets/${encodeURIComponent(video.digest)}`)) return route.fulfill({
      path: join(import.meta.dirname, '../fixtures/media-overlay/visible-2s.webm'), contentType: 'video/webm',
    })
    return route.fulfill({ status: 404 })
  })
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const owner = app.addBackend('/thumbnail-owner', 'Thumbnail owner', false, 'dinkster')!
    const tab = app.createWorkflow()
    app.setTabTarget(tab.id, owner.id)
  })
  await selectProductOption(page, page.getByTestId('runs-scope'), 'all')
  await expect(row('Image output').locator('img.run-thumbnail')).toHaveAttribute('src', /\/thumbnail-owner\/api\/assets\//)
  await expect(row('Image output').locator('img.run-thumbnail')).toHaveAttribute('data-ready', 'true')
  await expect(row('Video output').locator('video.run-thumbnail')).toHaveAttribute('src', /\/thumbnail-owner\/api\/assets\//)
  await expect(row('Video output').locator('video.run-thumbnail')).toHaveAttribute('data-ready', 'true')
  if (proof) await page.screenshot({ path: join(proof, 'owning-backend-thumbnails-1440.png'), animations: 'disabled' })
})

test('Resubmit reopens the producing document and queues a FRESH submission', async ({ page }) => {
  const fixture = await installFixture(page)
  await bootAndOpenRuns(page)

  const stamped = entryFor(page, INTERRUPTED_JOB_ID)
  await stamped.click()
  await stamped.locator('[data-testid=collection-action][data-action=resubmit]').click()

  // Runs stays available while the producing document opens in the active tab.
  await expect(page.getByTestId('runs-panel')).toBeVisible()
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
