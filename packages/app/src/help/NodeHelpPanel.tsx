import { createEffect, createSignal, Show } from 'solid-js'
import type { DocsDescriptor, DocsLocaleDescriptor } from '@dinkster/client'
import { t, type MessageParams } from '@dinkster/core'
import type { AppState } from '../app-state.js'
import { useSignal } from '../solid-adapter.js'
import { Markdown, type MarkdownAssets } from './Markdown.js'
import { parseMarkdown, type MarkdownBlock } from './markdownParser.js'

interface LoadedHelp {
  readonly descriptor: DocsDescriptor
  readonly locale: string
  readonly page: DocsLocaleDescriptor
  readonly blocks: readonly MarkdownBlock[]
  readonly assets: MarkdownAssets
  readonly stale: boolean
  readonly fallbackFrom?: string
}

type HelpState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'missing'; readonly message: string }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly value: LoadedHelp }

export function selectDocsLocale(
  descriptor: DocsDescriptor,
  requested: readonly string[],
): { readonly locale: string; readonly page: DocsLocaleDescriptor; readonly fallback: boolean } {
  const locales = Object.keys(descriptor.locales)
  const normalize = (locale: string): string => locale.toLowerCase().replaceAll('_', '-')
  for (const candidate of requested) {
    const normalized = normalize(candidate)
    const exact = locales.find((locale) => normalize(locale) === normalized)
    if (exact !== undefined) return { locale: exact, page: descriptor.locales[exact]!, fallback: false }
    const language = normalized.split('-', 1)[0]!
    const base = locales.find((locale) => normalize(locale) === language)
    if (base !== undefined) return { locale: base, page: descriptor.locales[base]!, fallback: false }
    const regional = locales.find((locale) => normalize(locale).split('-', 1)[0] === language)
    if (regional !== undefined) return { locale: regional, page: descriptor.locales[regional]!, fallback: false }
  }
  return { locale: descriptor.defaultLocale, page: descriptor.locales[descriptor.defaultLocale]!, fallback: true }
}

export function NodeHelpPanel(props: { readonly app: AppState; readonly locale: string }) {
  const request = useSignal(props.app.nodeHelpRequest)
  const [state, setState] = createSignal<HelpState>({ kind: 'idle' })
  const message = (key: string, params?: MessageParams): string => {
    props.locale
    return t(key, params)
  }
  let generation = 0

  createEffect(() => {
    const target = request()
    const requestedLocale = props.locale
    const current = ++generation
    if (target === undefined) {
      setState({ kind: 'idle' })
      return
    }
    const backend = props.app.backendFor(target.backendId)
    if (backend?.protocol !== 'dinkster') {
      setState({ kind: 'missing', message: message('nodeHelp.state.disconnected') })
      return
    }
    setState({ kind: 'loading' })
    void backend.connection.listDocs({ kind: 'node', pack: target.pack, id: target.nodeType, limit: 1 })
      .then(async (page) => {
        const descriptor = page.docs.find((entry) =>
          entry.kind === 'node' && entry.pack === target.pack && entry.id === target.nodeType)
        if (descriptor === undefined) return undefined
        const selected = selectDocsLocale(descriptor, [requestedLocale])
        const markdown = await backend.connection.fetchDocsPage(descriptor.pack, selected.page.digest)
        if (markdown === undefined) return undefined
        const assets = Object.fromEntries(Object.entries(selected.page.assets).map(([source, asset]) => [source, {
          url: backend.connection.docsAssetUrl(descriptor.pack, asset.digest),
          mediaType: asset.mediaType,
        }]))
        const dinkster = backend.registry.get()?.resolve(target.nodeType)?.ext?.['dinkster']
        const schemaVersion = typeof dinkster === 'object' && dinkster !== null && typeof (dinkster as { version?: unknown }).version === 'number'
          ? (dinkster as { version: number }).version
          : undefined
        return {
          descriptor,
          locale: selected.locale,
          page: selected.page,
          blocks: parseMarkdown(markdown),
          assets,
          stale: selected.page.schemaVersion !== undefined && schemaVersion !== undefined && selected.page.schemaVersion < schemaVersion,
          ...(selected.fallback ? { fallbackFrom: requestedLocale } : {}),
        } satisfies LoadedHelp
      })
      .then((loaded) => {
        if (generation !== current) return
        setState(loaded === undefined
          ? { kind: 'missing', message: message('nodeHelp.state.missing') }
          : { kind: 'loaded', value: loaded })
      })
      .catch((error: unknown) => {
        if (generation === current) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      })
  })

  const loadedState = (): LoadedHelp | undefined => {
    const current = state()
    return current.kind === 'loaded' ? current.value : undefined
  }

  return (
    <div class="rail-panel-body node-help-panel" data-testid="node-help-panel">
      <Show when={state().kind === 'idle'}><p class="node-help-state">{message('nodeHelp.state.idle')}</p></Show>
      <Show when={state().kind === 'loading'}><p class="node-help-state" role="status">{message('nodeHelp.state.loading')}</p></Show>
      <Show when={state().kind === 'missing' || state().kind === 'error'}>
        <p class="node-help-state" role="alert">{(state() as Extract<HelpState, { kind: 'missing' | 'error' }>).message}</p>
      </Show>
      <Show when={loadedState()}>{(loaded) => (
        <article lang={loaded().locale}>
          <header class="node-help-header">
            <h1>{loaded().page.title}</h1>
            <p>{loaded().page.summary}</p>
            <Show when={loaded().fallbackFrom}>{(locale) => <p class="node-help-fallback" role="status">{message('nodeHelp.state.fallback', { locale: loaded().locale.toLowerCase().startsWith('en') ? message('settings.language.option.en') : loaded().locale, requestedLocale: locale() })}</p>}</Show>
            <Show when={loaded().stale}><p class="node-help-warning" role="status">{message('nodeHelp.state.stale')}</p></Show>
          </header>
          <Markdown blocks={loaded().blocks} assets={loaded().assets} />
        </article>
      )}</Show>
    </div>
  )
}
