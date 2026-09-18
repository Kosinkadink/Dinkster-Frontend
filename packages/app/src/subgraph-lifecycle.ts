import {
  documentResolver,
  expandLifecycleSelectionFromGroups,
  hasSemanticLifecycleSelection,
  inputsOf,
  lifecycleCanonicalHash,
  lifecycleFlattenFingerprint,
  lifecycleSelectionFingerprint,
  outputsOf,
  planFlattenOccurrenceTopology,
  planFlattenBoundaryRoutes,
  resolveStaticWidgetTap,
  subgraphDefIdOf,
  type CommandInvocation,
  type CommandOutcome,
  type Json,
  type LifecycleSelectionInput,
  type NodeSchema,
  type ResolvedGeometryItem,
  type WorkflowDocument,
} from '@dinkster/core'

export interface LifecycleSelectionSnapshot extends LifecycleSelectionInput {
  readonly geometry: readonly ResolvedGeometryItem[]
}

export type ExtractCommit =
  | { readonly status: 'refused'; readonly selectedNodeIds: readonly string[] }
  | { readonly status: 'committed'; readonly selectedNodeIds: readonly string[]; readonly outcome: Extract<CommandOutcome, { ok: true }> }

/** Commit one already validated extraction plan with its default name. */
export function commitExtract(args: {
  readonly invocation: CommandInvocation
  readonly beforeNodeIds: ReadonlySet<string>
  readonly graphId: string
  readonly dispatch: (invocation: CommandInvocation) => CommandOutcome
}): ExtractCommit {
  const outcome = args.dispatch(args.invocation)
  if (!outcome.ok) return { status: 'refused', selectedNodeIds: [] }
  return {
    status: 'committed',
    selectedNodeIds: Object.keys(outcome.doc.graphs[args.graphId]?.nodes ?? {}).filter((id) => !args.beforeNodeIds.has(id)),
    outcome,
  }
}

export function extractInvocation(
  doc: WorkflowDocument,
  graphId: string,
  instancePath: readonly string[],
  snapshot: LifecycleSelectionSnapshot,
  name: string | undefined,
  resolveSchema: (type: string) => NodeSchema | undefined,
): CommandInvocation | undefined {
  const expanded = expandLifecycleSelectionFromGroups(snapshot, snapshot.geometry)
  if (expanded === undefined) return undefined
  const selected = new Set([
    ...expanded.selection.nodeIds.map((id) => `node:${id}`),
    ...expanded.selection.rerouteIds.map((id) => `reroute:${id}`),
    ...expanded.selection.valueSourceIds.map((id) => `valueSource:${id}`),
    ...expanded.selection.selectorIds.map((id) => `selector:${id}`),
    ...expanded.selection.groupIds.map((id) => `group:${id}`),
  ])
  const resolvedGeometry = snapshot.geometry.filter((item) => selected.has(`${item.kind}:${item.id}`))
  const selectionFingerprint = lifecycleSelectionFingerprint(doc, graphId, expanded.selection)
  if (selectionFingerprint === undefined) return undefined
  const graph = doc.graphs[graphId]
  if (graph === undefined) return undefined
  const resolve = documentResolver(doc, resolveSchema)
  const specializedSlotRoots = Object.values(graph.nodes).flatMap((node) => {
    const schema = resolve(node.type)
    return schema === undefined
      ? []
      : [...inputsOf(schema), ...outputsOf(schema)]
          .filter((port) => port.dynamic?.kind === 'dynamicSlot')
          .map((port) => ({ node: node.id, port: port.id }))
  })
  const widgetTapSources = Object.values(graph.nodes).flatMap((node) => {
    const schema = resolve(node.type)
    if (schema === undefined) return []
    return schema.items.flatMap((item, index) =>
      item.kind === 'input' && item.hidden !== true && schema.items.findIndex((candidate) => candidate.kind === 'input' && candidate.id === item.id) === index &&
      resolveStaticWidgetTap(schema, item.id).ok
        ? [{ node: node.id, tap: item.id }]
        : [],
    )
  })
  const minX = Math.min(...resolvedGeometry.map((item) => item.x))
  const minY = Math.min(...resolvedGeometry.map((item) => item.y))
  const maxX = Math.max(...resolvedGeometry.map((item) => item.x + item.width))
  const maxY = Math.max(...resolvedGeometry.map((item) => item.y + item.height))
  const placementCenter = resolvedGeometry.length === 0
    ? { x: 0, y: 0 }
    : { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  return {
    command: 'subgraph.extract',
    params: {
      graphId,
      instancePath: [...instancePath],
      selection: expanded.selection,
      selectionFingerprint,
      specializedSlotRoots,
      widgetTapSources,
      groupMemberships: expanded.groups,
      placementCenter,
      resolvedGeometry,
      ...(name !== undefined && name.trim() !== '' ? { name: name.trim() } : {}),
    } as unknown as Json,
  }
}

export function flattenInvocation(
  doc: WorkflowDocument,
  graphId: string,
  instancePath: readonly string[],
  nodeId: string,
  occurrence: ResolvedGeometryItem,
  bodyGeometry: readonly ResolvedGeometryItem[],
  resolveSchema: (type: string) => NodeSchema | undefined,
): CommandInvocation | undefined {
  const parent = doc.graphs[graphId]
  const node = parent?.nodes[nodeId]
  const bodyId = node === undefined ? undefined : subgraphDefIdOf(node.type)
  const body = bodyId === undefined ? undefined : doc.graphs[bodyId]
  if (parent === undefined || node === undefined || body === undefined) return undefined
  const plan = planFlattenBoundaryRoutes(body, documentResolver(doc, resolveSchema), node, parent)
  const occurrenceOwner = { instancePath: instancePath as never, node: nodeId as never }
  const occurrenceTopology = planFlattenOccurrenceTopology(doc, documentResolver(doc, resolveSchema), occurrenceOwner)
  if (occurrenceTopology.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return undefined
  const occurrenceTopologyPlanDigest = occurrenceTopology.plan === undefined
    ? undefined
    : lifecycleCanonicalHash(occurrenceTopology.plan)
  const selectionFingerprint = lifecycleFlattenFingerprint(doc, graphId, nodeId, {
    boundaryPlan: plan.boundaryPlan,
    statePlan: plan.statePlan,
    schemaPlanDigest: plan.schemaPlanDigest,
    ...(occurrenceTopology.plan !== undefined ? {
      occurrenceTopologyPlan: occurrenceTopology.plan,
      occurrenceTopologyPlanDigest,
    } : {}),
  })
  if (selectionFingerprint === undefined) return undefined
  return {
    command: 'subgraph.flatten',
    params: {
      graphId,
      instancePath: [...instancePath],
      nodeId,
      placementCenter: { x: occurrence.x + occurrence.width / 2, y: occurrence.y + occurrence.height / 2 },
      resolvedGeometry: { occurrence, body: bodyGeometry },
      boundaryPlan: plan.boundaryPlan,
      statePlan: plan.statePlan,
      schemaSnapshot: plan.schemaSnapshot,
      schemaPlanDigest: plan.schemaPlanDigest,
      ...(occurrenceTopology.plan !== undefined ? {
        occurrenceTopologyPlan: occurrenceTopology.plan,
        occurrenceTopologyPlanDigest,
      } : {}),
      selectionFingerprint,
    } as unknown as Json,
  }
}

export function isFlattenSelection(doc: WorkflowDocument, graphId: string, nodeIds: readonly string[], otherCount: number): boolean {
  if (nodeIds.length !== 1 || otherCount !== 0) return false
  const node = doc.graphs[graphId]?.nodes[nodeIds[0]!]
  const bodyId = node === undefined ? undefined : subgraphDefIdOf(node.type)
  return bodyId !== undefined && doc.graphs[bodyId]?.boundary !== undefined
}

export const hasExtractSelection = (snapshot: LifecycleSelectionSnapshot): boolean => {
  const expanded = expandLifecycleSelectionFromGroups(snapshot, snapshot.geometry)
  return expanded !== undefined && hasSemanticLifecycleSelection(expanded.selection)
}
