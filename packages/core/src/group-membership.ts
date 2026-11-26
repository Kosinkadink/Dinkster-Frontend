import type { CommandInvocation } from './commands/contract.js'
import type { GroupMembership, JsonObject, WorkflowDocument } from './format/document.js'

export interface GroupItemGeometry {
  readonly kind: keyof GroupMembership
  readonly id: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type GroupGeometryResolver = (document: WorkflowDocument, graphId: string) => readonly GroupItemGeometry[]

const kinds = ['nodes', 'reroutes', 'groups', 'boundary'] as const
const empty = (): { [K in keyof GroupMembership]: Record<string, string> } => ({ nodes: {}, reroutes: {}, groups: {}, boundary: {} })

/** Transfer only relationships whose item and immediate parent both survive. */
export function remapGroupMembership(
  membership: GroupMembership,
  ids: { readonly [K in keyof GroupMembership]: ReadonlyMap<string, string> },
): GroupMembership {
  const result = empty()
  for (const kind of kinds) {
    for (const [oldId, oldParent] of Object.entries(membership[kind])) {
      const id = ids[kind].get(oldId)
      const parent = ids.groups.get(oldParent)
      if (id !== undefined && parent !== undefined) result[kind][id] = parent
    }
  }
  return result
}

/** Whether an item descends from a group, including nested groups. */
export function belongsToGroup(membership: GroupMembership, kind: keyof GroupMembership, id: string, groupId: string): boolean {
  const seen = new Set<string>()
  let parent = membership[kind][id]
  while (parent !== undefined && !seen.has(parent)) {
    if (parent === groupId) return true
    seen.add(parent)
    parent = membership.groups[parent]
  }
  return false
}

function containingGroup(item: GroupItemGeometry, geometry: readonly GroupItemGeometry[], membership: GroupMembership): string | undefined {
  return [...geometry].reverse().find((group) => group.kind === 'groups' &&
    !(item.kind === 'groups' && (item.id === group.id || belongsToGroup(membership, 'groups', group.id, item.id))) &&
    item.x >= group.x && item.y >= group.y &&
    item.x + item.width <= group.x + group.width && item.y + item.height <= group.y + group.height)?.id
}

/** Legacy workflows acquire a single full-bounds parent per item on their first edit. */
export function initialGroupMembership(geometry: readonly GroupItemGeometry[]): GroupMembership {
  const membership = empty()
  for (const item of [...geometry].sort((a, b) => Number(b.kind === 'groups') - Number(a.kind === 'groups'))) {
    const parent = containingGroup(item, geometry, membership)
    if (parent !== undefined) membership[item.kind][item.id] = parent
  }
  return membership
}

/** Apply creation/drop intentions without adopting items covered by container movement. */
export function groupMembershipAfter(
  before: WorkflowDocument,
  after: WorkflowDocument,
  graphId: string,
  invocation: CommandInvocation,
  geometryFor: GroupGeometryResolver,
): GroupMembership {
  const oldGeometry = geometryFor(before, graphId)
  const geometry = geometryFor(after, graphId)
  const authored = after.view.graphs[graphId]?.groupMembership !== undefined &&
    after.view.graphs[graphId]?.groupMembership !== before.view.graphs[graphId]?.groupMembership
  const baseline = before.view.graphs[graphId]?.groupMembership ?? initialGroupMembership(oldGeometry)
  const supplied = after.view.graphs[graphId]?.groupMembership
  const previous = supplied === undefined ? baseline : before.view.graphs[graphId]?.groupMembership !== undefined ? supplied : {
    nodes: { ...baseline.nodes, ...supplied.nodes },
    reroutes: { ...baseline.reroutes, ...supplied.reroutes },
    groups: { ...baseline.groups, ...supplied.groups },
    boundary: { ...baseline.boundary, ...supplied.boundary },
  }
  const membership = empty()
  const live = Object.fromEntries(kinds.map((kind) => [kind, new Set(geometry.filter((item) => item.kind === kind).map((item) => item.id))])) as Record<keyof GroupMembership, Set<string>>
  for (const kind of kinds) {
    for (const [id, parent] of Object.entries(previous[kind])) {
      if (live[kind].has(id) && live.groups.has(parent)) membership[kind][id] = parent
    }
  }
  const moved = Object.fromEntries(kinds.map((kind) => [kind, new Set<string>()])) as Record<keyof GroupMembership, Set<string>>
  const collect = (command: CommandInvocation): void => {
    if (typeof command.params !== 'object' || command.params === null || Array.isArray(command.params)) return
    const p = command.params as JsonObject
    if (command.command === 'batch' && Array.isArray(p.invocations)) {
      for (const entry of p.invocations) collect(entry as unknown as CommandInvocation)
    }
    if (p.graphId !== graphId) return
    const add = (kind: keyof GroupMembership, value: unknown): void => {
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        for (const id of Object.keys(value)) moved[kind].add(id)
    }
    if (command.command === 'node.move') add('nodes', p.positions)
    if (command.command === 'reroute.move') add('reroutes', p.positions)
    if (command.command === 'view.moveBoundaryNode' && typeof p.side === 'string') moved.boundary.add(p.side)
    if (command.command === 'view.moveGroup' && typeof p.groupId === 'string') moved.groups.add(p.groupId)
    if (command.command === 'selection.move') for (const kind of kinds) add(kind, p[kind])
  }
  collect(invocation)
  const oldIds = new Set(oldGeometry.map((item) => `${item.kind}:${item.id}`))
  const createdGroups = geometry.filter((item) => item.kind === 'groups' && !oldIds.has(`groups:${item.id}`))
  for (const item of [...geometry].sort((a, b) => Number(b.kind === 'groups') - Number(a.kind === 'groups'))) {
    const created = !authored && !oldIds.has(`${item.kind}:${item.id}`)
    const carried = [...moved.groups].some((group) => belongsToGroup(previous, item.kind, item.id, group))
    if (!created && !moved[item.kind].has(item.id)) {
      if (!authored) {
        const wrapper = containingGroup(item, createdGroups, membership)
        const parent = membership[item.kind][item.id]
        // A wrapper around a group keeps that group's children beneath it.
        if (wrapper !== undefined && !(parent !== undefined && belongsToGroup(membership, 'groups', parent, wrapper)))
          membership[item.kind][item.id] = wrapper
      }
      continue
    }
    if (carried) continue
    delete membership[item.kind][item.id]
    const parent = containingGroup(item, geometry, membership)
    if (parent !== undefined) membership[item.kind][item.id] = parent
  }
  return membership
}
