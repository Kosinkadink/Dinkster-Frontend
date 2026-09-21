import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from 'solid-js'
import type { CollectionEntry } from '@dinkster/core'
import type { AppState } from './app-state.js'
import { initialsOf, templatesSource, type TemplateCollectionRef } from './collections.js'
import { useAppMessage } from './locale.js'
import { SearchInput } from './SearchSurface.js'
import { useSignal } from './solid-adapter.js'

interface TemplateFamily {
  readonly id: string
  readonly entries: readonly CollectionEntry[]
}

const detail = (entry: CollectionEntry, label: string): string | undefined =>
  entry.details?.find((item) => item.label === label)?.text

const missingModels = (entry: CollectionEntry): readonly string[] =>
  entry.details?.filter((item) => item.label === 'model missing').map((item) => item.text) ?? []

export function TemplateGallery(props: {
  readonly app: AppState
  readonly visible: () => boolean
  readonly onClose: () => void
}) {
  const message = useAppMessage()
  const backendTick = useSignal(props.app.backendsTick)
  const settingsTick = useSignal(props.app.settings.changed)
  const [entries, setEntries] = createSignal<readonly CollectionEntry[]>([])
  const [query, setQuery] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal('')
  const resultsId = createUniqueId()
  const searchDescriptionId = createUniqueId()
  let request = 0

  createEffect(() => {
    if (!props.visible()) return
    backendTick()
    settingsTick()
    const generation = ++request
    setLoading(true)
    setError('')
    void templatesSource(props.app).page({ query: query(), limit: 500 }).then((page) => {
      if (generation !== request) return
      setEntries(page.items)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (generation !== request) return
      setEntries([])
      setError(reason instanceof Error ? reason.message : String(reason))
      setLoading(false)
    })
  })

  const families = createMemo<readonly TemplateFamily[]>(() => {
    const grouped = new Map<string, CollectionEntry[]>()
    for (const entry of entries()) {
      const family = detail(entry, 'family') ?? message('templateGallery.family.other')
      const group = grouped.get(family) ?? []
      group.push(entry)
      grouped.set(family, group)
    }
    return [...grouped].map(([id, familyEntries]) => ({ id, entries: familyEntries }))
  })

  const open = (entry: CollectionEntry): void => {
    const ref = entry.ref as TemplateCollectionRef | undefined
    const opening = ref?.kind === 'remote'
      ? props.app.openRemoteTemplate(ref.template, entry.title)
      : ref?.kind === 'local' && entry.owner !== undefined
        ? props.app.openTemplate(ref.pack, ref.id, entry.title, entry.owner)
        : Promise.resolve(false)
    void opening.then((opened) => {
      if (opened) props.onClose()
    })
  }

  return (
    <Show when={props.visible()}>
      <section class="template-gallery" aria-label={message('templateGallery.ariaLabel')} data-testid="template-gallery">
        <header class="template-gallery-header">
          <div>
            <span class="template-gallery-kicker">{message('templateGallery.kicker')}</span>
            <h2>{message('templateGallery.title')}</h2>
            <p>{message('templateGallery.description')}</p>
          </div>
          <button type="button" class="template-gallery-close" onClick={props.onClose} aria-label={message('templateGallery.close')}>
            {message('templateGallery.blankCanvas')}
          </button>
        </header>
        <div class="template-gallery-body">
          <div class="template-gallery-search">
            <SearchInput
              value={query()}
              placeholder={message('templateGallery.search.placeholder')}
              controls={resultsId}
              describedBy={searchDescriptionId}
              busy={loading()}
              ariaLabel={message('templateGallery.search.label')}
              testId="template-gallery-search"
              clearTestId="template-gallery-search-clear"
              onClear={() => setQuery('')}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query() !== '') {
                  event.preventDefault()
                  setQuery('')
                }
              }}
            />
            <span id={searchDescriptionId} class="collection-search-description">
              {message('templateGallery.search.description')}
            </span>
          </div>
          <Show when={loading()}><p class="template-gallery-state" role="status">{message('templateGallery.loading')}</p></Show>
          <Show when={error() !== ''}><p class="template-gallery-state" role="alert">{message('templateGallery.error', { error: error() })}</p></Show>
          <Show when={!loading() && error() === '' && families().length === 0}>
            <p class="template-gallery-state">{message(query().trim() === '' ? 'templateGallery.empty' : 'templateGallery.noMatches')}</p>
          </Show>
          <div id={resultsId} role="listbox" aria-label={message('templateGallery.results')}>
            <For each={families()}>
              {(family) => (
                <section class="template-family" data-family={family.id}>
                  <h3>{family.id}</h3>
                  <div class="template-family-grid">
                    <For each={family.entries}>
                      {(entry) => {
                        function missing(): readonly string[] { return missingModels(entry) }
                        const source = entry.badges?.includes('remote') === true
                          ? message('templateGallery.source.remote')
                          : message('templateGallery.source.builtIn')
                        return (
                          <button type="button" class="template-card" role="option" aria-selected="false" onClick={() => open(entry)} data-testid="template-card">
                            <span class="template-card-image">
                              <Show when={entry.thumbUrl} fallback={<span class="template-card-initials">{initialsOf(entry.title)}</span>}>
                                {(url) => <img src={url()} alt="" loading="lazy" />}
                              </Show>
                              <span class="template-card-source">{source}</span>
                            </span>
                            <span class="template-card-copy">
                              <strong>{entry.title}</strong>
                              <Show when={entry.subtitle}>{(subtitle) => <small>{subtitle()}</small>}</Show>
                              <Show when={missing().length > 0}>
                                <span class="template-card-missing">
                                  {message('templateGallery.modelsMissing', { count: missing().length })}
                                  <small>{missing().join(', ')}</small>
                                </span>
                              </Show>
                            </span>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
        </div>
      </section>
    </Show>
  )
}
