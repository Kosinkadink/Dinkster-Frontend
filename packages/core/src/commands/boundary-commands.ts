/**
 * Boundary-editing commands: the write path for a subgraph definition's
 * boundary items - exposures, bindings and input fan-out (`alsoBinds`).
 *
 * Like every core command these are SCHEMA-BLIND and deterministic: they
 * validate structure (item exists, binding kind, unique targets) and write
 * exactly what the params describe. Whether a bound port exists and accepts
 * the boundary type is derivation's job (deriveBoundarySchema), so an editor
 * surfaces those problems inline without commands needing a schema resolver
 * (which would break command determinism/serializability).
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { boundaryBindingKey, isNodeBoundaryBinding, type BoundaryBinding, type BoundaryItem, type GraphDef, type Json, type JsonObject, type NodeBoundaryBinding, type WorkflowDocument } from '../format/document.js'
import { asNodeId, asPortId, asRerouteId, isPortEndpoint, samePortRef, type PortRef } from '../ids.js'
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

// ---------------------------------------------------------------------------
// boundary.addBinding {graphId, itemId, node, port}
//
// Fan-out: appends an ADDITIONAL inner input target to a boundary INPUT
// item (BoundaryItem.alsoBinds). Input-side only - an output has exactly
// one source - and only on a 'port' primary. The new entry is always kind
// 'port' (one canonical spelling).
// Whether the target port exists and accepts the boundary type is
// derivation's job (boundary.unknownPort / boundary.fanoutTypeMismatch);
// this command validates document structure only.
// ---------------------------------------------------------------------------

const bindingTargetKey = (node: string, port: string): string => JSON.stringify([node, port])

const boundaryAddBinding: CommandDefinition = {
  id: 'boundary.addBinding',
  run(doc, params, tx) {
    if (
      !isObj(params) ||
      typeof params.itemId !== 'string' ||
      typeof params.node !== 'string' ||
      typeof params.port !== 'string'
    )
      return [
        err(
          'params.invalid',
          'boundary.addBinding: params must be {graphId, itemId, node, port}',
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
          `boundary.addBinding: boundary input '${params.itemId}' binds a '${found.item.binds.kind}'; only a port binding can fan out`,
        ),
      ]
    if (!def.nodes[params.node])
      return [err('node.missing', `boundary.addBinding: no node '${params.node}' in graph '${String(params.graphId)}'`)]
    const key = bindingTargetKey(params.node, params.port)
    const existing = (def.boundary?.inputs ?? []).flatMap((item) => [item.binds, ...(item.alsoBinds ?? [])])
    if (existing.some((b) => isNodeBoundaryBinding(b) && b.kind !== 'widgetTap' && bindingTargetKey(b.node, b.port) === key))
      return [
        err(
          'boundary.duplicateBind',
          `boundary.addBinding: inner input '${params.node}/${params.port}' is already bound by a boundary input`,
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
// boundary.removeBinding {graphId, itemId, node, port}
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
      typeof params.port !== 'string'
    )
      return [
        err(
          'params.invalid',
          'boundary.removeBinding: params must be {graphId, itemId, node, port}',
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
    const key = bindingTargetKey(params.node, params.port)
    if (isNodeBoundaryBinding(found.item.binds) && found.item.binds.kind !== 'widgetTap' && bindingTargetKey(found.item.binds.node, found.item.binds.port) === key)
      return [
        err(
          'boundary.primaryBind',
          `boundary.removeBinding: '${params.node}/${params.port}' is the PRIMARY binding of '${params.itemId}'; re-point it or remove the boundary item instead`,
        ),
      ]
    const also = found.item.alsoBinds ?? []
    const kept = also.filter((b) => !isNodeBoundaryBinding(b) || b.kind === 'widgetTap' || bindingTargetKey(b.node, b.port) !== key)
    if (kept.length === also.length)
      return [
        err(
          'boundary.bindMissing',
          `boundary.removeBinding: boundary input '${params.itemId}' has no fan-out target '${params.node}/${params.port}'`,
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

const bindingKey = (binding: BoundaryItem['binds']): string => boundaryBindingKey(binding)

const bindingMatchesEndpoint = (binding: BoundaryBinding, target: BoundaryBinding): boolean =>
  !isNodeBoundaryBinding(binding) || !isNodeBoundaryBinding(target) || binding.kind === 'widgetTap' || target.kind === 'widgetTap'
    ? bindingKey(binding) === bindingKey(target)
    : bindingTargetKey(binding.node, binding.port) === bindingTargetKey(target.node, target.port)

const bindingFromParams = (params: JsonObject, side: Side): NodeBoundaryBinding | undefined => {
  if (typeof params.node !== 'string') return undefined
  if (typeof params.tap === 'string' && params.tap.length > 0 && params.port === undefined) {
    return side === 'outputs' && params.viaReroute === undefined
      ? { kind: 'widgetTap', node: asNodeId(params.node), tap: asPortId(params.tap) } : undefined
  }
  if (typeof params.port !== 'string' || params.tap !== undefined) return undefined
  if (params.viaReroute !== undefined &&
      (side !== 'inputs' || typeof params.viaReroute !== 'string' || params.viaReroute.length === 0)) return undefined
  return {
    kind: 'port',
    node: asNodeId(params.node),
    port: asPortId(params.port),
    ...(typeof params.viaReroute === 'string' ? { viaReroute: asRerouteId(params.viaReroute) } : {}),
  }
}

/**
 * First-run schema facts an inputs-side exposure records in its params, so a
 * shared replay writes the same item without a schema: a field (a
 * widget-backed port reached directly, not through a junction) is promoted so
 * the subgraph node shows it as a field instead of a pin.
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
  return params.promoted === undefined && slot.widget !== undefined ? { ...params, promoted: true } : params
}

// ---------------------------------------------------------------------------
// boundary.addItem {graphId, side, node, port?, tap?, itemId?, displayName?, promoted?}
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
    const base = binding.kind === 'widgetTap' ? binding.tap : binding.port
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
 * shown on the subgraph node as a field (a promoted 'port' binding).
 * `driven` without `item` means something else already delivers the input:
 * a link or a named net.
 */
export function boundaryFieldState(
  def: GraphDef,
  target: PortRef,
): { readonly driven: boolean; readonly item?: BoundaryItem; readonly primary?: boolean; readonly field?: boolean } {
  const end: BoundaryBinding = { kind: 'port', node: target.node, port: target.port }
  for (const item of def.boundary?.inputs ?? []) {
    const index = [item.binds, ...(item.alsoBinds ?? [])].findIndex((binding) => bindingMatchesEndpoint(binding, end))
    if (index !== -1) return { driven: true, item, primary: index === 0, field: item.binds.kind === 'port' && item.promoted === true }
  }
  const linked = Object.values(def.links).some((link) => isPortEndpoint(link.to) && samePortRef(link.to, target)) ||
    Object.values(def.nets).some((net) => net.sinks.some((sink) => samePortRef(sink, target)))
  return { driven: linked }
}

const showParamsInvalid = (): Diagnostic[] => [err('params.invalid', 'boundary.showOnSubgraphNode: params must be {graphId, node, port}')]

/**
 * Validate a "Show on subgraph node" request. The first run also reads the
 * schema: the target must be a stored field the format can show on the
 * subgraph node. A shared replay writes the same row without a schema.
 */
function prepareShowParams(doc: WorkflowDocument, params: Json, context: CommandExecutionContext): SharedReplayPreparation {
  if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.node !== 'string' || typeof params.port !== 'string')
    return { ok: false, diagnostics: showParamsInvalid() }
  const graphId = params.graphId
  const def = doc.graphs[graphId]
  if (!def) return { ok: false, diagnostics: [err('graph.missing', `boundary.showOnSubgraphNode: unknown graph '${graphId}'`)] }
  if (graphId === doc.root)
    return { ok: false, diagnostics: [err('boundary.topLevel', 'boundary.showOnSubgraphNode: the top-level workflow has no subgraph node')] }
  const node = def.nodes[params.node]
  if (!node) return { ok: false, diagnostics: [err('node.missing', `boundary.showOnSubgraphNode: no node '${params.node}' in graph '${graphId}'`)] }
  const target: PortRef = { node: asNodeId(params.node), port: asPortId(params.port) }
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
  if ((route.route.terminal.slot as InputSpec).widget === undefined) return notField('is not a field')
  // The format's own refusals (a selector, a row of an option that is not
  // chosen) come from derivation: refuse when adding the row brings an error
  // the definition does not already have.
  const item: BoundaryItem = { id: 'show_on_subgraph_node', binds: { kind: 'port', ...target }, promoted: true }
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
  return { ok: true, params }
}

// ---------------------------------------------------------------------------
// boundary.showOnSubgraphNode {graphId, node, port}
//
// Puts an inner field on the subgraph node without drawing a wire: appends a
// promoted input bound to the field, marked wireHidden, in one undo step.
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
    appendItem(tx, def, 'inputs', { kind: 'port', node: asNodeId(p.node as string), port: asPortId(p.port as string) },
      { promoted: true, wireHidden: true })
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
    if (found.item.binds.kind !== 'port' || found.item.promoted !== true) return [err('boundary.notField', `boundary.setWireHidden: boundary input '${params.itemId}' is not shown as a field on the subgraph node`)]
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
// boundary.setBinding {graphId, side, itemId, node, port}
//
// Re-points an item's primary binding to a concrete port.
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
    const stillField = binding.kind === 'port' && found.item.promoted === true
    if (found.item.wireHidden === true && !stillField)
      tx.remove(['graphs', params.graphId, 'boundary', params.side, found.index, 'wireHidden'])
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.unbind {graphId, side, itemId, node, port}
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
  boundaryAddBinding,
  boundaryRemoveBinding,
  boundaryAddItem,
  boundaryShowOnSubgraphNode,
  boundarySetWireHidden,
  boundaryRenameItem,
  boundarySetBinding,
  boundaryUnbind,
]
