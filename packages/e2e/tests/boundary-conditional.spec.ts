/** Browser coverage for region occurrence state and a type choice's revealed rows. */
import { expect, openRailPanel, test, subgraphMarkPoint, waitForWorkspaceReady, type Page } from './fixtures.js'

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function pinPoint(
  page: Page,
  nodeId: string,
  portId: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, portId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => item.portId === portId)!
    if (!pin) throw new Error(`no pin '${nodeId}/${portId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: rect.top + node.y + pin.y,
    }
  }, { nodeId, portId })
}

async function widgetRowPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)
    if (!row) throw new Error(`no widget row '${nodeId}/${inputId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = window.__dinksterTest!.renderer!.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, inputId })
}

async function regionIndexPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const panel = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((item) => item.side === 'inputs')!
    const pin = (panel.layout.pins as unknown as readonly { regionIndex?: true; y: number }[]).find((item) => item.regionIndex === true)!
    if (!pin) throw new Error('no immediate region Index source')
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + panel.x + panel.layout.width, y: rect.top + panel.y + pin.y }
  })
}

async function openConditionalWorkflow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const concrete = (name: string) => ({ kind: 'concrete', name })
    const widget = (id: string, widgetType: string, defaultValue: number) => ({
      kind: 'input', id, type: concrete(widgetType), optional: true, forceInput: true,
      widget: { widgetType, options: {}, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'ImageSourceTest', displayName: 'Image Source Test', category: 'test', source: 'v3', isOutputNode: false,
        body: [{ kind: 'output', id: 'image', type: concrete('IMAGE') }],
      },
      {
        type: 'SlotTest', displayName: 'Slot Test', category: 'test', source: 'v3', isOutputNode: false,
        body: [{
          kind: 'typeChoice', id: 'image', type: concrete('IMAGE'), required: false,
          rows: [widget('strength', 'FLOAT', 1)],
        }],
      },
    ])
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'boundary-conditional', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            i0: { id: 'i0', type: '#sub', values: {} },
            source: { id: 'source', type: 'ImageSourceTest', values: {} },
            slot: { id: 'slot', type: 'SlotTest', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 100,
        },
        sub: {
          id: 'sub', name: 'Conditional Wrapper',
          nodes: {},
          links: {}, nets: {}, reroutes: {}, boundary: { body: [] }, nextOrdinal: 100,
        },
      },
      view: { graphs: {
        g0: { nodes: {
          i0: { position: { x: 100, y: 100 } },
          source: { position: { x: 100, y: 360 } },
          slot: { position: { x: 450, y: 340 } },
        } },
        sub: { nodes: {} },
      } },
    }, 'Boundary Conditional')
  })
  await identityViewport(page)
}

async function drillIntoSub(page: Page): Promise<void> {
  const mark = await subgraphMarkPoint(page, 'i0')
  await page.mouse.dblclick(mark.x, mark.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await identityViewport(page)
}

async function returnToRoot(page: Page): Promise<void> {
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await identityViewport(page)
}

async function assertNoUnsupportedDiagnostic(page: Page): Promise<void> {
  await expect(page.getByText(/constructUnsupported|not supported yet/)).toHaveCount(0)
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.route('/queue', (route) => route.fulfill({ json: { queue_running: [], queue_pending: [] } }))
  await page.route('/history*', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await waitForWorkspaceReady(page)
  await openConditionalWorkflow(page)
})

test('region occurrences author independent promoted widget state', async ({ page }, testInfo) => {
  expect(await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const scalar = { kind: 'concrete', name: 'FLOAT' }
    app.registerSchemas([
      {
        type: 'RegionPassTest', displayName: 'Region Pass', category: 'test', source: 'v3', isOutputNode: false,
        body: [
          { kind: 'input', id: 'item', type: scalar, optional: false },
          { kind: 'output', id: 'result', type: scalar },
        ],
      },
      {
        type: 'RegionAmountTest', displayName: 'Region Amount', category: 'test', source: 'v3', isOutputNode: false,
        body: [{
          kind: 'input', id: 'amount', type: scalar, optional: true,
          widget: { widgetType: 'FLOAT', options: {}, default: 1 },
        }],
      },
      {
        type: 'RegionIndexSinkTest', displayName: 'Region Index Sink', category: 'test', source: 'v3', isOutputNode: true,
        body: [{ kind: 'input', id: 'index', type: { kind: 'concrete', name: 'INT' }, optional: false }],
      },
    ])
    const document = JSON.parse(JSON.stringify(app.activeTab()!.store.doc))
    document.lineage = 'region-conditional-authoring'
    document.graphs['g0']!.nodes = {
      i0: {
        id: 'i0', type: '#sub', values: { item: [1, 2], amount: 2 },
        region: { kind: 'map', elementPorts: ['item'], outputRoles: { result: { kind: 'gather' } } },
      },
      i1: {
        id: 'i1', type: '#sub', values: { item: [3, 4], amount: 9 },
        region: { kind: 'map', elementPorts: ['item'], outputRoles: { result: { kind: 'gather' } } },
      },
    }
    document.graphs['sub']!.nodes['pass'] = { id: 'pass', type: 'RegionPassTest', values: {} }
    document.graphs['sub']!.nodes['amount'] = { id: 'amount', type: 'RegionAmountTest', values: {} }
    document.graphs['sub']!.nodes['indexSink'] = { id: 'indexSink', type: 'RegionIndexSinkTest', values: {} }
    document.graphs['sub']!.boundary = {
      inputs: [
        { id: 'item', binds: { kind: 'port', node: 'pass', port: 'item' } },
        { id: 'amount', promoted: true, binds: { kind: 'port', node: 'amount', port: 'amount' } },
      ],
      outputs: [{ id: 'result', binds: { kind: 'port', node: 'pass', port: 'result' } }],
    }
    document.view!.graphs['g0']!.nodes = {
      i0: { position: { x: 100, y: 100 } },
      i1: { position: { x: 520, y: 100 } },
    }
    document.view!.graphs['sub']!.nodes['pass'] = { position: { x: 720, y: 100 } }
    document.view!.graphs['sub']!.nodes['amount'] = { position: { x: 720, y: 320 } }
    document.view!.graphs['sub']!.nodes['indexSink'] = { position: { x: 720, y: 520 } }
    return (await app.openDocument(document, 'Region conditional authoring'))
  })).toEqual([])
  await identityViewport(page)
  await drillIntoSub(page)
  await drag(page, await regionIndexPoint(page), await pinPoint(page, 'indexSink', 'index'))
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('region-index-authoring.png') })
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    const i0 = Object.values(document.occurrenceTopologies?.i0?.links ?? {})[0]
    return {
      boundaryInputs: document.graphs['sub']!.boundary!.body.flatMap((entry) => entry.kind === 'input' ? [entry.id] : []),
      i0: i0 === undefined ? undefined : { from: i0.from, to: i0.to },
      i1: document.occurrenceTopologies?.i1,
    }
  })).toEqual({
    boundaryInputs: ['item', 'amount'],
    i0: {
      from: { kind: 'body', endpoint: { node: '$region', port: 'index' } },
      to: { kind: 'body', endpoint: { node: 'indexSink', port: 'index' } },
    },
    i1: undefined,
  })
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.occurrenceTopologies?.i0?.links ?? {}))).toEqual([])
  await page.keyboard.press('Control+Shift+z')
  expect(await page.evaluate(() => Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.occurrenceTopologies?.i0?.links ?? {})[0]?.from)).toEqual({
    kind: 'body', endpoint: { node: '$region', port: 'index' },
  })
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  expect(await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'amount')!
    const rows = node.layout.rows as unknown as Array<{
      kind: string; inputId?: string; derivedValue?: unknown; familyOwner?: unknown
    }>
    const row = rows.find((item) => item.kind === 'widget' && item.inputId === 'amount')!
    return { occurrenceValue: row.derivedValue !== undefined, occurrenceOwner: row.familyOwner }
  })).toEqual({ occurrenceValue: false, occurrenceOwner: { graphId: 'g0', nodeId: 'i0', construct: 'amount', valueKey: 'amount' } })
  const definitionAmount = await widgetRowPoint(page, 'amount', 'amount')
  await page.mouse.click(definitionAmount.x, definitionAmount.y)
  await expect(page.getByTestId('widget-editor')).toHaveCount(0)
  let document = await activeDoc(page)
  expect(document.graphs['sub']!.nodes['amount']!.values['amount']).toBeUndefined()
  expect(document.graphs['g0']!.nodes['i0']!.values['amount']).toBe(2)
  expect(document.graphs['g0']!.nodes['i1']!.values['amount']).toBe(9)
  expect(Object.values(document.occurrenceTopologies?.i0?.links ?? {})[0]?.from).toEqual({
    kind: 'body', endpoint: { node: '$region', port: 'index' },
  })
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await returnToRoot(page)
  const amount = await widgetRowPoint(page, 'i0', 'amount')
  await page.mouse.click(amount.x, amount.y)
  const editor = page.getByTestId('widget-editor').locator('input')
  await editor.fill('5.5')
  await editor.press('Enter')

  document = await activeDoc(page)
  expect(document.graphs['g0']!.nodes['i0']!.values['amount']).toBe(5.5)
  expect(document.graphs['g0']!.nodes['i1']!.values['amount']).toBe(9)
  expect(document.graphs['sub']!.nodes['amount']!.values['amount']).toBeUndefined()
  expect(await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.map((node) => ({
      id: node.id,
      regionKind: (node as unknown as { regionKind?: string }).regionKind,
      rows: node.layout.rows.map((row) => row.inputId).filter((id): id is string => id !== undefined),
    })))).toEqual([
      { id: 'i0', regionKind: 'map', rows: expect.arrayContaining(['amount']) },
      { id: 'i1', regionKind: 'map', rows: expect.arrayContaining(['amount']) },
    ])
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('region-occurrence-authoring.png') })

  await page.keyboard.press('Control+z')
  document = await activeDoc(page)
  expect(document.graphs['g0']!.nodes['i0']!.values['amount']).toBe(2)
  expect(document.graphs['g0']!.nodes['i1']!.values['amount']).toBe(9)

  const exported = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    return app.exportDocument(tab.id)!
  })
  expect(await page.evaluate(async (saved) =>
    (await window.__dinksterTest!.app.openDocument(saved, 'Reopened region authoring', undefined, true)), exported,
  )).toEqual([])
  document = await activeDoc(page)
  expect(document.graphs['g0']!.nodes['i0']!.values['amount']).toBe(2)
  expect(document.graphs['g0']!.nodes['i1']!.values['amount']).toBe(9)
  await assertNoUnsupportedDiagnostic(page)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().diagnostics)).toEqual([])
})

test('a type choice reveals and hides its dependent row when connected and disconnected', async ({ page }) => {
  let slot = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'slot')!,
  )
  expect(slot.layout.pins.some((pin) => pin.portId === 'image.strength')).toBe(false)

  await drag(page, await pinPoint(page, 'source', 'image'), await pinPoint(page, 'slot', 'image'))
  slot = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'slot')!,
  )
  expect(slot.layout.pins.some((pin) => pin.portId === 'image.strength')).toBe(true)
  expect(Object.keys((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(1)
  await expect(page.getByTestId('graph-canvas')).toBeVisible()

  const input = await pinPoint(page, 'slot', 'image')
  await drag(page, input, { x: input.x + 120, y: input.y + 120 })
  slot = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'slot')!,
  )
  expect(slot.layout.pins.some((pin) => pin.portId === 'image.strength')).toBe(false)
  expect(Object.keys((await activeDoc(page)).graphs['g0']!.links)).toHaveLength(0)
})
