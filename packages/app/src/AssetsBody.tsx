import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { AssetDtoV1Client, type AssetDtoV1WireContract, type DinksterConnection, type MountDescriptor } from '@dinkster/client'
import type { CollectionSource, MessageParams } from '@dinkster/core'
import { CollectionPanel, type CollectionPanelState } from './CollectionPanel.js'
import { assetCollectionSource } from './asset-browser/collection-adapter.js'
import { allAssetsCollectionSource, mountPresentationKey, type AssetSourceFailure } from './asset-browser/cross-mount-collection-source.js'
import { VIEW_PREFERENCE_KEY } from './asset-browser/helpers.js'
import { mountAssetSources } from './asset-browser/mountAssetSource.js'
import { AssetEntryFallback } from './asset-browser/presentation.js'
import { AssetEntrySelection } from './asset-browser/rail.js'
import type { AssetSourceAdapter } from './asset-browser/types.js'
import { federatedCollectionSource } from './asset-browser/federated-collection-source.js'
import { useAppMessage } from './locale.js'
import { ProductSelect } from './ProductSelect.js'
import { SearchState } from './SearchSurface.js'

type AssetMessage = (key: string, params?: MessageParams) => string
type SourceSectionKey = 'assets.source.section.models' | 'assets.source.section.media' | 'assets.source.section.inputOutput' | 'assets.source.section.other'

interface MountPresentation {
  readonly mount: MountDescriptor
  readonly label: string
  readonly labelKey?: string
  readonly ordinal: number
  readonly sectionKey: SourceSectionKey
}

const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)
const MOUNT_SCAN_POLL_MS = 1000

const formatScanBytes = (bytes: number): string => {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

const mountDetail = (mount: MountDescriptor, message: AssetMessage): string => {
  const progress = mount.scanProgress
  if (progress === undefined) return message('assets.source.mountDetail', { id: mount.id })
  return message('assets.source.scanProgress', {
    filesDone: progress.filesDone,
    filesTotal: progress.filesTotal,
    bytesDone: formatScanBytes(progress.bytesDone),
    bytesTotal: formatScanBytes(progress.bytesTotal),
    elapsed: Math.floor(progress.elapsedSeconds),
  })
}

const titleWord = (value: string): string => value.split(/[-_]/).filter(Boolean)
  .map((part) => part.length <= 4 ? part.toUpperCase() : `${part[0]!.toUpperCase()}${part.slice(1)}`)
  .join(' ')

const kindPresentation = (kind: string): { readonly label: string; readonly key?: string } => {
  const leaf = kind.split('/').at(-1) ?? kind
  const labels: Readonly<Record<string, readonly [string, string]>> = {
    checkpoint: ['Checkpoints', 'assets.source.kind.checkpoint'], lora: ['LoRAs', 'assets.source.kind.lora'], vae: ['VAEs', 'assets.source.kind.vae'], controlnet: ['ControlNets', 'assets.source.kind.controlnet'],
    image: ['Images', 'assets.source.kind.image'], video: ['Videos', 'assets.source.kind.video'], audio: ['Audio', 'assets.source.kind.audio'], input: ['Input', 'assets.source.kind.input'], output: ['Output', 'assets.source.kind.output'],
  }
  const known = labels[leaf]
  return known === undefined ? { label: `${titleWord(leaf)}s` } : { label: known[0], key: known[1] }
}

const presentationSectionKey = (key: string): SourceSectionKey => key.startsWith('model/')
  ? 'assets.source.section.models'
  : key.startsWith('media/')
    ? 'assets.source.section.media'
    : key.startsWith('io/')
      ? 'assets.source.section.inputOutput'
      : 'assets.source.section.other'

const mountPresentations = (mounts: readonly MountDescriptor[]): readonly MountPresentation[] => {
  const seen = new Map<string, number>()
  return mounts.map((mount) => {
    const key = mountPresentationKey(mount)
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    const base = key.startsWith('io/') ? kindPresentation(key) : mount.kind !== undefined ? kindPresentation(mount.kind) : { label: titleWord(mount.id) }
    return { mount, label: count === 1 ? base.label : `${base.label} ${count}`, ...(base.key !== undefined ? { labelKey: base.key } : {}), ordinal: count, sectionKey: presentationSectionKey(key) }
  })
}

const presentationLabel = (row: MountPresentation, message: AssetMessage): string => row.labelKey === undefined
  ? row.label
  : `${message(row.labelKey)}${row.ordinal === 1 ? '' : ` ${row.ordinal}`}`

const relabelAdapter = (adapter: AssetSourceAdapter, label: string): AssetSourceAdapter => ({
  ...adapter,
  label,
  page: async (req) => {
    const page = await adapter.page(req)
    const relabel = (item: Awaited<ReturnType<AssetSourceAdapter['page']>>['items'][number]) => ({
      ...item,
      source: { ...item.source, label },
    })
    return {
      ...page,
      items: page.items.map(relabel),
      ...(page.folders !== undefined ? { folders: page.folders.map(relabel) } : {}),
    }
  },
})

interface AssetSourceFailurePresentation {
  readonly label: string
  readonly message: string
}

function AssetSourceControl(props: {
  readonly sources: readonly CollectionSource[]
  readonly presentations: readonly MountPresentation[]
  readonly failures: Readonly<Record<string, AssetSourceFailurePresentation>>
  readonly selectedId: () => string
  readonly select: (id: string) => void
  readonly message: AssetMessage
}) {
  const sourceById = () => new Map(props.sources.map((source) => [source.id, source]))
  const ready = () => props.presentations.filter(({ mount }) => mount.state === 'ready' && mount.entryCount !== 0)
  const sourceOptions = () => [
    ...(props.sources[0] ? [{ id: props.sources[0].id, label: props.sources[0].id === 'all-assets' ? props.message('assets.source.all') : props.sources[0].label, value: props.sources[0].id }] : []),
    ...ready().flatMap((row) => {
      const source = sourceById().get(`mount:${row.mount.id}`)
      return source ? [{ id: source.id, label: `${props.message(row.sectionKey)} / ${presentationLabel(row, props.message)}`, value: source.id }] : []
    }),
  ]
  const issues = () => {
    const mountIds = new Set(props.presentations.map((row) => `mount:${row.mount.id}`))
    return [
      ...props.presentations.flatMap((row) => {
        const id = `mount:${row.mount.id}`
        const failure = props.failures[id]
        if (failure !== undefined) return [{ id, label: presentationLabel(row, props.message), state: 'error', detail: failure.message }]
        if (row.mount.state !== 'ready') return [{ id, label: presentationLabel(row, props.message), state: row.mount.state, detail: mountDetail(row.mount, props.message) }]
        if (row.mount.entryCount === 0) return [{ id, label: presentationLabel(row, props.message), state: 'empty', detail: props.message('assets.source.mountDetail', { id: row.mount.id }) }]
        return []
      }),
      ...Object.entries(props.failures).flatMap(([id, failure]) =>
        mountIds.has(id) ? [] : [{ id, label: id === 'all-assets' ? props.message('assets.source.federatedCatalog') : failure.label, state: 'error', detail: failure.message }]),
    ]
  }
  return <div class="asset-source-control" data-testid="asset-source-control">
    <div class="asset-source-picker">
      <span class="asset-source-label">{props.message('assets.source.label')}</span>
      <ProductSelect
        class="asset-source-select"
        testId="asset-source-select"
        ariaLabel={props.message('assets.source.ariaLabel')}
        selectedId={props.selectedId()}
        options={sourceOptions()}
        disabled={sourceOptions().length <= 1}
        onSelect={(option) => props.select(option.value)}
      />
    </div>
    <details class="asset-source-health" data-testid="asset-source-health" data-state={issues().length > 0 ? 'issues' : 'healthy'}>
      <summary>
        <span>{props.message('assets.source.health.title')}</span>
        <span role="status">{issues().length > 0 ? props.message('assets.source.health.issues', { count: issues().length }) : props.message('assets.source.health.available')}</span>
      </summary>
      <Show when={issues().length > 0} fallback={<p>{props.message('assets.source.health.allAvailable')}</p>}>
        <ul>
          <For each={issues()}>{(issue) => <li data-source={issue.id} data-state={issue.state}>
            <strong>{issue.label}</strong>
            <span>{issue.state}</span>
            <small>{issue.detail}</small>
          </li>}</For>
        </ul>
      </Show>
    </details>
  </div>
}

function assetState(state: CollectionPanelState, message: AssetMessage) {
  const source = state.sourceLabel === 'All assets' ? message('assets.source.all') : state.sourceLabel
  if (state.kind === 'loading') return <SearchState kind="loading" title={message('assets.state.loading.title')} detail={message('assets.state.loading.detail', { source })} />
  if (state.kind === 'error') return <SearchState kind="error" title={message('assets.state.error.title')} detail={state.message ?? message('assets.state.error.detail', { source })} />
  if (state.kind === 'no-compatible') return <SearchState kind="empty" title={message('assets.state.noCompatible.title')} detail={message('assets.state.noCompatible.detail')} />
  if (state.kind === 'no-match') return <SearchState kind="empty" title={message('assets.state.noMatch.title')} detail={message('assets.state.noMatch.detail')} />
  return <SearchState kind="empty" title={message('assets.state.empty.title')} detail={message('assets.state.empty.detail', { source })} />
}

export function AssetsBody(props: { readonly connection: DinksterConnection; readonly backendId: string; readonly baseUrl?: string; readonly federatedContract?: AssetDtoV1WireContract }) {
  const message = useAppMessage()
  const [adapters, setAdapters] = createSignal<readonly AssetSourceAdapter[]>()
  const [mounts, setMounts] = createSignal<readonly MountDescriptor[]>([])
  const [discoveryError, setDiscoveryError] = createSignal<string>()
  const [sourceFailures, setSourceFailures] = createSignal<Readonly<Record<string, AssetSourceFailurePresentation>>>({})
  let live = true
  let discoveryGeneration = 0
  onCleanup(() => { live = false })
  createEffect(() => {
    const connection = props.connection
    const generation = ++discoveryGeneration
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true
    let scanPolling = false
    setAdapters(undefined)
    setMounts([])
    setDiscoveryError(undefined)
    setSourceFailures({})

    const discover = async (): Promise<void> => {
      try {
        const descriptors = await connection.listMounts()
        const ready = await mountAssetSources(connection, undefined, descriptors)
        if (!live || !active || generation !== discoveryGeneration) return
        setAdapters(ready)
        setMounts(descriptors)
        setDiscoveryError(undefined)
        scanPolling = descriptors.some((mount) => mount.state === 'pending' || mount.state === 'scanning')
        if (scanPolling) {
          timer = setTimeout(() => { void discover() }, MOUNT_SCAN_POLL_MS)
        }
      } catch (reason: unknown) {
        if (!live || !active || generation !== discoveryGeneration) return
        setDiscoveryError(errorText(reason))
        if (scanPolling) timer = setTimeout(() => { void discover() }, MOUNT_SCAN_POLL_MS)
      }
    }
    void discover()
    onCleanup(() => {
      active = false
      if (timer !== undefined) clearTimeout(timer)
    })
  })
  const unavailable = createMemo(() => mounts().filter((mount) => mount.state !== 'ready'))
  const presentations = createMemo(() => mountPresentations(mounts()))
  const presentedAdapters = createMemo(() => {
    const labels = new Map(presentations().map((row) => [`mount:${row.mount.id}`, row.label]))
    return (adapters() ?? []).map((adapter) => relabelAdapter(adapter, labels.get(adapter.id) ?? adapter.label))
  })
  const sources = createMemo((): readonly CollectionSource[] => {
    const ready = presentedAdapters()
    const assetUrl = (digest: string): string => props.connection.assetUrl(digest)
    const healthGeneration = discoveryGeneration
    const reportFailures = (failures: readonly AssetSourceFailure[]): void => {
      if (!live || healthGeneration !== discoveryGeneration) return
      setSourceFailures(Object.fromEntries(failures.map((failure) => [failure.sourceId, { label: failure.label, message: failure.message }])))
    }
    const local = allAssetsCollectionSource(ready, unavailable(), assetUrl, { onSourceFailures: reportFailures })
    return [
      props.federatedContract
        ? federatedCollectionSource(new AssetDtoV1Client(props.baseUrl ?? '', props.federatedContract), (message) => {
            if (!live || healthGeneration !== discoveryGeneration) return
            setSourceFailures(message === undefined ? {} : { 'all-assets': { label: 'Federated catalog', message } })
          })
        : local,
      ...ready.map((adapter) => assetCollectionSource(adapter, { assetUrl })),
    ]
  })

  return (
    <div class="assets-panel" data-testid="assets-overlay">
      <Show
        when={discoveryError()}
        fallback={
          <Show when={adapters() !== undefined} fallback={<div class="assets-bootstrap-state"><SearchState kind="loading" title={message('assets.discovery.loading.title')} detail={message('assets.discovery.loading.detail')} /></div>}>
            <CollectionPanel
              sources={sources()}
              sourceRail={({ selectedId, select }) => <AssetSourceControl sources={sources()} presentations={presentations()} failures={sourceFailures()} selectedId={selectedId} select={select} message={message} />}
              modeKey={VIEW_PREFERENCE_KEY}
              searchPriority="primary"
              searchLabel={message('assets.search')}
              searchPlaceholder={message('assets.search')}
              renderState={(state) => assetState(state, message)}
              entryFallback={(entry) => <AssetEntryFallback entry={entry} />}
              detailRail={(entry) => <AssetEntrySelection entry={entry} adapters={presentedAdapters()} backendId={props.backendId} assetUrl={(digest) => props.connection.assetUrl(digest)} />}
            />
          </Show>
        }
      >
        {(error) => <div class="assets-bootstrap-state" data-testid="assets-error"><SearchState kind="error" title={message('assets.discovery.error.title')} detail={error()} /></div>}
      </Show>
    </div>
  )
}
