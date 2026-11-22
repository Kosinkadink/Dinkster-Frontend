import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { effectiveOccurrenceTopology } from '../src/compile/effective-topology.js'
import { semanticHashOf } from '../src/compile/hash.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, occurrenceKey } from '../src/ids.js'
import type { NodeSchema } from '../src/schema/model.js'

const schema = (type: string, inputs: string[], outputs: string[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: type === 'Sink',
  body: [
    ...inputs.map((id) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' }, optional: false })),
    ...outputs.map((id) => ({ kind: 'output' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' } })),
  ],
})

const schemas: Record<string, NodeSchema> = {
  Src: schema('Src', [], ['out']),
  Sink: schema('Sink', ['in', 'other'], []),
  Slot: {
    type: 'Slot', displayName: 'Slot', category: 'test', source: 'v3', isOutputNode: true,
    body: [{
      kind: 'typeChoice', id: 's', type: { kind: 'concrete', name: 'IMAGE' }, required: false,
      rows: [{
        kind: 'input', id: 'gain', type: { kind: 'concrete', name: 'FLOAT' }, optional: true,
        widget: { widgetType: 'FLOAT', options: {}, default: 2 },
      }],
    }],
  },
}
const resolve = (type: string) => schemas[type]
const owner = (node: string, instancePath: readonly string[] = []) => ({
  instancePath: instancePath.map(asNodeId),
  node: asNodeId(node),
})

function document(): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('effective-topology'),
    root: asGraphDefId('root'),
    graphs: {
      root: {
        id: asGraphDefId('root'), name: 'root',
        nodes: {
          a: { id: asNodeId('a'), type: '#body', values: {} },
          b: { id: asNodeId('b'), type: '#body', values: {} },
        },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      },
      body: {
        id: asGraphDefId('body'), name: 'body',
        nodes: {
          p1: { id: asNodeId('p1'), type: 'Src', values: {} },
          p2: { id: asNodeId('p2'), type: 'Src', values: {} },
          sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
        },
        links: {
          shared: {
            id: asLinkId('shared'),
            from: { node: asNodeId('p1'), port: asPortId('out') },
            to: { node: asNodeId('sink'), port: asPortId('in') },
          },
        },
        nets: {
          sharedNet: {
            id: 'sharedNet' as never,
            name: 'sharedNet',
            source: { node: asNodeId('p1'), port: asPortId('out') },
            sinks: [{ node: asNodeId('sink'), port: asPortId('other') }],
          },
        },
        reroutes: {},
        boundary: { inputs: [], outputs: [] },
        nextOrdinal: 2,
      },
    },
    view: { graphs: {} },
  }
}

it('retains authored extra ports when validating occurrence-local links', () => {
  const base = withOverlay()
  const body = base.graphs.body!
  const authored: WorkflowDocument = { ...base, graphs: { ...base.graphs, body: {
    ...body, nodes: { ...body.nodes, sink: { ...body.nodes.sink!, additionalInputs: ['in'] } },
  } } }
  const extra = { ...schema('Sink', [], []), additionalInputs: { kind: 'wildcard' as const } }
  const resolver = (type: string) => type === 'Sink' ? extra : resolve(type)
  const result = effectiveOccurrenceTopology(authored, resolver, owner('a'))
  expect(result.diagnostics).toEqual([])
  const closed = effectiveOccurrenceTopology(base, resolver, owner('a'))
  expect(closed.diagnostics.map((item) => item.code)).toContain('occurrence.topology.endpointMissing')
})

function withOverlay(base = document()): WorkflowDocument {
  const a = owner('a')
  return {
    ...base,
    occurrenceTopologies: {
      [occurrenceKey(a)]: {
        owner: a,
        bodyGraph: asGraphDefId('body'),
        links: {
          local: {
            id: asLinkId('local'),
            from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
            to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
          },
        },
        suppressedDeliveries: [
          { kind: 'link', linkId: asLinkId('shared') },
          { kind: 'netSink', netId: 'sharedNet' as never, to: { node: asNodeId('sink'), port: asPortId('other') } },
        ],
        nextOrdinal: 1,
      },
    },
  }
}

const run = (doc: WorkflowDocument) => compile({
  document: doc,
  revision: 1,
  resolve,
  scope: { kind: 'full' },
  connection: asConnectionId('c'),
  schemaHash: 'schema',
})

describe('effectiveOccurrenceTopology', () => {
  it('lowers a local replacement only in its owning occurrence', () => {
    const result = run(withOverlay())
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.sink']!.inputs).toEqual({ in: ['a.p2', 0] })
    expect(result.artifact.prompt['b.sink']!.inputs).toEqual({ in: ['b.p1', 0], other: ['b.p1', 0] })
  })

  it('suppresses exactly one projected parent fan-out leg', () => {
    const base = document()
    const first = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('in') }
    const second = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('other') }
    const root = base.graphs.root!
    const body = base.graphs.body!
    const a = owner('a')
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...root,
          nodes: { ...root.nodes, p: { id: asNodeId('p'), type: 'Src', values: {} } },
          links: {
            parent: { id: asLinkId('parent'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('a'), port: asPortId('in') } },
            sibling: { id: asLinkId('sibling'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('b'), port: asPortId('in') } },
          },
        },
        body: { ...body, links: {}, nets: {}, boundary: { inputs: [{ id: 'in', binds: first, alsoBinds: [second] }], outputs: [] } },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('parent') },
            route: [{ graph: asGraphDefId('body'), boundaryId: 'in', binding: first }],
          }],
        },
      },
    }
    const result = run(changed)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.sink']!.inputs).toEqual({ other: ['p', 0] })
    expect(result.artifact.prompt['b.sink']!.inputs).toEqual({ in: ['p', 0], other: ['p', 0] })
    const effective = effectiveOccurrenceTopology(changed, resolve, a)
    expect(effective.projectedParentLinks).toHaveLength(1)
    expect(effective.projectedParentLinks[0]!.to.endpoint).toEqual(second)
  })

  it('suppresses a projected parent delivery on the output side', () => {
    const base = document()
    const a = owner('a')
    const binding = { kind: 'port' as const, node: asNodeId('p1'), port: asPortId('out') }
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            ...base.graphs.root!.nodes,
            sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
          },
          links: { parent: { id: asLinkId('parent'), from: { node: asNodeId('a'), port: asPortId('out') }, to: { node: asNodeId('sink'), port: asPortId('in') } } },
        },
        body: {
          ...base.graphs.body!,
          boundary: { inputs: [], outputs: [{ id: 'out', binds: binding }] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('parent') },
            route: [{ graph: asGraphDefId('body'), boundaryId: 'out', binding }],
          }],
        },
      },
    }
    expect(effectiveOccurrenceTopology(changed, resolve, a).projectedParentLinks).toEqual([])
    const compiled = run(changed)
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (compiled.ok) expect(compiled.artifact.prompt.sink!.inputs).toEqual({})
  })

  it('scopes a repeated-definition projected-leg suppression to its concrete owner and connectivity', () => {
    const base = document()
    const slotBinding = { kind: 'port' as const, node: asNodeId('slot'), port: asPortId('s') }
    const otherBinding = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('other') }
    const nestedA = owner('i', ['a'])
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            a: { id: asNodeId('a'), type: '#outer', values: {} },
            b: { id: asNodeId('b'), type: '#outer', values: {} },
          },
        },
        outer: {
          id: asGraphDefId('outer'), name: 'outer',
          nodes: {
            p: { id: asNodeId('p'), type: 'Src', values: {} },
            i: { id: asNodeId('i'), type: '#body', values: {} },
          },
          links: { parent: { id: asLinkId('parent'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('i'), port: asPortId('in') } } },
          nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: { inputs: [], outputs: [] },
        },
        body: {
          ...base.graphs.body!,
          nodes: {
            slot: { id: asNodeId('slot'), type: 'Slot', values: {} },
            sink: base.graphs.body!.nodes.sink!,
          },
          links: {}, nets: {},
          boundary: { inputs: [{ id: 'in', binds: slotBinding, alsoBinds: [otherBinding] }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(nestedA)]: {
          owner: nestedA, bodyGraph: asGraphDefId('body'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('outer'), linkId: asLinkId('parent') },
            route: [{ graph: asGraphDefId('body'), boundaryId: 'in', binding: slotBinding }],
          }],
        },
      },
    }
    const result = run(changed)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['a.i.slot']!.inputs).toEqual({})
    expect(result.artifact.prompt['a.i.sink']!.inputs).toEqual({ other: ['a.p', 0] })
    expect(result.artifact.prompt['b.i.slot']!.inputs).toEqual({ s: ['b.p', 0], 's.gain': 2 })
    expect(result.artifact.prompt['b.i.sink']!.inputs).toEqual({ other: ['b.p', 0] })
  })

  it('projects and suppresses a root delivery through a chained occurrence route', () => {
    const base = document()
    const nestedOwner = owner('i', ['a'])
    const outerBinding = { kind: 'port' as const, node: asNodeId('i'), port: asPortId('in') }
    const bodyBinding = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('in') }
    const route = [
      { graph: asGraphDefId('outer'), boundaryId: 'in', binding: outerBinding },
      { graph: asGraphDefId('body'), boundaryId: 'in', binding: bodyBinding },
    ]
    const changed: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        root: {
          ...base.graphs.root!,
          nodes: {
            p: { id: asNodeId('p'), type: 'Src', values: {} },
            a: { id: asNodeId('a'), type: '#outer', values: {} },
          },
          links: { rootLink: { id: asLinkId('rootLink'), from: { node: asNodeId('p'), port: asPortId('out') }, to: { node: asNodeId('a'), port: asPortId('in') } } },
        },
        outer: {
          id: asGraphDefId('outer'), name: 'outer',
          nodes: { i: { id: asNodeId('i'), type: '#body', values: {} } },
          links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
          boundary: { inputs: [{ id: 'in', binds: outerBinding }], outputs: [] },
        },
        body: {
          ...base.graphs.body!, links: {}, nets: {},
          boundary: { inputs: [{ id: 'in', binds: bodyBinding }], outputs: [] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(nestedOwner)]: {
          owner: nestedOwner, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: {
              id: asLinkId('local'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
            },
          },
        },
      },
    }
    const effective = effectiveOccurrenceTopology(changed, resolve, nestedOwner)
    expect(effective.projectedParentLinks).toHaveLength(1)
    expect(effective.projectedParentLinks[0]!.identity).toEqual({
      kind: 'parentLeg',
      delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('rootLink') },
      route,
    })
    expect(effective.diagnostics.map((diagnostic) => diagnostic.code)).toContain('occurrence.topology.multipleDrivers')

    const suppressed: WorkflowDocument = {
      ...changed,
      occurrenceTopologies: {
        [occurrenceKey(nestedOwner)]: {
          ...changed.occurrenceTopologies![occurrenceKey(nestedOwner)]!,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('rootLink') },
            route,
          }],
        },
      },
    }
    const suppressedEffective = effectiveOccurrenceTopology(suppressed, resolve, nestedOwner)
    expect(suppressedEffective.projectedParentLinks).toEqual([])
    expect(suppressedEffective.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('occurrence.topology.multipleDrivers')

    const intermediateSuppressed: WorkflowDocument = {
      ...changed,
      occurrenceTopologies: {
        [occurrenceKey(owner('a'))]: {
          owner: owner('a'), bodyGraph: asGraphDefId('outer'), links: {}, nextOrdinal: 0,
          suppressedDeliveries: [{
            kind: 'projectedLeg',
            delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('rootLink') },
            route: [route[0]!],
          }],
        },
        [occurrenceKey(nestedOwner)]: changed.occurrenceTopologies![occurrenceKey(nestedOwner)]!,
      },
    }
    const compiled = run(intermediateSuppressed)
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (compiled.ok) expect(compiled.artifact.prompt['a.i.sink']!.inputs).toEqual({ in: ['a.i.p2', 0] })
  })

  it('hashes a local reroute driver with its definition-owned consumer closure', () => {
    const base = document()
    const body = base.graphs.body!
    const a = owner('a')
    const rerouted: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        body: {
          ...body,
          links: { consumer: { id: asLinkId('consumer'), from: { reroute: 'r' as never }, to: { node: asNodeId('sink'), port: asPortId('in') } } },
          nets: {},
          reroutes: { r: { id: 'r' as never } },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: { id: asLinkId('local'), from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } }, to: { kind: 'body', endpoint: { reroute: 'r' as never } } },
          },
        },
      },
    }
    const direct: WorkflowDocument = {
      ...rerouted,
      graphs: { ...rerouted.graphs, body: { ...rerouted.graphs.body!, links: {} } },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          ...rerouted.occurrenceTopologies![occurrenceKey(a)]!,
          links: {
            local: { id: asLinkId('local'), from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } }, to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } } },
          },
        },
      },
    }
    expect(semanticHashOf(rerouted)).toBe(semanticHashOf(direct))

    const boundarySource = { kind: 'boundary' as const, occurrence: a, address: { port: asPortId('out') }, route: [{
      graph: asGraphDefId('body'), boundaryId: 'out', binding: { kind: 'port' as const, node: asNodeId('p2'), port: asPortId('out') },
    }] }
    const withOutput = (doc: WorkflowDocument): WorkflowDocument => ({
      ...doc,
      graphs: {
        ...doc.graphs,
        body: {
          ...doc.graphs.body!,
          boundary: { inputs: [], outputs: [{ id: 'out', binds: { kind: 'port', node: asNodeId('p2'), port: asPortId('out') } }] },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          ...doc.occurrenceTopologies![occurrenceKey(a)]!,
          links: {
            local: {
              ...doc.occurrenceTopologies![occurrenceKey(a)]!.links.local!,
              from: boundarySource,
            },
          },
        },
      },
    })
    expect(semanticHashOf(withOutput(rerouted))).toBe(semanticHashOf(withOutput(direct)))
  })

  it('fails closed when a boundary route binding has zero matches', () => {
    const doc = withOverlay()
    const top = doc.occurrenceTopologies![occurrenceKey(owner('a'))]!
    const changed: WorkflowDocument = {
      ...doc,
      occurrenceTopologies: {
        [occurrenceKey(owner('a'))]: {
          ...top,
          links: {
            bad: {
              id: asLinkId('bad'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: {
                kind: 'boundary', occurrence: owner('a'), address: { port: asPortId('missing') },
                route: [{ graph: asGraphDefId('body'), boundaryId: 'missing', binding: { kind: 'port', node: asNodeId('sink'), port: asPortId('in') } }],
              },
            },
          },
        },
      },
    }
    const result = effectiveOccurrenceTopology(changed, resolve, owner('a'))
    expect(result.links).toEqual([])
    expect(result.diagnostics.map((d) => d.code)).toContain('occurrence.topology.routeMissing')
  })

  it('fails closed when a recorded binding is structurally ambiguous', () => {
    const doc = document()
    const binding = { kind: 'port' as const, node: asNodeId('sink'), port: asPortId('in') }
    const body = doc.graphs.body!
    const changedBody = { ...body, boundary: { inputs: [{ id: 'in', binds: binding, alsoBinds: [binding] }], outputs: [] } }
    const a = owner('a')
    const changed: WorkflowDocument = {
      ...doc,
      graphs: { ...doc.graphs, body: changedBody },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            bad: {
              id: asLinkId('bad'),
              from: { kind: 'body', endpoint: { node: asNodeId('p2'), port: asPortId('out') } },
              to: { kind: 'boundary', occurrence: a, address: { port: asPortId('in') }, route: [{ graph: asGraphDefId('body'), boundaryId: 'in', binding }] },
            },
          },
        },
      },
    }
    const result = effectiveOccurrenceTopology(changed, resolve, a)
    expect(result.links.some((link) => link.identity.kind === 'occurrence')).toBe(false)
    expect(result.diagnostics.map((d) => d.code)).toContain('occurrence.topology.routeAmbiguous')
  })

  it('validates cycles and port direction over the combined effective set', () => {
    const base = document()
    const a = owner('a')
    const body = base.graphs.body!
    const cycled: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        body: {
          ...body, nets: {},
          reroutes: { r1: { id: 'r1' as never }, r2: { id: 'r2' as never } },
          links: { shared: { id: asLinkId('shared'), from: { reroute: 'r2' as never }, to: { reroute: 'r1' as never } } },
        },
      },
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: { id: asLinkId('local'), from: { kind: 'body', endpoint: { reroute: 'r1' as never } }, to: { kind: 'body', endpoint: { reroute: 'r2' as never } } },
          },
        },
      },
    }
    expect(effectiveOccurrenceTopology(cycled, resolve, a).diagnostics.map((diagnostic) => diagnostic.code)).toContain('doc.reroute.cycle')

    const wrongDirection: WorkflowDocument = {
      ...base,
      occurrenceTopologies: {
        [occurrenceKey(a)]: {
          owner: a, bodyGraph: asGraphDefId('body'), nextOrdinal: 1,
          links: {
            local: {
              id: asLinkId('local'),
              from: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
              to: { kind: 'body', endpoint: { node: asNodeId('p1'), port: asPortId('out') } },
            },
          },
        },
      },
    }
    expect(effectiveOccurrenceTopology(wrongDirection, resolve, a).diagnostics.filter((diagnostic) =>
      diagnostic.code === 'occurrence.topology.endpointDirection')).toHaveLength(2)
  })
})
