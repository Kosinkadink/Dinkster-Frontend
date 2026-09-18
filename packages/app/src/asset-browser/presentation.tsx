import type { CollectionEntry } from '@dinkster/core'
import { AudioLines, Box, File, Film, Folder, Image as ImageIcon } from 'lucide-solid'
import { Icon } from '../Icon.js'
import { useAppMessage } from '../locale.js'
import { assetEntryKindOf } from './collection-adapter.js'
import { logicalModelPickDetailOf } from './logical-model-collection-source.js'

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
