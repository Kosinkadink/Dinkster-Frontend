/**
 * Minimap: corner overview of the whole graph with click/drag-to-jump.
 * Pure geometry/state depiction is unit-tested in the canvas package; this
 * verifies the live wiring - the widget paints, navigation moves the MAIN
 * viewport (and only the viewport: the document never changes), and the
 * overview keeps painting on a frozen historical tab.
 */
import { expect, test, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
})

const viewport = (page: Page) => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())

/** Count minimap pixels that differ from the canvas background (#181818). */
const paintedPixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=minimap]')!
    const ctx = canvas.getContext('2d')!
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 0x18) n++
    }
    return n
  })

test('renders an overview and click-jumps the main viewport; document untouched', async ({ page }) => {
  const minimap = page.getByTestId('minimap')
  await expect(minimap).toBeVisible()

  // Backing store sized and something painted beyond the background wash.
  const dims = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=minimap]')!
    return { w: c.width, h: c.height }
  })
  expect(dims.w).toBeGreaterThan(0)
  expect(dims.h).toBeGreaterThan(0)
  expect(await paintedPixels(page)).toBeGreaterThan(50)

  const semanticBefore = await page.evaluate(() =>
    JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc),
  )
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const vp0 = await viewport(page)

  const box = (await minimap.boundingBox())!
  // Click the left-middle, then the right-middle of the overview. Centering
  // a SMALLER world x needs a LARGER positive viewport offset, so vpL.x >
  // vpR.x - a direction assertion that holds for any fit transform without
  // re-deriving the minimap math here.
  await page.mouse.click(box.x + 30, box.y + box.height / 2)
  const vpL = await viewport(page)
  await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2)
  const vpR = await viewport(page)

  expect(vpL.x).toBeGreaterThan(vpR.x)
  expect(vpL.scale).toBeCloseTo(vp0.scale)
  expect(vpR.scale).toBeCloseTo(vp0.scale)

  // Drag from left to right continuously pans in the same direction.
  await page.mouse.move(box.x + 30, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.move(box.x + box.width - 30, box.y + box.height / 2)
  await page.mouse.up()
  const vpDrag = await viewport(page)
  expect(vpDrag.x).toBeLessThan(vpL.x)
  expect(vpDrag.scale).toBeCloseTo(vp0.scale)

  // Navigation is pure view state: no revision bump, no document change.
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(
    revisionBefore,
  )
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(
    semanticBefore,
  )
})

test('wheel zoom centers on the pointed far-away minimap location exactly once', async ({ page }) => {
  const far = { x: 5000, y: 0 }
  const movedNodeId = await page.evaluate((position) => {
    const test = window.__dinksterTest!
    if (test.renderer!.getScene().nodes.length === 0) {
      test.app.registerSchemas([{
        type: 'MinimapE2E', displayName: 'Minimap E2E', category: 'test', source: 'v3', isOutputNode: false,
        items: [],
      }])
      test.app.openDocument({
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'minimap-e2e', root: 'root',
        graphs: { root: {
          id: 'root', name: 'Root',
          nodes: { n1: { id: 'n1', type: 'MinimapE2E', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        } },
        view: { graphs: { root: { nodes: { n1: { position: { x: 100, y: 100 } } } } } },
      }, 'Minimap E2E')
    }
    const tab = test.app.activeTab()!
    const nodeId = window.__dinksterTest!.renderer!.getScene().nodes[0]!.id
    ;(tab.store as unknown as {
      dispatch(invocation: { command: string; params: unknown }): { ok: boolean }
    }).dispatch({
      command: 'node.move',
      params: { graphId: tab.store.doc.root, positions: { [nodeId]: position } },
    })
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return nodeId
  }, far)

  const minimap = page.getByTestId('minimap')
  const metrics = () => minimap.evaluate((canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    return {
      width: canvas.clientWidth,
      height: canvas.clientHeight,
      contentX: rect.left + canvas.clientLeft,
      contentY: rect.top + canvas.clientTop,
    }
  })
  const targetFor = (size: Awaited<ReturnType<typeof metrics>>) => page.evaluate(({ width, height, nodeId }) => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const nodes = scene.nodes
    const pointed = nodes.find((node) => node.id === nodeId)!
    const boxes = [
      ...nodes.map((node) => ({ x: node.x, y: node.y, width: node.layout.width, height: node.layout.height })),
      ...scene.groups,
    ]
    const minX = Math.min(...boxes.map((box) => box.x))
    const minY = Math.min(...boxes.map((box) => box.y))
    const maxX = Math.max(...boxes.map((box) => box.x + box.width))
    const maxY = Math.max(...boxes.map((box) => box.y + box.height))
    const scale = Math.min(0.25, (width - 16) / (maxX - minX), (height - 16) / (maxY - minY))
    const offsetX = (width - (maxX - minX) * scale) / 2 - minX * scale
    const offsetY = (height - (maxY - minY) * scale) / 2 - minY * scale
    const worldX = pointed.x + pointed.layout.width / 2
    const worldY = pointed.y + pointed.layout.height / 2
    return { x: worldX * scale + offsetX, y: worldY * scale + offsetY, worldX, worldY, scale }
  }, { width: size.width, height: size.height, nodeId: movedNodeId })
  // Centering accuracy is bounded by the event's resolution on the minimap:
  // Chromium floors WheelEvent clientX/clientY to whole CSS pixels (only
  // PointerEvent carries fractional coordinates), and one minimap pixel
  // spans 1/scale world units. 1.5 pixels absorbs that floor plus fractional
  // element origins while still catching any real mapping bug, which is off
  // by whole node distances.
  const assertCentered = async (target: Awaited<ReturnType<typeof targetFor>>) => {
    const vp = await viewport(page)
    const canvasSize = await page.getByTestId('graph-canvas').evaluate((canvas) => ({
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    }))
    const tolerance = 1.5 / target.scale
    expect(Math.abs((canvasSize.width / 2 - vp.x) / vp.scale - target.worldX)).toBeLessThan(tolerance)
    expect(Math.abs((canvasSize.height / 2 - vp.y) / vp.scale - target.worldY)).toBeLessThan(tolerance)
    return vp
  }

  let size = await metrics()
  let target = await targetFor(size)
  const point = { x: size.contentX + target.x, y: size.contentY + target.y }
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), point)).toBe('minimap')
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(0, -100)
  await assertCentered(target)

  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await minimap.dispatchEvent('wheel', {
    clientX: point.x,
    clientY: point.y,
    deltaY: -100,
  })
  const vp = await assertCentered(target)
  expect(vp.scale).toBeCloseTo(Math.exp(0.12), 5)

  await page.locator('.canvas-corner-controls').evaluate((element) => { (element as HTMLElement).style.width = '200px' })
  await expect.poll(() => minimap.evaluate((canvas: HTMLCanvasElement) =>
    canvas.clientWidth < 250 && canvas.width === Math.round(canvas.clientWidth * window.devicePixelRatio),
  )).toBe(true)
  size = await metrics()
  target = await targetFor(size)
  const narrowPoint = { x: size.contentX + target.x, y: size.contentY + target.y }
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-testid'), narrowPoint)).toBe('minimap')
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await page.mouse.move(narrowPoint.x, narrowPoint.y)
  await page.mouse.wheel(0, -100)
  await assertCentered(target)
})

test('minimap tracks main-canvas panning (viewport rectangle repaints)', async ({ page }) => {
  // Two viewports whose visible world rects differ wildly must paint
  // different overviews (the stroked rectangle moved).
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  const a = await paintedPixels(page)
  const snapA = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=minimap]')!
    return c.toDataURL()
  })
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: -2000, y: -1500, scale: 2 })
  })
  await page.waitForTimeout(20)
  const snapB = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=minimap]')!
    return c.toDataURL()
  })
  expect(a).toBeGreaterThan(0)
  expect(snapB).not.toBe(snapA)
})

test('display toggles persist and minimap can be hidden and restored', async ({ page }) => {
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  await page.getByTestId('minimap-settings').click()
  const menu = page.locator('.minimap-menu')
  await expect(menu).toContainText('Node Colors')
  await expect(menu).toContainText('Render Bypass State')
  await expect(menu).toContainText('Show Links')
  await expect(menu).toContainText('Show Frames/Groups')
  await expect(menu).toContainText('Reroutes')
  await expect(menu).toContainText('Render Error State')
  await expect(menu).toContainText('Bookmarks')
  await page.getByTestId('minimap-toggle-nodes').click()
  await page.getByTestId('minimap-toggle-bypass').click()
  await page.getByTestId('minimap-toggle-noodles').click()
  await page.getByTestId('minimap-toggle-groups').click()
  await page.getByTestId('minimap-toggle-reroutes').click()
  await page.getByTestId('minimap-toggle-errors').click()
  await page.getByTestId('minimap-marker-toggle').click()
  const minimap = page.getByTestId('minimap')
  await expect(minimap).toHaveAttribute('data-node-colors', 'false')
  await expect(minimap).toHaveAttribute('data-bypass', 'false')
  await expect(minimap).toHaveAttribute('data-links', 'false')
  await expect(minimap).toHaveAttribute('data-groups', 'false')
  await expect(minimap).toHaveAttribute('data-reroutes', 'false')
  await expect(minimap).toHaveAttribute('data-errors', 'false')
  await expect(minimap).toHaveAttribute('data-bookmarks', 'false')
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dinkster.settings')!).values)
  expect(stored).toMatchObject({
    'canvas.minimap.nodes': false,
    'canvas.minimap.bypass': false,
    'canvas.minimap.noodles': false,
    'canvas.minimap.groups': false,
    'canvas.minimap.reroutes': false,
    'canvas.minimap.errors': false,
    'canvas.minimap.bookmarks': false,
  })
  // Palette-off still paints nodes; these controls never turn nodes into a
  // visibility category or remove them from the fitted world union.
  expect(await paintedPixels(page)).toBeGreaterThan(50)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionBefore)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)

  await page.reload()
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('minimap')).toHaveAttribute('data-node-colors', 'false')
  await expect(page.getByTestId('minimap')).toHaveAttribute('data-bookmarks', 'false')
  const minimapHandle = await page.getByTestId('minimap').elementHandle()
  const toggle = page.getByTestId('minimap-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await toggle.click()
  await expect(page.getByTestId('minimap')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  for (const size of [{ width: 1440, height: 900 }, { width: 640, height: 520 }]) {
    await page.setViewportSize(size)
    const [toggleBox, zoom] = await Promise.all([
      toggle.boundingBox(),
      page.locator('.canvas-zoom-controls').boundingBox(),
    ])
    for (const box of [toggleBox!, zoom!]) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(size.width)
      expect(box.y + box.height).toBeLessThanOrEqual(size.height)
    }
  }
  await toggle.click()
  await expect(page.getByTestId('minimap')).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(await minimapHandle!.evaluate((canvas) => canvas.isConnected)).toBe(true)
  const restoredHandle = await page.getByTestId('minimap').elementHandle()
  expect(await minimapHandle!.evaluate((canvas, restored) => canvas === restored, restoredHandle)).toBe(true)
  const restoredBox = (await page.getByTestId('minimap').boundingBox())!
  const restoredViewport = await viewport(page)
  await page.mouse.click(restoredBox.x + 30, restoredBox.y + restoredBox.height / 2)
  expect((await viewport(page)).x).not.toBe(restoredViewport.x)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionBefore)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)
})

test('minimap remains graph-local in root and drilled views', async ({ page }) => {
  const rootScene = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene())
  const rootGraphId = rootScene.graphId
  await expect(page.getByTestId('minimap')).toBeVisible()
  expect(await paintedPixels(page)).toBeGreaterThan(50)

  await page.getByTestId('topbar-search').click()
  await page.getByTestId('universal-search-input').fill('> Create empty subgraph')
  await page.locator('[data-provider="core.commands"] [data-testid="search-result-row"]', { hasText: 'Create empty subgraph' }).click()
  await expect(page.getByTestId('graph-breadcrumb')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).not.toBe(rootGraphId)
  await expect(page.getByTestId('minimap')).toBeVisible()
  expect(await paintedPixels(page)).toBeGreaterThan(50)
})

test('ordinary and narrow layouts keep controls disjoint and canvas interaction outside the cluster', async ({ page }) => {
  for (const { size, menuPlacement } of [
    { size: { width: 1440, height: 900 }, menuPlacement: 'beside' as const },
    // At 640px the open side panel leaves no stage room beside the cluster,
    // so the settings popover must open above it instead.
    { size: { width: 640, height: 520 }, menuPlacement: 'above' as const },
  ]) {
    await page.setViewportSize(size)
    const [panel, toggle, settings, bar] = await Promise.all([
      page.getByTestId('minimap').boundingBox(),
      page.getByTestId('minimap-toggle').boundingBox(),
      page.getByTestId('minimap-settings').boundingBox(),
      page.locator('.canvas-corner-bar').boundingBox(),
    ])
    for (const box of [panel!, toggle!, settings!, bar!]) {
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.y).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(size.width)
      expect(box.y + box.height).toBeLessThanOrEqual(size.height)
    }
    for (const box of [toggle!, settings!]) {
      expect(box.width).toBeGreaterThanOrEqual(36)
      expect(box.height).toBeGreaterThanOrEqual(36)
    }
    // The whole bar (toggle, settings, zoom) sits strictly below the minimap.
    expect(toggle!.x + toggle!.width).toBeLessThanOrEqual(settings!.x)
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(bar!.y)
    const zoomButtons = await page.locator('.canvas-zoom-controls button').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }))
    expect(zoomButtons).toHaveLength(4)
    for (const [index, button] of zoomButtons.entries()) {
      expect(button.width).toBeGreaterThanOrEqual(36)
      expect(button.height).toBeGreaterThanOrEqual(36)
      if (index > 0) expect(zoomButtons[index - 1]!.x + zoomButtons[index - 1]!.width).toBeLessThanOrEqual(button.x)
    }
    await page.getByTestId('minimap-settings').focus()
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('minimap-toggle-nodes')).toBeFocused()
    // The settings popover opens beside the cluster when the stage has room
    // and above it when a side panel or narrow window leaves none; either
    // way it stays in the viewport and never covers the minimap or the bar
    // controls, which stay visible and in place.
    const menu = (await page.locator('.minimap-menu').boundingBox())!
    if (menuPlacement === 'beside') expect(menu.x + menu.width).toBeLessThanOrEqual(panel!.x)
    else expect(menu.y + menu.height).toBeLessThanOrEqual(panel!.y)
    expect(menu.x).toBeGreaterThanOrEqual(0)
    expect(menu.y).toBeGreaterThanOrEqual(0)
    expect(menu.x + menu.width).toBeLessThanOrEqual(size.width)
    expect(menu.y + menu.height).toBeLessThanOrEqual(size.height)
    await expect(page.locator('.canvas-zoom-controls')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('minimap-settings')).toBeFocused()
  }

  await page.locator('.canvas-corner-controls').evaluate((element) => { (element as HTMLElement).style.width = '200px' })
  await expect.poll(() => page.getByTestId('minimap').evaluate((canvas: HTMLCanvasElement) =>
    canvas.clientWidth < 250 && canvas.width === Math.round(canvas.clientWidth * window.devicePixelRatio),
  )).toBe(true)
  const narrowed = await page.getByTestId('minimap').evaluate((canvas: HTMLCanvasElement) => ({
    backingWidth: canvas.width,
    clientWidth: canvas.clientWidth,
    dpr: window.devicePixelRatio,
  }))
  expect(narrowed.backingWidth).toBe(Math.round(narrowed.clientWidth * narrowed.dpr))
  const narrowedBox = (await page.getByTestId('minimap').boundingBox())!
  const leftBefore = await viewport(page)
  await page.mouse.click(narrowedBox.x + 10, narrowedBox.y + narrowedBox.height / 2)
  const left = await viewport(page)
  await page.mouse.click(narrowedBox.x + narrowedBox.width - 10, narrowedBox.y + narrowedBox.height / 2)
  const right = await viewport(page)
  expect(left.x).toBeGreaterThan(right.x)
  expect(left.x).not.toBe(leftBefore.x)

  const before = await viewport(page)
  const graph = (await page.getByTestId('graph-canvas').boundingBox())!
  const start = { x: graph.x + 80, y: graph.y + 80 }
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 60, start.y + 20)
  await page.mouse.up()
  const after = await viewport(page)
  expect(after.x).not.toBe(before.x)
  expect(after.y).not.toBe(before.y)
})

test('corner zoom controls are keyboard reachable, truthful, and preserve the document', async ({ page }) => {
  const revisionBefore = await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
  const documentBefore = await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))
  const level = page.getByTestId('canvas-zoom-level')
  const initial = await viewport(page)
  const worldCenter = async () => {
    const vp = await viewport(page)
    const canvas = await page.getByTestId('graph-canvas').evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
    return { x: (canvas.width / 2 - vp.x) / vp.scale, y: (canvas.height / 2 - vp.y) / vp.scale }
  }
  const center = await worldCenter()

  await page.getByTestId('canvas-zoom-in').focus()
  await page.keyboard.press('Enter')
  const zoomed = await viewport(page)
  expect(zoomed.scale).toBeCloseTo(Math.min(4, initial.scale * 1.2), 5)
  expect(await worldCenter()).toEqual(expect.objectContaining({ x: expect.closeTo(center.x, 5), y: expect.closeTo(center.y, 5) }))
  await expect(level).toHaveText(`${Math.round(zoomed.scale * 100)}%`)

  for (let i = 0; i < 40; i++) await page.getByTestId('canvas-zoom-in').click()
  expect((await viewport(page)).scale).toBe(4)
  expect(await worldCenter()).toEqual(expect.objectContaining({ x: expect.closeTo(center.x, 5), y: expect.closeTo(center.y, 5) }))
  for (let i = 0; i < 50; i++) await page.getByTestId('canvas-zoom-out').click()
  expect((await viewport(page)).scale).toBe(0.05)
  expect(await worldCenter()).toEqual(expect.objectContaining({ x: expect.closeTo(center.x, 5), y: expect.closeTo(center.y, 5) }))

  await level.focus()
  await page.keyboard.press('Enter')
  expect((await viewport(page)).scale).toBeCloseTo(1, 5)
  expect(await worldCenter()).toEqual(expect.objectContaining({ x: expect.closeTo(center.x, 5), y: expect.closeTo(center.y, 5) }))
  await expect(level).toHaveText('100%')

  await page.getByTestId('canvas-fit-view').focus()
  await page.keyboard.press('Enter')
  const fit = await viewport(page)
  expect(Number.isFinite(fit.x) && Number.isFinite(fit.y) && Number.isFinite(fit.scale)).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionBefore)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)
})

test('settings popover dismisses on outside pointerdown and global Escape', async ({ page }) => {
  const settings = page.getByTestId('minimap-settings')
  await settings.click()
  const backdrop = (await page.getByTestId('canvas-popover-backdrop').boundingBox())!
  await page.mouse.move(backdrop.x + backdrop.width / 2, backdrop.y + backdrop.height / 2)
  await page.mouse.down()
  await page.mouse.up()
  await expect(settings).toHaveAttribute('aria-expanded', 'false')

  await settings.click()
  await page.keyboard.press('Escape')
  await expect(settings).toHaveAttribute('aria-expanded', 'false')
})

test('overview keeps painting on a frozen historical tab', async ({ page }) => {
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })

  // Open the execution as a frozen tab.
  await row.locator('.execution-open').click()
  await expect(page.getByTestId('frozen-banner')).toBeVisible({ timeout: 10_000 })

  expect(await paintedPixels(page)).toBeGreaterThan(50)
})
