import { boundaryItems, type GraphDef, type WorkflowDocument } from '../format/document.js'
import { asNodeId, asPortId, isPortEndpoint, isRerouteRef, isWidgetTapRef, type LinkId, type NodeId } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { buildRerouteIndex, rerouteInputTargets, traceEndpointAll, type RerouteTrace } from '../reroute.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import { buildGraphConnectivity } from '../schema/elaborate.js'
import { cardinalityOf, type TypeExpr } from '../schema/model.js'
import { combineListCountFacts, solveGraphTypes, type ListCountFact, type SolveOptions, type SolveResult } from '../schema/solve.js'
import { documentNodeResolver } from './compile.js'
import { effectiveOccurrenceTopology, resolveOccurrenceLinkEndpoint, type EffectiveLink, type EffectiveOccurrenceTopology } from './effective-topology.js'
import { occurrenceDynamicView } from './occurrence-view.js'

type ProjectedTypeConstraint = NonNullable<SolveOptions['projectedInputs']>[number]

/** Metadata belongs to a concrete producer occurrence, never its shared definition. */
export type OccurrenceListCountEstimate = (instancePath: readonly NodeId[], node: NodeId, port: string) => Extract<ListCountFact, { kind: 'estimate' }> | undefined

function projectTypeThroughRegionInputs(
  document: WorkflowDocument,
  link: EffectiveLink,
  type: TypeExpr,
): TypeExpr {
  if (link.identity.kind !== 'parentLeg') return type
  let graph = document.graphs[document.root]
  let routeIndex = 0
  let projected = type
  for (const nodeId of link.to.instancePath) {
    const node = graph?.nodes[nodeId]
    const bodyId = subgraphDefIdOf(node?.type ?? '')
    if (node === undefined || bodyId === undefined) break
    const index = link.identity.route.findIndex((leg, candidate) =>
      candidate >= routeIndex && leg.graph === bodyId)
    if (index >= 0) {
      const leg = link.identity.route[index]!
      if (node.region?.elementPorts?.includes(leg.boundaryId) && projected.kind === 'list') {
        projected = projected.element
      }
      routeIndex = index + 1
    }
    graph = document.graphs[bodyId]
  }
  return projected
}

function occurrenceTypeSolver(
  document: WorkflowDocument,
  resolve: SchemaResolver,
  estimateOf?: OccurrenceListCountEstimate,
) {
  const resolveDocumentNode = documentNodeResolver(document, resolve)
  type ProjectionSolve = {
    readonly graph: GraphDef
    readonly result: SolveResult
    readonly variableSources: ReadonlyMap<NodeId, symbol>
  }
  const cache = new Map<string, ProjectionSolve>()
  const constraintsOf = (
    effective: EffectiveOccurrenceTopology | undefined,
    targetGraph: GraphDef,
  ): readonly ProjectedTypeConstraint[] => (effective?.projectedParentLinks ?? []).flatMap((link) => {
    if (link.to.graphId !== targetGraph.id) return []
    const targets = isPortEndpoint(link.to.endpoint) ? [link.to.endpoint]
      : isRerouteRef(link.to.endpoint) ? rerouteInputTargets(targetGraph, link.to.endpoint.reroute) ?? [] : []
    if (targets.length === 0) return []
    const solved = solveProjectionGraph(link.from.graphId, link.from.instancePath)
    if (solved === undefined) return []
    const upstream = traceEndpointAll(solved.graph, link.from.endpoint, buildRerouteIndex(solved.graph))
    const traces: readonly RerouteTrace[] = isWidgetTapRef(link.from.endpoint) && upstream.some((trace) => trace.kind === 'undriven')
      ? [{ kind: 'tapValue', node: link.from.endpoint.node, input: link.from.endpoint.tap }]
      : upstream
    return traces.flatMap((trace) => {
      const source = trace.kind === 'output' ? { ...trace.ref, side: 'output' as const }
        : trace.kind === 'tapValue' ? { node: trace.node, port: trace.input, side: 'input' as const } : undefined
      if (source === undefined) return []
      const type = solved.result.portTypeOf(source.node, source.side, source.port)
      if (type === undefined) return []
      const projectedType = projectTypeThroughRegionInputs(document, link, type)
      // A region's element is not the list that drives its iterations.
      const itemCount = projectedType === type ? solved.result.itemCountOf(source.node, source.side, source.port)
        : cardinalityOf(projectedType) === 'scalar' ? 1 : undefined
      const fact = projectedType === type ? solved.result.listCountFactOf(source.node, source.side, source.port) : undefined
      return targets.map((to) => ({
        type: projectedType,
        ...(itemCount !== undefined ? { itemCount } : {}),
        ...(fact?.kind === 'estimate' ? { itemCountEstimate: fact } : {}),
        to,
        label: `projected ${JSON.stringify(link.identity)}`,
        variableSource: solved.variableSources.get(source.node)!,
      }))
    })
  })
  const outputListCountFactOf = (
    graph: GraphDef,
    path: readonly NodeId[],
    nodeId: NodeId,
    port: string,
  ): ListCountFact | undefined => {
    const node = graph.nodes[nodeId]
    const childId = node && subgraphDefIdOf(node.type)
    const child = childId === undefined ? undefined : document.graphs[childId]
    const item = child?.boundary && boundaryItems(child.boundary, 'outputs').find((item) => item.id === port)
    if (!node || node.region || !child || !item) return undefined
    const owner = { instancePath: path, node: nodeId }
    const resolved = resolveOccurrenceLinkEndpoint(document, owner, {
      kind: 'boundary', occurrence: owner, address: { port: asPortId(item.id) },
      route: [{ graph: child.id, boundaryId: item.id, binding: item.binds }],
    }, 'from').endpoint
    if (resolved === undefined) return undefined
    const producer = solveProjectionGraph(resolved.graphId, resolved.instancePath)
    if (producer === undefined) return undefined
    if (isWidgetTapRef(resolved.endpoint)) {
      const count = producer.result.listCountFactOf(resolved.endpoint.node, 'input', resolved.endpoint.tap)
      if (count !== undefined) return count
    }
    const counts = traceEndpointAll(producer.graph, resolved.endpoint, buildRerouteIndex(producer.graph)).map((trace) =>
      trace.kind === 'output' ? producer.result.listCountFactOf(trace.ref.node, 'output', trace.ref.port)
        : trace.kind === 'tapValue' ? producer.result.listCountFactOf(trace.node, 'input', trace.input) : undefined)
    return combineListCountFacts(counts)
  }
  const countOptions = (graph: GraphDef, path: readonly NodeId[]): Pick<SolveOptions, 'outputListCountOf' | 'outputListCountEstimateOf'> => ({
    outputListCountOf: (node, port) => {
      const fact = outputListCountFactOf(graph, path, node, port)
      return fact?.kind === 'known' ? fact.count : undefined
    },
    outputListCountEstimateOf: (node, port) => {
      if (subgraphDefIdOf(graph.nodes[node]?.type ?? '') === undefined) return estimateOf?.(path, node, port)
      const fact = outputListCountFactOf(graph, path, node, port)
      return fact?.kind === 'estimate' ? fact : undefined
    },
  })
  const solveProjectionGraph = (
    sourceGraphId: string,
    instancePath: readonly NodeId[],
  ): ProjectionSolve | undefined => {
    const key = JSON.stringify([sourceGraphId, instancePath])
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const graph = document.graphs[sourceGraphId]
    if (graph === undefined) return undefined
    const owner = instancePath.length === 0 ? undefined : {
      instancePath: instancePath.slice(0, -1),
      node: instancePath[instancePath.length - 1]!,
    }
    const effective = owner === undefined ? undefined : effectiveOccurrenceTopology(document, resolve, owner)
    const occurrenceView = occurrenceDynamicView(document, resolve, instancePath)
    const solveGraph: GraphDef = {
      ...graph,
      nodes: Object.fromEntries(Object.entries(graph.nodes).map(([id, node]) => {
        const dynamic = occurrenceView?.dynamic.get(id)
        const values = occurrenceView?.values.get(id)
        return [id, dynamic === undefined && values === undefined
          ? node
          : { ...node, ...(values !== undefined ? { values } : {}), ...(dynamic !== undefined ? { dynamic } : {}) }]
      })),
      links: effective === undefined ? graph.links : Object.fromEntries(effective.links.map((link, index) => [
        `__projection_solve_${index}`,
        {
          id: `__projection_solve_${index}` as LinkId,
          from: link.from.endpoint,
          to: link.to.endpoint,
        },
      ])) as GraphDef['links'],
      nets: effective === undefined ? graph.nets : {},
    }
    const baseConnectivity = buildGraphConnectivity(solveGraph)
    const projectedInputKeys = new Map<string, Set<string>>()
    const projectedOutputKeys = new Map<string, Set<string>>()
    const projectedInputPortKeys = new Map<string, Set<string>>()
    for (const link of effective?.projectedParentLinks ?? []) {
      if (link.from.graphId === graph.id && isPortEndpoint(link.from.endpoint)) {
        const keys = projectedOutputKeys.get(link.from.endpoint.node) ?? new Set<string>()
        keys.add(link.from.endpoint.port)
        projectedOutputKeys.set(link.from.endpoint.node, keys)
      }
      if (link.to.graphId === graph.id && isPortEndpoint(link.to.endpoint)) {
        const keys = projectedInputKeys.get(link.to.endpoint.node) ?? new Set<string>()
        keys.add(link.to.endpoint.port)
        projectedInputKeys.set(link.to.endpoint.node, keys)
        const ports = projectedInputPortKeys.get(link.to.endpoint.node) ?? new Set<string>()
        ports.add(link.to.endpoint.port)
        projectedInputPortKeys.set(link.to.endpoint.node, ports)
      }
    }
    const connectivityOf = (nodeId: NodeId) => {
      const base = baseConnectivity(nodeId)
      return {
        isInputConnected: (port: string) =>
          projectedInputKeys.get(nodeId)?.has(port) || base.isInputConnected(port),
        isOutputConnected: (port: string) =>
          projectedOutputKeys.get(nodeId)?.has(port) || base.isOutputConnected(port),
        inputPorts: () => [...new Set([...(base.inputPorts?.() ?? []), ...(projectedInputPortKeys.get(nodeId) ?? [])])],
        outputPorts: () => [...new Set([...(base.outputPorts?.() ?? []), ...(projectedOutputKeys.get(nodeId) ?? [])])],
      }
    }
    const result = solveGraphTypes(solveGraph, resolve, {
      resolveNode: (node) => resolveDocumentNode(sourceGraphId, node),
      connectivityOf,
      projectedInputs: constraintsOf(effective, solveGraph),
      ...countOptions(solveGraph, instancePath),
    })
    const variableSources = new Map(
      Object.keys(solveGraph.nodes).map((nodeId) => [asNodeId(nodeId), Symbol(nodeId)]),
    )
    const solved = { graph: solveGraph, result, variableSources }
    cache.set(key, solved)
    return solved
  }
  return {
    solve: solveProjectionGraph,
    options: (topology: EffectiveOccurrenceTopology | undefined, graph: GraphDef, instancePath: readonly NodeId[]) => ({
      projectedInputs: constraintsOf(topology, graph), ...countOptions(graph, instancePath),
    }),
  }
}

/** Resolve parent producers outward so each drilled graph receives only its occurrence's constraints. */
export function occurrenceSolveOptions(
  document: WorkflowDocument,
  resolve: SchemaResolver,
  topology: EffectiveOccurrenceTopology | undefined,
  graph: GraphDef,
  instancePath: readonly NodeId[],
  estimateOf?: OccurrenceListCountEstimate,
): Pick<SolveOptions, 'projectedInputs' | 'outputListCountOf' | 'outputListCountEstimateOf'> {
  return occurrenceTypeSolver(document, resolve, estimateOf).options(topology, graph, instancePath)
}

/** Solve the concrete graph, including its local topology, values and parent arrivals. */
export function solveOccurrenceTypes(
  document: WorkflowDocument,
  resolve: SchemaResolver,
  graphId: string,
  instancePath: readonly NodeId[],
  estimateOf?: OccurrenceListCountEstimate,
): SolveResult | undefined {
  return occurrenceTypeSolver(document, resolve, estimateOf).solve(graphId, instancePath)?.result
}
