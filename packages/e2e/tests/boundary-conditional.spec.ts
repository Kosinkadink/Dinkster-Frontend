/** Browser coverage for forwarding conditional constructs through a subgraph. */
import { expect, openRailPanel, test, type Page } from './fixtures.js'

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

async function blankInputBoundaryPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const panel = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((item) => item.side === 'inputs')!
    const pin = panel.layout.pins.find((item) => item.portId === '__add__')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + panel.x + panel.layout.width, y: rect.top + panel.y + pin.y }
  })
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
  await page.evaluate(() => {
    const concrete = (name: string) => ({ kind: 'concrete', name })
    const widget = (id: string, widgetType: string, defaultValue: number) => ({
      kind: 'input', id, type: concrete(widgetType), optional: true, forceInput: true,
      widget: { widgetType, options: {}, default: defaultValue },
    })
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'ResizeTest', displayName: 'Resize Test', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'resize', type: concrete('STRING'), optional: true,
          dynamic: {
            kind: 'dynamicCombo', defaultOption: 'fit',
            options: [
              { key: 'fit', inputs: [widget('width', 'INT', 512)] },
              { key: 'crop', inputs: [widget('ratio', 'FLOAT', 1)] },
            ],
          },
        }],
      },
      {
        type: 'ImageSourceTest', displayName: 'Image Source Test', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'image', type: concrete('IMAGE') }],
      },
      {
        type: 'SlotTest', displayName: 'Slot Test', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'image', type: concrete('IMAGE'), optional: true,
          dynamic: { kind: 'dynamicSlot', slotType: concrete('IMAGE'), inputs: [widget('strength', 'FLOAT', 1)] },
        }],
      },
    ])
    window.__dinksterTest!.app.openDocument({
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
          nodes: { resize: { id: 'resize', type: 'ResizeTest', values: {} } },
          links: {}, nets: {}, reroutes: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 100,
        },
      },
      view: { graphs: {
        g0: { nodes: {
          i0: { position: { x: 100, y: 100 } },
          source: { position: { x: 100, y: 360 } },
          slot: { position: { x: 450, y: 340 } },
        } },
        sub: { nodes: { resize: { position: { x: 400, y: 180 } } } },
      } },
    }, 'Boundary Conditional')
  })
  await identityViewport(page)
}

async function drillIntoSub(page: Page): Promise<void> {
  const header = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'i0')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.dblclick(header.x, header.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await identityViewport(page)
}

async function returnToRoot(page: Page): Promise<void> {
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await identityViewport(page)
}

async function selectCombo(page: Page, nodeId: string, inputId: string, option: string, xFraction = 0.5): Promise<void> {
  const point = await page.evaluate(({ nodeId, inputId, xFraction }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.inputId === inputId)!
    if (!row) throw new Error(`no row '${nodeId}/${inputId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width * xFraction, y: rect.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId, xFraction })
  await page.mouse.click(point.x, point.y)
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toBeVisible()
  await dropdown.getByRole('option', { name: option, exact: true }).click()
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
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openConditionalWorkflow(page)
})

test('dragging the Inputs pseudo-node forwards the full DynamicCombo branch by default', async ({ page }) => {
  await drillIntoSub(page)
  const pins = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'resize')!.layout.pins.map((pin) => pin.portId),
  )
  // DynamicCombo selector rows are connectable canvas pins. Prefer this
  // construct binding over the also-visible force-input branch pin.
  expect(pins).toContain('resize')
  expect(pins).toContain('resize.[fit].width')
  await drag(page, await blankInputBoundaryPoint(page), await pinPoint(page, 'resize', 'resize'))

  await assertNoUnsupportedDiagnostic(page)
  const doc = await activeDoc(page)
  const graph = doc.graphs['sub'] as typeof doc.graphs[string] & {
    boundary: { inputs: Array<{ id: string; binds: { node: string; port: string } }> }
  }
  const item = graph.boundary.inputs[0]!
  expect(item.binds).toMatchObject({ kind: 'dynamicCombo', node: 'resize', port: 'resize' })

  await returnToRoot(page)
  const instance = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'i0')!,
  )
  expect(instance.layout.rows.some((row) => row.inputId === item.id)).toBe(true)
  await assertNoUnsupportedDiagnostic(page)
})

test('drag-bound selector binding switches through the derived instance combo', async ({ page }) => {
  await drillIntoSub(page)
  await drag(page, await blankInputBoundaryPoint(page), await pinPoint(page, 'resize', 'resize'))
  const boundaryId = await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs['sub'] as unknown as {
      boundary: { inputs: Array<{ id: string }> }
    }
    return graph.boundary.inputs[0]!.id
  })
  await returnToRoot(page)

  const instance = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'i0')!,
  )
  expect(instance.layout.rows.some((row) => row.inputId === boundaryId)).toBe(true)
  await selectCombo(page, 'i0', boundaryId, 'crop')
  const doc = await activeDoc(page)
  const node = doc.graphs['g0']!.nodes['i0'] as typeof doc.graphs['g0']['nodes'][string] & {
    dynamic?: Record<string, { selected?: string }>
  }
  expect(node.dynamic?.[boundaryId]?.selected).toBe('crop')
  await assertNoUnsupportedDiagnostic(page)
})

test('forwarded selector displays and edits occurrence state while drilled in', async ({ page }) => {
  await drillIntoSub(page)
  await drag(page, await blankInputBoundaryPoint(page), await pinPoint(page, 'resize', 'resize'))
  const boundaryId = await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs['sub'] as unknown as {
      boundary: { inputs: Array<{ id: string }> }
    }
    return graph.boundary.inputs[0]!.id
  })
  await returnToRoot(page)
  await selectCombo(page, 'i0', boundaryId, 'crop')

  await drillIntoSub(page)
  expect(await page.evaluate(() => {
    const rows = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'resize')!.layout.rows as unknown as
      Array<{ kind: string; selector?: unknown; derivedValue?: unknown }>
    return rows.find((item) => item.kind === 'widget' && item.selector !== undefined)?.derivedValue
  })).toBe('crop')
  await selectCombo(page, 'resize', 'resize', 'fit', 0.25)

  await returnToRoot(page)
  expect(await page.evaluate(({ boundaryId }) => {
    const rows = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'i0')!.layout.rows as unknown as
      Array<{ kind: string; inputId?: string; derivedValue?: unknown }>
    return rows.find((item) => item.kind === 'widget' && item.inputId === boundaryId)?.derivedValue
  }, { boundaryId })).toBe('fit')
  await page.keyboard.press('Control+z')
  expect(await page.evaluate(({ boundaryId }) => {
    const rows = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'i0')!.layout.rows as unknown as
      Array<{ kind: string; inputId?: string; derivedValue?: unknown }>
    return rows.find((item) => item.kind === 'widget' && item.inputId === boundaryId)?.derivedValue
  }, { boundaryId })).toBe('crop')
})

test('region occurrences author independent conditional and promoted widget state', async ({ page }, testInfo) => {
  expect(await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const scalar = { kind: 'concrete', name: 'FLOAT' }
    app.registerSchemas([
      {
        type: 'RegionPassTest', displayName: 'Region Pass', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'item', type: scalar, optional: false },
          { kind: 'output', id: 'result', type: scalar },
        ],
      },
      {
        type: 'RegionAmountTest', displayName: 'Region Amount', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'amount', type: scalar, optional: true,
          widget: { widgetType: 'FLOAT', options: {}, default: 1 },
        }],
      },
      {
        type: 'RegionIndexSinkTest', displayName: 'Region Index Sink', category: 'test', source: 'v3', isOutputNode: true,
        items: [{ kind: 'input', id: 'index', type: { kind: 'concrete', name: 'core.int' }, optional: false }],
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
    return app.openDocument(document, 'Region conditional authoring')
  })).toEqual([])
  await identityViewport(page)
  await drillIntoSub(page)
  await drag(page, await regionIndexPoint(page), await pinPoint(page, 'indexSink', 'index'))
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('region-index-authoring.png') })
  expect(await page.evaluate(() => {
    const document = window.__dinksterTest!.app.activeTab()!.store.doc
    const i0 = Object.values(document.occurrenceTopologies?.i0?.links ?? {})[0]
    return {
      boundaryInputs: document.graphs['sub']!.boundary!.inputs.map((item) => item.id),
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
  await drag(page, await blankInputBoundaryPoint(page), await pinPoint(page, 'resize', 'resize'))
  const boundaryId = await page.evaluate(() => {
    const boundary = window.__dinksterTest!.app.activeTab()!.store.doc.graphs['sub']!.boundary!
    return boundary.inputs.find((item) => item.binds.node === 'resize')!.id
  })
  await returnToRoot(page)

  await selectCombo(page, 'i0', boundaryId, 'crop')
  await drillIntoSub(page)
  expect(await page.evaluate(() => {
    const rows = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'resize')!.layout.rows as unknown as
      Array<{ kind: string; selector?: unknown; derivedValue?: unknown }>
    return rows.find((row) => row.kind === 'widget' && row.selector !== undefined)?.derivedValue
  })).toBe('crop')
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  expect(await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'amount')!
    const rows = node.layout.rows as unknown as Array<{
      kind: string; inputId?: string; derivedValue?: unknown; familyOwner?: unknown
    }>
    const row = rows.find((item) => item.kind === 'widget' && item.inputId === 'amount')!
    return { occurrenceValue: row.derivedValue !== undefined, occurrenceOwner: row.familyOwner !== undefined }
  })).toEqual({ occurrenceValue: false, occurrenceOwner: false })
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
  expect(document.graphs['g0']!.nodes['i0']!.dynamic?.[boundaryId]?.selected).toBe('crop')
  expect(document.graphs['g0']!.nodes['i0']!.values['amount']).toBe(5.5)
  expect(document.graphs['g0']!.nodes['i1']!.dynamic?.[boundaryId]?.selected).toBeUndefined()
  expect(document.graphs['g0']!.nodes['i1']!.values['amount']).toBe(9)
  expect(document.graphs['sub']!.nodes['amount']!.values['amount']).toBeUndefined()
  expect(await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.map((node) => ({
      id: node.id,
      regionKind: (node as unknown as { regionKind?: string }).regionKind,
      rows: node.layout.rows.map((row) => row.inputId).filter((id): id is string => id !== undefined),
      pins: node.layout.pins.map((pin) => pin.portId),
    })))).toEqual([
    {
      id: 'i0', regionKind: 'map', rows: expect.arrayContaining(['amount', boundaryId]),
      pins: expect.arrayContaining([`${boundaryId}.[crop].ratio`]),
    },
    {
      id: 'i1', regionKind: 'map', rows: expect.arrayContaining(['amount', boundaryId]),
      pins: expect.arrayContaining([`${boundaryId}.[fit].width`]),
    },
  ])
  await page.getByRole('button', { name: /^Toggle right rail/ }).click()
  await page.getByTestId('graph-canvas').screenshot({ path: testInfo.outputPath('region-occurrence-authoring.png') })

  await page.keyboard.press('Control+z')
  document = await activeDoc(page)
  expect(document.graphs['g0']!.nodes['i0']!.values['amount']).toBe(2)
  expect(document.graphs['g0']!.nodes['i0']!.dynamic?.[boundaryId]?.selected).toBe('crop')
  expect(document.graphs['g0']!.nodes['i1']!.values['amount']).toBe(9)

  const exported = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    return app.exportDocument(tab.id)!
  })
  expect(await page.evaluate((saved) =>
    window.__dinksterTest!.app.openDocument(saved, 'Reopened region authoring', undefined, true), exported,
  )).toEqual([])
  document = await activeDoc(page)
  expect(document.graphs['g0']!.nodes['i0']!.dynamic?.[boundaryId]?.selected).toBe('crop')
  expect(document.graphs['g0']!.nodes['i0']!.values['amount']).toBe(2)
  expect(document.graphs['g0']!.nodes['i1']!.values['amount']).toBe(9)
  await assertNoUnsupportedDiagnostic(page)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().diagnostics)).toEqual([])
})

test('DynamicSlot reveals and hides its dependent row when connected and disconnected', async ({ page }) => {
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

test('explicitly upgrades persisted selector-only boundaries and keeps branch values independent', async ({ page }, testInfo) => {
  const failures = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'ResizeTest', displayName: 'Resize Test', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'input', id: 'resize', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: { kind: 'dynamicCombo', defaultOption: 'fit', options: [
          { key: 'fit', inputs: [{ kind: 'input', id: 'width', type: { kind: 'concrete', name: 'INT' }, optional: true, widget: { widgetType: 'INT', default: 512, options: {} } }] },
          { key: 'crop', inputs: [{ kind: 'input', id: 'ratio', type: { kind: 'concrete', name: 'FLOAT' }, optional: true, widget: { widgetType: 'FLOAT', default: 1, options: {} } }] },
        ] },
      }],
    }])
    const doc = JSON.parse(JSON.stringify(app.activeTab()!.store.doc))
    doc.lineage = 'boundary-conditional-upgrade'
    doc.graphs.g0.nodes = { i0: { id: 'i0', type: '#sub', values: {} }, i1: { id: 'i1', type: '#sub', values: { 'choice.[fit].width': 900 } } }
    doc.graphs.sub.nodes.resize.values = { 'resize.[fit].width': 640 }
    doc.graphs.sub.boundary.inputs = [{ id: 'choice', binds: { kind: 'port', node: 'resize', port: 'resize' } }]
    doc.view.graphs.g0.nodes = { i0: { position: { x: 100, y: 100 } }, i1: { position: { x: 520, y: 100 } } }
    return app.openDocument(doc, 'Full branch boundaries')
  })
  expect(failures).toEqual([])
  expect((await activeDoc(page)).graphs['sub']!.boundary!.inputs).toEqual([{ id: 'choice', binds: { kind: 'port', node: 'resize', port: 'resize' } }])
  await identityViewport(page)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes[0]!.layout.rows.some((row) => row.inputId === 'choice.[fit].width'))).toBe(false)
  await drillIntoSub(page)
  expect(await page.evaluate(() => ({ stack: window.__dinksterTest!.app.activeTab()!.graphStack.get(), graph: window.__dinksterTest!.renderer!.getScene().graphId }))).toEqual({ stack: ['g0', 'sub'], graph: 'sub' })
  expect((await activeDoc(page)).graphs['sub']!.boundary!.inputs).toEqual([{ id: 'choice', binds: { kind: 'port', node: 'resize', port: 'resize' } }])
  await expect(page.getByTestId('boundary-panel')).toContainText('Selector only: branch inputs stay definition-owned.')
  await page.screenshot({ path: testInfo.outputPath('selector-only-before.png') })
  await page.getByRole('button', { name: 'Upgrade to full branch for Resize', exact: true }).click()
  await expect(page.getByTestId('boundary-panel')).toContainText('Full branch: inputs and values are independent on each instance.')
  await returnToRoot(page)
  const values = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.map((node) => ({ id: node.id, width: (node as unknown as { node: { values: Record<string, unknown> } }).node.values['choice.[fit].width'], rows: node.layout.rows.map((row) => row.inputId) })))
  expect(values).toEqual([
    { id: 'i0', width: 640, rows: expect.arrayContaining(['choice', 'choice.[fit].width']) },
    { id: 'i1', width: 900, rows: expect.arrayContaining(['choice', 'choice.[fit].width']) },
  ])
  await page.screenshot({ path: testInfo.outputPath('full-branch-after.png') })
  await selectCombo(page, 'i0', 'choice', 'crop')
  const doc = await activeDoc(page)
  expect(doc.graphs['sub']!.nodes['resize']!.dynamic).toBeUndefined()
  expect(doc.graphs['sub']!.nodes['resize']!.values).toEqual({ 'resize.[fit].width': 640 })
  expect(doc.graphs['g0']!.nodes['i1']!.values).toEqual({ 'choice.[fit].width': 900 })
  await page.evaluate((saved) => window.__dinksterTest!.app.openDocument(saved, 'Reopened full branches', undefined, true), doc)
  expect((await activeDoc(page)).graphs).toEqual(doc.graphs)
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'i0')!.layout.rows.some((row) => row.inputId === 'choice.[crop].ratio'))).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('reopened-crop.png') })
})

test('specialized slots expose independent variants and editable dependents through two wrappers', async ({ page }, testInfo) => {
  const failures = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const concrete = (name: string) => ({ kind: 'concrete', name })
    const gain = { kind: 'input', id: 'gain', type: concrete('FLOAT'), optional: true, widget: { widgetType: 'FLOAT', default: 1, options: {} } }
    app.registerSchemas([
      { type: 'SpecializedTest', displayName: 'Specialized Test', category: 'test', source: 'v3', isOutputNode: true,
        items: [{ kind: 'input', id: 'data', type: { kind: 'variable', templateId: 'T' }, optional: true,
          dynamic: { kind: 'dynamicSlot', slotType: { kind: 'variable', templateId: 'T' }, typeTemplateId: 'T', inputs: [], variants: [
            { key: 'image', type: concrete('IMAGE'), inputs: [gain] }, { key: 'latent', type: concrete('LATENT'), inputs: [gain] },
          ] },
        }],
      },
      ...['IMAGE', 'LATENT'].map((type) => ({ type, displayName: type, category: 'test', source: 'v3', isOutputNode: false, items: [{ kind: 'output', id: 'out', type: concrete(type) }] })),
    ])
    const graph = (id: string, nodes: unknown, boundary?: unknown) => ({ id, name: id, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 100, ...(boundary ? { boundary } : {}) })
    return app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'nested-specialized-boundaries', root: 'g0',
      graphs: {
        g0: { ...graph('g0', {
          i0: { id: 'i0', type: '#sub', values: { 'data.[image].gain': 8 }, dynamic: { data: { selected: 'image' } } },
          i1: { id: 'i1', type: '#sub', values: { 'data.[latent].gain': 9 }, dynamic: { data: { selected: 'latent' } } },
          image: { id: 'image', type: 'IMAGE', values: {} }, latent: { id: 'latent', type: 'LATENT', values: {} },
        }), links: {
          l0: { id: 'l0', from: { node: 'image', port: 'out' }, to: { node: 'i0', port: 'data' } },
          l1: { id: 'l1', from: { node: 'latent', port: 'out' }, to: { node: 'i1', port: 'data' } },
        } },
        sub: graph('sub', { i0: { id: 'i0', type: '#body', values: {} } }, { inputs: [{ id: 'data', binds: { kind: 'port', node: 'i0', port: 'data' } }], outputs: [] }),
        body: graph('body', { leaf: { id: 'leaf', type: 'SpecializedTest', values: {} } }, { inputs: [{ id: 'data', binds: { kind: 'slot', node: 'leaf', port: 'data' } }], outputs: [] }),
      },
      view: { graphs: {
        g0: { nodes: { i0: { position: { x: 150, y: 100 } }, i1: { position: { x: 550, y: 100 } }, image: { position: { x: 100, y: 400 } }, latent: { position: { x: 500, y: 400 } } } },
        sub: { nodes: { i0: { position: { x: 350, y: 200 } } } },
        body: { nodes: { leaf: { position: { x: 350, y: 200 } } } },
      } },
    }, 'Independent specialized slots')
  })
  expect(failures).toEqual([])
  await identityViewport(page)
  await drillIntoSub(page)
  await expect(page.getByTestId('boundary-panel')).toContainText('Slot dependents are not forwarded.')
  await page.getByRole('button', { name: 'Forward full slot for Data', exact: true }).click()
  await expect(page.getByTestId('boundary-panel')).toContainText('Full slot: specialization and dependents are independent on each instance.')
  await returnToRoot(page)
  const rows = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.filter((node) => node.id === 'i0' || node.id === 'i1').map((node) => node.layout.rows.map((row) => row.inputId)))
  expect(rows[0]).toContain('data.[image].gain')
  expect(rows[1]).toContain('data.[latent].gain')
  const original = await activeDoc(page)
  await page.screenshot({ path: testInfo.outputPath('specialized-siblings.png') })
  await drillIntoSub(page)
  await drillIntoSub(page)
  const gain = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'leaf')!
    const row = node.layout.rows.find((entry) => entry.inputId === 'data.[image].gain')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(gain.x, gain.y)
  const editor = page.getByTestId('widget-editor').locator('input')
  await editor.fill('12')
  await editor.press('Enter')
  expect((await activeDoc(page)).graphs['g0']!.nodes['i0']!.values['data.[image].gain']).toBe(12)
  const input = await pinPoint(page, 'leaf', 'data')
  await page.mouse.click(input.x, input.y, { button: 'right' })
  await page.locator('[data-item-id="core.slot.specialize.latent"]').click()
  const changed = await activeDoc(page)
  expect(changed.graphs['g0']!.nodes['i0']!.dynamic?.['data']?.selected).toBe('latent')
  expect(changed.graphs['sub']).toEqual(original.graphs['sub'])
  expect(changed.graphs['body']).toEqual(original.graphs['body'])
  await page.keyboard.press('Control+z')
  await returnToRoot(page)
  const compiled = await page.evaluate(() => window.__dinksterTest!.app.compileTab(window.__dinksterTest!.app.activeTab()!))
  expect(compiled?.ok).toBe(true)
  if (!compiled?.ok) throw new Error(JSON.stringify(compiled))
  const prompt = (compiled.artifact as unknown as { prompt: Record<string, unknown> }).prompt
  expect(prompt['i0.i0.leaf']).toMatchObject({ inputs: { 'data.gain': 12 }, slotVariants: { data: 'image' } })
  expect(prompt['i1.i0.leaf']).toMatchObject({ inputs: { 'data.gain': 9 }, slotVariants: { data: 'latent' } })
  const saved = await activeDoc(page)
  expect(await page.evaluate((doc) => window.__dinksterTest!.app.openDocument(doc, 'Reopened specialized slots', undefined, true), saved)).toEqual([])
  expect((await activeDoc(page)).graphs).toEqual(saved.graphs)
})
