import { boardMediaKindOf, type CollectionEntry } from '@dinkster/core'
import { assetItemOf } from './collection-adapter.js'
import { committableAssetRef, type CanonicalAssetRef } from './helpers.js'

export const ASSET_DRAG_TYPE = 'application/x-dinkster-media-asset+json'

export interface AssetDrag {
  readonly project: string
  readonly baseUrl: string
  readonly asset: CanonicalAssetRef
}

export function draggableMediaAsset(entry: CollectionEntry): CanonicalAssetRef | undefined {
  const item = assetItemOf(entry)
  if (!item) return undefined
  const asset = committableAssetRef(item)
  return asset && boardMediaKindOf(asset.mediaType) ? asset : undefined
}

/** Drag data is untrusted, including transfers from another window. */
export function readAssetDrag(text: string): AssetDrag {
  if (text.length > 16_384) throw new Error('Media drop is too large')
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid media drop')
  const data = value as Record<string, unknown>
  const raw = data['asset']
  if (typeof data['project'] !== 'string' || typeof data['baseUrl'] !== 'string' ||
      typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('Invalid media drop')
  const asset = raw as Record<string, unknown>
  if (typeof asset['digest'] !== 'string' || !/^blake3:[a-f0-9]{64}$/.test(asset['digest']) ||
      typeof asset['name'] !== 'string' || typeof asset['mediaType'] !== 'string' ||
      !boardMediaKindOf(asset['mediaType']) || typeof asset['size'] !== 'number' ||
      !Number.isSafeInteger(asset['size']) || asset['size'] < 0 || typeof asset['virtualPath'] !== 'string')
    throw new Error('Invalid media drop')
  return { project: data['project'], baseUrl: data['baseUrl'], asset: {
    digest: asset['digest'], name: asset['name'], mediaType: asset['mediaType'], size: asset['size'], virtualPath: asset['virtualPath'],
  } }
}
