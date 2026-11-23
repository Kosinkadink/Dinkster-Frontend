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
import { asNodeId, asPortId, asRerouteId } from '../ids.js'
import { Formula, FormulaRefused } from '../mirror/formula.js'
import { boundaryConditionScope, boundaryInnerInput, deriveBoundarySchema, numberFieldRange } from '../schema/derive-boundary.js'
import { schemaResolverForCommand } from './command-support.js'
import type { CommandDefinition, CommandExecutionContext, TransactionBuilder } from './contract.js'

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

// ---------------------------------------------------------------------------
// boundary.addItem {graphId, side, node, port?, tap?, itemId?, displayName?}
//
// Appends one endpoint exposure. IDs are allocated deterministically from the
// target when omitted. Input targets are globally unique across primary and
// fan-out bindings; outputs may re-expose a source.
// ---------------------------------------------------------------------------

const boundaryAddItem: CommandDefinition = {
  id: 'boundary.addItem',
  run(doc, params, tx) {
    if (
      !isObj(params) || typeof params.graphId !== 'string' || !isSide(params.side) ||
      typeof params.node !== 'string' || bindingFromParams(params, params.side) === undefined ||
      (params.itemId !== undefined && (typeof params.itemId !== 'string' || params.itemId.length === 0)) ||
      (params.displayName !== undefined && typeof params.displayName !== 'string')
    ) return [err('params.invalid', "boundary.addItem: params must identify one port binding, or one outputs-side widget tap")]
    const def = graphOf(doc, params.graphId)
    if (!def) return [err('graph.missing', `boundary.addItem: unknown graph '${params.graphId}'`)]
    if (!def.nodes[params.node]) return [err('node.missing', `boundary.addItem: no node '${params.node}' in graph '${params.graphId}'`)]
    const items = def.boundary?.[params.side] ?? []
    const allItems = [...(def.boundary?.inputs ?? []), ...(def.boundary?.outputs ?? [])]
    if (params.itemId !== undefined && allItems.some((item) => item.id === params.itemId))
      return [err('boundary.duplicateId', `boundary.addItem: boundary item '${params.itemId}' already exists in graph '${params.graphId}'`)]
    const binding = bindingFromParams(params, params.side)!
    if (params.side === 'inputs' && items.some((item) =>
      [item.binds, ...(item.alsoBinds ?? [])].some((candidate) => bindingMatchesEndpoint(candidate, binding))))
      return [err('boundary.duplicateBind', `boundary.addItem: inner input '${params.node}/${params.port}' is already bound by another boundary input`)]
    let id = params.itemId as string | undefined
    if (id === undefined) {
      const base = binding.kind === 'widgetTap'
        ? binding.tap
        : binding.port
      id = base
      // Allocate against BOTH sides: derivation treats boundary item ids
      // as one global namespace, so a generated input id must not collide
      // with an existing output id either.
      for (let suffix = 2; allItems.some((item) => item.id === id); suffix++) id = `${base}_${suffix}`
    }
    const item = {
      id,
      ...(typeof params.displayName === 'string' && params.displayName.length > 0 ? { displayName: params.displayName } : {}),
      binds: binding,
    }
    if (!def.boundary) {
      tx.set(['graphs', params.graphId, 'boundary'], {
        inputs: params.side === 'inputs' ? [item] : [],
        outputs: params.side === 'outputs' ? [item] : [],
      } as unknown as Json)
    } else {
      tx.set(['graphs', params.graphId, 'boundary', params.side], [...items, item] as unknown as Json)
    }
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

// ---------------------------------------------------------------------------
// Row settings. Each is layout: it changes how every instance shows the row,
// never a value, a wire or what a run sends.
// ---------------------------------------------------------------------------

/** Set or clear one optional field of a boundary item; unchanged values record nothing. */
function setItemField(
  tx: TransactionBuilder,
  graphId: string,
  side: Side,
  found: { item: BoundaryItem; index: number },
  field: 'tooltip' | 'limits' | 'visible',
  value: Json | undefined,
): void {
  const path = ['graphs', graphId, 'boundary', side, found.index, field]
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
  boundaryAddBinding,
  boundaryRemoveBinding,
  boundaryAddItem,
  boundaryRenameItem,
  boundarySetTooltip,
  boundarySetLimits,
  boundarySetVisible,
  boundarySetBinding,
  boundaryUnbind,
]
