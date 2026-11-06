import { uuidv4, type DinksterConnection, type ExecutionState, type RetainedAssetOwner, type RetainedAssets } from '@dinkster/client'
import {
  EMPTY_CONNECTIVITY,
  MASK_PAINT_SOURCE_EXT_KEY,
  MAX_DYNAMIC_STATE_DEPTH,
  buildGraphConnectivity,
  documentNodeResolver,
  elabInputsOf,
  elaborateInterface,
  executionKey,
  isDinksterClipboardEnvelope,
  isAssetWidgetInput,
  maskPaintSourceNodeId,
  parseTypedLiteralWire,
  replayHistoryOps,
  typeExprFromTypeId,
  valueSourceConsumersOf,
  valueKeyOf,
  type CommandOutcome,
  type DocumentNodeResolver,
  type ExecutionRef,
  type HistorySnapshot,
  type GraphDef,
  type InputSpec,
  type Json,
  type NodeData,
  type NodeSchema,
  type PatchOp,
  type PreparedDocumentDispatch,
  type SchemaResolver,
  type TypeExpr,
  type WorkflowDocument,
} from '@dinkster/core'
import { isAssetRef } from './image-editor.js'
import { activeProjectId, scopedStorageKey } from './projects.js'

const primitiveNames = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'])
const widgetTypes = new Set(['STRING', 'INT', 'FLOAT', 'NUMBER', 'BOOLEAN', 'COMBO', 'ASSET'])

function assetFreeDynamicState(value: unknown, depth = 0): boolean {
  if (depth > MAX_DYNAMIC_STATE_DEPTH || typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.entries(value).every(([key, entry]) => {
    if (key === 'selected') return typeof entry === 'string'
    if (key === 'seq') return Number.isSafeInteger(entry) && entry >= 0
    if (key === 'members') return Array.isArray(entry) && entry.every((member) => typeof member === 'string')
    if (key === 'options') return Array.isArray(entry) && entry.every((option) =>
      typeof option === 'string' || typeof option === 'boolean' || (typeof option === 'number' && Number.isFinite(option)))
    if (key === 'memberLabels') return typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
      Object.values(entry).every((label) => typeof label === 'string')
    if (key === 'memberState') return typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
      Object.values(entry).every((constructs) => typeof constructs === 'object' && constructs !== null && !Array.isArray(constructs) &&
        Object.values(constructs).every((state) => assetFreeDynamicState(state, depth + 1)))
    return false
  })
}

/** Strict census: unsupported state is incomplete, never an empty complete set. */
export function workflowAssetRoots(
  document: WorkflowDocument,
  history: HistorySnapshot,
  resolve: SchemaResolver,
  additionalDocuments: readonly WorkflowDocument[] = [],
): { readonly complete: boolean; readonly digests: readonly string[]; readonly refusal?: string } {
  const digests = new Set<string>()
  let complete = true
  let refusal: string | undefined
  const checkedOpaque = new WeakSet<object>()
  // Unknown storage can reveal known roots without certifying that these are all of them.
  const opaqueRoots = (value: Json): void => {
    if (typeof value !== 'object' || value === null || checkedOpaque.has(value)) return
    checkedOpaque.add(value)
    if (isAssetRef(value)) { digests.add(value.digest); return }
    if (!Array.isArray(value) && Object.hasOwn(value, 'digest')) refusal = 'Workflow asset identity is malformed'
    if (!Array.isArray(value) && Object.hasOwn(value, '$typed')) {
      if (parseTypedLiteralWire(value) === undefined || Object.keys(value).length !== 1 ||
        Object.keys((value as { readonly [key: string]: Json })['$typed'] as object).length !== 2) refusal = 'Workflow typed literal is malformed'
    }
    for (const entry of Object.values(value)) opaqueRoots(entry)
  }
  const checkedExtensions = new WeakSet<object>()
  const checkedSchemaExtensions = new WeakSet<object>()
  const knownSchemaExtensions = new WeakSet<object>()
  const checkedNodes = new WeakMap<object, Set<NodeSchema | undefined>>()
  let hasContextualValues = false
  const supported = (type: TypeExpr): boolean => {
    if (type.kind === 'asset') return true
    if (type.kind === 'list') return supported(type.element)
    if (type.kind === 'tuple') return type.elements.every(supported)
    return type.kind === 'concrete' && (type.name === 'ASSET' || primitiveNames.has(type.name))
  }
  const valueRoots = (value: Json, type: TypeExpr, namedAsset = false): void => {
    // Asset widgets can hold unresolved imported names, never a certified digest set.
    if (namedAsset && typeof value === 'string') { complete = false; return }
    const typed = parseTypedLiteralWire(value)
    if (typed !== undefined) {
      const wrapper = value as { readonly [key: string]: Json }
      if (Object.keys(wrapper).length !== 1 || Object.keys(wrapper['$typed'] as object).length !== 2) {
        complete = false
        refusal = 'Workflow typed literal is malformed'
        return
      }
      valueRoots(typed.value, typeExprFromTypeId(typed.type))
    } else if (!supported(type)) {
      complete = false
      opaqueRoots(value)
    } else if (type.kind === 'asset' || (type.kind === 'concrete' && type.name === 'ASSET')) {
      if (isAssetRef(value)) digests.add(value.digest)
      else { complete = false; refusal = 'Workflow asset identity is malformed' }
    } else if (type.kind === 'list') {
      if (!Array.isArray(value)) { complete = false; refusal = 'Workflow asset list is malformed' }
      else for (const element of value) valueRoots(element, type.element)
    } else if (type.kind === 'tuple') {
      if (!Array.isArray(value) || value.length !== type.elements.length) { complete = false; refusal = 'Workflow asset tuple is malformed' }
      else value.forEach((element, index) => valueRoots(element, type.elements[index]!))
    } else if (typeof value === 'object') {
      complete = false
      opaqueRoots(value)
    }
  }
  const checkExtensions = (value: Json, stored = true): void => {
    if (typeof value !== 'object' || value === null) return
    const checked = stored ? checkedExtensions : checkedSchemaExtensions
    if (checked.has(value)) return
    checked.add(value)
    if (Array.isArray(value)) {
      for (const entry of value) checkExtensions(entry, stored)
    } else {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'ext' && typeof entry === 'object' && entry !== null && Object.keys(entry).length > 0 &&
          !knownSchemaExtensions.has(value)) {
          complete = false
          if (stored) opaqueRoots(entry)
        } else checkExtensions(entry, stored)
      }
    }
  }
  const registerInputDefaults = (input: InputSpec): void => {
    if (input.ext !== undefined && Object.keys(input.ext).every((key) => key === 'default')) knownSchemaExtensions.add(input)
    const dynamic = input.dynamic
    if (dynamic?.kind === 'autogrow') dynamic.template.forEach(registerInputDefaults)
    else if (dynamic?.kind === 'dynamicCombo') dynamic.options.forEach((option) => option.inputs.forEach(registerInputDefaults))
    else if (dynamic?.kind === 'dynamicSlot') {
      dynamic.inputs.forEach(registerInputDefaults)
      dynamic.variants?.forEach((variant) => variant.inputs.forEach(registerInputDefaults))
    }
  }
  const visitNode = (node: NodeData, schemas: DocumentNodeResolver, graph: GraphDef): void => {
    if (node.type.startsWith('#')) hasContextualValues = true
    const schema = schemas(graph.id, node)
    const dynamic = schema?.items.some((item) => (item.kind === 'input' || item.kind === 'output') && item.dynamic !== undefined)
    if (dynamic) hasContextualValues = true
    // A stable node can resolve differently after its referenced graph changes.
    let checkedSchemas = checkedNodes.get(node)
    if (!dynamic && checkedSchemas?.has(schema)) return
    if (checkedSchemas === undefined) {
      checkedSchemas = new Set()
      checkedNodes.set(node, checkedSchemas)
    }
    checkedSchemas.add(schema)
    // Only this node association has a known asset-free shape; nested metadata stays opaque.
    if (node.ext !== undefined && Object.keys(node.ext).length > 0 &&
      (schema?.editorRole !== 'mask-paint' || Object.keys(node.ext).length !== 1 ||
        !Object.hasOwn(node.ext, MASK_PAINT_SOURCE_EXT_KEY) || maskPaintSourceNodeId(node) === undefined)) complete = false
    checkedExtensions.add(node)
    for (const [key, value] of Object.entries(node)) if (key !== 'ext') checkExtensions(value as Json)
    for (const value of Object.values(node.values)) opaqueRoots(value)
    if (node.ext !== undefined) opaqueRoots(node.ext)
    if (node.dynamic !== undefined) opaqueRoots(node.dynamic as Json)
    if (schema === undefined) { complete = false; return }
    const metadata = schema.ext?.['dinkster']
    if (schema.ext !== undefined && Object.keys(schema.ext).length === 1 &&
      typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)) {
      const fields = metadata as Record<string, unknown>
      if (Object.keys(fields).every((key) => ['version', 'idempotent', 'occupies', 'ioBound'].includes(key)) &&
        typeof fields['version'] === 'number' && Number.isFinite(fields['version']) && typeof fields['idempotent'] === 'boolean' &&
        (fields['occupies'] === undefined || (Array.isArray(fields['occupies']) && fields['occupies'].every((entry) => typeof entry === 'string'))) &&
        (fields['ioBound'] === undefined || fields['ioBound'] === true)) knownSchemaExtensions.add(schema)
    }
    for (const item of schema.items) if (item.kind === 'input') registerInputDefaults(item)
    checkExtensions(schema as unknown as Json, false)
    if (Object.values(node.dynamic ?? {}).some((state) => !assetFreeDynamicState(state))) complete = false
    for (const item of schema?.items ?? []) {
      if (item.kind !== 'input' && item.kind !== 'output') complete = false
    }
    const connectivity = dynamic ? buildGraphConnectivity(graph)(node.id) : EMPTY_CONNECTIVITY
    const active = elaborateInterface(schema, node, connectivity, { promoteGhosts: false })
    const stored = dynamic || Object.keys(node.dynamic ?? {}).length > 0
      ? elaborateInterface(schema, node, connectivity, { promoteGhosts: false, includeDormant: true }) : active
    if (active.diagnostics.length > 0 || stored.diagnostics.length > 0) {
      complete = false
      refusal = 'Workflow dynamic identities are invalid'
    }
    const inputs = elabInputsOf(stored)
    for (const { spec } of inputs) {
      if (spec.ext !== undefined && Object.keys(spec.ext).some((key) => key !== 'default')) complete = false
      if (spec.widget !== undefined && !widgetTypes.has(spec.widget.widgetType)) complete = false
    }
    for (const input of elabInputsOf(active)) {
      if (input.ancestry?.some((ancestor) => ancestor.ghost)) continue
      const fallback = input.spec.widget?.default !== undefined ? input.spec.widget.default : input.spec.ext?.['default']
      if (!Object.hasOwn(node.values, valueKeyOf(input)) && fallback !== undefined) {
        valueRoots(fallback as Json, input.spec.type, isAssetWidgetInput(input.spec))
      }
    }
    for (const [input, value] of Object.entries(node.values)) {
      const matching = inputs.filter((item) => valueKeyOf(item) === input)
      if (matching.length === 0) complete = false
      for (const item of matching) valueRoots(value, item.spec.type, isAssetWidgetInput(item.spec))
    }
  }
  const visit = (snapshot: WorkflowDocument, changes?: readonly PatchOp[]): void => {
    const schemas = documentNodeResolver(snapshot, resolve)
    if (Object.values(snapshot.graphs).some((graph) => Object.keys(graph.valueSources ?? {}).length > 0)) hasContextualValues = true
    // Instances and literal producers depend on schemas outside the changed node.
    if (!hasContextualValues && changes !== undefined && changes.every((op) =>
      op.path.length >= 4 && op.path[0] === 'graphs' && op.path[2] === 'nodes' &&
      !op.path.slice(0, 4).includes('ext'))) {
      const nodes = new Map(changes.flatMap((op) => {
        const graph = snapshot.graphs[String(op.path[1])]
        const node = graph?.nodes[String(op.path[3])]
        return node === undefined ? [] : [[node, graph!] as const]
      }))
      if ([...nodes.keys()].every((node) => !node.type.startsWith('#'))) {
        for (const [node, graph] of nodes) visitNode(node, schemas, graph)
        return
      }
    }
    for (const graph of Object.values(snapshot.graphs)) {
      for (const node of Object.values(graph.nodes)) visitNode(node, schemas, graph)
      for (const source of Object.values(graph.valueSources ?? {})) {
        opaqueRoots(source.value)
        if (source.spec?.options !== undefined) complete = false
        const typed = parseTypedLiteralWire(source.value)
        if (typed !== undefined) valueRoots(source.value, typeExprFromTypeId(typed.type))
        else {
          const consumers = valueSourceConsumersOf(graph, source.id)
          if (consumers.length === 0) complete = false
          for (const consumer of consumers) {
            const node = graph.nodes[consumer.node]
            const input = node === undefined ? undefined : schemas(graph.id, node)?.items.find((item) =>
              item.kind === 'input' && item.id === consumer.port)
            if (consumer.members !== undefined || input?.kind !== 'input' || input.dynamic !== undefined) complete = false
            else valueRoots(source.value, input.type)
          }
        }
      }
    }
    checkExtensions(snapshot as unknown as Json)
  }
  visit(document)
  for (const snapshot of additionalDocuments) visit(snapshot)
  for (const [records, direction] of [[history.undo, 'inverse'], [history.redo, 'forward']] as const) {
    let snapshot = document
    for (const record of [...records].reverse()) {
      const replayed = replayHistoryOps(snapshot, record[direction], { requireRecordedValues: true })
      if (replayed.stale !== undefined) { complete = false; refusal = 'Workflow retained history is stale' }
      snapshot = replayed.doc
      visit(snapshot, replayed.applied)
    }
  }
  return { complete, digests: [...digests].sort(), ...(refusal === undefined ? {} : { refusal }) }
}

/** Known result identities are roots, but opaque runtime values are never certified complete. */
export function executionAssetRoots(
  state: Pick<ExecutionState, 'outputs' | 'artifacts' | 'sourceDocument' | 'artifact'> &
    Partial<Pick<ExecutionState, 'previews' | 'previewRings' | 'lastPreview'>>,
  resolve: SchemaResolver,
): ReturnType<typeof workflowAssetRoots> {
  const digests = new Set<string>()
  const add = (digest: unknown): void => {
    if (typeof digest === 'string' && /^blake3:[0-9a-f]{64}$/.test(digest)) digests.add(digest)
  }
  add(state.sourceDocument)
  if (state.artifact !== undefined) {
    for (const digest of workflowAssetRoots(state.artifact.snapshot,
      { revision: state.artifact.revision, undo: [], redo: [] }, resolve).digests) add(digest)
  }
  for (const artifact of state.artifacts) {
    add(artifact.digest)
    add(artifact.preview?.digest)
  }
  const visited = new WeakSet<object>()
  const pending: unknown[] = Object.values(state.outputs).flatMap((outputs) => Object.values(outputs))
  pending.push(state.previews, state.previewRings, state.lastPreview)
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || visited.has(value)) continue
    visited.add(value)
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) ||
      (typeof Blob !== 'undefined' && value instanceof Blob)) continue
    if (Array.isArray(value)) { for (const entry of value) pending.push(entry); continue }
    const descriptor = value as Record<string, unknown>
    add(descriptor['digest'])
    add(descriptor['documentDigest'])
    for (const entry of Object.values(descriptor)) pending.push(entry)
  }
  return { complete: false, digests: [...digests].sort() }
}

function retentionMatches(value: RetainedAssets | undefined, owner: RetainedAssetOwner,
  digests: readonly string[], complete: boolean): boolean {
  return value !== undefined && value.scope === owner.scope && value.ownerKind === owner.ownerKind &&
    value.ownerId === owner.ownerId && value.revision === 1 && value.complete === complete &&
    value.digests.length === digests.length && value.digests.every((digest, index) => digest === digests[index])
}

/** Observe durable intents without replaying their commands, writes or releases. */
export async function reconcileWorkflowRetentions(
  connection: DinksterConnection,
  signal: AbortSignal,
  storage?: Pick<Storage, 'length' | 'key' | 'getItem'>,
): Promise<boolean> {
  const prefix = scopedStorageKey('dinkster.workflow-retentions.')
  let resolved = true
  try {
    storage ??= globalThis.localStorage
    const entries: Array<readonly [string, string | null]> = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(prefix)) entries.push([key, storage.getItem(key)])
    }
    for (const [key, bytes] of entries) {
      signal.throwIfAborted()
      try {
        const raw: unknown = JSON.parse(bytes ?? 'null')
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid workflow retention intent')
        const intent = raw as Record<string, unknown>
        // Stored destinations identify an existing connection, never authorize a new request destination.
        if (typeof intent.connectionId === 'string' && intent.connectionId !== connection.id) continue
        if (typeof intent.assetBaseUrl === 'string' && intent.assetBaseUrl !== connection.assetUrl('')) continue
        const owner = intent.owner as RetainedAssetOwner | undefined
        let clipboardValid = intent.clipboardText === undefined
        if (typeof intent.clipboardText === 'string') {
          const envelope: unknown = JSON.parse(intent.clipboardText)
          clipboardValid = owner?.ownerKind === 'document' && isDinksterClipboardEnvelope(envelope) &&
            envelope.scope?.lineage === intent.documentLineage && intent.complete === false
        }
        const contextValid = owner?.ownerKind === 'document'
          ? typeof owner.ownerId === 'string' && /^workflow-candidate:[a-zA-Z0-9-]+$/.test(owner.ownerId) &&
            typeof intent.documentLineage === 'string' && intent.documentLineage.length > 0 &&
            Number.isSafeInteger(intent.documentRevision) && (intent.documentRevision as number) >= 0
          : owner?.ownerKind === 'preview'
            ? typeof owner.ownerId === 'string' && /^asset-preview:[a-zA-Z0-9-]+$/.test(owner.ownerId) &&
              intent.preview === true && intent.complete === false
          : owner?.ownerKind === 'shown-result' && typeof owner.ownerId === 'string' &&
            /^execution-result:[a-zA-Z0-9-]+$/.test(owner.ownerId) &&
            typeof intent.executionKey === 'string' && intent.executionKey.length > 0
        if (intent.version !== 3 || (intent.acknowledgedRevision !== undefined && intent.acknowledgedRevision !== 1) ||
          intent.connectionId !== connection.id || intent.assetBaseUrl !== connection.assetUrl('') ||
          owner === undefined || owner === null || owner.scope !== 'local' || !contextValid || !clipboardValid ||
          owner.ownerId.length > 512 || key !== `${prefix}${owner.ownerId}` ||
          typeof intent.complete !== 'boolean' || !Array.isArray(intent.digests) || intent.digests.length > 4096 ||
          !intent.digests.every((digest: unknown, index: number, digests: unknown[]) =>
            typeof digest === 'string' && /^blake3:[0-9a-f]{64}$/.test(digest) &&
            (index === 0 || (digests[index - 1] as string) < digest))) throw new Error('Invalid workflow retention intent')
        const observed = await connection.fetchRetainedAssets(owner, signal)
        // A concurrent window may have changed the intent while the request was in flight.
        if (storage.getItem(key) !== bytes || !retentionMatches(observed, owner, intent.digests, intent.complete)) resolved = false
      } catch {
        resolved = false
      }
    }
    signal.throwIfAborted()
  } catch {
    return false
  }
  return resolved
}

/** Durable owners are never released merely because their caller leaves or fails. */
export async function retainWorkflowAssets(
  connection: DinksterConnection,
  documentLineage: string,
  documentRevision: number,
  roots: ReturnType<typeof workflowAssetRoots>,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
  clipboardText?: string,
): Promise<RetainedAssets> {
  if (clipboardText !== undefined) {
    const envelope: unknown = JSON.parse(clipboardText)
    if (!isDinksterClipboardEnvelope(envelope) || envelope.scope?.lineage !== documentLineage || roots.complete) {
      throw new Error('Clipboard retention context differs')
    }
  }
  return retainAssetRoots(connection, 'document', { documentLineage, documentRevision,
    ...(clipboardText === undefined ? {} : { clipboardText }) }, roots, storage)
}

export async function retainExecutionAssets(
  connection: DinksterConnection,
  ref: ExecutionRef,
  roots: ReturnType<typeof workflowAssetRoots>,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): Promise<RetainedAssets> {
  return retainAssetRoots(connection, 'shown-result', { executionKey: executionKey(ref) }, roots, storage)
}

/** Catalog entries have independent preview ownership, not workflow roots. */
export async function readAssetPreview<T>(
  connection: DinksterConnection,
  digest: string,
  consume: () => Promise<T>,
  stillCurrent: () => boolean,
): Promise<T> {
  const project = activeProjectId()
  let connectionChanged = false
  const unsubscribe = connection.status.subscribe(() => { connectionChanged = true })
  const current = () => !connectionChanged && activeProjectId() === project && stillCurrent()
  let reader: RetainedAssetReader | undefined
  try {
    if (!current()) throw new Error('Asset preview changed before admission')
    const retained = await retainAssetRoots(connection, 'preview', { preview: true }, { complete: false, digests: [digest] }, globalThis.localStorage)
    reader = new RetainedAssetReader(connection, retained, current)
    return await reader.read(consume)
  } finally {
    // Cancellation closes publication, not a shared renderer's pending work.
    await reader?.close()
    unsubscribe()
  }
}

/** Acknowledged protection outlives all admitted reads, including pending bodies. */
export class RetainedAssetReader {
  private closed = false
  private readonly pending = new Set<Promise<unknown>>()

  constructor(
    readonly connection: DinksterConnection,
    readonly retained: RetainedAssets,
    private readonly isCurrent: () => boolean,
  ) {}

  async read<T>(consume: () => Promise<T>): Promise<T> {
    if (this.closed || !this.isCurrent()) throw new Error('Retained asset reader is closed')
    const pending = Promise.resolve().then(() => {
      if (this.closed || !this.isCurrent()) throw new Error('Retained asset reader is closed')
      return consume()
    })
    this.pending.add(pending)
    try {
      const result = await pending
      if (this.closed || !this.isCurrent()) throw new Error('Retained asset reader changed during read')
      return result
    } finally {
      this.pending.delete(pending)
    }
  }

  /** Closing admission waits for actual work; it never releases durable protection. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.pending])
  }
}

async function retainAssetRoots(
  connection: DinksterConnection,
  ownerKind: 'document' | 'shown-result' | 'preview',
  context: { readonly documentLineage: string; readonly documentRevision: number; readonly clipboardText?: string } | { readonly executionKey: string } | { readonly preview: true },
  roots: ReturnType<typeof workflowAssetRoots>,
  storage: Pick<Storage, 'setItem'>,
): Promise<RetainedAssets> {
  if (roots.refusal !== undefined) throw new Error(roots.refusal)
  const digests = roots.digests
  if (digests.length > 4096) throw new Error('Workflow exceeds the retained identity limit')
  const owner = { scope: 'local', ownerKind, ownerId: `${ownerKind === 'document' ? 'workflow-candidate' : ownerKind === 'preview' ? 'asset-preview' : 'execution-result'}:${uuidv4()}` }
  const key = scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`)
  const intent = {
    version: 3, connectionId: connection.id, assetBaseUrl: connection.assetUrl(''), owner, digests, complete: roots.complete,
    ...context,
  }
  storage.setItem(key, JSON.stringify(intent))
  const matches = (value: RetainedAssets | undefined): value is RetainedAssets =>
    retentionMatches(value, owner, digests, roots.complete)
  let acknowledged: RetainedAssets
  try {
    const response = await connection.retainAssets(owner, { revision: 0, complete: roots.complete, digests })
    if (!matches(response)) {
      throw new Error('Workflow retention acknowledgment differs')
    }
    acknowledged = response
  } catch (error) {
    let observed: RetainedAssets | undefined
    try { observed = await connection.fetchRetainedAssets(owner) } catch { /* Intent remains unresolved. */ }
    if (!matches(observed)) throw error
    acknowledged = observed
  }
  storage.setItem(key, JSON.stringify({ ...intent, acknowledgedRevision: acknowledged.revision }))
  return acknowledged
}

/** Durable candidate ownership precedes publication; successful owners are not released on unmount. */
export async function admitWorkflowDispatch(
  connection: DinksterConnection,
  prepared: Extract<PreparedDocumentDispatch, { readonly ok: true }>,
  resolve: SchemaResolver,
  stillCurrent: () => boolean,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): Promise<CommandOutcome> {
  // Proposed history adds only the captured current state and trims existing records.
  const roots = workflowAssetRoots(prepared.currentDocument, prepared.currentHistory, resolve,
    [prepared.document, ...(prepared.retainedDocuments ?? [])])
  await retainWorkflowAssets(connection, prepared.document.lineage, prepared.history.revision, roots, storage)
  if (!stillCurrent()) throw new Error('Workflow destination changed during asset admission')
  return prepared.commit()
}
