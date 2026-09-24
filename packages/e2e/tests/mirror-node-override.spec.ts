import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, test } from './fixtures.js'

/**
 * Per-node mirror-estimate override: the node context menu's "Mirror
 * Estimates" submenu (Inherit/On/Off) writes the display-only mirrorPreviews
 * node field, whose value wins over the global execution.mirrorPreviews
 * setting for that node. The submenu exists only on mirror-capable node
 * types.
 */

const adjustWire = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../core/test/fixtures/image_adjust_wire29.json', import.meta.url)), 'utf8'),
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

test('the node context menu overrides mirror estimates per node', async ({ page }, testInfo) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('**/api/assets/*', (route) => route.fulfill({ contentType: 'image/png', body: sourcePng }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'mirror-node-override-proof', schemaWire: 1 },
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
      lineage: 'mirror-node-override-proof',
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
    } as never, 'Mirror node override')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const previewOf = (nodeId: string) => page.evaluate((id) => {
    const preview = window.__dinksterTest!.renderer!.getNodePreviews()[id]
    return preview === undefined ? undefined : { state: preview.state ?? null }
  }, nodeId)
  const overrideOf = () => page.evaluate(() =>
    (window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes['adjust'] as {
      mirrorPreviews?: boolean
    }).mirrorPreviews ?? null)
  const headerPoint = (nodeId: string) => page.evaluate((id) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === id)
    if (!node) throw new Error(`no scene node '${id}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
  const menuItem = (id: string) => page.locator(`[data-item-id="${id}"]`)
  const openOverrideMenu = async (nodeId: string) => {
    const point = await headerPoint(nodeId)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    await expect(page.getByTestId('context-menu')).toBeVisible()
    await menuItem('core.node.mirrorPreviews').hover()
    await expect(page.getByTestId('context-submenu').last()).toBeVisible()
  }

  // Record the source's executed output so the adjust estimate derives.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'mirror-override-run-1' }
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
  await expect.poll(() => previewOf('adjust')).toEqual({ state: 'estimate' })

  // The submenu shows the inherited state checked; Off wins over the
  // global default-on setting for this node only.
  await openOverrideMenu('adjust')
  await expect(menuItem('core.node.mirrorPreviews.inherit')).toHaveClass(/checked/)
  await page.screenshot({ path: testInfo.outputPath('mirror-override-menu.png'), animations: 'disabled' })
  await menuItem('core.node.mirrorPreviews.off').click()
  await expect(page.getByTestId('context-menu')).not.toBeVisible()
  expect(await overrideOf()).toBe(false)
  await expect.poll(() => previewOf('adjust')).toBeUndefined()
  await expect.poll(() => previewOf('src')).toEqual({ state: null })
  await page.screenshot({ path: testInfo.outputPath('mirror-override-off.png'), animations: 'disabled' })

  // Reopening shows Off checked; the override survives the menu round trip.
  await openOverrideMenu('adjust')
  await expect(menuItem('core.node.mirrorPreviews.off')).toHaveClass(/checked/)
  await page.keyboard.press('Escape')

  // On wins over a globally disabled setting.
  await page.evaluate(() => {
    (window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, value: unknown): void }
    }).settings.set('execution.mirrorPreviews', false)
  })
  await openOverrideMenu('adjust')
  await menuItem('core.node.mirrorPreviews.on').click()
  expect(await overrideOf()).toBe(true)
  await expect.poll(() => previewOf('adjust')).toEqual({ state: 'estimate' })
  await page.screenshot({ path: testInfo.outputPath('mirror-override-on-global-off.png'), animations: 'disabled' })

  // One undo step per menu action.
  await page.keyboard.press('Control+z')
  expect(await overrideOf()).toBe(false)

  // A node without an evaluable mirror never offers the submenu.
  const srcPoint = await headerPoint('src')
  await page.mouse.click(srcPoint.x, srcPoint.y, { button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await expect(menuItem('core.node.mirrorPreviews')).toHaveCount(0)

  expect(pageErrors).toEqual([])
})
