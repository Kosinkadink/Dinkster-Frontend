import { expect, test, type Page } from '@playwright/test'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

type DynamicState = Record<string, {
  readonly selected?: string
  readonly members?: readonly string[]
  readonly seq?: number
}>

type Wire15Input = {
  readonly kind: string
  readonly id: string
  readonly dynamic?: {
    readonly kind: string
    readonly materialization?: string
    readonly template?: readonly Wire15Input[]
    readonly naming?:
      | { readonly kind: 'prefix'; readonly min?: number }
      | { readonly kind: 'names'; readonly names: readonly string[]; readonly min?: number }
      | { readonly kind: 'native' }
    readonly options?: readonly { readonly key: string; readonly inputs: readonly Wire15Input[] }[]
  }
}

function requiredWire15State(
  items: readonly Wire15Input[],
  prefix = '',
  result: DynamicState = {},
): DynamicState {
  for (const item of items) {
    if (item.kind !== 'input') continue
    const dynamic = item.dynamic
    const construct = prefix === '' ? item.id : `${prefix}.${item.id}`
    if (
      dynamic?.kind === 'autogrow' &&
      dynamic.materialization === 'wire15' &&
      dynamic.naming !== undefined &&
      dynamic.template !== undefined
    ) {
      if (dynamic.naming.kind === 'native') continue
      const min = dynamic.naming.min ?? 0
      if (min === 0) continue
      const members = dynamic.naming.kind === 'names'
        ? dynamic.naming.names.slice(0, min)
        : Array.from({ length: min }, (_, index) => `m${index}`)
      result[construct] = {
        members,
        ...(dynamic.naming.kind === 'prefix' ? { seq: min } : {}),
      }
      for (const member of members) requiredWire15State(dynamic.template, `${construct}.${member}`, result)
      continue
    }
    if (
      dynamic?.kind !== 'dynamicCombo' ||
      dynamic.materialization !== 'wire15' ||
      dynamic.options === undefined
    ) continue
    const option = dynamic.options[0]
    if (option === undefined) continue
    result[construct] = { selected: option.key }
    requiredWire15State(option.inputs, construct, result)
  }
  return result
}

async function openBlank(page: Page, lineage: string): Promise<void> {
  await page.evaluate((lineage) => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage, root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        },
      },
      view: { graphs: { g0: { nodes: {} } } },
    }, lineage)
  }, lineage)
  await expect.poll(() => page.evaluate((lineage) => {
    const tab = window.__dinksterTest!.app.activeTab()
    return tab !== undefined && 'status' in tab.store && tab.store.doc.lineage === lineage
  }, lineage)).toBe(true)
  await page.evaluate(() => window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 }))
}

async function placeFromPalette(
  page: Page,
  type: string,
  point: { x: number; y: number },
): Promise<string> {
  const before = await page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(doc.graphs[doc.root]!.nodes)
  })
  await page.mouse.dblclick(point.x, point.y)
  await page.getByTestId('palette-search').fill(type)
  const option = page.locator(`[data-node-type="${type}"]`).getByRole('option')
  await expect(option).toBeVisible()
  await option.click()
  await page.mouse.click(point.x, point.y)
  return expect.poll(() => page.evaluate((oldIds) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(doc.graphs[doc.root]!.nodes).find((id) => !oldIds.includes(id))
  }, before)).not.toBeUndefined().then(() => page.evaluate((oldIds) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.keys(doc.graphs[doc.root]!.nodes).find((id) => !oldIds.includes(id))!
  }, before))
}

async function pinPoint(
  page: Page,
  nodeId: string,
  direction: 'in' | 'out',
  portId: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate(({ nodeId, direction, portId }) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === nodeId)
    const pin = node?.layout.pins.find((candidate) =>
      candidate.direction === direction && candidate.portId === portId)
    if (!node || !pin) throw new Error(`missing ${direction} pin ${nodeId}:${portId}`)
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: rect.left + (node.x + (direction === 'in' ? 0 : node.layout.width)) * viewport.scale + viewport.x,
      y: rect.top + (node.y + pin.y) * viewport.scale + viewport.y,
    }
  }, { nodeId, direction, portId })
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

test.beforeEach(async ({ page, request }) => {
  test.skip(process.env['DINKSTER_NATIVE_BACKEND'] === undefined,
    'set DINKSTER_NATIVE_BACKEND so the Vite same-origin proxy targets the native backend')
  const direct = await fetch(`${NATIVE_BACKEND}/api/nodes`, { signal: AbortSignal.timeout(3000) })
  test.skip(!direct.ok, `native backend is unavailable at ${NATIVE_BACKEND}`)
  const sameOrigin = await request.get('/api/nodes')
  expect(sameOrigin.ok()).toBe(true)

  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await expect(page.getByTestId('status-bar')).toContainText('connected')
})

test('every live wire-15 family node persists minimums and reloads with a growth target', async ({ page }) => {
  const familyNodeTypes = await page.evaluate(() => {
    const registry = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!
    const hasAutogrow = (items: readonly unknown[]): boolean => items.some((value) => {
      if (typeof value !== 'object' || value === null) return false
      const item = value as { kind?: string; dynamic?: { kind?: string; template?: readonly unknown[]; options?: readonly { inputs?: readonly unknown[] }[] } }
      if (item.kind !== 'input' || item.dynamic === undefined) return false
      if (item.dynamic.kind === 'autogrow') return true
      return (item.dynamic.template !== undefined && hasAutogrow(item.dynamic.template)) ||
        item.dynamic.options?.some((option) => option.inputs !== undefined && hasAutogrow(option.inputs)) === true
    })
    return [...registry.schemas].flatMap(([type, schema]) =>
      hasAutogrow((schema as { readonly items: readonly unknown[] }).items) ? [type] : [])
  })
  expect(familyNodeTypes.length).toBeGreaterThan(0)

  for (const type of familyNodeTypes) {
    await openBlank(page, `fresh-${type}`)
    const nodeId = await placeFromPalette(page, type, { x: 700, y: 500 })
    const result = await page.evaluate(({ nodeId, type }) => {
      const scene = window.__dinksterTest!.renderer!.getScene()
      const node = scene.nodes.find((candidate) => candidate.id === nodeId)!
      const doc = window.__dinksterTest!.app.activeTab()!.store.doc
      const stored = doc.graphs[doc.root]!.nodes[nodeId]!
      const schema = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!.schemas.get(type)! as {
        readonly items: readonly unknown[]
      }
      return {
        dynamic: stored.dynamic ?? {},
        schemaItems: schema.items,
        hasGrowthTarget:
          node.layout.pins.some((pin) => pin.ghost === true) ||
          node.layout.rows.some((row) => row.kind === 'growth'),
        underMinimum: scene.diagnostics
          .filter((diagnostic) => diagnostic.code === 'elab.autogrow.underMin')
          .map((diagnostic) => diagnostic.message),
      }
    }, { nodeId, type })
    const required = requiredWire15State(result.schemaItems as Wire15Input[])
    for (const [construct, state] of Object.entries(required)) {
      expect(result.dynamic[construct], `${type}:${construct}`).toEqual(state)
    }
    expect(result.hasGrowthTarget, type).toBe(true)
    expect(result.underMinimum, type).toEqual([])

    await page.evaluate(({ type }) => {
      const app = window.__dinksterTest!.app
      app.openDocument(structuredClone(app.activeTab()!.store.doc), `reloaded-${type}`)
    }, { type })
    await expect.poll(() => page.evaluate((nodeId) => {
      const tab = window.__dinksterTest!.app.activeTab()
      return tab !== undefined && 'status' in tab.store &&
        tab.store.doc.graphs[tab.store.doc.root]!.nodes[nodeId] !== undefined &&
        window.__dinksterTest!.renderer!.getScene().nodes.some((node) => node.id === nodeId)
    }, nodeId)).toBe(true)
    const reloaded = await page.evaluate(({ nodeId }) => {
      const app = window.__dinksterTest!.app
      const scene = window.__dinksterTest!.renderer!.getScene()
      const node = scene.nodes.find((candidate) => candidate.id === nodeId)!
      const doc = app.activeTab()!.store.doc
      return {
        dynamic: doc.graphs[doc.root]!.nodes[nodeId]!.dynamic ?? {},
        hasGrowthTarget:
          node.layout.pins.some((pin) => pin.ghost === true) ||
          node.layout.rows.some((row) => row.kind === 'growth'),
        underMinimum: scene.diagnostics
          .filter((diagnostic) => diagnostic.code === 'elab.autogrow.underMin')
          .map((diagnostic) => diagnostic.message),
      }
    }, { nodeId })
    for (const [construct, state] of Object.entries(required)) {
      expect(reloaded.dynamic[construct], `${type}:${construct}:reload`).toEqual(state)
    }
    expect(reloaded.hasGrowthTarget, `${type}:reload`).toBe(true)
    expect(reloaded.underMinimum, `${type}:reload`).toEqual([])
  }
})

test('Math Expression keeps named inputs ordered through growth and compaction', async ({ page }, testInfo) => {
  await openBlank(page, 'math-family-link-drop')
  const sourceId = await placeFromPalette(page, 'dinkster.float', { x: 300, y: 300 })
  const source = await pinPoint(page, sourceId, 'out', 'value')
  await drag(page, source, { x: 800, y: 500 })
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await page.getByTestId('palette-search').fill('dinkster.math.expression')
  await page.locator('[data-node-type="dinkster.math.expression"]').getByRole('option').click()

  const mathId = await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.graphs.g0!.nodes).find((node) => node.type === 'dinkster.math.expression')?.id
  })).not.toBeUndefined().then(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.graphs.g0!.nodes).find((node) => node.type === 'dinkster.math.expression')!.id
  }))

  let state = await page.evaluate((mathId) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const graph = doc.graphs.g0!
    return {
      members: graph.nodes[mathId]!.dynamic?.values?.members,
      targets: Object.values(graph.links).map((link) => 'node' in link.to ? link.to.port : undefined),
    }
  }, mathId)
  expect(state).toEqual({ members: ['a'], targets: ['values.a'] })

  const next = await pinPoint(page, mathId, 'in', 'values.b')
  await drag(page, source, next)
  state = await page.evaluate((mathId) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const graph = doc.graphs.g0!
    return {
      members: graph.nodes[mathId]!.dynamic?.values?.members,
      targets: Object.values(graph.links).map((link) => 'node' in link.to ? link.to.port : undefined).sort(),
    }
  }, mathId)
  expect(state).toEqual({ members: ['a', 'b'], targets: ['values.a', 'values.b'] })

  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    app.openDocument(structuredClone(app.activeTab()!.store.doc), 'Reloaded Math family')
  })
  const reloaded = await page.evaluate((mathId) => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === mathId)!
    return {
      members: doc.graphs.g0!.nodes[mathId]!.dynamic?.values?.members,
      inputs: node.layout.pins.filter((pin) => pin.direction === 'in')
        .map((pin) => ({ port: pin.portId, ghost: pin.ghost ?? false })),
      valueWidgets: node.layout.rows.filter((row) =>
        row.kind === 'widget' && row.inputId?.startsWith('values.') === true,
      ).map((row) => row.inputId!),
      pairedRows: node.layout.rows.filter((row) => row.kind === 'ports').map((row) => ({
        input: row.input?.portId,
        output: row.output?.portId,
      })),
    }
  }, mathId)
  expect(reloaded.members).toEqual(['a', 'b'])
  expect(reloaded.inputs).toEqual(expect.arrayContaining([
    { port: 'values.a', ghost: false },
    { port: 'values.b', ghost: false },
    { port: 'values.c', ghost: true },
  ]))
  expect(reloaded.valueWidgets).toEqual([])
  expect(reloaded.pairedRows).toEqual([
    { input: 'values.a', output: 'float' },
    { input: 'values.b', output: 'int' },
    { input: 'values.c', output: 'boolean' },
  ])

  const preserved = await page.evaluate((mathId) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    const aLink = Object.entries(graph.links).find(([, link]) => 'node' in link.to && link.to.port === 'values.a')!
    const bLink = Object.entries(graph.links).find(([, link]) => 'node' in link.to && link.to.port === 'values.b')!
    const value = tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: mathId, inputId: 'values.b', value: 2.5 },
    })
    const disconnect = tab.store.dispatch({
      command: 'link.disconnect', params: { graphId: 'g0', linkId: aLink[0] },
    })
    if (!value.ok || !disconnect.ok) throw new Error('Math Expression compaction setup failed')
    return { bLinkId: bLink[0] }
  }, mathId)

  const header = await page.evaluate((mathId) => {
    const renderer = window.__dinksterTest!.renderer!
    const node = renderer.getScene().nodes.find((candidate) => candidate.id === mathId)!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    const viewport = renderer.getViewport()
    return {
      x: rect.left + (node.x + node.layout.width / 2) * viewport.scale + viewport.x,
      y: rect.top + (node.y + node.layout.headerHeight / 2) * viewport.scale + viewport.y,
    }
  }, mathId)
  await page.mouse.click(header.x, header.y, { button: 'right' })
  await page.locator('[data-testid=context-menu-item][data-item-id="core.node.compactDynamic"]').click()

  const compactedState = async () => page.evaluate((mathId) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((candidate) => candidate.id === mathId)!
    return {
      members: graph.nodes[mathId]!.dynamic?.values?.members,
      value: graph.nodes[mathId]!.values['values.b'],
      links: Object.entries(graph.links).map(([id, link]) => ({
        id,
        target: 'node' in link.to ? link.to.port : undefined,
      })),
      inputs: node.layout.pins
        .filter((pin) => pin.direction === 'in' && pin.portId.startsWith('values.'))
        .map((pin) => ({ port: pin.portId, ghost: pin.ghost ?? false })),
    }
  }, mathId)
  await expect.poll(compactedState).toEqual({
    members: ['b'],
    value: 2.5,
    links: [{ id: preserved.bLinkId, target: 'values.b' }],
    inputs: [
      { port: 'values.b', ghost: false },
      { port: 'values.c', ghost: true },
    ],
  })
  const minimapToggle = page.getByTestId('minimap-toggle')
  if (await minimapToggle.getAttribute('aria-pressed') === 'true') await minimapToggle.click()
  const screenshot = testInfo.outputPath('math-expression-ordered-after-compaction.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('math-expression-ordered-after-compaction', {
    path: screenshot, contentType: 'image/png',
  })

  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.undo())).toBe(true)
  await expect.poll(() => page.evaluate((mathId) =>
    window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!.nodes[mathId]!.dynamic?.values?.members,
  mathId)).toEqual(['a', 'b'])
  expect(await page.evaluate(() => window.__dinksterTest!.app.activeTab()!.store.redo())).toBe(true)
  await expect.poll(compactedState).toEqual({
    members: ['b'],
    value: 2.5,
    links: [{ id: preserved.bLinkId, target: 'values.b' }],
    inputs: [
      { port: 'values.b', ghost: false },
      { port: 'values.c', ghost: true },
    ],
  })
})
