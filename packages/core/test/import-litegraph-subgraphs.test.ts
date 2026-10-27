import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { effectiveOccurrenceTopology } from '../src/compile/effective-topology.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { loadDocument } from '../src/format/migrate.js'
import type { Json, JsonObject, WorkflowDocument } from '../src/format/document.js'
import { asConnectionId } from '../src/ids.js'
import type { NodeSchema } from '../src/schema/model.js'

const schema: NodeSchema = {
  type: 'Relay', displayName: 'Relay', category: 'test', source: 'v3', isOutputNode: true,
  items: [
    { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
      widget: { widgetType: 'INT', options: {}, default: 5 } },
    { kind: 'output', id: 'result', type: { kind: 'concrete', name: 'INT' } },
  ],
}
const resolve = (type: string) => type === 'Relay' ? schema : undefined
const link = (id: number, from: number, fromSlot: number, to: number, toSlot: number) =>
  ({ id, origin_id: from, origin_slot: fromSlot, target_id: to, target_slot: toSlot, type: 'INT' })
const relay = (id = 1) => ({ id, type: 'Relay', inputs: [{ name: 'value', widget: { name: 'value' }, link: 1 }],
  outputs: [{ name: 'result' }], widgets_values: [7] as Json[] })
const definition = (id = 'inner') => ({
  id, name: id, version: 1, nodes: [relay()],
  inputs: [{ id: 'in', name: 'value', type: 'INT', linkIds: [1] }],
  outputs: [{ id: 'out', name: 'result', type: 'INT', linkIds: [2] }],
  links: [link(1, -10, 0, 1, 0), link(2, 1, 0, -20, 0)],
})
const instance = (id: number, type = 'inner', value = 19) => ({ id, type,
  inputs: [{ name: 'value', widget: { name: 'value' } }], outputs: [{ name: 'result' }], widgets_values: [value] })
const imported = (raw: unknown, resolver = resolve): WorkflowDocument => {
  const result = importLitegraph(raw as JsonObject, resolver)
  expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
  expect(result.document).toBeDefined()
  expect(loadDocument(result.document).document).toEqual(result.document)
  return result.document!
}
const prompt = (document: WorkflowDocument, resolver = resolve) => {
  const result = compile({ document, revision: 1, resolve: resolver, scope: { kind: 'full' },
    connection: asConnectionId('test'), schemaHash: 'test' })
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error('compile failed')
  return result.artifact.prompt
}

describe('LiteGraph subgraphs', () => {
  it.each([false, true])('maps a scalar sink after a generated map crosses a subgraph boundary (unresolved input: %s)', (unresolved) => {
    const source: NodeSchema = {
      type: 'ListSource', displayName: 'Source', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'values', type: { kind: 'list', element: { kind: 'concrete', name: 'INT' } } }],
    }
    const sink: NodeSchema = {
      type: 'SaveValue', displayName: 'Save', category: 'test', source: 'v3', isOutputNode: true,
      items: [
        { kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false },
        { kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
          dynamic: { kind: 'dynamicCombo', options: [{ key: 'auto', inputs: [] }], defaultOption: 'auto' } },
        { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'INT' } },
      ],
    }
    const resolver = (type: string) => type === 'ListSource' ? source : type === 'SaveValue' ? sink : resolve(type)
    const doc = imported({
      nodes: [
        { id: 10, type: 'inner', outputs: [{ name: 'result', links: [1] }] },
        { id: 20, type: 'SaveValue', inputs: [{ name: 'value', link: 1 }], outputs: [{ name: 'value' }], widgets_values: ['auto'] },
      ],
      links: [link(1, 10, 0, 20, 0)],
      definitions: { subgraphs: [{
        id: 'inner', name: 'inner', version: 1,
        inputs: unresolved ? [{ id: 'unresolved', name: 'missing', type: 'INT', linkIds: [3] }] : [],
        outputs: [{ id: 'out', name: 'result', type: 'INT', linkIds: [2] }],
        nodes: [
          { id: 1, type: 'ListSource', outputs: [{ name: 'values', links: [1] }] },
          { ...relay(2), outputs: [{ name: 'result', links: [2] }] },
          ...(unresolved ? [{ id: 3, type: 'UnknownInput', inputs: [{ name: 'missing', link: 3 }] }] : []),
        ],
        links: [link(1, 1, 0, 2, 0), link(2, 2, 0, -20, 0), ...(unresolved ? [link(3, -10, 0, 3, 0)] : [])],
      }] },
    }, resolver)
    expect(doc.graphs.g0!.nodes.n20!.region).toMatchObject({ kind: 'map', elementPorts: ['value'] })
    expect(doc.graphs['list-map-n20']!.boundary!.outputs[0]!.id).toBe('output.value')
    if (unresolved) return
    const result = compile({ document: doc, revision: 1, resolve: resolver, scope: { kind: 'full' },
      connection: asConnectionId('test'), schemaHash: 'list-boundary', graphFeatures: ['regions', 'typedLiteral'] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.dinksterGraph!.nodes.n20).toHaveProperty('region')
  })

  it('maps UUID ports, widget values, output indices and fan-out through a reusable definition', () => {
    const def = definition()
    def.nodes.push(relay(2))
    def.links.push(link(3, -10, 0, 2, 0))
    def.inputs[0]!.linkIds.push(3)
    const raw = { nodes: [instance(1), instance(2, 'inner', 31)], links: [], definitions: { subgraphs: [def] } }
    const doc = imported(raw)
    expect(doc.graphs['inner']!.boundary).toEqual({ inputs: [{ id: 'in', displayName: 'value', promoted: true,
      binds: { kind: 'port', node: 'n1', port: 'value' }, alsoBinds: [{ kind: 'port', node: 'n2', port: 'value' }] }],
    outputs: [{ id: 'out', displayName: 'result', binds: { kind: 'port', node: 'n1', port: 'result' } }] })
    expect(doc.graphs.g0!.nodes.n1!.type).toBe('#inner')
    expect(doc.graphs.g0!.nodes.n1!.values).toEqual({ in: 19 })
    expect(doc.graphs.g0!.nodes.n2!.values).toEqual({ in: 31 })
    expect(doc.graphs['inner']!.nodes.n1!.values).toEqual({ value: 7 })
    expect(Object.values(prompt(doc)).map((node) => node.inputs['value']).sort()).toEqual([19, 19, 31, 31])
    expect(imported(raw)).toEqual(doc)
  })

  it('retains recursive definition catalogs and nested instances', () => {
    const outer = { ...definition('outer'), nodes: [instance(1)], definitions: { subgraphs: [definition()] } }
    const doc = imported({ nodes: [instance(1, 'outer')], links: [], definitions: { subgraphs: [outer] } })
    expect(Object.keys(doc.graphs).sort()).toEqual(['g0', 'inner', 'outer'])
    expect(doc.graphs['outer']!.nodes.n1!.type).toBe('#inner')
    expect(doc.graphs.g0!.nodes.n1!.type).toBe('#outer')
    expect(prompt(doc)['n1.n1.n1']!.inputs['value']).toBe(19)
  })

  it('retains nested definitions when boundary node schemas are unavailable', () => {
    const outer = { ...definition('outer'), nodes: [instance(1)], definitions: { subgraphs: [definition()] } }
    const result = importLitegraph(
      { nodes: [instance(1, 'outer')], links: [], definitions: { subgraphs: [outer] } } as JsonObject,
      () => undefined,
    )
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(result.diagnostics.map((item) => item.code)).toContain('import.schema.missing')
    expect(result.diagnostics.filter((item) => item.code === 'import.subgraphs.boundaryUnresolved')).toHaveLength(1)
    expect(Object.keys(result.document!.graphs).sort()).toEqual(['g0', 'inner', 'outer'])
    expect(result.document!.graphs['outer']!.nodes.n1!.type).toBe('#inner')
    expect(result.document!.graphs.g0!.nodes.n1!.type).toBe('#outer')
  })

  it('preserves a boundary port that is incompatible with an available schema', () => {
    const incompatibleSchema: NodeSchema = {
      ...schema,
      items: [{ ...schema.items[0]!, id: 'current_value' }, schema.items[1]!],
    }
    const result = importLitegraph(
      { nodes: [instance(1)], links: [], definitions: { subgraphs: [definition()] } } as JsonObject,
      (type) => type === 'Relay' ? incompatibleSchema : undefined,
    )
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(result.diagnostics.filter((item) => item.code === 'import.subgraphs.boundaryUnresolved')).toHaveLength(1)
    expect(result.diagnostics.map((item) => item.code)).not.toContain('import.subgraphs.inlined')
    expect(Object.keys(result.document!.graphs).sort()).toEqual(['g0', 'inner'])
    expect(result.document!.graphs.g0!.nodes.n1!.type).toBe('#inner')
    expect(result.document!.graphs['inner']!.nodes.n1!.type).toBe('Relay')
  })

  it.each([false, true])('preserves nested input junction boundaries without inlining shared definitions (linked: %s)', (linked) => {
    const outer = { ...definition('outer'), nodes: [instance(1), { id: 2, type: 'Reroute',
      inputs: [{ name: '', link: 1 }], outputs: [{ name: '' }] }],
    links: [link(1, -10, 0, 2, 0), link(2, 2, 0, 1, 0), link(3, 1, 0, -20, 0)] }
    const raw = { nodes: [
      { ...instance(1, 'outer'), inputs: [{ name: 'value', widget: { name: 'value' }, link: linked ? 10 : null }] },
      { ...instance(2, 'outer', 31), inputs: [{ name: 'value', widget: { name: 'value' }, link: linked ? 20 : null }] },
      ...(linked ? [
        { ...relay(7), inputs: [{ name: 'value', widget: { name: 'value' }, link: null }], widgets_values: [37] },
        { ...relay(8), inputs: [{ name: 'value', widget: { name: 'value' }, link: null }], widgets_values: [53] },
      ] : []),
    ], links: linked ? [link(10, 7, 0, 1, 0), link(20, 8, 0, 2, 0)] : [], definitions: { subgraphs: [outer, definition()] } }
    const result = importLitegraph(raw as unknown as JsonObject, resolve)
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([])
    expect(Object.keys(result.document!.graphs).sort()).toEqual(['g0', 'inner', 'outer'])
    expect(result.document!.graphs.outer!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'in', viaReroute: 'r2' })
    expect(Object.values(result.document!.graphs.outer!.links)).toEqual([
      expect.objectContaining({ from: { reroute: 'r2' }, to: { node: 'n1', port: 'in' } }),
    ])
    expect(result.diagnostics.map((item) => item.code)).not.toContain('import.subgraphs.inlined')
    expect(result.document!.graphs.g0!.nodes.n1!.values).toEqual({ in: 19 })
    expect(result.document!.graphs.g0!.nodes.n2!.values).toEqual({ in: 31 })
    const compiled = prompt(result.document!)
    expect(compiled['n1.n1.n1']!.inputs.value).toEqual(linked ? ['n7', 0] : 19)
    expect(compiled['n2.n1.n1']!.inputs.value).toEqual(linked ? ['n8', 0] : 31)
  })

  it('resolves output reroute chains while preserving unrelated internal links', () => {
    const def = { ...definition(), nodes: [relay(), relay(2),
      { id: 3, type: 'Reroute', pos: [100, 200], inputs: [{ name: '', link: 3 }], outputs: [{ name: '' }] },
      { id: 4, type: 'Reroute', pos: [300, 400], inputs: [{ name: '', link: 4 }], outputs: [{ name: '' }] },
    ], links: [link(1, -10, 0, 1, 0), link(2, 1, 0, 2, 0),
      link(3, 2, 0, 3, 0), link(4, 3, 0, 4, 0), link(5, 4, 0, -20, 0)] }
    const sink = { ...relay(9), inputs: [{ name: 'value', link: 10 }] }
    const doc = imported({ nodes: [instance(1), sink], links: [link(10, 1, 0, 9, 0)],
      definitions: { subgraphs: [def] } })
    expect(doc.graphs.inner!.boundary!.outputs[0]!.binds).toEqual({ kind: 'port', node: 'n2', port: 'result' })
    expect(Object.values(doc.graphs.inner!.links).map(({ from, to }) => ({ from, to }))).toEqual([
      { from: { node: 'n1', port: 'result' }, to: { node: 'n2', port: 'value' } },
      { from: { node: 'n2', port: 'result' }, to: { reroute: 'r3' } },
      { from: { reroute: 'r3' }, to: { reroute: 'r4' } },
    ])
    expect(doc.view.graphs.inner!.reroutes).toEqual({
      r3: { position: { x: 100, y: 200 } }, r4: { position: { x: 300, y: 400 } },
    })
    const compiled = prompt(doc)
    expect(compiled['n1.n1']!.inputs.value).toBe(19)
    expect(compiled['n1.n2']!.inputs.value).toEqual(['n1.n1', 0])
    expect(compiled.n9!.inputs.value).toEqual(['n1.n2', 0])
  })

  it.each([false, true])('preserves input boundary reroute fanout and occurrence-specific upstream drivers (linked: %s)', (linked) => {
    const def = { ...definition(), nodes: [
      { ...relay(), inputs: [{ name: 'value', widget: { name: 'value' }, link: 3 }] },
      { ...relay(2), inputs: [{ name: 'value', widget: { name: 'value' }, link: 4 }] },
      { id: 3, type: 'Reroute', pos: [110, 210], inputs: [{ name: '', link: 1 }], outputs: [{ name: '' }] },
      { id: 4, type: 'Reroute', pos: [310, 410], inputs: [{ name: '', link: 2 }], outputs: [{ name: '' }] },
    ], links: [link(1, -10, 0, 3, 0), link(2, 3, 0, 4, 0),
      link(3, 4, 0, 1, 0), link(4, 3, 0, 2, 0), link(5, 2, 0, -20, 0)] }
    const sourceA = { ...relay(7), inputs: [{ name: 'value', widget: { name: 'value' }, link: null }], widgets_values: [37] }
    const sourceB = { ...relay(8), inputs: [{ name: 'value', widget: { name: 'value' }, link: null }], widgets_values: [53] }
    const doc = imported({ nodes: [sourceA, sourceB,
      { ...instance(10), inputs: [{ name: 'value', link: linked ? 10 : null }] },
      { ...instance(20, 'inner', 31), inputs: [{ name: 'value', link: linked ? 20 : null }] },
    ], links: linked ? [link(10, 7, 0, 10, 0), link(20, 8, 0, 20, 0)] : [], definitions: { subgraphs: [def] } })
    expect(Object.keys(doc.graphs.inner!.nodes)).toEqual(['n1', 'n2'])
    expect(Object.keys(doc.graphs.inner!.reroutes)).toEqual(['r3', 'r4'])
    expect(Object.values(doc.graphs.inner!.links).map(({ from, to }) => ({ from, to }))).toEqual([
      { from: { reroute: 'r3' }, to: { reroute: 'r4' } },
      { from: { reroute: 'r4' }, to: { node: 'n1', port: 'value' } },
      { from: { reroute: 'r3' }, to: { node: 'n2', port: 'value' } },
    ])
    expect(doc.view.graphs.inner!.reroutes).toEqual({
      r3: { position: { x: 110, y: 210 } }, r4: { position: { x: 310, y: 410 } },
    })
    expect(Object.values(doc.graphs.g0!.links).map(({ from, to }) => ({ from, to }))).toEqual(linked ? [
      { from: { node: 'n7', port: 'result' }, to: { node: 'n10', port: 'in' } },
      { from: { node: 'n8', port: 'result' }, to: { node: 'n20', port: 'in' } },
    ] : [])
    const before = JSON.stringify(doc)
    const compiled = prompt(doc)
    expect(compiled.n7!.inputs.value).toBe(37)
    expect(compiled.n8!.inputs.value).toBe(53)
    for (const innerNode of ['n1', 'n2']) {
      expect(compiled[`n10.${innerNode}`]!.inputs.value).toEqual(linked ? ['n7', 0] : 19)
      expect(compiled[`n20.${innerNode}`]!.inputs.value).toEqual(linked ? ['n8', 0] : 31)
    }
    expect(Object.keys(compiled).sort()).toEqual(['n10.n1', 'n10.n2', 'n20.n1', 'n20.n2', 'n7', 'n8'])
    expect(JSON.stringify(doc)).toBe(before)
    const reopened = loadDocument(JSON.parse(before)).document!
    expect(reopened).toEqual(doc)
    expect(prompt(reopened)).toEqual(compiled)
    if (linked) {
      const owner = { instancePath: [], node: doc.graphs.g0!.nodes.n10!.id }
      const topology = effectiveOccurrenceTopology(doc, resolve, owner)
      expect(topology.diagnostics).toEqual([])
      expect(topology.projectedParentLinks).toHaveLength(1)
      expect(topology.projectedParentLinks[0]!.to.endpoint).toEqual({ reroute: 'r3' })
      const identity = topology.projectedParentLinks[0]!.identity
      expect(identity.kind).toBe('parentLeg')
      if (identity.kind !== 'parentLeg') throw new Error('missing projected parent identity')
      const suppressed: WorkflowDocument = { ...doc, occurrenceTopologies: {
        n10: { owner, bodyGraph: doc.graphs.inner!.id, links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{ kind: 'projectedLeg', delivery: identity.delivery, route: identity.route }] },
      } }
      expect(loadDocument(suppressed).document).toEqual(suppressed)
      const isolated = prompt(suppressed)
      for (const innerNode of ['n1', 'n2']) {
        expect(isolated[`n10.${innerNode}`]!.inputs.value).toBe(19)
        expect(isolated[`n20.${innerNode}`]!.inputs.value).toEqual(['n8', 0])
      }
    }
  })

  it.each([false, true])('preserves mixed direct and junction input fanout in authored order (direct first: %s)', (directFirst) => {
    const def = { ...definition(), nodes: [relay(), relay(2), relay(5),
      { id: 3, type: 'Reroute', pos: [110, 210], inputs: [{ name: '', link: 1 }], outputs: [{ name: '' }] },
      { id: 4, type: 'Reroute', pos: [310, 410], inputs: [{ name: '', link: 4 }], outputs: [{ name: '' }] },
    ], links: [
      ...(directFirst ? [link(6, -10, 0, 5, 0)] : []),
      link(1, -10, 0, 3, 0), link(2, 3, 0, 1, 0),
      link(4, -10, 0, 4, 0), link(5, 4, 0, 2, 0),
      ...(!directFirst ? [link(6, -10, 0, 5, 0)] : []), link(7, 2, 0, -20, 0),
    ] }
    const doc = imported({ nodes: [
      { ...relay(7), inputs: [{ name: 'value', link: null }], widgets_values: [37] },
      { ...instance(10), inputs: [{ name: 'value', link: 10 }] }, instance(20, 'inner', 31),
    ], links: [link(10, 7, 0, 10, 0)], definitions: { subgraphs: [def] } })
    const direct = { kind: 'port', node: 'n5', port: 'value' }
    const junctions = [
      { kind: 'port', node: 'n1', port: 'value', viaReroute: 'r3' },
      { kind: 'port', node: 'n2', port: 'value', viaReroute: 'r4' },
    ]
    const item = doc.graphs.inner!.boundary!.inputs[0]!
    expect([item.binds, ...(item.alsoBinds ?? [])]).toEqual(directFirst ? [direct, ...junctions] : [...junctions, direct])
    expect(Object.keys(doc.graphs.inner!.nodes)).toEqual(['n1', 'n2', 'n5'])
    expect(Object.values(doc.graphs.inner!.links).map(({ from, to }) => ({ from, to }))).toEqual([
      { from: { reroute: 'r3' }, to: { node: 'n1', port: 'value' } },
      { from: { reroute: 'r4' }, to: { node: 'n2', port: 'value' } },
    ])
    expect(doc.view.graphs.inner!.reroutes).toEqual({ r3: { position: { x: 110, y: 210 } }, r4: { position: { x: 310, y: 410 } } })
    const before = JSON.stringify(doc)
    const compiled = prompt(doc)
    for (const node of ['n1', 'n2', 'n5']) {
      expect(compiled[`n10.${node}`]!.inputs.value).toEqual(['n7', 0])
      expect(compiled[`n20.${node}`]!.inputs.value).toBe(31)
    }
    const owner = { instancePath: [], node: doc.graphs.g0!.nodes.n10!.id }
    const topology = effectiveOccurrenceTopology(doc, resolve, owner)
    expect(topology.diagnostics).toEqual([])
    expect(topology.projectedParentLinks.map((link) => link.to.endpoint)).toEqual(directFirst
      ? [expect.objectContaining({ node: 'n5', port: 'value' }), { reroute: 'r3' }, { reroute: 'r4' }]
      : [{ reroute: 'r3' }, { reroute: 'r4' }, expect.objectContaining({ node: 'n5', port: 'value' })])
    const identity = topology.projectedParentLinks.find((link) => 'reroute' in link.to.endpoint && link.to.endpoint.reroute === 'r4')!.identity
    if (identity.kind !== 'parentLeg') throw new Error('missing projected parent identity')
    const suppressed: WorkflowDocument = { ...doc, occurrenceTopologies: {
      n10: { owner, bodyGraph: doc.graphs.inner!.id, links: {}, nextOrdinal: 0,
        suppressedDeliveries: [{ kind: 'projectedLeg', delivery: identity.delivery, route: identity.route }] },
    } }
    expect(loadDocument(suppressed).document).toEqual(suppressed)
    const isolated = prompt(suppressed)
    expect(isolated['n10.n1']!.inputs.value).toEqual(['n7', 0])
    expect(isolated['n10.n2']!.inputs.value).toBe(19)
    expect(isolated['n10.n5']!.inputs.value).toEqual(['n7', 0])
    for (const node of ['n1', 'n2', 'n5']) expect(isolated[`n20.${node}`]!.inputs.value).toBe(31)
    expect(JSON.stringify(doc)).toBe(before)
    expect(prompt(loadDocument(JSON.parse(before)).document!)).toEqual(compiled)
  })

  it('refuses an output reroute cycle without choosing a producer', () => {
    const def = { ...definition(), nodes: [relay(),
      { id: 2, type: 'Reroute', inputs: [{ name: '', link: 3 }], outputs: [{ name: '' }] },
      { id: 3, type: 'Reroute', inputs: [{ name: '', link: 2 }], outputs: [{ name: '' }] },
    ], links: [link(1, -10, 0, 1, 0), link(2, 2, 0, 3, 0), link(3, 3, 0, 2, 0), link(4, 3, 0, -20, 0)] }
    const result = importLitegraph({ nodes: [instance(1)], definitions: { subgraphs: [def] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  it.each(['inputs', 'outputs'] as const)('refuses a dangling %s reroute instead of guessing a boundary endpoint', (side) => {
    const def = { ...definition(), nodes: [relay(),
      { id: 2, type: 'Reroute', inputs: [{ name: '', link: null }], outputs: [{ name: '' }] },
    ], links: side === 'inputs'
      ? [link(1, -10, 0, 2, 0), link(2, 1, 0, -20, 0)]
      : [link(1, -10, 0, 1, 0), link(2, 2, 0, -20, 0)] }
    const result = importLitegraph({ nodes: [instance(1)], definitions: { subgraphs: [def] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error', code: 'import.subgraphs.boundaryUnsupported',
    }))
  })

  it('migrates legacy proxy widgets without interpreting missing host values as overrides', () => {
    const def = { ...definition(), inputs: [], links: [link(2, 1, 0, -20, 0)] }
    const node = { ...instance(1), inputs: [], properties: { proxyWidgets: [['1', 'value']] }, widgets_values: [] }
    const doc = imported({ nodes: [node], links: [], definitions: { subgraphs: [def] } })
    expect(doc.graphs['inner']!.boundary!.inputs[0]!.promoted).toBe(true)
    expect(doc.graphs.g0!.nodes.n1!.values).toEqual({})
    expect(doc.graphs['inner']!.nodes.n1!.values).toEqual({ value: 7 })
  })

  it('keeps modern promoted seed values separate from implicit controller entries', () => {
    const controlled: NodeSchema = { ...schema, items: [
      { ...schema.items[0]!, kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: {}, controller: 'after_generate' } }, schema.items[1]!,
    ] }
    const resolver = (type: string) => type === 'Relay' ? controlled : undefined
    const def = definition()
    def.nodes[0]!.widgets_values.push('fixed')
    const doc = imported({ nodes: [instance(1)], links: [], definitions: { subgraphs: [def] } }, resolver)
    expect(doc.graphs.g0!.nodes.n1!.values).toEqual({ in: 19 })
    expect(doc.graphs['inner']!.nodes.n1!.controllers).toEqual({ value: 'fixed' })
    expect(prompt(doc, resolver)['n1.n1']!.inputs['value']).toBe(19)
  })

  it('fails instead of selecting one of multiple virtual-output drivers', () => {
    const def = definition()
    def.nodes.push(relay(2))
    def.nodes[0]!.inputs[0]!.link = 4
    def.links.push(link(3, 2, 0, -20, 0), link(4, 2, 0, 1, 0))
    const result = importLitegraph({ nodes: [instance(1)], definitions: { subgraphs: [def] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.filter((item) => item.severity === 'error').map((item) => item.code))
      .toEqual(['import.subgraphs.boundaryUnsupported'])
  })

  it('maps input members using the existing autogrow decoder', () => {
    const family: NodeSchema = { ...schema, type: 'Family', items: [
      { kind: 'input', id: 'items', type: { kind: 'concrete', name: 'INT' }, optional: false,
        dynamic: { kind: 'autogrow', template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false }],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 5 } } }, schema.items[1]!,
    ] }
    const resolver = (type: string) => type === 'Family' ? family : resolve(type)
    const def = { ...definition(), nodes: [{ id: 1, type: 'Family',
      inputs: [{ name: 'items.item2', link: 1 }], outputs: [{ name: 'result' }] }] }
    const doc = imported({ nodes: [instance(1)], definitions: { subgraphs: [def] } }, resolver)
    expect(doc.graphs['inner']!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'items.value', members: ['m0'] })
  })

  it.each([2, 4])('reports mode %s when its structural producer cannot be preserved', (mode) => {
    const def = { ...definition(), nodes: [{ id: 1, type: 'PrimitiveNode', widgets_values: [7], outputs: [{ name: 'INT' }] }],
      inputs: [], links: [link(2, 1, 0, -20, 0)] }
    const target = { ...relay(2), inputs: [{ name: 'value', widget: { name: 'value' }, link: 1 }] }
    const result = importLitegraph({ nodes: [{ ...instance(1), inputs: [], widgets_values: [], mode }, target],
      links: [[1, 1, 0, 2, 0, 'INT']], definitions: { subgraphs: [def] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.filter((item) => item.severity === 'error').map((item) => item.code))
      .toEqual(['import.subgraphs.boundaryUnsupported'])
  })

  it('reports primitive proxy instances whose output boundary cannot be preserved', () => {
    const def = { ...definition(), inputs: [], nodes: [
      { id: 1, type: 'PrimitiveNode', outputs: [{ name: 'INT' }], widgets_values: [7, 'fixed'] },
    ], links: [link(2, 1, 0, -20, 0)] }
    const host = (id: number, value: number) => ({ ...instance(id), inputs: [], widgets_values: [value, 'randomize'],
      properties: { proxyWidgets: [['1', 'value'], ['1', 'control_after_generate']] } })
    const result = importLitegraph({ nodes: [host(1, 11), host(2, 29), relay(3), relay(4)],
      links: [[1, 1, 0, 3, 0, 'INT'], [2, 2, 0, 4, 0, 'INT']], definitions: { subgraphs: [def] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.filter((item) => item.severity === 'error').map((item) => item.code))
      .toEqual(['import.subgraphs.boundaryUnsupported'])
  })

  it.each([['value', '2'], ['1: 2: value', undefined]])('resolves nested legacy widget %s without confusing identical names', (name, sourceId) => {
    const inner = definition()
    inner.nodes.push(relay(2))
    inner.inputs.push({ id: 'in2', name: 'value_1', type: 'INT', linkIds: [3] })
    inner.links.push(link(3, -10, 1, 2, 0))
    const nested = { ...instance(1), inputs: [{ name: 'value' }, { name: 'value_1' }], widgets_values: [] }
    const outer = { ...definition('outer'), nodes: [nested], inputs: [], links: [link(2, 1, 0, -20, 0)] }
    const host = { ...instance(1, 'outer', 37), inputs: [], properties: {
      proxyWidgets: [[...['1', name], ...(sourceId ? [sourceId] : [])]],
    } }
    const doc = imported({ nodes: [host], definitions: { subgraphs: [outer, inner] } })
    const compiled = prompt(doc)
    expect(compiled['n1.n1.n1']!.inputs['value']).toBe(7)
    expect(compiled['n1.n1.n2']!.inputs['value']).toBe(37)
  })

  it('includes definition contents in deterministic lineage', () => {
    const def = definition()
    const raw = { nodes: [instance(1)], definitions: { subgraphs: [def] } }
    const first = imported(raw)
    def.nodes[0]!.widgets_values[0] = 88
    expect(imported(raw).lineage).not.toBe(first.lineage)
  })

  it('maps a net delivery across a boundary without leaving a synthetic source', () => {
    const target = relay()
    target.inputs[0]!.link = 3
    const def = { ...definition(), nodes: [target,
      { id: 2, type: 'SetNode', inputs: [{ name: '*', type: 'INT', link: 1 }], outputs: [{ name: 'INT', type: 'INT', links: [] }], widgets_values: ['shared'] },
      { id: 3, type: 'GetNode', outputs: [{ name: 'INT', type: 'INT', links: [3] }], widgets_values: ['shared'] },
    ], links: [link(1, -10, 0, 2, 0), link(2, 1, 0, -20, 0), link(3, 3, 0, 1, 0)] }
    const doc = imported({ nodes: [instance(1), relay(2)], links: [[1, 2, 0, 1, 0, 'INT']], definitions: { subgraphs: [def] } })
    expect(doc.graphs['inner']!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'value' })
    expect(prompt(doc)['n1.n1']!.inputs['value']).toEqual(['n2', 0])
  })

  it.each(['inputs', 'outputs'] as const)('rejects duplicate %s identities before they can collapse instance state', (side) => {
    const def = definition()
    def.nodes.push(relay(2))
    def[side].push({ ...def[side][0]!, linkIds: [3] })
    def.links.push(side === 'inputs' ? link(3, -10, 1, 2, 0) : link(3, 2, 0, -20, 1))
    const host = { ...instance(1), widgets_values: [11, 22], inputs: [
      { name: 'value', widget: { name: 'value' } }, { name: 'value', widget: { name: 'value' } },
    ] }
    const result = importLitegraph({ nodes: [host], definitions: { subgraphs: [def] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'import.subgraphs.invalid', severity: 'error' })])
  })

  it.each([
    { inputNode: { id: 1 } },
    { outputNode: { id: '1' } },
    { inputNode: { id: 9 }, outputNode: { id: '9' } },
    { inputNode: { id: -20 } },
    { outputNode: { id: '-10' } },
  ])('rejects colliding virtual boundary IDs: %j', (fields) => {
    const result = importLitegraph({ nodes: [instance(1)], definitions: { subgraphs: [{ ...definition(), ...fields }] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toEqual([expect.objectContaining({ code: 'import.subgraphs.invalid', severity: 'error' })])
  })

  it('maps distinct custom virtual boundary IDs without changing real edges', () => {
    const def = { ...definition(), inputNode: { id: 41 }, outputNode: { id: '42' },
      links: [link(1, 41, 0, 1, 0), link(2, 1, 0, 42, 0)] }
    const doc = imported({ nodes: [instance(1)], definitions: { subgraphs: [def] } })
    expect(prompt(doc)['n1.n1']!.inputs['value']).toBe(19)
    expect(doc.graphs['inner']!.boundary!.outputs[0]!.binds).toEqual({ kind: 'port', node: 'n1', port: 'result' })
  })

  it.each([
    { nodes: [{ id: { toString: 0, valueOf: 0 }, type: 'Relay' }] },
    { nodes: [null] },
    { nodes: [{ id: 1, type: 'Relay', inputs: 3 }] },
    { inputNode: { id: { toString: 0 } } },
    { links: [[1, null, 0, 1, 0]] },
    { inputs: [{ id: '__proto__' }] },
    { id: '__proto__' },
  ])('rejects malformed subgraph fields without throwing: %j', (fields) => {
    const result = importLitegraph({ nodes: [], definitions: { subgraphs: [{ ...definition(), ...fields }] } } as JsonObject, resolve)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
  })

  it('rejects recursive instance graphs and duplicate definition ids', () => {
    const cycle = { ...definition(), nodes: [instance(1)] }
    for (const defs of [[cycle], [definition(), definition()]]) {
      const result = importLitegraph({ nodes: [], links: [], definitions: { subgraphs: defs } } as unknown as JsonObject, resolve)
      expect(result.document).toBeUndefined()
      expect(result.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    }
  })
})
