/**
 * Interaction controller. Framework-free: translates pointer gestures
 * over the canvas into document COMMANDS (via the host) plus ephemeral
 * overlay state (selection, drag offsets, ghost link) that never touches the
 * document. Gesture interception is explicit: every pointerdown resolves one
 * hit and claims one gesture; nothing else sees it.
 *
 * Gestures:
 * - empty: drag = pan (Ctrl+drag = marquee select); click = clear selection
 * - header/body: click = select (Ctrl toggles, Shift adds the connected
 *   range); drag = move selection, ONE move command on release
 * - out pin: drag = new link, ghost + compatible input pins highlighted
 * - in pin (free): drag = new link seeking an output
 * - fresh link drag dropped on EMPTY canvas: host.onLinkDropOnEmpty
 *   (compatible-node search); rewires dropped on empty still disconnect
 * - in pin (connected): drag = grab the existing link; drop on an input =
 *   link.rewire (one undo step), drop on nothing = link.disconnect
 * - Shift+drag on a connected input = fresh replacement candidate; the old
 *   driver remains until a legal output drop atomically replaces it
 * - widget row: click = host.onWidgetActivate (expand/edit lives above)
 * - section header: click = toggle collapse, ONE view.setSectionCollapsed
 * - link body: click = select link (shift toggles); deletion lives above
 * - reroute dot: click = select (shift toggles); drag = move selection, ONE
 *   reroute.move on release; Alt+drag = new link FROM the junction
 * - reroute hover: reveals ghost sockets left (input) and right (output) of
 *   the dot; dragging the right socket pulls a new link FROM the junction
 *   (same as Alt+drag, but discoverable), dragging the left one seeks a
 *   producer INTO it (link.connect replaces any existing driver)
 * - out-pin/reroute drags accept reroute dots as drop targets (set driver /
 *   fan out); in-pin drags accept reroutes as sources
 * - node border: drag any corner/edge = ghost preview, ONE atomic
 *   view.setNodeSize (position + size) on release
 * - double-click on a link: ask the host for reroute vs node-splice menu
 * - double-click on a subgraph node: host.onOpenSubgraph
 * - double-click on an ordinary node: toggle minimized state for its selection
 * - double-click on empty canvas: host.onOpenPalette
 * - right-click: select the item under the cursor (preserving an existing
 *   multi-selection that contains it), then host.onContextMenu
 * - wheel: configured cursor-anchored zoom or two-axis pan
 */

import {
  canonicalTypeIdOf,
  hasKnownLinkDropAnchorType,
  isIntegerWidgetValue,
  numericStepConstraints,
  stepNumericValue,
  typesCompatible,
  type CommandInvocation,
  type DynamicMemberId,
  type Json,
  type JsonObject,
  type MaterializeFrame,
  type EffectiveLinkIdentity,
  type LinkEndpoint,
  type OccurrenceLinkEndpoint,
  type TypeExpr,
  type WidgetSpec,
} from '@dinkster/core'
import { hitTestBadge, type BadgeHit, type BadgeRect, type NodeBadge } from './badges.js'
import { controllerChipContains, WIDGET_EDGE_CONTROL_WIDTH } from './controller-chip.js'
import { hitTestToolbox, insideToolbox, type ToolboxButtonRect } from './toolbox.js'
import { hitTest, hitTestRerouteRevealZone, hoveredNodeAt, pinPosition, PIN_HIT_RADIUS, type Hit, type HitOptions, type ResizeHandle } from './hit.js'
import { BOUNDARY_ADD_SLOT, type PinLayout } from './layout.js'
import { PointerTrace, type PointerTraceEntry, type PointerTraceReason } from './pointer-trace.js'
import { touchNavViewport } from './touch-nav.js'
import { wheelNavigationViewport, type WheelNavigationMode } from './zoom.js'
import {
  boundaryTargetKey,
  dropTargetKey,
  rerouteTargetKey,
  selectorInTargetKey,
  selectorOutTargetKey,
  valueSourceTargetKey,
  type CanvasRenderer,
  type GhostLink,
  type PlacementGhost,
  previewSurfaceAffordanceRect,
  widgetRowAffordanceRect,
} from './renderer.js'
import {
  boundarySceneId,
  boundaryNodesInGroup,
  nodesInGroup,
  reroutesInGroup,
  sceneEndId,
  valueSourcesInGroup,
  selectorsInGroup,
  portEndKey,
  selectorBadgeRect,
  selectorOutPinPosition,
  valueSourceBadgeRect,
  valueSourcePinPosition,
  type Scene,
  type SceneBoundaryNode,
  type SceneLink,
  type SceneLinkEnd,
  type SceneNode,
  type OccurrenceLinkIntention,
  type SceneReroute,
  type SceneSelector,
  type SceneValueSource,
} from './scene.js'

/** Screen-space distance before a press becomes a drag. */
const DRAG_THRESHOLD = 4

/** Two Chromium pointer-coordinate quanta, expressed in CSS pixels. */
const POINTER_COORDINATE_TOLERANCE_PX = 2 / 65_536

/** Smallest width/height a group can be resized to (world units). */
const GROUP_MIN_SIZE = 60

/** The `MouseEvent.buttons` bit for a `MouseEvent.button` value. */
const buttonsBit = (button: number): number =>
  button === 0 ? 1 : button === 1 ? 4 : button === 2 ? 2 : button === 3 ? 8 : button === 4 ? 16 : 0

/** Gestures that carry positional work a missed release should complete. */
const isMoveFamilyKind = (kind: Gesture['kind']): boolean =>
  kind === 'node' ||
  kind === 'reroute-move' ||
  kind === 'value-source-move' ||
  kind === 'selector-move' ||
  kind === 'boundary-move' ||
  kind === 'group' ||
  kind === 'group-resize' ||
  kind === 'resize'

export interface ResizeBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Resize with the opposite edges anchored, clamping the moving edges. */
export function resizedNodeBounds(
  start: ResizeBounds,
  anchorX: number,
  anchorY: number,
  movingX: number,
  movingY: number,
  handle: ResizeHandle,
  minW: number,
  minH: number,
): ResizeBounds {
  const left = handle.includes('w') ? Math.min(movingX, anchorX - minW) : start.x
  const top = handle.includes('n') ? Math.min(movingY, anchorY - minH) : start.y
  const right = handle.includes('e') ? Math.max(movingX, anchorX + minW) : start.x + start.width
  const bottom = handle.includes('s') ? Math.max(movingY, anchorY + minH) : start.y + start.height
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** How modifiers reinterpret a regular document link grabbed at its input. */
export type ConnectedInputDragMode = 'rewire' | 'fan-out' | 'replace-candidate'

/** Shared modifier interpretation for every real or pseudo link endpoint. */
export type EndpointDragMode = 'fresh' | 'rewire' | 'fan-out' | 'replace-candidate' | 'move-source'

export function endpointDragMode(
  direction: 'in' | 'out',
  connected: boolean,
  shift: boolean,
  alt = false,
): EndpointDragMode {
  if (!connected) return 'fresh'
  if (direction === 'out') return shift ? 'move-source' : 'fresh'
  if (alt) return 'fan-out'
  if (shift) return 'replace-candidate'
  return 'rewire'
}

/**
 * Resolve connected-input modifiers in one testable place. Alt deliberately
 * wins when both keys are held because its established "reuse this driver"
 * gesture must not silently turn into Shift's "replace this driver" gesture.
 */
export function connectedInputDragMode(shift: boolean, alt: boolean): ConnectedInputDragMode {
  return endpointDragMode('in', true, shift, alt) as ConnectedInputDragMode
}

/**
 * Nodes and reroutes lying on any directed path between the current node
 * selection and `clicked`, considering both possible path directions. The two
 * multi-source reachability passes stay linear in scene vertices plus links.
 */
export function connectivityRangeSelection(
  scene: Scene,
  selected: ReadonlySet<string>,
  clicked: string,
): { nodes: Set<string>; reroutes: Set<string> } | undefined {
  const endpoints = [...selected].filter((id) => id !== clicked)
  if (endpoints.length === 0) return undefined
  const forward = new Map<string, string[]>()
  const reverse = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, from: string, to: string) => {
    const next = map.get(from)
    if (next) next.push(to)
    else map.set(from, [to])
  }
  for (const link of scene.links) {
    const from = sceneEndId(link.from)
    const to = sceneEndId(link.to)
    add(forward, from, to)
    add(reverse, to, from)
  }
  const reach = (starts: Iterable<string>, edges: ReadonlyMap<string, readonly string[]>): Set<string> => {
    const seen = new Set(starts)
    const queue = [...seen]
    for (let i = 0; i < queue.length; i++) {
      for (const next of edges.get(queue[i]!) ?? []) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    return seen
  }
  const fromSelection = reach(endpoints, forward)
  const toSelection = reach(endpoints, reverse)
  const fromClicked = reach([clicked], forward)
  const toClicked = reach([clicked], reverse)
  const nodes = new Set(selected)
  const reroutes = new Set<string>()
  const onPath = (id: string) =>
    (fromSelection.has(id) && toClicked.has(id)) ||
    (fromClicked.has(id) && toSelection.has(id))
  let hasPath = false
  for (const node of scene.nodes) {
    if (onPath(node.id)) {
      nodes.add(node.id)
      hasPath = true
    }
  }
  for (const reroute of scene.reroutes) {
    if (onPath(reroute.id)) reroutes.add(reroute.id)
  }
  return hasPath ? { nodes, reroutes } : undefined
}

/** A structural port endpoint for command params (document identity, never an elab key). */
interface PortEndpointJson extends JsonObject {
  readonly node: string
  readonly port: string
  readonly members?: readonly DynamicMemberId[]
}

interface WidgetTapEndpointJson extends JsonObject {
  readonly node: string
  readonly tap: string
}

type BoundaryEndpointJson = PortEndpointJson | WidgetTapEndpointJson

/** A pending dynamic.materialize for one node, batched with the gesture's command. */
export interface MaterializeStep {
  readonly nodeId: string
  readonly frames: readonly MaterializeFrame[]
}

/**
 * A fresh link drag released over EMPTY canvas: everything the host needs
 * to finish the connection after the user picks a node from the palette.
 * `seeking` names what the dragged end was looking for ('in' = the fixed
 * end is a source of `anchorType`; 'out' = the fixed end is an input).
 * Exactly one of fixedFrom/fixedInto is present, as a structural link
 * endpoint ready for link.connect params; fixedMaterialize (when present)
 * must ride the SAME batch as the connect (hazard N3: the fixed end is a
 * synthetic ghost/min-fill pin).
 */
export interface LinkDropContext {
  readonly seeking: 'in' | 'out'
  readonly anchorType: TypeExpr
  readonly anchorTypeName?: string
  /** Fixed endpoint's world position - lets the host keep the dropped
   * noodle rendered (via setPaletteGhost) while its palette is open. */
  readonly anchorX: number
  readonly anchorY: number
  /** Source end of the eventual link (present when seeking 'in'). */
  readonly fixedFrom?: JsonObject
  /** Destination end of the eventual link (present when seeking 'out'). */
  readonly fixedInto?: JsonObject
  readonly fixedMaterialize?: MaterializeStep
}

/** Existing ordinary link double-clicked at a splice position. */
export interface LinkDoubleClickContext {
  readonly linkId: string
  readonly position: { readonly x: number; readonly y: number }
  readonly fromType: TypeExpr
  readonly toType: TypeExpr
  readonly fixedFrom: JsonObject
  readonly fixedInto: JsonObject
}

/** One payload builder for midpoint click and whole-noodle double-click. */
function linkMenuContext(link: SceneLink, position: { x: number; y: number }): LinkDoubleClickContext {
  const snap = (v: number) => Math.round(v * 100) / 100
  const endpoint = (end: SceneLinkEnd): JsonObject => {
    switch (end.kind) {
      case 'port': return { node: end.node, port: end.port, ...(end.members ? { members: [...end.members] } : {}) }
      case 'reroute': return { reroute: end.reroute }
      case 'valueSource': return { valueSource: end.valueSource }
      case 'widgetTap': return { node: end.node, tap: end.input }
      case 'selector': return { selector: end.selector, ...(end.candidate ? { candidate: end.candidate } : {}) }
      case 'boundary': return { boundary: end.side, item: end.item }
    }
  }
  return {
    linkId: link.id,
    position: { x: snap(position.x), y: snap(position.y) },
    fromType: link.fromType ?? { kind: 'wildcard' },
    toType: link.toType ?? { kind: 'wildcard' },
    fixedFrom: endpoint(link.from),
    fixedInto: endpoint(link.to),
  }
}

/** A pin's structural endpoint, from its elaborated address (hazard N6: never parse elab keys). */
const pinEndpoint = (nodeId: string, pin: PinLayout): PortEndpointJson => ({
  node: nodeId,
  port: pin.address.port as string,
  ...(pin.address.members !== undefined ? { members: pin.address.members } : {}),
})

/** The pin's pending materialization, when it (or an ancestor) is synthetic. */
const pinMaterialize = (nodeId: string, pin: PinLayout): MaterializeStep | undefined =>
  pin.materialize !== undefined ? { nodeId, frames: pin.materialize } : undefined

/**
 * Wrap a command with the dynamic.materialize steps it depends on: a plain
 * invocation when nothing is synthetic, else ONE batch so materialization is
 * atomic with its cause (one undo step; a rejected connect materializes
 * nothing).
 */
function withMaterialize(
  graphId: string,
  steps: readonly (MaterializeStep | undefined)[],
  action: CommandInvocation,
): CommandInvocation {
  const real = steps.filter((s): s is MaterializeStep => s !== undefined)
  if (real.length === 0) return action
  return {
    command: 'batch',
    params: {
      invocations: [
        ...real.map((s) => ({
          command: 'dynamic.materialize',
          params: {
            graphId,
            nodeId: s.nodeId,
            frames: s.frames.map((f) => ({ construct: f.construct, members: [...f.members] })),
          },
        })),
        { command: action.command, params: action.params },
      ],
    },
  } as CommandInvocation
}

/**
 * Compose materialize steps + main ops + trailing dynamic.compact passes
 * into one invocation (a plain one when only a single op remains). Compact
 * rides the SAME batch as the edit that freed the member, so undo restores
 * both the exact endpoint identity and its connection.
 */
function composeBatch(
  graphId: string,
  steps: readonly (MaterializeStep | undefined)[],
  ops: readonly CommandInvocation[],
  compactNodes: readonly string[] = [],
): CommandInvocation {
  const real = steps.filter((s): s is MaterializeStep => s !== undefined)
  // Plain {command, params} literals (not the CommandInvocation interface)
  // so the batch params stay structurally Json - same trick as withMaterialize.
  const invocations = [
    ...real.map((s) => ({
      command: 'dynamic.materialize',
      params: {
        graphId,
        nodeId: s.nodeId,
        frames: s.frames.map((f) => ({ construct: f.construct, members: [...f.members] })),
      },
    })),
    ...ops.map((op) => ({ command: op.command, params: op.params })),
    ...[...new Set(compactNodes)].map((nodeId) => ({
      command: 'dynamic.compact',
      params: { graphId, nodeId },
    })),
  ]
  if (invocations.length === 1) return invocations[0]! as CommandInvocation
  return { command: 'batch', params: { invocations } } as CommandInvocation
}

export interface InteractionHost {
  /** Dispatch a document command. The controller only needs commit/reject. */
  dispatch(invocation: CommandInvocation): { readonly ok: boolean }
  /** Current wheel policy; omitted hosts retain cursor-anchored zoom. */
  wheelNavigationMode?(): WheelNavigationMode
  /** Plan and dispatch one drilled occurrence mutation through the injected capability. */
  dispatchOccurrenceMutation?(intention: OccurrenceLinkIntention): { readonly ok: boolean }
  /** Report an occurrence gesture that cannot be represented atomically. */
  onOccurrenceMutationRefused?(code: string, message: string): void
  /** Resolve the same intrinsic value a registry-backed compact view paints. */
  resolveWidgetDefault?(spec: WidgetSpec): Json | undefined
  /** Report a producer used on a boundary side that cannot represent it. */
  onBoundaryExposureRefused?(
    code: 'boundary.structuralProducerUnsupported',
    source: BoundaryExposureSource,
    side: 'inputs' | 'outputs',
  ): void
  onSelectionChange?(
    nodes: ReadonlySet<string>,
    links: ReadonlySet<string>,
    reroutes: ReadonlySet<string>,
    valueSources: ReadonlySet<string>,
    selectors: ReadonlySet<string>,
    groups: ReadonlySet<string>,
  ): void
  /** Click on a widget row; screen coords anchor an editor overlay. */
  onWidgetActivate?(hit: Extract<Hit, { kind: 'widget' }>, screenX: number, screenY: number): void
  /** Click on the active lens's registered widget-row affordance. */
  onWidgetRowAffordanceActivate?(hit: Extract<Hit, { kind: 'widget' }>): void
  /** Click on the active lens's preview-surface affordance. */
  onPreviewSurfaceAffordanceActivate?(node: SceneNode): void
  /** Click on an after-generate icon chip; the host owns its DOM menu. */
  onControllerActivate?(hit: Extract<Hit, { kind: 'widget' }>, screenX: number, screenY: number): void
  /** Double-click on a subgraph instance node. */
  onOpenSubgraph?(node: SceneNode): void
  /** Double-click on empty canvas: open the add-node palette here. */
  onOpenPalette?(worldX: number, worldY: number, screenX: number, screenY: number): void
  /**
   * A FRESH link drag (never a rewire - those disconnect) released over
   * empty canvas: open the compatible-node search there. The context
   * carries the fixed end so the host can commit insert + connect as one
   * batch after the pick.
   */
  onLinkDropOnEmpty?(context: LinkDropContext, worldX: number, worldY: number): void
  /** Double-click on an ordinary link; the host chooses reroute vs node splice. */
  onLinkDoubleClick?(context: LinkDoubleClickContext, screenX: number, screenY: number): void
  /**
   * Right-click. Selection is already adjusted (see the class doc); the host
   * resolves menu contributions and renders the overlay. screenX/screenY are
   * client coordinates.
   */
  onContextMenu?(hit: Hit, worldX: number, worldY: number, screenX: number, screenY: number): void
  /**
   * Click on a node header badge (error chip, subgraph marker, ...). Badges
   * claim the pointerdown BEFORE any other gesture, so a badge click never
   * selects or drags. `rect` is the badge's world-space rect (popover anchor).
   */
  onBadgeClick?(node: SceneNode, badge: NodeBadge, rect: BadgeRect): void
  /**
   * Click on a selection-toolbox button. The toolbox claims the pointerdown
   * BEFORE any other gesture (like badges), so a button click never starts
   * a drag or changes the selection it acts on.
   */
  onToolboxAction?(button: ToolboxButtonRect): void
  /** Toolbox button under the idle pointer, or undefined after hover-off. */
  onToolboxHover?(button: ToolboxButtonRect | undefined): void
  /** Semantic target under the idle pointer, with client-space anchor. */
  onHoverTarget?(target: CanvasHoverTarget | undefined): void
  /**
   * Live drag offsets while a move gesture is in progress, undefined when it
   * ends (commit or cancel). Fires only on change; presence egress rides it.
   */
  onDragOffsets?(offsets: ReadonlyMap<string, { readonly dx: number; readonly dy: number }> | undefined): void
  /** Semantic fixed endpoint of an active link drag, or undefined on end. */
  onLinkDragPresence?(origin: LinkDragPresenceOrigin | undefined): void
  /**
   * The node under the idle pointer changed (undefined on hover-off or when
   * the hovered node leaves the scene). Fires only on change; unlike
   * onHoverTarget this is the plain node identity - presence egress rides it.
   */
  onNodeHover?(nodeId: string | undefined): void
  /** Click (no drag) on a value source pill: open its value editor. */
  onValueSourceActivate?(valueSource: SceneValueSource, screenX: number, screenY: number): void
  /** Double-click a boundary pseudo-node pin/row: host opens a rename prompt. */
  onBoundaryRenameRequest?(side: 'inputs' | 'outputs', itemId: string, screenX: number, screenY: number): void
  /**
   * Click on a value source's spec badge (declared/derived/conflict details).
   * Claims the pointerdown like node badges do; `rect` anchors a popover.
   */
  onValueSourceBadgeClick?(
    valueSource: SceneValueSource,
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  ): void
  /**
   * Click on a selector's policy badge (fixed/random details + actions).
   * Claims the pointerdown like node badges do; `rect` anchors a popover.
   */
  onSelectorBadgeClick?(
    selector: SceneSelector,
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  ): void
}

export type BoundaryExposureSource =
  | { readonly kind: 'widgetTap'; readonly node: string; readonly tap: string }
  | { readonly kind: 'valueSource' | 'selector' | 'reroute'; readonly id: string }

export type LinkDragPresenceOrigin =
  | { readonly kind: 'port'; readonly node: string; readonly port: string; readonly side: 'in' | 'out' }
  | { readonly kind: 'widgetTap'; readonly node: string; readonly input: string }
  | { readonly kind: 'reroute'; readonly reroute: string; readonly side: 'in' | 'out' }

export type CanvasHoverTarget =
  | { readonly kind: 'badge'; readonly hit: BadgeHit; readonly x: number; readonly y: number }
  | { readonly kind: 'pin'; readonly hit: Extract<Hit, { kind: 'pin' }>; readonly x: number; readonly y: number }
  | { readonly kind: 'widgetTap'; readonly hit: Extract<Hit, { kind: 'widgetTap' }>; readonly x: number; readonly y: number }
  | { readonly kind: 'widget'; readonly hit: Extract<Hit, { kind: 'widget' }>; readonly x: number; readonly y: number }
  | { readonly kind: 'controller'; readonly hit: Extract<Hit, { kind: 'widget' }>; readonly x: number; readonly y: number }
  | { readonly kind: 'header'; readonly hit: Extract<Hit, { kind: 'header' }>; readonly x: number; readonly y: number }
  | { readonly kind: 'reroute'; readonly hit: Extract<Hit, { kind: 'reroute' }>; readonly x: number; readonly y: number }
  | { readonly kind: 'link'; readonly hit: Extract<Hit, { kind: 'link' }>; readonly x: number; readonly y: number }
  | { readonly kind: 'toolbox'; readonly button: ToolboxButtonRect; readonly x: number; readonly y: number }

type Gesture =
  | { readonly kind: 'idle' }
  | {
      /** A selected noodle press, retained only to distinguish click from drag. */
      readonly kind: 'link-press'
      readonly linkId?: string
      readonly midpoint: boolean
      readonly modified: boolean
      moved: boolean
    }
  | {
      readonly kind: 'pan'
      lastX: number
      lastY: number
      moved: boolean
      /** Shift held at an empty-canvas press: a motionless click keeps the selection. */
      readonly keepSelection?: boolean
    }
  | {
      /**
       * Rubber-band selection from a Ctrl+drag on empty canvas (plain drags
       * pan). `additive` (Shift held at press) unions the sweep with the
       * existing selection rather than replacing it.
       */
      readonly kind: 'marquee'
      readonly startWX: number
      readonly startWY: number
      readonly additive: boolean
      moved: boolean
    }
  | {
      readonly kind: 'node'
      readonly nodeIds: readonly string[]
      readonly rerouteIds: readonly string[]
      readonly valueSourceIds: readonly string[]
      readonly selectorIds: readonly string[]
      readonly boundarySides: readonly ('inputs' | 'outputs')[]
      readonly groupIds: readonly string[]
      readonly netViewIds: readonly string[]
      readonly pressedValueSourceId?: string
      readonly startWX: number
      readonly startWY: number
      moved: boolean
    }
  | {
      readonly kind: 'link'
      /** Fixed semantic endpoint exposed to ephemeral multiplayer presence. */
      readonly presenceOrigin?: LinkDragPresenceOrigin
      /** Fixed end of the ghost noodle (world coords). */
      readonly anchor: { x: number; y: number }
      /** Which end the cursor drags: 'to' seeks inputs, 'from' seeks outputs. */
      readonly seeking: 'in' | 'out'
      /** Type at the fixed end, for compatibility highlighting. */
      readonly anchorType: TypeExpr
      readonly anchorTypeName?: string
      /** Fresh drag from an input pin: connect INTO this port on drop (structural: port + members). */
      readonly intoPort?: PortEndpointJson
      /** Fresh drag from an output pin: connect FROM this port on drop (structural: port + members). */
      readonly fromPort?: PortEndpointJson
      /** Fresh drag from a widget tap: connect FROM the tapped input value. */
      readonly fromTap?: { readonly node: string; readonly tap: string }
      /**
       * The fixed end is a synthetic (ghost/min-fill) pin: these frames must
       * dynamic.materialize in the SAME batch as the connect (hazard N3).
       */
      readonly fixedMaterialize?: MaterializeStep
      /** Fresh drag from a reroute junction: connect FROM it on drop. */
      readonly fromReroute?: string
      /** Fresh drag from a reroute's ghost input socket: connect INTO it on
       * drop (link.connect replaces any existing driver, core semantics). */
      readonly intoReroute?: string
      /** Fresh drag from a value source's output pin: connect FROM it on drop. */
      readonly fromValueSource?: string
      /** Fresh drag from a selector's output pin: connect FROM it on drop. */
      readonly fromSelector?: string
      /** Fresh drag from a free candidate input: connect INTO this branch on drop. */
      readonly intoSelector?: { readonly selector: string; readonly candidate: string }
      /** Rewire of an existing link (grabbed at its input end). */
      readonly rewireLinkId?: string
      /**
       * Rewire of a net delivery grabbed at its sink end (collapsed or
       * expanded). Net scene links carry synthetic ids that link.rewire and
       * link.disconnect reject, so drops dispatch net commands instead: a
       * port drop moves the sink membership, a reroute/selector drop detaches
       * the sink and connects an ordinary link from the net's source, and a
       * moved space drop just detaches the sink.
       */
      readonly netRewire?: {
        readonly netId: string
        readonly prev: PortEndpointJson
        readonly source?: PortEndpointJson
      }
      /**
       * A Shift-drag replacement candidate keeps the current input driver
       * intact. Unlike an ordinary fresh drag, an empty drop must not open
       * the palette because cancellation means exactly no change.
       */
      readonly preserveInputDriver?: boolean
      /**
       * Scene links hidden while this gesture drags: the ghost noodles ARE
       * those connections moving with the cursor. Distinct from rewireLinkId
       * because boundary rewires grab synthetic 'boundary:*' scene links that
       * never reach link.rewire/link.disconnect but still need hiding.
       */
      readonly hideLinkIds?: ReadonlySet<string>
      /**
       * Shift-grab of an output's whole fan-out: the cursor drags the shared
       * SOURCE end of every listed link; a legal drop re-sources them all in
       * one link.rewireSource transaction. `toEnds` are the fixed input-end
       * positions for the multi-noodle ghost.
       */
      readonly moveSource?: {
        readonly linkIds: readonly string[]
        readonly effectiveLinks?: readonly EffectiveLinkIdentity[]
        /**
         * Nets whose source pin is part of the grabbed fan-out: a legal drop
         * re-points each via net.setSource in the same batch as the
         * link.rewireSource of the ordinary links. Net scene link ids are
         * synthetic, so they never appear in linkIds.
         */
        readonly netIds?: readonly string[]
        readonly toEnds: readonly { readonly x: number; readonly y: number }[]
      }
      /**
       * Fresh drag FROM a boundary pseudo-node pin. `item` absent = the
       * blank "expose..." slot (drop creates a boundary item); present =
       * an existing item (inputs drop fans out, outputs drop re-points).
       */
      readonly boundarySource?: { readonly side: 'inputs' | 'outputs'; readonly item?: string }
      /**
       * Shift-grab of an inputs-side boundary item's whole binding fan-out
       * (the boundary mirror of an output pin's moveSource): the cursor
       * drags the shared source end of every binding noodle; a legal drop
       * on a real output unbinds them all and link.connects that output to
       * every freed sink in ONE batch. `toEnds` mirror moveSource's ghost
       * anchor positions.
       */
      readonly boundaryMoveSource?: {
        readonly item: string
        readonly sinks: readonly PortEndpointJson[]
        readonly toEnds: readonly { readonly x: number; readonly y: number }[]
      }
      /** The outputs-side item's current inner source (space-drop unbinds it). */
      readonly boundaryPrev?: BoundaryEndpointJson
      /**
       * Grabbed an existing boundary INPUT binding at its inner end: drop
       * re-points the binding (boundary commands), space-drop unbinds. The
       * synthetic 'boundary:*' link ids never reach link.disconnect.
       */
      readonly boundaryRewire?: {
        readonly item: string
        readonly prev: PortEndpointJson
        readonly prevIsPrimary: boolean
      }
      /** Shift replacement of a real input currently driven by a boundary item. */
      readonly boundaryInputReplacement?: {
        readonly item: string
        readonly prev: PortEndpointJson
      }
      readonly dropTargets: ReadonlySet<string>
      /** Per-layout auto-slot cache. Recomputed when the hovered SceneNode is replaced. */
      bodyCandidateNode?: SceneNode | undefined
      bodyCandidate?: Extract<Hit, { kind: 'pin' }> | undefined
      moved: boolean
    }
  | {
      readonly kind: 'reroute-move'
      readonly rerouteIds: readonly string[]
      readonly startWX: number
      readonly startWY: number
      moved: boolean
    }
  | {
      readonly kind: 'value-source-move'
      readonly valueSourceIds: readonly string[]
      /** The pressed pill: a click (no drag) activates its editor. */
      readonly pressedId: string
      readonly startWX: number
      readonly startWY: number
      moved: boolean
    }
  | {
      readonly kind: 'selector-move'
      readonly selectorIds: readonly string[]
      readonly startWX: number
      readonly startWY: number
      moved: boolean
    }
  | { readonly kind: 'widget'; readonly hit: Extract<Hit, { kind: 'widget' }>; moved: boolean }
  | { readonly kind: 'widget-affordance'; readonly hit: Extract<Hit, { kind: 'widget' }>; moved: boolean }
  | { readonly kind: 'preview-affordance'; readonly node: SceneNode; moved: boolean }
  | { readonly kind: 'section'; readonly hit: Extract<Hit, { kind: 'section' }>; moved: boolean }
  | { readonly kind: 'growth'; readonly hit: Extract<Hit, { kind: 'growth' }>; moved: boolean }
  | {
      readonly kind: 'resize'
      readonly nodeId: string
      readonly handle: ResizeHandle
      readonly start: ResizeBounds
      /** Opposite resize edges, captured once in world coordinates. */
      readonly anchorX: number
      readonly anchorY: number
      /** Moving edge minus pointer at press, so grabbing near an edge never jumps. */
      readonly grabOffsetX: number
      readonly grabOffsetY: number
      readonly minW: number
      readonly minH: number
      /** Difference between visible height and the document size request. */
      readonly heightOffset: number
      moved: boolean
    }
  | {
      readonly kind: 'group'
      readonly groupId: string
      /** Spatial membership captured at drag START; the drag carries these. */
      readonly memberIds: readonly string[]
      readonly rerouteIds: readonly string[]
      readonly valueSourceIds: readonly string[]
      readonly selectorIds: readonly string[]
      readonly boundarySides: readonly ('inputs' | 'outputs')[]
      readonly startWX: number
      readonly startWY: number
      moved: boolean
    }
  | {
      readonly kind: 'group-resize'
      readonly groupId: string
      readonly handle: ResizeHandle
      readonly start: ResizeBounds
      readonly anchorX: number
      readonly anchorY: number
      readonly grabOffsetX: number
      readonly grabOffsetY: number
      moved: boolean
    }
  | {
      /** Dragging a boundary pseudo-node; ONE view.moveBoundaryNode on release. */
      readonly kind: 'boundary-move'
      readonly side: 'inputs' | 'outputs'
      readonly startWX: number
      readonly startWY: number
      moved: boolean
    }

export class InteractionController {
  private selection = new Set<string>()
  private linkSelection = new Set<string>()
  private rerouteSelection = new Set<string>()
  private valueSourceSelection = new Set<string>()
  private selectorSelection = new Set<string>()
  private groupSelection = new Set<string>()
  private netViewSelection = new Set<string>()
  private selectionOwner: string | undefined
  private gesture: Gesture = { kind: 'idle' }
  /** The pointer that owns the active gesture; all other pointers are ignored
   * until it completes or cancels. Set whenever pointer capture is taken. */
  private activePointerId: number | undefined
  /** `buttons` bit of the button that started the active gesture: missed-
   * release recovery keys off whether that exact button is still held. */
  private activeButtonMask: number | undefined
  /** `pointerType` of the active gesture's pointer: the mouseup and wheel
   * recovery signals only apply to mouse/pen gestures. */
  private activePointerType: string | undefined
  /**
   * Last position of the owning pointer, tracked so a capture loss - which
   * carries no useful coordinates - can complete a move/resize-family
   * gesture where the user last saw it. WORLD coordinates are captured at
   * move time: the viewport can change between the last move and the loss
   * (wheel navigation, camera animation), and reprojecting a stale screen
   * point through the new viewport would commit somewhere the ghost never was.
   * Set at capture, updated per owning move, cleared on commit and cancel.
   */
  private lastGesturePoint: { wx: number; wy: number; cx: number; cy: number } | undefined
  /** Graph the active gesture was started on: a commit into any OTHER graph
   * would misattribute captured ids, so mismatches abort without dispatch. */
  private gestureGraphId: string | undefined
  /** Live touch pointers, tracked by id so a second finger can start
   * two-finger navigation from current positions. Entries update on every
   * touch move and drop on pointerup/pointercancel; blur and dispose clear
   * the map outright because their releases may never arrive. */
  private readonly touchPoints = new Map<number, { cx: number; cy: number }>()
  /** The two pointer ids driving two-finger pinch-zoom/pan navigation.
   * Navigation is not a Gesture: like wheel navigation it only moves the
   * viewport, so it never captures scene state and survives scene
   * replacement. While set, all other pointers are inert. */
  private touchNav: { a: number; b: number } | undefined
  /** Graph of the last installed scene: a change stales hover ids outright. */
  private lastSceneGraphId: string | undefined
  private downX = 0
  private downY = 0
  /** Space held: empty-canvas drags pan instead of marquee-selecting. */
  private spaceDown = false
  /** Host-owned persistent ghost: keeps a dropped noodle visible while the
   * compatible-node palette is open. Merged into every overlay push (an
   * active gesture's own ghost wins) until the host clears it. */
  private paletteGhost: GhostLink | undefined
  /** Host-owned pending node preview, preserved across every interaction overlay update. */
  private placementGhost: PlacementGhost | undefined
  /** The reroute whose ghost sockets are revealed: pointer idling anywhere
   * in its socket halo (dot, either socket, or between). Renderer paints the
   * sockets; pointerdown routes socket grabs into link gestures. Ephemeral -
   * never touches the scene. */
  private hoveredReroute: string | undefined
  /** Link midpoint under the idle pointer; enlarges its clickable handle. */
  private hoveredLinkMidpoint: string | undefined
  /** Last idle pointer position over the canvas, in client coordinates.
   * Lets refreshHover re-resolve hover after a scene replacement without
   * waiting for the next pointer move. Cleared when the pointer leaves. */
  private idlePointer: { clientX: number; clientY: number } | undefined
  /** The node under the idle pointer: reveals its widget-backed input pins
   * (normally hidden until connected or selected). Ephemeral overlay state. */
  private hoveredNode: string | undefined
  /** Detailed node-surface hover identities. Kept as primitives so repeated
   * pointer moves over one surface allocate nothing and trigger no repaint. */
  private hoveredPinNode: string | undefined
  private hoveredPinPort: string | undefined
  private hoveredPinDirection: 'in' | 'out' | undefined
  private hoveredPinWidgetTap: true | undefined
  private focusedPinNode: string | undefined
  private focusedPinPort: string | undefined
  private focusedPinDirection: 'in' | 'out' | undefined
  private focusedPinWidgetTap: true | undefined
  private hoveredWidgetNode: string | undefined
  private hoveredWidgetValue: string | undefined
  private hoveredToolboxButton: string | undefined
  /** A toolbox press can synchronously remove/move the toolbox before the
   * browser emits dblclick. Remember that press briefly so its dblclick can
   * never be reinterpreted as a graph-surface action. */
  private toolboxDblClickGuard:
    | { readonly clientX: number; readonly clientY: number; readonly expiresAt: number }
    | undefined
  /** Last drag-offset map handed to the host (identity-compared in
   * pushOverlay): lets presence egress see live node-drag offsets without
   * subscribing to every overlay churn. */
  private lastDragOffsets:
    | ReadonlyMap<string, { readonly dx: number; readonly dy: number }>
    | undefined
  private lastLinkDragPresence: LinkDragPresenceOrigin | undefined
  private readonly pointerTrace = new PointerTrace()
  private readonly detach: () => void

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly renderer: CanvasRenderer,
    private readonly host: InteractionHost,
  ) {
    this.lastSceneGraphId = renderer.getScene().graphId
    const onWheel = (e: WheelEvent) => this.onWheel(e)
    const onPointerDown = (e: PointerEvent) => {
      this.pointerTrace.recordPointer(e, false)
      // A press that contradicts the active gesture's held button recovers
      // the stale gesture FIRST, so this press starts fresh below instead of
      // being swallowed by the second-pointer guard.
      this.recoverRepressedGesture(e)
      const wasIdle = this.gesture.kind === 'idle'
      this.onPointerDown(e)
      if (wasIdle && this.gesture.kind !== 'idle')
        this.pointerTrace.recordGesture(this.gesture.kind, 'start', 'pointerdown')
      // A press that captured the pointer but started no gesture (badge
      // clicks, inert pins, failed link starts) must not retain ownership:
      // if its release is dropped, the missed-release recoveries all require
      // an active gesture, so stale ownership would swallow every later
      // press forever.
      if (this.gesture.kind === 'idle' && this.activePointerId === e.pointerId)
        this.cancelGesture()
    }
    const onPointerMove = (e: PointerEvent) => {
      this.pointerTrace.recordPointer(e, false)
      this.onPointerMove(e)
    }
    const onPointerUp = (e: PointerEvent) => {
      this.pointerTrace.recordPointer(e, false)
      this.onPointerUp(e)
    }
    // Safari can reject pointer capture (by throwing or by leaving capture
    // unset). Canvas-local listeners remain the fast path, while these
    // window fallbacks keep an owned gesture alive after the pointer leaves
    // the canvas. Captured events retarget to the canvas and are ignored here
    // so one physical event is never processed twice.
    const onWindowPointerMove = (e: PointerEvent) => {
      if (e.target !== canvas && this.ownsPointer(e.pointerId)) {
        this.pointerTrace.recordPointer(e, true)
        this.onPointerMove(e)
      }
    }
    const onWindowPointerUp = (e: PointerEvent) => {
      if (e.target !== canvas && this.ownsPointer(e.pointerId)) {
        this.pointerTrace.recordPointer(e, true)
        this.onPointerUp(e)
      }
    }
    const onDblClick = (e: MouseEvent) => this.onDblClick(e)
    const onContextMenu = (e: MouseEvent) => this.onContextMenu(e)
    // The pointer leaving the canvas can't hover anything on it.
    const onPointerLeave = () => {
      this.canvas.style.cursor = ''
      this.idlePointer = undefined
      this.setHover(undefined, undefined, undefined)
      this.setAffordanceHover(undefined)
      this.setLinkMidpointHover(undefined)
    }
    // Space is tracked at the window so it works without canvas focus, but
    // never while typing in a field (space must stay a space there).
    const isEditable = (t: EventTarget | null): boolean =>
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isEditable(e.target)) this.spaceDown = true
      // Escape aborts the gesture in place: no dispatch, ghosts dropped.
      if (e.code === 'Escape') this.cancelGesture('escape')
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') this.spaceDown = false
    }
    // Losing window focus mid-drag means the pointerup may never arrive
    // (alt-tab, dev tools, native dialogs): abort rather than strand a
    // gesture that would complete against a stale press.
    const onBlur = () => {
      this.spaceDown = false
      this.cancelGesture('blur')
      this.resetTouchTracking('blur')
    }
    // Desktop pointercancel is treated as a missed release: mouse and pen
    // commit moved move/resize gestures and moved links at the last tracked
    // point with ordinary empty-drop semantics. Touch and unknown pointer
    // types retain the strict takeover policy: links commit only over a legal
    // target and every other gesture cancels. Motionless presses always
    // cancel. Capture loss keeps its separate strict policy below.
    const handlePointerCancel = (e: PointerEvent) => {
      if (this.endTouchPointer(e, 'pointercancel-cancel')) return
      if (e.pointerId !== this.activePointerId) return
      const g = this.gesture
      const last = this.lastGesturePoint
      const desktop = e.pointerType === 'mouse' || e.pointerType === 'pen'
      if (
        desktop &&
        last !== undefined &&
        'moved' in g &&
        g.moved &&
        (g.kind === 'link' || isMoveFamilyKind(g.kind))
      ) {
        this.commitGesture(
          e.pointerId,
          { x: last.wx, y: last.wy },
          last.cx,
          last.cy,
          false,
          'pointercancel-release',
        )
      } else if (!desktop && g.kind === 'link' && last !== undefined) {
        this.commitGesture(
          e.pointerId,
          { x: last.wx, y: last.wy },
          last.cx,
          last.cy,
          true,
          'pointercancel-strict-commit',
        )
      } else this.cancelGesture('pointercancel-cancel')
    }
    const onPointerCancel = (e: PointerEvent) => {
      this.pointerTrace.recordPointer(e, false)
      handlePointerCancel(e)
    }
    const onWindowPointerCancel = (e: PointerEvent) => {
      if (e.target !== canvas && this.ownsPointer(e.pointerId)) {
        this.pointerTrace.recordPointer(e, true)
        handlePointerCancel(e)
      }
    }
    // A compatibility mouseup for the initiating button while a mouse-typed
    // gesture is still active means the pointer layer dropped the release
    // (observed as stuck stationary lifts on macOS trackpads): commit with
    // full pointerup semantics at the event position, so taps select and
    // widget presses activate exactly as the user's release intended. In the
    // normal flow pointerup precedes the compatibility mouseup and the
    // gesture is already idle, making this a strict no-op. Mouse-typed only:
    // a physical mouse's mouseup is indistinguishable from a pen's
    // compatibility mouseup, so acting on one while a pen gesture is held
    // could commit a drag the pen still owns (pens recover via re-press).
    // Every physical mouse shares the browser's single mouse pointer stream,
    // so within mouse-typed gestures the button correlation is sound.
    const onWindowMouseUp = (e: MouseEvent) => {
      const pointerId = this.activePointerId
      if (pointerId === undefined || this.gesture.kind === 'idle') return
      if (this.activePointerType !== 'mouse') return
      if (buttonsBit(e.button) !== this.activeButtonMask) return
      const { sx, sy } = this.toScreen(e)
      this.commitGesture(
        pointerId,
        this.renderer.toWorld(sx, sy),
        e.clientX,
        e.clientY,
        false,
        'mouseup-fallback',
      )
    }
    // Capture loss is NOT always abnormal: macOS trackpads (and overlays
    // that steal capture) can revoke it at release without ever delivering
    // the pointerup, and RG-1 field traces showed exactly that killing node
    // drags. A moved move/resize-family gesture carries the user's work at
    // the last tracked pointer position, so complete it there instead of
    // snapping it back. Link drags use the same strict valid-target policy
    // as pointercancel; widget/section/growth presses, marquee, pan, and
    // motionless presses cancel.
    // A normal pointerup, pointercancel, or cancellation clears
    // activePointerId BEFORE releasing capture, so the lostpointercapture
    // those trigger is a no-op here. A genuine platform cancel fires
    // pointercancel FIRST (spec order), so it can never complete through
    // this path.
    const onLostPointerCapture = (e: PointerEvent) => {
      this.pointerTrace.recordPointer(e, false)
      if (e.pointerId !== this.activePointerId) {
        // Unexpected capture loss of a navigation participant is terminal
        // for that finger: its release may never be delivered. Intentional
        // releases inside endTouchNav are no-ops here because touchNav is
        // cleared first, so the other finger's tracking survives to re-pair.
        const nav = this.touchNav
        if (nav !== undefined && (e.pointerId === nav.a || e.pointerId === nav.b)) {
          this.touchPoints.delete(e.pointerId)
          this.endTouchNav('cancel', 'lostpointercapture-cancel')
        }
        return
      }
      // A touch finger whose gesture ends through capture loss is dropped
      // from touch tracking too: a stale entry would let a later single
      // touch masquerade as the second of a pair.
      this.touchPoints.delete(e.pointerId)
      const g = this.gesture
      const last = this.lastGesturePoint
      if (g.kind === 'link' && last !== undefined) {
        this.commitGesture(
          e.pointerId,
          { x: last.wx, y: last.wy },
          last.cx,
          last.cy,
          true,
          'lostpointercapture-commit',
        )
        return
      }
      const completes =
        isMoveFamilyKind(g.kind) &&
        'moved' in g &&
        g.moved &&
        last !== undefined
      if (completes)
        this.commitGesture(
          e.pointerId,
          { x: last.wx, y: last.wy },
          last.cx,
          last.cy,
          false,
          'lostpointercapture-commit',
        )
      else this.cancelGesture('lostpointercapture-cancel')
    }
    // Scene replacement mid-gesture: what survives is decided by what the
    // gesture CAPTURED. Pure viewport pans survive (they never touch the
    // scene). Marquees and the whole move/resize family survive same-graph
    // rebuilds: they carry only entity ids plus world-space press geometry,
    // and their commits re-resolve every id against the commit-time scene
    // (vanished ids are skipped, group commits no-op). Background document
    // mutations - an execution tick, a post-run seed advancement, a
    // collaboration patch - must not eat an in-flight drag. Gestures whose
    // captures ARE scene objects (link drags with pin layouts and drop-target
    // sets, widget/section/growth presses holding old rows) cancel instead of
    // committing stale captures, as does everything on a graph change.
    const detachScene = renderer.onSceneReplaced((scene) => {
      // Hover ids are overlay state keyed to the OLD scene: a hovered node or
      // reroute that left must not keep pins or ghost sockets revealed, and a
      // GRAPH change stales both ids outright - an id in another graph may
      // name an unrelated entity. Prune first, in field state only; who
      // republishes the overlay depends on the gesture outcome below.
      const crossGraph = scene.graphId !== this.lastSceneGraphId
      this.lastSceneGraphId = scene.graphId
      if (crossGraph) this.setSelection([])
      const staleNode =
        this.hoveredNode !== undefined && (crossGraph || !scene.nodes.some((n) => n.id === this.hoveredNode))
      const staleReroute =
        this.hoveredReroute !== undefined &&
        (crossGraph || !scene.reroutes.some((r) => r.id === this.hoveredReroute))
      const staleLinkMidpoint =
        this.hoveredLinkMidpoint !== undefined &&
        (crossGraph || !scene.links.some((link) => link.id === this.hoveredLinkMidpoint))
      // Rows and pin layouts belong to the exact scene instance. Clear their
      // hover on every replacement, even when an identity happens to recur.
      const staleAffordance = this.hoveredPinNode !== undefined || this.hoveredWidgetNode !== undefined
      if (staleNode) {
        this.hoveredNode = undefined
        this.host.onNodeHover?.(undefined)
      }
      if (staleReroute) this.hoveredReroute = undefined
      if (staleLinkMidpoint) this.hoveredLinkMidpoint = undefined
      if (staleAffordance) this.clearAffordanceHoverFields()
      const g = this.gesture
      const idResolved =
        g.kind === 'marquee' ||
        g.kind === 'link-press' ||
        g.kind === 'node' ||
        g.kind === 'reroute-move' ||
        g.kind === 'value-source-move' ||
        g.kind === 'selector-move' ||
        g.kind === 'boundary-move' ||
        g.kind === 'group' ||
        g.kind === 'group-resize' ||
        g.kind === 'resize'
      const survives =
        g.kind === 'idle' ||
        g.kind === 'pan' ||
        (idResolved &&
          scene.graphId === this.gestureGraphId &&
          (g.kind !== 'resize' || scene.nodes.some((node) =>
            node.id === g.nodeId && node.x === g.start.x && node.y === g.start.y &&
            node.layout.width === g.start.width && node.layout.height === g.start.height &&
            node.layout.minWidth === g.minW && node.layout.minHeight === g.minH,
          )))
      if (!survives) {
        // cancelGesture publishes the overlay itself (now without the
        // pruned hover) - a second push here would be redundant.
        this.cancelGesture('scene-replaced')
        return
      }
      if (staleNode || staleReroute || staleLinkMidpoint || staleAffordance) {
        // A surviving gesture keeps its transient visuals: pushOverlay
        // replaces the WHOLE overlay, so carry the live marquee, drag
        // ghosts, and resize previews through (ids stayed same-graph valid;
        // the next pointermove refreshes them anyway).
        const live = this.renderer.getOverlay()
        this.pushOverlay({
          ...(live.marquee !== undefined ? { marquee: live.marquee } : {}),
          ...(live.dragOffsets !== undefined ? { dragOffsets: live.dragOffsets } : {}),
          ...(live.resizePreview !== undefined ? { resizePreview: live.resizePreview } : {}),
          ...(live.groupDragOffset !== undefined ? { groupDragOffset: live.groupDragOffset } : {}),
          ...(live.groupResizeGhost !== undefined ? { groupResizeGhost: live.groupResizeGhost } : {}),
        })
      }
    })
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerCancel)
    canvas.addEventListener('lostpointercapture', onLostPointerCapture)
    canvas.addEventListener('dblclick', onDblClick)
    canvas.addEventListener('contextmenu', onContextMenu)
    canvas.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('pointermove', onWindowPointerMove)
    window.addEventListener('pointerup', onWindowPointerUp)
    window.addEventListener('pointercancel', onWindowPointerCancel)
    window.addEventListener('mouseup', onWindowMouseUp)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    this.detach = () => {
      detachScene()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerCancel)
      canvas.removeEventListener('lostpointercapture', onLostPointerCapture)
      canvas.removeEventListener('dblclick', onDblClick)
      canvas.removeEventListener('contextmenu', onContextMenu)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('pointermove', onWindowPointerMove)
      window.removeEventListener('pointerup', onWindowPointerUp)
      window.removeEventListener('pointercancel', onWindowPointerCancel)
      window.removeEventListener('mouseup', onWindowMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }

  private hitOptions(options: Omit<HitOptions, 'scale' | 'detailLevel'> = {}): HitOptions {
    return {
      ...options,
      scale: this.renderer.getViewport().scale,
      detailLevel: this.renderer.getDetailLevel(),
    }
  }

  dispose(): void {
    this.cancelGesture('dispose')
    this.resetTouchTracking('dispose')
    this.detach()
  }

  enablePointerTrace(): void {
    this.pointerTrace.enable()
  }

  disablePointerTrace(): void {
    this.pointerTrace.disable()
  }

  clearPointerTrace(): void {
    this.pointerTrace.clear()
  }

  dumpPointerTrace(): readonly PointerTraceEntry[] {
    return this.pointerTrace.dump()
  }

  /**
   * Abort the active gesture without dispatching anything: release the
   * captured pointer, drop transient overlay state (ghost noodles, marquee,
   * drag offsets), and return to idle. Idempotent - safe from any of its
   * cancellation triggers (Escape, blur, an invalid terminal event, scene
   * replacement, disposal) in any order.
   */
  cancelGesture(reason: PointerTraceReason = 'pointercancel-cancel'): void {
    const pointerId = this.activePointerId
    const kind = this.gesture.kind
    this.activePointerId = undefined
    this.activeButtonMask = undefined
    this.activePointerType = undefined
    this.gestureGraphId = undefined
    this.lastGesturePoint = undefined
    this.releasePointer(pointerId)
    if (kind === 'idle') return
    this.pointerTrace.recordGesture(kind, 'cancel', reason)
    this.gesture = { kind: 'idle' }
    this.pushOverlay()
  }

  /**
   * A late signal proved the initiating button was released even though its
   * pointerup never arrived (dropped release, e.g. a macOS trackpad lift
   * that goes silent). Moved move/resize-family and link drags carry the
   * user's work, so complete them at the last tracked point - the pointer
   * has not moved since the release, or the buttons-zero move synthesis
   * would already have recovered. Everything else (motionless presses,
   * widget/section presses, marquee, pan) cancels rather than firing a
   * click action from a stale press. Late recovery never applies
   * empty-move-source disconnect: destructive rewire drops stay reserved
   * for releases delivered at a real-time position.
   */
  private recoverMissedRelease(reason: PointerTraceReason): void {
    const pointerId = this.activePointerId
    const g = this.gesture
    const last = this.lastGesturePoint
    if (pointerId === undefined || g.kind === 'idle') return
    if (
      last !== undefined &&
      'moved' in g &&
      g.moved &&
      (g.kind === 'link' || isMoveFamilyKind(g.kind))
    ) {
      this.commitGesture(pointerId, { x: last.wx, y: last.wy }, last.cx, last.cy, false, reason)
    } else this.cancelGesture(reason)
  }

  /**
   * A pointerdown that presses the button the active gesture believes is
   * ALREADY held - or whose buttons snapshot shows that button released -
   * can only mean the earlier release was dropped. Recover the stale
   * gesture so this press starts fresh instead of silently continuing it
   * (the "release not registered until repeated" symptom).
   */
  private recoverRepressedGesture(e: PointerEvent): void {
    if (this.activePointerId !== e.pointerId || this.gesture.kind === 'idle') return
    const mask = this.activeButtonMask
    if (mask === undefined || mask === 0) return
    if (buttonsBit(e.button) === mask || (e.buttons & mask) === 0)
      this.recoverMissedRelease('pointerdown-repress')
  }

  /**
   * Take ownership of this pointer for the gesture being started: attempt
   * capture (window listeners are the fallback), remember its id so no other
   * pointer can advance or complete the gesture, and record the graph the
   * gesture's captures belong to.
   */
  private capturePointer(e: PointerEvent): void {
    // Hover visuals are idle affordances. Clear them exactly once when a
    // gesture takes ownership; owned moves never churn them back on.
    this.setAffordanceHover(undefined)
    // Owned moves do not update the idle pointer, so the pre-gesture
    // position is stale by the time the gesture ends. Drop it: a scene
    // rebuild right after a commit must not re-announce hover at wherever
    // the pointer idled before the drag.
    this.idlePointer = undefined
    this.activePointerId = e.pointerId
    this.activeButtonMask = buttonsBit(e.button)
    this.activePointerType = e.pointerType
    this.gestureGraphId = this.renderer.getScene().graphId
    const { sx, sy } = this.toScreen(e)
    const w = this.renderer.toWorld(sx, sy)
    this.lastGesturePoint = { wx: w.x, wy: w.y, cx: e.clientX, cy: e.clientY }
    // Pointer capture is an optimization, not a correctness requirement.
    // Safari may throw here or silently leave capture unset; window-level
    // move/up/cancel fallbacks continue the already-owned gesture.
    try {
      this.canvas.setPointerCapture(e.pointerId)
    } catch {
      // Continue uncaptured.
    }
  }

  private releasePointer(pointerId: number | undefined): void {
    if (pointerId === undefined) return
    try {
      if (this.canvas.hasPointerCapture(pointerId)) this.canvas.releasePointerCapture(pointerId)
    } catch {
      // Capture may already have been revoked by the platform.
    }
  }

  /** Window fallback events are processed only for pointers this controller
   * tracks: the gesture owner and live touch pointers (a navigation finger
   * may be uncaptured when the platform rejects setPointerCapture). */
  private ownsPointer(pointerId: number): boolean {
    return pointerId === this.activePointerId || this.touchPoints.has(pointerId)
  }

  /** Start two-finger navigation from the two live touch points. Any
   * one-finger touch gesture yields: its captures would fight the moving
   * viewport, and the strict touch policy already treats an interrupted
   * touch gesture as cancelled rather than committed. */
  private beginTouchNav(): void {
    if (this.gesture.kind !== 'idle') this.cancelGesture('touch-nav-takeover')
    this.setAffordanceHover(undefined)
    this.idlePointer = undefined
    const [a, b] = [...this.touchPoints.keys()] as [number, number]
    this.touchNav = { a, b }
    this.pointerTrace.recordGesture('touch-nav', 'start', 'pointerdown')
    for (const id of [a, b]) {
      // Capture is an optimization here exactly as for gestures: the window
      // fallbacks forward tracked touch pointers when it fails.
      try {
        this.canvas.setPointerCapture(id)
      } catch {
        // Continue uncaptured.
      }
    }
  }

  /**
   * Advance touch tracking for a move. Returns true when the event belongs
   * to two-finger navigation (participant or inert extra finger) and must
   * not fall through to gesture/hover processing. A participant move pans
   * and zooms the viewport with the pair midpoint and distance.
   */
  private handleTouchNavMove(e: PointerEvent): boolean {
    if (e.pointerType !== 'touch') return false
    const point = this.touchPoints.get(e.pointerId)
    if (point === undefined) return false
    const nav = this.touchNav
    if (nav === undefined || (e.pointerId !== nav.a && e.pointerId !== nav.b)) {
      point.cx = e.clientX
      point.cy = e.clientY
      return nav !== undefined
    }
    const other = this.touchPoints.get(e.pointerId === nav.a ? nav.b : nav.a)
    if (other === undefined) return true
    const rect = this.canvas.getBoundingClientRect()
    const prevSelf = { x: point.cx - rect.left, y: point.cy - rect.top }
    const otherPoint = { x: other.cx - rect.left, y: other.cy - rect.top }
    const nextSelf = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    point.cx = e.clientX
    point.cy = e.clientY
    this.renderer.setViewport(
      touchNavViewport(this.renderer.getViewport(), prevSelf, otherPoint, nextSelf, otherPoint),
    )
    return true
  }

  /**
   * Forget a lifted or cancelled touch pointer. Returns true when the event
   * belonged to two-finger navigation and must not fall through to gesture
   * completion: a participant lift ends navigation (the remaining finger
   * owns nothing until it lifts and a new second touch re-pairs), an extra
   * finger's lift is inert.
   */
  private endTouchPointer(e: PointerEvent, reason: PointerTraceReason): boolean {
    if (e.pointerType !== 'touch') return false
    this.touchPoints.delete(e.pointerId)
    const nav = this.touchNav
    if (nav === undefined) return false
    if (e.pointerId === nav.a || e.pointerId === nav.b)
      this.endTouchNav(reason === 'pointerup' ? 'commit' : 'cancel', reason)
    return true
  }

  private endTouchNav(event: 'commit' | 'cancel', reason: PointerTraceReason): void {
    const nav = this.touchNav
    if (nav === undefined) return
    this.touchNav = undefined
    this.releasePointer(nav.a)
    this.releasePointer(nav.b)
    this.pointerTrace.recordGesture('touch-nav', event, reason)
  }

  /** Drop all touch tracking: blur and dispose may swallow the releases, and
   * a stale entry would let a later single touch masquerade as a pair. */
  private resetTouchTracking(reason: PointerTraceReason): void {
    this.endTouchNav('cancel', reason)
    this.touchPoints.clear()
  }

  getSelection(): ReadonlySet<string> {
    return this.selection
  }

  /**
   * Set (or clear, with undefined) the persistent palette ghost noodle:
   * the host calls this on link-drop-on-empty so the dangling connection
   * stays visible while the user browses the compatible-node palette, and
   * clears it when the palette closes or commits.
   */
  setPaletteGhost(ghost: GhostLink | undefined): void {
    this.paletteGhost = ghost
    this.pushOverlay()
  }

  /** Set or clear the persistent paint-only preview for an armed node placement. */
  setPlacementGhost(ghost: PlacementGhost | undefined): void {
    this.placementGhost = ghost
    this.pushOverlay()
  }

  /** Set or clear the keyboard-focused semantic pin. */
  setFocusedPin(pin: {
    readonly nodeId: string
    readonly portId: string
    readonly direction: 'in' | 'out'
    readonly widgetTap?: true
  } | undefined): void {
    if (pin?.nodeId === this.focusedPinNode &&
        pin?.portId === this.focusedPinPort &&
        pin?.direction === this.focusedPinDirection &&
        pin?.widgetTap === this.focusedPinWidgetTap) return
    this.focusedPinNode = pin?.nodeId
    this.focusedPinPort = pin?.portId
    this.focusedPinDirection = pin?.direction
    this.focusedPinWidgetTap = pin?.widgetTap
    this.pushOverlay()
  }

  getLinkSelection(): ReadonlySet<string> {
    return this.linkSelection
  }

  getRerouteSelection(): ReadonlySet<string> {
    return this.rerouteSelection
  }

  getValueSourceSelection(): ReadonlySet<string> {
    return this.valueSourceSelection
  }

  getSelectorSelection(): ReadonlySet<string> {
    return this.selectorSelection
  }

  getGroupSelection(): ReadonlySet<string> {
    return this.groupSelection
  }

  getNetViewSelection(): ReadonlySet<string> {
    return this.netViewSelection
  }

  /** Clear selection when the app changes tab ownership without changing graph ids. */
  setSelectionOwner(owner: string): void {
    if (owner === this.selectionOwner) return
    const hadOwner = this.selectionOwner !== undefined
    this.selectionOwner = owner
    if (hadOwner) {
      if (this.gesture.kind !== 'idle') this.cancelGesture('selection-owner-changed')
      this.setSelection([])
    }
  }

  setSelection(
    nodeIds: Iterable<string>,
    linkIds: Iterable<string> = [],
    rerouteIds: Iterable<string> = [],
    valueSourceIds: Iterable<string> = [],
    selectorIds: Iterable<string> = [],
    groupIds: Iterable<string> = [],
    netViewIds: Iterable<string> = [],
  ): void {
    this.selection = new Set(nodeIds)
    this.linkSelection = new Set(linkIds)
    this.rerouteSelection = new Set(rerouteIds)
    this.valueSourceSelection = new Set(valueSourceIds)
    this.selectorSelection = new Set(selectorIds)
    this.groupSelection = new Set(groupIds)
    this.netViewSelection = new Set(netViewIds)
    this.notifySelection()
    this.pushOverlay()
  }

  /** Drop selection entries whose items left the scene (e.g. after undo). */
  pruneSelection(): void {
    const scene = this.renderer.getScene()
    const aliveNodes = new Set([...scene.nodes.map((n) => n.id), ...scene.boundaryNodes.map((n) => boundarySceneId(n.side))])
    // A hidden (collapsed-net) delivery is not a selectable item: a selection
    // taken while the net was expanded must not survive the collapse, or
    // Delete would disconnect an invisible link.
    const aliveLinks = new Set(scene.links.filter((l) => l.hidden !== true).map((l) => l.id))
    const aliveReroutes = new Set(scene.reroutes.map((r) => r.id))
    const aliveValueSources = new Set(scene.valueSources.map((v) => v.id))
    const aliveSelectors = new Set(scene.selectors.map((s) => s.id))
    const aliveGroups = new Set(scene.groups.map((g) => g.id))
    const aliveNetViews = new Set(scene.netStubs.map((stub) => stub.id))
    const nodes = [...this.selection].filter((id) => aliveNodes.has(id))
    const links = [...this.linkSelection].filter((id) => aliveLinks.has(id))
    const reroutes = [...this.rerouteSelection].filter((id) => aliveReroutes.has(id))
    const valueSources = [...this.valueSourceSelection].filter((id) => aliveValueSources.has(id))
    const selectors = [...this.selectorSelection].filter((id) => aliveSelectors.has(id))
    const groups = [...this.groupSelection].filter((id) => aliveGroups.has(id))
    const netViews = [...this.netViewSelection].filter((id) => aliveNetViews.has(id))
    if (
      nodes.length !== this.selection.size ||
      links.length !== this.linkSelection.size ||
      reroutes.length !== this.rerouteSelection.size ||
      valueSources.length !== this.valueSourceSelection.size ||
      selectors.length !== this.selectorSelection.size ||
      groups.length !== this.groupSelection.size ||
      netViews.length !== this.netViewSelection.size
    ) {
      this.setSelection(nodes, links, reroutes, valueSources, selectors, groups, netViews)
    } else this.pushOverlay()
  }

  private notifySelection(): void {
    this.host.onSelectionChange?.(
      this.selection,
      this.linkSelection,
      this.rerouteSelection,
      this.valueSourceSelection,
      this.selectorSelection,
      this.groupSelection,
    )
  }

  private selectionMoveGesture(
    scene: Scene,
    startWX: number,
    startWY: number,
    pressedValueSourceId?: string,
  ): Extract<Gesture, { kind: 'node' }> {
    return {
      kind: 'node',
      nodeIds: scene.nodes.filter((node) => this.selection.has(node.id)).map((node) => node.id),
      rerouteIds: [...this.rerouteSelection],
      valueSourceIds: [...this.valueSourceSelection],
      selectorIds: [...this.selectorSelection],
      boundarySides: scene.boundaryNodes.filter((node) => this.selection.has(boundarySceneId(node.side))).map((node) => node.side),
      groupIds: [...this.groupSelection],
      netViewIds: [...this.netViewSelection],
      ...(pressedValueSourceId !== undefined ? { pressedValueSourceId } : {}),
      startWX,
      startWY,
      moved: false,
    }
  }

  private hasOtherMovableSelection(kind: 'reroute' | 'valueSource' | 'selector'): boolean {
    return this.selection.size > 0 || this.groupSelection.size > 0 || this.netViewSelection.size > 0 ||
      (kind !== 'reroute' && this.rerouteSelection.size > 0) ||
      (kind !== 'valueSource' && this.valueSourceSelection.size > 0) ||
      (kind !== 'selector' && this.selectorSelection.size > 0)
  }

  /** Select every citizen projected by the current graph scene. */
  selectAll(): void {
    const scene = this.renderer.getScene()
    this.setSelection(
      [...scene.nodes.map((node) => node.id), ...scene.boundaryNodes.map((node) => boundarySceneId(node.side))],
      [],
      scene.reroutes.map((reroute) => reroute.id),
      scene.valueSources.map((source) => source.id),
      scene.selectors.map((selector) => selector.id),
      scene.groups.map((group) => group.id),
      scene.netStubs.map((stub) => stub.id),
    )
  }

  // -- gesture entry ---------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touchPoints.set(e.pointerId, { cx: e.clientX, cy: e.clientY })
      // Extra fingers during navigation are inert: they neither restart the
      // pair nor fall through to start a gesture.
      if (this.touchNav !== undefined) return
      // A second finger starts two-finger navigation when touch owns the
      // canvas (idle, or a one-finger touch gesture that yields). A gesture
      // held by mouse or pen keeps ownership; the touches stay ignored.
      if (
        this.touchPoints.size === 2 &&
        (this.gesture.kind === 'idle' || this.activePointerType === 'touch')
      ) {
        this.beginTouchNav()
        return
      }
    } else if (this.touchNav !== undefined) {
      // A mouse/pen press while two fingers navigate would fight the
      // viewport; swallow it.
      e.preventDefault()
      return
    }
    // A second pointer (other mouse button mid-drag, second touch) never
    // steals or restarts the gesture the first pointer owns.
    if (this.activePointerId !== undefined) return
    // Middle button always pans, wherever it lands.
    if (e.button === 1) {
      e.preventDefault()
      const { sx, sy } = this.toScreen(e)
      this.downX = sx
      this.downY = sy
      this.capturePointer(e)
      this.gesture = { kind: 'pan', lastX: e.clientX, lastY: e.clientY, moved: true }
      return
    }
    if (e.button !== 0) return
    const { sx, sy } = this.toScreen(e)
    this.downX = sx
    this.downY = sy
    const w = this.renderer.toWorld(sx, sy)
    const scene = this.renderer.getScene()

    // Space+drag pans from anywhere (the ComfyUI hand tool): it outranks
    // every hit so a crowded canvas stays navigable.
    if (this.spaceDown) {
      this.capturePointer(e)
      this.gesture = {
        kind: 'pan',
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        keepSelection: true,
      }
      return
    }

    // The selection toolbox floats over everything it acts on, so it claims
    // clicks first: a button fires its action; strip chrome between buttons
    // swallows the press (never a marquee/drag through the toolbox).
    const toolbox = this.renderer.getToolboxLayout()
    if (toolbox) {
      const buttonHit = hitTestToolbox(toolbox, w.x, w.y)
      if (buttonHit) {
        e.preventDefault()
        this.toolboxDblClickGuard = {
          clientX: e.clientX,
          clientY: e.clientY,
          expiresAt: e.timeStamp + 1000,
        }
        this.gesture = { kind: 'idle' }
        if (buttonHit.button.disabled !== true) this.host.onToolboxAction?.(buttonHit)
        return
      }
      if (insideToolbox(toolbox, w.x, w.y)) {
        e.preventDefault()
        this.toolboxDblClickGuard = {
          clientX: e.clientX,
          clientY: e.clientY,
          expiresAt: e.timeStamp + 1000,
        }
        this.gesture = { kind: 'idle' }
        return
      }
    }

    // Badges win over every other gesture: a badge click opens details, never
    // a selection/drag on the node underneath.
    const badgeHit = this.renderer.getDetailLevel() === 'overview'
      ? undefined
      : hitTestBadge(scene, this.renderer.getBadges(), w.x, w.y)
    if (badgeHit) {
      // Cancel the pointerdown so the follow-up mousedown's default action
      // (focus change) can't blur a popover the host just opened and focused.
      e.preventDefault()
      this.gesture = { kind: 'idle' }
      this.host.onBadgeClick?.(badgeHit.node, badgeHit.badge, badgeHit.rect)
      return
    }

    // Ghost sockets are grabbable only while revealed (hovered reroute).
    const hit = hitTest(
      scene,
      w.x,
      w.y,
      this.hitOptions({
        ...(this.hoveredReroute !== undefined ? { rerouteSockets: this.hoveredReroute } : {}),
        widgetTaps: this.widgetTapHits(scene),
        pinRevealed: this.pinRevealed(scene),
      }),
    )
    this.capturePointer(e)

    if (hit.kind === 'widget' && this.widgetRowAffordanceContains(hit)) {
      this.gesture = { kind: 'widget-affordance', hit, moved: false }
      return
    }
    if ((hit.kind === 'body' || hit.kind === 'header') && this.previewSurfaceAffordanceContains(hit.node, w.x, w.y)) {
      this.gesture = { kind: 'preview-affordance', node: hit.node, moved: false }
      return
    }

    switch (hit.kind) {
      case 'empty':
        // Plain empty drag pans (the primary navigation gesture); Ctrl+drag
        // sweeps a marquee (Shift keeps it additive). A motionless plain
        // click still clears the selection; Shift-click keeps it.
        this.gesture =
          e.ctrlKey || e.metaKey
            ? { kind: 'marquee', startWX: w.x, startWY: w.y, additive: e.shiftKey, moved: false }
            : { kind: 'pan', lastX: e.clientX, lastY: e.clientY, moved: false, keepSelection: e.shiftKey }
        return
      case 'widget':
        this.gesture = { kind: 'widget', hit, moved: false }
        return
      case 'section':
        this.gesture = { kind: 'section', hit, moved: false }
        return
      case 'growth':
        this.gesture = { kind: 'growth', hit, moved: false }
        return
      case 'pin':
        if (hit.pin.familyOwner !== undefined && hit.pin.familyOwner.socketed !== true) return
        {
          const gesture = this.beginLinkGesture(scene, hit, e.shiftKey, e.altKey)
          if (gesture === undefined) return
          this.gesture = gesture
        }
        this.pushOverlay()
        return
      case 'widgetTap':
        const fanOut = scene.links.filter((link) =>
          link.from.kind === 'widgetTap' && link.from.node === hit.node.id && link.from.input === hit.input,
        )
        const move = endpointDragMode('out', fanOut.length > 0, e.shiftKey) === 'move-source'
          ? this.beginMoveSourceGesture(scene, { x: hit.x, y: hit.y }, hit.type, fanOut, hit.node.id)
          : undefined
        this.gesture = move ?? {
          kind: 'link', anchor: { x: hit.x, y: hit.y }, seeking: 'in',
          presenceOrigin: { kind: 'widgetTap', node: hit.node.id, input: hit.input },
          anchorType: hit.type,
          ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
          fromTap: { node: hit.node.id, tap: hit.input },
          dropTargets: this.withBoundaryTargets(
            scene,
            this.compatibleTargets(scene, hit.type, 'in', hit.node.id),
            hit.type,
            'in',
          ),
          moved: false,
        }
        this.pushOverlay()
        return
      case 'netStub':
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (this.netViewSelection.has(hit.stub.id)) this.netViewSelection.delete(hit.stub.id)
          else this.netViewSelection.add(hit.stub.id)
        } else if (!this.netViewSelection.has(hit.stub.id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set([hit.stub.id])
        }
        this.notifySelection()
        this.gesture = this.selectionMoveGesture(scene, w.x, w.y)
        this.pushOverlay()
        return
      case 'boundary-pin':
        if (hit.row && !hit.regionIndex) {
          this.gesture = { kind: 'boundary-move', side: hit.bnode.side, startWX: w.x, startWY: w.y, moved: false }
          return
        }
        // Boundary pins are link-drag sources: existing items fan out
        // (inputs) or re-point (outputs); the blank slot exposes a new port.
        // Shift on a bound inputs item grabs the whole binding fan-out,
        // mirroring Shift-grab on a real output pin.
        this.gesture = this.beginBoundaryLinkGesture(scene, hit, e.shiftKey)
        this.pushOverlay()
        return
      case 'boundary-header':
      case 'boundary-body': {
        const id = boundarySceneId(hit.bnode.side)
        if (e.shiftKey) {
          if (this.selection.has(id)) this.selection.delete(id)
          else this.selection.add(id)
        } else if (!this.selection.has(id)) {
          this.selection = new Set([id])
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
        }
        this.notifySelection()
        const selectedBoundarySides = scene.boundaryNodes.filter((node) => this.selection.has(boundarySceneId(node.side))).map((node) => node.side)
        const selectedRealNodes = [...this.selection].filter((selected) => scene.nodes.some((node) => node.id === selected))
        this.gesture = selectedRealNodes.length === 0 && selectedBoundarySides.length === 1 &&
          this.rerouteSelection.size === 0 && this.valueSourceSelection.size === 0 && this.selectorSelection.size === 0 &&
          this.groupSelection.size === 0 && this.netViewSelection.size === 0
          ? { kind: 'boundary-move', side: hit.bnode.side, startWX: w.x, startWY: w.y, moved: false }
          : {
          kind: 'node',
          nodeIds: selectedRealNodes,
          rerouteIds: [...this.rerouteSelection],
          valueSourceIds: [...this.valueSourceSelection],
          selectorIds: [...this.selectorSelection],
          boundarySides: selectedBoundarySides,
          groupIds: [...this.groupSelection],
          netViewIds: [...this.netViewSelection],
          startWX: w.x,
          startWY: w.y,
          moved: false,
        }
        this.pushOverlay()
        return
      }
      case 'link': {
        // Click-select only; links are managed by pin drags.
        const id = hit.link.id
        if (e.shiftKey) {
          if (this.linkSelection.has(id)) this.linkSelection.delete(id)
          else this.linkSelection.add(id)
        } else {
          this.selection = new Set()
          this.linkSelection = new Set([id])
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
        }
        this.notifySelection()
        this.gesture = {
          kind: 'link-press',
          ...(hit.link.boundary !== true ? { linkId: hit.link.id } : {}),
          midpoint: hit.midpoint,
          modified: e.ctrlKey || e.metaKey || e.shiftKey || e.altKey,
          moved: false,
        }
        this.pushOverlay()
        return
      }
      case 'reroute': {
        const id = hit.reroute.id
        // Alt+drag pulls a new noodle FROM the junction (fan-out).
        if (e.altKey) {
          this.gesture = this.beginRerouteLinkGesture(scene, hit.reroute)
          this.pushOverlay()
          return
        }
        if (e.shiftKey) {
          if (this.rerouteSelection.has(id)) this.rerouteSelection.delete(id)
          else this.rerouteSelection.add(id)
        } else if (!this.rerouteSelection.has(id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set([id])
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
        }
        this.notifySelection()
        if (this.rerouteSelection.has(id) && this.hasOtherMovableSelection('reroute')) {
          this.gesture = this.selectionMoveGesture(scene, w.x, w.y)
          this.pushOverlay()
          return
        }
        const dragIds = this.rerouteSelection.has(id) ? [...this.rerouteSelection] : []
        this.gesture = { kind: 'reroute-move', rerouteIds: dragIds, startWX: w.x, startWY: w.y, moved: false }
        this.pushOverlay()
        return
      }
      case 'rerouteSocket': {
        // Right socket pulls a new noodle OUT of the junction (fan-out,
        // like Alt+drag); left socket seeks a producer INTO it. Both anchor
        // the ghost at the grabbed socket so the drag reads as "from here".
        this.gesture =
          hit.side === 'out'
            ? this.beginRerouteLinkGesture(scene, hit.reroute, { x: hit.x, y: hit.y }, e.shiftKey)
            : this.beginRerouteInLinkGesture(scene, hit.reroute, { x: hit.x, y: hit.y }, e.shiftKey)
        this.pushOverlay()
        return
      }
      case 'valueSourceOut': {
        this.gesture = this.beginValueSourceLinkGesture(scene, hit)
        this.pushOverlay()
        return
      }
      case 'valueSourceBadge': {
        // Like node badges: the click opens details, never selects or drags.
        e.preventDefault()
        this.gesture = { kind: 'idle' }
        this.host.onValueSourceBadgeClick?.(hit.valueSource, valueSourceBadgeRect(hit.valueSource))
        return
      }
      case 'valueSource': {
        const id = hit.valueSource.id
        if (e.shiftKey) {
          if (this.valueSourceSelection.has(id)) this.valueSourceSelection.delete(id)
          else this.valueSourceSelection.add(id)
        } else if (!this.valueSourceSelection.has(id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set([id])
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
        }
        this.notifySelection()
        if (this.valueSourceSelection.has(id) && this.hasOtherMovableSelection('valueSource')) {
          this.gesture = this.selectionMoveGesture(scene, w.x, w.y, id)
          this.pushOverlay()
          return
        }
        const dragIds = this.valueSourceSelection.has(id) ? [...this.valueSourceSelection] : []
        this.gesture = {
          kind: 'value-source-move',
          valueSourceIds: dragIds,
          pressedId: id,
          startWX: w.x,
          startWY: w.y,
          moved: false,
        }
        this.pushOverlay()
        return
      }
      case 'selectorOut': {
        this.gesture = this.beginSelectorOutLinkGesture(scene, hit)
        this.pushOverlay()
        return
      }
      case 'selectorIn': {
        this.gesture = this.beginSelectorInLinkGesture(scene, hit)
        this.pushOverlay()
        return
      }
      case 'selectorBadge': {
        // Like node badges: the click opens policy details, never selects or drags.
        e.preventDefault()
        this.gesture = { kind: 'idle' }
        this.host.onSelectorBadgeClick?.(hit.selector, selectorBadgeRect(hit.selector))
        return
      }
      case 'selector': {
        const id = hit.selector.id
        if (e.shiftKey) {
          if (this.selectorSelection.has(id)) this.selectorSelection.delete(id)
          else this.selectorSelection.add(id)
        } else if (!this.selectorSelection.has(id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set([id])
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
        }
        this.notifySelection()
        if (this.selectorSelection.has(id) && this.hasOtherMovableSelection('selector')) {
          this.gesture = this.selectionMoveGesture(scene, w.x, w.y)
          this.pushOverlay()
          return
        }
        const dragIds = this.selectorSelection.has(id) ? [...this.selectorSelection] : []
        this.gesture = { kind: 'selector-move', selectorIds: dragIds, startWX: w.x, startWY: w.y, moved: false }
        this.pushOverlay()
        return
      }
      case 'resize': {
        const l = hit.node.layout
        const west = hit.handle.includes('w')
        const north = hit.handle.includes('n')
        const movingX = west ? hit.node.x : hit.node.x + l.width
        const movingY = north ? hit.node.y : hit.node.y + l.height
        this.gesture = {
          kind: 'resize',
          nodeId: hit.node.id,
          handle: hit.handle,
          start: { x: hit.node.x, y: hit.node.y, width: l.width, height: l.height },
          // Manual sizes persist as whole world units, so canonicalize a
          // natural fractional layout once before capturing its fixed edge.
          anchorX: west ? hit.node.x + Math.round(l.width) : hit.node.x,
          anchorY: north ? hit.node.y + Math.round(l.height) : hit.node.y,
          grabOffsetX: movingX - w.x,
          grabOffsetY: movingY - w.y,
          minW: l.minWidth,
          minH: l.minHeight,
          heightOffset: l.resizeHeightOffset ?? 0,
          moved: false,
        }
        return
      }
      case 'group-header': {
        const id = hit.group.id
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (this.groupSelection.has(id)) this.groupSelection.delete(id)
          else this.groupSelection.add(id)
        } else if (!this.groupSelection.has(id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set([id])
          this.netViewSelection = new Set()
        }
        this.notifySelection()
        const selectedCitizens =
          this.selection.size + this.rerouteSelection.size + this.valueSourceSelection.size +
          this.selectorSelection.size + this.netViewSelection.size
        if (selectedCitizens > 0 || this.groupSelection.size > 1) {
          this.gesture = this.selectionMoveGesture(scene, w.x, w.y)
          this.pushOverlay()
          return
        }
        // Drag moves the rectangle plus the nodes spatially inside it right
        // now; membership is captured once, at gesture start.
        this.gesture = {
          kind: 'group',
          groupId: hit.group.id,
          memberIds: nodesInGroup(scene, hit.group),
          rerouteIds: reroutesInGroup(scene, hit.group),
          valueSourceIds: valueSourcesInGroup(scene, hit.group),
          selectorIds: selectorsInGroup(scene, hit.group),
          boundarySides: boundaryNodesInGroup(scene, hit.group),
          startWX: w.x,
          startWY: w.y,
          moved: false,
        }
        return
      }
      case 'group-resize': {
        const west = hit.handle.includes('w')
        const north = hit.handle.includes('n')
        const movingX = west ? hit.group.x : hit.group.x + hit.group.width
        const movingY = north ? hit.group.y : hit.group.y + hit.group.height
        this.gesture = {
          kind: 'group-resize',
          groupId: hit.group.id,
          handle: hit.handle,
          start: { x: hit.group.x, y: hit.group.y, width: hit.group.width, height: hit.group.height },
          anchorX: west ? hit.group.x + hit.group.width : hit.group.x,
          anchorY: north ? hit.group.y + hit.group.height : hit.group.y,
          grabOffsetX: movingX - w.x,
          grabOffsetY: movingY - w.y,
          moved: false,
        }
        return
      }
      case 'header':
      case 'body': {
        const id = hit.node.id
        if (e.shiftKey) {
          const range = connectivityRangeSelection(scene, this.selection, id)
          if (range !== undefined) {
            this.selection = range.nodes
            this.rerouteSelection = new Set([...this.rerouteSelection, ...range.reroutes])
          }
          else if (this.selection.has(id)) this.selection.delete(id)
          else this.selection.add(id)
        } else if (e.ctrlKey || e.metaKey) {
          // Toggle immediately; a modifier-drag moves the resulting selection.
          if (this.selection.has(id)) this.selection.delete(id)
          else this.selection.add(id)
        } else if (!this.selection.has(id)) {
          this.selection = new Set([id])
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
        }
        this.notifySelection()
        const dragIds = this.selection.has(id) ? [...this.selection] : []
        this.gesture = this.selection.has(id)
          ? this.selectionMoveGesture(scene, w.x, w.y)
          : { kind: 'node', nodeIds: dragIds, rerouteIds: [], valueSourceIds: [], selectorIds: [], boundarySides: [], groupIds: [], netViewIds: [], startWX: w.x, startWY: w.y, moved: false }
        this.pushOverlay()
        return
      }
    }
  }

  private beginLinkGesture(
    scene: Scene,
    hit: Extract<Hit, { kind: 'pin' }>,
    shift = false,
    alt = false,
  ): Gesture | undefined {
    const fixedMaterialize = pinMaterialize(hit.node.id, hit.pin)
    if (hit.direction === 'in') {
      // Pins are keyed by elab key; compare link ends the same way (a member
      // path is part of the identity - hazard N6).
      const existing = scene.links.find(
        (l) => l.to.kind === 'port' && l.to.node === hit.node.id && portEndKey(l.to) === hit.portId,
      )
      // Alt keeps its established meaning and outranks Shift. For regular
      // links it fans out from the driver; boundary links retain their
      // existing boundary-rewire behavior because they have no link source
      // endpoint that link.connect can reuse.
      const mode = connectedInputDragMode(shift, alt)
      // A synthetic boundary noodle drives this input: grab it as a boundary
      // rewire (boundary commands, never link.disconnect - its id is not a
      // document link).
      if (existing?.effectiveIdentities !== undefined && existing.effectiveIdentities.length > 1) {
        this.host.onOccurrenceMutationRefused?.(
          'occurrence.link.multipleDeliveriesUnsupported',
          'Edit this projected fan-out from its source socket.',
        )
        return undefined
      }
      if (existing?.effectiveIdentity !== undefined && mode !== 'rewire') {
        this.host.onOccurrenceMutationRefused?.(
          mode === 'fan-out' ? 'occurrence.link.fanOutUnsupported' : 'occurrence.link.replacementUnsupported',
          mode === 'fan-out'
            ? 'Create projected fan-out links from the source socket.'
            : 'Replace this projected delivery with an ordinary rewire gesture.',
        )
        return undefined
      }
      if (existing && existing.from.kind === 'boundary' && existing.effectiveIdentity === undefined && existing.effectiveIdentities === undefined) {
        if (mode === 'replace-candidate') return this.beginBoundaryInputReplacement(scene, existing, hit, fixedMaterialize)
        return this.beginBoundaryRewire(scene, existing, hit)
      }
      // Alt-grab of a connected input: pull a NEW noodle from this input's
      // driver instead of rewiring - the "this value passes through"
      // gesture (same source, no new semantics; mirrors reroute Alt-drag).
      if (existing && mode === 'fan-out') return this.beginRewire(scene, existing, true)
      // This is intentionally the same fresh input-side candidate used by an
      // empty input. Its eventual link.connect removes the prior driver only
      // after a legal drop has supplied the replacement source.
      if (existing && mode === 'replace-candidate')
        return this.beginFreshInputGesture(scene, hit, fixedMaterialize, true)
      if (existing) return this.beginRewire(scene, existing)
      // Fresh drag from a free input: seek an output (or a reroute source,
      // or the Inputs boundary panel to expose/fan out a boundary port).
      return this.beginFreshInputGesture(scene, hit, fixedMaterialize)
    }
    // Shift-grab of a connected output: pick up the WHOLE fan-out and seek a
    // new source output; a legal drop re-sources every link atomically.
    const fanOut = scene.links.filter(
      (l) => l.from.kind === 'port' && l.from.node === hit.node.id && portEndKey(l.from) === hit.portId,
    )
    if (endpointDragMode('out', fanOut.length > 0, shift) === 'move-source') {
      const move = this.beginMoveSourceGesture(scene, { x: hit.x, y: hit.y }, hit.type, fanOut, hit.node.id)
      if (move) return move
    }
    // From an output: seek inputs (or reroutes to drive, or the Outputs
    // boundary panel to expose the value).
    return {
      kind: 'link',
      presenceOrigin: { kind: 'port', node: hit.node.id, port: hit.portId, side: 'out' },
      anchor: { x: hit.x, y: hit.y },
      seeking: 'in',
      anchorType: hit.type,
      ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
      fromPort: pinEndpoint(hit.node.id, hit.pin),
      ...(fixedMaterialize !== undefined ? { fixedMaterialize } : {}),
      dropTargets: this.withBoundaryTargets(
        scene,
        this.compatibleTargets(scene, hit.type, 'in', hit.node.id),
        hit.type,
        'in',
      ),
      moved: false,
    }
  }

  /** Build the shared input-side fresh candidate used by empty and Shift-grabbed inputs. */
  private beginFreshInputGesture(
    scene: Scene,
    hit: Extract<Hit, { kind: 'pin' }>,
    fixedMaterialize: MaterializeStep | undefined,
    preserveInputDriver = false,
  ): Extract<Gesture, { kind: 'link' }> {
    return {
      kind: 'link',
      presenceOrigin: { kind: 'port', node: hit.node.id, port: hit.portId, side: 'in' },
      anchor: { x: hit.x, y: hit.y },
      seeking: 'out',
      anchorType: hit.type,
      ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
      intoPort: pinEndpoint(hit.node.id, hit.pin),
      ...(fixedMaterialize !== undefined ? { fixedMaterialize } : {}),
      ...(preserveInputDriver ? { preserveInputDriver: true } : {}),
      dropTargets: this.withBoundaryTargets(
        scene,
        this.compatibleTargets(scene, hit.type, 'out', hit.node.id),
        hit.type,
        'out',
      ),
      moved: false,
    }
  }

  /**
   * Fresh drag from a boundary pseudo-node pin. Inputs-side pins produce
   * into inner inputs (existing item = fan-out via boundary.addBinding,
   * blank slot = boundary.addItem); Outputs-side pins consume inner outputs
   * (existing item = re-point via boundary.setBinding, blank slot =
   * boundary.addItem). Inputs bind to real input ports; outputs bind to real
   * output ports or widget-output taps, never reroutes/selectors/value sources.
   */
  private beginBoundaryLinkGesture(scene: Scene, hit: Extract<Hit, { kind: 'boundary-pin' }>, shift = false): Gesture {
    if (hit.regionIndex) {
      return {
        kind: 'link',
        anchor: { x: hit.x, y: hit.y },
        seeking: 'in',
        anchorType: hit.type,
        anchorTypeName: 'core.int',
        fromPort: { node: '$region', port: 'index' },
        dropTargets: this.innerPinTargets(scene, hit.type, 'in'),
        moved: false,
      }
    }
    const side = hit.bnode.side
    const item = hit.item === BOUNDARY_ADD_SLOT ? undefined : hit.item
    // Shift-grab of a bound inputs item: pick up the WHOLE binding fan-out
    // and seek a replacement source, exactly like Shift-grab of a real
    // output pin's fan-out. A legal drop on a real output unbinds every
    // sink from the item and link.connects the new source to each, in one
    // batch. Items with no bindings fall through to the fresh drag.
    if (side === 'inputs' && item !== undefined) {
      const bindings = scene.links.filter(
        (l) => l.from.kind === 'boundary' && l.from.side === 'inputs' && l.from.item === item,
      )
      if (endpointDragMode('out', bindings.length > 0, shift) === 'move-source') {
        const sinks: PortEndpointJson[] = bindings
          .filter((l): l is SceneLink & { to: Extract<SceneLink['to'], { kind: 'port' }> } => l.to.kind === 'port')
          .map((l) => ({
            node: l.to.node,
            port: l.to.port,
            ...(l.to.members !== undefined ? { members: l.to.members } : {}),
          }))
        // Exclude sink nodes from the targets: dropping there would self-loop.
        const sinkNodes = new Set(sinks.map((s) => s.node))
        const targets = this.innerPinTargets(scene, hit.type, 'out')
        for (const key of [...targets]) {
          if (sinkNodes.has(key.slice(0, key.indexOf(':')))) targets.delete(key)
        }
        return {
          kind: 'link',
          anchor: { x: hit.x, y: hit.y },
          seeking: 'out',
          anchorType: hit.type,
          ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
          boundaryMoveSource: {
            item,
            sinks,
            toEnds: bindings.map((l) => ({ x: l.x2, y: l.y2 })),
          },
          hideLinkIds: new Set(bindings.map((l) => l.id)),
          dropTargets: targets,
          moved: false,
        }
      }
    }
    const seeking = side === 'inputs' ? 'in' : 'out'
    // The outputs-side item's current source anchors a space-drop unbind.
    let boundaryPrev: BoundaryEndpointJson | undefined
    if (side === 'outputs' && item !== undefined) {
      const bound = scene.links.find((l) => l.id === `boundary:outputs:${item}`)
      if (bound && endpointDragMode('in', true, shift) !== 'replace-candidate') {
        if (bound.from.kind === 'port') {
          boundaryPrev = {
            node: bound.from.node,
            port: bound.from.port,
            ...(bound.from.members !== undefined ? { members: bound.from.members } : {}),
          }
        } else if (bound.from.kind === 'widgetTap') {
          boundaryPrev = { node: bound.from.node, tap: bound.from.input }
        }
      }
    }
    return {
      kind: 'link',
      anchor: { x: hit.x, y: hit.y },
      seeking,
      anchorType: hit.type,
      ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
      boundarySource: { side, ...(item !== undefined ? { item } : {}) },
      ...(boundaryPrev !== undefined ? { boundaryPrev } : {}),
      dropTargets: this.innerPinTargets(scene, hit.type, seeking),
      moved: false,
    }
  }

  /**
   * Grab an existing boundary INPUT binding at the inner pin it drives.
   * Drop on another input re-points it; a space drop unbinds (removing the
   * item when the primary was the last binding).
   */
  private beginBoundaryRewire(
    scene: Scene,
    link: SceneLink,
    hit: Extract<Hit, { kind: 'pin' }>,
  ): Gesture {
    const from = link.from as Extract<SceneLink['from'], { kind: 'boundary' }>
    const prevIsPrimary = link.id === `boundary:${from.side}:${from.item}`
    const bnode = scene.boundaryNodes.find((b) => b.side === 'inputs')
    const pin = bnode?.layout.pins.find((p) => p.portId === from.item)
    const anchorType: TypeExpr = pin?.type ?? hit.type
    return {
      kind: 'link',
      anchor: { x: link.x1, y: link.y1 },
      seeking: 'in',
      anchorType,
      ...(canonicalTypeIdOf(anchorType) !== undefined ? { anchorTypeName: canonicalTypeIdOf(anchorType)! } : {}),
      boundaryRewire: {
        item: from.item,
        prev: pinEndpoint(hit.node.id, hit.pin),
        prevIsPrimary,
      },
      hideLinkIds: new Set([link.id]),
      dropTargets: this.innerPinTargets(scene, anchorType, 'in'),
      moved: false,
    }
  }

  /** Shift replacement candidate for an input driven by a boundary binding. */
  private beginBoundaryInputReplacement(
    scene: Scene,
    link: SceneLink,
    hit: Extract<Hit, { kind: 'pin' }>,
    fixedMaterialize: MaterializeStep | undefined,
  ): Gesture {
    const from = link.from as Extract<SceneLink['from'], { kind: 'boundary' }>
    const fresh = this.beginFreshInputGesture(scene, hit, fixedMaterialize, true)
    return {
      ...fresh,
      boundaryInputReplacement: {
        item: from.item,
        prev: pinEndpoint(hit.node.id, hit.pin),
      },
    }
  }

  /**
   * Node pins of `direction` compatible with `type`. Input boundaries land on
   * real inputs; output boundaries may also land on widget-output taps.
   */
  private innerPinTargets(scene: Scene, type: TypeExpr, direction: 'in' | 'out'): Set<string> {
    const keys = new Set<string>()
    for (const node of scene.nodes) {
      for (const pin of node.layout.pins) {
        if (pin.direction !== direction || pin.familyOwner !== undefined && pin.familyOwner.socketed !== true) continue
        const ok = direction === 'in' ? typesCompatible(type, pin.type) : typesCompatible(pin.type, type)
        if (ok) keys.add(dropTargetKey(node.id, pin.portId, pin.direction, pin.widgetTap === true))
      }
    }
    return keys
  }

  /**
   * Union boundary pseudo-node pins into a fresh port drag's targets:
   * seeking 'in' (drag from an inner output) may land on the Outputs panel
   * (any type - re-pointing/exposing replaces the derived type); seeking
   * 'out' (drag from an inner input) may land on the Inputs panel when the
   * item's type is compatible, or on its blank slot always.
   */
  private withBoundaryTargets(
    scene: Scene,
    keys: Set<string>,
    type: TypeExpr,
    seeking: 'in' | 'out',
  ): Set<string> {
    const side = seeking === 'in' ? 'outputs' : 'inputs'
    const bnode = scene.boundaryNodes.find((b) => b.side === side)
    if (!bnode) return keys
    for (const pin of bnode.layout.pins) {
      if (pin.portId === BOUNDARY_ADD_SLOT || side === 'outputs' || typesCompatible(pin.type, type)) {
        keys.add(boundaryTargetKey(side, pin.portId))
      }
    }
    return keys
  }

  /** Build the shared Shift move-source gesture for any output endpoint kind. */
  private beginMoveSourceGesture(
    scene: Scene,
    anchor: { readonly x: number; readonly y: number },
    type: TypeExpr,
    fanOut: readonly SceneLink[],
    sourceNode = '',
  ): Gesture | undefined {
    if (fanOut.length === 0) return undefined
    // Net deliveries in the fan-out move via net.setSource (their scene link
    // ids are synthetic); ordinary links move via link.rewireSource. One
    // batch commits both.
    const docLinks = fanOut.filter((link) => link.netId === undefined)
    const netIds = [...new Set(fanOut.flatMap((link) => (link.netId !== undefined ? [link.netId] : [])))]
    const effectiveLinks = fanOut.flatMap((link) => link.effectiveIdentities ?? (link.effectiveIdentity === undefined ? [] : [link.effectiveIdentity]))
    // A fan-out mixing occurrence-owned and definition-owned links cannot be
    // re-sourced atomically by either command path; an all-definition fan-out
    // stays on the ordinary link.rewireSource path even while drilled.
    if (
      scene.occurrence !== undefined && effectiveLinks.length > 0 &&
      fanOut.some((link) => link.effectiveIdentity === undefined && link.effectiveIdentities === undefined)
    ) return undefined
    const sinkNodes = new Set(fanOut.flatMap((link) => link.to.kind === 'port' ? [link.to.node] : []))
    const sinkEnds: PortEndpointJson[] = fanOut.flatMap((link) =>
      link.to.kind === 'port'
        ? [{ node: link.to.node, port: link.to.port, ...(link.to.members !== undefined ? { members: link.to.members } : {}) }]
        : [],
    )
    const targets = this.compatibleTargets(scene, type, 'out', sourceNode)
    for (const key of [...targets]) {
      if (sinkNodes.has(key.slice(0, key.indexOf(':')))) targets.delete(key)
    }
    // A net's source must be a real node output port: when the fan-out
    // carries net membership, reroutes, value sources, selectors, and widget
    // taps cannot receive the drop.
    if (netIds.length > 0) {
      const portKeys = new Set<string>()
      for (const node of scene.nodes) {
        for (const pin of node.layout.pins) {
          if (pin.direction === 'out' && pin.widgetTap !== true) portKeys.add(dropTargetKey(node.id, pin.portId, 'out'))
        }
      }
      for (const key of [...targets]) {
        if (!portKeys.has(key)) targets.delete(key)
      }
    }
    return {
      kind: 'link',
      anchor,
      seeking: 'out',
      anchorType: type,
      ...(canonicalTypeIdOf(type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(type)! } : {}),
      moveSource: {
        linkIds: docLinks.map((link) => link.id),
        ...(effectiveLinks.length > 0 ? { effectiveLinks } : {}),
        ...(netIds.length > 0 ? { netIds } : {}),
        toEnds: fanOut.map((link) => ({ x: link.x2, y: link.y2 })),
      },
      hideLinkIds: new Set(fanOut.map((link) => link.id)),
      dropTargets: targets,
      moved: false,
    }
  }

  /**
   * Alt+drag from a reroute dot or grab of its ghost OUTPUT socket: pull a
   * new noodle out of the junction (fan-out). `anchor` defaults to the dot
   * center (Alt+drag); socket grabs anchor at the socket.
   */
  private beginRerouteLinkGesture(
    scene: Scene,
    reroute: SceneReroute,
    anchor?: { x: number; y: number },
    shift = false,
  ): Gesture {
    const anchorType: TypeExpr = reroute.typeName
      ? { kind: 'concrete', name: reroute.typeName }
      : { kind: 'wildcard' }
    const fanOut = scene.links.filter((link) => link.from.kind === 'reroute' && link.from.reroute === reroute.id)
    if (endpointDragMode('out', fanOut.length > 0, shift) === 'move-source') {
      const move = this.beginMoveSourceGesture(scene, anchor ?? { x: reroute.x, y: reroute.y }, anchorType, fanOut)
      if (move) return move
    }
    return {
      kind: 'link',
      presenceOrigin: { kind: 'reroute', reroute: reroute.id, side: 'out' },
      anchor: anchor ?? { x: reroute.x, y: reroute.y },
      seeking: 'in',
      anchorType,
      ...(reroute.typeName ? { anchorTypeName: reroute.typeName } : {}),
      fromReroute: reroute.id,
      dropTargets: this.compatibleTargets(scene, anchorType, 'in', '', reroute.id),
      moved: false,
    }
  }

  /**
   * Grab of a reroute's ghost INPUT socket: seek a producer for the
   * junction. The drop connects INTO the reroute; link.connect's ordinary
   * semantics replace any existing driver (one undo step).
   */
  private beginRerouteInLinkGesture(
    scene: Scene,
    reroute: SceneReroute,
    anchor: { x: number; y: number },
    shift = false,
  ): Gesture {
    const anchorType: TypeExpr = reroute.typeName
      ? { kind: 'concrete', name: reroute.typeName }
      : { kind: 'wildcard' }
    const connected = scene.links.some((link) => link.to.kind === 'reroute' && link.to.reroute === reroute.id)
    return {
      kind: 'link',
      presenceOrigin: { kind: 'reroute', reroute: reroute.id, side: 'in' },
      anchor,
      seeking: 'out',
      anchorType,
      ...(reroute.typeName ? { anchorTypeName: reroute.typeName } : {}),
      intoReroute: reroute.id,
      ...(endpointDragMode('in', connected, shift) === 'replace-candidate' ? { preserveInputDriver: true } : {}),
      dropTargets: this.compatibleTargets(scene, anchorType, 'out', '', reroute.id),
      moved: false,
    }
  }

  /** Drag from a value source's output pin: pull a new noodle out of it. */
  private beginValueSourceLinkGesture(scene: Scene, hit: Extract<Hit, { kind: 'valueSourceOut' }>): Gesture {
    return {
      kind: 'link',
      anchor: { x: hit.x, y: hit.y },
      seeking: 'in',
      anchorType: hit.type,
      ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
      fromValueSource: hit.valueSource.id,
      dropTargets: this.compatibleTargets(scene, hit.type, 'in', ''),
      moved: false,
    }
  }

  /** Drag from a selector's output pin: pull a new noodle out of it (fan-out). */
  private beginSelectorOutLinkGesture(scene: Scene, hit: Extract<Hit, { kind: 'selectorOut' }>): Gesture {
    return {
      kind: 'link',
      anchor: { x: hit.x, y: hit.y },
      seeking: 'in',
      anchorType: hit.type,
      ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
      fromSelector: hit.selector.id,
      dropTargets: this.compatibleTargets(scene, hit.type, 'in', '', undefined, hit.selector.id),
      moved: false,
    }
  }

  /**
   * Drag from a candidate's branch input pin: grab the existing driver
   * (rewire), else seek an output for a fresh connect into the branch.
   */
  private beginSelectorInLinkGesture(scene: Scene, hit: Extract<Hit, { kind: 'selectorIn' }>): Gesture {
    const existing = scene.links.find(
      (l) => l.to.kind === 'selector' && l.to.selector === hit.selector.id && l.to.candidate === hit.candidate,
    )
    if (existing) return this.beginRewire(scene, existing)
    return {
      kind: 'link',
      anchor: { x: hit.x, y: hit.y },
      seeking: 'out',
      anchorType: hit.type,
      ...(canonicalTypeIdOf(hit.type) !== undefined ? { anchorTypeName: canonicalTypeIdOf(hit.type)! } : {}),
      intoSelector: { selector: hit.selector.id, candidate: hit.candidate },
      dropTargets: this.compatibleTargets(scene, hit.type, 'out', '', undefined, hit.selector.id),
      moved: false,
    }
  }

  /**
   * Grab an existing link at its input end; the ghost hangs off its source
   * end. `fanOut` keeps the grabbed link INTACT and drags a fresh noodle
   * from the same driver instead (Alt-grab: fan the value out).
   */
  private beginRewire(scene: Scene, link: SceneLink, fanOut = false): Gesture {
    let anchor = { x: link.x1, y: link.y1 }
    let anchorType: TypeExpr = link.typeName ? { kind: 'concrete', name: link.typeName } : { kind: 'wildcard' }
    let excludeNode = ''
    let excludeReroute: string | undefined
    let excludeSelector: string | undefined
    const from = link.from // const binding: narrowing survives the closures below
    const presenceOrigin: LinkDragPresenceOrigin | undefined =
      from.kind === 'port'
        ? { kind: 'port', node: from.node, port: portEndKey(from), side: 'out' }
        : from.kind === 'reroute'
          ? { kind: 'reroute', reroute: from.reroute, side: 'out' }
          : from.kind === 'widgetTap'
            ? { kind: 'widgetTap', node: from.node, input: from.input }
            : undefined
    if (from.kind === 'port') {
      const fromKey = portEndKey(from)
      const fromNode = scene.nodes.find((n) => n.id === from.node)
      // Real output only: a widget tap shares its input's port id on the
      // 'out' side, so an unguarded lookup would anchor/type off the widget
      // row when an output uses the same id.
      const fromPin = fromNode?.layout.pins.find((p) => p.direction === 'out' && p.portId === fromKey && p.widgetTap !== true)
      anchor = (fromNode && pinPosition(fromNode, fromKey, 'out')) ?? anchor
      if (fromPin) anchorType = fromPin.type
      excludeNode = from.node
    } else if (from.kind === 'reroute') {
      const fromReroute = scene.reroutes.find((r) => r.id === from.reroute)
      if (fromReroute) anchor = { x: fromReroute.x, y: fromReroute.y }
      excludeReroute = from.reroute
    } else if (from.kind === 'valueSource') {
      const fromSource = scene.valueSources.find((s) => s.id === from.valueSource)
      if (fromSource) {
        anchor = valueSourcePinPosition(fromSource)
        anchorType = fromSource.effective.type
      }
    } else if (from.kind === 'widgetTap') {
      const fromNode = scene.nodes.find((n) => n.id === from.node)
      const fromPin = fromNode?.layout.pins.find((p) => p.widgetTap === true && p.address.port === from.input)
      if (fromNode && fromPin) {
        anchor = { x: fromNode.x + fromNode.layout.width, y: fromNode.y + fromPin.y }
        anchorType = fromPin.type
      }
      excludeNode = from.node
    } else if (from.kind === 'selector') {
      // A from-end selector ref is always the output (candidates only consume).
      const fromSel = scene.selectors.find((s) => s.id === from.selector)
      if (fromSel) {
        anchor = selectorOutPinPosition(fromSel)
        if (fromSel.typeName) anchorType = { kind: 'concrete', name: fromSel.typeName }
      }
      excludeSelector = from.selector
    }
    // 'boundary' ends never reach here: boundary noodles are excluded from
    // link hit-testing, so a rewire gesture cannot grab one.
    const targets = this.compatibleTargets(scene, anchorType, 'in', excludeNode, excludeReroute, excludeSelector)
    if (fanOut) {
      // Fresh drag FROM the driver: the grabbed link stays; a drop creates
      // a NEW link via the same completion path as an output-pin drag.
      const source =
        from.kind === 'port'
          ? { fromPort: { node: from.node, port: from.port, ...(from.members !== undefined ? { members: from.members } : {}) } }
          : from.kind === 'reroute'
            ? { fromReroute: from.reroute }
            : from.kind === 'valueSource'
              ? { fromValueSource: from.valueSource }
              : from.kind === 'widgetTap'
                ? { fromTap: { node: from.node, tap: from.input } }
              : from.kind === 'selector'
                ? { fromSelector: from.selector }
                : {}
      return {
        kind: 'link',
        ...(presenceOrigin !== undefined ? { presenceOrigin } : {}),
        anchor,
        seeking: 'in',
        anchorType,
        ...(canonicalTypeIdOf(anchorType) !== undefined ? { anchorTypeName: canonicalTypeIdOf(anchorType)! } : {}),
        ...source,
        dropTargets: from.kind === 'port' || from.kind === 'widgetTap'
          ? this.withBoundaryTargets(scene, targets, anchorType, 'in')
          : targets,
        moved: false,
      }
    }
    // A net delivery grabbed at its sink: same gesture surface as a link
    // rewire, but the drop dispatches net commands (the synthetic scene link
    // id never reaches link.rewire/link.disconnect).
    if (link.netId !== undefined && link.to.kind === 'port') {
      return {
        kind: 'link',
        ...(presenceOrigin !== undefined ? { presenceOrigin } : {}),
        anchor,
        seeking: 'in',
        anchorType,
        ...(canonicalTypeIdOf(anchorType) !== undefined ? { anchorTypeName: canonicalTypeIdOf(anchorType)! } : {}),
        netRewire: {
          netId: link.netId,
          prev: { node: link.to.node, port: link.to.port, ...(link.to.members !== undefined ? { members: link.to.members } : {}) },
          ...(from.kind === 'port'
            ? { source: { node: from.node, port: from.port, ...(from.members !== undefined ? { members: from.members } : {}) } }
            : {}),
        },
        hideLinkIds: new Set([link.id]),
        dropTargets: targets,
        moved: false,
      }
    }
    return {
      kind: 'link',
      ...(presenceOrigin !== undefined ? { presenceOrigin } : {}),
      anchor,
      seeking: 'in',
      anchorType,
      ...(canonicalTypeIdOf(anchorType) !== undefined ? { anchorTypeName: canonicalTypeIdOf(anchorType)! } : {}),
      rewireLinkId: link.id,
      hideLinkIds: new Set([link.id]),
      dropTargets: targets,
      moved: false,
    }
  }

  /**
   * All legal drop targets for a link drag: pins of `direction` (excluding
   * `excludeNode`) type-compatible with `type`, plus reroute junctions.
   * Seeking 'in', a reroute accepts a new driver when its current effective
   * type matches (or it is undriven); seeking 'out', a reroute is a valid
   * source under the same rule. Cycle-forming drops are rejected by the core
   * command, not predicted here.
   *
   * core.combo is an ordinary concrete atom, so TypeExpr compatibility is
   * the whole legal-drop decision.
   */
  private compatibleTargets(
    scene: Scene,
    type: TypeExpr,
    direction: 'in' | 'out',
    excludeNode: string,
    excludeReroute?: string,
    excludeSelector?: string,
  ): Set<string> {
    const keys = new Set<string>()
    for (const node of scene.nodes) {
      if (node.id === excludeNode) continue
      for (const pin of node.layout.pins) {
        if (pin.direction !== direction || pin.familyOwner !== undefined && pin.familyOwner.socketed !== true) continue
        const ok = direction === 'in' ? typesCompatible(type, pin.type) : typesCompatible(pin.type, type)
        if (ok) keys.add(dropTargetKey(node.id, pin.portId, direction, pin.widgetTap === true))
      }
    }
    for (const r of scene.reroutes) {
      if (r.id === excludeReroute) continue
      const rType: TypeExpr = r.typeName ? { kind: 'concrete', name: r.typeName } : { kind: 'wildcard' }
      const ok = direction === 'in' ? typesCompatible(type, rType) : typesCompatible(rType, type)
      if (ok) keys.add(rerouteTargetKey(r.id))
    }
    // Value sources only PRODUCE (invariant I10): they are drop targets only
    // when the drag seeks an output.
    if (direction === 'out') {
      for (const vs of scene.valueSources) {
        if (typesCompatible(vs.effective.type, type)) keys.add(valueSourceTargetKey(vs.id))
      }
    }
    // Selectors: candidate pins consume (seeking 'in'), the output produces
    // (seeking 'out'). Traced types are advisory - an undriven branch or an
    // unresolved output is a wildcard passthrough. Cycle-forming drops are
    // rejected by the core command, not predicted here.
    for (const sel of scene.selectors) {
      if (sel.id === excludeSelector) continue
      if (direction === 'in') {
        for (const c of sel.candidates) {
          const cType: TypeExpr = c.typeName ? { kind: 'concrete', name: c.typeName } : { kind: 'wildcard' }
          if (typesCompatible(type, cType)) keys.add(selectorInTargetKey(sel.id, c.id))
        }
      } else {
        const outType: TypeExpr = sel.typeName ? { kind: 'concrete', name: sel.typeName } : { kind: 'wildcard' }
        if (typesCompatible(outType, type)) keys.add(selectorOutTargetKey(sel.id))
      }
    }
    return keys
  }

  /**
   * Deterministically choose a node-body drop slot. Inputs with no driver
   * rank before driven inputs; outputs fan out, so every output is free.
   * Within a rank, layout pin order is the declared/elaborated order. The
   * legal-target set is the same structural compatibility decision used by
   * explicit pin drops. Iterating all ranked pins avoids stopping at an
   * early slot that fails that full drag-specific validation.
   */
  private bodyDropCandidate(
    g: Extract<Gesture, { kind: 'link' }>,
    scene: Scene,
    node: SceneNode,
  ): Extract<Hit, { kind: 'pin' }> | undefined {
    if (g.bodyCandidateNode === node) return g.bodyCandidate
    g.bodyCandidateNode = node
    g.bodyCandidate = undefined
    // Widget taps are excluded: a body drop lands on real ports only (a tap
    // ranked here would commit as a bogus PORT endpoint via pinEndpoint);
    // explicit tap-pin hits keep their own 'widgetTap' hit path.
    const pins = node.layout.pins.filter((pin) =>
      pin.direction === g.seeking && pin.widgetTap !== true &&
      (pin.familyOwner === undefined || pin.familyOwner.socketed === true),
    )
    // Links hidden by the gesture (the grabbed rewire or net delivery) do
    // not occupy their sink: the drag is moving them off it.
    const isOccupied = (pin: PinLayout): boolean =>
      pin.direction === 'in' && scene.links.some((link) =>
        link.id !== g.rewireLinkId && g.hideLinkIds?.has(link.id) !== true &&
        link.to.kind === 'port' && link.to.node === node.id && portEndKey(link.to) === pin.portId,
      )
    const ranked = [...pins.filter((pin) => !isOccupied(pin)), ...pins.filter(isOccupied)]
    for (const pin of ranked) {
      if (!g.dropTargets.has(dropTargetKey(node.id, pin.portId, pin.direction))) continue
      const position = pinPosition(node, pin.portId, pin.direction, pin.widgetTap === true)
      if (!position) continue
      g.bodyCandidate = {
        kind: 'pin', node, pin, portId: pin.portId, direction: pin.direction,
        x: position.x, y: position.y, type: pin.type,
      }
      break
    }
    return g.bodyCandidate
  }

  /**
   * Ordinary body autosnap stays out of the narrow socket lanes. Geometry is
   * derived from the current SceneNode layout: the side depth shares the pin
   * hit radius, while the first/last visible real pin centers bound a band
   * that includes compact between-socket gaps. Explicit pin hits are resolved
   * before this helper and remain unchanged.
   */
  private bodyDropEligible(
    g: Extract<Gesture, { kind: 'link' }>,
    scene: Scene,
    node: SceneNode,
    w: { x: number; y: number },
  ): boolean {
    if (node.layout.minimized) return true
    const localX = w.x - node.x
    const localY = w.y - node.y
    const coordinateTolerance = POINTER_COORDINATE_TOLERANCE_PX /
      Math.max(this.renderer.getViewport().scale, Number.EPSILON)
    const pinRevealed = this.pinRevealed(scene, g.dropTargets)
    const inRenderedPinBand = (direction: 'in' | 'out'): boolean => {
      let minY = Infinity
      let maxY = -Infinity
      for (const pin of node.layout.pins) {
        if (
          pin.direction === direction &&
          (pin.familyOwner === undefined || pin.familyOwner.socketed === true) &&
          pin.widgetTap !== true &&
          pinRevealed(node, pin)
        ) {
          minY = Math.min(minY, pin.y)
          maxY = Math.max(maxY, pin.y)
        }
      }
      if (minY === Infinity) return false
      const nearSide = direction === 'in'
        ? localX >= 0 && localX <= PIN_HIT_RADIUS + coordinateTolerance
        : localX >= node.layout.width - PIN_HIT_RADIUS - coordinateTolerance && localX <= node.layout.width
      return nearSide &&
        localY >= minY - PIN_HIT_RADIUS - coordinateTolerance &&
        localY <= maxY + PIN_HIT_RADIUS + coordinateTolerance
    }
    return !inRenderedPinBand('in') && !inRenderedPinBand('out')
  }

  private nodeOfBodyHit(hit: Hit): SceneNode | undefined {
    return hit.kind === 'body' || hit.kind === 'header' || hit.kind === 'widget' ||
      hit.kind === 'section' || hit.kind === 'growth' || hit.kind === 'resize'
      ? hit.node
      : undefined
  }

  /** Boundary-panel counterpart of bodyDropCandidate. Existing rows keep
   * declared order, free inputs rank before occupied inputs, and the trailing
   * expose slot is considered last. The explicit-pin legal-target set remains
   * the single validator for both preview and commit. */
  private boundaryBodyDropCandidate(
    g: Extract<Gesture, { kind: 'link' }>,
    scene: Scene,
    bnode: SceneBoundaryNode,
  ): Extract<Hit, { kind: 'boundary-pin' }> | undefined {
    const direction = bnode.side === 'inputs' ? 'out' : 'in'
    if (direction !== g.seeking) return undefined
    const pins = bnode.layout.pins.filter((pin) => pin.direction === direction)
    const occupied = (item: string): boolean => scene.links.some((link) =>
      link.from.kind === 'boundary' && link.from.side === bnode.side && link.from.item === item ||
      link.to.kind === 'boundary' && link.to.side === bnode.side && link.to.item === item,
    )
    const existing = pins.filter((pin) => pin.portId !== BOUNDARY_ADD_SLOT)
    const ranked = direction === 'in'
      ? [...existing.filter((pin) => !occupied(pin.portId)), ...existing.filter((pin) => occupied(pin.portId))]
      : existing
    ranked.push(...pins.filter((pin) => pin.portId === BOUNDARY_ADD_SLOT))
    for (const pin of ranked) {
      if (!g.dropTargets.has(boundaryTargetKey(bnode.side, pin.portId))) continue
      return {
        kind: 'boundary-pin', bnode, item: pin.portId, direction,
        x: direction === 'in' ? bnode.x : bnode.x + bnode.layout.width,
        y: bnode.y + pin.y, type: pin.type, ...(pin.regionIndex ? { regionIndex: true } : {}),
      }
    }
    return undefined
  }

  private controllerChipContains(hit: Extract<Hit, { kind: 'widget' }>): boolean {
    const { row } = hit
    return controllerChipContains(hit.localX, hit.localY, hit.width, row.height)
  }

  private widgetRowAffordanceContains(hit: Extract<Hit, { kind: 'widget' }>): boolean {
    const capabilities = this.renderer.getLensCapabilities?.()
    const affordance = capabilities?.widgetRowAffordance?.(hit.node, hit.row)
    if (affordance === undefined || affordance.disabled === true) return false
    const rect = widgetRowAffordanceRect(hit.width, this.renderer.getDesignTokens().rowHeight, hit.row)
    return hit.localX >= rect.x && hit.localX <= rect.x + rect.width &&
      hit.localY >= rect.y && hit.localY <= rect.y + rect.height
  }

  private previewSurfaceAffordanceContains(node: SceneNode, worldX: number, worldY: number): boolean {
    const affordance = this.renderer.getLensCapabilities?.().previewSurfaceAffordance?.(node)
    if (affordance === undefined || affordance.disabled === true) return false
    const rect = previewSurfaceAffordanceRect(node)
    if (rect === undefined) return false
    const localX = worldX - node.x
    const localY = worldY - node.y
    return localX >= rect.x && localX <= rect.x + rect.width &&
      localY >= rect.y && localY <= rect.y + rect.height
  }

  // -- gesture progress ------------------------------------------------------

  private onPointerMove(e: PointerEvent): void {
    if (this.handleTouchNavMove(e)) return
    const ownedGesture =
      this.activePointerId === e.pointerId && this.gesture.kind !== 'idle'
    this.processPointerMove(e)
    if (
      ownedGesture &&
      e.buttons === 0 &&
      this.activePointerId === e.pointerId &&
      this.gesture.kind !== 'idle'
    ) {
      const { sx, sy } = this.toScreen(e)
      this.commitGesture(
        e.pointerId,
        this.renderer.toWorld(sx, sy),
        e.clientX,
        e.clientY,
        false,
        'synthetic-buttons0',
      )
    }
  }

  /**
   * Re-resolve idle hover (and its onHoverTarget announcement) at the last
   * known pointer position. Scene replacements prune stale hover state but
   * produce no pointer event, so a tooltip pending or visible under a
   * stationary pointer would otherwise vanish until the next real move.
   */
  refreshHover(): void {
    if (this.gesture.kind !== 'idle' || this.idlePointer === undefined) return
    this.updateIdleHover(this.idlePointer.clientX, this.idlePointer.clientY)
  }

  /**
   * Idle motion only tracks hover reveals (reroute ghost sockets,
   * widget-backed pins on the hovered node). No scene rebuild: both are
   * pure overlay state.
   */
  private updateIdleHover(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    const w = this.renderer.toWorld(clientX - rect.left, clientY - rect.top)
    const scene = this.renderer.getScene()
    const toolbox = this.renderer.getToolboxLayout()
    const toolboxButton = toolbox ? hitTestToolbox(toolbox, w.x, w.y) : undefined
    const toolboxInside = toolbox !== undefined && insideToolbox(toolbox, w.x, w.y)
    const overview = this.renderer.getDetailLevel() === 'overview'
    // Hover state updates BEFORE the hit test: the reveal contracts
    // (widget-backed pins on the hovered node, ghost sockets on the
    // hovered reroute) must see THIS event's hover, not the previous
    // event's - a single-jump move onto a widget-backed pin has to hit
    // it, and clearing a departed hover here (setHover emits the
    // onHoverTarget(undefined)) before announcing the new target below
    // avoids the show-then-clear flicker of the old order (SH2).
    // Sockets reveal on APPROACH: the whole halo (dot, either socket,
    // the stems between) triggers, so aiming straight at a socket
    // position works without first crossing the dot.
    this.setHover(
      toolboxInside || overview ? undefined : hitTestRerouteRevealZone(scene, w.x, w.y)?.id,
      toolboxInside ? undefined : hoveredNodeAt(scene, w.x, w.y)?.id,
      toolboxButton,
    )
    const badge = toolboxInside || overview
      ? undefined
      : hitTestBadge(scene, this.renderer.getBadges(), w.x, w.y)
    const hit = toolboxInside || badge ? undefined : hitTest(scene, w.x, w.y, this.hitOptions({
      ...(this.hoveredReroute ? { rerouteSockets: this.hoveredReroute } : {}),
      widgetTaps: this.widgetTapHits(scene),
      pinRevealed: this.pinRevealed(scene),
    }))
    this.setAffordanceHover(hit)
    this.setLinkMidpointHover(hit?.kind === 'link' && hit.midpoint ? hit.link.id : undefined)
    this.canvas.style.cursor = hit?.kind === 'resize' || hit?.kind === 'group-resize'
      ? hit.handle === 'nw' || hit.handle === 'se'
        ? 'nwse-resize'
        : 'nesw-resize'
      : ''
    const controllerChip = hit?.kind === 'widget' && hit.row.controllerMode !== undefined
      && this.controllerChipContains(hit)
    this.host.onHoverTarget?.(toolboxButton
      ? { kind: 'toolbox', button: toolboxButton, x: clientX, y: clientY }
      : badge
        ? { kind: 'badge', hit: badge, x: clientX, y: clientY }
      : controllerChip
        ? { kind: 'controller', hit, x: clientX, y: clientY }
      : hit && (hit.kind === 'pin' || hit.kind === 'widgetTap' || hit.kind === 'widget' || hit.kind === 'header' || hit.kind === 'reroute' ||
        hit.kind === 'link' && hit.link.mismatch === true)
        ? { kind: hit.kind, hit, x: clientX, y: clientY } as CanvasHoverTarget
        : undefined)
  }

  private processPointerMove(e: PointerEvent): void {
    // Only the pointer that owns the gesture advances it; other pointers
    // (a stray touch during a mouse drag) neither move it nor update hover.
    if (this.activePointerId !== undefined && e.pointerId !== this.activePointerId) return
    const g = this.gesture
    if (g.kind === 'idle') {
      this.idlePointer = { clientX: e.clientX, clientY: e.clientY }
      this.updateIdleHover(e.clientX, e.clientY)
      return
    }
    const { sx, sy } = this.toScreen(e)
    {
      const lw = this.renderer.toWorld(sx, sy)
      this.lastGesturePoint = { wx: lw.x, wy: lw.y, cx: e.clientX, cy: e.clientY }
    }
    const passed = Math.hypot(sx - this.downX, sy - this.downY) >= DRAG_THRESHOLD

    switch (g.kind) {
      case 'pan': {
        const { x, y, scale } = this.renderer.getViewport()
        this.renderer.setViewport({ x: x + e.clientX - g.lastX, y: y + e.clientY - g.lastY, scale })
        g.lastX = e.clientX
        g.lastY = e.clientY
        if (passed) g.moved = true
        return
      }
      case 'marquee': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        this.pushOverlay({
          marquee: {
            x1: Math.min(g.startWX, w.x),
            y1: Math.min(g.startWY, w.y),
            x2: Math.max(g.startWX, w.x),
            y2: Math.max(g.startWY, w.y),
          },
        })
        return
      }
      case 'link-press':
        if (passed) g.moved = true
        return
      case 'node': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const dx = w.x - g.startWX
        const dy = w.y - g.startWY
        const ids = [...g.nodeIds, ...g.rerouteIds, ...g.valueSourceIds, ...g.selectorIds, ...g.boundarySides.map(boundarySceneId), ...g.groupIds, ...g.netViewIds]
        const offsets = new Map(ids.map((id) => [id, { dx, dy }]))
        this.pushOverlay({ dragOffsets: offsets })
        return
      }
      case 'reroute-move': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const dx = w.x - g.startWX
        const dy = w.y - g.startWY
        this.pushOverlay({ dragOffsets: new Map(g.rerouteIds.map((id) => [id, { dx, dy }])) })
        return
      }
      case 'boundary-move': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const dx = w.x - g.startWX
        const dy = w.y - g.startWY
        this.pushOverlay({ dragOffsets: new Map([[boundarySceneId(g.side), { dx, dy }]]) })
        return
      }
      case 'value-source-move': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const dx = w.x - g.startWX
        const dy = w.y - g.startWY
        this.pushOverlay({ dragOffsets: new Map(g.valueSourceIds.map((id) => [id, { dx, dy }])) })
        return
      }
      case 'selector-move': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const dx = w.x - g.startWX
        const dy = w.y - g.startWY
        this.pushOverlay({ dragOffsets: new Map(g.selectorIds.map((id) => [id, { dx, dy }])) })
        return
      }
      case 'link': {
        if (passed) g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const scene = this.renderer.getScene()
        const fanMove = g.moveSource ?? g.boundaryMoveSource
        if (fanMove !== undefined) {
          // The cursor drags the shared source end; every sink stays fixed.
          const ghosts: GhostLink[] = fanMove.toEnds.map((t) => ({
            x1: w.x,
            y1: w.y,
            x2: t.x,
            y2: t.y,
            ...(g.anchorTypeName ? { typeName: g.anchorTypeName } : {}),
          }))
          this.pushOverlay({
            ghostLinks: ghosts,
            dropTargets: g.dropTargets,
            ...(g.hideLinkIds !== undefined ? { hiddenLinkIds: g.hideLinkIds } : {}),
          })
          return
        }
        const hit = hitTest(scene, w.x, w.y, this.hitOptions({ pinRevealed: this.pinRevealed(scene, g.dropTargets) }))
        const explicitPin = hit.kind === 'pin' && hit.direction === g.seeking &&
          g.dropTargets.has(dropTargetKey(hit.node.id, hit.portId, hit.direction))
          ? hit
          : undefined
        const rawBodyNode = explicitPin ? undefined : this.nodeOfBodyHit(hit)
        const bodyNode = rawBodyNode && this.bodyDropEligible(g, scene, rawBodyNode, w) ? rawBodyNode : undefined
        const boundaryBody = !explicitPin && (hit.kind === 'boundary-body' || hit.kind === 'boundary-header') ? hit.bnode : undefined
        const boundaryCandidate = boundaryBody ? this.boundaryBodyDropCandidate(g, scene, boundaryBody) : undefined
        const nodeCandidate = explicitPin ?? (bodyNode ? this.bodyDropCandidate(g, scene, bodyNode) : undefined)
        const candidate = nodeCandidate ?? boundaryCandidate
        if (!bodyNode) {
          g.bodyCandidateNode = undefined
          g.bodyCandidate = undefined
        }
        const end = candidate ?? w
        const ghost: GhostLink =
          g.seeking === 'in'
            ? {
                x1: g.anchor.x, y1: g.anchor.y, x2: end.x, y2: end.y,
                ...(g.anchorTypeName ? { typeName: g.anchorTypeName } : {}),
              }
            : {
                x1: end.x, y1: end.y, x2: g.anchor.x, y2: g.anchor.y,
                ...(g.anchorTypeName ? { typeName: g.anchorTypeName } : {}),
              }
        this.pushOverlay({
          ghostLink: ghost,
          dropTargets: nodeCandidate
            ? new Set([dropTargetKey(nodeCandidate.node.id, nodeCandidate.portId, nodeCandidate.direction)])
            : boundaryCandidate ? new Set([boundaryTargetKey(boundaryCandidate.bnode.side, boundaryCandidate.item)]) : g.dropTargets,
          ...(bodyNode && nodeCandidate ? { bodyDropNode: bodyNode.id } : {}),
          ...(boundaryBody && boundaryCandidate ? { bodyDropNode: boundarySceneId(boundaryBody.side) } : {}),
          ...(g.hideLinkIds !== undefined ? { hiddenLinkIds: g.hideLinkIds } : {}),
        })
        return
      }
      case 'widget':
      case 'widget-affordance':
      case 'preview-affordance':
      case 'section':
      case 'growth':
        if (passed) g.moved = true
        return
      case 'resize': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const bounds = resizedNodeBounds(
          g.start,
          g.anchorX, g.anchorY, w.x + g.grabOffsetX, w.y + g.grabOffsetY,
          g.handle, g.minW, g.minH,
        )
        this.pushOverlay({ resizePreview: { nodeId: g.nodeId, ...bounds } })
        return
      }
      case 'group': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const dx = w.x - g.startWX
        const dy = w.y - g.startWY
        this.pushOverlay({
          dragOffsets: new Map([
            ...g.memberIds.map((id) => [id, { dx, dy }] as const),
            ...g.rerouteIds.map((id) => [id, { dx, dy }] as const),
            ...g.valueSourceIds.map((id) => [id, { dx, dy }] as const),
            ...g.selectorIds.map((id) => [id, { dx, dy }] as const),
            ...g.boundarySides.map((side) => [boundarySceneId(side), { dx, dy }] as const),
          ]),
          groupDragOffset: { groupId: g.groupId, dx, dy },
        })
        return
      }
      case 'group-resize': {
        if (!passed && !g.moved) return
        g.moved = true
        const w = this.renderer.toWorld(sx, sy)
        const bounds = resizedNodeBounds(
          g.start,
          g.anchorX, g.anchorY, w.x + g.grabOffsetX, w.y + g.grabOffsetY,
          g.handle, GROUP_MIN_SIZE, GROUP_MIN_SIZE,
        )
        this.pushOverlay({ groupResizeGhost: { groupId: g.groupId, ...bounds } })
        return
      }
    }
  }

  // -- gesture completion ----------------------------------------------------

  private onPointerUp(e: PointerEvent): void {
    if (this.endTouchPointer(e, 'pointerup')) return
    // Only the owning pointer can complete the gesture.
    if (this.activePointerId !== undefined && e.pointerId !== this.activePointerId) return
    const { sx, sy } = this.toScreen(e)
    this.commitGesture(
      e.pointerId,
      this.renderer.toWorld(sx, sy),
      e.clientX,
      e.clientY,
      false,
      'pointerup',
    )
  }

  /**
   * Complete the in-flight gesture at world position w: the ordinary
   * pointerup path (which projects the release event through the current
   * viewport), and the completion point for a capture loss that ends a
   * move/resize-family gesture (which supplies the last TRACKED world
   * position, because a lostpointercapture event carries no useful
   * coordinates and the viewport may have changed since the last move).
   * Client coordinates anchor activation popups (editor cards, menus).
   */
  private commitGesture(
    pointerId: number,
    w: { x: number; y: number },
    clientX: number,
    clientY: number,
    requireLegalLinkTarget = false,
    reason: PointerTraceReason = 'pointerup',
  ): void {
    const g = this.gesture
    const gestureGraphId = this.gestureGraphId
    this.gesture = { kind: 'idle' }
    this.activePointerId = undefined
    this.activeButtonMask = undefined
    this.activePointerType = undefined
    this.gestureGraphId = undefined
    this.lastGesturePoint = undefined
    this.releasePointer(pointerId)
    if (g.kind === 'idle') return
    const scene = this.renderer.getScene()
    // Belt-and-braces behind the scene-replacement hook: captured ids must
    // never commit into a graph other than the one they were captured on.
    if (g.kind !== 'pan' && gestureGraphId !== undefined && scene.graphId !== gestureGraphId) {
      this.pointerTrace.recordGesture(g.kind, 'cancel', 'scene-replaced')
      this.pushOverlay()
      return
    }

    if (g.kind !== 'link') this.pointerTrace.recordGesture(g.kind, 'commit', reason)

    switch (g.kind) {
      case 'pan':
        if (!g.moved && g.keepSelection !== true) this.setSelection([])
        return
      case 'link-press':
        if (!g.moved && !g.modified && g.midpoint && g.linkId !== undefined) {
          const link = scene.links.find((candidate) => candidate.id === g.linkId)
          if (link !== undefined && link.boundary !== true && link.hidden !== true && link.netId === undefined)
            this.host.onLinkDoubleClick?.(linkMenuContext(link, w), clientX, clientY)
        }
        return
      case 'marquee': {
        if (!g.moved) {
          // Motionless empty click: clear (Shift-click on empty keeps).
          if (!g.additive) this.setSelection([])
          this.pushOverlay()
          return
        }
        const x1 = Math.min(g.startWX, w.x)
        const y1 = Math.min(g.startWY, w.y)
        const x2 = Math.max(g.startWX, w.x)
        const y2 = Math.max(g.startWY, w.y)
        const overlaps = (bx: number, by: number, bw: number, bh: number): boolean =>
          bx < x2 && bx + bw > x1 && by < y2 && by + bh > y1
        const nodes = scene.nodes.filter((n) => overlaps(n.x, n.y, n.layout.width, n.layout.height)).map((n) => n.id)
        const boundaries = scene.boundaryNodes.filter((n) => {
          const cx = n.x + n.layout.width / 2
          const cy = n.y + n.layout.height / 2
          return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2
        }).map((n) => boundarySceneId(n.side))
        const reroutes = scene.reroutes.filter((r) => r.x >= x1 && r.x <= x2 && r.y >= y1 && r.y <= y2).map((r) => r.id)
        const valueSources = scene.valueSources.filter((v) => overlaps(v.x, v.y, v.width, v.height)).map((v) => v.id)
        const selectors = scene.selectors.filter((s) => overlaps(s.x, s.y, s.width, s.height)).map((s) => s.id)
        const netViews = scene.netStubs.filter((stub) => overlaps(stub.x, stub.y, stub.width, stub.height)).map((stub) => stub.id)
        const groups = scene.groups.filter((group) => {
          const cx = group.x + group.width / 2
          const cy = group.y + group.height / 2
          return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2
        }).map((group) => group.id)
        if (g.additive) {
          this.setSelection(
            [...this.selection, ...nodes, ...boundaries],
            this.linkSelection,
            [...this.rerouteSelection, ...reroutes],
            [...this.valueSourceSelection, ...valueSources],
            [...this.selectorSelection, ...selectors],
            [...this.groupSelection, ...groups],
            [...this.netViewSelection, ...netViews],
          )
        } else {
          this.setSelection([...nodes, ...boundaries], [], reroutes, valueSources, selectors, groups, netViews)
        }
        return
      }
      case 'widget':
        this.pushOverlay()
        if (!g.moved) {
          // Boundary bindings on a SELECTOR row forward the construct, not a
          // value: the row stays the occurrence-local editor (edits route to
          // the owning instance), so only real links make it inert.
          const bindingOk = (link: SceneLink) => g.hit.row.selector === undefined || link.boundary !== true
          const connected = scene.links.some(
            (link) => bindingOk(link) && link.to.kind === 'port' && link.to.node === g.hit.node.id && link.to.port === g.hit.row.inputId,
          )
          // The connected value wins; editing the dormant value invites confusion.
          if (connected) return
          const row = g.hit.row
          // Paint and interaction share the same row-local chip rectangle;
          // the rightmost numeric stepper remains outside it.
          if (row.controllerMode !== undefined && this.controllerChipContains(g.hit)) {
            this.host.onControllerActivate?.(g.hit, clientX, clientY)
            return
          }
          const numeric = row.spec.widgetType === 'INT' || row.spec.widgetType === 'FLOAT'
          const direction = g.hit.localX <= WIDGET_EDGE_CONTROL_WIDTH
            ? -1
            : g.hit.localX >= g.hit.width - WIDGET_EDGE_CONTROL_WIDTH ? 1 : 0
          if (numeric && row.derivedValue === undefined && !row.ghost && direction !== 0) {
            const stored = g.hit.node.node.values[row.valueKey]
            const intrinsic = this.host.resolveWidgetDefault?.(row.spec)
            const current = row.spec.widgetType === 'INT'
              ? isIntegerWidgetValue(stored)
                ? stored
                : isIntegerWidgetValue(row.spec.default)
                  ? row.spec.default
                  : isIntegerWidgetValue(intrinsic) ? intrinsic : undefined
              : typeof stored === 'number'
                ? stored
                : typeof row.spec.default === 'number'
                  ? row.spec.default
                  : typeof intrinsic === 'number' ? intrinsic : undefined
            if (current !== undefined) {
              // Shared with controller advancement (core numeric-step): the
              // stepper and queue-time advancement must not drift.
              const constraints = numericStepConstraints({ widgetType: row.spec.widgetType, options: row.spec.options ?? {} })
              const value = stepNumericValue(current, direction, constraints)
              this.host.dispatch({
                command: 'node.setValue',
                params: {
                  graphId: row.familyOwner?.graphId ?? scene.graphId,
                  nodeId: row.familyOwner?.nodeId ?? g.hit.node.id,
                  inputId: row.familyOwner?.valueKey ?? row.valueKey,
                  value,
                },
              })
            }
            // A numeric edge zone is an independent control even if an
            // unknown extension kind cannot resolve a starting value. It
            // never falls through and opens the body editor.
            return
          }
          this.host.onWidgetActivate?.(g.hit, clientX, clientY)
        }
        return
      case 'widget-affordance':
        this.pushOverlay()
        const affordance = this.renderer.getLensCapabilities().widgetRowAffordance?.(g.hit.node, g.hit.row)
        if (!g.moved && affordance !== undefined && affordance.disabled !== true) {
          this.host.onWidgetRowAffordanceActivate?.(g.hit)
        }
        return
      case 'preview-affordance': {
        this.pushOverlay()
        const affordance = this.renderer.getLensCapabilities().previewSurfaceAffordance?.(g.node)
        if (!g.moved && affordance !== undefined && affordance.disabled !== true) {
          this.host.onPreviewSurfaceAffordanceActivate?.(g.node)
        }
        return
      }
      case 'section':
        this.pushOverlay()
        if (!g.moved) {
          this.host.dispatch({
            command: 'view.setSectionCollapsed',
            params: {
              graphId: scene.graphId,
              nodeId: g.hit.node.id,
              sectionId: g.hit.row.sectionId,
              collapsed: !g.hit.row.collapsed,
            },
          })
        }
        return
      case 'growth':
        // Click-to-add: persist the offered member (plus min-fill siblings)
        // so its inner families elaborate - the affordance for a nested-only
        // template whose ghost has no slot to connect or edit.
        this.pushOverlay()
        if (!g.moved) {
          this.host.dispatch({
            command: 'dynamic.materialize',
            params: {
              graphId: g.hit.row.familyOwner?.graphId ?? scene.graphId,
              nodeId: g.hit.row.familyOwner?.nodeId ?? g.hit.node.id,
              frames: g.hit.row.frames.map((f, index) => ({ construct: index === g.hit.row.frames.length - 1 ? (g.hit.row.familyOwner?.construct ?? f.construct) : f.construct, members: [...f.members] })),
            },
          })
        }
        return
      case 'node': {
        if (!g.moved) {
          this.pushOverlay()
          const valueSource = g.pressedValueSourceId === undefined
            ? undefined
            : scene.valueSources.find((candidate) => candidate.id === g.pressedValueSourceId)
          if (valueSource) this.host.onValueSourceActivate?.(valueSource, clientX, clientY)
          return
        }
        if (
          g.nodeIds.length > 0 || g.rerouteIds.length > 0 || g.valueSourceIds.length > 0 ||
          g.selectorIds.length > 0 || g.boundarySides.length > 0 || g.groupIds.length > 0 || g.netViewIds.length > 0
        ) {
          const dx = w.x - g.startWX
          const dy = w.y - g.startWY
          // Round to 0.01 world units: screen->world transforms produce
          // float noise that would otherwise pollute the serialized document.
          const snap = (v: number) => Math.round(v * 100) / 100
          const positions: Record<string, { x: number; y: number }> = {}
          for (const id of g.nodeIds) {
            const node = scene.nodes.find((n) => n.id === id)
            if (node) positions[id] = { x: snap(node.x + dx), y: snap(node.y + dy) }
          }
          const moved = <T extends { id: string; x: number; y: number }>(items: readonly T[], ids: readonly string[]) => {
            const out: Record<string, { x: number; y: number }> = {}
            for (const id of ids) {
              const item = items.find((candidate) => candidate.id === id)
              if (item) out[id] = { x: snap(item.x + dx), y: snap(item.y + dy) }
            }
            return out
          }
          const reroutes = moved(scene.reroutes, g.rerouteIds)
          const valueSources = moved(scene.valueSources, g.valueSourceIds)
          const selectors = moved(scene.selectors, g.selectorIds)
          const netViews = g.netViewIds.flatMap((id) => {
            const stub = scene.netStubs.find((candidate) => candidate.id === id)
            if (stub === undefined) return []
            const position = { x: snap(stub.x + dx), y: snap(stub.y + dy) }
            return [{
              netId: stub.netId,
              role: stub.role,
              ...(stub.role === 'sink' ? {
                to: { node: stub.nodeId, port: stub.portId, ...(stub.members === undefined ? {} : { members: [...stub.members] }) },
              } : {}),
              position,
            }]
          })
          const groups = Object.fromEntries(g.groupIds.flatMap((id) => {
            const group = scene.groups.find((candidate) => candidate.id === id)
            return group ? [[id, { x: snap(group.x + dx), y: snap(group.y + dy) }]] : []
          }))
          const boundary: Partial<Record<'inputs' | 'outputs', { x: number; y: number }>> = {}
          for (const side of g.boundarySides) {
            const node = scene.boundaryNodes.find((candidate) => candidate.side === side)
            if (node) boundary[side] = { x: snap(node.x + dx), y: snap(node.y + dy) }
          }
          const kindCount = [positions, reroutes, valueSources, selectors, boundary, groups].filter((map) => Object.keys(map).length > 0).length + (netViews.length > 0 ? 1 : 0)
          const boundaryEntries = Object.entries(boundary) as ['inputs' | 'outputs', { x: number; y: number }][]
          const soloBoundary = boundaryEntries.length === 1 ? boundaryEntries[0] : undefined
          const onlyNodes = Object.keys(positions).length > 0 &&
            [reroutes, valueSources, selectors, boundary, groups].every((map) => Object.keys(map).length === 0) && netViews.length === 0
          if (kindCount === 0) {
            // Every captured id vanished during the drag (same-graph rebuild
            // deleted them): there is nothing to move, so dispatch nothing.
            this.pushOverlay()
            return
          }
          this.host.dispatch(
            kindCount === 1 && soloBoundary
              ? {
                  command: 'view.moveBoundaryNode',
                  params: { graphId: scene.graphId, side: soloBoundary[0], position: soloBoundary[1] },
                }
              : !onlyNodes
              ? {
                  command: 'selection.move',
                  params: {
                    graphId: scene.graphId,
                    nodes: positions,
                    ...(Object.keys(reroutes).length ? { reroutes } : {}),
                    ...(Object.keys(valueSources).length ? { valueSources } : {}),
                    ...(Object.keys(selectors).length ? { selectors } : {}),
                    ...(Object.keys(boundary).length ? { boundary } : {}),
                    ...(Object.keys(groups).length ? { groups } : {}),
                    ...(netViews.length ? { netViews } : {}),
                  },
                }
              : { command: 'node.move', params: { graphId: scene.graphId, positions } },
          )
        }
        this.pushOverlay() // drop transient offsets; scene rebuild follows commit
        return
      }
      case 'reroute-move': {
        if (g.moved && g.rerouteIds.length > 0) {
          const dx = w.x - g.startWX
          const dy = w.y - g.startWY
          const snap = (v: number) => Math.round(v * 100) / 100
          const positions: Record<string, { x: number; y: number }> = {}
          for (const id of g.rerouteIds) {
            const r = scene.reroutes.find((sr) => sr.id === id)
            if (r) positions[id] = { x: snap(r.x + dx), y: snap(r.y + dy) }
          }
          // ONE undoable command for the whole drag, however many dots moved.
          // Nothing survived a mid-drag rebuild: nothing to move, no dispatch.
          if (Object.keys(positions).length > 0)
            this.host.dispatch({
              command: 'reroute.move',
              params: { graphId: scene.graphId, positions },
            })
        }
        this.pushOverlay() // drop transient offsets; scene rebuild follows commit
        return
      }
      case 'boundary-move': {
        if (g.moved) {
          const bnode = scene.boundaryNodes.find((b) => b.side === g.side)
          if (bnode) {
            const snap = (v: number) => Math.round(v * 100) / 100
            this.host.dispatch({
              command: 'view.moveBoundaryNode',
              params: {
                graphId: scene.graphId,
                side: g.side,
                position: { x: snap(bnode.x + (w.x - g.startWX)), y: snap(bnode.y + (w.y - g.startWY)) },
              },
            })
          }
        }
        this.pushOverlay() // drop transient offsets; scene rebuild follows commit
        return
      }
      case 'value-source-move': {
        if (g.moved && g.valueSourceIds.length > 0) {
          const dx = w.x - g.startWX
          const dy = w.y - g.startWY
          const snap = (v: number) => Math.round(v * 100) / 100
          const positions: Record<string, { x: number; y: number }> = {}
          for (const id of g.valueSourceIds) {
            const vs = scene.valueSources.find((sv) => sv.id === id)
            if (vs) positions[id] = { x: snap(vs.x + dx), y: snap(vs.y + dy) }
          }
          // ONE undoable command for the whole drag, however many pills moved.
          // Nothing survived a mid-drag rebuild: nothing to move, no dispatch.
          if (Object.keys(positions).length > 0)
            this.host.dispatch({
              command: 'valueSource.move',
              params: { graphId: scene.graphId, positions },
            })
        }
        this.pushOverlay() // drop transient offsets; scene rebuild follows commit
        if (!g.moved) {
          // Click without drag: open the value editor (the pill IS the widget).
          const vs = scene.valueSources.find((sv) => sv.id === g.pressedId)
          if (vs) this.host.onValueSourceActivate?.(vs, clientX, clientY)
        }
        return
      }
      case 'selector-move': {
        if (g.moved && g.selectorIds.length > 0) {
          const dx = w.x - g.startWX
          const dy = w.y - g.startWY
          const snap = (v: number) => Math.round(v * 100) / 100
          const positions: Record<string, { x: number; y: number }> = {}
          for (const id of g.selectorIds) {
            const sel = scene.selectors.find((ss) => ss.id === id)
            if (sel) positions[id] = { x: snap(sel.x + dx), y: snap(sel.y + dy) }
          }
          // ONE undoable command for the whole drag, however many boxes moved.
          // Nothing survived a mid-drag rebuild: nothing to move, no dispatch.
          if (Object.keys(positions).length > 0)
            this.host.dispatch({
              command: 'selector.move',
              params: { graphId: scene.graphId, positions },
            })
        }
        this.pushOverlay() // drop transient offsets; scene rebuild follows commit
        return
      }
      case 'link': {
        const allowEmptyMoveSourceDisconnect =
          reason === 'pointerup' || reason === 'synthetic-buttons0' || reason === 'mouseup-fallback'
        const strictRejected = this.completeLink(g, scene, w, requireLegalLinkTarget, allowEmptyMoveSourceDisconnect) === false
        if (strictRejected) {
          this.pointerTrace.recordGesture(
            g.kind,
            'cancel',
            reason === 'pointercancel-strict-commit'
              ? 'pointercancel-cancel'
              : 'lostpointercapture-cancel',
          )
        } else this.pointerTrace.recordGesture(g.kind, 'commit', reason)
        this.pushOverlay()
        return
      }
      case 'resize': {
        // Same-graph rebuilds mid-drag keep the gesture alive, so the node
        // may have been deleted underneath it: commit only if it survived
        // (matching how move commits skip vanished ids).
        if (g.moved && scene.nodes.some((n) => n.id === g.nodeId)) {
          // Round to whole world units: manual sizes are user-visible document
          // state and sub-pixel float noise has no meaning there.
          const bounds = resizedNodeBounds(
            g.start,
            g.anchorX, g.anchorY, w.x + g.grabOffsetX, w.y + g.grabOffsetY,
            g.handle, g.minW, g.minH,
          )
          const width = Math.round(bounds.width)
          const visibleHeight = Math.round(bounds.height)
          const height = Math.round(bounds.height - g.heightOffset)
          // Derive the moving-side position from the captured edge and the
          // rounded size. The persisted opposite edge is therefore exactly
          // the captured world anchor, without feeding layout float noise
          // into the node position.
          const x = g.handle.includes('w') ? g.anchorX - width : g.anchorX
          const y = g.handle.includes('n') ? g.anchorY - visibleHeight : g.anchorY
          this.host.dispatch({
            command: 'view.setNodeSize',
            params: { graphId: scene.graphId, nodeId: g.nodeId, size: { width, height }, position: { x, y } },
          })
        }
        this.pushOverlay() // drop the preview; scene rebuild follows commit
        return
      }
      case 'group': {
        if (g.moved) {
          const group = scene.groups.find((sg) => sg.id === g.groupId)
          if (group) {
            const dx = w.x - g.startWX
            const dy = w.y - g.startWY
            const snap = (v: number) => Math.round(v * 100) / 100
            const positions: Record<string, { x: number; y: number }> = {}
            const reroutes: Record<string, { x: number; y: number }> = {}
            const valueSources: Record<string, { x: number; y: number }> = {}
            const selectors: Record<string, { x: number; y: number }> = {}
            const boundary: Partial<Record<'inputs' | 'outputs', { x: number; y: number }>> = {}
            for (const id of g.memberIds) {
              const node = scene.nodes.find((n) => n.id === id)
              if (node) positions[id] = { x: snap(node.x + dx), y: snap(node.y + dy) }
            }
            for (const id of g.rerouteIds) {
              const reroute = scene.reroutes.find((r) => r.id === id)
              if (reroute) reroutes[id] = { x: snap(reroute.x + dx), y: snap(reroute.y + dy) }
            }
            for (const id of g.valueSourceIds) {
              const vs = scene.valueSources.find((v) => v.id === id)
              if (vs) valueSources[id] = { x: snap(vs.x + dx), y: snap(vs.y + dy) }
            }
            for (const id of g.selectorIds) {
              const sel = scene.selectors.find((s) => s.id === id)
              if (sel) selectors[id] = { x: snap(sel.x + dx), y: snap(sel.y + dy) }
            }
            for (const side of g.boundarySides) {
              const node = scene.boundaryNodes.find((b) => b.side === side)
              if (node) boundary[side] = { x: snap(node.x + dx), y: snap(node.y + dy) }
            }
            // ONE undoable command: the rectangle plus every item it carried.
            this.host.dispatch({
              command: 'view.moveGroup',
              params: {
                graphId: scene.graphId,
                groupId: g.groupId,
                bounds: { x: snap(group.x + dx), y: snap(group.y + dy) },
                positions,
                ...(Object.keys(reroutes).length ? { reroutes } : {}),
                ...(Object.keys(valueSources).length ? { valueSources } : {}),
                ...(Object.keys(selectors).length ? { selectors } : {}),
                ...(Object.keys(boundary).length ? { boundary } : {}),
              },
            })
          }
        }
        this.pushOverlay() // drop transient offsets; scene rebuild follows commit
        return
      }
      case 'group-resize': {
        if (g.moved) {
          const group = scene.groups.find((sg) => sg.id === g.groupId)
          if (group) {
            const resized = resizedNodeBounds(
              g.start,
              g.anchorX, g.anchorY, w.x + g.grabOffsetX, w.y + g.grabOffsetY,
              g.handle, GROUP_MIN_SIZE, GROUP_MIN_SIZE,
            )
            const width = Math.round(resized.width)
            const height = Math.round(resized.height)
            const x = g.handle.includes('w') ? g.anchorX - width : g.anchorX
            const y = g.handle.includes('n') ? g.anchorY - height : g.anchorY
            this.host.dispatch({
              command: 'view.setGroupBounds',
              params: {
                graphId: scene.graphId,
                groupId: g.groupId,
                bounds: { x, y, width, height },
              },
            })
          }
        }
        this.pushOverlay() // drop the ghost; scene rebuild follows commit
        return
      }
    }
  }

  private completeLink(
    g: Extract<Gesture, { kind: 'link' }>,
    scene: Scene,
    w: { x: number; y: number },
    requireLegalTarget = false,
    allowEmptyMoveSourceDisconnect = false,
  ): false | void {
    // ONE hitTest resolves the drop with the SAME priority as hover (pins
    // and node bodies beat reroute dots): a junction hidden behind a node
    // can never silently steal a drop aimed at the visible surface.
    const rawHit = hitTest(scene, w.x, w.y, this.hitOptions({
      widgetTaps: this.widgetTapHits(scene, g.dropTargets),
      pinRevealed: this.pinRevealed(scene, g.dropTargets),
    }))
    // Explicit pin hit-testing always wins. Only otherwise may a regular
    // node surface resolve to its cached ranked slot. Boundary pseudo-nodes
    // retain their specialized explicit-pin behavior.
    const rawBodyNode = rawHit.kind === 'pin' ? undefined : this.nodeOfBodyHit(rawHit)
    const bodyNode = rawBodyNode && this.bodyDropEligible(g, scene, rawBodyNode, w) ? rawBodyNode : undefined
    if (!bodyNode) {
      g.bodyCandidateNode = undefined
      g.bodyCandidate = undefined
    }
    const boundaryBody = rawHit.kind === 'boundary-body' || rawHit.kind === 'boundary-header' ? rawHit.bnode : undefined
    const hit: Hit = boundaryBody
      ? (this.boundaryBodyDropCandidate(g, scene, boundaryBody) ?? rawHit)
      : bodyNode ? (this.bodyDropCandidate(g, scene, bodyNode) ?? rawHit) : rawHit
    const rerouteLegal = hit.kind === 'reroute' && g.dropTargets.has(rerouteTargetKey(hit.reroute.id))
    const pinLegal =
      hit.kind === 'pin' &&
      (hit.pin.familyOwner === undefined || hit.pin.familyOwner.socketed === true) &&
      hit.direction === g.seeking &&
      g.dropTargets.has(dropTargetKey(hit.node.id, hit.portId, hit.direction))
    const tapLegal = hit.kind === 'widgetTap' && g.seeking === 'out' &&
      g.dropTargets.has(dropTargetKey(hit.node.id, hit.pin.portId, 'out', true))
    // Value sources only produce: a drop on their pin is legal only when the
    // drag seeks an output (started from a free input).
    const valueSourceLegal =
      hit.kind === 'valueSourceOut' && g.seeking === 'out' && g.dropTargets.has(valueSourceTargetKey(hit.valueSource.id))
    // Selector candidate pins consume; the output pin produces.
    const selectorInLegal =
      hit.kind === 'selectorIn' &&
      g.seeking === 'in' &&
      g.dropTargets.has(selectorInTargetKey(hit.selector.id, hit.candidate))
    const selectorOutLegal =
      hit.kind === 'selectorOut' && g.seeking === 'out' && g.dropTargets.has(selectorOutTargetKey(hit.selector.id))

    /** Where the dragged end landed, as a STRUCTURAL link endpoint (or nowhere legal). */
    const regionIndexLegal = hit.kind === 'boundary-pin' && hit.regionIndex === true &&
      g.seeking === 'out' && g.dropTargets.has(boundaryTargetKey(hit.bnode.side, hit.item))
    const dropEnd = regionIndexLegal
      ? { node: '$region', port: 'index' }
      : rerouteLegal
        ? { reroute: hit.reroute.id }
      : pinLegal
        ? pinEndpoint(hit.node.id, hit.pin)
        : tapLegal
          ? { node: hit.node.id, tap: hit.input }
        : valueSourceLegal
          ? { valueSource: hit.valueSource.id }
          : selectorInLegal
            ? { selector: hit.selector.id, candidate: hit.candidate }
            : selectorOutLegal
              ? { selector: hit.selector.id }
              : undefined
    // A drop on a synthetic (ghost/min-fill) pin materializes in the same batch.
    const dropMaterialize = pinLegal ? pinMaterialize(hit.node.id, hit.pin) : undefined
    const boundaryLegal =
      hit.kind === 'boundary-pin' && hit.regionIndex !== true && g.dropTargets.has(boundaryTargetKey(hit.bnode.side, hit.item))
    if (requireLegalTarget && dropEnd === undefined && !boundaryLegal) return false
    const graphId = scene.graphId
    const sameEnd = (a: PortEndpointJson, b: PortEndpointJson): boolean =>
      a.node === b.node &&
      a.port === b.port &&
      (a.members ?? []).length === (b.members ?? []).length &&
      (a.members ?? []).every((m, i) => (b.members ?? [])[i] === m)
    const endParams = (end: BoundaryEndpointJson): JsonObject =>
      'tap' in end
        ? { node: end.node, tap: end.tap }
        : {
            node: end.node,
            port: end.port,
            ...(end.members !== undefined ? { members: [...end.members] } : {}),
          }

    // Shift fan-out move: a legal drop re-sources every grabbed link in one
    // link.rewireSource transaction. A committed empty-canvas drop disconnects
    // the whole fan-out in one batch; cancellation still snaps it back.
    if (g.moveSource !== undefined) {
      if (dropEnd) {
        if (scene.occurrence !== undefined && g.moveSource.effectiveLinks !== undefined) {
          this.host.dispatchOccurrenceMutation?.({
            kind: 'rewireSource',
            owner: scene.occurrence.owner,
            bodyGraph: scene.occurrence.bodyGraph,
            links: g.moveSource.effectiveLinks,
            from: this.occurrenceEndpoint(scene, dropEnd, 'out'),
          })
          return
        }
        const moveOps: CommandInvocation[] = [
          ...(g.moveSource.linkIds.length > 0
            ? [
                {
                  command: 'link.rewireSource',
                  params: { graphId, linkIds: [...g.moveSource.linkIds], from: dropEnd },
                } as CommandInvocation,
              ]
            : []),
          ...(g.moveSource.netIds ?? []).map(
            (netId) =>
              ({
                command: 'net.setSource',
                params: { graphId, netId, source: dropEnd },
              }) as CommandInvocation,
          ),
        ]
        if (moveOps.length > 0) this.host.dispatch(composeBatch(graphId, [dropMaterialize], moveOps))
      } else if (allowEmptyMoveSourceDisconnect && g.moved && hit.kind === 'empty') {
        if (scene.occurrence !== undefined && g.moveSource.effectiveLinks !== undefined) {
          if (g.moveSource.effectiveLinks.length === 1) {
            this.host.dispatchOccurrenceMutation?.({
              kind: 'disconnect',
              owner: scene.occurrence.owner,
              bodyGraph: scene.occurrence.bodyGraph,
              link: g.moveSource.effectiveLinks[0]!,
            })
          } else {
            this.host.onOccurrenceMutationRefused?.(
              'occurrence.link.bulkDisconnectUnsupported',
              'Disconnect occurrence fan-out links separately.',
            )
          }
          return
        }
        // Only ordinary links disconnect on an empty drop; a net always has
        // a source, so net deliveries in the fan-out snap back unchanged.
        if (g.moveSource.linkIds.length === 0) return
        const moved = new Set(g.moveSource.linkIds)
        const freedNodes = scene.links.flatMap((link) =>
          moved.has(link.id) && link.to.kind === 'port' ? [link.to.node] : [],
        )
        this.host.dispatch(
          composeBatch(
            graphId,
            [],
            g.moveSource.linkIds.map((linkId) => ({
              command: 'link.disconnect',
              params: { graphId, linkId },
            } as CommandInvocation)),
            freedNodes,
          ),
        )
      }
      return
    }

    // Boundary fan-out move (Shift-grab of an inputs-side item's bindings):
    // a legal drop on a real output unbinds every sink from the item and
    // connects the dropped output to each, in ONE batch - the boundary
    // mirror of link.rewireSource. Anything else snaps the noodles back.
    if (g.boundaryMoveSource !== undefined) {
      const bms = g.boundaryMoveSource
      if (pinLegal && hit.direction === 'out' && dropEnd) {
        const ops: CommandInvocation[] = [
          ...bms.sinks.map(
            (sink) =>
              ({
                command: 'boundary.unbind',
                params: { graphId, side: 'inputs', itemId: bms.item, ...endParams(sink) },
              }) as CommandInvocation,
          ),
          ...bms.sinks.map(
            (sink) =>
              ({
                command: 'link.connect',
                params: { graphId, from: dropEnd, to: endParams(sink) },
              }) as CommandInvocation,
          ),
        ]
        this.host.dispatch(composeBatch(graphId, [dropMaterialize], ops))
      }
      return
    }

    // Boundary rewire: an existing boundary INPUT binding grabbed at its
    // inner end. Drop re-points it; a moved space-drop unbinds it. The old
    // destination compacts in the same transaction when no reference remains.
    if (g.boundaryRewire !== undefined) {
      const br = g.boundaryRewire
      if (pinLegal && hit.direction === 'in') {
        const end = pinEndpoint(hit.node.id, hit.pin)
        if (sameEnd(end, br.prev)) return
        const ops: CommandInvocation[] = br.prevIsPrimary
          ? [
              {
                command: 'boundary.setBinding',
                params: { graphId, side: 'inputs', itemId: br.item, ...endParams(end) },
              } as CommandInvocation,
            ]
          : [
              {
                command: 'boundary.removeBinding',
                params: { graphId, itemId: br.item, ...endParams(br.prev) },
              } as CommandInvocation,
              {
                command: 'boundary.addBinding',
                params: { graphId, itemId: br.item, ...endParams(end) },
              } as CommandInvocation,
            ]
        this.host.dispatch(composeBatch(graphId, [dropMaterialize], ops, [br.prev.node]))
      } else if (g.moved) {
        this.host.dispatch(
          composeBatch(
            graphId,
            [],
            [
              {
                command: 'boundary.unbind',
                params: { graphId, side: 'inputs', itemId: br.item, ...endParams(br.prev) },
              } as CommandInvocation,
            ],
            [br.prev.node],
          ),
        )
      }
      return
    }


    // Shift replacement of a boundary-driven real input: cancellation keeps
    // the binding; a legal source atomically unbinds it and connects the new
    // producer to the same input.
    if (g.boundaryInputReplacement !== undefined) {
      const replacement = g.boundaryInputReplacement
      if (dropEnd) {
        this.host.dispatch(
          composeBatch(graphId, [g.fixedMaterialize, dropMaterialize], [
            {
              command: 'boundary.unbind',
              params: { graphId, side: 'inputs', itemId: replacement.item, ...endParams(replacement.prev) },
            } as CommandInvocation,
            {
              command: 'link.connect',
              params: { graphId, from: dropEnd, to: endParams(replacement.prev) },
            } as CommandInvocation,
          ]),
        )
      } else if (
        hit.kind === 'boundary-pin' &&
        hit.bnode.side === 'inputs' &&
        g.dropTargets.has(boundaryTargetKey('inputs', hit.item)) &&
        hit.item !== replacement.item
      ) {
        const bind: CommandInvocation = hit.item === BOUNDARY_ADD_SLOT
          ? {
              command: 'boundary.addItem',
              params: { graphId, side: 'inputs', ...endParams(replacement.prev) },
            } as CommandInvocation
          : {
              command: 'boundary.addBinding',
              params: { graphId, itemId: hit.item, ...endParams(replacement.prev) },
            } as CommandInvocation
        this.host.dispatch(
          composeBatch(graphId, [g.fixedMaterialize], [
            {
              command: 'boundary.unbind',
              params: { graphId, side: 'inputs', itemId: replacement.item, ...endParams(replacement.prev) },
            } as CommandInvocation,
            bind,
          ]),
        )
      }
      return
    }
    // Fresh drag FROM a boundary pseudo-node pin: exposure edits on drop.
    if (g.boundarySource !== undefined) {
      const bs = g.boundarySource
      if ((pinLegal && hit.direction === g.seeking) || (bs.side === 'outputs' && tapLegal)) {
        const end: BoundaryEndpointJson = tapLegal
          ? { node: hit.node.id, tap: hit.input }
          : pinEndpoint(hit.node.id, hit.pin)
        const op: CommandInvocation =
          bs.side === 'inputs'
            ? bs.item === undefined
              ? ({ command: 'boundary.addItem', params: { graphId, side: 'inputs', ...endParams(end) } } as CommandInvocation)
              : ({ command: 'boundary.addBinding', params: { graphId, itemId: bs.item, ...endParams(end) } } as CommandInvocation)
            : bs.item === undefined
              ? ({ command: 'boundary.addItem', params: { graphId, side: 'outputs', ...endParams(end) } } as CommandInvocation)
              : ({
                  command: 'boundary.setBinding',
                  params: { graphId, side: 'outputs', itemId: bs.item, ...endParams(end) },
                } as CommandInvocation)
        this.host.dispatch(composeBatch(graphId, [dropMaterialize], [op]))
      } else if (g.moved && bs.side === 'outputs' && bs.item !== undefined && g.boundaryPrev !== undefined) {
        // Dragged an exposed output off into space: un-expose it.
        this.host.dispatch(
          composeBatch(graphId, [], [
            {
              command: 'boundary.unbind',
              params: { graphId, side: 'outputs', itemId: bs.item, ...endParams(g.boundaryPrev) },
            } as CommandInvocation,
          ]),
        )
      }
      return
    }

    // A fresh port drag dropped ON a boundary pseudo-node pin: expose the
    // fixed end (blank slot) or attach it to an existing boundary item.
    if (boundaryLegal && hit.kind === 'boundary-pin' && g.rewireLinkId === undefined) {
      if (hit.bnode.side === 'inputs' && g.seeking === 'out' && g.intoPort !== undefined) {
        const op: CommandInvocation =
          hit.item === BOUNDARY_ADD_SLOT
            ? ({ command: 'boundary.addItem', params: { graphId, side: 'inputs', ...endParams(g.intoPort) } } as CommandInvocation)
            : ({ command: 'boundary.addBinding', params: { graphId, itemId: hit.item, ...endParams(g.intoPort) } } as CommandInvocation)
        this.host.dispatch(composeBatch(graphId, [g.fixedMaterialize], [op]))
      } else if (hit.bnode.side === 'outputs' && g.seeking === 'in' && (g.fromPort !== undefined || g.fromTap !== undefined)) {
        const source = g.fromPort ?? g.fromTap!
        const op: CommandInvocation =
          hit.item === BOUNDARY_ADD_SLOT
            ? ({ command: 'boundary.addItem', params: { graphId, side: 'outputs', ...endParams(source) } } as CommandInvocation)
            : ({
                command: 'boundary.setBinding',
                params: { graphId, side: 'outputs', itemId: hit.item, ...endParams(source) },
              } as CommandInvocation)
        this.host.dispatch(composeBatch(graphId, [g.fixedMaterialize], [op]))
      }
      return
    }

    // A net delivery grabbed at its sink end. A port drop moves the sink
    // membership (net.connectInput replaces the target's driver, then the
    // old sink detaches - one batch, one undo step). A reroute or selector
    // drop cannot stay a net delivery, so the sink detaches and an ordinary
    // link connects the net's source to the drop. A moved space drop just
    // detaches the sink. The freed node compacts in the same transaction.
    if (g.netRewire !== undefined) {
      const nr = g.netRewire
      if (dropEnd) {
        if ('node' in dropEnd && 'port' in dropEnd) {
          const end = dropEnd as PortEndpointJson
          if (sameEnd(end, nr.prev)) return
          this.host.dispatch(
            composeBatch(
              graphId,
              [dropMaterialize],
              [
                {
                  command: 'net.connectInput',
                  params: { graphId, netId: nr.netId, to: endParams(end) },
                } as CommandInvocation,
                {
                  command: 'net.disconnectInput',
                  params: { graphId, to: endParams(nr.prev) },
                } as CommandInvocation,
              ],
              [nr.prev.node],
            ),
          )
        } else if (nr.source !== undefined) {
          this.host.dispatch(
            composeBatch(
              graphId,
              [],
              [
                {
                  command: 'net.disconnectInput',
                  params: { graphId, to: endParams(nr.prev) },
                } as CommandInvocation,
                {
                  command: 'link.connect',
                  params: { graphId, from: endParams(nr.source), to: dropEnd },
                } as CommandInvocation,
              ],
              [nr.prev.node],
            ),
          )
        }
      } else if (g.moved) {
        this.host.dispatch(
          composeBatch(
            graphId,
            [],
            [
              {
                command: 'net.disconnectInput',
                params: { graphId, to: endParams(nr.prev) },
              } as CommandInvocation,
            ],
            [nr.prev.node],
          ),
        )
      }
      return
    }

    if (g.rewireLinkId !== undefined) {
      const oldLink = scene.links.find((link) => link.id === g.rewireLinkId)
      const freedNodes = oldLink !== undefined && oldLink.to.kind === 'port'
        ? [oldLink.to.node]
        : []
      if (dropEnd) {
        if (scene.occurrence !== undefined && oldLink?.effectiveIdentity !== undefined) {
          this.host.dispatchOccurrenceMutation?.({
            kind: 'rewire',
            owner: scene.occurrence.owner,
            bodyGraph: scene.occurrence.bodyGraph,
            link: oldLink.effectiveIdentity,
            to: this.occurrenceEndpoint(scene, dropEnd, 'in'),
          })
          return
        }
        this.host.dispatch(
          composeBatch(
            graphId,
            [dropMaterialize],
            [
              {
                command: 'link.rewire',
                params: { graphId, linkId: g.rewireLinkId, to: dropEnd },
              } as CommandInvocation,
            ],
            freedNodes,
          ),
        )
      } else if (g.moved) {
        if (scene.occurrence !== undefined && oldLink?.effectiveIdentity !== undefined) {
          this.host.dispatchOccurrenceMutation?.({
            kind: 'disconnect',
            owner: scene.occurrence.owner,
            bodyGraph: scene.occurrence.bodyGraph,
            link: oldLink.effectiveIdentity,
          })
          return
        }
        // Dropped in space: detach and compact the freed destination together.
        this.host.dispatch(
          composeBatch(
            graphId,
            [],
            [
              {
                command: 'link.disconnect',
                params: { graphId, linkId: g.rewireLinkId },
              } as CommandInvocation,
            ],
            freedNodes,
          ),
        )
      }
      return
    }
    // seeking 'in': the fixed end is the source (out-pin or reroute); the drop
    // is the destination. seeking 'out': the fixed end is an input; the drop
    // is the source (out-pin or reroute).
    const fixedFrom =
      g.fromPort ??
      g.fromTap ??
      (g.fromReroute !== undefined
        ? { reroute: g.fromReroute }
        : g.fromValueSource !== undefined
          ? { valueSource: g.fromValueSource }
          : g.fromSelector !== undefined
            ? { selector: g.fromSelector }
            : undefined)
    const fixedInto =
      g.intoPort ??
      (g.intoReroute !== undefined
        ? { reroute: g.intoReroute }
        : g.intoSelector !== undefined
          ? { selector: g.intoSelector.selector, candidate: g.intoSelector.candidate }
          : undefined)
    if (!dropEnd) {
      const boundarySide = hit.kind === 'boundary-pin' || hit.kind === 'boundary-body' || hit.kind === 'boundary-header'
        ? hit.bnode.side
        : undefined
      const unsupportedBoundarySource: BoundaryExposureSource | undefined =
        g.fromTap !== undefined && boundarySide === 'inputs'
          ? { kind: 'widgetTap', node: g.fromTap.node, tap: g.fromTap.tap }
          : boundarySide === 'outputs' && g.fromValueSource !== undefined
            ? { kind: 'valueSource', id: g.fromValueSource }
            : boundarySide === 'outputs' && g.fromSelector !== undefined
              ? { kind: 'selector', id: g.fromSelector }
              : boundarySide === 'outputs' && g.fromReroute !== undefined
                ? { kind: 'reroute', id: g.fromReroute }
                : undefined
      if (g.moved && unsupportedBoundarySource !== undefined && boundarySide !== undefined) {
        this.host.onBoundaryExposureRefused?.(
          'boundary.structuralProducerUnsupported',
          unsupportedBoundarySource,
          boundarySide,
        )
        return
      }
      // A MOVED fresh drag released over truly empty canvas opens the
      // compatible-node search; any other miss (node body, incompatible
      // pin, unmoved click) stays a no-op. Rewires never reach here.
      if (
        g.moved &&
        hit.kind === 'empty' &&
        !g.preserveInputDriver &&
        hasKnownLinkDropAnchorType(g.anchorType) &&
        (g.seeking === 'in' ? fixedFrom : fixedInto) !== undefined
      ) {
        this.host.onLinkDropOnEmpty?.(
          {
            seeking: g.seeking,
            anchorType: g.anchorType,
            ...(g.anchorTypeName !== undefined ? { anchorTypeName: g.anchorTypeName } : {}),
            anchorX: g.anchor.x,
            anchorY: g.anchor.y,
            ...(fixedFrom !== undefined ? { fixedFrom } : {}),
            ...(fixedInto !== undefined ? { fixedInto } : {}),
            ...(g.fixedMaterialize !== undefined ? { fixedMaterialize: g.fixedMaterialize } : {}),
          },
          w.x,
          w.y,
        )
      }
      return
    }
    const from = g.seeking === 'in' ? fixedFrom : dropEnd
    const to = g.seeking === 'in' ? dropEnd : fixedInto
    if (!from || !to) return
    const occurrence = scene.occurrence
    if (occurrence !== undefined) {
      const occurrenceFrom = this.occurrenceEndpoint(scene, from, 'out')
      const occurrenceTo = this.occurrenceEndpoint(scene, to, 'in')
      if (occurrenceFrom.kind === 'boundary' || occurrenceTo.kind === 'boundary' ||
          'node' in from && 'port' in from && from.node === '$region' && from.port === 'index') {
        this.host.dispatchOccurrenceMutation?.({
          kind: 'connect',
          owner: occurrence.owner,
          bodyGraph: occurrence.bodyGraph,
          from: occurrenceFrom,
          to: occurrenceTo,
        })
        return
      }
    }
    // Either end (or both) may need materializing; a rejected connect then
    // rolls back the whole batch, so no orphan member is ever persisted.
    this.host.dispatch(
      withMaterialize(scene.graphId, [g.fixedMaterialize, dropMaterialize], {
        command: 'link.connect',
        params: { graphId: scene.graphId, from, to },
      }),
    )
  }

  private occurrenceEndpoint(scene: Scene, endpoint: JsonObject, direction: 'in' | 'out'): OccurrenceLinkEndpoint {
    const nodeId = endpoint['node']
    const port = endpoint['port']
    if (typeof nodeId === 'string' && typeof port === 'string') {
      const members = Array.isArray(endpoint['members']) ? endpoint['members'] : undefined
      const pin = scene.nodes.find((node) => node.id === nodeId)?.layout.pins.find((candidate) =>
        candidate.direction === direction && candidate.address.port === port &&
        JSON.stringify(candidate.address.members ?? []) === JSON.stringify(members ?? []),
      )
      const familyOwner = pin?.familyOwner
      if (pin !== undefined && familyOwner?.socketed === true && familyOwner.sourceEndpoint !== undefined)
        return familyOwner.sourceEndpoint
    }
    return { kind: 'body', endpoint: endpoint as unknown as LinkEndpoint }
  }

  /**
   * The document identity a context-menu Hit targets, independent of the
   * scene objects carrying it. Used to decide whether a re-resolved hit
   * (after a selection notification replaced the scene) still means the
   * thing the user clicked. Identities are exhaustive per kind: two pins on
   * the same node, two widget rows, two sections, or two boundary items are
   * DIFFERENT menu targets (the app builds materially different menus from
   * pin addresses, widget input ids, and section ids), so a re-hit that
   * drifted to a sibling must not be accepted. The field tuple is
   * JSON-encoded: identifiers are arbitrary strings (see core ids.ts), so
   * no delimiter join is injective - JSON escaping is.
   */
  private menuTargetIdentity(hit: Hit): string | undefined {
    const j = (...parts: readonly string[]): string => JSON.stringify(parts)
    switch (hit.kind) {
      case 'pin':
        return j('pin', hit.node.id, hit.direction, hit.pin.address.port, ...(hit.pin.address.members ?? []))
      case 'widgetTap':
        return j('widgetTap', hit.node.id, hit.input)
      case 'widget':
        return j('widget', hit.node.id, hit.row.inputId)
      case 'section':
        return j('section', hit.node.id, hit.row.sectionId)
      case 'growth':
        return j('growth', hit.node.id, hit.row.construct)
      case 'header':
      case 'body':
        return j('node', hit.node.id)
      case 'resize':
        return j('resize', hit.node.id, hit.handle)
      case 'link':
        return j('link', hit.link.id)
      case 'reroute':
        return j('reroute', hit.reroute.id)
      case 'rerouteSocket':
        return j('rerouteSocket', hit.reroute.id, hit.side)
      case 'valueSource':
      case 'valueSourceBadge':
      case 'valueSourceOut':
        return j('valueSource', hit.valueSource.id)
      case 'selector':
      case 'selectorBadge':
      case 'selectorOut':
        return j('selector', hit.selector.id)
      case 'selectorIn':
        return j('selectorIn', hit.selector.id, hit.candidate)
      case 'netStub':
        return j('net', hit.stub.netId, hit.stub.role, hit.stub.nodeId, hit.stub.portId, ...(hit.stub.members ?? []))
      case 'group-header':
        return j('group', hit.group.id)
      case 'group-resize':
        return j('group-resize', hit.group.id, hit.handle)
      case 'boundary-header':
      case 'boundary-body':
        return j('boundary', hit.bnode.side)
      case 'boundary-pin':
        return j('boundary-pin', hit.bnode.side, hit.item, hit.direction)
      case 'empty':
        return undefined
    }
    // Exhaustiveness: a new Hit kind MUST be given an identity above, or
    // two unrelated instances would compare equal (undefined === undefined)
    // and a drifted re-hit would be accepted as the menu target.
    const exhaustive: never = hit
    return exhaustive
  }

  /**
   * Right-click: adjust selection like a primary click would (an unselected
   * item becomes THE selection; an already-selected item keeps the existing
   * multi-selection; empty space preserves it), then hand off to the host.
   */
  private onContextMenu(e: MouseEvent): void {
    e.preventDefault()
    // Every input except the navigating fingers is inert while two-finger
    // navigation owns the canvas.
    if (this.touchNav !== undefined) return
    // macOS maps Ctrl+left-click to contextmenu and may report the eventual
    // release with secondary-button semantics. End any canvas gesture before
    // opening the menu so that sequence cannot leave a half-owned drag or
    // activate the press on a later pointerup.
    this.cancelGesture('contextmenu')
    const { sx, sy } = this.toScreen(e)
    const w = this.renderer.toWorld(sx, sy)
    const scene = this.renderer.getScene()
    const toolbox = this.renderer.getToolboxLayout()
    if (toolbox && insideToolbox(toolbox, w.x, w.y)) return
    const hit = hitTest(scene, w.x, w.y, this.hitOptions({ pinRevealed: this.pinRevealed(scene) }))
    switch (hit.kind) {
      case 'header':
      case 'body':
      case 'resize':
      case 'widget':
      case 'section':
      case 'growth':
      case 'pin':
        if (!this.selection.has(hit.node.id)) {
          this.selection = new Set([hit.node.id])
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
          this.notifySelection()
          this.pushOverlay()
        }
        break
      case 'link':
        if (!this.linkSelection.has(hit.link.id)) {
          this.selection = new Set()
          this.linkSelection = new Set([hit.link.id])
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
          this.notifySelection()
          this.pushOverlay()
        }
        break
      case 'reroute':
        if (!this.rerouteSelection.has(hit.reroute.id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set([hit.reroute.id])
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
          this.notifySelection()
          this.pushOverlay()
        }
        break
      case 'valueSource':
      case 'valueSourceOut':
      case 'valueSourceBadge':
        if (!this.valueSourceSelection.has(hit.valueSource.id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set([hit.valueSource.id])
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
          this.notifySelection()
          this.pushOverlay()
        }
        break
      case 'selector':
      case 'selectorIn':
      case 'selectorOut':
      case 'selectorBadge':
        if (!this.selectorSelection.has(hit.selector.id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set([hit.selector.id])
          this.groupSelection = new Set()
          this.netViewSelection = new Set()
          this.notifySelection()
          this.pushOverlay()
        }
        break
      case 'group-header':
      case 'group-resize':
        if (!this.groupSelection.has(hit.group.id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set([hit.group.id])
          this.netViewSelection = new Set()
          this.notifySelection()
          this.pushOverlay()
        }
        break
      case 'netStub':
        if (!this.netViewSelection.has(hit.stub.id)) {
          this.selection = new Set()
          this.linkSelection = new Set()
          this.rerouteSelection = new Set()
          this.valueSourceSelection = new Set()
          this.selectorSelection = new Set()
          this.groupSelection = new Set()
          this.netViewSelection = new Set([hit.stub.id])
          this.notifySelection()
          this.pushOverlay()
        }
        break
      case 'empty':
        break
    }
    // notifySelection is a synchronous host callback: it may replace the
    // scene AND the viewport (lens change, selection-driven rebuild, graph
    // switch) before the menu opens. A Hit into the pre-notification scene
    // would hand the host stale objects, so when the scene changed:
    // re-derive the world point from the ORIGINAL screen point under the
    // CURRENT viewport, re-hit, and only accept a target that still means
    // what the user clicked - the same kind on the same identity, in the
    // SAME graph (cross-graph id collisions are unrelated entities, so a
    // graph switch always degrades to empty). A same-graph hit whose
    // meaning changed (a pin the new selection just revealed, a sibling
    // pin under a moved viewport) degrades to the clicked node's body when
    // that node survived, else to empty space - never to a menu for
    // something the user did not aim at.
    const current = this.renderer.getScene()
    let menuHit = hit
    let mx = w.x
    let my = w.y
    if (current !== scene) {
      const w2 = this.renderer.toWorld(sx, sy)
      mx = w2.x
      my = w2.y
      if (current.graphId !== scene.graphId) {
        // A graph switch replaces the world wholesale: an identical id in
        // the new graph may name an unrelated entity, so neither the re-hit
        // nor the clicked node's body can be trusted - no menu opens.
        menuHit = { kind: 'empty' }
      } else {
        const re = hitTest(current, w2.x, w2.y, this.hitOptions({ pinRevealed: this.pinRevealed(current) }))
        if (hit.kind === re.kind && this.menuTargetIdentity(hit) === this.menuTargetIdentity(re)) {
          menuHit = re
        } else {
          const owner = 'node' in hit ? hit.node.id : undefined
          const node = owner === undefined ? undefined : current.nodes.find((n) => n.id === owner)
          menuHit = node === undefined ? { kind: 'empty' } : { kind: 'body', node }
        }
      }
    }
    this.host.onContextMenu?.(menuHit, mx, my, e.clientX, e.clientY)
  }

  private onDblClick(e: MouseEvent): void {
    // Every input except the navigating fingers is inert while two-finger
    // navigation owns the canvas.
    if (this.touchNav !== undefined) {
      e.preventDefault()
      return
    }
    const { sx, sy } = this.toScreen(e)
    const w = this.renderer.toWorld(sx, sy)
    // Canvas-drawn chrome is not part of hitTest's graph surface. Claim it
    // before resolving graph hits so a rapid toolbox action cannot leak its
    // second click into the empty-canvas palette action below.
    const toolbox = this.renderer.getToolboxLayout()
    const guard = this.toolboxDblClickGuard
    this.toolboxDblClickGuard = undefined
    const guardedToolboxPress =
      guard !== undefined &&
      e.timeStamp <= guard.expiresAt &&
      Math.hypot(e.clientX - guard.clientX, e.clientY - guard.clientY) <= DRAG_THRESHOLD
    if (guardedToolboxPress || (toolbox && insideToolbox(toolbox, w.x, w.y))) {
      e.preventDefault()
      return
    }
    const scene = this.renderer.getScene()
    const hit = hitTest(scene, w.x, w.y, this.hitOptions({ pinRevealed: this.pinRevealed(scene) }))
    if ((hit.kind === 'header' || hit.kind === 'body') && hit.node.isSubgraph) {
      this.host.onOpenSubgraph?.(hit.node)
    } else if (hit.kind === 'header') {
      const selectedNodes = scene.nodes.filter((node) => this.selection.has(node.id))
      const nodes = selectedNodes.some((node) => node.id === hit.node.id)
        ? selectedNodes
        : [hit.node]
      this.host.dispatch({
        command: 'view.setNodeCollapsed',
        params: {
          graphId: scene.graphId,
          nodeIds: nodes.map((node) => node.id),
          collapsed: nodes.some((node) => node.layout.minimized !== true),
        },
      })
    } else if (hit.kind === 'boundary-pin' && hit.item !== BOUNDARY_ADD_SLOT && !hit.regionIndex) {
      // Double-click a boundary slot: rename its exposed port.
      this.host.onBoundaryRenameRequest?.(hit.bnode.side, hit.item, e.clientX, e.clientY)
    } else if (hit.kind === 'link' && hit.link.boundary !== true && hit.link.netId === undefined) {
      // The host offers reroute vs node splice. Boundary binding and net
      // delivery noodles are excluded because their ids are synthetic and
      // splicing them has no document command to lower to.
      this.host.onLinkDoubleClick?.(linkMenuContext(hit.link, w), e.clientX, e.clientY)
    } else if (hit.kind === 'empty') {
      this.host.onOpenPalette?.(w.x, w.y, e.clientX, e.clientY)
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    // A scroll with no buttons held while a mouse-typed gesture is active
    // proves the release was dropped: recover before navigating. Mouse-typed
    // only: a wheel's buttons snapshot may not reflect a held pen tip, so a
    // trackpad scroll must not end a pen drag (pens recover via re-press).
    if (this.gesture.kind !== 'idle' && this.activePointerType === 'mouse' && e.buttons === 0)
      this.recoverMissedRelease('wheel-buttons0')
    const { sx, sy } = this.toScreen(e)
    this.renderer.setViewport(wheelNavigationViewport(this.renderer.getViewport(), {
      screenX: sx,
      screenY: sy,
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      pageWidth: this.canvas.clientWidth,
      pageHeight: this.canvas.clientHeight,
      ctrlKey: e.ctrlKey,
    }, this.host.wheelNavigationMode?.() ?? 'zoom'))
  }

  // -- helpers ---------------------------------------------------------------

  private toScreen(e: MouseEvent): { sx: number; sy: number } {
    const rect = this.canvas.getBoundingClientRect()
    return { sx: e.clientX - rect.left, sy: e.clientY - rect.top }
  }

  private pushOverlay(
    extra: {
      dragOffsets?: ReadonlyMap<string, { dx: number; dy: number }>
      ghostLink?: GhostLink
      ghostLinks?: readonly GhostLink[]
      hiddenLinkIds?: ReadonlySet<string>
      dropTargets?: ReadonlySet<string>
      marquee?: { x1: number; y1: number; x2: number; y2: number }
      resizePreview?: { nodeId: string; x: number; y: number; width: number; height: number }
      groupDragOffset?: { groupId: string; dx: number; dy: number }
      groupResizeGhost?: { groupId: string; x: number; y: number; width: number; height: number }
      bodyDropNode?: string
    } = {},
  ): void {
    const ghost = extra.ghostLink ?? this.paletteGhost
    this.renderer.setOverlay({
      selection: new Set(this.selection),
      linkSelection: new Set(this.linkSelection),
      rerouteSelection: new Set(this.rerouteSelection),
      valueSourceSelection: new Set(this.valueSourceSelection),
      selectorSelection: new Set(this.selectorSelection),
      groupSelection: new Set(this.groupSelection),
      netViewSelection: new Set(this.netViewSelection),
      ...(this.hoveredReroute !== undefined ? { hoveredReroute: this.hoveredReroute } : {}),
      ...(this.hoveredLinkMidpoint !== undefined ? { hoveredLinkMidpoint: this.hoveredLinkMidpoint } : {}),
      ...(this.hoveredNode !== undefined ? { hoveredNode: this.hoveredNode } : {}),
      ...(this.hoveredPinNode !== undefined ? {
        hoveredPin: {
          nodeId: this.hoveredPinNode,
          portId: this.hoveredPinPort!,
          direction: this.hoveredPinDirection!,
          ...(this.hoveredPinWidgetTap === true ? { widgetTap: true as const } : {}),
        },
      } : {}),
      ...(this.focusedPinNode !== undefined ? {
        focusedPin: {
          nodeId: this.focusedPinNode,
          portId: this.focusedPinPort!,
          direction: this.focusedPinDirection!,
          ...(this.focusedPinWidgetTap === true ? { widgetTap: true as const } : {}),
        },
      } : {}),
      ...(this.hoveredWidgetNode !== undefined ? {
        hoveredWidget: { nodeId: this.hoveredWidgetNode, valueKey: this.hoveredWidgetValue! },
      } : {}),
      ...extra,
      ...(ghost !== undefined ? { ghostLink: ghost } : {}),
      ...(this.placementGhost !== undefined ? { placementGhost: this.placementGhost } : {}),
    })
    // Announce drag-offset changes AFTER the overlay is installed, by map
    // identity: each move builds a fresh map (fires), the graph-churn
    // carry-through reuses the live one (silent), a push without offsets
    // ends the stream with one undefined (commit or cancel alike).
    if (extra.dragOffsets !== this.lastDragOffsets) {
      this.lastDragOffsets = extra.dragOffsets
      this.host.onDragOffsets?.(extra.dragOffsets)
    }
    const linkPresence = this.gesture.kind === 'link' ? this.gesture.presenceOrigin : undefined
    const sameLinkPresence =
      linkPresence === this.lastLinkDragPresence || (
        linkPresence !== undefined && this.lastLinkDragPresence !== undefined &&
        linkPresence.kind === this.lastLinkDragPresence.kind &&
        (linkPresence.kind === 'port' && this.lastLinkDragPresence.kind === 'port'
          ? linkPresence.node === this.lastLinkDragPresence.node &&
            linkPresence.port === this.lastLinkDragPresence.port &&
            linkPresence.side === this.lastLinkDragPresence.side
          : linkPresence.kind === 'widgetTap' && this.lastLinkDragPresence.kind === 'widgetTap'
            ? linkPresence.node === this.lastLinkDragPresence.node &&
              linkPresence.input === this.lastLinkDragPresence.input
          : linkPresence.kind === 'reroute' && this.lastLinkDragPresence.kind === 'reroute' &&
            linkPresence.reroute === this.lastLinkDragPresence.reroute &&
            linkPresence.side === this.lastLinkDragPresence.side)
      )
    if (!sameLinkPresence) {
      this.lastLinkDragPresence = linkPresence
      this.host.onLinkDragPresence?.(linkPresence)
    }
  }

  /**
   * Mirror of the renderer's pin paint suppression (drawNode): a
   * widget-backed input pin paints only when connected, its node is
   * selected/hovered, or it is a legal drop target - so only then may it
   * take hits. Keeps invisible pins from swallowing clicks aimed at what IS
   * painted there (a widget row edge, a neighboring node's body).
   */
  private pinRevealed(
    scene: Scene,
    dropTargets?: ReadonlySet<string>,
  ): (node: SceneNode, pin: PinLayout) => boolean {
    let connected: Set<string> | undefined
    return (node, pin) => {
      if (pin.widgetBacked !== true || pin.direction !== 'in') return true
      if (this.selection.has(node.id) || this.hoveredNode === node.id) return true
      if (dropTargets?.has(dropTargetKey(node.id, pin.portId, pin.direction)) === true) return true
      // Lazily derive connectivity the way the renderer does each paint.
      connected ??= new Set(
        scene.links
          .filter((link) => link.to.kind === 'port')
          .map((link) => {
            const to = link.to as Extract<SceneLink['to'], { kind: 'port' }>
            return `${to.node}\u0000${portEndKey(to)}`
          }),
      )
      return connected.has(`${node.id}\u0000${pin.portId}`)
    }
  }

  /** Tap hits obey the same connected/hovered/legal-target reveal contract as paint. */
  private widgetTapHits(scene: Scene, targets?: ReadonlySet<string>): Set<string> {
    const keys = new Set<string>(targets)
    for (const link of scene.links) {
      if (link.from.kind === 'widgetTap') keys.add(dropTargetKey(link.from.node, link.from.input, 'out', true))
    }
    if (this.hoveredNode !== undefined) {
      const node = scene.nodes.find((n) => n.id === this.hoveredNode)
      for (const pin of node?.layout.pins ?? [])
        if (pin.widgetTap === true) keys.add(dropTargetKey(node!.id, pin.portId, 'out', true))
    }
    return keys
  }

  /** Update the hover reveals (ghost sockets, widget-backed pins); overlay repaints only on change. */
  private setHover(
    rerouteId: string | undefined,
    nodeId: string | undefined,
    toolboxButton: ToolboxButtonRect | undefined,
  ): void {
    const toolboxButtonId = toolboxButton?.button.id
    if (
      rerouteId === this.hoveredReroute &&
      nodeId === this.hoveredNode &&
      toolboxButtonId === this.hoveredToolboxButton
    ) return
    if (nodeId !== this.hoveredNode) this.host.onNodeHover?.(nodeId)
    this.hoveredReroute = rerouteId
    this.hoveredNode = nodeId
    this.hoveredToolboxButton = toolboxButtonId
    this.host.onToolboxHover?.(toolboxButton)
    if (rerouteId === undefined && nodeId === undefined && toolboxButton === undefined) this.host.onHoverTarget?.(undefined)
    this.pushOverlay()
  }

  private setLinkMidpointHover(linkId: string | undefined): void {
    if (linkId === this.hoveredLinkMidpoint) return
    this.hoveredLinkMidpoint = linkId
    this.pushOverlay()
  }

  /** Track one pin OR widget row; repeated moves on it are repaint-free. */
  private setAffordanceHover(hit: Hit | undefined): void {
    const pin = hit?.kind === 'pin' || hit?.kind === 'widgetTap' ? hit : undefined
    const widget = hit?.kind === 'widget' ? hit : undefined
    const pinNode = pin?.node.id
    const pinPort = pin?.kind === 'widgetTap' ? pin.pin.portId : pin?.portId
    const pinDirection = pin?.kind === 'widgetTap' ? 'out' : pin?.direction
    const pinWidgetTap = pin?.kind === 'widgetTap' ? true : undefined
    const widgetNode = widget?.node.id
    const widgetValue = widget?.row.valueKey
    if (
      pinNode === this.hoveredPinNode &&
      pinPort === this.hoveredPinPort &&
      pinDirection === this.hoveredPinDirection &&
      pinWidgetTap === this.hoveredPinWidgetTap &&
      widgetNode === this.hoveredWidgetNode &&
      widgetValue === this.hoveredWidgetValue
    ) return
    this.hoveredPinNode = pinNode
    this.hoveredPinPort = pinPort
    this.hoveredPinDirection = pinDirection
    this.hoveredPinWidgetTap = pinWidgetTap
    this.hoveredWidgetNode = widgetNode
    this.hoveredWidgetValue = widgetValue
    this.pushOverlay()
  }

  private clearAffordanceHoverFields(): void {
    this.hoveredPinNode = undefined
    this.hoveredPinPort = undefined
    this.hoveredPinDirection = undefined
    this.hoveredPinWidgetTap = undefined
    this.hoveredWidgetNode = undefined
    this.hoveredWidgetValue = undefined
  }
}
