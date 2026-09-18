import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from './fixtures.js'

const proofDir = '/tmp/audit-integration-proof'

async function pinPoint(page: Page, nodeId: string, predicate: 'producer' | 'prefix' | 'ghost') {
  return page.evaluate(({ nodeId, predicate }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const pin = node.layout.pins.find((candidate) => {
      if (predicate === 'producer') return candidate.direction === 'out' && candidate.address.port === 'out'
      if (predicate === 'ghost') return candidate.direction === 'in' && candidate.ghost === true
      return candidate.direction === 'in' && candidate.address.members?.[0] === 'd0'
    })!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: canvas.top + node.y + pin.y,
    }
  }, { nodeId, predicate })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

test('production planner commits a drilled occurrence ghost connect without any test-bridge injection', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'audit-integration', schemaWire: 21 }, nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get().length ?? 0)).toBe(1)

  await page.evaluate(() => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([
      {
        type: 'Producer', displayName: 'Producer', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'FLOAT' } }],
      },
      {
        type: 'Family', displayName: 'Family', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'items', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
          dynamic: {
            kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
            template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: true }],
          },
        }],
      },
    ])
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-integration-proof', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: { s: { id: 's', type: '#sub', values: {}, dynamic: { forwarded: { members: ['s0'], seq: 1 } } } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
        },
        sub: {
          id: 'sub', name: 'sub',
          nodes: {
            p: { id: 'p', type: 'Producer', values: {} },
            n: { id: 'n', type: 'Family', values: {}, dynamic: { items: { members: ['d0'], seq: 1 } } },
          },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
          boundary: { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] },
        },
      },
      view: { graphs: {
        g0: { nodes: { s: { position: { x: 200, y: 120 } } } },
        sub: { nodes: { p: { position: { x: 100, y: 160 } }, n: { position: { x: 500, y: 120 }, size: { width: 260, height: 180 } } } },
      } },
    }, 'audit integration proof')
    const tab = test.app.activeTab()!
    tab.graphStack.set(['g0', 'sub'])
    tab.instancePath.set(['s'])
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  // Sockets are active WITHOUT any setOccurrencePlanner call: production
  // shipped its own planner, so absent-capability fail-closed cannot occur.
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'n')
    return node?.layout.pins.filter((pin) => pin.familyOwner?.socketed === true).length ?? 0
  })).toBe(2)
  await page.screenshot({ path: `${proofDir}/01-production-sockets-no-injection.png`, animations: 'disabled' })

  // Real ghost connect: commits ONE occurrence-local overlay link and leaves
  // the shared definition graph untouched.
  await drag(page, await pinPoint(page, 'p', 'producer'), await pinPoint(page, 'n', 'ghost'))
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const topologies = Object.values(doc.occurrenceTopologies ?? {})
    return topologies.length === 1 ? Object.keys(topologies[0]!.links).length : 0
  })).toBe(1)
  await expect(page.evaluate(() =>
    Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.sub!.links).length,
  )).resolves.toBe(0)
  await page.screenshot({ path: `${proofDir}/02-occurrence-ghost-connect-committed.png`, animations: 'disabled' })

  // One undo removes the local link and its materialized member together.
  await page.evaluate(() => { window.__dinksterTest!.app.activeTab()!.store.undo() })
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.occurrenceTopologies ?? {}).reduce((count, topology) => count + Object.keys(topology.links).length, 0)
  })).toBe(0)
  await page.screenshot({ path: `${proofDir}/03-one-step-undo.png`, animations: 'disabled' })

  // Ordinary definition-owned prefix editing stays on the shared command path.
  await drag(page, await pinPoint(page, 'p', 'producer'), await pinPoint(page, 'n', 'prefix'))
  await expect.poll(() => page.evaluate(() =>
    Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.sub!.links).length,
  )).toBe(1)
  await expect(page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.occurrenceTopologies ?? {}).reduce((count, topology) => count + Object.keys(topology.links).length, 0)
  })).resolves.toBe(0)
  await page.screenshot({ path: `${proofDir}/04-definition-prefix-edit-unchanged.png`, animations: 'disabled' })
})
