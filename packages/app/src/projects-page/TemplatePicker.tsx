import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import type { CollectionEntry, SchemaResolver, WorkflowDocument } from '@dinkster/core'
import { ProductButton, ProductErrorBanner, ProductTemplateDetail, ProductTemplatesPage, type ProductTemplateEntry } from '@dinkster/ui'
import { normalizeTemplateSearch, type TemplateCollectionRef } from '../collections.js'
import { useAppMessage } from '../locale.js'
import { WorkflowPicture } from './workflow-picture.js'

export interface ProjectTemplateCatalog {
  readonly entries: readonly CollectionEntry[]
  readonly resolve: SchemaResolver
  document(entry: CollectionEntry): Promise<WorkflowDocument | undefined>
}

export interface ProjectTemplateChoice {
  readonly pack: string
  readonly id: string
  readonly name: string
  readonly digest: string
  readonly document: WorkflowDocument
}

/** Browsing only: choosing a template returns its document, never acquires models. */
export function TemplatePicker(props: {
  readonly catalog: ProjectTemplateCatalog
  readonly initial?: Pick<ProjectTemplateChoice, 'pack' | 'id'> | undefined
  readonly drawing: (document: WorkflowDocument, resolve: SchemaResolver) => ReturnType<typeof WorkflowPicture>
  readonly onChoose: (choice: ProjectTemplateChoice) => Promise<void>
  readonly onCancel: () => void
}) {
  const message = useAppMessage()
  const [search, setSearch] = createSignal('')
  const [group, setGroup] = createSignal('all')
  const [selected, setSelected] = createSignal<string>()
  const [view, setView] = createSignal<'result' | 'workflow'>('result')
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal('')
  const [documents, setDocuments] = createSignal<ReadonlyMap<string, WorkflowDocument>>(new Map())
  const [pictures, setPictures] = createSignal<ReadonlyMap<string, string>>(new Map())
  const bodies = new Map<CollectionEntry, Promise<WorkflowDocument | undefined>>()
  let live = true
  onCleanup(() => { live = false })
  const ref = (entry: CollectionEntry) => entry.ref as TemplateCollectionRef
  const family = (entry: CollectionEntry) => ref(entry).template.family ?? message('templateGallery.family.other')
  const inGroup = (entry: CollectionEntry, id: string) => id === 'all' || id === `family:${family(entry)}`
    || (id.startsWith('makes:') && ref(entry).template.tags?.includes(id.slice(6)) === true)
  const groups = createMemo(() => {
    const entries = props.catalog.entries
    const count = (id: string) => entries.filter((entry) => inGroup(entry, id)).length
    return [
      { label: message('templatesPage.makes'), rows: [
        { id: 'all', label: message('templatesPage.all'), count: entries.length },
        ...['image', 'video', 'audio', '3d', 'tool'].map((make) => ({ id: `makes:${make}`, label: message(`templatesPage.makes.${make}`), count: count(`makes:${make}`) }))
          .filter((row) => row.count > 0),
      ] },
      ...(entries.length === 0 ? [] : [{ label: message('templatesPage.modelFamily'), rows: [...new Set(entries.map(family))].sort().map((label) => ({ id: `family:${label}`, label, count: count(`family:${label}`) })) }]),
    ]
  })
  const shown = createMemo(() => props.catalog.entries.filter((entry) => inGroup(entry, group()) &&
    normalizeTemplateSearch([entry.title, entry.description, family(entry), ...(ref(entry).template.tags ?? [])].join(' ')).includes(normalizeTemplateSearch(search()))))
  const current = () => shown().find((entry) => entry.id === selected())
    ?? shown().find((entry) => ref(entry).template.pack === props.initial?.pack && ref(entry).template.id === props.initial.id)
    ?? shown()[0]
  const document = (entry: CollectionEntry) => {
    let body = bodies.get(entry)
    if (!body) {
      body = props.catalog.document(entry).then((value) => {
        if (!value) bodies.delete(entry)
        return value
      }, (reason: unknown) => {
        bodies.delete(entry)
        throw reason
      })
      bodies.set(entry, body)
    }
    return body
  }
  createEffect(() => {
    const entries = props.catalog.entries
    const abort = new AbortController()
    onCleanup(() => abort.abort())
    setDocuments(new Map())
    setPictures(new Map())
    for (const entry of entries) {
      if (entry.thumbUrl === undefined && entry.thumbRender) {
        void entry.thumbRender(abort.signal).then((url) => {
          if (!abort.signal.aborted) setPictures((previous) => new Map([...previous, [entry.id, url]]))
        }).catch(() => { /* A missing picture falls back to the workflow. */ })
      }
      void document(entry).then((body) => {
        if (!abort.signal.aborted && body) setDocuments((previous) => new Map([...previous, [entry.id, body]]))
      }).catch(() => { /* Choosing reports an unavailable document. */ })
    }
  })
  const tile = (entry: CollectionEntry): ProductTemplateEntry => ({ id: entry.id, name: entry.title, family: family(entry), picture: entry.thumbUrl ?? pictures().get(entry.id) })
  const drawing = (entry: ProductTemplateEntry) => <Show when={documents().get(entry.id)} keyed>{(body) => props.drawing(body, props.catalog.resolve)}</Show>
  const choose = async (entry: CollectionEntry) => {
    if (pending()) return
    setPending(true)
    setError('')
    try {
      const body = await document(entry)
      if (!live) return
      if (!body) throw new Error('Template unavailable')
      await props.onChoose({ pack: ref(entry).template.pack, id: ref(entry).template.id, name: entry.title, digest: ref(entry).template.digest, document: body })
    } catch {
      if (live) setError(message('templateGallery.openError', { name: entry.title }))
    } finally {
      if (live) setPending(false)
    }
  }
  return <section class="templates-page dinkster-root" data-testid="project-template-picker">
    <Show when={error()}><ProductErrorBanner onDismiss={() => setError('')}>{error()}</ProductErrorBanner></Show>
    <ProductTemplatesPage title={message('projects.new.chooseTemplate')} groups={groups()} group={group()} onGroup={setGroup}
      onCancel={props.onCancel} pending={pending()}
      searchLabel={message('templatesPage.search')} search={search()} onSearch={(value) => { if (search().trim() === '' && value.trim() !== '') setGroup('all'); setSearch(value) }}
      leave={<ProductButton disabled={pending()} onClick={props.onCancel}>{message('projects.action.cancel')}</ProductButton>}
      templates={shown().map(tile)} selected={current()?.id} onSelect={(id) => { setSelected(id); setView('result') }}
      onOpen={(id) => { const entry = shown().find((entry) => entry.id === id); if (entry) void choose(entry) }} drawing={drawing}
      loadingLabel={message('templateGallery.loading')} empty={message(props.catalog.entries.length === 0 ? 'templatesPage.empty' : 'templatesPage.noMatches')}>
      <Show when={current()}>{(entry) => <ProductTemplateDetail template={tile(entry())} drawing={drawing} view={view()} onView={setView}
        viewLabels={{ result: message('templatesPage.result'), workflow: message('templatesPage.workflow') }}
        summary={family(entry())} description={entry().description}
        facts={[{ label: message('templatesPage.pack'), value: ref(entry()).template.pack }]}
        actions={<ProductButton fill="solid" pending={pending()} onClick={() => { void choose(entry()) }}>{message('templatesPage.use')}</ProductButton>} />}</Show>
    </ProductTemplatesPage>
  </section>
}
