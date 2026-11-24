import { describe, expect, it } from 'vitest'
import type { GraphDef, Json, LinkData, WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, occurrenceKey, type LinkEndpoint, type PortRef } from '../src/ids.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { createLocalSession as createRawLocalSession } from '../src/commands/session.js'
import { checkDocument } from '../src/invariants.js'
import { compile } from '../src/compile/compile.js'
import { loadDocument } from '../src/format/migrate.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import { EMPTY_SUBGRAPH_DEFINITION, EMPTY_SUBGRAPH_VIEW, expandLifecycleSelectionFromGroups, flattenSchemaPlanDigest, flattenShellRefusalDiagnostic, lifecycleCanonicalHash, lifecycleFlattenFingerprint, lifecycleSelectionFingerprint, planFreshSubgraphCreate, planBoundaryNames, planFlattenBoundaryRoutes, verifyLifecycleSelectionPlan, type LifecycleSelectionInput } from '../src/lifecycle/planner.js'
import { effectiveOccurrenceTopology, planFlattenOccurrenceTopology } from '../src/compile/effective-topology.js'

type MutableDocument = Omit<WorkflowDocument, 'graphs' | 'view' | 'surfaces' | 'occurrenceTopologies'> & {
  graphs: Record<string, any>
  view: { graphs: Record<string, any> }
  surfaces?: Record<string, any>
  occurrenceTopologies?: Record<string, any>
}

const createLocalSession: typeof createRawLocalSession = (doc, commands, options) =>
  createRawLocalSession(doc, commands, {
    schemaResolverFor: () => flattenResolver,
    ...options,
  })

const port = (node: string, id: string): PortRef => ({
  node: node as never,
  port: id as never,
})

const link = (id: string, from: LinkEndpoint, to: LinkEndpoint): LinkData => ({ id: id as never, from, to })

const graph = (overrides: Partial<GraphDef> = {}): GraphDef => ({
  id: 'root' as never,
  name: 'Root',
  nodes: {
    outside: { id: 'outside' as never, type: 'Node', values: {} },
    inside: { id: 'inside' as never, type: 'Node', values: {} },
    inside2: { id: 'inside2' as never, type: 'Node', values: {} },
  },
  links: {},
  nets: {},
  reroutes: {},
  nextOrdinal: 20,
  ...overrides,
})

const document = (root = graph()): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lineage' as never,
  root: 'root' as never,
  graphs: { root },
  view: {
    graphs: {
      root: {
        nodes: {
          inside: { position: { x: 10, y: 20 }, size: { width: 100, height: 50 } },
          inside2: { position: { x: 40, y: 80 } },
          outside: { position: { x: -10, y: -20 } },
        },
        reroutes: {},
        groups: { group: { id: 'group', title: 'Group', bounds: { x: 0, y: 0, width: 200, height: 100 } } },
      },
    },
  },
})

const extractInvocation = (
  doc: WorkflowDocument,
  graphId: string,
  nodeIds: readonly string[],
  instancePath: readonly string[] = [],
  name = 'Extracted',
) => ({
  command: 'subgraph.extract',
  params: {
    graphId,
    instancePath,
    selection: { nodeIds },
    selectionFingerprint: lifecycleSelectionFingerprint(doc, graphId, { nodeIds })!,
    specializedSlotRoots: [],
    widgetTapSources: [],
    placementCenter: { x: 0, y: 0 },
    resolvedGeometry: [...nodeIds].sort().map((id, index) => {
      const view = doc.view.graphs[graphId]?.nodes[id]
      return {
        id,
        kind: 'node',
        x: view?.position?.x ?? index * 160,
        y: view?.position?.y ?? 0,
        width: view?.size?.width ?? 140,
        height: view?.size?.height ?? 80,
      }
    }),
    name,
  },
})

const l4ExtractInvocation = (
  doc: WorkflowDocument,
  selection: LifecycleSelectionInput,
  resolvedGeometry: readonly Record<string, unknown>[],
  graphId = 'root',
  instancePath: readonly string[] = [],
) => ({
  command: 'subgraph.extract',
  params: {
    graphId,
    instancePath,
    selection,
    selectionFingerprint: lifecycleSelectionFingerprint(doc, graphId, selection)!,
    specializedSlotRoots: [],
    widgetTapSources: [],
    groupMemberships: (selection.groupIds ?? []).map((groupId) => ({
      groupId,
      nodeIds: selection.nodeIds ?? [],
      rerouteIds: selection.rerouteIds ?? [],
    })),
    placementCenter: { x: 900, y: 700 },
    resolvedGeometry,
    name: 'Extracted L4',
  } as unknown as Json,
})

describe('fresh subgraph create planner', () => {
  it('localizes one shared occurrence as one serializable undoable command', () => {
    const initial = document(graph({
      nodes: {
        first: { id: 'first' as never, type: '#shared', values: {} },
        second: { id: 'second' as never, type: '#shared', values: {} },
      },
    }))
    ;(initial as MutableDocument).view.graphs.root = { nodes: { first: { position: { x: 0, y: 0 } }, second: { position: { x: 200, y: 0 } } } }
    ;(initial as MutableDocument).graphs.shared = graph({
      id: 'shared' as never,
      name: 'Shared',
      nodes: {
        nested: { id: 'nested' as never, type: '#child', values: { value: 3 } },
        producer: { id: 'producer' as never, type: 'Node', values: {} },
      },
      links: { nestedIncoming: link('nestedIncoming', port('producer', 'out'), port('nested', 'aux')) },
      boundary: { inputs: [], outputs: [{ id: 'out', binds: { kind: 'port', node: 'nested' as never, port: 'out' as never } }] },
    })
    ;(initial as MutableDocument).graphs.child = graph({
      id: 'child' as never,
      name: 'Child',
      nodes: { deep: { id: 'deep' as never, type: 'Node', values: {} } },
      boundary: { inputs: [{ id: 'aux', binds: { kind: 'port', node: 'deep' as never, port: 'aux' as never } }], outputs: [] },
    })
    ;(initial as MutableDocument).view.graphs.shared = { nodes: { nested: { position: { x: 4, y: 5 } }, producer: {} } }
    ;(initial as MutableDocument).view.graphs.child = { nodes: { deep: {} } }
    const sharedOutputBinding = initial.graphs.shared!.boundary!.outputs[0]!.binds
    const childAuxBinding = initial.graphs.child!.boundary!.inputs[0]!.binds
    ;(initial as MutableDocument).occurrenceTopologies = {
      first: {
        owner: { instancePath: [], node: 'first' }, bodyGraph: 'shared', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: {
              kind: 'boundary', occurrence: { instancePath: [], node: 'first' }, address: { port: 'out' },
              route: [{ graph: 'shared', boundaryId: 'out', binding: sharedOutputBinding }],
            },
            to: { kind: 'body', endpoint: port('nested', 'out') },
          },
        },
      },
      'first.nested': {
        owner: { instancePath: ['first'], node: 'nested' }, bodyGraph: 'child', links: {}, nextOrdinal: 0,
        suppressedDeliveries: [{
          kind: 'projectedLeg',
          delivery: { kind: 'link', graph: 'shared', linkId: 'nestedIncoming' },
          route: [{ graph: 'child', boundaryId: 'aux', binding: childAuxBinding }],
        }],
      },
      second: { owner: { instancePath: [], node: 'second' }, bodyGraph: 'shared', links: {}, nextOrdinal: 0 },
    }
    expect(checkDocument(initial), JSON.stringify(checkDocument(initial))).toEqual([])
    const session = createLocalSession(initial, coreCommandRegistry())
    const invocation = { command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } } as const

    expect(JSON.parse(JSON.stringify(invocation))).toEqual(invocation)
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.graphs.root!.nodes.second!.type).toBe('#shared')
    expect(session.doc.graphs.g0).toMatchObject({ name: 'Shared (Unique)', nodes: { nested: { type: '#child' } } })
    expect(session.doc.graphs.g0).not.toBe(initial.graphs.shared)
    expect(session.doc.view.graphs.g0).toEqual(initial.view.graphs.shared)
    expect(session.doc.occurrenceTopologies?.first?.bodyGraph).toBe('g0')
    expect(session.doc.occurrenceTopologies?.first).toMatchObject({
      links: { l0: { from: { route: [{ graph: 'g0' }] } } },
    })
    expect(session.doc.occurrenceTopologies?.['first.nested']?.bodyGraph).toBe('child')
    expect(session.doc.occurrenceTopologies?.['first.nested']?.suppressedDeliveries?.[0]).toMatchObject({
      delivery: { graph: 'g0' },
      route: [{ graph: 'child' }],
    })
    expect(JSON.stringify(session.doc.occurrenceTopologies?.second)).toBe(JSON.stringify(initial.occurrenceTopologies?.second))
    expect(checkDocument(session.doc).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(initial)
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.occurrenceTopologies).toEqual({
      ...initial.occurrenceTopologies,
      first: session.doc.occurrenceTopologies?.first,
      'first.nested': session.doc.occurrenceTopologies?.['first.nested'],
    })
  })

  it('localizes an occurrence selected inside a nested definition', () => {
    const initial = document(graph({ nodes: {
      outer: { id: 'outer' as never, type: '#parent', values: {} },
      sibling: { id: 'sibling' as never, type: '#child', values: {} },
    } })) as MutableDocument
    initial.graphs.parent = graph({
      id: 'parent' as never,
      name: 'Parent',
      nodes: {
        nested: { id: 'nested' as never, type: '#child', values: {} },
        nestedSibling: { id: 'nestedSibling' as never, type: '#child', values: {} },
      },
    })
    initial.graphs.child = graph({ id: 'child' as never, name: 'Child' })
    initial.view.graphs.parent = { nodes: { nested: {}, nestedSibling: {} } }
    initial.view.graphs.child = { nodes: {} }
    initial.occurrenceTopologies = {
      'outer.nested': { owner: { instancePath: ['outer'], node: 'nested' }, bodyGraph: 'child', links: {}, nextOrdinal: 0 },
      sibling: { owner: { instancePath: [], node: 'sibling' }, bodyGraph: 'child', links: {}, nextOrdinal: 0 },
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch({ command: 'occurrence.localize', params: { graphId: 'parent', nodeId: 'nested' } }).ok).toBe(true)
    expect(session.doc.graphs.parent!.nodes.nested!.type).toBe('#g0')
    expect(session.doc.occurrenceTopologies?.['outer.nested']?.bodyGraph).toBe('g0')
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(JSON.stringify(initial.occurrenceTopologies?.sibling))
    expect(checkDocument(session.doc).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(initial)
    expect(session.redo()).toBe(true)
    expect(session.doc.occurrenceTopologies?.['outer.nested']?.bodyGraph).toBe('g0')
  })

  it('localize copies exposed parameters and App layout placements for the cloned definition', () => {
    const initial = document(graph({
      nodes: {
        first: { id: 'first' as never, type: '#shared', values: {} },
        second: { id: 'second' as never, type: '#shared', values: {} },
      },
    })) as MutableDocument
    initial.graphs.shared = graph({
      id: 'shared' as never,
      name: 'Shared',
      nodes: { inner: { id: 'inner' as never, type: 'demo.node', values: {} } },
    })
    initial.view.graphs.shared = { nodes: { inner: {} } }
    const malformed = { graphId: 'shared' }
    const foreign = { graphId: 'root', nodeId: 'first', inputId: 'text' }
    const exposed = { graphId: 'shared', nodeId: 'inner', inputId: 'text', label: 'Inner text' }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.exposed': [foreign, exposed, malformed],
      'dinkster.appLayout': {
        version: 1,
        desktop: { items: [
          { id: 'inner-control', kind: 'control', ref: { graphId: 'shared', nodeId: 'inner', inputId: 'text' } },
          { id: 'instructions', kind: 'text', role: 'body', text: 'Instructions' },
          { id: 'controls', kind: 'group', title: 'Controls', children: ['inner-control'] },
        ] },
        mobile: { customized: false, items: [] },
      },
    }
    const session = createLocalSession(initial, coreCommandRegistry())

    expect(session.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.ext?.['dinkster.exposed']).toEqual([
      foreign,
      exposed,
      { ...exposed, graphId: 'g0' },
      malformed,
    ])
    expect(session.doc.ext?.['dinkster.appLayout']).toEqual({
      version: 1,
      desktop: { items: [
        { id: 'inner-control', kind: 'control', ref: { graphId: 'shared', nodeId: 'inner', inputId: 'text' } },
        { id: 'inner-control@g0', kind: 'control', ref: { graphId: 'g0', nodeId: 'inner', inputId: 'text' } },
        { id: 'instructions', kind: 'text', role: 'body', text: 'Instructions' },
        { id: 'controls', kind: 'group', title: 'Controls', children: ['inner-control', 'inner-control@g0'] },
      ] },
      mobile: { customized: false, items: [] },
    })
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(initial)
    expect(session.redo()).toBe(true)
    expect(session.doc.ext?.['dinkster.exposed']).toEqual([
      foreign,
      exposed,
      { ...exposed, graphId: 'g0' },
      malformed,
    ])
  })

  it('localize duplicates net tag placements for the cloned definition', () => {
    const initial = document(graph({
      nodes: {
        first: { id: 'first' as never, type: '#shared', values: {} },
        second: { id: 'second' as never, type: '#shared', values: {} },
      },
    })) as MutableDocument
    initial.graphs.shared = graph({
      id: 'shared' as never,
      name: 'Shared',
      nodes: {
        producer: { id: 'producer' as never, type: 'demo.node', values: {} },
        consumer: { id: 'consumer' as never, type: 'demo.node', values: {} },
      },
      nets: { inner: { id: 'inner' as never, name: 'Inner', source: port('producer', 'out'), sinks: [port('consumer', 'in')] } },
    })
    initial.view.graphs.shared = { nodes: { producer: {}, consumer: {} } }
    const malformed = { graphId: 'shared', netId: 'inner' }
    const rootEntry = { graphId: 'root', netId: 'other', role: 'source', offset: { x: 1, y: 2 } }
    const sourceEntry = { graphId: 'shared', netId: 'inner', role: 'source', offset: { x: 12, y: -8 } }
    const sinkEntry = { graphId: 'shared', netId: 'inner', role: 'sink', to: { node: 'consumer', port: 'in' }, position: { x: 300, y: 40 } }
    ;(initial as unknown as { ext: Json }).ext = { 'dinkster.netViews': [rootEntry, sourceEntry, sinkEntry, malformed] }
    const session = createLocalSession(initial, coreCommandRegistry())

    expect(session.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.first!.type).toBe('#g0')
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      rootEntry,
      sourceEntry,
      { ...sourceEntry, graphId: 'g0' },
      sinkEntry,
      { ...sinkEntry, graphId: 'g0' },
      malformed,
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([rootEntry, sourceEntry, sinkEntry, malformed])
  })

  it('creates the minimal invariant-clean definition and occurrence as one undoable batch', () => {
    const initial = document()
    const session = createLocalSession(initial, coreCommandRegistry())
    const plan = planFreshSubgraphCreate(session.doc, {
      parentGraphId: 'root',
      definition: EMPTY_SUBGRAPH_DEFINITION,
      view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position: { x: 12, y: 34 } },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan).toMatchObject({ graphId: 'g0', name: 'New Subgraph' })
    expect(plan.invocation).toMatchObject({
      command: 'batch',
      params: {
        invocations: [
          { command: 'subgraph.import', params: { graphs: { g0: { id: 'g0', name: 'New Subgraph' } } } },
          { command: 'node.add', params: { graphId: 'root', type: '#g0', position: { x: 12, y: 34 }, values: {} } },
        ],
      },
    })
    expect(session.dispatch(plan.invocation).ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.doc.graphs.g0).toEqual({
      id: 'g0',
      name: 'New Subgraph',
      nodes: {},
      links: {},
      nets: {},
      reroutes: {},
      boundary: { inputs: [], outputs: [] },
      nextOrdinal: 0,
    })
    expect(session.doc.view.graphs.g0).toEqual({ nodes: {} })
    expect(session.doc.graphs.root!.nodes.n20).toMatchObject({ type: '#g0', values: {} })
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.g0).toBeUndefined()
    expect(session.doc.view.graphs.g0).toBeUndefined()
    expect(session.doc.graphs.root!.nodes.n20).toBeUndefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(21)
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.canUndo).toBe(false)
  })

  it('suffixes default names across all definitions while preserving a caller-supplied nonblank name', () => {
    const doc = document()
    ;(doc as MutableDocument).graphs.named = graph({ id: 'named' as never, name: 'New Subgraph' })
    ;(doc as MutableDocument).graphs.named2 = graph({ id: 'named2' as never, name: 'New Subgraph 2' })
    ;(doc as MutableDocument).view.graphs.named = { nodes: {} }
    ;(doc as MutableDocument).view.graphs.named2 = { nodes: {} }
    const defaultPlan = planFreshSubgraphCreate(doc, {
      parentGraphId: 'root', definition: EMPTY_SUBGRAPH_DEFINITION, view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position: { x: 0, y: 0 } },
    })
    expect(defaultPlan.ok && defaultPlan.name).toBe('New Subgraph 3')
    const namedPlan = planFreshSubgraphCreate(doc, {
      parentGraphId: 'root', definition: EMPTY_SUBGRAPH_DEFINITION, view: EMPTY_SUBGRAPH_VIEW,
      occurrence: { position: { x: 0, y: 0 } }, name: 'Reusable',
    })
    expect(namedPlan.ok && namedPlan.name).toBe('Reusable')
  })

  it('passes a non-empty invariant-clean topology and region occurrence through the same planner', () => {
    const definition = {
      ...EMPTY_SUBGRAPH_DEFINITION,
      nodes: { starter: { id: 'starter', type: 'Starter', values: {} } },
      boundary: {
        inputs: [
          { id: 'item', binds: { kind: 'port', node: 'starter', port: 'item' } },
          { id: 'state', binds: { kind: 'port', node: 'starter', port: 'state' } },
        ],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'starter', port: 'result' } }],
      },
    } as unknown as typeof EMPTY_SUBGRAPH_DEFINITION
    const plan = planFreshSubgraphCreate(document(), {
      parentGraphId: 'root',
      definition,
      view: { nodes: { starter: { position: { x: 10, y: 20 } } } },
      occurrence: {
        position: { x: 30, y: 40 },
        values: { item: [], state: 0 },
        region: {
          kind: 'fold',
          elementPorts: ['item'],
          statePorts: ['state'],
          outputRoles: { result: { kind: 'state', statePort: 'state' } },
        },
      },
    })
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const session = createLocalSession(document(), coreCommandRegistry())
    expect(session.dispatch(plan.invocation).ok).toBe(true)
    expect(session.doc.graphs.g0!.nodes.starter).toEqual({ id: 'starter', type: 'Starter', values: {} })
    expect(session.doc.view.graphs.g0!.nodes.starter!.position).toEqual({ x: 10, y: 20 })
    expect(session.doc.graphs.root!.nodes.n20!.region).toEqual({
      kind: 'fold', elementPorts: ['item'], statePorts: ['state'],
      outputRoles: { result: { kind: 'state', statePort: 'state' } },
    })
    expect(checkDocument(session.doc)).toEqual([])
  })
})

describe('occurrence topology lifecycle guards', () => {
  const topologyDocument = (): MutableDocument => {
    const initial = document(graph({
      nodes: {
        owner: { id: 'owner' as never, type: '#body', values: {}, dynamic: { items: { members: ['m0'], seq: 1 } } },
        selected: { id: 'selected' as never, type: 'Node', values: {} },
        outside: { id: 'outside' as never, type: 'Node', values: {} },
      },
    })) as MutableDocument
    initial.graphs.body = graph({
      id: 'body' as never, name: 'Body',
      nodes: {
        producer: { id: 'producer' as never, type: 'Source', values: {} },
        sink: { id: 'sink' as never, type: 'Consumer', values: {}, dynamic: { items: { members: ['m0'], seq: 1 } } },
      },
      links: { shared: link('shared', port('producer', 'out'), port('sink', 'in')) },
      nets: { sharedNet: { id: 'sharedNet' as never, name: 'shared', source: port('producer', 'out'), sinks: [port('sink', 'net')] } },
      boundary: { inputs: [], outputs: [] },
    })
    initial.view.graphs.body = { nodes: { producer: {}, sink: {} } }
    ;(initial as any).occurrenceTopologies = {
      owner: {
        owner: { instancePath: [], node: 'owner' }, bodyGraph: 'body', nextOrdinal: 1,
        links: {
          l0: {
            id: 'l0',
            from: { kind: 'body', endpoint: port('producer', 'out') },
            to: { kind: 'body', endpoint: port('sink', 'in') },
          },
        },
        suppressedDeliveries: [
          { kind: 'link', linkId: 'shared' },
          { kind: 'netSink', netId: 'sharedNet', to: port('sink', 'net') },
        ],
      },
    }
    return initial
  }

  it.each([
    ['owner path hop', 'root', [] as string[], ['owner']],
    ['occurrence link endpoint', 'body', ['owner'], ['sink']],
    ['occurrence suppression target', 'body', ['owner'], ['sink']],
    ['occurrence dynamic member owner', 'root', [] as string[], ['owner']],
  ])('extract refuses a selection intersecting an %s', (_label, graphId, instancePath, nodeIds) => {
    const initial = topologyDocument()
    const session = createLocalSession(initial, coreCommandRegistry())
    const before = session.doc
    const outcome = session.dispatch(extractInvocation(initial, graphId, nodeIds, instancePath))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.extract.occurrenceTopologyIntersect')
    expect(session.doc).toBe(before)
  })
})

describe('subgraph.extract L3 command', () => {
  it('extracts nodes, plain links, and named nets into exact parent and definition topology', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        a: { id: 'a' as never, type: 'A', values: { keep: 1 } },
        b: { id: 'b' as never, type: 'B', values: {} },
        consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
      },
      links: {
        inA: link('inA', port('outside', 'out'), port('a', 'input')),
        inB: link('inB', port('outside', 'out'), port('b', 'other')),
        middle: link('middle', port('a', 'middle'), port('b', 'middle')),
        out: link('out', port('a', 'result'), port('consumer', 'input')),
      },
      nets: {
        internal: { id: 'internal' as never, name: 'Internal', source: port('a', 'net'), sinks: [port('b', 'net')] },
        incoming: { id: 'incoming' as never, name: 'Incoming', source: port('outside', 'net'), sinks: [port('a', 'netIn'), port('consumer', 'netIn')] },
        split: { id: 'split' as never, name: 'Split', source: port('b', 'netOut'), sinks: [port('a', 'inner'), port('consumer', 'outer')] },
      },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'root', ['b', 'a'])).ok).toBe(true)

    expect(session.doc.graphs.g0).toEqual({
      id: 'g0',
      name: 'Extracted',
      nodes: {
        n0: { id: 'n0', type: 'A', values: { keep: 1 } },
        n1: { id: 'n1', type: 'B', values: {} },
      },
      links: {
        l2: { id: 'l2', from: port('n0', 'middle'), to: port('n1', 'middle') },
      },
      nets: {
        net3: { id: 'net3', name: 'Internal', source: port('n0', 'net'), sinks: [port('n1', 'net')] },
        net4: { id: 'net4', name: 'Split', source: port('n1', 'netOut'), sinks: [port('n0', 'inner')] },
      },
      reroutes: {},
      boundary: {
        inputs: [
          { id: 'netIn', binds: { kind: 'port', ...port('n0', 'netIn') } },
          {
            id: 'input',
            binds: { kind: 'port', ...port('n0', 'input') },
            alsoBinds: [{ kind: 'port', ...port('n1', 'other') }],
          },
        ],
        outputs: [
          { id: 'result', binds: { kind: 'port', ...port('n0', 'result') } },
          { id: 'netOut', binds: { kind: 'port', ...port('n1', 'netOut') } },
        ],
      },
      nextOrdinal: 5,
    })
    expect(session.doc.graphs.root).toEqual({
      ...initial.graphs.root,
      nodes: {
        outside: initial.graphs.root!.nodes.outside,
        consumer: initial.graphs.root!.nodes.consumer,
        n20: { id: 'n20', type: '#g0', values: {} },
      },
      links: {
        inA: { id: 'inA', from: port('outside', 'out'), to: port('n20', 'input') },
        out: { id: 'out', from: port('n20', 'result'), to: port('consumer', 'input') },
      },
      nets: {
        incoming: {
          id: 'incoming', name: 'Incoming', source: port('outside', 'net'),
          sinks: [port('consumer', 'netIn'), port('n20', 'netIn')],
        },
        split: { id: 'split', name: 'Split', source: port('n20', 'netOut'), sinks: [port('consumer', 'outer')] },
      },
      nextOrdinal: 21,
    })
    expect(session.doc.view.graphs.g0).toEqual({
      nodes: {
        n0: { position: { x: -150, y: -40 } },
        n1: { position: { x: 10, y: -40 } },
      },
    })
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('extracts one widget output boundary from a multi-node selection for every outside fan-out consumer and round-trips undo', () => {
    const initial = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'Int', values: { value: 7 } },
        spare: { id: 'spare' as never, type: 'Keep', values: {} },
        first: { id: 'first' as never, type: 'MathExpression', values: {} },
        second: { id: 'second' as never, type: 'MathExpression', values: {} },
      },
      links: {
        firstTap: link('firstTap', { node: 'inside' as never, tap: 'value' as never }, port('first', 'a')),
        secondTap: link('secondTap', { node: 'inside' as never, tap: 'value' as never }, port('second', 'b')),
      },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = { inside: {}, spare: {}, first: {}, second: {} }

    const refusedSession = createLocalSession(initial, coreCommandRegistry())
    const refusedBefore = refusedSession.doc
    const refused = refusedSession.dispatch(extractInvocation(initial, 'root', ['inside', 'spare']))
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
    expect(refusedSession.doc).toBe(refusedBefore)
    expect(refusedSession.canUndo).toBe(false)

    const widgetSchema: any = {
      type: 'Int', displayName: 'Int', category: 'test', source: 'v3', isOutputNode: false,
      body: [{
        kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: {} },
      }],
    }
    const session = createLocalSession(initial, coreCommandRegistry(), {
      schemaResolverFor: () => (type) => type === 'Int' ? widgetSchema : flattenResolver(type),
    })

    const planned = extractInvocation(initial, 'root', ['inside', 'spare'])
    const invocation = {
      ...planned,
      params: { ...planned.params, widgetTapSources: [{ node: 'inside', tap: 'value' }] },
    }
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(Object.values(session.doc.graphs.g0!.nodes).map((node) => node.type).sort()).toEqual(['Int', 'Keep'])
    expect(session.doc.graphs.g0!.boundary).toEqual({
      inputs: [],
      outputs: [{ id: 'value', binds: { kind: 'widgetTap', node: 'n0', tap: 'value' } }],
    })
    expect(session.doc.graphs.root!.links).toEqual({
      firstTap: { id: 'firstTap', from: port('n20', 'value'), to: port('first', 'a') },
      secondTap: { id: 'secondTap', from: port('n20', 'value'), to: port('second', 'b') },
    })
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual({
      ...initial,
      graphs: { ...initial.graphs, root: { ...initial.graphs.root!, nextOrdinal: 21 } },
    })
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.g0!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n0', tap: 'value' })
  })

  it('moves tag offsets of fully extracted nets into the new definition and drops their absolute geometry', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        a: { id: 'a' as never, type: 'A', values: {} },
        b: { id: 'b' as never, type: 'B', values: {} },
        consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
      },
      links: {},
      nets: {
        internal: { id: 'internal' as never, name: 'Internal', source: port('a', 'net'), sinks: [port('b', 'net')] },
        split: { id: 'split' as never, name: 'Split', source: port('b', 'netOut'), sinks: [port('a', 'inner'), port('consumer', 'outer')] },
      },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const malformed = { future: true }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [
        { graphId: 'root', netId: 'internal', role: 'source', offset: { x: 30, y: -10 } },
        { graphId: 'root', netId: 'internal', role: 'sink', to: { node: 'b', port: 'net' }, offset: { x: -25, y: 40 } },
        // Absolute geometry is root-graph world coordinates: dropped on move.
        { graphId: 'root', netId: 'internal', role: 'source', position: { x: 9, y: 9 } },
        // The split net keeps a parent entry, so its tag stays put.
        { graphId: 'root', netId: 'split', role: 'source', offset: { x: 5, y: 6 } },
        malformed,
      ],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'root', ['b', 'a'])).ok).toBe(true)
    // Extraction remaps a -> n0, b -> n1, internal -> net2 inside g0.
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      { graphId: 'g0', netId: 'net2', role: 'source', offset: { x: 30, y: -10 } },
      { graphId: 'g0', netId: 'net2', role: 'sink', to: { node: 'n1', port: 'net' }, offset: { x: -25, y: 40 } },
      { graphId: 'root', netId: 'split', role: 'source', offset: { x: 5, y: 6 } },
      malformed,
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext).toEqual((initial as unknown as { ext: Json }).ext)
  })

  it('is one undo and redo while keeping both allocator high-water marks clean', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        inside: { id: 'inside' as never, type: 'Body', values: {} },
      },
      links: { crossing: link('crossing', port('outside', 'out'), port('inside', 'in')) },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'root', ['inside'])).ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.g0).toBeUndefined()
    expect(session.doc.graphs.root!.nodes.inside).toEqual(initial.graphs.root!.nodes.inside)
    expect(session.doc.graphs.root!.nextOrdinal).toBe(21)
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.g0!.nextOrdinal).toBe(1)
    expect(session.doc.graphs.root!.nextOrdinal).toBe(21)
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('rewrites the current enclosing boundary while extracting inside a nested definition', () => {
    const root = graph({
      nodes: { shell: { id: 'shell' as never, type: '#body', values: {} } },
      links: {}, nets: {}, nextOrdinal: 20,
    })
    const body = graph({
      id: 'body' as never,
      name: 'Body',
      nodes: {
        keep: { id: 'keep' as never, type: 'Keep', values: {} },
        move: { id: 'move' as never, type: 'Move', values: {} },
      },
      links: {}, nets: {}, nextOrdinal: 7,
      boundary: {
        inputs: [{
          id: 'fan',
          binds: { kind: 'port', node: 'keep' as never, port: 'a' as never },
          alsoBinds: [{ kind: 'port', node: 'move' as never, port: 'b' as never }],
        }],
        outputs: [{ id: 'result', binds: { kind: 'port', node: 'move' as never, port: 'out' as never } }],
      },
    })
    const initial = document(root) as MutableDocument
    initial.view.graphs.root = { nodes: { shell: {} } }
    initial.graphs.body = body
    initial.view.graphs.body = { nodes: { keep: {}, move: {} } }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'body', ['move'], ['shell'])).ok).toBe(true)
    expect(session.doc.graphs.body!.boundary).toEqual({
      inputs: [{
        id: 'fan',
        binds: { kind: 'port', node: 'keep', port: 'a' },
        alsoBinds: [{ kind: 'port', node: 'n7', port: 'b' }],
      }],
      outputs: [{ id: 'result', binds: { kind: 'port', node: 'n7', port: 'out' } }],
    })
    expect(session.doc.graphs.g0!.boundary).toEqual({
      inputs: [{ id: 'b', binds: { kind: 'port', node: 'n0', port: 'b' } }],
      outputs: [{ id: 'out', binds: { kind: 'port', node: 'n0', port: 'out' } }],
    })
    expect(session.doc.graphs.root!.nodes.shell!.type).toBe('#body')
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('re-executes against unrelated changes and drops stale intentions loudly', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        inside: { id: 'inside' as never, type: 'Body', values: {} },
      },
      links: { crossing: link('crossing', port('outside', 'out'), port('inside', 'in')) },
    }))
    ;(initial as MutableDocument).view.graphs.root.nodes = {}
    const invocation = extractInvocation(initial, 'root', ['inside'])
    const unrelated = structuredClone(initial) as MutableDocument
    unrelated.graphs.g0 = graph({ id: 'g0' as never, name: 'Claimed', nodes: {}, nextOrdinal: 0 })
    unrelated.view.graphs.g0 = { nodes: {} }
    unrelated.graphs.root!.nodes.outside = { ...unrelated.graphs.root!.nodes.outside!, title: 'peer edit' }
    const rebased = createLocalSession(unrelated, coreCommandRegistry())
    expect(rebased.dispatch({ ...invocation, actor: 'actorA' }).ok).toBe(true)
    expect(rebased.doc.graphs.g1).toBeDefined()
    expect(rebased.doc.graphs.root!.nodes['n0-actorA']).toBeDefined()
    expect(rebased.doc.graphs.g1!.nodes['n0-actorA']).toBeDefined()

    const stale = structuredClone(initial) as MutableDocument
    stale.graphs.root!.links.crossing = { ...stale.graphs.root!.links.crossing!, to: port('inside', 'changed') }
    const dropped = createLocalSession(stale, coreCommandRegistry()).dispatch(invocation)
    expect(dropped.ok).toBe(false)
    if (!dropped.ok) expect(dropped.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.lifecycle.stalePlan')

  })

  it('gates specialized-slot roots and prospective multi-driver violations with named diagnostics', () => {
    const slotDoc = document(graph({
      links: { crossing: link('crossing', port('outside', 'out'), port('inside', 'slot')) },
    }))
    const slotInvocation = extractInvocation(slotDoc, 'root', ['inside'])
    const slot = createLocalSession(slotDoc, coreCommandRegistry()).dispatch({
      ...slotInvocation,
      params: { ...slotInvocation.params, specializedSlotRoots: [{ node: 'inside', port: 'slot' }] },
    })
    expect(slot.ok).toBe(false)
    if (!slot.ok) expect(slot.diagnostics[0]!.code).toBe('subgraph.extract.specializedSlotUnsupported')

    const driven = document(graph({
      links: { internal: link('internal', port('inside2', 'out'), port('inside', 'in')) },
      boundary: {
        inputs: [{ id: 'input', binds: { kind: 'port', node: 'inside' as never, port: 'in' as never } }],
        outputs: [],
      },
    }))
    const multiDriver = createLocalSession(driven, coreCommandRegistry())
      .dispatch(extractInvocation(driven, 'root', ['inside', 'inside2']))
    expect(multiDriver.ok).toBe(false)
    if (!multiDriver.ok) expect(multiDriver.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('subgraph.lifecycle.multiDriver')
  })

  it('transfers view state and refuses malformed selections and exhausted allocation without mutation', () => {
    const viewed = document(graph({
      nodes: { inside: { id: 'inside' as never, type: 'Body', values: {} } },
      links: {}, nets: {}, nextOrdinal: 20,
    })) as MutableDocument
    viewed.view.graphs.root = { nodes: { inside: { position: { x: 1, y: 2 } } } }
    const viewedSession = createLocalSession(viewed, coreCommandRegistry())
    const viewOutcome = viewedSession.dispatch(extractInvocation(viewed, 'root', ['inside']))
    expect(viewOutcome.ok).toBe(true)
    expect(viewedSession.doc.view.graphs.g0!.nodes.n0!.position).toEqual({ x: -70, y: -40 })
    expect(viewedSession.doc.view.graphs.root!.nodes.n20!.position).toEqual({ x: 71, y: 42 })

    for (const split of [false, true]) {
      const collapsed = document(graph({
        nodes: {
          inside: { id: 'inside' as never, type: 'Inside', values: {} },
          inside2: { id: 'inside2' as never, type: 'Inside2', values: {} },
          outside: { id: 'outside' as never, type: 'Outside', values: {} },
        },
        links: {},
        nets: {
          net: {
            id: 'net' as never, name: 'Net', source: port('inside', 'out'),
            sinks: [port('inside2', 'inner'), ...(split ? [port('outside', 'outer')] : [])],
          },
        },
      })) as MutableDocument
      collapsed.view.graphs.root = { nodes: {}, collapsedNets: ['net'], guideNets: ['net'] }
      const collapsedSession = createLocalSession(collapsed, coreCommandRegistry())
      const outcome = collapsedSession.dispatch(extractInvocation(collapsed, 'root', ['inside', 'inside2']))
      expect(outcome.ok).toBe(true)
      expect(collapsedSession.doc.view.graphs.g0!.collapsedNets).toEqual(['net2'])
      expect(collapsedSession.doc.view.graphs.g0!.guideNets).toEqual(['net2'])
      expect(collapsedSession.doc.view.graphs.root!.collapsedNets).toEqual(split ? ['net'] : [])
      expect(collapsedSession.doc.view.graphs.root!.guideNets).toEqual(split ? ['net'] : [])
    }

    const missingCoverageDoc = document()
    const withCoverage = extractInvocation(missingCoverageDoc, 'root', ['inside'])
    const { specializedSlotRoots: _coverage, ...withoutCoverage } = withCoverage.params
    const missingCoverage = createLocalSession(missingCoverageDoc, coreCommandRegistry()).dispatch({
      ...withCoverage,
      params: withoutCoverage,
    })
    expect(missingCoverage.ok).toBe(false)
    if (!missingCoverage.ok) expect(missingCoverage.diagnostics[0]!.code).toBe('params.invalid')

    const malformed = createLocalSession(document(), coreCommandRegistry()).dispatch({
      command: 'subgraph.extract',
      params: {
        graphId: 'root', instancePath: [], selection: { nodeIds: ['inside', 1] },
        selectionFingerprint: 'sha256:not-used', specializedSlotRoots: [],
      },
    })
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.diagnostics[0]!.code).toBe('params.invalid')

    const exhausted = document(graph({
      nodes: { inside: { id: 'inside' as never, type: 'Body', values: {} } },
      links: {}, nets: {}, nextOrdinal: Number.MAX_SAFE_INTEGER,
    })) as MutableDocument
    exhausted.view.graphs.root = { nodes: { inside: {} } }
    const exhaustedSession = createLocalSession(exhausted, coreCommandRegistry())
    const exhaustedBefore = exhaustedSession.doc
    const exhaustion = exhaustedSession.dispatch(extractInvocation(exhausted, 'root', ['inside']))
    expect(exhaustion.ok).toBe(false)
    if (!exhaustion.ok) expect(exhaustion.diagnostics[0]!.code).toBe('subgraph.lifecycle.idExhausted')
    expect(exhaustedSession.doc).toBe(exhaustedBefore)
  })

  it('collapses an all-moved enclosing input fan-out without retaining stale bindings', () => {
    const body = graph({
      id: 'body' as never,
      name: 'Body',
      nodes: {
        a: { id: 'a' as never, type: 'A', values: {} },
        b: { id: 'b' as never, type: 'B', values: {} },
        c: { id: 'c' as never, type: 'C', values: {} },
      },
      links: {}, nets: {}, nextOrdinal: 4,
      boundary: {
        inputs: [{
          id: 'fan',
          binds: { kind: 'port', node: 'a' as never, port: 'one' as never },
          alsoBinds: [
            { kind: 'port', node: 'b' as never, port: 'two' as never },
            { kind: 'port', node: 'c' as never, port: 'three' as never },
          ],
        }],
        outputs: [],
      },
    })
    const root = graph({ nodes: { shell: { id: 'shell' as never, type: '#body', values: {} } }, links: {}, nets: {} })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { shell: {} } }
    initial.view.graphs.body = { nodes: { a: {}, b: {}, c: {} } }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(extractInvocation(initial, 'body', ['a', 'b', 'c'], ['shell'])).ok).toBe(true)
    expect(session.doc.graphs.body!.boundary!.inputs).toEqual([
      { id: 'fan', binds: { kind: 'port', node: 'n4', port: 'one' } },
    ])
    expect(session.doc.graphs.g0!.boundary!.inputs).toEqual([{
      id: 'one',
      binds: { kind: 'port', node: 'n0', port: 'one' },
      alsoBinds: [
        { kind: 'port', node: 'n1', port: 'two' },
        { kind: 'port', node: 'n2', port: 'three' },
      ],
    }])
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('retains each semantic link extension and atomically refuses opaque split-net state', () => {
    const linksDoc = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Source', values: {} },
        a: { id: 'a' as never, type: 'A', values: {} },
        b: { id: 'b' as never, type: 'B', values: {} },
      },
      links: {
        plain: link('plain', port('outside', 'out'), port('a', 'plain')),
        extA: { ...link('extA', port('outside', 'out'), port('a', 'ext')), ext: { owner: 'a' } },
        extB: { ...link('extB', port('outside', 'out'), port('b', 'ext')), ext: { owner: 'b' } },
      },
    })) as MutableDocument
    linksDoc.view.graphs.root = { nodes: {} }
    const linksSession = createLocalSession(linksDoc, coreCommandRegistry())
    expect(linksSession.dispatch(extractInvocation(linksDoc, 'root', ['a', 'b'])).ok).toBe(true)
    expect(linksSession.doc.graphs.root!.links).toEqual({
      extA: { id: 'extA', from: port('outside', 'out'), to: port('n20', 'ext'), ext: { owner: 'a' } },
      extB: { id: 'extB', from: port('outside', 'out'), to: port('n20', 'ext_2'), ext: { owner: 'b' } },
      plain: { id: 'plain', from: port('outside', 'out'), to: port('n20', 'plain') },
    })

    const netDoc = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'Inside', values: {} },
        inside2: { id: 'inside2' as never, type: 'Inside2', values: {} },
        outside: { id: 'outside' as never, type: 'Outside', values: {} },
      },
      nets: {
        split: {
          id: 'split' as never, name: 'Split', source: port('inside', 'out'),
          sinks: [port('inside2', 'inner'), port('outside', 'outer')], ext: { opaque: true },
        },
      },
    })) as MutableDocument
    netDoc.view.graphs.root = { nodes: {} }
    const netSession = createLocalSession(netDoc, coreCommandRegistry())
    const before = netSession.doc
    const refusal = netSession.dispatch(extractInvocation(netDoc, 'root', ['inside', 'inside2']))
    expect(refusal.ok).toBe(false)
    if (!refusal.ok) expect(refusal.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
    expect(netSession.doc).toBe(before)
  })
})

describe('subgraph.extract L4 structural and view completion', () => {
  it('moves an enclosing junction boundary with its complete fanout and refuses split ownership atomically', () => {
    const initial = document(graph({
      nodes: {
        inside: { id: 'inside' as never, type: 'BodyNode', values: {} },
        inside2: { id: 'inside2' as never, type: 'BodyNode', values: {} },
      },
      reroutes: { junction: { id: 'junction' as never } },
      links: {
        left: link('left', { reroute: 'junction' as never }, port('inside', 'in')),
        right: link('right', { reroute: 'junction' as never }, port('inside2', 'other')),
      },
      boundary: {
        inputs: [{ id: 'in', binds: { kind: 'port', ...port('inside', 'in'), viaReroute: 'junction' as never } }],
        outputs: [],
      },
    })) as MutableDocument
    initial.view.graphs.root.reroutes = { junction: { position: { x: -30, y: 45 } } }
    delete initial.view.graphs.root.nodes.outside
    const geometry = [
      { id: 'inside', kind: 'node', x: 10, y: 20, width: 100, height: 50 },
      { id: 'inside2', kind: 'node', x: 40, y: 80, width: 140, height: 80 },
      { id: 'junction', kind: 'reroute', x: -30, y: 45, width: 0, height: 0 },
    ]
    const splitSelections: LifecycleSelectionInput[] = [{ nodeIds: ['inside'] }, { nodeIds: ['inside2'], rerouteIds: ['junction'] }]
    for (const selection of splitSelections) {
      const session = createLocalSession(initial, coreCommandRegistry())
      const before = JSON.stringify(session.doc)
      const outcome = session.dispatch(l4ExtractInvocation(initial, selection, geometry.filter((item) =>
        item.kind === 'node' ? selection.nodeIds?.includes(item.id) : selection.rerouteIds?.includes(item.id))))
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.diagnostics.map((entry) => entry.code)).toContain('subgraph.extract.structuralCutUnsupported')
      expect(JSON.stringify(session.doc)).toBe(before)
    }

    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(l4ExtractInvocation(initial, { nodeIds: ['inside', 'inside2'], rerouteIds: ['junction'] }, geometry))
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true)
    const nested = session.doc.graphs.g0!
    expect(nested.boundary?.inputs).toEqual([{ id: 'in', binds: { kind: 'port', ...port('n0', 'in'), viaReroute: 'r2' } }])
    expect(nested.links).toEqual({
      l3: link('l3', { reroute: 'r2' as never }, port('n0', 'in')),
      l4: link('l4', { reroute: 'r2' as never }, port('n1', 'other')),
    })
    expect(session.doc.graphs.root!.boundary?.inputs).toEqual([{ id: 'in', binds: { kind: 'port', ...port('n20', 'in') } }])
    expect(Object.keys(session.doc.graphs.root!.reroutes)).toEqual([])
    const view = session.doc.view.graphs.g0!
    expect(view.reroutes!.r2!.position.x - view.nodes.n0!.position!.x).toBe(-40)
    expect(view.reroutes!.r2!.position.y - view.nodes.n1!.position!.y).toBe(-35)
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual({ ...initial, graphs: { root: { ...initial.graphs.root, nextOrdinal: 21 } } })
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.g0).toEqual(nested)
  })

  it('coexists across nets, reroutes, taps, wire-15 members, nested occurrences, groups, modes, and view state', () => {
    const initial = document(graph({
      nodes: {
        outside: { id: 'outside' as never, type: 'Outside', values: {} },
        consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
        a: {
          id: 'a' as never,
          type: 'A',
          mode: 'muted',
          values: { dormant: 7 },
          dynamic: { family: { members: ['m9'] }, 'family.m9.nested': { members: ['name-a'] } },
        },
        b: { id: 'b' as never, type: 'B', mode: 'bypassed', values: {} },
        nested: { id: 'nested' as never, type: '#child', values: { promoted: 3 } },
      },
      reroutes: { route: { id: 'route' as never, ext: { route: true } } },
      links: {
        tapIn: link('tapIn', { node: 'outside' as never, tap: 'widget' as never }, port('a', 'tapInput')),
        memberIn: link('memberIn', port('outside', 'member'), port('a', 'family.m9.nested.name-a.leaf')),
        routeDriver: link('routeDriver', port('a', 'out'), { reroute: 'route' as never }),
        routeConsumer: link('routeConsumer', { reroute: 'route' as never }, port('b', 'in')),
        nestedFeed: link('nestedFeed', port('b', 'nested'), port('nested', 'in')),
      },
      nets: {
        split: {
          id: 'split' as never,
          name: 'Split',
          source: port('b', 'netOut'),
          sinks: [port('a', 'netIn'), port('consumer', 'netIn')],
        },
      },
      nextOrdinal: 30,
    })) as MutableDocument
    initial.graphs.child = graph({ id: 'child' as never, name: 'Child', nodes: {}, nextOrdinal: 0 })
    initial.view.graphs.child = { nodes: {} }
    initial.view.graphs.root = {
      nodes: {
        outside: { position: { x: -200, y: 0 } },
        consumer: { position: { x: 500, y: 0 } },
        a: { position: { x: 100, y: 100 }, size: { width: 120, height: 80 }, collapsed: true, color: '#123456' },
        b: { position: { x: 300, y: 100 }, sections: { advanced: { collapsed: true } } },
        nested: { position: { x: 500, y: 100 } },
      },
      reroutes: { route: { position: { x: 270, y: 180 }, ext: { view: true } } },
      groups: { grp4: { id: 'grp4', title: 'Body', bounds: { x: 50, y: 50, width: 600, height: 300 }, color: '#abcdef' } },
      collapsedNets: ['split'],
    }
    const selection = {
      nodeIds: ['a', 'b', 'nested'],
      rerouteIds: ['route'],
      groupIds: ['grp4'],
    }
    const geometry = [
      { id: 'a', kind: 'node', x: 100, y: 100, width: 120, height: 80 },
      { id: 'b', kind: 'node', x: 300, y: 100, width: 140, height: 80 },
      { id: 'nested', kind: 'node', x: 500, y: 100, width: 140, height: 80 },
      { id: 'route', kind: 'reroute', x: 270, y: 180, width: 0, height: 0 },
      { id: 'grp4', kind: 'group', x: 50, y: 50, width: 600, height: 300 },
    ]
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(l4ExtractInvocation(initial, selection, geometry))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.g0).toMatchObject({
      nodes: {
        n0: { mode: 'muted', values: { dormant: 7 }, dynamic: initial.graphs.root!.nodes.a!.dynamic },
        n1: { mode: 'bypassed' },
        n2: { type: '#child', values: { promoted: 3 } },
      },
      reroutes: { r3: { id: 'r3', ext: { route: true } } },
    })
    expect(session.doc.graphs.g0!.boundary!.inputs).toEqual(expect.arrayContaining([
      expect.objectContaining({ binds: expect.objectContaining({ node: 'n0', port: 'family.m9.nested.name-a.leaf' }) }),
      expect.objectContaining({ binds: expect.objectContaining({ node: 'n0', port: 'tapInput' }) }),
    ]))
    expect(session.doc.view.graphs.g0).toMatchObject({
      nodes: { n0: { collapsed: true, color: '#123456' }, n1: { sections: { advanced: { collapsed: true } } } },
      reroutes: { r3: { ext: { view: true } } },
      groups: { grp0: { id: 'grp0', title: 'Body', color: '#abcdef' } },
      groupSeq: 1,
      collapsedNets: [expect.any(String)],
    })
    expect(session.doc.view.graphs.root!.collapsedNets).toEqual(['split'])
    expect(session.doc.view.graphs.root!.groupSeq).toBe(5)
    expect(session.doc.view.graphs.root!.nodes.n30!.position).toEqual({ x: 350, y: 200 })
    expect(checkDocument(session.doc).filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc.view.graphs.root!.groups!.grp4).toBeDefined()
    expect(session.doc.view.graphs.root!.groupSeq).toBe(5)
  })

  it('keeps an unselected group in the parent and warns when extraction empties it', () => {
    const initial = document(graph({
      nodes: { only: { id: 'only' as never, type: 'Only', values: {} } },
      links: {}, nets: {}, nextOrdinal: 20,
    })) as MutableDocument
    initial.view.graphs.root = {
      nodes: { only: { position: { x: 10, y: 10 } } },
      groups: { left: { id: 'left', title: 'Left behind', bounds: { x: 0, y: 0, width: 100, height: 100 } } },
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(l4ExtractInvocation(initial, { nodeIds: ['only'] }, [
      { id: 'only', kind: 'node', x: 10, y: 10, width: 40, height: 40 },
    ]))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.extract.groupEmptied')
    expect(session.doc.view.graphs.root!.groups!.left).toBeDefined()
    expect(session.doc.view.graphs.g0!.groups).toBeUndefined()
  })

  it('forwards a promoted enclosing boundary through the new occurrence', () => {
    const root = graph({ nodes: { shell: { id: 'shell' as never, type: '#body', values: {} } }, links: {}, nets: {} })
    const body = graph({
      id: 'body' as never,
      name: 'Body',
      nodes: { move: { id: 'move' as never, type: 'Move', values: { widget: 9 } } },
      links: {}, nets: {}, nextOrdinal: 4,
      boundary: {
        inputs: [
          { id: 'widget', displayName: 'Widget label', binds: { kind: 'port', node: 'move' as never, port: 'widget' as never }, promoted: true },
        ],
        outputs: [],
      },
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { shell: {} } }
    initial.view.graphs.body = { nodes: { move: { position: { x: 20, y: 30 } } } }
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(l4ExtractInvocation(initial, { nodeIds: ['move'] }, [
      { id: 'move', kind: 'node', x: 20, y: 30, width: 100, height: 60 },
    ], 'body', ['shell']))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.g0!.boundary).toEqual({
      inputs: [
        { id: 'widget', displayName: 'Widget label', binds: { kind: 'port', node: 'n0', port: 'widget' }, promoted: true },
      ],
      outputs: [],
    })
    expect(session.doc.graphs.body!.boundary).toEqual({
      inputs: [
        { id: 'widget', displayName: 'Widget label', binds: { kind: 'port', node: 'n4', port: 'widget' }, promoted: true },
      ],
      outputs: [],
    })
    expect(session.doc.graphs.body!.nodes.n4!.values).toEqual({})
  })

  it.each([
    {
      name: 'selected reroute crossing',
      selection: { nodeIds: ['inside'], rerouteIds: ['route'] },
      links: { crossing: link('crossing', port('outside', 'out'), { reroute: 'route' as never }) },
      reroutes: { route: { id: 'route' as never } },
      geometry: [
        { id: 'inside', kind: 'node', x: 0, y: 0, width: 100, height: 60 },
        { id: 'route', kind: 'reroute', x: 120, y: 20, width: 0, height: 0 },
      ],
      code: 'subgraph.extract.structuralCutUnsupported',
    },
  ])('handles the whole operation atomically for $name', ({ selection, links, reroutes, geometry, code }) => {
    const initial = document(graph({ links, reroutes }))
    const session = createLocalSession(initial, coreCommandRegistry())
    const before = session.doc
    const outcome = session.dispatch(l4ExtractInvocation(initial, selection, geometry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.diagnostics[0]!.code).toBe(code)
      expect(outcome.diagnostics[0]!.refs?.[0]?.graphId).toBe('root')
    }
    expect(session.doc).toBe(before)
  })
})

describe('subgraph lifecycle cut matrix', () => {

  it('names boundaries globally in canonical cut order with exact ports, fallbacks, and collisions', () => {
    const planned = planBoundaryNames([
      { side: 'output', base: 'same', orderKey: 'b' },
      { side: 'input', base: '', orderKey: 'b' },
      { side: 'input', base: 'same', orderKey: 'a' },
      { side: 'output', base: '', orderKey: 'a' },
      { side: 'input', base: 'same', orderKey: 'c' },
    ])
    expect(planned.map((candidate) => candidate.id)).toEqual(['same_3', 'input', 'same', 'output', 'same_2'])
  })

})

const flattenDocument = (): MutableDocument => {
  const root = graph({
    nodes: {
      source: { id: 'source' as never, type: 'Source', values: {} },
      occurrence: { id: 'occurrence' as never, type: '#body', values: {} },
      survivor: { id: 'survivor' as never, type: '#body', values: {} },
      consumer: { id: 'consumer' as never, type: 'Consumer', values: {} },
      outer: { id: 'outer' as never, type: 'Outer', values: {} },
    },
    links: {
      incoming: { ...link('incoming', port('source', 'out'), port('occurrence', 'input')), ext: { delivery: 1 } },
      outgoing: link('outgoing', port('occurrence', 'output'), port('consumer', 'in')),
      tap: link('tap', { node: 'occurrence' as never, tap: 'input' as never }, port('consumer', 'tap')),
    },
    nets: {
      incomingNet: {
        id: 'incomingNet' as never, name: 'Incoming', source: port('source', 'net'),
        sinks: [port('outer', 'net'), port('occurrence', 'netInput')],
      },
      outgoingNet: {
        id: 'outgoingNet' as never, name: 'Outgoing', source: port('occurrence', 'output'),
        sinks: [port('consumer', 'net')],
      },
    },
    boundary: {
      inputs: [
        {
          id: 'outerPrimary',
          binds: { kind: 'port', node: 'occurrence' as never, port: 'input' as never },
          alsoBinds: [{ kind: 'port', node: 'outer' as never, port: 'after' as never }],
        },
        {
          id: 'outerAdditional',
          binds: { kind: 'port', node: 'outer' as never, port: 'before' as never },
          alsoBinds: [
            { kind: 'port', node: 'occurrence' as never, port: 'input' as never },
            { kind: 'port', node: 'outer' as never, port: 'after2' as never },
          ],
        },
      ],
      outputs: [{ id: 'outerOutput', binds: { kind: 'port', node: 'occurrence' as never, port: 'output' as never } }],
    },
    nextOrdinal: 100,
  })
  const body = graph({
    id: 'body' as never,
    name: 'Body',
    nodes: {
      a: { id: 'a' as never, type: '#child', values: { keep: 1 }, ext: { node: true } },
      b: { id: 'b' as never, type: 'BodyNode', values: {} },
    },
    links: { internal: { ...link('internal', port('a', 'out'), port('b', 'mid')), ext: { inner: true } } },
    nets: { internalNet: { id: 'internalNet' as never, name: 'Inner', source: port('a', 'net'), sinks: [port('b', 'net')] } },
    reroutes: { reroute: { id: 'reroute' as never, ext: { r: 1 } } },
    boundary: {
      inputs: [
        {
          id: 'input', promoted: true,
          binds: { kind: 'port', node: 'a' as never, port: 'in' as never },
          alsoBinds: [{ kind: 'port', node: 'b' as never, port: 'other' as never }],
        },
        {
          id: 'netInput', binds: { kind: 'port', node: 'a' as never, port: 'netIn' as never },
          alsoBinds: [{ kind: 'port', node: 'b' as never, port: 'netOther' as never }],
        },
      ],
      outputs: [{ id: 'output', binds: { kind: 'port', node: 'b' as never, port: 'out' as never } }],
    },
    nextOrdinal: 20,
  })
  const child = graph({ id: 'child' as never, name: 'Child', nodes: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 0 })
  const doc = document(root) as MutableDocument
  doc.graphs.body = body
  doc.graphs.child = child
  doc.view.graphs.root = {
    nodes: {
      source: { position: { x: 0, y: 0 } },
      occurrence: { position: { x: 450, y: 250 }, size: { width: 100, height: 100 }, collapsed: true, color: '#fff' },
      survivor: { position: { x: 800, y: 0 } }, consumer: {}, outer: {},
    },
    groups: { grp4: { id: 'grp4', title: 'Existing', bounds: { x: 0, y: 0, width: 10, height: 10 } } },
    groupSeq: 5,
    collapsedNets: ['incomingNet'],
  }
  doc.view.graphs.body = {
    nodes: {
      a: { position: { x: 0, y: 0 }, color: '#a' },
      b: { position: { x: 200, y: 100 }, collapsed: true },
    },
    reroutes: { reroute: { position: { x: 50, y: 20 }, ext: { view: true } } },
    groups: { innerGroup: { id: 'innerGroup', title: 'Inner', bounds: { x: -20, y: -20, width: 300, height: 200 }, ext: { group: true } } },
    groupSeq: 1,
    collapsedNets: ['internalNet'],
  }
  doc.view.graphs.child = { nodes: {} }
  return doc
}

const flattenSchema = (type: string, items: readonly any[]) => ({
    type, displayName: type, category: 'test', source: 'v3' as const, body: items, isOutputNode: false,
})
const flattenSchemas: Record<string, any> = {
    '#child': flattenSchema('#child', [
      { kind: 'input', id: 'in', type: { kind: 'concrete', name: 'X' }, optional: true, widget: { widgetType: 'INT', options: {}, controller: 'after_generate' } },
      { kind: 'input', id: 'netIn', type: { kind: 'concrete', name: 'X' }, optional: true },
      { kind: 'output', id: 'out', type: { kind: 'concrete', name: 'X' } },
      { kind: 'output', id: 'net', type: { kind: 'concrete', name: 'X' } },
    ]),
    BodyNode: flattenSchema('BodyNode', [
      ...['in', 'netIn', 'other', 'netOther', 'mid', 'net', 'tapTarget'].map((id) => ({ kind: 'input', id, type: { kind: 'concrete', name: 'X' }, optional: true })),
      ...['out', 'net', 'driver'].map((id) => ({ kind: 'output', id, type: { kind: 'concrete', name: 'X' } })),
    ]),
}
const flattenResolver = (type: string) => {
  const schema = flattenSchemas[type]
  return schema === undefined ? undefined : structuredClone(schema)
}
const trustedFlattenSession = (doc: WorkflowDocument, resolver = flattenResolver) =>
  createRawLocalSession(doc, coreCommandRegistry(), { schemaResolverFor: () => resolver })

const flattenInvocation = (doc: WorkflowDocument, instancePath: readonly string[] = []) => {
  const schemaPlan = planFlattenBoundaryRoutes(doc.graphs.body!, flattenResolver, doc.graphs.root!.nodes.occurrence!, doc.graphs.root!)
  const owner = { instancePath: instancePath as never, node: 'occurrence' as never }
  const occurrencePlan = planFlattenOccurrenceTopology(doc, flattenResolver, owner).plan
  const occurrenceTopologyPlanDigest = occurrencePlan === undefined ? undefined : lifecycleCanonicalHash(occurrencePlan)
  return {
    command: 'subgraph.flatten',
    params: {
    graphId: 'root',
    instancePath,
    nodeId: 'occurrence',
    placementCenter: { x: 500, y: 300 },
    resolvedGeometry: {
      occurrence: { id: 'occurrence', kind: 'node', x: 450, y: 250, width: 100, height: 100 },
      body: [
        { id: 'a', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
        { id: 'b', kind: 'node', x: 200, y: 100, width: 100, height: 80 },
        { id: 'reroute', kind: 'reroute', x: 50, y: 20, width: 0, height: 0 },
        { id: 'innerGroup', kind: 'group', x: -20, y: -20, width: 300, height: 200 },
      ],
    },
      boundaryPlan: schemaPlan.boundaryPlan as unknown as Json,
      statePlan: schemaPlan.statePlan as unknown as Json,
      schemaSnapshot: schemaPlan.schemaSnapshot as unknown as Json,
      schemaPlanDigest: schemaPlan.schemaPlanDigest,
      selectionFingerprint: lifecycleFlattenFingerprint(doc, 'root', 'occurrence', {
        boundaryPlan: schemaPlan.boundaryPlan,
        statePlan: schemaPlan.statePlan,
        schemaPlanDigest: schemaPlan.schemaPlanDigest,
        ...(occurrencePlan !== undefined ? { occurrenceTopologyPlan: occurrencePlan, occurrenceTopologyPlanDigest } : {}),
      })!,
      ...(occurrencePlan !== undefined ? { occurrenceTopologyPlan: occurrencePlan, occurrenceTopologyPlanDigest } : {}),
    },
  } as any
}

const refreshFlattenFingerprint = (doc: WorkflowDocument, invocation: any): void => {
  invocation.params.selectionFingerprint = lifecycleFlattenFingerprint(
    doc,
    invocation.params.graphId,
    invocation.params.nodeId,
    invocation.params.statePlan === undefined
      ? invocation.params.boundaryPlan
      : {
          boundaryPlan: invocation.params.boundaryPlan,
          statePlan: invocation.params.statePlan,
          schemaPlanDigest: invocation.params.schemaPlanDigest,
        },
  )
}

const refreshFlattenSchemaDigest = (invocation: any): void => {
  invocation.params.schemaPlanDigest = flattenSchemaPlanDigest(
    invocation.params.schemaSnapshot,
    invocation.params.boundaryPlan,
    invocation.params.statePlan,
  )
}

describe('subgraph.flatten trusted-dispatch authorization', () => {
  it('preserves authored menus when flattening a body node', () => {
    const initial = flattenDocument()
    const dynamic = { choice: { options: ['duplicate', 'duplicate', false, 0] }, empty: { options: [] } }
    initial.graphs.body.nodes.b.dynamic = dynamic
    const invocation = flattenInvocation(initial)
    expect(invocation.params.statePlan.status, JSON.stringify(invocation.params.statePlan)).toBe('ready')
    const session = trustedFlattenSession(initial)
    const result = session.dispatch(invocation)
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    const copied = Object.values(session.doc.graphs.root!.nodes).find((node) => node.type === 'BodyNode')!
    expect(copied.dynamic).toEqual(dynamic)
    expect(session.doc.graphs.body!.nodes.b!.dynamic).toEqual(dynamic)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.root!.nodes.occurrence).toEqual(initial.graphs.root.nodes.occurrence)
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.root!.nodes[copied.id]!.dynamic).toEqual(dynamic)
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])('preserves junction fanout, enclosing bindings and values while flattening (linked=%s, overlay=%s)', (linked, overlay) => {
    const initial = flattenDocument()
    initial.graphs.body.nodes.a.type = 'BodyNode'
    initial.graphs.body.boundary!.inputs[0]!.binds = { kind: 'port', node: 'a' as never, port: 'in' as never, viaReroute: 'reroute' as never }
    delete initial.graphs.body.boundary!.inputs[0]!.alsoBinds
    initial.graphs.body.boundary!.inputs[1]!.binds = { kind: 'port', node: 'a' as never, port: 'netIn' as never, viaReroute: 'netJunction' as never }
    delete initial.graphs.body.boundary!.inputs[1]!.alsoBinds
    initial.graphs.body.reroutes.netJunction = { id: 'netJunction' as never }
    initial.graphs.body.links.fanA = link('fanA', { reroute: 'reroute' as never }, port('a', 'in'))
    initial.graphs.body.links.fanB = link('fanB', { reroute: 'reroute' as never }, port('b', 'other'))
    initial.graphs.body.links.netFanA = link('netFanA', { reroute: 'netJunction' as never }, port('a', 'netIn'))
    initial.graphs.body.links.netFanB = link('netFanB', { reroute: 'netJunction' as never }, port('b', 'netOther'))
    initial.graphs.root.nodes.occurrence.values = { input: 23 }
    initial.graphs.root.nodes.survivor.values = { input: 47 }
    delete initial.graphs.root.links.tap
    initial.graphs.root.boundary!.inputs = []
    if (!linked) {
      delete initial.graphs.root.links.incoming
      delete initial.graphs.root.nets.incomingNet
      initial.graphs.root.boundary!.inputs = [{ id: 'outerInput', binds: { kind: 'port', node: 'occurrence' as never, port: 'input' as never } }]
    }
    if (overlay) initial.occurrenceTopologies = {
      occurrence: { owner: { instancePath: [], node: 'occurrence' as never }, bodyGraph: 'body' as never, links: {}, nextOrdinal: 1 },
    }
    const resolver = (type: string) => type === 'BodyNode'
      ? { ...flattenSchemas.BodyNode, body: flattenSchemas.BodyNode.body.map((item: any) => item.kind === 'input' && ['in', 'other'].includes(item.id)
        ? { ...item, widget: { widgetType: 'INT', options: { default: 5 } } } : item) }
      : ['Source', 'Consumer', 'Outer'].includes(type) ? flattenSchema(type, [
        ...['in', 'tap', 'net', 'after', 'before', 'after2'].map((id) => ({ kind: 'input', id, optional: true, type: { kind: 'concrete', name: 'X' } })),
        ...['out', 'net'].map((id) => ({ kind: 'output', id, type: { kind: 'concrete', name: 'X' } })),
      ]) : flattenResolver(type)
    const compiledBefore = compile({ document: initial, revision: 0, resolve: resolver, scope: { kind: 'full' }, connection: asConnectionId('junction-before'), schemaHash: 'junction' })
    expect(compiledBefore.ok, JSON.stringify(!compiledBefore.ok && compiledBefore.diagnostics)).toBe(true)
    const invocation = flattenInvocation(initial)
    Object.assign(invocation.params, planFlattenBoundaryRoutes(initial.graphs.body, resolver, initial.graphs.root.nodes.occurrence, initial.graphs.root))
    invocation.params.resolvedGeometry.body.push({ id: 'netJunction', kind: 'reroute', x: 90, y: 70, width: 0, height: 0 })
    refreshFlattenFingerprint(initial, invocation)
    if (overlay) invocation.params.selectionFingerprint = lifecycleFlattenFingerprint(initial, 'root', 'occurrence', {
      boundaryPlan: invocation.params.boundaryPlan, statePlan: invocation.params.statePlan,
      schemaPlanDigest: invocation.params.schemaPlanDigest,
      occurrenceTopologyPlan: invocation.params.occurrenceTopologyPlan,
      occurrenceTopologyPlanDigest: invocation.params.occurrenceTopologyPlanDigest,
    })
    const session = trustedFlattenSession(initial, resolver)
    const outcome = session.dispatch(invocation)
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    const root = session.doc.graphs.root!
    const junction = Object.values(root.links).find((entry) => 'port' in entry.to && entry.to.node === 'n100' && entry.to.port === 'in')!.from
    const netJunction = Object.values(root.links).find((entry) => 'port' in entry.to && entry.to.node === 'n100' && entry.to.port === 'netIn')!.from
    expect(junction).toHaveProperty('reroute')
    expect(netJunction).toHaveProperty('reroute')
    expect(Object.values(root.links).filter((entry) => JSON.stringify(entry.from) === JSON.stringify(junction))).toHaveLength(2)
    expect(root.nodes.n100!.values.in).toBe(23)
    expect(root.nodes.n101!.values.other).toBe(23)
    expect(root.nodes.survivor!.values.input).toBe(47)
    const compiledAfter = compile({ document: session.doc, revision: 1, resolve: resolver, scope: { kind: 'full' }, connection: asConnectionId('junction-after'), schemaHash: 'junction' })
    expect(compiledAfter.ok, JSON.stringify(!compiledAfter.ok && compiledAfter.diagnostics)).toBe(true)
    if (compiledBefore.ok && compiledAfter.ok) {
      expect(compiledBefore.artifact.prompt['occurrence.a']!.inputs.in).toEqual(linked ? ['source', 0] : 23)
      expect(compiledBefore.artifact.prompt['occurrence.b']!.inputs.other).toEqual(linked ? ['source', 0] : 23)
      expect(compiledAfter.artifact.prompt.n100!.inputs.in).toEqual(linked ? ['source', 0] : 23)
      expect(compiledAfter.artifact.prompt.n101!.inputs.other).toEqual(linked ? ['source', 0] : 23)
      expect(compiledAfter.artifact.prompt['survivor.a']!.inputs.in).toBe(47)
      expect(compiledAfter.artifact.prompt.n100!.inputs.netIn).toEqual(linked ? ['source', 1] : undefined)
      expect(compiledAfter.artifact.prompt.n101!.inputs.netOther).toEqual(linked ? ['source', 1] : undefined)
    }
    if (linked) {
      expect(Object.values(root.links).find((entry) => 'port' in entry.from && entry.from.node === 'source' && entry.from.port === 'out')?.to).toEqual(junction)
      expect(Object.values(root.links).find((entry) => 'port' in entry.from && entry.from.node === 'source' && entry.from.port === 'net')?.to).toEqual(netJunction)
      expect(root.nets.incomingNet!.sinks).toEqual([port('outer', 'net')])
    } else expect(root.boundary!.inputs[0]!.binds).toMatchObject({ node: 'n100', port: 'in', viaReroute: (junction as { reroute: string }).reroute })
    expect(checkDocument(session.doc).filter((entry) => entry.severity === 'error')).toEqual([])
    const after = JSON.stringify(session.doc)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.root!.nodes).toEqual(initial.graphs.root.nodes)
    expect(session.doc.graphs.root!.links).toEqual(initial.graphs.root.links)
    expect(session.doc.graphs.root!.nets).toEqual(initial.graphs.root.nets)
    expect(session.doc.graphs.root!.boundary).toEqual(initial.graphs.root.boundary)
    expect(session.doc.graphs.body).toEqual(initial.graphs.body)
    expect(session.redo()).toBe(true)
    expect(JSON.stringify(session.doc)).toBe(after)
  })

  it('T8 drift stale', () => {
    const initial = flattenDocument()
    const invocation = flattenInvocation(initial)
    const drifted = (type: string) => {
      const schema = flattenResolver(type)
      return schema === undefined ? undefined : { ...schema, displayName: `${schema.displayName} drifted` }
    }
    const session = trustedFlattenSession(initial, drifted)
    const before = session.doc
    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.flatten.schemaPlanStale')
    expect(session.doc).toBe(before)
  })

  it('T9 alias canonical success', () => {
    const initial = flattenDocument()
    initial.graphs.body.nodes.a.type = 'AuthoredAlias'
    const canonical = { ...flattenResolver('#child')!, type: 'CanonicalTarget' }
    const resolver = (type: string) => type === 'AuthoredAlias' ? structuredClone(canonical) : flattenResolver(type)
    const plan = planFlattenBoundaryRoutes(initial.graphs.body, resolver, initial.graphs.root.nodes.occurrence, initial.graphs.root)
    const invocation = flattenInvocation(initial) as any
    Object.assign(invocation.params, plan)
    refreshFlattenFingerprint(initial, invocation)
    const outcome = trustedFlattenSession(initial, resolver).dispatch(invocation)
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
  })

})

describe('subgraph.flatten L5-L6 core command', () => {
  it('flattens an output boundary back to the exact inner widget tap endpoint', () => {
    const initial = flattenDocument()
    initial.graphs.body!.boundary!.outputs = [{
      id: 'output',
      binds: { kind: 'widgetTap', node: 'a' as never, tap: 'in' as never },
    }]
    delete initial.graphs.root!.nets.outgoingNet
    const session = trustedFlattenSession(initial)

    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.links.outgoing!.from).toEqual({ node: 'n100', tap: 'in' })
    expect(session.doc.graphs.root!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'n100', tap: 'in' })
    expect(checkDocument(session.doc)).toEqual([])
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.body!.boundary!.outputs[0]!.binds).toEqual({ kind: 'widgetTap', node: 'a', tap: 'in' })
  })

  it('refuses atomically when flattening would make a named net source a widgetTap', () => {
    const initial = flattenDocument()
    initial.graphs.body!.boundary!.outputs = [{
      id: 'output',
      binds: { kind: 'widgetTap', node: 'a' as never, tap: 'in' as never },
    }]
    const session = trustedFlattenSession(initial)
    const before = session.doc

    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.diagnostics[0]!.code).toBe('subgraph.lifecycle.boundaryUnresolved')
    expect(session.doc).toBe(before)
    expect(session.canUndo).toBe(false)
  })

  it('materializes the selected occurrence effective topology while preserving a sibling overlay', () => {
    const initial = flattenDocument()
    initial.graphs.root.nodes = {
      occurrence: initial.graphs.root.nodes.occurrence,
      sibling: { id: 'sibling' as never, type: '#body', values: {} },
    }
    initial.graphs.root.links = {}
    initial.graphs.root.nets = {}
    delete initial.graphs.root.boundary
    initial.view.graphs.root.nodes = {
      occurrence: initial.view.graphs.root.nodes.occurrence,
      sibling: { position: { x: 900, y: 300 } },
    }
    initial.graphs.body.nodes.a.type = 'BodyNode'
    initial.graphs.body.links = {
      shared: link('shared', port('a', 'out'), port('b', 'mid')),
    }
    initial.graphs.body.nets = {}
    ;(initial as any).occurrenceTopologies = {
      occurrence: {
        owner: { instancePath: [], node: 'occurrence' }, bodyGraph: 'body', nextOrdinal: 8,
        links: {
          l7: {
            id: 'l7',
            from: { kind: 'body', endpoint: port('b', 'driver') },
            to: { kind: 'body', endpoint: port('b', 'mid') },
            ext: { occurrence: true },
          },
        },
        suppressedDeliveries: [{ kind: 'link', linkId: 'shared' }],
      },
      sibling: {
        owner: { instancePath: [], node: 'sibling' }, bodyGraph: 'body', nextOrdinal: 4,
        links: {
          l3: {
            id: 'l3',
            from: { kind: 'body', endpoint: port('b', 'driver') },
            to: { kind: 'body', endpoint: port('b', 'mid') },
          },
        },
        suppressedDeliveries: [{ kind: 'link', linkId: 'shared' }],
      },
    }
    const siblingTopologyBytes = JSON.stringify(initial.occurrenceTopologies!.sibling)
    const before = compile({
      document: initial, revision: 1, resolve: flattenResolver, scope: { kind: 'full' },
      connection: asConnectionId('occurrence-flatten-before'), schemaHash: 'occurrence-flatten',
    })
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const session = trustedFlattenSession(initial)
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.occurrenceTopologies?.occurrence).toBeUndefined()
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(siblingTopologyBytes)
    expect(Object.values(session.doc.graphs.root!.links).find((candidate) =>
      'node' in candidate.from && 'port' in candidate.from && candidate.from.node === 'n101' && candidate.from.port === 'driver' &&
      'node' in candidate.to && 'port' in candidate.to && candidate.to.node === 'n101' && candidate.to.port === 'mid')?.ext).toEqual({ occurrence: true })
    expect(Object.values(session.doc.graphs.root!.links).some((candidate) =>
      'node' in candidate.from && candidate.from.node === 'n100' &&
      'node' in candidate.to && 'port' in candidate.to && candidate.to.node === 'n101' && candidate.to.port === 'mid')).toBe(false)
    const after = compile({
      document: session.doc, revision: 1, resolve: flattenResolver, scope: { kind: 'full' },
      connection: asConnectionId('occurrence-flatten-after'), schemaHash: 'occurrence-flatten',
    })
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(before.artifact.prompt['occurrence.b']!.inputs).toEqual({ mid: ['occurrence.b', 2] })
      expect(after.artifact.prompt.n101!.inputs).toEqual({ mid: ['n101', 2] })
    }
    expect(session.undo()).toBe(true)
    expect(session.doc.occurrenceTopologies?.occurrence?.links.l7).toBeDefined()
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(siblingTopologyBytes)
    expect(session.redo()).toBe(true)
    expect(session.doc.occurrenceTopologies?.occurrence).toBeUndefined()
    expect(JSON.stringify(session.doc.occurrenceTopologies?.sibling)).toBe(siblingTopologyBytes)
  })

  it('applies projected parent link and net-sink suppressions during materialization', () => {
    const initial = flattenDocument()
    initial.graphs.body.nodes.a.type = 'BodyNode'
    delete initial.graphs.root.links.tap
    ;(initial as any).occurrenceTopologies = {
      occurrence: {
        owner: { instancePath: [], node: 'occurrence' }, bodyGraph: 'body', links: {}, nextOrdinal: 1,
      },
    }
    const unsuppressed = effectiveOccurrenceTopology(initial, flattenResolver, { instancePath: [], node: 'occurrence' as never })
    const incomingLink = unsuppressed.projectedParentLinks.find((link) =>
      link.identity.kind === 'parentLeg' && link.identity.delivery.kind === 'link' && link.identity.delivery.linkId === 'incoming')!
    const incomingNet = unsuppressed.projectedParentLinks.find((link) =>
      link.identity.kind === 'parentLeg' && link.identity.delivery.kind === 'netSink' && link.identity.delivery.netId === 'incomingNet')!
    if (incomingLink.identity.kind !== 'parentLeg' || incomingNet.identity.kind !== 'parentLeg') throw new Error('expected projected parent legs')
    ;(initial as any).occurrenceTopologies.occurrence.suppressedDeliveries = [
      { kind: 'projectedLeg', delivery: incomingLink.identity.delivery, route: incomingLink.identity.route },
      { kind: 'projectedLeg', delivery: incomingNet.identity.delivery, route: incomingNet.identity.route },
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    const planned = planFlattenOccurrenceTopology(initial, flattenResolver, { instancePath: [], node: 'occurrence' as never })
    expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
    expect(planned.plan).toBeDefined()
    const session = trustedFlattenSession(initial)
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(Object.values(session.doc.graphs.root!.links).some((candidate) =>
      'node' in candidate.from && candidate.from.node === 'source' &&
      'node' in candidate.to && candidate.to.node === 'n100')).toBe(false)
    expect(session.doc.graphs.root!.nets.incomingNet!.sinks).toEqual([port('outer', 'net')])
  })

  it('refuses unsupported occurrence overlay flatten contexts by name', () => {
    const extension = flattenDocument()
    ;(extension as any).occurrenceTopologies = {
      occurrence: {
        owner: { instancePath: [], node: 'occurrence' }, bodyGraph: 'body', links: {}, nextOrdinal: 1,
        ext: { pack: true },
      },
    }
    const extensionOutcome = trustedFlattenSession(extension).dispatch(flattenInvocation(extension))
    expect(extensionOutcome.ok).toBe(false)
    if (!extensionOutcome.ok) expect(extensionOutcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(extensionOutcome.diagnostics))
      .toContain('subgraph.flatten.occurrenceTopologyExtensionUnsupported')

    const definition = coreCommandRegistry().get('subgraph.flatten')!
    const validate = (
      doc: WorkflowDocument,
      invocation: ReturnType<typeof flattenInvocation>,
      expected: string,
    ) => {
      const stale = structuredClone(invocation.params) as Record<string, Json>
      stale.occurrenceTopologyPlan = { version: 'stale' }
      for (const context of [{ kind: 'initial' as const }, { kind: 'shared-replay' as const }]) {
        expect(definition.validateDispatch!(doc, stale as Json, context).map((diagnostic) => diagnostic.code))
          .toContain(expected)
      }
    }
    validate(extension, flattenInvocation(extension), 'subgraph.flatten.occurrenceTopologyExtensionUnsupported')

    const drilled = flattenDocument()
    const wrapper = graph({
      id: 'wrapper' as never,
      nodes: { outer: { id: 'outer' as never, type: '#root', values: {} } },
      boundary: { inputs: [], outputs: [] },
    })
    drilled.graphs.wrapper = wrapper
    drilled.view.graphs.wrapper = { nodes: { outer: { position: { x: 0, y: 0 } } } }
    ;(drilled as { root: string }).root = 'wrapper'
    const drilledOwner = { instancePath: ['outer' as never], node: 'occurrence' as never }
    ;(drilled as any).occurrenceTopologies = {
      [occurrenceKey(drilledOwner)]: {
        owner: drilledOwner, bodyGraph: 'body', links: {}, nextOrdinal: 1,
      },
    }
    const drilledInvocation = flattenInvocation(drilled, ['outer'])
    ;(drilledInvocation.params as Record<string, Json>).occurrenceTopologyPlan = { version: 'stale' }
    const drilledOutcome = trustedFlattenSession(drilled).dispatch(drilledInvocation)
    expect(drilledOutcome.ok).toBe(false)
    if (!drilledOutcome.ok) expect(drilledOutcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(drilledOutcome.diagnostics))
      .toContain('subgraph.flatten.occurrenceTopologyContextUnsupported')
    validate(drilled, flattenInvocation(drilled, ['outer']), 'subgraph.flatten.occurrenceTopologyContextUnsupported')

    const descendant = flattenDocument()
    const descendantOwner = { instancePath: ['occurrence' as never], node: 'a' as never }
    ;(descendant as any).occurrenceTopologies = {
      [occurrenceKey(descendantOwner)]: {
        owner: descendantOwner, bodyGraph: 'child', links: {}, nextOrdinal: 1,
      },
    }
    const descendantOutcome = trustedFlattenSession(descendant).dispatch(flattenInvocation(descendant))
    expect(descendantOutcome.ok).toBe(false)
    if (!descendantOutcome.ok) expect(descendantOutcome.diagnostics.map((diagnostic) => diagnostic.code))
      .toContain('subgraph.flatten.occurrenceTopologyDescendantUnsupported')
  })

  it('clones every body construct, expands plain routes, retains nesting and definition, and places exact view state', () => {
    const initial = flattenDocument()
    initial.view.graphs.root = { ...initial.view.graphs.root!, guideNets: ['incomingNet'] }
    initial.view.graphs.body = { ...initial.view.graphs.body!, guideNets: ['internalNet'] }
    const immutableBody = structuredClone(initial.graphs.body)
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.body).toEqual(immutableBody)
    expect(session.doc.graphs.root!.nodes.occurrence).toBeUndefined()
    expect(session.doc.graphs.root!.nodes.survivor!.type).toBe('#body')
    expect(session.doc.graphs.root!.nodes.n100).toEqual({ id: 'n100', type: '#child', values: { keep: 1, in: 0 }, controllers: { in: 'randomize' }, ext: { node: true } })
    expect(session.doc.graphs.root!.nodes.n101).toMatchObject({ id: 'n101', type: 'BodyNode' })
    expect(session.doc.graphs.root!.links.incoming).toEqual({
      id: 'incoming', from: port('source', 'out'), to: port('n100', 'in'), ext: { delivery: 1 },
    })
    expect(Object.values(session.doc.graphs.root!.links)).toContainEqual({
      id: 'l105', from: port('source', 'out'), to: port('n101', 'other'), ext: { delivery: 1 },
    })
    expect(session.doc.graphs.root!.links.outgoing!.from).toEqual(port('n101', 'out'))
    expect(session.doc.graphs.root!.links.tap!.from).toEqual({ node: 'n100', tap: 'in' })
    expect(session.doc.graphs.root!.nets.incomingNet!.sinks).toEqual([
      port('outer', 'net'), port('n100', 'netIn'), port('n101', 'netOther'),
    ])
    expect(session.doc.graphs.root!.nets.outgoingNet!.source).toEqual(port('n101', 'out'))
    expect(session.doc.graphs.root!.boundary!.inputs[0]!.binds).toEqual({ kind: 'port', ...port('n100', 'in') })
    expect(session.doc.graphs.root!.boundary!.inputs[0]!.alsoBinds).toEqual([
      { kind: 'port', ...port('n101', 'other') }, { kind: 'port', ...port('outer', 'after') },
    ])
    expect(session.doc.graphs.root!.boundary!.inputs[1]!.alsoBinds).toEqual([
      { kind: 'port', ...port('n100', 'in') }, { kind: 'port', ...port('n101', 'other') },
      { kind: 'port', ...port('outer', 'after2') },
    ])
    expect(session.doc.graphs.root!.boundary!.outputs[0]!.binds).toEqual({ kind: 'port', ...port('n101', 'out') })
    expect(session.doc.view.graphs.root!.nodes.n100).toEqual({ position: { x: 360, y: 220 }, color: '#a' })
    expect(session.doc.view.graphs.root!.nodes.n101).toEqual({ position: { x: 560, y: 320 }, collapsed: true })
    expect(session.doc.view.graphs.root!.nodes.occurrence).toBeUndefined()
    expect(session.doc.view.graphs.root!.groups!.grp5).toEqual({
      id: 'grp5', title: 'Inner', bounds: { x: 340, y: 200, width: 300, height: 200 }, ext: { group: true },
    })
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.doc.view.graphs.root!.collapsedNets).toEqual(['incomingNet', 'net104'])
    expect(session.doc.view.graphs.root!.guideNets).toEqual(['incomingNet', 'net104'])
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('drops display entries for parent nets that vanish during flatten', () => {
    const initial = flattenDocument()
    initial.graphs.root!.nets.strayNet = {
      id: 'strayNet' as never, name: 'Stray', source: port('outer', 'netOut'), sinks: [],
    }
    initial.view.graphs.root = {
      ...initial.view.graphs.root!,
      collapsedNets: ['incomingNet', 'strayNet'],
      guideNets: ['strayNet'],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    const outcome = session.dispatch(flattenInvocation(initial))
    expect(outcome.ok).toBe(true)
    expect(session.doc.graphs.root!.nets.strayNet).toBeUndefined()
    expect(session.doc.view.graphs.root!.collapsedNets).toEqual(['incomingNet', 'net104'])
    expect(session.doc.view.graphs.root!.guideNets).toEqual([])
    expect(checkDocument(session.doc)).toEqual([])
  })

  it('copies body tag offsets onto the cloned nets while leaving the shared definition entries in place', () => {
    const initial = flattenDocument()
    const malformed = { graphId: 'body', netId: 'internalNet' }
    const sourceEntry = { graphId: 'body', netId: 'internalNet', role: 'source', offset: { x: 30, y: -10 } }
    const sinkEntry = { graphId: 'body', netId: 'internalNet', role: 'sink', to: { node: 'b', port: 'net' }, offset: { x: -25, y: 40 } }
    // Absolute geometry is body-graph world coordinates: meaningless in the
    // parent, so it is not copied.
    const absoluteEntry = { graphId: 'body', netId: 'internalNet', role: 'source', position: { x: 9, y: 9 } }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [sourceEntry, sinkEntry, absoluteEntry, malformed],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    // Body ids remap a -> n100, b -> n101, internalNet -> net104.
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      sourceEntry,
      sinkEntry,
      absoluteEntry,
      malformed,
      { graphId: 'root', netId: 'net104', role: 'source', offset: { x: 30, y: -10 } },
      { graphId: 'root', netId: 'net104', role: 'sink', to: { node: 'n101', port: 'net' }, offset: { x: -25, y: 40 } },
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([sourceEntry, sinkEntry, absoluteEntry, malformed])
  })

  it('moves parent tags anchored to the flattened occurrence onto the expanded endpoints', () => {
    const initial = flattenDocument()
    // The occurrence sits at (450,250); the expansion places a -> n100 at
    // (360,220) and b -> n101 at (560,320).
    const survivorSink = { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'outer', port: 'net' }, offset: { x: 1, y: 2 } }
    const occurrenceSink = { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'occurrence', port: 'netInput' }, offset: { x: 10, y: 20 } }
    const occurrenceSource = { graphId: 'root', netId: 'outgoingNet', role: 'source', offset: { x: -15, y: 5 } }
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [survivorSink, occurrenceSink, occurrenceSource],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    // The occurrence sink fans out to n100.netIn and n101.netOther; each copy
    // re-anchors so the tag keeps its on-screen point (460,270). The source
    // tag re-anchors to outgoingNet's new source n101 the same way (435,255).
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      survivorSink,
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n100', port: 'netIn' }, offset: { x: 100, y: 50 } },
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n101', port: 'netOther' }, offset: { x: -100, y: -50 } },
      { graphId: 'root', netId: 'outgoingNet', role: 'source', offset: { x: -125, y: -65 } },
    ])
    expect(session.undo()).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([survivorSink, occurrenceSink, occurrenceSource])
  })

  it('remaps an absolute parent tag on the flattened occurrence without moving it', () => {
    const initial = flattenDocument()
    ;(initial as unknown as { ext: Json }).ext = {
      'dinkster.netViews': [
        { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'occurrence', port: 'netInput' }, position: { x: 500, y: 300 } },
      ],
    }
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    expect(session.doc.ext?.['dinkster.netViews']).toEqual([
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n100', port: 'netIn' }, position: { x: 500, y: 300 } },
      { graphId: 'root', netId: 'incomingNet', role: 'sink', to: { node: 'n101', port: 'netOther' }, position: { x: 500, y: 300 } },
    ])
  })

  it('is one undo and redo with materialized state, clean allocator high-water marks, and retained orphan definition', () => {
    const initial = flattenDocument()
    initial.graphs.root!.nodes.occurrence!.values.input = 41
    delete initial.graphs.root!.nodes.survivor
    delete initial.view.graphs.root!.nodes.survivor
    const invocation = flattenInvocation(initial)
    const session = createLocalSession(initial, coreCommandRegistry())
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.revision).toBe(1)
    expect(session.doc.graphs.body).toBeDefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(106)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs.root!.nodes.occurrence).toBeDefined()
    expect(session.doc.graphs.body).toBeDefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(106)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.redo()).toBe(true)
    expect(session.doc.graphs.root!.nodes.occurrence).toBeUndefined()
    expect(session.doc.graphs.root!.nextOrdinal).toBe(106)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(6)
    expect(session.canRedo).toBe(false)
  })

  it('materializes one effective promoted value and controller onto primary and alsoBinds targets', () => {
    const initial = flattenDocument()
    initial.graphs.body!.nodes.a!.values.in = 7
    initial.graphs.body!.nodes.b!.values.other = 9
    initial.graphs.root!.nodes.occurrence!.values.input = 33
    initial.graphs.root!.nodes.occurrence!.controllers = { input: 'randomize' }
    const session = trustedFlattenSession(initial)

    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.n100!.values.in).toBe(33)
    expect(session.doc.graphs.root!.nodes.n101!.values.other).toBe(33)
    expect(session.doc.graphs.root!.nodes.n100!.controllers?.in).toBe('randomize')
    expect(session.doc.graphs.root!.nodes.n101!.controllers?.other).toBe('randomize')
  })

  it('resolves promoted value and controller ownership independently with explicit null authoritative', () => {
    const initial = flattenDocument()
    initial.graphs.body.nodes.a.values.in = 7
    initial.graphs.body.nodes.a.controllers = { in: 'fixed' }
    initial.graphs.body.nodes.b.values.other = 9
    initial.graphs.body.nodes.b.controllers = { other: 'decrement' }
    initial.graphs.root.nodes.occurrence.values.input = null
    const session = trustedFlattenSession(initial)

    expect(session.dispatch(flattenInvocation(initial)).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.n100!.values.in).toBeNull()
    expect(session.doc.graphs.root!.nodes.n101!.values.other).toBeNull()
    expect(session.doc.graphs.root!.nodes.n100!.controllers?.in).toBe('fixed')
    expect(session.doc.graphs.root!.nodes.n101!.controllers?.other).toBe('fixed')
  })

  it('keeps enclosing output unique-producer refusal named and byte-cursor atomic', () => {
    const initial = flattenDocument()
    initial.graphs.body.boundary.outputs[0].alsoBinds = [
      { kind: 'port', node: 'a', port: 'out' },
    ]
    const invocation = flattenInvocation(initial)
    const session = trustedFlattenSession(initial)
    const before = session.doc
    const beforeBytes = JSON.stringify(before)
    const beforeOrdinal = before.graphs.root!.nextOrdinal
    const beforeActorCursors = before.graphs.root!.actorCursors
    const beforeGroupSeq = before.view.graphs.root!.groupSeq

    const outcome = session.dispatch(invocation)

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(outcome.diagnostics)).toContain('subgraph.lifecycle.boundaryUnresolved')
    expect(session.doc).toBe(before)
    expect(JSON.stringify(session.doc)).toBe(beforeBytes)
    expect(session.doc.graphs.root!.nextOrdinal).toBe(beforeOrdinal)
    expect(session.doc.graphs.root!.actorCursors).toEqual(beforeActorCursors)
    expect(session.doc.view.graphs.root!.groupSeq).toBe(beforeGroupSeq)
  })

  it('preserves the compiled prompt across promoted value materialization', () => {
    const widgetSchema: any = {
      type: 'WidgetNode', displayName: 'WidgetNode', category: 'test', source: 'v3', isOutputNode: false,
      body: [{
        kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: {} },
      }],
    }
    const root = graph({
      nodes: { occurrence: { id: 'occurrence' as never, type: '#body', values: { input: 33 } } },
      nextOrdinal: 20,
    })
    const body = graph({
      id: 'body' as never,
      nodes: { inner: { id: 'inner' as never, type: 'WidgetNode', values: {} } },
      boundary: {
        inputs: [{ id: 'input', promoted: true, binds: { kind: 'port', node: 'inner' as never, port: 'value' as never } }],
        outputs: [],
      },
      nextOrdinal: 1,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { inner: { position: { x: 0, y: 0 } } } }
    const resolve = (type: string) => type === 'WidgetNode' ? widgetSchema : undefined
    const compileDoc = (doc: WorkflowDocument) => compile({
      document: doc,
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'l6-equivalence',
    })
    const before = compileDoc(initial)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'inner', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    const after = compileDoc(session.doc)
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(Object.values(after.artifact.prompt)[0]!.inputs).toEqual(Object.values(before.artifact.prompt)[0]!.inputs)
      expect(Object.values(after.artifact.prompt)[0]!.inputs.value).toBe(33)
    }
  })

  it('preserves nested definition-owned promoted fallback when the outer occurrence is absent', () => {
    const widgetSchema: any = {
      type: 'WidgetNode', displayName: 'WidgetNode', category: 'test', source: 'v3', isOutputNode: false,
      body: [{
        kind: 'input', id: 'value', type: { kind: 'concrete', name: 'INT' }, optional: false,
        widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' },
      }],
    }
    const child = graph({
      id: 'child' as never, name: 'Child',
      nodes: { leaf: { id: 'leaf' as never, type: 'WidgetNode', values: { value: 7 }, controllers: { value: 'fixed' } } },
      boundary: { inputs: [{ id: 'input', promoted: true, binds: { kind: 'port', node: 'leaf' as never, port: 'value' as never } }], outputs: [] },
    })
    const body = graph({
      id: 'body' as never, name: 'Body',
      nodes: { nested: { id: 'nested' as never, type: '#child', values: {} } },
      boundary: { inputs: [{ id: 'input', promoted: true, binds: { kind: 'port', node: 'nested' as never, port: 'input' as never } }], outputs: [] },
    })
    const root = graph({
      nodes: { occurrence: { id: 'occurrence' as never, type: '#body', values: {} } },
      nextOrdinal: 20,
    })
    const initial = document(root) as MutableDocument
    initial.graphs.body = body
    initial.graphs.child = child
    initial.view.graphs.root = { nodes: { occurrence: { position: { x: 0, y: 0 }, size: { width: 100, height: 80 } } } }
    initial.view.graphs.body = { nodes: { nested: { position: { x: 0, y: 0 } } } }
    initial.view.graphs.child = { nodes: { leaf: {} } }
    const resolve = (type: string): any => {
      if (type === 'WidgetNode') return widgetSchema
      if (type === '#child') return deriveBoundarySchema(child, resolve).schema
      if (type === '#body') return deriveBoundarySchema(body, resolve).schema
      return undefined
    }
    const before = compile({
      document: initial, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('nested-before'), schemaHash: 'nested-fallback',
    })
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    const plan = planFlattenBoundaryRoutes(body, resolve, root.nodes.occurrence!, root)
    expect(plan.statePlan.status).toBe('ready')
    if (plan.statePlan.status === 'ready') {
      expect(plan.statePlan.nodes[0]).toMatchObject({ values: { input: 7 }, controllers: { input: 'fixed' } })
    }
    const evidence = { boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest }
    const session = trustedFlattenSession(initial, resolve)
    const outcome = session.dispatch({
      command: 'subgraph.flatten',
      params: {
        graphId: 'root', instancePath: [], nodeId: 'occurrence', placementCenter: { x: 50, y: 40 },
        resolvedGeometry: {
          occurrence: { id: 'occurrence', kind: 'node', x: 0, y: 0, width: 100, height: 80 },
          body: [{ id: 'nested', kind: 'node', x: 0, y: 0, width: 140, height: 80 }],
        },
        boundaryPlan: plan.boundaryPlan as unknown as Json,
        statePlan: plan.statePlan as unknown as Json,
        schemaSnapshot: plan.schemaSnapshot as unknown as Json,
        schemaPlanDigest: plan.schemaPlanDigest,
        selectionFingerprint: lifecycleFlattenFingerprint(initial, 'root', 'occurrence', evidence)!,
      },
    })
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(session.doc.graphs.root!.nodes.n20).toMatchObject({ values: { input: 7 }, controllers: { input: 'fixed' } })
    const after = compile({
      document: session.doc, revision: 2, resolve, scope: { kind: 'full' },
      connection: asConnectionId('nested-after'), schemaHash: 'nested-fallback',
    })
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (before.ok && after.ok) {
      expect(Object.values(after.artifact.prompt)[0]!.inputs).toEqual(Object.values(before.artifact.prompt)[0]!.inputs)
    }
  })

  it('rewrites both ends of a promoted occurrence tap delivery before staged cycle checks', () => {
    const initial = flattenDocument()
    initial.graphs.body.boundary.inputs.push({
      id: 'tapTarget', binds: { kind: 'port', node: 'b', port: 'tapTarget' },
    })
    initial.graphs.root.links.crossTap = link(
      'crossTap',
      { node: 'occurrence' as never, tap: 'input' as never },
      port('occurrence', 'tapTarget'),
    )
    const invocation = flattenInvocation(initial)
    const session = trustedFlattenSession(initial)
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.root!.links.crossTap).toEqual({
      id: 'crossTap', from: { node: 'n100', tap: 'in' }, to: port('n101', 'tapTarget'),
    })

    const cyclic = flattenDocument()
    delete cyclic.graphs.root.links.incoming
    cyclic.graphs.root.links.tapCycle = link(
      'tapCycle',
      { node: 'occurrence' as never, tap: 'input' as never },
      port('occurrence', 'input'),
    )
    const cyclicSession = trustedFlattenSession(cyclic)
    const before = cyclicSession.doc
    const outcome = cyclicSession.dispatch(flattenInvocation(cyclic))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('doc.tap.cycle')
    expect(cyclicSession.doc).toBe(before)
  })

  it.each([
    { name: 'nonempty occurrence ext', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.ext = { pack: 1 }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.extensionStateUnsupported' },
    { name: 'body boundary ext', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.body.boundary.inputs[0].ext = { pack: 1 }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.boundaryExtensionUnsupported' },
    { name: 'bypassed shell', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.mode = 'bypassed'; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.modeUnsupported' },
    { name: 'region shell', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.region = { kind: 'map', elementPorts: ['input'] }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.flatten.regionUnsupported' },
    { name: 'missing required state plan with dormant state', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.values.netInput = 3; delete invocation.params.statePlan; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'missing required state plan with dynamic state', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nodes.occurrence.dynamic = { choice: { selected: 'x' } }; delete invocation.params.statePlan; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'ready state plan paired with unresolved route', mutate: (doc: MutableDocument, invocation: any) => { invocation.params.schemaSnapshot['#child'].body[0] = { kind: 'choice', id: 'in', options: [], shared: [], required: false }; invocation.params.boundaryPlan[0].route = 'unresolved'; refreshFlattenSchemaDigest(invocation); refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'schema snapshot digest mismatch', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.schemaSnapshot['#child'].body[0].tooltip = 'changed' }, code: 'params.invalid' },
    { name: 'malformed state plan coverage', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.statePlan.source.bodyNodes.pop() }, code: 'params.invalid' },
    { name: 'array-shaped route assertion', mutate: (doc: MutableDocument, invocation: any) => { invocation.params.boundaryPlan[0].route = ['plainWidget']; refreshFlattenFingerprint(doc, invocation) }, code: 'params.invalid' },
    { name: 'unpromoted boundary tap', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.body.boundary.inputs[0].promoted = false; Object.assign(invocation.params, (flattenInvocation(doc) as any).params) }, code: 'subgraph.flatten.stateUnresolved' },
    { name: 'durable mode-panel binding', mutate: (doc: MutableDocument, invocation: any) => { doc.surfaces = { panel: { id: 'panel', type: 'core.modePanel', config: { bindings: [{ kind: 'node', graphId: 'root', nodeId: 'occurrence' }] } } }; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.lifecycle.boundaryUnresolved' },
    { name: 'placement center mismatches occurrence geometry', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.placementCenter = { x: 999, y: 999 } }, code: 'subgraph.lifecycle.boundaryUnresolved' },
    { name: 'output without an inner producer', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.links.outgoing.from.port = 'missing'; Object.assign(invocation.params, (flattenInvocation(doc) as any).params) }, code: 'subgraph.flatten.stateUnresolved' },
    { name: 'non-occurrence target', mutate: (doc: MutableDocument) => { doc.graphs.root.nodes.occurrence.type = 'Plain' }, code: 'subgraph.flatten.notOccurrence' },
    { name: 'stale fingerprint', mutate: (doc: MutableDocument) => { doc.graphs.body.nodes.a.title = 'peer edit' }, code: 'subgraph.lifecycle.stalePlan' },
    { name: 'incomplete geometry', mutate: (_doc: MutableDocument, invocation: any) => { invocation.params.resolvedGeometry.body.pop() }, code: 'subgraph.lifecycle.boundaryUnresolved' },
    { name: 'exhausted ids', mutate: (doc: MutableDocument, invocation: any) => { doc.graphs.root.nextOrdinal = Number.MAX_SAFE_INTEGER; refreshFlattenFingerprint(doc, invocation) }, code: 'subgraph.lifecycle.idExhausted' },
  ])('refuses $name atomically as $code', ({ mutate, code }) => {
    const initial = flattenDocument()
    const invocation = flattenInvocation(initial) as any
    mutate(initial, invocation)
    const session = trustedFlattenSession(initial)
    const before = session.doc
    const beforeBytes = JSON.stringify(before)
    const beforeOrdinal = before.graphs.root?.nextOrdinal
    const beforeActorCursors = before.graphs.root?.actorCursors
    const beforeGroupSeq = before.view.graphs.root?.groupSeq
    const outcome = session.dispatch(invocation)
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.diagnostics.map((diagnostic) => diagnostic.code), JSON.stringify(outcome.diagnostics)).toContain(code)
    expect(session.doc).toBe(before)
    expect(JSON.stringify(session.doc)).toBe(beforeBytes)
    expect(session.doc.graphs.root?.nextOrdinal).toBe(beforeOrdinal)
    expect(session.doc.graphs.root?.actorCursors).toEqual(beforeActorCursors)
    expect(session.doc.view.graphs.root?.groupSeq).toBe(beforeGroupSeq)
  })

  it('refuses post-allocation duplicate drivers and repeated net sinks without changing bytes or allocator cursors', () => {
    const driven = flattenDocument()
    driven.graphs.body.links.driver = link('driver', port('b', 'driver'), port('a', 'in'))
    const drivenInvocation = flattenInvocation(driven)
    const drivenSession = trustedFlattenSession(driven)
    const drivenBefore = drivenSession.doc
    const drivenOutcome = drivenSession.dispatch(drivenInvocation)
    expect(drivenOutcome.ok).toBe(false)
    if (!drivenOutcome.ok) expect(drivenOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.lifecycle.multiDriver')
    expect(drivenSession.doc).toBe(drivenBefore)

    const repeated = flattenDocument()
    repeated.graphs.root.nets.incomingNet.sinks.push(port('occurrence', 'netInput'))
    const repeatedInvocation = flattenInvocation(repeated)
    const repeatedSession = trustedFlattenSession(repeated)
    const repeatedBefore = repeatedSession.doc
    const repeatedBytes = JSON.stringify(repeatedBefore)
    const repeatedOrdinal = repeatedBefore.graphs.root!.nextOrdinal
    const repeatedGroupSeq = repeatedBefore.view.graphs.root!.groupSeq
    const repeatedOutcome = repeatedSession.dispatch(repeatedInvocation)
    expect(repeatedOutcome.ok).toBe(false)
    if (!repeatedOutcome.ok) expect(repeatedOutcome.diagnostics.map((diagnostic) => diagnostic.code)).toContain('subgraph.lifecycle.multiDriver')
    expect(repeatedSession.doc).toBe(repeatedBefore)
    expect(JSON.stringify(repeatedSession.doc)).toBe(repeatedBytes)
    expect(repeatedSession.doc.graphs.root!.nextOrdinal).toBe(repeatedOrdinal)
    expect(repeatedSession.doc.view.graphs.root!.groupSeq).toBe(repeatedGroupSeq)
  })
})

describe('subgraph lifecycle prospective DAG and shell refusals', () => {

  it('builds the canonical shell refusal with a nested occurrence anchor', () => {
    expect(flattenShellRefusalDiagnostic(
      { region: { kind: 'map', elementPorts: ['in'] } },
      'nestedBody',
      ['outer', 'middle'],
      'region',
    )).toMatchObject({
      code: 'subgraph.flatten.regionUnsupported',
      message: 'subgraph.flatten: occurrence shell mode or region contract cannot be flattened',
      refs: [{ graphId: 'nestedBody', nodeId: 'region' }],
      anchor: { occurrence: { instancePath: ['outer', 'middle'], node: 'region' } },
    })
  })
})

describe('subgraph lifecycle deterministic geometry', () => {
  const items = [
    { id: 'b', kind: 'node' as const, x: 100, y: 50, width: 40, height: 20 },
    { id: 'a', kind: 'reroute' as const, x: 20, y: 10, width: 0, height: 0 },
    { id: 'group', kind: 'group' as const, x: 0, y: 0, width: 200, height: 100 },
  ]

  it('expands selected groups with the pinned center-inside rule and records explicit membership', () => {
    const result = expandLifecycleSelectionFromGroups({ groupIds: ['g'], nodeIds: ['preselected'] }, [
      { id: 'g', kind: 'group', x: 0, y: 0, width: 100, height: 100 },
      { id: 'n', kind: 'node', x: 90, y: 90, width: 20, height: 20 },
      { id: 'outside', kind: 'node', x: 101, y: 101, width: 0, height: 0 },
      { id: 'r', kind: 'reroute', x: 0, y: 0, width: 0, height: 0 },
    ])
    expect(result).toEqual({
      selection: {
        nodeIds: ['n', 'preselected'], rerouteIds: ['r'], groupIds: ['g'],
      },
      groups: [{ groupId: 'g', nodeIds: ['n'], rerouteIds: ['r'] }],
    })
    expect(expandLifecycleSelectionFromGroups({ groupIds: ['empty'] }, [
      { id: 'empty', kind: 'group', x: 0, y: 0, width: 1, height: 1 },
    ])?.groups[0]).toEqual({
      groupId: 'empty', nodeIds: [], rerouteIds: [],
    })
  })

})
