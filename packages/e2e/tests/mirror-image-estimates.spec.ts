import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures.js'

/**
 * In-app image estimates from glsl mirrors: a node whose schema declares a
 * glsl mirror (the REAL wire-29 dinkster.image.adjust serialization) and whose
 * single image input is fed by a node showing its executed output image
 * paints a GPU-computed estimate preview, gated by execution.mirrorPreviews.
 * The executed output carries exact output attribution; imagery without it
 * (such as a selected input asset) never feeds an estimate.
 */

const adjustWire = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/image_adjust_wire29.json', import.meta.url)), 'utf8'),
) as Record<string, unknown>

// 2x2 RGB PNG: red, green / blue, white. Inverting gives cyan, magenta /
// yellow, black - four unambiguous, exactly representable 8-bit colors.
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

test('glsl mirrors paint GPU image estimates gated by execution.mirrorPreviews', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: sourcePng }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'mirror-image-estimates-proof', schemaWire: 1 },
    nodes: {
      'e2e.image.source': imageSourceNode,
      'dinkster.image.adjust': adjustWire,
    },
  } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(2)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'mirror-image-estimates-proof',
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
            adjust: { id: 'adjust', type: 'dinkster.image.adjust', values: { operation: 'invert' } },
          },
          links: {
            l1: { id: 'l1', from: { node: 'src', port: 'image' }, to: { node: 'adjust', port: 'image' } },
          },
          nets: {},
          reroutes: {},
          valueSources: {},
          nextOrdinal: 10,
        },
      },
      view: { graphs: { g0: {
        nodes: { src: { position: { x: 80, y: 140 } }, adjust: { position: { x: 480, y: 140 } } },
      } } },
    } as never, 'Mirror image estimates')
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

  // Before any execution, the source panel shows only its selected input
  // asset, which carries no output attribution: the mirror must abstain.
  await expect.poll(() => previewOf('src')).toEqual({ state: null, width: 2, height: 2 })
  expect(await previewOf('adjust')).toBeUndefined()

  // A completed run records the source's output image (an asset ref under
  // the exact output id the adjust input is wired to); the estimate then
  // derives from that attributed executed imagery.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'mirror-image-run-1' }
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

  // The source's executed output decodes into its preview panel; the adjust
  // node has never executed, so the estimate is its only preview source.
  await expect.poll(() => previewOf('src')).toEqual({ state: null, width: 2, height: 2 })
  await expect.poll(() => previewOf('adjust')).toEqual({ state: 'estimate', width: 2, height: 2 })

  // The estimate's pixels are the shader's output: 8-bit inversion of the
  // source is exact, so every texel must match its complement.
  expect(await page.evaluate(async () => {
    const preview = (window.__dinksterTest!.renderer as unknown as {
      getNodePreviews(): Record<string, { image?: CanvasImageSource }>
    }).getNodePreviews()['adjust']
    const canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2
    const context = canvas.getContext('2d')!
    context.drawImage(preview!.image as ImageBitmap, 0, 0)
    return [...context.getImageData(0, 0, 2, 2).data]
  })).toEqual([
    0, 255, 255, 255, /**/ 255, 0, 255, 255,
    255, 255, 0, 255, /**/ 0, 0, 0, 255,
  ])
  await page.screenshot({ path: testInfo.outputPath('image-estimate-on.png'), animations: 'disabled' })

  // The execution.mirrorPreviews setting gates the whole derivation.
  await page.evaluate(() => {
    (window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, value: unknown): void }
    }).settings.set('execution.mirrorPreviews', false)
  })
  await expect.poll(() => previewOf('adjust')).toBeUndefined()
  await expect.poll(() => previewOf('src')).toEqual({ state: null, width: 2, height: 2 })
  await page.screenshot({ path: testInfo.outputPath('image-estimate-off.png'), animations: 'disabled' })

  expect(pageErrors).toEqual([])
})
