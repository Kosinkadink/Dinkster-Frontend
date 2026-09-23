import type { Json } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { isValidActorId } from '../ids.js'
import type { ReadonlySignal } from '../reactive/signal.js'
import { normalizeCollabDocumentKind, type CollabConnection } from '../commands/collab-protocol.js'
import { imageDocumentTypeAdapter } from '../commands/document-type.js'
import { SharedDocumentSession, type SharedSessionOptions, type SharedSessionStatus } from '../commands/shared-session.js'
import type { ImageDocumentCommandInvocation } from './commands.js'
import type { ImageDocument } from './model.js'
import type { ImageDocumentSession, ImageDocumentSessionOp } from './session.js'
import type { ImageDocumentDispatchOutcome } from './store.js'

export type SharedImageDocumentStatus = SharedSessionStatus

export interface SharedImageDocumentConflict {
  readonly origin: string
  readonly message: string
}

export interface SharedImageDocumentSessionOptions extends Omit<SharedSessionOptions, 'onConflict' | 'schemaResolverFor'> {
  readonly onConflict?: (conflict: SharedImageDocumentConflict) => void
}

function imageOrigin(origin: string): string {
  return origin === 'session.undo' ? 'image.undo' : origin === 'session.redo' ? 'image.redo' : origin
}

/** Compatibility surface; all collaboration state belongs to the generic engine. */
export class SharedImageDocumentSession implements ImageDocumentSession {
  private readonly session: SharedDocumentSession<ImageDocument>
  private readonly clock: () => number

  constructor(
    connection: CollabConnection,
    snapshot: ImageDocument,
    snapshotRevision: number,
    options?: SharedImageDocumentSessionOptions,
  ) {
    if (options?.actorId !== undefined && !isValidActorId(options.actorId)) {
      throw new Error('invalid ImageDocument collaboration actor id')
    }
    this.clock = options?.clock ?? Date.now
    this.session = new SharedDocumentSession(connection, snapshot, snapshotRevision, imageDocumentTypeAdapter, {
      ...options,
      onConflict: (conflict) => options?.onConflict?.({
        origin: imageOrigin(conflict.origin ?? (conflict.during === 'rebase' ? conflict.invocation.command : `session.${conflict.during}`)),
        message: conflict.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
      }),
    })
  }

  get actorId(): string { return this.session.actorId }
  get status(): ReadonlySignal<SharedImageDocumentStatus> { return this.session.status }
  get doc(): ImageDocument { return this.session.doc }
  get document(): ReadonlySignal<ImageDocument> { return this.session.document }
  get revision(): number { return this.session.revision }
  get canUndo(): boolean { return this.session.canUndo }
  get canRedo(): boolean { return this.session.canRedo }

  dispatch(invocation: ImageDocumentCommandInvocation): ImageDocumentDispatchOutcome {
    const owned = ownJson({ ...invocation, actor: this.actorId }, { undefinedProps: 'reject' })
    if (!owned.ok) return { ok: false, diagnostics: [{ severity: 'error', origin: 'command', code: 'command.params.notJson', message: owned.reason }] }
    const stamped = owned.value as unknown as ImageDocumentCommandInvocation
    const result = this.session.dispatch(stamped)
    if (!result.ok) return {
      ok: false,
      diagnostics: result.diagnostics.map((diagnostic) => diagnostic.code === 'session.unavailable'
        ? { ...diagnostic, code: 'image.session.unavailable', message: `ImageDocument session is ${this.status.get()}` }
        : diagnostic),
    }
    return {
      ok: true,
      document: result.doc,
      revision: this.revision,
      transaction: {
        revision: this.revision,
        invocation: stamped,
        forward: result.forward,
        inverse: result.inverse,
        timestamp: this.clock(),
      },
      ...(result.created !== undefined ? { created: result.created } : {}),
    }
  }

  undo(): boolean { return this.session.undo() }
  redo(): boolean { return this.session.redo() }
  clearHistory(): void { this.session.clearHistory() }
  retainedResourceDigests(): ReadonlySet<string> { return this.session.retainedResourceDigests() }
  onOp(listener: (operation: ImageDocumentSessionOp) => void): () => void {
    return this.session.onOp((operation) => listener(Object.freeze({ ...operation, origin: imageOrigin(operation.origin) })))
  }
  onPresence(listener: (actorId: string, payload?: Json) => void): () => void {
    return this.session.onPresence(listener)
  }
  sendPresence(payload: Json): void { this.session.sendPresence(payload) }
  settle(): Promise<void> { return this.session.settle() }
  close(): void { this.session.close() }
}

export async function connectSharedImageDocumentSession(
  connection: CollabConnection,
  descriptor: { readonly documentKind?: string },
  options?: SharedImageDocumentSessionOptions,
): Promise<SharedImageDocumentSession> {
  if (normalizeCollabDocumentKind(descriptor.documentKind) !== imageDocumentTypeAdapter.kind) {
    throw new Error('collaboration session is not an ImageDocument')
  }
  const snapshot = await connection.fetchSnapshot()
  return new SharedImageDocumentSession(connection, snapshot.document as ImageDocument, snapshot.revision, options)
}
