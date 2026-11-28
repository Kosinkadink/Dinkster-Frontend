import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import type { CollectionEntry, WorkflowDocument } from '@dinkster/core'
import type { ModelDownloadRequirement } from '@dinkster/client'
import {
  ProductButton,
  ProductErrorBanner,
  ProductTemplateDetail,
  ProductTemplateDownload,
  ProductTemplatesPage,
  ProductTextButton,
  type ProductTemplateEntry,
} from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { formatByteSize, normalizeTemplateSearch, templatesSource, type TemplateCollectionRef } from './collections.js'
import { lookupAnswersOf } from './lookup-demand.js'
import { useAppMessage } from './locale.js'
import type { ModelDownloadState } from './model-downloads.js'
import { activeProjectId } from './projects.js'
import { WorkflowPicture } from './projects-page/workflow-picture.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { useSignal } from './solid-adapter.js'
import { RemoteTemplateCatalog } from './template-catalog.js'
import { workflowModelOccurrences } from './workflow-asset-locations.js'
import { failureMessage } from './request-failure.js'

const makes = ['image', 'video', 'audio', '3d', 'tool'] as const

/** The real template collection, with page navigation supplied by its tab host. */
export function TemplatesPage(props: {
  readonly app: AppState
  readonly backend?: Extract<Backend, { protocol: 'dinkster' }>
  readonly onOpen: (entry: CollectionEntry) => Promise<boolean>
  readonly onBlank: () => void
  readonly onOpenStorage: () => void
}) {
  const message = useAppMessage()
  const backendTick = useSignal(props.app.backendsTick)
  const activeTabId = useSignal(props.app.activeTabId)
  const settingsTick = useSignal(props.app.settings.changed)
  const downloadTasks = useSignal(props.app.modelDownloadTasks)
  const backend = () => props.backend ?? props.app.libraryBackend()
  const [entries, setEntries] = createSignal<readonly CollectionEntry[]>([])
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal('')
  const [loadFailed, setLoadFailed] = createSignal('')
  const [refresh, setRefresh] = createSignal(0)
  const [group, setGroup] = createSignal('all')
  const [search, setSearch] = createSignal('')
  const [selected, setSelected] = createSignal<string>()
  const [view, setView] = createSignal<'result' | 'workflow'>('result')
  const [opening, setOpening] = createSignal(false)
  const [noFolders, setNoFolders] = createSignal<boolean>()
  const [pictures, setPictures] = createSignal<ReadonlyMap<string, string>>(new Map())
  const [documents, setDocuments] = createSignal<ReadonlyMap<string, WorkflowDocument>>(new Map())
  const bodies = new Map<CollectionEntry, Promise<WorkflowDocument | undefined>>()
  const [requirements, setRequirements] = createSignal<ReadonlyMap<string, readonly ModelDownloadRequirement[]>>(new Map())
  const [states, setStates] = createSignal<ReadonlyMap<string, readonly ModelDownloadState[]>>(new Map())
  const [stopping, setStopping] = createSignal(false)
  const ref = (entry: CollectionEntry) => entry.ref as TemplateCollectionRef
  const available = createMemo(() => {
    backendTick()
    activeTabId()
    const owner = backend()
    return owner !== undefined && props.app.backends.get().includes(owner) && owner.templatesEnabled.get()
  })

  const project = activeProjectId()
  const activeDownloads = (entry: CollectionEntry) => activeProjectId() !== project ? [] :
    (states().get(entry.id) ?? []).filter((row) => row.queued ||
      (row.job && !['completed', 'cancelled', 'failed'].includes(row.job.status)))
  const progress = (entry: CollectionEntry): number | undefined => {
    const active = activeDownloads(entry)
    if (active.length === 0) return undefined
    const total = active.reduce((sum, row) => sum + (row.job?.size ?? (row.plan?.status === 'consent-required' ? row.plan.size : 0)), 0)
    return total === 0 ? 0 : active.reduce((sum, row) => sum + (row.job?.received ?? 0), 0) / total
  }
  const cancellable = (row: ModelDownloadState) => !row.pending && (row.queued ||
    (row.job !== undefined && ['starting', 'checking-existing', 'downloading'].includes(row.job.status)))
  createEffect(() => {
    const owner = backend()
    const wanted = requirements()
    setStates(new Map())
    if (!available() || !owner) return
    const observations = [...wanted].map(([id, models]) => ({ id,
      rows: models.map((model) => useSignal(props.app.modelDownloadStateFor(owner, model, project))),
    }))
    let previous = new Map<string, readonly ModelDownloadState[]>()
    createEffect(() => {
      const next = new Map(observations.map(({ id, rows }) => [id,
        rows.flatMap((read) => { const row = read(); return row ? [row] : [] }),
      ]))
      if ([...next].some(([id, rows]) => rows.some((row) => row.job?.status === 'completed' &&
        previous.get(id)?.some((old) => old.job?.jobId === row.job?.jobId && old.job?.status !== 'completed')))) {
        setRefresh((value) => value + 1)
      }
      previous = next
      setStates(next)
    })
  })
  const stop = async (entry: CollectionEntry): Promise<void> => {
    const owner = backend()
    if (!available() || !owner || stopping() || activeProjectId() !== project) return
    const targets = activeDownloads(entry).filter(cancellable)
    setStopping(true)
    try {
      const transfers = props.app.modelDownloadsFor(owner, project)
      const results = await Promise.allSettled(targets.map((row) => row.queued
        ? transfers.cancel(row.requirement)
        : owner.connection.cancelModelDownload(row.job!.jobId)))
      await transfers.refresh()
      if (live && backend() === owner && (results.some((result) => result.status === 'rejected') ||
        targets.some((row) => props.app.modelDownloadStateFor(owner, row.requirement, project).get()?.error !== undefined))) {
        setLoadFailed('')
        setError(message('templatesPage.stopError'))
      }
    } finally {
      if (live) setStopping(false)
    }
  }

  createEffect(() => {
    backendTick()
    activeTabId()
    settingsTick()
    refresh()
    const owner = backend()
    let live = true
    onCleanup(() => { live = false })
    setEntries([])
    setRequirements(new Map())
    setLoading(true)
    setNoFolders(undefined)
    setError('')
    setLoadFailed('')
    if (!owner?.templatesEnabled.get()) {
      setLoading(false)
      return
    }
    onCleanup(owner.connection.onMountsChanged(() => setRefresh((value) => value + 1)))
    // Groups and search operate on the entire collection, never a truncated first page.
    void templatesSource(props.app, backend).page({ query: '', limit: Number.MAX_SAFE_INTEGER }).then((page) => {
      if (!live) return
      setEntries(page.items)
      setLoading(false)
    }).catch((reason: unknown) => {
      if (!live) return
      setLoadFailed(failureMessage(reason, message('templatesPage.loadFailed')))
      setLoading(false)
    })
    void owner.connection.fetchModelSettings().then((settings) => {
      if (live) setNoFolders(settings.locations.length === 0)
    }).catch((reason: unknown) => {
      if (live) setLoadFailed(failureMessage(reason, message('templatesPage.loadFailed')))
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
      return inGroup(entry, group()) && (query === '' || [template.id, entry.title, entry.description ?? '', family(entry), ...(template.tags ?? [])]
        .some((value) => normalizeTemplateSearch(value).includes(query)))
    })
  })
  const current = () => shown().find((entry) => entry.id === selected()) ?? shown()[0]
  const templateDocument = (entry: CollectionEntry, owner: Extract<Backend, { protocol: 'dinkster' }>): Promise<WorkflowDocument | undefined> => {
    const cached = bodies.get(entry)
    if (cached) return cached
    const source = ref(entry)
    const body = source.kind === 'remote'
      ? new RemoteTemplateCatalog(props.app.settings.get<string>('templates.registryUrl')).fetchBody(source.template)
      : owner.connection.fetchTemplateBody(source.pack, source.id)
    bodies.set(entry, body)
    return body
  }
  createEffect(() => {
    const all = entries()
    const owner = backend()
    let live = true
    onCleanup(() => { live = false })
    bodies.clear()
    setDocuments(new Map())
    if (!owner || !available()) return
    for (const entry of all) {
      void templateDocument(entry, owner).then((document) => {
        if (live && document) setDocuments((previous) => new Map([...previous, [entry.id, document]]))
      }).catch(() => { /* An unavailable workflow keeps its picture area empty. */ })
    }
  })
  const modelRequirements = async (entry: CollectionEntry, owner: Extract<Backend, { protocol: 'dinkster' }>): Promise<readonly ModelDownloadRequirement[]> => {
    const registry = owner.registry.get()
    if (!registry) return []
    const document = await templateDocument(entry, owner)
    if (!document) throw new Error('Template unavailable')
    return [...new Map(workflowModelOccurrences(document, registry.resolve, lookupAnswersOf(owner.lookups))
      .filter((model) => model.valid).map(({ name, kind, asset }) => [JSON.stringify([name, kind, asset?.digest]),
        { name, kind, ...(asset === undefined ? {} : { asset }) }])).values()]
  }
  const downloadingNames = createMemo(() => {
    const owner = backend()
    return [...new Set((owner ? downloadTasks().get(owner) ?? [] : [])
      .map((task) => task.name))].sort().join('\0')
  })
  createEffect(() => {
    const all = entries()
    const owner = backend()
    const names = downloadingNames().split('\0')
    const selected = current()
    let live = true
    if (owner && available()) {
      for (const entry of all.filter((item) => item === selected || ref(item).models.some((model) => names.includes(model.name)))) {
        void modelRequirements(entry, owner).then((models) => {
          if (live) setRequirements((previous) => new Map([...previous, [entry.id, models]]))
        }).catch(() => { /* Opening or reviewing reports an unavailable template. */ })
      }
    }
    onCleanup(() => { live = false })
  })
  const tile = (entry: CollectionEntry): ProductTemplateEntry => ({
    id: entry.id,
    name: entry.title,
    family: family(entry),
    picture: entry.thumbUrl ?? pictures().get(entry.id),
    progress: progress(entry),
    missing: missing(entry).length === 0 ? undefined : amount(entry) ?? message('templatesPage.missingCount', { count: missing(entry).length }),
  })
  const drawing = (entry: ProductTemplateEntry) => {
    return <Show when={documents().get(entry.id)} keyed>{(document) =>
      <WorkflowPicture document={document} resolve={backend()?.registry.get()?.resolve ?? (() => undefined)} widgets={props.app.widgetRegistry} />
    }</Show>
  }
  let live = true
  let review: AbortController | undefined
  let reviewCurrent = () => true
  onCleanup(() => { live = false; review?.abort() })
  createEffect(() => {
    backendTick()
    settingsTick()
    if (!available() || !reviewCurrent()) review?.abort()
  })
  const download = async (entry: CollectionEntry): Promise<void> => {
    const owner = backend()
    const registry = owner?.registry.get()
    if (opening() || !owner || !registry || entry.owner !== owner.id || !available()) return
    review?.abort()
    const controller = new AbortController()
    review = controller
    const previousConsent = props.app.assetConsent.get()
    const project = activeProjectId()
    const current = () => live && !controller.signal.aborted && backend() === owner && available() &&
      owner.registry.get() === registry && activeProjectId() === project
    reviewCurrent = current
    setOpening(true)
    setError('')
    setLoadFailed('')
    try {
      const requirements = await modelRequirements(entry, owner)
      if (!current()) return
      if (requirements.length === 0 || missing(entry).some((model) => !requirements.some((item) => item.name === model.name))) {
        throw new Error('Template has unresolved model requirements')
      }
      if (!current() || props.app.assetConsent.get() !== previousConsent) return
      setRequirements((previous) => new Map([...previous, [entry.id, requirements]]))
      props.app.openModelDownloads(owner, requirements, {
        workflowTitle: entry.title, signal: controller.signal, stillCurrent: current,
        missing: requirements.filter((requirement) => missing(entry).some((model) => model.name === requirement.name)),
      })
    } catch {
      if (current()) setError(message('templatesPage.reviewError', { name: entry.title }))
    } finally {
      if (live) setOpening(false)
    }
  }
  const open = async (id: string): Promise<void> => {
    const entry = entries().find((candidate) => candidate.id === id)
    const owner = backend()
    if (opening() || !entry || !owner || entry.owner !== owner.id || !available()) return
    setOpening(true)
    setError('')
    setLoadFailed('')
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
        {error()}
      </ProductErrorBanner>
    </Show>
    <ProductTemplatesPage
      title={message('templatesPage.title')}
      groups={loading() || loadFailed() ? [] : groups()}
      group={group()}
      onGroup={setGroup}
      searchLabel={message('templatesPage.search')}
      search={search()}
      onSearch={(value) => {
        if (value.trim() !== '' && search().trim() === '') setGroup('all')
        setSearch(value)
      }}
      leave={<ProductButton disabled={opening()} onClick={props.onBlank}>{message('templatesPage.blank')}</ProductButton>}
      templates={loadFailed() ? [] : loading() ? undefined : shown().map(tile)}
      error={loadFailed() ? <ProductEmptyState tone="error" title={loadFailed()} action={
        <ProductButton onClick={() => setRefresh((value) => value + 1)}>{message('templateGallery.retry')}</ProductButton>
      } /> : undefined}
      selected={current()?.id}
      onSelect={(id) => { setSelected(id); setView('result') }}
      onOpen={(id) => { void open(id) }}
      drawing={drawing}
      loadingLabel={message('templateGallery.loading')}
      empty={message(entries().length === 0 ? 'templatesPage.empty' : 'templatesPage.noMatches')}
    >
      <Show when={!loadFailed() && current()}>
        {(entry) => <ProductTemplateDetail
          template={tile(entry())}
          drawing={drawing}
          view={view()}
          onView={setView}
          viewLabels={{ result: message('templatesPage.result'), workflow: message('templatesPage.workflow') }}
          summary={[family(entry()), ...makes.filter((make) => ref(entry()).template.tags?.includes(make)).map((make) => message(`templatesPage.makes.${make}`))].join(' - ')}
          description={entry().description}
          needs={models(entry()).length === 0 ? undefined : {
            label: message('templatesPage.needs'),
            summary: message('templatesPage.hereCount', { count: models(entry()).length - missing(entry()).length, total: models(entry()).length }),
            hereLabel: message('templatesPage.here'),
            missingLabel: message('templatesPage.missing'),
            downloadingLabel: message('templatesPage.downloadingModel'),
            models: models(entry()).map((model) => ({ name: model.name, here: model.here,
              downloading: activeDownloads(entry()).some((row) => row.requirement.name === model.name),
              size: model.size === undefined ? undefined : formatByteSize(model.size) })),
          }}
          facts={[
            { label: message('templatesPage.pack'), value: backend()?.registry.get()?.packs?.get(ref(entry()).template.pack)?.displayName ?? ref(entry()).template.pack },
            { label: message('templatesPage.from'), value: message(ref(entry()).kind === 'remote' ? 'templateGallery.source.remote' : 'templateGallery.source.builtIn') },
          ]}
          actions={<>
            <Show when={missing(entry()).length > 0}>
              <Show when={progress(entry()) !== undefined} fallback={<Show when={noFolders()} fallback={
                <ProductButton disabled={opening() || noFolders() === undefined} onClick={() => { void download(entry()) }}>
                  {message('templatesPage.downloadCount', { count: missing(entry()).length })}
                  <Show when={amount(entry())}>{(size) => <span class="dinkster-template-fact-detail">{size()}</span>}</Show>
                </ProductButton>
              }>
                <span class="dinkster-template-folder">
                  <span class="dinkster-description">{message('templatesPage.noFolder')}</span>
                  <ProductTextButton label={message('templatesPage.openStorage')} onClick={props.onOpenStorage} />
                </span>
              </Show>}>
                <ProductTemplateDownload
                  label={message('templatesPage.downloading', { count: activeDownloads(entry()).length, percent: Math.round(progress(entry())! * 100) })}
                  progress={progress(entry())!}
                  stop={<ProductTextButton label={message('templatesPage.stop')} disabled={stopping() || !activeDownloads(entry()).some(cancellable)} onClick={() => { void stop(entry()) }} />}
                />
              </Show>
            </Show>
            <ProductButton fill="solid" pending={opening()} onClick={() => { void open(entry().id) }}>{message('templatesPage.use')}</ProductButton>
          </>}
        />}
      </Show>
    </ProductTemplatesPage>
  </section></Show>
}
