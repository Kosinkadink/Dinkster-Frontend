/**
 * Runs against the standing :5199 dev server and real native :8765 catalog
 * (no webServer, no catalog mocks). Backend
 * mutation routes are intercepted defensively; the scenarios never submit
 * jobs or upload assets.
 *
 * Proven in the deployed app: dragging a widget-tap producer onto a
 * subgraph boundary Outputs panel (fresh drag and Alt fan-out, existing
 * pin / add slot / panel body surfaces) preserves exact tap identity, while
 * ordinary port-output boundary exposure on the same panel still works.
 * The unit matrix is in
 * canvas/test/interaction.test.ts ("modifier parity across link endpoint
 * kinds").
 */
import { expect, test, type Page } from '@playwright/test'
import { openRailPanel, skipWithoutNativeCatalog } from './fixtures.js'

const proofDir = '/tmp/audit-live-proof'
const ADD_SLOT = '__add__'

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
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-live-proof', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: {
          i0: { id: 'i0', type: '#sub', values: {} },
        }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10 },
        sub: { id: 'sub', name: 'Wrapper', nodes: {
          tap: { id: 'tap', type: 'TapWidget', values: { amount: 2 } },
          sink: { id: 'sink', type: 'FloatSink', values: {} },
          src: { id: 'src', type: 'FloatSource', values: {} },
        }, links: {
          tapLink: { id: 'tapLink', from: { node: 'tap', tap: 'amount' }, to: { node: 'sink', port: 'value' } },
        }, nets: {}, reroutes: {}, boundary: {
          inputs: [],
          outputs: [{ id: 'result', binds: { kind: 'port', node: 'src', port: 'out' } }],
        }, nextOrdinal: 40 },
      },
      view: { graphs: {
        g0: { nodes: { i0: { position: { x: 200, y: 160 } } } },
        sub: { nodes: {
          tap: { position: { x: 80, y: 120 } },
          sink: { position: { x: 420, y: 320 } },
          src: { position: { x: 80, y: 420 } },
        } },
      } },
    }, 'audit live proof')
    if (failures.length > 0) throw new Error(`openDocument failed: ${JSON.stringify(failures)}`)
    bridge.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

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
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

const subState = (page: Page) => page.evaluate(() => {
  const bridge = window.__dinksterTest!
  const doc = bridge.app.activeTab()!.store.doc
  const graph = doc.graphs['sub']! as unknown as {
    nodes: Record<string, unknown>
    links: Record<string, object>
    boundary?: { inputs: readonly unknown[]; outputs: readonly unknown[] }
  }
  return {
    nodes: Object.keys(graph.nodes).sort(),
    links: Object.entries(graph.links).map(([id, link]) => ({ id, ...link })),
    boundary: graph.boundary ?? null,
    revision: bridge.app.activeTab()!.store.revision,
  }
})

async function tapPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) =>
      item.direction === 'out' && (item as { widgetTap?: true }).widgetTap === true)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width, y: rect.top + node.y + pin.y }
  }, nodeId)
}

async function inputPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => item.direction === 'in')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x, y: rect.top + node.y + pin.y }
  }, nodeId)
}

async function outputPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) =>
      item.direction === 'out' && (item as { widgetTap?: true }).widgetTap !== true)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width, y: rect.top + node.y + pin.y }
  }, nodeId)
}

async function boundaryPoint(page: Page, portId: string | 'body'): Promise<{ x: number; y: number }> {
  return page.evaluate((portId) => {
    const bnode = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((b) => b.side === 'outputs')
    if (!bnode) throw new Error('no outputs boundary panel')
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    if (portId === 'body') {
      return {
        x: rect.left + bnode.x + bnode.layout.width / 2,
        y: rect.top + bnode.y + bnode.layout.headerHeight + (bnode.layout.height - bnode.layout.headerHeight) / 2,
      }
    }
    // Outputs-side boundary pins face in: their hit point is the panel's
    // LEFT edge (hit.ts nearestBoundaryPin uses bnode.x for direction 'in').
    const pin = bnode.layout.pins.find((p) => p.portId === portId)!
    return { x: rect.left + bnode.x, y: rect.top + bnode.y + pin.y }
  }, portId)
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number },
  modifier?: 'Alt'): Promise<void> {
  await page.mouse.move(from.x, from.y)
  if (modifier) await page.keyboard.down(modifier)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
  if (modifier) await page.keyboard.up(modifier)
}

const pageErrors: string[] = []
let assetPosts = 0
let jobPosts = 0

test.beforeEach(async ({ page, request }, testInfo) => {
  await skipWithoutNativeCatalog(request, testInfo)
  pageErrors.length = 0
  assetPosts = 0
  jobPosts = 0
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/api/assets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    assetPosts += 1
    await route.fulfill({ status: 200, json: { digest: `blake3:${'d'.repeat(64)}` } })
  })
  await page.route('**/api/jobs', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    jobPosts += 1
    await route.fulfill({ status: 202, json: { jobRef: 'audit-live-mocked-job' } })
  })
  const catalog = await page.request.get('/api/nodes')
  expect(catalog.ok()).toBe(true)
  expect(((await catalog.json()) as { dinkster?: { schemaWire?: number } }).dinkster?.schemaWire).toBeGreaterThan(0)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0,
  ), { timeout: 20_000 }).toBeGreaterThan(0)
  await openFixture(page)
  await drillIntoSub(page)
})

test.afterEach(() => {
  expect(pageErrors).toEqual([])
  expect(assetPosts).toBe(0)
  expect(jobPosts).toBe(0)
})

test('live: fresh tap drag re-points an existing boundary output', async ({ page }) => {
  const before = await subState(page)
  await drag(page, await tapPoint(page, 'tap'), await boundaryPoint(page, 'result'))
  const after = await subState(page)
  expect(after.revision).toBeGreaterThan(before.revision)
  expect(after.links).toEqual(before.links)
  expect(after.boundary?.outputs).toEqual([{
    id: 'result', binds: { kind: 'widgetTap', node: 'tap', tap: 'amount' },
  }])
  await expect(page.locator('[data-binding-kind="widgetTap"]')).toContainText('Widget output')
  await page.screenshot({ path: `${proofDir}/live-d1-fresh-existing-pin.png` })
})

test('live: fresh tap drag creates a boundary output from the add slot', async ({ page }) => {
  const before = await subState(page)
  await drag(page, await tapPoint(page, 'tap'), await boundaryPoint(page, ADD_SLOT))
  const after = await subState(page)
  expect(after.revision).toBeGreaterThan(before.revision)
  expect(after.links).toEqual(before.links)
  expect(after.boundary?.outputs).toContainEqual({
    id: 'amount', binds: { kind: 'widgetTap', node: 'tap', tap: 'amount' },
  })
  await page.screenshot({ path: `${proofDir}/live-d2-fresh-add-slot.png` })
})

test('live: Alt fan-out from a connected tap link exposes on the panel body', async ({ page }) => {
  const before = await subState(page)
  await drag(page, await inputPoint(page, 'sink'), await boundaryPoint(page, 'body'), 'Alt')
  const after = await subState(page)
  expect(after.revision).toBeGreaterThan(before.revision)
  expect(after.boundary?.outputs).toEqual([{
    id: 'result', binds: { kind: 'widgetTap', node: 'tap', tap: 'amount' },
  }])
  expect(after.links.map((l) => l.id)).toContain('tapLink')
  await page.screenshot({ path: `${proofDir}/live-d3-alt-fanout-body.png` })
})

test('live: ordinary port output still exposes on the same boundary panel', async ({ page }) => {
  const before = await subState(page)
  const from = await outputPoint(page, 'src')
  const to = await boundaryPoint(page, ADD_SLOT)
  await drag(page, from, to)
  await expect.poll(async () => {
    const state = await subState(page)
    return (state.boundary?.outputs ?? []).length
  }).toBe(2)
  const after = await subState(page)
  expect(after.revision).toBeGreaterThan(before.revision)
  await page.screenshot({ path: `${proofDir}/live-d4-port-expose-control.png` })
})
