import type { AssetBrowserItem, AssetSourceAdapter } from './types.js'

export const METADATA_INSPECTION_UNSUPPORTED = 'Metadata inspection is unsupported.'

const cache = new Map<string, unknown>()
export async function loadAssetMetadata(backendId: string, source: AssetSourceAdapter, item: AssetBrowserItem, signal?: AbortSignal): Promise<unknown | undefined> {
  if (!item.digest || !source.loadMetadata) return undefined
  const key = `${backendId}:${item.digest}`
  if (cache.has(key)) return cache.get(key)
  const result = await source.loadMetadata(item, signal)
  if (result !== undefined) cache.set(key, result)
  return result
}
export function clearMetadataCache(): void { cache.clear() }

/**
 * Run one metadata inspection whose result is applied only while it still
 * owns the detail rail (AP10). The browser hands in `stillCurrent` - true
 * only while the inspected item is STILL the selection that started the
 * inspection (selection changes, source switches, and unmount all advance
 * the epoch) - so a slow inspection can never attach one asset's metadata
 * (or its failure message) to whatever the user selected next.
 */
export async function inspectAssetMetadata(p: {
  readonly backendId: string
  readonly source: AssetSourceAdapter
  readonly item: AssetBrowserItem
  readonly stillCurrent: () => boolean
  readonly apply: (state: string, metadata: unknown | undefined) => void
}): Promise<void> {
  try {
    const value = await loadAssetMetadata(p.backendId, p.source, p.item)
    if (!p.stillCurrent()) return
    p.apply(value === undefined ? METADATA_INSPECTION_UNSUPPORTED : 'ready', value)
  } catch (reason) {
    if (!p.stillCurrent()) return
    p.apply(reason instanceof Error ? reason.message : String(reason), undefined)
  }
}
