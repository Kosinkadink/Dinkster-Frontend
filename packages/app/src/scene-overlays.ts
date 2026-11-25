/**
 * Scene overlay derivation: everything the renderer layers on top of one
 * installed scene - run states, companion values,
 * selector resolutions, badges, previews - derived in one
 * pass from the tab's bound execution and the current view. Framework-free:
 * no reactive state, no renderer; the HOST applies the model and owns
 * scheduling (directly after a scene rebuild, and on execution/preview/
 * registry ticks). The two effects this pass can start stay behind injected
 * seams - loader.resolve may kick a preview decode and reports back through
 * the host's ticks, never through this module.
 */

import {
  companionText,
  DEPRECATED_BADGE,
  executionBlockedBadge,
  executionExpandedBadge,
  executionErrorBadge,
  isCanvasIconName,
  LAST_RUN_BADGE,
  LOG_INFO_BADGE,
  logWarningBadge,
  mediaDiagnosticBadge,
  PROBLEM_ERROR_BADGE,
  PROBLEM_WARNING_BADGE,
  problemBadge,
  regionIterationBadge,
  subgraphBadge,
  UNAVAILABLE_BADGE,
  type CompanionMap,
  type NodeBadge,
  type NodeOutputText,
  type NodePreview,
  type OutputTextMap,
  type ProblemKind,
  type RowProblemMap,
  type Scene,
} from '@dinkster/canvas'
import {
  asNodeId,
  asPortId,
  buildGraphConnectivity,
  diag,
  deriveGlslMirrorBindings,
  deriveMirrorEstimates,
  documentPrimitiveResolver,
  elabInputsOf,
  elaborateInterface,
  isDeprecated,
  outputsOf,
  parseOccurrenceKey,
  primitiveOf,
  supportsOutputRepresentation,
  withPrimitiveValue,
  effectiveWidgetDefault,
  documentIdentityOf,
  occurrencesForView,
  runtimeIdsFor,
  subgraphDefIdOf,
  valueKeyOf,
  type CompanionSourceMap,
  type Diagnostic,
  type GraphDef,
  type Json,
  type NodeData,
  type NodeId,
  type NodeProgress,
  type NodeSchema,
  type NodeDecoration,
  type NodeDecorationContribution,
  type ValueDiagnostic,
  type WidgetRegistry,
  type WorkflowDocument,
  inputsOf,
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
      const sensitive = inputsOf(schema).some((item) => item.widget?.controller === 'after_generate' &&
        (node.controllers?.[item.id] ?? item.widget.controllerInitial ?? 'randomize') !== 'fixed')
      return sensitive ? [runtimeId] : []
    } catch {
      return [runtimeId]
    }
  }))
  const provenRuntimeIds = new Set(Object.keys(artifact.provenance.toSource))
  return (runtimeId: string): boolean => {
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

type RecordedAutomatic = NonNullable<ExecutionState['automaticValues']>[number]

/** Calls `visit` for each automatic row of the viewed scene that the run recorded a value for. */
function eachRecordedAutomaticRow(
  scene: Scene,
  execution: Pick<ExecutionState, 'artifact' | 'automaticValues'> | undefined,
  instancePath: readonly string[] | undefined,
  keep: (record: RecordedAutomatic) => boolean,
  visit: (node: Scene['nodes'][number], row: Extract<Scene['nodes'][number]['layout']['rows'][number], { kind: 'widget' }>, record: RecordedAutomatic) => void,
): void {
  const records = execution?.automaticValues?.filter(keep) ?? []
  const artifact = execution?.artifact
  if (records.length === 0 || artifact === undefined || instancePath === undefined) return
  const toSource = artifact.provenance.toSource
  const view = occurrencesForView({ instancePath, runtimeIds: records.map((record) => record.runtimeNodeId), toSource })
  // A field promoted to a subgraph node is recorded on the inner node that
  // ran, under the inner input; the run's own document says which boundary
  // item reaches it, through every subgraph in between.
  const graphs = artifact.snapshot.graphs
  const defOf = (graphId: string | undefined, nodeId: string): string | undefined => {
    const type = graphId === undefined ? undefined : graphs[graphId]?.nodes[nodeId]?.type
    return type === undefined ? undefined : subgraphDefIdOf(type)
  }
  let viewedGraph: string | undefined = artifact.snapshot.root
  for (const instance of instancePath) viewedGraph = defOf(viewedGraph, instance)
  const boundaryItemOf = (defId: string | undefined, hops: readonly string[], inputId: string): string | undefined => {
    const [hop, ...rest] = hops
    const inputs = defId === undefined ? undefined : graphs[defId]?.boundary?.inputs
    if (inputs === undefined || hop === undefined) return undefined
    const port = rest.length === 0 ? inputId : boundaryItemOf(defOf(defId, hop), rest, inputId)
    return inputs.find((item) => item.binds.kind === 'port' && item.binds.node === hop && item.binds.port === port)?.id
  }
  const keyOf = (node: Scene['nodes'][number], record: RecordedAutomatic): string | undefined => {
    if ((view.own.get(node.id) ?? []).includes(record.runtimeNodeId)) return record.inputId
    if (!(view.inner.get(node.id) ?? []).includes(record.runtimeNodeId)) return undefined
    const occurrence = documentIdentityOf(record.runtimeNodeId, toSource)?.occurrence
    if (occurrence === undefined) return undefined
    const hops = [...occurrence.instancePath.slice(instancePath.length + 1), occurrence.node]
    return boundaryItemOf(defOf(viewedGraph, node.id), hops, record.inputId)
  }
  for (const node of scene.nodes) {
    const recorded = records.flatMap((record) => {
      const key = keyOf(node, record)
      return key === undefined ? [] : [{ key, record }]
    })
    if (recorded.length === 0) continue
    for (const row of node.layout.rows) {
      if (row.kind !== 'widget' || row.automatic === undefined) continue
      const found = recorded.find((item) => item.key === row.valueKey)
      if (found !== undefined) visit(node, row, found.record)
    }
  }
}

const shownValue = (value: Json): string => typeof value === 'string' ? value : JSON.stringify(value)

/**
 * The fields the viewed graph's last run filled with their default because
 * it could not work out their automatic value, while the editor works one
 * out now: one warning each, anchored to the field and listed in Problems.
 * A field that is fixed or wired is not automatic, so its warning goes; a
 * later run replaces the records.
 */
export function lastRunAutomaticDiagnostics(args: {
  readonly scene: Scene
  readonly execution: Pick<ExecutionState, 'artifact' | 'automaticValues'> | undefined
  readonly instancePath: readonly string[] | undefined
}): readonly Diagnostic[] {
  const out: Diagnostic[] = []
  eachRecordedAutomaticRow(args.scene, args.execution, args.instancePath, (record) => !record.workedOut, (node, row, record) => {
    if (row.automatic?.state !== 'worked-out') return
    out.push(diag('warning', 'runtime', 'automatic.lastRunDefault',
      `The last run could not work out ${row.label} and used the default, ${shownValue(record.value)}.`, {
        anchor: { port: { node: asNodeId(node.id), port: asPortId(row.inputId) } },
        data: { input: row.valueKey, runtimeId: record.runtimeNodeId },
      }))
  })
  return out
}

/**
 * A frozen view of a past run: each automatic row shows the value that run
 * recorded, not one worked out now, and warns only where the run used the
 * default.
 */
export function withRecordedAutomaticValues(
  scene: Scene,
  execution: Pick<ExecutionState, 'artifact' | 'automaticValues'> | undefined,
  instancePath: readonly string[] | undefined,
): Scene {
  const recorded = new Map<string, Map<string, RecordedAutomatic>>()
  eachRecordedAutomaticRow(scene, execution, instancePath, () => true, (node, row, record) => {
    let rows = recorded.get(node.id)
    if (rows === undefined) recorded.set(node.id, (rows = new Map()))
    rows.set(row.valueKey, record)
  })
  if (recorded.size === 0) return scene
  const diagnostics = scene.diagnostics.filter((d) => {
    const port = d.anchor?.port
    return d.code !== 'automatic.default' || port === undefined ||
      !recorded.get(port.node)?.has(String(d.data?.['input'] ?? port.port))
  })
  const nodes = scene.nodes.map((node) => {
    const rows = recorded.get(node.id)
    if (rows === undefined) return node
    return {
      ...node,
      layout: {
        ...node.layout,
        rows: node.layout.rows.map((row) => {
          const record = row.kind === 'widget' ? rows.get(row.valueKey) : undefined
          if (record === undefined || row.kind !== 'widget') return row
          if (!record.workedOut) {
            diagnostics.push(diag('warning', 'runtime', 'automatic.default',
              `Could not work out ${row.label}. Using the default, ${shownValue(record.value)}.`, {
                anchor: { port: { node: asNodeId(node.id), port: asPortId(row.inputId) } },
                data: { input: row.valueKey, runtimeId: record.runtimeNodeId },
              }))
          }
          return { ...row, automatic: { value: record.value, state: record.workedOut ? 'worked-out' as const : 'default' as const } }
        }),
      },
    }
  })
  return { ...scene, nodes, diagnostics }
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
  const artifacts = [...current.artifacts]
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
    ...current.artifacts.map((artifact) => artifact.nodeId),
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
      ...candidate.artifacts.map((artifact) => artifact.nodeId),
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
      // Saved artifacts are content-addressed even when the node's value is
      // a tensor whose rendition belongs to the previous job.
      const priorArtifacts = candidate.artifacts.filter((artifact) => artifact.nodeId === runtimeId)
      artifacts.push(...priorArtifacts)
      if (nodes[runtimeId] !== undefined || outputs[runtimeId] !== undefined || priorArtifacts.length > 0) {
        selected.add(runtimeId)
      }
    }
  }
  if (selected.size === 0) return unchanged()
  return { execution: { ...current, nodes, outputs, previews, artifacts }, retainedRuntimeIds: selected }
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
  /** Root-absence messages projected from runtime nodes onto this canvas view. */
  readonly blockedByNode: ReadonlyMap<string, string>
  /** Runtime expansion child counts projected onto their visible parent nodes. */
  readonly expandedByNode: ReadonlyMap<string, number>
  readonly rowProblems: RowProblemMap
  /** Nodes whose problems from the run have lost their color: changed since it (run-problem-standing.ts). */
  readonly lastRunNodes: ReadonlySet<string>
  readonly previews: Readonly<Record<string, NodePreview>>
  /** Scene node -> source authority for host-owned media element failures. */
  readonly previewSources: Readonly<Record<string, PreviewSource>>
  readonly executedImages: Readonly<Record<string, ExecutedImagePreview>>
  /** Selected input previews that actually won source precedence. */
  readonly selectedInputPreviews: Readonly<Record<string, SelectedInputPreview>>
  /** Standard-view text and scalar result surfaces; image previews take precedence. */
  readonly outputTexts: OutputTextMap
}

export interface AppliedNodeDecorations {
  readonly badges: Readonly<Record<string, readonly NodeBadge[]>>
  readonly presentation: Readonly<Record<string, NodeDecoration>>
}

const plainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => descriptor.get === undefined && descriptor.set === undefined,
  )
}

const decorationText = (value: unknown, field: string, max: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max ||
      value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${field} must be a trimmed visible string of at most ${max} characters`)
  }
  return value
}

const decorationBadge = (value: unknown): NodeBadge => {
  if (!plainRecord(value)) throw new Error('badge must be a plain object')
  const allowed = new Set(['id', 'glyph', 'fallbackGlyph', 'variant', 'appearance', 'placement', 'interactive', 'color', 'icon'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('badge contains an unsupported field')
  const id = decorationText(value['id'], 'badge id', 128)
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) throw new Error('badge id must be namespaced lowercase ASCII')
  const glyph = decorationText(value['glyph'], 'badge glyph', 40)
  const color = decorationText(value['color'], 'badge color', 9)
  if (!/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(color)) throw new Error('badge color must be #RRGGBB or #RRGGBBAA')
  if (value['fallbackGlyph'] !== undefined) decorationText(value['fallbackGlyph'], 'badge fallback glyph', 40)
  if (value['variant'] !== undefined && value['variant'] !== 'label') throw new Error("badge variant must be 'label'")
  if (value['appearance'] !== undefined && value['appearance'] !== 'policy') throw new Error("badge appearance must be 'policy'")
  if (value['placement'] !== undefined && value['placement'] !== 'above' && value['placement'] !== 'below') {
    throw new Error("badge placement must be 'above' or 'below'")
  }
  if (value['interactive'] !== undefined && value['interactive'] !== false) throw new Error('extension badges cannot be interactive')
  const icon = value['icon']
  if (icon !== undefined && (typeof icon !== 'string' || !isCanvasIconName(icon))) throw new Error('badge icon must name a canvas icon')
  return Object.freeze({
    id,
    glyph,
    color,
    ...(value['placement'] === undefined ? {} : { placement: value['placement'] as 'above' | 'below' }),
    ...(value['interactive'] === undefined ? {} : { interactive: false as const }),
    ...(icon === undefined ? {} : { icon }),
  })
}

const normalizedDecoration = (value: unknown): (Omit<NodeDecoration, 'badges'> & { readonly badges?: readonly NodeBadge[] }) | undefined => {
  if (value === undefined) return undefined
  if (!plainRecord(value)) throw new Error('decoration must be a plain object')
  const allowed = new Set(['badges', 'color', 'titleSuffix', 'status'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('decoration contains an unsupported field')
  if (value['badges'] !== undefined && (!Array.isArray(value['badges']) || value['badges'].length > 16)) {
    throw new Error('decoration badges must be an array of at most 16 items')
  }
  const color = value['color'] === undefined ? undefined : decorationText(value['color'], 'color', 9)
  if (color !== undefined && !/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/u.test(color)) {
    throw new Error('color must be #RRGGBB or #RRGGBBAA')
  }
  const titleSuffix = value['titleSuffix'] === undefined
    ? undefined
    : decorationText(value['titleSuffix'], 'title suffix', 64)
  const status = value['status'] === undefined ? undefined : decorationText(value['status'], 'status', 64)
  const badges = value['badges'] === undefined
    ? undefined
    : Object.freeze(value['badges'].map(decorationBadge))
  return Object.freeze({
    ...(badges === undefined ? {} : { badges }),
    ...(color === undefined ? {} : { color }),
    ...(titleSuffix === undefined ? {} : { titleSuffix }),
    ...(status === undefined ? {} : { status }),
  })
}

/** Apply sorted contribution callbacks transactionally and isolate failures by contribution. */
export function applyNodeDecorations(args: {
  readonly scene: Scene
  readonly documentId: string
  readonly graphId: string
  readonly contributions: readonly NodeDecorationContribution[]
  readonly badges: Readonly<Record<string, readonly NodeBadge[]>>
  readonly onResult?: (id: string, error?: unknown) => void
}): AppliedNodeDecorations {
  const badges: Record<string, readonly NodeBadge[]> = { ...args.badges }
  const presentation: Record<string, NodeDecoration> = {}
  for (const contribution of [...args.contributions].sort((left, right) => left.id.localeCompare(right.id))) {
    try {
      const staged = args.scene.nodes.flatMap((node) => {
        const result = normalizedDecoration(contribution.decorate(Object.freeze({
          documentId: args.documentId,
          graphId: args.graphId,
          id: node.id,
          type: node.node.type,
          title: node.layout?.title ?? node.node.title ?? node.id,
          mode: node.node.mode ?? 'active',
        })))
        return result === undefined ? [] : [{ nodeId: node.id, result }]
      })
      for (const { nodeId, result } of staged) {
        if (result.badges !== undefined) badges[nodeId] = [...(badges[nodeId] ?? []), ...result.badges]
        const current = presentation[nodeId]
        const titleSuffix = [current?.titleSuffix, result.titleSuffix].filter((value) => value !== undefined).join(' ')
        const color = result.color ?? current?.color
        const status = result.status ?? current?.status
        presentation[nodeId] = {
          ...(color === undefined ? {} : { color }),
          ...(titleSuffix === '' ? {} : { titleSuffix }),
          ...(status === undefined ? {} : { status }),
        }
      }
      args.onResult?.(contribution.id)
    } catch (error) {
      args.onResult?.(contribution.id, error)
    }
  }
  return { badges, presentation }
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
    output.type.kind === 'concrete' && output.type.name === 'IMAGE' && output.isList !== true)
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
  /** Manual migration badges belong only to the opt-in review mode. */
  readonly reviewReplacements?: boolean
  readonly replacementNodes?: ReadonlySet<string> | undefined
  /** Live-tab exactness oracle (liveExactnessFor); undefined = stale. */
  readonly exactProducer: ((runtimeId: string) => boolean) | undefined
  /** Runtime occurrences explicitly retained from older executions. */
  readonly retainedRuntimeIds?: ReadonlySet<string> | undefined
  /** Current compile + widget/solver diagnostics projected onto this view. */
  readonly nodeProblems?: NodeProblemMap
  /** Nodes whose runtime error badge the user dismissed for THIS run. */
  readonly dismissedErrorNodes?: ReadonlySet<string>
  readonly rowProblems?: RowProblemMap
  /**
   * Live tabs: whether a node no longer runs as the run ran it, given the
   * runtime ids in this view that failed (all of its runtime ids when none
   * is known to have failed); run-problem-standing.ts. Absent = unchanged.
   */
  readonly runChanged?: (sceneNodeId: string, runtimeIds: readonly string[]) => boolean
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
  const executionToSource = { ...exec?.artifact?.provenance.toSource }
  const executionDisplayIds = [
    ...Object.entries(exec?.nodes ?? {}).map(([runtimeId, progress]) => [runtimeId, progress.displayRuntimeNodeId] as const),
    ...Object.entries(exec?.blockedNodes ?? {}).map(([runtimeId, blocked]) => [runtimeId, blocked.displayRuntimeNodeId] as const),
    ...Object.entries(exec?.expandedNodes ?? {}).map(([runtimeId, expansion]) => [runtimeId, expansion.displayRuntimeNodeId] as const),
  ]
  for (const [runtimeId, displayRuntimeNodeId] of executionDisplayIds) {
    if (displayRuntimeNodeId === undefined) continue
    executionToSource[runtimeId] =
      exec?.artifact?.provenance.toSource[displayRuntimeNodeId] ?? displayRuntimeNodeId
  }

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
            ...Object.keys(exec.blockedNodes ?? {}),
            ...Object.keys(exec.expandedNodes ?? {}),
            ...exec.activities.map((activity) => activity.nodeId),
            ...exec.artifacts.map((artifact) => artifact.nodeId),
            ...exec.logs.flatMap((entry) => entry.runtimeNodeId === undefined ? [] : [entry.runtimeNodeId]),
            ...(exec.valueDiagnostics ?? []).map((diagnostic) => diagnostic.nodeId),
          ]),
          toSource: executionToSource,
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
  const blockedByNode = new Map<string, string>()
  for (const [runtimeNodeId, blocked] of Object.entries(exec?.blockedNodes ?? {})) {
    const sceneNodeId = sceneNodeOfRuntime.get(runtimeNodeId)
    if (sceneNodeId !== undefined) blockedByNode.set(sceneNodeId, blocked.message)
  }
  const expandedByNode = new Map<string, number>()
  for (const [runtimeNodeId, expansion] of Object.entries(exec?.expandedNodes ?? {})) {
    const sceneNodeId = sceneNodeOfRuntime.get(runtimeNodeId)
    if (sceneNodeId !== undefined) expandedByNode.set(sceneNodeId, expansion.childCount)
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

  // A run's problems on a node lose their color once the node has changed
  // since the run: no Failed state, a gray Last run tab, no row outlines.
  // A node is judged by its failed runtime nodes, so a subgraph node follows
  // the failed nodes inside it rather than every node inside it.
  const lastRunNodes = new Set<string>()
  if (!args.frozen && occ !== undefined && args.runChanged !== undefined && exec !== undefined) {
    for (const n of scene.nodes) {
      if (!runErrorsByNode.has(n.id) && states[n.id]?.state !== 'error') continue
      const ids = runtimeIdsFor(occ, n.id)
      const failed = new Set(ids.filter((id) => exec.nodes[id]?.state === 'error'))
      for (const diagnostic of runErrorsByNode.get(n.id) ?? []) {
        const id = diagnostic.data?.['runtimeId']
        if (typeof id === 'string') failed.add(id)
      }
      if (args.runChanged(n.id, failed.size > 0 ? [...failed] : ids)) lastRunNodes.add(n.id)
    }
  }
  // Once a run has ended, the live editor keeps only its errors; what ran,
  // came from cache or was skipped is drawn in the frozen view.
  const ended = exec !== undefined && exec.status !== 'queued' && exec.status !== 'running'
  const shownStates = Object.fromEntries(Object.entries(states).filter(([id, progress]) =>
    progress.state === 'error'
      ? !lastRunNodes.has(id)
      : args.frozen || !ended || (progress.state !== 'done' && progress.state !== 'cached' && progress.state !== 'skipped')))
  let rowProblems = args.rowProblems ?? {}
  if (lastRunNodes.size > 0) {
    const rows: Record<string, Readonly<Record<string, ProblemKind>>> = { ...rowProblems }
    for (const id of lastRunNodes) {
      const kept: Record<string, ProblemKind> = {}
      for (const line of args.nodeProblems?.[id] ?? []) {
        if (line.row === undefined || line.diagnostic.origin === 'runtime') continue
        if (kept[line.row] !== 'error') kept[line.row] = line.kind
      }
      if (Object.keys(kept).length > 0) rows[id] = kept
      else delete rows[id]
    }
    rowProblems = rows
  }

  // Resolve tap defaults from the elaborated interface, not only top-level
  // schema items: a persisted dynamic member is a real widget source too.
  // Cache one elaboration per source node for this overlay pass.
  // A primitive's value field takes the widget its own row draws, so a field
  // it feeds shows the value an empty primitive passes on in a run. An
  // automatic field passes on the value its own row has in use, as a run does.
  const tapDefaults = new Map<string, ReadonlyMap<string, Json | undefined>>()
  let connectivity: ReturnType<typeof buildGraphConnectivity> | undefined
  let resolvePrimitive: ReturnType<typeof documentPrimitiveResolver> | undefined
  const tapSchemaOf = (node: NodeData): NodeSchema | undefined => {
    const schema = args.resolveSchema?.(node.type)
    const shape = schema && args.doc !== undefined ? primitiveOf(schema) : undefined
    if (schema === undefined || shape === undefined) return schema
    resolvePrimitive ??= documentPrimitiveResolver(args.doc!, args.resolveSchema!)
    const effective = resolvePrimitive(gid, node, instancePath as readonly NodeId[] | undefined)
    return effective === undefined ? schema : withPrimitiveValue(schema, shape, effective)
  }
  const tapValueOf = (nodeId: string, inputId: string) => {
    let defaults = tapDefaults.get(nodeId)
    if (defaults === undefined) {
      const resolved = new Map<string, Json | undefined>()
      const node = args.def?.nodes[nodeId]
      const schema = node === undefined ? undefined : tapSchemaOf(node)
      if (node !== undefined && schema !== undefined) {
        const items = elabInputsOf(elaborateInterface(
          schema,
          node,
          (connectivity ??= buildGraphConnectivity(args.def!))(node.id),
          { promoteGhosts: false },
        ))
        const rows = args.scene.nodes.find((candidate) => candidate.id === nodeId)?.layout.rows ?? []
        for (const item of items) {
          if (item.spec.widget === undefined) continue
          const key = valueKeyOf(item)
          const row = rows.find((candidate) => candidate.kind === 'widget' && candidate.valueKey === key)
          resolved.set(key, row?.kind === 'widget' && row.automatic !== undefined
            ? row.automatic.value
            : effectiveWidgetDefault(item.spec.widget))
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

  const badges: Record<string, NodeBadge[]> = {}
  for (const n of scene.nodes) {
    const list: NodeBadge[] = []
    const s = n.isSubgraph ? undefined : args.resolveSchema?.(n.node.type)
    // Bottom lane, left to right: error, warning, info. The error tab is the
    // ONE visual for the job error report (rider on Dinkster #368: errors are
    // never a log level); dismissal hides it for this run only.
    const runErrors = runErrorsByNode.get(n.id)
    if (runErrors !== undefined && args.dismissedErrorNodes?.has(n.id) !== true) {
      list.push(lastRunNodes.has(n.id) ? LAST_RUN_BADGE : executionErrorBadge(runErrors.length))
    }
    const blocked = blockedByNode.get(n.id)
    if (blocked !== undefined) list.push(executionBlockedBadge(blocked))
    const expanded = expandedByNode.get(n.id)
    if (expanded !== undefined) list.push(executionExpandedBadge(expanded))
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
      list.push(mediaDiagnosticBadge(id, `${diagnostic.code === 'alpha_dropped' ? 'Alpha dropped' : 'Mask polarity'}: ${port}`))
    }
    // Execution errors already own the runtime error badge and its
    // runtime-details popover, so a runtime cause is not counted again here.
    const problemLines = (args.nodeProblems?.[n.id] ?? []).filter((line) =>
      !((runErrorsByNode.has(n.id) || lastRunNodes.has(n.id)) && line.diagnostic.origin === 'runtime'))
    const errorLines = problemLines.filter((line) => line.kind === 'error')
    const warningLines = problemLines.filter((line) => line.kind === 'warning')
    // A node that cannot run here says so on its tab, with no count.
    if (errorLines.some((line) =>
      line.diagnostic.code === 'dinksterGraph.residentProcessBoundary' || line.diagnostic.code === 'dinksterGraph.nodeUnavailable')) {
      list.push(UNAVAILABLE_BADGE)
    } else if (errorLines.length > 0) {
      list.push(problemBadge(PROBLEM_ERROR_BADGE, errorLines.length))
    }
    if (warningLines.length > 0) list.push(problemBadge(PROBLEM_WARNING_BADGE, warningLines.length))
    if (n.isSubgraph) {
      const defId = subgraphDefIdOf(n.node.type)
      const occurrences = defId === undefined || args.doc === undefined ? 1 : Object.values(args.doc.graphs).reduce((count, graph) =>
        count + Object.values(graph.nodes).filter((node) => subgraphDefIdOf(node.type) === defId).length, 0)
      list.push(subgraphBadge(occurrences))
    }
    else if (args.reviewReplacements === true && (args.replacementNodes?.has(n.id) || s !== undefined && isDeprecated(s))) list.push(DEPRECATED_BADGE)
    const iterationLabel = regionIterationLabels[n.id]
    if (iterationLabel !== undefined) list.push(regionIterationBadge(iterationLabel))
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
    // A refused output's caption row says why the preview is unavailable.
    if (surface.preview !== undefined) {
      previews[n.id] = surface.refusal === undefined || surface.preview.statusMessage !== undefined
        ? surface.preview
        : { ...surface.preview, statusMessage: surface.refusal }
    }
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
      // (selected input assets, artifacts, live frames)
      // carries no output-level provenance, so it fails closed. Output
      // cardinality is no proof: a one-output node's panel can show its
      // selected input asset, which is not the produced output.
      if (upstreamSource.outputId !== binding.images[0]!.driver.output) continue
      if (upstreamSource.runtimeId !== undefined && args.exactProducer?.(upstreamSource.runtimeId) !== true) continue
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
    states: shownStates,
    companions: derived.companions,
    companionSources: derived.sources,
    ownRuntimeIds,
    badges,
    runLogsByNode,
    runErrorsByNode,
    blockedByNode,
    expandedByNode,
    rowProblems,
    lastRunNodes,
    previews,
    previewSources,
    executedImages,
    selectedInputPreviews,
    outputTexts,
  }
}
