/**
 * Common collection browser: THE one list/grid surface for every browsable
 * collection - Library sources (packs, templates, workflows, history,
 * runs), the asset picker, and whatever arrives next (Manager UI). Source
 * tabs or a compact source select, one search box, grid/list modes with
 * optional persistence, folder navigation, cursor paging, an optional
 * pick/commit mode, and an optional host-owned detail rail.
 *
 * Contract enforcement lives HERE so no source can get it wrong:
 * - the query is debounced then handed to the SOURCE; the view never
 *   filters a loaded page by QUERY (pick-mode compatibility hiding is a
 *   mode concern, not a search: the query still went to the source);
 * - a request generation guard drops stale async results (a slow page for
 *   an old query can never overwrite a newer one), and superseded requests
 *   are additionally ABORTED so well-behaved sources stop transferring;
 * - a changed folder restarts paging exactly like a changed query;
 * - "Load more" appends only while the cursor and generation still match;
 * - thumbnails load lazily (loading=lazy decoding=async) so a page of
 *   entries renders text-first and images fill in as they arrive - 2/10
 *   complete beats 10/10 half-loaded; entries without a thumbnail render
 *   derived initials, never a broken-image box;
 * - entry.ref stays OPAQUE: only the host's pick handler consumes it.
 */

import { batch, createEffect, createSignal as createSolidSignal, createUniqueId, For, onCleanup, Show, type JSX } from 'solid-js'
import type { CollectionEntry, CollectionSource } from '@dinkster/core'
// Barrel import, NOT lucide-solid/icons/* deep imports: this module is
// transitively imported by unit-tested code (WidgetEditor), and the deep
// icon paths resolve to lucide's client-compiled ESM under vitest's node
// resolution, which crashes on solid-js/web server stubs at module scope.
import { Grid2X2, List, X } from 'lucide-solid'
import { initialsOf, readCollectionViewMode, safeLocalStorage, writeCollectionViewMode, type CollectionViewMode } from './collections.js'
import { Icon } from './Icon.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { SearchInput } from './SearchSurface.js'

const PAGE_SIZE = 24
const DEBOUNCE_MS = 120

export type CollectionPanelStateKind = 'loading' | 'empty' | 'no-match' | 'no-compatible' | 'error'

export interface CollectionPanelState {
  readonly kind: CollectionPanelStateKind
  readonly query: string
  readonly sourceLabel: string
  readonly message?: string | undefined
}

export function CollectionPanel(props: {
  readonly sources: readonly CollectionSource[]
  /** Optional host-owned source rail. The default flat tabs remain unchanged. */
  readonly sourceRail?: (controls: {
    readonly selectedId: () => string
    readonly select: (id: string) => void
  }) => JSX.Element
  /** Optional entry activation (open frozen view, insert blueprint, ...). */
  readonly onActivate?: (sourceId: string, entry: CollectionEntry) => void
  /** Optional handler for per-entry actions (entry.actions clicks). */
  readonly onAction?: (sourceId: string, entry: CollectionEntry, actionId: string) => void
  /** Source-scoped toolbar operations (bulk clear, ...), host-provided. */
  readonly sourceActions?: readonly { sourceId: string; id: string; label: string }[]
  /**
   * `owner` is the COMMITTED page's owner (CollectionPage owner): the
   * backend whose entries are actually on screen, not whatever backend is
   * current when the click lands. It is undefined while a first-page
   * refresh is in flight (stale items may still be visible) and for local
   * sources - hosts must treat undefined as "no page-scoped target".
   */
  readonly onSourceAction?: (sourceId: string, actionId: string, owner?: string) => void
  /** Bump to re-fetch the current page (live corpus changed upstream). */
  readonly refreshTick?: () => number
  /**
   * Source picker presentation: 'tabs' (default, panel hosts) or 'select'
   * (compact embeddings like widget popups, aria-label "Source").
   */
  readonly variant?: 'tabs' | 'select'
  /** First-render mode when no persisted preference applies. */
  readonly defaultMode?: CollectionViewMode
  /**
   * localStorage key persisting the grid/list mode. Scope is the host's
   * decision: a shared key makes the same surface feel the same across
   * embeddings. Absent = mode is ephemeral.
   */
  readonly modeKey?: string
  /** Search prominence and Assets-local state presentation. */
  readonly searchPriority?: 'toolbar' | 'primary'
  readonly searchLabel?: string
  readonly searchPlaceholder?: string
  readonly renderState?: (state: CollectionPanelState) => JSX.Element
  readonly entryFallback?: (entry: CollectionEntry) => JSX.Element
  /** Exact-match filter values applied before the first page loads. */
  readonly initialFilters?: Readonly<Record<string, string>>
  /**
   * Pick mode: entries the predicate refuses are hidden by default (folders
   * always show - they navigate, never pick). Adapters may retain disabled
   * informational rows. A click or Enter on a pickable entry hands it to
   * onPick immediately. The adapter narrows entry.ref itself.
   */
  readonly pick?: {
    readonly pickable: (entry: CollectionEntry) => boolean
    readonly onPick: (entry: CollectionEntry) => void
    /** Keep informational or disabled entries visible. Hidden remains the default. */
    readonly visible?: (entry: CollectionEntry) => boolean
    /**
     * Host-owned highlight: rows render as selected exactly when this says
     * so (the host's staged selection), not from the panel's private
     * last-clicked row, so unstaging (Remove) visibly clears rows and
     * multi-select highlights every staged row. Roving focus still follows
     * the last-clicked row.
     */
    readonly selected?: (entry: CollectionEntry) => boolean
    /** Multiple rows may be selected at once; sets aria-multiselectable. */
    readonly multi?: boolean
  }
  /**
   * One-shot initial selection: the first matching fresh page selects the
   * first visible non-folder entry while the user has not selected
   * anything. This remains armed across folder pages so a reopened picker
   * can reach a nested current value, but any explicit file selection or
   * source switch disarms it. Hosts narrow entry.ref themselves; this
   * surface never inspects it.
   */
  readonly initialSelection?: (entry: CollectionEntry) => boolean
  /**
   * Host-owned rail rendered beside the items (details, inspections, ...).
   * Receives the selected entry; re-renders on every selection change.
   */
  readonly detailRail?: (entry: CollectionEntry | undefined) => JSX.Element
  /** Escape pressed anywhere inside the panel. */
  readonly onEscape?: () => void
}) {
  const message = useAppMessage()
  const storage = safeLocalStorage()
  const [sourceId, setSourceId] = createSolidSignal(props.sources[0]?.id ?? '')
  const [mode, setModeSignal] = createSolidSignal<CollectionViewMode>(
    props.modeKey !== undefined
      ? readCollectionViewMode(storage, props.modeKey, props.defaultMode ?? 'list')
      : props.defaultMode ?? 'list',
  )
  const [query, setQuery] = createSolidSignal('')
  const [folder, setFolder] = createSolidSignal('')
  const [filters, setFilters] = createSolidSignal<Readonly<Record<string, string>>>(props.initialFilters ?? {})
  const [items, setItems] = createSolidSignal<readonly CollectionEntry[]>([])
  const [cursor, setCursor] = createSolidSignal<string | undefined>(undefined)
  const [total, setTotal] = createSolidSignal<number | undefined>(undefined)
  const [loading, setLoading] = createSolidSignal(false)
  const [error, setError] = createSolidSignal<string | undefined>(undefined)
  // Owner of the COMMITTED page (see onSourceAction). Invalidated the
  // moment a first-page refresh starts: the old items stay visible until
  // the replacement resolves, but page-scoped actions must not treat them
  // as current - the refresh may be re-paging against a different backend.
  const [pageOwner, setPageOwner] = createSolidSignal<string | undefined>(undefined)
  const [selectedId, setSelectedId] = createSolidSignal<string | undefined>(undefined)
  const [expandedIds, setExpandedIds] = createSolidSignal<ReadonlySet<string>>(new Set())
  const [armedAction, setArmedAction] = createSolidSignal<string>()
  const instanceId = createUniqueId()
  const resultsId = `collection-results-${instanceId}`
  const descriptionId = `collection-description-${instanceId}`
  let rootEl: HTMLDivElement | undefined
  let searchEl: HTMLInputElement | undefined
  let actionArmTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const selection = `${sourceId()}:${selectedId() ?? ''}`
    void selection
    if (actionArmTimer !== undefined) clearTimeout(actionArmTimer)
    actionArmTimer = undefined
    setArmedAction(undefined)
  })
  const clearSearch = (): void => {
    if (searchEl === undefined || searchEl.value === '') return
    searchEl.value = ''
    searchEl.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }

  const source = (): CollectionSource | undefined => props.sources.find((s) => s.id === sourceId())

  const filterOptions = (filter: NonNullable<CollectionSource['filters']>[number]) => {
    void items()
    const options = filter.options()
    const active = filters()[filter.id]
    return [
      { id: '', label: message('collection.filter.all', { filter: filter.label.toLowerCase() }), value: '' },
      ...(active !== undefined && active !== '' && !options.some((option) => option.value === active)
        ? [{ id: active, label: active, value: active }]
        : []),
      ...options.map((option) => ({ id: option.value, label: option.label, value: option.value })),
    ]
  }

  const activeFilters = (): readonly { readonly id: string; readonly label: string; readonly value: string; readonly valueLabel: string }[] =>
    (source()?.filters ?? []).flatMap((filter) => {
      const value = filters()[filter.id]
      if (value === undefined || value === '') return []
      return [{
        id: filter.id,
        label: filter.label,
        value,
        valueLabel: filter.options().find((option) => option.value === value)?.label ?? value,
      }]
    })

  const clearFilter = (id: string): void => {
    setFilters({ ...filters(), [id]: '' })
  }

  const setMode = (next: CollectionViewMode): void => {
    setModeSignal(next)
    if (props.modeKey !== undefined) writeCollectionViewMode(storage, props.modeKey, next)
    // Mode switch keeps selection; put focus back on the selected row so
    // keyboard navigation continues from where the user was.
    queueMicrotask(() => focusEntry(selectedId()))
  }

  // Pick-mode visibility: unpickable entries hide by default, folders
  // always show, and adapters may retain informational disabled rows.
  // This is capability filtering of a page the SOURCE already ranked -
  // never a substitute for source-owned query filtering.
  const visibleItems = (): readonly CollectionEntry[] =>
    props.pick
      ? items().filter((entry) => entry.folder !== undefined || props.pick!.pickable(entry) || props.pick!.visible?.(entry) === true)
      : items()

  const visibleChildren = (entry: CollectionEntry): readonly CollectionEntry[] =>
    (entry.children ?? []).filter((child) => !props.pick || props.pick.pickable(child) || props.pick.visible?.(child) === true)

  // A non-pickable parent with visible pickable/informational children is a
  // presentation group, not an option. Its children stay in the one list.
  const pickGroupChildren = (entry: CollectionEntry): readonly CollectionEntry[] | undefined => {
    if (!props.pick || entry.folder !== undefined || props.pick.pickable(entry)) return undefined
    const children = visibleChildren(entry)
    return children.length > 0 ? children : undefined
  }

  const navigableItems = (): readonly CollectionEntry[] => visibleItems().flatMap((entry) => [
    ...(pickGroupChildren(entry) ?? [entry]),
    ...(pickGroupChildren(entry) === undefined && expandedIds().has(entry.id) ? visibleChildren(entry) : []),
  ])

  const selectedEntry = (): CollectionEntry | undefined => navigableItems().find((e) => e.id === selectedId())
  const selectedElementId = (): string | undefined => {
    const selected = selectedId()
    const index = selected === undefined ? -1 : navigableItems().findIndex((entry) => entry.id === selected)
    return index < 0 ? undefined : `${resultsId}-entry-${index}`
  }

  const panelState = (): CollectionPanelState | undefined => {
    if (visibleItems().length > 0) return undefined
    const common = { query: query().trim(), sourceLabel: source()?.label ?? '' }
    if (error() !== undefined) return { ...common, kind: 'error', message: error() }
    if (loading()) return { ...common, kind: 'loading' }
    if (props.pick && items().length > 0) return { ...common, kind: 'no-compatible' }
    if (common.query !== '' || activeFilters().length > 0) return { ...common, kind: 'no-match' }
    return { ...common, kind: 'empty' }
  }

  const searchDescription = (): string => {
    const state = panelState()
    if (state?.kind === 'loading') return message('collection.description.loading', { source: state.sourceLabel })
    if (state?.kind === 'error') return message('collection.description.error', { source: state.sourceLabel })
    if (state?.kind === 'no-match') return message('collection.description.noMatches', { source: state.sourceLabel })
    if (state?.kind === 'no-compatible') return message('collection.description.noAvailable', { source: state.sourceLabel })
    if (state?.kind === 'empty') return message('collection.description.empty', { source: state.sourceLabel })
    const count = total() ?? visibleItems().length
    return message('collection.result.count', { count, source: source()?.label ?? message('collection.result.collectionFallback') })
  }

  const toggleExpanded = (id: string): void => {
    const next = new Set(expandedIds())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpandedIds(next)
  }

  // Stale-response guard: only the newest request generation may write.
  // The abort controller is defense-in-depth on top of it: aborting lets
  // sources stop wasted transfers, but a source that ignores the signal
  // still cannot overwrite newer results.
  let generation = 0
  let controller: AbortController | undefined
  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  // One-shot: armed until a fresh page in the navigated folder contains
  // the initial row. A non-recursive root page cannot contain a nested
  // current asset, so folder navigation must not disarm it prematurely.
  let pendingInitialSelection = props.initialSelection

  /**
   * Supersede whatever is in flight RIGHT NOW, before the replacement
   * request exists: the debounce window between a query keystroke and its
   * runPage must not let the old request commit, and must not let "Load
   * more" send the NEW query with the OLD query's cursor.
   */
  const supersede = (): void => {
    generation++
    controller?.abort()
    controller = undefined
    setLoading(true)
    setError(undefined)
    setCursor(undefined)
    setPageOwner(undefined)
  }

  const runPage = (append: boolean): void => {
    const src = source()
    if (!src) return
    const gen = ++generation
    controller?.abort()
    controller = new AbortController()
    const cur = append ? cursor() : undefined
    const req = {
      query: query().trim(),
      limit: PAGE_SIZE,
      filters: filters(),
      signal: controller.signal,
      ...(src.folders === true && folder() !== '' ? { folder: folder() } : {}),
      ...(cur !== undefined ? { cursor: cur } : {}),
    }
    setLoading(true)
    setError(undefined)
    if (!append) setPageOwner(undefined)
    void src
      .page(req)
      .then((page) => {
        if (gen !== generation) return // a newer query/source superseded us
        // A fresh page replaces every row object, so <For> unmounts the
        // focused row even when the same id comes back (refresh ticks
        // re-page a live panel). If keyboard focus was ON a row - not
        // inside a nested control - carry it to the replacement row with
        // the same id, else to the roving stop; never steal focus from
        // anywhere else.
        const active = document.activeElement
        const focusedRowId = !append && active instanceof HTMLElement
          && rootEl?.contains(active) === true && active.dataset['entry'] !== undefined
          ? active.dataset['entry']
          : undefined
        setItems(append ? [...items(), ...page.items] : page.items)
        setCursor(page.cursor)
        setTotal(page.total)
        setPageOwner(page.owner)
        setLoading(false)
        if (!append && pendingInitialSelection !== undefined && selectedId() === undefined) {
          const match = pendingInitialSelection
          const entry = navigableItems().find((e) => e.folder === undefined && match(e))
          if (entry !== undefined) {
            pendingInitialSelection = undefined
            setSelectedId(entry.id)
          }
        }
        if (focusedRowId !== undefined) {
          queueMicrotask(() => {
            focusEntry(visibleItems().some((e) => e.id === focusedRowId) ? focusedRowId : rovingId())
          })
        }
      })
      .catch((reason: unknown) => {
        if (gen !== generation) return // superseded (incl. our own abort)
        if (!append) {
          setItems([])
          setPageOwner(undefined)
        }
        setCursor(undefined)
        setLoading(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      })
  }

  // First page: immediately on source/folder switch and refresh ticks,
  // debounced on typing.
  let lastQuery = ''
  let lastSource = ''
  createEffect(() => {
    const q = query()
    const s = sourceId()
    const f = JSON.stringify(filters())
    folder()
    props.refreshTick?.()
    const typed = q !== lastQuery && s === lastSource
    void f
    if (s !== lastSource) setSelectedId(undefined) // refresh ticks keep selection
    lastQuery = q
    lastSource = s
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    if (typed) {
      // Only the FETCH waits for typing to settle; the in-flight request
      // and the old cursor are superseded immediately (see supersede).
      supersede()
      debounceTimer = setTimeout(() => runPage(false), DEBOUNCE_MS)
    } else {
      runPage(false)
    }
  })
  onCleanup(() => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    if (actionArmTimer !== undefined) clearTimeout(actionArmTimer)
    generation++ // orphan any in-flight page
    controller?.abort()
  })

  const switchSource = (id: string): void => {
    batch(() => {
      pendingInitialSelection = undefined
      setSourceId(id)
      setFolder('')
      setSelectedId(undefined)
    })
  }

  const navigateFolder = (path: string): void => {
    batch(() => {
      setFolder(path)
      setSelectedId(undefined)
    })
  }

  const focusEntry = (id: string | undefined): void => {
    if (id === undefined) return
    const entry = rootEl?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(id)}"]`)
    if (entry == null) return
    entry.focus({ preventScroll: true })
    const viewport = entry.closest<HTMLElement>('.collection-items')
    if (viewport === null) return
    const entryRect = entry.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    if (entryRect.bottom > viewportRect.bottom) viewport.scrollTop += entryRect.bottom - viewportRect.bottom
    else if (entryRect.top < viewportRect.top) viewport.scrollTop -= viewportRect.top - entryRect.top
  }

  // Roving tab index: exactly one row is Tab-reachable - the selected row,
  // or the first visible row when nothing is selected. Every other row is
  // click/arrow-focusable only (tabindex -1), so Tab enters the list once
  // instead of walking every entry.
  const rovingId = (): string | undefined => {
    const rows = navigableItems()
    const sel = selectedId()
    return sel !== undefined && rows.some((e) => e.id === sel) ? sel : rows[0]?.id
  }

  /** Activate an entry: folders navigate; pick mode selects and hands the
   * pickable entry to onPick immediately; panel mode toggles selection +
   * onActivate. */
  const activate = (entry: CollectionEntry): void => {
    if (entry.folder !== undefined) {
      navigateFolder(entry.folder.path)
      return
    }
    pendingInitialSelection = undefined
    if (props.pick) {
      if (!props.pick.pickable(entry)) return
      setSelectedId(entry.id)
      props.pick.onPick(entry)
      return
    }
    setSelectedId(selectedId() === entry.id ? undefined : entry.id)
    props.onActivate?.(sourceId(), entry)
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && props.onEscape) {
      event.preventDefault()
      props.onEscape()
      return
    }
    // Row navigation anchors on the focused row when there is one (roving
    // focus): a row can hold focus without being selected yet, and arrows
    // must move from THERE, not from stale selection state. Only keys ON
    // the row itself navigate/commit: controls nested inside it (entry
    // action buttons, rail inputs) keep their native key behavior - Enter
    // on a Library action must click the action, never re-activate the
    // row out from under it.
    const target = event.target instanceof HTMLElement ? event.target : undefined
    const row = target?.closest<HTMLElement>('[data-entry]')
    if (!row || target !== row) return
    const rows = navigableItems()
    let index = rows.findIndex((e) => e.id === row.dataset['entry'])
    if (index < 0) index = rows.findIndex((e) => e.id === selectedId())
    if (event.key === 'Enter') {
      const entry = rows[index]
      if (entry) {
        event.preventDefault()
        activate(entry)
      }
      return
    }
    if (event.key === 'Home') index = 0
    else if (event.key === 'End') index = rows.length - 1
    else if (event.key.startsWith('Arrow')) {
      index = Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1)))
    } else return
    event.preventDefault()
    const entry = rows[index]
    if (entry) {
      if (entry.folder === undefined) pendingInitialSelection = undefined
      setSelectedId(entry.id)
      queueMicrotask(() => focusEntry(entry.id))
    }
  }

  const Thumb = (p: { entry: CollectionEntry }) => {
    const [failed, setFailed] = createSolidSignal(false)
    const [rendered, setRendered] = createSolidSignal<string>()
    // Rendered thumbnails (no direct pixels; thumbUrl wins when present).
    createEffect(() => {
      const render = p.entry.thumbUrl === undefined ? p.entry.thumbRender : undefined
      setRendered(undefined)
      if (render === undefined) return
      let live = true
      onCleanup(() => { live = false })
      render().then(
        (url) => { if (live) setRendered(url) },
        () => { if (live) setFailed(true) },
      )
    })
    const fallback = () => props.entryFallback?.(p.entry)
      ?? <span class="collection-initials" aria-hidden="true">{initialsOf(p.entry.title)}</span>
    return <Show when={!failed() ? p.entry.thumbUrl ?? rendered() : undefined} fallback={fallback()}>
      {(url) => <img class="collection-thumb" src={url()} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </Show>
  }

  const Details = (p: { entry: CollectionEntry }) => (
    <dl class="collection-details" data-testid="collection-details">
      <For each={p.entry.details ?? []}>
        {(d) => (
          <>
            <dt>{d.label}</dt>
            <dd>{d.text}</dd>
          </>
        )}
      </For>
    </dl>
  )

  // Entry actions render on the SELECTED entry only; a click routes to the
  // action handler and never doubles as activation (stopPropagation).
  const Actions = (p: { entry: CollectionEntry }) => (
    <div class="collection-actions" data-testid="collection-actions">
      <For each={p.entry.actions ?? []}>
        {(a) => {
          const key = () => `${sourceId()}:${p.entry.id}:${a.id}`
          const armed = () => a.id === 'delete' && armedAction() === key()
          return <button
              class="collection-action"
              data-testid="collection-action"
              data-action={a.id}
              data-tone={a.id === 'delete' ? 'danger' : 'accent'}
              aria-pressed={a.id === 'delete' ? armed() : undefined}
              onClick={(e) => {
                e.stopPropagation()
                if (a.id === 'delete' && !armed()) {
                  setArmedAction(key())
                  if (actionArmTimer !== undefined) clearTimeout(actionArmTimer)
                  actionArmTimer = setTimeout(() => setArmedAction(undefined), 4000)
                  return
                }
                if (actionArmTimer !== undefined) clearTimeout(actionArmTimer)
                actionArmTimer = undefined
                setArmedAction(undefined)
                props.onAction?.(sourceId(), p.entry, a.id)
              }}
            >
              {armed() ? message('collection.action.confirmDelete') : a.label}
            </button>
        }}
      </For>
    </div>
  )

  // Highlight state: the host's staged selection when it provides one
  // (pick mode), else the panel's own last-clicked row.
  const highlighted = (entry: CollectionEntry): boolean =>
    props.pick?.selected !== undefined ? props.pick.selected(entry) : entry.id === selectedId()

  const Entry = (p: { entry: CollectionEntry; child?: boolean }) => (
    <div
      id={`${resultsId}-entry-${navigableItems().findIndex((entry) => entry.id === p.entry.id)}`}
      classList={{
        'collection-entry': true,
        'collection-child': p.child === true,
        selected: highlighted(p.entry),
        folder: p.entry.folder !== undefined,
        disabled: props.pick !== undefined && p.entry.folder === undefined && !props.pick.pickable(p.entry),
      }}
      data-testid="collection-entry"
      data-entry={p.entry.id}
      role="option"
      aria-selected={highlighted(p.entry)}
      aria-disabled={props.pick !== undefined && p.entry.folder === undefined && !props.pick.pickable(p.entry) ? 'true' : undefined}
      aria-label={`${p.entry.title}${p.entry.subtitle ? `\n${p.entry.subtitle}` : ''}`}
      data-tooltip-label={`${p.entry.title}${p.entry.subtitle ? `\n${p.entry.subtitle}` : ''}`}
      tabindex={p.entry.id === rovingId() ? '0' : '-1'}
      onClick={() => activate(p.entry)}
    >
      <Thumb entry={p.entry} />
      <div class="collection-text">
        <span class="collection-title">{p.entry.title}</span>
        <Show when={p.entry.subtitle}>
          <span class="collection-subtitle">{p.entry.subtitle}</span>
        </Show>
        <Show when={(p.entry.badges ?? []).length > 0}>
          <span class="collection-badges">
            <For each={p.entry.badges}>{(b) => <span class="collection-badge" data-badge={b.toLocaleLowerCase()}>{b}</span>}</For>
          </span>
        </Show>
      </div>
      <Show when={(p.entry.children ?? []).length > 0}>
        <button
          type="button"
          class="collection-expand"
          data-testid="collection-expand"
          aria-controls={`${resultsId}-group-${p.entry.id}`}
          aria-expanded={expandedIds().has(p.entry.id)}
          aria-label={message(expandedIds().has(p.entry.id) ? 'collection.group.collapse' : 'collection.group.expand', { count: p.entry.children!.length })}
          onClick={(event) => {
            event.stopPropagation()
            toggleExpanded(p.entry.id)
          }}
        >
          {message(expandedIds().has(p.entry.id) ? 'collection.action.hideRuns' : 'collection.action.showRuns')}
        </button>
      </Show>
      <Show when={p.entry.id === selectedId() && (p.entry.details ?? []).length > 0}>
        <Details entry={p.entry} />
      </Show>
      <Show when={p.entry.id === selectedId() && (p.entry.actions ?? []).length > 0}>
        <Actions entry={p.entry} />
      </Show>
    </div>
  )

  const Group = (p: { entry: CollectionEntry; children: readonly CollectionEntry[] }) => {
    const labelId = `${resultsId}-group-${encodeURIComponent(p.entry.id)}-label`
    return (
      <section class="collection-group" data-testid="collection-group" role="presentation">
        <header id={labelId} class="collection-group-header">
          <span class="collection-title">{p.entry.title}</span>
          <Show when={(p.entry.badges ?? []).length > 0}>
            <span class="collection-badges">
              <For each={p.entry.badges}>{(badge) => <span class="collection-badge" data-badge={badge.toLocaleLowerCase()}>{badge}</span>}</For>
            </span>
          </Show>
        </header>
        <div class="collection-group-entries" role="group" aria-labelledby={labelId}>
          <For each={p.children}>{(child) => <Entry entry={child} child />}</For>
        </div>
      </section>
    )
  }

  const SourceControl = () => (
    <Show
      when={props.variant === 'select'}
      fallback={
        <Show when={props.sourceRail} fallback={
          <div class="collection-sources" role="tablist">
            <For each={props.sources}>
              {(entrySource) => (
                <button
                  classList={{ 'collection-source': true, active: entrySource.id === sourceId() }}
                  data-testid="collection-source"
                  data-source={entrySource.id}
                  role="tab"
                  aria-selected={entrySource.id === sourceId()}
                  onClick={() => switchSource(entrySource.id)}
                >
                  {entrySource.label}
                </button>
              )}
            </For>
          </div>
        }>
          {(rail) => rail()({ selectedId: sourceId, select: switchSource })}
        </Show>
      }
    >
      <ProductSelect
        class="collection-source-select"
        testId="collection-source-select"
        ariaLabel={message('collection.source.ariaLabel')}
        selectedId={sourceId()}
        options={props.sources.map((entrySource) => ({ id: entrySource.id, label: entrySource.label, value: entrySource.id }))}
        onSelect={(option) => switchSource(option.value)}
      />
    </Show>
  )

  const FilterControls = () => (
    <For each={source()?.filters ?? []}>
      {(filter) => (
        <ProductSelect
          class="collection-filter"
          testId={`collection-filter-${filter.id}`}
          ariaLabel={filter.label}
          selectedId={filters()[filter.id] ?? ''}
          options={filterOptions(filter)}
          onSelect={(option) => setFilters({ ...filters(), [filter.id]: option.value })}
        />
      )}
    </For>
  )

  const StatePresentation = (stateProps: { readonly state: CollectionPanelState }) => (
    <div
      classList={{ 'collection-state': true, 'collection-error': stateProps.state.kind === 'error' }}
      data-testid={stateProps.state.kind === 'error' ? 'collection-error' : 'collection-empty'}
      data-collection-state={stateProps.state.kind}
    >
      {props.renderState?.(stateProps.state) ?? (
        <p class="empty">
          {stateProps.state.kind === 'loading'
            ? message('collection.state.loading')
            : stateProps.state.kind === 'error'
              ? stateProps.state.message
              : stateProps.state.kind === 'no-match'
                ? message('collection.state.noMatches')
                : stateProps.state.kind === 'no-compatible'
                  ? message('collection.state.noAvailable')
                  : message('collection.state.empty')}
        </p>
      )}
    </div>
  )

  const searchKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && event.currentTarget instanceof HTMLInputElement && event.currentTarget.value !== '') {
      event.preventDefault()
      event.stopPropagation()
      clearSearch()
      return
    }
    if (event.key === 'ArrowDown' && navigableItems().length > 0) {
      event.preventDefault()
      focusEntry(rovingId())
    }
  }

  const SearchControl = () => (
    <span class="collection-search-field">
      <SearchInput
        value={query()}
        placeholder={props.searchPlaceholder ?? message('collection.search.placeholder')}
        controls={resultsId}
        describedBy={descriptionId}
        activeDescendant={selectedElementId()}
        busy={loading()}
        ariaLabel={props.searchLabel ?? message('collection.search.label')}
        testId="collection-search"
        clearTestId="collection-search-clear"
        variant={props.searchPriority === 'primary' ? 'surface' : 'toolbar'}
        inputRef={(element) => { searchEl = element }}
        onClear={clearSearch}
        onInput={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={searchKeyDown}
      />
      <span id={descriptionId} class="collection-search-description">{searchDescription()}</span>
    </span>
  )

  const Controls = () => props.searchPriority === 'primary'
    ? <>
        <SearchControl />
        <Show when={activeFilters().length > 0}>
          <div class="collection-active-filters" data-testid="collection-active-filters" aria-label={message('collection.filter.active')}>
            <For each={activeFilters()}>{(filter) => (
              <button type="button" class="collection-active-filter" aria-label={message('collection.action.removeFilter', { filter: filter.label })} onClick={() => clearFilter(filter.id)}>
                <span>{filter.label}: {filter.valueLabel}</span>
                <Icon icon={X} />
              </button>
            )}</For>
          </div>
        </Show>
        <SourceControl />
        <Show when={(source()?.filters ?? []).length > 0}>
          <details class="collection-filter-disclosure">
            <summary>{message('collection.filter.title')}</summary>
            <div class="collection-filter-controls"><FilterControls /></div>
          </details>
        </Show>
      </>
    : <><SourceControl /><FilterControls /><SearchControl /></>

  return (
    <div
      class="collection-panel"
      data-testid="collection-panel"
      data-layout={visibleItems().length <= 3 && cursor() === undefined ? 'sparse' : 'filled'}
      data-search-priority={props.searchPriority ?? 'toolbar'}
      ref={rootEl}
      onKeyDown={keydown}
    >
      <div class="collection-toolbar">
        <Controls />
        <For each={(props.sourceActions ?? []).filter((a) => a.sourceId === sourceId())}>
          {(a) => (
            <button
              class="collection-source-action"
              data-testid="collection-source-action"
              data-action={a.id}
              disabled={loading()}
              onClick={() => props.onSourceAction?.(sourceId(), a.id, pageOwner())}
            >
              {a.label}
            </button>
          )}
        </For>
        <button
          class="collection-mode"
          data-testid="collection-mode"
          data-tooltip-label={message(mode() === 'list' ? 'collection.mode.grid' : 'collection.mode.list')}
          aria-label={message(mode() === 'list' ? 'collection.mode.grid' : 'collection.mode.list')}
          onClick={() => setMode(mode() === 'list' ? 'grid' : 'list')}
        >
          <Show when={mode() === 'list'} fallback={<Icon icon={List} />}>
            <Icon icon={Grid2X2} />
          </Show>
        </button>
      </div>

      <Show when={source()?.folders === true}>
        <nav class="collection-folders" data-testid="collection-folders" aria-label={message('collection.folder.ariaLabel')}>
          <button type="button" aria-current={folder() === '' ? 'page' : undefined} onClick={() => navigateFolder('')}>{message('collection.folder.root')}</button>
          <For each={folder().split('/').filter(Boolean)}>
            {(part, index) => (
              <>
                <span class="collection-folder-separator" aria-hidden="true">/</span>
                <button
                  type="button"
                  aria-current={index() === folder().split('/').filter(Boolean).length - 1 ? 'page' : undefined}
                  onClick={() => navigateFolder(folder().split('/').filter(Boolean).slice(0, index() + 1).join('/'))}
                >
                  {part}
                </button>
              </>
            )}
          </For>
        </nav>
      </Show>

      <Show when={error() !== undefined && visibleItems().length > 0}>
        <div class="collection-continuation-error">
          <StatePresentation state={{ kind: 'error', query: query().trim(), sourceLabel: source()?.label ?? '', message: error() }} />
        </div>
      </Show>

      <div class="collection-content">
        <Show
          when={visibleItems().length > 0}
          fallback={
            <div id={resultsId} class="collection-state-list" role="listbox" aria-label={message('collection.result.ariaLabel', { source: source()?.label ?? message('collection.result.collectionFallback') })}>
              <Show when={panelState()}>{(state) => <StatePresentation state={state()} />}</Show>
            </div>
          }
        >
          <div
            id={resultsId}
            classList={{ 'collection-items': true, grid: mode() === 'grid', list: mode() === 'list' }}
            data-testid="collection-items"
            data-mode={mode()}
            role="listbox"
            aria-label={message('collection.result.ariaLabel', { source: source()?.label ?? message('collection.result.collectionFallback') })}
            aria-multiselectable={props.pick?.multi === true ? 'true' : undefined}
          >
            <For each={visibleItems()}>
              {(entry) => (
                <Show when={pickGroupChildren(entry)} fallback={
                  <>
                    <Entry entry={entry} />
                    <Show when={expandedIds().has(entry.id)}>
                      <div id={`${resultsId}-group-${entry.id}`} class="collection-children" role="group" aria-label={message('collection.group.runsIn', { title: entry.title })}>
                        <For each={visibleChildren(entry)}>{(child) => <Entry entry={child} child />}</For>
                      </div>
                    </Show>
                  </>
                }>
                  {(children) => <Group entry={entry} children={children()} />}
                </Show>
              )}
            </For>
          </div>
        </Show>
        {props.detailRail?.(selectedEntry())}
      </div>

      <div class="collection-footer">
        <Show when={total() !== undefined}>
          <span class="collection-total" data-testid="collection-total">
            {message('collection.result.total', { count: items().length, total: total()! })}
          </span>
        </Show>
        <Show when={cursor() !== undefined}>
          <button
            class="collection-more"
            data-testid="collection-more"
            disabled={loading()}
            onClick={() => runPage(true)}
          >
            {message('collection.action.loadMore')}
          </button>
        </Show>
      </div>
    </div>
  )
}
