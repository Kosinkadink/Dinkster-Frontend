/**
 * Native Float (dinkster.float) Ctrl+Shift+V connected-paste matrix against the
 * standing :5199 dev server and the
 * real native :8765 backend catalog, driven through the user's exact
 * LAN origin. Distinguishes empirically every meaning of "normal
 * output kept":
 *   (1) output socket/schema presence on the pasted Float,
 *   (2) internal outgoing link when Float and downstream are both copied,
 *   (3) outgoing link from copied Float to an UNSELECTED downstream node
 *       (Comfy parity: NOT reconnected; pinned by core clipboard tests),
 *   (4) incoming link from an unselected upstream node (restored).
 * Plus ordinary Ctrl+V detachment, missing-endpoint skip, one-step
 * undo/redo, and no stale-connection reporting via page errors.
 *
 * The LAN origin is an insecure context, so navigator.clipboard is
 * unavailable; the app's documented in-memory fallback covers the
 * copy/paste round trip exactly as it does for the user.
 */
import { expect, test, type Page } from '@playwright/test'
import { skipWithoutNativeCatalog } from './fixtures.js'

const proofDir = '/tmp/audit-live-conflict-proof'

async function openFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    const failures = bridge.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-live-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        up: { id: 'up', type: 'dinkster.float', values: { value: 1.5 } },
        mid: { id: 'mid', type: 'dinkster.float', values: { value: 2.5 } },
        down: { id: 'down', type: 'dinkster.float', values: { value: 3.5 } },
      }, links: {
        lin: { id: 'lin', from: { node: 'up', port: 'value' }, to: { node: 'mid', port: 'value' } },
        lout: { id: 'lout', from: { node: 'mid', port: 'value' }, to: { node: 'down', port: 'value' } },
      }, nets: {}, reroutes: {}, nextOrdinal: 20 } },
      view: { graphs: { g0: { nodes: {
        up: { position: { x: 80, y: 120 } },
        mid: { position: { x: 420, y: 120 } },
        down: { position: { x: 760, y: 120 } },
      } } } },
    }, 'audit float paste proof')
    if (failures.length > 0) throw new Error(`openDocument failed: ${JSON.stringify(failures)}`)
    bridge.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

interface LinkShape {
  readonly id: string
  readonly from: Record<string, unknown>
  readonly to: Record<string, unknown>
}

const graphState = (page: Page) => page.evaluate(() => {
  const bridge = window.__dinksterTest!
  const tab = bridge.app.activeTab()!
  const graph = tab.store.doc.graphs.g0!
  return {
    nodes: Object.entries(graph.nodes).map(([id, node]) => ({ id, type: (node as { type: string }).type })),
    links: Object.entries(graph.links).map(([id, link]) => ({ id, ...(link as object) })) as unknown as LinkShape[],
    selection: [...bridge.controller!.getSelection()],
    revision: tab.store.revision,
  }
})

/** Scene pin inventory for one node: proves socket presence visually/structurally. */
const scenePins = (page: Page, nodeId: string) => page.evaluate((nodeId) => {
  const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)
  if (!node) return undefined
  return node.layout.pins.map((pin) => ({
    direction: pin.direction,
    widgetTap: (pin as { widgetTap?: true }).widgetTap === true,
  }))
}, nodeId)

const select = (page: Page, nodes: readonly string[]) =>
  page.evaluate((nodes) => window.__dinksterTest!.controller!.setSelection([...nodes], [], []), nodes)

const pastedIds = async (page: Page, before: readonly string[]): Promise<string[]> => {
  const state = await graphState(page)
  return state.nodes.map((n) => n.id).filter((id) => !before.includes(id))
}

const nodeOf = (endpoint: Record<string, unknown>): string | undefined =>
  typeof endpoint.node === 'string' ? endpoint.node : undefined

const pageErrors: string[] = []

test.beforeEach(async ({ page, request }, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  pageErrors.length = 0
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const catalog = await page.request.get('/api/nodes?wire=39')
  expect(catalog.ok()).toBe(true)
  expect(((await catalog.json()) as { dinkster?: { schemaWire?: number } }).dinkster?.schemaWire).toBe(39)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0,
  ), { timeout: 20_000 }).toBeGreaterThan(500)
  await openFixture(page)
})

test.afterEach(() => {
  expect(pageErrors).toEqual([])
})

test('case 1+3+4: connected paste of Float alone keeps output socket, restores incoming, never rewires outgoing', async ({ page }) => {
  await select(page, ['mid'])
  await page.keyboard.press('Control+c')
  await page.mouse.move(420, 480)
  await page.keyboard.press('Control+Shift+v')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(4)
  const [pasted] = await pastedIds(page, ['up', 'mid', 'down'])
  expect(pasted).toBeDefined()

  // (1) The pasted Float exposes its schema output socket in the scene.
  const pins = await scenePins(page, pasted!)
  expect(pins).toBeDefined()
  expect(pins!.some((pin) => pin.direction === 'out' && !pin.widgetTap)).toBe(true)
  expect(pins!.some((pin) => pin.direction === 'in')).toBe(true)

  const state = await graphState(page)
  // (4) Incoming from the unselected upstream node is restored.
  expect(state.links.some((link) => nodeOf(link.from) === 'up' && nodeOf(link.to) === pasted)).toBe(true)
  // (3) Comfy parity: the copied Float's outgoing link to the unselected
  // downstream node is NOT reconnected from the pasted copy.
  expect(state.links.some((link) => nodeOf(link.from) === pasted)).toBe(false)
  // Original topology is untouched.
  expect(state.links.some((link) => link.id === 'lin' && nodeOf(link.from) === 'up' && nodeOf(link.to) === 'mid')).toBe(true)
  expect(state.links.some((link) => link.id === 'lout' && nodeOf(link.from) === 'mid' && nodeOf(link.to) === 'down')).toBe(true)
  await page.screenshot({ path: `${proofDir}/01-connected-paste-single-float.png` })
})

test('case 2: internal Float->downstream link survives when both are copied', async ({ page }) => {
  await select(page, ['mid', 'down'])
  await page.keyboard.press('Control+c')
  await page.mouse.move(420, 480)
  await page.keyboard.press('Control+Shift+v')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(5)
  const fresh = await pastedIds(page, ['up', 'mid', 'down'])
  expect(fresh).toHaveLength(2)

  const state = await graphState(page)
  // (2) The internal outgoing link between the two copied nodes survives.
  expect(state.links.some((link) =>
    fresh.includes(nodeOf(link.from) ?? '') && fresh.includes(nodeOf(link.to) ?? ''),
  )).toBe(true)
  // (4) Incoming from the unselected upstream node lands on the pasted mid.
  expect(state.links.some((link) => nodeOf(link.from) === 'up' && fresh.includes(nodeOf(link.to) ?? ''))).toBe(true)
  // No pasted node reconnects to the ORIGINAL unselected nodes' inputs.
  expect(state.links.some((link) => fresh.includes(nodeOf(link.from) ?? '') && ['up', 'mid', 'down'].includes(nodeOf(link.to) ?? ''))).toBe(false)
  await page.screenshot({ path: `${proofDir}/02-connected-paste-pair-internal-link.png` })
})

test('ordinary Ctrl+V pastes fully detached with the output socket intact', async ({ page }) => {
  await select(page, ['mid'])
  await page.keyboard.press('Control+c')
  await page.mouse.move(420, 480)
  await page.keyboard.press('Control+v')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(4)
  const [pasted] = await pastedIds(page, ['up', 'mid', 'down'])
  const state = await graphState(page)
  expect(state.links.some((link) => nodeOf(link.from) === pasted || nodeOf(link.to) === pasted)).toBe(false)
  const pins = await scenePins(page, pasted!)
  expect(pins!.some((pin) => pin.direction === 'out' && !pin.widgetTap)).toBe(true)
  await page.screenshot({ path: `${proofDir}/03-plain-paste-detached.png` })
})

test('missing upstream endpoint is skipped without failing the paste', async ({ page }) => {
  await select(page, ['mid'])
  await page.keyboard.press('Control+c')
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'node.remove', params: { graphId: 'g0', nodeIds: ['up'] } })
  })
  await page.mouse.move(420, 480)
  await page.keyboard.press('Control+Shift+v')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(3)
  const [pasted] = await pastedIds(page, ['mid', 'down'])
  const state = await graphState(page)
  expect(state.links.some((link) => nodeOf(link.to) === pasted || nodeOf(link.from) === pasted)).toBe(false)
  const pins = await scenePins(page, pasted!)
  expect(pins!.some((pin) => pin.direction === 'out' && !pin.widgetTap)).toBe(true)
  await page.screenshot({ path: `${proofDir}/04-missing-upstream-skipped.png` })
})

test('connected paste is one undo transaction and redo restores it', async ({ page }) => {
  const baseline = await graphState(page)
  await select(page, ['mid'])
  await page.keyboard.press('Control+c')
  await page.mouse.move(420, 480)
  await page.keyboard.press('Control+Shift+v')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(4)
  const afterPaste = await graphState(page)
  expect(afterPaste.links.length).toBe(baseline.links.length + 1)

  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(3)
  const afterUndo = await graphState(page)
  expect(afterUndo.links.map((link) => link.id).sort()).toEqual(baseline.links.map((link) => link.id).sort())

  await page.keyboard.press('Control+y')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(4)
  const afterRedo = await graphState(page)
  expect(afterRedo.links.length).toBe(baseline.links.length + 1)
  await page.screenshot({ path: `${proofDir}/05-undo-redo-roundtrip.png` })
})
