import { mkdirSync } from 'node:fs'
import { expect, test } from './fixtures.js'

const proofDir = '/tmp/app-view-queue-buttons'

const nativeTable = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'app-view-queue-buttons', schemaWire: 44 },
  packs: { test: { displayName: 'Test' } },
  nodes: {
    'test.PartialOutput': {
      schemaVersion: 44,
      nodeType: 'test.PartialOutput',
      displayName: 'Partial output',
      category: 'test',
      interface: [],
      isOutputNode: true,
      signature: 'app-view-partial-output',
    },
  },
}

test('authors multiple partial queue buttons, persists them, and reports execution state', async ({ page }) => {
  mkdirSync(proofDir, { recursive: true })
  const submissions: Record<string, unknown>[] = []
  let holdNextSubmission = false
  let releaseSubmission: (() => void) | undefined
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: nativeTable }))
  await page.route('/api/assets', (route) => route.fulfill({ status: 200, json: { digest: `blake3:${'d'.repeat(64)}` } }))
  await page.route('/api/jobs', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    submissions.push(body)
    if (holdNextSubmission) {
      holdNextSubmission = false
      await new Promise<void>((resolve) => { releaseSubmission = resolve })
    }
    await route.fulfill({ status: 202, json: { clientId: body['clientId'], jobId: body['jobId'], state: 'queued' } })
  })

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('test.PartialOutput') ?? false,
  )).toBe(true)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'app-view-queue-buttons', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Workflow', links: {}, nets: {}, reroutes: {}, nextOrdinal: 4,
          nodes: {
            baseA: { id: 'baseA', type: '#base', title: 'First base stage', values: {} },
            baseB: { id: 'baseB', type: '#base', title: 'Second base stage', values: {} },
            upscale: { id: 'upscale', type: 'test.PartialOutput', title: 'Upscale result', values: {} },
          },
        },
        base: {
          id: 'base', name: 'Base definition', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { result: { id: 'result', type: 'test.PartialOutput', title: 'Base result', values: {} } },
          boundary: { inputs: [], outputs: [] },
        },
      },
      view: { graphs: { root: { nodes: {} }, base: { nodes: {} } } },
    }, 'Partial queue buttons')
  })
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()

  await expect(page.getByTestId('app-view-queue')).toBeVisible()
  await page.screenshot({ path: `${proofDir}/01-full-run-fallback.png`, animations: 'disabled' })
  await page.getByTestId('app-view-arrange-toggle').click()
  await page.getByTestId('app-layout-add-queue').click()
  let queues = page.getByTestId('app-layout-queue')
  await queues.nth(0).getByTestId('app-layout-queue-label').fill('Upscale')
  await queues.nth(0).getByTestId('app-layout-queue-label').blur()

  await page.getByTestId('app-layout-add-queue').click()
  queues = page.getByTestId('app-layout-queue')
  const baseQueue = queues.nth(1)
  await baseQueue.getByText('Base result').click()
  await baseQueue.getByText('Upscale result').click()
  await baseQueue.getByTestId('app-layout-queue-label').fill('Generate base')
  await baseQueue.getByTestId('app-layout-queue-label').blur()
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const items = (tab.store.doc.ext?.['dinkster.appLayout'] as {
      desktop: { items: { id: string; kind: string }[] }
    }).desktop.items
    const firstQueue = items.find((item) => item.kind === 'queue')!
    const queue = items.find((item) => item.kind === 'queue' && item.id !== firstQueue.id)!
    tab.store.dispatch({
      command: 'app.layout.setQueue',
      params: { id: queue.id, targets: [{ graphId: 'base', nodeId: 'result' }, { graphId: 'missing', nodeId: 'gone' }] },
    })
  })
  await expect(page.getByTestId('app-view-queue')).toHaveCount(0)
  await expect(baseQueue.getByTestId('app-layout-queue-targets')).toContainText('Base definition')
  await expect(baseQueue.getByTestId('app-layout-queue-stale')).toHaveText('1 selected target is unavailable.')
  await page.screenshot({ path: `${proofDir}/02-arrange-target-picker.png`, animations: 'disabled' })

  const authored = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'])
  await page.getByTestId('app-view-arrange-toggle').click()
  await expect(page.getByTestId('app-layout-queue-button')).toHaveCount(2)
  await expect(page.getByRole('button', { name: 'Upscale' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Generate base' })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Generate base' })).toHaveAccessibleDescription('Ready')
  await page.screenshot({ path: `${proofDir}/03-multiple-queue-buttons.png`, animations: 'disabled' })

  await page.setViewportSize({ width: 600, height: 900 })
  await expect(page.getByTestId('app-view')).toHaveAttribute('data-app-breakpoint', 'mobile')
  await page.screenshot({ path: `${proofDir}/04-mobile-queue-buttons.png`, animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 720 })

  const compile = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      compileTab(tab: unknown, scope: unknown): unknown
    }
    return app.compileTab(app.activeTab(), {
      kind: 'partial',
      targets: [
        { instancePath: ['baseA'], node: 'result' },
        { instancePath: ['baseB'], node: 'result' },
      ],
    })
  })
  if (!(compile as { ok?: boolean } | undefined)?.ok) throw new Error(JSON.stringify(compile))
  holdNextSubmission = true
  await page.getByRole('button', { name: 'Generate base' }).click()
  await expect(baseQueue.getByTestId('app-layout-queue-state')).toHaveText('Submitting')
  await page.screenshot({ path: `${proofDir}/05-submitting-state.png`, animations: 'disabled' })
  releaseSubmission?.()
  await expect.poll(() => submissions.length).toBe(1)
  expect(submissions[0]?.['targets']).toEqual(['baseA.result', 'baseB.result'])
  await expect(baseQueue.getByTestId('app-layout-queue-state')).toHaveText('Queued')
  await page.screenshot({ path: `${proofDir}/06-queued-state.png`, animations: 'disabled' })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].at(-1)!
    ;(app.store as unknown as { apply(event: unknown): void }).apply({
      kind: 'started', execution: execution.ref, timestamp: Date.now(),
    })
  })
  await expect(baseQueue.getByTestId('app-layout-queue-state')).toHaveText('Running')
  await page.screenshot({ path: `${proofDir}/07-running-state.png`, animations: 'disabled' })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].at(-1)!
    ;(app.store as unknown as { apply(event: unknown): void }).apply({
      kind: 'completed', execution: execution.ref, timestamp: Date.now(),
    })
    ;(app as unknown as { flushPersistTabs(): void }).flushPersistTabs()
  })
  await expect(baseQueue.getByTestId('app-layout-queue-state')).toHaveText('Completed')
  await page.screenshot({ path: `${proofDir}/08-completed-state.png`, animations: 'disabled' })

  await page.getByRole('button', { name: 'Upscale' }).click()
  await expect.poll(() => submissions.length).toBe(2)
  const upscaleQueue = page.getByTestId('app-layout-queue').nth(0)
  await expect(upscaleQueue.getByTestId('app-layout-queue-state')).toHaveText('Queued')
  await expect(baseQueue.getByTestId('app-layout-queue-state')).toHaveText('Completed')
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const execution = [...app.store.executions.get().values()].find((candidate) => {
      const artifact = candidate.artifact as { scope?: { kind?: string; targets?: { node?: string }[] } } | undefined
      return artifact?.scope?.kind === 'partial' && artifact.scope.targets?.some((target) => target.node === 'upscale')
    })!
    ;(app.store as unknown as { apply(event: unknown): void }).apply({
      kind: 'started', execution: execution.ref, timestamp: Date.now(),
    })
    ;(app.store as unknown as { apply(event: unknown): void }).apply({
      kind: 'error', execution: execution.ref, timestamp: Date.now() + 1, runtimeNodeId: 'upscale',
      detail: { exceptionType: 'FixtureError', exceptionMessage: 'Upscale failed.', traceback: [] },
    })
  })
  await expect(upscaleQueue.getByTestId('app-layout-queue-state')).toHaveText('Failed')
  await page.screenshot({ path: `${proofDir}/09-failed-state.png`, animations: 'disabled' })

  await page.reload()
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.has('test.PartialOutput') ?? false,
  )).toBe(true)
  await page.getByTestId('views-switcher').click()
  await page.getByRole('menuitemradio', { name: 'App view' }).click()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.ext?.['dinkster.appLayout'])).toEqual(authored)
  await expect(page.getByTestId('app-layout-queue-button')).toHaveCount(2)
})
