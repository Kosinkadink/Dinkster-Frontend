import { createEffect, createMemo, createSignal, createUniqueId, For, Show } from 'solid-js'
import type { CollectionEntry } from '@dinkster/core'
import type { MountSettings } from '@dinkster/client'
import type { AppState } from './app-state.js'
import { initialsOf, templatesSource, type TemplateCollectionRef } from './collections.js'
import { ModalSurface } from './ModalSurface.js'
import { MountFolderForm } from './MountFolderForm.js'
import { useAppMessage } from './locale.js'
import { ProductButton } from './ProductControls.js'
import { ProductActionFooter } from './ProductForm.js'
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
  const [failedEntry, setFailedEntry] = createSignal(undefined as CollectionEntry | undefined)
  const [refresh, setRefresh] = createSignal(0)
  const resultsId = createUniqueId()
  const searchDescriptionId = createUniqueId()
  let request = 0

  createEffect(() => {
    if (!props.visible()) return
    backendTick()
    settingsTick()
    refresh()
    const generation = ++request
    setLoading(true)
    setError('')
    setFailedEntry(undefined)
    void templatesSource(props.app).page({ query: query(), limit: 500 }).then((page) => {
      if (generation !== request) return
      setEntries(page.items)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (generation !== request) return
      setEntries([])
      setError(message('templateGallery.error', {
        error: reason instanceof Error ? reason.message : String(reason),
      }))
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

  const mountConnection = createMemo(() => props.app.libraryBackend()?.connection)
  const [mountSettings, setMountSettings] = createSignal<MountSettings>()
  const [mountRefresh, setMountRefresh] = createSignal(0)
  let mountRequest = 0

  createEffect(() => {
    if (!props.visible()) return
    backendTick()
    mountRefresh()
    const connection = mountConnection()
    if (!connection) return
    const generation = ++mountRequest
    void connection.fetchMountSettings().then((settings) => {
      if (generation !== mountRequest) return
      setMountSettings(settings)
    }).catch(() => {
      if (generation !== mountRequest) return
      setMountSettings(undefined)
    })
  })

  const mountsEmpty = (): boolean => mountSettings()?.mounts.length === 0
  const allowedMountConnection = createMemo(() =>
    mountSettings()?.mountChangesAllowed === true ? mountConnection() : undefined)

  function open(entry: CollectionEntry): void {
    setError('')
    setFailedEntry(undefined)
    const ref = entry.ref as TemplateCollectionRef | undefined
    const opening = ref?.kind === 'remote'
      ? props.app.openRemoteTemplate(ref.template, entry.title)
      : ref?.kind === 'local' && entry.owner !== undefined
        ? props.app.openTemplate(ref.pack, ref.id, entry.title, entry.owner)
        : Promise.resolve(false)
    void opening.then((opened) => {
      if (opened) {
        props.onClose()
      } else {
        setFailedEntry(entry)
        setError(message('templateGallery.openError', { name: entry.title }))
      }
    })
  }

  const retry = (): void => {
    const entry = failedEntry()
    if (entry === undefined) setRefresh((value) => value + 1)
    else open(entry)
  }

  return (
    <Show when={props.visible()}>
      <ModalSurface
        title={message('templateGallery.title')}
        ariaLabel={message('templateGallery.ariaLabel')}
        modalId="template-gallery"
        testId="template-gallery"
        closeLabel={message('templateGallery.close')}
        onRequestClose={props.onClose}
      >
      <section class="template-gallery-content">
        <header class="template-gallery-header">
          <div>
            <span class="template-gallery-kicker">{message('templateGallery.kicker')}</span>
            <p>{message('templateGallery.description')}</p>
          </div>
          <ProductActionFooter class="template-gallery-actions">
            <ProductButton type="button" variant="primary" class="primary" onClick={props.onClose}>{message('templateGallery.blankCanvas')}</ProductButton>
          </ProductActionFooter>
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
          <Show when={error() !== ''}>
            <div class="template-gallery-error">
              <p class="template-gallery-state" role="alert">{error()}</p>
              <ProductActionFooter>
                <ProductButton type="button" onClick={retry}>{message('templateGallery.retry')}</ProductButton>
              </ProductActionFooter>
            </div>
          </Show>
          <Show when={!loading() && error() === '' && families().length === 0}>
            <p class="template-gallery-state">{message(query().trim() === '' ? 'templateGallery.empty' : 'templateGallery.noMatches')}</p>
          </Show>
          <Show when={!loading() && error() === '' && mountsEmpty()}>
            <div class="template-gallery-mounts">
              <p class="template-gallery-state">{message('desktopManagement.folders.description')}</p>
              <Show when={allowedMountConnection()}>
                {(connection) => <MountFolderForm connection={connection()} onGranted={() => setMountRefresh((value) => value + 1)} />}
              </Show>
            </div>
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
      </ModalSurface>
    </Show>
  )
}
