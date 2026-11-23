/**
 * Boundary address helpers shared by compilation, occurrence views,
 * invariants and commands: selecting the boundary item an instance address
 * names, and projecting promoted editable menus onto inner nodes.
 */

import type { BoundaryItem, ConstructBoundaryBinding, DynamicPortState, GraphDef, Json, NodeData } from '../format/document.js'
import type { NodeId } from '../ids.js'
import { constructRowOf, innerMemberKey, interiorMembersOf, outerMemberKey, resolveBoundaryRoute } from '../schema/derive-boundary.js'
import { elaborateInterface, elabInputsOf } from '../schema/elaborate.js'
import type { NodeSchema } from '../schema/model.js'
import { boundaryItems } from '../format/document.js'

/** Project schema-opted-in menus through promoted inputs without changing values. */
export function projectEditableOptions(
  child: GraphDef,
  instanceDynamic: Readonly<Record<string, DynamicPortState>> | undefined,
  resolveNode: (node: NodeData) => NodeSchema | undefined,
): ReadonlyMap<NodeId, Readonly<Record<string, DynamicPortState>>> {
  const projected = new Map<NodeId, Readonly<Record<string, DynamicPortState>>>()
  const claimed = new Map<NodeId, Set<string>>()
  for (const item of boundaryItems(child.boundary, 'inputs') ?? []) {
    if (item.promoted !== true || item.binds.kind !== 'port') continue
    const options = instanceDynamic?.[item.id]?.options
    if (options === undefined) continue
    const primary = child.nodes[item.binds.node]
    const primarySchema = primary && resolveNode(primary)
    const primaryRoute = primarySchema && resolveBoundaryRoute(primarySchema, item.binds, 'input')
    if (!primaryRoute?.ok || primaryRoute.route.terminal.kind !== 'port' ||
      primaryRoute.route.terminal.slot.kind !== 'input' || !primaryRoute.route.terminal.slot.widget?.editableOptions) continue
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (binding.kind !== 'port') continue
      const target = child.nodes[binding.node]
      const schema = target && resolveNode(target)
      const route = schema && resolveBoundaryRoute(schema, binding, 'input')
      if (!target || !route?.ok || route.route.terminal.kind !== 'port' ||
        route.route.terminal.slot.kind !== 'input' || !route.route.terminal.slot.widget?.editableOptions) continue
      const key = binding.port
      let keys = claimed.get(target.id)
      if (!keys) claimed.set(target.id, (keys = new Set()))
      if (keys.has(key)) continue
      keys.add(key)
      projected.set(target.id, overlayPortDynamic(projected.get(target.id) ?? target.dynamic,
        binding.port, { options }))
    }
  }
  return projected
}

// ---------------------------------------------------------------------------
// Boundary item selection (the ONE interpreter of instance addresses)
// ---------------------------------------------------------------------------

export interface BoundaryAddr {
  readonly port: string
}

export type BoundaryMatch =
  | { readonly ok: true; readonly item: BoundaryItem }
  | { readonly ok: false; readonly code: 'missing' | 'ambiguous'; readonly message: string }

/**
 * Select THE boundary item an instance-side address refers to: the address
 * is exactly the item's id (the INSTANCE-side port is a plain static port
 * even when its inner binding targets a group member row), or a row inside a
 * construct the item shows whole.
 * Every candidate is enumerated and exactly one must fit.
 */
export function matchBoundaryItem(items: readonly BoundaryItem[], addr: BoundaryAddr): BoundaryMatch {
  const candidates = items.filter((i) => addr.port === i.id || (i.binds.kind === 'construct' && addr.port.startsWith(`${i.id}.`)))
  if (candidates.length === 1) return { ok: true, item: candidates[0]! }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'missing',
      message: `no boundary item matches '${addr.port}'`,
    }
  }
  return {
    ok: false,
    code: 'ambiguous',
    message: `address '${addr.port}' matches ${candidates.length} boundary items (${candidates.map((c) => `'${c.id}'`).join(', ')}); boundary ids collide`,
  }
}

export interface CrossingProblem {
  readonly code: string
  readonly message: string
}

/**
 * Boundary output fan-out refusals for one child definition: an output has
 * exactly one source, so an output item carrying `alsoBinds` cannot lower.
 */
export function boundaryOutputFanOutProblems(child: GraphDef): readonly CrossingProblem[] {
  return (boundaryItems(child.boundary, 'outputs') ?? [])
    .filter((item) => item.alsoBinds !== undefined)
    .map((item) => ({
      code: 'compile.boundary.forwardUnresolved',
      message: `boundary output '${item.id}' of '${child.id}' cannot fan out`,
    }))
}

/** Overlay authored port state at its flattened id, keeping the state beside it. */
export function overlayPortDynamic(
  base: Readonly<Record<string, DynamicPortState>> | undefined,
  constructPath: string,
  authored: Pick<DynamicPortState, 'selected' | 'options'>,
): Readonly<Record<string, DynamicPortState>> {
  return { ...base, [constructPath]: { ...base?.[constructPath], ...authored } }
}

// ---------------------------------------------------------------------------
// Whole constructs shown on a subgraph node
// ---------------------------------------------------------------------------

/**
 * Where an address a subgraph node holds under a construct row lands on the
 * inner node: the same rows under the inner construct's flattened id, with a
 * member the subgraph node owns moved past the definition's own members.
 * Undefined when the address names no member the inner node can make.
 */
export function innerConstructAddress(
  child: GraphDef,
  binding: ConstructBoundaryBinding,
  itemId: string,
  outerPort: string,
  resolveNode: (node: NodeData) => NodeSchema | undefined,
): string | undefined {
  if (outerPort !== itemId && !outerPort.startsWith(`${itemId}.`)) return undefined
  const rest = outerPort.slice(itemId.length)
  const found = constructAt(child, binding, resolveNode)
  if (found === undefined) return undefined
  const { target, row } = found
  if (row.kind !== 'group' || rest === '') return `${binding.port}${rest}`
  const [, key, ...more] = rest.split('.')
  const inner = innerMemberKey(row, interiorMembersOf(row, target.dynamic?.[binding.port]), key!)
  return inner === undefined ? undefined : [binding.port, inner, ...more].join('.')
}

/**
 * The address on the subgraph node that holds an inner address under a
 * construct it shows whole: the inverse of innerConstructAddress. Undefined
 * for an address outside the construct or in a member the definition owns.
 */
export function outerConstructAddress(
  child: GraphDef,
  binding: ConstructBoundaryBinding,
  itemId: string,
  innerPort: string,
  resolveNode: (node: NodeData) => NodeSchema | undefined,
): string | undefined {
  if (innerPort !== binding.port && !innerPort.startsWith(`${binding.port}.`)) return undefined
  const rest = innerPort.slice(binding.port.length)
  const found = constructAt(child, binding, resolveNode)
  if (found === undefined) return undefined
  const { target, row } = found
  if (row.kind !== 'group' || rest === '') return `${itemId}${rest}`
  const [, key, ...more] = rest.split('.')
  const outer = outerMemberKey(row, interiorMembersOf(row, target.dynamic?.[binding.port]), key!)
  return outer === undefined ? undefined : [itemId, outer, ...more].join('.')
}

function constructAt(
  child: GraphDef,
  binding: ConstructBoundaryBinding,
  resolveNode: (node: NodeData) => NodeSchema | undefined,
): { readonly target: NodeData; readonly schema: NodeSchema; readonly row: NonNullable<ReturnType<typeof constructRowOf>> } | undefined {
  const target = child.nodes[binding.node]
  const schema = target && resolveNode(target)
  const route = schema && resolveBoundaryRoute(schema, binding, undefined, target.values, target.dynamic)
  const row = route?.ok ? constructRowOf(route.route) : undefined
  return row === undefined ? undefined : { target: target!, schema: schema!, row }
}

export interface ConstructProjection {
  /** Inner node -> its whole dynamic state with the subgraph node's own state in place. */
  readonly dynamic: ReadonlyMap<NodeId, Readonly<Record<string, DynamicPortState>>>
  /** Inner node -> its whole values with the subgraph node's own values in place. */
  readonly values: ReadonlyMap<NodeId, Readonly<Record<string, Json>>>
  /** Inner node -> inner value key -> the subgraph node's value key that holds it. */
  readonly owners: ReadonlyMap<NodeId, ReadonlyMap<string, string>>
}

/**
 * Put one subgraph node's state into its definition's inner nodes for one
 * occurrence: what it stores under each construct it shows whole, and the
 * value of each field it shows. The definition's members come first in each
 * group; the subgraph node's own follow. Nothing here is saved.
 */
export function projectConstructs(
  child: GraphDef,
  instance: Pick<NodeData, 'values' | 'dynamic'>,
  resolveNode: (node: NodeData) => NodeSchema | undefined,
  base: ReadonlyMap<string, Readonly<Record<string, DynamicPortState>>> = new Map(),
): ConstructProjection {
  const dynamic = new Map<NodeId, Record<string, DynamicPortState>>()
  const values = new Map<NodeId, Record<string, Json>>()
  const owners = new Map<NodeId, Map<string, string>>()
  const dynamicOf = (node: NodeData): Record<string, DynamicPortState> => {
    let found = dynamic.get(node.id)
    if (!found) dynamic.set(node.id, (found = { ...(base.get(node.id) ?? node.dynamic) }))
    return found
  }
  const valuesOf = (node: NodeData): Record<string, Json> => {
    let found = values.get(node.id)
    if (!found) values.set(node.id, (found = { ...node.values }))
    return found
  }
  const own = (node: NodeData, key: string, owner: string): void => {
    let byKey = owners.get(node.id)
    if (!byKey) owners.set(node.id, (byKey = new Map()))
    if (!byKey.has(key)) byKey.set(key, owner)
  }
  const write = (node: NodeData, key: string, value: Json, owner: string): void => {
    valuesOf(node)[key] = value
    own(node, key, owner)
  }
  for (const item of [...(boundaryItems(child.boundary, 'inputs') ?? []), ...(boundaryItems(child.boundary, 'outputs') ?? [])]) {
    if (item.binds.kind === 'port' && item.promoted === true && Object.hasOwn(instance.values, item.id)) {
      // A field the subgraph node shows reaches its inner field before the
      // inner node's formulas read it, as a group count or a choice leader does.
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.kind !== 'port' || binding.viaReroute !== undefined) continue
        const target = child.nodes[binding.node]
        if (target !== undefined) write(target, binding.port, instance.values[item.id]!, item.id)
      }
      continue
    }
    if (item.binds.kind !== 'construct') continue
    const under = (key: string): boolean => key === item.id || key.startsWith(`${item.id}.`)
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (binding.kind !== 'construct') continue
      const found = constructAt(child, binding, resolveNode)
      if (found === undefined) continue
      const { target, schema, row } = found
      const interior = row.kind === 'group' ? interiorMembersOf(row, target.dynamic?.[binding.port]) : undefined
      const map = (key: string): string | undefined => innerConstructAddress(child, binding, item.id, key, resolveNode)
      const outerOf = (key: string): string | undefined => outerConstructAddress(child, binding, item.id, key, resolveNode)
      if (row.kind === 'group' && typeof row.grows === 'string') {
        // A member the subgraph node owns starts empty: what the definition
        // stores at that place inside is not the subgraph node's.
        const owned = (key: string): boolean => key.startsWith(`${binding.port}.`) && outerOf(key) !== undefined
        for (const key of Object.keys(values.get(target.id) ?? target.values)) if (owned(key)) delete valuesOf(target)[key]
        for (const key of Object.keys(dynamic.get(target.id) ?? base.get(target.id) ?? target.dynamic ?? {})) if (owned(key)) delete dynamicOf(target)[key]
      }
      for (const [key, state] of Object.entries(instance.dynamic ?? {})) {
        if (!under(key)) continue
        const innerKey = map(key)
        if (innerKey === undefined) continue
        const into = dynamicOf(target)
        if (key === item.id && row.kind === 'group' && interior !== undefined) {
          const ownMembers = (state.members ?? []).flatMap((member) => innerMemberKey(row, interior, member) ?? [])
          const labels = Object.entries(state.memberLabels ?? {}).flatMap(([member, label]) => {
            const moved = innerMemberKey(row, interior, member)
            return moved === undefined ? [] : [[moved, label] as const]
          })
          const { seq: _seq, members: _members, memberLabels: _labels, ...rest } = state
          const previous = into[innerKey]
          into[innerKey] = {
            ...previous,
            ...rest,
            members: [...interior.members, ...ownMembers],
            ...(labels.length > 0 || previous?.memberLabels !== undefined
              ? { memberLabels: { ...previous?.memberLabels, ...Object.fromEntries(labels) } }
              : {}),
          }
        } else {
          into[innerKey] = { ...into[innerKey], ...state }
        }
      }
      for (const [key, value] of Object.entries(instance.values)) {
        if (!under(key)) continue
        const innerKey = map(key)
        if (innerKey !== undefined) write(target, innerKey, value, key)
      }
      // Every row of the construct is the subgraph node's, stored there or
      // not: an edit inside writes it outside, never into the definition.
      if (row.kind !== 'group') own(target, binding.port, item.id)
      const dynamicNow = dynamic.get(target.id) ?? base.get(target.id) ?? target.dynamic
      const shown = elaborateInterface(schema, {
        values: values.get(target.id) ?? target.values,
        ...(dynamicNow !== undefined ? { dynamic: dynamicNow } : {}),
        ...(target.additionalInputs !== undefined ? { additionalInputs: target.additionalInputs } : {}),
      })
      for (const key of [...elabInputsOf(shown).map((input) => input.address.port), ...shown.constructs]) {
        const outer = outerOf(key)
        if (outer !== undefined) own(target, key, outer)
      }
    }
  }
  return { dynamic, values, owners }
}

