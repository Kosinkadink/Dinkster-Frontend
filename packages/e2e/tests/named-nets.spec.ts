/**
 * Named nets (first-class Get/Set): promote an output from its pin menu,
 * attach inputs, render labeled noodles, collapse them into endpoint tags,
 * and manage the net from tags/noodles. Everything runs through real pointer
 * interactions + the shared menu registry; the document assertions prove the
 * net serializes as ONE hyperedge scoped to its graph definition.
 */
import { expect, test, type Page } from './fixtures.js'
import { evidencePath } from './evidence-output.js'

const xy = (p: { x: number; y: number }): [number, number] => [p.x, p.y]

/**
 * Issue #23 / #176 / #177 / #184 / #262 evidence captures. Captures are
 * written to the Playwright output directory; inspected copies are retained
 * at https://github.com/Kosinkadink/dinkster-evidence/tree/main/frontend.
 */
async function evidenceShot(page: Page, name: string, group: string = 'issue-23'): Promise<void> {
  await page.screenshot({ path: evidencePath(group, name), animations: 'disabled' })
}

/** Frame the whole scene (and settle the repaint) before an evidence shot. */
async function fitForShot(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.fitToScene()
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  })
}

async function identityViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

/** Page coordinates of a node's pin center (assumes identity viewport). */
async function pinPoint(
  page: Page,
  nodeId: string,
  portId: string,
  direction: 'in' | 'out',
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ nodeId, portId, direction }) => {
      const r = window.__dinksterTest!.renderer!
      const vp = r.getViewport()
      const node = r.getScene().nodes.find((n) => n.id === nodeId)
      if (!node) throw new Error(`no scene node '${nodeId}'`)
      const pin = node.layout.pins.find((p) => p.portId === portId && p.direction === direction)
      if (!pin) throw new Error(`no pin '${direction}:${portId}' on '${nodeId}'`)
      const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
      const wx = direction === 'in' ? node.x : node.x + node.layout.width
      return { x: rect.left + wx * vp.scale + vp.x, y: rect.top + (node.y + pin.y) * vp.scale + vp.y }
    },
    { nodeId, portId, direction },
  )
}

/** Page coordinates of a node's header center (assumes identity viewport). */
async function headerPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const node = r.getScene().nodes.find((n) => n.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * vp.scale + vp.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

/** Scene coordinates of a node and its net tag (for offset assertions). */
async function tagAndNode(page: Page, nodeId: string): Promise<{
  stub: { x: number; y: number }
  node: { x: number; y: number }
}> {
  return page.evaluate((nodeId) => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const stub = scene.netStubs.find((s) => s.nodeId === nodeId)
    if (!stub) throw new Error(`no net stub on '${nodeId}'`)
    const node = scene.nodes.find((n) => n.id === nodeId)!
    return { stub: { x: stub.x, y: stub.y }, node: { x: node.x, y: node.y } }
  }, nodeId)
}

/** Page coordinates of a net noodle's midpoint. */
async function netLinkPoint(page: Page, linkId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((linkId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const link = r.getScene().links.find((l) => l.id === linkId)
    if (!link) throw new Error(`no scene link '${linkId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + ((link.x1 + link.x2) / 2) * vp.scale + vp.x,
      y: rect.top + ((link.y1 + link.y2) / 2) * vp.scale + vp.y,
    }
  }, linkId)
}

/** Page coordinates of a collapsed-net endpoint tag's center. */
async function stubPoint(page: Page, nodeId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((nodeId) => {
    const r = window.__dinksterTest!.renderer!
    const vp = r.getViewport()
    const stub = r.getScene().netStubs.find((s) => s.nodeId === nodeId)
    if (!stub) throw new Error(`no net stub on '${nodeId}'`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: rect.left + (stub.x + stub.width / 2) * vp.scale + vp.x,
      y: rect.top + (stub.y + stub.height / 2) * vp.scale + vp.y,
    }
  }, nodeId)
}

const activeDoc = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc)
const sceneShape = (page: Page) =>
  page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScene()
    return {
      netLinks: s.links
        .filter((l) => l.netId !== undefined)
        .map((l) => ({ id: l.id, netName: l.netName, ...(l.hidden === true ? { hidden: true } : {}) })),
      stubs: s.netStubs.map((st) => `${st.role}:${st.nodeId}:${st.name}`).sort(),
    }
  })

const menu = (page: Page) => page.getByTestId('context-menu')
const menuItem = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`)

/** One producer feeding nothing yet + two consumers; nets start empty. */
async function openNetWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'NetProducer',
        displayName: 'Net Producer',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [{ kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'LATENT' } }],
      },
      {
        type: 'NetConsumer',
        displayName: 'Net Consumer',
        category: 'test',
        source: 'v3',
        isOutputNode: false,
        items: [{ kind: 'input', id: 'in0', type: { kind: 'concrete', name: 'LATENT' }, optional: false }],
      },
    ])
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-nets',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              p0: { id: 'p0', type: 'NetProducer', values: {} },
              c1: { id: 'c1', type: 'NetConsumer', values: {} },
              c2: { id: 'c2', type: 'NetConsumer', values: {} },
            },
            links: {},
            nets: {},
            reroutes: {},
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                p0: { position: { x: 60, y: 160 } },
                c1: { position: { x: 520, y: 80 } },
                c2: { position: { x: 520, y: 320 } },
              },
            },
          },
        },
      },
      'Nets',
    )
  })
  await identityViewport(page)
  // Let the initial scene rebuilds finish before tests start menu
  // interactions (any rebuild closes an open context menu).
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

test.beforeEach(async ({ page }) => {
  // Mock the backend polls (same as clipboard.spec.ts): without a live
  // backend, failing polls churn app state and re-render open menus
  // mid-click, which flakes every context-menu interaction.
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  // No settings seed: named nets are enabled by default and this suite
  // proves the default-on surface.
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  // Detach from the workspace session BEFORE opening the fixture: the async
  // session adoption switches id allocation to actor-scoped ids (net0-<actor>
  // instead of net100) and its scene rebuild closes any open context menu,
  // so racing it makes every id assertion and menu interaction flaky.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app as unknown as {
      disableWorkspaceAuthority(keepLocalTabs: boolean): void
    }
    app.disableWorkspaceAuthority(true)
  })
  await openNetWorkflow(page)
})

test('full net lifecycle: promote, connect, collapse, disconnect, rename, expand', async ({ page }) => {
  // 1. Promote p0.out0 through the pin menu; name it in the app-owned prompt.
  await page.mouse.click(...xy(await pinPoint(page, 'p0', 'out0', 'out')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await menuItem(page, 'core.pin.promoteToNet').click()
  const prompt = page.getByTestId('net-prompt-input')
  await expect(prompt).toBeVisible()
  await prompt.fill('latents')
  await prompt.press('Enter')
  await expect(page.getByTestId('net-prompt')).not.toBeVisible()

  let doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']).toEqual({
    id: 'net100',
    name: 'latents',
    source: { node: 'p0', port: 'out0' },
    sinks: [],
  })

  // 2. Attach both consumers from their input-pin menus.
  await page.mouse.click(...xy(await pinPoint(page, 'c1', 'in0', 'in')), { button: 'right' })
  await menuItem(page, 'core.pin.connectToNet.net100').click()
  await page.mouse.click(...xy(await pinPoint(page, 'c2', 'in0', 'in')), { button: 'right' })
  await menuItem(page, 'core.pin.connectToNet.net100').click()

  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']!.sinks).toEqual([
    { node: 'c1', port: 'in0' },
    { node: 'c2', port: 'in0' },
  ])

  // 3. Both sinks render as labeled noodles and authorable Get/Set views.
  let scene = await sceneShape(page)
  expect(scene.netLinks).toEqual([
    { id: 'net100:0', netName: 'latents' },
    { id: 'net100:1', netName: 'latents' },
  ])
  expect(scene.stubs).toEqual(['sink:c1:latents', 'sink:c2:latents', 'source:p0:latents'])

  // 4. Switch to Tags Only from a noodle's own context menu.
  await page.mouse.click(...xy(await netLinkPoint(page, 'net100:0')), { button: 'right' })
  await chooseNetDisplay(page, 'tags')
  doc = await activeDoc(page)
  expect(doc.view.graphs['g0']!.collapsedNets).toEqual(['net100'])
  scene = await sceneShape(page)
  // Collapse hides the noodles but keeps the deliveries in the scene, so
  // pins and widgets still read connected.
  expect(scene.netLinks).toEqual([
    { id: 'net100:0', netName: 'latents', hidden: true },
    { id: 'net100:1', netName: 'latents', hidden: true },
  ])
  expect(scene.stubs).toEqual(['sink:c1:latents', 'sink:c2:latents', 'source:p0:latents'])

  // 5. A sink tag disconnects ONLY its own sink.
  await page.mouse.click(...xy(await stubPoint(page, 'c1')), { button: 'right' })
  await menuItem(page, 'core.net.stubDisconnect').click()
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']!.sinks).toEqual([{ node: 'c2', port: 'in0' }])
  scene = await sceneShape(page)
  expect(scene.stubs).toEqual(['sink:c2:latents', 'source:p0:latents'])

  // 6. Rename from the source tag; the prompt pre-fills the current name.
  await page.mouse.click(...xy(await stubPoint(page, 'p0')), { button: 'right' })
  await menuItem(page, 'core.net.rename').click()
  const rename = page.getByTestId('net-prompt-input')
  await expect(rename).toBeVisible()
  await expect(rename).toHaveValue('latents')
  await rename.fill('noise')
  await rename.press('Enter')
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']!.name).toBe('noise')

  // 7. Show the noodles again from a tag.
  await page.mouse.click(...xy(await stubPoint(page, 'p0')), { button: 'right' })
  await chooseNetDisplay(page, 'noodle')
  scene = await sceneShape(page)
  expect(scene.stubs).toEqual(['sink:c2:noise', 'source:p0:noise'])
  expect(scene.netLinks).toEqual([{ id: 'net100:0', netName: 'noise' }])

  // 8. Undo walks the whole session back; redo replays it.
  for (let i = 0; i < 7; i++) await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']).toBeUndefined()
  await page.keyboard.press('Control+Shift+z')
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']).toMatchObject({ name: 'latents', sinks: [] })
})

test('collapsed mismatch tags keep the solver error visible beside a healthy delivery', async ({ page }) => {
  const diagnostics = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'NetImageConsumer',
      displayName: 'Image Consumer',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{ kind: 'input', id: 'in0', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
    }])
    const doc = structuredClone(app.activeTab()!.store.doc)
    doc.lineage = 'lineage-nets-mismatch'
    doc.graphs['g0']!.nodes['c2']!.type = 'NetImageConsumer'
    doc.graphs['g0']!.nets['net100'] = {
      id: 'net100',
      name: 'latents',
      source: { node: 'p0', port: 'out0' },
      sinks: [{ node: 'c1', port: 'in0' }, { node: 'c2', port: 'in0' }],
    }
    doc.graphs['g0']!.nextOrdinal = 101
    doc.view.graphs['g0']!.collapsedNets = ['net100']
    return app.openDocument(doc, 'Collapsed mismatch')
  })
  expect(diagnostics).toEqual([])
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.renderer!.getScene().links.filter((link) => link.netId === 'net100').length,
  )).toBe(2)
  await fitForShot(page)

  const state = await page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    return {
      links: scene.links.filter((link) => link.netId === 'net100').map((link) => ({
        id: link.id,
        hidden: link.hidden,
        mismatch: link.mismatch,
      })),
      stubs: scene.netStubs.map((stub) => ({
        role: stub.role,
        nodeId: stub.nodeId,
        mismatch: stub.mismatch,
      })),
    }
  })
  expect(state.links).toEqual([
    { id: 'net100:0', hidden: true, mismatch: undefined },
    { id: 'net100:1', hidden: true, mismatch: true },
  ])
  expect(state.stubs).toEqual([
    { role: 'source', nodeId: 'p0', mismatch: true },
    { role: 'sink', nodeId: 'c1', mismatch: undefined },
    { role: 'sink', nodeId: 'c2', mismatch: true },
  ])
  await evidenceShot(page, 'collapsed-mismatch-and-healthy-tags.png', 'issue-184')
})

test('Get/Set views move atomically and advisory geometry survives export/reopen', async ({ page }) => {
  await page.mouse.click(...xy(await pinPoint(page, 'p0', 'out0', 'out')), { button: 'right' })
  await menuItem(page, 'core.pin.promoteToNet').click()
  await page.getByTestId('net-prompt-input').fill('latents')
  await page.getByTestId('net-prompt-input').press('Enter')
  await page.mouse.click(...xy(await pinPoint(page, 'c1', 'in0', 'in')), { button: 'right' })
  await menuItem(page, 'core.pin.connectToNet.net100').click()

  const before = await stubPoint(page, 'c1')
  await page.mouse.move(before.x, before.y)
  await page.mouse.down()
  await page.mouse.move(before.x - 120, before.y + 90, { steps: 8 })
  await page.mouse.up()
  const moved = await page.evaluate(() => {
    const stub = window.__dinksterTest!.renderer!.getScene().netStubs.find((candidate) => candidate.nodeId === 'c1')!
    return { x: stub.x, y: stub.y, authored: stub.authored }
  })
  expect(moved.authored).toBe(true)
  // The document stores the placement as an offset from c1's top-left
  // (520, 80), so the tag follows later node moves.
  const movedDoc = await activeDoc(page)
  const entry = (movedDoc.ext?.['dinkster.netViews'] as { role: string; offset?: { x: number; y: number }; position?: unknown }[])
    .find((candidate) => candidate.role === 'sink')!
  expect(entry).toMatchObject({ graphId: 'g0', netId: 'net100', role: 'sink' })
  expect(entry.position).toBeUndefined()
  expect(entry.offset!.x).toBeCloseTo(moved.x - 520, 6)
  expect(entry.offset!.y).toBeCloseTo(moved.y - 80, 6)

  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).ext?.['dinkster.netViews']).toBeUndefined()
  await page.keyboard.press('Control+Shift+z')
  expect((await activeDoc(page)).ext?.['dinkster.netViews']).toBeDefined()

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const exported = app.exportDocument(tab.id)
    app.openDocument(JSON.parse(JSON.stringify(exported)), 'Nets reopened')
  })
  await identityViewport(page)
  const reopened = await page.evaluate(() => {
    const stub = window.__dinksterTest!.renderer!.getScene().netStubs.find((candidate) => candidate.nodeId === 'c1')!
    return { x: stub.x, y: stub.y, authored: stub.authored }
  })
  expect(reopened).toEqual(moved)

  const sink = await stubPoint(page, 'c1')
  await page.mouse.click(sink.x, sink.y)
  await page.keyboard.press('Delete')
  expect((await activeDoc(page)).graphs['g0']!.nets['net100']!.sinks).toEqual([])
  await page.keyboard.press('Control+z')
  expect((await activeDoc(page)).graphs['g0']!.nets['net100']!.sinks).toEqual([{ node: 'c1', port: 'in0' }])
})

test('a manually placed tag follows its node and keeps the chosen offset', async ({ page }) => {
  await buildLatentsNet(page, ['c1'])

  // Author the sink tag's placement by dragging it.
  const tag = await stubPoint(page, 'c1')
  await page.mouse.move(tag.x, tag.y)
  await page.mouse.down()
  await page.mouse.move(tag.x - 140, tag.y + 60, { steps: 8 })
  await page.mouse.up()
  const placed = await tagAndNode(page, 'c1')
  const offset = { x: placed.stub.x - placed.node.x, y: placed.stub.y - placed.node.y }
  await fitForShot(page)
  await evidenceShot(page, 'tag-placed-before-node-move.png', 'issue-176')
  await identityViewport(page)

  // Drag the node: mid-drag the tag rides along (screenshot evidence) and
  // the committed scene keeps the same node-relative offset.
  const header = await headerPoint(page, 'c1')
  await page.mouse.move(header.x, header.y)
  await page.mouse.down()
  await page.mouse.move(header.x + 170, header.y + 120, { steps: 10 })
  await evidenceShot(page, 'tag-mid-node-drag.png', 'issue-176')
  await page.mouse.up()

  const after = await tagAndNode(page, 'c1')
  expect(after.node.x).toBeCloseTo(placed.node.x + 170, 1)
  expect(after.node.y).toBeCloseTo(placed.node.y + 120, 1)
  expect(after.stub.x - after.node.x).toBeCloseTo(offset.x, 6)
  expect(after.stub.y - after.node.y).toBeCloseTo(offset.y, 6)
  // Only the node moved: the stored offset is untouched.
  const doc = await activeDoc(page)
  const entries = doc.ext?.['dinkster.netViews'] as { role: string; offset?: { x: number; y: number } }[]
  expect(entries).toHaveLength(1)
  expect(entries[0]!.offset!.x).toBeCloseTo(offset.x, 6)
  expect(entries[0]!.offset!.y).toBeCloseTo(offset.y, 6)
  await fitForShot(page)
  await evidenceShot(page, 'tag-after-node-move.png', 'issue-176')
  await identityViewport(page)

  // Undo returns node AND tag; redo replays both.
  await page.keyboard.press('Control+z')
  const undone = await tagAndNode(page, 'c1')
  expect(undone.node).toEqual(placed.node)
  expect(undone.stub.x - undone.node.x).toBeCloseTo(offset.x, 6)
  expect(undone.stub.y - undone.node.y).toBeCloseTo(offset.y, 6)
  await page.keyboard.press('Control+Shift+z')
  const redone = await tagAndNode(page, 'c1')
  expect(redone.node.x).toBeCloseTo(after.node.x, 6)
  expect(redone.stub.x - redone.node.x).toBeCloseTo(offset.x, 6)
})

test('Reset Tag Position returns an authored tag to its default spawn spot', async ({ page }) => {
  await buildLatentsNet(page, ['c1'])

  // A freshly spawned tag has no authored placement: nothing to reset.
  const spawn = await tagAndNode(page, 'c1')
  const tag = await stubPoint(page, 'c1')
  await page.mouse.click(tag.x, tag.y, { button: 'right' })
  await expect(menuItem(page, 'core.net.display')).toBeVisible()
  await expect(menuItem(page, 'core.net.stubResetPosition')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()

  // Author the placement by dragging the tag.
  await page.mouse.move(tag.x, tag.y)
  await page.mouse.down()
  await page.mouse.move(tag.x - 140, tag.y + 60, { steps: 8 })
  await page.mouse.up()
  const moved = await page.evaluate(() => {
    const stub = window.__dinksterTest!.renderer!.getScene().netStubs.find((candidate) => candidate.nodeId === 'c1')!
    return { x: stub.x, y: stub.y, authored: stub.authored }
  })
  expect(moved.authored).toBe(true)
  expect(moved).not.toMatchObject(spawn.stub)

  // Reset from the tag's context menu: back to the exact spawn placement.
  const movedPoint = await stubPoint(page, 'c1')
  await page.mouse.click(movedPoint.x, movedPoint.y, { button: 'right' })
  await menuItem(page, 'core.net.stubResetPosition').click()
  const reset = await page.evaluate(() => {
    const stub = window.__dinksterTest!.renderer!.getScene().netStubs.find((candidate) => candidate.nodeId === 'c1')!
    return { x: stub.x, y: stub.y, authored: stub.authored }
  })
  expect(reset).toEqual({ x: spawn.stub.x, y: spawn.stub.y, authored: undefined })
  const resetDoc = await activeDoc(page)
  expect(resetDoc.ext?.['dinkster.netViews']).toEqual([])

  // One undo restores the authored placement exactly.
  await page.keyboard.press('Control+z')
  const undone = await page.evaluate(() => {
    const stub = window.__dinksterTest!.renderer!.getScene().netStubs.find((candidate) => candidate.nodeId === 'c1')!
    return { x: stub.x, y: stub.y, authored: stub.authored }
  })
  expect(undone).toEqual(moved)
})

test('legacy absolute tag geometry loads without a jump and then follows the node', async ({ page }) => {
  // A document saved before offsets existed carries a world point. Loading
  // canonicalizes it to a node-relative offset that renders at exactly the
  // same spot, and the tag follows the node from then on.
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-legacy-netviews',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              p0: { id: 'p0', type: 'NetProducer', values: {} },
              c1: { id: 'c1', type: 'NetConsumer', values: {} },
            },
            links: {},
            nets: {
              net0: { id: 'net0', name: 'latents', source: { node: 'p0', port: 'out0' }, sinks: [{ node: 'c1', port: 'in0' }] },
            },
            reroutes: {},
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: { p0: { position: { x: 60, y: 160 } }, c1: { position: { x: 520, y: 80 } } },
              collapsedNets: ['net0'],
            },
          },
        },
        ext: {
          'dinkster.netViews': [
            { graphId: 'g0', netId: 'net0', role: 'sink', to: { node: 'c1', port: 'in0' }, position: { x: 360, y: 40 } },
          ],
        },
      },
      'Legacy nets',
    )
  })
  await identityViewport(page)

  const loaded = await tagAndNode(page, 'c1')
  expect(loaded.stub).toEqual({ x: 360, y: 40 }) // exactly where it was saved
  const doc = await activeDoc(page)
  expect(doc.ext?.['dinkster.netViews']).toEqual([
    { graphId: 'g0', netId: 'net0', role: 'sink', to: { node: 'c1', port: 'in0' }, offset: { x: -160, y: -40 } },
  ])

  const header = await headerPoint(page, 'c1')
  await page.mouse.move(header.x, header.y)
  await page.mouse.down()
  await page.mouse.move(header.x + 100, header.y + 50, { steps: 8 })
  await page.mouse.up()
  const after = await tagAndNode(page, 'c1')
  expect(after.node.x).toBeCloseTo(620, 1)
  expect(after.node.y).toBeCloseTo(130, 1)
  expect(after.stub.x - after.node.x).toBeCloseTo(-160, 6)
  expect(after.stub.y - after.node.y).toBeCloseTo(-40, 6)
})

test('connecting a net displaces the direct link driving that input', async ({ page }) => {
  // Wire p0 -> c1 with an ordinary link first (pin drag).
  const from = await pinPoint(page, 'p0', 'out0', 'out')
  const to = await pinPoint(page, 'c1', 'in0', 'in')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await page.mouse.up()
  let doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(1)

  // Promote + connect the same input through the net. The link drag consumed
  // ordinal 100 (l100), so the net allocates net101.
  await page.mouse.click(...xy(await pinPoint(page, 'p0', 'out0', 'out')), { button: 'right' })
  await menuItem(page, 'core.pin.promoteToNet').click()
  const prompt = page.getByTestId('net-prompt-input')
  await prompt.fill('latents')
  await prompt.press('Enter')
  await page.mouse.click(...xy(await pinPoint(page, 'c1', 'in0', 'in')), { button: 'right' })
  await menuItem(page, 'core.pin.connectToNet.net101').click()

  doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(0) // displaced
  expect(doc.graphs['g0']!.nets['net101']!.sinks).toEqual([{ node: 'c1', port: 'in0' }])

  // ONE undo restores the direct link and empties the net.
  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(1)
  expect(doc.graphs['g0']!.nets['net101']!.sinks).toEqual([])
})

test('escape dismisses the name prompt without committing anything', async ({ page }) => {
  await page.mouse.click(...xy(await pinPoint(page, 'p0', 'out0', 'out')), { button: 'right' })
  await menuItem(page, 'core.pin.promoteToNet').click()
  const prompt = page.getByTestId('net-prompt-input')
  await expect(prompt).toBeVisible()
  await prompt.fill('doomed')
  await prompt.press('Escape')
  await expect(page.getByTestId('net-prompt')).not.toBeVisible()
  const doc = await activeDoc(page)
  expect(Object.keys(doc.graphs['g0']!.nets)).toHaveLength(0)
})

test('nets never cross subgraph boundaries: inner pins see no parent nets', async ({ page }) => {
  // Rebuild the doc with a subgraph instance + a parent-level net.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-nets-sub',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              p0: { id: 'p0', type: 'NetProducer', values: {} },
              s0: { id: 's0', type: '#sub', values: {} },
            },
            links: {},
            nets: {
              t1: {
                id: 't1',
                name: 'shared',
                source: { node: 'p0', port: 'out0' },
                sinks: [],
              },
            },
            reroutes: {},
            nextOrdinal: 100,
          },
          sub: {
            id: 'sub',
            name: 'Sub',
            boundary: { inputs: [], outputs: [] },
            nodes: {
              m1: { id: 'm1', type: 'NetConsumer', values: {} },
              m2: { id: 'm2', type: 'NetProducer', values: {} },
            },
            links: {},
            nets: {
              u1: {
                id: 'u1',
                name: 'shared',
                source: { node: 'm2', port: 'out0' },
                sinks: [],
              },
            },
            reroutes: {},
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: { p0: { position: { x: 60, y: 160 } }, s0: { position: { x: 520, y: 160 } } },
            },
            sub: { nodes: { m1: { position: { x: 400, y: 160 } }, m2: { position: { x: 60, y: 160 } } } },
          },
        },
      },
      'Nets Sub',
    )
  })
  await identityViewport(page)

  // Drill into the subgraph and open the inner consumer's input-pin menu.
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab() as unknown as {
      graphStack: { update(fn: (s: readonly string[]) => readonly string[]): void }
    }
    tab.graphStack.update((s) => [...s, 'sub'])
  })
  await identityViewport(page)
  await page.mouse.click(...xy(await pinPoint(page, 'm1', 'in0', 'in')), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  // The subgraph's own net is offered; the parent's same-name net must not be.
  await expect(menuItem(page, 'core.pin.connectToNet.u1')).toBeVisible()
  await expect(menuItem(page, 'core.pin.connectToNet.t1')).toHaveCount(0)
  const drilled = await page.evaluate(() => window.__dinksterTest!.renderer!.getScene().netStubs.map((stub) => stub.netId))
  expect(new Set(drilled)).toEqual(new Set(['u1']))
})

/** Promote p0.out0 to net100 'latents' and attach the given consumers. */
async function buildLatentsNet(page: Page, sinks: readonly string[]): Promise<void> {
  await page.mouse.click(...xy(await pinPoint(page, 'p0', 'out0', 'out')), { button: 'right' })
  await menuItem(page, 'core.pin.promoteToNet').click()
  const prompt = page.getByTestId('net-prompt-input')
  await expect(prompt).toBeVisible()
  await prompt.fill('latents')
  await prompt.press('Enter')
  for (const sink of sinks) {
    await page.mouse.click(...xy(await pinPoint(page, sink, 'in0', 'in')), { button: 'right' })
    await menuItem(page, 'core.pin.connectToNet.net100').click()
  }
}

const revisionOf = (page: Page) => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.revision)

/** Pick a display mode from an already-open net/noodle context menu. */
async function chooseNetDisplay(page: Page, mode: 'noodle' | 'tags' | 'guide'): Promise<void> {
  await menuItem(page, 'core.net.display').hover()
  await menuItem(page, `core.net.display.${mode}`).click()
}

const netViewState = (page: Page) =>
  page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const view = doc.view.graphs['g0']
    return { collapsed: view?.collapsedNets ?? [], guides: view?.guideNets ?? [] }
  })

test('per-net display modes are exclusive and the Views menu sets all nets at once', async ({ page }) => {
  // Default-on evidence: the promote item appears with NO settings seed.
  await page.mouse.click(...xy(await pinPoint(page, 'p0', 'out0', 'out')), { button: 'right' })
  await expect(menuItem(page, 'core.pin.promoteToNet')).toBeVisible()
  await evidenceShot(page, 'default-on-authoring.png')
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()

  await buildLatentsNet(page, ['c1', 'c2'])

  // The submenu marks the current mode; a fresh net renders noodles.
  await page.mouse.click(...xy(await netLinkPoint(page, 'net100:0')), { button: 'right' })
  await menuItem(page, 'core.net.display').hover()
  await expect(menuItem(page, 'core.net.display.noodle')).toHaveClass(/checked/)
  await expect(menuItem(page, 'core.net.display.guide')).not.toHaveClass(/checked/)
  await evidenceShot(page, 'display-submenu.png')

  // Guide mode: one click collapses the noodles AND draws the dashed guide.
  await menuItem(page, 'core.net.display.guide').click()
  expect(await netViewState(page)).toEqual({ collapsed: ['net100'], guides: ['net100'] })
  let scene = await page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScene()
    return {
      guides: s.netStubs.filter((stub) => stub.guide === true).length,
      hiddenNetLinks: s.links.filter((l) => l.netId !== undefined && l.hidden === true).length,
    }
  })
  expect(scene).toEqual({ guides: 3, hiddenNetLinks: 2 })
  await evidenceShot(page, 'display-guide.png')

  // The check mark follows the persisted mode (reopened from a tag).
  await page.mouse.click(...xy(await stubPoint(page, 'p0')), { button: 'right' })
  await menuItem(page, 'core.net.display').hover()
  await expect(menuItem(page, 'core.net.display.guide')).toHaveClass(/checked/)
  await expect(menuItem(page, 'core.net.display.noodle')).not.toHaveClass(/checked/)
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()

  // Views menu set-all: one undoable document step back to noodles.
  const revisionBefore = await revisionOf(page)
  await page.getByTestId('views-switcher').click()
  await page.getByTestId('net-display-all-noodle').click()
  expect(await netViewState(page)).toEqual({ collapsed: [], guides: [] })
  expect(await revisionOf(page)).toBeGreaterThan(revisionBefore)
  scene = await page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScene()
    return {
      guides: s.netStubs.filter((stub) => stub.guide === true).length,
      hiddenNetLinks: s.links.filter((l) => l.netId !== undefined && l.hidden === true).length,
    }
  })
  expect(scene).toEqual({ guides: 0, hiddenNetLinks: 0 })
  await evidenceShot(page, 'display-all-noodles.png')

  // Set-all to tags, then a single undo restores the previous view state.
  await page.getByTestId('views-switcher').click()
  await page.getByTestId('net-display-all-tags').click()
  expect(await netViewState(page)).toEqual({ collapsed: ['net100'], guides: [] })
  await evidenceShot(page, 'display-all-tags.png')
  await page.keyboard.press('Control+z')
  expect(await netViewState(page)).toEqual({ collapsed: [], guides: [] })

  // The display mode never touches the graph itself: net and sinks intact.
  const doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']!.sinks).toHaveLength(2)
})

test('a net noodle midpoint offers no splice menu; right-click still opens the net menu', async ({ page }) => {
  await buildLatentsNet(page, ['c1'])
  const mid = await netLinkPoint(page, 'net100:0')

  // Neither a midpoint click nor a double-click opens the reroute/node
  // splice menu: the delivery's id is synthetic and splicing between a Set
  // and a Get has no defined semantics.
  await page.mouse.click(...xy(mid))
  await expect(page.getByTestId('link-double-click-menu')).not.toBeVisible()
  await page.mouse.dblclick(...xy(mid))
  await expect(page.getByTestId('link-double-click-menu')).not.toBeVisible()

  // The same midpoint still serves the net context menu.
  await page.mouse.click(...xy(mid), { button: 'right' })
  await expect(menu(page)).toBeVisible()
  await expect(menuItem(page, 'core.net.display')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu(page)).not.toBeVisible()

  await fitForShot(page)
  await evidenceShot(page, 'no-midpoint-dot.png', 'issue-262')
  await identityViewport(page)
})

test('pasting a copied sink merges into the compatible same-name net', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await buildLatentsNet(page, ['c1'])

  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['c1']))
  await page.keyboard.press('Control+c')
  await page.mouse.move(950, 180)
  await page.keyboard.press('Control+v')
  await expect.poll(async () => Object.keys((await activeDoc(page)).graphs['g0']!.nodes)).toHaveLength(4)

  const doc = await activeDoc(page)
  const nets = Object.values(doc.graphs['g0']!.nets)
  expect(nets).toHaveLength(1) // merged, no duplicate source and no rename
  expect(nets[0]!.name).toBe('latents')
  expect(nets[0]!.source).toEqual({ node: 'p0', port: 'out0' })
  expect(nets[0]!.sinks).toHaveLength(2)
  const pastedSink = nets[0]!.sinks.find((sink) => sink.node !== 'c1')!
  expect(doc.graphs['g0']!.nodes[pastedSink.node]!.type).toBe('NetConsumer')
  await fitForShot(page)
  await evidenceShot(page, 'paste-merge.png')

  // One undo removes the whole paste including the merged sink.
  await page.keyboard.press('Control+z')
  const undone = await activeDoc(page)
  expect(Object.keys(undone.graphs['g0']!.nodes)).toHaveLength(3)
  expect(undone.graphs['g0']!.nets['net100']!.sinks).toEqual([{ node: 'c1', port: 'in0' }])
})

test('pasting a copied source renames the collision deterministically', async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await buildLatentsNet(page, ['c1'])

  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['p0', 'c1']))
  await page.keyboard.press('Control+c')
  await page.mouse.move(750, 400)
  await page.keyboard.press('Control+v')
  await expect.poll(async () => Object.keys((await activeDoc(page)).graphs['g0']!.nodes)).toHaveLength(5)

  let doc = await activeDoc(page)
  let names = Object.values(doc.graphs['g0']!.nets).map((net) => net.name).sort()
  expect(names).toEqual(['latents', 'latents_2'])
  const renamed = Object.values(doc.graphs['g0']!.nets).find((net) => net.name === 'latents_2')!
  // Connectivity is preserved inside the pasted copy: its own source, its own sink.
  expect(renamed.source.node).not.toBe('p0')
  expect(doc.graphs['g0']!.nodes[renamed.source.node]!.type).toBe('NetProducer')
  expect(renamed.sinks).toHaveLength(1)
  expect(renamed.sinks[0]!.node).not.toBe('c1')
  expect(doc.graphs['g0']!.nodes[renamed.sinks[0]!.node]!.type).toBe('NetConsumer')
  await fitForShot(page)
  await evidenceShot(page, 'paste-rename.png')

  // A second paste of the same payload takes the next free suffix.
  await page.mouse.move(750, 620)
  await page.keyboard.press('Control+v')
  await expect.poll(async () => Object.keys((await activeDoc(page)).graphs['g0']!.nodes)).toHaveLength(7)
  doc = await activeDoc(page)
  names = Object.values(doc.graphs['g0']!.nets).map((net) => net.name).sort()
  expect(names).toEqual(['latents', 'latents_2', 'latents_3'])

  // Undo unwinds paste-by-paste.
  await page.keyboard.press('Control+z')
  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(Object.values(doc.graphs['g0']!.nets).map((net) => net.name)).toEqual(['latents'])
  expect(Object.keys(doc.graphs['g0']!.nodes)).toHaveLength(3)
})
test('a collapsed net stays a real connection: hidden scene link, and dragging the sink pin re-points the net', async ({ page }) => {
  await buildLatentsNet(page, ['c1'])
  await page.mouse.click(...xy(await netLinkPoint(page, 'net100:0')), { button: 'right' })
  await chooseNetDisplay(page, 'tags')

  // The delivery stays in the scene as a hidden link: painting and hit
  // testing skip it while pins, widgets, and gestures still see it.
  const netLinks = await page.evaluate(() => {
    const s = window.__dinksterTest!.renderer!.getScene()
    return s.links.filter((l) => l.netId !== undefined).map((l) => ({ id: l.id, hidden: l.hidden === true }))
  })
  expect(netLinks).toEqual([{ id: 'net100:0', hidden: true }])
  await fitForShot(page)
  await evidenceShot(page, 'collapsed-connected-pin.png', 'issue-177')
  await identityViewport(page)

  // Dragging the sink pin grabs the hidden delivery; the drop moves the
  // net membership to the target input in one undo step.
  const from = await pinPoint(page, 'c1', 'in0', 'in')
  const to = await pinPoint(page, 'c2', 'in0', 'in')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await evidenceShot(page, 'sink-drag-mid.png', 'issue-177')
  await page.mouse.up()
  let doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']!.sinks).toEqual([{ node: 'c2', port: 'in0' }])
  expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(0)
  await fitForShot(page)
  await evidenceShot(page, 'sink-drag-after.png', 'issue-177')
  await identityViewport(page)

  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net100']!.sinks).toEqual([{ node: 'c1', port: 'in0' }])
})

test('Shift-dragging the net source pin onto another producer re-points the whole net', async ({ page }) => {
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument(
      {
        format: 'dinkster-workflow',
        formatVersion: 1,
        lineage: 'lineage-nets-source-move',
        root: 'g0',
        graphs: {
          g0: {
            id: 'g0',
            name: 'root',
            nodes: {
              p0: { id: 'p0', type: 'NetProducer', values: {} },
              p1: { id: 'p1', type: 'NetProducer', values: {} },
              c1: { id: 'c1', type: 'NetConsumer', values: {} },
            },
            links: {},
            nets: {
              net0: { id: 'net0', name: 'latents', source: { node: 'p0', port: 'out0' }, sinks: [{ node: 'c1', port: 'in0' }] },
            },
            reroutes: {},
            nextOrdinal: 100,
          },
        },
        view: {
          graphs: {
            g0: {
              nodes: {
                p0: { position: { x: 60, y: 160 } },
                p1: { position: { x: 60, y: 400 } },
                c1: { position: { x: 520, y: 80 } },
              },
            },
          },
        },
      },
      'Nets source move',
    )
  })
  await identityViewport(page)

  const from = await pinPoint(page, 'p0', 'out0', 'out')
  const to = await pinPoint(page, 'p1', 'out0', 'out')
  await page.keyboard.down('Shift')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await evidenceShot(page, 'source-move-mid.png', 'issue-177')
  await page.mouse.up()
  await page.keyboard.up('Shift')

  let doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net0']!.source).toEqual({ node: 'p1', port: 'out0' })
  expect(doc.graphs['g0']!.nets['net0']!.sinks).toEqual([{ node: 'c1', port: 'in0' }])
  await fitForShot(page)
  await evidenceShot(page, 'source-move-after.png', 'issue-177')
  await identityViewport(page)

  // One undo returns the source; the sink list never churned.
  await page.keyboard.press('Control+z')
  doc = await activeDoc(page)
  expect(doc.graphs['g0']!.nets['net0']!.source).toEqual({ node: 'p0', port: 'out0' })
  expect(doc.graphs['g0']!.nets['net0']!.sinks).toEqual([{ node: 'c1', port: 'in0' }])
})
