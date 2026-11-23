/**
 * `dynamic.removeMember {graphId, nodeId, construct, member}`: remove one
 * stored member of a group and everything stored under it - its values,
 * controller modes, choices and inner groups, and its label. The group's
 * `seq` stays, so the key is never offered again.
 *
 * A member something is wired to cannot be removed: the document check that
 * runs after every command refuses a wire to a member that is gone, so the
 * whole command fails and nothing changes. Whether the group may go below
 * its least count is the caller's to decide; the command checks structure only.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { DynamicPortState, Json, JsonObject } from '../format/document.js'
import type { CommandDefinition } from './contract.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A flattened id that lies in `member` of `construct`: the member's own value or a row under it. */
const isUnder = (key: string, construct: string, member: string): boolean =>
  key === `${construct}.${member}` || key.startsWith(`${construct}.${member}.`)

const dynamicRemoveMember: CommandDefinition = {
  id: 'dynamic.removeMember',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.nodeId !== 'string' ||
      typeof params.construct !== 'string' || typeof params.member !== 'string') {
      return [err('params.invalid', 'dynamic.removeMember: params must be {graphId, nodeId, construct, member}')]
    }
    const { graphId, nodeId, construct, member } = params
    const node = doc.graphs[graphId]?.nodes[nodeId]
    if (node === undefined) return [err('node.missing', `dynamic.removeMember: unknown node '${nodeId}' in graph '${graphId}'`)]
    const state = node.dynamic?.[construct]
    if (state?.members?.includes(member) !== true) {
      return [err('dynamic.memberMissing', `dynamic.removeMember: group '${construct}' stores no member '${member}'`)]
    }

    const nodePath = ['graphs', graphId, 'nodes', nodeId]
    for (const key of Object.keys(node.values)) {
      if (isUnder(key, construct, member)) tx.remove([...nodePath, 'values', key])
    }
    for (const key of Object.keys(node.controllers ?? {})) {
      if (isUnder(key, construct, member)) tx.remove([...nodePath, 'controllers', key])
    }

    const dynamic: Record<string, DynamicPortState> = {}
    for (const [key, item] of Object.entries(node.dynamic ?? {})) {
      if (!isUnder(key, construct, member)) dynamic[key] = item
    }
    const members = state.members.filter((item) => item !== member)
    const { [member]: _label, ...labels } = state.memberLabels ?? {}
    const { members: _members, memberLabels: _labels, ...rest } = state
    // `rest` keeps `seq`, which dynamic.materialize advanced past every numbered key it stored.
    dynamic[construct] = {
      ...rest,
      ...(members.length > 0 ? { members } : {}),
      ...(Object.keys(labels).length > 0 ? { memberLabels: labels } : {}),
    }
    tx.set([...nodePath, 'dynamic'], dynamic as unknown as Json)
    return []
  },
}

export const MEMBER_COMMANDS: readonly CommandDefinition[] = [dynamicRemoveMember]
