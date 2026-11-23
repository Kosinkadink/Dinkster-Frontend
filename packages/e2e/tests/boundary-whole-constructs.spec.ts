/**
 * A whole group or choice shown on a subgraph node.
 *
 * The contract under test: the subgraph node outside shows the group's own
 * members and the choice with its pick and fields, stored on that node;
 * entering the subgraph from it shows the definition's members followed by
 * the outer node's, with the outer values, and an edit there is written on
 * the outer node; the "Show ... on subgraph node"
 * menu item adds one whole item to the boundary, and undo removes it.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openRailPanel, subgraphMarkPoint, test, waitForWorkspaceReady, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_SUBGRAPH_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

/** Widget rows of a scene node: flattened id, label and the shown value. */
const widgetRows = (page: Page, nodeId: string) =>
  page.evaluate((nodeId) => {
    type Row = { kind: string; inputId: string; label: string; derivedValue?: unknown; spec: { default?: unknown } }
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === nodeId)!
    const values = (node as unknown as { node: { values: Record<string, unknown> } }).node.values
    return (node.layout.rows as unknown as Row[]).flatMap((row) => row.kind !== 'widget' ? [] : [{
      key: row.inputId,
      label: row.label,
      value: row.derivedValue ?? values[row.inputId] ?? row.spec.default,
    }])
  }, nodeId)

async function widgetPoint(page: Page, nodeId: string, valueKey: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, valueKey }) => {
    const r = window.__dinksterTest!.renderer!
    const node = r.getScene().nodes.find((n) => n.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === valueKey)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = r.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + row.y + row.height / 2) * viewport.scale + viewport.y,
    }
  }, { nodeId, valueKey })
}

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

async function shot(page: Page, name: string): Promise<void> {
  if (proofDir) await page.getByTestId('graph-canvas').screenshot({ path: join(proofDir, `${name}.png`) })
}

test.beforeEach(async ({ page }) => {
  // Every node type here is registered by the page, so no backend is needed.
  await page.route(/\/api\/(?!library\/retention(?:s\/|-clients(?:\?|$))).*/, (route) => route.fulfill({ status: 503, json: {} }))
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'whole-constructs-fixture', schemaWire: 2 }, nodes: {},
  } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get() !== undefined)).toBe(true)
  await waitForWorkspaceReady(page)
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const FLOAT = { kind: 'concrete', name: 'FLOAT' } as const
    const STRING = { kind: 'concrete', name: 'STRING' } as const
    const IMAGE = { kind: 'concrete', name: 'IMAGE' } as const
    app.registerSchemas([
      {
        type: 'Weigh', displayName: 'Weigh', category: 'test', source: 'v3', isOutputNode: true,
        body: [
          {
            kind: 'group', id: 'weights', displayName: 'Weights',
            value: { kind: 'input', id: 'w', type: FLOAT, optional: true, widget: { widgetType: 'FLOAT', options: {}, default: 0.5 } },
            keys: { kind: 'numbered', prefix: 'w', start: 0, pad: 0 }, grows: 'link', minMembers: 0, maxMembers: 8,
          },
          { kind: 'output', id: 'out', type: IMAGE },
        ],
      },
      {
        type: 'Mode', displayName: 'Mode', category: 'test', source: 'v3', isOutputNode: true,
        body: [
          {
            kind: 'choice', id: 'mode', displayName: 'Mode', required: true, shared: [],
            options: [
              { key: 'image', rows: [{ kind: 'input', id: 'strength', type: FLOAT, optional: false, widget: { widgetType: 'FLOAT', options: {}, default: 0.3 } }] },
              { key: 'text', rows: [{ kind: 'input', id: 'words', type: STRING, optional: false, widget: { widgetType: 'STRING', options: {}, default: '' } }] },
            ],
          },
          { kind: 'output', id: 'out', type: IMAGE },
        ],
      },
      {
        type: 'Feather', displayName: 'Feather', category: 'test', source: 'v3', isOutputNode: true,
        body: [
          {
            kind: 'typeChoice', id: 'src', displayName: 'Source', required: false, rows: [],
            variants: [
              { key: 'image', type: IMAGE, rows: [] },
              { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, rows: [] },
            ],
          },
          { kind: 'output', id: 'out', type: IMAGE },
        ],
      },
    ] as never)
    await app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-whole-constructs',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0', name: 'root',
            nodes: {
              i0: {
                id: 'i0', type: '#sub',
                dynamic: { mix: { members: ['w0', 'w1'] }, look: { selected: 'text' } },
                values: { 'mix.w0': 0.2, 'mix.w1': 0.8, 'look.words': 'portrait' },
              },
            },
            links: {}, nets: {}, reroutes: {}, nextOrdinal: 100,
          },
          sub: {
            id: 'sub', name: 'Detail pass',
            nodes: {
              n: { id: 'n', type: 'Weigh', dynamic: { weights: { members: ['w0'] } }, values: { 'weights.w0': 0.1 } },
              m: { id: 'm', type: 'Mode', dynamic: { mode: { selected: 'image' } }, values: {} },
              spare: { id: 'spare', type: 'Mode', dynamic: { mode: { selected: 'image' } }, values: {} },
            },
            links: {}, nets: {}, reroutes: {},
            boundary: {
              inputs: [
                { id: 'mix', binds: { kind: 'construct', node: 'n', port: 'weights' } },
                { id: 'look', binds: { kind: 'construct', node: 'm', port: 'mode' } },
              ],
              outputs: [],
            },
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: { nodes: { i0: { position: { x: 200, y: 160 } } } },
            sub: { nodes: { n: { position: { x: 400, y: 120 } }, m: { position: { x: 400, y: 340 } }, spare: { position: { x: 700, y: 340 } } } },
          },
        },
      },
      'WholeConstructs',
    )
  })
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === 'lineage-whole-constructs'
  })).toBe(true)
  await identityViewport(page)
})

test('the subgraph node shows the whole group and choice; entering shows definition members, then outer ones', async ({ page }) => {
  await expect.poll(() => widgetRows(page, 'i0')).toEqual([
    { key: 'mix.w0', label: expect.any(String), value: 0.2 },
    { key: 'mix.w1', label: expect.any(String), value: 0.8 },
    // The spare member a link-grown group offers, as on a plain node.
    { key: 'mix.w2', label: expect.any(String), value: 0.5 },
    { key: 'look', label: expect.any(String), value: 'text' },
    { key: 'look.words', label: expect.any(String), value: 'portrait' },
  ])
  await shot(page, 'outside')

  // The subgraph mark on the header enters the subgraph.
  const mark = await subgraphMarkPoint(page, 'i0')
  await page.mouse.dblclick(mark.x, mark.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await identityViewport(page)

  // The definition's own member first, then the outer node's two, with its values.
  await expect.poll(() => widgetRows(page, 'n')).toEqual([
    { key: 'weights.w0', label: expect.any(String), value: 0.1 },
    { key: 'weights.w1', label: expect.any(String), value: 0.2 },
    { key: 'weights.w2', label: expect.any(String), value: 0.8 },
    { key: 'weights.w3', label: expect.any(String), value: 0.5 },
  ])
  // The outer pick reaches the inner choice.
  await expect.poll(() => widgetRows(page, 'm')).toEqual([
    { key: 'mode', label: expect.any(String), value: 'text' },
    { key: 'mode.words', label: expect.any(String), value: 'portrait' },
  ])
  await shot(page, 'entered')

  // Picking inside writes the subgraph node's pick, never the definition's.
  const leader = await widgetPoint(page, 'm', 'mode')
  await page.mouse.click(leader.x, leader.y)
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toBeVisible()
  await dropdown.getByRole('option', { name: 'image', exact: true }).click()
  await expect.poll(async () => (await activeDoc(page)).graphs['g0']!.nodes['i0']!.dynamic?.['look']?.selected).toBe('image')
  expect((await activeDoc(page)).graphs['sub']!.nodes['m']!.dynamic?.['mode']?.selected).toBe('image')
  await expect.poll(() => widgetRows(page, 'm')).toEqual([
    { key: 'mode', label: expect.any(String), value: 'image' },
    { key: 'mode.strength', label: expect.any(String), value: 0.3 },
  ])
  // A field the subgraph node does not store yet is still its own: the edit
  // lands outside, and the definition keeps nothing.
  await page.getByTestId('graph-canvas').focus()
  const strength = await widgetPoint(page, 'm', 'mode.strength')
  await page.mouse.click(strength.x, strength.y)
  const editor = page.getByTestId('widget-editor').locator('input')
  await expect(editor).toBeVisible()
  await editor.fill('0.65')
  await editor.press('Enter')
  await expect.poll(async () => (await activeDoc(page)).graphs['g0']!.nodes['i0']!.values['look.strength']).toBe(0.65)
  expect((await activeDoc(page)).graphs['sub']!.nodes['m']!.values).toEqual({})
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await activeDoc(page)).graphs['g0']!.nodes['i0']!.values['look.strength']).toBeUndefined()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await activeDoc(page)).graphs['g0']!.nodes['i0']!.dynamic?.['look']?.selected).toBe('text')

  // Show the spare node's choice on the subgraph node from its own row's
  // menu, which offers the whole choice and not its dropdown as a field.
  const before = (await activeDoc(page)).graphs['sub']!.boundary
  const point = await widgetPoint(page, 'spare', 'mode')
  await page.mouse.click(point.x, point.y, { button: 'right' })
  const item = page.locator('[data-item-id="core.boundary.showWhole.mode"]')
  await expect(item).toContainText('Show Mode on subgraph node')
  await expect(page.locator('[data-item-id="core.widget.subgraphNode.show"]')).toHaveCount(0)
  if (proofDir) await page.screenshot({ path: join(proofDir, 'menu.png') })
  await item.click()
  await expect.poll(async () => (await activeDoc(page)).graphs['sub']!.boundary!.inputs.map((i) => i.binds)).toEqual([
    { kind: 'construct', node: 'n', port: 'weights' },
    { kind: 'construct', node: 'm', port: 'mode' },
    { kind: 'construct', node: 'spare', port: 'mode' },
  ])

  // A row of a choice that is already shown offers nothing more.
  const shownPoint = await widgetPoint(page, 'spare', 'mode.strength')
  await page.mouse.click(shownPoint.x, shownPoint.y, { button: 'right' })
  await expect(page.locator('[data-item-id="core.boundary.showWhole.mode"]')).toHaveCount(0)
  await page.keyboard.press('Escape')

  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await activeDoc(page)).graphs['sub']!.boundary).toEqual(before)
})

test('a subgraph node does not offer to clear a variant its definition picks inside', async ({ page }) => {
  await page.evaluate(async () => {
    const shown = (selected?: string) => ({
      id: selected === undefined ? 'bare' : 'picked', name: 'Feather pass',
      nodes: { f: { id: 'f', type: 'Feather', values: {}, ...(selected !== undefined ? { dynamic: { src: { selected } } } : {}) } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 100,
      boundary: { inputs: [{ id: 'feather', binds: { kind: 'construct', node: 'f', port: 'src' } }], outputs: [] },
    })
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage-definition-pick', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 100,
          nodes: {
            p: { id: 'p', type: '#picked', values: {}, dynamic: { feather: { selected: 'mask' } } },
            b: { id: 'b', type: '#bare', values: {}, dynamic: { feather: { selected: 'mask' } } },
          },
        },
        picked: shown('image'),
        bare: shown(),
      },
      view: { graphs: { g0: { nodes: { p: { position: { x: 200, y: 160 } }, b: { position: { x: 200, y: 400 } } } } } },
    } as never, 'DefinitionPick')
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.lineage)).toBe('lineage-definition-pick')
  await identityViewport(page)
  const clearOn = async (nodeId: string) => {
    const point = await page.evaluate((nodeId) => {
      const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
      const pin = node.layout.pins.find((item) => item.portId === 'feather')!
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      return { x: rect.left + node.x, y: rect.top + node.y + pin.y }
    }, nodeId)
    await page.mouse.click(point.x, point.y, { button: 'right' })
    const item = page.locator('[data-item-id="core.slot.specialize.clear"]')
    await expect(item).toBeVisible()
    return item
  }
  // Cleared, this node would run the definition's variant, so clearing is not offered.
  await expect(await clearOn('p')).toHaveAttribute('aria-disabled', 'true')
  if (proofDir) await page.screenshot({ path: join(proofDir, 'clear-variant.png') })
  await page.keyboard.press('Escape')
  // Where the definition picks nothing, clearing gives none, as on a plain node.
  await expect(await clearOn('b')).toHaveAttribute('aria-disabled', 'false')
  await page.keyboard.press('Escape')
})
