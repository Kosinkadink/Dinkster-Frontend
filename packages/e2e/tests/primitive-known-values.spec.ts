import { expect, test, type Page } from './fixtures.js'

const concrete = (type: string) => ({ kind: 'concrete', types: [type] })

const primitiveSchema = (
  nodeType: string,
  displayName: string,
  type: string,
  defaultValue: string | number | boolean,
  widget?: Record<string, unknown>,
) => ({
  schemaVersion: 34,
  nodeType,
  displayName,
  category: 'test/primitives',
  idempotent: true,
  interface: [
    {
      role: 'input',
      id: 'source',
      type: concrete(type),
      required: false,
      default: defaultValue,
      ...(widget === undefined ? {} : { widget }),
    },
    {
      role: 'output',
      id: 'result',
      type: concrete(type),
      knownValue: { input: 'source' },
    },
  ],
})

const sinkSchema = {
  schemaVersion: 34,
  nodeType: 'e2e.known-value-sink',
  displayName: 'Known value results',
  category: 'test',
  outputNode: true,
  interface: [
    { role: 'input', id: 'integer', type: concrete('core.int'), required: false, default: 0 },
    {
      role: 'input',
      id: 'integer_as_float',
      type: concrete('core.float'),
      required: false,
      default: 0,
      widget: { type: 'NUMBER', step: 0.1 },
    },
    {
      role: 'input',
      id: 'decimal',
      type: concrete('core.float'),
      required: false,
      default: 0,
      widget: { type: 'NUMBER', step: 0.1 },
    },
    { role: 'input', id: 'text', type: concrete('core.string'), required: false, default: '' },
    { role: 'input', id: 'flag', type: concrete('core.boolean'), required: false, default: false },
  ],
}

const companions = (page: Page) => page.evaluate(() => structuredClone(
  (window.__dinksterTest!.renderer as unknown as { companions: unknown }).companions,
))

test('wire-34 primitive identity declarations show typed values before execution', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'primitive-known-values-proof', schemaWire: 34 },
    nodes: {
      'e2e.identity.integer': primitiveSchema(
        'e2e.identity.integer', 'Integer identity', 'core.int', 0,
      ),
      'e2e.identity.decimal': primitiveSchema(
        'e2e.identity.decimal', 'Decimal identity', 'core.float', 0, { type: 'NUMBER', step: 0.1 },
      ),
      'e2e.identity.text': primitiveSchema('e2e.identity.text', 'Text identity', 'core.string', ''),
      'e2e.identity.flag': primitiveSchema('e2e.identity.flag', 'Boolean identity', 'core.boolean', false),
      'e2e.known-value-sink': sinkSchema,
    },
  } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(5)
  expect(await page.evaluate(() => {
    const schemas = window.__dinksterTest!.app.backends.get()[0]!.registry.get()!.schemas as ReadonlyMap<
      string,
      { type: string; items: readonly { kind: string; knownValue?: { input: string } }[] }
    >
    return [...schemas.values()].filter((schema) => schema.type.startsWith('e2e.identity.')).map((schema) => ({
      type: schema.type,
      knownValue: schema.items.find((item) => item.kind === 'output')?.knownValue,
    }))
  })).toEqual([
    { type: 'e2e.identity.integer', knownValue: { input: 'source' } },
    { type: 'e2e.identity.decimal', knownValue: { input: 'source' } },
    { type: 'e2e.identity.text', knownValue: { input: 'source' } },
    { type: 'e2e.identity.flag', knownValue: { input: 'source' } },
  ])
  const loadDiagnostics = await page.evaluate(() => {
    const diagnostics = window.__dinksterTest!.app.openDocument({
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
    } as never, 'Primitive known values')
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
