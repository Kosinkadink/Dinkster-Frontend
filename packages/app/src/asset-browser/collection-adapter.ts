/**
 * Asset -> collection adapter: maps the transport-owning AssetSourceAdapter
 * (mounts today, pack declarations and requirement rows later) onto the
 * common CollectionSource vocabulary so assets browse and pick through the
 * ONE shared list/grid surface instead of a bespoke renderer.
 *
 * The whole AssetBrowserItem rides along as the entry's opaque `ref`: the
 * shared surface never inspects it, and only asset-owned code (the pick
 * predicate, the commit handler, the detail rail) narrows it back.
 */

import type { CollectionEntry, CollectionSource } from '@dinkster/core'
import type { DinksterConnection } from '@dinkster/client'
import type { AssetBrowserItem, AssetSourceAdapter } from './types.js'
import { committableAssetRef, formatSize, isBrowserPreviewable, isCompatible } from './helpers.js'
import { isModel3dMime } from '../model3d-mime.js'
import { readAssetPreview } from '../workflow-asset-retention.js'
import { activeProjectId } from '../projects.js'

export interface AssetPreviewOwner {
  readonly connection: DinksterConnection
  readonly current: () => boolean
}

const EXTENSION_KINDS: Readonly<Record<string, string>> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', gif: 'image', bmp: 'image',
  mp4: 'video', webm: 'video', mov: 'video', avi: 'video',
  wav: 'audio', mp3: 'audio', flac: 'audio', ogg: 'audio',
  safetensors: 'model', ckpt: 'model', pt: 'model', gguf: 'model',
}

/** Best-effort display kind for mount entries whose backend omitted one. */
export function assetKindOf(item: Pick<AssetBrowserItem, 'kind' | 'name'>): string | undefined {
  if (item.kind) return item.kind
  const dot = item.name.lastIndexOf('.')
  if (dot < 0 || dot === item.name.length - 1) return undefined
  return EXTENSION_KINDS[item.name.slice(dot + 1).toLowerCase()]
}

/** One asset row (or folder row) in the common display vocabulary. */
export function assetEntryOf(item: AssetBrowserItem, assetUrl?: (digest: string) => string, previewOwner?: AssetPreviewOwner): CollectionEntry {
  const project = activeProjectId()
  if (item.folder === true) {
    return {
      id: item.id,
      title: item.name,
      badges: ['folder', ...(item.childCount !== undefined ? [`${item.childCount} items`] : [])],
      folder: { path: item.virtualPath ?? '' },
    }
  }
  // Rows stay compact on purpose: name plus size. Kind, source, mount
  // path, and digest live in the detail rail, not on every row.
  return {
    id: item.id,
    title: item.name,
    badges: [...(item.size !== undefined ? [formatSize(item.size)] : []), ...(item.availability === 'missing' ? ['missing'] : [])],
    ...(item.details !== undefined ? { details: item.details } : {}),
    // Conservative preview policy: digest bytes render as a thumbnail only
    // for browser-previewable media entries; everything else stays
    // text-first (initials), never a broken-image box. GLB and splat PLY
    // entries have no direct pixels, so they get a lazy poster render
    // instead of a URL.
    ...(assetUrl !== undefined && item.digest !== undefined && isBrowserPreviewable(item)
      ? { thumbRender: async (signal?: AbortSignal) => {
          if (previewOwner === undefined || signal === undefined) throw new Error('Asset preview ownership unavailable')
          signal.throwIfAborted()
          const blob = await readAssetPreview(previewOwner.connection, { complete: true, digests: [item.digest!] }, async () => {
            const bytes = await previewOwner.connection.fetchAssetBytes(item.digest!, signal)
            if (bytes === undefined) throw new Error('Asset preview is unavailable')
            return new Blob([bytes], { type: item.mediaType! })
          }, () => !signal.aborted && activeProjectId() === project && previewOwner.current())
          signal.throwIfAborted()
          const url = URL.createObjectURL(blob)
          signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true })
          return url
        } }
      : assetUrl !== undefined && item.digest !== undefined && (item.availability === undefined || item.availability === 'available') && isModel3dMime(item.mediaType)
        ? {
            thumbRender: async (signal?: AbortSignal) => {
              signal?.throwIfAborted()
              if (previewOwner === undefined) throw new Error('Asset preview ownership unavailable')
              const url = assetUrl(item.digest!)
              const viewer = await import('../model3d-viewer.js')
              signal?.throwIfAborted()
              return readAssetPreview(previewOwner.connection, { complete: true, digests: [item.digest!] },
                () => viewer.renderModel3dPosterUrl(url, item.mediaType!),
                () => signal?.aborted !== true && activeProjectId() === project && previewOwner.current())
            },
          }
        : {}),
    ref: item,
  }
}

/** Narrow an entry's opaque ref back to the asset item that minted it. */
export function assetItemOf(entry: CollectionEntry | undefined): AssetBrowserItem | undefined {
  const ref = entry?.ref
  return typeof ref === 'object' && ref !== null && 'id' in ref && 'name' in ref && 'source' in ref
    ? (ref as AssetBrowserItem)
    : undefined
}

/** Resolve the semantic kind used by asset-owned entry presentation. */
export function assetEntryKindOf(entry: CollectionEntry | undefined): string | undefined {
  const item = assetItemOf(entry)
  if (item !== undefined) return assetKindOf(item)
  return entry?.details?.find((fact) => fact.label === 'Kind')?.text ?? entry?.badges?.[0]
}

/**
 * Pick predicate for the shared surface: only entries whose asset ref
 * proves MIME/kind compatibility AND yields a complete committable
 * AssetRef via `committableAssetRef` (the same guard the commit path
 * derives its descriptor from - a row must never look pickable while
 * its staged commit would silently no-op). Folder rows carry no ref
 * and are therefore never pickable (they navigate instead).
 */
export function assetEntryPickable(accept: readonly string[], kind?: string): (entry: CollectionEntry) => boolean {
  return (entry) => {
    const item = assetItemOf(entry)
    return item !== undefined && committableAssetRef(item) !== undefined && isCompatible(item, accept, kind)
  }
}

/**
 * Wrap one AssetSourceAdapter as a CollectionSource. Kind filtering is
 * open-vocabulary: the filter offers every kind observed in pages this
 * source served plus the host preset, so unknown future kinds stay
 * selectable without a hard-coded registry.
 */
export function assetCollectionSource(
  adapter: AssetSourceAdapter,
  opts: { readonly assetUrl?: (digest: string) => string; readonly fixedKind?: string; readonly previewOwner?: AssetPreviewOwner } = {},
): CollectionSource {
  const seenKinds = new Set<string>()
  return {
    id: adapter.id,
    label: adapter.label,
    ...(adapter.capabilities.folders ? { folders: true } : {}),
    ...(adapter.capabilities.kindFilter && opts.fixedKind === undefined
      ? {
          filters: [{
            id: 'kind',
            label: 'Kinds',
            options: () => [...seenKinds].sort().map((value) => ({ value, label: value })),
          }],
        }
      : {}),
    page: async (req) => {
      const kind = opts.fixedKind ?? req.filters?.['kind']
      const folder = req.folder ?? ''
      // Legacy adapters may list folders separately. Newer paged adapters
      // return them atomically with their non-recursive first page.
      const folderRows = req.cursor === undefined && req.query === '' && adapter.capabilities.folders && adapter.listFolder
        ? adapter.listFolder({ folder, ...(req.signal !== undefined ? { signal: req.signal } : {}) })
        : Promise.resolve({ folders: [] as readonly AssetBrowserItem[] })
      const [page, nav] = await Promise.all([
        adapter.page({
          query: req.query,
          limit: req.limit,
          ...(kind !== undefined && kind !== '' ? { kind } : {}),
          ...(folder !== '' ? { folder } : {}),
          ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
        }),
        folderRows,
      ])
      for (const item of page.items) {
        const kind = assetKindOf(item)
        if (kind !== undefined) seenKinds.add(kind)
      }
      return {
        items: [
          ...(page.folders ?? nav.folders).map((f) => assetEntryOf(f, opts.assetUrl, opts.previewOwner)),
          ...page.items.map((i) => assetEntryOf(i, opts.assetUrl, opts.previewOwner)),
        ],
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        ...(page.total !== undefined ? { total: page.total } : {}),
      }
    },
  }
}
