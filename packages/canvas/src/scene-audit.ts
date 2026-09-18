/**
 * Scene audit: machine-checkable geometry/identity invariants over a built
 * Scene, so canvas wreckage cannot hide behind behaviorally green tests -
 * the canvas twin of the DOM layout audit (e2e/tests/ui-audit.ts).
 *
 * Born from the 2026-07-25 field failures: noodles anchored to the wrong
 * pin when a widget tap shared its id with a real output, and earlier
 * layout bugs that no behavioral assertion tripped. Every invariant here is
 * one an agent (or CI) can run over ANY scene - golden workflows, synthetic
 * matrices, or a live document - and get human-readable findings naming
 * exactly what is visually wrong and where.
 *
 * The audit is read-only and total: it never throws on malformed scenes,
 * it reports. Specs assert the findings list is empty.
 */
import type { PinLayout } from './layout.js'
import {
  portEndKey,
  selectorCandidatePinPosition,
  selectorOutPinPosition,
  valueSourcePinPosition,
  type Scene,
  type SceneBoundaryNode,
  type SceneLink,
  type SceneLinkEnd,
  type SceneNode,
} from './scene.js'

export interface SceneFinding {
  /** What the finding is about ("node 'n0'", "link 'l1' from-end", ...). */
  readonly subject: string
  readonly finding: string
}

/** Coordinate comparison tolerance (world units). */
const EPSILON = 0.5

const near = (a: number, b: number): boolean => Math.abs(a - b) <= EPSILON

/**
 * Audit every node, boundary pseudo-node, and link endpoint in the scene.
 * Empty result = all invariants hold.
 */
export function auditScene(scene: Scene): SceneFinding[] {
  const findings: SceneFinding[] = []
  for (const node of scene.nodes) auditNodeLayout(`node '${node.id}'`, node.layout, findings)
  for (const bnode of scene.boundaryNodes) auditNodeLayout(`boundary '${bnode.side}'`, bnode.layout, findings)
  for (const link of scene.links) auditLink(scene, link, findings)
  for (const stub of scene.netStubs) auditNetStub(scene, stub, findings)
  return findings
}

interface NodeLayoutLike {
  readonly width: number
  readonly height: number
  readonly headerHeight: number
  readonly pins: readonly PinLayout[]
  readonly rows: readonly { readonly kind: string; readonly y: number; readonly height: number }[]
}

/**
 * Per-node invariants:
 *  - every pin sits inside the node's vertical extent
 *  - pin identity is unambiguous: at most one pin per (portId, direction,
 *    tapness) - the same-id widget-tap/real-output collision class
 *  - no two painted same-direction pins share a row (overlapping sockets);
 *    family-owner pins are paint-suppressed and exempt
 *  - rows stay inside the body (below the header, above the bottom edge)
 */
function auditNodeLayout(subject: string, layout: NodeLayoutLike, findings: SceneFinding[]): void {
  const seen = new Map<string, PinLayout>()
  const painted = new Map<string, PinLayout>()
  for (const pin of layout.pins) {
    if (pin.y <= 0 || pin.y > layout.height + EPSILON) {
      findings.push({ subject, finding: `pin '${pin.portId}' (${pin.direction}${pin.widgetTap ? ', tap' : ''}) at y=${pin.y} lies outside the node body (height ${layout.height})` })
    }
    // Identity keys mirror the resolvers: real ports resolve by portId
    // (elab key), taps by address.port - each must be unambiguous in the
    // keyspace it is actually looked up in.
    const identity = pin.widgetTap === true
      ? `tap\u0000${pin.direction}\u0000${pin.address.port}`
      : `port\u0000${pin.direction}\u0000${pin.portId}`
    const dup = seen.get(identity)
    if (dup) {
      findings.push({ subject, finding: `duplicate pin identity '${pin.portId}' (${pin.direction}${pin.widgetTap ? ', tap' : ''}): rows y=${dup.y} and y=${pin.y} - lookups by id+direction are ambiguous` })
    } else {
      seen.set(identity, pin)
    }
    if (pin.familyOwner === undefined) {
      const rowKey = `${pin.direction}\u0000${Math.round(pin.y * 2)}`
      const overlap = painted.get(rowKey)
      if (overlap) {
        // Connected ports hidden by the SAME collapsed section share the
        // section header row on purpose - co-location, not overlap.
        const sameCollapsedSection = pin.collapsedSection !== undefined && overlap.collapsedSection === pin.collapsedSection
        const sameMinimizedNode = pin.minimized === true && overlap.minimized === true
        if (!sameCollapsedSection && !sameMinimizedNode) {
          findings.push({ subject, finding: `pins '${overlap.portId}' and '${pin.portId}' (${pin.direction}) overlap at y=${pin.y}` })
        }
      } else {
        painted.set(rowKey, pin)
      }
    }
  }
  for (const row of layout.rows) {
    if (row.y < layout.headerHeight - EPSILON) {
      findings.push({ subject, finding: `${row.kind} row at y=${row.y} overlaps the header (headerHeight ${layout.headerHeight})` })
    }
    if (row.y + row.height > layout.height + EPSILON) {
      findings.push({ subject, finding: `${row.kind} row at y=${row.y} (height ${row.height}) extends past the node bottom (height ${layout.height})` })
    }
  }
}

/**
 * Link endpoint invariants: each end resolves to an existing scene entity
 * of the RIGHT kind (port ends to real port pins of the correct direction,
 * tap ends to widget tap pins, ...) and the link's stored coordinates equal
 * that entity's anchor. A link whose endpoint resolves but whose geometry
 * disagrees is exactly the "noodle from the wrong row" class of bug.
 */
function auditLink(scene: Scene, link: SceneLink, findings: SceneFinding[]): void {
  const fromAnchor = endpointAnchor(scene, link.from, 'out', `link '${link.id}' from-end`, findings, link.boundaryFamily === true)
  if (fromAnchor && !(near(link.x1, fromAnchor.x) && near(link.y1, fromAnchor.y))) {
    findings.push({ subject: `link '${link.id}' from-end`, finding: `anchored at (${link.x1}, ${link.y1}) but its ${describeEnd(link.from)} pin is at (${fromAnchor.x}, ${fromAnchor.y})` })
  }
  const toAnchor = endpointAnchor(scene, link.to, 'in', `link '${link.id}' to-end`, findings, link.boundaryFamily === true)
  if (toAnchor && !(near(link.x2, toAnchor.x) && near(link.y2, toAnchor.y))) {
    findings.push({ subject: `link '${link.id}' to-end`, finding: `anchored at (${link.x2}, ${link.y2}) but its ${describeEnd(link.to)} pin is at (${toAnchor.x}, ${toAnchor.y})` })
  }
}

const describeEnd = (end: SceneLinkEnd): string => {
  switch (end.kind) {
    case 'port': return `port '${end.node}.${end.port}'`
    case 'widgetTap': return `widget tap '${end.node}.${end.input}'`
    case 'reroute': return `reroute '${end.reroute}'`
    case 'valueSource': return `value source '${end.valueSource}'`
    case 'selector': return end.candidate !== undefined ? `selector '${end.selector}/${end.candidate}'` : `selector '${end.selector}' output`
    case 'boundary': return `boundary ${end.side} item '${end.item}'`
  }
}

/**
 * The world coordinate a link end must anchor at, or undefined after
 * reporting why it could not resolve. Direction is the PIN direction this
 * end must land on (from-ends produce, to-ends consume).
 */
function endpointAnchor(
  scene: Scene,
  end: SceneLinkEnd,
  direction: 'in' | 'out',
  subject: string,
  findings: SceneFinding[],
  familyBind: boolean,
): { x: number; y: number } | undefined {
  switch (end.kind) {
    case 'port': {
      const node = scene.nodes.find((n) => n.id === end.node)
      if (!node) {
        findings.push({ subject, finding: `references missing node '${end.node}'` })
        return undefined
      }
      const key = portEndKey(end)
      // Real port only: the same-id widget tap must never satisfy this.
      const pin = node.layout.pins.find((p) => p.direction === direction && p.portId === key && p.widgetTap !== true)
      if (pin) {
        return { x: direction === 'out' ? node.x + node.layout.width : node.x, y: node.y + pin.y }
      }
      if (familyBind) {
        // A family-bound boundary noodle (link.boundaryFamily) binds a
        // dynamic FAMILY, not one exact port: the builder (innerAnchor)
        // anchors on the first family-member pin, or the header center when
        // no member is laid out. Mirror both. Exact 'port' bindings never
        // take this path - a missing precise pin on them IS a finding.
        const edgeX = direction === 'out' ? node.x + node.layout.width : node.x
        const familyPin = node.layout.pins.find(
          (p) =>
            p.direction === direction &&
            p.widgetTap !== true &&
            (p.address.port === end.port || p.address.port.startsWith(`${end.port}.`)) &&
            membersPrefixOk(p.address.members, end.members),
        )
        return { x: edgeX, y: node.y + (familyPin ? familyPin.y : node.layout.headerHeight / 2) }
      }
      findings.push({ subject, finding: `node '${end.node}' has no real ${direction} pin '${key}'${hasTapPin(node, key) ? ` (only a widget tap shares that id - same-id collision)` : ''}` })
      return undefined
    }
    case 'widgetTap': {
      if (direction === 'in') {
        findings.push({ subject, finding: `widget tap '${end.node}.${end.input}' used as a consumer end (taps only produce)` })
        return undefined
      }
      const node = scene.nodes.find((n) => n.id === end.node)
      if (!node) {
        findings.push({ subject, finding: `references missing node '${end.node}'` })
        return undefined
      }
      const pin = node.layout.pins.find((p) => p.widgetTap === true && p.direction === 'out' && p.address.port === end.input)
      if (!pin) {
        findings.push({ subject, finding: `node '${end.node}' has no widget tap pin '${end.input}'` })
        return undefined
      }
      return { x: node.x + node.layout.width, y: node.y + pin.y }
    }
    case 'reroute': {
      const reroute = scene.reroutes.find((r) => r.id === end.reroute)
      if (!reroute) {
        findings.push({ subject, finding: `references missing reroute '${end.reroute}'` })
        return undefined
      }
      return { x: reroute.x, y: reroute.y }
    }
    case 'valueSource': {
      const vs = scene.valueSources.find((s) => s.id === end.valueSource)
      if (!vs) {
        findings.push({ subject, finding: `references missing value source '${end.valueSource}'` })
        return undefined
      }
      if (direction === 'in') {
        findings.push({ subject, finding: `value source '${end.valueSource}' used as a consumer end (sources only produce, invariant I10)` })
        return undefined
      }
      return valueSourcePinPosition(vs)
    }
    case 'selector': {
      const sel = scene.selectors.find((s) => s.id === end.selector)
      if (!sel) {
        findings.push({ subject, finding: `references missing selector '${end.selector}'` })
        return undefined
      }
      if (end.candidate !== undefined) {
        if (direction === 'out') {
          findings.push({ subject, finding: `selector candidate '${end.selector}/${end.candidate}' used as a producer end (candidates only consume)` })
          return undefined
        }
        const pos = selectorCandidatePinPosition(sel, end.candidate)
        if (!pos) {
          findings.push({ subject, finding: `selector '${end.selector}' has no candidate '${end.candidate}'` })
          return undefined
        }
        return pos
      }
      if (direction === 'in') {
        findings.push({ subject, finding: `selector '${end.selector}' output used as a consumer end (selector outputs only produce)` })
        return undefined
      }
      return selectorOutPinPosition(sel)
    }
    case 'boundary': {
      // Side fixes direction: the Inputs panel produces into the graph,
      // the Outputs panel consumes from it - never the reverse.
      if (direction === 'out' && end.side !== 'inputs') {
        findings.push({ subject, finding: `boundary outputs item '${end.item}' used as a producer end (the Outputs panel only consumes)` })
        return undefined
      }
      if (direction === 'in' && end.side !== 'outputs') {
        findings.push({ subject, finding: `boundary inputs item '${end.item}' used as a consumer end (the Inputs panel only produces)` })
        return undefined
      }
      const bnode = scene.boundaryNodes.find((b) => b.side === end.side)
      if (!bnode) {
        findings.push({ subject, finding: `references missing boundary pseudo-node '${end.side}'` })
        return undefined
      }
      const pin = bnode.layout.pins.find((p) => p.portId === end.item)
      if (!pin) {
        findings.push({ subject, finding: `boundary '${end.side}' has no item pin '${end.item}'` })
        return undefined
      }
      return { x: boundaryPinX(bnode), y: bnode.y + pin.y }
    }
  }
}

/**
 * Net-stub invariants: a collapsed net's endpoint tag must point at an
 * existing REAL port pin (source tags at out pins, sink tags at in pins;
 * nets never source from widget taps) and its stored pinX/pinY must equal
 * that pin's anchor - the tag-beside-the-wrong-row twin of the link check.
 */
function auditNetStub(scene: Scene, stub: Scene['netStubs'][number], findings: SceneFinding[]): void {
  const subject = `net stub '${stub.netId}' (${stub.role}) at '${stub.nodeId}.${stub.portId}'`
  const node = scene.nodes.find((n) => n.id === stub.nodeId)
  if (!node) {
    findings.push({ subject, finding: `references missing node '${stub.nodeId}'` })
    return
  }
  const direction = stub.role === 'source' ? 'out' : 'in'
  const key = portEndKey({ port: stub.portId, ...(stub.members !== undefined ? { members: stub.members } : {}) })
  const pin = node.layout.pins.find((p) => p.direction === direction && p.portId === key && p.widgetTap !== true)
  if (!pin) {
    findings.push({ subject, finding: `node '${stub.nodeId}' has no real ${direction} pin '${key}'${hasTapPin(node, key) ? ` (only a widget tap shares that id - same-id collision)` : ''}` })
    return
  }
  const x = direction === 'out' ? node.x + node.layout.width : node.x
  const y = node.y + pin.y
  if (!(near(stub.pinX, x) && near(stub.pinY, y))) {
    findings.push({ subject, finding: `tag points at (${stub.pinX}, ${stub.pinY}) but its pin is at (${x}, ${y})` })
  }
}

/** Family-bind member-path prefix check (mirrors scene.ts membersPrefixOk). */
const membersPrefixOk = (
  pinMembers: readonly string[] | undefined,
  bindMembers: readonly string[] | undefined,
): boolean => {
  const prefix = bindMembers ?? []
  const full = pinMembers ?? []
  return prefix.length <= full.length && prefix.every((m, i) => full[i] === m)
}

const hasTapPin = (node: SceneNode, portId: string): boolean =>
  node.layout.pins.some((p) => p.widgetTap === true && p.portId === portId)

/** Inputs panel produces on its right edge; Outputs panel consumes on its left. */
const boundaryPinX = (bnode: SceneBoundaryNode): number =>
  bnode.side === 'inputs' ? bnode.x + bnode.layout.width : bnode.x
