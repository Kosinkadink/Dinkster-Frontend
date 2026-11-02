import type { MountDescriptor } from '@dinkster/client'
import type { CollectionEntry, CollectionPageRequest, CollectionSource } from '@dinkster/core'
import { assetCollectionSource, assetEntryOf, assetItemOf } from './collection-adapter.js'
import type { AssetSourceAdapter } from './types.js'

interface CrossMountCursor {
  readonly version: 1
  readonly signature: string
  readonly cursors: Readonly<Record<string, string>>
}

export interface AssetSourceFailure {
  readonly sourceId: string
  readonly label: string
  readonly message: string
}

export type MountPresentationClass = 'input' | 'output' | 'unclassified'

export function mountPresentationClass(mount: Pick<MountDescriptor, 'id' | 'kind'>): MountPresentationClass {
  if (mount.id === 'comfy-input' || /(?:^|-)input(?:-|$)/.test(mount.id)) return 'input'
  if (mount.id === 'comfy-output' || /(?:^|-)output(?:-|$)/.test(mount.id)) return 'output'
  return 'unclassified'
}

export function mountPresentationKey(mount: Pick<MountDescriptor, 'id' | 'kind'>): string {
  const classification = mountPresentationClass(mount)
  if (classification !== 'unclassified') return `io/${classification}`
  return mount.kind ?? `other/${mount.id}`
}

const requestSignature = (req: CollectionPageRequest): string => JSON.stringify({
  query: req.query,
  folder: req.folder ?? '',
  filters: req.filters ?? {},
})

const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason)

const errorEntry = (id: string, label: string, reason: string): CollectionEntry => ({
  id: `all-assets:error:${id}`,
  title: `${label} unavailable`,
  subtitle: reason,
  badges: ['unavailable'],
  details: [{ label: 'Reason', text: reason }],
})

const decodeCursor = (cursor: string, signature: string): CrossMountCursor => {
  try {
    const parsed = JSON.parse(cursor) as Partial<CrossMountCursor>
    if (parsed.version !== 1 || parsed.signature !== signature || typeof parsed.cursors !== 'object' || parsed.cursors === null) {
      throw new Error('invalid')
    }
    return parsed as CrossMountCursor
  } catch {
    throw new Error('stale All assets cursor')
  }
}

export function allAssetsCollectionSource(
  adapters: readonly AssetSourceAdapter[],
  unavailable: readonly Pick<MountDescriptor, 'id' | 'state'>[] = [],
  assetUrl?: (digest: string) => string,
  options: {
    readonly id?: string
    readonly label?: string
    readonly fixedKind?: string
    readonly failWhenAllSourcesFail?: boolean
    readonly onSourceFailures?: (failures: readonly AssetSourceFailure[]) => void
    readonly additionalSources?: readonly CollectionSource[]
  } = {},
): CollectionSource {
  const sources = [...adapters.map((adapter) => assetCollectionSource(adapter, {
      ...(assetUrl ? { assetUrl } : {}),
      ...(options.fixedKind ? { fixedKind: options.fixedKind } : {}),
    })), ...(options.additionalSources ?? [])]
  let generation = 0
  let activeSignature = ''
  const activeSourceFailures = new Map<string, AssetSourceFailure>()
  const assetGroups = new Map<string, CollectionEntry>()
  return {
    id: options.id ?? 'all-assets',
    label: options.label ?? 'All assets',
    folders: true,
    filters: (options.additionalSources ?? []).flatMap((source) => source.filters ?? []),
    page: async (req) => {
      const signature = requestSignature(req)
      const cursor = req.cursor === undefined ? undefined : decodeCursor(req.cursor, signature)
      let requestGeneration: number
      if (cursor === undefined) {
        activeSignature = signature
        requestGeneration = ++generation
        assetGroups.clear()
      } else {
        if (activeSignature !== signature) throw new Error('stale All assets cursor')
        requestGeneration = generation
      }
      const results = await Promise.all(sources.map(async (source) => {
        const mountCursor = cursor?.cursors[source.id]
        if (cursor !== undefined && mountCursor === undefined) return { source, page: undefined }
        if (Object.entries(req.filters ?? {}).some(([key, value]) => value && key !== 'kind' &&
          !source.filters?.some((filter) => filter.id === key))) return { source, page: undefined }
        try {
          const page = await source.page({
            ...req,
            ...(mountCursor !== undefined ? { cursor: mountCursor } : {}),
          })
          return { source, page }
        } catch (reason) {
          if (req.signal?.aborted === true) throw reason
          return { source, error: errorText(reason) }
        }
      }))
      if (requestGeneration !== generation || activeSignature !== signature) {
        throw new Error('stale All assets response')
      }
      req.signal?.throwIfAborted()
      const sourceFailures = results.flatMap((result) => result.error === undefined
        ? []
        : [{ sourceId: result.source.id, label: result.source.label, message: result.error }])
      if (req.cursor === undefined) activeSourceFailures.clear()
      for (const result of results) {
        if (result.page === undefined && result.error === undefined) continue
        if (result.error === undefined) activeSourceFailures.delete(result.source.id)
        else activeSourceFailures.set(result.source.id, { sourceId: result.source.id, label: result.source.label, message: result.error })
      }
      options.onSourceFailures?.([...activeSourceFailures.values()])
      if ((options.failWhenAllSourcesFail === true || options.onSourceFailures !== undefined)
        && results.length > 0 && results.every((result) => result.error !== undefined)) {
        throw new Error(sourceFailures.map((failure) => `${failure.label}: ${failure.message}`).join('; '))
      }
      const nextCursors: Record<string, string> = {}
      const items: CollectionEntry[] = []
      const errors: CollectionEntry[] = options.onSourceFailures !== undefined
        ? []
        : req.cursor === undefined ? unavailable.map((mount) => errorEntry(mount.id, mount.id, mount.state)) : []
      for (const result of results) {
        if (result.error !== undefined) {
          if (options.onSourceFailures === undefined) errors.push(errorEntry(result.source.id, result.source.label, result.error))
          continue
        }
        if (result.page === undefined) continue
        items.push(...result.page.items)
        if (result.page.cursor !== undefined) nextCursors[result.source.id] = result.page.cursor
      }
      const grouped = new Map<string, CollectionEntry>()
      for (const entry of items) {
        const item = assetItemOf(entry)
        if (item?.digest === undefined || item.folder) {
          grouped.set(entry.id, entry)
          continue
        }
        const previous = assetGroups.get(item.digest)
        const previousItem = assetItemOf(previous)
        const chosen = previousItem === undefined ||
          (item.availability === 'available' && previousItem.availability !== 'available') ||
          (item.availability === undefined && previousItem.availability !== undefined && previousItem.availability !== 'available')
          ? item : previousItem
        const facts = [
          ...(previous?.details ?? []), ...(entry.details ?? []),
          { label: 'Observed name', text: item.name },
          { label: 'Location', text: `${item.source.label}: ${item.virtualPath ?? ''}` },
        ]
        const details = [...new Map(facts.map((fact) => [JSON.stringify(fact), fact])).values()]
        const merged = assetEntryOf({ ...chosen, id: `all-assets:${item.digest}`, details }, assetUrl)
        assetGroups.set(item.digest, merged)
        grouped.set(merged.id, merged)
      }
      const mergedItems = [...grouped.values()]
      mergedItems.sort((left, right) => {
        const byName = left.title < right.title ? -1 : left.title > right.title ? 1 : 0
        if (byName !== 0) return byName
        const leftPath = assetItemOf(left)?.virtualPath ?? ''
        const rightPath = assetItemOf(right)?.virtualPath ?? ''
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
      })
      return {
        items: [...mergedItems, ...errors],
        ...(Object.keys(nextCursors).length > 0
          ? { cursor: JSON.stringify({ version: 1, signature, cursors: nextCursors } satisfies CrossMountCursor) }
          : {}),
      }
    },
  }
}
