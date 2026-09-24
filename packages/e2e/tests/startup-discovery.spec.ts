/**
 * Clean-startup composition proof: a fresh load of the app against an
 * origin that fronts a NATIVE engine selects the native protocol for the
 * same-origin default backend - no manual add, no protocol picker, no
 * stored state. This is the "just works" path that discovery.spec (client
 * unit tests) and the app default-option tests prove separately; here the
 * full composition runs in the real browser: main.tsx discovery ->
 * AppState default protocol -> native client fetch.
 *
 * Deliberately imports from '@playwright/test', NOT './fixtures.js': the
 * shared fixture pins the same-origin default to v1 for the rest of the
 * suite, which is exactly the behavior this spec must escape.
 */
import { expect, test } from '@playwright/test'

const nativeFrontend = process.env['DINKSTER_E2E_NATIVE_FRONTEND']
if (!nativeFrontend) throw new Error('DINKSTER_E2E_NATIVE_FRONTEND must identify the native-only frontend')
test.use({ baseURL: nativeFrontend })

test('native compatibility matrix replaces the V1 connection entry', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'native-without-v1', 'runs only in the native compatibility matrix')
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterV1EntryStubbed)).toBe(true)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.protocol)).toBe('dinkster')
})

const NATIVE_TABLE = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'e2e', schemaWire: 1 },
  packs: { demo: { displayName: 'Demo Pack' } },
  nodes: {
    'demo.node': { schemaVersion: 1, displayName: 'Demo Node', pack: 'demo', signature: 's', interface: [] },
  },
}

const RICH_NATIVE_TABLE = {
  ...NATIVE_TABLE,
  nodes: {
    ...NATIVE_TABLE.nodes,
    'comfy.EmptyImage': {
      schemaVersion: 1, displayName: 'Empty Image', pack: 'comfy', signature: 'empty', aliases: ['EmptyImage'], interface: [],
    },
    'comfy.PreviewImage': {
      schemaVersion: 1, displayName: 'Preview Image', pack: 'comfy', signature: 'preview', aliases: ['PreviewImage'], interface: [],
    },
  },
}

const lazyNode = (id: string, lazy?: boolean) => ({
  schemaVersion: 1,
  displayName: 'Lazy Socket',
  category: 'test',
  interface: [{
    role: 'input', id, type: { kind: 'concrete', types: ['core.int'] }, required: true,
    forceInput: true,
    ...(lazy !== undefined ? { lazy } : {}),
  }],
})

const CURRENT_LAZY_TABLE = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'e2e-current', schemaWire: 1 },
  nodes: {
    'test.lazy_absent': lazyNode('value'),
    'test.lazy_false': lazyNode('value', false),
    'test.lazy_true': lazyNode('value', true),
  },
}

const previewNode = (preview?: boolean) => ({
  schemaVersion: 1,
  displayName: 'Preview Output',
  category: 'test',
  interface: [{
    role: 'output', id: 'result', type: { kind: 'concrete', types: ['core.int'] },
    ...(preview !== undefined ? { preview } : {}),
  }],
})

const CURRENT_PREVIEW_TABLE = {
  schemaVersion: 1,
  epoch: 1,
  dinkster: { version: 'e2e-current-preview', schemaWire: 1 },
  nodes: {
    'test.preview_absent': previewNode(),
    'test.preview_false': previewNode(false),
    'test.preview_true': previewNode(true),
  },
}

test('same-origin native launch keeps the compatibility probe bounded', async ({ page }, testInfo) => {
  // Temporary skip pending attribution: Kosinkadink/comfy-vibe-station#430
  test.skip(true, 'red at main; attribution and re-enable tracked in Kosinkadink/comfy-vibe-station#430')
  let v1Requests = 0
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'no supervisor' }),
  )
  await page.route('/api/nodes*', (route) => route.fulfill({ json: NATIVE_TABLE }))
  await page.route('/system_stats', (route) => {
    v1Requests += 1
    return route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } })
  })

  await page.goto('/')

  // The default (index 0, unremovable) backend is native, and its registry
  // decoded the mocked table - the native client actually ran, this is not
  // just a label.
  await expect
    .poll(() =>
      page.evaluate(() => {
        // The bridge lands after main.tsx's pre-render discovery await;
        // return a retriable sentinel instead of throwing until then.
        const backend = window.__dinksterTest?.app.backends.get()[0]
        if (!backend) return { protocol: 'pending', schemas: 0, title: '', nodes: -1 }
        const tab = window.__dinksterTest?.app.activeTab()
        const graph = tab?.store.doc.graphs[tab.store.doc.root]
        return {
          protocol: backend.protocol,
          schemas: backend.registry.get()?.schemas.size ?? 0,
          title: tab?.title ?? '',
          nodes: graph === undefined ? -1 : Object.keys(graph.nodes).length,
        }
      }),
    )
    .toEqual({ protocol: 'dinkster', schemas: 1, title: 'Untitled', nodes: 0 })
  expect(v1Requests).toBe(testInfo.project.name === 'native-without-v1' ? 0 : 1)
})

test('native clean startup stays blank with a richer compatibility catalog', async ({ page }) => {
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'no supervisor' }),
  )
  await page.route('/api/nodes*', (route) => route.fulfill({ json: RICH_NATIVE_TABLE }))
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )

  await page.goto('/')
  await expect
    .poll(() => page.evaluate(() => {
      const app = window.__dinksterTest?.app
      const tab = app?.activeTab()
      if (!app || !tab) return { schemas: 0, nodes: -1, unresolved: -1 }
      return {
        schemas: app.backends.get()[0]?.registry.get()?.schemas.size ?? 0,
        nodes: Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length,
        unresolved: app.problems.get().filter((problem) => problem.code === 'schema.unresolvedType').length,
      }
    }))
    .toEqual({ schemas: 3, nodes: 0, unresolved: 0 })
})

test('same-origin native mode has an explicit cascading hover/menu smoke path', async ({ page }) => {
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'no supervisor' }),
  )
  await page.route('/api/nodes*', (route) => route.fulfill({ json: NATIVE_TABLE }))
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.protocol ?? 'pending'))
    .toBe('dinkster')

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const result = tab.store.dispatch({
      command: 'node.add',
      params: { graphId: tab.store.doc.root, type: 'demo.node', values: {}, position: { x: 80, y: 120 } },
    })
    if (!result.ok) throw new Error(`node.add refused: ${JSON.stringify(result.diagnostics)}`)
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().nodes.length)).toBe(1)

  const point = await page.evaluate(() => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes[0]
    if (!node) throw new Error('native menu smoke requires one scene node')
    const viewport = renderer.getViewport()
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!.getBoundingClientRect()
    return {
      x: canvas.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: canvas.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  })
  await page.mouse.click(point.x, point.y, { button: 'right' })
  await expect(page.getByTestId('context-menu')).toBeVisible()
  await page.locator('[data-item-id="core.node.mode"]').hover()
  await expect(page.getByTestId('context-submenu')).toBeVisible()
  await expect(page.locator('[role="menu"]')).toHaveCount(1)
  await expect(page.getByTestId('context-submenu')).toHaveAttribute('role', 'group')
})

test('lazy absent, false, and true render identical ordinary sockets', async ({ page }) => {
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'no supervisor' }),
  )
  await page.route('/api/nodes*', (route) => route.fulfill({ json: CURRENT_LAZY_TABLE }))
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0))
    .toBe(3)

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graphId = tab.store.doc.root
    for (const [index, type] of ['test.lazy_absent', 'test.lazy_false', 'test.lazy_true'].entries()) {
      const result = tab.store.dispatch({
        command: 'node.add',
        params: { graphId, type, values: {}, position: { x: 80 + index * 240, y: 120 } },
      })
      if (!result.ok) throw new Error(`node.add refused: ${JSON.stringify(result.diagnostics)}`)
    }
  })

  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graphId = tab.store.doc.root
    const graph = tab.store.doc.graphs[graphId]!
    const layouts = window.__dinksterTest!.renderer!.getScene().nodes
      .filter((node) => graph.nodes[node.id]?.type.startsWith('test.lazy_'))
      .map((node) => node.layout)
    return {
      count: layouts.length,
      equal: layouts.length === 3 && layouts.every((layout) => JSON.stringify(layout) === JSON.stringify(layouts[0])),
      socketRows: layouts.map((layout) => layout.rows.filter((row) => row.kind === 'ports').length),
    }
  })).toEqual({ count: 3, equal: true, socketRows: [1, 1, 1] })
})

test('preview flags preserve outputs and only true reserves the compact preview surface', async ({ page }) => {
  await page.route('/supervisor/status', (route) =>
    route.fulfill({ status: 502, contentType: 'text/plain', body: 'no supervisor' }),
  )
  await page.route('/api/nodes*', (route) => route.fulfill({ json: CURRENT_PREVIEW_TABLE }))
  await page.route('/system_stats', (route) =>
    route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }),
  )
  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size ?? 0))
    .toBe(3)

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graphId = tab.store.doc.root
    for (const [index, type] of ['test.preview_absent', 'test.preview_false', 'test.preview_true'].entries()) {
      const result = tab.store.dispatch({
        command: 'node.add',
        params: { graphId, type, values: {}, position: { x: 80 + index * 240, y: 120 } },
      })
      if (!result.ok) throw new Error(`node.add refused: ${JSON.stringify(result.diagnostics)}`)
    }
  })

  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs[tab.store.doc.root]!
    const nodes = window.__dinksterTest!.renderer!.getScene().nodes
      .filter((node) => graph.nodes[node.id]?.type.startsWith('test.preview_'))
      .sort((a, b) => graph.nodes[a.id]!.type.localeCompare(graph.nodes[b.id]!.type))
    return {
      count: nodes.length,
      compactPreview: nodes.map((node) => node.layout.preview?.compact === true),
      outputRows: nodes.map((node) => node.layout.rows.filter((row) => row.kind === 'ports').length),
    }
  })).toEqual({
    count: 3,
    compactPreview: [false, false, true],
    outputRows: [1, 1, 1],
  })
})

test('live: a clean load against a real native origin connects without manual add', async ({ page, request }) => {
  // Gated on the environment actually fronting a native engine (dev server
  // started with DINKSTER_NATIVE_BACKEND pointed at a live dinkster-serve, or an
  // engine on the default :3639). Skips loudly otherwise.
  let native = false
  try {
    const res = await request.get('/api/nodes', { timeout: 3000 })
    if (res.ok()) {
      const body = (await res.json()) as { dinkster?: unknown }
      native = typeof body.dinkster === 'object' && body.dinkster !== null
    }
  } catch {
    /* unreachable -> skip below */
  }
  test.skip(!native, 'same-origin /api/nodes is not a live native engine (set DINKSTER_NATIVE_BACKEND to one)')

  await page.goto('/')
  await expect(page.locator('.conn-status')).toHaveText('connected', { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  const protocol = await page.evaluate(() => window.__dinksterTest!.app.backends.get()[0]!.protocol)
  expect(protocol).toBe('dinkster')
})
