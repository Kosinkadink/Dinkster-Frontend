import { For, Show, createSignal as createSolidSignal, createUniqueId, onCleanup, onMount } from 'solid-js'
import type { ExecutionState } from '@dinkster/client'
import type { ExecutionRef, LineageId } from '@dinkster/core'
import Play from 'lucide-solid/icons/play'
import { ExecutionActivityCard, executionProgress } from './ExecutionActivityCard.js'
import { Icon } from './Icon.js'

export interface WorkflowQueueOwner {
  readonly id: string
  readonly title: string
  readonly lineage: LineageId
}

export function WorkflowQueueControl(props: {
  readonly owner: WorkflowQueueOwner
  readonly executions: readonly ExecutionState[]
  readonly canQueue: boolean
  readonly onQueue: () => void
  readonly onOpenExecution: (ref: ExecutionRef) => void
}) {
  const [open, setOpen] = createSolidSignal(false)
  const popoverId = `workflow-queue-popover-${createUniqueId()}`
  let root!: HTMLDivElement
  let toggle!: HTMLButtonElement
  let list!: HTMLDivElement

  const progress = () => {
    const active = props.executions.find((entry) => entry.status === 'running')
    return active === undefined ? undefined : executionProgress(active)
  }

  const summary = (): string => {
    const queued = props.executions.filter((entry) => entry.status === 'queued').length
    const running = props.executions.filter((entry) => entry.status === 'running').length
    const active = [
      ...(queued > 0 ? [`${queued} queued`] : []),
      ...(running > 0 ? [`${running} running`] : []),
    ]
    if (active.length > 0) return active.join(', ')
    return props.executions.length > 0 ? `${props.executions.length} recent` : 'No jobs'
  }

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

  return (
    <div
      ref={root}
      class="workflow-queue-control"
      data-testid="workflow-queue-control"
      data-owner={props.owner.id}
    >
      <div class="workflow-queue-buttons">
        <button
          type="button"
          class="workflow-queue-submit"
          data-testid="queue-button"
          aria-label={`Queue ${props.owner.title}`}
          data-tooltip-label="Queue workflow"
          data-tooltip-detail="Ctrl+Enter"
          disabled={!props.canQueue}
          onClick={props.onQueue}
        >
          <Icon icon={Play} /> Queue
        </button>
        <button
          ref={toggle}
          type="button"
          class="workflow-queue-toggle"
          data-testid="workflow-queue-toggle"
          aria-label={`${open() ? 'Hide' : 'Show'} queue for ${props.owner.title}`}
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
          <span data-testid="workflow-queue-summary" aria-live="polite">{summary()}</span>
          <span class="workflow-queue-caret" aria-hidden="true" />
        </button>
      </div>
      <Show when={progress()}>
        {(current) => (
          <label class="workflow-queue-progress" data-testid="workflow-progress">
            <span>Workflow {Math.round(current().value * 100)}%</span>
            <progress
              max="1"
              value={current().value}
              aria-label={`${props.owner.title} workflow progress`}
            />
            <span>{current().finished} of {current().total} nodes</span>
          </label>
        )}
      </Show>
      <Show when={open()}>
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
          <header>
            <strong>{props.owner.title}</strong>
            <span>{summary()}</span>
          </header>
          <Show when={props.executions.length > 0} fallback={<p class="workflow-queue-empty">No jobs for this workflow.</p>}>
            <div
              ref={list}
              class="workflow-queue-list"
              role="list"
              aria-label="Workflow jobs"
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
              <For each={props.executions}>
                {(entry) => (
                  <ExecutionActivityCard
                    entry={entry}
                    title={props.owner.title}
                    testId="workflow-queue-entry"
                    compact
                    onOpen={() => props.onOpenExecution(entry.ref)}
                  />
                )}
              </For>
            </div>
          </Show>
        </section>
      </Show>
    </div>
  )
}
