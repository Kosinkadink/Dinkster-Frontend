import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { executionDetails, expect, mockProjectPacks, nativeTest as test, waitForWorkspaceReady, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_LOOP_UI_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

async function mockBackend(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'loop-proof', schemaWire: 2 }, nodes: {},
  } }))
  await page.route('**/api/assets/*', async (route) => {
    const digest = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    const filename = digest === `blake3:${'a'.repeat(64)}` ? 'item-1.png'
      : digest === `blake3:${'b'.repeat(64)}` ? 'item-2.png' : 'nested-item.png'
    const color = filename === 'item-1.png' ? '#2563eb' : '#9333ea'
    const png = await page.evaluate(({ color, filename }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 960
      canvas.height = 640
      const context = canvas.getContext('2d')!
      context.fillStyle = color
      context.fillRect(0, 0, 960, 640)
      context.fillStyle = 'white'
      context.font = '72px sans-serif'
      context.fillText(filename, 40, 330)
      return canvas.toDataURL('image/png').split(',')[1]!
    }, { color, filename })
    return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') })
  })
}

async function installLoopExecution(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([{
      type: 'LoopOutputProof', displayName: 'Loop output', category: 'proof', source: 'v3', isOutputNode: true,
      body: [{ kind: 'output', id: 'images', type: { kind: 'asset', element: { kind: 'concrete', name: 'IMAGE' } } }],
    }])
    await bridge.app.openDocument({
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
    const imageAsset = (name: string, char: string) => ({
      typeId: 'asset<IMAGE>', fingerprint: `blake3:${char.repeat(64)}`,
      meta: { digest: `blake3:${char.repeat(64)}`, name, mediaType: 'image/png' },
    })
    for (const [iteration, filename] of ['item-1.png', 'item-2.png'].entries()) {
      store.apply({
        kind: 'nodeOutput', execution: ref, timestamp: now + 6 + iteration,
        runtimeNodeId: `mapImages[${iteration}]/output`, output: { images: imageAsset(filename, 'ab'[iteration]!) },
      })
    }
    store.apply({
      kind: 'nodeOutput', execution: ref, timestamp: now + 8,
      runtimeNodeId: 'mapImages[0]/nested[2]/output', output: { images: imageAsset('nested-item.png', 'c') },
    })
  })
}

test('loop progress and outputs render per item', async ({ page }) => {
  await mockBackend(page)
  await mockProjectPacks(page)
  await page.route('/api/workflows/plan', (route) => route.fulfill({ json: { packs: [], assets: [], errors: [] } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app !== undefined)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await waitForWorkspaceReady(page)
  await installLoopExecution(page)
  await executionDetails(page.getByTestId('execution-row').first())

  const progress = page.getByLabel('Loop iteration progress')
  await expect(progress).toContainText('map mapImages - item 1completed')
  await expect(progress).toContainText('map mapImages - item 2running')
  await expect(progress).toContainText('map mapImages - item 3waiting')
  if (proofDir !== undefined) {
    await page.screenshot({ path: join(proofDir, 'loop-queue-progress.png'), animations: 'disabled', fullPage: true })
  }

  await page.getByRole('tab', { name: 'Runs', exact: true }).click()
  const outputs = page.getByTestId('runs-panel')
  await expect(
    outputs.getByRole('region', { name: 'mapImages - item 1', exact: true }).locator('.output-thumbnail'),
  ).toHaveAccessibleName(/item-1.png/)
  await expect(
    outputs.getByRole('region', { name: 'mapImages - item 2', exact: true }).locator('.output-thumbnail'),
  ).toHaveAccessibleName(/item-2.png/)
  await expect(
    outputs.getByRole('region', { name: 'mapImages - item 1 / nested - item 3', exact: true }).locator('.output-thumbnail'),
  ).toHaveAccessibleName(/nested-item.png/)
  await expect(outputs.locator('.output-thumbnail')).toHaveCount(3)
  await expect(outputs.locator('.output-thumbnail img')).toHaveCount(3)
  for (const image of await outputs.locator('.output-thumbnail img').all()) {
    await expect(image).toHaveJSProperty('naturalWidth', 960)
  }
  if (proofDir !== undefined) {
    await page.setViewportSize({ width: 1440, height: 1600 })
    await page.screenshot({ path: join(proofDir, 'loop-grouped-outputs.png'), animations: 'disabled', fullPage: true })
  }
})
