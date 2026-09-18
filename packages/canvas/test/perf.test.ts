/**
 * Scene-build performance budgets on the synthetic 1k+ node workload, with
 * real parsed schemas. Generous budgets - these catch quadratic blowups in
 * CI, not micro-regressions. Real frame times are measured by the Playwright
 * perf spec against a live renderer.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  documentResolver,
  loadDocument,
  parseObjectInfo,
  syntheticWorkflow,
  type ObjectInfoEntry,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildScene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const objectInfo = JSON.parse(
  readFileSync(join(coreRoot, 'fixtures/object_info.json'), 'utf8'),
) as Record<string, ObjectInfoEntry>
const { schemas } = parseObjectInfo(objectInfo)

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = () => ({ viewId: 'core.line', rows: 1 })

const CHAINS = 60
const CHAIN_LENGTH = 20
const NODES = CHAINS * CHAIN_LENGTH

describe(`buildScene on synthetic workload (${NODES} nodes)`, () => {
  const doc = loadDocument(syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH }))
    .document as WorkflowDocument
  const resolve = documentResolver(doc, (t) => schemas.get(t))

  it('produces a complete scene', () => {
    const scene = buildScene({
      document: doc,
      graphId: 'g0',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    expect(scene.nodes).toHaveLength(NODES)
    expect(scene.links).toHaveLength(NODES - CHAINS)
    // Every link endpoint is pin-anchored (no dangling coordinates).
    for (const link of scene.links) {
      expect(Number.isFinite(link.x1 + link.y1 + link.x2 + link.y2)).toBe(true)
    }
  })

  it(`builds within budget (2s for ${NODES} nodes)`, () => {
    const t0 = performance.now()
    buildScene({
      document: doc,
      graphId: 'g0',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const ms = performance.now() - t0
    expect(ms, `buildScene took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })
})

describe(`buildScene on feature-heavy workload (${NODES} nodes + reroutes/valueSources/nets/groups/selectors)`, () => {
  const loaded = loadDocument(
    syntheticWorkflow({
      chains: CHAINS,
      chainLength: CHAIN_LENGTH,
      reroutes: true,
      valueSources: true,
      nets: true,
      groups: true,
      selectors: true,
    }),
  )
  const doc = loaded.document as WorkflowDocument
  const resolve = documentResolver(doc, (t) => schemas.get(t))

  it('loads invariant-clean and produces a complete scene', () => {
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const scene = buildScene({
      document: doc,
      graphId: 'g0',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    expect(scene.nodes).toHaveLength(NODES)
    expect(scene.valueSources).toHaveLength(CHAINS)
    expect(scene.groups).toHaveLength(CHAINS)
    // One selector per chain, each with a traced concrete output (both
    // branches are IMAGE producers) - solving runs across every candidate.
    expect(scene.selectors).toHaveLength(CHAINS)
    for (const sel of scene.selectors) {
      expect(sel.typeName).toBe('IMAGE')
      expect(sel.candidates.map((c) => c.typeName)).toEqual(['IMAGE', 'IMAGE'])
    }
    // Every source derives a clean INT spec from its two consumers.
    for (const vs of scene.valueSources) {
      expect(vs.specState).toBe('derived')
      expect(vs.conflict).toBe(false)
    }
    // Each chain's final segment rides a net; it still renders a noodle.
    expect(scene.links.filter((l) => l.netId !== undefined)).toHaveLength(CHAINS)
    for (const link of scene.links) {
      expect(Number.isFinite(link.x1 + link.y1 + link.x2 + link.y2)).toBe(true)
    }
  })

  it(`builds within the same budget as the plain workload (2s)`, () => {
    const t0 = performance.now()
    buildScene({
      document: doc,
      graphId: 'g0',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const ms = performance.now() - t0
    expect(ms, `buildScene took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })
})

describe(`buildScene on subgraph workload (${CHAINS} instances of a shared definition)`, () => {
  const loaded = loadDocument(syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH, subgraphs: true }))
  const doc = loaded.document as WorkflowDocument
  const resolve = documentResolver(doc, (t) => schemas.get(t))

  it('loads invariant-clean; root scene derives boundary pins per instance', () => {
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const scene = buildScene({
      document: doc,
      graphId: 'g0',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    expect(scene.nodes).toHaveLength(CHAINS * 2)
    expect(scene.links).toHaveLength(CHAINS)
    for (const link of scene.links) {
      expect(Number.isFinite(link.x1 + link.y1 + link.x2 + link.y2)).toBe(true)
    }
  })

  it('builds the definition graph scene too (editing view)', () => {
    const scene = buildScene({
      document: doc,
      graphId: 'g1',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    expect(scene.nodes).toHaveLength(CHAIN_LENGTH - 1)
  })

  it(`root scene builds within budget (2s)`, () => {
    const t0 = performance.now()
    buildScene({
      document: doc,
      graphId: 'g0',
      resolve,
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const ms = performance.now() - t0
    expect(ms, `buildScene took ${ms.toFixed(1)}ms`).toBeLessThan(2000)
  })
})
