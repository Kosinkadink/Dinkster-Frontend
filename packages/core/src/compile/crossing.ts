/**
 * Boundary address helpers shared by compilation, occurrence views,
 * invariants and commands: selecting the boundary item an instance address
 * names, and projecting promoted editable menus onto inner nodes.
 */

import type { BoundaryItem, DynamicPortState, GraphDef, NodeData } from '../format/document.js'
import type { NodeId } from '../ids.js'
import { resolveBoundaryRoute } from '../schema/derive-boundary.js'
import type { NodeSchema } from '../schema/model.js'

/** Project schema-opted-in menus through promoted inputs without changing values. */
export function projectEditableOptions(
  child: GraphDef,
  instanceDynamic: Readonly<Record<string, DynamicPortState>> | undefined,
  resolveNode: (node: NodeData) => NodeSchema | undefined,
): ReadonlyMap<NodeId, Readonly<Record<string, DynamicPortState>>> {
  const projected = new Map<NodeId, Readonly<Record<string, DynamicPortState>>>()
  const claimed = new Map<NodeId, Set<string>>()
  for (const item of child.boundary?.inputs ?? []) {
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
      const key = JSON.stringify([binding.port, binding.members])
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
  readonly members?: readonly string[]
}

export type BoundaryMatch =
  | { readonly ok: true; readonly item: BoundaryItem }
  | { readonly ok: false; readonly code: 'missing' | 'ambiguous'; readonly message: string }

/**
 * Select THE boundary item an instance-side address refers to: the address
 * is exactly the item's id, with no member path (the INSTANCE-side port is a
 * plain static port even when its inner binding targets a group member).
 * Every candidate is enumerated and exactly one must fit.
 */
export function matchBoundaryItem(items: readonly BoundaryItem[], addr: BoundaryAddr): BoundaryMatch {
  const candidates = items.filter((i) => addr.port === i.id && addr.members === undefined)
  if (candidates.length === 1) return { ok: true, item: candidates[0]! }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'missing',
      message: `no boundary item matches '${addr.port}'${addr.members ? ` member '${addr.members.join('.')}'` : ''}`,
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
  return (child.boundary?.outputs ?? [])
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
