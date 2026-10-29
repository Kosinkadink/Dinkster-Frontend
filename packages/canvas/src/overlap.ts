export interface NodeBounds {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Executable-node body intersections; touching edges do not overlap. */
export function overlappingNodeIds(bounds: readonly NodeBounds[]): readonly string[] {
  const overlapping = new Set<string>()
  for (let i = 0; i < bounds.length; i++) {
    const a = bounds[i]!
    if (a.width <= 0 || a.height <= 0) continue
    for (let j = i + 1; j < bounds.length; j++) {
      const b = bounds[j]!
      if (b.width <= 0 || b.height <= 0) continue
      if (a.x < b.x + b.width && b.x < a.x + a.width &&
          a.y < b.y + b.height && b.y < a.y + a.height) {
        overlapping.add(a.id)
        overlapping.add(b.id)
      }
    }
  }
  return [...new Set(bounds.filter((node) => overlapping.has(node.id)).map((node) => node.id))]
}
