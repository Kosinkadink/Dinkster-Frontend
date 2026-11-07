import type { AssetBrowserItem } from './types.js'

/**
 * The asset picker's persisted grid/list mode key, shared across all its
 * embeddings and handed to the common collection surface as its modeKey.
 * The legacy 'tile' value is decoded as 'grid' by readCollectionViewMode.
 */
export const VIEW_PREFERENCE_KEY = 'dinkster.assetBrowser.view.v1'

export function isBrowserPreviewable(item: Pick<AssetBrowserItem, 'kind' | 'mediaType' | 'digest'>): boolean {
  if (!item.digest || !item.mediaType || !item.mediaType.startsWith('image/')) return false
  return item.kind === undefined || item.kind.startsWith('media/')
}

const mimeMatches = (mediaType: string, accept: string): boolean =>
  accept === '*/*' || (accept.endsWith('/*') ? mediaType.startsWith(accept.slice(0, -1)) : mediaType === accept)

/** Semantic media scope implied by an unambiguous MIME accept list. */
export function mediaKindForAccept(accept: readonly string[]): string | undefined {
  if (accept.length === 0) return undefined
  const family = accept[0]?.split('/', 1)[0]
  if (family === undefined || !['image', 'audio', 'video'].includes(family)) return undefined
  return accept.every((value) => value.startsWith(`${family}/`)) ? `media/${family}` : undefined
}

export function isCompatible(item: AssetBrowserItem, accept: readonly string[], kind?: string): boolean {
  if (item.folder || !item.digest || !item.mediaType) return false
  if (accept.length > 0 && !accept.some((value) => mimeMatches(item.mediaType!, value))) return false
  if (kind) {
    // Mounted image/audio/video rows currently carry mediaType but no kind.
    // Derive only the unambiguous media family needed by media/* widget
    // declarations; an explicit backend kind remains authoritative and
    // application/* entries never acquire guessed model semantics.
    const mediaFamily = item.mediaType.slice(0, item.mediaType.indexOf('/'))
    const effectiveKind = item.kind ?? (
      ['image', 'audio', 'video'].includes(mediaFamily) ? `media/${mediaFamily}` : undefined
    )
    if (!effectiveKind || (kind.endsWith('/*') ? !effectiveKind.startsWith(kind.slice(0, -1)) : effectiveKind !== kind)) return false
  }
  return true
}

/**
 * The complete AssetRef descriptor an item would commit, or undefined when
 * any required field is missing or malformed. Pickable and committable are
 * the SAME question by construction: every caller that renders a pickable
 * row and every caller that commits derives from THIS - so a row can
 * never look pickable while its commit would silently no-op or write an
 * invalid ref. Size must be a real byte count (safe non-negative integer,
 * matching the ASSET widget validator), not merely present.
 */
export function committableAssetRef(
  item: AssetBrowserItem,
): { digest: string; name: string; size: number; mediaType: string; virtualPath: string } | undefined {
  if (item.folder || !item.digest || !item.mediaType) return undefined
  if (typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0) return undefined
  return { digest: item.digest, name: item.name, size: item.size, mediaType: item.mediaType, virtualPath: item.virtualPath ?? '' }
}

/** Canonical ASSET value shape derived from the existing commit gate. */
export type CanonicalAssetRef = NonNullable<ReturnType<typeof committableAssetRef>>

/**
 * Host presentation of mount-source discovery. `undefined` sources mean the
 * request has not settled; an empty array means it settled with nothing
 * browsable. Collapsing those two states into one is exactly the bug that
 * showed "loading readable mounts..." forever after a successful empty
 * (or failed) discovery.
 */
export type AssetSourcesStatus = 'loading' | 'error' | 'empty' | 'ready'
export function assetSourcesStatus(sources: readonly unknown[] | undefined, error: string | undefined): AssetSourcesStatus {
  if (error !== undefined) return 'error'
  if (sources === undefined) return 'loading'
  return sources.length === 0 ? 'empty' : 'ready'
}

export function formatSize(size?: number): string {
  if (size === undefined) return 'unknown'
  if (size < 1024) return `${size} B`
  if (size < 1048576) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KiB`
  return `${(size / 1048576).toFixed(size < 10485760 ? 1 : 0)} MiB`
}
