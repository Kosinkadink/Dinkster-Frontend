/**
 * Boundary-editing commands: the write path for a subgraph definition's
 * boundary items - slot-selective family forwarding (`binds.slots`, hazard
 * F10) and input fan-out (`alsoBinds`).
 *
 * Like every core command these are SCHEMA-BLIND and deterministic: they
 * validate structure (item exists, binding kind, selection grammar and
 * prefix-conflict rules) and write exactly what the params describe.
 * Template-aware validation (unknown paths, narrowing into non-autogrow
 * constructs, starvation) is derivation's job - deriveBoundarySchema reports
 * boundary.slotUnknown / boundary.slotNotNestable / boundary.slotStarved
 * against whatever the document says, so an editor surfaces those inline
 * without commands needing a schema resolver (which would break command
 * determinism/serializability).
 *
 * Selection is CANONICALIZED before writing: entries are deduplicated and
 * sorted lexicographically. The derived template is filtered in TEMPLATE
 * order regardless of listing order (see BoundaryBinding.slots), so listing
 * order carries no meaning - canonicalizing prevents semantically identical
 * selections (checkbox click order) from producing document churn, and makes
 * "same selection" checkable by deep equality.
 *
 * Selection never touches member identity, stored values, or capacity
 * arithmetic - these commands only rewrite `binds.slots`, so undo simply
 * restores the previous selection and hidden state returns untouched.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { boundaryBindingKey, isNodeBoundaryBinding, type BoundaryBinding, type BoundaryItem, type GraphDef, type Json, type JsonObject, type NodeBoundaryBinding, type WorkflowDocument } from '../format/document.js'
import { asDynamicMemberId, asNodeId, asPortId, asRerouteId, isPortEndpoint, samePortRef, type PortRef } from '../ids.js'
import type { CommandDefinition, CommandExecutionContext, SharedReplayPreparation, TransactionBuilder } from './contract.js'
import { deriveBoundarySchema, familyStateAt, resolveBoundaryRoute } from '../schema/derive-boundary.js'
import type { InputSpec } from '../schema/model.js'
import { documentNodeResolver, documentResolver } from '../compile/compile.js'

const err = (code: string, message: string): Diagnostic => diag('error', 'command', code, message)

const isObj = (v: Json | undefined): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const SIDES = ['inputs', 'outputs'] as const
type Side = (typeof SIDES)[number]
const isSide = (v: Json | undefined): v is Side => v === 'inputs' || v === 'outputs'

function graphOf(doc: WorkflowDocument, graphId: Json | undefined): GraphDef | undefined {
  return typeof graphId === 'string' ? doc.graphs[graphId] : undefined
}

/**
 * Resolve a boundary item by its stable `id` (params never carry array
 * indices - the index is a storage detail resolved at patch time).
 */
function findItem(
  def: GraphDef,
  side: Side,
  itemId: string,
): { item: BoundaryItem; index: number } | undefined {
  const items = def.boundary?.[side]
  if (!items) return undefined
  const index = items.findIndex((b) => b.id === itemId)
  return index === -1 ? undefined : { item: items[index]!, index }
}

/**
 * A syntactically valid selection entry: nonempty dotted path with nonempty
 * segments. Splitting on '.' is the `slots` field's own grammar (template
 * slot ids never legally contain dots); no charset restriction beyond that,
 * since legacy-derived template ids may carry other characters (warn-only
 * at elaboration).
 */
const isValidEntry = (v: Json): v is string =>
  typeof v === 'string' && v.length > 0 && v.split('.').every((seg) => seg.length > 0)

/**
 * Dedupe + lexicographic sort. Exact duplicates are set-semantics idempotent
 * downstream, so dropping them here loses nothing.
 */
const canonicalize = (entries: readonly string[]): string[] =>
  [...new Set(entries)].sort()

/**
 * First prefix conflict in a CANONICAL (sorted) selection: an entry plus a
 * strict dotted extension of it ('sub' AND 'sub.s'). Whole-subtree and
 * narrowed selection of the same construct are mutually exclusive
 * (BoundaryBinding.slots). Sorting places a prefix immediately before its
 * extensions, so adjacent comparison suffices.
 */
function findPrefixConflict(sorted: readonly string[]): { prefix: string; extension: string } | undefined {
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    if (cur.startsWith(`${prev}.`)) return { prefix: prev, extension: cur }
  }
  return undefined
}

const sameSelection = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  a !== undefined && a.length === b.length && a.every((v, i) => v === b[i])

// ---------------------------------------------------------------------------
// boundary.setSlots {graphId, side, itemId, slots: string[]}
//
// Pins the boundary item's exposure to the listed template slot paths.
// Family bindings only; an empty list is rejected (boundary.clearSlots is
// the one canonical spelling for "whole template", hazard N2).
// ---------------------------------------------------------------------------

const boundarySetSlots: CommandDefinition = {
  id: 'boundary.setSlots',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.itemId !== 'string' ||
      !isSide(params.side) ||
      !Array.isArray(params.slots)
    )
      return [
        err(
          'params.invalid',
          "boundary.setSlots: params must be {graphId, side: 'inputs'|'outputs', itemId, slots: string[]}",
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def)
      return [err('graph.missing', `boundary.setSlots: unknown graph '${String(params.graphId)}'`)]
    if (params.slots.length === 0)
      return [
        err(
          'params.invalid',
          'boundary.setSlots: slots must be nonempty; use boundary.clearSlots to restore whole-template exposure',
        ),
      ]
    const invalid = params.slots.find((s) => !isValidEntry(s))
    if (invalid !== undefined)
      return [
        err(
          'params.invalid',
          `boundary.setSlots: '${String(invalid)}' is not a valid slot path (nonempty dotted segments)`,
        ),
      ]
    const found = findItem(def, params.side, params.itemId)
    if (!found)
      return [
        err(
          'boundary.itemMissing',
          `boundary.setSlots: no boundary ${params.side.slice(0, -1)} '${params.itemId}' in graph '${String(params.graphId)}'`,
        ),
      ]
    if (found.item.binds.kind !== 'family')
      return [
        err(
          'boundary.bindKind',
          `boundary.setSlots: boundary ${params.side.slice(0, -1)} '${params.itemId}' binds a '${found.item.binds.kind}'; slot selection applies to family forwarding only`,
        ),
      ]
    const slots = canonicalize(params.slots as string[])
    const conflict = findPrefixConflict(slots)
    if (conflict)
      return [
        err(
          'boundary.slotConflict',
          `boundary.setSlots: '${conflict.prefix}' selects a whole subtree but '${conflict.extension}' narrows beneath it; list one or the other`,
        ),
      ]
    if (sameSelection(found.item.binds.slots, slots)) return [] // no-op: identical selection
    tx.set(
      ['graphs', params.graphId as string, 'boundary', params.side, found.index, 'binds', 'slots'],
      slots,
    )
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.clearSlots {graphId, side, itemId}
//
// Removes the selection, restoring whole-template exposure so template slot
// changes track automatically. Works on any binding kind so it can also
// repair an invalid `slots` on a 'port' binding.
// ---------------------------------------------------------------------------

const boundaryClearSlots: CommandDefinition = {
  id: 'boundary.clearSlots',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.itemId !== 'string' || !isSide(params.side))
      return [
        err(
          'params.invalid',
          "boundary.clearSlots: params must be {graphId, side: 'inputs'|'outputs', itemId}",
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def)
      return [err('graph.missing', `boundary.clearSlots: unknown graph '${String(params.graphId)}'`)]
    const found = findItem(def, params.side, params.itemId)
    if (!found)
      return [
        err(
          'boundary.itemMissing',
          `boundary.clearSlots: no boundary ${params.side.slice(0, -1)} '${params.itemId}' in graph '${String(params.graphId)}'`,
        ),
      ]
    if (found.item.binds.kind === 'widgetTap' || found.item.binds.slots === undefined) return [] // no-op: already whole-template
    tx.remove([
      'graphs',
      params.graphId as string,
      'boundary',
      params.side,
      found.index,
      'binds',
      'slots',
    ])
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.addBinding {graphId, itemId, node, port, members?: string[]}
//
// Fan-out: appends an ADDITIONAL inner input target to a boundary INPUT
// item (BoundaryItem.alsoBinds). Input-side only - an output has exactly
// one source - and only on a 'port' primary (family forwarding cannot fan
// out). The new entry is always kind 'port' (one canonical spelling).
// Whether the target port exists and accepts the boundary type is
// derivation's job (boundary.unknownPort / boundary.fanoutTypeMismatch);
// this command validates document structure only.
// ---------------------------------------------------------------------------

const bindingTargetKey = (node: string, port: string, members: readonly string[] | undefined): string =>
  JSON.stringify([node, port, members ?? []])

const boundaryAddBinding: CommandDefinition = {
  id: 'boundary.addBinding',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.itemId !== 'string' ||
      typeof params.node !== 'string' ||
      typeof params.port !== 'string' ||
      (params.members !== undefined && !(Array.isArray(params.members) && params.members.every((m) => typeof m === 'string' && m.length > 0)))
    )
      return [
        err(
          'params.invalid',
          'boundary.addBinding: params must be {graphId, itemId, node, port, members?: string[]}',
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def)
      return [err('graph.missing', `boundary.addBinding: unknown graph '${String(params.graphId)}'`)]
    const found = findItem(def, 'inputs', params.itemId)
    if (!found)
      return [
        err(
          'boundary.itemMissing',
          `boundary.addBinding: no boundary input '${params.itemId}' in graph '${String(params.graphId)}' (fan-out is input-side only)`,
        ),
      ]
    if (found.item.binds.kind !== 'port')
      return [
        err(
          'boundary.bindKind',
          `boundary.addBinding: boundary input '${params.itemId}' forwards a family; family forwarding cannot fan out`,
        ),
      ]
    if (!def.nodes[params.node])
      return [err('node.missing', `boundary.addBinding: no node '${params.node}' in graph '${String(params.graphId)}'`)]
    const members = params.members as string[] | undefined
    const key = bindingTargetKey(params.node, params.port, members)
    const existing = (def.boundary?.inputs ?? []).flatMap((item) => [item.binds, ...(item.alsoBinds ?? [])])
    if (existing.some((b) => isNodeBoundaryBinding(b) && b.kind !== 'widgetTap' && bindingTargetKey(b.node, b.port, b.members) === key))
      return [
        err(
          'boundary.duplicateBind',
          `boundary.addBinding: inner input '${params.node}/${params.port}'${members ? ` member '${members.join('.')}'` : ''} is already bound by a boundary input`,
        ),
      ]
    const entry = bindingFromParams(params, 'inputs')
    if (entry?.kind !== 'port') return [err('params.invalid', 'boundary.addBinding: params must identify an input port binding')]
    tx.set(
      ['graphs', params.graphId as string, 'boundary', 'inputs', found.index, 'alsoBinds'],
      [...(found.item.alsoBinds ?? []), entry] as unknown as Json,
    )
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.removeBinding {graphId, itemId, node, port, members?: string[]}
//
// Removes one fan-out target from a boundary input's `alsoBinds`. The
// PRIMARY binding is not removable this way - re-point it or remove the
// item instead (the primary owns the derived type/widget, so removing it
// is an interface change, not a fan-out edit). Canonical form: when the
// last target goes, the `alsoBinds` key is dropped entirely (never `[]`).
// ---------------------------------------------------------------------------

const boundaryRemoveBinding: CommandDefinition = {
  id: 'boundary.removeBinding',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.itemId !== 'string' ||
      typeof params.node !== 'string' ||
      typeof params.port !== 'string' ||
      (params.members !== undefined && !(Array.isArray(params.members) && params.members.every((m) => typeof m === 'string' && m.length > 0)))
    )
      return [
        err(
          'params.invalid',
          'boundary.removeBinding: params must be {graphId, itemId, node, port, members?: string[]}',
        ),
      ]
    const def = graphOf(doc, params.graphId)
    if (!def)
      return [err('graph.missing', `boundary.removeBinding: unknown graph '${String(params.graphId)}'`)]
    const found = findItem(def, 'inputs', params.itemId)
    if (!found)
      return [
        err(
          'boundary.itemMissing',
          `boundary.removeBinding: no boundary input '${params.itemId}' in graph '${String(params.graphId)}'`,
        ),
      ]
    const members = params.members as string[] | undefined
    const key = bindingTargetKey(params.node, params.port, members)
    if (isNodeBoundaryBinding(found.item.binds) && found.item.binds.kind !== 'widgetTap' && bindingTargetKey(found.item.binds.node, found.item.binds.port, found.item.binds.members) === key)
      return [
        err(
          'boundary.primaryBind',
          `boundary.removeBinding: '${params.node}/${params.port}' is the PRIMARY binding of '${params.itemId}'; re-point it or remove the boundary item instead`,
        ),
      ]
    const also = found.item.alsoBinds ?? []
    const kept = also.filter((b) => !isNodeBoundaryBinding(b) || b.kind === 'widgetTap' || bindingTargetKey(b.node, b.port, b.members) !== key)
    if (kept.length === also.length)
      return [
        err(
          'boundary.bindMissing',
          `boundary.removeBinding: boundary input '${params.itemId}' has no fan-out target '${params.node}/${params.port}'${members ? ` member '${members.join('.')}'` : ''}`,
        ),
      ]
    if (kept.length === 0) {
      tx.remove(['graphs', params.graphId as string, 'boundary', 'inputs', found.index, 'alsoBinds'])
    } else {
      tx.set(
        ['graphs', params.graphId as string, 'boundary', 'inputs', found.index, 'alsoBinds'],
        kept as unknown as Json,
      )
    }
    return []
  },
}

const validMembers = (v: Json | undefined): boolean =>
  v === undefined || (Array.isArray(v) && v.every((m) => typeof m === 'string' && m.length > 0))

const bindingKey = (binding: BoundaryItem['binds']): string => boundaryBindingKey(binding)

const bindingMatchesEndpoint = (binding: BoundaryBinding, target: BoundaryBinding): boolean =>
  !isNodeBoundaryBinding(binding) || !isNodeBoundaryBinding(target) || binding.kind === 'widgetTap' || target.kind === 'widgetTap'
    ? bindingKey(binding) === bindingKey(target)
    : bindingTargetKey(binding.node, binding.port, binding.members) ===
      bindingTargetKey(target.node, target.port, target.members)

const bindingFromParams = (params: JsonObject, side: Side): NodeBoundaryBinding | undefined => {
  if (typeof params.node !== 'string') return undefined
  if (typeof params.tap === 'string' && params.tap.length > 0 && params.port === undefined && params.members === undefined) {
    return side === 'outputs' && params.viaReroute === undefined
      ? { kind: 'widgetTap', node: asNodeId(params.node), tap: asPortId(params.tap) } : undefined
  }
  if (typeof params.port !== 'string' || params.tap !== undefined || !validMembers(params.members)) return undefined
  const kind = params.bindingKind ?? 'port'
  if (kind !== 'port' && kind !== 'slot' && kind !== 'dynamicCombo') return undefined
  if (side !== 'inputs' && kind !== 'port') return undefined
  if (params.viaReroute !== undefined &&
      (side !== 'inputs' || kind !== 'port' || typeof params.viaReroute !== 'string' || params.viaReroute.length === 0)) return undefined
  const members = params.members as string[] | undefined
  return {
    kind,
    node: asNodeId(params.node),
    port: asPortId(params.port),
    ...(members !== undefined ? { members: members.map(asDynamicMemberId) } : {}),
    ...(typeof params.viaReroute === 'string' ? { viaReroute: asRerouteId(params.viaReroute) } : {}),
  }
}

/**
 * First-run schema facts an inputs-side exposure records in its params, so a
 * shared replay writes the same item without a schema: a dropdown that leads
 * options forwards as a 'dynamicCombo' subtree, and a field (a widget-backed
 * port reached directly, not through a junction) is promoted so the subgraph
 * node shows it as a field instead of a pin.
 */
const newBindingParams = (doc: WorkflowDocument, params: JsonObject, context: CommandExecutionContext): JsonObject => {
  if (params.side !== 'inputs' || context.kind !== 'initial') return params
  const binding = bindingFromParams(params, 'inputs')
  const graph = typeof params.graphId === 'string' ? doc.graphs[params.graphId] : undefined
  const node = binding && graph?.nodes[binding.node]
  const resolve = context.schemaResolverFor?.(doc)
  const schema = node && graph && resolve && documentNodeResolver(doc, resolve)(graph.id, node)
  const route = schema && binding && resolveBoundaryRoute(schema, binding, 'input')
  const slot = route?.ok && route.route.side === 'input' && route.route.terminal.kind === 'port' ? route.route.terminal.slot as InputSpec : undefined
  if (slot === undefined || params.viaReroute !== undefined) return params
  if (slot.dynamic?.kind === 'dynamicCombo')
    return params.bindingKind === undefined ? { ...params, bindingKind: 'dynamicCombo' } : params
  return (params.bindingKind ?? 'port') === 'port' && params.promoted === undefined && slot.widget !== undefined && slot.dynamic === undefined
    ? { ...params, promoted: true } : params
}

// ---------------------------------------------------------------------------
// boundary.addItem {graphId, side, node, port?, tap?, members?, itemId?, displayName?, promoted?}
//
// Appends one endpoint exposure. IDs are allocated deterministically from the
// target when omitted. Input targets are globally unique across primary and
// fan-out bindings; outputs may re-expose a source. Exposing the primary
// target of an input drawn without its wire draws the wire instead.
// ---------------------------------------------------------------------------

const boundaryAddItem: CommandDefinition = {
  id: 'boundary.addItem',
  prepareForSharedReplay(doc, params, context) {
    return isObj(params) ? { ok: true, params: newBindingParams(doc, params, context) } : undefined
  },
  run(doc, params, tx, context) {
    if (
      !isObj(params) || typeof params.graphId !== 'string' || !isSide(params.side) ||
      typeof params.node !== 'string' || bindingFromParams(params, params.side) === undefined ||
      (params.itemId !== undefined && (typeof params.itemId !== 'string' || params.itemId.length === 0)) ||
      (params.displayName !== undefined && typeof params.displayName !== 'string') ||
      (params.promoted !== undefined && (params.side !== 'inputs' || typeof params.promoted !== 'boolean'))
    ) return [err('params.invalid', "boundary.addItem: params must identify one port binding, or one outputs-side widget tap")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.addItem: unknown graph '${params.graphId}'`)]
    if (!def.nodes[params.node]) return [err('node.missing', `boundary.addItem: no node '${params.node}' in graph '${params.graphId}'`)]
    const items = def.boundary?.[params.side] ?? []
    const allItems = [...(def.boundary?.inputs ?? []), ...(def.boundary?.outputs ?? [])]
    if (params.itemId !== undefined && allItems.some((item) => item.id === params.itemId))
      return [err('boundary.duplicateId', `boundary.addItem: boundary item '${params.itemId}' already exists in graph '${params.graphId}'`)]
    const prepared = newBindingParams(doc, params, context)
    const binding = bindingFromParams(prepared, params.side)!
    const pinless = params.side === 'inputs'
      ? items.findIndex((item) => item.wireHidden === true && bindingMatchesEndpoint(item.binds, binding))
      : -1
    if (pinless !== -1) {
      tx.remove(['graphs', params.graphId, 'boundary', 'inputs', pinless, 'wireHidden'])
      return []
    }
    if (params.side === 'inputs' && items.some((item) =>
      [item.binds, ...(item.alsoBinds ?? [])].some((candidate) => bindingMatchesEndpoint(candidate, binding))))
      return [err('boundary.duplicateBind', `boundary.addItem: inner input '${params.node}/${params.port}' is already bound by another boundary input`)]
    appendItem(tx, def, params.side, binding, {
      ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}),
      ...(typeof params.displayName === 'string' && params.displayName.length > 0 ? { displayName: params.displayName } : {}),
      ...(prepared.promoted === true ? { promoted: true } : {}),
    })
    return []
  },
}

/**
 * Append one boundary item at the end of a side, allocating its id from the
 * target when none is given. Ids are allocated against BOTH sides: derivation
 * treats boundary item ids as one global namespace, so a generated input id
 * must not collide with an existing output id either.
 */
function appendItem(
  tx: TransactionBuilder,
  def: GraphDef,
  side: Side,
  binding: NodeBoundaryBinding,
  fields: { readonly itemId?: string; readonly displayName?: string; readonly promoted?: true; readonly wireHidden?: true },
): void {
  const items = def.boundary?.[side] ?? []
  const allItems = [...(def.boundary?.inputs ?? []), ...(def.boundary?.outputs ?? [])]
  let id = fields.itemId
  if (id === undefined) {
    const base = binding.kind === 'widgetTap'
      ? binding.tap
      : binding.members?.length ? `${binding.port}_${binding.members.join('_')}` : binding.port
    id = base
    for (let suffix = 2; allItems.some((item) => item.id === id); suffix++) id = `${base}_${suffix}`
  }
  const { itemId: _itemId, ...rest } = fields
  const item = { id, ...(rest.displayName !== undefined ? { displayName: rest.displayName } : {}), binds: binding,
    ...(rest.promoted ? { promoted: true } : {}), ...(rest.wireHidden ? { wireHidden: true } : {}) }
  if (!def.boundary) {
    tx.set(['graphs', def.id, 'boundary'], {
      inputs: side === 'inputs' ? [item] : [],
      outputs: side === 'outputs' ? [item] : [],
    } as unknown as Json)
  } else {
    tx.set(['graphs', def.id, 'boundary', side], [...items, item] as unknown as Json)
  }
}

/**
 * The boundary input that drives an inner field, and whether that input is
 * shown on the subgraph node as a field (a promoted 'port' binding or a
 * 'dynamicCombo' subtree). `driven` without `item` means something else
 * already delivers the input: a link, a named net, or a forwarded family or
 * construct that contains it.
 */
export function boundaryFieldState(
  def: GraphDef,
  target: PortRef,
): { readonly driven: boolean; readonly item?: BoundaryItem; readonly primary?: boolean; readonly field?: boolean } {
  const end: BoundaryBinding = { kind: 'port', node: target.node, port: target.port, ...(target.members?.length ? { members: target.members } : {}) }
  for (const item of def.boundary?.inputs ?? []) {
    const bindings = [item.binds, ...(item.alsoBinds ?? [])]
    const index = bindings.findIndex((binding) => isNodeBoundaryBinding(binding) && binding.kind !== 'family' && binding.kind !== 'slot' &&
      bindingMatchesEndpoint(binding, end))
    if (index !== -1) {
      const field = item.binds.kind === 'port' ? item.promoted === true : item.binds.kind === 'dynamicCombo'
      return { driven: true, item, primary: index === 0, field }
    }
    const forwards = bindings.some((binding) => (binding.kind === 'family' || binding.kind === 'slot' || binding.kind === 'dynamicCombo') &&
      binding.node === target.node && target.port.startsWith(`${binding.port}.`) &&
      (binding.members ?? []).every((member, i) => target.members?.[i] === member))
    if (forwards) return { driven: true }
  }
  const linked = Object.values(def.links).some((link) => isPortEndpoint(link.to) && samePortRef(link.to, target)) ||
    Object.values(def.nets).some((net) => net.sinks.some((sink) => samePortRef(sink, target)))
  return { driven: linked }
}

const showParamsInvalid = (): Diagnostic[] => [err('params.invalid', 'boundary.showOnSubgraphNode: params must be {graphId, node, port, members?: string[]}')]

/**
 * Validate a "Show on subgraph node" request. The first run also reads the
 * schema: the target must be a stored field the format can show on the
 * subgraph node, and the binding kind it needs is recorded in the params so
 * a shared replay writes the same row without a schema.
 */
function prepareShowParams(doc: WorkflowDocument, params: Json, context: CommandExecutionContext): SharedReplayPreparation {
  if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.node !== 'string' || typeof params.port !== 'string' ||
      !validMembers(params.members) || (params.bindingKind !== undefined && params.bindingKind !== 'port' && params.bindingKind !== 'dynamicCombo'))
    return { ok: false, diagnostics: showParamsInvalid() }
  const graphId = params.graphId
  const def = doc.graphs[graphId]
  if (!def) return { ok: false, diagnostics: [err('graph.missing', `boundary.showOnSubgraphNode: unknown graph '${graphId}'`)] }
  if (graphId === doc.root)
    return { ok: false, diagnostics: [err('boundary.topLevel', 'boundary.showOnSubgraphNode: the top-level workflow has no subgraph node')] }
  const node = def.nodes[params.node]
  if (!node) return { ok: false, diagnostics: [err('node.missing', `boundary.showOnSubgraphNode: no node '${params.node}' in graph '${graphId}'`)] }
  const members = params.members as string[] | undefined
  const target: PortRef = { node: asNodeId(params.node), port: asPortId(params.port), ...(members?.length ? { members: members.map(asDynamicMemberId) } : {}) }
  const state = boundaryFieldState(def, target)
  if (state.item !== undefined)
    return { ok: false, diagnostics: [err('boundary.duplicateBind', `boundary.showOnSubgraphNode: '${params.node}/${params.port}' is already bound by boundary input '${state.item.id}'`)] }
  if (state.driven)
    return { ok: false, diagnostics: [err('boundary.inputDriven', `boundary.showOnSubgraphNode: '${params.node}/${params.port}' already has a wire coming in`)] }
  const resolve = context.kind === 'initial' ? context.schemaResolverFor?.(doc) : undefined
  if (resolve === undefined) return { ok: true, params }
  const notField = (why: string): SharedReplayPreparation =>
    ({ ok: false, diagnostics: [err('boundary.notField', `boundary.showOnSubgraphNode: '${params.node}/${params.port}' ${why}`)] })
  const schema = documentNodeResolver(doc, resolve)(graphId, node)
  if (schema === undefined) return notField('has no known schema')
  const route = resolveBoundaryRoute(schema, { kind: 'port', ...target }, 'input')
  if (!route.ok || route.route.side !== 'input' || route.route.terminal.kind !== 'port') return notField('is not an input field')
  const missingMember = route.route.hops.some((hop, i) => hop.kind === 'member' &&
    familyStateAt(node, route.route.hops.slice(0, i), hop.familyPath)?.members?.includes(hop.member) !== true)
  if (missingMember) return notField('has no stored value yet')
  const slot = route.route.terminal.slot as InputSpec
  const combo = slot.dynamic?.kind === 'dynamicCombo'
  const bindingKind = (params.bindingKind ?? (combo ? 'dynamicCombo' : 'port')) as 'port' | 'dynamicCombo'
  if (!combo && (slot.widget === undefined || slot.dynamic !== undefined)) return notField('is not a field')
  // The format's own refusals (a forwarded construct, a selector, a slot
  // that is not connected inside) come from derivation: refuse when adding
  // the row brings an error the definition does not already have.
  const item: BoundaryItem = { id: 'show_on_subgraph_node', binds: { kind: bindingKind, ...target }, ...(bindingKind === 'port' ? { promoted: true } : {}) }
  const withItem: GraphDef = { ...def, boundary: { inputs: [...(def.boundary?.inputs ?? []), item], outputs: def.boundary?.outputs ?? [] } }
  const schemas = documentResolver(doc, resolve)
  const resolveNode = (inner: typeof node) => documentNodeResolver(doc, resolve)(graphId, inner)
  const errorsOf = (graph: GraphDef): Set<string> => new Set(
    deriveBoundarySchema(graph, schemas, undefined, resolveNode).diagnostics.filter((d) => d.severity === 'error').map((d) => JSON.stringify([d.code, d.message])))
  const before = def.boundary === undefined ? new Set<string>() : errorsOf(def)
  const added = [...errorsOf(withItem)].filter((key) => !before.has(key))
  if (added.length > 0) {
    const [code, message] = JSON.parse(added[0]!) as [string, string]
    return { ok: false, diagnostics: [err(code, `boundary.showOnSubgraphNode: ${message}`)] }
  }
  return { ok: true, params: { ...params, bindingKind } }
}

// ---------------------------------------------------------------------------
// boundary.showOnSubgraphNode {graphId, node, port, members?}
//
// Puts an inner field on the subgraph node without drawing a wire: appends an
// input bound to the field (promoted, or the 'dynamicCombo' subtree for a
// dropdown that leads options) marked wireHidden, in one undo step.
// ---------------------------------------------------------------------------

const boundaryShowOnSubgraphNode: CommandDefinition = {
  id: 'boundary.showOnSubgraphNode',
  prepareForSharedReplay(doc, params, context) {
    return prepareShowParams(doc, params, context)
  },
  run(doc, params, tx, context) {
    const prepared = prepareShowParams(doc, params, context)
    if (!prepared.ok) return [...prepared.diagnostics]
    const p = prepared.params as JsonObject
    const def = doc.graphs[p.graphId as string]!
    const kind = p.bindingKind === 'dynamicCombo' ? 'dynamicCombo' : 'port'
    const members = p.members as string[] | undefined
    appendItem(tx, def, 'inputs', {
      kind,
      node: asNodeId(p.node as string),
      port: asPortId(p.port as string),
      ...(members?.length ? { members: members.map(asDynamicMemberId) } : {}),
    }, { ...(kind === 'port' ? { promoted: true } : {}), wireHidden: true })
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.setWireHidden {graphId, itemId, hidden}
//
// Draws or hides the wire of a boundary input shown on the subgraph node as a
// field. The row keeps its id, so every subgraph node keeps its value.
// ---------------------------------------------------------------------------

const boundarySetWireHidden: CommandDefinition = {
  id: 'boundary.setWireHidden',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.itemId !== 'string' || typeof params.hidden !== 'boolean')
      return [err('params.invalid', 'boundary.setWireHidden: params must be {graphId, itemId, hidden: boolean}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.setWireHidden: unknown graph '${params.graphId}'`)]
    const found = findItem(def, 'inputs', params.itemId)
    if (!found) return [err('boundary.itemMissing', `boundary.setWireHidden: no boundary input '${params.itemId}' in graph '${params.graphId}'`)]
    const field = found.item.binds.kind === 'port' ? found.item.promoted === true : found.item.binds.kind === 'dynamicCombo'
    if (!field) return [err('boundary.notField', `boundary.setWireHidden: boundary input '${params.itemId}' is not shown as a field on the subgraph node`)]
    const path = ['graphs', params.graphId, 'boundary', 'inputs', found.index, 'wireHidden']
    if (params.hidden === (found.item.wireHidden === true)) return []
    if (params.hidden) tx.set(path, true)
    else tx.remove(path)
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.renameItem {graphId, side, itemId, displayName}
//
// Sets the presentation label. The empty string canonically clears it.
// ---------------------------------------------------------------------------

const boundaryRenameItem: CommandDefinition = {
  id: 'boundary.renameItem',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !isSide(params.side) || typeof params.itemId !== 'string' || typeof params.displayName !== 'string')
      return [err('params.invalid', "boundary.renameItem: params must be {graphId, side: 'inputs'|'outputs', itemId, displayName: string}")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.renameItem: unknown graph '${params.graphId}'`)]
    const found = findItem(def, params.side, params.itemId)
    if (!found) return [err('boundary.itemMissing', `boundary.renameItem: no boundary ${params.side.slice(0, -1)} '${params.itemId}' in graph '${params.graphId}'`)]
    if (params.displayName === '') {
      if (found.item.displayName === undefined) return []
      tx.remove(['graphs', params.graphId, 'boundary', params.side, found.index, 'displayName'])
    } else {
      if (found.item.displayName === params.displayName) return []
      tx.set(['graphs', params.graphId, 'boundary', params.side, found.index, 'displayName'], params.displayName)
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.setBinding {graphId, side, itemId, node, port, members?}
//
// Re-points an item's primary binding to a concrete port, dropping slots.
// ---------------------------------------------------------------------------

const boundarySetBinding: CommandDefinition = {
  id: 'boundary.setBinding',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !isSide(params.side) || typeof params.itemId !== 'string' || bindingFromParams(params, params.side) === undefined)
      return [err('params.invalid', "boundary.setBinding: params must identify one port binding, or one outputs-side widget tap")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.setBinding: unknown graph '${params.graphId}'`)]
    const found = findItem(def, params.side, params.itemId)
    if (!found) return [err('boundary.itemMissing', `boundary.setBinding: no boundary ${params.side.slice(0, -1)} '${params.itemId}' in graph '${params.graphId}'`)]
    const binding = bindingFromParams(params, params.side)!
    if (!def.nodes[binding.node]) return [err('node.missing', `boundary.setBinding: no node '${binding.node}' in graph '${params.graphId}'`)]
    if (params.side === 'inputs' && (def.boundary?.inputs ?? []).some((item, index) => {
      const bindings = index === found.index ? (item.alsoBinds ?? []) : [item.binds, ...(item.alsoBinds ?? [])]
      return bindings.some((candidate) => bindingMatchesEndpoint(candidate, binding))
    })) return [err('boundary.duplicateBind', `boundary.setBinding: inner input '${params.node}/${params.port}' is already bound by a boundary input`)]
    const current = found.item.binds
    if (bindingKey(current) === bindingKey(binding)) return []
    tx.set(['graphs', params.graphId, 'boundary', params.side, found.index, 'binds'], binding as unknown as Json)
    // A row that stops being a field on the subgraph node draws its wire again.
    const stillField = binding.kind === 'dynamicCombo' || (binding.kind === 'port' && found.item.promoted === true)
    if (found.item.wireHidden === true && !stillField)
      tx.remove(['graphs', params.graphId, 'boundary', params.side, found.index, 'wireHidden'])
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.unbind {graphId, side, itemId, node, port, members?}
//
// Disconnects one boundary noodle, promoting input fan-out in stable order.
// ---------------------------------------------------------------------------

const boundaryUnbind: CommandDefinition = {
  id: 'boundary.unbind',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !isSide(params.side) || typeof params.itemId !== 'string' || bindingFromParams(params, params.side) === undefined)
      return [err('params.invalid', "boundary.unbind: params must identify one port binding, or one outputs-side widget tap")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.unbind: unknown graph '${params.graphId}'`)]
    const found = findItem(def, params.side, params.itemId)
    if (!found) return [err('boundary.itemMissing', `boundary.unbind: no boundary ${params.side.slice(0, -1)} '${params.itemId}' in graph '${params.graphId}'`)]
    const target = bindingFromParams(params, params.side)!
    const path = ['graphs', params.graphId, 'boundary', params.side] as const
    const items = def.boundary![params.side]
    if (params.side === 'outputs') {
      if (!bindingMatchesEndpoint(found.item.binds, target)) return [err('boundary.bindMissing', `boundary.unbind: boundary output '${params.itemId}' does not bind '${params.node}/${params.port}'`)]
      tx.set(path, items.filter((_, index) => index !== found.index) as unknown as Json)
      return []
    }
    const also = found.item.alsoBinds ?? []
    const alsoIndex = also.findIndex((binding) => bindingMatchesEndpoint(binding, target))
    if (alsoIndex !== -1) {
      const kept = also.filter((_, index) => index !== alsoIndex)
      if (kept.length) tx.set([...path, found.index, 'alsoBinds'], kept as unknown as Json)
      else tx.remove([...path, found.index, 'alsoBinds'])
      return []
    }
    if (!bindingMatchesEndpoint(found.item.binds, target)) return [err('boundary.bindMissing', `boundary.unbind: boundary input '${params.itemId}' does not bind '${params.node}/${params.port}'`)]
    if (also.length === 0) tx.set(path, items.filter((_, index) => index !== found.index) as unknown as Json)
    else {
      tx.set([...path, found.index, 'binds'], also[0] as unknown as Json)
      if (also.length === 1) tx.remove([...path, found.index, 'alsoBinds'])
      else tx.set([...path, found.index, 'alsoBinds'], also.slice(1) as unknown as Json)
    }
    return []
  },
}

export const BOUNDARY_COMMANDS: readonly CommandDefinition[] = [
  boundarySetSlots,
  boundaryClearSlots,
  boundaryAddBinding,
  boundaryRemoveBinding,
  boundaryAddItem,
  boundaryShowOnSubgraphNode,
  boundarySetWireHidden,
  boundaryRenameItem,
  boundarySetBinding,
  boundaryUnbind,
]
