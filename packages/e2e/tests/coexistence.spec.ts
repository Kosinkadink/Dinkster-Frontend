/**
 * Browser coexistence regression driven through the PRODUCTION CanvasHost
 * with real interactions. Every construct is present at once - a subgraph
 * instance forwarding two group member inputs, a promoted choice option
 * widget, a promoted type-choice dependent, a reroute chain, a named net, a
 * value source, and a fixed-policy selector - and the user can still edit a
 * promoted widget, all with a clean Problems state.
 */
import { expect, openRailPanel, test, waitForWorkspaceReady, subgraphMarkPoint, type Page } from './fixtures.js'

const activeDoc = (page: Page) =>
  page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)

async function widgetRowPoint(page: Page, nodeId: string, inputId: string): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, inputId }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)!
    const row = node.layout.rows.find((item) => item.kind === 'widget' && item.inputId === inputId)
    if (!row) throw new Error(`no widget row '${nodeId}/${inputId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  }, { nodeId, inputId })
}

async function openCoexistenceWorkflow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const IMAGE = { kind: 'concrete', name: 'IMAGE' }
    const FLOAT = { kind: 'concrete', name: 'FLOAT' }
    const input = (id: string, extra: Record<string, unknown> = {}) =>
      ({ kind: 'input', id, type: IMAGE, optional: false, ...extra })
    const widget = (id: string, value: number) => input(id, {
      type: FLOAT, optional: true, widget: { widgetType: 'FLOAT', options: {}, default: value },
    })
    const output = (id: string) => ({ kind: 'output', id, type: IMAGE })
    const schemaOf = (type: string, body: unknown[]) =>
      ({ type, displayName: type, category: 'test', source: 'v3', isOutputNode: false, body })
    window.__dinksterTest!.app.registerSchemas([
      schemaOf('CoexSrcTest', [output('out')]),
      schemaOf('CoexComboTest', [
        {
          kind: 'choice', id: 'mode', required: true,
          shared: [widget('amount', 1)],
          options: [
            { key: 'a', rows: [{ kind: 'use', id: 'amount' }] },
            { key: 'b', rows: [{ kind: 'use', id: 'amount', default: 2 }, widget('bias', 3)] },
          ],
        },
        output('out'),
      ]),
      schemaOf('CoexFamTest', [
        {
          kind: 'group', id: 'images',
          member: [input('img', { optional: true }), widget('weight', 1)],
          keys: { kind: 'numbered', prefix: 'image', start: 0, pad: 0 },
          grows: 'link', minMembers: 0, maxMembers: 4,
        },
        output('out'),
      ]),
      schemaOf('CoexSlotTest', [
        { kind: 'typeChoice', id: 'slot', type: IMAGE, required: false, rows: [widget('gain', 4)] },
        output('out'),
      ]),
      schemaOf('CoexSinkTest', [input('in')]),
    ] as never)
    await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'coexistence-e2e', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: {
            src1: { id: 'src1', type: 'CoexSrcTest', values: {} },
            src2: { id: 'src2', type: 'CoexSrcTest', values: {} },
            inst: { id: 'inst', type: '#sub', values: { gain: 8 } },
            inst2: { id: 'inst2', type: '#sub', values: {} },
            snk: { id: 'snk', type: 'CoexSinkTest', values: {} },
            snk2: { id: 'snk2', type: 'CoexSinkTest', values: {} },
          },
          links: {
            l1: { id: 'l1', from: { node: 'src1', port: 'out' }, to: { reroute: 'r1' } },
            l2: { id: 'l2', from: { reroute: 'r1' }, to: { reroute: 'r2' } },
            l3: { id: 'l3', from: { reroute: 'r2' }, to: { node: 'inst', port: 'first' } },
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
              sinks: [{ node: 'inst', port: 'second' }],
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
            cmb2: { id: 'cmb2', type: 'CoexComboTest', values: {}, dynamic: { mode: { selected: 'b' } } },
            fam: {
              id: 'fam', type: 'CoexFamTest', values: { 'images.image0.weight': 3 },
              dynamic: { images: { members: ['image0', 'image1'], seq: 2 } },
            },
            slot: { id: 'slot', type: 'CoexSlotTest', values: {} },
          },
          links: {
            k1: { id: 'k1', from: { node: 'fam', port: 'out' }, to: { node: 'slot', port: 'slot' } },
          },
          nets: {}, reroutes: {},
          boundary: {
            body: [
              { kind: 'input', id: 'amount', promoted: true, binds: { kind: 'port', node: 'cmb2', port: 'mode.amount' } },
              { kind: 'input', id: 'first', binds: { kind: 'port', node: 'fam', port: 'images.image0.img' } },
              { kind: 'input', id: 'second', binds: { kind: 'port', node: 'fam', port: 'images.image1.img' } },
              { kind: 'input', id: 'gain', promoted: true, binds: { kind: 'port', node: 'slot', port: 'slot.gain' } },
              { kind: 'output', id: 'result', binds: { kind: 'port', node: 'slot', port: 'out' } },
            ],
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
  await waitForWorkspaceReady(page)
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
  // Forwarded member inputs, promoted rows, and the boundary output all coexist.
  for (const pin of ['first', 'second', 'amount', 'gain', 'result']) {
    expect(scene.instPins, `instance pin ${pin}`).toContain(pin)
  }
  await expect(page.getByTestId('problems-panel')).not.toContainText(/solve\.|compile\.|boundary\./)
})

test('editing the promoted type-choice dependent persists across drill-in and back', async ({ page }) => {
  const point = await widgetRowPoint(page, 'inst', 'gain')
  await page.mouse.click(point.x, point.y)
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('5.5')
  await input.press('Enter')
  expect((await activeDoc(page)).graphs.g0!.nodes.inst!.values.gain).toBe(5.5)

  // Drill into the definition and back: the promoted value survives and the
  // definition still shows the revealed dependent on the inner slot node.
  const mark = await subgraphMarkPoint(page, 'inst')
  await page.mouse.dblclick(mark.x, mark.y)
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
