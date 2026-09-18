/**
 * A document tick that rebuilds a content-identical scene for the displayed
 * graph (an edit in another graph, a workspace-session swap re-reading an
 * equal document) must not disturb an in-flight link drag: the renderer
 * keeps the installed scene, so scene-replacement listeners never fire and
 * the drag commits normally on release. Issue #213.
 */
import { expect, test, type Page } from './fixtures.js'

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

async function pinPoint(
  page: Page,
  nodeId: string,
  direction: 'in' | 'out',
  portId: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, direction, portId }) => {
      const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const pin = node.layout.pins.find((p) => p.direction === direction && p.portId === portId)
      if (!pin) throw new Error(`no pin ${direction}:${portId} on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return {
        x: rect.left + node.x + (direction === 'out' ? node.layout.width : 0),
        y: rect.top + node.y + pin.y,
      }
    },
    { nodeId, direction, portId },
  )
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  const failures = await page.evaluate(() => {
    const IMAGE = { kind: 'concrete', name: 'IMAGE' }
    const schemaOf = (type: string, items: unknown[]) =>
      ({ type, displayName: type, category: 'test', source: 'v3', isOutputNode: false, items })
    window.__dinksterTest!.app.registerSchemas([
      schemaOf('RebuildSrcTest', [{ kind: 'output', id: 'out', type: IMAGE }]),
      schemaOf('RebuildSnkTest', [{ kind: 'input', id: 'in', type: IMAGE, optional: false }]),
    ] as never)
    return window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'scene-rebuild-drag', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            src: { id: 'src', type: 'RebuildSrcTest', values: {} },
            snk: { id: 'snk', type: 'RebuildSnkTest', values: {} },
            inst: { id: 'inst', type: '#sub', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        },
        sub: {
          id: 'sub', name: 'sub',
          nodes: { inner: { id: 'inner', type: 'RebuildSrcTest', values: {} } },
          links: {}, nets: {}, reroutes: {},
          boundary: {
            inputs: [],
            outputs: [{ id: 'r', binds: { kind: 'port', node: 'inner', port: 'out' } }],
          },
          nextOrdinal: 10,
        },
      },
      view: { graphs: {
        g0: { nodes: {
          src: { position: { x: 100, y: 150 } },
          snk: { position: { x: 500, y: 150 } },
          inst: { position: { x: 100, y: 420 } },
        } },
        sub: { nodes: { inner: { position: { x: 50, y: 50 } } } },
      } },
    }, 'Scene rebuild drag')
  })
  expect(failures).toEqual([])
  await identityViewport(page)
})

test('a link drag survives a rebuild that leaves the displayed graph unchanged', async ({ page }) => {
  const from = await pinPoint(page, 'src', 'out', 'out')
  const to = await pinPoint(page, 'snk', 'in', 'in')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)

  const ghostBefore = await page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getOverlay() as { ghostLink?: object }).ghostLink !== undefined)
  expect(ghostBefore).toBe(true)

  // Mid-drag, edit the OTHER graph: docTick fires, the displayed graph's
  // scene rebuilds with identical content - the same shape a workspace
  // session swap produces.
  const moved = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      dispatchTo(tab: unknown, invocation: { command: string; params: unknown }): { ok: boolean }
    }
    return app.dispatchTo(app.activeTab(), {
      command: 'node.move',
      params: { graphId: 'sub', positions: { inner: { x: 80, y: 90 } } },
    }).ok
  })
  expect(moved).toBe(true)

  // The drag is still alive: its ghost noodle survived the rebuild.
  const ghostAfter = await page.evaluate(() =>
    (window.__dinksterTest!.renderer!.getOverlay() as { ghostLink?: object }).ghostLink !== undefined)
  expect(ghostAfter).toBe(true)

  await page.mouse.up()
  const links = await page.evaluate(() =>
    Object.values(window.__dinksterTest!.app.activeTab()!.store.doc.graphs['g0']!.links))
  expect(links.some((l) =>
    'node' in l.from && l.from.node === 'src' &&
    'node' in l.to && l.to.node === 'snk' && l.to.port === 'in')).toBe(true)
})

test('an edit in the displayed graph still replaces the scene', async ({ page }) => {
  // The guard must not over-hold the old scene: a real change in the
  // displayed graph installs the new one.
  const before = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'src')!
    return { x: node.x, y: node.y }
  })
  const moved = await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      activeTab(): unknown
      dispatchTo(tab: unknown, invocation: { command: string; params: unknown }): { ok: boolean }
    }
    return app.dispatchTo(app.activeTab(), {
      command: 'node.move',
      params: { graphId: 'g0', positions: { src: { x: 130, y: 170 } } },
    }).ok
  })
  expect(moved).toBe(true)
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'src')!
    return { x: node.x, y: node.y }
  })).toEqual({ x: 130, y: 170 })
  expect(before).toEqual({ x: 100, y: 150 })
})
