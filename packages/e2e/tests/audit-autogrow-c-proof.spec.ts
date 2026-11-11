import { expect, test, type Page } from '@playwright/test'
import { openRailPanel } from './fixtures.js'

interface Point {
  readonly x: number
  readonly y: number
}

async function drag(page: Page, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function pinPoint(
  page: Page,
  nodeId: string,
  port: string,
  member: string,
  ghost: boolean,
  direction: 'in' | 'out' = 'in',
): Promise<Point> {
  return page.evaluate(({ nodeId, port, member, ghost, direction }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)
    const pin = node?.layout.pins.find((candidate) =>
      candidate.direction === direction &&
      candidate.address.port === port &&
      candidate.address.members?.[0] === member &&
      Boolean(candidate.ghost) === ghost)
    if (!node || !pin) throw new Error(`missing ${ghost ? 'ghost' : 'member'} pin ${nodeId}/${port}#${member}`)
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + (direction === 'out' ? node.layout.width : 0),
      y: canvas.top + node.y + pin.y,
    }
  }, { nodeId, port, member, ghost, direction })
}

async function sourcePoint(page: Page, nodeId: string): Promise<Point> {
  return page.evaluate((id) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === id)
    const pin = node?.layout.pins.find((candidate) => candidate.direction === 'out' && candidate.address.port === 'out')
    if (!node || !pin) throw new Error(`missing source pin ${id}/out`)
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width, y: canvas.top + node.y + pin.y }
  }, nodeId)
}

async function boundaryPoint(page: Page, item: string): Promise<Point> {
  return page.evaluate((itemId) => {
    const boundary = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((candidate) => candidate.side === 'inputs')
    const pin = boundary?.layout.pins.find((candidate) => candidate.portId === itemId)
    if (!boundary || !pin) throw new Error(`missing Inputs boundary pin ${itemId}`)
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + boundary.x + boundary.layout.width, y: canvas.top + boundary.y + pin.y }
  }, item)
}

async function openWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const image = { kind: 'concrete', name: 'IMAGE' }
    const family = {
      kind: 'input', id: 'pairs', type: image, optional: true,
      dynamic: {
        kind: 'autogrow',
        template: [
          { kind: 'input', id: 'image', type: image, optional: true },
          { kind: 'input', id: 'mask', type: image, optional: true },
        ],
        naming: { kind: 'prefix', prefix: 'pair', min: 0, max: 8 },
      },
    }
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'auditSource', displayName: 'Source', category: 'test', source: 'v3',
        isOutputNode: false, items: [{ kind: 'output', id: 'out', type: image }],
      },
      {
        type: 'auditGrouped', displayName: 'Grouped', category: 'test', source: 'v3',
        isOutputNode: false, items: [family],
      },
    ] as never)
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-autogrow-c', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root',
          nodes: {
            sourceA: { id: 'sourceA', type: 'auditSource', values: {} },
            sourceB: { id: 'sourceB', type: 'auditSource', values: {} },
            occurrence: { id: 'occurrence', type: '#body', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 1,
        },
        body: {
          id: 'body', name: 'Body',
          nodes: {
            forwardedFamily: { id: 'forwardedFamily', type: 'auditGrouped', values: {} },
            secondFamily: { id: 'secondFamily', type: 'auditGrouped', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 1,
          boundary: {
            inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'forwardedFamily', port: 'pairs' } }],
            outputs: [],
          },
        },
      },
      view: { graphs: {
        root: { nodes: {
          sourceA: { position: { x: 80, y: 120 } },
          sourceB: { position: { x: 80, y: 300 } },
          occurrence: { position: { x: 500, y: 160 } },
        } },
        body: { nodes: {
          forwardedFamily: { position: { x: 300, y: 100 } },
          secondFamily: { position: { x: 650, y: 320 } },
        } },
      } },
    } as never, 'Outside Autogrow Option C')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

test('outside per-family ghost growth advances, persists, drills, and refuses family fan-out atomically', async ({ page }) => {
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'audit-proof', schemaWire: 1 }, nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get().length ?? 0)).toBe(1)
  await openWorkflow(page)
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'audit-autogrow-c'
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    return Object.fromEntries(scene.nodes.map((node) => [node.id, node.layout.pins.map((pin) => pin.portId)]))
  })).toMatchObject({
    sourceA: ['out'],
    sourceB: ['out'],
    occurrence: ['forwarded.image#m0', 'forwarded.mask#m0'],
  })

  await drag(page, await sourcePoint(page, 'sourceA'), await pinPoint(page, 'occurrence', 'forwarded.image', 'm0', true))
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    return {
      dynamic: graph.nodes.occurrence!.dynamic,
      links: Object.values(graph.links).map((link) => link.to),
    }
  })).toEqual({
    dynamic: { forwarded: { members: ['m0'], seq: 1 } },
    links: [{ node: 'occurrence', port: 'forwarded.image', members: ['m0'] }],
  })

  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    const ghosts = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'occurrence')!
      .layout.pins.filter((pin) => pin.ghost).map((pin) => pin.address.members?.[0])
    return { dynamic: graph.nodes.occurrence!.dynamic, links: Object.keys(graph.links).length, ghosts }
  })).toEqual({ dynamic: { forwarded: { seq: 1 } }, links: 0, ghosts: ['m1', 'm1'] })

  await drag(page, await sourcePoint(page, 'sourceA'), await pinPoint(page, 'occurrence', 'forwarded.image', 'm1', true))
  await drag(page, await sourcePoint(page, 'sourceB'), await pinPoint(page, 'occurrence', 'forwarded.image', 'm2', true))
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    const ghosts = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'occurrence')!
      .layout.pins.filter((pin) => pin.ghost).map((pin) => pin.address.members?.[0])
    return { dynamic: graph.nodes.occurrence!.dynamic, links: Object.keys(graph.links).length, ghosts }
  })).toEqual({ dynamic: { forwarded: { members: ['m1', 'm2'], seq: 3 } }, links: 2, ghosts: ['m3', 'm3'] })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const exported = app.exportDocument(app.activeTab()!.id)!
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Outside Autogrow Reopened')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'audit-autogrow-c'
  })).toBe(true)
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    return { dynamic: graph.nodes.occurrence!.dynamic, links: Object.values(graph.links).map((link) => link.to) }
  })).toEqual({
    dynamic: { forwarded: { members: ['m1', 'm2'], seq: 3 } },
    links: [
      { node: 'occurrence', port: 'forwarded.image', members: ['m1'] },
      { node: 'occurrence', port: 'forwarded.image', members: ['m2'] },
    ],
  })

  const occurrenceHeader = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'occurrence')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x + node.layout.width / 2, y: canvas.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.dblclick(occurrenceHeader.x, occurrenceHeader.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'forwardedFamily')!
    return node.layout.pins.filter((pin) => !pin.ghost && pin.address.port === 'pairs.image')
      .map((pin) => pin.address.members?.[0])
  })).toEqual(['\u0000m1', '\u0000m2'])

  const beforeRefusal = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      revision: tab.store.revision,
      boundary: JSON.stringify((tab.store.doc.graphs.body as any).boundary),
      secondDynamic: JSON.stringify(tab.store.doc.graphs.body!.nodes.secondFamily!.dynamic ?? null),
    }
  })
  await drag(
    page,
    await pinPoint(page, 'secondFamily', 'pairs.image', 'm0', true),
    await boundaryPoint(page, 'forwarded'),
  )
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((problem) => problem.code === 'boundary.bindKind')
    .map((problem) => problem.message))).toEqual([
    "boundary.addBinding: boundary input 'forwarded' forwards a family; family forwarding cannot fan out",
  ])
  expect(await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return {
      revision: tab.store.revision,
      boundary: JSON.stringify((tab.store.doc.graphs.body as any).boundary),
      secondDynamic: JSON.stringify(tab.store.doc.graphs.body!.nodes.secondFamily!.dynamic ?? null),
    }
  })).toEqual(beforeRefusal)
})
