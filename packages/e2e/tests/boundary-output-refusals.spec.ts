import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openRailPanel, test, waitForWorkspaceReady, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_OUTPUT_REFUSAL_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

async function registerSchemas(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'RefusalFloatSource',
        displayName: 'Float Source',
        category: 'test',
        source: 'v3',
        isOutputNode: true,
        body: [{ kind: 'output', id: 'value', type: { kind: 'concrete', name: 'FLOAT' } }],
      },
    ])
  })
}

async function openStructuralWorkflow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const diagnostics = (await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'structural-output-refusal', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Structural output refusal',
          nodes: { instance: { id: 'instance', type: '#producers', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        },
        producers: {
          id: 'producers', name: 'Structural producers',
          nodes: {
            first: { id: 'first', type: 'RefusalFloatSource', values: {} },
          },
          links: {
            rerouteDriver: { id: 'rerouteDriver', from: { node: 'first', port: 'value' }, to: { reroute: 'junction' } },
          },
          nets: {},
          reroutes: { junction: { id: 'junction' } },
          boundary: { body: [] },
          nextOrdinal: 20,
        },
      },
      view: { graphs: {
        root: { nodes: { instance: { position: { x: 180, y: 120 } } } },
        producers: {
          nodes: {
            first: { position: { x: 80, y: 80 } },
          },
          reroutes: { junction: { position: { x: 400, y: 100 } } },
        },
      } },
    }, 'Structural output refusal'))
    if (diagnostics.length > 0) throw new Error(`open failed: ${JSON.stringify(diagnostics)}`)
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['root', 'producers'])
    tab.instancePath.set(['instance'])
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('producers')
}

async function rerouteCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const reroute = window.__dinksterTest!.renderer!.getScene().reroutes.find((item) => item.id === 'junction')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + reroute.x, y: rect.top + reroute.y }
  })
}

async function outputBoundaryPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const boundary = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((item) => item.side === 'outputs')!
    const add = boundary.layout.pins.find((pin) => pin.portId === '__add__')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + boundary.x, y: rect.top + boundary.y + add.y }
  })
}

async function dragReroute(page: Page): Promise<void> {
  // Hovering the junction reveals its output handle to the right.
  const center = await rerouteCenter(page)
  await page.mouse.move(center.x, center.y)
  const from = { x: center.x + 21, y: center.y }
  const to = await outputBoundaryPoint(page)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.route('/queue', (route) => route.fulfill({ json: { queue_running: [], queue_pending: [] } }))
  await page.route('/history*', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await waitForWorkspaceReady(page)
  await registerSchemas(page)
})

test('a reroute refuses a direct boundary output with a visible diagnostic', async ({ page }) => {
  await openStructuralWorkflow(page)
  const before = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const outputs = window.__dinksterTest!.renderer!.getScene().boundaryNodes
      .find((item) => item.side === 'outputs')!.layout.pins.map((pin) => pin.portId)
    return { revision: tab.store.revision, outputs }
  })
  const message = "Cannot expose reroute 'junction' on boundary outputs: structural producers require stamped public output types"
  await dragReroute(page)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((diagnostic) => diagnostic.code === 'boundary.structuralProducerUnsupported')
    .map((diagnostic) => diagnostic.message))).toEqual([message])
  const after = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const outputs = window.__dinksterTest!.renderer!.getScene().boundaryNodes
      .find((item) => item.side === 'outputs')!.layout.pins.map((pin) => pin.portId)
    return { revision: tab.store.revision, outputs }
  })
  expect(after).toEqual(before)

  await openRailPanel(page, 'Problems')
  await expect(page.getByTestId('problems-panel')).toBeVisible()
  await expect(page.getByTestId('problems-panel')).toContainText("Cannot expose reroute 'junction' on boundary outputs")
  await page.mouse.move(20, 20)
  if (proofDir) {
    await page.screenshot({
      path: join(proofDir, 'structural-output-refusal.png'),
      animations: 'disabled',
      fullPage: true,
    })
  }
})
