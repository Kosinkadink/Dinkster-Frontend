import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_SUBGRAPH_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

async function openFixture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'ClipboardText', displayName: 'Clipboard Text', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'text', type: { kind: 'concrete', name: 'STRING' }, optional: false,
        widget: { widgetType: 'STRING', options: {}, default: '' } }],
    }, {
      type: 'EmptyImage', displayName: 'Empty Image', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' } }],
    }, {
      type: 'PreviewImage', displayName: 'Preview Image', category: 'test', source: 'v3', isOutputNode: true,
      items: [{ kind: 'input', id: 'images', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'clipboard-e2e', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        n0: { id: 'n0', type: 'EmptyImage', values: { width: 64, height: 64, batch_size: 1, color: 0 } },
        n1: { id: 'n1', type: 'PreviewImage', values: {} },
        text: { id: 'text', type: 'ClipboardText', values: { text: 'unchanged' } },
      }, links: {
        l0: { id: 'l0', from: { node: 'n0', port: 'out0' }, to: { reroute: 'r0' } },
        l1: { id: 'l1', from: { reroute: 'r0' }, to: { node: 'n1', port: 'images' } },
      }, nets: {}, reroutes: { r0: { id: 'r0' } }, nextOrdinal: 10 } },
      view: { graphs: { g0: { nodes: {
        n0: { position: { x: 100, y: 100 } }, n1: { position: { x: 500, y: 100 } },
        text: { position: { x: 100, y: 500 } },
      }, reroutes: { r0: { position: { x: 400, y: 180 } } } } } },
    }, 'Clipboard E2E')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

async function selectTopology(page: Page): Promise<void> {
  await page.evaluate(() => window.__dinksterTest!.controller!.setSelection(['n0', 'n1'], [], ['r0']))
}

type SelectionController = {
  getSelection(): Set<string>
  getRerouteSelection(): Set<string>
}

const graphCounts = (page: Page) => page.evaluate(() => {
  const graph = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
  return { nodes: Object.keys(graph.nodes).length, links: Object.keys(graph.links).length, reroutes: Object.keys(graph.reroutes).length }
})

test.beforeEach(async ({ context, page }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await openFixture(page)
  await page.waitForFunction(() => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab?.store.doc.lineage === 'clipboard-e2e' && 'status' in tab.store
  })
})

test('keyboard copy/paste preserves topology and selection and undoes atomically', async ({ page }) => {
  await selectTopology(page)
  await page.keyboard.press('Control+c')
  await page.mouse.move(750, 400)
  await page.keyboard.press('Control+v')
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 5, links: 4, reroutes: 2 })

  const selection = await page.evaluate(() => ({
    nodes: [...(window.__dinksterTest!.controller! as unknown as SelectionController).getSelection()],
    reroutes: [...(window.__dinksterTest!.controller! as unknown as SelectionController).getRerouteSelection()],
  }))
  expect(selection.nodes).toHaveLength(2)
  expect(selection.nodes).not.toContain('n0')
  expect(selection.reroutes).toHaveLength(1)
  expect(selection.reroutes).not.toContain('r0')

  await page.keyboard.press('Control+z')
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 3, links: 2, reroutes: 1 })
})

test('pasting a dynamic node removes unused members without recycling identity', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const scalar = { kind: 'concrete', name: 'FLOAT' }
    app.registerSchemas([{
      type: 'ClipboardAutogrow', displayName: 'Clipboard Autogrow', category: 'test',
      source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'values', type: scalar, optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'value', type: scalar, optional: false }],
          naming: { kind: 'prefix', prefix: 'value', min: 1, max: 10 },
        },
      }],
    }] as never)
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'clipboard-autogrow', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          dynamic: {
            id: 'dynamic', type: 'ClipboardAutogrow', values: {},
            dynamic: { values: { members: ['m3'], seq: 4 } },
          },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
      } },
      view: { graphs: { g0: { nodes: { dynamic: { position: { x: 200, y: 160 } } } } } },
    } as never, 'Clipboard Autogrow')
    window.__dinksterTest!.controller!.setSelection(['dynamic'])
  })

  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const pasted = [...window.__dinksterTest!.controller!.getSelection()][0]!
    const sceneNode = window.__dinksterTest!.renderer!.getScene().nodes.find((node) => node.id === pasted)
    return {
      original: tab.store.doc.graphs.g0!.nodes.dynamic!.dynamic,
      pasted,
      dynamic: tab.store.doc.graphs.g0!.nodes[pasted]!.dynamic,
      members: sceneNode?.layout.pins
        .filter((pin) => pin.direction === 'in' && pin.address.port === 'values.value')
        .map((pin) => ({
          id: pin.address.members?.[0],
          ghost: pin.ghost === true,
          familyMember: pin.familyMember === true,
          optional: pin.optional === true,
        })),
    }
  })).toEqual({
    original: { values: { members: ['m3'], seq: 4 } },
    pasted: 'n10',
    dynamic: { values: { seq: 4 } },
    members: [
      { id: 'm4', ghost: false, familyMember: true, optional: false },
      { id: 'm5', ghost: true, familyMember: true, optional: true },
    ],
  })

  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n10,
  )).toBeUndefined()
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.n10!.dynamic,
  )).toEqual({ values: { seq: 4 } })
})

test('connected paste restores incoming node links only and undoes in one step', async ({ page }) => {
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.store.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l1' } })
    tab.store.dispatch({ command: 'link.connect', params: {
      graphId: 'g0', from: { node: 'n0', port: 'out0' }, to: { node: 'n1', port: 'images' },
    } })
    window.__dinksterTest!.controller!.setSelection(['n1'])
  })
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+Shift+v')
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 4, links: 3, reroutes: 1 })
  const restored = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const pasted = [...window.__dinksterTest!.controller!.getSelection()][0]!
    const links = Object.values(tab.store.doc.graphs.g0!.links)
    return {
      pasted,
      incoming: links.some((link) => 'node' in link.from && link.from.node === 'n0' && 'node' in link.to && link.to.node === pasted),
      outgoing: links.some((link) => 'node' in link.from && link.from.node === pasted),
    }
  })
  expect(restored.incoming).toBe(true)
  expect(restored.outgoing).toBe(false)
  await page.keyboard.press('Control+z')
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 3, links: 2, reroutes: 1 })
})

test('connected paste restores an incoming link into a widget-backed input (audit)', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'FloatOut', displayName: 'Float Out', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'FLOAT' } }],
    }, {
      type: 'FloatWidget', displayName: 'Float Widget', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
        widget: { widgetType: 'FLOAT', options: {}, default: 0 } }],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'clipboard-widget-target', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'root', nodes: {
        fsrc: { id: 'fsrc', type: 'FloatOut', values: {} },
        fwid: { id: 'fwid', type: 'FloatWidget', values: { value: 2.5 } },
      }, links: {
        l0: { id: 'l0', from: { node: 'fsrc', port: 'out' }, to: { node: 'fwid', port: 'value' } },
      }, nets: {}, reroutes: {}, nextOrdinal: 10 } },
      view: { graphs: { g0: { nodes: {
        fsrc: { position: { x: 100, y: 100 } }, fwid: { position: { x: 500, y: 100 } },
      } } } },
    }, 'Clipboard Widget Target')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    window.__dinksterTest!.controller!.setSelection(['fwid'])
  })
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+Shift+v')
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 3, links: 2, reroutes: 0 })
  const restored = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const pasted = [...window.__dinksterTest!.controller!.getSelection()][0]!
    const links = Object.values(tab.store.doc.graphs.g0!.links)
    return {
      incoming: links.some((link) => 'node' in link.from && link.from.node === 'fsrc' && 'node' in link.to && link.to.node === pasted && link.to.port === 'value'),
      outgoing: links.some((link) => 'node' in link.from && link.from.node === pasted),
    }
  })
  expect(restored.incoming).toBe(true)
  expect(restored.outgoing).toBe(false)
  await page.keyboard.press('Control+z')
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 2, links: 1, reroutes: 0 })
})

test('system clipboard pastes into a second document and foreign text is ignored', async ({ page }) => {
  await selectTopology(page)
  await page.keyboard.press('Control+c')
  await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'clipboard-target', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: { g0: { nodes: {} } } },
  }, 'Clipboard Target'))
  await page.keyboard.press('Control+v')
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 2, links: 2, reroutes: 1 })

  await page.evaluate(() => navigator.clipboard.writeText('unrelated text'))
  await page.keyboard.press('Control+v')
  await page.waitForTimeout(100)
  expect(await graphCounts(page)).toEqual({ nodes: 2, links: 2, reroutes: 1 })
})

test('subgraph copy across tabs carries nested definitions and undoes atomically', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([{
      type: 'NestedPass', displayName: 'Nested Pass', category: 'test', source: 'v3', isOutputNode: false,
      items: [
        { kind: 'input', id: 'image', displayName: 'Source Image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
        { kind: 'output', id: 'result', displayName: 'Result Image', type: { kind: 'concrete', name: 'IMAGE' } },
      ],
    }])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'clipboard-subgraph-source', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'Source', nodes: { instance: { id: 'instance', type: '#outer', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
        outer: {
          id: 'outer', name: 'Outer', nodes: { nested: { id: 'nested', type: '#inner', values: {} } }, links: {}, nets: {}, reroutes: {},
          boundary: {
            inputs: [{ id: 'source', binds: { kind: 'port', node: 'nested', port: 'source' } }],
            outputs: [{ id: 'result', binds: { kind: 'port', node: 'nested', port: 'result' } }],
          }, nextOrdinal: 1,
        },
        inner: {
          id: 'inner', name: 'Inner', nodes: { pass: { id: 'pass', type: 'NestedPass', values: {} } }, links: {}, nets: {}, reroutes: {},
          boundary: {
            inputs: [{ id: 'source', binds: { kind: 'port', node: 'pass', port: 'image' } }],
            outputs: [{ id: 'result', binds: { kind: 'port', node: 'pass', port: 'result' } }],
          }, nextOrdinal: 1,
        },
      },
      view: { graphs: {
        g0: { nodes: { instance: { position: { x: 260, y: 220 } } } },
        outer: { nodes: { nested: { position: { x: 300, y: 220 } } } },
        inner: { nodes: { pass: { position: { x: 300, y: 220 } } } },
      } },
    }, 'Subgraph Source')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    window.__dinksterTest!.controller!.setSelection(['instance'])
  })
  await page.keyboard.press('Control+c')
  await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'clipboard-subgraph-target', root: 'g0',
    graphs: { g0: { id: 'g0', name: 'Target', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: { g0: { nodes: {} } } },
  }, 'Subgraph Target'))
  await page.mouse.move(620, 360)
  await page.keyboard.press('Control+v')

  const pastedState = () => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const node = Object.values(tab.store.doc.graphs.g0!.nodes)[0]
    if (node === undefined) return undefined
    const outerId = node.type.startsWith('#') ? node.type.slice(1) : ''
    const outer = tab.store.doc.graphs[outerId]
    const nested = outer === undefined ? undefined : Object.values(outer.nodes)[0]
    const innerId = nested?.type.startsWith('#') ? nested.type.slice(1) : ''
    const scene = (window.__dinksterTest!.renderer!.getScene().nodes as unknown as readonly {
      id: string
      missingSchema?: boolean
    }[]).find((candidate) => candidate.id === node.id)
    return {
      nodeId: node.id,
      outerId,
      innerId,
      graphCount: Object.keys(tab.store.doc.graphs).length,
      resolved: scene !== undefined && scene.missingSchema !== true,
    }
  })
  await expect.poll(pastedState).toMatchObject({ graphCount: 3, resolved: true })
  const pasted = await pastedState()
  if (pasted === undefined) throw new Error('pasted subgraph did not materialize')
  expect(pasted.outerId).not.toBe('')
  expect(pasted.innerId).not.toBe('')
  if (proofDir) await page.screenshot({ path: join(proofDir, 'cross-tab-subgraph-paste.png'), animations: 'disabled', fullPage: true })

  const point = await page.evaluate((nodeId) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  }, pasted.nodeId)
  await page.mouse.dblclick(point.x, point.y)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.graphStack.get().at(-1))).toBe(pasted.outerId)

  const nestedPoint = await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    const node = window.__dinksterTest!.renderer!.getScene().nodes[0]!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.dblclick(nestedPoint.x, nestedPoint.y)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.activeTab()!.graphStack.get().at(-1))).toBe(pasted.innerId)
  if (proofDir) await page.screenshot({ path: join(proofDir, 'cross-tab-nested-definition.png'), animations: 'disabled', fullPage: true })
  await page.getByTestId('graph-breadcrumb').locator('.crumb').first().click()

  await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return { nodes: Object.keys(doc.graphs.g0!.nodes).length, graphs: Object.keys(doc.graphs).length }
  })).toEqual({ nodes: 0, graphs: 1 })
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return { nodes: Object.keys(doc.graphs.g0!.nodes).length, graphs: Object.keys(doc.graphs).length }
  })).toEqual({ nodes: 1, graphs: 3 })

  await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    window.__dinksterTest!.controller!.setSelection([Object.keys(doc.graphs.g0!.nodes)[0]!])
  })
  await page.keyboard.press('Control+c')
  await page.keyboard.press('Control+v')
  await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return { nodes: Object.keys(doc.graphs.g0!.nodes).length, graphs: Object.keys(doc.graphs).length }
  })).toEqual({ nodes: 2, graphs: 3 })
})

test('clipboard shortcuts in a text widget remain native', async ({ page }) => {
  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'text')!
    const row = node.layout.rows.find((r) => r.kind === 'widget' && r.inputId === 'text')
    if (row === undefined) throw new Error(`text widget row missing: ${JSON.stringify(node.layout.rows)}`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + row.y + row.height / 2 }
  })
  await page.mouse.click(point.x, point.y)
  const input = page.getByTestId('widget-editor').locator('input')
  await input.fill('native')
  await input.press('Control+a')
  await input.press('Control+c')
  await input.press('End')
  await input.press('Control+v')
  await expect(input).toHaveValue('nativenative')
  await input.press('Control+a')
  await input.press('Control+x')
  await expect(input).toHaveValue('')
  await input.press('Control+v')
  await expect(input).toHaveValue('nativenative')
  expect(await graphCounts(page)).toEqual({ nodes: 3, links: 2, reroutes: 1 })
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes.text!.values.text)).toBe('unchanged')
})

test('node Copy and canvas Paste context menu round-trip at the invocation point', async ({ page }) => {
  await selectTopology(page)
  const previousIds = await page.evaluate(() =>
    Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes),
  )
  const nodePoint = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((n) => n.id === 'n0')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.click(nodePoint.x, nodePoint.y, { button: 'right' })
  await page.locator('[data-item-id="core.node.copy"]').click()
  await page.mouse.click(750, 650, { button: 'right' })
  await page.locator('[data-item-id="core.canvas.paste"]').click()
  await expect.poll(() => graphCounts(page)).toEqual({ nodes: 5, links: 4, reroutes: 2 })
  await expect.poll(() => page.evaluate(
    (ids) => window.__dinksterTest!.renderer!.getScene().nodes.filter((node) => !ids.includes(node.id)).length,
    previousIds,
  )).toBe(2)
  const anchored = await page.evaluate((before) => {
    const renderer = window.__dinksterTest!.renderer!
    const nodes = renderer.getScene().nodes.filter((node) => !before.includes(node.id))
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { minX: Math.min(...nodes.map((node) => node.x)), canvasLeft: rect.left }
  }, previousIds)
  expect(anchored.minX).toBeCloseTo(750 - anchored.canvasLeft, 0)
})
