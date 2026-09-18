import { expect, test, type Page } from './fixtures.js'

async function prepare(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1, epoch: 1, dinkster: { version: 'audit-s4', schemaWire: 21 }, nodes: {},
  } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get().length ?? 0)).toBe(1)
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

async function pinPoint(page: Page, nodeId: string, port: string, ghost = false): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, port, ghost }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === nodeId)!
    const pin = node.layout.pins.find((candidate) => ghost ? candidate.ghost === true : candidate.portId === port)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return {
      x: canvas.left + node.x + (pin.direction === 'out' ? node.layout.width : 0),
      y: canvas.top + node.y + pin.y,
    }
  }, { nodeId, port, ghost })
}

async function boundaryPinPoint(page: Page, portId: string): Promise<{ x: number; y: number }> {
  return page.evaluate((portId) => {
    const item = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((candidate) => candidate.side === 'inputs')!
    const pin = item.layout.pins.find((candidate) => candidate.portId === portId)!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: canvas.left + item.x + item.layout.width, y: canvas.top + item.y + pin.y }
  }, portId)
}

test('a refused occurrence drag shows gesture-site feedback and creates no link', async ({ page }) => {
  await prepare(page)
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
    test.setOccurrencePlanner?.({
      planOccurrenceLinkMutation: () => ({
        ok: false,
        diagnostics: [{
          severity: 'warning', origin: 'command', code: 'occurrence.link.planUnavailable',
          message: `Injected planner refused this occurrence mutation. ${'The requested route is unavailable at this gesture endpoint. '.repeat(30)}`,
        }],
      }),
    })
    test.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-occurrence', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: { s: { id: 's', type: '#sub', values: {}, dynamic: { forwarded: { members: ['s0'], seq: 1 } } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 },
        sub: {
          id: 'sub', name: 'sub',
          nodes: { p: { id: 'p', type: 'Producer', values: {} }, n: { id: 'n', type: 'Family', values: {}, dynamic: { items: { members: ['d0'], seq: 1 } } } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
          boundary: { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'n', port: 'items' } }], outputs: [] },
        },
      },
      view: { graphs: { g0: { nodes: { s: { position: { x: 200, y: 120 } } } }, sub: { nodes: { p: { position: { x: 100, y: 680 } }, n: { position: { x: 500, y: 640 } } } } } },
    }, 'audit occurrence')
    const tab = test.app.activeTab()!
    tab.graphStack.set(['g0', 'sub'])
    tab.instancePath.set(['s'])
    test.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await expect.poll(() => page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'n')
    return node?.layout.pins.filter((pin) => pin.familyOwner?.socketed === true).length ?? 0
  })).toBe(2)
  const from = await pinPoint(page, 'p', 'out')
  const to = await pinPoint(page, 'n', 'items', true)
  await drag(page, from, to)
  const toast = page.getByTestId('gesture-refusal-toast')
  await expect(toast).toBeVisible()
  await expect(toast).toHaveAttribute('role', 'alert')
  await expect(toast).toContainText('occurrence.link.planUnavailable')
  await expect(toast).toContainText('Injected planner refused this occurrence mutation.')
  const toastBox = await toast.boundingBox()
  expect(toastBox?.x).toBeCloseTo(to.x + 12, 0)
  expect(toastBox?.y).toBeCloseTo(Math.min(to.y + 12, 780), 0)
  expect(toastBox!.x).toBeGreaterThanOrEqual(0)
  expect(toastBox!.y).toBeGreaterThanOrEqual(0)
  expect(toastBox!.x + toastBox!.width).toBeLessThanOrEqual(1440)
  expect(toastBox!.y + toastBox!.height).toBeLessThanOrEqual(900)
  await expect(toast.getByRole('button', { name: 'Dismiss refusal message' })).toBeVisible()
  expect(await toast.locator('span').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
  await expect(page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.occurrenceTopologies ?? {}).reduce((count, topology) => count + Object.keys(topology.links).length, 0)
  })).resolves.toBe(0)

  await toast.getByRole('button', { name: 'Dismiss refusal message' }).click()
  await expect(toast).toBeHidden()
  await drag(page, from, to)
  await expect(toast).toBeVisible()
  await expect(toast).toBeHidden({ timeout: 5_000 })
})

test('a refused extract commit shows gesture-site feedback and mutates nothing', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'Target', displayName: 'Target', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'in', type: { kind: 'concrete', name: 'FLOAT' }, optional: true }],
      },
    ])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-extract', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: { target: { id: 'target', type: 'Target', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 },
      },
      view: { graphs: { g0: { nodes: { target: { position: { x: 400, y: 300 } } } } } },
    }, 'audit extract')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    const dispatchApp = app as unknown as {
      dispatchTo(tab: unknown, invocation: { readonly command: string }): unknown
    }
    const dispatchTo = dispatchApp.dispatchTo.bind(app)
    dispatchApp.dispatchTo = (tab, invocation) =>
      invocation.command === 'subgraph.extract'
        ? { ok: false, diagnostics: [{ severity: 'warning', origin: 'command', code: 'subgraph.extract.dispatchRefused', message: 'Injected dispatch refusal for the committed extraction.' }] }
        : dispatchTo(tab, invocation)
  })

  const point = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === 'target')!
    const canvas = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const x = canvas.left + node.x + node.layout.width / 2
    const y = canvas.top + node.y + node.layout.headerHeight / 2
    const covering = document.elementFromPoint(x, y)
    if (covering?.getAttribute('data-testid') !== 'graph-canvas') {
      throw new Error(`node header center (${x}, ${y}) is covered by ${covering?.tagName}[data-testid=${covering?.getAttribute('data-testid')}]`)
    }
    return { x, y }
  })
  await page.mouse.click(point.x, point.y)
  await expect.poll(() => page.evaluate(() =>
    (window.__dinksterTest!.app as unknown as { canvasBridge: { get(): { selectedNodes(): readonly string[] } } }).canvasBridge.get().selectedNodes(),
  )).toEqual(['target'])
  const graphsBefore = await page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).length)
  await page.keyboard.press('Control+Shift+E')
  const toast = page.getByTestId('gesture-refusal-toast')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('subgraph.extract.dispatchRefused')
  await expect(page.evaluate(() => Object.keys(window.__dinksterTest!.app.activeTab()!.store.doc.graphs).length)).resolves.toBe(graphsBefore)
})

test('repeated family-forwarding fan-out refusal stays one Problem and flashes each time', async ({ page }) => {
  await prepare(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.registerSchemas([
      {
        type: 'Family', displayName: 'Family', category: 'test', source: 'v3', isOutputNode: false,
        items: [{
          kind: 'input', id: 'items', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
          dynamic: { kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 }, template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'FLOAT' }, optional: true }] },
        }],
      },
      {
        type: 'Target', displayName: 'Target', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'input', id: 'in', type: { kind: 'concrete', name: 'FLOAT' }, optional: true }],
      },
    ])
    app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'audit-boundary', root: 'g0',
      graphs: {
        g0: { id: 'g0', name: 'root', nodes: { s: { id: 's', type: '#sub', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 },
        sub: {
          id: 'sub', name: 'sub', nodes: { family: { id: 'family', type: 'Family', values: {} }, target: { id: 'target', type: 'Target', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
          boundary: { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'family', port: 'items' } }], outputs: [] },
        },
      },
      view: { graphs: { g0: { nodes: { s: { position: { x: 200, y: 120 } } } }, sub: { nodes: { family: { position: { x: 500, y: 120 } }, target: { position: { x: 500, y: 360 } } } } } },
    }, 'audit boundary')
  })

  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    return 'status' in tab.store && tab.store.doc.lineage === 'audit-boundary'
  })).toBe(true)
  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['g0', 'sub'])
    tab.instancePath.set(['s'])
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  const from = await boundaryPinPoint(page, 'forwarded')
  const to = await pinPoint(page, 'target', 'in')
  const toastVisible: boolean[] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await drag(page, from, to)
    toastVisible.push(await page.getByTestId('gesture-refusal-toast').isVisible())
    if (attempt === 0) {
      await page.getByTestId('gesture-refusal-toast').getByRole('button', { name: 'Dismiss refusal message' }).click()
      await expect(page.getByTestId('gesture-refusal-toast')).toBeHidden()
    }
  }
  await expect(page.locator('.problem summary', { hasText: 'boundary.bindKind' })).toHaveCount(1)
  expect(toastVisible).toEqual([true, true])
  await expect(page.getByTestId('gesture-refusal-toast')).toContainText('boundary.bindKind')
})
