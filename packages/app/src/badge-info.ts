/**
 * Framework-free badge-popover content resolvers: the data each node-badge
 * popover branch renders, derived from plain document/registry state. Kept
 * out of BadgePopover.tsx so unit tests (node environment, no Solid
 * transform) can pin them directly - same split as menu-target.ts.
 *
 * The host wraps these with its reactive document and registry state;
 * nothing here reads a signal.
 */

import {
  resolveDeprecationPointer,
  subgraphDefIdOf,
  type NodeSchema,
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

export interface DeprecationBadgeInfo {
  readonly type: string
  readonly deprecation: NodeSchema['deprecation']
  /** Name-only successor pointer, resolved transitively (display guidance). */
  readonly pointer: ResolvedDeprecationPointer | undefined
}

/**
 * Deprecation badge popover content; undefined when the node is missing.
 */
export function deprecationBadgeInfo(args: {
  readonly doc: WorkflowDocument
  readonly graphId: string
  readonly nodeId: string
  readonly resolve: ((type: string) => NodeSchema | undefined) | undefined
}): DeprecationBadgeInfo | undefined {
  const { doc, graphId, nodeId, resolve } = args
  const type = doc.graphs[graphId]?.nodes[nodeId]?.type
  if (type === undefined) return undefined
  const schema = resolve?.(type)
  return {
    type,
    deprecation: schema?.deprecation,
    // Name-only successor pointer, resolved transitively (A -> B -> C
    // shows C). Display guidance only, never an executable mapping.
    pointer: schema && resolve ? resolveDeprecationPointer(schema, resolve) : undefined,
  }
}
