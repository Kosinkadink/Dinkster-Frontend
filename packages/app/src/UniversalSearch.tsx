import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import { createSearchSession, decodeSearchHostAction, type SearchGroup, type SearchResult } from '@dinkster/core'
import Search from 'lucide-solid/icons/search'
import type { AppState } from './app-state.js'
import { Icon } from './Icon.js'
import { SearchInput, SearchResultGroup, SearchResultRow, SearchState } from './SearchSurface.js'
import { recordSearchRecent, runSearchAction, searchRecents } from './universal-search.js'

type VisibleSearchRow =
  | { readonly kind: 'result'; readonly group: SearchGroup; readonly item: SearchResult }
  | { readonly kind: 'expand'; readonly group: SearchGroup }

export function UniversalSearchTrigger(props: { readonly shortcut?: string | undefined; readonly onOpen: () => void }) {
  return (
    <button
      class="search-trigger"
      data-testid="topbar-search"
      aria-label={props.shortcut ? `Search Dinkster, ${props.shortcut}` : 'Search Dinkster'}
      onClick={props.onOpen}
    >
      <Icon icon={Search} />
      <span>Search Dinkster</span>
      <Show when={props.shortcut}>{(shortcut) => <kbd>{shortcut()}</kbd>}</Show>
    </button>
  )
}

export function UniversalSearch(props: { app: AppState }) {
  const [query, setQuery] = createSignal(''); const [groups, setGroups] = createSignal<readonly SearchGroup[]>([])
  const [selected, setSelected] = createSignal<string>(); const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  let input!: HTMLInputElement; let dialog!: HTMLDialogElement
  let results!: HTMLDivElement
  const instanceId = createUniqueId()
  const listboxId = `universal-search-results-${instanceId}`
  const statusId = `${listboxId}-status`
  const previewId = `${listboxId}-preview`
  const previewHeadingId = `${previewId}-heading`
  const previewContentId = `${previewId}-content`
  const visible = (): VisibleSearchRow[] => groups().flatMap((group) => {
    if (group.status !== 'ready') return []
    if (expanded().has(group.id)) return group.results.map((item) => ({ kind: 'result' as const, group, item }))
    return [
      ...group.results.slice(0, 5).map((item) => ({ kind: 'result' as const, group, item })),
      ...(group.results.length > 5 ? [{ kind: 'expand' as const, group }] : []),
    ]
  })
  const keyOf = (row: VisibleSearchRow): string => row.kind === 'result'
    ? `result:${row.group.id}:${row.item.id}`
    : `expand:${row.group.id}`
  const recentKeyOf = (row: Extract<VisibleSearchRow, { readonly kind: 'result' }>): string => `${row.group.id}:${row.item.id}`
  const selectedIndex = (): number => {
    const rows = visible()
    const found = rows.findIndex((row) => keyOf(row) === selected())
    return found < 0 && rows.length > 0 ? 0 : found
  }
  const optionId = (index: number): string => `${listboxId}-option-${index}`
  const activeDescendant = (): string | undefined => visible()[selectedIndex()] === undefined ? undefined : optionId(selectedIndex())
  const activeResult = (): Extract<VisibleSearchRow, { readonly kind: 'result' }> | undefined => {
    const row = visible()[selectedIndex()]
    return row?.kind === 'result' ? row : undefined
  }
  const pending = (): boolean => groups().some((group) => group.status === 'loading')
  const readyGroups = () => groups().filter((group) => group.status === 'ready' && group.results.length > 0)
  const providerStates = () => groups().filter((group) => group.status === 'loading' || group.status === 'error')
  const session = createSearchSession({
    registry: props.app.searchRegistry,
    context: () => {
      const tab = props.app.activeTab()
      return { ...(tab ? { activeTab: { id: tab.id, title: tab.title } } : {}), selection: { nodes: props.app.canvasBridge.get()?.selectedNodes() ?? [] } }
    },
    boost: (provider, item) => {
      const index = searchRecents(props.app.settings).indexOf(`${provider.id}:${item.id}`)
      return index < 0 ? 0 : Math.max(0.005, 0.05 - index * 0.005)
    },
    onReset: () => { setSelected(undefined); setExpanded(new Set<string>()) },
    onGroups: (next) => {
      setGroups(next)
      const keys = new Set(next.flatMap((group) => [
        ...group.results.map((item) => `result:${group.id}:${item.id}`),
        ...(group.status === 'ready' && group.results.length > 5 ? [`expand:${group.id}`] : []),
      ]))
      const first = next.find((group) => group.status === 'ready' && group.results.length > 0)
      setSelected((current) => current !== undefined && keys.has(current)
        ? current
        : first?.results[0] === undefined ? undefined : `result:${first.id}:${first.results[0].id}`)
    },
  })
  createEffect(() => session.query(query()))
  createEffect(() => {
    const id = activeDescendant()
    if (id === undefined) return
    queueMicrotask(() => results?.querySelector<HTMLElement>(`#${id}`)?.scrollIntoView?.({ block: 'nearest' }))
  })
  onMount(() => { dialog.showModal(); queueMicrotask(() => input.focus()) })
  onCleanup(() => { session.dispose(); dialog.close() })
  const activate = (index = selectedIndex()) => {
    const row = visible()[index]
    if (!row) return
    if (row.kind === 'expand') {
      const firstHidden = row.group.results[5]
      setExpanded(new Set([...expanded(), row.group.id]))
      if (firstHidden !== undefined) setSelected(keyOf({ kind: 'result', group: row.group, item: firstHidden }))
      return
    }
    const action = row.item.action.kind === 'host' ? decodeSearchHostAction(row.item.action) : row.item.action
    if (action === undefined) return
    const opensModal = action.kind === 'host'
      && (action.action === 'settings.open' || action.action === 'command.run')
    if (opensModal) {
      const command = action.action === 'command.run' ? props.app.commands.get(action.params.id) : undefined
      if (action.action === 'command.run' && (!command || command.enabled?.() === false)) return
      recordSearchRecent(props.app.settings, recentKeyOf(row))
      // Unmount/close this native dialog first so it restores focus to the
      // persistent search trigger. The next modal then records that trigger
      // as its own restoration target instead of this disappearing input.
      props.app.searchOpen.set(false)
      queueMicrotask(() => runSearchAction(props.app, action))
      return
    }
    if (!runSearchAction(props.app, action)) return
    recordSearchRecent(props.app.settings, recentKeyOf(row))
    props.app.searchOpen.set(false)
  }
  const announcement = (): string => {
    const rows = visible()
    const active = rows[selectedIndex()]
    const resultCount = groups().reduce((sum, group) => sum + group.results.length, 0)
    const failures = groups().filter((group) => group.status === 'error').length
    if (active !== undefined) {
      const providerStatus = pending()
        ? ' Searching providers.'
        : failures > 0
          ? ` ${failures} ${failures === 1 ? 'provider is' : 'providers are'} unavailable.`
          : ''
      const activeLabel = active.kind === 'result'
        ? active.item.title
        : `Show ${active.group.results.length - 5} more ${active.group.label} results`
      const previewStatus = active.kind === 'result' && active.item.preview !== undefined ? ' Preview available.' : ''
      return `${resultCount} results.${providerStatus} ${selectedIndex() + 1} of ${rows.length} visible options active: ${activeLabel}.${previewStatus}`
    }
    if (pending()) return 'Searching providers.'
    if (failures > 0) return `${failures} ${failures === 1 ? 'provider is' : 'providers are'} unavailable. No results available.`
    return query().trim() === '' ? 'No results available.' : `No matches for ${query()}.`
  }
  return (
    <dialog
      ref={dialog}
      class="search-dialog-host"
      aria-modal="true"
      aria-label="Search Dinkster"
      onClose={() => props.app.searchOpen.set(false)}
      onCancel={() => props.app.searchOpen.set(false)}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault()
          props.app.searchOpen.set(false)
        }
      }}
    >
      <section class="search-dialog floating-surface">
        <SearchInput
          value={query()}
          placeholder="Search commands, nodes, settings, and tabs"
          controls={listboxId}
          describedBy={statusId}
          activeDescendant={activeDescendant()}
          busy={pending()}
          ariaLabel="Search Dinkster"
          testId="universal-search-input"
          inputRef={(element) => { input = element }}
          onInput={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.isComposing) return
            const rows = visible()
            const index = selectedIndex()
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (rows.length > 0) setSelected(keyOf(rows[(index + 1) % rows.length]!))
            } else if (event.key === 'ArrowUp') {
              event.preventDefault()
              if (rows.length > 0) setSelected(keyOf(rows[(index - 1 + rows.length) % rows.length]!))
            } else if (event.key === 'Enter') {
              event.preventDefault()
              activate()
            }
          }}
        />
        <div class="search-dialog-content" classList={{ 'has-preview': activeResult()?.item.preview !== undefined }}>
          <div ref={results} class="search-results">
            <div class="search-provider-states">
              <For each={providerStates()}>{(group, groupIndex) => (
                <SearchResultGroup
                  id={`${listboxId}-state-${groupIndex()}`}
                  providerId={group.id}
                  label={group.label}
                  role="region"
                >
                  <Show when={group.status === 'loading'}>
                    <SearchState kind="loading" title={`Searching ${group.label}`} detail="Waiting for this provider to respond." />
                  </Show>
                  <Show when={group.status === 'error'}>
                    <SearchState kind="error" title="Provider unavailable" detail={`${group.label} could not return results. Other search providers remain available.`} />
                  </Show>
                </SearchResultGroup>
              )}</For>
            </div>
            <div
              id={listboxId}
              class="search-result-listbox"
              role="listbox"
              aria-label="Search results"
              aria-busy={pending()}
            >
              <For each={readyGroups()}>{(group, groupIndex) => (
                <SearchResultGroup
                  id={`${listboxId}-group-${groupIndex()}`}
                  providerId={group.id}
                  label={group.label}
                  count={group.results.length}
                >
                  <For each={expanded().has(group.id) ? group.results : group.results.slice(0, 5)}>{(item) => {
                    const key = () => keyOf({ kind: 'result', group, item })
                    const index = () => visible().findIndex((row) => keyOf(row) === key())
                    const describedBy = (): string | undefined => {
                      if (selected() !== key() || item.preview === undefined) return undefined
                      const ids: string[] = []
                      if (item.preview.title !== undefined && item.preview.title !== item.title) ids.push(previewHeadingId)
                      if (item.preview.description !== undefined || (item.preview.fields?.length ?? 0) > 0) ids.push(previewContentId)
                      return ids.length > 0 ? ids.join(' ') : undefined
                    }
                    return (
                      <SearchResultRow
                        id={optionId(index())}
                        selected={selected() === key()}
                        title={item.title}
                        detail={item.detail}
                        describedBy={describedBy()}
                        onHighlight={() => setSelected(key())}
                        onActivate={() => activate(index())}
                      />
                    )
                  }}</For>
                  <Show when={group.results.length > 5 && !expanded().has(group.id) ? group : undefined}>
                    {(expandGroup) => {
                      const key = () => keyOf({ kind: 'expand', group: expandGroup() })
                      const index = () => visible().findIndex((row) => keyOf(row) === key())
                      return (
                        <button
                          id={optionId(index())}
                          class="search-show-more"
                          classList={{ active: selected() === key() }}
                          type="button"
                          role="option"
                          aria-selected={selected() === key()}
                          tabindex="-1"
                          onPointerDown={(event) => event.preventDefault()}
                          onPointerMove={() => setSelected(key())}
                          onMouseEnter={() => setSelected(key())}
                          onClick={() => activate(index())}
                        >
                          Show {expandGroup().results.length - 5} more
                        </button>
                      )
                    }}
                  </Show>
                </SearchResultGroup>
              )}</For>
            </div>
            <Show when={readyGroups().length === 0 && providerStates().length === 0}>
              <SearchState
                kind="empty"
                title={query().trim() === '' ? 'Nothing to show yet' : 'No matches'}
                detail={query().trim() === '' ? 'Search providers have no available results.' : `Try another term or a provider prefix for "${query()}".`}
              />
            </Show>
          </div>
          <Show when={activeResult()?.item.preview}>{(preview) =>
            <aside id={previewId} class="search-result-preview" data-testid="search-result-preview" aria-labelledby={previewHeadingId}>
              <h2 id={previewHeadingId}>{preview().title ?? activeResult()?.item.title}</h2>
              <div id={previewContentId}>
                <Show when={preview().description}>{(description) => <p>{description()}</p>}</Show>
                <Show when={(preview().fields?.length ?? 0) > 0}>
                  <dl>
                    <For each={preview().fields}>{(field) => <div><dt>{field.label}</dt><dd>{field.value}</dd></div>}</For>
                  </dl>
                </Show>
              </div>
            </aside>
          }</Show>
        </div>
        <div class="search-dialog-help" aria-hidden="true">
          <span><kbd>&gt;</kbd> Commands <kbd>@</kbd> Nodes <kbd>#</kbd> Settings <kbd>~</kbd> Tabs</span>
          <span>Up/Down: Navigate | Enter: Open | Esc: Close</span>
        </div>
        <div id={statusId} class="search-announcement" role="status" aria-live="polite" aria-atomic="true">
          {announcement()}
        </div>
      </section>
    </dialog>
  )
}
