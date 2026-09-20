/**
 * Scene building: document graph + schemas + layout -> a plain,
 * JSON-friendly scene the renderer draws and tests snapshot. Derived, never
 * stored: rebuild on document change (current scale; retained/incremental updates
 * are the optimization path, behind this same shape).
 */

import {
  addressOfElabKey,
  asDynamicMemberId,
  asNodeId,
  asPortId,
  boundaryBindingKey,
  buildGraphConnectivity,
  buildRerouteIndex,
  canonicalCompatTypeIdOf,
  DINKSTER_REGION_PSEUDO_NODE,
  defaultBoundaryLabels,
  effectiveValueSourceSpec,
  effectiveOccurrenceTopology,
  elabKeyOf,
  elaborateInterface,
  hasPreviewSurface,
  inputsOf,
  isOccurrenceKeyWithin,
  isPortEndpoint,
  isRerouteRef,
  isSelectorRef,
  isValueSourceRef,
  isWidgetTapRef,
  netSinkKey,
  netViewPositions,
  occurrenceDynamicView,
  occurrenceFamilyEndpoint,
  occurrenceSubtreeKey,
  portRefKey,
  outputsOf,
  samePortRef,
  solveGraphTypes,
  subgraphDefIdOf,
  traceEndpoint,
  traceEndpointAll,
  typeExprFromTypeId,
  type BoundaryItem,
  type CommandInvocation,
  type Diagnostic,
  type DynamicPortState,
  type DynamicMemberId,
  type ElaboratedInterface,
  type EffectiveValueSourceSpec,
  type EffectiveLinkIdentity,
  type EffectiveOccurrenceTopology,
  type GraphDef,
  type GraphDefId,
  type Json,
  type LinkEndpoint,
  type NodeData,
  type NodeProgress,
  type OccurrenceLinkEndpoint,
  type OccurrenceRef,
  type PortRef,
  type SchemaResolver,
  type SelectorData,
  type SolveResult,
  type TypeExpr,
  type ValueSourceData,
  type VirtualNodeRenderModel,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  connectedPortKey,
  layoutBoundaryNode,
  REGION_INDEX_SLOT,
  layoutNode,
  MINIMIZED_NODE_MIN_WIDTH,
  type BoundarySlotInfo,
  type LayoutRow,
  type NodeLayout,
  type PinLayout,
  type SizeOverride,
  type TextMeasurer,
  type WidgetMeasure,
} from './layout.js'
import type { DesignTokens } from './tokens.js'

interface PositionedSceneCacheEntry {
  readonly graph: GraphDef
  readonly graphSnapshot: Readonly<Record<string, unknown>>
  readonly graphs: WorkflowDocument['graphs']
  readonly documentExt: WorkflowDocument['ext']
  readonly view: WorkflowDocument['view']['graphs'][string]
  readonly seedControllerEnabled: boolean | undefined
  readonly tokens: DesignTokens
  readonly measure: TextMeasurer
  readonly widgetMeasure: WidgetMeasure
  readonly generation: unknown
  readonly scene: Scene
}

const positionedSceneCache = new WeakMap<GraphDef, PositionedSceneCacheEntry>()

const snapshotGraph = (graph: GraphDef): Readonly<Record<string, unknown>> => Object.fromEntries(
  Object.entries(graph).map(([key, value]) => [
    key,
    typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : value,
  ]),
)

const graphMatchesSnapshot = (snapshot: Readonly<Record<string, unknown>>, graph: GraphDef): boolean => {
  const current = graph as unknown as Readonly<Record<string, unknown>>
  const keys = Object.keys(current)
  if (Object.keys(snapshot).length !== keys.length) return false
  return keys.every((key) => {
    const previous = snapshot[key]
    const next = current[key]
    if (typeof previous !== 'object' || previous === null || Array.isArray(previous) ||
        typeof next !== 'object' || next === null || Array.isArray(next)) return previous === next
    const previousRecord = previous as Readonly<Record<string, unknown>>
    const nextRecord = next as Readonly<Record<string, unknown>>
    const nestedKeys = Object.keys(nextRecord)
    return Object.keys(previousRecord).length === nestedKeys.length &&
      nestedKeys.every((nestedKey) => previousRecord[nestedKey] === nextRecord[nestedKey])
  })
}

const onlyNodePositionsChanged = (
  previous: WorkflowDocument['view']['graphs'][string],
  next: WorkflowDocument['view']['graphs'][string],
): boolean => {
  if (previous === undefined || next === undefined ||
      previous.reroutes !== next.reroutes || previous.valueSources !== next.valueSources ||
      previous.selectors !== next.selectors || previous.groups !== next.groups ||
      previous.groupSeq !== next.groupSeq || previous.collapsedNets !== next.collapsedNets ||
      previous.guideNets !== next.guideNets || previous.boundary !== next.boundary || previous.ext !== next.ext) return false
  const previousIds = Object.keys(previous.nodes)
  const nextIds = Object.keys(next.nodes)
  if (previousIds.length !== nextIds.length || previousIds.some((id) => next.nodes[id] === undefined)) return false
  return previousIds.every((id) => {
    const before = previous.nodes[id]!
    const after = next.nodes[id]!
    return before === after || (
      before.size === after.size && before.collapsed === after.collapsed && before.views === after.views &&
      before.sections === after.sections && before.color === after.color && before.ext === after.ext
    )
  })
}

const repositionScene = (
  scene: Scene,
  graph: GraphDef,
  view: NonNullable<WorkflowDocument['view']['graphs'][string]>,
): Scene => {
  let fallbackY = 0
  const positions = new Map<string, { readonly x: number; readonly y: number }>(Object.values(graph.nodes).map((node) => {
    const position = view.nodes[node.id]?.position ?? { x: 40, y: (fallbackY += 120) }
    return [node.id, position] as const
  }))
  const deltas = new Map<string, { x: number; y: number }>()
  const nodes = scene.nodes.map((node) => {
    const position = positions.get(node.id)
    if (position === undefined || (position.x === node.x && position.y === node.y)) return node
    deltas.set(node.id, { x: position.x - node.x, y: position.y - node.y })
    return { ...node, x: position.x, y: position.y }
  })
  if (deltas.size === 0) return scene
  const endDelta = (end: SceneLinkEnd) =>
    end.kind === 'port' || end.kind === 'widgetTap' ? deltas.get(end.node) : undefined
  const links = scene.links.map((link) => {
    const from = endDelta(link.from)
    const to = endDelta(link.to)
    return from === undefined && to === undefined ? link : {
      ...link,
      x1: link.x1 + (from?.x ?? 0),
      y1: link.y1 + (from?.y ?? 0),
      x2: link.x2 + (to?.x ?? 0),
      y2: link.y2 + (to?.y ?? 0),
    }
  })
  const netStubs = scene.netStubs.map((stub) => {
    const delta = deltas.get(stub.nodeId)
    if (delta === undefined) return stub
    return {
      ...stub,
      pinX: stub.pinX + delta.x,
      pinY: stub.pinY + delta.y,
      x: stub.x + (stub.authoredAbsolute === true ? 0 : delta.x),
      y: stub.y + (stub.authoredAbsolute === true ? 0 : delta.y),
    }
  })
  return { ...scene, nodes, links, netStubs }
}

const matchVariableOf = (type: TypeExpr): string | undefined => {
  let element = type
  while (element.kind === 'list' || element.kind === 'asset' || element.kind === 'stream') element = element.element
  return element.kind === 'variable' ? element.templateId : undefined
}

const matchConstraintOf = (type: TypeExpr): TypeExpr | undefined => {
  let element = type
  while (element.kind === 'list' || element.kind === 'asset' || element.kind === 'stream') element = element.element
  return element.kind === 'variable' && element.allowedTypes !== undefined && element.allowedTypes.length > 0
    ? type
    : undefined
}

const sameTypeExpr = (left: TypeExpr, right: TypeExpr): boolean => {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case 'concrete': return left.name === (right as typeof left).name
    case 'union': {
      const names = (right as typeof left).names
      return left.names.length === names.length && left.names.every((name, index) => name === names[index])
    }
    case 'wildcard': return true
    case 'variable': {
      const other = right as typeof left
      const leftAllowed = left.allowedTypes ?? []
      const rightAllowed = other.allowedTypes ?? []
      return left.templateId === other.templateId &&
        leftAllowed.length === rightAllowed.length &&
        leftAllowed.every((type, index) => sameTypeExpr(type, rightAllowed[index]!))
    }
    case 'list':
    case 'asset':
    case 'stream': return sameTypeExpr(left.element, (right as typeof left).element)
  }
}

export interface SceneNode {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly layout: NodeLayout
  readonly node: NodeData
  readonly virtual?: VirtualNodeRenderModel
  /** Full effective interface, including inputs hidden by presentation state. */
  readonly elaborated?: ElaboratedInterface
  /** Schema declares live previews or an output intended for preview. */
  readonly previewCapable?: true
  /** Optional user-selected identity color projected from node view state. */
  readonly color?: string
  /** '#<defId>' instance nodes get the subgraph badge. */
  readonly isSubgraph: boolean
  /** Presentation-only projection of an occurrence-local repetition contract. */
  readonly regionKind?: 'map' | 'fold' | 'while'
  /** Set when the document resolver has no schema for the node type. */
  readonly unrecognized?: true
  /** Set when the node's schema could not be resolved (rendered as an error shell). */
  readonly missingSchema?: boolean
}

/**
 * A boundary pseudo-node: the node-like Inputs/Outputs panel shown while
 * editing a subgraph definition. DERIVED from GraphDef.boundary every build
 * (never NodeData, never stored); only its position persists, in
 * GraphViewState.boundary. Pin portId = boundary item id.
 */
export interface SceneBoundaryNode {
  readonly side: 'inputs' | 'outputs'
  readonly x: number
  readonly y: number
  readonly layout: NodeLayout
}

/**
 * Tagged scene identity of a boundary pseudo-node for drag-offset maps.
 * Pseudo-nodes live in their own scene array (never scene.nodes), so this
 * id can NEVER collide with document node ids in hit paths; the offset map
 * is the only shared keyspace and the '@boundary:' tag keeps it distinct.
 */
export const boundarySceneId = (side: 'inputs' | 'outputs'): string => `@boundary:${side}`

/** One end of a scene noodle: a node port pin, a reroute junction, a value source, or a boundary pseudo-node pin. */
export type SceneLinkEnd =
  | {
      readonly kind: 'port'
      readonly node: string
      readonly port: string
      /** Dynamic-family member path (document identity, mirrors PortRef). */
      readonly members?: readonly DynamicMemberId[]
    }
  | { readonly kind: 'reroute'; readonly reroute: string }
  | { readonly kind: 'valueSource'; readonly valueSource: string }
  | { readonly kind: 'widgetTap'; readonly node: string; readonly input: string }
  /** A selector endpoint: with `candidate` = one branch input, without = the output. */
  | { readonly kind: 'selector'; readonly selector: string; readonly candidate?: string }
  /** A boundary pseudo-node pin; `item` is the boundary item id (opaque - never split). */
  | { readonly kind: 'boundary'; readonly side: 'inputs' | 'outputs'; readonly item: string }

/** The elab key a port end's pin is laid out under (pins are keyed by elab key). */
export const portEndKey = (end: {
  port: string
  members?: readonly DynamicMemberId[]
}): string =>
  elabKeyOf({ port: end.port, ...(end.members !== undefined ? { members: end.members } : {}) })

export const netDeliveryLinkId = (netId: string, sinkIndex: number): string => `${netId}:${sinkIndex}`

/**
 * A consumer end: value sources produce, never consume (invariant I10), so a
 * link's `to` is structurally narrower than its `from`.
 */
export type SceneLinkTo = Exclude<SceneLinkEnd, { kind: 'valueSource' }>

/** The scene id a link end rides during drags (node, reroute, source, selector, or boundary pseudo-node id). */
export const sceneEndId = (end: SceneLinkEnd): string =>
  end.kind === 'port'
    ? end.node
    : end.kind === 'reroute'
      ? end.reroute
      : end.kind === 'valueSource'
        ? end.valueSource
        : end.kind === 'widgetTap'
          ? end.node
        : end.kind === 'selector'
          ? end.selector
          : boundarySceneId(end.side)

export interface SceneLink {
  readonly id: string
  readonly from: SceneLinkEnd
  readonly to: SceneLinkTo
  /** Absolute endpoint coordinates (source pin -> target pin). */
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
  /** Declared endpoint types, retained for link-splice search. */
  readonly fromType?: TypeExpr
  readonly toType?: TypeExpr
  /** Concrete type name driving link color, when statically known. */
  readonly typeName?: string
  /**
   * The traced producer declares an optional output: this value may
   * deliberately not exist at runtime. Rendered distinctly (dashed), and
   * DISTINCT from error/conflict styling - maybe-absent is normal.
   */
  readonly maybeAbsent?: true
  /**
   * Set when this noodle renders a named-net fan-out rather than a document
   * link. Its `id` is synthetic (`netId:index`); deletion must go through
   * net commands with the sink PortRef (its `to` is always a port), never
   * link commands.
   */
  readonly netId?: string
  /**
   * The solver PROVED this edge's endpoint types incompatible. 'unknown'
   * verdicts (generic or wildcard endpoints) deliberately do not mark:
   * uncertainty is normal, only demonstrated conflict earns error paint.
   */
  readonly mismatch?: true
  /** Solver diagnostics attributed to this proven-mismatch noodle. */
  readonly diagnostics?: readonly Diagnostic[]
  /** The net's user-facing name (drawn as a midpoint label). */
  readonly netName?: string
  /**
   * Collapsed-net noodle: the connection is real and participates in every
   * connectivity decision (pin styling, widget suppression, gestures,
   * occupancy), but it is never painted, hit-tested, or shown in the
   * minimap. Collapsing a net is purely visual.
   */
  readonly hidden?: true
  /**
   * Set when this noodle renders a boundary BINDING rather than a document
   * link (its `id` is synthetic). Exposure edits go through boundary
   * commands, never link commands, so these are not link hit targets.
   */
  readonly boundary?: true
  /**
   * Boundary noodles only: the inner binding is a dynamic FAMILY, not one
   * exact port, so its inner anchor may legally sit on the first
   * family-member pin or the header center (see innerAnchor). Exact 'port'
   * bindings never set this - their anchor must be the precise real pin.
   */
  readonly boundaryFamily?: true
  /** Effective owner identity used by drilled occurrence gestures. */
  readonly effectiveIdentity?: EffectiveLinkIdentity
  /** Every delivery represented by a coincident projected boundary alias. */
  readonly effectiveIdentities?: readonly EffectiveLinkIdentity[]
}

export type OccurrenceLinkIntention =
  | { readonly kind: 'connect'; readonly owner: OccurrenceRef; readonly bodyGraph: GraphDefId; readonly from: OccurrenceLinkEndpoint; readonly to: OccurrenceLinkEndpoint }
  | { readonly kind: 'disconnect'; readonly owner: OccurrenceRef; readonly bodyGraph: GraphDefId; readonly link: EffectiveLinkIdentity }
  | { readonly kind: 'rewire'; readonly owner: OccurrenceRef; readonly bodyGraph: GraphDefId; readonly link: EffectiveLinkIdentity; readonly to: OccurrenceLinkEndpoint }
  | { readonly kind: 'rewireSource'; readonly owner: OccurrenceRef; readonly bodyGraph: GraphDefId; readonly links: readonly EffectiveLinkIdentity[]; readonly from: OccurrenceLinkEndpoint }

export interface OccurrenceMutationPlanner {
  planOccurrenceLinkMutation(
    document: WorkflowDocument,
    resolver: SchemaResolver,
    intention: OccurrenceLinkIntention,
  ):
    | { readonly ok: true; readonly invocation: CommandInvocation }
    | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] }
}

/**
 * A reroute junction: a draggable dot noodles pass through. Topology lives in
 * the document (`GraphDef.reroutes` + link endpoints); this carries geometry
 * and the traced effective type for coloring.
 */
export interface SceneReroute {
  readonly id: string
  /** Center, world coords. */
  readonly x: number
  readonly y: number
  /** Concrete type traced from the driving output, when statically known. */
  readonly typeName?: string
}

/** Reroute dot radius (world units). A deliberately large junction: easy to grab, reads as a station on the noodle. */
export const REROUTE_RADIUS = 13

/**
 * Ghost socket geometry for a HOVERED reroute: an input socket floats left
 * of the dot and an output socket right of it, advertising that links can
 * be pulled out of (or into) the junction without the undiscoverable
 * Alt+drag. One constant pair shared by renderer AND hit testing so the
 * painted circle and its grab region can never drift apart.
 */
export const REROUTE_SOCKET_OFFSET = REROUTE_RADIUS + 8
export const REROUTE_SOCKET_RADIUS = 5

/**
 * A value source rendered as a compact literal pill: title + value + spec
 * badge + ONE output pin. It is NOT a node - no schema, no input pins, no
 * rows - and it compiles away entirely. The effective widget spec (and its
 * declared/derived/conflict status) is derived at build time, never stored.
 */
export interface SceneValueSource {
  readonly id: string
  /** Top-left, world coords. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly source: ValueSourceData
  /** Display title: explicit title, else the effective widget kind, else 'value'. */
  readonly title: string
  /** Compact one-line value text (raw JSON rendering for non-strings). */
  readonly valueText: string
  /** Effective spec + consumers + diagnostics, derived during build. */
  readonly effective: EffectiveValueSourceSpec
  /** Advisory concrete type (pin/noodle color), when determinable. */
  readonly typeName?: string
  /** declared: pinned spec; derived: unified from consumers; raw: neither. */
  readonly specState: 'declared' | 'derived' | 'raw'
  /** Derivation reported conflicts (badge renders as a warning). */
  readonly conflict: boolean
}

export const VS_HEIGHT_PAD = 8
export const VS_MIN_WIDTH = 90
export const VS_BADGE_SIZE = 14
/** Badge inset from the pill's right edge. */
export const VS_BADGE_INSET = 6

/** A value source's single output pin center, world coords. */
export const valueSourcePinPosition = (vs: SceneValueSource): { x: number; y: number } => ({
  x: vs.x + vs.width,
  y: vs.y + vs.height / 2,
})

/** World-space rect of a value source's spec badge (declared/derived/conflict). */
export function valueSourceBadgeRect(vs: SceneValueSource): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
} {
  return {
    x: vs.x + vs.width - VS_BADGE_SIZE - VS_BADGE_INSET,
    y: vs.y + vs.height / 2 - VS_BADGE_SIZE / 2,
    width: VS_BADGE_SIZE,
    height: VS_BADGE_SIZE,
  }
}

/** Compact one-line value text ('' for null; first line of strings). */
export const valueSourceValueText = (value: Json): string =>
  value === null ? '' : typeof value === 'string' ? (value.split('\n')[0] ?? '') : JSON.stringify(value)

/**
 * One candidate row of a selector: a branch input pin plus its label.
 * `y` is the pin/row center relative to the selector's top edge.
 */
export interface SceneSelectorCandidate {
  readonly id: string
  readonly label: string
  readonly y: number
  /** Concrete type traced from this branch's driver, when statically known. */
  readonly typeName?: string
}

/**
 * A selector rendered as a compact node-like box: header (title + policy
 * badge + ONE output pin) over one row per candidate branch. It is NOT a
 * node - no schema, no widgets - and unselected branches compile away.
 * Semantics live in GraphDef.selectors; this carries geometry plus traced
 * types for coloring.
 */
export interface SceneSelector {
  readonly id: string
  /** Top-left, world coords. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly headerHeight: number
  readonly data: SelectorData
  /** Display title: explicit title, else 'Select'. */
  readonly title: string
  readonly candidates: readonly SceneSelectorCandidate[]
  /** The fixed policy's chosen candidate id (undefined under random policy). */
  readonly activeCandidate?: string
  /** True under random policy (badge renders as a die). */
  readonly random: boolean
  /** Output color: the single concrete type ALL driven branches agree on. */
  readonly typeName?: string
}

export const SELECTOR_MIN_WIDTH = 110
export const SELECTOR_BADGE_SIZE = 14
/** Badge inset from the selector's right edge (header band). */
export const SELECTOR_BADGE_INSET = 6

/** A selector's single output pin center, world coords (header band, right edge). */
export const selectorOutPinPosition = (sel: SceneSelector): { x: number; y: number } => ({
  x: sel.x + sel.width,
  y: sel.y + sel.headerHeight / 2,
})

/** One candidate's input pin center, world coords (left edge at its row). */
export const selectorCandidatePinPosition = (
  sel: SceneSelector,
  candidateId: string,
): { x: number; y: number } | undefined => {
  const c = sel.candidates.find((cand) => cand.id === candidateId)
  return c ? { x: sel.x, y: sel.y + c.y } : undefined
}

/** World-space rect of a selector's policy badge (fixed/random details + menu). */
export function selectorBadgeRect(sel: SceneSelector): {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
} {
  return {
    x: sel.x + sel.width - SELECTOR_BADGE_SIZE - SELECTOR_BADGE_INSET,
    y: sel.y + sel.headerHeight / 2 - SELECTOR_BADGE_SIZE / 2,
    width: SELECTOR_BADGE_SIZE,
    height: SELECTOR_BADGE_SIZE,
  }
}

/**
 * A collapsed net's endpoint tag: drawn beside the pin instead of noodles.
 * Geometry is precomputed here (the scene has the measurer) so drawing and
 * hit-testing agree without re-measuring text.
 */
export interface SceneNetStub {
  readonly id: string
  readonly netId: string
  readonly name: string
  readonly role: 'source' | 'sink'
  /** Solver-proven mismatch for this sink, or any sink for a source tag. */
  readonly mismatch?: true
  readonly nodeId: string
  readonly portId: string
  /** Dynamic-family member path (document identity, mirrors PortRef). */
  readonly members?: readonly DynamicMemberId[]
  /** Pin center the tag points at, world coords. */
  readonly pinX: number
  readonly pinY: number
  /** Tag rect, world coords. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** True when x/y came from advisory dinkster.netViews geometry. */
  readonly authored?: true
  /**
   * True when that geometry is the retired absolute form (owning node had no
   * stored position when it was written): the tag renders where it was saved
   * and does not follow the node. Offset-authored and unauthored tags follow.
   */
  readonly authoredAbsolute?: true
  /** Net is in guide display mode: a dashed Set-to-Get curve joins its tags. */
  readonly guide?: true
  /** Concrete type name driving tag color, when statically known. */
  readonly typeName?: string
}

/** Gap between a node edge and its net stub tags. */
export const NET_STUB_GAP = 10
export const NET_STUB_HEIGHT = 18
export const NET_STUB_PAD_X = 6

export const netStubId = (netId: string, role: 'source' | 'sink', ref: PortRef): string =>
  JSON.stringify(['netView', netId, role, ref.node, ref.port, ref.members ?? []])

/**
 * A visual group rectangle (view state passed through verbatim). Groups have
 * NO stored membership: which nodes a group carries is derived spatially at
 * interaction time via `nodesInGroup`.
 */
export interface SceneGroup {
  readonly id: string
  readonly title: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly color?: string
}

/** Height of a group's title band (world units): drag handle + hit target. */
export const GROUP_HEADER_HEIGHT = 26

export interface Scene {
  readonly graphId: string
  readonly nodes: readonly SceneNode[]
  readonly links: readonly SceneLink[]
  readonly reroutes: readonly SceneReroute[]
  readonly valueSources: readonly SceneValueSource[]
  readonly selectors: readonly SceneSelector[]
  readonly netStubs: readonly SceneNetStub[]
  readonly groups: readonly SceneGroup[]
  /** Boundary pseudo-nodes (subgraph definitions only; empty elsewhere). */
  readonly boundaryNodes: readonly SceneBoundaryNode[]
  /**
   * Solver diagnostics for THIS graph (type mismatches, stale DynamicSlot
   * specializations, ...). Derived state, replaced wholesale on every scene
   * build - consumers must present it as live status, never append it to an
   * event log, or every rebuild would duplicate entries.
   */
  readonly diagnostics: readonly Diagnostic[]
  readonly occurrence?: { readonly owner: OccurrenceRef; readonly bodyGraph: GraphDefId }
}

/**
 * Node ids a group carries: node CENTER inside the group bounds. Derived at
 * interaction time (drag start), never stored, so membership can never go
 * stale. Boundary pseudo-nodes use the same center rule.
 */
export function nodesInGroup(scene: Scene, group: SceneGroup): string[] {
  const out: string[] = []
  for (const node of scene.nodes) {
    const cx = node.x + node.layout.width / 2
    const cy = node.y + node.layout.height / 2
    if (cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height) {
      out.push(node.id)
    }
  }
  return out
}

/** Reroute ids a group carries: the junction point is inside its bounds. */
export function reroutesInGroup(scene: Scene, group: SceneGroup): string[] {
  return scene.reroutes
    .filter((r) => r.x >= group.x && r.x <= group.x + group.width && r.y >= group.y && r.y <= group.y + group.height)
    .map((r) => r.id)
}

/** Value source ids a group carries, using the same center rule as nodes. */
export function valueSourcesInGroup(scene: Scene, group: SceneGroup): string[] {
  return scene.valueSources
    .filter((v) => {
      const cx = v.x + v.width / 2
      const cy = v.y + v.height / 2
      return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height
    })
    .map((v) => v.id)
}

/** Selector ids a group carries, using the same center rule as nodes. */
export function selectorsInGroup(scene: Scene, group: SceneGroup): string[] {
  return scene.selectors
    .filter((s) => {
      const cx = s.x + s.width / 2
      const cy = s.y + s.height / 2
      return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height
    })
    .map((s) => s.id)
}

/** Boundary pseudo-node sides a group carries, using the node-center rule. */
export function boundaryNodesInGroup(scene: Scene, group: SceneGroup): Array<'inputs' | 'outputs'> {
  return scene.boundaryNodes
    .filter((node) => {
      const cx = node.x + node.layout.width / 2
      const cy = node.y + node.layout.height / 2
      return cx >= group.x && cx <= group.x + group.width && cy >= group.y && cy <= group.y + group.height
    })
    .map((node) => node.side)
}

type ProjectedTypeConstraint = NonNullable<NonNullable<Parameters<typeof solveGraphTypes>[2]>['projectedInputs']>[number]

/** Resolve parent producers outward so each drilled graph receives only its occurrence's constraints. */
function projectedTypeConstraints(
  document: WorkflowDocument,
  resolve: SchemaResolver,
  topology: EffectiveOccurrenceTopology,
  graphId: string,
): readonly ProjectedTypeConstraint[] {
  type ProjectionSolve = {
    readonly graph: GraphDef
    readonly result: SolveResult
    readonly variableSources: ReadonlyMap<import('@dinkster/core').NodeId, symbol>
  }
  const cache = new Map<string, ProjectionSolve>()
  const constraintsOf = (
    effective: EffectiveOccurrenceTopology | undefined,
    targetGraphId: string,
  ): readonly ProjectedTypeConstraint[] => (effective?.projectedParentLinks ?? []).flatMap((link) => {
    if (link.to.graphId !== targetGraphId || !isPortEndpoint(link.to.endpoint)) return []
    const solved = solveProjectionGraph(link.from.graphId, link.from.instancePath)
    if (solved === undefined) return []
    return traceEndpointAll(solved.graph, link.from.endpoint, buildRerouteIndex(solved.graph)).flatMap((trace) => {
      if (trace.kind !== 'output') return []
      const type = solved.result.portTypeOf(trace.ref.node, 'output', elabKeyOf(trace.ref))
      return type === undefined ? [] : [{
        type,
        to: link.to.endpoint as PortRef,
        label: `projected ${JSON.stringify(link.identity)}`,
        variableSource: solved.variableSources.get(trace.ref.node)!,
      }]
    })
  })
  const solveProjectionGraph = (
    sourceGraphId: string,
    instancePath: readonly import('@dinkster/core').NodeId[],
  ): ProjectionSolve | undefined => {
    const key = JSON.stringify([sourceGraphId, instancePath])
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const graph = document.graphs[sourceGraphId]
    if (graph === undefined) return undefined
    const owner = instancePath.length === 0 ? undefined : {
      instancePath: instancePath.slice(0, -1),
      node: instancePath[instancePath.length - 1]!,
    }
    const effective = owner === undefined ? undefined : effectiveOccurrenceTopology(document, resolve, owner)
    const occurrenceView = occurrenceDynamicView(document, resolve, instancePath)
    const solveGraph: GraphDef = {
      ...graph,
      nodes: Object.fromEntries(Object.entries(graph.nodes).map(([id, node]) => {
        const dynamic = occurrenceView?.dynamic.get(id)
        const values = occurrenceView?.values.get(id)
        return [id, dynamic === undefined && values === undefined
          ? node
          : { ...node, ...(values !== undefined ? { values } : {}), ...(dynamic !== undefined ? { dynamic } : {}) }]
      })),
      links: effective === undefined ? graph.links : Object.fromEntries(effective.links.map((link, index) => [
        `__projection_solve_${index}`,
        {
          id: `__projection_solve_${index}` as import('@dinkster/core').LinkId,
          from: link.from.endpoint,
          to: link.to.endpoint,
        },
      ])) as GraphDef['links'],
      nets: effective === undefined ? graph.nets : {},
    }
    const baseConnectivity = buildGraphConnectivity(solveGraph)
    const projectedInputKeys = new Map<string, Set<string>>()
    const projectedOutputKeys = new Map<string, Set<string>>()
    const projectedInputPortKeys = new Map<string, Set<string>>()
    for (const link of effective?.projectedParentLinks ?? []) {
      if (link.from.graphId === graph.id && isPortEndpoint(link.from.endpoint)) {
        const keys = projectedOutputKeys.get(link.from.endpoint.node) ?? new Set<string>()
        keys.add(portEndKey(link.from.endpoint))
        projectedOutputKeys.set(link.from.endpoint.node, keys)
      }
      if (link.to.graphId === graph.id && isPortEndpoint(link.to.endpoint)) {
        const keys = projectedInputKeys.get(link.to.endpoint.node) ?? new Set<string>()
        keys.add(portEndKey(link.to.endpoint))
        projectedInputKeys.set(link.to.endpoint.node, keys)
        if (link.to.endpoint.members === undefined || link.to.endpoint.members.length === 0) {
          const ports = projectedInputPortKeys.get(link.to.endpoint.node) ?? new Set<string>()
          ports.add(link.to.endpoint.port)
          projectedInputPortKeys.set(link.to.endpoint.node, ports)
        }
      }
    }
    const connectivityOf = (nodeId: import('@dinkster/core').NodeId) => {
      const base = baseConnectivity(nodeId)
      return {
        isInputConnected: (port: string, members?: readonly string[]) =>
          projectedInputKeys.get(nodeId)?.has(portEndKey({ port: asPortId(port), ...(members === undefined ? {} : { members: members as readonly DynamicMemberId[] }) })) ||
          base.isInputConnected(port, members),
        isOutputConnected: (port: string, members?: readonly string[]) =>
          projectedOutputKeys.get(nodeId)?.has(portEndKey({ port: asPortId(port), ...(members === undefined ? {} : { members: members as readonly DynamicMemberId[] }) })) ||
          base.isOutputConnected(port, members),
        inputPorts: () => [...new Set([...(base.inputPorts?.() ?? []), ...(projectedInputPortKeys.get(nodeId) ?? [])])],
      }
    }
    const result = solveGraphTypes(solveGraph, resolve, {
      connectivityOf,
      projectedInputs: constraintsOf(effective, graph.id),
    })
    const variableSources = new Map(
      Object.keys(solveGraph.nodes).map((nodeId) => [asNodeId(nodeId), Symbol(nodeId)]),
    )
    const solved = { graph: solveGraph, result, variableSources }
    cache.set(key, solved)
    return solved
  }
  return constraintsOf(topology, graphId)
}

export interface BuildSceneInput {
  readonly document: WorkflowDocument
  /** App capability controlling seed-controller UI construction. */
  readonly seedControllerEnabled?: boolean
  /** Graph definition to render (the root, or a subgraph being edited). */
  readonly graphId: string
  readonly resolve: SchemaResolver
  readonly renderVirtualNode?: (node: NodeData) => VirtualNodeRenderModel | undefined
  readonly tokens: DesignTokens
  readonly measure: TextMeasurer
  readonly widgetMeasure: WidgetMeasure
  /** Enables position-only root-scene reuse until rendering capabilities change. */
  readonly layoutGeneration?: unknown
  /** Concrete drilled owner plus the integration capability gate. */
  readonly occurrence?: {
    readonly owner: OccurrenceRef
    readonly plannerAvailable: boolean
  }
  readonly occurrenceView?: {
    readonly dynamic: ReadonlyMap<string, Readonly<Record<string, DynamicPortState>>>
    readonly values?: ReadonlyMap<string, Readonly<Record<string, Json>>>
    readonly controllers?: import('@dinkster/core').OccurrenceDynamicView['controllers']
    readonly subtreeOwners?: import('@dinkster/core').OccurrenceDynamicView['subtreeOwners']
    readonly valueOwners?: ReadonlyMap<string, ReadonlyMap<string, {
      readonly graphId: string
      readonly nodeId: string
      readonly valueKey: string
    }>>
    readonly selectorOwners: ReadonlyMap<string, ReadonlyMap<string, { readonly graphId: string; readonly nodeId: string; readonly boundaryId: string }>>
    readonly familyOwners?: ReadonlyMap<string, ReadonlyMap<string, {
      readonly graphId: string
      readonly nodeId: string
      readonly boundaryId: string
      readonly occurrence: import('@dinkster/core').OccurrenceRef
      readonly familyPath: string
      readonly suffixMembers: ReadonlyMap<string, string>
      readonly ghostOwner: {
        readonly graphId: string
        readonly nodeId: string
        readonly boundaryId: string
        readonly occurrence: import('@dinkster/core').OccurrenceRef
        readonly sourceMember: string
        readonly route: readonly import('@dinkster/core').BoundaryRouteLeg[]
      }
      readonly route: readonly import('@dinkster/core').BoundaryRouteLeg[]
      readonly suffixOwners: ReadonlyMap<string, {
        readonly graphId: string
        readonly nodeId: string
        readonly boundaryId: string
        readonly occurrence: import('@dinkster/core').OccurrenceRef
        readonly sourceMember: string
        readonly route: readonly import('@dinkster/core').BoundaryRouteLeg[]
      }>
    }>>
  }
}

function sameReferencesExcept(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
  excluded: string,
): boolean {
  const leftKeys = Object.keys(left).filter((key) => key !== excluded)
  const rightKeys = Object.keys(right).filter((key) => key !== excluded)
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}

function positionOnlyNodeViewChange(
  previous: WorkflowDocument,
  current: WorkflowDocument,
  graphId: string,
): boolean {
  if (!sameReferencesExcept(previous as unknown as Readonly<Record<string, unknown>>, current as unknown as Readonly<Record<string, unknown>>, 'view')) return false
  if (!sameReferencesExcept(previous.view as unknown as Readonly<Record<string, unknown>>, current.view as unknown as Readonly<Record<string, unknown>>, 'graphs')) return false
  if (!sameReferencesExcept(previous.view.graphs, current.view.graphs, graphId)) return false

  const previousGraph = previous.view.graphs[graphId]
  const currentGraph = current.view.graphs[graphId]
  if (previousGraph === undefined || currentGraph === undefined) return false
  if (!sameReferencesExcept(previousGraph as unknown as Readonly<Record<string, unknown>>, currentGraph as unknown as Readonly<Record<string, unknown>>, 'nodes')) return false

  const nodeIds = new Set([...Object.keys(previousGraph.nodes), ...Object.keys(currentGraph.nodes)])
  for (const nodeId of nodeIds) {
    const previousNode = previousGraph.nodes[nodeId]
    const currentNode = currentGraph.nodes[nodeId]
    if (previousNode === currentNode) continue
    if (previousNode === undefined) {
      if (currentNode === undefined || Object.keys(currentNode).some((key) => key !== 'position')) return false
      continue
    }
    if (currentNode === undefined) {
      if (Object.keys(previousNode).some((key) => key !== 'position')) return false
      continue
    }
    if (!sameReferencesExcept(previousNode as unknown as Readonly<Record<string, unknown>>, currentNode as unknown as Readonly<Record<string, unknown>>, 'position')) return false
  }
  return true
}

/**
 * Reproject an already-built scene when immutable document updates changed
 * only node positions. Undefined means the caller must perform a full build.
 */
export function updateSceneNodePositions(
  scene: Scene,
  previous: WorkflowDocument,
  current: WorkflowDocument,
  graphId: string,
): Scene | undefined {
  const def = current.graphs[graphId]
  if (scene.graphId !== graphId || def === undefined || !positionOnlyNodeViewChange(previous, current, graphId)) return undefined

  const graphView = current.view.graphs[graphId]
  if (graphView === undefined) return undefined
  if (def.boundary !== undefined &&
      (graphView.boundary?.inputs?.position === undefined || graphView.boundary?.outputs?.position === undefined)) return undefined

  const previousNodes = new Map(scene.nodes.map((node) => [node.id, node]))
  const deltas = new Map<string, { readonly x: number; readonly y: number }>()
  let fallbackY = 0
  const nodes = Object.values(def.nodes).map((node) => {
    const existing = previousNodes.get(node.id)
    if (existing === undefined) return undefined
    const position = graphView.nodes[node.id]?.position ?? { x: 40, y: (fallbackY += 120) }
    const delta = { x: position.x - existing.x, y: position.y - existing.y }
    if (delta.x === 0 && delta.y === 0) return existing
    deltas.set(node.id, delta)
    return { ...existing, x: position.x, y: position.y }
  })
  if (nodes.some((node) => node === undefined) || nodes.length !== scene.nodes.length) return undefined
  if (deltas.size === 0) return scene

  const links = scene.links.map((link) => {
    const from = deltas.get(sceneEndId(link.from))
    const to = deltas.get(sceneEndId(link.to))
    if (from === undefined && to === undefined) return link
    return {
      ...link,
      x1: link.x1 + (from?.x ?? 0),
      y1: link.y1 + (from?.y ?? 0),
      x2: link.x2 + (to?.x ?? 0),
      y2: link.y2 + (to?.y ?? 0),
    }
  })
  const netStubs = scene.netStubs.map((stub) => {
    const delta = deltas.get(stub.nodeId)
    if (delta === undefined) return stub
    return {
      ...stub,
      pinX: stub.pinX + delta.x,
      pinY: stub.pinY + delta.y,
      x: stub.x + (stub.authoredAbsolute === true ? 0 : delta.x),
      y: stub.y + (stub.authoredAbsolute === true ? 0 : delta.y),
    }
  })
  return { ...scene, nodes: nodes as SceneNode[], links, netStubs }
}

export function buildScene(input: BuildSceneInput): Scene {
  const def: GraphDef | undefined = input.document.graphs[input.graphId]
  if (!def) return { graphId: input.graphId, nodes: [], links: [], reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [] }
  const view = input.document.view.graphs[input.graphId]
  const positioned = positionedSceneCache.get(def)
  if (view !== undefined && input.layoutGeneration !== undefined && input.occurrence === undefined && input.occurrenceView === undefined &&
      positioned?.graph === def && graphMatchesSnapshot(positioned.graphSnapshot, def) &&
      positioned.graphs === input.document.graphs && positioned.documentExt === input.document.ext &&
      positioned.seedControllerEnabled === input.seedControllerEnabled &&
      positioned.tokens === input.tokens && positioned.measure === input.measure && positioned.widgetMeasure === input.widgetMeasure &&
      positioned.generation === input.layoutGeneration && onlyNodePositionsChanged(positioned.view, view)) {
    const scene = repositionScene(positioned.scene, def, view)
    positionedSceneCache.set(def, { ...positioned, view, scene })
    return scene
  }
  const widths = new Map<string, number>()
  const measure: TextMeasurer = (text, role) => {
    const key = `${role}\u0000${text}`
    let width = widths.get(key)
    if (width === undefined) widths.set(key, (width = input.measure(text, role)))
    return width
  }
  const effective = input.occurrence === undefined
    ? undefined
    : effectiveOccurrenceTopology(input.document, input.resolve, input.occurrence.owner)
  // One ephemeral reroute index per scene build; per-trace link scans are O(R x L).
  const rerouteIndex = buildRerouteIndex(def)
  const graphView = input.document.view.graphs[input.graphId]
  const viewNodes = graphView?.nodes ?? {}
  const collapsedNets = new Set(graphView?.collapsedNets ?? [])
  // Guide mode only applies to collapsed nets (noodles and guide curves
  // never draw together); stray entries are invariant warnings, not modes.
  const guideNets = new Set((graphView?.guideNets ?? []).filter((netId) => collapsedNets.has(netId)))
  const authoredNetViews = netViewPositions(input.document, input.graphId)

  // Connected ports by node id (links + named nets), keyed over ELAB KEYS:
  // collapsed sections keep pins for these so their noodles never dangle.
  const connectedByNode = new Map<string, Set<string>>()
  const markConnected = (ref: PortRef, direction: 'in' | 'out'): void => {
    let set = connectedByNode.get(ref.node)
    if (!set) connectedByNode.set(ref.node, (set = new Set()))
    set.add(connectedPortKey(direction, portEndKey(ref)))
  }
  const structuralLinks = effective === undefined
    ? Object.values(def.links).map((link) => ({ from: { endpoint: link.from }, to: { endpoint: link.to } }))
    : [...effective.links, ...effective.projectedParentLinks]
  for (const link of structuralLinks) {
    const fromEndpoint = 'endpoint' in link.from ? link.from.endpoint : link.from
    const toEndpoint = 'endpoint' in link.to ? link.to.endpoint : link.to
    if (isPortEndpoint(fromEndpoint)) markConnected(fromEndpoint, 'out')
    // A widget tap is a producer connection too: the tap's input must keep
    // its right-edge anchor inside a collapsed section (taps are memberless,
    // so the elab key is the bare port).
    else if (isWidgetTapRef(fromEndpoint)) {
      let set = connectedByNode.get(fromEndpoint.node)
      if (!set) connectedByNode.set(fromEndpoint.node, (set = new Set()))
      set.add(connectedPortKey('out', fromEndpoint.tap))
    }
    if (isPortEndpoint(toEndpoint)) markConnected(toEndpoint, 'in')
  }
  for (const net of Object.values(def.nets)) {
    markConnected(net.source, 'out')
    for (const sink of net.sinks) markConnected(sink, 'in')
  }
  // Boundary bindings are connections too: a bound port inside a collapsed
  // section must keep its pin so the boundary noodle never dangles. Family
  // forwarding has no single pin; its noodle anchors dynamically below.
  if (def.boundary) {
    for (const item of def.boundary.inputs) {
      for (const b of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (b.kind === 'port')
          markConnected({ node: b.node, port: b.port, ...(b.members !== undefined ? { members: b.members } : {}) }, 'in')
      }
    }
    for (const item of def.boundary.outputs) {
      if (item.binds.kind === 'port')
        markConnected({ node: item.binds.node, port: item.binds.port, ...(item.binds.members !== undefined ? { members: item.binds.members } : {}) }, 'out')
      else if (item.binds.kind === 'widgetTap') {
        let set = connectedByNode.get(item.binds.node)
        if (!set) connectedByNode.set(item.binds.node, (set = new Set()))
        set.add(connectedPortKey('out', item.binds.tap))
      }
    }
  }

  // Structural connectivity for elaboration: ghost promotion and future
  // connection-sensitive dynamic kinds see links AND nets (hazard N3).
  const solverLinkId = new Map<EffectiveLinkIdentity, import('@dinkster/core').LinkId>()
  const occurrenceNodes = input.occurrenceView === undefined ? def.nodes : Object.fromEntries(Object.entries(def.nodes).map(([id, node]) => {
    const dynamic = input.occurrenceView?.dynamic.get(id)
    const values = input.occurrenceView?.values?.get(id)
    return [id, dynamic === undefined && values === undefined ? node : {
      ...node, ...(values !== undefined ? { values } : {}), ...(dynamic !== undefined ? { dynamic } : {}),
    }]
  }))
  const effectiveGraph: GraphDef = effective === undefined ? (occurrenceNodes === def.nodes ? def : { ...def, nodes: occurrenceNodes }) : (() => {
    const occupied = new Set([
      ...Object.keys(def.nodes), ...Object.keys(def.reroutes),
      ...Object.keys(def.valueSources ?? {}), ...Object.keys(def.selectors ?? {}),
    ])
    const links = Object.fromEntries(effective.links.filter((link) =>
      !(isPortEndpoint(link.from.endpoint) && link.from.endpoint.node === DINKSTER_REGION_PSEUDO_NODE),
    ).map((link, index) => {
      let id = link.identity.kind === 'definition' ? link.identity.linkId as string : `__occurrence_scene_${index}`
      while (occupied.has(id)) id += '_'
      occupied.add(id)
      const linkId = id as import('@dinkster/core').LinkId
      solverLinkId.set(link.identity, linkId)
      return [id, { id: linkId, from: link.from.endpoint, to: link.to.endpoint }]
    })) as GraphDef['links']
    return {
      ...def,
      nodes: occurrenceNodes,
      links,
      nets: {},
    }
  })()
  const baseConnectivityOf = buildGraphConnectivity(effectiveGraph)
  const projectedInputs = new Map<string, Set<string>>()
  const projectedInputPorts = new Map<string, Set<string>>()
  const projectedOutputs = new Map<string, Set<string>>()
  for (const link of effective?.projectedParentLinks ?? []) {
    if (link.from.graphId === def.id && isPortEndpoint(link.from.endpoint)) {
      const set = projectedOutputs.get(link.from.endpoint.node) ?? new Set<string>()
      set.add(portEndKey(link.from.endpoint))
      projectedOutputs.set(link.from.endpoint.node, set)
    }
    if (link.to.graphId === def.id && isPortEndpoint(link.to.endpoint)) {
      const set = projectedInputs.get(link.to.endpoint.node) ?? new Set<string>()
      set.add(portEndKey(link.to.endpoint))
      projectedInputs.set(link.to.endpoint.node, set)
      if (link.to.endpoint.members === undefined || link.to.endpoint.members.length === 0) {
        const ports = projectedInputPorts.get(link.to.endpoint.node) ?? new Set<string>()
        ports.add(link.to.endpoint.port)
        projectedInputPorts.set(link.to.endpoint.node, ports)
      }
    }
  }
  const connectivityOf = (nodeId: import('@dinkster/core').NodeId) => {
    const base = baseConnectivityOf(nodeId)
    return {
      isInputConnected: (port: string, members?: readonly string[]) =>
        projectedInputs.get(nodeId)?.has(portEndKey({ port: asPortId(port), ...(members !== undefined ? { members: members as readonly DynamicMemberId[] } : {}) })) ||
        base.isInputConnected(port, members),
      isOutputConnected: (port: string, members?: readonly string[]) =>
        projectedOutputs.get(nodeId)?.has(portEndKey({ port: asPortId(port), ...(members !== undefined ? { members: members as readonly DynamicMemberId[] } : {}) })) ||
        base.isOutputConnected(port, members),
      inputPorts: () => [...new Set([...(base.inputPorts?.() ?? []), ...(projectedInputPorts.get(nodeId) ?? [])])],
    }
  }

  // Solving is deliberately downstream from elaboration in core. Scene
  // layout still uses the elaborated interface for its structure, then each
  // visible pin receives the solver's display type. Keeping this substitution
  // here (rather than teaching layout about graph constraints) preserves the
  // document -> elaboration -> solving -> rendering dependency direction.
  const solvedTypes = solveGraphTypes(effectiveGraph, input.resolve, {
    connectivityOf,
    ...(effective === undefined ? {} : {
      projectedInputs: projectedTypeConstraints(input.document, input.resolve, effective, def.id),
    }),
  })
  // Definition-owned identities (the shown body graph's own links and net
  // sinks) keep their ordinary scene ids so every selection/gesture seam
  // stays on the prior definition command paths; only occurrence-owned
  // identities (parent, parentNetSink, parentLeg, occurrence) are routed
  // through the occurrence planner seam.
  const definitionNetSinkSceneId = (identity: Extract<EffectiveLinkIdentity, { kind: 'definitionNetSink' }>): string | undefined => {
    const index = def.nets[identity.netId]?.sinks.findIndex((sink) => portRefKey(sink) === portRefKey(identity.to))
    return index === undefined || index < 0 ? undefined : netDeliveryLinkId(identity.netId, index)
  }
  const occurrenceOwnedIdentity = (identity: EffectiveLinkIdentity): boolean =>
    identity.kind !== 'definition' && identity.kind !== 'definitionNetSink'
  const effectiveSceneId = (identity: EffectiveLinkIdentity): string =>
    identity.kind === 'definition'
      ? identity.linkId
      : identity.kind === 'definitionNetSink'
        ? definitionNetSinkSceneId(identity) ?? `@effective:${JSON.stringify(identity)}`
        : `@effective:${JSON.stringify(identity)}`
  const solverToScene = new Map([...solverLinkId].map(([identity, id]) => [id as string, effectiveSceneId(identity)]))
  const renderSolverLabels = (text: string): string => {
    let rendered = text
    for (const [solverId, sceneId] of solverToScene)
      rendered = rendered.replaceAll(`link '${solverId}'`, `link '${sceneId}'`)
    return rendered
  }
  const solverDiagnostics = solvedTypes.diagnostics.map((diagnostic): Diagnostic => {
    const link = diagnostic.anchor?.link
    const renderedLink = link === undefined ? undefined : solverToScene.get(link)
    const edges = diagnostic.data?.['edges']
    const renderedEdges = Array.isArray(edges)
      ? edges.map((edge) => typeof edge === 'string' ? renderSolverLabels(edge) : edge)
      : undefined
    const renderedMessage = renderSolverLabels(diagnostic.message)
    if (renderedLink === undefined && renderedEdges === undefined && renderedMessage === diagnostic.message) return diagnostic
    return {
      ...diagnostic,
      message: renderedMessage,
      ...(renderedLink === undefined ? {} : { anchor: { ...diagnostic.anchor, link: renderedLink as import('@dinkster/core').LinkId } }),
      ...(renderedEdges === undefined ? {} : { data: { ...diagnostic.data, edges: renderedEdges } }),
    }
  })

  // Port-anchored solver diagnostics (e.g. a stale DynamicSlot
  // specialization) mark their pin: the warning must be visible where the
  // user will act on it, not only in the Problems panel. Keys use the
  // elaborated port key so dynamic member pins match exactly.
  const warnedPins = new Set<string>()
  for (const d of solverDiagnostics) {
    const ref = d.anchor?.port
    if (ref !== undefined) warnedPins.add(`${ref.node}\u0000${elabKeyOf(ref)}`)
  }

  const nodes: SceneNode[] = []
  const byId = new Map<string, SceneNode>()
  let fallbackY = 0
  for (const node of Object.values(def.nodes)) {
    const view = viewNodes[node.id]
    const pos = view?.position ?? { x: 40, y: (fallbackY += 120) }
    const schema = input.resolve(node.type)
    const sectionOverrides = view?.sections
      ? Object.fromEntries(Object.entries(view.sections).map(([id, s]) => [id, s.collapsed]))
      : undefined
    const occurrenceDynamic = input.occurrenceView?.dynamic.get(node.id)
    const occurrenceValues = input.occurrenceView?.values?.get(node.id)
    const occurrenceControllers = input.occurrenceView?.controllers?.get(node.id)
    const occurrenceNode = occurrenceDynamic === undefined && occurrenceValues === undefined && occurrenceControllers === undefined
      ? node
      : {
          ...node,
          ...(occurrenceValues !== undefined ? { values: occurrenceValues } : {}),
          ...(occurrenceDynamic !== undefined ? { dynamic: occurrenceDynamic } : {}),
          ...(occurrenceControllers !== undefined ? { controllers: occurrenceControllers } : {}),
        }
    const elaborated = schema
      ? elaborateInterface(schema, occurrenceNode, connectivityOf(node.id))
      : undefined
    const baseLayout = schema
      ? layoutNode(schema, occurrenceNode, input.tokens, measure, input.widgetMeasure, {
          ...(input.seedControllerEnabled !== undefined ? { seedControllerEnabled: input.seedControllerEnabled } : {}),
          ...(view?.collapsed === true ? { minimized: true as const } : {}),
          ...(view?.size ? { size: view.size } : {}),
          ...(sectionOverrides ? { sectionOverrides } : {}),
          ...(view?.views ? { widgetRepresentations: view.views } : {}),
          ...(connectedByNode.has(node.id) ? { connectedPorts: connectedByNode.get(node.id)! } : {}),
          // Subgraph instances resolve to boundary-derived schemas, so a
          // forwarded family's suffix ghost elaborates here like any node's.
          ...(elaborated !== undefined ? { elaborated } : {}),
        })
      : missingLayout(
          node,
          input.tokens,
          measure,
          missingConnections(def, node.id),
          view?.size,
          view?.collapsed === true,
        )
    const subtreeTarget = (key: string) => {
      const matches = (input.occurrenceView?.subtreeOwners?.get(node.id) ?? []).flatMap((owner) => {
        const valueKey = occurrenceSubtreeKey(owner, key)
        const address = valueKey === undefined ? undefined : addressOfElabKey(valueKey, true)
        return address === undefined ? [] : [{ owner, valueKey: valueKey!, address }]
      })
      return matches.length === 1 ? matches[0] : undefined
    }
    const mapFrames = (owner: import('@dinkster/core').SubtreeOwner, frames: readonly import('@dinkster/core').MaterializeFrame[]) => frames.flatMap((frame, index) => {
      const key = occurrenceSubtreeKey(owner, elabKeyOf({ port: frame.construct, members: frames.slice(0, index).map((ancestor) => asDynamicMemberId(ancestor.members.at(-1)!)) }))
      const address = key === undefined ? undefined : addressOfElabKey(key, true)
      return address === undefined ? [] : [{ ...frame, construct: address.port }]
    })
    const mapAncestors = (owner: import('@dinkster/core').SubtreeOwner, ancestors: readonly { readonly construct: string; readonly member: string }[]) => ancestors.flatMap((ancestor, index) => {
      const key = occurrenceSubtreeKey(owner, elabKeyOf({ port: ancestor.construct, members: ancestors.slice(0, index).map((entry) => asDynamicMemberId(entry.member)) }))
      const address = key === undefined ? undefined : addressOfElabKey(key, true)
      return address === undefined ? [] : [{ construct: address.port, member: ancestor.member }]
    })
    const familyOwnerFor = (construct: string) => input.occurrenceView?.familyOwners?.get(node.id)?.get(construct)
    const pinFamilyOwner = (pin: typeof baseLayout.pins[number]) => {
      const construct = pin.materialize?.at(-1)?.construct
      const growthOwner = construct === undefined ? undefined : familyOwnerFor(construct)
      if (growthOwner !== undefined) return growthOwner
      for (const [familyPath, owner] of input.occurrenceView?.familyOwners?.get(node.id) ?? []) {
        if (
          pin.address.port.startsWith(`${familyPath}.`) &&
          pin.address.members?.some((member) => owner.suffixMembers.has(member as string))
        ) return owner
      }
      return undefined
    }
    const rowFamilyOwner = (row: Extract<typeof baseLayout.rows[number], { kind: 'widget' }>) => {
      for (const [familyPath, owner] of input.occurrenceView?.familyOwners?.get(node.id) ?? []) {
        const member = row.address.members?.[0]
        const persisted = member === undefined ? undefined : owner.suffixMembers.get(member as string)
        if (persisted === undefined || !row.address.port.startsWith(`${familyPath}.`)) continue
        // The instance schema exposes the same member-relative suffix under
        // its boundary construct. Member ids are identity, so only the
        // crossing's rebased id is translated back to its persisted id.
        const valueKey = row.valueKey
          .replace(familyPath, owner.boundaryId)
          .replace(`#${member as string}`, `#${persisted}`)
        return { graphId: owner.graphId, nodeId: owner.nodeId, construct: owner.boundaryId, valueKey }
      }
      return undefined
    }
    const rawLayout = schema && input.occurrenceView
      ? {
          ...baseLayout,
          rows: baseLayout.rows.map((baseRow) => {
            const optionSourceOwner = baseRow.kind === 'widget' && baseRow.spec.optionSource !== undefined
              ? familyOwnerFor(baseRow.spec.optionSource.inputFamily)
              : undefined
            const row = optionSourceOwner === undefined ? baseRow : {
              ...baseRow,
              inputFamilyOwner: {
                graphId: optionSourceOwner.graphId,
                nodeId: optionSourceOwner.nodeId,
                construct: optionSourceOwner.boundaryId,
                memberIds: Object.fromEntries(optionSourceOwner.suffixMembers),
              },
            }
            const family = row.kind === 'widget' ? rowFamilyOwner(row) : row.kind === 'growth' ? familyOwnerFor(row.construct) : undefined
            const subtree = family !== undefined ? undefined : row.kind === 'widget' ? subtreeTarget(row.valueKey) : row.kind === 'growth' ? subtreeTarget(row.construct) : undefined
            if (subtree !== undefined && (row.kind === 'widget' || row.kind === 'growth')) {
              const owner = { graphId: subtree.owner.graphId, nodeId: subtree.owner.nodeId, construct: subtree.address.port, valueKey: subtree.valueKey }
              if (row.kind === 'growth') return { ...row, frames: mapFrames(subtree.owner, row.frames), familyOwner: owner }
              const ancestors = row.selector === undefined ? undefined : mapAncestors(subtree.owner, row.selector.ancestors)
              return { ...row, familyOwner: owner,
                ...(row.materialize !== undefined ? { materialize: mapFrames(subtree.owner, row.materialize) } : {}),
                ...(row.selector !== undefined ? { selector: { ...row.selector, owner: { ...owner, ancestors: ancestors ?? [] } } } : {}),
              }
            }
            if (row.kind === 'widget') {
              const owner = rowFamilyOwner(row)
              if (owner !== undefined) return { ...row, familyOwner: owner }
              const valueOwner = input.occurrenceView!.valueOwners?.get(node.id)?.get(row.valueKey)
              if (valueOwner !== undefined) {
                return {
                  ...row,
                  familyOwner: {
                    graphId: valueOwner.graphId,
                    nodeId: valueOwner.nodeId,
                    construct: row.valueKey,
                    valueKey: valueOwner.valueKey,
                  },
                }
              }
            }
            if (row.kind === 'growth') {
              const owner = familyOwnerFor(row.construct)
              return owner === undefined ? row : { ...row, familyOwner: { graphId: owner.graphId, nodeId: owner.nodeId, construct: owner.boundaryId } }
            }
            if ((row.kind === 'widget' || row.kind === 'ports') && 'materialize' in row) {
              const construct = row.materialize?.at(-1)?.construct
              const owner = construct === undefined ? undefined : familyOwnerFor(construct)
              if (owner !== undefined) return { ...row, familyOwner: { graphId: owner.graphId, nodeId: owner.nodeId, construct: owner.boundaryId } }
            }
            if (row.kind !== 'widget' || row.selector === undefined || row.selector.ancestors.length > 0) return row
            const owner = input.occurrenceView!.selectorOwners.get(node.id)?.get(row.selector.construct)
            return owner === undefined ? row : {
              ...row,
              selector: { ...row.selector, owner: { graphId: owner.graphId, nodeId: owner.nodeId, construct: owner.boundaryId } },
            }
          }),
          pins: baseLayout.pins.map((pin) => {
            const owner = pinFamilyOwner(pin)
            const subtree = owner === undefined ? subtreeTarget(elabKeyOf(pin.address)) : undefined
            if (subtree !== undefined) return {
              ...pin,
              ...(pin.dynamicSlot !== undefined ? { dynamicSlot: { ...pin.dynamicSlot, owner: {
                graphId: subtree.owner.graphId, nodeId: subtree.owner.nodeId, construct: subtree.address.port,
                ancestors: mapAncestors(subtree.owner, pin.dynamicSlot.ancestors),
              } } } : {}),
              familyOwner: {
                graphId: subtree.owner.graphId, nodeId: subtree.owner.nodeId, construct: subtree.address.port,
                occurrence: subtree.owner.occurrence, route: subtree.owner.route,
                sourceEndpoint: { kind: 'boundary' as const, occurrence: subtree.owner.occurrence, address: { ...subtree.address, port: asPortId(subtree.address.port) }, route: subtree.owner.route },
                ...(input.occurrence?.plannerAvailable === true ? { socketed: true as const } : {}),
              },
            }
            if (owner === undefined) return pin
            const memberOwners = (pin.address.members ?? [])
              .map((member) => owner.suffixOwners.get(member as string))
              .filter((memberOwner) => memberOwner !== undefined)
            const memberOwner = memberOwners.length === 1 ? memberOwners[0] : undefined
            const sourceOwner = memberOwner ?? owner
            const sourceEndpoint = occurrenceFamilyEndpoint(
              owner,
              pin.address.port,
              pin.address.members,
              pin.materialize?.at(-1)?.members.at(-1),
            )
            return {
              ...pin,
              familyOwner: {
                graphId: sourceOwner.graphId,
                nodeId: sourceOwner.nodeId,
                construct: sourceOwner.boundaryId,
                occurrence: sourceOwner.occurrence,
                familyPath: owner.familyPath,
                ...(memberOwner !== undefined ? { sourceMember: memberOwner.sourceMember } : {}),
                route: sourceOwner.route,
                ...(sourceEndpoint !== undefined ? { sourceEndpoint } : {}),
                ...(input.occurrence?.plannerAvailable === true && sourceEndpoint !== undefined ? { socketed: true as const } : {}),
              },
            }
          }),
        }
      : baseLayout
    const layoutWithPorts = schema
      ? {
          ...rawLayout,
          pins: rawLayout.pins.map((pin) => {
            const type = pin.widgetTap === true ? pin.type : solvedTypes.portTypeOf(
              asNodeId(node.id),
              pin.direction === 'in' ? 'input' : 'output',
              pin.portId,
            ) ?? pin.type
            const matchVariable = pin.type.kind === 'variable'
              ? pin.type.templateId
              : pin.type.kind === 'list' || pin.type.kind === 'asset' || pin.type.kind === 'stream'
                ? matchVariableOf(pin.type)
                : undefined
            const matchConstraint = matchConstraintOf(pin.type)
            const warn = warnedPins.has(`${node.id}\u0000${elabKeyOf(pin.address)}`)
            if (matchVariable === undefined) {
              return {
                ...pin,
                type,
                ...(warn ? { warn: true as const } : {}),
              }
            }
            return {
              ...pin,
              type,
              matchVariable,
              ...(matchConstraint !== undefined
                ? { matchConstraint }
                : {}),
              ...(!sameTypeExpr(type, pin.type) ? { inferred: true as const } : {}),
              ...(warn ? { warn: true as const } : {}),
            }
          }),
        }
      : {
          // Missing schema: no solver substitution, but anchored diagnostics
          // still mark their pin so the red ring appears where the user acts.
          ...rawLayout,
          pins: rawLayout.pins.map((pin) =>
            warnedPins.has(`${node.id}\u0000${elabKeyOf(pin.address)}`) ? { ...pin, warn: true as const } : pin,
          ),
        }
    const virtual = node.virtual === true ? input.renderVirtualNode?.(occurrenceNode) : undefined
    const layout = virtual === undefined ? layoutWithPorts : { ...layoutWithPorts, pins: [] }
    const sceneNode: SceneNode = {
      id: node.id,
      x: pos.x,
      y: pos.y,
      layout,
      node: occurrenceNode,
      ...(virtual !== undefined ? { virtual } : {}),
      ...(elaborated !== undefined ? { elaborated } : {}),
      ...(schema !== undefined && hasPreviewSurface(schema)
        ? { previewCapable: true as const }
        : {}),
      ...(view?.color !== undefined ? { color: view.color } : {}),
      isSubgraph: subgraphDefIdOf(node.type) !== undefined,
      ...(node.region !== undefined ? { regionKind: node.region.kind } : {}),
      ...(schema ? {} : { unrecognized: true, missingSchema: true }),
    }
    nodes.push(sceneNode)
    byId.set(node.id, sceneNode)
  }

  // Value sources: compact literal pills. Semantics from GraphDef, geometry
  // from view state (fallback stack for imports that lost positions), the
  // effective spec derived fresh every build - NEVER stored (hazard P1).
  // Built BEFORE reroutes: reroute chains fed by a source take its color.
  const viewValueSources = graphView?.valueSources ?? {}
  const valueSources: SceneValueSource[] = []
  const valueSourceById = new Map<string, SceneValueSource>()
  let vsFallbackY = 0
  for (const vs of Object.values(def.valueSources ?? {})) {
    const pos = viewValueSources[vs.id]?.position ?? { x: 0, y: (vsFallbackY += 60) }
    const effective = effectiveValueSourceSpec(def, vs, input.resolve, rerouteIndex)
    const title = vs.title ?? effective.spec?.widgetType ?? 'value'
    const valueText = valueSourceValueText(vs.value)
    const width = Math.min(
      input.tokens.nodeMaxAutoWidth,
      Math.max(
        VS_MIN_WIDTH,
        input.tokens.padX +
          measure(title, 'label') +
          8 +
          measure(valueText, 'value') +
          8 +
          VS_BADGE_SIZE +
          VS_BADGE_INSET,
      ),
    )
    const typeName = canonicalCompatTypeIdOf(effective.type)
    const sceneSource: SceneValueSource = {
      id: vs.id,
      x: pos.x,
      y: pos.y,
      width,
      height: input.tokens.rowHeight + VS_HEIGHT_PAD,
      source: vs,
      title,
      valueText,
      effective,
      ...(typeName !== undefined ? { typeName } : {}),
      specState: vs.spec ? 'declared' : effective.spec ? 'derived' : 'raw',
      conflict: effective.diagnostics.length > 0,
    }
    valueSources.push(sceneSource)
    valueSourceById.set(vs.id, sceneSource)
  }

  // Reroute junctions: geometry from view state (fallback stack for imports
  // that lost positions), effective type traced through the chain to the
  // driving output so every segment of a chain shares one color.
  const viewReroutes = graphView?.reroutes ?? {}
  const reroutes: SceneReroute[] = []
  const rerouteById = new Map<string, SceneReroute>()
  let rerouteFallbackY = 0
  const outputTypeName = (ref: PortRef): string | undefined => {
    const producer = byId.get(ref.node)
    const key = portEndKey(ref)
    // Real output only: a widget tap shares its input's port id on the 'out'
    // side, so an unguarded lookup would color off the widget row.
    const pin = producer?.layout.pins.find((p) => p.direction === 'out' && p.portId === key && p.widgetTap !== true)
    return pin === undefined ? undefined : canonicalCompatTypeIdOf(pin.type)
  }
  const widgetTapTypeName = (nodeId: string, inputId: string): string | undefined => {
    const node = byId.get(nodeId)
    const pin = node?.layout.pins.find((p) => p.widgetTap === true && p.address.port === inputId)
    return pin === undefined ? undefined : canonicalCompatTypeIdOf(pin.type)
  }
  const tracedTypeName = (from: LinkEndpoint): string | undefined => {
    if (isWidgetTapRef(from)) {
      return widgetTapTypeName(from.node, from.tap)
    }
    const trace = traceEndpoint(def, from, rerouteIndex)
    if (trace.kind === 'valueSource') return valueSourceById.get(trace.id)?.typeName
    if (trace.kind === 'tapValue') return widgetTapTypeName(trace.node, trace.input)
    if (trace.kind === 'selector') {
      // A selector output has no single producer without a resolution; color
      // only when EVERY driven branch agrees on one concrete type (matches
      // the solver's all-candidate view, so the color never lies).
      let name: string | undefined
      for (const t of traceEndpointAll(def, from, rerouteIndex)) {
        if (t.kind === 'valueSource') {
          const n = valueSourceById.get(t.id)?.typeName
          if (n === undefined || (name !== undefined && name !== n)) return undefined
          name = n
        } else if (t.kind === 'tapValue') {
          const n = widgetTapTypeName(t.node, t.input)
          if (n === undefined || (name !== undefined && name !== n)) return undefined
          name = n
        } else if (t.kind === 'output') {
          const n = outputTypeName(t.ref)
          if (n === undefined || (name !== undefined && name !== n)) return undefined
          name = n
        }
      }
      return name
    }
    if (trace.kind !== 'output') return undefined
    return outputTypeName(trace.ref)
  }
  /**
   * True when the REAL producer behind `from` declares an optional output
   * (may deliberately emit no value at runtime) - a static schema fact, so
   * it needs no solver. A selector counts when ANY driven branch is
   * maybe-absent (policy can switch to that branch at any moment).
   */
  const tracedMaybeAbsent = (from: LinkEndpoint): boolean => {
    for (const t of traceEndpointAll(def, from, rerouteIndex)) {
      if (t.kind !== 'output') continue
      const producer = byId.get(t.ref.node)
      const key = portEndKey(t.ref)
      if (producer?.layout.pins.some((p) => p.direction === 'out' && p.portId === key && p.maybeAbsent === true)) return true
    }
    return false
  }
  for (const reroute of Object.values(def.reroutes)) {
    const pos = viewReroutes[reroute.id]?.position ?? { x: 0, y: (rerouteFallbackY += 60) }
    const typeName = tracedTypeName({ reroute: reroute.id })
    const sceneReroute: SceneReroute = {
      id: reroute.id,
      x: pos.x,
      y: pos.y,
      ...(typeName !== undefined ? { typeName } : {}),
    }
    reroutes.push(sceneReroute)
    rerouteById.set(reroute.id, sceneReroute)
  }

  // Selectors: compact node-like boxes (header + one row per candidate).
  // Semantics from GraphDef.selectors, geometry from view state, branch and
  // output types traced fresh every build - never stored.
  const viewSelectors = graphView?.selectors ?? {}
  const selectors: SceneSelector[] = []
  const selectorById = new Map<string, SceneSelector>()
  let selectorFallbackY = 0
  for (const sel of Object.values(def.selectors ?? {})) {
    const pos = viewSelectors[sel.id]?.position ?? { x: 0, y: (selectorFallbackY += 100) }
    const title = sel.title ?? 'Select'
    const headerHeight = input.tokens.headerHeight
    const rowHeight = input.tokens.rowHeight
    const candidates: SceneSelectorCandidate[] = sel.candidates.map((c, i) => {
      const typeName = tracedTypeName({ selector: sel.id, candidate: c.id })
      return {
        id: c.id,
        label: c.title ?? `${i + 1}`,
        y: headerHeight + rowHeight * i + rowHeight / 2,
        ...(typeName !== undefined ? { typeName } : {}),
      }
    })
    const width = Math.min(
      input.tokens.nodeMaxAutoWidth,
      Math.max(
        SELECTOR_MIN_WIDTH,
        input.tokens.padX * 2 + measure(title, 'title') + 8 + SELECTOR_BADGE_SIZE + SELECTOR_BADGE_INSET,
        ...candidates.map((c) => input.tokens.padX * 2 + measure(c.label, 'label') + 8),
      ),
    )
    const typeName = tracedTypeName({ selector: sel.id })
    const sceneSelector: SceneSelector = {
      id: sel.id,
      x: pos.x,
      y: pos.y,
      width,
      height: headerHeight + rowHeight * candidates.length + input.tokens.padBottom,
      headerHeight,
      data: sel,
      title,
      candidates,
      ...(sel.policy.kind === 'fixed' ? { activeCandidate: sel.policy.candidate as string } : {}),
      random: sel.policy.kind === 'random',
      ...(typeName !== undefined ? { typeName } : {}),
    }
    selectors.push(sceneSelector)
    selectorById.set(sel.id, sceneSelector)
  }

  // A link end's anchor point: pin center for ports, dot center for reroutes.
  const endPoint = (end: LinkEndpoint, direction: 'in' | 'out'): { x: number; y: number; end: SceneLinkEnd; type?: TypeExpr } | undefined => {
    if (isRerouteRef(end)) {
      const r = rerouteById.get(end.reroute)
      return r ? { x: r.x, y: r.y, end: { kind: 'reroute', reroute: r.id }, ...(r.typeName ? { type: typeExprFromTypeId(r.typeName) } : {}) } : undefined
    }
    if (isValueSourceRef(end)) {
      const vs = valueSourceById.get(end.valueSource)
      if (!vs) return undefined
      const pin = valueSourcePinPosition(vs)
      return { x: pin.x, y: pin.y, end: { kind: 'valueSource', valueSource: vs.id }, type: vs.effective.type }
    }
    if (isSelectorRef(end)) {
      const sel = selectorById.get(end.selector)
      if (!sel) return undefined
      const pin =
        end.candidate !== undefined
          ? selectorCandidatePinPosition(sel, end.candidate)
          : selectorOutPinPosition(sel)
      if (!pin) return undefined
      return {
        x: pin.x,
        y: pin.y,
        end: { kind: 'selector', selector: sel.id, ...(end.candidate !== undefined ? { candidate: end.candidate } : {}) },
        ...(sel.typeName ? { type: typeExprFromTypeId(sel.typeName) } : {}),
      }
    }
    if (isWidgetTapRef(end)) {
      const node = byId.get(end.node)
      const pin = node?.layout.pins.find((p) => p.widgetTap === true && p.address.port === end.tap)
      return node && pin ? {
        x: node.x + node.layout.width,
        y: node.y + pin.y,
        end: { kind: 'widgetTap', node: end.node, input: end.tap },
        type: pin.type,
      } : undefined
    }
    const node = byId.get(end.node)
    const key = portEndKey(end)
    // Real port only: a widget tap shares its input's port id on the 'out'
    // side, so an unguarded lookup would anchor the noodle on the widget row
    // when a real output uses the same id (LoadImage 'image').
    const pin = node?.layout.pins.find((p) => p.direction === direction && p.portId === key && p.widgetTap !== true)
    if (!node || !pin) return undefined
    return {
      x: direction === 'out' ? node.x + node.layout.width : node.x,
      y: node.y + pin.y,
      end: {
        kind: 'port',
        node: end.node,
        port: end.port,
        ...(end.members !== undefined ? { members: end.members } : {}),
      },
      type: pin.type,
    }
  }

  const links: SceneLink[] = []
  const connections: {
    id: string
    from: LinkEndpoint
    to: LinkEndpoint
    netId?: string
    netName?: string
    mismatch?: boolean
    diagnostics?: readonly Diagnostic[]
    effectiveIdentity?: EffectiveLinkIdentity
    hidden?: true
  }[] = [
    ...(effective?.links ?? Object.values(def.links).map((link) => ({
      identity: { kind: 'definition' as const, graphId: def.id, linkId: link.id },
      from: { endpoint: link.from },
      to: { endpoint: link.to },
    }))).map((link) => {
      const identity = link.identity
      const id = effectiveSceneId(identity)
      const solverId = solverLinkId.get(identity) ?? (identity.kind === 'definition' ? identity.linkId : undefined)
      return {
      id,
      from: link.from.endpoint,
      to: link.to.endpoint,
      mismatch: solverId !== undefined && solvedTypes.linkVerdicts.get(solverId) === 'mismatch',
      diagnostics: solverDiagnostics.filter((diagnostic) =>
        diagnostic.anchor?.link === id ||
        diagnostic.code === 'solve.varConflict' &&
          Array.isArray(diagnostic.data?.['edges']) &&
          diagnostic.data['edges'].includes(`link '${id}'`),
      ),
      ...(occurrenceOwnedIdentity(identity) ? { effectiveIdentity: identity } : {}),
      ...(identity.kind === 'definitionNetSink'
        ? {
            netId: identity.netId,
            ...(def.nets[identity.netId]?.name !== undefined ? { netName: def.nets[identity.netId]!.name } : {}),
            ...(collapsedNets.has(identity.netId) ? { hidden: true as const } : {}),
          }
        : {}),
    }}),
    // Named nets are always scene links; a collapsed net's links carry
    // `hidden` (endpoint tags render instead of noodles) so connectivity
    // consumers treat the sink exactly like a link-driven input.
    ...(effective === undefined ? Object.values(def.nets) : [])
      .flatMap((net) =>
        net.sinks.map((sink, i) => ({
          id: netDeliveryLinkId(net.id, i),
          from: net.source,
          to: sink,
          netId: net.id,
          netName: net.name,
          ...(collapsedNets.has(net.id) ? { hidden: true as const } : {}),
          mismatch: solvedTypes.netSinkVerdicts.get(netSinkKey(net.id, i)) === 'mismatch',
          diagnostics: solvedTypes.diagnostics.filter((diagnostic) =>
            diagnostic.anchor?.net === net.id ||
            diagnostic.anchor?.port !== undefined && samePortRef(diagnostic.anchor.port, sink) ||
            diagnostic.code === 'solve.varConflict' &&
              Array.isArray(diagnostic.data?.['edges']) &&
              diagnostic.data['edges'].includes(`net '${net.id}' sink ${i}`),
          ),
        })),
      ),
  ]
  for (const c of connections) {
    const from = endPoint(c.from, 'out')
    const to = endPoint(c.to, 'in')
    if (!from || !to) continue
    if (to.end.kind === 'valueSource') continue // illegal consumer (I10); validation owns the report
    const typeName = tracedTypeName(c.from)
    links.push({
      id: c.id,
      from: from.end,
      to: to.end,
      x1: from.x,
      y1: from.y,
      x2: to.x,
      y2: to.y,
      ...(from.type !== undefined ? { fromType: from.type } : typeName !== undefined ? { fromType: typeExprFromTypeId(typeName) } : {}),
      ...(to.type !== undefined ? { toType: to.type } : typeName !== undefined ? { toType: typeExprFromTypeId(typeName) } : {}),
      ...(typeName !== undefined ? { typeName } : {}),
      ...(tracedMaybeAbsent(c.from) ? { maybeAbsent: true as const } : {}),
      ...(c.mismatch === true ? { mismatch: true as const } : {}),
      ...(c.diagnostics !== undefined && c.diagnostics.length > 0 ? { diagnostics: c.diagnostics } : {}),
      ...(c.netId !== undefined ? { netId: c.netId } : {}),
      ...(c.netName !== undefined ? { netName: c.netName } : {}),
      ...(c.hidden === true ? { hidden: true as const } : {}),
      ...(c.effectiveIdentity !== undefined ? { effectiveIdentity: c.effectiveIdentity } : {}),
    })
  }

  // Named nets expose one authorable Set view at the source and one Get view
  // per sink. collapsedNets controls noodles only; the endpoint views remain.
  const netStubs: SceneNetStub[] = []
  const mismatchedNetSinkIds = new Set(
    links.filter((link) => link.netId !== undefined && link.mismatch === true).map((link) => link.id),
  )
  for (const net of Object.values(def.nets)) {
    const sinkMismatches = net.sinks.map((_, i) =>
      mismatchedNetSinkIds.has(netDeliveryLinkId(net.id, i)),
    )
    const push = (role: 'source' | 'sink', ref: PortRef, mismatch: boolean): void => {
      const node = byId.get(ref.node)
      if (!node) return
      const direction = role === 'source' ? 'out' : 'in'
      const key = portEndKey(ref)
      // Real port only (nets never source from widget taps; see pin lookup
      // guards elsewhere for the same-id tap/output collision).
      const pin = node.layout.pins.find((p) => p.direction === direction && p.portId === key && p.widgetTap !== true)
      if (!pin) return
      const pinX = role === 'source' ? node.x + node.layout.width : node.x
      const pinY = node.y + pin.y
      const label = `${role === 'source' ? 'Set' : 'Get'} ${net.name}`
      const width = measure(label, 'label') + NET_STUB_PAD_X * 2
      const authored = authoredNetViews.find((view) =>
        view.netId === net.id && view.role === role &&
        (role === 'source' || (view.role === 'sink' && samePortRef(view.to, ref))),
      )
      const fallbackX = role === 'source' ? pinX + NET_STUB_GAP : pinX - NET_STUB_GAP - width
      const fallbackY = pinY - NET_STUB_HEIGHT / 2
      // Offset geometry anchors to the node's top-left, so the tag keeps its
      // user-chosen offset across node moves; absolute geometry renders as-is.
      const geometry = authored?.geometry
      netStubs.push({
        id: netStubId(net.id, role, ref),
        netId: net.id,
        name: net.name,
        role,
        ...(mismatch ? { mismatch: true as const } : {}),
        nodeId: ref.node,
        portId: ref.port,
        ...(ref.members !== undefined ? { members: ref.members } : {}),
        pinX,
        pinY,
        x: geometry === undefined ? fallbackX : geometry.kind === 'offset' ? node.x + geometry.x : geometry.x,
        y: geometry === undefined ? fallbackY : geometry.kind === 'offset' ? node.y + geometry.y : geometry.y,
        width,
        height: NET_STUB_HEIGHT,
        ...(authored === undefined ? {} : { authored: true as const }),
        ...(geometry?.kind === 'absolute' ? { authoredAbsolute: true as const } : {}),
        ...(guideNets.has(net.id) ? { guide: true as const } : {}),
        ...(canonicalCompatTypeIdOf(pin.type) !== undefined ? { typeName: canonicalCompatTypeIdOf(pin.type)! } : {}),
      })
    }
    push('source', net.source, sinkMismatches.some(Boolean))
    for (const [i, sink] of net.sinks.entries()) push('sink', sink, sinkMismatches[i]!)
  }

  // Groups: view rectangles passed through in map insertion order (stable
  // draw order for a given document history; groups rarely overlap and only
  // background fills stack, so key order is not sorted).
  const groups: SceneGroup[] = Object.values(graphView?.groups ?? {}).map((g) => ({
    id: g.id,
    title: g.title,
    x: g.bounds.x,
    y: g.bounds.y,
    width: g.bounds.width,
    height: g.bounds.height,
    ...(g.color !== undefined ? { color: g.color } : {}),
  }))

  // Boundary pseudo-nodes: node-like Inputs/Outputs panels, derived from
  // def.boundary every build. Types mirror the derived instance schema (the
  // same resolver instances use), so inside and outside always agree. Their
  // noodles render the BINDINGS - there are no boundary links in the
  // document, so these are synthetic and excluded from link hit-testing.
  const boundaryNodes: SceneBoundaryNode[] = []
  if (def.boundary) {
    const derived = input.resolve(`#${def.id}`)
    const derivedInputs = derived ? inputsOf(derived) : []
    const derivedOutputs = derived ? outputsOf(derived) : []

    const boundaryLabel = (
      item: BoundaryItem,
      derivedLabel: string | undefined,
      defaults: ReadonlyMap<string, string>,
    ): string => {
      if (item.displayName !== undefined) return item.displayName
      if (derivedLabel !== undefined) return derivedLabel
      return defaults.get(item.id) ?? 'Boundary'
    }

    const slotsOf = (items: readonly BoundaryItem[], side: 'inputs' | 'outputs'): BoundarySlotInfo[] => {
      const defaults = defaultBoundaryLabels(items)
      return items.map((item) => {
        const spec =
          side === 'inputs'
            ? derivedInputs.find((s) => s.id === item.id)
            : derivedOutputs.find((s) => s.id === item.id)
        return {
          id: item.id,
          label: boundaryLabel(item, spec?.displayName, defaults),
          ...(spec !== undefined ? { type: spec.type } : {}),
          ...(item.binds.kind === 'family' ? { family: true as const } : {}),
        }
      })
    }

    let ownerNode: NodeData | undefined
    if (input.occurrence !== undefined) {
      let ownerGraph = input.document.graphs[input.document.root]
      for (const hop of input.occurrence.owner.instancePath) {
        const hopNode = ownerGraph?.nodes[hop]
        ownerGraph = hopNode?.type.startsWith('#') ? input.document.graphs[hopNode.type.slice(1)] : undefined
      }
      ownerNode = ownerGraph?.nodes[input.occurrence.owner.node]
    }
    const regionIndexSlots: BoundarySlotInfo[] = ownerNode?.region === undefined ? [] : [{
      id: REGION_INDEX_SLOT,
      label: 'Index',
      type: { kind: 'concrete', name: 'core.int' },
      regionIndex: true,
    }]
    const inputsLayout = layoutBoundaryNode('inputs', [...slotsOf(def.boundary.inputs, 'inputs'), ...regionIndexSlots], input.tokens, measure)
    const outputsLayout = layoutBoundaryNode('outputs', slotsOf(def.boundary.outputs, 'outputs'), input.tokens, measure)

    // Default positions hug the content bounds; a persisted position wins.
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x)
      maxX = Math.max(maxX, n.x + n.layout.width)
      minY = Math.min(minY, n.y)
    }
    for (const vs of valueSources) {
      minX = Math.min(minX, vs.x)
      maxX = Math.max(maxX, vs.x + vs.width)
      minY = Math.min(minY, vs.y)
    }
    for (const r of reroutes) {
      minX = Math.min(minX, r.x)
      maxX = Math.max(maxX, r.x)
      minY = Math.min(minY, r.y)
    }
    for (const s of selectors) {
      minX = Math.min(minX, s.x)
      maxX = Math.max(maxX, s.x + s.width)
      minY = Math.min(minY, s.y)
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      maxX = 320
      minY = 0
    }
    const BOUNDARY_GAP = 120
    const viewBoundary = graphView?.boundary
    const inputsPos = viewBoundary?.inputs?.position ?? { x: minX - BOUNDARY_GAP - inputsLayout.width, y: minY }
    const outputsPos = viewBoundary?.outputs?.position ?? { x: maxX + BOUNDARY_GAP, y: minY }
    const inputsNode: SceneBoundaryNode = { side: 'inputs', x: inputsPos.x, y: inputsPos.y, layout: inputsLayout }
    const outputsNode: SceneBoundaryNode = { side: 'outputs', x: outputsPos.x, y: outputsPos.y, layout: outputsLayout }
    boundaryNodes.push(inputsNode, outputsNode)

    const regionIndexPin = inputsLayout.pins.find((pin) => pin.regionIndex === true)
    if (regionIndexPin !== undefined) {
      for (const c of connections) {
        if (!isPortEndpoint(c.from) || c.from.node !== DINKSTER_REGION_PSEUDO_NODE || c.from.port !== 'index' || c.from.members !== undefined) continue
        const to = endPoint(c.to, 'in')
        if (!to || to.end.kind === 'valueSource') continue
        links.push({
          id: c.id,
          from: { kind: 'boundary', side: 'inputs', item: REGION_INDEX_SLOT },
          to: to.end,
          x1: inputsNode.x + inputsLayout.width,
          y1: inputsNode.y + regionIndexPin.y,
          x2: to.x,
          y2: to.y,
          fromType: regionIndexPin.type,
          ...(to.type !== undefined ? { toType: to.type } : {}),
          typeName: 'core.int',
          ...(c.effectiveIdentity !== undefined ? { effectiveIdentity: c.effectiveIdentity } : {}),
        })
      }
    }

    // Binding noodles. 'port' and 'widgetTap' bind at the exact inner pin;
    // 'family' binds anchor at the family's first pin (template-slot paths reserve
    // dots, so prefix-matching binds.port here is grammar-safe - boundary
    // item ids are never split). Fallback: the node's header edge.
    const membersPrefixOk = (
      pinMembers: readonly DynamicMemberId[] | undefined,
      bindMembers: readonly DynamicMemberId[] | undefined,
    ): boolean => {
      const prefix = bindMembers ?? []
      const full = pinMembers ?? []
      return prefix.length <= full.length && prefix.every((m, i) => full[i] === m)
    }
    const innerAnchor = (
      binds: BoundaryItem['binds'],
      direction: 'in' | 'out',
    ): { x: number; y: number; end: Extract<SceneLinkEnd, { kind: 'port' | 'widgetTap' }> } | undefined => {
      const node = byId.get(binds.node)
      if (!node) return undefined
      const edgeX = direction === 'out' ? node.x + node.layout.width : node.x
      if (binds.kind === 'widgetTap') {
        if (direction !== 'out') return undefined
        const pin = node.layout.pins.find((candidate) => candidate.widgetTap === true && candidate.address.port === binds.tap)
        return pin === undefined
          ? undefined
          : { x: edgeX, y: node.y + pin.y, end: { kind: 'widgetTap', node: binds.node, input: binds.tap } }
      }
      const end: Extract<SceneLinkEnd, { kind: 'port' }> = {
        kind: 'port',
        node: binds.node,
        port: binds.port,
        ...(binds.members !== undefined ? { members: binds.members } : {}),
      }
      if (binds.kind === 'port') {
        const key = portEndKey({ port: binds.port, ...(binds.members !== undefined ? { members: binds.members } : {}) })
        // Real port only: excludes the same-id widget tap pin (see the
        // endpoint resolver above).
        const pin = node.layout.pins.find((p) => p.direction === direction && p.portId === key && p.widgetTap !== true)
        if (!pin) return undefined
        return { x: edgeX, y: node.y + pin.y, end }
      }
      const familyPin = node.layout.pins.find(
        (p) =>
          p.direction === direction &&
          p.widgetTap !== true &&
          (p.address.port === binds.port || p.address.port.startsWith(`${binds.port}.`)) &&
          membersPrefixOk(p.address.members, binds.members),
      )
      const y = familyPin ? node.y + familyPin.y : node.y + node.layout.headerHeight / 2
      return { x: edgeX, y, end }
    }

    const boundaryPin = (bnode: SceneBoundaryNode, itemId: string): { x: number; y: number } | undefined => {
      const pin = bnode.layout.pins.find((p) => p.portId === itemId)
      if (!pin) return undefined
      return { x: bnode.side === 'inputs' ? bnode.x + bnode.layout.width : bnode.x, y: bnode.y + pin.y }
    }

    const projectedAnchors = (
      direction: 'in' | 'out', item: BoundaryItem, binding: BoundaryItem['binds'],
    ): readonly {
      readonly anchor: NonNullable<ReturnType<typeof endPoint>> & { readonly end: Extract<SceneLinkEnd, { kind: 'port' | 'widgetTap' }> }
      readonly identities: readonly EffectiveLinkIdentity[]
    }[] => {
      const grouped = new Map<string, { endpoint: LinkEndpoint; identities: EffectiveLinkIdentity[] }>()
      for (const projected of effective?.projectedParentLinks ?? []) {
        if (projected.identity.kind !== 'parentLeg') continue
        const leg = projected.identity.route.at(-1)
        const resolved = direction === 'in' ? projected.to : projected.from
        if (
          leg?.boundaryId !== item.id || boundaryBindingKey(leg.binding) !== boundaryBindingKey(binding) ||
          resolved.graphId !== def.id ||
          (direction === 'in' && !isPortEndpoint(resolved.endpoint)) ||
          (direction === 'out' && !isPortEndpoint(resolved.endpoint) && !isWidgetTapRef(resolved.endpoint))
        ) continue
        const key = JSON.stringify(resolved.endpoint)
        const group = grouped.get(key) ?? { endpoint: resolved.endpoint, identities: [] }
        group.identities.push(projected.identity)
        grouped.set(key, group)
      }
      return [...grouped.values()].flatMap((group) => {
        const anchor = endPoint(group.endpoint, direction)
        return anchor?.end.kind === 'port' || anchor?.end.kind === 'widgetTap'
          ? [{ anchor: { ...anchor, end: anchor.end }, identities: group.identities }]
          : []
      })
    }

    for (const item of def.boundary.inputs) {
      const from = boundaryPin(inputsNode, item.id)
      if (!from) continue
      const pinType = inputsNode.layout.pins.find((p) => p.portId === item.id)?.type
      const typeName = pinType === undefined ? undefined : canonicalCompatTypeIdOf(pinType)
      // One noodle per binding: fan-out targets render exactly like the
      // primary (the boundary pin fans out to every bound inner input).
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      bindings.forEach((b, i) => {
        const projected = projectedAnchors('in', item, b)
        const fallback = innerAnchor(b, 'in')
        const targets = projected.length > 0 ? projected : fallback === undefined ? [] : [{ anchor: fallback, identities: [] }]
        targets.forEach(({ anchor: to, identities }, aliasIndex) => {
          links.push({
            id: `${i === 0 ? `boundary:inputs:${item.id}` : `boundary:inputs:${item.id}:${i}`}${aliasIndex === 0 ? '' : `:alias:${aliasIndex}`}`,
            from: { kind: 'boundary', side: 'inputs', item: item.id },
            to: to.end,
            x1: from.x,
            y1: from.y,
            x2: to.x,
            y2: to.y,
            ...(typeName !== undefined ? { typeName } : {}),
            boundary: true,
            ...(b.kind === 'family' ? { boundaryFamily: true as const } : {}),
            ...(identities.length === 1 ? { effectiveIdentity: identities[0] } : {}),
            ...(identities.length > 0 ? { effectiveIdentities: identities } : {}),
          })
        })
      })
    }
    for (const item of def.boundary.outputs) {
      const to = boundaryPin(outputsNode, item.id)
      if (!to) continue
      const pinType = outputsNode.layout.pins.find((p) => p.portId === item.id)?.type
      const traced =
        item.binds.kind === 'port'
          ? tracedTypeName({
              node: item.binds.node,
              port: item.binds.port,
              ...(item.binds.members !== undefined ? { members: item.binds.members } : {}),
            })
          : item.binds.kind === 'widgetTap'
            ? widgetTapTypeName(item.binds.node, item.binds.tap)
          : undefined
      const typeName = traced ?? (pinType === undefined ? undefined : canonicalCompatTypeIdOf(pinType))
      const projected = projectedAnchors('out', item, item.binds)
      const fallback = innerAnchor(item.binds, 'out')
      const sources = projected.length > 0 ? projected : fallback === undefined ? [] : [{ anchor: fallback, identities: [] }]
      sources.forEach(({ anchor: from, identities }, aliasIndex) => {
        links.push({
          id: `boundary:outputs:${item.id}${aliasIndex === 0 ? '' : `:${aliasIndex}`}`,
          from: from.end,
          to: { kind: 'boundary', side: 'outputs', item: item.id },
          x1: from.x,
          y1: from.y,
          x2: to.x,
          y2: to.y,
          ...(typeName !== undefined ? { typeName } : {}),
          boundary: true,
          ...(item.binds.kind === 'family' ? { boundaryFamily: true as const } : {}),
          ...(identities.length === 1 ? { effectiveIdentity: identities[0] } : {}),
          ...(identities.length > 0 ? { effectiveIdentities: identities } : {}),
        })
      })
    }
  }

  const result: Scene = {
    graphId: input.graphId, nodes, links, reroutes, valueSources, selectors, netStubs, groups, boundaryNodes,
    diagnostics: [...solverDiagnostics, ...(effective?.diagnostics ?? [])],
    ...(input.occurrence !== undefined ? { occurrence: { owner: input.occurrence.owner, bodyGraph: def.id } } : {}),
  }
  if (input.layoutGeneration !== undefined && input.occurrence === undefined && input.occurrenceView === undefined && view !== undefined) {
    positionedSceneCache.set(def, {
      graph: def,
      graphSnapshot: snapshotGraph(def),
      graphs: input.document.graphs,
      documentExt: input.document.ext,
      view: {
        ...view,
        nodes: Object.fromEntries(Object.entries(view.nodes).map(([id, node]) => [id, { ...node }])),
      },
      seedControllerEnabled: input.seedControllerEnabled,
      tokens: input.tokens,
      measure: input.measure,
      widgetMeasure: input.widgetMeasure,
      generation: input.layoutGeneration,
      scene: result,
    })
  }
  return result
}

/**
 * Connections the DOCUMENT proves a node has, used when its schema cannot be
 * resolved: every link/net/boundary endpoint touching the node yields a port
 * (or widget tap) so the unresolved node keeps its pins and every visible
 * noodle stays attached. Keyed/deduped by elab key, document order.
 */
function missingConnections(
  def: GraphDef,
  nodeId: string,
): { inputs: PortRef[]; outputs: PortRef[]; taps: string[] } {
  const ins = new Map<string, PortRef>()
  const outs = new Map<string, PortRef>()
  const taps = new Set<string>()
  const mark = (map: Map<string, PortRef>, ref: PortRef): void => {
    if (ref.node === nodeId && !map.has(portEndKey(ref))) map.set(portEndKey(ref), ref)
  }
  for (const link of Object.values(def.links)) {
    if (isPortEndpoint(link.from)) mark(outs, link.from)
    else if (isWidgetTapRef(link.from) && link.from.node === nodeId) taps.add(link.from.tap)
    if (isPortEndpoint(link.to)) mark(ins, link.to)
  }
  for (const net of Object.values(def.nets)) {
    mark(outs, net.source)
    for (const sink of net.sinks) mark(ins, sink)
  }
  if (def.boundary) {
    for (const item of def.boundary.inputs) {
      for (const b of [item.binds, ...(item.alsoBinds ?? [])]) {
        if (b.kind === 'port') mark(ins, { node: b.node, port: b.port, ...(b.members !== undefined ? { members: b.members } : {}) })
      }
    }
    for (const item of def.boundary.outputs) {
      const b = item.binds
      if (b.kind === 'port') mark(outs, { node: b.node, port: b.port, ...(b.members !== undefined ? { members: b.members } : {}) })
      else if (b.kind === 'widgetTap' && b.node === nodeId) taps.add(b.tap)
    }
  }
  return { inputs: [...ins.values()], outputs: [...outs.values()], taps: [...taps] }
}

/** Safe single-line preview of a stored JSON value for fallback rows. */
function fallbackValueText(value: Json | undefined): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  return s.length > 42 ? `${s.slice(0, 41)}...` : s
}

/**
 * Best-effort layout for unknown node types: the schema is gone, but the
 * DOCUMENT still knows the node's title, size, stored values, and every
 * connected port - so render all of that instead of an empty shell. Rows:
 * inferred ports (labels = stored port ids) then read-only fallback value
 * rows. The error itself is the renderer's red outline, not lost content.
 */
function missingLayout(
  node: NodeData,
  tokens: DesignTokens,
  measure: TextMeasurer,
  connections: { inputs: readonly PortRef[]; outputs: readonly PortRef[]; taps: readonly string[] },
  sizeOverride?: SizeOverride,
  minimized = false,
): NodeLayout {
  const titleRenamed = node.title !== undefined && node.title !== node.type
  const title = node.title ?? node.type
  const unknownType = { kind: 'wildcard' } as const
  const labelOf = (ref: PortRef): string =>
    ref.members !== undefined ? `${ref.port}.${ref.members.join('.')}` : ref.port
  const rows: LayoutRow[] = []
  const pins: PinLayout[] = []
  let y = tokens.headerHeight
  let contentWidth = measure(title, titleRenamed ? 'renamedTitle' : 'title') + tokens.padX * 2 + 8

  const pairs = Math.max(connections.inputs.length, connections.outputs.length)
  for (let i = 0; i < pairs; i++) {
    const inRef = connections.inputs[i]
    const outRef = connections.outputs[i]
    const height = tokens.rowHeight
    const input = inRef === undefined ? undefined : {
      portId: portEndKey(inRef),
      label: labelOf(inRef),
      type: unknownType,
      address: { port: inRef.port, ...(inRef.members !== undefined ? { members: inRef.members } : {}) },
    }
    const output = outRef === undefined ? undefined : {
      portId: portEndKey(outRef),
      label: labelOf(outRef),
      type: unknownType,
      address: { port: outRef.port, ...(outRef.members !== undefined ? { members: outRef.members } : {}) },
      index: i,
    }
    rows.push({ kind: 'ports', y, height, ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) })
    if (input !== undefined) pins.push({ portId: input.portId, label: input.label, direction: 'in', y: y + height / 2, type: unknownType, address: input.address })
    if (output !== undefined) pins.push({ portId: output.portId, label: output.label, direction: 'out', y: y + height / 2, type: unknownType, address: output.address })
    contentWidth = Math.max(
      contentWidth,
      tokens.padX * 2 +
        (input !== undefined ? measure(input.label, 'label') + tokens.pinRadius + 4 : 0) +
        (output !== undefined ? measure(output.label, 'label') + tokens.pinRadius + 4 : 0) +
        16,
    )
    y += height
  }
  // Widget taps stay producers: their own row anchors the right-edge tap pin
  // so tap links never dangle. The stored value (if any) shows on the row.
  for (const tap of connections.taps) {
    const height = tokens.rowHeight
    const address = { port: asPortId(tap) }
    rows.push({
      kind: 'ports', y, height,
      output: { portId: tap, label: tap, type: unknownType, address, index: pairs + rows.length },
    })
    pins.push({ portId: tap, label: tap, direction: 'out', y: y + height / 2, type: unknownType, address, widgetTap: true })
    contentWidth = Math.max(contentWidth, tokens.padX * 2 + measure(tap, 'label') + tokens.pinRadius + 20)
    y += height
  }
  for (const [key, value] of Object.entries(node.values ?? {})) {
    const text = fallbackValueText(value)
    rows.push({ kind: 'fallback', y, height: tokens.rowHeight, label: key, text })
    contentWidth = Math.max(
      contentWidth,
      tokens.padX * 2 + measure(key, 'label') + 12 + measure(text, 'value'),
    )
    y += tokens.rowHeight
  }

  // Rows never compress: manual sizes clamp to the natural row stack.
  const minHeight = Math.max(tokens.headerHeight + tokens.rowHeight + tokens.padBottom, y + tokens.padBottom)
  const naturalWidth = Math.min(tokens.nodeMaxAutoWidth, Math.max(tokens.nodeMinWidth, contentWidth))
  if (minimized) {
    const height = tokens.headerHeight + tokens.padBottom
    const width = Math.min(
      tokens.nodeMaxAutoWidth,
      Math.max(
        MINIMIZED_NODE_MIN_WIDTH,
        measure(title, titleRenamed ? 'renamedTitle' : 'title') + tokens.padX * 2 + 8,
      ),
    )
    return {
      width,
      height,
      minWidth: MINIMIZED_NODE_MIN_WIDTH,
      minHeight: height,
      headerHeight: tokens.headerHeight,
      title,
      titleRenamed,
      rows: [],
      pins: pins.map((pin) => ({ ...pin, y: tokens.headerHeight / 2, minimized: true as const })),
      minimized: true,
    }
  }
  return {
    width: sizeOverride ? Math.max(tokens.nodeMinWidth, sizeOverride.width) : naturalWidth,
    height: sizeOverride ? Math.max(minHeight, sizeOverride.height) : minHeight,
    minWidth: tokens.nodeMinWidth,
    minHeight,
    headerHeight: tokens.headerHeight,
    title,
    titleRenamed,
    rows,
    pins,
  }
}

/** Severity-first aggregation over several occurrences' progress states. */
function aggregateProgress(progresses: readonly NodeProgress[]): NodeProgress | undefined {
  const stateOrder = ['error', 'running', 'pending', 'skipped', 'cached', 'done'] as const
  for (const s of stateOrder) {
    if (progresses.some((p) => p.state === s)) {
      // Only RUNNING children contribute to the aggregate bar: finished
      // occurrences may keep their final value (comfy-v1 does), and mixing
      // those in would freeze the bar near 100% while work is still going.
      // Values are injected external data: a NaN/Infinity child must not
      // poison the whole average.
      const running = progresses.filter((p) => p.state === 'running' && Number.isFinite(p.value))
      return {
        state: s,
        ...(s === 'running' && running.length > 0
          ? { value: running.reduce((a, p) => a + p.value!, 0) / running.length }
          : {}),
      }
    }
  }
  return undefined
}

/**
 * Map per-execution runtime node states onto scene nodes of ONE graph.
 * Runtime ids are occurrence keys; a subgraph instance aggregates the states
 * of all inner occurrences beneath it (collapsed-progress UX lands in execution UX implementation;
 * the aggregation rule lives here from the start).
 *
 * `resolveRuntimeIds` (view-occurrence mapping, core/occurrences.ts) makes
 * the function depth-aware: it names the runtime ids each scene node owns
 * in the CURRENT view, so nested views map exactly and never rely on bare
 * inner ids colliding with root runtime ids. A single resolved id keeps its
 * direct progress (value included); several aggregate severity-first.
 * Without a resolver the historical root-view behavior applies.
 */
export function nodeStatesForGraph(
  states: Readonly<Record<string, NodeProgress>>,
  scene: Scene,
  resolveRuntimeIds?: (sceneNodeId: string, isSubgraph: boolean) => readonly string[],
): Readonly<Record<string, NodeProgress>> {
  const out: Record<string, NodeProgress> = {}
  for (const sceneNode of scene.nodes) {
    if (resolveRuntimeIds) {
      const ids = resolveRuntimeIds(sceneNode.id, sceneNode.isSubgraph)
      const progresses = ids.map((id) => states[id]).filter((p): p is NodeProgress => p !== undefined)
      if (progresses.length === 0) continue
      if (progresses.length === 1 && !sceneNode.isSubgraph) {
        out[sceneNode.id] = progresses[0]!
        continue
      }
      const agg = aggregateProgress(progresses)
      if (agg) out[sceneNode.id] = agg
      continue
    }
    if (!sceneNode.isSubgraph) {
      const direct = states[sceneNode.id]
      if (direct) out[sceneNode.id] = direct
      continue
    }
    // Aggregate occurrences nested inside this instance (core owns the
    // occurrence-key separator/escaping - never string-match here).
    const inner = Object.entries(states)
      .filter(([k]) => isOccurrenceKeyWithin(k, asNodeId(sceneNode.id)))
      .map(([, p]) => p)
    if (inner.length === 0) continue
    const agg = aggregateProgress(inner)
    if (agg) out[sceneNode.id] = agg
  }
  return out
}

/**
 * Structural equality over two built scenes. A host that rebuilds on every
 * document tick can receive a scene identical to the one already installed
 * (a workspace-session swap re-reads an equal document; an edit in another
 * graph leaves this one untouched). Replacing the renderer scene anyway
 * fires scene-replacement listeners, which cancel in-flight link drags and
 * hide tooltips - so hosts compare first and keep the installed scene when
 * nothing changed.
 *
 * Scenes are plain data (no functions, no cycles). Undefined-valued keys
 * compare as absent, matching how conditional spreads build them. Any
 * mismatch (including NaN, which never equals itself) reports "different",
 * which only costs an unnecessary replacement - today's behavior.
 */
export function scenesEqual(a: Scene, b: Scene): boolean {
  return structuralEqual(a, b)
}

function structuralEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!structuralEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  // Widget specs carry unknown option/default values, which can hold Maps,
  // Sets, Dates, or class instances with no enumerable own keys. Two such
  // distinct objects must not compare equal, so only plain objects compare
  // structurally; everything else already matched by reference or differs.
  const protoA = Object.getPrototypeOf(a) as unknown
  const protoB = Object.getPrototypeOf(b) as unknown
  if ((protoA !== Object.prototype && protoA !== null) || (protoB !== Object.prototype && protoB !== null)) {
    return false
  }
  const recordA = a as Record<string, unknown>
  const recordB = b as Record<string, unknown>
  const keysA = Object.keys(recordA).filter((k) => recordA[k] !== undefined)
  const keysB = Object.keys(recordB).filter((k) => recordB[k] !== undefined)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!structuralEqual(recordA[key], recordB[key])) return false
  }
  return true
}
