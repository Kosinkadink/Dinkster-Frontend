import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  asConnectionId,
  asNodeId,
  compile,
  loadDocument,
  type ExecutionScope,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildDinksterRegistry, DinksterConnection } from '../src/index.js'

const examplesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/examples/loops-and-subgraphs',
)
const readText = (file: string): string => readFileSync(join(examplesRoot, file), 'utf8').replace(/\r\n?/g, '\n')
const readJson = (file: string): unknown => JSON.parse(readText(file))

type CompletedExpectation = {
  readonly state: 'completed'
  readonly output: string
  readonly value: unknown
}
type FailedExpectation = {
  readonly state: 'failed'
  readonly nodeType: string
  readonly message: string
}
type ExampleExpectation = CompletedExpectation | FailedExpectation

const expectedResults = readJson('expected-results.json') as Record<string, ExampleExpectation>
const exampleFiles = Object.keys(expectedResults)
const LIVE_URL = process.env['DINKSTER_LIVE_URL']
const withdrawnDrafts = JSON.parse(readFileSync(
  new URL('../../e2e/tests/withdrawn-drafts.json', import.meta.url), 'utf8',
)) as { readonly nodes: readonly string[] }

const compileExample = (
  file: string,
  registry: ReturnType<typeof buildDinksterRegistry>,
  scope: ExecutionScope = { kind: 'full' },
) => {
  const loaded = loadDocument(readJson(file))
  expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined()
  expect(loaded.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
  const result = compile({
    document: loaded.document as WorkflowDocument,
    revision: 1,
    resolve: registry.resolve,
    scope,
    connection: registry.connection,
    schemaHash: registry.hash,
    ...(registry.graphFeatures === undefined ? {} : { graphFeatures: registry.graphFeatures }),
  })
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error(`${file} did not compile`)
  expect(result.artifact.dinksterGraph).toBeDefined()
  return result.artifact
}

describe.skipIf(!LIVE_URL)('live loop and subgraph executable examples', () => {
  for (const file of exampleFiles) {
  it(`${file} reaches its expected terminal result`, async (context) => {
    const connection = new DinksterConnection({
      id: asConnectionId('example-live'),
      baseUrl: LIVE_URL!,
      clientId: `frontend-examples-${process.pid}`,
    })
    const registry = await connection.fetchSchemas()
    expect(registry.graphFeatures).toContain('regions')
    const document = readJson(file) as WorkflowDocument
    const missing = Object.values(document.graphs)
      .flatMap((graph) => Object.values(graph.nodes).map((node) => node.type))
      .filter((type) => !type.startsWith('#') && registry.resolve(type) === undefined)
    expect(missing.filter((type) => !withdrawnDrafts.nodes.includes(type)),
      `live catalog lacks required nodes: ${missing.join(', ')}`).toEqual([])
    if (missing.length > 0)
      context.skip(`node withdrawn with the drafts, #661: ${missing.join(', ')}`)
    const artifact = compileExample(file, registry, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('region') }],
    })
    expect(artifact.dinksterTargets).toEqual(['region'])
    const submitted = await connection.submit(artifact)
    expect(submitted.ok, JSON.stringify(!submitted.ok && submitted.diagnostics)).toBe(true)
    if (!submitted.ok) return

    const job = await waitForJob(connection, submitted.execution.prompt)
    const expected = expectedResults[file]!
    expect(job['state']).toBe(expected.state)
    if (expected.state === 'failed') {
      expect(job['error']).toMatchObject({ nodeType: expected.nodeType, message: expected.message })
      return
    }

    const descriptor = (job['outputs'] as Record<string, Record<string, Record<string, unknown>>>)
      ['region']?.[expected.output]
    expect(descriptor, JSON.stringify(job)).toBeDefined()
    const value = Array.isArray(descriptor?.['elements'])
      ? (descriptor['elements'] as Array<{ value?: unknown }>).map((element) => element.value)
      : descriptor?.['value']
    expect(value).toEqual(expected.value)
  }, 45_000)
  }
})

async function waitForJob(connection: DinksterConnection, jobId: string): Promise<Record<string, unknown>> {
  const started = Date.now()
  for (;;) {
    const job = await connection.fetchJob(jobId)
    if (job?.state === 'completed' || job?.state === 'failed' || job?.state === 'cancelled') {
      return job as unknown as Record<string, unknown>
    }
    if (Date.now() - started > 30_000) throw new Error(`timeout waiting for example job '${jobId}'`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
