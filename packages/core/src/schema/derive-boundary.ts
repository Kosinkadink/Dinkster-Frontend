/**
 * Subgraph boundary -> NodeSchema derivation.
 *
 * A subgraph definition's boundary derives EXACTLY the same NodeSchema model
 * backend nodes parse into - this is what makes "anything that works on a
 * node works on a subgraph" true by construction (architecture section 6).
 * The instance node ('#<defId>') is then typed, connected, muted, promoted,
 * and compiled by code that never knows it is a subgraph.
 *
 * Key rules:
 * - A 'port' binding names one input or output of an inner node by its
 *   flattened id, at any depth of the node's body: a row of a group member,
 *   of a choice's chosen option, or of a type choice. Forwarding a whole
 *   group, choice or type choice to the face is refused.
 * - Widget promotion: a promoted boundary input carries the inner WidgetSpec,
 *   so the instance renders the widget and stores the value under the
 *   boundary id. A non-promoted widget-backed input derives a socket-only
 *   input (forceInput) that is OPTIONAL: unconnected means the inner node's
 *   stored value applies.
 * - Type variables (MatchType) are namespaced per inner node
 *   ('<nodeId>:<templateId>'): unrelated 'T's from different inner nodes stay
 *   distinct, while ports of one inner node sharing a template keep sharing
 *   it on the boundary. A variable bound by a chosen type-choice variant
 *   projects as that concrete type.
 * - Route resolution is STRUCTURAL, shared with compilation via
 *   `resolveBoundaryRoute`: derive and lowering must never interpret the
 *   path independently.
 * - isOutputNode is true iff any inner node resolves to an output-node
 *   schema, and emitsPreviews iff any inner schema declares it; `resolve`
 *   must therefore also answer nested '#<defId>' types (registries resolve
 *   derived schemas recursively).
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import { generatedBoundaryLabel, regionBoundaryLabels } from './boundary-labels.js'
import { isNodeBoundaryBinding, type BoundaryBinding, type BoundaryItem, type DynamicPortState, type GraphDef, type NodeData, type PortBoundaryBinding, type RegionContract } from '../format/document.js'
import { isPortEndpoint, portAddressKey, type DynamicMemberId } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { rerouteInputTargets } from '../reroute.js'
import { effectiveValueSourceSpec, type EffectiveValueSourceSpec } from '../value-source.js'
import { typesCompatible, typesDirectlyCompatible } from './type-relations.js'
import { describedEntries } from './elaborate.js'
import { applyUse, keyPosition } from './body.js'
import { canonicalTypeIdOf, inputsOf, scopeRowsOf, typeExprFromTypeId } from './model.js'
import type {
  BodyRow,
  ChoiceSpec,
  DescribedSpec,
  GroupSpec,
  InputSpec,
  NodeSchema,
  OptionRow,
  OutputSpec,
  TypeChoiceSpec,
  TypeExpr,
} from './model.js'

/** Resolves node types and optional backend-declared editor roles. */
export interface SchemaResolver {
  (nodeType: string): NodeSchema | undefined
  readonly forEditorRole?: (role: string) => NodeSchema | undefined
}

export interface DeriveResult {
  /** Present unless an error-level diagnostic was produced. */
  readonly schema?: NodeSchema
  readonly diagnostics: readonly Diagnostic[]
}

export type StaticWidgetTapResolution =
  | { readonly ok: true; readonly input: InputSpec }
  | { readonly ok: false; readonly code: 'boundary.tapMissing' | 'boundary.tapAmbiguous' | 'boundary.tapUnsupported' }

/** Resolve one exact top-scope widget-backed input that can serve as an output tap. */
export function resolveStaticWidgetTap(schema: NodeSchema, tap: string): StaticWidgetTapResolution {
  const matches = inputsOf(schema).filter((candidate) => candidate.id === tap)
  if (matches.length !== 1) {
    return { ok: false, code: matches.length === 0 ? 'boundary.tapMissing' : 'boundary.tapAmbiguous' }
  }
  const input = matches[0]!
  return input.widget !== undefined
    ? { ok: true, input }
    : { ok: false, code: 'boundary.tapUnsupported' }
}

const mentionsCombo = (type: TypeExpr): boolean => {
  if (type.kind === 'concrete') return type.name === 'COMBO'
  if (type.kind === 'union') return type.names.includes('COMBO')
  if (type.kind === 'variable') return type.allowedTypes?.some(mentionsCombo) ?? false
  if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') return mentionsCombo(type.element)
  return false
}

const regionSourceMismatch = (source: TypeExpr, expected: TypeExpr): 'error' | 'warning' | undefined => {
  const runtimeType = canonicalTypeIdOf(source)
  if (runtimeType === undefined || typesDirectlyCompatible(typeExprFromTypeId(runtimeType), expected)) return undefined
  return mentionsCombo(source) || mentionsCombo(expected) ? 'error' : 'warning'
}

// ---------------------------------------------------------------------------
// Type freshening (per inner node)
// ---------------------------------------------------------------------------

const NO_TYPE_BINDINGS: ReadonlyMap<string, TypeExpr> = new Map()

/** Namespace a type expression's unbound variables by inner node id. */
function freshenType(
  type: TypeExpr,
  nodeId: string,
  bindings: ReadonlyMap<string, TypeExpr> = NO_TYPE_BINDINGS,
): TypeExpr {
  switch (type.kind) {
    case 'tuple':
      return { ...type, elements: type.elements.map((element) => freshenType(element, nodeId, bindings)) }
    case 'tuple_element':
      return type.element === undefined ? type : { ...type, element: freshenType(type.element, nodeId, bindings) }
    case 'variable': {
      const bound = bindings.get(type.templateId)
      if (bound !== undefined) return bound
      return {
        kind: 'variable',
        templateId: `${nodeId}:${type.templateId}`,
        ...(type.allowedTypes
          ? { allowedTypes: type.allowedTypes.map((t) => freshenType(t, nodeId, bindings)) }
          : {}),
      }
    }
    case 'list':
    case 'asset':
    case 'stream':
      return { kind: type.kind, element: freshenType(type.element, nodeId, bindings) }
    default:
      return type
  }
}

// ---------------------------------------------------------------------------
// Structural route resolution (shared by derivation AND compile lowering)
// ---------------------------------------------------------------------------

/** One box crossed on the way to a binding's target. */
export type RouteHop =
  | { readonly kind: 'member'; readonly familyPath: string; readonly spec: GroupSpec; readonly member: DynamicMemberId }
  /** A choice: the target exists under each of `options`. */
  | { readonly kind: 'combo'; readonly constructPath: string; readonly options: readonly string[]; readonly spec: ChoiceSpec }
  /** A type choice's rows, which exist while its pin is wired or a variant is chosen. */
  | { readonly kind: 'slot'; readonly constructPath: string; readonly spec: TypeChoiceSpec }
  | { readonly kind: 'slotVariant'; readonly constructPath: string; readonly key: string; readonly spec: TypeChoiceSpec }

export const memberHopsOf = (hops: readonly RouteHop[]): readonly Extract<RouteHop, { kind: 'member' }>[] =>
  hops.filter((h): h is Extract<RouteHop, { kind: 'member' }> => h.kind === 'member')

/** The node's dynamic state, keyed by flattened id at every depth. */
export function scopeAt(node: Pick<NodeData, 'dynamic'>, _hops?: readonly RouteHop[]): Readonly<Record<string, DynamicPortState>> | undefined {
  return node.dynamic
}

export type RouteTerminal =
  | {
      readonly kind: 'port'
      /** The input or output, with its flattened id. A type choice's pin is an input. */
      readonly slot: InputSpec | OutputSpec
    }
  | {
      readonly kind: 'family'
      readonly declaring: GroupSpec
      /** Flattened id of the group (== binding.port). */
      readonly familyPath: string
    }
  | {
      /** A choice, a type choice with variants, or a described row: a box, not a port. */
      readonly kind: 'construct'
      readonly row: ChoiceSpec | TypeChoiceSpec | DescribedSpec
      readonly constructPath: string
    }

export interface BoundaryRoute {
  readonly side: 'input' | 'output'
  /** Top-scope row the route enters through. */
  readonly topItem: BodyRow
  readonly hops: readonly RouteHop[]
  readonly terminal: RouteTerminal
}

export type RouteResult =
  | { readonly ok: true; readonly route: BoundaryRoute }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Whether any output sits inside a row, so a route to it is on the output side. */
function holdsOutput(row: OptionRow): boolean {
  switch (row.kind) {
    case 'output': return true
    case 'section': case 'row': return row.rows.some(holdsOutput)
    case 'group': return (row.value !== undefined ? [row.value] : row.member ?? []).some(holdsOutput)
    case 'choice': return [...row.shared, ...row.options.flatMap((option) => option.rows)].some(holdsOutput)
    case 'typeChoice': return [...row.rows, ...(row.variants ?? []).flatMap((variant) => variant.rows)].some(holdsOutput)
    case 'described': return row.kinds.some((kind) => kind.kind === 'output')
    default: return false
  }
}

/** The pin type of a type choice before a variant is chosen. */
function slotTypeOf(choice: TypeChoiceSpec): TypeExpr {
  if (choice.type !== undefined) return choice.type
  const variants = choice.variants ?? []
  if (variants.length === 1) return variants[0]!.type
  if (variants.length > 1 && variants.every((variant) => variant.type.kind === 'concrete')) {
    const names = [...new Set(variants.map((variant) => (variant.type as Extract<TypeExpr, { kind: 'concrete' }>).name))]
    return names.length === 1 ? { kind: 'concrete', name: names[0]! } : { kind: 'union', names }
  }
  return { kind: 'wildcard' }
}

/**
 * Resolve a binding's flattened port id against a schema's body
 * STRUCTURALLY: each segment names a row of the current scope, a group's
 * member key, or a row inside a choice or a type choice. Ids never hold a
 * dot, so a path has exactly one reading; a member key is checked against
 * the group's naming rule. The `kind` fit (port vs family) is checked by the
 * CALLER so kind mismatches get precise diagnostics. `values` lets a route
 * reach the rows of a described row.
 */
export function resolveBoundaryRoute(
  schema: NodeSchema,
  binding: BoundaryBinding,
  expectedSide?: 'input' | 'output',
  values?: Readonly<Record<string, unknown>>,
  _dynamic?: NodeData['dynamic'],
): RouteResult {
  if (binding.kind === 'unbound' || binding.kind === 'valueSource') return { ok: false, code: 'boundary.unboundRoute', message: 'a structural boundary has no node port route' }
  if (binding.kind === 'widgetTap') {
    return { ok: false, code: 'boundary.tapRoute', message: `widget tap '${binding.tap}' is not a port or family route` }
  }
  const path = binding.port as string
  if ((binding.members?.length ?? 0) > 0) {
    return { ok: false, code: 'boundary.memberPath', message: `port '${path}' carries member ids; a member is part of the flattened id` }
  }
  const segs = path.split('.')
  let found: BoundaryRoute | undefined
  let problem: { code: string; message: string } | undefined

  const walk = (
    rows: readonly OptionRow[],
    index: number,
    prefix: string,
    hops: readonly RouteHop[],
    topItem: BodyRow | undefined,
    shared?: ReadonlyMap<string, BodyRow>,
  ): void => {
    const seg = segs[index]
    for (const raw of scopeRowsOf(rows)) {
      if (raw.kind === 'row' || raw.kind === 'note' || raw.kind === 'button' || raw.kind === 'section') continue
      let row: BodyRow
      if (raw.kind === 'use') {
        const base = shared?.get(raw.id)
        if (base === undefined) continue
        row = applyUse(base, raw)
      } else row = raw
      if (row.kind === 'row' || row.kind === 'section' || row.kind === 'note' || row.kind === 'button' || row.id !== seg) continue
      const full = `${prefix}${row.id}`
      const top = topItem ?? row
      const last = index === segs.length - 1
      switch (row.kind) {
        case 'input':
        case 'output':
          if (last) {
            const route: BoundaryRoute = { side: row.kind, topItem: top, hops, terminal: { kind: 'port', slot: { ...row, id: full } } }
            // An input and an output may share an id; keep looking for the expected side.
            if (expectedSide !== undefined && row.kind !== expectedSide) {
              found ??= route
              continue
            }
            found = route
          }
          break
        case 'group':
          if (last) {
            found = { side: holdsOutput(row) && expectedSide !== 'input' ? 'output' : 'input', topItem: top, hops, terminal: { kind: 'family', declaring: row, familyPath: full } }
            break
          }
          {
            const key = segs[index + 1]!
            if (keyPosition(row.keys, key) === undefined) {
              problem = { code: 'boundary.memberPath', message: `'${key}' is not a member key group '${full}' can make` }
              break
            }
            const memberHops: readonly RouteHop[] = [...hops, { kind: 'member', familyPath: full, spec: row, member: key as DynamicMemberId }]
            if (row.value !== undefined) {
              if (index + 1 === segs.length - 1) {
                found = { side: row.value.kind, topItem: top, hops: memberHops, terminal: { kind: 'port', slot: { ...row.value, id: `${full}.${key}` } } }
              }
            } else {
              walk(row.member ?? [], index + 2, `${full}.${key}.`, memberHops, top)
            }
          }
          break
        case 'choice':
          if (last) {
            found = { side: 'input', topItem: top, hops, terminal: { kind: 'construct', row, constructPath: full } }
            break
          }
          {
            const sharedRows = new Map(row.shared.filter((item) => item.kind !== 'row').map((item) => [(item as { id: string }).id, item]))
            const options: string[] = []
            let reached: BoundaryRoute | undefined
            for (const option of row.options) {
              found = undefined
              walk(option.rows, index + 1, `${full}.`, [...hops, { kind: 'combo', constructPath: full, options: [], spec: row }], top, sharedRows)
              const here = found as BoundaryRoute | undefined
              if (here !== undefined) {
                options.push(option.key)
                reached ??= here
              }
            }
            found = reached === undefined ? undefined : {
              ...reached,
              hops: reached.hops.map((hop) => hop.kind === 'combo' && hop.constructPath === full ? { ...hop, options } : hop),
            }
          }
          break
        case 'typeChoice':
          if (last) {
            found = row.variants === undefined
              ? { side: 'input', topItem: top, hops, terminal: { kind: 'port', slot: { kind: 'input', id: full, type: slotTypeOf(row), optional: true, ...(typeof row.displayName === 'string' ? { displayName: row.displayName } : {}) } } }
              : { side: 'input', topItem: top, hops, terminal: { kind: 'construct', row, constructPath: full } }
            break
          }
          walk(row.rows, index + 1, `${full}.`, [...hops, { kind: 'slot', constructPath: full, spec: row }], top)
          for (const variant of row.variants ?? []) {
            if (found !== undefined) break
            walk(variant.rows, index + 1, `${full}.`, [...hops, { kind: 'slotVariant', constructPath: full, key: variant.key, spec: row }], top)
          }
          break
        case 'described':
          if (last) {
            found = { side: 'input', topItem: top, hops, terminal: { kind: 'construct', row, constructPath: full } }
            break
          }
          if (index + 1 === segs.length - 1 && values !== undefined) {
            const entries = describedEntries(row, values[full] ?? undefined, full)
            const entry = typeof entries === 'string' ? undefined : entries.find((candidate) => candidate.id === segs[index + 1])
            const kind = entry === undefined ? undefined : row.kinds.find((candidate) => candidate.id === entry.kind)
            if (entry !== undefined && kind !== undefined) {
              found = { side: kind.kind, topItem: top, hops, terminal: { kind: 'port', slot: { ...kind, id: `${full}.${entry.id}`, displayName: entry.label } } }
            }
          }
          break
        case 'state':
          break
      }
      return
    }
  }
  walk(schema.body, 0, '', [], undefined)
  if (found !== undefined) {
    if (expectedSide !== undefined && found.side !== expectedSide && found.terminal.kind === 'port' && found.terminal.slot.kind === expectedSide) return { ok: true, route: { ...found, side: expectedSide } }
    return { ok: true, route: found }
  }
  if (problem !== undefined) return { ok: false, ...problem }
  return { ok: false, code: 'boundary.unknownPort', message: `no port '${path}' on '${schema.type}'` }
}

/** The definition-local dynamic state of a group, keyed by its flattened id. */
export function familyStateAt(
  node: Pick<NodeData, 'dynamic'>,
  _hops: readonly RouteHop[],
  familyPath: string,
): DynamicPortState | undefined {
  return node.dynamic?.[familyPath]
}

// ---------------------------------------------------------------------------
// Boundary -> NodeSchema derivation
// ---------------------------------------------------------------------------

/**
 * Derive the NodeSchema of a subgraph definition's boundary. Returns
 * diagnostics for every unresolvable binding; the schema is produced only if
 * no error occurred (partial schemas would let bad instances propagate).
 */
export function deriveBoundarySchema(
  graph: GraphDef,
  resolve: SchemaResolver,
  region?: RegionContract,
  resolveNode: (node: NodeData) => NodeSchema | undefined = (node) => resolve(node.type),
  resolveSource?: (sourceId: string) => EffectiveValueSourceSpec | undefined,
): DeriveResult {
  const diags: Diagnostic[] = []
  const fail = (code: string, msg: string): void => {
    diags.push(diag('error', 'schema', code, `[${graph.id}] ${msg}`))
  }

  if (!graph.boundary) {
    fail('boundary.missing', `graph definition has no boundary (root graphs cannot be instanced)`)
    return { diagnostics: diags }
  }

  const inputs = graph.boundary.inputs.map((item): BoundaryItem => {
    const bindings = [item.binds, ...(item.alsoBinds ?? [])]
    if (bindings.every((binding) => binding.viaReroute === undefined)) return item
    const expanded = bindings.flatMap((binding): BoundaryBinding[] => {
      if (binding.viaReroute === undefined) return [binding]
      const targets = rerouteInputTargets(graph, binding.viaReroute)
      if (binding.kind !== 'port' || !targets?.length ||
          !targets.some((target) => target.node === binding.node && portAddressKey(target.port, target.members) === portAddressKey(binding.port, binding.members)) ||
          Object.values(graph.links).some((link) => 'reroute' in link.to && link.to.reroute === binding.viaReroute)) {
        fail('boundary.reroute', `boundary input '${item.id}' has an invalid or internally driven junction attachment`)
        return []
      }
      const { viaReroute: _via, ...authority } = binding
      return [authority, ...targets.filter((target) => target.node !== binding.node || portAddressKey(target.port, target.members) !== portAddressKey(binding.port, binding.members))
        .map((target) => ({ kind: 'port' as const, ...target }))]
    })
    const { alsoBinds: _also, ...single } = item
    return { ...single, binds: expanded[0] ?? item.binds, ...(expanded.length > 1 ? { alsoBinds: expanded.slice(1) } : {}) }
  })
  if (diags.length) return { diagnostics: diags }
  if (graph.boundary.outputs.some((item) => item.binds.viaReroute !== undefined)) {
    fail('boundary.rerouteSide', 'junction attachments are input-side only')
    return { diagnostics: diags }
  }
  const def = { ...graph, boundary: { ...graph.boundary, inputs } }


  const items: (InputSpec | OutputSpec)[] = []
  const seenIds = new Set<string>()
  const routeCache = new WeakMap<object, Partial<Record<'input' | 'output', { node: NodeData; route: BoundaryRoute }>>>()
  const slotTypeBindings = new WeakMap<NodeData, ReadonlyMap<string, TypeExpr>>()

  /** A type variable a chosen variant of a top-scope type choice binds. */
  const typeBindingsFor = (node: NodeData): ReadonlyMap<string, TypeExpr> => {
    const cached = slotTypeBindings.get(node)
    if (cached !== undefined) return cached
    const bindings = new Map<string, TypeExpr>()
    const schema = resolveNode(node)
    for (const row of schema === undefined ? [] : scopeRowsOf(schema.body)) {
      if (row.kind !== 'typeChoice' || row.typeVariable === undefined || row.variants === undefined) continue
      const variant = row.variants.find((candidate) => candidate.key === node.dynamic?.[row.id]?.selected)
      if (variant !== undefined) bindings.set(row.typeVariable, variant.type)
    }
    slotTypeBindings.set(node, bindings)
    return bindings
  }

  const checkId = (item: BoundaryItem): boolean => {
    if (seenIds.has(item.id)) {
      fail('boundary.duplicateId', `duplicate boundary id '${item.id}'`)
      return false
    }
    seenIds.add(item.id)
    return true
  }

  /** Link existence on an inner node's input, by flattened id. */
  const isInternallyConnected = (b: PortBoundaryBinding, port: string): boolean => {
    const key = portAddressKey(port, b.members)
    for (const link of Object.values(def.links)) {
      if (isPortEndpoint(link.to) && link.to.node === b.node && portAddressKey(link.to.port, link.to.members) === key) return true
    }
    for (const net of Object.values(def.nets)) {
      if (net.sinks.some((s) => s.node === b.node && portAddressKey(s.port, s.members) === key)) return true
    }
    return false
  }

  /**
   * Resolve schema + route for one binding; undefined = failed, with one
   * diagnostic. A route must reach a port that exists in the definition:
   * the chosen option of each choice it crosses and a wired or chosen type
   * choice. Forwarding a whole group, a choice or a type choice to the
   * face is refused here.
   */
  const routeForBinding = (
    binds: BoundaryBinding,
    describe: string,
    expectedSide: 'input' | 'output',
  ): { node: NodeData; route: BoundaryRoute } | undefined => {
    if (!isNodeBoundaryBinding(binds)) return undefined
    const cached = routeCache.get(binds)?.[expectedSide]
    if (cached != null) return cached
    const node = def.nodes[binds.node]
    if (!node) {
      fail('boundary.danglingNode', `${describe} binds missing node '${binds.node}'`)
      return undefined
    }
    const schema = resolveNode(node)
    if (!schema) {
      fail('boundary.unresolvedSchema', `${describe} binds node '${node.id}' of unresolvable type '${node.type}'`)
      return undefined
    }
    if (binds.kind === 'widgetTap') {
      fail('boundary.tapSide', `${describe} uses an output-only widget tap binding`)
      return undefined
    }
    const result = resolveBoundaryRoute(schema, binds, expectedSide, node.values, node.dynamic)
    if (!result.ok) {
      fail(result.code, `${describe}: ${result.message}`)
      return undefined
    }
    const route = result.route
    if (route.terminal.kind !== 'port') {
      fail('boundary.familyBind', `${describe} binds '${binds.port}', which is a group, a choice, a type choice or a described row, not a port`)
      return undefined
    }
    for (const hop of route.hops) {
      if (hop.kind === 'combo') {
        const stored = node.dynamic?.[hop.constructPath]?.selected
        const active = stored ?? hop.spec.default ?? (hop.spec.required ? hop.spec.options[0]?.key : undefined)
        if (active === undefined || !hop.options.includes(active)) {
          fail('boundary.branchInactive', `${describe}: '${binds.port}' is not a row of the chosen option of '${hop.constructPath}'; the chosen option is '${active ?? ''}'`)
          return undefined
        }
      } else if (hop.kind === 'slotVariant') {
        const active = node.dynamic?.[hop.constructPath]?.selected
        if (active !== hop.key) {
          fail('boundary.branchInactive', `${describe}: variant '${hop.key}' of '${hop.constructPath}' is not chosen; the chosen variant is '${active ?? ''}'`)
          return undefined
        }
      } else if (hop.kind === 'slot' && hop.spec.variants === undefined && !isInternallyConnected(binds, hop.constructPath)) {
        fail('boundary.slotDisconnected', `${describe} binds '${binds.port}' beneath type choice '${hop.constructPath}', which is not connected inside the definition`)
        return undefined
      } else if (hop.kind === 'member' && !(node.dynamic?.[hop.familyPath]?.members ?? []).includes(hop.member) &&
          typeof hop.spec.grows !== 'object') {
        fail('boundary.memberMissing', `${describe}: member '${hop.member}' of group '${hop.familyPath}' is not stored on the node`)
        return undefined
      }
    }
    const resolved = { node, route }
    routeCache.set(binds, { ...routeCache.get(binds), [expectedSide]: resolved })
    return resolved
  }

  /** Resolve schema + route for one item's PRIMARY binding. */
  const routeFor = (item: BoundaryItem, side: 'input' | 'output'): { node: NodeData; route: BoundaryRoute } | undefined =>
    routeForBinding(item.binds, `boundary ${side} '${item.id}'`, side)

  /** Fan-out duplicate key: full target address (node, port, member path). */
  const targetKeyOf = (b: PortBoundaryBinding): string => JSON.stringify([b.node, b.port, b.members ?? []])

  const displayNameOf = (
    item: BoundaryItem,
    inner: InputSpec | OutputSpec,
  ): { displayName: string } => ({
    displayName: item.displayName ?? inner.displayName ?? generatedBoundaryLabel(item),
  })

  const valueSourceInputs = new Map<string, string>()
  for (const item of def.boundary.inputs) {
    if (!checkId(item)) continue
    if (item.binds.kind === 'valueSource') {
      const previous = valueSourceInputs.get(item.binds.valueSource)
      if (previous !== undefined) {
        fail('boundary.valueSourceConflict', `boundary inputs '${previous}' and '${item.id}' both bind value source '${item.binds.valueSource}'`)
        continue
      }
      valueSourceInputs.set(item.binds.valueSource, item.id)
      const source = def.valueSources?.[item.binds.valueSource]
      if (!source) {
        fail('boundary.danglingValueSource', `boundary input '${item.id}' binds missing value source '${item.binds.valueSource}'`)
        continue
      }
      const effective = resolveSource?.(source.id) ?? effectiveValueSourceSpec(def, source, resolve)
      items.push({ kind: 'input', id: item.id, type: item.binds.type, optional: true,
        ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
        ...(item.promoted === true && effective.spec !== undefined ? { widget: {
          ...effective.spec,
          default: source.value,
          ...(source.controller !== undefined ? { controllerInitial: source.controller } : {}),
        } } : {}),
      })
      continue
    }
    if (item.binds.kind === 'unbound') {
      items.push({ kind: 'input', id: item.id, ...(item.displayName !== undefined ? { displayName: item.displayName } : {}), type: item.binds.type, optional: true })
      continue
    }
    if (item.binds.kind === 'widgetTap') {
      fail('boundary.tapSide', `boundary input '${item.id}' uses an output-only widget tap binding`)
      continue
    }
    const resolved = routeFor(item, 'input')
    if (!resolved) continue
    const { node, route } = resolved
    if (route.side !== 'input') {
      fail('boundary.sideMismatch', `boundary input '${item.id}' binds an OUTPUT port '${item.binds.port}'`)
      continue
    }
    if (route.terminal.kind !== 'port') continue
    const inner = route.terminal.slot as InputSpec
    const promoted = item.promoted === true && inner.widget !== undefined
    const primaryType = freshenType(inner.type, item.binds.node, typeBindingsFor(node))
    // Fan-out: the PRIMARY binding stays authoritative for type and widget;
    // each additional target must resolve structurally (errors skip the
    // item) and should accept the derived type (advisory warning only -
    // documents are never rejected on type grounds). The boundary input is
    // satisfiable without a connection only when EVERY target is (each
    // falls back to its own stored value or optionality).
    let satisfiable = inner.optional || inner.widget !== undefined
    let fanoutOk = true
    if (item.alsoBinds !== undefined) {
      const seenTargets = new Set<string>([targetKeyOf(item.binds)])
      for (const [i, b] of item.alsoBinds.entries()) {
        const describe = `boundary input '${item.id}' fan-out target [${i}]`
        if (b.kind !== 'port') {
          fail('boundary.fanoutKind', `${describe} must be kind 'port'`)
          fanoutOk = false
          continue
        }
        const key = targetKeyOf(b)
        if (seenTargets.has(key)) {
          fail('boundary.duplicateBind', `${describe} repeats target '${b.node}/${b.port}'${b.members ? ` member '${b.members.join('.')}'` : ''}`)
          fanoutOk = false
          continue
        }
        seenTargets.add(key)
        const r = routeForBinding(b, describe, 'input')
        if (!r) {
          fanoutOk = false
          continue
        }
        if (r.route.side !== 'input') {
          fail('boundary.sideMismatch', `${describe} binds an OUTPUT port '${b.port}'`)
          fanoutOk = false
          continue
        }
        if (r.route.terminal.kind !== 'port') continue
        const targetSlot = r.route.terminal.slot as InputSpec
        if (!typesCompatible(primaryType, freshenType(targetSlot.type, b.node, typeBindingsFor(r.node)))) {
          diags.push(diag('warning', 'schema', 'boundary.fanoutTypeMismatch', `[${def.id}] boundary input '${item.id}' fan-out target '${b.node}/${b.port}' does not accept the boundary type`))
        }
        if (!(targetSlot.optional || targetSlot.widget !== undefined)) satisfiable = false
      }
    }
    if (!fanoutOk) continue
    const inheritedOptions = inner.widget?.editableOptions ? node.dynamic?.[item.binds.port]?.options : undefined
    const promotedWidget = promoted ? {
      ...inner.widget!,
      ...(inheritedOptions !== undefined ? { options: { ...inner.widget!.options, options: inheritedOptions } } : {}),
      ...(Object.hasOwn(node.values, item.binds.port as string)
        ? { default: node.values[item.binds.port as string] }
        : {}),
      ...(Object.hasOwn(node.controllers ?? {}, item.binds.port as string)
        ? { controllerInitial: node.controllers![item.binds.port as string] }
        : {}),
    } : undefined
    items.push({
      kind: 'input',
      id: item.id,
      ...displayNameOf(item, inner),
      ...(inner.tooltip !== undefined ? { tooltip: inner.tooltip } : {}),
      type: primaryType,
      // A widget-backed inner input has a stored value, so the boundary
      // input is satisfiable without a connection.
      optional: satisfiable,
      ...(promotedWidget !== undefined
        ? { widget: promotedWidget }
        : inner.widget !== undefined
          ? { forceInput: true }
          : {}),
      ...(inner.lazy !== undefined ? { lazy: inner.lazy } : {}),
    })
  }

  for (const item of def.boundary.outputs) {
    if (!checkId(item)) continue
    if (item.binds.kind === 'valueSource') {
      if (!def.valueSources?.[item.binds.valueSource]) {
        fail('boundary.danglingValueSource', `boundary output '${item.id}' binds missing value source '${item.binds.valueSource}'`)
        continue
      }
      items.push({ kind: 'output', id: item.id, type: item.binds.type,
        ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
      })
      continue
    }
    if (item.binds.kind === 'unbound') {
      items.push({ kind: 'output', id: item.id, ...(item.displayName !== undefined ? { displayName: item.displayName } : {}), type: item.binds.type })
      continue
    }
    if (item.alsoBinds !== undefined) {
      fail('boundary.fanoutOnOutput', `boundary output '${item.id}': 'alsoBinds' is invalid on outputs (an output has exactly one source)`)
      continue
    }
    if (item.binds.kind === 'widgetTap') {
      const binding = item.binds
      const node = def.nodes[binding.node]
      if (node === undefined) {
        fail('boundary.danglingNode', `boundary output '${item.id}' binds missing node '${binding.node}'`)
        continue
      }
      const schema = resolveNode(node)
      if (schema === undefined) {
        fail('boundary.unresolvedSchema', `boundary output '${item.id}' binds node '${node.id}' of unresolvable type '${node.type}'`)
        continue
      }
      const resolvedTap = resolveStaticWidgetTap(schema, binding.tap)
      if (!resolvedTap.ok) {
        fail(
          resolvedTap.code,
          resolvedTap.code === 'boundary.tapUnsupported'
            ? `boundary output '${item.id}' must bind one static widget-backed input`
            : `boundary output '${item.id}' widget tap '${binding.tap}' resolves to ${resolvedTap.code === 'boundary.tapMissing' ? 0 : 'multiple'} static inputs`,
        )
        continue
      }
      const inner = resolvedTap.input
      items.push({
        kind: 'output',
        id: item.id,
        ...displayNameOf(item, inner),
        ...(inner.tooltip !== undefined ? { tooltip: inner.tooltip } : {}),
        type: freshenType(inner.type, binding.node, typeBindingsFor(node)),
      })
      continue
    }
    const resolved = routeFor(item, 'output')
    if (!resolved) continue
    const { node, route } = resolved
    if (route.side !== 'output') {
      fail('boundary.sideMismatch', `boundary output '${item.id}' binds an INPUT port '${item.binds.port}'`)
      continue
    }
    if (route.terminal.kind !== 'port') continue
    const inner = route.terminal.slot as OutputSpec
    items.push({
      kind: 'output',
      id: item.id,
      ...displayNameOf(item, inner),
      ...(inner.tooltip !== undefined ? { tooltip: inner.tooltip } : {}),
      type: freshenType(inner.type, item.binds.node, typeBindingsFor(node)),
      ...(inner.isList !== undefined ? { isList: inner.isList } : {}),
      ...(inner.preview !== undefined ? { preview: inner.preview } : {}),
    })
  }

  // Output-node status: any active inner output node makes
  // the instance one (partial-execution scoping descends through instances).
  // Runtime capabilities aggregate the same way. Nested subgraphs compose
  // because inner instances resolve to derived schemas.
  let isOutputNode = false
  let emitsPreviews = false
  let mayExpandGraph = false
  for (const node of Object.values(def.nodes)) {
    const schema = resolveNode(node)
    if (schema?.isOutputNode && node.mode !== 'muted' && node.mode !== 'bypassed') isOutputNode = true
    if (schema?.emitsPreviews) emitsPreviews = true
    if (schema?.mayExpandGraph) mayExpandGraph = true
    if (isOutputNode && emitsPreviews && mayExpandGraph) break
    if (!schema && subgraphDefIdOf(node.type) === undefined) {
      diags.push(
        diag('warning', 'schema', 'boundary.innerUnresolved', `[${def.id}] inner node '${node.id}' type '${node.type}' is unresolvable; derived capabilities may be understated`),
      )
    }
  }

  let derivedItems = items
  if (region !== undefined) {
    if (!def.boundary.outputs.some((output) => output.id !== region.continueOutput) && !isOutputNode) {
      fail('doc.region.outputRequired', 'region requires an exported boundary output or a declared output node')
    }
    const elements = new Set(region.elementPorts ?? [])
    const state = new Set(region.statePorts ?? [])
    const outputRoles = region.outputRoles ?? {}
    const inputRoleLabels = regionBoundaryLabels(def.boundary?.inputs ?? [], region, 'inputs')
    const outputRoleLabels = regionBoundaryLabels(def.boundary?.outputs ?? [], region, 'outputs')
    const explicitInputLabels = new Set((def.boundary?.inputs ?? []).filter((item) => item.displayName !== undefined).map((item) => item.id))
    const explicitOutputLabels = new Set((def.boundary?.outputs ?? []).filter((item) => item.displayName !== undefined).map((item) => item.id))
    const stateInputTypes = new Map(
      items.flatMap((item) => item.kind === 'input' && state.has(item.id) ? [[item.id, item.type] as const] : []),
    )
    const projected: (InputSpec | OutputSpec)[] = []
    for (const item of items) {
      if (item.kind === 'input') {
        const roleLabel = inputRoleLabels.get(item.id)
        const named = explicitInputLabels.has(item.id) || roleLabel === undefined ? item : { ...item, displayName: roleLabel }
        if (elements.has(item.id)) {
          if (item.widget !== undefined) {
            fail('doc.region.elementPromoted', `region element input '${item.id}' cannot promote a scalar widget`)
          }
          projected.push({ ...named, type: { kind: 'list', element: item.type } })
        } else {
          // State and broadcast ports retain the ordinary boundary contract.
          projected.push(named)
        }
        continue
      }
      const sourceType: TypeExpr = item.isList === true ? { kind: 'list', element: item.type } : item.type
      if (item.id === region.continueOutput) {
        const severity = regionSourceMismatch(sourceType, { kind: 'concrete', name: 'BOOLEAN' })
        if (severity !== undefined) {
          diags.push(diag(severity, 'schema', 'doc.region.continueNotBoolean', `[${def.id}] region continue output '${item.id}' is not statically BOOLEAN`))
        }
        continue
      }
      const role = Object.hasOwn(outputRoles, item.id) ? outputRoles[item.id] : undefined
      const roleLabel = outputRoleLabels.get(item.id)
      const named = explicitOutputLabels.has(item.id) || roleLabel === undefined ? item : { ...item, displayName: roleLabel }
      if (role === undefined || role.kind === 'gather' || role.kind === 'compact') {
        if (canonicalTypeIdOf(sourceType) === undefined) {
          const roleName = role?.kind ?? 'gather'
          diags.push(diag('warning', 'schema', 'doc.region.gatherNonConcrete', `[${def.id}] region ${roleName} output '${item.id}' is not statically runtime-resolvable`))
        }
        const { isList: _isList, ...withoutLegacyList } = named
        projected.push({ ...withoutLegacyList, type: { kind: 'list', element: sourceType } })
      } else if (role.kind === 'flatten') {
        if (sourceType.kind !== 'list') {
          fail('doc.region.flattenNonList', `region flatten output '${item.id}' requires a list-typed body output`)
        } else {
          if (canonicalTypeIdOf(sourceType) === undefined) {
            diags.push(diag('warning', 'schema', 'doc.region.flattenNonConcrete', `[${def.id}] region flatten output '${item.id}' is not statically runtime-resolvable`))
          }
          const { isList: _isList, ...withoutLegacyList } = named
          projected.push({ ...withoutLegacyList, type: sourceType })
        }
      } else if (role.kind === 'last') {
        if (canonicalTypeIdOf(sourceType) === undefined) {
          diags.push(diag('warning', 'schema', 'doc.region.lastNonConcrete', `[${def.id}] region last output '${item.id}' is not statically runtime-resolvable`))
        }
        const { isList: _isList, ...withoutLegacyList } = named
        projected.push({ ...withoutLegacyList, type: sourceType })
      } else {
        const carriedType = stateInputTypes.get(role.statePort)
        const severity = carriedType === undefined ? undefined : regionSourceMismatch(sourceType, carriedType)
        if (severity !== undefined) {
          const message = `[${def.id}] region state output '${item.id}' does not produce a value compatible with state input '${role.statePort}'`
          diags.push(diag(severity, 'schema', 'doc.region.stateTypeMismatch', message))
        }
        const { isList: _isList, ...withoutLegacyList } = named
        projected.push({ ...withoutLegacyList, type: carriedType ?? sourceType })
      }
    }
    derivedItems = projected
  }

  if (diags.some((d) => d.severity === 'error')) return { diagnostics: diags }

  return {
    schema: {
      type: `#${def.id}`,
      displayName: def.name,
      category: 'subgraph',
      source: 'subgraph',
      body: derivedItems,
      isOutputNode,
      ...(emitsPreviews ? { emitsPreviews: true } : {}),
      ...(mayExpandGraph ? { mayExpandGraph: true } : {}),
    },
    diagnostics: diags,
  }
}
