/**
 * Browser proof for the persisted-member Autogrow lifecycle. This
 * intentionally uses real CanvasHost pointer gestures for ghost promotion and
 * automatic disconnect compaction and one-step undo/redo restoration.
 */
import { expect, test, type Page } from '@playwright/test'
import { openRailPanel } from './fixtures.js'

async function pinPoint(
  page: Page,
  member: string,
  ghost: boolean,
  nodeId = 'occurrence',
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, member, ghost }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) =>
      item.direction === 'in'
      && Boolean(item.ghost) === ghost
      && (item as any).address.port === 'forwarded.image'
      && (item as any).address.members?.[0] === member)
    if (!pin) throw new Error(`no ${ghost ? 'ghost' : 'persisted'} pin '${nodeId}/${member}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x, y: rect.top + node.y + pin.y }
  }, { nodeId, member, ghost })
}

async function sourcePoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'source')!
    const pin = node.layout.pins.find((item) => item.direction === 'out' && (item as any).address.port === 'out')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width, y: rect.top + node.y + pin.y }
  })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function openWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const image = { kind: 'concrete', name: 'IMAGE' }
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'AutogrowLifecycleSource', displayName: 'Source', category: 'test', source: 'v3',
        isOutputNode: false, items: [{ kind: 'output', id: 'out', type: image }],
      },
      {
        type: 'AutogrowLifecycleGrouped', displayName: 'Grouped', category: 'test', source: 'v3',
        isOutputNode: false,
        items: [{
          kind: 'input', id: 'pairs', type: image, optional: true,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'image', type: image, optional: true },
              { kind: 'input', id: 'mask', type: image, optional: true },
            ],
            naming: { kind: 'prefix', prefix: 'pair', min: 0, max: 3 },
          },
        }],
      },
    ] as never)
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'autogrow-lifecycle-e2e', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root',
          nodes: {
            source: { id: 'source', type: 'AutogrowLifecycleSource', values: {} },
            occurrence: { id: 'occurrence', type: '#body', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 1,
        },
        body: {
          id: 'body', name: 'Body',
          nodes: { grouped: { id: 'grouped', type: 'AutogrowLifecycleGrouped', values: {} } },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 1,
          boundary: {
            inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'grouped', port: 'pairs' } }],
            outputs: [],
          },
        },
      },
      view: {
        graphs: {
          root: { nodes: { source: { position: { x: 100, y: 160 } }, occurrence: { position: { x: 500, y: 120 } } } },
          body: { nodes: { grouped: { position: { x: 300, y: 140 } } } },
        },
      },
    } as never, 'Autogrow lifecycle')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

test('grouped forwarded disconnect compacts atomically and never recycles identity', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openWorkflow(page)
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'autogrow-lifecycle-e2e' && 'status' in tab.store
  })

  await drag(page, await sourcePoint(page), await pinPoint(page, 'm0', true))
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    const state = (graph.nodes.occurrence as any)!.dynamic?.forwarded
    const ghosts = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'occurrence')!
      .layout.pins.filter((pin) => pin.ghost).map((pin) => (pin as any).address.members?.[0])
    return { state, links: Object.keys(graph.links).length, ghosts }
  })).toEqual({ state: { members: ['m0'], seq: 1 }, links: 1, ghosts: ['m1', 'm1'] })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as any
    const exported = app.exportDocument(app.activeTab()!.id)!
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Autogrow reopened')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'autogrow-lifecycle-e2e' && 'status' in tab.store
  })
  expect(await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    return { dynamic: (graph.nodes.occurrence as any)!.dynamic, to: Object.values(graph.links)[0]!.to }
  })).toEqual({
    dynamic: { forwarded: { members: ['m0'], seq: 1 } },
    to: { node: 'occurrence', port: 'forwarded.image', members: ['m0'] },
  })

  const header = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'occurrence')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.dblclick(header.x, header.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  expect(await page.evaluate(() => {
    const pin = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'grouped')!
      .layout.pins.find((item) => !item.ghost && (item as any).address.members?.[0] === '\u0000m0')
    const link = Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.links)[0]!
    return { innerMember: (pin as any)?.address.members?.[0], ownerMember: (link.to as any).members?.[0] }
  })).toEqual({ innerMember: '\u0000m0', ownerMember: 'm0' })

  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))

  // Bulk/legacy cleanup remains available even though normal gestures compact.
  const occurrenceHeader = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'occurrence')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.click(occurrenceHeader.x, occurrenceHeader.y, { button: 'right' })
  await expect(page.getByTestId('context-menu').locator('[data-item-id="core.node.compactDynamic"]'))
    .toHaveText('Remove Unused Dynamic Inputs')
  await page.keyboard.press('Escape')

  const persisted = await pinPoint(page, 'm0', false)
  await drag(page, persisted, { x: persisted.x + 350, y: persisted.y + 250 })
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    return { dynamic: (graph.nodes.occurrence as any)!.dynamic, links: Object.keys(graph.links).length }
  })).toEqual({ dynamic: { forwarded: { seq: 1 } }, links: 0 })
  expect(await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'occurrence')!
    .layout.pins.filter((pin) => pin.ghost).map((pin) => (pin as any).address.members?.[0]))).toEqual(['m1', 'm1'])

  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  expect(await page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    return { dynamic: (graph.nodes.occurrence as any)!.dynamic, to: Object.values(graph.links)[0]!.to }
  })).toEqual({
    dynamic: { forwarded: { members: ['m0'], seq: 1 } },
    to: { node: 'occurrence', port: 'forwarded.image', members: ['m0'] },
  })
  expect(await page.evaluate(() => (window.__dinksterTest!.app.activeTab()!.store as any).redo())).toBe(true)
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    .nodes.occurrence as any).then((node) => node.dynamic)).toEqual({ forwarded: { seq: 1 } })

  await drag(page, await sourcePoint(page), await pinPoint(page, 'm1', true))
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!
    return { dynamic: (graph.nodes.occurrence as any)!.dynamic, to: Object.values(graph.links)[0]!.to }
  })).toEqual({
    dynamic: { forwarded: { members: ['m1'], seq: 2 } },
    to: { node: 'occurrence', port: 'forwarded.image', members: ['m1'] },
  })
})
