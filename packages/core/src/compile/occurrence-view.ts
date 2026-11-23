import { boundaryBindingKey, suppressedDeliveryKey, type BoundaryRouteLeg, type DynamicPortState, type GraphDef, type Json, type NodeData, type ParentDeliveryIdentity, type WorkflowDocument } from '../format/document.js'
import { asNodeId, asPortId, isOccurrenceAncestorOrSelf, isPortEndpoint, occurrenceKey, type PortRef } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { resolveBoundaryRoute, type SchemaResolver } from '../schema/derive-boundary.js'
import { boundaryOutputFanOutProblems, innerConstructAddress, matchBoundaryItem, projectConstructs, projectEditableOptions } from './crossing.js'
import { documentNodeResolver } from './compile.js'

export interface ValueOwner {
  readonly graphId: string
  readonly nodeId: string
  readonly valueKey: string
}

export interface OccurrenceDynamicView {
  /** Authored input addresses, including occurrence-local and projected deliveries. */
  readonly inputPorts: ReadonlyMap<string, readonly string[]>
  /** Per inner-node occurrence-effective dynamic state (only nodes that differ). */
  readonly dynamic: ReadonlyMap<string, Readonly<Record<string, DynamicPortState>>>
  /** Per inner-node occurrence-effective values (only nodes that differ). */
  readonly values: ReadonlyMap<string, Readonly<Record<string, Json>>>
  readonly controllers: ReadonlyMap<string, NonNullable<NodeData['controllers']>>
  /** Per inner-node projected value: where an edit must be written. */
  readonly valueOwners: ReadonlyMap<string, ReadonlyMap<string, ValueOwner>>
}

/**
 * The option or variant a subgraph node of `defId` runs for a choice it shows
 * whole at `port` while it stores none of its own: what the definition picks
 * inside, through any number of subgraphs. Undefined when nothing is picked.
 */
export function definitionPick(doc: WorkflowDocument, defId: string, port: string, resolveSchema: SchemaResolver): string | undefined {
  const child = doc.graphs[defId]
  const match = child?.boundary === undefined ? undefined : matchBoundaryItem(child.boundary.inputs, { port })
  if (!match?.ok) return undefined
  const resolveNode = documentNodeResolver(doc, resolveSchema)
  for (const binding of [match.item.binds, ...(match.item.alsoBinds ?? [])]) {
    if (binding.kind !== 'construct') continue
    const inner = innerConstructAddress(child!, binding, match.item.id, port, (node) => resolveNode(defId, node))
    const node = child!.nodes[binding.node]
    if (inner === undefined || node === undefined) continue
    const nested = subgraphDefIdOf(node.type)
    const picked = node.dynamic?.[inner]?.selected ?? (nested === undefined ? undefined : definitionPick(doc, nested, inner, resolveSchema))
    if (picked !== undefined) return picked
  }
  return undefined
}

interface InputEvidence {
  readonly ref: PortRef
  readonly route?: readonly BoundaryRouteLeg[]
  readonly delivery?: ParentDeliveryIdentity
  readonly projectedRoute?: readonly BoundaryRouteLeg[]
}

/** Collect endpoints before boundary projection; existence never depends on solved topology. */
function authoredInputEvidence(doc: WorkflowDocument, graph: GraphDef | undefined, path: readonly string[]): InputEvidence[] {
  if (!graph) return []
  const owner = path.length === 0 ? undefined : { instancePath: path.slice(0, -1).map(asNodeId), node: asNodeId(path[path.length - 1]!) }
  const topology = owner && doc.occurrenceTopologies?.[occurrenceKey(owner)]
  const suppressed = new Set((topology?.suppressedDeliveries ?? []).map(suppressedDeliveryKey))
  const result: InputEvidence[] = []
  for (const link of Object.values(graph.links)) {
    if (isPortEndpoint(link.to) && !suppressed.has(suppressedDeliveryKey({ kind: 'link', linkId: link.id }))) result.push({ ref: link.to, delivery: { kind: 'link', graph: graph.id, linkId: link.id } })
  }
  for (const net of Object.values(graph.nets)) for (const to of net.sinks) {
    if (!suppressed.has(suppressedDeliveryKey({ kind: 'netSink', netId: net.id, to }))) result.push({ ref: to, delivery: { kind: 'netSink', graph: graph.id, netId: net.id, to } })
  }
  for (const local of Object.values(doc.occurrenceTopologies ?? {})) {
    for (const link of Object.values(local.links)) {
      const to = link.to
      if (to.kind === 'body') {
        if (local.bodyGraph === graph.id && JSON.stringify([...local.owner.instancePath, local.owner.node]) === JSON.stringify(path) && isPortEndpoint(to.endpoint)) result.push({ ref: to.endpoint })
      } else if (isOccurrenceAncestorOrSelf(to.occurrence, local.owner) && JSON.stringify(to.occurrence.instancePath) === JSON.stringify(path)) {
        result.push({ ref: { node: to.occurrence.node, ...to.address }, route: to.route })
      }
    }
  }
  return result
}

/**
 * Project occurrence-local state down one concrete instance path exactly as
 * compile does: promoted editable menus and values, and input connectivity
 * delivered through boundary inputs.
 */
export function occurrenceDynamicView(
  doc: WorkflowDocument,
  resolve: SchemaResolver,
  instancePath: readonly string[],
  rootGraph: string = doc.root,
): OccurrenceDynamicView {
  const empty = (): OccurrenceDynamicView => ({ inputPorts: new Map(), dynamic: new Map(), values: new Map(), controllers: new Map(), valueOwners: new Map() })

  const resolveNode = documentNodeResolver(doc, resolve)
  let def = doc.graphs[rootGraph]
  let overlays = new Map<string, Readonly<Record<string, DynamicPortState>>>()
  let values = new Map<string, Readonly<Record<string, Json>>>()
  let controllers = new Map<string, NonNullable<NodeData['controllers']>>()
  let valueOwners = new Map<string, ReadonlyMap<string, ValueOwner>>()
  const traversedPath: string[] = []
  let inputEvidence = authoredInputEvidence(doc, def, traversedPath)
  for (const hop of instancePath) {
    const node = def?.nodes[hop]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    const child = childId === undefined ? undefined : doc.graphs[childId]
    if (!def || !node || !child?.boundary) return empty()

    const instanceDynamic = overlays.get(hop) ?? node.dynamic
    const instanceValues = values.get(hop) ?? node.values
    const instanceControllers = controllers.get(hop) ?? node.controllers
    const childOverlays = new Map<string, Readonly<Record<string, DynamicPortState>>>(projectEditableOptions(child, instanceDynamic, (inner) => resolveNode(child.id, inner)))
    const childValues = new Map<string, Readonly<Record<string, Json>>>()
    const childControllers = new Map<string, NonNullable<NodeData['controllers']>>()
    const childValueOwners = new Map<string, Map<string, ValueOwner>>()
    // A recorded route ends in this body; only unrecorded deliveries may continue freely.
    const instanceEvidence = inputEvidence.filter(({ ref, route }) => ref.node === node.id && route?.length !== 0)
    if (boundaryOutputFanOutProblems(child).length > 0) return empty()
    const childEvidence = authoredInputEvidence(doc, child, [...traversedPath, hop])
    const childOwner = { instancePath: traversedPath.map(asNodeId), node: asNodeId(hop) }
    const suppressed = new Set((doc.occurrenceTopologies?.[occurrenceKey(childOwner)]?.suppressedDeliveries ?? []).map(suppressedDeliveryKey))
    for (const evidence of instanceEvidence) for (const item of child.boundary.inputs) {
      const whole = item.binds.kind === 'construct'
      if (evidence.ref.port !== item.id && !(whole && evidence.ref.port.startsWith(`${item.id}.`))) continue
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.kind !== 'port' && binding.kind !== 'construct') continue
        const port = binding.kind === 'construct'
          ? innerConstructAddress(child, binding, item.id, evidence.ref.port, (inner) => resolveNode(child.id, inner))
          : binding.port
        if (port === undefined) continue
        const leg = evidence.route?.[0]
        if (leg && (leg.graph !== child.id || leg.boundaryId !== item.id || boundaryBindingKey(leg.binding) !== boundaryBindingKey(binding))) continue
        const projectedRoute = [...(evidence.projectedRoute ?? []), { graph: child.id, boundaryId: item.id, binding }]
        if (evidence.delivery && suppressed.has(suppressedDeliveryKey({ kind: 'projectedLeg', delivery: evidence.delivery, route: projectedRoute }))) continue
        childEvidence.push({ ...evidence, ref: { node: binding.node, port: asPortId(port) }, projectedRoute, ...(evidence.route !== undefined ? { route: evidence.route.slice(1) } : {}) })
      }
    }
    for (const item of child.boundary.inputs) {
      if (item.promoted !== true) continue
      const owner = valueOwners.get(hop)?.get(item.id) ?? { graphId: def.id, nodeId: hop, valueKey: item.id }
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.kind !== 'port') continue
        const target = child.nodes[binding.node]
        const schema = target && resolveNode(child.id, target)
        if (!target || !schema) continue
        const route = resolveBoundaryRoute(schema, binding, 'input')
        if (!route.ok || route.route.terminal.kind !== 'port') continue
        const valueKey = binding.port as string
        let targetOwners = childValueOwners.get(binding.node)
        if (!targetOwners) childValueOwners.set(binding.node, (targetOwners = new Map()))
        if (!targetOwners.has(valueKey)) targetOwners.set(valueKey, owner)
        if (Object.hasOwn(instanceValues, item.id)) childValues.set(target.id, {
          ...(childValues.get(target.id) ?? target.values), [valueKey]: instanceValues[item.id]!,
        })
        if (Object.hasOwn(instanceControllers ?? {}, item.id)) childControllers.set(target.id, {
          ...(childControllers.get(target.id) ?? target.controllers), [valueKey]: instanceControllers![item.id]!,
        })
      }
    }
    // A construct the subgraph node shows whole: its members, picks and
    // values reach the inner node, and an edit there is written back outside.
    const constructs = projectConstructs(child, { values: instanceValues, ...(instanceDynamic !== undefined ? { dynamic: instanceDynamic } : {}) }, (inner) => resolveNode(child.id, inner), childOverlays)
    for (const [target, dynamic] of constructs.dynamic) childOverlays.set(target, dynamic)
    for (const [target, projected] of constructs.values) childValues.set(target, projected)
    for (const [target, owners] of constructs.owners) {
      const targetOwners = childValueOwners.get(target) ?? new Map<string, ValueOwner>()
      childValueOwners.set(target, targetOwners)
      for (const [valueKey, outerKey] of owners) {
        if (!targetOwners.has(valueKey)) targetOwners.set(valueKey, valueOwners.get(hop)?.get(outerKey) ?? { graphId: def.id, nodeId: hop, valueKey: outerKey })
      }
    }
    def = child
    overlays = childOverlays
    values = childValues
    controllers = childControllers
    valueOwners = childValueOwners
    inputEvidence = childEvidence
    traversedPath.push(hop)
  }
  const inputPorts = new Map<string, string[]>()
  for (const { ref } of inputEvidence) {
    const ports = inputPorts.get(ref.node) ?? []
    if (!inputPorts.has(ref.node)) inputPorts.set(ref.node, ports)
    if (!ports.includes(ref.port)) ports.push(ref.port)
  }
  return { inputPorts, dynamic: overlays, values, controllers, valueOwners }
}
