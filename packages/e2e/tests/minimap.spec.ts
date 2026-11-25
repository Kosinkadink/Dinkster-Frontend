/**
 * Minimap: corner overview of the whole graph with click/drag-to-jump.
 * Pure geometry/state depiction is unit-tested in the canvas package; this
 * verifies the live wiring - the widget paints, navigation moves the MAIN
 * viewport (and only the viewport: the document never changes), and the
 * overview keeps painting on a frozen historical tab.
 */
import { expect, test, waitForWorkspaceReady, type Page } from './fixtures.js'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await waitForWorkspaceReady(page)
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const document = structuredClone(app.activeTab()!.store.doc)
    document.graphs.g0!.nodes.n0!.type = 'dinkster.image.empty_image'
    document.graphs.g0!.nodes.n1!.type = 'dinkster.image.preview_image'
    return app.openDocument(document, 'Basic')
  })).toEqual([])
})

const viewport = (page: Page) => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())

/** Count minimap pixels that differ from its panel background. */
const paintedPixels = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=minimap]')!
    const background = getComputedStyle(canvas).backgroundColor.match(/\d+/g)!.slice(0, 3).map(Number)
    const ctx = canvas.getContext('2d')!
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    let n = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== background[0] || data[i + 1] !== background[1] || data[i + 2] !== background[2]) n++
    }
    return n
  })

test('minimap sizes persist with small as the default; the bar under it keeps its width, right-justified', async ({ page }) => {
  const map = page.getByTestId('minimap')
  const bar = page.locator('.canvas-corner-bar')
  await expect(map).toHaveCSS('width', '160px')
  await expect(map).toHaveCSS('height', '96px')
  const before = await viewport(page)
  await map.hover()
  await page.mouse.wheel(0, -100)
  await expect.poll(async () => (await viewport(page)).scale).toBeGreaterThan(before.scale)

  const barWidth = (await bar.boundingBox())!.width
  expect(barWidth).toBeLessThan(160)
  for (const [size, width, height] of [
    ['medium', 196, 118], ['large', 256, 150], ['small', 160, 96],
  ] as const) {
    await page.evaluate((value) => window.__dinksterTest!.app.settings.set('canvas.minimap.size', value), size)
    await expect(map).toHaveCSS('width', `${width}px`)
    await expect(map).toHaveCSS('height', `${height}px`)
    const [mapBox, barBox] = await Promise.all([map.boundingBox(), bar.boundingBox()])
    expect(barBox!.width).toBeCloseTo(barWidth, 0)
    expect(barBox!.height).toBe(36)
    expect(barBox!.x + barBox!.width).toBeCloseTo(mapBox!.x + mapBox!.width, 0)
    await expect(bar.locator('button:visible')).toHaveCount(4)
  }
  expect((await page.locator('.canvas-view-controls').boundingBox())!.height).toBe(36)
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.minimap.size', 'medium'))
  await page.reload()
  await expect(page.getByTestId('minimap')).toHaveCSS('width', '196px')
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
  const movedNodeId = await page.evaluate(async (position) => {
    const test = window.__dinksterTest!
    if (test.renderer!.getScene().nodes.length === 0) {
      test.app.registerSchemas([{
        type: 'MinimapE2E', displayName: 'Minimap E2E', category: 'test', source: 'v3', isOutputNode: false,
        items: [],
      }])
      await test.app.openDocument({
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
  await expect(menu.getByRole('switch')).toHaveText(['Colors', 'Links', 'Frames and groups', 'Errors', 'Bookmark numbers'])
  for (const label of ['Colors', 'Links', 'Frames and groups', 'Errors']) {
    const row = menu.getByRole('switch', { name: label, exact: true })
    await expect(row).toHaveAttribute('aria-checked', 'true')
    await expect(row).not.toHaveAttribute('data-tooltip-label')
    await expect(row).not.toHaveAttribute('title')
    expect(await row.evaluate((element) => element.getBoundingClientRect().height)).toBe(28)
  }
  const bookmarks = menu.getByRole('switch', { name: 'Bookmark numbers', exact: true })
  await expect(bookmarks).toHaveAttribute('data-tooltip-label', 'Show bookmark numbers on the minimap')
  await expect(bookmarks).not.toHaveAttribute('title')
  await expect(bookmarks).toHaveAttribute('aria-checked', 'true')
  await bookmarks.focus()
  await expect(bookmarks).toBeFocused()
  await page.getByTestId('minimap-toggle-nodes').click()
  await page.getByTestId('minimap-toggle-noodles').click()
  await page.getByTestId('minimap-toggle-groups').click()
  await page.getByTestId('minimap-toggle-errors').click()
  await bookmarks.focus()
  await page.keyboard.press('Space')
  await expect(bookmarks).toHaveAttribute('aria-checked', 'false')
  const minimap = page.getByTestId('minimap')
  await expect(minimap).toHaveAttribute('data-node-colors', 'false')
  await expect(minimap).toHaveAttribute('data-links', 'false')
  await expect(minimap).toHaveAttribute('data-groups', 'false')
  await expect(minimap).toHaveAttribute('data-errors', 'false')
  await expect(minimap).toHaveAttribute('data-bookmarks', 'false')
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('dinkster.settings')!).values)
  expect(stored).toMatchObject({
    'canvas.minimap.nodes': false,
    'canvas.minimap.noodles': false,
    'canvas.minimap.groups': false,
    'canvas.minimap.errors': false,
    'canvas.minimap.bookmarks': false,
  })
  // Palette-off still paints nodes; these controls never turn nodes into a
  // visibility category or remove them from the fitted world union.
  expect(await paintedPixels(page)).toBeGreaterThan(50)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionBefore)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)

  await page.reload()
  await waitForWorkspaceReady(page)
  await expect(page.getByTestId('minimap')).toHaveAttribute('data-node-colors', 'false')
  await expect(page.getByTestId('minimap')).toHaveAttribute('data-bookmarks', 'false')
  const minimapHandle = await page.getByTestId('minimap').elementHandle()
  const toggle = page.getByTestId('minimap-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAccessibleName('Hide minimap')
  await expect(toggle).toHaveAttribute('data-tooltip-label', 'Hide minimap')
  await toggle.click()
  await expect(page.getByTestId('minimap')).toBeHidden()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(toggle).toHaveAccessibleName('Show minimap')
  await expect(toggle).toHaveAttribute('data-tooltip-label', 'Show minimap')
  for (const size of [{ width: 1440, height: 900 }, { width: 640, height: 520 }]) {
    await page.setViewportSize(size)
    const [toggleBox, zoom] = await Promise.all([
      toggle.boundingBox(),
      page.locator('.canvas-corner-bar').boundingBox(),
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
  await expect(toggle).toHaveAccessibleName('Hide minimap')
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

test('the zoom menu is keyboard reachable, truthful, and preserves the document', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.app.settings.set('canvas.minimap.size', 'medium'))
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
  const centered = async () =>
    expect(await worldCenter()).toEqual(expect.objectContaining({ x: expect.closeTo(center.x, 5), y: expect.closeTo(center.y, 5) }))
  const menu = page.getByTestId('canvas-zoom-menu')
  const field = page.getByTestId('canvas-zoom-input')
  const number = menu.locator('.dinkster-canvas-closed-row-open')
  const numberValue = menu.locator('.dinkster-canvas-closed-row-value')

  // The percentage opens the menu with the keyboard on its number.
  await level.focus()
  await page.keyboard.press('Enter')
  await expect(menu).toBeVisible()
  await expect(level).toHaveAttribute('aria-expanded', 'true')
  await expect(number).toBeFocused()
  await expect(number).toHaveAccessibleName(`Zoom: ${Math.round(initial.scale * 100)}%`)

  // Plus and minus step the zoom around the view's center and leave the menu open.
  await menu.getByRole('button', { name: 'Zoom in' }).click()
  await expect(menu).toBeVisible()
  const zoomed = await viewport(page)
  expect(zoomed.scale).toBeCloseTo(Math.min(4, initial.scale * 1.2), 5)
  await centered()
  await expect(level).toHaveText(`${Math.round(zoomed.scale * 100)}%`)
  await expect(numberValue).toHaveText(`${Math.round(zoomed.scale * 100)}%`)
  await menu.getByRole('button', { name: 'Zoom out' }).click()
  expect((await viewport(page)).scale).toBeCloseTo(initial.scale, 5)
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(level).toBeFocused()

  // Pressing the number types a percentage, which sets that zoom around the
  // view's center, within the canvas limits, and closes the menu.
  for (const [typed, scale] of [['150', 1.5], ['1000', 4], ['1', 0.05]] as const) {
    await level.click()
    await number.click()
    await expect(field).toBeFocused()
    await field.fill(typed)
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    expect((await viewport(page)).scale).toBeCloseTo(scale, 5)
    await centered()
  }

  // A digit typed anywhere in the menu starts the field with that digit.
  await level.focus()
  await page.keyboard.press('Enter')
  await expect(number).toBeFocused()
  await page.keyboard.type('80')
  await expect(field).toHaveValue('80')
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  expect((await viewport(page)).scale).toBeCloseTo(0.8, 5)

  await level.click()
  await page.getByTestId('canvas-zoom-reset').click()
  expect((await viewport(page)).scale).toBeCloseTo(1, 5)
  await centered()
  await expect(level).toHaveText('100%')

  await page.getByTestId('canvas-fit-view').focus()
  await page.keyboard.press('Enter')
  const fit = await viewport(page)
  expect(Number.isFinite(fit.x) && Number.isFinite(fit.y) && Number.isFinite(fit.scale)).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)).toBe(revisionBefore)
  expect(await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc))).toBe(documentBefore)
})

test('corner menus dismiss on outside pointerdown and global Escape', async ({ page }) => {
  for (const trigger of [page.getByTestId('minimap-settings'), page.getByTestId('canvas-zoom-level')]) {
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    const backdrop = (await page.getByTestId('canvas-popover-backdrop').boundingBox())!
    await page.mouse.move(backdrop.x + backdrop.width / 2, backdrop.y + backdrop.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')

    await trigger.click()
    await page.keyboard.press('Escape')
    await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  }
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
