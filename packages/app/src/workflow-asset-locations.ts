import { asNodeId, buildGraphConnectivity, documentNodeResolver, effectiveOccurrenceTopology, effectiveWidgetDefault, elabInputsOf, elaborateInterface, isAssetWidgetInput, occurrenceDynamicView, subgraphDefIdOf, valueKeyOf, type AssetRef, type ElaborateOptions, type Json, type LinkId, type SchemaResolver, type WorkflowDocument } from '@dinkster/core'

export function isAssetRef(value: unknown): value is AssetRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const ref = value as Partial<AssetRef>
  return Object.keys(value).length === 5 && /^blake3:[0-9a-f]{64}$/.test(ref.digest ?? '') &&
    typeof ref.name === 'string' && Number.isSafeInteger(ref.size) && (ref.size ?? -1) >= 0 &&
    typeof ref.mediaType === 'string' && typeof ref.virtualPath === 'string'
}

const EXT_KEY = 'dinkster.assetLocations'

export interface WorkflowAssetOccurrence {
  readonly graph: string
  readonly node: string
  readonly input: string
  readonly index: number
  readonly asset: AssetRef
  readonly instancePath?: readonly string[]
}

export interface AssetLocationHint {
  readonly machine: string
  readonly paths: readonly string[]
}

function instancePaths(doc: WorkflowDocument): ReadonlyMap<string, readonly string[]> {
  const paths = new Map<string, readonly string[]>()
  const visit = (graphId: string, path: readonly string[]): void => {
    if (paths.has(graphId)) return
    paths.set(graphId, path)
    for (const node of Object.values(doc.graphs[graphId]?.nodes ?? {})) {
      const child = subgraphDefIdOf(node.type)
      if (child !== undefined) visit(child, [...path, node.id])
    }
  }
  visit(doc.root, [])
  return paths
}

export interface WorkflowModelOccurrence {
  readonly graph: string
  readonly node: string
  readonly input: string
  readonly name: string
  readonly kind: string
  readonly valid: boolean
  readonly instancePath?: readonly string[]
}

/** Only active, unwired model-name fields participate in local model binding. */
export function workflowModelOccurrences(
  doc: WorkflowDocument,
  resolveSchema: SchemaResolver,
  lookupAnswers: ElaborateOptions['lookupAnswers'],
): readonly WorkflowModelOccurrence[] {
  const resolve = documentNodeResolver(doc, resolveSchema)
  const visit = (graphId: string, path: readonly string[], ancestors: ReadonlySet<string>): WorkflowModelOccurrence[] => {
    const graph = doc.graphs[graphId]
    if (graph === undefined || ancestors.has(graphId)) return []
    const nextAncestors = new Set(ancestors).add(graphId)
    const view = occurrenceDynamicView(doc, resolveSchema, path)
    const effective = path.length === 0 ? undefined : effectiveOccurrenceTopology(doc, resolveSchema, {
      instancePath: path.slice(0, -1).map(asNodeId), node: asNodeId(path[path.length - 1]!),
    })
    const connectivity = buildGraphConnectivity(effective === undefined ? graph : {
      ...graph, nets: {}, links: Object.fromEntries(effective.links.map((link, index) => {
        const id = `__model_presence_${index}` as LinkId
        return [id, { id, from: link.from.endpoint, to: link.to.endpoint }]
      })),
    })
    return Object.values(graph.nodes).flatMap((stored) => {
      if (stored.mode === 'muted' || stored.mode === 'bypassed') return []
      const child = subgraphDefIdOf(stored.type)
      if (child !== undefined) return visit(child, [...path, stored.id], nextAncestors)
      const node = { ...stored, values: view.values.get(stored.id) ?? stored.values,
        ...(view.dynamic.has(stored.id) ? { dynamic: view.dynamic.get(stored.id)! } : {}) }
      const schema = resolve(graph.id, node, path.map(asNodeId))
      if (schema === undefined) return []
      const base = connectivity(node.id)
      const inputs = [...new Set([...(base.inputPorts?.() ?? []), ...(view.inputPorts.get(node.id) ?? [])])]
      const connected = { ...base, isInputConnected: (port: string) => inputs.includes(port), inputPorts: () => inputs }
      return elabInputsOf(elaborateInterface(schema, node, connected, {
        promoteGhosts: false, ...(lookupAnswers === undefined ? {} : { lookupAnswers }),
      })).flatMap((item): WorkflowModelOccurrence[] => {
        const widget = item.spec.widget
        const input = valueKeyOf(item)
        if (item.apiName === undefined || item.spec.sent === false || connected.isInputConnected(input) ||
            !isAssetWidgetInput(item.spec) || widget?.selection === true || !widget?.kind?.startsWith('model/')) return []
        const name = item.derivedValue ?? node.values[input] ?? item.automatic?.value ?? effectiveWidgetDefault(widget)
        if (typeof name !== 'string') return []
        const valid = name.length > 0 && name.length <= 4096 && !/[\\\x00-\x1f\x7f]/.test(name) && !/^[A-Za-z]:/.test(name) &&
          !name.split('/').some((part) => part === '' || part === '.' || part === '..') &&
          (!name.includes('/') || widget.kind === 'model/text-encoder')
        return [{ graph: graph.id, node: node.id, input, name, kind: widget.kind, valid, instancePath: path }]
      })
    })
  }
  return visit(doc.root, [], new Set())
}

export function workflowAssetOccurrences(doc: WorkflowDocument): readonly WorkflowAssetOccurrence[] {
  const paths = instancePaths(doc)
  return Object.values(doc.graphs).flatMap((graph) => Object.values(graph.nodes).flatMap((node) =>
    Object.entries(node.values).flatMap(([input, value]) => {
      const values = Array.isArray(value) ? value : [value]
      return values.flatMap((asset, index) => isAssetRef(asset)
        ? [{ graph: graph.id, node: node.id, input, index, asset,
            ...(paths.has(graph.id) ? { instancePath: paths.get(graph.id)! } : {}) }] : [])
    })))
}

const isObject = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Saved hints describe previous observations, never authority to read a path. */
export function savedAssetLocation(doc: WorkflowDocument, occurrence: WorkflowAssetOccurrence): AssetLocationHint | undefined {
  const raw = doc.meta?.ext?.[EXT_KEY]
  if (!isObject(raw) || raw['version'] !== 1 || !Array.isArray(raw['observations'])) return undefined
  const observation = raw['observations'].find((entry) => isObject(entry) &&
    entry['digest'] === occurrence.asset.digest && entry['graph'] === occurrence.graph &&
    entry['node'] === occurrence.node && entry['input'] === occurrence.input && entry['index'] === occurrence.index)
  if (!isObject(observation) || typeof observation['machine'] !== 'string' ||
      !Array.isArray(observation['paths']) || !observation['paths'].every((path) => typeof path === 'string')) return undefined
  return { machine: observation['machine'], paths: observation['paths'] as readonly string[] }
}

export function stampAssetLocations(
  doc: WorkflowDocument,
  observed: ReadonlyMap<string, AssetLocationHint> | undefined,
): WorkflowDocument {
  const observations = workflowAssetOccurrences(doc).flatMap((occurrence) => {
    const hint = observed?.get(occurrence.asset.digest) ?? savedAssetLocation(doc, occurrence)
    return hint === undefined ? [] : [{
      graph: occurrence.graph, node: occurrence.node, input: occurrence.input, index: occurrence.index,
      digest: occurrence.asset.digest, machine: hint.machine, paths: [...hint.paths],
    }]
  })
  if (observations.length === 0) return doc
  return { ...doc, meta: { ...doc.meta, ext: { ...doc.meta?.ext,
    [EXT_KEY]: { version: 1, observations },
  } } }
}
