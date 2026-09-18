import { mkdirSync } from 'node:fs'
import { expect, selectProductOption, test, type Page } from './fixtures.js'

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxW8WQAAAABJRU5ErkJggg==', 'base64')
const proofDir = '/tmp/preview-retention-whole-run'

async function openDoc(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    const widget = (id: string, widgetType: string, defaultValue: unknown, options: Record<string, unknown> = {}) => ({
      kind: 'input', id, type: { kind: 'concrete', name: widgetType }, optional: false,
      widget: { widgetType, options, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([{
      type: 'PreviewRetentionTest', displayName: 'Image Result', category: 'test', source: 'v3', isOutputNode: false,
      items: [widget('count', 'INT', 5, { min: 0, max: 100, step: 1 })],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'preview-retention', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          widgets: { id: 'widgets', type: 'PreviewRetentionTest', values: {} },
          other: { id: 'other', type: 'PreviewRetentionTest', values: {} },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      } },
      view: { graphs: { g0: { nodes: {
        widgets: { position: { x: 100, y: 80 }, size: { width: 460, height: 420 } },
        other: { position: { x: 700, y: 80 } },
      } } } },
    }, 'Preview Retention')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.tabs.get().find((candidate) => candidate.id === 'preview-retention')
    return tab !== undefined && 'status' in tab.store
  })
}

/** Complete execution A: widgets done with a digest image output (and optionally a preview frame only). */
async function completeRunA(page: Page, withOutput: boolean): Promise<void> {
  await page.evaluate(async ({ withOutput }) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('compile A failed')
    const ref = { connection: compiled.artifact.connection, prompt: 'preview-retention-a' }
    const store = app.store as never as {
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: { widgets: { state: 'running' } },
    })
    // A live preview frame for widgets, always present.
    const canvas = new OffscreenCanvas(240, 135)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#0f766e'
    context.fillRect(0, 0, 240, 135)
    const payload = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    store.apply({
      kind: 'preview', execution: ref, timestamp: Date.now(),
      runtimeNodeId: 'widgets', channel: 'image/png', payload,
    })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now(),
      nodes: { widgets: { state: 'done' }, other: { state: 'done' } },
    })
    if (withOutput) {
      const digest = `blake3:${'a'.repeat(64)}`
      store.apply({
        kind: 'nodeOutput', execution: ref, runtimeNodeId: 'widgets', timestamp: Date.now(),
        output: { image: { typeId: 'dinkster.asset', meta: { digest, mediaType: 'image/png', name: 'result.png' } } },
      })
    }
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
  }, { withOutput })
}

/** Register partial execution B targeting only `other`; optionally complete it. */
async function startPartialB(page: Page, complete: boolean): Promise<void> {
  await page.evaluate(({ complete }) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('compile B failed')
    const artifact = compiled.artifact as never as { connection: string; prompt: Record<string, unknown> }
    const ref = { connection: artifact.connection, prompt: 'preview-retention-b' }
    const partial = {
      ...compiled.artifact,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: 'other' }] },
      prompt: { other: artifact.prompt.other },
      partialTargets: ['other'],
    }
    const store = app.store as never as {
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, partial, Date.now() + 100)
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() + 101 })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: Date.now() + 102,
      nodes: { other: { state: 'running' } },
    })
    if (complete) {
      store.apply({
        kind: 'nodeStates', execution: ref, timestamp: Date.now() + 103,
        nodes: { other: { state: 'done' } },
      })
      store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() + 104 })
    }
  }, { complete })
}

/** Register whole-run execution B (full scope, no node has reported yet). */
async function startWholeB(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('compile whole B failed')
    const ref = { connection: compiled.artifact.connection, prompt: 'preview-retention-whole-b' }
    const store = app.store as never as {
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    store.register(ref, compiled.artifact, Date.now() + 100)
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() + 101 })
  })
}

const widgetsPreview = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getNodePreviews()['widgets'] !== undefined)

test.beforeEach(async ({ page }) => {
  // Self-contained: every schema this spec uses comes from registerSchemas,
  // so the v1 catalog can be empty and no live backend is required.
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: pixel }))
  await openDoc(page)
})

test('canvas: executed image survives while a disjoint partial run is RUNNING', async ({ page }) => {
  await completeRunA(page, true)
  await expect.poll(() => widgetsPreview(page)).toBe(true)

  await startPartialB(page, false)
  // User symptom: while B runs, does the widgets preview from run A stay?
  await page.waitForTimeout(500)
  expect(await widgetsPreview(page), 'preview from run A should remain visible while partial B runs').toBe(true)
})

test('canvas: executed image returns after the disjoint partial run COMPLETES', async ({ page }) => {
  await completeRunA(page, true)
  await expect.poll(() => widgetsPreview(page)).toBe(true)

  await startPartialB(page, true)
  await expect.poll(() => widgetsPreview(page), { timeout: 5_000 }).toBe(true)
})

test('canvas: executed image survives while a WHOLE run is queued and has not re-reported the node', async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  await completeRunA(page, true)
  await expect.poll(() => widgetsPreview(page)).toBe(true)
  await page.screenshot({ path: `${proofDir}/1-completed-run-a.png` })

  await startWholeB(page)
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${proofDir}/2-whole-run-b-in-flight.png` })
  expect(await widgetsPreview(page), 'preview from run A should remain visible while whole run B is in flight').toBe(true)
})

test('history: entry admitted from mid-run chatter is labeled unconfirmed', async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  // A preview frame for a run this client never submitted and never saw
  // start: the store admits it only as an unconfirmed entry.
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const compiled = app.compileTab(tab)
    if (!compiled?.ok) throw new Error('compile failed')
    const ref = { connection: compiled.artifact.connection, prompt: 'preview-retention-phantom' }
    const canvas = new OffscreenCanvas(240, 135)
    const context = canvas.getContext('2d')!
    context.fillStyle = '#7c2d12'
    context.fillRect(0, 0, 240, 135)
    const payload = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
    const store = app.store as never as { apply(event: unknown): void }
    store.apply({
      kind: 'preview', execution: ref, timestamp: Date.now(),
      runtimeNodeId: 'widgets', channel: 'image/png', payload,
    })
  })
  await page.getByTestId('library-toggle').click()
  const library = page.getByTestId('library-overlay')
  await expect(library).toBeVisible()
  const sourceTab = library.locator('[data-testid=collection-source][data-source=history]')
  if (await sourceTab.isVisible()) await sourceTab.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), 'history')
  const entry = page.getByTestId('collection-entry')
  await expect(entry).toHaveCount(1)
  await expect(entry.locator('.collection-badges')).toContainText('unconfirmed')
  await expect(entry.locator('.collection-badges')).not.toContainText('queued')
  await page.screenshot({ path: `${proofDir}/3-history-unconfirmed-row.png` })
})

test('canvas: preview-frame-only node (no digest output) after partial completes', async ({ page }) => {
  await completeRunA(page, false)
  await expect.poll(() => widgetsPreview(page)).toBe(true)

  await startPartialB(page, true)
  await page.waitForTimeout(500)
  expect(await widgetsPreview(page), 'preview-frame-only source from run A after partial B completes').toBe(true)
})
