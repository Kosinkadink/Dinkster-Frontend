import { diag, type Diagnostic } from '../diagnostics.js'
import type { Json, WorkflowDocument } from '../format/document.js'
import { ownJson } from '../format/json.js'
import { loadDocument } from '../format/migrate.js'
import { checkDocument } from '../invariants.js'
import { loadImageDocument } from '../image-document/migrate.js'
import { planImageDocumentCommand } from '../image-document/commands.js'
import type { ImageDocument } from '../image-document/model.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import { createSignal, type ReadonlySignal } from '../reactive/signal.js'
import type {
  CommandDefinition,
  CommandInvocation,
  SharedReplayPreparation,
} from './contract.js'
import { coreCommandRegistry } from './core-commands.js'
import { predictAllocatedId } from './alloc.js'
import { normalizeCollabDocumentKind } from './collab-protocol.js'
import { applyOps, applyOwnedOps, getAtPath, type PatchOp } from './patch.js'
import {
  jsonSameValue,
  planWorkflowCommand,
  replayHistoryOps,
} from './store.js'
import { videoDocumentTypeAdapter } from './video-document.js'

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
        readonly command: 'document.undo' | 'document.redo'
        readonly params: null
      }
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
}

interface LocalDocumentTypeHistory {
  readonly invocation: CommandInvocation
  readonly forward: readonly PatchOp[]
  readonly inverse: readonly PatchOp[]
  readonly resources?: ReadonlySet<string>
}

/** Local authority for every adapter kind; shared authority uses the same adapter. */
export class LocalDocumentTypeSession<D> {
  private current: D
  private currentRevision = 0
  private readonly signal
  private readonly undoStack: LocalDocumentTypeHistory[] = []
  private readonly redoStack: LocalDocumentTypeHistory[] = []
  private readonly listeners = new Set<
    (operation: LocalDocumentTypeOperation) => void
  >()

  constructor(
    initial: D,
    private readonly adapter: DocumentTypeAdapter<D>,
    private readonly maxUndo = 200,
  ) {
    if (!Number.isSafeInteger(maxUndo) || maxUndo < 0)
      throw new Error('maxUndo must be a non-negative safe integer')
    const loaded = adapter.load(initial)
    if (loaded.document === undefined)
      throw new Error(`initial ${adapter.kind} document is invalid`)
    this.current = loaded.document
    this.signal = createSignal(this.current)
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

  dispatch(invocation: CommandInvocation): DocumentCommandOutcome<D> {
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
      if (
        !outcome.ok ||
        outcome.diagnostics.some((problem) => problem.severity === 'error')
      )
        return outcome
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
      const next = this.loadReplay(this.current, owned.forward)
      if (owned.forward.length === 0) return { ...outcome, doc: next }
      const resources = this.changedResources(this.current, next)
      this.current = next
      this.undoStack.push({
        invocation: stamped,
        forward: owned.redo,
        inverse: owned.inverse,
        ...(resources === undefined ? {} : { resources }),
      })
      if (this.undoStack.length > this.maxUndo) this.undoStack.shift()
      this.redoStack.length = 0
      this.commit(stamped, owned.forward, owned.inverse)
      return {
        ...outcome,
        doc: next,
        forward: owned.forward,
        inverse: owned.inverse,
        redo: owned.redo,
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

  onOp(listener: (operation: LocalDocumentTypeOperation) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private replay(
    from: LocalDocumentTypeHistory[],
    to: LocalDocumentTypeHistory[],
    kind: 'undo' | 'redo',
  ): boolean {
    const record = from.at(-1)
    if (record === undefined) return false
    const forward = kind === 'undo' ? record.inverse : record.forward
    const inverse = kind === 'undo' ? record.forward : record.inverse
    try {
      this.current = this.loadReplay(this.current, forward)
    } catch {
      return false
    }
    from.pop()
    to.push(record)
    this.commit({ command: `document.${kind}`, params: null }, forward, inverse)
    return true
  }

  private loadReplay(document: D, operations: readonly PatchOp[]): D {
    const candidate = applyOwnedOps(document as unknown as Json, operations)
    const loaded = this.adapter.load(candidate)
    if (loaded.document === undefined)
      throw new Error(
        `${this.adapter.kind} command violated document invariants`,
      )
    return loaded.document
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

  private commit(
    invocation: LocalDocumentTypeOperation['invocation'],
    forward: readonly PatchOp[],
    inverse: readonly PatchOp[],
  ): void {
    this.currentRevision += 1
    this.signal.set(this.current)
    const operation = Object.freeze({
      revision: this.currentRevision,
      invocation,
      forward,
      inverse,
    })
    for (const listener of this.listeners) {
      try {
        listener(operation)
      } catch {
        /* Listener failures do not unwind committed state. */
      }
    }
  }
}

export function createWorkflowDocumentTypeAdapter(
  commands: ReadonlyMap<string, CommandDefinition> = coreCommandRegistry(),
  options?: {
    readonly schemaResolverFor?: (document: WorkflowDocument) => SchemaResolver
  },
): DocumentTypeAdapter<WorkflowDocument> {
  const registry = new Map(commands)
  const context = {
    kind: 'initial' as const,
    ...(options?.schemaResolverFor !== undefined
      ? { schemaResolverFor: options.schemaResolverFor }
      : {}),
  }
  return {
    kind: 'dinkster.workflow',
    commandIds: new Set(registry.keys()),
    load: loadDocument,
    check: checkDocument,
    execute: (document, invocation, replay) =>
      planWorkflowCommand(
        document,
        invocation,
        registry,
        replay ? { kind: 'shared-replay' } : context,
      ),
    prepare: (document, invocation) =>
      registry
        .get(invocation.command)
        ?.prepareForSharedReplay?.(
          document,
          invocation.params,
          context,
          invocation.actor,
        ),
    transform: (invocation, oldDocument, newDocument) =>
      registry
        .get(invocation.command)
        ?.transformForRebase?.(invocation.params, oldDocument, newDocument),
    replayHistory: (document, operations, replay) =>
      replay
        ? { applied: operations }
        : replayHistoryOps(document, operations, {
            requireRecordedValues: true,
          }),
    predictId: (document, actor, graphId, prefix) => {
      const graph = document.graphs[graphId]
      return graph === undefined
        ? undefined
        : predictAllocatedId(graph, actor, prefix)
    },
  }
}

/** Record positional array edits against the whole array so history detects shifts. */
export function recordDocumentHistory<D>(
  document: D,
  operations: readonly PatchOp[],
): readonly PatchOp[] {
  if (
    !operations.some(
      (operation) =>
        typeof operation.path.at(-1) === 'number' && operation.op !== 'replace',
    )
  )
    return operations
  let current = document as unknown as Json
  return Object.freeze(
    operations.map((operation) => {
      const next = applyOps(current, [operation])
      const parent = Object.freeze(operation.path.slice(0, -1))
      const recorded: PatchOp =
        typeof operation.path.at(-1) === 'number' && operation.op !== 'replace'
          ? Object.freeze({
              op: 'replace',
              path: parent,
              oldValue: getAtPath(current, parent)!,
              value: getAtPath(next, parent)!,
            })
          : operation
      current = next
      return recorded
    }),
  )
}

/** Default JSON history guard: never overwrite a value another actor changed. */
export function replayDocumentHistory<D>(
  document: D,
  operations: readonly PatchOp[],
): {
  readonly applied: readonly PatchOp[]
  readonly stale?: PatchOp
} {
  let current = document as unknown as Json
  const applied: PatchOp[] = []
  for (const operation of operations) {
    const value = getAtPath(current, operation.path)
    const matches =
      operation.op === 'add'
        ? value === undefined
        : value !== undefined && jsonSameValue(value, operation.oldValue)
    if (!matches) return { applied, stale: operation }
    current = applyOps(current, [operation])
    applied.push(operation)
  }
  return { applied }
}

export const imageDocumentTypeAdapter: DocumentTypeAdapter<ImageDocument> = {
  kind: 'dinkster.image',
  commandIds: new Set([
    'image.canvas.crop',
    'image.canvas.resize',
    'image.canvas.update',
    'image.output.update',
    'image.layer.group',
    'image.layer.update',
    'image.layer.addRaster',
    'image.layer.move',
    'image.layer.remove',
    'image.mask.update',
    'image.mask.addRaster',
    'image.mask.remove',
  ]),
  load: loadImageDocument,
  check: (document) => loadImageDocument(document).diagnostics,
  execute(document, invocation) {
    const result = planImageDocumentCommand(document, invocation)
    if (!result.ok) return result
    return {
      ok: true,
      doc: result.plan.document,
      forward: result.plan.forward,
      inverse: result.plan.inverse,
      redo: result.plan.redo,
      diagnostics: [],
      ...(result.plan.created !== undefined
        ? { created: result.plan.created }
        : {}),
    }
  },
  resourceDigests: (document) =>
    new Set(
      Object.values(document.resources).map((resource) => resource.digest),
    ),
}

export class DocumentTypeRegistry {
  private readonly adapters = new Map<string, DocumentTypeAdapter<unknown>>()

  register<D>(adapter: DocumentTypeAdapter<D>): this {
    this.contribute(adapter)
    return this
  }

  contribute<D>(adapter: DocumentTypeAdapter<D>): () => void {
    const kind = normalizeCollabDocumentKind(adapter.kind)
    if (kind.length === 0) throw new Error('document kind must not be empty')
    if (this.adapters.has(kind))
      throw new Error(`document kind already registered: ${kind}`)
    const value = adapter as DocumentTypeAdapter<unknown>
    this.adapters.set(kind, value)
    return () => {
      if (this.adapters.get(kind) === value) this.adapters.delete(kind)
    }
  }

  get(kind?: string): DocumentTypeAdapter<unknown> | undefined {
    return this.adapters.get(normalizeCollabDocumentKind(kind))
  }
}

export function createDocumentTypeRegistry(): DocumentTypeRegistry {
  return new DocumentTypeRegistry()
    .register(createWorkflowDocumentTypeAdapter())
    .register(imageDocumentTypeAdapter)
    .register(videoDocumentTypeAdapter)
}
