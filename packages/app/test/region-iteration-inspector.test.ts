import { describe, expect, it } from 'vitest'
import type { ExecutionState } from '@dinkster/client'
import { asNodeId, type CompileArtifact, type Occurrence } from '@dinkster/core'
import { regionIterationInventory } from '../src/region-iteration.js'

const region: Occurrence = { instancePath: [], node: asNodeId('outer') }

const execution = (over: Partial<ExecutionState> = {}): ExecutionState => ({
  ref: { connection: 'backend', prompt: 'job-7' },
  key: 'backend:job-7',
  status: 'completed',
  artifact: {
    connection: 'backend',
    prompt: {
      'outer.source': { class_type: 'Source', inputs: {}, outputIds: ['value'] },
      'outer.inner.leaf': { class_type: 'Leaf', inputs: {}, outputIds: ['image'] },
      'outer.sink': { class_type: 'Sink', inputs: {} },
    },
    provenance: {
      fromSource: { outer: ['outer'] },
      toSource: {
        'outer.source': 'outer.source',
        'outer.inner.leaf': 'outer.inner.leaf',
        'outer.sink': 'outer.sink',
      },
    },
  } as unknown as CompileArtifact,
  nodes: {
    'outer[1]/source': { state: 'cached', outputs: { value: { typeId: 'core.int', value: 8 }, bonus: { typeId: 'core.int' } } },
    'outer[0]/source': { state: 'running', value: 0.375, outputs: { value: { typeId: 'core.int', value: 3 } } },
    'outer[0]/inner[2]/leaf': { state: 'done', outputs: { image: { typeId: 'comfy.IMAGE' } } },
    'outer[0]/sink': { state: 'done' },
    'other[0]/source': { state: 'done' },
    'outer[2]/unknown': { state: 'done' },
    'outer[3]//source': { state: 'done' },
  },
  regions: { outer: { kind: 'map', binding: 'zip', iterations: 4, finishedIterations: 2 } },
  outputs: {}, artifacts: [], artifactsHydrated: true, previews: {}, activities: [], logs: [], logsDropped: 0,
  errors: [], queuedAt: 1,
  ...over,
} as ExecutionState)

describe('regionIterationInventory', () => {
  it('derives simple and nested iterations only from exact runtime paths and provenance', () => {
    expect(regionIterationInventory(execution(), region)).toEqual({
      runtimeId: 'outer',
      expectedIterations: 4,
      finishedIterations: 2,
      iterations: [
        {
          key: JSON.stringify([{ nodeId: 'outer', iteration: 0 }]),
          path: [{ nodeId: 'outer', iteration: 0 }],
          nodes: [
            {
              runtimeId: 'outer[0]/sink', occurrence: { instancePath: ['outer'], node: 'sink' },
              outputIds: [], state: 'done', iterationPath: [{ nodeId: 'outer', iteration: 0 }],
            },
            {
              runtimeId: 'outer[0]/source', occurrence: { instancePath: ['outer'], node: 'source' },
              outputIds: ['value'], state: 'running', progress: 0.375, iterationPath: [{ nodeId: 'outer', iteration: 0 }],
            },
          ],
        },
        {
          key: JSON.stringify([{ nodeId: 'outer', iteration: 0 }, { nodeId: 'inner', iteration: 2 }]),
          path: [{ nodeId: 'outer', iteration: 0 }, { nodeId: 'inner', iteration: 2 }],
          nodes: [{
            runtimeId: 'outer[0]/inner[2]/leaf', occurrence: { instancePath: ['outer', 'inner'], node: 'leaf' },
            outputIds: ['image'], state: 'done',
            iterationPath: [{ nodeId: 'outer', iteration: 0 }, { nodeId: 'inner', iteration: 2 }],
          }],
        },
        {
          key: JSON.stringify([{ nodeId: 'outer', iteration: 1 }]),
          path: [{ nodeId: 'outer', iteration: 1 }],
          nodes: [{
            runtimeId: 'outer[1]/source', occurrence: { instancePath: ['outer'], node: 'source' },
            outputIds: ['value', 'bonus'], state: 'cached', iterationPath: [{ nodeId: 'outer', iteration: 1 }],
          }],
        },
      ],
    })
  })

  it('requires exact compiled ownership and an observed region lifecycle', () => {
    const { artifact: _artifact, ...withoutArtifact } = execution()
    expect(regionIterationInventory(withoutArtifact, region)).toBeUndefined()
    expect(regionIterationInventory(execution({ regions: {} }), region)).toBeUndefined()
    expect(regionIterationInventory(execution(), { instancePath: [], node: asNodeId('foreign') })).toBeUndefined()
  })
})
