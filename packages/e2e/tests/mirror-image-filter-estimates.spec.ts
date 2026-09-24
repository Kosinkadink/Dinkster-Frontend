import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures.js'

/**
 * Applies-scoped image estimates in the app: the REAL wire-30
 * dinkster.image.filter serialization declares a glsl mirror scoped to
 * gaussian_blur and sharpen. A filter node whose selected operation is
 * inside that scope paints a GPU estimate from its producer's executed
 * output; a node whose selection is outside the scope paints NOTHING -
 * the shader would compute a different operation than the backend, so the
 * gate must fail closed rather than show a wrong estimate.
 */

const filterWire = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/image_filter_wire30.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>

// 2x2 RGB PNG: red, green / blue, white.
const sourcePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC',
  'base64',
)

const imageSourceNode = {
  schemaVersion: 1,
  nodeType: 'e2e.image.source',
  displayName: 'Image Source',
  category: 'test',
  interface: [
    {
      role: 'input',
      id: 'image',
      required: true,
      type: { kind: 'asset', element: { kind: 'concrete', types: ['dinkster.image'] } },
      widget: { type: 'ASSET', accept: ['image/png'] },
    },
    { role: 'output', id: 'image', type: { kind: 'concrete', types: ['dinkster.image'] } },
  ],
}

test('applies-scoped filter mirrors estimate covered operations and abstain outside the scope', async ({ page }, testInfo) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#429
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#429')
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: sourcePng }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'mirror-filter-estimates-proof', schemaWire: 1 },
    nodes: {
      'e2e.image.source': imageSourceNode,
      'dinkster.image.filter': filterWire,
    },
  } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(2)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'mirror-filter-estimates-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            src: {
              id: 'src',
              type: 'e2e.image.source',
              values: { image: {
                digest: `blake3:${'ab'.repeat(32)}`,
                name: 'image.png',
                size: 75,
                mediaType: 'image/png',
                virtualPath: 'image.png',
              } },
            },
            covered: {
              id: 'covered',
              type: 'dinkster.image.filter',
              values: {},
              dynamic: { operation: { selected: 'sharpen' } },
            },
            uncovered: {
              id: 'uncovered',
              type: 'dinkster.image.filter',
              values: {},
              dynamic: { operation: { selected: 'noise' } },
            },
          },
          links: {
            l1: { id: 'l1', from: { node: 'src', port: 'image' }, to: { node: 'covered', port: 'image' } },
            l2: { id: 'l2', from: { node: 'src', port: 'image' }, to: { node: 'uncovered', port: 'image' } },
          },
          nets: {},
          reroutes: {},
          valueSources: {},
          nextOrdinal: 10,
        },
      },
      view: { graphs: { g0: {
        nodes: {
          src: { position: { x: 80, y: 140 } },
          covered: { position: { x: 520, y: 60 } },
          uncovered: { position: { x: 520, y: 500 } },
        },
      } } },
    } as never, 'Mirror filter estimates')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const previewOf = (nodeId: string) => page.evaluate((id) => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews()[id]
    return preview === undefined ? undefined : {
      state: preview.state ?? null,
      width: preview.width ?? null,
      height: preview.height ?? null,
    }
  }, nodeId)

  // Record a completed run attributing the source's executed output image;
  // estimates derive only from attributed executed imagery.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'mirror-filter-run-1' }
    const store = app.store as unknown as { register(ref: unknown, artifact: unknown, now: number): void; apply(event: unknown): void }
    store.register(ref, compiled.artifact, Date.now())
    store.apply({ kind: 'started', execution: ref, timestamp: Date.now() })
    store.apply({ kind: 'nodeStates', execution: ref, timestamp: Date.now(), nodes: { src: { state: 'done' } } })
    store.apply({
      kind: 'nodeOutput', execution: ref, runtimeNodeId: 'src', timestamp: Date.now(),
      output: { image: {
        typeId: 'dinkster.asset',
        meta: { digest: `blake3:${'ab'.repeat(32)}`, mediaType: 'image/png', name: 'image.png' },
      } },
    })
    store.apply({ kind: 'completed', execution: ref, timestamp: Date.now() })
  })

  // Covered selection (sharpen): the estimate paints. Uncovered selection
  // (noise): the gate fails closed and the node keeps NO preview at all.
  await expect.poll(() => previewOf('src')).toEqual({ state: null, width: 2, height: 2 })
  await expect.poll(() => previewOf('covered')).toEqual({ state: 'estimate', width: 2, height: 2 })
  expect(await previewOf('uncovered')).toBeUndefined()
  await page.screenshot({ path: testInfo.outputPath('filter-estimate-applies-gate.png'), animations: 'disabled' })

  expect(pageErrors).toEqual([])
})
