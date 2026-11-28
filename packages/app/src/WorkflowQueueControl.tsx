import { For, Show, children, createEffect, createSignal as createSolidSignal, createUniqueId, onCleanup, onMount, type JSX } from 'solid-js'
import type { ExecutionState } from '@dinkster/client'
import { executionKey, type ExecutionRef, type LineageId } from '@dinkster/core'
import Play from 'lucide-solid/icons/play'
import List from 'lucide-solid/icons/list'
import { ProductCancelButton, ProductRunActivity } from '@dinkster/ui'
import { executionActivity } from './execution-activity.js'
import { useAppMessage } from './locale.js'
import { executionProgress, executionStatusLabel } from './ExecutionActivityCard.js'
import { Icon } from './Icon.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { RunProgress, RunRow, RunSection, placeInLine, runIsPending, type RunNodeTitle } from './RunControls.js'

export interface WorkflowQueueOwner {
  readonly id: string
  readonly title: string
  readonly lineage: LineageId
}

/** Running jobs first, then the queue in its order, then finished runs newest first. */
const runOrder = (executions: readonly ExecutionState[]) => {
  const running = executions.filter((entry) => entry.status === 'running')
  const queued = executions.filter((entry) => entry.status === 'queued')
    .sort((a, b) => (placeInLine(a, executions) ?? 0) - (placeInLine(b, executions) ?? 0))
  const finished = executions.filter((entry) => !runIsPending(entry))
  return { pending: [...running, ...queued], finished }
}

export function WorkflowQueueControl(props: {
  readonly owner: WorkflowQueueOwner
  readonly executions: readonly ExecutionState[]
  readonly canQueue: boolean
  /** Why Run is off, shown as its tooltip in place of the action and shortcut. */
  readonly blockedReason?: string | undefined
  /** Absent on a frozen tab, which has no Run button: only its run list and progress. */
  readonly onQueue?: (() => void) | undefined
  /** Replaces Run while unavailable; the factory gives each conditional branch its own DOM. */
  readonly runControl?: (runButton: () => JSX.Element) => JSX.Element
  /** Hides the list and cancel controls, but keeps progress for an existing job. */
  readonly hideRunList?: boolean | undefined
  readonly onOpenExecution: (ref: ExecutionRef) => void
  /** Absent where jobs cannot be cancelled, such as the component gallery. */
  readonly onCancel?: ((ref: ExecutionRef) => void) | undefined
  readonly cancelling?: ReadonlySet<string> | undefined
  readonly nodeTitle?: RunNodeTitle | undefined
  readonly thumbnail?: ((entry: ExecutionState) => JSX.Element) | undefined
}) {
  const message = useAppMessage()
  const runButton = () => <Show when={props.onQueue}>{(onQueue) => <button
    type="button"
    class="workflow-queue-submit"
    data-testid="queue-button"
    aria-label={`Run ${props.owner.title}`}
    data-tooltip-label={props.blockedReason ?? message('command.workflow.queue')}
    data-tooltip-shortcut={props.blockedReason === undefined ? 'Ctrl+Enter' : undefined}
    disabled={!props.canQueue}
    onClick={() => onQueue()()}
  >
    <Icon icon={Play} /> {message('appView.queue')}
  </button>}</Show>
  const runControl = children(() => props.runControl?.(runButton) ?? runButton())
  const [open, setOpen] = createSolidSignal(false)
  createEffect(() => { if (props.hideRunList) setOpen(false) })
  const popoverId = `workflow-queue-popover-${createUniqueId()}`
  let root!: HTMLDivElement
  let toggle!: HTMLButtonElement
  let list!: HTMLDivElement

  const runningEntry = () => props.executions.find((entry) => entry.status === 'running')
  const progress = () => {
    const active = runningEntry()
    return active === undefined ? undefined : executionProgress(active)
  }
  const cancelling = (entry: ExecutionState): boolean => props.cancelling?.has(executionKey(entry.ref)) === true

  const activity = () => executionActivity(props.executions)
  const summary = (): string => {
    const { running, waiting } = activity()
    return [
      ...(running > 0 ? [`${running} running`] : []),
      ...(waiting > 0 ? [`${waiting} queued`] : []),
    ].join(', ') || 'No active jobs'
  }
  const rows = () => runOrder(props.executions)

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) queueMicrotask(() => toggle.focus())
  }

  const focusEntry = (edge: 'first' | 'last'): void => {
    queueMicrotask(() => {
      const entries = [...(list?.querySelectorAll<HTMLButtonElement>('.execution-open:not(:disabled)') ?? [])]
      entries[edge === 'first' ? 0 : entries.length - 1]?.focus()
    })
  }

  const show = (focus: boolean): void => {
    setOpen(true)
    if (focus) focusEntry('first')
  }

  onMount(() => {
    const outside = (event: PointerEvent): void => {
      if (open() && event.target instanceof Node && !root.contains(event.target)) close()
    }
    window.addEventListener('pointerdown', outside, true)
    onCleanup(() => window.removeEventListener('pointerdown', outside, true))
  })

  const Row = (row: { entry: ExecutionState }) => (
    <RunRow
      entry={row.entry}
      name={executionStatusLabel(row.entry.status)}
      workflow={props.owner.title}
      statusInNote={false}
      all={props.executions}
      cancelling={cancelling(row.entry)}
      onCancel={() => props.onCancel?.(row.entry.ref)}
      onOpen={() => { close(); props.onOpenExecution(row.entry.ref) }}
      testId="workflow-queue-entry"
      nodeTitle={props.nodeTitle}
      thumbnail={props.thumbnail?.(row.entry)}
    />
  )

  return (
    <div
      ref={root}
      class="workflow-queue-control"
      data-testid="workflow-queue-control"
      data-owner={props.owner.id}
    >
      <div class="workflow-queue-buttons">
        {runControl()}
        <Show when={!props.hideRunList}>
        <button
          ref={toggle}
          type="button"
          class="workflow-queue-toggle"
          data-testid="workflow-queue-toggle"
          aria-label={`${summary()}: ${open() ? 'Hide' : 'Show'} runs for ${props.owner.title}`}
          // The summary tooltip would cover the open list's first row, which says the same.
          data-tooltip-label={open() ? undefined : summary()}
          data-running={activity().running > 0}
          aria-expanded={open()}
          aria-controls={popoverId}
          onClick={() => setOpen((value) => !value)}
          onKeyDown={(event) => {
            if (!open() && event.key === 'ArrowDown') {
              event.preventDefault()
              show(true)
            } else if (open() && event.key === 'Escape') {
              event.preventDefault()
              close(true)
            }
          }}
        >
          <span data-testid="workflow-queue-summary" class="dinkster-visually-hidden" aria-live="polite">{summary()}</span>
          <Show when={activity().running > 0 || activity().waiting > 0} fallback={<Icon icon={List} />}>
            <ProductRunActivity running={activity().running} waiting={activity().waiting} label={summary()} />
          </Show>
        </button>
        <Show when={props.onCancel ? runningEntry() : undefined}>
          {(entry) => (
            <span class="workflow-queue-cancel">
              <ProductCancelButton
                label={message('runs.cancel.named', { name: props.owner.title })}
                data-testid="workflow-cancel"
                pending={cancelling(entry())}
                onClick={() => props.onCancel?.(entry().ref)}
              />
            </span>
          )}
        </Show>
        </Show>
        <Show when={progress()}>
          {(current) => (
            <RunProgress class="workflow-queue-line" testId="workflow-progress" progress={current()}
              label={`${props.owner.title} workflow progress`} nodeLabel={`${props.owner.title} node progress`} />
          )}
        </Show>
      </div>
      <Show when={open() && !props.hideRunList}>
        <section
          id={popoverId}
          class="workflow-queue-popover"
          role="region"
          aria-label={`Queue for ${props.owner.title}`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              close(true)
            }
          }}
        >
          <header><span class="workflow-queue-heading-name">{props.owner.title}</span><span>{summary()}</span></header>
          <Show when={props.executions.length > 0} fallback={<ProductEmptyState title="No jobs for this workflow." />}>
            <div
              ref={list}
              class="workflow-queue-list"
              onKeyDown={(event) => {
                const entries = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.execution-open:not(:disabled)')]
                const current = entries.indexOf(document.activeElement as HTMLButtonElement)
                let next: number | undefined
                if (event.key === 'Home') next = 0
                else if (event.key === 'End') next = entries.length - 1
                else if (event.key === 'ArrowDown') next = Math.min(entries.length - 1, current + 1)
                else if (event.key === 'ArrowUp') next = Math.max(0, current - 1)
                if (next === undefined || entries[next] === undefined) return
                event.preventDefault()
                entries[next]!.focus()
              }}
            >
              <Show when={rows().pending.length > 0}>
                <div class="run-rows dinkster-list-rows" role="list" aria-label="Workflow jobs">
                  <For each={rows().pending}>{(entry) => <Row entry={entry} />}</For>
                </div>
              </Show>
              <Show when={rows().finished.length > 0}>
                <RunSection title={message('runs.section.finished')}>
                  <For each={rows().finished}>{(entry) => <Row entry={entry} />}</For>
                </RunSection>
              </Show>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  )
}
