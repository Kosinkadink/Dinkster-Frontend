import { createSignal, For, Show } from 'solid-js'
import { formatDate, type CollectionEntry } from '@dinkster/core'
import { AudioLines, Box, File, Film, Folder, Image as ImageIcon } from 'lucide-solid'
import { CollectionImage } from '../CollectionImage.js'
import { formatCollectionDate } from '../collections.js'
import { Icon } from '../Icon.js'
import { useAppMessage } from '../locale.js'
import { assetEntryKindOf, assetItemOf } from './collection-adapter.js'
import { logicalModelPickDetailOf } from './logical-model-collection-source.js'

export function AssetModifiedTime(props: { readonly value: number }) {
  return <time class="asset-modified-time" dateTime={new Date(props.value * 1000).toISOString()}
    title={formatCollectionDate(props.value * 1000)}>{formatDate(props.value * 1000, { dateStyle: 'short' })}</time>
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
