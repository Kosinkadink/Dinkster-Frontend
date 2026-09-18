/**
 * Execution log panel: the per-run structured log feed (Dinkster node_event/log
 * records plus the run's error diagnostics), separate from the app Activity
 * panel. Error rows are a VIEW over ExecutionState.errors - the same job
 * error report that drives node error badges - never a second error channel
 * (Dinkster issue #368).
 */
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { activeLocale } from '@dinkster/core'
import type { ExecutionLogEntry, ExecutionState } from '@dinkster/client'
import { formatActivityTimestamp } from './ActivityLog.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'

export type ExecutionLogRowLevel = 'info' | 'warning' | 'error'

/** One display row: a log record or a diagnostic projected into the feed. */
export interface ExecutionLogRow {
  readonly level: ExecutionLogRowLevel
  readonly message: string
  readonly timestamp: number
  readonly runtimeNodeId?: string
  readonly origin?: ExecutionLogEntry['origin']
  /** 'log' = wire log record; 'diagnostic' = run error report entry. */
  readonly source: 'log' | 'diagnostic'
}

/**
 * Project one execution's feed: its log buffer merged chronologically with
 * its error diagnostics. Diagnostics carry no own timestamp; they are
 * recorded when the run ends, so endedAt orders them truthfully.
 */
export function executionLogRows(execution: ExecutionState): readonly ExecutionLogRow[] {
  const logs: ExecutionLogRow[] = execution.logs.map((entry) => ({
    level: entry.level,
    message: entry.message,
    timestamp: entry.timestamp,
    ...(entry.runtimeNodeId !== undefined ? { runtimeNodeId: entry.runtimeNodeId } : {}),
    ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    source: 'log' as const,
  }))
  const diagnostics: ExecutionLogRow[] = execution.errors.map((diagnostic) => {
    const runtimeId = diagnostic.data?.['runtimeId']
    return {
      level: diagnostic.severity,
      message: diagnostic.message,
      timestamp: execution.endedAt ?? execution.queuedAt,
      ...(typeof runtimeId === 'string' ? { runtimeNodeId: runtimeId } : {}),
      source: 'diagnostic' as const,
    }
  })
  // Stable sort: rows sharing a timestamp keep log-before-diagnostic order.
  return [...logs, ...diagnostics].sort((a, b) => a.timestamp - b.timestamp)
}

export interface ExecutionLogPanelProps {
  /** Selectable runs for the active workflow, as the queue rail lists them. */
  readonly executions: () => readonly ExecutionState[]
  /** The run the active tab currently shows; the default selection follows it. */
  readonly active: () => ExecutionState | undefined
  /** Display title for a runtime node id (falls back to the raw id). */
  readonly nodeTitle: (execution: ExecutionState, runtimeNodeId: string) => string
  /** Focus/center the node on canvas. */
  readonly onFocusNode?: (execution: ExecutionState, runtimeNodeId: string) => void
  /**
   * External ask to show one scene node's rows, as the set of runtime ids
   * attributed to it; the token distinguishes repeats.
   */
  readonly filterRequest?: () => { readonly runtimeNodeIds: readonly string[]; readonly token: number } | undefined
  /** Acknowledge an applied filter request so it is never replayed. */
  readonly onFilterApplied?: (token: number) => void
}

const LEVELS: readonly ExecutionLogRowLevel[] = ['info', 'warning', 'error']

export function ExecutionLogPanel(props: ExecutionLogPanelProps) {
  const message = useAppMessage()
  const locale = useSignal(activeLocale)
  // '' = follow the active tab's run; a key pins one specific run.
  const [selectedKey, setSelectedKey] = createSignal('')
  const [hiddenLevels, setHiddenLevels] = createSignal<ReadonlySet<ExecutionLogRowLevel>>(new Set())
  // '' = all nodes; a runtime node id filters to that node's rows.
  const [nodeFilter, setNodeFilter] = createSignal('')
  // Badge-driven grouped filter: one scene node's runtime occurrences. Any
  // manual node selection clears it.
  const [groupFilter, setGroupFilter] = createSignal<ReadonlySet<string> | undefined>(undefined)

  const execution = (): ExecutionState | undefined => {
    const key = selectedKey()
    if (key === '') return props.active()
    return props.executions().find((entry) => entry.key === key) ?? props.active()
  }

  const rows = createMemo((): readonly ExecutionLogRow[] => {
    const entry = execution()
    return entry === undefined ? [] : executionLogRows(entry)
  })

  const nodeIds = createMemo((): readonly string[] => {
    const seen = new Set<string>()
    for (const row of rows()) if (row.runtimeNodeId !== undefined) seen.add(row.runtimeNodeId)
    return [...seen]
  })

  const visibleRows = createMemo((): readonly ExecutionLogRow[] => {
    const hidden = hiddenLevels()
    const group = groupFilter()
    const node = nodeFilter()
    return rows().filter((row) =>
      !hidden.has(row.level) && (group !== undefined
        ? row.runtimeNodeId !== undefined && group.has(row.runtimeNodeId)
        : node === '' || row.runtimeNodeId === node))
  })

  const toggleLevel = (level: ExecutionLogRowLevel): void => {
    setHiddenLevels((current) => {
      const next = new Set(current)
      if (next.has(level)) next.delete(level)
      else next.add(level)
      return next
    })
  }

  // Tail follow: pinned to the newest row unless the user scrolls up.
  let list: HTMLDivElement | undefined
  const [followsTail, setFollowsTail] = createSignal(true)
  let lastScrollHeight = 0
  let lastClientHeight = 0

  const rememberGeometry = (): void => {
    if (!list) return
    lastScrollHeight = list.scrollHeight
    lastClientHeight = list.clientHeight
  }

  const updateTailPreference = (): void => {
    if (!list) return
    const geometryChanged = list.scrollHeight !== lastScrollHeight || list.clientHeight !== lastClientHeight
    if (!geometryChanged) {
      setFollowsTail(list.scrollHeight - list.scrollTop - list.clientHeight <= 8)
    }
    rememberGeometry()
  }

  const followTail = (): void => {
    if (list && followsTail()) list.scrollTop = list.scrollHeight
    rememberGeometry()
  }

  const jumpToTail = (): void => {
    setFollowsTail(true)
    if (list) list.scrollTop = list.scrollHeight
    rememberGeometry()
  }

  onMount(() => {
    rememberGeometry()
    const observer = new ResizeObserver(() => queueMicrotask(followTail))
    if (list) observer.observe(list)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const rowCount = visibleRows().length
    queueMicrotask(() => {
      if (!list) return
      if (rowCount === 0) {
        setFollowsTail(true)
        list.scrollTop = 0
      } else followTail()
    })
  })

  // A pinned run that disappears (cleared history) falls back to following.
  createEffect(() => {
    const key = selectedKey()
    if (key !== '' && !props.executions().some((entry) => entry.key === key)) setSelectedKey('')
  })

  // A badge's "Open in Execution log" targets the active run's node rows.
  // A single-occurrence node lands in the ordinary node select; several
  // occurrences become the grouped filter.
  let appliedFilterToken: number | undefined
  createEffect(() => {
    const request = props.filterRequest?.()
    if (request === undefined || request.token === appliedFilterToken) return
    appliedFilterToken = request.token
    setSelectedKey('')
    if (request.runtimeNodeIds.length === 1) {
      setGroupFilter(undefined)
      setNodeFilter(request.runtimeNodeIds[0]!)
    } else {
      setNodeFilter('')
      setGroupFilter(new Set(request.runtimeNodeIds))
    }
    props.onFilterApplied?.(request.token)
  })

  const runLabel = (entry: ExecutionState): string => message('executionLog.run.label', {
    prompt: entry.ref.prompt,
    status: message(`executionLog.status.${entry.status}`),
  })

  const nodeButton = (row: ExecutionLogRow) => {
    const entry = execution()
    if (row.runtimeNodeId === undefined || entry === undefined) return <span class="execution-log-node-empty">-</span>
    const id = row.runtimeNodeId
    return (
      <button
        type="button"
        class="execution-log-node"
        data-testid="execution-log-node"
        title={message('executionLog.title.showNode', { id })}
        onClick={() => props.onFocusNode?.(entry, id)}
      >
        {props.nodeTitle(entry, id)}
      </button>
    )
  }

  return (
    <section class="execution-log" data-testid="execution-log-panel" aria-label={message('executionLog.aria.contents')}>
      <div class="execution-log-controls">
        <label class="execution-log-run">
          <span>{message('executionLog.field.run')}</span>
          <select
            data-testid="execution-log-run-select"
            value={selectedKey()}
            onChange={(event) => setSelectedKey(event.currentTarget.value)}
          >
            <option value="">{message('executionLog.option.current')}</option>
            <For each={props.executions()}>
              {(entry) => <option value={entry.key}>{locale().tag && runLabel(entry)}</option>}
            </For>
          </select>
        </label>
        <label class="execution-log-node-filter">
          <span>{message('executionLog.field.node')}</span>
          <select
            data-testid="execution-log-node-select"
            onChange={(event) => {
              // Read before any set: clearing the grouped filter re-runs the
              // selection binding, which resets the select element itself.
              const option = event.currentTarget.options[event.currentTarget.selectedIndex]
              setGroupFilter(undefined)
              setNodeFilter(option?.dataset['groupFilter'] === 'true' ? '' : option?.value ?? '')
            }}
          >
            <Show when={groupFilter() !== undefined}>
              <option data-group-filter="true" selected>
                {message('executionLog.option.focusedNode', { count: groupFilter()!.size })}
              </option>
            </Show>
            <Show when={groupFilter() === undefined && nodeFilter() !== '' && !nodeIds().includes(nodeFilter())}>
              <option value={nodeFilter()} selected>{nodeFilter()}</option>
            </Show>
            <option value="" selected={groupFilter() === undefined && nodeFilter() === ''}>{message('executionLog.option.allNodes')}</option>
            <For each={nodeIds()}>
              {(id) => {
                const entry = execution()
                return <option value={id} selected={groupFilter() === undefined && nodeFilter() === id}>{entry === undefined ? id : props.nodeTitle(entry, id)}</option>
              }}
            </For>
          </select>
        </label>
        <div class="execution-log-levels" role="group" aria-label={message('executionLog.aria.levelFilters')}>
          <For each={LEVELS}>
            {(level) => (
              <button
                type="button"
                class="execution-log-level-toggle"
                data-level={level}
                data-testid={`execution-log-level-${level}`}
                aria-pressed={!hiddenLevels().has(level)}
                onClick={() => toggleLevel(level)}
              >
                {locale().tag && message(`executionLog.level.${level}`)}
              </button>
            )}
          </For>
        </div>
      </div>
      <div
        class="execution-log-list"
        data-testid="execution-log-list"
        ref={list}
        role="log"
        aria-label={message('executionLog.aria.records')}
        aria-live="polite"
        aria-relevant="additions"
        tabindex="0"
        onScroll={updateTailPreference}
      >
        <Show
          when={execution() !== undefined}
          fallback={(
            <div class="execution-log-empty" data-testid="execution-log-empty">
              <strong>{message('executionLog.empty.noExecution')}</strong>
              <span>{message('executionLog.description.noExecution')}</span>
            </div>
          )}
        >
          <Show when={(execution()?.logsDropped ?? 0) > 0}>
            <p class="execution-log-truncated" data-testid="execution-log-truncated" role="status">
              {message('executionLog.notice.discarded', { count: execution()!.logsDropped })}
            </p>
          </Show>
          <Show
            when={visibleRows().length > 0}
            fallback={(
              <div class="execution-log-empty" data-testid="execution-log-empty">
                <strong>{message('executionLog.empty.noRecords')}</strong>
                <span>{message('executionLog.description.noRecords')}</span>
              </div>
            )}
          >
            <For each={visibleRows()}>
              {(row) => (
                <div
                  class="execution-log-row"
                  data-testid="execution-log-row"
                  data-level={row.level}
                  data-source={row.source}
                  {...(row.origin !== undefined ? { 'data-origin': row.origin } : {})}
                >
                  <time class="execution-log-time" datetime={new Date(row.timestamp).toISOString()}>
                    {formatActivityTimestamp(row.timestamp)}
                  </time>
                  <span class="execution-log-level">{locale().tag && message(`executionLog.level.${row.level}`)}</span>
                  {nodeButton(row)}
                  <span class="execution-log-message">
                    <Show when={row.origin !== undefined}>
                      <span class="execution-log-origin">{row.origin}</span>
                    </Show>
                    {row.message}
                  </span>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
      <Show when={!followsTail() && visibleRows().length > 0}>
        <button
          type="button"
          class="execution-log-resume"
          data-testid="execution-log-resume"
          onClick={jumpToTail}
        >
          {message('executionLog.action.jumpLatest')}
        </button>
      </Show>
    </section>
  )
}
