import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, asNodeId, asPromptId, compile, loadDocument, type CompileArtifact, type DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry, type ExecutionState, type RetainedAssets } from '@dinkster/client'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { scopedStorageKey } from '../src/projects.js'
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
      outputs: { value: { typeId: 'FLOAT', value: 7.5 } },
    },
  },
  blockedNodes: {},
  expandedNodes: {},
  regions: {},
  outputs: {
    producer: {
      value: { typeId: 'FLOAT', fingerprint: 'scalar-fingerprint', value: 7.5 },
      image: {
        typeId: 'asset<media/image>', fingerprint: 'image-fingerprint',
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('startup result source admission', () => {
  function setup() {
    vi.stubGlobal('location', { protocol: 'http:', host: 'test' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
    const app = createWorkflowApp(null)
    const backend = app.backends.get()[0]!
    if (backend.protocol !== 'dinkster') throw new Error('Expected native backend')
    const payload = JSON.parse(readFileSync(new URL('../../core/fixtures/dinkster-nodes.json', import.meta.url), 'utf8')) as DinksterNodesPayload
    const registry = { ...buildDinksterRegistry(backend.id, payload), server: { version: 'reload-test', schemaWire: 1 } }
    const loaded = loadDocument({ format: 'dinkster-workflow', formatVersion: 1, lineage: 'restore-source', root: 'g0',
      graphs: { g0: { id: 'g0', name: 'Root', nodes: {
        n0: { id: 'n0', type: 'std.math.add_ints', values: { a: 3, b: 4 } },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 } }, view: { graphs: {} } })
    if (loaded.document === undefined) throw new Error('Invalid source fixture')
    const compiled = compile({ document: loaded.document, revision: 0, resolve: registry.resolve,
      scope: { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('n0') }] },
      connection: backend.id, schemaHash: registry.hash, pickCandidate: () => 0 })
    if (!compiled.ok) throw new Error('Source fixture did not compile')
    const nodeId = Object.keys(compiled.artifact.prompt)[0]!
    const ref = { connection: backend.id, prompt: asPromptId('restored-job') }
    const saved = { ...completed('restored-job'), ref, artifact: compiled.artifact,
      jobRef: 'run-restored-job', sourceDocument: `blake3:${'b'.repeat(64)}`,
      submittedBy: { principalId: 'user-1', kind: 'human' as const },
      nodes: { [nodeId]: { state: 'done' as const, outputs: { sum: { typeId: 'INT', value: 7 } } } },
      outputs: { [nodeId]: { sum: { typeId: 'INT', fingerprint: 'sum-seven', value: 7 } } } }
    const backendIdentity = { connection: backend.id, baseUrl: backend.baseUrl,
      clientId: `${globalThis.localStorage.getItem(scopedStorageKey('dinkster.workspaceClientId'))}:${backend.id}`,
      serverVersion: 'reload-test', schemaWire: 1 }
    saveExecutionResult(saved, backendIdentity)
    vi.spyOn(backend.connection, 'connect').mockImplementation(() => undefined)
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(registry)
    vi.spyOn(backend, 'refreshDiagnostics').mockImplementation(() => undefined)
    vi.spyOn(backend.connection, 'getHistoryRun').mockResolvedValue({ runId: saved.jobRef!, scope: 'local',
      clientId: backendIdentity.clientId, jobId: ref.prompt, state: 'completed', priority: 0,
      submittedAt: 1, finishedAt: 10, executed: 1, cached: 0, skipped: 0,
      sourceDocument: saved.sourceDocument, principalId: 'user-1', principalKind: 'human' })
    vi.spyOn(backend.connection, 'fetchJob').mockResolvedValue({ state: 'completed', jobRef: saved.jobRef,
      sourceDocument: saved.sourceDocument, submittedBy: saved.submittedBy,
      nodeStates: { [nodeId]: 'completed' }, outputs: saved.outputs })
    const fetchSource = vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(loaded.document))
    vi.spyOn(backend.connection.values(), 'peek').mockResolvedValue({ available: true, renditions: [],
      descriptor: { typeId: 'INT', fingerprint: 'sum-seven', value: 7 } })
    return { app, backend, registry, ref, nodeId, saved, backendIdentity, fetchSource, source: JSON.stringify(loaded.document) }
  }

  it.each(['startup', 'startup-first', 'refresh-first'] as const)('restores two source-bound results through public value admission before publication: %s', async (order) => {
    const test = setup()
    const schemas: Array<(registry: typeof test.registry) => void> = []
    if (order !== 'startup') {
      vi.mocked(test.backend.connection.fetchSchemas).mockImplementation(() => new Promise((resolve) => { schemas.push(resolve) }))
    }
    const second = { ...test.saved, ref: { ...test.ref, prompt: asPromptId('restored-second') }, jobRef: 'run-restored-second' }
    saveExecutionResult(second, test.backendIdentity)
    vi.mocked(test.backend.connection.values().peek).mockRestore()
    const owners = new Map<string, RetainedAssets>()
    const results = [test.saved, second]
    vi.mocked(test.backend.connection.fetchJob).mockImplementation(async (prompt) => {
      const saved = results.find((result) => result.ref.prompt === prompt)!
      return { state: 'completed', jobRef: saved.jobRef, sourceDocument: saved.sourceDocument,
        submittedBy: saved.submittedBy, nodeStates: { [test.nodeId]: 'completed' }, outputs: saved.outputs }
    })
    vi.mocked(test.backend.connection.getHistoryRun).mockImplementation(async (jobRef) => {
      const saved = results.find((result) => result.jobRef === jobRef)!
      return { runId: jobRef, scope: 'local', clientId: test.backendIdentity.clientId, jobId: saved.ref.prompt,
        state: 'completed', priority: 0, submittedAt: 1, finishedAt: 10, executed: 1, cached: 0, skipped: 0,
        sourceDocument: saved.sourceDocument, principalId: 'user-1', principalKind: 'human' }
    })
    vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const receipt = { ...owner, ...declaration, revision: 1 }
      owners.set(owner.ownerId, receipt)
      return receipt
    })
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://test')
      if (url.pathname === '/api/values') {
        const saved = results.find((result) => result.ref.prompt === url.searchParams.get('jobId'))
        return Response.json({ available: true, descriptor: { typeId: 'INT', fingerprint: 'sum-seven', value: 7 },
          renditions: [], resultOffer: { token: 'a'.repeat(32), scope: 'local', jobRef: saved?.jobRef ?? 'foreign-job',
            attemptId: 1, nodeId: test.nodeId, outputId: 'sum', publication: 1,
            digests: [test.saved.sourceDocument!], complete: false } })
      }
      if (init?.method === 'PUT' && url.pathname.includes('/retentions/shown-result/')) {
        const ownerId = decodeURIComponent(url.pathname.split('/').at(-1)!)
        const receipt: RetainedAssets = { scope: 'local', ownerKind: 'shown-result', ownerId, revision: 1,
          digests: [test.saved.sourceDocument!], complete: false, sourceToken: 'a'.repeat(32) }
        owners.set(ownerId, receipt)
        return Response.json(receipt)
      }
      return new Response('', { status: 404 })
    }))
    try {
      const starting = test.app.start()
      if (order !== 'startup') {
        ;(test.backend.connection.status as unknown as { set(value: string): void }).set('connected')
        expect(schemas).toHaveLength(2)
        if (order === 'startup-first') {
          schemas[0]!(test.registry)
          await starting
          expect(test.app.store.get(test.ref)).toBeUndefined()
          schemas[1]!(test.registry)
        } else {
          schemas[1]!(test.registry)
          await vi.waitFor(() => expect(test.app.store.get(second.ref)).toBeDefined())
          schemas[0]!(test.registry)
        }
      }
      await starting
      await vi.waitFor(() => expect(test.app.store.get(second.ref)).toBeDefined())
      for (const saved of results) {
        const restored = test.app.store.get(saved.ref)!
        expect(restored?.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 })
        expect(restored.assetRetentions).toHaveLength(1)
        const receipt = restored.assetRetentions![0]!
        expect(receipt.digests).toContain(test.saved.sourceDocument)
        expect(owners.get(receipt.ownerId)).toEqual(receipt)
      }
      expect(loadExecutionResults(test.backendIdentity)).toHaveLength(2)
      expect(await test.backend.connection.values().peek({ jobId: 'foreign-read', nodeId: test.nodeId, outputId: 'sum' }))
        .toMatchObject({ available: false, reason: 'ownership-unconfirmed' })
    } finally { test.app.dispose() }
  })
  it.each(['accepted', 'refused', 'mismatched', 'malformed', 'absent', 'failed-body'] as const)('restores only an admitted persisted source: %s', async (mode) => {
    const test = setup()
    try {
      if (mode === 'malformed') test.fetchSource.mockResolvedValue('{')
      if (mode === 'absent') test.fetchSource.mockResolvedValue(undefined)
      if (mode === 'failed-body') test.fetchSource.mockRejectedValue(new Error('Body failed'))
      vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        if (owner.ownerKind === 'preview' && mode === 'refused') throw new Error('Admission refused')
        return { ...owner, ...declaration, revision: declaration.revision + 1,
          ...(owner.ownerKind === 'preview' && mode === 'mismatched' ? { digests: [`blake3:${'e'.repeat(64)}`] } : {}) }
      })
      await test.app.start()
      if (mode === 'accepted') {
        expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toEqual({ typeId: 'INT', fingerprint: 'sum-seven', value: 7 })
      } else {
        if (mode === 'refused' || mode === 'mismatched') expect(test.fetchSource).not.toHaveBeenCalled()
        expect(test.app.store.get(test.ref)).toBeUndefined()
      }
      expect(loadExecutionResults(test.backendIdentity)).toHaveLength(mode === 'malformed' || mode === 'absent' ? 0 : 1)
    } finally { test.app.dispose() }
  })

})

describe('execution result persistence', () => {
  it('retains scalar and digest metadata but never runtime models, tensors, or preview bytes', () => {
    saveExecutionResult(completed('job-1'), identity)
    const [saved] = loadExecutionResults(identity)
    expect(saved?.proof.prompt.producer?.outputIds).toEqual(['value', 'image'])
    expect(saved?.nodes.producer?.outputs?.value).toEqual({ typeId: 'FLOAT', value: 7.5 })
    expect(saved?.nodes.producer).toMatchObject({
      executionArm: 'native',
      provider: 'vision.depth.v3',
      pack: 'dinkster-vision-depth-anything-v3',
      worker: 'gpu-box',
    })
    expect(saved?.outputs.producer?.image).toEqual({
      typeId: 'asset<media/image>', fingerprint: 'image-fingerprint',
      meta: { digest: `blake3:${'a'.repeat(64)}`, mediaType: 'image/png', width: 64 },
    })
    expect(saved?.outputs.producer?.model).toBeUndefined()
    const raw = globalThis.localStorage.getItem(EXECUTION_RESULTS_STORAGE_KEY) ?? ''
    expect(raw).not.toContain('tensor')
    expect(raw).not.toContain('preview')
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
