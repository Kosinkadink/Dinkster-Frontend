/**
 * editing implementation extensibility suite: typed context menus (registry-driven, core and
 * extensions share one surface) and collapsible schema sections. Section
 * schemas don't exist in the live backend yet, so those specs register a
 * synthetic schema through the SAME public extension API (registerSchemas)
 * and open a matching workflow document.
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

/** Page coordinates of a node's section strip center. */
async function sectionPoint(page: Page, nodeId: string, sectionId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, sectionId }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const row = node.layout.rows.find((row) => row.kind === 'section' && row.sectionId === sectionId)
      if (!row) throw new Error(`no section row '${sectionId}' on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return {
        x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
        y: rect.top + (node.y + row.y + row.height / 2) * vp.scale + vp.y,
      }
    },
    { nodeId, sectionId },
  )
}

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
const revision = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

const menu = (page: Page) => page.getByTestId('context-menu')
const menuItem = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`)
const openSubmenu = async (page: Page, id: string) => {
  await menuItem(page, id).hover()
  await expect(page.getByTestId('context-submenu').last()).toBeVisible()
}

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.annotations.some((annotation) => annotation.type === 'mock-legacy-discovery')) {
    await page.route('/system_stats', (route) =>
      route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
    )
    await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  }
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await identityViewport(page)
})

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

test('right-click on a node opens the menu; mode item commits and undoes', async ({ page }) => {
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await openSubmenu(page, 'core.node.mode')
  // Current mode is checked.
  await expect(menuItem(page, 'core.node.mode.active')).toHaveClass(/checked/)

  await menuItem(page, 'core.node.mode.muted').click()
  await expect(menu(page)).not.toBeVisible()
  const doc = await activeDoc(page)
  expect((doc.graphs['g0']!.nodes['n0'] as { mode?: string }).mode).toBe('muted')

  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect((undone.graphs['g0']!.nodes['n0'] as { mode?: string }).mode).toBeUndefined()
})

test('rename a node with instant original-name provenance, equal-name clear, and reset', async ({ page }) => {
  const point = await headerPoint(page, 'n0')
  const original = await page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'n0')!.layout as any).title as string,
  )

  await page.mouse.click(...xy(point), { button: 'right' })
  await menuItem(page, 'core.node.rename').click()
  const input = page.getByTestId('node-prompt-input')
  await expect(input).toBeVisible()
  await input.fill('Primary Loader')
  await input.press('Enter')
  expect(((await activeDoc(page)).graphs.g0!.nodes.n0! as any).title).toBe('Primary Loader')
  expect(await page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'n0')!.layout as any).titleRenamed as boolean,
  )).toBe(true)

  await page.mouse.move(point.x, point.y)
  await expect(page.getByTestId('app-tooltip')).toContainText(`Original: ${original}`, { timeout: 250 })

  await page.mouse.click(...xy(point), { button: 'right' })
  await expect(menuItem(page, 'core.node.resetName')).toBeVisible()
  await menuItem(page, 'core.node.rename').click()
  await input.fill(original)
  await input.press('Enter')
  expect(((await activeDoc(page)).graphs.g0!.nodes.n0! as any).title).toBeUndefined()

  await page.mouse.click(...xy(point), { button: 'right' })
  await expect(menuItem(page, 'core.node.resetName')).toHaveCount(0)
  await menuItem(page, 'core.node.rename').click()
  await input.fill('Primary Loader')
  await input.press('Enter')
  await page.mouse.click(...xy(point), { button: 'right' })
  await menuItem(page, 'core.node.resetName').click()
  expect(((await activeDoc(page)).graphs.g0!.nodes.n0! as any).title).toBeUndefined()
})

test('menu delete removes the node + links in ONE undo step', async ({ page }) => {
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  const before = await revision(page)
  await menuItem(page, 'core.node.delete').click()

  expect(await revision(page)).toBe(before + 1)
  const after = await activeDoc(page)
  expect(after.graphs['g0']!.nodes['n0']).toBeUndefined()
  expect(Object.keys(after.graphs['g0']!.links)).toHaveLength(0)

  await page.keyboard.press('Control+z')
  const restored = await activeDoc(page)
  expect(restored.graphs['g0']!.nodes['n0']).toBeDefined()
  expect(restored.graphs['g0']!.links['l2']).toBeDefined()
})

test('right-click empty canvas offers Add Node, which opens the palette there', async ({ page }) => {
  await page.mouse.click(700, 750, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await menuItem(page, 'core.canvas.addNode').click()
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('right-click a link offers Delete Link', async ({ page }) => {
  const mid = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const link = r.getScene().links[0]!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + ((link.x1 + link.x2) / 2) * vp.scale + vp.x,
      y: rect.top + ((link.y1 + link.y2) / 2) * vp.scale + vp.y,
    }
  })
  await page.mouse.click(mid.x, mid.y, { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await menuItem(page, 'core.link.delete').click()
  const doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(0)
})

test('Escape and outside click dismiss the menu without acting', async ({ page }) => {
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()

  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.mouse.click(700, 750)
  await expect(menu(page)).not.toBeVisible()
  // Nothing was committed by opening/dismissing menus.
  expect(await revision(page)).toBe(0)
})

test('keyboard: arrows enter and leave cascading panels, Enter invokes the active leaf', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }) => {
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  // Availability can make the preceding run action disabled, so point at
  // Mode before proving keyboard traversal inside and back out of its tier.
  await menuItem(page, 'core.node.mode').hover()
  await expect(menuItem(page, 'core.node.mode')).toHaveClass(/active/)
  const composite = page.locator('.context-menu-cascade')
  await expect(page.locator('[role="menu"]')).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  const submenu = page.getByTestId('context-submenu')
  await expect(submenu).toBeVisible()
  await expect(submenu).toHaveAttribute('role', 'group')
  await expect(menuItem(page, 'core.node.mode')).toHaveAttribute('aria-expanded', 'true')
  await expect(menuItem(page, 'core.node.mode')).toHaveAttribute('aria-controls', await submenu.getAttribute('id') ?? '')
  await expect(composite).toHaveAttribute('aria-activedescendant', await menuItem(page, 'core.node.mode.active').getAttribute('id') ?? '')
  await page.keyboard.press('ArrowDown')
  await expect(menuItem(page, 'core.node.mode.muted')).toHaveClass(/active/)
  const activeId = await composite.getAttribute('aria-activedescendant')
  expect(activeId).toBe(await menuItem(page, 'core.node.mode.muted').getAttribute('id'))
  expect(await page.locator(`#${activeId}`).count()).toBe(1)
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByTestId('context-submenu')).toHaveCount(0)
  await expect(menuItem(page, 'core.node.mode')).toHaveAttribute('aria-expanded', 'false')
  await expect(menuItem(page, 'core.node.mode')).not.toHaveAttribute('aria-controls', /.+/)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(menu(page)).not.toBeVisible()
  const doc = await activeDoc(page)
  expect((doc.graphs['g0']!.nodes['n0'] as { mode?: string }).mode).toBe('muted')
})

test('multi-selection: right-click a selected node acts on the whole selection', async ({ page }) => {
  await page.mouse.click(...xy(await headerPoint(page, 'n0')))
  await page.keyboard.down('Shift')
  await page.mouse.click(...xy(await headerPoint(page, 'n1')))
  await page.keyboard.up('Shift')
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '2')

  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menuItem(page, 'core.node.delete')).toContainText('Delete 2 Nodes')
  await openSubmenu(page, 'core.node.mode')
  await menuItem(page, 'core.node.mode.bypassed').click()
  const doc = await activeDoc(page)
  expect((doc.graphs['g0']!.nodes['n0'] as { mode?: string }).mode).toBe('bypassed')
  expect((doc.graphs['g0']!.nodes['n1'] as { mode?: string }).mode).toBe('bypassed')
})

test('node color menu tints the selected nodes and Default clears in one undo step', async ({ page }) => {
  await page.mouse.click(...xy(await headerPoint(page, 'n0')))
  await page.keyboard.down('Shift')
  await page.mouse.click(...xy(await headerPoint(page, 'n1')))
  await page.keyboard.up('Shift')

  const before = await revision(page)
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await openSubmenu(page, 'core.node.color')
  await expect(menuItem(page, 'core.node.color.default')).toHaveClass(/checked/)
  await menuItem(page, 'core.node.color.blue').click()
  expect(await revision(page)).toBe(before + 1)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .filter((node) => node.id === 'n0' || node.id === 'n1')
    .map((node) => node.color))).toEqual(['#355c7d', '#355c7d'])

  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await openSubmenu(page, 'core.node.color')
  await expect(menuItem(page, 'core.node.color.blue')).toHaveClass(/checked/)
  await menuItem(page, 'core.node.color.default').click()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .filter((node) => node.id === 'n0' || node.id === 'n1')
    .map((node) => node.color))).toEqual([undefined, undefined])

  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .filter((node) => node.id === 'n0' || node.id === 'n1')
    .map((node) => node.color))).toEqual(['#355c7d', '#355c7d'])
})

test('oversized root and child menus stay in a short viewport, flip left, and retain scroll identity', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 700, height: 350 })
  await page.addStyleTag({ content: '.context-menu .menu-item { padding-top: 30px; padding-bottom: 30px; }' })
  await page.getByRole('button', { name: 'Toggle right rail' }).click()
  await page.getByRole('button', { name: 'Hide minimap' }).click()
  const canvas = await page.getByTestId('graph-canvas').boundingBox()
  expect(canvas).not.toBeNull()
  await page.evaluate(({ canvasWidth, canvasHeight }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'n0')!
    renderer.setViewport({
      x: canvasWidth / 2 - node.x - node.layout.width / 2,
      y: canvasHeight - node.y - node.layout.headerHeight / 2 - 30,
      scale: 1,
    })
  }, { canvasWidth: canvas!.width, canvasHeight: canvas!.height })
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await openSubmenu(page, 'core.node.color')
  const rootPanel = page.locator('.context-menu[data-menu-depth="0"]')
  const childPanel = page.locator('.context-menu[data-menu-depth="1"]')
  await expect(childPanel).toBeVisible()
  const [rootBox, childBox] = await Promise.all([rootPanel.boundingBox(), childPanel.boundingBox()])
  expect(rootBox).not.toBeNull()
  expect(childBox).not.toBeNull()
  expect(childBox!.x).toBeLessThan(rootBox!.x)
  expect(childBox!.x).toBeGreaterThanOrEqual(8)
  expect(childBox!.x + childBox!.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth - 8))
  expect(childBox!.y).toBeGreaterThanOrEqual(8)
  expect(childBox!.y + childBox!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight - 8))
  expect(rootBox!.y).toBeGreaterThanOrEqual(8)
  expect(rootBox!.y + rootBox!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight - 8))
  expect(await rootPanel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  expect(await childPanel.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

  await page.keyboard.press('ArrowRight')
  await childPanel.evaluate((element) => {
    element.dataset['identityProbe'] = 'stable'
    element.scrollTop = 80
  })
  const scrollTop = await childPanel.evaluate((element) => element.scrollTop)
  expect(scrollTop).toBeGreaterThan(0)
  await page.keyboard.press('ArrowDown')
  await expect(childPanel).toHaveAttribute('data-identity-probe', 'stable')
  expect(await childPanel.evaluate((element) => element.scrollTop)).toBe(scrollTop)
  await menuItem(page, 'core.node.color.blue').hover()
  await expect(childPanel).toHaveAttribute('data-identity-probe', 'stable')
  expect(await childPanel.evaluate((element) => element.scrollTop)).toBe(scrollTop)

  const screenshotPath = testInfo.outputPath('contained-cascading-context-menu.png')
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('contained-cascading-context-menu', { path: screenshotPath, contentType: 'image/png' })

  await page.setViewportSize({ width: 700, height: 700 })
  await expect.poll(async () => {
    const boxes = await Promise.all([rootPanel.boundingBox(), childPanel.boundingBox()])
    return boxes.every((box) => box !== null && box.y >= 8 && box.y + box.height <= 692)
      && boxes[0]!.height > rootBox!.height
      && boxes[1]!.height > childBox!.height
  }).toBe(true)
  await expect.poll(() => page.evaluate(() => {
    const child = document.querySelector<HTMLElement>('[data-menu-depth="1"]')!
    const owner = document.querySelector<HTMLElement>('[data-item-id="core.node.color"]')!
    const offsetParent = child.offsetParent as HTMLElement
    const offsetRect = offsetParent.getBoundingClientRect()
    const ownerTop = owner.getBoundingClientRect().top - offsetRect.top
    const expectedTop = Math.min(
      Math.max(ownerTop, 8),
      Math.max(8, offsetParent.clientHeight - 8 - child.offsetHeight),
    ) + offsetRect.top
    return Math.abs(child.getBoundingClientRect().top - expectedTop)
  })).toBeLessThanOrEqual(1)
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()
})

// ---------------------------------------------------------------------------
// Sections (synthetic schema registered through the public extension API)
// ---------------------------------------------------------------------------

async function openSectionedWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'SectionedTest',
        displayName: 'Sectioned Test',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [
          { kind: 'input', id: 'a', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
          { kind: 'section', id: 'adv', displayName: 'Advanced' },
          {
            kind: 'input',
            id: 'w',
            type: { kind: 'concrete', name: 'INT' },
            optional: false,
            section: 'adv',
            widget: { widgetType: 'INT', options: {}, default: 20 },
          },
          { kind: 'input', id: 'b', type: { kind: 'concrete', name: 'IMAGE' }, optional: false, section: 'adv' },
          { kind: 'output', id: 'x', type: { kind: 'concrete', name: 'IMAGE' } },
        ],
      },
      {
        type: 'ProducerTest',
        displayName: 'Producer Test',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [{ kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' } }],
      },
    ])
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-sections',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              p0: { id: 'p0', type: 'ProducerTest', values: {} },
              s0: { id: 's0', type: 'SectionedTest', values: { w: 3 } },
            },
            links: {
              l1: { id: 'l1', from: { node: 'p0', port: 'out0' }, to: { node: 's0', port: 'b' } },
            },
            nets: {},
            reroutes: {},
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                p0: { position: { x: 60, y: 120 } },
                s0: { position: { x: 420, y: 120 } },
              },
            },
          },
        },
      },
      'Sections',
    )
  })
  await expect(page.getByTestId('tab-bar').locator('.tab', { hasText: 'Sections' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    const scene = window.__dinksterTest!.renderer!.getScene()
    const node = scene.nodes.find((candidate) => candidate.id === 's0')
    return {
      activeTitle: tab?.title,
      graphId: scene.graphId,
      widgetReady: node?.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'w') ?? false,
    }
  })).toEqual({ activeTitle: 'Sections', graphId: 'g0', widgetReady: true })
  await identityViewport(page)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getViewport()))
    .toEqual({ x: 0, y: 0, scale: 1 })
}

const sectionState = (page: Page, nodeId: string) =>
  page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((n) => n.id === nodeId)!
    return {
      rowKinds: node.layout.rows.map((row) => row.kind),
      height: node.layout.height,
      pinIds: node.layout.pins.map((p) => `${p.direction}:${p.portId}`).sort(),
      viewSections: window.__dinksterTest!.app.activeTab()!.store.doc.view.graphs['g0']!.nodes[nodeId]!.sections,
    }
  }, nodeId)

test('clicking the section strip collapses; height shrinks; undo re-expands', async ({ page }) => {
  await openSectionedWorkflow(page)

  const open = await sectionState(page, 's0')
  expect(open.rowKinds).toEqual(['ports', 'section', 'widget', 'ports'])
  expect(open.viewSections).toBeUndefined()

  await page.mouse.click(...xy(await sectionPoint(page, 's0', 'adv')))
  const closed = await sectionState(page, 's0')
  expect(closed.viewSections).toEqual({ adv: { collapsed: true } })
  expect(closed.rowKinds).toEqual(['ports', 'section'])
  expect(closed.height).toBeLessThan(open.height)
  // The connected hidden port keeps its pin; the unconnected widget loses it.
  expect(closed.pinIds).toContain('in:b')
  expect(closed.pinIds).not.toContain('in:w')

  // Clicking the strip again expands (an override flip, still one command).
  await page.mouse.click(...xy(await sectionPoint(page, 's0', 'adv')))
  expect((await sectionState(page, 's0')).rowKinds).toEqual(['ports', 'section', 'widget', 'ports'])

  // Both toggles undo cleanly.
  await page.keyboard.press('Control+z')
  expect((await sectionState(page, 's0')).rowKinds).toEqual(['ports', 'section'])
  await page.keyboard.press('Control+z')
  expect((await sectionState(page, 's0')).viewSections).toBeUndefined()
})

test('noodle into a collapsed section stays anchored on the header row', async ({ page }) => {
  await openSectionedWorkflow(page)
  await page.mouse.click(...xy(await sectionPoint(page, 's0', 'adv')))

  const anchored = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const scene = r.getScene()
    const node = scene.nodes.find((n) => n.id === 's0')!
    const header = node.layout.rows.find((row) => row.kind === 'section')!
    const link = scene.links.find((l) => l.to.kind === 'port' && l.to.node === 's0')!
    return { linkY: link.y2, headerCenter: node.y + header.y + header.height / 2 }
  })
  expect(anchored.linkY).toBe(anchored.headerCenter)
})

test('right-click on the section strip offers Collapse/Expand', async ({ page }) => {
  await openSectionedWorkflow(page)
  await page.mouse.click(...xy(await sectionPoint(page, 's0', 'adv')), { button: 'right' })
  await expect(menuItem(page, 'core.section.toggle')).toContainText('Collapse Section')
  await menuItem(page, 'core.section.toggle').click()
  expect((await sectionState(page, 's0')).viewSections).toEqual({ adv: { collapsed: true } })

  await page.mouse.click(...xy(await sectionPoint(page, 's0', 'adv')), { button: 'right' })
  await expect(menuItem(page, 'core.section.toggle')).toContainText('Expand Section')
  await page.keyboard.press('Escape')
})

// ---------------------------------------------------------------------------
// Modified indicators + reset to defaults (fixture: w default 20, stored 3)
// ---------------------------------------------------------------------------

/** Page coordinates of a widget row's center. */
async function widgetPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, inputId }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const row = node.layout.rows.find((row) => row.kind === 'widget' && row.inputId === inputId)
      if (!row) throw new Error(`no widget row '${inputId}' on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return {
        x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
        y: rect.top + (node.y + row.y + row.height / 2) * vp.scale + vp.y,
      }
    },
    { nodeId, inputId },
  )
}

const sectionRow = (page: Page, nodeId: string, sectionId: string) =>
  page.evaluate(
    ({ nodeId, sectionId }) => {
      const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === nodeId)!
      return node.layout.rows.find((row) => row.kind === 'section' && row.sectionId === sectionId) as {
        collapsed: boolean
        hiddenModified?: number
      }
    },
    { nodeId, sectionId },
  )

test('widget context menu resets to the LIVE schema default; undo restores', async ({ page }) => {
  await openSectionedWorkflow(page)
  await page.mouse.click(...xy(await widgetPoint(page, 's0', 'w')), { button: 'right' })
  await expect(menuItem(page, 'core.widget.reset')).toContainText('Reset to Default')
  await menuItem(page, 'core.widget.reset').click()

  let doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['s0']!.values['w']).toBe(20) // written EXPLICITLY

  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['s0']!.values['w']).toBe(3)

  // At the default now the item renders disabled, and invoking it is inert.
  await page.keyboard.press('Control+y')
  await page.mouse.click(...xy(await widgetPoint(page, 's0', 'w')), { button: 'right' })
  await expect(menuItem(page, 'core.widget.reset')).toHaveClass(/disabled/)
  await page.keyboard.press('Escape')
})

test('collapsed section carries hiddenModified; section reset clears it in ONE undo step', async ({ page }) => {
  await openSectionedWorkflow(page)
  // Collapse: the off-default w (3 vs 20) is now hidden -> indicator count 1.
  await page.mouse.click(...xy(await sectionPoint(page, 's0', 'adv')))
  expect(await sectionRow(page, 's0', 'adv')).toMatchObject({ collapsed: true, hiddenModified: 1 })

  await page.mouse.click(...xy(await sectionPoint(page, 's0', 'adv')), { button: 'right' })
  await menuItem(page, 'core.section.reset').click()
  expect(await sectionRow(page, 's0', 'adv')).not.toHaveProperty('hiddenModified')
  const doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['s0']!.values['w']).toBe(20)

  await page.keyboard.press('Control+z')
  expect(await sectionRow(page, 's0', 'adv')).toMatchObject({ hiddenModified: 1 })
})

test('node reset covers all widgets; hidden on nodes without resettable widgets', async ({ page }) => {
  await openSectionedWorkflow(page)
  await page.mouse.click(...xy(await headerPoint(page, 's0')), { button: 'right' })
  await expect(menuItem(page, 'core.node.reset')).toContainText('Reset All Widgets to Defaults')
  await menuItem(page, 'core.node.reset').click()
  const doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['s0']!.values['w']).toBe(20)

  // p0 has no widgets at all: the contribution hides, no reset item appears.
  await page.mouse.click(...xy(await headerPoint(page, 'p0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(menuItem(page, 'core.node.reset')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('FR14 a disabled menu item cannot be invoked by mouse or Enter, and arrows skip it', async ({ page }) => {
  await openSectionedWorkflow(page)
  // Bring every widget to its default so the node reset renders disabled.
  await page.mouse.click(...xy(await headerPoint(page, 's0')), { button: 'right' })
  await menuItem(page, 'core.node.reset').click()
  await expect(menu(page)).not.toBeVisible()

  await page.mouse.click(...xy(await headerPoint(page, 's0')), { button: 'right' })
  const reset = menuItem(page, 'core.node.reset')
  await expect(reset).toHaveClass(/disabled/)
  const before = await revision(page)

  // Mouse: mousedown on the disabled row invokes nothing; the menu stays
  // open. (force: the row carries aria-disabled, which Playwright's
  // actionability check refuses to click - the point IS clicking it.)
  await reset.click({ force: true })
  await expect(menu(page)).toBeVisible()

  // Hover may highlight it (pointer honesty), but Enter still refuses.
  await reset.hover()
  await expect(reset).toHaveClass(/active/)
  await page.keyboard.press('Enter')
  await expect(menu(page)).toBeVisible()

  // Arrow navigation skips the disabled row in BOTH directions: a full walk
  // down to the last row and back up to the first never lands on it.
  const rows = await page.getByTestId('context-menu-item').count()
  for (let i = 0; i < rows; i++) {
    await page.keyboard.press('ArrowDown')
    await expect(reset).not.toHaveClass(/active/)
  }
  for (let i = 0; i < rows; i++) {
    await page.keyboard.press('ArrowUp')
    await expect(reset).not.toHaveClass(/active/)
  }
  expect(await revision(page)).toBe(before)
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()
})

test('FR14 the initial highlight skips a disabled first row; a disabled row refuses Enter and mousedown', async ({ page }) => {
  await openSectionedWorkflow(page)
  // Bring w to its default so core.widget.reset renders disabled.
  await page.mouse.click(...xy(await widgetPoint(page, 's0', 'w')), { button: 'right' })
  await menuItem(page, 'core.widget.reset').click()
  await expect(menu(page)).not.toBeVisible()

  // The widget menu is now [disabled reset ('80-values'), enabled expose
  // toggle ('85-expose')]: the INITIAL highlight must skip the disabled
  // first row and land on the first enabled item. (An all-disabled menu is
  // no longer constructible on a widget target - the expose toggle is
  // always enabled - so the index-0 fallback stays a code-level guard.)
  await page.mouse.click(...xy(await widgetPoint(page, 's0', 'w')), { button: 'right' })
  await expect(page.getByTestId('context-menu-item')).toHaveCount(2)
  await expect(menuItem(page, 'core.widget.reset')).toHaveClass(/disabled/)
  await expect(menuItem(page, 'core.widget.expose.toggle')).toHaveClass(/active/)
  await expect(menuItem(page, 'core.widget.reset')).not.toHaveClass(/active/)
  // No enabled item above: ArrowUp stays put instead of landing on disabled.
  await page.keyboard.press('ArrowUp')
  await expect(menuItem(page, 'core.widget.expose.toggle')).toHaveClass(/active/)

  // Hover moves the highlight onto ANY row, including a disabled one - but
  // Enter and mousedown on it still refuse: disabled is never invokable.
  await menuItem(page, 'core.widget.reset').hover()
  await expect(menuItem(page, 'core.widget.reset')).toHaveClass(/active/)
  const before = await revision(page)
  await page.keyboard.press('Enter')
  await expect(menu(page)).toBeVisible()
  expect(await revision(page)).toBe(before)
  // force: aria-disabled rows fail Playwright actionability by design.
  await menuItem(page, 'core.widget.reset').click({ force: true })
  await expect(menu(page)).toBeVisible()
  expect(await revision(page)).toBe(before)
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()
})

test('switching tabs dismisses a stale menu', async ({ page }) => {
  await page.mouse.click(...xy(await headerPoint(page, 'n0')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  await expect(menu(page)).not.toBeVisible()
})

test('create empty subgraph drills in and one undo removes the definition and repairs navigation', async ({ page }) => {
  await page.evaluate(() => { (window.__dinksterTest!.app as any).createWorkflow() })
  await identityViewport(page)
  const canvas = page.getByTestId('graph-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('graph canvas has no bounds')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  await expect(menuItem(page, 'core.canvas.createSubgraph')).toBeVisible()
  await menuItem(page, 'core.canvas.createSubgraph').click()
  await expect(page.getByTestId('graph-breadcrumb')).toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.graphStack.get().at(-1))).toBe('g0')
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0 as any)?.boundary)).toEqual({ inputs: [], outputs: [] })
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('graph-breadcrumb')).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0)).toBeUndefined()
})
