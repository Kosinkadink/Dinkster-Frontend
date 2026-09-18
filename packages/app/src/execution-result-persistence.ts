import {
  projectWorkspaceCompileArtifact,
  type CompileArtifact,
  type ConnectionId,
  type ExecutionRef,
  type NodeOutputSummary,
  type NodeProgress,
  type SelectorChoice,
  type WorkspaceCompileArtifact,
  type WorkspaceProvenance,
} from '@dinkster/core'
import type { ExecutionArtifact, ExecutionState, ExecutionSubmitter } from '@dinkster/client'
import { scopedStorageKey } from './projects.js'

export const EXECUTION_RESULTS_STORAGE_KEY = 'dinkster.executionResults'
export const MAX_PERSISTED_EXECUTION_RESULTS = 40
export const MAX_PERSISTED_EXECUTION_BYTES = 1_000_000

export interface ExecutionResultBackendIdentity {
  readonly connection: ConnectionId
  readonly baseUrl: string
  readonly clientId: string
  readonly serverVersion: string
  readonly schemaWire: number
}

export interface PersistedCompileProof {
  readonly revision: number
  readonly semanticHash: string
  readonly scope: CompileArtifact['scope']
  readonly connection: ConnectionId
  readonly schemaHash: string
  readonly prompt: CompileArtifact['prompt']
  readonly dinksterGraph?: CompileArtifact['dinksterGraph']
  readonly dinksterTargets?: readonly string[]
  readonly partialTargets?: readonly string[]
  readonly provenance: WorkspaceProvenance
  readonly choices?: readonly SelectorChoice[]
}

export interface PersistedExecutionResult {
  readonly backend: ExecutionResultBackendIdentity
  readonly ref: ExecutionRef
  readonly jobRef: string
  readonly sourceDocument: string
  readonly proof: PersistedCompileProof
  readonly nodes: Readonly<Record<string, NodeProgress>>
  readonly outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly artifacts: readonly ExecutionArtifact[]
  readonly submittedBy?: ExecutionSubmitter
  readonly queuedAt: number
  readonly endedAt: number
}

interface ExecutionResultsEnvelope {
  readonly v: 1
  readonly results: readonly PersistedExecutionResult[]
}

const storageKey = (): string => scopedStorageKey(EXECUTION_RESULTS_STORAGE_KEY)
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const string = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const scalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'boolean' || finite(value)
const bytesOf = (value: string): number => new TextEncoder().encode(value).byteLength

const outputSummary = (value: NodeOutputSummary): NodeOutputSummary => ({
  typeId: value.typeId,
  ...(value.length === undefined ? {} : { length: value.length }),
  ...(value.value === undefined ? {} : { value: value.value }),
})

const persistedNodes = (nodes: ExecutionState['nodes']): Record<string, NodeProgress> =>
  Object.fromEntries(Object.entries(nodes).flatMap(([runtimeId, progress]) => {
    if (progress.state !== 'done' && progress.state !== 'cached') return []
    const outputs = progress.outputs === undefined
      ? undefined
      : Object.fromEntries(Object.entries(progress.outputs).map(([outputId, summary]) => [
          outputId,
          outputSummary(summary),
        ]))
    return [[runtimeId, {
      state: progress.state,
      ...(progress.executionArm === undefined ? {} : { executionArm: progress.executionArm }),
      ...(progress.provider === undefined ? {} : { provider: progress.provider }),
      ...(progress.pack === undefined ? {} : { pack: progress.pack }),
      ...(progress.worker === undefined ? {} : { worker: progress.worker }),
      ...(outputs === undefined ? {} : { outputs }),
    } satisfies NodeProgress]]
  }))

const META_KEYS = new Set([
  'digest', 'mediaType', 'name', 'size', 'virtualPath', 'width', 'height',
  'duration', 'frameCount', 'fps', 'channels', 'sampleRate',
])

const persistedDescriptor = (value: unknown, depth = 0): unknown => {
  if (!record(value) || depth > 8 || !string(value['typeId'])) return undefined
  const descriptor: Record<string, unknown> = { typeId: value['typeId'] }
  if (string(value['fingerprint'])) descriptor['fingerprint'] = value['fingerprint']
  if (scalar(value['value'])) descriptor['value'] = value['value']
  if (Number.isSafeInteger(value['length']) && (value['length'] as number) >= 0) descriptor['length'] = value['length']
  if (record(value['meta'])) {
    const meta = Object.fromEntries(Object.entries(value['meta'])
      .filter(([key, item]) => META_KEYS.has(key) && scalar(item)))
    if (Object.keys(meta).length > 0) descriptor['meta'] = meta
  }
  if (Array.isArray(value['elements'])) {
    const elements = value['elements'].slice(0, 64).map((item) => persistedDescriptor(item, depth + 1))
    if (elements.every((item) => item !== undefined)) descriptor['elements'] = elements
  }
  if (value['elementsTruncated'] === true) descriptor['elementsTruncated'] = true
  return descriptor
}

const persistedOutputs = (outputs: ExecutionState['outputs']): PersistedExecutionResult['outputs'] =>
  Object.fromEntries(Object.entries(outputs).flatMap(([runtimeId, byOutput]) => {
    const descriptors = Object.fromEntries(Object.entries(byOutput).flatMap(([outputId, value]) => {
      const descriptor = persistedDescriptor(value)
      return descriptor === undefined ? [] : [[outputId, descriptor]]
    }))
    return Object.keys(descriptors).length === 0 ? [] : [[runtimeId, descriptors]]
  }))

export function persistedCompileProof(artifact: CompileArtifact): PersistedCompileProof {
  const projected: WorkspaceCompileArtifact = projectWorkspaceCompileArtifact(artifact)
  return {
    revision: projected.revision,
    semanticHash: projected.semanticHash,
    scope: projected.scope,
    connection: projected.connection,
    schemaHash: projected.schemaHash,
    prompt: projected.prompt,
    ...(projected.dinksterGraph === undefined ? {} : { dinksterGraph: projected.dinksterGraph }),
    ...(projected.dinksterTargets === undefined ? {} : { dinksterTargets: projected.dinksterTargets }),
    ...(projected.partialTargets === undefined ? {} : { partialTargets: projected.partialTargets }),
    provenance: projected.provenance,
    ...(projected.choices === undefined ? {} : { choices: projected.choices }),
  }
}

function decodeResult(value: unknown): PersistedExecutionResult | undefined {
  if (!record(value) || !record(value['backend']) || !record(value['ref']) || !record(value['proof']) ||
    !record(value['nodes']) || !record(value['outputs']) || !Array.isArray(value['artifacts']) ||
    !string(value['jobRef']) || !string(value['sourceDocument']) ||
    !finite(value['queuedAt']) || !finite(value['endedAt'])) return undefined
  const backend = value['backend']
  const ref = value['ref']
  const proof = value['proof']
  const submittedBy = value['submittedBy']
  if (!string(backend['connection']) || !string(backend['clientId']) ||
    typeof backend['baseUrl'] !== 'string' || !string(backend['serverVersion']) ||
    !Number.isSafeInteger(backend['schemaWire']) ||
    !string(ref['connection']) || !string(ref['prompt']) ||
    !Number.isSafeInteger(proof['revision']) || !string(proof['semanticHash']) ||
    !string(proof['connection']) || !string(proof['schemaHash']) ||
    !record(proof['prompt']) || !record(proof['provenance']) || !record(proof['scope']) ||
    !record(submittedBy) || !string(submittedBy['principalId']) ||
    (submittedBy['kind'] !== 'human' && submittedBy['kind'] !== 'agent')) return undefined
  return value as unknown as PersistedExecutionResult
}

function readEnvelope(): ExecutionResultsEnvelope {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey())
    if (raw === null || raw === undefined || bytesOf(raw) > MAX_PERSISTED_EXECUTION_BYTES) return { v: 1, results: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!record(parsed) || parsed['v'] !== 1 || !Array.isArray(parsed['results'])) return { v: 1, results: [] }
    return { v: 1, results: parsed['results'].flatMap((value) => {
      const decoded = decodeResult(value)
      return decoded === undefined ? [] : [decoded]
    }) }
  } catch {
    return { v: 1, results: [] }
  }
}

function writeResults(results: readonly PersistedExecutionResult[]): void {
  const bounded = [...results]
    .sort((left, right) => right.endedAt - left.endedAt)
    .slice(0, MAX_PERSISTED_EXECUTION_RESULTS)
  while (bounded.length > 0) {
    const raw = JSON.stringify({ v: 1, results: bounded } satisfies ExecutionResultsEnvelope)
    if (bytesOf(raw) <= MAX_PERSISTED_EXECUTION_BYTES) {
      try {
        globalThis.localStorage?.setItem(storageKey(), raw)
        return
      } catch {
        // Quota may be shared with other project state; evict oldest first.
      }
    }
    bounded.pop()
  }
  try {
    globalThis.localStorage?.removeItem(storageKey())
  } catch {
    // Browser storage is advisory.
  }
}

export function saveExecutionResult(
  execution: ExecutionState,
  backend: ExecutionResultBackendIdentity,
): void {
  if (execution.status !== 'completed' || execution.artifact === undefined ||
    execution.jobRef === undefined || execution.sourceDocument === undefined ||
    execution.submittedBy === undefined || execution.endedAt === undefined) return
  const result: PersistedExecutionResult = {
    backend,
    ref: execution.ref,
    jobRef: execution.jobRef,
    sourceDocument: execution.sourceDocument,
    proof: persistedCompileProof(execution.artifact),
    nodes: persistedNodes(execution.nodes),
    outputs: persistedOutputs(execution.outputs),
    artifacts: execution.artifacts.map((artifact) => ({ ...artifact })),
    ...(execution.submittedBy === undefined ? {} : { submittedBy: execution.submittedBy }),
    queuedAt: execution.queuedAt,
    endedAt: execution.endedAt,
  }
  const previous = readEnvelope().results.filter((candidate) =>
    candidate.backend.connection !== backend.connection || candidate.ref.prompt !== execution.ref.prompt)
  writeResults([result, ...previous])
}

export function loadExecutionResults(backend: ExecutionResultBackendIdentity): readonly PersistedExecutionResult[] {
  const results = readEnvelope().results
  const matches = (result: PersistedExecutionResult): boolean =>
    result.backend.connection === backend.connection &&
    result.backend.baseUrl === backend.baseUrl &&
    result.backend.clientId === backend.clientId &&
    result.backend.serverVersion === backend.serverVersion &&
    result.backend.schemaWire === backend.schemaWire
  const staleIdentity = results.some((result) =>
    result.backend.connection === backend.connection && !matches(result))
  if (staleIdentity) writeResults(results.filter((result) =>
    result.backend.connection !== backend.connection || matches(result)))
  return results.filter(matches)
}

export function removeExecutionResult(result: PersistedExecutionResult): void {
  writeResults(readEnvelope().results.filter((candidate) =>
    candidate.backend.connection !== result.backend.connection || candidate.ref.prompt !== result.ref.prompt))
}

export function clearExecutionResultJobRef(connection: ConnectionId, jobRef: string): void {
  writeResults(readEnvelope().results.filter((result) =>
    result.backend.connection !== connection || result.jobRef !== jobRef))
}

export function clearExecutionResults(connection?: ConnectionId): void {
  if (connection === undefined) writeResults([])
  else writeResults(readEnvelope().results.filter((result) => result.backend.connection !== connection))
}
