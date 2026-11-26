import type {
  BoundaryBinding,
  BoundaryLimits,
  BoundaryItem,
  ControllerMode,
  DynamicPortState,
  ExtData,
  GraphDef,
  GraphViewState,
  GroupViewState,
  Json,
  JsonObject,
  NodeData,
  RegionContract,
  Vec2,
  WorkflowDocument,
} from '../format/document.js'
import { isNodeBoundaryBinding } from '../format/document.js'
import { validateGraphDefShape, validateGraphViewShape } from '../format/validate.js'
import { diag, type Diagnostic } from '../diagnostics.js'
import type { CommandInvocation } from '../commands/contract.js'
import { asGraphDefId, asNodeId, asPortId } from '../ids.js'
import {
  isPortEndpoint,
  isRerouteRef,
  isWidgetTapRef,
  portRefKey,
  type LinkEndpoint,
  type PortRef,
  type WidgetTapRef,
} from '../ids.js'
import { canonicalJson, sha256Hex } from '../compile/hash.js'
import { subgraphDefIdOf } from '../invariants.js'
import { constructRowOf, deriveBoundarySchema, resolveBoundaryRoute, type SchemaResolver } from '../schema/derive-boundary.js'
import type { NodeSchema } from '../schema/model.js'
import { DEFAULT_ELAB_BUDGET, elaborateInterface, EMPTY_CONNECTIVITY, valueKeyOf } from '../schema/elaborate.js'
import { effectiveWidgetDefault } from '../schema/widget-defaults.js'
import { decodeModePanelConfig, MODE_PANEL_TYPE } from '../surfaces/mode-panel.js'
import { innerConstructAddress, matchBoundaryItem, projectConstructs } from '../compile/crossing.js'
import { rerouteInputTargets } from '../reroute.js'
import { boundaryItems } from '../format/document.js'

export const LIFECYCLE_PLAN_VERSION = 'subgraph-lifecycle-plan-v2'

export type FlattenRouteKind = 'plain' | 'plainWidget' | 'widgetTap' | 'unresolved'

export interface FlattenBoundaryPlanEntry {
  readonly side: 'input' | 'output'
  readonly id: string
  readonly route: FlattenRouteKind
}

export interface FlattenSchemaPlan {
  readonly boundaryPlan: readonly FlattenBoundaryPlanEntry[]
  readonly statePlan: FlattenStatePlan
  /** Keyed by the authored document type, even when resolution returns a canonical alias target. */
  readonly schemaSnapshot: Readonly<Record<string, NodeSchema>>
  readonly schemaPlanDigest: string
}

export type FlattenStateRefusalCode =
  | 'subgraph.flatten.stateUnresolved'
  | 'subgraph.flatten.dormantStateUnsupported'
  | 'subgraph.lifecycle.boundaryUnresolved'
  | 'subgraph.lifecycle.idExhausted'

export interface FlattenNodeStateSnapshot {
  readonly node: string
  readonly type: string
  readonly values: Readonly<Record<string, Json>>
  readonly controllers?: Readonly<Record<string, ControllerMode>>
  readonly dynamic?: Readonly<Record<string, DynamicPortState>>
}

export interface FlattenStateSource {
  readonly occurrence: FlattenNodeStateSnapshot
  readonly bodyNodes: readonly FlattenNodeStateSnapshot[]
}

export interface FlattenBoundaryStateRoute {
  readonly side: 'input' | 'output'
  readonly id: string
  readonly bindingCount: number
}

export interface FlattenPortAddress {
  readonly port: string
}

export interface FlattenEnclosingBindingRewrite {
  readonly side: 'input' | 'output'
  readonly itemIndex: number
  readonly itemId: string
  readonly bindingIndex: number
  readonly before: BoundaryBinding
  readonly after: readonly BoundaryBinding[]
}

export interface FlattenReadyStatePlan {
  readonly version: 'subgraph-flatten-state-plan-v1'
  readonly status: 'ready'
  readonly source: FlattenStateSource
  readonly nodes: readonly FlattenNodeStateSnapshot[]
  readonly routes: readonly FlattenBoundaryStateRoute[]
  readonly enclosingRewrites: readonly FlattenEnclosingBindingRewrite[]
}

export interface FlattenRefusedStatePlan {
  readonly version: 'subgraph-flatten-state-plan-v1'
  readonly status: 'refused'
  readonly source: FlattenStateSource
  readonly refusal: {
    readonly code: FlattenStateRefusalCode
    readonly message: string
    readonly side?: 'input' | 'output'
    readonly boundaryId?: string
    readonly key?: string
    readonly address?: FlattenPortAddress
  }
}

export type FlattenStatePlan = FlattenReadyStatePlan | FlattenRefusedStatePlan

export interface FlattenStoredStateInventory {
  readonly valueKeys: readonly string[]
  readonly controllerKeys: readonly string[]
  readonly dynamicPaths: readonly string[]
  readonly portKeys: readonly string[]
}

export interface FlattenStoredPortEvidence {
  readonly key: string
  readonly side: 'input' | 'output'
  readonly use?: 'link' | 'net' | 'enclosing'
}

export type FlattenStoredStateWalk =
  | { readonly ok: true; readonly inventory: FlattenStoredStateInventory }
  | { readonly ok: false; readonly code: 'subgraph.flatten.stateUnresolved'; readonly message: string }

/**
 * Inventories persisted state against the node's body, including the rows
 * of options and variants that are not chosen and every stored member.
 * Every stored value, controller, member state and wire end must belong to
 * a row the body holds.
 */
export function walkFlattenStoredState(
  node: Pick<NodeData, 'type' | 'values' | 'controllers' | 'dynamic'>,
  schema: NodeSchema,
  rawPortEvidence: readonly (string | FlattenStoredPortEvidence)[] = [],
  boundaryPlan?: readonly FlattenBoundaryPlanEntry[],
): FlattenStoredStateWalk {
  const portEvidence = rawPortEvidence.map((entry): FlattenStoredPortEvidence =>
    typeof entry === 'string' ? { key: entry, side: 'input' } : entry)
  const portKeys = portEvidence.map((entry) => entry.key)
  const valueKeys = Object.keys(node.values)
  const controllerKeys = Object.keys(node.controllers ?? {})
  const dynamicPaths = Object.keys(node.dynamic ?? {}).filter((key) => Object.keys(node.dynamic![key]!).length > 0)
  const routeIds = boundaryPlan === undefined ? undefined : new Set(boundaryPlan.map((route) => JSON.stringify([route.side, route.id])))
  const fail = (message: string): FlattenStoredStateWalk => ({ ok: false, code: 'subgraph.flatten.stateUnresolved', message })
  const census = elaborateInterface(schema, node, EMPTY_CONNECTIVITY, { promoteGhosts: false, includeDormant: true })
  const error = census.diagnostics.find((entry) => entry.severity === 'error')
  if (error !== undefined) return fail(`${node.type}: ${error.message}`)
  // A row's boundary route is its top-level row: the first segment of its flattened id.
  const routeOf = (side: 'input' | 'output', key: string): string => JSON.stringify([side, key.split('.', 1)[0]])
  const allowedValues = new Set<string>()
  const allowedControllers = new Set<string>()
  const allowedPorts = new Map<string, 'input' | 'output'>()
  for (const item of census.items) {
    if (item.kind === 'input') {
      const key = valueKeyOf(item)
      allowedValues.add(key)
      if (item.spec.widget?.controller !== undefined) allowedControllers.add(key)
      allowedPorts.set(key, 'input')
    } else if (item.kind === 'output') allowedPorts.set(item.address.port, 'output')
  }
  if (allowedPorts.size > DEFAULT_ELAB_BUDGET.maxItems) return fail(`${node.type}: schema descriptors exceed the ${DEFAULT_ELAB_BUDGET.maxItems}-item budget`)
  const constructs = new Set(census.constructs)
  for (const key of valueKeys) {
    if (!allowedValues.has(key)) return fail(`${node.type}: stored value '${key}' has no schema-owned input`)
    if (routeIds !== undefined && !routeIds.has(routeOf('input', key))) return fail(`${node.type}: stored value '${key}' has no unique boundary route`)
  }
  for (const key of controllerKeys) {
    if (!allowedValues.has(key) || !allowedControllers.has(key)) return fail(`${node.type}: stored controller '${key}' has no controller-capable input`)
    if (routeIds !== undefined && !routeIds.has(routeOf('input', key))) return fail(`${node.type}: stored controller '${key}' has no unique boundary route`)
  }
  for (const { key, side } of portEvidence) {
    if (!allowedPorts.has(key)) return fail(`${node.type}: structural endpoint '${key}' has no schema-owned port`)
    if (routeIds !== undefined && (allowedPorts.get(key) !== side || !routeIds.has(routeOf(side, key)))) {
      return fail(`${node.type}: structural endpoint '${key}' has no unique boundary route`)
    }
  }
  for (const key of Object.keys(node.dynamic ?? {})) {
    if (!constructs.has(key)) return fail(`${node.type}: dynamic state '${key}' has no schema-owned construct`)
  }
  return { ok: true, inventory: { valueKeys, controllerKeys, dynamicPaths, portKeys } }
}

function occurrencePortEvidence(parent: GraphDef, nodeId: string): FlattenStoredPortEvidence[] {
  const evidence: FlattenStoredPortEvidence[] = []
  const add = (ref: PortRef, side: 'input' | 'output', use: 'link' | 'net' | 'enclosing'): void => {
    if (ref.node !== nodeId) return
    evidence.push({ key: ref.port, side, use })
  }
  for (const link of Object.values(parent.links).sort((a, b) => compareStrings(a.id, b.id))) {
    if (isPortEndpoint(link.from)) add(link.from, 'output', 'link')
    if (isWidgetTapRef(link.from) && link.from.node === nodeId) evidence.push({ key: link.from.tap, side: 'input' })
    if (isPortEndpoint(link.to)) add(link.to, 'input', 'link')
  }
  for (const net of Object.values(parent.nets).sort((a, b) => compareStrings(a.id, b.id))) {
    if (isPortEndpoint(net.source)) add(net.source, 'output', 'net')
    for (const sink of net.sinks) if (isPortEndpoint(sink)) add(sink, 'input', 'net')
  }
  for (const [side, items] of [['input', boundaryItems(parent.boundary, 'inputs') ?? []], ['output', boundaryItems(parent.boundary, 'outputs') ?? []]] as const) {
    for (const item of items) {
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.node !== nodeId) continue
        // A construct shown whole is checked by its enclosing rewrite, not as one port.
        if (binding.kind === 'widgetTap' || binding.kind === 'construct') continue
        add({ node: binding.node, port: binding.port }, side, 'enclosing')
      }
    }
  }
  return evidence
}

/**
 * How one boundary binding flattens. A binding that shows a whole group,
 * choice, type choice or described row flattens to that construct, which
 * takes the subgraph node's own members, pick and values.
 */
export function classifyFlattenBindingRoute(
  binding: BoundaryBinding,
  schema: NodeSchema | undefined,
  expectedSide?: 'input' | 'output',
  node?: Pick<NodeData, 'values' | 'dynamic'>,
): FlattenRouteKind {
  if (binding.kind === 'widgetTap') return expectedSide === 'output' ? 'widgetTap' : 'unresolved'
  if (binding.kind === 'construct' && schema !== undefined) {
    const resolved = resolveBoundaryRoute(schema, binding, expectedSide, node?.values, node?.dynamic)
    return resolved.ok && constructRowOf(resolved.route) !== undefined ? 'plain' : 'unresolved'
  }
  if (binding.kind !== 'port' || schema === undefined) return 'unresolved'
  const resolved = resolveBoundaryRoute(schema, binding, expectedSide, node?.values, node?.dynamic)
  if (!resolved.ok || resolved.route.terminal.kind !== 'port') return 'unresolved'
  const slot = resolved.route.terminal.slot
  return slot.kind === 'input' && slot.widget !== undefined ? 'plainWidget' : 'plain'
}

export function classifyFlattenBoundaryRoute(
  body: GraphDef,
  item: BoundaryItem,
  resolveSchema: SchemaResolver,
  expectedSide?: 'input' | 'output',
): FlattenRouteKind {
  const routes = [item.binds, ...(item.alsoBinds ?? [])].flatMap((binding) => flattenBindingTargets(body, binding)).map((binding) => {
    if (!isNodeBoundaryBinding(binding)) return 'unresolved'
    const node = body.nodes[binding.node]
    return classifyFlattenBindingRoute(binding, node === undefined ? undefined : resolveSchema(node.type), expectedSide, node)
  })
  return routes.includes('unresolved') ? 'unresolved' : routes[0] ?? 'unresolved'
}

function flattenBindingTargets(body: GraphDef, binding: BoundaryBinding): readonly BoundaryBinding[] {
  if (binding.kind !== 'port' || binding.viaReroute === undefined) return [binding]
  return (rerouteInputTargets(body, binding.viaReroute) ?? []).map((target) => ({ kind: 'port', ...target }))
}

export function planFlattenBoundaryRoutes(
  body: GraphDef,
  resolveSchema: SchemaResolver,
  occurrence: NodeData,
  parent: GraphDef,
): FlattenSchemaPlan {
  const schemaSnapshot: Record<string, NodeSchema> = {}
  for (const node of Object.values(body.nodes)) {
    const schema = resolveSchema(node.type)
    if (schema !== undefined) schemaSnapshot[node.type] = schema
  }
  const items = [
    ...(boundaryItems(body.boundary, 'inputs') ?? []).map((item) => ({ side: 'input' as const, item })),
    ...(boundaryItems(body.boundary, 'outputs') ?? []).map((item) => ({ side: 'output' as const, item })),
  ]
  const boundaryPlan = items.map(({ side, item }) => {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (!isNodeBoundaryBinding(binding)) continue
      const node = body.nodes[binding.node]
      const schema = node === undefined ? undefined : resolveSchema(node.type)
      if (node !== undefined && schema !== undefined) schemaSnapshot[node.type] = schema
    }
    return { side, id: item.id, route: classifyFlattenBoundaryRoute(body, item, resolveSchema, side) }
  })
  const statePlan = planFlattenState(body, occurrence, parent, resolveSchema, schemaSnapshot, boundaryPlan, occurrencePortEvidence(parent, occurrence.id))
  return {
    boundaryPlan,
    statePlan,
    schemaSnapshot,
    schemaPlanDigest: flattenSchemaPlanDigest(schemaSnapshot, boundaryPlan, statePlan),
  }
}

const stateSnapshot = (node: Pick<NodeData, 'id' | 'type' | 'values' | 'controllers' | 'dynamic'>): FlattenNodeStateSnapshot => ({
  node: node.id as string,
  type: node.type,
  values: structuredClone(node.values),
  ...(node.controllers !== undefined && Object.keys(node.controllers).length > 0 ? { controllers: structuredClone(node.controllers) } : {}),
  ...(node.dynamic !== undefined && Object.keys(node.dynamic).length > 0 ? { dynamic: structuredClone(node.dynamic) } : {}),
})

type MutableFlattenSnapshot = {
  node: string
  type: string
  values: Record<string, Json>
  controllers?: Record<string, ControllerMode>
  dynamic?: Record<string, DynamicPortState>
}

function planFlattenState(
  body: GraphDef,
  occurrence: NodeData,
  parent: GraphDef,
  resolveSchema: SchemaResolver,
  schemaSnapshot: Record<string, NodeSchema>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  occurrencePorts: readonly FlattenStoredPortEvidence[],
): FlattenStatePlan {
  const bodyNodes = Object.values(body.nodes).sort((a, b) => compareStrings(a.id, b.id)).map(stateSnapshot)
  const source: FlattenStateSource = {
    occurrence: stateSnapshot(occurrence),
    bodyNodes,
  }
  const nodes = new Map(bodyNodes.map((node) => [node.node, structuredClone(node) as MutableFlattenSnapshot]))
  const routes: Array<{
    side: 'input' | 'output'
    id: string
    bindingCount: number
  }> = []
  let refusal: FlattenRefusedStatePlan['refusal'] | undefined
  const items = [
    ...(boundaryItems(body.boundary, 'inputs') ?? []).map((item) => ({ side: 'input' as const, item })),
    ...(boundaryItems(body.boundary, 'outputs') ?? []).map((item) => ({ side: 'output' as const, item })),
  ]
  const fail = (code: FlattenStateRefusalCode, message: string, side?: 'input' | 'output', boundaryId?: string, key?: string, address?: FlattenPortAddress): void => {
    if (refusal === undefined) refusal = {
      code,
      message,
      ...(side !== undefined ? { side } : {}),
      ...(boundaryId !== undefined ? { boundaryId } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(address !== undefined ? { address } : {}),
    }
  }

  const occurrenceSchema = deriveBoundarySchema(body, resolveSchema)

  for (const [{ side, item }, routePlan] of items.map((item, index) => [item, boundaryPlan[index]!] as const)) {
    const stateRoute: {
      side: 'input' | 'output'
      id: string
      bindingCount: number
    } = {
      side,
      id: item.id,
      bindingCount: 1 + (item.alsoBinds?.length ?? 0),
    }
    routes.push(stateRoute)
    if (routePlan.route === 'widgetTap') continue
    if (routePlan.route === 'unresolved') {
      fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' has no unique schema interpretation`, side, item.id)
      continue
    }
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])].flatMap((binding) => flattenBindingTargets(body, binding))) {
      if (!isNodeBoundaryBinding(binding)) continue
      const original = body.nodes[binding.node]
      const schema = original === undefined ? undefined : resolveSchema(original.type)
      const target = original === undefined ? undefined : nodes.get(original.id as string)
      if (original === undefined || target === undefined || schema === undefined) {
        fail('subgraph.flatten.stateUnresolved', `boundary '${item.id}' has an unresolved target`, side, item.id)
        continue
      }
      schemaSnapshot[original.type] = schema
      const resolved = resolveBoundaryRoute(schema, binding, side, original.values, original.dynamic)
      if (!resolved.ok) {
        fail('subgraph.flatten.stateUnresolved', resolved.message, side, item.id)
        continue
      }
    }
  }

  const inputItems = new Map((boundaryItems(body.boundary, 'inputs') ?? []).map((item) => [item.id, item]))
  // State the subgraph node keeps under a construct it shows whole moves
  // onto that construct's inner nodes.
  const constructItems = new Set([...(boundaryItems(body.boundary, 'inputs') ?? []), ...(boundaryItems(body.boundary, 'outputs') ?? [])]
    .filter((item) => item.binds.kind === 'construct').map((item) => item.id))
  const underConstruct = (key: string): boolean => constructItems.has(key.split('.', 1)[0]!)
  if (occurrenceSchema.schema !== undefined) {
    const walked = walkFlattenStoredState(occurrence, occurrenceSchema.schema, occurrencePorts, boundaryPlan)
    if (!walked.ok) {
      fail(walked.code, walked.message)
    } else {
      for (const path of walked.inventory.dynamicPaths) {
        if (underConstruct(path)) continue
        fail('subgraph.flatten.stateUnresolved', `occurrence dynamic state '${path}' has no eligible flattened owner`)
      }
    }
  } else fail('subgraph.lifecycle.boundaryUnresolved', 'body boundary cannot be derived into one occurrence schema')

  if (constructItems.size > 0) {
    const projected = projectConstructs(body, occurrence, (node) => resolveSchema(node.type))
    for (const [id, dynamic] of projected.dynamic) {
      const target = nodes.get(id as string)
      if (target !== undefined) target.dynamic = structuredClone({ ...dynamic })
    }
    for (const [id, values] of projected.values) {
      const target = nodes.get(id as string)
      if (target !== undefined) target.values = structuredClone({ ...values })
    }
  }

  const stateKeys = new Set([...Object.keys(occurrence.values), ...Object.keys(occurrence.controllers ?? {})])
  for (const key of stateKeys) {
    if (underConstruct(key) && !Object.hasOwn(occurrence.controllers ?? {}, key)) continue
    const item = inputItems.get(key)
    if (item === undefined || item.promoted !== true) {
      fail(item !== undefined && item.promoted !== true
        ? 'subgraph.flatten.dormantStateUnsupported'
        : 'subgraph.flatten.stateUnresolved', `occurrence state '${key}' has no eligible flattened owner`, 'input', item?.id, key)
    }
  }

  for (const item of boundaryItems(body.boundary, 'inputs') ?? []) {
    if (item.promoted !== true) continue
    const targets = [item.binds, ...(item.alsoBinds ?? [])].flatMap((binding) => flattenBindingTargets(body, binding))
    const primaryBinding = item.binds
    if (!isNodeBoundaryBinding(primaryBinding)) continue
    const primaryNode = body.nodes[primaryBinding.node]
    const primarySchema = primaryNode === undefined ? undefined : resolveSchema(primaryNode.type)
    const primaryRoute = primarySchema === undefined ? undefined : resolveBoundaryRoute(primarySchema, primaryBinding, 'input', primaryNode?.values, primaryNode?.dynamic)
    const primarySlot = primaryRoute?.ok === true && primaryRoute.route.terminal.kind === 'port' ? primaryRoute.route.terminal.slot : undefined
    const primaryState = nodes.get(primaryBinding.node as string)
    if (primarySlot?.kind !== 'input' || primaryState === undefined || primaryBinding.kind !== 'port') {
      fail('subgraph.flatten.stateUnresolved', `promoted boundary '${item.id}' has no plain primary widget`, 'input', item.id)
      continue
    }
    const primaryKey = primaryBinding.port as string
    const value = Object.hasOwn(occurrence.values, item.id)
      ? occurrence.values[item.id]
      : Object.hasOwn(primaryState.values, primaryKey)
        ? primaryState.values[primaryKey]
        : primarySlot.widget === undefined ? undefined : effectiveWidgetDefault(primarySlot.widget) as Json | undefined
    const controller = Object.hasOwn(occurrence.controllers ?? {}, item.id)
      ? occurrence.controllers![item.id]
      : Object.hasOwn(primaryState.controllers ?? {}, primaryKey)
        ? primaryState.controllers![primaryKey]
        : primarySlot.widget?.controllerInitial ?? (primarySlot.widget?.controller !== undefined ? 'randomize' : undefined)
    for (const binding of targets) {
      const target = nodes.get(binding.node as string)
      if (target === undefined || binding.kind !== 'port') {
        fail('subgraph.flatten.stateUnresolved', `promoted boundary '${item.id}' cannot map to one plain target`, 'input', item.id)
        continue
      }
      const targetKey = binding.port as string
      const targetValues = { ...target.values }
      delete targetValues[targetKey]
      if (value !== undefined) targetValues[targetKey] = value
      const targetControllers = { ...(target.controllers ?? {}) }
      delete targetControllers[targetKey]
      if (controller !== undefined) targetControllers[targetKey] = controller
      target.values = targetValues
      if (Object.keys(targetControllers).length > 0) target.controllers = targetControllers
      else delete target.controllers
    }
  }

  const enclosingRewrites: FlattenEnclosingBindingRewrite[] = []
  const enclosingSides = [
    { side: 'input' as const, parentItems: boundaryItems(parent.boundary, 'inputs') ?? [], childItems: boundaryItems(body.boundary, 'inputs') ?? [] },
    { side: 'output' as const, parentItems: boundaryItems(parent.boundary, 'outputs') ?? [], childItems: boundaryItems(body.boundary, 'outputs') ?? [] },
  ]
  for (const { side, parentItems, childItems } of enclosingSides) {
    for (const [itemIndex, parentItem] of parentItems.entries()) {
      const bindings = [parentItem.binds, ...(parentItem.alsoBinds ?? [])]
      for (const [bindingIndex, binding] of bindings.entries()) {
        if (binding.node !== occurrence.id) continue
        if (binding.kind === 'widgetTap') {
          fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' widget tap cannot route through an occurrence`, side)
          continue
        }
        const childMatch = matchBoundaryItem(childItems, binding)
        if (!childMatch.ok) {
          fail('subgraph.flatten.stateUnresolved', `enclosing ${side} '${parentItem.id}' has ${childMatch.code} descendant route`, side)
          continue
        }
        const childItem = childMatch.item
        const route = boundaryPlan.find((entry) => entry.side === side && entry.id === childItem.id)
        const childBindings = route === undefined ? [] : [childItem.binds, ...(childItem.alsoBinds ?? [])]
        // Under a construct shown whole, the enclosing row binds the matching inner row.
        const after = childBindings.flatMap((child): BoundaryBinding[] => {
          if (child.kind !== 'construct') return [child]
          const port = innerConstructAddress(body, child, childItem.id, binding.port as string, (node) => resolveSchema(node.type))
          if (port === undefined) return []
          return [binding.kind === 'construct' ? { ...child, port: asPortId(port) } : { kind: 'port', node: child.node, port: asPortId(port) }]
        })
        if (after.length === 0 || after.length !== childBindings.length || side === 'output' && after.length !== 1) {
          fail('subgraph.lifecycle.boundaryUnresolved', `enclosing ${side} '${parentItem.id}' has no unique representable descendant`, side, childItem.id)
          continue
        }
        enclosingRewrites.push({ side, itemIndex, itemId: parentItem.id, bindingIndex, before: binding, after })
      }
    }
  }

  if (refusal !== undefined) return { version: 'subgraph-flatten-state-plan-v1', status: 'refused', source, refusal }
  return {
    version: 'subgraph-flatten-state-plan-v1',
    status: 'ready',
    source,
    nodes: [...nodes.values()].sort((a, b) => compareStrings(a.node, b.node)),
    routes,
    enclosingRewrites,
  }
}

export function verifyFlattenStatePlan(
  body: GraphDef,
  occurrence: NodeData,
  parent: GraphDef,
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): boolean {
  const expected = planFlattenState(
    body,
    occurrence,
    parent,
    (type) => schemaSnapshot[type],
    { ...schemaSnapshot },
    boundaryPlan,
    occurrencePortEvidence(parent, occurrence.id),
  )
  return canonicalJson(expected) === canonicalJson(statePlan)
}

const flattenSchemaPlanProjection = (
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): unknown => ({
  version: 'subgraph-flatten-schema-plan-v2',
  schemas: Object.keys(schemaSnapshot).sort(compareStrings).map((authoredType) => ({
    authoredType,
    schema: schemaSnapshot[authoredType],
  })),
  boundaryPlan,
  statePlan,
})

export function flattenSchemaPlanDigest(
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): string {
  return lifecycleCanonicalHash(flattenSchemaPlanProjection(schemaSnapshot, boundaryPlan, statePlan))
}

export function verifyFlattenSchemaPlanDigest(
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  schemaPlanDigest: string,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): boolean {
  return flattenSchemaPlanDigest(schemaSnapshot, boundaryPlan, statePlan) === schemaPlanDigest
}

/** Initial-dispatch guard. Shared re-execution deliberately does not call this. */
export function flattenRegistryMatchesSchemaPlan(
  schemaSnapshot: Readonly<Record<string, NodeSchema>>,
  schemaPlanDigest: string,
  resolveSchema: SchemaResolver,
  boundaryPlan: readonly FlattenBoundaryPlanEntry[],
  statePlan: FlattenStatePlan,
): boolean {
  const current: Record<string, NodeSchema> = {}
  for (const authoredType of Object.keys(schemaSnapshot)) {
    const schema = resolveSchema(authoredType)
    if (schema === undefined) return false
    current[authoredType] = schema
  }
  return flattenSchemaPlanDigest(current, boundaryPlan, statePlan) === schemaPlanDigest
}

export type FreshDefinitionInitializer = Omit<GraphDef, 'id' | 'name'>

export interface FreshOccurrenceInitializer {
  readonly position: Vec2
  readonly values?: JsonObject
  readonly title?: string
  readonly region?: RegionContract
}

export interface FreshSubgraphCreateInput {
  readonly parentGraphId: string
  readonly definition: FreshDefinitionInitializer
  readonly view: GraphViewState
  readonly occurrence: FreshOccurrenceInitializer
  readonly name?: string
}

export interface FreshSubgraphCreatePlan {
  readonly ok: true
  readonly graphId: string
  readonly name: string
  readonly definition: GraphDef
  readonly view: GraphViewState
  readonly invocation: CommandInvocation
}

export interface FreshSubgraphCreateRejection {
  readonly ok: false
  readonly diagnostics: readonly Diagnostic[]
}

const freshDefinitionId = (doc: WorkflowDocument): string => {
  let ordinal = 0
  while (Object.hasOwn(doc.graphs, `g${ordinal}`)) ordinal += 1
  return `g${ordinal}`
}

const freshDefinitionName = (doc: WorkflowDocument): string => {
  const names = new Set(Object.values(doc.graphs).map((graph) => graph.name))
  if (!names.has('New Subgraph')) return 'New Subgraph'
  let suffix = 2
  while (names.has(`New Subgraph ${suffix}`)) suffix += 1
  return `New Subgraph ${suffix}`
}

/**
 * Owns the one create-new-definition allocation path. Callers provide an
 * id-less topology and occurrence fields, while this planner alone injects
 * the fresh definition id and matching occurrence type.
 */
export function planFreshSubgraphCreate(
  doc: WorkflowDocument,
  input: FreshSubgraphCreateInput,
): FreshSubgraphCreatePlan | FreshSubgraphCreateRejection {
  if (!Object.hasOwn(doc.graphs, input.parentGraphId)) {
    return {
      ok: false,
      diagnostics: [diag('error', 'command', 'graph.missing', `create subgraph: unknown graph '${input.parentGraphId}'`)],
    }
  }
  const graphId = freshDefinitionId(doc)
  const requestedName = input.name
  const name = requestedName !== undefined && requestedName.trim().length > 0 ? requestedName : freshDefinitionName(doc)
  const definition: GraphDef = { ...input.definition, id: asGraphDefId(graphId), name }
  const diagnostics = [
    ...validateGraphDefShape(definition, `graphs.${graphId}`),
    ...validateGraphViewShape(input.view, `view.${graphId}`),
  ]
  if (!Number.isFinite(input.occurrence.position.x) || !Number.isFinite(input.occurrence.position.y)) {
    diagnostics.push(diag('error', 'command', 'params.invalid', 'create subgraph: occurrence position must be finite'))
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return { ok: false, diagnostics }

  const occurrenceParams = {
    graphId: input.parentGraphId,
    type: `#${graphId}`,
    position: { x: input.occurrence.position.x, y: input.occurrence.position.y },
    values: input.occurrence.values ?? {},
    ...(input.occurrence.title !== undefined ? { title: input.occurrence.title } : {}),
    ...(input.occurrence.region !== undefined ? { region: input.occurrence.region } : {}),
  } as unknown as JsonObject
  return {
    ok: true,
    graphId,
    name,
    definition,
    view: input.view,
    invocation: {
      command: 'batch',
      params: {
        invocations: [
          {
            command: 'subgraph.import',
            params: { graphs: { [graphId]: definition }, view: { [graphId]: input.view } },
          },
          { command: 'node.add', params: occurrenceParams },
        ],
      } as unknown as Json,
    },
  }
}

export const EMPTY_SUBGRAPH_DEFINITION: FreshDefinitionInitializer = {
  nodes: {},
  links: {},
  nets: {},
  reroutes: {},
  boundary: { body: [] },
  nextOrdinal: 0,
}

export const EMPTY_SUBGRAPH_VIEW: GraphViewState = { nodes: {} }

export interface LifecycleSelectionInput {
  readonly nodeIds?: readonly string[]
  readonly rerouteIds?: readonly string[]
  readonly groupIds?: readonly string[]
}

export interface LifecycleSelection {
  readonly nodeIds: readonly string[]
  readonly rerouteIds: readonly string[]
  readonly groupIds: readonly string[]
}

export type LifecycleEntityKind = keyof LifecycleSelection

export interface MissingLifecycleEntity {
  readonly kind: LifecycleEntityKind
  readonly id: string
}

const sortedUnique = (values: readonly string[] | undefined): readonly string[] =>
  [...new Set(values ?? [])].sort(compareStrings)

export function canonicalizeLifecycleSelection(selection: LifecycleSelectionInput): LifecycleSelection {
  return {
    nodeIds: sortedUnique(selection.nodeIds),
    rerouteIds: sortedUnique(selection.rerouteIds),
    groupIds: sortedUnique(selection.groupIds),
  }
}

export function missingLifecycleEntities(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelection,
): readonly MissingLifecycleEntity[] {
  const graph = Object.hasOwn(doc.graphs, graphId) ? doc.graphs[graphId] : undefined
  const view = Object.hasOwn(doc.view.graphs, graphId) ? doc.view.graphs[graphId] : undefined
  const collections: Readonly<Record<LifecycleEntityKind, Readonly<Record<string, unknown>> | undefined>> = {
    nodeIds: graph?.nodes,
    rerouteIds: graph?.reroutes,
    groupIds: view?.groups,
  }
  const missing: MissingLifecycleEntity[] = []
  for (const kind of Object.keys(selection) as LifecycleEntityKind[]) {
    const records = collections[kind]
    for (const id of selection[kind]) {
      if (records === undefined || !Object.hasOwn(records, id)) missing.push({ kind, id })
    }
  }
  return missing
}

export function hasSemanticLifecycleSelection(selection: LifecycleSelection): boolean {
  return selection.nodeIds.length > 0
}

interface FingerprintProjection {
  readonly version: typeof LIFECYCLE_PLAN_VERSION
  readonly graphId: string
  readonly selection: LifecycleSelection
  readonly entities: {
    readonly nodes: readonly unknown[]
    readonly reroutes: readonly unknown[]
    readonly groups: readonly unknown[]
  }
  readonly links: readonly unknown[]
  readonly nets: readonly unknown[]
  readonly boundary: readonly unknown[]
  readonly collapsedNets: readonly string[]
  readonly guideNets: readonly string[]
}

const selectedSets = (selection: LifecycleSelection) => ({
  nodes: new Set(selection.nodeIds),
  reroutes: new Set(selection.rerouteIds),
})

function endpointSelected(endpoint: LinkEndpoint, selection: ReturnType<typeof selectedSets>): boolean {
  if (isRerouteRef(endpoint)) return selection.reroutes.has(endpoint.reroute)
  return selection.nodes.has(endpoint.node)
}

function bindingSelected(binding: BoundaryBinding, selection: ReturnType<typeof selectedSets>): boolean {
  return isNodeBoundaryBinding(binding) && selection.nodes.has(binding.node)
}

function recordProjection(
  ids: readonly string[],
  records: Readonly<Record<string, unknown>> | undefined,
  views: Readonly<Record<string, unknown>> | undefined,
): readonly unknown[] {
  return ids.map((id) => ({
    id,
    record: records?.[id],
    viewPresent: views !== undefined && Object.hasOwn(views, id),
    ...(views !== undefined && Object.hasOwn(views, id) ? { view: views[id] } : {}),
  }))
}

export function lifecycleSelectionProjection(
  doc: WorkflowDocument,
  graphId: string,
  selectionInput: LifecycleSelectionInput,
): FingerprintProjection | undefined {
  if (!Object.hasOwn(doc.graphs, graphId)) return undefined
  const graph = doc.graphs[graphId]!
  const graphView = Object.hasOwn(doc.view.graphs, graphId) ? doc.view.graphs[graphId] : undefined
  const selection = canonicalizeLifecycleSelection(selectionInput)
  if (missingLifecycleEntities(doc, graphId, selection).length > 0) return undefined
  const selected = selectedSets(selection)
  const links = Object.values(graph.links)
    .filter((link) => endpointSelected(link.from, selected) || endpointSelected(link.to, selected))
    .sort((a, b) => compareStrings(a.id, b.id))
  const nets = Object.values(graph.nets)
    .filter((net) => selected.nodes.has(net.source.node) || net.sinks.some((sink) => selected.nodes.has(sink.node)))
    .sort((a, b) => compareStrings(a.id, b.id))
  const boundary: unknown[] = []
  for (const side of ['inputs', 'outputs'] as const) {
    for (const [index, item] of boundaryItems(graph.boundary, side).entries()) {
      if (bindingSelected(item.binds, selected) || item.alsoBinds?.some((binding) => bindingSelected(binding, selected))) {
        boundary.push({ side, index, item })
      }
    }
  }
  return {
    version: LIFECYCLE_PLAN_VERSION,
    graphId,
    selection,
    entities: {
      nodes: recordProjection(selection.nodeIds, graph.nodes, graphView?.nodes),
      reroutes: recordProjection(selection.rerouteIds, graph.reroutes, graphView?.reroutes),
      groups: recordProjection(selection.groupIds, graphView?.groups, undefined),
    },
    links,
    nets,
    boundary,
    collapsedNets: sortedUnique(graphView?.collapsedNets),
    guideNets: sortedUnique(graphView?.guideNets),
  }
}

export function lifecycleCanonicalHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`
}

export function lifecycleSelectionFingerprint(
  doc: WorkflowDocument,
  graphId: string,
  selection: LifecycleSelectionInput,
): string | undefined {
  const projection = lifecycleSelectionProjection(doc, graphId, selection)
  return projection === undefined ? undefined : lifecycleCanonicalHash(projection)
}

export interface LifecycleSelectionPlan {
  readonly graphId: string
  readonly selection: LifecycleSelectionInput
  readonly selectionFingerprint: string
}

export type LifecyclePlanFreshness =
  | { readonly stale: false; readonly fingerprint: string }
  | { readonly stale: true; readonly fingerprint?: string; readonly code: 'subgraph.lifecycle.stalePlan' }

export function verifyLifecycleSelectionPlan(
  doc: WorkflowDocument,
  plan: LifecycleSelectionPlan,
): LifecyclePlanFreshness {
  const fingerprint = lifecycleSelectionFingerprint(doc, plan.graphId, plan.selection)
  return fingerprint !== undefined && fingerprint === plan.selectionFingerprint
    ? { stale: false, fingerprint }
    : {
        stale: true,
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        code: 'subgraph.lifecycle.stalePlan',
      }
}

export function lifecycleFlattenProjection(
  doc: WorkflowDocument,
  graphId: string,
  occurrenceNodeId: string,
  boundaryRoutePlan?: unknown,
): unknown | undefined {
  const graph = doc.graphs[graphId]
  const occurrence = graph?.nodes[occurrenceNodeId]
  const bodyId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
  const body = bodyId === undefined ? undefined : doc.graphs[bodyId]
  if (graph === undefined || occurrence === undefined || bodyId === undefined || body === undefined) return undefined
  const graphView = doc.view.graphs[graphId]
  const modePanelBindings = Object.values(doc.surfaces ?? {}).flatMap((surface) => {
    if (surface.type !== MODE_PANEL_TYPE) return []
    const decoded = decodeModePanelConfig(surface.config)
    if (!decoded.ok) return []
    const bindings = decoded.config.bindings.filter((binding) =>
      binding.kind === 'node' && binding.graphId === graphId && binding.nodeId === occurrenceNodeId)
    return bindings.length > 0 ? [{ surfaceId: surface.id, bindings }] : []
  }).sort((a, b) => compareStrings(a.surfaceId, b.surfaceId))
  return {
    version: LIFECYCLE_PLAN_VERSION,
    graphId,
    occurrence: {
      record: occurrence,
      viewPresent: graphView !== undefined && Object.hasOwn(graphView.nodes, occurrenceNodeId),
      ...(graphView !== undefined && Object.hasOwn(graphView.nodes, occurrenceNodeId)
        ? { view: graphView.nodes[occurrenceNodeId] }
        : {}),
    },
    body,
    bodyViewPresent: Object.hasOwn(doc.view.graphs, bodyId),
    ...(Object.hasOwn(doc.view.graphs, bodyId) ? { bodyView: doc.view.graphs[bodyId] } : {}),
    links: Object.values(graph.links)
      .filter((link) =>
        (isPortEndpoint(link.from) || isWidgetTapRef(link.from)) && link.from.node === occurrenceNodeId ||
        isPortEndpoint(link.to) && link.to.node === occurrenceNodeId)
      .sort((a, b) => compareStrings(a.id, b.id)),
    nets: Object.values(graph.nets)
      .filter((net) => net.source.node === occurrenceNodeId || net.sinks.some((sink) => sink.node === occurrenceNodeId))
      .sort((a, b) => compareStrings(a.id, b.id)),
    boundary: [
      ...['inputs', 'outputs'].flatMap((side) => boundaryItems(graph.boundary, side as 'inputs' | 'outputs')
        .map((item, index) => ({ side, index, item }))
        .filter(({ item }) => [item.binds, ...(item.alsoBinds ?? [])].some((binding) => binding.node === occurrenceNodeId))),
    ],
    boundaryRoutePlan,
    modePanelBindings,
    collapsedNets: sortedUnique(graphView?.collapsedNets),
    guideNets: sortedUnique(graphView?.guideNets),
  }
}

export function lifecycleFlattenFingerprint(
  doc: WorkflowDocument,
  graphId: string,
  occurrenceNodeId: string,
  boundaryRoutePlan?: unknown,
): string | undefined {
  const projection = lifecycleFlattenProjection(doc, graphId, occurrenceNodeId, boundaryRoutePlan)
  return projection === undefined ? undefined : lifecycleCanonicalHash(projection)
}

export function verifyLifecycleFlattenPlan(
  doc: WorkflowDocument,
  graphId: string,
  occurrenceNodeId: string,
  selectionFingerprint: string,
  boundaryRoutePlan?: unknown,
): LifecyclePlanFreshness {
  const fingerprint = lifecycleFlattenFingerprint(doc, graphId, occurrenceNodeId, boundaryRoutePlan)
  return fingerprint !== undefined && fingerprint === selectionFingerprint
    ? { stale: false, fingerprint }
    : {
        stale: true,
        ...(fingerprint !== undefined ? { fingerprint } : {}),
        code: 'subgraph.lifecycle.stalePlan',
      }
}

export type CutKind = 'outside' | 'internal' | 'in-cut' | 'out-cut' | 'unrepresentable'

export type ExtractRefusalCode =
  | 'subgraph.extract.structuralCutUnsupported'
  | 'subgraph.extract.specializedSlotUnsupported'
  | 'subgraph.lifecycle.boundaryUnresolved'
  | 'subgraph.lifecycle.multiDriver'
  | 'boundary.constructOwned'

export interface CutRefusal {
  readonly code: ExtractRefusalCode
  readonly source: 'link' | 'net' | 'boundary'
  readonly id: string
  readonly endpoint?: LinkEndpoint | PortRef
}

export interface LinkCut {
  readonly id: string
  readonly kind: CutKind
  readonly from: LinkEndpoint
  readonly to: LinkEndpoint
  readonly ext?: ExtData
  readonly refusal?: CutRefusal
}

export interface NetCut {
  readonly id: string
  readonly kind: CutKind
  readonly sourceInside: boolean
  readonly insideSinks: readonly PortRef[]
  readonly outsideSinks: readonly PortRef[]
  readonly split: boolean
  readonly refusal?: CutRefusal
}

export interface BoundaryCut {
  readonly side: 'inputs' | 'outputs'
  readonly itemIndex: number
  readonly itemId: string
  readonly kind: 'outside' | 'in-cut' | 'out-cut' | 'unrepresentable'
  readonly movedBindings: readonly BoundaryBinding[]
  readonly retainedBindings: readonly BoundaryBinding[]
  readonly primaryMoved: boolean
  /** Index in [binds, ...alsoBinds] where the occurrence replaces moved targets. */
  readonly replacementIndex?: number
  /** Exact nested item shape. */
  readonly nestedItem?: {
    readonly binds: BoundaryBinding
    readonly alsoBinds?: readonly BoundaryBinding[]
    readonly promoted?: true
    readonly wireHidden?: true
    readonly tooltip?: string
    readonly limits?: BoundaryLimits
    readonly visible?: { readonly formula: string }
    readonly displayName?: string
  }
  readonly promoted: boolean
  readonly refusal?: CutRefusal
}

export type InputCutSource =
  | {
      readonly kind: 'link'
      readonly endpoint: LinkEndpoint
      /** Present only for a semantic-ext exemption from same-producer grouping. */
      readonly linkId?: string
      readonly ext?: ExtData
    }
  | { readonly kind: 'net'; readonly netId: string; readonly endpoint: PortRef }
  | { readonly kind: 'boundary'; readonly itemIndex: number; readonly itemId: string }

export interface InputCutGroup {
  readonly source: InputCutSource
  readonly targets: readonly PortRef[]
}

export interface OutputCutGroup {
  readonly source: PortRef | WidgetTapRef
  readonly consumers: readonly LinkEndpoint[]
  readonly netIds: readonly string[]
  readonly boundaryItems: readonly { readonly itemIndex: number; readonly itemId: string }[]
}

export interface ExtractionCutAudit {
  readonly links: readonly LinkCut[]
  readonly nets: readonly NetCut[]
  readonly boundaries: readonly BoundaryCut[]
  readonly inputs: readonly InputCutGroup[]
  readonly outputs: readonly OutputCutGroup[]
  readonly refusals: readonly CutRefusal[]
}

export interface ExtractionCutOptions {
  /** Schema-resolved direct DynamicSlot root addresses. Descendants are omitted. */
  readonly specializedSlotRoots?: readonly PortRef[]
  /** Schema-resolved static widget inputs that can truthfully back output taps. */
  readonly widgetTapSources?: readonly WidgetTapRef[]
}

function endpointKey(endpoint: LinkEndpoint): string {
  if (isRerouteRef(endpoint)) return canonicalJson(['reroute', endpoint.reroute])
  if (isWidgetTapRef(endpoint)) return canonicalJson(['tap', endpoint.node, endpoint.tap])
  return canonicalJson(['port', endpoint.node, endpoint.port])
}

function refusalForLink(
  link: { readonly id: string; readonly from: LinkEndpoint; readonly to: LinkEndpoint },
  kind: 'in-cut' | 'out-cut',
  specializedSlots: ReadonlySet<string>,
  widgetTapSources?: ReadonlySet<string>,
): CutRefusal | undefined {
  const inner = kind === 'in-cut' ? link.to : link.from
  if (isPortEndpoint(inner)) {
    if (specializedSlots.has(portRefKey(inner))) {
      return { code: 'subgraph.extract.specializedSlotUnsupported', source: 'link', id: link.id, endpoint: inner }
    }
    return undefined
  }
  if (kind === 'out-cut' && isWidgetTapRef(inner)) {
    return widgetTapSources === undefined || widgetTapSources.has(endpointKey(inner))
      ? undefined
      : { code: 'subgraph.lifecycle.boundaryUnresolved', source: 'link', id: link.id, endpoint: inner }
  }
  return { code: 'subgraph.extract.structuralCutUnsupported', source: 'link', id: link.id, endpoint: inner }
}

const bindingAsPort = (binding: Exclude<BoundaryBinding, { kind: 'widgetTap' | 'unbound' }>): PortRef => ({
  node: binding.node,
  port: binding.port,
})

const bindingAsOutputEndpoint = (binding: BoundaryBinding): PortRef | WidgetTapRef => {
  if (binding.kind === 'unbound') throw new Error('unbound boundary has no endpoint')
  return binding.kind === 'widgetTap'
    ? { node: binding.node, tap: binding.tap }
    : bindingAsPort(binding)
}

export function auditExtractionCuts(
  graph: GraphDef,
  selectionInput: LifecycleSelectionInput,
  options: ExtractionCutOptions = {},
): ExtractionCutAudit {
  const selection = canonicalizeLifecycleSelection(selectionInput)
  const selected = selectedSets(selection)
  const specializedSlots = new Set((options.specializedSlotRoots ?? []).map(portRefKey))
  const widgetTapSources = options.widgetTapSources === undefined
    ? undefined
    : new Set(options.widgetTapSources.map(endpointKey))
  const refusals: CutRefusal[] = []
  const links: LinkCut[] = []
  const linkInputGroups = new Map<string, { source: InputCutSource; targets: PortRef[] }>()
  const outputGroups = new Map<string, { source: OutputCutGroup['source']; consumers: LinkEndpoint[]; netIds: string[]; boundaryItems: { itemIndex: number; itemId: string }[] }>()

  for (const link of Object.values(graph.links).sort((a, b) => compareStrings(a.id, b.id))) {
    const fromInside = endpointSelected(link.from, selected)
    const toInside = endpointSelected(link.to, selected)
    let kind: CutKind = fromInside === toInside ? (fromInside ? 'internal' : 'outside') : (toInside ? 'in-cut' : 'out-cut')
    const refusal = kind === 'in-cut' || kind === 'out-cut'
      ? refusalForLink(link, kind, specializedSlots, widgetTapSources)
      : undefined
    if (refusal !== undefined) {
      kind = 'unrepresentable'
      refusals.push(refusal)
    } else if (kind === 'in-cut' && isPortEndpoint(link.to)) {
      const semanticExt = link.ext !== undefined && Object.keys(link.ext).length > 0
      const key = semanticExt ? `${endpointKey(link.from)}\u0000${JSON.stringify(link.id)}` : endpointKey(link.from)
      let group = linkInputGroups.get(key)
      if (group === undefined) {
        group = {
          source: {
            kind: 'link',
            endpoint: link.from,
            ...(semanticExt ? { linkId: link.id, ext: link.ext } : {}),
          },
          targets: [],
        }
        linkInputGroups.set(key, group)
      }
      group.targets.push(link.to)
    } else if (kind === 'out-cut' && (isPortEndpoint(link.from) || isWidgetTapRef(link.from))) {
      const key = endpointKey(link.from)
      let group = outputGroups.get(key)
      if (group === undefined) {
        group = { source: link.from, consumers: [], netIds: [], boundaryItems: [] }
        outputGroups.set(key, group)
      }
      group.consumers.push(link.to)
    }
    links.push({
      id: link.id,
      kind,
      from: link.from,
      to: link.to,
      ...(link.ext !== undefined ? { ext: link.ext } : {}),
      ...(refusal !== undefined ? { refusal } : {}),
    })
  }

  const nets: NetCut[] = []
  const netInputGroups: InputCutGroup[] = []
  for (const net of Object.values(graph.nets).sort((a, b) => compareStrings(a.id, b.id))) {
    const sourceInside = selected.nodes.has(net.source.node)
    const insideSinks = net.sinks.filter((sink) => selected.nodes.has(sink.node))
    const outsideSinks = net.sinks.filter((sink) => !selected.nodes.has(sink.node))
    let kind: CutKind = sourceInside
      ? (outsideSinks.length === 0 ? 'internal' : 'out-cut')
      : (insideSinks.length === 0 ? 'outside' : 'in-cut')
    let refusal: CutRefusal | undefined
    const crossingPorts = kind === 'in-cut' ? insideSinks : kind === 'out-cut' ? [net.source] : []
    const specialized = crossingPorts.find((port) => specializedSlots.has(portRefKey(port)))
    if (specialized !== undefined) {
      refusal = { code: 'subgraph.extract.specializedSlotUnsupported', source: 'net', id: net.id, endpoint: specialized }
    } else if (sourceInside && insideSinks.length > 0 && outsideSinks.length > 0 && net.ext !== undefined && Object.keys(net.ext).length > 0) {
      refusal = { code: 'subgraph.lifecycle.boundaryUnresolved', source: 'net', id: net.id, endpoint: net.source }
    }
    if (refusal !== undefined) {
      kind = 'unrepresentable'
      refusals.push(refusal)
    } else if (kind === 'in-cut') {
      netInputGroups.push({
        source: { kind: 'net', netId: net.id, endpoint: net.source },
        targets: [...insideSinks].sort(comparePortRefs),
      })
    } else if (kind === 'out-cut') {
      const key = endpointKey(net.source)
      let group = outputGroups.get(key)
      if (group === undefined) {
        group = { source: net.source, consumers: [], netIds: [], boundaryItems: [] }
        outputGroups.set(key, group)
      }
      group.netIds.push(net.id)
    }
    nets.push({
      id: net.id,
      kind,
      sourceInside,
      insideSinks,
      outsideSinks,
      split: sourceInside && insideSinks.length > 0 && outsideSinks.length > 0,
      ...(refusal !== undefined ? { refusal } : {}),
    })
  }

  const boundaries: BoundaryCut[] = []
  for (const side of ['inputs', 'outputs'] as const) {
    for (const [itemIndex, item] of boundaryItems(graph.boundary, side).entries()) {
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      const movedBindings = bindings.filter((binding) => bindingSelected(binding, selected))
      const retainedBindings = bindings.filter((binding) => !bindingSelected(binding, selected))
      if (bindings.some((binding) => binding.viaReroute !== undefined &&
          selected.nodes.has(binding.node) !== selected.reroutes.has(binding.viaReroute))) {
        const refusal: CutRefusal = { code: 'subgraph.extract.structuralCutUnsupported', source: 'boundary', id: item.id }
        refusals.push(refusal)
        boundaries.push({
          side, itemIndex, itemId: item.id, kind: 'unrepresentable', movedBindings, retainedBindings,
          primaryMoved: bindingSelected(item.binds, selected), promoted: item.promoted === true, refusal,
        })
        continue
      }
      if (movedBindings.length === 0) {
        boundaries.push({
          side,
          itemIndex,
          itemId: item.id,
          kind: 'outside',
          movedBindings,
          retainedBindings,
          primaryMoved: false,
          promoted: item.promoted === true,
        })
        continue
      }
      let refusal: CutRefusal | undefined
      const specialized = movedBindings
        .filter((binding): binding is Extract<BoundaryBinding, { kind: 'port' }> => binding.kind === 'port')
        .map(bindingAsPort)
        .find((port) => specializedSlots.has(portRefKey(port)))
      if (specialized !== undefined) {
        refusal = { code: 'subgraph.extract.specializedSlotUnsupported', source: 'boundary', id: item.id, endpoint: specialized }
        refusals.push(refusal)
      } else if (item.ext !== undefined && Object.keys(item.ext).length > 0) {
        refusal = { code: 'subgraph.lifecycle.boundaryUnresolved', source: 'boundary', id: item.id }
        refusals.push(refusal)
      }
      const kind = refusal !== undefined ? 'unrepresentable' : side === 'inputs' ? 'in-cut' : 'out-cut'
      const firstMovedIndex = bindings.findIndex((binding) => bindingSelected(binding, selected))
      const nestedItem = refusal === undefined
        ? {
            binds: movedBindings[0]!,
            ...(movedBindings.length > 1 ? { alsoBinds: movedBindings.slice(1) } : {}),
            ...(item.promoted === true ? { promoted: true as const } : {}),
            ...(item.wireHidden === true ? { wireHidden: true as const } : {}),
            ...(item.tooltip !== undefined ? { tooltip: item.tooltip } : {}),
            ...(item.limits !== undefined ? { limits: item.limits } : {}),
            ...(item.visible !== undefined ? { visible: item.visible } : {}),
            ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
          }
        : undefined
      boundaries.push({
        side,
        itemIndex,
        itemId: item.id,
        kind,
        movedBindings,
        retainedBindings,
        primaryMoved: bindingSelected(item.binds, selected),
        replacementIndex: firstMovedIndex,
        ...(nestedItem !== undefined ? { nestedItem } : {}),
        promoted: item.promoted === true,
        ...(refusal !== undefined ? { refusal } : {}),
      })
      if (refusal !== undefined) continue
      if (side === 'outputs') {
        const source = bindingAsOutputEndpoint(item.binds)
        const key = endpointKey(source)
        let group = outputGroups.get(key)
        if (group === undefined) {
          group = { source, consumers: [], netIds: [], boundaryItems: [] }
          outputGroups.set(key, group)
        }
        group.boundaryItems.push({ itemIndex, itemId: item.id })
      }
    }
  }

  const ordinaryDrivenTargets = new Set<string>()
  for (const link of links) {
    if ((link.kind === 'internal' || link.kind === 'in-cut') && isPortEndpoint(link.to)) ordinaryDrivenTargets.add(portRefKey(link.to))
  }
  for (const net of nets) {
    if (net.kind === 'internal' || net.kind === 'in-cut') {
      for (const sink of net.insideSinks) ordinaryDrivenTargets.add(portRefKey(sink))
    }
  }
  for (const boundary of boundaries) {
    if (boundary.side !== 'inputs' || boundary.kind !== 'in-cut') continue
    for (const binding of boundary.movedBindings) {
      if (binding.kind !== 'port' || binding.viaReroute !== undefined) continue
      const target = bindingAsPort(binding)
      if (!ordinaryDrivenTargets.has(portRefKey(target))) continue
      const refusal: CutRefusal = {
        code: 'subgraph.lifecycle.multiDriver',
        source: 'boundary',
        id: boundary.itemId,
        endpoint: target,
      }
      refusals.push(refusal)
      const index = boundaries.indexOf(boundary)
      if (index >= 0) {
        const { nestedItem: _nestedItem, ...rest } = boundary
        boundaries[index] = { ...rest, kind: 'unrepresentable', refusal }
      }
    }
  }

  // A wire that crosses into a construct the definition shows whole would
  // become a second owner of a row the moved construct already owns.
  const crossingPorts = [
    ...links.filter((link) => link.kind === 'in-cut').map((link) => link.to),
    ...links.filter((link) => link.kind === 'out-cut').map((link) => link.from),
    ...nets.flatMap((net) => net.kind === 'in-cut' ? net.insideSinks : net.kind === 'out-cut' ? [graph.nets[net.id]!.source] : []),
  ].filter(isPortEndpoint)
  for (const [index, boundary] of boundaries.entries()) {
    if (boundary.kind !== 'in-cut' && boundary.kind !== 'out-cut') continue
    const owned = boundary.movedBindings.flatMap((binding) => {
      if (binding.kind !== 'construct') return []
      const port = crossingPorts.find((crossing) => crossing.node === binding.node && crossing.port.startsWith(`${binding.port}.`))
      return port === undefined ? [] : [port]
    })[0]
    if (owned === undefined) continue
    const refusal: CutRefusal = { code: 'boundary.constructOwned', source: 'boundary', id: boundary.itemId, endpoint: owned }
    refusals.push(refusal)
    const { nestedItem: _nestedItem, ...rest } = boundary
    boundaries[index] = { ...rest, kind: 'unrepresentable', refusal }
  }

  const inputs = [
    ...[...linkInputGroups.values()].map((group) => ({
      source: group.source,
      targets: [...group.targets].sort(comparePortRefs),
    })),
    ...netInputGroups,
  ].sort(compareInputGroups)
  const outputs = [...outputGroups.values()]
    .map((group) => ({
      source: group.source,
      consumers: [...group.consumers].sort((a, b) => compareStrings(endpointKey(a), endpointKey(b))),
      netIds: [...group.netIds].sort(compareStrings),
      boundaryItems: [...group.boundaryItems].sort((a, b) => a.itemIndex - b.itemIndex),
    }))
    .sort((a, b) => {
      const source = compareStrings(endpointKey(a.source), endpointKey(b.source))
      if (source !== 0) return source
      return compareStrings(endpointKey(a.consumers[0] ?? a.source), endpointKey(b.consumers[0] ?? b.source))
    })
  return { links, nets, boundaries, inputs, outputs, refusals }
}

function compareInputGroups(a: InputCutGroup, b: InputCutGroup): number {
  const producer = compareStrings(inputProducerKey(a.source), inputProducerKey(b.source))
  if (producer !== 0) return producer
  const target = comparePortRefs(a.targets[0]!, b.targets[0]!)
  if (target !== 0) return target
  return compareStrings(inputSourceKey(a.source), inputSourceKey(b.source))
}

function inputSourceKey(source: InputCutSource): string {
  if (source.kind === 'link') {
    return `${endpointKey(source.endpoint)}\u0000link:${source.linkId === undefined ? '' : JSON.stringify(source.linkId)}`
  }
  if (source.kind === 'net') return `${endpointKey(source.endpoint)}\u0000net:${JSON.stringify(source.netId)}`
  return `${canonicalJson(['boundary', source.itemIndex, source.itemId])}\u0000boundary`
}

function inputProducerKey(source: InputCutSource): string {
  if (source.kind === 'link' || source.kind === 'net') return endpointKey(source.endpoint)
  return canonicalJson(['boundary', source.itemIndex, source.itemId])
}

export interface BoundaryNameCandidate {
  readonly side: 'input' | 'output'
  readonly base: string
  readonly orderKey: string
}

export interface PlannedBoundaryName extends BoundaryNameCandidate {
  readonly id: string
}

export function planBoundaryNames(candidates: readonly BoundaryNameCandidate[]): readonly PlannedBoundaryName[] {
  const ordered = candidates.map((candidate, index) => ({ candidate, index })).sort((a, b) => {
    const side = a.candidate.side === b.candidate.side ? 0 : a.candidate.side === 'input' ? -1 : 1
    return side || compareStrings(a.candidate.orderKey, b.candidate.orderKey) || a.index - b.index
  })
  const used = new Set<string>()
  const planned = new Map<number, PlannedBoundaryName>()
  for (const { candidate, index } of ordered) {
    const fallback = candidate.side === 'input' ? 'input' : 'output'
    const base = candidate.base.length > 0 ? candidate.base : fallback
    let id = base
    let suffix = 2
    while (used.has(id)) id = `${base}_${suffix++}`
    used.add(id)
    planned.set(index, { ...candidate, id })
  }
  return candidates.map((_, index) => planned.get(index)!)
}

export function boundaryNameCandidates(audit: ExtractionCutAudit): readonly BoundaryNameCandidate[] {
  return [
    ...audit.inputs.map((cut) => ({
      side: 'input' as const,
      base: cut.targets[0]?.port ?? '',
      orderKey: `${inputProducerKey(cut.source)}:${cut.targets[0] === undefined ? '' : portRefKey(cut.targets[0])}:${inputSourceKey(cut.source)}`,
    })),
    ...audit.boundaries
      .filter((cut) => cut.kind === 'in-cut' && cut.nestedItem !== undefined && cut.nestedItem.binds.kind !== 'widgetTap')
      .map((cut) => ({
        side: 'input' as const,
        base: cut.nestedItem!.binds.port ?? '',
        orderKey: canonicalJson(['boundary', cut.itemIndex, cut.itemId]),
      })),
    ...audit.outputs.map((cut) => ({
      side: 'output' as const,
      base: isWidgetTapRef(cut.source) ? cut.source.tap : cut.source.port,
      orderKey: `${endpointKey(cut.source)}:${cut.consumers[0] === undefined ? '' : endpointKey(cut.consumers[0])}`,
    })),
  ]
}

export interface ProspectiveDagResult {
  readonly ok: boolean
  readonly cycle?: readonly string[]
  readonly code?:
    | 'subgraph.lifecycle.recursive'
    | 'subgraph.lifecycle.contextInvalid'
    | 'subgraph.lifecycle.selectionMissing'
    | 'subgraph.flatten.notOccurrence'
    | 'graph.exists'
}

function definitionRefs(doc: WorkflowDocument): Map<string, Set<string>> {
  const refs = new Map<string, Set<string>>()
  for (const [id, graph] of Object.entries(doc.graphs)) {
    const targets = new Set<string>()
    for (const node of Object.values(graph.nodes)) {
      const target = subgraphDefIdOf(node.type)
      if (target !== undefined && Object.hasOwn(doc.graphs, target)) targets.add(target)
    }
    refs.set(id, targets)
  }
  return refs
}

export function checkProspectiveDefinitionDag(refs: ReadonlyMap<string, ReadonlySet<string>>): ProspectiveDagResult {
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  let cycle: readonly string[] | undefined
  const visit = (id: string): void => {
    if (cycle !== undefined || state.get(id) === 'done') return
    const stackIndex = stack.indexOf(id)
    if (state.get(id) === 'visiting') {
      cycle = [...stack.slice(stackIndex), id]
      return
    }
    state.set(id, 'visiting')
    stack.push(id)
    for (const next of [...(refs.get(id) ?? [])].sort(compareStrings)) visit(next)
    stack.pop()
    state.set(id, 'done')
  }
  for (const id of [...refs.keys()].sort(compareStrings)) visit(id)
  return cycle === undefined ? { ok: true } : { ok: false, cycle, code: 'subgraph.lifecycle.recursive' }
}

export function checkProspectiveExtractionDag(
  doc: WorkflowDocument,
  parentGraphId: string,
  freshGraphId: string,
  movedNodeIds: readonly string[],
): ProspectiveDagResult {
  const refs = definitionRefs(doc)
  const parent = Object.hasOwn(doc.graphs, parentGraphId) ? doc.graphs[parentGraphId] : undefined
  if (parent === undefined) return { ok: false, code: 'subgraph.lifecycle.contextInvalid' }
  if (Object.hasOwn(doc.graphs, freshGraphId)) return { ok: false, code: 'graph.exists' }
  const moved = new Set(movedNodeIds)
  if ([...moved].some((id) => !Object.hasOwn(parent.nodes, id))) {
    return { ok: false, code: 'subgraph.lifecycle.selectionMissing' }
  }
  const parentRefs = new Set<string>()
  const freshRefs = new Set<string>()
  for (const node of Object.values(parent.nodes)) {
    const target = subgraphDefIdOf(node.type)
    if (target === undefined || !Object.hasOwn(doc.graphs, target)) continue
    if (moved.has(node.id)) freshRefs.add(target)
    else parentRefs.add(target)
  }
  parentRefs.add(freshGraphId)
  refs.set(parentGraphId, parentRefs)
  refs.set(freshGraphId, freshRefs)
  return checkProspectiveDefinitionDag(refs)
}

export function checkProspectiveFlattenDag(
  doc: WorkflowDocument,
  parentGraphId: string,
  occurrenceNodeId: string,
): ProspectiveDagResult {
  const refs = definitionRefs(doc)
  const parent = Object.hasOwn(doc.graphs, parentGraphId) ? doc.graphs[parentGraphId] : undefined
  const occurrence = parent !== undefined && Object.hasOwn(parent.nodes, occurrenceNodeId) ? parent.nodes[occurrenceNodeId] : undefined
  const flattenedId = occurrence === undefined ? undefined : subgraphDefIdOf(occurrence.type)
  const body = flattenedId !== undefined && Object.hasOwn(doc.graphs, flattenedId) ? doc.graphs[flattenedId] : undefined
  if (parent === undefined) return { ok: false, code: 'subgraph.lifecycle.contextInvalid' }
  if (occurrence === undefined || body === undefined) return { ok: false, code: 'subgraph.flatten.notOccurrence' }
  const parentRefs = new Set<string>()
  for (const node of Object.values(parent.nodes)) {
    if (node.id === occurrenceNodeId) continue
    const target = subgraphDefIdOf(node.type)
    if (target !== undefined && Object.hasOwn(doc.graphs, target)) parentRefs.add(target)
  }
  for (const node of Object.values(body.nodes)) {
    const target = subgraphDefIdOf(node.type)
    if (target !== undefined && Object.hasOwn(doc.graphs, target)) parentRefs.add(target)
  }
  refs.set(parentGraphId, parentRefs)
  return checkProspectiveDefinitionDag(refs)
}

export type FlattenShellRefusal =
  | 'subgraph.flatten.modeUnsupported'
  | 'subgraph.flatten.regionUnsupported'

export function flattenShellRefusal(node: Pick<NodeData, 'mode' | 'region'>): FlattenShellRefusal | undefined {
  if (node.region !== undefined) return 'subgraph.flatten.regionUnsupported'
  // A muted subgraph node flattens to muted nodes; a bypassed one has no plain equivalent.
  if (node.mode === 'bypassed') return 'subgraph.flatten.modeUnsupported'
  return undefined
}

export function flattenShellRefusalDiagnostic(
  node: Pick<NodeData, 'mode' | 'region'>,
  graphId: string,
  instancePath: readonly string[],
  nodeId: string,
): Diagnostic | undefined {
  const code = flattenShellRefusal(node)
  return code === undefined ? undefined : diag(
    'error',
    'command',
    code,
    'subgraph.flatten: occurrence shell mode or region contract cannot be flattened',
    {
      refs: [{ graphId, nodeId }],
      anchor: { occurrence: { instancePath: instancePath.map(asNodeId), node: asNodeId(nodeId) } },
    },
  )
}

export interface ResolvedGeometryItem {
  readonly id: string
  readonly kind: 'node' | 'reroute' | 'group'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface GeometryPlan {
  readonly center: Vec2
  readonly bounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly usedPlacementFallback: boolean
  readonly items: readonly ResolvedGeometryItem[]
}

export interface GeometryCoverage {
  readonly complete: boolean
  readonly missing: readonly { readonly kind: ResolvedGeometryItem['kind']; readonly id: string }[]
  readonly duplicate: readonly { readonly kind: ResolvedGeometryItem['kind']; readonly id: string }[]
  readonly unexpected: readonly { readonly kind: ResolvedGeometryItem['kind']; readonly id: string }[]
}

export interface GroupSelectionMembership {
  readonly groupId: string
  readonly nodeIds: readonly string[]
  readonly rerouteIds: readonly string[]
}

export interface ExpandedLifecycleSelection {
  readonly selection: LifecycleSelection
  readonly groups: readonly GroupSelectionMembership[]
}

export function expandLifecycleSelectionFromGroups(
  selectionInput: LifecycleSelectionInput,
  geometry: readonly ResolvedGeometryItem[],
): ExpandedLifecycleSelection | undefined {
  const selection = canonicalizeLifecycleSelection(selectionInput)
  const byGroup = new Map<string, ResolvedGeometryItem>()
  for (const item of geometry) {
    if (!validGeometry(item)) return undefined
    if (item.kind === 'group') {
      if (byGroup.has(item.id)) return undefined
      byGroup.set(item.id, item)
    }
  }
  const memberships: GroupSelectionMembership[] = []
  const expanded: Record<'nodeIds' | 'rerouteIds', Set<string>> = {
    nodeIds: new Set(selection.nodeIds),
    rerouteIds: new Set(selection.rerouteIds),
  }
  for (const groupId of selection.groupIds) {
    const group = byGroup.get(groupId)
    if (group === undefined) return undefined
    const members: Record<keyof typeof expanded, string[]> = {
      nodeIds: [], rerouteIds: [],
    }
    for (const item of geometry) {
      const kind = selectionKindOfGeometry(item.kind)
      if (kind === undefined || !insideGroup(item, group)) continue
      members[kind].push(item.id)
      expanded[kind].add(item.id)
    }
    for (const ids of Object.values(members)) ids.sort(compareStrings)
    memberships.push({ groupId, ...members })
  }
  return {
    selection: canonicalizeLifecycleSelection({
      nodeIds: [...expanded.nodeIds],
      rerouteIds: [...expanded.rerouteIds],
      groupIds: selection.groupIds,
    }),
    groups: memberships,
  }
}

function selectionKindOfGeometry(
  kind: ResolvedGeometryItem['kind'],
): 'nodeIds' | 'rerouteIds' | undefined {
  if (kind === 'node') return 'nodeIds'
  if (kind === 'reroute') return 'rerouteIds'
  return undefined
}

function insideGroup(item: ResolvedGeometryItem, group: ResolvedGeometryItem): boolean {
  const centerX = item.x + item.width / 2
  const centerY = item.y + item.height / 2
  return centerX >= group.x && centerX <= group.x + group.width &&
    centerY >= group.y && centerY <= group.y + group.height
}

export function validateLifecycleGeometry(
  selectionInput: LifecycleSelectionInput,
  items: readonly ResolvedGeometryItem[],
): GeometryCoverage {
  const selection = canonicalizeLifecycleSelection(selectionInput)
  const expected = new Set<string>([
    ...selection.nodeIds.map((id) => geometryKey('node', id)),
    ...selection.rerouteIds.map((id) => geometryKey('reroute', id)),
    ...selection.groupIds.map((id) => geometryKey('group', id)),
  ])
  const seen = new Set<string>()
  const duplicate: { kind: ResolvedGeometryItem['kind']; id: string }[] = []
  const unexpected: { kind: ResolvedGeometryItem['kind']; id: string }[] = []
  for (const item of items) {
    const key = geometryKey(item.kind, item.id)
    if (seen.has(key)) duplicate.push({ kind: item.kind, id: item.id })
    else seen.add(key)
    if (!expected.has(key)) unexpected.push({ kind: item.kind, id: item.id })
  }
  const missing = [...expected]
    .filter((key) => !seen.has(key))
    .map(geometryAddressOf)
    .sort(compareGeometryAddresses)
  duplicate.sort(compareGeometryAddresses)
  unexpected.sort(compareGeometryAddresses)
  return {
    complete: missing.length === 0 && duplicate.length === 0 && unexpected.length === 0,
    missing,
    duplicate,
    unexpected,
  }
}

const geometryKey = (kind: ResolvedGeometryItem['kind'], id: string): string => canonicalJson([kind, id])

const geometryAddressOf = (key: string): { kind: ResolvedGeometryItem['kind']; id: string } => {
  const [kind, id] = JSON.parse(key) as [ResolvedGeometryItem['kind'], string]
  return { kind, id }
}

const compareGeometryAddresses = (
  a: { readonly kind: ResolvedGeometryItem['kind']; readonly id: string },
  b: { readonly kind: ResolvedGeometryItem['kind']; readonly id: string },
): number => compareStrings(geometryKey(a.kind, a.id), geometryKey(b.kind, b.id))

function validGeometry(item: ResolvedGeometryItem): boolean {
  return validBounds(item) && Number.isFinite(item.x + item.width) && Number.isFinite(item.y + item.height)
}

function validBounds(bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): boolean {
  return [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) &&
    bounds.width >= 0 && bounds.height >= 0
}

export function planExtractedGeometry(
  items: readonly ResolvedGeometryItem[],
  placementCenter: Vec2,
): GeometryPlan | undefined {
  if (!Number.isFinite(placementCenter.x) || !Number.isFinite(placementCenter.y) || items.some((item) => !validGeometry(item))) {
    return undefined
  }
  const ordered = [...items].sort((a, b) => compareStrings(`${a.kind}:${a.id}`, `${b.kind}:${b.id}`))
  if (ordered.length === 0) return { center: { ...placementCenter }, usedPlacementFallback: true, items: [] }
  const minX = Math.min(...ordered.map((item) => item.x))
  const minY = Math.min(...ordered.map((item) => item.y))
  const maxX = Math.max(...ordered.map((item) => item.x + item.width))
  const maxY = Math.max(...ordered.map((item) => item.y + item.height))
  const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return undefined
  const bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
  if (!validBounds(bounds)) return undefined
  const translated = ordered.map((item) => ({ ...item, x: item.x - center.x, y: item.y - center.y }))
  if (translated.some((item) => !validGeometry(item))) return undefined
  return {
    center,
    bounds,
    usedPlacementFallback: false,
    items: translated,
  }
}

export function planFlattenedGeometry(
  bodyItems: readonly ResolvedGeometryItem[],
  occurrenceCenter: Vec2,
): GeometryPlan | undefined {
  const inner = planExtractedGeometry(bodyItems, occurrenceCenter)
  if (inner === undefined) return undefined
  if (inner.usedPlacementFallback) return inner
  const offsetX = occurrenceCenter.x - inner.center.x
  const offsetY = occurrenceCenter.y - inner.center.y
  const bounds = inner.bounds === undefined ? undefined : {
    ...inner.bounds,
    x: inner.bounds.x + offsetX,
    y: inner.bounds.y + offsetY,
  }
  if (bounds !== undefined && !validBounds(bounds)) return undefined
  const translated = inner.items.map((item) => ({ ...item, x: item.x + occurrenceCenter.x, y: item.y + occurrenceCenter.y }))
  if (translated.some((item) => !validGeometry(item))) return undefined
  return {
    ...inner,
    center: { ...occurrenceCenter },
    ...(bounds !== undefined ? { bounds } : {}),
    items: translated,
  }
}

export function validateFlattenGeometry(
  occurrence: ResolvedGeometryItem | undefined,
  bodySelection: LifecycleSelectionInput,
  bodyItems: readonly ResolvedGeometryItem[],
): GeometryCoverage {
  const body = validateLifecycleGeometry(bodySelection, bodyItems)
  const occurrenceMissing = occurrence === undefined || occurrence.kind !== 'node' || !validGeometry(occurrence)
  return {
    complete: !occurrenceMissing && body.complete,
    missing: occurrenceMissing ? [{ kind: 'node', id: 'occurrence' }, ...body.missing] : body.missing,
    duplicate: body.duplicate,
    unexpected: body.unexpected,
  }
}

export function geometryOfGroup(group: GroupViewState): ResolvedGeometryItem {
  return { id: group.id, kind: 'group', ...group.bounds }
}

function comparePortRefs(a: PortRef, b: PortRef): number {
  return compareStrings(portRefKey(a), portRefKey(b))
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
