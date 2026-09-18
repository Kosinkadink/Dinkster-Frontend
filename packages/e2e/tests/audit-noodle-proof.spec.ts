import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-noodle-proof'

async function openFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    bridge.app.registerSchemas([{
      type: 'TapWidget', displayName: 'Tap Widget', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'amount', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
        widget: { widgetType: 'FLOAT', options: {}, default: 1 } }],
    }, {
      type: 'FloatSource', displayName: 'Float Source', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'FLOAT' } }],
    }, {
      type: 'FloatSink', displayName: 'Float Sink', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: false }],
    }])
    const failures = bridge.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-proof', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        tap: { id: 'tap', type: 'TapWidget', values: { amount: 2 } },
        source: { id: 'source', type: 'FloatSource', values: {} },
        fan: { id: 'fan', type: 'FloatSource', values: {} },
        alternative: { id: 'alternative', type: 'FloatSource', values: {} },
        tapSink: { id: 'tapSink', type: 'FloatSink', values: {} },
        outputSink: { id: 'outputSink', type: 'FloatSink', values: {} },
        fanA: { id: 'fanA', type: 'FloatSink', values: {} },
        fanB: { id: 'fanB', type: 'FloatSink', values: {} },
      }, links: {
        tapLink: { id: 'tapLink', from: { node: 'tap', tap: 'amount' }, to: { node: 'tapSink', port: 'value' } },
        outputLink: { id: 'outputLink', from: { node: 'source', port: 'out' }, to: { node: 'outputSink', port: 'value' } },
        fanLinkA: { id: 'fanLinkA', from: { node: 'fan', port: 'out' }, to: { node: 'fanA', port: 'value' } },
        fanLinkB: { id: 'fanLinkB', from: { node: 'fan', port: 'out' }, to: { node: 'fanB', port: 'value' } },
      }, nets: {}, reroutes: {}, nextOrdinal: 40 } },
      view: { graphs: { g0: { nodes: {
        tap: { position: { x: 80, y: 80 } }, tapSink: { position: { x: 450, y: 80 } },
        source: { position: { x: 80, y: 270 } }, outputSink: { position: { x: 450, y: 270 } },
        fan: { position: { x: 80, y: 470 } }, fanA: { position: { x: 450, y: 440 } },
        fanB: { position: { x: 450, y: 590 } }, alternative: { position: { x: 760, y: 270 } },
      } } } },
    }, 'audit proof')
    if (failures.length > 0) throw new Error(`openDocument failed: ${JSON.stringify(failures)}`)
    bridge.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

const graphState = (page: Page) => page.evaluate(() => {
  const bridge = window.__dinksterTest!
  const graph = bridge.app.activeTab()!.store.doc.graphs.g0!
  return {
    nodes: Object.keys(graph.nodes),
    links: Object.entries(graph.links).map(([id, link]) => ({ id, ...link })),
    selection: [...bridge.controller!.getSelection()],
    revision: bridge.app.activeTab()!.store.revision,
  }
})

async function endpoint(page: Page, nodeId: string, kind: 'out' | 'in' | 'tap'): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, kind }) => {
    const bridge = window.__dinksterTest!
    const node = bridge.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => kind === 'tap'
      ? item.direction === 'out' && (item as { widgetTap?: true }).widgetTap === true
      : item.direction === kind)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: rect.top + node.y + pin.y,
    }
  }, { nodeId, kind })
}

async function shiftDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
  await page.keyboard.up('Shift')
}

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openFixture(page)
  // Wait for workspace promotion: a paste gesture in flight while the tab is
  // being replaced by its shared-session twin is dropped by the ownership
  // latch, so interact only with the settled tab.
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'audit-proof' && 'status' in tab.store
  })
})

test('connected and ordinary paste preserve endpoint rules', async ({ page }) => {
  for (const [sink, expected, screenshot] of [
    ['outputSink', { node: 'source', port: 'out' }, 'a-connected-output.png'],
    ['tapSink', { node: 'tap', tap: 'amount' }, 'b-connected-widget-tap.png'],
  ] as const) {
    await page.evaluate((id) => window.__dinksterTest!.controller!.setSelection([id]), sink)
    await page.keyboard.press('Control+c')
    const before = (await graphState(page)).nodes.length
    await page.keyboard.press('Control+Shift+v')
    await expect.poll(async () => (await graphState(page)).nodes.length).toBe(before + 1)
    const state = await graphState(page)
    const pasted = state.selection[0]!
    expect(state.links.some((link) => 'node' in link.to && link.to.node === pasted &&
      JSON.stringify(link.from) === JSON.stringify(expected))).toBe(true)
    await page.screenshot({ path: `${proofDir}/${screenshot}` })
  }

  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['tapSink']))
  await page.keyboard.press('Control+c')
  const before = (await graphState(page)).nodes.length
  await page.keyboard.press('Control+v')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(before + 1)
  const detached = await graphState(page)
  const pasted = detached.selection[0]!
  expect(detached.links.some((link) => 'node' in link.to && link.to.node === pasted)).toBe(false)
  await page.screenshot({ path: `${proofDir}/d-ordinary-paste-detached.png` })
})

test('stale widget-tap source is skipped while valid stubs and pasted nodes land', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['tapSink', 'outputSink']))
  await page.keyboard.press('Control+c')
  await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.dispatch({
    command: 'node.remove', params: { graphId: 'g0', nodeIds: ['tap'] },
  }))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.tap)).toBeUndefined()
  const before = (await graphState(page)).nodes.length
  await page.keyboard.press('Control+Shift+v')
  await expect.poll(async () => (await graphState(page)).nodes.length).toBe(before + 2)
  const state = await graphState(page)
  const pasted = new Set(state.selection)
  const incoming = state.links.filter((link) => 'node' in link.to && pasted.has(link.to.node))
  expect(incoming).toHaveLength(1)
  expect(incoming[0]!.from).toEqual({ node: 'source', port: 'out' })
  await page.screenshot({ path: `${proofDir}/c-stale-tap-skipped-valid-stub-lands.png` })
})

test('output move-source empty drop disconnects, undo restores, Escape cancels, and a target moves', async ({ page }) => {
  const source = await endpoint(page, 'source', 'out')
  const empty = { x: 1050, y: 760 }
  const before = await graphState(page)
  await shiftDrag(page, source, empty)
  let state = await graphState(page)
  expect(state.links.some((link) => link.id === 'outputLink')).toBe(false)
  expect(state.selection).toEqual([])
  expect(await page.locator('[data-testid=node-palette]').count()).toBe(0)
  await page.screenshot({ path: `${proofDir}/e-empty-drop-disconnected.png` })
  await page.keyboard.press('Control+z')
  state = await graphState(page)
  expect(state.links.some((link) => link.id === 'outputLink')).toBe(true)
  expect(state.revision).toBe(before.revision + 2)

  await page.mouse.move(source.x, source.y)
  await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.move(empty.x, empty.y)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await page.keyboard.up('Shift')
  state = await graphState(page)
  expect(state.links.some((link) => link.id === 'outputLink')).toBe(true)
  expect(state.revision).toBe(before.revision + 2)
  await page.screenshot({ path: `${proofDir}/f-escape-snapback.png` })

  await shiftDrag(page, source, await endpoint(page, 'fan', 'out'))
  state = await graphState(page)
  expect(state.links.find((link) => link.id === 'outputLink')!.from).toEqual({ node: 'fan', port: 'out' })
  await page.screenshot({ path: `${proofDir}/g-valid-target-moves-source.png` })
})

test('widget-tap and multi-link fan-out empty drops disconnect atomically', async ({ page }) => {
  const tapHover = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'tap')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight + 4 }
  })
  await page.mouse.move(tapHover.x, tapHover.y)
  await shiftDrag(page, await endpoint(page, 'tap', 'tap'), { x: 1050, y: 760 })
  let state = await graphState(page)
  expect(state.links.some((link) => link.id === 'tapLink')).toBe(false)
  await page.screenshot({ path: `${proofDir}/h-widget-tap-empty-drop.png` })
  await page.keyboard.press('Control+z')
  expect((await graphState(page)).links.some((link) => link.id === 'tapLink')).toBe(true)

  const before = await graphState(page)
  await shiftDrag(page, await endpoint(page, 'fan', 'out'), { x: 1050, y: 760 })
  state = await graphState(page)
  expect(state.links.some((link) => link.id === 'fanLinkA' || link.id === 'fanLinkB')).toBe(false)
  await page.screenshot({ path: `${proofDir}/i-fan-out-empty-drop.png` })
  await page.keyboard.press('Control+z')
  state = await graphState(page)
  expect(state.links.filter((link) => link.id === 'fanLinkA' || link.id === 'fanLinkB')).toHaveLength(2)
  expect(state.revision).toBe(before.revision + 2)
})
