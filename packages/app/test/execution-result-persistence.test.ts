import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, asNodeId, asPromptId, compile, loadDocument, type CompileArtifact, type DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry, type ExecutionState, type RetainedAssets, type RetainedAssetOwner } from '@dinkster/client'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { initializeProjectScope, scopedStorageKey } from '../src/projects.js'
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
  initializeProjectScope(undefined)
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

  it.each(['accepted', 'lost-release', 'refused', 'changed-registry', 'reused-execution', 'disconnected', 'changed-project', 'superseded-schemas'] as const)(
    'keeps restored source ownership through result admission and publication: %s', async (mode) => {
      const test = setup()
      const owners = new Map<string, RetainedAssets>()
      let entered!: () => void
      const resultRequested = new Promise<void>((resolve) => { entered = resolve })
      let acknowledge!: () => void
      const acknowledgment = new Promise<void>((resolve) => { acknowledge = resolve })
      vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        if (owner.ownerKind === 'shown-result') {
          entered()
          await acknowledgment
          if (mode === 'refused') throw new Error('Result admission refused')
        }
        const retained = { ...owner, ...declaration, revision: declaration.revision + 1 }
        owners.set(owner.ownerId, retained)
        return retained
      })
      vi.spyOn(test.backend.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
      vi.spyOn(test.backend.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        const retained = owners.get(owner.ownerId)!
        if (retained.revision !== revision) throw new Error('revision conflict')
        const released = { ...retained, revision: revision + 1, complete: true, digests: [] }
        owners.set(owner.ownerId, released)
        if (mode === 'lost-release') throw new Error('Lost release response')
        return released
      })
      try {
        const starting = test.app.start()
        await resultRequested
        expect(test.app.store.get(test.ref)).toBeUndefined()
        const sourceOwner = [...owners.values()].find((owner) => owner.ownerKind === 'preview')!
        expect(sourceOwner).toMatchObject({ revision: 1, complete: false, digests: [test.saved.sourceDocument] })
        if (mode === 'changed-registry') test.backend.registry.set({ ...test.registry })
        if (mode === 'reused-execution') test.app.store.apply({ kind: 'started', execution: test.ref, timestamp: 40 })
        if (mode === 'disconnected') {
          ;(test.backend.connection.status as unknown as { set(value: string): void }).set('connecting')
          ;(test.backend.connection.status as unknown as { set(value: string): void }).set('disconnected')
        }
        if (mode === 'changed-project') initializeProjectScope('other-project')
        let settleSchemas: (() => void) | undefined
        let refreshing: Promise<void> | undefined
        if (mode === 'superseded-schemas') {
          vi.mocked(test.backend.connection.fetchSchemas).mockImplementation(() => new Promise((resolve) => {
            settleSchemas = () => resolve(test.registry)
          }))
          refreshing = test.app.refreshBackendSchemas(test.backend)
        }
        const reused = test.app.store.get(test.ref)
        acknowledge()
        await starting
        initializeProjectScope(undefined)
        if (refreshing !== undefined) {
          test.app.dispose()
          settleSchemas!()
          await refreshing
        }
        const accepted = mode === 'accepted' || mode === 'lost-release'
        if (accepted) {
          const restored = test.app.store.get(test.ref)!
          expect(restored.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 })
          expect(restored.assetRetentions).toContainEqual(expect.objectContaining({ ownerKind: 'shown-result', revision: 1 }))
          expect(owners.get(sourceOwner.ownerId)).toMatchObject({ revision: 2, complete: true, digests: [] })
        } else {
          expect(test.app.store.get(test.ref)).toBe(reused)
          expect(owners.get(sourceOwner.ownerId)).toEqual(sourceOwner)
          expect(loadExecutionResults(test.backendIdentity)).toHaveLength(1)
        }
        const intent = JSON.parse(localStorage.getItem(scopedStorageKey(`dinkster.workflow-retentions.${sourceOwner.ownerId}`))!)
        expect(intent.releaseRevision).toBe(accepted ? 1 : undefined)
      } finally { test.app.dispose() }
    },
  )

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

  it.each(['accepted', 'missing', 'revision', 'source', 'roots', 'failed'] as const)(
    'reconciles persisted owners before restoring results: %s', async (mode) => {
      const test = setup()
      const receipt: RetainedAssets = { scope: 'local', ownerKind: 'shown-result',
        ownerId: 'execution-result:original', revision: 1, complete: true,
        digests: [`blake3:${'c'.repeat(64)}`], sourceToken: 'a'.repeat(32) }
      saveExecutionResult({ ...test.saved, assetRetentions: [receipt] }, test.backendIdentity)
      let entered!: () => void
      const fetching = new Promise<void>((resolve) => { entered = resolve })
      let settle!: (value: RetainedAssets | undefined) => void
      let fail!: (error: Error) => void
      const acknowledgment = new Promise<RetainedAssets | undefined>((resolve, reject) => { settle = resolve; fail = reject })
      vi.spyOn(test.backend.connection, 'fetchRetainedAssets').mockImplementation(() => { entered(); return acknowledgment })
      try {
        const starting = test.app.start()
        await fetching
        expect(test.app.store.get(test.ref)).toBeUndefined()
        if (mode === 'failed') fail(new Error('Lost connection'))
        else settle(mode === 'missing' ? undefined : { ...receipt,
          ...(mode === 'revision' ? { revision: 2 } : {}),
          ...(mode === 'source' ? { sourceToken: 'b'.repeat(32) } : {}),
          ...(mode === 'roots' ? { digests: [`blake3:${'d'.repeat(64)}`] } : {}),
        })
        await starting
        if (mode === 'accepted') {
          expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 })
          const [replacement] = test.app.store.get(test.ref)!.assetRetentions!
          expect(replacement!.ownerId).not.toBe(receipt.ownerId)
          expect(replacement!.digests).toContain(receipt.digests[0])
          expect(replacement!.complete).toBe(false)
        } else {
          expect(test.app.store.get(test.ref)).toBeUndefined()
          expect(loadExecutionResults(test.backendIdentity)[0]?.assetRetentions).toEqual([receipt])
        }
      } finally { test.app.dispose() }
    },
  )

  it.each(['accepted', 'lost', 'conflict', 'disconnected', 'corrupt-storage'] as const)(
    'retires only the final locally admitted result holder: %s', async (mode) => {
      const test = setup()
      const original: RetainedAssets = { scope: 'local', ownerKind: 'shown-result',
        ownerId: 'execution-result:other-window', revision: 1, complete: true,
        digests: [`blake3:${'c'.repeat(64)}`], sourceToken: 'a'.repeat(32) }
      saveExecutionResult({ ...test.saved, assetRetentions: [original] }, test.backendIdentity)
      const owners = new Map([[original.ownerId, original]])
      vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
        const receipt = { ...owner, ...declaration, revision: 1 }
        owners.set(owner.ownerId, receipt)
        return receipt
      })
      vi.spyOn(test.backend.connection, 'fetchRetainedAssets').mockImplementation(async (owner) => owners.get(owner.ownerId))
      vi.spyOn(test.backend.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
        const held = owners.get(owner.ownerId)!
        if (held.revision !== revision) throw new Error('Revision conflict')
        if (owner.ownerKind === 'shown-result' && mode === 'conflict') {
          owners.set(owner.ownerId, { ...held, revision: 3, digests: [`blake3:${'d'.repeat(64)}`] })
          throw new Error('Owner reused')
        }
        const { sourceToken: _source, ...unbound } = held
        const tombstone = { ...unbound, revision: revision + 1, digests: [], complete: true }
        owners.set(owner.ownerId, tombstone)
        if (owner.ownerKind === 'shown-result' && mode === 'lost') throw new Error('Lost response')
        return tombstone
      })
      vi.spyOn(test.backend.connection, 'clearHistory').mockResolvedValue(1)
      try {
        await test.app.start()
        const restored = test.app.store.get(test.ref)!
        const local = restored.assetRetentions!.find((receipt) => receipt.ownerId !== original.ownerId)!
        expect(local.digests).toContain(original.digests[0])
        test.app.store.retain(test.ref)
        expect(await test.app.clearRunHistory(test.backend.id)).toBe(1)
        expect(loadExecutionResults(test.backendIdentity)).toHaveLength(0)
        expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 })
        expect(owners.get(local.ownerId)).toEqual(local)
        if (mode === 'disconnected') {
          vi.mocked(test.backend.connection.connect).mockRestore()
          test.backend.connection.connect()
          test.backend.connection.disconnect()
        }
        if (mode === 'corrupt-storage') localStorage.setItem(scopedStorageKey(EXECUTION_RESULTS_STORAGE_KEY), '{')
        for (let index = 0; index < 201; index++) {
          const ref = { connection: test.backend.id, prompt: asPromptId(`other-${index}`) }
          test.app.store.apply({ kind: 'started', execution: ref, timestamp: index + 100 })
          test.app.store.apply({ kind: 'completed', execution: ref, timestamp: index + 101 })
        }
        expect(test.app.store.get(test.ref)).toBeDefined()
        expect(owners.get(local.ownerId)).toEqual(local)
        test.app.store.release(test.ref)
        test.app.store.apply({ kind: 'started', execution: { connection: test.backend.id,
          prompt: asPromptId('after-unpin') }, timestamp: 999 })
        expect(test.app.store.get(test.ref)).toBeUndefined()
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(owners.get(original.ownerId)).toEqual(original)
        if (mode === 'accepted' || mode === 'lost') {
          expect(owners.get(local.ownerId)).toMatchObject({ revision: 2, complete: true, digests: [] })
        } else if (mode === 'conflict') {
          expect(owners.get(local.ownerId)).toMatchObject({ revision: 3, digests: [`blake3:${'d'.repeat(64)}`] })
        } else expect(owners.get(local.ownerId)).toEqual(local)
      } finally { test.app.dispose() }
    },
  )

  it.each(['admission', 'body'] as const)('refuses a source whose backend registry changes during %s', async (phase) => {
    const test = setup()
    try {
      let begin!: () => void
      const entered = new Promise<void>((resolve) => { begin = resolve })
      let admit!: (receipt: RetainedAssets) => void
      const admission = new Promise<RetainedAssets>((resolve) => { admit = resolve })
      let deliver!: (text: string) => void
      const body = new Promise<string>((resolve) => { deliver = resolve })
      let owner!: RetainedAssetOwner
      vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (requested, declaration) => {
        if (requested.ownerKind === 'preview') {
          owner = requested
          if (phase === 'admission') { begin(); return admission }
        }
        return { ...requested, ...declaration, revision: declaration.revision + 1 }
      })
      test.fetchSource.mockImplementation(async () => { begin(); return body })
      let settled = false
      const starting = test.app.start().then(() => { settled = true })
      await entered
      test.backend.registry.set({ ...test.registry })
      if (phase === 'admission') {
        expect(test.fetchSource).not.toHaveBeenCalled()
        admit({ ...owner, revision: 1, complete: false, digests: [test.saved.sourceDocument!] })
      } else {
        expect(settled).toBe(false)
        deliver(test.source)
      }
      await starting
      expect(test.app.store.get(test.ref)).toBeUndefined()
      if (phase === 'admission') expect(test.fetchSource).not.toHaveBeenCalled()
      expect(loadExecutionResults(test.backendIdentity)).toHaveLength(1)
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

  it('does not persist foreign or reconciled results without local compile proof', () => {
    const { artifact: _foreignArtifact, ...foreign } = completed('foreign')
    const { sourceDocument: _sourceDocument, ...unstamped } = completed('unstamped')
    saveExecutionResult(foreign, identity)
    saveExecutionResult(unstamped, identity)
    expect(loadExecutionResults(identity)).toEqual([])
  })

  it('persists exact independent owners even when display descriptors omit their roots', () => {
    const roots = [`blake3:${'c'.repeat(64)}`, `blake3:${'d'.repeat(64)}`]
    const assetRetentions: RetainedAssets[] = [
      { scope: 'local', ownerKind: 'shown-result', ownerId: 'execution-result:one', revision: 1,
        digests: roots, complete: true, sourceToken: 'a'.repeat(32) },
      { scope: 'local', ownerKind: 'shown-result', ownerId: 'execution-result:two', revision: 3,
        digests: roots, complete: false },
    ]
    saveExecutionResult({ ...completed('owners'), assetRetentions }, identity)
    const [saved] = loadExecutionResults(identity)
    expect(saved?.assetRetentions).toEqual(assetRetentions)
    expect(JSON.stringify(saved?.outputs)).not.toContain(roots[1])
  })

  it.each([
    { revision: 0 }, { ownerKind: 'document' }, { ownerId: 'different-owner' },
    { sourceToken: 'invalid' }, { digests: [`blake3:${'f'.repeat(64)}`, `blake3:${'e'.repeat(64)}`] },
  ])('refuses malformed persisted retention metadata: %j', (invalid) => {
    saveExecutionResult(completed('bad-owner'), identity)
    const raw = globalThis.localStorage.getItem(EXECUTION_RESULTS_STORAGE_KEY)!
    const envelope = JSON.parse(raw)
    envelope.results[0].assetRetentions = [{ scope: 'local', ownerKind: 'shown-result',
      ownerId: 'execution-result:one', revision: 1, digests: [], complete: false, ...invalid }]
    globalThis.localStorage.setItem(EXECUTION_RESULTS_STORAGE_KEY, JSON.stringify(envelope))
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
