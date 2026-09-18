import { beforeAll, describe, expect, it } from 'vitest'
import { DinksterConnection } from '@dinkster/client'
import { AppState } from '../src/app-state.js'

const LIVE_URL = process.env['DINKSTER_LIVE_URL']

beforeAll(() => {
  Object.defineProperty(globalThis, 'location', { value: new URL('http://localhost/'), configurable: true })
})

describe.skipIf(!LIVE_URL)('live native regions', () => {
  it.each([
    { kind: 'map' as const, input: [1, 2, 3], outputId: 'result', expected: [1, 2, 3] },
    { kind: 'while' as const, input: 7, outputId: 'state', expected: 7 },
  ])('authors, submits, and completes a $kind region through AppState', async ({ kind, input, outputId, expected }) => {
    const app = new AppState()
    const connection = new DinksterConnection({
      id: app.connection.id,
      baseUrl: LIVE_URL!,
      clientId: `audit-r3-${kind}-${Date.now()}`,
    })
    const registry = await connection.fetchSchemas()
    expect(registry.graphFeatures).toContain('regions')
    app.registry.set(registry)

    const tab = app.createWorkflow()
    const root = tab.store.doc.root
    expect(app.createRegion(tab, root, { x: 0, y: 0 }, kind).ok).toBe(true)
    const occurrence = Object.values(tab.store.doc.graphs[root]!.nodes)[0]!
    const inputId = kind === 'map' ? 'item' : 'state'
    expect(tab.store.dispatch({
      command: 'node.setValue',
      params: { graphId: root, nodeId: occurrence.id, inputId, value: input },
    }).ok).toBe(true)
    if (kind === 'while') {
      const bodyId = occurrence.type.slice(1)
      expect(tab.store.dispatch({
        command: 'node.setValue',
        params: { graphId: bodyId, nodeId: 'n1', inputId: 'value', value: false },
      }).ok).toBe(true)
    }

    const compiled = app.compileTab(tab, {
      kind: 'partial',
      targets: [{ instancePath: [], node: occurrence.id }],
    })
    expect(compiled?.ok, JSON.stringify(compiled && !compiled.ok ? compiled.diagnostics : undefined)).toBe(true)
    if (!compiled?.ok) return
    const submitted = await connection.submit(compiled.artifact)
    expect(submitted.ok, JSON.stringify(!submitted.ok ? submitted.diagnostics : undefined)).toBe(true)
    if (!submitted.ok) return

    const jobId = submitted.execution.prompt
    const job = await waitFor(async () => {
      const current = await connection.fetchJob(jobId)
      return current?.state === 'completed' || current?.state === 'failed' ? current : undefined
    }, 30_000)
    expect(job.state, JSON.stringify(job.error)).toBe('completed')
    const query = {
      jobId,
      nodeId: occurrence.id,
      outputId,
    }
    const peek = await connection.values().peek(query)
    expect(peek.available, JSON.stringify(peek)).toBe(true)
    if (!peek.available) return
    const actual = peek.descriptor.elements?.map((element) => element.value) ?? peek.descriptor.value
    console.log(`[regions-live] ${kind} output=${JSON.stringify(actual)}`)
    expect(actual).toEqual(expected)
  }, 45_000)
})

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() - started > timeoutMs) throw new Error('timeout waiting for region job')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
