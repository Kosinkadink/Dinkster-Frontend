/**
 * Scene audit tests: the geometry/identity auditor must (1) stay silent on
 * every golden workflow scene - all graphs, root and subgraphs - and (2)
 * name the exact wreckage when a scene is deliberately corrupted, including
 * the same-id widget-tap/real-output collision class that motivated it.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  documentResolver,
  importLitegraph,
  loadDocument,
  parseObjectInfo,
  type JsonObject,
  type ObjectInfoEntry,
  type WorkflowDocument,
} from '@dinkster/core'
import { auditScene, type SceneFinding } from '../src/scene-audit.js'
import { buildScene, type Scene, type SceneLink, type SceneNode } from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = (spec) =>
  spec.options['multiline'] === true ? { viewId: 'core.text', rows: 2 } : { viewId: 'core.line', rows: 1 }

const docOf = (workflow: string): WorkflowDocument =>
  workflow === 'legacy-litegraph'
    ? (importLitegraph(readJson(`fixtures/workflows/${workflow}.json`) as JsonObject, (t) => schemas.get(t)).document as WorkflowDocument)
    : (loadDocument(readJson(`fixtures/workflows/${workflow}.json`)).document as WorkflowDocument)

const sceneOf = (doc: WorkflowDocument, graphId: string): Scene =>
  buildScene({
    document: doc,
    graphId,
    resolve: documentResolver(doc, (t) => schemas.get(t)),
    tokens: defaultTokens,
    measure,
    widgetMeasure,
  })

const GOLDEN = [
  'exec-basic',
  'exec-subgraph',
  'legacy-litegraph',
  'minimal',
  'retired-scalar-member',
  'seed-basic',
  'seed-subgraph',
  'selector',
  'subgraph',
  'value-source',
] as const

describe('auditScene on golden workflows', () => {
  for (const workflow of GOLDEN) {
    it(`${workflow}: every graph audits clean`, () => {
      const doc = docOf(workflow)
      for (const graphId of Object.keys(doc.graphs)) {
        const findings = auditScene(sceneOf(doc, graphId))
        expect(findings, `${workflow}/${graphId}: ${findings.map((f) => `${f.subject}: ${f.finding}`).join('; ')}`).toEqual([])
      }
    })
  }
})

/** Deep-clone a scene so corruption never leaks between tests. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const messages = (findings: readonly SceneFinding[]): string =>
  findings.map((f) => `${f.subject}: ${f.finding}`).join('\n')

describe('auditScene on corrupted scenes', () => {
  const base = (): Scene => sceneOf(docOf('exec-basic'), 'g0')

  it('reports a link whose stored geometry disagrees with its pin', () => {
    const scene = clone(base()) as { links: SceneLink[] } & Scene
    const link = scene.links[0] as { y1: number }
    link.y1 += 25
    const findings = auditScene(scene)
    expect(findings).toHaveLength(1)
    expect(messages(findings)).toMatch(/from-end.*anchored at .* but its port .* pin is at/)
  })

  it('reports a link end referencing a missing node', () => {
    const scene = clone(base()) as { links: SceneLink[] } & Scene
    const link = scene.links[0] as { from: { kind: string; node: string } }
    link.from.node = 'ghost'
    const findings = auditScene(scene)
    expect(messages(findings)).toContain("references missing node 'ghost'")
  })

  it('reports a link end referencing a nonexistent port', () => {
    const scene = clone(base()) as { links: SceneLink[] } & Scene
    const link = scene.links[0] as { from: { kind: string; node: string; port: string } }
    link.from.port = 'nope'
    const findings = auditScene(scene)
    expect(messages(findings)).toMatch(/has no real out pin 'nope'/)
  })

  it('reports a pin laid out beyond the node body', () => {
    const scene = clone(base()) as { nodes: SceneNode[] } & Scene
    const node = scene.nodes[0]!
    const pin = node.layout.pins[0] as { y: number }
    pin.y = node.layout.height + 40
    const findings = auditScene(scene)
    expect(messages(findings)).toMatch(/lies outside the node body/)
  })

  it('reports duplicate pin identities (ambiguous id+direction lookups)', () => {
    const scene = clone(base()) as { nodes: SceneNode[] } & Scene
    const node = scene.nodes[0] as unknown as { layout: { pins: unknown[] } }
    const original = node.layout.pins[0] as { y: number }
    node.layout.pins.push({ ...original, y: original.y + 30 })
    const findings = auditScene(scene)
    expect(messages(findings)).toMatch(/duplicate pin identity/)
  })

  it('reports two painted same-direction pins overlapping on one row', () => {
    const scene = clone(base()) as { nodes: SceneNode[] } & Scene
    const node = scene.nodes.find((n) => n.layout.pins.filter((p) => p.direction === 'in').length >= 2) ?? scene.nodes[1]!
    const pins = node.layout.pins as unknown as { direction: string; y: number; portId: string }[]
    const ins = pins.filter((p) => p.direction === 'in')
    if (ins.length < 2) {
      pins.push({ ...(ins[0] as object), portId: 'other' } as never)
      const findings = auditScene(scene)
      expect(messages(findings)).toMatch(/overlap at y=/)
      return
    }
    ins[1]!.y = ins[0]!.y
    const findings = auditScene(scene)
    expect(messages(findings)).toMatch(/overlap at y=/)
  })

  it('reports a widget-tap end used as a consumer', () => {
    const scene = clone(base()) as { links: SceneLink[] } & Scene
    const link = scene.links[0] as { to: unknown }
    const from = scene.links[0]!.from as { kind: 'port'; node: string; port: string }
    link.to = { kind: 'widgetTap', node: from.node, input: from.port }
    const findings = auditScene(scene)
    expect(messages(findings)).toMatch(/taps only produce/)
  })

  it('reports a row escaping the node body (header overlap and bottom overflow)', () => {
    const scene = clone(base()) as { nodes: SceneNode[] } & Scene
    const node = scene.nodes.find((n) => n.layout.rows.length > 0)!
    const rows = node.layout.rows as unknown as { y: number; height: number }[]
    rows[0]!.y = 0 // into the header
    const findings = auditScene(scene)
    expect(messages(findings)).toMatch(/overlaps the header/)

    const scene2 = clone(base()) as { nodes: SceneNode[] } & Scene
    const node2 = scene2.nodes.find((n) => n.layout.rows.length > 0)!
    const rows2 = node2.layout.rows as unknown as { y: number; height: number }[]
    rows2[rows2.length - 1]!.height = node2.layout.height * 2
    expect(messages(auditScene(scene2))).toMatch(/extends past the node bottom/)
  })

  it('reports a value source used as a consumer end', () => {
    const doc = docOf('value-source')
    const scene = clone(sceneOf(doc, 'g0')) as { links: SceneLink[] } & Scene
    const vsLink = scene.links.find((l) => l.from.kind === 'valueSource')
    expect(vsLink).toBeDefined()
    const other = scene.links.find((l) => l !== vsLink)! as { to: unknown }
    other.to = { kind: 'valueSource', valueSource: (vsLink!.from as { valueSource: string }).valueSource }
    expect(messages(auditScene(scene))).toMatch(/sources only produce/)
  })

  it('reports a link end referencing a missing reroute', () => {
    const scene = clone(base()) as { links: SceneLink[] } & Scene
    const link = scene.links[0] as { from: unknown }
    link.from = { kind: 'reroute', reroute: 'ghost' }
    expect(messages(auditScene(scene))).toContain("references missing reroute 'ghost'")
  })

  it('reports selector direction violations (producer candidate, consumer output)', () => {
    const doc = docOf('selector')
    const scene = clone(sceneOf(doc, 'g0')) as { links: SceneLink[] } & Scene
    const candLink = scene.links.find((l) => l.to.kind === 'selector' && (l.to as { candidate?: string }).candidate !== undefined)
    expect(candLink).toBeDefined()
    const to = candLink!.to as { selector: string; candidate: string }
    ;(candLink as { from: unknown }).from = { kind: 'selector', selector: to.selector, candidate: to.candidate }
    expect(messages(auditScene(scene))).toMatch(/candidates only consume/)

    const scene2 = clone(sceneOf(doc, 'g0')) as { links: SceneLink[] } & Scene
    const outLink = scene2.links.find((l) => l.from.kind === 'selector' && (l.from as { candidate?: string }).candidate === undefined)
    expect(outLink).toBeDefined()
    ;(outLink as { to: unknown }).to = { kind: 'selector', selector: (outLink!.from as { selector: string }).selector }
    expect(messages(auditScene(scene2))).toMatch(/selector outputs only produce/)
  })
})

describe('auditScene on boundary links', () => {
  /** The subgraph-definition graph of the subgraph fixture has boundary panels. */
  const boundaryScene = (): Scene => {
    const doc = docOf('subgraph')
    for (const graphId of Object.keys(doc.graphs)) {
      const scene = sceneOf(doc, graphId)
      if (scene.links.some((l) => l.boundary === true)) return scene
    }
    throw new Error('no graph with boundary links in the subgraph fixture')
  }

  it('reports a boundary end referencing a missing boundary item', () => {
    const scene = clone(boundaryScene()) as { links: SceneLink[] } & Scene
    const blink = scene.links.find((l) => l.boundary === true && l.from.kind === 'boundary')!
    ;(blink.from as { item: string }).item = 'ghost'
    expect(messages(auditScene(scene))).toMatch(/has no item pin 'ghost'/)
  })

  it('reports an exact boundary binding whose inner anchor drifted (no family fallback)', () => {
    const scene = clone(boundaryScene()) as { links: SceneLink[] } & Scene
    const blink = scene.links.find((l) => l.boundary === true && l.boundaryFamily !== true && l.to.kind === 'port')
    expect(blink, 'fixture should carry an exact port-bound boundary input').toBeDefined()
    ;(blink as { y2: number }).y2 += 30
    expect(messages(auditScene(scene))).toMatch(/anchored at .* but its port .* pin is at/)
  })

  it('reports an exact boundary binding whose precise inner pin is missing', () => {
    const scene = clone(boundaryScene()) as { links: SceneLink[] } & Scene
    const blink = scene.links.find((l) => l.boundary === true && l.boundaryFamily !== true && l.to.kind === 'port')!
    ;(blink.to as { port: string }).port = 'nope'
    expect(messages(auditScene(scene))).toMatch(/has no real in pin 'nope'/)
  })

  it('reports a boundary side/direction violation (Outputs panel producing)', () => {
    const scene = clone(boundaryScene()) as { links: SceneLink[] } & Scene
    const blink = scene.links.find((l) => l.boundary === true && l.from.kind === 'boundary')!
    ;(blink.from as { side: string }).side = 'outputs'
    expect(messages(auditScene(scene))).toMatch(/the Outputs panel only consumes/)
  })
})

describe('auditScene on the same-id tap/output collision class', () => {
  const concrete = (name: string) => ({ kind: 'concrete' as const, name })

  /**
   * A synthetic LoadImage-shaped node: widget input 'image' (with a tap on
   * the out edge) AND a real output 'image', plus a sink node. Mirrors the
   * widget-tap.test.ts same-id fixtures.
   */
  function sameIdScene(link: SceneLink): Scene {
    const source = {
      id: 'src', x: 10, y: 10, node: { id: 'src', type: 'LoadImage', values: {} },
      layout: {
        width: 120, height: 70, headerHeight: 20, title: 'LoadImage', rows: [],
        pins: [
          { portId: 'image', address: { port: 'image' }, direction: 'in' as const, y: 32, type: concrete('ASSET'), widgetBacked: true as const },
          { portId: 'image', address: { port: 'image' }, direction: 'out' as const, y: 32, type: concrete('ASSET'), widgetTap: true as const },
          { portId: 'image', address: { port: 'image' }, direction: 'out' as const, y: 56, type: concrete('IMAGE') },
        ],
      },
    }
    const sink = {
      id: 'dst', x: 300, y: 10, node: { id: 'dst', type: 'Preview', values: {} },
      layout: {
        width: 100, height: 50, headerHeight: 20, title: 'Preview', rows: [],
        pins: [{ portId: 'source', address: { port: 'source' }, direction: 'in' as const, y: 32, type: concrete('IMAGE') }],
      },
    }
    return {
      graphId: 'g0', nodes: [source, sink], links: [link],
      reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [],
      boundaryNodes: [], diagnostics: [],
    } as unknown as Scene
  }

  it('accepts a real-output link anchored at the output row', () => {
    const findings = auditScene(sameIdScene({
      id: 'l1', from: { kind: 'port', node: 'src', port: 'image' },
      to: { kind: 'port', node: 'dst', port: 'source' },
      x1: 130, y1: 66, x2: 300, y2: 42,
    } as SceneLink))
    expect(findings).toEqual([])
  })

  it('flags a real-output link anchored at the same-id widget tap row', () => {
    const findings = auditScene(sameIdScene({
      id: 'l1', from: { kind: 'port', node: 'src', port: 'image' },
      to: { kind: 'port', node: 'dst', port: 'source' },
      x1: 130, y1: 42, x2: 300, y2: 42, // y1=42: the widget row, not the output row
    } as SceneLink))
    expect(messages(findings)).toMatch(/anchored at \(130, 42\) but its port 'src\.image' pin is at \(130, 66\)/)
  })

  it('accepts a tap-sourced link anchored at the widget row', () => {
    const findings = auditScene(sameIdScene({
      id: 'l1', from: { kind: 'widgetTap', node: 'src', input: 'image' },
      to: { kind: 'port', node: 'dst', port: 'source' },
      x1: 130, y1: 42, x2: 300, y2: 42,
    } as SceneLink))
    expect(findings).toEqual([])
  })

  it('flags a tap-sourced link anchored at the real output row', () => {
    const findings = auditScene(sameIdScene({
      id: 'l1', from: { kind: 'widgetTap', node: 'src', input: 'image' },
      to: { kind: 'port', node: 'dst', port: 'source' },
      x1: 130, y1: 66, x2: 300, y2: 42, // y1=66: the output row, not the widget row
    } as SceneLink))
    expect(messages(findings)).toMatch(/anchored at \(130, 66\) but its widget tap 'src\.image' pin is at \(130, 42\)/)
  })

  it('names the collision when only the tap carries a demanded port id', () => {
    const scene = sameIdScene({
      id: 'l1', from: { kind: 'port', node: 'src', port: 'image' },
      to: { kind: 'port', node: 'dst', port: 'source' },
      x1: 130, y1: 66, x2: 300, y2: 42,
    } as SceneLink)
    // Delete the real output: only the widget tap keeps the 'image' id.
    const src = scene.nodes[0]! as unknown as { layout: { pins: readonly { widgetTap?: true; direction: string }[] } }
    ;(src.layout as { pins: unknown }).pins = src.layout.pins.filter((p) => p.widgetTap === true || p.direction === 'in')
    const findings = auditScene(scene)
    expect(messages(findings)).toMatch(/only a widget tap shares that id - same-id collision/)
  })

  it('audits net stubs: clean at the pin, flagged when drifted or tap-shadowed', () => {
    const stub = (over: object) => ({
      id: 'net-view', netId: 'net0', name: 'img', role: 'source' as const, nodeId: 'src', portId: 'image',
      pinX: 130, pinY: 66, x: 140, y: 58, width: 40, height: 16, ...over,
    })
    const link: SceneLink = {
      id: 'l1', from: { kind: 'port', node: 'src', port: 'image' },
      to: { kind: 'port', node: 'dst', port: 'source' },
      x1: 130, y1: 66, x2: 300, y2: 42,
    } as SceneLink
    // Clean: tag points at the REAL output pin (y=66), not the tap row.
    const clean = sameIdScene(link) as { netStubs: unknown[] } & Scene
    clean.netStubs = [stub({})]
    expect(auditScene(clean)).toEqual([])
    // Drifted: tag points at the widget tap row (y=42) - wrong row.
    const drifted = sameIdScene(link) as { netStubs: unknown[] } & Scene
    drifted.netStubs = [stub({ pinY: 42 })]
    expect(messages(auditScene(drifted))).toMatch(/net stub 'net0'.*tag points at \(130, 42\) but its pin is at \(130, 66\)/)
    // Tap-shadowed: only the tap carries the id - the collision is named.
    const shadowed = sameIdScene(link) as { netStubs: unknown[]; links: unknown[] } & Scene
    shadowed.links = []
    shadowed.netStubs = [stub({})]
    const src = shadowed.nodes[0]! as unknown as { layout: { pins: readonly { widgetTap?: true; direction: string }[] } }
    ;(src.layout as { pins: unknown }).pins = src.layout.pins.filter((p) => p.widgetTap === true || p.direction === 'in')
    expect(messages(auditScene(shadowed))).toMatch(/net stub 'net0'.*only a widget tap shares that id - same-id collision/)
  })
})

describe('auditScene on collapsed-section co-location', () => {
  const concrete = (name: string) => ({ kind: 'concrete' as const, name })
  const pinAt = (portId: string, y: number, collapsedSection?: string) => ({
    portId, address: { port: portId }, direction: 'in' as const, y, type: concrete('IMAGE'),
    ...(collapsedSection !== undefined ? { collapsedSection } : {}),
  })
  const sceneWith = (pins: readonly object[]): Scene => ({
    graphId: 'g0',
    nodes: [{
      id: 'n0', x: 0, y: 0, node: { id: 'n0', type: 'T', values: {} },
      layout: { width: 100, height: 60, headerHeight: 20, title: 'T', rows: [], pins },
    }],
    links: [], reroutes: [], valueSources: [], selectors: [], netStubs: [], groups: [],
    boundaryNodes: [], diagnostics: [],
  }) as unknown as Scene

  it('same-section collapsed pins sharing the header row are NOT overlap', () => {
    expect(auditScene(sceneWith([pinAt('a', 30, 'sec'), pinAt('b', 30, 'sec')]))).toEqual([])
  })

  it('distinct minimized pins may share their aggregate side anchor', () => {
    expect(auditScene(sceneWith([
      { ...pinAt('a', 10), minimized: true },
      { ...pinAt('b', 10), minimized: true },
    ]))).toEqual([])
  })

  it('same-y pins WITHOUT a shared collapsed section still flag', () => {
    expect(messages(auditScene(sceneWith([pinAt('a', 30), pinAt('b', 30)])))).toMatch(/overlap at y=30/)
    expect(messages(auditScene(sceneWith([pinAt('a', 30, 'sec'), pinAt('b', 30, 'other')])))).toMatch(/overlap at y=30/)
  })
})
