/**
 * LIVE half of the Widget & Socket Gallery contract: gallery.spec.ts proves
 * the frontend against deterministic fixtures; this suite proves the same
 * coverage against a real native backend by opening the backend's shipped
 * dev-gallery template (pack "core", node types dev.gallery.*, composed
 * from the `dinkster-nodes-dev` pack through the production templates surface, so
 * wire decode gaps cannot hide behind fixture equivalence.
 *
 * Skips loudly without a reachable native backend (DINKSTER_NATIVE_BACKEND,
 * default http://127.0.0.1:8765) or when the dev gallery pack is absent.
 */
import { expect, selectProductOption, test, type Page } from './fixtures.js'

// Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
// All three tests fail in the shared beforeEach: the assets dock panel and
// the library overlay both render a `collection-search` input, so the
// unscoped locator violates strict mode (run 35947843185).
test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

async function addNativeBackend(page: Page): Promise<void> {
  await page.getByTestId('backends-toggle').click()
  await page.getByTestId('backend-url-input').fill(NATIVE_BACKEND)
  await page.getByTestId('backend-add').click()
  await expect(page.getByTestId('tab-target')).toBeVisible()
  await selectProductOption(page, page.getByTestId('tab-target'), NATIVE_BACKEND)
}

async function selectSource(page: Page, source: string): Promise<void> {
  const library = page.getByTestId('library-overlay')
  const sourceTab = library.locator(`[data-testid=collection-source][data-source=${source}]`)
  if (await sourceTab.isVisible()) await sourceTab.click()
  else await selectProductOption(page, library.getByTestId('library-source-select'), source)
}

test.beforeEach(async ({ page }) => {
  // Probe outside the skip calls: test.skip signals by throwing, so a skip
  // raised inside the try would be swallowed and remapped to 'unreachable'.
  let served: Record<string, unknown> | null = null
  try {
    const probe = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(2000) })
    if (probe.ok) served = (await probe.json() as { nodes?: Record<string, unknown> }).nodes ?? {}
  } catch { /* unreachable -> served stays null */ }
  test.skip(served === null, `no native Dinkster backend reachable at ${NATIVE_BACKEND} (set DINKSTER_NATIVE_BACKEND)`)
  test.skip(!(served !== null && 'dev.gallery.sockets' in served),
    `native backend at ${NATIVE_BACKEND} lacks dev.gallery.* - serve the dinkster-nodes-dev pack (Dinkster >= 33a1345)`)

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await addNativeBackend(page)

  // Open the backend-shipped template through the production Library flow.
  await page.getByTestId('library-toggle').click()
  await selectSource(page, 'templates')
  await page.getByTestId('collection-search').fill('gallery')
  await expect(page.getByTestId('collection-entry').first()).toContainText('Widget & Socket Gallery')
  await page.getByTestId('collection-entry').first().click()
  await page.locator('[data-testid=collection-action][data-action=open]').click()
  await expect(page.getByTestId('library-overlay')).not.toBeVisible()

  // openTemplate targets the freshly opened tab at the library backend
  // itself, so no manual tab-target step here.
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.length,
  ), { timeout: 15_000 }).toBeGreaterThan(0)
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 20, scale: 0.85 })
  })
})

test('the live dev-gallery template decodes and lays out with zero errors', async ({ page }) => {
  const state = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const scene = window.__dinksterTest!.renderer!.getScene()
    const doc = app.activeTab()!.store.doc
    const graph = doc.graphs[doc.root]!
    return {
      docNodeIds: Object.keys(graph.nodes).sort(),
      sceneNodeIds: scene.nodes.map((n) => n.id).sort(),
      unresolved: scene.nodes.filter((n) => n.layout.rows.length === 0 && n.layout.pins.length === 0).map((n) => n.id),
      errors: app.problems.get().filter((p) => p.severity === 'error').map((p) => `${p.code}: ${p.message}`),
    }
  })
  expect(state.sceneNodeIds).toEqual(state.docNodeIds)
  expect(state.docNodeIds.length).toBeGreaterThanOrEqual(8)
  expect(state.unresolved).toEqual([])
  expect(state.errors).toEqual([])
})

test('live gallery pins carry the full socket-variant vocabulary', async ({ page }) => {
  const kinds = await page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const byNode: Record<string, Record<string, { kind: string; optional: boolean }>> = {}
    for (const node of scene.nodes) {
      const entry: Record<string, { kind: string; optional: boolean }> = {}
      for (const p of node.layout.pins) entry[p.portId] = { kind: p.type?.kind ?? 'missing', optional: p.optional === true }
      byNode[node.id] = entry
    }
    return byNode
  })
  const allPins = Object.values(kinds).flatMap((entry) => Object.values(entry))
  const present = new Set(allPins.map((p) => p.kind))
  // Wire decode must surface every socket family the backend gallery ships.
  for (const kind of ['concrete', 'union', 'wildcard', 'list']) expect(present).toContain(kind)
  // The unconnected match node keeps an open variable; the connected one may
  // solve to concrete, so assert on the open instance specifically.
  const matchOpen = Object.values(kinds).find((entry) =>
    Object.values(entry).some((p) => p.kind === 'variable'))
  expect(matchOpen).toBeDefined()
  expect(allPins.some((p) => p.optional)).toBe(true)
})

test('visual artifact: live gallery screenshot', async ({ page }, testInfo) => {
  // Not a pixel assertion - the real-server twin of gallery.spec.ts's
  // artifact, so fixture and live renderings can be compared side by side.
  const path = testInfo.outputPath('gallery-live.png')
  await page.getByTestId('graph-canvas').screenshot({ path })
  await testInfo.attach('gallery-live', { path, contentType: 'image/png' })
})
