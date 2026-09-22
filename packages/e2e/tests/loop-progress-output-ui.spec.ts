import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'

const proofDir = process.env['DINKSTER_LOOP_UI_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

async function mockBackend(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'loop-proof', schemaWire: 1 }, nodes: {},
  } }))
  await page.route(/\/view(?:\?|$)/, (route) => {
    const filename = new URL(route.request().url()).searchParams.get('filename') ?? 'unknown.png'
    const color = filename === 'item-1.png' ? '#2563eb' : '#9333ea'
    void route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="640"><rect width="960" height="640" fill="${color}"/><text x="480" y="330" text-anchor="middle" fill="white" font-size="72">${filename}</text></svg>`,
    })
  })
}

async function installLoopExecution(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([{
      type: 'LoopOutputProof', displayName: 'Loop output', category: 'proof', source: 'v3', isOutputNode: true,
      items: [{ kind: 'output', id: 'images', type: { kind: 'concrete', name: 'comfy.IMAGE' } }],
    }])
    bridge.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'loop-progress-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: { output: { id: 'output', type: 'LoopOutputProof', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: { output: { position: { x: 150, y: 100 }, size: { width: 420, height: 280 } } } } } },
    } as never, 'Loop progress proof')
    const compiled = bridge.app.compileTab(bridge.app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'loop-progress-run' }
    type Store = { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    const store = bridge.app.store as unknown as Store
    const now = Date.now()
    store.register(ref, compiled.artifact, now)
    store.apply({ kind: 'started', execution: ref, timestamp: now + 1 })
    store.apply({
      kind: 'regionExpanded', execution: ref, timestamp: now + 2, runtimeNodeId: 'mapImages',
      regionKind: 'map', binding: 'zip', iterations: 3,
    })
    store.apply({
      kind: 'regionIteration', execution: ref, timestamp: now + 3,
      runtimeNodeId: 'mapImages', iteration: 0, state: 'running',
    })
    store.apply({
      kind: 'regionIteration', execution: ref, timestamp: now + 4,
      runtimeNodeId: 'mapImages', iteration: 0, state: 'completed',
    })
    store.apply({
      kind: 'regionIteration', execution: ref, timestamp: now + 5,
      runtimeNodeId: 'mapImages', iteration: 1, state: 'running',
    })
    for (const [iteration, filename] of ['item-1.png', 'item-2.png'].entries()) {
      store.apply({
        kind: 'nodeOutput', execution: ref, timestamp: now + 6 + iteration,
        runtimeNodeId: `mapImages[${iteration}]/output`, output: { images: [{ filename }] },
      })
    }
    store.apply({
      kind: 'nodeOutput', execution: ref, timestamp: now + 8,
      runtimeNodeId: 'mapImages[0]/nested[2]/output', output: { images: [{ filename: 'nested-item.png' }] },
    })
  })
}

test('loop progress and outputs render per item', async ({ page }) => {
  await mockBackend(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await installLoopExecution(page)

  const progress = page.getByLabel('Loop iteration progress')
  await expect(progress).toContainText('map mapImages - item 1completed')
  await expect(progress).toContainText('map mapImages - item 2running')
  await expect(progress).toContainText('map mapImages - item 3waiting')
  if (proofDir !== undefined) {
    await page.screenshot({ path: join(proofDir, 'loop-queue-progress.png'), animations: 'disabled', fullPage: true })
  }

  await page.getByRole('tab', { name: 'Outputs' }).click()
  const outputs = page.getByTestId('outputs-panel')
  await expect(
    outputs.getByRole('region', { name: 'mapImages - item 1', exact: true }),
  ).toContainText('item-1.png')
  await expect(
    outputs.getByRole('region', { name: 'mapImages - item 2', exact: true }),
  ).toContainText('item-2.png')
  await expect(
    outputs.getByRole('region', { name: 'mapImages - item 1 / nested - item 3', exact: true }),
  ).toContainText('nested-item.png')
  await expect(outputs.locator('.output-thumbnail')).toHaveCount(3)
  if (proofDir !== undefined) {
    await page.setViewportSize({ width: 1440, height: 1600 })
    await page.screenshot({ path: join(proofDir, 'loop-grouped-outputs.png'), animations: 'disabled', fullPage: true })
  }
})
