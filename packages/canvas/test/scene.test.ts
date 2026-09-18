/**
 * Scene building tests against REAL parsed schemas (the live object_info
 * fixture) and the golden workflows - including subgraph instances rendered
 * through their boundary-derived schema, exactly like backend nodes.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  asGraphDefId,
  asDynamicMemberId,
  asLineageId,
  asLinkId,
  asNetId,
  asNodeId,
  asPortId,
  asSelectorCandidateId,
  asSelectorId,
  documentResolver,
  loadDocument,
  parseObjectInfo,
  type NodeProgress,
  type NodeSchema,
  type ObjectInfoEntry,
  type WorkflowDocument,
} from '@dinkster/core'
import { auditScene } from '../src/scene-audit.js'
import {
  buildScene,
  boundaryNodesInGroup,
  netDeliveryLinkId,
  nodesInGroup,
  reroutesInGroup,
  selectorsInGroup,
  nodeStatesForGraph,
  scenesEqual,
  selectorBadgeRect,
  selectorCandidatePinPosition,
  selectorOutPinPosition,
  updateSceneNodePositions,
  valueSourcesInGroup,
  valueSourcePinPosition,
  NET_STUB_GAP,
  NET_STUB_HEIGHT,
  NET_STUB_PAD_X,
  SELECTOR_MIN_WIDTH,
  VS_MIN_WIDTH,
  type Scene,
} from '../src/scene.js'
import { defaultTokens } from '../src/tokens.js'
import type { TextMeasurer, WidgetMeasure } from '../src/layout.js'

const coreRoot = join(dirname(fileURLToPath(import.meta.url)), '../../core')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(coreRoot, rel), 'utf8'))

const { schemas } = parseObjectInfo(readJson('fixtures/object_info.json') as Record<string, ObjectInfoEntry>)
const measure: TextMeasurer = (text) => text.length * 6
const widgetMeasure: WidgetMeasure = (spec) =>
  spec.options['multiline'] === true ? { viewId: 'core.text', rows: 2 } : { viewId: 'core.line', rows: 1 }

describe('netDeliveryLinkId', () => {
  it('formats a net id and sink index', () => {
    expect(netDeliveryLinkId('net100', 2)).toBe('net100:2')
  })
})

function sceneOf(workflow: string, graphId = 'g0') {
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

describe('buildScene', () => {
  it('measures each text/role once per build without retaining widths across rebuilds', () => {
    const doc = loadDocument(readJson('fixtures/workflows/exec-basic.json')).document as WorkflowDocument
    const calls = new Map<string, number>()
    const input = {
      document: doc, graphId: 'g0', resolve: documentResolver(doc, (type) => schemas.get(type)), tokens: defaultTokens,
      measure: ((text, role) => {
        const key = `${role}:${text}`
        calls.set(key, (calls.get(key) ?? 0) + 1)
        return measure(text, role)
      }) as TextMeasurer,
      widgetMeasure,
    }
    buildScene(input)
    expect(calls.size).toBeGreaterThan(0)
    expect([...calls.values()].every((count) => count === 1)).toBe(true)
    buildScene(input)
    expect([...calls.values()].every((count) => count === 2)).toBe(true)
  })

  it('reuses semantic layout while reprojecting node position geometry', () => {
    const previous = loadDocument(readJson('fixtures/workflows/exec-basic.json')).document as WorkflowDocument
    const previousGraph = previous.view.graphs.g0!
    const current = {
      ...previous,
      view: {
        ...previous.view,
        graphs: {
          ...previous.view.graphs,
          g0: {
            ...previousGraph,
            nodes: {
              ...previousGraph.nodes,
              n0: { ...previousGraph.nodes.n0, position: { x: 137, y: 251 } },
            },
          },
        },
      },
    } as WorkflowDocument
    const resolve = documentResolver(previous, (type) => schemas.get(type))
    const input = { graphId: 'g0', resolve, tokens: defaultTokens, measure, widgetMeasure }
    const before = buildScene({ ...input, document: previous })
    const updated = updateSceneNodePositions(before, previous, current, 'g0')
    const rebuilt = buildScene({ ...input, document: current })

    expect(updated).toEqual(rebuilt)
    expect(updated!.nodes.find((node) => node.id === 'n0')!.layout)
      .toBe(before.nodes.find((node) => node.id === 'n0')!.layout)
    expect(updated!.links[0]).toMatchObject({
      x1: rebuilt.links[0]!.x1,
      y1: rebuilt.links[0]!.y1,
      x2: rebuilt.links[0]!.x2,
      y2: rebuilt.links[0]!.y2,
    })

    const withStubs = {
      ...before,
      netStubs: [
        {
          id: 'offset', netId: 'net', name: 'net', role: 'source' as const, nodeId: 'n0', portId: 'out0',
          pinX: 10, pinY: 20, x: 30, y: 40, width: 50, height: 18,
        },
        {
          id: 'absolute', netId: 'net', name: 'net', role: 'source' as const, nodeId: 'n0', portId: 'out0',
          pinX: 10, pinY: 20, x: 30, y: 40, width: 50, height: 18, authoredAbsolute: true as const,
        },
      ],
    }
    const updatedStubs = updateSceneNodePositions(withStubs, previous, current, 'g0')!.netStubs
    expect(updatedStubs[0]).toMatchObject({ pinX: 67, pinY: 151, x: 87, y: 171 })
    expect(updatedStubs[1]).toMatchObject({ pinX: 67, pinY: 151, x: 30, y: 40 })
  })

  it('declines position reuse when scene-building document inputs change', () => {
    const previous = loadDocument(readJson('fixtures/workflows/exec-basic.json')).document as WorkflowDocument
    const before = buildScene({
      document: previous,
      graphId: 'g0',
      resolve: documentResolver(previous, (type) => schemas.get(type)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const graphChanged = { ...previous, graphs: { ...previous.graphs } } as WorkflowDocument
    const occurrenceChanged = { ...previous, occurrenceTopologies: {} } as WorkflowDocument
    const graphView = previous.view.graphs.g0!
    const layoutChanged = {
      ...previous,
      view: {
        ...previous.view,
        graphs: {
          ...previous.view.graphs,
          g0: {
            ...graphView,
            nodes: {
              ...graphView.nodes,
              n0: { ...graphView.nodes.n0, size: { width: 300, height: 200 } },
            },
          },
        },
      },
    } as WorkflowDocument

    expect(updateSceneNodePositions(before, previous, graphChanged, 'g0')).toBeUndefined()
    expect(updateSceneNodePositions(before, previous, occurrenceChanged, 'g0')).toBeUndefined()
    expect(updateSceneNodePositions(before, previous, layoutChanged, 'g0')).toBeUndefined()
  })

  it('invalidates positioned scene reuse when a graph mutates in place', () => {
    const doc = structuredClone(loadDocument(readJson('fixtures/workflows/exec-basic.json')).document) as WorkflowDocument
    const generation = {}
    const input = {
      document: doc,
      graphId: 'g0',
      resolve: documentResolver(doc, (type) => schemas.get(type)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      layoutGeneration: generation,
    }
    expect(buildScene(input).nodes.map((node) => node.id).sort()).toEqual(['n0', 'n1'])

    delete (doc.graphs.g0!.nodes as Record<string, unknown>)['n1']

    expect(buildScene(input).nodes.map((node) => node.id)).toEqual(['n0'])
  })

  it('exec-basic: two nodes, one link with pin-anchored endpoints', () => {
    const scene = sceneOf('exec-basic')
    expect(scene.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1'])
    expect(scene.links).toHaveLength(1)
    const link = scene.links[0]!
    const from = scene.nodes.find((n) => n.id === 'n0')!
    const to = scene.nodes.find((n) => n.id === 'n1')!
    expect(link.x1).toBe(from.x + from.layout.width)
    expect(link.x2).toBe(to.x)
    const fromPin = from.layout.pins.find((p) => p.direction === 'out' && p.portId === 'out0')!
    expect(link.y1).toBe(from.y + fromPin.y)
    expect(link.typeName).toBe('IMAGE')
  })

  it('exec-subgraph: the instance renders via its boundary-derived schema', () => {
    const scene = sceneOf('exec-subgraph')
    const instance = scene.nodes.find((n) => n.id === 'n0')!
    expect(instance.isSubgraph).toBe(true)
    expect(instance.unrecognized).toBeUndefined()
    expect(instance.missingSchema).toBeUndefined()
    // Promoted widget input + boundary output are real pins/rows.
    expect(instance.layout.pins.some((p) => p.direction === 'in' && p.portId === 'color')).toBe(true)
    expect(instance.layout.pins.some((p) => p.direction === 'out' && p.portId === 'image')).toBe(true)
    // The link from the instance's boundary output resolves like any node's.
    expect(scene.links).toHaveLength(1)
    expect(scene.links[0]!.from).toMatchObject({ kind: 'port', port: 'image' })
  })

  it('inner subgraph definitions render standalone by graph id', () => {
    const scene = sceneOf('exec-subgraph', 'g1')
    expect(scene.nodes.map((n) => n.id)).toEqual(['n0'])
    expect(scene.nodes[0]!.isSubgraph).toBe(false)
  })

  it('projects a node view color onto the scene node', () => {
    const raw = readJson('fixtures/workflows/exec-basic.json') as {
      view: { graphs: Record<string, { nodes: Record<string, { color?: string }> }> }
    }
    raw.view.graphs.g0!.nodes.n0!.color = '#355c7d'
    const doc = loadDocument(raw).document as WorkflowDocument
    const scene = buildScene({
      document: doc,
      graphId: 'g0',
      resolve: documentResolver(doc, (type) => schemas.get(type)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    expect(scene.nodes.find((node) => node.id === 'n0')!.color).toBe('#355c7d')
    expect(scene.nodes.find((node) => node.id === 'n1')!.color).toBeUndefined()
  })

  it('marks schema-declared preview emitters and preview outputs as capable', () => {
    const doc = loadDocument(readJson('fixtures/workflows/exec-basic.json')).document as WorkflowDocument
    const node = doc.graphs.g0!.nodes.n0!
    const schema = schemas.get(node.type)!
    const sceneWith = (candidate: NodeSchema) => buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (type) => type === node.type ? candidate : schemas.get(type),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const emitter = sceneWith({ ...schema, emitsPreviews: true })
    expect(emitter.nodes.find((candidate) => candidate.id === node.id)?.previewCapable).toBe(true)

    const output = sceneWith({
      ...schema,
      items: schema.items.map((item) => item.kind === 'output' ? { ...item, preview: true } : item),
    })
    expect(output.nodes.find((candidate) => candidate.id === node.id)?.previewCapable).toBe(true)
  })

  it('value sources are scene items separate from nodes, with derived INT spec', () => {
    const scene = sceneOf('value-source')
    expect(scene.nodes.map((n) => n.id).sort()).toEqual(['n0', 'n1'])
    expect(scene.valueSources).toHaveLength(1)
    const vs = scene.valueSources[0]!
    expect(vs.id).toBe('v2')
    expect(vs.x).toBe(80)
    expect(vs.y).toBe(140)
    expect(vs.width).toBeGreaterThanOrEqual(VS_MIN_WIDTH)
    // No declared spec, but INT consumers: spec derives; no conflicts.
    expect(vs.specState).toBe('derived')
    expect(vs.conflict).toBe(false)
    expect(vs.effective.spec?.widgetType).toBe('INT')
    expect(vs.typeName).toBe('INT')
    expect(vs.title).toBe('INT')
    expect(vs.valueText).toBe('128')
  })

  it('value source noodles render: direct, into a reroute, and onward (fan-out)', () => {
    const scene = sceneOf('value-source')
    const vs = scene.valueSources[0]!
    const pin = valueSourcePinPosition(vs)
    const n0 = scene.nodes.find((n) => n.id === 'n0')!

    const direct = scene.links.find((l) => l.id === 'l4')!
    expect(direct.from).toEqual({ kind: 'valueSource', valueSource: 'v2' })
    expect(direct.x1).toBe(pin.x)
    expect(direct.y1).toBe(pin.y)
    const widthPin = n0.layout.pins.find((p) => p.direction === 'in' && p.portId === 'width')!
    expect(direct.x2).toBe(n0.x)
    expect(direct.y2).toBe(n0.y + widthPin.y)
    expect(direct.typeName).toBe('INT')

    const intoReroute = scene.links.find((l) => l.id === 'l5')!
    expect(intoReroute.from).toEqual({ kind: 'valueSource', valueSource: 'v2' })
    expect(intoReroute.to).toEqual({ kind: 'reroute', reroute: 'r3' })
    expect(intoReroute.typeName).toBe('INT')

    // The reroute dot itself takes the source's advisory type color.
    expect(scene.reroutes.find((r) => r.id === 'r3')!.typeName).toBe('INT')
    const onward = scene.links.find((l) => l.id === 'l6')!
    expect(onward.typeName).toBe('INT')
  })

  it('marks a resolver-missing node type as unrecognized', () => {
    const doc = structuredClone(
      loadDocument(readJson('fixtures/workflows/exec-basic.json')).document,
    ) as WorkflowDocument
    ;(doc.graphs.g0!.nodes.n0 as { type: string }).type = 'TotallyUnknownNode'
    ;(doc.view.graphs.g0!.nodes.n0 as { collapsed?: boolean }).collapsed = true
    const scene = buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (t) => schemas.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    expect(scene.nodes.find((n) => n.id === 'n0')).toMatchObject({
      unrecognized: true,
      missingSchema: true,
      layout: { minimized: true, rows: [] },
    })
    const node = scene.nodes.find((n) => n.id === 'n0')!
    const link = scene.links.find((candidate) => candidate.from.kind === 'port' && candidate.from.node === 'n0')!
    expect(link).toMatchObject({
      x1: node.x + node.layout.width,
      y1: node.y + node.layout.headerHeight / 2,
    })
  })

  it('does not mark a resolver-recognized node type as unrecognized', () => {
    const scene = sceneOf('exec-basic')
    expect(scene.nodes.find((n) => n.id === 'n0')!.unrecognized).toBeUndefined()
  })

  it('missing-schema title provenance uses node.type as the original name', () => {
    const doc = structuredClone(
      loadDocument(readJson('fixtures/workflows/exec-basic.json')).document,
    ) as WorkflowDocument
    const node = doc.graphs.g0!.nodes.n0! as { type: string; title?: string }
    node.type = 'TotallyUnknownNode'
    node.title = 'Custom'
    const renamed = buildScene({
      document: doc, graphId: 'g0', resolve: () => undefined,
      tokens: defaultTokens, measure, widgetMeasure,
    }).nodes.find((candidate) => candidate.id === 'n0')!
    expect(renamed.layout).toMatchObject({ title: 'Custom', titleRenamed: true })

    node.title = node.type
    const same = buildScene({
      document: doc, graphId: 'g0', resolve: () => undefined,
      tokens: defaultTokens, measure, widgetMeasure,
    }).nodes.find((candidate) => candidate.id === 'n0')!
    expect(same.layout).toMatchObject({ title: 'TotallyUnknownNode', titleRenamed: false })
  })

  it('an unresolved node keeps its stored values as read-only fallback rows', () => {
    const doc = structuredClone(
      loadDocument(readJson('fixtures/workflows/exec-basic.json')).document,
    ) as unknown as { graphs: { g0: { nodes: Record<string, { type: string }> } } }
    doc.graphs.g0.nodes['n0']!.type = 'TotallyUnknownNode'
    const scene = buildScene({
      document: doc as unknown as WorkflowDocument,
      graphId: 'g0',
      resolve: (t) => schemas.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const rows = scene.nodes.find((n) => n.id === 'n0')!.layout.rows
    const fallback = rows.filter((r) => r.kind === 'fallback')
    expect(fallback.map((r) => [r.label, r.text])).toEqual([
      ['width', '64'],
      ['height', '64'],
      ['batch_size', '1'],
      ['color', '0'],
    ])
  })

  it('an unresolved node keeps its manual size override (never snaps back to natural size)', () => {
    const doc = structuredClone(
      loadDocument(readJson('fixtures/workflows/exec-basic.json')).document,
    ) as unknown as {
      graphs: { g0: { nodes: Record<string, { type: string }> } }
      view: { graphs: Record<string, { nodes: Record<string, { size?: { width: number; height: number } }> }> }
    }
    doc.graphs.g0.nodes['n0']!.type = 'TotallyUnknownNode'
    const viewNodes = (doc.view.graphs['g0'] ??= { nodes: {} }).nodes
    viewNodes['n0'] = { ...viewNodes['n0'], size: { width: 333, height: 222 } }
    const scene = buildScene({
      document: doc as unknown as WorkflowDocument,
      graphId: 'g0',
      resolve: (t) => schemas.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    expect(n0.missingSchema).toBe(true)
    expect(n0.layout.width).toBe(333)
    expect(n0.layout.height).toBe(222)
  })

  it('an unresolved node infers pins from its links so link geometry stays attached', () => {
    const doc = structuredClone(
      loadDocument(readJson('fixtures/workflows/exec-basic.json')).document,
    ) as unknown as { graphs: { g0: { nodes: Record<string, { type: string }> } } }
    // Break BOTH ends: producer n0 and consumer n1 lose their schemas.
    doc.graphs.g0.nodes['n0']!.type = 'TotallyUnknownNode'
    doc.graphs.g0.nodes['n1']!.type = 'AlsoUnknown'
    const scene = buildScene({
      document: doc as unknown as WorkflowDocument,
      graphId: 'g0',
      resolve: (t) => schemas.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    const n1 = scene.nodes.find((n) => n.id === 'n1')!
    const out = n0.layout.pins.find((p) => p.portId === 'out0')!
    const inp = n1.layout.pins.find((p) => p.portId === 'images')!
    expect(out.direction).toBe('out')
    expect(inp.direction).toBe('in')
    // The link between the two unresolved nodes survives, anchored on both pins.
    const link = scene.links.find((l) => l.id === 'l2')!
    expect(link.x1).toBe(n0.x + n0.layout.width)
    expect(link.y1).toBe(n0.y + out.y)
    expect(link.x2).toBe(n1.x)
    expect(link.y2).toBe(n1.y + inp.y)
  })

  it('an unresolved subgraph instance (missing definition) keeps values, pins, and links from outside', () => {
    const doc = structuredClone(
      loadDocument(readJson('fixtures/workflows/exec-subgraph.json')).document,
    ) as unknown as { graphs: { g0: { nodes: Record<string, { type: string }> } } }
    // The exterior view of a subgraph whose definition graph is gone: the
    // boundary-derived schema cannot resolve, but the instance must stay
    // recognizable - not an opaque shell.
    doc.graphs.g0.nodes['n0']!.type = '#gone'
    const scene = buildScene({
      document: doc as unknown as WorkflowDocument,
      graphId: 'g0',
      resolve: documentResolver(doc as unknown as WorkflowDocument, (t) => schemas.get(t)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const instance = scene.nodes.find((n) => n.id === 'n0')!
    expect(instance.unrecognized).toBe(true)
    expect(instance.missingSchema).toBe(true)
    expect(instance.isSubgraph).toBe(true)
    // The stored promoted-widget value survives as a read-only fallback row.
    const fallback = instance.layout.rows.filter((r) => r.kind === 'fallback')
    expect(fallback.map((r) => [r.label, r.text])).toEqual([['color', '123']])
    // The boundary-output link infers its pin so the noodle stays attached.
    const out = instance.layout.pins.find((p) => p.portId === 'image')!
    expect(out.direction).toBe('out')
    const link = scene.links[0]!
    expect(link.x1).toBe(instance.x + instance.layout.width)
    expect(link.y1).toBe(instance.y + out.y)
  })

  it('substitutes a link-resolved MatchType into every scene pin sharing its template', () => {
    const producer: NodeSchema = {
      type: 'ImageProducer',
      displayName: 'Image Producer',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{ kind: 'output', id: 'image', type: { kind: 'concrete', name: 'IMAGE' } }],
    }
    const match: NodeSchema = {
      type: 'Match',
      displayName: 'Match',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input', id: 'in', optional: false,
          type: {
            kind: 'variable', templateId: 'T',
            allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }, { kind: 'concrete', name: 'MASK' }],
          },
        },
        {
          kind: 'output', id: 'out',
          type: {
            kind: 'variable', templateId: 'T',
            allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }, { kind: 'concrete', name: 'MASK' }],
          },
        },
        {
          kind: 'output', id: 'list',
          type: {
            kind: 'list',
            element: {
              kind: 'variable', templateId: 'T',
              allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }, { kind: 'concrete', name: 'MASK' }],
            },
          },
        },
      ],
    }
    const doc: WorkflowDocument = {
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: asLineageId('lin-match'),
      root: asGraphDefId('g0'),
      graphs: {
        g0: {
          id: asGraphDefId('g0'),
          name: 'match',
          nodes: {
            producer: { id: asNodeId('producer'), type: producer.type, values: {} },
            match: { id: asNodeId('match'), type: match.type, values: {} },
          },
          links: {
            link: {
              id: asLinkId('link'),
              from: { node: asNodeId('producer'), port: asPortId('image') },
              to: { node: asNodeId('match'), port: asPortId('in') },
            },
          },
          nets: {},
          reroutes: {},
          nextOrdinal: 1,
        },
      },
      view: { graphs: {} },
    }
    const scene = buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (type) => (type === producer.type ? producer : type === match.type ? match : undefined),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const pins = scene.nodes.find((node) => node.id === 'match')!.layout.pins

    expect(pins.find((pin) => pin.portId === 'in')!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(pins.find((pin) => pin.portId === 'out')!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(pins.find((pin) => pin.portId === 'list')!.type).toEqual({
      kind: 'list',
      element: { kind: 'concrete', name: 'IMAGE' },
    })
    for (const pin of pins) {
      expect(pin.matchVariable).toBe('T')
      const declared = match.items.find((item) =>
        (item.kind === 'input' || item.kind === 'output') && item.id === pin.portId)
      if (declared?.kind !== 'input' && declared?.kind !== 'output') throw new Error(`missing declared pin '${pin.portId}'`)
      expect(pin.matchConstraint).toEqual(declared.type)
    }
    expect(scene.links[0]!.typeName).toBe('IMAGE')
  })

  it('projects parent input constraints into each drilled MatchType occurrence', () => {
    const variable = { kind: 'variable' as const, templateId: 'input_type' }
    const listMaker: NodeSchema = {
      type: 'ListMaker',
      displayName: 'List Maker',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'items',
          type: { kind: 'wildcard' },
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [{ kind: 'input', id: 'value', type: variable, optional: false }],
            naming: { kind: 'prefix', prefix: 'value', min: 1, max: 8 },
          },
        },
        { kind: 'output', id: 'result', type: { kind: 'list', element: variable } },
      ],
    }
    const producer = (name: string): NodeSchema => ({
      type: `${name}Producer`,
      displayName: `${name} Producer`,
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{ kind: 'output', id: 'value', type: { kind: 'concrete', name } }],
    })
    const image = producer('IMAGE')
    const latent = producer('LATENT')
    const document: WorkflowDocument = {
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: asLineageId('lin-match-occurrences'),
      root: asGraphDefId('root'),
      graphs: {
        root: {
          id: asGraphDefId('root'),
          name: 'root',
          nodes: {
            image: { id: asNodeId('image'), type: image.type, values: {} },
            latent: { id: asNodeId('latent'), type: latent.type, values: {} },
            first: { id: asNodeId('first'), type: '#body', values: {} },
            second: { id: asNodeId('second'), type: '#body', values: {} },
          },
          links: {
            latentFeed: {
              id: asLinkId('latentFeed'),
              from: { node: asNodeId('latent'), port: asPortId('value') },
              to: { selector: asSelectorId('pick'), candidate: asSelectorCandidateId('only') },
            },
            latentDelivery: {
              id: asLinkId('latentDelivery'),
              from: { selector: asSelectorId('pick') },
              to: { node: asNodeId('second'), port: asPortId('input') },
            },
          },
          nets: {
            image: {
              id: asNetId('image'),
              name: 'image',
              source: { node: asNodeId('image'), port: asPortId('value') },
              sinks: [{ node: asNodeId('first'), port: asPortId('input') }],
            },
          },
          reroutes: {},
          selectors: {
            pick: {
              id: asSelectorId('pick'),
              candidates: [{ id: asSelectorCandidateId('only') }],
              policy: { kind: 'fixed', candidate: asSelectorCandidateId('only') },
            },
          },
          nextOrdinal: 1,
        },
        body: {
          id: asGraphDefId('body'),
          name: 'body',
          nodes: {
            match: {
              id: asNodeId('match'),
              type: listMaker.type,
              values: {},
              dynamic: { items: { members: [asDynamicMemberId('m0'), asDynamicMemberId('m1')] } },
            },
          },
          links: {},
          nets: {},
          reroutes: {},
          boundary: {
            inputs: [{
              id: 'input',
              binds: {
                kind: 'port',
                node: asNodeId('match'),
                port: asPortId('items.value'),
                members: [asDynamicMemberId('m0')],
              },
            }],
            outputs: [{ id: 'output', binds: { kind: 'port', node: asNodeId('match'), port: asPortId('result') } }],
          },
          nextOrdinal: 1,
        },
      },
      view: { graphs: {} },
    }
    const resolve = documentResolver(document, (type) =>
      type === listMaker.type ? listMaker : type === image.type ? image : type === latent.type ? latent : undefined,
    )
    const occurrencePins = (node: 'first' | 'second', current = document) =>
      buildScene({
        document: current,
        graphId: asGraphDefId('body'),
        resolve: documentResolver(current, (type) =>
          type === listMaker.type ? listMaker : type === image.type ? image : type === latent.type ? latent : undefined,
        ),
        tokens: defaultTokens,
        measure,
        widgetMeasure,
        occurrence: { owner: { instancePath: [], node: asNodeId(node) }, plannerAvailable: true },
      }).nodes.find((item) => item.id === 'match')!.layout.pins

    expect(resolve('#body')).toBeDefined()
    const expectOccurrenceType = (pins: ReturnType<typeof occurrencePins>, name: string) => {
      for (const id of ['items.value#m0', 'items.value#m1']) {
        expect(pins.find((pin) => pin.portId === id)?.type).toEqual({ kind: 'concrete', name })
      }
      expect(pins.find((pin) => pin.portId === 'result')?.type).toEqual({
        kind: 'list',
        element: { kind: 'concrete', name },
      })
    }
    expectOccurrenceType(occurrencePins('first'), 'IMAGE')
    expectOccurrenceType(occurrencePins('second'), 'LATENT')

    const disconnected: WorkflowDocument = {
      ...document,
      graphs: {
        ...document.graphs,
        root: {
          ...document.graphs.root!,
          nets: {},
        },
      },
    }
    const reverted = occurrencePins('first', disconnected)
    for (const id of ['items.value#m0', 'items.value#m1']) {
      expect(reverted.find((pin) => pin.portId === id)?.type).toEqual(variable)
    }
    expect(reverted.find((pin) => pin.portId === 'result')?.type).toEqual({ kind: 'list', element: variable })
    expectOccurrenceType(occurrencePins('second', disconnected), 'LATENT')
  })

  it('projects MatchType constraints through two occurrence levels without crossing siblings', () => {
    const variable = { kind: 'variable' as const, templateId: 'T' }
    const match: NodeSchema = {
      type: 'NestedMatch',
      displayName: 'Nested Match',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'in', type: variable, optional: false },
        { kind: 'output', id: 'out', type: variable },
      ],
    }
    const producer = (name: string): NodeSchema => ({
      type: `Nested${name}Producer`,
      displayName: `${name} Producer`,
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name } }],
    })
    const image = producer('IMAGE')
    const latent = producer('LATENT')
    const document: WorkflowDocument = {
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: asLineageId('lin-nested-match-occurrences'),
      root: asGraphDefId('root'),
      graphs: {
        root: {
          id: asGraphDefId('root'),
          name: 'root',
          nodes: {
            image: { id: asNodeId('image'), type: image.type, values: {} },
            latent: { id: asNodeId('latent'), type: latent.type, values: {} },
            first: { id: asNodeId('first'), type: '#outer', values: {} },
            second: { id: asNodeId('second'), type: '#outer', values: {} },
          },
          links: {
            first: {
              id: asLinkId('first'),
              from: { node: asNodeId('image'), port: asPortId('out') },
              to: { node: asNodeId('first'), port: asPortId('input') },
            },
            second: {
              id: asLinkId('second'),
              from: { node: asNodeId('latent'), port: asPortId('out') },
              to: { node: asNodeId('second'), port: asPortId('input') },
            },
          },
          nets: {},
          reroutes: {},
          nextOrdinal: 1,
        },
        outer: {
          id: asGraphDefId('outer'),
          name: 'outer',
          nodes: { inner: { id: asNodeId('inner'), type: '#body', values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          boundary: {
            inputs: [{ id: 'input', binds: { kind: 'port', node: asNodeId('inner'), port: asPortId('input') } }],
            outputs: [{ id: 'output', binds: { kind: 'port', node: asNodeId('inner'), port: asPortId('output') } }],
          },
          nextOrdinal: 1,
        },
        body: {
          id: asGraphDefId('body'),
          name: 'body',
          nodes: { match: { id: asNodeId('match'), type: match.type, values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          boundary: {
            inputs: [{ id: 'input', binds: { kind: 'port', node: asNodeId('match'), port: asPortId('in') } }],
            outputs: [{ id: 'output', binds: { kind: 'port', node: asNodeId('match'), port: asPortId('out') } }],
          },
          nextOrdinal: 1,
        },
      },
      view: { graphs: {} },
    }
    const schema = (type: string) =>
      type === match.type ? match : type === image.type ? image : type === latent.type ? latent : undefined
    const occurrencePins = (outer: 'first' | 'second', current = document) =>
      buildScene({
        document: current,
        graphId: asGraphDefId('body'),
        resolve: documentResolver(current, schema),
        tokens: defaultTokens,
        measure,
        widgetMeasure,
        occurrence: {
          owner: { instancePath: [asNodeId(outer)], node: asNodeId('inner') },
          plannerAvailable: true,
        },
      }).nodes.find((node) => node.id === 'match')!.layout.pins
    const expectType = (pins: ReturnType<typeof occurrencePins>, name: string) => {
      expect(pins.find((pin) => pin.portId === 'in')?.type).toEqual({ kind: 'concrete', name })
      expect(pins.find((pin) => pin.portId === 'out')?.type).toEqual({ kind: 'concrete', name })
    }

    expectType(occurrencePins('first'), 'IMAGE')
    expectType(occurrencePins('second'), 'LATENT')

    const disconnected: WorkflowDocument = {
      ...document,
      graphs: {
        ...document.graphs,
        root: {
          ...document.graphs.root!,
          links: { second: document.graphs.root!.links.second! },
        },
      },
    }
    const first = occurrencePins('first', disconnected)
    expect(first.find((pin) => pin.portId === 'in')?.type).toEqual(variable)
    expect(first.find((pin) => pin.portId === 'out')?.type).toEqual(variable)
    expectType(occurrencePins('second', disconnected), 'LATENT')
  })
})

describe('sections in scenes', () => {
  // Live object_info emits no sections yet, so this uses a synthetic schema:
  // [a] [Advanced: w(INT widget), b, out x], plus a Producer feeding it.
  const sectionedSchema: NodeSchema = {
    type: 'Sectioned',
    displayName: 'Sectioned',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'a', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
      { kind: 'section', id: 'advanced', displayName: 'Advanced' },
      {
        kind: 'input',
        id: 'w',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        section: 'advanced',
        widget: { widgetType: 'INT', options: {} },
      },
      { kind: 'input', id: 'b', type: { kind: 'concrete', name: 'IMAGE' }, optional: false, section: 'advanced' },
      { kind: 'output', id: 'x', type: { kind: 'concrete', name: 'IMAGE' }, section: 'advanced' },
    ],
  }
  const producerSchema: NodeSchema = {
    type: 'Producer',
    displayName: 'Producer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'IMAGE' } }],
  }
  const consumerSchema: NodeSchema = {
    type: 'Consumer',
    displayName: 'Consumer',
    category: 'test',
    source: 'v3',
    isOutputNode: false,
    items: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false }],
  }
  const synthetic = new Map([
    ['Sectioned', sectionedSchema],
    ['Producer', producerSchema],
    ['Consumer', consumerSchema],
  ])

  function sectionedScene(collapsed: boolean, tapLinked = false, drilled = false, minimized = false) {
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
            s0: { id: asNodeId('s0'), type: 'Sectioned', values: {} },
            c0: { id: asNodeId('c0'), type: 'Consumer', values: {} },
          },
          links: {
            l1: { id: asLinkId('l1'), from: { node: asNodeId('p0'), port: asPortId('out0') }, to: { node: asNodeId('s0'), port: asPortId('b') } },
            ...(tapLinked ? {
              tap: { id: asLinkId('tap'), from: { node: asNodeId('s0'), tap: asPortId('w') }, to: { node: asNodeId('c0'), port: asPortId('value') } },
            } : {}),
          },
          nets: {
            t2: {
              id: asNetId('t2'),
              name: 'count',
              source: { node: asNodeId('p0'), port: asPortId('out0') },
              sinks: [{ node: asNodeId('s0'), port: asPortId('w') }],
            },
            t3: {
              id: asNetId('t3'),
              name: 'sinkless',
              source: { node: asNodeId('s0'), port: asPortId('x') },
              sinks: [],
            },
          },
          reroutes: {},
          nextOrdinal: 100,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              p0: { position: { x: 0, y: 0 } },
              c0: { position: { x: 800, y: 0 } },
              s0: {
                position: { x: 400, y: 0 },
                ...(collapsed ? { sections: { advanced: { collapsed: true } } } : {}),
                ...(minimized ? { collapsed: true } : {}),
              },
            },
          },
        },
      },
    }
    if (drilled) {
      ;(doc as any).root = 'root'
      ;(doc as any).graphs.root = {
        id: 'root', name: 'Root',
        nodes: { instance: { id: 'instance', type: '#g0', values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      }
      ;(doc as any).view.graphs.root = { nodes: { instance: { position: { x: 0, y: 0 } } } }
    }
    return buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (t) => synthetic.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      ...(drilled ? { occurrence: { owner: { instancePath: [], node: asNodeId('instance') }, plannerAvailable: true } } : {}),
    })
  }

  it('expanded: section row renders in place with all member rows and pins', () => {
    const s0 = sectionedScene(false).nodes.find((n) => n.id === 's0')!
    expect(s0.layout.rows.map((r) => r.kind)).toEqual(['ports', 'section', 'widget', 'ports'])
    expect(s0.layout.pins.map((p) => `${p.direction}:${p.portId}`).sort()).toEqual([
      'in:a',
      'in:b',
      'in:w',
      'out:w',
      'out:x',
    ])
  })

  it('minimized Advanced, widget-tap, and named-net endpoints remain resolvable and audit clean', () => {
    const scene = sectionedScene(false, true, false, true)
    const node = scene.nodes.find((candidate) => candidate.id === 's0')!
    const anchorY = node.y + node.layout.headerHeight / 2
    expect(node.layout).toMatchObject({ minimized: true, rows: [] })
    expect(node.layout.pins.map((pin) => `${pin.direction}:${pin.portId}`).sort()).toEqual([
      'in:a',
      'in:b',
      'in:w',
      'out:w',
      'out:x',
    ])
    expect(node.layout.pins.every((pin) => node.y + pin.y === anchorY)).toBe(true)
    for (const link of scene.links) {
      if ((link.from.kind === 'port' || link.from.kind === 'widgetTap') && link.from.node === node.id) {
        expect({ x: link.x1, y: link.y1 }).toEqual({ x: node.x + node.layout.width, y: anchorY })
      }
      if (link.to.kind === 'port' && link.to.node === node.id) {
        expect({ x: link.x2, y: link.y2 }).toEqual({ x: node.x, y: anchorY })
      }
    }
    for (const stub of scene.netStubs.filter((candidate) => candidate.nodeId === node.id)) {
      expect(stub.pinY).toBe(anchorY)
      expect(stub.pinX).toBe(stub.role === 'source' ? node.x + node.layout.width : node.x)
    }
    expect(auditScene(scene)).toEqual([])
  })

  it('collapsed via view override: member rows hide, height shrinks', () => {
    const open = sectionedScene(false).nodes.find((n) => n.id === 's0')!
    const closed = sectionedScene(true).nodes.find((n) => n.id === 's0')!
    expect(closed.layout.rows.map((r) => r.kind)).toEqual(['ports', 'section'])
    expect(closed.layout.height).toBeLessThan(open.layout.height)
    expect(closed.elaborated?.items.flatMap((item) =>
      item.kind === 'input' && item.apiName !== undefined ? [item.apiName] : [],
    )).toEqual(['a', 'w', 'b'])
  })

  it('link and named-net noodles into a collapsed section anchor on its header', () => {
    const scene = sectionedScene(true)
    const s0 = scene.nodes.find((n) => n.id === 's0')!
    const header = s0.layout.rows.find((r) => r.kind === 'section')!
    const anchorY = s0.y + header.y + header.height / 2
    // Ordinary link into hidden port b.
    const link = scene.links.find((l) => l.id === 'l1')!
    expect(link.x2).toBe(s0.x)
    expect(link.y2).toBe(anchorY)
    // Named-net noodle into hidden widget input w.
    const netLink = scene.links.find((l) => l.netId === 't2')!
    expect(netLink.y2).toBe(anchorY)
  })

  it('connected widget tap in a collapsed section keeps a header pin and noodle anchor', () => {
    const scene = sectionedScene(true, true)
    const s0 = scene.nodes.find((n) => n.id === 's0')!
    const header = s0.layout.rows.find((r) => r.kind === 'section')!
    const anchorY = s0.y + header.y + header.height / 2
    const tapPin = s0.layout.pins.find((p) => p.direction === 'out' && p.portId === 'w' && p.widgetTap === true)!
    const tapLink = scene.links.find((l) => l.id === 'tap')!

    expect(s0.y + tapPin.y).toBe(anchorY)
    expect(tapLink.from).toEqual({ kind: 'widgetTap', node: 's0', input: 'w' })
    expect(tapLink.x1).toBe(s0.x + s0.layout.width)
    expect(tapLink.y1).toBe(anchorY)
  })

  it('expansion restores exact Advanced endpoints without changing scene topology', () => {
    const expanded = sectionedScene(false, true)
    const collapsed = sectionedScene(true, true)
    const restored = sectionedScene(false, true)
    const topology = (scene: Scene) => scene.links.map((link) => ({
      id: link.id,
      from: link.from,
      to: link.to,
    }))
    const endpoints = (scene: Scene) => scene.links.map((link) => ({
      id: link.id,
      x1: link.x1,
      y1: link.y1,
      x2: link.x2,
      y2: link.y2,
    }))

    expect(topology(collapsed)).toEqual(topology(expanded))
    expect(topology(restored)).toEqual(topology(expanded))
    expect(endpoints(restored)).toEqual(endpoints(expanded))
    expect(endpoints(collapsed)).not.toEqual(endpoints(expanded))
  })

  it('unconnected widget tap in a collapsed section emits no output anchor', () => {
    const s0 = sectionedScene(true).nodes.find((n) => n.id === 's0')!
    expect(s0.layout.pins.some((p) => p.direction === 'out' && p.portId === 'w' && p.widgetTap === true)).toBe(false)
  })

  it('keeps definition net views on collapsed-section ports in a drilled occurrence', () => {
    const scene = sectionedScene(true, false, true)
    expect(scene.netStubs).toEqual(expect.arrayContaining([
      expect.objectContaining({ netId: 't3', role: 'source', nodeId: 's0', portId: 'x' }),
      expect.objectContaining({ netId: 't2', role: 'sink', nodeId: 's0', portId: 'w' }),
    ]))
  })

  it('a collapsed-section scene audits clean (same-section header co-location is not overlap)', () => {
    for (const scene of [sectionedScene(true), sectionedScene(true, true)]) {
      const findings = auditScene(scene)
      expect(findings, findings.map((f) => `${f.subject}: ${f.finding}`).join('; ')).toEqual([])
    }
  })
})

describe('nodeStatesForGraph', () => {
  it('maps direct runtime ids and aggregates subgraph instance occurrences', () => {
    const scene = sceneOf('exec-subgraph')
    const states: Record<string, NodeProgress> = {
      'n0.n0': { state: 'running', value: 0.5, max: 10 },
      n1: { state: 'pending' },
    }
    const mapped = nodeStatesForGraph(states, scene)
    expect(mapped['n1']).toEqual({ state: 'pending' })
    // The instance aggregates its inner occurrence.
    expect(mapped['n0']).toEqual({ state: 'running', value: 0.5 })
  })

  it('error anywhere inside an instance dominates the aggregate', () => {
    const scene = sceneOf('exec-subgraph')
    const mapped = nodeStatesForGraph({ 'n0.n0': { state: 'error' } }, scene)
    expect(mapped['n0']).toEqual({ state: 'error' })
  })
})

describe('nodeStatesForGraph with resolved runtime ids', () => {
  it('preserves progress for a non-subgraph node resolving to one exact id', () => {
    const scene = sceneOf('exec-subgraph')
    const mapped = nodeStatesForGraph(
      { exact: { state: 'running', value: 0.4 } },
      scene,
      (nodeId) => (nodeId === 'n1' ? ['exact'] : []),
    )
    expect(mapped['n1']).toEqual({ state: 'running', value: 0.4 })
  })

  it('aggregates several resolved ids by severity', () => {
    const scene = sceneOf('exec-subgraph')
    const mapped = nodeStatesForGraph(
      { failed: { state: 'error' }, complete: { state: 'done' } },
      scene,
      (nodeId) => (nodeId === 'n1' ? ['failed', 'complete'] : []),
    )
    expect(mapped['n1']).toEqual({ state: 'error' })
  })

  it('omits a node when resolution is empty', () => {
    const scene = sceneOf('exec-subgraph')
    expect(nodeStatesForGraph({ n1: { state: 'done' } }, scene, () => [])).not.toHaveProperty('n1')
  })

  it('always aggregates resolved ids for a subgraph node', () => {
    const scene = sceneOf('exec-subgraph')
    const mapped = nodeStatesForGraph(
      { innerA: { state: 'running', value: 0.2 }, innerB: { state: 'running', value: 0.6 } },
      scene,
      (nodeId, isSubgraph) => (nodeId === 'n0' && isSubgraph ? ['innerA', 'innerB'] : []),
    )
    expect(mapped['n0']).toEqual({ state: 'running', value: 0.4 })
  })

  it('excludes completed occurrence values from running progress', () => {
    const scene = sceneOf('exec-subgraph')
    const mapped = nodeStatesForGraph(
      { active: { state: 'running', value: 0.4 }, complete: { state: 'done', value: 1 } },
      scene,
      (nodeId, isSubgraph) => (nodeId === 'n0' && isSubgraph ? ['active', 'complete'] : []),
    )
    expect(mapped['n0']).toEqual({ state: 'running', value: 0.4 })
  })

  it('omits aggregate value when no running occurrence reports progress', () => {
    const scene = sceneOf('exec-subgraph')
    const mapped = nodeStatesForGraph(
      { active: { state: 'running' }, complete: { state: 'done', value: 1 } },
      scene,
      (nodeId, isSubgraph) => (nodeId === 'n0' && isSubgraph ? ['active', 'complete'] : []),
    )
    expect(mapped['n0']).toEqual({ state: 'running' })
  })

  it('FR6 non-finite child progress values are excluded from the aggregate', () => {
    const scene = sceneOf('exec-subgraph')
    const invalidValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    const resolve = (ids: string[]) => nodeStatesForGraph(
      Object.fromEntries(ids.map((id, index) => [id, { state: 'running', value: index === 0 ? 0.5 : invalidValues[index - 1] } as NodeProgress])),
      scene,
      (nodeId, isSubgraph) => (nodeId === 'n0' && isSubgraph ? ids : []),
    )['n0']
    expect(resolve(['finite', 'nan', 'positive-infinity', 'negative-infinity'])).toEqual({ state: 'running', value: 0.5 })
    const onlyNaN = nodeStatesForGraph(
      { invalid: { state: 'running', value: Number.NaN } }, scene,
      (nodeId, isSubgraph) => (nodeId === 'n0' && isSubgraph ? ['invalid'] : []),
    )
    expect(onlyNaN['n0']).toEqual({ state: 'running' })
    for (const value of invalidValues) {
      const onlyInvalid = nodeStatesForGraph(
        { invalid: { state: 'running', value } }, scene,
        (nodeId, isSubgraph) => (nodeId === 'n0' && isSubgraph ? ['invalid'] : []),
      )
      expect(onlyInvalid['n0']).toEqual({ state: 'running' })
    }
  })

  it('averages progress across running subgraph occurrences', () => {
    const scene = sceneOf('exec-subgraph')
    const mapped = nodeStatesForGraph(
      { first: { state: 'running', value: 0.2 }, second: { state: 'running', value: 0.6 } },
      scene,
      (nodeId, isSubgraph) => (nodeId === 'n0' && isSubgraph ? ['first', 'second'] : []),
    )
    expect(mapped['n0']).toEqual({ state: 'running', value: 0.4 })
  })
})

describe('named nets in scenes', () => {
  // Producer.out0 feeds two consumers through net 'latents'; the view decides
  // whether that renders as noodles or as collapsed endpoint tags.
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

  function netScene(collapsed: boolean, name = 'latents', guideNets?: readonly string[]) {
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
            c2: { id: asNodeId('c2'), type: 'Consumer', values: {} },
          },
          links: {},
          nets: {
            t9: {
              id: asNetId('t9'),
              name,
              source: { node: asNodeId('p0'), port: asPortId('out0') },
              sinks: [
                { node: asNodeId('c1'), port: asPortId('in0') },
                { node: asNodeId('c2'), port: asPortId('in0') },
              ],
            },
          },
          reroutes: {},
          nextOrdinal: 100,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: {
              p0: { position: { x: 0, y: 0 } },
              c1: { position: { x: 500, y: 0 } },
              c2: { position: { x: 500, y: 300 } },
            },
            ...(collapsed ? { collapsedNets: ['t9'] } : {}),
            ...(guideNets !== undefined ? { guideNets } : {}),
          },
        },
      },
    }
    return buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (t) => synthetic.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
  }

  it('visible net: one labeled noodle per sink plus authorable endpoint views', () => {
    const scene = netScene(false)
    expect(scene.netStubs).toHaveLength(3)
    const netLinks = scene.links.filter((l) => l.netId === 't9')
    expect(netLinks).toHaveLength(2)
    expect(netLinks.map((l) => l.id).sort()).toEqual(['t9:0', 't9:1'])
    expect(netLinks.every((l) => l.netName === 'latents')).toBe(true)
    expect(netLinks.every((l) => l.typeName === 'LATENT')).toBe(true)
  })

  it('projects advisory source and sink positions without crossing graph definitions', () => {
    const base = netScene(false)
    const doc = {
      format: 'dinkster-workflow' as const,
      formatVersion: 1 as const,
      lineage: asLineageId('lin1'),
      root: asGraphDefId('g0'),
      graphs: {
        g0: {
          id: asGraphDefId('g0'), name: 'g',
          nodes: Object.fromEntries(base.nodes.map((n) => [n.id, n.node])),
          links: {},
          nets: { t9: { id: asNetId('t9'), name: 'latents', source: { node: asNodeId('p0'), port: asPortId('out0') }, sinks: [{ node: asNodeId('c1'), port: asPortId('in0') }] } },
          reroutes: {}, nextOrdinal: 100,
        },
      },
      view: { graphs: { g0: { nodes: Object.fromEntries(base.nodes.map((n) => [n.id, { position: { x: n.x, y: n.y } }])) } } },
      ext: {
        'dinkster.netViews': [
          { graphId: 'other', netId: 't9', role: 'source', position: { x: 1, y: 2 } },
          { graphId: 'g0', netId: 't9', role: 'source', position: { x: 111, y: 222 } },
          { graphId: 'g0', netId: 't9', role: 'sink', to: { node: 'c1', port: 'in0' }, position: { x: 333, y: 444 } },
        ],
      },
    } satisfies WorkflowDocument
    const scene = buildScene({ document: doc, graphId: 'g0', resolve: (t) => synthetic.get(t), tokens: defaultTokens, measure, widgetMeasure })
    // Retired absolute geometry renders where it was saved and is flagged so
    // the renderer does not move it with node drags.
    expect(scene.netStubs.find((stub) => stub.role === 'source')).toMatchObject({ x: 111, y: 222, authored: true, authoredAbsolute: true })
    expect(scene.netStubs.find((stub) => stub.role === 'sink')).toMatchObject({ x: 333, y: 444, authored: true, authoredAbsolute: true })
  })

  it('anchors offset tag geometry to the owning node so tags follow node moves', () => {
    const base = netScene(false)
    const p0 = base.nodes.find((n) => n.id === 'p0')!
    const c1 = base.nodes.find((n) => n.id === 'c1')!
    const doc = {
      format: 'dinkster-workflow' as const,
      formatVersion: 1 as const,
      lineage: asLineageId('lin1'),
      root: asGraphDefId('g0'),
      graphs: {
        g0: {
          id: asGraphDefId('g0'), name: 'g',
          nodes: Object.fromEntries(base.nodes.map((n) => [n.id, n.node])),
          links: {},
          nets: { t9: { id: asNetId('t9'), name: 'latents', source: { node: asNodeId('p0'), port: asPortId('out0') }, sinks: [{ node: asNodeId('c1'), port: asPortId('in0') }] } },
          reroutes: {}, nextOrdinal: 100,
        },
      },
      view: { graphs: { g0: { nodes: Object.fromEntries(base.nodes.map((n) => [n.id, { position: { x: n.x, y: n.y } }])) } } },
      ext: {
        'dinkster.netViews': [
          { graphId: 'g0', netId: 't9', role: 'source', offset: { x: 30, y: -10 } },
          { graphId: 'g0', netId: 't9', role: 'sink', to: { node: 'c1', port: 'in0' }, offset: { x: -25, y: 40 } },
        ],
      },
    } satisfies WorkflowDocument
    const scene = buildScene({ document: doc, graphId: 'g0', resolve: (t) => synthetic.get(t), tokens: defaultTokens, measure, widgetMeasure })
    const source = scene.netStubs.find((stub) => stub.role === 'source')!
    const sink = scene.netStubs.find((stub) => stub.role === 'sink')!
    expect(source).toMatchObject({ x: p0.x + 30, y: p0.y - 10, authored: true })
    expect(source.authoredAbsolute).toBeUndefined()
    expect(sink).toMatchObject({ x: c1.x - 25, y: c1.y + 40, authored: true })
    expect(sink.authoredAbsolute).toBeUndefined()
  })

  it('collapsed net: hidden noodles for connectivity, one source tag + one tag per sink', () => {
    const scene = netScene(true)
    // The links stay in the scene so pin styling, widget suppression, and
    // gestures treat sinks as connected; `hidden` keeps them unpainted.
    const netLinks = scene.links.filter((l) => l.netId === 't9')
    expect(netLinks).toHaveLength(2)
    expect(netLinks.every((l) => l.hidden === true)).toBe(true)
    expect(scene.netStubs).toHaveLength(3)
    const roles = scene.netStubs.map((s) => `${s.role}:${s.nodeId}`).sort()
    expect(roles).toEqual(['sink:c1', 'sink:c2', 'source:p0'])
    expect(scene.netStubs.every((s) => s.name === 'latents' && s.typeName === 'LATENT')).toBe(true)
  })

  it('expanded net links carry no hidden flag', () => {
    const scene = netScene(false)
    const netLinks = scene.links.filter((l) => l.netId === 't9')
    expect(netLinks).toHaveLength(2)
    expect(netLinks.every((l) => l.hidden === undefined)).toBe(true)
  })

  it('guide mode marks the collapsed net stubs; guide entries need collapse', () => {
    const guided = netScene(true, 'latents', ['t9'])
    expect(guided.netStubs).toHaveLength(3)
    expect(guided.netStubs.every((s) => s.guide === true)).toBe(true)

    // A stray guide entry without collapse stays a plain noodle scene.
    const stray = netScene(false, 'latents', ['t9'])
    expect(stray.netStubs.every((s) => s.guide === undefined)).toBe(true)
    expect(stray.links.filter((l) => l.netId === 't9').every((l) => l.hidden === undefined)).toBe(true)
  })

  it('tag geometry: source tags sit right of the pin, sink tags left, centered on it', () => {
    const scene = netScene(true)
    const p0 = scene.nodes.find((n) => n.id === 'p0')!
    const source = scene.netStubs.find((s) => s.role === 'source')!
    const sourceWidth = measure('Set latents', 'label') + NET_STUB_PAD_X * 2
    const sinkWidth = measure('Get latents', 'label') + NET_STUB_PAD_X * 2
    expect(source.width).toBe(sourceWidth)
    expect(source.pinX).toBe(p0.x + p0.layout.width)
    expect(source.x).toBe(source.pinX + NET_STUB_GAP)
    expect(source.y).toBe(source.pinY - NET_STUB_HEIGHT / 2)

    const c1 = scene.nodes.find((n) => n.id === 'c1')!
    const sink = scene.netStubs.find((s) => s.nodeId === 'c1')!
    expect(sink.pinX).toBe(c1.x)
    expect(sink.x).toBe(sink.pinX - NET_STUB_GAP - sinkWidth)
  })
})

describe('solver verdicts on scene edges', () => {
  // A proven type conflict must be marked on the noodle itself. 'unknown'
  // verdicts (wildcard endpoints) deliberately stay unmarked - only
  // demonstrated incompatibility earns error paint.
  const typed = (name: string): { kind: 'concrete'; name: string } => ({ kind: 'concrete', name })
  const producerOf = (type: string, out: string): NodeSchema => ({
    type: `P${out}`, displayName: type, category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'output', id: 'out', type: typed(type) }],
  })
  const sink: NodeSchema = {
    type: 'SinkLatent', displayName: 'Sink', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'in', type: typed('LATENT'), optional: false }],
  }
  const imageSink: NodeSchema = {
    type: 'SinkImage', displayName: 'Image sink', category: 'test', source: 'v3', isOutputNode: false,
    items: [{ kind: 'input', id: 'in', type: typed('IMAGE'), optional: false }],
  }
  const variable = { kind: 'variable' as const, templateId: 'T' }
  const variableSwitch: NodeSchema = {
    type: 'VariableSwitch', displayName: 'Variable switch', category: 'test', source: 'v3', isOutputNode: false,
    items: [
      { kind: 'input', id: 'in', type: variable, optional: false },
      { kind: 'output', id: 'out', type: variable },
    ],
  }
  const synthetic = new Map<string, NodeSchema>([
    ['PIMG', producerOf('IMAGE', 'IMG')],
    ['PLAT', producerOf('LATENT', 'LAT')],
    ['SinkLatent', sink],
    ['SinkImage', imageSink],
    ['VariableSwitch', variableSwitch],
  ])

  function verdictScene(kind: 'link' | 'net' | 'variable') {
    const conn =
      kind === 'link'
        ? {
            links: {
              bad: { id: asLinkId('bad'), from: { node: asNodeId('img'), port: asPortId('out') }, to: { node: asNodeId('c1'), port: asPortId('in') } },
              good: { id: asLinkId('good'), from: { node: asNodeId('lat'), port: asPortId('out') }, to: { node: asNodeId('c2'), port: asPortId('in') } },
            },
            nets: {},
          }
        : kind === 'net'
          ? {
            links: {},
            nets: {
              n: {
                id: asNetId('n'),
                name: 'feed',
                source: { node: asNodeId('img'), port: asPortId('out') },
                sinks: [
                  { node: asNodeId('c1'), port: asPortId('in') },
                  { node: asNodeId('cImage'), port: asPortId('in') },
                ],
              },
            },
          }
          : {
              links: {
                intoVariable: { id: asLinkId('intoVariable'), from: { node: asNodeId('img'), port: asPortId('out') }, to: { node: asNodeId('sw'), port: asPortId('in') } },
                outOfVariable: { id: asLinkId('outOfVariable'), from: { node: asNodeId('sw'), port: asPortId('out') }, to: { node: asNodeId('c1'), port: asPortId('in') } },
              },
              nets: {},
            }
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
            img: { id: asNodeId('img'), type: 'PIMG', values: {} },
            lat: { id: asNodeId('lat'), type: 'PLAT', values: {} },
            c1: { id: asNodeId('c1'), type: 'SinkLatent', values: {} },
            c2: { id: asNodeId('c2'), type: 'SinkLatent', values: {} },
            cImage: { id: asNodeId('cImage'), type: 'SinkImage', values: {} },
            sw: { id: asNodeId('sw'), type: 'VariableSwitch', values: {} },
          },
          ...conn,
          reroutes: {},
          nextOrdinal: 100,
        },
      },
      view: { graphs: { g0: { nodes: {}, ...(kind === 'net' ? { collapsedNets: ['n'] } : {}) } } },
    }
    return buildScene({
      document: doc,
      graphId: 'g0',
      resolve: (t) => synthetic.get(t),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
  }

  it('an incompatible link is marked mismatch; a compatible one is not', () => {
    const scene = verdictScene('link')
    const bad = scene.links.find((l) => l.id === 'bad')!
    expect(bad.mismatch).toBe(true)
    expect(bad.diagnostics).toEqual([
      expect.objectContaining({ code: 'solve.linkMismatch', message: expect.stringContaining("output type 'IMAGE'") }),
    ])
    const good = scene.links.find((l) => l.id === 'good')!
    expect(good.mismatch).toBeUndefined()
    expect(good.diagnostics).toBeUndefined()
    // The same conflict also rides the generic diagnostics channel.
    expect(scene.diagnostics.some((d) => d.severity === 'warning' || d.severity === 'error')).toBe(true)
  })

  it('a net fan-out attributes diagnostics only to the mismatched sink', () => {
    const scene = verdictScene('net')
    const [bad, good] = scene.links.filter((l) => l.netId === 'n')
    expect(bad).toMatchObject({
      mismatch: true,
      diagnostics: [expect.objectContaining({ code: 'solve.linkMismatch' })],
    })
    expect(good!.mismatch).toBeUndefined()
    expect(good!.diagnostics).toBeUndefined()
    expect(scene.netStubs.find((stub) => stub.role === 'source')!.mismatch).toBe(true)
    expect(scene.netStubs.find((stub) => stub.nodeId === 'c1')!.mismatch).toBe(true)
    expect(scene.netStubs.find((stub) => stub.nodeId === 'cImage')!.mismatch).toBeUndefined()
  })

  it('a variable conflict is retained on every contributing mismatch noodle', () => {
    const links = verdictScene('variable').links
    expect(links).toHaveLength(2)
    for (const link of links) {
      expect(link.mismatch).toBe(true)
      expect(link.diagnostics).toEqual([
        expect.objectContaining({ code: 'solve.varConflict', message: expect.stringContaining('has no type satisfying') }),
      ])
    }
  })
})

describe('groups', () => {
  it('view groups pass through to the scene', () => {
    const scene = sceneOf('subgraph')
    expect(scene.groups).toHaveLength(1)
    expect(scene.groups[0]).toMatchObject({
      id: 'grp0',
      title: 'Main flow',
      x: 40,
      y: 140,
      width: 760,
      height: 300,
    })
  })

  it('graphs without groups produce an empty list', () => {
    const scene = sceneOf('exec-basic')
    expect(scene.groups).toEqual([])
  })

  it('nodesInGroup: membership is spatial (node center inside bounds)', () => {
    const scene = sceneOf('subgraph')
    const group = scene.groups[0]!
    // All three g0 nodes (positions 60/380/720 x ~200) center inside the
    // 40..800 x 140..440 rect.
    expect(nodesInGroup(scene, group).sort()).toEqual(['n0', 'n1', 'n2'])
    // Shrink the rect so only n0's center fits: membership follows.
    const narrow = { ...group, x: 40, width: 200 }
    expect(nodesInGroup(scene, narrow)).toEqual(['n0'])
    // A rect over empty space carries nothing.
    expect(nodesInGroup(scene, { ...group, x: -5_000, y: -5_000, width: 10, height: 10 })).toEqual([])
  })

  it('reroutes use spatial group membership too', () => {
    const scene = sceneOf('subgraph')
    const group = scene.groups[0]!
    const reroute = scene.reroutes[0]
    if (reroute) {
      expect(reroutesInGroup(scene, { ...group, x: reroute.x - 1, y: reroute.y - 1, width: 2, height: 2 }))
        .toEqual([reroute.id])
    }

  })

  it('value sources and selectors use center membership with inclusive edges', () => {
    const base = sceneOf('exec-basic')
    const group = { id: 'g', title: 'g', x: 10, y: 20, width: 100, height: 80 }
    // Centers are inside, one unit past the right edge, and exactly on it.
    const positioned = (id: string, centerX: number) => ({ id, x: centerX - 5, y: 55, width: 10, height: 10 })
    const scene = {
      ...base,
      valueSources: [positioned('vs-inside', 50), positioned('vs-outside', 111), positioned('vs-edge', 110)],
      selectors: [positioned('sel-inside', 50), positioned('sel-outside', 111), positioned('sel-edge', 110)],
    } as unknown as Scene

    expect(valueSourcesInGroup(scene, group)).toEqual(['vs-inside', 'vs-edge'])
    expect(selectorsInGroup(scene, group)).toEqual(['sel-inside', 'sel-edge'])
  })
})

describe('boundary pseudo-nodes', () => {
  /** exec-subgraph fixture, optionally with saved boundary view positions. */
  function g1SceneWith(boundary?: {
    inputs?: { position: { x: number; y: number } }
    outputs?: { position: { x: number; y: number } }
  }) {
    const doc = loadDocument(readJson('fixtures/workflows/exec-subgraph.json')).document as WorkflowDocument
    const patched: WorkflowDocument = boundary
      ? {
          ...doc,
          view: {
            ...doc.view,
            graphs: { ...doc.view.graphs, g1: { ...doc.view.graphs['g1']!, boundary } },
          },
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

  it('shows and anchors the immediate region index only in a drilled region occurrence', () => {
    const original = loadDocument(readJson('fixtures/workflows/exec-subgraph.json')).document as WorkflowDocument
    const document = structuredClone(original)
    ;(document.graphs.g0!.nodes as Record<string, unknown>).n0 = {
      ...document.graphs.g0!.nodes.n0!,
      region: { kind: 'map', elementPorts: ['color'] },
    }
    ;(document as any).occurrenceTopologies = {
      n0: {
        owner: { instancePath: [], node: 'n0' }, bodyGraph: 'g1', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: { kind: 'body', endpoint: { node: '$region', port: 'index' } },
            to: { kind: 'body', endpoint: { node: 'n0', port: 'width' } },
          },
        },
      },
    }
    const drilled = buildScene({
      document,
      graphId: 'g1',
      resolve: documentResolver(document, (type) => schemas.get(type)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      occurrence: { owner: { instancePath: [], node: asNodeId('n0') }, plannerAvailable: true },
    })
    const index = drilled.boundaryNodes.find((node) => node.side === 'inputs')!.layout.pins.find((pin) => pin.regionIndex)
    expect(index).toMatchObject({
      portId: '@region:index', direction: 'out',
      type: { kind: 'concrete', name: 'core.int' },
    })
    expect(drilled.boundaryNodes.find((node) => node.side === 'inputs')!.layout.rows).toContainEqual(expect.objectContaining({
      output: expect.objectContaining({ portId: '@region:index', label: 'Index', regionIndex: true }),
    }))
    expect(drilled.links).toContainEqual(expect.objectContaining({
      from: { kind: 'boundary', side: 'inputs', item: '@region:index' },
      to: { kind: 'port', node: 'n0', port: 'width' },
      effectiveIdentity: { kind: 'occurrence', owner: { instancePath: [], node: 'n0' }, linkId: 'l0' },
    }))

    const ordinary = buildScene({
      document: original,
      graphId: 'g1',
      resolve: documentResolver(original, (type) => schemas.get(type)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
      occurrence: { owner: { instancePath: [], node: asNodeId('n0') }, plannerAvailable: true },
    })
    expect(ordinary.boundaryNodes.flatMap((node) => node.layout.pins).some((pin) => pin.regionIndex)).toBe(false)
    expect(sceneOf('exec-subgraph').boundaryNodes).toEqual([])
  })

  it('participate in spatial group membership by center', () => {
    const scene = g1SceneWith({ inputs: { position: { x: 100, y: 100 } } })
    const inputs = scene.boundaryNodes.find((node) => node.side === 'inputs')!
    const group = {
      id: 'group', title: 'Boundary', x: inputs.x - 10, y: inputs.y - 10,
      width: inputs.layout.width + 20, height: inputs.layout.height + 20,
    }
    expect(boundaryNodesInGroup(scene, group)).toContain('inputs')
  })

  it('graphs without a boundary derive no pseudo-nodes', () => {
    expect(sceneOf('exec-basic').boundaryNodes).toEqual([])
    expect(sceneOf('exec-subgraph').boundaryNodes).toEqual([]) // root, not the definition
  })

  it('a definition derives Inputs (pins face out) and Outputs (pins face in)', () => {
    const scene = g1SceneWith()
    expect(scene.boundaryNodes.map((b) => b.side).sort()).toEqual(['inputs', 'outputs'])
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    const outputs = scene.boundaryNodes.find((b) => b.side === 'outputs')!
    expect(inputs.layout.title).toBe('Inputs')
    expect(outputs.layout.title).toBe('Outputs')
    // The Inputs panel FEEDS the graph, so its pin is an output; symmetric
    // for the Outputs panel. Pin portId is the boundary item id; each panel
    // ends with the blank "expose..." slot.
    expect(inputs.layout.pins).toHaveLength(2)
    expect(inputs.layout.pins[0]).toMatchObject({ portId: 'color', direction: 'out' })
    expect(inputs.layout.pins[1]).toMatchObject({ portId: '__add__', direction: 'out', ghost: true })
    expect(outputs.layout.pins).toHaveLength(2)
    expect(outputs.layout.pins[0]).toMatchObject({ portId: 'image', direction: 'in' })
    expect(outputs.layout.pins[1]).toMatchObject({ portId: '__add__', direction: 'in', ghost: true })
  })

  it('pin types mirror the derived instance schema (inside == outside)', () => {
    const scene = g1SceneWith()
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    const outputs = scene.boundaryNodes.find((b) => b.side === 'outputs')!
    // #g1's derived schema: promoted INT widget input 'color', IMAGE output.
    expect(inputs.layout.pins[0]!.type).toEqual({ kind: 'concrete', name: 'INT' })
    expect(outputs.layout.pins[0]!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
  })

  it('binding noodles are synthetic, boundary-flagged, and pin-anchored on both ends', () => {
    const scene = g1SceneWith()
    const bLinks = scene.links.filter((l) => l.boundary)
    expect(bLinks.map((l) => l.id).sort()).toEqual(['boundary:inputs:color', 'boundary:outputs:image'])

    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    const inLink = bLinks.find((l) => l.id === 'boundary:inputs:color')!
    expect(inLink.from).toEqual({ kind: 'boundary', side: 'inputs', item: 'color' })
    expect(inLink.to).toMatchObject({ kind: 'port', node: 'n0', port: 'color' })
    // From: the Inputs panel's right edge at its pin row.
    expect(inLink.x1).toBe(inputs.x + inputs.layout.width)
    expect(inLink.y1).toBe(inputs.y + inputs.layout.pins[0]!.y)
    // To: the inner node's left edge at the bound (widget-backed) pin - the
    // binding itself keeps that pin alive.
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    const innerIn = n0.layout.pins.find((p) => p.direction === 'in' && p.portId === 'color')!
    expect(inLink.x2).toBe(n0.x)
    expect(inLink.y2).toBe(n0.y + innerIn.y)

    const outputs = scene.boundaryNodes.find((b) => b.side === 'outputs')!
    const outLink = bLinks.find((l) => l.id === 'boundary:outputs:image')!
    expect(outLink.from).toMatchObject({ kind: 'port', node: 'n0', port: 'out0' })
    expect(outLink.to).toEqual({ kind: 'boundary', side: 'outputs', item: 'image' })
    const innerOut = n0.layout.pins.find((p) => p.direction === 'out' && p.portId === 'out0')!
    expect(outLink.x1).toBe(n0.x + n0.layout.width)
    expect(outLink.y1).toBe(n0.y + innerOut.y)
    expect(outLink.x2).toBe(outputs.x)
    expect(outLink.y2).toBe(outputs.y + outputs.layout.pins[0]!.y)
    expect(outLink.typeName).toBe('IMAGE')
  })

  it('projects an output widget-tap binding from the exact widget pin', () => {
    const doc = loadDocument(readJson('fixtures/workflows/exec-subgraph.json')).document as WorkflowDocument
    const g1 = doc.graphs['g1']!
    const patched = {
      ...doc,
      graphs: {
        ...doc.graphs,
        g1: {
          ...g1,
          boundary: {
            ...g1.boundary!,
            outputs: [{ id: 'color', binds: { kind: 'widgetTap', node: 'n0', tap: 'color' } }],
          },
        },
      },
    } as unknown as WorkflowDocument
    const scene = buildScene({
      document: patched,
      graphId: 'g1',
      resolve: documentResolver(patched, (t) => schemas.get(t)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const n0 = scene.nodes.find((node) => node.id === 'n0')!
    const tap = n0.layout.pins.find((pin) =>
      pin.direction === 'out' && pin.portId === 'color' && pin.widgetTap === true,
    )!
    const link = scene.links.find((candidate) => candidate.id === 'boundary:outputs:color')!

    expect(link.from).toEqual({ kind: 'widgetTap', node: 'n0', input: 'color' })
    expect(link.to).toEqual({ kind: 'boundary', side: 'outputs', item: 'color' })
    expect(link.typeName).toBe('INT')
    expect(link.boundaryFamily).toBeUndefined()
    expect(link.x1).toBe(n0.x + n0.layout.width)
    expect(link.y1).toBe(n0.y + tap.y)
  })

  it('default positions flank the content; Inputs left, Outputs right', () => {
    const scene = g1SceneWith()
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    const outputs = scene.boundaryNodes.find((b) => b.side === 'outputs')!
    expect(inputs.x + inputs.layout.width).toBeLessThan(n0.x)
    expect(outputs.x).toBeGreaterThan(n0.x + n0.layout.width)
    expect(inputs.y).toBe(n0.y)
    expect(outputs.y).toBe(n0.y)
  })

  it('fan-out (alsoBinds) renders one noodle per binding from the same boundary pin', () => {
    const doc = loadDocument(readJson('fixtures/workflows/exec-subgraph.json')).document as WorkflowDocument
    const g1 = doc.graphs['g1']!
    const item = g1.boundary!.inputs[0]! // 'color' -> n0/color
    const patched: WorkflowDocument = {
      ...doc,
      graphs: {
        ...doc.graphs,
        g1: {
          ...g1,
          boundary: {
            ...g1.boundary!,
            inputs: [{ ...item, alsoBinds: [{ kind: 'port', node: 'n0', port: 'width' } as (typeof item)['binds']] }],
          },
        },
      },
    } as WorkflowDocument
    const scene = buildScene({
      document: patched,
      graphId: 'g1',
      resolve: documentResolver(patched, (t) => schemas.get(t)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const bLinks = scene.links.filter((l) => l.boundary && l.id.startsWith('boundary:inputs:color'))
    expect(bLinks.map((l) => l.id).sort()).toEqual(['boundary:inputs:color', 'boundary:inputs:color:1'])
    // Both noodles leave the SAME boundary pin...
    expect(bLinks[1]!.x1).toBe(bLinks[0]!.x1)
    expect(bLinks[1]!.y1).toBe(bLinks[0]!.y1)
    // ...and land on distinct inner pins, both kept alive by the binding.
    expect(bLinks.map((l) => l.to)).toEqual([
      { kind: 'port', node: 'n0', port: 'color' },
      { kind: 'port', node: 'n0', port: 'width' },
    ])
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    for (const port of ['color', 'width']) {
      expect(n0.layout.pins.some((p) => p.direction === 'in' && p.portId === port)).toBe(true)
    }
    expect(bLinks[0]!.y2).not.toBe(bLinks[1]!.y2)
  })

  it('saved view positions win over defaults, per side', () => {
    const scene = g1SceneWith({ inputs: { position: { x: -321, y: 77 } } })
    const inputs = scene.boundaryNodes.find((b) => b.side === 'inputs')!
    const outputs = scene.boundaryNodes.find((b) => b.side === 'outputs')!
    expect({ x: inputs.x, y: inputs.y }).toEqual({ x: -321, y: 77 })
    // The unsaved side still gets its default placement.
    const n0 = scene.nodes.find((n) => n.id === 'n0')!
    expect(outputs.x).toBeGreaterThan(n0.x + n0.layout.width)
    // Binding noodles follow the saved position.
    const inLink = scene.links.find((l) => l.id === 'boundary:inputs:color')!
    expect(inLink.x1).toBe(-321 + inputs.layout.width)
    expect(inLink.y1).toBe(77 + inputs.layout.pins[0]!.y)
  })
})

describe('selector scene items', () => {
  // selector fixture: s6 fixed (two IMAGE branches, one via reroute, output
  // fanning out to two consumers) + s9 random (mixed IMAGE/LATENT branches).
  const scene = sceneOf('selector')
  const s6 = scene.selectors.find((s) => s.id === 's6')!
  const s9 = scene.selectors.find((s) => s.id === 's9')!

  it('selectors are scene items separate from nodes, at their view positions', () => {
    expect(scene.selectors).toHaveLength(2)
    expect(scene.nodes.some((n) => n.id === 's6' || n.id === 's9')).toBe(false)
    expect({ x: s6.x, y: s6.y }).toEqual({ x: 440, y: 140 })
    expect({ x: s9.x, y: s9.y }).toEqual({ x: 440, y: 560 })
    expect(s6.width).toBeGreaterThanOrEqual(SELECTOR_MIN_WIDTH)
  })

  it('title, candidate labels, and policy flags come from the document', () => {
    expect(s6.title).toBe('Quality')
    expect(s6.candidates.map((c) => c.label)).toEqual(['full', '2']) // title else 1-based ordinal
    expect(s6.activeCandidate).toBe('c7')
    expect(s6.random).toBe(false)
    expect(s9.title).toBe('Select')
    expect(s9.activeCandidate).toBeUndefined()
    expect(s9.random).toBe(true)
  })

  it('homogeneous driven branches give the output the single agreed type', () => {
    expect(s6.candidates.map((c) => c.typeName)).toEqual(['IMAGE', 'IMAGE'])
    expect(s6.typeName).toBe('IMAGE')
  })

  it('mixed branch types keep their own colors but leave the output unresolved', () => {
    expect(s9.candidates.map((c) => c.typeName)).toEqual(['IMAGE', 'LATENT'])
    expect(s9.typeName).toBeUndefined()
  })

  it('interchangeable comfy-compat spellings count as one agreed branch type', () => {
    // dinkster.image and comfy.IMAGE denote the same backend value type, so a
    // selector fed by both must resolve to the canonical spelling instead of
    // degrading to a wildcard output.
    const extra: Record<string, NodeSchema> = {
      DinksterImageSrc: {
        type: 'DinksterImageSrc', displayName: 'DinksterImageSrc', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'dinkster.image' } }],
      },
      ComfyImageSrc: {
        type: 'ComfyImageSrc', displayName: 'ComfyImageSrc', category: 'test', source: 'v3', isOutputNode: false,
        items: [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'comfy.IMAGE' } }],
      },
    }
    const doc = loadDocument({
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage-compat-sel', root: 'g0',
      graphs: {
        g0: {
          id: 'g0', name: 'root',
          nodes: { n0: { id: 'n0', type: 'DinksterImageSrc', values: {} }, n1: { id: 'n1', type: 'ComfyImageSrc', values: {} } },
          links: {
            l2: { id: 'l2', from: { node: 'n0', port: 'out' }, to: { selector: 's4', candidate: 'c5' } },
            l3: { id: 'l3', from: { node: 'n1', port: 'out' }, to: { selector: 's4', candidate: 'c6' } },
          },
          nets: {},
          reroutes: {},
          selectors: { s4: { id: 's4', candidates: [{ id: 'c5' }, { id: 'c6' }], policy: { kind: 'random' } } },
          nextOrdinal: 7,
        },
      },
      view: {
        graphs: {
          g0: {
            nodes: { n0: { position: { x: 0, y: 0 } }, n1: { position: { x: 0, y: 200 } } },
            selectors: { s4: { position: { x: 400, y: 100 } } },
          },
        },
      },
    }).document as WorkflowDocument
    const mixed = buildScene({
      document: doc,
      graphId: 'g0',
      resolve: documentResolver(doc, (t) => extra[t] ?? schemas.get(t)),
      tokens: defaultTokens,
      measure,
      widgetMeasure,
    })
    const sel = mixed.selectors.find((s) => s.id === 's4')!
    expect(sel.candidates.map((c) => c.typeName)).toEqual(['comfy.IMAGE', 'comfy.IMAGE'])
    expect(sel.typeName).toBe('comfy.IMAGE')
  })

  it('every candidate noodle stays visible and anchors at the candidate pin', () => {
    const direct = scene.links.find((l) => l.id === 'l12')!
    expect(direct.to).toEqual({ kind: 'selector', selector: 's6', candidate: 'c7' })
    const pin7 = selectorCandidatePinPosition(s6, 'c7')!
    expect({ x: direct.x2, y: direct.y2 }).toEqual(pin7)

    // The second branch arrives via a reroute; both hops render.
    const intoReroute = scene.links.find((l) => l.id === 'l13')!
    expect(intoReroute.to).toEqual({ kind: 'reroute', reroute: 'r5' })
    const fromReroute = scene.links.find((l) => l.id === 'l14')!
    expect(fromReroute.from).toEqual({ kind: 'reroute', reroute: 'r5' })
    const pin8 = selectorCandidatePinPosition(s6, 'c8')!
    expect({ x: fromReroute.x2, y: fromReroute.y2 }).toEqual(pin8)

    // Candidate pins sit on the left edge, one per row, below the header.
    expect(pin7.x).toBe(s6.x)
    expect(pin8.x).toBe(s6.x)
    expect(pin7.y).toBeGreaterThan(s6.y + s6.headerHeight)
    expect(pin8.y).toBeGreaterThan(pin7.y)
  })

  it('the single output pin anchors fan-out links in the header band', () => {
    const out = selectorOutPinPosition(s6)
    expect(out.x).toBe(s6.x + s6.width)
    expect(out.y).toBe(s6.y + s6.headerHeight / 2)
    const fanOut = scene.links.filter((l) => l.id === 'l15' || l.id === 'l16')
    expect(fanOut).toHaveLength(2)
    for (const link of fanOut) {
      expect(link.from).toEqual({ kind: 'selector', selector: 's6' })
      expect({ x: link.x1, y: link.y1 }).toEqual(out)
      expect(link.typeName).toBe('IMAGE') // traced through the selector
    }
    expect(fanOut.map((l) => (l.to as { node: string }).node).sort()).toEqual(['n2', 'n3'])
  })

  it('the policy badge sits inside the header band at the right edge', () => {
    const badge = selectorBadgeRect(s6)
    expect(badge.x + badge.width).toBeLessThanOrEqual(s6.x + s6.width)
    expect(badge.y).toBeGreaterThanOrEqual(s6.y)
    expect(badge.y + badge.height).toBeLessThanOrEqual(s6.y + s6.headerHeight)
  })
})

describe('scenesEqual', () => {
  it('two independent builds of the same document compare equal', () => {
    expect(scenesEqual(sceneOf('exec-basic'), sceneOf('exec-basic'))).toBe(true)
    expect(scenesEqual(sceneOf('exec-subgraph'), sceneOf('exec-subgraph'))).toBe(true)
  })

  it('different graphs of the same document compare unequal', () => {
    expect(scenesEqual(sceneOf('exec-subgraph'), sceneOf('exec-subgraph', 'g1'))).toBe(false)
  })

  it('a changed node position compares unequal', () => {
    const a = sceneOf('exec-basic')
    const b = JSON.parse(JSON.stringify(a)) as Scene
    expect(scenesEqual(a, b)).toBe(true)
    ;(b.nodes[0] as { x: number }).x += 1
    expect(scenesEqual(a, b)).toBe(false)
  })

  it('an added or removed link compares unequal', () => {
    const a = sceneOf('exec-basic')
    const b = JSON.parse(JSON.stringify(a)) as Scene
    ;(b as unknown as { links: unknown[] }).links = b.links.slice(1)
    expect(scenesEqual(a, b)).toBe(false)
  })

  it('an undefined-valued key compares as absent', () => {
    const a = sceneOf('exec-basic')
    const b = { ...JSON.parse(JSON.stringify(a)) as Scene, occurrence: undefined } as unknown as Scene
    expect(scenesEqual(a, b)).toBe(true)
  })

  it('NaN compares unequal, forcing a replacement', () => {
    const a = sceneOf('exec-basic')
    const b = JSON.parse(JSON.stringify(a)) as Scene
    ;(a.nodes[0] as { x: number }).x = Number.NaN
    ;(b.nodes[0] as { x: number }).x = Number.NaN
    expect(scenesEqual(a, b)).toBe(false)
  })

  it('distinct non-plain objects compare unequal even with equal contents', () => {
    const a = sceneOf('exec-basic')
    const b = JSON.parse(JSON.stringify(a)) as Scene
    ;(a as unknown as { extra: unknown }).extra = new Map([['k', 1]])
    ;(b as unknown as { extra: unknown }).extra = new Map([['k', 1]])
    expect(scenesEqual(a, b)).toBe(false)

    class Opaque { value = 1 }
    ;(a as unknown as { extra: unknown }).extra = new Opaque()
    ;(b as unknown as { extra: unknown }).extra = new Opaque()
    expect(scenesEqual(a, b)).toBe(false)

    // The same reference still compares equal through identity.
    const shared = new Map([['k', 1]])
    ;(a as unknown as { extra: unknown }).extra = shared
    ;(b as unknown as { extra: unknown }).extra = shared
    expect(scenesEqual(a, b)).toBe(true)
  })
})
