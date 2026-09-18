/**
 * Project backend runtime state onto one concrete canvas view.
 *
 * The execution store deliberately keeps runtime ids: they are the only
 * identities that stay unique when one graph definition is instantiated
 * twice. Projection belongs at the view boundary, where the navigated
 * instance path is finally known. Compile provenance translates lowered
 * runtime names back to qualified source occurrences; the core mapper's
 * parse fallback preserves the historical node-id behavior for foreign or
 * reconciled executions that have no locally retained artifact.
 */

import { nodeStatesForGraph, type Scene } from '@dinkster/canvas'
import {
  occurrencesForView,
  parseDinksterRuntimePath,
  type NodeProgress,
  type RegionProgress,
} from '@dinkster/core'

export function projectExecutionNodeStates(args: {
  readonly states: Readonly<Record<string, NodeProgress>>
  readonly scene: Scene
  /** Undefined means navigation provenance is untrustworthy: never guess. */
  readonly instancePath: readonly string[] | undefined
  readonly toSource?: Readonly<Record<string, string>> | undefined
}): Readonly<Record<string, NodeProgress>> {
  if (args.instancePath === undefined) return {}

  const occurrences = occurrencesForView({
    instancePath: args.instancePath,
    runtimeIds: Object.keys(args.states),
    toSource: args.toSource,
  })
  const sceneNodes = new Map(args.scene.nodes.map((node) => [node.id, node]))
  return nodeStatesForGraph(args.states, args.scene, (id, isSubgraph) =>
    sceneNodes.get(id)?.regionKind !== undefined
      ? (occurrences.own.get(id) ?? [])
      : isSubgraph ? (occurrences.inner.get(id) ?? []) : (occurrences.own.get(id) ?? []),
  )
}

function iterationForRegion(runtimeId: string, regionRuntimeId: string): number | undefined {
  const path = parseDinksterRuntimePath(runtimeId)
  const region = parseDinksterRuntimePath(regionRuntimeId)
  if (path === undefined || region === undefined || path.length <= region.length) return undefined
  for (let i = 0; i < region.length - 1; i++) {
    if (path[i]?.nodeId !== region[i]?.nodeId || path[i]?.iteration !== region[i]?.iteration) return undefined
  }
  const regionSegment = region[region.length - 1]!
  const pathSegment = path[region.length - 1]!
  return pathSegment.nodeId === regionSegment.nodeId ? pathSegment.iteration : undefined
}

export function projectRegionIterationLabels(args: {
  readonly regions: Readonly<Record<string, RegionProgress>>
  readonly states: Readonly<Record<string, NodeProgress>>
  readonly scene: Scene
  readonly instancePath: readonly string[] | undefined
  readonly toSource?: Readonly<Record<string, string>> | undefined
}): Readonly<Record<string, string>> {
  if (args.instancePath === undefined || Object.keys(args.regions).length === 0) return {}
  const occurrences = occurrencesForView({
    instancePath: args.instancePath,
    runtimeIds: Object.keys(args.regions),
    toSource: args.toSource,
  })
  const labels: Record<string, string> = {}
  for (const node of args.scene.nodes) {
    if (node.regionKind === undefined) continue
    // Only the node's own undecorated lifecycle record is authoritative; a
    // decorated descendant (a nested region such as `outer[0]/inner`) must
    // never supply the outer occurrence's counter.
    const regionRuntimeId = (occurrences.own.get(node.id) ?? [])[0]
    if (regionRuntimeId === undefined || regionRuntimeId.includes('/') || /\[\d+\]$/.test(regionRuntimeId)) {
      continue
    }
    const region = args.regions[regionRuntimeId]
    if (region === undefined) continue
    const running = Object.entries(args.states)
      .filter(([, progress]) => progress.state === 'running')
      .map(([runtimeId]) => iterationForRegion(runtimeId, regionRuntimeId))
      .filter((iteration): iteration is number => iteration !== undefined)
    const index = running.length > 0 ? Math.max(...running) + 1 : region.finishedIterations
    if (index === undefined) continue
    labels[node.id] = region.iterations === null
      ? `iteration ${index}`
      : `iteration ${index} of ${region.iterations}`
  }
  return labels
}
