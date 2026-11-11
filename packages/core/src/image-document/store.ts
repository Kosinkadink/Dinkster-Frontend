import { createSignal, type ReadonlySignal } from '../reactive/signal.js'
import type { Json } from '../format/document.js'
import { applyOwnedOps, type PatchOp } from '../commands/patch.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import { planImageDocumentCommand, type ImageDocumentCommandInvocation, type ImageDocumentCommandPlan } from './commands.js'
import { loadImageDocument } from './migrate.js'
import type { ImageDocument } from './model.js'

export interface ImageDocumentTransaction {
  readonly revision: number
  readonly invocation: ImageDocumentCommandInvocation | { readonly command: 'image.undo' | 'image.redo' }
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  readonly timestamp: number
}

export type ImageDocumentDispatchOutcome =
  | {
      readonly ok: true
      readonly document: ImageDocument
      readonly revision: number
      readonly transaction: ImageDocumentTransaction
      readonly created?: ImageDocumentCommandPlan['created']
    }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }

export type PreparedImageDocumentDispatch =
  | Extract<ImageDocumentDispatchOutcome, { readonly ok: false }>
  | {
      readonly ok: true
      readonly currentDocument: ImageDocument
      readonly document: ImageDocument
      readonly currentResourceDigests: readonly string[]
      readonly resourceDigests: readonly string[]
      readonly commit: () => ImageDocumentDispatchOutcome
    }

export type ImageDocumentCommitPolicy = (
  current: ImageDocument,
  candidate: ImageDocument,
  resourceDigests: readonly string[],
) => readonly Diagnostic[]

interface HistoryRecord {
  readonly invocation: ImageDocumentCommandInvocation
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  readonly resources: ReadonlySet<string>
}

const resourceDigests = (document: ImageDocument): Set<string> =>
  new Set(Object.values(document.resources).filter((resource) => resource.inline === undefined).map((resource) => resource.digest))

function changedResources(before: ImageDocument, after: ImageDocument): ReadonlySet<string> {
  const left = resourceDigests(before)
  const right = resourceDigests(after)
  return new Set([...left].filter((digest) => !right.has(digest)).concat([...right].filter((digest) => !left.has(digest))))
}

export class ImageDocumentStore {
  private current: ImageDocument
  private currentRevision = 0
  private generation = 0
  private readonly undoStack: HistoryRecord[] = []
  private readonly redoStack: HistoryRecord[] = []
  private readonly listeners = new Set<(transaction: ImageDocumentTransaction) => void>()
  private readonly signal

  constructor(
    initial: ImageDocument,
    private readonly maxUndo = 200,
    private readonly clock: () => number = Date.now,
    private readonly validateCommit?: ImageDocumentCommitPolicy,
  ) {
    if (!Number.isSafeInteger(maxUndo) || maxUndo < 0) throw new Error('maxUndo must be a non-negative safe integer')
    const loaded = loadImageDocument(initial)
    if (loaded.document === undefined) throw new Error('initial ImageDocument is invalid')
    this.current = loaded.document
    const refusal = this.validateCommit?.(this.current, this.current, Object.freeze([...resourceDigests(this.current)].sort()))
      .find((diagnostic) => diagnostic.severity === 'error')
    if (refusal !== undefined) throw new Error(refusal.message)
    this.signal = createSignal(this.current)
  }

  get doc(): ImageDocument {
    return this.current
  }

  get revision(): number {
    return this.currentRevision
  }

  get document(): ReadonlySignal<ImageDocument> {
    return this.signal
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  prepareDispatch(invocation: unknown): PreparedImageDocumentDispatch {
    const result = planImageDocumentCommand(this.current, invocation)
    if (!result.ok) return result
    const before = this.current
    const record: HistoryRecord = {
      invocation: result.plan.invocation,
      forward: result.plan.redo,
      inverse: result.plan.inverse,
      resources: changedResources(before, result.plan.document),
    }
    const undo = [...this.undoStack, record]
    if (undo.length > this.maxUndo) undo.shift()
    return this.prepare(result.plan.document, undo, [], result.plan.invocation,
      result.plan.forward, result.plan.inverse, result.plan.created)
  }

  dispatch(invocation: unknown): ImageDocumentDispatchOutcome {
    const prepared = this.prepareDispatch(invocation)
    return prepared.ok ? prepared.commit() : prepared
  }

  prepareUndo(): PreparedImageDocumentDispatch {
    const record = this.undoStack.at(-1)
    if (record === undefined) return { ok: false, diagnostics: [] }
    const document = this.replay(record.inverse)
    return this.prepare(document, this.undoStack.slice(0, -1), [...this.redoStack, record],
      { command: 'image.undo' }, record.inverse, record.forward)
  }

  undo(): boolean {
    const prepared = this.prepareUndo()
    return prepared.ok && prepared.commit().ok
  }

  prepareRedo(): PreparedImageDocumentDispatch {
    const record = this.redoStack.at(-1)
    if (record === undefined) return { ok: false, diagnostics: [] }
    const document = this.replay(record.forward)
    return this.prepare(document, [...this.undoStack, record], this.redoStack.slice(0, -1),
      { command: 'image.redo' }, record.forward, record.inverse)
  }

  redo(): boolean {
    const prepared = this.prepareRedo()
    return prepared.ok && prepared.commit().ok
  }

  clearHistory(): void {
    this.generation += 1
    this.undoStack.length = 0
    this.redoStack.length = 0
  }

  retainedResourceDigests(): ReadonlySet<string> {
    return this.resources(this.current, [...this.undoStack, ...this.redoStack])
  }

  private resources(document: ImageDocument, history: readonly HistoryRecord[]): Set<string> {
    const retained = resourceDigests(document)
    for (const record of history) {
      for (const digest of record.resources) retained.add(digest)
    }
    return retained
  }

  private prepare(
    document: ImageDocument,
    undo: readonly HistoryRecord[],
    redo: readonly HistoryRecord[],
    invocation: ImageDocumentTransaction['invocation'],
    forward: readonly PatchOp[],
    inverse: readonly PatchOp[],
    created?: ImageDocumentCommandPlan['created'],
  ): PreparedImageDocumentDispatch {
    const generation = this.generation
    const current = this.current
    const digests = Object.freeze([...this.resources(document, [...undo, ...redo])].sort())
    let consumed = false
    const stale = (): Extract<ImageDocumentDispatchOutcome, { readonly ok: false }> => ({
      ok: false, diagnostics: [diag('error', 'command', 'image.candidate.stale', 'Prepared ImageDocument change is stale or already consumed')],
    })
    return Object.freeze({
      ok: true,
      currentDocument: current,
      document,
      currentResourceDigests: Object.freeze([...this.retainedResourceDigests()].sort()),
      resourceDigests: digests,
      commit: (): ImageDocumentDispatchOutcome => {
        if (consumed || this.generation !== generation) return stale()
        consumed = true
        const diagnostics = this.validateCommit?.(current, document, digests) ?? []
        if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { ok: false, diagnostics }
        if (this.generation !== generation) return stale()
        this.generation += 1
        this.current = document
        this.undoStack.splice(0, this.undoStack.length, ...undo)
        this.redoStack.splice(0, this.redoStack.length, ...redo)
        const transaction = this.commit(invocation, forward, inverse)
        return { ok: true, document, revision: transaction.revision, transaction,
          ...(created !== undefined ? { created } : {}) }
      },
    })
  }

  onTransaction(listener: (transaction: ImageDocumentTransaction) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private replay(operations: readonly PatchOp[]): ImageDocument {
    const candidate = applyOwnedOps(this.current as unknown as Json, operations)
    const loaded = loadImageDocument(candidate)
    if (loaded.document === undefined) throw new Error('ImageDocument history replay violated invariants')
    return loaded.document
  }

  private commit(
    invocation: ImageDocumentTransaction['invocation'],
    forward: readonly PatchOp[],
    inverse: readonly PatchOp[],
  ): ImageDocumentTransaction {
    this.currentRevision += 1
    this.signal.set(this.current)
    const transaction: ImageDocumentTransaction = Object.freeze({
      revision: this.currentRevision,
      invocation,
      forward,
      inverse,
      timestamp: this.clock(),
    })
    for (const listener of this.listeners) {
      try {
        listener(transaction)
      } catch (error) {
        console.error('[ImageDocumentStore] listener threw:', error)
      }
    }
    return transaction
  }
}
