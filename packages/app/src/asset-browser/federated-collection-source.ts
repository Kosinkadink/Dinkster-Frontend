import { AssetDtoV1Client, AssetDtoV1HttpError, type CandidateV1, type CatalogRequestV1 } from '@dinkster/client'
import type { CollectionEntry, CollectionSource } from '@dinkster/core'
import { assetEntryOf } from './collection-adapter.js'
import { formatSize } from './helpers.js'

const details = (
  candidate: CandidateV1,
  size: number | undefined,
  mediaType: string | undefined,
): NonNullable<CollectionEntry['details']> => [
  { label: 'Kind', text: candidate.assetKind },
  { label: 'Logical ID', text: candidate.logicalId },
  { label: 'Variant ID', text: candidate.variantId },
  ...candidate.providerSources.flatMap((provider) => [
    { label: 'Provider', text: provider.source.providerId },
    { label: 'Source', text: provider.source.sourceId },
    { label: 'Provider status', text: `${provider.status}${provider.reason ? `: ${provider.reason}` : ''}` },
    ...Object.entries(provider.requires).map(([label, text]) => ({ label: `Requires ${label}`, text })),
  ]),
  { label: 'Availability', text: `${candidate.availability.status}: ${candidate.availability.reason}` },
  { label: 'Compatibility', text: `${candidate.compatibility.status}: ${candidate.compatibility.reason}` },
  { label: 'Digest', text: candidate.digest },
  ...(candidate.assetRef ? [{ label: 'Name', text: candidate.assetRef.name }] : []),
  ...(size !== undefined ? [{ label: 'Size', text: String(size) }] : []),
  ...(mediaType !== undefined ? [{ label: 'Media type', text: mediaType }] : []),
  ...(candidate.assetRef ? [{ label: 'Virtual path', text: candidate.assetRef.virtualPath }] : []),
]

const entry = (candidate: CandidateV1, assetUrl?: (digest: string) => string): CollectionEntry => {
  const size = candidate.assetRef?.size ?? candidate.size
  const mediaType = candidate.assetRef?.mediaType ?? candidate.mediaType
  const id = `federated:${JSON.stringify([candidate.logicalId, candidate.variantId, candidate.digest])}`
  return {
    ...assetEntryOf({
      id, name: candidate.assetRef?.name || `${candidate.logicalId} / ${candidate.variantId}`,
      digest: candidate.digest, kind: candidate.assetKind,
      ...(size !== undefined ? { size } : {}),
      ...(mediaType !== undefined ? { mediaType } : {}),
      ...(candidate.assetRef ? { virtualPath: candidate.assetRef.virtualPath, rawRef: candidate.assetRef } : {}),
      availability: candidate.availability.status === 'local' && candidate.assetRef !== undefined
        && candidate.compatibility.status !== 'incompatible' ? 'available' : 'unavailable',
      source: { id: 'federated-assets', label: 'Federated catalog' },
    }, assetUrl),
    badges: size !== undefined ? [formatSize(size)] : [],
    details: details(candidate, size, mediaType),
  }
}

const unavailable = (title: string, reason: string): CollectionEntry => ({
  id: `federated:error:${title}`,
  title,
  subtitle: reason,
  badges: ['unavailable'],
  details: [{ label: 'Reason', text: reason }],
})

export function federatedCollectionSource(
  client: AssetDtoV1Client,
  onFailure?: (message: string | undefined) => void,
  options: { fixedKind?: string; assetUrl?: (digest: string) => string } = {},
): CollectionSource {
  const providers = new Set<string>()
  const sources = new Set<string>()
  let generation = 0
  const filterOptions = (values: Set<string>) => [...values].sort().map((value) => ({ value, label: value }))
  return {
    id: 'all-assets',
    label: 'All assets',
    folders: false,
    filters: [
      { id: 'providerId', label: 'Provider', options: () => filterOptions(providers) },
      { id: 'sourceId', label: 'Source', options: () => filterOptions(sources) },
      { id: 'availability', label: 'Availability', options: () => ['local', 'downloadable', 'unavailable'].map((value) => ({ value, label: value })) },
      { id: 'compatibility', label: 'Compatibility', options: () => ['compatible', 'incompatible', 'unknown'].map((value) => ({ value, label: value })) },
    ],
    page: async (req) => {
      const requestGeneration = ++generation
      if (req.folder) return { items: [unavailable('Folder browsing unsupported', 'The federated catalog does not support folders.')] }
      const filters = req.filters ?? {}
      const request: CatalogRequestV1 = {
        query: req.query,
        ...(options.fixedKind !== undefined ? { assetKind: options.fixedKind }
          : typeof filters['assetKind'] === 'string' ? { assetKind: filters['assetKind'] } : {}),
        ...(filters['availability'] ? { availability: [filters['availability']] as NonNullable<CatalogRequestV1['availability']> } : {}),
        ...(filters['compatibility'] ? { compatibility: [filters['compatibility']] as NonNullable<CatalogRequestV1['compatibility']> } : {}),
        ...(req.cursor !== undefined ? { cursor: req.cursor } : {}),
        limit: req.limit,
      }
      try {
        const page = await client.catalog(request, req.signal)
        req.signal?.throwIfAborted()
        if (requestGeneration === generation) onFailure?.(undefined)
        const providerId = filters['providerId']
        const sourceId = filters['sourceId']
        for (const candidate of page.items) for (const provider of candidate.providerSources) {
          providers.add(provider.source.providerId)
          sources.add(provider.source.sourceId)
        }
        const filtered = providerId || sourceId
          ? page.items.filter((candidate) => candidate.providerSources.some((provider) =>
              (!providerId || provider.source.providerId === providerId)
              && (!sourceId || provider.source.sourceId === sourceId)))
          : page.items
        return { items: filtered.map((candidate) => entry(candidate, options.assetUrl)), ...(page.nextCursor !== undefined ? { cursor: page.nextCursor } : {}) }
      } catch (error) {
        if (req.signal?.aborted === true) throw error
        const code = error instanceof AssetDtoV1HttpError ? error.error.error.code : 'catalog-error'
        const text = code === 'authentication-required'
          ? 'Authentication required'
          : code === 'forbidden'
            ? 'Not authorized'
            : error instanceof Error
              ? error.message
              : code
        if (onFailure !== undefined) {
          if (requestGeneration === generation) onFailure(text)
          throw error
        }
        return { items: [unavailable(text, text)] }
      }
    },
  }
}
