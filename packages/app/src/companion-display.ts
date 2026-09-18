/**
 * Companion display derivation: turns the document's companion SOURCES
 * (link/net-driven widget inputs, from core's companionSourcesOf) into the
 * renderer's display map by resolving producer sources against the tab's
 * BOUND execution's inline output summaries.
 *
 * Provenance rules (architecture: resolved-value display):
 * - literal sources are document-static and ALWAYS exact;
 * - producer values on a FROZEN tab are exact - the frozen document IS the
 *   execution's snapshot, so the run's values are the document's values;
 * - producer values on a LIVE tab are exact only when upstream-recipe
 *   provenance PROVES them current (liveExactnessFor: the producer's
 *   transitive input closure compares identical between a fresh compile of
 *   the live document and the run's artifact, under equal schema hashes and
 *   outside both artifacts' random-selector cones); every occurrence
 *   contributing the value must pass. Anything unprovable stays
 *   conservatively stale - a previous execution's value must never silently
 *   present itself as current;
 * - producer lookup goes through the view's OCCURRENCE mapping (`
 *   runtimeIdsOf`, core/occurrences.ts): the caller resolves each document
 *   node to the runtime ids it owns in the CURRENT view, so nested views
 *   read the navigated instance's values - never a bare inner id that
 *   happens to collide with an unrelated root runtime id. No resolver
 *   (unknown instance path) = abstain. When a node maps to SEVERAL runtime
 *   occurrences (region iterations), the value displays only if every
 *   occurrence that recorded one agrees - an ambiguous multi-iteration
 *   scalar must never present one arbitrary iteration as exact. Literals
 *   are graph-local facts and resolve at any depth.
 *
 * Pure derivation, never stored: the dormant node.values underneath are
 * untouched by construction (this module only reads).
 */

import type { CompanionDisplay, CompanionMap } from '@dinkster/canvas'
import {
  companionSourcesOf,
  upstreamRecipesEqual,
  type CompanionTapValueResolver,
  type CompanionSourceMap,
  type CompileArtifact,
  type GraphDef,
  type MirrorEstimateMap,
  type NodeSchema,
  type NodeProgress,
} from '@dinkster/core'

/**
 * Exactness oracle for producer values on a LIVE tab: given a fresh compile
 * of the live document and the bound run's artifact, returns a predicate
 * telling whether a runtime node's recorded value is provably what the next
 * run would compute. Undefined = nothing provable (caller shows stale).
 *
 * Gates before any structural comparison (each one is a soundness
 * requirement, not an optimization):
 * - both artifacts present: a foreign/reconciled run has no recorded prompt
 *   to compare against, and an uncompilable document proves nothing;
 * - equal schemaHash: identical recipes under different registries can
 *   compute different values (node behavior lives in the schema);
 * - random-selector route provenance whenever either artifact rolled a
 *   selector: older artifacts without that proof fail closed.
 *
 * Past the gates, exactness is upstreamRecipesEqual in prompt space: the
 * engine's cache keys are content-derived over the lowered recipe, so an
 * identical upstream recipe IS the guarantee the engine would serve the
 * same value.
 */
export function liveExactnessFor(
  live: CompileArtifact | undefined,
  ran: CompileArtifact | undefined,
): ((runtimeId: string) => boolean) | undefined {
  if (!live || !ran) return undefined
  if (live.schemaHash !== ran.schemaHash) return undefined
  const rolled = (a: CompileArtifact) => (a.choices ?? []).some((c) => c.policy === 'random')
  if ((rolled(live) && live.provenance?.randomSelectorInputs === undefined) ||
    (rolled(ran) && ran.provenance?.randomSelectorInputs === undefined)) return undefined
  const randomConeContains = (artifact: CompileArtifact, runtimeId: string): boolean => {
    const pending = [runtimeId]
    const seen = new Set<string>()
    while (pending.length > 0) {
      const id = pending.pop()!
      if (seen.has(id)) continue
      seen.add(id)
      if ((artifact.provenance?.randomSelectorInputs?.[id]?.length ?? 0) > 0) return true
      const node = artifact.prompt[id]
      if (node === undefined) continue
      for (const input of Object.values(node.inputs)) {
        if (Array.isArray(input) && input.length === 2 &&
          typeof input[0] === 'string' && typeof input[1] === 'number') pending.push(input[0])
      }
    }
    return false
  }
  return (runtimeId) =>
    !randomConeContains(live, runtimeId) &&
    !randomConeContains(ran, runtimeId) &&
    upstreamRecipesEqual(live.prompt, ran.prompt, runtimeId)
}

export interface CompanionDerivation {
  /** Driven inputs (node id -> port id -> source); read-only widget guard. */
  readonly sources: CompanionSourceMap
  /** node id -> valueKey -> display, ready for renderer.setCompanions. */
  readonly companions: CompanionMap
}

export interface RecordedProducerDisplayArgs {
  /** Bound execution's per-node progress (runtime node id keyed); undefined = no execution. */
  readonly execNodes?: Readonly<Record<string, NodeProgress>> | undefined
  /** Frozen tab: the document is the execution's snapshot (values exact). */
  readonly frozen: boolean
  /**
   * Runtime ids a document node of the CURRENT view owns (occurrence
   * mapping). Undefined = the view's instance path is unknown: producer
   * lookups abstain entirely.
   */
  readonly runtimeIdsOf?: ((nodeId: string) => readonly string[]) | undefined
  /**
   * Live-tab exactness oracle (liveExactnessFor): a producer value shows
   * exact (not stale) only when EVERY occurrence that recorded it passes.
   * Undefined or any failing occurrence = stale. Ignored when frozen.
   */
  readonly exactProducer?: ((runtimeId: string) => boolean) | undefined
  /** Runtime occurrences copied from an older, recipe-proven execution. */
  readonly retainedRuntimeIds?: ReadonlySet<string> | undefined
  /** Backend output ids for occurrence outputs whose native region state id differs. */
  readonly outputAliases?: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined
}

/**
 * Resolve one execution-recorded output without weakening its provenance.
 * Propagation sets requireComplete so a partially reported multi-occurrence
 * output cannot seed one document-level estimate.
 */
export function recordedProducerDisplay(
  args: RecordedProducerDisplayArgs,
  nodeId: string,
  outputId: string,
  requireComplete = false,
): CompanionDisplay | undefined {
  if (args.runtimeIdsOf === undefined) return undefined
  const runtimeIds = args.runtimeIdsOf(nodeId)
  const recorded = new Set<string | number | boolean>()
  const contributors: string[] = []
  for (const runtimeId of runtimeIds) {
    const aliasedOutput = args.outputAliases?.[runtimeId]?.[outputId] ?? outputId
    const inline = args.execNodes?.[runtimeId]?.outputs?.[aliasedOutput]?.value
    if (inline === undefined) continue
    recorded.add(inline)
    contributors.push(runtimeId)
  }
  if (recorded.size !== 1 || (requireComplete && contributors.length !== runtimeIds.length)) return undefined
  const value = [...recorded][0]!
  const retained = contributors.some((runtimeId) => args.retainedRuntimeIds?.has(runtimeId) === true)
  const current = contributors.every((runtimeId) =>
    args.frozen ||
    args.retainedRuntimeIds?.has(runtimeId) === true ||
    args.exactProducer?.(runtimeId) === true)
  if (!current) return { value, stale: true }
  return retained
    ? { value, state: 'cached' }
    : { value }
}

export function deriveCompanions(args: RecordedProducerDisplayArgs & {
  readonly def: GraphDef | undefined
  /** Effective schema default for an unstored widget-tap source. */
  readonly tapValueOf?: CompanionTapValueResolver | undefined
  /** Node schemas carrying exact primitive output-to-input identity declarations. */
  readonly resolveSchema?: ((nodeType: string) => NodeSchema | undefined) | undefined
  /**
   * Mirror-computed output estimates (deriveMirrorEstimates). A producer
   * value that is not proven current displays its estimate instead: the
   * estimate reflects what the NEXT run would compute, while an unproven
   * recorded value belongs to a previous one. Authoritative values (frozen,
   * exact, retained) always win. Ignored when frozen.
   */
  readonly estimates?: MirrorEstimateMap | undefined
}): CompanionDerivation {
  const sources = args.def
    ? companionSourcesOf(args.def, undefined, args.tapValueOf, args.resolveSchema)
    : new Map()
  const companions: Record<string, Record<string, CompanionDisplay>> = {}
  for (const [nodeId, ports] of sources) {
    for (const [portId, source] of ports) {
      let display: CompanionDisplay | undefined
      if (source.kind === 'literal') {
        display = { value: source.value }
      } else {
        const estimate = args.frozen
          ? undefined
          : args.estimates?.get(source.node)?.outputs[source.output]
        display = recordedProducerDisplay(args, source.node, source.output)
        if (display?.stale === true && estimate !== undefined) {
          display = { value: estimate, state: 'estimate' }
        }
        // No usable recorded value (no execution, no mapping, ambiguity):
        // the mirror estimate is the only current information.
        if (display === undefined && estimate !== undefined) {
          display = { value: estimate, state: 'estimate' }
        }
      }
      if (display) (companions[nodeId] ??= {})[portId] = display
    }
  }
  return { sources, companions }
}
