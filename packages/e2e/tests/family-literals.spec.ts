import { expect, test, type Page } from './fixtures.js'

async function nodePoint(
  page: Page,
  nodeId: string,
  target: { kind: 'widget'; inputId: string } | { kind: 'pin'; direction: 'in' | 'out'; portId: string },
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, target }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    if (!node) throw new Error(`missing node ${nodeId}`)
    const canvas = document.querySelector<HTMLElement>('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    const pagePoint = (worldX: number, worldY: number) => ({
      x: canvas.left + worldX * viewport.scale + viewport.x,
      y: canvas.top + worldY * viewport.scale + viewport.y,
    })
    if (target.kind === 'widget') {
      const row = node.layout.rows.find((candidate) =>
        candidate.kind === 'widget' && candidate.inputId === target.inputId)
      if (!row) throw new Error(`missing widget ${nodeId}:${target.inputId}`)
      return pagePoint(node.x + node.layout.width / 2, node.y + row.y + row.height / 2)
    }
    const pin = node.layout.pins.find((candidate) =>
      candidate.direction === target.direction && candidate.portId === target.portId)
    if (!pin) throw new Error(`missing pin ${nodeId}:${target.portId}`)
    return pagePoint(
      node.x + (target.direction === 'in' ? 0 : node.layout.width),
      node.y + pin.y,
    )
  }, { nodeId, target })
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

test('legacy named family literal editing advances the ghost through compaction', async ({ page }, testInfo) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'proof' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'family-literal-proof', schemaWire: 1 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const scalar = { kind: 'union', names: ['core.float', 'core.int', 'core.boolean'] }
    app.registerSchemas([
      {
        type: 'FamilyLiteralProof',
        displayName: 'Math operands',
        category: 'proof',
        source: 'v3',
        isOutputNode: false,
        items: [{
          kind: 'input',
          id: 'values',
          type: { kind: 'wildcard' },
          optional: false,
          dynamic: {
            kind: 'autogrow',
            materialization: 'wire15',
            naming: { kind: 'names', names: ['a', 'b', 'c'], min: 1 },
            template: [{ kind: 'input', id: 'value', type: scalar, optional: false }],
          },
        }],
      },
      {
        type: 'FamilyLiteralSource',
        displayName: 'Number source',
        category: 'proof',
        source: 'v3',
        isOutputNode: false,
        items: [{ kind: 'output', id: 'value', type: { kind: 'concrete', name: 'core.float' } }],
      },
    ] as never)
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'family-literal-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            source: { id: 'source', type: 'FamilyLiteralSource', values: {} },
            math: {
              id: 'math',
              type: 'FamilyLiteralProof',
              values: {},
              dynamic: { values: { members: ['a'] } },
            },
          },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 3,
        },
      },
      view: { graphs: { g0: { nodes: {
        source: { position: { x: 100, y: 180 } },
        math: { position: { x: 480, y: 140 } },
      } } } },
    }, 'Family literal proof')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 20, scale: 1.5 })
  })
  await page.waitForFunction(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'math')
    return node?.layout.rows.some((row) => row.kind === 'widget' && row.inputId === 'values.b') === true
  })

  const ghostWidget = await nodePoint(page, 'math', { kind: 'widget', inputId: 'values.b' })
  await page.mouse.click(ghostWidget.x, ghostWidget.y)
  const editor = page.locator('#widget-editor-value')
  await expect(editor).toBeVisible()
  await editor.fill('2.5')
  await editor.press('Enter')

  await expect.poll(() => page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const node = app.activeTab()!.store.doc.graphs.g0!.nodes.math!
    const sceneNode = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'math')!
    return {
      members: node.dynamic?.values?.members,
      literal: node.values['values.b'],
      widgets: sceneNode.layout.rows.filter((row) => row.kind === 'widget').map((row) => row.inputId),
      ghost: sceneNode.layout.pins.find((pin) => pin.portId === 'values.c')?.ghost === true,
    }
  })).toEqual({
    members: ['a', 'b'],
    literal: 2.5,
    widgets: ['values.a', 'values.b', 'values.c'],
    ghost: true,
  })

  await drag(
    page,
    await nodePoint(page, 'source', { kind: 'pin', direction: 'out', portId: 'value' }),
    await nodePoint(page, 'math', { kind: 'pin', direction: 'in', portId: 'values.b' }),
  )
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    return Object.values(graph.links).map((link) => link.to)
  })).toEqual([{ node: 'math', port: 'values.b' }])

  const header = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === 'math')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(header.x, header.y, { button: 'right' })
  await page.locator('[data-testid=context-menu-item][data-item-id="core.node.compactDynamic"]').click()
  await expect.poll(() => page.evaluate(() => {
    const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    const sceneNode = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'math')!
    return {
      state: graph.nodes.math!.dynamic?.values,
      pins: sceneNode.layout.pins.filter((pin) => pin.direction === 'in')
        .map((pin) => ({ port: pin.portId, ghost: pin.ghost === true })),
    }
  })).toEqual({
    state: { members: ['b'], seq: 0 },
    pins: [
      { port: 'values.b', ghost: false },
      { port: 'values.c', ghost: true },
    ],
  })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const serialized = JSON.parse(JSON.stringify(app.activeTab()!.store.doc))
    app.openDocument(serialized, 'Reloaded family literal proof')
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 20, scale: 1.5 })
  })
  const reloaded = await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const graph = app.activeTab()!.store.doc.graphs.g0!
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'math')!
    return {
      members: graph.nodes.math!.dynamic?.values?.members,
      literal: graph.nodes.math!.values['values.b'],
      target: Object.values(graph.links)[0]?.to,
      pins: node.layout.pins.filter((pin) => pin.direction === 'in')
        .map((pin) => ({ port: pin.portId, ghost: pin.ghost === true, widgetBacked: pin.widgetBacked === true })),
    }
  })
  expect(reloaded).toEqual({
    members: ['b'],
    literal: 2.5,
    target: { node: 'math', port: 'values.b' },
    pins: [
      { port: 'values.b', ghost: false, widgetBacked: false },
      { port: 'values.c', ghost: true, widgetBacked: false },
    ],
  })

  const path = testInfo.outputPath('family-literals.png')
  await page.screenshot({ path, animations: 'disabled' })
  await testInfo.attach('family literals', { path, contentType: 'image/png' })
})
