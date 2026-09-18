/**
 * Scene overlay derivation: everything the renderer layers on top of one
 * installed scene - run states, companion values,
 * selector resolutions, replacement items, badges, previews - derived in one
 * pass from the tab's bound execution and the current view. Framework-free:
 * no reactive state, no renderer; the HOST applies the model and owns
 * scheduling (directly after a scene rebuild, and on execution/preview/
 * registry ticks). The two effects this pass can start stay behind injected
 * seams - loader.resolve may kick a preview decode and reports back through
 * the host's ticks, never through this module.
 */

import {
  BYPASSED_BADGE,
  companionText,
  DEPRECATED_BADGE,
  executionErrorBadge,
  LOG_INFO_BADGE,
  logWarningBadge,
  MUTED_BADGE,
  PROBLEM_BLOCKING_WARNING_BADGE,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  subgraphBadge,
  type CompanionMap,
  type NodeBadge,
  type NodeOutputText,
  type NodePreview,
  type OutputTextMap,
  type PortProblemMap,
  type Scene,
} from '@dinkster/canvas'
import {
  buildGraphConnectivity,
  deriveGlslMirrorBindings,
  deriveMirrorEstimates,
  elabInputsOf,
  elaborateInterface,
  isDeprecated,
  outputsOf,
  parseOccurrenceKey,
  supportsOutputRepresentation,
  effectiveWidgetDefault,
  occurrencesForView,
  runtimeIdsFor,
  subgraphDefIdOf,
  valueKeyOf,
  type CompanionSourceMap,
  type Diagnostic,
  type GraphDef,
  type Json,
  type NodeProgress,
  type NodeSchema,
  type ReplacementScanItem,
  type ValueDiagnostic,
  type WidgetRegistry,
  type WorkflowDocument,
} from '@dinkster/core'
import { imageAssetRefsOf, type DinksterValuesClient, type ExecutionLogEntry, type ExecutionState } from '@dinkster/client'
import { deriveCompanions, liveExactnessFor, recordedProducerDisplay } from './companion-display.js'
import { projectExecutionNodeStates, projectRegionIterationLabels } from './execution-projection.js'
import {
  mirrorImageEstimateIdentity,
  type MirrorImageEstimate,
  type MirrorImageEstimateRequest,
  type MirrorImageEstimator,
} from './mirror-image-previews.js'
import {
  deriveNodePreviewSurface,
  selectedPreviewAssetForRows,
  type PreviewLoader,
  type PreviewSource,
  type SelectedPreviewAsset,
} from './node-previews.js'
import type { NodeProblemMap } from './problem-display.js'
import type { ExecutedImage, ExecutedImageBatch } from './executed-image-inventory.js'

const controllerSensitiveFor = (
  artifact: NonNullable<ExecutionState['artifact']>,
  resolveSchema: ((type: string) => NodeSchema | undefined) | undefined,
) => {
  const valueSourceSensitive = Object.values(artifact.snapshot.graphs).some((graph) =>
    Object.values(graph.valueSources ?? {}).some((source) => source.controller !== undefined && source.controller !== 'fixed'))
  const controlled = new Set(Object.entries(artifact.provenance.toSource).flatMap(([runtimeId, key]) => {
    try {
      const source = parseOccurrenceKey(key)
      let graphId: string = artifact.snapshot.root
      if (!graphId || artifact.snapshot.graphs[graphId] === undefined) return [runtimeId]
      for (const instanceId of source.instancePath) {
        const instance = artifact.snapshot.graphs[graphId]?.nodes[instanceId]
        const child = instance && subgraphDefIdOf(instance.type)
        if (!child || artifact.snapshot.graphs[child] === undefined) return [runtimeId]
        graphId = child
      }
      const node = artifact.snapshot.graphs[graphId]?.nodes[source.node]
      if (!node || !resolveSchema) return [runtimeId]
      const schema = resolveSchema(node.type)
      if (!schema) return [runtimeId]
      const sensitive = schema.items.some((item) => item.kind === 'input' && item.widget?.controller === 'after_generate' &&
        (node.controllers?.[item.id] ?? item.widget.controllerInitial ?? 'randomize') !== 'fixed')
      return sensitive ? [runtimeId] : []
    } catch {
      return [runtimeId]
    }
  }))
  const provenRuntimeIds = new Set(Object.keys(artifact.provenance.toSource))
  return (runtimeId: string): boolean => {
    if (valueSourceSensitive) return true
    const pending = [runtimeId]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const id = pending.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      if (!provenRuntimeIds.has(id) || artifact.prompt[id] === undefined) return true
      if (controlled.has(id)) return true
      for (const input of Object.values(artifact.prompt[id]?.inputs ?? {})) {
        if (Array.isArray(input) && input.length === 2 && typeof input[0] === 'string' &&
            typeof input[1] === 'number') pending.push(input[0])
      }
    }
    return false
  }
}

export interface RetainedExecutionView {
  readonly execution: ExecutionState
  /** Runtime occurrences whose data was copied from an older execution. */
  readonly retainedRuntimeIds: ReadonlySet<string>
}

const digestOutputs = (outputs: ExecutionState['outputs'][string]) => {
  const retained = Object.fromEntries(Object.entries(outputs)
    .filter(([, descriptor]) => imageAssetRefsOf(descriptor).length > 0))
  return Object.keys(retained).length > 0 ? retained : undefined
}

/**
 * Fill holes in a run from older executions of the same in-memory lineage,
 * from the moment the run is queued through its terminal state, so proven
 * prior results stay visible while the run is in flight. Each runtime
 * occurrence is proved independently against one cached full comparison
 * compile. Current-run data always wins; uncertain candidates are ignored
 * rather than weakened into a cache guess.
 *
 * A partial run's own prompt nodes were explicitly requested to recompute
 * and stay blank; a WHOLE run's prompt covers every node, so its occurrences
 * are filled until the run reports each one itself.
 */
export function retainProvenExecution(
  current: ExecutionState,
  executions: readonly ExecutionState[],
  live: NonNullable<ExecutionState['artifact']> | undefined,
  instancePath: readonly string[] | undefined,
  resolveSchema?: ((type: string) => NodeSchema | undefined) | undefined,
): RetainedExecutionView {
  const currentArtifact = current.artifact
  const unchanged = (): RetainedExecutionView => ({ execution: current, retainedRuntimeIds: new Set() })
  if (!live || !currentArtifact || !instancePath) return unchanged()
  if (live.connection !== current.ref.connection || currentArtifact.connection !== current.ref.connection) return unchanged()
  if (live.snapshot.lineage !== currentArtifact.snapshot.lineage || live.schemaHash !== currentArtifact.schemaHash) return unchanged()

  const nodes = { ...current.nodes }
  const outputs = { ...current.outputs }
  const previews = { ...current.previews }
  const idsFor = (artifact: NonNullable<ExecutionState['artifact']>) => {
    const occurrences = occurrencesForView({
      instancePath,
      runtimeIds: Object.keys(artifact.prompt),
      toSource: artifact.provenance.toSource,
    })
    return new Set([...occurrences.own.values(), ...occurrences.inner.values()].flat())
  }
  const liveIds = idsFor(live)
  const liveControllerSensitive = controllerSensitiveFor(live, resolveSchema)
  // Only a partial run's prompt blocks retention: those nodes were requested
  // to recompute. A whole run's prompt is every node, so blocking on it
  // would blank all prior proven previews at queue time.
  const requestedIds = currentArtifact.scope.kind === 'partial'
    ? new Set(Object.keys(currentArtifact.prompt))
    : new Set<string>()
  const occupied = new Set([
    ...Object.keys(current.nodes),
    ...Object.keys(current.outputs),
    ...Object.keys(current.previews),
  ])
  const selected = new Set<string>()
  const candidates = executions
    .filter((candidate) => candidate.key !== current.key && candidate.queuedAt < current.queuedAt)
    .sort((a, b) => b.queuedAt - a.queuedAt)

  for (const candidate of candidates) {
    const ran = candidate.artifact
    if (!ran || candidate.status !== 'completed') continue
    if (candidate.ref.connection !== current.ref.connection || ran.connection !== current.ref.connection) continue
    if (ran.snapshot.lineage !== live.snapshot.lineage) continue
    const exact = liveExactnessFor(live, ran)
    if (!exact) continue
    const ranControllerSensitive = controllerSensitiveFor(ran, resolveSchema)
    const candidateIds = idsFor(ran)
    const runtimeIds = new Set([
      ...Object.keys(candidate.nodes),
      ...Object.keys(candidate.outputs),
      ...Object.keys(candidate.previews),
    ])
    for (const runtimeId of runtimeIds) {
      if (requestedIds.has(runtimeId) || occupied.has(runtimeId) || selected.has(runtimeId) ||
          !liveIds.has(runtimeId) || !candidateIds.has(runtimeId) ||
          live.provenance.toSource[runtimeId] === undefined ||
          live.provenance.toSource[runtimeId] !== ran.provenance.toSource[runtimeId] ||
          liveControllerSensitive(runtimeId) || ranControllerSensitive(runtimeId) || !exact(runtimeId)) continue
      const priorNode = candidate.nodes[runtimeId]
      const resolvedNode = priorNode?.state === 'done' || priorNode?.state === 'cached' ? priorNode : undefined
      if (priorNode !== undefined && resolvedNode === undefined) continue
      if (resolvedNode !== undefined) {
        nodes[runtimeId] = { ...priorNode, state: 'cached' }
      }
      const priorOutputs = candidate.outputs[runtimeId]
      // Only content-addressed outputs are safe to carry across runs among
      // recorded outputs: V1 filename URLs can be recycled by the backend, so
      // retaining them could display different bytes under an old identity.
      // The loader will derive the cached preview from digest.
      if (current.nodes[runtimeId] === undefined && current.previews[runtimeId] === undefined &&
          outputs[runtimeId] === undefined && priorOutputs !== undefined) {
        const safe = digestOutputs(priorOutputs)
        if (safe) outputs[runtimeId] = safe
      }
      if (nodes[runtimeId] === undefined && outputs[runtimeId] !== undefined) nodes[runtimeId] = { state: 'cached' }
      // Preview frames hold their payload bytes in memory, so a retained
      // frame always shows exactly the bytes received for this occurrence.
      const priorFrame = candidate.previews[runtimeId]
      if (nodes[runtimeId] !== undefined && previews[runtimeId] === undefined && priorFrame !== undefined) {
        previews[runtimeId] = priorFrame
      }
      if (nodes[runtimeId] !== undefined || outputs[runtimeId] !== undefined) selected.add(runtimeId)
    }
  }
  if (selected.size === 0) return unchanged()
  return { execution: { ...current, nodes, outputs, previews }, retainedRuntimeIds: selected }
}

/** One derivation pass, ready for the host to install on the renderer. */
export interface SceneOverlayModel {
  /** Per scene-node run state (occurrence-projected); {} without execution. */
  readonly states: Readonly<Record<string, NodeProgress>>
  /** node id -> valueKey -> display, for renderer.setCompanions. */
  readonly companions: CompanionMap
  /** Driven inputs of the CURRENT graph (read-only widget guard). */
  readonly companionSources: CompanionSourceMap
  /**
   * Runtime ids a document node's OWN occurrence holds in this view;
   * undefined when navigation provenance is untrustworthy (occurrence-keyed
   * consumers, e.g. the lens context, must abstain rather than guess).
   */
  readonly ownRuntimeIds: ((nodeId: string) => readonly string[]) | undefined
  /** Recorded selector choices (frozen tabs only); undefined = none. */
  readonly selectorResolutions: Map<string, string> | undefined
  /** Replacement scan items of the current graph, keyed by node id. */
  readonly replaceItems: Map<string, ReplacementScanItem>
  readonly badges: Readonly<Record<string, NodeBadge[]>>
  /**
   * Chronological run log records attributed to each scene node in this
   * view (own + nested occurrences); feeds bottom-badge popovers.
   */
  readonly runLogsByNode: ReadonlyMap<string, readonly ExecutionLogEntry[]>
  /**
   * Run error report entries anchored to each scene node in this view; the
   * single projection behind the bottom error badge, its popover, and its
   * tooltip.
   */
  readonly runErrorsByNode: ReadonlyMap<string, readonly Diagnostic[]>
  readonly portProblems: PortProblemMap
  readonly previews: Readonly<Record<string, NodePreview>>
  /** Scene node -> source authority for host-owned media element failures. */
  readonly previewSources: Readonly<Record<string, PreviewSource>>
  readonly executedImages: Readonly<Record<string, ExecutedImagePreview>>
  /** Selected input previews that actually won source precedence. */
  readonly selectedInputPreviews: Readonly<Record<string, SelectedInputPreview>>
  /** Standard-view text and scalar result surfaces; image previews take precedence. */
  readonly outputTexts: OutputTextMap
}

export interface ExecutedImagePreview {
  readonly key: string
  readonly images: readonly ExecutedImage[]
  readonly batch?: ExecutedImageBatch
  readonly refusal?: string
  readonly index: number
  readonly count: number
  readonly mediaKind?: 'image' | 'video' | 'audio' | 'model3d'
}

export interface SelectedInputPreview {
  readonly name: string
  readonly count: number
  readonly preview: NodePreview
}

/** First selected asset claimed by a registered preview renderer, if any. */
export function selectedPreviewAssetForNode(
  node: Scene['nodes'][number],
  previewRendererFor: WidgetRegistry['previewRendererFor'],
): SelectedPreviewAsset | undefined {
  if (node.layout === undefined) return undefined
  return selectedPreviewAssetForRows(
    node.node.values,
    node.layout.rows.flatMap((row) => row.kind === 'widget'
      ? [{ widgetType: row.spec.widgetType, valueKey: row.valueKey }]
      : []),
    previewRendererFor,
  )
}

/** First supported output representation satisfied by this node's stored state. */
export function representedPreviewAssetForNode(
  node: Scene['nodes'][number],
  schema: NodeSchema,
  previewRendererFor: WidgetRegistry['previewRendererFor'],
): SelectedPreviewAsset | undefined {
  if (node.layout === undefined) return undefined
  for (const output of outputsOf(schema)) {
    const represents = output.represents
    if (!supportsOutputRepresentation(represents)) continue
    if (represents.applies !== undefined && !Object.entries(represents.applies).every(([comboId, values]) => {
      const selected = node.node.dynamic?.[comboId]?.selected
      return selected !== undefined && values.includes(selected)
    })) continue
    const selected = selectedPreviewAssetForRows(
      node.node.values,
      node.layout.rows.flatMap((row) =>
        row.kind === 'widget' && row.inputId === represents.input
          ? [{ widgetType: row.spec.widgetType, valueKey: row.valueKey }]
          : []),
      previewRendererFor,
    )
    if (selected?.mediaKind === 'image') return { ...selected, outputId: output.id }
  }
  return undefined
}

/** Mirrored nodes in dependency order; cyclic mirror components are omitted. */
function orderedMirrorNodeIds(bindings: ReturnType<typeof deriveGlslMirrorBindings>): readonly string[] {
  const indegree = new Map<string, number>()
  const downstream = new Map<string, string[]>()
  for (const nodeId of bindings.keys()) indegree.set(nodeId, 0)
  for (const [nodeId, binding] of bindings) {
    const dependencies = new Set(
      binding.images.map((image) => image.driver.node).filter((driver) => bindings.has(driver)),
    )
    indegree.set(nodeId, dependencies.size)
    for (const driver of dependencies) {
      const dependents = downstream.get(driver) ?? []
      dependents.push(nodeId)
      downstream.set(driver, dependents)
    }
  }
  const ordered = [...indegree].filter(([, degree]) => degree === 0).map(([nodeId]) => nodeId)
  for (let index = 0; index < ordered.length; index++) {
    for (const dependent of downstream.get(ordered[index]!) ?? []) {
      const degree = indegree.get(dependent)! - 1
      indegree.set(dependent, degree)
      if (degree === 0) ordered.push(dependent)
    }
  }
  return ordered
}

/** Exact output a node-level image mirror represents, when unambiguous. */
function mirroredImageOutputId(schema: NodeSchema): string | undefined {
  const imageOutputs = outputsOf(schema).filter((output) =>
    output.type.kind === 'concrete' && output.type.name === 'dinkster.image' && output.isList !== true)
  return imageOutputs.length === 1 ? imageOutputs[0]!.id : undefined
}

export function deriveSceneOverlays(args: {
  readonly scene: Scene
  /** The tab's BOUND execution (frozen pin or lineage latest). */
  readonly exec: ExecutionState | undefined
  readonly graphId: string
  readonly doc: WorkflowDocument | undefined
  readonly def: GraphDef | undefined
  /** Undefined means navigation provenance is untrustworthy: never guess. */
  readonly instancePath: readonly string[] | undefined
  /** Frozen tab: the document is the execution's snapshot. */
  readonly frozen: boolean
  /** Live-tab exactness oracle (liveExactnessFor); undefined = stale. */
  readonly exactProducer: ((runtimeId: string) => boolean) | undefined
  /** Runtime occurrences explicitly retained from older executions. */
  readonly retainedRuntimeIds?: ReadonlySet<string> | undefined
  /** Replacement scan of the tab's document; pass [] for frozen tabs. */
  readonly replacements: readonly ReplacementScanItem[]
  /** Current compile + widget/solver diagnostics projected onto this view. */
  readonly nodeProblems?: NodeProblemMap
  /** Nodes whose runtime error badge the user dismissed for THIS run. */
  readonly dismissedErrorNodes?: ReadonlySet<string>
  readonly portProblems?: PortProblemMap
  readonly resolveSchema: ((type: string) => NodeSchema | undefined) | undefined
  /**
   * Locally evaluate schema-declared expression mirrors and display the
   * results as companion estimates (execution.mirrorPreviews setting).
   * A stored node.mirrorPreviews override wins over this for that node.
   * Frozen tabs never estimate: their document is the run's snapshot.
   */
  readonly mirrorPreviews?: boolean
  /**
   * GPU estimate cache for schema-declared glsl mirrors (same setting and
   * frozen-tab rules as expression estimates); undefined = no image
   * estimates.
   */
  readonly imageEstimator?: MirrorImageEstimator
  readonly previewRendererFor: WidgetRegistry['previewRendererFor']
  readonly loader: PreviewLoader
  readonly outputPreviewKeyPrefix?: string
  readonly outputPreviewIndex?: (key: string) => number
  /** Native peek client for terminal runs; undefined = no peeking. */
  readonly values: DinksterValuesClient | undefined
}): SceneOverlayModel {
  const { scene, exec, graphId: gid, instancePath } = args

  // Occurrence mapping for the CURRENT view: which runtime ids each scene
  // node owns given the instance path the user navigated. The artifact's
  // provenance is authoritative when present; parsing the occurrence-key
  // grammar covers artifact-less (reconciled) runs. An unknown path
  // (desynced navigation) yields no mapping and every occurrence-keyed
  // overlay abstains rather than guessing which instance of a
  // multiply-instantiated def is meant.
  const occ =
    exec && instancePath !== undefined
      ? occurrencesForView({
          instancePath,
          runtimeIds: new Set([
            ...Object.keys(exec.nodes),
            ...Object.keys(exec.outputs),
            ...Object.keys(exec.previews),
            ...exec.activities.map((activity) => activity.nodeId),
            ...exec.artifacts.map((artifact) => artifact.nodeId),
            ...exec.logs.flatMap((entry) => entry.runtimeNodeId === undefined ? [] : [entry.runtimeNodeId]),
            ...(exec.valueDiagnostics ?? []).map((diagnostic) => diagnostic.nodeId),
          ]),
          toSource: exec.artifact?.provenance.toSource,
        })
      : undefined
  /** Runtime ids of a document node's OWN occurrence in this view. */
  const ownRuntimeIds = occ ? (nodeId: string) => occ.own.get(nodeId) ?? [] : undefined

  const states = exec
    ? projectExecutionNodeStates({
        states: exec.nodes,
        scene,
        instancePath,
        toSource: exec.artifact?.provenance.toSource,
      })
    : {}
  const regionIterationLabels = exec
    ? projectRegionIterationLabels({
        regions: exec.regions ?? {},
        states: exec.nodes,
        scene,
        instancePath,
        toSource: exec.artifact?.provenance.toSource,
      })
    : {}

  // Run log attribution: one pass over the bounded log buffer, through the
  // inverted occurrence map (runtime id -> scene node, nested occurrences
  // roll up to their subgraph-instance node), keeps the per-node slices the
  // bottom badges and their popovers read chronological (logs sort by seq).
  const sceneNodeOfRuntime = new Map<string, string>()
  if (occ !== undefined) {
    for (const [sceneNodeId, ids] of occ.own) for (const id of ids) sceneNodeOfRuntime.set(id, sceneNodeId)
    for (const [sceneNodeId, ids] of occ.inner) for (const id of ids) sceneNodeOfRuntime.set(id, sceneNodeId)
  }
  const mediaDiagnosticsByNode = new Map<string, ValueDiagnostic[]>()
  for (const diagnostic of exec?.valueDiagnostics ?? []) {
    const nodeId = sceneNodeOfRuntime.get(diagnostic.nodeId)
    if (nodeId === undefined) continue
    const entries = mediaDiagnosticsByNode.get(nodeId) ?? []
    entries.push(diagnostic)
    mediaDiagnosticsByNode.set(nodeId, entries)
  }
  const runLogsByNode = new Map<string, ExecutionLogEntry[]>()
  if (exec !== undefined) {
    for (const entry of exec.logs) {
      if (entry.runtimeNodeId === undefined) continue
      const sceneNodeId = sceneNodeOfRuntime.get(entry.runtimeNodeId)
      if (sceneNodeId === undefined) continue
      const list = runLogsByNode.get(sceneNodeId)
      if (list === undefined) runLogsByNode.set(sceneNodeId, [entry])
      else list.push(entry)
    }
  }
  // Error diagnostics anchored to each scene node of this view: the anchor
  // names a root occurrence, so the node visible HERE is the next
  // instance-path segment under the navigated path (the anchor node at the
  // leaf). This one projection is the ONLY driver of the bottom error badge
  // and feeds its popover details and tooltip - all views over the job error
  // report, never a second error channel (Dinkster issue #368).
  const runErrorsByNode = new Map<string, Diagnostic[]>()
  if (exec !== undefined && instancePath !== undefined) {
    for (const d of exec.errors) {
      if (d.severity !== 'error') continue
      const anchor = d.anchor?.occurrence
      if (anchor === undefined) continue
      const path = anchor.instancePath
      if (path.length < instancePath.length) continue
      if (!instancePath.every((segment, i) => path[i] === segment)) continue
      const visible = path.length > instancePath.length ? path[instancePath.length]! : anchor.node
      const list = runErrorsByNode.get(visible)
      if (list === undefined) runErrorsByNode.set(visible, [d])
      else list.push(d)
    }
  }

  // Resolve tap defaults from the elaborated interface, not only top-level
  // schema items: a persisted dynamic member is a real widget source too.
  // Cache one elaboration per source node for this overlay pass.
  const tapDefaults = new Map<string, ReadonlyMap<string, Json | undefined>>()
  let connectivity: ReturnType<typeof buildGraphConnectivity> | undefined
  const tapValueOf = (nodeId: string, inputId: string) => {
    let defaults = tapDefaults.get(nodeId)
    if (defaults === undefined) {
      const resolved = new Map<string, Json | undefined>()
      const node = args.def?.nodes[nodeId]
      const schema = node === undefined ? undefined : args.resolveSchema?.(node.type)
      if (node !== undefined && schema !== undefined) {
        const items = elabInputsOf(elaborateInterface(
          schema,
          node,
          (connectivity ??= buildGraphConnectivity(args.def!))(node.id),
          { promoteGhosts: false },
        ))
        for (const item of items) {
          if (item.spec.widget !== undefined) resolved.set(valueKeyOf(item), effectiveWidgetDefault(item.spec.widget))
        }
      }
      defaults = resolved
      tapDefaults.set(nodeId, defaults)
    }
    return defaults.get(inputId)
  }

  // Companion (propagated) values: every link/net-driven widget row displays
  // the value it WOULD execute with, read-only - literals from the document,
  // producer scalars from the tab's BOUND execution's inline output
  // summaries (never "latest globally"). Provenance and depth rules live in
  // deriveCompanions.

  // Mirror estimates: locally computed per-output scalars for nodes whose
  // schema declares a supported expression mirror (display only, fail-soft).
  // The global setting is the default; a stored node.mirrorPreviews override
  // wins for that node, so derivation runs when anything can estimate and
  // each node's effective value gates its own estimate.
  const nodeMirrorsOn = (nodeId: string): boolean =>
    args.def?.nodes[nodeId]?.mirrorPreviews ?? args.mirrorPreviews === true
  const anyMirrorsOn = args.mirrorPreviews === true ||
    (args.def !== undefined && Object.values(args.def.nodes).some((n) => n.mirrorPreviews === true))
  const recordedProducerArgs = {
    execNodes: exec?.nodes,
    frozen: args.frozen,
    runtimeIdsOf: ownRuntimeIds,
    exactProducer: args.exactProducer,
    retainedRuntimeIds: args.retainedRuntimeIds,
    ...(exec?.artifact?.provenance.outputAliases !== undefined
      ? { outputAliases: exec.artifact.provenance.outputAliases }
      : {}),
  }
  const currentProducerValue = (nodeId: string, outputId: string): Json | undefined => {
    const display = recordedProducerDisplay(recordedProducerArgs, nodeId, outputId, true)
    return display?.stale === true ? undefined : display?.value
  }
  const estimates =
    anyMirrorsOn && !args.frozen && args.def !== undefined && args.resolveSchema !== undefined
      ? deriveMirrorEstimates(args.def, args.resolveSchema, {
          enabled: nodeMirrorsOn,
          producerValue: currentProducerValue,
        })
      : undefined

  const derived = deriveCompanions({
    def: args.def,
    ...recordedProducerArgs,
    tapValueOf,
    resolveSchema: args.resolveSchema,
    estimates,
  })

  // Frozen views show the selector branches that ACTUALLY ran: the
  // artifact's recorded choices are authoritative (a random policy must
  // display its recorded roll, never a fresh one). Live tabs never get
  // resolutions - their document is editable and the policy badge already
  // tells the truth about the NEXT run.
  let selectorResolutions: Map<string, string> | undefined
  if (args.frozen && exec?.artifact) {
    const resolutions = new Map<string, string>()
    for (const c of exec.artifact.choices ?? []) {
      if (c.graph === gid) resolutions.set(c.selector, c.candidate)
    }
    if (resolutions.size > 0) selectorResolutions = resolutions
  }

  // Deprecation/replacement: the caller scans live tabs only (frozen
  // snapshots are read-only history - upgrading them would falsify the
  // record); this pass filters to the current graph.
  const replaceItems = new Map<string, ReplacementScanItem>()
  for (const item of args.replacements) {
    if (item.graphId === gid) replaceItems.set(item.nodeId, item)
  }

  const badges: Record<string, NodeBadge[]> = {}
  for (const n of scene.nodes) {
    const list: NodeBadge[] = []
    const s = n.isSubgraph ? undefined : args.resolveSchema?.(n.node.type)
    // Bottom lane, left to right: error, warning, info. The error tab is the
    // ONE visual for the job error report (rider on Dinkster #368: errors are
    // never a log level); dismissal hides it for this run only.
    const runErrors = runErrorsByNode.get(n.id)
    if (runErrors !== undefined && args.dismissedErrorNodes?.has(n.id) !== true) {
      list.push(executionErrorBadge(runErrors.length))
    }
    const nodeLogs = runLogsByNode.get(n.id)
    if (nodeLogs !== undefined) {
      const warnings = nodeLogs.reduce((total, entry) => entry.level === 'warning' ? total + 1 : total, 0)
      if (warnings > 0) list.push(logWarningBadge(warnings))
      if (nodeLogs.length > warnings) list.push(LOG_INFO_BADGE)
    }
    for (const diagnostic of mediaDiagnosticsByNode.get(n.id) ?? []) {
      const port = diagnostic.code === 'alpha_dropped' ? diagnostic.outputId : diagnostic.inputId
      const id = `core.media.${diagnostic.code}.${diagnostic.nodeId}.${port}`
      if (list.some((badge) => badge.id === id)) continue
      list.push({
        id,
        glyph: `${diagnostic.code === 'alpha_dropped' ? 'Alpha dropped' : 'Mask polarity'}: ${port}`,
        variant: 'label',
        placement: 'below',
        interactive: false,
        color: '#8a6d1f',
      })
    }
    for (const problem of args.nodeProblems?.[n.id] ?? []) {
      // Execution errors already own the runtime error badge + its
      // runtime-details popover. Keep mixed error groups, but do not
      // duplicate a pure runtime group as a second document-error chip.
      if (runErrorsByNode.has(n.id) && problem.kind === 'error' &&
        problem.diagnostics.length > 0 && problem.diagnostics.every((d) => d.origin === 'runtime')) continue
      list.push(problem.kind === 'error'
        ? PROBLEM_ERROR_BADGE
        : problem.kind === 'blocking-warning'
          ? PROBLEM_BLOCKING_WARNING_BADGE
          : PROBLEM_WARNING_BADGE)
    }
    if (n.isSubgraph) {
      const defId = subgraphDefIdOf(n.node.type)
      const occurrences = defId === undefined || args.doc === undefined ? 1 : Object.values(args.doc.graphs).reduce((count, graph) =>
        count + Object.values(graph.nodes).filter((node) => subgraphDefIdOf(node.type) === defId).length, 0)
      list.push(subgraphBadge(occurrences))
    }
    else if (replaceItems.has(n.id) || (s !== undefined && isDeprecated(s))) list.push(DEPRECATED_BADGE)
    if (n.node.mode === 'muted') list.push(MUTED_BADGE)
    else if (n.node.mode === 'bypassed') list.push(BYPASSED_BADGE)
    const iterationLabel = regionIterationLabels[n.id]
    if (iterationLabel !== undefined) {
      list.push({
        id: 'core.region.iteration',
        glyph: iterationLabel,
        variant: 'label',
        interactive: false,
        color: '#315d73',
      })
    }
    if (list.length > 0) badges[n.id] = list
  }

  // In-node previews: decoded imagery or explicit loading/failure state;
  // resolve kicks decodes for
  // misses (the host's preview tick re-derives when one lands).
  const previews: Record<string, NodePreview> = {}
  const previewSources: Record<string, PreviewSource> = {}
  const executedImages: Record<string, ExecutedImagePreview> = {}
  const selectedInputPreviews: Record<string, SelectedInputPreview> = {}
  const outputTexts: Record<string, NodeOutputText> = {}
  for (const n of scene.nodes) {
    const runtimeIds = occ ? runtimeIdsFor(occ, n.id) : []
    const schema = n.isSubgraph ? undefined : args.resolveSchema?.(n.node.type)
    const representedAsset = schema !== undefined && !args.frozen && nodeMirrorsOn(n.id)
      ? representedPreviewAssetForNode(n, schema, args.previewRendererFor)
      : undefined
    const surface = deriveNodePreviewSurface({
      nodeId: n.id,
      isSubgraph: n.isSubgraph,
      schema,
      exec,
      runtimeIds,
      runtimeIdsOf: ownRuntimeIds,
      running: states[n.id]?.state === 'running',
      frozen: args.frozen,
      exactProducer: args.exactProducer,
      ...(args.retainedRuntimeIds === undefined ? {} : { retainedRuntimeIds: args.retainedRuntimeIds }),
      companionSources: derived.sources,
      values: args.values,
      selectedAsset: representedAsset ?? selectedPreviewAssetForNode(n, args.previewRendererFor),
      loader: args.loader,
      outputKey: `${args.outputPreviewKeyPrefix ?? ''}\u0000${exec?.key ?? 'none'}\u0000${gid}\u0000${JSON.stringify(instancePath ?? [])}\u0000${n.id}`,
      ...(args.outputPreviewIndex === undefined ? {} : { outputIndex: args.outputPreviewIndex }),
    })
    if (surface.preview !== undefined) previews[n.id] = surface.preview
    if (surface.source !== undefined) previewSources[n.id] = surface.source
    if (surface.executedOutput !== undefined) executedImages[n.id] = surface.executedOutput
    if (surface.selectedInput !== undefined) selectedInputPreviews[n.id] = surface.selectedInput
    if (surface.text !== undefined) outputTexts[n.id] = surface.text
    const estimate = estimates?.get(n.id)
    const hasCurrentOutput = estimate !== undefined && schema !== undefined && outputsOf(schema).some((output) =>
      currentProducerValue(n.id, output.id) !== undefined)
    if (
      surface.preview === undefined && surface.text === undefined &&
      estimate !== undefined && !hasCurrentOutput
    ) {
      if (estimate.error !== undefined) {
        outputTexts[n.id] = { text: `Preview error\n${estimate.error}`, error: true }
      } else {
        const lines = (schema === undefined ? [] : outputsOf(schema)).flatMap((output) => {
          const value = estimate.outputs[output.id]
          return value === undefined ? [] : [`${output.id}: ${companionText(value)}`]
        })
        if (lines.length > 0) {
          outputTexts[n.id] = { text: ['Estimated locally', ...lines].join('\n'), estimate: true }
        }
      }
    }
  }

  // Image estimates: GPU-computed previews for nodes whose schema declares a
  // supported glsl mirror, fed by the SINGLE upstream node's attributed
  // decoded preview (display only, fail-soft). Mirrored nodes run in
  // topological order, so an attributed estimate can feed the downstream
  // suffix in the same pass. Same gating as expression estimates. An
  // estimate applies only where no current-proof preview exists (absent or
  // retained-'cached' panels).
  if (
    args.imageEstimator !== undefined && anyMirrorsOn && !args.frozen &&
    args.def !== undefined && args.resolveSchema !== undefined
  ) {
    const bindings = deriveGlslMirrorBindings(args.def, args.resolveSchema)
    const sceneNodes = new Map(scene.nodes.map((node) => [node.id, node]))
    for (const nodeId of orderedMirrorNodeIds(bindings)) {
      const n = sceneNodes.get(nodeId)
      if (n === undefined) continue
      if (n.isSubgraph) continue
      if (!nodeMirrorsOn(n.id)) continue
      const existing = previews[n.id]
      if (existing !== undefined && existing.state !== 'cached') continue
      const binding = bindings.get(n.id)
      if (binding === undefined || binding.images.length !== 1) continue
      const driverNode = binding.images[0]!.driver.node
      const upstream = previews[driverNode]
      const upstreamSource = previewSources[driverNode]
      if (
        upstream === undefined || upstreamSource === undefined ||
        (upstream.kind !== undefined && upstream.kind !== 'image') ||
        upstream.image === undefined || upstream.animation !== undefined ||
        upstream.status !== undefined
      ) continue
      // The binding names the exact producer output, but the producer's
      // panel shows node-wide imagery. Only a source attributed to exactly
      // the driven output may feed the estimate; unattributed imagery
      // (selected input assets, artifacts, live frames, peek renditions)
      // carries no output-level provenance, so it fails closed. Output
      // cardinality is no proof: a one-output node's panel can show its
      // selected input asset, which is not the produced output.
      if (upstreamSource.outputId !== binding.images[0]!.driver.output) continue
      const width = upstream.width ?? 0
      const height = upstream.height ?? 0
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) continue
      // Fail-soft boundary: a broken estimator loses one node's estimate,
      // never the whole overlay derivation.
      let estimate: MirrorImageEstimate | undefined
      const request: MirrorImageEstimateRequest = {
        nodeId: n.id,
        nodeType: n.node.type,
        binding,
        image: upstream.image,
        imageKey: upstreamSource.key,
        width,
        height,
      }
      try {
        estimate = args.imageEstimator.estimate(request)
      } catch {
        continue
      }
      if (estimate === undefined) continue
      const preview: NodePreview = {
        kind: 'image',
        image: estimate.image,
        width: estimate.width,
        height: estimate.height,
        state: 'estimate',
      }
      previews[n.id] = preview
      const schema = args.resolveSchema(n.node.type)
      const outputId = schema === undefined ? undefined : mirroredImageOutputId(schema)
      if (outputId !== undefined) {
        previewSources[n.id] = {
          key: `mirror:${mirrorImageEstimateIdentity(request)}`,
          mediaKind: 'image',
          outputId,
          load: () => Promise.resolve(preview),
        }
      }
    }
  }

  return {
    states,
    companions: derived.companions,
    companionSources: derived.sources,
    ownRuntimeIds,
    selectorResolutions,
    replaceItems,
    badges,
    runLogsByNode,
    runErrorsByNode,
    portProblems: args.portProblems ?? {},
    previews,
    previewSources,
    executedImages,
    selectedInputPreviews,
    outputTexts,
  }
}
