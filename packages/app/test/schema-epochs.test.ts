/**
 * Epoch-gated schema refresh: schema_changed / composition_complete pings on
 * a native backend invalidate its registry (refetch /api/nodes), gated by the
 * held epoch and coalesced under concurrent pings. Composition narration and
 * pack failures surface in the activity log / problems, never the execution
 * store. Events are pushed through the real WS data path (handleWsData ->
 * normalizer -> wire listener), so this covers the full pipeline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineNotReadyError, type DinksterDiagnostics, type SchemaRegistry } from '@dinkster/client'
import { AppState, GLOBAL_PROBLEMS_OWNER, type Backend } from '../src/app-state.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const reg = (backend: Backend, epoch?: number): SchemaRegistry => ({
  connection: backend.id,
  hash: `h${epoch ?? 0}`,
  schemas: new Map(),
  diagnostics: [],
  resolve: () => undefined,
  ...(epoch !== undefined ? { epoch } : {}),
})

/** Push a raw wire message through the connection's real WS data path. */
const push = (backend: Backend, msg: Record<string, unknown>): void => {
  ;(backend.connection as unknown as { handleWsData(data: unknown): void }).handleWsData(
    JSON.stringify(msg),
  )
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

let app: AppState
let backend: Backend

const nativeConnection = () => {
  if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
  return backend.connection
}

beforeEach(() => {
  app = new AppState()
  const b = app.addBackend('http://native:8000', 'Native', false, 'dinkster')
  if (!b) throw new Error('addBackend rejected')
  backend = b
  vi.spyOn(nativeConnection(), 'fetchCompositionFailures').mockResolvedValue(undefined)
})

describe('schema_changed epoch invalidation', () => {
  it('refetches once and replaces the registry when a newer epoch is pinged', async () => {
    backend.registry.set(reg(backend, 1))
    const fetchSpy = vi
      .spyOn(backend.connection, 'fetchSchemas')
      .mockResolvedValue(reg(backend, 2))
    push(backend, { type: 'schema_changed', epoch: 2 })
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(backend.registry.get()?.epoch).toBe(2)
  })

  it('refreshes replacement problems and compat skips from the same diagnostics snapshot', async () => {
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    backend.registry.set(reg(backend, 1))
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 2))
    vi.spyOn(backend.connection, 'fetchDiagnostics').mockResolvedValue({
      replacementProblems: [],
      compatSkips: [{ packId: 'comfy', nodeId: 'CreateList', reason: 'unsupported nested marker' }],
    })

    push(backend, { type: 'schema_changed', epoch: 2 })
    await flush()

    expect(backend.replacementProblems.get()).toEqual([])
    expect(backend.compatSkips.get()).toEqual([
      { packId: 'comfy', nodeId: 'CreateList', reason: 'unsupported nested marker' },
    ])
  })

  it('keeps a newer diagnostics snapshot when an older request resolves last', async () => {
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    let resolveOlder!: (value: DinksterDiagnostics) => void
    let resolveNewer!: (value: DinksterDiagnostics) => void
    vi.spyOn(backend.connection, 'fetchDiagnostics')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve }))

    backend.refreshDiagnostics()
    backend.refreshDiagnostics()
    resolveNewer({
      replacementProblems: [],
      compatSkips: [{ packId: 'comfy', nodeId: 'Newer', reason: 'newer reason' }],
    })
    await flush()
    resolveOlder({
      replacementProblems: [],
      compatSkips: [{ packId: 'comfy', nodeId: 'Older', reason: 'older reason' }],
    })
    await flush()

    expect(backend.compatSkips.get()).toEqual([
      { packId: 'comfy', nodeId: 'Newer', reason: 'newer reason' },
    ])
  })

  it('skips the refetch when the held epoch is already at or past the ping', async () => {
    backend.registry.set(reg(backend, 3))
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas')
    push(backend, { type: 'schema_changed', epoch: 2 })
    push(backend, { type: 'schema_changed', epoch: 3 })
    await flush()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refetches when no registry is held yet (initial load raced the ping)', async () => {
    const fetchSpy = vi
      .spyOn(backend.connection, 'fetchSchemas')
      .mockResolvedValue(reg(backend, 1))
    push(backend, { type: 'schema_changed', epoch: 1 })
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('coalesces rapid pings: one fetch in flight, newer targets fold in', async () => {
    backend.registry.set(reg(backend, 1))
    let resolveFirst: ((r: SchemaRegistry) => void) | undefined
    const fetchSpy = vi
      .spyOn(backend.connection, 'fetchSchemas')
      .mockImplementationOnce(
        () =>
          new Promise<SchemaRegistry>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockResolvedValue(reg(backend, 4))
    push(backend, { type: 'schema_changed', epoch: 2 })
    push(backend, { type: 'schema_changed', epoch: 3 })
    push(backend, { type: 'schema_changed', epoch: 4 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // First fetch observed only epoch 2; the coalesced target is 4, so
    // exactly one follow-up fetch lands the newest surface.
    resolveFirst!(reg(backend, 2))
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(backend.registry.get()?.epoch).toBe(4)
  })

  it('FR9 stale epoch response stops after one fetch when the target is unchanged', async () => {
    backend.registry.set(reg(backend, 1))
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 1))
    push(backend, { type: 'schema_changed', epoch: 2 })
    await flush()
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('FR9 newer ping during an in-flight fetch triggers exactly one follow-up fetch', async () => {
    backend.registry.set(reg(backend, 1))
    let resolveFirst!: (registry: SchemaRegistry) => void
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValueOnce(reg(backend, 3))
    push(backend, { type: 'schema_changed', epoch: 2 })
    resolveFirst(reg(backend, 2))
    push(backend, { type: 'schema_changed', epoch: 3 })
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(backend.registry.get()?.epoch).toBe(3)
  })

  it('FR9 a ping after a failed refresh starts a new fetch (the gate resets)', async () => {
    backend.registry.set(reg(backend, 1))
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(reg(backend, 3))
    push(backend, { type: 'schema_changed', epoch: 2 })
    await flush()
    push(backend, { type: 'schema_changed', epoch: 3 })
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(backend.registry.get()?.epoch).toBe(3)
  })

  it('a failed refresh surfaces as a problem, not a silent stale registry', async () => {
    backend.registry.set(reg(backend, 1))
    vi.spyOn(backend.connection, 'fetchSchemas').mockRejectedValue(new Error('offline'))
    push(backend, { type: 'schema_changed', epoch: 2 })
    await flush()
    expect(app.problems.get().some((p) => p.code === 'schema.refreshFailed')).toBe(true)
    expect(backend.registry.get()?.epoch).toBe(1)
  })
})

// Reconnect capability invalidation: a restarted server can change
// load-bearing graph capabilities (dinkster.graphFeatures) while coming back at
// an equal or lower epoch, so every connected transition refetches
// /api/nodes unconditionally - and while that refetch has not landed, the
// epoch gate is bypassed so no ping is swallowed by a stale held epoch.
describe('reconnect capability invalidation', () => {
  const setStatus = (s: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'): void => {
    ;(backend.connection.status as unknown as { set(v: string): void }).set(s)
  }

  it('retires the worker catalog as soon as the connection leaves connected', () => {
    vi.spyOn(backend.connection, 'fetchSchemas').mockImplementation(() => new Promise(() => {}))
    setStatus('connected')
    backend.workerCatalog.set({
      status: 'ready',
      workers: [{ name: 'old-worker', status: 'connected', routedNodeTypes: [], deviceQualifiers: [] }],
    })

    setStatus('reconnecting')

    expect(backend.workerCatalog.get()).toEqual({ status: 'unsupported' })
  })

  it('refetches /api/nodes on reconnect even when the epoch did not advance', async () => {
    backend.registry.set(reg(backend, 3))
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 3))
    setStatus('connected')
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('replaces held graphFeatures with the restarted server\'s (feature appears, same epoch)', async () => {
    backend.registry.set(reg(backend, 3))
    vi.spyOn(backend.connection, 'fetchSchemas')
      .mockResolvedValue({ ...reg(backend, 3), graphFeatures: ['typedLiteral'] })
    setStatus('connected')
    await flush()
    expect(backend.registry.get()?.graphFeatures).toEqual(['typedLiteral'])
  })

  it('drops held graphFeatures when the restarted server no longer advertises them', async () => {
    backend.registry.set({ ...reg(backend, 3), graphFeatures: ['typedLiteral'] })
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 3))
    setStatus('connected')
    await flush()
    expect(backend.registry.get()?.graphFeatures).toBeUndefined()
  })

  it('fetches on the FIRST connect too when no registry is held (down-at-add recovery)', async () => {
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 1))
    setStatus('connected')
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(backend.registry.get()?.epoch).toBe(1)
  })

  it('an epoch ping after a FAILED reconnect refresh is not swallowed by the stale held epoch', async () => {
    backend.registry.set(reg(backend, 5))
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(reg(backend, 2))
    setStatus('connected')
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(app.problems.get().some((p) => p.code === 'schema.refreshFailed')).toBe(true)
    // The restarted server's epoch space restarted below the held 5: the
    // plain epoch gate would skip this ping, the stale-generation bypass
    // must not.
    push(backend, { type: 'schema_changed', epoch: 2 })
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(backend.registry.get()?.epoch).toBe(2)
  })

  it('a reconnect during an in-flight refresh triggers exactly one follow-up fetch', async () => {
    backend.registry.set(reg(backend, 1))
    let resolveFirst!: (r: SchemaRegistry) => void
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(reg(backend, 2))
    push(backend, { type: 'schema_changed', epoch: 2 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // The server restarts while that fetch is in flight: its response is
    // from the previous server life, so one follow-up must be issued.
    setStatus('connected')
    resolveFirst(reg(backend, 2))
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })

  it('strips held graphFeatures SYNCHRONOUSLY on reconnect, before the refetch commits', async () => {
    backend.registry.set({ ...reg(backend, 3), graphFeatures: ['typedLiteral'] })
    backend.workerCatalog.set({
      status: 'ready',
      workers: [{ name: 'old-worker', status: 'connected', routedNodeTypes: [], deviceQualifiers: [] }],
    })
    let resolveFetch!: (r: SchemaRegistry) => void
    vi.spyOn(backend.connection, 'fetchSchemas')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve }))
    setStatus('connected')
    // The refetch is still in flight: a compile in this window must not see
    // the previous server life's capabilities ($typed emission gates here).
    expect(backend.registry.get()?.graphFeatures).toBeUndefined()
    expect(backend.registry.get()?.epoch).toBe(3) // schemas stay for display
    expect(backend.workerCatalog.get()).toEqual({ status: 'unsupported' })
    resolveFetch({ ...reg(backend, 3), graphFeatures: ['typedLiteral'] })
    await flush()
    expect(backend.registry.get()?.graphFeatures).toEqual(['typedLiteral'])
  })

  it('invalidates both observable extension snapshot pairs before publishing a connected transition', () => {
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    const connection = backend.connection
    const oldPair = {
      digest: `sha256:${'a'.repeat(64)}`,
      snapshot: { format: 'dinkster.extension-snapshot' as const, version: 1 as const, frontendApi: '1.0.0', extensions: [] },
    }
    const held = { ...reg(backend, 3), extensionSnapshotPair: oldPair }
    backend.registry.set(held)
    ;(connection as unknown as { registry?: SchemaRegistry }).registry = held
    vi.spyOn(connection, 'fetchSchemas').mockImplementationOnce(() => new Promise(() => {}))
    const observations: [SchemaRegistry['extensionSnapshotPair'], SchemaRegistry['extensionSnapshotPair']][] = []
    const observe = () => observations.push([
      backend.registry.get()?.extensionSnapshotPair,
      connection.currentRegistry?.extensionSnapshotPair,
    ])
    backend.registry.subscribe(observe)
    app.backendsTick.subscribe(observe)

    setStatus('connected')

    expect(observations.length).toBeGreaterThan(0)
    expect(observations.every(([appPair, connectionPair]) => appPair === undefined && connectionPair === undefined)).toBe(true)
    expect(backend.registry.get()?.extensionSnapshotPair).toBeUndefined()
    expect(connection.currentRegistry?.extensionSnapshotPair).toBeUndefined()
    expect(backend.registry.get()?.epoch).toBe(3)
  })

  it('a FAILED reconnect refresh leaves capabilities invalidated, never restored', async () => {
    if (backend.protocol !== 'dinkster') throw new Error('expected native backend')
    const connection = backend.connection
    const oldPair = {
      digest: `sha256:${'a'.repeat(64)}`,
      snapshot: { format: 'dinkster.extension-snapshot' as const, version: 1 as const, frontendApi: '1.0.0', extensions: [] },
    }
    const held = { ...reg(backend, 3), graphFeatures: ['typedLiteral'], extensionSnapshotPair: oldPair }
    backend.registry.set(held)
    ;(connection as unknown as { registry?: SchemaRegistry }).registry = held
    vi.spyOn(connection, 'fetchSchemas').mockRejectedValue(new Error('offline'))
    setStatus('connected')
    await flush()
    expect(backend.registry.get()?.graphFeatures).toBeUndefined()
    expect(backend.registry.get()?.extensionSnapshotPair).toBeUndefined()
    expect(connection.currentRegistry?.extensionSnapshotPair).toBeUndefined()
    expect(app.problems.get().some((p) => p.code === 'schema.refreshFailed')).toBe(true)
  })

  it('never commits a response fetched under the PREVIOUS server life', async () => {
    backend.registry.set({ ...reg(backend, 3), graphFeatures: ['typedLiteral'] })
    let resolveFirst!: (r: SchemaRegistry) => void
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas')
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
      .mockResolvedValue(reg(backend, 3)) // the new life: no features
    push(backend, { type: 'schema_changed', epoch: 4 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // The server restarts while that fetch is in flight; its (old-life)
    // response advertising typedLiteral must be discarded, not committed -
    // committing would restore the capabilities the reconnect invalidated.
    setStatus('connected')
    resolveFirst({ ...reg(backend, 3), graphFeatures: ['typedLiteral'] })
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(backend.registry.get()?.graphFeatures).toBeUndefined()
  })

  it('a reconnect during a FAILING refresh gets exactly one follow-up fetch, which never retries itself', async () => {
    backend.registry.set(reg(backend, 1))
    let rejectFirst!: (e: Error) => void
    const fetchSpy = vi.spyOn(backend.connection, 'fetchSchemas')
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
      .mockRejectedValue(new Error('still offline'))
    push(backend, { type: 'schema_changed', epoch: 2 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    // The server restarts mid-fetch (the restart is WHY the fetch fails):
    // the new life still owes its unconditional fetch, exactly once.
    setStatus('connected')
    rejectFirst(new Error('connection reset'))
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    // The follow-up failed under the CURRENT life: report, never a third.
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(app.problems.get().some((p) => p.code === 'schema.refreshFailed')).toBe(true)
  })

  it('engine-not-ready during a reconnect refresh stays quiet (the supervisor narrates)', async () => {
    backend.registry.set(reg(backend, 3))
    vi.spyOn(backend.connection, 'fetchSchemas').mockRejectedValue(new EngineNotReadyError('starting'))
    setStatus('connected')
    await flush()
    expect(app.problems.get().some((p) => p.code === 'schema.refreshFailed')).toBe(false)
    expect(app.logs.get().some((l) => l.message.includes('engine not ready'))).toBe(true)
  })
})

describe('composition narration and pack failures', () => {
  it('composition_complete triggers the same epoch-gated refresh', async () => {
    backend.registry.set(reg(backend, 1))
    const fetchSpy = vi
      .spyOn(backend.connection, 'fetchSchemas')
      .mockResolvedValue(reg(backend, 3))
    push(backend, { type: 'composition_complete', epoch: 3 })
    await flush()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(backend.registry.get()?.epoch).toBe(3)
  })

  it('composition_progress narrates in the activity log without touching executions', () => {
    push(backend, { type: 'composition_progress', done: 2, total: 5, phase: 'packs' })
    expect(app.logs.get().find((l) => l.message.includes('2/5'))?.source).toBe('Native')
    expect(app.store.executions.get().size).toBe(0)
  })

  it('pack_failed lands in both the activity log and problems', () => {
    push(backend, { type: 'pack_failed', pack: 'vhs.video', error: 'boom' })
    const log = app.logs.get().find((l) => l.message.includes('vhs.video'))
    expect(log).toMatchObject({ severity: 'warn', source: 'Native' })
    const problem = app.problems.get().find((p) => p.code === 'schema.packFailed')
    expect(problem?.message).toContain('vhs.video')
    expect(problem?.message).toContain('boom')
  })

  it('reconstructs a missed pack failure during a schema load', async () => {
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 3))
    vi.spyOn(nativeConnection(), 'fetchDiagnostics').mockResolvedValue({
      replacementProblems: [],
      compatSkips: [],
    })
    vi.mocked(nativeConnection().fetchCompositionFailures).mockResolvedValue([
      { pack: 'dinkster-nodes-generation', error: 'schema-only nodes have no provider' },
    ])

    await app.refreshBackendSchemas(backend)
    await flush()

    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'schema.packFailed',
      message: '[Native] pack "dinkster-nodes-generation" failed to load: schema-only nodes have no provider',
    }))
  })

  it('reconstructs missed failures after reconnect', async () => {
    backend.registry.set(reg(backend, 3))
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 3))
    vi.mocked(nativeConnection().fetchCompositionFailures).mockResolvedValue([
      { pack: 'dinkster-compat-comfy', error: 'worker exited' },
    ])

    ;(backend.connection.status as unknown as { set(v: string): void }).set('connected')
    await flush()
    await flush()

    expect(app.problems.get()).toContainEqual(expect.objectContaining({
      code: 'schema.packFailed',
      message: '[Native] pack "dinkster-compat-comfy" failed to load: worker exited',
    }))
  })

  it('clears healed snapshot failures without clearing unrelated problems', async () => {
    backend.registry.set(reg(backend, 2))
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue(reg(backend, 3))
    vi.spyOn(nativeConnection(), 'fetchDiagnostics').mockResolvedValue({
      replacementProblems: [],
      compatSkips: [],
    })
    app.reportProblems(GLOBAL_PROBLEMS_OWNER, [
      { severity: 'error', origin: 'schema', code: 'other.problem', message: 'keep me' },
    ])
    push(backend, { type: 'pack_failed', pack: 'bad.pack', error: 'boom' })
    expect(app.problems.get().some((problem) => problem.code === 'schema.packFailed')).toBe(true)
    vi.mocked(nativeConnection().fetchCompositionFailures).mockResolvedValue([])

    await app.refreshBackendSchemas(backend)
    await flush()

    expect(app.problems.get().some((problem) => problem.code === 'schema.packFailed')).toBe(false)
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ code: 'other.problem' }))
  })

  it('a composition_complete with failures logs a warning naming the packs', () => {
    backend.registry.set(reg(backend, 2))
    push(backend, { type: 'composition_complete', epoch: 2, failed: ['bad.pack'] })
    expect(app.logs.get().some((l) => l.severity === 'warn' && l.message.includes('bad.pack'))).toBe(true)
  })
})
