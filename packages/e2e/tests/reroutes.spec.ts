/**
 * First-class reroute gestures: double-click insertion, dot dragging,
 * Alt+drag fan-out, dropping input-pin drags onto a junction, delete vs
 * dissolve, undo/redo round-trips, and frozen-tab rejection. Real pointer
 * input; document assertions go through the __dinksterTest bridge and prove
 * reroutes stay structural (ID-keyed topology + separated view geometry).
 */
import { expect, test, type Page } from './fixtures.js'

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a node's pin center (assumes identity viewport). */
async function pinPoint(
  page: Page,
  nodeId: string,
  portId: string,
  direction: 'in' | 'out',
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, portId, direction }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const pin = node.layout.pins.find((p) => p.portId === portId && p.direction === direction)
      if (!pin) throw new Error(`no pin '${direction}:${portId}' on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const wx = direction === 'in' ? node.x : node.x + node.layout.width
      return { x: rect.left + wx * vp.scale + vp.x, y: rect.top + (node.y + pin.y) * vp.scale + vp.y }
    },
    { nodeId, portId, direction },
  )
}

/** Page coordinates of a reroute dot's center (assumes identity viewport). */
async function reroutePoint(page: Page, rerouteId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((rerouteId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const dot = r.getScene().reroutes.find((d) => d.id === rerouteId)
    if (!dot) throw new Error(`no scene reroute '${rerouteId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + dot.x * vp.scale + vp.x, y: rect.top + dot.y * vp.scale + vp.y }
  }, rerouteId)
}

/** Page coordinates of a scene link's midpoint (assumes identity viewport). */
async function linkMidpoint(page: Page, linkId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((linkId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const link = r.getScene().links.find((l) => l.id === linkId)
    if (!link) throw new Error(`no scene link '${linkId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + ((link.x1 + link.x2) / 2) * vp.scale + vp.x,
      y: rect.top + ((link.y1 + link.y2) / 2) * vp.scale + vp.y,
    }
  }, linkId)
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const rootGraph = async (page: Page) => (await activeDoc(page)).graphs['g0']!

const menuItem = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`)

/**
 * EmptyImage -> r0 -> PreviewImage, plus a second free PreviewImage. Types
 * resolve against the real backend's object_info, so the traced reroute type
 * is a concrete IMAGE.
 */
async function openRerouteWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const failures = app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-reroutes',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              n0: {
                id: 'n0',
                type: 'EmptyImage',
                values: { width: 64, height: 64, batch_size: 1, color: 0 },
              },
              n1: { id: 'n1', type: 'PreviewImage', values: {} },
              n2: { id: 'n2', type: 'PreviewImage', values: {} },
              // Free second producer: the ghost input-socket tests connect
              // it into r0 (replacing the n0 driver).
              n3: {
                id: 'n3',
                type: 'EmptyImage',
                values: { width: 64, height: 64, batch_size: 1, color: 0 },
              },
            },
            links: {
              l1: { id: 'l1', from: { node: 'n0', port: 'out0' }, to: { reroute: 'r0' } },
              l2: { id: 'l2', from: { reroute: 'r0' }, to: { node: 'n1', port: 'images' } },
            },
            nets: {},
            reroutes: { r0: { id: 'r0' } },
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                n0: { position: { x: 60, y: 120 } },
                n1: { position: { x: 560, y: 60 } },
                n2: { position: { x: 560, y: 340 } },
                n3: { position: { x: 60, y: 380 } },
              },
              reroutes: { r0: { position: { x: 400, y: 160 } } },
            },
          },
        },
      },
      'Reroutes',
    )
    if (failures.length > 0) throw new Error(`openDocument failed: ${JSON.stringify(failures)}`)
  })
  await identityViewport(page)
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await identityViewport(page)
})

test('clicking a link midpoint inserts ONE reroute there; undo restores the direct link', async ({ page }) => {
  // The startup doc: n0 -> l2 -> n1 with no reroutes.
  const before = await rootGraph(page)
  expect(Object.keys(before.reroutes)).toHaveLength(0)

  const mid = await linkMidpoint(page, 'l2')
  await page.mouse.click(...xy(mid))

  // A clean midpoint click opens the same choice menu as a whole-link
  // double-click; "Add reroute" performs reroute.insert.
  const menu = page.getByTestId('link-double-click-menu')
  await expect(menu).toBeVisible()
  await menu.getByRole('button', { name: 'Add reroute' }).click()
  await expect(menu).not.toBeVisible()

  const g = await rootGraph(page)
  const rerouteIds = Object.keys(g.reroutes)
  expect(rerouteIds).toHaveLength(1)
  const rid = rerouteIds[0]!
  const links = Object.values(g.links)
  expect(links).toHaveLength(2)
  expect(links).toContainEqual(
    expect.objectContaining({ from: { node: 'n0', port: 'out0' }, to: { reroute: rid } }),
  )
  expect(links).toContainEqual(
    expect.objectContaining({ from: { reroute: rid }, to: { node: 'n1', port: 'images' } }),
  )
  // Geometry landed where the user pointed, in the view (not the topology).
  const doc = await activeDoc(page)
  const viewPos = doc.view.graphs['g0']!.reroutes![rid]!.position
  const rect = await page.getByTestId('graph-canvas').boundingBox()
  expect(viewPos.x).toBeCloseTo(mid.x - rect!.x, 0)
  expect(viewPos.y).toBeCloseTo(mid.y - rect!.y, 0)

  // ONE undo restores the direct link and drops the junction + its geometry.
  await page.keyboard.press('Control+z')
  const undone = await rootGraph(page)
  expect(Object.keys(undone.reroutes)).toHaveLength(0)
  expect(Object.values(undone.links)).toEqual([
    expect.objectContaining({ from: { node: 'n0', port: 'out0' }, to: { node: 'n1', port: 'images' } }),
  ])
})

test('double-clicking a link midpoint leaves the menu open until an explicit choice', async ({ page }) => {
  const before = await rootGraph(page)
  await page.mouse.dblclick(...xy(await linkMidpoint(page, 'l2')))

  await expect(page.getByTestId('link-double-click-menu')).toBeVisible()
  expect(await rootGraph(page)).toEqual(before)
})

test('a scene rebuild closes an open link menu before its context can stale', async ({ page }) => {
  await page.mouse.click(...xy(await linkMidpoint(page, 'l2')))
  const menu = page.getByTestId('link-double-click-menu')
  await expect(menu).toBeVisible()

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({
      command: 'node.move',
      params: { graphId: 'g0', positions: { n0: { x: 61, y: 50 } } },
    })
  })
  await expect(menu).not.toBeVisible()
})

test('dragging a reroute dot commits ONE reroute.move; undo/redo round-trips', async ({ page }) => {
  await openRerouteWorkflow(page)

  const dot = await reroutePoint(page, 'r0')
  await drag(page, dot, { x: dot.x + 80, y: dot.y - 40 })

  const moved = await activeDoc(page)
  expect(moved.view.graphs['g0']!.reroutes!['r0']!.position).toEqual({ x: 480, y: 120 })

  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.view.graphs['g0']!.reroutes!['r0']!.position).toEqual({ x: 400, y: 160 })

  await page.keyboard.press('Control+Shift+z')
  const redone = await activeDoc(page)
  expect(redone.view.graphs['g0']!.reroutes!['r0']!.position).toEqual({ x: 480, y: 120 })
})

test('Alt+drag from a reroute fans out a second consumer from the junction', async ({ page }) => {
  await openRerouteWorkflow(page)

  const dot = await reroutePoint(page, 'r0')
  const target = await pinPoint(page, 'n2', 'images', 'in')
  await page.keyboard.down('Alt')
  await drag(page, dot, target)
  await page.keyboard.up('Alt')

  const g = await rootGraph(page)
  // Existing segments intact + one new fan-out from the SAME junction.
  expect(Object.keys(g.reroutes)).toEqual(['r0'])
  const links = Object.values(g.links)
  expect(links).toHaveLength(3)
  expect(links).toContainEqual(
    expect.objectContaining({ from: { reroute: 'r0' }, to: { node: 'n2', port: 'images' } }),
  )

  await page.keyboard.press('Control+z')
  expect(Object.values((await rootGraph(page)).links)).toHaveLength(2)
})

test('dragging a free input pin onto a reroute dot uses the junction as source', async ({ page }) => {
  await openRerouteWorkflow(page)

  const from = await pinPoint(page, 'n2', 'images', 'in')
  const dot = await reroutePoint(page, 'r0')
  await drag(page, from, dot)

  const links = Object.values((await rootGraph(page)).links)
  expect(links).toHaveLength(3)
  expect(links).toContainEqual(
    expect.objectContaining({ from: { reroute: 'r0' }, to: { node: 'n2', port: 'images' } }),
  )
})

/** REROUTE_SOCKET_OFFSET in @dinkster/canvas scene.ts (keep in sync). */
const SOCKET_OFFSET = 21

const hoveredReroute = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getOverlay().hoveredReroute)

test('hovering a reroute reveals ghost sockets; moving away hides them', async ({ page }) => {
  await openRerouteWorkflow(page)
  const dot = await reroutePoint(page, 'r0')

  expect(await hoveredReroute(page)).toBeUndefined()
  await page.mouse.move(dot.x, dot.y)
  expect(await hoveredReroute(page)).toBe('r0')

  // Sliding from the dot onto a revealed socket keeps the reveal alive
  // (otherwise the affordance would vanish under the approaching cursor).
  await page.mouse.move(dot.x + SOCKET_OFFSET, dot.y)
  expect(await hoveredReroute(page)).toBe('r0')

  await page.mouse.move(dot.x + 150, dot.y + 150)
  expect(await hoveredReroute(page)).toBeUndefined()
})

test('approaching a socket position directly reveals it without touching the dot first', async ({ page }) => {
  await openRerouteWorkflow(page)
  const dot = await reroutePoint(page, 'r0')

  // Park far away, then jump straight to where the OUTPUT socket lives.
  // The reveal zone covers the socket ring itself, so the affordance must
  // appear even though the pointer never crossed the central dot.
  await page.mouse.move(dot.x + 200, dot.y + 200)
  expect(await hoveredReroute(page)).toBeUndefined()
  await page.mouse.move(dot.x + SOCKET_OFFSET, dot.y)
  expect(await hoveredReroute(page)).toBe('r0')

  // Same from the INPUT side.
  await page.mouse.move(dot.x - 200, dot.y - 200)
  expect(await hoveredReroute(page)).toBeUndefined()
  await page.mouse.move(dot.x - SOCKET_OFFSET, dot.y)
  expect(await hoveredReroute(page)).toBe('r0')
})

test('dragging the ghost output socket fans out a new consumer - no Alt needed', async ({ page }) => {
  await openRerouteWorkflow(page)
  const dot = await reroutePoint(page, 'r0')
  const target = await pinPoint(page, 'n2', 'images', 'in')

  // Hover first (the socket only exists while revealed), then grab it.
  await page.mouse.move(dot.x, dot.y)
  await drag(page, { x: dot.x + SOCKET_OFFSET, y: dot.y }, target)

  const g = await rootGraph(page)
  expect(Object.keys(g.reroutes)).toEqual(['r0'])
  const links = Object.values(g.links)
  expect(links).toHaveLength(3)
  expect(links).toContainEqual(
    expect.objectContaining({ from: { reroute: 'r0' }, to: { node: 'n2', port: 'images' } }),
  )

  await page.keyboard.press('Control+z')
  expect(Object.values((await rootGraph(page)).links)).toHaveLength(2)
})

test('dragging the ghost input socket to a producer replaces the junction driver', async ({ page }) => {
  await openRerouteWorkflow(page)
  const dot = await reroutePoint(page, 'r0')
  const producer = await pinPoint(page, 'n3', 'out0', 'out')

  await page.mouse.move(dot.x, dot.y)
  await drag(page, { x: dot.x - SOCKET_OFFSET, y: dot.y }, producer)

  // link.connect INTO the junction replaced the old driver (core removeDriver
  // semantics): n3 now feeds r0, the n0 link is gone, the consumer is intact.
  const g = await rootGraph(page)
  const links = Object.values(g.links)
  expect(links).toHaveLength(2)
  expect(links).toContainEqual(
    expect.objectContaining({ from: { node: 'n3', port: 'out0' }, to: { reroute: 'r0' } }),
  )
  expect(links).toContainEqual(
    expect.objectContaining({ from: { reroute: 'r0' }, to: { node: 'n1', port: 'images' } }),
  )

  // ONE undo restores the original driver atomically.
  await page.keyboard.press('Control+z')
  const undone = Object.values((await rootGraph(page)).links)
  expect(undone).toContainEqual(
    expect.objectContaining({ from: { node: 'n0', port: 'out0' }, to: { reroute: 'r0' } }),
  )
  expect(undone).toHaveLength(2)
})

test('a ghost socket drag dropped on empty opens the palette seeking the right direction', async ({ page }) => {
  await openRerouteWorkflow(page)
  const dot = await reroutePoint(page, 'r0')

  // Empty canvas point: clear of every fixture node (n2 sits at 560,340).
  const empty = { x: dot.x, y: dot.y + 460 }

  // Output socket seeks inputs.
  await page.mouse.move(dot.x, dot.y)
  await drag(page, { x: dot.x + SOCKET_OFFSET, y: dot.y }, empty)
  const palette = page.getByTestId('node-palette')
  await expect(palette).toBeVisible()
  await expect(palette).toHaveAttribute('data-link-drop', 'in')
  await page.getByTestId('palette-search').press('Escape')
  await expect(palette).not.toBeVisible()

  // Input socket seeks outputs.
  await page.mouse.move(dot.x, dot.y)
  await drag(page, { x: dot.x - SOCKET_OFFSET, y: dot.y }, empty)
  await expect(palette).toBeVisible()
  await expect(palette).toHaveAttribute('data-link-drop', 'out')
  await page.getByTestId('palette-search').press('Escape')

  // Nothing changed in the document: both drags were fully cancelled.
  const g = await rootGraph(page)
  expect(Object.keys(g.links).sort()).toEqual(['l1', 'l2'])
})

test('the reroute dot itself still moves - sockets never steal the center grab', async ({ page }) => {
  await openRerouteWorkflow(page)
  const dot = await reroutePoint(page, 'r0')

  // Hover to reveal sockets, then drag the CENTER: still a move gesture.
  await page.mouse.move(dot.x, dot.y)
  expect(await hoveredReroute(page)).toBe('r0')
  await drag(page, dot, { x: dot.x + 80, y: dot.y - 40 })

  const moved = await activeDoc(page)
  expect(moved.view.graphs['g0']!.reroutes!['r0']!.position).toEqual({ x: 480, y: 120 })
  expect(Object.keys((await rootGraph(page)).links).sort()).toEqual(['l1', 'l2'])
})

test('Delete removes a selected reroute and cascades its links; undo restores both', async ({ page }) => {
  await openRerouteWorkflow(page)

  await page.mouse.click(...xy(await reroutePoint(page, 'r0')))
  await page.keyboard.press('Delete')

  const g = await rootGraph(page)
  expect(Object.keys(g.reroutes)).toHaveLength(0)
  expect(Object.keys(g.links)).toHaveLength(0)

  await page.keyboard.press('Control+z')
  const undone = await rootGraph(page)
  expect(Object.keys(undone.reroutes)).toEqual(['r0'])
  expect(Object.keys(undone.links).sort()).toEqual(['l1', 'l2'])
})

test('context-menu Dissolve reconnects the path as a direct link', async ({ page }) => {
  await openRerouteWorkflow(page)

  await page.mouse.click(...xy(await reroutePoint(page, 'r0')), { button: 'right' })
  await expect(menuItem(page, 'core.reroute.dissolve')).toBeVisible()
  await menuItem(page, 'core.reroute.dissolve').click()

  const g = await rootGraph(page)
  expect(Object.keys(g.reroutes)).toHaveLength(0)
  expect(Object.values(g.links)).toEqual([
    expect.objectContaining({ from: { node: 'n0', port: 'out0' }, to: { node: 'n1', port: 'images' } }),
  ])
  // The junction's view geometry went with it.
  const doc = await activeDoc(page)
  expect(doc.view.graphs['g0']!.reroutes?.['r0']).toBeUndefined()
})

test('frozen tabs reject reroute insertion like every other command', async ({ page }) => {
  // Queue the startup workflow and open its frozen snapshot view.
  await expect(page.getByTestId('queue-button')).toBeEnabled({ timeout: 15_000 })
  await page.getByTestId('queue-button').click()
  const row = page.getByTestId('execution-row').first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  await expect(row.locator('.execution-status')).toHaveText('Completed', { timeout: 30_000 })
  await row.locator('.execution-open').click()
  await expect(page.getByTestId('tab-bar').locator('.tab.frozen.active')).toHaveCount(1)
  await identityViewport(page)

  await page.mouse.dblclick(...xy(await linkMidpoint(page, 'l2')))

  const g = await rootGraph(page)
  expect(Object.keys(g.reroutes)).toHaveLength(0)
  expect(Object.keys(g.links)).toEqual(['l2'])
})
