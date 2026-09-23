/**
 * The generic local document engine: the ONE state/history implementation
 * for every document kind, parameterized by DocumentTypeAdapter. The
 * workflow DocumentStore compatibility API and kind-specific local session
 * facades delegate here; nothing else owns document state or undo/redo
 * history.
 *
 * Commit protocol per dispatch:
 *   1. the adapter executes the command against the current document
 *   2. adapter error diagnostics or a thrown error reject atomically
 *      (nothing applied)
 *   3. the adapter's checker gates the patched document; error diagnostics
 *      reject with the merged diagnostics
 *   4. commit: bump revision, push the history record, clear the redo
 *      stack, notify subscribers in exact commit order
 *
 * Undo/redo REPLAY recorded patches (never re-run commands), so they are
 * deterministic even if a command implementation changes between versions.
 * Adapters with a replayHistory hook keep allocation cursors monotonic
 * across undo (CO3); adapters without one revalidate each replay through
 * the loader and refuse a replay that violates document invariants.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, WorkflowDocument } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { isValidActorId } from '../ids.js'
import {
  createSignal,
  type ReadonlySignal,
  type Signal,
} from '../reactive/signal.js'
import type {
  CommandInvocation,
  SharedReplayPreparation,
} from './contract.js'
import { applyOwnedOps, toWirePatch, type PatchOp } from './patch.js'
import type {
  HistorySnapshot,
  HistorySnapshotRecord,
  ListenerErrorSink,
} from './store.js'
import type { SessionOp } from './session.js'

export type DocumentCommandOutcome<D> =
  | {
      readonly ok: true
      readonly doc: D
      readonly forward: readonly PatchOp[]
      readonly inverse: readonly PatchOp[]
      readonly diagnostics: readonly Diagnostic[]
      /** History forward patch, when allocation writes must not be replayed. */
      readonly redo?: readonly PatchOp[]
      readonly created?: {
        readonly layerId?: string
        readonly maskId?: string
        readonly resourceId?: string
      }
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

/**
 * What the committing engine's dispatch returns: the adapter's outcome with
 * the commit snapshot added - `document` aliases `doc` (the document as of
 * THIS commit, even when a reentrant listener dispatched again before the
 * result was read) and `revision` is the revision after this commit.
 */
export type LocalDocumentDispatchResult<D> =
  | (Extract<DocumentCommandOutcome<D>, { readonly ok: true }> & {
      readonly document: D
      readonly revision: number
    })
  | Extract<DocumentCommandOutcome<D>, { readonly ok: false }>

/**
 * Pure, process-local document semantics. Patches describe the proposed
 * document; the engine owns their JSON and checks invariants before committing.
 * No adapter owns transport, revisions, or session history.
 */
export interface DocumentTypeAdapter<D = WorkflowDocument> {
  readonly kind: string
  readonly commandIds: ReadonlySet<string>
  load(value: unknown): {
    readonly document?: D
    readonly diagnostics: readonly Diagnostic[]
  }
  check(document: D): readonly Diagnostic[]
  execute(
    document: D,
    invocation: CommandInvocation,
    replay: boolean,
  ): DocumentCommandOutcome<D>
  prepare?(
    document: D,
    invocation: CommandInvocation,
  ): SharedReplayPreparation | undefined
  transform?(
    invocation: CommandInvocation,
    oldDocument: D,
    newDocument: D,
  ): Json | undefined
  /** replay is true when an already-pending history intention rebases. */
  replayHistory?(
    document: D,
    operations: readonly PatchOp[],
    replay?: boolean,
  ): {
    readonly applied: readonly PatchOp[]
    readonly stale?: PatchOp
  }
  /**
   * Trusted local undo/redo replay: the record holds only this session's
   * own commits, so hooks apply document-specific preservation (workflow
   * allocation cursors) without the shared-mode recorded-value
   * preconditions of replayHistory.
   */
  replayLocalHistory?(
    document: D,
    operations: readonly PatchOp[],
  ): {
    readonly applied: readonly PatchOp[]
    readonly stale?: PatchOp
  }
  predictId?(
    document: D,
    actor: string,
    graphId: string,
    prefix: 'n' | 'r',
  ): string | undefined
  resourceDigests?(document: D): ReadonlySet<string>
}

export interface LocalDocumentTypeOperation {
  readonly revision: number
  readonly invocation:
    | CommandInvocation
    | {
        /** '<replayOriginPrefix>.undo' / '.redo' ('document.undo' by default). */
        readonly command: string
        readonly params: null
      }
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
}

/** One history entry: the patches replayed by undo (inverse) and redo (forward). */
export interface LocalDocumentHistoryRecord {
  readonly invocation: CommandInvocation
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  /** Document-type resources whose retention changed with this record. */
  readonly resources?: readonly string[]
  readonly timestamp: number
  /** Revision after the dispatch that authored this record. */
  readonly revision: number
}

/**
 * One committed change, however it happened. `patch` holds the ops actually
 * APPLIED to the document (the record's forward ops for dispatch/redo, its
 * inverse ops for undo, minus any ops skipped by cursor-preserving replay) -
 * events report reality, not the recording. `timestamp` is this commit's
 * own clock reading (an undo/redo commit is later than its record's
 * authoring time); `record.timestamp` stays the authoring time.
 */
export interface LocalDocumentCommitEvent<D> {
  readonly kind: 'dispatch' | 'undo' | 'redo'
  readonly revision: number
  readonly record: LocalDocumentHistoryRecord
  readonly patch: readonly PatchOp[]
  readonly doc: D
  readonly timestamp: number
}

export interface LocalDocumentEngineOptions {
  /** Stable participant identity for the op envelope; validated. */
  readonly actorId?: string
  /** Injectable clock for history-record timestamps. */
  readonly clock?: () => number
  /** Observer-failure sink (CO10); console.error by default. */
  readonly onListenerError?: ListenerErrorSink
  /**
   * Origin namespace for history replays on both op feeds: undo reports
   * '<prefix>.undo', redo '<prefix>.redo' ('document.undo' by default;
   * kind-specific sessions name their own replays, e.g. 'image.undo').
   */
  readonly replayOriginPrefix?: string
  /**
   * Whether the constructor runs the adapter loader over the initial
   * document (default true). The workflow DocumentStore compatibility API
   * passes false: it has always accepted any JSON-valued document here and
   * validated only on dispatch, where the adapter's checker gates results.
   */
  readonly validateInitial?: boolean
}

const defaultSink: ListenerErrorSink = (error, context) => {
  // eslint-disable-next-line no-console
  console.error(`[LocalDocumentEngine] listener threw during ${context}:`, error)
}

/** Local authority for every adapter kind; shared authority uses the same adapter. */
export class LocalDocumentEngine<D> {
  private current: D
  private currentRevision = 0
  private readonly signal: Signal<D>
  private readonly undoStack: LocalDocumentHistoryRecord[] = []
  private readonly redoStack: LocalDocumentHistoryRecord[] = []
  private readonly opListeners = new Set<
    (operation: LocalDocumentTypeOperation) => void
  >()
  private readonly envelopeListeners = new Set<(op: SessionOp) => void>()
  private readonly commitListeners = new Set<
    (event: LocalDocumentCommitEvent<D>) => void
  >()
  /**
   * Reentrancy-safe notification FIFO: a listener may synchronously dispatch
   * again. Without the queue, the nested commit's notifications would
   * OVERTAKE the outer commit's (listeners would see revision 2 before
   * revision 1). Every commit enqueues its event; only the outermost commit
   * drains, so every listener observes documents and events in exact commit
   * order while the nested commit's document is already authoritative.
   */
  private readonly notifyQueue: LocalDocumentCommitEvent<D>[] = []
  private notifying = false
  private opCounter = 0

  readonly actorId: string
  private readonly clock: () => number
  private readonly replayOriginPrefix: string
  private readonly onListenerError: ListenerErrorSink

  constructor(
    initial: D,
    private readonly adapter: DocumentTypeAdapter<D>,
    private readonly maxUndo = 200,
    options?: LocalDocumentEngineOptions,
  ) {
    if (!Number.isSafeInteger(maxUndo) || maxUndo < 0)
      throw new Error('maxUndo must be a non-negative safe integer')
    this.actorId = options?.actorId ?? 'local'
    if (!isValidActorId(this.actorId))
      throw new Error(`invalid ${adapter.kind} document session actor id`)
    this.clock = options?.clock ?? Date.now
    this.replayOriginPrefix = options?.replayOriginPrefix ?? 'document'
    this.onListenerError = options?.onListenerError ?? defaultSink
    if (options?.validateInitial === false) {
      // Ownership boundary (CO1) without shape validation: the workflow
      // DocumentStore has always accepted any JSON-valued document here.
      const owned = ownJson(initial as unknown as Json)
      if (!owned.ok) throw new Error(`initial document is not JSON: ${owned.reason}`)
      this.current = owned.value as D
    } else {
      const loaded = adapter.load(initial)
      if (loaded.document === undefined)
        throw new Error(`initial ${adapter.kind} document is invalid`)
      this.current = loaded.document
    }
    this.signal = createSignal(
      this.current,
      Object.is,
      (error) => this.onListenerError(error, 'document notify'),
    )
  }

  get doc(): D {
    return this.current
  }
  get document(): ReadonlySignal<D> {
    return this.signal
  }
  get revision(): number {
    return this.currentRevision
  }
  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  dispatch(invocation: CommandInvocation): LocalDocumentDispatchResult<D> {
    if (!this.adapter.commandIds.has(invocation.command)) {
      return {
        ok: false,
        diagnostics: [
          diag(
            'error',
            'command',
            'command.unknown',
            `unknown command '${invocation.command}'`,
          ),
        ],
      }
    }
    const ownedInvocation = ownJson(invocation, { undefinedProps: 'reject' })
    if (!ownedInvocation.ok) {
      return {
        ok: false,
        diagnostics: [
          diag(
            'error',
            'command',
            'command.params.notJson',
            ownedInvocation.reason,
          ),
        ],
      }
    }
    try {
      const stamped = ownedInvocation.value as unknown as CommandInvocation
      const outcome = this.adapter.execute(this.current, stamped, false)
      if (!outcome.ok) return outcome
      if (outcome.diagnostics.some((problem) => problem.severity === 'error'))
        // Error diagnostics reject the edit: nothing was applied or committed.
        return { ok: false, diagnostics: outcome.diagnostics }
      const patches = ownJson(
        {
          forward: outcome.forward,
          inverse: outcome.inverse,
          redo: outcome.redo ?? outcome.forward,
        },
        { undefinedProps: 'reject' },
      )
      if (!patches.ok)
        throw new Error(`adapter patches are not JSON: ${patches.reason}`)
      const owned = patches.value as unknown as {
        readonly forward: readonly PatchOp[]
        readonly inverse: readonly PatchOp[]
        readonly redo: readonly PatchOp[]
      }
      if (owned.forward.length === 0)
        return {
          ...outcome,
          doc: this.current,
          document: this.current,
          revision: this.currentRevision,
        }
      const next = applyOwnedOps(this.current as unknown as Json, owned.forward) as unknown as D
      const diagnostics: readonly Diagnostic[] = [
        ...outcome.diagnostics,
        ...this.adapter.check(next),
      ]
      if (diagnostics.some((problem) => problem.severity === 'error'))
        return { ok: false, diagnostics }
      const resources = this.changedResources(this.current, next)
      const revision = this.currentRevision + 1
      const timestamp = this.clock()
      const record: LocalDocumentHistoryRecord = Object.freeze({
        invocation: stamped,
        forward: owned.redo,
        inverse: owned.inverse,
        ...(resources === undefined ? {} : { resources: Object.freeze([...resources]) }),
        timestamp,
        revision,
      })
      this.current = next
      this.undoStack.push(record)
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
      this.redoStack.length = 0
      this.commit({ kind: 'dispatch', revision, record, patch: owned.forward, doc: next, timestamp })
      return {
        ...outcome,
        doc: next,
        document: next,
        revision,
        forward: owned.forward,
        inverse: owned.inverse,
        redo: owned.redo,
        diagnostics,
      }
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          diag(
            'error',
            'command',
            'command.threw',
            `${invocation.command}: ${String(error)}`,
          ),
        ],
      }
    }
  }

  undo(): boolean {
    return this.replay(this.undoStack, this.redoStack, 'undo')
  }
  redo(): boolean {
    return this.replay(this.redoStack, this.undoStack, 'redo')
  }
  clearHistory(): void {
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  retainedResourceDigests(): ReadonlySet<string> {
    const retained = new Set(this.adapter.resourceDigests?.(this.current))
    for (const record of [...this.undoStack, ...this.redoStack]) {
      for (const digest of record.resources ?? []) retained.add(digest)
    }
    return retained
  }

  /**
   * This engine's undo/redo records, oldest first, detached from engine
   * internals, so a same-document session replacement can carry the user's
   * history across the swap (the records stay valid only while the
   * successor's document is identical to this engine's).
   */
  historySnapshot(): HistorySnapshot {
    const detach = (records: readonly LocalDocumentHistoryRecord[]): HistorySnapshotRecord[] =>
      records.map((record) => ({
        forward: record.forward,
        inverse: record.inverse,
        ...(record.resources !== undefined
          ? { resources: Object.freeze([...record.resources]) }
          : {}),
      }))
    return {
      revision: this.currentRevision,
      undo: detach(this.undoStack),
      redo: detach(this.redoStack),
    }
  }

  /** Every committed change (dispatch, undo, redo), invocation-shaped. */
  onOp(listener: (operation: LocalDocumentTypeOperation) => void): () => void {
    this.opListeners.add(listener)
    return () => this.opListeners.delete(listener)
  }

  /**
   * Every committed change as an envelope-shaped op (SessionOp): opId unique
   * per engine, actorId, baseRevision/revision, the WIRE-shaped patch (no
   * local oldValue), and the origin ('<prefix>.undo'/'.redo' for replays).
   */
  onSessionOp(listener: (op: SessionOp) => void): () => void {
    this.envelopeListeners.add(listener)
    return () => this.envelopeListeners.delete(listener)
  }

  /** Every committed change with its full history record and applied patch. */
  onCommit(
    listener: (event: LocalDocumentCommitEvent<D>) => void,
  ): () => void {
    this.commitListeners.add(listener)
    return () => this.commitListeners.delete(listener)
  }

  private replay(
    from: LocalDocumentHistoryRecord[],
    to: LocalDocumentHistoryRecord[],
    kind: 'undo' | 'redo',
  ): boolean {
    const record = from.at(-1)
    if (record === undefined) return false
    const operations = kind === 'undo' ? record.inverse : record.forward
    let doc: D
    let applied: readonly PatchOp[]
    try {
      ;({ doc, applied } = this.replayOperations(this.current, operations))
    } catch {
      return false
    }
    from.pop()
    to.push(record)
    this.current = doc
    const revision = this.currentRevision + 1
    this.commit({ kind, revision, record, patch: applied, doc, timestamp: this.clock() })
    return true
  }

  /**
   * Replay recorded history ops against `document`. Local history is
   * trusted: adapters with a replayLocalHistory hook own document-specific
   * preservation (allocation cursors stay monotonic across undo, CO3)
   * without cross-actor preconditions, because only this session's own
   * commits are in the record. Without the hook, ops replay verbatim
   * through the loader, which refuses a replay that violates document
   * invariants. (Shared sessions use the adapter's replayHistory hook
   * instead: their history can interleave with remote edits, so their
   * replay demands the recorded preconditions and reports conflicts.)
   */
  private replayOperations(
    document: D,
    operations: readonly PatchOp[],
  ): { doc: D; applied: readonly PatchOp[] } {
    if (this.adapter.replayLocalHistory !== undefined) {
      const replayed = this.adapter.replayLocalHistory(document, operations)
      if (replayed.stale !== undefined)
        throw new Error('history replay no longer applies')
      return {
        doc: applyOwnedOps(document as unknown as Json, replayed.applied) as unknown as D,
        applied: replayed.applied,
      }
    }
    const candidate = applyOwnedOps(document as unknown as Json, operations)
    const loaded = this.adapter.load(candidate)
    if (loaded.document === undefined)
      throw new Error(
        `${this.adapter.kind} command violated document invariants`,
      )
    return { doc: loaded.document, applied: operations }
  }

  private changedResources(
    before: D,
    after: D,
  ): ReadonlySet<string> | undefined {
    if (this.adapter.resourceDigests === undefined) return undefined
    const left = this.adapter.resourceDigests(before)
    const right = this.adapter.resourceDigests(after)
    return new Set(
      [...left]
        .filter((digest) => !right.has(digest))
        .concat([...right].filter((digest) => !left.has(digest))),
    )
  }

  private commit(event: LocalDocumentCommitEvent<D>): void {
    // Listeners must never reshape a committed event for later listeners or
    // reach engine internals through it: frozen before first publication.
    const published = Object.freeze(event)
    this.currentRevision = published.revision
    this.notifyQueue.push(published)
    if (this.notifying) return
    this.notifying = true
    try {
      for (let next = this.notifyQueue.shift(); next; next = this.notifyQueue.shift()) {
        this.signal.set(next.doc)
        this.notify(next)
      }
    } finally {
      this.notifying = false
    }
  }

  private notify(event: LocalDocumentCommitEvent<D>): void {
    const origin =
      event.kind === 'dispatch'
        ? event.record.invocation.command
        : `${this.replayOriginPrefix}.${event.kind}`
    const operation: LocalDocumentTypeOperation = Object.freeze({
      revision: event.revision,
      invocation:
        event.kind === 'dispatch'
          ? event.record.invocation
          : { command: origin, params: null },
      forward: event.patch,
      inverse:
        event.kind === 'undo' ? event.record.forward : event.record.inverse,
    })
    this.opCounter += 1
    const envelope: SessionOp = Object.freeze({
      opId: `${this.actorId}#${this.opCounter}`,
      actorId: this.actorId,
      baseRevision: event.revision - 1,
      revision: event.revision,
      // The envelope carries the WIRE shape - never raw PatchOps with their
      // local-only oldValue.
      patch: toWirePatch(event.patch),
      timestamp: event.timestamp,
      origin,
    })
    // CO10: one throwing observer must not starve the rest or unwind into
    // the committed dispatch; a throwing injected sink must not either.
    for (const listener of [...this.opListeners]) {
      try {
        listener(operation)
      } catch (error) {
        this.safeSink(error, 'operation notify')
      }
    }
    for (const listener of [...this.envelopeListeners]) {
      try {
        listener(envelope)
      } catch (error) {
        this.safeSink(error, 'session op notify')
      }
    }
    for (const listener of [...this.commitListeners]) {
      try {
        listener(event)
      } catch (error) {
        this.safeSink(error, 'commit notify')
      }
    }
  }

  private safeSink(error: unknown, context: string): void {
    try {
      this.onListenerError(error, context)
    } catch (sinkError) {
      // eslint-disable-next-line no-console
      console.error('[LocalDocumentEngine] error sink threw:', sinkError)
    }
  }
}
