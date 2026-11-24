/**
 * The compiler is a pure function from document, schemas, and scope to a CompileArtifact.
 *
 * Pinned by the golden pairs in fixtures/prompts (validated against a real
 * server; see the README there):
 * - Runtime node id = occurrenceKey(): source node id for root nodes ('n1'),
 *   instance-path-qualified inside subgraph instances ('n0.n0').
 * - The compiler reasons over elaborated interfaces: values and links
 *   resolve by document identity (the flattened port id), the prompt is
 *   keyed by elaborated apiName (positional wire names for group members -
 *   compiler OUTPUT, never identity). Static nodes are unchanged:
 *   apiName = flattened id = schema input id.
 * - Links lower to [producerRuntimeId, outputIndex] (index = producer's
 *   position among its non-ghost elaborated outputs; compiler OUTPUT only).
 * - Subgraph instances flatten away. Boundary ports resolve through to the
 *   bound inner port, recursively. A value stored on the instance for a
 *   boundary input overrides the inner node's stored value; an OUTER
 *   instance's override beats an inner instance's (first-write-wins while
 *   walking outside-in).
 * - Compilation is phased: (1) discover every graph occurrence outside-in,
 *   deriving occurrence-local editable-menu overlays and input connectivity
 *   projected through boundary inputs; (2) resolve promoted values; (3)
 *   lower values/links/nets. Boundary item selection goes through the ONE
 *   matcher (crossing.ts); nothing re-parses paths.
 * - Named nets expand to direct links.
 * - Muted nodes and links touching them are omitted (warning when that leaves
 *   a required input dangling). Bypassed nodes lower to a type-matched
 *   passthrough: a consumer edge whose producer
 *   is bypassed traces through the bypassed node's matching DRIVEN input
 *   (bypass.ts owns the matching rule), through reroute chains and further
 *   bypassed nodes, to the real producer - or a known value, which bakes
 *   into the consumer input. Subgraph instances bypass at their
 *   boundary schema: the passthrough matches over the instance's ELABORATED
 *   boundary interface in the parent graph; the definition's contents never
 *   compile (no recursive descendant-poking).
 *
 * Stored controller values compile as-is; advancement happens elsewhere.
 */

import { diag, type Diagnostic } from '../diagnostics.js'
import {
  suppressedDeliveryKey,
  type BoundaryRouteLeg,
  type DynamicPortState,
  type GraphDef,
  type Json,
  type NodeData,
  type ParentDeliveryIdentity,
  type WorkflowDocument,
} from '../format/document.js'
import {
  asGraphDefId,
  asPortId,
  isPortEndpoint,
  isRerouteRef,
  isWidgetTapRef,
  occurrenceKey,
  portAddressKey,
  portRefKey,
  type ConnectionId,
  type GraphDefId,
  type LinkEndpoint,
  type LinkId,
  type NodeId,
  type Occurrence,
  type PortRef,
} from '../ids.js'
import { companionSourcesOf } from '../companion.js'
import { subgraphDefIdOf } from '../invariants.js'
import { buildRerouteIndex, rerouteDriverOf, rerouteInputTargets, type RerouteIndex, type TraceVia } from '../reroute.js'
import { effectivePrimitiveSpec, explicitPrimitiveDefault, explicitPrimitiveLimits, primitiveOf, withPrimitiveValue, type EffectivePrimitiveSpec, type FedField } from '../primitive.js'
import { matchBypassInput, type BypassCandidate } from './bypass.js'
import { deriveBoundarySchema, type SchemaResolver } from '../schema/derive-boundary.js'
import {
  buildGraphConnectivity,
  elabInputsOf,
  elabOutputsOf,
  elaborateInterface,
  ruleProblemRefs,
  selectorMembersOf,
  valueKeyOf,
  EMPTY_CONNECTIVITY,
  type Connectivity,
  type ElaboratedInput,
  type ElaboratedOutput,
  type PortAddress,
} from '../schema/elaborate.js'
import { solveGraphTypes } from '../schema/solve.js'
import { constructsOf } from '../schema/body.js'
import { boundaryOutputFanOutProblems, innerConstructAddress, matchBoundaryItem, outerConstructAddress, projectConstructs, projectEditableOptions } from './crossing.js'
import { assetTypeId, canonicalTypeIdOf, effectiveAbsentPolicy, isAssetRefDestinationTypeId, isAssetSourceTypeId, listTypeId, parseListTypeId, resolveWidgetRepresentation, typeExprFromTypeId, type InputSpec, selectedMember, type NodeSchema, type NodeSelectorSpec, type TypeExpr, type WidgetSpec } from '../schema/model.js'
import { effectiveWidgetDefault, isAssetRefValue } from '../schema/widget-defaults.js'
import { isCanonicalUnsafeInteger } from '../schema/numeric-step.js'
import {
  decimalIntegerWire,
  DINKSTER_GRAPH_FEATURE_ABSENT_INPUT,
  DINKSTER_GRAPH_FEATURE_DECIMAL_INT,
  DINKSTER_GRAPH_FEATURE_REGIONS,
  DINKSTER_GRAPH_FEATURE_TYPED_LITERAL,
  DINKSTER_REGION_PSEUDO_NODE,
  parseDecimalIntegerWire,
  parseTypedLiteralWire,
  typeExprToDinksterWire,
  typedLiteralWire,
  absentInputWire,
  isAbsentInputWire,
  validateDinksterGraph,
  type DinksterGraphEntryWire,
  type DinksterGraphValidationNode,
  type DinksterGraphWire,
  type DinksterInputWire,
  type DinksterRegionOutputWire,
} from './dinkster-graph.js'
import { LivenessDerivation, traverseRoutedProjection, type RouteProjection, type RoutedStep } from './liveness.js'
import type {
  CompileArtifact,
  CompileResult,
  ControllerInputProvenance,
  ControllerInputSource,
  ControllerNodeInputSource,
  ExecutionScope,
  Prompt,
  PromptNode,
  Provenance,
  ScopeClosure,
  ScopeStructuralGraph,
  SelectorChoice,
} from './artifact.js'
import { semanticHashOf } from './hash.js'
import { effectiveOccurrenceTopology, type EffectiveLinkIdentity } from './effective-topology.js'

// ---------------------------------------------------------------------------
// Schema resolution over a document (backend types + '#<defId>' boundaries)
// ---------------------------------------------------------------------------

/**
 * Wrap a backend-schema resolver so subgraph-instance types ('#<defId>')
 * resolve to boundary-derived schemas of this document, recursively. Memoized
 * per document instance; create a fresh resolver when the document changes.
 */
export function documentResolver(doc: WorkflowDocument, base: SchemaResolver): SchemaResolver {
  const cache = new Map<string, NodeSchema | undefined>()
  const resolve: SchemaResolver = Object.assign(
    (nodeType: string) => {
      const defId = subgraphDefIdOf(nodeType)
      if (defId === undefined) return base(nodeType)
      if (cache.has(nodeType)) return cache.get(nodeType)
      const def = doc.graphs[defId]
      if (!def) {
        cache.set(nodeType, undefined)
        return undefined
      }
      const derived = deriveBoundarySchema(def, resolve)
      cache.set(nodeType, derived.schema)
      return derived.schema
    },
    {
      ...(base.forEditorRole === undefined ? {} : { forEditorRole: base.forEditorRole })
    }
  )
  return resolve
}

/**
 * A primitive's effective value widget in one document snapshot: from the
 * fields its output feeds in the given occurrence, or in every occurrence
 * of its definition when `instancePath` is not given.
 */
export type DocumentPrimitiveResolver = (
  graphId: string,
  node: NodeData,
  instancePath?: readonly NodeId[],
) => EffectivePrimitiveSpec | undefined

export function documentPrimitiveResolver(doc: WorkflowDocument, base: SchemaResolver): DocumentPrimitiveResolver {
  const resolve = documentResolver(doc, base)
  let consumers: readonly FedConsumer[] | undefined
  const cache = new Map<string, EffectivePrimitiveSpec | undefined>()
  return (graphId, node, instancePath) => {
    const schema = resolve(node.type)
    const shape = schema && primitiveOf(schema)
    if (!shape) return undefined
    const key = JSON.stringify([graphId, node.id, instancePath ?? null])
    if (cache.has(key)) return cache.get(key)
    consumers ??= compileImpl({ query: 'fedFields', document: doc, resolve: base }, true).consumers
    const samePath = (path: readonly NodeId[]): boolean =>
      instancePath === undefined || JSON.stringify(path) === JSON.stringify(instancePath)
    const fed = new Map<string, FedField>()
    for (const consumer of consumers) {
      const reaches = consumer.sources.some((source) => 'occurrence' in source && source.graph === graphId &&
        source.occurrence.node === node.id && source.valueKey === shape.value.id && samePath(source.occurrence.instancePath))
      if (!reaches) continue
      fed.set(JSON.stringify([consumer.terminal.graph, occurrenceKey(consumer.terminal.occurrence), consumer.terminal.valueKey]),
        { name: `${consumer.ref.node}.${consumer.input.displayName ?? consumer.input.id}`, input: consumer.input })
    }
    // A limit field holds its typed-in value, or the one its wire brings
    // when that is known before the run, such as another primitive's.
    const def = doc.graphs[graphId]
    const arriving = def === undefined ? undefined : companionSourcesOf(def, undefined, undefined, resolve).get(node.id)
    const wired = (inputId: string): boolean => def !== undefined && Object.values(def.links).some((link) =>
      isPortEndpoint(link.to) && link.to.node === node.id && link.to.port === inputId)
    const limitValue = (inputId: string): Json | undefined => {
      const source = arriving?.get(inputId)
      if (source !== undefined) return source.kind === 'literal' ? source.value : undefined
      return wired(inputId) ? undefined : node.values[inputId]
    }
    const effective = effectivePrimitiveSpec(node.id, shape,
      [...fed.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, field]) => field),
      explicitPrimitiveLimits(shape, limitValue), explicitPrimitiveDefault(shape, limitValue))
    cache.set(key, effective)
    return effective
  }
}

export type DocumentNodeResolver = (graphId: string, node: NodeData, instancePath?: readonly NodeId[]) => NodeSchema | undefined

/**
 * Resolve a concrete document node, including occurrence-local interface
 * contracts such as regions. Definition-only callers should use
 * {@link documentResolver}; concrete graph/node callers must use this form.
 */
export function documentNodeResolver(
  doc: WorkflowDocument,
  base: SchemaResolver,
  resolvePrimitive?: DocumentPrimitiveResolver,
): DocumentNodeResolver {
  const definitionResolve = documentResolver(doc, base)
  const cache = new Map<string, NodeSchema | undefined>()
  const resolveNode: DocumentNodeResolver = (graphId, node, instancePath) => {
    const defId = subgraphDefIdOf(node.type)
    if (defId === undefined) {
      const schema = base(node.type)
      const shape = resolvePrimitive && schema && primitiveOf(schema)
      const effective = shape && resolvePrimitive(graphId, node, instancePath)
      return shape && effective ? withPrimitiveValue(schema, shape, effective) : schema
    }
    const key = JSON.stringify([graphId, node.id, instancePath])
    if (cache.has(key)) return cache.get(key)
    const def = doc.graphs[defId]
    if (!def) {
      cache.set(key, undefined)
      return undefined
    }
    const childPath = instancePath === undefined ? undefined : [...instancePath, node.id]
    const derived = deriveBoundarySchema(
      def,
      definitionResolve,
      node.region,
      (inner) => resolveNode(def.id, inner, childPath),
    )
    cache.set(key, derived.schema)
    return derived.schema
  }
  return resolveNode
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompileInput {
  readonly document: WorkflowDocument
  readonly revision: number
  /** Backend node schemas; '#<defId>' resolution is handled internally. */
  readonly resolve: SchemaResolver
  readonly scope: ExecutionScope
  readonly connection: ConnectionId
  readonly schemaHash: string
  /**
   * Exact replay of a random Switch pick for an existing artifact. The
   * returned member key wins over a new roll when it is still present.
   * `selector` is the Switch occurrence's runtime id and the candidates are
   * its member keys.
   */
  readonly candidateOverride?: (ctx: {
    readonly graph: string
    readonly selector: string
    readonly candidates: readonly string[]
  }) => string | undefined
  /**
   * Chooser for random Switch picks: returns a candidate index in
   * [0, count). REQUIRED for compile() whenever the document contains one -
   * compile has no ambient randomness; the caller injects the roll and the
   * EXACT outcome is recorded in the artifact's `choices`. scopeClosure()
   * never needs one: its would-run closure covers every branch of a random
   * pick (superset) instead of rolling.
   */
  readonly pickCandidate?: (ctx: {
    readonly graph: string
    readonly selector: string
    readonly count: number
  }) => number
  /**
   * Graph document wire feature flags of the TARGET backend (the /api/nodes
   * dinkster.graphFeatures field, SchemaRegistry.graphFeatures). Gates
   * capability-negotiated lowering forms: with 'typedLiteral' present, a
   * tap literal into a non-concrete-typed input lowers to a $typed marker
   * instead of refusing with compile.tap.nonConcreteTarget. Absent or empty
   * = oldest wire, emit no negotiated forms.
   */
  readonly graphFeatures?: readonly string[]
  /** Submission-only worker hints, keyed by root runtime node id. */
  readonly placement?: Readonly<Record<string, string>>
}

const KNOWN_VALUE_TYPES: ReadonlySet<string> = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO'])

interface FlatNode {
  readonly runtimeId: string
  readonly occ: Occurrence
  readonly graphId: GraphDefId
  readonly node: NodeData
  readonly elab: NodeElab
  readonly selector?: NodeSelectorSpec
  /** Elaborated identity of selector.input, when this is a selector node. */
  readonly selectorInputKey?: string
  /** Elaborated identities of the selector's member inputs, in stored order. */
  readonly selectorMembers?: readonly string[]
  /** Members a stored, occurrence-effective pick leaves out; used only by would-run liveness. */
  selectorProjection?: { readonly inactive: readonly string[] }
  /** Inputs whose final staged value came from a real graph link/net. */
  readonly linkedInputs: Set<string>
  /** Staging record, keyed by ELABORATED input id (remapped to apiName at assembly). */
  readonly inputs: Record<string, Json | readonly [string, number]>
  /** An editable choice's authored options, keyed by the input its optionsInput names. */
  readonly authoredOptions?: ReadonlyMap<string, readonly string[]>
}

/** A Switch's branch names as its rows show them, in member order. */
const branchNamesOf = (fn: FlatNode): readonly string[] =>
  (fn.selectorMembers ?? []).map((member) =>
    fn.elab.inputsByValueKey.get(member)?.spec.displayName ?? member.slice(fn.selector!.group.length + 1))

/**
 * A node's elaborated interface, indexed for compilation. Computed once per
 * (definition, node) - every occurrence of a definition shares values,
 * dynamic state, and link connectivity, so the elaboration is identical.
 */
interface NodeElab {
  /** All elaborated inputs, in interface order (ghosts included). */
  readonly inputs: readonly ElaboratedInput[]
  /** All elaborated outputs, in interface order (ghosts included). */
  readonly outputs: readonly ElaboratedOutput[]
  /** Stored member keys of each group that holds outputs. */
  readonly outputMembers?: Readonly<Record<string, readonly string[]>>
  /** The key of every choice and type choice that takes part in the run. */
  readonly choices?: Readonly<Record<string, string>>
  /** Non-port values the run carries. */
  readonly submissionValues: readonly { readonly path: string; readonly apiPath: string; readonly value: Json }[]
  /**
   * PERSISTED value key -> input: the key under which a document stores this
   * input's value, its flattened id. A collision between two inputs is a
   * detectable duplicate, never a silent mis-route.
   */
  readonly inputsByValueKey: ReadonlyMap<string, ElaboratedInput>
  /** portAddressKey(port) -> input (for link/bind targets). */
  readonly inputsByAddr: ReadonlyMap<string, ElaboratedInput>
  /** portAddressKey(port) -> output, wireable or not. */
  readonly outputsByAddr: ReadonlyMap<string, ElaboratedOutput>
  /** portAddressKey(port) -> wire index (wireable outputs only). */
  readonly outputIndexByAddr: ReadonlyMap<string, number>
}

/** A synthesized, unpersisted member anywhere in the path. */
const hasSyntheticAncestor = (ancestry?: readonly { readonly synthetic?: boolean }[]): boolean =>
  ancestry?.some((a) => a.synthetic) ?? false

/**
 * Dynamic-scoped value keys (any dotted path - static input ids never
 * contain '.') may be DORMANT by design: inactive
 * combo branches, hidden DynamicSlot dependents, and removed members keep
 * their values so switching back restores them. Never warn about those;
 * only a plain top-level key matching no input is junk worth flagging.
 */
const isDynamicScopedValueKey = (key: string): boolean => key.includes('.')

interface ResolvedNodeInput {
  readonly runtimeId: string
  /** The input's flattened id (= spec.id): the FlatNode.inputs staging key. */
  readonly inputId: string
  readonly input: ElaboratedInput
}
interface ResolvedOutput {
  readonly runtimeId: string
  readonly outputIndex: number
}
interface ResolvedStructuralSource {
  readonly structuralSource: {
    readonly path: readonly NodeId[]
    readonly defId: string
    readonly endpoint: LinkEndpoint
    readonly typeId?: string
  }
}
/**
 * An output whose value is known before running (the schema's knownValue):
 * the node and the input whose resolved value the output passes on. The
 * route continues at that input instead of invoking the node.
 */
interface KnownValueAt {
  readonly path: readonly NodeId[]
  readonly defId: string
  readonly node: NodeId
  readonly input: ElaboratedInput
}
interface ResolvedKnownValue {
  readonly knownValue: KnownValueAt
}
/**
 * An output resolution that landed on a BYPASSED node: where it lives and
 * which of its outputs was asked for, so the passthrough trace can pick the
 * matching driven input and continue upstream from there.
 */
interface BypassAt {
  readonly path: readonly NodeId[]
  readonly defId: string
  readonly ref: PortRef
}

export function compile(input: CompileInput): CompileResult {
  return compileImpl(input, false).result
}

/** A field a primitive's value reaches, found by the fed-fields query. */
interface FedConsumer {
  readonly sources: readonly ControllerInputSource[]
  readonly terminal: ControllerNodeInputSource
  readonly ref: PortRef
  readonly input: InputSpec
}

interface FedFieldsQuery {
  readonly query: 'fedFields'
  readonly document: WorkflowDocument
  readonly resolve: SchemaResolver
}

interface CompileTraversalResult {
  result: CompileResult
  structural?: ReadonlyMap<string, ScopeStructuralGraph>
  inactiveExclusive?: ReadonlyMap<string, ReadonlySet<string>>
}

/**
 * Shared implementation behind {@link compile} (real submissions) and
 * {@link scopeClosure} (would-run previews). In would-run mode a random
 * Switch pick keeps every branch (superset: "may run"), and the reroutes on
 * in-closure wires are recorded per graph definition for highlighting.
 *
 * A would-run artifact must be DISCARDED and never submitted.
 */
function compileImpl(input: CompileInput, wouldRun: boolean): CompileTraversalResult
function compileImpl(input: FedFieldsQuery, wouldRun: boolean): { consumers: readonly FedConsumer[] }
function compileImpl(
  input: CompileInput | FedFieldsQuery,
  wouldRun: boolean,
): CompileTraversalResult | { consumers: readonly FedConsumer[] } {
  const doc = input.document
  const queryingSources = 'query' in input
  const options = queryingSources ? undefined : input
  const scope: ExecutionScope = queryingSources ? { kind: 'full' } : input.scope
  const sourceConsumers: FedConsumer[] = []
  const resolve = documentResolver(doc, input.resolve)
  // A primitive's value field is the widget the canvas draws for it, so an
  // empty primitive passes on the value its row shows. Working out which
  // fields it feeds is itself a query and sees the declared fields.
  const resolveNode = documentNodeResolver(doc, input.resolve,
    queryingSources ? undefined : documentPrimitiveResolver(doc, input.resolve))
  const isVirtualNode = (graphId: string, node: NodeData): boolean =>
    node.virtual === true && resolveNode(graphId, node)?.virtual === true
  /**
   * Capability gate for the $typed graph wire form: absent = the target
   * server would pass the marker through as a plain literal dict, so HOLD
   * the lowering and refuse loudly instead.
   */
  const emitTypedLiterals = options?.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_TYPED_LITERAL) ?? false
  const emitDecimalInts = options?.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_DECIMAL_INT) ?? false
  const emitAbsentInputs = options?.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_ABSENT_INPUT) ?? false
  const emitRegions = options?.graphFeatures?.includes(DINKSTER_GRAPH_FEATURE_REGIONS) ?? false
  const diags: Diagnostic[] = []
  const elaborationDiagnosticOwners = new Map<Diagnostic, {
    readonly graphId: GraphDefId
    readonly nodeId: NodeId
    readonly runtimeId?: string
  }>()
  const flat = new Map<string, FlatNode>()
  interface RegionLowering {
    readonly runtimeId: string
    readonly occ: Occurrence
    readonly node: NodeData
    readonly parentDefId: GraphDefId
    readonly childId: GraphDefId
    readonly childPath: readonly NodeId[]
    readonly stateOutputAliases: ReadonlyMap<string, string>
  }
  const regions = new Map<string, RegionLowering>()
  /** runtimeId -> inputId -> promoted-value override (first write wins: outer beats inner). */
  const overrides = new Map<string, Map<string, Json>>()
  interface ControllerSource {
    readonly source: ControllerNodeInputSource
    readonly widget: WidgetSpec
    readonly ownerPriority: number
  }
  /** runtimeId -> inputId -> effective controller sources, outside-in. */
  const controllerSources = new Map<string, Map<string, ControllerSource[]>>()
  const sourcePromotions = new Map<string, ControllerNodeInputSource[]>()
  const literalControllers = new Map<string, Map<string, {
    readonly sources: readonly ControllerInputSource[]
    readonly widget?: WidgetSpec
  }>>()
  const recordControllerSource = (
    target: ResolvedNodeInput,
    graph: GraphDefId,
    occurrence: Occurrence,
    input: ElaboratedInput,
    ownerPriority: number,
  ): void => {
    const source: ControllerNodeInputSource = { graph, occurrence, valueKey: valueKeyOf(input) }
    const widget = input.spec.widget
    if (widget?.controller !== 'after_generate') return
    let byInput = controllerSources.get(target.runtimeId)
    if (!byInput) controllerSources.set(target.runtimeId, (byInput = new Map()))
    let sources = byInput.get(target.inputId)
    if (!sources) byInput.set(target.inputId, (sources = []))
    if (sources.some((candidate) =>
      candidate.source.graph === source.graph &&
      candidate.source.occurrence.node === source.occurrence.node &&
      candidate.source.valueKey === source.valueKey)) return
    sources.push({ source, widget, ownerPriority })
  }
  /** Every (defId, instancePath) at which a graph definition is instantiated. */
  const graphOccurrences: { defId: GraphDefId; path: readonly NodeId[] }[] = []
  const liveness = new LivenessDerivation()
  const recordSuccessfulDelivery = (target: ResolvedNodeInput): void => {
    liveness.recordSuccessfulDestination(target.runtimeId, target.input.address)
  }

  const graphOf = (defId: string): GraphDef | undefined => doc.graphs[defId]

  /**
   * A tap on a field the node declares but does not hold now: a member that
   * was removed, or a row under an option or type-led pin that is not
   * chosen. Its wire stays and gives nothing.
   */
  const tapsAbsentRow = (defId: string, nodeId: NodeId, tap: string): boolean => {
    const node = graphOf(defId)?.nodes[nodeId]
    const schema = node && resolveNode(defId, node)
    if (!node || !schema) return false
    return [...constructsOf(schema, node.dynamic).keys()].some((construct) => tap.startsWith(`${construct}.`))
  }

  /**
   * The muted node the last port resolution stopped at, by the name the user
   * sees: its title, else its type's name, else its id. Set where a
   * resolution returns 'muted', read right after it.
   */
  let lastMuted: string | undefined
  const nameOf = (defId: string, node: NodeData): string => node.title ?? resolveNode(defId, node)?.displayName ?? node.id
  const markMuted = (defId: string, node: NodeData): 'muted' => {
    lastMuted = nameOf(defId, node)
    return 'muted'
  }

  const anchorOf = (path: readonly NodeId[], node: NodeId): { occurrence: Occurrence } => ({
    occurrence: { instancePath: path, node },
  })

  // compile.schema.unknown is scope-sensitive. An unresolved node never
  // enters `flat`, so it can never reach the prompt; it is fatal only when
  // the executed scope needs it - a consumer inside the executed closure
  // draws from it, or a partial-execution target names it. A stray
  // unresolved node elsewhere in the document must not block the run
  // (muted/bypassed unresolved nodes already compile fine, same principle).
  // The executed scope is not known until liveness derives it, so every
  // unresolved-schema diagnostic starts as an error and registers here with
  // the runtime ids of the consumers whose scope membership decides it;
  // settleUnknownSchema() then demotes the ones no included node depends on.
  const pendingUnknownSchema = new Map<Diagnostic, Set<string>>()
  const unknownSchemaDiag = (path: readonly NodeId[], node: NodeData): Diagnostic => {
    const diagnostic = diag('error', 'compile', 'compile.schema.unknown', `unknown node type '${node.type}'`, { anchor: anchorOf(path, node.id), data: { nodeType: node.type } })
    pendingUnknownSchema.set(diagnostic, new Set())
    return diagnostic
  }
  const attachUnknownSchemaDependents = (sink: readonly Diagnostic[], dependents: readonly string[]): void => {
    if (dependents.length === 0) return
    for (const diagnostic of sink) {
      const deciders = pendingUnknownSchema.get(diagnostic)
      if (deciders) for (const dependent of dependents) deciders.add(dependent)
    }
  }
  const settleUnknownSchema = (executedScope: ReadonlySet<string>): void => {
    for (const [diagnostic, deciders] of pendingUnknownSchema) {
      if ([...deciders].some((dependent) => executedScope.has(dependent))) continue
      ;(diagnostic as { severity: Diagnostic['severity'] }).severity = 'warning'
    }
    pendingUnknownSchema.clear()
  }
  /** Unresolved occurrences seen at collection: occurrence key -> node type. */
  const unresolvedCollected = new Map<string, string>()

  const scanRegions = (defId: GraphDefId, path: readonly NodeId[], stack: ReadonlySet<GraphDefId>): void => {
    if (stack.has(defId)) return
    const def = graphOf(defId)
    if (!def) return
    const nextStack = new Set(stack).add(defId)
    for (const node of Object.values(def.nodes)) {
      if (isVirtualNode(defId, node)) continue
      const mode = node.mode ?? 'active'
      if (node.region !== undefined) {
        if (mode === 'muted') continue
        const occurrence = { instancePath: path, node: node.id }
        if (mode === 'bypassed') {
          diags.push(diag('error', 'compile', 'compile.region.bypassUnsupported', 'region occurrences cannot be bypassed because their list contracts have no positional passthrough', { anchor: { occurrence } }))
          continue
        }
      }
      const childId = subgraphDefIdOf(node.type)
      if (childId !== undefined) {
        if (mode === 'active') scanRegions(asGraphDefId(childId), [...path, node.id], nextStack)
        continue
      }
    }
  }
  scanRegions(doc.root, [], new Set())
  if (!queryingSources && diags.some((diagnostic) => diagnostic.severity === 'error')) {
    return { result: { ok: false, diagnostics: diags } }
  }
  // -- Occurrence contexts
  //
  // One context per GRAPH OCCURRENCE. A promoted editable menu and input
  // connectivity projected through a boundary make an inner node's
  // interface occurrence-dependent; that state exists only here - derived
  // per compile, never persisted, never shared between occurrences.

  interface OccCtx {
    readonly defId: GraphDefId
    readonly path: readonly NodeId[]
    /** nodeId -> occurrence-local dynamic state (promoted editable menus, constructs shown whole). */
    readonly overlays: Map<NodeId, Readonly<Record<string, DynamicPortState>>>
    /** nodeId -> occurrence-local values (fields and constructs a subgraph node shows). */
    readonly values: Map<NodeId, Readonly<Record<string, Json>>>
    /** nodeId -> input addresses projected through boundaries from outer graphs. */
    readonly extraIn: Map<NodeId, ProjectedAddress[]>
  }
  // Node ids may contain every separator character, including NUL. Encode the
  // segment array itself so distinct occurrence paths cannot share a cache
  // entry or routed-vertex identity.
  const pathKey = (path: readonly NodeId[]): string => JSON.stringify(path)
  const topologyKey = (path: readonly NodeId[], defId: string): string => JSON.stringify([defId, path])
  const occCtxByPath = new Map<string, OccCtx>()
  const newOccCtx = (defId: GraphDefId, path: readonly NodeId[]): OccCtx => {
    const ctx: OccCtx = { defId, path, overlays: new Map(), values: new Map(), extraIn: new Map() }
    occCtxByPath.set(pathKey(path), ctx)
    return ctx
  }
  const projectedLegSuppressions = new Set(
    Object.values(doc.occurrenceTopologies ?? {}).flatMap((topology) =>
      (topology.suppressedDeliveries ?? [])
        .filter((suppression) => suppression.kind === 'projectedLeg')
        .map((suppression) => JSON.stringify([
          [...topology.owner.instancePath, topology.owner.node],
          suppressedDeliveryKey(suppression),
        ])),
    ),
  )
  const routeIsSuppressed = (
    ownerPath: readonly NodeId[],
    delivery: ParentDeliveryIdentity | undefined,
    route: readonly BoundaryRouteLeg[],
  ): boolean => delivery !== undefined && projectedLegSuppressions.has(JSON.stringify([
    ownerPath,
    suppressedDeliveryKey({ kind: 'projectedLeg', delivery, route }),
  ]))

  interface ProjectedAddress {
    readonly address: PortAddress
    readonly delivery?: ParentDeliveryIdentity
    readonly route: readonly BoundaryRouteLeg[]
  }

  interface TopologyConnection {
    readonly from: LinkEndpoint
    readonly to: LinkEndpoint
    readonly identity: EffectiveLinkIdentity
    readonly what: string
    readonly delivery?: ParentDeliveryIdentity
  }
  const topologyCache = new Map<string, readonly TopologyConnection[]>()
  const projectedRerouteDrivers = new Map<string, ReadonlyMap<string, LocatedDriver>>()
  const topologyFor = (path: readonly NodeId[], defId: GraphDefId): readonly TopologyConnection[] => {
    const key = topologyKey(path, defId)
    const cached = topologyCache.get(key)
    if (cached) return cached
    const connections: TopologyConnection[] = []
    if (path.length === 0) {
      const def = graphOf(defId)
      for (const link of Object.values(def?.links ?? {})) connections.push({
        from: link.from,
        to: link.to,
        identity: { kind: 'definition', graphId: defId, linkId: link.id },
        what: `link '${link.id}'`,
        delivery: { kind: 'link', graph: defId, linkId: link.id },
      })
      for (const net of Object.values(def?.nets ?? {})) for (const to of net.sinks) connections.push({
        from: net.source,
        to,
        identity: { kind: 'definitionNetSink', graphId: defId, netId: net.id, to },
        what: `net '${net.name}'`,
        delivery: { kind: 'netSink', graph: defId, netId: net.id, to },
      })
    } else {
      const owner: Occurrence = { instancePath: path.slice(0, -1), node: path[path.length - 1]! }
      const effective = effectiveOccurrenceTopology(doc, input.resolve, owner)
      diags.push(...effective.diagnostics)
      projectedRerouteDrivers.set(key, new Map(effective.projectedParentLinks.flatMap((link) =>
        link.to.graphId === defId && isRerouteRef(link.to.endpoint)
          ? [[link.to.endpoint.reroute, { endpoint: link.from.endpoint, path: link.from.instancePath, defId: link.from.graphId }] as const]
          : [])))
      for (const link of effective.links) {
        const delivery: ParentDeliveryIdentity | undefined = link.identity.kind === 'definition'
          ? { kind: 'link', graph: link.identity.graphId, linkId: link.identity.linkId }
          : link.identity.kind === 'definitionNetSink'
            ? { kind: 'netSink', graph: link.identity.graphId, netId: link.identity.netId, to: link.identity.to }
            : undefined
        connections.push({
          from: link.from.endpoint,
          to: link.to.endpoint,
          identity: link.identity,
          what: link.identity.kind === 'occurrence'
            ? `occurrence link '${link.identity.linkId}'`
            : link.identity.kind === 'definition'
              ? `link '${link.identity.linkId}'`
              : link.identity.kind === 'definitionNetSink'
                ? `net '${effective.bodyGraph.nets[link.identity.netId]?.name ?? link.identity.netId}'`
                : `projected ${link.identity.kind}`,
          ...(delivery ? { delivery } : {}),
        })
      }
    }
    topologyCache.set(key, connections)
    return connections
  }

  const topologyGraphFor = (path: readonly NodeId[], defId: GraphDefId): GraphDef => {
    const def = graphOf(defId)!
    const links = Object.fromEntries(topologyFor(path, defId).map((connection, index) => {
      const id = `__effective_${index}` as LinkId
      return [id, { id, from: connection.from, to: connection.to }]
    }))
    return { ...def, links, nets: {} }
  }

  // -- Elaborated interfaces (occurrence-aware, memoized) --------------------
  //
  // The compiler reasons over ELABORATED interfaces, not raw schema items:
  // dynamic families, combo branches, and slot dependents resolve here
  // through the exact same elaborateInterface the editor and solver use, so
  // compile and view can never disagree about which ports exist. Elaboration
  // is deterministic over (schema, node state, connectivity). For most nodes
  // those live in the definition, so every occurrence shares one cached
  // elaboration; a node with an occurrence overlay or projected connectivity
  // (forwarded-family target) elaborates per occurrence instead - the two
  // caches never mix because one instance must not see another's state.

  const connectivityCache = new Map<string, (node: NodeId) => Connectivity>()
  const connectivityFor = (path: readonly NodeId[], defId: GraphDefId): ((node: NodeId) => Connectivity) => {
    const key = topologyKey(path, defId)
    let c = connectivityCache.get(key)
    if (!c) {
      const def = graphOf(defId)
      connectivityCache.set(key, (c = def ? buildGraphConnectivity(topologyGraphFor(path, defId)) : () => EMPTY_CONNECTIVITY))
    }
    return c
  }

  const withExtraConnectivity = (
    base: Connectivity,
    ins: readonly ProjectedAddress[] | undefined,
  ): Connectivity => {
    if (!ins?.length) return base
    const inKeys = new Set(ins.map(({ address }) => portAddressKey(address.port)))
    return {
      isInputConnected: (p) => inKeys.has(portAddressKey(p)) || base.isInputConnected(p),
      isOutputConnected: base.isOutputConnected,
      inputPorts: () => [
        ...(base.inputPorts?.() ?? []),
        ...ins.map(({ address }) => address.port),
      ],
    }
  }

  const elabCache = new Map<string, Map<NodeId, NodeElab>>()
  const occElabCache = new Map<string, NodeElab>()
  const elabAt = (ctx: OccCtx, node: NodeData, schema: NodeSchema): NodeElab => {
    const overlay = ctx.overlays.get(node.id)
    const valuesOverlay = ctx.values.get(node.id)
    const extraIn = ctx.extraIn.get(node.id)
    const runtimeId = occurrenceKey({ instancePath: ctx.path, node: node.id })
    if (doc.occurrenceTopologies === undefined && overlay === undefined && valuesOverlay === undefined && extraIn === undefined) {
      return elabOf(ctx.defId, node, schema)
    }
    const hit = occElabCache.get(runtimeId)
    if (hit) return hit
    const state = overlay === undefined && valuesOverlay === undefined
      ? node
      : {
          values: valuesOverlay ?? node.values,
          ...(node.additionalInputs !== undefined ? { additionalInputs: node.additionalInputs } : {}),
          ...(overlay !== undefined ? { dynamic: overlay } : node.dynamic !== undefined ? { dynamic: node.dynamic } : {}),
        }
    const connectivity = withExtraConnectivity(connectivityFor(ctx.path, ctx.defId)(node.id), extraIn)
    const elab = buildElab(
      `${ctx.defId}/${node.id} @ ${runtimeId}`,
      node.id,
      node.type,
      schema,
      state,
      connectivity,
      { graphId: ctx.defId, nodeId: node.id, runtimeId },
    )
    occElabCache.set(runtimeId, elab)
    return elab
  }
  const elabOf = (defId: string, node: NodeData, schema: NodeSchema): NodeElab => {
    let byNode = elabCache.get(defId)
    if (!byNode) elabCache.set(defId, (byNode = new Map()))
    const hit = byNode.get(node.id)
    if (hit) return hit
    const elab = buildElab(
      `${defId}/${node.id}`,
      node.id,
      node.type,
      schema,
      node,
      connectivityFor([], defId as GraphDefId)(node.id),
      { graphId: asGraphDefId(defId), nodeId: node.id },
    )
    byNode.set(node.id, elab)
    return elab
  }

  function buildElab(
    where: string,
    nodeId: NodeId,
    nodeType: string,
    schema: NodeSchema,
    state: Pick<NodeData, 'values' | 'dynamic' | 'additionalInputs'>,
    connectivity: Connectivity,
    owner: { readonly graphId: GraphDefId; readonly nodeId: NodeId; readonly runtimeId?: string },
  ): NodeElab {
    // promoteGhosts: false - promotion is a view affordance for the one
    // frame before normalization persists a just-connected ghost. A compile
    // runs against normalized state; honoring promotion here would let a
    // persisted link whose lowering is dropped (muted endpoint, undriven
    // reroute) conjure an api-visible member that leaks values/defaults or
    // shifts output wire indexes.
    const e = elaborateInterface(schema, state, connectivity, { promoteGhosts: false, nodeId })
    // Elaboration diagnostics surface once per cache entry: once per
    // definition node normally, once per occurrence for overlaid nodes
    // (over-cap etc. genuinely depend on the merged occurrence state).
    // Errors (budget exhaustion) fail the compile - a truncated interface
    // must never produce a prompt.
    for (const d of e.diagnostics) {
      // A failed node rule keeps its data and names its node (and its one
      // field), so the editor's copy and this one read as one cause.
      const rule = d.code === 'node.rule.failed'
      const diagnostic = diag(d.severity, 'compile', d.code, `[${where}] ${d.message}`, {
        ...(d.anchor !== undefined ? { anchor: d.anchor } : {}),
        ...(rule ? { refs: ruleProblemRefs(d, owner.graphId, owner.nodeId), ...(d.data !== undefined ? { data: d.data } : {}) }
          : d.refs !== undefined ? { refs: d.refs } : {}),
      })
      diags.push(diagnostic)
      elaborationDiagnosticOwners.set(diagnostic, owner)
    }
    // Duplicate identities/wire names would silently overwrite one another
    // in the staging record or the prompt: reject the interface loudly
    // (schemas own uniqueness; this is the backstop).
    const dup = (code: string, what: string): void => {
      const diagnostic = diag('error', 'compile', code, `[${where}] '${nodeType}' elaborates duplicate ${what}`)
      diags.push(diagnostic)
      elaborationDiagnosticOwners.set(diagnostic, owner)
    }
    const inputs = elabInputsOf(e)
    const inputsByValueKey = new Map<string, ElaboratedInput>()
    const inputsByAddr = new Map<string, ElaboratedInput>()
    const apiNames = new Set<string>()
    for (const i of inputs) {
      const addr = portAddressKey(i.address.port)
      if (inputsByAddr.has(addr)) dup('compile.interface.duplicatePort', `input '${i.spec.id}'`)
      inputsByAddr.set(addr, i)
      const valueKey = valueKeyOf(i)
      if (inputsByValueKey.has(valueKey)) dup('compile.interface.duplicateValueKey', `value key '${valueKey}'`)
      inputsByValueKey.set(valueKey, i)
      if (i.apiName !== undefined) {
        if (apiNames.has(i.apiName)) dup('compile.interface.duplicateApiName', `wire name '${i.apiName}'`)
        apiNames.add(i.apiName)
      }
    }
    // Wire output index: position among WIREABLE elaborated outputs (the
    // interface the backend sees). Ghost/over-cap/unknown outputs stay
    // addressable (for precise link diagnostics) but never take an index.
    const outputs = elabOutputsOf(e)
    const outputsByAddr = new Map<string, ElaboratedOutput>()
    const outputIndexByAddr = new Map<string, number>()
    let outputIndex = 0
    for (const o of outputs) {
      const addr = portAddressKey(o.address.port)
      if (outputsByAddr.has(addr)) dup('compile.interface.duplicatePort', `output '${o.spec.id}'`)
      outputsByAddr.set(addr, o)
      if (o.wireable !== false) outputIndexByAddr.set(addr, outputIndex++)
    }
    return { inputs, outputs, ...(e.outputMembers ? { outputMembers: e.outputMembers } : {}), ...(e.choices ? { choices: e.choices } : {}), submissionValues: e.submissionValues, inputsByValueKey, inputsByAddr, outputsByAddr, outputIndexByAddr }
  }

  // -- Structural port resolution (walks definitions only; no flat state) ----
  //
  // 'muted' short-circuits BEFORE any schema/port validation: a muted
  // endpoint means the connection is dropped (a warning at the call site),
  // and a DEAD EDGE IS NOT AUDITED AT ALL - neither endpoint's structure,
  // schema, or ports fail the compile (callers resolve both ends into a
  // scratch sink and discard it when either end is muted). Muting a node
  // deliberately disables its edges; a disabled edge must not block a run
  // over stale state it no longer delivers.
  //
  // 'bypassed' short-circuits the same way, but with opposite intent: an
  // input-side hit means the edge is CONSUMED by passthrough (dropped here,
  // silently - downstream traces re-read it as a driver); an output-side hit
  // returns a BypassAt marker for the routed projection to continue upstream.
  //
  // `sink` collects this resolution's diagnostics (defaults to the compile's
  // main list). Note elabOf pushes to the main list directly by design:
  // elaboration facts are definition-level, not edge-level.

  function resolveInputPort(
    path: readonly NodeId[],
    defId: string,
    ref: PortRef,
    sink: Diagnostic[] = diags,
    delivery?: ParentDeliveryIdentity,
    boundaryRoute: readonly BoundaryRouteLeg[] = [],
    openRegion?: string,
  ): readonly ResolvedNodeInput[] | 'muted' | 'bypassed' | undefined {
    const def = graphOf(defId)
    const node = def?.nodes[ref.node]
    if (!def || !node) {
      sink.push(diag('error', 'compile', 'compile.link.danglingNode', `input ref names missing node '${ref.node}' in graph '${defId}'`))
      return undefined
    }
    if ((node.mode ?? 'active') === 'muted') return markMuted(defId, node)
    if (node.mode === 'bypassed') return 'bypassed'
    const childId = subgraphDefIdOf(node.type)
    if (childId !== undefined) {
      const regionRuntimeId = occurrenceKey({ instancePath: path, node: node.id })
      if (node.region !== undefined && openRegion !== regionRuntimeId) {
        const schema = resolveNode(defId, node)
        if (!schema) {
          sink.push(unknownSchemaDiag(path, node))
          return undefined
        }
        const ctx = occCtxByPath.get(pathKey(path))
        const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
        const input = elab.inputsByAddr.get(portAddressKey(ref.port))
        if (!input || input.apiName === undefined) {
          sink.push(diag('error', 'compile', 'compile.port.unknownInput', `'${node.type}' has no wireable input '${ref.port}'`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        if (routeIsSuppressed(path, delivery, boundaryRoute)) return []
        return [{ runtimeId: regionRuntimeId, inputId: input.spec.id, input }]
      }
      const child = graphOf(childId)
      // Boundary item selection goes through the ONE matcher (crossing.ts).
      const match = matchBoundaryItem(child?.boundary?.inputs ?? [], ref)
      if (!child || !match.ok) {
        const ambiguous = child && !match.ok && match.code === 'ambiguous'
        sink.push(diag(
          'error',
          'compile',
          ambiguous ? 'compile.boundary.ambiguousAddress' : 'compile.boundary.missingInput',
          ambiguous && !match.ok
            ? `subgraph '${childId}': ${match.message}`
            : `subgraph '${childId}' has no boundary input '${ref.port}'`,
          { anchor: anchorOf(path, node.id) },
        ))
        return undefined
      }
      const item = match.item
      // Fan-out (alsoBinds): one boundary input drives EVERY bound inner
      // input. Each binding resolves independently; muted/bypassed targets
      // drop out (their local edge is dead) while the edge stays alive for
      // the rest. With zero live targets the singular statuses collapse so
      // callers keep the existing dead-edge policy.
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      if (bindings.every((binding) => binding.viaReroute !== undefined)) return []
      const targets: ResolvedNodeInput[] = []
      let sawMuted = false
      let sawBypassed = false
      for (const b of bindings) {
        if (b.kind === 'unbound') continue
        // Junction deliveries lower through their retained internal links.
        if (b.viaReroute !== undefined) continue
        if (b.kind === 'widgetTap') {
          sink.push(diag('error', 'compile', 'compile.boundary.invalidInputBinding', `subgraph '${childId}' boundary input '${item.id}' cannot bind an output-only widget tap`, { anchor: anchorOf(path, node.id) }))
          continue
        }
        const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding: b }]
        if (routeIsSuppressed([...path, node.id], delivery, route)) continue
        let inner: PortRef = b
        if (b.kind === 'construct') {
          const port = innerConstructAddress(child, b, item.id, ref.port, (innerNode) => resolveNode(child.id, innerNode))
          if (port === undefined) {
            sink.push(diag('error', 'compile', 'compile.boundary.missingInput', `subgraph '${childId}' has no row '${ref.port}' in '${item.id}'`, { anchor: anchorOf(path, node.id) }))
            continue
          }
          inner = { node: b.node, port: asPortId(port) }
        }
        const r = resolveInputPort([...path, node.id], childId, inner, sink, delivery, route, openRegion)
        if (r === 'muted') sawMuted = true
        else if (r === 'bypassed') sawBypassed = true
        else if (r !== undefined) targets.push(...r)
      }
      if (targets.length > 0) return targets
      if (sawMuted) return 'muted'
      if (sawBypassed) return 'bypassed'
      return undefined
    }
    const schema = resolveNode(defId, node)
    if (!schema) {
      sink.push(unknownSchemaDiag(path, node))
      return undefined
    }
    const ctx = occCtxByPath.get(pathKey(path))
    const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
    const input = elab.inputsByAddr.get(portAddressKey(ref.port))
    if (!input) {
      sink.push(diag('error', 'compile', 'compile.port.unknownInput', `'${node.type}' has no input '${ref.port}'`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (input.apiName === undefined) {
      // Elaborated but never compiled: ghost subtree, beyond the family cap,
      // or an unknown-kind placeholder. A committed document must not wire
      // through such a port - loud error, never a silent drop.
      sink.push(diag('error', 'compile', 'compile.port.unwirable', `'${node.type}' input '${input.spec.id}' exists but never reaches the prompt (ghost/over-cap/unknown dynamic kind)`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (hasSyntheticAncestor(input.ancestry)) {
      // Min-fill members are interface-only until a command materializes
      // them; a committed reference to one is a stale/malformed document
      // never something to silently honor.
      sink.push(diag('error', 'compile', 'compile.port.unmaterialized', `${node.type}.${input.spec.id}: dynamic input member is not materialized`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (input.origin.kind === 'selector') {
      // A selector's value decides WHICH ports elaborate; a link or promoted
      // value cannot be honored without re-elaborating against it. Reject
      // rather than emit a prompt that contradicts its own interface.
      sink.push(diag('error', 'compile', 'compile.port.selector', `'${node.type}' input '${input.spec.id}' is a dynamic selector; it cannot be driven by links or promoted values`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (routeIsSuppressed(path, delivery, boundaryRoute)) return []
    return [{ runtimeId: occurrenceKey({ instancePath: path, node: node.id }), inputId: input.spec.id, input }]
  }

  function resolveOutputPort(
    path: readonly NodeId[],
    defId: string,
    ref: PortRef,
    sink: Diagnostic[] = diags,
    delivery?: ParentDeliveryIdentity,
    boundaryRoute: readonly BoundaryRouteLeg[] = [],
    openRegion?: string,
  ): ResolvedOutput | ResolvedStructuralSource | ResolvedKnownValue | 'muted' | { readonly bypass: BypassAt } | undefined {
    const def = graphOf(defId)
    if (ref.node === DINKSTER_REGION_PSEUDO_NODE) {
      sink.push(diag('error', 'compile', 'compile.region.invalidIndex', `'$region.${ref.port}' is available only as the immediate region index source`))
      return undefined
    }
    const node = def?.nodes[ref.node]
    if (!def || !node) {
      sink.push(diag('error', 'compile', 'compile.link.danglingNode', `output ref names missing node '${ref.node}' in graph '${defId}'`))
      return undefined
    }
    if ((node.mode ?? 'active') === 'muted') return markMuted(defId, node)
    if (node.mode === 'bypassed') return { bypass: { path, defId, ref } }
    const childId = subgraphDefIdOf(node.type)
    if (childId !== undefined) {
      const regionRuntimeId = occurrenceKey({ instancePath: path, node: node.id })
      if (node.region !== undefined && openRegion !== regionRuntimeId) {
        const schema = resolveNode(defId, node)
        if (!schema) {
          sink.push(unknownSchemaDiag(path, node))
          return undefined
        }
        const ctx = occCtxByPath.get(pathKey(path))
        const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
        const addr = portAddressKey(ref.port)
        const outputIndex = elab.outputIndexByAddr.get(addr)
        if (outputIndex === undefined) {
          sink.push(diag('error', 'compile', 'compile.port.unknownOutput', `'${node.type}' has no wireable output '${ref.port}'`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        return { runtimeId: regionRuntimeId, outputIndex }
      }
      const child = graphOf(childId)
      // Symmetric with the input side: one boundary matcher (crossing.ts).
      const match = matchBoundaryItem(child?.boundary?.outputs ?? [], ref)
      if (!child || !match.ok) {
        const ambiguous = child && !match.ok && match.code === 'ambiguous'
        sink.push(diag(
          'error',
          'compile',
          ambiguous ? 'compile.boundary.ambiguousAddress' : 'compile.boundary.missingOutput',
          ambiguous && !match.ok
            ? `subgraph '${childId}': ${match.message}`
            : `subgraph '${childId}' has no boundary output '${ref.port}'`,
          { anchor: anchorOf(path, node.id) },
        ))
        return undefined
      }
      const item = match.item
      if (item.binds.kind === 'unbound') return undefined
      if (item.binds.kind === 'widgetTap') {
        const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding: item.binds }]
        if (routeIsSuppressed([...path, node.id], delivery, route)) return undefined
        const childPath = [...path, node.id]
        const tapped = tappedInputs(childPath, childId, item.binds.node, item.binds.tap, sink)
        if (!tapped) {
          sink.push(diag('error', 'compile', 'compile.tap.missingInput', `${item.binds.node}.${item.binds.tap}: tapped input is missing in graph ${childId}`))
          return undefined
        }
        if (tapped !== 'muted' && tapped.some((input) => canonicalTypeIdOf(input.input.spec.type) === undefined)) {
          sink.push(diag('error', 'compile', 'compile.tap.nonConcrete', `${item.binds.node}.${item.binds.tap}: tapped input has no concrete type`))
          return undefined
        }
        return {
          structuralSource: {
            path: childPath,
            defId: childId,
            endpoint: { node: item.binds.node, tap: item.binds.tap },
          },
        }
      }
      const route = [...boundaryRoute, { graph: child.id, boundaryId: item.id, binding: item.binds }]
      if (routeIsSuppressed([...path, node.id], delivery, route)) return undefined
      if (item.binds.kind === 'construct') {
        const port = innerConstructAddress(child, item.binds, item.id, ref.port, (innerNode) => resolveNode(child.id, innerNode))
        if (port === undefined) {
          sink.push(diag('error', 'compile', 'compile.boundary.missingOutput', `subgraph '${childId}' has no row '${ref.port}' in '${item.id}'`, { anchor: anchorOf(path, node.id) }))
          return undefined
        }
        return resolveOutputPort([...path, node.id], childId, { node: item.binds.node, port: asPortId(port) }, sink, delivery, route, openRegion)
      }
      return resolveOutputPort([...path, node.id], childId, item.binds, sink, delivery, route, openRegion)
    }
    const schema = resolveNode(defId, node)
    if (!schema) {
      sink.push(unknownSchemaDiag(path, node))
      return undefined
    }
    const ctx = occCtxByPath.get(pathKey(path))
    const elab = ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)
    const addr = portAddressKey(ref.port)
    const output = elab.outputsByAddr.get(addr)
    if (!output) {
      sink.push(diag('error', 'compile', 'compile.port.unknownOutput', `'${node.type}' has no output '${ref.port}'`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    if (hasSyntheticAncestor(output.ancestry)) {
      sink.push(diag('error', 'compile', 'compile.port.unmaterialized', `${node.type}.${output.spec.id}: dynamic output member is not materialized`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    const outputIndex = elab.outputIndexByAddr.get(addr)
    if (outputIndex === undefined) {
      // Elaborated but not wireable (ghost/over-cap/unknown) - mirror of the
      // input-side apiName check.
      sink.push(diag('error', 'compile', 'compile.port.unwirable', `'${node.type}' output '${output.spec.id}' exists but never takes part in wiring (ghost/over-cap/unknown dynamic kind)`, { anchor: anchorOf(path, node.id) }))
      return undefined
    }
    // Inside a region body the value can differ per element, so the node runs.
    const inRegion = [...regions.values()].some((region) => path.length >= region.childPath.length &&
      region.childPath.every((segment, index) => path[index] === segment))
    const known = !inRegion && output.spec.knownValue && elab.inputsByValueKey.get(output.spec.knownValue.input)
    // A known value applies only to a value of a primitive or choice type. An
    // input typed by a variable has none until the variable is bound, so the
    // node runs.
    const knownType = known ? canonicalTypeIdOf(known.spec.type) : undefined
    if (known && knownType !== undefined && KNOWN_VALUE_TYPES.has(knownType)) {
      return { knownValue: { path, defId, node: node.id, input: known } }
    }
    return { runtimeId: occurrenceKey({ instancePath: path, node: node.id }), outputIndex }
  }

  // -- Bypass passthrough tracing -------------------------------------------
  //
  // A consumer edge whose producer resolves onto a bypassed node re-routes
  // through that node: pick the matching DRIVEN input (bypass.ts owns the
  // rule), follow its driver through reroutes, and continue - the driver may
  // land on another bypassed node (chain), a muted node (dead edge), or a
  // known value (bake). Everything here operates on ELABORATED interfaces,
  // so subgraph instances (boundary schemas), dynamic members, and forwarded
  // families all match by the same machinery as plain static ports.

  const rerouteIndexCache = new Map<string, RerouteIndex>()
  const rerouteIndexFor = (path: readonly NodeId[], defId: GraphDefId): RerouteIndex => {
    const key = topologyKey(path, defId)
    let idx = rerouteIndexCache.get(key)
    if (!idx) {
      const def = graphOf(defId)
      idx = def
        ? buildRerouteIndex(topologyGraphFor(path, defId))
        : { driverOf: new Map(), successorsOf: new Map(), inputDriverOf: new Map(), netSourceOf: new Map() }
      rerouteIndexCache.set(key, idx)
    }
    return idx
  }

  // Random Switch picks land in `selectorChoices` so the artifact
  // reproduces the exact execution (frozen views, re-runs).
  const selectorChoices: SelectorChoice[] = []

  // -- Would-run bookkeeping (scopeClosure only) ------------------------------
  //
  // `wouldRunVia` records the reroutes each consumer's wires traverse -
  // merged at the end for consumers that land in the closure.
  // `wouldRunInputEdges` records every projected producer per destination
  // input. Input identity is kept so backend lazy selectors can choose one
  // branch without changing the exact staged prompt.
  const wouldRunVia = wouldRun
    ? new Map<string, { inputKey: string; entries: { defId: string; via: TraceVia }[] }[]>()
    : undefined
  const wouldRunInputEdges = wouldRun ? new Map<string, Map<string, Set<string>>>() : undefined
  /** Switches whose known text names no branch: their pick is refused, so would-run stays neutral. */
  const refusedPicks = new Set<string>()
  /** Per-definition driver of each node input address (links + net sinks; first wins). */
  const inputDriverCache = new Map<string, Map<NodeId, Map<string, LinkEndpoint>>>()
  const inputDriverIndexFor = (path: readonly NodeId[], defId: GraphDefId): Map<NodeId, Map<string, LinkEndpoint>> => {
    const key = topologyKey(path, defId)
    let idx = inputDriverCache.get(key)
    if (idx) return idx
    const built = new Map<NodeId, Map<string, LinkEndpoint>>()
    const record = (node: NodeId, addrKey: string, from: LinkEndpoint): void => {
      let byAddr = built.get(node)
      if (!byAddr) built.set(node, (byAddr = new Map()))
      if (!byAddr.has(addrKey)) byAddr.set(addrKey, from)
    }
    for (const connection of topologyFor(path, defId)) {
      if (isPortEndpoint(connection.to)) record(connection.to.node, portAddressKey(connection.to.port), connection.from)
    }
    inputDriverCache.set(key, built)
    return built
  }

  /** A driver endpoint plus the graph occurrence its topology lives in. */
  interface LocatedDriver {
    readonly endpoint: LinkEndpoint
    readonly path: readonly NodeId[]
    readonly defId: string
  }

  /**
   * What drives `(node, address)` as seen from graph occurrence (path,
   * defId)? An intra-definition link/net wins; otherwise, when the input is
   * bound by one of this definition's boundary INPUT items ('port' kind),
   * climb to the parent occurrence and look for a driver of the instance's
   * corresponding port - repeatedly, so chained boundary bindings resolve.
   */
  function driverOfInput(
    path: readonly NodeId[],
    defId: string,
    node: NodeId,
    address: PortAddress,
  ): LocatedDriver | undefined {
    let curPath = path
    let curDefId = defId
    let curNode = node
    let curPort: string = address.port
    for (;;) {
      const drv = inputDriverIndexFor(curPath, curDefId as GraphDefId).get(curNode)?.get(portAddressKey(curPort))
      if (drv) return { endpoint: drv, path: curPath, defId: curDefId }
      if (curPath.length === 0) return undefined
      const def = graphOf(curDefId)
      // The outer address that reaches this inner port: a field's item id, or
      // the row under a construct the subgraph node shows whole.
      let outerPort: string | undefined
      for (const i of def?.boundary?.inputs ?? []) {
        for (const b of [i.binds, ...(i.alsoBinds ?? [])]) {
          if (outerPort !== undefined || (b.kind !== 'port' && b.kind !== 'construct') || b.node !== curNode) continue
          outerPort = b.kind === 'port'
            ? (b.port === curPort ? i.id : undefined)
            : outerConstructAddress(def!, b, i.id, curPort, (inner) => resolveNode(curDefId, inner))
        }
      }
      if (outerPort === undefined) return undefined
      const instanceNode = curPath[curPath.length - 1]!
      const parentPath = curPath.slice(0, -1)
      const parentCtx = occCtxByPath.get(pathKey(parentPath))
      if (!parentCtx) return undefined
      curPath = parentPath
      curDefId = parentCtx.defId
      curNode = instanceNode
      curPort = outerPort
    }
  }

  type BypassTrace =
    | { readonly kind: 'output'; readonly src: ResolvedOutput }
    /**
     * A baked literal. `typeId` is the source's canonical runtime type when
     * one is known (tap fallbacks always carry it), feeding the $typed
     * lowering for non-concrete destinations.
     */
    | { readonly kind: 'value'; readonly value: Json; readonly typeId?: string; readonly controllerSources?: readonly ControllerInputSource[]; readonly controllerWidget?: WidgetSpec }
    /** `node` names the muted node the route reached, for the reason sent with $absent. */
    | { readonly kind: 'muted'; readonly reason: string; readonly node?: string }
    /** `absent`: the wire gives nothing (its field is no longer part of its node), sent as $absent when the server takes it. */
    | { readonly kind: 'dropped'; readonly reason: string; readonly absent?: true }

  type RouteAt =
    | { readonly kind: 'bypass'; readonly bypass: BypassAt }
    | { readonly kind: 'known'; readonly known: KnownValueAt }
    | { readonly kind: 'endpoint'; readonly path: readonly NodeId[]; readonly defId: string; readonly endpoint: LinkEndpoint; readonly typeId?: string }

  interface SelectedBypassHop {
    readonly at: BypassAt
    readonly occurrenceKey: string
    readonly output: ElaboratedOutput
    readonly input: ElaboratedInput
    readonly inputIndex: number
    readonly driver: LocatedDriver
  }

  /**
   * The single structural bypass selection operation. Both projections use
   * this result; would-run may not rediscover an interface or rematch a
   * bypass input.
   */
  const selectBypassHop = (at: BypassAt, consumerType?: TypeExpr): SelectedBypassHop | undefined => {
    const def = graphOf(at.defId)
    const node = def?.nodes[at.ref.node]
    const schema = node && resolveNode(at.defId, node)
    if (!node || !schema) return undefined
    const ctx = occCtxByPath.get(pathKey(at.path))
    const elab = ctx ? elabAt(ctx, node, schema) : elabOf(at.defId, node, schema)
    const address = portAddressKey(at.ref.port)
    const output = elab.outputsByAddr.get(address)
    const outputIndex = elab.outputIndexByAddr.get(address)
    if (!output || outputIndex === undefined) return undefined
    const candidates: BypassCandidate<{ readonly driver: LocatedDriver; readonly input: ElaboratedInput }>[] = []
    let wireIndex = 0
    for (const input of elab.inputs) {
      if (input.apiName === undefined || hasSyntheticAncestor(input.ancestry)) continue
      const index = wireIndex++
      const driver = driverOfInput(at.path, at.defId, at.ref.node, input.address)
      if (driver) candidates.push({ index, type: input.spec.type, driver: { driver, input } })
    }
    const selected = matchBypassInput(
      { index: outputIndex, type: consumerType ?? output.spec.type },
      candidates,
    )
    return selected && {
      at,
      occurrenceKey: occurrenceKey({ instancePath: at.path, node: at.ref.node }),
      output,
      input: selected.driver.input,
      inputIndex: selected.index,
      driver: selected.driver.driver,
    }
  }

  function projectRoute(
    start: RouteAt,
    projection: RouteProjection,
    sink: Diagnostic[],
    consumerType?: TypeExpr,
    viaFor?: (defId: string) => TraceVia,
    delivery?: ParentDeliveryIdentity,
  ): readonly BypassTrace[] {
    const result = traverseRoutedProjection<RouteAt, SelectedBypassHop, BypassTrace>(start, projection, {
      key: (at) => at.kind === 'bypass'
        ? JSON.stringify(['bypass', occurrenceKey({ instancePath: at.bypass.path, node: at.bypass.ref.node }), portAddressKey(at.bypass.ref.port)])
        : at.kind === 'known'
          ? JSON.stringify(['known', occurrenceKey({ instancePath: at.known.path, node: at.known.node }), at.known.input.spec.id])
          : JSON.stringify(['endpoint', at.path, at.defId, at.endpoint]),
      cycle: (at) => {
        if (at.kind === 'known') {
          if (projection === 'exact') sink.push(diag('error', 'compile', 'compile.knownValue.cycle', `${at.known.node}.${at.known.input.spec.id}: the value passes through a cycle`, { anchor: anchorOf(at.known.path, at.known.node) }))
          return [{ kind: 'dropped', reason: `known value cycle at '${at.known.node}'` }]
        }
        if (projection === 'exact') {
          if (at.kind === 'bypass') sink.push(diag('error', 'compile', 'compile.bypass.cycle', `bypass passthrough through '${at.bypass.ref.node}' in graph '${at.bypass.defId}' forms a cycle`, { anchor: anchorOf(at.bypass.path, at.bypass.ref.node) }))
          else if (isRerouteRef(at.endpoint)) sink.push(diag('error', 'compile', 'compile.reroute.cycle', `Reroute ${at.endpoint.reroute}: connection chain forms a cycle`))
          else if (isWidgetTapRef(at.endpoint)) sink.push(diag('error', 'compile', 'compile.tap.cycle', `${at.endpoint.node}.${at.endpoint.tap}: tap connection forms a cycle`))
        }
        return [{ kind: 'dropped', reason: at.kind === 'bypass'
          ? `bypass cycle at '${at.bypass.ref.node}'`
          : `endpoint cycle at ${JSON.stringify(at.endpoint)}` }]
      },
      route: (at, selectedProjection): { readonly steps: readonly RoutedStep<RouteAt, BypassTrace>[]; readonly hop?: SelectedBypassHop } => {
        if (at.kind === 'endpoint') {
          const def = graphOf(at.defId)
          if (!def) return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `graph definition '${at.defId}' is unavailable` } }] }
          const index = rerouteIndexFor(at.path, at.defId as GraphDefId)
          const endpoint = at.endpoint
          if (isRerouteRef(endpoint)) {
            viaFor?.(at.defId).reroutes.add(endpoint.reroute)
            const driver = rerouteDriverOf(def, endpoint.reroute, index)
            if (driver) return { steps: [{ kind: 'recurse', at: { kind: 'endpoint', path: at.path, defId: at.defId, endpoint: driver.from } }] }
            const projected = projectedRerouteDrivers.get(topologyKey(at.path, at.defId))?.get(endpoint.reroute)
            if (projected) return { steps: [{ kind: 'recurse', at: { kind: 'endpoint', ...projected } }] }
            if (selectedProjection === 'exact') sink.push(diag('warning', 'compile', 'compile.reroute.undriven', `Reroute ${endpoint.reroute}: no input connection`))
            return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `reroute '${endpoint.reroute}' is undriven` } }] }
          }
          if (isWidgetTapRef(endpoint)) {
            const ref: PortRef = { node: endpoint.node, port: endpoint.tap }
            const driver = index.inputDriverOf.get(portRefKey(ref))
            const netSource = index.netSourceOf.get(portRefKey(ref))
            if (driver || netSource) return { steps: [{ kind: 'recurse', at: { kind: 'endpoint', path: at.path, defId: at.defId, endpoint: driver?.from ?? netSource! } }] }
            const absent = tappedInputs(at.path, at.defId, endpoint.node, endpoint.tap, []) === undefined &&
              tapsAbsentRow(at.defId, endpoint.node, endpoint.tap)
            if (absent) return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `field '${endpoint.node}.${endpoint.tap}' is no longer part of its node`, absent: true } }] }
            const tapped = tapValue(at.path, at.defId, endpoint.node, endpoint.tap, sink)
            if (tapped === 'muted') return { steps: [{ kind: 'terminal', terminal: { kind: 'muted', reason: `widget tap '${endpoint.node}.${endpoint.tap}' reaches a muted occurrence`, ...(lastMuted !== undefined ? { node: lastMuted } : {}) } }] }
            if (tapped === undefined) {
              if (selectedProjection === 'exact') sink.push(diag('error', 'compile', 'compile.tap.novalue', `${endpoint.node}.${endpoint.tap}: tapped input has no value`))
              return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `widget tap '${endpoint.node}.${endpoint.tap}' has no value` } }] }
            }
            return { steps: [{ kind: 'terminal', terminal: { kind: 'value', value: tapped.value, typeId: tapped.typeId } }] }
          }
          const resolved = resolveOutputPort(at.path, at.defId, endpoint, sink, delivery)
          if (resolved === 'muted') return { steps: [{ kind: 'terminal', terminal: { kind: 'muted', reason: `producer '${endpoint.node}' is muted or in an inactive occurrence`, ...(lastMuted !== undefined ? { node: lastMuted } : {}) } }] }
          if (!resolved) return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `producer endpoint ${JSON.stringify(endpoint)} cannot deliver` } }] }
          return 'bypass' in resolved
            ? { steps: [{ kind: 'recurse', at: { kind: 'bypass', bypass: resolved.bypass } }] }
            : 'structuralSource' in resolved
              ? { steps: [{ kind: 'recurse', at: { kind: 'endpoint', ...resolved.structuralSource } }] }
            : 'knownValue' in resolved
              ? { steps: [{ kind: 'recurse', at: { kind: 'known', known: resolved.knownValue } }] }
            : { steps: [{ kind: 'terminal', terminal: { kind: 'output', src: resolved } }] }
        }
        if (at.kind === 'known') {
          // The node is not invoked. A wired input passes its producer on;
          // otherwise the input's occurrence-effective value is baked into
          // the consumer, and an after-run control on it stays the node's own.
          const { path: knownPath, defId: knownDefId, node: knownNode, input } = at.known
          // A link from a muted producer passes nothing on, not the node's own value.
          const driver = driverOfInput(knownPath, knownDefId, knownNode, input.address)
          if (driver) return { steps: [{ kind: 'recurse', at: { kind: 'endpoint', path: driver.path, defId: driver.defId, endpoint: driver.endpoint } }] }
          const tapped = tapValue(knownPath, knownDefId, knownNode, input.spec.id, sink)
          if (tapped === 'muted') return { steps: [{ kind: 'terminal', terminal: { kind: 'muted', reason: `'${knownNode}' is muted`, ...(lastMuted !== undefined ? { node: lastMuted } : {}) } }] }
          const runtimeId = occurrenceKey({ instancePath: knownPath, node: knownNode })
          const sources: readonly ControllerInputSource[] = [
            ...(controllerSources.get(runtimeId)?.get(input.spec.id) ?? []).map((source) => source.source),
            { graph: asGraphDefId(knownDefId), occurrence: { instancePath: knownPath, node: knownNode }, valueKey: valueKeyOf(input) },
          ]
          // Working out a primitive's range needs the fields it feeds whether
          // or not it holds a value or declares a widget yet.
          if (selectedProjection === 'spec') return { steps: [{ kind: 'terminal', terminal: { kind: 'value', value: tapped?.value ?? null, controllerSources: sources } }] }
          if (tapped === undefined) {
            if (selectedProjection === 'exact') sink.push(diag('error', 'compile', 'compile.knownValue.novalue', `${knownNode}.${input.spec.id}: the value it passes on is not set`, { anchor: anchorOf(knownPath, knownNode) }))
            return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `'${knownNode}.${input.spec.id}' has no value` } }] }
          }
          const widget = input.spec.widget
          return { steps: [{ kind: 'terminal', terminal: { kind: 'value', value: tapped.value, typeId: tapped.typeId,
            ...(widget !== undefined ? { controllerSources: sources, controllerWidget: widget } : {}) } }] }
        }
        const bypass = at.bypass
        const selected = selectBypassHop(bypass, consumerType)
        if (!selected) {
          if (selectedProjection === 'exact') {
          const node = graphOf(bypass.defId)?.nodes[bypass.ref.node]
          const schema = node && resolveNode(bypass.defId, node)
          if (!node) {
            // A dangling bypass occurrence was already diagnosed while its
            // structural endpoint was resolved.
          } else if (!schema) {
            sink.push(unknownSchemaDiag(bypass.path, node))
          } else {
            const ctx = occCtxByPath.get(pathKey(bypass.path))
            const elab = ctx ? elabAt(ctx, node, schema) : elabOf(bypass.defId, node, schema)
            const requested = elab.outputsByAddr.get(portAddressKey(bypass.ref.port))
            if (!requested || !elab.outputIndexByAddr.has(portAddressKey(bypass.ref.port))) {
              sink.push(diag('error', 'compile', 'compile.port.unknownOutput', `${node.type}.${portAddressKey(bypass.ref.port)}: bypass output is not wireable`, { anchor: anchorOf(bypass.path, bypass.ref.node) }))
            } else {
              sink.push(diag('warning', 'compile', 'compile.bypass.unrouted', `${node.type}.${requested.spec.id}: bypass has no matching driven input`, { anchor: anchorOf(bypass.path, bypass.ref.node) }))
            }
          }
          }
          return { steps: [{ kind: 'terminal', terminal: { kind: 'dropped', reason: `bypassed '${bypass.ref.node}' has no matching driven input` } }] }
        }
        return { hop: selected, steps: [{ kind: 'recurse', at: { kind: 'endpoint', path: selected.driver.path, defId: selected.driver.defId, endpoint: selected.driver.endpoint } }] }
      },
    })
    if (projection === 'exact' && result.hops.length > 0 && result.terminals.some((terminal) => terminal.kind === 'muted' || terminal.kind === 'dropped')) {
      const first = result.hops[0]!
      const dead = result.terminals.find((terminal) => terminal.kind === 'muted' || terminal.kind === 'dropped')!
      sink.push(diag('warning', 'compile', 'compile.bypass.structuralRouteDropped', `${first.at.ref.node}.${first.input.spec.id}: selected bypass route has no value`, {
        anchor: anchorOf(first.at.path, first.at.ref.node),
        data: { reason: dead.reason, inputIndex: first.inputIndex, output: first.output.spec.id, route: result.hops.map((hop) => hop.occurrenceKey) },
      }))
    }
    return result.terminals
  }

  // -- Pass 1: discover occurrences, derive overlays, collect ---------------
  //
  // Outside-in, so an instance's OWN occurrence-local state (overlay from
  // ITS parent) exists before its child context is built. Promoted values
  // are NOT resolved here: value resolution needs the complete occurrence
  // index (a chained value can cross several boundaries), so it runs as a
  // separate pass over `pendingPromotions`.
  // Promoted output counts are the exception: they determine interface
  // shape and must enter the child context before its nodes elaborate.

  /** Per-definition index of link/net input endpoint addresses by node (for projection). */
  const addrIndexCache = new Map<string, Map<NodeId, ProjectedAddress[]>>()
  const addrIndexFor = (path: readonly NodeId[], defId: GraphDefId): Map<NodeId, ProjectedAddress[]> => {
    const key = topologyKey(path, defId)
    let idx = addrIndexCache.get(key)
    if (idx) return idx
    const built = new Map<NodeId, ProjectedAddress[]>()
    for (const connection of topologyFor(path, defId)) {
      if (!isPortEndpoint(connection.to)) continue
      let ins = built.get(connection.to.node)
      if (!ins) built.set(connection.to.node, (ins = []))
      ins.push({
        address: { port: connection.to.port },
        ...(connection.delivery ? { delivery: connection.delivery } : {}),
        route: [],
      })
    }
    addrIndexCache.set(key, built)
    return built
  }

  const pendingPromotions: { parentCtx: OccCtx; node: NodeData; childId: GraphDefId }[] = []

  function collectNodes(defId: GraphDefId, path: readonly NodeId[], ctx: OccCtx): void {
    const def = graphOf(defId)
    if (!def) {
      diags.push(diag('error', 'compile', 'compile.graph.missing', `graph definition '${defId}' not found`))
      return
    }
    graphOccurrences.push({ defId, path })
    for (const authored of Object.values(def.nodes)) {
      const overlay = ctx.overlays.get(authored.id)
      const valuesOverlay = ctx.values.get(authored.id)
      const node = overlay === undefined && valuesOverlay === undefined
        ? authored
        : { ...authored, ...(overlay !== undefined ? { dynamic: overlay } : {}), ...(valuesOverlay !== undefined ? { values: valuesOverlay } : {}) }
      if (isVirtualNode(defId, node)) continue
      const mode = node.mode ?? 'active'
      // Muted and bypassed nodes never enter the prompt. A bypassed subgraph
      // instance also never recurses: bypass acts at the boundary schema, so
      // the definition's contents are as absent as a bypassed leaf's body.
      if (mode === 'muted' || mode === 'bypassed') continue
      const childId = subgraphDefIdOf(node.type)
      if (childId !== undefined) {
        const child = graphOf(childId)
        if (!child?.boundary) {
          diags.push(diag('error', 'compile', 'compile.subgraph.missing', `node '${node.id}' references missing/boundary-less subgraph '${childId}'`, { anchor: anchorOf(path, node.id) }))
          continue
        }
        const childPath = [...path, node.id]
        if (node.region !== undefined) {
          const schema = resolveNode(defId, node)
          if (!schema) {
            unresolvedCollected.set(occurrenceKey({ instancePath: path, node: node.id }), node.type)
            diags.push(unknownSchemaDiag(path, node))
            continue
          }
          const occ: Occurrence = { instancePath: path, node: node.id }
          const runtimeId = occurrenceKey(occ)
          const elab = elabAt(ctx, node, schema)
          flat.set(runtimeId, {
            runtimeId,
            occ,
            graphId: asGraphDefId(defId),
            node,
            elab,
            linkedInputs: new Set(),
            inputs: {},
          })
          regions.set(runtimeId, {
            runtimeId,
            occ,
            node,
            parentDefId: defId,
            childId: asGraphDefId(childId),
            childPath,
            stateOutputAliases: new Map(Object.entries(node.region.outputRoles ?? {}).flatMap(([outputId, role]) =>
              role.kind === 'state' ? [[outputId, role.statePort] as const] : [])),
          })
        }
        const instanceDynamic = ctx.overlays.get(node.id) ?? node.dynamic
        const resolveChildNode = (inner: NodeData): NodeSchema | undefined => resolveNode(child.id, inner)
        const problems = boundaryOutputFanOutProblems(child)
        if (problems.length > 0) {
          for (const p of problems) {
            diags.push(diag('error', 'compile', p.code, `${p.message} (node '${node.id}')`, { anchor: anchorOf(path, node.id) }))
          }
          continue
        }
        const childCtx = newOccCtx(asGraphDefId(childId), childPath)
        for (const [target, dynamic] of projectEditableOptions(child, instanceDynamic, resolveChildNode)) {
          childCtx.overlays.set(target, dynamic)
        }
        const constructs = projectConstructs(child, { values: node.values, ...(instanceDynamic !== undefined ? { dynamic: instanceDynamic } : {}) }, resolveChildNode, childCtx.overlays)
        for (const [target, dynamic] of constructs.dynamic) childCtx.overlays.set(target, dynamic)
        for (const [target, values] of constructs.values) childCtx.values.set(target, values)
        // Concrete input connectivity also crosses the boundary. DynamicSlot
        // reads link existence during elaboration, before ordinary endpoint
        // lowering, so project every primary and fan-out target now.
        const connected = [...(addrIndexFor(path, defId).get(node.id) ?? []), ...(ctx.extraIn.get(node.id) ?? [])]
        for (const projected of connected) {
          const match = matchBoundaryItem(child.boundary.inputs, projected.address)
          if (!match.ok) continue
          if (match.item.binds.kind === 'construct') {
            for (const source of [match.item.binds, ...(match.item.alsoBinds ?? [])]) {
              if (source.kind !== 'construct') continue
              const port = innerConstructAddress(child, source, match.item.id, projected.address.port, resolveChildNode)
              const route = [...projected.route, { graph: child.id, boundaryId: match.item.id, binding: source }]
              if (port === undefined || routeIsSuppressed(childPath, projected.delivery, route)) continue
              let list = childCtx.extraIn.get(source.node)
              if (!list) childCtx.extraIn.set(source.node, (list = []))
              list.push({ address: { port: asPortId(port) }, ...(projected.delivery ? { delivery: projected.delivery } : {}), route })
            }
            continue
          }
          if (match.item.binds.kind !== 'port') continue
          for (const source of [match.item.binds, ...(match.item.alsoBinds ?? [])]) {
            if (source.kind !== 'port') continue
            const bindings = source.viaReroute === undefined
              ? [source]
              : (rerouteInputTargets(child, source.viaReroute) ?? []).map((target) => ({ kind: 'port' as const, ...target }))
            for (const binding of bindings) {
              const route = [...projected.route, { graph: child.id, boundaryId: match.item.id, binding: source }]
              if (routeIsSuppressed(childPath, projected.delivery, route)) continue
              let list = childCtx.extraIn.get(binding.node)
              if (!list) childCtx.extraIn.set(binding.node, (list = []))
              list.push({
                address: { port: binding.port },
                ...(projected.delivery ? { delivery: projected.delivery } : {}),
                route,
              })
            }
          }
        }
        if (node.region === undefined) pendingPromotions.push({ parentCtx: ctx, node, childId: asGraphDefId(childId) })
        collectNodes(asGraphDefId(childId), childPath, childCtx)
        continue
      }
      const schema = resolveNode(defId, node)
      if (!schema) {
        unresolvedCollected.set(occurrenceKey({ instancePath: path, node: node.id }), node.type)
        diags.push(unknownSchemaDiag(path, node))
        continue
      }
      const occ: Occurrence = { instancePath: path, node: node.id }
      const runtimeId = occurrenceKey(occ)
      const elab = elabAt(ctx, node, schema)
      const authoredOptions = new Map<string, readonly string[]>()
      for (const input of elab.inputs) {
        const widget = input.spec.widget
        const target = widget?.optionsInput ??
          widget?.representations?.representations.find((item) => item.widget.optionsInput !== undefined)?.widget.optionsInput
        if (target !== undefined) authoredOptions.set(target, (node.dynamic?.[valueKeyOf(input)]?.options ?? []).map(String))
      }
      const selectorInputKey = schema.selector === undefined
        ? undefined
        : elab.inputsByValueKey.get(schema.selector.input)?.spec.id
      const selectorMembers = schema.selector === undefined
        ? undefined
        : selectorMembersOf(schema.selector, elab.inputs)
      flat.set(runtimeId, {
        runtimeId,
        occ,
        graphId: asGraphDefId(defId),
        node,
        elab,
        ...(schema.selector !== undefined ? { selector: schema.selector } : {}),
        ...(selectorInputKey !== undefined ? { selectorInputKey } : {}),
        ...(selectorMembers !== undefined ? { selectorMembers } : {}),
        linkedInputs: new Set(),
        inputs: {},
        ...(authoredOptions.size > 0 ? { authoredOptions } : {}),
      })
    }
  }

  collectNodes(doc.root, [], newOccCtx(doc.root, []))

  // -- Pass 1.5: promoted-value overrides (outside-in; first write wins) -----
  //
  // Runs only after EVERY occurrence exists: a value held by an outer
  // instance resolves through every nested boundary it is promoted across.
  // Values use the same resolver links use - one address interpreter.

  for (const { parentCtx, node, childId } of pendingPromotions) {
    const child = graphOf(childId)
    if (!child?.boundary) continue
    const childPath = [...parentCtx.path, node.id]
    const parentSchema = resolveNode(parentCtx.defId, node)
    const parentElab = parentSchema ? elabAt(parentCtx, node, parentSchema) : undefined
    const ownerOccurrence: Occurrence = { instancePath: parentCtx.path, node: node.id }
    const record = (target: ResolvedNodeInput, v: Json): void => {
      let byInput = overrides.get(target.runtimeId)
      if (!byInput) overrides.set(target.runtimeId, (byInput = new Map()))
      if (!byInput.has(target.inputId)) byInput.set(target.inputId, v)
    }
    for (const item of child.boundary.inputs) {
      if (item.binds.kind !== 'port') continue
      const v = node.values[item.id]
      const ownerInput = item.promoted === true ? parentElab?.inputsByValueKey.get(item.id) : undefined
      if (v === undefined && ownerInput === undefined) continue
      // Fan-out: a promoted value bakes into EVERY bound target (primary
      // and alsoBinds alike) - targets must never diverge under one
      // boundary value.
      let ownerPriority = 0
      const targets = [item.binds, ...(item.alsoBinds ?? [])].flatMap((binding) => binding.viaReroute === undefined
        ? [binding]
        : (rerouteInputTargets(child, binding.viaReroute) ?? []).map((target) => ({ kind: 'port' as const, ...target })))
      for (const b of targets) {
        if (b.kind === 'widgetTap' || b.kind === 'unbound') continue
        const targets = resolveInputPort(childPath, childId, b)
        // Muted/bypassed inner targets compile nothing; a promoted value for
        // them is dormant (bypass forwards connections, never widget values).
        if (!targets || targets === 'muted' || targets === 'bypassed') continue
        for (const target of targets) {
          if (ownerInput !== undefined) {
            recordControllerSource(target, parentCtx.defId, ownerOccurrence, ownerInput, ownerPriority)
          }
          if (v !== undefined) record(target, v)
          ownerPriority += 1
        }
      }
    }
  }

  // -- Pass 2: values -> overrides -> links (connections beat values) --------

  /**
   * The runtime type of a widget-held literal when it DIFFERS from the
   * input's declared type. Asset-source references stored by an ASSET widget
   * on a concrete
   * NON-asset-reference input have runtime type asset<T> (one ref: decode
   * arm, incl. asset<list<T>> onto a list<T> input) or list<asset<T>> (N
   * refs: merge arm onto scalar T, lift arm onto list<T>), never the
   * declared type. Undefined everywhere else: asset-REFERENCE destinations
   * (bare ASSET, asset<...>, lists of either) receive refs AS-IS per
   * the joint pins - stamping there would route a valid plain delivery into
   * the coercion planner, which has no asset-to-asset vocabulary; non-ASSET
   * widgets and non-ref-shaped values pass through untouched. No scalar-T
   * ASSET binding is schema-expressible today (backend AssetWidget binding
   * policy, 72c0719) - this keeps lowering correct for fixtures and for
   * the ledgered relaxation, with the server planner enforcing anyway.
   */
  const assetSourceTypeOf = (input: ElaboratedInput, value: Json): string | undefined => {
    if (input.spec.widget?.widgetType !== 'ASSET') return undefined
    if (input.spec.widget.selection === true && input.spec.type.kind === 'union') {
      if (typeof value === 'string') return 'COMBO'
      if (isAssetRefValue(value)) return 'ASSET'
      return undefined
    }
    const dstTypeId = canonicalTypeIdOf(input.spec.type)
    if (dstTypeId === undefined || isAssetRefDestinationTypeId(dstTypeId)) return undefined
    if (isAssetRefValue(value)) return assetTypeId(dstTypeId)
    if (!Array.isArray(value) || value.length === 0 || !value.every(isAssetRefValue)) return undefined
    // N refs: merge arm on a scalar destination (list<asset<T>>), lift arm
    // on a list<T> destination (list<asset<T>> with T = the list element).
    const element = parseListTypeId(dstTypeId)
    return listTypeId(assetTypeId(element ?? dstTypeId))
  }

  const solvedTypeCache = new Map<string, ReturnType<typeof solveGraphTypes>>()
  const solvedTypesOf = (graphId: string): ReturnType<typeof solveGraphTypes> | undefined => {
    const graph = doc.graphs[graphId]
    if (graph === undefined) return undefined
    let solved = solvedTypeCache.get(graphId)
    if (!solved) solvedTypeCache.set(graphId, (solved = solveGraphTypes(graph, resolve, { resolveNode: (node) => resolveNode(graph.id, node) })))
    return solved
  }
  /**
   * The type a primitive typed by a type variable holds: the one the fields
   * it feeds bind the variable to. Its value is a plain literal, so it is
   * stamped with that type, as the engine binds the variable from it. A
   * backend without typed literals keeps receiving the plain value.
   */
  const primitiveValueTypeOf = (fn: FlatNode, input: ElaboratedInput, value: Json): string | undefined => {
    if (!emitTypedLiterals || input.spec.type.kind !== 'variable' || parseTypedLiteralWire(value) !== undefined) return undefined
    if (!fn.elab.outputs.some((output) => output.spec.knownValue?.input === input.spec.id)) return undefined
    const bound = solvedTypesOf(fn.graphId)?.portTypeOf(fn.node.id, 'input', input.address.port)
    return bound === undefined ? undefined : canonicalTypeIdOf(bound)
  }

  /**
   * Lower ONE widget-held literal onto its own declared input: stamp $typed
   * for a numeric-union widget or an asset source differing from the declared
   * type, so the backend receives a concrete source type. Concrete numeric
   * inputs keep their plain literals.
   * Stamping needs the typedLiteral capability; without it, REFUSE loudly
   * (error diag, input omitted - returns undefined) instead of silently
   * passing raw refs the server would wrap as the declared type - the same
   * loud-refusal contract as the tap/bypass paths. Unobservable against
   * real servers (a pre-typed-literal backend cannot declare the schemas
   * that reach this arm), but fixtures and the ledgered scalar-T binding
   * relaxation must not silently mis-lower.
   */
  const stagedNodeDiagnostics = new Map<string, Diagnostic[]>()
  const stagedDiagnosticsFor = (fn: FlatNode): Diagnostic[] => {
    let sink = stagedNodeDiagnostics.get(fn.runtimeId)
    if (!sink) stagedNodeDiagnostics.set(fn.runtimeId, (sink = []))
    return sink
  }
  const lowerWidgetLiteral = (
    fn: FlatNode,
    input: ElaboratedInput,
    value: Json,
    sink: Diagnostic[] = diags,
  ): Json | undefined => {
    const type = input.spec.type
    if (emitRegions && type.kind === 'union' && type.names.length === 2 &&
      type.names.includes('FLOAT') && type.names.includes('INT') && input.spec.widget !== undefined) {
      if (emitTypedLiterals) return typedLiteralWire('FLOAT', value) as Json
      sink.push(diag('error', 'compile', 'compile.value.numericUnionUnsupported', `${fn.node.type}.${input.spec.id}: backend cannot preserve the numeric widget type`, { anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port } as PortRef } }))
      return undefined
    }
    if (canonicalTypeIdOf(input.spec.type) === 'INT' && isCanonicalUnsafeInteger(value)) {
      if (emitDecimalInts) return decimalIntegerWire(value)
      sink.push(diag('error', 'compile', 'compile.value.decimalIntUnsupported', `${fn.node.type}.${input.spec.id}: backend cannot preserve this large integer`, { anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port } as PortRef } }))
      return undefined
    }
    const sourceType = assetSourceTypeOf(input, value) ?? primitiveValueTypeOf(fn, input, value)
    if (sourceType === undefined) return value
    if (emitTypedLiterals) return typedLiteralWire(sourceType, value) as Json
    sink.push(diag('error', 'compile', 'compile.value.assetSourceUnsupported', `${fn.node.type}.${input.spec.id}: backend cannot preserve the asset source type`, { anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port } as PortRef } }))
    return undefined
  }

  for (const fn of flat.values()) {
    const nodeDiags = stagedDiagnosticsFor(fn)
    for (const [key, value] of Object.entries(fn.node.values)) {
      const input = fn.elab.inputsByValueKey.get(key)
      if (!input) {
        // Dormant dynamic-scoped values (inactive combo branches, hidden
        // dependents, removed members) are preserved-by-design state, not
        // junk - never warn, never compile.
        if (!isDynamicScopedValueKey(key)) {
          nodeDiags.push(diag('warning', 'compile', 'compile.value.unknownInput', `${fn.node.type}.${key}: stored value has no matching input`, { anchor: { occurrence: fn.occ } }))
        }
        continue
      }
      if (input.apiName === undefined) continue
      // Stage under the ELABORATED id (identical to the persisted value key).
      const lowered = lowerWidgetLiteral(fn, input, value, nodeDiags)
      if (lowered !== undefined) fn.inputs[input.spec.id] = lowered
    }
    const byInput = overrides.get(fn.runtimeId)
    if (byInput) {
      // Indexed once per node, not per override (a heavily promoted node
      // would otherwise scan the input list quadratically).
      const inputsById = new Map(fn.elab.inputs.map((i) => [i.spec.id, i]))
      for (const [inputId, v] of byInput) {
        const input = inputsById.get(inputId)
        if (!input) {
          // Promoted overrides resolve through real input ports, so an id
          // outside the elaborated interface is a compiler invariant
          // violation. Refuse loudly and omit - staging the value raw would
          // ship an un-lowered literal past every stamping rule.
          nodeDiags.push(diag('error', 'compile', 'compile.internal.overrideUnresolved', `internal: promoted override targets unknown input '${inputId}' on '${fn.node.type}'`, { anchor: { occurrence: fn.occ } }))
          continue
        }
        const lowered = lowerWidgetLiteral(fn, input, v, nodeDiags)
        if (lowered !== undefined) fn.inputs[inputId] = lowered
      }
    }
    // Derived values (combo selectors) are authoritative and applied LAST:
    // the elaborated interface (which branch inputs exist) was computed FROM
    // this selection, so nothing - not even a promoted override - may
    // contradict it in the prompt. Occurrence-level selector overrides need
    // occurrence-state forwarding to re-elaborate first.
    for (const input of fn.elab.inputs) {
      if (input.derivedValue !== undefined && input.apiName !== undefined) {
        fn.inputs[input.spec.id] = input.derivedValue
      }
    }
  }

  /** Resolve a tap without treating bypass as erasing the node's document value. */
  const tappedInputs = (
    path: readonly NodeId[],
    defId: string,
    nodeId: NodeId,
    inputId: string,
    sink: Diagnostic[] = diags,
  ): readonly ResolvedNodeInput[] | 'muted' | undefined => {
    const ref: PortRef = { node: nodeId, port: inputId as PortRef['port'] }
    const resolved = resolveInputPort(path, defId, ref, sink)
    if (resolved !== 'bypassed') return resolved
    // Bypass changes dataflow only. The bypassed node itself is absent from
    // `flat`, so recover its occurrence-aware elaborated input directly and
    // use the same staged-value precedence below.
    const node = graphOf(defId)?.nodes[nodeId]
    const schema = node && resolveNode(defId, node)
    const ctx = occCtxByPath.get(pathKey(path))
    const input = node && schema
      ? (ctx ? elabAt(ctx, node, schema) : elabOf(defId, node, schema)).inputsByAddr.get(portAddressKey(ref.port))
      : undefined
    if (!node || !input) return undefined
    return [{ runtimeId: occurrenceKey({ instancePath: path, node: nodeId }), inputId: input.spec.id, input }]
  }

  /**
   * The value a tap delivers PLUS the tapped input's canonical type id -
   * the stamp a $typed lowering wraps the literal with when the destination
   * is not concrete-typed (compile.tap.nonConcrete already guarantees the
   * SOURCE type is known, so typeId is never a guess).
   */
  const tapValue = (
    path: readonly NodeId[],
    defId: string,
    nodeId: NodeId,
    inputId: string,
    sink: Diagnostic[] = diags,
  ): { readonly value: Json; readonly typeId: string } | 'muted' | undefined => {
    const inputs = tappedInputs(path, defId, nodeId, inputId, sink)
    if (inputs === 'muted') return 'muted'
    if (!inputs || inputs.length === 0) return undefined
    const input = inputs[0]!
    const typeId = canonicalTypeIdOf(input.input.spec.type)
    if (typeId === undefined) return undefined
    // The value's TRUE runtime type, not blindly the tapped input's declared
    // type: a staged value may already carry an asset-source stamp (the
    // scalar-T decode/merge arms lower through lowerWidgetLiteral before
    // links) - unwrap it instead of double-wrapping; raw stored/override/
    // fallback refs on those inputs re-derive the same source type.
    const staged = flat.get(input.runtimeId)?.inputs[input.inputId]
      ?? overrides.get(input.runtimeId)?.get(input.inputId)
    if (staged !== undefined) {
      const decimalInteger = parseDecimalIntegerWire(staged)
      if (decimalInteger !== undefined) return { value: decimalInteger, typeId: 'INT' }
      const stamped = parseTypedLiteralWire(staged)
      if (stamped !== undefined) return { value: stamped.value, typeId: stamped.type }
      return { value: staged, typeId: assetSourceTypeOf(input.input, staged) ?? typeId }
    }
    const node = graphOf(defId)?.nodes[nodeId]
    const stored = node?.values?.[valueKeyOf(input.input)]
    if (stored !== undefined) return { value: stored, typeId: assetSourceTypeOf(input.input, stored) ?? typeId }
    // Schema default, then the widget kind's intrinsic value - a tapped INT
    // widget showing 0 taps as 0; only kinds with no intrinsic value (ASSET,
    // remote COMBO, ...) leave the tap valueless.
    const widget = input.input.spec.widget
    const fallback = widget ? effectiveWidgetDefault(widget) : undefined
    return fallback === undefined ? undefined : { value: fallback, typeId: assetSourceTypeOf(input.input, fallback) ?? typeId }
  }

  for (const { defId, path } of graphOccurrences) {
    const def = graphOf(defId)
    if (!def) continue
    const rerouteIndex = rerouteIndexFor(path, defId)
    const connections: { from: LinkEndpoint; to: PortRef; what: string; delivery?: ParentDeliveryIdentity }[] = []
    const recordWouldRunConnection = (from: LinkEndpoint, to: PortRef, delivery?: ParentDeliveryIdentity): void => {
      if (!wouldRunVia || !wouldRunInputEdges) return
      const scratch: Diagnostic[] = []
      const dsts = resolveInputPort(path, defId, to, scratch, delivery)
      const live = dsts !== undefined && dsts !== 'muted' && dsts !== 'bypassed'
        ? dsts.filter((d) => flat.has(d.runtimeId))
        : []
      for (const destination of live) {
        let byInput = wouldRunInputEdges.get(destination.runtimeId)
        if (!byInput) wouldRunInputEdges.set(destination.runtimeId, (byInput = new Map()))
        let producers = byInput.get(destination.inputId)
        if (!producers) byInput.set(destination.inputId, (producers = new Set()))
        const vias = new Map<string, TraceVia>()
        const viaFor = (routeDefId: string): TraceVia => {
          let via = vias.get(routeDefId)
          if (!via) vias.set(routeDefId, (via = { reroutes: new Set() }))
          return via
        }
        const all = projectRoute({ kind: 'endpoint', path, defId, endpoint: from }, queryingSources ? 'spec' : 'would-run', scratch, destination.input.spec.type, viaFor, delivery)
        const connections = wouldRunVia.get(destination.runtimeId)
        const recorded = [...vias].map(([routeDefId, via]) => ({ defId: routeDefId, via }))
        const record = { inputKey: destination.inputId, entries: recorded }
        if (connections) connections.push(record)
        else wouldRunVia.set(destination.runtimeId, [record])
        let anyCandidateDelivers = false
        for (const terminal of all) {
          if (terminal.kind === 'value') {
            anyCandidateDelivers = true
            if (queryingSources && terminal.controllerSources !== undefined) {
              const consumer = flat.get(destination.runtimeId)!
              // A Switch's Pick that takes names offers its branch names, so
              // a Choice that feeds it lists them.
              const pickByName = consumer.selector?.names !== undefined && destination.inputId === consumer.selectorInputKey
              sourceConsumers.push({ sources: terminal.controllerSources,
                terminal: { graph: consumer.graphId, occurrence: consumer.occ, valueKey: valueKeyOf(destination.input) },
                ref: { node: consumer.occ.node, ...destination.input.address, port: destination.input.address.port as PortRef['port'] },
                input: pickByName
                  ? { ...destination.input.spec, widget: { widgetType: 'COMBO', options: { options: [...branchNamesOf(consumer)] } } }
                  : destination.input.spec,
              })
            }
            continue
          }
          if (terminal.kind !== 'output') continue
          anyCandidateDelivers = true
          if (!flat.has(terminal.src.runtimeId)) continue
          producers.add(terminal.src.runtimeId)
          // A primitive typed by a variable runs instead of passing on its
          // value, but its value field still takes its widget from the
          // fields it feeds.
          const source = queryingSources ? flat.get(terminal.src.runtimeId)! : undefined
          const known = source?.elab.outputs.filter((output) => output.wireable !== false)[terminal.src.outputIndex]?.spec.knownValue
          const knownInput = known === undefined ? undefined : source!.elab.inputsByValueKey.get(known.input)
          if (source !== undefined && knownInput !== undefined) {
            const consumer = flat.get(destination.runtimeId)!
            sourceConsumers.push({
              sources: [{ graph: source.graphId, occurrence: source.occ, valueKey: valueKeyOf(knownInput) }],
              terminal: { graph: consumer.graphId, occurrence: consumer.occ, valueKey: valueKeyOf(destination.input) },
              ref: { node: consumer.occ.node, ...destination.input.address, port: destination.input.address.port as PortRef['port'] },
              input: destination.input.spec,
            })
          }
        }
        if (anyCandidateDelivers) recordSuccessfulDelivery(destination)
      }
    }
    for (const connection of topologyFor(path, defId)) {
      const link = connection
      if (isWidgetTapRef(link.from)) {
        const tapped = tappedInputs(path, defId, link.from.node, link.from.tap, [])
        const givesNothing = !tapped && tapsAbsentRow(defId, link.from.node, link.from.tap)
        // A wire that gives nothing is sent as $absent by the route below when
        // the server takes it. Otherwise the input is left out of the prompt,
        // as for a muted producer, and the warning says what that does.
        if (givesNothing && !emitAbsentInputs) {
          const into = isPortEndpoint(link.to) ? ` into '${link.to.node}.${link.to.port}'` : ''
          diags.push(diag('warning', 'compile', 'compile.link.dropped',
            `The wire from '${link.from.node}.${link.from.tap}'${into} gives nothing: that field is no longer part of its node. Until a run can send nothing, the input is left out: a field sends its own value, and a required input without one refuses the run.`,
            { anchor: anchorOf(path, link.from.node) }))
        } else if (!tapped && !givesNothing) {
          diags.push(diag('error', 'compile', 'compile.tap.missingInput', `${link.from.node}.${link.from.tap}: tapped input is missing in graph ${defId}`))
          continue
        } else if (tapped && tapped !== 'muted' && tapped.some((i) => canonicalTypeIdOf(i.input.spec.type) === undefined)) {
          diags.push(diag('error', 'compile', 'compile.tap.nonConcrete', `${link.from.node}.${link.from.tap}: tapped input has no concrete type`))
          continue
        }
      }
      // Reroutes lower away: links INTO a reroute are structural feeds
      // (consumed when tracing), links FROM one trace to the real producer.
      if (isRerouteRef(link.to)) continue
      if (isWidgetTapRef(link.to)) {
        diags.push(diag('error', 'compile', 'compile.link.invalidTarget', `${link.what} in graph '${defId}' targets a widget tap; widget taps have no inputs`))
        continue
      }
      // Would-run recording happens before exact lowering and uses the same
      // route engine. Hypothetical branches write no diagnostics.
      if (!isPortEndpoint(link.to)) continue
      recordWouldRunConnection(link.from, link.to, link.delivery)
      if (queryingSources) continue
      connections.push({ from: link.from, to: link.to, what: link.what, ...(link.delivery ? { delivery: link.delivery } : {}) })
    }
    /**
     * A wire whose source is a muted node's output gives nothing: the input is
     * sent $absent when the server takes it, and its absence policy decides
     * (a required input skips its node). On a server without it the input is
     * left out as before, with the warning: it then sends its field's own
     * value or refuses the run.
     */
    const givesNothingFromMuted = (dst: ResolvedNodeInput, muted: string, what: string, defId: string): void => {
      const receiver = emitAbsentInputs ? flat.get(dst.runtimeId) : undefined
      if (receiver === undefined) {
        diags.push(diag('warning', 'compile', 'compile.link.dropped', `${what} in graph '${defId}': connected node is muted`))
        return
      }
      receiver.inputs[dst.inputId] = absentInputWire(`'${muted}' is muted`)
      receiver.linkedInputs.delete(dst.inputId)
      recordSuccessfulDelivery(dst)
    }
    for (const c of connections) {
      // Both endpoints resolve into a SCRATCH sink: if either end is muted
      // the edge is dead and NOTHING about it is audited (symmetric policy -
      // see the resolver comment); otherwise the scratch diagnostics of both
      // ends surface together. A bypassed producer re-routes through the
      // passthrough trace first; a trace that dies at a muted node makes the
      // edge dead exactly like a directly muted producer.
      const scratch: Diagnostic[] = []
      const dsts = resolveInputPort(path, defId, c.to, scratch, c.delivery)
      const regionPseudoRef = isPortEndpoint(c.from) && c.from.node === DINKSTER_REGION_PSEUDO_NODE ? c.from : undefined
      const enclosingRegion = regionPseudoRef !== undefined
        ? [...regions.values()].find((region) => region.childId === defId && pathKey(region.childPath) === pathKey(path))
        : undefined
      const regionIndexRef = regionPseudoRef?.port === 'index' && enclosingRegion !== undefined
        ? regionPseudoRef
        : undefined
      if (regionPseudoRef !== undefined && regionIndexRef === undefined) {
        scratch.push(diag('error', 'compile', 'compile.region.invalidIndex', `'$region.${regionPseudoRef.port}' is available only as the immediate region index source`))
      }
      const structuralSrc = isPortEndpoint(c.from) && regionPseudoRef === undefined
        ? resolveOutputPort(path, defId, c.from, scratch, c.delivery)
        : undefined
      const mutedSource = structuralSrc === 'muted' ? lastMuted : undefined
      if (structuralSrc === 'muted' && Array.isArray(dsts)) {
        for (const dst of dsts) givesNothingFromMuted(dst, mutedSource!, c.what, defId)
        continue
      }
      // Bypassed consumer: consumed by passthrough (or dormant) - silent. What
      // it hands on, nothing when the producer is muted, reaches its
      // consumers along the route from its output.
      if (dsts === 'bypassed') continue
      if (structuralSrc === 'muted' || dsts === 'muted') {
        diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}': connected node is muted`))
        continue
      }
      // An unresolved producer is fatal only if one of these consumers
      // executes; record them before the scratch diagnostics surface.
      if (Array.isArray(dsts)) attachUnknownSchemaDependents(scratch, dsts.map((destination) => destination.runtimeId))
      diags.push(...scratch)
      // Ordinary port sources were resolved above so malformed source
      // diagnostics are emitted once per connection, not once per fanout
      // destination. Transparent endpoints still route per final consumer.
      if (!dsts || (isPortEndpoint(c.from) && !structuralSrc && regionIndexRef === undefined)) continue
      for (const dst of dsts) {
        if (regionIndexRef !== undefined) {
          const consumer = flat.get(dst.runtimeId)
          if (!consumer) continue
          consumer.inputs[dst.inputId] = { $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: 'index' } }
          consumer.linkedInputs.add(dst.inputId)
          recordSuccessfulDelivery(dst)
          continue
        }
        // A boundary item may fan one outer edge into differently typed final
        // consumers. Route independently for each destination so bypass
        // matching always sees that destination's declared type.
        const routeDiagnostics: Diagnostic[] = []
        let src: ResolvedOutput | undefined
        let baked: { readonly value: Json; readonly typeId?: string } | undefined
        if (structuralSrc && !('bypass' in structuralSrc) && !('structuralSource' in structuralSrc) && !('knownValue' in structuralSrc)) {
          src = structuralSrc
        } else {
          const routeStart: RouteAt = structuralSrc
            ? 'bypass' in structuralSrc
              ? { kind: 'bypass', bypass: structuralSrc.bypass }
              : 'knownValue' in structuralSrc
                ? { kind: 'known', known: structuralSrc.knownValue }
                : { kind: 'endpoint', ...structuralSrc.structuralSource }
            : { kind: 'endpoint', path, defId, endpoint: c.from }
          const trace = projectRoute(routeStart, 'exact', routeDiagnostics, dst.input.spec.type, undefined, c.delivery)[0] ?? { kind: 'dropped', reason: 'route produced no terminal' }
          attachUnknownSchemaDependents(routeDiagnostics, [dst.runtimeId])
          if (trace.kind === 'muted') {
            diags.push(...routeDiagnostics)
            if (trace.node !== undefined) givesNothingFromMuted(dst, trace.node, c.what, defId)
            else diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}': connected node is muted`))
            continue
          }
          if (trace.kind === 'dropped') {
            diags.push(...routeDiagnostics)
            const receiver = trace.absent === true && emitAbsentInputs ? flat.get(dst.runtimeId) : undefined
            if (receiver) {
              receiver.inputs[dst.inputId] = absentInputWire(trace.reason)
              receiver.linkedInputs.delete(dst.inputId)
              recordSuccessfulDelivery(dst)
            }
            continue
          }
          if (trace.kind === 'value') {
            baked = { value: trace.value, ...(trace.typeId !== undefined ? { typeId: trace.typeId } : {}) }
            if (trace.controllerSources !== undefined) {
              let byInput = literalControllers.get(dst.runtimeId)
              if (!byInput) literalControllers.set(dst.runtimeId, (byInput = new Map()))
              byInput.set(dst.inputId, { sources: trace.controllerSources, ...(trace.controllerWidget !== undefined ? { widget: trace.controllerWidget } : {}) })
            }
          } else src = trace.src
        }
        diags.push(...routeDiagnostics)
        if (src && !flat.has(src.runtimeId)) {
          diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}': connected node is unavailable`))
          continue
        }
        const consumer = flat.get(dst.runtimeId)
        if (!consumer) {
          diags.push(diag('warning', 'compile', 'compile.link.dropped', `${c.what} in graph '${defId}': connected node is unavailable`))
          continue
        }
        if (baked !== undefined) {
          // Passthrough traced to a known value or tap value: bake, same
          // precedence as a connection through one delivery path with no
          // write-through). Same typed-literal lowering as the direct
          // tapValue path - non-concrete destination OR an asset-source
          // runtime type differing from the concrete declared type (the
          // asset-reference destinations exempt, refs
          // deliver AS-IS): stamp when the capability AND a source type are
          // known (tap fallbacks always carry one; no guessing, per the
          // joint contract), else
          // refuse loudly instead of failing at the server.
          // Known text on a Switch that picks by name resolves here, name
          // then key, and is sent as the member key: the server reads a
          // stored text pick as a key. Text naming no branch is refused.
          if (consumer.selector?.names !== undefined && dst.inputId === consumer.selectorInputKey && typeof baked.value === 'string') {
            const names = branchNamesOf(consumer)
            const picked = selectedMember(consumer.selector, consumer.selectorMembers ?? [], baked.value, names)
            if (picked === undefined) {
              const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
              diags.push(diag('error', 'compile', 'compile.switch.noBranchNamed', `Switch received "${baked.value}". ${names.length === 1 ? 'The branch is' : 'The branches are'} ${listed}.`, { anchor: { occurrence: consumer.occ, port: { node: consumer.occ.node, port: dst.input.address.port } as PortRef } }))
              refusedPicks.add(consumer.runtimeId)
              continue
            }
            baked = { ...baked, value: picked.slice(consumer.selector.group.length + 1) }
          }
          const dstTypeId = canonicalTypeIdOf(dst.input.spec.type)
          if (isCanonicalUnsafeInteger(baked.value)) {
            if (baked.typeId === 'INT' && dstTypeId === 'INT') {
              const lowered = lowerWidgetLiteral(consumer, dst.input, baked.value)
              if (lowered !== undefined) {
                consumer.inputs[dst.inputId] = lowered
                consumer.linkedInputs.delete(dst.inputId)
                recordSuccessfulDelivery(dst)
              }
            } else {
              diags.push(diag('error', 'compile', 'compile.tap.decimalIntNonConcreteTarget', `${consumer.node.type}.${dst.input.spec.id}: large integer requires an INT input`, { anchor: { occurrence: consumer.occ, port: { node: consumer.occ.node, port: dst.input.address.port } as PortRef } }))
            }
            continue
          }
          if (dstTypeId === undefined ||
            (baked.typeId !== undefined && isAssetSourceTypeId(baked.typeId) &&
              baked.typeId !== dstTypeId && !isAssetRefDestinationTypeId(dstTypeId))) {
            if (emitTypedLiterals && baked.typeId !== undefined) {
              consumer.inputs[dst.inputId] = typedLiteralWire(baked.typeId, baked.value)
              consumer.linkedInputs.delete(dst.inputId)
              recordSuccessfulDelivery(dst)
              continue
            }
            diags.push(diag('error', 'compile', 'compile.tap.nonConcreteTarget', `${consumer.node.type}.${dst.input.spec.id}: literal type cannot be resolved on this backend`, { anchor: { occurrence: consumer.occ, port: { node: consumer.occ.node, port: dst.input.address.port } as PortRef } }))
            continue
          }
          consumer.inputs[dst.inputId] = baked.value
          consumer.linkedInputs.delete(dst.inputId)
          recordSuccessfulDelivery(dst)
          continue
        }
        if (!src) continue // unreachable (guarded above); narrows the type
        consumer.inputs[dst.inputId] = [src.runtimeId, src.outputIndex] as const
        consumer.linkedInputs.add(dst.inputId)
        recordSuccessfulDelivery(dst)
      }
    }
  }

  // Region boundary inputs are body-local reads from the reserved pseudo
  // node. Resolve each boundary item through the same matcher and fan-out
  // machinery as ordinary parent deliveries, but open only this region so a
  // nested region remains an opaque entry in its enclosing body.
  for (const region of regions.values()) {
    const child = graphOf(region.childId)
    if (!child?.boundary) continue
    for (const item of child.boundary.inputs) {
      const targets = resolveInputPort(
        region.occ.instancePath,
        region.parentDefId,
        { node: region.node.id, port: item.id as PortRef['port'] },
        diags,
        undefined,
        [],
        region.runtimeId,
      )
      if (!targets || targets === 'muted' || targets === 'bypassed') continue
      for (const target of targets) {
        const bodyNode = flat.get(target.runtimeId)
        if (!bodyNode) continue
        bodyNode.inputs[target.inputId] = {
          $link: { node: DINKSTER_REGION_PSEUDO_NODE, output: item.id },
        }
        bodyNode.linkedInputs.add(target.inputId)
        recordSuccessfulDelivery(target)
      }
    }
  }

  if ('query' in input) return { consumers: sourceConsumers }

  // -- Scope: full = closure of output nodes; partial = closure of targets ---

  // A Switch whose pick is in Random mode rolls one member per occurrence
  // once the executed scope is known (below). The mode belongs to whoever
  // owns the pick's value, as for an after-run control: the outermost
  // subgraph node that promotes it, else the Switch. A pick fed by anything
  // in the document, even a value baked into it, overrides the mode.
  // Would-run keeps every member of a random pick, since the roll is not
  // known until queueing.
  const randomPicks = new Set<string>()
  for (const fn of flat.values()) {
    if (!fn.selector || !fn.selectorInputKey || !fn.selectorMembers || fn.selectorMembers.length === 0) continue
    const input = fn.elab.inputsByValueKey.get(fn.selector.input)
    const widget = input?.spec.widget
    if (!input || widget?.controller === undefined) continue
    if (driverOfInput(fn.occ.instancePath, fn.graphId, fn.occ.node, input.address)) continue
    const owner = controllerSources.get(fn.runtimeId)?.get(input.spec.id)?.[0]?.source
    const ownerNode = owner ? graphOf(owner.graph)?.nodes[owner.occurrence.node] : fn.node
    const mode = ownerNode?.controllers?.[owner ? owner.valueKey : valueKeyOf(input)] ?? widget.controllerInitial ?? 'randomize'
    if (mode === 'randomize') randomPicks.add(fn.runtimeId)
  }

  // A Switch's pick may be document state, a known value baked into it, or
  // link-fed. A known pick projects the members it leaves out, from the
  // staged occurrence-effective value. Link-fed and random picks stay
  // neutral: the backend resolves a link at runtime, and stale stored values
  // must not prune any would-run branch. A pick the backend would refuse
  // also stays neutral. This projection never mutates fn.inputs.
  if (wouldRun) {
    for (const fn of flat.values()) {
      if (!fn.selector || !fn.selectorInputKey || !fn.selectorMembers) continue
      if (fn.linkedInputs.has(fn.selectorInputKey) || randomPicks.has(fn.runtimeId) || refusedPicks.has(fn.runtimeId)) continue
      const staged = fn.inputs[fn.selectorInputKey]
      const pick = staged === undefined ? undefined : parseTypedLiteralWire(staged)?.value ?? staged
      const picked = selectedMember(fn.selector, fn.selectorMembers, pick)
      if (picked === undefined) continue
      fn.selectorProjection = { inactive: fn.selectorMembers.filter((member) => member !== picked) }
    }
  }

  let included: ReadonlySet<string>
  let successfulDestinations: ReadonlyMap<string, readonly PortAddress[]>
  let inactiveExclusive: ReadonlyMap<string, ReadonlySet<string>> = new Map()
  let partialTargets: readonly string[] | undefined
  let dinksterTargets: readonly string[] | undefined
  // A full compile of a graph with no resolved output node is degenerate: it
  // cannot execute, `included` is a keep-everything diagnostic surface (see
  // below), and an unresolved node may itself be the missing output. Such
  // graphs keep unresolved-schema errors standing instead of demoting them.
  let demoteOutOfScopeUnknownSchema = true
  const enclosingRegionRuntimeId = (runtimeId: string): string => {
    const fn = flat.get(runtimeId)
    if (!fn) return runtimeId
    const outer = [...regions.values()]
      .filter((region) => fn.occ.instancePath.length >= region.childPath.length &&
        region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment))
      .sort((a, b) => a.childPath.length - b.childPath.length)[0]
    return outer?.runtimeId ?? runtimeId
  }
  /** The nodes this run asks for: the output nodes, or the partial targets. */
  let requested: readonly string[] = []
  if (scope.kind === 'full') {
    // 'full' = all output nodes (artifact contract), i.e. their upstream
    // closure. Anything unreachable from an output node - a disconnected
    // chain - must not enter the executed
    // closure: the server would prune it anyway, and controller/seed
    // advancement keys off `included` (out-of-scope seeds stay untouched).
    // Degenerate graphs with NO output nodes keep everything: they cannot
    // execute at all, and pruning to nothing would only hide the real
    // problem from diagnostics.
    const roots = [...flat.values()]
      .filter((fn) => {
        const region = regions.get(fn.runtimeId)
        return (region ? resolveNode(region.parentDefId, fn.node) : resolve(fn.node.type))?.isOutputNode
      })
      .map((fn) => fn.runtimeId)
    requested = roots
    const derived = liveness.derive(flat, roots.length > 0 ? roots : [...flat.keys()], wouldRunInputEdges)
    successfulDestinations = derived.successfulDestinations
    included = roots.length > 0 ? derived.included : new Set(flat.keys())
    if (roots.length === 0) demoteOutOfScopeUnknownSchema = false
    inactiveExclusive = derived.inactiveExclusive
    if (regions.size > 0) {
      dinksterTargets = roots.filter((runtimeId) => {
        const fn = flat.get(runtimeId)
        return fn !== undefined && ![...regions.values()].some((region) =>
          fn.occ.instancePath.length >= region.childPath.length &&
          region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment))
      })
    }
  } else {
    const targets = scope.targets.map(occurrenceKey)
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex++) {
      const t = targets[targetIndex]!
      if (!flat.has(t)) {
        const occurrence = scope.targets[targetIndex]!
        const unresolvedType = unresolvedCollected.get(t)
        if (unresolvedType !== undefined) {
          // The target names a real node whose schema does not resolve:
          // report the actual problem, not a missing target. Explicitly
          // targeting the unresolved node keeps it fatal.
          diags.push(diag('error', 'compile', 'compile.schema.unknown', `unknown node type '${unresolvedType}'`, { anchor: { occurrence }, data: { nodeType: unresolvedType } }))
          continue
        }
        let defId: string = doc.root
        let inactive: { node: string; mode: 'muted' | 'bypassed' } | undefined
        for (const instanceId of occurrence.instancePath) {
          const instance = graphOf(defId)?.nodes[instanceId]
          if (!instance) break
          if (instance.mode === 'muted' || instance.mode === 'bypassed') {
            inactive = { node: instance.id, mode: instance.mode }
            break
          }
          const childId = subgraphDefIdOf(instance.type)
          if (!childId) break
          defId = childId
        }
        diags.push(inactive
          ? diag('error', 'compile', 'compile.scope.inactiveAncestor', `partial-execution target '${t}' is inside ${inactive.mode} subgraph instance '${inactive.node}' and cannot execute`)
          : diag('error', 'compile', 'compile.scope.missingTarget', `partial-execution target '${t}' is not in the compiled graph`))
      }
    }
    const nativeTargets = targets.map(enclosingRegionRuntimeId)
    const derived = liveness.derive(flat, nativeTargets, wouldRunInputEdges)
    successfulDestinations = derived.successfulDestinations
    included = derived.included
    inactiveExclusive = derived.inactiveExclusive
    partialTargets = targets
    requested = nativeTargets
    if (regions.size > 0) {
      dinksterTargets = [...new Set(nativeTargets)]
    }
  }

  if (regions.size > 0) {
    const expanded = new Set(included)
    for (const fn of flat.values()) {
      if (!expanded.has(fn.runtimeId)) continue
      for (const region of regions.values()) {
        if (fn.occ.instancePath.length >= region.childPath.length &&
          region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment)) {
          expanded.add(region.runtimeId)
        }
      }
    }
    for (const region of regions.values()) {
      if (!expanded.has(region.runtimeId)) continue
      for (const fn of flat.values()) {
        if (fn.occ.instancePath.length >= region.childPath.length &&
          region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment)) {
          expanded.add(fn.runtimeId)
        }
      }
    }
    included = expanded
  }

  // The executed scope is final: unresolved-schema diagnostics whose
  // consumers all fall outside it demote to warnings, so a stray unresolved
  // node no longer blocks the runnable rest of the document.
  if (demoteOutOfScopeUnknownSchema) settleUnknownSchema(included)

  // Roll each random pick that runs, before the backend prunes the members
  // not picked; the choice is recorded so a frozen run and a re-run replay it.
  if (!wouldRun) for (const runtimeId of randomPicks) {
    const fn = flat.get(runtimeId)!
    if (!included.has(runtimeId)) continue
    const keys = fn.selectorMembers!.map((member) => member.slice(fn.selector!.group.length + 1))
    let key = options?.candidateOverride?.({ graph: fn.graphId, selector: fn.runtimeId, candidates: keys })
    if (key === undefined || !keys.includes(key)) {
      if (!options?.pickCandidate) {
        diags.push(diag('error', 'compile', 'compile.switch.noChooser', `${fn.node.type}: the pick is random but no pickCandidate chooser was provided`, { anchor: { occurrence: fn.occ } }))
        continue
      }
      const raw = options.pickCandidate({ graph: fn.graphId, selector: fn.runtimeId, count: keys.length })
      key = keys[Number.isFinite(raw) ? Math.min(keys.length - 1, Math.max(0, Math.floor(raw))) : 0]!
    }
    const lowered = lowerWidgetLiteral(fn, fn.elab.inputsByValueKey.get(fn.selector!.input)!, key)
    if (lowered === undefined) continue
    fn.inputs[fn.selectorInputKey!] = lowered
    selectorChoices.push({ graph: fn.graphId, selector: fn.runtimeId, policy: 'random', candidate: key })
  }

  // Several passes report the same unresolved occurrence (collection, link
  // lowering, per-destination routing), each with its own copy so severity
  // can settle per consumer. One entry per occurrence is enough for the
  // result; when the settled copies disagree the fatal one wins.
  const unknownByOccurrence = new Map<string, Diagnostic>()
  const dedupedDiags = diags.filter((diagnostic) => {
    if (diagnostic.code !== 'compile.schema.unknown' || !diagnostic.anchor?.occurrence) return true
    const key = occurrenceKey(diagnostic.anchor.occurrence)
    const kept = unknownByOccurrence.get(key)
    if (!kept) {
      unknownByOccurrence.set(key, diagnostic)
      return true
    }
    if (kept.severity !== 'error' && diagnostic.severity === 'error') {
      ;(kept as { severity: Diagnostic['severity'] }).severity = 'error'
    }
    return false
  })
  diags.length = 0
  diags.push(...dedupedDiags)

  const includedRegions = [...regions.values()].filter((region) => included.has(region.runtimeId))
  // dinksterTargets is paired with dinksterGraph: an artifact whose regions are all
  // excluded from scope keeps the ordinary region-free shape.
  if (includedRegions.length === 0) dinksterTargets = undefined
  if (!emitRegions) {
    for (const region of includedRegions) {
      diags.push(diag(
        'error',
        'compile',
        'compile.region.backendUnsupported',
        'this backend does not advertise first-class region execution support',
        { anchor: { occurrence: region.occ } },
      ))
    }
  }
  const validatesNode = (runtimeId: string): boolean =>
    scope.kind === 'full' || included.has(runtimeId)
  if (scope.kind === 'partial') {
    const includedDefinitionNodes = new Set(
      [...flat.values()]
        .filter((fn) => included.has(fn.runtimeId))
        .map((fn) => JSON.stringify([fn.graphId, fn.node.id])),
    )
    const scoped = diags.filter((diagnostic) => {
      const owner = elaborationDiagnosticOwners.get(diagnostic)
      if (owner === undefined) return true
      return owner.runtimeId !== undefined
        ? included.has(owner.runtimeId)
        : includedDefinitionNodes.has(JSON.stringify([owner.graphId, owner.nodeId]))
    })
    diags.length = 0
    diags.push(...scoped)
  }
  if (diags.some((diagnostic) => diagnostic.severity === 'error')) {
    return { result: { ok: false, diagnostics: diags } }
  }

  // Full compile validates every flattened node, including disconnected
  // non-output nodes. Partial compile validates only the nodes
  // that can execute. Staging diagnostics were buffered because staging must
  // precede closure construction (taps and links consume staged literals).
  // The backend accepts link-fed selector decisions as runtime selectors;
  // stored decisions are still lowered and pruned server-side. The frontend
  // deliberately does not pre-refuse either form. An incompatible backend returns a
  // structured lowering problem, so an incompatible submission stays visible.
  for (const [runtimeId, staged] of stagedNodeDiagnostics) {
    if (validatesNode(runtimeId)) diags.push(...staged)
  }

  // -- Pass 3: widget defaults + required-input checks ------------------------
  //
  // Scope is known before node-local validation: a partial compile must not
  // report or block on inputs of nodes that cannot execute. Link lowering
  // remains earlier because its staged producer references are what define
  // the upstream closure (and its structural diagnostics are needed to
  // explain a broken in-scope path).

  for (const fn of flat.values()) {
    if (!validatesNode(fn.runtimeId)) continue
    const unavailableReason = resolveNode(fn.graphId, fn.node)?.unavailableReason
    if (unavailableReason !== undefined) {
      diags.push(diag('error', 'compile', 'dinksterGraph.nodeUnavailable', unavailableReason, { anchor: { occurrence: fn.occ } }))
    }
    for (const input of fn.elab.inputs) {
      if (input.apiName === undefined) continue // never reaches the prompt
      if (input.origin.kind === 'member' && input.origin.ghost === true) continue
      const spec = input.spec
      if (fn.inputs[spec.id] !== undefined) continue
      if (spec.hidden === true) continue
      // A primitive's empty limit only shows the limit worked out for it.
      if (spec.widget?.automatic === true) continue
      if (spec.widget) {
        // Explicit schema default first, then the widget kind's intrinsic
        // value (an INT shows 0/min, a STRING shows '', ...): what the
        // canvas visibly displays is what executes. Kinds without an
        // intrinsic value (ASSET, remote COMBO, ...) fall through to the
        // missing-input warning - those genuinely need the user. A purely
        // INTRINSIC value is synthesized only when a declared default exists
        // or the input is REQUIRED: an optional widget input with no schema
        // default was always omitted from the prompt and stays omitted (the
        // backend's own default applies - inventing 0/''/false would change
        // valid workflows that never warned).
        const fallback = effectiveWidgetDefault(spec.widget)
        if (fallback !== undefined && (spec.widget.default !== undefined || !spec.optional)) {
          const lowered = lowerWidgetLiteral(fn, input, fallback)
          if (lowered !== undefined) fn.inputs[spec.id] = lowered
          // A refused fallback already errored; the missing-input warning
          // below would only restate it as noise.
          continue
        }
      }
      if (!spec.optional) {
        // Server-side validation is authoritative; surface early as a warning.
        diags.push(diag('warning', 'compile', 'compile.input.missing', `'${fn.node.type}' required input '${spec.id}' has no value or connection`, {
          blocksExecution: true,
          anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port } as PortRef },
        }))
      }
    }
  }

  // Settled DynamicSlot contract (Dinkster c2ac572, schema wire v6): the stored
  // variant choice is authoritative for the backend's elaborated interface,
  // traveling once per node as the graph wire's 'slotVariants' object. A
  // variant-carrying slot that participates in the prompt (linked or valued)
  // without a valid stored choice cannot lower - the backend elaborates the
  // interface FROM the choice, so submitting would bounce off elaboration
  // (missing/unknown-key are deterministic elaboration-failed errors there).
  // Surface that early and anchored instead.
  for (const fn of flat.values()) for (const input of fn.elab.inputs) {
    if (!validatesNode(fn.runtimeId)) continue
    if (input.origin.kind !== 'slot' || !input.origin.variants?.length) continue
    if (fn.inputs[input.spec.id] === undefined) continue
    const selected = input.origin.selected
    if (selected !== undefined && input.origin.variants.some((v) => v.key === selected)) continue
    diags.push(diag('error', 'compile', 'compile.slot.missingVariant',
      selected === undefined
        ? `${fn.node.type}.${input.origin.construct}: connected slot has no stored variant`
        : `${fn.node.type}.${input.origin.construct}: unknown slot variant '${selected}'`,
      { anchor: { occurrence: fn.occ } }))
  }

  const errors = diags.filter((d) => d.severity === 'error')
  if (errors.length > 0) return { result: { ok: false, diagnostics: diags } }

  // -- Assemble artifact -------------------------------------------------------

  const nativeOutputId = (runtimeId: string, output: ElaboratedOutput): string =>
    regions.get(runtimeId)?.stateOutputAliases.get(output.spec.id) ?? output.backendId ?? output.spec.id
  const prompt: Record<string, PromptNode> = {}
  const toSource: Record<string, string> = {}
  const fromSource: Record<string, string[]> = {}
  const inputSources: Record<string, Record<string, PortRef>> = {}
  const outputAliases: Record<string, Record<string, string>> = {}
  const dynamicPromptInputs: Record<string, string[]> = {}
  const controllerInputs: ControllerInputProvenance[] = []
  for (const fn of flat.values()) {
    if (!included.has(fn.runtimeId)) continue
    // Staging keys are elaborated ids (document identity); the prompt is
    // keyed by apiName (wire identity). For static inputs they coincide, so
    // golden prompts are unchanged; dynamic members remap to their positional
    // wire names here and ONLY here (api names are compiler output, never
    // identity).
    const inputs: Record<string, Json | readonly [string, number]> = {}
    const sourceInputs: Record<string, PortRef> = {}
    const dynamicInputs: string[] = []
    let viewGraphId: string = doc.root
    for (const instanceId of fn.occ.instancePath) {
      const childId = subgraphDefIdOf(doc.graphs[viewGraphId]?.nodes[instanceId]?.type ?? '')
      if (childId === undefined) break
      viewGraphId = childId
    }
    const selectedViews = doc.view.graphs[viewGraphId]?.nodes[fn.occ.node]?.views
    // The key of every choice and type choice that takes part in the run,
    // by flattened id (graph wire 'slotVariants').
    const slotVariants: Record<string, string> = { ...fn.elab.choices }
    const successful = new Set(
      (successfulDestinations.get(fn.runtimeId) ?? [])
        .map((address) => portAddressKey(address.port)),
    )
    for (const input of fn.elab.inputs) {
      if (input.apiName === undefined) continue
      const literal = literalControllers.get(fn.runtimeId)?.get(input.spec.id)
      const widget = literal?.widget ?? input.spec.widget
      // A random pick was rolled before the run; nothing advances it after.
      const rolledPick = randomPicks.has(fn.runtimeId) && input.spec.id === fn.selectorInputKey
      if (widget?.controller === 'after_generate' && !rolledPick) {
        const sources = [...(controllerSources.get(fn.runtimeId)?.get(input.spec.id) ?? [])]
        const terminal: ControllerSource = {
          source: { graph: fn.graphId, occurrence: fn.occ, valueKey: valueKeyOf(input) },
          widget,
          ownerPriority: 0,
        }
        if (!sources.some((candidate) =>
          candidate.source.graph === terminal.source.graph &&
          candidate.source.occurrence.node === terminal.source.occurrence.node &&
          candidate.source.valueKey === terminal.source.valueKey)) sources.push(terminal)
        controllerInputs.push({
          runtimeId: fn.runtimeId,
          terminal: terminal.source,
          sources: literal?.sources ?? sources.map((source) => source.source),
          ownerPriority: sources[0]?.ownerPriority ?? 0,
          widget: literal?.widget ?? sources[0]?.widget ?? widget,
          optional: input.spec.optional,
          driven: literal === undefined && successful.has(portAddressKey(input.address.port)),
        })
      }
      const submissionName = input.apiName
      sourceInputs[submissionName] = {
        node: fn.occ.node,
        port: input.address.port as PortRef['port'],
      }
      // A Switch's names are sent only when its pick is a wire that may carry
      // text, so a branch name otherwise stays a label and a rename changes
      // nothing that is submitted.
      if (fn.selector?.names !== undefined && valueKeyOf(input) === fn.selector.names) {
        const pick = fn.inputs[fn.selectorInputKey!]
        const source = fn.linkedInputs.has(fn.selectorInputKey!) && Array.isArray(pick) && typeof pick[1] === 'number'
          ? flat.get(pick[0] as string)?.elab.outputs.filter((output) => output.wireable !== false)[pick[1]]
          : undefined
        const sourceType = source === undefined ? undefined : canonicalTypeIdOf(source.spec.type)
        if (source !== undefined && sourceType !== 'INT' && sourceType !== 'BOOLEAN') inputs[submissionName] = [...branchNamesOf(fn)]
        continue
      }
      // The compiler fills an editable choice's options input on every submission.
      const authored = fn.authoredOptions?.get(valueKeyOf(input))
      if (authored !== undefined) {
        inputs[submissionName] = [...authored]
        continue
      }
      const v = fn.inputs[input.spec.id]
      if (v !== undefined && fn.node.additionalInputs?.includes(input.address.port) &&
        canonicalTypeIdOf(input.spec.type) === undefined && !fn.linkedInputs.has(input.spec.id) && !isAbsentInputWire(v) &&
        (parseTypedLiteralWire(v) === undefined || !emitTypedLiterals)) {
        diags.push(diag('error', 'compile', 'compile.value.additionalInputType', `${fn.node.type}.${input.spec.id}: additional input literals require an explicit type and backend typed-literal support`, { anchor: { occurrence: fn.occ } }))
        continue
      }
      if (v !== undefined) {
        inputs[submissionName] = v
        const widget = input.spec.widget
        if (widget !== undefined &&
            resolveWidgetRepresentation(widget, selectedViews?.[valueKeyOf(input)]).spec.options['dynamicPrompts'] === true) {
          dynamicInputs.push(submissionName)
        }
      }
    }
    for (const { path, value } of fn.elab.submissionValues) {
      inputs[path] = value
      sourceInputs[path] = { node: fn.occ.node, port: path as PortRef['port'] }
    }
    prompt[fn.runtimeId] = {
      class_type: fn.node.type,
      inputs,
      outputIds: fn.elab.outputs.filter((output) => output.wireable !== false)
        .map((output) => nativeOutputId(fn.runtimeId, output)),
      ...(fn.elab.outputMembers ? { outputMembers: fn.elab.outputMembers } : {}),
      ...(Object.keys(slotVariants).length > 0 ? { slotVariants } : {}),
    }
    const occKey = occurrenceKey(fn.occ)
    toSource[fn.runtimeId] = occKey
    inputSources[fn.runtimeId] = sourceInputs
    if (dynamicInputs.length > 0) dynamicPromptInputs[fn.runtimeId] = dynamicInputs
    ;(fromSource[occKey] ??= []).push(fn.runtimeId)
    const aliases = regions.get(fn.runtimeId)?.stateOutputAliases
    if (aliases !== undefined && aliases.size > 0) outputAliases[fn.runtimeId] = Object.fromEntries(aliases)
  }

  // A node the run will skip: a required input (absence policy 'skip')
  // receives nothing, as an $absent marker or by a wire from a node that is
  // itself skipped. Only a node whose input receives the marker says so
  // before the run, without blocking it; the nodes skipped after it stay
  // quiet. A run whose every requested node is skipped could do nothing and
  // is not sent (a would-run query still reports its closure).
  const skipped = new Set<string>()
  for (let grew = true; grew;) {
    grew = false
    for (const fn of flat.values()) {
      if (!included.has(fn.runtimeId) || skipped.has(fn.runtimeId)) continue
      for (const input of fn.elab.inputs) {
        if (input.apiName === undefined || effectiveAbsentPolicy(input.spec) !== 'skip') continue
        const v = fn.inputs[input.spec.id]
        const from = Array.isArray(v) && fn.linkedInputs.has(input.spec.id) ? flat.get(v[0] as string) : undefined
        const absent = v !== undefined && isAbsentInputWire(v as Json)
        if (!absent && (from === undefined || !skipped.has(from.runtimeId))) continue
        if (absent) {
          const reason = String(((v as { $absent: { reason?: unknown } }).$absent).reason ?? 'it receives nothing')
          diags.push(diag('warning', 'compile', 'compile.input.skipped',
            `Receives nothing because ${reason}, so this node is skipped in the run.`,
            { anchor: { occurrence: fn.occ, port: { node: fn.occ.node, port: input.address.port as PortRef['port'] } } }))
        }
        skipped.add(fn.runtimeId)
        grew = true
        break
      }
    }
  }
  if (!wouldRun && requested.length > 0 && requested.every((runtimeId) => skipped.has(runtimeId))) {
    diags.push(diag('error', 'compile', 'compile.run.allSkipped',
      'Nothing would run: every output this run asks for is skipped, because an input it needs receives nothing. The warning on the first skipped node says why.'))
  }

  const ownerRegionOf = (fn: FlatNode): RegionLowering | undefined => {
    let owner: RegionLowering | undefined
    for (const region of regions.values()) {
      if (fn.occ.instancePath.length < region.childPath.length) continue
      if (!region.childPath.every((segment, index) => fn.occ.instancePath[index] === segment)) continue
      if (owner === undefined || region.childPath.length > owner.childPath.length) owner = region
    }
    return owner
  }
  const localRuntimeId = (runtimeId: string, scopeRegion?: RegionLowering): string => {
    if (scopeRegion === undefined) return runtimeId
    const fn = flat.get(runtimeId)
    if (!fn) return runtimeId
    return occurrenceKey({
      instancePath: fn.occ.instancePath.slice(scopeRegion.childPath.length),
      node: fn.occ.node,
    })
  }
  const outputIdOf = (source: ResolvedOutput): string | undefined => {
    const producer = flat.get(source.runtimeId)
    const output = producer?.elab.outputs.filter((candidate) => candidate.wireable !== false)[source.outputIndex]
    if (!output) return undefined
    return nativeOutputId(source.runtimeId, output)
  }
  const wireInput = (value: Json | readonly [string, number], scopeRegion?: RegionLowering): DinksterInputWire => {
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'number') {
      return value as DinksterInputWire
    }
    const output = outputIdOf({ runtimeId: value[0], outputIndex: value[1] })
    if (output === undefined) {
      diags.push(diag('error', 'compile', 'compile.region.outputUnresolved', `native region lowering cannot resolve output #${value[1]} on producer '${value[0]}'`))
      return value as unknown as DinksterInputWire
    }
    return { $link: { node: localRuntimeId(value[0], scopeRegion), output } }
  }
  const nativeInputs = (compiled: PromptNode, scopeRegion?: RegionLowering) =>
    Object.fromEntries(Object.entries(compiled.inputs)
      .map(([inputId, value]) => [inputId, wireInput(value, scopeRegion)]))
  const sourceForBoundaryOutput = (
    region: RegionLowering,
    outputId: string,
  ): { readonly node: string; readonly output: string } | undefined => {
    const source = resolveOutputPort(
      region.occ.instancePath,
      region.parentDefId,
      { node: region.node.id, port: outputId as PortRef['port'] },
      diags,
      undefined,
      [],
      region.runtimeId,
    )
    const fail = (reason: string): undefined => {
      diags.push(diag('error', 'compile', 'compile.region.outputUnresolved', `region output '${outputId}' ${reason}`, { anchor: { occurrence: region.occ } }))
      return undefined
    }
    if (!source) return fail('cannot be resolved')
    if (source === 'muted') return fail('is driven by a muted occurrence')
    const resolved = 'bypass' in source
      ? projectRoute({ kind: 'bypass', bypass: source.bypass }, 'exact', diags)
      : 'structuralSource' in source
        ? projectRoute({ kind: 'endpoint', ...source.structuralSource }, 'exact', diags)
        : 'knownValue' in source
          ? projectRoute({ kind: 'known', known: source.knownValue }, 'exact', diags)
          : [{ kind: 'output' as const, src: source }]
    const outputs = resolved.filter((terminal): terminal is Extract<BypassTrace, { readonly kind: 'output' }> => terminal.kind === 'output')
    if (outputs.length !== 1 || resolved.length !== 1) return fail('does not resolve to exactly one body output')
    const output = outputIdOf(outputs[0]!.src)
    return output === undefined
      ? fail('resolves to an unknown body output')
      : { node: localRuntimeId(outputs[0]!.src.runtimeId, region), output }
  }
  const validationContext = new Map<string, DinksterGraphValidationNode>()
  const solvedTypes = new Map(Object.values(doc.graphs).map((graph) => [graph.id, solvedTypesOf(graph.id)!]))
  const nativeTypes = new Map<string, TypeExpr>()
  const resolvingNativeTypes = new Set<string>()
  const nativeInputType = (fn: FlatNode, key: string): TypeExpr | undefined => {
    const value = fn.inputs[key]
    const stamped = value === undefined ? undefined : parseTypedLiteralWire(value)
    if (stamped !== undefined) return typeExprFromTypeId(stamped.type)
    if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') {
      return nativeOutputType(value[0], value[1])
    }
    const port = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as { $link?: { node?: string; output?: string } }).$link
      : undefined
    if (port?.node === DINKSTER_REGION_PSEUDO_NODE && port.output !== undefined) {
      if (port.output === 'index') return { kind: 'concrete', name: 'INT' }
      const owner = ownerRegionOf(fn)
      const parent = owner && flat.get(owner.runtimeId)
      const type = parent && nativeInputType(parent, port.output)
      return owner?.node.region?.elementPorts?.includes(port.output) && type?.kind === 'list' ? type.element : type
    }
    return fn.elab.inputs.find((input) => input.address.port === key)?.spec.type
  }
  const nativeOutputType = (runtimeId: string, index: number): TypeExpr | undefined => {
    const key = `${runtimeId}/${index}`
    const cached = nativeTypes.get(key)
    if (cached) return cached
    if (resolvingNativeTypes.has(key)) return undefined
    const fn = flat.get(runtimeId)
    const output = fn?.elab.outputs.filter((item) => item.wireable !== false)[index]
    if (!fn || !output) return undefined
    resolvingNativeTypes.add(key)
    let type: TypeExpr | undefined
    const region = regions.get(runtimeId)
    if (region) {
      const source = sourceForBoundaryOutput(region, output.address.port)
      const producer = source && [...flat.values()].find((candidate) => ownerRegionOf(candidate)?.runtimeId === runtimeId && localRuntimeId(candidate.runtimeId, region) === source.node)
      const producerIndex = producer?.elab.outputs.filter((item) => item.wireable !== false).findIndex((item) => nativeOutputId(producer.runtimeId, item) === source?.output)
      const inner = producer && producerIndex !== undefined && producerIndex >= 0 ? nativeOutputType(producer.runtimeId, producerIndex) : undefined
      const role = region.node.region?.outputRoles?.[output.address.port]
      type = inner === undefined ? undefined : role?.kind === 'flatten' || role?.kind === 'last' || role?.kind === 'state' ? inner : { kind: 'list', element: inner }
    } else {
      const items = [
        ...fn.elab.inputs.map((input, i) => ({ kind: 'input' as const, id: `input_${i}`, type: input.spec.type, optional: input.spec.optional })),
        ...fn.elab.outputs.map((item, i) => ({ kind: 'output' as const, id: `output_${i}`, type: item.spec.type })),
      ]
      const schema = { ...resolveNode(fn.graphId, fn.node)!, body: items }
      const projectedInputs = fn.elab.inputs.flatMap((input, i) => {
        const type = nativeInputType(fn, input.address.port)
        return type ? [{ type, to: { node: fn.node.id, port: `input_${i}` as PortRef['port'] } }] : []
      })
      const graph = { ...doc.graphs[fn.graphId]!, nodes: { [fn.node.id]: fn.node }, links: {}, nets: {}, reroutes: {} }
      type = solveGraphTypes(graph, () => schema, { projectedInputs }).portTypeOf(fn.node.id, 'output', `output_${fn.elab.outputs.indexOf(output)}`)
    }
    resolvingNativeTypes.delete(key)
    if (type) nativeTypes.set(key, type)
    return type
  }
  const validationNode = (fn: FlatNode): DinksterGraphValidationNode => {
    const inputTypes: Record<string, TypeExpr> = {}
    const inputPorts: Record<string, PortRef> = {}
    for (const input of fn.elab.inputs) {
      if (input.apiName === undefined) continue
      const inputId = input.apiName
      inputTypes[inputId] = input.spec.type
      inputPorts[inputId] = {
        node: fn.occ.node,
        port: input.address.port as PortRef['port'],
      }
    }
    const outputTypes: Record<string, TypeExpr> = {}
    const outputPorts: Record<string, PortRef> = {}
    const selectorBranchTypes = fn.selectorMembers === undefined
      ? undefined
      : fn.selectorMembers.map((key) => {
          const value = fn.inputs[key]
          if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || typeof value[1] !== 'number') return undefined
          return flat.get(value[0])?.elab.outputs
            .filter((output) => output.wireable !== false)[value[1]]?.spec.type
        })
    const firstBranchType = selectorBranchTypes?.[0]
    const selectorOutputType = firstBranchType !== undefined &&
        canonicalTypeIdOf(firstBranchType) !== undefined &&
        selectorBranchTypes!.every((type) => type !== undefined && canonicalTypeIdOf(type) === canonicalTypeIdOf(firstBranchType))
      ? firstBranchType
      : undefined
    for (const output of fn.elab.outputs) {
      if (output.wireable === false) continue
      const outputId = nativeOutputId(fn.runtimeId, output)
      const solved = solvedTypes.get(fn.graphId)?.portTypeOf(fn.node.id, 'output', output.address.port)
      const native = nativeOutputType(fn.runtimeId, fn.elab.outputs.filter((item) => item.wireable !== false).indexOf(output))
      outputTypes[outputId] = output.spec.type.kind === 'variable' && selectorOutputType !== undefined
        ? selectorOutputType
        : native !== undefined && canonicalTypeIdOf(native) !== undefined ? native : solved ?? output.spec.type
      outputPorts[outputId] = {
        node: fn.occ.node,
        port: output.address.port as PortRef['port'],
      }
    }
    return {
      anchor: { occurrence: fn.occ },
      inputTypes,
      inputPorts,
      outputTypes,
      outputPorts,
      ...(resolveNode(fn.graphId, fn.node)?.unavailableReason !== undefined
        ? { unavailableReason: resolveNode(fn.graphId, fn.node)!.unavailableReason } : {}),
      ...(resolveNode(fn.graphId, fn.node)?.residentAffinity !== undefined
        ? { residentAffinity: resolveNode(fn.graphId, fn.node)!.residentAffinity } : {}),
    }
  }
  const buildNativeGraph = (scopeRegion?: RegionLowering, prefix = ''): DinksterGraphWire => {
    const nodes: Record<string, DinksterGraphEntryWire> = {}
    for (const fn of flat.values()) {
      if (!included.has(fn.runtimeId) || ownerRegionOf(fn)?.runtimeId !== scopeRegion?.runtimeId) continue
      const nodeId = localRuntimeId(fn.runtimeId, scopeRegion)
      const path = prefix === '' ? nodeId : `${prefix}/${nodeId}`
      const region = regions.get(fn.runtimeId)
      const compiled = prompt[fn.runtimeId]
      if (!compiled) continue
      validationContext.set(path, validationNode(fn))
      if (!region) {
        nodes[nodeId] = {
          nodeType: compiled.class_type,
          inputs: nativeInputs(compiled, scopeRegion),
          ...(compiled.outputMembers ? { outputMembers: compiled.outputMembers } : {}),
          ...(compiled.slotVariants ? { slotVariants: compiled.slotVariants } : {}),
        }
        continue
      }
      const contract = region.node.region!
      const child = graphOf(region.childId)!
      const boundarySchema = deriveBoundarySchema(child, resolve, undefined, (inner) => resolveNode(child.id, inner)).schema
      const ports: Record<string, Json> = {}
      for (const item of boundarySchema?.body ?? []) {
        if (item.kind !== 'input') continue
        const incoming = nativeInputType(fn, item.id)
        const bodyType = contract.elementPorts?.includes(item.id) && incoming?.kind === 'list' ? incoming.element : incoming
        const encoded = typeExprToDinksterWire(canonicalTypeIdOf(item.type) === undefined && bodyType !== undefined && canonicalTypeIdOf(bodyType) !== undefined ? bodyType : item.type)
        if (encoded === undefined) {
          diags.push(diag('error', 'compile', 'compile.region.portTypeUnsupported', `region port '${item.id}' has a type expression that cannot be emitted`, { anchor: { occurrence: region.occ } }))
          continue
        }
        ports[item.id] = encoded
      }
      const outputs: Record<string, DinksterRegionOutputWire> = {}
      for (const item of child.boundary!.outputs) {
        if (item.id === contract.continueOutput) continue
        const source = sourceForBoundaryOutput(region, item.id)
        if (!source) continue
        const role = contract.outputRoles?.[item.id]
        const outputId = region.stateOutputAliases.get(item.id) ?? item.id
        outputs[outputId] = {
          source,
          ...(role?.kind === 'state'
            ? { mode: 'state' as const }
            : role?.kind === 'flatten' || role?.kind === 'compact' || role?.kind === 'last' ? { mode: role.kind } : {}),
        }
      }
      const continueSource = contract.continueOutput === undefined
        ? undefined
        : sourceForBoundaryOutput(region, contract.continueOutput)
      nodes[nodeId] = {
        region: {
          kind: contract.kind,
          ports,
          ...(contract.elementPorts !== undefined ? { elementPorts: contract.elementPorts } : {}),
          ...(contract.statePorts !== undefined ? { statePorts: contract.statePorts } : {}),
          ...(contract.binding !== undefined ? { binding: contract.binding } : {}),
          inputs: nativeInputs(compiled, scopeRegion),
          body: buildNativeGraph(region, path),
          outputs,
          ...(contract.maxIterations !== undefined ? { maxIterations: contract.maxIterations } : {}),
          ...(continueSource !== undefined ? { continueSource } : {}),
          ...(contract.cachePolicy !== undefined ? { cachePolicy: contract.cachePolicy } : {}),
        },
      }
    }
    return { nodes }
  }
  const dinksterGraph = emitRegions && included.size > 0 ? buildNativeGraph() : undefined
  if (dinksterGraph !== undefined) {
    diags.push(...validateDinksterGraph(dinksterGraph, validationContext, options?.placement))
    // The engine refuses a node whose inputs bring types its one type
    // variable cannot match; refuse it here before anything is submitted. A
    // Switch whose pick compiled to a stored value is lowered away by the
    // server, so only a linked pick counts.
    for (const fn of flat.values()) {
      if (!included.has(fn.runtimeId) || regions.has(fn.runtimeId)) continue
      if (fn.selector !== undefined && !Array.isArray(fn.inputs[fn.selectorInputKey!])) continue
      for (const conflict of solvedTypes.get(fn.graphId)?.diagnostics ?? []) {
        if (conflict.code !== 'solve.varConflict' || conflict.severity !== 'error' || conflict.data?.['node'] !== fn.node.id) continue
        diags.push(diag('error', 'compile', 'compile.typeVariableConflict', conflict.message, {
          anchor: { occurrence: fn.occ, ...(conflict.anchor?.port !== undefined ? { port: conflict.anchor.port } : {}) },
        }))
      }
    }
  }
  if (diags.some((diagnostic) => diagnostic.severity === 'error')) {
    return { result: { ok: false, diagnostics: diags } }
  }

  const snapshot = deepFreeze(structuredClone(doc) as WorkflowDocument)
  const provenance: Provenance = deepFreeze({
    toSource,
    fromSource,
    inputSources,
    ...(Object.keys(outputAliases).length > 0 ? { outputAliases } : {}),
    ...(Object.keys(dynamicPromptInputs).length > 0 ? { dynamicPromptInputs } : {}),
    ...(controllerInputs.length > 0 ? { controllerInputs } : {}),
  })
  // The whole artifact is deeply owned and frozen (CO1): consumers cache and
  // share it, and a mutated prompt would silently diverge from the snapshot/
  // hash it claims to describe. Everything that could alias caller data
  // (prompt values alias the input document; scope/targets come from the
  // caller) is CLONED before freezing, so the artifact neither shares
  // mutable state with the caller nor freezes caller-owned objects as a
  // side effect.
  const artifact: CompileArtifact = Object.freeze({
    snapshot,
    revision: input.revision,
    semanticHash: semanticHashOf(doc, (type) => resolve(type)?.virtual === true),
    scope: deepFreeze(structuredClone(scope)),
    connection: input.connection,
    schemaHash: input.schemaHash,
    prompt: deepFreeze(structuredClone(prompt)) as Prompt,
    ...(dinksterGraph !== undefined ? { dinksterGraph: deepFreeze(structuredClone(dinksterGraph)) } : {}),
    ...(dinksterTargets !== undefined ? { dinksterTargets: deepFreeze(structuredClone(dinksterTargets)) } : {}),
    ...(partialTargets ? { partialTargets: deepFreeze(structuredClone(partialTargets)) } : {}),
    provenance,
    ...(selectorChoices.length > 0 ? { choices: deepFreeze(structuredClone(selectorChoices)) } : {}),
    diagnostics: deepFreeze(structuredClone(diags)),
  })

  // Would-run structural output: merge the traversal records of consumers
  // that landed in the closure, per graph definition.
  let structural: Map<string, ScopeStructuralGraph> | undefined
  if (wouldRunVia) {
    const acc = new Map<string, { reroutes: Set<string> }>()
    for (const [consumerId, connections] of wouldRunVia) {
      if (!included.has(consumerId)) continue
      const consumer = flat.get(consumerId)
      const inactive = consumer?.selectorProjection?.inactive ?? []
      for (const connection of connections) {
        if (inactive.includes(connection.inputKey)) continue
        for (const { defId, via } of connection.entries) {
          let g = acc.get(defId)
          if (!g) acc.set(defId, (g = { reroutes: new Set() }))
          for (const r of via.reroutes) g.reroutes.add(r)
        }
      }
    }
    structural = acc
  }
  return {
    result: { ok: true, artifact },
    ...(structural ? { structural } : {}),
    ...(wouldRun ? { inactiveExclusive } : {}),
  }
}

/**
 * Upstream closure of a scope, for would-run highlighting. Runs the same
 * flattening as {@link compile} so preview and submission cannot disagree on
 * anything DECIDED: mutes, bypasses, reroutes, subgraph flattening. A random
 * Switch pick is the one undecidable input - its branch is rolled at queue
 * time - so the closure is a SUPERSET there: every branch's upstream counts
 * as "may run", and no chooser is required.
 */
export function scopeClosure(input: CompileInput): ScopeClosure | undefined {
  const { result, structural, inactiveExclusive } = compileImpl(input, true)
  if (!result.ok) return undefined
  const included = new Set(Object.values(result.artifact.provenance.toSource))
  return {
    scope: input.scope,
    revision: input.revision,
    included,
    inactiveExclusive: inactiveExclusive ?? new Map(),
    structural: structural ?? new Map(),
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  // Always walk children: Object.isFrozen only proves the ROOT is frozen; a
  // partially-frozen tree short-circuited here would be wrongly treated as
  // deeply immutable. The per-call `seen` set (NOT isFrozen) dedupes so
  // shared subtrees walk once and a cycle (structuredClone preserves them)
  // terminates instead of overflowing the stack.
  if (value !== null && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v, seen)
    Object.freeze(value)
  }
  return value
}
