import { createEffect, For, onCleanup, onMount, Show } from 'solid-js'
import type { AppLogEntry } from './app-state.js'
import { useAppMessage } from './locale.js'
import { ProductEmptyState, ProductListRow } from './ProductSurfaces.js'

export interface ActivityLogProps {
  readonly entries: () => readonly AppLogEntry[]
  readonly clearArmed: () => boolean
}

export function formatActivityTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().replace('T', ' ').replace('Z', ' UTC')
}

export function ActivityLog(props: ActivityLogProps) {
  const message = useAppMessage()
  let list: HTMLDivElement | undefined
  let followsTail = true
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
      followsTail = list.scrollHeight - list.scrollTop - list.clientHeight <= 8
    }
    rememberGeometry()
  }

  const followTail = (): void => {
    if (list && followsTail) list.scrollTop = list.scrollHeight
    rememberGeometry()
  }

  onMount(() => {
    rememberGeometry()
    const observer = new ResizeObserver(() => queueMicrotask(followTail))
    if (list) observer.observe(list)
    onCleanup(() => observer.disconnect())
  })

  createEffect(() => {
    const entryCount = props.entries().length
    queueMicrotask(() => {
      if (!list) return
      if (entryCount === 0) {
        followsTail = true
        list.scrollTop = 0
      } else followTail()
    })
  })

  return (
    <section class="activity-log" data-testid="logs-panel" aria-label={message('activityLog.aria.contents')}>
      <Show when={props.clearArmed()}>
        <p class="activity-log-clear-status" role="status" aria-live="polite">
          {message('activityLog.clearArmed', { count: props.entries().length })}
        </p>
      </Show>
      <div
        class="activity-log-list"
        data-testid="activity-log-list"
        ref={list}
        role="log"
        aria-label={message('activityLog.aria.events')}
        aria-live="polite"
        aria-relevant="additions"
        tabindex="0"
        onScroll={updateTailPreference}
      >
        <Show
          when={props.entries().length > 0}
          fallback={<ProductEmptyState class="activity-log-empty" testId="activity-log-empty" title={message('activityLog.empty.title')} hint={message('activityLog.empty.description')} />}
        >
          <For each={props.entries()}>
            {(entry) => {
              const timestamp = formatActivityTimestamp(entry.timestamp)
              return (
                <ProductListRow
                  class="activity-log-row"
                  dataAttributes={{ 'data-severity': entry.severity }}
                  primary={<>
                    <time class="activity-log-time" datetime={new Date(entry.timestamp).toISOString()}>{timestamp}</time>
                    <span class="activity-log-severity">{entry.severity}</span>
                    <span class="activity-log-source">{entry.source}</span>
                    <span class="activity-log-message">{entry.message}</span>
                  </>}
                />
              )
            }}
          </For>
        </Show>
      </div>
    </section>
  )
}
