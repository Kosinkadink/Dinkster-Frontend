/**
 * Boundary-editing commands: the write path for a subgraph definition's
 * boundary items - exposures, bindings and input fan-out (`alsoBinds`).
 *
 * Writes are deterministic and validate document structure. Initial dispatch
 * also checks schema-dependent ownership and construct compatibility; shared
 * replay writes the accepted parameters without re-reading a live schema.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { validateGraphDefShape } from '../format/validate.js'
import { canonicalJson } from '../compile/hash.js'
import { boundaryBindingKey, boundaryButtons, boundaryItems, boundaryItemsWithPaths, isNodeBoundaryBinding, withBoundaryItems, type Boundary, type BoundaryBinding, type BoundaryEntry, type BoundaryInputEntry, type BoundaryItem, type GraphDef, type Json, type JsonObject, type NodeBoundaryBinding, type WorkflowDocument } from '../format/document.js'
import { buttonWriteFields } from '../actions/steps.js'
import { asNodeId, asPortId, asRerouteId, isPortEndpoint, samePortRef, type PortRef } from '../ids.js'
import { Formula, FormulaRefused } from '../mirror/formula.js'
import type { CommandDefinition, CommandExecutionContext, SharedReplayPreparation, TransactionBuilder } from './contract.js'
import { createTransactionBuilder } from './contract.js'
import { boundaryConditionScope, boundaryInnerInput, constructsAround, deriveBoundarySchema, familyStateAt, numberFieldRange, resolveBoundaryRoute } from '../schema/derive-boundary.js'
import type { InputSpec } from '../schema/model.js'
import { documentNodeResolver, documentResolver } from '../compile/compile.js'
import { schemaResolverForCommand } from './command-support.js'
import { elaborateInterface } from '../schema/elaborate.js'

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
): { item: BoundaryItem; index: number; path: (string | number)[] } | undefined {
  const items = boundaryItemsWithPaths(def.boundary, side)
  const index = items.findIndex(({ item }) => item.id === itemId)
  if (index === -1) return undefined
  return { item: items[index]!.item, index, path: ['graphs', def.id, 'boundary', ...items[index]!.path] }
}

// ---------------------------------------------------------------------------
// boundary.addBinding {graphId, itemId, node, port}
//
// Fan-out: appends an ADDITIONAL inner input target to a boundary INPUT
// item (BoundaryItem.alsoBinds). Input-side only - an output has exactly
// one source. Every target has the primary's kind; constructs must have
// matching rows, keys, options and growth.
// Dispatch checks construct compatibility with derivation. Port type
// mismatches remain advisory derivation diagnostics.
// ---------------------------------------------------------------------------

const bindingTargetKey = (node: string, port: string): string => JSON.stringify([node, port])

const boundaryAddBinding: CommandDefinition = {
  id: 'boundary.addBinding',
  validateDispatch(doc, params, context) {
    if (!isObj(params) || typeof params.itemId !== 'string') return []
    const def = graphOf(doc, params.graphId)
    const found = def && findItem(def, 'inputs', params.itemId)
    if (!def || found?.item.binds.kind !== 'construct') return []
    const binding = bindingFromParams({ ...params, kind: 'construct' }, 'inputs')
    const resolve = schemaResolverForCommand(doc, context)
    if (binding === undefined || resolve === undefined) return []
    const withTarget = { ...def, boundary: withBoundaryItems(def.boundary, 'inputs', boundaryItems(def.boundary, 'inputs').map((item) =>
      item.id === params.itemId ? { ...item, alsoBinds: [...(item.alsoBinds ?? []), binding] } : item)) }
    const resolveNode = (node: typeof def.nodes[string]) => documentNodeResolver(doc, resolve)(def.id, node)
    const errorsOf = (graph: GraphDef) => deriveBoundarySchema(graph, documentResolver(doc, resolve), undefined, resolveNode).diagnostics
      .filter((d) => d.severity === 'error')
    const before = new Set(errorsOf(def).map((d) => JSON.stringify([d.code, d.message])))
    const errors = errorsOf(withTarget).filter((d) => !before.has(JSON.stringify([d.code, d.message])))
    if (errors.length > 0) return errors
    // A new target can narrow a group's capacity on every containing boundary.
    // Check stored members there too, before changing any definition or instance.
    const capacityErrors = (document: WorkflowDocument): Diagnostic[] => {
      const nodeSchema = documentNodeResolver(document, resolve)
      const definitionSchema = documentResolver(document, resolve)
      return Object.values(document.graphs).flatMap((graph) => [
        ...(graph.boundary === undefined ? [] : deriveBoundarySchema(graph, definitionSchema, undefined,
          (node) => nodeSchema(graph.id, node)).diagnostics.filter((d) => d.code === 'boundary.familyOverCap')),
        ...Object.values(graph.nodes).flatMap((node) => {
          if (!node.type.startsWith('#')) return []
          const schema = nodeSchema(graph.id, node)
          if (schema === undefined) return []
          return elaborateInterface(schema, node).diagnostics.filter((d) =>
            d.code === 'elab.autogrow.overMax' || d.code === 'elab.autogrow.badMember')
            .map((d) => ({ ...d, refs: [{ graphId: graph.id, nodeId: node.id }] }))
        }),
      ])
    }
    const existing = new Set(capacityErrors(doc).map((d) => JSON.stringify(d)))
    return capacityErrors({ ...doc, graphs: { ...doc.graphs, [def.id]: withTarget } }).filter((d) => !existing.has(JSON.stringify(d)))
  },
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
    if (found.item.binds.kind !== 'port' && found.item.binds.kind !== 'construct')
      return [
        err(
          'boundary.bindKind',
          `boundary.addBinding: boundary input '${params.itemId}' binds a '${found.item.binds.kind}'; only a port or construct binding can fan out`,
        ),
      ]
    if (!def.nodes[params.node])
      return [err('node.missing', `boundary.addBinding: no node '${params.node}' in graph '${String(params.graphId)}'`)]
    const key = bindingTargetKey(params.node, params.port)
    const existing = boundaryItems(def.boundary, 'inputs').flatMap((item) => [item.binds, ...(item.alsoBinds ?? [])])
    if (existing.some((b) => isNodeBoundaryBinding(b) && b.kind !== 'widgetTap' && bindingTargetKey(b.node, b.port) === key))
      return [
        err(
          'boundary.duplicateBind',
          `boundary.addBinding: inner input '${params.node}/${params.port}' is already bound by a boundary input`,
        ),
      ]
    const entry = bindingFromParams({ ...params, kind: found.item.binds.kind }, 'inputs')
    if (entry === undefined) return [err('params.invalid', 'boundary.addBinding: params must identify an input binding')]
    const conflict = itemConflict('boundary.addBinding', def, entry)
    if (conflict !== undefined) return [conflict]
    tx.set(
      [...found.path, 'alsoBinds'],
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
      tx.remove([...found.path, 'alsoBinds'])
    } else {
      tx.set(
        [...found.path, 'alsoBinds'],
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
  if (params.kind !== undefined && params.kind !== 'port' && params.kind !== 'construct' && params.kind !== 'widgetTap') return undefined
  if (params.kind === 'construct') {
    return typeof params.port === 'string' && params.tap === undefined && params.viaReroute === undefined
      ? { kind: 'construct', node: asNodeId(params.node), port: asPortId(params.port) } : undefined
  }
  if (typeof params.tap === 'string' && params.tap.length > 0 && params.port === undefined) {
    return side === 'outputs' && params.kind !== 'port' && params.viaReroute === undefined
      ? { kind: 'widgetTap', node: asNodeId(params.node), tap: asPortId(params.tap) } : undefined
  }
  if (typeof params.port !== 'string' || params.tap !== undefined || params.kind === 'widgetTap') return undefined
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
// target of an input drawn without its wire draws the wire instead. A row
// inside a construct shown whole is refused: the construct owns it.
// ---------------------------------------------------------------------------

/** The item that already shows `binding`'s row through a construct, or a row inside it. */
function ownershipConflict(def: GraphDef, binding: NodeBoundaryBinding): BoundaryItem | undefined {
  if (binding.kind === 'widgetTap') return undefined
  const items = [...boundaryItems(def.boundary, 'inputs'), ...(boundaryItems(def.boundary, 'outputs') ?? [])]
  return items.find((item) => [item.binds, ...(item.alsoBinds ?? [])].some((other) => {
    if ((other.kind !== 'port' && other.kind !== 'construct') || other.node !== binding.node) return false
    if (other.kind === 'construct' && (binding.port === other.port || binding.port.startsWith(`${other.port}.`))) return true
    return binding.kind === 'construct' && (other.port === binding.port || other.port.startsWith(`${binding.port}.`))
  }))
}

/**
 * The refusal for a new item id or binding: an id taken, or under a
 * construct item's id (an address under it names a row inside the
 * construct), or a row a construct shown whole already owns.
 */
function itemConflict(command: string, def: GraphDef, binding: NodeBoundaryBinding, itemId?: string): Diagnostic | undefined {
  if (itemId !== undefined && idTaken(def, binding, itemId))
    return err('boundary.duplicateId', `${command}: boundary item '${itemId}' already exists in graph '${def.id}'`)
  const owner = ownershipConflict(def, binding)
  return owner === undefined ? undefined
    : err('boundary.constructOwned', `${command}: '${binding.kind === 'widgetTap' ? binding.tap : binding.port}' is already shown through '${owner.id}'`)
}

function idTaken(def: GraphDef, binding: NodeBoundaryBinding, id: string): boolean {
  return [...boundaryItems(def.boundary, 'inputs'), ...(boundaryItems(def.boundary, 'outputs') ?? [])].some((item) => item.id === id ||
    (binding.kind === 'construct' && item.id.startsWith(`${id}.`)) ||
    (item.binds.kind === 'construct' && id.startsWith(`${item.id}.`)))
}

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
    const items = boundaryItems(def.boundary, params.side)
    const prepared = newBindingParams(doc, params, context)
    const binding = bindingFromParams(prepared, params.side)!
    const conflict = itemConflict('boundary.addItem', def, binding, params.itemId as string | undefined)
    if (conflict !== undefined) return [conflict]
    const pinless = params.side === 'inputs'
      ? items.findIndex((item) => item.wireHidden === true && bindingMatchesEndpoint(item.binds, binding))
      : -1
    if (pinless !== -1) {
      tx.remove(['graphs', params.graphId, 'boundary', ...boundaryItemsWithPaths(def.boundary, 'inputs')[pinless]!.path, 'wireHidden'])
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
  const items = boundaryItems(def.boundary, side)
  let id = fields.itemId
  if (id === undefined) {
    const base = binding.kind === 'widgetTap' ? binding.tap : binding.port
    id = base
    for (let suffix = 2; idTaken(def, binding, id); suffix++) id = `${base}_${suffix}`
  }
  const { itemId: _itemId, ...rest } = fields
  const item = { id, ...(rest.displayName !== undefined ? { displayName: rest.displayName } : {}), binds: binding,
    ...(rest.promoted ? { promoted: true } : {}), ...(rest.wireHidden ? { wireHidden: true as const } : {}) }
  tx.set(['graphs', def.id, 'boundary'], withBoundaryItems(def.boundary, side, [...items, item]) as unknown as Json)
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
  for (const item of boundaryItems(def.boundary, 'inputs') ?? []) {
    const index = [item.binds, ...(item.alsoBinds ?? [])].findIndex((binding) => bindingMatchesEndpoint(binding, end))
    if (index !== -1) return { driven: true, item, primary: index === 0, field: item.binds.kind === 'port' && item.promoted === true }
  }
  const linked = Object.values(def.links).some((link) => isPortEndpoint(link.to) && samePortRef(link.to, target)) ||
    Object.values(def.nets).some((net) => net.sinks.some((sink) => samePortRef(sink, target)))
  return { driven: linked }
}

const showParamsInvalid = (): Diagnostic[] => [err('params.invalid', "boundary.showOnSubgraphNode: params must be {graphId, node, port, side?: 'inputs'|'outputs'}")]

/**
 * Validate a "Show on subgraph node" request. The first run also reads the
 * schema: the target must be a group, choice, type choice or described row,
 * or a stored field the format can show on the subgraph node. A shared
 * replay writes the same row without a schema.
 */
function prepareShowParams(doc: WorkflowDocument, params: Json, context: CommandExecutionContext): SharedReplayPreparation {
  if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.node !== 'string' || typeof params.port !== 'string' ||
      (params.side !== undefined && !isSide(params.side)))
    return { ok: false, diagnostics: showParamsInvalid() }
  const graphId = params.graphId
  const def = doc.graphs[graphId]
  if (!def) return { ok: false, diagnostics: [err('graph.missing', `boundary.showOnSubgraphNode: unknown graph '${graphId}'`)] }
  if (graphId === doc.root)
    return { ok: false, diagnostics: [err('boundary.topLevel', 'boundary.showOnSubgraphNode: the top-level workflow has no subgraph node')] }
  const node = def.nodes[params.node]
  if (!node) return { ok: false, diagnostics: [err('node.missing', `boundary.showOnSubgraphNode: no node '${params.node}' in graph '${graphId}'`)] }
  // A construct: the first run records its side, which a shared replay reads.
  if (params.side !== undefined) return { ok: true, params }
  const resolveConstruct = context.kind === 'initial' ? context.schemaResolverFor?.(doc) : undefined
  const schemaOfNode = resolveConstruct === undefined ? undefined : documentNodeResolver(doc, resolveConstruct)(graphId, node)
  const construct = schemaOfNode === undefined ? undefined : constructsAround(schemaOfNode, params.port).find((entry) => entry.path === params.port)
  if (construct !== undefined) return { ok: true, params: { ...params, side: construct.side } }
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
  const withItem: GraphDef = { ...def, boundary: withBoundaryItems(def.boundary, 'inputs', [...boundaryItems(def.boundary, 'inputs'), item]) }
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
// boundary.showOnSubgraphNode {graphId, node, port, side?}
//
// Puts an inner field on the subgraph node without drawing a wire: appends a
// promoted input bound to the field, marked wireHidden, in one undo step.
// At a group, choice, type choice or described row it shows the construct
// whole instead; the first run records the construct's side, so a shared
// replay writes the same item without a schema.
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
    const node = asNodeId(p.node as string)
    const port = asPortId(p.port as string)
    // A group, choice, type choice or described row is shown whole: each
    // subgraph node then owns its members, pick and values under the item.
    const binding: NodeBoundaryBinding = isSide(p.side) ? { kind: 'construct', node, port } : { kind: 'port', node, port }
    const conflict = itemConflict('boundary.showOnSubgraphNode', def, binding)
    if (conflict !== undefined) return [conflict]
    appendItem(tx, def, isSide(p.side) ? p.side : 'inputs', binding, isSide(p.side) ? {} : { promoted: true, wireHidden: true })
    return []
  },
}

/** Promote every written field and its button in the same transaction. */
const boundaryShowButton: CommandDefinition = {
  id: 'boundary.showButton',
  prepareForSharedReplay(doc, params, context, actor) {
    const tx = createTransactionBuilder(doc, actor)
    const diagnostics = boundaryShowButton.run(doc, params, tx, context)
    return diagnostics.some((item) => item.severity === 'error') ? { ok: false, diagnostics }
      : { ok: true, params: { ...(params as JsonObject), body: tx.current.graphs[(params as JsonObject).graphId as string]!.boundary!.body as unknown as Json } }
  },
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.node !== 'string' || typeof params.button !== 'string')
      return [err('params.invalid', 'boundary.showButton: identify an inner node button')]
    const def = doc.graphs[params.graphId]
    const node = def?.nodes[params.node]
    if (context.kind === 'shared-replay') {
      if (def === undefined || !Array.isArray(params.body)) return [err('params.invalid', 'The shown button body is missing.')]
      const shape = validateGraphDefShape({ ...def, boundary: { body: params.body } } as unknown as Json)
      if (shape.length > 0) return shape
      tx.set(['graphs', def.id, 'boundary'], { body: params.body })
      return []
    }
    const resolve = context.schemaResolverFor?.(doc)
    const schema = node === undefined || resolve === undefined ? undefined : documentNodeResolver(doc, resolve)(params.graphId, node)
    if (def === undefined || node === undefined || schema === undefined || def.id === doc.root)
      return [err('boundary.buttonMissing', 'The inner button is not available.')]
    if (boundaryButtons(def.boundary).some((entry) => entry.node === node.id && entry.button === params.button)) return []
    const button = elaborateInterface(schema, node).items.find((item) => item.kind === 'button' && item.id === params.button)
    const writes = button?.kind === 'button' ? buttonWriteFields(button.spec) : undefined
    if (writes === undefined) return [err('boundary.buttonUnsupported', 'This button changes graph structure or has unsupported steps and cannot be shown.')]
    const prefix = params.button.includes('.') ? params.button.slice(0, params.button.lastIndexOf('.') + 1) : ''
    for (const field of writes) {
      const port = prefix + field
      const current = tx.current.graphs[def.id]!
      const state = boundaryFieldState(current, { node: node.id, port: asPortId(port) })
      if (state.item?.promoted === true || state.item?.binds.kind === 'construct') continue
      const diagnostics = boundaryShowOnSubgraphNode.run(tx.current, { graphId: def.id, node: node.id, port }, tx, context)
      if (diagnostics.some((item) => item.severity === 'error')) return diagnostics
    }
    const current = tx.current.graphs[def.id]!
    const ids = new Set([...(current.boundary?.body ?? []).flatMap((entry) => 'id' in entry ? [entry.id] : []),
      ...boundaryItems(current.boundary, 'inputs').map((item) => item.id), ...boundaryItems(current.boundary, 'outputs').map((item) => item.id)])
    let id = params.button.replace(/[^a-zA-Z0-9_]/g, '_')
    for (let suffix = 2; ids.has(id); suffix++) id = `${params.button.replace(/[^a-zA-Z0-9_]/g, '_')}_${suffix}`
    tx.set(['graphs', def.id, 'boundary', 'body'], [...(current.boundary?.body ?? []), { kind: 'button', id, node: node.id, button: params.button }] as unknown as Json)
    return []
  },
}

const boundaryHideButton: CommandDefinition = {
  id: 'boundary.hideButton',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.itemId !== 'string')
      return [err('params.invalid', 'boundary.hideButton: identify a shown button')]
    const def = doc.graphs[params.graphId]
    if (def === undefined || !boundaryButtons(def.boundary).some((entry) => entry.id === params.itemId))
      return [err('boundary.buttonMissing', 'The shown button is missing.')]
    const remove = (entries: readonly BoundaryEntry[]): BoundaryEntry[] => entries.flatMap((entry): BoundaryEntry[] =>
      entry.kind === 'section' ? [{ ...entry, rows: remove(entry.rows) }]
        : entry.kind === 'button' && entry.id === params.itemId ? [] : [entry])
    tx.set(['graphs', def.id, 'boundary', 'body'], remove(def.boundary!.body) as unknown as Json)
    return []
  },
}

/** Follow only the explicitly chosen occurrence chain, never other uses of a definition. */
const boundaryShowOnAncestor: CommandDefinition = {
  id: 'boundary.showOnAncestor',
  prepareForSharedReplay(doc, params, context, actor) {
    if (!isObj(params)) return undefined
    const resolve = context.schemaResolverFor?.(doc)
    const node = typeof params.graphId === 'string' && typeof params.node === 'string'
      ? doc.graphs[params.graphId]?.nodes[params.node] : undefined
    const schema = node === undefined || resolve === undefined || typeof params.graphId !== 'string'
      ? undefined : documentNodeResolver(doc, resolve)(params.graphId, node)
    const construct = schema === undefined ? undefined
      : constructsAround(schema, String(params.port)).find((entry) => entry.path === params.port)
    const prepared = construct === undefined ? params : { ...params, side: construct.side }
    const diagnostics = boundaryShowOnAncestor.run(doc, prepared, createTransactionBuilder(doc, actor), context)
    return diagnostics.some((diagnostic) => diagnostic.severity === 'error')
      ? { ok: false, diagnostics } : { ok: true, params: prepared }
  },
  run(doc, params, tx, context) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.node !== 'string' ||
        typeof params.port !== 'string' || !Array.isArray(params.ancestors) || params.ancestors.length === 0 ||
        params.ancestors.some((hop) => !isObj(hop) || typeof hop.graphId !== 'string' || typeof hop.node !== 'string'))
      return [err('params.invalid', 'boundary.showOnAncestor: identify a field or construct and its enclosing occurrences')]
    const hops = [{ graphId: params.graphId, node: params.node },
      ...params.ancestors as { graphId: string; node: string }[]]
    const seen = new Set<string>()
    for (const [index, hop] of hops.entries()) {
      if (hop.graphId === doc.root || seen.has(hop.graphId) || doc.graphs[hop.graphId]?.nodes[hop.node] === undefined ||
          (index > 0 && doc.graphs[hop.graphId]!.nodes[hop.node]?.type !== `#${hops[index - 1]!.graphId}`))
        return [err('boundary.ancestorPath', 'The selected enclosing subgraph path is no longer available.')]
      seen.add(hop.graphId)
    }
    const resolve = context.kind === 'initial' ? context.schemaResolverFor?.(doc) : undefined
    const first = doc.graphs[params.graphId]?.nodes[params.node]
    const schema = first === undefined || resolve === undefined ? undefined
      : documentNodeResolver(doc, resolve)(params.graphId, first)
    const construct = schema === undefined ? undefined : constructsAround(schema, params.port).find((entry) => entry.path === params.port)
    const side = construct?.side ?? (context.kind === 'shared-replay' && isSide(params.side) ? params.side : undefined)
    let port = params.port
    for (const hop of hops) {
      const def = tx.current.graphs[hop.graphId]!
      const binding: NodeBoundaryBinding = { kind: side === undefined ? 'port' : 'construct', node: asNodeId(hop.node), port: asPortId(port) }
      const equivalent = boundaryItems(def.boundary, side ?? 'inputs').find((item) =>
        (side !== undefined || item.promoted === true) && [item.binds, ...(item.alsoBinds ?? [])]
          .some((candidate) => boundaryBindingKey(candidate) === boundaryBindingKey(binding)))
      if (equivalent !== undefined) {
        if (side !== 'outputs' && [equivalent.binds, ...(equivalent.alsoBinds ?? [])]
          .some((candidate) => boundaryBindingKey(candidate) !== boundaryBindingKey(binding)))
          return [err('boundary.ancestorFanOut', `'${equivalent.id}' in '${def.name}' also drives other targets. Choose those targets explicitly instead.`)]
        port = equivalent.id
        continue
      }
      const diagnostics = boundaryShowOnSubgraphNode.run(tx.current, {
        ...hop, port, ...(side === undefined ? {} : { side }),
      }, tx, context)
      if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) return diagnostics
      const added = boundaryItems(tx.current.graphs[hop.graphId]!.boundary, side ?? 'inputs')
        .find((item) => boundaryBindingKey(item.binds) === boundaryBindingKey(binding))
      if (added === undefined) return [err('boundary.ancestorPath', 'The intermediate exposure could not be created.')]
      port = added.id
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.setWireHidden {graphId, itemId, hidden}
//
// Draws or hides the wire of a boundary input shown on the subgraph node as a
// field or whole construct. Its id and per-instance values remain unchanged.
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
    if (found.item.binds.kind !== 'construct' && (found.item.binds.kind !== 'port' || found.item.promoted !== true)) return [err('boundary.notField', `boundary.setWireHidden: boundary input '${params.itemId}' is not shown as a field on the subgraph node`)]
    const path = [...found.path, 'wireHidden']
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
      tx.remove([...found.path, 'displayName'])
    } else {
      if (found.item.displayName === params.displayName) return []
      tx.set([...found.path, 'displayName'], params.displayName)
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
    if (params.side === 'inputs' && boundaryItems(def.boundary, 'inputs').some((item, index) => {
      const bindings = index === found.index ? (item.alsoBinds ?? []) : [item.binds, ...(item.alsoBinds ?? [])]
      return bindings.some((candidate) => bindingMatchesEndpoint(candidate, binding))
    })) return [err('boundary.duplicateBind', `boundary.setBinding: inner input '${params.node}/${params.port}' is already bound by a boundary input`)]
    const current = found.item.binds
    if (bindingKey(current) === bindingKey(binding)) return []
    tx.set([...found.path, 'binds'], binding as unknown as Json)
    // A row that stops being a field on the subgraph node draws its wire again.
    const stillField = binding.kind === 'construct' || (binding.kind === 'port' && found.item.promoted === true)
    if (found.item.wireHidden === true && !stillField)
      tx.remove([...found.path, 'wireHidden'])
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
    const path = found.path
    const side = params.side
    const removeItem = (): void => tx.set(['graphs', params.graphId as string, 'boundary'], withBoundaryItems(def.boundary, side,
      boundaryItems(def.boundary, side).filter((_, index) => index !== found.index)) as unknown as Json)
    if (params.side === 'outputs') {
      if (!bindingMatchesEndpoint(found.item.binds, target)) return [err('boundary.bindMissing', `boundary.unbind: boundary output '${params.itemId}' does not bind '${params.node}/${params.port}'`)]
      removeItem()
      return []
    }
    const also = found.item.alsoBinds ?? []
    const alsoIndex = also.findIndex((binding) => bindingMatchesEndpoint(binding, target))
    if (alsoIndex !== -1) {
      const kept = also.filter((_, index) => index !== alsoIndex)
      if (kept.length) tx.set([...path, 'alsoBinds'], kept as unknown as Json)
      else tx.remove([...path, 'alsoBinds'])
      return []
    }
    if (!bindingMatchesEndpoint(found.item.binds, target)) return [err('boundary.bindMissing', `boundary.unbind: boundary input '${params.itemId}' does not bind '${params.node}/${params.port}'`)]
    if (also.length === 0) removeItem()
    else {
      tx.set([...path, 'binds'], also[0] as unknown as Json)
      if (also.length === 1) tx.remove([...path, 'alsoBinds'])
      else tx.set([...path, 'alsoBinds'], also.slice(1) as unknown as Json)
    }
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.arrange {graphId, body}
//
// Sets the boundary's layout: where each input and output sits, the sections
// and the lines of fields, fold defaults and outputs kept on rows of their
// own. `body` names every item by side and id, as in
// [{kind: 'input', id}, {kind: 'section', id, rows: [...]},
//  {kind: 'line', rows: [{kind: 'input', id}, ...]}, {kind: 'output', id, ownRow: true}].
// It must name exactly the items the boundary has, so it never adds, removes
// or rebinds one: layout changes no value, wire or cache key.
// ---------------------------------------------------------------------------

const boundaryArrange: CommandDefinition = {
  id: 'boundary.arrange',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !Array.isArray(params.body))
      return [err('params.invalid', 'boundary.arrange: params must be {graphId, body: [...]}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.arrange: unknown graph '${params.graphId}'`)]
    const items = {
      inputs: new Map(boundaryItems(def.boundary, 'inputs').map((item) => [item.id as string, item])),
      outputs: new Map(boundaryItems(def.boundary, 'outputs').map((item) => [item.id as string, item])),
    }
    const buttons = new Map(boundaryButtons(def.boundary).map((entry) => [entry.id, entry]))
    const named = new Set<string>()
    const problems: Diagnostic[] = []
    const build = (entries: readonly Json[]): BoundaryEntry[] => entries.flatMap((entry): BoundaryEntry[] => {
      if (!isObj(entry)) {
        problems.push(err('params.invalid', 'boundary.arrange: every body entry must be an object'))
        return []
      }
      if (entry.kind === 'button') {
        const button = typeof entry.id === 'string' ? buttons.get(entry.id) : undefined
        if (button === undefined || named.has(`button:${button.id}`)) {
          problems.push(err('boundary.arrangeItems', 'boundary.arrange: unknown or repeated button'))
          return []
        }
        named.add(`button:${button.id}`)
        return [button]
      }
      if (entry.kind === 'input' || entry.kind === 'output') {
        const side = entry.kind === 'input' ? 'inputs' : 'outputs'
        const item = typeof entry.id === 'string' ? items[side].get(entry.id) : undefined
        if (item === undefined || named.has(`${side}:${item.id}`)) {
          problems.push(err('boundary.arrangeItems', `boundary.arrange: '${String(entry.id)}' is not a boundary ${entry.kind}, or is named twice`))
          return []
        }
        named.add(`${side}:${item.id}`)
        const { kind: _kind, ownRow: _ownRow, ...plain } = item as BoundaryItem & { kind?: unknown; ownRow?: unknown }
        if (entry.kind === 'input') return [{ ...plain, kind: 'input' }]
        return [{ ...plain, kind: 'output', ...(entry.ownRow === true ? { ownRow: true as const } : {}) }]
      }
      const rows = Array.isArray(entry.rows) ? build(entry.rows) : []
      if (entry.kind === 'line') return [{ kind: 'line', rows: rows as BoundaryInputEntry[] }]
      if (entry.kind === 'section' && typeof entry.id === 'string') return [{
        kind: 'section', id: entry.id, rows,
        ...(typeof entry.displayName === 'string' && entry.displayName.length > 0 ? { displayName: entry.displayName } : {}),
        ...(entry.collapsedByDefault === true ? { collapsedByDefault: true as const } : {}),
        ...(entry.openName === false ? { openName: false as const } : {}),
      }]
      problems.push(err('params.invalid', "boundary.arrange: an entry is an 'input', 'output', 'line' or a 'section' with an id"))
      return []
    })
    const body = build(params.body)
    if (problems.length > 0) return problems
    if (named.size !== items.inputs.size + items.outputs.size + buttons.size)
      return [err('boundary.arrangeItems', 'boundary.arrange: the body must name every input and output of the boundary')]
    const boundary: Boundary = { body }
    const shape = validateGraphDefShape({ ...def, boundary } as unknown as Json, `$.graphs.${def.id}`)
    if (shape.length > 0) return [err('boundary.arrangeShape', `boundary.arrange: ${shape[0]!.message}`)]
    if (canonicalJson(boundary) === canonicalJson(def.boundary ?? { body: [] })) return []
    tx.set(['graphs', def.id, 'boundary'], boundary as unknown as Json)
    return []
  },
}

// ---------------------------------------------------------------------------
// Row settings. Each is layout: it changes how every instance shows the row,
// never a value, a wire or what a run sends.
// ---------------------------------------------------------------------------

/** Set or clear one optional field of a boundary item; unchanged values record nothing. */
function setItemField(
  tx: TransactionBuilder,
  graphId: string,
  side: Side,
  found: { item: BoundaryItem; path: (string | number)[] },
  field: 'tooltip' | 'limits' | 'visible',
  value: Json | undefined,
): void {
  const path = [...found.path, field]
  const current = found.item[field] as Json | undefined
  if (value === undefined) {
    if (current !== undefined) tx.remove(path)
    return
  }
  if (JSON.stringify(current) !== JSON.stringify(value)) tx.set(path, value)
}

const formatBound = (value: number | undefined, fallback: string): string => value === undefined ? fallback : String(value)

/** The schema a command can read at its first dispatch; shared replay has none. */
function derivedFor(doc: WorkflowDocument, def: GraphDef, context: CommandExecutionContext) {
  const resolve = schemaResolverForCommand(doc, context)
  return resolve === undefined ? undefined : { resolve, derived: deriveBoundarySchema(def, resolve) }
}

// ---------------------------------------------------------------------------
// boundary.setTooltip {graphId, side, itemId, tooltip}
//
// The row's help text, shown when pointing at it on every instance. The empty
// string clears it, so the inner row's own tooltip shows again.
// ---------------------------------------------------------------------------

const boundarySetTooltip: CommandDefinition = {
  id: 'boundary.setTooltip',
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || !isSide(params.side) || typeof params.itemId !== 'string' || typeof params.tooltip !== 'string')
      return [err('params.invalid', "boundary.setTooltip: params must be {graphId, side: 'inputs'|'outputs', itemId, tooltip: string}")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.setTooltip: unknown graph '${params.graphId}'`)]
    const found = findItem(def, params.side, params.itemId)
    if (!found) return [err('boundary.itemMissing', `boundary.setTooltip: no boundary ${params.side.slice(0, -1)} '${params.itemId}' in graph '${params.graphId}'`)]
    const text = params.tooltip.trim()
    setItemField(tx, params.graphId, params.side, found, 'tooltip', text === '' ? undefined : text)
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.setLimits {graphId, itemId, min: number|null, max: number|null}
//
// Narrows a promoted number field's range on every instance; null leaves that
// side unlimited. A limit wider than the inner field's own range is refused
// at dispatch, where the schema is known: limits narrow and never widen.
// ---------------------------------------------------------------------------

const isBound = (v: Json | undefined): v is number | null =>
  v === null || (typeof v === 'number' && Number.isFinite(v))

const boundarySetLimits: CommandDefinition = {
  id: 'boundary.setLimits',
  validateDispatch(doc, params, context) {
    if (!isObj(params) || typeof params.itemId !== 'string' || !isBound(params.min) || !isBound(params.max)) return []
    // Clearing is always allowed, also once the inner field is no longer a number.
    if (params.min === null && params.max === null) return []
    const def = graphOf(doc, params.graphId)
    const found = def && findItem(def, 'inputs', params.itemId)
    const schema = def && found ? derivedFor(doc, def, context) : undefined
    if (!def || !found || schema === undefined) return []
    const inner = boundaryInnerInput(def, found.item, schema.resolve)
    if (inner === undefined) return []
    const range = numberFieldRange(inner)
    const name = found.item.displayName ?? inner.displayName ?? found.item.id
    if (range === undefined) return [err('boundary.limitsNotNumber', `Only a number field has limits; ${name} is not one.`)]
    const outside = (bound: number | null): boolean => bound !== null &&
      ((range.min !== undefined && bound < range.min) || (range.max !== undefined && bound > range.max))
    if (outside(params.min) || outside(params.max)) {
      return [err('boundary.limitsWider', `Limits can narrow ${name} (${formatBound(range.min, 'no lowest')} to ${formatBound(range.max, 'no highest')}) and never widen it.`)]
    }
    return []
  },
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.itemId !== 'string' || !isBound(params.min) || !isBound(params.max))
      return [err('params.invalid', 'boundary.setLimits: params must be {graphId, itemId, min: number|null, max: number|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.setLimits: unknown graph '${params.graphId}'`)]
    const found = findItem(def, 'inputs', params.itemId)
    if (!found) return [err('boundary.itemMissing', `boundary.setLimits: no boundary input '${params.itemId}' in graph '${params.graphId}'`)]
    if (found.item.promoted !== true) return [err('boundary.limitsNotField', `boundary.setLimits: boundary input '${params.itemId}' is not a field on the subgraph node`)]
    if (params.min !== null && params.max !== null && params.min > params.max)
      return [err('boundary.limitsOrder', `The lowest limit (${params.min}) is above the highest (${params.max}).`)]
    const limits = { ...(params.min !== null ? { min: params.min } : {}), ...(params.max !== null ? { max: params.max } : {}) }
    setItemField(tx, params.graphId, 'inputs', found, 'limits', Object.keys(limits).length > 0 ? limits : undefined)
    return []
  },
}

// ---------------------------------------------------------------------------
// boundary.setVisible {graphId, itemId, formula: string|null}
//
// When an input row shows on an instance: a formula in the formula language
// over the instance's own inputs; null shows it always. A formula outside the
// language, or naming anything but one of those inputs, is refused at
// dispatch. A condition never changes a value or what a run sends.
// ---------------------------------------------------------------------------

const boundarySetVisible: CommandDefinition = {
  id: 'boundary.setVisible',
  validateDispatch(doc, params, context) {
    if (!isObj(params) || typeof params.itemId !== 'string' || typeof params.formula !== 'string') return []
    const def = graphOf(doc, params.graphId)
    const schema = def && findItem(def, 'inputs', params.itemId) ? derivedFor(doc, def, context) : undefined
    if (schema?.derived.schema === undefined) return []
    try {
      Formula.parse(params.formula, boundaryConditionScope(schema.derived.schema))
    } catch (error) {
      if (error instanceof FormulaRefused) return [err('boundary.visibleRefused', `This condition cannot be used: ${error.message}.`)]
      throw error
    }
    return []
  },
  run(doc, params, tx) {
    if (!isObj(params) || typeof params.graphId !== 'string' || typeof params.itemId !== 'string' ||
        !(params.formula === null || (typeof params.formula === 'string' && params.formula.trim() !== '')))
      return [err('params.invalid', 'boundary.setVisible: params must be {graphId, itemId, formula: non-empty string|null}')]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.setVisible: unknown graph '${params.graphId}'`)]
    const found = findItem(def, 'inputs', params.itemId)
    if (!found) return [err('boundary.itemMissing', `boundary.setVisible: no boundary input '${params.itemId}' in graph '${params.graphId}'`)]
    setItemField(tx, params.graphId, 'inputs', found, 'visible', params.formula === null ? undefined : { formula: params.formula.trim() })
    return []
  },
}

export const BOUNDARY_COMMANDS: readonly CommandDefinition[] = [
  boundaryShowButton,
  boundaryHideButton,
  boundaryArrange,
  boundaryAddBinding,
  boundaryRemoveBinding,
  boundaryAddItem,
  boundaryShowOnSubgraphNode,
  boundaryShowOnAncestor,
  boundarySetWireHidden,
  boundaryRenameItem,
  boundarySetTooltip,
  boundarySetLimits,
  boundarySetVisible,
  boundarySetBinding,
  boundaryUnbind,
]
