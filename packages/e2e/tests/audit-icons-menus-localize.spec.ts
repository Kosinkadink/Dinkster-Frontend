import { expect, test, type Page } from './fixtures.js'

async function nodePoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === id)
    if (!node) throw new Error(`missing node '${id}'`)
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  }, nodeId)
}

test('icons, shortcut pills, localize, linked counts, and region tooltips compose', async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'audit-icons',
      root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root',
          nodes: {
            first: { id: 'first', type: '#shared', values: {} },
            second: { id: 'second', type: '#shared', values: {} },
            loop: {
              id: 'loop', type: '#loopBody', values: { state: 0 },
              region: {
                kind: 'while', statePorts: ['state'],
                outputRoles: { result: { kind: 'state', statePort: 'state' } },
                continueOutput: 'continue', maxIterations: 12,
              },
            },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 0,
        },
        shared: {
          id: 'shared', name: 'Shared', nodes: {}, links: {}, nets: {}, reroutes: {},
          boundary: { inputs: [], outputs: [] }, nextOrdinal: 0,
        },
        loopBody: {
          id: 'loopBody', name: 'Loop body',
          nodes: {
            state: { id: 'state', type: 'dinkster.float', values: {} },
            condition: { id: 'condition', type: 'dinkster.boolean', values: { value: true } },
          },
          links: {}, nets: {}, reroutes: {},
          boundary: {
            inputs: [{ id: 'state', binds: { kind: 'port', node: 'state', port: 'value' } }],
            outputs: [
              { id: 'result', binds: { kind: 'port', node: 'state', port: 'value' } },
              { id: 'continue', binds: { kind: 'port', node: 'condition', port: 'value' } },
            ],
          },
          nextOrdinal: 2,
        },
      },
      view: { graphs: {
        root: { nodes: {
          first: { position: { x: 160, y: 180 } },
          second: { position: { x: 500, y: 180 } },
          loop: { position: { x: 840, y: 180 } },
        } },
        shared: { nodes: {} },
        loopBody: { nodes: { state: { position: { x: 0, y: 0 } }, condition: { position: { x: 240, y: 0 } } } },
      } },
    } as never, 'audit icons')
  })
  // Workspace promotion replaces the local tab and rebuilds the scene, which
  // closes context menus. Interact only after the shared store is authoritative.
  await page.waitForFunction(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(3)

  const linked = await page.evaluate(() => (window.__dinksterTest!.renderer!.getBadges().first?.[0] as any))
  expect(linked).toMatchObject({ id: 'core.subgraph', glyph: '2', icon: 'boxes', variant: 'label' })

  await page.mouse.click(...Object.values(await nodePoint(page, 'first')) as [number, number])
  const toolbox = await page.evaluate(() => window.__dinksterTest!.renderer!.getToolboxLayout()!.buttons
    .filter((entry) => ['core.openSubgraph', 'core.extractSubgraph', 'core.flattenSubgraph'].includes(entry.button.id))
    .map((entry) => ({ id: entry.button.id, icon: entry.button.icon, name: entry.button.label })))
  expect(toolbox).toEqual([
    { id: 'core.openSubgraph', icon: 'folder-open', name: 'Open Subgraph' },
    { id: 'core.extractSubgraph', icon: 'group', name: 'Extract as Subgraph' },
    { id: 'core.flattenSubgraph', icon: 'ungroup', name: 'Flatten Subgraph One Level' },
  ])

  await page.mouse.click(...Object.values(await nodePoint(page, 'first')) as [number, number], { button: 'right' })
  await expect(page.locator('[data-item-id="core.node.localize"] [data-testid="menu-icon"] svg')).toBeVisible()
  await expect(page.locator('[data-item-id="core.subgraph.extract"] [data-testid="menu-shortcut"]')).toHaveText('ctrl+shift+e')
  await expect(page.locator('[data-item-id="core.subgraph.flatten"] [data-testid="menu-shortcut"]')).toHaveText('ctrl+shift+f')
  await expect(page.locator('[data-item-id="core.node.delete"] [data-testid="menu-shortcut"]')).toHaveText('delete')
  await page.locator('[data-item-id="core.node.localize"]').hover()
  await page.keyboard.press('Enter')

  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes.first!.type))
    .not.toBe('#shared')
  expect(await page.evaluate(() => (window.__dinksterTest!.renderer!.getBadges().first?.[0] as any)))
    .toMatchObject({ id: 'core.subgraph', glyph: 'S', icon: 'boxes' })
  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.root!.nodes.first!.type))
    .toBe('#shared')
  expect(await page.evaluate(() => (window.__dinksterTest!.renderer!.getBadges().first?.[0] as any)))
    .toMatchObject({ id: 'core.subgraph', glyph: '2', icon: 'boxes', variant: 'label' })

  const loop = await nodePoint(page, 'loop')
  await page.mouse.move(loop.x, loop.y)
  await expect(page.getByTestId('app-tooltip')).toContainText('While region')
  await expect(page.getByTestId('app-tooltip')).toContainText('Repeats state state while continue is true, up to 12 iterations.')
})
