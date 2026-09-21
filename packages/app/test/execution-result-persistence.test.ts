import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asConnectionId, asPromptId, type CompileArtifact } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import {
  EXECUTION_RESULTS_STORAGE_KEY,
  MAX_PERSISTED_EXECUTION_BYTES,
  MAX_PERSISTED_EXECUTION_RESULTS,
  clearExecutionResults,
  loadExecutionResults,
  saveExecutionResult,
  type ExecutionResultBackendIdentity,
} from '../src/execution-result-persistence.js'

const C0 = asConnectionId('native')
const identity: ExecutionResultBackendIdentity = {
  connection: C0,
  baseUrl: 'http://native',
  clientId: 'workspace:native',
  serverVersion: '1.2.3',
  schemaWire: 1,
}

const makeStorage = (maxBytes = Number.POSITIVE_INFINITY): Storage => {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (new TextEncoder().encode(value).byteLength > maxBytes) throw new DOMException('quota exceeded')
      map.set(key, value)
    },
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size },
  } as Storage
}

const artifact = (promptId: string): CompileArtifact => ({
  snapshot: {
    format: 'dinkster.workflow', version: 3, root: 'g', nextOrdinal: 1,
    graphs: { g: { id: 'g', name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 0 } },
    view: { graphs: { g: { nodes: {}, reroutes: {}, groups: {} } } },
  },
  revision: 1,
  semanticHash: `semantic-${promptId}`,
  scope: { kind: 'full' },
  connection: C0,
  schemaHash: 'schema',
  prompt: { producer: { class_type: 'RuntimeScalar', inputs: { seed: promptId }, outputIds: ['value', 'image'] } },
  provenance: { toSource: { producer: 'producer' }, fromSource: { producer: ['producer'] } },
  diagnostics: [],
}) as unknown as CompileArtifact

const completed = (promptId: string, endedAt = 10): ExecutionState => ({
  ref: { connection: C0, prompt: asPromptId(promptId) },
  key: `${C0}:${promptId}`,
  artifact: artifact(promptId),
  status: 'completed',
  nodes: {
    producer: {
      state: 'done',
      executionArm: 'native',
      provider: 'vision.depth.v3',
      pack: 'dinkster-vision-depth-anything-v3',
      worker: 'gpu-box',
      outputs: { value: { typeId: 'core.float', value: 7.5 } },
    },
  },
  regions: {},
  outputs: {
    producer: {
      value: { typeId: 'core.float', fingerprint: 'scalar-fingerprint', value: 7.5 },
      image: {
        typeId: 'dinkster.asset<media/image>', fingerprint: 'image-fingerprint',
        meta: { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png', width: 64, secret: 'omit' },
      },
      model: { tensor: new Float32Array([1, 2]), weights: { hidden: true } },
    },
  },
  artifacts: [],
  artifactsHydrated: true,
  previews: { producer: { '': { channel: 'preview', payload: new ArrayBuffer(1024), timestamp: 1 } } },
  activities: [],
  logs: [],
  logsDropped: 0,
  errors: [],
  submittedBy: { principalId: 'user-1', kind: 'human' },
  jobRef: `run-${promptId}`,
  sourceDocument: `blake3:${'b'.repeat(64)}`,
  queuedAt: endedAt - 5,
  endedAt,
})

beforeEach(() => {
  ;(globalThis as { localStorage: Storage }).localStorage = makeStorage()
})

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe('execution result persistence', () => {
  it('retains scalar and digest metadata but never runtime models, tensors, or preview bytes', () => {
    saveExecutionResult(completed('job-1'), identity)
    const [saved] = loadExecutionResults(identity)
    expect(saved?.proof.prompt.producer?.outputIds).toEqual(['value', 'image'])
    expect(saved?.nodes.producer?.outputs?.value).toEqual({ typeId: 'core.float', value: 7.5 })
    expect(saved?.nodes.producer).toMatchObject({
      executionArm: 'native',
      provider: 'vision.depth.v3',
      pack: 'dinkster-vision-depth-anything-v3',
      worker: 'gpu-box',
    })
    expect(saved?.outputs.producer?.image).toEqual({
      typeId: 'dinkster.asset<media/image>', fingerprint: 'image-fingerprint',
      meta: { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png', width: 64 },
    })
    expect(saved?.outputs.producer?.model).toBeUndefined()
    const raw = globalThis.localStorage.getItem(EXECUTION_RESULTS_STORAGE_KEY) ?? ''
    expect(raw).not.toContain('tensor')
    expect(raw).not.toContain('preview')
  })

  it('does not persist foreign or reconciled results without local compile proof', () => {
    const { artifact: _foreignArtifact, ...foreign } = completed('foreign')
    const { sourceDocument: _sourceDocument, ...unstamped } = completed('unstamped')
    saveExecutionResult(foreign, identity)
    saveExecutionResult(unstamped, identity)
    expect(loadExecutionResults(identity)).toEqual([])
  })

  it('evicts the oldest results by count and keeps the serialized envelope byte-bounded', () => {
    for (let index = 0; index < MAX_PERSISTED_EXECUTION_RESULTS + 8; index += 1) {
      saveExecutionResult(completed(`job-${index}`, index), identity)
    }
    const saved = loadExecutionResults(identity)
    expect(saved).toHaveLength(MAX_PERSISTED_EXECUTION_RESULTS)
    expect(saved[0]?.ref.prompt).toBe(`job-${MAX_PERSISTED_EXECUTION_RESULTS + 7}`)
    expect(saved.at(-1)?.ref.prompt).toBe('job-8')
    const raw = globalThis.localStorage.getItem(EXECUTION_RESULTS_STORAGE_KEY) ?? ''
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(MAX_PERSISTED_EXECUTION_BYTES)
  })

  it('evicts oldest-first at the byte cap and retries browser quota failures', () => {
    const largeId = (index: number) => `${index}-${'x'.repeat(40_000)}`
    for (let index = 0; index < MAX_PERSISTED_EXECUTION_RESULTS; index += 1) {
      saveExecutionResult(completed(largeId(index), index), identity)
    }
    const byteBounded = loadExecutionResults(identity)
    expect(byteBounded.length).toBeGreaterThan(0)
    expect(byteBounded.length).toBeLessThan(MAX_PERSISTED_EXECUTION_RESULTS)
    expect(byteBounded[0]?.endedAt).toBe(MAX_PERSISTED_EXECUTION_RESULTS - 1)
    expect(new TextEncoder().encode(
      globalThis.localStorage.getItem(EXECUTION_RESULTS_STORAGE_KEY) ?? '',
    ).byteLength).toBeLessThanOrEqual(MAX_PERSISTED_EXECUTION_BYTES)

    ;(globalThis as { localStorage: Storage }).localStorage = makeStorage(300_000)
    for (let index = 0; index < 8; index += 1) {
      saveExecutionResult(completed(largeId(index), index), identity)
    }
    const quotaBounded = loadExecutionResults(identity)
    expect(quotaBounded).toHaveLength(1)
    expect(quotaBounded[0]?.endedAt).toBe(7)
  })

  it('clears stale backend/runtime identity partitions and explicit backend state', () => {
    const changedIdentities = [
      { ...identity, baseUrl: 'http://different' },
      { ...identity, clientId: 'different-client' },
      { ...identity, serverVersion: '2.0.0' },
      { ...identity, schemaWire: 2 },
    ]
    for (const changed of changedIdentities) {
      saveExecutionResult(completed('job-1'), identity)
      expect(loadExecutionResults(changed)).toEqual([])
      expect(loadExecutionResults(identity)).toEqual([])
    }
    saveExecutionResult(completed('job-2'), identity)
    clearExecutionResults(C0)
    expect(loadExecutionResults(identity)).toEqual([])
  })
})
