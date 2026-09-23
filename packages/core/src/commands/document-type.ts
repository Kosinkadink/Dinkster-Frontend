import type { Diagnostic } from '../diagnostics.js'
import type { Json, WorkflowDocument } from '../format/document.js'
import { loadDocument } from '../format/migrate.js'
import { checkDocument } from '../invariants.js'
import { loadImageDocument } from '../image-document/migrate.js'
import { planImageDocumentCommand } from '../image-document/commands.js'
import type { ImageDocument } from '../image-document/model.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import type { CommandDefinition, CommandInvocation, SharedReplayPreparation } from './contract.js'
import { coreCommandRegistry } from './core-commands.js'
import { predictAllocatedId } from './alloc.js'
import { normalizeCollabDocumentKind } from './collab-protocol.js'
import { applyOps, getAtPath, type PatchOp } from './patch.js'
import { jsonSameValue, planWorkflowCommand, replayHistoryOps } from './store.js'

export type DocumentCommandOutcome<D> =
  | {
      readonly ok: true
      readonly doc: D
      readonly forward: readonly PatchOp[]
      readonly inverse: readonly PatchOp[]
      readonly diagnostics: readonly Diagnostic[]
      /** History forward patch, when allocation writes must not be replayed. */
      readonly redo?: readonly PatchOp[]
      readonly created?: { readonly layerId?: string; readonly maskId?: string; readonly resourceId?: string }
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
  load(value: unknown): { readonly document?: D; readonly diagnostics: readonly Diagnostic[] }
  check(document: D): readonly Diagnostic[]
  execute(document: D, invocation: CommandInvocation, replay: boolean): DocumentCommandOutcome<D>
  prepare?(document: D, invocation: CommandInvocation): SharedReplayPreparation | undefined
  transform?(invocation: CommandInvocation, oldDocument: D, newDocument: D): Json | undefined
  /** replay is true when an already-pending history intention rebases. */
  replayHistory?(document: D, operations: readonly PatchOp[], replay?: boolean): {
    readonly applied: readonly PatchOp[]
    readonly stale?: PatchOp
  }
  predictId?(document: D, actor: string, graphId: string, prefix: 'n' | 'r'): string | undefined
  resourceDigests?(document: D): ReadonlySet<string>
}

export function createWorkflowDocumentTypeAdapter(
  commands: ReadonlyMap<string, CommandDefinition> = coreCommandRegistry(),
  options?: { readonly schemaResolverFor?: (document: WorkflowDocument) => SchemaResolver },
): DocumentTypeAdapter<WorkflowDocument> {
  const registry = new Map(commands)
  const context = {
    kind: 'initial' as const,
    ...(options?.schemaResolverFor !== undefined ? { schemaResolverFor: options.schemaResolverFor } : {}),
  }
  return {
    kind: 'dinkster.workflow',
    commandIds: new Set(registry.keys()),
    load: loadDocument,
    check: checkDocument,
    execute: (document, invocation, replay) => planWorkflowCommand(
      document, invocation, registry, replay ? { kind: 'shared-replay' } : context,
    ),
    prepare: (document, invocation) => registry.get(invocation.command)?.prepareForSharedReplay?.(
      document, invocation.params, context, invocation.actor,
    ),
    transform: (invocation, oldDocument, newDocument) => registry.get(invocation.command)?.transformForRebase?.(
      invocation.params, oldDocument, newDocument,
    ),
    replayHistory: (document, operations, replay) => replay
      ? { applied: operations }
      : replayHistoryOps(document, operations, { requireRecordedValues: true }),
    predictId: (document, actor, graphId, prefix) => {
      const graph = document.graphs[graphId]
      return graph === undefined ? undefined : predictAllocatedId(graph, actor, prefix)
    },
  }
}

/** Record positional array edits against the whole array so history detects shifts. */
export function recordDocumentHistory<D>(document: D, operations: readonly PatchOp[]): readonly PatchOp[] {
  if (!operations.some((operation) => typeof operation.path.at(-1) === 'number' && operation.op !== 'replace')) return operations
  let current = document as unknown as Json
  return Object.freeze(operations.map((operation) => {
    const next = applyOps(current, [operation])
    const parent = Object.freeze(operation.path.slice(0, -1))
    const recorded: PatchOp = typeof operation.path.at(-1) === 'number' && operation.op !== 'replace'
      ? Object.freeze({ op: 'replace', path: parent, oldValue: getAtPath(current, parent)!, value: getAtPath(next, parent)! })
      : operation
    current = next
    return recorded
  }))
}

/** Default JSON history guard: never overwrite a value another actor changed. */
export function replayDocumentHistory<D>(document: D, operations: readonly PatchOp[]): {
  readonly applied: readonly PatchOp[]
  readonly stale?: PatchOp
} {
  let current = document as unknown as Json
  const applied: PatchOp[] = []
  for (const operation of operations) {
    const value = getAtPath(current, operation.path)
    const matches = operation.op === 'add'
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
    'image.layer.update', 'image.layer.addRaster', 'image.layer.move', 'image.layer.remove',
    'image.mask.update', 'image.mask.addRaster', 'image.mask.remove',
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
      ...(result.plan.created !== undefined ? { created: result.plan.created } : {}),
    }
  },
  resourceDigests: (document) => new Set(Object.values(document.resources).map((resource) => resource.digest)),
}

export class DocumentTypeRegistry {
  private readonly adapters = new Map<string, DocumentTypeAdapter<unknown>>()

  register<D>(adapter: DocumentTypeAdapter<D>): this {
    const kind = normalizeCollabDocumentKind(adapter.kind)
    if (kind.length === 0) throw new Error('document kind must not be empty')
    if (this.adapters.has(kind)) throw new Error(`document kind already registered: ${kind}`)
    this.adapters.set(kind, adapter as DocumentTypeAdapter<unknown>)
    return this
  }

  get(kind?: string): DocumentTypeAdapter<unknown> | undefined {
    return this.adapters.get(normalizeCollabDocumentKind(kind))
  }
}

export function createDocumentTypeRegistry(): DocumentTypeRegistry {
  return new DocumentTypeRegistry()
    .register(createWorkflowDocumentTypeAdapter())
    .register(imageDocumentTypeAdapter)
}
