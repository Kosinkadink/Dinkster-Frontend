import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { localCollectionSource, type Json } from '@dinkster/core'
import type { AssetSelectionOption, DinksterConnection } from '@dinkster/client'
import { CollectionPanel } from '../CollectionPanel.js'
import { ProductButton } from '../ProductControls.js'
import { ProductActionFooter, ProductNotice } from '../ProductForm.js'
import { ProductEmptyState } from '../ProductSurfaces.js'
import { SearchState } from '../SearchSurface.js'

export function AssetSelectionEditor(props: {
  readonly connection: Pick<DinksterConnection, 'listAssetSelections'>
  readonly kind: string
  readonly initial: Json | undefined
  readonly commit: (value: Json) => void
  readonly close: () => void
  readonly browseFiles?: (() => void) | undefined
}) {
  const [options, setOptions] = createSignal<readonly AssetSelectionOption[]>()
  const [error, setError] = createSignal<string>()
  const [selected, setSelected] = createSignal(typeof props.initial === 'string' ? props.initial : undefined)
  let request: AbortController | undefined
  onCleanup(() => request?.abort())
  const refresh = async (): Promise<void> => {
    request?.abort()
    const abort = new AbortController()
    request = abort
    setOptions(undefined)
    setError(undefined)
    try {
      const current = await props.connection.listAssetSelections(props.kind, abort.signal)
      if (!abort.signal.aborted) setOptions(current)
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
    }
  }
  onMount(() => { void refresh() })
  const sources = createMemo(() => [localCollectionSource({
    id: 'source-selections', label: 'Source options',
    corpus: () => (options() ?? []).map((option) => ({
      id: option.name, title: option.name,
      badges: [option.shape === 'literal' ? 'No file' : option.shape === 'pair' ? 'File pair' : option.shape === 'directory' ? 'Directory' : 'File'],
    })),
  })])
  const current = () => options()?.find((option) => option.name === selected())
  return <div class="widget-editor asset-editor widget-modal-editor" data-testid="asset-selection-editor">
    <div class="asset-editor-context"><strong>Source selection</strong><span>{props.kind}</span></div>
    <Show when={error()}>{(message) => <ProductNotice tone="error">{message()}</ProductNotice>}</Show>
    <div class="asset-editor-body">
      <section class="asset-browser-section" aria-label="Source options">
        <Show when={options() !== undefined} fallback={
          <Show when={error() === undefined}><SearchState kind="loading" title="Loading source options" detail="Reading current granted roots." /></Show>
        }>
          <CollectionPanel sources={sources()} variant="select" defaultMode="list" searchPriority="primary"
            searchLabel="Search source options" searchPlaceholder="Search source options"
            pick={{ pickable: () => true, onPick: (entry) => setSelected(entry.id), selected: (entry) => entry.id === selected() }}
            initialSelection={(entry) => entry.id === selected()}
          />
        </Show>
      </section>
      <section class="asset-selection-summary" aria-label="Selection">
        <header class="asset-section-heading"><div><span class="asset-section-eyebrow">Selection</span>
          <h3>{selected() ?? 'Nothing selected'}</h3></div></header>
        <Show when={current()} fallback={<ProductEmptyState title={selected() === undefined
          ? 'Choose a source option from the list.' : 'This option is not currently available under the granted roots.'} />}>
          {(option) => <p>{option().shape === 'literal' ? 'This option opens no file.'
            : option().shape === 'pair' ? 'Both files are resolved together inside one granted root.'
              : option().shape === 'directory' ? 'Read-only directory selection inside a granted root.'
                : 'File selected by its original source name.'}</p>}
        </Show>
      </section>
    </div>
    <ProductActionFooter>
      <ProductButton onClick={() => { void refresh() }}>Refresh</ProductButton>
      <Show when={props.browseFiles}><ProductButton onClick={() => props.browseFiles?.()}>Browse files</ProductButton></Show>
      <ProductButton onClick={props.close}>Cancel</ProductButton>
      <ProductButton variant="primary" disabled={current() === undefined} onClick={() => {
        const option = current()
        if (option !== undefined) props.commit(option.name)
      }}>Use selection</ProductButton>
    </ProductActionFooter>
  </div>
}
