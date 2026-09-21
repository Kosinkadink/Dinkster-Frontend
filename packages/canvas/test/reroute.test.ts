/**
 * Canvas-side reroutes: scene building (segmented links, traced type color,
 * view-state geometry with fallback) and hit priority (dots beat the noodles
 * passing through them, nodes beat dots).
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asLineageId,
  asLinkId,
  asNodeId,
  asPortId,
  asRerouteId,
  documentResolver,
  type GraphDef,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import { parseObjectInfo, type ObjectInfoEntry } from '@dinkster/core/comfy-v1'
import { buildScene, REROUTE_SOCKET_OFFSET, sceneEndId, type Scene } from '../src/scene.js'
import {
  hitTest,
  hitTestReroute,
  hitTestRerouteRevealZone,
  REROUTE_HIT_RADIUS,
  REROUTE_REVEAL_RADIUS,
  REROUTE_SOCKET_HIT_RADIUS,
  rerouteSocketAt,
} from '../src/hit.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = () => ({ viewId: 'core.line', rows: 1 })

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const rr = (id: string) => ({ reroute: asRerouteId(id) })
const reroute = (id: string) => ({ id: asRerouteId(id) })

/**
 * EmptyImage.out0 (IMAGE) -> r1 -> r2 -> PreviewImage.images, with a second
 * consumer p2 fanning out from r1. Dot positions come from view state.
 */
function reroutedDoc(withViewPositions = true): WorkflowDocument {
  const g0: GraphDef = {
    id: asGraphDefId('g0'),
    name: 'g',
    nodes: {
      src: { id: asNodeId('src'), type: 'EmptyImage', values: {} },
      p1: { id: asNodeId('p1'), type: 'PreviewImage', values: {} },
      p2: { id: asNodeId('p2'), type: 'PreviewImage', values: {} },
    },
    links: {
      l1: { id: asLinkId('l1'), from: port('src', 'out0'), to: rr('r1') },
      l2: { id: asLinkId('l2'), from: rr('r1'), to: rr('r2') },
      l3: { id: asLinkId('l3'), from: rr('r2'), to: port('p1', 'images') },
      l4: { id: asLinkId('l4'), from: rr('r1'), to: port('p2', 'images') },
    },
    nets: {},
    reroutes: { r1: reroute('r1'), r2: reroute('r2') },
    nextOrdinal: 100,
  }
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId('g0'),
    graphs: { g0 },
    view: {
      graphs: {
        g0: {
          nodes: {
            src: { position: { x: 0, y: 0 } },
            p1: { position: { x: 900, y: 0 } },
            p2: { position: { x: 900, y: 400 } },
          },
          ...(withViewPositions
            ? { reroutes: { r1: { position: { x: 400, y: 100 } }, r2: { position: { x: 600, y: 100 } } } }
            : {}),
        },
      },
    },
  }
}

function sceneOf(doc: WorkflowDocument): Scene {
  return buildScene({
    document: doc,
    graphId: 'g0',
    resolve: documentResolver(doc, (t) => schemas.get(t)),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

function sourcePresentationScene(doc: WorkflowDocument, typeName: string): Scene {
  const emptyImage = schemas.get('EmptyImage')!
  const markedEmptyImage = {
    ...emptyImage,
    items: emptyImage.items.map((item) => item.kind === 'output'
      ? { ...item, type: { kind: 'concrete' as const, name: typeName } }
      : item),
  }
  return buildScene({
    document: doc,
    graphId: 'g0',
    resolve: documentResolver(doc, (type) => type === 'EmptyImage' ? markedEmptyImage : schemas.get(type)),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })
}

function widgetTapPresentationScene(): Scene {
  const stringType = { kind: 'concrete' as const, name: 'core.string' }
  const localSchemas = new Map<string, NodeSchema>([
    ['MarkedString', {
      type: 'MarkedString', displayName: 'Marked', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'out', type: stringType }],
    }],
    ['StringWidget', {
      type: 'StringWidget', displayName: 'Widget', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'text', type: stringType, optional: false,
        widget: { widgetType: 'STRING', options: {}, default: '' },
      }],
    }],
    ['StringSink', {
      type: 'StringSink', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'in', type: stringType, optional: false }],
    }],
  ])
  const doc: WorkflowDocument = {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('tap-lineage'), root: asGraphDefId('g0'),
    graphs: { g0: {
      id: asGraphDefId('g0'), name: 'tap graph',
      nodes: {
        src: { id: asNodeId('src'), type: 'MarkedString', values: {} },
        widget: { id: asNodeId('widget'), type: 'StringWidget', values: { text: '' } },
        direct: { id: asNodeId('direct'), type: 'StringSink', values: {} },
        routed: { id: asNodeId('routed'), type: 'StringSink', values: {} },
      },
      links: {
        driver: { id: asLinkId('driver'), from: port('src', 'out'), to: port('widget', 'text') },
        direct: { id: asLinkId('direct'), from: { node: asNodeId('widget'), tap: asPortId('text') }, to: port('direct', 'in') },
        intoReroute: { id: asLinkId('intoReroute'), from: { node: asNodeId('widget'), tap: asPortId('text') }, to: rr('r1') },
        routed: { id: asLinkId('routed'), from: rr('r1'), to: port('routed', 'in') },
      },
      nets: {}, reroutes: { r1: reroute('r1') }, nextOrdinal: 20,
    } },
    view: { graphs: {} },
  }
  return buildScene({
    document: doc, graphId: 'g0', resolve: documentResolver(doc, (type) => localSchemas.get(type)),
    tokens: defaultTokens, measure, widgetMeasure,
  })
}

describe('scene building with reroutes', () => {
  const scene = sceneOf(reroutedDoc())

  it('emits dots at their view positions', () => {
    expect(scene.reroutes.map((r) => ({ id: r.id, x: r.x, y: r.y }))).toEqual(
      expect.arrayContaining([
        { id: 'r1', x: 400, y: 100 },
        { id: 'r2', x: 600, y: 100 },
      ]),
    )
  })

  it('segments links between pins and dots with endpoint objects', () => {
    const byId = new Map(scene.links.map((l) => [l.id, l]))
    expect(byId.get('l1')!.from).toEqual({ kind: 'port', node: 'src', port: 'out0' })
    expect(byId.get('l1')!.to).toEqual({ kind: 'reroute', reroute: 'r1' })
    expect(byId.get('l2')!.from).toEqual({ kind: 'reroute', reroute: 'r1' })
    expect(byId.get('l2')!.to).toEqual({ kind: 'reroute', reroute: 'r2' })
    expect(byId.get('l3')!.to).toEqual({ kind: 'port', node: 'p1', port: 'images' })
    // Segment geometry anchors at dot centers.
    expect({ x: byId.get('l2')!.x1, y: byId.get('l2')!.y1 }).toEqual({ x: 400, y: 100 })
    expect({ x: byId.get('l2')!.x2, y: byId.get('l2')!.y2 }).toEqual({ x: 600, y: 100 })
  })

  it('traces one effective type across every chain segment and the dots', () => {
    for (const link of scene.links) expect(link.typeName, link.id).toBe('IMAGE')
    for (const dot of scene.reroutes) expect(dot.typeName, dot.id).toBe('IMAGE')
  })

  it('traces core.combo identity across every chain segment and dot without provenance metadata', () => {
    const comboScene = sourcePresentationScene(reroutedDoc(), 'core.combo')
    for (const link of comboScene.links) expect(link.typeName, link.id).toBe('core.combo')
    for (const dot of comboScene.reroutes) expect(dot.typeName, dot.id).toBe('core.combo')
  })

  it('keeps ordinary core.string distinct through reroutes', () => {
    const stringScene = sourcePresentationScene(reroutedDoc(), 'core.string')
    for (const link of stringScene.links) expect(link.typeName, link.id).toBe('core.string')
    for (const dot of stringScene.reroutes) expect(dot.typeName, dot.id).toBe('core.string')
  })

  it('an undriven junction renders without a type (wildcard color)', () => {
    const doc = reroutedDoc()
    delete (doc.graphs['g0']!.links as Record<string, unknown>)['l1']
    const s = sceneOf(doc)
    for (const dot of s.reroutes) expect(dot.typeName).toBeUndefined()
    const l2 = s.links.find((l) => l.id === 'l2')!
    expect(l2.typeName).toBeUndefined()
  })

  it('dots missing view state get fallback positions, never dropped', () => {
    const s = sceneOf(reroutedDoc(false))
    expect(s.reroutes).toHaveLength(2)
    // Both still render and the chain still connects.
    expect(s.links).toHaveLength(4)
  })

  it('sceneEndId yields the drag-offset key: owning node for ports, dot id for reroutes', () => {
    // Document ID allocation prefixes ('n', 'r') keep the two namespaces
    // disjoint, so one offset map can carry both.
    expect(sceneEndId({ kind: 'port', node: 'n1', port: 'out0' })).toBe('n1')
    expect(sceneEndId({ kind: 'reroute', reroute: 'r1' })).toBe('r1')
  })
})

describe('reroute hit testing', () => {
  const scene = sceneOf(reroutedDoc())

  it('resolves a dot within its hit radius', () => {
    expect(hitTestReroute(scene, 400, 100)?.id).toBe('r1')
    expect(hitTestReroute(scene, 400 + REROUTE_HIT_RADIUS - 1, 100)?.id).toBe('r1')
    expect(hitTestReroute(scene, 400 + REROUTE_HIT_RADIUS + 2, 100)).toBeUndefined()
  })

  it('the dot beats the noodles that pass through it', () => {
    // l1/l2/l4 all touch (400,100); the junction must win.
    const hit = hitTest(scene, 400, 100)
    expect(hit.kind).toBe('reroute')
    if (hit.kind === 'reroute') expect(hit.reroute.id).toBe('r1')
  })

  it('a noodle still hits between dots', () => {
    const hit = hitTest(scene, 500, 100) // midpoint of the straight r1 -> r2 run
    expect(hit.kind).toBe('link')
    if (hit.kind === 'link') expect(hit.link.id).toBe('l2')
  })

  it('nodes beat dots when a dot hides under a node body', () => {
    const doc = reroutedDoc()
    const g0View = doc.view.graphs['g0']!
    const src = g0View.nodes['src']!.position!
    const parked = { x: src.x + 30, y: src.y + 30 }
    const view: WorkflowDocument['view'] = {
      graphs: {
        g0: { ...g0View, reroutes: { ...g0View.reroutes, r1: { position: parked } } },
      },
    }
    const s = sceneOf({ ...doc, view })
    const hit = hitTest(s, parked.x, parked.y)
    expect(hit.kind).not.toBe('reroute')
  })
})

describe('reroute ghost socket hit testing', () => {
  const scene = sceneOf(reroutedDoc())
  // r1 sits at (400,100); its sockets at x -/+ REROUTE_SOCKET_OFFSET.
  const leftX = 400 - REROUTE_SOCKET_OFFSET
  const rightX = 400 + REROUTE_SOCKET_OFFSET
  const reveal = { rerouteSockets: 'r1' }

  it('rerouteSocketAt resolves each side within the socket grab radius', () => {
    const r1 = scene.reroutes.find((r) => r.id === 'r1')!
    expect(rerouteSocketAt(r1, leftX, 100)).toBe('in')
    expect(rerouteSocketAt(r1, rightX, 100)).toBe('out')
    expect(rerouteSocketAt(r1, rightX, 100 + REROUTE_SOCKET_HIT_RADIUS - 1)).toBe('out')
    expect(rerouteSocketAt(r1, rightX + REROUTE_SOCKET_HIT_RADIUS + 1, 100)).toBeUndefined()
    expect(rerouteSocketAt(r1, 400, 100)).toBeUndefined() // dot center is not a socket
  })

  it('sockets hit only when the caller reveals that reroute', () => {
    // Unrevealed: the point over the socket falls through (the r1 -> r2
    // noodle runs right through it, so it resolves as the link).
    expect(hitTest(scene, rightX, 100).kind).not.toBe('rerouteSocket')
    const hit = hitTest(scene, rightX, 100, reveal)
    expect(hit).toMatchObject({ kind: 'rerouteSocket', side: 'out', x: rightX, y: 100 })
    const left = hitTest(scene, leftX, 100, reveal)
    expect(left).toMatchObject({ kind: 'rerouteSocket', side: 'in', x: leftX, y: 100 })
  })

  it('revealing one reroute never exposes another junction sockets', () => {
    // r2 sits at (600,100): its socket regions stay inert under r1 reveal.
    const hit = hitTest(scene, 600 + REROUTE_SOCKET_OFFSET, 100, reveal)
    expect(hit.kind).not.toBe('rerouteSocket')
  })

  it('the central dot wins where dot and socket grab radii overlap', () => {
    // Just inside the dot's hit radius, on the socket side: move, not link.
    const hit = hitTest(scene, 400 + REROUTE_HIT_RADIUS - 1, 100, reveal)
    expect(hit.kind).toBe('reroute')
  })
})

describe('reroute reveal zone (direct socket approach)', () => {
  const scene = sceneOf(reroutedDoc())

  it('covers the socket positions themselves, not just the central dot', () => {
    // A pointer landing exactly where a socket will appear reveals the
    // affordance without first crossing the dot.
    expect(hitTestRerouteRevealZone(scene, 400 + REROUTE_SOCKET_OFFSET, 100)?.id).toBe('r1')
    expect(hitTestRerouteRevealZone(scene, 400 - REROUTE_SOCKET_OFFSET, 100)?.id).toBe('r1')
    // And the socket's own grab halo is inside the zone too, so a revealed
    // socket never dies under a pointer that is still allowed to grab it.
    expect(
      hitTestRerouteRevealZone(scene, 400 + REROUTE_SOCKET_OFFSET + REROUTE_SOCKET_HIT_RADIUS - 1, 100)?.id,
    ).toBe('r1')
  })

  it('ends where the sockets end; the nearest junction wins ties', () => {
    expect(hitTestRerouteRevealZone(scene, 400 + REROUTE_REVEAL_RADIUS + 2, 100)).toBeUndefined()
    // Halfway between r1 (400,100) and r2 (600,100) is out of both zones.
    expect(hitTestRerouteRevealZone(scene, 500, 100)).toBeUndefined()
    expect(hitTestRerouteRevealZone(scene, 600 - REROUTE_SOCKET_OFFSET, 100)?.id).toBe('r2')
  })
})
