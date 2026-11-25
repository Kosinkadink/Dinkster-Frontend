import { createEffect, createMemo, createSignal, onCleanup, Show, type JSX } from 'solid-js'
import type { CollectionEntry } from '@dinkster/core'
import {
  ProductButton,
  ProductErrorBanner,
  ProductTemplateDetail,
  ProductTemplatesPage,
  ProductTextButton,
  type ProductTemplateEntry,
} from '@dinkster/ui'
import type { AppState } from './app-state.js'
import { formatByteSize, normalizeTemplateSearch, templatesSource, type TemplateCollectionRef } from './collections.js'
import { useAppMessage } from './locale.js'
import { useSignal } from './solid-adapter.js'

const makes = ['image', 'video', 'audio', '3d', 'tool'] as const

/** The real template collection, with page navigation supplied by its tab host. */
export function TemplatesPage(props: {
  readonly app: AppState
  readonly drawing: (entry: CollectionEntry) => JSX.Element
  readonly onOpen: (entry: CollectionEntry) => Promise<boolean>
  readonly onBlank: () => void
  readonly onOpenStorage: () => void
  readonly onDownload: (entry: CollectionEntry) => void
}) {
  const message = useAppMessage()
  const backendTick = useSignal(props.app.backendsTick)
  const activeTabId = useSignal(props.app.activeTabId)
  const settingsTick = useSignal(props.app.settings.changed)
  const [entries, setEntries] = createSignal<readonly CollectionEntry[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [loadFailed, setLoadFailed] = createSignal(false)
  const [refresh, setRefresh] = createSignal(0)
  const [group, setGroup] = createSignal('all')
  const [search, setSearch] = createSignal('')
  const [selected, setSelected] = createSignal<string>()
  const [view, setView] = createSignal<'result' | 'workflow'>('result')
  const [opening, setOpening] = createSignal(false)
  const [noFolders, setNoFolders] = createSignal<boolean>()
  const [pictures, setPictures] = createSignal<ReadonlyMap<string, string>>(new Map())
  const ref = (entry: CollectionEntry) => entry.ref as TemplateCollectionRef
  const available = createMemo(() => {
    backendTick()
    activeTabId()
    return props.app.libraryBackend()?.templatesEnabled.get() === true
  })

  createEffect(() => {
    backendTick()
    activeTabId()
    settingsTick()
    refresh()
    const backend = props.app.libraryBackend()
    let live = true
    onCleanup(() => { live = false })
    setEntries([])
    setLoading(true)
    setNoFolders(undefined)
    setError('')
    setLoadFailed(false)
    if (!backend?.templatesEnabled.get()) {
      setLoading(false)
      return
    }
    onCleanup(backend.connection.onMountsChanged(() => setRefresh((value) => value + 1)))
    // Groups and search operate on the entire collection, never a truncated first page.
    void templatesSource(props.app).page({ query: '', limit: Number.MAX_SAFE_INTEGER }).then((page) => {
      if (!live) return
      setEntries(page.items)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (!live) return
      setLoadFailed(true)
      setError(message('templateGallery.error', {
        error: reason instanceof Error ? reason.message : String(reason),
      }))
      setLoading(false)
    })
    void backend.connection.fetchModelSettings().then((settings) => {
      if (live) setNoFolders(settings.locations.length === 0)
    }).catch((reason: unknown) => {
      if (live) {
        setLoadFailed(true)
        setError(message('templateGallery.error', {
          error: reason instanceof Error ? reason.message : String(reason),
        }))
      }
    })
  })

  createEffect(() => {
    const all = entries()
    const abort = new AbortController()
    onCleanup(() => abort.abort())
    setPictures(new Map())
    for (const entry of all) {
      if (entry.thumbUrl !== undefined || entry.thumbRender === undefined) continue
      void entry.thumbRender(abort.signal).then((url) => {
        if (!abort.signal.aborted) setPictures((current) => new Map([...current, [entry.id, url]]))
      }).catch(() => { /* A missing result picture falls back to the workflow. */ })
    }
  })

  const models = (entry: CollectionEntry) => ref(entry).models.map((model) => ({
    ...model,
    here: !noFolders() && model.here,
  }))
  const missing = (entry: CollectionEntry) => models(entry).filter((model) => !model.here)
  const amount = (entry: CollectionEntry): string | undefined => {
    const left = missing(entry)
    return left.length > 0 && left.every((model) => model.size !== undefined)
      ? formatByteSize(left.reduce((total, model) => total + model.size!, 0))
      : undefined
  }
  const family = (entry: CollectionEntry) => ref(entry).template.family
    ?? message(ref(entry).models.length === 0 ? 'templatesPage.noModels' : 'templateGallery.family.other')
  const inGroup = (entry: CollectionEntry, id: string): boolean => id === 'all'
    || (id.startsWith('makes:') && (ref(entry).template.tags ?? []).includes(id.slice(6)))
    || id === `family:${family(entry)}`
  const groups = createMemo(() => {
    const all = entries()
    const count = (id: string) => all.filter((entry) => inGroup(entry, id)).length
    const makeRows = makes.map((id) => ({ id: `makes:${id}`, label: message(`templatesPage.makes.${id}`), count: count(`makes:${id}`) }))
      .filter((row) => row.count > 0)
    const families = [...new Set(all.map(family))].sort((a, b) => {
      const none = message('templatesPage.noModels')
      return a === none ? 1 : b === none ? -1 : a.localeCompare(b)
    })
    return [
      { label: message('templatesPage.makes'), rows: [{ id: 'all', label: message('templatesPage.all'), count: all.length }, ...makeRows] },
      ...(all.length === 0 ? [] : [{ label: message('templatesPage.modelFamily'), rows: families.map((label) => ({ id: `family:${label}`, label, count: count(`family:${label}`) })) }]),
    ]
  })
  createEffect(() => {
    if (!groups().some((section) => section.rows.some((row) => row.id === group()))) setGroup('all')
  })
  const shown = createMemo(() => {
    const query = normalizeTemplateSearch(search())
    return entries().filter((entry) => {
      const template = ref(entry).template
      return inGroup(entry, group()) && (query === '' || [template.id, entry.title, entry.subtitle ?? '', family(entry), ...(template.tags ?? [])]
        .some((value) => normalizeTemplateSearch(value).includes(query)))
    })
  })
  const current = () => shown().find((entry) => entry.id === selected()) ?? shown()[0]
  const tile = (entry: CollectionEntry): ProductTemplateEntry => ({
    id: entry.id,
    name: entry.title,
    family: family(entry),
    picture: entry.thumbUrl ?? pictures().get(entry.id),
    missing: missing(entry).length === 0 ? undefined : amount(entry) ?? message('templatesPage.missingCount', { count: missing(entry).length }),
  })
  const drawing = (entry: ProductTemplateEntry) => {
    const source = entries().find((candidate) => candidate.id === entry.id)
    return source === undefined ? undefined : props.drawing(source)
  }
  let live = true
  onCleanup(() => { live = false })
  const open = async (id: string): Promise<void> => {
    const entry = entries().find((candidate) => candidate.id === id)
    const backend = props.app.libraryBackend()
    if (opening() || !entry || !backend || entry.owner !== backend.id || !backend.templatesEnabled.get()) return
    setOpening(true)
    setError('')
    setLoadFailed(false)
    try {
      const opened = await props.onOpen(entry)
      if (live && !opened) setError(message('templateGallery.openError', { name: entry.title }))
    } catch {
      if (live) setError(message('templateGallery.openError', { name: entry.title }))
    } finally {
      if (live) setOpening(false)
    }
  }

  return <Show when={available()}><section class="templates-page dinkster-root" data-testid="templates-page">
    <Show when={error() !== ''}>
      <ProductErrorBanner onDismiss={() => setError('')}>
        {error()}{' '}
        <Show when={loadFailed()}>
          <ProductTextButton label={message('templateGallery.retry')} onClick={() => setRefresh((value) => value + 1)} />
        </Show>
      </ProductErrorBanner>
    </Show>
    <ProductTemplatesPage
      title={message('templatesPage.title')}
      groups={loading() ? [] : groups()}
      group={group()}
      onGroup={setGroup}
      searchLabel={message('templatesPage.search')}
      search={search()}
      onSearch={(value) => {
        if (value.trim() !== '' && search().trim() === '') setGroup('all')
        setSearch(value)
      }}
      leave={<ProductButton disabled={opening()} onClick={props.onBlank}>{message('templatesPage.blank')}</ProductButton>}
      templates={loading() ? undefined : shown().map(tile)}
      selected={current()?.id}
      onSelect={(id) => { setSelected(id); setView('result') }}
      onOpen={(id) => { void open(id) }}
      drawing={drawing}
      loadingLabel={message('templateGallery.loading')}
      empty={message(entries().length === 0 ? 'templatesPage.empty' : 'templatesPage.noMatches')}
    >
      <Show when={current()}>
        {(entry) => <ProductTemplateDetail
          template={tile(entry())}
          drawing={drawing}
          view={view()}
          onView={setView}
          viewLabels={{ result: message('templatesPage.result'), workflow: message('templatesPage.workflow') }}
          summary={[family(entry()), ...makes.filter((make) => ref(entry()).template.tags?.includes(make)).map((make) => message(`templatesPage.makes.${make}`))].join(' - ')}
          description={entry().subtitle}
          needs={models(entry()).length === 0 ? undefined : {
            label: message('templatesPage.needs'),
            summary: message('templatesPage.hereCount', { count: models(entry()).length - missing(entry()).length, total: models(entry()).length }),
            hereLabel: message('templatesPage.here'),
            missingLabel: message('templatesPage.missing'),
            models: models(entry()).map((model) => ({ name: model.name, here: model.here, size: model.size === undefined ? undefined : formatByteSize(model.size) })),
          }}
          facts={[
            { label: message('templatesPage.pack'), value: props.app.libraryBackend()?.registry.get()?.packs?.get(ref(entry()).template.pack)?.displayName ?? ref(entry()).template.pack },
            { label: message('templatesPage.from'), value: message(ref(entry()).kind === 'remote' ? 'templateGallery.source.remote' : 'templateGallery.source.builtIn') },
          ]}
          actions={<>
            <ProductButton fill="solid" pending={opening()} onClick={() => { void open(entry().id) }}>{message('templatesPage.use')}</ProductButton>
            <Show when={missing(entry()).length > 0}>
              <Show when={noFolders()} fallback={
                <ProductButton disabled={opening() || noFolders() === undefined} onClick={() => props.onDownload(entry())}>
                  {message('templatesPage.downloadCount', { count: missing(entry()).length })}
                  <Show when={amount(entry())}>{(size) => <span class="dinkster-template-fact-detail">{size()}</span>}</Show>
                </ProductButton>
              }>
                <span class="dinkster-template-folder">
                  <span class="dinkster-description">{message('templatesPage.noFolder')}</span>
                  <ProductTextButton label={message('templatesPage.openStorage')} onClick={props.onOpenStorage} />
                </span>
              </Show>
            </Show>
          </>}
        />}
      </Show>
    </ProductTemplatesPage>
  </section></Show>
}
