/**
 * "Show on subgraph node": inside a subgraph, a field's menu puts the field
 * on the subgraph node outside without a wire drawn inside. The field and
 * its Inputs panel row carry the cyan subgraph mark; hovering the mark names
 * the input and clicking it selects that input in the Boundary panel.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, nativeTest as test, subgraphMarkPoint, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_SHOW_ON_SUBGRAPH_NODE_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) return
  await page.getByTestId('graph-canvas').screenshot({ path: join(proofDir, `${name}.png`), animations: 'disabled' })
}

/** Screen point of a row on an inner node, at its subgraph mark or its value. */
async function rowPoint(page: Page, nodeId: string, port: string, at: 'mark' | 'value'): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, port, at }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget' && candidate.address?.port === port)!
    const tokens = renderer.getDesignTokens()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const inset = row.inset ?? 0
    const width = row.width ?? node.layout.width - inset * 2
    const x = at === 'mark'
      ? tokens.rowGeometry.stepperZone + tokens.rowGeometry.stepperLabelInset + 6
      : width - tokens.rowGeometry.stepperZone - 20
    return { x: rect.left + node.x + inset + x, y: rect.top + node.y + row.y + tokens.rowHeight / 2 }
  }, { nodeId, port, at })
}

test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/(?!library\/retention(?:s\/|-clients(?:\?|$))).*/, (route) => route.fulfill({ status: 503, json: {} }))
  await page.route('**/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'show-on-subgraph-node-fixture', schemaWire: 1 }, nodes: {},
  } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    const image = { kind: 'concrete', name: 'IMAGE' } as const
    app.registerSchemas([{
      type: 'Blur', displayName: 'Blur', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'image', type: image, optional: false },
        { kind: 'input', id: 'radius', type: { kind: 'concrete', name: 'INT' }, optional: false,
          widget: { widgetType: 'INT', options: { min: 0, max: 64 }, default: 4 } },
        { kind: 'input', id: 'strength', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
          widget: { widgetType: 'FLOAT', options: { min: 0, max: 1, step: 0.05 }, default: 0.5 } },
        { kind: 'output', id: 'IMAGE', type: image },
      ],
    }])
    await app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'show-on-subgraph-node', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: { soften: { id: 'soften', type: '#sub', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10 },
        sub: {
          id: 'sub', name: 'Soften', links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
          nodes: { blur: { id: 'blur', type: 'Blur', values: { radius: 6, strength: 0.75 } } },
          boundary: {
            inputs: [{ id: 'image', binds: { kind: 'port', node: 'blur', port: 'image' } }],
            outputs: [{ id: 'image_out', binds: { kind: 'port', node: 'blur', port: 'IMAGE' } }],
          },
        },
      },
      view: { graphs: { g0: { nodes: { soften: { position: { x: 160, y: 160 } } } }, sub: { nodes: { blur: { position: { x: 420, y: 160 } } } } } },
    }, 'Show on subgraph node')
  })
  await page.waitForFunction(() => window.__dinksterTest!.app.activeTab()?.store.doc.lineage === 'show-on-subgraph-node')
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  const mark = await subgraphMarkPoint(page, 'soften')
  await page.mouse.dblclick(mark.x, mark.y)
  await expect(page.getByTestId('graph-breadcrumb')).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
})

test('a field shown on the subgraph node has no wire inside, carries the mark, and the mark selects its input', async ({ page }) => {
  const value = await rowPoint(page, 'blur', 'strength', 'value')
  await page.mouse.click(value.x, value.y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Show on subgraph node', exact: true }).click()

  const inputs = () => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs['sub']!.boundary!.inputs)
  await expect.poll(inputs).toContainEqual({ id: 'strength', binds: { kind: 'port', node: 'blur', port: 'strength' }, promoted: true, wireHidden: true })
  const links = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().links
    .filter((link) => link.boundary === true && link.to.kind === 'port' && link.to.node === 'blur')
    .map((link) => ({ port: (link.to as { port: string }).port, hidden: link.hidden === true })))
  expect(links).toEqual(expect.arrayContaining([{ port: 'image', hidden: false }, { port: 'strength', hidden: true }]))
  await capture(page, 'inside-field-shown-without-wire')

  const mark = await rowPoint(page, 'blur', 'strength', 'mark')
  await page.mouse.move(mark.x, mark.y)
  await expect(page.getByTestId('app-tooltip')).toContainText('On the subgraph node as strength')
  await capture(page, 'inside-mark-hover')

  await page.mouse.click(mark.x, mark.y)
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  const selected = page.locator('[data-testid=boundary-item][data-selected]')
  await expect(selected).toHaveCount(1)
  await expect(selected).toHaveAttribute('data-boundary-id', 'strength')
  if (proofDir) await page.screenshot({ path: join(proofDir, 'boundary-panel-selected.png'), animations: 'disabled' })

  // Outside, the subgraph node has the field, with no mark.
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
  const outside = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes
    .find((candidate) => candidate.id === 'soften')!.layout.rows
    .flatMap((row) => row.kind === 'widget' ? [{ port: row.address?.port, marked: row.subgraphMark !== undefined }] : []))
  expect(outside).toContainEqual({ port: 'strength', marked: false })
  await capture(page, 'outside-subgraph-node')
})
