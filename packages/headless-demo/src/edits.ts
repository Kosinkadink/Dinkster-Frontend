import {
  isPortEndpoint,
  type CommandInvocation,
  type GraphDef,
  type Json,
  type NodeData,
  type PortRef,
  type Vec2,
  type WorkflowDocument,
} from '@dinkster/core'

export interface DemoEditOptions {
  readonly type?: string
}

interface DemoNode {
  readonly node: NodeData
  readonly position: Vec2
}

export interface DemoEditSource {
  readonly graphId: string
  readonly first: DemoNode
  readonly second?: DemoNode
  readonly ports?: {
    readonly from: Omit<PortRef, 'node'>
    readonly to: Omit<PortRef, 'node'>
  }
}

const positionOf = (doc: WorkflowDocument, graphId: string, nodeId: string): Vec2 =>
  doc.view.graphs[graphId]?.nodes[nodeId]?.position ?? { x: 0, y: 0 }

const endpointWithoutNode = (endpoint: PortRef): Omit<PortRef, 'node'> => ({
  port: endpoint.port,
  ...(endpoint.members !== undefined ? { members: endpoint.members } : {}),
})

export function demoEditSource(doc: WorkflowDocument, opts: DemoEditOptions = {}): DemoEditSource {
  const graphId = doc.root
  const graph = doc.graphs[graphId]
  if (graph === undefined) throw new Error(`root graph '${graphId}' does not exist`)

  for (const link of Object.values(graph.links)) {
    if (!isPortEndpoint(link.from) || !isPortEndpoint(link.to)) continue
    const first = graph.nodes[link.from.node]
    const second = graph.nodes[link.to.node]
    if (first === undefined || second === undefined) continue
    return {
      graphId,
      first: { node: first, position: positionOf(doc, graphId, first.id) },
      second: { node: second, position: positionOf(doc, graphId, second.id) },
      ports: {
        from: endpointWithoutNode(link.from),
        to: endpointWithoutNode(link.to),
      },
    }
  }

  const existing = Object.values(graph.nodes)[0]
  if (existing !== undefined) {
    return {
      graphId,
      first: { node: existing, position: positionOf(doc, graphId, existing.id) },
    }
  }
  if (opts.type === undefined || opts.type.length === 0) {
    throw new Error('the root graph has no nodes; pass --type to choose a node type')
  }
  return {
    graphId,
    first: {
      node: { id: 'headless-template' as NodeData['id'], type: opts.type, values: {} },
      position: { x: 0, y: 0 },
    },
  }
}

export const demoAddPosition = (position: Vec2): Vec2 => ({
  x: position.x + 320,
  y: position.y + 120,
})

export const planNodeAdd = (graphId: string, source: DemoNode): CommandInvocation => {
  const position = demoAddPosition(source.position)
  return {
    command: 'node.add',
    params: {
      graphId,
      type: source.node.type,
      position: { x: position.x, y: position.y },
      values: source.node.values,
    },
  }
}

export const markerEntry = (node: NodeData): readonly [string, Json] => {
  const key = Object.keys(node.values)[0] ?? 'headlessDemo'
  const current = node.values[key]
  return [key, typeof current === 'string' ? `${current} [headless]` : 1]
}

export const planMarker = (
  graphId: string,
  nodeId: string,
  source: NodeData,
): CommandInvocation => {
  const [inputId, value] = markerEntry(source)
  return {
    command: 'node.setValue',
    params: { graphId, nodeId, inputId, value },
  }
}

export const planMoves = (
  graphId: string,
  nodeId: string,
  start: Vec2,
): readonly CommandInvocation[] =>
  [20, 40, 60, 80].map((offset) => ({
    command: 'node.move',
    params: {
      graphId,
      positions: { [nodeId]: { x: start.x + offset, y: start.y } },
    },
  }))

export const planLink = (
  graphId: string,
  firstId: string,
  secondId: string,
  ports: NonNullable<DemoEditSource['ports']>,
): CommandInvocation => ({
  command: 'link.connect',
  params: {
    graphId,
    from: { node: firstId, ...ports.from },
    to: { node: secondId, ...ports.to },
  },
})

/** Plan the deterministic local-session form of the demo sequence. */
export function planDemoEdits(
  doc: WorkflowDocument,
  opts: DemoEditOptions = {},
): CommandInvocation[] {
  const source = demoEditSource(doc, opts)
  const graph = doc.graphs[source.graphId] as GraphDef
  const firstId = `n${graph.nextOrdinal}`
  const invocations: CommandInvocation[] = [planNodeAdd(source.graphId, source.first)]

  if (source.second !== undefined && source.ports !== undefined) {
    const secondId = `n${graph.nextOrdinal + 1}`
    invocations.push(planNodeAdd(source.graphId, source.second))
    invocations.push(planLink(source.graphId, firstId, secondId, source.ports))
  }

  const start = demoAddPosition(source.first.position)
  invocations.push(planMarker(source.graphId, firstId, source.first.node))
  invocations.push(...planMoves(source.graphId, firstId, start))
  return invocations
}
