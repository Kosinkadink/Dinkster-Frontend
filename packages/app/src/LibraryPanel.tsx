import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'
import type { ConnectionStatus } from '@dinkster/client'
import type { CollectionEntry, CollectionSource, MessageParams } from '@dinkster/core'
import { CollectionPanel, type CollectionPanelState } from './CollectionPanel.js'
import { initialsOf } from './collections.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { SearchState } from './SearchSurface.js'

const DIRECT_LIBRARY_SOURCES = new Set(['packs', 'templates', 'workflows'])
const ACTIVITY_SOURCES = new Set(['history', 'runs'])
type LibraryMessage = (key: string, params?: MessageParams) => string

interface LibraryBackendContext {
  readonly label: string
  readonly protocol: 'dinkster' | 'v1'
  readonly status: ConnectionStatus
}

export interface LibraryPanelProps {
  readonly sources: readonly CollectionSource[]
  readonly backend: () => LibraryBackendContext
  readonly refreshTick?: () => number
  readonly onActivate?: (sourceId: string, entry: CollectionEntry) => void
  readonly onAction?: (sourceId: string, entry: CollectionEntry, actionId: string) => void
  readonly sourceActions?: readonly { sourceId: string; id: string; label: string }[]
  readonly onSourceAction?: (sourceId: string, actionId: string, owner?: string) => void
}

function LibrarySourceControl(props: {
  readonly sources: readonly CollectionSource[]
  readonly selectedId: () => string
  readonly select: (id: string) => void
  readonly message: LibraryMessage
}) {
  let controls: HTMLDivElement | undefined
  const selectAt = (index: number): void => {
    const source = props.sources[index]
    if (source === undefined) return
    props.select(source.id)
    queueMicrotask(() => controls?.querySelectorAll<HTMLButtonElement>('[data-testid="collection-source"]')[index]?.focus())
  }
  const move = (event: KeyboardEvent, index: number): void => {
    let next: number | undefined
    if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = props.sources.length - 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + props.sources.length) % props.sources.length
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % props.sources.length
    if (next === undefined) return
    event.preventDefault()
    selectAt(next)
  }
  return (
    <>
      <div class="library-source-tabs" role="group" aria-label={props.message('library.source.collections')} ref={controls}>
        <For each={props.sources}>
          {(source, index) => (
            <button
              type="button"
              class="library-source"
              data-testid="collection-source"
              data-source={source.id}
              data-family={DIRECT_LIBRARY_SOURCES.has(source.id) ? 'library' : 'activity'}
              aria-pressed={source.id === props.selectedId()}
              tabindex={source.id === props.selectedId() ? '0' : '-1'}
              onClick={() => props.select(source.id)}
              onKeyDown={(event) => move(event, index())}
            >
              {source.label}
            </button>
          )}
        </For>
      </div>
      <ProductSelect
        class="library-source-select"
        testId="library-source-select"
        ariaLabel={props.message('library.source.collection')}
        selectedId={props.selectedId()}
        options={props.sources.map((source) => ({ id: source.id, label: source.label, value: source.id }))}
        onSelect={(option) => props.select(option.value)}
      />
    </>
  )
}

function LibraryDetailRail(props: {
  readonly entry: CollectionEntry | undefined
  readonly sourceId: string
  readonly message: LibraryMessage
  readonly onAction?: (sourceId: string, entry: CollectionEntry, actionId: string) => void
}) {
  const [armedDelete, setArmedDelete] = createSignal(false)
  let rail: HTMLElement | undefined
  let armTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => { if (armTimer !== undefined) clearTimeout(armTimer) })
  createEffect(() => {
    const selection = `${props.sourceId}:${props.entry?.id ?? ''}`
    if (armTimer !== undefined) clearTimeout(armTimer)
    armTimer = undefined
    setArmedDelete(false)
    queueMicrotask(() => {
      if (`${props.sourceId}:${props.entry?.id ?? ''}` === selection && rail !== undefined) rail.scrollTop = 0
    })
  })
  const runAction = (entry: CollectionEntry, actionId: string): void => {
    if (actionId === 'delete' && !armedDelete()) {
      setArmedDelete(true)
      if (armTimer !== undefined) clearTimeout(armTimer)
      armTimer = setTimeout(() => setArmedDelete(false), 4000)
      return
    }
    if (armTimer !== undefined) clearTimeout(armTimer)
    armTimer = undefined
    setArmedDelete(false)
    props.onAction?.(props.sourceId, entry, actionId)
  }
  return (
    <aside
      class="library-detail-rail"
      data-testid="library-detail-rail"
      aria-label={props.message('library.detail.selected')}
      ref={(element) => { rail = element }}
    >
      <Show
        when={props.entry}
        keyed
        fallback={<div class="library-detail-empty"><strong>{props.message('library.detail.empty.title')}</strong><span>{props.message('library.detail.empty.description')}</span></div>}
      >
        {(entry) => (
          <>
            <header class="library-detail-header">
              <span class="library-detail-initials" aria-hidden="true">{initialsOf(entry.title)}</span>
              <span>
                <strong>{entry.title}</strong>
                <Show when={entry.subtitle}>{(subtitle) => <small>{subtitle()}</small>}</Show>
              </span>
            </header>
            <Show when={(entry.badges ?? []).length > 0}>
              <div class="library-detail-badges" aria-label={props.message('library.detail.attributes')}>
                <For each={entry.badges}>{(badge) => <span>{badge}</span>}</For>
              </div>
            </Show>
            <Show when={(entry.details ?? []).length > 0}>
              <dl class="library-detail-facts">
                <For each={entry.details}>
                  {(detail) => <><dt>{detail.label}</dt><dd>{detail.text}</dd></>}
                </For>
              </dl>
            </Show>
            <Show when={(entry.actions ?? []).length > 0}>
              <div class="library-detail-actions">
                <For each={entry.actions}>
                  {(action) => (
                    <button
                      type="button"
                      data-testid="library-detail-action"
                      data-action={action.id}
                      data-tone={action.id === 'delete' ? 'danger' : 'accent'}
                      aria-pressed={action.id === 'delete' ? armedDelete() : undefined}
                      onClick={() => runAction(entry, action.id)}
                    >
                      {action.id === 'delete' && armedDelete() ? props.message('library.action.confirmDelete') : action.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </aside>
  )
}

function DirectLibraryState(props: { readonly state: CollectionPanelState; readonly backend: LibraryBackendContext; readonly message: LibraryMessage }) {
  const source = () => props.state.sourceLabel.toLocaleLowerCase()
  if (props.state.kind === 'loading') {
    return <div role="status"><SearchState kind="loading" title={props.message('library.state.loading.title', { source: source() })} detail={props.message('library.state.loading.directDetail', { source: props.state.sourceLabel, backend: props.backend.label })} /></div>
  }
  if (props.state.kind === 'error') {
    return <div role="alert"><SearchState kind="error" title={props.message('library.state.unavailable.title', { source: props.state.sourceLabel })} detail={props.state.message ?? props.message('library.state.unavailable.directDetail', { source: props.state.sourceLabel, backend: props.backend.label })} /></div>
  }
  if (props.state.kind === 'no-match') {
    return <SearchState kind="empty" title={props.message('library.state.noMatch.title', { source: source() })} detail={props.message('library.state.noMatch.directDetail')} />
  }
  if (props.state.kind === 'no-compatible') {
    return <SearchState kind="empty" title={props.message('library.state.noCompatible.title')} detail={props.message('library.state.noCompatible.detail')} />
  }
  if (props.state.sourceLabel === 'Packs') {
    return <SearchState kind="empty" title={props.message('library.state.noPacks.title')} detail={props.message('library.state.noPacks.detail', { backend: props.backend.label })} />
  }
  if (props.state.sourceLabel === 'Templates') {
    return <SearchState kind="empty" title={props.message('library.state.noTemplates.title')} detail={props.message('library.state.noTemplates.detail', { backend: props.backend.label })} />
  }
  if (props.backend.protocol === 'v1') {
    return <SearchState kind="empty" title={props.message('library.state.savedWorkflowsUnavailable.title')} detail={props.message('library.state.savedWorkflowsUnavailable.detail')} />
  }
  return <SearchState kind="empty" title={props.message('library.state.noSavedWorkflows.title')} detail={props.message('library.state.noSavedWorkflows.detail', { backend: props.backend.label })} />
}

function ActivityState(props: { readonly state: CollectionPanelState; readonly backend: LibraryBackendContext; readonly message: LibraryMessage }) {
  const durable = props.state.sourceLabel === 'Runs'
  const noun = () => props.message(durable ? 'library.activity.durableRuns' : 'library.activity.localSnapshots')
  if (props.state.kind === 'loading') {
    return <div role="status"><SearchState kind="loading" title={props.message('library.state.loading.title', { source: noun() })} detail={durable ? props.message('library.state.loading.runsDetail', { backend: props.backend.label }) : props.message('library.state.loading.historyDetail')} /></div>
  }
  if (props.state.kind === 'error') {
    return <div role="alert"><SearchState kind="error" title={props.message('library.state.unavailable.title', { source: props.state.sourceLabel })} detail={props.state.message ?? props.message('library.state.unavailable.activityDetail', { source: noun() })} /></div>
  }
  if (props.state.kind === 'no-match') {
    return <SearchState kind="empty" title={props.message('library.state.noMatch.title', { source: noun() })} detail={props.message(durable ? 'library.state.noMatch.runsDetail' : 'library.state.noMatch.historyDetail')} />
  }
  if (durable && props.backend.protocol === 'v1') {
    return <SearchState kind="empty" title={props.message('library.state.durableRunsUnavailable.title')} detail={props.message('library.state.durableRunsUnavailable.detail')} />
  }
  return <SearchState kind="empty" title={props.message('library.state.none.title', { source: noun() })} detail={durable ? props.message('library.state.noRuns.detail', { backend: props.backend.label }) : props.message('library.state.noSnapshots.detail')} />
}

function inheritedState(state: CollectionPanelState, message: LibraryMessage) {
  return <p class="empty">
    {state.kind === 'loading'
      ? message('library.inherited.loading')
      : state.kind === 'error'
        ? state.message
        : state.kind === 'no-match'
          ? message('library.inherited.noMatches')
          : state.kind === 'no-compatible'
            ? message('library.inherited.noCompatible')
            : message('library.inherited.empty')}
  </p>
}

export function LibraryPanel(props: LibraryPanelProps) {
  const message = useAppMessage()
  const [sourceId, setSourceId] = createSignal(props.sources[0]?.id ?? '')
  const [transitionSourceId, setTransitionSourceId] = createSignal<string>()
  const transitionId = createUniqueId()
  const transitionResultsId = `library-transition-results-${transitionId}`
  const transitionDescriptionId = `library-transition-description-${transitionId}`
  const sourceHasItems = new Map<string, boolean>()
  const settleTimers = new Set<ReturnType<typeof setTimeout>>()
  let panelRoot: HTMLDivElement | undefined
  let displayedSourceId: string | undefined
  let requestSequence = 0
  let latestFirstPageRequest = 0
  const afterCollectionSettles = (action: () => void): void => {
    const timer = setTimeout(() => {
      settleTimers.delete(timer)
      action()
    }, 0)
    settleTimers.add(timer)
  }
  const settleFirstPage = (settledSourceId: string, requestId: number, hasItems: boolean, aborted: boolean): void => {
    if (requestId !== latestFirstPageRequest || aborted) return
    sourceHasItems.set(settledSourceId, hasItems)
    afterCollectionSettles(() => {
      if (sourceId() !== settledSourceId || requestId !== latestFirstPageRequest) return
      displayedSourceId = settledSourceId
      if (transitionSourceId() === settledSourceId) setTransitionSourceId(undefined)
    })
  }
  const panelSources = props.sources.map((source): CollectionSource => ({
    ...source,
    page: async (request) => {
      const requestId = ++requestSequence
      if (request.cursor === undefined) latestFirstPageRequest = requestId
      try {
        const page = await source.page(request)
        if (request.cursor === undefined) settleFirstPage(source.id, requestId, page.items.length > 0, request.signal?.aborted === true)
        return page
      } catch (error) {
        if (request.cursor === undefined) settleFirstPage(source.id, requestId, false, request.signal?.aborted === true)
        throw error
      }
    },
  }))
  const sourceLabel = () => props.sources.find((source) => source.id === sourceId())?.label ?? 'library'
  const directSource = () => DIRECT_LIBRARY_SOURCES.has(sourceId())
  const activitySource = () => ACTIVITY_SOURCES.has(sourceId())
  const transitioning = () => transitionSourceId() === sourceId()
  const transitionState = (): CollectionPanelState => ({ kind: 'loading', query: '', sourceLabel: sourceLabel() })
  const selectSource = (id: string, select: (id: string) => void): void => {
    if (id !== sourceId()) {
      const displayed = displayedSourceId ?? sourceId()
      setTransitionSourceId(sourceHasItems.get(displayed) === true ? id : undefined)
      setSourceId(id)
    }
    select(id)
  }
  createEffect(() => {
    if (!transitioning()) return
    const search = panelRoot?.querySelector<HTMLInputElement>('.collection-search-field input[role="combobox"]')
    if (search === undefined || search === null) return
    const previousControls = search.getAttribute('aria-controls')
    const previousDescription = search.getAttribute('aria-describedby')
    const previousResults = previousControls === null ? null : document.getElementById(previousControls)
    const previousResultsHidden = previousResults?.getAttribute('aria-hidden') ?? null

    search.setAttribute('aria-controls', transitionResultsId)
    search.setAttribute('aria-describedby', transitionDescriptionId)
    search.removeAttribute('aria-activedescendant')
    if (previousResults !== null && panelRoot?.contains(previousResults) === true) previousResults.setAttribute('aria-hidden', 'true')

    onCleanup(() => {
      if (search.getAttribute('aria-controls') === transitionResultsId) {
        if (previousControls === null) search.removeAttribute('aria-controls')
        else search.setAttribute('aria-controls', previousControls)
      }
      if (search.getAttribute('aria-describedby') === transitionDescriptionId) {
        if (previousDescription === null) search.removeAttribute('aria-describedby')
        else search.setAttribute('aria-describedby', previousDescription)
      }
      if (previousResults !== null && panelRoot?.contains(previousResults) === true) {
        if (previousResultsHidden === null) previousResults.removeAttribute('aria-hidden')
        else previousResults.setAttribute('aria-hidden', previousResultsHidden)
      }
    })
  })
  onCleanup(() => {
    for (const timer of settleTimers) clearTimeout(timer)
  })
  return (
    <div
      class="library-panel"
      data-testid="library-overlay"
      data-source={sourceId()}
      data-source-loading={transitioning() ? 'true' : undefined}
      aria-busy={transitioning()}
      ref={(element) => { panelRoot = element }}
    >
      <div class="library-backend-context" data-status={props.backend().status}>
        <span>{message('library.backend')}</span>
        <strong>{props.backend().label}</strong>
        <span role="status">{props.backend().protocol === 'dinkster' ? 'Dinkster' : 'ComfyUI'} - {props.backend().status}</span>
      </div>
      <CollectionPanel
        sources={panelSources}
        sourceRail={({ selectedId, select }) => <LibrarySourceControl
          sources={props.sources}
          selectedId={selectedId}
          select={(id) => selectSource(id, select)}
          message={message}
        />}
        modeKey="dinkster.library.view.v1"
        searchLabel={message('library.search', { source: sourceLabel().toLocaleLowerCase() })}
        searchPlaceholder={message('library.search', { source: sourceLabel().toLocaleLowerCase() })}
        renderState={(state) => directSource()
          ? <DirectLibraryState state={state} backend={props.backend()} message={message} />
          : activitySource()
            ? <ActivityState state={state} backend={props.backend()} message={message} />
            : inheritedState(state, message)}
        detailRail={(entry) => transitioning()
          ? <div class="library-source-transition" data-testid="library-source-transition">
              <div
                id={transitionResultsId}
                class="library-source-transition-results"
                role="listbox"
                aria-label={message('library.results', { source: sourceLabel() })}
                aria-busy="true"
              />
              <div id={transitionDescriptionId} class="library-source-transition-description">
                {directSource()
                  ? <DirectLibraryState state={transitionState()} backend={props.backend()} message={message} />
                  : activitySource()
                    ? <ActivityState state={transitionState()} backend={props.backend()} message={message} />
                  : <div role="status">{inheritedState(transitionState(), message)}</div>}
              </div>
            </div>
          : directSource() || activitySource()
            ? <LibraryDetailRail
                entry={entry}
                sourceId={sourceId()}
                message={message}
                {...(props.onAction ? { onAction: props.onAction } : {})}
              />
            : undefined}
        {...(props.refreshTick ? { refreshTick: props.refreshTick } : {})}
        {...(props.onActivate ? { onActivate: props.onActivate } : {})}
        {...(props.onAction ? { onAction: props.onAction } : {})}
        {...(props.sourceActions ? { sourceActions: props.sourceActions } : {})}
        {...(props.onSourceAction ? { onSourceAction: props.onSourceAction } : {})}
      />
    </div>
  )
}
