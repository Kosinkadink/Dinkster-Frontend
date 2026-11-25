/**
 * Expression-mirror estimate derivation: nodes declaring a supported
 * expression mirror get display-only scalar estimates when every variable
 * input resolves to an eligible scalar (resident literal, proven producer
 * value, or upstream mirror). Evaluation failures become producer preview
 * errors; unresolved inputs, cycles, and non-scalar results stay absent.
 */
import { describe, expect, it } from 'vitest'
import type { GraphDef } from '../src/format/document.js'
import {
  asGraphDefId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
} from '../src/ids.js'
import { deriveMirrorEstimates } from '../src/mirror/estimate.js'
import type { MirrorSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
/** Document address of one `values` group member: its flattened id (`values.a`). */
const member = (node: string, key: string) => port(node, `values.${key}`)
const tap = (node: string, inputId: string) => ({ node: asNodeId(node), tap: asPortId(inputId) })
/** A primitive holding a literal: its known-value output passes on its stored field. */
const vsrc = (id: string) => port(id, 'out')
const source = (id: string, value: unknown) => node(id, 'KnownIntNode', { steps: value })
const link = (id: string, from: object, to: object) =>
  ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]

const node = (id: string, type: string, values: Record<string, unknown> = {}, memberIds?: string[]) =>
  ({
    id: asNodeId(id),
    type,
    values,
    ...(memberIds ? { dynamic: { values: { members: memberIds } } } : {}),
  }) as GraphDef['nodes'][string]

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string; sources?: GraphDef['nodes'] }): GraphDef {
  const { sources, ...rest } = partial
  return {
    name: 'g',
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...rest,
    nodes: { ...rest.nodes, ...sources },
    id: asGraphDefId(partial.id),
  }
}

const output = (id: string, type: string): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: type },
})

const EXPRESSION_MIRROR: MirrorSpec = {
  kind: 'expression',
  precision: 'bounded',
  tolerance: { relative: 1e-12 },
  grammarVersion: 1,
}

/** MathExpression-shaped schema: expression widget + a..z values family. */
const mathSchema = (mirror: MirrorSpec | null = EXPRESSION_MIRROR): NodeSchema => ({
  type: 'dinkster.math.expression',
  displayName: 'Math Expression',
  category: 'math',
  source: 'v3',
  isOutputNode: false,
  ...(mirror ? { mirror } : {}),
  body: [
    {
      kind: 'input',
      id: 'expression',
      type: { kind: 'concrete', name: 'STRING' },
      optional: false,
      widget: { widgetType: 'STRING', options: {}, default: 'a + b' },
    },
    {
      kind: 'group',
      id: 'values',
      value: { kind: 'input', id: 'value', type: { kind: 'wildcard' }, optional: false },
      keys: { kind: 'named', names: 'abcdefghijklmnopqrstuvwxyz'.split('') },
      grows: 'link',
      minMembers: 1,
    },
    output('float', 'FLOAT'),
    output('int', 'INT'),
    output('boolean', 'BOOLEAN'),
  ],
})

/** Plain producer/consumer schema with an INT widget input and one output. */
const intSchema: NodeSchema = {
  type: 'IntNode',
  displayName: 'Int',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: [
    {
      kind: 'input',
      id: 'steps',
      type: { kind: 'concrete', name: 'INT' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 4 },
    },
    output('out', 'INT'),
  ],
}

const knownIntSchema: NodeSchema = {
  ...intSchema,
  type: 'KnownIntNode',
  body: [
    intSchema.body[0]!,
    { ...output('out', 'INT'), knownValue: { input: 'steps' } },
  ],
}

const schemas = new Map<string, NodeSchema>([
  ['dinkster.math.expression', mathSchema()],
  ['IntNode', intSchema],
  ['KnownIntNode', knownIntSchema],
])
const resolve = (type: string): NodeSchema | undefined => schemas.get(type)

const estimateOf = (def: GraphDef, nodeId = 'm1') =>
  deriveMirrorEstimates(def, resolve).get(nodeId)

describe('deriveMirrorEstimates', () => {
  it('computes all three scalar outputs from primitive literals', () => {
    const def = graph({
      id: 'g0',
      nodes: { m1: node('m1', 'dinkster.math.expression', { expression: 'a + b' }, ['a', 'b']) },
      sources: { v1: source('v1', 2), v2: source('v2', 3.5) },
      links: {
        l1: link('l1', vsrc('v1'), member('m1', 'a')),
        l2: link('l2', vsrc('v2'), member('m1', 'b')),
      },
    })
    expect(estimateOf(def)).toEqual({ outputs: { float: 5.5, int: 5, boolean: true } })
  })

  it('classifies integer-valued numbers as ints (prompt JSON semantics)', () => {
    const def = graph({
      id: 'g0',
      nodes: { m1: node('m1', 'dinkster.math.expression', { expression: 'a // b' }, ['a', 'b']) },
      sources: { v1: source('v1', 7), v2: source('v2', 2) },
      links: {
        l1: link('l1', vsrc('v1'), member('m1', 'a')),
        l2: link('l2', vsrc('v2'), member('m1', 'b')),
      },
    })
    expect(estimateOf(def)?.outputs['int']).toBe(3)
  })

  it('resolves widget taps through stored values and widget defaults', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        src: node('src', 'IntNode'),
        m1: node('m1', 'dinkster.math.expression', { expression: 'a * a' }, ['a']),
      },
      links: { l1: link('l1', tap('src', 'steps'), member('m1', 'a')) },
    })
    // No stored value: the INT widget's declared default (4) applies.
    expect(estimateOf(def)?.outputs['int']).toBe(16)
    ;(def.nodes['src']!.values as Record<string, unknown>)['steps'] = 9
    expect(estimateOf(def)?.outputs['int']).toBe(81)
  })

  it('treats schema-declared primitive identity chains as exact mirror inputs', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        source: node('source', 'KnownIntNode', { steps: 2 }),
        identity: node('identity', 'KnownIntNode'),
        m1: node('m1', 'dinkster.math.expression', { expression: 'a + 0.5' }, ['a']),
        m2: node('m2', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']),
      },
      links: {
        l1: link('l1', port('source', 'out'), port('identity', 'steps')),
        l2: link('l2', port('identity', 'out'), member('m1', 'a')),
        l3: link('l3', port('m1', 'float'), member('m2', 'a')),
      },
    })
    const estimates = deriveMirrorEstimates(def, resolve)
    expect(estimates.get('m1')?.outputs['float']).toBe(2.5)
    expect(estimates.get('m2')?.outputs['float']).toBe(3.5)
  })

  it('yields no estimate when a producer output has no current value or upstream mirror', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        src: node('src', 'IntNode'),
        m1: node('m1', 'dinkster.math.expression', { expression: 'a + b' }, ['a', 'b']),
      },
      sources: { v1: source('v1', 2) },
      links: {
        l1: link('l1', vsrc('v1'), member('m1', 'a')),
        l2: link('l2', port('src', 'out'), member('m1', 'b')),
      },
    })
    expect(estimateOf(def)).toBeUndefined()
  })

  it('reports structural expression errors before unresolved inputs', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        src: node('src', 'IntNode'),
        m1: node('m1', 'dinkster.math.expression', { expression: 'a +' }, ['a']),
      },
      links: { l1: link('l1', port('src', 'out'), member('m1', 'a')) },
    })
    expect(estimateOf(def)).toEqual({
      outputs: {},
      error: 'Invalid expression: unexpected token',
    })
  })

  it('uses provenance-approved producer values through links and nets', () => {
    const linked = graph({
      id: 'g0',
      nodes: {
        src: node('src', 'IntNode'),
        m1: node('m1', 'dinkster.math.expression', { expression: 'a / 2' }, ['a']),
      },
      links: { l1: link('l1', port('src', 'out'), member('m1', 'a')) },
    })
    const producerValue = (nodeId: string, outputId: string) =>
      nodeId === 'src' && outputId === 'out' ? 7 : undefined
    expect(deriveMirrorEstimates(linked, resolve, { producerValue }).get('m1')).toEqual({
      outputs: { float: 3.5, int: 3, boolean: true },
    })

    const netDriven = graph({
      ...linked,
      id: 'g1',
      links: {},
      nets: {
        n1: {
          id: asNetId('n1'),
          name: 'scalar',
          source: port('src', 'out'),
          sinks: [member('m1', 'a')],
        } as GraphDef['nets'][string],
      },
    })
    expect(deriveMirrorEstimates(netDriven, resolve, { producerValue }).get('m1')).toEqual({
      outputs: { float: 3.5, int: 3, boolean: true },
    })
  })

  it('propagates integer, float, and boolean outputs through an unordered three-mirror chain', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        third: node('third', 'dinkster.math.expression', { expression: 'not a' }, ['a']),
        first: node('first', 'dinkster.math.expression', { expression: 'a + 0.5' }, ['a']),
        second: node('second', 'dinkster.math.expression', { expression: 'a * 2' }, ['a']),
      },
      sources: { v1: source('v1', 2) },
      links: {
        l1: link('l1', vsrc('v1'), member('first', 'a')),
        l2: link('l2', port('first', 'float'), member('second', 'a')),
        l3: link('l3', port('second', 'boolean'), member('third', 'a')),
      },
    })
    const estimates = deriveMirrorEstimates(def, resolve)
    expect(estimates.get('first')?.outputs).toEqual({ float: 2.5, int: 2, boolean: true })
    expect(estimates.get('second')?.outputs).toEqual({ float: 5, int: 5, boolean: true })
    expect(estimates.get('third')?.outputs).toEqual({ float: 0, int: 0, boolean: false })
  })

  it('prefers a current producer value over that producer local estimate', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        first: node('first', 'dinkster.math.expression', { expression: 'a * 2' }, ['a']),
        second: node('second', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']),
      },
      sources: { v1: source('v1', 2) },
      links: {
        l1: link('l1', vsrc('v1'), member('first', 'a')),
        l2: link('l2', port('first', 'float'), member('second', 'a')),
      },
    })
    const estimates = deriveMirrorEstimates(def, resolve, {
      producerValue: (nodeId, outputId) =>
        nodeId === 'first' && outputId === 'float' ? 9 : undefined,
    })
    expect(estimates.get('first')?.outputs['float']).toBe(4)
    expect(estimates.get('second')?.outputs['float']).toBe(10)
  })

  it('retains an invalid producer error while clearing its downstream cone and abstaining on cycles', () => {
    const invalid = graph({
      id: 'g0',
      nodes: {
        first: node('first', 'dinkster.math.expression', { expression: 'a / 0' }, ['a']),
        second: node('second', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']),
      },
      sources: { v1: source('v1', 2) },
      links: {
        l1: link('l1', vsrc('v1'), member('first', 'a')),
        l2: link('l2', port('first', 'float'), member('second', 'a')),
      },
    })
    expect(deriveMirrorEstimates(invalid, resolve)).toEqual(new Map([
      ['first', { outputs: {}, error: 'Division by zero' }],
    ]))

    const cyclic = graph({
      id: 'g1',
      nodes: {
        first: node('first', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']),
        second: node('second', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']),
      },
      links: {
        l1: link('l1', port('second', 'float'), member('first', 'a')),
        l2: link('l2', port('first', 'float'), member('second', 'a')),
      },
    })
    expect(deriveMirrorEstimates(cyclic, resolve).size).toBe(0)
  })

  it('does not let a disabled upstream mirror feed a downstream mirror', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        first: node('first', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']),
        second: node('second', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']),
      },
      sources: { v1: source('v1', 2) },
      links: {
        l1: link('l1', vsrc('v1'), member('first', 'a')),
        l2: link('l2', port('first', 'float'), member('second', 'a')),
      },
    })
    expect(deriveMirrorEstimates(def, resolve, { enabled: (nodeId) => nodeId !== 'first' }).size).toBe(0)
  })

  it('yields no estimate for non-scalar or non-numeric resident values', () => {
    for (const bad of ['text', null, [1, 2], { a: 1 }]) {
      const def = graph({
        id: 'g0',
        nodes: { m1: node('m1', 'dinkster.math.expression', { expression: 'a + 1' }, ['a']) },
        sources: { v1: source('v1', bad) },
        links: { l1: link('l1', vsrc('v1'), member('m1', 'a')) },
      })
      expect(estimateOf(def)).toBeUndefined()
    }
  })

  it('returns a canonical preview error when evaluation fails', () => {
    const deeplyNested = '('.repeat(2000) + 'a' + ')'.repeat(2000)
    for (const expression of ['a +', 'a / b', 'a + c', deeplyNested]) {
      const def = graph({
        id: 'g0',
        nodes: { m1: node('m1', 'dinkster.math.expression', { expression }, ['a', 'b']) },
        sources: { v1: source('v1', 1), v2: source('v2', 0) },
        links: {
          l1: link('l1', vsrc('v1'), member('m1', 'a')),
          l2: link('l2', vsrc('v2'), member('m1', 'b')),
        },
      })
      expect(estimateOf(def)).toEqual({
        outputs: {},
        error: expect.any(String),
      })
    }
  })

  it('omits the int output when the result exceeds exact JSON range', () => {
    const def = graph({
      id: 'g0',
      nodes: { m1: node('m1', 'dinkster.math.expression', { expression: 'a ** b' }, ['a', 'b']) },
      sources: { v1: source('v1', 2), v2: source('v2', 60) },
      links: {
        l1: link('l1', vsrc('v1'), member('m1', 'a')),
        l2: link('l2', vsrc('v2'), member('m1', 'b')),
      },
    })
    const outputs = estimateOf(def)?.outputs
    expect(outputs).toBeDefined()
    expect(outputs!['int']).toBeUndefined()
    expect(outputs!['float']).toBe(2 ** 60)
    expect(outputs!['boolean']).toBe(true)
  })

})
