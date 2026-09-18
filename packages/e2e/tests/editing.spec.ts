/**
 * editing suite: selection, node drag, undo/redo, link disconnect /
 * reconnect / rewire, delete cascade, widget editing, and subgraph drill-in.
 * Real pointer/keyboard input against the live app; document assertions go
 * through the __dinksterTest bridge (commands -> DocumentStore -> doc).
 */
import { expect, test, type Page } from './fixtures.js'

/** Reset the viewport to identity so world coords == canvas CSS pixels. */
async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

type Part =
  | { kind: 'header' }
  | { kind: 'body' }
  | { kind: 'pin'; direction: 'in' | 'out'; portId: string }
  | { kind: 'widget'; inputId: string }

/** Page coordinates of a feature of a scene node (assumes identity viewport). */
async function pointOn(page: Page, nodeId: string, part: Part): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, part }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const toPage = (wx: number, wy: number) => ({
        x: rect.left + wx * vp.scale + vp.x,
        y: rect.top + wy * vp.scale + vp.y,
      })
      const l = node.layout
      switch (part.kind) {
        case 'header':
          return toPage(node.x + l.width / 2, node.y + l.headerHeight / 2)
        case 'body': {
          const row = l.rows.find((r) => r.kind === 'ports')
          const y = row ? row.y + row.height / 2 : l.headerHeight + 10
          return toPage(node.x + l.width / 2, node.y + y)
        }
        case 'pin': {
          const pin = l.pins.find((p) => p.direction === part.direction && p.portId === part.portId)
          if (!pin) throw new Error(`no pin ${part.direction}:${part.portId} on '${nodeId}'`)
          return toPage(node.x + (part.direction === 'in' ? 0 : l.width), node.y + pin.y)
        }
        case 'widget': {
          const row = l.rows.find((r) => r.kind === 'widget' && r.inputId === part.inputId)
          if (!row) throw new Error(`no widget row '${part.inputId}' on '${nodeId}'`)
          return toPage(node.x + l.width / 2, node.y + row.y + row.height / 2)
        }
      }
    },
    { nodeId, part },
  )
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  // Two intermediate moves: cross the drag threshold, then land exactly.
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

async function openauditInteractionFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([{
      type: 'auditPlacementTest', displayName: 'audit KSampler', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        {
          kind: 'input', id: 'steps', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: { min: 1, max: 100 }, default: 20 },
        },
        { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'INT' } },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-interaction', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          n0: { id: 'n0', type: 'auditPlacementTest', values: { steps: 20 } },
          n1: { id: 'n1', type: 'auditPlacementTest', values: { steps: 20 } },
        },
        links: {
          l0: { id: 'l0', from: { node: 'n0', port: 'result' }, to: { node: 'n1', port: 'steps' } },
        },
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: {
        n0: { position: { x: 180, y: 160 } },
        n1: { position: { x: 600, y: 160 } },
      } } } },
    }, 'audit Interaction')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.id === 'audit-interaction' && 'status' in tab.store
  })
}

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.annotations.some((annotation) => annotation.type === 'mock-legacy-discovery')) {
    await page.route('/system_stats', (route) =>
      route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
    )
    await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  }
  await page.goto('/')
  // Scenes need schemas; wait for the registry before touching the canvas.
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await identityViewport(page)
})

test('bridge reports an unrecognized node type', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'unknown-node', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { unknown: { id: 'unknown', type: 'Definitely.Not.In.The.Registry', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      } },
      view: { graphs: { g0: { nodes: { unknown: { position: { x: 200, y: 200 } } } } } },
    }, 'Unknown Node')
  })

  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'unknown')?.unrecognized,
  )).toBe(true)
})

test('click selects a node, empty-space click clears', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'header' })))
  await expect(canvas).toHaveAttribute('data-selection', '1')
  // Well inside the canvas (the rail starts ~1140px in) but empty world space.
  await page.mouse.click(700, 750)
  await expect(canvas).toHaveAttribute('data-selection', '0')
})

test('plain empty-canvas drag pans the viewport and selects nothing', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  // Plain drag from empty space is the pan gesture: the viewport moves by
  // the drag delta, no marquee appears, and nothing commits.
  const before = await activeDoc(page)
  await drag(page, { x: 700, y: 700 }, { x: 820, y: 740 })
  const vp = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  expect(vp.x).toBe(120)
  expect(vp.y).toBe(40)
  await expect(canvas).toHaveAttribute('data-selection', '0')
  expect(await activeDoc(page)).toEqual(before)
  // Reset the viewport for the assertions below.
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
})

test('Ctrl+A selects every selectable citizen in the current scene', async ({ page }) => {
  await page.keyboard.press('Control+A')

  const parity = await page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene() as any
    const controller = window.__dinksterTest!.controller!
    return {
      selected: {
        nodes: [...controller.getSelection()].sort(),
        reroutes: [...controller.getRerouteSelection()].sort(),
        valueSources: [...controller.getValueSourceSelection()].sort(),
        selectors: [...controller.getSelectorSelection()].sort(),
        groups: [...controller.getGroupSelection()].sort(),
      },
      scene: {
        nodes: [...scene.nodes.map((node: { id: string }) => node.id), ...scene.boundaryNodes.map((node: { side: string }) => `@boundary:${node.side}`)].sort(),
        reroutes: scene.reroutes.map((item: { id: string }) => item.id).sort(),
        valueSources: scene.valueSources.map((item: { id: string }) => item.id).sort(),
        selectors: scene.selectors.map((item: { id: string }) => item.id).sort(),
        groups: scene.groups.map((item: { id: string }) => item.id).sort(),
      },
    }
  })

  expect(parity.selected).toEqual(parity.scene)
})

test('Ctrl+empty-canvas drag sweeps a marquee that selects covered nodes', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  // Sweep a rectangle around every scene node, starting in empty space just
  // above-left of the nodes (NOT the canvas corner: the DOM views control
  // sits at the canvas top-left and would swallow the pointerdown).
  const sweep = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const nodes = r.getScene().nodes
    const minX = Math.min(...nodes.map((n) => n.x))
    const minY = Math.min(...nodes.map((n) => n.y))
    const maxX = Math.max(...nodes.map((n) => n.x + n.layout.width))
    const maxY = Math.max(...nodes.map((n) => n.y + n.layout.height))
    const toPage = (wx: number, wy: number) => ({
      x: rect.left + wx * vp.scale + vp.x,
      y: rect.top + wy * vp.scale + vp.y,
    })
    const from = toPage(minX - 20, minY - 20)
    const control = document.querySelector('.canvas-view-control')?.getBoundingClientRect()
    if (control && from.x < control.right + 4 && from.y < control.bottom + 4) {
      throw new Error('marquee start would land on the canvas views control; fixture layout changed')
    }
    return { from, to: toPage(maxX + 20, maxY + 20), count: nodes.length }
  })
  await page.keyboard.down('Control')
  await drag(page, sweep.from, sweep.to)
  await page.keyboard.up('Control')
  await expect(canvas).toHaveAttribute('data-selection', String(sweep.count))
  // The sweep selects; it never pans and commits nothing.
  const vp = await page.evaluate(() => window.__dinksterTest!.renderer!.getViewport())
  expect(vp).toEqual({ x: 0, y: 0, scale: 1 })
  // A motionless empty click clears the sweep.
  await page.mouse.click(700, 750)
  await expect(canvas).toHaveAttribute('data-selection', '0')
})

test('marquee-selected node and reroute move together and undo atomically', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'heterogeneous-move', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'EmptyImage', values: { width: 64, height: 64, batch_size: 1, color: 0 } },
        n1: { id: 'n1', type: 'PreviewImage', values: {} },
      }, links: {
        l0: { id: 'l0', from: { node: 'n0', port: 'out0' }, to: { reroute: 'r0' } },
        l1: { id: 'l1', from: { reroute: 'r0' }, to: { node: 'n1', port: 'images' } },
      }, nets: {}, reroutes: { r0: { id: 'r0' } }, nextOrdinal: 5 } },
      view: { graphs: { g0: {
        nodes: { n0: { position: { x: 200, y: 200 } }, n1: { position: { x: 800, y: 200 } } },
        reroutes: { r0: { position: { x: 500, y: 260 } } },
      } } },
    }, 'Heterogeneous Move')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const sweep = await page.evaluate(() => {
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { from: { x: rect.left + 150, y: rect.top + 150 }, to: { x: rect.left + 540, y: rect.top + 400 } }
  })
  await page.keyboard.down('Control')
  await drag(page, sweep.from, sweep.to)
  await page.keyboard.up('Control')
  const canvas = page.getByTestId('graph-canvas')
  // data-selection is the total heterogeneous selection; the kind-specific
  // attributes below expose its composition.
  await expect(canvas).toHaveAttribute('data-selection', '2')
  await expect(canvas).toHaveAttribute('data-reroute-selection', '1')

  const start = await pointOn(page, 'n0', { kind: 'header' })
  await drag(page, start, { x: start.x + 80, y: start.y + 40 })
  let doc = await activeDoc(page)
  expect(doc.view.graphs.g0!.nodes.n0!.position).toEqual({ x: 280, y: 240 })
  expect(doc.view.graphs.g0!.reroutes!.r0!.position).toEqual({ x: 580, y: 300 })

  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(doc.view.graphs.g0!.nodes.n0!.position).toEqual({ x: 200, y: 200 })
  expect(doc.view.graphs.g0!.reroutes!.r0!.position).toEqual({ x: 500, y: 260 })
})

test('dragging a node commits ONE node.move; undo/redo round-trips', async ({ page }) => {
  const start = await pointOn(page, 'n0', { kind: 'header' })
  await drag(page, start, { x: start.x + 100, y: start.y + 50 })

  const moved = await activeDoc(page)
  expect(moved.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: 180, y: 170 })

  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: 80, y: 120 })

  await page.keyboard.press('Control+Shift+z')
  const redone = await activeDoc(page)
  expect(redone.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: 180, y: 170 })
})

test('dragging a connected input pin into space disconnects; undo restores', async ({ page }) => {
  const pin = await pointOn(page, 'n1', { kind: 'pin', direction: 'in', portId: 'images' })
  await drag(page, pin, { x: pin.x + 150, y: pin.y + 150 })

  const after = await activeDoc(page)
  expect(Object.keys(after.graphs['g0']!.links)).toHaveLength(0)

  await page.keyboard.press('Control+z')
  const restored = await activeDoc(page)
  expect(restored.graphs['g0']!.links['l2']).toBeDefined()
})

test('dragging output pin -> compatible input creates a link (replacing the old driver)', async ({ page }) => {
  const from = await pointOn(page, 'n0', { kind: 'pin', direction: 'out', portId: 'out0' })
  const to = await pointOn(page, 'n1', { kind: 'pin', direction: 'in', portId: 'images' })
  await drag(page, from, to)

  const doc = await activeDoc(page)
  const links = Object.values(doc.graphs['g0']!.links)
  // Old driver (l2) displaced by the new link in the same gesture; still one driver.
  expect(links).toHaveLength(1)
  expect(links[0]!.from).toEqual({ node: 'n0', port: 'out0' })
  expect(links[0]!.to).toEqual({ node: 'n1', port: 'images' })
})

test('delete removes the selection and cascades its links; undo restores both', async ({ page }) => {
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'header' })))
  await page.keyboard.press('Delete')

  const after = await activeDoc(page)
  expect(after.graphs['g0']!.nodes['n0']).toBeUndefined()
  expect(Object.keys(after.graphs['g0']!.links)).toHaveLength(0)
  await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '0')

  await page.keyboard.press('Control+z')
  const restored = await activeDoc(page)
  expect(restored.graphs['g0']!.nodes['n0']).toBeDefined()
  expect(restored.graphs['g0']!.links['l2']).toBeDefined()
})

test('clicking a widget row opens the editor; Enter commits node.setValue', async ({ page }) => {
  const row = await pointOn(page, 'n0', { kind: 'widget', inputId: 'width' })
  await page.mouse.click(row.x, row.y)

  const editor = page.getByTestId('widget-editor').locator('input')
  await expect(editor).toBeVisible()
  await expect(editor).toHaveValue('64')
  await editor.fill('128')
  await editor.press('Enter')

  await expect(page.getByTestId('widget-editor')).not.toBeVisible()
  const doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['n0']!.values['width']).toBe(128)

  // Escape closes without committing.
  await page.mouse.click(row.x, row.y)
  await page.getByTestId('widget-editor').locator('input').press('Escape')
  const unchanged = await activeDoc(page)
  expect(unchanged.graphs['g0']!.nodes['n0']!.values['width']).toBe(128)
})

test('double-clicking a subgraph instance drills in; breadcrumb navigates back', async ({ page }) => {
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  await identityViewport(page)

  const header = await pointOn(page, 'n0', { kind: 'header' })
  await page.mouse.dblclick(header.x, header.y)

  await expect(page.getByTestId('graph-breadcrumb')).toBeVisible()
  await expect(page.getByTestId('graph-breadcrumb')).toContainText('Image source')
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.graphStack.get())).toEqual(['g0', 'g1'])
  // The inner graph is what's on the canvas now.
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('g1')

  await page.keyboard.press('Control+A')
  expect(await page.evaluate(() => [...window.__dinksterTest!.controller!.getSelection()].sort())).toEqual([
    '@boundary:inputs', '@boundary:outputs', 'n0',
  ])

  // Edits inside the drill-in target the inner graph definition.
  await identityViewport(page)
  const inner = await pointOn(page, 'n0', { kind: 'header' })
  await drag(page, inner, { x: inner.x + 50, y: inner.y + 25 })
  const doc = await activeDoc(page)
  expect(doc.view.graphs['g1']!.nodes['n0']!.position).toEqual({ x: 150, y: 125 })

  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await expect(page.getByTestId('graph-breadcrumb')).not.toBeVisible()
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('g0')
})

/** Page coords of a link's curve midpoint (t=0.5 == endpoint midpoint). */
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

/** Page coords of a node resize handle + its layout geometry. */
async function resizePoint(
  page: Page,
  nodeId: string,
  handle: 'nw' | 'se' = 'se',
): Promise<{ x: number; y: number; nodeX: number; nodeY: number; width: number; height: number; minWidth: number; minHeight: number }> {
  return page.evaluate(({ nodeId, handle }) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const l = node.layout
    const wx = handle === 'nw' ? node.x : node.x + l.width
    const wy = handle === 'nw' ? node.y : node.y + l.height
    return {
      x: rect.left + wx * vp.scale + vp.x,
      y: rect.top + wy * vp.scale + vp.y,
      nodeX: node.x,
      nodeY: node.y,
      width: l.width,
      height: l.height,
      minWidth: l.minWidth,
      minHeight: l.minHeight,
    }
  }, { nodeId, handle })
}

const revision = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

test('clicking a link selects it; Delete removes it in ONE undo step', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.click(...xy(await linkMidpoint(page, 'l2')))
  await expect(canvas).toHaveAttribute('data-link-selection', '1')
  await expect(canvas).toHaveAttribute('data-selection', '0')

  const before = await revision(page)
  await page.keyboard.press('Delete')
  expect(await revision(page)).toBe(before + 1)
  const after = await activeDoc(page)
  expect(Object.keys(after.graphs['g0']!.links)).toHaveLength(0)
  await expect(canvas).toHaveAttribute('data-link-selection', '0')

  await page.keyboard.press('Control+z')
  const restored = await activeDoc(page)
  expect(restored.graphs['g0']!.links['l2']).toBeDefined()
})

test('selecting a node clears link selection and vice versa', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.click(...xy(await linkMidpoint(page, 'l2')))
  await expect(canvas).toHaveAttribute('data-link-selection', '1')
  // The midpoint click also opens the link menu; dismiss it so the next
  // click reaches the canvas instead of the menu layer.
  await page.keyboard.press('Escape')
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'header' })))
  await expect(canvas).toHaveAttribute('data-selection', '1')
  await expect(canvas).toHaveAttribute('data-link-selection', '0')
})

test('dragging NW commits position and size atomically; undo restores both', async ({ page }) => {
  const corner = await resizePoint(page, 'n0', 'nw')
  const before = await revision(page)
  await page.mouse.move(corner.x, corner.y)
  await expect(page.getByTestId('graph-canvas')).toHaveCSS('cursor', 'nwse-resize')
  await drag(page, corner, { x: corner.x - 60, y: corner.y - 40 })

  expect(await revision(page)).toBe(before + 1)
  const doc = await activeDoc(page)
  expect(doc.view.graphs['g0']!.nodes['n0']!.size).toEqual({
    width: Math.round(corner.width + 60), height: Math.round(corner.height + 40),
  })
  expect(doc.view.graphs['g0']!.nodes['n0']!.position).toEqual({ x: corner.nodeX - 60, y: corner.nodeY - 40 })
  const resized = await resizePoint(page, 'n0')
  expect(resized.width).toBe(Math.round(corner.width + 60))

  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.view.graphs['g0']!.nodes['n0']!.size).toBeUndefined()
  const back = await resizePoint(page, 'n0')
  expect(back.width).toBe(corner.width)
  expect(back.nodeX).toBe(corner.nodeX)
  expect(back.nodeY).toBe(corner.nodeY)
})

test('resize clamps to the natural minimum size', async ({ page }) => {
  const corner = await resizePoint(page, 'n0')
  await drag(page, corner, { x: corner.x - 500, y: corner.y - 500 })
  const doc = await activeDoc(page)
  expect(doc.view.graphs['g0']!.nodes['n0']!.size).toEqual({
    width: Math.round(corner.minWidth),
    height: Math.round(corner.minHeight),
  })
})

test('live resize paints every intermediate node geometry and remains one undo step at each zoom', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }) => {
  await openauditInteractionFixture(page)
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.roundRect
    const originalMoveTo = CanvasRenderingContext2D.prototype.moveTo
    ;(window as any).__resizePaintOps = [] as number[][]
    ;(window as any).__resizeMoveTos = [] as number[][]
    CanvasRenderingContext2D.prototype.roundRect = function (...args: Parameters<typeof original>) {
      if (typeof args[0] === 'number') (window as any).__resizePaintOps.push(args.slice(0, 4))
      return original.apply(this, args)
    }
    CanvasRenderingContext2D.prototype.moveTo = function (...args: Parameters<typeof originalMoveTo>) {
      ;(window as any).__resizeMoveTos.push(args)
      return originalMoveTo.apply(this, args)
    }
  })

  for (const scale of [0.5, 1, 2]) {
    await page.evaluate((nextScale) => {
      window.__dinksterTest!.renderer!.setViewport({
        x: 180 - 180 * nextScale,
        y: 160 - 160 * nextScale,
        scale: nextScale,
      })
      window.__dinksterTest!.controller!.setSelection(['n0'], [], [])
    }, scale)
    await expect(page.getByTestId('graph-canvas')).toHaveAttribute('data-selection', '1')
    const corner = await resizePoint(page, 'n0')
    const before = await activeDoc(page)
    const beforeView = structuredClone(before.view.graphs.g0!.nodes.n0)
    const startRevision = await revision(page)
    await page.mouse.move(corner.x, corner.y)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    await page.mouse.down()

    const previews: Array<{ x: number; y: number; width: number; height: number }> = []
    for (const delta of [12, 24, 36]) {
      await page.evaluate(() => { (window as any).__resizePaintOps = [] })
      await page.evaluate(() => { (window as any).__resizeMoveTos = [] })
      await page.mouse.move(corner.x + delta, corner.y + delta)
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
      await expect.poll(
        () => page.evaluate(() => (window.__dinksterTest!.renderer!.getOverlay() as any).resizePreview),
        { message: `resize preview at scale ${scale}, delta ${delta}` },
      ).toBeDefined()
      const frame = await page.evaluate(() => ({
        preview: (window.__dinksterTest!.renderer!.getOverlay() as any).resizePreview,
        ops: (window as any).__resizePaintOps as number[][],
        moves: (window as any).__resizeMoveTos as number[][],
        attached: window.__dinksterTest!.renderer!.getScene().links.flatMap((link) => {
          const ends = [{ end: link.from, direction: 'out' }, { end: link.to, direction: 'in' }] as const
          return ends.flatMap(({ end, direction }) => {
            if (end.kind !== 'port' || end.node !== 'n0') return []
            const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'n0')!
            const pin = node.layout.pins.find((candidate) => candidate.direction === direction && candidate.portId === end.port)
            if (!pin) return []
            const preview = (window.__dinksterTest!.renderer!.getOverlay() as any).resizePreview
            return [{ x: preview.x + (direction === 'out' ? preview.width : 0), y: preview.y + pin.y }]
          })
        }),
      }))
      expect(frame.preview).toBeDefined()
      const previewPaints = frame.ops.filter(([x, y, width, height]) =>
        x === frame.preview.x && y === frame.preview.y &&
        width === frame.preview.width && height === frame.preview.height,
      )
      expect(previewPaints.length).toBeGreaterThanOrEqual(2)
      expect(previewPaints.length % 2).toBe(0)
      expect(frame.ops.some(([x, y, width, height]) =>
        x === corner.nodeX && y === corner.nodeY &&
        width === corner.width && height === corner.height,
      )).toBe(false)
      expect(frame.attached.length).toBeGreaterThan(0)
      for (const endpoint of frame.attached) {
        expect(frame.moves.some(([x, y]) => x === endpoint.x && y === endpoint.y)).toBe(true)
      }
      previews.push(frame.preview)
    }
    expect(previews[1]!.width).toBeGreaterThan(previews[0]!.width)
    expect(previews[2]!.height).toBeGreaterThan(previews[1]!.height)
    expect(await revision(page)).toBe(startRevision)

    await page.mouse.up()
    expect(await revision(page)).toBe(startRevision + 1)
    const committed = structuredClone((await activeDoc(page)).view.graphs.g0!.nodes.n0!)
    expect(committed.size).toEqual({
      width: Math.round(previews[2]!.width),
      height: Math.round(previews[2]!.height),
    })

    await page.keyboard.press('Control+z')
    expect((await activeDoc(page)).view.graphs.g0!.nodes.n0).toEqual(beforeView)
    await page.keyboard.press('Control+Shift+z')
    expect((await activeDoc(page)).view.graphs.g0!.nodes.n0).toEqual(committed)
  }
})

test('double-click Add node arms a title-centered ghost and commits only on the next click', async ({ page }) => {
  await openauditInteractionFixture(page)
  const countBefore = await page.evaluate(
    () => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes).length,
  )
  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()

  const search = page.getByTestId('palette-search')
  await search.fill('audit KSampler')
  await expect(page.getByTestId('palette-item').first()).toBeVisible()
  await page.locator('[data-node-type="auditPlacementTest"]').click()

  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  expect(await page.evaluate(() => Object.keys(
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes,
  ).length)).toBe(countBefore)
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.move(740, 620)
  await expect(canvas).toHaveAttribute('data-placement-ghost', 'visible')
  const ghost = await page.evaluate(() => (window.__dinksterTest!.renderer!.getOverlay() as {
    placementGhost: { x: number; y: number; width: number; height: number }
  }).placementGhost)
  await page.mouse.click(740, 620)
  const doc = await activeDoc(page)
  const added = Object.entries(doc.graphs['g0']!.nodes).find(([id, n]) =>
    id !== 'n0' && id !== 'n1' && n.type === 'auditPlacementTest',
  )
  expect(added).toBeDefined()
  const [id, node] = added!
  // Keyed widget defaults are materialized at creation - never positional.
  expect(node.values['steps']).toBeDefined()
  expect(doc.view.graphs['g0']!.nodes[id]!.position).toEqual({ x: Math.round(ghost.x), y: Math.round(ghost.y) })
  const sceneNode = await page.evaluate((id) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === id)!
    return { x: node.x, y: node.y, width: node.layout.width, headerHeight: node.layout.headerHeight }
  }, id)
  expect(sceneNode.width).toBe(ghost.width)
  expect(sceneNode.x + sceneNode.width / 2).toBeCloseTo(ghost.x + ghost.width / 2, 0)
  expect(sceneNode.y + sceneNode.headerHeight / 2).toBeCloseTo(ghost.y + sceneNode.headerHeight / 2, 0)
  // The new node is selected.
  await expect(canvas).toHaveAttribute('data-selection', '1')
})

test('Escape closes the palette without adding anything', async ({ page }) => {
  const countBefore = await page.evaluate(
    () => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes).length,
  )
  await page.mouse.dblclick(700, 600)
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await page.getByTestId('palette-search').press('Escape')
  await expect(page.getByTestId('node-palette')).not.toBeVisible()
  const countAfter = await page.evaluate(
    () => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.nodes).length,
  )
  expect(countAfter).toBe(countBefore)
})

test('palette lists subgraph definitions and adds an instance', async ({ page }) => {
  await page.getByTestId('tab-bar').locator('.tab', { hasText: 'Subgraph' }).click()
  await identityViewport(page)

  await page.mouse.dblclick(700, 600)
  await page.getByTestId('palette-search').fill('Image source')
  await page.locator('[data-node-type="#g1"]').click()
  await page.mouse.click(700, 600)

  const doc = await activeDoc(page)
  const added = Object.values(doc.graphs['g0']!.nodes).find((n) => n.type === '#g1')
  expect(added).toBeDefined()
})

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

/** Page coordinates of a toolbox button's center (assumes identity viewport). */
async function toolboxButtonPoint(page: Page, buttonId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((buttonId) => {
    const r = window.__dinksterTest!.renderer!
    const tl = r.getToolboxLayout()
    if (!tl) throw new Error('no toolbox visible')
    const b = tl.buttons.find((br) => br.button.id === buttonId)
    if (!b) throw new Error(`no toolbox button '${buttonId}'`)
    const vp = r.getViewport()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (b.x + b.size / 2) * vp.scale + vp.x,
      y: rect.top + (b.y + b.size / 2) * vp.scale + vp.y,
    }
  }, buttonId)
}

test('selection toolbox: mode selector and minimize act without dropping selection', async ({ page }) => {
  const canvas = page.getByTestId('graph-canvas')
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'header' })))
  await expect(canvas).toHaveAttribute('data-selection', '1')

  await page.mouse.click(...xy(await toolboxButtonPoint(page, 'core.mode')))
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await expect(page.locator('[data-item-id="core.node.mode.active"]')).toBeVisible()
  await page.locator('[data-item-id="core.node.mode.muted"]').click()
  let doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['n0']!.mode).toBe('muted')
  await expect(canvas).toHaveAttribute('data-selection', '1')

  await page.mouse.click(...xy(await toolboxButtonPoint(page, 'core.mode')))
  await page.locator('[data-item-id="core.node.mode.active"]').click()
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['n0']!.mode ?? 'active').toBe('active')

  await page.mouse.click(...xy(await toolboxButtonPoint(page, 'core.mode')))
  await page.locator('[data-item-id="core.node.mode.bypassed"]').click()
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['n0']!.mode).toBe('bypassed')

  await page.mouse.click(...xy(await toolboxButtonPoint(page, 'core.minimize')))
  doc = await activeDoc(page)
  expect(doc.view.graphs['g0']!.nodes['n0']!.collapsed).toBe(true)
  await expect(canvas).toHaveAttribute('data-selection', '1')

  // Empty-space click clears the selection and the toolbox with it.
  await page.mouse.click(700, 750)
  await expect(canvas).toHaveAttribute('data-selection', '0')
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getToolboxLayout())).toBeUndefined()
})

test('selection toolbox is an upside-down T with exactly three top controls and a wider complete lower row', {
  annotation: { type: 'mock-legacy-discovery' },
}, async ({ page }, testInfo) => {
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'header' })))
  const layout = await page.evaluate(() => window.__dinksterTest!.renderer!.getToolboxLayout())
  expect(layout).toBeDefined()
  expect(layout!.rows).toHaveLength(2)
  const [top, lower] = layout!.rows
  if (!top || !lower) throw new Error('expected both selection toolbox rows')
  expect(top!.entries.filter((entry) => entry.kind === 'button').map((entry) => entry.button.id)).toEqual([
    'core.queueUpToHere',
    'core.queueBetween',
    'core.queueFromHere',
  ])
  expect(top!.panel.width).toBeLessThan(lower!.panel.width)
  expect(top!.panel.x + top!.panel.width / 2).toBeCloseTo(lower!.panel.x + lower!.panel.width / 2)
  const lowerIds = lower!.entries
    .filter((entry): entry is Extract<(typeof lower.entries)[number], { kind: 'button' }> => entry.kind === 'button')
    .map((entry) => entry.button.id)
  expect(lowerIds).toEqual(expect.arrayContaining([
    'core.delete',
    'core.mode',
    'core.minimize',
    'core.color',
    'core.more',
  ]))
  expect(lowerIds.indexOf('core.color')).toBeLessThan(lowerIds.indexOf('core.more'))

  const screenshotPath = testInfo.outputPath('upside-down-t-selection-toolbox.png')
  await page.getByTestId('graph-canvas').screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('upside-down-t-selection-toolbox', { path: screenshotPath, contentType: 'image/png' })

  await page.mouse.click(...xy(await toolboxButtonPoint(page, 'core.more')))
  const menu = page.getByTestId('context-menu')
  const modeItem = page.locator('[data-item-id="core.node.mode"]')
  const submenu = page.getByTestId('context-submenu')
  await expect(menu).toBeVisible()
  await modeItem.hover()
  await expect(submenu).toBeVisible()
  const [menuBox, modeItemBox, submenuBox] = await Promise.all([
    menu.boundingBox(), modeItem.boundingBox(), submenu.boundingBox(),
  ])
  expect(menuBox).not.toBeNull()
  expect(modeItemBox).not.toBeNull()
  expect(submenuBox).not.toBeNull()
  const cascadesRight = submenuBox!.x >= menuBox!.x + menuBox!.width - 1
  const cascadesLeft = submenuBox!.x + submenuBox!.width <= menuBox!.x + 1
  expect(cascadesRight || cascadesLeft).toBe(true)
  expect(submenuBox!.y).toBeLessThan(modeItemBox!.y + modeItemBox!.height)
  expect(submenuBox!.y + submenuBox!.height).toBeGreaterThan(modeItemBox!.y)
  expect(submenuBox!.x).toBeGreaterThanOrEqual(0)
  expect(submenuBox!.x + submenuBox!.width).toBeLessThanOrEqual(1440)
  expect(submenuBox!.y).toBeGreaterThanOrEqual(0)
  expect(submenuBox!.y + submenuBox!.height).toBeLessThanOrEqual(900)
  const cascadePath = testInfo.outputPath('upside-down-t-selection-toolbox-cascade.png')
  await page.screenshot({ path: cascadePath, animations: 'disabled' })
  await testInfo.attach('upside-down-t-selection-toolbox-cascade', { path: cascadePath, contentType: 'image/png' })
})

test('selection toolbox keeps a 16px outline gap and clickable edge actions across zoom', async ({ page }, testInfo) => {
  await openauditInteractionFixture(page)
  const canvas = page.getByTestId('graph-canvas')
  await page.evaluate(() => {
    const state = window as typeof window & { __toolboxQueueCount?: number }
    state.__toolboxQueueCount = 0
    window.__dinksterTest!.app.queueSelection = async () => { state.__toolboxQueueCount!++ }
  })
  for (const scale of [0.5, 1, 2]) {
    await page.evaluate((scale) => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'n0')!
      renderer.setViewport({
        x: 500 - (node.x + node.layout.width / 2) * scale,
        y: 400 - (node.y + node.layout.headerHeight / 2) * scale,
        scale,
      })
    }, scale)
    await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'header' })))
    await expect(canvas).toHaveAttribute('data-selection', '1')

    const geometry = await page.evaluate(() => {
      const renderer = window.__dinksterTest!.renderer!
      const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'n0')!
      const layout = renderer.getToolboxLayout()!
      const viewport = renderer.getViewport()
      const canvasRect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const point = (button: (typeof layout.buttons)[number]) => ({
        x: canvasRect.left + (button.x + button.size / 2) * viewport.scale + viewport.x,
        y: canvasRect.top + (button.y + button.size / 2) * viewport.scale + viewport.y,
      })
      return {
        gap: (node.y - 4 - (layout.y + layout.height)) * viewport.scale,
        selectionOutlineTop: canvasRect.top + (node.y - 4) * viewport.scale + viewport.y,
        first: point(layout.buttons[0]!),
        last: point(layout.buttons[layout.buttons.length - 1]!),
      }
    })
    expect(Math.abs(geometry.gap - 16)).toBeLessThanOrEqual(0.5)
    expect(geometry.first.y).toBeLessThan(geometry.selectionOutlineTop)
    expect(geometry.last.y).toBeLessThan(geometry.selectionOutlineTop)

    const screenshotPath = testInfo.outputPath(`selection-toolbox-gap-${scale}x.png`)
    await canvas.screenshot({ path: screenshotPath, animations: 'disabled' })
    await testInfo.attach(`selection-toolbox-gap-${scale}x`, { path: screenshotPath, contentType: 'image/png' })

    await page.mouse.click(...xy(geometry.first))
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __toolboxQueueCount?: number }).__toolboxQueueCount,
    )).toBe([0.5, 1, 2].indexOf(scale) + 1)
    await expect(canvas).toHaveAttribute('data-selection', '1')
    await page.mouse.click(...xy(geometry.last))
    await expect(page.locator('[role="menu"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="menu"]')).not.toBeVisible()
  }
})

test('selection toolbox: delete button removes the selected node', async ({ page }) => {
  await page.mouse.click(...xy(await pointOn(page, 'n0', { kind: 'header' })))
  await page.mouse.click(...xy(await toolboxButtonPoint(page, 'core.delete')))
  const doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nodes['n0']).toBeUndefined()
})
