import { describe, expect, it, vi } from 'vitest'
import {
  COLLAB_PROTOCOL_VERSION,
  IMAGE_DOCUMENT_FORMAT_VERSION,
  IMAGE_FIXED_POINT_SCALE,
  IMAGE_OPACITY_MAX,
  SharedImageDocumentSession,
  asImageLayerId,
  asImageLineageId,
  asImageResourceId,
  connectSharedImageDocumentSession,
  diag,
  type CollabClientOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
  type CollabSessionDescriptor,
  type FetchOpsOutcome,
  type ImageDocument,
  type PostOpOutcome,
  type PutSnapshotOutcome,
} from '../src/index.js'
import { applyOps } from '../src/commands/patch.js'
import type { Json } from '../src/format/document.js'

const DIGEST_A = `blake3:${'a'.repeat(64)}` as const
const DIGEST_B = `blake3:${'b'.repeat(64)}` as const

function imageDocument(): ImageDocument {
  return {
    format: 'dinkster-image',
    formatVersion: IMAGE_DOCUMENT_FORMAT_VERSION,
    lineage: asImageLineageId('shared-image'),
    canvas: {
      width: 8,
      height: 6,
      colorSpace: 'srgb',
      channelDepth: 8,
      compositing: 'premultiplied-alpha',
    },
    allocation: { nextOrdinal: 2 },
    rootLayerIds: [asImageLayerId('l1')],
    layers: {
      l1: {
        id: asImageLayerId('l1'),
        kind: 'raster',
        name: 'Pixels',
        visible: true,
        opacity: IMAGE_OPACITY_MAX,
        transform: {
          a: IMAGE_FIXED_POINT_SCALE,
          b: 0,
          c: 0,
          d: IMAGE_FIXED_POINT_SCALE,
          tx: 0,
          ty: 0,
        },
        blendMode: 'normal',
        clipping: 'none',
        maskIds: [],
        resourceId: asImageResourceId('r0'),
        sourceRect: { x: 0, y: 0, width: 8, height: 6 },
      },
    },
    masks: {},
    resources: {
      r0: {
        id: asImageResourceId('r0'),
        kind: 'raster',
        digest: DIGEST_A,
        byteSize: 192,
        mediaType: 'image/png',
        width: 8,
        height: 6,
        colorSpace: 'srgb',
        channelDepth: 8,
        alphaMode: 'straight',
      },
    },
  }
}

class FakeServer {
  readonly descriptor: CollabSessionDescriptor = {
    protocolVersion: COLLAB_PROTOCOL_VERSION,
    sessionId: 'image-session',
    scope: 'shared',
    documentId: 'shared-image',
    documentKind: 'image',
    revision: 0,
    snapshotRevision: 0,
  }
  document: ImageDocument = imageDocument()
  readonly log: CollabServerOp[] = []
  readonly connections = new Set<FakeConnection>()

  connect(): FakeConnection {
    const connection = new FakeConnection(this)
    this.connections.add(connection)
    return connection
  }

  async post(operation: CollabClientOp): Promise<PostOpOutcome> {
    if (operation.baseRevision !== this.log.length) {
      return { kind: 'stale-base', revision: this.log.length }
    }
    this.document = applyOps(this.document as unknown as Json, operation.patch) as unknown as ImageDocument
    const accepted: CollabServerOp = {
      opId: operation.opId,
      actorId: operation.actorId,
      baseRevision: operation.baseRevision,
      revision: this.log.length + 1,
      patch: operation.patch,
      timestamp: this.log.length + 1,
    }
    this.log.push(accepted)
    for (const connection of this.connections) connection.emit({ kind: 'op', op: accepted })
    return { kind: 'accepted', op: accepted }
  }
}

class FakeConnection implements CollabConnection {
  readonly sessionId = 'image-session'
  private readonly listeners = new Set<(event: CollabConnectionEvent) => void>()

  constructor(private readonly server: FakeServer) {}

  postOp(operation: CollabClientOp): Promise<PostOpOutcome> { return this.server.post(operation) }

  fetchOps(after: number): Promise<FetchOpsOutcome> {
    return Promise.resolve({ kind: 'ops', ops: this.server.log.filter((operation) => operation.revision > after) })
  }

  fetchSnapshot(): Promise<{ readonly revision: number; readonly document: unknown }> {
    return Promise.resolve({ revision: this.server.log.length, document: this.server.document })
  }

  putSnapshot(): Promise<PutSnapshotOutcome> { return Promise.resolve({ kind: 'ok' }) }
  sendPresence(): void {}

  onEvent(listener: (event: CollabConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    listener({ kind: 'connected', descriptor: this.server.descriptor })
    return () => this.listeners.delete(listener)
  }

  emit(event: CollabConnectionEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  close(): void { this.server.connections.delete(this) }
}

async function settle(...sessions: SharedImageDocumentSession[]): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await Promise.all(sessions.map((session) => session.settle()))
    if (sessions.every((session) => session.doc.rootLayerIds.length === sessions[0]!.doc.rootLayerIds.length)) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('shared image sessions did not settle')
}

describe('SharedImageDocumentSession', () => {
  it.each(['admit', 'refuse', 'disconnect'] as const)('waits for initial remote admission: %s', async (outcome) => {
    const server = new FakeServer()
    const connection = server.connect()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    let proposed: ImageDocument | undefined
    let exposed = false
    const committed: number[] = []
    const options = { beforeRemoteDocument: async (document: ImageDocument, revision: number,
      current: ImageDocument, digests: readonly string[]) => {
      expect(revision).toBe(0)
      expect(current).toBe(document)
      expect(digests).toEqual([DIGEST_A])
      proposed = document
      await gate
      if (outcome === 'refuse') throw new Error('Ownership refused')
      return () => { committed.push(revision) }
    } }
    expect(() => new SharedImageDocumentSession(connection, server.document, 0, options))
      .toThrow('requires connectSharedImageDocumentSession')
    const pending = connectSharedImageDocumentSession(connection, server.descriptor, options)
      .then((session) => { exposed = true; return session })
    await vi.waitFor(() => expect(proposed).toBeDefined())
    expect(exposed).toBe(false)
    if (outcome === 'disconnect') connection.emit({ kind: 'disconnected' })
    complete()
    if (outcome === 'admit') {
      const session = await pending
      expect(session.doc).toEqual(proposed)
      expect(committed).toEqual([0])
      session.close()
    } else {
      await expect(pending).rejects.toThrow(outcome === 'refuse' ? 'Ownership refused' : 'connection changed')
      expect(committed).toEqual([])
    }
    expect(server.log).toEqual([])
  })

  it('catches up operations announced during initial admission', async () => {
    const server = new FakeServer()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    const revisions: number[] = []
    const pending = connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      beforeRemoteDocument: async (_document, revision) => {
        revisions.push(revision)
        if (revision === 0) await gate
      },
    })
    await vi.waitFor(() => expect(revisions).toEqual([0]))
    const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'During admission' } })
    await remote.settle()
    complete()
    const session = await pending
    await session.settle()
    expect(revisions).toEqual([0, 1])
    expect(session.doc.layers['l1']?.name).toBe('During admission')
    expect(session.revision).toBe(1)
    session.close()
    remote.close()
  })

  it('admits ordered remote documents before signals and operations', async () => {
    const server = new FakeServer()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    const proposals: number[] = []
    const committed: number[] = []
    const session = await connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      beforeRemoteDocument: async (_document, revision) => {
        proposals.push(revision)
        if (revision === 1) await gate
        if (revision > 0) return () => {
          expect(session.revision).toBe(revision)
          expect(operations.at(-1)).toBe(revision)
          expect(visible.at(-1)).toBe(session.doc)
          committed.push(revision)
        }
      },
    })
    const current = session.doc
    const visible: ImageDocument[] = []
    const operations: number[] = []
    session.document.subscribe((document) => visible.push(document))
    session.onOp((operation) => operations.push(operation.revision))
    const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Remote' } })
    await remote.settle()
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', opacity: 23_456 } })
    await remote.settle()
    await vi.waitFor(() => expect(proposals).toEqual([0, 1]))
    expect(session.doc).toBe(current)
    expect(session.revision).toBe(0)
    expect(visible).toEqual([])
    expect(operations).toEqual([])
    complete()
    await session.settle()
    expect(proposals).toEqual([0, 1, 2])
    expect(operations).toEqual([1, 2])
    expect(committed).toEqual([1, 2])
    expect(visible.map((document) => document.layers['l1'])).toMatchObject([
      { name: 'Remote', opacity: IMAGE_OPACITY_MAX }, { name: 'Remote', opacity: 23_456 },
    ])
    expect(session.doc).toEqual(server.document)
    session.close()
    remote.close()
  })

  it.each(['refuse', 'close', 'disconnect'] as const)('preserves published state on remote admission %s', async (outcome) => {
    const server = new FakeServer()
    const connection = server.connect()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    let waiting = false
    const committed: number[] = []
    const session = await connectSharedImageDocumentSession(connection, server.descriptor, {
      beforeRemoteDocument: async (_document, revision) => {
        if (revision === 0) return
        waiting = true
        await gate
        if (outcome === 'refuse') throw new Error('Ownership refused')
        return () => { committed.push(revision) }
      },
    })
    const current = session.doc
    const visible: ImageDocument[] = []
    session.document.subscribe((document) => visible.push(document))
    const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Remote' } })
    await remote.settle()
    await vi.waitFor(() => expect(waiting).toBe(true))
    if (outcome === 'close') session.close()
    if (outcome === 'disconnect') connection.emit({ kind: 'disconnected' })
    complete()
    await session.settle()
    expect(session.status.get()).toBe(outcome === 'close' ? 'closed' : 'error')
    expect(session.doc).toBe(current)
    expect(session.revision).toBe(0)
    expect(visible).toEqual([])
    expect(committed).toEqual([])
    session.close()
    remote.close()
  })

  it('discards a superseded ordered admission before publishing the replacement snapshot', async () => {
    const server = new FakeServer()
    const connection = server.connect()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    const revisions: number[] = []
    const committed: number[] = []
    const session = await connectSharedImageDocumentSession(connection, server.descriptor, {
      beforeRemoteDocument: async (_document, revision) => {
        revisions.push(revision)
        if (revision === 1) await gate
        return () => { committed.push(revision) }
      },
    })
    const names: string[] = []
    session.document.subscribe((document) => names.push(document.layers['l1']!.name))
    const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Superseded' } })
    await remote.settle()
    await vi.waitFor(() => expect(revisions).toEqual([0, 1]))
    connection.fetchSnapshot = async () => ({ revision: 2, document: {
      ...server.document, layers: { ...server.document.layers, l1: { ...server.document.layers['l1']!, name: 'Replacement' } },
    } })
    connection.emit({ kind: 'op', op: {
      actorId: 'remote', opId: 'invalid', baseRevision: 0, revision: -1, patch: [], timestamp: 1,
    } })
    complete()
    await session.settle()
    expect(revisions).toEqual([0, 1, 2])
    expect(committed).toEqual([0, 2])
    expect(names).toEqual(['Replacement'])
    expect(session.revision).toBe(2)
    session.close()
    remote.close()
  })

  it('does not admit a page fetched across a disconnect and reconnect', async () => {
    const server = new FakeServer()
    const connection = server.connect()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    let fetching = false
    connection.fetchOps = async (after) => {
      fetching = true
      await gate
      return { kind: 'ops', ops: server.log.filter((operation) => operation.revision > after) }
    }
    const revisions: number[] = []
    const session = await connectSharedImageDocumentSession(connection, server.descriptor, {
      beforeRemoteDocument: async (_document, revision) => { revisions.push(revision) },
    })
    const current = session.doc
    const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Old connection' } })
    await remote.settle()
    await vi.waitFor(() => expect(fetching).toBe(true))
    connection.emit({ kind: 'disconnected' })
    connection.emit({ kind: 'connected', descriptor: server.descriptor })
    complete()
    await session.settle()
    expect(session.status.get()).toBe('error')
    expect(session.doc).toBe(current)
    expect(session.revision).toBe(0)
    expect(revisions).toEqual([0])
    session.close()
    remote.close()
  })

  it('re-admits rebased pending edits when local state changes during remote admission', async () => {
    const server = new FakeServer()
    const connection = server.connect()
    let finishPost!: (outcome: PostOpOutcome) => void
    connection.postOp = async () => new Promise((resolve) => { finishPost = resolve })
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    const proposals: { name: string; opacity: number; digests: readonly string[] }[] = []
    const session = await connectSharedImageDocumentSession(connection, server.descriptor, {
      beforeRemoteDocument: async (document, revision, _current, digests, retained) => {
        if (revision === 0) return
        expect(retained.some((snapshot) => snapshot.layers['l1']?.name === 'Remote')).toBe(true)
        proposals.push({ name: document.layers['l1']!.name, opacity: document.layers['l1']!.opacity, digests })
        await gate
      },
    })
    session.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', opacity: 12_345 } })
    await Promise.resolve()
    const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Remote' } })
    await remote.settle()
    await vi.waitFor(() => expect(proposals).toHaveLength(1))
    const undoBefore = session.prepareUndo()
    expect(undoBefore.ok && undoBefore.document.layers['l1']?.opacity).toBe(IMAGE_OPACITY_MAX)
    session.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', opacity: 34_567 } })
    expect(session.doc.layers['l1']?.name).toBe('Pixels')
    complete()
    await vi.waitFor(() => expect(session.status.get()).toBe('live'))
    expect(proposals).toEqual([
      { name: 'Remote', opacity: 12_345, digests: [DIGEST_A] },
      { name: 'Remote', opacity: 34_567, digests: [DIGEST_A] },
    ])
    expect(session.doc.layers['l1']).toMatchObject({ name: 'Remote', opacity: 34_567 })
    const undo = session.prepareUndo()
    expect(undo.ok && undo.document.layers['l1']).toMatchObject({ name: 'Remote', opacity: 12_345 })
    session.close()
    finishPost({ kind: 'error', message: 'Closed' })
    await session.settle()
    remote.close()
  })

  it('admits unused remote resources while keeping earlier holders in the inventory', async () => {
    const server = new FakeServer()
    const actual: string[][] = []
    const session = await connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      beforeRemoteDocument: async (document, revision, current, digests, retained) => {
        actual.push([...digests])
        if (revision === 0) return
        expect(current.resources['r2']).toBeUndefined()
        expect(document.resources['r2']?.digest).toBe(DIGEST_B)
        expect(document.layers['l1']).toMatchObject({ kind: 'raster', resourceId: 'r0' })
        expect(retained.some((snapshot) => snapshot === current)).toBe(true)
        expect(Object.isFrozen(document.resources['r2'])).toBe(true)
      },
    })
    await server.post({ protocolVersion: COLLAB_PROTOCOL_VERSION, opId: 'unused', actorId: 'remote', baseRevision: 0, patch: [
      { op: 'add', path: ['resources', 'r2'], value: { ...server.document.resources['r0']!, id: 'r2', digest: DIGEST_B } },
      { op: 'replace', path: ['allocation', 'nextOrdinal'], value: 3 },
    ] })
    await session.settle()
    expect(actual).toEqual([[DIGEST_A], [DIGEST_A, DIGEST_B]])
    expect(session.retainedResourceDigests()).toEqual(new Set([DIGEST_A, DIGEST_B]))
    session.close()
  })

  it.each(['admit', 'refuse'] as const)('preserves snapshot history until admission: %s', async (outcome) => {
    const server = new FakeServer()
    const connection = server.connect()
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    let waiting = false
    const session = await connectSharedImageDocumentSession(connection, server.descriptor, {
      beforeRemoteDocument: async (_document, revision) => {
        if (revision < 2) return
        waiting = true
        await gate
        if (outcome === 'refuse') throw new Error('Snapshot ownership refused')
      },
    })
    session.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Local' } })
    await session.settle()
    const current = session.doc
    const revision = session.revision
    connection.fetchOps = async () => ({ kind: 'resync-required', snapshotRevision: 2 })
    connection.fetchSnapshot = async () => ({ revision: 2, document: {
      ...server.document, canvas: { ...server.document.canvas, width: 13 },
    } })
    connection.emit({ kind: 'op', op: {
      actorId: 'remote', opId: 'gap', baseRevision: 1, revision: 2, patch: [], timestamp: 1,
    } })
    await vi.waitFor(() => expect(waiting).toBe(true))
    expect(session.doc).toBe(current)
    expect(session.revision).toBe(revision)
    expect(session.canUndo).toBe(true)
    complete()
    await session.settle()
    if (outcome === 'refuse') {
      expect(session.status.get()).toBe('error')
      expect(session.doc).toBe(current)
      expect(session.revision).toBe(revision)
      expect(session.canUndo).toBe(true)
    } else {
      expect(session.status.get()).toBe('live')
      expect(session.doc.canvas.width).toBe(13)
      expect(session.revision).toBe(2)
      expect(session.canUndo).toBe(false)
    }
    session.close()
  })

  it.each(['dispatch', 'undo', 'redo'] as const)('prepares %s without publication and admits it once', async (kind) => {
    const server = new FakeServer()
    let allowed = true
    const session = await connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      validateCommit: () => allowed ? [] : [diag('error', 'command', 'test.refused', 'Refused')],
    })
    const edit = { command: 'image.layer.update' as const, params: { layerId: 'l1', name: 'Changed' } }
    if (kind !== 'dispatch') {
      expect(session.dispatch(edit).ok).toBe(true)
      await session.settle()
    }
    if (kind === 'redo') {
      expect(session.undo()).toBe(true)
      await session.settle()
    }
    const current = session.doc
    const revision = session.revision
    const logLength = server.log.length
    const history = [session.canUndo, session.canRedo]
    const visible: ImageDocument[] = []
    session.document.subscribe((document) => visible.push(document))
    const prepared = kind === 'dispatch' ? session.prepareDispatch(edit)
      : kind === 'undo' ? session.prepareUndo() : session.prepareRedo()
    if (!prepared.ok) throw new Error('Missing candidate')
    expect(prepared.currentDocument).toBe(current)
    expect(prepared.currentResourceDigests).toEqual([DIGEST_A])
    expect(prepared.resourceDigests).toEqual([DIGEST_A])
    expect(Object.isFrozen(prepared.document.layers['l1'])).toBe(true)
    expect(Object.isFrozen(prepared.resourceDigests)).toBe(true)
    expect(session.doc).toBe(current)
    expect(session.revision).toBe(revision)
    expect([session.canUndo, session.canRedo]).toEqual(history)
    expect(visible).toEqual([])
    expect(server.log).toHaveLength(logLength)
    allowed = false
    const refused = kind === 'dispatch' ? session.dispatch(edit)
      : kind === 'undo' ? { ok: session.undo() } : { ok: session.redo() }
    expect(refused.ok).toBe(false)
    expect(session.doc).toBe(current)
    expect([session.canUndo, session.canRedo]).toEqual(history)
    allowed = true
    expect(prepared.commit().ok).toBe(true)
    expect(session.doc).toBe(prepared.document)
    expect(session.doc.layers['l1']?.name).toBe(kind === 'undo' ? 'Pixels' : 'Changed')
    expect(visible).toEqual([prepared.document])
    expect(prepared.commit().ok).toBe(false)
    await session.settle()
    expect(server.log).toHaveLength(logLength + 1)
    expect(session.doc).toEqual(server.document)
    session.close()
  })

  it('consumes a refused candidate without consuming history or submitting it', async () => {
    const server = new FakeServer()
    let allowed = true
    const session = await connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      validateCommit: () => allowed ? [] : [diag('error', 'command', 'test.refused', 'Refused')],
    })
    expect(session.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', visible: false } }).ok).toBe(true)
    await session.settle()
    const current = session.doc
    const prepared = session.prepareUndo()
    if (!prepared.ok) throw new Error('Missing undo')
    allowed = false
    expect(prepared.commit().ok).toBe(false)
    allowed = true
    expect(prepared.commit().ok).toBe(false)
    expect(session.doc).toBe(current)
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)
    expect(server.log).toHaveLength(1)
    expect(session.undo()).toBe(true)
    await session.settle()
    expect(server.document.layers['l1']?.visible).toBe(true)
    session.close()
  })

  it.each(['command', 'clear', 'remote', 'disconnect', 'close'] as const)('invalidates candidates after %s', async (change) => {
    const server = new FakeServer()
    const connection = server.connect()
    const session = await connectSharedImageDocumentSession(connection, server.descriptor)
    const prepared = session.prepareDispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Stale' } })
    if (!prepared.ok) throw new Error('Missing candidate')
    if (change === 'command') session.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', opacity: 12_345 } })
    if (change === 'clear') session.clearHistory()
    if (change === 'remote') {
      const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
      remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', opacity: 23_456 } })
      await remote.settle()
      remote.close()
    }
    if (change === 'disconnect') connection.emit({ kind: 'disconnected' })
    if (change === 'close') session.close()
    const current = session.doc
    const revision = session.revision
    expect(prepared.commit()).toMatchObject({ ok: false, diagnostics: [{ code: 'image.candidate.stale' }] })
    expect(session.doc).toBe(current)
    expect(session.revision).toBe(revision)
    expect(session.doc.layers['l1']?.name).toBe('Pixels')
    await session.settle()
    session.close()
  })

  it('rechecks the generation after a reentrant admission policy', async () => {
    const server = new FakeServer()
    let reenter = false
    const session = await connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      validateCommit: () => {
        if (reenter) session.clearHistory()
        return []
      },
    })
    const prepared = session.prepareDispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Stale' } })
    if (!prepared.ok) throw new Error('Missing candidate')
    reenter = true
    expect(prepared.commit().ok).toBe(false)
    expect(session.doc.layers['l1']?.name).toBe('Pixels')
    expect(session.revision).toBe(0)
    expect(server.log).toEqual([])
    session.close()
  })

  it('invalidates a prepared edit when a replacement snapshot is adopted', async () => {
    const server = new FakeServer()
    const connection = server.connect()
    const session = await connectSharedImageDocumentSession(connection, server.descriptor)
    const prepared = session.prepareDispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Stale' } })
    if (!prepared.ok) throw new Error('Missing candidate')
    const replacement = { ...server.document, canvas: { ...server.document.canvas, width: 13 } }
    connection.fetchOps = async () => ({ kind: 'resync-required', snapshotRevision: 2 })
    connection.fetchSnapshot = async () => ({ revision: 2, document: replacement })
    connection.emit({ kind: 'op', op: {
      actorId: 'remote', opId: 'gap', baseRevision: 1, revision: 2, patch: [], timestamp: 1,
    } })
    await session.settle()
    expect(session.doc.canvas.width).toBe(13)
    expect(prepared.commit().ok).toBe(false)
    expect(session.doc.layers['l1']?.name).toBe('Pixels')
    expect(session.revision).toBe(2)
    session.close()
  })

  it.each(['catch-up', 'resync'] as const)('invalidates before a delayed %s fetch completes', async (trigger) => {
    const server = new FakeServer()
    const connection = server.connect()
    const session = await connectSharedImageDocumentSession(connection, server.descriptor)
    const prepared = session.prepareDispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Stale' } })
    if (!prepared.ok) throw new Error('Missing candidate')
    const current = session.doc
    let complete!: () => void
    const gate = new Promise<void>((resolve) => { complete = resolve })
    connection.fetchOps = async () => {
      await gate
      return { kind: 'resync-required', snapshotRevision: 2 }
    }
    connection.fetchSnapshot = async () => {
      await gate
      return { revision: 2, document: { ...server.document, canvas: { ...server.document.canvas, width: 13 } } }
    }
    connection.emit({ kind: 'op', op: {
      actorId: 'remote', opId: 'incoming', baseRevision: 1,
      revision: trigger === 'catch-up' ? 2 : -1, patch: [], timestamp: 1,
    } })
    expect(session.status.get()).toBe('catching-up')
    expect(session.doc).toBe(current)
    expect(prepared.commit()).toMatchObject({ ok: false, diagnostics: [{ code: 'image.candidate.stale' }] })
    expect(session.doc).toBe(current)
    expect(session.revision).toBe(0)
    expect(session.canUndo).toBe(false)
    expect(server.log).toEqual([])
    complete()
    await session.settle()
    expect(session.doc.canvas.width).toBe(13)
    expect(session.doc.layers['l1']?.name).toBe('Pixels')
    expect(session.revision).toBe(2)
    session.close()
  })

  it('reports a stale synchronous undo without removing its retained history', async () => {
    const server = new FakeServer()
    const conflicts: string[] = []
    const session = await connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      onConflict: (conflict) => conflicts.push(conflict.origin),
    })
    session.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Local' } })
    await session.settle()
    const remote = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    remote.dispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Remote' } })
    await remote.settle()
    const current = session.doc
    expect(session.prepareUndo().ok).toBe(false)
    expect(conflicts).toEqual([])
    expect(session.undo()).toBe(false)
    expect(conflicts).toEqual(['image.undo'])
    expect(session.doc).toBe(current)
    expect(session.canUndo).toBe(true)
    expect(server.log).toHaveLength(2)
    remote.close()
    session.close()
  })

  it('includes unused and pending external rasters but excludes inline bytes', async () => {
    const server = new FakeServer()
    const pendingDigest = `blake3:${'c'.repeat(64)}` as const
    const digest = 'blake3:2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213' as const
    server.document = { ...server.document, allocation: { nextOrdinal: 4 }, resources: {
      ...server.document.resources,
      r2: { ...server.document.resources['r0']!, id: asImageResourceId('r2'), digest: DIGEST_B },
      r3: { ...server.document.resources['r0']!, id: asImageResourceId('r3'), digest,
        byteSize: 1, inline: 'AA==' },
    } }
    const session = await connectSharedImageDocumentSession(server.connect(), server.descriptor)
    const prepared = session.prepareDispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Changed' } })
    if (!prepared.ok) throw new Error('Missing candidate')
    expect(prepared.currentResourceDigests).toEqual([DIGEST_A, DIGEST_B])
    expect(prepared.resourceDigests).toEqual([DIGEST_A, DIGEST_B])
    expect(prepared.resourceDigests).not.toContain(digest)
    expect(session.dispatch({ command: 'image.layer.addRaster', params: {
      parentId: null, index: 1, name: 'Pending',
      resource: { ...server.document.resources['r0']!, digest: pendingDigest },
      sourceRect: { x: 0, y: 0, width: 8, height: 6 },
    } }).ok).toBe(true)
    expect(session.undo()).toBe(true)
    session.clearHistory()
    const pending = session.prepareDispatch({ command: 'image.layer.update', params: { layerId: 'l1', name: 'Pending inventory' } })
    if (!pending.ok) throw new Error('Missing pending candidate')
    expect(pending.resourceDigests).toEqual([DIGEST_A, DIGEST_B, pendingDigest])
    await session.settle()
    session.close()
  })

  it('refuses construction before the session exposes its document', async () => {
    const server = new FakeServer()
    await expect(connectSharedImageDocumentSession(server.connect(), server.descriptor, {
      validateCommit: () => [diag('error', 'command', 'test.refused', 'Initial document refused')],
    })).rejects.toThrow('Initial document refused')
    expect(server.log).toEqual([])
  })

  it('rebases concurrent edits in server order', async () => {
    const server = new FakeServer()
    const first = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'alice' })
    const second = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'bob' })

    expect(first.dispatch({
      command: 'image.layer.update',
      params: { layerId: 'l1', name: 'Foreground' },
    }).ok).toBe(true)
    expect(second.dispatch({
      command: 'image.layer.update',
      params: { layerId: 'l1', opacity: 32_768 },
    }).ok).toBe(true)
    await settle(first, second)

    expect(server.log).toHaveLength(2)
    expect(first.doc).toEqual(server.document)
    expect(second.doc).toEqual(server.document)
    expect(server.document.layers['l1']).toMatchObject({ name: 'Foreground', opacity: 32_768 })
  })

  it('allocates disjoint ids when collaborators add raster layers concurrently', async () => {
    const server = new FakeServer()
    const first = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'alice' })
    const second = await connectSharedImageDocumentSession(server.connect(), server.descriptor, { actorId: 'bob' })
    const add = {
      command: 'image.layer.addRaster' as const,
      params: {
        parentId: null,
        index: 1,
        name: 'Added',
        resource: {
          kind: 'raster' as const,
          digest: DIGEST_B,
          byteSize: 96,
          mediaType: 'image/png' as const,
          width: 4,
          height: 6,
          colorSpace: 'srgb' as const,
          channelDepth: 8 as const,
          alphaMode: 'straight' as const,
        },
        sourceRect: { x: 0, y: 0, width: 4, height: 6 },
      },
    }

    const left = first.dispatch(add)
    const right = second.dispatch(add)
    expect(left.ok && left.created?.layerId).toBe('l1-alice')
    expect(right.ok && right.created?.layerId).toBe('l1-bob')
    await settle(first, second)

    expect(new Set(server.document.rootLayerIds)).toEqual(new Set(['l1', 'l1-alice', 'l1-bob']))
    expect(first.doc).toEqual(server.document)
    expect(second.doc).toEqual(server.document)
  })

  it('refuses a workflow descriptor before fetching shared state', async () => {
    const server = new FakeServer()
    await expect(connectSharedImageDocumentSession(server.connect(), {
      ...server.descriptor,
      documentKind: 'workflow',
    })).rejects.toThrow('not an ImageDocument')
  })

  it('backs off when a required checkpoint cannot be published', async () => {
    const server = new FakeServer()
    const connection = server.connect()
    connection.postOp = async () => ({ kind: 'snapshot-required' })
    connection.putSnapshot = async () => { throw new Error('offline') }
    let session: SharedImageDocumentSession
    session = await connectSharedImageDocumentSession(connection, server.descriptor, {
      actorId: 'alice',
      retryDelay: async () => session.close(),
    })
    expect(session.dispatch({
      command: 'image.layer.update',
      params: { layerId: 'l1', name: 'Pending' },
    }).ok).toBe(true)

    await expect(session.settle()).resolves.toBeUndefined()
    expect(session.status.get()).toBe('closed')
  })
})
