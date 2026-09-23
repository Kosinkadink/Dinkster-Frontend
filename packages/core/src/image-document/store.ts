import {
  LocalDocumentTypeSession,
  imageDocumentTypeAdapter,
  type LocalDocumentTypeOperation,
} from '../commands/document-type.js'
import type { PatchOp } from '../commands/patch.js'
import type { Diagnostic } from '../diagnostics.js'
import type { ReadonlySignal } from '../reactive/signal.js'
import type {
  ImageDocumentCommandInvocation,
  ImageDocumentCommandPlan,
} from './commands.js'
import type { ImageDocument } from './model.js'

export interface ImageDocumentTransaction {
  readonly revision: number
  readonly invocation:
    | ImageDocumentCommandInvocation
    | { readonly command: 'image.undo' | 'image.redo' }
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

const imageInvocation = (
  operation: LocalDocumentTypeOperation,
): ImageDocumentTransaction['invocation'] => {
  if (operation.invocation.command === 'document.undo')
    return { command: 'image.undo' }
  if (operation.invocation.command === 'document.redo')
    return { command: 'image.redo' }
  return operation.invocation as ImageDocumentCommandInvocation
}

/** Compatibility facade over the document-kind-parameterized local store. */
export class ImageDocumentStore {
  private readonly store: LocalDocumentTypeSession<ImageDocument>
  private readonly listeners = new Set<
    (transaction: ImageDocumentTransaction) => void
  >()
  private readonly transactions = new Map<number, ImageDocumentTransaction>()

  constructor(
    initial: ImageDocument,
    maxUndo = 200,
    private readonly clock: () => number = Date.now,
  ) {
    this.store = new LocalDocumentTypeSession(
      initial,
      imageDocumentTypeAdapter,
      maxUndo,
    )
    this.store.onOp((operation) => this.publish(operation))
  }

  get doc(): ImageDocument {
    return this.store.doc
  }
  get revision(): number {
    return this.store.revision
  }
  get document(): ReadonlySignal<ImageDocument> {
    return this.store.document
  }
  get canUndo(): boolean {
    return this.store.canUndo
  }
  get canRedo(): boolean {
    return this.store.canRedo
  }

  dispatch(invocation: unknown): ImageDocumentDispatchOutcome {
    const before = this.store.revision
    const outcome = this.store.dispatch(
      invocation as ImageDocumentCommandInvocation,
    )
    if (!outcome.ok) return outcome
    const transaction = this.transactions.get(before + 1)
    if (transaction === undefined)
      throw new Error('ImageDocument command did not commit a transaction')
    this.transactions.delete(before + 1)
    return {
      ok: true,
      document: outcome.doc,
      revision: transaction.revision,
      transaction,
      ...(outcome.created === undefined ? {} : { created: outcome.created }),
    }
  }

  undo(): boolean {
    return this.store.undo()
  }
  redo(): boolean {
    return this.store.redo()
  }
  clearHistory(): void {
    this.store.clearHistory()
  }
  retainedResourceDigests(): ReadonlySet<string> {
    return this.store.retainedResourceDigests()
  }

  onTransaction(
    listener: (transaction: ImageDocumentTransaction) => void,
  ): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(operation: LocalDocumentTypeOperation): void {
    const transaction: ImageDocumentTransaction = Object.freeze({
      revision: operation.revision,
      invocation: imageInvocation(operation),
      forward: operation.forward,
      inverse: operation.inverse,
      timestamp: this.clock(),
    })
    if (!operation.invocation.command.startsWith('document.'))
      this.transactions.set(operation.revision, transaction)
    for (const listener of this.listeners) {
      try {
        listener(transaction)
      } catch (error) {
        console.error('[ImageDocumentStore] listener threw:', error)
      }
    }
  }
}
