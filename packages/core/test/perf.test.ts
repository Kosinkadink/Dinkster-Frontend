/**
 * Performance budgets for the framework-free hot path (architecture section:
 * "benchmark workflows (1k+ nodes, heavy noodles) ... starting at initial implementation").
 *
 * Budgets are deliberately generous - they exist to catch accidental
 * quadratic blowups in CI, not to microbenchmark. Real frame-time budgets
 * live in the Playwright perf spec, which runs a real renderer.
 */
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { syntheticWorkflow } from '../src/format/synthetic.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import { syntheticSchemas as schemas } from './fixtures/historical-schemas.js'

// 60 chains x 20 nodes = 1200 nodes, 1140 links.
const CHAINS = 60
const CHAIN_LENGTH = 20
const NODES = CHAINS * CHAIN_LENGTH

describe(`synthetic workload (${NODES} nodes)`, () => {
  const json = syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH })

  it(`loads within budget (2s for ${NODES} nodes)`, () => {
    const t0 = performance.now()
    const loaded = loadDocument(json)
    const ms = performance.now() - t0
    expect(loaded.document).toBeDefined()
    expect(ms, `loadDocument took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })

  it(`compiles within budget (2s for ${NODES} nodes)`, () => {
    const doc = loadDocument(json).document!
    const t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(NODES)
    expect(ms, `compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })

  it('partial-scope closure stays fast on deep chains', () => {
    const doc = loadDocument(json).document!
    // Target the last node of the last chain: closure = one full chain.
    // Ordinals interleave nodes and links (node allocated before its incoming
    // link): each chain uses 2*CHAIN_LENGTH-1 ordinals, last node is total-2.
    const lastNodeOrdinal = CHAINS * (2 * CHAIN_LENGTH - 1) - 2
    const t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: {
        kind: 'partial',
        targets: [{ instancePath: [], node: asNodeId(`n${lastNodeOrdinal}`) }],
      },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const ms = performance.now() - t0
    expect(result.ok).toBe(true)
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(CHAIN_LENGTH)
    expect(ms, `partial compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })
})

describe('reroute-dense load (O(R x L) regression guard)', () => {
  // 4800 nodes, 4560 reroutes, 9120 links. The budget permits the one-pass
  // driver index but not per-reroute link scans (see RerouteIndex).
  it('loads within 1s at 4x reroute density', () => {
    const json = syntheticWorkflow({ chains: CHAINS * 4, chainLength: CHAIN_LENGTH, reroutes: true })
    const t0 = performance.now()
    const loaded = loadDocument(json)
    const ms = performance.now() - t0
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(ms, `loadDocument took ${ms.toFixed(1)}ms`).toBeLessThan(1000)
  })
})

describe(`feature-heavy synthetic workload (${NODES} nodes + reroutes/valueSources/nets/groups/selectors)`, () => {
  const json = syntheticWorkflow({
    chains: CHAINS,
    chainLength: CHAIN_LENGTH,
    reroutes: true,
    valueSources: true,
    nets: true,
    groups: true,
    selectors: true,
  })

  it(`loads + compiles within budget (2s each); sources bake, nets link`, () => {
    let t0 = performance.now()
    const doc = loadDocument(json).document!
    const loadMs = performance.now() - t0
    expect(loadMs, `loadDocument took ${loadMs.toFixed(1)}ms`).toBeLessThan(2000)

    t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const compileMs = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    expect(compileMs, `compile took ${compileMs.toFixed(1)}ms`).toBeLessThan(2000)
    if (result.ok) {
      // Value sources compile away: the first chain's EmptyImage carries the
      // baked literal (chain 0 source value is 64), not a link.
      expect(Object.keys(result.artifact.prompt)).toHaveLength(NODES)
      const first = result.artifact.prompt['n0'] as { inputs: Record<string, unknown> }
      expect(first.inputs['width']).toBe(64)
      expect(first.inputs['height']).toBe(64)
    }
  })
})

describe('selector-dense load + compile (regression guard)', () => {
  // 4x chain density at load and 2x at compile, with two candidates on
  // every selector: exercises all-candidate acyclicity, eager selector
  // resolution and closure pruning without changing the one-second budgets.
  const DENSE_CHAINS = CHAINS * 4
  const json = syntheticWorkflow({ chains: DENSE_CHAINS, chainLength: CHAIN_LENGTH, selectors: true })

  it('loads within 1s at 4x selector density', () => {
    const t0 = performance.now()
    const loaded = loadDocument(json)
    const ms = performance.now() - t0
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(Object.keys(loaded.document!.graphs['g0']!.selectors ?? {})).toHaveLength(DENSE_CHAINS)
    expect(ms, `loadDocument took ${ms.toFixed(1)}ms`).toBeLessThan(1000)
  })

  it('compiles within 1s at 2x selector density; unselected decoy branches leave the prompt intact', () => {
    const compileChains = DENSE_CHAINS / 2
    const doc = loadDocument(syntheticWorkflow({ chains: compileChains, chainLength: CHAIN_LENGTH, selectors: true })).document!
    const t0 = performance.now()
    const result = compile({
      document: doc,
      revision: 1,
      resolve: (t) => schemas.get(t),
      scope: { kind: 'full' },
      connection: asConnectionId('c0'),
      schemaHash: 'perf',
    })
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    // Every chain node stays reachable through its fixed 'ca' branch; the
    // decoy 'cb' feed is pruned as a LINK but its producer (the chain source)
    // is still in closure via the chain itself.
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(compileChains * CHAIN_LENGTH)
    expect(ms, `compile took ${ms.toFixed(1)}ms`).toBeLessThan(1000)
  })
})

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

  it('nested pass-through wrappers (depth 8) do not blow up flattening', () => {
    const depth = 8
    const loaded = loadDocument(
      syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH, subgraphs: true, subgraphDepth: depth }),
    )
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const doc = loaded.document!
    expect(Object.keys(doc.graphs)).toHaveLength(depth + 1)
    const t0 = performance.now()
    const result = compileFull(doc)
    const ms = performance.now() - t0
    expect(result.ok, JSON.stringify(!result.ok ? result.diagnostics : [])).toBe(true)
    // Wrappers add no executable nodes: same expanded prompt, similar cost.
    if (result.ok) expect(Object.keys(result.artifact.prompt)).toHaveLength(NODES)
    expect(ms, `depth-${depth} compile took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })
})
