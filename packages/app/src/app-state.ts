/**
 * App state uses plain-TS state on core signals; Solid components subscribe
 * through the adapter. One backend connection, N document tabs, one shared
 * execution store. Execution -> tab routing goes through the artifact's
 * lineage id, NEVER "the active tab".
 */

import {
  DINKSTER_ADVERTISED_WIRE_VERSIONS,
  activeLocale,
  analyzeSelectionExecution,
  asConnectionId,
  asLineageId,
  asNodeId,
  asPortId,
  asPromptId,
  canonicalJson,
  canonicalTypeIdOf,
  companionSourcesOf,
  compile,
  documentResolver,
  coreCommandRegistry,
  coreMenuContributions,
  createMenuRegistry,
  createSearchRegistry,
  createReplacementRegistry,
  createSignal,
  createSurfaceRegistry,
  effectiveOccurrenceTopology,
  effectiveTopologyDrivesPort,
  effectiveWidgetDefault,
  modePanelSurface,
  detectFormat,
  diag,
  createLocalSession,
  connectSharedSession,
  type DocumentSession,
  type SharedDocumentSession,
  type CollabSessionDescriptor,
  type SessionConflict,
  emptyGates,
  environmentDrift,
  executionKey,
  ExtensionHost,
  type ExtensionHostOptions,
  type ExtensionEditorKind,
  type EditorBinding,
  type ExtensionPanelContributionV1,
  type FrontendPrivilege,
  stampEnvironment,
  t,
  importLitegraph,
  isIntegerWidgetValue,
  isValueDiagnostic,
  loadDocument,
  inputsOf,
  maskPaintSourceNodeId,
  nodeStatesFromDinksterJob,
  numericStepConstraints,
  outputCountInputsOf,
  outputsOf,
  parseMaskPaintRecipe,
  EMPTY_SUBGRAPH_DEFINITION,
  EMPTY_SUBGRAPH_VIEW,
  planFreshSubgraphCreate,
  parseOccurrenceKey,
  projectWorkspaceCompileArtifact,
  randomNumericValue,
  stepNumericValue,
  subgraphDefIdOf,
  registerSchemaRules,
  synthesizeAliasRules,
  comfyGroupReplacementInvocation,
  replacementInvocation,
  resetMenuContributions,
  scanReplacements,
  scopeClosure,
  resolvePreviewPolicy,
  semanticHashOf,
  validateDocumentShape,
  type PreviewAnimation,
  type CommandInvocation,
  type CommandOutcome,
  type AssetRef,
  type CompileInput,
  type CompileResult,
  type ComfyAliasRecord,
  type ComfyGroupRecord,
  type ConnectionId,
  type ControllerInputProvenance,
  type ControllerInputSource,
  type ControllerMode,
  type Diagnostic,
  type DiagnosticAnchor,
  type ExecutionRef,
  type ExecutionScope,
  type JsonObject,
  type ScopeClosure,
  type Json,
  type LineageId,
  type FreshDefinitionInitializer,
  type NodeActivity,
  type NodeData,
  type NodeId,
  type NodeOutputSummary,
  type NodeProgress,
  type NodeSchema,
  type Occurrence,
  type NormalizedEvent,
  type ReadonlySignal,
  type ReplacementRegistry,
  type ReplacementRule,
  type ReplacementScanItem,
  type ReplacementSchemaResolver,
  type RuntimeErrorDetail,
  type SelectionExecutionAnalysis,
  type SelectorChoice,
  type GateState,
  type GraphDef,
  type Signal,
  type WorkflowDocument,
  type WorkspaceCompileArtifact,
  type WidgetSpec,
  type Vec2,
  type CompileArtifact,
} from '@dinkster/core'
import {
  BackendConnection,
  DINKSTER_GRAPH_FEATURE_PLACEMENT,
  DinksterConnection,
  EngineNotReadyError,
  ExecutionStore,
  createScopedClient,
  discoverBackend,
  hydrateDinksterCompletedExecution,
  probeSupervisorStatus,
  reconcileDinksterExecutions,
  reconcileExecutions,
  restartSupervisorEngine,
  v1ViewUrl,
  type ConnectionStatus,
  type ExecutionState,
  type ExecutionStatus,
  type LibraryRecord,
  type BackendDiscovery,
  type DinksterSubmitResult,
  type PreviewMode,
  type CompatSkip,
  type RefreshableScopedClient,
  type ReplacementProblem,
  type SchemaRegistry,
  type SupervisorProgress,
  type SupervisorStatus,
  type WorkerInfo,
} from '@dinkster/client'
import {
  createTextWidgetEditorExtensionRegistry,
  createWidgetRegistry,
  LiveEmbeddingAndLoraInventoryProvider,
  registerCoreWidgets,
  SchemaTextCompletionProvider,
  type TextWidgetEditorExtension,
} from '@dinkster/widgets'
import { MAX_SCALE, MIN_SCALE, type Viewport } from '@dinkster/canvas'
import { createComponent } from 'solid-js'
import pkg from '../package.json'
import seedBasic from '../../core/fixtures/workflows/seed-basic.json'
import seedSubgraph from '../../core/fixtures/workflows/seed-subgraph.json'
import type { CanvasLens } from './data-lens.js'
import { registerLocaleSetting } from './locale.js'
import {
  assetGuessCandidateToRef,
  installAssetConsent,
  installImportAssetResolution,
  type AssetConsentRequest,
  type ImportAssetReference,
  type ImportAssetResolutionRequest,
} from './dialog-requests.js'
import {
  decodePackLocaleCatalog,
  overlayPackLocales,
  preferredPackLocaleKeys,
  type PackLocaleCatalog,
} from './pack-locales.js'
import {
  importAssetBasenamesForNames,
  importAssetDigestHintsForNames,
  importAssetMatchesForNames,
  planImportAssetAutoresolution,
  type ImportAssetDigestHint,
} from './import-asset-autoresolve.js'
import { createCoreLensRegistry } from './lenses.js'
import { APP_EDITOR_KIND, CURVE_EDITOR_KIND, EditorBindingRegistry, EditorRegistry, GLSL_EDITOR_KIND, GRAPH_EDITOR_KIND, IMAGE_EDITOR_KIND, type EditorBindingContext, type EditorKindDescriptor } from './editors.js'
import { BUILTIN_EDITOR_NODE_IDS } from './builtin-bindings.js'
import { isCurveValue, type CurveValue } from '@dinkster/widgets'
import { imageInputCandidates, isAssetRef } from './image-editor.js'
import { DockLayout } from './dock-layout.js'
import { EditorSplitStore } from './editor-split-store.js'
import { setPanelOpen } from './panel-location.js'
import { PanelRegistry, type PanelDescriptor } from './panels.js'
import { resolveNodeOccurrence } from './problem-display.js'
import { ShellLayout } from './shell-layout.js'
import { pollSupervisor } from './supervisor-poll.js'
import { CommandRegistry, KeybindingRegistry, SettingsRegistry, SETTINGS_STORAGE_KEY, type AppCommand } from './settings.js'
import { scopedSharedName, scopedStorageKey } from './projects.js'
import { ExtensionEditorHost, HostUiContributionRegistry, HostUiProviderHost } from './host-ui.js'
import { ExtensionWorld } from './extension-world.js'
import { registerCoreWidgetEditors } from './editors/widget-editors.js'
import {
  clearExecutionResultJobRef,
  clearExecutionResults,
  loadExecutionResults,
  persistedCompileProof,
  removeExecutionResult,
  saveExecutionResult,
  type ExecutionResultBackendIdentity,
  type PersistedExecutionResult,
} from './execution-result-persistence.js'
import { COLLAB_SCOPE, httpCollabTransport, stableActorId, type CollabTransport } from './collab.js'
import { PresenceChannel } from './collab-presence.js'
import {
  connectSharedWorkerSession,
  type SharedWorkerPortFactory,
} from './shared-worker-connection.js'
import {
  SharedWorkerTabConnection,
  type WorkspaceWorkerPortFactory,
} from './workspace-worker-connection.js'
import type {
  WorkspaceTabMutation,
  WorkspaceTabRecord,
  WorkspaceTabSnapshot,
} from './workspace-worker-authority.js'

export type RegionKind = 'map' | 'fold' | 'while'

interface WorkspaceEventChannel {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener?(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  close?(): void
}

type WorkspaceExecutionMessage =
  | { readonly source: string; readonly kind: 'event'; readonly event: NormalizedEvent }
  | {
      readonly source: string
      readonly kind: 'register'
      readonly ref: ExecutionRef
      readonly artifact: WorkspaceCompileArtifact
      readonly timestamp?: number
      readonly jobRef?: string
      readonly sourceDocument?: string
    }

interface WorkspaceRegistration {
  readonly ref: ExecutionRef
  readonly artifact: WorkspaceCompileArtifact
  readonly snapshot: WorkflowDocument
  readonly revision: number
  readonly scope: ExecutionScope
  readonly schemaHash: string
  readonly choices: readonly SelectorChoice[]
  readonly timestamp?: number
  readonly jobRef?: string
  readonly sourceDocument?: string
}

const workspaceRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const workspaceString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

const workspaceNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const workspaceInteger = (value: unknown, minimum = 0): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum

const workspaceStrings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every(workspaceString) ? value : undefined

const workspaceTextStrings = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value : undefined

const workspaceOwnedRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined => {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || encoded.length > 16_000_000) return undefined
    const decoded: unknown = JSON.parse(encoded)
    if (!workspaceRecord(decoded)) return undefined
    const pending: Array<{ value: unknown; depth: number }> = [{ value: decoded, depth: 0 }]
    let nodes = 0
    while (pending.length > 0) {
      const next = pending.pop()!
      nodes += 1
      if (nodes > 1_000_000 || next.depth > 64) return undefined
      if (next.value !== null && typeof next.value === 'object') {
        for (const child of Array.isArray(next.value)
          ? next.value
          : Object.values(next.value as Record<string, unknown>)) {
          pending.push({ value: child, depth: next.depth + 1 })
        }
      }
    }
    return decoded
  } catch {
    return undefined
  }
}

const decodeWorkspaceExecutionRef = (value: unknown): ExecutionRef | undefined => {
  if (!workspaceRecord(value) || !workspaceString(value['connection']) || !workspaceString(value['prompt'])) {
    return undefined
  }
  return { connection: asConnectionId(value['connection']), prompt: asPromptId(value['prompt']) }
}

const decodeWorkspaceOccurrence = (value: unknown): Occurrence | undefined => {
  if (!workspaceRecord(value) || !workspaceString(value['node'])) return undefined
  const instancePath = workspaceStrings(value['instancePath'])
  if (instancePath === undefined) return undefined
  return { instancePath: instancePath.map(asNodeId), node: asNodeId(value['node']) }
}

const decodeWorkspaceScope = (value: unknown): ExecutionScope | undefined => {
  if (!workspaceRecord(value)) return undefined
  if (value['kind'] === 'full') return { kind: 'full' }
  if (value['kind'] !== 'partial' || !Array.isArray(value['targets'])) return undefined
  const targets = value['targets'].map(decodeWorkspaceOccurrence)
  if (targets.some((target) => target === undefined)) return undefined
  return { kind: 'partial', targets: targets as Occurrence[] }
}

const decodeWorkspaceChoices = (value: unknown): readonly SelectorChoice[] | undefined => {
  if (value === undefined) return []
  if (!Array.isArray(value)) return undefined
  const keys = new Set<string>()
  const choices = value.flatMap((entry): SelectorChoice[] => {
    if (!workspaceRecord(entry) ||
      !workspaceString(entry['graph']) ||
      !workspaceString(entry['selector']) ||
      !workspaceString(entry['candidate']) ||
      (entry['policy'] !== 'fixed' && entry['policy'] !== 'random')) return []
    const key = JSON.stringify([entry['graph'], entry['selector']])
    if (keys.has(key)) return []
    keys.add(key)
    return [{
      graph: entry['graph'],
      selector: entry['selector'],
      policy: entry['policy'],
      candidate: entry['candidate'],
    }]
  })
  return choices.length === value.length ? choices : undefined
}

const decodeWorkspaceRegistration = (value: Readonly<Record<string, unknown>>): WorkspaceRegistration | undefined => {
  const ref = decodeWorkspaceExecutionRef(value['ref'])
  const rawArtifact = workspaceOwnedRecord(value['artifact'])
  const timestamp = value['timestamp']
  const jobRef = value['jobRef']
  const sourceDocument = value['sourceDocument']
  if (ref === undefined || rawArtifact === undefined ||
    (timestamp !== undefined && !workspaceNumber(timestamp)) ||
    (jobRef !== undefined && !workspaceString(jobRef)) ||
    (sourceDocument !== undefined && !workspaceString(sourceDocument)) ||
    !workspaceInteger(rawArtifact['revision']) ||
    !workspaceString(rawArtifact['connection']) || rawArtifact['connection'] !== ref.connection ||
    !workspaceString(rawArtifact['schemaHash']) || !workspaceString(rawArtifact['semanticHash']) ||
    !workspaceRecord(rawArtifact['prompt']) || !workspaceRecord(rawArtifact['provenance']) ||
    !Array.isArray(rawArtifact['diagnostics'])) return undefined
  const scope = decodeWorkspaceScope(rawArtifact['scope'])
  const choices = decodeWorkspaceChoices(rawArtifact['choices'])
  if (scope === undefined || choices === undefined || validateDocumentShape(rawArtifact['snapshot']).length > 0) return undefined
  const snapshot = rawArtifact['snapshot'] as WorkflowDocument
  if (rawArtifact['semanticHash'] !== semanticHashOf(snapshot)) return undefined
  const artifact = projectWorkspaceCompileArtifact(rawArtifact as unknown as CompileArtifact)
  return {
    ref,
    artifact,
    snapshot,
    revision: rawArtifact['revision'],
    scope,
    schemaHash: rawArtifact['schemaHash'],
    choices,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(jobRef === undefined ? {} : { jobRef }),
    ...(sourceDocument === undefined ? {} : { sourceDocument }),
  }
}

const decodeWorkspaceOutputSummary = (value: unknown): NodeOutputSummary | undefined => {
  if (!workspaceRecord(value) || !workspaceString(value['typeId'])) return undefined
  const length = value['length']
  if (length !== undefined && !workspaceInteger(length)) return undefined
  const inline = value['value']
  if (inline !== undefined &&
    typeof inline !== 'string' && typeof inline !== 'boolean' && !workspaceNumber(inline)) return undefined
  return {
    typeId: value['typeId'],
    ...(length === undefined ? {} : { length }),
    ...(inline === undefined ? {} : { value: inline }),
  }
}

const decodeWorkspaceNodeProgress = (value: unknown): NodeProgress | undefined => {
  if (!workspaceRecord(value)) return undefined
  const state = value['state']
  if (state !== 'pending' && state !== 'running' && state !== 'cached' &&
    state !== 'done' && state !== 'error' && state !== 'skipped') return undefined
  const executionArm = value['executionArm']
  if (executionArm !== undefined && executionArm !== 'native' && executionArm !== 'comfyui') return undefined
  const provider = value['provider']
  if (provider !== undefined && !workspaceString(provider)) return undefined
  const pack = value['pack']
  if (pack !== undefined && !workspaceString(pack)) return undefined
  const worker = value['worker']
  if (worker !== undefined && !workspaceString(worker)) return undefined
  const progress = value['value']
  const max = value['max']
  if (progress !== undefined && !workspaceNumber(progress)) return undefined
  if (max !== undefined && !workspaceNumber(max)) return undefined
  const skipOrigin = value['skipOrigin']
  const skipReason = value['skipReason']
  if (skipOrigin !== undefined && !workspaceString(skipOrigin)) return undefined
  if (skipReason !== undefined && typeof skipReason !== 'string') return undefined
  const rawOutputs = value['outputs']
  let outputs: Readonly<Record<string, NodeOutputSummary>> | undefined
  if (rawOutputs !== undefined) {
    if (!workspaceRecord(rawOutputs)) return undefined
    const entries: Array<readonly [string, NodeOutputSummary]> = []
    for (const [outputId, rawSummary] of Object.entries(rawOutputs)) {
      if (!workspaceString(outputId)) return undefined
      const summary = decodeWorkspaceOutputSummary(rawSummary)
      if (summary === undefined) return undefined
      entries.push([outputId, summary])
    }
    outputs = Object.fromEntries(entries)
  }
  return {
    state,
    ...(executionArm === undefined ? {} : { executionArm }),
    ...(provider === undefined ? {} : { provider }),
    ...(pack === undefined ? {} : { pack }),
    ...(worker === undefined ? {} : { worker }),
    ...(progress === undefined ? {} : { value: progress }),
    ...(max === undefined ? {} : { max }),
    ...(skipOrigin === undefined ? {} : { skipOrigin }),
    ...(skipReason === undefined ? {} : { skipReason }),
    ...(outputs === undefined ? {} : { outputs }),
  }
}

const decodeWorkspaceNodeActivity = (value: unknown): NodeActivity | undefined => {
  if (!workspaceRecord(value) || !workspaceString(value['nodeId'])) return undefined
  if (value['kind'] === 'lazy_demand') {
    const requestedInputs = workspaceStrings(value['requestedInputs'])
    const newInputs = workspaceStrings(value['newInputs'])
    const demandedInputs = workspaceStrings(value['demandedInputs'])
    const producerNodes = workspaceStrings(value['producerNodes'])
    if (!workspaceInteger(value['round']) ||
      (value['status'] !== 'waiting' && value['status'] !== 'ready') ||
      requestedInputs === undefined || newInputs === undefined ||
      demandedInputs === undefined || producerNodes === undefined) return undefined
    return {
      kind: 'lazy_demand',
      nodeId: value['nodeId'],
      round: value['round'],
      status: value['status'],
      requestedInputs,
      newInputs,
      demandedInputs,
      producerNodes,
    }
  }
  if (value['kind'] !== 'cache_miss' || typeof value['reason'] !== 'string') return undefined
  const changedInputs = value['changedInputs'] === undefined ? undefined : workspaceStrings(value['changedInputs'])
  const addedInputs = value['addedInputs'] === undefined ? undefined : workspaceStrings(value['addedInputs'])
  const removedInputs = value['removedInputs'] === undefined ? undefined : workspaceStrings(value['removedInputs'])
  if ((value['changedInputs'] !== undefined && changedInputs === undefined) ||
    (value['addedInputs'] !== undefined && addedInputs === undefined) ||
    (value['removedInputs'] !== undefined && removedInputs === undefined)) return undefined
  return {
    kind: 'cache_miss',
    nodeId: value['nodeId'],
    reason: value['reason'],
    ...(changedInputs === undefined ? {} : { changedInputs }),
    ...(addedInputs === undefined ? {} : { addedInputs }),
    ...(removedInputs === undefined ? {} : { removedInputs }),
  }
}

const decodeWorkspaceRuntimeError = (value: unknown): RuntimeErrorDetail | undefined => {
  if (!workspaceRecord(value) ||
    !workspaceString(value['exceptionType']) ||
    typeof value['exceptionMessage'] !== 'string') return undefined
  const traceback = workspaceTextStrings(value['traceback'])
  if (traceback === undefined) return undefined
  const rawHints = value['hints']
  let hints: RuntimeErrorDetail['hints']
  if (rawHints !== undefined) {
    if (!Array.isArray(rawHints)) return undefined
    const decoded = rawHints.flatMap((rawHint) => {
      if (!workspaceRecord(rawHint) ||
        !workspaceString(rawHint['code']) || typeof rawHint['message'] !== 'string' ||
        (rawHint['suggestion'] !== undefined && typeof rawHint['suggestion'] !== 'string')) return []
      return [{
        code: rawHint['code'],
        message: rawHint['message'],
        ...(rawHint['suggestion'] === undefined ? {} : { suggestion: rawHint['suggestion'] as string }),
      }]
    })
    if (decoded.length !== rawHints.length) return undefined
    hints = decoded
  }
  const currentInputs = value['currentInputs']
  const currentOutputs = value['currentOutputs']
  if (currentInputs !== undefined && !workspaceRecord(currentInputs)) return undefined
  if (currentOutputs !== undefined && !Array.isArray(currentOutputs)) return undefined
  return {
    exceptionType: value['exceptionType'],
    exceptionMessage: value['exceptionMessage'],
    traceback,
    ...(hints === undefined ? {} : { hints }),
    ...(currentInputs === undefined ? {} : { currentInputs }),
    ...(currentOutputs === undefined ? {} : { currentOutputs }),
  }
}

/** Decode the unversioned same-origin channel before it reaches the execution store. */
const decodeWorkspaceExecutionEvent = (value: unknown): NormalizedEvent | undefined => {
  if (!workspaceRecord(value) || !workspaceString(value['kind']) || !workspaceNumber(value['timestamp'])) {
    return undefined
  }
  const execution = decodeWorkspaceExecutionRef(value['execution'])
  const timestamp = value['timestamp']
  if (value['kind'] === 'status') {
    if (!workspaceString(value['connection']) ||
      (value['execution'] !== undefined && execution === undefined) ||
      (value['queueRemaining'] !== undefined && !workspaceInteger(value['queueRemaining']))) return undefined
    return {
      kind: 'status',
      connection: asConnectionId(value['connection']),
      timestamp,
      ...(execution === undefined ? {} : { execution }),
      ...(value['queueRemaining'] === undefined ? {} : { queueRemaining: value['queueRemaining'] as number }),
    }
  }
  if (execution === undefined) return undefined
  switch (value['kind']) {
    case 'started':
    case 'interrupted':
    case 'completed':
      return { kind: value['kind'], execution, timestamp }
    case 'regionExpanded': {
      const iterations = value['iterations']
      const regionKind = value['regionKind']
      const binding = value['binding']
      if (!workspaceString(value['runtimeNodeId']) ||
        (regionKind !== 'map' && regionKind !== 'fold' && regionKind !== 'while') ||
        (binding !== 'zip' && binding !== 'cross' && binding !== 'broadcast') ||
        (iterations !== null && !workspaceInteger(iterations)) ||
        ((regionKind === 'while') !== (iterations === null))) return undefined
      return {
        kind: 'regionExpanded', execution, timestamp,
        runtimeNodeId: value['runtimeNodeId'],
        regionKind,
        binding,
        iterations,
      }
    }
    case 'regionFinished':
      if (!workspaceString(value['runtimeNodeId']) || !workspaceInteger(value['iterations'])) return undefined
      return {
        kind: 'regionFinished', execution, timestamp,
        runtimeNodeId: value['runtimeNodeId'], iterations: value['iterations'],
      }
    case 'nodeStates': {
      if (!workspaceRecord(value['nodes']) ||
        (value['snapshot'] !== undefined && value['snapshot'] !== true)) return undefined
      const entries: Array<readonly [string, NodeProgress]> = []
      for (const [nodeId, rawProgress] of Object.entries(value['nodes'])) {
        if (!workspaceString(nodeId)) return undefined
        const progress = decodeWorkspaceNodeProgress(rawProgress)
        if (progress === undefined) return undefined
        entries.push([nodeId, progress])
      }
      return {
        kind: 'nodeStates', execution, timestamp,
        nodes: Object.fromEntries(entries),
        ...(value['snapshot'] === true ? { snapshot: true } : {}),
      }
    }
    case 'preview': {
      const payload = value['payload']
      const payloadValid =
        (typeof Blob !== 'undefined' && payload instanceof Blob) ||
        payload instanceof ArrayBuffer || workspaceRecord(payload)
      if (!workspaceString(value['channel']) || !payloadValid ||
        (value['runtimeNodeId'] !== undefined && !workspaceString(value['runtimeNodeId'])) ||
        (value['stream'] !== undefined && !workspaceString(value['stream'])) ||
        (value['frameIndex'] !== undefined && !workspaceInteger(value['frameIndex'])) ||
        (value['frameCount'] !== undefined && !workspaceInteger(value['frameCount'], 1)) ||
        (value['fps'] !== undefined && (!workspaceNumber(value['fps']) || value['fps'] <= 0))) return undefined
      return {
        kind: 'preview', execution, timestamp,
        channel: value['channel'], payload,
        ...(value['runtimeNodeId'] === undefined ? {} : { runtimeNodeId: value['runtimeNodeId'] as string }),
        ...(value['stream'] === undefined ? {} : { stream: value['stream'] as string }),
        ...(value['frameIndex'] === undefined ? {} : { frameIndex: value['frameIndex'] as number }),
        ...(value['frameCount'] === undefined ? {} : { frameCount: value['frameCount'] as number }),
        ...(value['fps'] === undefined ? {} : { fps: value['fps'] as number }),
      }
    }
    case 'nodeOutput':
      if (!workspaceString(value['runtimeNodeId']) || !workspaceRecord(value['output'])) return undefined
      return {
        kind: 'nodeOutput', execution, timestamp,
        runtimeNodeId: value['runtimeNodeId'], output: value['output'],
      }
    case 'node.event': {
      const payload = value['payload']
      if (!workspaceString(value['name']) ||
        (!(payload instanceof ArrayBuffer) && !workspaceRecord(payload)) ||
        (value['runtimeNodeId'] !== undefined && !workspaceString(value['runtimeNodeId']))) return undefined
      return {
        kind: 'node.event', execution, timestamp,
        name: value['name'], payload,
        ...(value['runtimeNodeId'] === undefined ? {} : { runtimeNodeId: value['runtimeNodeId'] as string }),
      }
    }
    case 'activity': {
      const activity = decodeWorkspaceNodeActivity(value['activity'])
      return activity === undefined ? undefined : { kind: 'activity', execution, timestamp, activity }
    }
    case 'valueDiagnostics': {
      const diagnostics = value['diagnostics']
      if (!Array.isArray(diagnostics) || !diagnostics.every(isValueDiagnostic)) return undefined
      return { kind: 'valueDiagnostics', execution, timestamp, diagnostics }
    }
    case 'log':
      if ((value['level'] !== 'info' && value['level'] !== 'warning') ||
        typeof value['message'] !== 'string' || !workspaceInteger(value['seq']) ||
        (value['runtimeNodeId'] !== undefined && !workspaceString(value['runtimeNodeId'])) ||
        (value['emittedAt'] !== undefined && !workspaceNumber(value['emittedAt'])) ||
        (value['origin'] !== undefined && value['origin'] !== 'stdout' && value['origin'] !== 'stderr' &&
          value['origin'] !== 'logging' && value['origin'] !== 'capture') ||
        (value['logger'] !== undefined && typeof value['logger'] !== 'string') ||
        (value['pythonLevel'] !== undefined && typeof value['pythonLevel'] !== 'string')) return undefined
      return {
        kind: 'log', execution, timestamp,
        level: value['level'], message: value['message'], seq: value['seq'],
        ...(value['runtimeNodeId'] === undefined ? {} : { runtimeNodeId: value['runtimeNodeId'] as string }),
        ...(value['emittedAt'] === undefined ? {} : { emittedAt: value['emittedAt'] as number }),
        ...(value['origin'] === undefined ? {} : { origin: value['origin'] as 'stdout' | 'stderr' | 'logging' | 'capture' }),
        ...(value['logger'] === undefined ? {} : { logger: value['logger'] as string }),
        ...(value['pythonLevel'] === undefined ? {} : { pythonLevel: value['pythonLevel'] as string }),
      }
    case 'error': {
      const detail = decodeWorkspaceRuntimeError(value['detail'])
      if (detail === undefined ||
        (value['runtimeNodeId'] !== undefined && !workspaceString(value['runtimeNodeId']))) return undefined
      return {
        kind: 'error', execution, timestamp, detail,
        ...(value['runtimeNodeId'] === undefined ? {} : { runtimeNodeId: value['runtimeNodeId'] as string }),
      }
    }
    default:
      return undefined
  }
}

const randomWorkspaceId = (prefix: string): string =>
  `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`

const sharedBackendClientId = (): string => {
  // Scoped per project: backend jobs and event sockets are keyed by this id,
  // so sharing it across projects would intermingle their execution state.
  const key = scopedStorageKey('dinkster.workspaceClientId')
  try {
    const existing = globalThis.localStorage?.getItem(key)
    if (existing) return existing
    const created = randomWorkspaceId('dinkster')
    globalThis.localStorage?.setItem(key, created)
    return created
  } catch {
    return randomWorkspaceId('dinkster')
  }
}

const REGION_DEFINITIONS: Readonly<Record<RegionKind, FreshDefinitionInitializer>> = {
  map: {
    nodes: { n0: { id: 'n0' as never, type: 'dinkster.float', values: {} } },
    links: {}, nets: {}, reroutes: {},
    boundary: {
      inputs: [{ id: 'item' as never, displayName: 'Item', binds: { kind: 'port', node: 'n0' as never, port: 'value' as never } }],
      outputs: [{ id: 'result' as never, displayName: 'Result', binds: { kind: 'port', node: 'n0' as never, port: 'value' as never } }],
    },
    nextOrdinal: 1,
  },
  fold: {
    nodes: { n0: { id: 'n0' as never, type: 'std.math.add_ints', values: {} } },
    links: {}, nets: {}, reroutes: {},
    boundary: {
      inputs: [
        { id: 'item' as never, displayName: 'Item', binds: { kind: 'port', node: 'n0' as never, port: 'a' as never } },
        { id: 'state' as never, displayName: 'State', binds: { kind: 'port', node: 'n0' as never, port: 'b' as never } },
      ],
      outputs: [{ id: 'result' as never, displayName: 'Result', binds: { kind: 'port', node: 'n0' as never, port: 'sum' as never } }],
    },
    nextOrdinal: 1,
  },
  while: {
    nodes: {
      n0: { id: 'n0' as never, type: 'dinkster.float', values: {} },
      n1: { id: 'n1' as never, type: 'dinkster.boolean', values: { value: true } },
    },
    links: {}, nets: {}, reroutes: {},
    boundary: {
      inputs: [{ id: 'state' as never, displayName: 'State', binds: { kind: 'port', node: 'n0' as never, port: 'value' as never } }],
      outputs: [
        { id: 'result' as never, displayName: 'Result', binds: { kind: 'port', node: 'n0' as never, port: 'value' as never } },
        { id: 'continue' as never, displayName: 'Continue', binds: { kind: 'port', node: 'n1' as never, port: 'value' as never } },
      ],
    },
    nextOrdinal: 2,
  },
}

const REGION_VIEWS = {
  map: { nodes: { n0: { position: { x: 80, y: 80 } } } },
  fold: { nodes: { n0: { position: { x: 80, y: 80 } } } },
  while: { nodes: { n0: { position: { x: 80, y: 80 } }, n1: { position: { x: 320, y: 80 } } } },
} as const

const regionContract = (kind: RegionKind) => kind === 'map'
  ? { kind, elementPorts: ['item'] as readonly string[] }
  : kind === 'fold'
    ? {
        kind, elementPorts: ['item'] as readonly string[], statePorts: ['state'] as readonly string[],
        outputRoles: { result: { kind: 'state' as const, statePort: 'state' } },
      }
    : {
        kind, statePorts: ['state'] as readonly string[],
        outputRoles: { result: { kind: 'state' as const, statePort: 'state' } },
        continueOutput: 'continue', maxIterations: 100,
      }

const regionValues = (kind: RegionKind): JsonObject => kind === 'map'
  ? { item: [] }
  : kind === 'fold' ? { item: [], state: 0 } : { state: 0 }

/** Reserved single-user library scope (backend contract: explicit, never absent). */
export const LIBRARY_SCOPE = 'local'
/** Media type recorded on saved workflow documents (backend records it verbatim). */
export const WORKFLOW_MEDIA_TYPE = 'application/x-dinkster-workflow+json'
/**
 * Label stamped on workflow library records. The list endpoint filters by
 * label (not mediaType), so this is the query-first browse key for the
 * Workflows collection - list-then-filter would break the paging contract.
 */
export const WORKFLOW_LABEL = 'workflow'

/** Filesystem-safe stem used by local workflow downloads. */
export function workflowExportFilename(title: string): string {
  const stem = title
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim()
  return `${stem || 'workflow'}.json`
}

export type { AssetConsentRequest, ImportAssetReference, ImportAssetResolutionRequest } from './dialog-requests.js'

function legacyAssetDigestHints(json: unknown): readonly ImportAssetDigestHint[] {
  if (typeof json !== 'object' || json === null) return []
  const models = (json as Record<string, unknown>)['models']
  if (!Array.isArray(models)) return []
  const hints: ImportAssetDigestHint[] = []
  for (const model of models) {
    if (typeof model !== 'object' || model === null) continue
    const record = model as Record<string, unknown>
    if (typeof record['name'] !== 'string' || typeof record['hash_type'] !== 'string' ||
      record['hash_type'].toLowerCase() !== 'blake3' || typeof record['hash'] !== 'string' ||
      !/^[0-9a-f]{64}$/i.test(record['hash'])) continue
    hints.push({ name: record['name'], digest: `blake3:${record['hash'].toLowerCase()}` })
  }
  return hints
}

export interface SelectionExecutionScopes {
  readonly analysis: SelectionExecutionAnalysis
  readonly upTo?: ExecutionScope
  readonly between?: ExecutionScope
  readonly fromOnwards?: ExecutionScope
  readonly upToReason?: string
  readonly betweenReason?: string
  readonly fromOnwardsReason?: string
}

/**
 * One planned controller advancement: the new value plus the exact state it
 * was derived from. `expected` is the RAW stored value (undefined when the
 * widget default was in effect), `current` is the EFFECTIVE compiled value,
 * and `mode` is the EFFECTIVE controller mode at queue time -
 * the compare-and-set tokens that let completion-time application skip any
 * input whose value or controller mode the user changed after queueing:
 * switching to 'fixed' mid-run parks the value, in-flight plans
 * included.
 */
export interface AdvancementStep {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly value: Json
  readonly expected: Json | undefined
  readonly current: Json
  readonly mode: ControllerMode
  /** Value candidates through the queue-time effective source, for ABA detection. */
  readonly valueSources: readonly ControllerInputSource[]
  /** Every undriven compiled terminal owned by this one stored control. */
  readonly controllers: readonly ControllerInputProvenance[]
}

/** A queue-time advancement plan bound to the exact session it targets. */
export interface AdvancementPlan {
  readonly session: DocumentSession
  readonly artifact: CompileArtifact
  readonly steps: readonly AdvancementStep[]
  /** Per-input value mutation generation captured with the queue-time snapshot. */
  readonly generations: ReadonlyMap<string, number>
}

type AdvancementInputLocation = Pick<AdvancementStep, 'graphId' | 'nodeId' | 'inputId'>

const advancementInputKey = (step: AdvancementInputLocation): string =>
  JSON.stringify(['graphs', step.graphId, 'nodes', step.nodeId, 'values', step.inputId])

const controllerSourceLocation = (source: ControllerInputSource): AdvancementInputLocation => ({
  graphId: source.graph,
  nodeId: source.occurrence.node,
  inputId: source.valueKey,
})

const controllerInputKey = (
  runtimeId: string,
  terminal: ControllerInputSource,
): string => JSON.stringify([
  runtimeId,
  terminal.graph,
  terminal.occurrence.instancePath,
  terminal.occurrence.node,
  terminal.valueKey,
])

// Promoted widget defaults mirror live fallback values, which the value CAS checks separately.
const controllerSemanticsKey = (input: ControllerInputProvenance): string => canonicalJson({
  runtimeId: input.runtimeId,
  terminal: input.terminal,
  sources: input.sources,
  ownerPriority: input.ownerPriority,
  optional: input.optional,
  driven: input.driven,
  widget: {
    widgetType: input.widget.widgetType,
    options: input.widget.options,
    controller: input.widget.controller,
    controllerInitial: input.widget.controllerInitial,
  },
})

interface ControllerMutationState {
  next: number
  readonly inputs: Map<string, {
    readonly graphId: string
    readonly nodeId: string
    readonly inputId: string
    value: Json | undefined
    generation: number
  }>
}

export interface ComboRefreshStep {
  readonly graphId: string
  readonly nodeId: string
  readonly nodeType: string
  readonly inputId: string
  readonly expected: Json | undefined
  readonly current: string
  readonly mode: ControllerMode
}

export interface ComboRefreshPlan {
  readonly session: DocumentSession
  readonly backend: Backend
  readonly registry: SchemaRegistry
  readonly route: string
  readonly steps: readonly ComboRefreshStep[]
}

export function comboRefreshAdvancementPlan(
  session: DocumentSession,
  route: string,
  backend: Backend,
  registry: SchemaRegistry,
): ComboRefreshPlan | undefined {
  const document = session.doc
  const steps: ComboRefreshStep[] = []
  for (const graph of Object.values(document.graphs)) for (const node of Object.values(graph.nodes)) {
    const schema = registry.resolve(node.type)
    if (!schema) continue
    for (const input of schema.items) {
      const widget = input.kind === 'input' ? input.widget : undefined
      if (widget?.widgetType !== 'COMBO' || widget.controller !== 'after_refresh' || widget.remote?.route !== route) continue
      const mode = node.controllers?.[input.id] ?? widget.controllerInitial ?? 'randomize'
      if (mode === 'fixed') continue
      const linkDriven = Object.values(graph.links).some((link) => 'port' in link.to && link.to.node === node.id && link.to.port === input.id)
        || Object.values(graph.nets).some((net) => net.sinks.some((sink) => sink.node === node.id && sink.port === input.id))
      if (linkDriven) continue
      const expected = node.values[input.id]
      const effective = expected ?? effectiveWidgetDefault(widget)
      if (typeof effective !== 'string' && typeof effective !== 'number') continue
      steps.push({ graphId: graph.id, nodeId: node.id, nodeType: node.type, inputId: input.id, expected, current: String(effective), mode })
    }
  }
  return steps.length > 0 ? { session, backend, registry, route, steps } : undefined
}

export function comboRefreshAdvancement(
  document: WorkflowDocument,
  plan: ComboRefreshPlan,
  options: readonly string[],
  resolve: (type: string) => NodeSchema | undefined,
  random: () => number = Math.random,
): CommandInvocation | undefined {
  if (options.length === 0) return undefined
  const invocations: CommandInvocation[] = []
  for (const step of plan.steps) {
    const node = document.graphs[step.graphId]?.nodes[step.nodeId]
    if (!node || node.type !== step.nodeType || node.values[step.inputId] !== step.expected) continue
    const graph = document.graphs[step.graphId]!
    const linkDriven = Object.values(graph.links).some((link) => 'port' in link.to && link.to.node === node.id && link.to.port === step.inputId)
      || Object.values(graph.nets).some((net) => net.sinks.some((sink) => sink.node === node.id && sink.port === step.inputId))
    if (linkDriven) continue
    const input = resolve(node.type)?.items.find((item) => item.kind === 'input' && item.id === step.inputId)
    const widget = input?.kind === 'input' ? input.widget : undefined
    if (widget?.widgetType !== 'COMBO' || widget.controller !== 'after_refresh' || widget.remote?.route !== plan.route) continue
    const mode = node.controllers?.[step.inputId] ?? widget.controllerInitial ?? 'randomize'
    if (mode !== step.mode) continue
    const index = options.indexOf(step.current)
    const next = mode === 'increment'
      ? options[index < 0 ? 0 : (index + 1) % options.length]!
      : mode === 'decrement'
        ? options[index < 0 ? options.length - 1 : (index + options.length - 1) % options.length]!
        : options[Math.min(options.length - 1, Math.max(0, Math.floor(random() * options.length)))]!
    invocations.push({ command: 'node.setValue', params: { graphId: step.graphId, nodeId: step.nodeId, inputId: step.inputId, value: next } })
  }
  return invocations.length > 0 ? { command: 'batch', params: { invocations } as unknown as Json } : undefined
}

function effectiveControllerState(
  document: WorkflowDocument,
  sources: readonly ControllerInputSource[],
  widget: WidgetSpec,
  optional: boolean,
): {
  readonly current: Json | undefined
  readonly mode: ControllerMode
  readonly valueSources: readonly ControllerInputSource[]
} {
  let current: Json | undefined
  let mode: ControllerMode | undefined
  let valueSourceCount = sources.length
  for (const [index, source] of sources.entries()) {
    const node = document.graphs[source.graph]?.nodes[source.occurrence.node]
    if (current === undefined) {
      current = node?.values[source.valueKey]
      if (current !== undefined) valueSourceCount = index + 1
    }
    if (mode === undefined) mode = node?.controllers?.[source.valueKey]
  }
  if (current === undefined && (widget.default !== undefined || !optional)) {
    current = effectiveWidgetDefault(widget)
  }
  return {
    current,
    mode: mode ?? widget.controllerInitial ?? 'randomize',
    valueSources: sources.slice(0, valueSourceCount),
  }
}

/** Build one atomic, undoable controller advancement for a completed prompt. */
export function controllerAdvancement(
  document: WorkflowDocument,
  artifact: CompileArtifact,
  random: () => number = Math.random,
): CommandInvocation | undefined {
  const steps = controllerAdvancementPlan(document, artifact, random)
  return advancementInvocation(steps)
}

/** The batch invocation for a set of advancement steps ([] -> undefined). */
export function advancementInvocation(steps: readonly AdvancementStep[]): CommandInvocation | undefined {
  const invocations = steps.map(({ graphId, nodeId, inputId, value }) => ({
    command: 'node.setValue',
    params: { graphId, nodeId, inputId, value },
  }))
  return invocations.length > 0 ? { command: 'batch', params: { invocations } as unknown as Json } : undefined
}

/**
 * The per-input advancement plan for a compiled prompt: which controller
 * inputs advance, to what value, and from which stored value. Pure - the
 * caller owns when (and whether) to apply it.
 */
export function controllerAdvancementPlan(
  document: WorkflowDocument,
  artifact: CompileArtifact,
  random: () => number = Math.random,
): readonly AdvancementStep[] {
  const steps: AdvancementStep[] = []
  const controllersByOwner = new Map<string, {
    readonly owner: ControllerInputSource
    readonly controllers: ControllerInputProvenance[]
  }>()
  for (const input of artifact.provenance.controllerInputs ?? []) {
    if (input.sources.length === 0) continue
    const owner = input.sources[0]!
    const ownerKey = advancementInputKey({ graphId: owner.graph, nodeId: owner.occurrence.node, inputId: owner.valueKey })
    let group = controllersByOwner.get(ownerKey)
    if (group === undefined) {
      group = { owner, controllers: [] }
      controllersByOwner.set(ownerKey, group)
    }
    if (!input.driven) group.controllers.push(input)
  }
  for (const { owner, controllers } of controllersByOwner.values()) {
    controllers.sort((a, b) => a.ownerPriority - b.ownerPriority)
    const input = controllers[0]
    if (input === undefined) continue
    const node = document.graphs[owner.graph]?.nodes[owner.occurrence.node]
    if (!node) continue
    const state = effectiveControllerState(document, input.sources, input.widget, input.optional)
    if (state.current === undefined || state.mode === 'fixed') continue
    let value: Json
    if (input.widget.widgetType === 'COMBO') {
      const options = input.widget.options['options']
      if (!Array.isArray(options) || !options.every((option) => typeof option === 'string') || options.length === 0 || typeof state.current !== 'string') continue
      const index = options.indexOf(state.current)
      value = state.mode === 'increment'
        ? options[index < 0 ? 0 : (index + 1) % options.length]!
        : state.mode === 'decrement'
          ? options[index < 0 ? options.length - 1 : (index + options.length - 1) % options.length]!
          : options[Math.min(options.length - 1, Math.max(0, Math.floor(random() * options.length)))]!
    } else {
      const current = state.current
      if (typeof current !== 'number' &&
        (input.widget.widgetType !== 'INT' || !isIntegerWidgetValue(current))) continue
      const constraints = numericStepConstraints(input.widget)
      value = state.mode === 'increment'
        ? stepNumericValue(current, 1, constraints)
        : state.mode === 'decrement'
          ? stepNumericValue(current, -1, constraints)
          : randomNumericValue(constraints, random)
    }
    const valueSources = new Map<string, ControllerInputSource>()
    for (const controller of controllers) {
      const candidateState = effectiveControllerState(document, controller.sources, controller.widget, controller.optional)
      for (const source of candidateState.valueSources) {
        const location = controllerSourceLocation(source)
        valueSources.set(advancementInputKey(location), source)
      }
    }
    steps.push({
      graphId: owner.graph,
      nodeId: owner.occurrence.node,
      inputId: owner.valueKey,
      value,
      expected: node.values[owner.valueKey],
      current: state.current,
      mode: state.mode,
      valueSources: [...valueSources.values()],
      controllers,
    })
  }
  return steps
}

/**
 * Legacy boolean tokens (wire v10): the exact two-option combo vocabularies
 * the backend now translates to core.boolean. Old documents stored the
 * option string; these are the ONLY strings normalizeLegacyBooleans rewrites.
 */
const LEGACY_BOOLEAN_TOKENS: ReadonlyMap<string, boolean> = new Map([
  ['enable', true], ['on', true], ['true', true], ['yes', true],
  ['disable', false], ['off', false], ['false', false], ['no', false],
])

/**
 * Typed accessors the canvas host publishes for OTHER panels (control
 * surfaces and inspectors): the live node selection and geometric group
 * membership of the graph currently rendered. A registration contract, not a
 * reach into canvas internals - membership capture at invocation time is the
 * same convention view.moveGroup uses. `groupMembers` answers only for the
 * graph on screen (undefined otherwise: geometry of unrendered graphs is
 * unknown, and callers must treat that as "membership unresolved").
 */
export interface CanvasBridge {
  readonly selectedNodes: () => readonly string[]
  readonly groupMembers: (graphId: string, groupId: string) => readonly string[] | undefined
  /** App-level actions live here so commands do not reach into renderer internals. */
  readonly deleteSelection: () => void
  readonly selectAll: () => void
  readonly setSelectedMode: (mode: 'active' | 'muted' | 'bypassed') => void
  readonly toggleSelectedCollapsed: () => void
  readonly zoomBy: (factor: number) => void
  readonly fitSelection: () => void
  readonly armNodePlacement: (
    type: string,
    expected?: { readonly schemaKey: string; readonly backendId: string },
  ) => boolean
  readonly createEmptySubgraph?: (position?: Vec2) => boolean
  readonly createRegion?: (kind: 'map' | 'fold' | 'while', position?: Vec2) => boolean
  /** Opens the naming prompt after snapshotting selection and group contents. */
  readonly extractSubgraph?: () => boolean
  /** Flattens the sole selected subgraph occurrence by one level. */
  readonly flattenSubgraph?: () => boolean
  readonly canExtractSubgraph?: () => boolean
  readonly canFlattenSubgraph?: () => boolean
}

export interface NodeHelpRequest {
  readonly backendId: ConnectionId
  readonly pack: string
  readonly nodeType: string
}

/** Selected entity ids of the graph currently rendered (see canvasSelection). */
export interface CanvasSelectionSnapshot {
  readonly nodes: readonly string[]
  readonly links: readonly string[]
  readonly groups: readonly string[]
}

export const EMPTY_CANVAS_SELECTION: CanvasSelectionSnapshot = { nodes: [], links: [], groups: [] }

/** The open widget editor as focus facts (see widgetFocus). */
export interface WidgetFocus {
  readonly nodeId: string
  /** The node.values key the editor writes. */
  readonly valueKey: string
  /** The display label painted on the widget row. */
  readonly label: string
}

/** A validated Problems-row request waiting for CanvasHost to install its scene. */
export interface DiagnosticFocusRequest {
  readonly tab: Tab
  readonly anchor: DiagnosticAnchor
  /** Current view context for solver anchors that carry only a port. */
  readonly portInstancePath?: readonly string[]
}

export type NodeMode = 'active' | 'muted' | 'bypassed'

/** Toggle a mode for a whole selection: only an all-target selection turns off. */
export function toggledSelectionMode(modes: readonly NodeMode[], target: Exclude<NodeMode, 'active'>): NodeMode {
  return modes.length > 0 && modes.every((mode) => mode === target) ? 'active' : target
}

/** Minimize a mixed selection; restore only when every node is minimized. */
export function toggledSelectionCollapsed(collapsed: readonly boolean[]): boolean {
  return collapsed.some((value) => !value)
}

interface TabViewUpdate {
  readonly updatedAt: number
  readonly sequence: number
  readonly actorId: string
}

interface TabGraphViewport extends Viewport {
  readonly update: TabViewUpdate
}

interface TabViewState {
  readonly graphViewports: Readonly<Record<string, TabGraphViewport>>
  readonly appScroll?: {
    readonly scrollTop: number
    readonly update: TabViewUpdate
  }
}

export interface Tab {
  readonly id: string
  readonly title: string
  /**
   * Which center-region editor renders this tab (editors.ts). A tab is
   * conceptually (document, editorKind). Editor kinds are
   * EditorRegistry descriptors referenced by this value.
   */
  readonly editorKind: string
  /**
   * App-view arrange mode: when true the app editor shows its authoring
   * tools (reorder, rename, remove) instead of the clean use-mode form.
   * This interaction mode is transient; persisted view position is kept
   * separately from both the tab record and document data.
   */
  readonly appArrange?: boolean
  /**
   * Authoritative document state: commands in, patches out, undo/redo.
   * Nothing outside the DocumentSession may assume single-writer document
   * access.
   */
  readonly store: DocumentSession
  /** Subgraph drill-in path; the LAST entry is the graph being edited. */
  readonly graphStack: Signal<readonly string[]>
  /**
   * Instance node ids navigated THROUGH to reach the current graph (one per
   * graphStack entry beyond the root). A def instantiated twice is two
   * different occurrence chains; the definition-only graphStack cannot tell
   * them apart, so execution overlays key off this path. Kept in sync by
   * pushGraph/truncateGraphStack; read through viewInstancePath, which
   * abstains (undefined) when the two signals disagree - e.g. after a
   * direct graphStack write - so a stale path can never mis-attribute
   * runtime state.
   */
  readonly instancePath: Signal<readonly string[]>
  /**
   * Present on FROZEN tabs: this tab renders the compile artifact's snapshot
   * of that execution, read-only. The snapshot is the exact document the
   * prompt was lowered from, so progress/errors/outputs shown here are
   * truthful no matter what happens to the live document afterwards.
   */
  readonly execution?: ExecutionRef
}

/** Session-only destination for the registry-resolved image editor. */
export interface ImageEditorTarget {
  readonly tabId: string
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly sourceRef: AssetRef
  readonly maskPaint?: {
    readonly expectedMaskLinkIds: readonly string[]
    readonly expectedMaskNetIds: readonly string[]
    readonly paintNodeId: string | null
    readonly expectedPaintOperations: string | null
  }
}

export interface CurveEditorTarget {
  readonly tabId: string
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly instancePath: readonly string[]
  readonly openedStoredValue: Json | undefined
  readonly openedSchemaDefault: unknown
  readonly openedValue: CurveValue
  readonly follow?: {
    readonly envelopeNodeId: string
    readonly audioNodeId: string
    readonly audioOutputId: string
  }
}

export interface GlslEditorTarget {
  readonly tabId: string
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: 'fragment_shader'
  readonly instancePath: readonly string[]
  readonly openedStoredValue: Json | undefined
  readonly openedSchemaDefault: unknown
  readonly openedValue: string
}

/** Session-only destination for the compositor mode of the image editor. */
export interface CompositorEditorTarget {
  readonly mode: 'compositor'
  readonly tabId: string
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly instancePath: readonly string[]
  readonly openedStoredValue: Json | undefined
}

export const isCompositorEditorTarget = (
  target: ImageEditorTarget | CompositorEditorTarget,
): target is CompositorEditorTarget => 'mode' in target && target.mode === 'compositor'

export const isMaskPaintEditorTarget = (target: ImageEditorTarget): boolean => target.maskPaint !== undefined

const sameAssetRef = (left: AssetRef, right: AssetRef): boolean =>
  left.digest === right.digest && left.name === right.name && left.size === right.size &&
  left.mediaType === right.mediaType && left.virtualPath === right.virtualPath

const schemaPortType = (schema: NodeSchema | undefined, kind: 'input' | 'output', id: string): string | undefined => {
  if (!schema) return undefined
  const item = (kind === 'input' ? inputsOf(schema) : outputsOf(schema)).find((candidate) => candidate.id === id)
  return item ? canonicalTypeIdOf(item.type) : undefined
}

const isSessionOnlyEditorKind = (kind: string): boolean =>
  kind === IMAGE_EDITOR_KIND || kind === CURVE_EDITOR_KIND || kind === GLSL_EDITOR_KIND

/** A tab's live shared-session membership (session-only; never persisted). */
export interface CollabTabState {
  readonly descriptor: CollabSessionDescriptor
  /** Collab backend base URL the session was joined through. */
  readonly baseUrl: string
  /** The tab's store, typed to its shared surface (status, settle, close). */
  readonly session: SharedDocumentSession
  /** The membership's presence pipe (cursors/selection); dies with it. */
  readonly presence: PresenceChannel
}

let newWorkflowOrdinal = 0

/** Build a schema-independent document for New and native clean startup. */
function emptyWorkflowJson(): JsonObject {
  const suffix = `${Date.now()}-${++newWorkflowOrdinal}`
  const lineage = `workflow-${suffix}`
  const root = `graph-${suffix}`
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage,
    root,
    graphs: {
      [root]: { id: root, name: 'root', nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1 },
    },
    view: { graphs: { [root]: { nodes: {} } } },
  }
}

/** How a frozen tab's snapshot relates to the live document of its lineage. */
export type FrozenSyncStatus = 'in-sync' | 'diverged' | 'no-live-tab'

/**
 * Problems ownership: every entry belongs to a tab id string or an app-scoped
 * symbol. The panel shows visible tabs plus every symbol owner; background
 * tabs retain their entries hidden, and closing a tab drops them. Ownership
 * is keyed by tab id, never graph id - two documents that both contain a
 * graph 'g0' can never cross-contaminate.
 *
 * App owners are symbols because document lineage is an arbitrary string.
 * Symbols prevent any document lineage from colliding with app diagnostics
 * or clearing them when its tab closes.
 */
export const GLOBAL_PROBLEMS_OWNER: unique symbol = Symbol('global-problems')

export type ProblemOwner = string | symbol

/** A Problems entry: the diagnostic plus the owner it belongs to. */
export type OwnedDiagnostic = Diagnostic & { readonly owner: ProblemOwner }

const sameProblemIdentity = (a: OwnedDiagnostic, b: OwnedDiagnostic): boolean =>
  a.owner === b.owner && a.origin === b.origin && a.code === b.code && a.message === b.message

/**
 * Report-ingress dedupe only: gesture refusals repeat the identical
 * {owner, origin, code, message} tuple on every attempt and must keep one
 * live row. Replacement batches (compile/submit) bypass this because
 * identical tuples there can carry distinct anchors that each need their
 * own activatable entry.
 */
const dedupedReportDiagnostics = (owner: ProblemOwner, diagnostics: readonly Diagnostic[]): readonly OwnedDiagnostic[] => {
  const entries: OwnedDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const entry: OwnedDiagnostic = { ...diagnostic, owner }
    if (!entries.some((candidate) => sameProblemIdentity(candidate, entry))) entries.push(entry)
  }
  return entries
}

/**
 * The Problems projection for a set of visible canvases: their own entries
 * plus all app-scoped symbol owners, in log order. The caller supplies every
 * visible tab id.
 */
export const visibleProblems = (
  problems: readonly OwnedDiagnostic[],
  visibleOwners: ReadonlySet<string>,
): readonly OwnedDiagnostic[] =>
  problems.filter(
    (d) => typeof d.owner === 'symbol' || visibleOwners.has(d.owner),
  )

/** Graph definition a tab currently shows. */
export const currentGraphId = (tab: Tab): string =>
  tab.graphStack.get()[tab.graphStack.get().length - 1] ?? tab.store.doc.root

/** Subgraph definition the tab currently edits, if the Boundary panel applies. */
export const editedSubgraphDefinition = (tab: Tab | undefined): GraphDef | undefined => {
  if (!tab) return undefined
  const definition = tab.store.doc.graphs[currentGraphId(tab)]
  return definition?.boundary ? definition : undefined
}

/**
 * Drill into a subgraph: record the definition AND the instance node the
 * user entered through. The instance path updates first so any subscriber
 * reacting to the stack change already sees a consistent pair.
 */
export function pushGraph(tab: Tab, defId: string, viaNode: string): void {
  tab.instancePath.update((p) => [...p, viaNode])
  tab.graphStack.update((s) => [...s, defId])
}

/** Navigate up: truncate the stack to `length` entries (breadcrumbs). */
export function truncateGraphStack(tab: Tab, length: number): void {
  tab.instancePath.update((p) => p.slice(0, Math.max(0, length - 1)))
  tab.graphStack.update((s) => s.slice(0, length))
}

/** Drop navigation suffixes whose occurrence/definition was removed by undo. */
export function reconcileGraphNavigation(tab: Tab): void {
  const path = tab.instancePath.get()
  const stack = tab.graphStack.get()
  const root = tab.store.doc.root
  let graphId: string = root
  let validHops = 0
  while (validHops < path.length && validHops + 1 < stack.length) {
    const node = tab.store.doc.graphs[graphId]?.nodes[path[validHops]!]
    const next = stack[validHops + 1]
    if (next === undefined || !occurrenceReferencesDefinition(node, next) || !tab.store.doc.graphs[next]) break
    graphId = next
    validHops += 1
  }
  if (stack[0] !== root || validHops !== path.length || stack.length !== path.length + 1) {
    tab.instancePath.set(path.slice(0, validHops))
    tab.graphStack.set([root, ...stack.slice(1, validHops + 1)])
  }
}

/** The exact occurrence-hop predicate shared by navigation and occurrence-scoped panels. */
export const occurrenceReferencesDefinition = (node: NodeData | undefined, definitionId: string): boolean =>
  node !== undefined && subgraphDefIdOf(node.type) === definitionId

/**
 * Jump to a saved navigation context (camera bookmarks): replace BOTH
 * signals with a consistent pair. Instance path first, same ordering
 * contract as pushGraph. Callers own validating the context against the
 * current document; this only performs the swap.
 */
export function restoreNavigation(tab: Tab, graphStack: readonly string[], instancePath: readonly string[]): void {
  tab.instancePath.set(instancePath)
  tab.graphStack.set(graphStack)
}

/**
 * Instance node ids from the root to the graph currently shown ([] at the
 * root). Undefined when the navigation signals are out of sync (a direct
 * graphStack write bypassed pushGraph): callers must then abstain from
 * occurrence-exact overlays instead of guessing which instance is meant.
 */
export function viewInstancePath(tab: Tab): readonly string[] | undefined {
  const stack = tab.graphStack.get()
  const path = tab.instancePath.get()
  return path.length === stack.length - 1 ? path : undefined
}

export interface DiagnosticFocusPlan {
  readonly graphStack: readonly string[]
  readonly instancePath: readonly string[]
  readonly nodeId: string
}

/**
 * Resolve a diagnostic's node occurrence against the current document.
 * Qualified compile anchors carry their full subgraph instance path;
 * port-only solver anchors use the caller's validated current view path.
 * Any stale hop or node returns undefined so activation silently no-ops.
 */
export function diagnosticFocusPlan(
  doc: WorkflowDocument,
  anchor: DiagnosticAnchor | undefined,
  portInstancePath: readonly string[] = [],
): DiagnosticFocusPlan | undefined {
  const occurrence = anchor?.occurrence ?? (anchor?.port
    ? { instancePath: portInstancePath.map(asNodeId), node: anchor.port.node }
    : undefined)
  if (!occurrence) return undefined
  const resolved = resolveNodeOccurrence(doc, occurrence)
  return resolved === undefined
    ? undefined
    : {
        graphStack: resolved.graphStack,
        instancePath: resolved.instancePath,
        nodeId: resolved.nodeId,
      }
}

/** Pick the owner tab and validate its current document without mutating app state. */
export function diagnosticFocusTarget(
  tabs: readonly Tab[],
  activeTabId: string,
  diagnostic: Diagnostic | OwnedDiagnostic,
): { readonly tab: Tab; readonly plan: DiagnosticFocusPlan } | undefined {
  const owner = 'owner' in diagnostic && typeof diagnostic.owner === 'string'
    ? diagnostic.owner
    : activeTabId
  const tab = tabs.find((candidate) => candidate.id === owner)
  const path = tab ? viewInstancePath(tab) : undefined
  const plan = tab && path !== undefined ? diagnosticFocusPlan(tab.store.doc, diagnostic.anchor, path) : undefined
  return tab && plan ? { tab, plan } : undefined
}

// ---------------------------------------------------------------------------
// Extension gate persistence (local, per-browser; deployment policy is the
// embedding host's channel, never stored here)
// ---------------------------------------------------------------------------

/** This frontend build's version, recorded in environment stamps it writes. */
const FRONTEND_VERSION: string = (pkg as { version: string }).version

const GATES_KEY = 'dinkster.extensionGates'

function loadGates(): GateState {
  try {
    const raw = globalThis.localStorage?.getItem(GATES_KEY)
    if (!raw) return emptyGates
    const parsed = JSON.parse(raw) as Partial<GateState>
    return {
      packs: parsed.packs ?? {},
      categories: parsed.categories ?? {},
      contributions: parsed.contributions ?? {},
    }
  } catch {
    return emptyGates // malformed/unavailable storage never blocks startup
  }
}

function saveGates(gates: GateState): void {
  try {
    globalThis.localStorage?.setItem(GATES_KEY, JSON.stringify(gates))
  } catch {
    // Storage unavailable (private mode, tests): gating still works in-session.
  }
}

// ---------------------------------------------------------------------------
// Open-tab persistence: a refresh must never lose working documents, saved
// or not. Live tabs (title + raw document bytes) and the active tab id are
// mirrored into browser storage on every mutation; frozen execution views
// are session-only (they are read-only projections of the execution store,
// which does not survive a refresh either). Versioned envelope: any parse
// failure or version mismatch falls back to the fixture seed tabs.
// ---------------------------------------------------------------------------

const TABS_KEY = 'dinkster.openTabs'
const TABS_CANDIDATE_PREFIX = 'dinkster.openTabsCandidate.'
const DOCUMENT_CANDIDATE_PREFIX = 'dinkster.openTabsDocumentCandidate.'
const WORKSPACE_OPERATION_PREFIX = 'dinkster.workspaceOperation.'
const WORKSPACE_PERSISTENCE_LOCK = 'dinkster.openTabs.commit'

// Per-project storage/lock names, resolved lazily so the project scope set
// during bootstrap (before AppState construction) is what gets applied. The
// default project resolves to the unprefixed names above.
const tabsKey = (): string => scopedStorageKey(TABS_KEY)
const tabsCandidatePrefix = (): string => scopedStorageKey(TABS_CANDIDATE_PREFIX)
const documentCandidatePrefix = (): string => scopedStorageKey(DOCUMENT_CANDIDATE_PREFIX)
const workspaceOperationPrefix = (): string => scopedStorageKey(WORKSPACE_OPERATION_PREFIX)
const workspacePersistenceLock = (): string => scopedSharedName(WORKSPACE_PERSISTENCE_LOCK)

const LEGACY_TAB_VIEW_UPDATE: TabViewUpdate = { updatedAt: 0, sequence: 0, actorId: '' }

function parseTabViewUpdate(value: unknown): TabViewUpdate | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as { updatedAt?: unknown; sequence?: unknown; actorId?: unknown }
  return Number.isSafeInteger(raw.updatedAt) && (raw.updatedAt as number) >= 0 &&
    Number.isSafeInteger(raw.sequence) && (raw.sequence as number) >= 0 &&
    typeof raw.actorId === 'string'
    ? { updatedAt: raw.updatedAt as number, sequence: raw.sequence as number, actorId: raw.actorId }
    : undefined
}

function parseTabViewState(value: unknown): TabViewState | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as {
    graphViewports?: unknown
    appScroll?: unknown
    appScrollTop?: unknown
    appScrollUpdate?: unknown
  }
  const graphViewports = raw.graphViewports !== null && typeof raw.graphViewports === 'object' && !Array.isArray(raw.graphViewports)
    ? Object.fromEntries(Object.entries(raw.graphViewports).flatMap(([graphId, candidate]) => {
        if (graphId.length === 0 || candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return []
        const viewport = candidate as { x?: unknown; y?: unknown; scale?: unknown; update?: unknown }
        return Number.isFinite(viewport.x) && Number.isFinite(viewport.y) &&
          Number.isFinite(viewport.scale) && (viewport.scale as number) >= MIN_SCALE && (viewport.scale as number) <= MAX_SCALE
          ? [[graphId, {
              x: viewport.x as number,
              y: viewport.y as number,
              scale: viewport.scale as number,
              update: parseTabViewUpdate(viewport.update) ?? LEGACY_TAB_VIEW_UPDATE,
            }]]
          : []
      }))
    : {}
  const rawAppScroll = raw.appScroll !== null && typeof raw.appScroll === 'object' && !Array.isArray(raw.appScroll)
    ? raw.appScroll as { scrollTop?: unknown; update?: unknown }
    : undefined
  const rawAppScrollTop = rawAppScroll?.scrollTop ?? raw.appScrollTop
  const validAppScrollTop = Number.isFinite(rawAppScrollTop) && (rawAppScrollTop as number) >= 0
  const appScrollTop = validAppScrollTop
    ? rawAppScrollTop as number
    : 0
  const appScrollUpdate = validAppScrollTop
    ? parseTabViewUpdate(rawAppScroll?.update) ?? parseTabViewUpdate(raw.appScrollUpdate) ??
      (appScrollTop > 0 ? LEGACY_TAB_VIEW_UPDATE : undefined)
    : undefined
  return Object.keys(graphViewports).length > 0 || appScrollUpdate !== undefined
    ? {
        graphViewports,
        ...(appScrollUpdate === undefined ? {} : { appScroll: { scrollTop: appScrollTop, update: appScrollUpdate } }),
      }
    : undefined
}

function compareTabViewUpdates(left: TabViewUpdate, right: TabViewUpdate): number {
  // Time wins; sequence orders one window's same-tick writes and actor id breaks cross-window ties.
  if (left.updatedAt !== right.updatedAt) return left.updatedAt - right.updatedAt
  if (left.actorId === right.actorId) return left.sequence - right.sequence
  return left.actorId.localeCompare(right.actorId)
}

function mergeTabViewStates(left: TabViewState | undefined, right: TabViewState | undefined): TabViewState | undefined {
  if (left === undefined) return right
  if (right === undefined) return left
  const graphViewports = { ...left.graphViewports }
  for (const [graphId, viewport] of Object.entries(right.graphViewports)) {
    const current = graphViewports[graphId]
    if (current !== undefined && compareTabViewUpdates(viewport.update, current.update) < 0) continue
    graphViewports[graphId] = viewport
  }
  let appScroll = left.appScroll
  if (right.appScroll !== undefined &&
    (appScroll === undefined || compareTabViewUpdates(right.appScroll.update, appScroll.update) >= 0)) {
    appScroll = right.appScroll
  }
  return {
    graphViewports,
    ...(appScroll === undefined ? {} : { appScroll }),
  }
}

function tabViewStateForDocument(state: TabViewState | undefined, doc: unknown): TabViewState | undefined {
  if (state === undefined) return undefined
  const graphs = doc !== null && typeof doc === 'object' && !Array.isArray(doc)
    ? (doc as { graphs?: unknown }).graphs
    : undefined
  const graphRecord = graphs !== null && typeof graphs === 'object' && !Array.isArray(graphs)
    ? graphs as Readonly<Record<string, unknown>>
    : {}
  const graphViewports = Object.fromEntries(Object.entries(state.graphViewports)
    .filter(([graphId]) => Object.prototype.hasOwnProperty.call(graphRecord, graphId)))
  if (Object.keys(graphViewports).length === 0 && state.appScroll === undefined) return undefined
  return {
    graphViewports,
    ...(state.appScroll === undefined ? {} : { appScroll: state.appScroll }),
  }
}

interface PersistedTabs {
  readonly v: 1
  readonly active: string
  readonly workspaceRevision?: number
  readonly workspaceOperationWatermarks?: Readonly<Record<string, number>>
  /** Covered slots stay in storage because deleting one can race a newer stage for the same lineage. */
  readonly documentCandidateStages?: Readonly<Record<string, string>>
  /**
   * `stock` marks a still-pristine app-shipped seed tab (see stockPending):
   * it survives reloads so a seed that ran unmigrated on a V1 backend keeps
   * its silent-baseline-migration entitlement when a later session targets a
   * native backend. Persisted ONLY while the tab is unedited; absent
   * otherwise.
   */
  readonly tabs: readonly {
    readonly title: string
    readonly doc: unknown
    readonly documentRevision?: number
    readonly documentDirty?: true
    readonly stock?: true
    /** Center-region editor kind; absent = graph (pre-2.4 snapshots). */
    readonly editorKind?: string
    /** Browser-local editor position; never sent to the workspace authority. */
    readonly viewState?: TabViewState
  }[]
}

function parsePersistedTabs(raw: string | null): PersistedTabs | undefined {
  try {
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<PersistedTabs>
    if (parsed.v !== 1 || !Array.isArray(parsed.tabs)) return undefined
    return {
      v: 1,
      active: typeof parsed.active === 'string' ? parsed.active : '',
      ...(Number.isSafeInteger(parsed.workspaceRevision) && parsed.workspaceRevision! >= 0
        ? { workspaceRevision: parsed.workspaceRevision }
        : {}),
      ...(parsed.documentCandidateStages !== null && typeof parsed.documentCandidateStages === 'object'
        ? { documentCandidateStages: Object.fromEntries(
            Object.entries(parsed.documentCandidateStages).filter(([lineage, stageId]) =>
              lineage.length > 0 && typeof stageId === 'string' && stageId.length > 0),
          ) }
        : {}),
      ...(parsed.workspaceOperationWatermarks !== null && typeof parsed.workspaceOperationWatermarks === 'object'
        ? { workspaceOperationWatermarks: Object.fromEntries(
            Object.entries(parsed.workspaceOperationWatermarks).filter(([actorId, sequence]) =>
              actorId.length > 0 && Number.isSafeInteger(sequence) && sequence >= 0),
          ) }
        : {}),
      tabs: parsed.tabs
        .filter(
          (t): t is { title: string; doc: unknown; documentRevision?: unknown; documentDirty?: unknown; stock?: unknown; editorKind?: unknown; viewState?: unknown } =>
            typeof t === 'object' && t !== null && typeof (t as { title?: unknown }).title === 'string',
        )
        .map((t) => {
          const viewState = parseTabViewState(t.viewState)
          return {
            title: t.title,
            doc: t.doc,
            ...(typeof t.documentRevision === 'number' && Number.isSafeInteger(t.documentRevision) && t.documentRevision >= 0
              ? { documentRevision: t.documentRevision }
              : {}),
            ...(t.documentDirty === true ? { documentDirty: true as const } : {}),
            ...(t.stock === true ? { stock: true as const } : {}),
            ...(typeof t.editorKind === 'string' && t.editorKind.length > 0 && !isSessionOnlyEditorKind(t.editorKind)
              ? { editorKind: t.editorKind }
              : {}),
            ...(viewState === undefined ? {} : { viewState }),
          }
        }),
    }
  } catch {
    return undefined // corrupt/unavailable storage never blocks startup
  }
}

function persistedTabId(tab: PersistedTabs['tabs'][number]): string | undefined {
  if (typeof tab.doc !== 'object' || tab.doc === null) return undefined
  const lineage = (tab.doc as { lineage?: unknown }).lineage
  return typeof lineage === 'string' && lineage.length > 0 ? lineage : undefined
}

function committedPersistedTab(
  tab: PersistedTabs['tabs'][number],
  documentRevision = tab.documentRevision ?? 0,
): PersistedTabs['tabs'][number] {
  const { documentDirty: _documentDirty, ...committed } = tab
  return { ...committed, documentRevision }
}

interface PersistedDocumentCandidate {
  readonly v: 1
  readonly stageId: string
  readonly tab: PersistedTabs['tabs'][number]
}

function parsePersistedDocumentCandidate(raw: string | null): PersistedDocumentCandidate | undefined {
  try {
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as Partial<PersistedDocumentCandidate>
    if (parsed.v !== 1 || typeof parsed.stageId !== 'string' || parsed.stageId.length === 0 ||
      typeof parsed.tab !== 'object' || parsed.tab === null) return undefined
    const tab = parsePersistedTabs(JSON.stringify({ v: 1, active: '', tabs: [parsed.tab] }))?.tabs[0]
    if (!tab) return undefined
    if (!persistedTabId(tab)) return undefined
    return { v: 1, stageId: parsed.stageId, tab }
  } catch {
    return undefined
  }
}

function mergePersistedTabs(
  states: readonly PersistedTabs[],
  documentCandidates: readonly PersistedDocumentCandidate[],
): PersistedTabs | undefined {
  let workspace: PersistedTabs | undefined
  for (const state of states) {
    if (!workspace || (state.workspaceRevision ?? 0) >= (workspace.workspaceRevision ?? 0)) workspace = state
  }
  if (!workspace) return undefined
  const documents = new Map<string, PersistedTabs['tabs'][number]>()
  const viewStates = new Map<string, TabViewState>()
  for (const state of states) for (const tab of state.tabs) {
    const id = persistedTabId(tab)
    if (!id) continue
    const mergedViewState = mergeTabViewStates(viewStates.get(id), tab.viewState)
    if (mergedViewState !== undefined) viewStates.set(id, mergedViewState)
    const current = documents.get(id)
    if (!current) {
      documents.set(id, committedPersistedTab(
        tab,
        (tab.documentRevision ?? 0) + (tab.documentDirty === true ? 1 : 0),
      ))
      continue
    }
    const incomingRevision = tab.documentRevision ?? 0
    const currentRevision = current.documentRevision ?? 0
    if (tab.documentDirty === true && JSON.stringify(tab.doc) !== JSON.stringify(current.doc)) {
      documents.set(id, committedPersistedTab(tab, currentRevision + 1))
    } else if (incomingRevision > currentRevision) {
      documents.set(id, committedPersistedTab(tab))
    }
  }
  const documentCandidateStages = { ...(states[0]?.documentCandidateStages ?? {}) }
  for (const candidate of documentCandidates) {
    const id = persistedTabId(candidate.tab)
    if (!id || documentCandidateStages[id] === candidate.stageId) continue
    const current = documents.get(id)
    if (!current) continue
    if (JSON.stringify(candidate.tab.doc) !== JSON.stringify(current.doc)) {
      documents.set(id, committedPersistedTab(
        candidate.tab,
        Math.max(candidate.tab.documentRevision ?? 0, current.documentRevision ?? 0) + 1,
      ))
    }
    documentCandidateStages[id] = candidate.stageId
  }
  return {
    ...workspace,
    ...(Object.keys(documentCandidateStages).length > 0 ? { documentCandidateStages } : {}),
    tabs: workspace.tabs.map((tab) => {
      const id = persistedTabId(tab)
      const document = id ? documents.get(id) : undefined
      const mergedTab = document ? committedPersistedTab({
        ...tab,
        doc: document.doc,
        ...(document.documentRevision === undefined ? {} : { documentRevision: document.documentRevision }),
      }) : tab
      const { viewState: _viewState, ...withoutViewState } = mergedTab
      const viewState = id ? tabViewStateForDocument(viewStates.get(id), mergedTab.doc) : undefined
      return {
        ...withoutViewState,
        ...(viewState === undefined ? {} : { viewState }),
      }
    }),
  }
}

function loadPersistedTabStates(): {
  readonly states: readonly PersistedTabs[]
  readonly candidates: readonly { readonly key: string; readonly raw: string }[]
  readonly documentCandidates: readonly PersistedDocumentCandidate[]
} {
  const states: PersistedTabs[] = []
  const candidates: { key: string; raw: string }[] = []
  const documentCandidates: PersistedDocumentCandidate[] = []
  try {
    const storage = globalThis.localStorage
    if (!storage) return { states, candidates, documentCandidates }
    const canonical = parsePersistedTabs(storage.getItem(tabsKey()))
    if (canonical) states.push(canonical)
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (key?.startsWith(documentCandidatePrefix())) {
        const candidate = parsePersistedDocumentCandidate(storage.getItem(key))
        if (candidate && key === `${documentCandidatePrefix()}${encodeURIComponent(persistedTabId(candidate.tab)!)}`) {
          documentCandidates.push(candidate)
        }
        continue
      }
      if (!key?.startsWith(tabsCandidatePrefix())) continue
      const raw = storage.getItem(key)
      const candidate = parsePersistedTabs(raw)
      if (!raw || !candidate) continue
      candidates.push({ key, raw })
      states.push(candidate)
    }
  } catch {
    return { states, candidates, documentCandidates }
  }
  return { states, candidates, documentCandidates }
}

function loadPersistedTabs(): PersistedTabs | undefined {
  const loaded = loadPersistedTabStates()
  return mergePersistedTabs(loaded.states, loaded.documentCandidates)
}

function persistWorkspaceOperation(mutation: WorkspaceTabMutation): void {
  try {
    globalThis.localStorage?.setItem(`${workspaceOperationPrefix()}${mutation.opId}`, JSON.stringify(mutation))
  } catch {
    // Storage unavailable/full: the live SharedWorker remains authoritative.
  }
}

function loadWorkspaceOperations(): readonly WorkspaceTabMutation[] {
  const operations: WorkspaceTabMutation[] = []
  try {
    const storage = globalThis.localStorage
    if (!storage) return operations
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(workspaceOperationPrefix())) continue
      const raw = storage.getItem(key)
      if (!raw) continue
      const operation = JSON.parse(raw) as WorkspaceTabMutation
      if (typeof operation.opId === 'string' && key === `${workspaceOperationPrefix()}${operation.opId}`) {
        operations.push(operation)
      }
    }
  } catch {
    return []
  }
  return orderWorkspaceOperations(operations)
}

export function orderWorkspaceOperations(
  operations: readonly WorkspaceTabMutation[],
): readonly WorkspaceTabMutation[] {
  return [...operations].sort((left, right) => {
    if (left.actorId === right.actorId) return left.sequence - right.sequence
    return left.baseRevision - right.baseRevision || left.actorId.localeCompare(right.actorId)
  })
}

function removeWorkspaceOperation(opId: string): void {
  try {
    globalThis.localStorage?.removeItem(`${workspaceOperationPrefix()}${opId}`)
  } catch {
    // A harmless replay remains if storage is unavailable during cleanup.
  }
}

function commitPersistedTabs(
  state: PersistedTabs,
  actorId: string,
  acknowledged: readonly { readonly opId: string; readonly revision: number }[],
  onCommitted: (retired: readonly string[], committed: PersistedTabs) => void,
): void {
  const storage = globalThis.localStorage
  if (!storage) return
  try {
    // Each document's shared slot makes setItem itself the cross-renderer staging order.
    for (const tab of state.tabs) {
      const id = persistedTabId(tab)
      if (!id || tab.documentDirty !== true) continue
      const candidate: PersistedDocumentCandidate = { v: 1, stageId: randomWorkspaceId('stage'), tab }
      storage.setItem(`${documentCandidatePrefix()}${encodeURIComponent(id)}`, JSON.stringify(candidate))
    }
    // pagehide cannot await Web Locks, so leave a synchronous workspace recovery source too.
    storage.setItem(`${tabsCandidatePrefix()}${actorId}`, JSON.stringify({
      ...state,
      // Not a tacit callback: map would pass the index as documentRevision.
      tabs: state.tabs.map((tab) => committedPersistedTab(tab)),
    }))
  } catch {
    return
  }
  const commit = (): void => {
    try {
      const loaded = loadPersistedTabStates()
      const merged = mergePersistedTabs(loaded.states, loaded.documentCandidates)
      if (!merged) return
      storage.setItem(tabsKey(), JSON.stringify(merged))
      const retired = acknowledged
        .filter(({ revision }) => revision <= (merged.workspaceRevision ?? 0))
        .map(({ opId }) => opId)
      for (const opId of retired) removeWorkspaceOperation(opId)
      for (const candidate of loaded.candidates) {
        if (storage.getItem(candidate.key) === candidate.raw) storage.removeItem(candidate.key)
      }
      onCommitted(retired, merged)
    } catch {
      // Storage unavailable/full: tabs still work in-session and journals remain.
    }
  }
  const locks = globalThis.navigator?.locks
  if (locks) {
    void locks.request(workspacePersistenceLock(), { mode: 'exclusive' }, commit).catch(() => undefined)
  } else commit()
}

// ---------------------------------------------------------------------------
// Backend persistence: user-added backends survive a reload (URL, label,
// discovered protocol). The same-origin default is NEVER persisted - it is
// re-derived at startup (constructor + discovery), so a stale record can
// never shadow it. Versioned envelope like tabs; corrupt storage means
// "no extra backends", never a startup failure.
// ---------------------------------------------------------------------------

export const BACKENDS_KEY = 'dinkster.backends'

/** Per-project backend list; the default project keeps the legacy key. */
const backendsKey = (): string => scopedStorageKey(BACKENDS_KEY)

/**
 * Canonicalize a backend address so aliases of the same server collide in
 * the duplicate check instead of becoming a second connection. In
 * particular an absolute URL naming THIS origin's root (e.g. the address
 * bar pasted back in) canonicalizes to '' - the same-origin default's base
 * URL - so it can never bypass the "default is never persisted" invariant.
 * Path-prefix backends ('/b2') and absolute URLs with a path stay distinct.
 */
export function canonicalBackendUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const sameOriginRoot =
        url.origin === globalThis.location?.origin &&
        (url.pathname === '' || url.pathname === '/') &&
        !url.search
      if (sameOriginRoot) return ''
    } catch {
      // Unparseable: leave as typed; discovery will name the failure.
    }
  }
  return trimmed
}

export interface PersistedBackend {
  readonly baseUrl: string
  readonly label: string
  readonly protocol: BackendProtocol
}

interface PersistedBackends {
  readonly v: 1
  readonly backends: readonly PersistedBackend[]
}

function decodePersistedBackends(raw: string | null): readonly PersistedBackend[] | undefined {
  if (raw === null) return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedBackends>
    if (parsed.v !== 1 || !Array.isArray(parsed.backends)) return undefined
    return parsed.backends.filter(
      (b): b is PersistedBackend =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as { baseUrl?: unknown }).baseUrl === 'string' &&
        (b as { baseUrl?: unknown }).baseUrl !== '' &&
        typeof (b as { label?: unknown }).label === 'string' &&
        ((b as { protocol?: unknown }).protocol === 'v1' ||
          (b as { protocol?: unknown }).protocol === 'dinkster'),
    )
  } catch {
    return undefined
  }
}

function readPersistedBackends(): readonly PersistedBackend[] | undefined {
  try {
    const raw = globalThis.localStorage?.getItem(backendsKey()) ?? null
    return raw === null ? [] : decodePersistedBackends(raw)
  } catch {
    return undefined
  }
}

function loadPersistedBackends(): readonly PersistedBackend[] {
  return readPersistedBackends() ?? [] // corrupt/unavailable storage never blocks startup
}

export interface BackendListRebase {
  readonly adds: readonly PersistedBackend[]
  readonly removes: readonly PersistedBackend[]
  readonly keeps: readonly PersistedBackend[]
}

/**
 * Derive one backend-list write as identity-stable operations. Storage events
 * provide both lists: `current` is oldValue and `incoming` is newValue. The
 * caller applies these operations to its LIVE list, so an edit made locally
 * after the other tab started its write is not mistaken for an external
 * removal. A kept identity deliberately retains this tab's runtime Backend.
 */
export function rebaseBackendLists(
  current: readonly PersistedBackend[],
  incoming: readonly PersistedBackend[],
): BackendListRebase {
  const currentIds = new Set(current.map((backend) => canonicalBackendUrl(backend.baseUrl)))
  const incomingIds = new Set(incoming.map((backend) => canonicalBackendUrl(backend.baseUrl)))
  return {
    adds: incoming.filter((backend) => !currentIds.has(canonicalBackendUrl(backend.baseUrl))),
    removes: current.filter((backend) => !incomingIds.has(canonicalBackendUrl(backend.baseUrl))),
    keeps: current.filter((backend) => incomingIds.has(canonicalBackendUrl(backend.baseUrl))),
  }
}

function savePersistedBackends(backends: readonly PersistedBackend[]): void {
  try {
    globalThis.localStorage?.setItem(
      backendsKey(),
      JSON.stringify({ v: 1, backends } satisfies PersistedBackends),
    )
  } catch {
    // Storage unavailable/full: backends still work in-session.
  }
}

// ---------------------------------------------------------------------------
// Collab membership persistence: which shared sessions this browser's tabs
// were joined to, so a reload REJOINS instead of silently downgrading the
// tab to a local fork (docs/collaboration.md "Reload rejoin"). Only the
// membership (session id + where it lives + document lineage + tab title)
// persists - the
// authoritative document is the server's; the persisted TAB doc is merely
// the offline fallback when the session is gone or unreachable. Versioned
// envelope like tabs/backends; corrupt storage means "no memberships".
// ---------------------------------------------------------------------------

const COLLAB_SESSIONS_KEY = 'dinkster.collabSessions'

/** Memberships describe a project's tabs, so they scope with the project. */
const collabSessionsKey = (): string => scopedStorageKey(COLLAB_SESSIONS_KEY)

export interface PersistedCollabMembership {
  readonly sessionId: string
  readonly baseUrl: string
  /**
   * The shared document's lineage = the id of the tab this membership
   * belongs to. Rejoin uses it to bind the membership to its RESTORED tab
   * up front (a membership whose tab was not restored is dropped, never
   * adopted into a fresh appended tab), and explicit close/replace of that
   * tab uses it to kill a still-pending record.
   */
  readonly documentId: string
  readonly title: string
}

interface PersistedCollabMemberships {
  readonly v: 1
  readonly sessions: readonly PersistedCollabMembership[]
}

function loadPersistedCollabMemberships(): readonly PersistedCollabMembership[] {
  try {
    const raw = globalThis.localStorage?.getItem(collabSessionsKey())
    if (!raw) return []
    const parsed = JSON.parse(raw) as Partial<PersistedCollabMemberships>
    if (parsed.v !== 1 || !Array.isArray(parsed.sessions)) return []
    return parsed.sessions.filter(
      (s): s is PersistedCollabMembership =>
        typeof s === 'object' &&
        s !== null &&
        typeof (s as { sessionId?: unknown }).sessionId === 'string' &&
        (s as { sessionId: string }).sessionId !== '' &&
        typeof (s as { baseUrl?: unknown }).baseUrl === 'string' &&
        typeof (s as { documentId?: unknown }).documentId === 'string' &&
        (s as { documentId: string }).documentId !== '' &&
        typeof (s as { title?: unknown }).title === 'string',
    )
  } catch {
    return [] // corrupt/unavailable storage never blocks startup
  }
}

function savePersistedCollabMemberships(sessions: readonly PersistedCollabMembership[]): void {
  try {
    globalThis.localStorage?.setItem(
      collabSessionsKey(),
      JSON.stringify({ v: 1, sessions } satisfies PersistedCollabMemberships),
    )
  } catch {
    // Storage unavailable/full: sessions still work in-session.
  }
}

/** One membership identity: the same sessionId on two backends is two memberships. */
const collabMembershipKey = (baseUrl: string, sessionId: string): string => `${baseUrl}\n${sessionId}`

/**
 * Rejoin refusal: the restored tab a rejoin would replace was closed (or
 * replaced) while the probe/connect was in flight. Deliberately NOT a
 * transient failure - retrying would resurrect a tab the user just closed.
 */
class CollabRejoinTabGoneError extends Error {
  constructor() {
    super('the restored tab was closed before its shared session could rejoin')
  }
}

/**
 * Join refusal: the session settled closed/error during the join itself (a
 * session_closed frame buffered by the transport replays synchronously at
 * subscription). Definite, not transient - a rejoin hitting this must drop
 * its persisted record rather than retry a session that is gone for everyone.
 */
class CollabSessionEndedDuringJoinError extends Error {
  constructor() {
    super('the session ended while it was being joined')
  }
}

/**
 * Which wire protocol a backend speaks: 'v1' is a ComfyUI server
 * (/object_info, /prompt, /ws), 'dinkster' is a native Dinkster server
 * (/api/nodes, /api/jobs, /api/events). Chosen when the backend is added;
 * both normalize into the SAME event/model pipeline, so protocol never
 * leaks past the connection layer - the app dispatches on it only where
 * the protocols genuinely differ (reconcile, output hydration, /view).
 */
export type BackendProtocol = 'v1' | 'dinkster'

export type WorkerCatalogState =
  | { readonly status: 'unsupported' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly workers: readonly WorkerInfo[] }
  | { readonly status: 'error'; readonly message: string }

interface BackendBase {
  readonly id: ConnectionId
  readonly label: string
  readonly baseUrl: string
  readonly registry: Signal<SchemaRegistry | undefined>
  /** Execution locations advertised by the current native server life. */
  readonly workerCatalog: Signal<WorkerCatalogState>
  /** Current schema request state for truthful backend-management feedback. */
  readonly schemaState: Signal<
    | { readonly status: 'idle' | 'loading' | 'waiting' | 'ready' }
    | { readonly status: 'error'; readonly message: string }
  >
  /**
   * The server's advisory replacement-rule diagnostics (native backends;
   * always [] on v1). Fetched alongside the registry so the deprecation UX
   * can explain a rule that cannot plan against this environment.
   */
  readonly replacementProblems: Signal<readonly ReplacementProblem[]>
  /** ComfyUI compatibility nodes omitted from the native catalog, with the
   * server's verbatim advisory reason. Always [] on v1 backends. */
  readonly compatSkips: Signal<readonly CompatSkip[]>
  /** Request the latest native advisory snapshot; a no-op on v1 backends. */
  readonly refreshDiagnostics: () => void
  readonly scopedClient: RefreshableScopedClient
  /** Clear remote-choice authority after a schema/server generation change. */
  readonly invalidateRemoteChoices: () => void
  /**
   * Last /supervisor/status answer (native backends behind a supervisor).
   * undefined = no supervisor known (standalone dinkster-serve, v1, or not
   * probed yet). Drives the "Dinkster is starting" shell affordance instead of
   * a connection-failure render (supervisor Ask 1).
   */
  readonly supervisor: Signal<SupervisorStatus | undefined>
  /**
   * Engine-level composition narration from /api/events
   * (composition_progress; cleared by composition_complete). Covers the
   * direct-to-engine deployment where no supervisor carries progress.
   */
  readonly composition: Signal<SupervisorProgress | undefined>
  /** Tear down event/status subscriptions on removal. */
  readonly dispose: () => void
}

/**
 * One backend, whole: connection, ITS schema registry (never merged with
 * other backends' - packs/versions differ per server), and ITS scoped client
 * (remote combos differ per server). Executions carry (connectionId, prompt),
 * so the shared ExecutionStore needs no per-backend partitioning.
 * A discriminated union on `protocol`: the common surface (connect,
 * fetchSchemas, submit, onEvent, status) is identical on both connection
 * types; narrowing is only needed for protocol-specific calls.
 */
export type Backend =
  | (BackendBase & { readonly protocol: 'v1'; readonly connection: BackendConnection })
  | (BackendBase & { readonly protocol: 'dinkster'; readonly connection: DinksterConnection })

export interface AppLogEntry {
  readonly timestamp: number
  readonly severity: 'info' | 'warn' | 'error'
  readonly source: string
  readonly message: string
}

const descriptorWithId = <T extends object>(id: string, descriptor: T): T & { readonly id: string } => {
  const copy = Object.defineProperties({}, Object.getOwnPropertyDescriptors(descriptor))
  return Object.defineProperty(copy, 'id', { configurable: true, enumerable: true, value: id }) as T & { readonly id: string }
}

export class AppState {
  /** Default backend's connection (single-backend code path; always exists). */
  readonly connection: Backend['connection']
  readonly store = new ExecutionStore()
  /** Default backend's scoped client. */
  readonly scopedClient: RefreshableScopedClient
  /** UI-neutral live prompt inventory captured from the active tab's backend. */
  readonly liveEmbeddingAndLoraInventory: LiveEmbeddingAndLoraInventoryProvider
  readonly widgetRegistry = createWidgetRegistry()
  readonly textEditorExtensionRegistry = createTextWidgetEditorExtensionRegistry()
  /** Shared registration points used by core UI and extension packs alike. */
  readonly settings = new SettingsRegistry(globalThis.localStorage, scopedStorageKey(SETTINGS_STORAGE_KEY))
  readonly commands = new CommandRegistry()
  readonly keybindings = new KeybindingRegistry(this.settings)
  readonly hostUiContributions = new HostUiContributionRegistry()
  /**
   * The open modal panel id ('' = none). Session-only view state,
   * deliberately NOT persisted: modals are decision flows (docs/shell.md
   * "What is a modal"), and reloading into a blocking dialog would be
   * hostile. An id whose panel unregisters or moves off 'modal' is CLEARED
   * (constructor subscription on panels.changed), never retained: unlike
   * persisted dock ids there is no value in keeping it, and retaining it
   * would silently resurrect the dialog when the panel re-registers.
   */
  readonly modalPanel = createSignal('')
  /**
   * Shell geometry and bar visibility, persisted per-browser via settings.
   * Assigned in the constructor AFTER the core canvas/features/tooltips
   * setting registrations so its `shell.layout.*` settings keep registering
   * last and the settings dialog still opens on the canvas category.
   */
  readonly shell: ShellLayout
  /**
   * All tabbed dock zones: zone membership, tab order, active tab, and open
   * state, persisted as one validated setting. PanelRegistry keeps owning the
   * floating/window override, and panel-location.ts is the one move boundary
   * between the two.
   */
  readonly dock: DockLayout
  /**
   * Center-region split layout (editor-layout.ts), persisted as one
   * validated, project-scoped setting. Passive here: the shell repairs it
   * against the open-tab list at every read, so tab open/close/restore code
   * stays split-blind.
   */
  readonly editorSplits: EditorSplitStore
  /** Context-menu contributions; core registers through the same public API. */
  readonly menuRegistry = createMenuRegistry()
  readonly searchRegistry = createSearchRegistry()
  readonly searchOpen = createSignal(false)
  /** Node docs page requested by the canvas, palette, or F1 command. */
  readonly nodeHelpRequest = createSignal<NodeHelpRequest | undefined>(undefined)
  /**
   * Pending request to focus the Execution log panel on one scene node's
   * runtime occurrences (bottom-badge popover "Open in Execution log"). The
   * token makes each request distinct so repeating the same node re-applies
   * the filter; the panel consumes the request after applying it so a
   * remount never replays a stale one.
   */
  readonly executionLogFocus = createSignal<
    { readonly runtimeNodeIds: readonly string[]; readonly token: number } | undefined
  >(undefined)

  /**
   * Monotonic across the session, independent of the pending signal:
   * consuming a request must never let a later one reuse an earlier token,
   * or a mounted panel that remembers the applied token would ignore it.
   */
  private executionLogFocusToken = 0

  /** Open the Execution log panel filtered to these runtime nodes' rows. */
  requestExecutionLogFocus(runtimeNodeIds: readonly string[]): void {
    this.executionLogFocus.set({
      runtimeNodeIds,
      token: ++this.executionLogFocusToken,
    })
    setPanelOpen(this.panels, this.dock, 'execution-log', 'bottom', true)
  }

  /** The panel applied this focus request; stop it from replaying. */
  consumeExecutionLogFocus(token: number): void {
    if (this.executionLogFocus.get()?.token === token) this.executionLogFocus.set(undefined)
  }
  readonly placementStatus = createSignal<string | undefined>(undefined)
  /** Short-lived operation feedback rendered by the status bar. */
  readonly transientStatus = createSignal<string | undefined>(undefined)
  private transientStatusTimer: ReturnType<typeof setTimeout> | undefined
  readonly settingsOpenRequest = createSignal<{ readonly category: string; readonly id: string } | undefined>(undefined)
  /** Control-surface types; extensions register through the same public API. */
  readonly surfaceRegistry = createSurfaceRegistry([modePanelSurface])
  /**
   * Shell panels are descriptors (identity, placement, component), and the
   * shell renders from them. The built-in shell registers panel descriptors
   * at App setup.
   */
  readonly panels = new PanelRegistry()
  /**
   * Center-region editor kinds (editors.ts): the shell resolves the active
   * tab's editorKind here. Built-in editor kinds are registered in App.tsx.
   */
  readonly editors = new EditorRegistry()
  readonly editorBindings = new EditorBindingRegistry()
  readonly extensionToolbarPanels = createSignal<readonly ExtensionPanelContributionV1[]>([])
  private readonly extensionEditorIds = new Set<string>()
  readonly frontendDoors = {
    widgetKind: (_id: string, kind: Parameters<typeof this.widgetRegistry.registerKind>[0]): (() => void) =>
      this.widgetRegistry.registerKind(kind),
    widgetView: (_id: string, view: Parameters<typeof this.widgetRegistry.registerView>[0]): (() => void) =>
      this.widgetRegistry.registerView(view),
    previewRenderer: (_id: string, renderer: Parameters<typeof this.widgetRegistry.registerPreviewRenderer>[0]): (() => void) =>
      this.widgetRegistry.registerPreviewRenderer(renderer),
    command: (id: string, command: Omit<AppCommand, 'id'>): (() => void) =>
      this.commands.register(descriptorWithId(id, command)),
    editor: (id: string, kind: Omit<EditorKindDescriptor, 'id'> | ExtensionEditorKind): (() => void) =>
      'component' in kind
        ? this.editors.register(descriptorWithId(id, kind))
        : this.registerExtensionEditor({ ...kind, id }),
    editorBinding: (id: string, binding: Omit<EditorBinding, 'id'>): (() => void) =>
      this.editorBindings.register({ ...binding, id }),
    panel: (id: string, panel: Omit<PanelDescriptor, 'id'> | Omit<ExtensionPanelContributionV1, 'id'>): (() => void) =>
      'component' in panel
        ? this.panels.register(descriptorWithId(id, panel))
        : this.registerExtensionPanel({ ...panel, id }),
  }
  /**
   * Pack frontend contributions and per-contribution gating: packs enumerate
   * features in a manifest, every feature is
   * individually toggleable, and disabling never touches the pack's NODES.
   * Gate overrides persist locally (browser storage), so a disabled panel
   * stays disabled across sessions.
   */
  private readonly extensionRevision = createSignal(0)
  private readonly extensionTargets: ExtensionHostOptions<TextWidgetEditorExtension> = {
    changedSignal: this.extensionRevision,
    menus: this.menuRegistry,
    widgets: this.widgetRegistry,
    registerTextEditorExtension: (extension) => this.textEditorExtensionRegistry.register(extension),
    registerSetting: (setting) => this.settings.register(setting),
    registerCommand: (command) => this.frontendDoors.command(command.id, command),
    registerKeybinding: (binding) => this.keybindings.register(binding),
    registerHostUi: (id, slot, provider, order, title) => this.hostUiContributions.register(id, slot, provider, order, title),
    invalidateHostUi: (id) => this.hostUiContributions.invalidate(id),
    registerSearchProvider: (provider) => this.searchRegistry.register(provider),
    registerEditor: (kind) => this.frontendDoors.editor(kind.id, kind),
    registerEditorBinding: (binding) => this.frontendDoors.editorBinding(binding.id, binding),
    registerPanel: (panel) => this.frontendDoors.panel(panel.id, panel),
    beginRegistryBatch: () => {
      const finishSettings = this.settings.beginBatch()
      const finishHostUi = this.hostUiContributions.beginBatch()
      const finishSearch = this.searchRegistry.beginBatch()
      return (commit) => {
        finishSearch(commit)
        finishHostUi(commit)
        finishSettings(commit)
      }
    },
    initialGates: loadGates(),
    onGatesChanged: saveGates,
  }
  private readonly localExtensions = new ExtensionHost(this.extensionTargets)
  private readonly extensionWorlds = new Map<ConnectionId, Map<string, ExtensionWorld>>()
  private readonly extensionWorldLoads = new WeakMap<ExtensionWorld, Promise<void>>()
  private readonly submissionWorlds = new Map<AbortController, { readonly tab: Tab; readonly world: ExtensionWorld | undefined }>()
  private readonly deniedExtensionPrivileges: readonly FrontendPrivilege[]
  private selectedExtensionWorld: ExtensionWorld | undefined

  get extensions(): ExtensionHost<TextWidgetEditorExtension> {
    return this.selectedExtensionWorld?.host ?? this.localExtensions
  }

  private registerExtensionEditor(kind: ExtensionEditorKind): () => void {
    const owner = Symbol(`extension-editor:${kind.id}`)
    const app = this
    const unregister = this.editors.register({
      id: kind.id,
      title: kind.title,
      component: (host) => createComponent(ExtensionEditorHost, {
        owner,
        provider: kind.provider,
        surface: 'editor',
        get data() {
          return { editor: kind.id, tabId: host?.tabId() ?? app.activeTabId.get() ?? null, focused: host?.focused() ?? true }
        },
        commands: this.commands,
        replaceProblems: (problemOwner, diagnostics) => this.replaceProblems(problemOwner, diagnostics),
        errorText: 'Unable to render extension editor.',
      }),
    })
    this.extensionEditorIds.add(kind.id)
    return () => {
      this.extensionEditorIds.delete(kind.id)
      unregister()
    }
  }

  private registerExtensionPanel(panel: ExtensionPanelContributionV1): () => void {
    if (panel.slot === 'toolbar.canvas') {
      this.extensionToolbarPanels.update((panels) => [...panels, panel]
        .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.id.localeCompare(right.id)))
      return () => this.extensionToolbarPanels.update((panels) => panels.filter((candidate) => candidate !== panel))
    }
    const placement = panel.slot === 'sidebar.left' ? 'dock' : panel.slot === 'sidebar.right' ? 'rail' : 'bottom'
    const owner = Symbol(`extension-panel:${panel.id}`)
    return this.panels.register({
      id: panel.id,
      title: panel.title ?? panel.id.slice(panel.id.lastIndexOf('.') + 1),
      placement,
      allowedPlacements: [placement],
      order: panel.order ?? 0,
      component: () => createComponent(HostUiProviderHost, {
        owner,
        provider: panel.provider,
        surface: 'panel',
        data: { panel: panel.id, slot: panel.slot },
        commands: this.commands,
        replaceProblems: (problemOwner, diagnostics) => this.replaceProblems(problemOwner, diagnostics),
        errorText: 'Unable to render extension panel.',
      }),
    })
  }

  private async prepareExtensionWorld(backend: Pick<Backend, 'id' | 'baseUrl'>, registry: SchemaRegistry): Promise<void> {
    const pair = registry.extensionSnapshotPair
    if (pair === undefined || this.disposed) return
    const connection = backend.id
    let worlds = this.extensionWorlds.get(connection)
    const existing = worlds?.get(pair.digest)
    if (existing) return this.extensionWorldLoads.get(existing)
    const world = new ExtensionWorld(connection, pair.digest, { ...this.extensionTargets, initialGates: loadGates() },
      (diagnostic) => this.reportProblems(GLOBAL_PROBLEMS_OWNER, [diagnostic]))
    if (worlds === undefined) {
      worlds = new Map()
      this.extensionWorlds.set(connection, worlds)
    }
    worlds.set(pair.digest, world)
    const loading = world.activate(pair.snapshot, backend.baseUrl, this.deniedExtensionPrivileges)
    this.extensionWorldLoads.set(world, loading)
    try { await loading } finally { this.extensionWorldLoads.delete(world) }
  }

  private pruneExtensionWorlds(): void {
    const retained = new Set<ExtensionWorld>()
    for (const { world } of this.submissionWorlds.values()) if (world) retained.add(world)
    const retain = (connection: ConnectionId, registry: SchemaRegistry | undefined): void => {
      const digest = registry?.extensionSnapshotPair?.digest
      const world = digest === undefined ? undefined : this.extensionWorlds.get(connection)?.get(digest)
      if (world) retained.add(world)
    }
    for (const backend of this.backends.get()) retain(backend.id, backend.registry.get())
    for (const execution of this.store.executions.get().values()) retain(execution.ref.connection, this.registryForExecution(execution.ref))
    for (const [connection, worlds] of this.extensionWorlds) {
      for (const [digest, world] of worlds) {
        if (retained.has(world) || (this.backendFor(connection) && this.extensionWorldLoads.has(world))) continue
        if (this.selectedExtensionWorld === world) this.selectedExtensionWorld = undefined
        world.dispose()
        worlds.delete(digest)
      }
      if (worlds.size === 0) this.extensionWorlds.delete(connection)
    }
  }

  /** A posted submission can outlive its tab and transfer ownership to a run. */
  private retainSubmissionWorld(tab: Tab, artifact: CompileArtifact): { readonly signal: AbortSignal; readonly release: () => void; readonly markPosted: () => void } {
    const registry = this.retainedRegistries.get(artifact)
    const digest = registry?.extensionSnapshotPair?.digest
    const world = digest === undefined ? undefined : this.extensionWorlds.get(artifact.connection)?.get(digest)
    const controller = new AbortController()
    let posted = false
    this.submissionWorlds.set(controller, { tab, world })
    const release = (): void => {
      if (!this.submissionWorlds.delete(controller)) return
      controller.abort()
      this.pruneExtensionWorlds()
    }
    controller.signal.addEventListener('abort', () => { if (!posted) release() }, { once: true })
    return { signal: controller.signal, release, markPosted: () => { posted = true } }
  }

  private selectExtensionWorld(): void {
    const tab = this.activeTab()
    const registry = tab ? this.registryForTab(tab) : this.backends.get()[0]?.registry.get()
    const connection = tab?.execution?.connection ?? (tab ? this.backendForTab(tab).id : this.backends.get()[0]?.id)
    const digest = registry?.extensionSnapshotPair?.digest
    const next = connection && digest ? this.extensionWorlds.get(connection)?.get(digest) : undefined
    if (next === this.selectedExtensionWorld) return
    const finish = this.extensionTargets.beginRegistryBatch!()
    this.selectedExtensionWorld?.select(false)
    this.selectedExtensionWorld = next
    try {
      next?.select(true)
    } catch (error) {
      this.selectedExtensionWorld = undefined
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('error', 'extension', 'extension.projection-failed', String(error))])
    } finally {
      finish(true)
      this.extensionRevision.update((value) => value + 1)
    }
  }
  /** Published by CanvasHost while mounted (see CanvasBridge). */
  readonly canvasBridge: Signal<CanvasBridge | undefined> = createSignal<CanvasBridge | undefined>(undefined)
  /** Bumped on every canvas selection change (panels re-read the bridge). */
  readonly selectionTick: Signal<number> = createSignal(0)
  /**
   * Selection facts CanvasHost publishes for context-scoped surfaces
   * (problem-context.ts): selected node, link, and group ids of the graph
   * currently rendered. Empty while no canvas is mounted.
   */
  readonly canvasSelection: Signal<CanvasSelectionSnapshot> = createSignal<CanvasSelectionSnapshot>(EMPTY_CANVAS_SELECTION)
  /**
   * The widget editor currently open on canvas, reduced to focus facts for
   * the Context panel. Undefined while no widget editor is open.
   */
  readonly widgetFocus: Signal<WidgetFocus | undefined> = createSignal<WidgetFocus | undefined>(undefined)

  /** Default backend's schema registry (single-backend code path). */
  readonly registry: Signal<SchemaRegistry | undefined>
  readonly tabs: Signal<readonly Tab[]> = createSignal<readonly Tab[]>([])
  readonly activeTabId: Signal<string> = createSignal('')
  /** Never serialized: identifies the active mask or graph-compositor image editing session. */
  readonly imageEditorTarget: Signal<ImageEditorTarget | CompositorEditorTarget | undefined> =
    createSignal<ImageEditorTarget | CompositorEditorTarget | undefined>(undefined)
  /** Never serialized: identifies the one input projected by the curve editor. */
  readonly curveEditorTarget: Signal<CurveEditorTarget | undefined> = createSignal<CurveEditorTarget | undefined>(undefined)
  /** Never serialized: identifies the first-party GLSL source editor session. */
  readonly glslEditorTarget: Signal<GlslEditorTarget | undefined> = createSignal<GlslEditorTarget | undefined>(undefined)
  /**
   * Live tab ids whose current document revision has not been written to the
   * workflow library. A signal, rather than a derived read of DocumentStore,
   * keeps framework adapters honest when a command changes only a document.
   */
  readonly dirtyTabs: Signal<ReadonlySet<string>> = createSignal<ReadonlySet<string>>(new Set())
  readonly problems: Signal<readonly OwnedDiagnostic[]> = createSignal<readonly OwnedDiagnostic[]>([])
  readonly assetConsent: Signal<AssetConsentRequest | undefined> = createSignal<AssetConsentRequest | undefined>(undefined)
  readonly importAssetResolution: Signal<ImportAssetResolutionRequest | undefined> = createSignal<ImportAssetResolutionRequest | undefined>(undefined)
  /**
   * Live solver diagnostics for the graph currently on the canvas (type
   * mismatches, stale DynamicSlot specializations, ...). Unlike the owned
   * reports and snapshots in `problems`, this is DERIVED state: CanvasHost
   * replaces it wholesale on every scene rebuild, so entries appear while
   * the condition holds and vanish when the document stops exhibiting it.
   */
  readonly solveDiagnostics: Signal<readonly Diagnostic[]> = createSignal<readonly Diagnostic[]>([])
  /** Problems-to-canvas handoff; CanvasHost revalidates the anchor before acting. */
  readonly diagnosticFocus: Signal<DiagnosticFocusRequest | undefined> = createSignal<DiagnosticFocusRequest | undefined>(undefined)
  readonly logs: Signal<readonly AppLogEntry[]> = createSignal<readonly AppLogEntry[]>([])
  /**
   * All connected backends; index 0 is the default (never removable). Most
   * users have exactly one and see none of the multi-backend chrome.
   */
  readonly backends: Signal<readonly Backend[]> = createSignal<readonly Backend[]>([])
  /**
   * Per-tab target backend (VIEW/session state, never serialized): live tab
   * id -> connection a queue submits to. Absent -> default backend. A stale
   * target (backend removed) also resolves to the default.
   */
  readonly tabTargets: Signal<ReadonlyMap<string, ConnectionId>> = createSignal<
    ReadonlyMap<string, ConnectionId>
  >(new Map())
  /**
   * Per-tab overlay pins (VIEW state, never serialized): live tab id -> the
   * execution its overlay is explicitly bound to. Unpinned tabs follow the
   * default binding policy (most recent matching run). Central map rather
   * than per-tab signals so the shell subscribes once.
   */
  readonly overlayPins: Signal<ReadonlyMap<string, ExecutionRef>> = createSignal<
    ReadonlyMap<string, ExecutionRef>
  >(new Map())
  /**
   * Browser-local editor positions keyed by live tab id. These persist with
   * open tabs, but never enter documents, WorkspaceTabRecord, or collab.
   */
  private readonly tabViewStates: Signal<ReadonlyMap<string, TabViewState>> = createSignal<
    ReadonlyMap<string, TabViewState>
  >(new Map())
  /**
   * Per-tab canvas lens (VIEW state, never serialized): tab id -> active
   * lens. Absent -> 'standard'. Lenses change canvas presentation
   * (data-lens.ts); they never touch document or execution semantics, and
   * work on frozen tabs too (inspecting a past run is their best use).
   */
  readonly lenses: Signal<ReadonlyMap<string, CanvasLens>> = createSignal<
    ReadonlyMap<string, CanvasLens>
  >(new Map())
  readonly lensRegistry = createCoreLensRegistry()
  /**
   * Bumped whenever any backend's registry or status changes (each Backend
   * has its OWN core signals; the shell subscribes to this one instead of
   * rebinding per backend). Same pattern as CanvasHost's docTick.
   */
  readonly backendsTick: Signal<number> = createSignal(0)

  /**
   * Tabs currently joined to a shared session, keyed by tab id. Session-only
   * view of live memberships (never persisted - a reload rejoins explicitly
   * through the collab panel); the entry's session IS the tab's store.
   */
  readonly collabTabs: Signal<ReadonlyMap<string, CollabTabState>> = createSignal<ReadonlyMap<string, CollabTabState>>(new Map())
  /** This browser's durable collab identity (joint actorId pin; collab.ts). */
  collabActorId: string
  readonly collabTransport: CollabTransport
  /**
   * Single-flight keys for in-progress collab operations (`share:<tabId>`,
   * `join:<sessionId>`): a second identical request while the first's awaits
   * are in flight is refused instead of creating a duplicate server session
   * or a racing second membership.
   */
  private readonly collabPending = new Set<string>()

  /** Local multi-window sessions owned by the same-origin SharedWorker. */
  private readonly workspaceSessions = new Map<string, { readonly tab: Tab; readonly session: SharedDocumentSession }>()
  private readonly workspacePromotions = new Map<string, { tab: Tab; promise: Promise<void> }>()
  private readonly workspaceReplacements = new WeakSet<Tab>()
  private workspaceAuthorityEnabled = false
  private workspaceAuthorityDesired = false
  private workspacePortFactory: SharedWorkerPortFactory | undefined
  private workspaceTabsPortFactory: WorkspaceWorkerPortFactory | undefined
  private workspaceTabConnection: SharedWorkerTabConnection | undefined
  private workspaceAuthorityGeneration = 0
  private workspaceMutationSequence = 0
  private workspaceReconnectPromise: Promise<void> | undefined
  private workspaceTabRevision = -1
  private workspacePersistedRevision = 0
  private workspaceCausalRevision = 0
  private workspaceOperationWatermarks: Readonly<Record<string, number>> = {}
  private workspaceTabBaseline: readonly WorkspaceTabRecord[] = []
  private workspaceActiveBaseline = ''
  private workspaceTabPending = 0
  private workspaceTabBuffered: WorkspaceTabSnapshot | undefined
  private applyingWorkspaceTabs = false
  private unsubscribeWorkspaceTabs: (() => void) | undefined
  private unsubscribeWorkspaceSnapshots: (() => void) | undefined
  private unsubscribeWorkspaceDisconnect: (() => void) | undefined
  private readonly workspaceAcknowledgedOperations = new Map<string, number>()
  private readonly documentPersistenceRevisions = new Map<string, number>()
  private readonly documentPersistenceDirty = new Set<string>()
  private readonly workspaceActorId = randomWorkspaceId('window')
  private tabViewUpdateTime = 0
  private tabViewUpdateSequence = 0
  private readonly backendClientId = sharedBackendClientId()
  private readonly workspaceEvents: WorkspaceEventChannel | undefined
  private readonly workspaceExecutionEvents = new Set<string>()
  private readonly receiveWorkspaceEvent = (event: MessageEvent<unknown>): void => this.receiveWorkspaceExecution(event.data)
  private readonly handlePageHide = (event: PageTransitionEvent): void => {
    if (event.persisted) {
      this.flushPersistTabs(true)
      this.disableWorkspaceAuthority(true)
    } else this.dispose()
  }
  private readonly handlePageShow = (event: PageTransitionEvent): void => {
    if (event.persisted && !this.workspaceAuthorityEnabled) {
      void this.enableWorkspaceAuthority(this.workspacePortFactory, this.workspaceTabsPortFactory)
    }
  }
  private readonly receiveStorage = (event: StorageEvent): void => {
    this.settings.refreshFromStorage(event.key)
    if (event.key !== backendsKey()) return
    const incoming = decodePersistedBackends(event.newValue)
    if (!incoming) return
    const delta = rebaseBackendLists(decodePersistedBackends(event.oldValue) ?? [], incoming)
    for (const removed of delta.removes) {
      this.removeBackend(asConnectionId(canonicalBackendUrl(removed.baseUrl)), false)
    }
    for (const added of delta.adds) {
      const id = asConnectionId(canonicalBackendUrl(added.baseUrl) || 'local')
      if (id === 'local' || this.backends.get().some((backend) => backend.id === id)) continue
      this.addBackend(added.baseUrl, added.label, true, added.protocol, false)
    }
  }
  private disposed = false
  private readonly unsubscribePackLocale: () => void

  /**
   * Persisted memberships whose startup rejoin failed TRANSIENTLY (backend
   * unreachable), keyed by membership identity (baseUrl + sessionId):
   * carried so persistCollabMemberships keeps writing them for a later
   * reload to retry. A record leaves this map on ANY definite outcome -
   * successful adoption, confirmed-gone (404), a restored tab closed before
   * the rejoin, or an explicit leave/end/close of the same membership.
   */
  private readonly collabRejoinPending = new Map<string, PersistedCollabMembership>()

  constructor(options?: {
    /**
     * Protocol for the same-origin default backend, as discovered by the
     * entry point (discoverBackend('') in main.tsx) BEFORE construction.
     * Defaults to 'v1' so direct unit-test constructions remain stable; main
     * passes the discovered answer.
     */
    readonly defaultProtocol?: BackendProtocol
    /** Injectable collab session transport (tests); defaults to HTTP + WS. */
    readonly collabTransport?: CollabTransport
    /** Injectable same-workspace execution event channel (tests). */
    readonly workspaceEvents?: WorkspaceEventChannel
    /** Deployment restrictions can only subtract backend-authorized frontend privileges. */
    readonly deniedExtensionPrivileges?: readonly FrontendPrivilege[]
  }) {
    this.deniedExtensionPrivileges = Object.freeze([...(options?.deniedExtensionPrivileges ?? [])])
    this.collabTransport = options?.collabTransport ?? httpCollabTransport
    this.collabActorId = stableActorId()
    this.workspaceEvents = options?.workspaceEvents ?? (
      typeof globalThis.SharedWorker === 'function' && typeof globalThis.BroadcastChannel === 'function'
        ? new BroadcastChannel(scopedSharedName('dinkster-workspace-executions'))
        : undefined
    )
    ;(this.workspaceEvents as WorkspaceEventChannel & { unref?: () => void } | undefined)?.unref?.()
    this.workspaceEvents?.addEventListener('message', this.receiveWorkspaceEvent)
    this.settings.register({ id: 'canvas.grid.visible', get name() { return t('settings.canvas.grid.visible') }, type: 'boolean', defaultValue: true })
    registerLocaleSetting(this.settings)
    this.settings.register({ id: 'canvas.bookmarkTransitions', get name() { return t('settings.canvas.bookmarkTransitions') }, type: 'boolean', defaultValue: true })
    this.settings.register({
      id: 'canvas.scrollBehavior',
      get name() { return t('settings.canvas.scrollBehavior.name') },
      type: 'combo',
      defaultValue: 'zoom',
      get description() { return t('settings.canvas.scrollBehavior.description') },
      get options() {
        return [
          { value: 'zoom', label: t('settings.canvas.scrollBehavior.option.zoom') },
          { value: 'pan', label: t('settings.canvas.scrollBehavior.option.pan') },
        ]
      },
    })
    this.settings.register({ id: 'canvas.minimap.bookmarks', get name() { return t('settings.canvas.minimap.bookmarks') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'canvas.minimap.visible', get name() { return t('settings.canvas.minimap.visible') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'canvas.minimap.nodes', get name() { return t('settings.canvas.minimap.nodes') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'canvas.minimap.bypass', get name() { return t('settings.canvas.minimap.bypass') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'canvas.minimap.noodles', get name() { return t('settings.canvas.minimap.noodles') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'canvas.minimap.groups', get name() { return t('settings.canvas.minimap.groups') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'canvas.minimap.reroutes', get name() { return t('settings.canvas.minimap.reroutes') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'canvas.minimap.errors', get name() { return t('settings.canvas.minimap.errors') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'features.namedNets.enabled', get name() { return t('settings.features.namedNets') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'features.seedController.enabled', get name() { return t('settings.features.seedController') }, type: 'boolean', defaultValue: true })
    this.settings.register({ id: 'features.controlSurfaces.enabled', get name() { return t('settings.features.controlSurfaces') }, type: 'boolean', defaultValue: false })
    this.settings.register({ id: 'tooltips.delayMs', get name() { return t('settings.tooltips.delayMs') }, type: 'number', defaultValue: 500, min: 0, max: 5000, step: 50 })
    this.settings.register({
      id: 'execution.previews',
      get name() { return t('settings.execution.previews.name') },
      type: 'combo',
      // Off by default: previews cost compute/VRAM on every sampling step,
      // so they are opt-in globally (workflow/node overrides still apply).
      defaultValue: 'off',
      get description() { return t('settings.execution.previews.description') },
      get options() {
        return [
          { value: 'off', label: t('settings.execution.previews.option.off') },
          { value: 'cheap', label: t('settings.execution.previews.option.cheap') },
          { value: 'quality', label: t('settings.execution.previews.option.quality') },
          { value: 'auto', label: t('settings.execution.previews.option.auto') },
        ]
      },
    })
    this.settings.register({
      id: 'execution.mirrorPreviews',
      get name() { return t('settings.execution.mirrorPreviews.name') },
      type: 'boolean',
      defaultValue: true,
      get description() { return t('settings.execution.mirrorPreviews.description') },
    })
    this.settings.register({
      id: 'execution.previewAnimation',
      get name() { return t('settings.execution.previewAnimation.name') },
      type: 'combo',
      defaultValue: 'ring',
      get description() { return t('settings.execution.previewAnimation.description') },
      get options() {
        return [
          { value: 'ring', label: t('settings.execution.previewAnimation.option.ring') },
          { value: 'encoded', label: t('settings.execution.previewAnimation.option.encoded') },
        ]
      },
    })
    // After the core settings above, so `shell.layout.*` registers last and
    // the settings dialog keeps opening on the canvas category.
    this.shell = new ShellLayout(this.settings)
    this.dock = new DockLayout(this.settings, () =>
      this.panels.all().map(({ id, placement, allowedPlacements, order }) =>
        ({ id, placement, allowedPlacements, order })))
    this.editorSplits = new EditorSplitStore(this.settings)
    // Stale-modal guard (see modalPanel above): registry churn that removes
    // the open modal's panel - or moves it off 'modal' - closes the modal
    // state itself, so a later re-register can never resurrect the dialog.
    this.panels.changed.subscribe(() => {
      const id = this.modalPanel.get()
      if (id !== '' && this.panels.placementOf(id) !== 'modal') this.modalPanel.set('')
    })
    const activeTabNow = () => this.activeTab()
    const register = (id: string, labelKey: string, combo: string, run: () => void, enabled?: () => boolean) => {
      this.frontendDoors.command(id, { get label() { return t(labelKey) }, run, ...(enabled ? { enabled } : {}) })
      this.keybindings.register({ command: id, combo })
    }
    register('workflow.queue', 'command.workflow.queue', 'Ctrl+Enter', () => { const tab = activeTabNow(); if (tab) void this.queue(tab) })
    register('workflow.save', 'command.workflow.save', 'Ctrl+S', () => { const tab = activeTabNow(); if (tab) void this.saveWorkflow(tab.id) }, () => {
      const tab = activeTabNow()
      return tab !== undefined && tab.execution === undefined && this.backendForTab(tab).protocol === 'dinkster'
    })
    register('workflow.open', 'command.workflow.open', 'Ctrl+O', () => {
      setPanelOpen(this.panels, this.dock, 'library', 'left', true)
    })
    this.frontendDoors.command('workflow.importFile', {
      get label() { return t('command.workflow.importFile') },
      run: () => this.openWorkflowFilePicker(),
    })
    this.frontendDoors.command('workflow.export', {
      get label() { return t('command.workflow.export') },
      run: () => { const tab = activeTabNow(); if (tab) this.exportWorkflow(tab.id) },
      enabled: () => {
        const tab = activeTabNow()
        return tab !== undefined && tab.execution === undefined
      },
    })
    // Alt+ combo: Ctrl+Shift+P/A are browser-reserved (private window, tab
    // search) and the Alt band already hosts view commands (zoom).
    register('view.toggleAppView', 'command.view.toggleAppView', 'Alt+V', () => {
      const tab = activeTabNow()
      if (tab) this.setTabEditorKind(tab.id, tab.editorKind === APP_EDITOR_KIND ? GRAPH_EDITOR_KIND : APP_EDITOR_KIND)
    })
    register('edit.selectAll', 'command.edit.selectAll', 'Ctrl+A', () => this.canvasBridge.get()?.selectAll(), () => this.canvasBridge.get() !== undefined)
    register('edit.delete', 'command.edit.delete', 'Delete', () => this.canvasBridge.get()?.deleteSelection(), () => this.canvasBridge.get() !== undefined)
    register('edit.deleteBackspace', 'command.edit.deleteBackspace', 'Backspace', () => this.canvasBridge.get()?.deleteSelection(), () => this.canvasBridge.get() !== undefined)
    register('edit.undo', 'command.edit.undo', 'Ctrl+Z', () => {
      const tab = activeTabNow()
      if (tab?.store.undo()) reconcileGraphNavigation(tab)
    }, () => activeTabNow()?.store.canUndo === true)
    register('edit.redo', 'command.edit.redo', 'Ctrl+Shift+Z', () => activeTabNow()?.store.redo(), () => activeTabNow()?.store.canRedo === true)
    register('edit.redoLegacy', 'command.edit.redoLegacy', 'Ctrl+Y', () => activeTabNow()?.store.redo(), () => activeTabNow()?.store.canRedo === true)
    register('node.bypass', 'command.node.bypass', 'Ctrl+B', () => this.canvasBridge.get()?.setSelectedMode('bypassed'), () => this.canvasBridge.get() !== undefined)
    register('node.mute', 'command.node.mute', 'Ctrl+M', () => this.canvasBridge.get()?.setSelectedMode('muted'), () => this.canvasBridge.get() !== undefined)
    register('node.minimize', 'command.node.minimize', 'Alt+C', () => this.canvasBridge.get()?.toggleSelectedCollapsed(), () => this.canvasBridge.get() !== undefined)
    const selectedNodeHelp = (): { readonly tab: Tab; readonly type: string } | undefined => {
      const tab = activeTabNow()
      const selected = this.canvasBridge.get()?.selectedNodes() ?? []
      if (tab === undefined || selected.length !== 1) return undefined
      const node = tab.store.doc.graphs[currentGraphId(tab)]?.nodes[selected[0]!]
      return node === undefined ? undefined : { tab, type: node.type }
    }
    register('node.help', 'nodeHelp.command.open', 'F1', () => {
      const target = selectedNodeHelp()
      if (target) this.openNodeHelp(target.tab, target.type)
    }, () => {
      const target = selectedNodeHelp()
      if (target === undefined) return false
      const schema = this.registryForTab(target.tab)?.resolve(target.type)
      return schema?.hasDocs === true && schema.pack !== undefined && this.backendForTab(target.tab).protocol === 'dinkster'
    })
    this.frontendDoors.command('subgraph.createEmpty', {
      get label() { return t('command.subgraph.createEmpty') },
      run: () => this.canvasBridge.get()?.createEmptySubgraph?.(),
      enabled: () => activeTabNow()?.execution === undefined && this.canvasBridge.get()?.createEmptySubgraph !== undefined,
    })
    for (const kind of ['map', 'fold', 'while'] as const) {
      this.frontendDoors.command(`region.create${kind[0]!.toUpperCase()}${kind.slice(1)}`, {
        get label() { return t(`command.region.create.${kind}`) },
        run: () => this.canvasBridge.get()?.createRegion?.(kind),
        enabled: () => activeTabNow()?.execution === undefined && this.canvasBridge.get()?.createRegion !== undefined,
      })
    }
    register(
      'subgraph.extract',
      'command.subgraph.extract',
      'Ctrl+Shift+E',
      () => this.canvasBridge.get()?.extractSubgraph?.(),
      () => activeTabNow()?.execution === undefined && this.canvasBridge.get()?.canExtractSubgraph?.() === true,
    )
    register(
      'subgraph.flatten',
      'command.subgraph.flatten',
      'Ctrl+Shift+F',
      () => this.canvasBridge.get()?.flattenSubgraph?.(),
      () => activeTabNow()?.execution === undefined && this.canvasBridge.get()?.canFlattenSubgraph?.() === true,
    )
    this.frontendDoors.command('subgraph.manageDefinitions', {
      get label() { return t('command.subgraph.manageDefinitions') },
      run: () => this.modalPanel.set('subgraph-definitions'),
      enabled: () => activeTabNow() !== undefined && activeTabNow()?.execution === undefined,
    })
    register('view.zoomIn', 'command.view.zoomIn', 'Alt+=', () => this.canvasBridge.get()?.zoomBy(1.2), () => this.canvasBridge.get() !== undefined)
    register('view.zoomOut', 'command.view.zoomOut', 'Alt+-', () => this.canvasBridge.get()?.zoomBy(1 / 1.2), () => this.canvasBridge.get() !== undefined)
    // The bridge intentionally falls back to fitting the whole scene when
    // there is no selection, so selection emptiness does not disable this.
    register('view.fitSelection', 'command.view.fitSelection', '.', () => this.canvasBridge.get()?.fitSelection(), () => this.canvasBridge.get() !== undefined)
    this.frontendDoors.command('layout.customize', {
      get label() { return t('command.layout.customize') },
      run: () => this.modalPanel.set('customize-layout'),
    })
    this.frontendDoors.command('backend.open', {
      get label() { return t('command.backend.open') },
      run: () => { setPanelOpen(this.panels, this.dock, 'backends', 'left', true) },
    })
    register('settings.open', 'command.settings.open', 'Ctrl+,', () => {
      this.settingsOpenRequest.set(undefined)
      this.modalPanel.set('settings')
    })
    register('search.open', 'command.search.open', 'Ctrl+K', () => this.searchOpen.set(true))
    this.settings.register({ id: 'search.recentActivations', get name() { return t('settings.search.recentActivations') }, category: 'search', type: 'string', defaultValue: '[]' })
    registerCoreWidgets(this.frontendDoors)
    registerCoreWidgetEditors(this.widgetRegistry)
    this.textEditorExtensionRegistry.register(new SchemaTextCompletionProvider())
    for (const contribution of coreMenuContributions()) this.menuRegistry.register(contribution)
    // Reset-to-default items are schema-aware: they resolve through the
    // ACTIVE tab's target backend (defaults differ per backend registry).
    for (const contribution of resetMenuContributions(() => {
      const tab = this.activeTab()
      return (tab ? this.registryForTab(tab) : this.registry.get())?.resolve
    }))
      this.menuRegistry.register(contribution)

    const local = this.createBackend(
      asConnectionId('local'),
      'Local',
      '',
      options?.defaultProtocol ?? 'v1',
    )
    this.backends.set([local])
    this.connection = local.connection
    this.registry = local.registry
    this.scopedClient = local.scopedClient
    this.liveEmbeddingAndLoraInventory = new LiveEmbeddingAndLoraInventoryProvider({
      capture: () => {
        const tab = this.activeTab()
        if (tab === undefined || tab.execution !== undefined) return undefined
        const backend = this.backendForTab(tab)
        return {
          id: JSON.stringify([tab.id, backend.id]),
          source: {
            choices: (route, options) => backend.scopedClient.remoteChoices(route, options),
          },
          isCurrent: () => this.activeTabId.get() === tab.id && this.backendForTab(tab) === backend,
        }
      },
    })
    // Restore user-added backends (URL/label/protocol as discovered when
    // added). Not connected here - start() connects every backend at once.
    // A stale record aliasing the same-origin default (canonicalizes to '')
    // is skipped silently: corrupt storage yields no extras, never startup
    // noise.
    for (const saved of loadPersistedBackends()) {
      if (canonicalBackendUrl(saved.baseUrl) === '') continue
      this.addBackend(saved.baseUrl, saved.label, false, saved.protocol, false)
    }
    globalThis.addEventListener?.('storage', this.receiveStorage)
    this.store.executions.subscribe((execs) => this.hydrateCachedOutputs(execs))
    this.store.executions.subscribe(() => this.pruneExtensionWorlds())
    const persistedExecutions = new WeakSet<ExecutionState>()
    this.store.executions.subscribe((executions) => {
      for (const execution of executions.values()) {
        if (persistedExecutions.has(execution)) continue
        persistedExecutions.add(execution)
        const backend = this.backendFor(execution.ref.connection)
        const identity = backend === undefined ? undefined : this.executionResultIdentity(backend)
        if (identity !== undefined) saveExecutionResult(execution, identity)
      }
    })
    let previousProblems: readonly OwnedDiagnostic[] = []
    this.problems.subscribe((problems) => {
      // Identity-based: owner-scoped replace/drop retains other owners'
      // entry OBJECTS while reordering the array, and a retained entry must
      // never be re-logged. New entries are always fresh objects.
      const previous = new Set<OwnedDiagnostic>(previousProblems)
      for (const problem of problems) {
        if (previous.has(problem)) continue
        this.log(
          problem.severity === 'warning' ? 'warn' : problem.severity,
          problem.origin,
          `${problem.message} (${problem.code})`,
        )
      }
      previousProblems = problems
    })
    const executionStatuses = new Map<string, ExecutionStatus>()
    const terminal: readonly ExecutionStatus[] = ['completed', 'error', 'interrupted']
    this.store.executions.subscribe((executions) => {
      // Evicted executions drop their status memory and any captured plan.
      for (const key of [...executionStatuses.keys()]) {
        if (executions.has(key)) continue
        executionStatuses.delete(key)
        this.advancementPlans.delete(key)
      }
      for (const execution of executions.values()) {
        const key = executionKey(execution.ref)
        const previous = executionStatuses.get(key)
        executionStatuses.set(key, execution.status)
        // Advancement plans are prepared from the compile artifact's frozen
        // snapshot and installed BEFORE store registration, so a run
        // whose terminal event beat the submit response is handled here the
        // moment registration republishes it. Completion APPLIES the plan
        // (applyAdvancement consumes it - duplicate observations advance at
        // most once); an authoritative error/interrupted drops it, transition
        // or not. Runs without a plan (reconciled history, disabled
        // controller, foreign submitters) never touch any document.
        // Provisional loss (reconcile verdict, revivable by a live event) is
        // NOT an authoritative interruption: the plan survives so a revived
        // run that completes still advances.
        if (execution.status === 'completed') this.applyAdvancement(key)
        else if (
          execution.status === 'error' ||
          (execution.status === 'interrupted' && !this.store.isProvisionallyLost(execution.ref))
        ) this.advancementPlans.delete(key)
        if (
          previous !== undefined &&
          previous !== execution.status &&
          terminal.includes(execution.status)
        ) {
          this.log(
            execution.status === 'error' ? 'error' : 'info',
            this.backendFor(execution.ref.connection)?.label ?? String(execution.ref.connection),
            `job ${execution.ref.prompt} ${execution.status}`,
          )
        }
      }
    })

    // Restore the previous session's open tabs (saved or not). An absent,
    // corrupt, or fully unloadable native session opens a schema-independent
    // blank workflow: the native catalog may intentionally contain no Comfy
    // compatibility nodes. The legacy bridge retains its portable fixtures.
    const persisted = loadPersistedTabs()
    this.workspacePersistedRevision = persisted?.workspaceRevision ?? 0
    this.workspaceCausalRevision = this.workspacePersistedRevision
    this.workspaceOperationWatermarks = persisted?.workspaceOperationWatermarks ?? {}
    const tabs: Tab[] = []
    const tabViewStates = new Map<string, TabViewState>()
    for (const entry of persisted?.tabs ?? []) {
      const loaded = loadDocument(entry.doc)
      if (!loaded.document) continue
      const tab = this.makeTab(loaded.document, entry.title, undefined, entry.editorKind ?? GRAPH_EDITOR_KIND)
      if (entry.viewState === undefined) tabViewStates.delete(tab.id)
      else tabViewStates.set(tab.id, entry.viewState)
      this.documentPersistenceRevisions.set(tab.id, entry.documentRevision ?? 0)
      // A persisted still-pristine seed keeps its silent-migration
      // entitlement (see stockPending): the flag was only written while the
      // tab was unedited.
      if (entry.stock === true) this.stockPending.add(tab.id)
      // Tab ids are lineages, and every id-keyed surface (dirty set, watchers,
      // links, active id) assumes ids are unique. Normal flow guarantees that
      // (openDocument replaces same-lineage tabs), so duplicates here mean a
      // hand-edited or corrupt snapshot: keep the LAST occurrence, matching
      // openDocument's replace semantics.
      const collision = tabs.findIndex((t) => t.id === tab.id)
      if (collision !== -1) tabs.splice(collision, 1)
      tabs.push(tab)
    }
    if (tabs.length === 0) {
      if (local.protocol === 'dinkster') {
        const loaded = loadDocument(emptyWorkflowJson())
        if (loaded.document) tabs.push(this.makeTab(loaded.document, 'Untitled'))
      } else {
        for (const [title, json] of [
          ['Basic', seedBasic],
          ['Subgraph', seedSubgraph],
        ] as const) {
          const loaded = loadDocument(json)
          if (!loaded.document) continue
          const tab = this.makeTab(loaded.document, title)
          tabs.push(tab)
          // Stock content the app itself shipped: its upgrade to the backend's
          // canonical types is baseline normalization, not user-visible churn.
          this.stockPending.add(tab.id)
        }
      }
    }
    this.tabViewStates.set(tabViewStates)
    this.tabs.set(tabs)
    this.dirtyTabs.set(new Set(tabs.filter((tab) => !tab.execution).map((tab) => tab.id)))
    const active = persisted !== undefined && tabs.some((t) => t.id === persisted.active) ? persisted.active : (tabs[0]?.id ?? '')
    this.activeTabId.set(active)
    // Seed tabs open before any backend has schemas; upgrade them (and any
    // other pending tab) when a registry arrives or refreshes.
    for (const tab of tabs) {
      this.upgradePending.add(tab.id)
      this.legacyBooleanPending.add(tab.id)
    }
    this.backendsTick.subscribe(() => {
      this.selectExtensionWorld()
      this.pruneExtensionWorlds()
      this.drainLegacyBooleans() // before replacements: same open boundary
      this.drainUpgrades()
    })
    // Mirror tab, document, and active-tab changes back into storage.
    this.tabs.subscribe(() => {
      for (const [controller, { tab }] of this.submissionWorlds) {
        if (!this.tabs.get().includes(tab)) controller.abort()
      }
      this.selectExtensionWorld()
      this.watchTabDocuments()
      this.schedulePersistTabs()
      this.syncWorkspaceTabs()
    })
    this.activeTabId.subscribe((activeId) => {
      this.selectExtensionWorld()
      const imageTarget = this.imageEditorTarget.get()
      const curveTarget = this.curveEditorTarget.get()
      const glslTarget = this.glslEditorTarget.get()
      if (imageTarget && imageTarget.tabId !== activeId) this.imageEditorTarget.set(undefined)
      if (curveTarget && curveTarget.tabId !== activeId) this.curveEditorTarget.set(undefined)
      if (glslTarget && glslTarget.tabId !== activeId) this.glslEditorTarget.set(undefined)
      if ((imageTarget && imageTarget.tabId !== activeId) ||
          (curveTarget && curveTarget.tabId !== activeId) ||
          (glslTarget && glslTarget.tabId !== activeId)) {
        this.tabs.update((list) => list.map((tab) =>
          (tab.id === imageTarget?.tabId && tab.editorKind === IMAGE_EDITOR_KIND) ||
          (tab.id === curveTarget?.tabId && tab.editorKind === CURVE_EDITOR_KIND) ||
          (tab.id === glslTarget?.tabId && tab.editorKind === GLSL_EDITOR_KIND)
            ? { ...tab, editorKind: GRAPH_EDITOR_KIND }
            : tab))
      }
      this.schedulePersistTabs()
      this.syncWorkspaceTabs()
    })
    this.watchTabDocuments()
    this.schedulePersistTabs() // seed/restored state lands in storage too
    // The debounce is lossy at teardown: an edit made within 400ms of the
    // page going away would never reach storage. pagehide is the last
    // reliable moment to write (fires for close, navigation, AND bfcache
    // entry, unlike beforeunload). Guarded: absent outside the browser.
    globalThis.window?.addEventListener('pagehide', this.handlePageHide)
    globalThis.window?.addEventListener('pageshow', this.handlePageShow)
    this.unsubscribePackLocale = activeLocale.subscribe(() => {
      for (const backend of this.backends.get()) {
        if (backend.protocol === 'dinkster') void this.refreshPackLocaleOverlay(backend)
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribePackLocale()
    for (const controller of this.submissionWorlds.keys()) controller.abort()
    this.submissionWorlds.clear()
    for (const worlds of this.extensionWorlds.values()) for (const world of worlds.values()) world.dispose()
    this.extensionWorlds.clear()
    this.selectedExtensionWorld = undefined
    this.workspaceAuthorityDesired = false
    this.flushPersistTabs(true)
    this.disableWorkspaceAuthority(false)
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    for (const watcher of this.persistWatchers.values()) watcher.unsubscribe()
    this.persistWatchers.clear()
    this.workspaceEvents?.removeEventListener?.('message', this.receiveWorkspaceEvent)
    this.workspaceEvents?.close?.()
    globalThis.removeEventListener?.('storage', this.receiveStorage)
    globalThis.window?.removeEventListener('pagehide', this.handlePageHide)
    globalThis.window?.removeEventListener('pageshow', this.handlePageShow)
  }

  /**
   * Move every local workflow onto the same-origin SharedWorker authority.
   * Rendering waits for this during bootstrap, so the first editable frame
   * already observes the canonical document used by every other window.
   */
  async enableWorkspaceAuthority(
    portFactory?: SharedWorkerPortFactory,
    workspacePortFactory?: WorkspaceWorkerPortFactory,
  ): Promise<void> {
    this.disposed = false
    this.workspaceAuthorityDesired = true
    if (this.workspaceAuthorityEnabled) return this.promoteWorkspaceTabs()
    this.workspaceAuthorityEnabled = true
    const generation = ++this.workspaceAuthorityGeneration
    this.workspacePortFactory = portFactory
    this.workspaceTabsPortFactory = workspacePortFactory
    const openingRecords = this.workspaceTabRecords()
    const activeTab = this.activeTab()
    const liveActive = activeTab?.execution ? this.liveTabFor(activeTab.store.doc.lineage)?.id : activeTab?.id
    const openingActive = liveActive !== undefined && openingRecords.some((tab) => tab.id === liveActive)
      ? liveActive
      : openingRecords.some((tab) => tab.id === this.workspaceActiveBaseline)
        ? this.workspaceActiveBaseline
        : (openingRecords[0]?.id ?? '')
    this.workspaceTabBaseline = openingRecords
    this.workspaceActiveBaseline = openingActive
    try {
      const opened = await SharedWorkerTabConnection.open(
        openingRecords,
        workspacePortFactory,
        this.workspacePersistedRevision,
        openingActive,
        this.workspaceOperationWatermarks,
      )
      if (!this.workspaceAuthorityEnabled || generation !== this.workspaceAuthorityGeneration) {
        opened.connection.close()
        return
      }
      this.workspaceTabConnection = opened.connection
      this.unsubscribeWorkspaceSnapshots = opened.connection.onSnapshot((snapshot) => this.receiveWorkspaceTabSnapshot(snapshot))
      this.unsubscribeWorkspaceDisconnect = opened.connection.onDisconnect((error) => {
        if (this.workspaceTabConnection === opened.connection) void this.reconnectWorkspaceAuthority(error)
      })
      this.applyWorkspaceTabSnapshot(opened.snapshot)
      for (const operation of loadWorkspaceOperations()) {
        if ((opened.snapshot.operationWatermarks[operation.actorId] ?? -1) < operation.sequence) {
          this.submitWorkspaceTabMutation(operation)
        } else removeWorkspaceOperation(operation.opId)
      }
      this.unsubscribeWorkspaceTabs = this.tabs.subscribe(() => {
        this.watchTabDocuments()
        this.schedulePersistTabs()
        this.syncWorkspaceTabs()
        void this.promoteWorkspaceTabs()
      })
    } catch (error) {
      this.workspaceAuthorityEnabled = false
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag(
        'error', 'command', 'workspace.tabs.failed',
        `Shared tab workspace unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )])
      throw error
    }
    await this.promoteWorkspaceTabs()
  }

  private workspaceTabRecords(tabs: readonly Tab[] = this.tabs.get()): readonly WorkspaceTabRecord[] {
    return tabs.filter((tab) => !tab.execution).map((tab) => ({
      id: tab.id,
      title: tab.title,
      document: tab.store.doc,
      ...(tab.editorKind !== GRAPH_EDITOR_KIND && !isSessionOnlyEditorKind(tab.editorKind) ? { editorKind: tab.editorKind } : {}),
      ...(this.stockPending.has(tab.id) && tab.store.revision === 0 ? { stock: true as const } : {}),
    }))
  }

  private workspaceTabMutation(
    before: readonly WorkspaceTabRecord[],
    after: readonly WorkspaceTabRecord[],
    beforeActive = this.workspaceActiveBaseline,
    afterActive = this.activeTabId.get(),
  ): WorkspaceTabMutation | undefined {
    const oldById = new Map(before.map((tab) => [tab.id, tab]))
    const newById = new Map(after.map((tab) => [tab.id, tab]))
    const additions = after.filter((tab) => !oldById.has(tab.id))
    const removals = before.filter((tab) => !newById.has(tab.id)).map((tab) => tab.id)
    const updates = after.filter((tab) => {
      const old = oldById.get(tab.id)
      return old !== undefined && (
        old.title !== tab.title || old.editorKind !== tab.editorKind || old.stock !== tab.stock
      )
    }).map(({ id, title, editorKind, stock }) => ({
      id,
      title,
      editorKind: editorKind ?? null,
      stock: stock === true,
    }))
    const order = after.map((tab) => tab.id)
    const oldOrder = before.map((tab) => tab.id)
    if (additions.length === 0 && removals.length === 0 && updates.length === 0 &&
      order.length === oldOrder.length && order.every((id, index) => oldOrder[index] === id) &&
      beforeActive === afterActive) return undefined
    return {
      opId: `${this.workspaceActorId}-tabs-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`,
      actorId: this.workspaceActorId,
      sequence: this.workspaceMutationSequence++,
      baseRevision: this.workspaceCausalRevision,
      additions,
      removals,
      updates,
      order,
      active: afterActive,
    }
  }

  private syncWorkspaceTabs(): void {
    if (this.applyingWorkspaceTabs || !this.workspaceAuthorityDesired) return
    const next = this.workspaceTabRecords()
    const active = this.activeTabId.get()
    const synchronizedActive = next.some((tab) => tab.id === active) ? active : this.workspaceActiveBaseline
    const mutation = this.workspaceTabMutation(
      this.workspaceTabBaseline,
      next,
      this.workspaceActiveBaseline,
      synchronizedActive,
    )
    this.workspaceTabBaseline = next
    this.workspaceActiveBaseline = synchronizedActive
    if (!mutation) return
    if (this.workspaceTabConnection) this.submitWorkspaceTabMutation(mutation)
    else persistWorkspaceOperation(mutation)
  }

  private submitWorkspaceTabMutation(mutation: WorkspaceTabMutation): void {
    const connection = this.workspaceTabConnection
    if (!connection) return
    persistWorkspaceOperation(mutation)
    this.workspaceTabPending += 1
    void connection.mutate(mutation).then(
      (snapshot) => {
        if (this.workspaceTabConnection === connection) {
          this.workspaceAcknowledgedOperations.set(mutation.opId, snapshot.revision)
          this.workspaceTabBuffered = this.newerWorkspaceSnapshot(this.workspaceTabBuffered, snapshot)
        }
      },
      (error: unknown) => {
        if (this.workspaceTabConnection === connection) this.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag(
          'error', 'command', 'workspace.tabs.mutationFailed',
          `Shared tab change failed: ${error instanceof Error ? error.message : String(error)}`,
        )])
      },
    ).finally(() => {
      if (this.workspaceTabConnection !== connection) return
      this.workspaceTabPending -= 1
      if (this.workspaceTabPending === 0 && this.workspaceTabBuffered) {
        const snapshot = this.workspaceTabBuffered
        this.workspaceTabBuffered = undefined
        this.applyWorkspaceTabSnapshot(snapshot)
      }
    })
  }

  private receiveWorkspaceTabSnapshot(snapshot: WorkspaceTabSnapshot): void {
    if (this.workspaceTabPending > 0) {
      this.workspaceTabBuffered = this.newerWorkspaceSnapshot(this.workspaceTabBuffered, snapshot)
    } else this.applyWorkspaceTabSnapshot(snapshot)
  }

  private newerWorkspaceSnapshot(
    current: WorkspaceTabSnapshot | undefined,
    incoming: WorkspaceTabSnapshot,
  ): WorkspaceTabSnapshot {
    return current === undefined || incoming.revision > current.revision ? incoming : current
  }

  private applyWorkspaceTabSnapshot(snapshot: WorkspaceTabSnapshot): void {
    if (!this.workspaceAuthorityEnabled || snapshot.revision < this.workspaceTabRevision) return
    const opening = this.workspaceTabRevision < 0
    this.workspaceTabRevision = snapshot.revision
    this.workspacePersistedRevision = snapshot.revision
    this.workspaceCausalRevision = Math.max(this.workspaceCausalRevision, snapshot.revision)
    this.workspaceOperationWatermarks = snapshot.operationWatermarks
    this.workspaceTabBaseline = snapshot.tabs
    this.workspaceActiveBaseline = snapshot.active
    const current = this.tabs.get()
    const liveById = new Map(current.filter((tab) => !tab.execution).map((tab) => [tab.id, tab]))
    const nextLive: Tab[] = []
    this.applyingWorkspaceTabs = true
    try {
      for (const record of snapshot.tabs) {
        let tab = liveById.get(record.id)
        if (!tab) {
          tab = this.makeTab(record.document, record.title, undefined, record.editorKind ?? GRAPH_EDITOR_KIND)
          this.markTabDirty(tab.id)
        } else {
          const editorKind = isSessionOnlyEditorKind(tab.editorKind)
            ? tab.editorKind
            : (record.editorKind ?? GRAPH_EDITOR_KIND)
          if (tab.title !== record.title || tab.editorKind !== editorKind) {
            tab = { ...tab, title: record.title, editorKind }
          }
        }
        if (record.stock === true) this.stockPending.add(record.id)
        else this.stockPending.delete(record.id)
        nextLive.push(tab)
      }
      const retained = new Set(snapshot.tabs.map((tab) => tab.id))
      for (const tab of current) if (!tab.execution && !retained.has(tab.id)) this.cleanupClosedTab(tab.id)
      // A shared live tab whose lineage collides with a local frozen tab id
      // displaces the frozen view; drop it and release its pin exactly once,
      // or the duplicate id would leak the pin when the tab closes.
      const frozen = current.filter((tab) => {
        if (!tab.execution) return false
        if (!retained.has(tab.id)) return true
        this.store.release(tab.execution)
        return false
      })
      const nextTabs = [...nextLive, ...frozen]
      this.tabs.set(nextTabs)
      const localFrozenActive = frozen.some((tab) => tab.id === this.activeTabId.get())
      if (opening && !localFrozenActive && nextLive.some((tab) => tab.id === snapshot.active)) this.activeTabId.set(snapshot.active)
      else if (!nextTabs.some((tab) => tab.id === this.activeTabId.get())) this.activeTabId.set(nextLive[0]?.id ?? '')
    } finally {
      this.applyingWorkspaceTabs = false
    }
    this.watchTabDocuments()
    this.schedulePersistTabs()
    void this.promoteWorkspaceTabs()
  }

  private disableWorkspaceAuthority(keepLocalTabs: boolean): void {
    if (!this.workspaceAuthorityEnabled) return
    this.workspaceAuthorityEnabled = false
    this.workspaceAuthorityGeneration += 1
    this.unsubscribeWorkspaceTabs?.()
    this.unsubscribeWorkspaceTabs = undefined
    this.unsubscribeWorkspaceSnapshots?.()
    this.unsubscribeWorkspaceSnapshots = undefined
    this.unsubscribeWorkspaceDisconnect?.()
    this.unsubscribeWorkspaceDisconnect = undefined
    if (keepLocalTabs) {
      const replacements = new Map<string, Tab>()
      for (const [id, entry] of this.workspaceSessions) {
        // entry.tab can lag a metadata-only replacement until the next
        // promotion sweep; the live tab carries the current metadata.
        const source = this.tabs.get().find((tab) => tab.id === id && tab.store === entry.session) ?? entry.tab
        const local: Tab = {
          ...this.makeTab(entry.session.doc, source.title, undefined, source.editorKind),
          ...(source.appArrange !== undefined ? { appArrange: source.appArrange } : {}),
        }
        local.graphStack.set(source.graphStack.get())
        local.instancePath.set(source.instancePath.get())
        replacements.set(id, local)
      }
      this.applyingWorkspaceTabs = true
      try {
        this.tabs.set(this.tabs.get().map((tab) => replacements.get(tab.id) ?? tab))
      } finally {
        this.applyingWorkspaceTabs = false
      }
    }
    for (const entry of this.workspaceSessions.values()) entry.session.close()
    this.workspaceSessions.clear()
    this.workspacePromotions.clear()
    this.workspaceTabConnection?.close()
    this.workspaceTabConnection = undefined
    this.workspaceTabRevision = -1
    this.workspaceTabPending = 0
    this.workspaceTabBuffered = undefined
  }

  private async reconnectWorkspaceAuthority(error: Error): Promise<void> {
    if (this.disposed || !this.workspaceAuthorityDesired || this.workspaceReconnectPromise) return
    this.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag(
      'warning',
      'command',
      'workspace.tabs.reconnecting',
      `Shared tab workspace reconnecting: ${error.message}`,
    )])
    this.disableWorkspaceAuthority(true)
    let delay = 250
    const reconnect = async (): Promise<void> => {
      while (this.workspaceAuthorityDesired && !this.disposed) {
        try {
          await this.enableWorkspaceAuthority(this.workspacePortFactory, this.workspaceTabsPortFactory)
          return
        } catch {
          if (!this.workspaceAuthorityDesired || this.disposed) return
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 5_000)
        }
      }
    }
    this.workspaceReconnectPromise = reconnect().finally(() => {
      this.workspaceReconnectPromise = undefined
    })
    await this.workspaceReconnectPromise
  }

  private async promoteWorkspaceTabs(): Promise<void> {
    const current = this.tabs.get()
    for (const [id, entry] of this.workspaceSessions) {
      const live = current.find((tab) => tab.id === id)
      // Compare by store identity, not Tab identity: metadata-only tab
      // replacements ({ ...tab, editorKind } and the like) keep the session
      // as their store, and closing it would strand the live tab on a dead
      // session. Adopt the replacement Tab object instead.
      if (live !== undefined && live.store === entry.session) {
        if (live !== entry.tab) this.workspaceSessions.set(id, { tab: live, session: entry.session })
        continue
      }
      entry.session.close()
      this.workspaceSessions.delete(id)
    }
    const pending = current
      .filter((tab) =>
        tab.execution === undefined &&
        this.workspaceSessions.get(tab.id)?.tab !== tab &&
        !('status' in tab.store))
      .map((tab) => this.startWorkspaceTabPromotion(tab))
    await Promise.all(pending)
  }

  private startWorkspaceTabPromotion(tab: Tab): Promise<void> {
    const existing = this.workspacePromotions.get(tab.id)
    if (existing?.tab === tab) return existing.promise
    const generation = this.workspaceAuthorityGeneration
    const promise = this.promoteWorkspaceTab(tab, generation).finally(() => {
      if (this.workspacePromotions.get(tab.id)?.promise === promise) this.workspacePromotions.delete(tab.id)
    })
    this.workspacePromotions.set(tab.id, { tab, promise })
    return promise
  }

  private async promoteWorkspaceTab(tab: Tab, generation: number): Promise<void> {
    const sourceDocument = tab.store.doc
    const sourceRevision = tab.store.revision
    const resolve = (type: string): NodeSchema | undefined => {
      const live = this.tabs.get().find((candidate) => candidate.id === tab.id)
      return live ? this.registryForTab(live)?.resolve(type) : undefined
    }
    let session: SharedDocumentSession | undefined
    try {
      session = await connectSharedWorkerSession(
        tab.id,
        tab.store.doc,
        coreCommandRegistry([], resolve),
        {
          actorId: this.workspaceActorId,
          schemaResolverFor: (document) => documentResolver(document, resolve),
          onConflict: (conflict) => this.reportProblems(tab.id, conflict.diagnostics),
          onError: (message) => this.reportProblems(tab.id, [
            diag('error', 'command', 'workspace.authority.failed', message),
          ]),
        },
        this.workspacePortFactory,
        () => this.tabs.get().find((candidate) => candidate.id === tab.id) === tab ? tab.store.doc : undefined,
        this.workspaceReplacements.has(tab),
      )
      const live = this.tabs.get().find((candidate) => candidate.id === tab.id)
      const sourceChanged = tab.store.doc !== sourceDocument || tab.store.revision !== sourceRevision
      const sameDocument = JSON.stringify(session.doc) === JSON.stringify(tab.store.doc)
      const latestWasAdopted = !sourceChanged || sameDocument
      if (generation !== this.workspaceAuthorityGeneration || !this.workspaceAuthorityEnabled ||
        live !== tab || this.collabTabs.get().has(tab.id) || !latestWasAdopted) {
        session.close()
        if (live === tab && sourceChanged) {
          this.reportProblems(tab.id, [diag(
            'error', 'command', 'workspace.authority.changedDuringOpen',
            'The workflow changed while its shared workspace was opening; the local edit was kept.',
          )])
        }
        return
      }
      // When the shared document is identical to the local one, the local
      // session's history records still apply: carry them across or every
      // edit dispatched before the promotion landed would silently lose its
      // undo record at the swap. A differing shared document (another window
      // established the workspace first) invalidates the records, so they
      // stay behind.
      if (sameDocument) session.adoptHistory(tab.store.historySnapshot())
      const replacement: Tab = { ...tab, store: session }
      // The swap strands in-flight advancement plans keyed to the old store
      // identity (combo refresh responses, queued run completions); record
      // the continuation so they follow the live session instead of dying,
      // and keep their mutation tracking watching the session that now
      // publishes the document.
      this.sessionContinuations.set(tab.store, session)
      this.adoptControllerMutations(tab.store, session)
      this.reconcileDocumentPersistenceRevision(tab.id, tab.store.doc, session.doc)
      reconcileGraphNavigation(replacement)
      this.workspaceSessions.set(tab.id, { tab: replacement, session })
      this.tabs.set(this.tabs.get().map((candidate) => candidate === tab ? replacement : candidate))
    } catch (error) {
      session?.close()
      this.reportProblems(tab.id, [diag(
        'error',
        'command',
        'workspace.authority.failed',
        `Shared workspace unavailable: ${error instanceof Error ? error.message : String(error)}`,
      )])
    }
  }

  // -- Open-tab persistence ---------------------------------------------------

  /**
   * Per-live-tab document subscriptions feeding the persistence mirror,
   * keyed by tab id but OWNED by the exact Tab object: a same-lineage
   * replacement reuses the id with a new session, and a watcher left on
   * the old session would silently stop persisting (and dirty-marking)
   * the replacement's edits.
   */
  private readonly persistWatchers = new Map<string, {
    tab: Tab
    unsubscribe: () => void
  }>()
  private persistTimer: ReturnType<typeof setTimeout> | undefined

  private markDocumentPersistenceDirty(tabId: string): void {
    this.documentPersistenceDirty.add(tabId)
  }

  private reconcileDocumentPersistenceRevision(
    tabId: string,
    previous: WorkflowDocument,
    replacement: WorkflowDocument,
  ): void {
    const changed = JSON.stringify(previous) !== JSON.stringify(replacement)
    if (changed) this.documentPersistenceDirty.add(tabId)
  }

  /**
   * (Re)subscribe to each live tab's document; drop watchers of closed
   * tabs and REBIND watchers whose tab id now names a different session.
   */
  private watchTabDocuments(): void {
    const live = new Map(this.tabs.get().filter((t) => !t.execution).map((t) => [t.id, t]))
    for (const [id, watcher] of this.persistWatchers) {
      if (live.get(id) === watcher.tab) continue // same session, still good
      watcher.unsubscribe()
      this.persistWatchers.delete(id)
    }
    for (const [id, tab] of live) {
      if (this.persistWatchers.has(id)) continue
      const watcher = {
        tab,
        unsubscribe: tab.store.document.subscribe(() => {
          // Signal notification snapshots its listeners, so an unsubscribe
          // cannot cancel a callback already in flight: re-check ownership
          // rather than trusting teardown ordering.
          if (this.tabs.get().find((candidate) => candidate.id === id) !== tab) return
          this.documentPersistenceDirty.add(id)
          reconcileGraphNavigation(tab)
          this.markTabDirty(id)
          this.schedulePersistTabs()
        }),
      }
      this.persistWatchers.set(id, watcher)
    }
  }

  /** Debounced: rapid command streams (drags) collapse into one write. */
  private schedulePersistTabs(): void {
    if (this.persistTimer !== undefined) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined
      this.persistTabsNow()
    }, 400)
  }

  /** Write any pending (debounced) tab snapshot immediately. */
  flushPersistTabs(forceStage = false): void {
    if (this.persistTimer === undefined) {
      if (forceStage) this.persistTabsNow(true)
      return
    }
    clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    this.persistTabsNow(forceStage)
  }

  private persistTabsNow(forceStage = false): void {
    if (!forceStage && this.workspaceAuthorityEnabled && this.workspaceTabPending > 0) {
      if (!this.disposed) this.schedulePersistTabs()
      return
    }
    const state: PersistedTabs = {
      v: 1,
      active: this.workspaceAuthorityEnabled ? this.workspaceActiveBaseline : this.activeTabId.get(),
      workspaceRevision: this.workspacePersistedRevision,
      workspaceOperationWatermarks: this.workspaceOperationWatermarks,
      tabs: this.tabs.get()
        .filter((t) => !t.execution)
        .map((t) => {
          const localViewState = this.tabViewStates.get().get(t.id)
          const viewState = tabViewStateForDocument(localViewState, t.store.doc)
          return {
            title: t.title,
            doc: t.store.doc as unknown,
            documentRevision: this.documentPersistenceRevisions.get(t.id) ?? 0,
            ...(this.documentPersistenceDirty.has(t.id) ? { documentDirty: true as const } : {}),
            // Stock provenance survives ONLY while pristine: an edited seed
            // must never regain silent-migration status after a reload resets
            // its revision counter.
            ...(this.stockPending.has(t.id) && t.store.revision === 0 ? { stock: true as const } : {}),
            ...(t.editorKind !== GRAPH_EDITOR_KIND && !isSessionOnlyEditorKind(t.editorKind) ? { editorKind: t.editorKind } : {}),
            ...(viewState === undefined ? {} : { viewState }),
          }
        }),
    }
    const acknowledged = [...this.workspaceAcknowledgedOperations].map(([opId, revision]) => ({ opId, revision }))
    commitPersistedTabs(state, this.workspaceActorId, acknowledged, (retired, committed) => {
      for (const tab of committed.tabs) {
        const id = persistedTabId(tab)
        if (!id) continue
        this.documentPersistenceRevisions.set(id, tab.documentRevision ?? 0)
        const live = this.tabs.get().find((candidate) => candidate.id === id)
        if (live && JSON.stringify(live.store.doc) === JSON.stringify(tab.doc)) this.documentPersistenceDirty.delete(id)
      }
      if (!this.disposed && this.tabs.get().some((tab) => this.documentPersistenceDirty.has(tab.id))) {
        this.schedulePersistTabs()
      }
      for (const opId of retired) {
        if ((this.workspaceAcknowledgedOperations.get(opId) ?? Infinity) <= this.workspacePersistedRevision) {
          this.workspaceAcknowledgedOperations.delete(opId)
        }
      }
    })
  }

  private log(severity: AppLogEntry['severity'], source: string, message: string): void {
    this.logs.update((entries) => [
      ...entries,
      { timestamp: Date.now(), severity, source, message },
    ].slice(-500))
  }

  recordHostLog(severity: AppLogEntry['severity'], source: string, message: string): void {
    this.log(severity, source, message)
  }

  clearLogs(): void {
    this.logs.set([])
  }

  /**
   * Build a Backend and wire it into the shared pipeline: events into the ONE
   * ExecutionStore (refs carry the connection id, so nothing collides), a
   * reconcile pass on every (re)connect, and tick bumps for the shell.
   */
  private createBackend(id: ConnectionId, label: string, baseUrl: string): Backend & { protocol: 'v1' }
  private createBackend(id: ConnectionId, label: string, baseUrl: string, protocol: BackendProtocol): Backend
  private createBackend(
    id: ConnectionId,
    label: string,
    baseUrl: string,
    protocol: BackendProtocol = 'v1',
  ): Backend {
    // Each connection needs its own stable client id for both the WS session
    // and submitted prompts. Two URLs can route to the same server.
    const clientId = `${this.backendClientId}:${id}`
    // Path-relative base urls (dev proxy) need the ws url built from the page
    // origin; absolute ones derive it from their own scheme+host.
    const wsPath = protocol === 'dinkster' ? '/api/events' : '/ws'
    const wsUrl = baseUrl.startsWith('http')
      ? `${baseUrl.replace(/^http/, 'ws')}${wsPath}?clientId=${encodeURIComponent(clientId)}`
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${baseUrl}${wsPath}?clientId=${encodeURIComponent(clientId)}`
    const registry = createSignal<SchemaRegistry | undefined>(undefined)
    const workerCatalog = createSignal<WorkerCatalogState>({ status: 'unsupported' })
    const scopedClient = createScopedClient({ baseUrl })
    const packProblemsOwner = Symbol(`pack-problems:${id}`)
    let refreshDiagnostics = (): void => {}
    let compositionRequest = 0
    let remoteChoiceSchemaGeneration = 0
    const invalidateRemoteChoices = (): void => {
      remoteChoiceSchemaGeneration += 1
      // Authentication is not yet configurable in the frontend. Generation
      // zero is still an explicit partition so the auth owner can advance it
      // without changing the cache model when authenticated backends land.
      scopedClient.setRemoteChoicePartition({
        principalGeneration: 0,
        schemaEpoch: remoteChoiceSchemaGeneration,
      })
      this.backendsTick.update((value) => value + 1)
    }
    // Scoped client per backend: remote combos (model lists) differ per server.
    const base = {
      id,
      label,
      baseUrl,
      registry,
      workerCatalog,
      schemaState: createSignal<
        | { readonly status: 'idle' | 'loading' | 'waiting' | 'ready' }
        | { readonly status: 'error'; readonly message: string }
      >({ status: 'idle' }),
      replacementProblems: createSignal<readonly ReplacementProblem[]>([]),
      compatSkips: createSignal<readonly CompatSkip[]>([]),
      refreshDiagnostics: () => refreshDiagnostics(),
      scopedClient,
      invalidateRemoteChoices,
      supervisor: createSignal<SupervisorStatus | undefined>(undefined),
      composition: createSignal<SupervisorProgress | undefined>(undefined),
    }
    // Shared wiring: events into the ONE store; every (re)connect reconciles
    // THIS backend's in-flight executions against its server-side history -
    // missed terminal events are replayed, vanished runs marked lost.
    // Initial connect: empty store, no-op.
    const wire = (
      connection: BackendConnection | DinksterConnection,
      reconcile: () => Promise<void>,
      refreshForEpoch?: (epoch: number) => void,
      onStatusChange?: (status: ConnectionStatus) => void,
    ): (() => void) => {
      const unsubs = [
        connection.onEvent((e) => {
          // Connection-level control events never reach the execution store:
          // they describe the schema surface, not a run. V1 backends never
          // emit them; refreshForEpoch exists only for the native protocol.
          switch (e.kind) {
            case 'extensionEvent': {
              const pinned = this.registryForExecution(e.execution)?.extensionSnapshotPair?.digest
              if (pinned !== undefined && pinned !== e.extensionSnapshotDigest) return
              this.extensionWorlds.get(e.execution.connection)?.get(e.extensionSnapshotDigest)?.deliver(e)
              return
            }
            case 'schemaChanged':
              this.log('info', label, `schema surface changed (epoch ${e.epoch})`)
              refreshForEpoch?.(e.epoch)
              return
            case 'compositionProgress':
              this.log('info', label, `composing packs ${e.done}/${e.total}${e.phase ? ` (${e.phase})` : ''}`)
              base.composition.set({ done: e.done, total: e.total, ...(e.phase ? { phase: e.phase } : {}) })
              return
            case 'compositionComplete':
              this.log(
                e.failed.length > 0 ? 'warn' : 'info',
                label,
                `pack composition complete (epoch ${e.epoch})${e.failed.length > 0 ? `; failed: ${e.failed.join(', ')}` : ''}`,
              )
              base.composition.set(undefined)
              refreshForEpoch?.(e.epoch)
              base.refreshDiagnostics()
              return
            case 'packFailed':
              compositionRequest += 1
              this.log('warn', label, `pack "${e.pack}" failed to load: ${e.error}`)
              this.reportProblems(packProblemsOwner, [
                diag('error', 'schema', 'schema.packFailed', `[${label}] pack "${e.pack}" failed to load: ${e.error}`),
              ])
              return
            default:
              if (!this.applyWorkspaceExecutionEvent(e)) return
              this.workspaceEvents?.postMessage({
                source: this.workspaceActorId,
                kind: 'event',
                event: e,
              } satisfies WorkspaceExecutionMessage)
          }
        }),
        connection.status.subscribe((s) => {
          // Connection transitions retire server-lifetime state before any
          // synchronous observer can act on the new status.
          onStatusChange?.(s)
          this.backendsTick.update((v) => v + 1)
          this.log(s === 'disconnected' ? 'warn' : 'info', label, s)
          if (s !== 'connected') return
          reconcile().catch((e: unknown) => {
            // A failed reconcile must be visible, not vanish into a void
            // promise: executions would silently stay 'running' forever.
            this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
              diag('error', 'runtime', 'reconcile.failed', `[${label}] failed to reconcile executions after reconnect: ${e instanceof Error ? e.message : String(e)}`),
            ])
          })
        }),
        registry.subscribe(() => {
          this.backendsTick.update((v) => v + 1)
          this.flushWorkspaceRegistrations(id)
        }),
        base.workerCatalog.subscribe(() => this.backendsTick.update((v) => v + 1)),
        base.schemaState.subscribe(() => this.backendsTick.update((v) => v + 1)),
        base.replacementProblems.subscribe(() => this.backendsTick.update((v) => v + 1)),
        base.compatSkips.subscribe(() => this.backendsTick.update((v) => v + 1)),
        base.supervisor.subscribe(() => this.backendsTick.update((v) => v + 1)),
        base.composition.subscribe(() => this.backendsTick.update((v) => v + 1)),
      ]
      return () => unsubs.forEach((u) => u())
    }
    if (protocol === 'dinkster') {
      const connection = new DinksterConnection({ id, baseUrl, clientId, wsUrl })
      let nativeBackend: Backend & { readonly protocol: 'dinkster' }
      // Epoch-gated registry refresh (schema_changed / composition_complete
      // pings are invalidations, never deltas). Coalesced: one fetch in
      // flight, newer targets fold in; skip entirely when the held table is
      // already at or past the ping's epoch. Backend ordering contract makes
      // one refetch sufficient: a fetch issued after seeing epoch N always
      // observes >= N.
      //
      // The epoch gate only holds within one server life. A restart can
      // change load-bearing capabilities (dinkster.graphFeatures) while coming
      // back at an equal or lower epoch, so every (re)connect invalidates
      // unconditionally: staleGen counts connects, freshGen the newest
      // server life a committed fetch was issued under, and while freshGen
      // lags the gate is bypassed so no ping is swallowed by a stale epoch.
      let refreshing = false
      let targetEpoch = 0
      let staleGen = 0 // bumped on every connected transition
      let freshGen = 0 // server life the held registry is known to satisfy
      let attemptGen = 0 // server life the most recent fetch was issued under
      let diagnosticsRequest = 0
      const requestDiagnostics = (gen: number): void => {
        const request = ++diagnosticsRequest
        void connection.fetchDiagnostics().then((diagnostics) => {
          if (gen !== staleGen || request !== diagnosticsRequest) return
          base.replacementProblems.set(diagnostics.replacementProblems)
          base.compatSkips.set(diagnostics.compatSkips)
        })
      }
      const requestCompositionProblems = (gen: number): void => {
        const request = ++compositionRequest
        void connection.fetchCompositionFailures().then((failures) => {
          if (failures === undefined || gen !== staleGen || request !== compositionRequest) return
          this.replaceProblems(
            packProblemsOwner,
            failures.map(({ pack, error }) =>
              diag('error', 'schema', 'schema.packFailed', `[${label}] pack "${pack}" failed to load: ${error}`),
            ),
          )
        })
      }
      const requestCurrentDiagnostics = (gen: number): void => {
        requestDiagnostics(gen)
        requestCompositionProblems(gen)
      }
      refreshDiagnostics = () => requestCurrentDiagnostics(staleGen)
      const startRefresh = (why: string): void => {
        if (refreshing) return
        refreshing = true
        const run = async (): Promise<number> => {
          for (;;) {
            const goal = targetEpoch
            const gen = staleGen // a fetch issued now observes this server life
            attemptGen = gen
            const fresh = await connection.fetchSchemas(this.schemaWireVersionsFor(nativeBackend))
            // A reconnect landed mid-fetch: this response may belong to the
            // PREVIOUS server life. Never commit it - committing would
            // restore capabilities the strip below just invalidated - loop
            // and refetch under the current generation instead.
            if (gen < staleGen) continue
            await this.prepareExtensionWorld(nativeBackend, fresh)
            if (gen < staleGen) {
              this.pruneExtensionWorlds()
              continue
            }
            const layered = this.layerExtraSchemas(fresh)
            registry.set(layered)
            base.invalidateRemoteChoices()
            this.refreshWorkerCatalog(nativeBackend, layered)
            void this.refreshPackLocaleOverlay(nativeBackend, fresh)
            requestCurrentDiagnostics(gen)
            freshGen = gen
            // Older backend without epochs: one refetch is the best we can do.
            if (fresh.epoch === undefined || fresh.epoch >= targetEpoch) return targetEpoch
            // No progress and no newer ping arrived: stop rather than spin.
            if (targetEpoch === goal) return goal
          }
        }
        run().then(
          (attempted) => {
            refreshing = false
            // Only a genuinely newer ping swallowed by the refreshing gate
            // needs a re-check; a stale response must not retry itself.
            // (Reconnects mid-run are handled inside the loop: every commit
            // is current-generation by construction.)
            if (targetEpoch > attempted) refreshForEpoch(targetEpoch)
          },
          (e: unknown) => {
            this.pruneExtensionWorlds()
            // No auto-retry: an immediate retry against a failing server is
            // a tight loop. The next ping (or reconnect) tries again - and
            // while freshGen lags staleGen the epoch gate stays bypassed, so
            // that retry cannot be swallowed by a stale held epoch.
            refreshing = false
            // ...unless a reconnect landed while THIS attempt was in flight:
            // the failure belongs to the previous server life and the new
            // life still owes its unconditional fetch. Exactly one follow-up
            // (a follow-up failing under the current life never retries).
            if (attemptGen < staleGen) {
              startRefresh('reconnect')
              return
            }
            if (e instanceof EngineNotReadyError) {
              // Supervisor-managed restart: the poll narrates the wait, and
              // the ready transition's composition ping refetches (gate
              // bypassed), mirroring the startup 503 gate.
              this.log('info', label, `engine not ready (${e.state}); deferring /api/nodes refresh`)
              return
            }
            this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
              diag('error', 'schema', 'schema.refreshFailed', `[${label}] failed to refresh /api/nodes after ${why}: ${e instanceof Error ? e.message : String(e)}`),
            ])
          },
        )
      }
      const refreshForEpoch = (epoch: number): void => {
        if (freshGen >= staleGen && (registry.get()?.epoch ?? 0) >= epoch) return
        // The ping itself retires choice authority. Do not wait for schema
        // refetch success: a failed refetch must not leave old choices live.
        if (epoch > targetEpoch) {
          base.invalidateRemoteChoices()
          this.invalidateWorkerCatalog(nativeBackend)
        }
        targetEpoch = Math.max(targetEpoch, epoch)
        startRefresh(`schema change (epoch ${epoch})`)
      }
      const refreshOnConnect = (): void => {
        staleGen += 1
        // graphFeatures and the extension snapshot pair are load-bearing and
        // belong to one server lifetime. Strip both from every observable
        // registry SYNCHRONOUSLY, so no work inside the refresh window uses
        // authority from the dead server process. Schemas stay held for
        // display/editing; the current-generation fetch below restores what
        // the new life actually advertises.
        const held = registry.get()
        connection.invalidateExtensionSnapshotPair()
        if (held?.graphFeatures !== undefined || held?.extensionSnapshotPair !== undefined) {
          const stripped = { ...held }
          delete stripped.graphFeatures
          delete stripped.extensionSnapshotPair
          registry.set(stripped)
        }
        this.invalidateWorkerCatalog(nativeBackend)
        base.invalidateRemoteChoices()
        startRefresh('reconnect')
      }
      const handleStatusChange = (status: ConnectionStatus): void => {
        if (status === 'connected') refreshOnConnect()
        else this.invalidateWorkerCatalog(nativeBackend)
      }
      const disposeConnection = wire(
        connection,
        () => reconcileDinksterExecutions(connection, this.store),
        refreshForEpoch,
        handleStatusChange,
      )
      const disposeCompletionHydration = connection.onLiveCompletion((ref) => {
        hydrateDinksterCompletedExecution(connection, this.store, ref).catch((error: unknown) => {
          this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
            diag(
              'error',
              'runtime',
              'execution.artifactHydrationFailed',
              `[${label}] failed to hydrate completed execution artifacts: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ])
        })
      })
      nativeBackend = {
        ...base,
        protocol,
        connection,
        refreshDiagnostics: () => refreshDiagnostics(),
        dispose: () => {
          compositionRequest += 1
          this.clearProblems(packProblemsOwner)
          disposeCompletionHydration()
          disposeConnection()
          scopedClient.dispose()
        },
      }
      return nativeBackend
    }
    const connection = new BackendConnection({ id, baseUrl, clientId, wsUrl })
    const disposeConnection = wire(connection, () => reconcileExecutions(connection, this.store))
    return {
      ...base,
      protocol,
      connection,
      dispose: () => {
        disposeConnection()
        scopedClient.dispose()
      },
    }
  }

  /**
   * Connect an additional backend. Returns diagnostics on rejection
   * (duplicate url/id). `start` (default true) also connects + fetches
   * schemas; unit tests pass false and drive the registry directly.
   */
  addBackend(
    baseUrl: string,
    label?: string,
    start = true,
    protocol: BackendProtocol = 'v1',
    persist = true,
  ): Backend | undefined {
    const trimmed = canonicalBackendUrl(baseUrl)
    const id = asConnectionId(trimmed || 'local')
    if (this.backends.get().some((b) => b.id === id)) {
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'schema', 'backend.duplicate', `backend '${trimmed}' is already connected`),
      ])
      return undefined
    }
    const entry = this.createBackend(id, label?.trim() || trimmed, trimmed, protocol)
    this.retiredBackends.delete(id) // re-adding revives the live entry
    this.backends.update((list) => [...list, entry])
    this.log('info', 'Backends', `backend added: ${entry.label}`)
    this.backendsTick.update((v) => v + 1)
    if (persist) this.persistBackendAdd(entry)
    if (start) void this.startBackend(entry)
    return entry
  }

  /**
   * URL-only add: discover what the server speaks (supervisor -> native ->
   * v1) and add it with the discovered protocol. Nothing is added when the
   * URL is unreachable, unrecognized, or a wire-incompatible Dinkster - each
   * lands as a named problem instead, so a typo or down server is a loud
   * diagnosis, not a dead backend row. `discover` is injectable for tests.
   */
  async addBackendByUrl(
    baseUrl: string,
    options?: {
      readonly label?: string
      /** Injectable discovery for tests; defaults to the live probe. */
      readonly discover?: (url: string) => Promise<BackendDiscovery>
      /** Connect + fetch schemas after add (default true); unit tests pass false. */
      readonly start?: boolean
    },
  ): Promise<Backend | undefined> {
    const trimmed = canonicalBackendUrl(baseUrl)
    let found: BackendDiscovery
    try {
      found = await (options?.discover ?? discoverBackend)(trimmed)
    } catch (e) {
      // The live probe never throws, but an injected discovery can; keep
      // the named-problem contract instead of an unhandled rejection.
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'schema', 'backend.discovery-failed', `'${trimmed}': discovery failed: ${e instanceof Error ? e.message : String(e)}`),
      ])
      return undefined
    }
    if (found.kind === 'dinkster' || found.kind === 'v1') {
      return this.addBackend(
        trimmed,
        options?.label,
        options?.start ?? true,
        found.kind === 'v1' ? 'v1' : 'dinkster',
      )
    }
    const message =
      found.kind === 'dinkster-incompatible'
        ? `'${trimmed}' is a Dinkster server, but this build decodes schema wire ${DINKSTER_ADVERTISED_WIRE_VERSIONS.join(', ')} and the server encodes ${found.supported.join(', ') || 'none of them'}`
        : `'${trimmed}': ${found.detail}`
    this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
      diag('error', 'schema', `backend.${found.kind}`, message),
    ])
    return undefined
  }

  /**
   * Persist one local add over the latest stored envelope. Reading storage at
   * write time preserves an edit another tab committed before this tab has
   * handled its storage event. External event application never calls this,
   * so the resulting event cannot echo around the tabs.
   */
  private persistBackendAdd(added: Backend): void {
    const current = readPersistedBackends()
    if (!current) {
      savePersistedBackends(this.persistableBackends())
      return
    }
    const id = canonicalBackendUrl(added.baseUrl)
    if (current.some((backend) => canonicalBackendUrl(backend.baseUrl) === id)) return
    savePersistedBackends([
      ...current,
      { baseUrl: added.baseUrl, label: added.label, protocol: added.protocol },
    ])
  }

  /** Persist one local removal without dropping unrelated external edits. */
  private persistBackendRemove(id: ConnectionId): void {
    const current = readPersistedBackends()
    if (!current) {
      savePersistedBackends(this.persistableBackends())
      return
    }
    savePersistedBackends(
      current.filter((backend) => canonicalBackendUrl(backend.baseUrl) !== id),
    )
  }

  /** Current live fallback used only to repair an unreadable envelope. */
  private persistableBackends(): readonly PersistedBackend[] {
    return this.backends.get().slice(1).map((backend) => ({
      baseUrl: backend.baseUrl,
      label: backend.label,
      protocol: backend.protocol,
    }))
  }

  /**
   * Disconnect and remove a non-default backend. Its executions stay in the
   * store (frozen views remain truthful); tabs targeting it fall back to the
   * default backend by resolution, and their stale target entries are dropped.
   */
  removeBackend(id: ConnectionId, persist = true): void {
    const list = this.backends.get()
    const entry = list.find((b) => b.id === id)
    if (!entry || entry === list[0]) return // default is not removable
    this.supervisorPolls.get(id)?.()
    entry.connection.disconnect()
    entry.dispose()
    this.log('info', 'Backends', `backend removed: ${entry.label}`)
    // Kept for URL resolution only: historical executions of a removed
    // backend still render their output/preview images through ITS /view.
    this.retiredBackends.set(id, entry)
    clearExecutionResults(id)
    this.backends.set(list.filter((b) => b !== entry))
    this.tabTargets.update((m) => {
      const next = new Map([...m].filter(([, target]) => target !== id))
      return next.size === m.size ? m : next
    })
    this.backendsTick.update((v) => v + 1)
    if (persist) this.persistBackendRemove(id)
  }

  /** Removed backends, retained only so their executions' /view URLs resolve. */
  private readonly retiredBackends = new Map<ConnectionId, Backend>()

  /**
   * The registry each compile artifact was produced against, keyed by the
   * ARTIFACT OBJECT (WeakMap: registry lifetime follows artifact lifetime,
   * no pruning bookkeeping), so FROZEN execution views resolve with the
   * EXACT schemas they compiled with - never a backend's current registry
   * after an epoch bump, never the default backend standing in for a removed
   * one, and never a same-hash impostor (extra-schema layering can replace
   * `schemas`/`resolve` while keeping the raw backend hash).
   */
  private readonly retainedRegistries = new WeakMap<CompileArtifact, SchemaRegistry>()
  private readonly pendingWorkspaceRegistrations = new Map<string, WorkspaceRegistration>()

  /**
   * The registry a frozen execution view must resolve with. Preference order
   * is the registry retained for the artifact at compile time, then the
   * run's own backend (live or retired) IF its registry still carries the
   * artifact's exact schema hash. Anything else would render the snapshot
   * with the wrong schemas, so a miss returns undefined - a visible
   * "schemas unavailable" state, never a silent fallback. Foreign runs (no
   * artifact) have no frozen view and return undefined too.
   */
  registryForExecution(ref: ExecutionRef): SchemaRegistry | undefined {
    const artifact = this.store.get(ref)?.artifact
    if (!artifact) return undefined
    const retained = this.retainedRegistries.get(artifact)
    if (retained && retained.hash === artifact.schemaHash) return retained
    const live = this.backendFor(ref.connection)?.registry.get()
    if (live?.hash === artifact.schemaHash) return live
    const retired = this.retiredBackends.get(ref.connection)?.registry.get()
    return retired?.hash === artifact.schemaHash ? retired : undefined
  }

  /** Backend by connection id (e.g. from an ExecutionRef). */
  backendFor(id: ConnectionId | undefined): Backend | undefined {
    return this.backends.get().find((b) => b.id === id)
  }

  /**
   * /view URL for an execution's output/preview file, routed through the
   * execution's OWN backend - never the active tab's. Removed backends stay
   * resolvable (retired entry); the default is a last-resort fallback only.
   */
  viewUrlForExecution(
    ref: ExecutionRef,
    file: { filename: string; subfolder?: string; type?: string },
  ): string {
    const backend =
      this.backendFor(ref.connection) ??
      this.retiredBackends.get(ref.connection) ??
      this.backends.get()[0]!
    // /view is a V1 endpoint, but only V1 executions carry V1 file refs, so
    // a native backend's base here is unreachable in practice; the URL stays
    // well-formed either way.
    return v1ViewUrl(backend.baseUrl, file)
  }

  /**
   * GET /api/assets/{digest} URL for an execution's content-addressed output,
   * routed through the execution's OWN backend - never the active tab's.
   * Same retirement rules as viewUrlForExecution: a removed backend's
   * historical outputs stay resolvable.
   */
  assetUrlForExecution(ref: ExecutionRef, digest: string): string {
    const backend =
      this.backendFor(ref.connection) ??
      this.retiredBackends.get(ref.connection) ??
      this.backends.get()[0]!
    return `${backend.baseUrl}/api/assets/${encodeURIComponent(digest)}`
  }

  /**
   * The backend a tab works against: frozen tabs follow their execution's
   * connection; live tabs follow their target (default when unset or stale).
   */
  backendForTab(tab: Tab): Backend {
    const fallback = this.backends.get()[0]!
    if (tab.execution) return this.backendFor(tab.execution.connection) ?? fallback
    const target = this.tabTargets.get().get(tab.id)
    return (target && this.backendFor(target)) ?? fallback
  }

  /** Open the right-rail help page when the node's wire-42 marker permits it. */
  openNodeHelp(tab: Tab, nodeType: string): boolean {
    const schema = this.registryForTab(tab)?.resolve(nodeType)
    const backend = this.backendForTab(tab)
    if (schema?.hasDocs !== true || schema.pack === undefined || backend.protocol !== 'dinkster') return false
    this.nodeHelpRequest.set({ backendId: backend.id, pack: schema.pack, nodeType })
    setPanelOpen(this.panels, this.dock, 'node-help', 'right', true)
    return true
  }

  registryForTab(tab: Tab): SchemaRegistry | undefined {
    // Frozen views resolve with their execution's compile-time schemas, never
    // whatever registry the (possibly re-resolved) backend holds NOW.
    if (tab.execution) return this.registryForExecution(tab.execution)
    return this.backendForTab(tab).registry.get()
  }

  /** Pane-local widget definitions, independent of the focused shell's world. */
  widgetRegistryForTab(tab: Tab | undefined): typeof this.widgetRegistry {
    const registry = tab === undefined ? undefined : this.registryForTab(tab)
    const digest = registry?.extensionSnapshotPair?.digest
    return digest === undefined ? this.widgetRegistry
      : this.extensionWorlds.get(registry!.connection)?.get(digest)?.widgets ?? this.widgetRegistry
  }

  private replacementSchemaOf(
    registry: SchemaRegistry | undefined,
    type: string,
    role: 'source' | 'target',
  ): NodeSchema | undefined {
    if (role === 'target') return registry?.resolve(type)
    return registry?.comfyAliases?.sourceSchemas.get(type) ??
      registry?.comfyGroups?.groupSchemas.get(type) ??
      registry?.resolve(type)
  }

  // -- Deprecation + replacement --------------------------------------------

  /**
   * When true, nothing is upgraded automatically: openDocument surfaces every
   * migratable node for review instead of applying safe plans (debug aid).
   */
  readonly reviewReplacements: Signal<boolean> = createSignal(false)

  /** Rules registered by packs/extensions; layered under schema rules. */
  private readonly extraRules: { layer: 'pack' | 'core'; rule: ReplacementRule }[] = []
  private extraRulesVersion = 0
  /** Per-SchemaRegistry rule cache. Weak: a refreshed/replaced registry's
   * entry must not pin the old registry (or its rules) alive. */
  private readonly replacementRegistries = new WeakMap<
    SchemaRegistry,
    { registry: ReplacementRegistry; version: number }
  >()
  /**
   * Tabs awaiting their first upgrade pass. A tab is upgraded exactly once,
   * as soon as BOTH the tab and its target backend's schemas exist - seed
   * tabs and documents opened before /object_info arrives are picked up by
   * the backendsTick subscription instead of being missed forever.
   * Retargeting a tab later does NOT re-run auto-apply (mutating a document
   * because the user switched backends would surprise); the deprecation
   * badge flow covers whatever the new backend's rules can migrate.
   */
  private readonly upgradePending = new Set<string>()

  /**
   * Stock seed tabs whose FIRST upgrade pass is silent baseline
   * normalization. The shipped seed workflows are authored in portable
   * legacy V1 form (bare class types, positional 'out{i}' ports) so they
   * run as-is on V1 ComfyUI backends; against a native backend the alias
   * rules migrate them to canonical types. The user never authored the
   * legacy form, so that migration must look born-this-way: no
   * 'replace.applied' Problems entry and no undo step back to a state the
   * user never saw. Consumed by upgradeOnOpen; only honored while the tab
   * is still pristine (revision 0) - once the user edits, the loud
   * reviewable path applies as for any document.
   */
  private readonly stockPending = new Set<string>()

  /**
   * Tabs awaiting a legacy-boolean normalization pass. Unlike upgradePending
   * this RE-ARMS on retarget: which schemas interpret the document is the
   * tab's target backend, and a document opened while targeting one backend
   * (where its types may not even resolve) can be pointed at another whose
   * BOOLEAN-widget inputs its stored strings were written for. The pass is
   * idempotent (converted values are booleans, no longer strings) and only
   * ever rewrites the eight exact recognized tokens, so re-running on an
   * explicit retarget is safe; it never re-runs on mere schema refreshes,
   * so an undone migration stays undone within a session.
   */
  private readonly legacyBooleanPending = new Set<string>()

  /** Normalize pending tabs whose target backend has schemas (see above). */
  private drainLegacyBooleans(): void {
    if (this.legacyBooleanPending.size === 0) return
    for (const tab of this.tabs.get()) {
      if (!this.legacyBooleanPending.has(tab.id)) continue
      if (tab.execution) {
        this.legacyBooleanPending.delete(tab.id) // frozen snapshots never migrate
        continue
      }
      if (!this.registryForTab(tab)) continue // still waiting for schemas
      this.legacyBooleanPending.delete(tab.id)
      this.normalizeLegacyBooleans(tab)
    }
  }

  /**
   * Register a replacement rule from a pack/extension (the 'pack' layer; the
   * 'core' layer is the frontend's own historical-rename table). Malformed
   * rules are rejected with diagnostics and land in Problems.
   */
  registerReplacementRule(layer: 'pack' | 'core', rule: ReplacementRule): readonly Diagnostic[] {
    const probe = createReplacementRegistry()
    const diags = probe.register(layer, rule)
    if (diags.length > 0) {
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, diags)
      return diags
    }
    this.extraRules.push({ layer, rule })
    this.extraRulesVersion++
    return []
  }

  /**
   * The replacement registry for one backend's schemas: schema-shipped rules
   * plus pack/core extras, rebuilt when either changes. Registry identity is
   * the cache key - a refreshed SchemaRegistry gets fresh rules.
   */
  private replacementRegistryFor(reg: SchemaRegistry): ReplacementRegistry {
    const cached = this.replacementRegistries.get(reg)
    if (cached && cached.version === this.extraRulesVersion) return cached.registry
    const registry = createReplacementRegistry()
    const diags = [...registerSchemaRules(registry, reg.schemas.values())]
    for (const record of reg.comfyAliases?.records ?? []) {
      diags.push(...registry.register('pack', record.replacement))
    }
    for (const record of reg.comfyGroups?.records ?? []) {
      diags.push(...registry.register('pack', record.replacement))
    }
    for (const { layer, rule } of this.extraRules) diags.push(...registry.register(layer, rule))
    // Synthesized legacy-name rules last, at the lowest-precedence layer:
    // an explicit schema/pack/core rule for the same legacy name always
    // wins over the derived rename (see replace/alias-rules.ts).
    for (const rule of synthesizeAliasRules(reg.schemas.values())) diags.push(...registry.register('core', rule))
    this.reportProblems(GLOBAL_PROBLEMS_OWNER, diags)
    this.replacementRegistries.set(reg, { registry, version: this.extraRulesVersion })
    return registry
  }

  /**
   * Every node in a tab's document a rule can migrate (planned against the
   * tab's target backend). Frozen tabs are snapshots: never scanned.
   */
  scanTabReplacements(tab: Tab): readonly ReplacementScanItem[] {
    if (tab.execution) return []
    const reg = this.registryForTab(tab)
    if (!reg) return []
    const resolve: ReplacementSchemaResolver = (type, role) => this.replacementSchemaOf(reg, type, role)
    return scanReplacements(tab.store.doc, this.replacementRegistryFor(reg), resolve)
  }

  /**
   * Apply planned scan items to a tab: one dispatch (batched when several),
   * one undo step. Returns false when nothing was planned or dispatch failed.
   */
  applyReplacements(tab: Tab, items: readonly ReplacementScanItem[]): boolean {
    const invocation = replacementInvocation(items)
    if (!invocation) return false
    return this.dispatchTo(tab, invocation).ok
  }

  /**
   * Run the once-per-tab upgrade pass for every pending tab whose target
   * backend has schemas. Called on document open (immediate when schemas are
   * already here) and on every backendsTick (deferred arrival/refresh).
   */
  private drainUpgrades(): void {
    if (this.upgradePending.size === 0) return
    for (const tab of this.tabs.get()) {
      if (!this.upgradePending.has(tab.id)) continue
      if (tab.execution) {
        this.upgradePending.delete(tab.id) // frozen snapshots never upgrade
        continue
      }
      if (!this.registryForTab(tab)) continue // still waiting for schemas
      this.upgradePending.delete(tab.id)
      this.upgradeOnOpen(tab)
    }
  }

  /**
   * The upgrade pass for one tab (open time, possibly deferred until its
   * backend's schemas arrive): auto-apply SAFE plans (lossless, warning
   * free) unless review mode is on. Best-effort migration fallbacks always
   * apply because their archived historical state needs no user decision.
   * Everything else lands in Problems so the badge/review flow can take over.
   */
  private upgradeOnOpen(tab: Tab): void {
    this.reportEnvironmentDrift(tab)
    this.reportUnresolvedTypes(tab)
    const items = this.scanTabReplacements(tab)
    // A pass that engaged nothing (e.g. a stock seed on a V1 backend, where
    // it resolves natively) keeps stock provenance: the entitlement to a
    // silent migration must survive until a backend actually claims it.
    if (items.length === 0) return
    const stockPristine = this.stockPending.has(tab.id) && tab.store.revision === 0
    this.stockPending.delete(tab.id) // engaged: silent or loud, provenance is spent
    const review = this.reviewReplacements.get()
    const firstHop = (item: ReplacementScanItem): ReplacementScanItem => {
      const hop = item.hops[0]!
      return {
        ...item,
        hops: [hop],
        terminalType: hop.plan.to,
        status: 'terminal',
        rule: hop.rule,
        plan: hop.plan,
        diagnostics: hop.diagnostics,
        safe: hop.diagnostics.every((entry) => entry.severity === 'info'),
      }
    }
    const nodeKey = (item: ReplacementScanItem): string => JSON.stringify([item.graphId, item.nodeId])
    const appliedMigrations: ReplacementScanItem[] = []
    const failedMigrationNodes = new Set<string>()
    const failedFallbackNodes = new Set<string>()
    let remainingItems = items
    for (;;) {
      const candidate = remainingItems.find((item) =>
        item.hops.some((hop) => hop.rule.migration !== undefined) &&
        (review
          ? item.hops[0]?.plan.migrationFallback === true
          : item.hops.some((hop, index) =>
              hop.plan.migrationFallback === true &&
              item.hops.slice(0, index).every((prefix) =>
                prefix.diagnostics.every((entry) => entry.severity === 'info')),
            ) || item.safe) &&
        !failedMigrationNodes.has(nodeKey(item)),
      )
      if (candidate === undefined) break
      const step = firstHop(candidate)
      if (!this.applyReplacements(tab, [step])) {
        failedMigrationNodes.add(nodeKey(candidate))
        if (step.plan?.migrationFallback === true) failedFallbackNodes.add(nodeKey(candidate))
        continue
      }
      appliedMigrations.push(step)
      remainingItems = this.scanTabReplacements(tab)
    }
    remainingItems = remainingItems.filter((item) =>
      !(failedFallbackNodes.has(nodeKey(item)) && item.hops[0]?.plan.migrationFallback === true),
    )
    const migrationSucceeded = failedMigrationNodes.size === 0

    const maintainedItems = remainingItems.filter((item) => {
      const registry = this.registryForTab(tab)
      return registry?.comfyAliases?.recordsBySourceType.has(item.sourceType) === true ||
        registry?.comfyGroups?.recordsByGroupType.has(item.sourceType) === true
    })
    const maintainedCohortSafe = maintainedItems.every((item) => item.safe)
    const ordinaryAuto = review
      ? []
      : remainingItems.filter((item) =>
          !failedMigrationNodes.has(nodeKey(item)) &&
          item.safe &&
          (maintainedCohortSafe || !maintainedItems.includes(item)),
        )
    const ordinarySucceeded = ordinaryAuto.length === 0 || this.applyReplacements(tab, ordinaryAuto)
    const rest = ordinarySucceeded
      ? remainingItems.filter((item) => !ordinaryAuto.includes(item))
      : remainingItems
    // Stock content stays silent only when every engaged replacement was
    // applied safely. Migration hops run separately so plans that share old
    // graph state cannot invalidate and roll back one another.
    const silentEligible = stockPristine && !review && migrationSucceeded && ordinarySucceeded && rest.length === 0
    const applied = [
      ...appliedMigrations,
      ...(ordinarySucceeded ? ordinaryAuto : []),
    ]
    if (applied.length > 0) {
      if (silentEligible) {
        // Baseline normalization of app-shipped content (see stockPending):
        // the migrated document IS the document; no churn, no undo step.
        tab.store.clearHistory()
      } else {
        this.reportProblems(tab.id, [
          ...applied.flatMap((item) => item.diagnostics.filter((entry) => entry.severity === 'info')),
          diag('info', 'command', 'replace.applied', `applied ${applied.length} replacement step(s) automatically`),
        ])
      }
    }
    if (rest.length > 0) {
      this.reportProblems(tab.id,
        rest.map((i) =>
          diag(
            'warning',
            'command',
            'replace.review',
            i.plan
              ? `node '${i.nodeId}' (${i.sourceType}) can be upgraded to '${i.terminalType}'${i.hops.length > 1 ? ` (${i.hops.length} steps)` : ''} - review via its badge`
              : `node '${i.nodeId}' (${i.sourceType}) has replacement rules but none apply: ${i.diagnostics.map((d) => d.message).join('; ')}`,
          ),
        ),
      )
    }
  }

  /**
   * A node type the target backend cannot resolve renders as a red error
   * shell - correct on canvas, but silently: nothing else says WHY a
   * workflow is dead or that queueing will refuse. Report every unresolved
   * type once at the same boundary as the upgrade pass, so "all my nodes
   * are red" always has a matching Problems entry naming the types and the
   * backend that lacks them. Subgraph-derived '#' types resolve locally and
   * are never reported.
   */
  private reportUnresolvedTypes(tab: Tab): void {
    const registry = this.registryForTab(tab)
    if (!registry) return
    const missing = new Map<string, number>()
    for (const graph of Object.values(tab.store.doc.graphs)) for (const node of Object.values(graph.nodes)) {
      if (
        node.type.startsWith('#') ||
        registry.resolve(node.type) ||
        registry.comfyAliases?.sourceSchemas.has(node.type) === true ||
        registry.comfyGroups?.groupSchemas.has(node.type) === true
      )
        continue
      missing.set(node.type, (missing.get(node.type) ?? 0) + 1)
    }
    if (missing.size === 0) return
    const backend = this.backendForTab(tab)
    this.reportProblems(tab.id,
      [...missing].map(([type, count]) =>
        diag(
          'warning',
          'schema',
          'schema.unresolvedType',
          `'${tab.title}': ${count} node(s) of type '${type}' do not resolve on backend '${backend.label}' - they render with a red hue and thick border (values and links preserved) and are excluded from execution; queueing is blocked when the requested run depends on one`,
        ),
      ),
    )
  }

  /**
   * Wire v10 moved boolean-like two-option combos to real core.boolean
   * inputs; documents saved before the flip stored the option STRING. On the
   * open boundary (and again on explicit retarget - see legacyBooleanPending),
   * rewrite exactly the recognized
   * legacy tokens on BOOLEAN-widget inputs to real booleans (one undo step),
   * so the widget.BOOLEAN.badValue advisory self-heals on load. Anything not
   * an exact recognized token is left alone - the advisory keeps reporting
   * it, and the value still submits unchanged (value-never-hostage).
   */
  private normalizeLegacyBooleans(tab: Tab): void {
    const registry = this.registryForTab(tab)
    if (!registry) return
    const invocations: CommandInvocation[] = []
    for (const [graphId, graph] of Object.entries(tab.store.doc.graphs)) for (const node of Object.values(graph.nodes)) {
      const schema = registry.resolve(node.type)
      if (!schema) continue
      for (const item of schema.items) {
        if (item.kind !== 'input' || item.widget?.widgetType !== 'BOOLEAN') continue
        const value = node.values[item.id]
        if (typeof value !== 'string') continue
        const mapped = LEGACY_BOOLEAN_TOKENS.get(value.toLowerCase())
        if (mapped === undefined) continue
        invocations.push({ command: 'node.setValue', params: { graphId, nodeId: node.id, inputId: item.id, value: mapped } })
      }
    }
    if (invocations.length === 0) return
    if (this.dispatchTo(tab, { command: 'batch', params: { invocations } as unknown as Json }).ok) {
      this.reportProblems(tab.id, [
        diag('info', 'command', 'upgrade.legacyBoolean', `converted ${invocations.length} legacy boolean string value(s) to real booleans (one undo step)`),
      ])
    }
  }

  graphViewport(tabId: string, graphId: string): Viewport | undefined {
    const viewport = this.tabViewStates.get().get(tabId)?.graphViewports[graphId]
    return viewport === undefined ? undefined : { x: viewport.x, y: viewport.y, scale: viewport.scale }
  }

  private nextTabViewUpdate(): TabViewUpdate {
    const updatedAt = Math.max(Date.now(), this.tabViewUpdateTime)
    if (updatedAt === this.tabViewUpdateTime) this.tabViewUpdateSequence += 1
    else {
      this.tabViewUpdateTime = updatedAt
      this.tabViewUpdateSequence = 0
    }
    return { updatedAt, sequence: this.tabViewUpdateSequence, actorId: this.workspaceActorId }
  }

  setGraphViewport(tabId: string, graphId: string, viewport: Viewport): void {
    const tab = this.tabs.get().find((candidate) => candidate.id === tabId && candidate.execution === undefined)
    if (!tab || tab.store.doc.graphs[graphId] === undefined || !Number.isFinite(viewport.x) ||
      !Number.isFinite(viewport.y) || !Number.isFinite(viewport.scale) ||
      viewport.scale < MIN_SCALE || viewport.scale > MAX_SCALE) return
    const current = this.tabViewStates.get().get(tabId)
    const previous = current?.graphViewports[graphId]
    if (previous?.x === viewport.x && previous.y === viewport.y && previous.scale === viewport.scale) return
    this.tabViewStates.update((states) => new Map(states).set(tabId, {
      graphViewports: { ...current?.graphViewports, [graphId]: { ...viewport, update: this.nextTabViewUpdate() } },
      ...(current?.appScroll === undefined ? {} : { appScroll: current.appScroll }),
    }))
    this.schedulePersistTabs()
  }

  appScrollTop(tabId: string): number {
    return this.tabViewStates.get().get(tabId)?.appScroll?.scrollTop ?? 0
  }

  setAppScrollTop(tabId: string, appScrollTop: number): void {
    const tab = this.tabs.get().find((candidate) => candidate.id === tabId && candidate.execution === undefined)
    if (!tab || !Number.isFinite(appScrollTop) || appScrollTop < 0) return
    const current = this.tabViewStates.get().get(tabId)
    if ((current?.appScroll?.scrollTop ?? 0) === appScrollTop) return
    this.tabViewStates.update((states) => new Map(states).set(tabId, {
      graphViewports: current?.graphViewports ?? {},
      appScroll: { scrollTop: appScrollTop, update: this.nextTabViewUpdate() },
    }))
    this.schedulePersistTabs()
  }

  /** Active canvas lens of a tab ('standard' when never switched). */
  lensFor(tabId: string): CanvasLens {
    return this.lenses.get().get(tabId) ?? 'standard'
  }

  setLens(tabId: string, lens: CanvasLens): void {
    if (!this.lensRegistry.get(lens)) return
    this.lenses.update((m) => {
      const next = new Map(m)
      if (lens === 'standard') next.delete(tabId)
      else next.set(tabId, lens)
      return next
    })
  }

  /** Toggle a tab between the default view and the given lens. */
  toggleLens(tabId: string, lens: Exclude<CanvasLens, 'standard'>): void {
    this.lenses.update((m) => {
      const next = new Map(m)
      if (next.get(tabId) === lens) next.delete(tabId)
      else next.set(tabId, lens)
      return next
    })
  }

  /** Retarget a live tab's compile/submit to another connected backend. */
  setTabTarget(tabId: string, id: ConnectionId): void {
    const tab = this.tabs.get().find((t) => t.id === tabId)
    const backend = this.backendFor(id)
    if (!tab || tab.execution || !backend) return
    this.tabTargets.update((m) => new Map(m).set(tabId, id))
    if (
      backend.protocol === 'dinkster' &&
      this.documentNeedsWire43(tab.store.doc) &&
      backend.registry.get()?.resolve(BUILTIN_EDITOR_NODE_IDS.routeSwitchByName) === undefined
    ) {
      void this.loadBackendSchemas(backend)
    }
    // The new target's schemas now interpret the document: re-arm the
    // legacy-boolean pass (idempotent; see legacyBooleanPending). The tick
    // below drains it once the target's registry is available.
    this.legacyBooleanPending.add(tabId)
    // Exception to the no-rearm-on-retarget rule, for STOCK-PRISTINE tabs
    // only: a seed that ran unmigrated on a V1 backend (its pass engaged
    // nothing, so provenance was kept) must still get its silent baseline
    // migration when the user points it at a native backend. User-edited
    // documents keep the badge/review flow.
    if (this.stockPending.has(tabId) && tab.store.revision === 0) this.upgradePending.add(tabId)
    this.backendsTick.update((v) => v + 1)
  }

  /**
   * Switch which center-region editor renders a tab. The tab object is
   * replaced (Tab fields stay
   * readonly) but keeps its id, session, and view state - the same
   * document under a different projection. Frozen tabs stay on the graph
   * editor: their read-only snapshot
   * semantics are canvas-rendered today.
   */
  setTabEditorKind(tabId: string, editorKind: string): void {
    const tab = this.tabs.get().find((t) => t.id === tabId)
    if (!tab || tab.execution !== undefined || tab.editorKind === editorKind) return
    if (editorKind !== IMAGE_EDITOR_KIND && this.imageEditorTarget.get()?.tabId === tabId) this.imageEditorTarget.set(undefined)
    if (editorKind !== CURVE_EDITOR_KIND && this.curveEditorTarget.get()?.tabId === tabId) this.curveEditorTarget.set(undefined)
    if (editorKind !== GLSL_EDITOR_KIND && this.glslEditorTarget.get()?.tabId === tabId) this.glslEditorTarget.set(undefined)
    this.tabs.update((list) => list.map((t) => (t.id === tabId ? { ...t, editorKind } : t)))
    this.schedulePersistTabs()
  }

  openEditorForBinding(tabId: string, context: EditorBindingContext): boolean {
    const binding = this.editorBindings.resolve(context, (candidate) =>
      this.extensionEditorIds.has(candidate.editor) && this.editors.get(candidate.editor) !== undefined)
    if (!binding) return false
    this.setTabEditorKind(tabId, binding.editor)
    this.activeTabId.set(tabId)
    return this.tabs.get().some((tab) => tab.id === tabId && tab.editorKind === binding.editor)
  }

  /**
   * Toggle the app editor between use mode (clean form) and arrange mode
   * (authoring tools visible). Frozen tabs refuse: their document is a
   * read-only snapshot, so there is nothing to arrange.
   */
  setTabAppArrange(tabId: string, appArrange: boolean): void {
    const tab = this.tabs.get().find((t) => t.id === tabId)
    if (!tab || tab.execution !== undefined || (tab.appArrange === true) === appArrange) return
    this.tabs.update((list) => list.map((t) => (t.id === tabId ? { ...t, appArrange } : t)))
  }

  /** Resolve the bounded selected-node entry. Ambiguous, driven, frozen, and non-image inputs refuse. */
  imageTargetForSelection(tab: Tab, graphId: string, selectedNodeIds: readonly string[]): ImageEditorTarget | undefined {
    if (tab.execution !== undefined || selectedNodeIds.length !== 1) return undefined
    const graph = tab.store.doc.graphs[graphId]
    const node = graph?.nodes[selectedNodeIds[0]!]
    if (!graph || !node) return undefined
    if (node.type === BUILTIN_EDITOR_NODE_IDS.maskPaint) {
      const loaderNodeId = maskPaintSourceNodeId(node)
      return loaderNodeId ? this.imageTargetForInput(tab, graphId, loaderNodeId, 'image') : undefined
    }
    const candidates = imageInputCandidates({
      schema: this.registryForTab(tab)?.resolve(node.type),
      nodeId: node.id,
      values: node.values,
      drivenInputIds: new Set([
        ...Object.values(graph.links).flatMap((link) =>
          'node' in link.to && 'port' in link.to && link.to.node === node.id ? [link.to.port] : []),
        ...Object.values(graph.nets).flatMap((net) => net.sinks.flatMap((sink) =>
          sink.node === node.id ? [sink.port] : [])),
      ]),
    })
    const candidate = candidates.length === 1 ? candidates[0] : undefined
    return candidate ? this.maskPaintTarget(tab, graphId, candidate) : undefined
  }

  private maskPaintTarget(tab: Tab, graphId: string, candidate: ReturnType<typeof imageInputCandidates>[number]): ImageEditorTarget | undefined {
    const base: ImageEditorTarget = { tabId: tab.id, graphId, ...candidate }
    const graph = tab.store.doc.graphs[graphId]
    const loader = graph?.nodes[candidate.nodeId]
    const registry = this.registryForTab(tab)
    const loaderSchema = loader ? registry?.resolve(loader.type) : undefined
    const paintSchema = registry?.resolve(BUILTIN_EDITOR_NODE_IDS.maskPaint)
    if (!graph) return base
    const associated = Object.values(graph.nodes).filter((node) =>
      node.type === BUILTIN_EDITOR_NODE_IDS.maskPaint && maskPaintSourceNodeId(node) === candidate.nodeId)
    if (associated.length > 1) return undefined
    const paint = associated[0]
    const paintSource = paint?.values.source
    const paintRecipe = typeof paint?.values.operations === 'string' ? parseMaskPaintRecipe(paint.values.operations) : undefined
    if (paint && (!isAssetRef(paintSource) || !sameAssetRef(paintSource, candidate.sourceRef) ||
        !paintRecipe || paintRecipe.sourceDigest !== candidate.sourceRef.digest)) return undefined
    const hasOccurrenceTopology = Object.values(tab.store.doc.occurrenceTopologies ?? {})
      .some((topology) => topology.bodyGraph === graphId)
    if (loader?.type !== BUILTIN_EDITOR_NODE_IDS.loadImage || candidate.inputId !== 'image' || hasOccurrenceTopology ||
        schemaPortType(loaderSchema, 'input', 'image') !== 'asset<dinkster.image>' ||
        schemaPortType(loaderSchema, 'output', 'image') !== 'dinkster.image' ||
        schemaPortType(loaderSchema, 'output', 'mask') !== 'dinkster.mask' ||
        schemaPortType(paintSchema, 'input', 'source') !== 'asset<dinkster.image>' ||
        schemaPortType(paintSchema, 'input', 'operations') !== 'core.string' ||
        inputsOf(paintSchema!).find((input) => input.id === 'operations')?.widget?.widgetType !== 'STRING' ||
        inputsOf(paintSchema!).find((input) => input.id === 'operations')?.widget?.options.multiline !== true ||
        schemaPortType(paintSchema, 'output', 'mask') !== 'dinkster.mask') return paint ? undefined : base
    const source = { node: candidate.nodeId, port: 'mask' }
    const expectedMaskLinkIds = Object.values(graph.links).filter((link) =>
      'node' in link.from && 'port' in link.from && link.from.node === source.node && link.from.port === source.port).map((link) => link.id).sort()
    const expectedMaskNetIds = Object.values(graph.nets).filter((net) =>
      net.source.node === source.node && net.source.port === source.port).map((net) => net.id).sort()
    if (!paint && expectedMaskLinkIds.length === 0 && expectedMaskNetIds.length === 0) return base
    return {
      ...base,
      maskPaint: {
        expectedMaskLinkIds,
        expectedMaskNetIds,
        paintNodeId: paint?.id ?? null,
        expectedPaintOperations: paint?.values.operations as string | undefined ?? null,
      },
    }
  }

  /** Explicit image-ASSET row entry, revalidated against the current document and schema. */
  imageTargetForInput(tab: Tab, graphId: string, nodeId: string, inputId: string): ImageEditorTarget | undefined {
    if (tab.execution !== undefined) return undefined
    const graph = tab.store.doc.graphs[graphId]
    const node = graph?.nodes[nodeId]
    if (node?.type === BUILTIN_EDITOR_NODE_IDS.maskPaint && inputId === 'source') {
      const loaderNodeId = maskPaintSourceNodeId(node)
      return loaderNodeId ? this.imageTargetForInput(tab, graphId, loaderNodeId, 'image') : undefined
    }
    const schema = node ? this.registryForTab(tab)?.resolve(node.type) : undefined
    const driven = graph && (Object.values(graph.links).some((link) =>
      'node' in link.to && 'port' in link.to && link.to.node === nodeId && link.to.port === inputId) ||
      Object.values(graph.nets).some((net) => net.sinks.some((sink) => sink.node === nodeId && sink.port === inputId)))
    const candidate = node && !driven
      ? imageInputCandidates({ schema, nodeId, values: node.values }).find((item) => item.inputId === inputId)
      : undefined
    return candidate ? this.maskPaintTarget(tab, graphId, candidate) : undefined
  }

  /** Re-resolve a target against current schema, topology, and the complete source ref. */
  validateImageTarget(target: ImageEditorTarget): ImageEditorTarget | undefined {
    const tab = this.tabs.get().find((candidate) => candidate.id === target.tabId)
    if (!tab) return undefined
    const current = this.imageTargetForInput(tab, target.graphId, target.nodeId, target.inputId)
    if (!current) return undefined
    const left = current.sourceRef, right = target.sourceRef
    return left.digest === right.digest && left.name === right.name && left.size === right.size &&
      left.mediaType === right.mediaType && left.virtualPath === right.virtualPath ? current : undefined
  }

  openImageEditor(target: ImageEditorTarget): boolean {
    const validated = this.validateImageTarget(target)
    const tab = validated ? this.tabs.get().find((candidate) => candidate.id === validated.tabId) : undefined
    if (!tab || !validated) return false
    const previous = this.imageEditorTarget.get()
    if (previous && previous.tabId !== validated.tabId) {
      this.tabs.update((list) => list.map((candidate) =>
        candidate.id === previous.tabId && candidate.editorKind === IMAGE_EDITOR_KIND ? { ...candidate, editorKind: GRAPH_EDITOR_KIND } : candidate))
    }
    this.imageEditorTarget.set(validated)
    this.setTabEditorKind(tab.id, IMAGE_EDITOR_KIND)
    this.activeTabId.set(tab.id)
    return this.tabs.get().some((candidate) => candidate.id === tab.id && candidate.editorKind === IMAGE_EDITOR_KIND)
  }

  closeImageEditor(target: ImageEditorTarget | CompositorEditorTarget): void {
    if (this.imageEditorTarget.get() !== target) return
    this.imageEditorTarget.set(undefined)
    this.setTabEditorKind(target.tabId, GRAPH_EDITOR_KIND)
  }

  compositorTargetForInput(
    tab: Tab,
    graphId: string,
    nodeId: string,
    inputId: string,
    instancePath: readonly string[] = [],
  ): CompositorEditorTarget | undefined {
    if (tab.execution !== undefined) return undefined
    const graph = tab.store.doc.graphs[graphId]
    const node = graph?.nodes[nodeId]
    const resolver = this.registryForTab(tab)?.resolve
    const input = node ? resolver?.(node.type)?.items.find((item) =>
      item.kind === 'input' && item.id === inputId) : undefined
    const definitionDriven = graph && (Object.values(graph.links).some((link) =>
      'node' in link.to && 'port' in link.to && link.to.node === nodeId && link.to.port === inputId) ||
      Object.values(graph.nets).some((net) => net.sinks.some((sink) =>
        'port' in sink && sink.node === nodeId && sink.port === inputId)))
    let occurrenceDriven = false
    if (instancePath.length > 0 && graph && resolver) {
      const owner = {
        instancePath: instancePath.slice(0, -1).map(asNodeId),
        node: asNodeId(instancePath.at(-1)!),
      }
      const effective = effectiveOccurrenceTopology(tab.store.doc, resolver, owner)
      if (effective.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return undefined
      occurrenceDriven = effectiveTopologyDrivesPort(
        effective,
        graph.id,
        instancePath.map(asNodeId),
        { node: asNodeId(nodeId), port: asPortId(inputId) },
      )
    }
    return !definitionDriven && !occurrenceDriven &&
      input?.kind === 'input' && input.widget?.widgetType === 'COMPOSITOR'
      ? {
          mode: 'compositor',
          tabId: tab.id,
          graphId,
          nodeId,
          inputId,
          instancePath: [...instancePath],
          openedStoredValue: node?.values[inputId],
        }
      : undefined
  }

  validateCompositorTarget(target: CompositorEditorTarget): CompositorEditorTarget | undefined {
    const tab = this.tabs.get().find((candidate) => candidate.id === target.tabId)
    const current = tab && this.compositorTargetForInput(
      tab, target.graphId, target.nodeId, target.inputId, target.instancePath,
    )
    if (!current || (current.openedStoredValue === undefined) !== (target.openedStoredValue === undefined)) return undefined
    if (current.openedStoredValue !== undefined && target.openedStoredValue !== undefined &&
        canonicalJson(current.openedStoredValue) !== canonicalJson(target.openedStoredValue)) return undefined
    return current
  }

  openCompositorEditor(target: CompositorEditorTarget): boolean {
    const current = this.validateCompositorTarget(target)
    const tab = current ? this.tabs.get().find((candidate) => candidate.id === current.tabId) : undefined
    if (!tab || !current) return false
    const previous = this.imageEditorTarget.get()
    if (previous && previous.tabId !== current.tabId) {
      this.tabs.update((list) => list.map((candidate) =>
        candidate.id === previous.tabId && candidate.editorKind === IMAGE_EDITOR_KIND
          ? { ...candidate, editorKind: GRAPH_EDITOR_KIND }
          : candidate))
    }
    this.imageEditorTarget.set(current)
    this.setTabEditorKind(tab.id, IMAGE_EDITOR_KIND)
    this.activeTabId.set(tab.id)
    return true
  }

  curveTargetForInput(
    tab: Tab,
    graphId: string,
    nodeId: string,
    inputId: string,
    instancePath: readonly string[] = [],
  ): CurveEditorTarget | undefined {
    if (tab.execution !== undefined) return undefined
    const graph = tab.store.doc.graphs[graphId]
    const node = graph?.nodes[nodeId]
    const resolve = this.registryForTab(tab)?.resolve
    const input = node ? resolve?.(node.type)?.items.find((item) => item.kind === 'input' && item.id === inputId) : undefined
    const driven = graph && (Object.values(graph.links).some((link) => 'node' in link.to && 'port' in link.to && link.to.node === nodeId && link.to.port === inputId) ||
      Object.values(graph.nets).some((net) => net.sinks.some((sink) => 'port' in sink && sink.node === nodeId && sink.port === inputId)))
    const stored = node?.values[inputId]
    const fallback = input?.kind === 'input' && input.widget ? effectiveWidgetDefault(input.widget) : undefined
    const value = isCurveValue(stored) ? stored : isCurveValue(fallback) ? fallback : undefined
    if (input?.kind !== 'input' || input.widget?.widgetType !== 'CURVE' || !value) return undefined
    if (driven && graph && node?.type === BUILTIN_EDITOR_NODE_IDS.curve) {
      const sources = companionSourcesOf(graph, undefined, undefined, resolve)
      const envelopeSource = sources.get(nodeId)?.get(inputId)
      const envelope = envelopeSource?.kind === 'producer' && envelopeSource.output === 'curve'
        ? graph.nodes[envelopeSource.node]
        : undefined
      const envelopeCurve = envelope && resolve?.(envelope.type)?.items.find((item) =>
        item.kind === 'output' && item.id === 'curve' && item.type.kind === 'concrete' && item.type.name === 'dinkster.curve')
      const audioSource = envelope?.type === BUILTIN_EDITOR_NODE_IDS.audioEnvelope
        ? sources.get(envelope.id)?.get('audio')
        : undefined
      const audio = audioSource?.kind === 'producer' ? graph.nodes[audioSource.node] : undefined
      const audioOutput = audio && audioSource?.kind === 'producer'
        ? resolve?.(audio.type)?.items.find((item) =>
            item.kind === 'output' && item.id === audioSource.output && item.type.kind === 'concrete' && item.type.name === 'comfy.AUDIO')
        : undefined
      if (envelopeCurve && audioSource?.kind === 'producer' && audioOutput) {
        return {
          tabId: tab.id,
          graphId,
          nodeId,
          inputId,
          instancePath: [...instancePath],
          openedStoredValue: stored,
          openedSchemaDefault: input.widget.default,
          openedValue: value,
          follow: {
            envelopeNodeId: envelope.id,
            audioNodeId: audioSource.node,
            audioOutputId: audioSource.output,
          },
        }
      }
      return undefined
    }
    return !driven
      ? {
          tabId: tab.id,
          graphId,
          nodeId,
          inputId,
          instancePath: [...instancePath],
          openedStoredValue: stored,
          openedSchemaDefault: input.widget.default,
          openedValue: value,
        }
      : undefined
  }

  openCurveEditor(target: CurveEditorTarget): boolean {
    const tab = this.tabs.get().find((candidate) => candidate.id === target.tabId)
    const current = tab && this.curveTargetForInput(
      tab, target.graphId, target.nodeId, target.inputId, target.instancePath,
    )
    if (!tab || !current) return false
    const previous = this.curveEditorTarget.get()
    if (previous && previous.tabId !== current.tabId) {
      this.tabs.update((list) => list.map((candidate) =>
        candidate.id === previous.tabId && candidate.editorKind === CURVE_EDITOR_KIND
          ? { ...candidate, editorKind: GRAPH_EDITOR_KIND }
          : candidate))
    }
    this.curveEditorTarget.set(current)
    this.setTabEditorKind(tab.id, CURVE_EDITOR_KIND)
    this.activeTabId.set(tab.id)
    return true
  }

  closeCurveEditor(target: CurveEditorTarget): void {
    if (this.curveEditorTarget.get() !== target) return
    this.curveEditorTarget.set(undefined)
    this.setTabEditorKind(target.tabId, GRAPH_EDITOR_KIND)
  }

  glslTargetForInput(
    tab: Tab,
    graphId: string,
    nodeId: string,
    inputId: string,
    instancePath: readonly string[] = [],
  ): GlslEditorTarget | undefined {
    if (tab.execution !== undefined || inputId !== 'fragment_shader') return undefined
    const graph = tab.store.doc.graphs[graphId]
    const node = graph?.nodes[nodeId]
    if (node?.type !== BUILTIN_EDITOR_NODE_IDS.glsl) return undefined
    const resolver = this.registryForTab(tab)?.resolve
    const input = resolver?.(node.type)?.items.find((item) =>
      item.kind === 'input' && item.id === inputId)
    const definitionDriven = graph && (Object.values(graph.links).some((link) =>
      'node' in link.to && 'port' in link.to && link.to.node === nodeId && link.to.port === inputId) ||
      Object.values(graph.nets).some((net) => net.sinks.some((sink) =>
        'port' in sink && sink.node === nodeId && sink.port === inputId)))
    let occurrenceDriven = false
    if (instancePath.length > 0 && graph && resolver) {
      const owner = {
        instancePath: instancePath.slice(0, -1).map(asNodeId),
        node: asNodeId(instancePath.at(-1)!),
      }
      const effective = effectiveOccurrenceTopology(tab.store.doc, resolver, owner)
      if (effective.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return undefined
      occurrenceDriven = effectiveTopologyDrivesPort(
        effective,
        graph.id,
        instancePath.map(asNodeId),
        { node: asNodeId(nodeId), port: asPortId(inputId) },
      )
    }
    const stored = node.values[inputId]
    const fallback = input?.kind === 'input' && input.widget
      ? effectiveWidgetDefault(input.widget)
      : undefined
    const value = typeof stored === 'string'
      ? stored
      : typeof fallback === 'string'
        ? fallback
        : undefined
    return !definitionDriven && !occurrenceDriven && value !== undefined &&
      input?.kind === 'input' && input.widget?.widgetType === 'STRING' &&
      input.widget.options['multiline'] === true
      ? {
          tabId: tab.id,
          graphId,
          nodeId,
          inputId: 'fragment_shader',
          instancePath: [...instancePath],
          openedStoredValue: stored,
          openedSchemaDefault: input.widget.default,
          openedValue: value,
        }
      : undefined
  }

  validateGlslTarget(target: GlslEditorTarget): GlslEditorTarget | undefined {
    const tab = this.tabs.get().find((candidate) => candidate.id === target.tabId)
    const current = tab && this.glslTargetForInput(
      tab, target.graphId, target.nodeId, target.inputId, target.instancePath,
    )
    if (!current ||
        (current.openedStoredValue === undefined) !== (target.openedStoredValue === undefined) ||
        (current.openedSchemaDefault === undefined) !== (target.openedSchemaDefault === undefined) ||
        current.openedValue !== target.openedValue) return undefined
    if (current.openedStoredValue !== undefined && target.openedStoredValue !== undefined &&
        canonicalJson(current.openedStoredValue) !== canonicalJson(target.openedStoredValue)) return undefined
    if (current.openedSchemaDefault !== undefined && target.openedSchemaDefault !== undefined &&
        canonicalJson(current.openedSchemaDefault) !== canonicalJson(target.openedSchemaDefault)) return undefined
    return current
  }

  openGlslEditor(target: GlslEditorTarget): boolean {
    const current = this.validateGlslTarget(target)
    const tab = current ? this.tabs.get().find((candidate) => candidate.id === current.tabId) : undefined
    if (!tab || !current) return false
    const previous = this.glslEditorTarget.get()
    if (previous && previous.tabId !== current.tabId) {
      this.tabs.update((list) => list.map((candidate) =>
        candidate.id === previous.tabId && candidate.editorKind === GLSL_EDITOR_KIND
          ? { ...candidate, editorKind: GRAPH_EDITOR_KIND }
          : candidate))
    }
    this.glslEditorTarget.set(current)
    this.setTabEditorKind(tab.id, GLSL_EDITOR_KIND)
    this.activeTabId.set(tab.id)
    return true
  }

  closeGlslEditor(target: GlslEditorTarget): void {
    if (this.glslEditorTarget.get() !== target) return
    this.glslEditorTarget.set(undefined)
    this.setTabEditorKind(target.tabId, GRAPH_EDITOR_KIND)
  }

  private makeTab(
    document: WorkflowDocument,
    title: string,
    execution?: ExecutionRef,
    editorKind: string = GRAPH_EDITOR_KIND,
    store?: DocumentSession,
    initialRegistry?: SchemaRegistry,
  ): Tab {
    const resolve = (type: string): NodeSchema | undefined => {
      // Frozen tabs resolve with their execution's compile-time registry; a
      // lineage lookup would hand them the LIVE tab's current schemas.
      if (execution) return this.registryForExecution(execution)?.resolve(type)
      const tab = this.tabs.get().find((candidate) => !candidate.execution && candidate.store.doc.lineage === document.lineage)
      return (tab ? this.registryForTab(tab) : initialRegistry)?.resolve(type)
    }
    return {
      id: execution ? `frozen:${executionKey(execution)}` : document.lineage,
      title,
      editorKind,
      // A caller-provided store (shared session) replaces the local default.
      store: store ?? createLocalSession(document, coreCommandRegistry([], resolve), {
        schemaResolverFor: (currentDoc) => documentResolver(currentDoc, resolve),
      }),
      graphStack: createSignal<readonly string[]>([document.root]),
      instancePath: createSignal<readonly string[]>([]),
      ...(execution ? { execution } : {}),
    }
  }

  /** Whether closing this live tab would discard library-unpersisted work. */
  isTabDirty(tabId: string): boolean {
    return this.dirtyTabs.get().has(tabId)
  }

  private markTabDirty(tabId: string): void {
    if (this.dirtyTabs.get().has(tabId)) return
    this.dirtyTabs.update((ids) => new Set(ids).add(tabId))
  }

  private markTabClean(tabId: string): void {
    if (!this.dirtyTabs.get().has(tabId)) return
    this.dirtyTabs.update((ids) => {
      const next = new Set(ids)
      next.delete(tabId)
      return next
    })
  }

  /**
   * Append diagnostics to the Problems log under a tab id or app-scoped
   * symbol owner. See visibleProblems.
   */
  reportProblems(owner: ProblemOwner, diags: readonly Diagnostic[]): void {
    if (diags.length === 0) return
    this.problems.update((problems) => {
      const additions = dedupedReportDiagnostics(owner, diags)
        .filter((entry) => !problems.some((candidate) => sameProblemIdentity(candidate, entry)))
      return additions.length === 0 ? problems : [...problems, ...additions]
    })
  }

  clearProblems(owner: ProblemOwner): void {
    this.problems.update((problems) => problems.filter((problem) => problem.owner !== owner))
  }

  /**
   * Replace ALL of one owner's Problems entries with its current snapshot;
   * every other owner's entries are untouched.
   */
  replaceProblems(owner: ProblemOwner, diags: readonly Diagnostic[]): void {
    this.problems.update((p) => [
      ...p.filter((d) => d.owner !== owner),
      ...diags.map((d): OwnedDiagnostic => ({ ...d, owner })),
    ])
  }

  /** Drop an owner's Problems entries (tab close/replace). */
  private dropProblems(owner: ProblemOwner): void {
    if (!this.problems.get().some((d) => d.owner === owner)) return
    this.problems.update((p) => p.filter((d) => d.owner !== owner))
  }

  private countAwareValueInvocations(tab: Tab, invocation: CommandInvocation): readonly CommandInvocation[] {
    if (
      (invocation.command !== 'node.setValue' && invocation.command !== 'node.setValues') ||
      typeof invocation.params !== 'object' ||
      invocation.params === null ||
      Array.isArray(invocation.params)
    ) return [invocation]
    const params = invocation.params as JsonObject
    const graphId = typeof params.graphId === 'string' ? params.graphId : undefined
    const nodeId = typeof params.nodeId === 'string' ? params.nodeId : undefined
    if (graphId === undefined || nodeId === undefined) return [invocation]
    const node = tab.store.doc.graphs[graphId]?.nodes[nodeId]
    const registry = this.registryForTab(tab)
    if (node === undefined || registry === undefined) return [invocation]
    const schema = documentResolver(tab.store.doc, registry.resolve)(node.type)
    if (schema === undefined) return [invocation]
    const countInputs = new Set(outputCountInputsOf(schema))
    if (invocation.command === 'node.setValue') {
      const inputId = typeof params.inputId === 'string' ? params.inputId : undefined
      if (inputId === undefined || !countInputs.has(inputId)) return [invocation]
      return [{
        ...invocation,
        command: 'node.setOutputCount',
        params: { ...params, removedLinks: 'preserve' },
      }]
    }
    if (
      typeof params.values !== 'object' ||
      params.values === null ||
      Array.isArray(params.values)
    ) return [invocation]
    const countValues: [string, Json][] = []
    const ordinaryValues: Record<string, Json> = {}
    for (const [inputId, value] of Object.entries(params.values)) {
      if (countInputs.has(inputId)) countValues.push([inputId, value])
      else ordinaryValues[inputId] = value
    }
    if (countValues.length === 0) return [invocation]
    const normalized: CommandInvocation[] = []
    if (Object.keys(ordinaryValues).length > 0) {
      normalized.push({ ...invocation, params: { ...params, values: ordinaryValues } })
    }
    for (const [inputId, value] of countValues) {
      normalized.push({
        command: 'node.setOutputCount',
        params: { graphId, nodeId, inputId, value, removedLinks: 'preserve' },
      })
    }
    return normalized
  }

  private countAwareValueInvocation(tab: Tab, invocation: CommandInvocation): CommandInvocation {
    if (
      invocation.command === 'batch' &&
      typeof invocation.params === 'object' &&
      invocation.params !== null &&
      !Array.isArray(invocation.params)
    ) {
      const params = invocation.params as JsonObject
      if (!Array.isArray(params.invocations)) return invocation
      const normalized: CommandInvocation[] = []
      for (const candidate of params.invocations) {
        if (
          typeof candidate !== 'object' ||
          candidate === null ||
          Array.isArray(candidate) ||
          typeof candidate.command !== 'string'
        ) return invocation
        normalized.push(...this.countAwareValueInvocations(tab, candidate as unknown as CommandInvocation))
      }
      return { ...invocation, params: { ...params, invocations: normalized } as unknown as Json }
    }
    const normalized = this.countAwareValueInvocations(tab, invocation)
    return normalized.length === 1
      ? normalized[0]!
      : { command: 'batch', params: { invocations: normalized } as unknown as Json }
  }

  /**
   * Dispatch a document command to a tab's store. Rejections land in
   * Problems (append; they do not clobber compile/submit diagnostics).
   * Frozen tabs reject everything silently: read-only is a mode the UI
   * communicates with a banner, not a per-gesture error.
   */
  dispatchTo(tab: Tab, invocation: CommandInvocation): CommandOutcome {
    if (tab.execution) return { ok: false, diagnostics: [] }
    const effective = this.countAwareValueInvocation(tab, invocation)
    const outcome = tab.store.dispatch(effective)
    if (!outcome.ok) this.reportProblems(tab.id, outcome.diagnostics)
    return outcome
  }

  /** Plan, commit, then drill into one fresh empty definition. */
  createEmptySubgraph(tab: Tab, graphId: string, position: Vec2): CommandOutcome {
    if (tab.execution) return { ok: false, diagnostics: [] }
    const occurrenceNodeId = tab.store.predictedNodeId(graphId)
    if (occurrenceNodeId === undefined) return { ok: false, diagnostics: [] }
    const plan = planFreshSubgraphCreate(tab.store.doc, {
      parentGraphId: graphId,
      definition: EMPTY_SUBGRAPH_DEFINITION,
      view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position },
    })
    if (!plan.ok) {
      this.reportProblems(tab.id, plan.diagnostics)
      return { ok: false, diagnostics: plan.diagnostics }
    }
    const outcome = this.dispatchTo(tab, plan.invocation)
    if (outcome.ok) pushGraph(tab, plan.graphId, occurrenceNodeId)
    return outcome
  }

  /** Plan and commit one fresh region occurrence and body definition. */
  createRegion(tab: Tab, graphId: string, position: Vec2, kind: RegionKind): CommandOutcome {
    if (tab.execution) return { ok: false, diagnostics: [] }
    const occurrenceNodeId = tab.store.predictedNodeId(graphId)
    if (occurrenceNodeId === undefined) return { ok: false, diagnostics: [] }
    const plan = planFreshSubgraphCreate(tab.store.doc, {
      parentGraphId: graphId,
      definition: REGION_DEFINITIONS[kind],
      view: REGION_VIEWS[kind],
      occurrence: {
        position,
        values: regionValues(kind),
        region: regionContract(kind),
      },
      name: `${kind[0]!.toUpperCase()}${kind.slice(1)} region`,
    })
    if (!plan.ok) {
      this.reportProblems(tab.id, plan.diagnostics)
      return { ok: false, diagnostics: plan.diagnostics }
    }
    const outcome = this.dispatchTo(tab, plan.invocation)
    return outcome
  }

  /**
   * Open (or focus) the FROZEN view of an execution: a read-only tab over the
   * artifact's exact document snapshot. Returns false when the execution has
   * no artifact (foreign runs submitted by another client).
   */
  openExecutionView(ref: ExecutionRef): boolean {
    const state = this.store.get(ref)
    const artifact = state?.artifact
    if (!artifact) return false
    const id = `frozen:${executionKey(ref)}`
    const existing = this.tabs.get().find((t) => t.id === id)
    if (existing) {
      this.activeTabId.set(id)
      return true
    }
    const title = `${this.tabTitleFor(ref)} @ ${ref.prompt.slice(0, 8)}`
    const tab = this.makeTab(artifact.snapshot, title, ref)
    // The frozen view shows EXACTLY this execution's state; pin it so the
    // store's entry cap cannot evict it while the tab is open.
    this.store.retain(ref)
    this.tabs.update((tabs) => [...tabs, tab])
    this.activeTabId.set(id)
    return true
  }

  /** Close a tab after the caller has handled any dirty-work confirmation. */
  closeTab(id: string): void {
    this.releaseFrozenPin(id)
    const remaining = this.tabs.get().filter((t) => t.id !== id)
    this.tabs.set(remaining)
    this.cleanupClosedTab(id)
    if (this.activeTabId.get() === id) this.activeTabId.set(remaining[0]?.id ?? '')
  }

  /**
   * Drop the execution pin of an open frozen tab about to be closed or
   * displaced (a same-id replacement removes the frozen view just like a
   * close). Must run BEFORE the tab list drops the tab, exactly once per
   * removal.
   */
  private releaseFrozenPin(id: string): void {
    // Release every frozen match: an unrestricted workflow lineage can
    // collide with a frozen tab id, putting a live tab first in the list
    // while the removal still drops the frozen tab behind it.
    for (const tab of this.tabs.get()) {
      if (tab.id === id && tab.execution) this.store.release(tab.execution)
    }
  }

  private cleanupClosedTab(id: string): void {
    if (this.imageEditorTarget.get()?.tabId === id) this.imageEditorTarget.set(undefined)
    if (this.curveEditorTarget.get()?.tabId === id) this.curveEditorTarget.set(undefined)
    if (this.glslEditorTarget.get()?.tabId === id) this.glslEditorTarget.set(undefined)
    this.dropCollabFor(id) // leave the shared session; the server session survives
    this.dropProblems(id) // its diagnostics may not outlive the tab
    this.followLatestExecution(id) // drop view state; no leak for reused ids
    this.dropTabTarget(id)
    this.upgradePending.delete(id)
    this.stockPending.delete(id)
    this.legacyBooleanPending.delete(id)
    // comparisonCompiles / sourceDocCache / hashCache are WeakMaps keyed by
    // the Tab object itself: dropping the tab drops its cache entries.
    this.libraryLinks.delete(id)
    this.markTabClean(id)
    if (this.tabViewStates.get().has(id)) {
      this.tabViewStates.update((states) => {
        const next = new Map(states)
        next.delete(id)
        return next
      })
    }
    if (this.lenses.get().has(id)) {
      this.lenses.update((m) => {
        const next = new Map(m)
        next.delete(id)
        return next
      })
    }
  }

  /**
   * Close with an explicit discard decision. Keeping the decision callback
   * outside AppState keeps dialog presentation separate from the safety
   * invariant.
   */
  requestCloseTab(id: string, confirmDiscard: () => boolean): boolean {
    if (!this.tabs.get().some((tab) => tab.id === id)) return false
    if (this.isTabDirty(id) && !confirmDiscard()) return false
    this.closeTab(id)
    return true
  }

  /** Create and activate a structurally valid empty workflow. */
  createWorkflow(): Tab {
    const diagnostics = this.openDocument(emptyWorkflowJson(), 'Untitled')
    if (diagnostics.length > 0) throw new Error('internal empty workflow did not validate')
    return this.activeTab()!
  }

  // -- Collaboration (shared sessions; docs/collaboration.md) ---------------

  /**
   * The backend whose collab surface shared sessions use: the active tab's
   * backend when it speaks dinkster, else the first dinkster backend. The surface
   * is native-only (v1 servers have no session routes), so undefined means
   * "collaboration unavailable", which the panel says in words.
   */
  collabBackend(): Backend | undefined {
    const active = this.activeTab()
    const preferred = active !== undefined ? this.backendForTab(active) : undefined
    if (preferred?.protocol === 'dinkster') return preferred
    return this.backends.get().find((b) => b.protocol === 'dinkster')
  }

  collabFor(tabId: string): CollabTabState | undefined {
    return this.collabTabs.get().get(tabId)
  }

  /** The collab backend's joinable sessions in the app discovery scope. */
  async listCollabSessions(): Promise<readonly CollabSessionDescriptor[]> {
    const backend = this.collabBackend()
    if (backend === undefined) return []
    return (await this.collabTransport.list(backend.baseUrl, COLLAB_SCOPE))
      .filter((descriptor) => (descriptor.documentKind ?? 'workflow') === 'workflow')
  }

  /**
   * Publish the active tab's document as a new shared session and swap the
   * tab onto a SharedDocumentSession joined to it. Collab actions return an
   * error message instead of throwing: the collab panel renders it inline,
   * and a failed share must leave the local tab exactly as it was.
   */
  async shareActiveTab(): Promise<string | undefined> {
    const tab = this.activeTab()
    if (tab === undefined || tab.execution !== undefined) return 'only a live workflow tab can be shared'
    if (this.collabTabs.get().has(tab.id)) return 'this tab is already in a shared session'
    const backend = this.collabBackend()
    if (backend === undefined) return 'no Dinkster backend connected (collaboration is native-only)'
    const key = `share:${tab.id}`
    if (this.collabPending.has(key)) return 'this tab is already being shared'
    this.collabPending.add(key)
    try {
      // The snapshot is the document at THIS revision; adoption re-verifies
      // both (expect below) so edits/closure during the awaits can never be
      // silently overwritten by the stale snapshot.
      const expect = { store: tab.store, revision: tab.store.revision }
      const descriptor = await this.collabTransport.create(backend.baseUrl, {
        scope: COLLAB_SCOPE,
        documentId: tab.store.doc.lineage,
        snapshot: tab.store.doc,
      })
      try {
        await this.adoptCollabSession(descriptor, backend.baseUrl, tab.title, { expect })
        return undefined
      } catch (e) {
        // The server session was created but nobody adopted it: it must not
        // linger in the discovery list. Best-effort - a failed DELETE leaves
        // an empty session the backend's retention rules own.
        void this.collabTransport.end(backend.baseUrl, descriptor.sessionId).catch(() => undefined)
        throw e
      }
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      this.collabPending.delete(key)
    }
  }

  /**
   * Join a discovered session. A tab already joined to it is focused instead
   * of joined twice (one membership per session per app).
   */
  async joinCollabSession(sessionId: string): Promise<string | undefined> {
    const existing = [...this.collabTabs.get().entries()].find(([, s]) => s.descriptor.sessionId === sessionId)
    if (existing !== undefined) {
      this.activeTabId.set(existing[0])
      return undefined
    }
    const backend = this.collabBackend()
    if (backend === undefined) return 'no Dinkster backend connected (collaboration is native-only)'
    const key = `join:${sessionId}`
    if (this.collabPending.has(key)) return 'joining this session is already in progress'
    this.collabPending.add(key)
    try {
      const descriptor = await this.collabTransport.get(backend.baseUrl, sessionId)
      if (descriptor === undefined) return 'that session no longer exists'
      await this.adoptCollabSession(descriptor, backend.baseUrl, descriptor.documentId)
      return undefined
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    } finally {
      this.collabPending.delete(key)
    }
  }

  /**
   * Leave a shared session, keeping the CURRENT document as an ordinary
   * local tab (same id/position; drill-in preserved). The server session
   * lives on for other participants.
   *
   * Leaving establishes a FRESH history baseline (canUndo false): shared
   * history interleaves other actors' ops, so replaying pre-leave inverses
   * against the departed document is not meaningful. Deliberate, tested
   * (collab.test.ts), and documented in docs/collaboration.md.
   */
  leaveCollabSession(tabId: string): void {
    const entry = this.collabTabs.get().get(tabId)
    if (entry === undefined) return
    const tab = this.tabs.get().find((t) => t.id === tabId)
    this.dropCollabFor(tabId)
    if (tab === undefined) return
    const local = this.makeTab(entry.session.doc, tab.title, undefined, tab.editorKind)
    // The session's doc is the stack's document: every drilled graph exists.
    local.graphStack.set(tab.graphStack.get())
    local.instancePath.set(tab.instancePath.get())
    this.tabs.update((tabs) => tabs.map((t) => (t.id === tabId ? local : t)))
  }

  /** DELETE the server session for every participant, then fall back local. */
  async endCollabSession(tabId: string): Promise<string | undefined> {
    const entry = this.collabTabs.get().get(tabId)
    if (entry === undefined) return 'this tab is not in a shared session'
    try {
      await this.collabTransport.end(entry.baseUrl, entry.descriptor.sessionId)
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
    // Only downgrade the membership DELETE targeted: if the tab left and
    // joined another session while the DELETE was in flight, this stale
    // completion must not tear the new membership down.
    if (this.collabTabs.get().get(tabId) === entry) this.leaveCollabSession(tabId)
    return undefined
  }

  /**
   * Stand a joined SharedDocumentSession up as a tab. The tab id is the
   * snapshot document's lineage, so this follows openDocument's same-lineage
   * replacement pattern: the sharer's own tab is replaced IN PLACE (view
   * state ownership keys survive; WeakMap caches die with the old Tab), a
   * joiner gets a fresh tab. Conflicts and session errors land in the
   * Problems panel under the tab's owner id.
   */
  private async adoptCollabSession(
    descriptor: CollabSessionDescriptor,
    baseUrl: string,
    title: string,
    opts?: {
      /**
       * Share-path guard: adoption commits only if the tab being shared still
       * exists with this exact store at this exact revision. Edits made or a
       * close/replace performed while create+connect were in flight would
       * otherwise be silently overwritten by the snapshot captured at share
       * time. Joins pass no expectation: a joiner takes the session's document
       * as truth by definition.
       */
      readonly expect?: { readonly store: DocumentSession; readonly revision: number }
      /**
       * Rejoin guard: adoption commits only while the restored tab's exact
       * DocumentSession still owns its id - a tab the user closed or
       * replaced during the in-flight probe/connect must never be
       * resurrected. The token is the STORE, not the Tab object: editor-kind
       * switches replace the Tab while keeping the store, and must not
       * cancel a valid rejoin. No revision check either: for a rejoin the
       * SERVER's document is truth by policy, local edits included.
       */
      readonly requireStore?: DocumentSession
      /** false = adopt without stealing focus (reload rejoin). Default true. */
      readonly activate?: boolean
    },
  ): Promise<void> {
    const expect = opts?.expect
    const actorId = this.collabTransport.bindActor === undefined ? this.collabActorId
      : await this.collabTransport.bindActor(baseUrl, descriptor.sessionId, this.collabActorId)
    this.collabActorId = actorId
    const connection = this.collabTransport.connect({
      baseUrl,
      sessionId: descriptor.sessionId,
      actorId,
    })
    // The Problems owner (= lineage) is known only after the snapshot loads;
    // the sinks read it lazily. Nothing can fire before it is set: conflicts
    // and errors need ingress, which needs the session to exist.
    let owner: string | undefined
    const report = (d: Diagnostic) => this.reportProblems(owner ?? GLOBAL_PROBLEMS_OWNER, [d])
    let session: SharedDocumentSession
    try {
      session = await connectSharedSession(connection, coreCommandRegistry([], (type) => {
        const tab = this.tabs.get().find((c) => !c.execution && c.store.doc.lineage === owner)
        return tab ? this.registryForTab(tab)?.resolve(type) : undefined
      }), {
        actorId,
        schemaResolverFor: (currentDoc) => documentResolver(currentDoc, (type) => {
          const tab = this.tabs.get().find((candidate) => !candidate.execution && candidate.store.doc.lineage === owner)
          return tab ? this.registryForTab(tab)?.resolve(type) : undefined
        }),
        onConflict: (conflict: SessionConflict) =>
          report(diag('warning', 'collab', `collab.conflict.${conflict.during}`,
            `a concurrent edit dropped your '${conflict.invocation.command}': ${conflict.diagnostics.find((d) => d.severity === 'error')?.message ?? 'no longer applicable'}`)),
        onError: (message: string) => report(diag('error', 'collab', 'collab.session', message)),
      })
    } catch (e) {
      connection.close() // a failed join must not leak a retrying socket
      throw e
    }
    owner = session.doc.lineage
    if (session.status.get() === 'closed' || session.status.get() === 'error') {
      // The session ended during the join itself (a session_closed frame
      // buffered by the transport replays synchronously at subscription):
      // never stand a dead session up as a membership.
      session.close()
      throw new CollabSessionEndedDuringJoinError()
    }
    const prior = this.tabs.get().find((t) => t.id === owner && t.execution === undefined)
    if (expect !== undefined && (prior === undefined || prior.store !== expect.store || expect.store.revision !== expect.revision)) {
      session.close()
      throw new Error(
        prior === undefined
          ? 'the workflow was closed while sharing was being set up'
          : 'the workflow changed while sharing was being set up; share it again',
      )
    }
    if (opts?.requireStore !== undefined && prior?.store !== opts.requireStore) {
      session.close()
      throw new CollabRejoinTabGoneError()
    }
    if (expect !== undefined && JSON.stringify(session.doc) === JSON.stringify(expect.store.doc)) {
      session.adoptHistory(expect.store.historySnapshot())
    }
    this.dropCollabFor(owner) // re-adopting over a shared tab closes the old session
    if (prior !== undefined) {
      this.reconcileDocumentPersistenceRevision(owner, prior.store.doc, session.doc)
    }
    const tab = this.makeTab(session.doc, title, undefined, prior?.editorKind ?? GRAPH_EDITOR_KIND, session)
    if (prior !== undefined && prior.graphStack.get().every((g) => session.doc.graphs[g] !== undefined)) {
      tab.graphStack.set(prior.graphStack.get())
      tab.instancePath.set(prior.instancePath.get())
    }
    this.replaceProblems(tab.id, [])
    this.markTabDirty(tab.id) // shared edits are library-unpersisted work
    this.followLatestExecution(tab.id)
    this.releaseFrozenPin(tab.id) // a displaced frozen view drops its pin
    this.tabs.update((tabs) =>
      tabs.some((t) => t.id === tab.id) ? tabs.map((t) => (t.id === tab.id ? tab : t)) : [...tabs, tab],
    )
    if (opts?.activate !== false) this.activeTabId.set(tab.id)
    const presence = new PresenceChannel(session, actorId)
    // A session that ends REMOTELY (session_closed, terminal error) never
    // passes through dropCollabFor's explicit dispose, which would leave the
    // channel's timers and listener running against a dead membership - so
    // the channel's lifetime is tied to the status signal here. dispose() is
    // idempotent; the explicit leave/close paths are unaffected.
    const unwatch = session.status.subscribe((status) => {
      if (status === 'closed' || status === 'error') {
        unwatch()
        presence.dispose()
        // A session that settles closed REMOTELY (session_closed) falls
        // back local as in leave (docs/collaboration.md). The membership
        // guard distinguishes remote closure from the explicit leave/end
        // path, where dropCollabFor removes the entry BEFORE closing the
        // session. A terminal ERROR keeps the membership: the red status
        // stays visible and the user chooses when to leave.
        if (status === 'closed' && this.collabTabs.get().get(tab.id)?.session === session) {
          this.leaveCollabSession(tab.id)
        }
      }
    })
    const status = session.status.get() // subscribe is not called on subscribe
    if (status === 'closed' || status === 'error') {
      unwatch()
      presence.dispose()
    }
    this.collabTabs.update((m) => new Map(m).set(tab.id, { descriptor, baseUrl, session, presence }))
    this.persistCollabMemberships()
    connection.onEvent((event) => {
      if (event.kind === 'denial') void session.settle().catch(() => {})
    })
    if (connection.denial !== undefined) void session.settle().catch(() => {})
  }

  /** Close and forget a tab's shared session (tab close/replace/leave). */
  private dropCollabFor(tabId: string): void {
    // An explicit close/replace/leave of the tab is a definite outcome for a
    // membership whose rejoin is still pending on this document: without
    // this, a transiently-failed record would outlive the user closing the
    // tab and resurrect it on a later reload.
    let pendingDropped = false
    for (const [key, record] of this.collabRejoinPending) {
      if (record.documentId === tabId) {
        this.collabRejoinPending.delete(key)
        pendingDropped = true
      }
    }
    const entry = this.collabTabs.get().get(tabId)
    if (entry === undefined) {
      if (pendingDropped) this.persistCollabMemberships()
      return
    }
    // Membership leaves the map BEFORE the session closes: closing flips
    // the status signal, and the remote-closure watcher (adoptCollabSession)
    // falls back local only while the membership is still current - removal
    // first is what distinguishes this explicit path from a remote close.
    this.collabTabs.update((m) => {
      const next = new Map(m)
      next.delete(tabId)
      return next
    })
    entry.presence.dispose() // before close: the gone frame needs the live WS
    entry.session.close() // closes the transport connection too
    this.persistCollabMemberships()
  }

  /**
   * Mirror the LIVE memberships into storage, derived from collabTabs (the
   * single source of membership truth) at both mutation throats. Records
   * whose startup rejoin failed transiently ride along untouched - the
   * session may still exist, so its record must survive adopt/drop churn in
   * this session for a later reload to retry (a live adoption of the same
   * session supersedes its pending record).
   */
  private persistCollabMemberships(): void {
    const live = [...this.collabTabs.get().entries()].map(([tabId, entry]) => ({
      sessionId: entry.descriptor.sessionId,
      baseUrl: entry.baseUrl,
      documentId: entry.descriptor.documentId,
      title: this.tabs.get().find((t) => t.id === tabId)?.title ?? entry.descriptor.documentId,
    }))
    const liveKeys = new Set(live.map((r) => collabMembershipKey(r.baseUrl, r.sessionId)))
    savePersistedCollabMemberships([
      ...live,
      ...[...this.collabRejoinPending.entries()].filter(([key]) => !liveKeys.has(key)).map(([, r]) => r),
    ])
  }

  /**
   * Reload rejoin (start()): probe each persisted membership and re-adopt
   * the live ones INTO their restored tabs. A membership belongs to the tab
   * the reload restored (same lineage id = record.documentId); rejoin never
   * appends a fresh tab, and adoption commits only while that exact restored
   * Tab still stands - one the user closes or replaces during the in-flight
   * probe/connect must never be resurrected (requireTab). The restored tab
   * is replaced in place with the shared session's document: the SERVER's
   * state is truth for a shared tab.
   *
   * Outcomes per record: adopted (record now lives as a live membership); no
   * restored tab, 404 probe, or tab closed mid-rejoin (definite - the record
   * dies); transient failure (backend down, network - the record rides in
   * collabRejoinPending for the next reload to retry, and dies if its tab is
   * explicitly closed first; see dropCollabFor).
   *
   * Public for tests (start() wires real backend connections); safe to call
   * again - concurrent calls single-flight per membership, and a session an
   * earlier call already joined is skipped.
   */
  async rejoinCollabSessions(): Promise<void> {
    const persisted = loadPersistedCollabMemberships()
    if (persisted.length === 0) return
    await Promise.all(persisted.map(async (record) => {
      const key = collabMembershipKey(record.baseUrl, record.sessionId)
      const flight = `rejoin:${key}`
      if (this.collabPending.has(flight)) return // already being rejoined
      this.collabPending.add(flight)
      let restored: Tab | undefined
      try {
        if (
          [...this.collabTabs.get().values()].some(
            (e) => e.baseUrl === record.baseUrl && e.descriptor.sessionId === record.sessionId,
          )
        ) {
          this.collabRejoinPending.delete(key) // already live: nothing pending
          return
        }
        restored = this.tabs.get().find((t) => t.id === record.documentId && t.execution === undefined)
        if (restored === undefined) {
          this.collabRejoinPending.delete(key) // its tab was not restored: record dies
          return
        }
        // Unresolved counts as pending FROM HERE: any persist that runs while
        // the probe/connect is in flight (another membership adopting, an
        // unrelated tab closing, even a crash before this settles) must keep
        // writing this record - it has no live entry yet to represent it.
        this.collabRejoinPending.set(key, record)
        const descriptor = await this.collabTransport.get(record.baseUrl, record.sessionId)
        if (descriptor === undefined) {
          this.collabRejoinPending.delete(key) // session gone (404): record dies
          return
        }
        // Rejoin must not steal focus: the reload restored the user's active
        // tab, and adoption of a background membership must leave it active.
        await this.adoptCollabSession(descriptor, record.baseUrl, record.title, {
          requireStore: restored.store,
          activate: false,
        })
        this.collabRejoinPending.delete(key)
      } catch (e) {
        // Transient failures keep the record for the next reload - but only
        // while the restored store still owns the document. A tab closed or
        // replaced during the flight is a definite outcome regardless of how
        // the flight itself ended.
        const current = this.tabs.get().find((t) => t.id === record.documentId && t.execution === undefined)
        if (
          e instanceof CollabRejoinTabGoneError ||
          e instanceof CollabSessionEndedDuringJoinError ||
          current?.store !== restored?.store
        ) {
          this.collabRejoinPending.delete(key)
        }
      } finally {
        this.collabPending.delete(flight)
      }
    }))
    this.persistCollabMemberships() // drops dead records, keeps pending ones
  }

  private dropTabTarget(tabId: string): void {
    if (!this.tabTargets.get().has(tabId)) return
    this.tabTargets.update((m) => {
      const next = new Map(m)
      next.delete(tabId)
      return next
    })
  }

  activeTab(): Tab | undefined {
    return this.tabs.get().find((t) => t.id === this.activeTabId.get())
  }

  /** Publish polite, auto-clearing operation feedback in the status bar. */
  showTransientStatus(message: string): void {
    if (this.transientStatusTimer !== undefined) clearTimeout(this.transientStatusTimer)
    this.transientStatus.set(message)
    const timer = setTimeout(() => {
      if (this.transientStatusTimer !== timer) return
      this.transientStatusTimer = undefined
      this.transientStatus.set(undefined)
    }, 4_000)
    this.transientStatusTimer = timer
    ;(timer as unknown as { unref?: () => void }).unref?.()
  }

  /**
   * Open a workflow document as a new tab (runs the full load/migration
   * pipeline; legacy litegraph workflows are translated - never kept - via
   * the current schema registry) and activate it. Returns load diagnostics
   * on failure; on success, non-fatal translation warnings land in the
   * problems panel for review.
   */
  openDocument(json: unknown, title: string, importVia?: Backend, forkOnCollision = false): readonly Diagnostic[] {
    const legacy = detectFormat(json) === 'litegraph-workflow'
    const digestHints = legacy ? legacyAssetDigestHints(json) : []
    // A legacy document is translated through the schemas of the backend it
    // is INTENDED for: callers that fetched it from a specific backend pass
    // that backend (library/template/run opens); a local file import falls
    // back to the active tab's backend, then the default.
    const active = this.activeTab()
    const importBackend = legacy
      ? importVia ?? (active !== undefined ? this.backendForTab(active) : this.backends.get()[0])
      : undefined
    const importRegistry = importBackend?.registry.get()
    const legacyLoaded = legacy ? this.importLegacy(json, importRegistry) : undefined
    const loaded = legacyLoaded ?? loadDocument(json)
    if (!loaded.document) {
      // No tab exists to own a failed load; the errors are app-scoped
      // operation feedback (visible regardless of the active canvas).
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, loaded.diagnostics)
      return loaded.diagnostics
    }
    let document = loaded.document
    if (forkOnCollision && this.tabs.get().some((tab) => !tab.execution && tab.id === document.lineage)) {
      let lineage: LineageId
      do lineage = asLineageId(`${document.lineage}-import-${Date.now()}-${++newWorkflowOrdinal}`)
      while (this.tabs.get().some((tab) => tab.id === lineage))
      document = { ...document, lineage }
    }
    const replacesExisting = this.tabs.get().some((candidate) => !candidate.execution && candidate.id === document.lineage)
    if (replacesExisting) {
      this.markDocumentPersistenceDirty(document.lineage)
    }
    const tab = this.makeTab(document, title, undefined, GRAPH_EDITOR_KIND, undefined, importRegistry)
    if (replacesExisting) this.workspaceReplacements.add(tab)
    let loadDiagnostics = loaded.diagnostics
    if (legacyLoaded?.groupTranslation !== undefined) {
      const outcome = tab.store.dispatch(legacyLoaded.groupTranslation.invocation)
      loadDiagnostics = outcome.ok
        ? legacyLoaded.groupTranslation.successDiagnostics
        : [
            ...loaded.diagnostics,
            ...outcome.diagnostics,
            diag(
              'warning',
              'import',
              'import.comfyGroup.review',
              'ComfyUI node groups were left unchanged because their atomic native replacement failed',
            ),
          ]
    }
    // Load/translation warnings belong to the tab they describe: a
    // same-lineage replacement swaps them out; other tabs keep theirs.
    this.replaceProblems(tab.id, loadDiagnostics)
    this.markTabDirty(tab.id)
    this.followLatestExecution(tab.id) // a replaced document starts unpinned
    this.dropTabTarget(tab.id) // ... and untargeted
    this.libraryLinks.delete(tab.id) // ... and unlinked (openFromLibrary relinks)
    this.dropCollabFor(tab.id) // a replaced shared tab leaves its session
    this.releaseFrozenPin(tab.id) // a displaced frozen view drops its pin
    // Session-keyed caches (sourceDocCache etc.) die with the replaced Tab.
    this.tabs.update((tabs) => [...tabs.filter((t) => t.id !== tab.id), tab])
    this.activeTabId.set(tab.id)
    this.upgradePending.add(tab.id)
    this.legacyBooleanPending.add(tab.id)
    this.drainLegacyBooleans() // immediate when schemas are already loaded
    this.drainUpgrades()
    const backend = this.backendForTab(tab)
    if (
      backend.protocol === 'dinkster' &&
      this.documentNeedsWire43(document) &&
      backend.registry.get()?.resolve(BUILTIN_EDITOR_NODE_IDS.routeSwitchByName) === undefined
    ) {
      void this.loadBackendSchemas(backend)
    }
    if (legacy && importBackend?.protocol === 'dinkster') void this.offerImportAssetResolution(tab, importBackend, digestHints)
    return []
  }

  private legacyAssetReferences(tab: Tab, backend: Backend): readonly ImportAssetReference[] {
    const registry = backend.registry.get()
    if (!registry) return []
    const refs: ImportAssetReference[] = []
    for (const [graphId, graph] of Object.entries(tab.store.doc.graphs)) for (const node of Object.values(graph.nodes)) {
      const schema = registry.comfyAliases?.sourceSchemas.get(node.type) ?? registry.resolve(node.type)
      if (!schema) continue
      for (const item of schema.items) {
        if (item.kind !== 'input' || item.widget?.widgetType !== 'ASSET') continue
        const value = node.values[item.id]
        if (typeof value === 'string') refs.push({ graphId, nodeId: node.id, inputId: item.id, name: value })
      }
    }
    return refs
  }

  private async offerImportAssetResolution(
    tab: Tab,
    backend: Backend & { protocol: 'dinkster' },
    digestHints: readonly ImportAssetDigestHint[],
  ): Promise<void> {
    const registry = backend.registry.get()
    const refs = this.legacyAssetReferences(tab, backend)
    const names = [...new Set(refs.map((ref) => ref.name))]
    if (names.length === 0) return
    const liveTab = (): Tab | undefined => this.tabs.get().find((candidate) =>
      candidate.id === tab.id &&
      candidate.graphStack === tab.graphStack &&
      candidate.instancePath === tab.instancePath)
    const basenameNames = importAssetBasenamesForNames(names)
    try {
      const matches = await backend.connection.guessAssets(names, importAssetDigestHintsForNames(names, digestHints))
      const basenameMatches = basenameNames.length > 0 ? await backend.connection.guessAssets(basenameNames) : []
      const current = liveTab()
      if (current === undefined || backend.registry.get() !== registry) return
      const liveRefs = refs.filter((ref) =>
        current.store.doc.graphs[ref.graphId]?.nodes[ref.nodeId]?.values[ref.inputId] === ref.name)
      if (liveRefs.length === 0) return
      const liveNames = [...new Set(liveRefs.map((ref) => ref.name))]
      const plan = planImportAssetAutoresolution(liveRefs, matches, digestHints, basenameMatches)
      const invocations: CommandInvocation[] = []
      for (const ref of liveRefs) {
        const candidate = Object.prototype.hasOwnProperty.call(plan.auto, ref.name) ? plan.auto[ref.name] : undefined
        if (!candidate) continue
        const value = assetGuessCandidateToRef(candidate)
        if (!value) continue
        invocations.push({ command: 'node.setValue', params: {
          graphId: ref.graphId,
          nodeId: ref.nodeId,
          inputId: ref.inputId,
          value: { ...value },
        } })
      }
      const appliedNames = new Set<string>()
      if (invocations.length > 0) {
        const outcome = this.dispatchTo(current, { command: 'batch', params: { invocations } as unknown as Json })
        if (outcome.ok) {
          for (const name of liveNames) if (Object.prototype.hasOwnProperty.call(plan.auto, name)) appliedNames.add(name)
          this.reportProblems(current.id, plan.provenance.map((entry) => diag(
            'info',
            'import',
            'import.assets.autoResolved',
            `${entry.original} -> ${entry.candidate.virtualPath} (${entry.candidate.digest})`,
          )))
        }
      }
      const leftoverNames = liveNames.filter((name) => !appliedNames.has(name))
      if (leftoverNames.length === 0) return
      const leftoverRefs = liveRefs.filter((ref) => !appliedNames.has(ref.name))
      // The navigation signals identify this document owner across a shared
      // workspace promotion while excluding a same-lineage replacement.
      installImportAssetResolution({
        matches: importAssetMatchesForNames(leftoverNames, matches, basenameMatches),
        refs: leftoverRefs,
        reasons: plan.prompt,
        slot: this.importAssetResolution,
        tabStillOpen: () => liveTab() !== undefined,
        dispatch: (invocation) => {
          const owner = liveTab()
          if (owner !== undefined) this.dispatchTo(owner, invocation)
        },
      })
    } catch (error) {
      const owner = liveTab()
      if (owner === undefined) return
      this.reportProblems(owner.id, [diag('warning', 'import', 'import.assets.guessFailed', error instanceof Error ? error.message : String(error))])
    }
  }

  /**
   * The document a save/download of this tab should write: the tab's
   * current document with a FRESH environment stamp from its target
   * backend's live schemas (used packs + used node-type signatures).
   * Frozen tabs export their snapshot verbatim (re-stamping a historical
   * record would misrepresent the producing environment), and when the
   * live surface cannot stamp (V1 backend, schemas not loaded) any
   * existing stamp is PRESERVED rather than overwritten - the last known
   * producing environment beats no record at all.
   */
  exportDocument(tabId: string): WorkflowDocument | undefined {
    const tab = this.tabs.get().find((t) => t.id === tabId)
    return tab ? this.stampedDocumentOf(tab) : undefined
  }

  /** Download a live tab through the same freshly-stamped export path as save. */
  exportWorkflow(tabId: string): boolean {
    const tab = this.tabs.get().find((candidate) => candidate.id === tabId)
    if (!tab || tab.execution) return false
    const filename = workflowExportFilename(tab.title)
    let url: string | undefined
    let anchor: HTMLAnchorElement | undefined
    try {
      const blob = new Blob([`${JSON.stringify(this.stampedDocumentOf(tab), null, 2)}\n`], {
        type: WORKFLOW_MEDIA_TYPE,
      })
      url = URL.createObjectURL(blob)
      anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.hidden = true
      document.body.append(anchor)
      anchor.click()
      this.showTransientStatus(`Download started: ${filename}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'validation', 'workflow.exportFailed', `failed to export workflow: ${message}`),
      ])
      this.showTransientStatus(`Could not export ${filename}: ${message}`)
      return false
    } finally {
      if (anchor !== undefined || url !== undefined) {
        const cleanup = setTimeout(() => {
          anchor?.remove()
          if (url !== undefined) URL.revokeObjectURL(url)
        }, 0)
        ;(cleanup as unknown as { unref?: () => void }).unref?.()
      }
    }
  }

  /**
   * Parse a local file and route it through the one document ingress. That
   * ingress also detects full LiteGraph/ComfyUI workflows and imports them
   * through the schema-aware legacy translator.
   */
  async importWorkflowFile(file: Pick<File, 'name' | 'text'>, stillOwned: () => boolean = () => true): Promise<boolean> {
    try {
      const title = file.name.replace(/\.json$/i, '') || 'Imported workflow'
      const text = await file.text()
      if (!stillOwned()) return false
      const diagnostics = this.openDocument(JSON.parse(text) as unknown, title, undefined, true)
      if (diagnostics.length > 0) {
        this.showTransientStatus(`Could not import ${file.name}: invalid workflow document`)
        return false
      }
      this.showTransientStatus(`Imported ${file.name}`)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'validation', 'workflow.importFailed', `failed to import workflow file: ${message}`),
      ])
      this.showTransientStatus(`Could not import ${file.name}: ${message}`)
      return false
    }
  }

  private openWorkflowFilePicker(): void {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.hidden = true
    let removed = false
    const remove = (): void => {
      if (removed) return
      removed = true
      input.remove()
      window.removeEventListener('focus', removeAfterFocus)
    }
    const removeAfterFocus = (): void => { setTimeout(remove, 0) }
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      remove()
      if (file) void this.importWorkflowFile(file)
    }, { once: true })
    input.addEventListener('cancel', remove, { once: true })
    document.body.append(input)
    window.addEventListener('focus', removeAfterFocus, { once: true })
    try {
      input.click()
    } catch (error) {
      remove()
      const message = error instanceof Error ? error.message : String(error)
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'validation', 'workflow.importFailed', `failed to open workflow file picker: ${message}`),
      ])
      this.showTransientStatus(`Could not open workflow file picker: ${message}`)
    }
  }

  private stampedDocumentOf(tab: Tab): WorkflowDocument {
    const doc = tab.store.doc
    if (tab.execution) return doc
    const reg = this.registryForTab(tab)
    if (!reg) return doc
    const stamp = stampEnvironment(doc, {
      resolve: reg.resolve,
      ...(reg.packs !== undefined ? { packs: reg.packs } : {}),
      ...(reg.server !== undefined ? { server: reg.server } : {}),
      frontendVersion: FRONTEND_VERSION,
    })
    return stamp !== undefined ? { ...doc, environment: stamp } : doc
  }

  // -- Workflow library -------------------------------------------------------

  /**
   * Live-tab id -> its backend library record (id + last known revision,
   * the optimistic-concurrency token) ON a specific backend. Set by save
   * and open-from-library; a linked tab's save PATCHES its record instead
   * of creating a new one - but only when the save targets the SAME
   * backend the link was made on (connectionId): retargeting a tab must
   * never patch record ids into a different backend's library.
   * View/session state, never serialized.
   */
  private readonly libraryLinks = new Map<string, { recordId: string; revision: number; connectionId: ConnectionId }>()

  /**
   * Per-tab digest of the last uploaded source document, validated by the
   * (revision, schemaHash) the stamp depends on - repeated queues of an
   * unchanged document reuse the digest instead of re-uploading. Keyed by
   * the Tab OBJECT, not its id: tab ids are lineages, a same-lineage
   * replacement session starts back at revision 0, and an id-keyed entry
   * could answer with the OLD session's digest for a revision-0 lookup.
   * The WeakMap also owns the async write - a digest uploaded for a tab
   * replaced mid-flight lands on the dead object and is simply collected.
   */
  private readonly sourceDocCache = new WeakMap<
    Tab,
    { revision: number; schemaHash: string; digest: string }
  >()

  /**
   * The backend library operations target: the ACTIVE tab's backend (same
   * resolution the packs collection uses), when it speaks the native
   * protocol. V1 backends have no library surface - callers render their
   * empty states.
   */
  libraryBackend(): Extract<Backend, { protocol: 'dinkster' }> | undefined {
    const tab = this.activeTab()
    const backend = tab ? this.backendForTab(tab) : this.backends.get()[0]
    return backend !== undefined && backend.protocol === 'dinkster' ? backend : undefined
  }

  /**
   * Resolve the backend that SERVED a library/template/run entry, by the
   * owner identity captured when its page was served (CollectionEntry
   * owner). STRICT: record/template/run ids are meaningless outside the
   * backend that minted them, so when the owner is gone the operation
   * fails into Problems - it never falls back to whatever backend the
   * active tab happens to target when the click lands.
   */
  private ownedLibraryBackend(owner: string): Extract<Backend, { protocol: 'dinkster' }> | undefined {
    const backend = this.backends.get().find((b) => b.id === owner)
    if (backend !== undefined && backend.protocol === 'dinkster') return backend
    this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
      diag('error', 'validation', 'library.ownerGone', 'the backend this entry came from is no longer connected'),
    ])
    return undefined
  }

  /**
   * Exact-OBJECT revalidation after awaits: the owner backend resolved at
   * operation start must still be the live entry in `backends` when a
   * response lands. Removal mid-flight retires the object but does not
   * abort its in-flight HTTP - and a remove/re-add of the same URL reuses
   * the ID on a NEW object - so an ID check alone would let a retired
   * backend's late response open tabs, install links, or set targets
   * against its replacement (or, once setTabTarget refuses the dead ID,
   * silently fall through to the default backend). Identity, not ID.
   * Reports library.ownerGone when the object was retired.
   */
  private ownerStillLive(backend: Backend): boolean {
    if (this.backends.get().includes(backend)) return true
    this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
      diag('error', 'validation', 'library.ownerGone', 'the backend this entry came from is no longer connected'),
    ])
    return false
  }

  /**
   * Save a live tab's document to its backend's library: upload the
   * freshly stamped bytes (idempotent, content-addressed), then create a
   * record - or PATCH the tab's linked record, with ONE re-read retry on a
   * revision conflict (the retry repoints only the digest, so a rename
   * made elsewhere survives). A link whose record was deleted elsewhere
   * falls back to creating a new record. Failures land in Problems.
   */
  async saveWorkflow(tabId: string): Promise<boolean> {
    const requested = this.tabs.get().find((tab) => tab.id === tabId)
    if (!requested) return false
    const unavailable = this.saveUnavailableReason(requested)
    if (unavailable !== undefined) {
      this.showTransientStatus(unavailable)
      return false
    }
    // Saves for one tab are strictly serialized: a second save issued while
    // one is in flight runs AFTER it (against the link the first save
    // refreshed), so overlapping saves can neither duplicate records nor
    // race each other's optimistic-concurrency tokens.
    const previous = this.saveChains.get(tabId) ?? Promise.resolve(true)
    const chained = previous.then(
      () => this.saveWorkflowNow(tabId),
      () => this.saveWorkflowNow(tabId),
    )
    this.saveChains.set(tabId, chained)
    try {
      return await chained
    } finally {
      if (this.saveChains.get(tabId) === chained) this.saveChains.delete(tabId)
    }
  }

  /** In-flight save per tab id; saveWorkflow() chains onto it. */
  private readonly saveChains = new Map<string, Promise<boolean>>()

  private saveUnavailableReason(tab: Tab): string | undefined {
    if (tab.execution) return 'Save is unavailable for an execution snapshot'
    const backend = this.backendForTab(tab)
    return backend.protocol === 'dinkster'
      ? undefined
      : `Save requires a Dinkster backend; ${backend.label} is ${backend.connection.status.get()} and uses the ComfyUI protocol`
  }

  private async saveWorkflowNow(tabId: string): Promise<boolean> {
    const tab = this.tabs.get().find((t) => t.id === tabId)
    if (!tab) return false
    const unavailable = this.saveUnavailableReason(tab)
    if (unavailable !== undefined) {
      this.showTransientStatus(unavailable)
      return false
    }
    const backend = this.backendForTab(tab)
    if (backend.protocol !== 'dinkster') return false // narrowed by saveUnavailableReason
    // Ownership captured at entry, BEFORE any await: the exact session
    // revision the uploaded bytes were stamped from, the backend the save
    // targets, and the library link as of submission - a link installed
    // during the upload (openFromLibrary replacing this tab id) belongs to
    // the replacement and must be neither patched nor deleted by this save.
    // Everything written back after the awaits is validated against these.
    const revision = tab.store.revision
    const payload = JSON.stringify(this.stampedDocumentOf(tab))
    const link = this.libraryLinks.get(tab.id)
    try {
      const digest = await backend.connection.uploadAsset(payload)
      let record: LibraryRecord | undefined
      // A link made on a DIFFERENT backend is not ours to patch: saving a
      // retargeted tab creates a fresh record on the new backend (the old
      // backend's record stays untouched under its own link semantics).
      if (link !== undefined && link.connectionId === backend.id) {
        const patch = { scope: LIBRARY_SCOPE, revision: link.revision, digest }
        const first = await backend.connection.patchLibraryRecord(link.recordId, patch)
        if (first.ok) {
          record = first.record
        } else {
          const fresh = await backend.connection.getLibraryRecord(link.recordId, LIBRARY_SCOPE)
          if (fresh !== undefined) {
            const retry = await backend.connection.patchLibraryRecord(link.recordId, {
              ...patch,
              revision: fresh.revision,
            })
            if (!retry.ok) throw new Error('library record changed concurrently - save again')
            record = retry.record
          }
          // fresh undefined: the record was deleted elsewhere; create anew.
        }
      }
      if (record === undefined) {
        // Drop only the link WE read: a replacement tab sharing this id may
        // have established its own link during the awaits above.
        if (link !== undefined && this.libraryLinks.get(tab.id) === link) this.libraryLinks.delete(tab.id)
        record = await backend.connection.createLibraryRecord({
          scope: LIBRARY_SCOPE,
          name: tab.title,
          digest,
          mediaType: WORKFLOW_MEDIA_TYPE,
          labels: [WORKFLOW_LABEL],
        })
      }
      this.backendsTick.update((v) => v + 1) // an open Workflows collection re-pages
      // The record was written; local bookkeeping only applies if this
      // exact Tab object is still open. A same-lineage replacement shares
      // the id but not identity - it must not inherit the link, and its
      // dirty flag is not ours to clear.
      if (!this.tabs.get().includes(tab)) return true
      this.libraryLinks.set(tab.id, { recordId: record.id, revision: record.revision, connectionId: backend.id })
      // Clean only when nothing was committed since the uploaded snapshot:
      // an edit made during the awaits keeps the tab dirty.
      const unchanged = tab.store.revision === revision
      if (unchanged) this.markTabClean(tab.id)
      const background = this.activeTab()?.id === tab.id ? '' : ` ${tab.title}`
      this.showTransientStatus(unchanged
        ? `Saved${background} to ${backend.label} library`
        : `Saved${background} snapshot to ${backend.label} library; newer changes remain unsaved`)
      return true
    } catch (e) {
      // Exact-object liveness after the awaits: a late failure from a
      // closed/replaced tab's save must not report into the same-lineage
      // replacement session (which reuses this tab id) or resurrect a
      // closed owner's entries.
      if (!this.tabs.get().includes(tab)) return false
      this.reportProblems(tab.id, [
        diag('error', 'validation', 'library.saveFailed', `failed to save workflow: ${e instanceof Error ? e.message : String(e)}`),
      ])
      this.showTransientStatus(`Save failed on ${backend.label}: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  /**
   * Open a library workflow: record -> immutable bytes by digest -> the
   * normal load pipeline. The record id is resolved ONLY against the
   * backend that served the entry (owner). The opened tab is LINKED to the
   * record, so a later save patches it. Returns false (with a Problems
   * entry for transport/parse failures) when anything is missing.
   */
  async openFromLibrary(recordId: string, owner: string): Promise<boolean> {
    const backend = this.ownedLibraryBackend(owner)
    if (!backend) return false
    try {
      const record = await backend.connection.getLibraryRecord(recordId, LIBRARY_SCOPE)
      // Liveness BEFORE payload checks: an empty answer from a retired
      // backend must still report ownerGone, not silently return.
      if (!this.ownerStillLive(backend)) return false
      if (!record) return false
      const text = await backend.connection.fetchAssetText(record.digest)
      if (!this.ownerStillLive(backend)) return false
      if (text === undefined) return false
      const diagnostics = this.openDocument(JSON.parse(text) as unknown, record.name, backend)
      if (diagnostics.length > 0) return false
      const tab = this.activeTab()
      if (tab) {
        this.libraryLinks.set(tab.id, { recordId: record.id, revision: record.revision, connectionId: backend.id })
        this.markTabClean(tab.id)
        // The tab follows its workflow home: saves patch the record it came
        // from and queues target the backend that served it.
        this.setTabTarget(tab.id, backend.id)
      }
      return true
    } catch (e) {
      // A rejection from a retired backend (removal disconnects/aborts) is
      // an ownership loss, not a transport diagnosis worth surfacing.
      if (this.ownerStillLive(backend)) {
        this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
          diag('error', 'validation', 'library.openFailed', `failed to open workflow from library: ${e instanceof Error ? e.message : String(e)}`),
        ])
      }
      return false
    }
  }

  /**
   * Open a browse-only pack template as a fresh, unlinked workflow tab.
   * The template is fetched from the backend that served its descriptor
   * (owner) - pack/template ids are that backend's namespace.
   */
  async openTemplate(packId: string, templateId: string, title: string, owner: string): Promise<boolean> {
    const backend = this.ownedLibraryBackend(owner)
    if (!backend) return false
    try {
      const document = await backend.connection.fetchTemplateBody(packId, templateId)
      // Liveness BEFORE payload checks (see openFromLibrary).
      if (!this.ownerStillLive(backend)) return false
      if (!document) return false
      if (this.openDocument(document, title, backend).length > 0) {
        // openDocument already reported the load diagnostics; append the
        // template context so the failure is attributable (the library
        // overlay stays open and shape errors alone don't say which
        // template produced them).
        this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
          diag('error', 'validation', 'template.openFailed', `template ${packId}/${templateId} is not a loadable workflow document - see the load errors above`),
        ])
        return false
      }
      const tab = this.activeTab()
      if (tab) this.setTabTarget(tab.id, backend.id)
      return true
    } catch (e) {
      if (this.ownerStillLive(backend)) {
        this.reportProblems(GLOBAL_PROBLEMS_OWNER, [diag('error', 'validation', 'template.openFailed', `failed to open template: ${e instanceof Error ? e.message : String(e)}`)])
      }
      return false
    }
  }

  /**
   * Reopen the exact producing workflow of a durable run: run record ->
   * sourceDocument digest -> immutable bytes -> the normal load pipeline
   * (drift diagnostics included, since the stamp rides inside the
   * document). An unstamped run surfaces a Problems entry instead of
   * silently doing nothing. The opened tab targets the backend the run
   * came from but is NOT library-linked - saving creates a fresh record.
   */
  async openRunWorkflow(runId: string, owner: string): Promise<boolean> {
    const backend = this.ownedLibraryBackend(owner)
    if (!backend) return false
    try {
      const run = await backend.connection.getHistoryRun(runId, LIBRARY_SCOPE)
      // Liveness BEFORE payload checks (see openFromLibrary).
      if (!this.ownerStillLive(backend)) return false
      if (!run) return false
      if (run.sourceDocument === undefined) {
        this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
          diag('warning', 'validation', 'history.unstamped', 'this run was submitted without a source document - the producing workflow was not recorded'),
        ])
        return false
      }
      const text = await backend.connection.fetchAssetText(run.sourceDocument)
      if (!this.ownerStillLive(backend)) return false
      if (text === undefined) return false
      const json = JSON.parse(text) as unknown
      const meta = (json as { meta?: { title?: unknown } }).meta
      const title = typeof meta?.title === 'string' ? meta.title : `Run ${run.jobId.slice(0, 8)}`
      const diagnostics = this.openDocument(json, title, backend)
      if (diagnostics.length > 0) return false
      const tab = this.activeTab()
      if (tab) this.setTabTarget(tab.id, backend.id)
      return true
    } catch (e) {
      if (this.ownerStillLive(backend)) {
        this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
          diag('error', 'validation', 'history.openFailed', `failed to open run workflow: ${e instanceof Error ? e.message : String(e)}`),
        ])
      }
      return false
    }
  }

  /**
   * Explicitly resubmit an interrupted run: reopen the exact producing
   * workflow (same path as openRunWorkflow, drift diagnostics included)
   * and queue the opened tab through the normal compile/submit pipeline.
   * This is a FRESH submission with a new job identity - the server never
   * resumes interrupted work, by contract (Dinkster #556). Compile problems
   * refuse the queue exactly as a manual run would; the opened tab stays
   * so the user can inspect them.
   */
  async resubmitRunWorkflow(runId: string, owner: string): Promise<boolean> {
    const opened = await this.openRunWorkflow(runId, owner)
    if (!opened) return false
    const tab = this.activeTab()
    if (!tab) return false
    await this.queue(tab)
    return true
  }

  /**
   * Delete ONE durable run record (never asset bytes or library records,
   * by contract). False on miss - already gone elsewhere is not an error.
   */
  async deleteHistoryRun(runId: string, owner: string): Promise<boolean> {
    const backend = this.ownedLibraryBackend(owner)
    if (!backend) return false
    try {
      const deleted = await backend.connection.deleteHistoryRun(runId, LIBRARY_SCOPE)
      if (deleted) {
        clearExecutionResultJobRef(backend.id, runId)
        this.backendsTick.update((v) => v + 1) // an open Runs collection re-pages
      }
      return deleted
    } catch (e) {
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'validation', 'history.deleteFailed', `failed to delete run record: ${e instanceof Error ? e.message : String(e)}`),
      ])
      return false
    }
  }

  /**
   * Clear the ENTIRE durable history scope. Destructive by design -
   * callers gate this behind an explicit confirmation affordance; asset
   * bytes and library records survive by contract.
   */
  async clearRunHistory(owner: string): Promise<number> {
    const backend = this.ownedLibraryBackend(owner)
    if (!backend) return 0
    try {
      const deleted = await backend.connection.clearHistory({ scope: LIBRARY_SCOPE })
      clearExecutionResults(backend.id)
      if (deleted > 0) this.backendsTick.update((v) => v + 1)
      return deleted
    } catch (e) {
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'validation', 'history.clearFailed', `failed to clear run history: ${e instanceof Error ? e.message : String(e)}`),
      ])
      return 0
    }
  }

  /**
   * The submit-time sourceDocument stamp for a native backend: upload the
   * stamped document (content-addressed and cached per revision+schema, so
   * an unchanged document never re-uploads) and hand back its digest.
   * ADVISORY by contract - any failure, including a server without
   * --library-root, degrades to an unstamped submission, never a blocked
   * queue.
   */
  private async sourceDocumentFor(
    tab: Tab,
    backend: Extract<Backend, { protocol: 'dinkster' }>,
  ): Promise<{ sourceDocument: string } | undefined> {
    const revision = tab.store.revision
    const schemaHash = this.registryForTab(tab)?.hash
    const cached = this.sourceDocCache.get(tab)
    if (cached && cached.revision === revision && cached.schemaHash === schemaHash) {
      return { sourceDocument: cached.digest }
    }
    try {
      const digest = await backend.connection.uploadAsset(
        JSON.stringify(this.stampedDocumentOf(tab)),
      )
      if (schemaHash !== undefined) this.sourceDocCache.set(tab, { revision, schemaHash, digest })
      return { sourceDocument: digest }
    } catch {
      return undefined // absence of a stamp is fully valid
    }
  }

  /**
   * Advisory load-time drift check: compare the document's environment
   * stamp (if any) against the tab's live registry and surface findings
   * in Problems. Never blocks anything - stamps are records, not identity.
   */
  private reportEnvironmentDrift(tab: Tab): void {
    const stamp = tab.store.doc.environment
    if (!stamp) return
    const reg = this.registryForTab(tab)
    if (!reg) return
    const drift = environmentDrift(stamp, {
      resolve: reg.resolve,
      ...(reg.packs !== undefined ? { packs: reg.packs } : {}),
    })
    this.reportProblems(tab.id, drift)
  }

  private importLegacy(json: unknown, registry = this.registry.get()): {
    readonly document?: WorkflowDocument
    readonly diagnostics: readonly Diagnostic[]
    readonly groupTranslation?: {
      readonly invocation: CommandInvocation
      readonly successDiagnostics: readonly Diagnostic[]
    }
  } {
    if (!registry) {
      return {
        diagnostics: [
          diag('error', 'import', 'import.registryMissing', 'cannot translate a legacy litegraph workflow before node schemas are loaded'),
        ],
      }
    }
    const resolve = (type: string): NodeSchema | undefined => {
      const record = registry.comfyAliases?.recordsByNodeClass.get(type)
      return record === undefined
        ? registry.resolve(type)
        : registry.comfyAliases?.sourceSchemas.get(record.source.nodeType)
    }
    const maintainedAlias = (authoredType: string): boolean =>
      registry.comfyAliases?.recordsByNodeClass.has(authoredType) === true
    const importGroups = (
      shouldCollapse: (record: ComfyGroupRecord, anchorId: number) => boolean,
    ) => importLitegraph(
      json as JsonObject,
      resolve,
      maintainedAlias,
      registry.comfyGroups,
      shouldCollapse,
    )
    const source = importGroups(() => false)
    if (source.document === undefined) return source

    const confidenceDiagnostics = (
      extraRecords: readonly ComfyGroupRecord[],
    ): readonly Diagnostic[] => {
      const importedRecords = new Map<string, ComfyAliasRecord | ComfyGroupRecord>(
        extraRecords.map((record) => [record.id, record]),
      )
      for (const graph of Object.values(source.document!.graphs)) {
        for (const node of Object.values(graph.nodes)) {
          const record = registry.comfyAliases?.recordsBySourceType.get(node.type)
          if (record !== undefined) importedRecords.set(record.id, record)
        }
      }
      const diagnostics: Diagnostic[] = []
      for (const mappingKind of ['op', 'family'] as const) {
        const records = [...importedRecords.values()].filter((record) => record.mappingKind === mappingKind)
        if (records.length === 0) continue
        const confidence = ['exact', 'parametric', 'equivalent', 'grouped']
          .map((tier) => `${tier}=${records.filter((record) => record.confidence.tier === tier).length}`)
          .join(', ')
        const familyAvailability = mappingKind === 'family'
          ? records.map((record) => {
              const provider = record.family?.provider
              const sourceName = 'nodeClass' in record.source
                ? record.source.nodeClass
                : record.source.name
              return provider === undefined
                ? `${sourceName}:unknown`
                : `${sourceName}:${registry.packs?.has(provider) === true ? 'available' : 'unavailable'}`
            })
          : []
        const availabilityCounts = ['available', 'unavailable', 'unknown']
          .map((status) => `${status}=${familyAvailability.filter((entry) => entry.endsWith(`:${status}`)).length}`)
          .join(', ')
        diagnostics.push(diag(
          'info',
          'import',
          `import.comfyAlias.confidence.${mappingKind}`,
          `ComfyUI ${mappingKind}-level mappings: total=${records.length}; confidence ${confidence}${familyAvailability.length > 0 ? `; family providers ${availabilityCounts}; ${familyAvailability.join(', ')}` : ''}`,
        ))
      }
      return diagnostics
    }

    const catalog = registry.comfyGroups
    if (catalog === undefined || catalog.records.length === 0) {
      return { ...source, diagnostics: [...source.diagnostics, ...confidenceDiagnostics([])] }
    }
    const tentative = importGroups(() => true)
    if (tentative.document === undefined) {
      return {
        ...source,
        diagnostics: [
          ...source.diagnostics,
          ...confidenceDiagnostics([]),
          diag(
            'warning',
            'import',
            'import.comfyGroup.review',
            'Matched ComfyUI node groups were left unchanged because their native translation could not be prepared',
          ),
        ],
      }
    }
    const replacementRegistry = this.replacementRegistryFor(registry)
    const resolveReplacement: ReplacementSchemaResolver = (type, role) =>
      this.replacementSchemaOf(registry, type, role)
    const tentativeItems = scanReplacements(
      tentative.document,
      replacementRegistry,
      resolveReplacement,
    ).filter((item) => catalog.recordsByGroupType.has(item.sourceType))
    const review = this.reviewReplacements.get()
    const selectedIds = new Set(
      tentativeItems.filter((item) => item.safe && !review).map((item) => item.nodeId),
    )
    const reviewDiagnostics = tentativeItems
      .filter((item) => !selectedIds.has(item.nodeId))
      .map((item) => diag(
        'warning',
        'import',
        'import.comfyGroup.review',
        review
          ? `ComfyUI node group '${item.sourceType}' was left unchanged for replacement review`
          : `ComfyUI node group '${item.sourceType}' was left unchanged because native replacement was not lossless: ${item.diagnostics.map((entry) => entry.message).join('; ')}`,
      ))
    if (selectedIds.size === 0) {
      return {
        ...source,
        diagnostics: [...source.diagnostics, ...reviewDiagnostics, ...confidenceDiagnostics([])],
      }
    }

    const collapsed = selectedIds.size === tentativeItems.length
      ? tentative
      : importGroups((_record, anchorId) => selectedIds.has(`n${anchorId}`))
    if (collapsed.document === undefined) {
      return {
        ...source,
        diagnostics: [...source.diagnostics, ...reviewDiagnostics, ...confidenceDiagnostics([])],
      }
    }
    const finalItems = scanReplacements(
      collapsed.document,
      replacementRegistry,
      resolveReplacement,
    ).filter((item) => selectedIds.has(item.nodeId) && catalog.recordsByGroupType.has(item.sourceType))
    if (finalItems.length !== selectedIds.size || finalItems.some((item) => !item.safe)) {
      return {
        ...source,
        diagnostics: [
          ...source.diagnostics,
          ...reviewDiagnostics,
          ...confidenceDiagnostics([]),
          diag(
            'warning',
            'import',
            'import.comfyGroup.review',
            'Matched ComfyUI node groups were left unchanged because their atomic native replacement did not reproduce',
          ),
        ],
      }
    }
    const plans = finalItems.flatMap((item) => item.hops.map((hop) => hop.plan))
    const invocation = comfyGroupReplacementInvocation(source.document, collapsed.document, plans)
    if (invocation === undefined) {
      return {
        ...source,
        diagnostics: [...source.diagnostics, ...reviewDiagnostics, ...confidenceDiagnostics([])],
      }
    }
    const appliedRecords = finalItems.flatMap((item) => {
      const record = catalog.recordsByGroupType.get(item.sourceType)
      return record === undefined ? [] : [record]
    })
    return {
      ...source,
      diagnostics: [...source.diagnostics, ...reviewDiagnostics, ...confidenceDiagnostics([])],
      groupTranslation: {
        invocation,
        successDiagnostics: [
          ...collapsed.diagnostics,
          ...reviewDiagnostics,
          ...confidenceDiagnostics(appliedRecords),
        ],
      },
    }
  }

  /**
   * Register frontend-provided node schemas (extensions and frontend-only
   * node types). They layer OVER the backend registry: same resolve path,
   * no special-casing anywhere downstream.
   */
  registerSchemas(schemas: readonly NodeSchema[]): void {
    for (const s of schemas) this.extraSchemas.set(s.type, s)
    // Extras layer over EVERY backend's registry: frontend-only node types
    // exist regardless of which server a tab targets.
    for (const backend of this.backends.get()) {
      const reg = backend.registry.get()
      if (reg) {
        backend.registry.set(this.layerExtraSchemas(reg))
        backend.invalidateRemoteChoices()
      }
    }
  }

  private readonly extraSchemas = new Map<string, NodeSchema>()

  private layerExtraSchemas(reg: SchemaRegistry): SchemaRegistry {
    if (this.extraSchemas.size === 0) return reg
    const extras = new Map(this.extraSchemas)
    return {
      ...reg,
      schemas: new Map([...reg.schemas, ...extras]),
      resolve: (type) => extras.get(type) ?? reg.resolve(type),
    }
  }

  private async refreshPackLocaleOverlay(
    backend: Backend & { readonly protocol: 'dinkster' },
    base: SchemaRegistry | undefined = backend.connection.currentRegistry,
  ): Promise<void> {
    const current = (): boolean =>
      !this.disposed &&
      this.backends.get().includes(backend) &&
      backend.connection.currentRegistry === base
    if (base === undefined || base.server?.schemaWire !== 44 || base.packs === undefined) return
    const locale = activeLocale.get().tag
    const catalogsByPack = new Map<string, readonly PackLocaleCatalog[]>()
    await Promise.all([...base.packs].map(async ([packId, pack]) => {
      if (pack.locales === undefined) return
      const catalogs: PackLocaleCatalog[] = []
      for (const key of preferredPackLocaleKeys(locale, Object.keys(pack.locales))) {
        const digest = pack.locales[key]
        if (digest === undefined) continue
        try {
          const payload = await backend.connection.fetchPackLocaleCatalog(packId, digest)
          if (payload !== undefined) catalogs.push(decodePackLocaleCatalog(payload))
        } catch {
          // One unavailable or malformed immutable catalog falls through to
          // the next advertised locale without making the schema unusable.
        }
      }
      if (catalogs.length > 0) catalogsByPack.set(packId, catalogs)
    }))
    if (!current() || activeLocale.get().tag !== locale) return
    backend.registry.set(this.layerExtraSchemas(overlayPackLocales(base, catalogsByPack)))
    backend.invalidateRemoteChoices()
  }

  async start(): Promise<void> {
    await Promise.all(this.backends.get().map((b) => this.startBackend(b)))
    // After the backends: rejoin probes talk to the same servers, and a
    // rejoined session's commands resolve against the loaded registries.
    await this.rejoinCollabSessions()
  }

  /** Connect a backend and load its schema registry; failures land in Problems. */
  private async startBackend(backend: Backend): Promise<void> {
    backend.connection.connect()
    if (backend.protocol === 'dinkster') this.superviseBackend(backend)
    await this.loadBackendSchemas(backend)
    const registry = backend.registry.get()
    if (backend.protocol === 'dinkster' && registry !== undefined) {
      await this.restoreExecutionResults(backend, registry)
    }
  }

  private executionResultIdentity(
    backend: Backend,
    registry: SchemaRegistry | undefined = backend.registry.get(),
  ): ExecutionResultBackendIdentity | undefined {
    if (backend.protocol !== 'dinkster' || registry?.server === undefined) return undefined
    return {
      connection: backend.id,
      baseUrl: backend.baseUrl,
      clientId: `${this.backendClientId}:${backend.id}`,
      serverVersion: registry.server.version,
      schemaWire: registry.server.schemaWire,
    }
  }

  private async validatedExecutionResult(
    backend: Backend & { readonly protocol: 'dinkster' },
    registry: SchemaRegistry,
    result: PersistedExecutionResult,
  ): Promise<Parameters<ExecutionStore['restoreCompleted']>[0] | null | undefined> {
    if (result.ref.connection !== backend.id || result.proof.connection !== backend.id ||
      result.proof.schemaHash !== registry.hash) return undefined
    const history = await backend.connection.getHistoryRun(result.jobRef, LIBRARY_SCOPE)
    if (history === undefined || history.state !== 'completed' ||
      (history.jobRef ?? history.runId) !== result.jobRef ||
      history.clientId !== result.backend.clientId || history.jobId !== result.ref.prompt ||
      history.sourceDocument !== result.sourceDocument ||
      history.principalId !== result.submittedBy?.principalId ||
      history.principalKind !== result.submittedBy?.kind) return undefined
    const job = await backend.connection.fetchJob(result.ref.prompt)
    if (job === undefined || job.state !== 'completed' ||
      job.jobRef !== result.jobRef || job.sourceDocument !== result.sourceDocument ||
      job.submittedBy?.principalId !== result.submittedBy?.principalId ||
      job.submittedBy?.kind !== result.submittedBy?.kind) return undefined
    const source = await backend.connection.fetchAssetText(result.sourceDocument)
    if (source === undefined) return undefined
    let loaded
    try {
      loaded = loadDocument(JSON.parse(source) as unknown)
    } catch {
      return undefined
    }
    if (loaded.document === undefined) return undefined
    const choices = new Map((result.proof.choices ?? []).map((choice) => [
      JSON.stringify([choice.graph, choice.selector]),
      choice.candidate,
    ]))
    const compiled = compile({
      document: loaded.document,
      revision: result.proof.revision,
      resolve: registry.resolve,
      scope: result.proof.scope,
      connection: backend.id,
      schemaHash: registry.hash,
      candidateOverride: ({ graph, selector, candidates }) => {
        const choice = choices.get(JSON.stringify([graph, selector]))
        return choice !== undefined && candidates.includes(choice) ? choice : undefined
      },
      pickCandidate: () => 0,
      ...(registry.graphFeatures === undefined ? {} : { graphFeatures: registry.graphFeatures }),
    })
    if (!compiled.ok || canonicalJson(persistedCompileProof(compiled.artifact)) !== canonicalJson(result.proof)) {
      return undefined
    }

    const queries = new Map<string, Set<string>>()
    const addQueries = (byNode: Readonly<Record<string, Readonly<Record<string, unknown>>>>): void => {
      for (const [nodeId, outputs] of Object.entries(byNode)) {
        let ids = queries.get(nodeId)
        if (!ids) queries.set(nodeId, (ids = new Set()))
        for (const outputId of Object.keys(outputs)) ids.add(outputId)
      }
    }
    addQueries(result.outputs)
    addQueries(Object.fromEntries(Object.entries(result.nodes).map(([nodeId, progress]) => [
      nodeId,
      progress.outputs ?? {},
    ])))
    if (workspaceRecord(job.outputs)) addQueries(job.outputs as Readonly<Record<string, Readonly<Record<string, unknown>>>>)
    if ([...queries.values()].reduce((total, ids) => total + ids.size, 0) > 512) return undefined

    const jobNodes = nodeStatesFromDinksterJob(job)
    const nodes: Record<string, NodeProgress> = {}
    const outputs: Record<string, Record<string, unknown>> = {}
    for (const [nodeId, outputIds] of queries) {
      const progress = jobNodes[nodeId]
      if (progress?.state !== 'done' && progress?.state !== 'cached') continue
      for (const outputId of outputIds) {
        const peek = await backend.connection.values().peek({
          jobId: result.ref.prompt,
          nodeId,
          outputId,
        })
        if (!peek.available) {
          if (peek.status === 0 || peek.status === 408 || peek.status === 429 ||
            peek.status >= 500 || peek.reason === 'malformed-response') return null
          continue
        }
        const descriptor = peek.descriptor
        const summary: NodeOutputSummary = {
          typeId: descriptor.typeId,
          ...(descriptor.length === undefined ? {} : { length: descriptor.length }),
          ...(descriptor.value === undefined ? {} : { value: descriptor.value }),
        }
        nodes[nodeId] = {
          ...progress,
          outputs: { ...nodes[nodeId]?.outputs, [outputId]: summary },
        }
        outputs[nodeId] = { ...outputs[nodeId], [outputId]: descriptor }
      }
    }
    for (const artifact of job.artifacts ?? []) {
      const progress = jobNodes[artifact.nodeId]
      if ((progress?.state === 'done' || progress?.state === 'cached') && nodes[artifact.nodeId] === undefined) {
        nodes[artifact.nodeId] = progress
      }
    }
    if (Object.keys(nodes).length === 0) return undefined
    return {
      ref: result.ref,
      artifact: compiled.artifact,
      nodes,
      outputs,
      artifacts: job.artifacts ?? [],
      ...(result.submittedBy === undefined ? {} : { submittedBy: result.submittedBy }),
      jobRef: result.jobRef,
      sourceDocument: result.sourceDocument,
      queuedAt: result.queuedAt,
      endedAt: result.endedAt,
    }
  }

  private async restoreExecutionResults(
    backend: Backend & { readonly protocol: 'dinkster' },
    registry: SchemaRegistry,
  ): Promise<void> {
    const identity = this.executionResultIdentity(backend, registry)
    if (identity === undefined) return
    for (const result of loadExecutionResults(identity)) {
      try {
        const restored = await this.validatedExecutionResult(backend, registry, result)
        if (restored === undefined) removeExecutionResult(result)
        else if (restored !== null) {
          this.retainedRegistries.set(restored.artifact, registry)
          this.store.restoreCompleted(restored)
        }
      } catch {
        // A transport failure proves nothing; retry the retained record on a later reload.
      }
    }
  }

  /** Retry one live backend's schema request without changing its connection. */
  async refreshBackendSchemas(backend: Backend): Promise<void> {
    if (!this.backends.get().includes(backend)) return
    await this.loadBackendSchemas(backend)
  }

  /** Latest schema request per backend; older completions cannot replace it. */
  private readonly schemaRequests = new WeakMap<Backend, object>()

  /** Latest worker request per backend; reconnects and schema refreshes retire older catalogs. */
  private readonly workerRequests = new WeakMap<Backend, object>()

  private invalidateWorkerCatalog(backend: Backend): void {
    this.workerRequests.set(backend, {})
    backend.workerCatalog.set({ status: 'unsupported' })
  }

  private refreshWorkerCatalog(backend: Backend, registry: SchemaRegistry): void {
    const request = {}
    this.workerRequests.set(backend, request)
    if (
      backend.protocol !== 'dinkster' ||
      !registry.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_PLACEMENT)
    ) {
      backend.workerCatalog.set({ status: 'unsupported' })
      return
    }
    backend.workerCatalog.set({ status: 'loading' })
    const current = (): boolean =>
      this.backends.get().includes(backend) && this.workerRequests.get(backend) === request
    void backend.connection.fetchWorkers().then(
      (workers) => {
        if (current()) backend.workerCatalog.set({ status: 'ready', workers })
      },
      (error: unknown) => {
        if (!current()) return
        backend.workerCatalog.set({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      },
    )
  }

  private documentNeedsWire43(document: WorkflowDocument): boolean {
    return Object.values(document.graphs).some((graph) =>
      Object.values(graph.nodes).some((node) => node.type === BUILTIN_EDITOR_NODE_IDS.routeSwitchByName),
    )
  }

  private schemaWireVersionsFor(backend: Backend): readonly number[] | undefined {
    if (backend.protocol !== 'dinkster') return undefined
    return this.tabs.get().some((tab) =>
      tab.execution === undefined &&
      this.backendForTab(tab) === backend &&
      this.documentNeedsWire43(tab.store.doc),
    ) ? [43, 44] : undefined
  }

  /** Fetch schemas (+ native diagnostics); failures land in Problems - except
   * the supervisor's engine-not-ready gate, which the supervisor poll narrates
   * (and retries on ready) instead of a scary fetch-failed problem. */
  private async loadBackendSchemas(backend: Backend): Promise<void> {
    const request = {}
    this.schemaRequests.set(backend, request)
    this.invalidateWorkerCatalog(backend)
    backend.schemaState.set({ status: 'loading' })
    const current = (): boolean =>
      this.backends.get().includes(backend) && this.schemaRequests.get(backend) === request
    try {
      const registry = backend.protocol === 'dinkster'
        ? await backend.connection.fetchSchemas(this.schemaWireVersionsFor(backend))
        : await backend.connection.fetchSchemas()
      if (!current()) return
      await this.prepareExtensionWorld(backend, registry)
      if (!current()) return
      const layered = this.layerExtraSchemas(registry)
      backend.registry.set(layered)
      backend.schemaState.set({ status: 'ready' })
      backend.invalidateRemoteChoices()
      this.refreshWorkerCatalog(backend, layered)
      // Advisory and non-blocking: older native backends without the endpoint
      // simply report no problems, while v1's implementation is a no-op.
      backend.refreshDiagnostics()
      if (backend.protocol === 'dinkster') void this.refreshPackLocaleOverlay(backend, registry)
    } catch (e) {
      if (!current()) return
      if (e instanceof EngineNotReadyError && backend.protocol === 'dinkster') {
        backend.schemaState.set({ status: 'waiting' })
        this.log('info', backend.label, `engine not ready (${e.state}); waiting for the supervisor`)
        return
      }
      const message = e instanceof Error ? e.message : String(e)
      backend.schemaState.set({ status: 'error', message })
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        {
          severity: 'error',
          origin: 'schema',
          code: 'schema.fetchFailed',
          message: `[${backend.label}] failed to fetch ${backend.protocol === 'dinkster' ? '/api/nodes' : '/object_info'}: ${message}`,
        },
      ])
    } finally {
      this.pruneExtensionWorlds()
    }
  }

  /** Active supervisor poll cancelers, keyed by backend. */
  private readonly supervisorPolls = new Map<ConnectionId, () => void>()

  /**
   * (Re)start the supervisor poll for a native backend. Stops itself when
   * there is no supervisor (standalone dinkster-serve) or nothing left to
   * narrate; see supervisor-poll.ts for the full lifecycle.
   */
  private superviseBackend(backend: Backend & { protocol: 'dinkster' }): void {
    this.supervisorPolls.get(backend.id)?.()
    const cancel = pollSupervisor({
      probe: () => probeSupervisorStatus(backend.baseUrl),
      connected: () => backend.connection.status.get() === 'connected',
      get: () => backend.supervisor.get(),
      set: (status) => backend.supervisor.set(status),
      onReady: () => {
        // The 503 gate may have rejected the startup schema fetch; the
        // engine answering healthy is the moment to try again.
        if (backend.registry.get() === undefined) void this.loadBackendSchemas(backend)
      },
    })
    this.supervisorPolls.set(backend.id, () => {
      cancel()
      this.supervisorPolls.delete(backend.id)
    })
  }

  /**
   * POST /supervisor/engine/restart for a failed/stopped engine, then
   * resume polling so the starting -> ready transition is narrated.
   */
  async restartEngine(backend: Backend): Promise<void> {
    if (backend.protocol !== 'dinkster') return
    this.log('info', backend.label, 'requesting engine restart')
    const result = await restartSupervisorEngine(backend.baseUrl)
    // Removal and re-addition can reuse a ConnectionId. Exact object liveness
    // prevents the retired request from cancelling or polling the new backend.
    if (!this.backends.get().includes(backend)) return
    if (!result.ok) {
      this.log('error', backend.label, `engine restart failed: ${result.error}`)
      this.reportProblems(GLOBAL_PROBLEMS_OWNER, [
        diag('error', 'runtime', 'supervisor.restartFailed', `[${backend.label}] engine restart failed: ${result.error}`),
      ])
      return
    }
    this.superviseBackend(backend)
  }

  /**
   * The shared CompileInput for a tab's TARGET backend: its registry
   * resolve, identity, schema hash, and capability-negotiated graph wire
   * features (e.g. $typed). Queue compiles (compileTab) and would-run scope
   * previews (CanvasHost's selection highlight) both build from HERE so
   * they can never disagree on capabilities - a $typed-lowered workflow
   * must not preview as an error closure while the actual queue succeeds.
   */
  compileInputForTab(tab: Tab, scope: ExecutionScope): CompileInput | undefined {
    const backend = this.backendForTab(tab)
    const registry = backend.registry.get()
    if (!registry) return undefined
    return {
      document: tab.store.doc,
      revision: tab.store.revision,
      resolve: registry.resolve,
      scope,
      connection: backend.id,
      schemaHash: registry.hash,
      // Capability-negotiated graph wire forms (e.g. $typed) are gated on
      // the TARGET backend's advertised features, exactly like the registry.
      ...(registry.graphFeatures ? { graphFeatures: registry.graphFeatures } : {}),
    }
  }

  /** Compile against the tab's TARGET backend: its registry, its identity. */
  compileTab(tab: Tab, scope: ExecutionScope = { kind: 'full' }): CompileResult | undefined {
    // Same registry read compileInputForTab makes (signals are synchronous):
    // captured here so the retained-registry association below is exact.
    const registry = this.backendForTab(tab).registry.get()
    const input = this.compileInputForTab(tab, scope)
    if (!registry || !input) return undefined
    const result = compile({
      ...input,
      // Random selector policies roll HERE, at the app boundary - compile is
      // pure and records the exact outcome in the artifact's `choices`, so a
      // frozen view always shows the branch THIS execution took. A fresh
      // queue is a fresh compile and rolls again (that is what 'random'
      // means); only the recorded artifact is stable.
      pickCandidate: ({ count }) => Math.floor(Math.random() * count),
    })
    // Retain the exact compile-time registry against the artifact OBJECT so
    // a frozen view of the run this compile may become resolves with it even
    // after the backend's schemas move (or a same-hash layered replacement
    // lands). Compile-time association is authoritative; installRun only
    // fills in for artifacts registered around this path.
    if (result.ok) this.retainedRegistries.set(result.artifact, registry)
    return result
  }

  /**
   * Comparison compiles (exact live companion values): one full-scope
   * compile per (tab, revision, registry) reused across overlay refreshes.
   * NOT the queue path - queue() must always compile fresh (random policies
   * re-roll per queue); this cache only feeds recipe COMPARISON, where
   * liveExactnessFor rejects any random roll outright, so a cached roll can
   * never leak into an exactness verdict. Keyed by the Tab OBJECT (WeakMap):
   * a same-lineage replacement session restarts at revision 0, so an
   * id-keyed entry could answer a fresh session with the OLD session's
   * compile; closed tabs collect without bookkeeping.
   */
  private comparisonCompiles = new WeakMap<
    Tab,
    { revision: number; schemaHash: string; result: CompileResult }
  >()

  compileTabCached(tab: Tab): CompileResult | undefined {
    const registry = this.registryForTab(tab)
    if (!registry) return undefined
    const cached = this.comparisonCompiles.get(tab)
    if (cached && cached.revision === tab.store.revision && cached.schemaHash === registry.hash) {
      return cached.result
    }
    const result = this.compileTab(tab)
    if (result) {
      this.comparisonCompiles.set(tab, {
        revision: tab.store.revision,
        schemaHash: registry.hash,
        result,
      })
    }
    return result
  }

  /** One full would-run projection per live tab revision and compile target. */
  private scopeClosures = new WeakMap<
    Tab,
    {
      revision: number
      schemaHash: string
      connection: ConnectionId
      graphFeatures: string
      resolve: CompileInput['resolve']
      closure?: ScopeClosure
    }
  >()

  scopeClosureCached(tab: Tab): ScopeClosure | undefined {
    const input = this.compileInputForTab(tab, { kind: 'full' })
    if (!input) return undefined
    const graphFeatures = JSON.stringify(input.graphFeatures ?? [])
    const cached = this.scopeClosures.get(tab)
    if (cached &&
      cached.revision === tab.store.revision &&
      cached.schemaHash === input.schemaHash &&
      cached.connection === input.connection &&
      cached.graphFeatures === graphFeatures &&
      cached.resolve === input.resolve) {
      return cached.closure
    }
    // A full would-run compile per revision is only worth paying when the
    // document can actually produce lazy-selector cones. Selector-less
    // documents (the common case, incl. large graphs) provably yield an
    // empty inactiveExclusive map, so skip the compile entirely.
    const closure = documentHasLazySelector(input.document, input.resolve)
      ? scopeClosure(input)
      : undefined
    this.scopeClosures.set(tab, {
      revision: tab.store.revision,
      schemaHash: input.schemaHash,
      connection: input.connection,
      graphFeatures,
      resolve: input.resolve,
      ...(closure ? { closure } : {}),
    })
    return closure
  }

  /**
   * Derive the executable scopes for the current root-graph selection. A
   * subgraph instance expands to its descendant output occurrences because
   * instances themselves do not survive prompt flattening.
   */
  selectionExecutionScopes(tab: Tab, nodeIds: readonly string[]): SelectionExecutionScopes | undefined {
    const def = tab.store.doc.graphs[tab.store.doc.root]
    const registry = this.registryForTab(tab)
    if (!def || !registry) return undefined
    const analysis = analyzeSelectionExecution(def, nodeIds)
    if (analysis.selected.size === 0) return { analysis }
    const resolve = documentResolver(tab.store.doc, registry.resolve)
    const expand = (nodeId: string, outputsOnly: boolean): Occurrence[] => {
      const targets: Occurrence[] = []
      const visit = (graphId: string, path: NodeId[], id: string): void => {
        const node = tab.store.doc.graphs[graphId]?.nodes[id]
        if (!node) return
        const childId = subgraphDefIdOf(node.type)
        if (!childId) {
          targets.push({ instancePath: path, node: asNodeId(id) })
          return
        }
        const child = tab.store.doc.graphs[childId]
        if (!child) return
        const childPath = [...path, asNodeId(id)]
        const childTargets = new Set(outputsOnly ? [] : child.boundary?.outputs.map((item) => item.binds.node) ?? [])
        for (const inner of Object.values(child.nodes)) if (resolve(inner.type)?.isOutputNode) childTargets.add(inner.id)
        for (const childTarget of [...childTargets].sort()) visit(childId, childPath, childTarget)
      }
      visit(tab.store.doc.root, [], nodeId)
      return targets
    }
    const scope = (ids: Iterable<string>, outputsOnly = false): ExecutionScope | undefined => {
      const targets = [...ids].flatMap((id) => expand(id, outputsOnly)).filter((target, index, all) =>
        all.findIndex((candidate) =>
          candidate.node === target.node &&
          candidate.instancePath.length === target.instancePath.length &&
          candidate.instancePath.every((id, i) => id === target.instancePath[i]),
        ) === index,
      )
      return targets.length > 0 ? { kind: 'partial', targets } : undefined
    }
    const outputIds = [...analysis.downstream]
      .filter((id) => resolve(def.nodes[id]!.type)?.isOutputNode === true)
      .sort()
    const selectedCycle = [...analysis.selected].some((id) => analysis.cyclicNodes.has(id))
    const upToRootCycle = [...analysis.upstream].some((id) => analysis.cyclicNodes.has(id))
    const outputRootCycle = [...analysis.upstreamOf(outputIds)].some((id) => analysis.cyclicNodes.has(id))
    const cycleNodesByGraph = new Map<string, ReadonlySet<string>>()
    const cycleNodesFor = (graphId: string): ReadonlySet<string> => {
      let cycleNodes = cycleNodesByGraph.get(graphId)
      if (!cycleNodes) {
        const graph = tab.store.doc.graphs[graphId]
        cycleNodes = graph ? analyzeSelectionExecution(graph, []).cyclicNodes : new Set()
        cycleNodesByGraph.set(graphId, cycleNodes)
      }
      return cycleNodes
    }
    const closureContainsCycle = (included: ReadonlySet<string>): boolean => {
      for (const key of included) {
        const occurrence = parseOccurrenceKey(key)
        let graphId: string = tab.store.doc.root
        for (const instanceId of occurrence.instancePath) {
          if (cycleNodesFor(graphId).has(instanceId)) return true
          const childId = subgraphDefIdOf(tab.store.doc.graphs[graphId]?.nodes[instanceId]?.type ?? '')
          if (!childId) break
          graphId = childId
        }
        if (cycleNodesFor(graphId).has(occurrence.node)) return true
      }
      return false
    }
    const inspect = (candidate: ExecutionScope | undefined) => {
      if (!candidate) return undefined
      const input = this.compileInputForTab(tab, candidate)
      if (!input) return undefined
      const closure = scopeClosure(input)
      return closure ? { scope: candidate, cyclic: closureContainsCycle(closure.included) } : undefined
    }
    const upToCandidate = scope(analysis.first)
    const betweenCandidate = analysis.contiguous ? scope(analysis.sinks) : undefined
    const fromOnwardsCandidate = scope(outputIds, true)
    const inspectedUpTo = inspect(upToCandidate)
    const inspectedBetween = inspect(betweenCandidate)
    const inspectedFromOnwards = inspect(fromOnwardsCandidate)
    const upToReason = analysis.first.length === 0 || selectedCycle
      ? 'selection is inside a cycle'
      : upToRootCycle || inspectedUpTo?.cyclic
        ? 'upstream of the selection contains a cycle'
        : !inspectedUpTo
          ? 'selection has no executable targets'
        : undefined
    const fromOnwardsReason = outputIds.length === 0
      ? 'no output node is downstream of the selection'
      : outputRootCycle || inspectedFromOnwards?.cyclic
        ? 'the downstream output execution closure contains a cycle'
        : !inspectedFromOnwards
          ? 'selection has no executable targets'
        : undefined
    const betweenReason = selectedCycle
      ? 'the selected range execution closure contains a cycle'
      : !analysis.contiguous
        ? 'requires a contiguous multi-node selection'
        : !inspectedBetween
          ? 'selection has no executable targets'
          : inspectedBetween.cyclic
            ? 'the selected range execution closure contains a cycle'
            : undefined
    const upTo = upToReason === undefined ? inspectedUpTo?.scope : undefined
    const between = betweenReason === undefined ? inspectedBetween?.scope : undefined
    const fromOnwards = fromOnwardsReason === undefined ? inspectedFromOnwards?.scope : undefined
    return {
      analysis,
      ...(upTo ? { upTo } : {}),
      ...(between ? { between } : {}),
      ...(fromOnwards ? { fromOnwards } : {}),
      ...(upToReason ? { upToReason } : {}),
      ...(betweenReason ? { betweenReason } : {}),
      ...(fromOnwardsReason ? { fromOnwardsReason } : {}),
    }
  }

  /** Queue the union of upstream closures of the selection minima. */
  async queueSelection(tab: Tab, nodeIds: readonly string[]): Promise<void> {
    const scope = this.selectionExecutionScopes(tab, nodeIds)?.upTo
    if (scope) await this.queue(tab, scope)
  }

  /** Queue the direct in-selection sinks of a contiguous selected range. */
  async queueSelectionBetween(tab: Tab, nodeIds: readonly string[]): Promise<void> {
    const scope = this.selectionExecutionScopes(tab, nodeIds)?.between
    if (scope) await this.queue(tab, scope)
  }

  /** Queue outputs downstream of the selection maxima. */
  async queueSelectionOnwards(tab: Tab, nodeIds: readonly string[]): Promise<void> {
    const scopes = this.selectionExecutionScopes(tab, nodeIds)
    if (scopes?.fromOnwards) await this.queue(tab, scopes.fromOnwards, scopes.analysis.last)
  }

  /**
   * Controller advancement plans captured at queue time, keyed by
   * executionKey. Each plan owns the exact DocumentSession it was
   * planned against - completion applies to that session only if a live tab
   * still holds it (a replacement session sharing the lineage never
   * qualifies), and each step is compare-and-set on the raw stored value so
   * inputs the user edited after queueing are preserved.
   */
  private readonly advancementPlans = new Map<string, AdvancementPlan>()

  /**
   * Latest mutation generation by document path. Value equality alone has
   * an ABA hole (manual + then - returns to the queued value), so an
   * after-generate plan also snapshots the generation of its exact value.
   * Controller intent remains compared by EFFECTIVE mode: explicitly
   * storing the same default mode is deliberately not an intent change.
   */
  private readonly controllerMutations = new WeakMap<DocumentSession, ControllerMutationState>()

  private trackControllerMutations(session: DocumentSession, state: ControllerMutationState): void {
    session.document.subscribe((document) => {
      for (const input of state.inputs.values()) {
        const value = document.graphs[input.graphId]?.nodes[input.nodeId]?.values[input.inputId]
        if (!Object.is(value, input.value)) {
          input.value = value
          input.generation = ++state.next
        }
      }
    })
  }

  /**
   * Continue mutation tracking across a store swap: plans hold generation
   * snapshots taken against the old session, whose publications stop at
   * promotion. The SAME tracker state (inputs and counter) must observe the
   * promoted session's edits, or an ABA edit made after promotion (change,
   * then restore the queue-time value) becomes invisible to the guard.
   */
  private adoptControllerMutations(previous: DocumentSession, session: DocumentSession): void {
    const state = this.controllerMutations.get(previous)
    if (!state || this.controllerMutations.has(session)) return
    this.controllerMutations.set(session, state)
    this.trackControllerMutations(session, state)
  }

  private controllerMutationGeneration(session: DocumentSession, step: AdvancementInputLocation): number {
    let state = this.controllerMutations.get(session)
    if (!state) {
      state = { next: 0, inputs: new Map() }
      this.controllerMutations.set(session, state)
      this.trackControllerMutations(session, state)
    }
    const key = advancementInputKey(step)
    let input = state.inputs.get(key)
    if (!input) {
      input = {
        graphId: step.graphId,
        nodeId: step.nodeId,
        inputId: step.inputId,
        value: session.doc.graphs[step.graphId]?.nodes[step.nodeId]?.values[step.inputId],
        generation: state.next,
      }
      state.inputs.set(key, input)
    }
    return input.generation
  }

  /** Mutation token for async widget compare-and-set plans (closes ABA edits). */
  widgetValueMutationGeneration(tab: Tab, graphId: string, nodeId: string, inputId: string): number {
    return this.controllerMutationGeneration(tab.store, { graphId, nodeId, inputId })
  }

  private readonly completedComboRefreshPlans = new WeakSet<ComboRefreshPlan>()

  prepareComboRefresh(tab: Tab, route: string): ComboRefreshPlan | undefined {
    if (tab.execution || !this.tabs.get().includes(tab)) return undefined
    if (!this.settings.get<boolean>('features.seedController.enabled')) return undefined
    const backend = this.backendForTab(tab)
    const registry = this.registryForTab(tab)
    return registry ? comboRefreshAdvancementPlan(tab.store, route, backend, registry) : undefined
  }

  completeComboRefresh(plan: ComboRefreshPlan | undefined, options: readonly string[], random: () => number = Math.random): void {
    if (!plan || this.completedComboRefreshPlans.has(plan)) return
    this.completedComboRefreshPlans.add(plan)
    if (!this.settings.get<boolean>('features.seedController.enabled')) return
    const tab = this.liveTabContinuing(plan.session)
    if (!tab) return
    if (this.backendForTab(tab) !== plan.backend || this.registryForTab(tab) !== plan.registry) return
    const invocation = comboRefreshAdvancement(tab.store.doc, plan, options, plan.registry.resolve, random)
    if (invocation) this.dispatchTo(tab, invocation)
  }

  /**
   * Register a submitted run and its queue-time advancement plan in one
   * step - the single door through which app-submitted runs enter the
   * execution store, so registration and plan capture cannot disagree.
   * Convenience over prepare+install for callers (and tests) that hold the
   * tab at registration time; queue() prepares its plan at COMPILE time
   * instead, before any await, from the artifact's occurrence provenance.
   */
  registerRun(tab: Tab, ref: ExecutionRef, artifact: CompileArtifact, timestamp?: number): void {
    const plan = tab.execution ? undefined : this.preparedAdvancement(tab.store, artifact)
    this.installRun(ref, artifact, plan, timestamp)
  }

  /**
   * The queue-time advancement plan for a compiled run, derived from the
   * artifact's frozen SNAPSHOT and compiled occurrence view (never the live
   * document - submission awaits must not move the compare-and-set baseline).
   */
  private preparedAdvancement(
    session: DocumentSession,
    artifact: CompileArtifact,
  ): AdvancementPlan | undefined {
    if (!this.settings.get<boolean>('features.seedController.enabled')) return undefined
    const steps = controllerAdvancementPlan(artifact.snapshot, artifact)
    if (steps.length === 0) return undefined
    const generations = new Map(steps.flatMap((step) => step.valueSources.map((source) => {
      const location = controllerSourceLocation(source)
      return [advancementInputKey(location), this.controllerMutationGeneration(session, location)] as const
    })))
    return { session, artifact, steps, generations }
  }

  /**
   * Install the plan FIRST, then register: register() synchronously
   * republishes an execution whose terminal event beat the submit response,
   * and the subscriber must find the plan (completed) or drop it
   * (error/interrupted) in that same publication.
   */
  private installRun(
    ref: ExecutionRef,
    artifact: CompileArtifact,
    plan: AdvancementPlan | undefined,
    timestamp?: number,
    identity?: { readonly jobRef?: string; readonly sourceDocument?: string },
  ): void {
    if (plan) this.advancementPlans.set(executionKey(ref), plan)
    // Belt-and-braces retention for artifacts that did not come through
    // compileTab: if the run's backend
    // still holds the registry the artifact compiled against, associate it
    // now. NEVER overwrite a compile-time association - the current registry
    // may be a same-hash impostor (layered replacement) by registration time.
    if (!this.retainedRegistries.has(artifact)) {
      const registry = this.backendFor(ref.connection)?.registry.get()
      if (registry && registry.hash === artifact.schemaHash) this.retainedRegistries.set(artifact, registry)
    }
    this.store.register(ref, artifact, timestamp, identity)
    this.workspaceEvents?.postMessage({
      source: this.workspaceActorId,
      kind: 'register',
      ref,
      artifact: projectWorkspaceCompileArtifact(artifact),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(identity?.jobRef === undefined ? {} : { jobRef: identity.jobRef }),
      ...(identity?.sourceDocument === undefined ? {} : { sourceDocument: identity.sourceDocument }),
    } satisfies WorkspaceExecutionMessage)
  }

  private receiveWorkspaceExecution(raw: unknown): void {
    if (!workspaceRecord(raw) || !workspaceString(raw['source']) || raw['source'] === this.workspaceActorId) return
    if (raw['kind'] === 'event') {
      const event = decodeWorkspaceExecutionEvent(raw['event'])
      if (event === undefined) return
      this.applyWorkspaceExecutionEvent(event)
      return
    }
    if (raw['kind'] !== 'register') return
    const registration = decodeWorkspaceRegistration(raw)
    if (registration === undefined) return
    const key = executionKey(registration.ref)
    this.pendingWorkspaceRegistrations.delete(key)
    this.pendingWorkspaceRegistrations.set(key, registration)
    if (this.pendingWorkspaceRegistrations.size > 200) {
      const oldest = this.pendingWorkspaceRegistrations.keys().next().value as string | undefined
      if (oldest !== undefined) this.pendingWorkspaceRegistrations.delete(oldest)
    }
    this.flushWorkspaceRegistrations(registration.ref.connection)
  }

  private flushWorkspaceRegistrations(connection: ConnectionId): void {
    const backend = this.backendFor(connection) ?? this.retiredBackends.get(connection)
    const registry = backend?.registry.get()
    if (registry === undefined) return
    for (const [key, registration] of this.pendingWorkspaceRegistrations) {
      if (registration.ref.connection !== connection || registration.schemaHash !== registry.hash) continue
      const choices = new Map(registration.choices.map((choice) => [
        JSON.stringify([choice.graph, choice.selector]),
        choice.candidate,
      ]))
      const result = compile({
        document: registration.snapshot,
        revision: registration.revision,
        resolve: registry.resolve,
        scope: registration.scope,
        connection,
        schemaHash: registry.hash,
        candidateOverride: ({ graph, selector, candidates }) => {
          const selected = choices.get(JSON.stringify([graph, selector]))
          return selected !== undefined && candidates.includes(selected) ? selected : undefined
        },
        pickCandidate: () => 0,
        ...(registry.graphFeatures ? { graphFeatures: registry.graphFeatures } : {}),
      })
      if (!result.ok) continue
      const artifact = projectWorkspaceCompileArtifact(result.artifact)
      if (canonicalJson(artifact) !== canonicalJson(registration.artifact)) continue
      this.retainedRegistries.set(artifact, registry)
      this.store.register(registration.ref, artifact, registration.timestamp, {
        ...(registration.jobRef === undefined ? {} : { jobRef: registration.jobRef }),
        ...(registration.sourceDocument === undefined ? {} : { sourceDocument: registration.sourceDocument }),
      })
      this.pendingWorkspaceRegistrations.delete(key)
    }
  }

  private applyWorkspaceExecutionEvent(event: NormalizedEvent): boolean {
    // Append-only events (activity, log) must apply exactly once across the
    // multi-window broadcast; everything else is idempotent per-key state.
    if (event.kind !== 'activity' && event.kind !== 'log') {
      this.store.apply(event)
      return true
    }
    // Log records carry a per-job envelope seq: the only identity stable
    // across windows and replays (each window stamps its own arrival
    // timestamp at normalization, so clock-derived keys would double-apply).
    const key = event.kind === 'log'
      ? `${executionKey(event.execution)}:log:${event.seq}`
      : `${executionKey(event.execution)}:${event.timestamp}:${JSON.stringify(event.activity)}`
    if (this.workspaceExecutionEvents.has(key)) return false
    this.workspaceExecutionEvents.add(key)
    if (this.workspaceExecutionEvents.size > 2_000) {
      const oldest = this.workspaceExecutionEvents.values().next().value as string | undefined
      if (oldest !== undefined) this.workspaceExecutionEvents.delete(oldest)
    }
    this.store.apply(event)
    return true
  }

  /**
   * Apply a captured advancement plan exactly once (the plan is consumed
   * before any dispatch). Steps whose input no longer holds the queue-time
   * stored value OR effective controller mode - edited, reparked, deleted,
   * or in a closed session - are skipped; the survivors dispatch as one
   * atomic, undoable batch.
   */
  private applyAdvancement(key: string): void {
    const plan = this.advancementPlans.get(key)
    if (!plan) return
    this.advancementPlans.delete(key)
    // Disabling the controller mid-run suppresses in-flight plans too.
    if (!this.settings.get<boolean>('features.seedController.enabled')) return
    const tab = this.liveTabContinuing(plan.session)
    if (!tab) return // no live tab continues the planned document: never advance another one
    const input = this.compileInputForTab(tab, plan.artifact.scope)
    if (!input) return
    const choices = new Map((plan.artifact.choices ?? []).map((choice) => [
      JSON.stringify([choice.graph, choice.selector]),
      choice.candidate,
    ]))
    const current = compile({
      ...input,
      candidateOverride: ({ graph, selector, candidates }) => {
        const selected = choices.get(JSON.stringify([graph, selector]))
        return selected !== undefined && candidates.includes(selected) ? selected : undefined
      },
      pickCandidate: ({ graph, selector }) => {
        const selected = choices.get(JSON.stringify([graph, selector]))
        const candidates = tab.store.doc.graphs[graph]?.selectors?.[selector]?.candidates
        const index = selected === undefined ? -1 : candidates?.findIndex((candidate) => candidate.id === selected) ?? -1
        return index < 0 ? 0 : index
      },
    })
    if (!current.ok) return
    const liveControllerInputs = new Map((current.artifact.provenance.controllerInputs ?? []).map((controller) => [
      controllerInputKey(controller.runtimeId, controller.terminal),
      controller,
    ]))
    const doc = tab.store.doc
    const applicable = plan.steps.filter((step) => {
      const node = doc.graphs[step.graphId]?.nodes[step.nodeId]
      if (node === undefined || node.values[step.inputId] !== step.expected) return false
      const liveController = step.controllers.flatMap((queued) => {
        const live = liveControllerInputs.get(controllerInputKey(queued.runtimeId, queued.terminal))
        return live !== undefined && controllerSemanticsKey(live) === controllerSemanticsKey(queued) ? [live] : []
      })[0]
      if (liveController === undefined) return false
      if (step.valueSources.some((source) => {
        const location = controllerSourceLocation(source)
        return this.controllerMutationGeneration(plan.session, location) !== plan.generations.get(advancementInputKey(location))
      })) return false
      const state = effectiveControllerState(doc, liveController.sources, liveController.widget, liveController.optional)
      return state.mode === step.mode && Object.is(state.current, step.current)
    })
    const invocation = advancementInvocation(applicable)
    if (invocation) this.dispatchTo(tab, invocation)
  }

  /**
   * A refused queue replaces the open-time Problems entries (including the
   * schema.unresolvedType explanation) with the raw compile diagnostics, so
   * the fatal unresolved-node entries must explain the refusal themselves:
   * which node the requested run depends on, that its type does not resolve
   * on this backend, and that unresolved nodes are excluded from execution.
   * Core stays queue-agnostic; the wording lives here.
   */
  private queueRefusalDiagnostics(tab: Tab, diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
    const backend = this.backendForTab(tab)
    return diagnostics.map((diagnostic) => {
      if (diagnostic.code !== 'compile.schema.unknown' || diagnostic.severity !== 'error') return diagnostic
      const nodeType = diagnostic.data?.['nodeType']
      const occurrence = diagnostic.anchor?.occurrence
      if (typeof nodeType !== 'string' || occurrence === undefined) return diagnostic
      const node = [...occurrence.instancePath, occurrence.node].join('.')
      return {
        ...diagnostic,
        message: `not queued: the requested output(s) depend on node '${node}' of type '${nodeType}', which does not resolve on backend '${backend.label}' - unresolved nodes are excluded from execution, so a run that depends on one cannot be queued`,
      }
    })
  }

  private connectedPlacementWorker(backend: Backend, workerName: string): WorkerInfo | undefined {
    if (backend.protocol !== 'dinkster' || backend.connection.status.get() !== 'connected') return undefined
    const catalog = backend.workerCatalog.get()
    if (catalog.status !== 'ready') return undefined
    return catalog.workers.find((worker) => worker.name === workerName && worker.status === 'connected')
  }

  private placementIsCurrent(
    tab: Tab,
    backend: Backend,
    compiledDocument: WorkflowDocument,
    placement: Readonly<Record<string, string>>,
  ): boolean {
    const registry = backend.registry.get()
    const root = compiledDocument.graphs[compiledDocument.root]
    return this.tabs.get().includes(tab) &&
      this.backendForTab(tab) === backend &&
      registry?.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_PLACEMENT) === true &&
      root !== undefined &&
      Object.entries(placement).every(([nodeId, workerName]) => {
        if (!Object.hasOwn(root.nodes, nodeId)) return false
        const node = root.nodes[nodeId]!
        const worker = this.connectedPlacementWorker(backend, workerName)
        return worker !== undefined && (
          node.region !== undefined || (
            subgraphDefIdOf(node.type) === undefined && worker.routedNodeTypes.includes(node.type)
          )
        )
      })
  }

  private placementStillAvailable(
    tab: Tab,
    backend: Backend,
    compiledDocument: WorkflowDocument,
    placement: Readonly<Record<string, string>>,
    diagnostics: readonly Diagnostic[],
  ): boolean {
    if (this.placementIsCurrent(tab, backend, compiledDocument, placement)) return true
    if (this.tabs.get().includes(tab)) {
      this.replaceProblems(tab.id, [
        ...diagnostics,
        diag(
          'error',
          'compile',
          'submit.workerUnavailable',
          'worker placement is no longer available; choose Run on machine again',
        ),
      ])
    }
    return false
  }

  async queueOnWorker(tab: Tab, nodeIds: readonly string[], workerName: string): Promise<void> {
    if (tab.execution || currentGraphId(tab) !== tab.store.doc.root) return
    const graph = tab.store.doc.graphs[tab.store.doc.root]
    const selected = graph === undefined ? [] : [...new Set(nodeIds)].flatMap((nodeId) => {
      if (!Object.hasOwn(graph.nodes, nodeId)) return []
      const node = graph.nodes[nodeId]!
      return node !== undefined && (node.region !== undefined || subgraphDefIdOf(node.type) === undefined)
        ? [node]
        : []
    })
    const backend = this.backendForTab(tab)
    const worker = this.connectedPlacementWorker(backend, workerName)
    const routed = new Set(worker?.routedNodeTypes ?? [])
    const unroutable = selected.filter((node) => node.region === undefined && !routed.has(node.type))
    if (selected.length === 0 || worker?.status !== 'connected' || unroutable.length > 0) {
      this.replaceProblems(tab.id, [diag(
        'error',
        'compile',
        'submit.workerUnavailable',
        selected.length === 0
          ? 'Run on machine requires at least one ordinary root node or region'
          : worker?.status !== 'connected'
            ? `worker '${workerName}' is not connected`
            : `worker '${workerName}' does not route every selected node type`,
      )])
      return
    }
    const placement = Object.fromEntries(selected.map((node) => [node.id, workerName]))
    await this.queue(tab, { kind: 'full' }, selected.map((node) => node.id), placement)
  }

  async queue(
    tab: Tab,
    scope: ExecutionScope = { kind: 'full' },
    requiredRootNodes: readonly string[] = [],
    placement?: Readonly<Record<string, string>>,
  ): Promise<void> {
    if (this.disposed || tab.execution) return // frozen views never queue
    const promotion = this.workspacePromotions.get(tab.id)
    if (promotion?.tab === tab) {
      await promotion.promise
      if (this.disposed) return
      const promoted = this.liveTabContinuing(tab.store)
      if (promoted === undefined) return
      tab = promoted
    }
    // Exact-object liveness: a closed or same-lineage-replaced tab is a
    // different document lineage session - it must not queue, and its late
    // results must not touch the replacement's Problems entries.
    if (!this.tabs.get().includes(tab)) return
    const requestedPlacement = placement === undefined ? undefined : { ...placement }
    const compiledDocument = tab.store.doc
    const result = this.compileTab(tab, scope)
    if (!result) return
    if (!result.ok) {
      // Queueing refreshes THIS tab's Problems entries (compile results
      // supersede open-time/previous-queue entries); other tabs' entries
      // and app-scoped entries are untouched.
      this.replaceProblems(tab.id, this.queueRefusalDiagnostics(tab, result.diagnostics))
      return
    }
    const missingRequired = requiredRootNodes.filter((required) =>
      !Object.values(result.artifact.provenance.toSource).some((key) => {
        const occurrence = parseOccurrenceKey(key)
        return occurrence.instancePath[0] === required ||
          (occurrence.instancePath.length === 0 && occurrence.node === required)
      }),
    )
    if (missingRequired.length > 0) {
      this.replaceProblems(tab.id, [diag(
        'error',
        'compile',
        'compile.scope.inactiveSelection',
        `selected node${missingRequired.length === 1 ? '' : 's'} ${missingRequired.map((id) => `'${id}'`).join(', ')} did not survive executable branch lowering`,
      )])
      return
    }
    this.replaceProblems(tab.id, result.artifact.diagnostics)
    // The advancement plan is fixed HERE, synchronously with the compile:
    // artifact snapshot as the value baseline, compiled occurrence
    // provenance as the owner view, and feature setting as of the queue
    // action. Edits during the submission awaits below can no longer shape
    // what completion applies.
    const plan = this.preparedAdvancement(tab.store, result.artifact)
    const lease = this.retainSubmissionWorld(tab, result.artifact)
    let consentOwnsLease = false
    try {
      // The artifact records its target connection; submit() cross-checks it.
      // Native backends get the advisory sourceDocument stamp: the exact
      // producing document (environment stamp inside) as a content-addressed
      // asset, so history can answer "which document made this run".
      const backend = this.backendForTab(tab)
      const sourceDocument = backend.protocol === 'dinkster'
        ? await this.sourceDocumentFor(tab, backend)
        : undefined
      if (lease.signal.aborted) return
      // The advisory source-document upload is an await between compile and
      // POST. If the document changed there, re-run only the conservative
      // wire-15 mode gate against current state; identical document objects
      // stay on the zero-work fast path. Never send the captured artifact
      // once the current document has entered the unsupported combination.
      if (this.wire15ModeChangeBlocksSubmission(tab, scope, compiledDocument)) return
      if (requestedPlacement !== undefined && !this.placementStillAvailable(
        tab,
        backend,
        compiledDocument,
        requestedPlacement,
        result.artifact.diagnostics,
      )) return
      lease.markPosted()
      const submitted =
        backend.protocol === 'dinkster'
          ? await backend.connection.submit(result.artifact, {
              ...sourceDocument,
              ...(requestedPlacement !== undefined ? { placement: requestedPlacement } : {}),
              // Overrides come from the artifact snapshot (the exact document
              // that compiled), layered global < workflow < node.
              previews: resolvePreviewPolicy(
                result.artifact.snapshot,
                result.artifact.provenance,
                this.settings.get<PreviewMode>('execution.previews'),
                this.settings.get<PreviewAnimation>('execution.previewAnimation'),
              ),
            })
          : await backend.connection.submit(result.artifact)
      if (this.disposed) return
      if (!submitted.ok) {
        if ('assetsMissing' in submitted && 'retryWithAssets' in submitted) {
          // Exact-object check after the await: a closed/replaced tab's late
          // assetsMissing response must not install a consent dialog for a
          // dead session (or clobber one the replacement tab installed).
          if (!this.tabs.get().includes(tab)) return
          this.openAssetConsent(
            tab,
            submitted as Extract<DinksterSubmitResult, { assetsMissing: unknown }>,
            result.artifact,
            plan,
            scope,
            compiledDocument,
            backend,
            requestedPlacement,
            sourceDocument?.sourceDocument,
            lease,
          )
          consentOwnsLease = true
          return
        }
        // Exact-object check after the await: a replaced/closed tab's late
        // rejection must not clobber (or resurrect entries under) the
        // replacement session that reuses this tab id.
        if (this.tabs.get().includes(tab)) {
          this.replaceProblems(tab.id, [...result.artifact.diagnostics, ...submitted.diagnostics])
        }
        return
      }
      this.installRun(submitted.execution, result.artifact, plan, undefined, {
        ...(submitted.jobRef === undefined ? {} : { jobRef: submitted.jobRef }),
        ...(sourceDocument?.sourceDocument === undefined ? {} : { sourceDocument: sourceDocument.sourceDocument }),
      })
      this.log('info', backend.label, `job submitted: ${submitted.execution.prompt}`)
    } catch (e) {
      // Network/transport failures must land in Problems, never vanish -
      // unless the tab is gone (exact object), in which case there is no
      // session left to own the report.
      if (!this.tabs.get().includes(tab)) return
      this.reportProblems(tab.id, [
        {
          severity: 'error',
          origin: 'validation',
          code: 'submit.transportFailed',
          message: `failed to submit prompt: ${e instanceof Error ? e.message : String(e)}`,
        },
      ])
    } finally {
      if (!consentOwnsLease) lease.release()
    }
  }

  /**
   * Refuse a stale captured submission only when current state now hits the
   * recursive wire-15 bypass/mute safety gate. Other edits retain the queue
   * path's established snapshot semantics. The common unchanged-document
   * path performs no compile.
   */
  private wire15ModeChangeBlocksSubmission(
    tab: Tab,
    scope: ExecutionScope,
    compiledDocument: WorkflowDocument,
  ): boolean {
    // A replacement session may reuse the lineage id, and a collaborative
    // rebase can change content while confirmed+pending keeps the same
    // numeric revision. Exact ownership and document object identity are the
    // only safe fast paths for the captured artifact/body.
    if (!this.tabs.get().includes(tab)) return true
    if (tab.store.doc === compiledDocument) return false
    const current = this.compileTab(tab, scope)
    if (current === undefined || current.ok) return false
    const gate = current.diagnostics.filter((diagnostic) =>
      diagnostic.code === 'compile.wire15.modesUnsupported')
    if (gate.length === 0) return false
    this.replaceProblems(tab.id, gate)
    return true
  }

  private openAssetConsent(
    tab: Tab,
    submitted: Extract<DinksterSubmitResult, { assetsMissing: unknown }>,
    artifact: CompileArtifact,
    plan: AdvancementPlan | undefined,
    scope: ExecutionScope,
    compiledDocument: WorkflowDocument,
    backend: Backend,
    placement: Readonly<Record<string, string>> | undefined,
    sourceDocument: string | undefined,
    lease: { readonly signal: AbortSignal; readonly release: () => void },
  ): void {
    // Problems callbacks re-prove exact-object tab liveness at fire time: a
    // retried submit that reached the server still installs its run, but a
    // closed/replaced tab owns no further diagnostics.
    const tabLive = (): boolean => this.tabs.get().includes(tab)
    // The whole retry conversation is owner-checked - a superseded
    // chain (newer submit claimed the dialog, or the user dismissed it)
    // stops touching the slot. A retried submit that reached the server
    // still installs its run; a superseded still-missing outcome lands in
    // Problems instead of reopening over the newer owner's dialog.
    installAssetConsent({
      result: submitted,
      slot: this.assetConsent,
      signal: lease.signal,
      onSettled: lease.release,
      // retryWithAssets re-POSTs the body captured by the first submit. Apply
      // the same document and placement safety gates before every retry stage.
      beforeRetry: () =>
        !this.wire15ModeChangeBlocksSubmission(tab, scope, compiledDocument) &&
        (placement === undefined || this.placementStillAvailable(
          tab,
          backend,
          compiledDocument,
          placement,
          artifact.diagnostics,
        )),
      onSubmitted: (ok) => {
        if (this.disposed) return
        this.installRun(ok.execution, artifact, plan, undefined, {
          ...(ok.jobRef === undefined ? {} : { jobRef: ok.jobRef }),
          ...(sourceDocument === undefined ? {} : { sourceDocument }),
        })
        this.log(
          'info',
          this.backendFor(ok.execution.connection)?.label ?? String(ok.execution.connection),
          `job submitted: ${ok.execution.prompt}`,
        )
      },
      onRejected: (diagnostics) => {
        if (tabLive()) this.replaceProblems(tab.id, [...artifact.diagnostics, ...diagnostics])
      },
      onTransportError: (message) => { if (tabLive()) this.reportProblems(tab.id, [diag(
        'error',
        'validation',
        'submit.transportFailed',
        `failed to submit prompt: ${message}`,
      )]) },
      onSuperseded: (assets) => { if (tabLive()) this.reportProblems(tab.id, [diag(
        'warning',
        'validation',
        'submit.assetsStillMissing',
        `submission still missing ${assets.length} asset(s); its consent dialog was superseded - queue again to retry`,
      )]) },
    })
  }

  /** Keys already hydrated (or being hydrated) from /history. */
  private readonly hydrated = new Set<string>()

  /**
   * A fully cached execution completes without ever emitting `executed`
   * events, so its outputs exist only in server history. Hydrate them once
   * per completed execution that has none.
   */
  private hydrateCachedOutputs(execs: ReadonlyMap<string, ExecutionState>): void {
    for (const state of execs.values()) {
      if (state.status !== 'completed') continue
      if (Object.keys(state.outputs).length > 0) continue
      if (this.hydrated.has(state.key)) continue
      // Route by the execution's OWN connection; a removed backend's runs
      // simply stay unhydrated (retried if it is ever re-added).
      const backend = this.backendFor(state.ref.connection)
      if (!backend) continue
      this.hydrated.add(state.key)
      // Protocol dispatch: V1 outputs live in /history; native output
      // descriptors ride the retained job record. Same store shape either way.
      const fetched =
        backend.protocol === 'dinkster'
          ? backend.connection.fetchJobOutputs(state.ref.prompt)
          : backend.connection.fetchHistoryOutputs(state.ref.prompt)
      void fetched
        .then((outputs) => {
          if (Object.keys(outputs).length > 0) this.store.hydrateOutputs(state.ref, outputs)
        })
        .catch(() => this.hydrated.delete(state.key))
    }
  }

  /**
   * Latest execution belonging to a document lineage. Matching is by the
   * artifact's snapshot lineage - executions render on the right tab no
   * matter which tab is active.
   */
  latestExecutionFor(lineage: LineageId): ExecutionState | undefined {
    let latest: ExecutionState | undefined
    for (const state of this.store.executions.get().values()) {
      if (state.artifact?.snapshot.lineage !== lineage) continue
      if (!latest || state.queuedAt > latest.queuedAt) latest = state
    }
    return latest
  }

  executionList(): readonly ExecutionState[] {
    return [...this.store.executions.get().values()].sort((a, b) => b.queuedAt - a.queuedAt)
  }

  /**
   * Executions owned by one workflow tab, newest first. The compile
   * artifact's snapshot lineage is the existing ownership contract: foreign
   * jobs without an artifact cannot be attributed and are never guessed into
   * a workflow queue.
   */
  executionsForTab(tab: Tab): readonly ExecutionState[] {
    if (tab.execution) {
      const state = this.store.get(tab.execution)
      return state ? [state] : []
    }
    const lineage = tab.store.doc.lineage
    return this.executionList().filter((state) => state.artifact?.snapshot.lineage === lineage)
  }

  /**
   * The execution a tab's overlay shows: frozen tabs show EXACTLY their
   * execution; live tabs show their pinned execution when one is pinned (and
   * still valid), otherwise the latest execution of their lineage.
   */
  executionForTab(tab: Tab): ExecutionState | undefined {
    if (tab.execution) return this.store.get(tab.execution)
    return this.pinnedExecutionFor(tab) ?? this.latestExecutionFor(tab.store.doc.lineage)
  }

  /**
   * Resolve a live tab's pin to a real execution of ITS lineage. A pin whose
   * execution vanished (history eviction) or never matched the tab's lineage
   * resolves to nothing, so the tab silently falls back to follow-latest
   * rather than showing a foreign or empty overlay.
   */
  private pinnedExecutionFor(tab: Tab): ExecutionState | undefined {
    if (tab.execution) return undefined
    const ref = this.overlayPins.get().get(tab.id)
    if (!ref) return undefined
    const state = this.store.get(ref)
    if (state?.artifact?.snapshot.lineage !== tab.store.doc.lineage) return undefined
    return state
  }

  /** Whether a live tab's overlay follows the newest run or a pinned one. */
  overlayModeForTab(tab: Tab): 'latest' | 'pinned' {
    return this.pinnedExecutionFor(tab) ? 'pinned' : 'latest'
  }

  /**
   * Pin a live tab's execution overlay to one explicit run. VIEW state:
   * never serialized, never routed through document commands. Rejects
   * frozen tabs and executions from another lineage - an execution may only
   * overlay the live tab it was submitted from.
   */
  pinExecutionOverlay(tabId: string, ref: ExecutionRef): boolean {
    const tab = this.tabs.get().find((t) => t.id === tabId)
    if (!tab || tab.execution) return false
    const state = this.store.get(ref)
    if (state?.artifact?.snapshot.lineage !== tab.store.doc.lineage) return false
    this.overlayPins.update((pins) => new Map(pins).set(tabId, ref))
    return true
  }

  /** Return a live tab's overlay to following its lineage's newest run. */
  followLatestExecution(tabId: string): void {
    if (!this.overlayPins.get().has(tabId)) return
    this.overlayPins.update((pins) => {
      const next = new Map(pins)
      next.delete(tabId)
      return next
    })
  }

  /** The live (editable) tab of a lineage, if it is open. */
  liveTabFor(lineage: LineageId): Tab | undefined {
    return this.tabs.get().find((t) => !t.execution && t.store.doc.lineage === lineage)
  }

  /**
   * Session-identity forwarding for store swaps that CONTINUE an editing
   * session (workspace-authority promotion adopts the document and its
   * history). Re-opening a document is deliberately NOT a continuation:
   * plans captured against the closed session must never advance the
   * fresh one, even though the lineage matches.
   */
  private readonly sessionContinuations = new WeakMap<DocumentSession, DocumentSession>()

  /**
   * The live tab whose editing session continues `session`: the tab still
   * holding it as its store, or the one holding its recorded continuation
   * after a store swap landed while a plan was in flight. Callers
   * re-validate per-step against the found tab's current document.
   */
  private liveTabContinuing(session: DocumentSession): Tab | undefined {
    let current = session
    for (let next = this.sessionContinuations.get(current); next; next = this.sessionContinuations.get(current)) {
      current = next
    }
    return this.tabs.get().find((tab) => !tab.execution && tab.store === current)
  }

  /**
   * Cached semantic hash per tab SESSION (WeakMap: a same-lineage
   * replacement restarts at revision 0 and must never see the old
   * session's hash; closed tabs collect without bookkeeping), validated
   * by document revision.
   */
  private readonly hashCache = new WeakMap<Tab, { revision: number; hash: string }>()

  private semanticHashOfTab(tab: Tab): string {
    const cached = this.hashCache.get(tab)
    if (cached && cached.revision === tab.store.revision) return cached.hash
    const hash = semanticHashOf(tab.store.doc)
    this.hashCache.set(tab, { revision: tab.store.revision, hash })
    return hash
  }

  /**
   * Does a frozen tab's snapshot still match the live document? Semantic
   * hashes compare graph content only (positions/pan don't count), so
   * "in-sync" means the execution truthfully reflects the live workflow.
   */
  frozenSyncStatus(tab: Tab): FrozenSyncStatus | undefined {
    if (!tab.execution) return undefined
    const artifact = this.store.get(tab.execution)?.artifact
    if (!artifact) return undefined
    const live = this.liveTabFor(tab.store.doc.lineage)
    if (!live) return 'no-live-tab'
    return this.semanticHashOfTab(live) === artifact.semanticHash ? 'in-sync' : 'diverged'
  }

  /**
   * For a LIVE tab: how its document relates to the execution its overlay
   * shows (pinned run when pinned, else the lineage's latest). `inSync:
   * false` means edits landed after that submission - progress overlays may
   * not match what actually runs; the frozen view is the truth.
   */
  liveSyncStatus(tab: Tab): {
    ref: ExecutionRef
    status: ExecutionStatus
    inSync: boolean
    mode: 'latest' | 'pinned'
  } | undefined {
    if (tab.execution) return undefined
    const pinned = this.pinnedExecutionFor(tab)
    const shown = pinned ?? this.latestExecutionFor(tab.store.doc.lineage)
    if (!shown?.artifact) return undefined
    return {
      ref: shown.ref,
      status: shown.status,
      inSync: this.semanticHashOfTab(tab) === shown.artifact.semanticHash,
      mode: pinned ? 'pinned' : 'latest',
    }
  }

  tabTitleFor(ref: ExecutionRef): string {
    const state = this.store.executions.get().get(executionKey(ref))
    const lineage = state?.artifact?.snapshot.lineage
    return (lineage && this.liveTabFor(lineage)?.title) ?? '(external)'
  }
}

/**
 * True when any node in any graph resolves to a schema with a lazy-switch
 * `selector`. Cheap O(nodes) scan with per-type memoization; gates the full
 * would-run closure compile in scopeClosureCached.
 */
export function documentHasLazySelector(
  document: WorkflowDocument,
  resolve: CompileInput['resolve'],
): boolean {
  const byType = new Map<string, boolean>()
  for (const graph of Object.values(document.graphs)) {
    for (const node of Object.values(graph.nodes)) {
      let has = byType.get(node.type)
      if (has === undefined) {
        has = resolve(node.type)?.selector !== undefined
        byType.set(node.type, has)
      }
      if (has) return true
    }
  }
  return false
}

export type { ReadonlySignal }
