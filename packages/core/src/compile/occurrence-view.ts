import { boundaryBindingKey, isForwardingBinding, suppressedDeliveryKey, type BoundaryRouteLeg, type DynamicPortState, type GraphDef, type Json, type NodeData, type OccurrenceLinkEndpoint, type ParentDeliveryIdentity, type WorkflowDocument } from '../format/document.js'
import { asDynamicMemberId, asNodeId, asPortId, isOccurrenceAncestorOrSelf, isPortEndpoint, occurrenceKey, type OccurrenceRef, type PortRef } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { memberHopsOf, resolveBoundaryRoute, type SchemaResolver } from '../schema/derive-boundary.js'
import { elabKeyOf } from '../schema/elaborate.js'
import { buildBoundaryCrossings, crossingTargets, isSubtreeCrossing, overlayNodeDynamic, overlayPortDynamic, projectCountBoundValues, projectEditableOptions, projectCrossingValues, rekeySubtreeValues, translateThroughCrossing, type SubtreeCrossing } from './crossing.js'
import { boundaryStateResolver } from './boundary-state.js'
import { documentNodeResolver } from './compile.js'

export interface SubtreeOwner {
  readonly graphId: string
  readonly nodeId: string
  readonly occurrence: OccurrenceRef
  readonly route: readonly BoundaryRouteLeg[]
  readonly crossings: readonly SubtreeCrossing[]
}

/** Map an inner construct or value key back through its complete owner route. */
export function occurrenceSubtreeKey(owner: SubtreeOwner, key: string): string | undefined {
  let values: Record<string, true> = { [key]: true }
  for (const crossing of [...owner.crossings].reverse()) values = rekeySubtreeValues(values, crossing)
  return Object.keys(values)[0]
}

export interface SelectorOwner {
  readonly graphId: string
  readonly nodeId: string
  readonly boundaryId: string
}

export interface ValueOwner {
  readonly graphId: string
  readonly nodeId: string
  readonly valueKey: string
}

export interface FamilyOwner extends SelectorOwner {
  readonly occurrence: OccurrenceRef
  /** Inner occurrence construct receiving the forwarded family. */
  readonly familyPath: string
  /** Canonical single-leaf inputs carry the suffix in the dotted port id. */
  readonly optionalAfterMinimum?: true
  /** Derived inner id -> persisted id on the owning instance. */
  readonly suffixMembers: ReadonlyMap<string, string>
  /** Route from the immediate owner boundary to the projected family. */
  readonly route: readonly BoundaryRouteLeg[]
  /** Exact source owner and route for every projected suffix member. */
  readonly suffixOwners: ReadonlyMap<string, FamilyMemberOwner>
  /** Source owner; canonical ghost ids come from the elaborated address. */
  readonly ghostOwner: Omit<FamilyMemberOwner, 'sourceMember'> & { readonly sourceMember?: string }
}

export interface FamilyMemberOwner extends SelectorOwner {
  readonly occurrence: OccurrenceRef
  readonly sourceMember: string
  readonly route: readonly BoundaryRouteLeg[]
}

/** Exact persisted owner of a retained projected member, excluding definition members. */
export function occurrenceFamilyMemberOwner(owner: FamilyOwner, port: string, members: readonly string[] | undefined): FamilyMemberOwner | undefined {
  if (port !== owner.familyPath && !port.startsWith(`${owner.familyPath}.`)) return undefined
  if (owner.optionalAfterMinimum) return owner.suffixOwners.get(port.slice(owner.familyPath.length + 1))
  const matches = (members ?? []).flatMap((member) => {
    const source = owner.suffixOwners.get(member)
    return source === undefined ? [] : [source]
  })
  return matches.length === 1 ? matches[0] : undefined
}

/** Resolve a derived family pin back to its persisted occurrence coordinate. */
export function occurrenceFamilyEndpoint(
  owner: FamilyOwner,
  port: string,
  members: readonly string[] | undefined,
  predictedMember?: string,
): OccurrenceLinkEndpoint | undefined {
  if (port !== owner.familyPath && !port.startsWith(`${owner.familyPath}.`)) return undefined
  const retained = occurrenceFamilyMemberOwner(owner, port, members)
  const predictedIndex = predictedMember === undefined ? -1 : owner.optionalAfterMinimum
    ? port === `${owner.familyPath}.${predictedMember}` ? 0 : -1
    : (members ?? []).lastIndexOf(predictedMember)
  const source = retained ?? (predictedIndex < 0 ? undefined : owner.ghostOwner)
  if (source === undefined) return undefined
  const sourceMember = source.sourceMember ?? predictedMember
  if (sourceMember === undefined) return undefined
  const memberIndex = retained === undefined ? predictedIndex : (members ?? []).findIndex((member) => owner.suffixOwners.get(member) === retained)
  return {
    kind: 'boundary',
    occurrence: source.occurrence,
    address: {
      port: asPortId(`${source.route[0]?.boundaryId ?? owner.boundaryId}${port.slice(owner.familyPath.length)}`),
      ...(!owner.optionalAfterMinimum && members !== undefined ? {
        members: [sourceMember, ...members.slice(memberIndex + 1)].map(asDynamicMemberId),
      } : {}),
    },
    route: source.route,
  }
}

const nextFamilyMember = (state: DynamicPortState | undefined): string => {
  let highest = -1
  for (const member of [...(state?.members ?? []), ...Object.keys(state?.memberState ?? {})]) {
    const match = /^m(\d{1,15})$/.exec(member)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `m${Math.max(state?.seq ?? 0, highest + 1)}`
}

export interface OccurrenceDynamicView {
  /** Authored input addresses, including occurrence-local and projected deliveries. */
  readonly inputPorts: ReadonlyMap<string, readonly string[]>
  /** Per inner-node occurrence-effective dynamic state (only nodes that differ). */
  readonly dynamic: ReadonlyMap<string, Readonly<Record<string, DynamicPortState>>>
  /** Per inner-node occurrence-effective values (only nodes that differ). */
  readonly values: ReadonlyMap<string, Readonly<Record<string, Json>>>
  readonly controllers: ReadonlyMap<string, NonNullable<NodeData['controllers']>>
  readonly subtreeOwners: ReadonlyMap<string, readonly SubtreeOwner[]>
  /** Per inner-node projected value: where an edit must be written. */
  readonly valueOwners: ReadonlyMap<string, ReadonlyMap<string, ValueOwner>>
  /** Per inner-node, per elaborated construct path: where an edit must be written. */
  readonly selectorOwners: ReadonlyMap<string, ReadonlyMap<string, SelectorOwner>>
  /** Per inner-node, per family construct: occurrence-local suffix owner. */
  readonly familyOwners: ReadonlyMap<string, ReadonlyMap<string, FamilyOwner>>
}

interface InputEvidence {
  readonly ref: PortRef
  readonly route?: readonly BoundaryRouteLeg[]
  readonly delivery?: ParentDeliveryIdentity
  readonly projectedRoute?: readonly BoundaryRouteLeg[]
}

/** Collect endpoints before crossing resolution; existence never depends on solved topology. */
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
 * Project dynamic state down one concrete instance path exactly as compile
 * does, including family crossings and their occurrence-local edit owners.
 */
export function occurrenceDynamicView(
  doc: WorkflowDocument,
  resolve: SchemaResolver,
  instancePath: readonly string[],
  rootGraph: string = doc.root,
): OccurrenceDynamicView {
  const empty = (): OccurrenceDynamicView => ({ inputPorts: new Map(), dynamic: new Map(), values: new Map(), controllers: new Map(), subtreeOwners: new Map(), valueOwners: new Map(), selectorOwners: new Map(), familyOwners: new Map() })

  const resolveNode = documentNodeResolver(doc, resolve)
  const effectiveState = boundaryStateResolver(doc, resolveNode)
  let def = doc.graphs[rootGraph]
  let overlays = new Map<string, Readonly<Record<string, DynamicPortState>>>()
  let values = new Map<string, Readonly<Record<string, Json>>>()
  let controllers = new Map<string, NonNullable<NodeData['controllers']>>()
  let subtreeOwners = new Map<string, readonly SubtreeOwner[]>()
  let valueOwners = new Map<string, ReadonlyMap<string, ValueOwner>>()
  let owners = new Map<string, ReadonlyMap<string, SelectorOwner>>()
  let familyOwners = new Map<string, ReadonlyMap<string, FamilyOwner>>()
  const traversedPath: string[] = []
  let inputEvidence = authoredInputEvidence(doc, def, traversedPath)
  const inheritBody = (body: GraphDef | undefined): void => {
    if (!body) return
    for (const node of Object.values(body.nodes)) {
      const dynamic = overlays.get(node.id)
      const projectedValues = values.get(node.id)
      const projectedControllers = controllers.get(node.id)
      const authored = dynamic === undefined && projectedValues === undefined && projectedControllers === undefined ? node : {
        ...node,
        ...(dynamic !== undefined ? { dynamic } : {}),
        ...(projectedValues !== undefined ? { values: projectedValues } : {}),
        ...(projectedControllers !== undefined ? { controllers: projectedControllers } : {}),
      }
      const state = effectiveState(body.id, node, authored)
      if (state === node) continue
      values.set(node.id, state.values)
      if (state.dynamic !== undefined) overlays.set(node.id, state.dynamic)
      if (state.controllers !== undefined) controllers.set(node.id, state.controllers)
    }
  }
  inheritBody(def)
  for (const hop of instancePath) {
    const node = def?.nodes[hop]
    const childId = node === undefined ? undefined : subgraphDefIdOf(node.type)
    const child = childId === undefined ? undefined : doc.graphs[childId]
    if (!def || !node || !child?.boundary) return empty()

    const instanceDynamic = overlays.get(hop) ?? node.dynamic
    const instanceValues = values.get(hop) ?? node.values
    const instanceControllers = controllers.get(hop) ?? node.controllers
    const childOverlays = new Map<string, Readonly<Record<string, DynamicPortState>>>(projectEditableOptions(child, instanceDynamic, (inner) => resolveNode(child.id, inner)))
    const childValues = new Map(projectCountBoundValues(child, instanceValues, (inner) => resolveNode(child.id, inner)))
    const childControllers = new Map<string, NonNullable<NodeData['controllers']>>()
    const childSubtreeOwners = new Map<string, SubtreeOwner[]>()
    const childValueOwners = new Map<string, Map<string, ValueOwner>>()
    const childOwners = new Map<string, Map<string, SelectorOwner>>()
    const childFamilyOwners = new Map<string, Map<string, FamilyOwner>>()
    // A recorded route ends in this body; only unrecorded deliveries may continue freely.
    const instanceEvidence = inputEvidence.filter(({ ref, route }) => ref.node === node.id && route?.length !== 0)
    const instanceInputs = instanceEvidence.map(({ ref }) => ref.port)
    const { crossings, problems } = buildBoundaryCrossings(child, resolve, instanceDynamic, (inner) => resolveNode(child.id, inner), instanceValues, instanceInputs)
    if (problems.length > 0) return empty()
    const childEvidence = authoredInputEvidence(doc, child, [...traversedPath, hop])
    const childOwner = { instancePath: traversedPath.map(asNodeId), node: asNodeId(hop) }
    const suppressed = new Set((doc.occurrenceTopologies?.[occurrenceKey(childOwner)]?.suppressedDeliveries ?? []).map(suppressedDeliveryKey))
    for (const evidence of instanceEvidence) for (const item of child.boundary.inputs) {
      if (evidence.ref.port !== item.id && !evidence.ref.port.startsWith(`${item.id}.`)) continue
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      for (const [index, binding] of bindings.entries()) {
        if (binding.kind !== 'port' && !isForwardingBinding(binding)) continue
        const leg = evidence.route?.[0]
        if (leg && (leg.graph !== child.id || leg.boundaryId !== item.id || boundaryBindingKey(leg.binding) !== boundaryBindingKey(binding))) continue
        if (!isForwardingBinding(binding) && (evidence.ref.port !== item.id || evidence.ref.members !== undefined)) continue
        const projectedRoute = [...(evidence.projectedRoute ?? []), { graph: child.id, boundaryId: item.id, binding }]
        if (evidence.delivery && suppressed.has(suppressedDeliveryKey({ kind: 'projectedLeg', delivery: evidence.delivery, route: projectedRoute }))) continue
        const crossing = crossings.get(item.id)
        const target = crossing && crossingTargets(crossing)[index]
        const translated = isForwardingBinding(binding)
          ? target && translateThroughCrossing(target, evidence.ref)
          : { ok: true as const, ref: binding }
        if (!translated?.ok || !isPortEndpoint(translated.ref)) continue
        childEvidence.push({ ...evidence, ref: translated.ref, projectedRoute, ...(evidence.route !== undefined ? { route: evidence.route.slice(1) } : {}) })
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
        if (!route.ok || route.route.terminal.kind !== 'port' || route.route.terminal.slot.dynamic !== undefined) continue
        const valueKey = binding.members?.length ? elabKeyOf(binding) : binding.port as string
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
    for (const primaryCrossing of crossings.values()) {
      const boundaryItems = primaryCrossing.side === 'input' ? child.boundary.inputs : child.boundary.outputs
      const item = boundaryItems.find((candidate) => candidate.id === primaryCrossing.boundaryId)!
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      for (const [crossingIndex, crossing] of crossingTargets(primaryCrossing).entries()) {
        if (!isSubtreeCrossing(crossing) && crossing.countBound) continue
        const base = childOverlays.get(crossing.targetNode) ?? child.nodes[crossing.targetNode]?.dynamic
        const target = child.nodes[crossing.targetNode]!
        // Link evidence follows its remaining route, not synthesized instance membership.
        const stateCrossing = !isSubtreeCrossing(crossing) && crossing.optionalAfterMinimum && subgraphDefIdOf(target.type) !== undefined
          ? { ...crossing, rebase: new Map([...crossing.rebase].filter(([member]) => instanceDynamic?.[crossing.boundaryId]?.members?.includes(member))) }
          : crossing
        childOverlays.set(crossing.targetNode, overlayNodeDynamic(base, stateCrossing, instanceDynamic))
        childValues.set(target.id, { ...(childValues.get(target.id) ?? target.values), ...projectCrossingValues(instanceValues, crossing) })
        childControllers.set(target.id, { ...(childControllers.get(target.id) ?? target.controllers), ...projectCrossingValues(instanceControllers, crossing) })
        if (isSubtreeCrossing(crossing)) {
          const inherited = (subtreeOwners.get(hop) ?? []).filter((owner) => occurrenceSubtreeKey(owner, crossing.boundaryId) !== undefined)
          const leg: BoundaryRouteLeg = { graph: child.id, boundaryId: crossing.boundaryId, binding: item.binds }
          for (const family of familyOwners.get(hop)?.values() ?? []) {
            const translated = translateThroughCrossing(crossing, { port: family.familyPath })
            if (!translated.ok) continue
            let byConstruct = childFamilyOwners.get(target.id)
            if (!byConstruct) childFamilyOwners.set(target.id, (byConstruct = new Map()))
            byConstruct.set(translated.ref.port, {
              ...family, familyPath: translated.ref.port, route: [...family.route, leg],
              suffixOwners: new Map([...family.suffixOwners].map(([id, source]) => [id, { ...source, route: [...source.route, leg] }])),
              ghostOwner: { ...family.ghostOwner, route: [...family.ghostOwner.route, leg] },
            })
          }
          const owner: SubtreeOwner = inherited.length === 1 ? {
            ...inherited[0]!, route: [...inherited[0]!.route, leg], crossings: [...inherited[0]!.crossings, crossing],
          } : {
            graphId: def.id, nodeId: hop, occurrence: { instancePath: traversedPath.map(asNodeId), node: asNodeId(hop) },
            route: [leg], crossings: [crossing],
          }
          childSubtreeOwners.set(target.id, [...(childSubtreeOwners.get(target.id) ?? []), owner])
          continue
        }
        const inherited = familyOwners.get(hop)?.get(crossing.boundaryId)
        const persistedToInner = crossing.rebase
        const suffixMembers = new Map<string, string>()
        const suffixOwners = new Map<string, FamilyMemberOwner>()
        const routeLeg: BoundaryRouteLeg = {
          graph: child.id,
          boundaryId: crossing.boundaryId,
          binding: bindings[crossingIndex]!,
        }
        const occurrence: OccurrenceRef = {
          instancePath: traversedPath.map(asNodeId),
          node: asNodeId(hop),
        }
        const inheritedGhost = inherited?.ghostOwner
        const ghostOwner: FamilyOwner['ghostOwner'] = inheritedGhost === undefined ? {
          graphId: def.id,
          nodeId: hop,
          boundaryId: crossing.boundaryId,
          occurrence,
          ...(!crossing.optionalAfterMinimum ? { sourceMember: nextFamilyMember(instanceDynamic?.[crossing.boundaryId]) } : {}),
          route: [routeLeg],
        } : { ...inheritedGhost, route: [...inheritedGhost.route, routeLeg] }
        for (const [persistedAtThisLevel, inner] of persistedToInner) {
          const inheritedOwner = inherited?.suffixOwners.get(persistedAtThisLevel)
          if (inheritedOwner !== undefined) {
            suffixMembers.set(inner, inheritedOwner.sourceMember)
            suffixOwners.set(inner, { ...inheritedOwner, route: [...inheritedOwner.route, routeLeg] })
          } else {
            suffixMembers.set(inner, persistedAtThisLevel)
            suffixOwners.set(inner, {
              graphId: def.id,
              nodeId: hop,
              boundaryId: crossing.boundaryId,
              occurrence,
              sourceMember: persistedAtThisLevel,
              route: [routeLeg],
            })
          }
        }
        let byConstruct = childFamilyOwners.get(crossing.targetNode)
        if (!byConstruct) childFamilyOwners.set(crossing.targetNode, (byConstruct = new Map()))
        byConstruct.set(crossing.familyPath, {
          graphId: def.id,
          nodeId: hop,
          boundaryId: crossing.boundaryId,
          occurrence,
          familyPath: crossing.familyPath,
          ...(crossing.optionalAfterMinimum ? { optionalAfterMinimum: true } : {}),
          suffixMembers,
          route: [routeLeg],
          suffixOwners,
          ghostOwner,
        })
      }
    }
    for (const item of child.boundary.inputs) {
      if (item.binds.kind !== 'port') continue
      const target = child.nodes[item.binds.node]
      const schema = target && resolveNode(child.id, target)
      if (!target || !schema) continue
      const rr = resolveBoundaryRoute(schema, item.binds, 'input')
      if (!rr.ok || rr.route.terminal.kind !== 'port') continue
      const dynamic = rr.route.terminal.slot.dynamic
      if (dynamic?.kind !== 'dynamicCombo') continue

      // Member-scoped edit ownership is deferred with occurrence family view;
      // unscoped constructs already cover ordinary forwarded selectors.
      if (memberHopsOf(rr.route.hops).length === 0) {
        const owner = owners.get(hop)?.get(item.id) ?? { graphId: def.id, nodeId: hop, boundaryId: item.id }
        let byConstruct = childOwners.get(target.id)
        if (!byConstruct) childOwners.set(target.id, (byConstruct = new Map()))
        byConstruct.set(item.binds.port as string, owner)
      }

      const requested = instanceDynamic?.[item.id]?.selected
      if (requested === undefined || !dynamic.options.some((option) => option.key === requested)) continue
      const base = childOverlays.get(target.id) ?? target.dynamic
      childOverlays.set(target.id, overlayPortDynamic(base, rr.route, item.binds.port as string, { selected: requested }))
    }
    def = child
    overlays = childOverlays
    values = childValues
    controllers = childControllers
    subtreeOwners = childSubtreeOwners
    valueOwners = childValueOwners
    owners = childOwners
    familyOwners = childFamilyOwners
    inputEvidence = childEvidence
    traversedPath.push(hop)
    inheritBody(def)
  }
  const inputPorts = new Map<string, string[]>()
  for (const { ref } of inputEvidence) {
    const ports = inputPorts.get(ref.node) ?? []
    if (!inputPorts.has(ref.node)) inputPorts.set(ref.node, ports)
    if (!ports.includes(ref.port)) ports.push(ref.port)
  }
  return { inputPorts, dynamic: overlays, values, controllers, subtreeOwners, valueOwners, selectorOwners: owners, familyOwners }
}
