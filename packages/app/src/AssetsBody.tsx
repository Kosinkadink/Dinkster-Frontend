import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { failureMessage } from './request-failure.js'
import type { DinksterConnection, MountDescriptor } from '@dinkster/client'
import type { CollectionPageRequest, CollectionSource, MessageParams } from '@dinkster/core'
import { ProductErrorBanner, ProductNotice, ProductProgress, ProductTextButton } from '@dinkster/ui'
import { CollectionPanel, type CollectionPanelState } from './CollectionPanel.js'
import { AssetBrowserNavigation } from './asset-browser/AssetBrowserNavigation.js'
import { assetCollectionSource } from './asset-browser/collection-adapter.js'
import { VIEW_PREFERENCE_KEY } from './asset-browser/helpers.js'
import { mountAssetSource } from './asset-browser/mountAssetSource.js'
import { AssetEntryContent } from './asset-browser/presentation.js'
import { AssetEntrySelection } from './asset-browser/rail.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { ProductButton } from './ProductControls.js'
import { ProductEmptyState } from './ProductSurfaces.js'
import { activeProjectId } from './projects.js'
import { ASSET_DRAG_TYPE, draggableMediaAsset, type AssetDrag } from './asset-browser/drag.js'

type AssetMessage = (key: string, params?: MessageParams) => string

function assetState(state: CollectionPanelState, message: AssetMessage, widen?: () => void, widerLabel?: string) {
  if (state.kind === 'loading') return <ProductEmptyState tone="loading" title={message('assets.state.loading.title')} />
  if (state.kind === 'error') return <ProductNotice tone="error">{message('assets.state.error.title')}{state.message ? `: ${state.message}` : ''}</ProductNotice>
  if (state.kind === 'no-match') return <ProductEmptyState title={message('assets.state.noMatch.title')} hint={message('assets.state.noMatch.detail')}
    action={widen && widerLabel ? <ProductTextButton label={widerLabel} onClick={widen} /> : undefined} />
  return <ProductEmptyState title={message('assets.state.empty.title')} hint={message('assets.state.empty.detail', { source: state.sourceLabel })} />
}

export function AssetsBody(props: { readonly connection: DinksterConnection; readonly backendId: string; readonly baseUrl?: string; readonly backendLabel?: string; readonly onOpenStorage?: () => void }) {
  const message = useAppMessage()
  const project = activeProjectId()
  const [mounts, setMounts] = createSignal<readonly MountDescriptor[]>([])
  const [loading, setLoading] = createSignal(true)
  const [discoveryError, setDiscoveryError] = createSignal<string>()
  const [retryTick, setRetryTick] = createSignal(0)
  const [refreshTick, setRefreshTick] = createSignal(0)
  const [outputUnconfigured, setOutputUnconfigured] = createSignal(false)
  const [recursive, setRecursive] = createSignal(true)
  const [sort, setSort] = createSignal<NonNullable<CollectionPageRequest['sort']>>('newest')
  const [widenSearch, setWidenSearch] = createSignal<(() => void)>()
  const [widerLabel, setWiderLabel] = createSignal<string>()

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
        setDiscoveryError(failureMessage(reason, 'Folders could not be loaded.'))
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
  const sources = createMemo((): readonly CollectionSource[] => adapters().map((adapter) => {
    const source = assetCollectionSource(adapter, { assetUrl: (digest) => props.connection.assetUrl(digest) })
    const owner = props.baseUrl ?? ''
    return {
      ...source,
      label: adapter.id === 'all-mounts' ? message('assets.mounts.all') : adapter.label,
      filters: [],
      page: async (request) => ({ ...await source.page(request), owner }),
    }
  }))

  return <div class="assets-panel" data-testid="assets-overlay">
    <Show when={outputUnconfigured()}>
      <div data-testid="assets-output-unconfigured"><ProductNotice>
        {message('assets.output.none')}{' '}
        <ProductTextButton label={message('assets.storage.open')} onClick={() => props.onOpenStorage?.()} />
      </ProductNotice></div>
    </Show>
    <Show when={discoveryError()}>
      <div data-testid="assets-error"><ProductErrorBanner onDismiss={() => setDiscoveryError(undefined)}>
        {discoveryError()}{' '}
        <ProductButton data-testid="assets-retry" onClick={() => setRetryTick((tick) => tick + 1)}>{message('templateGallery.retry')}</ProductButton>
      </ProductErrorBanner></div>
    </Show>
    <For each={mounts().filter((mount) => mount.state === 'scanning')}>{(mount) => {
      const label = `${mount.id}: ${mount.scanProgress
        ? message('projectFolders.scanning', { done: mount.scanProgress.filesDone, total: mount.scanProgress.filesTotal })
        : message('assets.readingFolder')}`
      return <div class="asset-scan-progress" data-testid="assets-reading-folder" role="status">
        <span>{label}</span>
        <ProductProgress label={label} value={mount.scanProgress && mount.scanProgress.filesTotal > 0
          ? mount.scanProgress.filesDone / mount.scanProgress.filesTotal : undefined} />
      </div>
    }}</For>
      <CollectionPanel sources={sources()} pageSize={60} pagination="scroll" recursive={recursive()} sort={sort()}
        drag={{
          enabled: (entry, owner) => owner === (props.baseUrl ?? '') && activeProjectId() === project && draggableMediaAsset(entry) !== undefined,
          start: (entry, event, owner) => {
            const asset = draggableMediaAsset(entry)
            if (!asset || !event.dataTransfer || owner !== (props.baseUrl ?? '') || activeProjectId() !== project) { event.preventDefault(); return }
            const data: AssetDrag = { project, baseUrl: owner, asset }
            event.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(data))
            event.dataTransfer.effectAllowed = 'copy'
          },
        }}
        refreshTick={refreshTick} modeKey={VIEW_PREFERENCE_KEY} searchPriority="primary"
        searchLabel={message('assets.search')} searchPlaceholder={message('assets.search')}
        toolbarActions={<ProductSelect testId="asset-sort-select" ariaLabel={message('assets.order.label')} selectedId={sort()}
          options={(['newest', 'name', 'path'] as const).map((value) => ({ id: value, label: message(`assets.order.${value}`), value }))}
          onSelect={(option) => setSort(option.value)} />}
        navigation={({ selectedId, select, folder, navigate, mode, setMode }) => {
          createEffect(() => {
            setWidenSearch(() => selectedId() === 'all-mounts' ? undefined : !recursive()
              ? () => setRecursive(true) : () => { setRecursive(true); select('all-mounts') })
            setWiderLabel(selectedId() === 'all-mounts' ? undefined : message(!recursive() ? 'assets.search.subfolders' : 'assets.search.allMounts'))
          })
          return <AssetBrowserNavigation sources={sources()} selectedId={selectedId()} select={select}
            folder={folder()} navigate={navigate} recursive={recursive()} setRecursive={setRecursive}
            mode={mode()} setMode={setMode} />
        }}
        renderState={(state) => assetState(loading() ? { ...state, kind: 'loading' } : state, message, widenSearch(), widerLabel())} entryContent={(entry) => <AssetEntryContent entry={entry()} />}
        detailPlacement="inline" detailRail={(entry) => <Show when={entry}>{(selected) => <AssetEntrySelection entry={selected()} adapters={adapters()}
          backendId={props.backendId} connection={props.connection} backendUrl={props.baseUrl ?? ''} backendLabel={props.backendLabel} />}</Show>}
      />
  </div>
}
