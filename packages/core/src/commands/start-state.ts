/**
 * A required choice always has a stored key: the editor stores it, and a run
 * never makes one up. Storing the start key (the choice's default, else its
 * first option) keeps a saved node's rows, wires and cache key the same when
 * a pack later changes a default or reorders options. A group that grows by
 * hand stores its minimum members the same way: the node always shows them,
 * so they are not the user's to add.
 */

import type { DynamicPortState, Json, WorkflowDocument } from '../format/document.js'
import { asNodeId, isPortEndpoint, type LinkEndpoint } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import type { SchemaResolver } from '../schema/derive-boundary.js'
import { buildGraphConnectivity, DEFAULT_ELAB_BUDGET, elaborateInterface } from '../schema/elaborate.js'
import type { PatchOp } from './patch.js'
import type { TransactionBuilder } from './contract.js'

/** One node by graph and node id. */
export interface NodeAt {
  readonly graphId: string
  readonly nodeId: string
}

/**
 * Store the start key of every required choice, and the minimum members of
 * every group that grows by hand, that exist on the given nodes with nothing
 * stored. Storing one can bring another into being, so each node repeats
 * until nothing changes.
 */
export function storeStartState(tx: TransactionBuilder, resolve: SchemaResolver, nodes: Iterable<NodeAt>): void {
  for (const { graphId, nodeId } of nodes) {
    for (let pass = 0; pass < DEFAULT_ELAB_BUDGET.maxItems; pass++) {
      const graph = tx.current.graphs[graphId]
      const node = graph?.nodes[nodeId]
      if (!graph || !node || subgraphDefIdOf(node.type) !== undefined) break
      const schema = resolve(node.type)
      if (!schema) break
      const elaborated = elaborateInterface(
        schema,
        node,
        buildGraphConnectivity(graph)(asNodeId(nodeId)),
        { promoteGhosts: true },
      )
      const choices = Object.entries(elaborated.unstoredChoices ?? {})
      const minimums = Object.entries(elaborated.unstoredMinimums ?? {})
      if (choices.length === 0 && minimums.length === 0) break
      const nodePath = ['graphs', graphId, 'nodes', nodeId]
      if (node.dynamic === undefined) tx.set([...nodePath, 'dynamic'], {})
      for (const [path, key] of choices) {
        const state: DynamicPortState = { ...node.dynamic?.[path], selected: key }
        tx.set([...nodePath, 'dynamic', path], state as unknown as Json)
      }
      for (const [path, frame] of minimums) {
        const stored = node.dynamic?.[path]
        const seq = Math.max(stored?.seq ?? 0, frame.seq ?? 0)
        const state: DynamicPortState = { ...stored, members: [...(stored?.members ?? []), ...frame.members], ...(seq > 0 ? { seq } : {}) }
        tx.set([...nodePath, 'dynamic', path], state as unknown as Json)
      }
    }
  }
}

/** Every node of the document. */
export function allNodesOf(doc: WorkflowDocument): NodeAt[] {
  return Object.entries(doc.graphs).flatMap(([graphId, graph]) =>
    Object.keys(graph.nodes).map((nodeId) => ({ graphId, nodeId })))
}

/**
 * The nodes a transaction may have changed the rows of: nodes it wrote, and
 * the input ends of links it added or removed (a wire can move a leader or
 * a count formula).
 */
export function nodesChangedBy(doc: WorkflowDocument, forward: readonly PatchOp[]): NodeAt[] {
  const found = new Map<string, NodeAt>()
  const add = (graphId: string, nodeId: string): void => {
    found.set(JSON.stringify([graphId, nodeId]), { graphId, nodeId })
  }
  const addGraph = (graphId: string): void => {
    for (const nodeId of Object.keys(doc.graphs[graphId]?.nodes ?? {})) add(graphId, nodeId)
  }
  const addLink = (graphId: string, link: Json | undefined): void => {
    const to = (link as { to?: LinkEndpoint } | undefined)?.to
    if (to !== undefined && isPortEndpoint(to)) add(graphId, to.node)
  }
  for (const op of forward) {
    const [root, graphId, area, id] = op.path
    if (root !== 'graphs') continue
    if (graphId === undefined) {
      for (const graph of Object.keys(doc.graphs)) addGraph(graph)
      continue
    }
    const graph = String(graphId)
    if (area === undefined || ((area === 'nodes' || area === 'links') && id === undefined)) addGraph(graph)
    else if (area === 'nodes') add(graph, String(id))
    else if (area === 'links') {
      if (op.op !== 'remove') addLink(graph, op.path.length === 4 ? op.value : doc.graphs[graph]?.links[String(id)] as unknown as Json)
      if (op.op !== 'add') addLink(graph, op.path.length === 4 ? op.oldValue : undefined)
    }
  }
  return [...found.values()]
}
