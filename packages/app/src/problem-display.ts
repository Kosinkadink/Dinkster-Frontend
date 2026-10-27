import {
  documentResolver,
  diagnosticBlocksExecution,
  elabKeyOf,
  inputsOf,
  outputsOf,
  subgraphDefIdOf,
  type Diagnostic,
  type DiagnosticOrigin,
  type DiagnosticRef,
  type NodeSchema,
  type Occurrence,
  type Severity,
  type WorkflowDocument,
} from '@dinkster/core'
import type { PortProblemMap } from '@dinkster/canvas'

export interface ProblemSchemaRegistry {
  readonly resolve: (type: string) => NodeSchema | undefined
}

export type NodeProblemKind = 'error' | 'blocking-warning' | 'warning'

export interface NodeProblemModel {
  readonly kind: NodeProblemKind
  readonly diagnostics: readonly Diagnostic[]
}

export type NodeProblemMap = Readonly<Record<string, readonly NodeProblemModel[]>>

export interface ProblemProjection {
  readonly nodes: NodeProblemMap
  readonly ports: PortProblemMap
}

/** Preserve every active diagnostic source before graph projection. */
export function composeCanvasProblemDiagnostics(args: {
  readonly owned: readonly Diagnostic[]
  readonly scene: readonly Diagnostic[]
  readonly artifact?: readonly Diagnostic[]
  readonly execution?: readonly Diagnostic[]
}): readonly Diagnostic[] {
  return [...args.owned, ...args.scene, ...(args.artifact ?? []), ...(args.execution ?? [])]
}

interface DiagnosticNodeTarget {
  readonly nodeId: string
  readonly graphId?: string
  readonly instancePath?: readonly string[]
  readonly source: 'ref' | 'occurrence' | 'port'
}

export interface ResolvedNodeOccurrence {
  readonly graphId: string
  readonly graphStack: readonly string[]
  readonly instancePath: readonly string[]
  readonly nodeId: string
}

/** Resolve an occurrence-qualified node through subgraph instances. */
export function resolveNodeOccurrence(
  document: WorkflowDocument,
  occurrence: Occurrence,
): ResolvedNodeOccurrence | undefined {
  const graphStack: string[] = [document.root]
  let graphId: string = document.root
  for (const instanceId of occurrence.instancePath) {
    const node = document.graphs[graphId]?.nodes[instanceId]
    const child = node ? subgraphDefIdOf(node.type) : undefined
    if (!child || !document.graphs[child]) return undefined
    graphStack.push(child)
    graphId = child
  }
  if (!document.graphs[graphId]?.nodes[occurrence.node]) return undefined
  return {
    graphId,
    graphStack,
    instancePath: [...occurrence.instancePath],
    nodeId: occurrence.node,
  }
}

/**
 * Collect presentation node identities in priority order. Structured refs
 * remain primary; occurrence and port anchors cover compiler/runtime rows.
 */
function diagnosticNodeTargets(
  diagnostic: Diagnostic,
  document: WorkflowDocument | undefined,
): readonly DiagnosticNodeTarget[] {
  const targets: DiagnosticNodeTarget[] = []
  for (const ref of diagnostic.refs ?? []) {
    if (ref.nodeId !== undefined) targets.push({
      nodeId: ref.nodeId,
      ...(ref.graphId === undefined ? {} : { graphId: ref.graphId }),
      source: 'ref',
    })
  }
  const occurrence = diagnostic.anchor?.occurrence
  if (occurrence !== undefined) {
    const resolved = document === undefined ? undefined : resolveNodeOccurrence(document, occurrence)
    targets.push({
      nodeId: occurrence.node,
      ...(resolved === undefined ? {} : { graphId: resolved.graphId }),
      instancePath: occurrence.instancePath,
      source: 'occurrence',
    })
  } else if (diagnostic.anchor?.port !== undefined) {
    targets.push({ nodeId: diagnostic.anchor.port.node, source: 'port' })
  }
  return targets
}

/**
 * Project current document diagnostics onto nodes in one visible graph.
 * Info is omitted. Errors, explicit blocking warnings, and advisory warnings
 * get separate groups so advisory notices never look execution-blocking.
 * Refs are preferred; occurrence anchors cover compiler diagnostics.
 */
export function deriveProblemProjection(args: {
  readonly diagnostics: readonly Diagnostic[]
  readonly document?: WorkflowDocument
  readonly graphId: string
  readonly instancePath: readonly string[] | undefined
}): ProblemProjection {
  const grouped: Record<string, Record<NodeProblemKind, Diagnostic[]>> = {}
  const ports: Record<string, Record<string, NodeProblemKind>> = {}
  const rank: Readonly<Record<NodeProblemKind, number>> = { warning: 0, 'blocking-warning': 1, error: 2 }
  for (const diagnostic of args.diagnostics) {
    if (diagnostic.severity === 'info') continue
    const nodeIds = new Set<string>()
    for (const target of diagnosticNodeTargets(diagnostic, args.document)) {
      if (target.source === 'ref') {
        // Node ids are graph-local. A graph-less ref remains useful to
        // problemDisplay, but cannot soundly select a node in this view.
        if (target.graphId === args.graphId) nodeIds.add(target.nodeId)
      } else if (target.source === 'occurrence' && args.instancePath !== undefined &&
        (args.document === undefined || target.graphId === args.graphId) &&
        target.instancePath?.length === args.instancePath.length &&
        target.instancePath.every((id, index) => id === args.instancePath![index])) {
        nodeIds.add(target.nodeId)
      } else if (target.source === 'port' && args.instancePath !== undefined &&
        args.document?.graphs[args.graphId]?.nodes[target.nodeId] !== undefined) {
        // A port-only anchor has no graph identity. Qualify it only against
        // the active graph instead of scanning graph-local node ids.
        nodeIds.add(target.nodeId)
      }
    }
    const kind: NodeProblemKind = diagnostic.severity === 'error'
      ? 'error'
      : diagnosticBlocksExecution(diagnostic)
        ? 'blocking-warning'
        : 'warning'
    for (const nodeId of nodeIds) (grouped[nodeId] ??= { error: [], 'blocking-warning': [], warning: [] })[kind].push(diagnostic)

    const port = diagnostic.anchor?.port
    if (port !== undefined && args.instancePath !== undefined) {
      const occurrence = diagnostic.anchor?.occurrence
      const resolved = occurrence === undefined || args.document === undefined
        ? undefined
        : resolveNodeOccurrence(args.document, occurrence)
      const exactOccurrence = occurrence !== undefined && resolved !== undefined &&
        resolved.graphId === args.graphId && occurrence.node === port.node &&
        occurrence.instancePath.length === args.instancePath.length &&
        occurrence.instancePath.every((id, index) => id === args.instancePath![index])
      const qualifiedPortOnly = occurrence === undefined &&
        args.document?.graphs[args.graphId]?.nodes[port.node] !== undefined
      if (exactOccurrence || qualifiedPortOnly) {
        const portId = elabKeyOf({ port: port.port, ...(port.members === undefined ? {} : { members: port.members }) })
        const nodePorts = (ports[port.node] ??= {})
        const current = nodePorts[portId]
        if (current === undefined || rank[kind] > rank[current]) nodePorts[portId] = kind
      }
    }
  }
  const out: Record<string, NodeProblemModel[]> = {}
  for (const [nodeId, groups] of Object.entries(grouped)) {
    out[nodeId] = (['error', 'blocking-warning', 'warning'] as const)
      .filter((kind) => groups[kind].length > 0)
      .map((kind) => ({ kind, diagnostics: groups[kind] }))
  }
  return { nodes: out, ports }
}

/** Backward-compatible node-only view of the shared problem projection. */
export function deriveNodeProblems(args: {
  readonly diagnostics: readonly Diagnostic[]
  readonly document?: WorkflowDocument
  readonly graphId: string
  readonly instancePath: readonly string[] | undefined
}): NodeProblemMap {
  return deriveProblemProjection(args).nodes
}

const quoted = (value: string): string => `"${value}"`

const severityRank: Readonly<Record<Severity, number>> = {
  info: 0,
  warning: 1,
  error: 2,
}

function graphForRef(document: WorkflowDocument, ref: DiagnosticRef) {
  if (ref.graphId !== undefined) return document.graphs[ref.graphId]
  if (ref.nodeId === undefined) return undefined
  return Object.values(document.graphs).find((graph) => graph.nodes[ref.nodeId!])
}

function nodeLabel(ref: DiagnosticRef, nodeName: string | undefined): string | undefined {
  if (ref.nodeId === undefined) return undefined
  return nodeName && nodeName !== ref.nodeId
    ? `Node ${quoted(nodeName)} (${ref.nodeId})`
    : `Node (${ref.nodeId})`
}

function displayRef(
  document: WorkflowDocument,
  resolve: (type: string) => NodeSchema | undefined,
  ref: DiagnosticRef,
): string | undefined {
  if (ref.nodeId === undefined) return undefined
  const node = graphForRef(document, ref)?.nodes[ref.nodeId]
  const schema = node === undefined ? undefined : resolve(node.type)
  const parts = [nodeLabel(ref, node?.title ?? schema?.displayName)!]

  const portId = ref.portId ?? ref.valueKey
  if (portId !== undefined) {
    const inputs = schema === undefined ? [] : inputsOf(schema)
    const outputs = schema === undefined ? [] : outputsOf(schema)
    const input = inputs.find((port) => port.id === portId)
    const output = outputs.find((port) => port.id === portId)
    const port = ref.direction === 'output' ? (output ?? input) : (input ?? output)
    const direction = ref.direction ?? (input !== undefined ? 'input' : output !== undefined ? 'output' : 'input')
    const label = port?.displayName ?? portId
    parts.push(`${direction} ${quoted(label)}${label === portId ? '' : ` (${portId})`}`)
  }
  return parts.join(', ')
}

/**
 * Adds current document/schema names to stable diagnostic text. Diagnostics
 * without structured refs remain byte-for-byte unchanged.
 */
export function problemDisplay(
  diagnostic: Diagnostic,
  document: WorkflowDocument | undefined,
  registry: ProblemSchemaRegistry | undefined,
): string {
  if (document === undefined || registry === undefined || diagnostic.refs?.length === 0 || diagnostic.refs === undefined) {
    return diagnostic.message
  }
  const resolve = documentResolver(document, registry.resolve)
  const seen = new Set<string>()
  const labels: string[] = []
  for (const ref of diagnostic.refs) {
    const label = displayRef(document, resolve, ref)
    if (label !== undefined && !seen.has(label)) {
      seen.add(label)
      labels.push(label)
    }
  }
  return labels.length === 0 ? diagnostic.message : `${labels.join('; ')}: ${diagnostic.message}`
}

export interface ProblemGroup {
  readonly key: string
  readonly title: string
  readonly severity: Severity
  readonly diagnostics: readonly Diagnostic[]
}

export const problemSections = ['execution', 'workflow', 'upgrade', 'packs', 'collaboration'] as const
export type ProblemSection = typeof problemSections[number]

export const problemSectionForOrigin = {
  runtime: 'execution',
  validation: 'execution',
  compile: 'workflow',
  invariant: 'workflow',
  environment: 'workflow',
  import: 'upgrade',
  schema: 'packs',
  extension: 'packs',
  command: 'packs',
  collab: 'collaboration',
} as const satisfies Readonly<Record<DiagnosticOrigin, ProblemSection>>

/** Group by the action a user can take, keeping source order within each section. */
export function groupProblemDiagnostics(
  diagnostics: readonly Diagnostic[],
  document?: WorkflowDocument,
): readonly ProblemGroup[] {
  const groups: ProblemGroup[] = []
  for (const section of problemSections) {
    const entries = diagnostics.filter((diagnostic) => problemSectionForOrigin[diagnostic.origin] === section)
    if (entries.length === 0) continue
    groups.push({
      key: JSON.stringify([section, document?.lineage ?? null]),
      title: section,
      severity: entries.reduce<Severity>((worst, entry) => severityRank[entry.severity] > severityRank[worst] ? entry.severity : worst, 'info'),
      diagnostics: entries,
    })
  }
  return groups
}
