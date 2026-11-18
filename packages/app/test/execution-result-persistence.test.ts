import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asConnectionId, asNodeId, asPromptId, compile, executionKey, loadDocument, type CompileArtifact, type DinksterNodesPayload } from '@dinkster/core'
import { buildDinksterRegistry, type ExecutionState, type RetainedAssets } from '@dinkster/client'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { scopedStorageKey } from '../src/projects.js'
import { AppState } from '../src/app-state.js'
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
    vi.spyOn(backend.connection, 'fetchJob').mockResolvedValue({ state: 'completed', jobRef: saved.jobRef, attemptId: 1,
      sourceDocument: saved.sourceDocument, submittedBy: saved.submittedBy,
      nodeStates: { [nodeId]: 'completed' }, outputs: saved.outputs })
    vi.spyOn(backend.connection, 'fetchTerminalResultAssets').mockImplementation(async (jobRef) => ({
      scope: 'local', jobRef, attemptId: 1, state: 'completed', complete: true,
      offers: [{ token: 'a'.repeat(32), scope: 'local', jobRef, attemptId: 1,
        nodeId, outputId: 'sum', publication: 1, complete: true, digests: [] }],
    }))
    vi.spyOn(backend.connection, 'claimResultAssets').mockImplementation(async (owner, sourceToken) =>
      ({ ...owner, sourceToken, revision: 1, complete: true, digests: [] }))
    const fetchSource = vi.spyOn(backend.connection, 'fetchAssetText').mockResolvedValue(JSON.stringify(loaded.document))
    vi.spyOn(backend.connection.values(), 'peek').mockResolvedValue({ available: true, renditions: [],
      descriptor: { typeId: 'INT', fingerprint: 'sum-seven', value: 7 } })
    return { app, backend, registry, ref, nodeId, saved, backendIdentity, fetchSource, source: JSON.stringify(loaded.document) }
  }

  it.each(['reopened', 'new-client', 'reopen-refused', 'replacement-refused', 'replacement-retry', 'independent-unreferenced', 'peer-held', 'holder-starts-during-release', 'holder-adopts-during-release', 'late-publication', 'unregistered-holder', 'legacy-project-holder', 'legacy-default-holder', 'closing-reader', 'census-failed', 'census-timeout', 'census-unsupported', 'uncovered', 'live-pin'] as const)(
    'reclaims only superseded own-client result journals before restoration at quota: %s', async (mode) => {
    const locks = new Map<string, LockInfo>()
    if (mode === 'census-timeout') locks.set('dinkster-result-holders:v2:unresponsive', { name: 'dinkster-result-holders:v2:unresponsive', mode: 'exclusive' })
    if (mode === 'legacy-project-holder') locks.set('dinkster-result-holders--p-other:legacy', { name: 'dinkster-result-holders--p-other:legacy', mode: 'exclusive' })
    const legacyChannel = mode === 'legacy-default-holder' ? new BroadcastChannel('dinkster-result-holders:') : undefined
    if (legacyChannel !== undefined) {
      locks.set('dinkster-result-holders:legacy', { name: 'dinkster-result-holders:legacy', mode: 'exclusive' })
      legacyChannel.addEventListener('message', (event) => {
        if (event.data.kind === 'query') legacyChannel.postMessage({ kind: 'holders', nonce: event.data.nonce, member: 'legacy', owners: [] })
      })
    }
    vi.stubGlobal('navigator', { locks: mode === 'census-unsupported' ? undefined : {
      request: async (name: string, options: LockOptions | ((lock: Lock) => unknown), callback?: (lock: Lock) => unknown) => {
        const consume = typeof options === 'function' ? options : callback!
        locks.set(name, { name, mode: 'exclusive' })
        try { return await consume({ name, mode: 'exclusive' }) } finally { locks.delete(name) }
      },
      query: async () => {
        if (mode === 'census-failed') throw new Error('Census unavailable')
        return { held: [...locks.values()], pending: [] }
      },
    } })
    const generation = '1'.repeat(32)
    const rotated = '2'.repeat(32)
    const session = makeStorage()
    if (mode !== 'new-client') session.setItem('dinkster.retention-generation.', generation)
    vi.stubGlobal('sessionStorage', session)
    const test = setup()
    const protectedOwner: RetainedAssets = { scope: 'local', ownerKind: 'shown-result',
      ownerId: 'execution-result:protected', holderClasses: [5, 6], revision: 1,
      complete: true, digests: [test.saved.sourceDocument!] }
    const controls = [protectedOwner, { ...protectedOwner, ownerId: 'execution-result:protected-source' },
      { ...protectedOwner, ownerId: 'execution-result:protected-token-a', sourceToken: 'a'.repeat(32) },
      { ...protectedOwner, ownerId: 'execution-result:protected-token-b', sourceToken: 'a'.repeat(32) }]
    const stale = Array.from({ length: 24 }, (_, index) => ({ ...controls[index % controls.length]!, ownerId: `execution-result:excess-${index}`,
      digests: mode === 'uncovered' ? [`blake3:${'c'.repeat(64)}`] : protectedOwner.digests }))
    const peer = { ...protectedOwner, ownerId: 'execution-result:peer' }
    const frozen: RetainedAssets = { ...protectedOwner, ownerKind: 'document',
      ownerId: 'workflow-candidate:frozen', holderClasses: [1, 2, 3] }
    const owners = new Map([...controls, ...stale, peer, frozen].map((owner) => [owner.ownerId, owner]))
    vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const retained = { ...owner, ...declaration, revision: declaration.revision + 1 }
      owners.set(owner.ownerId, retained)
      return retained
    })
    vi.mocked(test.backend.connection.claimResultAssets).mockImplementation(async (owner, sourceToken) => {
      const retained = { ...owner, sourceToken, revision: 1, complete: true, digests: [] }
      owners.set(owner.ownerId, retained)
      return retained
    })
    const keyFor = (owner: RetainedAssets) => scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`)
    for (const owner of owners.values()) localStorage.setItem(keyFor(owner), JSON.stringify({
      version: 3, connectionId: test.backend.id, assetBaseUrl: test.backend.connection.assetUrl(''), owner: {
        scope: owner.scope, ownerKind: owner.ownerKind, ownerId: owner.ownerId, holderClasses: owner.holderClasses,
      }, complete: owner.complete, digests: owner.digests, acknowledgedRevision: 1,
      ...(owner.sourceToken === undefined ? {} : { sourceToken: owner.sourceToken }),
      ...(owner.ownerKind === 'document' ? { documentLineage: 'frozen-control', documentRevision: 0 } : { executionKey: executionKey(test.saved.ref) }),
    }))
    saveExecutionResult({ ...test.saved, assetRetentions: mode === 'independent-unreferenced' ? controls.slice(1) : controls }, test.backendIdentity)
    let holder: AppState | undefined
    if (mode === 'unregistered-holder') {
      const navigator = globalThis.navigator
      vi.stubGlobal('navigator', {})
      try {
        holder = new AppState()
        holder.store.restoreCompleted({ ...test.saved, artifact: test.saved.artifact!, endedAt: test.saved.endedAt!,
          assetRetentions: [stale[0]!] })
        expect(holder.store.get(test.ref)?.assetRetentions).toEqual([stale[0]!])
      } finally { vi.stubGlobal('navigator', navigator) }
    }
    if (mode === 'holder-adopts-during-release' || mode === 'late-publication') holder = new AppState()
    const concurrentHolder = mode === 'holder-starts-during-release' || mode === 'holder-adopts-during-release'
    let releaseFirst: (() => void) | undefined
    let firstReleaseStarted: (() => void) | undefined
    const firstRelease = new Promise<void>((resolve) => { firstReleaseStarted = resolve })
    const releaseResponse = new Promise<void>((resolve) => { releaseFirst = resolve })
    let finishBody: (() => void) | undefined
    let stoppedRead: Promise<void> | undefined
    if (mode === 'independent-unreferenced' || mode === 'peer-held' || mode === 'closing-reader') {
      holder = new AppState()
      holder.store.restoreCompleted({ ...test.saved, artifact: test.saved.artifact!, endedAt: test.saved.endedAt!,
        assetRetentions: [mode === 'independent-unreferenced' ? protectedOwner : stale[0]!] })
      if (mode === 'closing-reader') {
        vi.spyOn(holder.connection, 'retainAssets').mockImplementation(async (owner, declaration) =>
          ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
        const reader = holder.executionAssetReader(holder.store.get(test.ref)!, [])
        expect(reader).toBeDefined()
        const reading = reader!.read(() => new Promise<number>((resolve) => { finishBody = () => resolve(7) }))
        stoppedRead = expect(reading).rejects.toThrow().then(() => undefined)
        await vi.waitFor(() => expect(finishBody).toBeDefined())
        holder.dispose()
        expect(holder.retentionActivity()).toMatchObject({ valueReads: 1 })
      }
    }
    let pinned: ReturnType<typeof test.app.activeTab>
    if (mode === 'live-pin') {
      test.backend.registry.set(test.registry)
      test.app.store.restoreCompleted({ ...test.saved, artifact: test.saved.artifact!, endedAt: test.saved.endedAt!,
        assetRetentions: [...controls, stale[0]!] })
      expect(await test.app.openExecutionView(test.ref)).toBe(true)
      pinned = test.app.activeTab()
    }
    const heldBytes = [...controls, peer, frozen].map((owner) => localStorage.getItem(keyFor(owner)))
    const storage = localStorage
    const units = () => Array.from({ length: storage.length }, (_, index) => {
      const key = storage.key(index)!
      return key.length + storage.getItem(key)!.length
    }).reduce((sum, size) => sum + size, 0)
    const capacity = units()
    vi.stubGlobal('localStorage', { ...storage, get length() { return storage.length }, setItem: (key: string, value: string) => {
      const previous = storage.getItem(key)
      if (units() - (previous === null ? 0 : key.length + previous.length) + key.length + value.length > capacity) {
        throw new DOMException('Browser storage quota exceeded', 'QuotaExceededError')
      }
      storage.setItem(key, value)
    } })
    const own = [...controls, ...stale, frozen]
    const holders = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [String(index + 1),
      own.filter((owner) => owner.holderClasses?.some((holder) => holder === index + 1))]))
    let replacementRefused = mode === 'replacement-refused' || mode === 'replacement-retry'
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://test')
      if (url.pathname === '/api/library/retention-clients') {
        if (mode === 'reopen-refused' && init?.method === 'POST') return new Response('', { status: 409 })
        return Response.json({
          clientId: '3'.repeat(32), generation: init?.method === 'POST' ? rotated : generation,
          revision: init?.method === 'POST' && mode !== 'new-client' ? 2 : 1, connected: true, pendingRequests: 0,
          activeStreams: 0, complete: false, holders,
        })
      }
      if (init?.method === 'GET' && url.pathname.includes('/retentions/shown-result/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
        if (replacementRefused && controls.some((owner) => owner.ownerId === id)) return new Response('', { status: 503 })
        return Response.json(owners.get(id))
      }
      if (init?.method === 'DELETE' && url.pathname.includes('/retentions/shown-result/')) {
        expect(new Headers(init.headers).get('X-Dinkster-Retention-Generation')).toBe(rotated)
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
        if ((concurrentHolder || mode === 'late-publication') && id === stale[0]!.ownerId) {
          firstReleaseStarted!()
          await releaseResponse
        }
        const old = owners.get(id)!
        const released = { ...old, revision: 2, complete: true, digests: [] }
        delete released.sourceToken
        owners.set(id, released)
        return Response.json(released)
      }
      return new Response('', { status: 404 })
    })
    try {
      const pinnedExecution = pinned === undefined ? undefined : test.app.executionForTab(pinned)
      const starting = test.app.start()
      const publishReleased = () => holder!.store.restoreCompleted({ ...test.saved,
        artifact: test.saved.artifact!, endedAt: test.saved.endedAt!, assetRetentions: [stale[0]!] })
      if (mode === 'late-publication') {
        await firstRelease
        expect(publishReleased).toThrow('Result ownership changed before publication')
        expect(holder!.store.get(test.ref)).toBeUndefined()
        releaseFirst!()
      }
      if (concurrentHolder) {
        await firstRelease
        holder ??= new AppState()
        holder.store.restoreCompleted({ ...test.saved, artifact: test.saved.artifact!, endedAt: test.saved.endedAt!,
          assetRetentions: [stale[1]!] })
        expect(holder.store.get(test.ref)?.assetRetentions).toEqual([stale[1]!])
        releaseFirst!()
      }
      await starting
      if (mode === 'late-publication') {
        expect(owners.get(stale[0]!.ownerId)).toMatchObject({ revision: 2, complete: true, digests: [] })
        expect(localStorage.getItem(keyFor(stale[0]!))).toBeNull()
        expect(publishReleased).toThrow('Result ownership changed before publication')
        expect(holder!.store.get(test.ref)).toBeUndefined()
      }
      if (mode === 'replacement-retry') {
        expect(owners.get(stale[0]!.ownerId)).toEqual(stale[0])
        replacementRefused = false
        await test.app.refreshBackendSchemas(test.backend)
      }
      if (concurrentHolder) {
        expect(owners.get(stale[1]!.ownerId)).toEqual(stale[1])
        expect(JSON.parse(localStorage.getItem(keyFor(stale[1]!))!)).toMatchObject({ acknowledgedRevision: 1 })
        expect(holder!.store.get(test.ref)?.assetRetentions).toEqual([stale[1]!])
      }
      const reclaim = mode === 'reopened' || mode === 'live-pin' || mode === 'replacement-retry' || mode === 'independent-unreferenced' || mode === 'peer-held' || concurrentHolder || mode === 'late-publication'
      for (const owner of stale) {
        if (concurrentHolder && owner !== stale[0]) continue
        const released = reclaim && !((mode === 'live-pin' || mode === 'peer-held') && owner === stale[0])
        expect(owners.get(owner.ownerId)).toEqual(released ? { ...owner, sourceToken: undefined, revision: 2, complete: true, digests: [] } : owner)
        if (released) expect(localStorage.getItem(keyFor(owner))).toBeNull()
        else expect(JSON.parse(localStorage.getItem(keyFor(owner))!)).toMatchObject({ acknowledgedRevision: 1 })
      }
      for (const [index, owner] of [...controls, peer, frozen].entries()) {
        expect(owners.get(owner.ownerId)).toEqual(owner)
        expect(localStorage.getItem(keyFor(owner))).toBe(heldBytes[index])
      }
      if (reclaim) expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 })
      if (pinned !== undefined) {
        expect(test.app.tabs.get()).toContain(pinned)
        expect(test.app.executionForTab(pinned)).toBe(pinnedExecution)
      }
      if (mode === 'independent-unreferenced') {
        holder!.dispose()
        await vi.waitFor(() => expect([...locks.keys()].filter((name) => name.startsWith('dinkster-result-holders:'))).toHaveLength(1))
        await test.app.refreshBackendSchemas(test.backend)
        expect(owners.get(protectedOwner.ownerId)).toMatchObject({ revision: 2, complete: true, digests: [] })
        expect(localStorage.getItem(keyFor(protectedOwner))).toBeNull()
      }
      if (mode === 'closing-reader') {
        expect([...locks.keys()].filter((name) => name.startsWith('dinkster-result-holders:'))).toHaveLength(2)
        finishBody!()
        await stoppedRead
        await vi.waitFor(() => expect([...locks.keys()].filter((name) => name.startsWith('dinkster-result-holders:'))).toHaveLength(1))
        await test.app.refreshBackendSchemas(test.backend)
        for (const owner of stale) {
          expect(owners.get(owner.ownerId)).toMatchObject({ revision: 2, complete: true, digests: [] })
          expect(localStorage.getItem(keyFor(owner))).toBeNull()
        }
      }
      expect(test.app.retentionActivity()).toMatchObject({ restorations: 0, retirements: 0 })
    } finally { releaseFirst?.(); finishBody?.(); await stoppedRead; holder?.dispose(); test.app.dispose(); legacyChannel?.close() }
  })

  it.each(['startup', 'startup-first', 'refresh-first'] as const)('restores two source-bound results through public value admission before publication: %s', async (order) => {
    const test = setup()
    const schemas: Array<(registry: typeof test.registry) => void> = []
    if (order !== 'startup') {
      vi.mocked(test.backend.connection.fetchSchemas).mockImplementation(() => new Promise((resolve) => { schemas.push(resolve) }))
    }
    const second = { ...test.saved, ref: { ...test.ref, prompt: asPromptId('restored-second') }, jobRef: 'run-restored-second' }
    saveExecutionResult(second, test.backendIdentity)
    vi.mocked(test.backend.connection.values().peek).mockRestore()
    vi.mocked(test.backend.connection.claimResultAssets).mockRestore()
    vi.mocked(test.backend.connection.fetchTerminalResultAssets).mockImplementation(async (jobRef) => ({
      scope: 'local', jobRef, attemptId: 1, state: 'completed', complete: false,
      offers: [{ token: 'a'.repeat(32), scope: 'local', jobRef, attemptId: 1, nodeId: test.nodeId,
        outputId: 'sum', publication: 1, digests: [test.saved.sourceDocument!], complete: false }],
    }))
    const owners = new Map<string, RetainedAssets>()
    const results = [test.saved, second]
    vi.mocked(test.backend.connection.fetchJob).mockImplementation(async (prompt) => {
      const saved = results.find((result) => result.ref.prompt === prompt)!
      return { state: 'completed', jobRef: saved.jobRef, attemptId: 1, sourceDocument: saved.sourceDocument,
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
        expect(new Headers(init.headers).get('X-Dinkster-Retention-Holder')).toBe('5,6')
        const receipt: RetainedAssets = { scope: 'local', ownerKind: 'shown-result', ownerId, revision: 1,
          holderClasses: [5, 6], digests: [test.saved.sourceDocument!], complete: false, sourceToken: 'a'.repeat(32) }
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
        const snapshot = restored.assetRetentions?.find((receipt) => receipt.sourceToken === undefined)
        expect(snapshot).toMatchObject({ complete: true, digests: [test.saved.sourceDocument] })
        const source = restored.assetRetentions?.find((receipt) => receipt.sourceToken !== undefined)
        expect(source).toMatchObject({ complete: false, sourceToken: 'a'.repeat(32), digests: [test.saved.sourceDocument] })
        for (const receipt of restored.assetRetentions ?? []) expect(owners.get(receipt.ownerId)).toEqual(receipt)
      }
      expect(loadExecutionResults(test.backendIdentity)).toHaveLength(2)
      expect(await test.backend.connection.values().peek({ jobId: 'foreign-read', nodeId: test.nodeId, outputId: 'sum' }))
        .toMatchObject({ available: false, reason: 'ownership-unconfirmed' })
    } finally { test.app.dispose() }
  })
  it.each(['replaced', 'different-source', 'failed-replacement', 'disconnected'] as const)('retires an interrupted source reader only after successful same-result replacement: %s', async (mode) => {
    const test = setup()
    const owners = new Map<string, RetainedAssets>()
    let finishRead!: (source: string) => void
    const pending = new Promise<string>((resolve) => { finishRead = resolve })
    test.fetchSource.mockReturnValueOnce(pending)
    vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const receipt = { ...owner, ...declaration, revision: 1 }
      owners.set(owner.ownerId, receipt)
      return receipt
    })
    vi.spyOn(test.backend.connection, 'releaseRetainedAssets').mockImplementation(async (owner, revision) => {
      const receipt = { ...owner, revision: revision + 1, complete: true, digests: [] }
      owners.set(owner.ownerId, receipt)
      return receipt
    })
    const previews = () => [...owners.values()].filter((receipt) => receipt.ownerKind === 'preview')
    try {
      const starting = test.app.start()
      await vi.waitFor(() => expect(test.fetchSource).toHaveBeenCalledTimes(1))
      const interrupted = previews()[0]!
      expect(interrupted).toMatchObject({ revision: 1, complete: false, digests: [test.saved.sourceDocument] })
      let refreshing: Promise<void> | undefined
      if (mode === 'different-source') {
        const sourceDocument = `blake3:${'c'.repeat(64)}`
        saveExecutionResult({ ...test.saved, sourceDocument }, test.backendIdentity)
        const history = await test.backend.connection.getHistoryRun(test.saved.jobRef!, 'local')
        vi.mocked(test.backend.connection.getHistoryRun).mockResolvedValue({ ...history!, sourceDocument })
        const job = await test.backend.connection.fetchJob(test.ref.prompt)
        vi.mocked(test.backend.connection.fetchJob).mockResolvedValue({ ...job!, sourceDocument })
      }
      if (mode === 'failed-replacement') vi.mocked(test.backend.connection.fetchTerminalResultAssets).mockResolvedValue(undefined)
      if (mode !== 'disconnected') {
        refreshing = test.app.refreshBackendSchemas(test.backend)
        await vi.waitFor(() => expect(test.backend.connection.fetchSchemas).toHaveBeenCalledTimes(2))
      } else {
        const status = test.backend.connection.status as unknown as { set(value: string): void }
        status.set('connecting')
        status.set('disconnected')
      }
      expect(owners.get(interrupted.ownerId)).toEqual(interrupted)
      finishRead(test.source)
      await Promise.all([starting, refreshing])
      if (mode === 'replaced') {
        await vi.waitFor(() => expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 }))
        await vi.waitFor(() => expect(owners.get(interrupted.ownerId)).toMatchObject({ revision: 2, complete: true, digests: [] }))
        expect(previews().every((receipt) => receipt.revision === 2)).toBe(true)
      } else if (mode === 'different-source') {
        await vi.waitFor(() => expect(test.app.store.get(test.ref)?.sourceDocument).toBe(`blake3:${'c'.repeat(64)}`))
        expect(owners.get(interrupted.ownerId)).toEqual(interrupted)
        expect(previews()).toContainEqual(expect.objectContaining({ revision: 2, digests: [], complete: true }))
      } else {
        expect(test.app.store.get(test.ref)).toBeUndefined()
        expect(owners.get(interrupted.ownerId)).toEqual(interrupted)
      }
    } finally { finishRead(test.source); test.app.dispose() }
  })

  it.each(['unregistered', 'registered', 'running', 'missing-seal', 'completion-later', 'registration-during-read'] as const)('reconciles a peer result saved after this window opened: %s', async (mode) => {
    const events = new EventTarget()
    vi.stubGlobal('addEventListener', events.addEventListener.bind(events))
    vi.stubGlobal('removeEventListener', events.removeEventListener.bind(events))
    const test = setup()
    clearExecutionResults()
    vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) =>
      ({ ...owner, ...declaration, revision: declaration.revision + 1 }))
    try {
      await test.app.start()
      test.app.store.apply({ kind: 'started', execution: test.ref, timestamp: 1 })
      if (mode !== 'running' && mode !== 'completion-later') test.app.store.apply({ kind: 'completed', execution: test.ref, timestamp: 2 })
      if (mode === 'registered') test.app.store.register(test.ref, test.saved.artifact!)
      if (mode === 'missing-seal') vi.mocked(test.backend.connection.fetchTerminalResultAssets).mockResolvedValue(undefined)
      let finishRead: ((source: string) => void) | undefined
      if (mode === 'registration-during-read') test.fetchSource.mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
      let before = test.app.store.get(test.ref)
      saveExecutionResult(test.saved, test.backendIdentity)
      events.dispatchEvent(Object.assign(new Event('storage'), {
        key: scopedStorageKey(EXECUTION_RESULTS_STORAGE_KEY),
        newValue: globalThis.localStorage.getItem(scopedStorageKey(EXECUTION_RESULTS_STORAGE_KEY)),
      }))
      if (mode === 'registration-during-read') {
        await vi.waitFor(() => expect(finishRead).toBeDefined())
        test.app.store.register(test.ref, test.saved.artifact!)
        before = test.app.store.get(test.ref)
        finishRead!(test.source)
      }
      if (mode === 'completion-later') test.app.store.apply({ kind: 'completed', execution: test.ref, timestamp: 3 })
      if (mode === 'unregistered' || mode === 'completion-later') {
        await vi.waitFor(() => expect(test.app.store.get(test.ref)?.jobRef).toBe(test.saved.jobRef))
        expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toEqual({ typeId: 'INT', fingerprint: 'sum-seven', value: 7 })
        expect(test.app.store.get(test.ref)?.assetRetentions?.every((receipt) => receipt.complete)).toBe(true)
      } else {
        if (mode === 'missing-seal') await vi.waitFor(() => expect(test.backend.connection.fetchTerminalResultAssets).toHaveBeenCalled())
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(test.app.store.get(test.ref)).toBe(before)
      }
    } finally { test.app.dispose() }
  })

  it('reports source restoration as pending until its preview retirement acknowledges', async () => {
    const test = setup()
    let finish!: (receipt: RetainedAssets) => void
    let released!: RetainedAssets
    vi.spyOn(test.backend.connection, 'releaseRetainedAssets').mockImplementation((owner, revision) => {
      released = { ...owner, revision: revision + 1, complete: true, digests: [] }
      return new Promise((resolve) => { finish = resolve })
    })
    try {
      const starting = test.app.start()
      await vi.waitFor(() => expect(released).toBeDefined())
      expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 })
      expect(test.app.retentionActivity().restorations).toBeGreaterThan(0)
      finish(released)
      await starting
      expect(test.app.retentionActivity()).toMatchObject({ restorations: 0, retirements: 0, valueAdmissions: 0 })
    } finally { if (finish) finish(released); test.app.dispose() }
  })

  it('keeps shown-result ownership flat when an unchanged value is read again', async () => {
    const test = setup()
    const owners = new Map<string, RetainedAssets>()
    let token = 'a'.repeat(32)
    const digests = [`blake3:${'c'.repeat(64)}`]
    vi.mocked(test.backend.connection.retainAssets).mockImplementation(async (owner, declaration) => {
      const receipt = { ...owner, ...declaration, revision: 1 }
      if (owner.ownerKind === 'shown-result') owners.set(owner.ownerId, receipt)
      return receipt
    })
    vi.mocked(test.backend.connection.claimResultAssets).mockImplementation(async (owner, sourceToken) => {
      const receipt = { ...owner, sourceToken, revision: 1, complete: true, digests }
      owners.set(owner.ownerId, receipt)
      return receipt
    })
    vi.mocked(test.backend.connection.fetchTerminalResultAssets).mockImplementation(async (jobRef) => ({
      scope: 'local', jobRef, attemptId: 1, state: 'completed', complete: true,
      offers: [{ token, scope: 'local', jobRef, attemptId: 1, nodeId: test.nodeId,
        outputId: 'sum', publication: 1, complete: true, digests }],
    }))
    vi.mocked(test.backend.connection.values().peek).mockRestore()
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://test')
      if (url.pathname.includes('/retentions/shown-result/')) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1)!)
        const owner = owners.get(id)
        if (owner === undefined) return new Response('', { status: 404 })
        if (init?.method === 'DELETE') {
          const released = { ...owner, revision: owner.revision + 1, complete: true, digests: [] }
          delete released.sourceToken
          owners.set(id, released)
          return Response.json(released)
        }
        return Response.json(owner)
      }
      if (url.pathname !== '/api/values') return new Response('', { status: 404 })
      return Response.json({ available: true, descriptor: { typeId: 'INT', fingerprint: 'sum-seven', value: 7 },
        renditions: [], resultOffer: { token, scope: 'local', jobRef: test.saved.jobRef,
          attemptId: 1, nodeId: test.nodeId, outputId: 'sum', publication: 1, complete: true, digests } })
    }))
    const journals = () => Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .filter((key) => key.includes('dinkster.workflow-retentions.')).sort()
      .map((key) => [key, localStorage.getItem(key)]))
    try {
      await test.app.start()
      expect(test.app.store.get(test.ref)?.outputs[test.nodeId]?.sum).toMatchObject({ value: 7 })
      const query = { jobId: test.ref.prompt, nodeId: test.nodeId, outputId: 'sum' }
      expect(await test.backend.connection.values().peek(query)).toMatchObject({ available: true })
      const settledJournals = journals()
      const settledOwners = [...owners.values()]
      for (let index = 0; index < 12; index++) {
        const result = await test.backend.connection.values().peek(query)
        expect(result).toMatchObject({ available: true, descriptor: { value: 7 } })
        if (result.available) expect(await test.backend.connection.values().read(query, result.descriptor, async () => 7)).toBe(7)
      }
      expect(journals()).toEqual(settledJournals)
      expect([...owners.values()]).toEqual(settledOwners)
      token = 'd'.repeat(32)
      const changed = await Promise.all(Array.from({ length: 3 }, () => test.backend.connection.values().peek(query)))
      expect(changed.every((result) => result.available)).toBe(true)
      expect(owners.size).toBe(settledOwners.length + 1)
      expect([...owners.values()].filter((receipt) => receipt.sourceToken === token)).toEqual([
        expect.objectContaining({ complete: true, digests, sourceToken: token }),
      ])
      const independent = test.app.store.get(test.ref)!.assetRetentions!
      const independentBytes = independent.map((owner) => localStorage.getItem(scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`)))
      for (let index = 1; index <= 12; index++) {
        const old = [...owners.values()].find((owner) => owner.sourceToken === token &&
          !independent.some((receipt) => receipt.ownerId === owner.ownerId))!
        let finishRead!: (value: number) => void
        let pendingRead: Promise<number> | undefined
        if (index === 1) {
          const original = changed[0]!
          if (!original.available) throw new Error('Expected original admitted descriptor')
          pendingRead = test.backend.connection.values().read(query, original.descriptor, () =>
            new Promise<number>((resolve) => { finishRead = resolve }))
          await vi.waitFor(() => expect(finishRead).toBeDefined())
        }
        token = index.toString(16).padStart(32, '0')
        const next = await test.backend.connection.values().peek(query)
        expect(next).toMatchObject({ available: true })
        if (pendingRead !== undefined) {
          expect(test.app.retentionActivity()).toMatchObject({ valueReads: 1, drainingReaders: 1 })
          expect(owners.get(old.ownerId)).toEqual(old)
          expect(JSON.parse(localStorage.getItem(scopedStorageKey(`dinkster.workflow-retentions.${old.ownerId}`))!))
            .toMatchObject({ acknowledgedRevision: 1 })
          finishRead(7)
          expect(await pendingRead).toBe(7)
        }
        await vi.waitFor(() => expect(test.app.retentionActivity()).toMatchObject({ drainingReaders: 0, retirements: 0 }))
        expect([...owners.values()].filter((owner) => owner.ownerKind === 'shown-result' && owner.revision === 1 &&
          !independent.some((receipt) => receipt.ownerId === owner.ownerId))).toHaveLength(1)
        for (const admitted of changed) {
          if (!admitted.available) throw new Error('Expected original admitted descriptor')
          expect(await test.backend.connection.values().read(query, admitted.descriptor, async () => 7)).toBe(7)
        }
        for (const [offset, owner] of independent.entries()) {
          expect(owners.get(owner.ownerId)).toEqual(owner)
          expect(localStorage.getItem(scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`))).toBe(independentBytes[offset])
        }
      }
      const replacementJournals = journals()
      expect(await test.backend.connection.values().peek(query)).toMatchObject({ available: true })
      expect(journals()).toEqual(replacementJournals)
      const replacement = [...owners.values()].find((receipt) => receipt.sourceToken === token)!
      const replacementKey = scopedStorageKey(`dinkster.workflow-retentions.${replacement.ownerId}`)
      localStorage.setItem(replacementKey, JSON.stringify({ ...JSON.parse(localStorage.getItem(replacementKey)!), releaseRevision: 1 }))
      expect(await test.backend.connection.values().peek(query)).toMatchObject({ available: true })
      expect(owners.size).toBe(settledOwners.length + 14)
      let finish!: (value: number) => void
      const body = new Promise<number>((resolve) => { finish = resolve })
      let entered = 0
      const reads = changed.map((result) => {
        if (!result.available) throw new Error('Expected admitted descriptor')
        return test.backend.connection.values().read(query, result.descriptor, async () => { entered++; return body })
      })
      const stopped = Promise.all(reads.map(async (read) => { await expect(read).rejects.toThrow() }))
      await vi.waitFor(() => expect(entered).toBe(3))
      test.app.dispose()
      finish(7)
      await stopped
    } finally { test.app.dispose() }
  })

  it.each(['accepted', 'saved-extra', 'missing-seal', 'wrong-attempt', 'refused', 'mismatched', 'malformed', 'absent', 'failed-body'] as const)('restores only an admitted persisted source: %s', async (mode) => {
    const test = setup()
    try {
      if (mode === 'saved-extra') {
        const receipt: RetainedAssets = { scope: 'local', ownerKind: 'shown-result', ownerId: 'execution-result:older',
          revision: 1, complete: false, digests: [`blake3:${'c'.repeat(64)}`] }
        saveExecutionResult({ ...test.saved, assetRetentions: [receipt] }, test.backendIdentity)
        vi.spyOn(test.backend.connection, 'fetchRetainedAssets').mockResolvedValue(receipt)
      }
      if (mode === 'missing-seal') vi.mocked(test.backend.connection.fetchTerminalResultAssets).mockResolvedValue(undefined)
      if (mode === 'wrong-attempt') {
        const terminal = await test.backend.connection.fetchTerminalResultAssets(test.saved.jobRef!, test.ref.prompt)
        vi.mocked(test.backend.connection.fetchTerminalResultAssets).mockResolvedValue({ ...terminal!, attemptId: 2 })
      }
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
        expect(test.app.store.get(test.ref)?.assetRetentions?.every((receipt) => receipt.complete)).toBe(true)
      } else if (mode === 'saved-extra') {
        expect(test.app.store.get(test.ref)?.assetRetentions).toContainEqual(expect.objectContaining({
          complete: false, digests: [`blake3:${'c'.repeat(64)}`], revision: 1,
        }))
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
