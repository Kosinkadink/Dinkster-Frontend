/**
 * Subgraph definition import: the write path for materializing prepackaged
 * subgraphs (pack blueprints, exported subgraphs) into a document.
 *
 * Schema-blind and deterministic like every core command: the caller
 * has already allocated fresh
 * definition ids and rewritten internal '#<id>' references; this command
 * validates STRUCTURE (fresh ids, key/id agreement, per-def shape) and
 * writes exactly the defs it was given. Referential integrity - subgraph
 * refs resolving, no recursion, ordinal cursors - is the invariant
 * checker's job and runs on the post-transaction document, so a bad import
 * rejects atomically.
 *
 * Import is COPY semantics by design: a materialized blueprint is a fresh
 * local definition with no link back to its source. Editing the local copy
 * never syncs anywhere, exactly like pasting.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { isNodeBoundaryBinding, type BoundaryBinding, type BoundaryItem, type BoundaryRouteLeg, type ControllerMode, type DynamicPortState, type GraphDef, type GraphViewState, type GroupViewState, type Json, type JsonObject, type LinkData, type NamedNetData, type NodeData, type OccurrenceLinkEndpoint, type OccurrenceTopology, type SelectorData, type SuppressedDelivery, type ValueSourceData, type WorkflowDocument } from '../format/document.js'
import { validateBoundaryBindingShape, validateGraphDefShape, validateGraphViewShape } from '../format/validate.js'
import { actorCursorOf, asGraphDefId, asLinkId, asNetId, asNodeId, asPortId, asRerouteId, asSelectorCandidateId, asSelectorId, asValueSourceId, formatAllocatedId, isPortEndpoint, isRerouteRef, isSelectorRef, isValueSourceRef, isWidgetTapRef, occurrenceKey, portRefKey, sameEndpoint, type LinkEndpoint, type OccurrenceRef, type PortRef, type WidgetTapRef } from '../ids.js'
import { EXPOSED_EXT_KEY, parseExposedEntry } from '../format/exposed.js'
import { EXPOSED_PREVIEWS_EXT_KEY, parseExposedPreviewEntry } from '../format/exposed-previews.js'
import { APP_LAYOUT_EXT_KEY, localizeAppLayoutJson, removeAppLayoutGraphRefs } from '../format/app-layout.js'
import { checkDocument, subgraphDefIdOf } from '../invariants.js'
import { isComboValue } from '../schema/combo-options.js'
import {
  auditExtractionCuts,
  boundaryNameCandidates,
  canonicalizeLifecycleSelection,
  classifyFlattenBoundaryRoute,
  checkProspectiveExtractionDag,
  checkProspectiveFlattenDag,
  flattenShellRefusalDiagnostic,
  flattenRegistryMatchesSchemaPlan,
  hasSemanticLifecycleSelection,
  lifecycleCanonicalHash,
  missingLifecycleEntities,
  planBoundaryNames,
  planExtractedGeometry,
  planFlattenedGeometry,
  validateLifecycleGeometry,
  validateFlattenGeometry,
  verifyFlattenSchemaPlanDigest,
  verifyFlattenStatePlan,
  verifyLifecycleFlattenPlan,
  verifyLifecycleSelectionPlan,
  type BoundaryCut,
  type InputCutGroup,
  type LifecycleSelection,
  type FlattenRouteKind,
  type FlattenStatePlan,
  type ResolvedGeometryItem,
} from '../lifecycle/planner.js'
import { planFlattenOccurrenceTopology, type FlattenOccurrenceTopologyPlan } from '../compile/effective-topology.js'
import { innerConstructAddress, matchBoundaryItem } from '../compile/crossing.js'
import type { NodeSchema } from '../schema/model.js'
import { canonicalJson } from '../compile/hash.js'
import { resolveStaticWidgetTap } from '../schema/derive-boundary.js'
import { graphAllocator } from './alloc.js'
import type { CommandDefinition, CommandExecutionContext, TransactionBuilder } from './contract.js'
import { groupAllocationFloor } from '../group-alloc.js'
import { decodeModePanelConfig, MODE_PANEL_TYPE } from '../surfaces/mode-panel.js'
import { planSubgraphDefinitionCleanup } from '../lifecycle/definition-cleanup.js'
import { NET_VIEWS_EXT_KEY, netViewToJson, parseNetViewPosition, type NetViewGeometry } from '../format/net-views.js'
import { boundaryItems, boundaryOf, mapBoundaryItems } from '../format/document.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)
const warn = (code: string, message: string): Diagnostic => diag('warning', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const compareStrings = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0

const lifecycleError = (
  code: string,
  message: string,
  graphId: string,
  instancePath: readonly string[],
  nodeId?: string,
  port?: PortRef,
): Diagnostic => diag('error', 'command', code, message, {
  refs: [{ graphId, ...(nodeId !== undefined ? { nodeId } : {}), ...(port !== undefined ? { portId: port.port } : {}) }],
  ...(nodeId !== undefined ? {
    anchor: {
      occurrence: { instancePath: instancePath.map(asNodeId), node: asNodeId(nodeId) },
      ...(port !== undefined ? { port } : {}),
    },
  } : {}),
})

function contextResolves(doc: WorkflowDocument, graphId: string, instancePath: readonly string[]): boolean {
  let current = doc.graphs[doc.root]
  if (current === undefined) return false
  for (const nodeId of instancePath) {
    const node: NodeData | undefined = current.nodes[nodeId]
    const childId: string | undefined = node === undefined ? undefined : subgraphDefIdOf(node.type)
    current = childId === undefined ? undefined : doc.graphs[childId]
    if (current === undefined) return false
  }
  return current.id === graphId
}

function occurrenceRefIntersectsNodes(
  doc: WorkflowDocument,
  ref: { readonly instancePath: readonly string[]; readonly node: string },
  graphId: string,
  selectedNodes: ReadonlySet<string>,
): boolean {
  let graph = doc.graphs[doc.root]
  for (const hop of ref.instancePath) {
    if (graph?.id === graphId && selectedNodes.has(hop)) return true
    const node = graph?.nodes[hop]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    graph = childId === undefined ? undefined : doc.graphs[childId]
  }
  return graph?.id === graphId && selectedNodes.has(ref.node)
}

function occurrenceEndpointIntersectsSelection(
  endpoint: OccurrenceLinkEndpoint,
  topologyBody: string,
  graphId: string,
  selection: LifecycleSelection,
  doc: WorkflowDocument,
): boolean {
  const nodes = new Set(selection.nodeIds)
  const endpointSelected = (value: LinkEndpoint): boolean => {
    if (isPortEndpoint(value) || isWidgetTapRef(value)) return nodes.has(value.node)
    if (isRerouteRef(value)) return selection.rerouteIds.includes(value.reroute)
    if (isValueSourceRef(value)) return selection.valueSourceIds.includes(value.valueSource)
    return selection.selectorIds.includes(value.selector)
  }
  if (endpoint.kind === 'body') return topologyBody === graphId && endpointSelected(endpoint.endpoint)
  return occurrenceRefIntersectsNodes(doc, endpoint.occurrence, graphId, nodes) ||
    endpoint.route.some((leg) => leg.graph === graphId && isNodeBoundaryBinding(leg.binding) && nodes.has(leg.binding.node))
}

function extractionIntersectsOccurrenceTopology(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelection,
  excludedTopologyKey?: string,
): boolean {
  const selectedNodes = new Set(selection.nodeIds)
  for (const topology of Object.values(doc.occurrenceTopologies ?? {})) {
    if (occurrenceKey(topology.owner) === excludedTopologyKey) continue
    if (occurrenceRefIntersectsNodes(doc, topology.owner, graphId, selectedNodes)) return true
    for (const link of Object.values(topology.links)) {
      if (occurrenceEndpointIntersectsSelection(link.from, topology.bodyGraph, graphId, selection, doc) ||
          occurrenceEndpointIntersectsSelection(link.to, topology.bodyGraph, graphId, selection, doc)) return true
    }
    for (const suppression of topology.suppressedDeliveries ?? []) {
      if (suppression.kind === 'link' && topology.bodyGraph === graphId) {
        const link = doc.graphs[topology.bodyGraph]?.links[suppression.linkId]
        if (link !== undefined && (
          occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.from }, topology.bodyGraph, graphId, selection, doc) ||
          occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.to }, topology.bodyGraph, graphId, selection, doc)
        )) return true
      } else if (suppression.kind === 'netSink' && topology.bodyGraph === graphId) {
        const net = doc.graphs[topology.bodyGraph]?.nets[suppression.netId]
        if (selectedNodes.has(suppression.to.node) || (net !== undefined && selectedNodes.has(net.source.node))) return true
      } else if (suppression.kind === 'projectedLeg') {
        if (suppression.route.some((leg) => leg.graph === graphId && isNodeBoundaryBinding(leg.binding) && selectedNodes.has(leg.binding.node))) return true
        const deliveryGraph = doc.graphs[suppression.delivery.graph]
        if (deliveryGraph?.id !== graphId) continue
        if (suppression.delivery.kind === 'link') {
          const link = deliveryGraph.links[suppression.delivery.linkId]
          if (link !== undefined && (
            occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.from }, graphId, graphId, selection, doc) ||
            occurrenceEndpointIntersectsSelection({ kind: 'body', endpoint: link.to }, graphId, graphId, selection, doc)
          )) return true
        } else {
          const net = deliveryGraph.nets[suppression.delivery.netId]
          if (selectedNodes.has(suppression.delivery.to.node) || (net !== undefined && selectedNodes.has(net.source.node))) return true
        }
      }
    }
  }
  return false
}

function freshDefinitionId(doc: WorkflowDocument): string {
  let ordinal = 0
  while (Object.hasOwn(doc.graphs, `g${ordinal}`)) ordinal += 1
  return `g${ordinal}`
}

function freshDefinitionName(doc: WorkflowDocument): string {
  const names = new Set(Object.values(doc.graphs).map((graph) => graph.name))
  if (!names.has('New Subgraph')) return 'New Subgraph'
  let suffix = 2
  while (names.has(`New Subgraph ${suffix}`)) suffix += 1
  return `New Subgraph ${suffix}`
}

function remapPort(port: PortRef, nodeIds: ReadonlyMap<string, string>): PortRef {
  const node = nodeIds.get(port.node)
  if (node === undefined) throw new Error(`subgraph.extract: no node map for '${port.node}'`)
  return { ...port, node: asNodeId(node) }
}

interface ExtractIdMaps {
  readonly nodes: ReadonlyMap<string, string>
  readonly reroutes: ReadonlyMap<string, string>
  readonly valueSources: ReadonlyMap<string, string>
  readonly selectors: ReadonlyMap<string, string>
  readonly candidates: ReadonlyMap<string, string>
}

function remapEndpoint(endpoint: LinkEndpoint, ids: ExtractIdMaps): LinkEndpoint {
  const nodeIds = ids.nodes
  if (isPortEndpoint(endpoint)) return remapPort(endpoint, nodeIds)
  if (isWidgetTapRef(endpoint)) {
    const node = nodeIds.get(endpoint.node)
    if (node === undefined) throw new Error(`subgraph.extract: no node map for '${endpoint.node}'`)
    return { ...endpoint, node: asNodeId(node) }
  }
  if (isRerouteRef(endpoint)) {
    const reroute = ids.reroutes.get(endpoint.reroute)
    if (reroute === undefined) throw new Error(`subgraph.extract: no reroute map for '${endpoint.reroute}'`)
    return { reroute: asRerouteId(reroute) }
  }
  if (isValueSourceRef(endpoint)) {
    const valueSource = ids.valueSources.get(endpoint.valueSource)
    if (valueSource === undefined) throw new Error(`subgraph.extract: no value-source map for '${endpoint.valueSource}'`)
    return { valueSource: asValueSourceId(valueSource) }
  }
  const selector = ids.selectors.get(endpoint.selector)
  if (selector === undefined) throw new Error(`subgraph.extract: no selector map for '${endpoint.selector}'`)
  if (endpoint.candidate === undefined) return { selector: asSelectorId(selector) }
  const candidate = ids.candidates.get(JSON.stringify([endpoint.selector, endpoint.candidate]))
  if (candidate === undefined) throw new Error(`subgraph.extract: no selector candidate map for '${endpoint.candidate}'`)
  return { selector: asSelectorId(selector), candidate: asSelectorCandidateId(candidate) }
}

function remapBinding(binding: BoundaryBinding, nodeIds: ReadonlyMap<string, string>, rerouteIds?: ReadonlyMap<string, string>, valueSourceIds?: ReadonlyMap<string, string>): BoundaryBinding {
  if (binding.kind === 'valueSource' && valueSourceIds !== undefined) {
    const valueSource = valueSourceIds.get(binding.valueSource)
    if (valueSource === undefined) throw new Error(`subgraph.extract: no value-source map for '${binding.valueSource}'`)
    return { ...binding, valueSource: asValueSourceId(valueSource) }
  }
  if (!isNodeBoundaryBinding(binding)) return binding
  const node = nodeIds.get(binding.node)
  if (node === undefined) throw new Error(`subgraph.extract: no node map for '${binding.node}'`)
  if (binding.kind === 'port' && binding.viaReroute !== undefined) {
    const reroute = rerouteIds?.get(binding.viaReroute)
    if (reroute === undefined) throw new Error(`subgraph.extract: no reroute map for '${binding.viaReroute}'`)
    return { ...binding, node: asNodeId(node), viaReroute: asRerouteId(reroute) }
  }
  return { ...binding, node: asNodeId(node) }
}

function bindingAsEndpoint(binding: BoundaryBinding): LinkEndpoint {
  if (binding.kind === 'valueSource') return { valueSource: binding.valueSource }
  if (!isNodeBoundaryBinding(binding)) throw new Error('unbound boundary has no endpoint')
  return binding.kind === 'widgetTap'
    ? { node: binding.node, tap: binding.tap }
    : { node: binding.node, port: binding.port }
}

function endpointKey(endpoint: LinkEndpoint): string {
  if (isRerouteRef(endpoint)) return canonicalJson(['reroute', endpoint.reroute])
  if (isValueSourceRef(endpoint)) return canonicalJson(['valueSource', endpoint.valueSource])
  if (isSelectorRef(endpoint)) return canonicalJson(['selector', endpoint.selector, endpoint.candidate ?? null])
  if (isWidgetTapRef(endpoint)) return canonicalJson(['tap', endpoint.node, endpoint.tap])
  return canonicalJson(['port', endpoint.node, endpoint.port])
}

function parentPort(nodeId: string, port: string): PortRef {
  return { node: asNodeId(nodeId), port: port as PortRef['port'] }
}

function inputLinkForGroup(group: InputCutGroup, links: readonly LinkData[]): LinkData | undefined {
  if (group.source.kind !== 'link') return undefined
  const source = group.source
  if (source.linkId !== undefined) return links.find((link) => link.id === source.linkId)
  for (const target of group.targets) {
    const matching = links
      .filter((link) => sameEndpoint(link.from, source.endpoint))
      .filter((link) => isPortEndpoint(link.to) && portRefKey(link.to) === portRefKey(target))
      .sort((a, b) => compareStrings(a.id, b.id))[0]
    if (matching !== undefined) return matching
  }
  return undefined
}

function portRefFromJson(value: Json): PortRef | undefined {
  if (!isObj(value) || typeof value.node !== 'string' || typeof value.port !== 'string') return undefined
  return { node: asNodeId(value.node), port: value.port as PortRef['port'] }
}

function rewriteEnclosingInput(
  item: BoundaryItem,
  cut: BoundaryCut,
  occurrenceId: string,
  boundaryId: string,
): BoundaryItem {
  const moved = new Set(cut.movedBindings)
  const bindings = [item.binds, ...(item.alsoBinds ?? [])]
  const rewritten: BoundaryBinding[] = []
  let inserted = false
  for (const binding of bindings) {
    if (moved.has(binding)) {
      if (!inserted) {
        // A construct shown whole stays whole through the new subgraph node.
        rewritten.push({ kind: binding.kind === 'construct' ? 'construct' : 'port', node: asNodeId(occurrenceId), port: boundaryId as PortRef['port'] })
        inserted = true
      }
    } else {
      rewritten.push(binding)
    }
  }
  const { alsoBinds: _oldAlsoBinds, ...rest } = item
  return {
    ...rest,
    binds: rewritten[0]!,
    ...(rewritten.length > 1 ? { alsoBinds: rewritten.slice(1) } : {}),
  }
}

function makeInnerAllocator(actor: string | undefined): {
  mint(prefix: 'n' | 'v' | 's' | 'c' | 'r' | 'l' | 'net'): string
  cursor(): Pick<GraphDef, 'nextOrdinal' | 'actorCursors'>
} {
  let ordinal = 0
  return {
    mint(prefix) {
      return formatAllocatedId(prefix, ordinal++, actor)
    },
    cursor() {
      return actor === undefined
        ? { nextOrdinal: ordinal }
        : { nextOrdinal: 0, actorCursors: { [actor]: ordinal } }
    },
  }
}

function geometryItemsFromJson(value: Json | undefined): ResolvedGeometryItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result: ResolvedGeometryItem[] = []
  for (const item of value) {
    if (!isObj(item) || typeof item.id !== 'string' ||
        !['node', 'reroute', 'valueSource', 'selector', 'group'].includes(String(item.kind)) ||
        !['x', 'y', 'width', 'height'].every((key) => typeof item[key] === 'number')) return undefined
    result.push({
      id: item.id,
      kind: item.kind as ResolvedGeometryItem['kind'],
      x: item.x as number,
      y: item.y as number,
      width: item.width as number,
      height: item.height as number,
    })
  }
  return result
}

function translatedPosition(
  geometry: ReadonlyMap<string, ResolvedGeometryItem>,
  kind: ResolvedGeometryItem['kind'],
  oldId: string,
): { x: number; y: number } {
  const item = geometry.get(`${kind}\u0000${oldId}`)
  if (item === undefined) throw new Error(`subgraph.extract: missing translated geometry for ${kind} '${oldId}'`)
  return { x: item.x, y: item.y }
}

function remapNestedItem(
  cut: BoundaryCut,
  ids: ExtractIdMaps,
  id: string,
): BoundaryItem {
  const nested = cut.nestedItem
  if (nested === undefined) throw new Error(`subgraph.extract: boundary '${cut.itemId}' has no nested item`)
  return {
    id,
    binds: remapBinding(nested.binds, ids.nodes, ids.reroutes, ids.valueSources),
    ...(nested.alsoBinds !== undefined ? { alsoBinds: nested.alsoBinds.map((binding) => remapBinding(binding, ids.nodes, ids.reroutes, ids.valueSources)) } : {}),
    ...(nested.promoted === true ? { promoted: true } : {}),
    ...(nested.wireHidden === true ? { wireHidden: true } : {}),
    ...(nested.displayName !== undefined ? { displayName: nested.displayName } : {}),
  }
}

function validateGroupMemberships(value: Json | undefined, selection: LifecycleSelection): boolean {
  if (selection.groupIds.length === 0) return value === undefined || Array.isArray(value)
  if (!Array.isArray(value)) return false
  const byId = new Map<string, JsonObject>()
  for (const entry of value) {
    if (!isObj(entry) || typeof entry.groupId !== 'string' || byId.has(entry.groupId)) return false
    for (const field of ['nodeIds', 'rerouteIds', 'valueSourceIds', 'selectorIds']) {
      const ids = entry[field]
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return false
    }
    byId.set(entry.groupId, entry)
  }
  if (byId.size !== selection.groupIds.length) return false
  const selected = {
    nodeIds: new Set(selection.nodeIds),
    rerouteIds: new Set(selection.rerouteIds),
    valueSourceIds: new Set(selection.valueSourceIds),
    selectorIds: new Set(selection.selectorIds),
  }
  return selection.groupIds.every((groupId) => {
    const membership = byId.get(groupId)
    return membership !== undefined && Object.entries(selected).every(([field, ids]) =>
      (membership[field] as Json[]).every((id) => ids.has(id as string)))
  })
}

function hasSelectedModePanelBinding(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelection,
): boolean {
  const nodes = new Set(selection.nodeIds)
  const groups = new Set(selection.groupIds)
  for (const surface of Object.values(doc.surfaces ?? {})) {
    if (surface.type !== MODE_PANEL_TYPE) continue
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) continue
    if (decoded.config.bindings.some((binding) =>
      binding.kind !== 'unknown' && binding.graphId === graphId &&
      (binding.kind === 'node' ? nodes.has(binding.nodeId) : groups.has(binding.groupId)))) return true
  }
  return false
}

function pointInsideGroup(position: { readonly x: number; readonly y: number }, group: GroupViewState): boolean {
  return position.x >= group.bounds.x && position.x <= group.bounds.x + group.bounds.width &&
    position.y >= group.bounds.y && position.y <= group.bounds.y + group.bounds.height
}

function emptiedParentGroups(
  view: GraphViewState,
  selection: LifecycleSelection,
  resolvedGeometry: readonly ResolvedGeometryItem[],
): readonly string[] {
  const movedInside = (group: GroupViewState): boolean => resolvedGeometry.some((item) => {
    if (item.kind === 'group') return false
    return pointInsideGroup({ x: item.x + item.width / 2, y: item.y + item.height / 2 }, group)
  })
  const hasRetainedPositionable =
    Object.keys(view.nodes).some((id) => !selection.nodeIds.includes(id)) ||
    Object.keys(view.reroutes ?? {}).some((id) => !selection.rerouteIds.includes(id)) ||
    Object.keys(view.valueSources ?? {}).some((id) => !selection.valueSourceIds.includes(id)) ||
    Object.keys(view.selectors ?? {}).some((id) => !selection.selectorIds.includes(id))
  if (hasRetainedPositionable) return []
  return Object.values(view.groups ?? {})
    .filter((group) => !selection.groupIds.includes(group.id) && movedInside(group))
    .map((group) => group.id)
    .sort(compareStrings)
}

// ---------------------------------------------------------------------------
// subgraph.import {graphs: {defId: GraphDef}, view?: {defId: GraphViewState}}
// ---------------------------------------------------------------------------

const subgraphImport: CommandDefinition = {
  id: 'subgraph.import',
  run(doc, params, tx) {
    if (!isObj(params) || !isObj(params.graphs))
      return [err('params.invalid', 'subgraph.import: params must be {graphs: {defId: GraphDef}, view?}')]
    const entries = Object.entries(params.graphs)
    if (entries.length === 0)
      return [err('params.invalid', 'subgraph.import: graphs must not be empty')]

    const diags: Diagnostic[] = []
    for (const [defId, def] of entries) {
      if (doc.graphs[defId] !== undefined) {
        diags.push(err('graph.exists', `subgraph.import: definition '${defId}' already exists`))
        continue
      }
      const shape = validateGraphDefShape(def, `graphs.${defId}`)
      diags.push(...shape.map((d) => ({ ...d, message: `subgraph.import: ${d.message}` })))
      if (shape.length === 0 && (def as JsonObject).id !== defId)
        diags.push(err('params.invalid', `subgraph.import: def key '${defId}' != id '${String((def as JsonObject).id)}'`))
    }

    const view = params.view
    if (view !== undefined) {
      if (!isObj(view)) return [...diags, err('params.invalid', 'subgraph.import: view must be an object')]
      for (const [defId, gv] of Object.entries(view)) {
        if (params.graphs[defId] === undefined) {
          diags.push(err('params.invalid', `subgraph.import: view for '${defId}' has no matching graph`))
          continue
        }
        const shape = validateGraphViewShape(gv, `view.${defId}`)
        diags.push(...shape.map((d) => ({ ...d, message: `subgraph.import: ${d.message}` })))
      }
    }
    if (diags.some((d) => d.severity === 'error')) return diags

    for (const [defId, def] of entries) {
      tx.set(['graphs', defId], def)
      const gv = view !== undefined && isObj(view) ? view[defId] : undefined
      tx.set(['view', 'graphs', defId], gv ?? { nodes: {} })
    }
    return diags
  },
}

// ---------------------------------------------------------------------------
// subgraph.extract
//
// L3 owns node-only extraction plus plain links, named nets, and enclosing
// boundary rewrites. Structural/view constructs assigned to L4 refuse here
// instead of being silently omitted from the extracted definition.
// ---------------------------------------------------------------------------

const subgraphExtract: CommandDefinition = {
  id: 'subgraph.extract',
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !Array.isArray(params.instancePath) ||
        !params.instancePath.every((id) => typeof id === 'string') || !isObj(params.selection) ||
        typeof params.selectionFingerprint !== 'string') {
      return [err('params.invalid', 'subgraph.extract: params must include graphId, instancePath, selection, and selectionFingerprint')]
    }
    const graphId = params.graphId
    const instancePath = params.instancePath as string[]
    if (!contextResolves(doc, graphId, instancePath)) {
      return [lifecycleError('subgraph.lifecycle.contextInvalid', `subgraph.extract: instance path does not resolve to graph '${graphId}'`, graphId, instancePath)]
    }
    const selectionFields = ['nodeIds', 'rerouteIds', 'valueSourceIds', 'selectorIds', 'groupIds'] as const
    for (const field of selectionFields) {
      const value = params.selection[field]
      if (value !== undefined && (!Array.isArray(value) || !value.every((id) => typeof id === 'string'))) {
        return [err('params.invalid', `subgraph.extract: selection.${field} must be an array of strings`)]
      }
    }
    const selection = canonicalizeLifecycleSelection({
      nodeIds: (params.selection.nodeIds ?? []) as string[],
      rerouteIds: (params.selection.rerouteIds ?? []) as string[],
      valueSourceIds: (params.selection.valueSourceIds ?? []) as string[],
      selectorIds: (params.selection.selectorIds ?? []) as string[],
      groupIds: (params.selection.groupIds ?? []) as string[],
    })
    if (!hasSemanticLifecycleSelection(selection)) {
      return [lifecycleError('subgraph.extract.empty', 'subgraph.extract: at least one node, value source, or selector must be selected', graphId, instancePath)]
    }
    const missing = missingLifecycleEntities(doc, graphId, selection)
    if (missing.length > 0) {
      return missing.map((entity) => lifecycleError(
        'subgraph.lifecycle.selectionMissing',
        `subgraph.extract: selected ${entity.kind} entity '${entity.id}' is missing`,
        graphId,
        instancePath,
        entity.kind === 'nodeIds' ? entity.id : selection.nodeIds[0],
      ))
    }
    if (extractionIntersectsOccurrenceTopology(doc, graphId, selection)) {
      return [lifecycleError(
        'subgraph.extract.occurrenceTopologyIntersect',
        'subgraph.extract: selection intersects occurrence-owned topology; explicit remapping is not available',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }
    const freshness = verifyLifecycleSelectionPlan(doc, {
      graphId,
      selection,
      selectionFingerprint: params.selectionFingerprint,
    })
    if (freshness.stale) {
      return [lifecycleError('subgraph.lifecycle.stalePlan', 'subgraph.extract: selected entities or incident topology changed after planning', graphId, instancePath, selection.nodeIds[0])]
    }

    const resolvedGeometry = geometryItemsFromJson(params.resolvedGeometry)
    if (resolvedGeometry === undefined || !isObj(params.placementCenter) ||
        typeof params.placementCenter.x !== 'number' || typeof params.placementCenter.y !== 'number') {
      return [err('params.invalid', 'subgraph.extract: placementCenter and resolvedGeometry are required')]
    }
    const geometryCoverage = validateLifecycleGeometry(selection, resolvedGeometry)
    const geometryPlan = geometryCoverage.complete
      ? planExtractedGeometry(resolvedGeometry, { x: params.placementCenter.x, y: params.placementCenter.y })
      : undefined
    if (geometryPlan === undefined) {
      return [lifecycleError(
        'subgraph.lifecycle.boundaryUnresolved',
        'subgraph.extract: resolved geometry must be finite, complete, unique, and selection-exact',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }
    if (!validateGroupMemberships(params.groupMemberships, selection)) {
      return [lifecycleError(
        'subgraph.lifecycle.boundaryUnresolved',
        'subgraph.extract: selected group membership snapshot is missing or not fully selected',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }
    if (hasSelectedModePanelBinding(doc, graphId, selection)) {
      return [lifecycleError(
        'subgraph.lifecycle.boundaryUnresolved',
        'subgraph.extract: selected nodes or groups have durable mode-panel bindings that cannot be remapped',
        graphId,
        instancePath,
        selection.nodeIds[0],
      )]
    }

    const parent = doc.graphs[graphId]!
    if (!Array.isArray(params.specializedSlotRoots) || !Array.isArray(params.widgetTapSources)) {
      return [err('params.invalid', 'subgraph.extract: specializedSlotRoots and widgetTapSources coverage are required and must be arrays')]
    }
    const specializedSlotRoots: PortRef[] = []
    for (const value of params.specializedSlotRoots) {
      const parsed = portRefFromJson(value)
      if (parsed === undefined) return [err('params.invalid', 'subgraph.extract: specializedSlotRoots contains an invalid port reference')]
      specializedSlotRoots.push(parsed)
    }
    const widgetTapSources: WidgetTapRef[] = []
    for (const value of params.widgetTapSources) {
      if (!isObj(value) || Object.keys(value).length !== 2 ||
          typeof value.node !== 'string' || value.node.length === 0 ||
          typeof value.tap !== 'string' || value.tap.length === 0) {
        return [err('params.invalid', 'subgraph.extract: widgetTapSources contains an invalid widget tap reference')]
      }
      widgetTapSources.push({ node: asNodeId(value.node), tap: asPortId(value.tap) })
    }
    const audit = auditExtractionCuts(parent, selection, { specializedSlotRoots, widgetTapSources })
    if (audit.refusals.length > 0) {
      return audit.refusals.map((refusal) => {
        const port = refusal.endpoint !== undefined && isPortEndpoint(refusal.endpoint) ? refusal.endpoint : undefined
        const nodeId = port?.node ?? selection.nodeIds[0]
        return lifecycleError(refusal.code, `subgraph.extract: ${refusal.source} '${refusal.id}' cannot cross this extraction boundary`, graphId, instancePath, nodeId, port)
      })
    }
    const crossingWidgetTaps = audit.outputs
      .map((cut) => cut.source)
      .filter((source): source is WidgetTapRef => isWidgetTapRef(source))
    if (crossingWidgetTaps.length > 0 && context.kind === 'initial') {
      if (context.schemaResolverFor === undefined) {
        return [err('subgraph.extract.schemaAuthorityUnavailable', 'subgraph.extract: trusted schema authority is unavailable for a widget output boundary')]
      }
      try {
        const resolve = context.schemaResolverFor(doc)
        for (const source of crossingWidgetTaps) {
          const node = parent.nodes[source.node]
          const schema = node === undefined ? undefined : resolve(node.type)
          if (schema === undefined || !resolveStaticWidgetTap(schema, source.tap).ok) {
            return [lifecycleError(
              'subgraph.extract.widgetTapSchemaStale',
              `subgraph.extract: widget tap '${source.node}/${source.tap}' is not one exact static widget-backed input`,
              graphId,
              instancePath,
              source.node,
            )]
          }
        }
      } catch {
        return [err('subgraph.extract.widgetTapSchemaStale', 'subgraph.extract: widget tap schema validation failed')]
      }
    }
    const parentView = doc.view.graphs[graphId]
    const collapsedNets = new Set(parentView?.collapsedNets ?? [])
    const guideNets = new Set(parentView?.guideNets ?? [])

    const freshGraphId = freshDefinitionId(doc)
    const dag = checkProspectiveExtractionDag(doc, graphId, freshGraphId, selection.nodeIds)
    if (!dag.ok) {
      return [lifecycleError(dag.code ?? 'subgraph.lifecycle.recursive', 'subgraph.extract: prospective definition references are recursive', graphId, instancePath, selection.nodeIds[0])]
    }

    const parentCursor = tx.actor === undefined ? parent.nextOrdinal : actorCursorOf(parent.actorCursors, tx.actor)
    if (parentCursor >= Number.MAX_SAFE_INTEGER) {
      return [lifecycleError('subgraph.lifecycle.idExhausted', 'subgraph.extract: parent graph id space is exhausted', graphId, instancePath, selection.nodeIds[0])]
    }
    const parentAllocator = graphAllocator(tx, graphId, parent)
    const occurrenceId = parentAllocator.mint('n')
    const innerAllocator = makeInnerAllocator(tx.actor)
    const nodeIds = new Map<string, string>()
    const innerNodes: Record<string, NodeData> = {}
    for (const oldId of selection.nodeIds) {
      const id = innerAllocator.mint('n')
      nodeIds.set(oldId, id)
      innerNodes[id] = { ...parent.nodes[oldId]!, id: asNodeId(id) }
    }
    const valueSourceIds = new Map<string, string>()
    const innerValueSources: Record<string, ValueSourceData> = {}
    for (const oldId of selection.valueSourceIds) {
      const id = innerAllocator.mint('v')
      valueSourceIds.set(oldId, id)
      innerValueSources[id] = { ...parent.valueSources![oldId]!, id: asValueSourceId(id) }
    }
    const selectorIds = new Map<string, string>()
    const candidateIds = new Map<string, string>()
    const innerSelectors: Record<string, SelectorData> = {}
    for (const oldId of selection.selectorIds) {
      const selector = parent.selectors![oldId]!
      const id = innerAllocator.mint('s')
      selectorIds.set(oldId, id)
      const candidates = selector.candidates.map((candidate) => {
        const candidateId = innerAllocator.mint('c')
        candidateIds.set(JSON.stringify([oldId, candidate.id]), candidateId)
        return { ...candidate, id: asSelectorCandidateId(candidateId) }
      })
      const fixed = selector.policy.kind === 'fixed'
        ? candidateIds.get(JSON.stringify([oldId, selector.policy.candidate]))
        : undefined
      if (selector.policy.kind === 'fixed' && fixed === undefined) {
        return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.extract: selector '${oldId}' has an unmapped fixed candidate`, graphId, instancePath, selection.nodeIds[0])]
      }
      innerSelectors[id] = {
        ...selector,
        id: asSelectorId(id),
        candidates,
        policy: selector.policy.kind === 'fixed'
          ? { kind: 'fixed', candidate: asSelectorCandidateId(fixed!) }
          : { kind: 'random' },
      }
    }
    const rerouteIds = new Map<string, string>()
    const innerReroutes: GraphDef['reroutes'] extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.rerouteIds) {
      const id = innerAllocator.mint('r')
      rerouteIds.set(oldId, id)
      innerReroutes[id] = { ...parent.reroutes[oldId]!, id: asRerouteId(id) }
    }
    const idMaps: ExtractIdMaps = {
      nodes: nodeIds,
      valueSources: valueSourceIds,
      selectors: selectorIds,
      candidates: candidateIds,
      reroutes: rerouteIds,
    }

    const candidates = planBoundaryNames(boundaryNameCandidates(audit))
    const enclosingInputs = audit.boundaries.filter((cut) => cut.kind === 'in-cut')
    const inputNames = candidates.slice(0, audit.inputs.length)
    const enclosingInputNames = candidates.slice(audit.inputs.length, audit.inputs.length + enclosingInputs.length)
    const outputStart = audit.inputs.length + enclosingInputs.length
    const outputNames = candidates.slice(outputStart, outputStart + audit.outputs.length)
    const inputIdByBoundary = new Map(enclosingInputs.map((cut, index) => [cut.itemId, enclosingInputNames[index]!.id]))
    const outputIdBySource = new Map(audit.outputs.map((cut, index) => [endpointKey(cut.source), outputNames[index]!.id]))

    const innerBoundaryInputs: BoundaryItem[] = audit.inputs.map((cut, index) => ({
      id: inputNames[index]!.id,
      binds: { kind: 'port', ...remapPort(cut.targets[0]!, nodeIds) },
      ...(cut.targets.length > 1 ? {
        alsoBinds: cut.targets.slice(1).map((target) => ({ kind: 'port' as const, ...remapPort(target, nodeIds) })),
      } : {}),
    }))
    for (const cut of enclosingInputs) {
      const itemId = inputIdByBoundary.get(cut.itemId)!
      innerBoundaryInputs.push(remapNestedItem(cut, idMaps, itemId))
    }
    const innerBoundaryOutputs: BoundaryItem[] = []
    const wholeOutput = (cut: (typeof audit.outputs)[number]): boolean =>
      cut.boundaryItems.some(({ itemIndex }) => boundaryItems(parent.boundary, 'outputs')[itemIndex]!.binds.kind === 'construct')
    for (const [index, cut] of audit.outputs.entries()) {
      if (isValueSourceRef(cut.source)) {
        const authored = cut.boundaryItems.map(({ itemIndex }) => boundaryItems(parent.boundary, 'outputs')[itemIndex]!.binds)
          .filter((binding) => binding.kind === 'valueSource')
        const type = authored[0]?.type ?? { kind: 'wildcard' as const }
        if (authored.some((binding) => canonicalJson(binding.type) !== canonicalJson(type))) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', 'subgraph.extract: value source output boundary types disagree', graphId, instancePath)]
        }
        innerBoundaryOutputs.push({ id: outputNames[index]!.id,
          binds: { kind: 'valueSource', valueSource: asValueSourceId(valueSourceIds.get(cut.source.valueSource)!), type },
        })
      } else innerBoundaryOutputs.push({
        id: outputNames[index]!.id,
        binds: isWidgetTapRef(cut.source)
          ? { kind: 'widgetTap', node: asNodeId(nodeIds.get(cut.source.node)!), tap: cut.source.tap }
          : { kind: wholeOutput(cut) ? 'construct' : 'port', ...remapPort(cut.source, nodeIds) },
      })
    }

    const parentLinks: Record<string, LinkData> = { ...parent.links }
    const innerLinks: Record<string, LinkData> = {}
    for (const cut of audit.links) {
      if (cut.kind === 'internal') {
        delete parentLinks[cut.id]
        const id = innerAllocator.mint('l')
        innerLinks[id] = {
          ...parent.links[cut.id]!,
          id: asLinkId(id),
          from: remapEndpoint(cut.from, idMaps),
          to: remapEndpoint(cut.to, idMaps),
        }
      }
    }
    for (const [index, group] of audit.inputs.entries()) {
      if (group.source.kind !== 'link') continue
      const source = group.source
      const targetKeys = new Set(group.targets.map(portRefKey))
      const groupLinks = audit.links.filter((cut) => {
        if (cut.kind !== 'in-cut' || !sameEndpoint(cut.from, source.endpoint) || !isPortEndpoint(cut.to)) return false
        return targetKeys.has(portRefKey(cut.to))
      })
      const retained = inputLinkForGroup(group, groupLinks.map((cut) => parent.links[cut.id]!))
      if (retained === undefined) throw new Error('subgraph.extract: planned input link is missing')
      for (const cut of groupLinks) delete parentLinks[cut.id]
      parentLinks[retained.id] = { ...retained, to: parentPort(occurrenceId, inputNames[index]!.id) }
    }
    for (const cut of audit.outputs) {
      const boundaryId = outputIdBySource.get(endpointKey(cut.source))!
      for (const linkCut of audit.links) {
        if (linkCut.kind === 'out-cut' && endpointKey(linkCut.from) === endpointKey(cut.source)) {
          parentLinks[linkCut.id] = { ...parent.links[linkCut.id]!, from: parentPort(occurrenceId, boundaryId) }
        }
      }
    }

    const parentNets: Record<string, NamedNetData> = { ...parent.nets }
    const innerNets: Record<string, NamedNetData> = {}
    const innerNetIds = new Map<string, string>()
    for (const cut of audit.nets) {
      const net = parent.nets[cut.id]!
      if (cut.kind === 'internal') {
        delete parentNets[cut.id]
        const id = innerAllocator.mint('net')
        innerNetIds.set(cut.id, id)
        innerNets[id] = {
          ...net,
          id: asNetId(id),
          source: remapPort(net.source, nodeIds),
          sinks: net.sinks.map((sink) => remapPort(sink, nodeIds)),
        }
      } else if (cut.kind === 'in-cut') {
        const inputIndex = audit.inputs.findIndex((group) => group.source.kind === 'net' && group.source.netId === cut.id)
        parentNets[cut.id] = {
          ...net,
          sinks: [...cut.outsideSinks, parentPort(occurrenceId, inputNames[inputIndex]!.id)],
        }
      } else if (cut.kind === 'out-cut') {
        const boundaryId = outputIdBySource.get(endpointKey(net.source))!
        parentNets[cut.id] = {
          ...net,
          source: parentPort(occurrenceId, boundaryId),
          sinks: cut.outsideSinks,
        }
        if (cut.insideSinks.length > 0) {
          const id = innerAllocator.mint('net')
          innerNetIds.set(cut.id, id)
          innerNets[id] = {
            ...net,
            id: asNetId(id),
            source: remapPort(net.source, nodeIds),
            sinks: cut.insideSinks.map((sink) => remapPort(sink, nodeIds)),
          }
        }
      }
    }

    let parentBoundary = parent.boundary
    if (parentBoundary !== undefined) {
      const inputs = [...boundaryItems(parentBoundary, 'inputs')]
      const outputs = [...boundaryItems(parentBoundary, 'outputs')]
      for (const cut of audit.boundaries) {
        if (cut.kind === 'in-cut') {
          inputs[cut.itemIndex] = rewriteEnclosingInput(inputs[cut.itemIndex]!, cut, occurrenceId, inputIdByBoundary.get(cut.itemId)!)
        } else if (cut.kind === 'out-cut') {
          const original = outputs[cut.itemIndex]!
          const source = cut.movedBindings[0]!
          const id = outputIdBySource.get(endpointKey(bindingAsEndpoint(source)))!
          outputs[cut.itemIndex] = {
            ...original,
            binds: { kind: source.kind === 'construct' ? 'construct' : 'port', node: asNodeId(occurrenceId), port: id as PortRef['port'] },
          }
        }
      }
      parentBoundary = mapBoundaryItems(parentBoundary, (_item, side, index) => (side === 'inputs' ? inputs : outputs)[index])
    }

    const parentNodes: Record<string, NodeData> = { ...parent.nodes }
    for (const id of selection.nodeIds) delete parentNodes[id]
    parentNodes[occurrenceId] = { id: asNodeId(occurrenceId), type: `#${freshGraphId}`, values: {} }
    const parentValueSources = { ...(parent.valueSources ?? {}) }
    for (const id of selection.valueSourceIds) delete parentValueSources[id]
    const parentSelectors = { ...(parent.selectors ?? {}) }
    for (const id of selection.selectorIds) delete parentSelectors[id]
    const parentReroutes = { ...parent.reroutes }
    for (const id of selection.rerouteIds) delete parentReroutes[id]
    const innerCursor = innerAllocator.cursor()
    const freshDefinition: GraphDef = {
      id: asGraphDefId(freshGraphId),
      name: typeof params.name === 'string' && params.name.trim().length > 0 ? params.name : freshDefinitionName(doc),
      nodes: innerNodes,
      links: innerLinks,
      nets: innerNets,
      reroutes: innerReroutes,
      ...(selection.valueSourceIds.length > 0 ? { valueSources: innerValueSources } : {}),
      ...(selection.selectorIds.length > 0 ? { selectors: innerSelectors } : {}),
      boundary: boundaryOf(innerBoundaryInputs, innerBoundaryOutputs),
      nextOrdinal: innerCursor.nextOrdinal,
      ...(innerCursor.actorCursors !== undefined ? { actorCursors: innerCursor.actorCursors } : {}),
    }
    const parentViewState = doc.view.graphs[graphId] ?? { nodes: {} }
    const emptiedGroups = emptiedParentGroups(parentViewState, selection, resolvedGeometry)
    const parentViewNodes = { ...parentViewState.nodes }
    for (const id of selection.nodeIds) delete parentViewNodes[id]

    const translatedGeometry = new Map(geometryPlan.items.map((item) => [`${item.kind}\u0000${item.id}`, item]))
    const innerViewNodes: GraphViewState['nodes'] extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.nodeIds) {
      const oldView = parentViewState.nodes[oldId]
      innerViewNodes[nodeIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'node', oldId),
      }
    }
    const parentViewReroutes = { ...(parentViewState.reroutes ?? {}) }
    const innerViewReroutes: NonNullable<GraphViewState['reroutes']> extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.rerouteIds) {
      const oldView = parentViewState.reroutes?.[oldId]
      delete parentViewReroutes[oldId]
      innerViewReroutes[rerouteIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'reroute', oldId),
      }
    }
    const parentViewValueSources = { ...(parentViewState.valueSources ?? {}) }
    const innerViewValueSources: NonNullable<GraphViewState['valueSources']> extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.valueSourceIds) {
      const oldView = parentViewState.valueSources?.[oldId]
      delete parentViewValueSources[oldId]
      innerViewValueSources[valueSourceIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'valueSource', oldId),
      }
    }
    const parentViewSelectors = { ...(parentViewState.selectors ?? {}) }
    const innerViewSelectors: NonNullable<GraphViewState['selectors']> extends Readonly<Record<string, infer T>> ? Record<string, T> : never = {}
    for (const oldId of selection.selectorIds) {
      const oldView = parentViewState.selectors?.[oldId]
      delete parentViewSelectors[oldId]
      innerViewSelectors[selectorIds.get(oldId)!] = {
        ...(oldView ?? {}),
        position: translatedPosition(translatedGeometry, 'selector', oldId),
      }
    }
    const parentGroups = { ...(parentViewState.groups ?? {}) }
    const innerGroups: Record<string, GroupViewState> = {}
    for (const [index, oldId] of selection.groupIds.entries()) {
      const group = parentViewState.groups![oldId]!
      const id = `grp${index}`
      delete parentGroups[oldId]
      const position = translatedPosition(translatedGeometry, 'group', oldId)
      innerGroups[id] = { ...group, id, bounds: { ...group.bounds, ...position } }
    }
    const parentCollapsedNets = (parentViewState.collapsedNets ?? [])
      .filter((id) => !innerNetIds.has(id) || Object.hasOwn(parentNets, id))
    const innerCollapsedNets = [...innerNetIds]
      .filter(([oldId]) => collapsedNets.has(oldId))
      .map(([, newId]) => newId)
    const parentGuideNets = (parentViewState.guideNets ?? [])
      .filter((id) => !innerNetIds.has(id) || Object.hasOwn(parentNets, id))
    const innerGuideNets = [...innerNetIds]
      .filter(([oldId]) => guideNets.has(oldId))
      .map(([, newId]) => newId)
    const freshView: GraphViewState = {
      nodes: innerViewNodes,
      ...(selection.rerouteIds.length > 0 ? { reroutes: innerViewReroutes } : {}),
      ...(selection.valueSourceIds.length > 0 ? { valueSources: innerViewValueSources } : {}),
      ...(selection.selectorIds.length > 0 ? { selectors: innerViewSelectors } : {}),
      ...(selection.groupIds.length > 0 ? { groups: innerGroups, groupSeq: selection.groupIds.length } : {}),
      ...(innerCollapsedNets.length > 0 ? { collapsedNets: innerCollapsedNets } : {}),
      ...(innerGuideNets.length > 0 ? { guideNets: innerGuideNets } : {}),
    }
    const occurrenceView = { position: { ...geometryPlan.center } }
    parentViewNodes[occurrenceId] = occurrenceView

    // Tag placements for nets that moved wholly into the extracted definition
    // move with them. Node-relative offsets stay valid after the id remap;
    // absolute placements are parent-graph world coordinates, so they drop.
    // Split nets (out-cut with outside sinks) keep their parent entries.
    const rawNetViews = doc.ext?.[NET_VIEWS_EXT_KEY]
    if (Array.isArray(rawNetViews)) {
      const next: Json[] = []
      let changed = false
      for (const raw of rawNetViews) {
        const entry = parseNetViewPosition(raw)
        const movedNetId = entry !== undefined && entry.graphId === graphId && !Object.hasOwn(parentNets, entry.netId)
          ? innerNetIds.get(entry.netId)
          : undefined
        if (entry === undefined || movedNetId === undefined) {
          next.push(raw)
          continue
        }
        changed = true
        if (entry.geometry.kind !== 'offset') continue
        if (entry.role === 'sink') {
          const node = nodeIds.get(entry.to.node)
          if (node === undefined) continue
          next.push(netViewToJson({ ...entry, graphId: freshGraphId, netId: movedNetId, to: { ...entry.to, node: asNodeId(node) } }))
        } else {
          next.push(netViewToJson({ ...entry, graphId: freshGraphId, netId: movedNetId }))
        }
      }
      if (changed) tx.set(['ext', NET_VIEWS_EXT_KEY], next)
    }

    tx.set(['graphs', freshGraphId], freshDefinition as unknown as Json)
    tx.set(['view', 'graphs', freshGraphId], freshView as unknown as Json)
    tx.set(['graphs', graphId, 'nodes'], parentNodes as unknown as Json)
    tx.set(['graphs', graphId, 'links'], parentLinks as unknown as Json)
    tx.set(['graphs', graphId, 'nets'], parentNets as unknown as Json)
    tx.set(['graphs', graphId, 'reroutes'], parentReroutes as unknown as Json)
    if (parent.valueSources !== undefined || selection.valueSourceIds.length > 0) {
      tx.set(['graphs', graphId, 'valueSources'], parentValueSources as unknown as Json)
    }
    if (parent.selectors !== undefined || selection.selectorIds.length > 0) {
      tx.set(['graphs', graphId, 'selectors'], parentSelectors as unknown as Json)
    }
    if (parentBoundary !== undefined) tx.set(['graphs', graphId, 'boundary'], parentBoundary as unknown as Json)
    if (doc.view.graphs[graphId] === undefined) {
      tx.set(['view', 'graphs', graphId], {
        nodes: parentViewNodes,
        ...(Object.keys(parentViewReroutes).length > 0 ? { reroutes: parentViewReroutes } : {}),
        ...(Object.keys(parentViewValueSources).length > 0 ? { valueSources: parentViewValueSources } : {}),
        ...(Object.keys(parentViewSelectors).length > 0 ? { selectors: parentViewSelectors } : {}),
        ...(Object.keys(parentGroups).length > 0 ? { groups: parentGroups } : {}),
        ...(parentCollapsedNets.length > 0 ? { collapsedNets: parentCollapsedNets } : {}),
        ...(parentGuideNets.length > 0 ? { guideNets: parentGuideNets } : {}),
      } as unknown as Json)
    } else {
      tx.set(['view', 'graphs', graphId, 'nodes'], parentViewNodes as unknown as Json)
      if (parentViewState.reroutes !== undefined) tx.set(['view', 'graphs', graphId, 'reroutes'], parentViewReroutes as unknown as Json)
      if (parentViewState.valueSources !== undefined) tx.set(['view', 'graphs', graphId, 'valueSources'], parentViewValueSources as unknown as Json)
      if (parentViewState.selectors !== undefined) tx.set(['view', 'graphs', graphId, 'selectors'], parentViewSelectors as unknown as Json)
      if (parentViewState.groups !== undefined) tx.set(['view', 'graphs', graphId, 'groups'], parentGroups as unknown as Json)
      if (selection.groupIds.length > 0) {
        tx.set(['view', 'graphs', graphId, 'groupSeq'], groupAllocationFloor(doc, graphId))
      }
      if (parentViewState.collapsedNets !== undefined || parentCollapsedNets.length > 0) {
        tx.set(['view', 'graphs', graphId, 'collapsedNets'], parentCollapsedNets as unknown as Json)
      }
      if (parentViewState.guideNets !== undefined || parentGuideNets.length > 0) {
        tx.set(['view', 'graphs', graphId, 'guideNets'], parentGuideNets as unknown as Json)
      }
    }
    parentAllocator.commit()
    return [
      ...(geometryPlan.usedPlacementFallback
        ? [warn('subgraph.extract.placementFallback', 'subgraph.extract: no moved geometry was available; used the planned placement center')]
        : []),
      ...emptiedGroups.map((id) => warn('subgraph.extract.groupEmptied', `subgraph.extract: parent group '${id}' became empty`)),
    ]
  },
}

function flattenBoundaryTargets(
  item: BoundaryItem,
  nodeIds: ReadonlyMap<string, string>,
  rerouteIds: ReadonlyMap<string, string>,
  valueSourceIds: ReadonlyMap<string, string>,
): readonly BoundaryBinding[] {
  const bindings = [item.binds, ...(item.alsoBinds ?? [])]
  return bindings.map((binding) => remapBinding(binding, nodeIds, rerouteIds, valueSourceIds))
}

function portFromBinding(binding: BoundaryBinding): PortRef {
  if (!isNodeBoundaryBinding(binding) || binding.kind === 'widgetTap') throw new Error('boundary binding is not a port')
  return {
    node: binding.node,
    port: binding.port,
  }
}

function endpointFromBinding(binding: BoundaryBinding): LinkEndpoint {
  if (binding.kind === 'valueSource') return { valueSource: binding.valueSource }
  return binding.kind === 'widgetTap'
    ? { node: binding.node, tap: binding.tap }
    : binding.kind === 'port' && binding.viaReroute !== undefined
      ? { reroute: binding.viaReroute }
      : portFromBinding(binding)
}

function flattenRoutePlanFromJson(
  value: Json | undefined,
  body: GraphDef,
): ReadonlyMap<string, FlattenRouteKind> | undefined {
  if (!Array.isArray(value) || body.boundary === undefined) return undefined
  const expected = [
    ...boundaryItems(body.boundary, 'inputs').map((item) => ({ side: 'input', id: item.id, item })),
    ...boundaryItems(body.boundary, 'outputs').map((item) => ({ side: 'output', id: item.id, item })),
  ]
  if (value.length !== expected.length) return undefined
  const result = new Map<string, FlattenRouteKind>()
  for (const [index, entry] of value.entries()) {
    const address = expected[index]!
    if (!isObj(entry) || Object.keys(entry).length !== 3 || !Object.hasOwn(entry, 'side') ||
        !Object.hasOwn(entry, 'id') || !Object.hasOwn(entry, 'route') ||
        entry.side !== address.side || entry.id !== address.id ||
        typeof entry.route !== 'string' ||
        !['plain', 'plainWidget', 'widgetTap', 'unresolved'].includes(entry.route) ||
        (entry.side === 'output' && entry.route === 'plainWidget')) return undefined
    const key = JSON.stringify([entry.side, entry.id])
    if (result.has(key)) return undefined
    result.set(key, entry.route as FlattenRouteKind)
  }
  return result
}

function flattenStatePlanFromJson(
  value: Json | undefined,
  body: GraphDef,
): FlattenStatePlan | undefined {
  const exactKeys = (record: JsonObject, required: readonly string[], optional: readonly string[] = []): boolean => {
    const allowed = new Set([...required, ...optional])
    return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key))
  }
  const controllerModes = new Set<ControllerMode>(['fixed', 'increment', 'decrement', 'randomize'])
  const dynamicState = (entry: Json | undefined): boolean => {
    if (!isObj(entry) || !exactKeys(entry, [], ['members', 'memberLabels', 'selected', 'options', 'seq'])) return false
    if (entry.options !== undefined && (!Array.isArray(entry.options) || !entry.options.every(isComboValue))) return false
    if (entry.members !== undefined && (!Array.isArray(entry.members) ||
        !entry.members.every((member) => typeof member === 'string' && member.length > 0) ||
        new Set(entry.members).size !== entry.members.length)) return false
    if (entry.selected !== undefined && typeof entry.selected !== 'string') return false
    if (entry.memberLabels !== undefined && (!isObj(entry.memberLabels) ||
        !Object.entries(entry.memberLabels).every(([member, label]) =>
          member.length > 0 && typeof label === 'string' && label.length > 0))) return false
    return entry.seq === undefined || typeof entry.seq === 'number' && Number.isSafeInteger(entry.seq) && entry.seq >= 0
  }
  const dynamicScope = (entry: Json | undefined): boolean => isObj(entry) &&
    Object.values(entry).every((state) => dynamicState(state))
  const controllers = (entry: Json | undefined): boolean => isObj(entry) &&
    Object.values(entry).every((mode) => typeof mode === 'string' && controllerModes.has(mode as ControllerMode))
  const snapshot = (entry: Json | undefined): boolean => isObj(entry) &&
    exactKeys(entry, ['node', 'type', 'values'], ['controllers', 'dynamic']) &&
    typeof entry.node === 'string' && typeof entry.type === 'string' && isObj(entry.values) &&
    (entry.controllers === undefined || controllers(entry.controllers) && Object.keys(entry.controllers as JsonObject).length > 0) &&
    (entry.dynamic === undefined || dynamicScope(entry.dynamic) && Object.keys(entry.dynamic as JsonObject).length > 0)
  if (!isObj(value) || value.version !== 'subgraph-flatten-state-plan-v1' ||
      (value.status !== 'ready' && value.status !== 'refused') || !isObj(value.source) ||
      !exactKeys(value.source, ['occurrence', 'bodyNodes']) || !snapshot(value.source.occurrence) ||
      !Array.isArray(value.source.bodyNodes) || !value.source.bodyNodes.every(snapshot)) return undefined
  const nodeIds = Object.keys(body.nodes).sort(compareStrings)
  if (value.source.bodyNodes.length !== nodeIds.length) return undefined
  for (const [index, entry] of value.source.bodyNodes.entries()) {
    if (!isObj(entry) || entry.node !== nodeIds[index] || entry.type !== body.nodes[nodeIds[index]!]!.type) return undefined
  }
  const refusalCodes = new Set([
    'subgraph.flatten.stateUnresolved',
    'subgraph.flatten.dormantStateUnsupported',
    'subgraph.lifecycle.boundaryUnresolved',
    'subgraph.lifecycle.idExhausted',
  ])
  if (value.status === 'refused') {
    if (!exactKeys(value, ['version', 'status', 'source', 'refusal']) || !isObj(value.refusal) ||
        !exactKeys(value.refusal, ['code', 'message'], ['side', 'boundaryId', 'key', 'address']) ||
        typeof value.refusal.code !== 'string' || !refusalCodes.has(value.refusal.code) ||
        typeof value.refusal.message !== 'string' ||
        (value.refusal.side !== undefined && value.refusal.side !== 'input' && value.refusal.side !== 'output') ||
        (value.refusal.boundaryId !== undefined && (typeof value.refusal.boundaryId !== 'string' || value.refusal.side === undefined)) ||
        (value.refusal.key !== undefined && typeof value.refusal.key !== 'string') ||
        (value.refusal.address !== undefined && (!isObj(value.refusal.address) ||
          !exactKeys(value.refusal.address, ['port']) || typeof value.refusal.address.port !== 'string' || value.refusal.address.port.length === 0))) return undefined
    return value as unknown as FlattenStatePlan
  }
  if (!exactKeys(value, ['version', 'status', 'source', 'nodes', 'routes', 'enclosingRewrites']) ||
      !Array.isArray(value.nodes) || !Array.isArray(value.routes) || !Array.isArray(value.enclosingRewrites) ||
      value.nodes.length !== nodeIds.length) return undefined
  for (const [index, entry] of value.nodes.entries()) {
    if (!snapshot(entry) || !isObj(entry) || entry.node !== nodeIds[index] || entry.type !== body.nodes[nodeIds[index]!]!.type) return undefined
  }
  const binding = (entry: Json | undefined): boolean => isObj(entry) && (
    entry.kind === 'valueSource'
      ? exactKeys(entry, ['kind', 'valueSource', 'type']) && validateBoundaryBindingShape(entry).length === 0
      : entry.kind === 'widgetTap'
      ? exactKeys(entry, ['kind', 'node', 'tap']) && typeof entry.node === 'string' &&
        typeof entry.tap === 'string' && entry.tap.length > 0
      : entry.kind === 'construct'
      ? exactKeys(entry, ['kind', 'node', 'port']) && typeof entry.node === 'string' &&
        typeof entry.port === 'string' && entry.port.length > 0
      : exactKeys(entry, ['kind', 'node', 'port'], ['viaReroute']) &&
        entry.kind === 'port' && typeof entry.node === 'string' &&
        typeof entry.port === 'string' && entry.port.length > 0 &&
        (entry.viaReroute === undefined ||
          typeof entry.viaReroute === 'string' && entry.viaReroute.length > 0)
  )
  const expected = [
    ...(boundaryItems(body.boundary, 'inputs') ?? []).map((item) => ({ side: 'input', item })),
    ...(boundaryItems(body.boundary, 'outputs') ?? []).map((item) => ({ side: 'output', item })),
  ]
  if (value.routes.length !== expected.length) return undefined
  for (const [index, route] of value.routes.entries()) {
    const address = expected[index]!
    if (!isObj(route) || !exactKeys(route, ['side', 'id', 'bindingCount']) ||
        route.side !== address.side || route.id !== address.item.id ||
        route.bindingCount !== 1 + (address.item.alsoBinds?.length ?? 0)) return undefined
  }
  const rewriteKeys = new Set<string>()
  for (const rewrite of value.enclosingRewrites) {
    if (!isObj(rewrite) || !exactKeys(rewrite, ['side', 'itemIndex', 'itemId', 'bindingIndex', 'before', 'after']) ||
        (rewrite.side !== 'input' && rewrite.side !== 'output') ||
        typeof rewrite.itemIndex !== 'number' || !Number.isSafeInteger(rewrite.itemIndex) || rewrite.itemIndex < 0 ||
        typeof rewrite.itemId !== 'string' || rewrite.itemId.length === 0 ||
        typeof rewrite.bindingIndex !== 'number' || !Number.isSafeInteger(rewrite.bindingIndex) || rewrite.bindingIndex < 0 ||
        !binding(rewrite.before) || !Array.isArray(rewrite.after) || rewrite.after.length === 0 || !rewrite.after.every(binding) ||
        rewrite.side === 'output' && rewrite.after.length !== 1) return undefined
    const key = JSON.stringify([rewrite.side, rewrite.itemIndex, rewrite.bindingIndex])
    if (rewriteKeys.has(key)) return undefined
    rewriteKeys.add(key)
  }
  return value as unknown as FlattenStatePlan
}

function flattenBodySelection(body: GraphDef, view: GraphViewState | undefined): LifecycleSelection {
  return canonicalizeLifecycleSelection({
    nodeIds: Object.keys(body.nodes),
    rerouteIds: Object.keys(body.reroutes),
    valueSourceIds: Object.keys(body.valueSources ?? {}),
    selectorIds: Object.keys(body.selectors ?? {}),
    groupIds: Object.keys(view?.groups ?? {}),
  })
}

function stagedFlattenIdentitiesContainNul(statePlan: Extract<FlattenStatePlan, { status: 'ready' }>): boolean {
  const hasNul = (value: string): boolean => value.includes(String.fromCharCode(0))
  const sourceNodes = new Map(statePlan.source.bodyNodes.map((node) => [node.node, node]))
  const changedDynamicHasNul = (
    before: Readonly<Record<string, DynamicPortState>> | undefined,
    after: Readonly<Record<string, DynamicPortState>> | undefined,
  ): boolean => {
    for (const construct of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      const beforeState = before?.[construct]
      const afterState = after?.[construct]
      const beforeMembers = new Set(beforeState?.members ?? [])
      const afterMembers = new Set(afterState?.members ?? [])
      if ([...beforeMembers].some((member) => !afterMembers.has(member) && hasNul(member)) ||
          [...afterMembers].some((member) => !beforeMembers.has(member) && hasNul(member))) return true
    }
    return false
  }
  for (const node of statePlan.nodes) {
    const source = sourceNodes.get(node.node)
    if (source === undefined) return true
    if (changedDynamicHasNul(source.dynamic, node.dynamic)) return true
    for (const key of new Set([...Object.keys(source.values), ...Object.keys(node.values)])) {
      if ((!Object.hasOwn(source.values, key) || !Object.hasOwn(node.values, key) ||
          canonicalJson(source.values[key]) !== canonicalJson(node.values[key])) && hasNul(key)) return true
    }
    for (const key of new Set([...Object.keys(source.controllers ?? {}), ...Object.keys(node.controllers ?? {})])) {
      if ((!Object.hasOwn(source.controllers ?? {}, key) || !Object.hasOwn(node.controllers ?? {}, key) ||
          source.controllers?.[key] !== node.controllers?.[key]) && hasNul(key)) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// subgraph.flatten
//
// Flatten consumes only the immutable route/schema plan supplied by the
// planner. It never consults the live schema registry, which is important for
// deterministic shared replay.
// ---------------------------------------------------------------------------

type OccurrenceTopologyOverlay = NonNullable<WorkflowDocument['occurrenceTopologies']>[string]

function flattenPlanNetExtension(doc: WorkflowDocument, plan: Json | undefined): boolean {
  if (!isObj(plan)) return false
  return [plan.links, plan.projectedParentLinks].some((group) => Array.isArray(group) && group.some((link) => {
    if (!isObj(link) || !isObj(link.identity)) return false
    const identity = link.identity
    const net = (identity.kind === 'definitionNetSink' || identity.kind === 'parentNetSink') &&
        typeof identity.graphId === 'string' && typeof identity.netId === 'string'
      ? doc.graphs[identity.graphId]?.nets[identity.netId as never]
      : identity.kind === 'parentLeg' && isObj(identity.delivery) && identity.delivery.kind === 'netSink' &&
          typeof identity.delivery.graph === 'string' && typeof identity.delivery.netId === 'string'
        ? doc.graphs[identity.delivery.graph]?.nets[identity.delivery.netId as never]
        : undefined
    return net?.ext !== undefined && Object.keys(net.ext).length > 0
  }))
}

/** One refusal sequence shared by validateDispatch and run so both paths
 * refuse identical inputs with identical diagnostics in identical order. */
function flattenOccurrenceTopologyRefusal(
  doc: WorkflowDocument,
  topology: OccurrenceTopologyOverlay | undefined,
  occurrencePlan: Json | undefined,
  graphId: string,
  instancePath: readonly string[],
  nodeId: string,
): Diagnostic | undefined {
  if (topology?.ext !== undefined && Object.keys(topology.ext).length > 0) {
    return lifecycleError(
      'subgraph.flatten.occurrenceTopologyExtensionUnsupported',
      'subgraph.flatten: occurrence topology extension state has no flattened owner',
      graphId,
      instancePath,
      nodeId,
    )
  }
  if (occurrencePlan === undefined) return undefined
  if (flattenPlanNetExtension(doc, occurrencePlan)) {
    return lifecycleError(
      'subgraph.flatten.netExtensionUnsupported',
      'subgraph.flatten: effective net extension state cannot be represented by ordinary links',
      graphId,
      instancePath,
      nodeId,
    )
  }
  if (graphId !== doc.root || instancePath.length !== 0) {
    return lifecycleError(
      'subgraph.flatten.occurrenceTopologyContextUnsupported',
      'subgraph.flatten: drilled occurrence topology requires definition specialization',
      graphId,
      instancePath,
      nodeId,
    )
  }
  return undefined
}

function validateFlattenDispatch(
  doc: WorkflowDocument,
  params: Json,
  context: CommandExecutionContext,
): readonly Diagnostic[] {
  if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string' ||
      !Array.isArray(params.instancePath) || !params.instancePath.every((id) => typeof id === 'string') ||
      !Array.isArray(params.boundaryPlan) || !isObj(params.schemaSnapshot) ||
      !isObj(params.statePlan) || typeof params.schemaPlanDigest !== 'string' ||
      typeof params.selectionFingerprint !== 'string') {
    return [err('params.invalid', 'subgraph.flatten: malformed trusted plan')]
  }
  const parent = doc.graphs[params.graphId]
  const occurrence = parent?.nodes[params.nodeId]
  const bodyId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
  const body = bodyId === undefined ? undefined : doc.graphs[bodyId]
  if (parent === undefined || occurrence === undefined || body?.boundary === undefined) return []
  const routes = flattenRoutePlanFromJson(params.boundaryPlan, body)
  const statePlan = flattenStatePlanFromJson(params.statePlan, body)
  if (routes === undefined || statePlan === undefined) return [err('params.invalid', 'subgraph.flatten: plan shape or coverage is invalid')]

  const snapshot = params.schemaSnapshot as unknown as Record<string, never>
  const boundAuthoredTypes = new Set(Object.values(body.nodes).map((node) => node.type))
  for (const item of [...boundaryItems(body.boundary, 'inputs'), ...boundaryItems(body.boundary, 'outputs')]) {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (!isNodeBoundaryBinding(binding)) continue
      const authoredType = body.nodes[binding.node]?.type
      if (authoredType !== undefined) boundAuthoredTypes.add(authoredType)
    }
  }
  for (const [authoredType, schema] of Object.entries(snapshot)) {
    if (!boundAuthoredTypes.has(authoredType) || !isObj(schema as unknown as Json) ||
        typeof (schema as unknown as JsonObject).type !== 'string' ||
        !Array.isArray((schema as unknown as JsonObject).body)) {
      return [err('params.invalid', 'subgraph.flatten: schema snapshot has invalid authored-type coverage')]
    }
  }
  const owner = { instancePath: params.instancePath as string[], node: params.nodeId }
  const topology = doc.occurrenceTopologies?.[occurrenceKey(owner as never)]
  const occurrencePlanValue = params.occurrenceTopologyPlan
  const occurrenceDigest = params.occurrenceTopologyPlanDigest
  if (topology === undefined && (occurrencePlanValue !== undefined || occurrenceDigest !== undefined)) {
    return [err('params.invalid', 'subgraph.flatten: occurrence topology plan is unexpected')]
  }
  const topologyRefusal = flattenOccurrenceTopologyRefusal(
    doc, topology, occurrencePlanValue, params.graphId, params.instancePath as string[], params.nodeId)
  if (topologyRefusal !== undefined) return [topologyRefusal]
  if (topology !== undefined) {
    if (!isObj(occurrencePlanValue) || occurrencePlanValue.version !== 'subgraph-flatten-occurrence-plan-v1' ||
        !Array.isArray(occurrencePlanValue.links) || !Array.isArray(occurrencePlanValue.projectedParentLinks) ||
        !occurrencePlanValue.projectedParentLinks.every((link) => isObj(link) && typeof link.fromGraphId === 'string' && typeof link.toGraphId === 'string') ||
        typeof occurrenceDigest !== 'string') {
      return [err('params.invalid', 'subgraph.flatten: occurrence topology plan is required and malformed')]
    }
    if (lifecycleCanonicalHash(occurrencePlanValue) !== occurrenceDigest) {
      return [err('params.invalid', 'subgraph.flatten: occurrence topology plan digest does not match')]
    }
    const recomputed = planFlattenOccurrenceTopology(doc, (type) => snapshot[type], owner as never)
    if (recomputed.plan === undefined || recomputed.diagnostics.some((diagnostic) => diagnostic.severity === 'error') ||
        canonicalJson(recomputed.plan) !== canonicalJson(occurrencePlanValue)) {
      return [err('params.invalid', 'subgraph.flatten: occurrence topology plan does not match semantic recomputation')]
    }
  }
  const expected = [
    ...boundaryItems(body.boundary, 'inputs').map((item) => ({ side: 'input', item } as const)),
    ...boundaryItems(body.boundary, 'outputs').map((item) => ({ side: 'output', item } as const)),
  ]
  for (const { side, item } of expected) {
    const route = routes.get(JSON.stringify([side, item.id]))
    if (route === 'plain' || route === 'plainWidget') {
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (!isNodeBoundaryBinding(binding)) continue
        const authoredType = body.nodes[binding.node]?.type
        if (authoredType === undefined || !Object.hasOwn(snapshot, authoredType)) {
          return [err('params.invalid', 'subgraph.flatten: boundary route requires a missing authored schema')]
        }
      }
    }
    if (route !== classifyFlattenBoundaryRoute(body, item, (type) => snapshot[type], side)) {
      return [err('params.invalid', 'subgraph.flatten: boundary route does not match the snapshot')]
    }
  }
  if (!verifyFlattenSchemaPlanDigest(snapshot, params.schemaPlanDigest, params.boundaryPlan as never, statePlan)) {
    return [err('params.invalid', 'subgraph.flatten: schemaPlanDigest checksum does not match the snapshot and plans')]
  }
  if (!verifyFlattenStatePlan(body, occurrence, parent, snapshot, params.boundaryPlan as never, statePlan)) {
    return [err('params.invalid', 'subgraph.flatten: statePlan does not match semantic recomputation')]
  }
  const plannedRoutes = [...routes.entries()]
  const unsupportedRoutes = plannedRoutes.filter(([, route]) => route === 'unresolved')
  if (statePlan.status === 'ready' && unsupportedRoutes.length > 0) {
    return [err('params.invalid', 'subgraph.flatten: ready statePlan cannot bypass a remainder refusal')]
  }
  if (statePlan.status === 'refused') {
    const refusalRoute = statePlan.refusal.side !== undefined && statePlan.refusal.boundaryId !== undefined
      ? routes.get(JSON.stringify([statePlan.refusal.side, statePlan.refusal.boundaryId]))
      : unsupportedRoutes[0]?.[1]
    const expectedRefusal = refusalRoute === 'unresolved' ? 'subgraph.flatten.stateUnresolved' : undefined
    if (statePlan.refusal.boundaryId !== undefined && refusalRoute === undefined) {
      return [err('params.invalid', 'subgraph.flatten: planner refusal names no verified boundary route')]
    }
    if (expectedRefusal !== undefined && statePlan.refusal.code !== expectedRefusal) {
      return [err('params.invalid', 'subgraph.flatten: planner refusal does not match the verified boundary routes')]
    }
  }
  const freshness = verifyLifecycleFlattenPlan(doc, params.graphId, params.nodeId, params.selectionFingerprint, {
    boundaryPlan: params.boundaryPlan,
    statePlan: params.statePlan,
    schemaPlanDigest: params.schemaPlanDigest,
    ...(occurrencePlanValue !== undefined ? {
      occurrenceTopologyPlan: occurrencePlanValue,
      occurrenceTopologyPlanDigest: occurrenceDigest,
    } : {}),
  })
  if (freshness.stale) {
    return [lifecycleError('subgraph.lifecycle.stalePlan', 'subgraph.flatten: document or trusted plan changed after planning', params.graphId, [], params.nodeId)]
  }
  if (context.kind === 'initial') {
    if (context.schemaResolverFor === undefined) {
      return [err('subgraph.flatten.schemaAuthorityUnavailable', 'subgraph.flatten: trusted schema authority is unavailable')]
    }
    let matches = false
    try {
      const liveResolver = context.schemaResolverFor(doc)
      const gainedSchemas = [...boundAuthoredTypes].some((authoredType) =>
        !Object.hasOwn(snapshot, authoredType) && liveResolver(authoredType) !== undefined)
      matches = flattenRegistryMatchesSchemaPlan(
        snapshot,
        params.schemaPlanDigest,
        liveResolver,
        params.boundaryPlan as never,
        statePlan,
      ) && !gainedSchemas
    } catch {
      matches = false
    }
    if (!matches) return [err('subgraph.flatten.schemaPlanStale', 'subgraph.flatten: live schema registry differs from the planned snapshot')]
  }
  return []
}

const subgraphFlatten: CommandDefinition = {
  id: 'subgraph.flatten',
  validateDispatch(doc, params, context) {
    return validateFlattenDispatch(doc, params, context)
  },
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !Array.isArray(params.instancePath) ||
        !params.instancePath.every((id) => typeof id === 'string') || typeof params.nodeId !== 'string' ||
        typeof params.selectionFingerprint !== 'string' || !isObj(params.placementCenter) ||
        typeof params.placementCenter.x !== 'number' || typeof params.placementCenter.y !== 'number' ||
        !isObj(params.resolvedGeometry) || !Array.isArray(params.boundaryPlan) || !isObj(params.statePlan) ||
        !isObj(params.schemaSnapshot) || typeof params.schemaPlanDigest !== 'string') {
      return [err('params.invalid', 'subgraph.flatten: params must include graphId, instancePath, nodeId, placementCenter, resolvedGeometry, boundaryPlan, statePlan, schemaSnapshot, schemaPlanDigest, and selectionFingerprint')]
    }
    const graphId = params.graphId
    const instancePath = params.instancePath as string[]
    const nodeId = params.nodeId
    if (!contextResolves(doc, graphId, instancePath)) {
      return [lifecycleError('subgraph.lifecycle.contextInvalid', `subgraph.flatten: instance path does not resolve to graph '${graphId}'`, graphId, instancePath, nodeId)]
    }
    const parent = doc.graphs[graphId]!
    const occurrence = parent.nodes[nodeId]
    const bodyId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
    const body = bodyId === undefined ? undefined : doc.graphs[bodyId]
    if (occurrence === undefined || bodyId === undefined || body === undefined || body.boundary === undefined) {
      return [lifecycleError('subgraph.flatten.notOccurrence', 'subgraph.flatten: target is not a resolvable subgraph occurrence', graphId, instancePath, nodeId)]
    }
    const topologyOwner = { instancePath: instancePath.map(asNodeId), node: asNodeId(nodeId) }
    const topologyKey = occurrenceKey(topologyOwner)
    const occurrencePlan = params.occurrenceTopologyPlan as unknown as FlattenOccurrenceTopologyPlan | undefined
    const selectedTopology = doc.occurrenceTopologies?.[topologyKey]
    const topologyRefusal = flattenOccurrenceTopologyRefusal(
      doc, selectedTopology, params.occurrenceTopologyPlan, graphId, instancePath, nodeId)
    if (topologyRefusal !== undefined) return [topologyRefusal]
    const descendantPrefix = [...topologyOwner.instancePath, topologyOwner.node]
    const hasDescendantTopology = Object.values(doc.occurrenceTopologies ?? {}).some((topology) =>
      occurrenceKey(topology.owner) !== topologyKey &&
      descendantPrefix.every((hop, index) => topology.owner.instancePath[index] === hop))
    if (hasDescendantTopology) {
      return [lifecycleError(
        'subgraph.flatten.occurrenceTopologyDescendantUnsupported',
        'subgraph.flatten: nested occurrence topology requires an explicit owner remap',
        graphId,
        instancePath,
        nodeId,
      )]
    }
    if (extractionIntersectsOccurrenceTopology(doc, graphId, {
      nodeIds: [nodeId], rerouteIds: [], valueSourceIds: [], selectorIds: [], groupIds: [],
    }, topologyKey)) {
      return [lifecycleError(
        'subgraph.flatten.occurrenceTopologyIntersection',
        'subgraph.flatten: another occurrence topology references the transformed definition region',
        graphId,
        instancePath,
        nodeId,
      )]
    }
    const shellRefusal = flattenShellRefusalDiagnostic(occurrence, graphId, instancePath, nodeId)
    if (shellRefusal !== undefined) return [shellRefusal]
    if (occurrence.ext !== undefined && Object.keys(occurrence.ext).length > 0) {
      return [lifecycleError('subgraph.flatten.extensionStateUnsupported', 'subgraph.flatten: occurrence-owned extension state has no flattened owner', graphId, instancePath, nodeId)]
    }
    const boundaryInputs = new Map(boundaryItems(body.boundary, 'inputs').map((item) => [item.id, item]))
    const boundaryOutputs = new Map(boundaryItems(body.boundary, 'outputs').map((item) => [item.id, item]))
    if ([...boundaryItems(body.boundary, 'inputs'), ...boundaryItems(body.boundary, 'outputs')].some((item) =>
      item.ext !== undefined && Object.keys(item.ext).length > 0)) {
      return [lifecycleError('subgraph.flatten.boundaryExtensionUnsupported', 'subgraph.flatten: body boundary extension state has no flattened owner', graphId, instancePath, nodeId)]
    }
    const routePlan = flattenRoutePlanFromJson(params.boundaryPlan, body)
    if (routePlan === undefined) {
      return [err('params.invalid', 'subgraph.flatten: boundaryPlan and schema snapshot must have exact coverage and a valid schemaPlanDigest')]
    }
    const statePlan = flattenStatePlanFromJson(params.statePlan, body)
    if (statePlan === undefined) {
      return [err('params.invalid', 'subgraph.flatten: statePlan must have exact source, node, route, and target coverage')]
    }
    const planEvidence = {
      boundaryPlan: params.boundaryPlan,
      statePlan: params.statePlan,
      schemaPlanDigest: params.schemaPlanDigest,
      ...(occurrencePlan !== undefined ? {
        occurrenceTopologyPlan: params.occurrenceTopologyPlan,
        occurrenceTopologyPlanDigest: params.occurrenceTopologyPlanDigest,
      } : {}),
    }
    const freshness = verifyLifecycleFlattenPlan(doc, graphId, nodeId, params.selectionFingerprint, planEvidence)
    if (freshness.stale) {
      return [lifecycleError('subgraph.lifecycle.stalePlan', 'subgraph.flatten: occurrence, body, incident topology, or view changed after planning', graphId, instancePath, nodeId)]
    }
    const currentSource = {
      occurrence: {
        node: occurrence.id,
        type: occurrence.type,
        values: occurrence.values,
        ...(occurrence.controllers !== undefined && Object.keys(occurrence.controllers).length > 0 ? { controllers: occurrence.controllers } : {}),
        ...(occurrence.dynamic !== undefined && Object.keys(occurrence.dynamic).length > 0 ? { dynamic: occurrence.dynamic } : {}),
      },
      bodyNodes: Object.values(body.nodes).sort((a, b) => compareStrings(a.id, b.id)).map((node) => ({
        node: node.id,
        type: node.type,
        values: node.values,
        ...(node.controllers !== undefined && Object.keys(node.controllers).length > 0 ? { controllers: node.controllers } : {}),
        ...(node.dynamic !== undefined && Object.keys(node.dynamic).length > 0 ? { dynamic: node.dynamic } : {}),
      })),
    }
    if (canonicalJson(statePlan.source) !== canonicalJson(currentSource)) {
      return [err('params.invalid', 'subgraph.flatten: statePlan source must exactly match occurrence and body state')]
    }
    if (statePlan.status === 'refused') {
      return [lifecycleError(statePlan.refusal.code, `subgraph.flatten: ${statePlan.refusal.message}`, graphId, instancePath, nodeId)]
    }
    if (hasSelectedModePanelBinding(doc, graphId, canonicalizeLifecycleSelection({ nodeIds: [nodeId] }))) {
      return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', 'subgraph.flatten: a durable mode-panel binding targets the occurrence', graphId, instancePath, nodeId)]
    }

    const bodyView = doc.view.graphs[bodyId]
    const bodySelection = flattenBodySelection(body, bodyView)
    const occurrenceItems = geometryItemsFromJson([params.resolvedGeometry.occurrence] as unknown as Json)
    const bodyItems = geometryItemsFromJson(params.resolvedGeometry.body)
    const occurrenceGeometry = occurrenceItems?.length === 1 && occurrenceItems[0]!.id === nodeId
      ? occurrenceItems[0]
      : undefined
    const geometryCoverage = bodyItems === undefined
      ? undefined
      : validateFlattenGeometry(occurrenceGeometry, bodySelection, bodyItems)
    const occurrenceCenter = occurrenceGeometry === undefined ? undefined : {
      x: occurrenceGeometry.x + occurrenceGeometry.width / 2,
      y: occurrenceGeometry.y + occurrenceGeometry.height / 2,
    }
    const placementMatchesOccurrence = occurrenceCenter !== undefined &&
      occurrenceCenter.x === params.placementCenter.x && occurrenceCenter.y === params.placementCenter.y
    const geometryPlan = geometryCoverage?.complete === true && placementMatchesOccurrence
      ? planFlattenedGeometry(bodyItems!, occurrenceCenter)
      : undefined
    if (geometryPlan === undefined) {
      return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', 'subgraph.flatten: resolved geometry must be finite, complete, unique, and body-exact', graphId, instancePath, nodeId)]
    }
    const dag = checkProspectiveFlattenDag(doc, graphId, nodeId)
    if (!dag.ok) {
      return [lifecycleError(dag.code ?? 'subgraph.lifecycle.recursive', 'subgraph.flatten: prospective definition references are recursive', graphId, instancePath, nodeId)]
    }

    for (const link of Object.values(parent.links)) {
      if (isPortEndpoint(link.to) && link.to.node === nodeId) {
        const match = matchBoundaryItem(boundaryItems(body.boundary, 'inputs'), link.to)
        if (!match.ok) return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: input '${link.to.port}' has no unique body boundary route`, graphId, instancePath, nodeId, link.to)]
      }
      if (isPortEndpoint(link.from) && link.from.node === nodeId) {
        const match = matchBoundaryItem(boundaryItems(body.boundary, 'outputs'), link.from)
        if (!match.ok) return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: output '${link.from.port}' has no unique body boundary route`, graphId, instancePath, nodeId, link.from)]
      }
      if (isWidgetTapRef(link.from) && link.from.node === nodeId) {
        const input = boundaryInputs.get(link.from.tap)
        const route = routePlan.get(JSON.stringify(['input', link.from.tap]))
        if (input === undefined || input.promoted !== true || route !== 'plainWidget' ||
            input.alsoBinds?.some((binding) => binding.kind !== 'port')) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: boundary tap '${link.from.tap}' is not one static promoted plain input`, graphId, instancePath, nodeId)]
        }
      }
    }
    for (const net of Object.values(parent.nets)) {
      if (net.source.node === nodeId && !matchBoundaryItem(boundaryItems(body.boundary, 'outputs'), net.source).ok) {
        return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: net source '${net.source.port}' has no unique body boundary route`, graphId, instancePath, nodeId, net.source)]
      }
      for (const sink of net.sinks) {
        if (sink.node === nodeId && !matchBoundaryItem(boundaryItems(body.boundary, 'inputs'), sink).ok) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: net sink '${sink.port}' has no unique body boundary route`, graphId, instancePath, nodeId, sink)]
        }
      }
    }

    const additionalDeliveries = occurrencePlan === undefined ? Object.values(parent.links).reduce((count, link) => {
      if (!isPortEndpoint(link.to) || link.to.node !== nodeId) return count
      const match = matchBoundaryItem(boundaryItems(body.boundary, 'inputs'), link.to)
      return count + (match.ok ? Math.max(0, match.item.alsoBinds?.length ?? 0) : 0)
    }, 0) : 0
    const netJunctionDeliveries = occurrencePlan === undefined ? Object.values(parent.nets).flatMap((net) =>
      net.sinks.filter((sink) => sink.node === nodeId).flatMap((sink) => {
        const match = matchBoundaryItem(boundaryItems(body.boundary, 'inputs'), sink)
        return match.ok ? [match.item.binds, ...(match.item.alsoBinds ?? [])].filter((binding) => binding.kind === 'port' && binding.viaReroute !== undefined) : []
      })).length : 0
    const materializedDeliveryCount = occurrencePlan?.links.length ??
      (Object.keys(body.links).length + Object.keys(body.nets).length)
    const projectedDeliveryCount = occurrencePlan?.projectedParentLinks.length ?? 0
    const requiredIds = Object.keys(body.nodes).length + Object.keys(body.reroutes).length +
      Object.keys(body.valueSources ?? {}).length + Object.keys(body.selectors ?? {}).length +
      Object.values(body.selectors ?? {}).reduce((sum, selector) => sum + selector.candidates.length, 0) +
      materializedDeliveryCount + projectedDeliveryCount + additionalDeliveries + netJunctionDeliveries
    const allocationStart = tx.actor === undefined ? parent.nextOrdinal : actorCursorOf(parent.actorCursors, tx.actor)
    if (!Number.isSafeInteger(allocationStart + requiredIds) || allocationStart + requiredIds > Number.MAX_SAFE_INTEGER) {
      return [lifecycleError('subgraph.lifecycle.idExhausted', 'subgraph.flatten: parent graph id space is exhausted', graphId, instancePath, nodeId)]
    }
    const groupFloor = groupAllocationFloor(doc, graphId)
    const groupCount = bodySelection.groupIds.length
    if (!Number.isSafeInteger(groupFloor + groupCount) || groupFloor + groupCount > Number.MAX_SAFE_INTEGER) {
      return [lifecycleError('subgraph.lifecycle.idExhausted', 'subgraph.flatten: parent group id space is exhausted', graphId, instancePath, nodeId)]
    }

    const allocator = graphAllocator(tx, graphId, parent)
    const nodeIds = new Map<string, string>()
    for (const id of bodySelection.nodeIds) nodeIds.set(id, allocator.mint('n'))
    const valueSourceIds = new Map<string, string>()
    for (const id of bodySelection.valueSourceIds) valueSourceIds.set(id, allocator.mint('v'))
    const selectorIds = new Map<string, string>()
    const candidateIds = new Map<string, string>()
    for (const id of bodySelection.selectorIds) {
      selectorIds.set(id, allocator.mint('s'))
      for (const candidate of [...body.selectors![id]!.candidates].sort((a, b) => compareStrings(a.id, b.id))) {
        candidateIds.set(JSON.stringify([id, candidate.id]), allocator.mint('c'))
      }
    }
    const rerouteIds = new Map<string, string>()
    for (const id of bodySelection.rerouteIds) rerouteIds.set(id, allocator.mint('r'))
    const bodyLinkIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const id of Object.keys(body.links).sort(compareStrings)) bodyLinkIds.set(id, allocator.mint('l'))
    }
    const bodyNetIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const id of Object.keys(body.nets).sort(compareStrings)) bodyNetIds.set(id, allocator.mint('net'))
    }
    const occurrenceLinkIds = occurrencePlan?.links.map(() => allocator.mint('l')) ?? []
    const projectedLinkIds = occurrencePlan?.projectedParentLinks.map(() => allocator.mint('l')) ?? []
    const deliveryIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const link of Object.values(parent.links).sort((a, b) => compareStrings(a.id, b.id))) {
        if (!isPortEndpoint(link.to) || link.to.node !== nodeId) continue
        const matched = matchBoundaryItem(boundaryItems(body.boundary, 'inputs'), link.to)
        const additions = matched.ok ? matched.item.alsoBinds?.length ?? 0 : 0
        for (let index = 0; index < additions; index++) {
          deliveryIds.set(JSON.stringify([link.id, index]), allocator.mint('l'))
        }
      }
    }
    const ids: ExtractIdMaps = { nodes: nodeIds, reroutes: rerouteIds, valueSources: valueSourceIds, selectors: selectorIds, candidates: candidateIds }
    const targetsFor = (item: BoundaryItem): readonly BoundaryBinding[] =>
      flattenBoundaryTargets(item, nodeIds, rerouteIds, valueSourceIds)
    // Where one of the subgraph node's ports lands: under a construct it
    // shows whole, the matching row of each inner construct.
    const plannedSchemas = params.schemaSnapshot as unknown as Readonly<Record<string, NodeSchema>>
    const targetsAt = (item: BoundaryItem, outerPort: string): readonly BoundaryBinding[] | undefined => {
      const targets = targetsFor(item)
      if (item.binds.kind !== 'construct') return targets
      const authored = [item.binds, ...(item.alsoBinds ?? [])]
      const mapped = targets.map((target, index): BoundaryBinding | undefined => {
        const binding = authored[index]!
        if (binding.kind !== 'construct' || target.kind !== 'construct') return target
        const port = innerConstructAddress(body, binding, item.id, outerPort, (node) => plannedSchemas[node.type])
        return port === undefined ? undefined : { kind: 'port', node: target.node, port: asPortId(port) }
      })
      return mapped.every((target) => target !== undefined) ? mapped as BoundaryBinding[] : undefined
    }

    const literalDrivers = new Map<string, LinkEndpoint>()
    for (const item of boundaryItems(body.boundary, 'inputs')) {
      if (item.binds.kind !== 'valueSource') continue
      const input = parentPort(nodeId, item.id)
      const driver = Object.values(parent.links).find((link) => sameEndpoint(link.to, input))?.from ??
        Object.values(parent.nets).find((net) => net.sinks.some((sink) => sameEndpoint(sink, input)))?.source
      if (driver !== undefined) literalDrivers.set(valueSourceIds.get(item.binds.valueSource)!, driver)
    }
    const redirectFrom = (endpoint: LinkEndpoint, seen = new Set<string>()): LinkEndpoint | undefined => {
      const key = endpointKey(endpoint)
      if (seen.has(key)) return undefined
      seen.add(key)
      if (isValueSourceRef(endpoint)) {
        const driver = literalDrivers.get(endpoint.valueSource)
        return driver === undefined ? endpoint : redirectFrom(driver, seen)
      }
      if (isPortEndpoint(endpoint) && endpoint.node === nodeId) {
        const match = matchBoundaryItem(boundaryItems(body.boundary, 'outputs'), endpoint)
        const targets = match.ok ? targetsAt(match.item, endpoint.port) : undefined
        return targets?.length === 1 ? redirectFrom(endpointFromBinding(targets[0]!), seen) : undefined
      }
      return endpoint
    }
    const redirectOutputBinding = (binding: BoundaryBinding): BoundaryBinding | undefined => {
      if (binding.kind !== 'valueSource') return binding
      const endpoint = redirectFrom(endpointFromBinding(binding))
      if (endpoint === undefined) return undefined
      if (isValueSourceRef(endpoint)) return { ...binding, valueSource: endpoint.valueSource }
      if (isPortEndpoint(endpoint)) return { kind: 'port', ...endpoint }
      if (isWidgetTapRef(endpoint)) return { kind: 'widgetTap', ...endpoint }
      return undefined
    }

    const nodes: Record<string, NodeData> = { ...parent.nodes }
    delete nodes[nodeId]
    const plannedNodes = new Map(statePlan.nodes.map((entry) => [entry.node, entry]))
    for (const [oldId, node] of Object.entries(body.nodes)) {
      const id = nodeIds.get(oldId)!
      const planned = plannedNodes.get(oldId)
      if (planned === undefined) {
        return [err('params.invalid', `subgraph.flatten: statePlan has no post-state for body node '${oldId}'`)]
      }
      const { controllers: _controllers, dynamic: _dynamic, ...nodeWithoutState } = node
      nodes[id] = {
        ...nodeWithoutState,
        id: asNodeId(id),
        values: planned.values,
        ...(planned.controllers !== undefined ? { controllers: planned.controllers } : {}),
        ...(planned.dynamic !== undefined ? { dynamic: planned.dynamic } : {}),
        ...(occurrence.mode === 'muted' ? { mode: 'muted' as const } : {}),
      }
    }
    const reroutes = { ...parent.reroutes }
    for (const [oldId, reroute] of Object.entries(body.reroutes)) {
      const id = rerouteIds.get(oldId)!
      reroutes[id] = { ...reroute, id: asRerouteId(id) }
    }
    const valueSources = { ...(parent.valueSources ?? {}) }
    for (const [oldId, source] of Object.entries(body.valueSources ?? {})) {
      const id = valueSourceIds.get(oldId)!
      const input = boundaryItems(body.boundary, 'inputs').find((item) => item.promoted === true &&
        item.binds.kind === 'valueSource' && item.binds.valueSource === oldId)
      valueSources[id] = {
        ...source,
        id: asValueSourceId(id),
        ...(input !== undefined && Object.hasOwn(occurrence.values, input.id) ? { value: occurrence.values[input.id]! } : {}),
        ...(input !== undefined && Object.hasOwn(occurrence.controllers ?? {}, input.id) ? { controller: occurrence.controllers![input.id]! } : {}),
      }
    }
    const selectors = { ...(parent.selectors ?? {}) }
    for (const [oldId, selector] of Object.entries(body.selectors ?? {})) {
      const id = selectorIds.get(oldId)!
      const candidates = selector.candidates.map((candidate) => ({
        ...candidate,
        id: asSelectorCandidateId(candidateIds.get(JSON.stringify([oldId, candidate.id]))!),
      }))
      const fixed = selector.policy.kind === 'fixed'
        ? candidateIds.get(JSON.stringify([oldId, selector.policy.candidate]))
        : undefined
      if (selector.policy.kind === 'fixed' && fixed === undefined) {
        return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: selector '${oldId}' has an unmapped fixed candidate`, graphId, instancePath, nodeId)]
      }
      selectors[id] = {
        ...selector,
        id: asSelectorId(id),
        candidates,
        policy: selector.policy.kind === 'fixed'
          ? { kind: 'fixed', candidate: asSelectorCandidateId(fixed!) }
          : { kind: 'random' },
      }
    }

    // A muted subgraph node gives its consumers nothing. Its nodes stay
    // muted after flattening, but a value source or an outside wire it passes
    // on has no mode, so flattening would start delivering it.
    const flattenedNodes = new Set(nodeIds.values())
    const mutedLeak = (from: LinkEndpoint): boolean =>
      occurrence.mode === 'muted' && !((isPortEndpoint(from) || isWidgetTapRef(from)) && flattenedNodes.has(from.node))
    const links: Record<string, LinkData> = {}
    const fromShellOutput = new Set<string>()
    for (const [id, link] of Object.entries(parent.links)) {
      if (occurrencePlan !== undefined && (
        isPortEndpoint(link.from) && link.from.node === nodeId ||
        isPortEndpoint(link.to) && link.to.node === nodeId
      )) continue
      let from = link.from
      if (isPortEndpoint(from) && from.node === nodeId) {
        fromShellOutput.add(id)
        const match = matchBoundaryItem(boundaryItems(body.boundary, 'outputs'), from)
        const targets = match.ok ? targetsAt(match.item, from.port) : undefined
        if (targets === undefined) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: output '${from.port}' has an unmapped materialized route`, graphId, instancePath, nodeId, from)]
        }
        if (targets.length !== 1) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: output '${from.port}' has no unique inner producer`, graphId, instancePath, nodeId, from)]
        }
        from = endpointFromBinding(targets[0]!)
      } else if (isWidgetTapRef(from) && from.node === nodeId) {
        const target = targetsFor(boundaryInputs.get(from.tap)!)[0]
        if (target === undefined || !isNodeBoundaryBinding(target) || target.kind === 'widgetTap') {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: tap '${from.tap}' has no materialized target`, graphId, instancePath, nodeId)]
        }
        from = { node: target.node, tap: target.port }
      }
      if (isPortEndpoint(link.to) && link.to.node === nodeId) {
        const match = matchBoundaryItem(boundaryItems(body.boundary, 'inputs'), link.to)
        const targets = match.ok ? targetsAt(match.item, link.to.port)?.filter((target) => target.kind !== 'valueSource') : undefined
        if (targets === undefined) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: input '${link.to.port}' has no materialized target`, graphId, instancePath, nodeId, link.to)]
        }
        if (targets.length === 0) continue
        links[id] = { ...link, from, to: endpointFromBinding(targets[0]!) }
        for (const [index, target] of targets.slice(1).entries()) {
          const deliveryId = deliveryIds.get(JSON.stringify([link.id, index]))
          if (deliveryId === undefined) {
            return [lifecycleError('subgraph.lifecycle.idExhausted', `subgraph.flatten: input '${link.to.port}' has no allocated fan-out delivery`, graphId, instancePath, nodeId, link.to)]
          }
          links[deliveryId] = { ...link, id: asLinkId(deliveryId), from, to: endpointFromBinding(target) }
        }
      } else {
        links[id] = { ...link, from }
      }
    }
    if (occurrencePlan === undefined) {
      for (const link of Object.values(body.links).sort((a, b) => compareStrings(a.id, b.id))) {
        const id = bodyLinkIds.get(link.id)!
        links[id] = { ...link, id: asLinkId(id), from: remapEndpoint(link.from, ids), to: remapEndpoint(link.to, ids) }
      }
    } else {
      for (const [index, link] of occurrencePlan.links.entries()) {
        const id = occurrenceLinkIds[index]!
        links[id] = {
          id: asLinkId(id),
          from: remapEndpoint(link.from, ids),
          to: remapEndpoint(link.to, ids),
          ...(link.ext !== undefined ? { ext: link.ext } : {}),
        }
      }
      const remapProjectedEndpoint = (endpoint: LinkEndpoint, endpointGraphId: string): LinkEndpoint => {
        if (endpointGraphId !== body.id) return endpoint
        if ((isPortEndpoint(endpoint) || isWidgetTapRef(endpoint)) && nodeIds.has(endpoint.node)) return remapEndpoint(endpoint, ids)
        if (isRerouteRef(endpoint) && rerouteIds.has(endpoint.reroute)) return remapEndpoint(endpoint, ids)
        if (isValueSourceRef(endpoint) && valueSourceIds.has(endpoint.valueSource)) return remapEndpoint(endpoint, ids)
        if (isSelectorRef(endpoint) && selectorIds.has(endpoint.selector)) return remapEndpoint(endpoint, ids)
        return endpoint
      }
      for (const [index, link] of occurrencePlan.projectedParentLinks.entries()) {
        const id = projectedLinkIds[index]!
        links[id] = {
          id: asLinkId(id),
          from: remapProjectedEndpoint(link.from, link.fromGraphId),
          to: remapProjectedEndpoint(link.to, link.toGraphId),
          ...(link.ext !== undefined ? { ext: link.ext } : {}),
        }
      }
    }

    const nets: Record<string, NamedNetData> = {}
    const netSourceRemap = new Map<string, PortRef>()
    const netSinkRemap = new Map<string, readonly PortRef[]>()
    const occurrenceSinkKey = (netId: string, sink: { readonly port: string }): string =>
      JSON.stringify([netId, sink.port])
    for (const [id, net] of Object.entries(parent.nets)) {
      if (occurrencePlan !== undefined && net.source.node === nodeId) continue
      let source = net.source
      if (source.node === nodeId) {
        const match = matchBoundaryItem(boundaryItems(body.boundary, 'outputs'), source)
        const targets = match.ok ? targetsAt(match.item, source.port) : undefined
        if (targets === undefined) {
          return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: net source '${source.port}' has no materialized target`, graphId, instancePath, nodeId, source)]
        }
        if (targets.length !== 1) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: output '${source.port}' has no unique inner producer`, graphId, instancePath, nodeId, source)]
        }
        const endpoint = redirectFrom(endpointFromBinding(targets[0]!))
        if (endpoint === undefined || !isPortEndpoint(endpoint)) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: net source '${source.port}' resolves to a structural producer, which named nets cannot represent`, graphId, instancePath, nodeId, source)]
        }
        if (mutedLeak(endpoint)) {
          return [lifecycleError('subgraph.flatten.modeUnsupported', `subgraph.flatten: muted output '${source.port}' passes on a value that is not muted`, graphId, instancePath, nodeId, source)]
        }
        source = endpoint
        netSourceRemap.set(id, source)
      }
      const sinks: PortRef[] = []
      for (const sink of net.sinks) {
        if (sink.node !== nodeId) sinks.push(sink)
        else if (occurrencePlan !== undefined) continue
        else {
          const match = matchBoundaryItem(boundaryItems(body.boundary, 'inputs'), sink)
          const targets = match.ok ? targetsAt(match.item, sink.port) : undefined
          if (targets === undefined) {
            return [lifecycleError('subgraph.flatten.stateUnresolved', `subgraph.flatten: net sink '${sink.port}' has no materialized target`, graphId, instancePath, nodeId, sink)]
          }
          const expanded: PortRef[] = []
          for (const target of targets) {
            if (target.kind === 'valueSource') continue
            const endpoint = endpointFromBinding(target)
            if (isRerouteRef(endpoint)) {
              const deliveryId = allocator.mint('l')
              links[deliveryId] = { id: asLinkId(deliveryId), from: source, to: endpoint }
            } else expanded.push(portFromBinding(target))
          }
          sinks.push(...expanded)
          netSinkRemap.set(occurrenceSinkKey(id, sink), expanded)
        }
      }
      const sinkKeys = sinks.map(portRefKey)
      if (new Set(sinkKeys).size !== sinkKeys.length) {
        return [lifecycleError('subgraph.lifecycle.multiDriver', `subgraph.flatten: net '${id}' expansion repeats a sink`, graphId, instancePath, nodeId)]
      }
      if (sinks.length > 0) nets[id] = { ...net, source, sinks }
    }
    const removedParentNetIds = new Set(Object.keys(parent.nets).filter((id) => nets[id] === undefined))
    const clonedNetIds = new Map<string, string>()
    if (occurrencePlan === undefined) {
      for (const [oldId, net] of Object.entries(body.nets).sort(([a], [b]) => compareStrings(a, b))) {
        const id = bodyNetIds.get(oldId)!
        clonedNetIds.set(oldId, id)
        nets[id] = {
          ...net,
          id: asNetId(id),
          source: remapPort(net.source, nodeIds),
          sinks: net.sinks.map((sink) => remapPort(sink, nodeIds)),
        }
      }
    }

    let boundary = parent.boundary
    if (boundary !== undefined) {
      const rewriteItem = (item: BoundaryItem, side: 'input' | 'output', itemIndex: number): BoundaryItem | undefined => {
        const oldTargets = [item.binds, ...(item.alsoBinds ?? [])]
        const expanded: BoundaryBinding[] = []
        for (const [bindingIndex, target] of oldTargets.entries()) {
          if (target.node !== nodeId) {
            expanded.push(target)
            continue
          }
          const rewrite = statePlan.enclosingRewrites.find((entry) =>
            entry.side === side && entry.itemIndex === itemIndex && entry.itemId === item.id &&
            entry.bindingIndex === bindingIndex && canonicalJson(entry.before) === canonicalJson(target))
          if (rewrite === undefined) return undefined
          for (const binding of rewrite.after) {
            const mapped = remapBinding(binding, nodeIds, rerouteIds, valueSourceIds)
            const redirected = side === 'output' ? redirectOutputBinding(mapped) : mapped
            if (redirected === undefined) return undefined
            expanded.push(redirected)
          }
        }
        if (expanded.length === 0) return undefined
        const { alsoBinds: _oldAlsoBinds, ...rest } = item
        return { ...rest, binds: expanded[0]!, ...(expanded.length > 1 ? { alsoBinds: expanded.slice(1) } : {}) }
      }
      const inputs: BoundaryItem[] = []
      for (const [itemIndex, item] of boundaryItems(boundary, 'inputs').entries()) {
        const rewritten = rewriteItem(item, 'input', itemIndex)
        if (rewritten === undefined) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: enclosing input '${item.id}' cannot expand through the occurrence`, graphId, instancePath, nodeId)]
        }
        inputs.push(rewritten)
      }
      const outputs: BoundaryItem[] = []
      for (const [itemIndex, item] of boundaryItems(boundary, 'outputs').entries()) {
        const rewritten = rewriteItem(item, 'output', itemIndex)
        if (rewritten === undefined || rewritten.alsoBinds !== undefined) {
          return [lifecycleError('subgraph.lifecycle.boundaryUnresolved', `subgraph.flatten: enclosing output '${item.id}' has no unique inner producer`, graphId, instancePath, nodeId)]
        }
        outputs.push(rewritten)
      }
      boundary = mapBoundaryItems(boundary, (_item, side, index) => (side === 'inputs' ? inputs : outputs)[index])
    }

    for (const [id, link] of Object.entries(links)) {
      const from = redirectFrom(link.from)
      if (from === undefined) {
        return [lifecycleError('subgraph.flatten.stateUnresolved', 'subgraph.flatten: literal input forwarding has no acyclic producer', graphId, instancePath, nodeId)]
      }
      if (fromShellOutput.has(id) && mutedLeak(from)) {
        return [lifecycleError('subgraph.flatten.modeUnsupported', `subgraph.flatten: muted output '${(parent.links[id]!.from as PortRef).port}' passes on a value that is not muted`, graphId, instancePath, nodeId)]
      }
      links[id] = { ...link, from }
    }

    const parentView = doc.view.graphs[graphId] ?? { nodes: {} }
    const viewNodes = { ...parentView.nodes }
    delete viewNodes[nodeId]
    const translated = new Map(geometryPlan.items.map((item) => [`${item.kind}\u0000${item.id}`, item]))
    for (const oldId of bodySelection.nodeIds) {
      viewNodes[nodeIds.get(oldId)!] = {
        ...(bodyView?.nodes[oldId] ?? {}),
        position: translatedPosition(translated, 'node', oldId),
      }
    }
    const viewReroutes = { ...(parentView.reroutes ?? {}) }
    for (const oldId of bodySelection.rerouteIds) {
      viewReroutes[rerouteIds.get(oldId)!] = {
        ...(bodyView?.reroutes?.[oldId] ?? {}),
        position: translatedPosition(translated, 'reroute', oldId),
      }
    }
    const viewValueSources = { ...(parentView.valueSources ?? {}) }
    for (const oldId of bodySelection.valueSourceIds) {
      viewValueSources[valueSourceIds.get(oldId)!] = {
        ...(bodyView?.valueSources?.[oldId] ?? {}),
        position: translatedPosition(translated, 'valueSource', oldId),
      }
    }
    const viewSelectors = { ...(parentView.selectors ?? {}) }
    for (const oldId of bodySelection.selectorIds) {
      viewSelectors[selectorIds.get(oldId)!] = {
        ...(bodyView?.selectors?.[oldId] ?? {}),
        position: translatedPosition(translated, 'selector', oldId),
      }
    }
    const groups = { ...(parentView.groups ?? {}) }
    for (const [index, oldId] of bodySelection.groupIds.entries()) {
      const old = bodyView!.groups![oldId]!
      const id = `grp${groupFloor + index}`
      const position = translatedPosition(translated, 'group', oldId)
      groups[id] = { ...old, id, bounds: { ...old.bounds, ...position } }
    }
    const collapsedNets = [
      ...(parentView.collapsedNets ?? []).filter((id) => !removedParentNetIds.has(id)),
      ...(bodyView?.collapsedNets ?? []).map((id) => clonedNetIds.get(id)).filter((id): id is string => id !== undefined),
    ]
    const guideNets = [
      ...(parentView.guideNets ?? []).filter((id) => !removedParentNetIds.has(id)),
      ...(bodyView?.guideNets ?? []).map((id) => clonedNetIds.get(id)).filter((id): id is string => id !== undefined),
    ]
    const stagedView: GraphViewState = {
      ...parentView,
      nodes: viewNodes,
      ...(Object.keys(viewReroutes).length > 0 || parentView.reroutes !== undefined ? { reroutes: viewReroutes } : {}),
      ...(Object.keys(viewValueSources).length > 0 || parentView.valueSources !== undefined ? { valueSources: viewValueSources } : {}),
      ...(Object.keys(viewSelectors).length > 0 || parentView.selectors !== undefined ? { selectors: viewSelectors } : {}),
      ...(Object.keys(groups).length > 0 || parentView.groups !== undefined ? { groups } : {}),
      ...(groupCount > 0 ? { groupSeq: groupFloor + groupCount } : {}),
      ...(collapsedNets.length > 0 || parentView.collapsedNets !== undefined ? { collapsedNets } : {}),
      ...(guideNets.length > 0 || parentView.guideNets !== undefined ? { guideNets } : {}),
    }
    const endingCursor = allocationStart + requiredIds
    const stagedParent: GraphDef = {
      ...parent,
      nodes,
      links,
      nets,
      reroutes,
      ...(parent.valueSources !== undefined || body.valueSources !== undefined ? { valueSources } : {}),
      ...(parent.selectors !== undefined || body.selectors !== undefined ? { selectors } : {}),
      ...(boundary !== undefined ? { boundary } : {}),
      ...(tx.actor === undefined
        ? { nextOrdinal: endingCursor }
        : { actorCursors: { ...(parent.actorCursors ?? {}), [tx.actor]: endingCursor } }),
    }
    const remainingTopologies = occurrencePlan === undefined
      ? doc.occurrenceTopologies
      : Object.fromEntries(Object.entries(doc.occurrenceTopologies ?? {}).filter(([key]) => key !== topologyKey))
    const { occurrenceTopologies: _oldTopologies, ...docWithoutTopologies } = doc
    const staged: WorkflowDocument = {
      ...(occurrencePlan === undefined ? doc : docWithoutTopologies),
      graphs: { ...doc.graphs, [graphId]: stagedParent },
      view: { ...doc.view, graphs: { ...doc.view.graphs, [graphId]: stagedView } },
      ...(occurrencePlan !== undefined && Object.keys(remainingTopologies ?? {}).length > 0
        ? { occurrenceTopologies: remainingTopologies }
        : {}),
    }
    if (stagedFlattenIdentitiesContainNul(statePlan)) {
      return [lifecycleError('subgraph.flatten.stateUnresolved', 'subgraph.flatten: staged materialization produced a NUL identity', graphId, instancePath, nodeId)]
    }
    const stagedErrors = checkDocument(staged).filter((diagnostic) => diagnostic.severity === 'error')
    const multiDriver = stagedErrors.find((diagnostic) => diagnostic.code.includes('multiDriver'))
    if (multiDriver !== undefined) {
      return [lifecycleError('subgraph.lifecycle.multiDriver', `subgraph.flatten: staged topology has conflicting deliveries (${multiDriver.message})`, graphId, instancePath, nodeId)]
    }
    if (stagedErrors.length > 0) return stagedErrors

    tx.set(['graphs', graphId, 'nodes'], nodes as unknown as Json)
    tx.set(['graphs', graphId, 'links'], links as unknown as Json)
    tx.set(['graphs', graphId, 'nets'], nets as unknown as Json)
    tx.set(['graphs', graphId, 'reroutes'], reroutes as unknown as Json)
    if (parent.valueSources !== undefined || body.valueSources !== undefined) tx.set(['graphs', graphId, 'valueSources'], valueSources as unknown as Json)
    if (parent.selectors !== undefined || body.selectors !== undefined) tx.set(['graphs', graphId, 'selectors'], selectors as unknown as Json)
    if (boundary !== undefined) tx.set(['graphs', graphId, 'boundary'], boundary as unknown as Json)
    tx.set(['view', 'graphs', graphId], stagedView as unknown as Json)
    if (occurrencePlan !== undefined) {
      if (Object.keys(remainingTopologies ?? {}).length === 0) tx.remove(['occurrenceTopologies'])
      else tx.set(['occurrenceTopologies'], remainingTopologies as unknown as Json)
    }
    // Tag placements survive the flatten. Parent-graph entries anchored to
    // the removed occurrence move onto the expanded endpoints (duplicated for
    // fan-out sinks), re-anchoring offsets so the on-screen point holds when
    // stored positions allow it; entries of nets that vanish are dropped.
    // Body-graph placements ride along with the cloned nets: offsets are
    // node-relative, so remapping ids is enough, and the body definition may
    // still be shared, so its own entries stay untouched.
    const rawNetViews = doc.ext?.[NET_VIEWS_EXT_KEY]
    if (Array.isArray(rawNetViews)) {
      const occurrencePosition = parentView.nodes[nodeId]?.position
      const reanchored = (geometry: NetViewGeometry, anchorNode: string): NetViewGeometry => {
        if (geometry.kind !== 'offset') return geometry
        const anchor = viewNodes[anchorNode]?.position
        if (occurrencePosition === undefined || anchor === undefined) return geometry
        const x = Math.round((occurrencePosition.x + geometry.x - anchor.x) * 100) / 100
        const y = Math.round((occurrencePosition.y + geometry.y - anchor.y) * 100) / 100
        return Number.isFinite(x) && Number.isFinite(y) ? { kind: 'offset', x, y } : geometry
      }
      const next: Json[] = []
      let changed = false
      for (const raw of rawNetViews) {
        const entry = parseNetViewPosition(raw)
        if (entry !== undefined && entry.graphId === graphId) {
          if (removedParentNetIds.has(entry.netId)) {
            changed = true
            continue
          }
          if (entry.role === 'sink' && entry.to.node === nodeId) {
            const targets = netSinkRemap.get(occurrenceSinkKey(entry.netId, entry.to))
            changed = true
            if (targets === undefined) continue
            for (const target of targets) {
              next.push(netViewToJson({ ...entry, to: target, geometry: reanchored(entry.geometry, target.node) }))
            }
            continue
          }
          if (entry.role === 'source' && entry.geometry.kind === 'offset') {
            const source = netSourceRemap.get(entry.netId)
            if (source !== undefined) {
              next.push(netViewToJson({ ...entry, geometry: reanchored(entry.geometry, source.node) }))
              changed = true
              continue
            }
          }
        }
        next.push(raw)
      }
      for (const raw of rawNetViews) {
        const entry = parseNetViewPosition(raw)
        if (entry === undefined || entry.graphId !== body.id || entry.geometry.kind !== 'offset') continue
        const netId = clonedNetIds.get(entry.netId)
        if (netId === undefined) continue
        if (entry.role === 'sink') {
          const node = nodeIds.get(entry.to.node)
          if (node === undefined) continue
          next.push(netViewToJson({ ...entry, graphId, netId, to: { ...entry.to, node: asNodeId(node) } }))
        } else {
          next.push(netViewToJson({ ...entry, graphId, netId }))
        }
        changed = true
      }
      if (changed) tx.set(['ext', NET_VIEWS_EXT_KEY], next)
    }
    allocator.commit()
    return []
  },
}

function localizedOccurrenceRelation(
  doc: WorkflowDocument,
  owner: OccurrenceRef,
  graphId: string,
  nodeId: string,
): { readonly affected: boolean; readonly direct: boolean } {
  let graph = doc.graphs[doc.root]
  const hops = [...owner.instancePath, owner.node]
  for (const [index, hop] of hops.entries()) {
    if (graph?.id === graphId && hop === nodeId) return { affected: true, direct: index === hops.length - 1 }
    const node = graph?.nodes[hop]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    graph = childId === undefined ? undefined : doc.graphs[childId]
  }
  return { affected: false, direct: false }
}

const remapRoute = (route: readonly BoundaryRouteLeg[], sourceId: string, freshId: string): BoundaryRouteLeg[] =>
  route.map((leg) => leg.graph === sourceId ? { ...leg, graph: asGraphDefId(freshId) } : leg)

function remapSuppression(delivery: SuppressedDelivery, sourceId: string, freshId: string): SuppressedDelivery {
  if (delivery.kind !== 'projectedLeg') return delivery
  return {
    ...delivery,
    delivery: delivery.delivery.graph === sourceId
      ? { ...delivery.delivery, graph: asGraphDefId(freshId) }
      : delivery.delivery,
    route: remapRoute(delivery.route, sourceId, freshId),
  }
}

function remapLocalizedTopology(
  topology: OccurrenceTopology,
  sourceId: string,
  freshId: string,
  direct: boolean,
): OccurrenceTopology {
  return {
    ...topology,
    ...(direct ? { bodyGraph: asGraphDefId(freshId) } : {}),
    links: Object.fromEntries(Object.entries(topology.links).map(([key, link]) => [key, {
      ...link,
      from: link.from.kind === 'boundary'
        ? { ...link.from, route: remapRoute(link.from.route, sourceId, freshId) }
        : link.from,
      to: link.to.kind === 'boundary'
        ? { ...link.to, route: remapRoute(link.to.route, sourceId, freshId) }
        : link.to,
    }])),
    ...(topology.suppressedDeliveries === undefined ? {} : {
      suppressedDeliveries: topology.suppressedDeliveries.map((delivery) =>
        remapSuppression(delivery, sourceId, freshId)),
    }),
  }
}

const occurrenceLocalize: CommandDefinition = {
  id: 'occurrence.localize',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string') {
      return [err('params.invalid', 'occurrence.localize: params must include graphId and nodeId')]
    }
    const parent = doc.graphs[params.graphId]
    const occurrence = parent?.nodes[params.nodeId]
    const sourceId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
    const source = sourceId === undefined ? undefined : doc.graphs[sourceId]
    if (parent === undefined || occurrence === undefined || sourceId === undefined || source === undefined) {
      return [err('subgraph.localize.notOccurrence', 'occurrence.localize: target is not a resolvable subgraph occurrence')]
    }
    const linkedCount = Object.values(doc.graphs).reduce((count, graph) =>
      count + Object.values(graph.nodes).filter((node) => subgraphDefIdOf(node.type) === sourceId).length, 0)
    if (linkedCount < 2) {
      return [err('subgraph.localize.notShared', 'occurrence.localize: definition has fewer than two occurrences')]
    }
    const freshId = freshDefinitionId(doc)
    tx.set(['graphs', freshId], {
      ...structuredClone(source),
      id: asGraphDefId(freshId),
      name: `${source.name} (Unique)`,
    } as unknown as Json)
    tx.set(['view', 'graphs', freshId], structuredClone(doc.view.graphs[sourceId] ?? { nodes: {} }) as unknown as Json)
    tx.set(['graphs', params.graphId, 'nodes', params.nodeId, 'type'], `#${freshId}`)
    // The clone keeps parity with its source: exposed parameters targeting
    // the source definition are duplicated onto the clone so the unique
    // occurrence keeps its app-view controls. Originals stay for the
    // occurrences still sharing the source; malformed entries pass through.
    const rawExposed = doc.ext?.[EXPOSED_EXT_KEY]
    if (Array.isArray(rawExposed)) {
      const next: Json[] = []
      let copied = false
      for (const raw of rawExposed) {
        next.push(raw)
        if (isObj(raw) && parseExposedEntry(raw)?.graphId === sourceId) {
          next.push({ ...raw, graphId: freshId })
          copied = true
        }
      }
      if (copied) tx.set(['ext', EXPOSED_EXT_KEY], next)
    }
    const rawExposedPreviews = doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY]
    if (Array.isArray(rawExposedPreviews)) {
      const next: Json[] = []
      let copied = false
      for (const raw of rawExposedPreviews) {
        next.push(raw)
        if (isObj(raw) && parseExposedPreviewEntry(raw)?.graphId === sourceId) {
          next.push({ ...raw, graphId: freshId })
          copied = true
        }
      }
      if (copied) tx.set(['ext', EXPOSED_PREVIEWS_EXT_KEY], next)
    }
    const rawCloneNetViews = doc.ext?.[NET_VIEWS_EXT_KEY]
    if (Array.isArray(rawCloneNetViews)) {
      const next: Json[] = []
      let copied = false
      for (const raw of rawCloneNetViews) {
        next.push(raw)
        if (isObj(raw) && parseNetViewPosition(raw)?.graphId === sourceId) {
          next.push({ ...raw, graphId: freshId })
          copied = true
        }
      }
      if (copied) tx.set(['ext', NET_VIEWS_EXT_KEY], next)
    }
    const localizedLayout = localizeAppLayoutJson(doc.ext?.[APP_LAYOUT_EXT_KEY], sourceId, freshId)
    if (localizedLayout !== undefined) tx.set(['ext', APP_LAYOUT_EXT_KEY], localizedLayout)
    const topologies = Object.fromEntries(Object.entries(doc.occurrenceTopologies ?? {}).map(([key, topology]) => {
      const relation = localizedOccurrenceRelation(doc, topology.owner, params.graphId as string, params.nodeId as string)
      return [key, relation.affected
        ? remapLocalizedTopology(topology, sourceId, freshId, relation.direct)
        : topology]
    }))
    if (Object.values(topologies).some((topology, index) => topology !== Object.values(doc.occurrenceTopologies ?? {})[index])) {
      tx.set(['occurrenceTopologies'], topologies as unknown as Json)
    }
    return []
  },
}

function removeDefinitionSupportState(doc: WorkflowDocument, removed: ReadonlySet<string>, tx: TransactionBuilder): void {
  for (const graphId of removed) {
    tx.remove(['graphs', graphId])
    if (doc.view.graphs[graphId] !== undefined) tx.remove(['view', 'graphs', graphId])
  }

  const exposed = doc.ext?.[EXPOSED_EXT_KEY]
  if (Array.isArray(exposed)) {
    const kept = exposed.filter((raw) => {
      const entry = parseExposedEntry(raw)
      return entry === undefined || !removed.has(entry.graphId)
    })
    if (kept.length !== exposed.length) tx.set(['ext', EXPOSED_EXT_KEY], kept)
  }
  const exposedPreviews = doc.ext?.[EXPOSED_PREVIEWS_EXT_KEY]
  if (Array.isArray(exposedPreviews)) {
    const kept = exposedPreviews.filter((raw) => {
      const entry = parseExposedPreviewEntry(raw)
      return entry === undefined || !removed.has(entry.graphId)
    })
    if (kept.length !== exposedPreviews.length) tx.set(['ext', EXPOSED_PREVIEWS_EXT_KEY], kept)
  }
  const appLayout = removeAppLayoutGraphRefs(doc.ext?.[APP_LAYOUT_EXT_KEY], removed)
  if (appLayout !== undefined) tx.set(['ext', APP_LAYOUT_EXT_KEY], appLayout)
  const netViews = doc.ext?.[NET_VIEWS_EXT_KEY]
  if (Array.isArray(netViews)) {
    const kept = netViews.filter((raw) => {
      const entry = parseNetViewPosition(raw)
      return entry === undefined || !removed.has(entry.graphId)
    })
    if (kept.length !== netViews.length) tx.set(['ext', NET_VIEWS_EXT_KEY], kept)
  }
  for (const [surfaceId, surface] of Object.entries(doc.surfaces ?? {})) {
    if (surface.type !== MODE_PANEL_TYPE) continue
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) continue
    const rawBindings = surface.config.bindings as readonly Json[]
    const bindings = rawBindings.filter((_, index) => {
      const binding = decoded.config.bindings[index]!
      return binding.kind === 'unknown' || !removed.has(binding.graphId)
    })
    if (bindings.length !== rawBindings.length) {
      tx.set(['surfaces', surfaceId, 'config'], { ...surface.config, bindings })
    }
  }
  for (const [slot, bookmark] of Object.entries(doc.view.bookmarks ?? {})) {
    if (bookmark.graphStack.some((graphId) => removed.has(graphId))) tx.remove(['view', 'bookmarks', slot])
  }
}

const removeUnusedDefinitions: CommandDefinition = {
  id: 'subgraph.removeUnusedDefinitions',
  run(doc, params, tx) {
    if (!isObj(params) || !Array.isArray(params.definitionIds) ||
        !params.definitionIds.every((id) => typeof id === 'string') ||
        typeof params.fingerprint !== 'string') {
      return [err('params.invalid', 'subgraph.removeUnusedDefinitions: params must include definitionIds and fingerprint')]
    }
    const plan = planSubgraphDefinitionCleanup(doc)
    const expected = plan.removable.map((entry) => entry.id)
    const supplied = params.definitionIds as readonly string[]
    if (params.fingerprint !== plan.fingerprint || supplied.length !== expected.length ||
        supplied.some((id, index) => id !== expected[index])) {
      return [err('subgraph.cleanup.stalePlan', 'subgraph.removeUnusedDefinitions: definition reachability changed after preview')]
    }
    if (expected.length === 0) return [err('subgraph.cleanup.noneUnused', 'subgraph.removeUnusedDefinitions: no unused definitions remain')]
    removeDefinitionSupportState(doc, new Set(expected), tx)
    return []
  },
}

const deleteDefinition: CommandDefinition = {
  id: 'subgraph.deleteDefinition',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.definitionId !== 'string' || typeof params.fingerprint !== 'string') {
      return [err('params.invalid', 'subgraph.deleteDefinition: params must include definitionId and fingerprint')]
    }
    const plan = planSubgraphDefinitionCleanup(doc)
    if (params.fingerprint !== plan.fingerprint) {
      return [err('subgraph.cleanup.stalePlan', 'subgraph.deleteDefinition: definition reachability changed after preview')]
    }
    const candidate = plan.removable.find((entry) => entry.id === params.definitionId)
    if (candidate === undefined) {
      return [err('subgraph.cleanup.definitionInUse', 'subgraph.deleteDefinition: definition is missing or reachable from root')]
    }
    const referencedByAnotherUnused = plan.removable.some((entry) =>
      entry.id !== candidate.id && entry.dependencies.includes(candidate.id))
    if (referencedByAnotherUnused) {
      return [err('subgraph.cleanup.definitionInUse', 'subgraph.deleteDefinition: another unused definition still references this definition')]
    }
    removeDefinitionSupportState(doc, new Set([candidate.id]), tx)
    return []
  },
}

export const SUBGRAPH_COMMANDS: readonly CommandDefinition[] = [
  subgraphImport,
  subgraphExtract,
  subgraphFlatten,
  occurrenceLocalize,
  deleteDefinition,
  removeUnusedDefinitions,
]
