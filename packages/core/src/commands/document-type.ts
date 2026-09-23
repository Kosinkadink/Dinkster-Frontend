import type { Json, WorkflowDocument } from '../format/document.js'
import { loadDocument, loadImageDocument } from '../format/migrate.js'
import { checkDocument } from '../invariants.js'
import { planImageDocumentCommand } from '../image-document/commands.js'
import type { ImageDocument } from '../image-document/model.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import type {
  CommandDefinition,
  CommandExecutionContext,
  CommandInvocation,
} from './contract.js'
import { coreCommandRegistry } from './core-commands.js'
import { predictAllocatedId } from './alloc.js'
import { normalizeCollabDocumentKind } from './collab-protocol.js'
import { applyOps, getAtPath, type PatchOp } from './patch.js'
import {
  jsonSameValue,
  planWorkflowCommand,
  replayHistoryOps,
} from './store.js'
import { videoDocumentTypeAdapter } from './video-document.js'

export {
  LocalDocumentEngine,
  LocalDocumentEngine as LocalDocumentTypeSession,
  type DocumentCommandOutcome,
  type DocumentTypeAdapter,
  type LocalDocumentTypeOperation,
} from './document-engine.js'
import type { DocumentTypeAdapter } from './document-engine.js'

export function createWorkflowDocumentTypeAdapter(
  commands: ReadonlyMap<string, CommandDefinition> = coreCommandRegistry(),
  options?: {
    readonly schemaResolverFor?: (document: WorkflowDocument) => SchemaResolver
    /**
     * Per-dispatch execution context provider (DocumentStore compatibility):
     * the store contract takes a context factory so trusted contexts can
     * vary per dispatch; adapters otherwise bake one context in at creation.
     */
    readonly executionContext?: () => CommandExecutionContext
  },
): DocumentTypeAdapter<WorkflowDocument> {
  const registry = new Map(commands)
  const context = {
    kind: 'initial' as const,
    ...(options?.schemaResolverFor !== undefined
      ? { schemaResolverFor: options.schemaResolverFor }
      : {}),
  }
  const initialContext = (): CommandExecutionContext =>
    options?.executionContext !== undefined ? options.executionContext() : context
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
        replay ? { kind: 'shared-replay' } : initialContext(),
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
    replayLocalHistory: (document, operations) =>
      replayHistoryOps(document, operations),
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
