import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import type { DinksterConnection, MountDescriptor } from '@dinkster/client'
import type { CollectionPageRequest, CollectionSource, MessageParams } from '@dinkster/core'
import { ProductSegmented, ProductTextButton } from '@dinkster/ui'
import { CollectionPanel, type CollectionPanelState } from './CollectionPanel.js'
import { assetCollectionSource } from './asset-browser/collection-adapter.js'
import { VIEW_PREFERENCE_KEY } from './asset-browser/helpers.js'
import { mountAssetSource } from './asset-browser/mountAssetSource.js'
import { AssetEntryFallback } from './asset-browser/presentation.js'
import { AssetEntrySelection } from './asset-browser/rail.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductButton } from './ProductControls.js'
import { ProductNotice } from './ProductForm.js'
import { ProductEmptyState } from './ProductSurfaces.js'

type AssetMessage = (key: string, params?: MessageParams) => string

function assetState(state: CollectionPanelState, message: AssetMessage) {
  if (state.kind === 'loading') return <ProductEmptyState tone="loading" title={message('assets.state.loading.title')} />
  if (state.kind === 'error') return <ProductEmptyState tone="error" title={message('assets.state.error.title')} hint={state.message} />
  if (state.kind === 'no-match') return <ProductEmptyState title={message('assets.state.noMatch.title')} hint={message('assets.state.noMatch.detail')} />
  return <ProductEmptyState title={message('assets.state.empty.title')} hint={message('assets.state.empty.detail', { source: state.sourceLabel })} />
}

export function AssetsBody(props: { readonly connection: DinksterConnection; readonly backendId: string; readonly baseUrl?: string; readonly backendLabel?: string; readonly onOpenStorage?: () => void }) {
  const message = useAppMessage()
  const [mounts, setMounts] = createSignal<readonly MountDescriptor[]>([])
  const [loading, setLoading] = createSignal(true)
  const [discoveryError, setDiscoveryError] = createSignal<string>()
  const [retryTick, setRetryTick] = createSignal(0)
  const [refreshTick, setRefreshTick] = createSignal(0)
  const [outputUnconfigured, setOutputUnconfigured] = createSignal(false)
  const [recursive, setRecursive] = createSignal(true)
  const [sort, setSort] = createSignal<NonNullable<CollectionPageRequest['sort']>>('newest')

  createEffect(() => {
    retryTick()
    const connection = props.connection
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let generation = 0
    let scanning = false
    setMounts([]); setLoading(true); setDiscoveryError(undefined); setOutputUnconfigured(false)
    const discover = async (): Promise<void> => {
      const request = ++generation
      if (timer !== undefined) clearTimeout(timer)
      try {
        const settings = await connection.fetchMountSettings()
        if (!active || request !== generation) return
        const available = settings.mounts.filter((mount) => !mount.kind?.startsWith('model/')
          && (mount.state === 'ready' || mount.state === 'scanning'))
        setMounts(available)
        setOutputUnconfigured(settings.outputMount === undefined)
        setDiscoveryError(undefined)
        setLoading(false)
        scanning = settings.mounts.some((mount) => !mount.kind?.startsWith('model/')
          && (mount.state === 'pending' || mount.state === 'scanning'))
        if (scanning) {
          timer = setTimeout(() => { void discover() }, 1000)
        }
      } catch (reason: unknown) {
        if (!active || request !== generation) return
        setDiscoveryError(reason instanceof Error ? reason.message : String(reason))
        setLoading(false)
        if (scanning) timer = setTimeout(() => { void discover() }, 1000)
      }
    }
    const unsubscribe = connection.onEvent((event) => {
      if (event.kind === 'nodeOutput' || event.kind === 'completed') setRefreshTick((tick) => tick + 1)
    })
    const unsubscribeMounts = connection.onMountsChanged(() => { void discover() })
    void discover()
    onCleanup(() => {
      active = false
      unsubscribe(); unsubscribeMounts()
      if (timer !== undefined) clearTimeout(timer)
    })
  })

  const adapters = createMemo(() => [
    mountAssetSource(props.connection, mounts().map((mount) => mount.id)),
    ...mounts().map((mount) => mountAssetSource(props.connection, mount.id)),
  ])
  const sources = createMemo((): readonly CollectionSource[] => adapters().map((adapter) => ({
    ...assetCollectionSource(adapter, { assetUrl: (digest) => props.connection.assetUrl(digest) }),
    label: adapter.id === 'all-mounts' ? message('assets.mounts.all') : adapter.label,
    filters: [],
  })))

  return <div class="assets-panel" data-testid="assets-overlay">
    <Show when={outputUnconfigured()}>
      <ProductNotice tone="info" testId="assets-output-unconfigured">
        {message('assets.output.none')}
        <ProductTextButton label={message('assets.storage.open')} onClick={() => props.onOpenStorage?.()} />
      </ProductNotice>
    </Show>
    <Show when={discoveryError()}>
      <ProductNotice tone="error" testId="assets-error">{discoveryError()}</ProductNotice>
      <ProductButton data-testid="assets-retry" onClick={() => setRetryTick((tick) => tick + 1)}>{message('templateGallery.retry')}</ProductButton>
    </Show>
    <Show when={mounts().some((mount) => mount.state === 'scanning')}>
      <ProductNotice tone="status" testId="assets-reading-folder">{message('assets.readingFolder')}</ProductNotice>
    </Show>
    <Show when={!loading()} fallback={<ProductEmptyState tone="loading" title={message('assets.state.loading.title')} />}>
      <CollectionPanel sources={sources()} pageSize={60} pagination="scroll" recursive={recursive()} sort={sort()}
        refreshTick={refreshTick} modeKey={VIEW_PREFERENCE_KEY} searchPriority="primary"
        searchLabel={message('assets.search')} searchPlaceholder={message('assets.search')}
        toolbarActions={<ProductSelect testId="asset-sort-select" ariaLabel={message('assets.order.label')} selectedId={sort()}
          options={(['newest', 'name', 'path'] as const).map((value) => ({ id: value, label: message(`assets.order.${value}`), value }))}
          onSelect={(option) => setSort(option.value)} />}
        navigation={({ selectedId, select, folder, navigate, mode, setMode }) => <>
          <nav class="asset-path" aria-label={message('collection.folder.ariaLabel')}>
            <ProductSelect class="asset-source-select" testId="asset-source-select" ariaLabel={message('assets.mounts.label')}
              selectedId={selectedId()} options={sources().map((source) => ({ id: source.id, label: source.label, value: source.id }))}
              onSelect={(option) => { setRecursive(true); select(option.value) }} />
            <For each={folder().split('/').filter(Boolean)}>{(part, index) => <>
              <span aria-hidden="true">/</span>
              <ProductTextButton label={part} aria-current={index() === folder().split('/').length - 1 ? 'page' : undefined}
                onClick={() => navigate(folder().split('/').slice(0, index() + 1).join('/'))} />
            </>}</For>
            <ProductSegmented label={message('assets.view.label')} value={mode()} onChange={(value) => setMode(value as 'list' | 'grid')}
              options={[{ value: 'list', label: message('assets.view.names') }, { value: 'grid', label: message('assets.view.pictures') }]} />
          </nav>
          <Show when={selectedId() !== 'all-mounts'}>
            <ProductSegmented label={message('assets.depth.label')} value={String(recursive())} onChange={(value) => setRecursive(value === 'true')}
              options={[{ value: 'false', label: message('assets.depth.this') }, { value: 'true', label: message('assets.depth.subfolders') }]} />
          </Show>
          <p class="asset-scope" data-testid="asset-scope">{message(recursive() ? 'assets.scope.subfolders' : 'assets.scope.this', {
            path: `${selectedId() === 'all-mounts' ? message('assets.mounts.all') : selectedId().slice('mount:'.length)}${folder() ? `/${folder()}` : ''}`,
          })}</p>
        </>}
        renderState={(state) => assetState(state, message)} entryFallback={(entry) => <AssetEntryFallback entry={entry} />}
        detailPlacement="inline" detailRail={(entry) => <Show when={entry}>{(selected) => <AssetEntrySelection entry={selected()} adapters={adapters()}
          backendId={props.backendId} connection={props.connection} backendUrl={props.baseUrl ?? ''} backendLabel={props.backendLabel} />}</Show>}
      />
    </Show>
  </div>
}
