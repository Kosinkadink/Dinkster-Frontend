import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures.js'

const proofDir = process.env['DINKSTER_COUNT_BOUNDARY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

test('count-bound outputs project independently onto subgraph instances', async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect(page.getByTestId('status-bar')).toContainText('0 node schemas', { timeout: 15_000 })
  await page.evaluate(() => {
    const image = { kind: 'concrete' as const, name: 'IMAGE' }
    window.__dinksterTest!.app.registerSchemas([{
      type: 'CountOutputTest',
      displayName: 'Count Output',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'count',
          type: { kind: 'concrete', name: 'INT' },
          optional: false,
          widget: { widgetType: 'INT', options: { min: 0, max: 4 }, default: 0 },
        },
        {
          kind: 'output',
          id: 'images',
          type: image,
          dynamic: {
            kind: 'autogrow',
            template: [{ kind: 'input', id: 'image', type: image, optional: true }],
            naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
            count: { input: 'count', suffix: 'index' },
          },
        },
      ],
    }])
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'count-output-boundary-proof',
      root: 'root',
      graphs: {
        root: {
          id: 'root',
          name: 'Count boundary projection',
          nodes: {
            one: { id: 'one', type: '#wrapper', values: { amount: 1 } },
            three: { id: 'three', type: '#wrapper', values: {} },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 10,
        },
        wrapper: {
          id: 'wrapper',
          name: 'Count Output Wrapper',
          nodes: { output: { id: 'output', type: 'CountOutputTest', values: { count: 3 } } },
          links: {},
          nets: {},
          reroutes: {},
          boundary: {
            inputs: [{ id: 'amount', displayName: 'Output count', binds: { kind: 'port', node: 'output', port: 'count' }, promoted: true }],
            outputs: [{ id: 'pictures', displayName: 'Pictures', binds: { kind: 'family', node: 'output', port: 'images' } }],
          },
          nextOrdinal: 10,
        },
      },
      view: {
        graphs: {
          root: {
            nodes: {
              one: { position: { x: 160, y: 180 } },
              three: { position: { x: 560, y: 180 } },
            },
          },
          wrapper: { nodes: { output: { position: { x: 280, y: 180 } } } },
        },
      },
    }, 'Count boundary projection')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const projected = await page.evaluate(() => Object.fromEntries(
    window.__dinksterTest!.renderer!.getScene().nodes.map((node) => [
      node.id,
      node.layout.pins
        .filter((pin) => pin.direction === 'out' && pin.address.port === 'pictures')
        .map((pin) => pin.address.members?.[0]),
    ]),
  ))
  expect(projected).toEqual({ one: ['0'], three: ['0', '1', '2'] })

  if (proofDir) {
    await page.screenshot({
      path: join(proofDir, 'count-bound-output-boundary-after.png'),
      animations: 'disabled',
      fullPage: true,
    })
  }

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['root', 'wrapper'])
    tab.instancePath.set(['three'])
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene() as unknown as {
      nodes: Array<{
        id: string
        node: { values: Record<string, unknown> }
        layout: {
          rows: Array<{ kind: string; valueKey?: string; familyOwner?: unknown }>
          pins: Array<{ direction: string; address: { port: string; members?: readonly string[] } }>
        }
      }>
    }
    const node = scene.nodes.find((item) => item.id === 'output')
    const countRow = node?.layout.rows.find((row) => row.kind === 'widget' && row.valueKey === 'count')
    return {
      count: node?.node.values.count,
      outputs: node?.layout.pins
        .filter((pin) => pin.direction === 'out' && pin.address.port === 'images')
        .map((pin) => pin.address.members?.[0]),
      owner: countRow?.kind === 'widget' ? countRow.familyOwner : undefined,
    }
  })).toEqual({
    count: 3,
    outputs: ['0', '1', '2'],
    owner: { graphId: 'root', nodeId: 'three', construct: 'count', valueKey: 'amount' },
  })
})
