import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { DinksterConnection } from '@dinkster/client'
import { AppState } from '../src/app-state.js'

const LIVE_URL = process.env['DINKSTER_LIVE_URL']

beforeEach(() => {
  vi.stubGlobal('location', new URL('http://localhost/'))
  vi.stubGlobal('localStorage', new Window().localStorage)
})
afterEach(() => vi.unstubAllGlobals())

describe.skipIf(!LIVE_URL)('live native regions', () => {
  it.each([
    { kind: 'map' as const, input: undefined, outputId: 'result', expected: [] },
    { kind: 'fold' as const, input: undefined, outputId: 'state', expected: 0 },
    { kind: 'while' as const, input: undefined, outputId: 'state', expected: 0 },
    { kind: 'map' as const, input: [1, 2, 3], outputId: 'result', expected: [1, 2, 3] },
    { kind: 'fold' as const, input: [2, 5, -1], outputId: 'state', expected: 6 },
    { kind: 'while' as const, input: 7, outputId: 'state', expected: 7 },
  ])('authors, submits, and completes a $kind region through AppState', async ({ kind, input, outputId, expected }) => {
    const app = new AppState()
    const backend = app.addBackend(LIVE_URL!, undefined, false)!
    const connection = new DinksterConnection({ id: backend.id, baseUrl: LIVE_URL!, clientId: `regions-live-${kind}-${Date.now()}` })
    const registry = await connection.fetchSchemas()
    expect(registry.graphFeatures).toContain('regions')
    backend.registry.set(registry)

    const tab = app.createWorkflow()
    app.setTabTarget(tab.id, backend.id)
    const root = tab.store.doc.root
    const created = await app.createRegion(tab, root, { x: 0, y: 0 }, kind)
    expect(created.ok, JSON.stringify(created.diagnostics)).toBe(true)
    const occurrence = Object.values(tab.store.doc.graphs[root]!.nodes)[0]!
    const inputId = kind === 'while' ? 'state' : 'item'
    if (input !== undefined) {
      expect(tab.store.dispatch({
        command: 'node.setValue',
        params: { graphId: root, nodeId: occurrence.id, inputId, value: input },
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
    app.dispose()
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
