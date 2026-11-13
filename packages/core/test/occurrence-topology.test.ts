
import { describe, expect, it } from 'vitest'
import { semanticHashOf } from '../src/compile/hash.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { BoundaryBinding, OccurrenceTopology, PortBoundaryBinding, WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { validateDocumentShape } from '../src/format/validate.js'
import { asGraphDefId, asDynamicMemberId, asLineageId, asLinkId, asNodeId, asPortId, occurrenceKey } from '../src/ids.js'
import { checkDocument } from '../src/invariants.js'

type Mutable = Record<string, unknown>

const occurrence = (instancePath: readonly string[], node: string) => ({
  instancePath: instancePath.map(asNodeId),
  node: asNodeId(node),
})

const binding = (node: string, port: string, extra?: Partial<PortBoundaryBinding>): PortBoundaryBinding => ({
  kind: 'port',
  node: asNodeId(node),
  port: asPortId(port),
  ...extra,
})

const routeLeg = (graph: string, boundaryId: string, target: BoundaryBinding) => ({
  graph: asGraphDefId(graph),
  boundaryId,
  binding: target,
})

function baseDocument(): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('occurrence-topology-tests'),
    root: asGraphDefId('root'),
    graphs: {
      root: {
        id: asGraphDefId('root'),
        name: 'root',
        nodes: {
          producer: { id: asNodeId('producer'), type: 'Producer', values: {} },
          s: { id: asNodeId('s'), type: '#shell', values: {} },
          sibling: { id: asNodeId('sibling'), type: '#shell', values: {} },
        },
        links: {
          parent: {
            id: asLinkId('parent'),
            from: { node: asNodeId('producer'), port: asPortId('out') },
            to: { node: asNodeId('s'), port: asPortId('in') },
          },
        },
        nets: {},
        reroutes: {},
        nextOrdinal: 0,
      },
      shell: {
        id: asGraphDefId('shell'),
        name: 'shell',
        nodes: {
          i: { id: asNodeId('i'), type: '#body', values: {} },
          side: { id: asNodeId('side'), type: 'Side', values: {} },
        },
        links: {},
        nets: {},
        reroutes: {},
        boundary: {
          inputs: [{
            id: 'in',
            binds: binding('i', 'inner'),
            alsoBinds: [binding('side', 'alt')],
          }],
          outputs: [{ id: 'out', binds: binding('i', 'outer') }],
        },
        nextOrdinal: 0,
      },
      body: {
        id: asGraphDefId('body'),
        name: 'body',
        nodes: {
          source: { id: asNodeId('source'), type: 'Source', values: {} },
          sink: {
            id: asNodeId('sink'),
            type: 'Sink',
            values: {},
            dynamic: { items: { members: ['m0'], seq: 1 } },
          },
        },
        links: {
          l0: {
            id: asLinkId('l0'),
            from: { node: asNodeId('source'), port: asPortId('out') },
            to: {
              node: asNodeId('sink'),
              port: asPortId('items.value'),
              members: [asDynamicMemberId('m0')],
            },
          },
        },
        nets: {
          net1: {
            id: 'net1' as never,
            name: 'shared',
            source: { node: asNodeId('source'), port: asPortId('out') },
            sinks: [{ node: asNodeId('sink'), port: asPortId('net') }],
          },
        },
        reroutes: {},
        boundary: {
          inputs: [{ id: 'inner', binds: binding('sink', 'in') }],
          outputs: [{ id: 'outer', binds: binding('source', 'out') }],
        },
        nextOrdinal: 2,
      },
    },
    view: { graphs: {} },
  }
}

const owner = occurrence(['s'], 'i')
const ownerKey = occurrenceKey(owner)

const ancestorInputRoute = [
  routeLeg('shell', 'in', binding('i', 'inner')),
  routeLeg('body', 'inner', binding('sink', 'in')),
]

const directOutputRoute = [routeLeg('body', 'outer', binding('source', 'out'))]

type TopologyOverrides = Omit<Partial<OccurrenceTopology>, 'suppressedDeliveries'> & {
  readonly suppressedDeliveries?: OccurrenceTopology['suppressedDeliveries'] | undefined
}

function topology(overrides?: TopologyOverrides): OccurrenceTopology {
  const result = {
    owner,
    bodyGraph: asGraphDefId('body'),
    links: {
      l0: {
        id: asLinkId('l0'),
        from: { kind: 'body', endpoint: { node: asNodeId('source'), port: asPortId('out') } },
        to: {
          kind: 'boundary',
          occurrence: occurrence([], 's'),
          address: { port: asPortId('in') },
          route: ancestorInputRoute,
        },
      },
      l1: {
        id: asLinkId('l1'),
        from: {
          kind: 'boundary',
          occurrence: owner,
          address: { port: asPortId('outer') },
          route: directOutputRoute,
        },
        to: { kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } },
      },
    },
    suppressedDeliveries: [
      { kind: 'link', linkId: asLinkId('l0') },
      {
        kind: 'netSink',
        netId: 'net1' as never,
        to: { node: asNodeId('sink'), port: asPortId('net') },
      },
      {
        kind: 'projectedLeg',
        delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: asLinkId('parent') },
        route: ancestorInputRoute,
      },
    ],
    nextOrdinal: 2,
    ...overrides,
  } as unknown as OccurrenceTopology
  if (overrides !== undefined && 'suppressedDeliveries' in overrides &&
      overrides.suppressedDeliveries === undefined) {
    delete (result as unknown as Mutable)['suppressedDeliveries']
  }
  return result
}

function withTopology(
  top: OccurrenceTopology = topology(),
  key = ownerKey,
  document: WorkflowDocument = baseDocument(),
): WorkflowDocument {
  return { ...document, occurrenceTopologies: { [key]: top } }
}

const errors = (doc: WorkflowDocument) => checkDocument(doc).filter((d) => d.severity === 'error')
const errorCodes = (doc: WorkflowDocument) => errors(doc).map((d) => d.code)

function mutateTopology(
  change: (top: Mutable, doc: Mutable) => void,
): WorkflowDocument {
  const doc = structuredClone(withTopology()) as unknown as Mutable
  const topologies = doc['occurrenceTopologies'] as Mutable
  change(topologies[ownerKey] as Mutable, doc)
  return doc as unknown as WorkflowDocument
}

describe('occurrence topology format shape and identity', () => {

  it.each([
    ['occurrenceTopologies array', (d: Mutable) => { d['occurrenceTopologies'] = [] }],
    ['owner path array missing', (d: Mutable) => { delete ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['owner'] }],
    ['empty owner node', (d: Mutable) => { (((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['owner'] as Mutable)['node'] = '' }],
    ['missing bodyGraph', (d: Mutable) => { delete ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['bodyGraph'] }],
    ['links array', (d: Mutable) => { ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['links'] = [] }],
    ['negative cursor', (d: Mutable) => { ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['nextOrdinal'] = -1 }],
    ['invalid actor', (d: Mutable) => { ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['actorCursors'] = { 'bad.actor': 1 } }],
    ['unknown endpoint kind', (d: Mutable) => {
      const top = (d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable
      ((top['links'] as Mutable)['l0'] as Mutable)['from'] = { kind: 'projected' }
    }],
    ['empty boundary route', (d: Mutable) => {
      const top = (d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable
      const link = (top['links'] as Mutable)['l0'] as Mutable
      ;(link['to'] as Mutable)['route'] = []
    }],
    ['tap target', (d: Mutable) => {
      const top = (d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable
      ((top['links'] as Mutable)['l1'] as Mutable)['to'] = {
        kind: 'body', endpoint: { node: 'sink', tap: 'in' },
      }
    }],
    ['empty suppression list', (d: Mutable) => { ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['suppressedDeliveries'] = [] }],
    ['unknown suppression kind', (d: Mutable) => { ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['suppressedDeliveries'] = [{ kind: 'unknown' }] }],
    ['projected suppression empty route', (d: Mutable) => { ((d['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['suppressedDeliveries'] = [{ kind: 'projectedLeg', delivery: { kind: 'link', graph: 'root', linkId: 'parent' }, route: [] }] }],
  ])('rejects malformed shape: %s', (_name, change) => {
    const doc = structuredClone(withTopology()) as unknown as Mutable
    change(doc)
    expect(validateDocumentShape(doc).some((d) => d.severity === 'error')).toBe(true)
  })
})

describe('occurrence topology canonicalization and serialization', () => {

  it('round-trips overlay-bearing documents and leaves absent-field bytes unchanged', () => {
    const overlay = withTopology()
    const first = loadDocument(JSON.parse(JSON.stringify(overlay))).document!
    const bytes = JSON.stringify(first)
    expect(JSON.stringify(loadDocument(JSON.parse(bytes)).document)).toBe(bytes)

    const old = baseDocument()
    const oldBytes = JSON.stringify(old)
    expect(JSON.stringify(loadDocument(JSON.parse(oldBytes)).document)).toBe(oldBytes)
    expect(loadDocument(JSON.parse(oldBytes)).document!.occurrenceTopologies).toBeUndefined()
  })

})

describe('occurrence topology semantic invariants fail closed', () => {
  it('accepts a projected net delivery from the source occurrence', () => {
    const doc = baseDocument()
    ;(doc.graphs.shell!.nets as Record<string, any>).projected = {
      id: 'projected',
      name: 'projected',
      source: { node: 'i', port: 'outer' },
      sinks: [{ node: 'side', port: 'alt' }],
    }
    const top = topology({
      suppressedDeliveries: [
        {
          kind: 'projectedLeg',
          delivery: {
            kind: 'netSink',
            graph: asGraphDefId('shell'),
            netId: 'projected' as never,
            to: { node: asNodeId('side'), port: asPortId('alt') },
          },
          route: directOutputRoute,
        },
      ],
    })
    expect(errors(withTopology(top, ownerKey, doc))).toEqual([])
  })

  it.each([
    ['missing path hop', 'doc.occurrenceTopology.ownerMissing', () => mutateTopology((top) => { (top['owner'] as Mutable)['instancePath'] = ['missing'] })],
    ['non-subgraph path hop', 'doc.occurrenceTopology.ownerMissing', () => mutateTopology((top) => { (top['owner'] as Mutable)['instancePath'] = ['producer'] })],
    ['missing owner node', 'doc.occurrenceTopology.ownerMissing', () => mutateTopology((top) => { (top['owner'] as Mutable)['node'] = 'missing' })],
    ['owner no longer a subgraph', 'doc.occurrenceTopology.ownerMissing', () => mutateTopology((top, doc) => { ((((doc['graphs'] as Mutable)['shell'] as Mutable)['nodes'] as Mutable)['i'] as Mutable)['type'] = 'Ordinary' })],
    ['body graph mismatch', 'doc.occurrenceTopology.bodyMismatch', () => mutateTopology((top) => { top['bodyGraph'] = 'shell' })],
    ['body endpoint missing node', 'doc.occurrenceTopology.endpointDangling', () => mutateTopology((top) => { (((top['links'] as Mutable)['l0'] as Mutable)['from'] as Mutable)['endpoint'] = { node: 'missing', port: 'out' } })],
    ['body endpoint removed member', 'doc.dynamic.memberMissing', () => mutateTopology((top) => { (((top['links'] as Mutable)['l1'] as Mutable)['to'] as Mutable)['endpoint'] = { node: 'sink', port: 'items.value', members: ['missing'] } })],
    ['body endpoint projected NUL member', 'doc.occurrenceTopology.projectedId', () => mutateTopology((top) => { (((top['links'] as Mutable)['l1'] as Mutable)['to'] as Mutable)['endpoint'] = { node: 'sink', port: 'items.value', members: ['\u0000m0'] } })],
    ['boundary occurrence is a sibling', 'doc.occurrenceTopology.boundaryOccurrence', () => mutateTopology((top) => { (((top['links'] as Mutable)['l0'] as Mutable)['to'] as Mutable)['occurrence'] = { instancePath: [], node: 'sibling' } })],
    ['route graph drift', 'doc.occurrenceTopology.routeInvalid', () => mutateTopology((top) => { (((((top['links'] as Mutable)['l0'] as Mutable)['to'] as Mutable)['route'] as Mutable[])[0] as Mutable)['graph'] = 'body' })],
    ['route boundary drift', 'doc.occurrenceTopology.routeInvalid', () => mutateTopology((top) => { (((((top['links'] as Mutable)['l0'] as Mutable)['to'] as Mutable)['route'] as Mutable[])[0] as Mutable)['boundaryId'] = 'out' })],
    ['route binding rebinding', 'doc.occurrenceTopology.routeInvalid', () => mutateTopology((top) => { ((((((top['links'] as Mutable)['l0'] as Mutable)['to'] as Mutable)['route'] as Mutable[])[0] as Mutable)['binding'] as Mutable)['port'] = 'changed' })],
    ['route is truncated', 'doc.occurrenceTopology.routeInvalid', () => mutateTopology((top) => { (((top['links'] as Mutable)['l0'] as Mutable)['to'] as Mutable)['route'] = ancestorInputRoute.slice(0, 1) })],
    ['stale net suppression', 'doc.occurrenceTopology.suppressionDangling', () => mutateTopology((top) => { (top['suppressedDeliveries'] as Mutable[])[1]!['netId'] = 'missing' })],
    ['stale net sink suppression', 'doc.occurrenceTopology.suppressionDangling', () => mutateTopology((top) => { ((top['suppressedDeliveries'] as Mutable[])[1]!['to'] as Mutable)['port'] = 'missing' })],
    ['missing projected delivery', 'doc.occurrenceTopology.suppressionDangling', () => mutateTopology((top) => { ((((top['suppressedDeliveries'] as Mutable[])[2]!['delivery']) as Mutable)['linkId']) = 'missing' })],
    ['local link key mismatch', 'doc.occurrenceTopology.linkKeyMismatch', () => mutateTopology((top) => { ((top['links'] as Mutable)['l0'] as Mutable)['id'] = 'l9' })],
    ['duplicate local link id', 'doc.occurrenceTopology.linkDuplicate', () => mutateTopology((top) => { ((top['links'] as Mutable)['l1'] as Mutable)['id'] = 'l0' })],
    ['solo cursor floor', 'doc.occurrenceTopology.idAboveCursor', () => mutateTopology((top) => { top['nextOrdinal'] = 1 })],
    ['actor cursor floor', 'doc.occurrenceTopology.idAboveCursor', () => mutateTopology((top) => { top['links'] = { 'l2-alice': { id: 'l2-alice', from: { kind: 'body', endpoint: { node: 'source', port: 'out' } }, to: { kind: 'body', endpoint: { node: 'sink', port: 'in' } } } }; top['actorCursors'] = { alice: 2 } })],
  ])('rejects %s', (_name, code, make) => {
    expect(errorCodes(make())).toContain(code)
  })

  it('allows a deleted shared-link suppression tombstone because link ids are never reused', () => {
    const doc = mutateTopology((_top, raw) => {
      delete (((raw['graphs'] as Mutable)['body'] as Mutable)['links'] as Mutable)['l0']
    })
    expect(errorCodes(doc)).not.toContain('doc.occurrenceTopology.suppressionDangling')
  })

  it('requires persisted family endpoint members to exist on the concrete occurrence', () => {
    const familyBinding = binding('i', 'inner', { kind: 'family' })
    const doc = structuredClone(baseDocument()) as unknown as Mutable
    const root = (doc['graphs'] as Mutable)['root'] as Mutable
    const rootNodes = root['nodes'] as Mutable
    ;(rootNodes['s'] as Mutable)['dynamic'] = { in: { members: ['outerMember'], seq: 1 } }
    const shell = (doc['graphs'] as Mutable)['shell'] as Mutable
    const shellBoundary = shell['boundary'] as Mutable
    const shellInput = (shellBoundary['inputs'] as Mutable[])[0]!
    shellInput['binds'] = familyBinding
    delete shellInput['alsoBinds']

    const top = topology({
      links: {
        l0: {
          id: asLinkId('l0'),
          from: { kind: 'body', endpoint: { node: asNodeId('source'), port: asPortId('out') } },
          to: {
            kind: 'boundary',
            occurrence: occurrence([], 's'),
            address: {
              port: asPortId('in.slot'),
              members: [asDynamicMemberId('outerMember')],
            },
            route: [routeLeg('shell', 'in', familyBinding), ancestorInputRoute[1]!],
          },
        },
      },
      suppressedDeliveries: undefined,
      nextOrdinal: 1,
    })
    const valid = withTopology(top, ownerKey, doc as unknown as WorkflowDocument)
    expect(errors(valid)).toEqual([])

    const stale = structuredClone(valid) as unknown as Mutable
    const local = (((stale['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['links'] as Mutable)['l0'] as Mutable
    ;((local['to'] as Mutable)['address'] as Mutable)['members'] = ['removedMember']
    expect(errorCodes(stale as unknown as WorkflowDocument)).toContain('doc.occurrenceTopology.routeInvalid')
  })

  it.each([
    ['rebind', {
      command: 'boundary.setBinding',
      params: { graphId: 'body', side: 'inputs', itemId: 'inner', node: 'sink', port: 'changed' },
    }],
    ['disconnect', {
      command: 'boundary.unbind',
      params: { graphId: 'body', side: 'inputs', itemId: 'inner', node: 'sink', port: 'in' },
    }],
  ])('refuses definition-level boundary %s before it can stale a persisted route', (_name, invocation) => {
    const store = new DocumentStore(withTopology(), coreCommandRegistry())
    const before = JSON.stringify(store.doc)
    const result = store.dispatch(invocation)
    expect(result.ok).toBe(false)
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('doc.occurrenceTopology.routeInvalid')
    expect(JSON.stringify(store.doc)).toBe(before)
  })

})

describe('occurrence topology semantic hashing and cursor history', () => {
  it('hashes execution-affecting overlay data but ignores allocator-only skeletons', () => {
    const plain = baseDocument()
    expect(semanticHashOf(withTopology(topology({ links: {}, suppressedDeliveries: undefined, nextOrdinal: 4 })))).toBe(semanticHashOf(plain))
    expect(semanticHashOf(withTopology())).not.toBe(semanticHashOf(plain))

    const changed = mutateTopology((top) => {
      (((top['links'] as Mutable)['l0'] as Mutable)['from'] as Mutable)['endpoint'] = { node: 'sink', port: 'other' }
    })
    expect(semanticHashOf(changed)).not.toBe(semanticHashOf(withTopology()))
  })

  it('hashes local connections without their allocator ids or stale tombstones', () => {
    const original = withTopology()
    const renamed = structuredClone(original) as unknown as Mutable
    const links = ((renamed['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['links'] as Mutable
    const local = links['l0'] as Mutable
    delete links['l0']
    local['id'] = 'l8'
    links['l8'] = local
    ;((renamed['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['nextOrdinal'] = 9
    expect(semanticHashOf(renamed as unknown as WorkflowDocument)).toBe(semanticHashOf(original))

    const tombstone = mutateTopology((top, doc) => {
      top['links'] = {}
      top['suppressedDeliveries'] = [{ kind: 'link', linkId: 'l0' }]
      delete (((doc['graphs'] as Mutable)['body'] as Mutable)['links'] as Mutable)['l0']
    })
    const withoutTombstone = structuredClone(tombstone) as unknown as Mutable
    delete ((withoutTombstone['occurrenceTopologies'] as Mutable)[ownerKey] as Mutable)['suppressedDeliveries']
    expect(semanticHashOf(tombstone)).toBe(semanticHashOf(withoutTombstone as unknown as WorkflowDocument))
  })

  it('traces a body reroute source so changing its definition-owned driver changes the hash', () => {
    const driven = mutateTopology((top, doc) => {
      const body = (doc['graphs'] as Mutable)['body'] as Mutable
      ;(body['reroutes'] as Mutable)['r0'] = { id: 'r0' }
      ;(body['links'] as Mutable)['l2'] = {
        id: 'l2',
        from: { node: 'source', port: 'out' },
        to: { reroute: 'r0' },
      }
      body['nextOrdinal'] = 3
      top['links'] = {
        l0: {
          id: 'l0',
          from: { kind: 'body', endpoint: { reroute: 'r0' } },
          to: { kind: 'body', endpoint: { node: 'sink', port: 'in' } },
        },
      }
      delete top['suppressedDeliveries']
      top['nextOrdinal'] = 1
    })
    const changedDriver = structuredClone(driven) as unknown as Mutable
    const body = (changedDriver['graphs'] as Mutable)['body'] as Mutable
    const feed = (body['links'] as Mutable)['l2'] as Mutable
    feed['from'] = { node: 'sink', port: 'other' }
    expect(semanticHashOf(changedDriver as unknown as WorkflowDocument)).not.toBe(semanticHashOf(driven))
  })

})
