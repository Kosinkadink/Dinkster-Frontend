import {
  COLLAB_PROTOCOL_VERSION,
  connectSharedSession,
  jsonSameValue,
  type CollabConnection,
  type CollabConnectionEvent,
  type CommandDefinition,
  type Json,
  type SharedDocumentSession,
  type SharedSessionOptions,
  type WirePatchOp,
  type WorkflowDocument,
} from '@dinkster/core'
import { scopedSharedName } from './projects.js'
import type { WorkerPortLike, WorkerRequest, WorkerResponse } from './shared-worker-authority.js'

export type SharedWorkerPortFactory = (sessionId: string) => WorkerPortLike
type RequestWithoutId = WorkerRequest extends infer Request
  ? Request extends { readonly id: number }
    ? Omit<Request, 'id'>
    : never
  : never

const browserPortFactory: SharedWorkerPortFactory = (sessionId) => {
  const worker = new SharedWorker(new URL('./shared-worker-entry.ts', import.meta.url), {
    type: 'module',
    name: scopedSharedName(`dinkster-document-${sessionId}`),
  })
  return worker.port
}

const replacementPatch = (before: unknown, document: WorkflowDocument): WirePatchOp[] => {
  const previous = before as Record<string, Json>
  const next = document as unknown as Record<string, Json>
  const patch: WirePatchOp[] = []
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    const had = Object.hasOwn(previous, key)
    const has = Object.hasOwn(next, key)
    if (had && !has) patch.push({ op: 'remove', path: [key] })
    else if (!had && has) patch.push({ op: 'add', path: [key], value: next[key]! })
    else if (had && has && !jsonSameValue(previous[key]!, next[key]!)) {
      patch.push({ op: 'replace', path: [key], value: next[key]! })
    }
  }
  return patch
}

export class SharedWorkerCollabConnection implements CollabConnection {
  private static readonly REQUEST_TIMEOUT_MS = 15_000
  private static readonly HEARTBEAT_MS = 15_000
  private nextId = 1
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }>()
  private readonly listeners = new Set<(event: CollabConnectionEvent) => void>()
  private readonly bufferedEvents: CollabConnectionEvent[] = []
  private readonly heartbeat: ReturnType<typeof setInterval>
  private closed = false

  private constructor(readonly sessionId: string, private readonly port: WorkerPortLike, private readonly actorId: string) {
    port.addEventListener('message', (event) => this.receive(event.data))
    port.start?.()
    this.heartbeat = setInterval(() => {
      if (!this.closed) void this.request({ kind: 'heartbeat' }).catch(() => undefined)
    }, SharedWorkerCollabConnection.HEARTBEAT_MS)
    ;(this.heartbeat as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()
  }

  static async open(sessionId: string, initial: WorkflowDocument, factory: SharedWorkerPortFactory = browserPortFactory, actorId = 'local'): Promise<SharedWorkerCollabConnection> {
    const connection = new SharedWorkerCollabConnection(sessionId, factory(sessionId), actorId)
    try {
      const opened = await connection.request({ kind: 'open', sessionId, document: initial }) as {
        descriptor: Extract<CollabConnectionEvent, { kind: 'connected' }>['descriptor']
        snapshot: { revision: number; document: unknown }
      }
      connection.snapshot = opened.snapshot
      connection.emit({ kind: 'connected', descriptor: opened.descriptor })
      return connection
    } catch (error) {
      connection.dispose(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
  }

  private snapshot: { revision: number; document: unknown } | undefined

  postOp(op: Parameters<CollabConnection['postOp']>[0]): ReturnType<CollabConnection['postOp']> {
    return this.request({ kind: 'post-op', op }) as ReturnType<CollabConnection['postOp']>
  }
  async fetchSnapshot(): Promise<{ revision: number; document: unknown }> {
    const initial = this.snapshot
    if (initial !== undefined) {
      this.snapshot = undefined
      return initial
    }
    return this.request({ kind: 'fetch-snapshot' }) as Promise<{ revision: number; document: unknown }>
  }
  fetchOps(after: number): ReturnType<CollabConnection['fetchOps']> {
    return this.request({ kind: 'fetch-ops', after }) as ReturnType<CollabConnection['fetchOps']>
  }
  putSnapshot(revision: number, document: WorkflowDocument): ReturnType<CollabConnection['putSnapshot']> {
    return this.request({ kind: 'put-snapshot', revision, document }) as ReturnType<CollabConnection['putSnapshot']>
  }
  async adoptExclusive(document: WorkflowDocument): Promise<boolean> {
    const snapshot = this.snapshot
    if (snapshot === undefined) throw new Error('shared workspace snapshot is unavailable')
    const patch = replacementPatch(snapshot.document, document)
    if (patch.length === 0) return true
    const op = {
      protocolVersion: COLLAB_PROTOCOL_VERSION,
      opId: `${this.actorId}#adopt#${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
      actorId: this.actorId,
      baseRevision: snapshot.revision,
      patch,
    }
    const result = await this.request({ kind: 'adopt-exclusive', op, document }) as
      | { kind: 'accepted'; op: { revision: number } }
      | { kind: 'conflict' }
      | { kind: 'error'; message: string }
    if (result.kind === 'conflict') return false
    if (result.kind === 'error') throw new Error(result.message)
    this.snapshot = { revision: result.op.revision, document }
    return true
  }
  async replaceAuthoritative(document: WorkflowDocument): Promise<void> {
    while (true) {
      const snapshot = this.snapshot
      if (snapshot === undefined) throw new Error('shared workspace snapshot is unavailable')
      const patch = replacementPatch(snapshot.document, document)
      if (patch.length === 0) return
      const op = {
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        opId: `${this.actorId}#replace#${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
        actorId: this.actorId,
        baseRevision: snapshot.revision,
        patch,
      }
      const result = await this.request({ kind: 'replace-authoritative', op, document }) as
        | { kind: 'accepted'; op: { revision: number } }
        | { kind: 'stale-base' }
        | { kind: 'error'; message: string }
        | { kind: 'protocol-unsupported' }
      if (result.kind === 'accepted') {
        this.snapshot = { revision: result.op.revision, document }
        return
      }
      if (result.kind === 'stale-base') {
        this.snapshot = await this.request({ kind: 'fetch-snapshot' }) as { revision: number; document: unknown }
        continue
      }
      if (result.kind === 'error') throw new Error(result.message)
      throw new Error('shared workspace protocol is unsupported')
    }
  }
  sendPresence(payload: Json): void { void this.request({ kind: 'presence', actorId: this.actorId, payload }) }
  onEvent(listener: (event: CollabConnectionEvent) => void): () => void {
    this.listeners.add(listener)
    for (const event of this.bufferedEvents.splice(0)) listener(event)
    return () => this.listeners.delete(listener)
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    void this.request({ kind: 'close' }).finally(() => this.port.close?.())
  }

  private request(request: RequestWithoutId): Promise<unknown> {
    if (this.closed && request.kind !== 'close') return Promise.reject(new Error('shared workspace connection is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.has(id)) return
        this.dispose(new Error(`shared workspace request '${request.kind}' timed out`))
      }, SharedWorkerCollabConnection.REQUEST_TIMEOUT_MS)
      ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()
      this.pending.set(id, { resolve, reject, timeout })
      this.port.postMessage({ ...request, id })
    })
  }
  private receive(raw: unknown): void {
    const message = raw as WorkerResponse
    if (message.kind === 'event') return this.emit(message.event)
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.kind === 'error') pending.reject(new Error(message.message))
    else pending.resolve(message.value)
  }
  private dispose(error: Error): void {
    this.closed = true
    clearInterval(this.heartbeat)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
    this.port.close?.()
  }
  private emit(event: CollabConnectionEvent): void {
    if (this.listeners.size === 0) {
      this.bufferedEvents.push(event)
      return
    }
    for (const listener of [...this.listeners]) listener(event)
  }
}

export async function connectSharedWorkerSession(
  sessionId: string,
  initial: WorkflowDocument,
  commands: ReadonlyMap<string, CommandDefinition>,
  options?: SharedSessionOptions,
  portFactory?: SharedWorkerPortFactory,
  latestInitial?: () => WorkflowDocument | undefined,
  replaceAuthoritative = false,
): Promise<SharedDocumentSession> {
  const connection = await SharedWorkerCollabConnection.open(sessionId, initial, portFactory, options?.actorId)
  let adopted = initial
  if (replaceAuthoritative) {
    const latest = latestInitial?.()
    if (latestInitial === undefined || latest !== undefined) {
      adopted = latest ?? initial
      await connection.replaceAuthoritative(adopted)
    }
  }
  while (latestInitial) {
    const latest = latestInitial()
    if (latest === undefined || latest === adopted) break
    if (replaceAuthoritative) await connection.replaceAuthoritative(latest)
    else if (!await connection.adoptExclusive(latest)) {
      connection.close()
      throw new Error('the workflow changed while another window joined its workspace')
    }
    adopted = latest
  }
  return connectSharedSession(connection, commands, options)
}
