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
import { admittedInputType, assetCoercible, atomNamesOf, coercionTargetsOf, typesCompatible } from './type-relations.js'
import type { SchemaResolver } from './derive-boundary.js'
import { typeAtomDisplayLabel, typeDisplayAliases, type TypeDisplayNames } from './type-presentation.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elabOutputsOf,
  elaborateInterface,
  type Connectivity,
  type ElaborateOptions,
} from './elaborate.js'
import { canonicalTypeIdOf, cardinalityOf, effectiveAbsentPolicy, inputsOf, outputsOf, parseAssetTypeId, parseListTypeId, parseStreamTypeId, typeExprFromTypeId, type NodeSchema, type NodeSelectorSpec, type TypeExpr } from './model.js'

/** Type words used by solver problems on every surface; never a type variable's storage name. */
export function typeProblemWords(type: TypeExpr, form: 'value' | 'name' | 'plural' | 'one' = 'value', names?: TypeDisplayNames): string {
  if (type.kind === 'concrete') {
    const parsed = typeExprFromTypeId(type.name)
    if (parsed.kind !== 'concrete') return typeProblemWords(parsed, form, names)
    const words: Readonly<Record<string, readonly [string, string, string]>> = {
      IMAGE: ['image', 'an image', 'images'], MASK: ['mask', 'a mask', 'masks'],
      STRING: ['text', 'text', 'text values'], INT: ['whole number', 'a whole number', 'whole numbers'],
      FLOAT: ['number', 'a number', 'numbers'], LATENT: ['latent data', 'latent data', 'latent values'],
      BOOLEAN: ['true/false value', 'a true/false value', 'true/false values'],
    }
    const shown = typeAtomDisplayLabel(type.name, names)
    const builtin = typeDisplayAliases[type.name] ?? type.name
    const [name, value, plural] = Object.hasOwn(words, builtin) ? words[builtin]! : [shown, shown, `${shown} values`]
    return form === 'name' ? name : form === 'plural' ? plural : form === 'one'
      ? `one ${builtin === 'LATENT' ? 'latent value' : builtin === 'STRING' ? 'text value' : name}` : value
  }
  if (type.kind === 'union') return type.names.map((name) => typeProblemWords(typeExprFromTypeId(name), form, names)).join(' or ')
  if (type.kind === 'variable') return type.allowedTypes?.length
    ? type.allowedTypes.map((allowed) => typeProblemWords(allowed, form, names)).join(' or ')
    : 'any type'
  if (type.kind === 'wildcard') return 'any type'
  if (type.kind === 'tuple_element') return type.element === undefined ? 'a value from a group' : typeProblemWords(type.element, form, names)
  if (type.kind === 'tuple') return `${form === 'plural' ? 'groups' : form === 'name' ? 'group' : 'a group'} of ${type.elements.length} values`
  if (type.kind === 'asset') {
    const element = typeProblemWords(type.element, form === 'plural' ? 'plural' : 'name', names)
    return `${form === 'plural' || form === 'name' || element === 'latent data' || element === 'text' ? 'stored' : 'a stored'} ${element}`
  }
  return `${form === 'plural' ? `${type.kind}s` : form === 'name' ? type.kind : `a ${type.kind}`} of ${typeProblemWords(type.element, 'plural', names)}`
}

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
  const words = (type: TypeExpr, form?: 'value' | 'name' | 'plural' | 'one'): string => typeProblemWords(type, form, resolve.typeDisplayNames)
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
  const declaredPortTypes = new Map<NodeId, PortTypes>()
  const specializedSlots: {
    node: NodeId
    ref: PortRef
    selectedType: TypeExpr
  }[] = []
  const optionalOutputs = new Map<NodeId, Set<string>>()
  const failInputs = new Map<NodeId, Set<string>>()
  const wholeListInputs = new Map<NodeId, Set<string>>()
  const inputLabels = new Map<NodeId, Map<string, string>>()
  const outputLabels = new Map<NodeId, Map<string, string>>()
  const schemas = new Map<NodeId, NodeSchema>()
  const nodeTitles = new Map<NodeId, string>()
  const knownOutputs = new Map<NodeId, Set<string>>()
  const selectors = new Map<NodeId, NodeSelectorSpec>()
  for (const node of Object.values(def.nodes) as NodeData[]) {
    options.onWork?.('node')
    const schema = options.resolveNode === undefined
      ? resolve(node.type)
      : options.resolveNode(node)
    if (!schema) continue // structural validators own "unresolvable type"
    schemas.set(node.id, schema)
    nodeTitles.set(node.id, node.title ?? schema.displayName)
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
      let labels = outputLabels.get(node.id)
      if (!labels) outputLabels.set(node.id, (labels = new Map()))
      labels.set(key, item.spec.displayName ?? item.spec.id)
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
    declaredPortTypes.set(node.id, { inputs: new Map(inputs), outputs: new Map(outputs) })
    if (slotBindings.length > 0) {
      const bindings = new Map(slotBindings.map(({ templateId, type }) => [templateId, type]))
      for (const [key, type] of inputs) inputs.set(key, substituteTypeBindings(type, bindings))
      for (const [key, type] of outputs) outputs.set(key, substituteTypeBindings(type, bindings))
    }
    portTypes.set(node.id, { inputs, outputs })
  }

  const rowLabel = (ref: PortRef, side: 'input' | 'output'): string => {
    const label = (side === 'input' ? inputLabels : outputLabels).get(ref.node)?.get(ref.port)
    if (label !== undefined) return label
    const schema = schemas.get(ref.node)
    const spec = schema === undefined ? undefined : (side === 'input' ? inputsOf(schema) : outputsOf(schema)).find((row) => row.id === ref.port)
    return spec?.displayName ?? `a connected ${side}`
  }
  const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)
  const sourceName = (ref: PortRef, side: 'input' | 'output' = 'output'): string =>
    (side === 'output' ? outputLabels : inputLabels).get(ref.node)?.size === 1
      ? nodeTitles.get(ref.node) ?? 'the connected node'
      : `the ${side} ${rowLabel(ref, side)} of ${nodeTitles.get(ref.node) ?? 'the connected node'}`
  const problem = (
    severity: Diagnostic['severity'], code: string, ref: PortRef, side: 'input' | 'output',
    nodeMessage: string, rest: Pick<Diagnostic, 'anchor' | 'data'> = {},
  ): Diagnostic => diag(severity, 'schema', code, `${nodeTitles.get(ref.node) ?? 'Node'}: ${nodeMessage}`, {
    ...rest,
    anchor: { ...rest.anchor, port: ref },
    refs: [{ graphId: def.id, nodeId: ref.node, portId: ref.port, direction: side }],
    data: { ...rest.data, nodeMessage },
  })

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
  type TypeEdge = { from: PortRef; to: PortRef; fromType: TypeExpr; toType: TypeExpr; fromSide: 'input' | 'output'; source: EdgeSource }
  const typeEdges = new Map<string, TypeEdge[]>()
  const rememberEdge = (edge: TypeEdge): void => {
    const key = sourceKey(edge.source)
    let edges = typeEdges.get(key)
    if (!edges) typeEdges.set(key, (edges = []))
    edges.push(edge)
  }
  /** Links whose consumer sees several possible producers (selector candidates). */
  const branchingLinks = new Set<LinkId>()

  const admittedTypeAt = (
    from: TypeExpr | undefined,
    to: PortRef,
    type: TypeExpr | undefined,
  ): TypeExpr | undefined =>
    type !== undefined && from !== undefined
      ? admittedInputType(type, wholeListInputs.get(to.node)?.has(to.port) === true, cardinalityOf(from))
      : type

  const constrain = (
    from: PortRef,
    to: PortRef,
    source: EdgeSource,
    fromSide: 'input' | 'output' = 'output',
  ): void => {
    const fromType = typeAt(from, fromSide)
    const toType = admittedTypeAt(fromType, to, typeAt(to, 'input'))
    if (fromType !== undefined && toType !== undefined && hasTuple(fromType))
      dependentEdges.push({ fromType, toType, from, to, source })
    if (fromType === undefined || toType === undefined) {
      setVerdict(source, 'unknown')
      const missing = fromType === undefined ? from : to
      if (portTypes.has(missing.node)) {
        // The node elaborated but this port does not currently exist
        // (inactive branch, removed member, renamed schema port).
        diagnostics.push(
          problem('info', 'solve.portMissing', missing, fromType === undefined ? fromSide : 'input', `${capitalized(rowLabel(missing, fromType === undefined ? fromSide : 'input'))} no longer exists on this node, but a wire is still connected to it.`, {
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
        problem('warning', 'solve.maybeAbsent', to, 'input', `${capitalized(rowLabel(to, 'input'))} needs a value, but ${sourceName(from, fromSide)} may send nothing.`, {
          anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
        }),
      )
    }

    rememberEdge({ from, to, fromType, toType, fromSide, source })
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
    const origin = typeEdges.get(sourceKey(source))?.find((edge) => edge.from.node === from.node && edge.from.port === from.port)
    const producer = source.kind === 'projectedInput' ? 'the outer input' : sourceName(from, origin?.fromSide)
    if (fromType.kind === 'wildcard' || toType.kind === 'wildcard') {
      setVerdict(source, 'ok') // no constraint, no capture
      return
    }

    if (fromType.kind === 'tuple' && toType.kind === 'tuple') {
      if (fromType.elements.length !== toType.elements.length) {
        setVerdict(source, 'mismatch')
        diagnostics.push(problem('warning', 'solve.tupleArity', to, 'input', `${capitalized(rowLabel(to, 'input'))} needs a group of ${toType.elements.length} values, but ${producer} sends a group of ${fromType.elements.length}.`, { anchor: { ...(source.kind === 'link' ? { link: source.id } : {}) } }))
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
      const code = cf === 'list' ? 'solve.listIntoScalar' : 'solve.scalarIntoList'
      diagnostics.push(
        problem('error', code, to, 'input', `${capitalized(rowLabel(to, 'input'))} needs ${words(toType, ct === 'list' ? 'value' : 'one')}, but ${producer} sends ${words(fromType, cf === 'list' ? 'value' : 'one')}.`, {
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
            problem('warning', 'solve.linkMismatch', to, 'input', `${capitalized(rowLabel(to, 'input'))} needs ${words(origin?.toType ?? toType)}, but ${producer} sends ${words(origin?.fromType ?? fromType)}.`, {
              anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
              data: { sourceNode: from.node, sourcePort: from.port },
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
      problem('warning', 'solve.linkMismatch', to, 'input', `${capitalized(rowLabel(to, 'input'))} needs ${words(origin?.toType ?? toType)}, but ${producer} sends ${words(origin?.fromType ?? fromType)}.`, {
        anchor: source.kind === 'link' ? { link: source.id, port: to } : { port: to },
        data: { sourceNode: from.node, sourcePort: from.port },
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
    const toType = admittedTypeAt(
      projected.type,
      projected.to,
      typeAt(projected.to, 'input'),
    )
    if (toType === undefined) {
      if (portTypes.has(projected.to.node)) {
        diagnostics.push(
          problem('info', 'solve.portMissing', projected.to, 'input', `${capitalized(rowLabel(projected.to, 'input'))} no longer exists on this node, but a wire is still connected to it.`, {
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
    const source: EdgeSource = {
      kind: 'projectedInput',
      index,
      to: projected.to,
      ...(projected.label === undefined ? {} : { label: projected.label }),
    }
    rememberEdge({ from: externalRef, to: projected.to, fromType: projected.type, toType, fromSide: 'input', source })
    unify(projected.type, toType, externalRef, projected.to, source, true, projectedVariableKeys)
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
      const ref = { node, port: asPortId(port) }
      const message = resolved.element.kind === 'tuple' && typeof resolved.index === 'number'
        ? `Position ${resolved.index} was chosen, but the group has ${resolved.element.elements.length} values.`
        : `${capitalized(rowLabel(ref, 'output'))} needs a group and a fixed position in it.`
      diagnostics.push(problem('error', 'solve.tupleProjection', ref, 'output', message))
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
        .map(([port, types]) => `the input ${labels?.get(port) ?? port} is ${[...types].map((type) => words(typeExprFromTypeId(type))).join(' or ')}`)
      return { key, node, into, message: `The inputs must be the same type, but ${named.join(' and ')}.` }
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
    diagnostics.push(problem('error', 'solve.varConflict', conflict.into.at(-1)!.to, 'input', conflict.message, onNode(conflict)))
  }
  // A Switch with a stored or known pick runs only the picked branch, so
  // branches of different types are a warning on the Switch, worded as the
  // error is.
  const warned = new Set<VarRecord>()
  for (const conflict of conflicts(unbranched)) {
    const root = vars.find(conflict.key)
    if (refused.has(root) || warned.has(root) || !conflict.into.some(storedPickBranch)) continue
    warned.add(root)
    diagnostics.push(problem('warning', 'solve.varConflict', conflict.into.at(-1)!.to, 'input', conflict.message, onNode(conflict)))
  }

  // -- 4. Other conflicted classes: mark every contributing edge, one warning each.
  for (const root of vars.roots()) {
    if (root.domain === undefined || root.domain.size > 0) continue
    for (const source of root.sources) setVerdict(source, 'mismatch')
    if (refused.has(root) || warned.has(root)) continue
    const firstLink = root.sources.find((s): s is Extract<EdgeSource, { kind: 'link' }> => s.kind === 'link')
    const firstProjected = root.sources.find((s): s is Extract<EdgeSource, { kind: 'projectedInput' }> => s.kind === 'projectedInput')
    const firstSlotBinding = root.slotBindings[0]
    const sources = new Set(root.sources.map(sourceKey))
    const edges = [...sources].flatMap((source) => typeEdges.get(source) ?? [])
    const ownerNode = root.owner.kind === 'node' ? root.owner.node : root.owner.to.node
    const incoming = edges.find((edge) => edge.to.node === ownerNode)
    const outgoing = edges.find((edge) => edge.from.node === ownerNode && edge.to.node !== ownerNode)
    const ref = firstSlotBinding?.ref ?? incoming?.to ?? outgoing?.from ?? firstProjected?.to
    const ownerPorts = declaredPortTypes.get(ownerNode)
    const declared = ownerPorts === undefined ? undefined : [...ownerPorts.inputs].find(([, type]) =>
      [...nestedVariablesOf(type)].some((variable) => vars.find(varKeyOf(ownerNode, variable.templateId)) === root))
    const target = ref ?? { node: ownerNode, port: asPortId(declared?.[0] ?? '') }
    const side = incoming !== undefined || firstSlotBinding !== undefined || outgoing === undefined ? 'input' : 'output'
    let message: string
    if (firstSlotBinding !== undefined) {
      const selected = specializedSlots.find((slot) => slot.ref.node === target.node && slot.ref.port === target.port)!.selectedType
      const origin = incoming === undefined ? undefined : incoming.source.kind === 'projectedInput' ? 'the outer input' : sourceName(incoming.from, incoming.fromSide)
      message = `${capitalized(rowLabel(target, 'input'))} is set to ${words(selected, 'name')}, but ${incoming === undefined
        ? `the input ${declared === undefined ? rowLabel(target, 'input') : rowLabel({ node: ownerNode, port: asPortId(declared[0]) }, 'input')} needs ${words(declared?.[1] ?? { kind: 'wildcard' }, 'name')}`
        : `${origin} sends ${words(incoming.fromType)}`}.`
    } else if (incoming !== undefined && outgoing !== undefined) {
      message = `${capitalized(rowLabel(incoming.to, 'input'))} receives ${words(incoming.fromType)}, but its output feeds the input ${rowLabel(outgoing.to, 'input')} of ${nodeTitles.get(outgoing.to.node)}, which needs ${words(outgoing.toType)}.`
    } else if (incoming !== undefined) {
      const origin = incoming.source.kind === 'projectedInput' ? 'the outer input' : sourceName(incoming.from, incoming.fromSide)
      message = `${capitalized(rowLabel(target, 'input'))} needs ${words(incoming.toType)}, but ${origin} sends ${words(incoming.fromType)}.`
    } else {
      message = `${capitalized(rowLabel(target, side))} must match the connected inputs, but ${edges.map((edge) => `the input ${rowLabel(edge.to, 'input')} of ${nodeTitles.get(edge.to.node)} needs ${words(edge.toType)}`).join(' and ')}.`
    }
    diagnostics.push(
      problem('warning', 'solve.varConflict', target, side, message, {
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
      diagnostics.push(problem('warning', 'solve.slot.staleSpecialization', slot.ref, 'input', `${capitalized(rowLabel(slot.ref, 'input'))} is set to ${words(slot.selectedType, 'name')}, but ${sourceName(trace.ref)} sends ${words(solved)}.`, {
        anchor: { port: slot.ref },
        data: { sourceNode: trace.ref.node, sourcePort: trace.ref.port },
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
    // Dependent structured edges can be checked again after tuple substitution.
    diagnostics: [...new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic])).values()],
  }
}

const sourceLabel = (s: EdgeSource): string =>
  s.kind === 'link'
    ? `link '${s.id}'`
    : s.kind === 'net'
      ? `net '${s.id}' sink ${s.sinkIndex}`
      : s.label ?? `projected input ${s.index}`

const sourceKey = (source: EdgeSource): string => JSON.stringify(source.kind === 'link'
  ? [source.kind, source.id]
  : source.kind === 'net' ? [source.kind, source.id, source.sinkIndex] : [source.kind, source.index])
