import { describe, expect, it, vi } from 'vitest'
import { asGraphDefId, asLineageId, asNodeId, asPortId, coreCommandRegistry, DocumentStore, occurrenceKey, type NodeSchema, type OccurrenceRef, type WorkflowDocument } from '@dinkster/core'
import type { OccurrenceLinkEndpoint } from '@dinkster/core'

vi.mock('lucide-solid', () => ({
  ArrowDown: {}, ArrowUp: {}, Ban: {}, Camera: {}, Check: {}, Circle: {}, CirclePlay: {}, Copy: {}, CopyPlus: {}, Dice5: {}, Eye: {},
  FolderOpen: {}, Group: {}, Lock: {}, Palette: {}, Play: {}, RotateCcw: {}, SlidersHorizontal: {}, Square: {}, Trash2: {}, Ungroup: {}, VolumeX: {}, X: {},
}))

import { coreOccurrencePlanner, dispatchOccurrenceIntention } from '../src/CanvasHost.js'

const schema = (type: string, inputs: string[], outputs: string[]): NodeSchema => ({
  type, displayName: type, category: 'test', source: 'v3', isOutputNode: type === 'Sink',
  body: [
    ...inputs.map((id) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' }, optional: true })),
    ...outputs.map((id) => ({ kind: 'output' as const, id, type: { kind: 'concrete' as const, name: 'IMAGE' } })),
  ],
})
const schemas: Record<string, NodeSchema> = {
  Src: schema('Src', [], ['out']),
  Sink: schema('Sink', ['in', 'other'], []),
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

  it('commits a real occurrence-local connect through the core planner and one undo restores', async () => {
    const store = new DocumentStore(fixtureDocument(), coreCommandRegistry())
    const target = owner('a')
    const report = vi.fn()

    const outcome = await dispatchOccurrenceIntention({
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

  it('refuses unresolvable intentions through the named planner diagnostic without dispatching', async () => {
    const store = new DocumentStore(fixtureDocument(), coreCommandRegistry())
    const target = owner('a')
    const dispatch = vi.fn()
    const report = vi.fn()

    const outcome = await dispatchOccurrenceIntention({
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

})
