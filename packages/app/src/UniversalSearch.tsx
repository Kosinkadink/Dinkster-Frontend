import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { createSearchSession, decodeSearchHostAction, type SearchGroup, type SearchHostAction, type SearchResult } from '@dinkster/core'
import Search from 'lucide-solid/icons/search'
import { AppWindow, Download, PanelTop, SlidersHorizontal, SquareTerminal, Workflow, type LucideIcon } from 'lucide-solid'
import {
  BlueprintIcon,
  ProductSearch,
  ProductSearchNodePreview,
  ProductWindowAction,
  productShortcutKeys as shortcutKeys,
  type ProductSearchGroup,
  type ProductSearchRow,
} from '@dinkster/ui'
import type { AppState } from './app-state.js'
import { recordSearchRecent, runSearchAction, searchNodeSchema, searchRecents } from './universal-search.js'
import { SchemaPreview } from './SchemaPreview.js'
import { useSignal } from './solid-adapter.js'
import { useAppMessage } from './locale.js'

/** How many results of each kind the All tab shows after typing before "N more". */
const SHOWN = 3
const RECENT_SHOWN = 5

const KIND_ICONS: Readonly<Record<string, LucideIcon>> = {
  'core.nodes': PanelTop,
  'core.blueprints': BlueprintIcon,
  'core.commands': SquareTerminal,
  'core.settings': SlidersHorizontal,
  'core.workflows': Workflow,
  'core.tabs': AppWindow,
}

type RowRef =
  | { readonly kind: 'result'; readonly group: SearchGroup; readonly item: SearchResult }
  | { readonly kind: 'more'; readonly group: SearchGroup }

const keyOf = (group: SearchGroup, item: SearchResult, place = 'result'): string => `${place}\u0000${group.id}\u0000${item.id}`
const moreKey = (group: SearchGroup): string => `more\u0000${group.id}`

export { productShortcutKeys as shortcutKeys } from '@dinkster/ui'

export function UniversalSearchTrigger(props: { readonly shortcut?: string | undefined; readonly open?: boolean; readonly onOpen: () => void }) {
  const message = useAppMessage()
  return (
    <ProductWindowAction
      label={message('command.search.open')}
      icon={Search}
      shortcut={props.shortcut ?? ''}
      data-testid="topbar-search"
      aria-haspopup="dialog"
      aria-expanded={props.open ?? false}
      onClick={props.onOpen}
    />
  )
}

export function UniversalSearch(props: { app: AppState }) {
  const message = useAppMessage()
  const catalog = useSignal(props.app.searchCatalog)
  const settingsChanged = useSignal(props.app.settings.changed)
  const [query, setQuery] = createSignal('')
  const [kind, setKind] = createSignal('all')
  const [groups, setGroups] = createSignal<readonly SearchGroup[]>([])
  const [current, setCurrent] = createSignal<string>()
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [activating, setActivating] = createSignal(false)
  let live = true
  let searchRevision = 0
  const unsubscribeOpen = props.app.searchOpen.subscribe(() => { searchRevision++ })
  const unsubscribeTab = props.app.activeTabId.subscribe(() => { searchRevision++ })
  let dialog!: HTMLDialogElement
  const typed = () => query().trim() !== ''
  const ready = () => groups().filter((group) => group.status === 'ready' && group.results.length > 0)
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
    onReset: () => setExpanded(new Set<string>()),
    onGroups: setGroups,
  })
  createEffect(() => { searchRevision++; session.query(query()) })

  /** Every row drawn, in order, with what it stands for. */
  const layout = (): { readonly groups: readonly { readonly group: SearchGroup | undefined; readonly id: string; readonly label: string; readonly rows: readonly (RowRef & { readonly key: string })[]; readonly note?: string }[] } => {
    const chosen = kind()
    if (chosen === 'all' && !typed()) {
      const recents = searchRecents(props.app.settings)
      const found = ready().flatMap((group) => group.results.map((item) => ({ group, item, at: recents.indexOf(`${group.id}:${item.id}`) })))
      const recent = found.filter((entry) => entry.at >= 0).sort((a, b) => a.at - b.at).slice(0, RECENT_SHOWN)
      const tabs = ready().find((group) => group.id === 'core.tabs')
      return { groups: [
        ...(recent.length === 0 ? [] : [{ group: undefined, id: 'recent', label: message('search.group.recent'), rows: recent.map(({ group, item }) => ({ kind: 'result' as const, group, item, key: keyOf(group, item, 'recent') })) }]),
        ...(tabs === undefined ? [] : [{ group: tabs, id: tabs.id, label: message('search.group.openTabs'), rows: tabs.results.map((item) => ({ kind: 'result' as const, group: tabs, item, key: keyOf(tabs, item) })) }]),
      ] }
    }
    return { groups: groups().filter((group) => chosen === 'all' || group.id === chosen).flatMap((group) => {
      if (group.status === 'loading') return [{ group, id: group.id, label: group.label, rows: [], note: message('search.searching', { kind: group.label.toLocaleLowerCase() }) }]
      if (group.status === 'error') return [{ group, id: group.id, label: group.label, rows: [], note: message('search.unavailable', { kind: group.label }) }]
      if (group.results.length === 0) return []
      const short = chosen === 'all' && !expanded().has(group.id) && group.results.length > SHOWN
      return [{
        group,
        id: group.id,
        label: group.label,
        rows: [
          ...(short ? group.results.slice(0, SHOWN) : group.results).map((item) => ({ kind: 'result' as const, group, item, key: keyOf(group, item) })),
          ...(short ? [{ kind: 'more' as const, group, key: moreKey(group) }] : []),
        ],
      }]
    }) }
  }
  const refs = () => new Map(layout().groups.flatMap((group) => group.rows.map((row) => [row.key, row] as const)))
  const currentKey = () => {
    const all = layout().groups.flatMap((group) => group.rows.map((row) => row.key))
    const key = current()
    return key !== undefined && all.includes(key) ? key : all[0]
  }
  const currentRef = () => refs().get(currentKey() ?? '')
  const hostAction = (item: SearchResult): SearchHostAction | undefined => item.action.kind === 'host' ? decodeSearchHostAction(item.action) : undefined
  /** A boolean setting a row can flip in place. */
  const switchSetting = (item: SearchResult): string | undefined => {
    const action = hostAction(item)
    if (action?.action !== 'settings.open' || action.params.id === undefined) return undefined
    const id = action.params.id
    return props.app.settings.list().some((definition) => definition.id === id && definition.type === 'boolean') ? id : undefined
  }
  const nodeLike = (item: SearchResult): boolean => {
    const action = hostAction(item)?.action
    return action === 'node.armPlacement' || action === 'node.previewInstall' || action === 'blueprint.armPlacement'
  }
  const row = (ref: RowRef & { readonly key: string }): ProductSearchRow => {
    if (ref.kind === 'more') {
      return { key: ref.key, kind: 'more', title: message('search.more', { count: ref.group.results.length - SHOWN, kind: ref.group.label.toLocaleLowerCase() }) }
    }
    const { group, item } = ref
    const setting = switchSetting(item)
    const icon = KIND_ICONS[group.id]
    const action = hostAction(item)
    const base: ProductSearchRow = { key: ref.key, title: item.title, ...(icon === undefined ? {} : { icon }) }
    if (group.id === 'core.commands') return { ...base, ...(item.detail === undefined ? {} : { keys: shortcutKeys(item.detail) }) }
    if (setting !== undefined) {
      return {
        ...base,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        toggle: {
          checked: (settingsChanged(), props.app.settings.get<boolean>(setting)),
          label: item.title,
          onChange: (next) => props.app.settings.set(setting, next),
        },
      }
    }
    return {
      ...base,
      ...(item.detail === undefined ? {} : { detail: item.detail }),
      ...(action?.action === 'node.previewInstall' ? { detailIcon: Download } : {}),
    }
  }
  const productGroups = (): readonly ProductSearchGroup[] => layout().groups.map((group) => ({
    key: group.id,
    ...(group.label === '' ? {} : { label: group.label }),
    ...(group.group !== undefined && typed() && group.group.status === 'ready' ? { count: group.group.results.length } : {}),
    rows: group.rows.map(row),
    ...(group.note === undefined ? {} : { note: group.note }),
  }))
  const kinds = () => [
    { id: 'all', label: message('search.kind.all') },
    ...props.app.searchRegistry.list()
      .filter((provider) => !typed() || kind() === provider.id || groups().some((group) => group.id === provider.id && (group.status !== 'ready' || group.results.length > 0)))
      .map((provider) => {
        const group = groups().find((candidate) => candidate.id === provider.id)
        return { id: provider.id, label: provider.label, ...(typed() && group?.status === 'ready' ? { count: group.results.length } : {}) }
      }),
  ]
  const enterHint = (): string => {
    const ref = currentRef()
    if (ref === undefined) return message('search.hint.open')
    if (ref.kind === 'more') return message('search.hint.showAll')
    const action = hostAction(ref.item)?.action
    if (action === 'node.armPlacement') return message('search.hint.placeNode')
    if (action === 'blueprint.armPlacement') return message('search.hint.placeBlueprint')
    if (action === 'node.previewInstall') return message('search.hint.install')
    if (action === 'command.run' || ref.item.action.kind === 'command') return message('search.hint.run')
    if (switchSetting(ref.item) !== undefined) return message('search.hint.change')
    return message('search.hint.open')
  }
  const preview = () => {
    const ref = currentRef()
    if (ref?.kind !== 'result' || !nodeLike(ref.item)) return undefined
    const item = ref.item
    const schema = (catalog(), searchNodeSchema(props.app, item.action))
    const place = item.preview?.fields?.find((field) => field.label === 'Where')?.value
    const notInstalled = hostAction(item)?.action === 'node.previewInstall'
    return (
      <ProductSearchNodePreview
        {...(schema === undefined ? {} : { drawing: <SchemaPreview schema={schema} widgets={props.app.widgetRegistryForTab(props.app.activeTab())} maximize subgraph={hostAction(item)?.action === 'blueprint.armPlacement'} /> })}
        title={item.preview?.title ?? item.title}
        {...(item.preview?.description === undefined ? {} : { description: item.preview.description })}
        {...(place === undefined ? {} : { place })}
        {...(notInstalled ? { flags: [message('search.notInstalled')] } : {})}
      />
    )
  }
  /** Opens over the top bar's search box, which it hides: at the box's top, centred on it, kept inside the window. */
  const placeOverTrigger = () => {
    const box = document.querySelector('[data-testid="topbar-search"]')?.getBoundingClientRect()
    const panel = dialog.querySelector<HTMLElement>('.search-dialog')
    if (box === undefined || panel === null) return
    const room = Math.max(0, (window.innerWidth - panel.offsetWidth) / 2 - 16)
    dialog.style.setProperty('--search-top', `${box.top}px`)
    dialog.style.setProperty('--search-shift', `${Math.min(room, Math.max(-room, box.left + box.width / 2 - window.innerWidth / 2))}px`)
  }
  onMount(() => {
    dialog.showModal()
    placeOverTrigger()
    window.addEventListener('resize', placeOverTrigger)
  })
  onCleanup(() => { live = false; window.removeEventListener('resize', placeOverTrigger); unsubscribeOpen(); unsubscribeTab(); session.dispose(); dialog.close() })
  const activate = async (key: string): Promise<void> => {
    if (activating()) return
    const ref = refs().get(key)
    if (ref === undefined) return
    if (ref.kind === 'more') {
      setExpanded(new Set([...expanded(), ref.group.id]))
      const next = ref.group.results[SHOWN]
      if (next !== undefined) setCurrent(keyOf(ref.group, next))
      return
    }
    const setting = switchSetting(ref.item)
    if (setting !== undefined) {
      props.app.settings.set(setting, !props.app.settings.get<boolean>(setting))
      recordSearchRecent(props.app.settings, `${ref.group.id}:${ref.item.id}`)
      return
    }
    const action = ref.item.action.kind === 'host' ? decodeSearchHostAction(ref.item.action) : ref.item.action
    if (action === undefined) return
    const recentKey = `${ref.group.id}:${ref.item.id}`
    const opensModal = action.kind === 'host'
      && (action.action === 'settings.open' || action.action === 'command.run' || action.action === 'node.previewInstall')
    if (opensModal) {
      const command = action.action === 'command.run' ? props.app.commands.get(action.params.id) : undefined
      if (action.action === 'command.run' && (!command || command.enabled?.() === false)) return
      recordSearchRecent(props.app.settings, recentKey)
      // Unmount/close this native dialog first so it restores focus to the
      // persistent search trigger. The next modal then records that trigger
      // as its own restoration target instead of this disappearing input.
      props.app.searchOpen.set(false)
      queueMicrotask(() => runSearchAction(props.app, action))
      return
    }
    const tab = props.app.activeTab()
    const revision = searchRevision
    setActivating(true)
    try {
      const outcome = runSearchAction(props.app, action)
      const accepted = typeof outcome === 'boolean' ? outcome : await outcome
      if (!accepted || !live || (action.kind === 'command' &&
          (!props.app.searchOpen.get() || props.app.activeTab() !== tab || searchRevision !== revision))) return
      recordSearchRecent(props.app.settings, recentKey)
      props.app.searchOpen.set(false)
    } finally {
      if (live) setActivating(false)
    }
  }
  const status = (): string => {
    const ref = currentRef()
    const count = ready().reduce((sum, group) => sum + group.results.length, 0)
    if (ref === undefined) return typed() ? message('search.empty.detail', { query: query() }) : message('search.empty.nothing')
    const title = ref.kind === 'more' ? message('search.more', { count: ref.group.results.length - SHOWN, kind: ref.group.label.toLocaleLowerCase() }) : ref.item.title
    return `${count} results. ${title}.`
  }
  return (
    <dialog
      ref={dialog}
      class="search-dialog-host"
      aria-modal="true"
      aria-label={message('command.search.open')}
      aria-busy={activating()}
      onClose={() => props.app.searchOpen.set(false)}
      onCancel={() => props.app.searchOpen.set(false)}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault()
          props.app.searchOpen.set(false)
        }
      }}
    >
      <div class="search-dialog" data-testid="universal-search">
        <ProductSearch
          label={message('command.search.open')}
          placeholder={message('command.search.open')}
          query={query()}
          onClose={() => props.app.searchOpen.set(false)}
          onQuery={(text) => {
            if (props.app.searchRegistry.list().some((provider) => provider.prefix === text.charAt(0))) setKind('all')
            setQuery(text)
            setCurrent(undefined)
          }}
          kinds={kinds()}
          kind={kind()}
          onKind={(id) => { setKind(id); setCurrent(undefined) }}
          groups={productGroups()}
          {...(currentKey() === undefined ? {} : { current: currentKey()! })}
          onCurrent={setCurrent}
          onActivate={(key) => { void activate(key) }}
          empty={typed()
            ? { title: message('search.empty.title'), detail: kind() === 'all'
              ? message('search.empty.detail', { query: query() })
              : message('search.empty.kind', { kind: kinds().find((entry) => entry.id === kind())?.label.toLocaleLowerCase() ?? '', query: query() }) }
            : { title: message('search.empty.nothing') }}
          hints={[
            { keys: ['Up', 'Down'], label: message('search.hint.move') },
            { keys: ['Enter'], label: enterHint() },
            { keys: ['Tab'], label: message('search.hint.nextKind') },
            { keys: ['Esc'], label: message('search.hint.close') },
          ]}
          preview={preview()}
          previewPlace="floating"
          status={status()}
          autofocus
          testId="universal-search-surface"
          inputRef={(element) => { element.dataset['testid'] = 'universal-search-input' }}
        />
      </div>
    </dialog>
  )
}
