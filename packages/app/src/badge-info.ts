/**
 * Framework-free badge-popover content resolvers: the data each node-badge
 * popover branch renders, derived from plain document/registry state. Kept
 * out of BadgePopover.tsx so unit tests (node environment, no Solid
 * transform) can pin them directly - same split as menu-target.ts.
 *
 * The host wraps these with its reactive state (active tab, replacement
 * scan items, backend problem feed); nothing here reads a signal.
 */

import {
  resolveDeprecationPointer,
  subgraphDefIdOf,
  type NodeSchema,
  type ReplacementScanItem,
  type ResolvedDeprecationPointer,
  type WorkflowDocument,
} from '@dinkster/core'

// -- subgraph badge -----------------------------------------------------------

export interface SubgraphBadgeInfo {
  readonly defId: string
  readonly name: string
  readonly nodeCount: number
}

/** Subgraph badge popover content; undefined when the definition is missing. */
export function subgraphBadgeInfo(
  doc: WorkflowDocument,
  graphId: string,
  nodeId: string,
): SubgraphBadgeInfo | undefined {
  const node = doc.graphs[graphId]?.nodes[nodeId]
  const defId = node ? subgraphDefIdOf(node.type) : undefined
  const def = defId ? doc.graphs[defId] : undefined
  if (!defId || !def) return undefined
  return { defId, name: def.name, nodeCount: Object.keys(def.nodes).length }
}

// -- deprecation badge --------------------------------------------------------

export interface ReplacementBadgeInfo<P extends { readonly from: string }> {
  readonly type: string
  /** Migration-chain scan item for this node; absent when no rule planned. */
  readonly item: ReplacementScanItem | undefined
  /** Advisory server problems whose predecessor the chain passes through. */
  readonly problems: readonly P[]
  readonly deprecation: NodeSchema['deprecation']
  /** Name-only successor pointer, resolved transitively (display guidance). */
  readonly pointer: ResolvedDeprecationPointer | undefined
}

/**
 * Deprecation badge popover content; undefined when the node is missing.
 * `problems` is the backend's full advisory rule-diagnostic feed - entries
 * are kept when their predecessor is any type this node's migration chain
 * passes through (they explain WHY a rule cannot plan against the installed
 * environment). Advisory only - schemas stay loadable and the scan's own
 * diagnostics stay primary.
 */
export function replacementBadgeInfo<P extends { readonly from: string }>(args: {
  readonly doc: WorkflowDocument
  readonly graphId: string
  readonly nodeId: string
  readonly resolve: ((type: string) => NodeSchema | undefined) | undefined
  readonly item: ReplacementScanItem | undefined
  readonly problems: readonly P[]
}): ReplacementBadgeInfo<P> | undefined {
  const { doc, graphId, nodeId, resolve, item, problems } = args
  const type = doc.graphs[graphId]?.nodes[nodeId]?.type
  if (type === undefined) return undefined
  const schema = resolve?.(type)
  const chainTypes = new Set([type, ...(item ? [item.terminalType, ...item.hops.map((h) => h.plan.to)] : [])])
  return {
    type,
    item,
    problems: problems.filter((p) => chainTypes.has(p.from)),
    deprecation: schema?.deprecation,
    // Name-only successor pointer, resolved transitively (A -> B -> C
    // shows C). Display guidance only - the executable path is the item.
    pointer: schema && resolve ? resolveDeprecationPointer(schema, resolve) : undefined,
  }
}
