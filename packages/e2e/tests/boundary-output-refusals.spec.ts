import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openRailPanel, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_OUTPUT_REFUSAL_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

const image = { kind: 'concrete' as const, name: 'IMAGE' }
const integer = { kind: 'concrete' as const, name: 'INT' }

async function registerSchemas(page: Page): Promise<void> {
  await page.evaluate(({ image, integer }) => {
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'RefusalFloatSource',
        displayName: 'Float Source',
        category: 'test',
        source: 'v3',
        isOutputNode: true,
        items: [{ kind: 'output', id: 'value', type: { kind: 'concrete', name: 'FLOAT' } }],
      },
      {
        type: 'RuntimeAritySplit',
        displayName: 'Runtime Arity Split',
        category: 'test',
        source: 'v3',
        isOutputNode: true,
        items: [
          {
            kind: 'input',
            id: 'count',
            type: integer,
            optional: false,
            widget: { widgetType: 'INT', options: { min: 0, max: 4 }, default: 0 },
          },
          {
            kind: 'output',
            id: 'outs',
            type: image,
            dynamic: {
              kind: 'autogrow',
              template: [{ kind: 'input', id: 'out', type: image, optional: true }],
              naming: { kind: 'prefix', prefix: 'out', min: 0, max: 4 },
              count: { input: 'count', suffix: 'index' },
            },
          },
        ],
      },
    ])
  }, { image, integer })
}

async function openStructuralWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const diagnostics = window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'structural-output-refusal', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Structural output refusal',
          nodes: { instance: { id: 'instance', type: '#producers', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        },
        producers: {
          id: 'producers', name: 'Structural producers',
          nodes: {
            first: { id: 'first', type: 'RefusalFloatSource', values: {} },
            second: { id: 'second', type: 'RefusalFloatSource', values: {} },
          },
          links: {
            rerouteDriver: { id: 'rerouteDriver', from: { node: 'first', port: 'value' }, to: { reroute: 'junction' } },
            choiceA: { id: 'choiceA', from: { node: 'first', port: 'value' }, to: { selector: 'choice', candidate: 'a' } },
            choiceB: { id: 'choiceB', from: { node: 'second', port: 'value' }, to: { selector: 'choice', candidate: 'b' } },
          },
          nets: {},
          reroutes: { junction: { id: 'junction' } },
          valueSources: { literal: { id: 'literal', value: 2.5, spec: { widgetType: 'FLOAT' } } },
          selectors: {
            choice: {
              id: 'choice',
              candidates: [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }],
              policy: { kind: 'fixed', candidate: 'a' },
            },
          },
          boundary: { inputs: [], outputs: [] },
          nextOrdinal: 20,
        },
      },
      view: { graphs: {
        root: { nodes: { instance: { position: { x: 180, y: 120 } } } },
        producers: {
          nodes: {
            first: { position: { x: 80, y: 80 } },
            second: { position: { x: 80, y: 260 } },
          },
          reroutes: { junction: { position: { x: 400, y: 100 } } },
          valueSources: { literal: { position: { x: 100, y: 480 } } },
          selectors: { choice: { position: { x: 430, y: 400 } } },
        },
      } },
    }, 'Structural output refusal')
    if (diagnostics.length > 0) throw new Error(`open failed: ${JSON.stringify(diagnostics)}`)
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['root', 'producers'])
    tab.instancePath.set(['instance'])
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('producers')
}

type StructuralProducer = 'valueSource' | 'selector' | 'reroute'

async function producerPoint(page: Page, producer: StructuralProducer): Promise<{ x: number; y: number }> {
  return page.evaluate((producer) => {
    const scene = window.__dinksterTest!.renderer!.getScene()
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    if (producer === 'valueSource') {
      const source = scene.valueSources.find((item) => item.id === 'literal')!
      return { x: rect.left + source.x + source.width, y: rect.top + source.y + source.height / 2 }
    }
    if (producer === 'selector') {
      const selector = scene.selectors.find((item) => item.id === 'choice')!
      return { x: rect.left + selector.x + selector.width, y: rect.top + selector.y + selector.headerHeight / 2 }
    }
    const reroute = scene.reroutes.find((item) => item.id === 'junction')!
    return { x: rect.left + reroute.x + 21, y: rect.top + reroute.y }
  }, producer)
}

async function rerouteCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const reroute = window.__dinksterTest!.renderer!.getScene().reroutes.find((item) => item.id === 'junction')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + reroute.x, y: rect.top + reroute.y }
  })
}

async function outputBoundaryPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const boundary = window.__dinksterTest!.renderer!.getScene().boundaryNodes.find((item) => item.side === 'outputs')!
    const add = boundary.layout.pins.find((pin) => pin.portId === '__add__')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + boundary.x, y: rect.top + boundary.y + add.y }
  })
}

async function dragStructuralProducer(page: Page, producer: StructuralProducer): Promise<void> {
  if (producer === 'reroute') {
    const center = await rerouteCenter(page)
    await page.mouse.move(center.x, center.y)
  }
  const from = await producerPoint(page, producer)
  const to = await outputBoundaryPoint(page)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2)
  await page.mouse.move(to.x, to.y)
  await page.mouse.up()
}

test.beforeEach(async ({ page }) => {
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: { os: 'e2e' }, devices: [] } }))
  await page.route('/object_info', (route) => route.fulfill({ json: {} }))
  await page.route('/queue', (route) => route.fulfill({ json: { queue_running: [], queue_pending: [] } }))
  await page.route('/history*', (route) => route.fulfill({ json: {} }))
  await page.routeWebSocket('/ws*', () => {})
  await page.goto('/')
  await page.waitForFunction(() => window.__dinksterTest !== undefined)
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })
  await registerSchemas(page)
})

test('structural producers refuse direct boundary outputs with visible diagnostics', async ({ page }) => {
  await openStructuralWorkflow(page)
  const before = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const outputs = window.__dinksterTest!.renderer!.getScene().boundaryNodes
      .find((item) => item.side === 'outputs')!.layout.pins.map((pin) => pin.portId)
    return { revision: tab.store.revision, outputs }
  })
  const cases = [
    { producer: 'valueSource' as const, label: "value source 'literal'" },
    { producer: 'selector' as const, label: "selector 'choice'" },
    { producer: 'reroute' as const, label: "reroute 'junction'" },
  ]
  const expectedMessages: string[] = []
  for (const item of cases) {
    await dragStructuralProducer(page, item.producer)
    expectedMessages.push(
      `Cannot expose ${item.label} on boundary outputs: structural producers require stamped public output types`,
    )
    await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get()
      .filter((diagnostic) => diagnostic.code === 'boundary.structuralProducerUnsupported')
      .map((diagnostic) => diagnostic.message))).toEqual(expectedMessages)
    await expect(page.getByTestId('problems-panel')).toContainText(`Cannot expose ${item.label} on boundary outputs`)
  }
  const after = await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    const outputs = window.__dinksterTest!.renderer!.getScene().boundaryNodes
      .find((item) => item.side === 'outputs')!.layout.pins.map((pin) => pin.portId)
    return { revision: tab.store.revision, outputs }
  })
  expect(after).toEqual(before)

  await openRailPanel(page, 'Problems')
  await expect(page.getByTestId('problems-panel')).toBeVisible()
  for (const item of cases) {
    await expect(page.getByTestId('problems-panel')).toContainText(`Cannot expose ${item.label} on boundary outputs`)
  }
  await page.mouse.move(20, 20)
  if (proofDir) {
    await page.screenshot({
      path: join(proofDir, 'structural-output-refusal.png'),
      animations: 'disabled',
      fullPage: true,
    })
  }
})

test('execution-time output arity is refused until count is a pre-execution literal', async ({ page }) => {
  let promptPosts = 0
  await page.route('/prompt', (route) => {
    promptPosts += 1
    return route.fulfill({ json: { prompt_id: 'unexpected' } })
  })
  await page.evaluate(() => {
    const diagnostics = window.__dinksterTest!.app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'runtime-output-arity-refusal', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Runtime output arity refusal',
          nodes: { instance: { id: 'instance', type: '#runtimeArity', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        },
        runtimeArity: {
          id: 'runtimeArity', name: 'Runtime output arity',
          nodes: { split: { id: 'split', type: 'RuntimeAritySplit', values: {} } },
          links: {}, nets: {}, reroutes: {},
          boundary: {
            inputs: [],
            outputs: [{ id: 'pictures', binds: { kind: 'family', node: 'split', port: 'outs' } }],
          },
          nextOrdinal: 10,
        },
      },
      view: { graphs: {
        root: { nodes: { instance: { position: { x: 180, y: 120 } } } },
        runtimeArity: { nodes: { split: { position: { x: 180, y: 120 } } } },
      } },
    }, 'Runtime output arity refusal')
    if (diagnostics.length > 0) throw new Error(`open failed: ${JSON.stringify(diagnostics)}`)
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['root', 'runtimeArity'])
    tab.instancePath.set(['instance'])
  })

  await openRailPanel(page, 'Boundary')
  const boundaryDiagnostic = page.locator('[data-testid=boundary-diag][data-code="boundary.countBoundOutputInvalid"]')
  await expect(boundaryDiagnostic).toBeVisible()
  await expect(boundaryDiagnostic).toContainText("count input 'count' must hold a safe integer in 0..4")

  await page.evaluate(async () => {
    const app = window.__dinksterTest!.app
    await app.queue(app.activeTab()!)
  })
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.app.problems.get()
    .filter((diagnostic) => diagnostic.code === 'elab.outputFamily.badCount')
    .map((diagnostic) => diagnostic.message))).toEqual([
    "[runtimeArity/split] RuntimeAritySplit.outs: count input 'count' must store a safe nonnegative integer",
  ])
  await expect(page.getByTestId('problems-panel')).toContainText("count input 'count' must store a safe nonnegative integer")
  expect(promptPosts).toBe(0)
  await openRailPanel(page, 'Problems')

  if (proofDir) {
    await page.screenshot({
      path: join(proofDir, 'runtime-output-arity-refusal.png'),
      animations: 'disabled',
      fullPage: true,
    })
  }
})
