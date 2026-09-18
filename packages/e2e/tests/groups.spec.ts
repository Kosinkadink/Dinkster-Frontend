/**
 * First-class visual groups: view-only rectangles with SPATIAL membership
 * (no stored node list). Covers menu-driven create/rename/color/delete, the
 * one-undo-step header drag that carries member nodes, resize, body
 * fall-through to panning, graph-definition scoping, and the invariant that
 * group operations never touch semantic state.
 */
import { expect, test, type Page } from './fixtures.js'

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a node's header center (assumes identity viewport). */
async function headerPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

type GroupPart = 'header' | 'nw' | 'se' | 'body'

/** Page coordinates of a feature of a scene group (assumes identity viewport). */
async function groupPoint(page: Page, groupId: string, part: GroupPart): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ groupId, part }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const g = r.getScene().groups.find((sg) => sg.id === groupId)
      if (!g) throw new Error(`no scene group '${groupId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const toPage = (wx: number, wy: number) => ({
        x: rect.left + wx * vp.scale + vp.x,
        y: rect.top + wy * vp.scale + vp.y,
      })
      switch (part) {
        case 'header':
          return toPage(g.x + g.width / 2, g.y + 13) // GROUP_HEADER_HEIGHT / 2
        case 'nw':
          return toPage(g.x, g.y)
        case 'se':
          return toPage(g.x + g.width, g.y + g.height)
        case 'body':
          // Just below the title band at the left edge: inside the group but
          // clear of the header, the resize corner, and any member node.
          return toPage(g.x + 8, g.y + 26 + 12)
      }
    },
    { groupId, part },
  )
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
const revision = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)
const groupsInDoc = async (page: Page, graphId = 'g0') =>
  (await activeDoc(page)).view.graphs[graphId]?.groups ?? {}

const menu = (page: Page) => page.getByTestId('context-menu')
const menuItem = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`)

/** Create a group around node n0 via selection + context menu; returns its id. */
async function groupAroundN0(page: Page): Promise<string> {
  const header = await headerPoint(page, 'n0')
  await page.mouse.click(...xy(header))
  await page.mouse.click(...xy(header), { button: 'right' })
  await menuItem(page, 'core.node.groupSelection').click()
  const groups = await groupsInDoc(page)
  const ids = Object.keys(groups)
  expect(ids).toHaveLength(1)
  // Clear the node selection: while n0 is selected, the selection toolbox
  // floats over the new group's header and swallows clicks aimed at it.
  await page.mouse.click(700, 750)
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '0')
  return ids[0]!
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await identityViewport(page)
})

test('canvas menu Add Group creates a view-only rectangle; undo removes it', async ({ page }) => {
  const semanticBefore = await page.evaluate(() =>
    JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc.graphs),
  )
  await page.mouse.click(700, 750, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await menuItem(page, 'core.canvas.addGroup').click()

  const groups = await groupsInDoc(page)
  const ids = Object.keys(groups)
  expect(ids).toHaveLength(1)
  const g = groups[ids[0]!]!
  expect(g.title).toBe('Group')
  expect(g.bounds.width).toBe(320)
  expect(g.bounds.height).toBe(220)
  // Rendered in the scene, and semantic state untouched.
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().groups)).toHaveLength(1)
  expect(
    await page.evaluate(() => JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc.graphs)),
  ).toBe(semanticBefore)

  await page.keyboard.press('Control+z')
  expect(Object.keys(await groupsInDoc(page))).toHaveLength(0)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().groups)).toHaveLength(0)
})

test('Group Node wraps the selection; header drag carries members in ONE undo step', async ({ page }) => {
  const id = await groupAroundN0(page)
  // n0 is still selected, so its selection toolbox floats exactly over the
  // group's title band; clear the selection before grabbing the header.
  await page.mouse.click(700, 750)
  const groups = await groupsInDoc(page)
  const bounds = groups[id]!.bounds

  // The rectangle wraps n0 (with padding + title headroom above).
  const n0 = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'n0')!
    return { x: node.x, y: node.y, w: node.layout.width, h: node.layout.height }
  })
  expect(bounds.x).toBeLessThan(n0.x)
  expect(bounds.y).toBeLessThan(n0.y)
  expect(bounds.x + bounds.width).toBeGreaterThan(n0.x + n0.w)
  expect(bounds.y + bounds.height).toBeGreaterThan(n0.y + n0.h)

  // Drag the title band: the group AND n0 move; n1 (outside) does not.
  const before = await revision(page)
  const from = await groupPoint(page, id, 'header')
  await drag(page, from, { x: from.x + 150, y: from.y + 60 })

  expect(await revision(page)).toBe(before + 1) // ONE command
  const moved = await activeDoc(page)
  expect(moved.view.graphs['g0']!.groups![id]!.bounds).toEqual({
    ...bounds,
    x: bounds.x + 150,
    y: bounds.y + 60,
  })
  expect(moved.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: 230, y: 180 })
  expect(moved.view.graphs['g0']!.nodes['n1']!.position).toEqual({ x: 420, y: 120 })

  // ONE undo restores the group and the carried node together.
  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.view.graphs['g0']!.groups![id]!.bounds).toEqual(bounds)
  expect(undone.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: 80, y: 120 })

  await page.keyboard.press('Control+Shift+z')
  const redone = await activeDoc(page)
  expect(redone.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: 230, y: 180 })
})

test('membership is spatial: a node moved out of the rectangle stops being carried', async ({ page }) => {
  const id = await groupAroundN0(page)
  // Move n0 far outside the rectangle.
  const n0 = await headerPoint(page, 'n0')
  await drag(page, n0, { x: n0.x + 400, y: n0.y + 300 })

  const from = await groupPoint(page, id, 'header')
  await drag(page, from, { x: from.x + 50, y: from.y })

  const doc = await activeDoc(page)
  // The group moved alone; n0 stayed where it was dropped.
  expect(doc.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: 480, y: 420 })
})

test('NW group resize moves only the frame, commits once, and undo restores', async ({ page }) => {
  const id = await groupAroundN0(page)
  const bounds = (await groupsInDoc(page))[id]!.bounds
  const nodeBefore = (await activeDoc(page)).view.graphs['g0']!.nodes['n0']!.position

  const before = await revision(page)
  const from = await groupPoint(page, id, 'nw')
  await drag(page, from, { x: from.x - 80, y: from.y - 50 })

  expect(await revision(page)).toBe(before + 1)
  const resized = (await groupsInDoc(page))[id]!.bounds
  expect(resized).toEqual({
    x: bounds.x - 80,
    y: bounds.y - 50,
    width: bounds.width + 80,
    height: bounds.height + 50,
  })
  expect((await activeDoc(page)).view.graphs['g0']!.nodes['n0']!.position).toEqual(nodeBefore)

  await page.keyboard.press('Control+z')
  expect((await groupsInDoc(page))[id]!.bounds).toEqual(bounds)
})

test('SE group corner grows the frame without moving members', async ({ page }) => {
  const id = await groupAroundN0(page)
  const before = await activeDoc(page)
  const bounds = before.view.graphs['g0']!.groups![id]!.bounds
  const nodeBefore = before.view.graphs['g0']!.nodes['n0']!.position
  const from = await groupPoint(page, id, 'se')
  await drag(page, from, { x: from.x + 80, y: from.y + 50 })
  const after = await activeDoc(page)
  expect(after.view.graphs['g0']!.groups![id]!.bounds).toEqual({
    ...bounds, width: bounds.width + 80, height: bounds.height + 50,
  })
  expect(after.view.graphs['g0']!.nodes['n0']!.position).toEqual(nodeBefore)
})

test('group body falls through: plain drag pans the canvas, Ctrl+drag marquees, doc untouched', async ({ page }) => {
  const id = await groupAroundN0(page)
  const before = await revision(page)
  const from = await groupPoint(page, id, 'body')

  // Ctrl+drag on empty space (group bodies fall through) marquee-selects:
  // the viewport must NOT move and nothing commits.
  await page.keyboard.down('Control')
  await drag(page, from, { x: from.x + 120, y: from.y + 40 })
  await page.keyboard.up('Control')
  const still = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  expect(still.x).toBe(0)
  expect(still.y).toBe(0)

  // The marquee selects n0 and materializes its toolbox over this group-body
  // point. Clear it so the next gesture still exercises body fall-through.
  await page.mouse.click(700, 750)
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '0')

  // Plain drag is the hand tool: it pans.
  await drag(page, from, { x: from.x + 120, y: from.y + 40 })
  const vp = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  expect(vp.x).toBe(120)
  expect(vp.y).toBe(40)
  expect(await revision(page)).toBe(before) // nothing committed
})

test('rename via the group menu prompt', async ({ page }) => {
  const id = await groupAroundN0(page)
  const header = await groupPoint(page, id, 'header')
  await page.mouse.click(...xy(header), { button: 'right' })
  await menuItem(page, 'core.group.rename').click()

  const input = page.getByTestId('group-prompt-input')
  await expect(input).toBeVisible()
  await input.fill('Loaders')
  await input.press('Enter')

  expect((await groupsInDoc(page))[id]!.title).toBe('Loaders')
})

test('color preset and delete via the group menu; undo restores the colored group', async ({ page }) => {
  const id = await groupAroundN0(page)
  const header = await groupPoint(page, id, 'header')

  await page.mouse.click(...xy(header), { button: 'right' })
  await menuItem(page, 'core.group.color').hover()
  await menuItem(page, 'core.group.color.blue').click()
  expect((await groupsInDoc(page))[id]!.color).toBe('#355c7d')

  await page.mouse.click(...xy(header), { button: 'right' })
  await menuItem(page, 'core.group.color').hover()
  await expect(menuItem(page, 'core.group.color.blue')).toHaveClass(/checked/)
  await menuItem(page, 'core.group.delete').click()
  expect(Object.keys(await groupsInDoc(page))).toHaveLength(0)

  await page.keyboard.press('Control+z')
  const restored = (await groupsInDoc(page))[id]
  expect(restored).toBeDefined()
  expect(restored!.color).toBe('#355c7d')
})

test('groups are graph-definition scoped: invisible inside a subgraph drill-in', async ({ page }) => {
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  await identityViewport(page)

  // Create a group in the ROOT graph, then drill into the subgraph instance.
  await page.mouse.click(700, 750, { button: 'right' })
  await menuItem(page, 'core.canvas.addGroup').click()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().groups)).toHaveLength(1)

  const header = await headerPoint(page, 'n0')
  await page.mouse.dblclick(header.x, header.y)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('g1')
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().groups)).toHaveLength(0)

  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().groups)).toHaveLength(1)
})
