import { mkdirSync } from 'node:fs'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_385_SOCKET_PROOF_DIR']

async function sectionPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'advanced')!
    const row = node.layout.rows.find((candidate) =>
      candidate.kind === 'section' && candidate.sectionId === 'advanced')!
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  })
}

async function capture(page: Page, name: string): Promise<void> {
  const path = proofDir === undefined ? test.info().outputPath(name) : `${proofDir}/${name}`
  await page.screenshot({ path, animations: 'disabled', fullPage: true })
  await test.info().attach(name, { path, contentType: 'image/png' })
}

test('Advanced proxies restore endpoints and scalar-list sockets stay distinct', async ({ page }) => {
  if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'advanced-prominence-e2e', schemaWire: 1 },
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  await page.evaluate(() => {
    const concrete = (name: string) => ({ kind: 'concrete', name })
    const variable = { kind: 'variable', templateId: 'item_type' }
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'ImageSourceE2E', displayName: 'Image Source', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'image', type: concrete('IMAGE') }],
      },
      {
        type: 'ImageSinkE2E', displayName: 'Image Sink', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'image', type: concrete('IMAGE'), optional: false }],
      },
      {
        type: 'FloatSinkE2E', displayName: 'Float Sink', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'value', type: concrete('FLOAT'), optional: false }],
      },
      {
        type: 'AdvancedE2E', displayName: 'Advanced Controls', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'image', type: concrete('IMAGE'), optional: false },
          { kind: 'input', id: 'reference', type: concrete('IMAGE'), optional: true, advanced: true },
          {
            kind: 'input', id: 'caption', type: concrete('STRING'), optional: true,
            widget: { widgetType: 'STRING', options: {}, default: '' },
          },
          {
            kind: 'input', id: 'strength', type: concrete('FLOAT'), optional: true, advanced: true,
            widget: { widgetType: 'FLOAT', options: {}, default: 1 },
          },
          { kind: 'output', id: 'image', type: concrete('IMAGE') },
        ],
      },
      {
        type: 'WidgetSourceE2E', displayName: 'Widget Output', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'amount', type: concrete('FLOAT'), optional: true,
          widget: { widgetType: 'FLOAT', options: {}, default: 1 },
        }],
      },
      {
        type: 'CreateListE2E', displayName: 'Create List', category: 'test', source: 'v3', isOutputNode: false,
        items: [
          {
            kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: false,
            dynamic: {
              kind: 'autogrow',
              template: [{ kind: 'input', id: 'item', type: variable, optional: false }],
              naming: { kind: 'prefix', prefix: 'items', min: 1, max: 8 },
            },
          },
          { kind: 'output', id: 'list', type: { kind: 'list', element: variable } },
        ],
      },
      {
        type: 'GenericInputE2E', displayName: 'Scalar or List', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'value', type: variable, optional: false }],
      },
    ])
    const failures = window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'advanced-prominence-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Advanced prominence', nodes: {
        source: { id: 'source', type: 'ImageSourceE2E', values: {} },
        advanced: { id: 'advanced', type: 'AdvancedE2E', values: {} },
        sink: { id: 'sink', type: 'ImageSinkE2E', values: {} },
        floatSink: { id: 'floatSink', type: 'FloatSinkE2E', values: {} },
        widget: { id: 'widget', type: 'WidgetSourceE2E', values: { amount: 2 } },
        generic: { id: 'generic', type: 'GenericInputE2E', values: {} },
        list: {
          id: 'list', type: 'CreateListE2E', values: {},
          dynamic: { items: { members: ['m0'], seq: 1 } },
        },
      }, links: {
        imageIn: {
          id: 'imageIn',
          from: { node: 'source', port: 'image' },
          to: { node: 'advanced', port: 'image' },
        },
        imageOut: {
          id: 'imageOut',
          from: { node: 'advanced', port: 'image' },
          to: { node: 'sink', port: 'image' },
        },
        imageReference: {
          id: 'imageReference',
          from: { node: 'source', port: 'image' },
          to: { node: 'advanced', port: 'reference' },
        },
        strengthOut: {
          id: 'strengthOut',
          from: { node: 'advanced', tap: 'strength' },
          to: { node: 'floatSink', port: 'value' },
        },
        widgetItem: {
          id: 'widgetItem',
          from: { node: 'widget', tap: 'amount' },
          to: { node: 'list', port: 'items.item', members: ['m0'] },
        },
      }, nets: {}, reroutes: {}, nextOrdinal: 6 } },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 80, y: 120 } },
        advanced: { position: { x: 380, y: 90 }, size: { width: 260, height: 0 } },
        sink: { position: { x: 760, y: 120 } },
        floatSink: { position: { x: 760, y: 280 } },
        generic: { position: { x: 880, y: 390 }, size: { width: 220, height: 0 } },
        widget: { position: { x: 220, y: 430 }, size: { width: 220, height: 0 } },
        list: { position: { x: 610, y: 410 }, size: { width: 220, height: 0 } },
      } } } },
    }, 'Advanced Prominence')
    if (failures.length > 0) throw new Error(`openDocument failed: ${JSON.stringify(failures)}`)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const presentation = () => page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const advanced = scene.nodes.find((node) => node.id === 'advanced')!
    const list = scene.nodes.find((node) => node.id === 'list')!
    const advancedRow = advanced.layout.rows.find((row) =>
      row.kind === 'section' && row.sectionId === 'advanced')!
    const caption = advanced.layout.rows.find((row) => row.kind === 'widget' && row.inputId === 'caption')!
    const advancedPins = advanced.layout.pins
      .filter((pin) => pin.portId === 'reference' || pin.portId === 'strength' && pin.widgetTap === true)
      .map((pin) => ({
        portId: pin.portId,
        direction: pin.direction,
        y: advanced.y + pin.y,
        widgetTap: pin.widgetTap,
      }))
    const listPins = list.layout.pins.map((pin) => ({
      direction: pin.direction,
      members: pin.address.members,
      ghost: pin.ghost,
      type: pin.type,
    }))
    return {
      advancedY: advancedRow.y,
      advancedCollapsed: advancedRow.kind === 'section' && advancedRow.collapsed,
      ordinaryBeforeAdvanced: caption.y + caption.height <= advancedRow.y,
      advancedHeaderY: advanced.y + advancedRow.y + advancedRow.height / 2,
      advancedPins,
      group: advanced.layout.advancedGroup,
      listPins,
      widgetLink: scene.links.find((link) => link.id === 'widgetItem'),
      advancedLinks: scene.links
        .filter((link) => link.id === 'imageReference' || link.id === 'strengthOut')
        .map((link) => ({
          id: link.id,
          from: link.from,
          to: link.to,
          x1: link.x1,
          y1: link.y1,
          x2: link.x2,
          y2: link.y2,
        })),
      graph: JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']),
    }
  })

  const collapsed = await presentation()
  expect(collapsed.advancedCollapsed).toBe(true)
  expect(collapsed.ordinaryBeforeAdvanced).toBe(true)
  expect(collapsed.group).toBeUndefined()
  expect(collapsed.advancedPins).toEqual([
    expect.objectContaining({ portId: 'reference', direction: 'in' }),
    expect.objectContaining({ portId: 'strength', direction: 'out', widgetTap: true }),
  ])
  expect(collapsed.advancedPins.every((pin) => pin.y === collapsed.advancedHeaderY)).toBe(true)
  expect(collapsed.advancedLinks).toEqual([
    expect.objectContaining({
      id: 'imageReference',
      to: { kind: 'port', node: 'advanced', port: 'reference' },
      y2: collapsed.advancedHeaderY,
    }),
    expect.objectContaining({
      id: 'strengthOut',
      from: { kind: 'widgetTap', node: 'advanced', input: 'strength' },
      y1: collapsed.advancedHeaderY,
    }),
  ])
  expect(collapsed.listPins).toEqual(expect.arrayContaining([
    expect.objectContaining({ direction: 'in', members: ['m0'], ghost: undefined, type: { kind: 'concrete', name: 'FLOAT' } }),
    expect.objectContaining({ direction: 'in', ghost: true, type: { kind: 'concrete', name: 'FLOAT' } }),
    expect.objectContaining({ direction: 'out', type: { kind: 'list', element: { kind: 'concrete', name: 'FLOAT' } } }),
  ]))
  expect(collapsed.widgetLink).toMatchObject({
    from: { kind: 'widgetTap', node: 'widget', input: 'amount' },
    typeName: 'FLOAT',
  })
  await capture(page, 'issue-385-collapsed-proxy-anchors.png')

  const point = await sectionPoint(page)
  await page.mouse.click(point.x, point.y)
  await expect.poll(async () => (await presentation()).advancedCollapsed).toBe(false)
  const expanded = await presentation()
  expect(expanded.advancedY).toBe(collapsed.advancedY)
  expect(expanded.ordinaryBeforeAdvanced).toBe(true)
  expect(expanded.group).toBeDefined()
  expect(expanded.advancedPins.every((pin) => pin.y !== expanded.advancedHeaderY)).toBe(true)
  expect(expanded.advancedLinks).not.toEqual(collapsed.advancedLinks)
  expect(expanded.graph).toBe(collapsed.graph)
  await capture(page, 'issue-385-expanded-socket-rows.png')

  await page.mouse.click(point.x, point.y)
  await expect.poll(async () => (await presentation()).advancedCollapsed).toBe(true)
  expect((await presentation()).graph).toBe(collapsed.graph)
  await page.mouse.click(point.x, point.y)
  await expect.poll(async () => (await presentation()).advancedCollapsed).toBe(false)
  const restored = await presentation()
  expect(restored.advancedLinks).toEqual(expanded.advancedLinks)
  expect(restored.graph).toBe(collapsed.graph)
})
