import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, openRailPanel, test } from './fixtures.js'

const proofDir = process.env['DINKSTER_REGION_INSPECTOR_PROOF_DIR']
if (proofDir !== undefined) mkdirSync(proofDir, { recursive: true })

test('inspects simple and nested region iterations by exact retained runtime identity', async ({ page }) => {
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'isolated proof' }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: {
    schemaVersion: 1,
    epoch: 1,
    dinkster: { version: 'region-inspector-proof', schemaWire: 44 },
    packs: {},
    nodes: {},
  } }))
  await page.route('/api/values*', (route) => {
    const url = new URL(route.request().url())
    const nodeId = url.searchParams.get('nodeId') ?? ''
    const outputId = url.searchParams.get('outputId') ?? ''
    if (nodeId === 'outer[1]/inner[2]/leaf') {
      return route.fulfill({ status: 410, json: {
        available: false,
        reason: 'not-retained',
        error: 'This nested intermediate is no longer retained.',
      } })
    }
    return route.fulfill({ json: {
      available: true,
      descriptor: { typeId: 'core.int', fingerprint: `${nodeId}:${outputId}`, value: nodeId.includes('[1]') ? 8 : 3 },
      renditions: [],
    } })
  })
  await page.goto('/')
  await expect(page.getByTestId('status-bar')).toContainText(/\d+ node schemas/, { timeout: 15_000 })

  await page.evaluate(() => {
    const bridge = window.__dinksterTest!
    const app = bridge.app as typeof bridge.app & {
      registryForTab(tab: unknown): { readonly hash: string } | undefined
    }
    const workflow = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'region-inspector-proof', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { outer: { id: 'outer', type: '#body', title: 'Batch variants', values: { item: [] }, region: { kind: 'map', elementPorts: ['item'] } } },
        },
        body: {
          id: 'body', name: 'Body', links: {}, nets: {}, reroutes: {}, boundary: {
            inputs: [{ id: 'item', binds: { kind: 'port', node: 'source', port: 'in' } }],
            outputs: [{ id: 'value', binds: { kind: 'port', node: 'source', port: 'value' } }],
          }, nextOrdinal: 4,
          nodes: {
            source: { id: 'source', type: 'ProofSource', title: 'Renamed selector', values: {} },
            inner: { id: 'inner', type: '#nested', values: { item: [] }, region: { kind: 'map', elementPorts: ['item'] } },
            sink: { id: 'sink', type: 'ProofSink', values: {} },
          },
        },
        nested: {
          id: 'nested', name: 'Nested', links: {}, nets: {}, reroutes: {}, boundary: {
            inputs: [{ id: 'item', binds: { kind: 'port', node: 'leaf', port: 'in' } }],
            outputs: [{ id: 'value', binds: { kind: 'port', node: 'leaf', port: 'value' } }],
          }, nextOrdinal: 2,
          nodes: { leaf: { id: 'leaf', type: 'ProofSource', title: 'Nested result', values: {} } },
        },
      },
      view: { graphs: {
        root: { nodes: { outer: { position: { x: 280, y: 180 } } } },
        body: { nodes: {} }, nested: { nodes: {} },
      } },
    }
    app.registerSchemas([
      { type: 'ProofSource', displayName: 'Proof Source', category: 'proof', source: 'v3', isOutputNode: false,
        items: [
          { kind: 'input', id: 'in', type: { kind: 'concrete', name: 'core.int' }, optional: false },
          { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'core.int' } },
        ] },
      { type: 'ProofSink', displayName: 'No-output step', category: 'proof', source: 'v3', isOutputNode: false, items: [] },
    ] as never)
    const diagnostics = app.openDocument(workflow as never, 'Iteration inspector proof')
    if (diagnostics.length > 0) throw new Error(JSON.stringify(diagnostics))
    const tab = app.activeTab()!
    const backend = (app as unknown as { backendForTab(tab: unknown): { id: string } }).backendForTab(tab)
    const registry = app.registryForTab(tab)!
    const artifact = {
      connection: backend.id,
      schemaHash: registry.hash,
      snapshot: tab.store.doc,
      scope: { kind: 'full' },
      prompt: {
        'outer.source': { class_type: 'ProofSource', inputs: {}, outputIds: ['value'] },
        'outer.inner.leaf': { class_type: 'ProofSource', inputs: {}, outputIds: ['value'] },
        'outer.sink': { class_type: 'ProofSink', inputs: {} },
      },
      provenance: {
        fromSource: { outer: ['outer'] },
        toSource: {
          'outer.source': 'outer.source',
          'outer.inner.leaf': 'outer.inner.leaf',
          'outer.sink': 'outer.sink',
        },
      },
    }
    const execution = { connection: backend.id, prompt: 'region-inspector-run' }
    app.store.register(execution as never, artifact as never, Date.now())
    app.store.apply({ kind: 'regionExpanded', execution, timestamp: Date.now() + 1,
      runtimeNodeId: 'outer', regionKind: 'map', binding: 'zip', iterations: 2 } as never)
    app.store.apply({ kind: 'nodeStates', execution, timestamp: Date.now() + 2, snapshot: false, nodes: {
      'outer[0]/source': { state: 'running', value: 0.375, outputs: { value: { typeId: 'core.int', value: 3 } } },
      'outer[0]/sink': { state: 'done' },
      'outer[1]/source': { state: 'cached', outputs: { value: { typeId: 'core.int', value: 8 } } },
      'outer[1]/inner[2]/leaf': { state: 'done', outputs: { value: { typeId: 'core.int' } } },
    } } as never)
    app.store.apply({ kind: 'regionFinished', execution, timestamp: Date.now() + 3,
      runtimeNodeId: 'outer', iterations: 2 } as never)
  })

  await openRailPanel(page, 'Focused')
  const regionPoint = await page.evaluate(() => {
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
    const node = window.__dinksterTest!.renderer!.getScene().nodes.find((entry) => entry.id === 'outer')!
    const rect = document.querySelector('[data-testid=graph-canvas]')!.getBoundingClientRect()
    return { x: rect.left + node.x + node.layout.width / 2, y: rect.top + node.y + node.layout.headerHeight / 2 }
  })
  await page.mouse.click(regionPoint.x, regionPoint.y)
  const inspector = page.getByTestId('region-iteration-inspector')
  await expect(inspector).toBeVisible()
  await expect(inspector).toContainText('2 observed of 2 iterations')
  await expect(inspector).toContainText('Renamed selector')
  await expect(inspector).toContainText('Running')
  await expect(inspector).toContainText('Progress: 38%')
  await expect(inspector).toContainText('outer[0]/source:value')
  if (proofDir !== undefined) {
    await page.screenshot({ path: join(proofDir, 'region-iteration-simple-map.png'), animations: 'disabled', fullPage: true })
  }

  const selects = inspector.locator('select')
  await selects.nth(0).selectOption({ label: 'Iteration 1' })
  await selects.nth(1).selectOption({ label: 'No-output step' })
  await expect(inspector).toContainText('This body node has no inspectable outputs.')
  if (proofDir !== undefined) {
    await page.screenshot({ path: join(proofDir, 'region-iteration-absent-output.png'), animations: 'disabled', fullPage: true })
  }

  await selects.nth(0).selectOption({ label: 'Iteration 2' })
  await expect(inspector).toContainText('Cached or coalesced')
  await expect(inspector).toContainText('outer[1]/source:value')
  if (proofDir !== undefined) {
    await page.screenshot({ path: join(proofDir, 'region-iteration-cached.png'), animations: 'disabled', fullPage: true })
  }

  await selects.nth(0).selectOption({ label: 'Iteration 2 / inner iteration 3' })
  await expect(inspector).toContainText('Nested result')
  await expect(inspector).toContainText('This nested intermediate is no longer retained.')

  if (proofDir !== undefined) {
    await page.screenshot({ path: join(proofDir, 'region-iteration-nested-region.png'), animations: 'disabled', fullPage: true })
  }
})
