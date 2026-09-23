import { createEffect, createSignal, For, Show } from 'solid-js'
import type { DocsDescriptor, DocsLocaleDescriptor, DinksterConnection } from '@dinkster/client'
import { t, type MessageParams } from '@dinkster/core'
import { Markdown, type MarkdownAssets } from './Markdown.js'
import { selectDocsLocale } from './NodeHelpPanel.js'
import { parseMarkdown, type MarkdownBlock } from './markdownParser.js'
import { ProductButton, ProductTextInput } from '../ProductControls.js'
import { ProductEmptyState } from '../ProductSurfaces.js'

type LearnConnection = Pick<DinksterConnection, 'listDocs' | 'fetchDocsPage' | 'docsAssetUrl'>

export interface LearnBackend {
  readonly id: string
  readonly connection: LearnConnection
}

interface LoadedGuide {
  readonly descriptor: DocsDescriptor
  readonly locale: string
  readonly page: DocsLocaleDescriptor
  readonly blocks: readonly MarkdownBlock[]
  readonly assets: MarkdownAssets
  readonly fallback: boolean
}

type ListState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly guides: readonly DocsDescriptor[]; readonly cursor?: string; readonly loadingMore: boolean }

type GuideState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly guide: LoadedGuide }

export function LearnPanel(props: {
  readonly backend: LearnBackend | undefined
  readonly locale: string
  readonly onOpenTemplate: (pack: string, template: string, title: string, owner: string) => void
}) {
  const [query, setQuery] = createSignal('')
  const [submittedQuery, setSubmittedQuery] = createSignal('')
  const [listState, setListState] = createSignal<ListState>({ kind: 'loading' })
  const [selected, setSelected] = createSignal<DocsDescriptor>()
  const [guideState, setGuideState] = createSignal<GuideState>({ kind: 'loading' })
  let listGeneration = 0
  let guideGeneration = 0

  const message = (key: string, params?: MessageParams): string => {
    props.locale
    return t(key, params)
  }
  const selectedLocale = (descriptor: DocsDescriptor) => selectDocsLocale(descriptor, [props.locale])

  createEffect(() => {
    const backend = props.backend
    const q = submittedQuery()
    const generation = ++listGeneration
    setSelected(undefined)
    if (backend === undefined) {
      setListState({ kind: 'unavailable' })
      return
    }
    setListState({ kind: 'loading' })
    void backend.connection.listDocs({ kind: 'guide', q, limit: 50 }).then((page) => {
      if (generation !== listGeneration) return
      setListState({
        kind: 'loaded',
        guides: page.docs.filter((descriptor) => descriptor.kind === 'guide'),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        loadingMore: false,
      })
    }).catch((error: unknown) => {
      if (generation === listGeneration) setListState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  })

  createEffect(() => {
    const descriptor = selected()
    const backend = props.backend
    const requestedLocale = props.locale
    const generation = ++guideGeneration
    if (descriptor === undefined || backend === undefined) return
    const selection = selectDocsLocale(descriptor, [requestedLocale])
    setGuideState({ kind: 'loading' })
    void backend.connection.fetchDocsPage(descriptor.pack, selection.page.digest).then((markdown) => {
      if (generation !== guideGeneration) return
      if (markdown === undefined) {
        setGuideState({ kind: 'missing' })
        return
      }
      setGuideState({
        kind: 'loaded',
        guide: {
          descriptor,
          locale: selection.locale,
          page: selection.page,
          blocks: parseMarkdown(markdown),
          assets: Object.fromEntries(Object.entries(selection.page.assets).map(([source, asset]) => [source, {
            url: backend.connection.docsAssetUrl(descriptor.pack, asset.digest),
            mediaType: asset.mediaType,
          }])),
          fallback: selection.fallback,
        },
      })
    }).catch((error: unknown) => {
      if (generation === guideGeneration) setGuideState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  })

  const loadMore = (): void => {
    const backend = props.backend
    const current = listState()
    if (backend === undefined || current.kind !== 'loaded' || current.cursor === undefined || current.loadingMore) return
    const generation = listGeneration
    setListState({ ...current, loadingMore: true })
    void backend.connection.listDocs({ kind: 'guide', q: submittedQuery(), limit: 50, cursor: current.cursor }).then((page) => {
      if (generation !== listGeneration) return
      const latest = listState()
      if (latest.kind !== 'loaded') return
      setListState({
        kind: 'loaded',
        guides: [...latest.guides, ...page.docs.filter((descriptor) => descriptor.kind === 'guide')],
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        loadingMore: false,
      })
    }).catch((error: unknown) => {
      if (generation === listGeneration) setListState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    })
  }

  const loadedGuide = (): LoadedGuide | undefined => {
    const state = guideState()
    return state.kind === 'loaded' ? state.guide : undefined
  }
  const loadedList = (): Extract<ListState, { kind: 'loaded' }> | undefined => {
    const state = listState()
    return state.kind === 'loaded' ? state : undefined
  }

  return (
    <div class="rail-panel-body learn-panel" data-testid="learn-panel">
      <Show when={selected() === undefined} fallback={
        <div class="learn-guide">
          <ProductButton type="button" variant="ghost" size="compact" class="learn-back" onClick={() => setSelected(undefined)}>{message('learn.action.back')}</ProductButton>
          <Show when={guideState().kind === 'loading'}><ProductEmptyState tone="loading" title={message('learn.state.loadingGuide')} /></Show>
          <Show when={guideState().kind === 'missing'}><ProductEmptyState tone="error" title={message('learn.state.missing')} /></Show>
          <Show when={guideState().kind === 'error'}><ProductEmptyState tone="error" title={message('learn.state.error', { error: (guideState() as Extract<GuideState, { kind: 'error' }>).message })} /></Show>
          <Show when={loadedGuide()}>{(loaded) => (
            <article lang={loaded().locale}>
              <header class="node-help-header">
                <h1>{loaded().page.title}</h1>
                <p>{loaded().page.summary}</p>
                <div class="learn-metadata">
                  <span class="learn-pack">{loaded().descriptor.pack}</span>
                  <Show when={loaded().descriptor.tags?.length}><span>{loaded().descriptor.tags!.join(' | ')}</span></Show>
                </div>
                <Show when={loaded().fallback}><p class="node-help-fallback" role="status">{message('learn.state.fallback', { locale: loaded().locale })}</p></Show>
              </header>
              <Markdown
                blocks={loaded().blocks}
                assets={loaded().assets}
                templateAction={{
                  label: message('learn.action.openTemplate'),
                  open: (template) => props.onOpenTemplate(
                    loaded().descriptor.pack,
                    template,
                    loaded().page.title,
                    props.backend!.id,
                  ),
                }}
              />
            </article>
          )}</Show>
        </div>
      }>
        <form class="learn-search" onSubmit={(event) => {
          event.preventDefault()
          setSubmittedQuery(query().trim())
        }}>
          <label for="learn-search-input">{message('learn.search.label')}</label>
          <div>
            <ProductTextInput id="learn-search-input" type="search" value={query()} onInput={(event) => setQuery(event.currentTarget.value)} />
            <ProductButton type="submit" variant="primary">{message('learn.action.search')}</ProductButton>
          </div>
        </form>
        <Show when={listState().kind === 'loading'}><ProductEmptyState tone="loading" title={message('learn.state.loading')} /></Show>
        <Show when={listState().kind === 'unavailable'}><ProductEmptyState tone="error" title={message('learn.state.unavailable')} /></Show>
        <Show when={listState().kind === 'error'}><ProductEmptyState tone="error" title={message('learn.state.error', { error: (listState() as Extract<ListState, { kind: 'error' }>).message })} /></Show>
        <Show when={loadedList()}>{(state) => (
          <Show when={state().guides.length > 0} fallback={<ProductEmptyState title={message('learn.state.empty')} />}>
            <div class="learn-guide-list">
              <For each={state().guides}>{(descriptor) => {
                const localized = () => selectedLocale(descriptor)
                return (
                  <ProductButton type="button" variant="ghost" class="learn-guide-card" onClick={() => setSelected(descriptor)}>
                    <strong>{localized().page.title}</strong>
                    <span>{localized().page.summary}</span>
                    <small>{descriptor.pack}</small>
                    <Show when={descriptor.tags?.length}><small>{descriptor.tags!.join(' | ')}</small></Show>
                    <Show when={localized().fallback}><small>{message('learn.state.fallback', { locale: localized().locale })}</small></Show>
                  </ProductButton>
                )}
              }</For>
            </div>
            <Show when={state().cursor}>
              <ProductButton type="button" class="learn-load-more" loading={state().loadingMore} onClick={loadMore}>
                {state().loadingMore ? message('learn.state.loading') : message('learn.action.loadMore')}
              </ProductButton>
            </Show>
          </Show>
        )}</Show>
      </Show>
    </div>
  )
}
