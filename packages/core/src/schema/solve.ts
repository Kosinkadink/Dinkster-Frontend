/**
 * Type constraint solving is stage 2 of the derived-state pipeline.
 *
 * Solves MatchType variables over one graph definition's ELABORATED
 * topology. Strictly advisory and strictly downstream: results color pins
 * and noodles, badge conflicts, and refine drop-target highlighting - they
 * are NEVER written back into the document or schema, and NEVER feed
 * elaboration (the anti-oscillation DAG: document -> elaboration -> solving
 * -> rendering). Conflicting links are marked, not auto-disconnected: a
 * stale document must stay loadable and fixable.
 *
 * Semantics (matching backend V3 validation):
 * - '*' (wildcard) imposes NO constraint. It is not a type variable; it
 *   never captures and never propagates ("no permanent wildcard capture").
 * - Concrete/union types check per edge by atom-set overlap. A union
 *   producer ('IMAGE,LATENT') can feed an IMAGE consumer and a LATENT
 *   consumer simultaneously - unions are never collapsed by solving.
 * - MatchType templates are variables freshened PER NODE OCCURRENCE:
 *   variable identity is (nodeId, templateId). Two instances of one
 *   (subgraph) schema resolve independently. derive-boundary namespaces
 *   inner templates per inner node ('n0:T'); prefixing the instance node id
 *   here compounds to per-occurrence freshness through nesting.
 * - A variable's domain starts at its declared allowedTypes (unrestricted
 *   when absent) and is intersected by every atom-typed edge or authoritative
 *   DynamicSlot selection; var-var edges merge variables (union-find) and
 *   intersect domains. Equality among ports sharing a templateId within one
 *   node is free: same variable.
 * - Resolution: 'resolved' (constrained to one atom), 'ambiguous'
 *   (constrained, several atoms remain - render as the union),
 *   'conflict' (empty domain - every contributing edge is marked and one
 *   diagnostic anchors to a contributing link), or 'unconstrained' (no
 *   concrete constraint touches it - render the declared expression).
 *   Conflict blame is the full contributing edge set, deterministically -
 *   never "whichever link happened to come last".
 *
 * Edges are the type-carrying adjacencies of the definition:
 * - links whose `to` is a node input, with `from` traced upstream through
 *   reroute chains to the real producer (structural feeds into reroutes
 *   carry no constraint themselves; undriven/cyclic chains constrain
 *   nothing);
 * - widget output taps use the widget input's declared type when its value is
 *   local, or trace through that input when another producer drives it;
 * - a selector OUTPUT expands to EVERY candidate branch's producer (policy
 *   can change at any time, so all branches must stay compatible); an
 *   unconsumed selector constrains nothing - it is a type-agnostic
 *   passthrough like a reroute, never a unifier of its own branches;
 * - named-net (source, sink) pairs;
 * - value-source feeds carry values, not types: no constraint.
 *
 * Complexity: O(nodes + elaborated ports + edges * alpha) per definition -
 * one elaboration pass per node, one union-find over edges.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import type { GraphDef, LinkData, NodeData } from '../format/document.js'
import { asPortId, isPortEndpoint, type LinkId, type NodeId, type PortRef } from '../ids.js'
import { buildRerouteIndex, traceEndpointAll } from '../reroute.js'
import { assetCoercible, atomNamesOf, coercionTargetsOf, typesCompatible } from './type-relations.js'
import type { SchemaResolver } from './derive-boundary.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elabOutputsOf,
  elaborateInterface,
  type Connectivity,
  type ElaborateOptions,
} from './elaborate.js'
import { canonicalTypeIdOf, cardinalityOf, effectiveAbsentPolicy, parseAssetTypeId, parseListTypeId, parseStreamTypeId, typeExprFromTypeId, type NodeSchema, type NodeSelectorSpec, type TypeExpr } from './model.js'

/** Every variable occurring in `t`, including inside list/asset elements. */
function* nestedVariablesOf(t: TypeExpr): Generator<TypeExpr & { kind: 'variable' }> {
  if (t.kind === 'variable') yield t
  else if (t.kind === 'tuple') for (const element of t.elements) yield* nestedVariablesOf(element)
  else if (t.kind === 'tuple_element' && t.element !== undefined) yield* nestedVariablesOf(t.element)
  else if (t.kind === 'list' || t.kind === 'asset' || t.kind === 'stream') yield* nestedVariablesOf(t.element)
}

const substituteTypeBindings = (
  type: TypeExpr,
  bindings: ReadonlyMap<string, TypeExpr>,
): TypeExpr => {
  if (type.kind === 'variable') return bindings.get(type.templateId) ?? type
  if (type.kind === 'tuple') return { ...type, elements: type.elements.map((element) => substituteTypeBindings(element, bindings)) }
  if (type.kind === 'tuple_element') return type.element === undefined ? type : { ...type, element: substituteTypeBindings(type.element, bindings) }
  if (type.kind !== 'list' && type.kind !== 'asset' && type.kind !== 'stream') return type
  const element = substituteTypeBindings(type.element, bindings)
  return element === type.element ? type : { kind: type.kind, element }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type VarResolution =
  /** No concrete constraint binds it; render the declared expression. */
  | { readonly kind: 'unconstrained' }
  | { readonly kind: 'resolved'; readonly name: string }
  /** Valid but not pinned to one atom; render as the union of `names`. */
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] }
  | { readonly kind: 'conflict' }

/**
 * Per-edge verdict. 'unknown' means the solver could not type an endpoint
 * (unresolvable schema, port not currently elaborated) - structurally the
 * validator's business, not a type mismatch.
 */
export type EdgeVerdict = 'ok' | 'mismatch' | 'unknown'

/** Key for a named-net sink's verdict: the net id plus sink ordinal. */
export const netSinkKey = (netId: string, sinkIndex: number): string => `${netId}[${sinkIndex}]`

export interface SolveResult {
  /** Resolution of variable `templateId` as it occurs on node `node`. */
  resolutionOf(node: NodeId, templateId: string): VarResolution
  /**
   * Display type of an elaborated port with solved variables substituted
   * (resolved -> concrete, ambiguous -> union, otherwise the declared
   * expression). Undefined when the node/port is not elaborated.
   */
  portTypeOf(node: NodeId, side: 'input' | 'output', port: string): TypeExpr | undefined
  /** Verdicts for consumer-delivering links (structural feeds absent). */
  readonly linkVerdicts: ReadonlyMap<LinkId, EdgeVerdict>
  /** Verdicts per named-net sink, keyed by netSinkKey(). */
  readonly netSinkVerdicts: ReadonlyMap<string, EdgeVerdict>
  readonly diagnostics: readonly Diagnostic[]
}

// ---------------------------------------------------------------------------
// Variable store (union-find with domain intersection)
// ---------------------------------------------------------------------------

type EdgeSource =
  | { readonly kind: 'link'; readonly id: LinkId }
  | { readonly kind: 'net'; readonly id: string; readonly sinkIndex: number }
  | { readonly kind: 'projectedInput'; readonly index: number; readonly to: PortRef; readonly label?: string }
type SlotBindingSource = { readonly ref: PortRef; readonly variant: string }

type VarKey = string | symbol
type VarOwner =
  | { readonly kind: 'node'; readonly node: NodeId; readonly templateId: string }
  | { readonly kind: 'projected'; readonly to: PortRef; readonly templateId: string }

interface VarRecord {
  parent: VarKey
  readonly owner: VarOwner
  rank: number
  /** Remaining atom candidates; undefined = unrestricted. */
  domain?: ReadonlySet<string>
  /** True once an edge or persisted DynamicSlot selection constrained this class. */
  constrained: boolean
  /** Contributing edges, for deterministic conflict blame. */
  sources: EdgeSource[]
  /** Authoritative stored slot choices constraining this class. */
  slotBindings: SlotBindingSource[]
}

const varKeyOf = (node: NodeId, templateId: string): string => `${node.length}:${node}${templateId}`

class VarStore {
  private readonly vars = new Map<VarKey, VarRecord>()

  ensure(key: VarKey, declared: TypeExpr & { kind: 'variable' }, owner: VarOwner): void {
    const existing = this.vars.get(key)
    const declaredAtoms = atomNamesOf(declared)
    if (!existing) {
      this.vars.set(key, {
        parent: key,
        owner,
        rank: 0,
        ...(declaredAtoms !== undefined ? { domain: new Set(declaredAtoms) } : {}),
        constrained: false,
        sources: [],
        slotBindings: [],
      })
      return
    }
    // Multiple declarations of one template on one node must agree; if a
    // schema declares differing allowed sets, the variable honors all of
    // them (intersection) - declaration alone never marks it constrained.
    if (declaredAtoms !== undefined) {
      const root = this.find(key)
      root.domain = intersect(root.domain, declaredAtoms)
    }
  }

  find(key: VarKey): VarRecord {
    let rec = this.vars.get(key)
    if (!rec) throw new Error(`unregistered type variable '${String(key)}'`)
    // Path halving.
    while (rec.parent !== key) {
      const parent: VarRecord = this.vars.get(rec.parent)!
      rec.parent = parent.parent
      key = rec.parent
      rec = this.vars.get(key)!
    }
    return rec
  }

  constrain(key: VarKey, atoms: readonly string[], source: EdgeSource): void {
    const root = this.find(key)
    root.domain = intersect(root.domain, atoms)
    root.constrained = true
    root.sources.push(source)
  }

  bind(key: VarKey, atom: string, source: SlotBindingSource): void {
    const root = this.find(key)
    root.domain = intersect(root.domain, [atom])
    root.constrained = true
    root.slotBindings.push(source)
  }

  merge(a: VarKey, b: VarKey, source: EdgeSource): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) {
      ra.sources.push(source)
      return
    }
    const [winner, loser] = ra.rank >= rb.rank ? [ra, rb] : [rb, ra]
    if (winner.rank === loser.rank) winner.rank++
    loser.parent = winner.parent
    if (loser.domain !== undefined) winner.domain = intersect(winner.domain, [...loser.domain])
    winner.constrained = winner.constrained || loser.constrained
    winner.sources.push(...loser.sources, source)
    winner.slotBindings.push(...loser.slotBindings)
  }

  roots(): IterableIterator<VarRecord> {
    const seen = new Set<VarRecord>()
    for (const key of this.vars.keys()) seen.add(this.find(key))
    return seen.values()
  }

  resolutionOf(key: VarKey): VarResolution {
    if (!this.vars.has(key)) return { kind: 'unconstrained' }
    return resolutionOfRoot(this.find(key))
  }
}

const intersect = (
  domain: ReadonlySet<string> | undefined,
  atoms: readonly string[],
): ReadonlySet<string> => {
  if (domain === undefined) return new Set(atoms)
  return new Set(atoms.filter((a) => domain.has(a)))
}

const resolutionOfRoot = (root: VarRecord): VarResolution => {
  if (root.domain !== undefined && root.domain.size === 0) return { kind: 'conflict' }
  if (!root.constrained) return { kind: 'unconstrained' }
  const names = [...(root.domain ?? [])]
  if (names.length === 1) return { kind: 'resolved', name: names[0]! }
  if (names.length > 1) return { kind: 'ambiguous', names }
  // A constrained class without a finite domain cannot resolve to an atom.
  return { kind: 'unconstrained' }
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

export interface SolveOptions extends ElaborateOptions {
  /** Observe node, elaborated-port and type-pair visits without timing the host. */
  readonly onWork?: (kind: 'node' | 'port' | 'constraint') => void
  /** Resolve a concrete node when its schema depends on occurrence-local data. */
  readonly resolveNode?: (node: NodeData) => NodeSchema | undefined
  /** Optional occurrence-aware connectivity used by scene projections. */
  readonly connectivityOf?: (nodeId: NodeId) => Connectivity
  /** Producer types projected through a parent occurrence input. */
  readonly projectedInputs?: readonly {
    readonly type: TypeExpr
    readonly to: PortRef
    readonly label?: string
    /** Shared identity for multiple edges from one projected producer node. */
    readonly variableSource?: symbol
  }[]
}

interface PortTypes {
  readonly inputs: ReadonlyMap<string, TypeExpr>
  readonly outputs: ReadonlyMap<string, TypeExpr>
}

/**
 * Solve one graph definition's types. Pure and deterministic; elaboration
 * diagnostics produced internally are NOT re-reported (callers elaborate for
 * rendering anyway) - only solver diagnostics come back.
 */
export function solveGraphTypes(
  def: GraphDef,
  resolve: SchemaResolver,
  options: SolveOptions = {},
): SolveResult {
  const diagnostics: Diagnostic[] = []
  const linkVerdicts = new Map<LinkId, EdgeVerdict>()
  const netSinkVerdicts = new Map<string, EdgeVerdict>()
  const vars = new VarStore()

  // -- 1. Elaborate every resolvable node once; index port types by flattened id.
  // Absence metadata rides along: which outputs may deliberately emit no
  // value, and which inputs declare on_absent='fail' - the edge walk below
  // warns where they meet (legal, but worth surfacing: solve.maybeAbsent).
  const connectivityOf = options.connectivityOf ?? buildGraphConnectivity(def)
  const portTypes = new Map<NodeId, PortTypes>()
  const specializedSlots: {
    node: NodeId
    ref: PortRef
    selectedType: TypeExpr
  }[] = []
  const optionalOutputs = new Map<NodeId, Set<string>>()
  const failInputs = new Map<NodeId, Set<string>>()
  const wholeListInputs = new Map<NodeId, Set<string>>()
  const inputLabels = new Map<NodeId, Map<string, string>>()
  const knownOutputs = new Map<NodeId, Set<string>>()
  const selectors = new Map<NodeId, NodeSelectorSpec>()
  for (const node of Object.values(def.nodes) as NodeData[]) {
    options.onWork?.('node')
    const schema = options.resolveNode === undefined
      ? resolve(node.type)
      : options.resolveNode(node)
    if (!schema) continue // structural validators own "unresolvable type"
    const e = elaborateInterface(schema, node, connectivityOf(node.id), options)
    const inputs = new Map<string, TypeExpr>()
    const outputs = new Map<string, TypeExpr>()
    const slotBindings: {
      readonly templateId: string
      readonly type: TypeExpr
      readonly source: SlotBindingSource
    }[] = []
    const labels = new Map<string, string>()
    inputLabels.set(node.id, labels)
    if (schema.selector !== undefined) selectors.set(node.id, schema.selector)
    for (const item of elabInputsOf(e)) {
      options.onWork?.('port')
      const key = item.address.port
      inputs.set(key, item.spec.type)
      labels.set(key, item.spec.displayName ?? item.spec.id)
      if (item.spec.acceptsList) {
        let set = wholeListInputs.get(node.id)
        if (!set) wholeListInputs.set(node.id, (set = new Set()))
        set.add(key)
      }
      if (item.origin.kind === 'slot' && item.origin.selected !== undefined) {
        const selected = item.origin.selected
        const variant = item.origin.variants?.find(
          (candidate) => candidate.key === selected,
        )
        if (variant) {
          const ref = {
            node: node.id,
            port: asPortId(item.address.port),
          }
          specializedSlots.push({
            node: node.id,
            ref,
            selectedType: variant.type,
          })
          if (item.origin.typeTemplateId !== undefined) {
            slotBindings.push({
              templateId: item.origin.typeTemplateId,
              type: variant.type,
              source: { ref, variant: selected },
            })
          }
        }
      }
      if (effectiveAbsentPolicy(item.spec) === 'fail') {
        let set = failInputs.get(node.id)
        if (!set) failInputs.set(node.id, (set = new Set()))
        set.add(key)
      }
    }
    for (const item of elabOutputsOf(e)) {
      options.onWork?.('port')
      const key = item.address.port
      outputs.set(key, item.spec.type)
      if (item.spec.knownValue !== undefined) {
        let set = knownOutputs.get(node.id)
        if (!set) knownOutputs.set(node.id, (set = new Set()))
        set.add(key)
      }
      if (item.spec.optional) {
        let set = optionalOutputs.get(node.id)
        if (!set) optionalOutputs.set(node.id, (set = new Set()))
        set.add(key)
      }
    }
    // Register every variable occurrence (including variables nested inside
    // list elements) so unlinked variables still answer resolutionOf, and
    // multi-declaration domains intersect up front.
    for (const type of [...inputs.values(), ...outputs.values()]) {
      for (const v of nestedVariablesOf(type)) {
        vars.ensure(varKeyOf(node.id, v.templateId), v, { kind: 'node', node: node.id, templateId: v.templateId })
      }
    }
    for (const binding of slotBindings) {
      const key = varKeyOf(node.id, binding.templateId)
      // A count-bound output family may currently have zero members, leaving
      // no elaborated variable occurrence even though the slot still binds it.
      vars.ensure(key, { kind: 'variable', templateId: binding.templateId }, {
        kind: 'node', node: node.id, templateId: binding.templateId,
      })
      const typeId = canonicalTypeIdOf(binding.type)
      if (typeId !== undefined) vars.bind(key, typeId, binding.source)
    }
    if (slotBindings.length > 0) {
      const bindings = new Map(slotBindings.map(({ templateId, type }) => [templateId, type]))
      for (const [key, type] of inputs) inputs.set(key, substituteTypeBindings(type, bindings))
      for (const [key, type] of outputs) outputs.set(key, substituteTypeBindings(type, bindings))
    }
    portTypes.set(node.id, { inputs, outputs })
  }

  const typeAt = (ref: PortRef, side: 'input' | 'output'): TypeExpr | undefined => {
    const entry = portTypes.get(ref.node)
    if (!entry) return undefined
    const key = ref.port
    return (side === 'input' ? entry.inputs : entry.outputs).get(key)
  }

  const substitute = (type: TypeExpr, node: NodeId): TypeExpr => {
    if (type.kind === 'tuple') return { ...type, elements: type.elements.map((element) => substitute(element, node)) }
    if (type.kind === 'tuple_element' && type.element !== undefined) {
      const element = substitute(type.element, node)
      if (element.kind === 'tuple' && typeof type.index === 'number') {
        return element.elements[type.index < 0 ? element.elements.length + type.index : type.index] ?? { ...type, element }
      }
      return { ...type, element }
    }
    if (type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') return { ...type, element: substitute(type.element, node) }
    if (type.kind !== 'variable') return type
    const resolution = vars.resolutionOf(varKeyOf(node, type.templateId))
    if (resolution.kind === 'resolved') return resolution.name === '*' ? { kind: 'wildcard' } : typeExprFromTypeId(resolution.name)
    if (resolution.kind === 'ambiguous') return { kind: 'union', names: resolution.names }
    return type
  }
  const dependentEdges: { fromType: TypeExpr; toType: TypeExpr; from: PortRef; to: PortRef; source: EdgeSource; signature?: string }[] = []
  const hasTuple = (type: TypeExpr): boolean => type.kind === 'tuple' || type.kind === 'tuple_element' ||
    ((type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') && hasTuple(type.element))

  // -- 2. Process type-carrying edges.
  //
  // One source may be constrained SEVERAL times (a link fed by a selector
  // output checks against every candidate branch), so verdicts are
  // sticky-worst: mismatch > unknown > ok. Single-constraint sources behave
  // exactly as before.
  const verdictRank: Record<EdgeVerdict, number> = { ok: 0, unknown: 1, mismatch: 2 }
  const setVerdict = (source: EdgeSource, verdict: EdgeVerdict): void => {
    if (source.kind === 'link') {
      const prev = linkVerdicts.get(source.id)
      if (prev === undefined || verdictRank[verdict] > verdictRank[prev]) linkVerdicts.set(source.id, verdict)
    } else if (source.kind === 'net') {
      const key = netSinkKey(source.id, source.sinkIndex)
      const prev = netSinkVerdicts.get(key)
      if (prev === undefined || verdictRank[verdict] > verdictRank[prev]) netSinkVerdicts.set(key, verdict)
    }
  }

  // Types fed INTO a variable input, kept per node apart from the class
  // domain. The engine binds each node from its own inputs and refuses the
  // run when they disagree; a class conflict that comes only from an
  // allowlist, a stored slot choice or a downstream input stays a warning.
  interface Feed {
    readonly key: VarKey
    readonly to: PortRef
    readonly source: EdgeSource
    /** The atoms a concrete producer brings, or the variable a generic producer passes on. */
    readonly atoms?: readonly string[]
    readonly from?: VarKey
  }
  const feeds: Feed[] = []
  /** Links whose consumer sees several possible producers (selector candidates). */
  const branchingLinks = new Set<LinkId>()

  const admittedInputType = (
    from: TypeExpr | undefined,
    to: PortRef,
    type: TypeExpr | undefined,
  ): TypeExpr | undefined =>
    type !== undefined &&
    type.kind !== 'list' &&
    from !== undefined &&
    cardinalityOf(from) === 'list' &&
    wholeListInputs.get(to.node)?.has(to.port)
      ? { kind: 'list', element: type }
      : type

  const constrain = (
    from: PortRef,
    to: PortRef,
    source: EdgeSource,
    fromSide: 'input' | 'output' = 'output',
  ): void => {
    const fromType = typeAt(from, fromSide)
    const toType = admittedInputType(fromType, to, typeAt(to, 'input'))
    if (fromType !== undefined && toType !== undefined && hasTuple(fromType))
      dependentEdges.push({ fromType, toType, from, to, source })
    if (fromType === undefined || toType === undefined) {
      setVerdict(source, 'unknown')
      const missing = fromType === undefined ? from : to
      if (portTypes.has(missing.node)) {
        // The node elaborated but this port does not currently exist
        // (inactive branch, removed member, renamed schema port).
        diagnostics.push(
          diag('info', 'schema', 'solve.portMissing', `${missing.node}.${missing.port}: connected port is unavailable`, {
            anchor: source.kind === 'link' ? { link: source.id, port: missing } : { port: missing },
          }),
        )
      }
      return
    }

    // Absence advisory (schema wire v3): a maybe-absent producer feeding a
    // fail-policy input is LEGAL - the type verdict is untouched - but worth
    // surfacing before the run fails at runtime. Keyed to the traced REAL
    // producer, so the warning survives reroute chains.
    const fromKey = from.port
    const toKey = to.port
    if (fromSide === 'output' && optionalOutputs.get(from.node)?.has(fromKey) && failInputs.get(to.node)?.has(toKey)) {
      diagnostics.push(
        diag('warning', 'schema', 'solve.maybeAbsent', `${to.node}.${to.port}: required value comes from optional output ${from.node}.${from.port}`, {
          anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
        }),
      )
    }

    unify(fromType, toType, from, to, source)
  }

  /**
   * Structural unification of one edge's endpoint types. Constructor-aware
   * and recursive: closed lists are ordinary atoms (canonical 'list<...>'
   * ids), so atom-set arithmetic handles them with exact identity; recursion
   * happens only when a list carries a variable/wildcard below it (peel the
   * constructor, unify elements). Cardinality is checked STRUCTURALLY first:
   * a definitely-list edge into a definitely-scalar input is an error
   * (mirrors backend 'list-into-scalar'/'scalar-into-list' - no implicit
   * coercion), unlike advisory atom mismatches which stay warnings.
   *
   * Known, deliberate under-constraint: an edge between an OPEN list
   * (`list<V>`) and a bare variable `U` records no domain relation (`U =
   * list<V>` is not representable in flat atom domains). The solver is
   * advisory, so under-constraining is sound - the edge just stays 'ok'.
   *
   * `allowCoercion` is the single-step budget of the engine-side asset
   * coercion (typed assets, wire v12): true on the outer edge call, and set
   * FALSE by every recursion that consumes the step (decode/lift/merge
   * peels), so asset<asset<T>> chains never pass. Peeling a SHARED
   * constructor (list-vs-list, asset-vs-asset) is free and inherits the
   * budget - that is how the elementwise lift works.
   */
  const unify = (
    fromType: TypeExpr,
    toType: TypeExpr,
    from: PortRef,
    to: PortRef,
    source: EdgeSource,
    allowCoercion = true,
    fromVariableKeys?: ReadonlyMap<string, VarKey>,
  ): void => {
    options.onWork?.('constraint')
    if (fromType.kind === 'wildcard' || toType.kind === 'wildcard') {
      setVerdict(source, 'ok') // no constraint, no capture
      return
    }

    if (fromType.kind === 'tuple' && toType.kind === 'tuple') {
      if (fromType.elements.length !== toType.elements.length) {
        setVerdict(source, 'mismatch')
        diagnostics.push(diag('warning', 'schema', 'solve.tupleArity', 'Tuple positions must have the same length.', { anchor: { port: to } }))
      } else {
        fromType.elements.forEach((element, index) => unify(element, toType.elements[index]!, from, to, source, allowCoercion, fromVariableKeys))
      }
      return
    }

    // Structural cardinality gate (variables/wildcards are 'unknown' and pass).
    // The ONE engine-side asset coercion step can legally cross cardinality
    // (decode asset<list<T>> -> list<T>; registry-gated merge
    // list<asset<T>> -> T), so a coercible edge passes the gate. Open
    // structured forms peel structurally with the step consumed; closed
    // forms resolve through the atom vocabulary.
    const cf = cardinalityOf(fromType)
    const ct = cardinalityOf(toType)
    if (cf !== 'unknown' && ct !== 'unknown' && cf !== ct) {
      if (allowCoercion) {
        if (fromType.kind === 'asset') {
          // decode asset<X> -> X (only asset<list<...>> can reach a list
          // destination); recursion is NON-coercing: the step is spent.
          unify(fromType.element, toType, from, to, source, false, fromVariableKeys)
          return
        }
        if (fromType.kind === 'list' && fromType.element.kind === 'asset') {
          // registry-gated merge list<asset<X>> -> scalar X. Maybe-legal
          // here: the merge-provider registry is server-side, so 'ok' means
          // "no frontend-known mismatch" and backend document validation
          // owns the final refusal.
          unify(fromType.element.element, toType, from, to, source, false, fromVariableKeys)
          return
        }
        if (assetCoercible(fromType, toType)) {
          setVerdict(source, 'ok') // closed coercion target is exact; no domain capture needed
          return
        }
      }
      setVerdict(source, 'mismatch')
      const [code, msg] =
        cf === 'list'
          ? ['solve.listIntoScalar', `expects one value but is driven by a list; apply the node per element with a Map region, reduce the list, or pick one element explicitly`]
          : ['solve.scalarIntoList', `expects a list but is driven by one value; collect values into a list explicitly`]
      diagnostics.push(
        diag('error', 'schema', code, `[${def.id}] ${sourceLabel(source)}: input '${to.port}' on node '${to.node}' ${msg}`, {
          anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
        }),
      )
      return
    }

    const fromVar = fromType.kind === 'variable'
      ? fromVariableKeys?.get(fromType.templateId) ?? varKeyOf(from.node, fromType.templateId)
      : undefined
    const toVar = toType.kind === 'variable' ? varKeyOf(to.node, toType.templateId) : undefined

    if (fromVar !== undefined && toVar !== undefined) {
      if (source.kind === 'projectedInput' && fromVariableKeys !== undefined) vars.merge(toVar, fromVar, source)
      else vars.merge(fromVar, toVar, source)
      feeds.push({ key: toVar, to, source, from: fromVar })
      setVerdict(source, 'ok') // downgraded to 'mismatch' if the class conflicts
      return
    }
    if (fromVar !== undefined || toVar !== undefined) {
      const varKey = (fromVar ?? toVar)!
      let atoms = atomNamesOf(fromVar !== undefined ? toType : fromType)
      if (atoms === undefined) {
        // Unrestricted (or open-list) other side: no constraint, no capture.
        setVerdict(source, 'ok')
        return
      }
      if (toVar !== undefined && allowCoercion) {
        // Exact-first (backend parity): a MATCHING variable destination
        // receives the AssetRef unchanged, so the incoming type itself binds
        // the variable - an asset<X> edge next to a plain X edge on one bare
        // variable is a genuine conflict, never a silent decode. Only when
        // the variable's DECLARED allowlist cannot accept the incoming type
        // directly does the one coercion step apply: the input then resolves
        // to a coercion target and the engine decodes/lifts/merges at input
        // resolution.
        const declared = atomNamesOf(toType)
        if (declared !== undefined && !atoms.some((n) => declared.includes(n))) {
          const coerced = atoms.flatMap((n) => coercionTargetsOf(n))
          if (coerced.some((n) => declared.includes(n))) atoms = coerced
        }
      }
      vars.constrain(varKey, atoms, source)
      // A type outside the variable's allowlist is an ordinary mismatch: a
      // registered type equivalence may still admit it on the server.
      const allowed = toVar === undefined ? undefined : atomNamesOf(toType)
      if (toVar !== undefined && (allowed === undefined || atoms.some((n) => allowed.includes(n)))) feeds.push({ key: toVar, to, source, atoms })
      setVerdict(source, 'ok') // downgraded on conflict
      return
    }

    // Structured-vs-structured of the SAME constructor (list or asset) where
    // at least one side is OPEN (closed structures denote atoms and fall
    // through to atom arithmetic below): peel the shared constructor and
    // unify the elements on the same edge source - this is how "asset<T>
    // binds T" works, mirroring the backend's unification through the
    // constructor.
    if (fromType.kind === toType.kind && (fromType.kind === 'list' || fromType.kind === 'asset' || fromType.kind === 'stream')) {
      const a = atomNamesOf(fromType)
      const b = atomNamesOf(toType)
      if (a === undefined || b === undefined) {
        // Shared-constructor peel is free: the coercion budget is inherited
        // (that is the elementwise lift when a list element then decodes).
        // A closed heterogeneous list binds its runtime element marker, not
        // an unconstrained wildcard edge. Bare wildcards still never capture.
        const element = fromType.kind === 'list' && fromType.element.kind === 'wildcard'
          ? { kind: 'concrete' as const, name: '*' }
          : fromType.element
        unify(element, (toType as TypeExpr & { kind: 'list' | 'asset' | 'stream' }).element, from, to, source, allowCoercion, fromVariableKeys)
        return
      }
      // Both closed: exact canonical-id overlap, handled below.
    } else if (fromType.kind === 'list' || fromType.kind === 'asset' || fromType.kind === 'stream' || toType.kind === 'list' || toType.kind === 'asset' || toType.kind === 'stream') {
      // Open structured side against a concrete/union side (closed
      // structures fell through the gate only when the other side has
      // matching atoms too): peel by parsing the atom side's parametric ids
      // and unify elements. Mixed constructors never meet here - the
      // cardinality gate already resolved list-vs-asset edges.
      const structuredIsFrom = fromType.kind === 'list' || fromType.kind === 'asset' || fromType.kind === 'stream'
      const structured = (structuredIsFrom ? fromType : toType) as TypeExpr & { kind: 'list' | 'asset' | 'stream' }
      const other = structuredIsFrom ? toType : fromType
      if (atomNamesOf(structured) === undefined) {
        const parse = structured.kind === 'list' ? parseListTypeId : structured.kind === 'asset' ? parseAssetTypeId : parseStreamTypeId
        const elems = (atomNamesOf(other) ?? []).map(parse).filter((n): n is string => n !== undefined)
        if (elems.length === 0) {
          // An open ASSET producer can still feed a concrete input through
          // the one decode step (asset<V> -> V): bind the element against
          // the input's atoms instead of reporting a mismatch. The step is
          // spent - the recursion is non-coercing, so asset<asset<V>> never
          // chains through.
          if (allowCoercion && structuredIsFrom && structured.kind === 'asset') {
            unify(structured.element, toType, from, to, source, false, fromVariableKeys)
            return
          }
          // Mixed-cardinality union with no matching members left: mismatch.
          setVerdict(source, 'mismatch')
          diagnostics.push(
            diag('warning', 'schema', 'solve.linkMismatch', `${to.node}.${to.port}: no ${structured.kind}-typed candidate matches this input`, {
              anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
            }),
          )
          return
        }
        const elemExpr: TypeExpr = elems.length === 1 ? typeExprFromTypeId(elems[0]!) : { kind: 'union', names: elems }
        if (structuredIsFrom) unify(structured.element, elemExpr, from, to, source, allowCoercion, fromVariableKeys)
        else unify(elemExpr, structured.element, from, to, source, allowCoercion, fromVariableKeys)
        return
      }
    }

    // Atom-vs-atom: per-edge overlap; unions never collapse. Closed lists
    // and assets compare here by exact canonical id, plus the one asset
    // coercion step (decode asset<T> -> T and kin) counts as overlap.
    const a = atomNamesOf(fromType)
    const b = atomNamesOf(toType)
    if (a === undefined || b === undefined || a.some((n) => b.includes(n)) || (allowCoercion && assetCoercible(fromType, toType))) {
      setVerdict(source, 'ok')
      return
    }
    setVerdict(source, 'mismatch')
    diagnostics.push(
      diag('warning', 'schema', 'solve.linkMismatch', `${to.node}.${to.port}: ${a.join(',')} cannot feed ${b.join(',')}`, {
        anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
      }),
    )
  }

  const rerouteIndex = buildRerouteIndex(def)
  for (const link of Object.values(def.links) as LinkData[]) {
    if (!isPortEndpoint(link.to)) continue // structural feed into a reroute
    // Undriven and cyclic chains constrain nothing.
    const traces = [...traceEndpointAll(def, link.from, rerouteIndex)]
    if (traces.length > 1) branchingLinks.add(link.id)
    for (const trace of traces) {
      if (trace.kind === 'output') {
        constrain(trace.ref, link.to, { kind: 'link', id: link.id })
      } else if (trace.kind === 'tapValue') {
        constrain(
          { node: trace.node, port: trace.input },
          link.to,
          { kind: 'link', id: link.id },
          'input',
        )
      }
    }
  }
  for (const net of Object.values(def.nets)) {
    net.sinks.forEach((sink, i) => {
      constrain(net.source, sink, { kind: 'net', id: net.id, sinkIndex: i })
    })
  }
  const projectedVariablesBySource = new Map<symbol, Map<string, VarKey>>()
  for (const [index, projected] of (options.projectedInputs ?? []).entries()) {
    const toType = admittedInputType(
      projected.type,
      projected.to,
      typeAt(projected.to, 'input'),
    )
    if (toType === undefined) {
      if (portTypes.has(projected.to.node)) {
        diagnostics.push(
          diag('info', 'schema', 'solve.portMissing', `${projected.to.node}.${projected.to.port}: connected port is unavailable`, {
            anchor: { port: projected.to },
          }),
        )
      }
      continue
    }
    const externalRef: PortRef = { node: projected.to.node, port: projected.to.port }
    let projectedVariableKeys: Map<string, VarKey>
    if (projected.variableSource === undefined) {
      projectedVariableKeys = new Map()
    } else {
      projectedVariableKeys = projectedVariablesBySource.get(projected.variableSource) ?? new Map()
      projectedVariablesBySource.set(projected.variableSource, projectedVariableKeys)
    }
    for (const variable of nestedVariablesOf(projected.type)) {
      let key = projectedVariableKeys.get(variable.templateId)
      if (key === undefined) {
        key = Symbol(`projected-input:${index}:${variable.templateId}`)
        projectedVariableKeys.set(variable.templateId, key)
      }
      vars.ensure(key, variable, { kind: 'projected', to: projected.to, templateId: variable.templateId })
    }
    unify(projected.type, toType, externalRef, projected.to, {
      kind: 'projectedInput',
      index,
      to: projected.to,
      ...(projected.label === undefined ? {} : { label: projected.label }),
    }, true, projectedVariableKeys)
  }

  // Tuple construction and projection depend on upstream bindings, not edge order.
  // Each pass propagates at least one closed product along the dependency chain.
  for (let pass = 0; pass <= dependentEdges.length; pass++) {
    let changed = false
    for (const edge of dependentEdges) {
      const resolved = substitute(edge.fromType, edge.from.node)
      if (atomNamesOf(resolved) === undefined) continue
      const signature = JSON.stringify(resolved)
      if (edge.signature === signature) continue
      edge.signature = signature
      changed = true
      unify(resolved, edge.toType, edge.from, edge.to, edge.source)
    }
    if (!changed) break
  }
  for (const [node, ports] of portTypes) {
    for (const [port, type] of ports.outputs) {
      const resolved = substitute(type, node)
      if (resolved.kind !== 'tuple_element' || resolved.element === undefined || atomNamesOf(resolved.element) === undefined) continue
      diagnostics.push(diag('error', 'schema', 'solve.tupleProjection', `Tuple output '${port}' requires a tuple source and an in-range literal index.`, { anchor: { port: { node, port: asPortId(port) } } }))
    }
  }

  // -- 3. Nodes whose own inputs bring types no one type matches: errors,
  // because the engine refuses the run. A Switch counts only when its pick is
  // a run-time value; a stored or known pick is lowered away before
  // validation, and the branches it leaves out never reach the engine.
  const runtimePick = (node: NodeId): boolean => {
    const selector = selectors.get(node)!
    const producers = [
      ...(Object.values(def.links) as LinkData[])
        .filter((link) => isPortEndpoint(link.to) && link.to.node === node && link.to.port === selector.input)
        .map((link) => [...traceEndpointAll(def, link.from, rerouteIndex)]),
      ...Object.values(def.nets)
        .filter((net) => net.sinks.some((sink) => sink.node === node && sink.port === selector.input))
        .map((net) => [...traceEndpointAll(def, net.source, rerouteIndex)]),
    ]
    return producers.length === 1 && producers[0]!.length === 1 &&
      producers[0]![0]!.kind === 'output' && !knownOutputs.get(producers[0]![0]!.ref.node)?.has(producers[0]![0]!.ref.port)
  }
  const unbranched = feeds.filter((feed) => !(feed.source.kind === 'link' && branchingLinks.has(feed.source.id)))
  const storedPickBranch = (feed: Feed): boolean =>
    selectors.has(feed.to.node) && feed.to.port.startsWith(`${selectors.get(feed.to.node)!.group}.`) && !runtimePick(feed.to.node)
  const broughtBy = (feed: Feed, fed: ReadonlyMap<VarKey, ReadonlySet<string>>): ReadonlySet<string> | undefined => {
    if (feed.atoms !== undefined) return new Set(feed.atoms)
    const passed = fed.get(feed.from!)
    // A generic producer that cannot bind passes no type on.
    return passed !== undefined && passed.size > 0 ? passed : undefined
  }
  /** The types each variable is fed through `counted`, narrowed until stable. */
  const fedTypes = (counted: readonly Feed[]): ReadonlyMap<VarKey, ReadonlySet<string>> => {
    let fed = new Map<VarKey, ReadonlySet<string>>()
    for (let pass = 0; pass <= counted.length; pass++) {
      const next = new Map<VarKey, ReadonlySet<string>>()
      for (const feed of counted) {
        const atoms = broughtBy(feed, fed)
        if (atoms === undefined) continue
        const prior = next.get(feed.key)
        next.set(feed.key, prior === undefined ? atoms : new Set([...atoms].filter((atom) => prior.has(atom))))
      }
      const stable = next.size === fed.size && [...next].every(([key, atoms]) => {
        const prior = fed.get(key)
        return prior !== undefined && prior.size === atoms.size && [...atoms].every((atom) => prior.has(atom))
      })
      fed = next
      if (stable) break
    }
    return fed
  }
  /** Each conflicted variable once, named the way a person reads it. */
  const conflicts = (counted: readonly Feed[]) => {
    const fed = fedTypes(counted)
    return [...fed].filter(([, atoms]) => atoms.size === 0).map(([key]) => {
      const into = counted.filter((feed) => feed.key === key)
      const node = into[0]!.to.node
      const brought = new Map<string, ReadonlySet<string>>()
      for (const feed of into) {
        const atoms = broughtBy(feed, fed)
        if (atoms === undefined) continue
        const prior = brought.get(feed.to.port)
        brought.set(feed.to.port, prior === undefined ? atoms : new Set([...atoms].filter((atom) => prior.has(atom))))
      }
      const order = [...(portTypes.get(node)?.inputs.keys() ?? [])]
      const labels = inputLabels.get(node)
      const named = [...brought]
        .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
        .map(([port, types]) => `${labels?.get(port) ?? port} is ${[...types].join(' or ')}`)
      return { key, node, into, message: `These inputs must be the same type: ${named.join(', ')}.` }
    })
  }
  const refused = new Set<VarRecord>()
  const onNode = (conflict: ReturnType<typeof conflicts>[number]) => {
    const last = conflict.into.at(-1)!
    return {
      anchor: { port: last.to, ...(last.source.kind === 'link' ? { link: last.source.id } : {}) },
      data: { node: conflict.node, edges: conflict.into.map((feed) => sourceLabel(feed.source)) },
    }
  }
  for (const conflict of conflicts(unbranched.filter((feed) => !storedPickBranch(feed)))) {
    refused.add(vars.find(conflict.key))
    diagnostics.push(diag('error', 'schema', 'solve.varConflict', conflict.message, onNode(conflict)))
  }
  // A Switch with a stored or known pick runs only the picked branch, so
  // branches of different types are a warning on the Switch, worded as the
  // error is.
  const warned = new Set<VarRecord>()
  for (const conflict of conflicts(unbranched)) {
    const root = vars.find(conflict.key)
    if (refused.has(root) || warned.has(root) || !conflict.into.some(storedPickBranch)) continue
    warned.add(root)
    diagnostics.push(diag('warning', 'schema', 'solve.varConflict', conflict.message, onNode(conflict)))
  }

  // -- 4. Other conflicted classes: mark every contributing edge, one warning each.
  for (const root of vars.roots()) {
    if (root.domain === undefined || root.domain.size > 0) continue
    for (const source of root.sources) setVerdict(source, 'mismatch')
    if (refused.has(root) || warned.has(root)) continue
    const firstLink = root.sources.find((s): s is Extract<EdgeSource, { kind: 'link' }> => s.kind === 'link')
    const firstProjected = root.sources.find((s): s is Extract<EdgeSource, { kind: 'projectedInput' }> => s.kind === 'projectedInput')
    const firstSlotBinding = root.slotBindings[0]
    const subject = root.owner.kind === 'node'
      ? `${root.owner.node}.${root.owner.templateId}`
      : `${root.owner.to.node}.${root.owner.to.port}`
    const message = firstSlotBinding !== undefined
      ? `${subject}: connected types conflict with selected variant '${firstSlotBinding.variant}'`
      : `${subject}: connected types have no common match`
    diagnostics.push(
      diag('warning', 'schema', 'solve.varConflict', message, {
        ...(firstLink ? { anchor: { link: firstLink.id } } : firstProjected ? { anchor: { port: firstProjected.to } } : firstSlotBinding ? { anchor: { port: firstSlotBinding.ref } } : {}),
        data: {
          edges: root.sources.map(sourceLabel),
          ...(root.slotBindings.length > 0
            ? { slotSelections: root.slotBindings.map(({ ref, variant }) => `${ref.node}/${ref.port}=${variant}`) }
            : {}),
        },
      }),
    )
  }

  // -- 5. Result surface.
  // Specialization is a persisted choice, so solving only advises when a
  // later topology/type change makes that choice stale. Reuse the exact
  // topology tracing policy used by edge checks, including all selector
  // candidates, and abstain for generic or wildcard producers.
  const isKnown = (type: TypeExpr): boolean =>
    type.kind === 'concrete' || type.kind === 'union' || ((type.kind === 'list' || type.kind === 'asset' || type.kind === 'stream') && isKnown(type.element))
  const reroutes = buildRerouteIndex(def)
  const checkProducer = (slot: typeof specializedSlots[number], from: Parameters<typeof traceEndpointAll>[1]): void => {
    for (const trace of traceEndpointAll(def, from, reroutes)) {
      if (trace.kind !== 'output') continue
      const declared = typeAt(trace.ref, 'output')
      if (declared === undefined) continue
      const solved = substitute(declared, trace.ref.node)
      if (!isKnown(solved) || typesCompatible(solved, slot.selectedType)) continue
      diagnostics.push(diag('warning', 'schema', 'solve.slot.staleSpecialization', `${slot.node}.${slot.ref.port}: slot variant is incompatible with ${trace.ref.node}.${trace.ref.port}`, {
        anchor: { port: slot.ref },
      }))
    }
  }
  for (const slot of specializedSlots) {
    const slotKey = slot.ref.port
    for (const link of Object.values(def.links) as LinkData[]) {
      if (isPortEndpoint(link.to) && link.to.node === slot.node && link.to.port === slotKey) checkProducer(slot, link.from)
    }
    for (const net of Object.values(def.nets)) {
      if (net.sinks.some((sink) => sink.node === slot.node && sink.port === slotKey)) checkProducer(slot, net.source)
    }
  }

  return {
    resolutionOf: (node, templateId) => vars.resolutionOf(varKeyOf(node, templateId)),
    portTypeOf: (node, side, port) => {
      const entry = portTypes.get(node)
      const declared = entry ? (side === 'input' ? entry.inputs : entry.outputs).get(port) : undefined
      return declared === undefined ? undefined : substitute(declared, node)
    },
    linkVerdicts,
    netSinkVerdicts,
    diagnostics,
  }
}

const sourceLabel = (s: EdgeSource): string =>
  s.kind === 'link'
    ? `link '${s.id}'`
    : s.kind === 'net'
      ? `net '${s.id}' sink ${s.sinkIndex}`
      : s.label ?? `projected input ${s.index}`
