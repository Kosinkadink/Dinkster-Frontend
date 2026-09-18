/**
 * Hit testing. Pure functions over the Scene: world point -> what is
 * under it. The interaction controller translates hits + gestures into
 * command invocations; nothing here mutates anything.
 */

import type { TypeExpr } from '@dinkster/core'
import type { LayoutRow, PinLayout } from './layout.js'
import type { CanvasDetailLevel } from './tokens.js'
import {
  GROUP_HEADER_HEIGHT,
  REROUTE_RADIUS,
  REROUTE_SOCKET_OFFSET,
  REROUTE_SOCKET_RADIUS,
  selectorBadgeRect,
  selectorCandidatePinPosition,
  selectorOutPinPosition,
  valueSourceBadgeRect,
  valueSourcePinPosition,
  type Scene,
  type SceneBoundaryNode,
  type SceneGroup,
  type SceneLink,
  type SceneNetStub,
  type SceneNode,
  type SceneReroute,
  type SceneSelector,
  type SceneValueSource,
} from './scene.js'

/** World-space pin grab radius (generous: pins are small targets). */
export const PIN_HIT_RADIUS = 9

/** Screen-space extent of each corner resize target. */
export const RESIZE_HIT_SIZE = 10

export type ResizeHandle = 'nw' | 'ne' | 'se' | 'sw'

/** World-space distance from a link's curve that still counts as a hit. */
export const LINK_HIT_RADIUS = 6

/**
 * Generous grab radius around a link's rendered midpoint dot: the dot is the
 * advertised click/split handle, so it forgives more than the thin curve.
 */
export const LINK_MIDPOINT_HIT_RADIUS = 12

/** World-space grab radius around a reroute dot (generous, like pins). */
export const REROUTE_HIT_RADIUS = REROUTE_RADIUS + 4

/** World-space grab radius around a revealed reroute ghost socket. */
export const REROUTE_SOCKET_HIT_RADIUS = REROUTE_SOCKET_RADIUS + 5

export type Hit =
  | {
      readonly kind: 'pin'
      readonly node: SceneNode
      /** Elab key (view lookup). Document identity is pin.address. */
      readonly portId: string
      readonly direction: 'in' | 'out'
      /** Pin center, world coords. */
      readonly x: number
      readonly y: number
      readonly type: TypeExpr
      /** The full pin layout: address (document identity), ghost, materialize. */
      readonly pin: PinLayout
    }
  | {
      readonly kind: 'widgetTap'
      readonly node: SceneNode
      readonly input: string
      readonly x: number
      readonly y: number
      readonly type: TypeExpr
      readonly pin: PinLayout
    }
  | {
      readonly kind: 'widget'
      readonly node: SceneNode
      readonly row: Extract<LayoutRow, { kind: 'widget' }>
      /** Row rect, world coords. */
      readonly x: number
      readonly y: number
      readonly width: number
      readonly height: number
      /** Pointer offset from the row origin, used by compact controls. */
      readonly localX: number
      readonly localY: number
    }
  | {
      readonly kind: 'section'
      readonly node: SceneNode
      readonly row: Extract<LayoutRow, { kind: 'section' }>
    }
  | {
      /** Grow-family affordance row: click materializes the offered member. */
      readonly kind: 'growth'
      readonly node: SceneNode
      readonly row: Extract<LayoutRow, { kind: 'growth' }>
    }
  | { readonly kind: 'header'; readonly node: SceneNode }
  | { readonly kind: 'body'; readonly node: SceneNode }
  | { readonly kind: 'resize'; readonly node: SceneNode; readonly handle: ResizeHandle }
  | {
      readonly kind: 'link'
      readonly link: SceneLink
      /** Pointer is inside the midpoint handle's generous grab radius. */
      readonly midpoint: boolean
    }
  | { readonly kind: 'reroute'; readonly reroute: SceneReroute }
  /**
   * A revealed ghost socket beside a hovered reroute dot: 'in' floats left
   * (drag seeks a producer for the junction), 'out' floats right (drag pulls
   * a new consumer noodle out of it). Only surfaced when the caller names
   * the hovered reroute - unhovered junctions never trap nearby clicks.
   */
  | {
      readonly kind: 'rerouteSocket'
      readonly reroute: SceneReroute
      readonly side: 'in' | 'out'
      /** Socket center, world coords. */
      readonly x: number
      readonly y: number
    }
  /** A value source's single output pin (link-drag start). */
  | {
      readonly kind: 'valueSourceOut'
      readonly valueSource: SceneValueSource
      /** Pin center, world coords. */
      readonly x: number
      readonly y: number
      readonly type: TypeExpr
    }
  /** A value source's spec badge (declared/derived/conflict details). */
  | { readonly kind: 'valueSourceBadge'; readonly valueSource: SceneValueSource }
  /** A value source's pill body (select/drag/edit). */
  | { readonly kind: 'valueSource'; readonly valueSource: SceneValueSource }
  /** One candidate's branch input pin (link-drag target/source). */
  | {
      readonly kind: 'selectorIn'
      readonly selector: SceneSelector
      readonly candidate: string
      /** Pin center, world coords. */
      readonly x: number
      readonly y: number
      readonly type: TypeExpr
    }
  /** A selector's single output pin (link-drag start). */
  | {
      readonly kind: 'selectorOut'
      readonly selector: SceneSelector
      /** Pin center, world coords. */
      readonly x: number
      readonly y: number
      readonly type: TypeExpr
    }
  /** A selector's policy badge (fixed/random details + menu). */
  | { readonly kind: 'selectorBadge'; readonly selector: SceneSelector }
  /** A selector's box body (select/drag/menu). */
  | { readonly kind: 'selector'; readonly selector: SceneSelector }
  | { readonly kind: 'netStub'; readonly stub: SceneNetStub }
  /** A group's title band: drag handle + menu surface. */
  | { readonly kind: 'group-header'; readonly group: SceneGroup }
  /** One of a group's four invisible corner resize targets. */
  | { readonly kind: 'group-resize'; readonly group: SceneGroup; readonly handle: ResizeHandle }
  /**
   * A boundary pseudo-node's pin. Boundary pins are anchors for derived
   * binding noodles, not (yet) link-drag sources; exposure editing lives in
   * boundary commands.
   */
  | {
      readonly kind: 'boundary-pin'
      readonly bnode: SceneBoundaryNode
      /** Boundary item id (opaque - never split). */
      readonly item: string
      readonly direction: 'in' | 'out'
      readonly x: number
      readonly y: number
      readonly type: TypeExpr
      readonly regionIndex?: true
      /** True when the label row, rather than the physical pin, was hit. */
      readonly row?: true
    }
  /** A boundary pseudo-node's header band (drag handle). */
  | { readonly kind: 'boundary-header'; readonly bnode: SceneBoundaryNode }
  /** A boundary pseudo-node's body (also a drag handle; rows are inert). */
  | { readonly kind: 'boundary-body'; readonly bnode: SceneBoundaryNode }
  | { readonly kind: 'empty' }

export interface HitOptions {
  /**
   * The reroute whose ghost sockets are currently revealed (hover state,
   * owned by the interaction controller). Only THAT junction's sockets are
   * hit-testable: hitTest stays pure while reveal-before-grab is preserved.
   */
  readonly rerouteSockets?: string
  /** Revealed tap keys (`nodeId:portId:out:tap`), including connected/hovered taps. */
  readonly widgetTaps?: ReadonlySet<string>
  /** Viewport scale; keeps node resize targets a constant screen-space size. */
  readonly scale?: number
  /** Renderer-owned density tier; overview omits row-level pointer targets. */
  readonly detailLevel?: CanvasDetailLevel
  /**
   * Whether a normally-hidden widget-backed input pin is currently revealed
   * (connected, node selected/hovered, or a legal drop target) - the caller
   * mirrors the renderer's paint suppression so an invisible pin never
   * swallows a hit aimed at what's actually painted there. Absent: every
   * pin is hit-testable (pure-geometry callers, tests).
   */
  readonly pinRevealed?: (node: SceneNode, pin: PinLayout) => boolean
}

const overviewHitRadius = (
  worldRadius: number,
  screenRadius: number,
  options: HitOptions | undefined,
): number => options?.detailLevel === 'overview'
  ? Math.max(worldRadius, screenRadius / Math.max(options.scale ?? 1, Number.EPSILON))
  : worldRadius

/** Invisible four-corner resize targets, expressed in screen pixels. */
export function nodeResizeHandle(
  node: SceneNode,
  wx: number,
  wy: number,
  scale = 1,
): ResizeHandle | undefined {
  if (node.layout.minimized) return undefined
  const screenScale = Math.max(scale, Number.EPSILON)
  const corner = RESIZE_HIT_SIZE / screenScale
  const left = node.x
  const top = node.y
  const right = left + node.layout.width
  const bottom = top + node.layout.height
  if (Math.abs(wx - left) <= corner && Math.abs(wy - top) <= corner) return 'nw'
  if (Math.abs(wx - right) <= corner && Math.abs(wy - top) <= corner) return 'ne'
  if (Math.abs(wx - right) <= corner && Math.abs(wy - bottom) <= corner) return 'se'
  if (Math.abs(wx - left) <= corner && Math.abs(wy - bottom) <= corner) return 'sw'
  return undefined
}

/**
 * Topmost hit at a world point. Scene order is draw order, so scan nodes in
 * reverse. Pins are checked across ALL nodes first (they overhang node edges
 * and must win against a neighboring node's body).
 */
export function hitTest(scene: Scene, wx: number, wy: number, opts?: HitOptions): Hit {
  const contentDetail = opts?.detailLevel !== 'overview'
  const pinHitRadius = overviewHitRadius(PIN_HIT_RADIUS, 5, opts)
  const linkHitRadius = overviewHitRadius(LINK_HIT_RADIUS, 4, opts)
  const rerouteHitRadius = overviewHitRadius(REROUTE_HIT_RADIUS, 5, opts)
  // Pin passes run in reverse paint order (selectors paint above value
  // sources, which paint above boundary nodes, which paint above nodes), so
  // where pins overlap across layers the topmost painted pin wins.

  // Selector pins overhang their box edges like node pins do.
  const selPin = hitTestSelectorPin(scene, wx, wy, pinHitRadius)
  if (selPin) return selPin

  // Value source output pins overhang their pill edge like node pins do.
  const vsPin = hitTestValueSourcePin(scene, wx, wy, pinHitRadius)
  if (vsPin) return vsPin

  // Boundary pseudo-node pins overhang like node pins do.
  const bPin = hitTestBoundaryPin(scene, wx, wy, pinHitRadius)
  if (bPin) return bPin

  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const node = scene.nodes[i]!
    if (node.layout.minimized) continue
    for (const pin of node.layout.pins) {
      if (pin.widgetTap !== true || !opts?.widgetTaps?.has(`${node.id}:${pin.portId}:out:tap`)) continue
      // Paint suppresses every family-owned pin; hit testing must agree
      // (taps are memberless today, so this is consistency armor).
      if (pin.familyOwner !== undefined) continue
      const x = node.x + node.layout.width
      const y = node.y + pin.y
      if (Math.hypot(wx - x, wy - y) <= pinHitRadius)
        return { kind: 'widgetTap', node, input: pin.address.port as string, x, y, type: pin.type, pin }
    }
  }
  const pin = hitTestPin(scene, wx, wy, opts?.pinRevealed, pinHitRadius)
  if (pin) return pin

  // Body passes also run in reverse paint order: selector boxes and value
  // source pills paint ABOVE boundary and regular nodes, so they must win
  // clicks where they overlap.

  // Selector boxes: badge wins over body (policy click before drag).
  for (let i = scene.selectors.length - 1; i >= 0; i--) {
    const sel = scene.selectors[i]!
    if (wx < sel.x || wx > sel.x + sel.width || wy < sel.y || wy > sel.y + sel.height) continue
    if (contentDetail) {
      const badge = selectorBadgeRect(sel)
      if (wx >= badge.x && wx <= badge.x + badge.width && wy >= badge.y && wy <= badge.y + badge.height) {
        return { kind: 'selectorBadge', selector: sel }
      }
    }
    return { kind: 'selector', selector: sel }
  }

  // Value source pills: badge wins over body (details click before drag).
  for (let i = scene.valueSources.length - 1; i >= 0; i--) {
    const vs = scene.valueSources[i]!
    if (wx < vs.x || wx > vs.x + vs.width || wy < vs.y || wy > vs.y + vs.height) continue
    if (contentDetail) {
      const badge = valueSourceBadgeRect(vs)
      if (wx >= badge.x && wx <= badge.x + badge.width && wy >= badge.y && wy <= badge.y + badge.height) {
        return { kind: 'valueSourceBadge', valueSource: vs }
      }
    }
    return { kind: 'valueSource', valueSource: vs }
  }

  // Boundary pseudo-nodes draw ABOVE regular nodes, so they hit first.
  for (let i = scene.boundaryNodes.length - 1; i >= 0; i--) {
    const bnode = scene.boundaryNodes[i]!
    const l = bnode.layout
    if (wx < bnode.x || wx > bnode.x + l.width || wy < bnode.y || wy > bnode.y + l.height) continue
    if (wy <= bnode.y + l.headerHeight) return { kind: 'boundary-header', bnode }
    if (contentDetail) {
      for (const row of l.rows) {
        if (row.kind !== 'ports') continue
        const slot = row.input ?? row.output
        if (slot && slot.portId !== '__add__' && wy >= bnode.y + row.y && wy <= bnode.y + row.y + row.height) {
          const direction = bnode.side === 'inputs' ? 'out' : 'in'
          return {
            kind: 'boundary-pin',
            bnode,
            item: slot.portId,
            direction,
            x: direction === 'in' ? bnode.x : bnode.x + l.width,
            y: bnode.y + row.y + row.height / 2,
            type: slot.type,
            row: true,
            ...(slot.regionIndex ? { regionIndex: true } : {}),
          }
        }
      }
    }
    return { kind: 'boundary-body', bnode }
  }

  // Net stub tags overhang node edges; like pins they beat node bodies.
  const stub = hitTestNetStub(scene, wx, wy)
  if (stub) return { kind: 'netStub', stub }

  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const node = scene.nodes[i]!
    const l = node.layout
    const right = node.x + l.width
    const bottom = node.y + l.height
    const minimizedProxy = l.minimized === true &&
      Math.abs(wy - (node.y + l.headerHeight / 2)) <= pinHitRadius &&
      (Math.abs(wx - node.x) <= pinHitRadius || Math.abs(wx - right) <= pinHitRadius)
    const inside = wx >= node.x && wx <= right && wy >= node.y && wy <= bottom
    // Row controls are boundary affordances too: edge steppers and sockets
    // must remain usable where they meet the resize band.
    if (inside && contentDetail) {
      for (const row of l.rows) {
        if (row.kind === 'ports' || row.kind === 'fallback') continue
        const ry = node.y + row.y
        if (wy < ry || wy > ry + row.height) continue
        if (row.kind === 'section') return { kind: 'section', node, row }
        if (row.kind === 'growth') return { kind: 'growth', node, row }
        if (wx < node.x + row.inset || wx > right - row.inset) continue
        return {
          kind: 'widget', node, row,
          x: node.x + row.inset, y: ry, width: l.width - row.inset * 2,
          height: row.height, localX: wx - node.x - row.inset, localY: wy - ry,
        }
      }
    }
    // Check each node in draw order before its body. This lets a top node's
    // strict body beat a lower node's outset while preserving corner reach.
    const resize = contentDetail ? nodeResizeHandle(node, wx, wy, opts?.scale) : undefined
    if (resize) return { kind: 'resize', node, handle: resize }
    if (!inside && !minimizedProxy) continue
    if (wy <= node.y + l.headerHeight) return { kind: 'header', node }
    if (contentDetail) {
      for (const row of l.rows) {
        if (row.kind === 'ports' || row.kind === 'fallback') continue
        const ry = node.y + row.y
        if (wy < ry || wy > ry + row.height) continue
        if (row.kind === 'section') return { kind: 'section', node, row }
        if (row.kind === 'growth') return { kind: 'growth', node, row }
        if (wx < node.x + row.inset || wx > right - row.inset) return { kind: 'body', node }
        return {
          kind: 'widget',
          node,
          row,
          x: node.x + row.inset,
          y: ry,
          width: l.width - row.inset * 2,
          height: row.height,
          localX: wx - node.x - row.inset,
          localY: wy - ry,
        }
      }
    }
    return { kind: 'body', node }
  }

  // Reroute dots sit ON the noodles, so they win against the links they join.
  // The central dot beats its own ghost sockets where their radii overlap:
  // moving the junction stays the primary gesture.
  const reroute = hitTestReroute(scene, wx, wy, rerouteHitRadius)
  if (reroute) return { kind: 'reroute', reroute }

  // Revealed ghost sockets (hovered reroute only) also sit on the noodles.
  if (contentDetail && opts?.rerouteSockets !== undefined) {
    const hovered = scene.reroutes.find((r) => r.id === opts.rerouteSockets)
    const side = hovered && rerouteSocketAt(hovered, wx, wy)
    if (hovered && side) {
      const x = hovered.x + (side === 'in' ? -REROUTE_SOCKET_OFFSET : REROUTE_SOCKET_OFFSET)
      return { kind: 'rerouteSocket', reroute: hovered, side, x, y: hovered.y }
    }
  }

  const link = hitTestLink(scene, wx, wy, contentDetail, linkHitRadius)
  if (link) {
    // Net delivery noodles advertise no midpoint handle (no dot is painted),
    // so their curve hits never carry the midpoint flag.
    const midpoint = contentDetail && link.netId === undefined &&
      Math.hypot(wx - (link.x1 + link.x2) / 2, wy - (link.y1 + link.y2) / 2) <= LINK_MIDPOINT_HIT_RADIUS
    return { kind: 'link', link, midpoint }
  }

  // Groups draw UNDER everything, so they hit last. Only the title band and
  // the resize corners are interactive; the body falls through to 'empty'
  // (pan/click-through), so a group never traps canvas gestures.
  const group = hitTestGroup(scene, wx, wy, opts?.scale, contentDetail)
  if (group) return group

  return { kind: 'empty' }
}

/** Topmost group whose header band or resize corner contains the point. */
export function hitTestGroup(
  scene: Scene,
  wx: number,
  wy: number,
  scale = 1,
  resizeEnabled = true,
): Extract<Hit, { kind: 'group-header' | 'group-resize' }> | undefined {
  const corner = RESIZE_HIT_SIZE / Math.max(scale, Number.EPSILON)
  for (let i = scene.groups.length - 1; i >= 0; i--) {
    const g = scene.groups[i]!
    const right = g.x + g.width
    const bottom = g.y + g.height
    let handle: ResizeHandle | undefined
    if (Math.abs(wx - g.x) <= corner && Math.abs(wy - g.y) <= corner) handle = 'nw'
    else if (Math.abs(wx - right) <= corner && Math.abs(wy - g.y) <= corner) handle = 'ne'
    else if (Math.abs(wx - right) <= corner && Math.abs(wy - bottom) <= corner) handle = 'se'
    else if (Math.abs(wx - g.x) <= corner && Math.abs(wy - bottom) <= corner) handle = 'sw'
    if (resizeEnabled && handle) return { kind: 'group-resize', group: g, handle }
    if (wx < g.x || wx > right || wy < g.y || wy > bottom) continue
    if (wy <= g.y + GROUP_HEADER_HEIGHT) return { kind: 'group-header', group: g }
  }
  return undefined
}

/**
 * Which of a reroute's ghost sockets contains the point, if either: 'in' is
 * the left socket, 'out' the right. Pure geometry - the caller decides
 * whether the sockets are revealed at all (hover state lives above).
 */
export function rerouteSocketAt(r: SceneReroute, wx: number, wy: number): 'in' | 'out' | undefined {
  if (Math.hypot(wx - (r.x - REROUTE_SOCKET_OFFSET), wy - r.y) <= REROUTE_SOCKET_HIT_RADIUS) return 'in'
  if (Math.hypot(wx - (r.x + REROUTE_SOCKET_OFFSET), wy - r.y) <= REROUTE_SOCKET_HIT_RADIUS) return 'out'
  return undefined
}

/**
 * Reveal radius for a reroute's ghost sockets: the whole halo spanning the
 * dot, both sockets, and the stems between them. Larger than the dot's grab
 * radius on purpose - approaching a socket position directly must reveal it
 * without first passing over the dot.
 */
export const REROUTE_REVEAL_RADIUS = REROUTE_SOCKET_OFFSET + REROUTE_SOCKET_HIT_RADIUS

/**
 * Nearest reroute whose ghost-socket halo contains the point (reveal zone,
 * NOT grab zone: grabbing the dot or a socket keeps its own tighter radius).
 */
export function hitTestRerouteRevealZone(scene: Scene, wx: number, wy: number): SceneReroute | undefined {
  let best: SceneReroute | undefined
  let bestDist = REROUTE_REVEAL_RADIUS
  for (const r of scene.reroutes) {
    const d = Math.hypot(wx - r.x, wy - r.y)
    if (d <= bestDist) {
      bestDist = d
      best = r
    }
  }
  return best
}

/**
 * Topmost node whose bounds (padded by the pin grab radius on the left and
 * right edges, where pins protrude) contain the point. Hover affordances
 * only - real gestures resolve through hitTest.
 */
export function hoveredNodeAt(scene: Scene, wx: number, wy: number): SceneNode | undefined {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const node = scene.nodes[i]!
    const l = node.layout
    if (
      wx >= node.x - PIN_HIT_RADIUS &&
      wx <= node.x + l.width + PIN_HIT_RADIUS &&
      wy >= node.y &&
      wy <= node.y + l.height
    ) {
      return node
    }
  }
  return undefined
}

/** Nearest reroute dot within REROUTE_HIT_RADIUS of the point. */
export function hitTestReroute(
  scene: Scene,
  wx: number,
  wy: number,
  hitRadius = REROUTE_HIT_RADIUS,
): SceneReroute | undefined {
  let best: SceneReroute | undefined
  let bestDist = hitRadius
  for (const r of scene.reroutes) {
    const d = Math.hypot(wx - r.x, wy - r.y)
    if (d <= bestDist) {
      bestDist = d
      best = r
    }
  }
  return best
}

/** Topmost net stub tag containing the point (rects precomputed in the scene). */
export function hitTestNetStub(scene: Scene, wx: number, wy: number): SceneNetStub | undefined {
  for (let i = scene.netStubs.length - 1; i >= 0; i--) {
    const s = scene.netStubs[i]!
    if (wx >= s.x && wx <= s.x + s.width && wy >= s.y && wy <= s.y + s.height) return s
  }
  return undefined
}

/**
 * Horizontal control-point offset of a link's cubic. The single source of
 * truth for link curve geometry: paint (renderer.drawLink), culling
 * (linkBounds), and hit testing all derive the same cubic control geometry
 * from it. (Hit testing then approximates that shared cubic with bounded
 * error; see distanceToLinkSquared.)
 */
export function linkControlOffset(x1: number, x2: number): number {
  return Math.max(40, Math.abs(x2 - x1) * 0.5)
}

/**
 * Conservative world-space bounds of a link's cubic: the control hull. The
 * control points sit at (x1+dx, y1) and (x2-dx, y2), so a long REVERSE link
 * (x2 < x1) bulges well past both endpoints horizontally; y stays within
 * [y1, y2] because the control ys equal the endpoint ys.
 */
export function linkBounds(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const dx = linkControlOffset(x1, x2)
  return {
    minX: Math.min(x1, x2 - dx),
    maxX: Math.max(x1 + dx, x2),
    minY: Math.min(y1, y2),
    maxY: Math.max(y1, y2),
  }
}

/** Distance from point (px, py) to segment (ax, ay)-(bx, by). Overflow-safe
 * for all finite inputs: the projection is computed on the segment scaled by
 * its largest component, so squaring never overflows to Infinity (which
 * would make t NaN, poison Math.min-folded accumulators, and defeat
 * NaN-always-false pruning comparisons downstream). */
function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const m = Math.max(Math.abs(dx), Math.abs(dy))
  if (m === 0) return Math.hypot(px - ax, py - ay)
  const ux = dx / m
  const uy = dy / m
  const lenSq = ux * ux + uy * uy // in [1, 2], never overflows
  const t = Math.max(0, Math.min(1, (((px - ax) / m) * ux + ((py - ay) / m) * uy) / lenSq))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Curve-to-chord error bound below which a cubic span counts as a segment.
 * Measured distances are accurate to within this bound, so a hit/miss
 * verdict can only differ from the exact curve within 0.5 world units of
 * the LINK_HIT_RADIUS boundary - well inside a noodle's visual width. */
const CUBIC_FLATNESS = 0.5

/** Unit in the last place of |v|: the spacing of representable doubles at
 * that magnitude. Conservative to within one binade at power-of-two
 * boundaries (Math.log2 rounding), which only widens the stagnation guard
 * by at most 2x - never below one actual ulp. */
function ulpOf(v: number): number {
  const a = Math.abs(v)
  if (a === 0) return Number.MIN_VALUE
  return 2 ** Math.max(Math.floor(Math.log2(a)) - 52, -1074)
}

/** Overflow-safe midpoint: halves are exact, and the rounded sum always
 * lies within [min(a,b), max(a,b)], so subdivision hulls nest. */
function mid(a: number, b: number): number {
  return a / 2 + b / 2
}

/**
 * Distance from a point to a cubic bezier, by adaptive De Casteljau
 * flattening over an explicit work stack: a span whose control points sit
 * within CUBIC_FLATNESS of its endpoint chord measures as one segment;
 * anything else splits at t=0.5. There is NO fixed depth or sample cap:
 * subdivision runs until the flatness test succeeds or float subdivision
 * reaches its representation floor (span hull within a few ulps of its
 * coordinates, or a split that reproduces its parent bitwise). Error is
 * therefore bounded by CUBIC_FLATNESS down to that float floor - the same
 * floor the painted curve's own evaluation has, so no representable
 * geometry is measured coarser than the budget. Non-finite inputs (e.g. an
 * overflowed control offset) fail closed as a miss. `limit` prunes: the
 * curve lies inside its control-point bounding box, so a span whose box is
 * farther than the best distance so far cannot improve it.
 */
function cubicDistance(
  px: number,
  py: number,
  x1: number,
  y1: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  x2: number,
  y2: number,
  limit: number,
): number {
  if (
    !Number.isFinite(px) || !Number.isFinite(py) ||
    !Number.isFinite(x1) || !Number.isFinite(y1) ||
    !Number.isFinite(c1x) || !Number.isFinite(c1y) ||
    !Number.isFinite(c2x) || !Number.isFinite(c2y) ||
    !Number.isFinite(x2) || !Number.isFinite(y2)
  ) {
    return Infinity
  }
  let best = Infinity
  // LIFO stack of spans, 8 numbers each: p1, q1 (control), q2 (control), p2.
  // All midpoints below use overflow-safe halving, so every span stays
  // finite and every child hull nests inside its parent hull.
  const stack: number[] = [x1, y1, c1x, c1y, c2x, c2y, x2, y2]
  while (stack.length > 0) {
    const p2y = stack.pop()!
    const p2x = stack.pop()!
    const q2y = stack.pop()!
    const q2x = stack.pop()!
    const q1y = stack.pop()!
    const q1x = stack.pop()!
    const p1y = stack.pop()!
    const p1x = stack.pop()!
    const minX = Math.min(p1x, q1x, q2x, p2x)
    const maxX = Math.max(p1x, q1x, q2x, p2x)
    const minY = Math.min(p1y, q1y, q2y, p2y)
    const maxY = Math.max(p1y, q1y, q2y, p2y)
    const bx = Math.max(0, Math.max(minX - px, px - maxX))
    const by = Math.max(0, Math.max(minY - py, py - maxY))
    if (Math.hypot(bx, by) > Math.min(limit, best)) continue
    // Terminate when the whole hull fits the flatness budget (the chord is
    // then within CUBIC_FLATNESS of every curve point; covers zero-length
    // chords), or when the hull extent is within a few ulps of its
    // coordinates - float subdivision cannot resolve finer geometry there.
    const spanX = maxX - minX
    const spanY = maxY - minY
    if (
      Math.hypot(spanX, spanY) <= CUBIC_FLATNESS ||
      (spanX <= 4 * ulpOf(Math.max(Math.abs(minX), Math.abs(maxX))) &&
        spanY <= 4 * ulpOf(Math.max(Math.abs(minY), Math.abs(maxY))))
    ) {
      best = Math.min(best, segmentDistance(px, py, p1x, p1y, p2x, p2y))
      continue
    }
    // Flat when both controls are near the chord LINE and the hull does not
    // extend past the chord along it (deviation covers the perpendicular;
    // the projection check covers control overhang past endpoints, which
    // reverse links have at the top level).
    const chordLen = Math.hypot(p2x - p1x, p2y - p1y)
    if (chordLen > 0) {
      const nx = (p2y - p1y) / chordLen
      const ny = (p1x - p2x) / chordLen
      const d1 = Math.abs((q1x - p1x) * nx + (q1y - p1y) * ny)
      const d2 = Math.abs((q2x - p1x) * nx + (q2y - p1y) * ny)
      // Each factor is pre-divided by chordLen so the products never
      // overflow to Infinity (which would make t1/t2 NaN and silently
      // disable flat detection at huge coordinate scales).
      const t1 = ((q1x - p1x) / chordLen) * ((p2x - p1x) / chordLen) + ((q1y - p1y) / chordLen) * ((p2y - p1y) / chordLen)
      const t2 = ((q2x - p1x) / chordLen) * ((p2x - p1x) / chordLen) + ((q2y - p1y) / chordLen) * ((p2y - p1y) / chordLen)
      if (d1 <= CUBIC_FLATNESS && d2 <= CUBIC_FLATNESS && t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1) {
        best = Math.min(best, segmentDistance(px, py, p1x, p1y, p2x, p2y))
        continue
      }
    }
    // De Casteljau split at t = 0.5.
    const ax = mid(p1x, q1x), ay = mid(p1y, q1y)
    const bx2 = mid(q1x, q2x), by2 = mid(q1y, q2y)
    const cx = mid(q2x, p2x), cy = mid(q2y, p2y)
    const dx2 = mid(ax, bx2), dy2 = mid(ay, by2)
    const ex = mid(bx2, cx), ey = mid(by2, cy)
    const mx = mid(dx2, ex), my = mid(dy2, ey)
    // Stagnation backstop: a child bitwise-identical to its parent would
    // recurse forever - subdivision has hit the representation floor, so
    // the chord is the finest measurable answer. (Curve midpoints merely
    // touching an endpoint - loops, cusps - do NOT trigger this; their
    // children differ from the parent and keep subdividing.)
    const leftIsParent =
      ax === q1x && ay === q1y && dx2 === q2x && dy2 === q2y && mx === p2x && my === p2y
    const rightIsParent =
      mx === p1x && my === p1y && ex === q1x && ey === q1y && cx === q2x && cy === q2y
    if (leftIsParent || rightIsParent) {
      best = Math.min(best, segmentDistance(px, py, p1x, p1y, p2x, p2y))
      continue
    }
    stack.push(p1x, p1y, ax, ay, dx2, dy2, mx, my)
    stack.push(mx, my, ex, ey, cx, cy, p2x, p2y)
  }
  return best
}

/**
 * Nearest link within LINK_HIT_RADIUS of the point. Links render as cubic
 * beziers with horizontal control offsets (renderer.drawLink); this measures
 * a bounded-error curve-distance approximation via adaptive flattening
 * (cubicDistance, error <= CUBIC_FLATNESS), so noodles of ANY length have
 * no unhittable painted stretches. Links draw UNDER nodes, so callers must
 * test nodes first.
 */
export function hitTestLink(
  scene: Scene,
  wx: number,
  wy: number,
  midpointHandle = true,
  hitRadius = LINK_HIT_RADIUS,
): SceneLink | undefined {
  let best: SceneLink | undefined
  let bestDist = hitRadius
  for (const link of scene.links) {
    // A collapsed net's noodle is not painted, so it cannot be hit; its
    // endpoint tags are the interactive surface.
    if (link.hidden === true) continue
    // Boundary binding noodles hit like any other noodle: selection and
    // delete are legal (delete lowers to boundary.unbind, never
    // link.disconnect - the host routes on link.boundary). Only gestures
    // that require a document link id (reroute insertion) exclude them.
    // The midpoint dot is the advertised handle: its wider grab ring maps
    // onto the curve-distance scale so the nearest link still wins ties.
    // Net delivery noodles paint no dot, so they get no widened ring; only
    // the curve itself is their hit surface.
    const midDist = Math.hypot(wx - (link.x1 + link.x2) / 2, wy - (link.y1 + link.y2) / 2)
    if (midpointHandle && link.netId === undefined && midDist <= LINK_MIDPOINT_HIT_RADIUS) {
      const scaled = midDist * (hitRadius / LINK_MIDPOINT_HIT_RADIUS)
      if (scaled < bestDist) {
        bestDist = scaled
        best = link
      }
    }
    const bounds = linkBounds(link.x1, link.y1, link.x2, link.y2)
    if (
      wx < bounds.minX - hitRadius ||
      wx > bounds.maxX + hitRadius ||
      wy < bounds.minY - hitRadius ||
      wy > bounds.maxY + hitRadius
    ) {
      continue
    }
    const dx = linkControlOffset(link.x1, link.x2)
    const d = cubicDistance(
      wx, wy,
      link.x1, link.y1,
      link.x1 + dx, link.y1,
      link.x2 - dx, link.y2,
      link.x2, link.y2,
      bestDist,
    )
    if (d <= bestDist) {
      bestDist = d
      best = link
    }
  }
  return best
}

export function hitTestPin(
  scene: Scene,
  wx: number,
  wy: number,
  pinRevealed?: (node: SceneNode, pin: PinLayout) => boolean,
  hitRadius = PIN_HIT_RADIUS,
): Extract<Hit, { kind: 'pin' }> | undefined {
  let best: Extract<Hit, { kind: 'pin' }> | undefined
  let bestDist = hitRadius
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const node = scene.nodes[i]!
    if (node.layout.minimized) continue
    for (const pin of node.layout.pins) {
      if (pin.widgetTap === true) continue
      if (pin.familyOwner !== undefined && pin.familyOwner.socketed !== true) continue
      if (pinRevealed && !pinRevealed(node, pin)) continue
      const px = pin.direction === 'in' ? node.x : node.x + node.layout.width
      const py = node.y + pin.y
      const d = Math.hypot(wx - px, wy - py)
      if (d <= bestDist) {
        bestDist = d
        best = { kind: 'pin', node, portId: pin.portId, direction: pin.direction, x: px, y: py, type: pin.type, pin }
      }
    }
  }
  return best
}

/** Nearest boundary pseudo-node pin within PIN_HIT_RADIUS of the point. */
export function hitTestBoundaryPin(
  scene: Scene,
  wx: number,
  wy: number,
  hitRadius = PIN_HIT_RADIUS,
): Extract<Hit, { kind: 'boundary-pin' }> | undefined {
  let best: Extract<Hit, { kind: 'boundary-pin' }> | undefined
  let bestDist = hitRadius
  for (let i = scene.boundaryNodes.length - 1; i >= 0; i--) {
    const bnode = scene.boundaryNodes[i]!
    for (const pin of bnode.layout.pins) {
      const px = pin.direction === 'in' ? bnode.x : bnode.x + bnode.layout.width
      const py = bnode.y + pin.y
      const d = Math.hypot(wx - px, wy - py)
      if (d <= bestDist) {
        bestDist = d
        best = { kind: 'boundary-pin', bnode, item: pin.portId, direction: pin.direction, x: px, y: py, type: pin.type, ...(pin.regionIndex ? { regionIndex: true } : {}) }
      }
    }
  }
  return best
}

/** Nearest value-source output pin within PIN_HIT_RADIUS of the point. */
export function hitTestValueSourcePin(
  scene: Scene,
  wx: number,
  wy: number,
  hitRadius = PIN_HIT_RADIUS,
): Extract<Hit, { kind: 'valueSourceOut' }> | undefined {
  let best: Extract<Hit, { kind: 'valueSourceOut' }> | undefined
  let bestDist = hitRadius
  for (let i = scene.valueSources.length - 1; i >= 0; i--) {
    const vs = scene.valueSources[i]!
    const pin = valueSourcePinPosition(vs)
    const d = Math.hypot(wx - pin.x, wy - pin.y)
    if (d <= bestDist) {
      bestDist = d
      best = { kind: 'valueSourceOut', valueSource: vs, x: pin.x, y: pin.y, type: vs.effective.type }
    }
  }
  return best
}

/**
 * Nearest selector pin (candidate input or the output) within PIN_HIT_RADIUS.
 * Pin types are advisory: the traced concrete type when known, else wildcard
 * (a selector is a type-agnostic passthrough).
 */
export function hitTestSelectorPin(
  scene: Scene,
  wx: number,
  wy: number,
  hitRadius = PIN_HIT_RADIUS,
): Extract<Hit, { kind: 'selectorIn' | 'selectorOut' }> | undefined {
  let best: Extract<Hit, { kind: 'selectorIn' | 'selectorOut' }> | undefined
  let bestDist = hitRadius
  for (let i = scene.selectors.length - 1; i >= 0; i--) {
    const sel = scene.selectors[i]!
    const out = selectorOutPinPosition(sel)
    const dOut = Math.hypot(wx - out.x, wy - out.y)
    if (dOut <= bestDist) {
      bestDist = dOut
      const type: TypeExpr = sel.typeName ? { kind: 'concrete', name: sel.typeName } : { kind: 'wildcard' }
      best = { kind: 'selectorOut', selector: sel, x: out.x, y: out.y, type }
    }
    for (const c of sel.candidates) {
      const pin = selectorCandidatePinPosition(sel, c.id)
      if (!pin) continue
      const d = Math.hypot(wx - pin.x, wy - pin.y)
      if (d <= bestDist) {
        bestDist = d
        const type: TypeExpr = c.typeName ? { kind: 'concrete', name: c.typeName } : { kind: 'wildcard' }
        best = { kind: 'selectorIn', selector: sel, candidate: c.id, x: pin.x, y: pin.y, type }
      }
    }
  }
  return best
}

/**
 * Pin center in world coords, or undefined if the port has no pin. Resolves
 * REAL ports only: a widget tap deliberately shares its input's port id on
 * the 'out' side, so an id+direction lookup would otherwise grab the widget
 * row when a real output uses the same id (LoadImage: widget input 'image'
 * + real output 'image'). Pass `widgetTap: true` to resolve the tap pin.
 */
export function pinPosition(
  node: SceneNode,
  portId: string,
  direction: 'in' | 'out',
  widgetTap = false,
): { x: number; y: number } | undefined {
  const pin = node.layout.pins.find((p) => p.portId === portId && p.direction === direction && (p.widgetTap === true) === widgetTap)
  if (!pin) return undefined
  return { x: direction === 'in' ? node.x : node.x + node.layout.width, y: node.y + pin.y }
}
