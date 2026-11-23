/**
 * Dynamic-state commands: the write path for `NodeData.dynamic`.
 *
 * Elaboration synthesizes min-fill members and one trailing ghost per family
 * as VIEW affordances; a committed document must never reference them as
 * link endpoints (hazard N3) - the compiler rejects such references. These
 * commands are how synthetic members become real:
 *
 * - `dynamic.materialize` persists family members (append-only, idempotent).
 *   The UI batches it with the action that grows the family (link.connect,
 *   node.setValue) so materialization is transactionally atomic with its
 *   cause - one undo step removes both.
 * - selection commands write a schema-authored dynamic choice (state.selected).
 * - `dynamic.moveMember` reorders a reorderable group's stored members.
 *
 * Every command addresses its construct by flattened id ('items',
 * 'items.item1.mode'); all state lives at that key of `NodeData.dynamic`.
 * Commands validate structure only; the caller derives frames from the
 * elaborated interface.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { DynamicPortState, GraphDef, Json, JsonObject, WorkflowDocument } from '../format/document.js'
import { resolveDynamicAddress } from '../format/document.js'
import type { CommandDefinition } from './contract.js'
import { isPortEndpoint, MAX_MEMBER_ORDINAL } from '../ids.js'
import { DEFAULT_ELAB_BUDGET } from '../schema/elaborate.js'
import { constructsOf } from '../schema/body.js'
import type { ChoiceSpec, GroupSpec } from '../schema/model.js'
import { checkDocument, subgraphDefIdOf } from '../invariants.js'
import { allNodesOf, storeStartState } from './start-state.js'
import { boundaryItems } from '../format/document.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function graphOf(doc: WorkflowDocument, graphId: Json | undefined): GraphDef | undefined {
  return typeof graphId === 'string' ? doc.graphs[graphId] : undefined
}

/**
 * Highest numeric suffix among `m<N>` member ids (-1 when none). Mirrors the
 * elaborator's scan (elaborate.ts) so `seq` stays "next fresh ordinal" even
 * when fixtures hand-write member ids.
 */
const maxMemberSuffix = (ids: Iterable<string>): number => {
  let max = -1
  for (const m of ids) {
    const match = /^m(\d{1,15})$/.exec(m)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

// ---------------------------------------------------------------------------
// dynamic.materialize {graphId, nodeId, frames: [{construct, members[]}...]}
// ---------------------------------------------------------------------------

interface MaterializeFrameJson extends JsonObject {
  readonly construct: string
  readonly members: readonly string[]
  readonly seq?: number
}

const isFrame = (v: Json | undefined): v is MaterializeFrameJson =>
  isObj(v) &&
  typeof v.construct === 'string' &&
  v.construct.length > 0 &&
  Array.isArray(v.members) &&
  v.members.length > 0 &&
  v.members.every((m) => typeof m === 'string' && m.length > 0) &&
  new Set(v.members).size === v.members.length &&
  (v.seq === undefined || (typeof v.seq === 'number' && Number.isSafeInteger(v.seq) && v.seq >= 0 && v.seq <= MAX_MEMBER_ORDINAL))

/**
 * Persist each frame's members into the state of its group, which is keyed
 * by the group's flattened id: append the missing ones in order and advance
 * `seq` past them, so a removed key is never offered again. Appending keeps
 * the drawn order because offered members always come after stored ones.
 */
function materializeScope(
  scope: Readonly<Record<string, DynamicPortState>> | undefined,
  frames: readonly MaterializeFrameJson[],
): Record<string, DynamicPortState> {
  let next: Record<string, DynamicPortState> = { ...scope }
  for (const frame of frames) {
    const state = next[frame.construct] ?? {}
    const members = [...(state.members ?? [])]
    for (const m of frame.members) if (!members.includes(m)) members.push(m)
    const seq = Math.max(state.seq ?? 0, frame.seq ?? 0)
    next = { ...next, [frame.construct]: { ...state, members, ...(seq > 0 ? { seq } : {}) } }
  }
  return next
}

const dynamicMaterialize: CommandDefinition = {
  id: 'dynamic.materialize',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.nodeId !== 'string' ||
      !Array.isArray(params.frames) ||
      params.frames.length === 0 ||
      !params.frames.every(isFrame)
    )
      return [
        err(
          'params.invalid',
          'dynamic.materialize: params must be {graphId, nodeId, frames: [{construct, members[]}, ...]}',
        ),
      ]
    // One frame per group on the target's path, so elaboration's depth
    // budget bounds a well-formed frame list.
    if (params.frames.length > DEFAULT_ELAB_BUDGET.maxDepth)
      return [
        err(
          'dynamic.tooDeep',
          `dynamic.materialize: ${params.frames.length} frames exceed the nesting cap of ${DEFAULT_ELAB_BUDGET.maxDepth}`,
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.materialize: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.materialize: unknown node '${params.nodeId}'`)]

    const frames = params.frames as readonly MaterializeFrameJson[]
    const next = materializeScope(node.dynamic, frames)
    // Idempotent: re-materializing persisted members records no transaction.
    if (JSON.stringify(next) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// dynamic.selectOption {graphId, nodeId, construct, option}
// ---------------------------------------------------------------------------

/** Edit the choice or editable-menu state stored at `construct`. */
function editState(
  scope: Readonly<Record<string, DynamicPortState>> | undefined,
  construct: string,
  update: { readonly selected: string | null } | { readonly options: readonly (string | number | boolean)[] },
): Record<string, DynamicPortState> {
  const next: { -readonly [K in keyof DynamicPortState]: DynamicPortState[K] } = { ...scope?.[construct] }
  if ('options' in update) next.options = update.options
  else if (update.selected === null) delete next.selected
  else next.selected = update.selected
  return { ...scope, [construct]: next }
}

const dynamicSelectOption: CommandDefinition = {
  id: 'dynamic.selectOption',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.nodeId !== 'string' ||
      typeof params.construct !== 'string' ||
      params.construct.length === 0 ||
      typeof params.option !== 'string'
    )
      return [
        err(
          'params.invalid',
          'dynamic.selectOption: params must be {graphId, nodeId, construct, option}',
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.selectOption: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.selectOption: unknown node '${params.nodeId}'`)]

    const next = editState(node.dynamic, params.construct, { selected: params.option })
    // Idempotent: re-selecting the current option records no transaction.
    if (JSON.stringify(next) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next as unknown as Json)
    return []
  },
}

const dynamicSetOptions: CommandDefinition = {
  id: 'dynamic.setOptions',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.nodeId !== 'string' ||
      typeof params.construct !== 'string' || params.construct.length === 0 ||
      !Array.isArray(params.options) || !params.options.every((option) =>
        typeof option === 'string' || typeof option === 'boolean' ||
        typeof option === 'number' && Number.isFinite(option))) {
      return [err('params.invalid', 'dynamic.setOptions: params must be {graphId, nodeId, construct, options: scalar[]}')]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.setOptions: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.setOptions: unknown node '${params.nodeId}'`)]
    const next = editState(node.dynamic, params.construct, { options: params.options as readonly (string | number | boolean)[] })
    if (JSON.stringify(next) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// dynamic.labelMember {graphId, nodeId, construct, member, label}
// ---------------------------------------------------------------------------

type LabelResult =
  | { readonly ok: true; readonly scope: Record<string, DynamicPortState> }
  | { readonly ok: false; readonly diagnostic: Diagnostic }

function labelMembers(
  scope: Readonly<Record<string, DynamicPortState>> | undefined,
  construct: string,
  updates: Readonly<Record<string, string | null>>,
): LabelResult {
  const state = scope?.[construct]
  if (state?.members === undefined) {
    return { ok: false, diagnostic: err('dynamic.unknownMember',
      `dynamic.labelMember: family '${construct}' is not materialized`) }
  }
  const members = state.members
  const unknownMember = Object.keys(updates).find((member) => !members.includes(member))
  if (unknownMember !== undefined) {
    return { ok: false, diagnostic: err('dynamic.unknownMember',
      `dynamic.labelMember: member '${unknownMember}' of family '${construct}' is not materialized`) }
  }
  const labels = { ...state.memberLabels }
  for (const [member, label] of Object.entries(updates)) {
    if (label === null || label === member) delete labels[member]
    else labels[member] = label
  }
  const effective = members.map((candidate) => labels[candidate] ?? candidate)
  if (new Set(effective).size !== effective.length) {
    return { ok: false, diagnostic: err('dynamic.duplicateMemberLabel',
      `dynamic.labelMember: labels for family '${construct}' must be unique`) }
  }
  const nextState: DynamicPortState = { ...state, ...(Object.keys(labels).length > 0 ? { memberLabels: labels } : {}) }
  if (Object.keys(labels).length === 0) delete (nextState as { memberLabels?: Readonly<Record<string, string>> }).memberLabels
  return { ok: true, scope: {
    ...scope,
    [construct]: nextState,
  } }
}

const dynamicLabelMember: CommandDefinition = {
  id: 'dynamic.labelMember',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.nodeId !== 'string' ||
        typeof params.construct !== 'string' || params.construct.length === 0 ||
        typeof params.member !== 'string' || params.member.length === 0 ||
        (params.label !== null && (typeof params.label !== 'string' || params.label.trim().length === 0))) {
      return [err('params.invalid', 'dynamic.labelMember: params must be {graphId, nodeId, construct, member, label: string|null}')]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.labelMember: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.labelMember: unknown node '${params.nodeId}'`)]
    const label = typeof params.label === 'string' ? params.label.trim() : null
    const next = labelMembers(node.dynamic, params.construct, { [params.member]: label })
    if (!next.ok) return [next.diagnostic]
    if (JSON.stringify(next.scope) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next.scope as unknown as Json)
    return []
  },
}

const dynamicLabelMembers: CommandDefinition = {
  id: 'dynamic.labelMembers',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.nodeId !== 'string' ||
        typeof params.construct !== 'string' || params.construct.length === 0 ||
        !isObj(params.labels) || Object.keys(params.labels).length === 0 ||
        !Object.entries(params.labels).every(([member, label]) => member.length > 0 &&
          (label === null || typeof label === 'string' && label.trim().length > 0))) {
      return [err('params.invalid', 'dynamic.labelMembers: params must be {graphId, nodeId, construct, labels: {member: string|null}}')]
    }
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.labelMembers: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.labelMembers: unknown node '${params.nodeId}'`)]
    const labels = Object.fromEntries(Object.entries(params.labels).map(([member, label]) => [
      member, typeof label === 'string' ? label.trim() : null,
    ]))
    const next = labelMembers(node.dynamic, params.construct, labels)
    if (!next.ok) return [next.diagnostic]
    if (JSON.stringify(next.scope) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next.scope as unknown as Json)
    return []
  },
}

// Slot specialization deliberately shares the choice editor: selected has one
// persisted home, and idempotence semantics must not drift. Like every core
// command this remains schema-blind; elaboration diagnoses an unknown key
// rather than commands coupling document edits to schema lookup.
const dynamicSpecializeSlot: CommandDefinition = {
  id: 'dynamic.specializeSlot',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.nodeId !== 'string' || typeof params.construct !== 'string' ||
      params.construct.length === 0 || (params.variant !== null && typeof params.variant !== 'string'))
      return [err('params.invalid', 'dynamic.specializeSlot: params must be {graphId, nodeId, construct, variant: string|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.specializeSlot: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.specializeSlot: unknown node '${params.nodeId}'`)]
    const next = editState(node.dynamic, params.construct, { selected: params.variant as string | null })
    if (JSON.stringify(next) === JSON.stringify(node.dynamic ?? {})) return []
    tx.set(['graphs', params.graphId as string, 'nodes', params.nodeId, 'dynamic'], next as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// dynamic.compact {graphId, nodeId}
// ---------------------------------------------------------------------------

/** A group, by its flattened id, and one of its members that something references. */
interface MemberReference {
  readonly construct: string
  readonly member: string
}

const portIsWithin = (port: string, construct: string): boolean =>
  port === construct || port.startsWith(`${construct}.`)

/**
 * Drop every member of every group that no reference names, and everything
 * stored under it. Each group's state sits at its flattened id, so a
 * reference keeps a member when the reference's group is this group or lies
 * within it and the reference names that member key. A group that grows by
 * hand keeps its first unused members up to its minimum.
 */
function compactScope(
  scope: Readonly<Record<string, DynamicPortState>>,
  references: readonly MemberReference[],
  constructs: ReadonlyMap<string, GroupSpec | ChoiceSpec> | undefined,
): Record<string, DynamicPortState> {
  const result: Record<string, DynamicPortState> = {}
  const removed: string[] = []
  for (const [construct, state] of Object.entries(scope)) {
    if (state.members === undefined) {
      result[construct] = state
      continue
    }

    const kept = new Set(state.members.filter((member) =>
      references.some((ref) => portIsWithin(ref.construct, construct) && ref.member === member)))
    const group = constructs?.get(construct)
    const minimum = group?.kind === 'group' && typeof group.grows === 'string' ? group.minMembers : 0
    for (const member of state.members) {
      if (kept.size >= minimum) break
      kept.add(member)
    }
    const members: string[] = []
    const memberLabels: Record<string, string> = {}
    for (const member of state.members) {
      if (!kept.has(member)) {
        removed.push(`${construct}.${member}.`)
        continue
      }
      members.push(member)
      if (state.memberLabels?.[member] !== undefined) memberLabels[member] = state.memberLabels[member]!
    }

    // Keep seq even when the family empties: member ids must never be reused.
    // Empty members containers are omitted as canonical form.
    const { members: _members, memberLabels: _memberLabels, ...rest } = state
    const inferredSeq = Math.max(state.seq ?? 0, maxMemberSuffix(state.members) + 1)
    result[construct] = {
      ...rest,
      seq: inferredSeq,
      ...(members.length > 0 ? { members } : {}),
      ...(Object.keys(memberLabels).length > 0 ? { memberLabels } : {}),
    }
  }
  for (const construct of Object.keys(result)) {
    if (removed.some((prefix) => construct.startsWith(prefix))) delete result[construct]
  }
  return result
}

const dynamicCompact: CommandDefinition = {
  id: 'dynamic.compact',
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string')
      return [err('params.invalid', 'dynamic.compact: params must be {graphId, nodeId}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.compact: unknown graph '${String(params.graphId)}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.compact: unknown node '${params.nodeId}'`)]
    if (node.dynamic === undefined) return []
    if (checkDocument(doc).some((diagnostic) =>
      diagnostic.code.startsWith('doc.occurrenceTopology.') || diagnostic.code === 'doc.dynamic.memberMissing')) return []

    const references: MemberReference[] = []
    const add = (ref: { readonly node: string; readonly port: string }): void => {
      if (ref.node !== params.nodeId) return
      const resolved = resolveDynamicAddress(ref, node.dynamic)
      if (resolved.kind === 'resolved') references.push(...resolved.references)
    }
    for (const link of Object.values(def.links)) {
      if (isPortEndpoint(link.from)) add(link.from)
      if (isPortEndpoint(link.to)) add(link.to)
    }
    for (const net of Object.values(def.nets)) {
      add(net.source)
      for (const sink of net.sinks) add(sink)
    }

    // Occurrence-local links can retain definition-owned members directly or
    // occurrence-owned members through a boundary source coordinate. Resolve
    // owner paths structurally; malformed paths fail safe by retaining state.
    let unresolvedOverlay = false
    for (const topology of Object.values(doc.occurrenceTopologies ?? {})) {
      let parent = doc.graphs[doc.root]
      for (const hop of topology.owner.instancePath) {
        const occurrence = parent?.nodes[hop]
        const childId = occurrence && subgraphDefIdOf(occurrence.type)
        parent = childId === undefined ? undefined : doc.graphs[childId]
      }
      const ownerNode = parent?.nodes[topology.owner.node]
      if (!parent || !ownerNode || subgraphDefIdOf(ownerNode.type) !== topology.bodyGraph) {
        unresolvedOverlay = true
        continue
      }
      for (const link of Object.values(topology.links)) {
        for (const endpoint of [link.from, link.to]) {
          if (endpoint.kind === 'body') {
            if (topology.bodyGraph === params.graphId && isPortEndpoint(endpoint.endpoint)) add(endpoint.endpoint)
            continue
          }
          let endpointParent = doc.graphs[doc.root]
          for (const hop of endpoint.occurrence.instancePath) {
            const occurrence = endpointParent?.nodes[hop]
            const childId = occurrence && subgraphDefIdOf(occurrence.type)
            endpointParent = childId === undefined ? undefined : doc.graphs[childId]
          }
          if (!endpointParent || !endpointParent.nodes[endpoint.occurrence.node]) {
            unresolvedOverlay = true
            continue
          }
          if (endpoint.route.length === 0 || endpoint.route[endpoint.route.length - 1]!.graph !== topology.bodyGraph) {
            unresolvedOverlay = true
            continue
          }
          if (endpointParent.id === params.graphId && endpoint.occurrence.node === params.nodeId) {
            add({ node: endpoint.occurrence.node, port: endpoint.address.port })
          }
        }
      }
    }
    if (unresolvedOverlay) return []

    for (const item of [...(boundaryItems(def.boundary, 'inputs') ?? []), ...(boundaryItems(def.boundary, 'outputs') ?? [])]) {
      for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (binding.kind === 'port') add(binding)
      }
    }
    for (const key of Object.keys(node.values)) {
      const resolved = resolveDynamicAddress({ port: key }, node.dynamic)
      if (resolved.kind === 'resolved') references.push(...resolved.references)
    }
    // A chosen key or an authored menu stored at a flattened id under a
    // member is member-owned evidence even when no link or value is present,
    // so retain every group it lies within. A required choice on its start
    // key is what adding the member would give again, so it is not use.
    const schema = context.kind === 'initial' ? context.schemaResolverFor?.(doc)?.(node.type) : undefined
    const constructs = schema === undefined ? undefined : constructsOf(schema, node.dynamic)
    for (const [key, state] of Object.entries(node.dynamic)) {
      if (state.selected === undefined && state.options === undefined) continue
      const choice = constructs?.get(key)
      if (state.options === undefined && choice?.kind === 'choice' && choice.required && choice.leader === undefined &&
        state.selected === (choice.default ?? choice.options[0]?.key)) continue
      const resolved = resolveDynamicAddress({ port: key }, node.dynamic)
      if (resolved.kind === 'resolved') references.push(...resolved.references)
    }
    const next = compactScope(node.dynamic, references, constructs)
    if (JSON.stringify(next) === JSON.stringify(node.dynamic)) return []
    tx.set(['graphs', params.graphId, 'nodes', params.nodeId, 'dynamic'], next as unknown as Json)
    return []
  },
}

/**
 * dynamic.moveMember {graphId, nodeId, construct, member, index}: move one
 * stored member of a reorderable group to `index` in its stored order. Keys,
 * values, labels and `seq` stay, so a wire or a promoted row keeps pointing
 * at the same member; a member's shown number and the order a run receives
 * follow its new position.
 */
const dynamicMoveMember: CommandDefinition = {
  id: 'dynamic.moveMember',
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string' ||
      typeof params.construct !== 'string' || params.construct.length === 0 ||
      typeof params.member !== 'string' || typeof params.index !== 'number' || !Number.isSafeInteger(params.index))
      return [err('params.invalid', 'dynamic.moveMember: params must be {graphId, nodeId, construct, member, index}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `dynamic.moveMember: unknown graph '${params.graphId}'`)]
    const node = def.nodes[params.nodeId]
    if (!node) return [err('node.missing', `dynamic.moveMember: unknown node '${params.nodeId}'`)]
    // A shared session's rebase replays a move that was already checked.
    if (context.kind === 'initial') {
      const schema = context.schemaResolverFor?.(doc)?.(node.type)
      const group = schema === undefined ? undefined : constructsOf(schema, node.dynamic).get(params.construct)
      if (group?.kind !== 'group' || group.reorderable !== true || typeof group.grows !== 'string')
        return [err('dynamic.notReorderable', `dynamic.moveMember: '${params.construct}' is not a group whose members can be reordered`)]
    }
    const state = node.dynamic?.[params.construct]
    const members = [...(state?.members ?? [])]
    const from = members.indexOf(params.member)
    if (from < 0) return [err('dynamic.memberMissing', `dynamic.moveMember: '${params.construct}' has no stored member '${params.member}'`)]
    if (params.index < 0 || params.index >= members.length)
      return [err('params.invalid', `dynamic.moveMember: index ${params.index} is outside 0..${members.length - 1}`)]
    if (from === params.index) return []
    members.splice(from, 1)
    members.splice(params.index, 0, params.member)
    tx.set(['graphs', params.graphId, 'nodes', params.nodeId, 'dynamic'],
      { ...node.dynamic, [params.construct]: { ...state, members } } as unknown as Json)
    return []
  },
}

/**
 * dynamic.storeStartState {}: store the start key of every required choice,
 * and the minimum members of every group that grows by hand, in the
 * document that has nothing stored. Run when a document meets its
 * schemas; every other command does this for the nodes it changes.
 */
const dynamicStoreStartState: CommandDefinition = {
  id: 'dynamic.storeStartState',
  run(doc, _params, tx, context) {
    const resolve = context.kind === 'initial' ? context.schemaResolverFor?.(doc) : undefined
    if (resolve !== undefined) storeStartState(tx, resolve, allNodesOf(doc))
    return []
  },
}

export const DYNAMIC_COMMANDS: readonly CommandDefinition[] = [
  dynamicMaterialize,
  dynamicSelectOption,
  dynamicSetOptions,
  dynamicLabelMember,
  dynamicLabelMembers,
  dynamicSpecializeSlot,
  dynamicCompact,
  dynamicMoveMember,
  dynamicStoreStartState,
]
