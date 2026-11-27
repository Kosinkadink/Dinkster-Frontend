import { diag } from '../diagnostics.js'
import type { Json } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { isValidActorId, uuidv4 } from '../ids.js'
import { createSignal, type ReadonlySignal } from '../reactive/signal.js'
import {
  COLLAB_PROTOCOL_VERSION, isValidCollabRevision, isValidCollabTitle, validateCollabDescriptor, validateCollabServerOp,
  type CollabConnection, type CollabConnectionEvent, type CollabServerOp, type CollabSessionDescriptor,
} from '../commands/collab-protocol.js'
import { applyOps, applyOwnedOps, getAtPath, invertOps, type PatchOp } from '../commands/patch.js'
import { toWirePatch } from '../commands/session.js'
import { jsonSameValue } from '../commands/store.js'
import { loadBoard, type BoardDocument } from './model.js'
import { BoardStore, planBoardCommand, type BoardCommandInvocation, type BoardDispatchOutcome, type BoardSession } from './store.js'

function ownedInvocation(invocation: BoardCommandInvocation): BoardCommandInvocation {
  const result = ownJson(invocation, { undefinedProps: 'reject' })
  if (!result.ok) throw new Error(result.reason)
  const owned = result.value as unknown as BoardCommandInvocation
  if (owned.command !== 'board.item.add') return owned
  return { ...owned, params: { items: owned.params.items.map((item) => ({
    ...item, id: item.id ?? `${item.kind}-${uuidv4()}`,
  })) } }
}

function loaded(value: unknown): BoardDocument {
  const result = loadBoard(value)
  if (result.document === undefined) throw new Error(result.diagnostics[0]?.message ?? 'invalid Board')
  return result.document
}

function refusal(error: unknown): Extract<BoardDispatchOutcome, { ok: false }> {
  return { ok: false, diagnostics: [diag('error', 'command', 'board.session.conflict',
    error instanceof Error ? error.message : String(error))] }
}

/** Assign identities once, before commands can be retained or replayed. */
class LocalBoardSession extends BoardStore {
  override dispatch(invocation: BoardCommandInvocation): BoardDispatchOutcome {
    try { return super.dispatch(ownedInvocation(invocation)) } catch (error) { return refusal(error) }
  }
}

export function createLocalBoardSession(initial: BoardDocument, maxUndo?: number): BoardSession {
  return new LocalBoardSession(initial, maxUndo)
}

interface HistoryEntry {
  forward: readonly PatchOp[]
  inverse: readonly PatchOp[]
}

interface PendingEntry {
  readonly intention: BoardCommandInvocation | 'undo' | 'redo'
  readonly origin: string
  readonly history: HistoryEntry
  patch: readonly PatchOp[]
  attempt?: { readonly opId: string; readonly baseRevision: number; readonly patch: ReturnType<typeof toWirePatch> }
}

export interface SharedBoardSessionOptions {
  readonly actorId?: string
  readonly maxUndo?: number
  readonly retryDelay?: () => Promise<void>
  readonly onConflict?: (conflict: { readonly origin: string; readonly message: string }) => void
}

/** Preserve foreign order entries; refuse changes to values owned by this history step. */
function replayHistory(document: BoardDocument, operations: readonly PatchOp[]): { document: BoardDocument; operations: readonly PatchOp[] } {
  let cursor = document as unknown as Json
  const applied: PatchOp[] = []
  for (const operation of operations) {
    const current = getAtPath(cursor, operation.path)
    if (operation.op === 'replace' && operation.path.length === 1 && operation.path[0] === 'order' &&
      Array.isArray(current) && Array.isArray(operation.oldValue) && Array.isArray(operation.value)) {
      const before = operation.oldValue as readonly string[]
      const after = operation.value as readonly string[]
      const removed = before.filter((id) => !after.includes(id))
      const inserted = after.filter((id) => !before.includes(id))
      if (removed.some((id) => !current.includes(id)) || inserted.some((id) => current.includes(id))) {
        throw new Error('another edit changed Board order membership')
      }
      const order = (current as string[]).filter((id) => !removed.includes(id))
      for (const id of inserted) {
        const index = after.indexOf(id)
        const next = after.slice(index + 1).find((candidate) => order.includes(candidate))
        const previous = after.slice(0, index).reverse().find((candidate) => order.includes(candidate))
        order.splice(next !== undefined ? order.indexOf(next) : previous !== undefined ? order.indexOf(previous) + 1 : order.length, 0, id)
      }
      const patch: PatchOp = { ...operation, oldValue: current, value: order }
      cursor = applyOwnedOps(cursor, [patch])
      applied.push(patch)
      continue
    }
    if (operation.op === 'add' ? current !== undefined : !jsonSameValue(current, operation.oldValue)) {
      throw new Error(`another edit changed ${operation.path.join('/')}`)
    }
    cursor = applyOwnedOps(cursor, [operation])
    applied.push(operation)
  }
  return { document: loaded(cursor), operations: applied }
}

export class SharedBoardSession implements BoardSession {
  readonly actorId: string
  private readonly documentSignal
  private readonly titleSignal = createSignal<string | undefined>(undefined)
  private readonly canEditSignal = createSignal(false)
  private readonly statusSignal = createSignal<'live' | 'catching-up' | 'closed' | 'error'>('live')
  readonly status = this.statusSignal as ReadonlySignal<'live' | 'catching-up' | 'closed' | 'error'>
  private confirmed: BoardDocument
  private confirmedRevision: number
  private readonly pending: PendingEntry[] = []
  private readonly confirmedUndoStack: HistoryEntry[] = []
  private readonly confirmedRedoStack: HistoryEntry[] = []
  private readonly undoStack: HistoryEntry[] = []
  private readonly redoStack: HistoryEntry[] = []
  private readonly maxUndo: number
  private readonly nonce = uuidv4()
  private counter = 0
  private target: number
  private resync = false
  private connected = true
  private work: Promise<void> | undefined
  private unsubscribe: (() => void) | undefined

  constructor(
    private readonly connection: CollabConnection,
    snapshot: unknown,
    revision: number,
    private readonly descriptor: CollabSessionDescriptor,
    private readonly options: SharedBoardSessionOptions = {},
    initialEvents: readonly CollabConnectionEvent[] = [],
  ) {
    const invalid = validateCollabDescriptor(descriptor, connection.sessionId, 'board')
    if (invalid !== null) throw new Error(invalid)
    if (!isValidCollabRevision(revision)) throw new Error('invalid Board snapshot revision')
    this.actorId = options.actorId ?? uuidv4()
    if (!isValidActorId(this.actorId)) throw new Error('invalid Board actor id')
    this.maxUndo = options.maxUndo ?? 200
    if (!Number.isSafeInteger(this.maxUndo) || this.maxUndo < 0) throw new Error('invalid maxUndo')
    this.confirmed = loaded(snapshot)
    if (this.confirmed.lineage !== descriptor.documentId) throw new Error('Board document identity mismatch')
    this.confirmedRevision = revision
    this.target = Math.max(revision, descriptor.revision)
    this.documentSignal = createSignal(this.confirmed)
    this.titleSignal.set(descriptor.title)
    this.canEditSignal.set(descriptor.canEdit ?? false)
    this.unsubscribe = connection.onEvent((event) => this.handleEvent(event))
    for (const event of initialEvents) this.handleEvent(event)
    if (this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') {
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
    this.pump()
  }

  get doc(): BoardDocument { return this.documentSignal.get() }
  get document(): ReadonlySignal<BoardDocument> { return this.documentSignal }
  get title(): ReadonlySignal<string | undefined> { return this.titleSignal }
  get canEdit(): ReadonlySignal<boolean> { return this.canEditSignal }
  get revision(): number { return this.confirmedRevision + this.pending.length }
  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  dispatch(invocation: BoardCommandInvocation): BoardDispatchOutcome {
    try {
      this.assertEditable()
      const intention = ownedInvocation(invocation)
      const plan = planBoardCommand(this.doc, intention)
      if (!plan.ok) return plan
      const document = loaded(applyOwnedOps(this.doc as unknown as Json, plan.forward))
      const history = { forward: plan.forward, inverse: invertOps(plan.forward) }
      this.undoStack.push(history)
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
      this.redoStack.length = 0
      this.pending.push({ intention, origin: invocation.command, history, patch: plan.forward })
      this.documentSignal.set(document)
      this.pump()
      return { ok: true, document, revision: this.revision, created: plan.created }
    } catch (error) { return refusal(error) }
  }

  undo(): boolean { return this.history('undo') }
  redo(): boolean { return this.history('redo') }

  private history(direction: 'undo' | 'redo'): boolean {
    const from = direction === 'undo' ? this.undoStack : this.redoStack
    const to = direction === 'undo' ? this.redoStack : this.undoStack
    const history = from.at(-1)
    if (history === undefined) return false
    try {
      this.assertEditable()
      const patch = direction === 'undo' ? history.inverse : history.forward
      const replay = replayHistory(this.doc, patch)
      from.pop()
      to.push(history)
      this.updateHistory(history, direction, replay.operations)
      this.pending.push({ intention: direction, origin: `board.${direction}`, history, patch: replay.operations })
      this.documentSignal.set(replay.document)
      this.pump()
      return true
    } catch (error) {
      this.conflict(`board.${direction}`, error)
      return false
    }
  }

  async settle(): Promise<void> {
    while (this.work !== undefined) await this.work
  }

  close(): void {
    this.canEditSignal.set(false)
    this.statusSignal.set('closed')
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.connection.close()
  }

  private assertEditable(): void {
    if (this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') throw new Error('Board session is unavailable')
  }

  private conflict(origin: string, error: unknown): void {
    try { this.options.onConflict?.({ origin, message: error instanceof Error ? error.message : String(error) }) } catch { /* observers do not own the document */ }
  }

  private handleEvent(event: CollabConnectionEvent): void {
    if (this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return
    if (event.kind === 'connected') {
      const invalid = validateCollabDescriptor(event.descriptor, this.connection.sessionId, 'board')
      if (invalid !== null || event.descriptor.documentId !== this.descriptor.documentId || event.descriptor.scope !== this.descriptor.scope) {
        this.fail(invalid ?? 'Board session identity changed')
        return
      }
      this.connected = true
      this.titleSignal.set(event.descriptor.title)
      this.canEditSignal.set(event.descriptor.canEdit ?? false)
      this.target = Math.max(this.target, event.descriptor.revision)
    } else if (event.kind === 'disconnected') {
      this.connected = false
      this.canEditSignal.set(false)
      this.statusSignal.set('catching-up')
    } else if (event.kind === 'session-title') {
      if (!isValidCollabTitle(event.title)) this.fail('invalid session title')
      else this.titleSignal.set(event.title)
      return
    } else if (event.kind === 'session-permissions') {
      if (typeof event.canEdit !== 'boolean') this.fail('invalid session permission')
      else this.canEditSignal.set(event.canEdit)
      return
    } else if (event.kind === 'session-closed') {
      this.close()
    } else if (event.kind === 'denial') {
      this.fail(event.diagnostic.message)
    } else if (event.kind === 'op') {
      const invalid = validateCollabServerOp(event.op)
      if (invalid !== null) this.resync = true
      else this.target = Math.max(this.target, event.op.revision)
    }
    this.pump()
  }

  private pump(): void {
    if (this.work !== undefined || !this.connected || this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return
    this.work = Promise.resolve().then(() => this.run()).catch((error: unknown) => this.fail(error)).finally(() => {
      this.work = undefined
      if (this.connected && this.statusSignal.get() !== 'closed' && this.statusSignal.get() !== 'error' &&
        (this.pending.length > 0 || this.resync || this.target > this.confirmedRevision)) this.pump()
    })
  }

  private async run(): Promise<void> {
    while (this.connected && this.statusSignal.get() !== 'closed' && this.statusSignal.get() !== 'error') {
      if (this.resync) {
        this.statusSignal.set('catching-up')
        const snapshot = await this.connection.fetchSnapshot()
        if (!this.connected || this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return
        if (!isValidCollabRevision(snapshot.revision) || snapshot.revision < this.confirmedRevision) throw new Error('invalid Board resync revision')
        const document = loaded(snapshot.document)
        if (document.lineage !== this.confirmed.lineage) throw new Error('Board resync identity changed')
        for (const entry of [...this.pending]) {
          if (entry.attempt !== undefined && entry.attempt.baseRevision < snapshot.revision) {
            this.drop(entry, 'checkpoint may already contain this submitted edit')
          }
        }
        this.confirmedUndoStack.length = 0
        this.confirmedRedoStack.length = 0
        this.confirmed = document
        this.confirmedRevision = snapshot.revision
        this.resync = false
        this.rebase()
        continue
      }
      if (this.target > this.confirmedRevision) {
        this.statusSignal.set('catching-up')
        const result = await this.connection.fetchOps(this.confirmedRevision)
        if (!this.connected || this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return
        if (result.kind === 'resync-required') { this.resync = true; continue }
        let progressed = false
        for (const operation of result.ops) {
          const invalid = validateCollabServerOp(operation)
          if (invalid !== null) throw new Error(invalid)
          if (operation.revision <= this.confirmedRevision) continue
          if (operation.revision !== this.confirmedRevision + 1) { this.resync = true; break }
          this.ingest(operation)
          progressed = true
        }
        if (!progressed && !this.resync) await this.retry()
        continue
      }
      this.statusSignal.set('live')
      const entry = this.pending[0]
      if (entry === undefined) return
      const attempt = entry.attempt ?? { opId: `${this.actorId}#${this.nonce}#${++this.counter}`,
        baseRevision: this.confirmedRevision, patch: toWirePatch(entry.patch) }
      entry.attempt = attempt
      const result = await this.connection.postOp({ protocolVersion: COLLAB_PROTOCOL_VERSION, actorId: this.actorId, ...attempt })
        .catch(() => undefined)
      if (this.statusSignal.get() === 'closed' || this.statusSignal.get() === 'error') return
      if (result === undefined || result.kind === 'error' || result.kind === 'rate-limited') { await this.retry(); continue }
      if (result.kind === 'accepted') {
        const operation = result.op
        if (validateCollabServerOp(operation) !== null || operation.opId !== attempt.opId || operation.actorId !== this.actorId ||
          operation.baseRevision !== attempt.baseRevision || !jsonSameValue(operation.patch as unknown as Json, attempt.patch as unknown as Json)) {
          this.resync = true
          continue
        }
        if (operation.revision === this.confirmedRevision + 1) this.ingest(operation)
        else this.target = Math.max(this.target, operation.revision)
      } else if (result.kind === 'stale-base') {
        if (!isValidCollabRevision(result.revision) || result.revision <= this.confirmedRevision) throw new Error('invalid Board stale revision')
        delete entry.attempt
        this.target = Math.max(this.target, result.revision)
      } else if (result.kind === 'snapshot-required') {
        const checkpoint = await this.connection.putSnapshot(this.confirmedRevision, this.confirmed)
        if (checkpoint.kind === 'conflict') this.resync = true
      } else if (result.kind === 'refused') {
        this.drop(entry, result.message)
        this.rebase()
      } else {
        throw new Error(result.kind === 'protocol-unsupported' ? 'Board collaboration protocol unsupported' : result.diagnostic.message)
      }
    }
  }

  private ingest(operation: CollabServerOp): void {
    const document = loaded(applyOps(this.confirmed as unknown as Json, operation.patch))
    if (document.lineage !== this.confirmed.lineage) throw new Error('Board operation changed identity')
    const own = this.pending.find((entry) => entry.attempt?.opId === operation.opId)
    if (own !== undefined) {
      if (operation.actorId !== this.actorId || !jsonSameValue(operation.patch as unknown as Json, own.attempt!.patch as unknown as Json)) {
        throw new Error('Board accepted operation changed')
      }
      this.advanceHistory(own, this.confirmedUndoStack, this.confirmedRedoStack)
      this.updateHistory(own.history, own.intention, own.patch)
      this.pending.splice(this.pending.indexOf(own), 1)
    }
    this.confirmed = document
    this.confirmedRevision = operation.revision
    this.rebase()
  }

  private rebase(): void {
    let cursor = this.confirmed
    this.undoStack.splice(0, this.undoStack.length, ...this.confirmedUndoStack)
    this.redoStack.splice(0, this.redoStack.length, ...this.confirmedRedoStack)
    for (const entry of [...this.pending]) {
      try {
        let document: BoardDocument
        if (typeof entry.intention === 'string') {
          const replay = replayHistory(cursor, entry.intention === 'undo' ? entry.history.inverse : entry.history.forward)
          document = replay.document
          entry.patch = replay.operations
        } else {
          const plan = planBoardCommand(cursor, entry.intention)
          if (!plan.ok) throw new Error(plan.diagnostics[0]?.message ?? 'Board command no longer applies')
          document = loaded(applyOwnedOps(cursor as unknown as Json, plan.forward))
          entry.patch = plan.forward
        }
        this.advanceHistory(entry, this.undoStack, this.redoStack)
        this.updateHistory(entry.history, entry.intention, entry.patch)
        cursor = document
      } catch (error) { this.drop(entry, error) }
    }
    this.documentSignal.set(cursor)
  }

  private drop(entry: PendingEntry, error: unknown): void {
    this.pending.splice(this.pending.indexOf(entry), 1)
    this.conflict(entry.origin, error)
  }

  private advanceHistory(entry: PendingEntry, undo: HistoryEntry[], redo: HistoryEntry[]): void {
    if (typeof entry.intention !== 'string') {
      undo.push(entry.history)
      if (undo.length > this.maxUndo) undo.shift()
      redo.length = 0
      return
    }
    const from = entry.intention === 'undo' ? undo : redo
    const to = entry.intention === 'undo' ? redo : undo
    if (from.at(-1) !== entry.history) throw new Error('Board history action no longer applies')
    from.pop()
    to.push(entry.history)
  }

  private updateHistory(history: HistoryEntry, intention: PendingEntry['intention'], patch: readonly PatchOp[]): void {
    history.forward = intention === 'undo' ? invertOps(patch) : patch
    history.inverse = intention === 'undo' ? patch : invertOps(patch)
  }

  private async retry(): Promise<void> {
    await (this.options.retryDelay?.() ?? new Promise((resolve) => setTimeout(resolve, 1000)))
  }

  private fail(error: unknown): void {
    if (this.statusSignal.get() === 'closed') return
    this.canEditSignal.set(false)
    this.statusSignal.set('error')
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.conflict('session', error)
  }
}

export async function connectSharedBoardSession(
  connection: CollabConnection,
  descriptor: CollabSessionDescriptor,
  options?: SharedBoardSessionOptions,
): Promise<SharedBoardSession> {
  const events: CollabConnectionEvent[] = []
  const stop = connection.onEvent((event) => events.push(event))
  try {
    const snapshot = await connection.fetchSnapshot()
    return new SharedBoardSession(connection, snapshot.document, snapshot.revision, descriptor, options, events)
  } finally { stop() }
}
