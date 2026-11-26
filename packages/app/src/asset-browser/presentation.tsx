import { createSignal, For, Show } from 'solid-js'
import { formatDate, formatRelativeTime, type CollectionEntry } from '@dinkster/core'
import { AudioLines, Box, ChevronRight, File, Film, Folder, Image as ImageIcon } from 'lucide-solid'
import { CollectionImage } from '../CollectionImage.js'
import { formatCollectionDate } from '../collections.js'
import { Icon } from '../Icon.js'
import { useAppMessage } from '../locale.js'
import { assetEntryKindOf, assetItemOf } from './collection-adapter.js'
import { logicalModelPickDetailOf } from './logical-model-collection-source.js'

export function AssetModifiedTime(props: { readonly value: number }) {
  const label = () => {
    const date = new Date(props.value * 1000)
    const seconds = Math.round((date.getTime() - Date.now()) / 1000)
    if (Math.abs(seconds) < 60) return formatRelativeTime(0, 'second', { numeric: 'auto' })
    if (Math.abs(seconds) < 3600) return formatRelativeTime(Math.round(seconds / 60), 'minute', { style: 'short' })
    if (Math.abs(seconds) < 86400 && date.toDateString() === new Date().toDateString()) return formatRelativeTime(Math.round(seconds / 3600), 'hour', { style: 'short' })
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1)
    if (date.toDateString() === yesterday.toDateString()) return formatRelativeTime(-1, 'day', { numeric: 'auto' })
    return formatDate(date, { day: 'numeric', month: 'short', year: 'numeric' })
  }
  return <time class="asset-modified-time" dateTime={new Date(props.value * 1000).toISOString()}
    title={formatCollectionDate(props.value * 1000)}>{label()}</time>
}

export function AssetEntryContent(props: { readonly entry: CollectionEntry }) {
  const [dimensions, setDimensions] = createSignal<string>()
  return <>
    <CollectionImage entry={props.entry} class="collection-thumb" alt="" fallback={<AssetEntryFallback entry={props.entry} />}
      onError={() => setDimensions(undefined)} onLoad={(event) => {
        const image = event.currentTarget
        if (image.naturalWidth > 0 && image.naturalHeight > 0) setDimensions(`${image.naturalWidth} x ${image.naturalHeight}`)
      }} />
    <div class="collection-text">
      <span class="collection-title">{props.entry.title}</span>
      <Show when={dimensions() !== undefined || (props.entry.badges ?? []).length > 0}>
        <span class="collection-badges">
          <Show when={dimensions()}>{(value) => <span class="asset-entry-dimensions">{value()}</span>}</Show>
          <For each={props.entry.badges}>{(badge) => <span class="collection-badge">{badge}</span>}</For>
        </span>
      </Show>
    </div>
    <Show when={props.entry.folder !== undefined}><Icon icon={ChevronRight} /></Show>
    <Show when={assetItemOf(props.entry)?.modifiedAt !== undefined}>
      <AssetModifiedTime value={assetItemOf(props.entry)!.modifiedAt!} />
    </Show>
  </>
}

const middleDigest = (digest: string): string => digest.length > 23
  ? `${digest.slice(0, 12)}...${digest.slice(-8)}`
  : digest

export function DigestValue(props: { readonly digest: string }) {
  const message = useAppMessage()
  return (
    <span class="asset-digest-value">
      <code title={props.digest}>{middleDigest(props.digest)}</code>
      <button type="button" aria-label={message('assets.digest.copyLabel')} onClick={() => void navigator.clipboard?.writeText(props.digest)}>{message('assets.digest.copy')}</button>
    </span>
  )
}

export function AssetEntryFallback(props: { readonly entry: CollectionEntry }) {
  const kind = () => assetEntryKindOf(props.entry)
  const family = () => props.entry.folder !== undefined
    ? 'folder'
    : logicalModelPickDetailOf(props.entry) !== undefined ? 'model'
    : kind() === 'image' || kind()?.startsWith('media/image') ? 'image'
      : kind() === 'video' || kind()?.startsWith('media/video') ? 'video'
        : kind() === 'audio' || kind()?.startsWith('media/audio') ? 'audio'
          : kind() === 'model3d' || kind()?.startsWith('media/model3d') ? 'model3d'
            : kind() === 'model' || kind()?.startsWith('model/') ? 'model' : 'asset'
  const icon = () => family() === 'folder' ? Folder
    : family() === 'image' ? ImageIcon
      : family() === 'video' ? Film
        : family() === 'audio' ? AudioLines
          : family() === 'model' || family() === 'model3d' ? Box : File
  return (
    <span class="asset-entry-fallback" data-testid="asset-entry-fallback" data-kind={family()} aria-hidden="true">
      <Icon icon={icon()} />
    </span>
  )
}
