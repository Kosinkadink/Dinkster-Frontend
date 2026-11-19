import type { BoundaryItem, RegionContract } from '../format/document.js'

export function generatedBoundaryLabel(item: BoundaryItem): string {
  return item.binds.kind === 'unbound' || item.binds.kind === 'valueSource'
    ? item.id
    : item.binds.kind === 'widgetTap'
      ? item.binds.tap as string
      : item.binds.port as string
}

/** Exact binding ids; explicit display names are resolved by the caller. */
export function defaultBoundaryLabels(items: readonly BoundaryItem[]): ReadonlyMap<string, string> {
  return new Map(items.map((item) => [item.id, generatedBoundaryLabel(item)]))
}

/** Role-oriented labels for the outer interface of one region occurrence. */
export function regionBoundaryLabels(
  items: readonly BoundaryItem[],
  region: RegionContract,
  side: 'inputs' | 'outputs',
): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const item of items) {
    const base = side === 'inputs'
      ? region.elementPorts?.includes(item.id)
        ? 'Element'
        : region.statePorts?.includes(item.id)
          ? 'State'
          : 'Capture'
      : item.id === region.continueOutput
        ? 'Continuation'
        : (() => {
            const role = region.outputRoles?.[item.id]
            if (role?.kind === 'compact') return 'Compact'
            if (role?.kind === 'flatten') return 'Flatten'
            if (role?.kind === 'last') return 'Last'
            if (role?.kind === 'state') return 'State'
            return 'Gather'
          })()
    const ordinal = (counts.get(base) ?? 0) + 1
    counts.set(base, ordinal)
    labels.set(item.id, ordinal === 1 ? base : `${base} ${ordinal}`)
  }
  return labels
}
