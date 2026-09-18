import {
  COLLAB_PROTOCOL_VERSION,
  applyOps,
  checkDocument,
  isValidActorId,
  jsonSameValue,
  loadDocument,
  type CollabClientOp,
  type CollabConnectionEvent,
  type CollabServerOp,
  type Json,
  type WorkflowDocument,
} from '@dinkster/core'

export interface WorkerPortLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  start?(): void
  close?(): void
}

export type WorkerRequest =
  | { readonly id: number; readonly kind: 'open'; readonly sessionId: string; readonly document: unknown }
  | { readonly id: number; readonly kind: 'post-op'; readonly op: CollabClientOp }
  | { readonly id: number; readonly kind: 'replace-authoritative'; readonly op: CollabClientOp; readonly document: unknown }
  | { readonly id: number; readonly kind: 'fetch-snapshot' }
  | { readonly id: number; readonly kind: 'fetch-ops'; readonly after: number }
  | { readonly id: number; readonly kind: 'put-snapshot'; readonly revision: number; readonly document: unknown }
  | { readonly id: number; readonly kind: 'adopt-exclusive'; readonly op: CollabClientOp; readonly document: unknown }
  | { readonly id: number; readonly kind: 'presence'; readonly actorId: string; readonly payload: Json }
  | { readonly id: number; readonly kind: 'heartbeat' }
  | { readonly id: number; readonly kind: 'close' }

export type WorkerResponse =
  | { readonly kind: 'response'; readonly id: number; readonly value: unknown }
  | { readonly kind: 'error'; readonly id: number; readonly message: string }
  | { readonly kind: 'event'; readonly event: CollabConnectionEvent }

interface AuthoritySession {
  document: WorkflowDocument
  revision: number
  readonly ops: CollabServerOp[]
  readonly seen: Map<string, CollabServerOp>
  readonly ports: Set<WorkerPortLike>
}

const clone = <T>(value: T): T => structuredClone(value)
const validRevision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const errors = (document: WorkflowDocument): boolean =>
  checkDocument(document).some((diagnostic) => diagnostic.severity === 'error')

export class SharedWorkerDocumentAuthority {
  static readonly PORT_LEASE_MS = 90_000
  private readonly sessions = new Map<string, AuthoritySession>()
  private readonly portSessions = new Map<WorkerPortLike, string>()
  private readonly portSeen = new Map<WorkerPortLike, number>()

  connect(port: WorkerPortLike): void {
    port.addEventListener('message', (event) => this.receive(port, event.data))
    port.start?.()
  }

  private receive(port: WorkerPortLike, raw: unknown): void {
    let request: WorkerRequest
    try {
      this.portSeen.set(port, Date.now())
      this.pruneExpiredPorts(port)
      request = clone(raw) as WorkerRequest
      if (request === null || typeof request !== 'object' || !validRevision(request.id) || typeof request.kind !== 'string') {
        throw new Error('invalid request')
      }
      const value = this.dispatch(port, request)
      this.send(port, { kind: 'response', id: request.id, value })
    } catch (error) {
      const id = raw !== null && typeof raw === 'object' && validRevision((raw as { id?: unknown }).id)
        ? (raw as { id: number }).id
        : 0
      this.send(port, { kind: 'error', id, message: error instanceof Error ? error.message : String(error) })
    }
  }

  private dispatch(port: WorkerPortLike, request: WorkerRequest): unknown {
    if (request.kind === 'open') return this.open(port, request.sessionId, request.document)
    const sessionId = this.portSessions.get(port)
    if (sessionId === undefined) throw new Error('connection is not open')
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error('connection is not open')
    switch (request.kind) {
      // The response carries the accepted op back through the requester's
      // ordered-ingress path; only peers need the broadcast copy.
      case 'post-op': return this.postOp(session, request.op, port)
      case 'replace-authoritative': return this.replaceAuthoritative(session, port, request.op, request.document)
      case 'adopt-exclusive':
        if (session.ports.size !== 1) return { kind: 'conflict' }
        return this.replaceAuthoritative(session, port, request.op, request.document)
      case 'fetch-snapshot': return { revision: session.revision, document: session.document }
      case 'fetch-ops':
        if (!validRevision(request.after)) throw new Error('invalid revision')
        return { kind: 'ops', ops: session.ops.filter((op) => op.revision > request.after) }
      case 'put-snapshot': return this.putSnapshot(session, request.revision, request.document)
      case 'presence':
        clone(request.payload)
        if (!isValidActorId(request.actorId)) throw new Error('invalid actor id')
        this.broadcast(session, { kind: 'presence', actorId: request.actorId, payload: request.payload }, port)
        return undefined
      case 'heartbeat': return undefined
      case 'close':
        this.disconnect(port, sessionId, session)
        return undefined
    }
  }

  private open(port: WorkerPortLike, sessionId: string, initial: unknown): unknown {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('invalid session id')
    const previousId = this.portSessions.get(port)
    if (previousId !== undefined && previousId !== sessionId) {
      const previous = this.sessions.get(previousId)
      if (previous !== undefined) this.disconnect(port, previousId, previous)
    }
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      const loaded = loadDocument(initial)
      if (loaded.document === undefined) throw new Error('initial document failed to load')
      session = { document: loaded.document, revision: 0, ops: [], seen: new Map(), ports: new Set() }
      this.sessions.set(sessionId, session)
    }
    session.ports.add(port)
    this.portSessions.set(port, sessionId)
    this.portSeen.set(port, Date.now())
    const descriptor = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      sessionId,
      scope: 'local',
      documentId: sessionId,
      revision: session.revision,
      snapshotRevision: session.revision,
    }
    return { descriptor, snapshot: { revision: session.revision, document: session.document } }
  }

  private disconnect(port: WorkerPortLike, sessionId: string, session: AuthoritySession): void {
    session.ports.delete(port)
    this.portSessions.delete(port)
    this.portSeen.delete(port)
    if (session.ports.size === 0) this.sessions.delete(sessionId)
  }

  private pruneExpiredPorts(except: WorkerPortLike): void {
    const expiredBefore = Date.now() - SharedWorkerDocumentAuthority.PORT_LEASE_MS
    for (const [port, seen] of this.portSeen) {
      if (port === except || seen >= expiredBefore) continue
      const sessionId = this.portSessions.get(port)
      const session = sessionId === undefined ? undefined : this.sessions.get(sessionId)
      if (sessionId !== undefined && session !== undefined) this.disconnect(port, sessionId, session)
      else {
        this.portSeen.delete(port)
        this.portSessions.delete(port)
      }
    }
  }

  private postOp(session: AuthoritySession, op: CollabClientOp, except?: WorkerPortLike): unknown {
    clone(op)
    if (op.protocolVersion !== COLLAB_PROTOCOL_VERSION) {
      return { kind: 'protocol-unsupported', supported: [COLLAB_PROTOCOL_VERSION] }
    }
    const replay = session.seen.get(op.opId)
    if (replay !== undefined) {
      if (
        replay.actorId !== op.actorId ||
        replay.baseRevision !== op.baseRevision ||
        !jsonSameValue(replay.patch as unknown as Json, op.patch as unknown as Json)
      ) return { kind: 'error', message: 'op id was already used for different content' }
      return { kind: 'accepted', op: { ...replay, replayed: true } }
    }
    if (!validRevision(op.baseRevision) || op.baseRevision !== session.revision) {
      return { kind: 'stale-base', revision: session.revision }
    }
    if (typeof op.opId !== 'string' || !op.opId || !isValidActorId(op.actorId)) {
      return { kind: 'error', message: 'invalid op envelope' }
    }
    let document: WorkflowDocument
    try {
      document = applyOps(session.document as unknown as Json, op.patch) as unknown as WorkflowDocument
      if (errors(document)) throw new Error('document invariants failed')
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    const accepted: CollabServerOp = {
      opId: op.opId,
      actorId: op.actorId,
      baseRevision: session.revision,
      revision: session.revision + 1,
      patch: clone(op.patch),
      timestamp: Date.now(),
    }
    session.document = document
    session.revision = accepted.revision
    session.ops.push(accepted)
    session.seen.set(accepted.opId, accepted)
    this.broadcast(session, { kind: 'op', op: accepted }, except)
    return { kind: 'accepted', op: accepted }
  }

  private replaceAuthoritative(session: AuthoritySession, port: WorkerPortLike, op: CollabClientOp, raw: unknown): unknown {
    if (!validRevision(op.baseRevision) || op.baseRevision !== session.revision) {
      return this.postOp(session, op, port)
    }
    const loaded = loadDocument(raw)
    if (loaded.document === undefined) return { kind: 'error', message: 'document failed to load' }
    try {
      const applied = applyOps(session.document as unknown as Json, op.patch) as unknown as WorkflowDocument
      if (!jsonSameValue(applied as unknown as Json, loaded.document as unknown as Json)) {
        return { kind: 'error', message: 'authoritative replacement patch does not match its document' }
      }
    } catch (error) {
      return { kind: 'error', message: error instanceof Error ? error.message : String(error) }
    }
    return this.postOp(session, op, port)
  }

  private putSnapshot(session: AuthoritySession, revision: number, raw: unknown): unknown {
    if (!validRevision(revision) || revision !== session.revision) return { kind: 'conflict' }
    const loaded = loadDocument(raw)
    if (loaded.document === undefined || JSON.stringify(loaded.document) !== JSON.stringify(session.document)) {
      return { kind: 'conflict' }
    }
    return { kind: 'ok' }
  }

  private broadcast(session: AuthoritySession, event: CollabConnectionEvent, except?: WorkerPortLike): void {
    for (const port of session.ports) if (port !== except) this.send(port, { kind: 'event', event })
  }

  private send(port: WorkerPortLike, message: WorkerResponse): void {
    port.postMessage(clone(message))
  }
}
