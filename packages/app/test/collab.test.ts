/**
 * App collaboration lifecycle (docs/collaboration.md): sharing a tab swaps
 * it onto a SharedDocumentSession, joining stands a discovered session up as
 * a tab, leaving falls back to a local session over the current document,
 * and closing/replacing a shared tab disposes its transport. Driven through
 * an in-memory CollabTransport whose fake server mirrors the real semantics
 * (exact-baseRevision acceptance, WS-style broadcast to every subscriber,
 * catch-up above the snapshot, session_closed on end), so two AppStates
 * genuinely converge through the same machinery the HTTP adapter drives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAB_PROTOCOL_VERSION,
  DocumentTypeRegistry,
  applyOps,
  asConnectionId,
  asNodeId,
  diag,
  invertOps,
  isValidActorId,
  type CollabClientOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
  type CollabSessionDescriptor,
  type DocumentTypeAdapter,
  type FetchOpsOutcome,
  type Json,
  type NodeSchema,
  type PostOpOutcome,
  type PutSnapshotOutcome,
  type SharedDocumentSession,
  type WorkflowDocument,
} from '@dinkster/core'
import { buildDinksterRegistry } from '@dinkster/client'
import nodesPayload from '../../core/fixtures/dinkster-nodes.json'
import seedBasic from '../../core/fixtures/workflows/seed-basic.json'
import seedSubgraph from '../../core/fixtures/workflows/seed-subgraph.json'
import { AppState, GLOBAL_PROBLEMS_OWNER, type Tab } from '../src/app-state.js'
import { bindBrowserActor, COLLAB_ACTOR_ID_KEY, COLLAB_SCOPE, stableActorId, type CollabTransport } from '../src/collab.js'
import { APP_EDITOR_KIND } from '../src/editors.js'
import { flattenInvocation } from '../src/subgraph-lifecycle.js'

// AppState builds its WS url from the page origin; give the node test env one.
;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

async function until(cond: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ---------------------------------------------------------------------------
// In-memory collab server + transport
// ---------------------------------------------------------------------------

interface ServerSession {
  readonly sessionId: string
  readonly scope: string
  readonly documentId: string
  snapshot: unknown
  snapshotRevision: number
  revision: number
  readonly log: CollabServerOp[]
  readonly seen: Map<string, CollabServerOp>
  readonly connections: Set<FakeConn>
}

class FakeConn implements CollabConnection {
  readonly sessionId: string
  closed = false
  private announced = false
  private readonly listeners = new Set<(e: CollabConnectionEvent) => void>()

  constructor(
    private readonly server: FakeCollabServer,
    private readonly session: ServerSession,
    readonly actorId: string,
  ) {
    this.sessionId = session.sessionId
    session.connections.add(this)
  }

  emit(event: CollabConnectionEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  async postOp(op: CollabClientOp): Promise<PostOpOutcome> {
    if (op.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
      return { kind: 'protocol-unsupported', supported: [COLLAB_PROTOCOL_VERSION] }
    }
    // Joint actorId pin (backend 8f392f3/f18e957 rejects with a 400): the
    // app must never send one, so the fake fails the test loudly instead of
    // accepting what the real server would refuse.
    if (!isValidActorId(op.actorId)) throw new Error(`op with pin-violating actorId ${JSON.stringify(op.actorId)}`)
    const dup = this.session.seen.get(op.opId)
    if (dup) return { kind: 'accepted', op: { ...dup, replayed: true } }
    if (op.baseRevision !== this.session.revision) {
      this.server.staleBases++
      return { kind: 'stale-base', revision: this.session.revision }
    }
    const server: CollabServerOp = {
      opId: op.opId,
      actorId: op.actorId,
      baseRevision: op.baseRevision,
      revision: ++this.session.revision,
      patch: op.patch,
      timestamp: 1000,
    }
    this.session.log.push(server)
    this.session.seen.set(op.opId, server)
    // WS-style fan-out to every subscriber, the poster included (the
    // session dedupes its own echo by revision).
    for (const conn of [...this.session.connections]) conn.emit({ kind: 'op', op: server })
    return { kind: 'accepted', op: server }
  }

  async fetchSnapshot(): Promise<{ readonly revision: number; readonly document: unknown }> {
    return { revision: this.session.snapshotRevision, document: this.session.snapshot }
  }

  async fetchOps(after: number): Promise<FetchOpsOutcome> {
    return { kind: 'ops', ops: this.session.log.filter((o) => o.revision > after) }
  }

  async putSnapshot(revision: number, document: WorkflowDocument): Promise<PutSnapshotOutcome> {
    // Backend rule: a checkpoint must ADVANCE the retained snapshot and may
    // not claim a revision the session has not reached (409 conflict).
    if (revision <= this.session.snapshotRevision || revision > this.session.revision) return { kind: 'conflict' }
    this.session.snapshot = document
    this.session.snapshotRevision = revision
    return { kind: 'ok' }
  }

  sendPresence(payload: Json): void {
    // Backend semantics: presence relays to OTHER subscribers only, never
    // stored, never echoed back to the sender.
    if (this.closed) return
    for (const conn of [...this.session.connections]) {
      if (conn !== this) conn.emit({ kind: 'presence', actorId: this.actorId, payload })
    }
  }

  onEvent(listener: (event: CollabConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    if (!this.announced) {
      // Descriptor-first WS contract: 'connected' announces the session's
      // current revision, which triggers catch-up above the snapshot.
      this.announced = true
      queueMicrotask(() => {
        if (!this.closed) this.emit({ kind: 'connected', descriptor: this.server.descriptorOf(this.session) })
      })
    }
    return () => this.listeners.delete(listener)
  }

  close(): void {
    this.closed = true
    this.session.connections.delete(this)
  }
}

class FakeCollabServer {
  private n = 0
  readonly sessions = new Map<string, ServerSession>()
  readonly createCalls: { baseUrl: string; scope: string; documentId: string }[] = []
  readonly endedSessions: string[] = []
  /** How many ops were refused stale-base (a real concurrency collision). */
  staleBases = 0

  descriptorOf(s: ServerSession): CollabSessionDescriptor {
    return {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId: s.sessionId,
      scope: s.scope,
      documentId: s.documentId,
      revision: s.revision,
      snapshotRevision: s.snapshotRevision,
    }
  }

  createSession(scope: string, documentId: string, snapshot: unknown): ServerSession {
    const session: ServerSession = {
      sessionId: `sess-${++this.n}`,
      scope,
      documentId,
      snapshot,
      snapshotRevision: 0,
      revision: 0,
      log: [],
      seen: new Map(),
      connections: new Set(),
    }
    this.sessions.set(session.sessionId, session)
    return session
  }

  readonly transport: CollabTransport = {
    create: async (baseUrl, args) => {
      this.createCalls.push({ baseUrl, scope: args.scope, documentId: args.documentId })
      return this.descriptorOf(this.createSession(args.scope, args.documentId, args.snapshot))
    },
    list: async (_baseUrl, scope) =>
      [...this.sessions.values()].filter((s) => s.scope === scope).map((s) => this.descriptorOf(s)),
    get: async (_baseUrl, sessionId) => {
      const s = this.sessions.get(sessionId)
      return s === undefined ? undefined : this.descriptorOf(s)
    },
    end: async (_baseUrl, sessionId) => {
      const s = this.sessions.get(sessionId)
      if (s === undefined) return
      this.endedSessions.push(sessionId)
      this.sessions.delete(sessionId)
      for (const conn of [...s.connections]) conn.emit({ kind: 'session-closed' })
    },
    connect: ({ sessionId, actorId }) => {
      const s = this.sessions.get(sessionId)
      if (s === undefined) throw new Error(`connect: unknown session ${sessionId}`)
      return new FakeConn(this, s, actorId)
    },
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const makeApp = (server: FakeCollabServer, withBackend = true): AppState => {
  const app = new AppState({ collabTransport: server.transport })
  if (withBackend) app.addBackend('http://collab', 'collab', false, 'dinkster')
  return app
}

const activeTab = (app: AppState): Tab => {
  const tab = app.activeTab()
  if (!tab) throw new Error('no active tab')
  return tab
}

const sharedSession = (app: AppState, tabId: string): SharedDocumentSession => {
  const entry = app.collabFor(tabId)
  if (!entry) throw new Error(`tab ${tabId} is not shared`)
  return entry.session
}

const nodeCount = (tab: Tab): number => Object.keys(tab.store.doc.graphs[tab.store.doc.root]!.nodes).length

const addNode = (tab: Tab) =>
  tab.store.dispatch({ command: 'node.add', params: { graphId: tab.store.doc.root, type: 'X', position: { x: 0, y: 0 } } })

const planSeedFlatten = (app: AppState, tab: Tab) => flattenInvocation(
  tab.store.doc,
  'g0',
  [],
  'n0',
  { id: 'n0', kind: 'node', x: 80, y: 120, width: 180, height: 100 },
  [{ id: 'n0', kind: 'node', x: 100, y: 100, width: 180, height: 100 }],
  app.backends.get()[0]!.registry.get()!.resolve,
)

const seedFlattenSchemas: readonly NodeSchema[] = [
  {
    type: 'EmptyImage', displayName: 'Empty Image', category: 'test', source: 'v3', isOutputNode: false,
    items: [
      { kind: 'input', id: 'color', type: { kind: 'concrete', name: 'INT' }, optional: true },
      { kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' }, isList: false },
    ],
  },
  {
    type: 'PreviewImage', displayName: 'Preview Image', category: 'test', source: 'v3', isOutputNode: true,
    items: [{ kind: 'input', id: 'images', type: { kind: 'concrete', name: 'IMAGE' }, optional: false }],
  },
]

const installSeedFlattenRegistry = (app: AppState): void => {
  const backend = app.backends.get()[0]!
  const schemas = new Map(seedFlattenSchemas.map((schema) => [schema.type, schema]))
  backend.registry.set({
    connection: backend.id,
    hash: 't19-seed-flatten',
    schemas,
    diagnostics: [],
    resolve: (type) => schemas.get(type),
  })
}

const sharedCountSchema: NodeSchema = {
  type: 'CountedOutput',
  displayName: 'Counted output',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items: [
    {
      kind: 'input',
      id: 'count',
      type: { kind: 'concrete', name: 'core.int' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 3 },
    },
    {
      kind: 'output',
      id: 'results',
      type: { kind: 'concrete', name: 'core.int' },
      dynamic: {
        kind: 'autogrow',
        template: [{
          kind: 'input',
          id: 'result',
          type: { kind: 'concrete', name: 'core.int' },
          optional: false,
        }],
        naming: { kind: 'prefix', prefix: '', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    },
  ],
}

const sharedCountDocument = (): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'shared-count-edit' as never,
  root: 'g0' as never,
  graphs: {
    g0: {
      id: 'g0' as never,
      name: 'root',
      nextOrdinal: 1,
      nodes: {
        left: { id: 'left' as never, type: '#sub', values: {} },
        right: { id: 'right' as never, type: '#sub', values: {} },
      },
      links: {},
      nets: {},
      reroutes: {},
    },
    sub: {
      id: 'sub' as never,
      name: 'sub',
      nextOrdinal: 1,
      nodes: {
        split: { id: 'split' as never, type: sharedCountSchema.type, values: { count: 3 } },
      },
      links: {},
      nets: {},
      reroutes: {},
      boundary: {
        inputs: [{ id: 'amount', binds: { kind: 'port', node: 'split' as never, port: 'count' as never }, promoted: true }],
        outputs: [{ id: 'results', binds: { kind: 'family', node: 'split' as never, port: 'results' as never } }],
      },
    },
  },
  view: { graphs: {} },
})

const installSharedCountRegistry = (app: AppState) => {
  const backend = app.backends.get().find((candidate) => candidate.protocol === 'dinkster')
  if (backend === undefined) throw new Error('native backend setup failed')
  const schemas = new Map([[sharedCountSchema.type, sharedCountSchema]])
  backend.registry.set({
    connection: backend.id,
    hash: 'shared-count-edit',
    schemas,
    diagnostics: [],
    resolve: (type) => schemas.get(type),
  })
  return backend
}

// ---------------------------------------------------------------------------

describe('stableActorId', () => {
  it('recovers a squatted identity with exactly one fresh binding attempt', async () => {
    const fetchFn = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'actor-principal-mismatch' }), { status: 409 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const id = await bindBrowserActor('http://fixture', 'session', 'squatted', fetchFn)
    expect(id).not.toBe('squatted')
    expect(isValidActorId(id)).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchFn.mock.calls[1]![1]!.body as string)).toEqual({ actorId: id })
    const refused = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ error: 'actor-principal-mismatch' }), { status: 409 }))
    await expect(bindBrowserActor('http://fixture', 'session', 'squatted', refused)).rejects.toThrow('actor-principal-mismatch')
    expect(refused).toHaveBeenCalledTimes(2)
  })

  const memStorage = (initial?: string) => {
    const map = new Map<string, string>()
    if (initial !== undefined) map.set(COLLAB_ACTOR_ID_KEY, initial)
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      map,
    }
  }

  it('mints a pin-valid id and persists it', () => {
    const storage = memStorage()
    const id = stableActorId(storage)
    expect(isValidActorId(id)).toBe(true)
    expect(storage.map.get(COLLAB_ACTOR_ID_KEY)).toBe(id)
    expect(stableActorId(storage)).toBe(id) // stable across loads
  })

  it('replaces a stored id that violates the joint pin', () => {
    for (const bad of ['has.dot', 'has space', '', '__proto__']) {
      const storage = memStorage(bad)
      const id = stableActorId(storage)
      expect(id).not.toBe(bad)
      expect(isValidActorId(id)).toBe(true)
      expect(storage.map.get(COLLAB_ACTOR_ID_KEY)).toBe(id)
    }
  })

  it('keeps a stored pin-valid id verbatim', () => {
    const storage = memStorage('keep_me-123')
    expect(stableActorId(storage)).toBe('keep_me-123')
  })

  it('survives unusable storage with a session-only id', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    expect(isValidActorId(stableActorId(throwing))).toBe(true)
    expect(isValidActorId(stableActorId(undefined))).toBe(true)
  })
})

describe('share', () => {
  it('dispatches through the exact adapter selected from the per-session registry', async () => {
    const app = makeApp(new FakeCollabServer())
    const lookup = vi.spyOn(DocumentTypeRegistry.prototype, 'get')
    try {
      expect(await app.shareActiveTab()).toBeUndefined()
      const selected: DocumentTypeAdapter<unknown> | undefined = lookup.mock.results.at(-1)?.value
      expect(selected?.kind).toBe('dinkster.workflow')
      const execute = vi.spyOn(selected!, 'execute')
      try {
        expect(addNode(activeTab(app)).ok).toBe(true)
        await sharedSession(app, activeTab(app).id).settle()
        expect(execute).toHaveBeenCalled()
      } finally {
        execute.mockRestore()
      }
    } finally {
      lookup.mockRestore()
      app.dispose()
    }
  })

  it('T19 installs current-document schema authority for both AppState local and adopted shared tabs', async () => {
    const server = new FakeCollabServer()
    const run = async (shared: boolean): Promise<void> => {
      const app = makeApp(server)
      installSeedFlattenRegistry(app)
      expect(app.openDocument(structuredClone(seedSubgraph), shared ? 'Shared flatten' : 'Local flatten')).toEqual([])
      if (shared) expect(await app.shareActiveTab()).toBeUndefined()
      const tab = activeTab(app)
      const invocation = planSeedFlatten(app, tab)
      expect(invocation).toBeDefined()

      const outcome = tab.store.dispatch(invocation!)

      expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
      expect(Object.values(tab.store.doc.graphs.g0!.nodes).some((node) => node.type === 'EmptyImage')).toBe(true)
      expect(Object.values(tab.store.doc.graphs.g0!.nodes).some((node) => node.type === '#g1')).toBe(false)
      if (shared) await sharedSession(app, tab.id).settle()
    }

    await run(false)
    await run(true)
  })

  it('commits a shared palette link-drop batch against the predicted node id and selects it', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const tab = activeTab(app)
    const graphId = tab.store.doc.root
    const predicted = tab.store.predictedNodeId(graphId)
    expect(predicted).toBe(`n0-${app.collabActorId}`)

    const outcome = tab.store.dispatch({
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'node.add',
            params: { graphId, type: 'PreviewImage', position: { x: 10, y: 20 }, values: {} },
          },
          {
            command: 'link.connect',
            params: {
              graphId,
              from: { node: 'n0', port: 'out0' },
              to: { node: predicted, port: 'images' },
            },
          },
        ],
      } as Json,
    })
    let selection: readonly string[] = []
    if (outcome.ok) selection = [predicted!]

    expect(outcome.ok).toBe(true)
    expect(tab.store.doc.graphs[graphId]!.nodes[predicted!]).toBeDefined()
    expect(selection).toEqual([predicted])
  })

  it('publishes the active tab and swaps it onto a shared session in place', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    const before = activeTab(app)
    const doc = before.store.doc

    expect(await app.shareActiveTab()).toBeUndefined()

    const tab = activeTab(app)
    expect(tab.id).toBe(before.id) // same lineage, replaced in place
    expect(tab.store).not.toBe(before.store)
    expect(tab.store.doc).toEqual(doc) // snapshot round-trip is lossless
    expect(app.collabFor(tab.id)).toBeDefined()
    expect(server.createCalls).toEqual([
      { baseUrl: 'http://collab', scope: COLLAB_SCOPE, documentId: doc.lineage },
    ])
  })

  it('keeps local undo history when sharing the same document', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    const joiner = makeApp(server)
    const local = activeTab(app)
    const baseline = nodeCount(local)
    expect(addNode(local).diagnostics).toEqual([])
    expect(local.store.canUndo).toBe(true)

    expect(await app.shareActiveTab()).toBeUndefined()

    const shared = activeTab(app)
    expect(shared.store.canUndo).toBe(true)
    const descriptor = app.collabFor(shared.id)!.descriptor
    expect(await joiner.joinCollabSession(descriptor.sessionId)).toBeUndefined()
    const joined = activeTab(joiner)
    expect(joined.store.canUndo).toBe(false)

    expect(shared.store.undo()).toBe(true)
    await sharedSession(app, shared.id).settle()
    await until(() => nodeCount(joined) === baseline, 'shared undo reaching joiner')
    expect(nodeCount(shared)).toBe(baseline)
  })

  it('refuses without a dinkster backend and leaves the tab untouched', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server, false)
    const before = activeTab(app)
    const err = await app.shareActiveTab()
    expect(err).toMatch(/no Dinkster backend/)
    expect(activeTab(app).store).toBe(before.store)
    expect(app.collabFor(before.id)).toBeUndefined()
  })

  it('refuses to share an already-shared tab', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    expect(await app.shareActiveTab()).toMatch(/already in a shared session/)
    expect(server.createCalls).toHaveLength(1)
  })

  it('stamps ops with this browser actor identity', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const tab = activeTab(app)
    expect(addNode(tab).diagnostics).toEqual([])
    await sharedSession(app, tab.id).settle()
    const session = [...server.sessions.values()][0]!
    expect(session.log).toHaveLength(1)
    expect(session.log[0]!.actorId).toBe(app.collabActorId)
    expect(isValidActorId(app.collabActorId)).toBe(true)
  })
})

describe('join and convergence', () => {
  it('two apps discover the same session and converge in both directions', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(appA.collabActorId).not.toBe(appB.collabActorId)

    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)

    const listed = await appB.listCollabSessions()
    expect(listed).toHaveLength(1)
    expect(await appB.joinCollabSession(listed[0]!.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    expect(tabB.store.doc.lineage).toBe(tabA.store.doc.lineage)
    await until(() => nodeCount(tabB) === nodeCount(tabA), 'join catch-up')

    // A -> B
    const baseline = nodeCount(tabA)
    expect(addNode(tabA).diagnostics).toEqual([])
    await sharedSession(appA, tabA.id).settle()
    await until(() => nodeCount(tabB) === baseline + 1, 'A edit reaching B')

    // B -> A
    expect(addNode(tabB).diagnostics).toEqual([])
    await sharedSession(appB, tabB.id).settle()
    await until(() => nodeCount(tabA) === baseline + 2, 'B edit reaching A')
    expect(tabA.store.doc).toEqual(tabB.store.doc)
  })

  it('joining a session this app is already in focuses the existing tab', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const shared = activeTab(app)
    const sessionId = app.collabFor(shared.id)!.descriptor.sessionId
    app.createWorkflow() // focus elsewhere
    expect(app.activeTab()!.id).not.toBe(shared.id)
    expect(await app.joinCollabSession(sessionId)).toBeUndefined()
    expect(app.activeTab()!.id).toBe(shared.id)
    expect(app.collabTabs.get().size).toBe(1) // no second membership
  })

  it('joining a gone session reports it instead of throwing', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.joinCollabSession('sess-nope')).toMatch(/no longer exists/)
  })

  it('keeps an unknown document kind read-only and reports a Problem', async () => {
    const server = new FakeCollabServer()
    const source = server.createSession(COLLAB_SCOPE, 'notes', { text: 'An extension document' })
    const descriptor = server.descriptorOf(source)
    vi.spyOn(server, 'descriptorOf').mockReturnValue({ ...descriptor, documentKind: 'example.notes' })
    const app = makeApp(server)
    const tab = activeTab(app)
    const report = vi.spyOn(app, 'reportProblems')
    expect(await app.listCollabSessions()).toHaveLength(1)
    expect(await app.joinCollabSession(source.sessionId)).toContain('No document adapter')
    expect(app.activeTab()).toBe(tab)
    expect(app.collabTabs.get().size).toBe(0)
    expect(app.readOnlyCollabDocument.get()?.document.get()).toEqual(source.snapshot)
    expect(source.connections.size).toBe(0)
    expect(source.log).toHaveLength(0)
    expect(report).toHaveBeenCalledWith(GLOBAL_PROBLEMS_OWNER, expect.arrayContaining([
      expect.objectContaining({ code: 'collab.documentKind.unsupported' }),
    ]))
  })

  it('opens a retained extension adapter in one engine without making a workflow tab', async () => {
    const server = new FakeCollabServer()
    const source = server.createSession(COLLAB_SCOPE, 'notes', { text: 'initial' })
    const descriptor = server.descriptorOf(source)
    vi.spyOn(server, 'descriptorOf').mockReturnValue({ ...descriptor, documentKind: 'example.notes' })
    const adapter: DocumentTypeAdapter<{ text: string }> = {
      kind: 'example.notes', commandIds: new Set(['note.rename']),
      load: (value) => ({ document: value as { text: string }, diagnostics: [] }),
      check: () => [],
      execute(document, invocation) {
        const forward = [{ op: 'replace' as const, path: ['text'], value: invocation.params, oldValue: document.text }]
        return { ok: true, doc: applyOps(document, forward) as { text: string }, forward, inverse: invertOps(forward), diagnostics: [] }
      },
    }
    const apps = [makeApp(server), makeApp(server)]
    for (const app of apps) {
      const tab = app.activeTab()
      app.collabDocumentTypes.register(adapter)
      expect(await app.joinCollabSession(source.sessionId)).toBeUndefined()
      expect(app.activeTab()).toBe(tab)
      expect(app.collabTabs.get().size).toBe(0)
      expect(app.readOnlyCollabDocument.get()?.document).toBe(app.readOnlyCollabDocument.get()?.session?.document)
    }
    const session = apps[0]!.readOnlyCollabDocument.get()!.session!
    expect(session.dispatch({ command: 'note.rename', params: 'shared edit' }).ok).toBe(true)
    await session.settle()
    expect(apps[1]!.readOnlyCollabDocument.get()?.document.get()).toEqual({ text: 'shared edit' })
    expect(await apps[0]!.joinCollabSession(source.sessionId)).toBeUndefined()
    expect(source.connections.size).toBe(2)
    apps[0]!.dismissCollabDocument()
    expect(session.status.get()).toBe('closed')
    expect(source.connections.size).toBe(1)
    apps[1]!.dispose()
    expect(source.connections.size).toBe(0)
  })
})

describe('leave, end, and disposal', () => {
  it('reports a passive authorization denial as a Problem without requiring an edit', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const tab = activeTab(app)
    const session = sharedSession(app, tab.id)
    await until(() => session.status.get() === 'live')
    const serverSession = [...server.sessions.values()][0]!
    const connection = [...serverSession.connections][0]!
    const diagnostic = {
      version: 1 as const, type: 'collab.denial' as const, code: 'capability-required',
      status: 403, message: 'HTTP 403: capability-required', operation: 'session',
      sessionId: connection.sessionId, actorId: connection.actorId,
    }
    Object.assign(connection, { denial: diagnostic })
    connection.emit({ kind: 'denial', diagnostic })
    expect(session.status.get()).toBe('error')
    expect(app.problems.get()).toContainEqual(expect.objectContaining({ code: 'collab.session', message: JSON.stringify(diagnostic) }))
    await expect(session.settle()).rejects.toMatchObject({ diagnostic })
    expect(serverSession.log).toHaveLength(0)
    app.leaveCollabSession(tab.id)
    expect(connection.closed).toBe(true)
  })

  it('leave keeps the current document as a local tab in place', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    expect(addNode(tabA).diagnostics).toEqual([])
    await sharedSession(appA, tabA.id).settle()
    const expected = nodeCount(tabA)
    await until(() => nodeCount(tabB) === expected, 'edit reaching B before leave')

    const serverSession = [...server.sessions.values()][0]!
    const connsBefore = serverSession.connections.size
    appB.leaveCollabSession(tabB.id)

    expect(appB.collabFor(tabB.id)).toBeUndefined()
    expect(serverSession.connections.size).toBe(connsBefore - 1) // transport closed
    const local = appB.tabs.get().find((t) => t.id === tabB.id)!
    expect(nodeCount(local)).toBe(expected) // document survives the downgrade
    expect(addNode(local).diagnostics).toEqual([]) // and stays editable locally
    // The server session (and A's membership) lives on.
    expect(server.sessions.size).toBe(1)
    expect(appA.collabFor(tabA.id)).toBeDefined()
  })

  it('end deletes the server session for everyone', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    const sessionId = appA.collabFor(tabA.id)!.descriptor.sessionId
    expect(await appB.joinCollabSession(sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    const sessionB = sharedSession(appB, tabB.id)

    expect(await appA.endCollabSession(tabA.id)).toBeUndefined()

    expect(server.endedSessions).toEqual([sessionId])
    expect(server.sessions.size).toBe(0)
    expect(appA.collabFor(tabA.id)).toBeUndefined() // A fell back local
    await until(() => sessionB.status.get() === 'closed', "B's session_closed")
  })

  it('closing a shared tab closes its transport connection', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const tab = activeTab(app)
    const serverSession = [...server.sessions.values()][0]!
    expect(serverSession.connections.size).toBe(1)
    app.closeTab(tab.id)
    expect(serverSession.connections.size).toBe(0)
    expect(app.collabFor(tab.id)).toBeUndefined()
    expect(server.sessions.size).toBe(1) // the server session outlives the tab
  })

  it('replacing a shared tab via openDocument disposes its session', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const tab = activeTab(app)
    const serverSession = [...server.sessions.values()][0]!
    expect(serverSession.connections.size).toBe(1)
    // Re-open the same document (same lineage) as a plain local tab.
    const diags = app.openDocument(JSON.parse(JSON.stringify(tab.store.doc)), tab.title)
    expect(diags).toEqual([])
    expect(serverSession.connections.size).toBe(0)
    expect(app.collabFor(tab.id)).toBeUndefined()
  })

  it('leaving establishes a fresh history baseline (documented decision)', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const tab = activeTab(app)
    expect(addNode(tab).diagnostics).toEqual([])
    await sharedSession(app, tab.id).settle()

    app.leaveCollabSession(tab.id)
    const local = app.tabs.get().find((t) => t.id === tab.id)!
    // Shared history interleaves other actors' ops; pre-leave undo does not
    // survive the downgrade (docs/collaboration.md).
    expect(local.store.canUndo).toBe(false)
    // But history works forward from the new baseline.
    const before = nodeCount(local)
    expect(addNode(local).diagnostics).toEqual([])
    expect(local.store.canUndo).toBe(true)
    expect(local.store.undo()).toBe(true)
    expect(nodeCount(local)).toBe(before)
  })
})

describe('presence lifecycle', () => {
  it('presence relays to the other membership and never echoes back', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)

    const chA = appA.collabFor(tabA.id)!.presence
    const chB = appB.collabFor(tabB.id)!.presence
    chA.setLocal({ graph: 'root', cursor: { x: 5, y: 6 }, selection: ['n1'] })
    await until(() => chB.remotes.get().size === 1, "A's presence reaching B")
    const seen = chB.remotes.get().get(appA.collabActorId)!
    expect(seen).toMatchObject({ graph: 'root', cursor: { x: 5, y: 6 }, selection: ['n1'] })
    // The fake relays to OTHERS only (backend semantics): A sees nobody.
    expect(chA.remotes.get().size).toBe(0)
  })

  it('leaving broadcasts departure so peers drop the actor immediately', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)

    const chA = appA.collabFor(tabA.id)!.presence
    appB.collabFor(tabB.id)!.presence.setLocal({ graph: 'root', cursor: undefined, selection: [] })
    await until(() => chA.remotes.get().size === 1, "B's presence reaching A")

    // Leave disposes B's channel BEFORE the connection closes, so the gone
    // frame rides the live socket instead of B lingering until A's TTL.
    appB.leaveCollabSession(tabB.id)
    await until(() => chA.remotes.get().size === 0, "B's departure reaching A")
    // And B's own channel is inert after the downgrade to a local tab.
    expect(appB.collabFor(tabB.id)).toBeUndefined()
  })

  it('a session ended REMOTELY disposes the peer channel (no timers against a dead membership)', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)

    const entryB = appB.collabFor(tabB.id)!
    appA.collabFor(tabA.id)!.presence.setLocal({ graph: 'root', cursor: { x: 1, y: 2 }, selection: [] })
    await until(() => entryB.presence.remotes.get().size === 1, "A's presence reaching B")

    // A ends the session: B's session closes via session_closed, never
    // passing through B's dropCollabFor - the status watcher must dispose
    // B's channel (forgetting remotes, detaching, stopping timers).
    expect(await appA.endCollabSession(tabA.id)).toBeUndefined()
    await until(() => entryB.session.status.get() === 'closed', "B's session_closed")
    expect(entryB.presence.remotes.get().size).toBe(0)
    // Disposed = inert: local updates broadcast nothing anymore.
    const sent: unknown[] = []
    const origSend = entryB.session.sendPresence.bind(entryB.session)
    entryB.session.sendPresence = (p: Json) => { sent.push(p); origSend(p) }
    entryB.presence.setLocal({ graph: 'root', cursor: { x: 9, y: 9 }, selection: [] })
    expect(sent).toEqual([])
  })

  it('a session ended REMOTELY falls back local as in leave (docs/collaboration.md pin)', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)

    // A ends for everyone: B's membership must downgrade WITHOUT an explicit
    // leave - the tab survives as an ordinary local tab over the same
    // document (found live 2026-07-27: only the channel was disposed).
    expect(await appA.endCollabSession(tabA.id)).toBeUndefined()
    await until(() => appB.collabFor(tabB.id) === undefined, "B's membership downgrade")
    const local = appB.tabs.get().find((t) => t.id === tabB.id)
    expect(local).toBeDefined()
    expect(local!.store.doc.lineage).toBe(tabB.store.doc.lineage)
    // The ender downgraded too, through the explicit path, exactly once.
    expect(appA.collabFor(tabA.id)).toBeUndefined()
    expect(appA.tabs.get().filter((t) => t.id === tabA.id)).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------

/** A manually-opened gate for holding a transport call in flight. */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void
  const promise = new Promise<void>((r) => (open = r))
  return { promise, open }
}

describe('lifecycle races', () => {
  it('rebases a promoted count edit over an unrelated shared operation', async () => {
    const server = new FakeCollabServer()
    const postGate = gate()
    let holdPosts = false
    let heldPosts = 0
    const appA = new AppState({
      collabTransport: {
        ...server.transport,
        connect: (config) => {
          const conn = server.transport.connect(config)
          return {
            sessionId: conn.sessionId,
            postOp: async (op: CollabClientOp) => {
              if (holdPosts) {
                heldPosts += 1
                await postGate.promise
              }
              return conn.postOp(op)
            },
            fetchSnapshot: () => conn.fetchSnapshot(),
            fetchOps: (after: number) => conn.fetchOps(after),
            putSnapshot: (revision: number, document: WorkflowDocument) => conn.putSnapshot(revision, document),
            sendPresence: (payload: Json) => conn.sendPresence(payload),
            close: () => conn.close(),
            onEvent: (listener: (event: CollabConnectionEvent) => void) => conn.onEvent(listener),
          }
        },
      },
    })
    appA.addBackend('http://collab', 'collab', false, 'dinkster')
    const backendA = installSharedCountRegistry(appA)
    expect(appA.openDocument(sharedCountDocument(), 'Shared count edit')).toEqual([])
    appA.setTabTarget(activeTab(appA).id, backendA.id)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)

    const appB = makeApp(server)
    const backendB = installSharedCountRegistry(appB)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    appB.setTabTarget(tabB.id, backendB.id)

    holdPosts = true
    expect(appA.dispatchTo(tabA, {
      command: 'node.setValue',
      params: { graphId: 'g0', nodeId: 'left', inputId: 'amount', value: 3 },
    }).ok).toBe(true)
    await until(() => heldPosts === 1, 'promoted count POST held')

    expect(appB.dispatchTo(tabB, {
      command: 'node.setTitle',
      params: { graphId: 'g0', nodeId: 'right', title: 'peer edit' },
    }).ok).toBe(true)
    await sharedSession(appB, tabB.id).settle()
    await until(() =>
      tabA.store.doc.graphs.g0!.nodes.right!.title === 'peer edit' &&
      tabA.store.doc.graphs.g0!.nodes.left!.values.amount === 3,
    'count intention replay')
    expect(appA.problems.get().filter((problem) => problem.code.startsWith('collab.conflict.'))).toEqual([])

    postGate.open()
    await sharedSession(appA, tabA.id).settle()
    await until(() => tabB.store.doc.graphs.g0!.nodes.left!.values.amount === 3, 'count convergence')
    expect(tabA.store.doc.graphs.g0!.nodes.left!.values).toEqual({ amount: 3 })
    expect(tabB.store.doc.graphs.g0!.nodes.left!.values).toEqual({ amount: 3 })
  })

  it('rechecks the wire-15 mode gate when a collab rebase changes content at the same revision', async () => {
    const server = new FakeCollabServer()
    let holdPosts = false
    const heldPost = new Promise<PostOpOutcome>(() => undefined)
    const appA = new AppState({
      collabTransport: {
        ...server.transport,
        connect: (config) => {
          const conn = server.transport.connect(config)
          return {
            sessionId: conn.sessionId,
            postOp: (op: CollabClientOp) => holdPosts ? heldPost : conn.postOp(op),
            fetchSnapshot: () => conn.fetchSnapshot(),
            fetchOps: (after: number) => conn.fetchOps(after),
            putSnapshot: (revision: number, document: WorkflowDocument) => conn.putSnapshot(revision, document),
            sendPresence: (payload: Json) => conn.sendPresence(payload),
            close: () => conn.close(),
            onEvent: (listener: (event: CollabConnectionEvent) => void) => conn.onEvent(listener),
          }
        },
      },
    })
    const backendA = appA.addBackend('http://collab', 'collab', false, 'dinkster')
    if (!backendA || backendA.protocol !== 'dinkster') throw new Error('native backend setup failed')
    backendA.registry.set(buildDinksterRegistry(asConnectionId(backendA.id), nodesPayload))
    const appB = makeApp(server)
    expect(appA.openDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'collab-queue-identity',
      root: 'g0',
      graphs: { g0: {
        id: 'g0', name: 'root',
        nodes: {
          n0: { id: 'n0', type: 'std.math.add_ints', values: { a: 3, b: 4 } },
          n1: { id: 'n1', type: 'std.math.add_ints', values: { b: 10 } },
        },
        links: { l2: { id: 'l2', from: { node: 'n0', port: 'sum' }, to: { node: 'n1', port: 'a' } } },
        nets: {}, reroutes: {}, nextOrdinal: 3,
      } },
      view: { graphs: { g0: { nodes: {} } } },
    }, 'collab queue identity')).toEqual([])
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    appA.setTabTarget(tabA.id, backendA.id)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    await until(() => nodeCount(tabB) === nodeCount(tabA), 'peer catch-up')

    // Establish one clean pending intention and hold its POST. The foreign
    // batch below confirms the same value plus bypass, so rebase dissolves
    // the pending value write: confirmed +1 and pending -1 preserve the
    // exposed numeric revision while publishing a different document object.
    holdPosts = true
    expect(tabA.store.dispatch({
      command: 'node.setValues',
      params: { graphId: 'g0', nodeId: 'n0', values: { a: 65 } },
    }).ok).toBe(true)
    const stableRevision = tabA.store.revision
    const clean = appA.compileTab(tabA)
    expect(clean?.ok, JSON.stringify(clean && !clean.ok ? clean.diagnostics : undefined)).toBe(true)
    if (!clean?.ok) return
    const gateDiagnostic = diag(
      'error',
      'compile',
      'compile.wire15.modesUnsupported',
      'wire-15 mode gate',
      { anchor: { occurrence: { instancePath: [], node: asNodeId('n0') } } },
    )
    const compileSpy = vi.spyOn(appA, 'compileTab').mockImplementation(() =>
      tabA.store.doc.graphs.g0!.nodes.n0!.mode === 'bypassed'
        ? { ok: false, diagnostics: [gateDiagnostic] }
        : clean)
    let resolveUpload!: (digest: string) => void
    const upload = new Promise<string>((resolve) => { resolveUpload = resolve })
    const uploadSpy = vi.spyOn(backendA.connection, 'uploadAsset').mockReturnValue(upload)
    const retryWithAssets = vi.fn()
    const submitSpy = vi.spyOn(backendA.connection, 'submit').mockResolvedValue({
      ok: false,
      diagnostics: [],
      assetsMissing: { error: 'assets-missing', assets: [] },
      retryWithAssets,
    })
    const queueing = appA.queue(tabA)
    await until(() => uploadSpy.mock.calls.length === 1, 'source upload')

    expect(tabB.store.dispatch({
      command: 'batch',
      params: { invocations: [
        { command: 'node.setValues', params: { graphId: 'g0', nodeId: 'n0', values: { a: 65 } } },
        { command: 'node.setMode', params: { graphId: 'g0', nodeIds: ['n0'], mode: 'bypassed' } },
      ] },
    }).ok).toBe(true)
    await sharedSession(appB, tabB.id).settle()
    await until(() => tabA.store.doc.graphs.g0!.nodes.n0!.mode === 'bypassed', 'foreign mode rebase')
    expect(tabA.store.revision).toBe(stableRevision)

    resolveUpload('blake3:' + 'a'.repeat(64))
    await queueing
    expect(compileSpy).toHaveBeenCalledTimes(2)
    expect(submitSpy).not.toHaveBeenCalled()
    expect(retryWithAssets).not.toHaveBeenCalled()
    expect(appA.problems.get().map((diagnostic) => diagnostic.code)).toEqual([
      'compile.wire15.modesUnsupported',
    ])
  })

  it('a share overtaken by a local edit aborts and ends the orphan session', async () => {
    const server = new FakeCollabServer()
    const createGate = gate()
    const app = new AppState({
      collabTransport: {
        ...server.transport,
        create: async (baseUrl, args) => {
          await createGate.promise
          return server.transport.create(baseUrl, args)
        },
      },
    })
    app.addBackend('http://collab', 'collab', false, 'dinkster')
    const tab = activeTab(app)
    const localStore = tab.store

    const pending = app.shareActiveTab()
    expect(addNode(tab).diagnostics).toEqual([]) // edit while create is in flight
    createGate.open()

    expect(await pending).toMatch(/changed while sharing/)
    expect(activeTab(app).store).toBe(localStore) // the local tab is untouched
    expect(app.collabFor(tab.id)).toBeUndefined()
    await until(() => server.endedSessions.length === 1, 'orphan session cleanup')
    expect(server.sessions.size).toBe(0)
  })

  it('a share overtaken by closing the tab aborts without resurrecting it', async () => {
    const server = new FakeCollabServer()
    const createGate = gate()
    const app = new AppState({
      collabTransport: {
        ...server.transport,
        create: async (baseUrl, args) => {
          await createGate.promise
          return server.transport.create(baseUrl, args)
        },
      },
    })
    app.addBackend('http://collab', 'collab', false, 'dinkster')
    const tab = activeTab(app)

    const pending = app.shareActiveTab()
    app.closeTab(tab.id)
    createGate.open()

    expect(await pending).toMatch(/closed while sharing/)
    expect(app.tabs.get().some((t) => t.id === tab.id)).toBe(false) // not resurrected
    expect(app.collabFor(tab.id)).toBeUndefined()
    await until(() => server.endedSessions.length === 1, 'orphan session cleanup')
    expect(server.sessions.size).toBe(0)
  })

  it('a duplicate concurrent share is refused (one server session)', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    const first = app.shareActiveTab()
    const second = app.shareActiveTab()
    expect(await second).toMatch(/already being shared/)
    expect(await first).toBeUndefined()
    expect(server.createCalls).toHaveLength(1)
    expect(server.sessions.size).toBe(1)
  })

  it('a duplicate concurrent join is refused (one membership, one connection)', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const appB = makeApp(server)
    expect(await appA.shareActiveTab()).toBeUndefined()
    const sessionId = appA.collabFor(activeTab(appA).id)!.descriptor.sessionId

    const first = appB.joinCollabSession(sessionId)
    const second = appB.joinCollabSession(sessionId)
    expect(await second).toMatch(/already in progress/)
    expect(await first).toBeUndefined()
    expect(appB.collabTabs.get().size).toBe(1)
    expect([...server.sessions.values()][0]!.connections.size).toBe(2) // A + B, once each
  })

  it('a stale end completion does not tear down a newer membership', async () => {
    const server = new FakeCollabServer()
    const endGate = gate()
    const app = new AppState({
      collabTransport: {
        ...server.transport,
        end: async (baseUrl, sessionId) => {
          await endGate.promise
          return server.transport.end(baseUrl, sessionId)
        },
      },
    })
    app.addBackend('http://collab', 'collab', false, 'dinkster')
    expect(await app.shareActiveTab()).toBeUndefined()
    const tabId = activeTab(app).id
    const doc = activeTab(app).store.doc
    // A second server session over the same document lineage.
    const other = await server.transport.create('http://collab', {
      scope: COLLAB_SCOPE,
      documentId: doc.lineage,
      snapshot: JSON.parse(JSON.stringify(doc)),
    })

    const pendingEnd = app.endCollabSession(tabId) // DELETE held in flight
    app.leaveCollabSession(tabId)
    expect(await app.joinCollabSession(other.sessionId)).toBeUndefined()
    endGate.open()
    expect(await pendingEnd).toBeUndefined()

    // The rejoined membership survives the stale completion.
    const entry = app.collabFor(tabId)
    expect(entry).toBeDefined()
    expect(entry!.descriptor.sessionId).toBe(other.sessionId)
    expect(entry!.session.status.get()).toBe('live')
  })

  it('simultaneous edits collide on the server and still converge', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    // B's WS delivery can be held so its next op is genuinely built on a
    // stale base (the fake's synchronous fan-out otherwise lets the client
    // rebase preemptively, and the server-side 409 path is never exercised).
    const hold = { held: false, buffer: [] as (() => void)[] }
    const appB = new AppState({
      collabTransport: {
        ...server.transport,
        connect: (config) => {
          const conn = server.transport.connect(config)
          return {
            sessionId: conn.sessionId,
            postOp: (op: CollabClientOp) => conn.postOp(op),
            fetchSnapshot: () => conn.fetchSnapshot(),
            fetchOps: (after: number) => conn.fetchOps(after),
            putSnapshot: (revision: number, document: WorkflowDocument) => conn.putSnapshot(revision, document),
            sendPresence: (payload: Json) => conn.sendPresence(payload),
            close: () => conn.close(),
            onEvent: (listener: (e: CollabConnectionEvent) => void) =>
              conn.onEvent((e) => {
                if (hold.held) hold.buffer.push(() => listener(e))
                else listener(e)
              }),
          }
        },
      },
    })
    appB.addBackend('http://collab', 'collab', false, 'dinkster')
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    await until(() => nodeCount(tabB) === nodeCount(tabA), 'join catch-up')
    const baseline = nodeCount(tabA)

    // A commits first; B edits without having seen it, so B's op reaches
    // the server on a stale base and must be refused and rebased
    // (server-ordered optimistic concurrency; the server never transforms).
    hold.held = true
    expect(addNode(tabA).diagnostics).toEqual([])
    await sharedSession(appA, tabA.id).settle()
    expect(addNode(tabB).diagnostics).toEqual([])
    await until(() => server.staleBases >= 1, "B's stale-base refusal")
    hold.held = false
    for (const deliver of hold.buffer.splice(0)) deliver()

    await sharedSession(appB, tabB.id).settle()
    await until(
      () => nodeCount(tabA) === baseline + 2 && nodeCount(tabB) === baseline + 2,
      'both edits on both sides',
    )
    expect(tabA.store.doc).toEqual(tabB.store.doc)
  })

  it('shares the complete App View layout and rebases concurrent layout edits', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const hold = { held: false, buffer: [] as (() => void)[] }
    const appB = new AppState({
      collabTransport: {
        ...server.transport,
        connect: (config) => {
          const conn = server.transport.connect(config)
          return {
            sessionId: conn.sessionId,
            postOp: (op: CollabClientOp) => conn.postOp(op),
            fetchSnapshot: () => conn.fetchSnapshot(),
            fetchOps: (after: number) => conn.fetchOps(after),
            putSnapshot: (revision: number, document: WorkflowDocument) => conn.putSnapshot(revision, document),
            sendPresence: (payload: Json) => conn.sendPresence(payload),
            close: () => conn.close(),
            onEvent: (listener: (e: CollabConnectionEvent) => void) => conn.onEvent((e) => {
              if (hold.held) hold.buffer.push(() => listener(e))
              else listener(e)
            }),
          }
        },
      },
    })
    appB.addBackend('http://collab', 'collab', false, 'dinkster')
    const local = activeTab(appA)
    const graphId = local.store.doc.root
    expect(local.store.dispatch({
      command: 'params.expose',
      params: { graphId, nodeId: 'n0', inputId: 'color', label: 'Color' },
    }).ok).toBe(true)
    expect(local.store.dispatch({
      command: 'previews.expose',
      params: { graphId, nodeId: 'n0', label: 'Result' },
    }).ok).toBe(true)
    const add = (item: Json) => local.store.dispatch({ command: 'app.layout.add', params: { item } })
    expect(add({
      id: 'instructions', kind: 'text', role: 'heading', text: 'Portrait instructions',
      x: 0, y: 0, w: 12, h: 2,
    }).ok).toBe(true)
    expect(add({
      id: 'color', kind: 'control', ref: { graphId, nodeId: 'n0', inputId: 'color' },
    }).ok).toBe(true)
    expect(add({
      id: 'controls', kind: 'group', title: 'Controls', children: [],
      x: 0, y: 2, w: 5, h: 3,
    }).ok).toBe(true)
    expect(local.store.dispatch({
      command: 'app.layout.move', params: { id: 'color', parentId: 'controls', index: 0 },
    }).ok).toBe(true)
    expect(add({
      id: 'preview', kind: 'preview', ref: { graphId, nodeId: 'n0' },
      x: 5, y: 2, w: 7, h: 4,
    }).ok).toBe(true)
    expect(local.store.dispatch({
      command: 'app.layout.moveMobile', params: { id: 'preview', index: 0 },
    }).ok).toBe(true)

    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    await until(
      () => JSON.stringify(tabB.store.doc.ext) === JSON.stringify(tabA.store.doc.ext),
      'joined App View data',
    )
    expect(tabB.store.doc.ext?.['dinkster.exposed']).toEqual(tabA.store.doc.ext?.['dinkster.exposed'])
    expect(tabB.store.doc.ext?.['dinkster.exposedPreviews']).toEqual(tabA.store.doc.ext?.['dinkster.exposedPreviews'])
    expect(tabB.store.doc.ext?.['dinkster.appLayout']).toEqual(tabA.store.doc.ext?.['dinkster.appLayout'])

    hold.held = true
    expect(tabA.store.dispatch({
      command: 'app.layout.setText', params: { id: 'instructions', text: 'Shared portrait instructions' },
    }).ok).toBe(true)
    await sharedSession(appA, tabA.id).settle()
    expect(tabB.store.dispatch({
      command: 'app.layout.setGroupTitle', params: { id: 'controls', title: 'Collaborative controls' },
    }).ok).toBe(true)
    await until(() => server.staleBases >= 1, "B's App View stale-base refusal")
    hold.held = false
    for (const deliver of hold.buffer.splice(0)) deliver()

    await sharedSession(appB, tabB.id).settle()
    await until(() => JSON.stringify(tabA.store.doc) === JSON.stringify(tabB.store.doc), 'App View convergence')
    const items = (tabA.store.doc.ext?.['dinkster.appLayout'] as {
      desktop: { items: Array<{ id: string; text?: string; title?: string }> }
    }).desktop.items
    expect(items.find((item) => item.id === 'instructions')?.text).toBe('Shared portrait instructions')
    expect(items.find((item) => item.id === 'controls')?.title).toBe('Collaborative controls')
    expect(tabA.store.doc).toEqual(tabB.store.doc)
  })

  it('drops a stale fixed-id create batch atomically and repairs the losing drill-in navigation', async () => {
    const server = new FakeCollabServer()
    const appA = makeApp(server)
    const hold = { held: false, buffer: [] as (() => void)[] }
    const appB = new AppState({
      collabTransport: {
        ...server.transport,
        connect: (config) => {
          const conn = server.transport.connect(config)
          return {
            sessionId: conn.sessionId,
            postOp: (op: CollabClientOp) => conn.postOp(op),
            fetchSnapshot: () => conn.fetchSnapshot(),
            fetchOps: (after: number) => conn.fetchOps(after),
            putSnapshot: (revision: number, document: WorkflowDocument) => conn.putSnapshot(revision, document),
            sendPresence: (payload: Json) => conn.sendPresence(payload),
            close: () => conn.close(),
            onEvent: (listener: (e: CollabConnectionEvent) => void) => conn.onEvent((e) => {
              if (hold.held) hold.buffer.push(() => listener(e))
              else listener(e)
            }),
          }
        },
      },
    })
    appB.addBackend('http://collab', 'collab', false, 'dinkster')
    expect(await appA.shareActiveTab()).toBeUndefined()
    const tabA = activeTab(appA)
    expect(await appB.joinCollabSession(appA.collabFor(tabA.id)!.descriptor.sessionId)).toBeUndefined()
    const tabB = activeTab(appB)
    await until(() => tabB.store.revision === tabA.store.revision, 'join catch-up')
    const root = tabA.store.doc.root
    const winnerNodeId = tabA.store.predictedNodeId(root)!
    const loserNodeId = tabB.store.predictedNodeId(root)!
    expect(winnerNodeId).not.toBe(loserNodeId)

    hold.held = true
    expect(appA.createEmptySubgraph(tabA, root, { x: 10, y: 20 }).ok).toBe(true)
    const fixedGraphId = tabA.graphStack.get().at(-1)!
    await sharedSession(appA, tabA.id).settle()
    expect(appB.createEmptySubgraph(tabB, root, { x: 30, y: 40 }).ok).toBe(true)
    expect(tabB.graphStack.get()).toEqual([root, fixedGraphId])
    await until(() => server.staleBases >= 1, "B's stale create refusal")
    hold.held = false
    for (const deliver of hold.buffer.splice(0)) deliver()
    await sharedSession(appB, tabB.id).settle()
    await until(() => tabA.store.doc === tabB.store.doc || JSON.stringify(tabA.store.doc) === JSON.stringify(tabB.store.doc), 'create convergence')

    expect(tabB.store.doc.graphs[root]!.nodes[winnerNodeId]?.type).toBe(`#${fixedGraphId}`)
    expect(tabB.store.doc.graphs[root]!.nodes[loserNodeId]).toBeUndefined()
    expect(tabB.store.doc.graphs[fixedGraphId]).toEqual(tabA.store.doc.graphs[fixedGraphId])
    expect(tabB.store.doc.view.graphs[fixedGraphId]).toEqual({ nodes: {} })
    expect(tabB.graphStack.get()).toEqual([root])
    expect(tabB.instancePath.get()).toEqual([])
    expect(appB.problems.get()).toContainEqual(expect.objectContaining({
      code: 'collab.conflict.rebase',
      message: expect.stringContaining('already exists'),
    }))
  })
})

// ---------------------------------------------------------------------------
// Reload rejoin (docs/collaboration.md "Reload rejoin"): memberships persist
// to localStorage and a fresh AppState re-adopts the live ones at startup.
// ---------------------------------------------------------------------------

const COLLAB_SESSIONS_KEY = 'dinkster.collabSessions'

/** Minimal in-memory localStorage (tab-persistence.test.ts pattern). */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size
    },
  } as Storage
}

describe('reload rejoin', () => {
  const g = globalThis as { localStorage?: Storage }

  beforeEach(() => {
    g.localStorage = fakeStorage()
  })

  afterEach(() => {
    delete g.localStorage
  })

  const storedSessions = (): unknown[] =>
    (JSON.parse(g.localStorage!.getItem(COLLAB_SESSIONS_KEY) ?? '{"sessions":[]}') as { sessions: unknown[] }).sessions

  it('sharing persists the membership; a fresh app rejoins it and converges', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)
    const sessionId = app1.collabFor(tab1.id)!.descriptor.sessionId
    expect(storedSessions()).toEqual([
      { sessionId, baseUrl: 'http://collab', documentId: tab1.id, title: tab1.title },
    ])

    // The "reloaded" browser: a fresh AppState over the same storage.
    const app2 = makeApp(server)
    const activeBefore = activeTab(app2).id
    await app2.rejoinCollabSessions()
    const tab2 = app2.tabs.get().find((t) => app2.collabFor(t.id) !== undefined)
    expect(tab2).toBeDefined()
    expect(app2.collabFor(tab2!.id)!.descriptor.sessionId).toBe(sessionId)
    expect(activeTab(app2).id).toBe(activeBefore) // rejoin never steals focus

    // Genuine membership: an edit in the original app lands in the rejoined tab.
    const baseline = nodeCount(tab2!)
    expect(addNode(tab1).diagnostics).toEqual([])
    await sharedSession(app1, tab1.id).settle()
    await until(() => nodeCount(app2.tabs.get().find((t) => t.id === tab2!.id)!) === baseline + 1, 'rejoined convergence')
  })

  it('a session that ended while we were away cleans its record silently', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const sessionId = app1.collabFor(activeTab(app1).id)!.descriptor.sessionId
    await server.transport.end('http://collab', sessionId)

    const app2 = makeApp(server)
    await app2.rejoinCollabSessions()
    expect(app2.tabs.get().every((t) => app2.collabFor(t.id) === undefined)).toBe(true)
    expect(storedSessions()).toEqual([])
  })

  it('a session that ends DURING the rejoin join drops the record and leaks nothing', async () => {
    // The probe succeeds, but a session_closed buffered by the transport
    // replays synchronously at subscription (the real connection's
    // pre-first-subscriber buffer) - the session is dead before adoption.
    // Definite outcome: the record must die, not persist as transient.
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()

    const connections: FakeConn[] = []
    const app2 = new AppState({
      collabTransport: {
        ...server.transport,
        connect: (args) => {
          const conn = server.transport.connect(args) as FakeConn
          connections.push(conn)
          return {
            sessionId: conn.sessionId,
            postOp: conn.postOp.bind(conn),
            fetchSnapshot: conn.fetchSnapshot.bind(conn),
            fetchOps: conn.fetchOps.bind(conn),
            putSnapshot: conn.putSnapshot.bind(conn),
            sendPresence: conn.sendPresence.bind(conn),
            close: conn.close.bind(conn),
            onEvent: (listener) => {
              const off = conn.onEvent(listener)
              listener({ kind: 'session-closed' })
              return off
            },
          }
        },
      },
    })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    await app2.rejoinCollabSessions()
    expect(app2.tabs.get().every((t) => app2.collabFor(t.id) === undefined)).toBe(true)
    expect(storedSessions()).toEqual([]) // definite, not transient: record dies
    expect(connections).toHaveLength(1)
    expect(connections[0]!.closed).toBe(true) // no leaked transport
  })

  it('a transient probe failure keeps the record for the next reload', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const sessionId = app1.collabFor(activeTab(app1).id)!.descriptor.sessionId

    const app2 = new AppState({
      collabTransport: { ...server.transport, get: () => Promise.reject(new Error('backend unreachable')) },
    })
    await app2.rejoinCollabSessions()
    expect(app2.tabs.get().every((t) => app2.collabFor(t.id) === undefined)).toBe(true)
    expect(storedSessions()).toMatchObject([{ sessionId }])
  })

  it('leaving a session removes its persisted record', async () => {
    const server = new FakeCollabServer()
    const app = makeApp(server)
    expect(await app.shareActiveTab()).toBeUndefined()
    const tab = activeTab(app)
    expect(storedSessions()).toHaveLength(1)
    app.leaveCollabSession(tab.id)
    expect(storedSessions()).toEqual([])
  })

  /**
   * server.transport with get() held until release() or failed with fail()
   * (in-flight race tests).
   */
  const gatedTransport = (server: FakeCollabServer) => {
    let release!: () => void
    let fail!: (e: Error) => void
    const gate = new Promise<void>((res, rej) => {
      release = res
      fail = rej
    })
    return {
      transport: {
        ...server.transport,
        get: async (baseUrl: string, sessionId: string) => {
          await gate
          return server.transport.get(baseUrl, sessionId)
        },
      },
      release,
      fail,
    }
  }

  it('closing the restored tab while the rejoin is in flight never resurrects it', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)
    const sessionId = app1.collabFor(tab1.id)!.descriptor.sessionId

    const gated = gatedTransport(server)
    const app2 = new AppState({ collabTransport: gated.transport })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    const rejoin = app2.rejoinCollabSessions()
    app2.closeTab(tab1.id) // user closes the restored tab while the probe hangs
    gated.release()
    await rejoin

    expect(app2.tabs.get().some((t) => t.id === tab1.id)).toBe(false) // not resurrected
    expect(app2.collabFor(tab1.id)).toBeUndefined()
    expect(storedSessions()).toEqual([]) // definite outcome: the record died
    expect(server.sessions.get(sessionId)!.connections.size).toBe(1) // only app1's; no leak
  })

  it('replacing the restored tab while the rejoin is in flight leaves the replacement untouched', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)
    const sessionId = app1.collabFor(tab1.id)!.descriptor.sessionId

    const gated = gatedTransport(server)
    const app2 = new AppState({ collabTransport: gated.transport })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    const rejoin = app2.rejoinCollabSessions()
    // Replace the restored tab in place (same lineage) with a fresh open of
    // the same seed document it was restored from.
    expect(app2.openDocument(structuredClone(seedBasic), 'Replaced')).toEqual([])
    const replacement = app2.tabs.get().find((t) => t.id === tab1.id)!
    gated.release()
    await rejoin

    expect(app2.tabs.get().find((t) => t.id === tab1.id)).toBe(replacement) // untouched
    expect(app2.collabFor(tab1.id)).toBeUndefined()
    expect(storedSessions()).toEqual([])
    expect(server.sessions.get(sessionId)!.connections.size).toBe(1)
  })

  it('a close during a rejoin that then FAILS still kills the record (no later resurrection)', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)

    const gated = gatedTransport(server)
    const app2 = new AppState({ collabTransport: gated.transport })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    const rejoin = app2.rejoinCollabSessions()
    app2.closeTab(tab1.id) // closed while the probe hangs...
    gated.fail(new Error('backend died')) // ... and the probe then fails
    await rejoin
    // A transient failure normally retains the record - but the user closed
    // the tab during the flight, which is definite regardless of the error.
    expect(storedSessions()).toEqual([])
  })

  it('a replace during a rejoin that then FAILS still kills the record', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)

    const gated = gatedTransport(server)
    const app2 = new AppState({ collabTransport: gated.transport })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    const rejoin = app2.rejoinCollabSessions()
    expect(app2.openDocument(structuredClone(seedBasic), 'Replaced')).toEqual([]) // same lineage
    gated.fail(new Error('backend died'))
    await rejoin
    expect(storedSessions()).toEqual([])
    expect(app2.collabFor(tab1.id)).toBeUndefined()
  })

  it('an unresolved in-flight membership survives persists that run mid-rejoin', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)
    const sessionId = app1.collabFor(tab1.id)!.descriptor.sessionId

    const gated = gatedTransport(server)
    const app2 = new AppState({ collabTransport: gated.transport })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    const rejoin = app2.rejoinCollabSessions()
    // A second rejoin while the first is in flight single-flights per
    // membership and then persists - which must still WRITE the unresolved
    // record (it has no live entry yet; dropping it here would lose the
    // membership to a crash or reload before the flight settles).
    await app2.rejoinCollabSessions()
    expect(storedSessions()).toMatchObject([{ sessionId, baseUrl: 'http://collab' }])
    gated.release()
    await rejoin
    expect(app2.collabFor(tab1.id)).toBeDefined()
    expect(storedSessions()).toHaveLength(1)
  })

  it('an editor-kind switch during the rejoin does not cancel it and survives adoption', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)

    const gated = gatedTransport(server)
    const app2 = new AppState({ collabTransport: gated.transport })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    const rejoin = app2.rejoinCollabSessions()
    // Switching the projection replaces the Tab OBJECT but keeps the store;
    // the rejoin ownership token is the store, so adoption must proceed.
    app2.setTabEditorKind(tab1.id, APP_EDITOR_KIND)
    gated.release()
    await rejoin
    expect(app2.collabFor(tab1.id)).toBeDefined()
    expect(app2.tabs.get().find((t) => t.id === tab1.id)!.editorKind).toBe(APP_EDITOR_KIND)
  })

  it('explicitly closing the tab kills a transiently-failed pending record', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)

    const app2 = new AppState({
      collabTransport: { ...server.transport, get: () => Promise.reject(new Error('backend unreachable')) },
    })
    await app2.rejoinCollabSessions()
    expect(storedSessions()).toHaveLength(1) // pending: would retry next reload
    app2.closeTab(tab1.id)
    expect(storedSessions()).toEqual([]) // ... unless the user closed the tab

    const app3 = makeApp(server)
    await app3.rejoinCollabSessions()
    expect(app3.tabs.get().every((t) => app3.collabFor(t.id) === undefined)).toBe(true)
  })

  it('a membership whose tab was not restored is dropped, never adopted into a new tab', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)
    const sessionId = app1.collabFor(tab1.id)!.descriptor.sessionId

    const app2 = makeApp(server)
    app2.closeTab(tab1.id) // its tab is gone before the startup rejoin runs
    const before = app2.tabs.get().length
    await app2.rejoinCollabSessions()
    expect(app2.tabs.get()).toHaveLength(before) // no appended tab
    expect(app2.tabs.get().every((t) => app2.collabFor(t.id) === undefined)).toBe(true)
    expect(storedSessions()).toEqual([])
    expect(server.sessions.get(sessionId)!.connections.size).toBe(1) // never connected
  })

  it('the same session id on two backends is two distinct memberships', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)
    const sessionId = app1.collabFor(tab1.id)!.descriptor.sessionId
    // A second persisted membership: the SAME session id living on another
    // backend, joined by a DIFFERENT tab (ids are per-server; collisions
    // across servers are legal).
    const otherTab = app1.tabs.get().find((t) => t.id !== tab1.id)!
    const stored = JSON.parse(g.localStorage!.getItem(COLLAB_SESSIONS_KEY)!) as { v: 1; sessions: unknown[] }
    stored.sessions.push({ sessionId, baseUrl: 'http://other', documentId: otherTab.id, title: 'Elsewhere' })
    g.localStorage!.setItem(COLLAB_SESSIONS_KEY, JSON.stringify(stored))

    const app2 = new AppState({
      collabTransport: {
        ...server.transport,
        get: (baseUrl: string, id: string) =>
          baseUrl === 'http://other' ? Promise.reject(new Error('unreachable')) : server.transport.get(baseUrl, id),
      },
    })
    app2.addBackend('http://collab', 'collab', false, 'dinkster')
    await app2.rejoinCollabSessions()
    // The live rejoin on http://collab must not swallow the still-pending
    // record for http://other: identity is (baseUrl, sessionId).
    expect(storedSessions()).toMatchObject([
      { sessionId, baseUrl: 'http://collab' },
      { sessionId, baseUrl: 'http://other' },
    ])
    expect(app2.collabFor(tab1.id)).toBeDefined()
  })

  it('repeated rejoin calls neither duplicate memberships nor leak connections', async () => {
    const server = new FakeCollabServer()
    const app1 = makeApp(server)
    expect(await app1.shareActiveTab()).toBeUndefined()
    const tab1 = activeTab(app1)
    const sessionId = app1.collabFor(tab1.id)!.descriptor.sessionId

    const app2 = makeApp(server)
    await Promise.all([app2.rejoinCollabSessions(), app2.rejoinCollabSessions()]) // concurrent
    await app2.rejoinCollabSessions() // and again after settling
    expect([...app2.tabs.get().filter((t) => app2.collabFor(t.id) !== undefined)]).toHaveLength(1)
    expect(storedSessions()).toHaveLength(1)
    expect(server.sessions.get(sessionId)!.connections.size).toBe(2) // app1 + app2, nothing extra
  })

  it('malformed or wrong-version storage is ignored without blocking startup', async () => {
    const server = new FakeCollabServer()
    g.localStorage!.setItem(COLLAB_SESSIONS_KEY, 'not json')
    const app1 = makeApp(server)
    await expect(app1.rejoinCollabSessions()).resolves.toBeUndefined()
    g.localStorage!.setItem(COLLAB_SESSIONS_KEY, JSON.stringify({ v: 99, sessions: [{ sessionId: 'x', baseUrl: '', title: '' }] }))
    const app2 = makeApp(server)
    await app2.rejoinCollabSessions()
    expect(app2.tabs.get().every((t) => app2.collabFor(t.id) === undefined)).toBe(true)
  })
})
