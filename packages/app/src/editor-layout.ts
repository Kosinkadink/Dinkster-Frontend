/**
 * Editor split layout model (#105): the center region as a tree of editor
 * groups so two or more tabs render simultaneously. Leaves are groups (an
 * ordered subset of the open tabs with one active tab); interior nodes are
 * binary row/column splits with a ratio. One focused group defines what
 * "the active tab" means globally.
 *
 * The open-tab list (app-state) stays the single source of truth for WHICH
 * documents are open; this tree holds only tab ids and is repaired at the
 * read boundary: unknown ids drop, orphan open tabs append to the focused
 * group, empty groups prune, single-child splits collapse. Tab-close code
 * therefore never needs to know the tree exists.
 *
 * Everything here is pure and structural. Rendering, drag interaction, and
 * persistence wiring live with their hosts.
 */

/** Splits beyond this depth refuse; deeper trees stop being usable. */
export const MAX_SPLIT_DEPTH = 4

export const SPLIT_RATIO_MIN = 0.1
export const SPLIT_RATIO_MAX = 0.9

export interface EditorGroup {
  readonly kind: 'group'
  /** Stable within one layout; regenerated ids never collide (nextGroupId). */
  readonly id: string
  /** Tab ids in strip order. A tab id appears in at most one group. */
  readonly tabIds: readonly string[]
  /** '' only while the group is empty (mirrors app-state's activeTabId). */
  readonly activeTabId: string
}

export interface EditorSplit {
  readonly kind: 'split'
  readonly direction: 'row' | 'column'
  /** Share of `first`, clamped to [SPLIT_RATIO_MIN, SPLIT_RATIO_MAX]. */
  readonly ratio: number
  readonly first: EditorLayoutNode
  readonly second: EditorLayoutNode
}

export type EditorLayoutNode = EditorGroup | EditorSplit

export interface EditorLayout {
  readonly root: EditorLayoutNode
  readonly focusedGroupId: string
}

/** A path from the root: which child to descend into at each split. */
export type SplitPath = readonly ('first' | 'second')[]

export const clampSplitRatio = (ratio: number): number =>
  Number.isFinite(ratio) ? Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)) : 0.5

export const singleGroupLayout = (
  tabIds: readonly string[] = [],
  activeTabId: string = tabIds[0] ?? '',
  id = 'group-1',
): EditorLayout => ({
  root: { kind: 'group', id, tabIds, activeTabId: tabIds.includes(activeTabId) ? activeTabId : (tabIds[0] ?? '') },
  focusedGroupId: id,
})

/** Groups in reading order (splits recurse first child before second). */
export function layoutGroups(node: EditorLayoutNode): readonly EditorGroup[] {
  return node.kind === 'group' ? [node] : [...layoutGroups(node.first), ...layoutGroups(node.second)]
}

export const findGroup = (layout: EditorLayout, id: string): EditorGroup | undefined =>
  layoutGroups(layout.root).find((group) => group.id === id)

export const focusedGroup = (layout: EditorLayout): EditorGroup => {
  const groups = layoutGroups(layout.root)
  return groups.find((group) => group.id === layout.focusedGroupId) ?? groups[0]!
}

/** Smallest 'group-N' not currently used in the layout. */
export function nextGroupId(layout: EditorLayout): string {
  const used = new Set(layoutGroups(layout.root).map((group) => group.id))
  for (let n = 1; ; n += 1) {
    const id = `group-${n}`
    if (!used.has(id)) return id
  }
}

const splitDepth = (node: EditorLayoutNode): number =>
  node.kind === 'group' ? 0 : 1 + Math.max(splitDepth(node.first), splitDepth(node.second))

const mapGroups = (
  node: EditorLayoutNode,
  fn: (group: EditorGroup) => EditorLayoutNode,
): EditorLayoutNode =>
  node.kind === 'group'
    ? fn(node)
    : { ...node, first: mapGroups(node.first, fn), second: mapGroups(node.second, fn) }

/** Active tab after removing `tabId`: the next tab, else the previous one. */
const activeAfterRemoval = (
  tabIds: readonly string[],
  removed: string,
  active: string,
): string => {
  const remaining = tabIds.filter((id) => id !== removed)
  if (active !== removed) return active
  const index = tabIds.indexOf(removed)
  return remaining[Math.min(index, remaining.length - 1)] ?? ''
}

/** Prune empty groups and collapse single-child splits, bottom-up. */
const pruneNode = (node: EditorLayoutNode): EditorLayoutNode | undefined => {
  if (node.kind === 'group') return node.tabIds.length === 0 ? undefined : node
  const first = pruneNode(node.first)
  const second = pruneNode(node.second)
  if (first !== undefined && second !== undefined) return { ...node, first, second }
  return first ?? second
}

const restoreGroupInvariants = (group: EditorGroup): EditorGroup =>
  group.tabIds.includes(group.activeTabId)
    ? group
    : { ...group, activeTabId: group.tabIds[0] ?? '' }

const restoreFocus = (root: EditorLayoutNode, focusedGroupId: string): EditorLayout => {
  const groups = layoutGroups(root)
  return {
    root,
    focusedGroupId: groups.some((group) => group.id === focusedGroupId)
      ? focusedGroupId
      : groups[0]!.id,
  }
}

/**
 * Read-boundary repair against the open-tab list: drop unknown tab ids and
 * duplicates (first group wins), append orphan open tabs to the focused
 * group in open order, prune emptied groups, collapse single-child splits,
 * and restore active-tab and focus invariants. Always yields at least one
 * group.
 */
export function repairEditorLayout(
  layout: EditorLayout,
  openTabIds: readonly string[],
): EditorLayout {
  const open = new Set(openTabIds)
  const seen = new Set<string>()
  const filtered = mapGroups(layout.root, (group) => {
    const tabIds: string[] = []
    for (const id of group.tabIds) {
      if (!open.has(id) || seen.has(id)) continue
      seen.add(id)
      tabIds.push(id)
    }
    return restoreGroupInvariants({ ...group, tabIds })
  })
  const orphans = openTabIds.filter((id) => !seen.has(id))
  const focusId =
    layoutGroups(filtered).some((group) => group.id === layout.focusedGroupId)
      ? layout.focusedGroupId
      : undefined
  const adopted =
    orphans.length === 0
      ? filtered
      : mapGroups(filtered, (group) =>
          group.id === (focusId ?? layoutGroups(filtered)[0]!.id)
            ? restoreGroupInvariants({
                ...group,
                tabIds: [...group.tabIds, ...orphans],
                activeTabId: group.activeTabId === '' ? (orphans[0] ?? '') : group.activeTabId,
              })
            : group,
        )
  const pruned = pruneNode(adopted)
  if (pruned === undefined) return singleGroupLayout()
  return restoreFocus(pruned, layout.focusedGroupId)
}

/**
 * Move `tabId` into a new group split off `groupId`. The new group becomes
 * focused and sits at `position`: second (right/bottom, the default) or
 * first (left/top). Refused unchanged when the group or tab is unknown, the
 * tab is the group's only tab (the split would just shuffle it), or the
 * resulting tree would exceed MAX_SPLIT_DEPTH.
 */
export function splitGroup(
  layout: EditorLayout,
  groupId: string,
  direction: 'row' | 'column',
  tabId: string,
  position: 'first' | 'second' = 'second',
): EditorLayout {
  const target = findGroup(layout, groupId)
  const source = layoutGroups(layout.root).find((group) => group.tabIds.includes(tabId))
  if (target === undefined || source === undefined) return layout
  if (source.id === target.id && source.tabIds.length === 1) return layout
  const newId = nextGroupId(layout)
  const withoutTab = mapGroups(layout.root, (group) =>
    group.tabIds.includes(tabId)
      ? {
          ...group,
          tabIds: group.tabIds.filter((id) => id !== tabId),
          activeTabId: activeAfterRemoval(group.tabIds, tabId, group.activeTabId),
        }
      : group,
  )
  const created: EditorGroup = { kind: 'group', id: newId, tabIds: [tabId], activeTabId: tabId }
  const splitAt = mapGroups(withoutTab, (group) =>
    group.id === groupId
      ? ({
          kind: 'split',
          direction,
          ratio: 0.5,
          first: position === 'first' ? created : group,
          second: position === 'first' ? group : created,
        } satisfies EditorSplit)
      : group,
  )
  const pruned = pruneNode(splitAt)
  if (pruned === undefined || splitDepth(pruned) > MAX_SPLIT_DEPTH) return layout
  return { root: pruned, focusedGroupId: newId }
}

/**
 * Move a tab into an existing group at `index` (clamped; appended when
 * omitted). The moved tab becomes the target's active tab and the target
 * becomes focused; an emptied source group prunes away. Refused unchanged
 * when the tab or target is unknown.
 */
export function moveTabToGroup(
  layout: EditorLayout,
  tabId: string,
  targetGroupId: string,
  index?: number,
): EditorLayout {
  const target = findGroup(layout, targetGroupId)
  const source = layoutGroups(layout.root).find((group) => group.tabIds.includes(tabId))
  if (target === undefined || source === undefined) return layout
  if (source.id === targetGroupId && source.tabIds.length === 1) return layout
  const moved = mapGroups(layout.root, (group) => {
    const without = group.tabIds.filter((id) => id !== tabId)
    if (group.id === targetGroupId) {
      const at = Math.max(0, Math.min(index ?? without.length, without.length))
      return {
        ...group,
        tabIds: [...without.slice(0, at), tabId, ...without.slice(at)],
        activeTabId: tabId,
      }
    }
    return group.tabIds.includes(tabId)
      ? { ...group, tabIds: without, activeTabId: activeAfterRemoval(group.tabIds, tabId, group.activeTabId) }
      : group
  })
  const pruned = pruneNode(moved)
  if (pruned === undefined) return layout
  return restoreFocus(pruned, targetGroupId)
}

/**
 * Reorder a group's tab strip. `order` must be a permutation of the group's
 * current tab ids; anything else is refused unchanged.
 */
export function setGroupTabOrder(
  layout: EditorLayout,
  groupId: string,
  order: readonly string[],
): EditorLayout {
  const group = findGroup(layout, groupId)
  if (group === undefined) return layout
  if (order.length !== group.tabIds.length) return layout
  const current = new Set(group.tabIds)
  if (!order.every((id) => current.has(id)) || new Set(order).size !== order.length) return layout
  return {
    ...layout,
    root: mapGroups(layout.root, (node) =>
      node.id === groupId ? { ...node, tabIds: order } : node,
    ),
  }
}

/**
 * Dissolve a group by merging its tabs into the neighboring group (the
 * previous group in reading order, else the next). The merged tabs append in
 * strip order, the dissolved group's active tab becomes the neighbor's
 * active tab, and the neighbor takes focus. Refused unchanged when the group
 * is unknown or is the only group.
 */
export function dissolveGroup(layout: EditorLayout, groupId: string): EditorLayout {
  const groups = layoutGroups(layout.root)
  const index = groups.findIndex((group) => group.id === groupId)
  if (index === -1 || groups.length < 2) return layout
  const source = groups[index]!
  const target = groups[index === 0 ? 1 : index - 1]!
  const merged = mapGroups(layout.root, (group) => {
    if (group.id === target.id) {
      return {
        ...group,
        tabIds: [...group.tabIds, ...source.tabIds],
        activeTabId: source.activeTabId !== '' ? source.activeTabId : group.activeTabId,
      }
    }
    return group.id === source.id ? { ...group, tabIds: [], activeTabId: '' } : group
  })
  const pruned = pruneNode(merged)
  if (pruned === undefined) return layout
  return restoreFocus(pruned, target.id)
}

/** Make `tabId` the group's visible tab; unknown pairs are refused. */
export function setActiveTab(layout: EditorLayout, groupId: string, tabId: string): EditorLayout {
  const group = findGroup(layout, groupId)
  if (group === undefined || !group.tabIds.includes(tabId)) return layout
  return {
    ...layout,
    root: mapGroups(layout.root, (node) =>
      node.id === groupId ? { ...node, activeTabId: tabId } : node,
    ),
  }
}

/** Focus a group; unknown ids are refused. */
export function focusGroup(layout: EditorLayout, groupId: string): EditorLayout {
  if (findGroup(layout, groupId) === undefined) return layout
  return { ...layout, focusedGroupId: groupId }
}

/** Set the ratio of the split at `path` from the root; non-splits refuse. */
export function setSplitRatioAt(
  layout: EditorLayout,
  path: SplitPath,
  ratio: number,
): EditorLayout {
  const rebuild = (node: EditorLayoutNode, at: number): EditorLayoutNode | undefined => {
    if (node.kind !== 'split') return undefined
    if (at === path.length) return { ...node, ratio: clampSplitRatio(ratio) }
    const key = path[at]!
    const child = rebuild(node[key], at + 1)
    return child === undefined ? undefined : { ...node, [key]: child }
  }
  const root = rebuild(layout.root, 0)
  return root === undefined ? layout : { ...layout, root }
}

export const encodeEditorLayout = (layout: EditorLayout): string =>
  JSON.stringify({ v: 1, root: layout.root, focusedGroupId: layout.focusedGroupId })

const decodeNode = (
  value: unknown,
  depth: number,
  groupIds: Set<string>,
  tabIds: Set<string>,
): EditorLayoutNode | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (row['kind'] === 'group') {
    if (typeof row['id'] !== 'string' || row['id'].length === 0 || groupIds.has(row['id'])) return undefined
    if (!Array.isArray(row['tabIds'])) return undefined
    if (!row['tabIds'].every((id): id is string => typeof id === 'string' && id.length > 0)) return undefined
    if (typeof row['activeTabId'] !== 'string') return undefined
    groupIds.add(row['id'])
    for (const id of row['tabIds']) {
      if (tabIds.has(id)) return undefined
      tabIds.add(id)
    }
    return restoreGroupInvariants({
      kind: 'group',
      id: row['id'],
      tabIds: row['tabIds'],
      activeTabId: row['activeTabId'],
    })
  }
  if (row['kind'] === 'split') {
    if (depth >= MAX_SPLIT_DEPTH) return undefined
    if (row['direction'] !== 'row' && row['direction'] !== 'column') return undefined
    if (typeof row['ratio'] !== 'number') return undefined
    const first = decodeNode(row['first'], depth + 1, groupIds, tabIds)
    const second = decodeNode(row['second'], depth + 1, groupIds, tabIds)
    if (first === undefined || second === undefined) return undefined
    return { kind: 'split', direction: row['direction'], ratio: clampSplitRatio(row['ratio']), first, second }
  }
  return undefined
}

/**
 * Read-boundary decode (FR11): anything structurally wrong - duplicate
 * group or tab ids, unknown kinds, over-deep trees - yields undefined so
 * the caller falls back to a fresh single group. Callers still repair
 * against the live open-tab list afterwards.
 */
export function decodeEditorLayout(raw: string): EditorLayout | undefined {
  if (raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const envelope = parsed as Record<string, unknown>
  if (envelope['v'] !== 1) return undefined
  if (typeof envelope['focusedGroupId'] !== 'string') return undefined
  const root = decodeNode(envelope['root'], 0, new Set(), new Set())
  if (root === undefined) return undefined
  return restoreFocus(root, envelope['focusedGroupId'])
}
