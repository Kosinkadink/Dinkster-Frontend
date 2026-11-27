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
  asConnectionId,
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  boundaryOf,
  compile,
  documentResolver,
  occurrenceKey,
  type CompileArtifact,
  type GraphDef,
  type NodeSchema,
  type NodeProgress,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildScene, defaultTokens } from '@dinkster/canvas'
import { deriveCompanions, liveExactnessFor, recordedListCountEstimates } from '../src/companion-display.js'
import type { ExecutionState } from '@dinkster/client'

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const tap = (node: string, inputId: string) => ({ node: asNodeId(node), tap: asPortId(inputId) })
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

it('carries only complete current occurrence summaries onto list wires as estimates', () => {
  const list = { kind: 'list' as const, element: { kind: 'concrete' as const, name: 'STRING' } }
  const source: NodeSchema = { type: 'Source', displayName: 'Source', category: '', source: 'v3', isOutputNode: false, body: [
    { kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: true },
    { kind: 'output', id: 'out', type: list },
  ] }
  const sink: NodeSchema = { ...source, type: 'Sink', body: [
    { kind: 'input', id: 'in', type: list, optional: false },
    { kind: 'output', id: 'out', type: list, listCount: { input: 'in' } },
  ] }
  const root = graph({ id: 'root', nodes: {
    a: { id: asNodeId('a'), type: '#body', values: {} }, b: { id: asNodeId('b'), type: '#body', values: {} },
  } })
  const body = graph({ id: 'body', nodes: {
    producer: { id: asNodeId('producer'), type: source.type, values: { seed: 1 } },
    consumer: { id: asNodeId('consumer'), type: sink.type, values: {} },
  }, links: { l: link('l', port('producer', 'out'), port('consumer', 'in')) },
  boundary: boundaryOf([], [{ id: 'out', binds: { kind: 'port', ...port('consumer', 'out') } }]) })
  const document: WorkflowDocument = { format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('counts'),
    root: root.id, graphs: { root, body }, view: { graphs: {} } }
  const resolve = (type: string) => type === source.type ? source : type === sink.type ? sink : undefined
  const connection = asConnectionId('counts')
  const compiled = compile({ document, revision: 1, resolve, scope: { kind: 'full' }, connection, schemaHash: 'h' })
  expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
  if (!compiled.ok) return
  const artifact = compiled.artifact
  const producerId = (instance: string) => Object.entries(artifact.provenance.toSource)
    .find(([, source]) => source === occurrenceKey({ instancePath: [asNodeId(instance)], node: asNodeId('producer') }))![0]
  const a = producerId('a'), b = producerId('b')
  const nodes: Record<string, NodeProgress> = {
    [a]: done({ out: { typeId: 'list<STRING>', length: 0 } }),
    [b]: done({ out: { typeId: 'list<STRING>', length: 7 } }),
  }
  const execution = { ref: { connection }, artifact, nodes } as unknown as ExecutionState
  const read = (instance: string, frozen = false, live = artifact, run = execution) => {
    const estimateOf = recordedListCountEstimates({ execution: run, frozen, live })
    return buildScene({ document, graphId: body.id, resolve: documentResolver(document, resolve),
      ...(estimateOf === undefined ? {} : { listCountEstimateOf: estimateOf }),
      occurrence: { owner: { instancePath: [], node: asNodeId(instance) }, plannerAvailable: true },
      tokens: defaultTokens, measure: text => text.length * 6, widgetMeasure: () => ({ viewId: 'core.number', rows: 1 }),
    }).links
  }
  for (const [instance, count] of [['a', 0], ['b', 7]] as const) {
    const wires = read(instance)
    expect(wires.map(wire => wire.listCountFact)).toEqual(Array(2).fill({ kind: 'estimate', count, sources: ['last-run'] }))
    expect(wires.map(wire => wire.listCount)).toEqual([undefined, undefined])
  }
  const changed = { ...artifact, prompt: { ...artifact.prompt, [a]: { ...artifact.prompt[a]!, inputs: { seed: 2 } } } }
  expect(read('a', false, changed).map(wire => wire.listCountFact)).toEqual([undefined, undefined])
  expect(read('b', false, changed).map(wire => wire.listCountFact)).toEqual(Array(2).fill({ kind: 'estimate', count: 7, sources: ['last-run'] }))
  const aliased = { ...execution, artifact: { ...artifact, provenance: { ...artifact.provenance,
    outputAliases: { [b]: { out: 'state' } },
  } }, nodes: { ...nodes, [b]: done({ state: { typeId: 'list<STRING>', length: 7 } }) } }
  expect(read('b', false, artifact, aliased).map(wire => wire.listCountFact)).toEqual(Array(2).fill({ kind: 'estimate', count: 7, sources: ['last-run'] }))
  nodes[`${a}[1]`] = done({ out: { typeId: 'list<STRING>', length: 2 } })
  expect(read('a', true).map(wire => wire.listCountFact)).toEqual([undefined, undefined])
  nodes[`${a}[1]`] = { state: 'running' }
  expect(read('a', true).map(wire => wire.listCountFact)).toEqual([undefined, undefined])
  nodes[`${a}[1]`] = done({ out: { typeId: 'list<STRING>', length: 0 } })
  expect(read('a', true).map(wire => wire.listCountFact)).toEqual(Array(2).fill({ kind: 'estimate', count: 0, sources: ['last-run'] }))
  expect(body.nodes['producer']!.values).toEqual({ seed: 1 })
})

describe('deriveCompanions: literals', () => {

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
      body: [
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
