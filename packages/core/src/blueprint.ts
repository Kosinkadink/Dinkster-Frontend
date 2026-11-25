/**
 * Blueprint materialization: turn a blueprint body (a full workflow
 * document whose ROOT graph is a boundary subgraph definition) into fresh
 * definitions ready for `subgraph.import` into a target document.
 *
 * COPY semantics by contract: every materialization allocates fresh
 * definition ids in the target document and rewrites internal '#<id>'
 * references, so the inserted subgraph has no link back to the blueprint -
 * editing the local copy never syncs anywhere. Only the root's referenced
 * cone is imported (a body may carry unreferenced defs; they stay behind).
 *
 * The body must already be a VALIDATED document (loadDocument), so this
 * function only checks blueprint-specific structure: the root exists and
 * has a boundary (a boundary is what makes a definition instantiable as a
 * node - a plain workflow is not a blueprint).
 */

import { diag, type Diagnostic } from './diagnostics.js'
import { FORMAT_VERSION, type GraphDef, type GraphViewState, type Json, type WorkflowDocument } from './format/document.js'
import type { GraphDefId, LineageId } from './ids.js'
import { subgraphDefIdOf } from './invariants.js'

/** The definition ids `rootId` reaches through '#<id>' node types, root first. */
function definitionCone(graphs: Readonly<Record<string, GraphDef>>, rootId: string): string[] {
  const cone: string[] = []
  const visited = new Set<string>()
  const visit = (defId: string): void => {
    if (visited.has(defId)) return
    visited.add(defId)
    const def = graphs[defId]
    if (!def) return // dangling ref: validated docs cannot have one; skip
    cone.push(defId)
    for (const node of Object.values(def.nodes)) {
      const ref = subgraphDefIdOf(node.type)
      if (ref !== undefined) visit(ref)
    }
  }
  visit(rootId)
  return cone
}

/**
 * The blueprint body for one subgraph node: a standalone document whose
 * root is the node's definition, carrying the definitions it uses inside
 * and their node positions. A detached copy - nothing links it back to the
 * source document.
 *
 * The values set on the node itself become the blueprint's starting values:
 * each promoted input's value is written into the inner field it is bound
 * to, which is where a placed subgraph reads its default from. Occurrence-
 * local link overlays belong to the source document's linked copies and are
 * not carried.
 */
export function blueprintFromSubgraph(
  source: WorkflowDocument,
  graphId: string,
  nodeId: string,
  lineage: LineageId,
): { readonly ok: true; readonly document: WorkflowDocument } | BlueprintRejection {
  const node = source.graphs[graphId]?.nodes[nodeId]
  const rootId = node === undefined ? undefined : subgraphDefIdOf(node.type)
  const rootDef = rootId === undefined ? undefined : source.graphs[rootId]
  if (node === undefined || rootId === undefined || rootDef?.boundary === undefined) {
    return {
      ok: false,
      diagnostics: [diag('error', 'command', 'blueprint.notSubgraph', `node '${nodeId}' is not a subgraph node with a boundary`)],
    }
  }
  const graphs: Record<string, GraphDef> = {}
  const view: Record<string, GraphViewState> = {}
  for (const defId of definitionCone(source.graphs, rootId)) {
    graphs[defId] = source.graphs[defId]!
    const gv = source.view.graphs[defId]
    if (gv !== undefined) view[defId] = gv
  }
  const innerNodes = { ...rootDef.nodes }
  for (const item of rootDef.boundary.inputs) {
    if (item.binds.kind !== 'port' || item.promoted !== true || !Object.hasOwn(node.values, item.id)) continue
    const inner = innerNodes[item.binds.node]
    if (inner === undefined) continue
    innerNodes[item.binds.node] = { ...inner, values: { ...inner.values, [item.binds.port]: node.values[item.id] as Json } }
  }
  graphs[rootId] = { ...rootDef, nodes: innerNodes }
  return {
    ok: true,
    document: {
      format: 'dinkster-workflow',
      formatVersion: FORMAT_VERSION,
      lineage,
      root: rootId as GraphDefId,
      graphs,
      view: { graphs: view },
      ...(source.environment !== undefined ? { environment: source.environment } : {}),
      meta: { title: rootDef.name },
    },
  }
}

export interface BlueprintMaterialization {
  readonly ok: true
  /** Fresh-keyed definitions for subgraph.import (root cone only). */
  readonly graphs: Readonly<Record<string, GraphDef>>
  /** Matching per-graph view state (node positions survive the copy). */
  readonly view: Readonly<Record<string, GraphViewState>>
  /** The fresh id of the instantiable root definition. */
  readonly rootId: string
}

export interface BlueprintRejection {
  readonly ok: false
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Compute fresh-keyed graph defs for inserting `blueprint`'s root subgraph
 * into `target`. Pure: allocates ids against the target's current keys;
 * dispatch the result in the SAME turn it was computed (a stale target
 * risks id collisions, which subgraph.import then rejects atomically).
 */
export function materializeBlueprint(
  target: WorkflowDocument,
  blueprint: WorkflowDocument,
): BlueprintMaterialization | BlueprintRejection {
  const rootDef = blueprint.graphs[blueprint.root]
  if (!rootDef) {
    return {
      ok: false,
      diagnostics: [diag('error', 'import', 'blueprint.rootMissing', `blueprint root graph '${blueprint.root}' not found`)],
    }
  }
  if (!rootDef.boundary) {
    return {
      ok: false,
      diagnostics: [
        diag('error', 'import', 'blueprint.noBoundary', 'blueprint root graph has no boundary; only boundary subgraphs are insertable as nodes'),
      ],
    }
  }

  // Root cone: the root def plus everything reachable through '#<id>' node
  // types. Cycles cannot occur in a validated document (no-recursion
  // invariant) but the visited set keeps this robust regardless.
  const cone = definitionCone(blueprint.graphs, blueprint.root)

  // Fresh ids: smallest unused g<n> in the target, in cone discovery order
  // (root first). Deterministic given (target, blueprint).
  const used = new Set(Object.keys(target.graphs))
  let n = 0
  const nextId = (): string => {
    while (used.has(`g${n}`)) n += 1
    const id = `g${n}`
    used.add(id)
    return id
  }
  const rename = new Map<string, string>()
  for (const oldId of cone) rename.set(oldId, nextId())

  const graphs: Record<string, GraphDef> = {}
  const view: Record<string, GraphViewState> = {}
  for (const oldId of cone) {
    const newId = rename.get(oldId)!
    const def = blueprint.graphs[oldId]!
    // Rewrite internal subgraph references; leave every other type alone
    // (unresolvable node types stay as data - the placeholder story).
    const nodes = Object.fromEntries(
      Object.entries(def.nodes).map(([nid, node]) => {
        const ref = subgraphDefIdOf(node.type)
        const mapped = ref !== undefined ? rename.get(ref) : undefined
        return [nid, mapped !== undefined ? { ...node, type: `#${mapped}` } : node]
      }),
    )
    graphs[newId] = { ...def, id: newId as GraphDefId, nodes }
    const gv = blueprint.view.graphs[oldId]
    if (gv !== undefined) view[newId] = gv
  }

  return { ok: true, graphs, view, rootId: rename.get(blueprint.root)! }
}
