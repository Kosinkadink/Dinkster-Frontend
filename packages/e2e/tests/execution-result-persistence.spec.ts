import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

const PROOF_DIR = '/tmp/dinkster-frontend-347-proof'
const SOURCE_DIGEST = `blake3:${'d'.repeat(64)}`
const CLIENT_ID = 'issue-347-client:local'
const PRINCIPAL = { principalId: 'issue-347-user', kind: 'human' }

const catalog = {
  schemaVersion: 32,
  epoch: 1,
  dinkster: { version: 'issue-347-runtime', schemaWire: 32 },
  nodes: {
    RuntimeScalar: {
      schemaVersion: 32, nodeType: 'RuntimeScalar', displayName: 'Runtime Scalar',
      category: 'test', signature: 'runtime-scalar-v1',
      interface: [{ role: 'output', id: 'value', type: { kind: 'concrete', types: ['core.float'] } }],
    },
    MathExpression: {
      schemaVersion: 32, nodeType: 'MathExpression', displayName: 'Math Expression',
      category: 'test', outputNode: true, signature: 'math-expression-v1',
      interface: [
        { role: 'input', id: 'x', required: true, type: { kind: 'concrete', types: ['core.float'] },
          default: 0, widget: { type: 'NUMBER', min: -1_000_000, max: 1_000_000 } },
        { role: 'input', id: 'expression', required: true, type: { kind: 'concrete', types: ['core.string'] },
          default: 'x * 2', widget: { type: 'STRING', multiline: false } },
        { role: 'output', id: 'value', type: { kind: 'concrete', types: ['core.float'] } },
      ],
    },
    OtherBranch: {
      schemaVersion: 32, nodeType: 'OtherBranch', displayName: 'Other Branch',
      category: 'test', outputNode: true, signature: 'other-branch-v1',
      interface: [
        { role: 'input', id: 'value', required: true, type: { kind: 'concrete', types: ['core.int'] },
          default: 3, widget: { type: 'NUMBER', min: -1_000_000, max: 1_000_000 } },
        { role: 'output', id: 'value', type: { kind: 'concrete', types: ['core.int'] } },
      ],
    },
  },
}

const workflow = {
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'issue-347-persistence', root: 'g0',
  graphs: { g0: {
    id: 'g0', name: 'root',
    nodes: {
      producer: { id: 'producer', type: 'RuntimeScalar', values: {} },
      math: { id: 'math', type: 'MathExpression', values: { expression: 'x * 2' } },
      other: { id: 'other', type: 'OtherBranch', values: { value: 3 } },
    },
    links: {
      l0: { id: 'l0', from: { node: 'producer', port: 'value' }, to: { node: 'math', port: 'x' } },
    },
    nets: {}, reroutes: {}, nextOrdinal: 4,
  } },
  view: { graphs: { g0: { nodes: {
    producer: { position: { x: 90, y: 160 } },
    math: { position: { x: 450, y: 120 }, size: { width: 360, height: 190 } },
    other: { position: { x: 900, y: 160 } },
  } } } },
}

test('runtime scalar survives an unrelated branch and browser reload with cached provenance', async ({ page }) => {
  test.setTimeout(120_000)
  await mkdir(PROOF_DIR, { recursive: true })
  let servedCatalog: unknown = catalog
  let servedWorkflow: unknown = workflow
  let servedPrincipalId = PRINCIPAL.principalId
  let assetAvailable = true
  let valuesMode: 'available' | 'unavailable' | 'evicted' = 'available'
  await page.addInitScript(() => localStorage.setItem('dinkster.workspaceClientId', 'issue-347-client'))
  await page.route('**/api/**', (route) => route.fulfill({ status: 404, json: { error: 'not used by persistence proof' } }))
  await page.route('/api/composition', (route) => route.fulfill({ json: { packs: {} } }))
  await page.route('/api/diagnostics*', (route) => route.fulfill({ json: { diagnostics: [] } }))
  await page.route('/memory/status', (route) => route.fulfill({ status: 404, json: { error: 'not used by persistence proof' } }))
  await page.routeWebSocket('**/api/events?*', () => {})
  await page.route('/supervisor/status', (route) => route.fulfill({ status: 502, body: 'no supervisor' }))
  await page.route('/system_stats', (route) => route.fulfill({ json: { system: {}, devices: [] } }))
  await page.route('/api/nodes*', (route) => route.fulfill({ json: servedCatalog }))
  await page.route('/api/history/*', (route) => {
    const runId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    const jobId = runId === 'run-a' ? 'job-a' : runId === 'run-b' ? 'job-b' : ''
    if (jobId === '') return route.fulfill({ status: 404, json: { error: 'not found' } })
    return route.fulfill({ json: {
      runId, jobRef: runId, scope: 'local', clientId: CLIENT_ID, jobId,
      state: 'completed', priority: 0, submittedAt: 100, finishedAt: runId === 'run-a' ? 110 : 210,
      executed: runId === 'run-a' ? 3 : 1, cached: 0, skipped: 0,
      sourceDocument: SOURCE_DIGEST, principalId: servedPrincipalId, principalKind: PRINCIPAL.kind,
    } })
  })
  await page.route('/api/jobs/*/*', (route) => {
    const parts = new URL(route.request().url()).pathname.split('/')
    const jobId = decodeURIComponent(parts.at(-1)!)
    const runId = jobId === 'job-a' ? 'run-a' : jobId === 'job-b' ? 'run-b' : ''
    if (runId === '') return route.fulfill({ status: 404, json: { error: 'not found' } })
    const nodeStates = jobId === 'job-a'
      ? { producer: 'completed', math: 'completed', other: 'completed' }
      : { other: 'completed' }
    const outputs = jobId === 'job-a'
      ? { producer: { value: { typeId: 'core.float', fingerprint: 'scalar-7-5', value: 7.5 } } }
      : { other: { value: { typeId: 'core.int', fingerprint: 'scalar-3', value: 3 } } }
    return route.fulfill({ json: {
      clientId: decodeURIComponent(parts.at(-2)!), jobId, jobRef: runId, runId, scope: 'local',
      state: 'completed', nodeStates, outputs, artifacts: [],
      submittedBy: { ...PRINCIPAL, principalId: servedPrincipalId },
      sourceDocument: SOURCE_DIGEST,
    } })
  })
  await page.route('/api/values*', (route) => {
    if (valuesMode === 'unavailable') return route.fulfill({ status: 503, json: {
      available: false, reason: 'temporarily-unavailable', error: 'value service unavailable',
    } })
    if (valuesMode === 'evicted') return route.fulfill({ status: 410, json: {
      available: false, reason: 'evicted', error: 'value evicted',
    } })
    const url = new URL(route.request().url())
    const nodeId = url.searchParams.get('nodeId')
    const descriptor = nodeId === 'producer'
      ? { typeId: 'core.float', fingerprint: 'scalar-7-5', value: 7.5 }
      : nodeId === 'math'
        ? { typeId: 'core.float', fingerprint: 'scalar-15', value: 15 }
      : { typeId: 'core.int', fingerprint: 'scalar-3', value: 3 }
    return route.fulfill({ json: { available: true, descriptor, renditions: [] } })
  })
  await page.route(`/api/assets/${encodeURIComponent(SOURCE_DIGEST)}`, (route) => assetAvailable
    ? route.fulfill({ contentType: 'application/json', body: JSON.stringify(servedWorkflow) })
    : route.fulfill({ status: 410, json: { error: 'evicted' } }))

  await page.goto('/')
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.backends.get()[0]?.registry.get()?.schemas.size)).toBe(3)
  await page.evaluate((document) => {
    window.__dinksterTest!.app.openDocument(document, 'Execution result persistence')
    window.__dinksterTest!.renderer!.setViewport({ x: 0, y: 0, scale: 1 })
  }, workflow)
  await page.waitForFunction(() => window.__dinksterTest!.app.activeTab()?.id === 'issue-347-persistence')

  await page.evaluate(({ sourceDigest, principal }) => {
    const app = window.__dinksterTest!.app
    const tab = app.activeTab()!
    const full = app.compileTab(tab)
    if (!full?.ok) throw new Error('full compile failed')
    const store = app.store as unknown as {
      register(ref: unknown, artifact: unknown, now: number, identity: unknown): void
      apply(event: unknown): void
      hydrateSubmittedBy(ref: unknown, submittedBy: unknown): void
    }
    const runA = { connection: full.artifact.connection, prompt: 'job-a' }
    store.register(runA, full.artifact, 100, { jobRef: 'run-a', sourceDocument: sourceDigest })
    store.apply({ kind: 'nodeStates', execution: runA, timestamp: 105, nodes: {
      producer: { state: 'done', outputs: { value: { typeId: 'core.float', value: 7.5 } } },
      math: { state: 'done', outputs: { value: { typeId: 'core.float', value: 15 } } },
      other: { state: 'done', outputs: { value: { typeId: 'core.int', value: 3 } } },
    } })
    store.apply({ kind: 'completed', execution: runA, timestamp: 110 })
    store.hydrateSubmittedBy(runA, principal)

    const partial = (app.compileTab as unknown as (tab: unknown, scope: unknown) => ReturnType<typeof app.compileTab>)(
      tab,
      { kind: 'partial', targets: [{ instancePath: [], node: 'other' }] },
    )
    if (!partial?.ok) throw new Error('partial compile failed')
    const runB = { connection: partial.artifact.connection, prompt: 'job-b' }
    store.register(runB, partial.artifact, 200, { jobRef: 'run-b', sourceDocument: sourceDigest })
    store.apply({ kind: 'nodeStates', execution: runB, timestamp: 205, nodes: {
      other: { state: 'done', outputs: { value: { typeId: 'core.int', value: 3 } } },
    } })
    store.apply({ kind: 'completed', execution: runB, timestamp: 210 })
    store.hydrateSubmittedBy(runB, principal)
  }, { sourceDigest: SOURCE_DIGEST, principal: PRINCIPAL })

  await expect(page.getByTestId('canvas-widget-a11y').filter({ hasText: 'Math Expression, x' })).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.executionResults'))).toContain('run-a')
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.openTabs'))).toContain('issue-347-persistence')
  await page.getByTestId('canvas-widget-a11y').filter({ hasText: 'Math Expression, x' }).focus()
  await expect(page.getByTestId('app-tooltip')).toContainText('Retained last-resolved value: 7.5')
  await page.screenshot({ path: `${PROOF_DIR}/01-unrelated-branch-retains-runtime-value.png`, animations: 'disabled' })

  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size), { timeout: 15_000 }).toBe(2)
  await page.getByTestId('canvas-widget-a11y').filter({ hasText: 'Math Expression, x' }).focus()
  await expect(page.getByTestId('app-tooltip')).toContainText('Retained last-resolved value: 7.5')
  await page.screenshot({ path: `${PROOF_DIR}/02-reload-retains-runtime-value.png`, animations: 'disabled' })

  const persisted = await page.evaluate(() => localStorage.getItem('dinkster.executionResults'))
  expect(persisted).not.toBeNull()
  const restoreSavedEnvelope = () => page.evaluate((raw) => {
    localStorage.setItem('dinkster.executionResults', raw!)
  }, persisted)

  servedPrincipalId = 'different-user'
  await restoreSavedEnvelope()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size)).toBe(0)

  servedPrincipalId = PRINCIPAL.principalId
  servedWorkflow = {
    ...workflow,
    graphs: { g0: { ...workflow.graphs.g0, nodes: {
      ...workflow.graphs.g0.nodes,
      other: { ...workflow.graphs.g0.nodes.other, values: { value: 4 } },
    } } },
  }
  await restoreSavedEnvelope()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size)).toBe(0)

  servedWorkflow = workflow
  assetAvailable = false
  await restoreSavedEnvelope()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size)).toBe(0)

  assetAvailable = true
  valuesMode = 'unavailable'
  await restoreSavedEnvelope()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size)).toBe(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.executionResults'))).toContain('run-a')

  valuesMode = 'evicted'
  await restoreSavedEnvelope()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size)).toBe(0)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('dinkster.executionResults') ?? '')).not.toContain('run-a')

  valuesMode = 'available'
  servedCatalog = {
    ...catalog,
    nodes: { ...catalog.nodes, RuntimeScalar: { ...catalog.nodes.RuntimeScalar, signature: 'runtime-scalar-v2' } },
  }
  await restoreSavedEnvelope()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size)).toBe(0)

  servedCatalog = { ...catalog, dinkster: { ...catalog.dinkster, version: 'different-runtime' } }
  await restoreSavedEnvelope()
  await page.reload()
  await expect.poll(() => page.evaluate(() => window.__dinksterTest?.app.store.executions.get().size)).toBe(0)
})
