import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COLLAB_PROTOCOL_VERSION,
  DocumentTypeRegistry,
  LocalDocumentTypeSession,
  SharedDocumentSession,
  applyOps,
  asGraphDefId,
  asImageLayerId,
  asImageLineageId,
  asLineageId,
  asNodeId,
  connectDocumentSession,
  connectSharedSession,
  coreCommandRegistry,
  createDocumentTypeRegistry,
  createVideoDocument,
  imageDocumentTypeAdapter,
  invertOps,
  legacyCollabDocumentKind,
  normalizeCollabDocumentKind,
  videoDocumentTypeAdapter,
  type CollabClientOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
  type CommandInvocation,
  type Diagnostic,
  type DocumentTypeAdapter,
  type FetchOpsOutcome,
  type ImageDocument,
  type Json,
  type PatchOp,
  type PostOpOutcome,
  type SessionConflict,
  type WorkflowDocument,
} from '../src/index.js'
import { validateCollabDescriptor } from '../src/commands/collab-protocol.js'
import { ownJson } from '../src/format/json.js'

type Note = {
  readonly title: string
  readonly count: number
  readonly editable: boolean
}
const note: Note = { title: 'initial', count: 0, editable: true }
const problem = (message: string): readonly Diagnostic[] => [
  {
    severity: 'error',
    origin: 'command',
    code: 'note.invalid',
    message,
  },
]

const noteAdapter: DocumentTypeAdapter<Note> = {
  kind: 'example.note',
  commandIds: new Set(['note.title', 'note.increment']),
  load(value) {
    const owned = ownJson(value)
    if (!owned.ok) return { diagnostics: problem(owned.reason) }
    const document = owned.value as Note
    const diagnostics = this.check(document)
    return diagnostics.length ? { diagnostics } : { document, diagnostics }
  },
  check(document) {
    return document !== null &&
      typeof document.title === 'string' &&
      Number.isSafeInteger(document.count) &&
      document.count >= 0 &&
      typeof document.editable === 'boolean'
      ? []
      : problem('invalid note')
  },
  execute(document, invocation) {
    if (!document.editable)
      return {
        ok: false,
        diagnostics: problem('note was locked by another actor'),
      }
    const forward: PatchOp[] =
      invocation.command === 'note.increment'
        ? [
            {
              op: 'replace',
              path: ['count'],
              value: document.count + 1,
              oldValue: document.count,
            },
          ]
        : [
            {
              op: 'replace',
              path: ['title'],
              value: invocation.params,
              oldValue: document.title,
            },
          ]
    return {
      ok: true,
      doc: applyOps(document, forward) as Note,
      forward,
      inverse: invertOps(forward),
      diagnostics: [],
    }
  },
}

class Connection implements CollabConnection {
  readonly sessionId = 'test-session'
  readonly posts: CollabClientOp[] = []
  readonly snapshots: { revision: number; document: unknown }[] = []
  readonly presence: Json[] = []
  readonly log: CollabServerOp[] = []
  private listener: ((event: CollabConnectionEvent) => void) | undefined
  snapshot: { revision: number; document: unknown }
  revision = 0
  document: unknown
  post: (operation: CollabClientOp) => Promise<PostOpOutcome> = async (
    operation,
  ) => this.accept(operation)
  fetchOps: (after: number) => Promise<FetchOpsOutcome> = async (after) => ({
    kind: 'ops',
    ops: this.log.filter((operation) => operation.revision > after),
  })

  constructor(document: unknown = note) {
    this.document = document
    this.snapshot = { revision: 0, document }
  }

  accept(operation: CollabClientOp): PostOpOutcome {
    if (operation.baseRevision !== this.revision)
      return { kind: 'stale-base', revision: this.revision }
    this.document = applyOps(this.document as Json, operation.patch)
    const op: CollabServerOp = {
      ...operation,
      revision: ++this.revision,
      timestamp: this.revision,
    }
    this.log.push(op)
    return { kind: 'accepted', op }
  }

  async postOp(operation: CollabClientOp): Promise<PostOpOutcome> {
    this.posts.push(operation)
    return this.post(operation)
  }

  async fetchSnapshot() {
    return this.snapshot
  }
  async putSnapshot(revision: number, document: unknown) {
    this.snapshots.push({ revision, document })
    return { kind: 'ok' as const }
  }
  sendPresence(payload: Json): void {
    this.presence.push(payload)
  }
  onEvent(listener: (event: CollabConnectionEvent) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }
  emit(event: CollabConnectionEvent): void {
    this.listener?.(event)
  }
  connected(kind = noteAdapter.kind): void {
    this.emit({
      kind: 'connected',
      descriptor: {
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        sessionId: this.sessionId,
        scope: 'shared',
        documentId: 'document',
        documentKind: kind,
        revision: this.revision,
        snapshotRevision: this.snapshot.revision,
      },
    })
  }
  foreign(patch: CollabClientOp['patch'], deliver = true): void {
    const result = this.accept({
      protocolVersion: 1,
      actorId: 'peer',
      opId: `peer-${this.revision}`,
      baseRevision: this.revision,
      patch,
    })
    if (result.kind !== 'accepted') throw new Error('foreign op failed')
    if (deliver) this.emit({ kind: 'op', op: result.op })
  }
  close(): void {
    this.listener = undefined
  }
}

const sessions: { close(): void }[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) session.close()
  vi.useRealTimers()
})

async function open(
  connection = new Connection(),
  adapter = noteAdapter,
  conflicts: SessionConflict[] = [],
) {
  const session = await connectDocumentSession(connection, adapter, {
    actorId: 'local',
    onConflict: (conflict) => conflicts.push(conflict),
    onListenerError: () => {},
    snapshotRandom: () => 0,
  })
  sessions.push(session)
  return session
}

describe('document type registry', () => {
  it('normalizes legacy builtins but leaves extension kinds alone', () => {
    const registry = createDocumentTypeRegistry().register(noteAdapter)
    expect(registry.get()).toBe(registry.get('workflow'))
    expect(registry.get('workflow')).toBe(registry.get('dinkster.workflow'))
    expect(registry.get('image')).toBe(imageDocumentTypeAdapter)
    expect(registry.get('dinkster.image')).toBe(imageDocumentTypeAdapter)
    expect(registry.get('video')).toBe(videoDocumentTypeAdapter)
    expect(registry.get('dinkster.video')).toBe(videoDocumentTypeAdapter)
    expect(registry.get('example.note')).toBe(noteAdapter)
    expect(registry.get('missing')).toBeUndefined()
    expect(normalizeCollabDocumentKind()).toBe('dinkster.workflow')
    expect(normalizeCollabDocumentKind('image')).toBe('dinkster.image')
    expect(normalizeCollabDocumentKind('video')).toBe('dinkster.video')
    expect(normalizeCollabDocumentKind('example.note')).toBe('example.note')
    expect(legacyCollabDocumentKind('dinkster.workflow')).toBe('workflow')
    expect(legacyCollabDocumentKind('dinkster.image')).toBe('image')
    expect(legacyCollabDocumentKind('dinkster.video')).toBe('video')
    expect(legacyCollabDocumentKind('example.note')).toBe('example.note')
    expect(new DocumentTypeRegistry().get()).toBeUndefined()
    expect(() =>
      registry.register({ ...noteAdapter, kind: 'workflow' }),
    ).toThrow('already registered')
    const descriptor = {
      protocolVersion: 1,
      sessionId: 'test',
      revision: 0,
      snapshotRevision: 0,
    }
    expect(
      validateCollabDescriptor(descriptor, 'test', 'dinkster.workflow'),
    ).toBeNull()
    expect(
      validateCollabDescriptor(
        { ...descriptor, documentKind: 'image' },
        'test',
        'dinkster.image',
      ),
    ).toBeNull()
    expect(
      validateCollabDescriptor(
        { ...descriptor, documentKind: 'dinkster.image' },
        'test',
        'image',
      ),
    ).toBeNull()
    expect(
      validateCollabDescriptor(
        { ...descriptor, documentKind: 'example.note' },
        'test',
        'example.note',
      ),
    ).toBeNull()
    expect(
      validateCollabDescriptor(descriptor, 'test', 'example.note'),
    ).toContain('mismatch')
  })

  it('loads and replaces a video document through the same adapter contract', () => {
    const initial = createVideoDocument('Initial')
    const replacement = createVideoDocument('Replacement')
    expect(videoDocumentTypeAdapter.load(initial).document).toEqual(initial)
    expect(videoDocumentTypeAdapter.load({}).document).toBeUndefined()
    const outcome = videoDocumentTypeAdapter.execute(
      initial,
      {
        command: 'video.document.replace',
        params: { document: replacement },
      },
      false,
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.doc).toEqual(replacement)
    expect(applyOps(outcome.doc, outcome.inverse)).toEqual(initial)
  })

  it('refuses a snapshot whose advertised kind does not match the adapter', async () => {
    const connection = new Connection()
    connection.fetchSnapshot = async () => ({
      revision: 0,
      document: note,
      documentKind: 'image',
    })
    await expect(open(connection)).rejects.toThrow(
      "document kind 'image' does not match 'example.note'",
    )
  })

  it('uses one local adapter path for dispatch, undo, and redo', () => {
    const session = new LocalDocumentTypeSession(note, noteAdapter)
    const operations: string[] = []
    session.onOp((operation) => operations.push(operation.invocation.command))

    expect(
      session.dispatch({ command: 'note.increment', params: null }).ok,
    ).toBe(true)
    expect(session.doc.count).toBe(1)
    expect(session.revision).toBe(1)
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)
    expect(session.undo()).toBe(true)
    expect(session.doc.count).toBe(0)
    expect(session.canRedo).toBe(true)
    expect(session.redo()).toBe(true)
    expect(session.doc.count).toBe(1)
    expect(session.revision).toBe(3)
    expect(operations).toEqual([
      'note.increment',
      'document.undo',
      'document.redo',
    ])
  })

  it('owns local invocations and patches before retaining history', () => {
    const patch: PatchOp[] = [
      { op: 'replace', path: ['title'], value: 'owned', oldValue: 'initial' },
    ]
    const adapter = {
      ...noteAdapter,
      execute: () => ({
        ok: true as const,
        doc: note,
        forward: patch,
        inverse: invertOps(patch),
        diagnostics: [],
      }),
    }
    const session = new LocalDocumentTypeSession(note, adapter)
    const nested = ['safe']
    const invocation: CommandInvocation = {
      command: 'note.title',
      params: { nested },
    }

    expect(session.dispatch(invocation).ok).toBe(true)
    patch.length = 0
    nested[0] = 'mutated'
    expect(session.doc.title).toBe('owned')
    expect(session.undo()).toBe(true)
    expect(session.doc.title).toBe('initial')
    expect(session.redo()).toBe(true)
    expect(session.doc.title).toBe('owned')
  })

  it('rejects a successful adapter outcome that carries an error diagnostic', () => {
    const adapter = {
      ...noteAdapter,
      execute: () => ({
        ok: true as const,
        doc: { ...note, count: 99 },
        forward: [
          { op: 'replace' as const, path: ['count'], value: 99, oldValue: 0 },
        ],
        inverse: [],
        diagnostics: problem('rejected after execution'),
      }),
    }
    const session = new LocalDocumentTypeSession(note, adapter)
    const operations: unknown[] = []
    session.onOp((operation) => operations.push(operation))
    const result = session.dispatch({ command: 'note.increment', params: null })
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toEqual(problem('rejected after execution'))
    expect(session.doc).toEqual(note)
    expect(session.revision).toBe(0)
    expect(session.canUndo).toBe(false)
    expect(operations).toEqual([])
  })

  it('keeps commit events and retained resources immutable for listeners', () => {
    const adapter: DocumentTypeAdapter<Note & { resources?: string[] }> = {
      ...noteAdapter,
      resourceDigests: (document) =>
        new Set((document as { resources?: string[] }).resources ?? []),
    }
    const withResource = { ...note, resources: ['blake3:a'] }
    const session = new LocalDocumentTypeSession(withResource, adapter)
    const events: unknown[] = []
    session.onCommit((event) => events.push(event))
    expect(
      session.dispatch({ command: 'note.increment', params: null }).ok,
    ).toBe(true)
    expect(session.retainedResourceDigests()).toEqual(new Set(['blake3:a']))
    for (const event of events) {
      const record = (event as { record: { resources?: readonly string[] } }).record
      expect(() => (record.resources as string[]).push('blake3:evil')).toThrow()
      expect(() => (event as { kind: string }).kind = 'redo').toThrow()
    }
    expect(session.retainedResourceDigests()).toEqual(new Set(['blake3:a']))
    expect(session.undo()).toBe(true)
    expect(session.retainedResourceDigests()).toEqual(new Set(['blake3:a']))
  })

  it('stamps each commit with its own clock reading on the op envelope', () => {
    let now = 100
    const session = new LocalDocumentTypeSession(note, noteAdapter, 200, {
      actorId: 'alice',
      clock: () => (now += 100),
      replayOriginPrefix: 'note',
    })
    const stamps: number[] = []
    session.onSessionOp((operation) => stamps.push(operation.timestamp))
    expect(session.dispatch({ command: 'note.increment', params: null }).ok).toBe(true)
    expect(session.undo()).toBe(true)
    expect(session.redo()).toBe(true)
    expect(stamps).toEqual([200, 300, 400])
    expect(stamps.every((stamp, index) => index === 0 || stamp > stamps[index - 1]!)).toBe(true)
  })

  it('removes only the adapter instance contributed by an extension', () => {
    const registry = new DocumentTypeRegistry()
    const remove = registry.contribute(noteAdapter)
    expect(registry.get(noteAdapter.kind)).toBe(noteAdapter)
    remove()
    remove()
    expect(registry.get(noteAdapter.kind)).toBeUndefined()
  })

  it('refuses an invalid local actor identity before opening a transport session', () => {
    const connection = new Connection()
    expect(
      () =>
        new SharedDocumentSession(connection, note, 0, noteAdapter, {
          actorId: '__proto__',
        }),
    ).toThrow('invalid collaboration actor id')
    expect(connection.posts).toEqual([])
    expect(connection.presence).toEqual([])
  })
})

describe('third document adapter through the shared engine', () => {
  it('dispatches, rebases a foreign edit, and sends undo/redo through the same FIFO', async () => {
    const connection = new Connection()
    const session = await open(connection)
    const operations: string[] = []
    session.onOp((operation) => operations.push(operation.origin))
    expect(session).toBeInstanceOf(SharedDocumentSession)
    expect(
      session.dispatch({ command: 'note.increment', params: null }).ok,
    ).toBe(true)
    connection.foreign([{ op: 'replace', path: ['count'], value: 4 }])
    expect(session.doc.count).toBe(5)
    await session.settle()
    expect(session.undo()).toBe(true)
    await session.settle()
    expect(session.doc.count).toBe(4)
    expect(session.redo()).toBe(true)
    await session.settle()
    expect(session.doc.count).toBe(5)
    expect(operations).toEqual([
      'remote',
      'note.increment',
      'session.undo',
      'session.redo',
    ])
    expect(connection.posts.map((operation) => operation.baseRevision)).toEqual(
      [1, 2, 3],
    )
    expect(session.predictedNodeId('g0')).toBeUndefined()
    const seen: unknown[] = []
    session.onPresence((actor, payload) => seen.push([actor, payload]))
    session.sendPresence({ cursor: 3 })
    connection.emit({
      kind: 'presence',
      actorId: 'peer',
      payload: { cursor: 4 },
    })
    expect(connection.presence).toEqual([{ cursor: 3 }])
    expect(seen).toEqual([['peer', { cursor: 4 }]])
  })

  it('catches up a gap and resyncs without discarding an unsent intention', async () => {
    const connection = new Connection()
    const session = await open(connection)
    connection.foreign([{ op: 'replace', path: ['count'], value: 4 }], false)
    connection.connected()
    await session.settle()
    expect(session.doc.count).toBe(4)
    connection.snapshot = { revision: 2, document: { ...note, count: 8 } }
    connection.document = connection.snapshot.document
    connection.revision = 2
    connection.fetchOps = async () => ({
      kind: 'resync-required',
      snapshotRevision: 2,
    })
    session.dispatch({ command: 'note.increment', params: null })
    connection.connected()
    await session.settle()
    expect(session.doc.count).toBe(9)
    expect(session.revision).toBe(3)
    expect(connection.posts).toHaveLength(1)
  })

  it('reports rebase and history conflicts as diagnostics for Problems, never overwriting a peer', async () => {
    const connection = new Connection()
    const conflicts: SessionConflict[] = []
    const session = await open(connection, noteAdapter, conflicts)
    session.dispatch({ command: 'note.title', params: 'local title' })
    await session.settle()
    connection.foreign([
      { op: 'replace', path: ['title'], value: 'peer title' },
    ])
    expect(session.undo()).toBe(false)
    expect(session.doc.title).toBe('peer title')
    session.dispatch({ command: 'note.increment', params: null })
    connection.foreign([{ op: 'replace', path: ['editable'], value: false }])
    await session.settle()
    expect(session.doc.count).toBe(0)
    expect(conflicts.map((conflict) => conflict.during)).toEqual([
      'undo',
      'rebase',
    ])
    expect(
      conflicts.every(
        (conflict) => conflict.diagnostics[0]?.severity === 'error',
      ),
    ).toBe(true)
    expect(connection.posts).toHaveLength(1)
  })

  it('publishes timed checkpoints from confirmed state while an optimistic edit is pending', async () => {
    vi.useFakeTimers()
    const connection = new Connection()
    const session = await open(connection)
    connection.connected()
    for (let count = 1; count <= 20; count++) {
      connection.foreign([{ op: 'replace', path: ['count'], value: count }])
    }
    let resolve!: (outcome: PostOpOutcome) => void
    connection.post = () =>
      new Promise((done) => {
        resolve = done
      })
    session.dispatch({ command: 'note.increment', params: null })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(session.doc.count).toBe(21)
    expect(connection.snapshots).toEqual([
      { revision: 20, document: { ...note, count: 20 } },
    ])
    resolve(connection.accept(connection.posts[0]!))
    await session.settle()
  })

  it('keeps definitive security denials terminal and rejects settle without retry', async () => {
    const connection = new Connection()
    const diagnostic = {
      version: 1 as const,
      type: 'collab.denial' as const,
      code: 'forbidden',
      status: 403,
      message: 'denied',
      sessionId: connection.sessionId,
      actorId: 'local',
      opId: 'denied-op',
    }
    connection.post = async () => ({ kind: 'forbidden', diagnostic })
    const session = await open(connection)
    session.dispatch({ command: 'note.increment', params: null })
    await expect(session.settle()).rejects.toMatchObject({ diagnostic })
    connection.connected()
    expect(session.status.get()).toBe('error')
    expect(session.doc.count).toBe(1)
    expect(connection.posts).toHaveLength(1)
  })

  it('owns adapter patches and derives state from them rather than retaining proposed mutable state', async () => {
    const connection = new Connection()
    const patch: PatchOp[] = [
      { op: 'replace', path: ['title'], value: 'owned', oldValue: 'initial' },
    ]
    const proposed = { ...note, title: 'not the patch' }
    const session = await open(connection, {
      ...noteAdapter,
      execute: () => ({
        ok: true,
        doc: proposed,
        forward: patch,
        inverse: invertOps(patch),
        diagnostics: [],
      }),
    })
    expect(
      session.dispatch({ command: 'note.title', params: 'owned' }).ok,
    ).toBe(true)
    patch.length = 0
    proposed.title = 'mutated'
    expect(session.doc.title).toBe('owned')
    expect(Object.isFrozen(session.doc)).toBe(true)
    await session.settle()
    expect(connection.posts[0]?.patch).toHaveLength(1)
  })

  it.each([
    [{ op: 'replace', path: ['count'], value: -1, oldValue: 0 }],
    [
      {
        op: 'replace',
        path: ['__proto__', 'polluted'],
        value: true,
        oldValue: null,
      },
    ],
    [{ op: 'replace', path: ['title'], value: undefined, oldValue: 'initial' }],
    [{ op: 'remove', path: ['title'] }],
  ])('rejects invalid adapter patches atomically: %j', async (operation) => {
    const connection = new Connection()
    const patch = [operation] as unknown as PatchOp[]
    const session = await open(connection, {
      ...noteAdapter,
      execute: () => ({
        ok: true,
        doc: note,
        forward: patch,
        inverse: [],
        diagnostics: [],
      }),
    })
    expect(session.dispatch({ command: 'note.title', params: null }).ok).toBe(
      false,
    )
    expect(session.doc).toEqual(note)
    expect(connection.posts).toHaveLength(0)
    expect(session.canUndo).toBe(false)
  })

  it('reserves session.patch even if the adapter advertises it and rejects malformed preparation', async () => {
    const connection = new Connection()
    const session = await open(connection, {
      ...noteAdapter,
      commandIds: new Set([...noteAdapter.commandIds, 'session.patch']),
      prepare: () => ({
        ok: true,
        params: { invalid: undefined } as unknown as Json,
      }),
    })
    expect(
      session.dispatch({ command: 'session.patch', params: { ops: [] } }),
    ).toMatchObject({ ok: false, diagnostics: [{ code: 'command.reserved' }] })
    expect(
      session.dispatch({ command: 'note.title', params: 'bad' }),
    ).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'command.params.notJson' }],
    })
    expect(connection.posts).toHaveLength(0)
  })

  it('isolates a malformed transform as a conflict without losing other pending intentions', async () => {
    const conflicts: SessionConflict[] = []
    const connection = new Connection()
    const session = await open(
      connection,
      {
        ...noteAdapter,
        transform: (invocation) =>
          invocation.command === 'note.title'
            ? ({ invalid: undefined } as unknown as Json)
            : undefined,
      },
      conflicts,
    )
    session.dispatch({ command: 'note.title', params: 'bad' })
    session.dispatch({ command: 'note.increment', params: null })
    connection.foreign([{ op: 'replace', path: ['count'], value: 5 }])
    await session.settle()
    expect(session.doc).toEqual({ ...note, count: 6 })
    expect(conflicts).toHaveLength(1)
    expect(connection.posts).toHaveLength(1)
  })

  it('rejects non-JSON loader output before subscribing', async () => {
    const connection = new Connection()
    const onEvent = vi.spyOn(connection, 'onEvent')
    await expect(
      open(connection, {
        ...noteAdapter,
        load: () => ({
          document: { ...note, extra: () => {} },
          diagnostics: [],
        }),
      }),
    ).rejects.toThrow('not JSON')
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('carries resource retention with adopted history and releases it on clear', async () => {
    const adapter: DocumentTypeAdapter<Note> = {
      ...noteAdapter,
      resourceDigests: (document) => new Set([document.title]),
    }
    const first = await open(new Connection(), adapter)
    first.dispatch({ command: 'note.title', params: 'resource' })
    await first.settle()
    expect(first.undo()).toBe(true)
    await first.settle()
    const second = await open(new Connection(first.doc), adapter)
    second.adoptHistory(first.historySnapshot())
    expect(second.retainedResourceDigests()).toEqual(
      new Set(['initial', 'resource']),
    )
    expect(second.redo()).toBe(true)
    await second.settle()
    expect(second.doc.title).toBe('resource')
    second.clearHistory()
    expect(second.retainedResourceDigests()).toEqual(new Set(['resource']))
  })
})

const workflow: WorkflowDocument = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: asLineageId('lineage'),
  root: asGraphDefId('g0'),
  graphs: {
    g0: {
      id: asGraphDefId('g0'),
      name: 'graph',
      nodes: { n0: { id: asNodeId('n0'), type: 'X', values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
    },
  },
  view: { graphs: {} },
}
const image: ImageDocument = {
  format: 'dinkster-image',
  formatVersion: 2,
  lineage: asImageLineageId('lineage'),
  canvas: {
    width: 1,
    height: 1,
    colorSpace: 'srgb',
    channelDepth: 8,
    compositing: 'premultiplied-alpha',
  },
  allocation: { nextOrdinal: 1 },
  rootLayerIds: [asImageLayerId('l0')],
  layers: {
    l0: {
      id: asImageLayerId('l0'),
      kind: 'group',
      name: 'initial',
      childLayerIds: [],
      visible: true,
      opacity: 65535,
      transform: { a: 1000000, b: 0, c: 0, d: 1000000, tx: 0, ty: 0 },
      blendMode: 'normal',
      clipping: 'none',
      maskIds: [],
    },
  },
  masks: {},
  resources: {},
}

describe('transport denials across document adapters', () => {
  it.each(['workflow', 'image', 'example.note'])(
    'fails an idle %s session immediately without losing the document',
    async (kind) => {
      const initial =
        kind === 'workflow' ? workflow : kind === 'image' ? image : note
      const connection = new Connection(initial)
      const errors: string[] = []
      const options = {
        actorId: 'local',
        onError: (message: string) => errors.push(message),
      }
      const session =
        kind === 'workflow'
          ? await connectSharedSession(
              connection,
              coreCommandRegistry(),
              options,
            )
          : kind === 'image'
            ? new SharedDocumentSession(
                connection,
                image,
                0,
                imageDocumentTypeAdapter,
                options,
              )
            : await connectDocumentSession(connection, noteAdapter, options)
      sessions.push(session)
      const diagnostic = {
        version: 1 as const,
        type: 'collab.denial' as const,
        code: 'forbidden',
        status: 403,
        message: 'session access revoked',
        sessionId: connection.sessionId,
        actorId: 'local',
        operation: 'snapshot',
      }
      connection.emit({ kind: 'denial', diagnostic })
      expect(session.status.get()).toBe('error')
      expect(errors).toEqual([JSON.stringify(diagnostic)])
      expect(session.doc).toEqual(initial)
      await expect(session.settle()).rejects.toMatchObject({ diagnostic })
      connection.connected(kind)
      expect(session.status.get()).toBe('error')
      expect(connection.posts).toEqual([])
      expect(errors).toHaveLength(1)
    },
  )
})

describe('default positional array history', () => {
  const adapter: DocumentTypeAdapter<{ items: string[] }> = {
    kind: 'example.list',
    commandIds: new Set(['remove', 'insert']),
    load: (value) => ({
      document: value as { items: string[] },
      diagnostics: [],
    }),
    check: () => [],
    execute(document, invocation) {
      const forward: PatchOp[] =
        invocation.command === 'remove'
          ? [{ op: 'remove', path: ['items', 0], oldValue: document.items[0]! }]
          : [{ op: 'add', path: ['items', 0], value: 'new' }]
      return {
        ok: true,
        doc: applyOps(document, forward) as { items: string[] },
        forward,
        inverse: invertOps(forward),
        diagnostics: [],
      }
    },
  }

  it.each(['remove', 'insert'])(
    'undoes and redoes a non-tail %s without a foreign edit',
    async (command) => {
      const initial = { items: ['a', 'b'] }
      const connection = new Connection(initial)
      const conflicts: SessionConflict[] = []
      const session = await connectDocumentSession(connection, adapter, {
        actorId: 'local',
        onConflict: (conflict) => conflicts.push(conflict),
      })
      sessions.push(session)
      const result = session.dispatch({ command, params: null })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(Object.isFrozen(result.inverse)).toBe(true)
        expect(Object.isFrozen(result.inverse[0])).toBe(true)
      }
      await session.settle()
      const edited = session.doc
      expect(session.undo()).toBe(true)
      await session.settle()
      expect(session.doc).toEqual(initial)
      expect(session.redo()).toBe(true)
      await session.settle()
      expect(session.doc).toEqual(edited)
      expect(connection.revision).toBe(3)
      expect(conflicts).toEqual([])
    },
  )

  it('refuses an insertion inverse after a foreign edit shifts its array', async () => {
    const connection = new Connection({ items: ['a', 'b'] })
    const conflicts: SessionConflict[] = []
    const session = await connectDocumentSession(connection, adapter, {
      actorId: 'local',
      onConflict: (conflict) => conflicts.push(conflict),
    })
    sessions.push(session)
    session.dispatch({ command: 'remove', params: null })
    await session.settle()
    connection.foreign([{ op: 'add', path: ['items', 0], value: 'peer' }])
    expect(session.undo()).toBe(false)
    expect(session.doc).toEqual({ items: ['peer', 'b'] })
    expect(conflicts).toHaveLength(1)
    expect(connection.posts).toHaveLength(1)
  })
})

describe('definitively refused stale-base attempts', () => {
  it('keeps an earlier unknown attempt ambiguous when a reminted attempt is refused', async () => {
    const connection = new Connection()
    const conflicts: SessionConflict[] = []
    const session = await open(connection, noteAdapter, conflicts)
    connection.fetchOps = async () => ({
      kind: 'resync-required',
      snapshotRevision: 1,
    })
    connection.post = async () => {
      if (connection.posts.length === 1) {
        connection.emit({
          kind: 'op',
          op: { opId: 'invalid' } as CollabServerOp,
        })
        return { kind: 'error', message: 'unknown delivery' }
      }
      connection.snapshot = { revision: 1, document: { ...note, count: 1 } }
      connection.document = connection.snapshot.document
      connection.revision = 1
      return { kind: 'stale-base', revision: 1 }
    }
    session.dispatch({ command: 'note.increment', params: null })
    await session.settle()
    expect(connection.posts).toHaveLength(2)
    expect(connection.posts[0]?.opId).not.toBe(connection.posts[1]?.opId)
    expect(session.doc.count).toBe(1)
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.diagnostics[0]?.code).toBe(
      'session.delivery-ambiguous',
    )
  })

  it.each(['workflow', 'image', 'example.note'])(
    'retains the %s edit across a compacted resync and submits exactly twice',
    async (kind) => {
      const initial =
        kind === 'workflow' ? workflow : kind === 'image' ? image : note
      const connection = new Connection(initial)
      connection.revision = 1
      connection.snapshot = { revision: 0, document: initial }
      connection.fetchOps = async () => ({
        kind: 'resync-required',
        snapshotRevision: 1,
      })
      connection.post = async (operation) => {
        if (connection.posts.length === 1) {
          connection.snapshot = { revision: 1, document: initial }
          return { kind: 'stale-base', revision: 1 }
        }
        return connection.accept(operation)
      }
      const conflicts: unknown[] = []
      const options = {
        actorId: 'local',
        onConflict: (conflict: unknown) => conflicts.push(conflict),
      }
      if (kind === 'workflow') {
        const session = await connectSharedSession(
          connection,
          coreCommandRegistry(),
          options,
        )
        sessions.push(session)
        session.dispatch({
          command: 'node.setTitle',
          params: { graphId: 'g0', nodeId: 'n0', title: 'retained' },
        })
        await session.settle()
        expect(session.doc.graphs.g0?.nodes.n0?.title).toBe('retained')
      } else if (kind === 'image') {
        const session = new SharedDocumentSession(
          connection,
          image,
          0,
          imageDocumentTypeAdapter,
          options,
        )
        sessions.push(session)
        session.dispatch({
          command: 'image.layer.update',
          params: { layerId: 'l0', name: 'retained' },
        })
        await session.settle()
        expect(session.doc.layers.l0?.name).toBe('retained')
      } else {
        const session = await open(
          connection,
          noteAdapter,
          conflicts as SessionConflict[],
        )
        session.dispatch({ command: 'note.title', params: 'retained' })
        await session.settle()
        expect(session.doc.title).toBe('retained')
      }
      expect(connection.posts).toHaveLength(2)
      expect(
        connection.posts.map((operation) => operation.baseRevision),
      ).toEqual([0, 1])
      expect(connection.revision).toBe(2)
      expect(conflicts).toEqual([])
    },
  )
})

describe('image adapter history and resource retention', () => {
  it('keeps allocation writes out of redo and retains resources through rebased history', async () => {
    const digest = `blake3:${'a'.repeat(64)}` as const
    const connection = new Connection(image)
    const conflicts: unknown[] = []
    const session = new SharedDocumentSession(
      connection,
      image,
      0,
      imageDocumentTypeAdapter,
      {
        actorId: 'local',
        onConflict: (conflict) => conflicts.push(conflict),
      },
    )
    sessions.push(session)
    const result = session.dispatch({
      command: 'image.layer.addRaster',
      params: {
        parentId: null,
        index: 1,
        name: 'raster',
        resource: {
          kind: 'raster',
          digest,
          byteSize: 4,
          mediaType: 'image/png',
          width: 1,
          height: 1,
          colorSpace: 'srgb',
          channelDepth: 8,
          alphaMode: 'straight',
        },
        sourceRect: { x: 0, y: 0, width: 1, height: 1 },
      },
    })
    expect(result).toMatchObject({
      ok: true,
      created: { resourceId: 'r0-local', layerId: 'l1-local' },
    })
    connection.foreign([
      { op: 'replace', path: ['layers', 'l0', 'name'], value: 'peer group' },
    ])
    await session.settle()
    expect(session.doc.allocation.actorCursors?.local).toBe(2)
    expect(session.undo()).toBe(true)
    connection.foreign([
      { op: 'replace', path: ['layers', 'l0', 'name'], value: 'peer renamed' },
    ])
    await session.settle()
    expect(session.doc.resources).toEqual({})
    expect(session.retainedResourceDigests()).toEqual(new Set([digest]))
    expect(session.doc.allocation.actorCursors?.local).toBe(2)
    expect(session.redo()).toBe(true)
    connection.foreign([
      { op: 'replace', path: ['layers', 'l0', 'name'], value: 'peer again' },
    ])
    await session.settle()
    expect(session.doc.layers['l1-local']).toBeDefined()
    expect(
      connection.posts
        .at(-1)
        ?.patch.every((operation) => operation.path[0] !== 'allocation'),
    ).toBe(true)
    expect(session.undo()).toBe(true)
    session.clearHistory()
    expect(session.retainedResourceDigests()).toEqual(new Set([digest]))
    await session.settle()
    expect(session.retainedResourceDigests()).toEqual(new Set())
    expect(conflicts).toEqual([])
  })

  it('rejects a foreign patch that violates image shape even if references remain valid', async () => {
    const connection = new Connection(image)
    const session = await connectDocumentSession(
      connection,
      imageDocumentTypeAdapter,
      {
        actorId: 'local',
        onListenerError: () => {},
      },
    )
    sessions.push(session)
    connection.emit({
      kind: 'op',
      op: {
        opId: 'invalid-shape',
        actorId: 'peer',
        baseRevision: 0,
        revision: 1,
        timestamp: 1,
        patch: [{ op: 'replace', path: ['canvas', 'width'], value: -1 }],
      },
    })
    // The authoritative snapshot and retained log contain a valid peer edit.
    connection.foreign(
      [{ op: 'replace', path: ['layers', 'l0', 'name'], value: 'valid peer' }],
      false,
    )
    await session.settle()
    expect(session.doc.canvas.width).toBe(1)
    expect(session.doc.layers.l0?.name).toBe('valid peer')
    expect(session.status.get()).toBe('live')
  })
})
