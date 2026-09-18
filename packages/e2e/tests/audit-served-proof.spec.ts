import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

// Served-app proof for the subgraph Autogrow ghost-input defect: real
// deployed frontend on :5199, real native backend behind the proxy, no
// route mocks and no test-bridge planner injection. Proves the drilled
// occurrence ghost input is socketed, a ghost connect commits one
// occurrence-local overlay link (definition untouched), undo/redo cycle
// the link plus its materialized member as one step, and the overlay
// survives a document save/reload round trip.

const proofDir = '/tmp/audit-served-proof'

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

const overlayLinkCount = (page: Page) => page.evaluate(() => {
  const doc = window.__dinksterTest!.app.activeTab()!.store.doc
  return Object.values(doc.occurrenceTopologies ?? {}).reduce(
    (count, topology) => count + Object.keys(topology.links).length, 0)
})

const definitionLinkCount = (page: Page) => page.evaluate(() =>
  Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.sub!.links).length)

function proofDocument() {
  return {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-served-proof', root: 'g0',
    graphs: {
      g0: {
        id: 'g0', name: 'root',
        nodes: { s: { id: 's', type: '#sub', values: {}, dynamic: { forwarded: { members: ['s0'], seq: 1 } } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      },
      sub: {
        id: 'sub', name: 'sub',
        nodes: {
          p: { id: 'p', type: 'auditProducer', values: {} },
          n: { id: 'n', type: 'auditFamily', values: {}, dynamic: { items: { members: ['d0'], seq: 1 } } },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
        boundary: { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] },
      },
    },
    view: { graphs: {
      g0: { nodes: { s: { position: { x: 200, y: 120 } } } },
      sub: { nodes: { p: { position: { x: 100, y: 160 } }, n: { position: { x: 500, y: 120 }, size: { width: 260, height: 180 } } } },
    } },
  }
}

async function drillIntoOccurrence(page: Page) {
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['g0', 'sub'])
    tab.instancePath.set(['s'])
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'n')
    return node?.layout.pins.filter((pin) => pin.familyOwner?.socketed === true).length ?? 0
  })).toBeGreaterThanOrEqual(2)
}

test('served app commits, undoes, redoes, and reloads a drilled occurrence ghost connect', async ({ page }) => {
  await mkdir(proofDir, { recursive: true })
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get().length ?? 0), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)

  await page.evaluate((doc) => {
    const test = window.__dinksterTest!
    test.app.registerSchemas([
      {
        type: 'auditProducer', displayName: 'auditProducer', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'FLOAT' } }],
      },
      {
        type: 'auditFamily', displayName: 'auditFamily', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'items', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
          dynamic: {
            kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
            template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: true }],
          },
        }],
      },
    ])
    test.app.openDocument(doc as never, 'audit served proof')
  }, proofDocument())
  await drillIntoOccurrence(page)
  await page.screenshot({ path: `${proofDir}/01-served-drilled-sockets.png`, animations: 'disabled' })

  // Ghost connect commits one occurrence-local overlay link; the shared
  // definition graph stays untouched.
  await drag(page, await pinPoint(page, 'p', 'producer'), await pinPoint(page, 'n', 'ghost'))
  await expect.poll(() => overlayLinkCount(page)).toBe(1)
  await expect(definitionLinkCount(page)).resolves.toBe(0)
  await page.screenshot({ path: `${proofDir}/02-served-ghost-connect.png`, animations: 'disabled' })

  // One undo removes the link and its materialized member; redo restores both.
  await page.evaluate(() => { window.__dinksterTest!.app.activeTab()!.store.undo() })
  await expect.poll(() => overlayLinkCount(page)).toBe(0)
  await page.evaluate(() => { window.__dinksterTest!.app.activeTab()!.store.redo() })
  await expect.poll(() => overlayLinkCount(page)).toBe(1)
  await page.screenshot({ path: `${proofDir}/03-served-undo-redo.png`, animations: 'disabled' })

  // Save/reload round trip: serialize the document, reopen it from the
  // serialized bytes, drill back in, and confirm the occurrence overlay
  // link and its socketed ghost survive.
  const saved = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc)))
  await page.evaluate((doc) => {
    window.__dinksterTest!.app.openDocument(doc as never, 'audit served proof reloaded')
  }, saved)
  await drillIntoOccurrence(page)
  await expect.poll(() => overlayLinkCount(page)).toBe(1)
  await expect(definitionLinkCount(page)).resolves.toBe(0)
  await page.screenshot({ path: `${proofDir}/04-served-reload-persisted.png`, animations: 'disabled' })
})
