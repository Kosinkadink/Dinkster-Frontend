import type { Json } from '../format/document.js'
import { diag } from '../diagnostics.js'
import { isValidActorId } from '../ids.js'
import { createSignal, type ReadonlySignal, type Signal } from '../reactive/signal.js'
import {
  COLLAB_PROTOCOL_VERSION,
  isValidCollabRevision,
  validateCollabDescriptor,
  validateCollabServerOp,
  type CollabConnection,
  type CollabConnectionEvent,
  type CollabServerOp,
} from '../commands/collab-protocol.js'
import { applyOps, applyOwnedOps, getAtPath, type PatchOp } from '../commands/patch.js'
import { toWirePatch } from '../commands/session.js'
import { jsonSameValue } from '../commands/store.js'
import {
  planImageDocumentCommand,
  type ImageDocumentCommandInvocation,
  type ImageDocumentCommandPlan,
} from './commands.js'
import { loadImageDocument } from './migrate.js'
import type { ImageDocument } from './model.js'
import type {
  ImageDocumentSession,
  ImageDocumentSessionOp,
} from './session.js'
import type {
  ImageDocumentCommitPolicy,
  ImageDocumentDispatchOutcome,
  PreparedImageDocumentDispatch,
} from './store.js'

export type SharedImageDocumentStatus = 'live' | 'catching-up' | 'closed' | 'error'

const initialAdmission = Symbol('ImageDocument initial admission')

export interface SharedImageDocumentConflict {
  readonly origin: string
  readonly message: string
}

export interface SharedImageDocumentSessionOptions {
  readonly actorId?: string
  readonly maxUndo?: number
  readonly clock?: () => number
  readonly retryDelay?: () => Promise<void>
  readonly onConflict?: (conflict: SharedImageDocumentConflict) => void
  readonly onError?: (message: string) => void
  readonly validateCommit?: ImageDocumentCommitPolicy
  readonly beforeRemoteDocument?: (
    document: ImageDocument,
    revision: number,
    currentDocument: ImageDocument,
    resourceDigests: readonly string[],
    retainedDocuments: readonly ImageDocument[],
  ) => Promise<void>
}

interface HistoryRecord {
  forward: readonly PatchOp[]
  inverse: readonly PatchOp[]
  resources: ReadonlySet<string>
}

interface Attempt {
  readonly opId: string
  readonly baseRevision: number
  readonly patch: ReturnType<typeof toWirePatch>
}

type PendingIntention =
  | { readonly kind: 'command'; readonly invocation: ImageDocumentCommandInvocation }
  | { readonly kind: 'patch'; readonly operations: readonly PatchOp[] }

interface PendingEntry {
  opId: string
  readonly intention: PendingIntention
  readonly origin: string
  predicted: ReturnType<typeof toWirePatch>
  readonly attempts: Attempt[]
  record?: HistoryRecord
}

const defaultActorId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `a${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffffff).toString(36)}`

function loadedDocument(value: unknown, context: string): ImageDocument {
  const loaded = loadImageDocument(value)
  if (loaded.document !== undefined) return loaded.document
  const problem = loaded.diagnostics.find((diagnostic) => diagnostic.severity === 'error')
  throw new Error(`${context}: ${problem?.message ?? 'invalid ImageDocument'}`)
}

function applyWire(document: ImageDocument, patch: CollabServerOp['patch'], context: string): ImageDocument {
  return loadedDocument(applyOps(document as unknown as Json, patch), context)
}

function resourceDigests(document: ImageDocument): Set<string> {
  return new Set(Object.values(document.resources)
    .filter((resource) => resource.inline === undefined).map((resource) => resource.digest))
}

function changedResourceDigests(before: ImageDocument, after: ImageDocument): Set<string> {
  const left = resourceDigests(before)
  const right = resourceDigests(after)
  return new Set([...left].filter((digest) => !right.has(digest)).concat(
    [...right].filter((digest) => !left.has(digest)),
  ))
}

function replayImageHistory(
  document: ImageDocument,
  operations: readonly PatchOp[],
): { readonly document: ImageDocument; readonly applied: readonly PatchOp[]; readonly stale?: PatchOp } {
  let current = document as unknown as Json
  const applied: PatchOp[] = []
  for (const operation of operations) {
    const value = getAtPath(current, operation.path)
    const matches = operation.op === 'add'
      ? value === undefined
      : value !== undefined && jsonSameValue(value, operation.oldValue)
    if (!matches) return { document: loadedDocument(current, 'image history'), applied, stale: operation }
    current = applyOwnedOps(current, [operation])
    applied.push(operation)
  }
  return { document: loadedDocument(current, 'image history'), applied }
}

export class SharedImageDocumentSession implements ImageDocumentSession {
  readonly actorId: string
  readonly status: ReadonlySignal<SharedImageDocumentStatus>

  private readonly connection: CollabConnection
  private readonly clock: () => number
  private readonly retryDelay: () => Promise<void>
  private readonly onConflict: ((conflict: SharedImageDocumentConflict) => void) | undefined
  private readonly onError: ((message: string) => void) | undefined
  private readonly validateCommit: ImageDocumentCommitPolicy | undefined
  private readonly beforeRemoteDocument: SharedImageDocumentSessionOptions['beforeRemoteDocument']
  private readonly maxUndo: number
  private readonly documentSignal: Signal<ImageDocument>
  private readonly statusSignal: Signal<SharedImageDocumentStatus>
  private readonly listeners = new Set<(operation: ImageDocumentSessionOp) => void>()
  private readonly presenceListeners = new Set<(actorId: string, payload?: Json) => void>()
  private unsubscribe: (() => void) | undefined

  private confirmed: ImageDocument
  private confirmedRevision: number
  private optimistic: ImageDocument
  private readonly pending: PendingEntry[] = []
  private readonly undoStack: HistoryRecord[] = []
  private readonly redoStack: HistoryRecord[] = []
  private readonly retained = new Set<string>()
  private generation = 0
  private connectionGeneration = 0
  private opCounter = 0
  private readonly opNonce = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`
  private pumpPromise: Promise<void> | undefined
  private syncPromise: Promise<void> | undefined
  private syncing = false
  private syncTarget = 0
  private resyncRequested = false
  private connected = false
  private lastSnapshotRevision: number

  constructor(
    connection: CollabConnection,
    snapshot: ImageDocument,
    snapshotRevision: number,
    options?: SharedImageDocumentSessionOptions,
    admission?: { readonly token: typeof initialAdmission; readonly revision: number },
  ) {
    if (options?.beforeRemoteDocument !== undefined && admission?.token !== initialAdmission) {
      throw new Error('ImageDocument remote admission requires connectSharedImageDocumentSession')
    }
    this.connection = connection
    this.actorId = options?.actorId ?? defaultActorId()
    if (!isValidActorId(this.actorId)) throw new Error('invalid ImageDocument collaboration actor id')
    if (!isValidCollabRevision(snapshotRevision)) throw new Error('invalid ImageDocument snapshot revision')
    this.clock = options?.clock ?? Date.now
    this.retryDelay = options?.retryDelay ?? (() => new Promise((resolve) => setTimeout(resolve, 1000)))
    this.onConflict = options?.onConflict
    this.onError = options?.onError
    this.validateCommit = options?.validateCommit
    this.beforeRemoteDocument = options?.beforeRemoteDocument
    this.maxUndo = options?.maxUndo ?? 200
    if (!Number.isSafeInteger(this.maxUndo) || this.maxUndo < 0) throw new Error('maxUndo must be a non-negative safe integer')
    this.confirmed = loadedDocument(snapshot, 'collab snapshot')
    const refusal = this.validateCommit?.(this.confirmed, this.confirmed,
      Object.freeze([...resourceDigests(this.confirmed)].sort()))
      .find((diagnostic) => diagnostic.severity === 'error')
    if (refusal !== undefined) throw new Error(refusal.message)
    this.confirmedRevision = snapshotRevision
    this.optimistic = this.confirmed
    this.lastSnapshotRevision = snapshotRevision
    this.documentSignal = createSignal(this.optimistic)
    this.statusSignal = createSignal<SharedImageDocumentStatus>('live')
    this.status = this.statusSignal
    this.unsubscribe = connection.onEvent((event) => this.handleEvent(event))
    if (this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') {
      const unsubscribe = this.unsubscribe
      this.unsubscribe = undefined
      unsubscribe()
    }
    if (admission !== undefined && admission.revision > snapshotRevision) this.requestCatchUp(admission.revision)
  }

  get doc(): ImageDocument { return this.optimistic }
  get document(): ReadonlySignal<ImageDocument> { return this.documentSignal }
  get revision(): number { return this.confirmedRevision + this.pending.length }
  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  dispatch(invocation: ImageDocumentCommandInvocation): ImageDocumentDispatchOutcome {
    const prepared = this.prepareDispatch(invocation)
    return prepared.ok ? prepared.commit() : prepared
  }

  prepareDispatch(invocation: ImageDocumentCommandInvocation): PreparedImageDocumentDispatch {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') {
      return {
        ok: false,
        diagnostics: [{
          severity: 'error',
          origin: 'command',
          code: 'image.session.unavailable',
          message: `ImageDocument session is ${status}`,
        }],
      }
    }
    const stamped = { ...invocation, actor: this.actorId } as ImageDocumentCommandInvocation
    const result = planImageDocumentCommand(this.optimistic, stamped)
    if (!result.ok) return result
    const record: HistoryRecord = {
      forward: result.plan.redo,
      inverse: result.plan.inverse,
      resources: changedResourceDigests(this.optimistic, result.plan.document),
    }
    const undo = [...this.undoStack, record]
    if (undo.length > this.maxUndo) undo.shift()
    return this.prepare(result.plan.document, undo, [],
      { kind: 'command', invocation: result.plan.invocation }, result.plan.invocation,
      result.plan.forward, result.plan.inverse, record, result.plan.created)
  }

  prepareUndo(): PreparedImageDocumentDispatch { return this.prepareHistory('undo') }
  prepareRedo(): PreparedImageDocumentDispatch { return this.prepareHistory('redo') }
  undo(): boolean {
    const prepared = this.prepareUndo()
    if (!prepared.ok && prepared.diagnostics[0]?.code === 'image.history.conflict') {
      this.notifyConflict('image.undo', new Error(prepared.diagnostics[0].message))
    }
    return prepared.ok && prepared.commit().ok
  }
  redo(): boolean {
    const prepared = this.prepareRedo()
    if (!prepared.ok && prepared.diagnostics[0]?.code === 'image.history.conflict') {
      this.notifyConflict('image.redo', new Error(prepared.diagnostics[0].message))
    }
    return prepared.ok && prepared.commit().ok
  }

  clearHistory(): void {
    this.generation += 1
    this.undoStack.length = 0
    this.redoStack.length = 0
    this.retained.clear()
  }

  retainedResourceDigests(): ReadonlySet<string> {
    return this.resources(this.optimistic, [...this.undoStack, ...this.redoStack])
  }

  onOp(listener: (operation: ImageDocumentSessionOp) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onPresence(listener: (actorId: string, payload?: Json) => void): () => void {
    this.presenceListeners.add(listener)
    return () => this.presenceListeners.delete(listener)
  }

  sendPresence(payload: Json): void { this.connection.sendPresence(payload) }

  async settle(): Promise<void> {
    while (this.pumpPromise !== undefined || this.syncPromise !== undefined) {
      await (this.pumpPromise ?? this.syncPromise)
    }
  }

  close(): void {
    this.generation += 1
    const unsubscribe = this.unsubscribe
    this.unsubscribe = undefined
    unsubscribe?.()
    if (this.connected && this.pending.length === 0 && this.confirmedRevision > this.lastSnapshotRevision) {
      void this.connection.putSnapshot(this.confirmedRevision, this.confirmed).catch(() => undefined)
    }
    this.connection.close()
    this.connected = false
    this.statusSignal.set('closed')
  }

  private prepareHistory(direction: 'undo' | 'redo'): PreparedImageDocumentDispatch {
    const from = direction === 'undo' ? this.undoStack : this.redoStack
    const to = direction === 'undo' ? this.redoStack : this.undoStack
    const record = from.at(-1)
    if (record === undefined) return { ok: false, diagnostics: [] }
    const operations = direction === 'undo' ? record.inverse : record.forward
    try {
      const replay = replayImageHistory(this.optimistic, operations)
      if (replay.stale !== undefined) throw new Error(`conflict at ${replay.stale.path.join('/')}`)
      const undo = direction === 'undo' ? from.slice(0, -1) : [...to, record]
      const redo = direction === 'redo' ? from.slice(0, -1) : [...to, record]
      return this.prepare(replay.document, undo, redo, { kind: 'patch', operations },
        { command: `image.${direction}` }, replay.applied,
        direction === 'undo' ? record.forward : record.inverse, record)
    } catch (error) {
      return { ok: false, diagnostics: [diag('error', 'command', 'image.history.conflict',
        error instanceof Error ? error.message : String(error))] }
    }
  }

  private resources(document: ImageDocument, history: readonly HistoryRecord[]): Set<string> {
    const digests = new Set([...resourceDigests(document), ...resourceDigests(this.confirmed), ...this.retained])
    for (const record of history) for (const digest of record.resources) digests.add(digest)
    for (const entry of this.pending) {
      if (entry.record !== undefined) for (const digest of entry.record.resources) digests.add(digest)
    }
    return digests
  }

  private prepare(
    document: ImageDocument,
    undo: readonly HistoryRecord[],
    redo: readonly HistoryRecord[],
    intention: PendingIntention,
    invocation: ImageDocumentCommandPlan['invocation'] | { readonly command: 'image.undo' | 'image.redo' },
    forward: readonly PatchOp[],
    inverse: readonly PatchOp[],
    record: HistoryRecord,
    created?: ImageDocumentCommandPlan['created'],
  ): PreparedImageDocumentDispatch {
    const generation = this.generation
    const current = this.optimistic
    const digests = Object.freeze([...this.resources(document, [...undo, ...redo])].sort())
    let consumed = false
    const stale = (): ImageDocumentDispatchOutcome => ({ ok: false, diagnostics: [diag(
      'error', 'command', 'image.candidate.stale', 'Prepared ImageDocument change is stale or already consumed',
    )] })
    return Object.freeze({
      ok: true,
      currentDocument: current,
      document,
      currentResourceDigests: Object.freeze([...this.retainedResourceDigests()].sort()),
      resourceDigests: digests,
      commit: (): ImageDocumentDispatchOutcome => {
        const status = this.statusSignal.get()
        if (consumed || generation !== this.generation || status === 'closed' || status === 'error') return stale()
        consumed = true
        const diagnostics = this.validateCommit?.(current, document, digests) ?? []
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { ok: false, diagnostics }
        if (generation !== this.generation) return stale()
        this.generation += 1
        this.retainedAdd(changedResourceDigests(current, document))
        this.optimistic = document
        this.undoStack.splice(0, this.undoStack.length, ...undo)
        this.redoStack.splice(0, this.redoStack.length, ...redo)
        this.pending.push({
          opId: this.mintOpId(), intention, origin: invocation.command,
          predicted: toWirePatch(forward), attempts: [], record,
        })
        const revision = this.revision
        this.documentSignal.set(document)
        this.pump()
        return { ok: true, document, revision,
          transaction: { revision, invocation, forward, inverse, timestamp: this.clock() },
          ...(created !== undefined ? { created } : {}) }
      },
    })
  }

  private mintOpId(): string {
    this.opCounter += 1
    return `${this.actorId}#${this.opNonce}#${this.opCounter}`
  }

  private pump(): void {
    if (this.pumpPromise !== undefined || this.syncing || this.statusSignal.get() !== 'live') return
    this.pumpPromise = Promise.resolve()
      .then(() => this.pumpLoop())
      .finally(() => {
        this.pumpPromise = undefined
        if (this.pending.length > 0 && !this.syncing && this.statusSignal.get() === 'live') this.pump()
      })
  }

  private async pumpLoop(): Promise<void> {
    while (this.pending.length > 0 && !this.syncing && this.statusSignal.get() === 'live') {
      const head = this.pending[0]!
      const attempt: Attempt = {
        opId: head.opId,
        baseRevision: this.confirmedRevision,
        patch: head.predicted,
      }
      if (!head.attempts.some((candidate) => candidate.opId === attempt.opId)) head.attempts.push(attempt)
      const outcome = await this.connection.postOp({
        protocolVersion: COLLAB_PROTOCOL_VERSION,
        opId: attempt.opId,
        actorId: this.actorId,
        baseRevision: attempt.baseRevision,
        patch: attempt.patch,
      }).catch((error: unknown) => ({
        kind: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
      }))
      if (this.statusSignal.get() !== 'live') return
      if (outcome.kind === 'accepted') {
        const invalid = validateCollabServerOp(outcome.op)
        if (invalid !== null) {
          this.requestResync(`accepted op is invalid: ${invalid}`)
          return
        }
        if (
          outcome.op.actorId !== this.actorId ||
          outcome.op.opId !== attempt.opId ||
          outcome.op.baseRevision !== attempt.baseRevision ||
          !jsonSameValue(outcome.op.patch as unknown as Json, attempt.patch as unknown as Json)
        ) {
          this.requestResync('accepted op differs from the submitted operation')
          return
        }
        this.handleServerOp(outcome.op)
        continue
      }
      if (outcome.kind === 'stale-base') {
        const attemptIndex = head.attempts.indexOf(attempt)
        if (attemptIndex !== -1) head.attempts.splice(attemptIndex, 1)
        this.requestCatchUp(outcome.revision)
        return
      }
      if (outcome.kind === 'snapshot-required') {
        const result = await this.connection.putSnapshot(this.confirmedRevision, this.confirmed)
          .catch(() => undefined)
        if (result === undefined) {
          await this.retryDelay()
          continue
        }
        if (result.kind === 'ok') this.lastSnapshotRevision = this.confirmedRevision
        else {
          const snapshot = await this.connection.fetchSnapshot().catch(() => undefined)
          if (snapshot !== undefined && isValidCollabRevision(snapshot.revision)) {
            this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, snapshot.revision)
          }
          await this.retryDelay()
        }
        continue
      }
      if (outcome.kind === 'protocol-unsupported') {
        this.fail(`protocol version ${COLLAB_PROTOCOL_VERSION} unsupported`)
        return
      }
      await this.retryDelay()
    }
  }

  private handleEvent(event: CollabConnectionEvent): void {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') return
    switch (event.kind) {
      case 'connected': {
        const invalid = validateCollabDescriptor(event.descriptor, this.connection.sessionId, 'image')
        if (invalid !== null) this.fail(invalid)
        else {
          this.connected = true
          this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, event.descriptor.snapshotRevision)
          if (event.descriptor.revision > this.confirmedRevision) {
            this.requestCatchUp(event.descriptor.revision)
          }
        }
        return
      }
      case 'disconnected':
        this.generation += 1
        this.connectionGeneration += 1
        this.connected = false
        return
      case 'session-closed':
        this.connected = false
        this.close()
        return
      case 'presence':
        if (!isValidActorId(event.actorId)) return
        for (const listener of [...this.presenceListeners]) {
          try { listener(event.actorId, event.payload) } catch { /* observers do not own session state */ }
        }
        return
      case 'op': {
        const invalid = validateCollabServerOp(event.op)
        if (invalid !== null) this.requestResync(invalid)
        else this.handleServerOp(event.op)
      }
    }
  }

  private handleServerOp(operation: CollabServerOp): void {
    if (operation.revision <= this.confirmedRevision) return
    if (this.beforeRemoteDocument !== undefined || operation.revision > this.confirmedRevision + 1) {
      this.requestCatchUp(operation.revision)
      return
    }
    try {
      this.ingestOrdered(operation)
    } catch (error) {
      this.requestResync(error instanceof Error ? error.message : String(error))
      return
    }
    this.pump()
    this.publishCheckpoint()
  }

  private publishCheckpoint(): void {
    if (this.confirmedRevision - this.lastSnapshotRevision >= 128 && this.pending.length === 0) {
      const revision = this.confirmedRevision
      void this.connection.putSnapshot(revision, this.confirmed).then((result) => {
        if (result.kind === 'ok') this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, revision)
        else void this.connection.fetchSnapshot().then((snapshot) => {
          if (isValidCollabRevision(snapshot.revision)) {
            this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, snapshot.revision)
          }
        }).catch(() => undefined)
      }).catch(() => undefined)
    }
  }

  private ingestOrdered(operation: CollabServerOp): void {
    if (operation.revision !== this.confirmedRevision + 1) throw new Error('collab operation is not contiguous')
    this.prepareRemote(applyWire(this.confirmed, operation.patch, 'collab operation'), operation.revision, operation).commit()
  }

  private prepareRemote(document: ImageDocument, revision: number, operation?: CollabServerOp) {
    const generation = this.generation
    const records = new Map<HistoryRecord, HistoryRecord>()
    const copyRecord = (record: HistoryRecord): HistoryRecord => {
      let copy = records.get(record)
      if (copy === undefined) {
        copy = { ...record, resources: new Set(record.resources) }
        records.set(record, copy)
      }
      return copy
    }
    let undo = this.undoStack.map(copyRecord)
    let redo = this.redoStack.map(copyRecord)
    let pending = this.pending.map((entry) => ({ ...entry, attempts: [...entry.attempts],
      ...(entry.record !== undefined ? { record: copyRecord(entry.record) } : {}) }))
    const conflicts: SharedImageDocumentConflict[] = []
    const removeHistory = (record: HistoryRecord): void => {
      undo = undo.filter((item) => item !== record)
      redo = redo.filter((item) => item !== record)
    }
    let origin = 'remote'
    if (operation !== undefined) {
      const pendingIndex = pending.findIndex((entry) =>
        entry.attempts.some((attempt) => attempt.opId === operation.opId &&
          attempt.baseRevision === operation.baseRevision &&
          jsonSameValue(attempt.patch as unknown as Json, operation.patch as unknown as Json)))
      if (pendingIndex !== -1) {
        const [confirmed] = pending.splice(pendingIndex, 1)
        origin = confirmed!.origin
        if (pendingIndex !== 0 && confirmed!.record !== undefined) removeHistory(confirmed!.record)
      } else if (operation.actorId === this.actorId &&
        pending.some((entry) => entry.attempts.some((attempt) => attempt.opId === operation.opId))) {
        throw new Error('own collab operation payload changed')
      }
    } else {
      pending = pending.filter((entry) => {
        if (!entry.attempts.some((attempt) => attempt.baseRevision < revision)) return true
        conflicts.push({ origin: entry.origin, message: 'a checkpoint may already contain this submitted edit' })
        return false
      })
      undo = []
      redo = []
    }
    const survivors: PendingEntry[] = []
    const retainedDocuments = [this.confirmed, this.optimistic, document]
    let cursor = document
    for (const entry of pending) {
      try {
        let patch: readonly PatchOp[]
        let next: ImageDocument
        if (entry.intention.kind === 'command') {
          const result = planImageDocumentCommand(cursor, entry.intention.invocation)
          if (!result.ok) throw new Error(result.diagnostics[0]?.message ?? 'command no longer applies')
          patch = result.plan.forward
          next = result.plan.document
          if (entry.record !== undefined) {
            entry.record.forward = result.plan.redo
            entry.record.inverse = result.plan.inverse
          }
        } else {
          const replay = replayImageHistory(cursor, entry.intention.operations)
          if (replay.stale !== undefined) throw new Error(`conflict at ${replay.stale.path.join('/')}`)
          patch = replay.applied
          next = replay.document
        }
        entry.predicted = toWirePatch(patch)
        entry.attempts.splice(0, entry.attempts.length,
          ...entry.attempts.filter((attempt) => attempt.baseRevision >= revision))
        if (entry.record !== undefined) {
          entry.record.resources = new Set([...entry.record.resources, ...changedResourceDigests(cursor, next)])
        }
        cursor = next
        retainedDocuments.push(cursor)
        survivors.push(entry)
      } catch (error) {
        if (entry.record !== undefined) removeHistory(entry.record)
        conflicts.push({ origin: entry.origin, message: error instanceof Error ? error.message : String(error) })
      }
    }
    const digests = this.resources(cursor, [...undo, ...redo])
    for (const retained of retainedDocuments) for (const digest of resourceDigests(retained)) digests.add(digest)
    let consumed = false
    return {
      document: cursor,
      resourceDigests: Object.freeze([...digests].sort()),
      retainedDocuments: Object.freeze(retainedDocuments),
      commit: (): boolean => {
        if (consumed || generation !== this.generation || this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return false
        consumed = true
        this.generation += 1
        this.confirmed = document
        this.confirmedRevision = revision
        for (const entry of survivors) entry.opId = this.mintOpId()
        this.pending.splice(0, this.pending.length, ...survivors)
        this.undoStack.splice(0, this.undoStack.length, ...undo)
        this.redoStack.splice(0, this.redoStack.length, ...redo)
        this.optimistic = cursor
        this.documentSignal.set(cursor)
        for (const conflict of conflicts) this.notifyConflict(conflict.origin, new Error(conflict.message))
        if (operation !== undefined) this.emitOperation(operation, origin)
        return true
      },
    }
  }

  private requestCatchUp(target: number): void {
    if (target > this.syncTarget) this.syncTarget = target
    this.startSync()
  }

  private requestResync(reason: string): void {
    this.generation += 1
    this.notifyConflict('resync', new Error(reason))
    this.resyncRequested = true
    this.startSync()
  }

  private startSync(): void {
    if (this.syncing || this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return
    this.generation += 1
    this.syncing = true
    this.statusSignal.set('catching-up')
    this.syncPromise = this.syncLoop().catch((error: unknown) => this.fail(
      error instanceof Error ? error.message : String(error),
    )).finally(() => {
      this.syncing = false
      this.syncPromise = undefined
      if (this.statusSignal.get() === 'catching-up') this.statusSignal.set('live')
      if (this.statusSignal.get() === 'live' &&
        (this.resyncRequested || this.confirmedRevision < this.syncTarget)) this.startSync()
      else this.pump()
    })
  }

  private async syncLoop(): Promise<void> {
    const connectionGeneration = this.connectionGeneration
    while (this.statusSignal.get() === 'catching-up') {
      if (this.resyncRequested) {
        this.resyncRequested = false
        const snapshot = await this.connection.fetchSnapshot()
        if (this.statusSignal.get() !== 'catching-up') return
        this.assertRemoteConnection(connectionGeneration)
        if (this.resyncRequested) continue
        if (!isValidCollabRevision(snapshot.revision)) throw new Error('invalid ImageDocument snapshot revision')
        const document = loadedDocument(snapshot.document, 'ImageDocument resync')
        this.syncTarget = Math.max(this.syncTarget, this.confirmedRevision, snapshot.revision)
        if (await this.admitRemote(document, snapshot.revision)) {
          this.lastSnapshotRevision = Math.max(this.lastSnapshotRevision, snapshot.revision)
        }
        continue
      }
      if (this.confirmedRevision >= this.syncTarget) return
      const page = await this.connection.fetchOps(this.confirmedRevision)
      if (this.statusSignal.get() !== 'catching-up') return
      this.assertRemoteConnection(connectionGeneration)
      if (this.resyncRequested) continue
      if (page.kind === 'resync-required') {
        this.resyncRequested = true
        continue
      }
      let progressed = false
      for (const operation of page.ops) {
        if (this.statusSignal.get() !== 'catching-up' || this.resyncRequested) break
        const invalid = validateCollabServerOp(operation)
        if (invalid !== null) throw new Error(invalid)
        if (operation.revision <= this.confirmedRevision) continue
        if (operation.revision !== this.confirmedRevision + 1) {
          this.resyncRequested = true
          break
        }
        const document = applyWire(this.confirmed, operation.patch, 'collab operation')
        if (!await this.admitRemote(document, operation.revision, operation)) break
        this.publishCheckpoint()
        progressed = true
      }
      if (this.statusSignal.get() === 'catching-up' && !progressed && !this.resyncRequested && this.confirmedRevision < this.syncTarget) {
        await this.retryDelay()
      }
    }
  }

  private emitOperation(operation: CollabServerOp, origin: string): void {
    const item: ImageDocumentSessionOp = Object.freeze({ ...operation, origin })
    for (const listener of [...this.listeners]) {
      try { listener(item) } catch { /* observers do not own session state */ }
    }
  }

  private retainedAdd(digests: ReadonlySet<string>): void {
    for (const digest of digests) this.retained.add(digest)
  }

  private async admitRemote(document: ImageDocument, revision: number, operation?: CollabServerOp): Promise<boolean> {
    const connectionGeneration = this.connectionGeneration
    while (this.statusSignal.get() === 'catching-up' && !this.resyncRequested) {
      this.assertRemoteConnection(connectionGeneration)
      const prepared = this.prepareRemote(document, revision, operation)
      if (this.beforeRemoteDocument !== undefined) {
        await this.beforeRemoteDocument(prepared.document, revision, this.optimistic,
          prepared.resourceDigests, prepared.retainedDocuments)
      }
      if (this.statusSignal.get() !== 'catching-up' || this.resyncRequested) return false
      this.assertRemoteConnection(connectionGeneration)
      if (prepared.commit()) return true
    }
    return false
  }

  private assertRemoteConnection(generation: number): void {
    if (this.beforeRemoteDocument !== undefined && (!this.connected || this.connectionGeneration !== generation)) {
      throw new Error('ImageDocument connection changed during remote admission')
    }
  }

  private notifyConflict(origin: string, error: unknown): void {
    try {
      this.onConflict?.({ origin, message: error instanceof Error ? error.message : String(error) })
    } catch { /* observers do not own session state */ }
  }

  private fail(message: string): void {
    const status = this.statusSignal.get()
    if (status === 'closed' || status === 'error') return
    this.generation += 1
    this.statusSignal.set('error')
    this.connected = false
    try { this.onError?.(message) } catch { /* observers do not own session state */ }
  }
}

export async function connectSharedImageDocumentSession(
  connection: CollabConnection,
  descriptor: { readonly documentKind?: string },
  options?: SharedImageDocumentSessionOptions,
): Promise<SharedImageDocumentSession> {
  if ((descriptor.documentKind ?? 'workflow') !== 'image') {
    throw new Error('collaboration session is not an ImageDocument')
  }
  let invalidated = false
  let announcedRevision = 0
  const stop = options?.beforeRemoteDocument === undefined ? () => {} : connection.onEvent((event) => {
    if (event.kind === 'disconnected' || event.kind === 'session-closed') invalidated = true
    if (event.kind === 'op') {
      if (validateCollabServerOp(event.op) !== null) invalidated = true
      else announcedRevision = Math.max(announcedRevision, event.op.revision)
    }
    if (event.kind === 'connected') {
      if (validateCollabDescriptor(event.descriptor, connection.sessionId, 'image') !== null) invalidated = true
      else announcedRevision = Math.max(announcedRevision, event.descriptor.revision)
    }
  })
  try {
    const snapshot = await connection.fetchSnapshot()
    if (!isValidCollabRevision(snapshot.revision)) throw new Error('invalid ImageDocument snapshot revision')
    const document = loadedDocument(snapshot.document, 'collab snapshot')
    await options?.beforeRemoteDocument?.(document, snapshot.revision, document,
      Object.freeze([...resourceDigests(document)].sort()), Object.freeze([document]))
    if (invalidated) throw new Error('ImageDocument connection changed during initial admission')
    const session = new SharedImageDocumentSession(connection, document, snapshot.revision, options,
      { token: initialAdmission, revision: announcedRevision })
    if (invalidated) {
      session.close()
      throw new Error('ImageDocument connection changed during initial admission')
    }
    return session
  } finally {
    stop()
  }
}
