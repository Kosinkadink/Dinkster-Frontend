/**
 * Boundary pseudo-nodes: while editing a subgraph definition, the canvas
 * shows node-like Inputs/Outputs panels derived from GraphDef.boundary.
 *
 * The contract under test: panels appear only inside definitions; the Inputs
 * panel's pins face out (it feeds the graph) and the Outputs panel's face in;
 * binding noodles render but are not document links; dragging a panel is one
 * undoable view.moveBoundaryNode that persists in GraphViewState.boundary and
 * never touches document semantics.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openRailPanel, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_SUBGRAPH_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const boundaryNodes = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getScene().boundaryNodes)

/** Page coordinates of a boundary panel's header center (identity viewport). */
async function boundaryHeaderPoint(page: Page, side: 'inputs' | 'outputs'): Promise<{ x: number; y: number }> {
  return page.evaluate((side) => {
    const r = window.__dinksterTest!.renderer!
    const bnode = r.getScene().boundaryNodes.find((b) => b.side === side)
    if (!bnode) throw new Error(`no boundary panel '${side}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + bnode.x + bnode.layout.width / 2,
      y: rect.top + bnode.y + bnode.layout.headerHeight / 2,
    }
  }, side)
}

async function boundaryRowPoint(page: Page, side: 'inputs' | 'outputs', portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ side, portId }) => {
    const bnode = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((b) => b.side === side)!
    const pin = bnode.layout.pins.find((p) => p.portId === portId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + bnode.x + bnode.layout.width / 2, y: rect.top + bnode.y + pin.y }
  }, { side, portId })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

/** Root with one #sub instance; sub forwards a port-bound input and output. */
async function openSubgraphWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'Pass',
        displayName: 'Pass',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [
          { kind: 'input', id: 'in', displayName: 'Source Image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
          { kind: 'output', id: 'out0', displayName: 'Result Image', type: { kind: 'concrete', name: 'IMAGE' } },
        ],
      },
    ])
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-boundary-nodes',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: { i0: { id: 'i0', type: '#sub', values: {} } },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 100,
          },
          sub: {
            id: 'sub',
            name: 'Wrapper',
            nodes: {
              n1: { id: 'n1', type: 'Pass', values: {} },
              // A second inner node: its output is the drop target for the
              // Shift fan-out re-source gesture (never bound at load).
              n2: { id: 'n2', type: 'Pass', values: {} },
            },
            links: {},
            nets: {},
            reroutes: {},
            boundary: {
              // Boundary ids share ONE namespace across both sides (the
              // derived schema's item list), so they must differ.
              inputs: [{ id: 'source', binds: { kind: 'port', node: 'n1', port: 'in' } }],
              outputs: [{ id: 'image', binds: { kind: 'port', node: 'n1', port: 'out0' } }],
            },
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: { nodes: { i0: { position: { x: 200, y: 160 } } } },
            sub: { nodes: { n1: { position: { x: 400, y: 200 } }, n2: { position: { x: 400, y: 380 } } } },
          },
        },
      },
      'BoundaryNodes',
    )
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'lineage-boundary-nodes'
  })).toBe(true)
  await identityViewport(page)
}

/** Double-click the instance header to drill into the definition. */
async function drillIntoSub(page: Page): Promise<void> {
  const header = await page.evaluate(() => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((n) => n.id === 'i0')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + node.layout.width / 2,
      y: rect.top + node.y + node.layout.headerHeight / 2,
    }
  })
  await page.mouse.dblclick(header.x, header.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await identityViewport(page)
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openSubgraphWorkflow(page)
})

test('panels appear only inside the definition, with side-correct pins', async ({ page }) => {
  // Root scene: no panels.
  expect(await boundaryNodes(page)).toEqual([])

  await drillIntoSub(page)
  const panels = await boundaryNodes(page)
  expect(panels.map((b) => b.side).sort()).toEqual(['inputs', 'outputs'])
  const inputs = panels.find((b) => b.side === 'inputs')!
  const outputs = panels.find((b) => b.side === 'outputs')!
  // One pin per boundary item plus the trailing blank "expose..." slot.
  expect(inputs.layout.pins).toHaveLength(2)
  expect(inputs.layout.pins[0]).toMatchObject({ portId: 'source', direction: 'out' })
  expect(inputs.layout.pins[1]).toMatchObject({ portId: '__add__', direction: 'out' })
  expect(outputs.layout.pins[0]).toMatchObject({ portId: 'image', direction: 'in' })
  expect(outputs.layout.pins[1]).toMatchObject({ portId: '__add__', direction: 'in' })
  // Panels flank the inner node.
  const n1 = await page.evaluate(() => {
    const n = window.__dinksterTest!.renderer!.getScene().nodes.find((x) => x.id === 'n1')!
    return { x: n.x, width: n.layout.width }
  })
  expect(inputs.x + inputs.layout.width).toBeLessThan(n1.x)
  expect(outputs.x).toBeGreaterThan(n1.x + n1.width)
})

test('binding noodles render but are not document links', async ({ page }) => {
  await drillIntoSub(page)
  // Both bindings render as scene links...
  const sceneLinkIds = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().links.map((l) => l.id).sort(),
  )
  expect(sceneLinkIds).toEqual(['boundary:inputs:source', 'boundary:outputs:image'])
  // ...but the document has none.
  const doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['sub']!.links)).toHaveLength(0)
})

test('dragging a panel persists ONE view.moveBoundaryNode; undo/redo round-trips', async ({ page }) => {
  await drillIntoSub(page)
  const before = (await boundaryNodes(page)).find((b) => b.side === 'inputs')!

  const start = await boundaryHeaderPoint(page, 'inputs')
  await drag(page, start, { x: start.x + 120, y: start.y + 60 })

  const expected = { x: before.x + 120, y: before.y + 60 }
  const moved = await activeDoc(page)
  expect(moved.view.graphs['sub']!.boundary).toEqual({ inputs: { position: expected } })
  const movedPanel = (await boundaryNodes(page)).find((b) => b.side === 'inputs')!
  expect({ x: movedPanel.x, y: movedPanel.y }).toEqual(expected)
  // Pure view state: the boundary definition itself is untouched.
  expect(moved.graphs['sub']!.nodes['n1']).toBeDefined()

  // ONE undo returns to the derived default placement.
  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(undone.view.graphs['sub']!.boundary).toBeUndefined()
  const undonePanel = (await boundaryNodes(page)).find((b) => b.side === 'inputs')!
  expect({ x: undonePanel.x, y: undonePanel.y }).toEqual({ x: before.x, y: before.y })

  await page.keyboard.press('Control+Shift+z')
  const redone = await activeDoc(page)
  expect(redone.view.graphs['sub']!.boundary).toEqual({ inputs: { position: expected } })
})

test('double-clicking boundary row labels renames input and output ports', async ({ page }) => {
  await drillIntoSub(page)
  for (const [side, id, name] of [
    ['inputs', 'source', 'Source Image'],
    ['outputs', 'image', 'Result Image'],
  ] as const) {
    const point = await boundaryRowPoint(page, side, id)
    await page.mouse.dblclick(point.x, point.y)
    const input = page.getByTestId('boundary-prompt-input')
    await expect(input).toBeVisible()
    await input.fill(name)
    await input.press('Enter')
    await expect.poll(() => page.evaluate(({ side, id }) => {
      const boundary = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.sub!.boundary!
      const item = boundary[side].find((candidate) => candidate.id === id)
      return item !== undefined && 'displayName' in item ? item.displayName : undefined
    }, { side, id })).toBe(name)
  }
  const doc = await activeDoc(page)
  const graph = doc.graphs.sub! as unknown as {
    boundary: { inputs: unknown[]; outputs: unknown[] }
  }
  expect(graph.boundary.inputs[0]).toMatchObject({ id: 'source', displayName: 'Source Image' })
  expect(graph.boundary.outputs[0]).toMatchObject({ id: 'image', displayName: 'Result Image' })
})

test('schema labels and user-defined boundary names stay consistent inside and outside', async ({ page }) => {
  const labels = () => page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene() as unknown as {
      nodes: readonly { layout: { rows: readonly { kind: string; input?: { label: string }; output?: { label: string } }[] } }[]
    }
    const rows = scene.nodes[0]?.layout.rows ?? []
    return rows.flatMap((row) => row.kind === 'ports'
      ? [row.input?.label, row.output?.label].filter((label): label is string => label !== undefined)
      : [])
  })
  await expect.poll(labels).toEqual(['Source Image', 'Result Image'])

  await drillIntoSub(page)
  const interiorLabels = () => page.evaluate(() => ((window.__dinksterTest!.renderer!.getScene() as unknown as {
    boundaryNodes: readonly { layout: { rows: readonly { kind: string; input?: { label: string }; output?: { label: string } }[] } }[]
  }).boundaryNodes).flatMap((node) =>
    node.layout.rows.flatMap((row) => row.kind === 'ports'
      ? [row.input?.label, row.output?.label].filter((label): label is string => label !== undefined && !label.startsWith('expose '))
      : []),
  ))
  await expect.poll(interiorLabels).toEqual(['Source Image', 'Result Image'])
  const sourceItem = page.locator('[data-testid=boundary-item][data-boundary-id=source]')
  await expect(sourceItem).toContainText('Source Image')
  const nameInput = sourceItem.getByTestId('boundary-name-input')
  await expect(nameInput).toHaveAttribute('placeholder', 'Source Image')
  await nameInput.fill('Primary Photo')
  await nameInput.press('Enter')
  await expect.poll(interiorLabels).toEqual(['Primary Photo', 'Result Image'])
  if (proofDir) await page.screenshot({ path: join(proofDir, 'named-subgraph-boundaries.png'), animations: 'disabled', fullPage: true })

  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await expect.poll(labels).toEqual(['Primary Photo', 'Result Image'])
  await drillIntoSub(page)
  const renamedInput = page.locator('[data-testid=boundary-item][data-boundary-id=source]').getByTestId('boundary-name-input')
  await renamedInput.fill('')
  await renamedInput.press('Enter')
  await expect.poll(interiorLabels).toEqual(['Source Image', 'Result Image'])
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await expect.poll(labels).toEqual(['Source Image', 'Result Image'])
})

/** The sub graph's boundary inputs, read through the untyped doc surface. */
async function boundaryInputs(page: Page): Promise<ReadonlyArray<{ id: string; binds: unknown }>> {
  const doc = await activeDoc(page)
  const graphs = doc.graphs as Record<
    string,
    { boundary?: { inputs: ReadonlyArray<{ id: string; binds: unknown }> } }
  >
  return graphs['sub']!.boundary!.inputs
}

/** Page coordinates of a scene link's straight-span midpoint (identity viewport). */
async function linkMidpoint(page: Page, linkId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((linkId) => {
    const link = window.__dinksterTest!.renderer!.getScene().links.find((l) => l.id === linkId)
    if (!link) throw new Error(`no scene link '${linkId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + (link.x1 + link.x2) / 2, y: rect.top + (link.y1 + link.y2) / 2 }
  }, linkId)
}

/** Page coordinates of a boundary panel pin (identity viewport). */
async function boundaryPinPoint(page: Page, side: 'inputs' | 'outputs', portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ side, portId }) => {
    const bnode = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((b) => b.side === side)
    if (!bnode) throw new Error(`no boundary panel '${side}'`)
    const pin = bnode.layout.pins.find((p) => p.portId === portId)
    if (!pin) throw new Error(`no boundary pin '${side}/${portId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + bnode.x + (pin.direction === 'out' ? bnode.layout.width : 0),
      y: rect.top + bnode.y + pin.y,
    }
  }, { side, portId })
}

/** Page coordinates of an inner node's pin (identity viewport). */
async function nodePinPoint(page: Page, nodeId: string, portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, portId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === nodeId)!
    const pin = node.layout.pins.find((p) => p.portId === portId)
    if (!pin) throw new Error(`no pin '${nodeId}/${portId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: rect.top + node.y + pin.y,
    }
  }, { nodeId, portId })
}

test('binding noodles click-select and Shift-toggle exactly like ordinary noodles', async ({ page }) => {
  await drillIntoSub(page)
  const canvas = page.getByTestId('graph-canvas')

  const inBind = await linkMidpoint(page, 'boundary:inputs:source')
  await page.mouse.click(inBind.x, inBind.y)
  await expect(canvas).toHaveAttribute('data-link-selection', '1')
  await expect(canvas).toHaveAttribute('data-selection', '0')

  // Shift-click ADDS the other binding noodle to the selection...
  const outBind = await linkMidpoint(page, 'boundary:outputs:image')
  await page.keyboard.down('Shift')
  await page.mouse.click(outBind.x, outBind.y)
  await expect(canvas).toHaveAttribute('data-link-selection', '2')

  // ...and Shift-click on an already-selected one toggles it back off.
  await page.mouse.click(inBind.x, inBind.y)
  await page.keyboard.up('Shift')
  await expect(canvas).toHaveAttribute('data-link-selection', '1')
})

test('Delete on a selected binding noodle lowers to boundary.unbind; undo restores', async ({ page }) => {
  await drillIntoSub(page)
  const canvas = page.getByTestId('graph-canvas')

  const mid = await linkMidpoint(page, 'boundary:inputs:source')
  await page.mouse.click(mid.x, mid.y)
  await expect(canvas).toHaveAttribute('data-link-selection', '1')
  await page.keyboard.press('Delete')

  // The last binding of an inputs item removes the item itself; the
  // document never saw a link.disconnect (there are no document links).
  const after = await activeDoc(page)
  expect(await boundaryInputs(page)).toEqual([])
  expect(Object.keys(after.graphs['sub']!.links)).toHaveLength(0)
  const sceneLinkIds = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().links.map((l) => l.id),
  )
  expect(sceneLinkIds).toEqual(['boundary:outputs:image'])

  await page.keyboard.press('Control+z')
  expect(await boundaryInputs(page)).toEqual([
    { id: 'source', binds: { kind: 'port', node: 'n1', port: 'in' } },
  ])
})

test('double-click on a binding noodle never inserts a reroute (synthetic link ids)', async ({ page }) => {
  await drillIntoSub(page)
  const mid = await linkMidpoint(page, 'boundary:inputs:source')
  await page.mouse.dblclick(mid.x, mid.y)
  const doc = await activeDoc(page)
  expect(doc.graphs['sub']!.reroutes).toEqual({})
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().reroutes)).toEqual([])
})

test('Shift-drag from an inputs pseudo output re-sources its sinks to a real output in ONE step', async ({ page }) => {
  await drillIntoSub(page)

  // Shift-grab the 'source' pseudo output: the whole binding fan-out (here
  // one sink, n1.in) rides the cursor; dropping on n2's real output unbinds
  // the boundary item and connects n2.out0 -> n1.in in one batch.
  const from = await boundaryPinPoint(page, 'inputs', 'source')
  const to = await nodePinPoint(page, 'n2', 'out0')
  await page.keyboard.down('Shift')
  await drag(page, from, to)
  await page.keyboard.up('Shift')

  const after = await activeDoc(page)
  expect(await boundaryInputs(page)).toEqual([])
  const links = Object.values(after.graphs['sub']!.links)
  expect(links).toHaveLength(1)
  expect(links[0]).toMatchObject({
    from: { node: 'n2', port: 'out0' },
    to: { node: 'n1', port: 'in' },
  })

  // ONE undo restores the binding AND removes the link (atomic batch).
  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(await boundaryInputs(page)).toEqual([
    { id: 'source', binds: { kind: 'port', node: 'n1', port: 'in' } },
  ])
  expect(Object.keys(undone.graphs['sub']!.links)).toHaveLength(0)
})

test('Shift-drag from the pseudo output dropped on empty space keeps the bindings', async ({ page }) => {
  await drillIntoSub(page)
  const before = await activeDoc(page)

  const from = await boundaryPinPoint(page, 'inputs', 'source')
  await page.keyboard.down('Shift')
  await drag(page, from, { x: from.x + 40, y: from.y + 220 })
  await page.keyboard.up('Shift')

  // Nothing committed: the noodles snap back, the binding survives.
  expect(await activeDoc(page)).toEqual(before)
})

test('moving the Inputs panel never disturbs the Outputs panel', async ({ page }) => {
  await drillIntoSub(page)
  const outputsBefore = (await boundaryNodes(page)).find((b) => b.side === 'outputs')!

  const start = await boundaryHeaderPoint(page, 'inputs')
  await drag(page, start, { x: start.x - 80, y: start.y + 40 })

  const doc = await activeDoc(page)
  expect(doc.view.graphs['sub']!.boundary!.inputs).toBeDefined()
  expect(doc.view.graphs['sub']!.boundary!.outputs).toBeUndefined()
  const outputsAfter = (await boundaryNodes(page)).find((b) => b.side === 'outputs')!
  expect({ x: outputsAfter.x, y: outputsAfter.y }).toEqual({ x: outputsBefore.x, y: outputsBefore.y })
})
