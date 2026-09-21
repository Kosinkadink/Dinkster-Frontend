import { expect, test, type Page } from './fixtures.js'

const concrete = (type: string) => ({ kind: 'concrete', types: [type] })

// Exact wire-29 shape of the backend's scalar dinkster.math.expression schema,
// including its declared expression mirror.
const mathExpressionNode = {
  schemaVersion: 1,
  nodeType: 'dinkster.math.expression',
  version: 1,
  displayName: 'Math Expression',
  category: 'math',
  description: 'Deterministic scalar expression grammar v1.',
  idempotent: true,
  interface: [
    {
      role: 'input',
      id: 'expression',
      type: concrete('core.string'),
      required: true,
      default: 'a + b',
      widget: { type: 'STRING', multiline: true },
    },
    {
      role: 'inputFamily',
      id: 'values',
      template: [{
        role: 'input',
        id: 'value',
        type: { kind: 'union', types: ['core.float', 'core.int', 'core.boolean'] },
        required: true,
      }],
      minMembers: 1,
      required: true,
      memberNames: 'abcdefghijklmnopqrstuvwxyz'.split(''),
    },
    { role: 'output', id: 'float', type: concrete('core.float') },
    { role: 'output', id: 'int', type: concrete('core.int') },
    { role: 'output', id: 'boolean', type: concrete('core.boolean') },
  ],
  searchTerms: ['formula', 'calculate', 'calculator', 'eval'],
  mirror: {
    kind: 'expression',
    precision: 'bounded',
    tolerance: { relative: 1e-12 },
    grammarVersion: 1,
  },
}

const scalarChainNode = (nodeType: string, inputType: string) => ({
  ...mathExpressionNode,
  schemaVersion: 1,
  nodeType,
  interface: mathExpressionNode.interface.map((item) => item.role === 'inputFamily'
    ? {
        ...item,
        template: [{ ...item.template?.[0], type: concrete(inputType) }],
      }
    : item),
})

const scalarChainIntNode = scalarChainNode('e2e.math.expression.scalar-chain-int', 'core.int')
const scalarChainFloatNode = scalarChainNode('e2e.math.expression.scalar-chain-float', 'core.float')

const knownIntNode = {
  schemaVersion: 1,
  nodeType: 'e2e.identity.int',
  version: 1,
  displayName: 'Integer',
  category: 'test',
  interface: [
    {
      role: 'input', id: 'source', required: false,
      type: concrete('core.int'), default: 0,
    },
    {
      role: 'output', id: 'result', type: concrete('core.int'),
      knownValue: { input: 'source' },
    },
  ],
}

const sinkNode = {
  schemaVersion: 1,
  nodeType: 'e2e.mirror.sink',
  displayName: 'Sink',
  category: 'test',
  outputNode: true,
  signature: 'mirror-estimates-proof',
  interface: [
    {
      role: 'input',
      id: 'value',
      required: false,
      type: concrete('core.float'),
      default: 0,
      widget: { type: 'NUMBER', min: 0 },
    },
  ],
}

const scalarChainSinkNode = { ...sinkNode, schemaVersion: 1 }

const socketSinkNode = {
  schemaVersion: 1,
  nodeType: 'e2e.mirror.socket-sink',
  displayName: 'Socket-only destination',
  category: 'test',
  outputNode: true,
  signature: 'mirror-estimates-socket-proof',
  interface: [{
    role: 'input',
    id: 'value',
    required: true,
    forceInput: true,
    type: concrete('core.boolean'),
  }],
}

const companion = (page: Page, nodeId: string, valueKey: string) =>
  page.evaluate((ids) => structuredClone(
    ((window.__dinksterTest!.renderer as unknown as {
      companions: Record<string, Record<string, unknown>>
    }).companions[ids.nodeId] ?? {})[ids.valueKey] ?? null,
  ), { nodeId, valueKey })

const sinkCompanion = (page: Page) => companion(page, 'sink', 'value')

const nodeResult = (page: Page, nodeId: string) =>
  page.evaluate((id) => structuredClone(
    window.__dinksterTest!.renderer!.getNodeOutputTexts()[id] ?? null,
  ), nodeId)

const mathResult = (page: Page) => nodeResult(page, 'math')

test('expression mirrors paint local estimates gated by execution.mirrorPreviews', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'mirror-estimates-proof', schemaWire: 1 },
    nodes: {
      'dinkster.math.expression': mathExpressionNode,
      'e2e.mirror.sink': sinkNode,
      'e2e.mirror.socket-sink': socketSinkNode,
    },
  } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(3)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'mirror-estimates-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            math: {
              id: 'math',
              type: 'dinkster.math.expression',
              values: { expression: 'a + b if c else 0' },
              // Wire-decoded memberNames families persist the names
              // themselves as member ids and address them as memberless
              // ports (values.a), unlike builder-schema autogrow (m0/m1).
              dynamic: { values: { members: ['a', 'b', 'c'] } },
            },
            sink: { id: 'sink', type: 'e2e.mirror.sink', values: { value: 0 } },
            socket: { id: 'socket', type: 'e2e.mirror.socket-sink', values: {} },
          },
          links: {
            la: { id: 'la', from: { valueSource: 'va' }, to: { node: 'math', port: 'values.a' } },
            lb: { id: 'lb', from: { valueSource: 'vb' }, to: { node: 'math', port: 'values.b' } },
            lc: { id: 'lc', from: { valueSource: 'vc' }, to: { node: 'math', port: 'values.c' } },
            ld: { id: 'ld', from: { node: 'math', port: 'float' }, to: { node: 'sink', port: 'value' } },
            le: { id: 'le', from: { node: 'math', port: 'boolean' }, to: { node: 'socket', port: 'value' } },
          },
          nets: {},
          reroutes: {},
          valueSources: {
            va: { id: 'va', value: 3, spec: { widgetType: 'INT' } },
            vb: { id: 'vb', value: 0.5, spec: { widgetType: 'FLOAT' } },
            vc: { id: 'vc', value: true, spec: { widgetType: 'BOOLEAN' } },
          },
          nextOrdinal: 10,
        },
      },
      view: { graphs: { g0: {
        nodes: {
          math: { position: { x: 300, y: 100 } },
          sink: { position: { x: 700, y: 120 } },
          socket: { position: { x: 700, y: 360 } },
        },
        valueSources: {
          va: { position: { x: 60, y: 90 } },
          vb: { position: { x: 60, y: 210 } },
          vc: { position: { x: 60, y: 330 } },
        },
      } } },
    } as never, 'Mirror estimates')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  // No execution has run: the mirror estimate is the only companion source.
  await expect.poll(() => sinkCompanion(page)).toEqual({ value: 3.5, state: 'estimate' })
  await expect.poll(() => mathResult(page)).toEqual({
    text: 'Estimated locally\nfloat: 3.5\nint: 3\nboolean: true',
    estimate: true,
  })
  await expect.poll(() => page.evaluate(() => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const math = scene.nodes.find((node) => node.id === 'math')!
    const socket = scene.nodes.find((node) => node.id === 'socket')!
    return {
      inputs: math.layout.pins
        .filter((pin) => pin.direction === 'in' && pin.address.port.startsWith('values.'))
        .map((pin) => pin.type),
      outputs: math.layout.pins
        .filter((pin) => pin.direction === 'out' && pin.widgetTap !== true)
        .map((pin) => ({ port: pin.portId, type: pin.type, maybeAbsent: pin.maybeAbsent === true })),
      socketWidgetBacked: socket.layout.pins.find((pin) => pin.direction === 'in')?.widgetBacked === true,
    }
  })).toEqual({
    inputs: [
      { kind: 'union', names: ['core.float', 'core.int', 'core.boolean'] },
      { kind: 'union', names: ['core.float', 'core.int', 'core.boolean'] },
      { kind: 'union', names: ['core.float', 'core.int', 'core.boolean'] },
      { kind: 'union', names: ['core.float', 'core.int', 'core.boolean'] },
    ],
    outputs: [
      { port: 'float', type: { kind: 'concrete', name: 'core.float' }, maybeAbsent: false },
      { port: 'int', type: { kind: 'concrete', name: 'core.int' }, maybeAbsent: false },
      { port: 'boolean', type: { kind: 'concrete', name: 'core.boolean' }, maybeAbsent: false },
    ],
    socketWidgetBacked: false,
  })
  await page.screenshot({ path: testInfo.outputPath('mirror-estimate-on.png'), animations: 'disabled' })

  const navigator = page.getByRole('listbox', { name: 'Canvas scene navigator' })
  await navigator.focus()
  await expect(navigator.getByRole('option').filter({ hasText: 'Node: Math Expression' }))
    .toContainText('live result estimated locally: float: 3.5, int: 3, boolean: true')
  await page.keyboard.press('Escape')

  const sinkWidget = page.getByTestId('canvas-widget-a11y')
    .filter({ has: page.getByText('Sink, value', { exact: true }) })
    .first()
  // The a11y widget list re-renders when companion values settle, which can
  // recreate the button right after focus and blur the tooltip away; retry
  // the focus+tooltip pair as one unit.
  await expect(async () => {
    await sinkWidget.focus()
    await expect(page.getByTestId('app-tooltip'))
      .toContainText('Mirrored estimate (computed locally, not executed): 3.5', { timeout: 1000 })
  }).toPass()

  // BOOLEAN literals participate in the same scalar mirror and update live.
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'valueSource.setValue',
      params: { graphId: 'g0', valueSourceId: 'vc', value: false },
    })
  })
  await expect.poll(() => sinkCompanion(page)).toEqual({ value: 0, state: 'estimate' })
  await expect.poll(() => mathResult(page)).toEqual({
    text: 'Estimated locally\nfloat: 0\nint: 0\nboolean: false',
    estimate: true,
  })

  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'valueSource.setValue',
      params: { graphId: 'g0', valueSourceId: 'vc', value: true },
    })
  })

  // Invalid expressions clear dependants while retaining an error on the producer.
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'math', inputId: 'expression', value: 'a +' },
    })
  })
  await expect.poll(() => sinkCompanion(page)).toBeNull()
  await expect.poll(() => mathResult(page)).toEqual({
    text: 'Preview error\nInvalid expression: unexpected token', error: true,
  })
  await page.locator('.canvas-stage').screenshot({
    path: testInfo.outputPath('expression-preview-error.png'),
    animations: 'disabled',
  })

  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'math', inputId: 'expression', value: 'a * b if c else 0' },
    })
  })
  await expect.poll(() => sinkCompanion(page)).toEqual({ value: 1.5, state: 'estimate' })
  await expect.poll(() => mathResult(page)).toEqual({
    text: 'Estimated locally\nfloat: 1.5\nint: 1\nboolean: true',
    estimate: true,
  })

  // Disconnecting an operand clears the estimate; reconnecting restores it.
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'link.disconnect', params: { graphId: 'g0', linkId: 'lb' },
    })
  })
  await expect.poll(() => sinkCompanion(page)).toBeNull()
  await expect.poll(() => mathResult(page)).toBeNull()
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'link.connect',
      params: { graphId: 'g0', from: { valueSource: 'vb' }, to: { node: 'math', port: 'values.b' } },
    })
  })
  await expect.poll(() => sinkCompanion(page)).toEqual({ value: 1.5, state: 'estimate' })
  await expect.poll(() => mathResult(page)).toEqual({
    text: 'Estimated locally\nfloat: 1.5\nint: 1\nboolean: true',
    estimate: true,
  })

  // The execution.mirrorPreviews setting gates derivation entirely.
  await page.evaluate(() => {
    (window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, value: unknown): void }
    }).settings.set('execution.mirrorPreviews', false)
  })
  await expect.poll(() => sinkCompanion(page)).toBeNull()
  await expect.poll(() => mathResult(page)).toBeNull()
  await page.screenshot({ path: testInfo.outputPath('mirror-estimate-off.png'), animations: 'disabled' })

  expect(pageErrors).toEqual([])
})

test('scalar estimates propagate through calculated outputs with truthful provenance', async ({ page }, testInfo) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/api/diagnostics', (route) => route.fulfill({ json: {} }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'scalar-propagation-proof', schemaWire: 1 },
    nodes: {
      'e2e.identity.int': knownIntNode,
      'e2e.math.expression.scalar-chain-int': scalarChainIntNode,
      'e2e.math.expression.scalar-chain-float': scalarChainFloatNode,
      'e2e.mirror.sink': scalarChainSinkNode,
    },
  } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() =>
    window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(4)
  await page.evaluate(() => {
    window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'scalar-propagation-proof',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'root',
          nodes: {
            third: {
              id: 'third', type: 'e2e.math.expression.scalar-chain-float', values: { expression: 'not a' },
              dynamic: { values: { members: ['a'] } },
            },
            primitive: {
              id: 'primitive', type: 'e2e.identity.int', values: { source: 2 },
            },
            first: {
              id: 'first', type: 'e2e.math.expression.scalar-chain-int', values: { expression: 'a + 0.5' },
              dynamic: { values: { members: ['a'] } },
            },
            second: {
              id: 'second', type: 'e2e.math.expression.scalar-chain-float', values: { expression: 'a + 1' },
              dynamic: { values: { members: ['a'] } },
            },
            sink: { id: 'sink', type: 'e2e.mirror.sink', values: { value: 0 } },
          },
          links: {
            l1: { id: 'l1', from: { node: 'primitive', port: 'result' }, to: { node: 'first', port: 'values.a' } },
            l2: { id: 'l2', from: { node: 'first', port: 'float' }, to: { node: 'second', port: 'values.a' } },
            l3: { id: 'l3', from: { node: 'second', port: 'float' }, to: { node: 'third', port: 'values.a' } },
            l4: { id: 'l4', from: { node: 'third', port: 'float' }, to: { node: 'sink', port: 'value' } },
          },
          nets: {},
          reroutes: {},
          nextOrdinal: 20,
        },
      },
      view: { graphs: { g0: {
        nodes: {
          primitive: { position: { x: 20, y: 120 } },
          first: { position: { x: 300, y: 90 } },
          second: { position: { x: 630, y: 90 } },
          third: { position: { x: 960, y: 90 } },
          sink: { position: { x: 1250, y: 120 } },
        },
      } } },
    } as never, 'Scalar estimate propagation')
    window.__dinksterTest!.renderer!.setViewport({ x: 20, y: 40, scale: 0.72 })
  })

  await expect.poll(() => nodeResult(page, 'first')).toEqual({
    text: 'Estimated locally\nfloat: 2.5\nint: 2\nboolean: true', estimate: true,
  })
  await expect.poll(() => nodeResult(page, 'second')).toEqual({
    text: 'Estimated locally\nfloat: 3.5\nint: 3\nboolean: true', estimate: true,
  })
  await expect.poll(() => nodeResult(page, 'third')).toEqual({
    text: 'Estimated locally\nfloat: 0\nint: 0\nboolean: false', estimate: true,
  })
  await expect.poll(() => companion(page, 'first', 'values.a')).toEqual({ value: 2 })
  await expect.poll(() => companion(page, 'second', 'values.a'))
    .toEqual({ value: 2.5, state: 'estimate' })
  await expect.poll(() => companion(page, 'third', 'values.a'))
    .toEqual({ value: 3.5, state: 'estimate' })
  await expect.poll(() => sinkCompanion(page)).toEqual({ value: 0, state: 'estimate' })

  await page.locator('.canvas-stage').screenshot({
    path: testInfo.outputPath('scalar-estimate-propagation.png'),
    animations: 'disabled',
  })

  const navigator = page.getByRole('listbox', { name: 'Canvas scene navigator' })
  await navigator.focus()
  await expect(navigator.locator('[data-active="true"]'))
    .toContainText('live result estimated locally: float: 0, int: 0, boolean: false')
  await page.keyboard.press('Escape')

  // A middle-node failure keeps its error and clears only its downstream suffix.
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'second', inputId: 'expression', value: 'a / 0' },
    })
  })
  await expect.poll(() => nodeResult(page, 'first')).not.toBeNull()
  await expect.poll(() => nodeResult(page, 'second')).toEqual({
    text: 'Preview error\nDivision by zero', error: true,
  })
  await expect.poll(() => nodeResult(page, 'third')).toBeNull()
  await expect.poll(() => sinkCompanion(page)).toBeNull()
  await page.locator('.canvas-stage').screenshot({
    path: testInfo.outputPath('scalar-estimate-preview-error.png'),
    animations: 'disabled',
  })

  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'second', inputId: 'expression', value: 'a + 1' },
    })
  })
  await expect.poll(() => nodeResult(page, 'third')).not.toBeNull()

  // A freshly executed output is exact and wins over its local estimate.
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const compiled = app.compileTab(app.activeTab()!)
    if (!compiled?.ok) throw new Error(JSON.stringify(compiled?.diagnostics))
    const ref = { connection: compiled.artifact.connection, prompt: 'scalar-propagation-run-1' }
    const store = app.store as unknown as {
      register(ref: unknown, artifact: unknown, now: number): void
      apply(event: unknown): void
    }
    const now = Date.now()
    store.register(ref, compiled.artifact, now)
    store.apply({ kind: 'started', execution: ref, timestamp: now })
    store.apply({
      kind: 'nodeStates', execution: ref, timestamp: now,
      nodes: { first: { state: 'done', outputs: {
        float: { typeId: 'core.float', value: 9 },
        int: { typeId: 'core.int', value: 9 },
        boolean: { typeId: 'core.boolean', value: true },
      } } },
    })
    store.apply({ kind: 'completed', execution: ref, timestamp: now })
  })
  await expect.poll(() => companion(page, 'second', 'values.a')).toEqual({ value: 9 })
  await expect.poll(() => nodeResult(page, 'first')).toBeNull()
  await expect.poll(() => nodeResult(page, 'second')).toEqual({
    text: 'Estimated locally\nfloat: 10\nint: 10\nboolean: true', estimate: true,
  })

  // Editing the source makes the recorded value stale; the local estimate
  // replaces it while mirrors are on, and the stale value remains distinct
  // when mirrors are disabled.
  await page.evaluate(() => {
    window.__dinksterTest!.app.activeTab()!.store.dispatch({
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'primitive', inputId: 'source', value: 4 },
    })
  })
  await expect.poll(() => companion(page, 'second', 'values.a'))
    .toEqual({ value: 4.5, state: 'estimate' })
  await expect.poll(() => nodeResult(page, 'second')).toEqual({
    text: 'Estimated locally\nfloat: 5.5\nint: 5\nboolean: true', estimate: true,
  })
  await page.evaluate(() => {
    (window.__dinksterTest!.app as unknown as {
      settings: { set(id: string, value: unknown): void }
    }).settings.set('execution.mirrorPreviews', false)
  })
  await expect.poll(() => companion(page, 'second', 'values.a')).toEqual({ value: 9, stale: true })
  await expect.poll(() => nodeResult(page, 'second')).toBeNull()

  expect(pageErrors).toEqual([])
})
