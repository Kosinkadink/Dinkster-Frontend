/**
 * Framework-free app-view row model: resolving the document's exposed
 * parameters (core format/exposed.ts) against live graphs + schemas into
 * renderable rows. Kept out of AppView.tsx so unit tests (node environment,
 * no Solid transform) can pin resolution directly - same split as
 * menu-target.ts / combo-search.ts.
 *
 * Resolution contract: an entry's inputId is the ELABORATED input id; rows
 * resolve it through elaborateInterface - fed the graph's REAL connectivity
 * (links AND nets, buildGraphConnectivity), the same facts the canvas scene
 * passes, so connectivity-dependent elaboration (ghost promotion, dynamic
 * slots) matches the graph editor exactly - and write through valueKeyOf
 * (hazard N6). `linked` uses the same connectivity, so a named-net sink is
 * read-only here just like a link-driven input (the net wins; a form edit
 * would write a dormant value). Anything that fails to resolve renders as a
 * STALE row with a remove affordance, never disappears silently.
 */

import {
  buildGraphConnectivity,
  elabInputsOf,
  elaborateInterface,
  effectiveWidgetDefault,
  exposedPreviews,
  exposedParameters,
  isCanonicalUnsafeInteger,
  occurrencesForViews,
  runtimeIdsFor,
  subgraphDefIdOf,
  valueKeyOf,
  asNodeId,
  normalizedComboOptions,
  type Connectivity,
  type CommandInvocation,
  type ElaboratedInput,
  type ExecutionScope,
  type ExposedParameter,
  type ExposedPreview,
  type AppLayoutQueueTarget,
  type Json,
  type NodeData,
  type NodeId,
  type NodeSchema,
  type RemoteSourceSpec,
  type WidgetRegistry,
  type WidgetSpec,
  type WidgetView,
  type WorkflowDocument,
} from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { selectedPreviewAssetForRows, type SelectedPreviewAsset } from './node-previews.js'

/** One exposed entry resolved against the live document + schemas. */
export type ParamRow =
  | {
      readonly kind: 'live'
      readonly entry: ExposedParameter
      readonly node: NodeData
      readonly item: ElaboratedInput
      readonly valueKey: string
      readonly label: string
      /** Node title context so identical labels stay tellable-apart. */
      readonly context: string
      readonly spec: WidgetSpec | undefined
      readonly value: Json | undefined
      /** Connection-driven inputs (link OR net sink) are not form-editable. */
      readonly linked: boolean
      /** Selector-derived value (never in node.values): read-only here. */
      readonly derived: boolean
    }
  | { readonly kind: 'stale'; readonly entry: ExposedParameter; readonly reason: string }

export type PreviewRow =
  | {
      readonly kind: 'candidate'
      readonly entry: ExposedPreview
      readonly node: NodeData
      readonly schema: NodeSchema | undefined
      readonly label: string
      readonly context: string
      readonly isSubgraph: boolean
      readonly selectedAsset: SelectedPreviewAsset | undefined
    }
  | { readonly kind: 'stale'; readonly entry: ExposedPreview; readonly reason: string }

function resolveRow(
  doc: WorkflowDocument,
  entry: ExposedParameter,
  resolve: ((type: string) => NodeSchema | undefined) | undefined,
  connectivityFor: (graphId: string) => (node: NodeId) => Connectivity,
): ParamRow {
  const def = doc.graphs[entry.graphId]
  if (!def) return { kind: 'stale', entry, reason: 'graph no longer exists' }
  const node = def.nodes[entry.nodeId]
  if (!node) return { kind: 'stale', entry, reason: 'node no longer exists' }
  const schema = resolve?.(node.type)
  if (!schema) return { kind: 'stale', entry, reason: `no schema for '${node.type}'` }
  const connectivity = connectivityFor(entry.graphId)(node.id)
  const elaborated = elaborateInterface(schema, node, connectivity)
  const item = elabInputsOf(elaborated).find((i) => i.spec.id === entry.inputId)
  if (!item) return { kind: 'stale', entry, reason: `input '${entry.inputId}' no longer exists` }
  const valueKey = valueKeyOf(item)
  const linked = connectivity.isInputConnected(
    item.address.port as string,
    item.address.members as readonly string[] | undefined,
  )
  const spec = item.spec.widget
  const stored = node.values[valueKey]
  const value = item.derivedValue ?? stored ?? (spec ? effectiveWidgetDefault(spec) : undefined)
  return {
    kind: 'live',
    entry,
    node,
    item,
    valueKey,
    label: entry.label ?? item.spec.displayName ?? entry.inputId,
    context: node.title ?? node.type,
    spec,
    value,
    linked,
    derived: item.derivedValue !== undefined,
  }
}

/**
 * All exposed entries resolved to rows, in declared order. Connectivity is
 * built once per touched graph (one pass over links and nets), not per row.
 */
export function buildParamRows(
  doc: WorkflowDocument,
  resolve: ((type: string) => NodeSchema | undefined) | undefined,
): readonly ParamRow[] {
  const cache = new Map<string, (node: NodeId) => Connectivity>()
  const connectivityFor = (graphId: string): ((node: NodeId) => Connectivity) => {
    let c = cache.get(graphId)
    if (!c) cache.set(graphId, (c = buildGraphConnectivity(doc.graphs[graphId]!)))
    return c
  }
  return exposedParameters(doc).flatMap((entry) => {
    const row = resolveRow(doc, entry, resolve, connectivityFor)
    return row.kind === 'live' && row.item.spec.hidden === true ? [] : [row]
  })
}

/** Preview entries resolved structurally; live preview capability is derived from runtime state. */
export function buildPreviewRows(
  doc: WorkflowDocument,
  resolve: ((type: string) => NodeSchema | undefined) | undefined,
  previewRendererFor: WidgetRegistry['previewRendererFor'],
): readonly PreviewRow[] {
  const connectivity = new Map<string, (node: NodeId) => Connectivity>()
  return exposedPreviews(doc).map((entry): PreviewRow => {
    const graph = doc.graphs[entry.graphId]
    if (graph === undefined) return { kind: 'stale', entry, reason: 'graph no longer exists' }
    const node = graph.nodes[entry.nodeId]
    if (node === undefined) return { kind: 'stale', entry, reason: 'node no longer exists' }
    const schema = resolve?.(node.type)
    let selectedAsset: SelectedPreviewAsset | undefined
    if (schema !== undefined) {
      let forGraph = connectivity.get(entry.graphId)
      if (forGraph === undefined) {
        forGraph = buildGraphConnectivity(graph)
        connectivity.set(entry.graphId, forGraph)
      }
      const inputs = elabInputsOf(elaborateInterface(schema, node, forGraph(node.id)))
      selectedAsset = selectedPreviewAssetForRows(
        node.values,
        inputs.flatMap((input) => input.spec.widget === undefined
          ? []
          : [{ widgetType: input.spec.widget.widgetType, valueKey: valueKeyOf(input) }]),
        previewRendererFor,
      )
    }
    const fallback = schema?.displayName ?? node.type
    return {
      kind: 'candidate',
      entry,
      node,
      schema,
      label: entry.label ?? node.title ?? fallback,
      context: node.title === undefined ? node.type : fallback === node.title ? node.type : fallback,
      isSubgraph: subgraphDefIdOf(node.type) !== undefined,
      selectedAsset,
    }
  })
}

export interface PreviewRuntimeMapping {
  /** Runtime occurrences owned directly by a definition node. */
  readonly own: (nodeId: string) => readonly string[]
  /** Own and nested occurrences represented by a definition node. */
  readonly all: (nodeId: string) => readonly string[]
}

function pathsToDefinition(doc: WorkflowDocument, targetGraphId: string): readonly (readonly string[])[] {
  const paths: string[][] = []
  const visit = (graphId: string, path: readonly string[], ancestors: ReadonlySet<string>): void => {
    if (graphId === targetGraphId) paths.push([...path])
    const graph = doc.graphs[graphId]
    if (graph === undefined) return
    for (const node of Object.values(graph.nodes)) {
      const child = subgraphDefIdOf(node.type)
      if (child === undefined || ancestors.has(child)) continue
      visit(child, [...path, node.id], new Set([...ancestors, child]))
    }
  }
  visit(doc.root, [], new Set([doc.root]))
  return paths
}

export interface AppViewQueueTargetOption extends AppLayoutQueueTarget {
  readonly label: string
  readonly context: string
}

/** Definition nodes available to authored partial-run actions. */
export function appViewQueueTargetOptions(doc: WorkflowDocument): readonly AppViewQueueTargetOption[] {
  return Object.values(doc.graphs).flatMap((graph) =>
    pathsToDefinition(doc, graph.id).length === 0
      ? []
      : Object.values(graph.nodes).flatMap((node) => subgraphDefIdOf(node.type) === undefined
          ? [{
              graphId: graph.id,
              nodeId: node.id,
              label: node.title ?? node.type,
              context: graph.name,
            }]
          : []))
}

export interface AppViewQueueScope {
  readonly scope?: ExecutionScope
  readonly missing: readonly AppLayoutQueueTarget[]
}

/** Expands definition targets to every occurrence accepted by partial compilation. */
export function appViewQueueScope(
  doc: WorkflowDocument,
  targets: readonly AppLayoutQueueTarget[],
): AppViewQueueScope {
  const occurrences: Extract<ExecutionScope, { kind: 'partial' }>['targets'][number][] = []
  const missing: AppLayoutQueueTarget[] = []
  const seen = new Set<string>()
  for (const target of targets) {
    const node = doc.graphs[target.graphId]?.nodes[target.nodeId]
    const paths = node === undefined || subgraphDefIdOf(node.type) !== undefined
      ? []
      : pathsToDefinition(doc, target.graphId)
    if (paths.length === 0) {
      missing.push(target)
      continue
    }
    for (const path of paths) {
      const occurrence = { instancePath: path.map(asNodeId), node: asNodeId(target.nodeId) }
      const key = JSON.stringify([occurrence.instancePath, occurrence.node])
      if (seen.has(key)) continue
      seen.add(key)
      occurrences.push(occurrence)
    }
  }
  return {
    ...(occurrences.length > 0 ? { scope: { kind: 'partial', targets: occurrences } as const } : {}),
    missing,
  }
}

/** Aggregates every runtime occurrence of one graph definition for App view. */
export function previewRuntimeMapping(
  doc: WorkflowDocument,
  exec: ExecutionState | undefined,
  graphId: string,
): PreviewRuntimeMapping | undefined {
  if (exec === undefined) return undefined
  const runtimeIds = new Set([
    ...Object.keys(exec.nodes),
    ...Object.keys(exec.outputs),
    ...Object.keys(exec.previews),
    ...exec.activities.map((activity) => activity.nodeId),
    ...exec.artifacts.map((artifact) => artifact.nodeId),
  ])
  const occurrences = occurrencesForViews({
    instancePaths: pathsToDefinition(doc, graphId),
    runtimeIds,
    toSource: exec.artifact?.provenance.toSource,
  })
  const own = (nodeId: string): readonly string[] => [
    ...new Set(occurrences.flatMap((mapping) => mapping.own.get(asNodeId(nodeId)) ?? [])),
  ]
  const all = (nodeId: string): readonly string[] => [
    ...new Set(occurrences.flatMap((mapping) => runtimeIdsFor(mapping, asNodeId(nodeId)))),
  ]
  return { own, all }
}

/** The exact default WidgetView selection used by the graph canvas. */
export function appViewWidgetPresentation(
  row: Extract<ParamRow, { kind: 'live' }>,
  registry: WidgetRegistry,
): { readonly view: WidgetView; readonly rows: number } | undefined {
  const spec = row.spec
  if (spec === undefined) return undefined
  const kind = registry.kind(spec.widgetType)
  if (kind === undefined) return undefined
  const viewId = kind.defaultView(spec)
  const view = registry.viewsFor(spec.widgetType).find((candidate) => candidate.id === viewId)
  if (view === undefined) return undefined
  return { view, rows: view.measure(spec).rows }
}

/** Static combo options normalized without changing their stored values. */
export const comboOptions = normalizedComboOptions

/**
 * Remote COMBO options are already bounded and validated by ScopedClient.
 * This presentation mapping preserves the provider's exact order.
 */
export function remoteComboOptions(result: readonly string[]): readonly { value: string; label: string }[] {
  return result.map((value) => ({ value, label: value }))
}

/** Fetch and normalize one remote COMBO opening, matching WidgetEditor. */
export async function fetchRemoteComboOptions(
  route: string,
  remoteChoices: (
    route: string,
    options: {
      refresh: boolean
      signal?: AbortSignal
      timeoutMs?: number
      maxRetries?: number
      refreshMs?: number
    },
  ) => Promise<readonly string[]>,
  signal?: AbortSignal,
  policy: Pick<RemoteSourceSpec, 'timeoutMs' | 'maxRetries' | 'refreshMs'> = {},
): Promise<readonly { value: string; label: string }[]> {
  return remoteComboOptions(await remoteChoices(route, {
    refresh: false,
    ...(signal ? { signal } : {}),
    ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
    ...(policy.maxRetries !== undefined ? { maxRetries: policy.maxRetries } : {}),
    ...(policy.refreshMs !== undefined ? { refreshMs: policy.refreshMs } : {}),
  }))
}

/** Whether a remote request owns the stale -> fresh controller hook. */
export function remoteComboRefreshCanAdvance(
  refresh: boolean,
  state: 'loading' | 'ready' | 'stale' | 'unavailable' | undefined,
): boolean {
  return refresh && (state === 'ready' || state === 'stale')
}

/** The only drag-reorder result: dispatch the maintained params.move command. */
export function moveExposedInvocation(entry: ExposedParameter, index: number): CommandInvocation {
  return {
    command: 'params.move',
    params: { graphId: entry.graphId, nodeId: entry.nodeId, inputId: entry.inputId, index },
  }
}

export function moveExposedPreviewInvocation(entry: ExposedPreview, index: number): CommandInvocation {
  return {
    command: 'previews.move',
    params: { graphId: entry.graphId, nodeId: entry.nodeId, index },
  }
}

export const numberAttr = (spec: WidgetSpec, key: 'min' | 'max' | 'step'): number | string | undefined => {
  const v = spec.options[key]
  return typeof v === 'number' && Number.isFinite(v) || isCanonicalUnsafeInteger(v) ? v : undefined
}
