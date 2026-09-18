/**
 * Browser coexistence regression: the maximal document from
 * core/canvas coexistence tests, driven through the PRODUCTION CanvasHost
 * with real interactions. Every construct is present at once - subgraph
 * instance with a forwarded DynamicCombo selector, promoted branch widget,
 * forwarded Autogrow family, promoted DynamicSlot dependent, reroute chain,
 * named net, value source, and a fixed-policy selector - and the user can
 * still grow the family through a ghost pin, switch the forwarded branch,
 * and edit a promoted widget, all with a clean Problems state.
 */
import { expect, openRailPanel, test, type Page } from './fixtures.js'

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

const instNode = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'inst')!)

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function pinPoint(page: Page, nodeId: string, portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, portId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const pin = node.layout.pins.find((item) => item.portId === portId)
    if (!pin) throw new Error(`no pin '${nodeId}/${portId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: rect.top + node.y + pin.y,
    }
  }, { nodeId, portId })
}

async function widgetRowPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)
    if (!row) throw new Error(`no widget row '${nodeId}/${inputId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId })
}

async function drillIntoInstance(page: Page, nodeId = 'inst'): Promise<void> {
  const header = await page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  }, nodeId)
  await page.mouse.dblclick(header.x, header.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

async function returnToRoot(page: Page): Promise<void> {
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

async function openCoexistenceWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const IMAGE = { kind: 'concrete', name: 'IMAGE' }
    const FLOAT = { kind: 'concrete', name: 'FLOAT' }
    const input = (id: string, extra: Record<string, unknown> = {}) =>
      ({ kind: 'input', id, type: IMAGE, optional: false, ...extra })
    const widget = (id: string, value: number) => input(id, {
      type: FLOAT, optional: true, widget: { widgetType: 'FLOAT', options: {}, default: value },
    })
    const output = (id: string) => ({ kind: 'output', id, type: IMAGE })
    const schemaOf = (type: string, items: unknown[]) =>
      ({ type, displayName: type, category: 'test', source: 'v3', isOutputNode: false, items })
    window.__dinksterTest!.app.registerSchemas([
      schemaOf('CoexSrcTest', [output('out')]),
      schemaOf('CoexComboTest', [
        {
          ...input('mode', { optional: true }),
          dynamic: {
            kind: 'dynamicCombo',
            options: [
              { key: 'a', inputs: [widget('amount', 1)] },
              { key: 'b', inputs: [widget('amount', 2), widget('bias', 3)] },
            ],
          },
        },
        output('out'),
      ]),
      schemaOf('CoexFamTest', [
        {
          ...input('images'),
          dynamic: {
            kind: 'autogrow',
            template: [input('img', { optional: true }), widget('weight', 1)],
            naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
          },
        },
        output('out'),
      ]),
      schemaOf('CoexSlotTest', [
        {
          ...input('slot', { optional: true }),
          dynamic: { kind: 'dynamicSlot', slotType: IMAGE, inputs: [widget('gain', 4)] },
        },
        output('out'),
      ]),
      schemaOf('CoexSinkTest', [input('in')]),
    ] as never)
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'coexistence-e2e', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            src1: { id: 'src1', type: 'CoexSrcTest', values: {} },
            src2: { id: 'src2', type: 'CoexSrcTest', values: {} },
            inst: {
              id: 'inst', type: '#sub',
              dynamic: { choice: { selected: 'a' }, images: { members: ['s0', 's1'] } },
              values: { gain: 8 },
            },
            inst2: { id: 'inst2', type: '#sub', dynamic: { images: { members: ['other0'] } }, values: {} },
            snk: { id: 'snk', type: 'CoexSinkTest', values: {} },
            snk2: { id: 'snk2', type: 'CoexSinkTest', values: {} },
          },
          links: {
            l1: { id: 'l1', from: { node: 'src1', port: 'out' }, to: { reroute: 'r1' } },
            l2: { id: 'l2', from: { reroute: 'r1' }, to: { reroute: 'r2' } },
            l3: { id: 'l3', from: { reroute: 'r2' }, to: { node: 'inst', port: 'images.img', members: ['s0'] } },
            l4: { id: 'l4', from: { valueSource: 'vs' }, to: { node: 'inst', port: 'amount' } },
            l5: { id: 'l5', from: { node: 'inst', port: 'result' }, to: { node: 'snk', port: 'in' } },
            l6: { id: 'l6', from: { node: 'src1', port: 'out' }, to: { selector: 'sel', candidate: 'c1' } },
            l7: { id: 'l7', from: { node: 'src2', port: 'out' }, to: { selector: 'sel', candidate: 'c2' } },
            l8: { id: 'l8', from: { selector: 'sel' }, to: { node: 'snk2', port: 'in' } },
          },
          nets: {
            n1: {
              id: 'n1', name: 'feed',
              source: { node: 'src2', port: 'out' },
              sinks: [{ node: 'inst', port: 'images.img', members: ['s1'] }],
            },
          },
          reroutes: { r1: { id: 'r1' }, r2: { id: 'r2' } },
          valueSources: { vs: { id: 'vs', value: 2.5, spec: { widgetType: 'FLOAT' } } },
          selectors: { sel: { id: 'sel', candidates: [{ id: 'c1' }, { id: 'c2' }], policy: { kind: 'fixed', candidate: 'c1' } } },
          nextOrdinal: 100,
        },
        sub: {
          id: 'sub', name: 'sub',
          nodes: {
            cmb: { id: 'cmb', type: 'CoexComboTest', values: {} },
            cmb2: { id: 'cmb2', type: 'CoexComboTest', values: {}, dynamic: { mode: { selected: 'b' } } },
            fam: { id: 'fam', type: 'CoexFamTest', values: { 'images.weight#d0': 3 }, dynamic: { images: { members: ['d0'] } } },
            slot: { id: 'slot', type: 'CoexSlotTest', values: {} },
          },
          links: {
            k1: { id: 'k1', from: { node: 'fam', port: 'out' }, to: { node: 'slot', port: 'slot' } },
          },
          nets: {}, reroutes: {},
          boundary: {
            inputs: [
              { id: 'choice', binds: { kind: 'port', node: 'cmb', port: 'mode' } },
              { id: 'amount', promoted: true, binds: { kind: 'port', node: 'cmb2', port: 'mode.[b].amount' } },
              { id: 'images', binds: { kind: 'family', node: 'fam', port: 'images' } },
              { id: 'gain', promoted: true, binds: { kind: 'port', node: 'slot', port: 'slot.gain' } },
            ],
            outputs: [{ id: 'result', binds: { kind: 'port', node: 'slot', port: 'out' } }],
          },
          nextOrdinal: 100,
        },
      },
      view: { graphs: {
        g0: {
          nodes: {
            src1: { position: { x: 40, y: 60 } },
            src2: { position: { x: 40, y: 260 } },
            inst: { position: { x: 460, y: 60 } },
            inst2: { position: { x: 700, y: 500 } },
            snk: { position: { x: 900, y: 60 } },
            snk2: { position: { x: 900, y: 260 } },
          },
          reroutes: { r1: { position: { x: 260, y: 90 } }, r2: { position: { x: 350, y: 120 } } },
          valueSources: { vs: { position: { x: 60, y: 470 } } },
          selectors: { sel: { position: { x: 500, y: 460 } } },
        },
        sub: { nodes: {
          cmb: { position: { x: 80, y: 60 } },
          cmb2: { position: { x: 80, y: 300 } },
          fam: { position: { x: 420, y: 60 } },
          slot: { position: { x: 420, y: 300 } },
        } },
      } },
    } as never, 'Coexistence')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openCoexistenceWorkflow(page)
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'coexistence-e2e' && 'status' in tab.store
  })
})

test('the maximal document renders every construct at once with a clean Problems state', async ({ page }) => {
  const scene = await page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScene()
    return {
      nodeIds: s.nodes.map((n) => n.id).sort(),
      reroutes: s.reroutes.map((r) => r.id).sort(),
      valueSources: s.valueSources.map((v) => v.id),
      selectors: s.selectors.map((sel) => ({ id: sel.id, active: sel.activeCandidate, typeName: sel.typeName })),
      netLink: s.links.some((l) => l.netId === 'n1'),
      diagnostics: s.diagnostics,
      instPins: s.nodes.find((n) => n.id === 'inst')!.layout.pins.map((p) => p.portId),
    }
  })
  expect(scene.nodeIds).toEqual(['inst', 'inst2', 'snk', 'snk2', 'src1', 'src2'])
  expect(scene.reroutes).toEqual(['r1', 'r2'])
  expect(scene.valueSources).toEqual(['vs'])
  expect(scene.selectors).toEqual([{ id: 'sel', active: 'c1', typeName: 'IMAGE' }])
  expect(scene.netLink).toBe(true)
  expect(scene.diagnostics).toEqual([])
  // Members, ghost, promoted rows, and the boundary output all coexist.
  for (const pin of ['images.img#s0', 'images.img#s1', 'images.img#m0', 'amount', 'gain', 'result']) {
    expect(scene.instPins, `instance pin ${pin}`).toContain(pin)
  }
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|boundary\./)
})

test('a ghost drag grows the forwarded family atomically; one undo removes member and link', async ({ page }) => {
  await drag(page, await pinPoint(page, 'src2', 'out'), await pinPoint(page, 'inst', 'images.img#m0'))
  let doc = await activeDoc(page)
  const dynamic = doc.graphs.g0!.nodes.inst! as { dynamic?: { images?: { members?: string[] } } }
  expect(dynamic.dynamic?.images?.members).toEqual(['s0', 's1', 'm0'])
  const linkCount = Object.keys(doc.graphs.g0!.links).length
  expect(linkCount).toBe(9) // l1-l8 plus the new member link

  // Atomic: the materialization and the connect are ONE undo step.
  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect((doc.graphs.g0!.nodes.inst! as { dynamic?: { images?: { members?: string[] } } }).dynamic?.images?.members)
    .toEqual(['s0', 's1'])
  expect(Object.keys(doc.graphs.g0!.links)).toHaveLength(8)
  // The scene ghost retreats with it - but member ids are never recycled
  // (CO3: undo keeps the seq high-water mark), so the fresh ghost is m1.
  const inst = await instNode(page)
  expect(inst.layout.pins.some((p) => p.portId === 'images.img#m1' && p.ghost)).toBe(true)
  expect(inst.layout.pins.some((p) => p.portId === 'images.img#m0')).toBe(false)
})

test('switching the forwarded branch updates the instance choice through the production combo editor', async ({ page }) => {
  const point = await widgetRowPoint(page, 'inst', 'choice')
  await page.mouse.click(point.x, point.y)
  const dropdown = page.getByTestId('combo-dropdown')
  await expect(dropdown).toBeVisible()
  await dropdown.getByRole('option', { name: 'b', exact: true }).click()
  const doc = await activeDoc(page)
  const inst = doc.graphs.g0!.nodes.inst! as { dynamic?: { choice?: { selected?: string } } }
  expect(inst.dynamic?.choice?.selected).toBe('b')
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|boundary\./)
})

test('editing the promoted slot dependent persists across drill-in and back', async ({ page }) => {
  const point = await widgetRowPoint(page, 'inst', 'gain')
  await page.mouse.click(point.x, point.y)
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('5.5')
  await input.press('Enter')
  expect((await activeDoc(page)).graphs.g0!.nodes.inst!.values.gain).toBe(5.5)

  // Drill into the definition and back: the promoted value survives and the
  // definition still shows the revealed dependent on the inner slot node.
  const header = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'inst')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.dblclick(header.x, header.y)
  await openRailPanel(page, 'Boundary')
  await expect(page.getByTestId('boundary-panel')).toBeVisible()
  const slotRows = await page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'slot')!
      .layout.rows.filter((r) => r.kind === 'widget').map((r) => r.inputId),
  )
  expect(slotRows).toContain('slot.gain')
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()
  expect((await activeDoc(page)).graphs.g0!.nodes.inst!.values.gain).toBe(5.5)
})

test('drilled forwarded family rows merge the definition prefix and instance suffix', async ({ page }) => {
  await drillIntoInstance(page)
  const ids = await page.evaluate(() => {
    const fam = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === 'fam')!
    const rows = fam.layout.rows as unknown as Array<{ kind: string; input?: { portId: string }; inputId?: string }>
    return rows.flatMap((row) => row.kind === 'ports' && row.input ? [row.input.portId] : row.kind === 'widget' && row.inputId ? [row.inputId] : [])
  })
  expect(ids.filter((id) => id.startsWith('images.img#'))).toEqual([
    'images.img#d0', 'images.img#\u0000s0', 'images.img#\u0000s1', 'images.img#m0',
  ])
  expect(ids).toContain('images.weight#d0')
  expect(ids).toContain('images.weight#\u0000s0')
  expect(ids).toContain('images.weight#\u0000s1')
})

test('drilled suffix sockets route through the occurrence planner without mutating the definition or sibling', async ({ page }) => {
  const before = await activeDoc(page)
  const rootLinks = Object.keys(before.graphs.g0!.links)
  await drillIntoInstance(page)
  await drag(page, await pinPoint(page, 'cmb', 'out'), await pinPoint(page, 'fam', 'images.img#m0'))
  await returnToRoot(page)

  const doc = await activeDoc(page)
  expect((doc.graphs.g0!.nodes.inst! as unknown as { dynamic: { images: { members: string[] } } }).dynamic.images.members)
    .toEqual(['s0', 's1', 'm0'])
  expect((doc.graphs.g0!.nodes.inst2! as unknown as { dynamic: { images: { members: string[] } } }).dynamic.images.members)
    .toEqual(['other0'])
  expect((doc.graphs.sub!.nodes.fam! as unknown as { dynamic: { images: { members: string[] } } }).dynamic.images.members)
    .toEqual(['d0'])
  expect(Object.keys(doc.graphs.sub!.links)).toEqual(['k1'])
  expect(Object.keys(doc.graphs.g0!.links)).toEqual(rootLinks)
  expect(Object.values(doc.occurrenceTopologies ?? {})
    .reduce((count, topology) => count + Object.keys(topology.links).length, 0)).toBe(1)
})

test('editing a drilled suffix widget writes occurrence state and one undo reverts', async ({ page }) => {
  await drillIntoInstance(page)
  const point = await widgetRowPoint(page, 'fam', 'images.weight#\u0000s1')
  await page.mouse.click(point.x, point.y)
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('6.5')
  await input.press('Enter')

  let doc = await activeDoc(page)
  expect(doc.graphs.g0!.nodes.inst!.values['images.weight#s1']).toBe(6.5)
  expect(doc.graphs.g0!.nodes.inst2!.values['images.weight#s1']).toBeUndefined()
  expect(doc.graphs.sub!.nodes.fam!.values['images.weight#s1']).toBeUndefined()
  expect(doc.graphs.sub!.nodes.fam!.values['images.weight#d0']).toBe(3)

  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(doc.graphs.g0!.nodes.inst!.values['images.weight#s1']).toBeUndefined()
})
