import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

// Served-app proof for automatic occurrence compaction: real deployed
// frontend on :5199, real native backend behind the proxy, no route
// mocks and no test-bridge injection. Proves through real pointer UI
// that a drilled occurrence ghost connect materializes a member, a
// pointer disconnect compacts that member automatically in the same
// undo step, exactly one trailing ghost remains, one undo restores the
// link plus member, redo compacts again, and a save/reload round trip
// preserves the compacted state while the sibling occurrence and the
// shared definition stay untouched.

const proofDir = '/tmp/audit-served-compaction-proof'

async function pinPoint(page: Page, nodeId: string, predicate: 'producer' | 'ghost') {
  return page.evaluate(({ nodeId, predicate }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const pin = node.layout.pins.find((candidate) => predicate === 'producer'
      ? candidate.direction === 'out' && candidate.address.port === 'out'
      : candidate.direction === 'in' && candidate.ghost === true)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: canvas.top + node.y + pin.y,
    }
  }, { nodeId, predicate })
}

async function occurrenceTargetPoint(page: Page) {
  return page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const link = (scene.links as any[]).find((candidate) => candidate.effectiveIdentity?.kind === 'occurrence')!
    const to = link.to as { kind: string; node: string; port: string; members?: string[] }
    if (to.kind !== 'port') throw new Error('occurrence delivery has no port target')
    const node = scene.nodes.find((candidate) => candidate.id === to.node)!
    const pin = node.layout.pins.find((candidate) =>
      candidate.direction === 'in' &&
      candidate.address.port === to.port &&
      JSON.stringify(candidate.address.members ?? []) === JSON.stringify(to.members ?? []))!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + node.x, y: canvas.top + node.y + pin.y }
  })
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function state(page: Page) {
  return page.evaluate(() => {
    const test = window.__dinksterTest!
    const doc = test.app.activeTab()!.store.doc
    const topology = doc.occurrenceTopologies?.a
    const sceneNode = test.renderer!.getScene().nodes.find((node) => node.id === 'n')!
    return {
      aDynamic: doc.graphs.g0!.nodes.a!.dynamic,
      bDynamic: doc.graphs.g0!.nodes.b!.dynamic,
      definition: doc.graphs.sub,
      localLinks: Object.keys(topology?.links ?? {}).length,
      ghosts: sceneNode.layout.pins.filter((pin) => pin.ghost === true).length,
    }
  })
}

function proofDocument() {
  return {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-served-compaction', root: 'g0',
    graphs: {
      g0: {
        id: 'g0', name: 'root',
        nodes: {
          a: { id: 'a', type: '#sub', values: {}, dynamic: { forwarded: { seq: 0 } } },
          b: { id: 'b', type: '#sub', values: {}, dynamic: { forwarded: { members: ['sibling0'], seq: 1 } } },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
      },
      sub: {
        id: 'sub', name: 'sub',
        nodes: {
          p: { id: 'p', type: 'auditProducer', values: {} },
          n: { id: 'n', type: 'auditFamily', values: {}, dynamic: { items: { members: ['definition0'], seq: 1 } } },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
        boundary: { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] },
      },
    },
    view: { graphs: {
      g0: { nodes: { a: { position: { x: 200, y: 120 } }, b: { position: { x: 520, y: 120 } } } },
      sub: { nodes: { p: { position: { x: 100, y: 160 } }, n: { position: { x: 500, y: 120 }, size: { width: 260, height: 180 } } } },
    } },
  }
}

async function drillIntoOccurrence(page: Page) {
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['g0', 'sub'])
    tab.instancePath.set(['a'])
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(async () => (await state(page)).ghosts).toBe(1)
}

test('served app compacts a UI occurrence disconnect atomically and survives reload', async ({ page }) => {
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
    test.app.openDocument(doc as never, 'audit served compaction proof')
  }, proofDocument())
  await drillIntoOccurrence(page)
  const baseline = await state(page)
  expect(baseline.localLinks).toBe(0)
  await page.screenshot({ path: `${proofDir}/01-served-trailing-ghost.png`, animations: 'disabled' })

  // Pointer ghost connect materializes one occurrence member plus one
  // occurrence-local overlay link; sibling and definition untouched.
  await drag(page, await pinPoint(page, 'p', 'producer'), await pinPoint(page, 'n', 'ghost'))
  await expect.poll(() => state(page)).toMatchObject({
    aDynamic: { forwarded: { members: ['m0'], seq: 1 } },
    bDynamic: baseline.bDynamic,
    definition: baseline.definition,
    localLinks: 1,
    ghosts: 1,
  })
  await page.screenshot({ path: `${proofDir}/02-served-member-materialized.png`, animations: 'disabled' })

  // Pointer disconnect (drag the delivery off to empty canvas) removes
  // the link AND automatically compacts the now-unreferenced member in
  // the same step; exactly one trailing ghost remains.
  const target = await occurrenceTargetPoint(page)
  await drag(page, target, { x: 1040, y: 720 })
  await expect.poll(() => state(page)).toEqual({
    aDynamic: { forwarded: { seq: 1 } },
    bDynamic: baseline.bDynamic,
    definition: baseline.definition,
    localLinks: 0,
    ghosts: 1,
  })
  await page.screenshot({ path: `${proofDir}/03-served-disconnect-compacted.png`, animations: 'disabled' })

  // One undo restores the link plus its materialized member.
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect.poll(() => state(page)).toMatchObject({
    aDynamic: { forwarded: { members: ['m0'], seq: 1 } },
    bDynamic: baseline.bDynamic,
    definition: baseline.definition,
    localLinks: 1,
    ghosts: 1,
  })
  await page.screenshot({ path: `${proofDir}/04-served-one-undo-restored.png`, animations: 'disabled' })

  // Redo reapplies disconnect plus compaction as one step.
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  await expect.poll(() => state(page)).toEqual({
    aDynamic: { forwarded: { seq: 1 } },
    bDynamic: baseline.bDynamic,
    definition: baseline.definition,
    localLinks: 0,
    ghosts: 1,
  })
  await page.screenshot({ path: `${proofDir}/05-served-redo-compacted.png`, animations: 'disabled' })

  // Save/reload round trip preserves the compacted state.
  const saved = await page.evaluate(() =>
    JSON.parse(JSON.stringify(window.__dinksterTest!.app.activeTab()!.store.doc)))
  await page.evaluate((doc) => {
    window.__dinksterTest!.app.openDocument(doc as never, 'audit served compaction reloaded')
  }, saved)
  await drillIntoOccurrence(page)
  await expect.poll(() => state(page)).toEqual({
    aDynamic: { forwarded: { seq: 1 } },
    bDynamic: baseline.bDynamic,
    definition: baseline.definition,
    localLinks: 0,
    ghosts: 1,
  })
  await page.screenshot({ path: `${proofDir}/06-served-reload-compacted.png`, animations: 'disabled' })
})
