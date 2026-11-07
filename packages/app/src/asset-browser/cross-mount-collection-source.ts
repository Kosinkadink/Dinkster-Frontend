import type { MountDescriptor } from '@dinkster/client'
import type { CollectionEntry, CollectionPageRequest, CollectionSource } from '@dinkster/core'
import { assetCollectionSource, assetItemOf } from './collection-adapter.js'
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
  } = {},
): CollectionSource {
  const sources = adapters.map((adapter) => ({
    adapter,
    source: assetCollectionSource(adapter, {
      ...(assetUrl ? { assetUrl } : {}),
      ...(options.fixedKind ? { fixedKind: options.fixedKind } : {}),
    }),
  }))
  let generation = 0
  let activeSignature = ''
  const activeSourceFailures = new Map<string, AssetSourceFailure>()
  return {
    id: options.id ?? 'all-assets',
    label: options.label ?? 'All assets',
    folders: true,
    page: async (req) => {
      const signature = requestSignature(req)
      const cursor = req.cursor === undefined ? undefined : decodeCursor(req.cursor, signature)
      let requestGeneration: number
      if (cursor === undefined) {
        activeSignature = signature
        requestGeneration = ++generation
      } else {
        if (activeSignature !== signature) throw new Error('stale All assets cursor')
        requestGeneration = generation
      }
      const results = await Promise.all(sources.map(async ({ adapter, source }) => {
        const mountCursor = cursor?.cursors[adapter.id]
        if (cursor !== undefined && mountCursor === undefined) return { adapter, page: undefined }
        try {
          const page = await source.page({
            ...req,
            ...(mountCursor !== undefined ? { cursor: mountCursor } : {}),
          })
          return { adapter, page }
        } catch (reason) {
          if (req.signal?.aborted === true) throw reason
          return { adapter, error: errorText(reason) }
        }
      }))
      if (requestGeneration !== generation || activeSignature !== signature) {
        throw new Error('stale All assets response')
      }
      req.signal?.throwIfAborted()
      const sourceFailures = results.flatMap((result) => result.error === undefined
        ? []
        : [{ sourceId: result.adapter.id, label: result.adapter.label, message: result.error }])
      if (req.cursor === undefined) activeSourceFailures.clear()
      for (const result of results) {
        if (result.page === undefined && result.error === undefined) continue
        if (result.error === undefined) activeSourceFailures.delete(result.adapter.id)
        else activeSourceFailures.set(result.adapter.id, { sourceId: result.adapter.id, label: result.adapter.label, message: result.error })
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
          if (options.onSourceFailures === undefined) errors.push(errorEntry(result.adapter.id, result.adapter.label, result.error))
          continue
        }
        if (result.page === undefined) continue
        items.push(...result.page.items)
        if (result.page.cursor !== undefined) nextCursors[result.adapter.id] = result.page.cursor
      }
      items.sort((left, right) => {
        const byName = left.title < right.title ? -1 : left.title > right.title ? 1 : 0
        if (byName !== 0) return byName
        const leftPath = assetItemOf(left)?.virtualPath ?? ''
        const rightPath = assetItemOf(right)?.virtualPath ?? ''
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
      })
      return {
        items: [...items, ...errors],
        ...(Object.keys(nextCursors).length > 0
          ? { cursor: JSON.stringify({ version: 1, signature, cursors: nextCursors } satisfies CrossMountCursor) }
          : {}),
      }
    },
  }
}
