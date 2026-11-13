import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { syntheticWorkflow } from '../src/format/synthetic.js'
import { asConnectionId } from '../src/ids.js'
import { syntheticSchemas as schemas } from './fixtures/historical-schemas.js'

const CHAINS = 60
const CHAIN_LENGTH = 20
const NODES = CHAINS * CHAIN_LENGTH

describe(`subgraph synthetic workload (${CHAINS} instances, ${NODES} expanded nodes)`, () => {
  const compileFull = (doc: WorkflowDocument) =>
    compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })

  it(`flattens to ${NODES} prompt entries within budget (2s); promoted values apply per instance`, () => {
    const doc = loadDocument(
      syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH, subgraphs: true }),
    ).document!
    const t0 = performance.now()
    const result = compileFull(doc)
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    expect(ms, `compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
    if (result.ok) {
      const prompt = result.artifact.prompt as Record<string, { class_type: string; inputs: Record<string, unknown> }>
      expect(Object.keys(prompt)).toHaveLength(NODES)
      // Each instance's promoted color overrides the definition's stored 0.
      const colors = Object.values(prompt)
        .filter((n) => n.class_type === 'dinkster.image.empty_image')
        .map((n) => n.inputs['color'] as number)
        .sort((a, b) => a - b)
      const expected = Array.from({ length: CHAINS }, (_, c) => (c * 7919) % 0xffffff).sort((a, b) => a - b)
      expect(colors).toEqual(expected)
    }
  })
})
