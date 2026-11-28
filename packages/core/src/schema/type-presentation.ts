/** Presentation names never participate in type identity or compatibility. */
export const typeDisplayAliases: Readonly<Record<string, string>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, string>, {
    'comfy.IMAGE': 'IMAGE',
    'comfy.MASK': 'MASK',
  }),
)

export type TypeDisplayNames = ReadonlyMap<string, string>

/** One catalog snapshot owns collision detection; storage providers are irrelevant. */
export function typeDisplayNamesForCatalog(
  owners: ReadonlyMap<string, string | null>,
  installedPacks: ReadonlySet<string>,
): TypeDisplayNames {
  const names = new Map<string, string>()
  const collisions = new Map<string, Set<string>>()
  for (const [id, owner] of owners) {
    const alias = typeDisplayAliases[id]
    const label = alias ?? (owner !== null && id.startsWith(`${owner}.`) ? id.slice(owner.length + 1) : id)
    names.set(id, label)
    if (alias !== undefined || owner === null || !installedPacks.has(owner)) continue
    const packs = collisions.get(label) ?? new Set<string>()
    packs.add(owner)
    collisions.set(label, packs)
  }
  for (const [id, owner] of owners) {
    const label = names.get(id)!
    if (typeDisplayAliases[id] === undefined && owner !== null && installedPacks.has(owner) && (collisions.get(label)?.size ?? 0) > 1) {
      names.set(id, `${label} (${owner})`)
    }
  }
  return names
}

export function typeAtomDisplayLabel(id: string, names?: TypeDisplayNames): string {
  return typeDisplayAliases[id] ?? names?.get(id) ?? id
}
