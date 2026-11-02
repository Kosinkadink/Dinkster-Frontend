import { uuidv4, type DinksterConnection, type RetainedAssets } from '@dinkster/client'
import {
  EMPTY_CONNECTIVITY,
  MASK_PAINT_SOURCE_EXT_KEY,
  MAX_DYNAMIC_STATE_DEPTH,
  buildGraphConnectivity,
  documentNodeResolver,
  elabInputsOf,
  elaborateInterface,
  isAssetWidgetInput,
  maskPaintSourceNodeId,
  parseTypedLiteralWire,
  replayHistoryOps,
  typeExprFromTypeId,
  valueSourceConsumersOf,
  valueKeyOf,
  type CommandOutcome,
  type DocumentNodeResolver,
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
import { scopedStorageKey } from './projects.js'

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
  if (roots.refusal !== undefined) throw new Error(roots.refusal)
  const digests = roots.digests
  if (digests.length > 4096) throw new Error('Workflow exceeds the retained identity limit')
  const owner = { scope: 'local', ownerKind: 'document' as const, ownerId: `workflow-candidate:${uuidv4()}` }
  const key = scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`)
  const intent = {
    version: 3, connectionId: connection.id, assetBaseUrl: connection.assetUrl(''), owner, digests, complete: roots.complete,
    documentLineage: prepared.document.lineage, documentRevision: prepared.history.revision,
  }
  storage.setItem(key, JSON.stringify(intent))
  const matches = (value: RetainedAssets | undefined): boolean =>
    value !== undefined && value.scope === owner.scope && value.ownerKind === owner.ownerKind &&
    value.ownerId === owner.ownerId && value.revision === 1 && value.complete === roots.complete &&
    value.digests.length === digests.length && value.digests.every((digest, index) => digest === digests[index])
  try {
    if (!matches(await connection.retainAssets(owner, { revision: 0, complete: roots.complete, digests }))) {
      throw new Error('Workflow retention acknowledgment differs')
    }
  } catch (error) {
    let observed: RetainedAssets | undefined
    try { observed = await connection.fetchRetainedAssets(owner) } catch { /* Intent remains unresolved. */ }
    if (!matches(observed)) throw error
  }
  if (!stillCurrent()) throw new Error('Workflow destination changed during asset admission')
  return prepared.commit()
}
