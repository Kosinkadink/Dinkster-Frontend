import type { DinksterConnection, MountDescriptor, MountEntry } from '@dinkster/client'
import type { AssetBrowserItem, AssetSourceAdapter } from './types.js'

function kindMatches(actual: string, requested: string): boolean {
  return requested.endsWith('/*') ? actual.startsWith(requested.slice(0, -1)) : actual === requested
}

export function normalizeMountEntry(adapterId: string, label: string, entry: MountEntry): AssetBrowserItem {
  return {
    id: `${adapterId}:${entry.virtualPath}`, name: entry.name, digest: entry.digest, size: entry.size,
    mediaType: entry.mediaType, ...(entry.kind ? { kind: entry.kind } : {}), virtualPath: entry.virtualPath,
    source: { id: adapterId, label, path: entry.virtualPath }, rawRef: entry,
  }
}

export function mountAssetSource(connection: DinksterConnection, mountId: string): AssetSourceAdapter {
  const id = `mount:${mountId}`
  return {
    id, label: mountId, sourceLabel: mountId,
    capabilities: { folders: true, query: true, kindFilter: true, thumbnails: true, actions: false },
    async page(req) {
      const folder = req.folder ?? ''
      const searching = req.query.trim() !== ''
      const page = await connection.listMountEntries(mountId, {
        ...(searching ? { q: req.query } : {}),
        path: folder,
        recursive: req.recursive ?? searching,
        ...(req.cursor ? { cursor: req.cursor } : {}),
        limit: req.limit,
        ...(req.kind ? { kind: req.kind } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      })
      const items = page.entries.map((entry) => normalizeMountEntry(id, mountId, entry))
      const folders = page.folders?.map((name): AssetBrowserItem => {
        const virtualPath = folder === '' ? name : `${folder}/${name}`
        return { id: `${id}:${virtualPath}`, name, folder: true, virtualPath, source: { id, label: mountId, path: virtualPath } }
      })
      return { items, ...(folders !== undefined ? { folders } : {}), ...(page.cursor ? { cursor: page.cursor } : {}), ...(page.total !== undefined ? { total: page.total } : {}) }
    },
    loadMetadata: (item) => item.digest ? connection.fetchAssetMetadata(item.digest) : Promise.resolve(undefined),
  }
}

export async function mountAssetSources(
  connection: DinksterConnection,
  kind?: string,
  discoveredMounts?: readonly MountDescriptor[],
): Promise<readonly AssetSourceAdapter[]> {
  // Every decoded mount mode ('read' | 'readwrite') is browsable; the
  // decoder owns the vocabulary. A scan does not invalidate entries that
  // have already reached the live catalog.
  const mounts = (discoveredMounts ?? await connection.listMounts())
    .filter((mount) => mount.state === 'ready' || mount.state === 'scanning')
  if (kind === undefined) return mounts.map((mount) => mountAssetSource(connection, mount.id))
  const scoped = await Promise.all(mounts.map(async (mount) => {
    if (mount.kind !== undefined) return kindMatches(mount.kind, kind) ? mount : undefined
    // A generic mount must prove it currently contains the requested kind.
    // One failed probe hides only that unproven source; it must not suppress
    // independently matching typed mounts.
    const page = await connection.listMountEntries(mount.id, { path: '', recursive: true, limit: 1, kind }).catch(() => undefined)
    return page !== undefined && page.entries.length > 0 ? mount : undefined
  }))
  return scoped.flatMap((mount) => mount === undefined ? [] : [mountAssetSource(connection, mount.id)])
}
