import { committableAssetRef, isCompatible } from './helpers.js'
import type { IngestedLogicalModelDescription, LogicalModelAdapter, SourceRef, VariantDescription } from './logical-model.js'
import type { AssetBrowserItem, AssetSourceAdapter } from './types.js'

interface ObservedAsset {
  readonly item: AssetBrowserItem
  readonly ref: NonNullable<ReturnType<typeof committableAssetRef>>
}

const CANONICAL_DIGEST = /^blake3:[0-9a-f]{64}$/
const basename = (name: string): string => name.replace(/\\/g, '/').split('/').at(-1) ?? name

const compareObserved = (left: ObservedAsset, right: ObservedAsset): number => {
  const leftName = basename(left.item.name)
  const rightName = basename(right.item.name)
  if (leftName !== rightName) return leftName < rightName ? -1 : 1
  if (left.ref.virtualPath !== right.ref.virtualPath) return left.ref.virtualPath < right.ref.virtualPath ? -1 : 1
  return left.item.source.id < right.item.source.id ? -1 : left.item.source.id > right.item.source.id ? 1 : 0
}

async function scanSource(source: AssetSourceAdapter, kind: string): Promise<readonly AssetBrowserItem[]> {
  const items: AssetBrowserItem[] = []
  let cursor: string | undefined
  do {
    const page = await source.page({
      query: '',
      kind,
      recursive: true,
      limit: 200,
      ...(cursor !== undefined ? { cursor } : {}),
    })
    items.push(...page.items)
    cursor = page.cursor
  } while (cursor !== undefined)
  return items
}

/** Derive one fixture-shaped V1 adapter from the complete kind-scoped local mount catalog. */
export async function localMountScanAdapter(
  sources: readonly AssetSourceAdapter[],
  kind: string,
  accept: readonly string[] = [],
): Promise<LogicalModelAdapter> {
  const scanned = await Promise.all(sources.map((source) => scanSource(source, kind)))
  const byDigest = new Map<string, ObservedAsset[]>()
  for (const item of scanned.flat()) {
    if (!isCompatible(item, accept, kind)) continue
    const ref = committableAssetRef(item)
    if (ref === undefined) continue
    if (!CANONICAL_DIGEST.test(ref.digest) || basename(item.name) === '') continue
    const observed = byDigest.get(ref.digest) ?? []
    observed.push({ item, ref })
    byDigest.set(ref.digest, observed)
  }

  const byLogicalId = new Map<string, { displayName: string; aliases: Set<string>; variants: VariantDescription[] }>()
  for (const [digest, unsorted] of [...byDigest.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const observed = [...unsorted].sort(compareObserved)
    const primary = basename(observed[0]!.item.name)
    const logicalId = `local-name:${primary}`
    const model = byLogicalId.get(logicalId) ?? { displayName: primary, aliases: new Set<string>(), variants: [] }
    for (const entry of observed) {
      model.aliases.add(basename(entry.item.name))
      if (entry.ref.virtualPath !== '') model.aliases.add(entry.ref.virtualPath)
    }
    const providers = new Map<string, SourceRef>()
    for (const entry of observed) {
      providers.set(entry.item.source.id, {
        sourceId: entry.item.source.id,
        sourceKind: 'local-scan',
        label: entry.item.source.label,
      })
    }
    const selected = observed[0]!
    model.variants.push({
      variantId: digest,
      logicalId,
      size: selected.ref.size,
      digest,
      providers: [...providers.values()].sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0),
      availability: 'installed',
      compatibility: { status: 'unknown' },
      localRef: selected.ref,
    })
    byLogicalId.set(logicalId, model)
  }

  const descriptions: IngestedLogicalModelDescription[] = [...byLogicalId.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([logicalId, model]) => ({
      logicalId,
      displayName: model.displayName,
      kind,
      aliases: [...model.aliases].sort(),
      variants: model.variants,
    }))
  return {
    source: { sourceId: 'local-mount-scan', sourceKind: 'local-scan', label: 'Local mounts' },
    descriptions,
  }
}
