import { Show, createSignal, onCleanup, type JSX } from 'solid-js'
import type { ExecutionState } from '@dinkster/client'
import { executionKey, formatRelativeTime } from '@dinkster/core'
import { ProductCancelButton, ProductRunActivity } from '@dinkster/ui'
import LoaderCircle from 'lucide-solid/icons/loader-circle'
import Clock from 'lucide-solid/icons/clock'
import { executionActivity } from './execution-activity.js'
import { ExecutionOpenButton, executionProgress, executionStatusLabel } from './ExecutionActivityCard.js'
import { Icon } from './Icon.js'
import { useAppMessage } from './locale.js'
import { ProductButton } from './ProductControls.js'

/** Names a node of a run by its runtime id, as the canvas does. */
export type RunNodeTitle = (entry: ExecutionState, runtimeId: string) => string

export const runIsPending = (entry: ExecutionState): boolean =>
  entry.status === 'running' || entry.status === 'queued'

/**
 * Where a queued job stands among the jobs waiting on its engine, counted
 * from 0 in submission order; undefined for a job that is not waiting.
 */
export function placeInLine(entry: ExecutionState, all: Iterable<ExecutionState>): number | undefined {
  if (entry.status !== 'queued') return undefined
  const waiting = [...all]
    .filter((other) => other.status === 'queued' && other.ref.connection === entry.ref.connection)
    .sort((a, b) => a.queuedAt - b.queuedAt)
  const index = waiting.findIndex((other) => other.key === entry.key)
  return index < 0 ? undefined : index
}

/** How long ago a run ended, in the largest whole unit: "2 minutes ago". */
export function runAge(endedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - endedAt) / 1000))
  // Under a minute reads "now": the lists tick every half minute, so counting seconds would show stale, differing ages.
  if (seconds < 60) return formatRelativeTime(0, 'second', { numeric: 'auto' })
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return formatRelativeTime(-minutes, 'minute')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return formatRelativeTime(-hours, 'hour')
  return formatRelativeTime(-Math.floor(hours / 24), 'day')
}

/** A clock for the ages in a list of finished runs, read again every half minute. */
export function useNow(): () => number {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))
  return now
}

/**
 * One run as one line: ring or clock (or the thumbnail of a finished run),
 * name, percent or place in line, the snowflake, and the slim X while the job
 * can still be cancelled. A running row adds a quiet second line with the node
 * at work and a 2 px bar; a finished row says how it ended and when.
 */
export function RunRow(props: {
  readonly entry: ExecutionState
  readonly name: string
  /** The workflow's name, which the snowflake's label and the X's tooltip carry. */
  readonly workflow: string
  /** A finished row's second line leads with how it ended unless the name already says so. */
  readonly statusInNote: boolean
  readonly all: readonly ExecutionState[]
  readonly cancelling: boolean
  readonly onCancel: () => void
  readonly onOpen: () => void
  readonly testId: string
  readonly nodeTitle?: RunNodeTitle | undefined
  readonly thumbnail?: JSX.Element
  readonly selected?: boolean | undefined
  readonly onSelect?: (() => void) | undefined
  /** Shown under the line, such as the outputs of the chosen run. */
  readonly children?: JSX.Element
}) {
  const message = useAppMessage()
  const now = useNow()
  const status = () => executionStatusLabel(props.entry.status)
  const progress = () => props.entry.status === 'running' ? executionProgress(props.entry) : undefined
  const detail = (): string | undefined => {
    const current = progress()
    if (current !== undefined) return `${Math.round(current.value * 100)}%`
    const index = placeInLine(props.entry, props.all)
    if (index === undefined) return undefined
    return index === 0 ? message('runs.row.next') : message('runs.row.inLine', { place: index + 1 })
  }
  const step = (): string | undefined => {
    const running = Object.entries(props.entry.nodes).find(([, node]) => node.state === 'running')
    if (running === undefined) return undefined
    const [runtimeId, node] = running
    const title = props.nodeTitle?.(props.entry, runtimeId) ?? runtimeId
    return node.max !== undefined && node.value !== undefined
      ? message('runs.row.step', { node: title, step: Math.round(node.value * node.max), total: node.max })
      : title
  }
  const ended = () => props.entry.endedAt ?? props.entry.startedAt ?? props.entry.queuedAt
  return (
    <article
      class="run-row"
      role="listitem"
      data-testid={props.testId}
      data-status={props.entry.status}
      data-selected={props.selected === true ? 'true' : undefined}
    >
      <div class="run-row-line">
        <Show when={runIsPending(props.entry)} fallback={
          <span class="run-row-thumbnail" aria-hidden="true">{props.thumbnail}</span>
        }>
          <span class="run-row-mark" data-status={props.entry.status}>
            <Icon icon={props.entry.status === 'running' ? LoaderCircle : Clock} />
            <Show when={props.statusInNote}><span class="execution-status dinkster-visually-hidden">{status()}</span></Show>
          </span>
        </Show>
        <span class="run-row-text">
          <Show when={props.onSelect} fallback={<span class="run-row-name">{props.name}</span>}>
            {(select) => (
              <ProductButton type="button" variant="ghost" size="compact" class="run-row-name"
                aria-pressed={props.selected === true} onClick={() => select()()}>{props.name}</ProductButton>
            )}
          </Show>
          <Show when={props.entry.status === 'running' ? step() : undefined}>
            {(note) => <span class="run-row-note">{note()}</span>}
          </Show>
          <Show when={!runIsPending(props.entry)}>
            <span class="run-row-note">
              <Show when={props.statusInNote} fallback={runAge(ended(), now())}>
                <span class="execution-status">{status()}</span>, {runAge(ended(), now())}
              </Show>
            </span>
          </Show>
        </span>
        <Show when={detail()}>{(text) => <span class="run-row-detail">{text()}</span>}</Show>
        <ExecutionOpenButton entry={props.entry} title={props.workflow} onOpen={props.onOpen} />
        <Show when={runIsPending(props.entry)}>
          <ProductCancelButton
            label={message('runs.cancel.named', { name: props.workflow })}
            data-testid="cancel-execution"
            pending={props.cancelling}
            onClick={() => props.onCancel()}
          />
        </Show>
      </div>
      <Show when={progress()}>
        {(current) => (
          <progress class="run-row-bar" max="1" value={current().value}
            aria-label={message('runs.row.progress', { name: props.workflow })} />
        )}
      </Show>
      {props.children}
    </article>
  )
}

/** A titled group of run rows: "Running (1)", "Queued (2)", "Finished". */
export function RunSection(props: { readonly title: string; readonly testId?: string; readonly children: JSX.Element }) {
  return (
    <section class="run-section" data-testid={props.testId} aria-label={props.title}>
      <h3 class="run-section-title">{props.title}</h3>
      <div class="run-section-rows" role="list" aria-label={props.title}>{props.children}</div>
    </section>
  )
}

/**
 * The top bar's run activity: the ring and its count, the clock and its
 * count, and the slim X. The X cancels the one running job; with more than
 * one running it opens the list instead. Absent while nothing runs.
 */
export function RunActivityControl(props: {
  readonly executions: readonly ExecutionState[]
  readonly title: (entry: ExecutionState) => string
  readonly cancelling: ReadonlySet<string>
  readonly onCancel: (entry: ExecutionState) => void
  readonly onOpenList: () => void
}) {
  const message = useAppMessage()
  const activity = () => executionActivity(props.executions)
  const running = () => props.executions.filter((entry) => entry.status === 'running')
  const only = () => running().length === 1 ? running()[0] : undefined
  return (
    <Show when={activity().running > 0}>
      <span class="run-activity-control" data-testid="run-activity-control">
        <ProductRunActivity {...activity()} label={message('runs.activity', activity())} />
        <Show when={only()} fallback={
          <ProductCancelButton label={message('runs.cancel.list')} data-testid="cancel-execution" onClick={() => props.onOpenList()} />
        }>
          {(entry) => (
            <ProductCancelButton
              label={message('runs.cancel.named', { name: props.title(entry()) })}
              data-testid="cancel-execution"
              pending={props.cancelling.has(executionKey(entry().ref))}
              onClick={() => props.onCancel(entry())}
            />
          )}
        </Show>
      </span>
    </Show>
  )
}
