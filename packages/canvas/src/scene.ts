/**
 * Scene building: document graph + schemas + layout -> a plain,
 * JSON-friendly scene the renderer draws and tests snapshot. Derived, never
 * stored: rebuild on document change (current scale; retained/incremental updates
 * are the optimization path, behind this same shape).
 */

import {
  asNodeId,
  asPortId,
  boundaryBindingKey,
  buildGraphConnectivity,
  buildRerouteIndex,
  canonicalTypeIdOf,
  companionSourcesOf,
  DINKSTER_REGION_PSEUDO_NODE,
  defaultBoundaryLabels,
  documentNodeResolver,
  documentPrimitiveResolver,
  primitiveOf,
  documentValueSourceResolver,
  effectiveOccurrenceTopology,
  elabInputsOf,
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
  portRefKey,
  regionBoundaryLabels,
  resolveBoundaryRoute,
  resolveWidgetRepresentation,
  outputsOf,
  allRowsOf,
  samePortRef,
  solveGraphTypes,
  subgraphDefIdOf,
  traceEndpoint,
  traceEndpointAll,
  typeExprFromTypeId,
  valueKeyOf,
  type BoundaryItem,
  type BoundaryPositionResolver,
  type CommandInvocation,
  type Connectivity,
  type Diagnostic,
  type DynamicPortState,
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
  type NodeSchema,
  type OccurrenceLinkEndpoint,
  type OccurrenceRef,
  type PortRef,
  type SchemaResolver,
  type SelectorData,
  type SolveResult,
  type TypeExpr,
  type ValueSourceData,
  type VirtualNodeRenderModel,
  type WidgetSpec,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  connectedPortKey,
  insetRowStack,
  layoutBoundaryNode,
  REGION_INDEX_SLOT,
  TITLE_START,
  layoutNode,
  type BoundarySlotInfo,
  type LayoutRow,
  type NodeLayout,
  type PinLayout,
  type SizeOverride,
  type TextMeasurer,
  type WidgetMeasure,
} from './layout.js'
import { canvasPaintTokens, type DesignTokens } from './tokens.js'

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
      before.textLines === after.textLines && before.previewFolded === after.previewFolded &&
      before.minimizedPreviewOpen === after.minimizedPreviewOpen && before.sections === after.sections && before.color === after.color && before.ext === after.ext
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
    const position = view.nodes[node.id]?.position ?? { x: canvasPaintTokens.scene.nodeFallbackX, y: (fallbackY += canvasPaintTokens.scene.nodeFallbackStepY) }
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
    case 'tuple': return left.elements.length === (right as typeof left).elements.length && left.elements.every((element, index) => sameTypeExpr(element, (right as typeof left).elements[index]!))
    case 'tuple_element': {
      const other = right as typeof left
      return left.input === other.input && left.index === other.index && (left.element === undefined ? other.element === undefined : other.element !== undefined && sameTypeExpr(left.element, other.element))
    }
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

/** Whether a node's preview shows only its caption row. */
export function previewFoldedOf(node: SceneNode): boolean {
  return node.layout.minimized === true ? node.minimizedPreviewOpen !== true : node.previewFolded === true
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
  /**
   * Every field row of a minimized node or of a node with a folded section,
   * laid out open with its sections unfolded, so a problem on a field the
   * node does not show still reaches its tab. Absent when layout shows them all.
   */
  readonly fieldRows?: readonly LayoutRow[]
  /** Schema declares live previews or an output intended for preview. */
  readonly previewCapable?: true
  /** The open node's preview is folded to its caption row. */
  readonly previewFolded?: true
  /** A minimized node's preview was opened by its caption; minimized previews start folded. */
  readonly minimizedPreviewOpen?: true
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
  /**
   * Inputs panel with field rows: the values they show, keyed by boundary
   * item id as on the subgraph node outside. They are the values of the
   * subgraph node the editor came in through, or the defaults a new
   * subgraph node starts with when it came in through none. Each row's
   * `familyOwner` names the node and value key an edit writes, or its
   * `valueSourceOwner` the value source.
   */
  readonly fields?: {
    readonly node: NodeData
    /** Rows wired outside the subgraph: dimmed and not editable, with the arriving value when the document fixes it. */
    readonly wired: Readonly<Record<string, { readonly value?: Json }>>
    /** Boundary item id -> value key of its first row, the one its pin and wire belong to. */
    readonly heads: Readonly<Record<string, string>>
  }
}

/** The Inputs panel as a node face, so its field rows hit, paint and edit as a node's do. */
export function boundaryFieldNode(bnode: SceneBoundaryNode): SceneNode | undefined {
  if (bnode.fields === undefined) return undefined
  return { id: boundarySceneId(bnode.side), x: bnode.x, y: bnode.y, layout: bnode.layout, node: bnode.fields.node, isSubgraph: true }
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
    }
  | { readonly kind: 'reroute'; readonly reroute: string }
  | { readonly kind: 'valueSource'; readonly valueSource: string }
  | { readonly kind: 'widgetTap'; readonly node: string; readonly input: string }
  /** A selector endpoint: with `candidate` = one branch input, without = the output. */
  | { readonly kind: 'selector'; readonly selector: string; readonly candidate?: string }
  /** A boundary pseudo-node pin; `item` is the boundary item id (opaque - never split). */
  | { readonly kind: 'boundary'; readonly side: 'inputs' | 'outputs'; readonly item: string }

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
  /** The wire leaves a kept row (a field no longer part of its node): drawn dimmed, it gives nothing. */
  readonly dimmed?: true
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
export const REROUTE_RADIUS = canvasPaintTokens.reroute.radius

/**
 * Ghost socket geometry for a HOVERED reroute: an input socket floats left
 * of the dot and an output socket right of it, advertising that links can
 * be pulled out of (or into) the junction without the undiscoverable
 * Alt+drag. One constant pair shared by renderer AND hit testing so the
 * painted circle and its grab region can never drift apart.
 */
export const REROUTE_SOCKET_OFFSET = REROUTE_RADIUS + canvasPaintTokens.reroute.socketGap
export const REROUTE_SOCKET_RADIUS = canvasPaintTokens.reroute.socketRadius

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
  /**
   * While a subgraph node is entered, the value it sends through this
   * source, which the Inputs panel edits. The pill shows it dimmed and is
   * not edited there.
   */
  readonly arriving?: { readonly value: Json }
  /**
   * While a subgraph node is entered, the boundary input that shows this
   * source as a field on that node, and the input's name there; painted as
   * the cyan subgraph icon before the title (valueSourceMarkRect).
   */
  readonly subgraphMark?: { readonly item: string; readonly label: string }
}

export const VS_HEIGHT_PAD = canvasPaintTokens.valueSource.heightPadding
export const VS_MIN_WIDTH = canvasPaintTokens.valueSource.minWidth
export const VS_BADGE_SIZE = canvasPaintTokens.valueSource.badgeSize
/** Badge inset from the pill's right edge. */
export const VS_BADGE_INSET = canvasPaintTokens.valueSource.badgeInset

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

/**
 * World-space square of the subgraph mark before a value source's title
 * (SceneValueSource.subgraphMark). Shared by painting and pointer hit
 * testing; `padX` is the design tokens' padX.
 */
export function valueSourceMarkRect(vs: SceneValueSource, padX: number): { readonly x: number; readonly y: number; readonly size: number } {
  const size = canvasPaintTokens.widget.subgraphMark.size
  return { x: vs.x + padX, y: vs.y + (vs.height - size) / 2, size }
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

export const SELECTOR_MIN_WIDTH = canvasPaintTokens.selector.minWidth
export const SELECTOR_BADGE_SIZE = canvasPaintTokens.selector.badgeSize
/** Badge inset from the selector's right edge (header band). */
export const SELECTOR_BADGE_INSET = canvasPaintTokens.selector.badgeInset

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
export const NET_STUB_GAP = canvasPaintTokens.net.gap
export const NET_STUB_HEIGHT = canvasPaintTokens.net.height
export const NET_STUB_PAD_X = canvasPaintTokens.net.paddingX

export const netStubId = (netId: string, role: 'source' | 'sink', ref: PortRef): string =>
  JSON.stringify(['netView', netId, role, ref.node, ref.port])

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
export const GROUP_HEADER_HEIGHT = canvasPaintTokens.group.headerHeight

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

function projectTypeThroughRegionInputs(
  document: WorkflowDocument,
  link: import('@dinkster/core').EffectiveLink,
  type: TypeExpr,
): TypeExpr {
  if (link.identity.kind !== 'parentLeg') return type
  let graph = document.graphs[document.root]
  let routeIndex = 0
  let projected = type
  for (const nodeId of link.to.instancePath) {
    const node = graph?.nodes[nodeId]
    const bodyId = subgraphDefIdOf(node?.type ?? '')
    if (node === undefined || bodyId === undefined) break
    const index = link.identity.route.findIndex((leg, candidate) =>
      candidate >= routeIndex && leg.graph === bodyId)
    if (index >= 0) {
      const leg = link.identity.route[index]!
      if (node.region?.elementPorts?.includes(leg.boundaryId) && projected.kind === 'list') {
        projected = projected.element
      }
      routeIndex = index + 1
    }
    graph = document.graphs[bodyId]
  }
  return projected
}

/** Resolve parent producers outward so each drilled graph receives only its occurrence's constraints. */
function projectedTypeConstraints(
  document: WorkflowDocument,
  resolve: SchemaResolver,
  topology: EffectiveOccurrenceTopology,
  graphId: string,
): readonly ProjectedTypeConstraint[] {
  const resolveDocumentNode = documentNodeResolver(document, resolve)
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
      const type = solved.result.portTypeOf(trace.ref.node, 'output', trace.ref.port)
      return type === undefined ? [] : [{
        type: projectTypeThroughRegionInputs(document, link, type),
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
        keys.add(link.from.endpoint.port)
        projectedOutputKeys.set(link.from.endpoint.node, keys)
      }
      if (link.to.graphId === graph.id && isPortEndpoint(link.to.endpoint)) {
        const keys = projectedInputKeys.get(link.to.endpoint.node) ?? new Set<string>()
        keys.add(link.to.endpoint.port)
        projectedInputKeys.set(link.to.endpoint.node, keys)
        const ports = projectedInputPortKeys.get(link.to.endpoint.node) ?? new Set<string>()
        ports.add(link.to.endpoint.port)
        projectedInputPortKeys.set(link.to.endpoint.node, ports)
      }
    }
    const connectivityOf = (nodeId: import('@dinkster/core').NodeId) => {
      const base = baseConnectivity(nodeId)
      return {
        isInputConnected: (port: string) =>
          projectedInputKeys.get(nodeId)?.has(port) || base.isInputConnected(port),
        isOutputConnected: (port: string) =>
          projectedOutputKeys.get(nodeId)?.has(port) || base.isOutputConnected(port),
        inputPorts: () => [...new Set([...(base.inputPorts?.() ?? []), ...(projectedInputPortKeys.get(nodeId) ?? [])])],
        outputPorts: () => [...new Set([...(base.outputPorts?.() ?? []), ...(projectedOutputKeys.get(nodeId) ?? [])])],
      }
    }
    const result = solveGraphTypes(solveGraph, resolve, {
      resolveNode: (node) => resolveDocumentNode(sourceGraphId, node),
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

/** A field row whose stored value the host checks. */
export interface StoredValueRow {
  readonly nodeId: string
  readonly inputId: string
  readonly valueKey: string
  readonly spec: WidgetSpec
}

export interface BuildSceneInput {
  readonly document: WorkflowDocument
  /**
   * Whether a field's stored value fails its widget's own check (the
   * host's widget kinds). A hidden row whose value fails shows, as a row
   * with a problem does.
   */
  readonly storedValueProblem?: (row: StoredValueRow, value: Json | undefined) => boolean
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
    readonly valueOwners?: ReadonlyMap<string, ReadonlyMap<string, {
      readonly graphId: string
      readonly nodeId: string
      readonly valueKey: string
    }>>
    readonly valueSources?: import('@dinkster/core').OccurrenceDynamicView['valueSources']
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
    const position = graphView.nodes[node.id]?.position ?? { x: canvasPaintTokens.scene.nodeFallbackX, y: (fallbackY += canvasPaintTokens.scene.nodeFallbackStepY) }
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

/** Reuse static geometry only when numeric edits leave the effective interface unchanged. */
export function updateSceneNodeValues(
  scene: Scene,
  previous: WorkflowDocument,
  current: WorkflowDocument,
  graphId: string,
  resolve: SchemaResolver,
): Scene | undefined {
  if (scene.graphId !== graphId || graphId !== current.root || Object.keys(current.graphs).length !== 1 ||
      !sameReferencesExcept(previous as unknown as Readonly<Record<string, unknown>>, current as unknown as Readonly<Record<string, unknown>>, 'graphs') ||
      !sameReferencesExcept(previous.graphs, current.graphs, graphId)) return undefined
  const before = previous.graphs[graphId]
  const after = current.graphs[graphId]
  if (!before || !after || !sameReferencesExcept(before as unknown as Readonly<Record<string, unknown>>, after as unknown as Readonly<Record<string, unknown>>, 'nodes') ||
      Object.keys(before.nodes).length !== Object.keys(after.nodes).length || scene.nodes.length !== Object.keys(after.nodes).length) return undefined
  if (after.boundary || Object.keys(after.valueSources ?? {}).length || Object.keys(after.selectors ?? {}).length) return undefined
  for (const node of Object.values(after.nodes)) {
    const schema = resolve(node.type)
    if (node.virtual || node.type.startsWith('#') || node.region || !schema || schema.virtual ||
        allRowsOf(schema.body).some((row) => row.kind === 'group' || row.kind === 'choice' || row.kind === 'typeChoice' || row.kind === 'described')) return undefined
  }
  let changed = false
  const nodes: SceneNode[] = []
  for (const existing of scene.nodes) {
    const old = before.nodes[existing.id]
    const node = after.nodes[existing.id]
    if (!old || !node) return undefined
    if (old === node) { nodes.push(existing); continue }
    if (existing.node !== old || node.virtual || node.type.startsWith('#') ||
        !sameReferencesExcept(old as unknown as Readonly<Record<string, unknown>>, node as unknown as Readonly<Record<string, unknown>>, 'values')) return undefined
    const schema = resolve(node.type)
    // A row with `visible` may show for a problem the new value has: the full build decides.
    if (!schema || schema.selector ||
      !schema.body.every((row) => (row.kind === 'input' || row.kind === 'output') && row.visible === undefined)) return undefined
    for (const key of new Set([...Object.keys(old.values), ...Object.keys(node.values)])) {
      if (old.values[key] === node.values[key]) continue
      const input = inputsOf(schema).find((item) => item.id === key)
      if (input === undefined || !['INT', 'FLOAT'].includes(input.widget?.widgetType ?? '') ||
          typeof node.values[key] !== 'number' || !Number.isFinite(node.values[key]) ||
          (old.values[key] !== undefined && (typeof old.values[key] !== 'number' || !Number.isFinite(old.values[key])))) return undefined
    }
    if (!structuralEqual(existing.elaborated, elaborateInterface(schema, node))) return undefined
    changed = true
    nodes.push({ ...existing, node })
  }
  return changed ? { ...scene, nodes } : scene
}

/** Use the rendered layout when persisting a definition's initial panel positions. */
export function boundaryPositions(input: BuildSceneInput): ReturnType<BoundaryPositionResolver> {
  const scene = buildScene(input)
  const position = (side: 'inputs' | 'outputs') => {
    const panel = scene.boundaryNodes.find((node) => node.side === side)!
    return { position: { x: panel.x, y: panel.y } }
  }
  return { inputs: position('inputs'), outputs: position('outputs') }
}

export function buildScene(input: BuildSceneInput): Scene {
  const def: GraphDef | undefined = input.document.graphs[input.graphId]
  /**
   * A node's interface as drawn. A row hidden by its `visible` shows while it
   * has a problem: a solver problem on its port, or a stored value its
   * widget's own check refuses.
   */
  const elaborateShown = (
    schema: NodeSchema,
    node: NodeData,
    connectivity: Connectivity,
    nodeId: string,
    solverProblems: ReadonlySet<string> | undefined,
    representations: Readonly<Record<string, string>> | undefined,
  ): ElaboratedInterface => {
    const problemRows = new Set(solverProblems)
    const elaborated = elaborateInterface(schema, node, connectivity, problemRows.size > 0 ? { problemRows } : {})
    const check = input.storedValueProblem
    if (check === undefined) return elaborated
    for (const item of elabInputsOf(elaborated)) {
      const widget = item.spec.widget
      if (item.spec.hidden !== true || widget === undefined) continue
      const valueKey = valueKeyOf(item)
      const spec = resolveWidgetRepresentation(widget, representations?.[valueKey]).spec
      if (check({ nodeId, inputId: item.spec.id, valueKey, spec }, node.values[valueKey])) problemRows.add(item.address.port)
    }
    return problemRows.size > (solverProblems?.size ?? 0)
      ? elaborateInterface(schema, node, connectivity, { problemRows })
      : elaborated
  }
  if (!def) return { graphId: input.graphId, nodes: [], links: [], reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [], boundaryNodes: [], diagnostics: [] }
  let resolveSource: ReturnType<typeof documentValueSourceResolver> | undefined
  const sourcePath = input.occurrence === undefined
    ? input.graphId === input.document.root ? [] : undefined
    : [...input.occurrence.owner.instancePath, input.occurrence.owner.node]
  let resolvePrimitive: ReturnType<typeof documentPrimitiveResolver> | undefined
  const resolveNode = documentNodeResolver(input.document, input.resolve, (graphId, sourceId, path) => {
    resolveSource ??= documentValueSourceResolver(input.document, input.resolve)
    return resolveSource(graphId, sourceId, path)
  }, (graphId, node, path) => {
    resolvePrimitive ??= documentPrimitiveResolver(input.document, input.resolve)
    return resolvePrimitive(graphId, node, path)
  })
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

  // Connected ports by node id (links + named nets), keyed by flattened id:
  // collapsed sections keep pins for these so their noodles never dangle.
  const connectedByNode = new Map<string, Set<string>>()
  const markConnected = (ref: PortRef, direction: 'in' | 'out'): void => {
    let set = connectedByNode.get(ref.node)
    if (!set) connectedByNode.set(ref.node, (set = new Set()))
    set.add(connectedPortKey(direction, ref.port))
  }
  const structuralLinks = effective === undefined
    ? Object.values(def.links).map((link) => ({ from: { endpoint: link.from }, to: { endpoint: link.to } }))
    : [...effective.links, ...effective.projectedParentLinks]
  for (const link of structuralLinks) {
    const fromEndpoint = 'endpoint' in link.from ? link.from.endpoint : link.from
    const toEndpoint = 'endpoint' in link.to ? link.to.endpoint : link.to
    if (isPortEndpoint(fromEndpoint)) markConnected(fromEndpoint, 'out')
    // A widget tap is a producer connection too: the tap's input must keep
    // its right-edge anchor inside a collapsed section.
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
          markConnected({ node: b.node, port: b.port }, 'in')
      }
    }
    for (const item of def.boundary.outputs) {
      if (item.binds.kind === 'port')
        markConnected({ node: item.binds.node, port: item.binds.port }, 'out')
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
      set.add(link.from.endpoint.port)
      projectedOutputs.set(link.from.endpoint.node, set)
    }
    if (link.to.graphId === def.id && isPortEndpoint(link.to.endpoint)) {
      const set = projectedInputs.get(link.to.endpoint.node) ?? new Set<string>()
      set.add(link.to.endpoint.port)
      projectedInputs.set(link.to.endpoint.node, set)
      const ports = projectedInputPorts.get(link.to.endpoint.node) ?? new Set<string>()
      ports.add(link.to.endpoint.port)
      projectedInputPorts.set(link.to.endpoint.node, ports)
    }
  }
  const connectivityOf = (nodeId: import('@dinkster/core').NodeId) => {
    const base = baseConnectivityOf(nodeId)
    return {
      isInputConnected: (port: string) =>
        projectedInputs.get(nodeId)?.has(port) || base.isInputConnected(port),
      isOutputConnected: (port: string) =>
        projectedOutputs.get(nodeId)?.has(port) || base.isOutputConnected(port),
      inputPorts: () => [...new Set([...(base.inputPorts?.() ?? []), ...(projectedInputPorts.get(nodeId) ?? [])])],
      outputPorts: () => [...new Set([...(base.outputPorts?.() ?? []), ...(projectedOutputs.get(nodeId) ?? [])])],
    }
  }

  // Solving is deliberately downstream from elaboration in core. Scene
  // layout still uses the elaborated interface for its structure, then each
  // visible pin receives the solver's display type. Keeping this substitution
  // here (rather than teaching layout about graph constraints) preserves the
  // document -> elaboration -> solving -> rendering dependency direction.
  const solvedTypes = solveGraphTypes(effectiveGraph, input.resolve, {
    resolveNode: (node) => resolveNode(input.graphId, node, sourcePath),
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
  // A primitive whose fed fields share no value shows the problem on its
  // value pin and on each wire it sends here; the value and wires stay.
  const primitiveDiagnostics: Diagnostic[] = []
  for (const node of Object.values(def.nodes)) {
    const base = input.resolve(node.type)
    const shape = base && primitiveOf(base)
    if (!shape) continue
    resolvePrimitive ??= documentPrimitiveResolver(input.document, input.resolve)
    for (const diagnostic of resolvePrimitive(input.graphId, node, sourcePath)?.diagnostics ?? []) {
      primitiveDiagnostics.push({ ...diagnostic, anchor: { port: { node: node.id, port: asPortId(shape.value.id) } } })
      for (const link of Object.values(def.links)) {
        if (isPortEndpoint(link.from) && link.from.node === node.id && link.from.port === shape.output.id)
          primitiveDiagnostics.push({ ...diagnostic, anchor: { link: link.id } })
      }
    }
  }
  const solverDiagnostics = [...solvedTypes.diagnostics.map((diagnostic): Diagnostic => {
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
  }), ...primitiveDiagnostics]

  /** Ports with a solver error or warning, by node: rows with a problem show even when hidden. */
  const problemPorts = new Map<string, Set<string>>()
  for (const d of solverDiagnostics) {
    const ref = d.anchor?.port
    if (ref === undefined) continue
    if (d.severity === 'info') continue
    let ports = problemPorts.get(ref.node)
    if (!ports) problemPorts.set(ref.node, (ports = new Set()))
    ports.add(ref.port)
  }

  const nodes: SceneNode[] = []
  const byId = new Map<string, SceneNode>()
  // An automatic value that cannot be worked out: the field's warning, also
  // listed in Problems, where picking it moves to the field.
  const automaticDiagnostics: Diagnostic[] = []
  let fallbackY = 0
  for (const node of Object.values(def.nodes)) {
    const view = viewNodes[node.id]
    const pos = view?.position ?? { x: canvasPaintTokens.scene.nodeFallbackX, y: (fallbackY += canvasPaintTokens.scene.nodeFallbackStepY) }
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
    const schema = resolveNode(input.graphId, occurrenceNode, sourcePath)
    const elaborated = schema
      ? elaborateShown(schema, occurrenceNode, connectivityOf(node.id), node.id, problemPorts.get(node.id), view?.views)
      : undefined
    for (const diagnostic of elaborated?.diagnostics ?? []) {
      const port = diagnostic.data?.['input']
      if (diagnostic.code !== 'automatic.default' || typeof port !== 'string') continue
      automaticDiagnostics.push({ ...diagnostic, anchor: { port: { node: asNodeId(node.id), port: asPortId(port) } } })
    }
    const baseLayout = schema
      ? layoutNode(schema, occurrenceNode, input.tokens, measure, input.widgetMeasure, {
          ...(input.seedControllerEnabled !== undefined ? { seedControllerEnabled: input.seedControllerEnabled } : {}),
          ...(view?.collapsed === true ? { minimized: true as const } : {}),
          ...(view?.size ? { size: view.size } : {}),
          ...(sectionOverrides ? { sectionOverrides } : {}),
          ...(view?.views ? { widgetRepresentations: view.views } : {}),
          ...(view?.textLines ? { textBoxLines: view.textLines } : {}),
          ...(connectedByNode.has(node.id) ? { connectedPorts: connectedByNode.get(node.id)! } : {}),
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
    // A promoted boundary input owns the value and editable menu of the
    // inner row it binds; edits on that row write to the owning instance.
    const optionsOwnerFor = (row: Extract<typeof baseLayout.rows[number], { kind: 'widget' }>) => {
      if (row.optionsTarget === undefined) return undefined
      const owner = input.occurrenceView?.valueOwners?.get(node.id)?.get(row.valueKey)
      if (owner === undefined) return undefined
      const target = input.document.graphs[owner.graphId]?.nodes[owner.nodeId]
      const targetSchema = target && resolveNode(owner.graphId, target)
      if (!targetSchema) return undefined
      // Value owners project only static promoted ports, so this is the
      // boundary's document id, not an elaborated member key.
      const route = resolveBoundaryRoute(targetSchema, { kind: 'port', node: asNodeId(owner.nodeId), port: asPortId(owner.valueKey) }, 'input')
      if (!route.ok) return undefined
      return {
        owner: { graphId: owner.graphId, nodeId: owner.nodeId, construct: owner.valueKey },
        ...(row.materialize === undefined ? {} : { materialize: row.materialize }),
      }
    }
    const rawLayout = schema && input.occurrenceView
      ? {
          ...baseLayout,
          rows: baseLayout.rows.map((row) => {
            if (row.kind !== 'widget') return row
            const optionsOwner = optionsOwnerFor(row)
            const menuRow = optionsOwner === undefined ? row : {
              ...row, optionsTarget: { ...row.optionsTarget!, ...optionsOwner },
            }
            const valueOwner = input.occurrenceView!.valueOwners?.get(node.id)?.get(row.valueKey)
            return valueOwner === undefined ? menuRow : {
              ...menuRow,
              familyOwner: {
                graphId: valueOwner.graphId,
                nodeId: valueOwner.nodeId,
                construct: row.valueKey,
                valueKey: valueOwner.valueKey,
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
            if (matchVariable === undefined) {
              return {
                ...pin,
                type,
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
            }
          }),
        }
      : rawLayout
    const virtual = node.virtual === true ? input.renderVirtualNode?.(occurrenceNode) : undefined
    const layout = virtual === undefined ? layoutWithPorts : { ...layoutWithPorts, pins: [] }
    const foldedSections = elaborated?.items.filter((item) => item.kind === 'section').map((item) => item.spec.id) ?? []
    const hidesFields = view?.collapsed === true || baseLayout.rows.some((row) => row.kind === 'section' && row.collapsed)
    const fieldRows = schema && hidesFields
      ? layoutNode(schema, occurrenceNode, input.tokens, measure, input.widgetMeasure, {
          ...(input.seedControllerEnabled !== undefined ? { seedControllerEnabled: input.seedControllerEnabled } : {}),
          sectionOverrides: Object.fromEntries(foldedSections.map((id) => [id, false])),
          ...(view?.views ? { widgetRepresentations: view.views } : {}),
          ...(elaborated !== undefined ? { elaborated } : {}),
        }).rows.filter((row) => row.kind === 'widget')
      : undefined
    const sceneNode: SceneNode = {
      id: node.id,
      x: pos.x,
      y: pos.y,
      layout,
      node: occurrenceNode,
      ...(virtual !== undefined ? { virtual } : {}),
      ...(elaborated !== undefined ? { elaborated } : {}),
      ...(fieldRows !== undefined ? { fieldRows } : {}),
      ...(schema !== undefined && hasPreviewSurface(schema)
        ? { previewCapable: true as const }
        : {}),
      ...(view?.previewFolded === true ? { previewFolded: true as const } : {}),
      ...(view?.collapsed === true && view.minimizedPreviewOpen === true ? { minimizedPreviewOpen: true as const } : {}),
      ...(view?.color !== undefined ? { color: view.color } : {}),
      isSubgraph: subgraphDefIdOf(node.type) !== undefined,
      ...(node.region !== undefined ? { regionKind: node.region.kind } : {}),
      ...(schema ? {} : { unrecognized: true, missingSchema: true }),
    }
    nodes.push(sceneNode)
    byId.set(node.id, sceneNode)
  }

  // The subgraph node the editor came in through, and the graph it sits in.
  let ownerNode: NodeData | undefined
  let ownerGraph: GraphDef | undefined
  if (input.occurrence !== undefined) {
    ownerGraph = input.document.graphs[input.document.root]
    for (const hop of input.occurrence.owner.instancePath) {
      const hopNode = ownerGraph?.nodes[hop]
      ownerGraph = hopNode?.type.startsWith('#') ? input.document.graphs[hopNode.type.slice(1)] : undefined
    }
    ownerNode = ownerGraph?.nodes[input.occurrence.owner.node]
  }
  // While a node is entered, a value source that node shows as a field sends
  // the node's value (or the outer owner's), else its own.
  const sentSourceValues = new Map<string, Json>()
  if (ownerNode !== undefined) {
    for (const item of def.boundary?.inputs ?? []) {
      const source = item.binds.kind === 'valueSource' && item.promoted === true ? def.valueSources?.[item.binds.valueSource] : undefined
      if (source === undefined) continue
      const occurrence = input.occurrenceView?.valueSources?.get(source.id)
      const value = occurrence !== undefined ? occurrence.value
        : Object.hasOwn(ownerNode.values, item.id) ? ownerNode.values[item.id] : undefined
      sentSourceValues.set(source.id, value !== undefined ? value : source.value)
    }
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
    const pos = viewValueSources[vs.id]?.position ?? { x: 0, y: (vsFallbackY += canvasPaintTokens.scene.valueSourceFallbackStepY) }
    resolveSource ??= documentValueSourceResolver(input.document, input.resolve)
    const effective = resolveSource(def.id, vs.id, sourcePath)!
    const title = vs.title ?? effective.spec?.widgetType ?? 'value'
    const sent = sentSourceValues.has(vs.id) ? { value: sentSourceValues.get(vs.id)! } : undefined
    const valueText = valueSourceValueText(sent !== undefined ? sent.value : vs.value)
    // A sent value comes from a field on the entered node: room for its mark.
    const markReserve = sent === undefined ? 0 : canvasPaintTokens.widget.subgraphMark.size + canvasPaintTokens.widget.subgraphMark.gap
    const width = Math.min(
      input.tokens.nodeMaxAutoWidth,
      Math.max(
        VS_MIN_WIDTH,
        input.tokens.padX +
          markReserve +
          measure(title, 'label') +
          canvasPaintTokens.valueSource.valueGap +
          measure(valueText, 'value') +
          canvasPaintTokens.valueSource.valueGap +
          VS_BADGE_SIZE +
          VS_BADGE_INSET,
      ),
    )
    const typeName = canonicalTypeIdOf(effective.type)
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
      ...(sent !== undefined ? { arriving: sent } : {}),
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
    const key = ref.port
    // Real output only: a widget tap shares its input's port id on the 'out'
    // side, so an unguarded lookup would color off the widget row.
    const pin = producer?.layout.pins.find((p) => p.direction === 'out' && p.portId === key && p.widgetTap !== true)
    return pin === undefined ? undefined : canonicalTypeIdOf(pin.type)
  }
  const widgetTapTypeName = (nodeId: string, inputId: string): string | undefined => {
    const node = byId.get(nodeId)
    const pin = node?.layout.pins.find((p) => p.widgetTap === true && p.address.port === inputId)
    return pin === undefined ? undefined : canonicalTypeIdOf(pin.type)
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
      const key = t.ref.port
      if (producer?.layout.pins.some((p) => p.direction === 'out' && p.portId === key && p.maybeAbsent === true)) return true
    }
    return false
  }
  for (const reroute of Object.values(def.reroutes)) {
    const pos = viewReroutes[reroute.id]?.position ?? { x: 0, y: (rerouteFallbackY += canvasPaintTokens.scene.rerouteFallbackStepY) }
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
    const pos = viewSelectors[sel.id]?.position ?? { x: 0, y: (selectorFallbackY += canvasPaintTokens.scene.selectorFallbackStepY) }
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
        input.tokens.padX * 2 + measure(title, 'title') + canvasPaintTokens.selector.widthPadding + SELECTOR_BADGE_SIZE + SELECTOR_BADGE_INSET,
        ...candidates.map((c) => input.tokens.padX * 2 + measure(c.label, 'label') + canvasPaintTokens.selector.widthPadding),
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
  const endPoint = (end: LinkEndpoint, direction: 'in' | 'out'): { x: number; y: number; end: SceneLinkEnd; type?: TypeExpr; kept?: true } | undefined => {
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
        ...(pin.kept !== undefined ? { kept: true as const } : {}),
      } : undefined
    }
    const node = byId.get(end.node)
    const key = end.port
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
      ...(from.kept === true ? { dimmed: true as const } : {}),
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
      const key = ref.port
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
        pinX,
        pinY,
        x: geometry === undefined ? fallbackX : geometry.kind === 'offset' ? node.x + geometry.x : geometry.x,
        y: geometry === undefined ? fallbackY : geometry.kind === 'offset' ? node.y + geometry.y : geometry.y,
        width,
        height: NET_STUB_HEIGHT,
        ...(authored === undefined ? {} : { authored: true as const }),
        ...(geometry?.kind === 'absolute' ? { authoredAbsolute: true as const } : {}),
        ...(guideNets.has(net.id) ? { guide: true as const } : {}),
        ...(canonicalTypeIdOf(pin.type) !== undefined ? { typeName: canonicalTypeIdOf(pin.type)! } : {}),
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

    // Field rows: each input the subgraph node outside shows as a field
    // shows as the same field here. Its value is the one the inner node
    // receives in this occurrence (the entered node's value, else the
    // default), and an edit writes where that value is owned: the entered
    // node (or the outer node that owns its value), or with no node entered
    // the inner node's stored value, which is the default. A value source
    // the input binds is edited the same way, its own value being the
    // default.
    const fieldValues: Record<string, Json> = {}
    const fieldControllers: Record<string, NonNullable<NodeData['controllers']>[string]> = {}
    const fieldOwners = new Map<string,
      { readonly graphId: string; readonly nodeId: string; readonly valueKey: string } | { readonly graphId: string; readonly valueSourceId: string }>()
    for (const item of def.boundary.inputs) {
      const binds = item.binds
      if (binds.kind === 'valueSource' && item.promoted === true) {
        const source = def.valueSources?.[binds.valueSource]
        if (source === undefined) continue
        const occurrence = input.occurrenceView?.valueSources?.get(source.id)
        const controller = occurrence !== undefined ? occurrence.controller : ownerNode?.controllers?.[item.id]
        fieldValues[item.id] = sentSourceValues.has(source.id) ? sentSourceValues.get(source.id)! : source.value
        if (controller !== undefined) fieldControllers[item.id] = controller
        fieldOwners.set(item.id, occurrence?.owner ?? (ownerNode !== undefined && ownerGraph !== undefined
          ? { graphId: ownerGraph.id, nodeId: ownerNode.id, valueKey: item.id }
          : { graphId: def.id, valueSourceId: source.id }))
        continue
      }
      if (binds.kind !== 'port' || item.promoted !== true) continue
      const inner = def.nodes[binds.node]
      if (inner === undefined) continue
      const port = binds.port as string
      const values = input.occurrenceView?.values?.get(inner.id) ?? inner.values
      const controllers = input.occurrenceView?.controllers?.get(inner.id) ?? inner.controllers
      const owner = input.occurrenceView?.valueOwners?.get(inner.id)?.get(port)
      // Without the occurrence's owner the entered node's own value is shown,
      // because that node is where an edit is written.
      const entered = owner === undefined && ownerNode !== undefined && Object.hasOwn(ownerNode.values, item.id)
      if (entered) fieldValues[item.id] = ownerNode!.values[item.id]!
      else if (Object.hasOwn(values, port)) fieldValues[item.id] = values[port]!
      if (controllers !== undefined && Object.hasOwn(controllers, port)) fieldControllers[item.id] = controllers[port]!
      fieldOwners.set(item.id, owner ?? (ownerNode !== undefined && ownerGraph !== undefined
        ? { graphId: ownerGraph.id, nodeId: ownerNode.id, valueKey: item.id }
        : { graphId: def.id, nodeId: inner.id, valueKey: port }))
    }
    const fieldNode: NodeData = {
      id: asNodeId(boundarySceneId('inputs')),
      type: `#${def.id}`,
      values: fieldValues,
      controllers: fieldControllers,
    }
    const outsideRows = new Map<string, Extract<LayoutRow, { kind: 'widget' }>[]>()
    if (derived !== undefined && fieldOwners.size > 0) {
      // The entered node's chosen views, so a field drawn as a slider there
      // is a slider here too.
      const ownerView = ownerNode !== undefined && ownerGraph !== undefined
        ? input.document.view.graphs[ownerGraph.id]?.nodes[ownerNode.id]
        : undefined
      // The fields as the subgraph node outside draws them, so a primitive's
      // value has the range the fields it feeds inside give it.
      const fieldSchema = (ownerNode !== undefined && ownerGraph !== undefined
        ? resolveNode(ownerGraph.id, ownerNode, input.occurrence!.owner.instancePath)
        : resolveNode(def.id, fieldNode)) ?? derived
      const outside = layoutNode(fieldSchema, fieldNode, input.tokens, measure, input.widgetMeasure, {
        ...(input.seedControllerEnabled !== undefined ? { seedControllerEnabled: input.seedControllerEnabled } : {}),
        ...(ownerView?.views !== undefined ? { widgetRepresentations: ownerView.views } : {}),
        ...(ownerView?.textLines !== undefined ? { textBoxLines: ownerView.textLines } : {}),
      })
      for (const row of outside.rows) {
        const owner = row.kind === 'widget' ? fieldOwners.get(row.inputId) : undefined
        // Rows whose options are edited on the node (editable choices)
        // stay pins: those edits target the node itself.
        if (row.kind !== 'widget' || owner === undefined || row.selector !== undefined || row.optionsTarget !== undefined) continue
        outsideRows.set(row.inputId, [{ ...row, ...('valueSourceId' in owner
          ? { valueSourceOwner: owner }
          : { familyOwner: { graphId: owner.graphId, nodeId: owner.nodeId, construct: row.valueKey, valueKey: owner.valueKey } }) }])
      }
    }
    // A value the owner receives by a wire outside the subgraph is not
    // edited here; a document literal on that wire is shown instead.
    const wiredFields: Record<string, { value?: Json }> = {}
    const drivenByGraph = new Map<string, ReturnType<typeof companionSourcesOf>>()
    for (const row of [...outsideRows.values()].flat()) {
      const owner = row.familyOwner
      const graph = owner === undefined ? undefined : input.document.graphs[owner.graphId]
      if (owner === undefined || owner.graphId === def.id || graph === undefined || owner.valueKey === undefined) continue
      if (!drivenByGraph.has(graph.id)) drivenByGraph.set(graph.id, companionSourcesOf(graph, undefined, undefined, input.resolve))
      const driven = drivenByGraph.get(graph.id)!.get(owner.nodeId)?.get(owner.valueKey)
      if (driven !== undefined) wiredFields[row.valueKey] = driven.kind === 'literal' ? { value: driven.value } : {}
    }
    const fieldsSubtitle = outsideRows.size === 0
      ? undefined
      : ownerNode === undefined ? 'defaults' : `of ${ownerNode.title ?? (input.resolve(ownerNode.type)?.displayName ?? def.name)}`

    const boundaryLabel = (
      item: BoundaryItem,
      derivedLabel: string | undefined,
      defaults: ReadonlyMap<string, string>,
      roles: ReadonlyMap<string, string> | undefined,
    ): string => {
      if (item.displayName !== undefined) return item.displayName
      if (roles !== undefined) return roles.get(item.id) ?? 'Boundary'
      if (derivedLabel !== undefined) return derivedLabel
      return defaults.get(item.id) ?? 'Boundary'
    }

    // Inputs drawn without their wire, by boundary item id: the name each
    // has on the subgraph node, for the mark on its fields.
    const markLabels = new Map<string, string>()
    const slotsOf = (items: readonly BoundaryItem[], side: 'inputs' | 'outputs'): BoundarySlotInfo[] => {
      const defaults = defaultBoundaryLabels(items)
      const roles = ownerNode?.region === undefined ? undefined : regionBoundaryLabels(items, ownerNode.region, side)
      return items.map((item) => {
        const spec =
          side === 'inputs'
            ? derivedInputs.find((s) => s.id === item.id)
            : derivedOutputs.find((s) => s.id === item.id)
        const label = boundaryLabel(item, spec?.displayName, defaults, roles)
        const fields = side === 'inputs' ? outsideRows.get(item.id) : undefined
        // A value source's field has no wire either: the pill has only an
        // output, and the row's pin cannot start one (boundary.addBinding
        // fans out port bindings only).
        const pinless = side === 'inputs' && (item.wireHidden === true || item.binds.kind === 'valueSource' && fields !== undefined)
        if (pinless) markLabels.set(item.id, label)
        return {
          id: item.id,
          label,
          ...(spec !== undefined ? { type: spec.type } : {}),
          ...(spec?.kind === 'input' && spec.acceptsList ? { acceptsList: true as const } : {}),
          ...(fields !== undefined ? { fields: pinless ? fields.map((field, index) => index === 0 ? { ...field, subgraphMark: { item: item.id, label } } : field) : fields } : {}),
          ...(pinless ? { pinless: true as const } : {}),
        }
      })
    }

    const regionIndexSlots: BoundarySlotInfo[] = ownerNode?.region === undefined ? [] : [{
      id: REGION_INDEX_SLOT,
      label: 'Index',
      type: { kind: 'concrete', name: 'INT' },
      regionIndex: true,
    }]
    const inputsLayout = layoutBoundaryNode('inputs', [...slotsOf(def.boundary.inputs, 'inputs'), ...regionIndexSlots], input.tokens, measure, fieldsSubtitle)
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
      maxX = canvasPaintTokens.scene.emptyGraphWidth
      minY = 0
    }
    const BOUNDARY_GAP = canvasPaintTokens.scene.boundaryGap
    const viewBoundary = graphView?.boundary
    const inputsPos = viewBoundary?.inputs?.position ?? { x: minX - BOUNDARY_GAP - inputsLayout.width, y: minY }
    const outputsPos = viewBoundary?.outputs?.position ?? { x: maxX + BOUNDARY_GAP, y: minY }
    const inputsNode: SceneBoundaryNode = {
      side: 'inputs', x: inputsPos.x, y: inputsPos.y, layout: inputsLayout,
      ...(outsideRows.size > 0 ? { fields: { node: fieldNode, wired: wiredFields,
        heads: Object.fromEntries([...outsideRows].map(([itemId, rows]) => [itemId, rows[0]!.valueKey])) } } : {}),
    }
    const outputsNode: SceneBoundaryNode = { side: 'outputs', x: outputsPos.x, y: outputsPos.y, layout: outputsLayout }
    boundaryNodes.push(inputsNode, outputsNode)

    const regionIndexPin = inputsLayout.pins.find((pin) => pin.regionIndex === true)
    if (regionIndexPin !== undefined) {
      for (const c of connections) {
        if (!isPortEndpoint(c.from) || c.from.node !== DINKSTER_REGION_PSEUDO_NODE || c.from.port !== 'index') continue
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
          typeName: 'INT',
          ...(c.effectiveIdentity !== undefined ? { effectiveIdentity: c.effectiveIdentity } : {}),
        })
      }
    }

    // Junction attachments bind at the retained dot, not their schema authority.
    // Other 'port' and 'widgetTap' bindings bind at the exact inner pin.
    const innerAnchor = (
      binds: BoundaryItem['binds'],
      direction: 'in' | 'out',
    ): { x: number; y: number; end: Extract<SceneLinkEnd, { kind: 'port' | 'widgetTap' | 'reroute' | 'valueSource' }> } | undefined => {
      if (binds.kind === 'unbound') return undefined
      if (binds.kind === 'valueSource') {
        const source = valueSourceById.get(binds.valueSource)
        if (direction !== 'out' || source === undefined) return undefined
        return { ...valueSourcePinPosition(source), end: { kind: 'valueSource', valueSource: source.id } }
      }
      if (binds.viaReroute !== undefined) {
        const reroute = direction === 'in' ? rerouteById.get(binds.viaReroute) : undefined
        return reroute && { x: reroute.x, y: reroute.y, end: { kind: 'reroute', reroute: reroute.id } }
      }
      const node = byId.get(binds.node)
      if (!node) return undefined
      const edgeX = direction === 'out' ? node.x + node.layout.width : node.x
      if (binds.kind === 'widgetTap') {
        if (direction !== 'out') return undefined
        const pin = node.layout.pins.find((candidate) => candidate.widgetTap === true && candidate.address.port === binds.tap)
        return pin === undefined
          ? undefined
          : { x: node.x + node.layout.width, y: node.y + pin.y, end: { kind: 'widgetTap', node: binds.node, input: binds.tap } }
      }
      const end: Extract<SceneLinkEnd, { kind: 'port' }> = {
        kind: 'port',
        node: binds.node,
        port: binds.port,
      }
      const key = binds.port
      // Real port only: excludes the same-id widget tap pin (see the
      // endpoint resolver above).
      const pin = node.layout.pins.find((p) => p.direction === direction && p.portId === key && p.widgetTap !== true)
      if (!pin) return undefined
      return { x: edgeX, y: node.y + pin.y, end }
    }

    const boundaryPin = (bnode: SceneBoundaryNode, itemId: string): { x: number; y: number } | undefined => {
      const pin = bnode.layout.pins.find((p) => p.portId === itemId)
      if (!pin) return undefined
      return { x: bnode.side === 'inputs' ? bnode.x + bnode.layout.width : bnode.x, y: bnode.y + pin.y }
    }

    const projectedAnchors = (
      direction: 'in' | 'out', item: BoundaryItem, binding: BoundaryItem['binds'],
    ): readonly {
      readonly anchor: NonNullable<ReturnType<typeof endPoint>> & { readonly end: Extract<SceneLinkEnd, { kind: 'port' | 'widgetTap' | 'reroute' | 'valueSource' }> }
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
          (direction === 'in' && !isPortEndpoint(resolved.endpoint) && !isRerouteRef(resolved.endpoint)) ||
          (direction === 'out' && !isPortEndpoint(resolved.endpoint) && !isWidgetTapRef(resolved.endpoint) && !isValueSourceRef(resolved.endpoint))
        ) continue
        const key = JSON.stringify(resolved.endpoint)
        const group = grouped.get(key) ?? { endpoint: resolved.endpoint, identities: [] }
        group.identities.push(projected.identity)
        grouped.set(key, group)
      }
      return [...grouped.values()].flatMap((group) => {
        const anchor = endPoint(group.endpoint, direction)
        return anchor?.end.kind === 'port' || anchor?.end.kind === 'widgetTap' || anchor?.end.kind === 'reroute' || anchor?.end.kind === 'valueSource'
          ? [{ anchor: { ...anchor, end: anchor.end }, identities: group.identities }]
          : []
      })
    }

    // A row drawn without its wire keeps its bindings as hidden links, so
    // each inner field still reads as driven by the boundary; they start
    // at the panel row, which has no pin.
    const pinlessRowAnchor = (itemId: string): { x: number; y: number } | undefined => {
      const head = inputsNode.fields?.heads[itemId]
      const row = inputsNode.layout.rows.find((candidate) =>
        candidate.kind === 'widget' ? head !== undefined && candidate.valueKey === head : candidate.kind === 'ports' && candidate.output?.portId === itemId)
      return row === undefined ? undefined : { x: inputsNode.x + inputsNode.layout.width, y: inputsNode.y + row.y + input.tokens.rowHeight / 2 }
    }
    for (const item of def.boundary.inputs) {
      const from = item.wireHidden === true ? pinlessRowAnchor(item.id) : boundaryPin(inputsNode, item.id)
      if (!from) continue
      const pinType = inputsNode.layout.pins.find((p) => p.portId === item.id)?.type
      const typeName = pinType === undefined ? undefined : canonicalTypeIdOf(pinType)
      // One noodle per binding: fan-out targets render exactly like the
      // primary (the boundary pin fans out to every bound inner input).
      const bindings = [item.binds, ...(item.alsoBinds ?? [])]
      bindings.forEach((b, i) => {
        const projected = projectedAnchors('in', item, b)
        const fallback = innerAnchor(b, 'in')
        const targets = projected.length > 0 ? projected : fallback === undefined ? [] : [{ anchor: fallback, identities: [] }]
        targets.forEach(({ anchor: to, identities }, aliasIndex) => {
          if (to.end.kind === 'valueSource') return
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
            ...(item.wireHidden === true ? { hidden: true as const } : {}),
            ...(identities.length === 1 ? { effectiveIdentity: identities[0] } : {}),
            ...(identities.length > 0 ? { effectiveIdentities: identities } : {}),
          })
        })
      })
    }
    // The inner fields of an input drawn without its wire carry the mark.
    for (const item of def.boundary.inputs) {
      const label = markLabels.get(item.id)
      if (label === undefined) continue
      for (const b of [item.binds, ...(item.alsoBinds ?? [])]) {
        // A value source's pill carries it while a node is entered, the
        // pill then showing the value that node's field sends.
        if (b.kind === 'valueSource') {
          const index = valueSources.findIndex((vs) => vs.id === b.valueSource && vs.arriving !== undefined && vs.subgraphMark === undefined)
          if (index >= 0) valueSources[index] = { ...valueSources[index]!, subgraphMark: { item: item.id, label } }
          continue
        }
        if (b.kind !== 'port') continue
        const index = nodes.findIndex((candidate) => candidate.id === b.node)
        const target = nodes[index]
        if (target === undefined) continue
        const rows = target.layout.rows.map((row) => row.kind === 'widget' && row.address.port === b.port
          ? { ...row, subgraphMark: { item: item.id, label } } : row)
        nodes[index] = { ...target, layout: { ...target.layout, rows } }
      }
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
            })
          : item.binds.kind === 'widgetTap'
            ? widgetTapTypeName(item.binds.node, item.binds.tap)
          : undefined
      const typeName = traced ?? (pinType === undefined ? undefined : canonicalTypeIdOf(pinType))
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
          ...(identities.length === 1 ? { effectiveIdentity: identities[0] } : {}),
          ...(identities.length > 0 ? { effectiveIdentities: identities } : {}),
        })
      })
    }
  }

  const result: Scene = {
    graphId: input.graphId, nodes, links, reroutes, valueSources, selectors, netStubs, groups, boundaryNodes,
    diagnostics: [...solverDiagnostics, ...(effective?.diagnostics ?? []), ...automaticDiagnostics],
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
 * noodle stays attached. Keyed/deduped by flattened port id, document order.
 */
function missingConnections(
  def: GraphDef,
  nodeId: string,
): { inputs: PortRef[]; outputs: PortRef[]; taps: string[] } {
  const ins = new Map<string, PortRef>()
  const outs = new Map<string, PortRef>()
  const taps = new Set<string>()
  const mark = (map: Map<string, PortRef>, ref: PortRef): void => {
    if (ref.node === nodeId && !map.has(ref.port)) map.set(ref.port, ref)
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
        if (b.kind === 'port') mark(ins, { node: b.node, port: b.port })
      }
    }
    for (const item of def.boundary.outputs) {
      const b = item.binds
      if (b.kind === 'port') mark(outs, { node: b.node, port: b.port })
      else if (b.kind === 'widgetTap' && b.node === nodeId) taps.add(b.tap)
    }
  }
  return { inputs: [...ins.values()], outputs: [...outs.values()], taps: [...taps] }
}

/** Safe single-line preview of a stored JSON value for fallback rows. */
function fallbackValueText(value: Json | undefined): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  const limit = canvasPaintTokens.scene.fallbackValueMaxCharacters
  return s.length > limit ? `${s.slice(0, limit - 1)}...` : s
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
  const rows: LayoutRow[] = []
  const pins: PinLayout[] = []
  let y = tokens.headerHeight
  let contentWidth = measure(title, titleRenamed ? 'renamedTitle' : 'title') + TITLE_START + tokens.padX + canvasPaintTokens.node.titleWidthPadding

  const pairs = Math.max(connections.inputs.length, connections.outputs.length)
  for (let i = 0; i < pairs; i++) {
    const inRef = connections.inputs[i]
    const outRef = connections.outputs[i]
    const height = tokens.rowHeight
    const input = inRef === undefined ? undefined : {
      portId: inRef.port,
      label: inRef.port,
      type: unknownType,
      address: { port: inRef.port },
    }
    const output = outRef === undefined ? undefined : {
      portId: outRef.port,
      label: outRef.port,
      type: unknownType,
      address: { port: outRef.port },
      index: i,
    }
    rows.push({ kind: 'ports', y, height, ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}) })
    if (input !== undefined) pins.push({ portId: input.portId, label: input.label, direction: 'in', y: y + height / 2, type: unknownType, address: input.address })
    if (output !== undefined) pins.push({ portId: output.portId, label: output.label, direction: 'out', y: y + height / 2, type: unknownType, address: output.address })
    contentWidth = Math.max(
      contentWidth,
      tokens.padX * 2 +
        (input !== undefined ? measure(input.label, 'label') + tokens.pinRadius + canvasPaintTokens.node.missing.portLabelPadding : 0) +
        (output !== undefined ? measure(output.label, 'label') + tokens.pinRadius + canvasPaintTokens.node.missing.portLabelPadding : 0) +
        canvasPaintTokens.node.missing.pairedPortGap,
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
    contentWidth = Math.max(contentWidth, tokens.padX * 2 + measure(tap, 'label') + tokens.pinRadius + canvasPaintTokens.node.missing.tapLabelPadding)
    y += height
  }
  for (const [key, value] of Object.entries(node.values ?? {})) {
    const text = fallbackValueText(value)
    rows.push({ kind: 'fallback', y, height: tokens.rowHeight, label: key, text })
    contentWidth = Math.max(
      contentWidth,
      tokens.padX * 2 + measure(key, 'label') + canvasPaintTokens.node.widgetLabelPadding + measure(text, 'value'),
    )
    y += tokens.rowHeight
  }

  // Rows never compress: manual sizes clamp to the natural row stack.
  const stackInsets = insetRowStack(rows, pins, tokens)
  const minHeight = Math.max(tokens.headerHeight + tokens.rowHeight + tokens.padBottom, y + stackInsets.top + stackInsets.bottom)
  const naturalWidth = Math.min(tokens.nodeMaxAutoWidth, Math.max(tokens.nodeMinWidth, contentWidth))
  const width = sizeOverride ? Math.max(tokens.nodeMinWidth, sizeOverride.width) : naturalWidth
  if (minimized) {
    // Minimizing only hides the body: the node keeps its open width.
    const height = tokens.headerHeight + tokens.padBottom
    return {
      width,
      height,
      minWidth: tokens.nodeMinWidth,
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
    width,
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

export function structuralEqual(a: unknown, b: unknown): boolean {
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
