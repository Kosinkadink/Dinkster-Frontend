/**
 * Scene-build performance budgets on the synthetic 1k+ node workload, with
 * native image interfaces. Generous budgets - these catch quadratic blowups in
 * CI, not micro-regressions. Real frame times are measured by the Playwright
 * perf spec against a live renderer.
 */
import { describe, expect, it } from 'vitest'
import {
  documentResolver,
  loadDocument,
  syntheticWorkflow,
  type WorkflowDocument,
} from '@dinkster/core'
import { syntheticSchemas as schemas } from './historical-schemas.js'
import { buildScene } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = () => ({ viewId: 'core.line', rows: 1 })

const CHAINS = 60
const CHAIN_LENGTH = 20
const NODES = CHAINS * CHAIN_LENGTH

describe(`buildScene on synthetic workload (${NODES} nodes)`, () => {
  const doc = loadDocument(syntheticWorkflow({ chains: CHAINS, chainLength: CHAIN_LENGTH }))
    .document as WorkflowDocument
  const resolve = documentResolver(doc, (t) => schemas.get(t))

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
