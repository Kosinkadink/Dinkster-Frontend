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
import { isNodeBoundaryBinding, type BoundaryBinding, type BoundaryItem, type ConstructBoundaryBinding, type DynamicPortState, type GraphDef, type NodeData, type RegionContract, type RouteBoundaryBinding } from '../format/document.js'
import { isPortEndpoint, portAddressKey, type DynamicMemberId } from '../ids.js'
import { subgraphDefIdOf } from '../invariants.js'
import { rerouteInputTargets } from '../reroute.js'
import { effectiveValueSourceSpec, type EffectiveValueSourceSpec } from '../value-source.js'
import { typesCompatible, typesDirectlyCompatible } from './type-relations.js'
import { buildGraphConnectivity, describedEntries, elabInputsOf, elaborateInterface, EMPTY_CONNECTIVITY, type Connectivity } from './elaborate.js'
import { applyUse, choiceScopeRows, framesNamesOf, keyPosition, memberKeyAt, memberLimitOf, memberRowsOf } from './body.js'
import { canonicalTypeIdOf, inputsOf, scopeRowsOf, typeExprFromTypeId } from './model.js'
import type {
  BodyRow,
  ChoiceSpec,
  DescribedSpec,
  GroupSpec,
  InputSpec,
  NodeSchema,
  OptionRow,
  OuterName,
  OutputSpec,
  TypeChoiceSpec,
  TypeExpr,
} from './model.js'
import { boundaryItems, type BoundaryEntry } from '../format/document.js'

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

export type WidgetTapResolution =
  | { readonly ok: true; readonly input: InputSpec }
  | { readonly ok: false; readonly code: 'boundary.tapMissing' | 'boundary.tapAmbiguous' | 'boundary.tapUnsupported' }

/**
 * Resolve the one field a widget tap reads on a node as the node stands:
 * top level, in a group's member, under the chosen option, or under a
 * plugged type-led pin, by its flattened id.
 */
export function resolveWidgetTap(
  schema: NodeSchema,
  node: Pick<NodeData, 'values' | 'dynamic' | 'additionalInputs'>,
  tap: string,
  connectivity: Connectivity = EMPTY_CONNECTIVITY,
): WidgetTapResolution {
  const matches = elabInputsOf(elaborateInterface(schema, node, connectivity, { promoteGhosts: false }))
    .filter((candidate) => candidate.address.port === tap)
  if (matches.length !== 1) {
    return { ok: false, code: matches.length === 0 ? 'boundary.tapMissing' : 'boundary.tapAmbiguous' }
  }
  const input = matches[0]!.spec
  return input.widget !== undefined && input.forceInput !== true
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
      if (raw.kind === 'row' || raw.kind === 'note' || raw.kind === 'editor' || raw.kind === 'button' || raw.kind === 'section') continue
      let row: BodyRow
      if (raw.kind === 'use') {
        const base = shared?.get(raw.id)
        if (base === undefined) continue
        row = applyUse(base, raw)
      } else row = raw
      if (row.kind === 'row' || row.kind === 'section' || row.kind === 'note' || row.kind === 'editor' || row.kind === 'button' || row.id !== seg) continue
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
            found = row.variants === undefined && binding.kind !== 'construct'
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
// Whole constructs on a subgraph node
// ---------------------------------------------------------------------------

/**
 * The members a definition's inner node holds in a group the subgraph node
 * shows whole, and the first position past them. Those members stay inside
 * the definition; each subgraph node's own members come after them.
 */
export function interiorMembersOf(group: GroupSpec, state: DynamicPortState | undefined): { readonly members: readonly string[]; readonly next: number } {
  if (typeof group.grows !== 'string') return { members: [], next: 0 }
  const members = state?.members ?? []
  if (group.keys.kind === 'named') return { members, next: 0 }
  const keys = group.keys
  return { members, next: Math.max(state?.seq ?? 0, 0, ...members.map((key) => (keyPosition(keys, key) ?? -1) + 1)) }
}

/**
 * The inner node's key for a member a subgraph node owns: a numbered key
 * moves past the definition's own members, a named key is the same name (the
 * subgraph node is offered only the names the definition leaves free), and a
 * counted member is its position on both.
 */
export function innerMemberKey(group: GroupSpec, interior: { readonly next: number }, key: string): string | undefined {
  if (typeof group.grows !== 'string' || group.keys.kind === 'named') return key
  const position = keyPosition(group.keys, key)
  return position === undefined ? undefined : memberKeyAt(group.keys, interior.next + position)
}

/** The subgraph node's key for an inner member: undefined for a member the definition owns. */
export function outerMemberKey(group: GroupSpec, interior: { readonly members: readonly string[]; readonly next: number }, key: string): string | undefined {
  if (typeof group.grows !== 'string') return key
  if (group.keys.kind === 'named') return interior.members.includes(key) ? undefined : key
  const position = keyPosition(group.keys, key)
  return position === undefined || position < interior.next ? undefined : memberKeyAt(group.keys, position - interior.next)
}

/** The row a construct route reaches. */
export function constructRowOf(route: BoundaryRoute): GroupSpec | ChoiceSpec | TypeChoiceSpec | DescribedSpec | undefined {
  if (route.terminal.kind === 'family') return route.terminal.declaring
  if (route.terminal.kind === 'construct') return route.terminal.row
  return undefined
}

/** Whether rows hold a field or an input: a construct of outputs only sits among the outputs. */
function holdsInput(list: readonly OptionRow[]): boolean {
  return scopeRowsOf(list).some((entry) =>
    entry.kind === 'input' || entry.kind === 'choice' || entry.kind === 'typeChoice' || entry.kind === 'use' ||
    (entry.kind === 'described' && entry.kinds.some((kind) => kind.kind === 'input')) ||
    (entry.kind === 'group' && holdsInput(memberRowsOf(entry))))
}

/** A construct a row sits in, as a subgraph can show it whole. */
export interface EnclosingConstruct {
  readonly path: string
  readonly kind: 'group' | 'choice' | 'typeChoice' | 'described'
  readonly label: string
  /** Where it sits among a subgraph node's rows: a group of outputs only is an output. */
  readonly side: 'inputs' | 'outputs'
}

/**
 * The constructs a row is in, outermost first, the row itself included when
 * it is one: what "Show on subgraph node" offers to show whole from it.
 */
export function constructsAround(schema: NodeSchema, port: string): readonly EnclosingConstruct[] {
  const found: EnclosingConstruct[] = []
  const segs = port.split('.')
  let rows: readonly OptionRow[] = schema.body
  let prefix = ''
  for (let index = 0; index < segs.length; index++) {
    const row = rowById(rows, segs[index]!)
    if (row === undefined) break
    const full = `${prefix}${row.id}`
    if (row.kind === 'group' || row.kind === 'choice' || row.kind === 'typeChoice' || row.kind === 'described') {
      const label = typeof row.displayName === 'string' && row.displayName !== '' ? row.displayName : row.id
      found.push({ path: full, kind: row.kind, label, side: holdsInput([row]) ? 'inputs' : 'outputs' })
    }
    if (row.kind === 'group') {
      rows = memberRowsOf(row)
      prefix = `${full}.${segs[++index]}.`
    } else if (row.kind === 'choice') {
      rows = choiceScopeRows(row)
      prefix = `${full}.`
    } else if (row.kind === 'typeChoice') {
      rows = [...row.rows, ...(row.variants ?? []).flatMap((variant) => variant.rows)]
      prefix = `${full}.`
    } else break
  }
  return found
}

/** Find a row of one scope by id, looking through layout boxes. */
const rowById = (rows: readonly OptionRow[], id: string): Exclude<BodyRow, { kind: 'row' }> | undefined =>
  scopeRowsOf(rows).find((row): row is Exclude<BodyRow, { kind: 'row' }> => row.kind !== 'use' && row.kind !== 'row' && row.id === id)

/**
 * The scopes around a row, outermost first, with each scope's flattened
 * prefix: what a formula inside that row reads besides the row's own scope.
 */
function scopesAround(body: readonly BodyRow[], path: string): readonly { readonly rows: readonly OptionRow[]; readonly prefix: string }[] {
  const frames: { rows: readonly OptionRow[]; prefix: string }[] = [{ rows: body, prefix: '' }]
  const segs = path.split('.')
  let rows: readonly OptionRow[] = body
  let prefix = ''
  for (let index = 0; index < segs.length - 1; index++) {
    const row = rowById(rows, segs[index]!)
    if (row === undefined) break
    const full = `${prefix}${row.id}`
    if (row.kind === 'group') {
      rows = memberRowsOf(row)
      prefix = `${full}.${segs[++index]}.`
    } else if (row.kind === 'choice') {
      rows = choiceScopeRows(row)
      prefix = `${full}.`
    } else if (row.kind === 'typeChoice') {
      rows = [...row.rows, ...(row.variants ?? []).flatMap((variant) => variant.rows)]
      prefix = `${full}.`
    } else break
    frames.push({ rows, prefix })
  }
  return frames
}

/** Each row's own default value, as a formula reads it with nothing stored. */
const ownDefaultOf = (row: Exclude<BodyRow, { kind: 'row' }> | undefined, stored: DynamicPortState | undefined): unknown => {
  if (row === undefined) return undefined
  if (row.kind === 'input') return row.widget?.default ?? row.ext?.['default']
  if (row.kind === 'state') return row.default
  if (row.kind === 'choice') return stored?.selected ?? (row.required ? row.default ?? row.options[0]?.key : null)
  return undefined
}

/** Name every unbound type variable inside a construct by its inner node. */
function freshenRow<T extends OptionRow>(row: T, nodeId: string, bindings: ReadonlyMap<string, TypeExpr>): T {
  const type = (t: TypeExpr): TypeExpr => freshenType(t, nodeId, bindings)
  const rows = <R extends OptionRow>(list: readonly R[]): R[] => list.map((item) => freshenRow(item, nodeId, bindings))
  const r = row as OptionRow
  switch (r.kind) {
    case 'input':
    case 'output':
    case 'state':
      return { ...r, type: type(r.type) } as unknown as T
    case 'section':
    case 'row':
      return { ...r, rows: rows(r.rows) } as unknown as T
    case 'group':
      return {
        ...r,
        ...(r.value !== undefined ? { value: freshenRow(r.value, nodeId, bindings) } : {}),
        ...(r.member !== undefined ? { member: rows(r.member) } : {}),
      } as unknown as T
    case 'choice':
      return { ...r, shared: rows(r.shared), options: r.options.map((option) => ({ ...option, rows: rows(option.rows) })) } as unknown as T
    case 'typeChoice':
      return {
        ...r,
        rows: rows(r.rows),
        ...(r.type !== undefined ? { type: type(r.type) } : {}),
        ...(r.variants !== undefined ? { variants: r.variants.map((variant) => ({ ...variant, type: type(variant.type), rows: rows(variant.rows) })) } : {}),
      } as unknown as T
    case 'described':
      return { ...r, kinds: r.kinds.map((kind) => ({ ...kind, type: type(kind.type) })) } as unknown as T
    default:
      return row
  }
}

/**
 * Start a construct's fields where the definition's inner node holds them:
 * a stored value becomes the default of its field, and a stored option the
 * default of its choice. Members of a group stay inside the definition.
 */
function withStoredDefaults<T extends OptionRow>(row: T, prefix: string, node: NodeData): T {
  const values = node.values
  const under = <R extends OptionRow>(list: readonly R[], at: string): R[] => list.map((item) => withStoredDefaults(item, at, node))
  const r = row as OptionRow
  switch (r.kind) {
    case 'input': {
      const path = prefix + r.id
      if (!Object.hasOwn(values, path)) return row
      return (r.widget !== undefined
        ? { ...r, widget: { ...r.widget, default: values[path] } }
        : { ...r, ext: { ...r.ext, default: values[path] } }) as unknown as T
    }
    case 'use': {
      const path = prefix + r.id
      return (Object.hasOwn(values, path) ? { ...r, default: values[path] } as unknown as T : row)
    }
    case 'section':
    case 'row':
      return { ...r, rows: under(r.rows, prefix) } as unknown as T
    case 'choice': {
      const path = prefix + r.id
      const selected = node.dynamic?.[path]?.selected
      const keyed = selected !== undefined && r.options.some((option) => option.key === selected) ? { default: selected } : {}
      return {
        ...r,
        ...keyed,
        shared: under(r.shared, `${path}.`),
        options: r.options.map((option) => ({ ...option, rows: under(option.rows, `${path}.`) })),
      } as unknown as T
    }
    case 'typeChoice': {
      const path = prefix + r.id
      const selected = node.dynamic?.[path]?.selected
      return {
        ...r,
        ...(selected !== undefined && r.variants?.some((variant) => variant.key === selected) ? { default: selected } : {}),
        rows: under(r.rows, `${path}.`),
        ...(r.variants !== undefined ? { variants: r.variants.map((variant) => ({ ...variant, rows: under(variant.rows, `${path}.`) })) } : {}),
      } as unknown as T
    }
    case 'described': {
      const path = prefix + r.id
      return (Object.hasOwn(values, path) ? { ...r, default: values[path] } as unknown as T : row)
    }
    default:
      return row
  }
}

/** A construct's shape, without its name: two constructs one row may drive must match. */
const constructShapeKey = (row: GroupSpec | ChoiceSpec | TypeChoiceSpec | DescribedSpec): string => {
  const { id: _id, displayName: _name, tooltip: _tooltip, ...shape } = row
  return JSON.stringify(shape)
}

// ---------------------------------------------------------------------------
// Boundary -> NodeSchema derivation
// ---------------------------------------------------------------------------

/**
 * Derive the NodeSchema of a subgraph definition's boundary. Returns
 * diagnostics for every unresolvable binding; the schema is produced only if
 * no error occurred (partial schemas would let bad instances propagate).
 */
/**
 * The subgraph node's body in the order the boundary stores it: each derived
 * row at its item's place, inside the stored sections and lines. A line left
 * with one row draws that row alone.
 */
function arrangedBody(entries: readonly BoundaryEntry[], derived: readonly BodyRow[]): BodyRow[] {
  const byId = new Map(derived.flatMap((row) => 'id' in row && typeof row.id === 'string' ? [[row.id, row] as const] : []))
  const arrange = (rows: readonly BoundaryEntry[]): BodyRow[] => rows.flatMap((entry): BodyRow[] => {
    if (entry.kind === 'section') {
      return [{
        kind: 'section', id: entry.id, rows: arrange(entry.rows) as OptionRow[],
        ...(entry.displayName !== undefined ? { displayName: entry.displayName } : {}),
        ...(entry.collapsedByDefault ? { collapsedByDefault: true } : {}),
        ...(entry.openName === false ? { openName: false as const } : {}),
      }]
    }
    if (entry.kind === 'line') {
      const cells = entry.rows.flatMap((cell) => {
        const row = byId.get(cell.id)
        return row !== undefined ? [row] : []
      })
      return cells.length > 1 ? [{ kind: 'row', rows: cells as InputSpec[] }] : cells
    }
    const row = byId.get(entry.id)
    if (row === undefined) return []
    return [entry.kind === 'output' && entry.ownRow && row.kind === 'output' ? { ...row, ownRow: true } : row]
  })
  return arrange(entries)
}

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
  let connectivityOf: ReturnType<typeof buildGraphConnectivity> | undefined

  if (!graph.boundary) {
    fail('boundary.missing', `graph definition has no boundary (root graphs cannot be instanced)`)
    return { diagnostics: diags }
  }

  const inputs = boundaryItems(graph.boundary, 'inputs').map((item): BoundaryItem => {
    const bindings = [item.binds, ...(item.alsoBinds ?? [])]
    if (bindings.every((binding) => binding.viaReroute === undefined)) return item
    const expanded = bindings.flatMap((binding): BoundaryBinding[] => {
      if (binding.viaReroute === undefined) return [binding]
      const targets = rerouteInputTargets(graph, binding.viaReroute)
      if (binding.kind !== 'port' || !targets?.length ||
          !targets.some((target) => target.node === binding.node && portAddressKey(target.port) === portAddressKey(binding.port)) ||
          Object.values(graph.links).some((link) => 'reroute' in link.to && link.to.reroute === binding.viaReroute)) {
        fail('boundary.reroute', `boundary input '${item.id}' has an invalid or internally driven junction attachment`)
        return []
      }
      const { viaReroute: _via, ...authority } = binding
      return [authority, ...targets.filter((target) => target.node !== binding.node || portAddressKey(target.port) !== portAddressKey(binding.port))
        .map((target) => ({ kind: 'port' as const, ...target }))]
    })
    const { alsoBinds: _also, ...single } = item
    return { ...single, binds: expanded[0] ?? item.binds, ...(expanded.length > 1 ? { alsoBinds: expanded.slice(1) } : {}) }
  })
  if (diags.length) return { diagnostics: diags }
  if (boundaryItems(graph.boundary, 'outputs').some((item) => item.binds.viaReroute !== undefined)) {
    fail('boundary.rerouteSide', 'junction attachments are input-side only')
    return { diagnostics: diags }
  }
  const def = { ...graph, boundary: { ...graph.boundary, inputs } }


  const items: BodyRow[] = []
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
  const isInternallyConnected = (b: RouteBoundaryBinding, port: string): boolean => {
    const key = portAddressKey(port)
    for (const link of Object.values(def.links)) {
      if (isPortEndpoint(link.to) && link.to.node === b.node && portAddressKey(link.to.port) === key) return true
    }
    for (const net of Object.values(def.nets)) {
      if (net.sinks.some((s) => s.node === b.node && portAddressKey(s.port) === key)) return true
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
    if (binds.kind === 'port' && route.terminal.kind !== 'port') {
      fail('boundary.familyBind', `${describe} binds '${binds.port}', which is a group, a choice, a type choice or a described row; a whole construct is shown with a construct binding`)
      return undefined
    }
    if (binds.kind === 'construct' && route.terminal.kind === 'port') {
      fail('boundary.notAConstruct', `${describe} shows '${binds.port}' whole, but it is a single row; a single row is shown with a port binding`)
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

  /** Fan-out duplicate key: full target address (node, port). */
  const targetKeyOf = (b: RouteBoundaryBinding): string => JSON.stringify([b.node, b.port])

  const displayNameOf = (
    item: BoundaryItem,
    inner: InputSpec | OutputSpec,
  ): { displayName: string } => ({
    displayName: item.displayName ?? inner.displayName ?? generatedBoundaryLabel(item),
  })

  // One owner per construct: a construct shown whole owns every row in it.
  const constructOwners: { readonly node: string; readonly path: string; readonly item: string }[] = []
  const shownRows = new Map<string, string>()
  const everyItem = [...boundaryItems(def.boundary, 'inputs'), ...boundaryItems(def.boundary, 'outputs')]
  for (const item of everyItem) {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (binding.kind === 'port' && !shownRows.has(JSON.stringify([binding.node, binding.port]))) shownRows.set(JSON.stringify([binding.node, binding.port]), item.id)
      if (binding.kind !== 'construct') continue
      const owner = constructOwners.find((other) => other.node === binding.node && other.path === binding.port)
      if (owner !== undefined) fail('boundary.constructConflict', `boundary items '${owner.item}' and '${item.id}' both show '${binding.port}' whole`)
      else constructOwners.push({ node: binding.node, path: binding.port, item: item.id })
    }
  }
  for (const item of everyItem) {
    for (const binding of [item.binds, ...(item.alsoBinds ?? [])]) {
      if (binding.kind !== 'port' && binding.kind !== 'construct') continue
      const owner = constructOwners.find((other) => other.node === binding.node && other.item !== item.id && binding.port.startsWith(`${other.path}.`))
      if (owner !== undefined) fail('boundary.constructOwned', `boundary item '${item.id}' shows '${binding.port}', which is already shown through '${owner.item}'`)
    }
  }
  if (region !== undefined && constructOwners.length > 0) fail('boundary.constructRegion', 'a repeated region shows single rows only, not a whole group, choice, type choice or described row')
  if (diags.length) return { diagnostics: diags }

  /**
   * The row a subgraph node shows for a whole construct: the inner row with
   * its types named by its inner node, its fields starting where the
   * definition holds them, a group's members past the definition's own, and
   * the inner node's scope for its formulas.
   */
  const constructRow = (item: BoundaryItem, side: 'input' | 'output'): BodyRow | undefined => {
    const binds = item.binds as ConstructBoundaryBinding
    const resolved = routeFor(item, side)
    if (!resolved) return undefined
    const { node, route } = resolved
    const row = constructRowOf(route)!
    if (side === 'output' && holdsInput([row])) {
      fail('boundary.sideMismatch', `boundary output '${item.id}' shows '${binds.port}', which holds a field or an input; it belongs among the inputs`)
      return undefined
    }
    const path = binds.port as string
    const prefix = path.slice(0, path.length - row.id.length)
    for (const [index, other] of (item.alsoBinds ?? []).entries()) {
      const describe = `boundary input '${item.id}' fan-out target [${index}]`
      if (other.kind !== 'construct') {
        fail('boundary.fanoutKind', `${describe} must be a construct like the row it shares`)
        return undefined
      }
      const target = routeForBinding(other, describe, side)
      if (!target) return undefined
      const otherRow = constructRowOf(target.route)
      if (otherRow === undefined || constructShapeKey(otherRow) !== constructShapeKey(row)) {
        fail('boundary.constructShapeMismatch', `${describe}: '${other.port}' does not have the same rows, options, keys and growth as '${binds.port}'`)
        return undefined
      }
    }
    let derived: BodyRow = withStoredDefaults(freshenRow(row, binds.node, typeBindingsFor(node)), prefix, node)
    if (derived.kind === 'group' && row.kind === 'group') {
      const interior = interiorMembersOf(row, node.dynamic?.[path])
      const count = interior.members.length
      const limit = memberLimitOf(row)
      if (count > limit) {
        fail('boundary.familyOverCap', `boundary ${side} '${item.id}': the definition holds ${count} members of '${path}' but the group holds at most ${limit}`)
        return undefined
      }
      derived = {
        ...derived,
        minMembers: Math.max(0, derived.minMembers - count),
        // Only a declared maximum is carried: it is the number a header shows.
        ...(row.maxMembers !== undefined ? { maxMembers: limit - count } : {}),
        ...(derived.keys.kind === 'named' ? { keys: { kind: 'named' as const, names: derived.keys.names.filter((name) => !interior.members.includes(name)) } } : {}),
        // Members inside count through every level: an outer face numbers on from all of them.
        ...(count > 0 ? { interiorMembers: (row.interiorMembers ?? 0) + count } : {}),
      }
    }
    const schema = resolveNode(node)!
    const frames = scopesAround(schema.body, path).map((frame) => {
      const names: Record<string, OuterName> = {}
      for (const name of framesNamesOf([frame.rows]).names.keys()) {
        const flat = frame.prefix + name
        const shown = flat === path ? item.id : shownRows.get(JSON.stringify([binds.node, flat]))
        if (shown !== undefined) {
          names[name] = { row: shown }
          continue
        }
        const value = Object.hasOwn(node.values, flat)
          ? node.values[flat]
          : ownDefaultOf(name.includes('.') ? undefined : rowById(frame.rows, name), node.dynamic?.[flat])
        if (value !== undefined) names[name] = { value, ...(isInternallyConnected(binds, flat) ? { linked: true as const } : {}) }
      }
      return { rows: frame.rows, names }
    })
    return {
      ...derived,
      id: item.id,
      ...(item.displayName !== undefined ? { displayName: item.displayName } : {}),
      outer: { frames },
    } as BodyRow
  }

  const valueSourceInputs = new Map<string, string>()
  for (const item of boundaryItems(def.boundary, 'inputs')) {
    if (!checkId(item)) continue
    if (item.binds.kind === 'construct') {
      const row = constructRow(item, 'input')
      if (row !== undefined) items.push(row)
      continue
    }
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
    // The subgraph input takes a whole list only when every target does;
    // one single-value target would receive the list unmapped.
    let acceptsList = inner.acceptsList === true
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
          fail('boundary.duplicateBind', `${describe} repeats target '${b.node}/${b.port}'`)
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
        if (targetSlot.acceptsList !== true) acceptsList = false
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
      ...(acceptsList ? { acceptsList: true as const } : {}),
      ...(promotedWidget !== undefined
        ? { widget: promotedWidget }
        : inner.widget !== undefined
          ? { forceInput: true }
          : {}),
      ...(inner.lazy !== undefined ? { lazy: inner.lazy } : {}),
    })
  }

  for (const item of boundaryItems(def.boundary, 'outputs')) {
    if (!checkId(item)) continue
    if (item.binds.kind === 'construct') {
      if (item.alsoBinds !== undefined) {
        fail('boundary.fanoutOnOutput', `boundary output '${item.id}': 'alsoBinds' is invalid on outputs (an output has exactly one source)`)
        continue
      }
      const row = constructRow(item, 'output')
      if (row !== undefined) items.push(row)
      continue
    }
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
      const resolvedTap = resolveWidgetTap(schema, node, binding.tap, (connectivityOf ??= buildGraphConnectivity(graph))(node.id))
      if (!resolvedTap.ok) {
        fail(
          resolvedTap.code,
          resolvedTap.code === 'boundary.tapUnsupported'
            ? `boundary output '${item.id}' must bind one widget-backed input`
            : `boundary output '${item.id}' widget tap '${binding.tap}' resolves to ${resolvedTap.code === 'boundary.tapMissing' ? 0 : 'multiple'} inputs`,
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
    const items = derivedItems as (InputSpec | OutputSpec)[]
    if (!boundaryItems(def.boundary, 'outputs').some((output) => output.id !== region.continueOutput) && !isOutputNode) {
      fail('doc.region.outputRequired', 'region requires an exported boundary output or a declared output node')
    }
    const elements = new Set(region.elementPorts ?? [])
    const state = new Set(region.statePorts ?? [])
    const outputRoles = region.outputRoles ?? {}
    const inputRoleLabels = regionBoundaryLabels(boundaryItems(def.boundary, 'inputs') ?? [], region, 'inputs')
    const outputRoleLabels = regionBoundaryLabels(boundaryItems(def.boundary, 'outputs') ?? [], region, 'outputs')
    const explicitInputLabels = new Set((boundaryItems(def.boundary, 'inputs') ?? []).filter((item) => item.displayName !== undefined).map((item) => item.id))
    const explicitOutputLabels = new Set((boundaryItems(def.boundary, 'outputs') ?? []).filter((item) => item.displayName !== undefined).map((item) => item.id))
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
      body: arrangedBody(def.boundary?.body ?? [], derivedItems),
      isOutputNode,
      ...(emitsPreviews ? { emitsPreviews: true } : {}),
      ...(mayExpandGraph ? { mayExpandGraph: true } : {}),
    },
    diagnostics: diags,
  }
}
