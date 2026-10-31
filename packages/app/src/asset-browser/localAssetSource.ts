import type { DinksterConnection } from '@dinkster/client'
import type { AssetSourceAdapter } from './types.js'

/** Recorded names and origins remain browsable when their bytes are no longer present. */
export function localAssetSource(connection: DinksterConnection, label = 'Local assets'): AssetSourceAdapter {
  const id = 'local-assets'
  return {
    id, label, sourceLabel: label,
    capabilities: { folders: false, query: true, kindFilter: true, thumbnails: true, actions: false },
    async page(req) {
      if (req.folder) return { items: [] }
      const kind = req.kind
      const page = await connection.listLocalAssets({
        scope: 'local', q: req.query, limit: req.limit,
        ...(req.kind && !req.kind.endsWith('/*') ? { kind: req.kind } : {}),
        ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
        ...(req.signal !== undefined ? { signal: req.signal } : {}),
      })
      const statuses = await connection.checkAssetAvailability(page.assets.map(({ asset }) => asset.digest), {
        scope: 'local', ...(req.signal !== undefined ? { signal: req.signal } : {}),
      })
      req.signal?.throwIfAborted()
      const availability = new Map(statuses.map((row) => [row.digest, row.status]))
      return {
        items: page.assets.flatMap((entry) => {
          const observations = kind ? entry.observations.filter((observation) => kind.endsWith('/*')
            ? observation.kind.startsWith(kind.slice(0, -1)) : observation.kind === kind) : entry.observations
          const latest = observations.at(-1)
          if (kind && latest === undefined) return []
          return [{
            ...entry.asset, id: `${id}:${entry.asset.digest}`,
            ...(latest ? { kind: latest.kind } : {}),
            availability: availability.get(entry.asset.digest)!,
            source: { id, label }, rawRef: entry.asset,
            details: [
              { label: 'Aliases', text: entry.aliases.join(', ') },
              ...entry.observations.flatMap((observation) => [
                { label: 'Recorded', text: new Date(observation.created * 1000).toISOString() },
                ...Object.entries(observation.origin).map(([key, text]) => ({ label: `Origin ${key}`, text })),
              ]),
            ],
          }]
        }),
        ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
      }
    },
    loadMetadata: (item) => item.digest && item.availability === 'available'
      ? connection.fetchAssetMetadata(item.digest) : Promise.resolve(undefined),
  }
}
