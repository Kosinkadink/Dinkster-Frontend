import { expect, nativeTest as test, waitForStartupOwnership, type Page } from './fixtures.js'

const NATIVE_BACKEND = process.env['DINKSTER_NATIVE_BACKEND'] ?? 'http://127.0.0.1:8765'

type DynamicState = Record<string, {
  readonly selected?: string
  readonly members?: readonly string[]
  readonly seq?: number
}>

// Node types whose live body holds a group; the reference-multi-latent image
// group is optional and stores no member on a new node.
const groupNodeTypes = [
  'dinkster.image.batch_images_node',
  'dinkster.latent.batch_latents_node',
  'dinkster.image.batch_masks_node',
  'dinkster.utilities.comfy_and_node',
  'dinkster.utilities.comfy_or_node',
  'dinkster.utilities.comfy_math_expression',
  'dinkster.video.concatenate_video',
  'dinkster.utilities.create_list',
  'dinkster.image.glsl_shader',
  'dinkster.3d.merge_meshes',
  'dinkster.3d.merge_splat',
  'dinkster.conditioning.reference_multi_latent',
  'dinkster.misc.models.text_encode_moss_image_edit',
]

interface BodyRowJson {
  readonly kind: string
  readonly id?: string
  readonly rows?: readonly BodyRowJson[]
  readonly member?: readonly BodyRowJson[]
  readonly value?: BodyRowJson
  readonly keys?:
    | { readonly kind: 'numbered'; readonly prefix: string; readonly start: number; readonly pad: number }
    | { readonly kind: 'named'; readonly names: readonly string[] }
  readonly grows?: unknown
  readonly minMembers?: number
  readonly maxMembers?: number
  readonly options?: readonly { readonly key: string; readonly rows: readonly BodyRowJson[] }[]
  readonly shared?: readonly BodyRowJson[]
  readonly required?: boolean
  readonly default?: string
  readonly leader?: string
}

/**
 * The dynamic state a new node must store: a group that grows by hand keeps
 * its first `minMembers` keys (numbered keys also keep the counter), and a
 * required choice keeps the option it starts on; both are followed down the
 * stored members and the chosen option.
 */
function requiredState(
  rows: readonly BodyRowJson[],
  prefix = '',
  result: DynamicState = {},
  shared: readonly BodyRowJson[] = [],
): DynamicState {
  for (const raw of rows) {
    if (raw.kind === 'section' || raw.kind === 'row') {
      requiredState(raw.rows ?? [], prefix, result, shared)
      continue
    }
    const row = raw.kind === 'use' ? shared.find((candidate) => candidate.id === raw.id) : raw
    if (row === undefined) continue
    const path = `${prefix}${row.id}`
    if (row.kind === 'group' && typeof row.grows === 'string' && (row.minMembers ?? 0) > 0 && row.keys !== undefined) {
      const keys = row.keys
      const count = Math.min(row.minMembers!, row.maxMembers ?? Infinity, keys.kind === 'named' ? keys.names.length : Infinity)
      const members = Array.from({ length: count }, (_, index) => keys.kind === 'named'
        ? keys.names[index]!
        : `${keys.prefix}${String(keys.start + index).padStart(keys.pad, '0')}`)
      result[path] = { members, ...(keys.kind === 'numbered' ? { seq: count } : {}) }
      if (row.member !== undefined) for (const key of members) requiredState(row.member, `${path}.${key}.`, result)
    } else if (row.kind === 'choice' && row.leader === undefined && row.required !== false && row.options !== undefined) {
      const option = row.options.find((candidate) => candidate.key === (row.default ?? row.options![0]?.key))
      if (option === undefined) continue
      result[path] = { selected: option.key }
      requiredState(option.rows, `${path}.`, result, row.shared ?? [])
    }
  }
  return result
}

async function openBlank(page: Page, lineage: string): Promise<void> {
  await page.evaluate(async (lineage) => {
    await window.__dinksterTest!.app.openDocument({
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
  await waitForStartupOwnership(page)
})

test('every live group node persists minimums and reloads with a growth target', async ({ page }) => {
  const familyNodeTypes = await page.evaluate(() => {
    const registry = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!
    type Row = { kind?: string; rows?: readonly Row[]; member?: readonly Row[]; options?: readonly { rows: readonly Row[] }[]; shared?: readonly Row[] }
    const hasGroup = (rows: readonly Row[]): boolean => rows.some((row) =>
      row.kind === 'group' ||
      ((row.kind === 'section' || row.kind === 'row' || row.kind === 'typeChoice') && hasGroup(row.rows ?? [])) ||
      (row.kind === 'choice' && (hasGroup(row.shared ?? []) || row.options?.some((option) => hasGroup(option.rows)) === true)))
    return [...registry.schemas].flatMap(([type, schema]) =>
      hasGroup((schema as { readonly body: readonly Row[] }).body) ? [type] : [])
  })
  expect(familyNodeTypes.length).toBeGreaterThan(0)
  expect(familyNodeTypes).toEqual(expect.arrayContaining(groupNodeTypes))

  for (const type of familyNodeTypes) {
    await openBlank(page, `fresh-${type}`)
    const nodeId = await placeFromPalette(page, type, { x: 700, y: 500 })
    const result = await page.evaluate(({ nodeId, type }) => {
      const scene = window.__dinksterTest!.renderer!.getScene()
      const node = scene.nodes.find((candidate) => candidate.id === nodeId)!
      const doc = window.__dinksterTest!.app.activeTab()!.store.doc
      const stored = doc.graphs[doc.root]!.nodes[nodeId]!
      const schema = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!.schemas.get(type)! as {
        readonly body: readonly unknown[]
      }
      return {
        dynamic: stored.dynamic ?? {},
        schemaBody: schema.body,
        hasGrowthTarget:
          node.layout.pins.some((pin) => pin.ghost === true) ||
          node.layout.rows.some((row) => row.kind === 'growth'),
        underMinimum: scene.diagnostics
          .filter((diagnostic) => diagnostic.code === 'elab.autogrow.underMin')
          .map((diagnostic) => diagnostic.message),
      }
    }, { nodeId, type })
    const required = requiredState(result.schemaBody as BodyRowJson[])
    // A new node stores exactly that state: an optional group stores no member.
    expect(result.dynamic, type).toEqual(required)
    // These nodes hold only the hidden dependencies group in loops.py.
    const visibleGrowth = ![
      'dinkster.utilities.loop_iteration',
      'dinkster.utilities.loop_progress',
      'dinkster.utilities.loop_result',
    ].includes(type)
    expect(result.hasGrowthTarget, type).toBe(visibleGrowth)
    expect(result.underMinimum, type).toEqual([])

    await page.evaluate(async ({ type }) => {
      const app = window.__dinksterTest!.app
      await app.openDocument(structuredClone(app.activeTab()!.store.doc), `reloaded-${type}`)
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
    expect(reloaded.dynamic, `${type}:reload`).toEqual(required)
    expect(reloaded.hasGrowthTarget, `${type}:reload`).toBe(visibleGrowth)
    expect(reloaded.underMinimum, `${type}:reload`).toEqual([])
  }
})

test('Math Expression keeps named inputs ordered through growth and compaction', async ({ page }, testInfo) => {
  await openBlank(page, 'math-family-link-drop')
  const sourceId = await placeFromPalette(page, 'dinkster.utilities.primitive_float', { x: 300, y: 300 })
  const source = await pinPoint(page, sourceId, 'out', 'FLOAT')
  await drag(page, source, { x: 800, y: 500 })
  await expect(page.getByTestId('node-palette')).toBeVisible()
  await page.getByTestId('palette-search').fill('dinkster.utilities.comfy_math_expression')
  await page.locator('[data-node-type="dinkster.utilities.comfy_math_expression"]').getByRole('option').click()

  const mathId = await expect.poll(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.graphs.g0!.nodes).find((node) => node.type === 'dinkster.utilities.comfy_math_expression')?.id
  })).not.toBeUndefined().then(() => page.evaluate(() => {
    const doc = window.__dinksterTest!.app.activeTab()!.store.doc
    return Object.values(doc.graphs.g0!.nodes).find((node) => node.type === 'dinkster.utilities.comfy_math_expression')!.id
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

  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.openDocument(structuredClone(app.activeTab()!.store.doc), 'Reloaded Math family')
  })
  await expect.poll(() => page.evaluate(() => 'status' in window.__dinksterTest!.app.activeTab()!.store)).toBe(true)
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
    { input: 'values.a', output: 'FLOAT' },
    { input: 'values.b', output: 'INT' },
    { input: 'values.c', output: 'BOOL' },
  ])

  const preserved = await page.evaluate(async (mathId) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const graph = tab.store.doc.graphs.g0!
    const aLink = Object.entries(graph.links).find(([, link]) => 'node' in link.to && link.to.port === 'values.a')!
    const bLink = Object.entries(graph.links).find(([, link]) => 'node' in link.to && link.to.port === 'values.b')!
    const value = await app.dispatchTo(tab, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: mathId, inputId: 'values.b', value: 2.5 },
    })
    const disconnect = await app.dispatchTo(tab, {
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
      { port: 'values.a', ghost: false },
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
      { port: 'values.a', ghost: false },
      { port: 'values.b', ghost: false },
      { port: 'values.c', ghost: true },
    ],
  })
})
