/**
 * Reroutes: pure tracing over the ONE authoritative representation.
 *
 * A reroute is a first-class structural junction vertex stored in
 * `GraphDef.reroutes` (geometry in `view.graphs[*].reroutes`). Links
 * reference it via a `{reroute}` endpoint. There are NO parent chains, NO
 * stored reverse link lists, and NO mutable wildcard slots - the three
 * redundancies that made both legacy-Comfy reroute designs collapse under
 * subgraphs. A reroute's upstream is defined solely by the unique link that
 * targets it (one driver, invariant I9); fan-out is just multiple links
 * leaving it.
 *
 * Consequences, all by construction:
 * - Graph-definition scoped: links never cross definitions, so neither do
 *   reroute paths. Subgraphs need zero reroute-specific code.
 * - No type ownership: the effective type is DERIVED by tracing to the real
 *   driving output; display color / drag compatibility read that, documents
 *   never store it.
 * - Compiled away: the compiler traces connections through reroute chains to
 *   the real producer and emits nothing for the reroutes themselves.
 * - An input boundary may feed a junction while retaining a downstream
 *   port as its schema authority. The fan-out remains ordinary graph links.
 */

import type { GraphDef, LinkData } from './format/document.js'
import {
  isRerouteRef,
  isWidgetTapRef,
  portRefKey,
  sameEndpoint,
  type LinkEndpoint,
  type PortRef,
  type RerouteId,
  type NodeId,
  type PortId,
} from './ids.js'
import { inputsOf, outputsOf, type NodeSchema, type TypeExpr } from './schema/model.js'

/**
 * Ephemeral reroute lookup derived from `def.links` in one pass. Links stay
 * the ONE authoritative topology; this is a per-operation acceleration only -
 * build it, use it, drop it. Never store one in a document or across edits
 * (that would recreate the stored-reverse-list redundancy this module bans).
 * Bulk operations (validation, compile, hashing, scene build) that would
 * otherwise call `rerouteDriverOf`/`rerouteSuccessorsOf` per reroute must
 * build one index up front: per-call scans over all links are O(R x L).
 */
export interface RerouteIndex {
  /** Driver link per reroute (first wins on malformed multi-driver docs). */
  readonly driverOf: ReadonlyMap<string, LinkData>
  /** Links leaving each reroute (fan-out). */
  readonly successorsOf: ReadonlyMap<string, readonly LinkData[]>
  readonly inputDriverOf: ReadonlyMap<string, LinkData>
  readonly netSourceOf: ReadonlyMap<string, PortRef>
}

/** Downstream input ports of a boundary-fed junction, in authored link order. */
export function rerouteInputTargets(def: GraphDef, reroute: string): readonly PortRef[] | undefined {
  const index = buildRerouteIndex(def)
  const visit = (id: string, path: ReadonlySet<string>): PortRef[] | undefined => {
    if (!def.reroutes[id] || path.has(id)) return undefined
    const successors = index.successorsOf.get(id)
    if (!successors?.length) return undefined
    const next = new Set([...path, id])
    const targets: PortRef[] = []
    for (const link of successors) {
      if (isRerouteRef(link.to)) {
        const nested = visit(link.to.reroute, next)
        if (!nested) return undefined
        targets.push(...nested)
      } else if (!isWidgetTapRef(link.to)) {
        targets.push(link.to)
      } else return undefined
    }
    return targets
  }
  return visit(reroute, new Set())
}

/** Build a {@link RerouteIndex} for one definition (single pass over links). */
export function buildRerouteIndex(def: GraphDef): RerouteIndex {
  const driverOf = new Map<string, LinkData>()
  const successorsOf = new Map<string, LinkData[]>()
  const inputDriverOf = new Map<string, LinkData>()
  const netSourceOf = new Map<string, PortRef>()
  for (const link of Object.values(def.links)) {
    if (isRerouteRef(link.to) && !driverOf.has(link.to.reroute)) driverOf.set(link.to.reroute, link)
    if (isRerouteRef(link.from)) {
      const list = successorsOf.get(link.from.reroute)
      if (list) list.push(link)
      else successorsOf.set(link.from.reroute, [link])
    }
    if (!isRerouteRef(link.to) && !isWidgetTapRef(link.to)) {
      const key = portRefKey(link.to)
      if (!inputDriverOf.has(key)) inputDriverOf.set(key, link)
    }
  }
  for (const net of Object.values(def.nets)) {
    for (const sink of net.sinks) netSourceOf.set(portRefKey(sink), net.source)
  }
  return { driverOf, successorsOf, inputDriverOf, netSourceOf }
}

/** The unique link driving `rerouteId`, if any (one driver per reroute, I9). */
export function rerouteDriverOf(
  def: GraphDef,
  rerouteId: string,
  index?: RerouteIndex,
): LinkData | undefined {
  if (index) return index.driverOf.get(rerouteId)
  for (const link of Object.values(def.links)) {
    if (isRerouteRef(link.to) && link.to.reroute === rerouteId) return link
  }
  return undefined
}

/** All links leaving `rerouteId` (fan-out). */
export function rerouteSuccessorsOf(
  def: GraphDef,
  rerouteId: string,
  index?: RerouteIndex,
): readonly LinkData[] {
  if (index) return index.successorsOf.get(rerouteId) ?? []
  return Object.values(def.links).filter(
    (l) => isRerouteRef(l.from) && l.from.reroute === rerouteId,
  )
}

export type RerouteTrace =
  /** Resolved to a real producing output port. */
  | { readonly kind: 'output'; readonly ref: PortRef; readonly lastLink?: LinkData }
  /** The chain ends at a reroute with no driver. */
  | { readonly kind: 'undriven'; readonly reroute: RerouteId }
  /** The chain loops back onto itself. */
  | { readonly kind: 'cycle'; readonly reroute: RerouteId }
  | { readonly kind: 'tapValue'; readonly node: NodeId; readonly input: PortId; readonly lastLink?: LinkData }
  | { readonly kind: 'tapCycle'; readonly node: NodeId; readonly input: PortId }
/**
 * Trace an output-side endpoint upstream through any chain of reroutes and
 * widget taps to the real producing output port. A plain port endpoint
 * returns as-is. Pure walk over one definition;
 * never crosses graph boundaries. `lastLink` is the outermost
 * (closest-to-producer) link of the chain, for provenance/ext decisions.
 */
export function traceEndpoint(
  def: GraphDef,
  from: LinkEndpoint,
  index?: RerouteIndex,
): RerouteTrace {
  let current = from
  let lastLink: LinkData | undefined
  const visited = new Set<string>()
  for (;;) {
    if (isWidgetTapRef(current)) {
      const ref: PortRef = { node: current.node, port: current.tap }
      const key = `t:${portRefKey(ref)}`
      if (visited.has(key)) return { kind: 'tapCycle', node: current.node, input: current.tap }
      visited.add(key)
      const driver = index?.inputDriverOf.get(portRefKey(ref)) ?? Object.values(def.links).find((l) =>
        !isRerouteRef(l.to) && !isWidgetTapRef(l.to) && portRefKey(l.to) === portRefKey(ref))
      if (driver) {
        lastLink = driver
        current = driver.from
        continue
      }
      const source = index?.netSourceOf.get(portRefKey(ref)) ?? Object.values(def.nets).find((n) => n.sinks.some((s) => portRefKey(s) === portRefKey(ref)))?.source
      if (source) return lastLink ? { kind: 'output', ref: source, lastLink } : { kind: 'output', ref: source }
      return lastLink ? { kind: 'tapValue', node: current.node, input: current.tap, lastLink } : { kind: 'tapValue', node: current.node, input: current.tap }
    }
    if (!isRerouteRef(current)) {
      return lastLink ? { kind: 'output', ref: current, lastLink } : { kind: 'output', ref: current }
    }
    const id = current.reroute
    if (visited.has(`r:${id}`)) return { kind: 'cycle', reroute: id }
    visited.add(`r:${id}`)
    const driver = rerouteDriverOf(def, id, index)
    if (!driver) return { kind: 'undriven', reroute: id }
    lastLink = driver
    current = driver.from
  }
}

/**
 * Mutable traversal collector for {@link traceEndpointAll}: every structural
 * reroute the walk passes through.
 * Callers that need "what sits on this wire" - the would-run scope preview -
 * supply one; plain tracing skips the bookkeeping entirely.
 */
export interface TraceVia {
  readonly reroutes: Set<string>
}

/**
 * ALL terminal producers reachable upstream of `from`. Reroute chains
 * collapse exactly as in {@link traceEndpoint}. Cycles are silently skipped
 * here - they constrain nothing and are diagnosed by invariants/compile.
 * Results are deduplicated, in deterministic first-reached order, without
 * lastLink provenance. `via`, when supplied, collects every reroute
 * traversed.
 */
export function traceEndpointAll(
  def: GraphDef,
  from: LinkEndpoint,
  index?: RerouteIndex,
  via?: TraceVia,
): RerouteTrace[] {
  const results: RerouteTrace[] = []
  const emitted = new Set<string>()
  const emit = (t: RerouteTrace): void => {
    const key = JSON.stringify(t)
    if (emitted.has(key)) return
    emitted.add(key)
    results.push(t)
  }
  const visited = new Set<string>()
  const stack: LinkEndpoint[] = [from]
  while (stack.length > 0) {
    const current = stack.pop()!
    if (isWidgetTapRef(current)) {
      const ref: PortRef = { node: current.node, port: current.tap }
      const key = `t:${portRefKey(ref)}`
      if (visited.has(key)) continue
      visited.add(key)
      const driver = index?.inputDriverOf.get(portRefKey(ref))
      const source = index?.netSourceOf.get(portRefKey(ref))
      if (driver) stack.push(driver.from)
      else if (source) stack.push(source)
      else emit({ kind: 'tapValue', node: current.node, input: current.tap })
      continue
    }
    if (!isRerouteRef(current)) {
      emit({ kind: 'output', ref: current })
      continue
    }
    const rKey = `r:${current.reroute}`
    if (visited.has(rKey)) continue
    visited.add(rKey)
    via?.reroutes.add(current.reroute)
    const driver = rerouteDriverOf(def, current.reroute, index)
    if (driver) stack.push(driver.from)
    else emit({ kind: 'undriven', reroute: current.reroute })
  }
  return results
}

/**
 * Does the upstream region of `from` (through reroutes) contain the given
 * junction? The shared engine behind the cycle rejections below: connecting
 * `from` into a junction its own upstream already passes through would close
 * a structural loop.
 */
function upstreamHitsJunction(
  def: GraphDef,
  from: LinkEndpoint,
  hits: (e: LinkEndpoint) => boolean,
  index?: RerouteIndex,
): boolean {
  const stack: LinkEndpoint[] = [from]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const current = stack.pop()!
    if (hits(current)) return true
    if (isRerouteRef(current)) {
      if (visited.has(`r:${current.reroute}`)) continue // pre-existing cycle; not ours
      visited.add(`r:${current.reroute}`)
      const driver = rerouteDriverOf(def, current.reroute, index)
      if (driver) stack.push(driver.from)
      continue
    }
    // Port endpoints: real producers, walk ends.
  }
  return false
}

/**
 * Would connecting `from` -> `toReroute` close a cycle? True when the
 * upstream region of `from` passes through `toReroute`. Used by commands to
 * reject cycle-forming connections atomically (invariant I9 stays clean).
 */
export function wouldCreateRerouteCycle(
  def: GraphDef,
  from: LinkEndpoint,
  toReroute: RerouteId,
  index?: RerouteIndex,
): boolean {
  return upstreamHitsJunction(
    def,
    from,
    (e) => isRerouteRef(e) && e.reroute === toReroute,
    index,
  )
}

/** Test a prospective edge against widget-tap alias chains. */
export function wouldCreateTapCycle(def: GraphDef, from: LinkEndpoint, to: LinkEndpoint): boolean {
  const links = Object.fromEntries(
    Object.entries(def.links).filter(([, link]) => !sameEndpoint(link.to, to)),
  ) as GraphDef['links']
  const prospective: LinkData = { id: '__tap_cycle__' as LinkData['id'], from, to }
  const trial: GraphDef = { ...def, links: { ...links, [prospective.id]: prospective } }
  const trace = traceEndpoint(trial, from, buildRerouteIndex(trial))
  return trace.kind === 'tapCycle' || trace.kind === 'cycle'
}

/**
 * Effective display type per reroute in a definition: the type of the real
 * output its chain traces to; wildcard when undriven/cyclic/unresolvable.
 * Advisory only (noodle/dot color, drag-target highlighting) - never stored,
 * never load-bearing.
 */
export function rerouteResolvedTypes(
  def: GraphDef,
  resolve: (nodeType: string) => NodeSchema | undefined,
): ReadonlyMap<string, TypeExpr> {
  const wildcard: TypeExpr = { kind: 'wildcard' }
  const out = new Map<string, TypeExpr>()
  const index = buildRerouteIndex(def)
  for (const reroute of Object.values(def.reroutes)) {
    const trace = traceEndpoint(def, { reroute: reroute.id }, index)
    if (trace.kind === 'tapValue') {
      const source = def.nodes[trace.node]
      const schema = source ? resolve(source.type) : undefined
      const spec = schema ? inputsOf(schema).find((input) => input.id === trace.input) : undefined
      out.set(reroute.id, spec?.type ?? wildcard)
      continue
    }
    if (trace.kind !== 'output') {
      out.set(reroute.id, wildcard)
      continue
    }
    const source = def.nodes[trace.ref.node]
    const schema = source ? resolve(source.type) : undefined
    const spec = schema ? outputsOf(schema).find((o) => o.id === trace.ref.port) : undefined
    out.set(reroute.id, spec?.type ?? wildcard)
  }
  return out
}
