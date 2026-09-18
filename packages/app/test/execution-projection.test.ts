/**
 * Execution projection is tested at the app seam, not merely in core and
 * canvas: this is the production composition that supplies compile
 * provenance, the concrete navigation path, and aggregation together.
 */
import { describe, expect, it } from 'vitest'
import type { Scene } from '@dinkster/canvas'
import type { NodeProgress } from '@dinkster/core'
import {
  projectExecutionNodeStates,
  projectRegionIterationLabels,
} from '../src/execution-projection.js'

// Projection only consumes scene node identity and subgraph-ness. Keeping the
// fixture intentionally narrow makes these tests describe attribution rather
// than duplicating the sizeable renderer layout contract.
const scene = (...nodes: Array<{ id: string; isSubgraph: boolean; regionKind?: 'map' | 'fold' | 'while' }>): Scene => ({ nodes }) as unknown as Scene
const states = (...entries: Array<[string, NodeProgress]>): Record<string, NodeProgress> =>
  Object.fromEntries(entries)

describe('execution occurrence projection', () => {
  it('preserves root-graph node projection', () => {
    const projected = projectExecutionNodeStates({
      states: states(['root', { state: 'running', value: 0.25 }]),
      scene: scene({ id: 'root', isSubgraph: false }),
      instancePath: [],
    })
    expect(projected).toEqual({ root: { state: 'running', value: 0.25 } })
  })

  it('decorates only the nested occurrence selected by the expanded view', () => {
    const projected = projectExecutionNodeStates({
      states: states(['run-left', { state: 'done' }], ['run-right', { state: 'error' }]),
      scene: scene({ id: 'leaf', isSubgraph: false }),
      instancePath: ['outer', 'left'],
      toSource: {
        'run-left': 'outer.left.leaf',
        'run-right': 'outer.right.leaf',
      },
    })
    expect(projected).toEqual({ leaf: { state: 'done' } })
  })

  it('aggregates all descendant states onto a collapsed instance', () => {
    const projected = projectExecutionNodeStates({
      states: states(['run-a', { state: 'done' }], ['run-b', { state: 'error' }]),
      scene: scene({ id: 'instance', isSubgraph: true }),
      instancePath: [],
      toSource: { 'run-a': 'instance.a', 'run-b': 'instance.nested.b' },
    })
    expect(projected).toEqual({ instance: { state: 'error' } })
  })

  it('keeps sibling instances of one definition independent', () => {
    const args = {
      states: states(['left-run', { state: 'running' }], ['right-run', { state: 'cached' }]),
      scene: scene({ id: 'leaf', isSubgraph: false }),
      toSource: { 'left-run': 'left.leaf', 'right-run': 'right.leaf' },
    }
    expect(projectExecutionNodeStates({ ...args, instancePath: ['left'] })).toEqual({
      leaf: { state: 'running' },
    })
    expect(projectExecutionNodeStates({ ...args, instancePath: ['right'] })).toEqual({
      leaf: { state: 'cached' },
    })
  })

  it('degrades an unmapped runtime id to historical node-id projection', () => {
    const projected = projectExecutionNodeStates({
      states: states(['legacy-node', { state: 'skipped' }]),
      scene: scene({ id: 'legacy-node', isSubgraph: false }),
      instancePath: [],
      toSource: {},
    })
    expect(projected).toEqual({ 'legacy-node': { state: 'skipped' } })
  })

  it('aggregates iteration body progress onto a region occurrence', () => {
    const projected = projectExecutionNodeStates({
      states: states(
        ['r[0]/body', { state: 'running', value: 0.25 }],
        ['r[1]/body', { state: 'running', value: 0.75 }],
      ),
      scene: scene({ id: 'r', isSubgraph: true, regionKind: 'map' }),
      instancePath: [],
    })
    expect(projected).toEqual({ r: { state: 'running', value: 0.5 } })
  })
})

describe('region iteration counter projection', () => {
  const regionScene = (kind: 'map' | 'fold' | 'while'): Scene =>
    scene({ id: 'r', isSubgraph: true, regionKind: kind })

  it('shows a fixed map count and selects the highest running iteration', () => {
    expect(projectRegionIterationLabels({
      regions: { r: { kind: 'map', binding: 'zip', iterations: 4 } },
      states: states(
        ['r[1]/early', { state: 'running' }],
        ['r[3]/late', { state: 'running' }],
        ['r[2]/done', { state: 'done' }],
      ),
      scene: regionScene('map'),
      instancePath: [],
    })).toEqual({ r: 'iteration 4 of 4' })
  })

  it('shows an unbounded while iteration without a total', () => {
    expect(projectRegionIterationLabels({
      regions: { r: { kind: 'while', binding: 'zip', iterations: null } },
      states: states(['r[2]/body', { state: 'running' }]),
      scene: regionScene('while'),
      instancePath: [],
    })).toEqual({ r: 'iteration 3' })
  })

  it('keeps the terminal iteration visible after running body states finish', () => {
    expect(projectRegionIterationLabels({
      regions: {
        r: { kind: 'fold', binding: 'zip', iterations: 3, finishedIterations: 3 },
      },
      states: states(['r[2]/body', { state: 'done' }]),
      scene: regionScene('fold'),
      instancePath: [],
    })).toEqual({ r: 'iteration 3 of 3' })
  })

  it('stays neutral without a region lifecycle event', () => {
    expect(projectRegionIterationLabels({
      regions: {},
      states: states(['r[0]/body', { state: 'running' }]),
      scene: regionScene('map'),
      instancePath: [],
    })).toEqual({})
  })

  it('never borrows a finished nested region count for the outer occurrence', () => {
    expect(projectRegionIterationLabels({
      regions: {
        outer: { kind: 'map', binding: 'zip', iterations: 3 },
        'outer[0]/inner': { kind: 'map', binding: 'zip', iterations: 2, finishedIterations: 2 },
      },
      states: states(['outer[0]/inner[1]/body', { state: 'done' }]),
      scene: scene({ id: 'outer', isSubgraph: true, regionKind: 'map' }),
      instancePath: [],
    })).toEqual({})
  })
})
