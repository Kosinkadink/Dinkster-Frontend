import { describe, expect, it, vi } from 'vitest'
import {
  asGraphDefId,
  asConnectionId,
  asLineageId,
  asNodeId,
  asPortId,
  compile,
  coreCommandRegistry,
  createTransactionBuilder,
  documentResolver,
  DocumentStore,
  elaborateInterface,
  elabInputsOf,
  executeCommand,
  occurrenceKey,
  type CommandInvocation,
  type EffectiveLink,
  type NodeSchema,
  type OccurrenceRef,
  type WorkflowDocument,
} from '@dinkster/core'
import type { OccurrenceLinkEndpoint } from '@dinkster/core'

vi.mock('lucide-solid', () => ({
  Ban: {}, Check: {}, CirclePlay: {}, Copy: {}, CopyPlus: {}, Eye: {}, FolderOpen: {}, Group: {},
  Palette: {}, SlidersHorizontal: {}, Trash2: {}, Ungroup: {}, VolumeX: {}, X: {},
}))

import { coreOccurrencePlanner, dispatchOccurrenceIntention, occurrenceCompactionTarget } from '../src/CanvasHost.js'

const schema = (type: string, inputs: string[], outputs: string[]): NodeSchema => ({
  type, displayName: type, category: 'test', source: 'v3', isOutputNode: type === 'Sink',
  items: [
    ...inputs.map((id) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' }, optional: true })),
    ...outputs.map((id) => ({ kind: 'output' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' } })),
  ],
})
const schemas: Record<string, NodeSchema> = {
  Src: schema('Src', [], ['out']),
  Sink: schema('Sink', ['in', 'other'], []),
  FamilySink: {
    ...schema('FamilySink', [], []),
    items: [{
      kind: 'input', id: 'items', type: { kind: 'wildcard' }, optional: false,
      dynamic: {
        kind: 'autogrow',
        template: [{ kind: 'input', id: 'item', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
        naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
      },
    }],
  },
}
const resolve = (type: string) => schemas[type]
const owner = (node: string): OccurrenceRef => ({ instancePath: [], node: asNodeId(node) })
const binding = (node = 'producerTwo') => ({ kind: 'port' as const, node: asNodeId(node), port: asPortId('out') })

function fixtureDocument(): WorkflowDocument {
  return {
    format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('occurrence-planner-wiring'),
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
          producerOne: { id: asNodeId('producerOne'), type: 'Src', values: {} },
          producerTwo: { id: asNodeId('producerTwo'), type: 'Src', values: {} },
          sink: { id: asNodeId('sink'), type: 'Sink', values: {} },
        },
        links: {
          shared: {
            id: 'shared' as never,
            from: { node: asNodeId('producerOne'), port: asPortId('out') },
            to: { node: asNodeId('sink'), port: asPortId('in') },
          },
        },
        nets: {}, reroutes: {}, nextOrdinal: 2,
        boundary: {
          inputs: [],
          outputs: [{ id: 'feed' as never, binds: binding() }],
        },
      },
    },
    view: { graphs: {} },
  }
}

const boundaryFrom = (target: OccurrenceRef): OccurrenceLinkEndpoint => ({
  kind: 'boundary', occurrence: target, address: { port: asPortId('feed') },
  route: [{ graph: asGraphDefId('body'), boundaryId: 'feed', binding: binding() }],
})
const bodyTo = (): OccurrenceLinkEndpoint => ({
  kind: 'body', endpoint: { node: asNodeId('sink'), port: asPortId('in') } as never,
})

describe('production occurrence planner wiring', () => {
  it('commits a real occurrence-local connect through the core planner and one undo restores', () => {
    const store = new DocumentStore(fixtureDocument(), coreCommandRegistry())
    const target = owner('a')
    const report = vi.fn()

    const outcome = dispatchOccurrenceIntention({
      document: store.doc,
      resolver: resolve,
      intention: { kind: 'connect', owner: target, bodyGraph: asGraphDefId('body') as never, from: boundaryFrom(target), to: bodyTo() },
      planner: coreOccurrencePlanner,
      dispatch: (invocation) => store.dispatch(invocation),
      report,
    })

    expect(outcome.ok, JSON.stringify(!outcome.ok ? outcome.diagnostics : undefined)).toBe(true)
    expect(report).not.toHaveBeenCalled()
    const topology = store.doc.occurrenceTopologies![occurrenceKey(target)]!
    expect(Object.keys(topology.links)).toEqual(['l0'])
    expect(topology.suppressedDeliveries).toEqual([{ kind: 'link', linkId: 'shared' }])
    expect(store.doc.occurrenceTopologies![occurrenceKey(owner('b'))]).toBeUndefined()
    expect(store.doc.graphs[asGraphDefId('body')]!.links.shared).toBeDefined()

    expect(store.undo()).toBe(true)
    expect(store.doc.occurrenceTopologies?.[occurrenceKey(target)]?.links ?? {}).toEqual({})
  })

  it('refuses unresolvable intentions through the named planner diagnostic without dispatching', () => {
    const store = new DocumentStore(fixtureDocument(), coreCommandRegistry())
    const target = owner('a')
    const dispatch = vi.fn()
    const report = vi.fn()

    const outcome = dispatchOccurrenceIntention({
      document: store.doc,
      resolver: resolve,
      intention: {
        kind: 'connect', owner: target, bodyGraph: asGraphDefId('body') as never,
        from: boundaryFrom(target),
        to: { kind: 'body', endpoint: { node: asNodeId('missing'), port: asPortId('in') } as never },
      },
      planner: coreOccurrencePlanner,
      dispatch,
      report,
    })

    expect(outcome.ok).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
    const codes = report.mock.calls[0]![0].map((diagnostic: { code: string }) => diagnostic.code)
    expect(codes).toEqual(['occurrence.link.planUnavailable'])
  })

  it('disconnects and compacts an occurrence-owned member in one replayable undo record', () => {
    const initial = fixtureDocument()
    const target = owner('a')
    const familyBinding = {
      kind: 'family' as const,
      node: asNodeId('sink'),
      port: asPortId('items'),
    }
    ;(initial.graphs.root!.nodes.a as any).dynamic = { ingest: { members: ['m0'], seq: 1 } }
    ;(initial.graphs.root!.nodes.b as any).dynamic = { ingest: { members: ['m0'], seq: 1 } }
    ;(initial.graphs.body!.nodes.sink as any) = {
      id: asNodeId('sink'), type: 'FamilySink', values: {},
    }
    ;(initial.graphs.body!.nodes as any).staticSink = {
      id: asNodeId('staticSink'), type: 'Sink', values: {},
    }
    ;(initial.graphs.body!.links as any) = {}
    ;(initial.graphs.body!.boundary as any).inputs = [{ id: 'ingest', binds: familyBinding }]
    const configured: WorkflowDocument = { ...initial, occurrenceTopologies: {
      [occurrenceKey(target)]: {
        owner: target,
        bodyGraph: asGraphDefId('body'),
        links: {
          l0: {
            id: 'l0' as never,
            from: { kind: 'body', endpoint: { node: asNodeId('producerOne'), port: asPortId('out') } },
            to: {
              kind: 'boundary',
              occurrence: target,
              address: { port: asPortId('ingest.item'), members: ['m0' as never] },
              route: [{ graph: asGraphDefId('body'), boundaryId: 'ingest', binding: familyBinding }],
            },
          },
        },
        nextOrdinal: 1,
      },
    } }
    const replayInitial = structuredClone(configured)
    const registry = coreCommandRegistry()
    const store = new DocumentStore(configured, registry)
    const dispatched: CommandInvocation[] = []
    const intention = {
      kind: 'disconnect' as const, owner: target, bodyGraph: asGraphDefId('body'),
      link: { kind: 'occurrence' as const, owner: target, linkId: 'l0' as never },
    }
    const planned = coreOccurrencePlanner.planOccurrenceLinkMutation(configured, resolve, intention)
    expect(planned.ok).toBe(true)
    if (!planned.ok) throw new Error('disconnect planning failed')
    const outcome = dispatchOccurrenceIntention({
      document: store.doc,
      resolver: resolve,
      intention,
      planner: coreOccurrencePlanner,
      dispatch: (invocation) => {
        dispatched.push(invocation)
        return store.dispatch(invocation)
      },
      report: () => undefined,
    })

    expect(outcome.ok, JSON.stringify(!outcome.ok ? outcome.diagnostics : undefined)).toBe(true)
    expect(dispatched).toEqual([{
      command: 'batch',
      params: {
        invocations: [
          planned.invocation,
          { command: 'dynamic.compact', params: { graphId: 'root', nodeId: 'a' } },
        ],
      },
    }])
    expect(store.doc.occurrenceTopologies!.a!.links).toEqual({})
    expect(store.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { seq: 1 } })
    expect(store.doc.graphs.root!.nodes.b!.dynamic).toEqual({ ingest: { members: ['m0'], seq: 1 } })
    expect(store.doc.graphs.body!.nodes.sink!.dynamic).toBeUndefined()

    const derived = documentResolver(store.doc, resolve)('#body')
    expect(derived).toBeDefined()
    expect(elabInputsOf(elaborateInterface(derived!, store.doc.graphs.root!.nodes.a!))
      .filter((input) => input.origin.kind === 'member' && input.origin.ghost === true)).toHaveLength(1)

    const reloaded = JSON.parse(JSON.stringify(store.doc)) as WorkflowDocument
    const compileDoc = (document: WorkflowDocument) => compile({
      document,
      revision: 1,
      resolve,
      scope: { kind: 'full' },
      connection: asConnectionId('test'),
      schemaHash: 'test',
    })
    expect(compileDoc(reloaded)).toEqual(compileDoc(store.doc))

    const batch = dispatched[0]!
    const runReplay = (kind: 'initial' | 'shared-replay') => {
      const tx = createTransactionBuilder(replayInitial)
      expect(executeCommand(registry.get('batch')!, replayInitial, batch.params, tx, { kind })).toEqual([])
      return tx.result().doc
    }
    expect(runReplay('shared-replay')).toEqual(runReplay('initial'))

    const rejected = structuredClone(batch) as unknown as { command: string; params: { invocations: CommandInvocation[] } }
    rejected.params.invocations[1] = { command: 'dynamic.compact', params: { graphId: 'missing', nodeId: 'a' } }
    for (const kind of ['initial', 'shared-replay'] as const) {
      const rejectingStore = new DocumentStore(replayInitial, registry, 200, () => undefined, () => ({ kind }))
      const before = rejectingStore.doc
      const refusal = rejectingStore.dispatch(rejected as unknown as CommandInvocation)
      expect(refusal.ok).toBe(false)
      expect(rejectingStore.doc).toBe(before)
      expect(rejectingStore.canUndo).toBe(false)
    }

    const rewireStore = new DocumentStore(replayInitial, registry)
    const rewireDispatches: CommandInvocation[] = []
    const rewire = dispatchOccurrenceIntention({
      document: rewireStore.doc,
      resolver: resolve,
      intention: {
        kind: 'rewire', owner: target, bodyGraph: asGraphDefId('body'),
        link: { kind: 'occurrence', owner: target, linkId: 'l0' as never },
        to: { kind: 'body', endpoint: { node: asNodeId('staticSink'), port: asPortId('in') } },
      },
      planner: coreOccurrencePlanner,
      dispatch: (invocation) => {
        rewireDispatches.push(invocation)
        return rewireStore.dispatch(invocation)
      },
      report: () => undefined,
    })
    expect(rewire.ok).toBe(true)
    expect((rewireDispatches[0]!.params as any).invocations[1]).toEqual({
      command: 'dynamic.compact', params: { graphId: 'root', nodeId: 'a' },
    })
    expect(rewireStore.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { seq: 1 } })
    expect(rewireStore.doc.occurrenceTopologies!.a!.links.l0!.to).toEqual({
      kind: 'body', endpoint: { node: 'staticSink', port: 'in' },
    })
    expect(rewireStore.undo()).toBe(true)
    expect(rewireStore.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { members: ['m0'], seq: 1 } })

    expect(store.undo()).toBe(true)
    expect(store.doc.occurrenceTopologies!.a!.links.l0).toBeDefined()
    expect(store.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { members: ['m0'], seq: 1 } })
    expect(store.redo()).toBe(true)
    expect(store.doc.occurrenceTopologies!.a!.links).toEqual({})
    expect(store.doc.graphs.root!.nodes.a!.dynamic).toEqual({ ingest: { seq: 1 } })
  })

  it('compacts the persisted outer owner for a nested projected parent leg', () => {
    const doc = fixtureDocument()
    ;(doc.graphs.root!.nodes.a as any).dynamic = { forwarded: { members: ['m0'], seq: 1 } }
    ;(doc.graphs.body!.nodes.sink as any).dynamic = { local: { members: ['wrong0'], seq: 1 } }
    ;(doc.graphs.root!.links as any).outer = {
      id: 'outer',
      from: { node: 'b', port: 'out' },
      to: { node: 'a', port: 'forwarded.item', members: ['m0'] },
    }
    const link = {
      identity: {
        kind: 'parentLeg',
        delivery: { kind: 'link', graph: asGraphDefId('root'), linkId: 'outer' as never },
        route: [{ graph: asGraphDefId('body'), boundaryId: 'forwarded', binding: binding('sink') }],
      },
      from: {} as any,
      to: {
        graphId: asGraphDefId('body'),
        instancePath: ['a' as never, 'inner' as never],
        endpoint: { node: asNodeId('sink'), port: asPortId('items.item'), members: ['m0' as never] },
        source: {
          kind: 'occurrence',
          owner: { instancePath: ['a' as never], node: asNodeId('inner') },
          endpoint: {
            kind: 'boundary',
            occurrence: { instancePath: ['a' as never], node: asNodeId('inner') },
            address: { port: asPortId('forwarded.item'), members: ['m0' as never] },
            route: [{ graph: asGraphDefId('body'), boundaryId: 'forwarded', binding: binding('sink') }],
          },
        },
      },
    } as EffectiveLink

    expect(occurrenceCompactionTarget(doc, link)).toEqual({ graphId: 'root', nodeId: 'a' })
  })
})
