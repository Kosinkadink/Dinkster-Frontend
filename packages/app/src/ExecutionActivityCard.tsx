import { For, Show } from 'solid-js'
import type { ExecutionState } from '@dinkster/client'
import { isDinksterRegionEntry, type DinksterGraphWire } from '@dinkster/core'
import { runAttributionLabel } from './run-attribution.js'

export type ExecutionActivityRelation = 'latest' | 'pinned'

const STATUS_LABELS: Readonly<Record<ExecutionState['status'], string>> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  error: 'Failed',
  interrupted: 'Interrupted',
}

export const executionStatusLabel = (status: ExecutionState['status']): string => STATUS_LABELS[status]

export interface ExecutionProgress {
  readonly finished: number
  readonly total: number
  readonly value: number
}

export interface ExecutionRegionIterationRow {
  readonly runtimeId: string
  readonly kind: 'map' | 'fold' | 'while'
  readonly iteration: number
  readonly state: 'waiting' | 'running' | 'completed'
}

export function executionRegionIterationRows(entry: ExecutionState): readonly ExecutionRegionIterationRow[] {
  return Object.entries(entry.regions).flatMap(([runtimeId, region]) => {
    const observed = Object.keys(region.iterationStates ?? {}).map(Number)
    const count = region.iterations ?? (observed.length === 0 ? 0 : Math.max(...observed) + 1)
    return Array.from({ length: count }, (_, iteration) => ({
      runtimeId,
      kind: region.kind,
      iteration,
      state: region.iterationStates?.[iteration] ?? 'waiting',
    }))
  })
}

const terminalNode = (state: ExecutionState['nodes'][string]['state']): boolean =>
  state === 'done' || state === 'cached'

const scheduledGraphNodes = (
  entry: ExecutionState,
  graph: DinksterGraphWire,
  prefix = '',
): ReadonlySet<string> | undefined => {
  const scheduled = new Set<string>()
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const runtimeId = `${prefix}${nodeId}`
    if (!isDinksterRegionEntry(node)) {
      scheduled.add(runtimeId)
      continue
    }
    const progress = entry.regions[runtimeId]
    const iterations = progress?.iterations ?? progress?.finishedIterations
    if (iterations === undefined) return undefined
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const body = scheduledGraphNodes(entry, node.region.body, `${runtimeId}[${iteration}]/`)
      if (body === undefined) return undefined
      for (const bodyNodeId of body) scheduled.add(bodyNodeId)
    }
  }
  return scheduled
}

export function executionProgress(entry: ExecutionState): ExecutionProgress | undefined {
  if (entry.artifact === undefined) return undefined
  const scheduled = entry.artifact?.dinksterGraph === undefined
    ? new Set(Object.keys(entry.artifact.prompt))
    : scheduledGraphNodes(entry, entry.artifact.dinksterGraph)
  if (scheduled === undefined) return undefined
  const total = scheduled.size
  if (total === 0) return undefined
  const nodes = [...scheduled].map((nodeId) => entry.nodes[nodeId]).filter((node) => node !== undefined)
  const finished = nodes.filter((node) => terminalNode(node.state)).length
  const active = nodes.reduce((sum, node) =>
    node.state === 'running' && node.value !== undefined && Number.isFinite(node.value)
      ? sum + Math.min(1, Math.max(0, node.value))
      : sum,
  0)
  return { finished, total, value: Math.min(1, (finished + active) / total) }
}

export function executionNodeSummary(entry: ExecutionState): string | undefined {
  const counts = new Map<string, number>()
  for (const node of Object.values(entry.nodes)) counts.set(node.state, (counts.get(node.state) ?? 0) + 1)
  const facts = [
    ['done', 'done'],
    ['cached', 'cached'],
    ['skipped', 'skipped'],
    ['error', 'failed'],
  ] as const
  const summary = facts.flatMap(([state, label]) => {
    const count = counts.get(state) ?? 0
    return count > 0 ? [`${count} ${label}`] : []
  })
  return summary.length > 0 ? summary.join(', ') : undefined
}

export function ExecutionActivityCard(props: {
  readonly entry: ExecutionState
  readonly title: string
  readonly testId: string
  readonly relation?: ExecutionActivityRelation | undefined
  readonly compact?: boolean | undefined
  readonly onOpen?: (() => void) | undefined
  readonly onPin?: (() => void) | undefined
}) {
  const status = () => executionStatusLabel(props.entry.status)
  const progress = () => executionProgress(props.entry)
  const nodeSummary = () => executionNodeSummary(props.entry)
  const regionIterations = () => executionRegionIterationRows(props.entry)
  const partial = () => props.entry.artifact?.scope.kind === 'partial'
  const partialTargets = () => props.entry.artifact?.scope.kind === 'partial'
    ? props.entry.artifact.partialTargets?.length
    : undefined
  const attribution = () => runAttributionLabel({
    principalId: props.entry.submittedBy?.principalId,
    kind: props.entry.submittedBy?.kind,
  })
  const openLabel = () => `Open ${props.title}, execution ${props.entry.ref.prompt}, ${status().toLocaleLowerCase()}`

  return (
    <article
      class="execution-activity-card"
      classList={{ compact: props.compact === true }}
      role="listitem"
      data-testid={props.testId}
      data-status={props.entry.status}
      data-overlay={props.relation}
      title={props.compact === true ? attribution() : undefined}
    >
      <div class="execution-activity-heading">
        <span class="execution-status-mark" aria-hidden="true" />
        <span class="execution-activity-title">
          <strong class="execution-tab">{props.title}</strong>
          <span class="execution-id">{props.entry.ref.prompt}</span>
        </span>
        <span class="execution-status">{status()}</span>
      </div>
      <div class="execution-activity-facts">
        <Show when={props.compact !== true ? attribution() : undefined}>
          {(label) => (
            <span class="execution-attribution">
              {label()}
              <Show when={props.entry.submittedBy?.kind === 'agent'}>
                <span class="collab-agent">agent</span>
              </Show>
            </span>
          )}
        </Show>
        <Show when={partial()}>
          <span class="execution-scope">
            Partial run{partialTargets() === undefined ? '' : ` - ${partialTargets()} target${partialTargets() === 1 ? '' : 's'}`}
          </span>
        </Show>
        <Show when={nodeSummary()}>{(summary) => <span>{summary()}</span>}</Show>
        <Show when={props.entry.errors.length > 0}>
          <span class="execution-errors">{props.entry.errors.length} error{props.entry.errors.length === 1 ? '' : 's'}</span>
        </Show>
        <Show when={!props.entry.artifact}>
          <span class="execution-incomplete">Snapshot unavailable - submitted by another client</span>
        </Show>
        <Show when={props.relation === 'latest'}><span class="execution-relation">Following latest</span></Show>
        <Show when={props.relation === 'pinned'}><span class="execution-relation">Pinned to canvas</span></Show>
      </div>
      <Show when={props.entry.status === 'running' && progress() !== undefined}>
        <label class="execution-progress">
          <span>Workflow progress {Math.round(progress()!.value * 100)}%</span>
          <progress max="1" value={progress()!.value} />
        </label>
      </Show>
      <Show when={regionIterations().length > 0}>
        <div class="execution-region-iterations" aria-label="Loop iteration progress">
          <For each={regionIterations()}>{(row) => (
            <div class="execution-region-iteration" data-state={row.state}>
              <span class="execution-region-item">
                {row.kind} {row.runtimeId} - item {row.iteration + 1}
              </span>
              <span class="execution-region-state">{row.state}</span>
            </div>
          )}</For>
        </div>
      </Show>
      <div class="execution-activity-actions">
        <button
          type="button"
          class="execution-open"
          aria-label={props.entry.artifact ? openLabel() : undefined}
          disabled={!props.entry.artifact}
          onClick={props.onOpen}
        >
          {props.entry.artifact ? 'Open snapshot' : 'Snapshot unavailable'}
        </button>
        <Show when={props.onPin}>
          {(pin) => (
            <button
              type="button"
              class="execution-pin"
              classList={{ pinned: props.relation === 'pinned' }}
              data-testid="execution-pin"
              aria-pressed={props.relation === 'pinned'}
              aria-label={props.relation === 'pinned' ? 'Follow latest execution' : 'Pin this execution to the canvas'}
              onClick={pin()}
            >
              {props.relation === 'pinned' ? 'Follow latest' : 'Pin to canvas'}
            </button>
          )}
        </Show>
      </div>
    </article>
  )
}
