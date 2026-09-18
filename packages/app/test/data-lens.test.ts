/**
 * Data lens derivation (data-lens.ts): node bodies re-skinned with the
 * bound execution's recorded data. Same honesty rules as companions -
 * exactness oracle for live values, 'varies' for disagreeing occurrences,
 * abstention for unknown instance paths - plus type/length descriptors for
 * values that never inline. Presentation only; nothing here mutates.
 */
import { describe, expect, it } from 'vitest'
import type { NodeProgress } from '@dinkster/core'
import { deriveDataPanels, recordedTextOutputForNode } from '../src/data-lens.js'

const node = (id: string) => ({ id, isSubgraph: false })
const done = (outputs?: NodeProgress['outputs']): NodeProgress => ({
  state: 'done',
  ...(outputs !== undefined ? { outputs } : {}),
})
const int = (v: number) => ({ typeId: 'core.int', value: v })

describe('deriveDataPanels: attribution honesty', () => {
  it('no occurrence resolver abstains per node (unknown instance path)', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done({ out: int(1) }) },
      frozen: true,
    })
    expect(panels['a']).toEqual([{ label: '', text: '-', tone: 'muted' }])
  })

  it('a node with no recorded occurrence reads "not run"', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: {},
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['a']).toEqual([{ label: '', text: 'not run', tone: 'muted' }])
  })

  it('subgraph instance nodes get no panel (inner values belong to inner nodes)', () => {
    const panels = deriveDataPanels({
      nodes: [{ id: 'sub', isSubgraph: true }],
      execNodes: {},
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['sub']).toBeUndefined()
  })
})

describe('deriveDataPanels: output rows', () => {
  it('inline scalars display as value rows; frozen tabs are exact', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done({ out: int(42), other: { typeId: 'core.string', value: 'hi' } }) },
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['a']).toEqual([
      { label: 'out', text: '42', tone: 'value' },
      { label: 'other', text: 'hi', tone: 'value' },
    ])
  })

  it('live values are stale without an oracle, exact with a passing one', () => {
    const args = {
      nodes: [node('a')],
      execNodes: { a: done({ out: int(42) }) },
      runtimeIdsOf: (id: string) => [id],
      frozen: false,
    }
    expect(deriveDataPanels(args)['a']).toEqual([{ label: 'out', text: '42', tone: 'stale' }])
    expect(deriveDataPanels({ ...args, exactProducer: () => true })['a']).toEqual([
      { label: 'out', text: '42', tone: 'value' },
    ])
    expect(deriveDataPanels({ ...args, exactProducer: () => false })['a']).toEqual([
      { label: 'out', text: '42', tone: 'stale' },
    ])
  })

  it('non-inline outputs show their type descriptor with list length', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done({ imgs: { typeId: 'list<std.image>', length: 4 } }) },
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['a']).toEqual([{ label: 'imgs', text: 'list<std.image> [4]', tone: 'muted' }])
  })

  it('a terminal node with no outputs reads "no recorded outputs"', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done() },
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['a']).toEqual([{ label: '', text: 'no recorded outputs', tone: 'muted' }])
  })

  it('projects exactly one unambiguous string through the data-lens truth source', () => {
    const context = {
      execNodes: { a: done({ text: { typeId: 'core.string', value: 'hello' }, count: int(2) }) },
      runtimeIdsOf: (id: string) => [id],
      frozen: false,
      exactProducer: () => false,
    }
    expect(recordedTextOutputForNode(node('a'), context)).toEqual({ text: 'hello', stale: true })
    expect(recordedTextOutputForNode(node('a'), { ...context, frozen: true })).toEqual({ text: 'hello' })
  })

  it('suppresses ambiguous multiple-string and disagreeing-occurrence outputs', () => {
    const context = {
      execNodes: {
        a: done({ first: { typeId: 'core.string', value: 'one' }, second: { typeId: 'core.string', value: 'two' } }),
      },
      runtimeIdsOf: (id: string) => [id],
      frozen: true,
    }
    expect(recordedTextOutputForNode(node('a'), context)).toBeNull()
    expect(recordedTextOutputForNode(node('a'), {
      ...context,
      execNodes: {
        a: done({ text: { typeId: 'core.string', value: 'one' } }),
        'a[1]': done({ text: { typeId: 'core.string', value: 'two' } }),
      },
      runtimeIdsOf: () => ['a', 'a[1]'],
    })).toBeNull()
    expect(recordedTextOutputForNode(node('a'), {
      ...context,
      execNodes: {
        a: done({ first: { typeId: 'core.string', value: 'same' }, second: { typeId: 'core.string', value: 'one' } }),
        'a[1]': done({ first: { typeId: 'core.string', value: 'same' }, second: { typeId: 'core.string', value: 'two' } }),
      },
      runtimeIdsOf: () => ['a', 'a[1]'],
    })).toBeNull()
  })
})

describe('deriveDataPanels: multiple occurrences', () => {
  const two = (id: string) => (id === 'a' ? ['a', 'a[1]'] : [id])

  it('agreeing occurrences show the value plus a runs row', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done({ out: int(7) }), 'a[1]': done({ out: int(7) }) },
      runtimeIdsOf: two,
      frozen: true,
    })
    expect(panels['a']).toEqual([
      { label: 'runs', text: '2', tone: 'muted' },
      { label: 'out', text: '7', tone: 'value' },
    ])
  })

  it('disagreeing occurrences say "varies", never one arbitrary iteration', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done({ out: int(7) }), 'a[1]': done({ out: int(8) }) },
      runtimeIdsOf: two,
      frozen: true,
    })
    expect(panels['a']).toContainEqual({ label: 'out', text: 'varies', tone: 'muted' })
  })

  it('every contributing occurrence must pass the oracle for exactness', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done({ out: int(7) }), 'a[1]': done({ out: int(7) }) },
      runtimeIdsOf: two,
      frozen: false,
      exactProducer: (rid) => rid === 'a',
    })
    expect(panels['a']).toContainEqual({ label: 'out', text: '7', tone: 'stale' })
  })

  it('mixed occurrence states surface as "varies"', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: done(), 'a[1]': { state: 'running' } },
      runtimeIdsOf: two,
      frozen: true,
    })
    expect(panels['a']).toContainEqual({ label: 'state', text: 'varies', tone: 'muted' })
  })
})

describe('deriveDataPanels: state rows', () => {
  it('non-done states surface; done is the silent default', () => {
    const panels = deriveDataPanels({
      nodes: [node('c'), node('r'), node('d')],
      execNodes: { c: { state: 'cached', outputs: { out: int(1) } }, r: { state: 'running' }, d: done() },
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['c']).toContainEqual({ label: 'state', text: 'cached', tone: 'muted' })
    expect(panels['r']).toEqual([{ label: 'state', text: 'running', tone: 'muted' }])
    expect(panels['d']).toEqual([{ label: '', text: 'no recorded outputs', tone: 'muted' }])
  })

  it('skipped nodes show the engine reason', () => {
    const panels = deriveDataPanels({
      nodes: [node('a')],
      execNodes: { a: { state: 'skipped', skipReason: 'absent input' } },
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['a']).toEqual([{ label: 'skipped', text: 'absent input', tone: 'muted' }])
  })

  it('describes lazy demand and cache misses as activity, not node state', () => {
    const panels = deriveDataPanels({
      nodes: [node('lazy'), node('miss')],
      execNodes: { miss: { state: 'running' } },
      activities: [
        {
          kind: 'lazy_demand',
          nodeId: 'lazy',
          round: 1,
          status: 'waiting',
          requestedInputs: ['on_true', 'on_false'],
          newInputs: ['on_false'],
          demandedInputs: ['on_true', 'on_false'],
          producerNodes: ['producer'],
        },
        {
          kind: 'cache_miss',
          nodeId: 'miss',
          reason: 'inputs-changed',
          changedInputs: ['seed'],
        },
      ],
      runtimeIdsOf: (id) => [id],
      frozen: true,
    })
    expect(panels['lazy']).toContainEqual({
      label: 'activity',
      text: 'waiting on lazy inputs: on_true, on_false',
      tone: 'muted',
    })
    expect(panels['miss']).toContainEqual({
      label: 'activity',
      text: 'cache miss (inputs changed)',
      tone: 'muted',
    })
  })
})
