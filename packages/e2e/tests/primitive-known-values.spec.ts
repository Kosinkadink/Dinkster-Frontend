import { expect, nativeTest as test, type Page } from './fixtures.js'

const concrete = (type: string) => ({ kind: 'concrete', types: [type] })

const primitiveSchema = (
  nodeType: string,
  displayName: string,
  type: string,
  defaultValue: string | number | boolean,
  widget?: Record<string, unknown>,
) => ({
  schemaVersion: 2,
  nodeType,
  displayName,
  category: 'test/primitives',
  idempotent: true,
  body: [
    {
      kind: 'input',
      id: 'source',
      type: concrete(type),
      required: false,
      default: defaultValue,
      ...(widget === undefined ? {} : { widget }),
    },
    {
      kind: 'output',
      id: 'result',
      type: concrete(type),
      knownValue: { input: 'source' },
    },
  ],
})

const sinkSchema = {
  schemaVersion: 2,
  nodeType: 'e2e.known-value-sink',
  displayName: 'Known value results',
  category: 'test',
  outputNode: true,
  body: [
    { kind: 'input', id: 'integer', type: concrete('INT'), required: false, default: 0 },
    {
      kind: 'input',
      id: 'integer_as_float',
      type: concrete('FLOAT'),
      required: false,
      default: 0,
      widget: { type: 'NUMBER', step: 0.1 },
    },
    {
      kind: 'input',
      id: 'decimal',
      type: concrete('FLOAT'),
      required: false,
      default: 0,
      widget: { type: 'NUMBER', step: 0.1 },
    },
    { kind: 'input', id: 'text', type: concrete('STRING'), required: false, default: '' },
    { kind: 'input', id: 'flag', type: concrete('BOOLEAN'), required: false, default: false },
  ],
}

const companions = (page: Page) => page.evaluate(() => structuredClone(
  (window.__dinksterTest!.renderer as unknown as { companions: unknown }).companions,
))

async function serveSchemas(page: Page): Promise<void> {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'primitive-known-values-proof', schemaWire: 2 },
    nodes: {
      'e2e.identity.integer': primitiveSchema(
        'e2e.identity.integer', 'Integer identity', 'INT', 0,
      ),
      'e2e.identity.decimal': primitiveSchema(
        'e2e.identity.decimal', 'Decimal identity', 'FLOAT', 0, { type: 'NUMBER', step: 0.1 },
      ),
      'e2e.identity.text': primitiveSchema('e2e.identity.text', 'Text identity', 'STRING', ''),
      'e2e.identity.flag': primitiveSchema('e2e.identity.flag', 'Boolean identity', 'BOOLEAN', false),
      'e2e.known-value-sink': sinkSchema,
    },
  } }))
}

test('wire-34 primitive identity declarations show typed values before execution', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await serveSchemas(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(5)
  expect(await page.evaluate(() => {
    const schemas = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!.schemas as ReadonlyMap<
      string,
      { type: string; body: readonly { kind: string; knownValue?: { input: string } }[] }
    >
    return [...schemas.values()].filter((schema) => schema.type.startsWith('e2e.identity.')).map((schema) => ({
      type: schema.type,
      knownValue: schema.body.find((item) => item.kind === 'output')?.knownValue,
    }))
  })).toEqual([
    { type: 'e2e.identity.integer', knownValue: { input: 'source' } },
    { type: 'e2e.identity.decimal', knownValue: { input: 'source' } },
    { type: 'e2e.identity.text', knownValue: { input: 'source' } },
    { type: 'e2e.identity.flag', knownValue: { input: 'source' } },
  ])
  const loadDiagnostics = await page.evaluate(async () => {
    const diagnostics = (await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'primitive-known-values-proof',
      root: 'g0',
      graphs: { g0: {
        id: 'g0',
        name: 'root',
        nodes: {
          integer: { id: 'integer', type: 'e2e.identity.integer', values: { source: 7 } },
          decimal: { id: 'decimal', type: 'e2e.identity.decimal', values: { source: 1.25 } },
          text: { id: 'text', type: 'e2e.identity.text', values: { source: 'hello' } },
          flag: { id: 'flag', type: 'e2e.identity.flag', values: { source: true } },
          sink: { id: 'sink', type: 'e2e.known-value-sink', values: {} },
        },
        links: {
          l1: { id: 'l1', from: { node: 'integer', port: 'result' }, to: { node: 'sink', port: 'integer' } },
          l2: { id: 'l2', from: { node: 'integer', port: 'result' }, to: { node: 'sink', port: 'integer_as_float' } },
          l3: { id: 'l3', from: { node: 'decimal', port: 'result' }, to: { node: 'sink', port: 'decimal' } },
          l4: { id: 'l4', from: { node: 'text', port: 'result' }, to: { node: 'sink', port: 'text' } },
          l5: { id: 'l5', from: { node: 'flag', port: 'result' }, to: { node: 'sink', port: 'flag' } },
        },
        nets: {},
        reroutes: {},
        nextOrdinal: 10,
      } },
      view: { graphs: { g0: { nodes: {
        integer: { position: { x: 60, y: 40 } },
        decimal: { position: { x: 60, y: 220 } },
        text: { position: { x: 60, y: 400 } },
        flag: { position: { x: 60, y: 580 } },
        sink: { position: { x: 600, y: 200 } },
      } } } },
    } as never, 'Primitive known values'))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return diagnostics
  })
  expect(loadDiagnostics).toEqual([])

  await expect.poll(() => page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const def = tab.store.doc.graphs.g0
    return {
      lineage: tab.store.doc.lineage,
      graphs: Object.keys(tab.store.doc.graphs),
      links: def === undefined ? -1 : Object.keys(def.links).length,
      sceneNodes: window.__dinksterTest!.renderer!.getScene().nodes.length,
    }
  })).toEqual({ lineage: 'primitive-known-values-proof', graphs: ['g0'], links: 5, sceneNodes: 5 })

  await expect.poll(() => companions(page)).toEqual({ sink: {
    integer: { value: 7 },
    integer_as_float: { value: 7 },
    decimal: { value: 1.25 },
    text: { value: 'hello' },
    flag: { value: true },
  } })
  expect(await page.evaluate(() => ({
    executions: document.querySelectorAll('[data-testid="execution-row"]').length,
    types: Object.fromEntries(Object.entries(
      ((window.__dinksterTest!.renderer as unknown as {
        companions: Record<string, Record<string, { value: unknown }>>
      }).companions['sink'] ?? {}),
    ).map(([key, companion]) => [key, typeof companion.value])),
  }))).toEqual({
    executions: 0,
    types: {
      integer: 'number',
      integer_as_float: 'number',
      decimal: 'number',
      text: 'string',
      flag: 'boolean',
    },
  })

  await page.evaluate(() => {
    const store = window.__dinksterTest!.app.activeTab()!.store
    store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'integer', inputId: 'source', value: -11,
    } })
    store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'decimal', inputId: 'source', value: 2.75,
    } })
    store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'text', inputId: 'source', value: 'updated text',
    } })
    store.dispatch({ command: 'node.setValue', params: {
      graphId: 'g0', nodeId: 'flag', inputId: 'source', value: false,
    } })
  })
  await expect.poll(() => companions(page)).toEqual({ sink: {
    integer: { value: -11 },
    integer_as_float: { value: -11 },
    decimal: { value: 2.75 },
    text: { value: 'updated text' },
    flag: { value: false },
  } })

  const coercedFloat = page.getByTestId('canvas-widget-a11y')
    .filter({ has: page.getByText('Known value results, integer_as_float', { exact: true }) })
  const tooltip = page.getByTestId('app-tooltip')
  await expect(async () => {
    await coercedFloat.focus()
    await expect(tooltip).toContainText('Current expected value: -11.0')
  }).toPass()
  await page.addStyleTag({ content: '[data-testid="canvas-widget-a11y"] { opacity: 0 !important; }' })
  const screenshotPath = testInfo.outputPath('primitive-known-values.png')
  await page.screenshot({ path: screenshotPath, animations: 'disabled' })
  await testInfo.attach('primitive-known-values', { path: screenshotPath, contentType: 'image/png' })
  expect(pageErrors).toEqual([])
})

test('a wire dragged off a field onto the canvas makes its primitive, and one undo removes both', async ({ page }) => {
  await serveSchemas(page)
  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(5)
  expect(await page.evaluate(async () => {
    const diagnostics = (await window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'field-drop-primitive', root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: { sink: { id: 'sink', type: 'e2e.known-value-sink', values: { integer: 5 } } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
      } },
      view: { graphs: { g0: { nodes: { sink: { position: { x: 600, y: 200 } } } } } },
    } as never, 'Field drop primitive'))
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    return diagnostics
  })).toEqual([])
  const pin = await page.evaluate(() => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === 'sink')!
    const pin = node.layout.pins.find((item) => item.direction === 'in' && item.portId === 'integer')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x, y: rect.top + node.y + pin.y }
  })
  const graph = () => page.evaluate(() => {
    const def = window.__dinksterTest!.app.activeTab()!.store.doc.graphs.g0!
    return { nodes: Object.values(def.nodes).map((node) => ({ type: node.type, values: node.values })), links: Object.values(def.links).map((link) => link.to) }
  })
  await page.mouse.move(pin.x, pin.y)
  await page.mouse.down()
  await page.mouse.move(pin.x - 150, pin.y + 60)
  await page.mouse.move(pin.x - 300, pin.y + 120)
  await page.mouse.up()
  await expect.poll(graph).toEqual({
    nodes: [
      { type: 'e2e.known-value-sink', values: { integer: 5 } },
      { type: 'e2e.identity.integer', values: { source: 5 } },
    ],
    links: [{ node: 'sink', port: 'integer' }],
  })
  await page.keyboard.press('Control+z')
  await expect.poll(graph).toEqual({ nodes: [{ type: 'e2e.known-value-sink', values: { integer: 5 } }], links: [] })
})
