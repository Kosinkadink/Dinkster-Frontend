import { uuidv4, type DinksterConnection, type RetainedAssets } from '@dinkster/client'
import {
  documentResolver,
  parseTypedLiteralWire,
  replayHistoryOps,
  typeExprFromTypeId,
  type CommandOutcome,
  type HistorySnapshot,
  type Json,
  type PreparedDocumentDispatch,
  type SchemaResolver,
  type TypeExpr,
  type WorkflowDocument,
} from '@dinkster/core'
import { isAssetRef } from './image-editor.js'
import { scopedStorageKey } from './projects.js'

const primitiveNames = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'])
const widgetTypes = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO', 'ASSET'])

/** Strict census: unsupported state is incomplete, never an empty complete set. */
export function workflowAssetRoots(
  document: WorkflowDocument,
  history: HistorySnapshot,
  resolve: SchemaResolver,
): { readonly complete: boolean; readonly digests: readonly string[] } {
  const digests = new Set<string>()
  let complete = true
  const supported = (type: TypeExpr): boolean => {
    if (type.kind === 'asset') return true
    if (type.kind === 'list') return supported(type.element)
    if (type.kind === 'tuple') return type.elements.every(supported)
    return type.kind === 'concrete' && (type.name === 'ASSET' || primitiveNames.has(type.name))
  }
  const valueRoots = (value: Json, type: TypeExpr): void => {
    const typed = parseTypedLiteralWire(value)
    if (typed !== undefined) {
      const wrapper = value as { readonly [key: string]: Json }
      if (Object.keys(wrapper).length !== 1 || Object.keys(wrapper['$typed'] as object).length !== 2) {
        complete = false
        return
      }
      valueRoots(typed.value, typeExprFromTypeId(typed.type))
    } else if (!supported(type)) {
      complete = false
    } else if (type.kind === 'asset' || (type.kind === 'concrete' && type.name === 'ASSET')) {
      if (isAssetRef(value)) digests.add(value.digest)
      else complete = false
    } else if (type.kind === 'list') {
      if (!Array.isArray(value)) complete = false
      else for (const element of value) valueRoots(element, type.element)
    } else if (type.kind === 'tuple') {
      if (!Array.isArray(value) || value.length !== type.elements.length) complete = false
      else value.forEach((element, index) => valueRoots(element, type.elements[index]!))
    } else if (typeof value === 'object') {
      complete = false
    }
  }
  const checkExtensions = (value: Json): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) {
      for (const entry of value) checkExtensions(entry)
    } else {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'ext' && typeof entry === 'object' && entry !== null && Object.keys(entry).length > 0) {
          complete = false
        } else checkExtensions(entry)
      }
    }
  }
  const visit = (snapshot: WorkflowDocument): void => {
    checkExtensions(snapshot as unknown as Json)
    const schemas = documentResolver(snapshot, resolve)
    for (const graph of Object.values(snapshot.graphs)) {
      for (const node of Object.values(graph.nodes)) {
        const schema = schemas(node.type)
        if (schema === undefined || (node.dynamic !== undefined && Object.keys(node.dynamic).length > 0)) {
          complete = false
        }
        for (const item of schema?.items ?? []) {
          if (item.kind !== 'input' && item.kind !== 'output') complete = false
          if (item.kind === 'input') {
            if (item.dynamic !== undefined || (item.ext !== undefined && Object.keys(item.ext).length > 0)) complete = false
            if (item.widget !== undefined && !widgetTypes.has(item.widget.widgetType)) complete = false
            if (!Object.hasOwn(node.values, item.id) && item.widget?.default !== undefined) valueRoots(item.widget.default as Json, item.type)
          }
        }
        for (const [input, value] of Object.entries(node.values)) {
          const spec = schema?.items.find((item) => item.kind === 'input' && item.id === input)
          if (spec?.kind !== 'input') complete = false
          else valueRoots(value, spec.type)
        }
      }
      for (const source of Object.values(graph.valueSources ?? {})) {
        if (source.spec?.options !== undefined) complete = false
        const typed = parseTypedLiteralWire(source.value)
        if (typed === undefined) complete = false
        else valueRoots(source.value, typeExprFromTypeId(typed.type))
      }
    }
  }
  visit(document)
  for (const [records, direction] of [[history.undo, 'inverse'], [history.redo, 'forward']] as const) {
    let snapshot = document
    for (const record of [...records].reverse()) {
      const replayed = replayHistoryOps(snapshot, record[direction], { requireRecordedValues: true })
      if (replayed.stale !== undefined) complete = false
      snapshot = replayed.doc
      visit(snapshot)
    }
  }
  return { complete, digests: [...digests].sort() }
}

/** Durable candidate ownership precedes publication; successful owners are not released on unmount. */
export async function admitWorkflowDispatch(
  connection: DinksterConnection,
  prepared: Extract<PreparedDocumentDispatch, { readonly ok: true }>,
  resolve: SchemaResolver,
  stillCurrent: () => boolean,
  storage: Pick<Storage, 'setItem'> = globalThis.localStorage,
): Promise<CommandOutcome> {
  const current = workflowAssetRoots(prepared.currentDocument, prepared.currentHistory, resolve)
  const proposed = workflowAssetRoots(prepared.document, prepared.history, resolve)
  const retained = (prepared.retainedDocuments ?? []).map((document) =>
    workflowAssetRoots(document, { revision: 0, undo: [], redo: [] }, resolve))
  if (!current.complete || !proposed.complete || retained.some((roots) => !roots.complete)) throw new Error('Workflow asset identities are incomplete')
  const digests = [...new Set([...current.digests, ...proposed.digests, ...retained.flatMap((roots) => roots.digests)])].sort()
  if (digests.length > 4096) throw new Error('Workflow exceeds the retained identity limit')
  const owner = { scope: 'local', ownerKind: 'document' as const, ownerId: `workflow-candidate:${uuidv4()}` }
  const key = scopedStorageKey(`dinkster.workflow-retentions.${owner.ownerId}`)
  const intent = {
    version: 1, connectionId: connection.id, assetBaseUrl: connection.assetUrl(''), owner, digests,
    document: prepared.document, history: prepared.history,
  }
  storage.setItem(key, JSON.stringify(intent))
  const matches = (value: RetainedAssets | undefined): boolean =>
    value !== undefined && value.scope === owner.scope && value.ownerKind === owner.ownerKind &&
    value.ownerId === owner.ownerId && value.revision === 1 && value.complete &&
    value.digests.length === digests.length && value.digests.every((digest, index) => digest === digests[index])
  try {
    if (!matches(await connection.retainAssets(owner, { revision: 0, complete: true, digests }))) {
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
