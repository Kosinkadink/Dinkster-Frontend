import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openRailPanel, test, type Page } from './fixtures.js'

const proofDir = process.env['DINKSTER_OUTPUT_FAMILY_PROOF_DIR']
if (proofDir) mkdirSync(proofDir, { recursive: true })

type ScenePin = {
  direction: string
  ghost?: true
  address: { port: string; members?: readonly string[] }
}

const image = { kind: 'concrete' as const, name: 'IMAGE' }
const integer = { kind: 'concrete' as const, name: 'INT' }

async function registerSchemas(page: Page): Promise<void> {
  await page.evaluate(({ image, integer }) => {
    window.__dinksterTest!.app.registerSchemas([
      {
        type: 'NestedSplit',
        displayName: 'Nested Split',
        category: 'test',
        source: 'v3',
        isOutputNode: true,
        items: [
          {
            kind: 'output',
            id: 'outs',
            type: image,
            dynamic: {
              kind: 'autogrow',
              template: [{
                kind: 'input',
                id: 'sub',
                type: image,
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  template: [{ kind: 'input', id: 'value', type: image, optional: true }],
                  naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
                },
              }],
              naming: { kind: 'prefix', prefix: 'out', min: 0, max: 4 },
            },
          },
          { kind: 'output', id: 'last', type: image },
        ],
      },
      {
        type: 'CountSplit',
        displayName: 'Count Split',
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
      {
        type: 'ImageSink',
        displayName: 'Image Sink',
        category: 'test',
        source: 'v3',
        isOutputNode: true,
        items: [{ kind: 'input', id: 'image', type: image, optional: false }],
      },
      {
        type: 'IntSource',
        displayName: 'Integer Source',
        category: 'test',
        source: 'v3',
        isOutputNode: true,
        items: [{ kind: 'output', id: 'value', type: integer }],
      },
    ])
  }, { image, integer })
}

async function openNestedWorkflow(page: Page): Promise<void> {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'nested-output-family-boundary-proof',
      root: 'root',
      graphs: {
        root: {
          id: 'root',
          name: 'Independent nested outputs',
          nodes: {
            a: {
              id: 'a',
              type: '#wrapper',
              values: {},
              dynamic: {
                outputs: {
                  members: ['m0'],
                  memberState: { m0: { 'outputs.sub': { members: ['k0', 'k1'] } } },
                },
              },
            },
            b: {
              id: 'b',
              type: '#wrapper',
              values: {},
              dynamic: {
                outputs: {
                  members: ['m0'],
                  memberState: { m0: { 'outputs.sub': { members: ['k0'] } } },
                },
              },
            },
            a0: { id: 'a0', type: 'ImageSink', values: {} },
            a1: { id: 'a1', type: 'ImageSink', values: {} },
            b0: { id: 'b0', type: 'ImageSink', values: {} },
          },
          links: {
            l0: { id: 'l0', from: { node: 'a', port: 'outputs.sub.value', members: ['m0', 'k0'] }, to: { node: 'a0', port: 'image' } },
            l1: { id: 'l1', from: { node: 'a', port: 'outputs.sub.value', members: ['m0', 'k1'] }, to: { node: 'a1', port: 'image' } },
            l2: { id: 'l2', from: { node: 'b', port: 'outputs.sub.value', members: ['m0', 'k0'] }, to: { node: 'b0', port: 'image' } },
          },
          nets: {},
          reroutes: {},
          nextOrdinal: 20,
        },
        wrapper: {
          id: 'wrapper',
          name: 'Nested output wrapper',
          nodes: { i: { id: 'i', type: '#definition', values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          boundary: {
            inputs: [],
            outputs: [
              { id: 'outputs', displayName: 'Nested outputs', binds: { kind: 'family', node: 'i', port: 'outputs' } },
              { id: 'last', displayName: 'Last', binds: { kind: 'port', node: 'i', port: 'last' } },
            ],
          },
          nextOrdinal: 10,
        },
        definition: {
          id: 'definition',
          name: 'Nested output definition',
          nodes: { n: { id: 'n', type: 'NestedSplit', values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          boundary: {
            inputs: [],
            outputs: [
              { id: 'outputs', displayName: 'Nested outputs', binds: { kind: 'family', node: 'n', port: 'outs' } },
              { id: 'last', displayName: 'Last', binds: { kind: 'port', node: 'n', port: 'last' } },
            ],
          },
          nextOrdinal: 10,
        },
      },
      view: {
        graphs: {
          root: {
            nodes: {
              a: { position: { x: 80, y: 100 } },
              b: { position: { x: 480, y: 100 } },
              a0: { position: { x: 850, y: 60 } },
              a1: { position: { x: 850, y: 260 } },
              b0: { position: { x: 850, y: 460 } },
            },
          },
          wrapper: { nodes: { i: { position: { x: 180, y: 120 } } } },
          definition: { nodes: { n: { position: { x: 180, y: 120 } } } },
        },
      },
    }, 'Nested output families')
    if (diagnostics.length > 0) throw new Error(`open failed: ${JSON.stringify(diagnostics)}`)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })
}

function nestedPins(page: Page, nodeId: string, port: string): Promise<readonly string[][]> {
  return page.evaluate(({ nodeId, port }) => {
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((item) => item.id === nodeId)
    if (!node) throw new Error(`no scene node '${nodeId}'`)
    return (node.layout.pins as readonly ScenePin[])
      .filter((pin) => pin.direction === 'out' && !pin.ghost && pin.address.port === port)
      .map((pin) => [...(pin.address.members ?? [])])
  }, { nodeId, port })
}

async function drillToNestedSplit(page: Page, rootInstance: string): Promise<void> {
  await page.evaluate((rootInstance) => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['root', 'wrapper', 'definition'])
    tab.instancePath.set([rootInstance, 'i'])
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, rootInstance)
  await expect.poll(() => page.evaluate(() => window.__dinksterTest!.renderer!.getScene().graphId)).toBe('definition')
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

test('nested output templates render independent root sibling member identities', async ({ page }) => {
  await openNestedWorkflow(page)

  await expect.poll(() => nestedPins(page, 'a', 'outputs.sub.value')).toEqual([['m0', 'k0'], ['m0', 'k1']])
  await expect.poll(() => nestedPins(page, 'b', 'outputs.sub.value')).toEqual([['m0', 'k0']])

  if (proofDir) {
    await page.screenshot({
      path: join(proofDir, 'boundary-output-families-independent-siblings.png'),
      animations: 'disabled',
      fullPage: true,
    })
  }
})

test('nested output identities reach the drilled inner occurrence', async ({ page }) => {
  await openNestedWorkflow(page)
  await drillToNestedSplit(page, 'a')
  await expect.poll(() => nestedPins(page, 'n', 'outs.sub.value')).toEqual([['\u0000\u0000m0', 'k0'], ['\u0000\u0000m0', 'k1']])

  await drillToNestedSplit(page, 'b')
  await expect.poll(() => nestedPins(page, 'n', 'outs.sub.value')).toEqual([['\u0000\u0000m0', 'k0']])
})

test('nested output identities survive export and reopen', async ({ page }) => {
  await openNestedWorkflow(page)
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const exported = app.exportDocument(tab.id)
    const diagnostics = app.openDocument(JSON.parse(JSON.stringify(exported)), 'Reopened nested output families')
    if (diagnostics.length > 0) throw new Error(`reopen failed: ${JSON.stringify(diagnostics)}`)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await expect.poll(() => nestedPins(page, 'a', 'outputs.sub.value')).toEqual([['m0', 'k0'], ['m0', 'k1']])
  await expect.poll(() => nestedPins(page, 'b', 'outputs.sub.value')).toEqual([['m0', 'k0']])
})

test('nested output members compile to occurrence-local inner output indexes', async ({ page }) => {
  await openNestedWorkflow(page)
  const compiled = await page.evaluate(() => {
    const result = window.__dinksterTest!.app.compileTab(window.__dinksterTest!.app.activeTab()!)
    if (result === undefined || !result.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    return (result.artifact as unknown as { prompt: Record<string, { inputs: Record<string, unknown> }> }).prompt
  })

  expect(compiled.a0?.inputs.image).toEqual(['a.i.n', 0])
  expect(compiled.a1?.inputs.image).toEqual(['a.i.n', 1])
  expect(compiled.b0?.inputs.image).toEqual(['b.i.n', 0])
})

test('promoted literal counts render canonical output members through chained wrappers', async ({ page }) => {
  await page.evaluate(() => {
    const app = window.__dinksterTest!.app
    const diagnostics = app.openDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'count-output-chain-proof', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Independent count outputs',
          nodes: {
            one: { id: 'one', type: '#countWrapper', values: { amount: 1 } },
            three: { id: 'three', type: '#countWrapper', values: { amount: 3 } },
            first: { id: 'first', type: 'ImageSink', values: {} },
            third: { id: 'third', type: 'ImageSink', values: {} },
          },
          links: {
            l0: { id: 'l0', from: { node: 'one', port: 'pictures', members: ['0'] }, to: { node: 'first', port: 'image' } },
            l1: { id: 'l1', from: { node: 'three', port: 'pictures', members: ['2'] }, to: { node: 'third', port: 'image' } },
          },
          nets: {}, reroutes: {}, nextOrdinal: 10,
        },
        countWrapper: {
          id: 'countWrapper', name: 'Count output wrapper',
          nodes: { i: { id: 'i', type: '#countDefinition', values: {} } },
          links: {}, nets: {}, reroutes: {},
          boundary: {
            inputs: [{ id: 'amount', binds: { kind: 'port', node: 'i', port: 'innerCount' }, promoted: true }],
            outputs: [{ id: 'pictures', binds: { kind: 'family', node: 'i', port: 'innerPictures' } }],
          },
          nextOrdinal: 10,
        },
        countDefinition: {
          id: 'countDefinition', name: 'Count output definition',
          nodes: { n: { id: 'n', type: 'CountSplit', values: { count: 2 } } },
          links: {}, nets: {}, reroutes: {},
          boundary: {
            inputs: [{ id: 'innerCount', binds: { kind: 'port', node: 'n', port: 'count' }, promoted: true }],
            outputs: [{ id: 'innerPictures', binds: { kind: 'family', node: 'n', port: 'outs' } }],
          },
          nextOrdinal: 10,
        },
      },
      view: { graphs: {
        root: { nodes: {
          one: { position: { x: 100, y: 120 } }, three: { position: { x: 500, y: 120 } },
          first: { position: { x: 900, y: 80 } }, third: { position: { x: 900, y: 320 } },
        } },
        countWrapper: { nodes: { i: { position: { x: 180, y: 120 } } } },
        countDefinition: { nodes: { n: { position: { x: 180, y: 120 } } } },
      } },
    }, 'Count output families')
    if (diagnostics.length > 0) throw new Error(`open failed: ${JSON.stringify(diagnostics)}`)
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  })

  await expect.poll(() => nestedPins(page, 'one', 'pictures')).toEqual([['0']])
  await expect.poll(() => nestedPins(page, 'three', 'pictures')).toEqual([['0'], ['1'], ['2']])
  const prompt = await page.evaluate(() => {
    const result = window.__dinksterTest!.app.compileTab(window.__dinksterTest!.app.activeTab()!)
    if (result === undefined || !result.ok) throw new Error(`compile failed: ${JSON.stringify(result?.diagnostics)}`)
    return (result.artifact as unknown as { prompt: Record<string, { inputs: Record<string, unknown>; outputMembers?: unknown }> }).prompt
  })
  expect(prompt['one.i.n']?.outputMembers).toEqual({ outs: ['0'] })
  expect(prompt['three.i.n']?.outputMembers).toEqual({ outs: ['0', '1', '2'] })
  expect(prompt.first?.inputs.image).toEqual(['one.i.n', 0])
  expect(prompt.third?.inputs.image).toEqual(['three.i.n', 2])
})

test('linked output counts are refused with boundary and compile diagnostics', async ({ page }) => {
  await page.evaluate(() => window.__dinksterTest!.app.openDocument({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'linked-output-count-refusal', root: 'root',
    graphs: {
      root: {
        id: 'root', name: 'Linked count refusal',
        nodes: { instance: { id: 'instance', type: '#linkedDefinition', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
      },
      linkedDefinition: {
        id: 'linkedDefinition', name: 'Invalid linked count',
        nodes: {
          source: { id: 'source', type: 'IntSource', values: {} },
          split: { id: 'split', type: 'CountSplit', values: { count: 2 } },
        },
        links: {
          count: { id: 'count', from: { node: 'source', port: 'value' }, to: { node: 'split', port: 'count' } },
        },
        nets: {}, reroutes: {},
        boundary: { inputs: [], outputs: [{ id: 'pictures', binds: { kind: 'family', node: 'split', port: 'outs' } }] },
        nextOrdinal: 10,
      },
    },
    view: { graphs: {
      root: { nodes: { instance: { position: { x: 180, y: 120 } } } },
      linkedDefinition: { nodes: {
        source: { position: { x: 100, y: 100 } }, split: { position: { x: 500, y: 100 } },
      } },
    } },
  }, 'Linked count refusal'))

  await page.evaluate(() => {
    const tab = window.__dinksterTest!.app.activeTab()!
    tab.graphStack.set(['root', 'linkedDefinition'])
    tab.instancePath.set(['instance'])
  })
  await openRailPanel(page, 'Boundary')
  const boundaryDiagnostic = page.locator('[data-testid=boundary-diag][data-code="boundary.countBoundOutputInvalid"]')
  await expect(boundaryDiagnostic).toBeVisible()
  await expect(boundaryDiagnostic).toContainText("count input 'count' is linked")

  const compileDiagnostics = await page.evaluate(() => {
    const result = window.__dinksterTest!.app.compileTab(window.__dinksterTest!.app.activeTab()!)
    if (result === undefined || result.ok) throw new Error('linked count unexpectedly compiled')
    return result.diagnostics
  })
  expect(compileDiagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'elab.outputFamily.linkedCount' }),
  ]))
})
