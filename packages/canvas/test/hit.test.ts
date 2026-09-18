/**
 * Hit-testing tests against real parsed schemas (the live object_info
 * fixture): pins win over bodies, widget rows resolve, world coords only.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
  documentResolver,
  loadDocument,
  parseObjectInfo,
  type NodeSchema,
  type ObjectInfoEntry,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  buildScene,
  GROUP_HEADER_HEIGHT,
  selectorBadgeRect,
  selectorCandidatePinPosition,
  selectorOutPinPosition,
  valueSourceBadgeRect,
  valueSourcePinPosition,
  type Scene,
} from '../src/scene.js'
import { hitTest, hitTestLink, hitTestPin, hoveredNodeAt, linkBounds, linkControlOffset, pinPosition, LINK_HIT_RADIUS, LINK_MIDPOINT_HIT_RADIUS, PIN_HIT_RADIUS } from '../src/hit.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = (spec) =>
  spec.options['multiline'] === true ? { viewId: 'core.text', rows: 2 } : { viewId: 'core.line', rows: 1 }

function linkPoint(x1: number, y1: number, x2: number, y2: number, t: number): { x: number; y: number } {
  const dx = linkControlOffset(x1, x2)
  const mt = 1 - t
  return {
    x: mt ** 3 * x1 + 3 * mt ** 2 * t * (x1 + dx) + 3 * mt * t ** 2 * (x2 - dx) + t ** 3 * x2,
    y: mt ** 3 * y1 + 3 * mt ** 2 * t * y1 + 3 * mt * t ** 2 * y2 + t ** 3 * y2,
  }
}

function sceneOf(workflow: string, graphId = 'g0'): Scene {
  const doc = loadDocument(readJson(`fixtures/workflows/${workflow}.json`)).document as WorkflowDocument
  return buildScene({
    document: doc,
    graphId,
    resolve: documentResolver(doc, (t) => schemas.get(t)),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

describe('hitTest', () => {
  const scene = sceneOf('exec-basic')
  const n0 = scene.nodes.find((n) => n.id === 'n0')!

  it('empty space misses everything', () => {
    expect(hitTest(scene, -10_000, -10_000)).toEqual({ kind: 'empty' })
  })

  it('header region resolves to header', () => {
    const hit = hitTest(scene, n0.x + n0.layout.width / 2, n0.y + n0.layout.headerHeight / 2)
    expect(hit.kind).toBe('header')
    if (hit.kind === 'header') expect(hit.node.id).toBe('n0')
  })

  it('a widget row resolves with its row rect in world coords', () => {
    const widgetRow = n0.layout.rows.find((r) => r.kind === 'widget')
    expect(widgetRow).toBeDefined()
    const hit = hitTest(scene, n0.x + n0.layout.width / 2, n0.y + widgetRow!.y + widgetRow!.height / 2)
    expect(hit.kind).toBe('widget')
    if (hit.kind === 'widget') {
      expect(hit.node.id).toBe('n0')
      expect(hit.x).toBe(n0.x + widgetRow!.inset)
      expect(hit.width).toBe(n0.layout.width - widgetRow!.inset * 2)
      expect(hit.y).toBe(n0.y + widgetRow!.y)
      expect(hit.height).toBe(widgetRow!.height)
      expect(hit.localX).toBe(hit.width / 2)
    }
  })

  it('non-header, non-widget interior resolves to body', () => {
    // exec-basic n1 has a connection input row (no widget) below the header.
    const n1 = scene.nodes.find((n) => n.id === 'n1')!
    const portRow = n1.layout.rows.find((r) => r.kind === 'ports')!
    // Center of the row, away from the input pin on the left edge.
    const hit = hitTest(scene, n1.x + n1.layout.width / 2, n1.y + portRow.y + portRow.height / 2)
    expect(hit.kind).toBe('body')
    if (hit.kind === 'body') expect(hit.node.id).toBe('n1')
  })

  it('aligns overview hits with omitted rows while preserving body drag and typed pins', () => {
    const widgetRow = n0.layout.rows.find((row) => row.kind === 'widget')!
    expect(hitTest(
      scene,
      n0.x + n0.layout.width / 2,
      n0.y + widgetRow.y + widgetRow.height / 2,
      { scale: 0.1, detailLevel: 'overview' },
    )).toMatchObject({ kind: 'body', node: { id: n0.id } })

    const node = scene.nodes.find((candidate) => candidate.layout.pins.some((pin) => pin.direction === 'in'))!
    const input = node.layout.pins.find((pin) => pin.direction === 'in')!
    expect(hitTest(
      scene,
      node.x - 40,
      node.y + input.y,
      { scale: 0.1, detailLevel: 'overview' },
    )).toMatchObject({ kind: 'pin', node: { id: node.id }, portId: input.portId })
  })

  it('FR3 a value source pill overlapping a node body wins the click (paint order)', () => {
    const local = sceneOf('value-source')
    const node = local.nodes[0]!
    const valueSource = local.valueSources[0]!
    ;(valueSource as any).x = node.x + 20
    ;(valueSource as any).y = node.y + 20
    expect(hitTest(local, valueSource.x + 10, valueSource.y + 10)).toMatchObject({
      kind: 'valueSource', valueSource,
    })
  })

  it('FR3 a selector box overlapping a value source pill wins the click (topmost paint)', () => {
    const local = sceneOf('selector')
    const valueScene = sceneOf('value-source')
    ;(local as any).valueSources = valueScene.valueSources
    const selector = local.selectors[0]!
    const valueSource = local.valueSources[0]!
    ;(valueSource as any).x = selector.x + 20
    ;(valueSource as any).y = selector.y + 20
    expect(hitTest(local, valueSource.x + 10, valueSource.y + 10)).toMatchObject({
      kind: 'selector', selector,
    })
  })

  it('FR3 a selector pin overlapping a node pin wins (topmost paint band)', () => {
    const local = sceneOf('selector')
    const nodeScene = sceneOf('exec-basic')
    ;(local as any).nodes = nodeScene.nodes
    const selector = local.selectors[0]!
    const node = local.nodes[0]!
    const pin = node.layout.pins.find((candidate) => candidate.widgetTap !== true)!
    const x = pin.direction === 'in' ? node.x : node.x + node.layout.width
    const y = node.y + pin.y
    ;(selector as any).x = x - selector.width
    ;(selector as any).y = y - selector.headerHeight / 2

    expect(selectorOutPinPosition(selector)).toEqual({ x, y })
    expect(hitTest(local, x, y)).toMatchObject({ kind: 'selectorOut', selector })
  })

  it('pins hit within PIN_HIT_RADIUS and win over the node body', () => {
    const pin = n0.layout.pins.find((p) => p.direction === 'out' && p.widgetTap !== true)!
    const px = n0.x + n0.layout.width
    const py = n0.y + pin.y
    // Slightly INSIDE the node body: pin must still win.
    const hit = hitTest(scene, px - 4, py + 2)
    expect(hit.kind).toBe('pin')
    if (hit.kind === 'pin') {
      expect(hit.node.id).toBe('n0')
      expect(hit.portId).toBe(pin.portId)
      expect(hit.direction).toBe('out')
      expect(hit.x).toBe(px)
      expect(hit.y).toBe(py)
    }
    // Just beyond the radius: no pin.
    expect(hitTestPin(scene, px + PIN_HIT_RADIUS + 1, py)).toBeUndefined()
  })

  it('input pins on the left edge resolve with direction in', () => {
    const n1 = scene.nodes.find((n) => n.id === 'n1')!
    const pin = n1.layout.pins.find((p) => p.direction === 'in')!
    const hit = hitTest(scene, n1.x, n1.y + pin.y)
    expect(hit.kind).toBe('pin')
    if (hit.kind === 'pin') {
      expect(hit.node.id).toBe('n1')
      expect(hit.direction).toBe('in')
    }
  })

  it('a widget-backed pin circle does not intersect its row and wins at its center', () => {
    const row = n0.layout.rows.find((r) => r.kind === 'widget')!
    const pin = n0.layout.pins.find((p) => p.widgetBacked)!
    const rectLeft = n0.x + row.inset
    expect(rectLeft - n0.x).toBeGreaterThan(defaultTokens.pinRadius)
    expect(hitTest(scene, n0.x, n0.y + pin.y)).toMatchObject({ kind: 'pin', portId: pin.portId })
  })

  it('hits socketed family-owner pins at their painted location', () => {
    const local = structuredClone(scene) as typeof scene
    const node = local.nodes.find((candidate) => candidate.id === 'n0')!
    const original = node.layout.pins.find((pin) => pin.direction === 'out' && pin.widgetTap !== true)!
    const hidden = { ...original, familyOwner: { graphId: 'g0', nodeId: 'owner', construct: 'family', socketed: true as const } }
    ;(node.layout as any).pins = [hidden]
    const x = node.x + node.layout.width
    const y = node.y + hidden.y

    expect(hitTestPin(local, x, y)).toMatchObject({ kind: 'pin', portId: hidden.portId })
    expect(hitTest(local, x, y)).toMatchObject({ kind: 'pin', portId: hidden.portId })
  })

  it('keeps family-owner pins socketless when no mutation planner is available', () => {
    const local = structuredClone(scene) as typeof scene
    const node = local.nodes.find((candidate) => candidate.id === 'n0')!
    const original = node.layout.pins.find((pin) => pin.direction === 'out' && pin.widgetTap !== true)!
    ;(node.layout as any).pins = [{ ...original, familyOwner: { graphId: 'g0', nodeId: 'owner', construct: 'family' } }]
    expect(hitTestPin(local, node.x + node.layout.width, node.y + original.y)).toBeUndefined()
  })

  it('honors pinRevealed for widget inputs without changing pure geometry callers', () => {
    const node = n0
    const widgetPin = node.layout.pins.find((pin) => pin.direction === 'in' && pin.widgetBacked === true)!
    const ordinaryPin = node.layout.pins.find((pin) => pin.widgetBacked !== true && pin.widgetTap !== true)!
    const widgetCenter = { x: node.x, y: node.y + widgetPin.y }
    const ordinaryCenter = {
      x: ordinaryPin.direction === 'in' ? node.x : node.x + node.layout.width,
      y: node.y + ordinaryPin.y,
    }
    const pinRevealed = (_node: typeof node, pin: typeof widgetPin) =>
      !(pin.direction === 'in' && pin.widgetBacked === true)

    expect(hitTest(scene, widgetCenter.x, widgetCenter.y)).toMatchObject({ kind: 'pin', portId: widgetPin.portId })
    expect(hitTest(scene, widgetCenter.x, widgetCenter.y, { pinRevealed }).kind).not.toBe('pin')
    expect(hitTest(scene, widgetCenter.x, widgetCenter.y, { pinRevealed: () => true }))
      .toMatchObject({ kind: 'pin', portId: widgetPin.portId })
    expect(hitTest(scene, ordinaryCenter.x, ordinaryCenter.y, { pinRevealed }))
      .toMatchObject({ kind: 'pin', portId: ordinaryPin.portId })
  })

  it('preserves distinct chip, row-activation, and edge-stepper zones on a controller row', () => {
    const controllerSchema: NodeSchema = {
      type: 'Controller', displayName: 'Controller', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'seed', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' } }],
    }
    const doc: WorkflowDocument = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('hit-controller'), root: asGraphDefId('g0'),
      graphs: { g0: { id: asGraphDefId('g0'), name: 'g', nodes: {
        seed: { id: asNodeId('seed'), type: 'Controller', values: {} },
      }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 2 } },
      view: { graphs: { g0: { nodes: {} } } },
    }
    const local = buildScene({ document: doc, graphId: 'g0', resolve: () => controllerSchema, tokens: defaultTokens, measure, widgetMeasure })
    const node = local.nodes[0]!
    const row = node.layout.rows.find((candidate) => candidate.kind === 'widget')!
    const at = (localX: number) => hitTest(local, node.x + localX, node.y + row.y + row.height / 2)
    expect(at(row.inset + 11)).toMatchObject({ kind: 'widget', localX: 11 })
    expect(at(node.layout.width / 2)).toMatchObject({ kind: 'widget', localX: node.layout.width / 2 - row.inset })
    expect(at(node.layout.width - row.inset - 32)).toMatchObject({ kind: 'widget', localX: node.layout.width - row.inset * 2 - 32 })
    expect(at(node.layout.width - row.inset - 11)).toMatchObject({ kind: 'widget', localX: node.layout.width - row.inset * 2 - 11 })
  })
})

describe('hoveredNodeAt (hover-reveal zone)', () => {
  const scene = sceneOf('exec-basic')
  const n0 = scene.nodes.find((n) => n.id === 'n0')!

  it('resolves interior points to the node', () => {
    expect(hoveredNodeAt(scene, n0.x + n0.layout.width / 2, n0.y + n0.layout.height / 2)?.id).toBe('n0')
  })

  it('extends past the left and right edges by the pin grab radius', () => {
    // The zone must include the pin approach area so a pointer heading for
    // a socket from outside the body still counts as hovering the node.
    const midY = n0.y + n0.layout.height / 2
    expect(hoveredNodeAt(scene, n0.x - PIN_HIT_RADIUS + 1, midY)?.id).toBe('n0')
    expect(hoveredNodeAt(scene, n0.x + n0.layout.width + PIN_HIT_RADIUS - 1, midY)?.id).toBe('n0')
    expect(hoveredNodeAt(scene, n0.x - PIN_HIT_RADIUS - 2, midY)?.id).not.toBe('n0')
  })

  it('misses empty space', () => {
    expect(hoveredNodeAt(scene, -10_000, -10_000)).toBeUndefined()
  })
})

describe('node resize border', () => {
  const scene = sceneOf('exec-basic')
  const n0 = scene.nodes.find((n) => n.id === 'n0')!
  const right = n0.x + n0.layout.width
  const bottom = n0.y + n0.layout.height

  it('resolves all four corners at non-unit zoom', () => {
    const points = {
      nw: [n0.x, n0.y], ne: [right, n0.y],
      se: [right, bottom], sw: [n0.x, bottom],
    } as const
    for (const [handle, point] of Object.entries(points)) {
      expect(hitTest(scene, point[0], point[1], { scale: 2.5 })).toMatchObject({ kind: 'resize', handle })
    }
  })

  it('leaves edge centers available to the node body or empty canvas', () => {
    const midX = (n0.x + right) / 2
    const midY = (n0.y + bottom) / 2
    expect(hitTest(scene, midX, n0.y, { scale: 2 }).kind).not.toBe('resize')
    expect(hitTest(scene, right, midY, { scale: 2 }).kind).not.toBe('resize')
    expect(hitTest(scene, midX, bottom, { scale: 2 }).kind).not.toBe('resize')
    expect(hitTest(scene, n0.x, midY, { scale: 2 }).kind).not.toBe('resize')
    expect(hitTest(scene, right + 1, midY, { scale: 2 }).kind).toBe('empty')
  })

  it('pins win over resize corners', () => {
    const pinScene = structuredClone(scene) as typeof scene
    const node = pinScene.nodes.find((n) => n.id === 'n0')!
    ;(node.layout.pins as any[]).push({
      portId: 'corner', address: { port: 'corner' }, direction: 'in', x: 0, y: 0,
      type: { kind: 'concrete', name: 'FLOAT' },
    })
    expect(hitTest(pinScene, node.x, node.y, { scale: 2 })).toMatchObject({ kind: 'pin', portId: 'corner' })
  })

  it('minimized nodes expose neither resize handles nor individual pin hits', () => {
    const minimizedScene = structuredClone(scene) as typeof scene
    const node = minimizedScene.nodes.find((candidate) => candidate.id === 'n0')!
    const pin = node.layout.pins[0]!
    ;(node as any).layout = {
      ...node.layout,
      minimized: true,
      rows: [],
      pins: node.layout.pins.map((candidate) => ({
        ...candidate,
        minimized: true,
        y: node.layout.headerHeight / 2,
      })),
    }
    expect(hitTest(
      minimizedScene,
      pin.direction === 'in' ? node.x : node.x + node.layout.width,
      node.y + node.layout.headerHeight / 2,
      { scale: 2 },
    ).kind).not.toBe('pin')
    expect(hitTest(
      minimizedScene,
      node.x - 3,
      node.y + node.layout.headerHeight / 2,
      { scale: 2 },
    ).kind).toBe('header')
    expect(hitTest(minimizedScene, node.x, node.y, { scale: 2 }).kind).toBe('header')
  })
})

describe('hitTestLink', () => {
  const scene = sceneOf('exec-basic')
  // Curve midpoint (t=0.5) is exactly the endpoint midpoint for this control
  // scheme: ((x1+x2)/2, (y1+y2)/2).
  const link = scene.links[0]!
  const mx = (link.x1 + link.x2) / 2
  const my = (link.y1 + link.y2) / 2

  it('hits the curve at its midpoint', () => {
    expect(hitTestLink(scene, mx, my)?.id).toBe(link.id)
  })

  it('misses beyond LINK_HIT_RADIUS of the curve', () => {
    // Perpendicular-ish offset well past the radius; no other link nearby in
    // this fixture.
    const miss = hitTestLink(scene, mx, my + LINK_HIT_RADIUS + 40)
    expect(miss?.id).not.toBe(link.id)
  })

  it('the midpoint grab dot forgives more than the thin curve', () => {
    // Past the curve radius but inside the advertised handle's ring.
    expect(hitTestLink(scene, mx, my + LINK_HIT_RADIUS + 4)?.id).toBe(link.id)
    expect(hitTestLink(scene, mx, my + LINK_MIDPOINT_HIT_RADIUS + 2)?.id).toBeUndefined()
  })

  it('marks link hits inside the midpoint handle radius', () => {
    expect(hitTest(scene, mx, my)).toMatchObject({ kind: 'link', link: { id: link.id }, midpoint: true })
  })

  it('omits the midpoint control but keeps a screen-sized curve target in overview', () => {
    const linkOnly = { ...scene, nodes: [], boundaryNodes: [], reroutes: [], valueSources: [], selectors: [] }
    expect(hitTest(linkOnly, mx, my + 30, { scale: 0.1, detailLevel: 'overview' })).toMatchObject({
      kind: 'link', link: { id: link.id }, midpoint: false,
    })
  })

  it('does not mark ordinary curve hits as midpoint hits', () => {
    const linkOnly = { ...scene, nodes: [], boundaryNodes: [], reroutes: [], valueSources: [], selectors: [] }
    expect(hitTest(linkOnly, link.x1, link.y1)).toMatchObject({
      kind: 'link', link: { id: link.id }, midpoint: false,
    })
  })

  it('grants net delivery noodles no midpoint flag and no widened grab ring', () => {
    const netScene = {
      ...scene, nodes: [], boundaryNodes: [], reroutes: [], valueSources: [], selectors: [],
      links: [{ ...link, id: 'net100:0', netId: 'net100', netName: 'latents' }],
    }
    // The curve still hits at its midpoint, but never as a midpoint handle.
    expect(hitTest(netScene, mx, my)).toMatchObject({
      kind: 'link', link: { id: 'net100:0' }, midpoint: false,
    })
    // Past the curve radius but inside the dot's ring: an ordinary link
    // would hit (see above); the net noodle does not.
    expect(hitTestLink(netScene, mx, my + LINK_HIT_RADIUS + 4)?.id).toBeUndefined()
  })

  it('nodes win over links in hitTest', () => {
    // A link endpoint sits on a node edge; the body/pin under it must win.
    const toEnd = link.to
    if (toEnd.kind !== 'port') throw new Error('fixture link must end at a port')
    const to = scene.nodes.find((n) => n.id === toEnd.node)!
    const hit = hitTest(scene, to.x + to.layout.width / 2, to.y + to.layout.headerHeight / 2)
    expect(hit.kind).toBe('header')
  })

  it('hitTest resolves links only over empty space', () => {
    const hit = hitTest(scene, mx, my)
    // Midpoint of the first link is empty space in this fixture.
    expect(hit.kind).toBe('link')
    if (hit.kind === 'link') expect(hit.link.id).toBe(link.id)
  })

  it('hits painted stretches between fixed samples on a long link', () => {
    const longScene = structuredClone(scene) as typeof scene
    const longLink = { ...link, x1: 0, y1: 0, x2: 4000, y2: 200 }
    ;(longScene.links as any[]) = [longLink]

    // Search halfway between each of the old 24 subdivisions. These points
    // lie on the painted cubic but maximize separation from the old sampled
    // points, proving the former point-distance algorithm left a real gap.
    const oldSamples = Array.from({ length: 25 }, (_, index) => linkPoint(0, 0, 4000, 200, index / 24))
    const candidates = Array.from({ length: 24 }, (_, index) => {
      const t = (index + 0.5) / 24
      const point = linkPoint(0, 0, 4000, 200, t)
      const oldDistance = Math.min(...oldSamples.map((sample) => Math.hypot(point.x - sample.x, point.y - sample.y)))
      return { t, point, oldDistance }
    })
    const gap = candidates.reduce((best, candidate) => candidate.oldDistance > best.oldDistance ? candidate : best)
    const segmentIndex = Math.floor(gap.t * 24)
    const a = oldSamples[segmentIndex]!
    const b = oldSamples[segmentIndex + 1]!
    const segmentX = b.x - a.x
    const segmentY = b.y - a.y
    const projection = Math.max(0, Math.min(1,
      ((gap.point.x - a.x) * segmentX + (gap.point.y - a.y) * segmentY) /
      (segmentX ** 2 + segmentY ** 2),
    ))
    const oldSegmentDistance = Math.hypot(
      gap.point.x - (a.x + projection * segmentX),
      gap.point.y - (a.y + projection * segmentY),
    )
    expect(gap.oldDistance).toBeGreaterThan(LINK_HIT_RADIUS)
    expect(oldSegmentDistance).toBeLessThan(LINK_HIT_RADIUS)
    expect(hitTestLink(longScene, gap.point.x, gap.point.y)?.id).toBe(longLink.id)

    const before = linkPoint(0, 0, 4000, 200, gap.t - 0.001)
    const after = linkPoint(0, 0, 4000, 200, gap.t + 0.001)
    const tangentX = after.x - before.x
    const tangentY = after.y - before.y
    const length = Math.hypot(tangentX, tangentY)
    const offset = LINK_HIT_RADIUS + 40
    expect(hitTestLink(
      longScene,
      gap.point.x - tangentY / length * offset,
      gap.point.y + tangentX / length * offset,
    )).toBeUndefined()
  })

  it('stays hittable everywhere on a 100k-unit link (coordinate-independent precision)', () => {
    // Adaptive flattening must not degrade with scale: any FIXED sample cap
    // eventually deviates from the painted cubic by more than the grab
    // radius once coordinates grow large enough. Probe many points on the
    // curve of a 100k-unit reverse link (the worst case: the control offset
    // is 50k+ and the hull bulges past both endpoints).
    const hugeScene = structuredClone(scene) as typeof scene
    const huge = { ...link, x1: 100000, y1: 0, x2: 0, y2: 50000 }
    ;(hugeScene.links as any[]) = [huge]
    for (let i = 1; i < 40; i++) {
      const t = i / 40
      const point = linkPoint(huge.x1, huge.y1, huge.x2, huge.y2, t)
      expect(hitTestLink(hugeScene, point.x, point.y)?.id).toBe(huge.id)
    }
    // Far from the curve still misses (the pruned descent terminates).
    expect(hitTestLink(hugeScene, 50000, -50000)).toBeUndefined()
  })

  it('stays hittable on a safe-integer-scale reverse link (no subdivision depth cap)', () => {
    // A fixed subdivision DEPTH cap fails the same way a fixed sample cap
    // does, just later: at ~4e15 coordinates a capped descent leaves chord
    // error beyond the grab radius. Probe the high-curvature region near an
    // endpoint (tiny t, where a depth-capped flattening is coarsest) and a
    // spread of interior points. Termination relies on the numeric-progress
    // guards, not a depth constant.
    const vastScene = structuredClone(scene) as typeof scene
    const vast = { ...link, x1: 4e15, y1: 0, x2: 0, y2: 4e15 }
    ;(vastScene.links as any[]) = [vast]
    for (const t of [2 ** -25, 2 ** -20, 2 ** -12, 0.25, 0.5, 0.75, 1 - 2 ** -20]) {
      const point = linkPoint(vast.x1, vast.y1, vast.x2, vast.y2, t)
      expect(hitTestLink(vastScene, point.x, point.y)?.id).toBe(vast.id)
    }
    // Far from the curve still misses at this scale too.
    expect(hitTestLink(vastScene, 2e15, -2e15)).toBeUndefined()
  })

  it('hits the lobes of a coincident-endpoint link (loop geometry is not a stagnation case)', () => {
    // Coincident endpoints make a looped cubic whose t=0.5 point equals both
    // endpoints while real lobes extend +-120*t(1-t)(1-2t) horizontally
    // (max ~11.55 units at t=(3-sqrt(3))/6). A midpoint-equals-endpoint
    // "progress" heuristic would collapse the whole loop to a point and
    // miss the lobes; the stagnation backstop must fire only on a child
    // bitwise-identical to its parent.
    const loopScene = structuredClone(scene) as typeof scene
    const loop = { ...link, x1: 200, y1: 150, x2: 200, y2: 150 }
    ;(loopScene.links as any[]) = [loop]
    expect(hitTestLink(loopScene, 211.5, 150)?.id).toBe(loop.id)
    expect(hitTestLink(loopScene, 188.5, 150)?.id).toBe(loop.id)
    expect(hitTestLink(loopScene, 200, 190)).toBeUndefined()
  })

  it('terminates and fails closed at double-extreme coordinates', () => {
    // Controls whose naive average overflows (sum > MAX_VALUE) must not
    // produce NaN spans that subdivide forever; and endpoints whose control
    // offset itself overflows to Infinity must fail closed as a miss. At
    // this magnitude one ulp (~2e292) dwarfs the grab radius, so the only
    // correct observable outcomes are termination and a miss.
    const extremeScene = structuredClone(scene) as typeof scene
    const nearMax = { ...link, x1: 1.5e308, y1: 0, x2: 1.4e308, y2: 1e308 }
    ;(extremeScene.links as any[]) = [nearMax]
    // Probe inside the hull (the curve midpoint) to force deep subdivision:
    // hit-or-miss is ulp-noise-dominated here, so assert only termination.
    const outcome = hitTestLink(extremeScene, 1.45e308, 5e307)
    expect(outcome === undefined || outcome.id === nearMax.id).toBe(true)
    // Probe away from the (finite) endpoint-average midpoint grab dot: the
    // overflowed Infinity controls must fail closed instead of hitting.
    const overflowOffset = { ...link, x1: 1e308, y1: 0, x2: -1e308, y2: 100 }
    ;(extremeScene.links as any[]) = [overflowOffset]
    expect(hitTestLink(extremeScene, 1000, 50)).toBeUndefined()
  })

  it('hits a reverse link in its horizontal control-point overhang', () => {
    const reverseScene = structuredClone(scene) as typeof scene
    const reverse = { ...link, x1: 400, y1: 100, x2: 0, y2: 300 }
    ;(reverseScene.links as any[]) = [reverse]
    const point = linkPoint(reverse.x1, reverse.y1, reverse.x2, reverse.y2, 0.1)

    expect(point.x).toBeGreaterThan(Math.max(reverse.x1, reverse.x2))
    expect(hitTestLink(reverseScene, point.x, point.y)?.id).toBe(reverse.id)
    expect(linkBounds(reverse.x1, reverse.y1, reverse.x2, reverse.y2)).toEqual({
      minX: -200,
      minY: 100,
      maxX: 600,
      maxY: 300,
    })
  })
})

describe('linkControlOffset', () => {
  it('uses the minimum offset for short horizontal spans', () => {
    expect(linkControlOffset(10, 50)).toBe(40)
  })

  it('uses half the horizontal span for long links in either direction', () => {
    expect(linkControlOffset(0, 400)).toBe(200)
    expect(linkControlOffset(400, 0)).toBe(200)
  })
})

describe('section hits', () => {
  // Synthetic sectioned schema (live object_info emits no sections yet):
  // [a] [section adv: w widget, b] [out x].
  const sectionedSchema: NodeSchema = {
    type: 'Sectioned',
    displayName: 'Sectioned',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'a', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
      { kind: 'section', id: 'adv', displayName: 'Advanced' },
      {
        kind: 'input',
        id: 'w',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        section: 'adv',
        widget: { widgetType: 'INT', options: {} },
      },
      { kind: 'input', id: 'b', type: { kind: 'concrete', name: 'IMAGE' }, optional: false, section: 'adv' },
      { kind: 'output', id: 'x', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  }

  function sectionedScene(collapsed: boolean, connected = false): Scene {
    const doc: WorkflowDocument = {
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: asLineageId('lin1'),
      root: asGraphDefId('g0'),
      graphs: {
        g0: {
          id: asGraphDefId('g0'),
          name: 'g',
          nodes: {
            s0: { id: asNodeId('s0'), type: 'Sectioned', values: {} },
            ...(connected ? { p0: { id: asNodeId('p0'), type: 'Sectioned', values: {} } } : {}),
          },
          links: connected
            ? {
                l1: {
                  id: asLinkId('l1'),
                  from: { node: asNodeId('p0'), port: asPortId('x') },
                  to: { node: asNodeId('s0'), port: asPortId('b') },
                },
              }
            : {},
          nets: {},
          reroutes: {},
          nextOrdinal: 100,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              s0: {
                position: { x: 0, y: 0 },
                ...(collapsed ? { sections: { adv: { collapsed: true } } } : {}),
              },
              ...(connected ? { p0: { position: { x: -600, y: 0 } } } : {}),
            },
          },
        },
      },
    }
    return buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (t) => (t === 'Sectioned' ? sectionedSchema : undefined),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
  }

  const nodeOf = (scene: Scene) => scene.nodes.find((n) => n.id === 's0')!
  const headerRowOf = (scene: Scene) => {
    const node = nodeOf(scene)
    const row = node.layout.rows.find((r) => r.kind === 'section')!
    return { node, row }
  }

  it('the section strip resolves to a section hit with its row', () => {
    const scene = sectionedScene(false)
    const { node, row } = headerRowOf(scene)
    const hit = hitTest(scene, node.x + node.layout.width / 2, node.y + row.y + row.height / 2)
    expect(hit.kind).toBe('section')
    if (hit.kind === 'section') {
      expect(hit.node.id).toBe('s0')
      expect(hit.row).toMatchObject({ sectionId: 'adv', collapsed: false })
    }
  })

  it('collapsed: hidden widget rows and unconnected pins cannot be hit', () => {
    const scene = sectionedScene(true)
    const node = nodeOf(scene)
    expect(node.layout.rows.some((r) => r.kind === 'widget')).toBe(false)
    // Sweep the node vertically: nothing resolves to a widget anywhere.
    for (let y = node.y; y <= node.y + node.layout.height; y += 2) {
      expect(hitTest(scene, node.x + node.layout.width / 2, y).kind).not.toBe('widget')
    }
    // Hidden ports w and b have no pins to grab.
    const { row } = headerRowOf(scene)
    const pin = hitTestPin(scene, node.x, node.y + row.y + row.height / 2)
    expect(pin).toBeUndefined()
  })

  it('collapsed: a CONNECTED hidden port keeps a grabbable pin at the header', () => {
    const scene = sectionedScene(true, true)
    const { node, row } = headerRowOf(scene)
    const pin = hitTestPin(scene, node.x, node.y + row.y + row.height / 2)
    expect(pin?.kind).toBe('pin')
    if (pin) {
      expect(pin.portId).toBe('b')
      expect(pin.direction).toBe('in')
    }
  })
})

describe('pinPosition', () => {
  const scene = sceneOf('exec-basic')

  it('returns world pin centers matching link endpoints', () => {
    const link = scene.links[0]!
    if (link.from.kind !== 'port' || link.to.kind !== 'port') throw new Error('fixture link must join ports')
    const fromEnd = link.from
    const toEnd = link.to
    const from = scene.nodes.find((n) => n.id === fromEnd.node)!
    const to = scene.nodes.find((n) => n.id === toEnd.node)!
    expect(pinPosition(from, fromEnd.port, 'out')).toEqual({ x: link.x1, y: link.y1 })
    expect(pinPosition(to, toEnd.port, 'in')).toEqual({ x: link.x2, y: link.y2 })
  })

  it('returns undefined for unknown ports', () => {
    const node = scene.nodes[0]!
    expect(pinPosition(node, 'nope', 'in')).toBeUndefined()
  })
})

describe('net stub hit testing', () => {
  // One producer with a collapsed net: a source tag overhangs its right edge.
  const producer: NodeSchema = {
    type: 'Producer',
    displayName: 'Producer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'LATENT' } }],
  }
  const consumer: NodeSchema = {
    type: 'Consumer',
    displayName: 'Consumer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'input', id: 'in0', type: { kind: 'concrete', name: 'LATENT' }, optional: false }],
  }
  const synthetic = new Map([
    ['Producer', producer],
    ['Consumer', consumer],
  ])
  const doc: WorkflowDocument = {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: {
        id: asGraphDefId('g0'),
        name: 'g',
        nodes: {
          p0: { id: asNodeId('p0'), type: 'Producer', values: {} },
          c1: { id: asNodeId('c1'), type: 'Consumer', values: {} },
        },
        links: {},
        nets: {
          t9: {
            id: asNetId('t9'),
            name: 'latents',
            source: { node: asNodeId('p0'), port: asPortId('out0') },
            sinks: [{ node: asNodeId('c1'), port: asPortId('in0') }],
          },
        },
        reroutes: {},
        nextOrdinal: 100,
      },
    },
    view: {
      graphs: {
        g0: {
          nodes: { p0: { position: { x: 0, y: 0 } }, c1: { position: { x: 500, y: 0 } } },
          collapsedNets: ['t9'],
        },
      },
    },
  }
  const scene = buildScene({
    document: doc,
    graphId: 'g0',
    resolve: (t) => synthetic.get(t),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
  const source = scene.netStubs.find((s) => s.role === 'source')!
  const sink = scene.netStubs.find((s) => s.role === 'sink')!

  it('points inside a tag resolve to netStub with the tag payload', () => {
    const hit = hitTest(scene, source.x + source.width / 2, source.y + source.height / 2)
    expect(hit.kind).toBe('netStub')
    if (hit.kind === 'netStub') {
      expect(hit.stub.netId).toBe('t9')
      expect(hit.stub.role).toBe('source')
      expect(hit.stub.nodeId).toBe('p0')
      expect(hit.stub.portId).toBe('out0')
    }
    const sinkHit = hitTest(scene, sink.x + 1, sink.y + 1)
    expect(sinkHit.kind).toBe('netStub')
    if (sinkHit.kind === 'netStub') expect(sinkHit.stub.role).toBe('sink')
  })

  it('pins still win over their own adjacent tag', () => {
    // The tag starts NET_STUB_GAP away, but the pin grab radius may overlap
    // its leading edge; the pin must take priority there.
    const hit = hitTest(scene, source.pinX, source.pinY)
    expect(hit.kind).toBe('pin')
    if (hit.kind === 'pin') expect(hit.portId).toBe('out0')
  })

  it('just outside the tag is empty space', () => {
    expect(hitTest(scene, source.x + source.width + 1, source.y - 10).kind).toBe('empty')
  })
})

describe('group hit testing', () => {
  // subgraph fixture: grp0 at (40,140) 760x300; nodes n0/n1/n2 inside it.
  const scene = sceneOf('subgraph')
  const group = scene.groups[0]!

  it('the title band resolves to group-header', () => {
    const hit = hitTest(scene, group.x + 60, group.y + GROUP_HEADER_HEIGHT / 2)
    expect(hit.kind).toBe('group-header')
    if (hit.kind === 'group-header') expect(hit.group.id).toBe('grp0')
  })

  it('all four 10px screen-space corners resolve at non-unit zoom', () => {
    const points = {
      nw: [group.x, group.y], ne: [group.x + group.width, group.y],
      se: [group.x + group.width, group.y + group.height], sw: [group.x, group.y + group.height],
    } as const
    for (const [handle, point] of Object.entries(points)) {
      expect(hitTest(scene, point[0], point[1], { scale: 2.5 })).toMatchObject({
        kind: 'group-resize', group: { id: 'grp0' }, handle,
      })
    }
    expect(hitTest(scene, group.x + group.width - 4.1, group.y + group.height - 4.1, { scale: 2.5 }).kind)
      .not.toBe('group-resize')
  })

  it('the group body falls through to empty (pan/click-through)', () => {
    // Bottom-left inside the rect: no node, link, or handle there.
    expect(hitTest(scene, group.x + 20, group.y + group.height - 20).kind).toBe('empty')
  })

  it('nodes inside the group win over the group', () => {
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    const hit = hitTest(scene, n0.x + n0.layout.width / 2, n0.y + n0.layout.headerHeight / 2)
    expect(hit.kind).toBe('header')
    if (hit.kind === 'header') expect(hit.node.id).toBe('n0')
  })

  it('a node at a group corner keeps node resize precedence', () => {
    const overlap = structuredClone(scene) as typeof scene
    const original = overlap.nodes[0]!
    const node = { ...original, x: group.x, y: group.y }
    ;(overlap.nodes as any[])[0] = node
    expect(hitTest(overlap, group.x, group.y, { scale: 2 })).toMatchObject({
      kind: 'resize', node: { id: node.id }, handle: 'nw',
    })
  })
})

describe('value source hit testing', () => {
  // value-source fixture: pill v2 at (80,140) driving n0.width/height.
  const scene = sceneOf('value-source')
  const vs = scene.valueSources[0]!

  it('the output pin wins over the pill body (link drags beat moves)', () => {
    const pin = valueSourcePinPosition(vs)
    // Just inside the pill's right edge, still within pin grab radius.
    const hit = hitTest(scene, pin.x - 2, pin.y)
    expect(hit.kind).toBe('valueSourceOut')
    if (hit.kind === 'valueSourceOut') {
      expect(hit.valueSource.id).toBe('v2')
      expect(hit.x).toBe(pin.x)
      expect(hit.y).toBe(pin.y)
    }
  })

  it('the spec badge wins over the pill body (details beat drags)', () => {
    const badge = valueSourceBadgeRect(vs)
    const hit = hitTest(scene, badge.x + badge.width / 2, badge.y + badge.height / 2)
    expect(hit.kind).toBe('valueSourceBadge')
    if (hit.kind === 'valueSourceBadge') expect(hit.valueSource.id).toBe('v2')
  })

  it('the pill body resolves to valueSource (select/drag/edit)', () => {
    // Left half of the pill: away from the badge and the output pin.
    const hit = hitTest(scene, vs.x + 10, vs.y + vs.height / 2)
    expect(hit.kind).toBe('valueSource')
    if (hit.kind === 'valueSource') expect(hit.valueSource.id).toBe('v2')
  })

  it('outside the pill misses it', () => {
    expect(hitTest(scene, vs.x - PIN_HIT_RADIUS - 1, vs.y - PIN_HIT_RADIUS - 1).kind).toBe('empty')
  })
})

describe('selector hit testing', () => {
  // selector fixture: s6 fixed (IMAGE branches) at (440,140), s9 random
  // (mixed IMAGE/LATENT) at (440,560).
  const scene = sceneOf('selector')
  const s6 = scene.selectors.find((s) => s.id === 's6')!
  const s9 = scene.selectors.find((s) => s.id === 's9')!

  it('the output pin wins over the box body and reports the traced type', () => {
    const out = selectorOutPinPosition(s6)
    // Just inside the right edge, still within pin grab radius.
    const hit = hitTest(scene, out.x - 2, out.y)
    expect(hit.kind).toBe('selectorOut')
    if (hit.kind === 'selectorOut') {
      expect(hit.selector.id).toBe('s6')
      expect({ x: hit.x, y: hit.y }).toEqual(out)
      expect(hit.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    }
  })

  it('a candidate pin wins over the box body and reports branch + type', () => {
    const pin = selectorCandidatePinPosition(s6, 'c8')!
    const hit = hitTest(scene, pin.x + 2, pin.y)
    expect(hit.kind).toBe('selectorIn')
    if (hit.kind === 'selectorIn') {
      expect(hit.selector.id).toBe('s6')
      expect(hit.candidate).toBe('c8')
      expect({ x: hit.x, y: hit.y }).toEqual(pin)
      expect(hit.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    }
  })

  it('a mixed selector reports wildcard at the output but concrete branches', () => {
    const out = hitTest(scene, selectorOutPinPosition(s9).x, selectorOutPinPosition(s9).y)
    expect(out.kind).toBe('selectorOut')
    if (out.kind === 'selectorOut') expect(out.type).toEqual({ kind: 'wildcard' })
    const latent = selectorCandidatePinPosition(s9, 'c11')!
    const branch = hitTest(scene, latent.x, latent.y)
    expect(branch.kind).toBe('selectorIn')
    if (branch.kind === 'selectorIn') expect(branch.type).toEqual({ kind: 'concrete', name: 'LATENT' })
  })

  it('the policy badge wins over the body (details beat drags)', () => {
    const badge = selectorBadgeRect(s6)
    const hit = hitTest(scene, badge.x + badge.width / 2, badge.y + badge.height / 2)
    expect(hit.kind).toBe('selectorBadge')
    if (hit.kind === 'selectorBadge') expect(hit.selector.id).toBe('s6')
  })

  it('the box interior resolves to selector (select/drag/menu)', () => {
    // Center-left of the header band: away from the badge and both pin edges.
    const hit = hitTest(scene, s6.x + s6.width / 3, s6.y + s6.headerHeight / 2)
    expect(hit.kind).toBe('selector')
    if (hit.kind === 'selector') expect(hit.selector.id).toBe('s6')
  })

  it('outside the box misses it', () => {
    expect(hitTest(scene, s6.x - PIN_HIT_RADIUS - 1, s6.y - PIN_HIT_RADIUS - 1).kind).toBe('empty')
  })
})

describe('boundary pseudo-node hit testing', () => {
  /** exec-subgraph's definition g1, optionally with saved panel positions. */
  function g1SceneWith(boundary?: {
    inputs?: { position: { x: number; y: number } }
    outputs?: { position: { x: number; y: number } }
  }): Scene {
    const doc = loadDocument(readJson('fixtures/workflows/exec-subgraph.json')).document as WorkflowDocument
    const patched: WorkflowDocument = boundary
      ? {
          ...doc,
          view: { ...doc.view, graphs: { ...doc.view.graphs, g1: { ...doc.view.graphs['g1']!, boundary } } },
        }
      : doc
    return buildScene({
      document: patched,
      graphId: 'g1',
      resolve: documentResolver(patched, (t) => schemas.get(t)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
  }

  const scene = g1SceneWith()
  const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
  const outputs = scene.boundaryNodes.find((b) => b.side === 'outputs')!

  it('header band resolves to boundary-header (the drag handle)', () => {
    const hit = hitTest(scene, inputs.x + inputs.layout.width / 2, inputs.y + inputs.layout.headerHeight / 2)
    expect(hit.kind).toBe('boundary-header')
    if (hit.kind === 'boundary-header') expect(hit.bnode.side).toBe('inputs')
  })

  it('below the header resolves to boundary-body (also draggable)', () => {
    const hit = hitTest(scene, inputs.x + 4, inputs.y + inputs.layout.height - 4)
    expect(hit.kind).toBe('boundary-body')
    if (hit.kind === 'boundary-body') expect(hit.bnode.side).toBe('inputs')
  })

  it('pins hit with the boundary item id, on the correct edge per side', () => {
    // Inputs panel feeds the graph: its pin sits on the RIGHT edge.
    const inPin = inputs.layout.pins[0]!
    const hitIn = hitTest(scene, inputs.x + inputs.layout.width, inputs.y + inPin.y)
    expect(hitIn.kind).toBe('boundary-pin')
    if (hitIn.kind === 'boundary-pin') {
      expect(hitIn.item).toBe('color')
      expect(hitIn.direction).toBe('out')
    }
    // Outputs panel consumes: its pin sits on the LEFT edge.
    const outPin = outputs.layout.pins[0]!
    const hitOut = hitTest(scene, outputs.x, outputs.y + outPin.y)
    expect(hitOut.kind).toBe('boundary-pin')
    if (hitOut.kind === 'boundary-pin') {
      expect(hitOut.item).toBe('image')
      expect(hitOut.direction).toBe('in')
    }
  })

  it('a boundary slot label row resolves as a renameable boundary-pin row', () => {
    const row = inputs.layout.rows.find((candidate) =>
      candidate.kind === 'ports' && (candidate.input ?? candidate.output)?.portId === 'color')!
    const hit = hitTest(scene, inputs.x + inputs.layout.width / 2, inputs.y + row.y + row.height / 2)
    expect(hit.kind).toBe('boundary-pin')
    if (hit.kind === 'boundary-pin') {
      expect(hit.item).toBe('color')
      expect(hit.row).toBe(true)
    }
  })

  it('a panel dragged over a real node hits ABOVE it (panels draw last)', () => {
    const n0 = g1SceneWith().nodes.find((n) => n.id === 'n0')!
    const over = g1SceneWith({ inputs: { position: { x: n0.x, y: n0.y } } })
    const bnode = over.boundaryNodes.find((b) => b.side === 'inputs')!
    // Dead center of the overlapped node body: the panel claims it.
    const hit = hitTest(over, bnode.x + bnode.layout.width / 2, bnode.y + bnode.layout.height - 4)
    expect(hit.kind === 'boundary-body' || hit.kind === 'boundary-header').toBe(true)
  })

  it('binding noodles hit-test like ordinary noodles (selection/deletion parity)', () => {
    const bind = scene.links.find((l) => l.boundary)!
    // Sample the exact midpoint of the noodle's straight-line span: the
    // boundary noodle is clickable there, exactly like a real link.
    const hit = hitTestLink(scene, (bind.x1 + bind.x2) / 2, (bind.y1 + bind.y2) / 2)
    expect(hit).toBeDefined()
    expect(hit!.id).toBe(bind.id)
    expect(hit!.boundary).toBe(true)
  })
})
