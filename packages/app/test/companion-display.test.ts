/**
 * Companion display derivation: document literals always show (exact),
 * producer scalars show only from the tab's bound execution's inline
 * summaries - exact on frozen tabs (the document IS the run's snapshot),
 * exact on live tabs only when the upstream-recipe oracle (exactProducer /
 * liveExactnessFor) proves every contributing occurrence current, stale
 * otherwise, and producer lookup goes through a caller-supplied occurrence
 * resolver (runtimeIdsOf), abstaining when the resolver is absent.
 *
 * Which execution gets bound to a tab is overlay.test.ts territory; this
 * suite covers the pure derivation the canvas host feeds the renderer.
 */
import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLinkId,
  asNodeId,
  asPortId,
  asRerouteId,
  asValueSourceId,
  type CompileArtifact,
  type GraphDef,
  type NodeSchema,
  type NodeProgress,
  type ValueSourceData,
} from '@dinkster/core'
import { deriveCompanions, liveExactnessFor } from '../src/companion-display.js'

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const tap = (node: string, inputId: string) => ({ node: asNodeId(node), tap: asPortId(inputId) })
const rr = (id: string) => ({ reroute: asRerouteId(id) })
const vsrc = (id: string) => ({ valueSource: asValueSourceId(id) })
const node = (id: string) => ({ id: asNodeId(id), type: 'T', values: { steps: 20 } })
const link = (id: string, from: object, to: object) =>
  ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

/** Value-source -> reroute -> consumer.steps literal chain. */
const literalGraph = graph({
  id: 'root',
  nodes: { consumer: node('consumer') },
  reroutes: { r1: { id: asRerouteId('r1') } },
  valueSources: { v1: { id: asValueSourceId('v1'), value: 7 } as ValueSourceData },
  links: {
    l1: link('l1', vsrc('v1'), rr('r1')),
    l2: link('l2', rr('r1'), port('consumer', 'steps')),
  },
})

/** producer.out -> consumer.steps runtime chain. */
const producerGraph = graph({
  id: 'root',
  nodes: { producer: node('producer'), consumer: node('consumer') },
  links: { l1: link('l1', port('producer', 'out'), port('consumer', 'steps')) },
})

const done = (outputs?: NodeProgress['outputs']): NodeProgress => ({
  state: 'done',
  ...(outputs !== undefined ? { outputs } : {}),
})

describe('deriveCompanions: literals', () => {
  it('a value-source chain displays its literal, exact, with no execution', () => {
    const { companions } = deriveCompanions({
      def: literalGraph,
      frozen: false,
      runtimeIdsOf: (id) => [id],
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 7 })
  })

  it.each([[0, 7], ['', 'changed']] as const)('keeps an unstored tap default %j and a later stored value in companion presentation', (fallback, stored) => {
    const def = graph({
      id: 'root',
      nodes: {
        source: { id: asNodeId('source'), type: 'Source', values: {} },
        consumer: node('consumer'),
      },
      links: { l1: link('l1', tap('source', 'value'), port('consumer', 'steps')) },
    })
    const before = deriveCompanions({
      def,
      frozen: false,
      tapValueOf: (nodeId, inputId) => nodeId === 'source' && inputId === 'value' ? fallback : undefined,
    })
    expect(before.companions['consumer']?.['steps']).toEqual({ value: fallback })
    ;(def.nodes['source']!.values as Record<string, unknown>)['value'] = stored
    const after = deriveCompanions({ def, frozen: false, tapValueOf: () => undefined })
    expect(after.companions['consumer']?.['steps']).toEqual({ value: stored })
  })

  it('keeps a declared known literal distinct from recorded and estimated values', () => {
    const schema: NodeSchema = {
      type: 'T', displayName: 'Primitive', category: '', source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'steps', type: { kind: 'concrete', name: 'INT' }, optional: true },
        { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'INT' }, knownValue: { input: 'steps' } },
      ],
    }
    const { companions } = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done({ out: { typeId: 'INT', value: 42 } }) },
      frozen: false,
      runtimeIdsOf: (id) => [id],
      exactProducer: () => false,
      estimates: new Map([['producer', { outputs: { out: 99 } }]]),
      resolveSchema: () => schema,
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 20 })
  })
})

describe('deriveCompanions: producers', () => {
  const inline = { out: { typeId: 'INT', value: 42 } }

  it('an inline scalar from the bound execution displays; frozen tabs are exact', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: true,
      runtimeIdsOf: (id) => [id],
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 42 })
  })

  it('reads a region state value through its compiled output alias', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done({ state: { typeId: 'INT', value: 42 } }) },
      frozen: true,
      runtimeIdsOf: (id) => [id],
      outputAliases: { producer: { out: 'state' } },
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 42 })
  })

  it('no execution means no producer companion (the input is still driven)', () => {
    const derived = deriveCompanions({
      def: producerGraph,
      frozen: false,
      runtimeIdsOf: (id) => [id],
    })
    expect(derived.companions['consumer']).toBeUndefined()
    // The read-only guard still sees the driven input: connect blocks editing
    // even before any value flows.
    expect(derived.sources.get('consumer')?.get('steps')).toEqual({
      kind: 'producer',
      node: 'producer',
      output: 'out',
    })
  })

  it('several agreeing occurrences display the shared value', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      frozen: true,
      execNodes: {
        producer: done({ out: { typeId: 'INT', value: 42 } }),
        'producer[1]': done({ out: { typeId: 'INT', value: 42 } }),
      },
      runtimeIdsOf: (id) => (id === 'producer' ? ['producer', 'producer[1]'] : [id]),
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 42 })
  })

  it('disagreeing occurrences abstain (ambiguous value never presented as exact)', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      frozen: true,
      execNodes: {
        producer: done({ out: { typeId: 'INT', value: 42 } }),
        'producer[1]': done({ out: { typeId: 'INT', value: 43 } }),
      },
      runtimeIdsOf: (id) => (id === 'producer' ? ['producer', 'producer[1]'] : [id]),
    })
    expect(companions['consumer']).toBeUndefined()
  })
})

describe('deriveCompanions: live exactness (exactProducer)', () => {
  const inline = { out: { typeId: 'INT', value: 42 } }

  it('a passing oracle sheds the stale mark on a live tab', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: false,
      runtimeIdsOf: (id) => [id],
      exactProducer: () => true,
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 42 })
  })

  it('a failing oracle keeps the value stale', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: false,
      runtimeIdsOf: (id) => [id],
      exactProducer: () => false,
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 42, stale: true })
  })

  it('EVERY contributing occurrence must pass; one failure is stale', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      frozen: false,
      execNodes: {
        producer: done(inline),
        'producer[1]': done(inline),
      },
      runtimeIdsOf: (id) => (id === 'producer' ? ['producer', 'producer[1]'] : [id]),
      exactProducer: (rid) => rid === 'producer', // producer[1] fails
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 42, stale: true })
  })

  it('frozen tabs ignore the oracle entirely (snapshot is authoritative)', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: true,
      runtimeIdsOf: (id) => [id],
      exactProducer: () => false,
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 42 })
  })

  it('labels only explicit retained contributors and treats mixed contributors as retained', () => {
    const execNodes = {
      producer: done(inline),
      'producer[1]': { ...done(inline), state: 'cached' as const },
    }
    const current = deriveCompanions({
      def: producerGraph, execNodes, frozen: false,
      runtimeIdsOf: (id) => (id === 'producer' ? ['producer', 'producer[1]'] : [id]),
      exactProducer: () => true,
    })
    expect(current.companions['consumer']?.['steps']).toEqual({ value: 42 })
    const mixed = deriveCompanions({
      def: producerGraph, execNodes, frozen: false,
      runtimeIdsOf: (id) => (id === 'producer' ? ['producer', 'producer[1]'] : [id]),
      exactProducer: () => true,
      retainedRuntimeIds: new Set(['producer[1]']),
    })
    expect(mixed.companions['consumer']?.['steps']).toEqual({ value: 42, state: 'cached' })
  })

})

describe('liveExactnessFor: comparability gates', () => {
  const prompt = {
    producer: { class_type: 'Int', inputs: { value: 7 } },
    consumer: { class_type: 'Use', inputs: { steps: ['producer', 0] } },
  }
  const artifact = (over?: Partial<CompileArtifact>): CompileArtifact =>
    ({ schemaHash: 'h1', prompt, ...over }) as unknown as CompileArtifact
  const random = { graph: 'root', selector: 's', policy: 'random', candidate: 'a' } as const

  it('invalidates only the transitive cone downstream of a random selector', () => {
    const withRandomCone = artifact({
      choices: [random],
      provenance: {
        toSource: {}, fromSource: {}, randomSelectorInputs: { consumer: ['steps'] },
      },
    })
    const independent = artifact({
      choices: [random],
      prompt: { ...prompt, lone: { class_type: 'Int', inputs: { value: 1 } } },
      provenance: {
        toSource: {}, fromSource: {}, randomSelectorInputs: { consumer: ['steps'] },
      },
    })
    const oracle = liveExactnessFor(independent, withRandomCone)
    expect(oracle?.('consumer')).toBe(false)
    expect(oracle?.('producer')).toBe(true)
  })

  it('past the gates, verdicts follow upstream recipe comparison per node', () => {
    const edited = {
      producer: { class_type: 'Int', inputs: { value: 8 } }, // changed literal
      consumer: { class_type: 'Use', inputs: { steps: ['producer', 0] } },
      lone: { class_type: 'Int', inputs: { value: 1 } },
    }
    const both = { ...prompt, lone: edited.lone }
    const oracle = liveExactnessFor(
      artifact({ prompt: edited as never }),
      artifact({ prompt: both as never }),
    )
    expect(oracle?.('consumer')).toBe(false) // upstream literal diverged
    expect(oracle?.('lone')).toBe(true) // untouched branch
  })
})

describe('deriveCompanions: mirror estimates', () => {
  const inline = { out: { typeId: 'INT', value: 42 } }
  const estimates = new Map([['producer', { outputs: { out: 55 } }]])

  it('shows the estimate when no execution recorded a value', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      frozen: false,
      runtimeIdsOf: (id) => [id],
      estimates,
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 55, state: 'estimate' })
  })

  it('replaces an unproven recorded value (the estimate reflects the NEXT run)', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: false,
      runtimeIdsOf: (id) => [id],
      estimates,
    })
    expect(companions['consumer']?.['steps']).toEqual({ value: 55, state: 'estimate' })
  })

  it('never displaces exact, retained, or frozen values', () => {
    const exact = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: false,
      runtimeIdsOf: (id) => [id],
      exactProducer: () => true,
      estimates,
    })
    expect(exact.companions['consumer']?.['steps']).toEqual({ value: 42 })
    const retained = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: false,
      runtimeIdsOf: (id) => [id],
      retainedRuntimeIds: new Set(['producer']),
      estimates,
    })
    expect(retained.companions['consumer']?.['steps']).toEqual({ value: 42, state: 'cached' })
    const frozen = deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done(inline) },
      frozen: true,
      runtimeIdsOf: (id) => [id],
      estimates,
    })
    expect(frozen.companions['consumer']?.['steps']).toEqual({ value: 42 })
  })

  it('frozen tabs never estimate, even without a recorded value', () => {
    const { companions } = deriveCompanions({
      def: producerGraph,
      frozen: true,
      runtimeIdsOf: (id) => [id],
      estimates,
    })
    expect(companions['consumer']?.['steps']).toBeUndefined()
  })

})

describe('deriveCompanions: dormant values are untouched', () => {
  it('derivation never mutates node.values (display substitutes, storage stays)', () => {
    const before = JSON.stringify(producerGraph)
    deriveCompanions({
      def: producerGraph,
      execNodes: { producer: done({ out: { typeId: 'INT', value: 42 } }) },
      frozen: false,
      runtimeIdsOf: (id) => [id],
    })
    expect(JSON.stringify(producerGraph)).toBe(before)
    expect(producerGraph.nodes['consumer']?.values['steps']).toBe(20)
  })

})
