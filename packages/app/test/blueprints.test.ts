/**
 * BlueprintBodyCache unit tests: fetch-once-per-digest with shared
 * in-flight promises, validate-once via loadDocument, and the
 * definitive-vs-transient failure split (non-OK / bad JSON / invalid
 * document negative-cached per digest; transport rejection retryable).
 *
 * insertBlueprintIntoTab unit tests: invocation-time
 * ownership held across the body fetch - stale owners refuse without
 * touching payload, dispatch, or resolver; a live owner commits one batch
 * against the captured graph.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  coreCommandRegistry,
  DocumentStore,
  loadDocument,
  type CommandInvocation,
  type NodeSchema,
  type WorkflowDocument,
} from '@dinkster/core'
import {
  BlueprintBodyCache,
  blueprintFailureDiagnostic,
  insertBlueprintIntoTab,
  type BlueprintInsertOutcome,
} from '../src/blueprints.js'

const DIGEST = 'sha256:' + 'a'.repeat(64)

const validBody = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lin-bp',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'Blueprint',
      nodes: { n0: { id: 'n0', type: 'EmptyImage', values: {} } },
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 1,
      boundary: { inputs: [], outputs: [] },
    },
  },
  view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 } } } } } },
}

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) }) as unknown as Response
const textResponse = (text: string): Response =>
  ({ ok: true, status: 200, text: () => Promise.resolve(text) }) as unknown as Response
const notFound = (): Response => ({ ok: false, status: 404 }) as unknown as Response

describe('BlueprintBodyCache', () => {
  it('fetches once per digest; concurrent loads share the in-flight fetch', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(validBody)))
    const cache = new BlueprintBodyCache({ fetchFn })

    const [a, b] = await Promise.all([
      cache.load('http://b:8000', 'my.pack', 'txt2img', DIGEST),
      cache.load('http://b:8000', 'my.pack', 'txt2img', DIGEST),
    ])
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith('http://b:8000/api/packs/my.pack/blueprints/txt2img')
    expect(a).toBeDefined()
    expect(a).toBe(b) // one decoded document, shared
    expect(a!.root).toBe('g0')

    // Later loads for the same digest never refetch.
    expect(await cache.load('http://b:8000', 'my.pack', 'txt2img', DIGEST)).toBe(a)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('404, unparseable JSON, and invalid documents are definitive per digest', async () => {
    for (const [response, digest] of [
      [notFound(), 'sha256:' + 'b'.repeat(64)],
      [textResponse('not json'), 'sha256:' + 'c'.repeat(64)],
      [jsonResponse({ format: 'dinkster-workflow', formatVersion: 1 }), 'sha256:' + 'd'.repeat(64)],
    ] as const) {
      const fetchFn = vi.fn(() => Promise.resolve(response))
      const cache = new BlueprintBodyCache({ fetchFn })
      expect(await cache.load('http://b', 'p', 'bp', digest)).toBeUndefined()
      // Negative-cached: the second load never refetches.
      expect(await cache.load('http://b', 'p', 'bp', digest)).toBeUndefined()
      expect(fetchFn).toHaveBeenCalledTimes(1)
    }
  })

  it('a transport failure leaves no record, so the next load retries', async () => {
    const fetchFn = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(jsonResponse(validBody))
    const cache = new BlueprintBodyCache({ fetchFn })

    expect(await cache.load('http://b', 'p', 'bp', DIGEST)).toBeUndefined()
    expect(await cache.load('http://b', 'p', 'bp', DIGEST)).toBeDefined()
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('URL-encodes pack and blueprint ids', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(jsonResponse(validBody)))
    const cache = new BlueprintBodyCache({ fetchFn })
    await cache.load('http://b', 'weird/pack', 'bp id', DIGEST)
    expect(fetchFn).toHaveBeenCalledWith('http://b/api/packs/weird%2Fpack/blueprints/bp%20id')
  })
})

// ---------------------------------------------------------------------------
// insertBlueprintIntoTab ownership
// ---------------------------------------------------------------------------

/** A decoded blueprint body (root graph carries a boundary). */
const blueprint = loadDocument(validBody).document!

/** A plain target document: root 'g0', no boundary, ordinal cursor at 5. */
const targetJson = {
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'lin-doc',
  root: 'g0',
  graphs: {
    g0: {
      id: 'g0',
      name: 'Main',
      nodes: {},
      links: {},
      nets: {},
      reroutes: {},
      nextOrdinal: 5,
    },
  },
  view: { graphs: { g0: { nodes: {} } } },
}
const target = loadDocument(targetJson).document!

type InsertDeps = Parameters<typeof insertBlueprintIntoTab>[0]

const makeDeps = (over: Partial<InsertDeps> = {}) => {
  const dispatched: CommandInvocation[] = []
  const inserted: string[] = []
  const deps: InsertDeps = {
    loadBody: () => Promise.resolve<WorkflowDocument | undefined>(blueprint),
    graphId: 'g0',
    position: { x: 10, y: 20 },
    tabStillOpen: () => true,
    currentGraphId: () => 'g0',
    graphStillOwned: () => true,
    ownerStillCurrent: () => true,
    doc: () => target,
    predictedNodeId: () => 'n5',
    resolveType: () => undefined,
    connect: () => [],
    dispatch: (inv) => {
      dispatched.push(inv)
      return true
    },
    onInserted: (id) => inserted.push(id),
    ...over,
  }
  return { deps, dispatched, inserted }
}

const invocationsOf = (inv: CommandInvocation): readonly CommandInvocation[] =>
  (inv.params as unknown as { invocations: readonly CommandInvocation[] }).invocations

describe('insertBlueprintIntoTab', () => {
  it('commits ONE batch against the captured graph and reports the allocated node id', async () => {
    const { deps, dispatched, inserted } = makeDeps()
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('inserted')

    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]!.command).toBe('batch')
    const invocations = invocationsOf(dispatched[0]!)
    expect(invocations.map((i) => i.command)).toEqual(['subgraph.import', 'node.add'])
    // Fresh definition id: target already uses g0, so the root re-keys to g1.
    const add = invocations[1]!.params as { graphId: string; type: string; position: unknown; values: unknown }
    expect(add.graphId).toBe('g0')
    expect(add.type).toBe('#g1')
    expect(add.position).toEqual({ x: 10, y: 20 })
    // Ordinal cursor at 5 => the new instance is n5, selected after commit.
    expect(inserted).toEqual(['n5'])
  })

  it('a tab closed during the fetch is stale-tab BEFORE payload - even when the body also failed', async () => {
    const doc = vi.fn(() => target)
    const resolveType = vi.fn(() => undefined)
    const { deps, dispatched, inserted } = makeDeps({
      loadBody: () => Promise.resolve(undefined), // liveness must win over no-body
      tabStillOpen: () => false,
      doc,
      resolveType,
    })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('stale-tab')
    expect(dispatched).toHaveLength(0)
    expect(inserted).toHaveLength(0)
    // No probe ran against what could be a same-id replacement tab.
    expect(doc).not.toHaveBeenCalled()
    expect(resolveType).not.toHaveBeenCalled()
  })

  it('graph navigation during the fetch is stale-graph: nothing dispatched anywhere', async () => {
    const { deps, dispatched, inserted } = makeDeps({ currentGraphId: () => 'g7' })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('stale-graph')
    expect(dispatched).toHaveLength(0)
    expect(inserted).toHaveLength(0)
  })

  it('a retired graph INCARNATION is stale-graph even when the same id matches again', async () => {
    // Graph ids are reusable (undo of an import frees g<n> for the next
    // import): the incarnation latch must refuse even though the current
    // graph id string equals the captured one and a graph exists under it.
    const doc = vi.fn(() => target)
    const { deps, dispatched, inserted } = makeDeps({ graphStillOwned: () => false, doc })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('stale-graph')
    expect(dispatched).toHaveLength(0)
    expect(inserted).toHaveLength(0)
    // The recreated same-id graph is never probed.
    expect(doc).not.toHaveBeenCalled()
  })

  it('backend, registry, or frozen ownership changing during the fetch is stale-owner', async () => {
    let release: ((body: WorkflowDocument) => void) | undefined
    let current = true
    const { deps, dispatched, inserted } = makeDeps({
      loadBody: () => new Promise<WorkflowDocument>((resolve) => { release = resolve }),
      ownerStillCurrent: () => current,
    })
    const insertion = insertBlueprintIntoTab(deps)
    current = false
    release!(blueprint)

    expect(await insertion).toBe<BlueprintInsertOutcome>('stale-owner')
    expect(dispatched).toHaveLength(0)
    expect(inserted).toHaveLength(0)
  })

  it('a live gesture whose body fetch definitively failed is no-body', async () => {
    const { deps, dispatched } = makeDeps({ loadBody: () => Promise.resolve(undefined) })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('no-body')
    expect(dispatched).toHaveLength(0)
  })

  it('a captured graph deleted during the fetch is graph-missing', async () => {
    const gone = { ...target, graphs: {} } as unknown as WorkflowDocument
    const { deps, dispatched } = makeDeps({ doc: () => gone })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('graph-missing')
    expect(dispatched).toHaveLength(0)
  })

  it('a body that is not a blueprint (root without boundary) is materialize-failed', async () => {
    const { deps, dispatched } = makeDeps({ loadBody: () => Promise.resolve(target) })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('materialize-failed')
    expect(dispatched).toHaveLength(0)
  })

  it('a rejected commit is rejected: dispatched once, nothing selected', async () => {
    let calls = 0
    const { deps, inserted } = makeDeps({ dispatch: () => ((calls += 1), false) })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('rejected')
    expect(calls).toBe(1)
    expect(inserted).toHaveLength(0)
  })

  it('widget defaults derive through the SUPPLIED resolver (owner registry, promoted boundary widget)', async () => {
    // Blueprint whose root boundary promotes n0's 'seed' widget; only the
    // resolver handed in (the owner tab's) can answer 'KSampler', so a
    // non-empty defaults map proves defaults derive through it - never
    // through ambient/active-tab state.
    const promotedBody = loadDocument({
      format: 'dinkster-workflow',
      formatVersion: 1,
      lineage: 'lin-bp2',
      root: 'g0',
      graphs: {
        g0: {
          id: 'g0',
          name: 'BP',
          nodes: { n0: { id: 'n0', type: 'KSampler', values: {} } },
          links: {},
          nets: {},
          reroutes: {},
          nextOrdinal: 1,
          boundary: {
            inputs: [{ id: 'seed', binds: { kind: 'port', node: 'n0', port: 'seed' }, promoted: true }],
            outputs: [],
          },
        },
      },
      view: { graphs: { g0: { nodes: { n0: { position: { x: 0, y: 0 } } } } } },
    }).document!
    const ksampler: NodeSchema = {
      type: 'KSampler',
      displayName: 'KSampler',
      category: 'sampling',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'seed',
          type: { kind: 'concrete', name: 'INT' },
          optional: false,
          widget: { widgetType: 'core.int', options: {}, default: 7 },
        },
        { kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'LATENT' } },
      ],
    }
    const ownerResolve = vi.fn((type: string) => (type === 'KSampler' ? ksampler : undefined))
    const connect = vi.fn<(nodeId: string, schema: NodeSchema | undefined) => readonly CommandInvocation[]>(() => [])
    const { deps, dispatched } = makeDeps({
      loadBody: () => Promise.resolve(promotedBody),
      resolveType: () => ownerResolve,
      connect,
    })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('inserted')
    expect(ownerResolve).toHaveBeenCalledWith('KSampler')
    const add = invocationsOf(dispatched[0]!)[1]!.params as { values: Record<string, unknown> }
    expect(add.values).toEqual({ seed: 7 })
    // The boundary-derived schema (not descriptor hints) reaches connect,
    // resolved in the blueprint's own namespace ('#g0' is the body root).
    const schemaArg = connect.mock.calls[0]![1] as NodeSchema | undefined
    expect(schemaArg).toBeDefined()
    expect(schemaArg!.type).toBe('#g0')
  })

  it('an absent owner resolver (schemas still loading) inserts with empty defaults', async () => {
    const resolveType = vi.fn(() => undefined)
    const connect = vi.fn(() => [])
    const { deps, dispatched, inserted } = makeDeps({ resolveType, connect })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('inserted')
    expect(resolveType).toHaveBeenCalledTimes(1)
    const add = invocationsOf(dispatched[0]!)[1]!.params as { values: unknown }
    expect(add.values).toEqual({})
    // The connect hook still runs, addressed to the allocated id.
    expect(connect).toHaveBeenCalledWith('n5', undefined)
    expect(inserted).toEqual(['n5'])
  })

  it('link-drop connect uses the session prediction after subgraph.import without consuming a target node id', async () => {
    const sharedTarget = loadDocument({
      ...targetJson,
      graphs: {
        g0: {
          ...targetJson.graphs.g0,
          nodes: { source: { id: 'source', type: 'EmptyImage', values: {} } },
        },
      },
    }).document!
    const store = new DocumentStore(sharedTarget, coreCommandRegistry())
    const { deps, inserted } = makeDeps({
      doc: () => store.doc,
      predictedNodeId: () => 'n0-sharedActor',
      connect: (nodeId) => [{
        command: 'link.connect',
        params: {
          graphId: 'g0',
          from: { node: 'source', port: 'out0' },
          to: { node: nodeId, port: 'input' },
        },
      }],
      dispatch: (invocation) => store.dispatch({ ...invocation, actor: 'sharedActor' }).ok,
    })
    expect(await insertBlueprintIntoTab(deps)).toBe<BlueprintInsertOutcome>('inserted')
    // subgraph.import mints graph ids during materialization, not target
    // graph node ids; node.add therefore still mints this predicted id.
    expect(store.doc.graphs.g0!.nodes['n0-sharedActor']).toBeDefined()
    const to = Object.values(store.doc.graphs.g0!.links)[0]!.to
    expect('node' in to ? to.node : undefined).toBe('n0-sharedActor')
    expect(inserted).toEqual(['n0-sharedActor'])
  })
})

describe('blueprintFailureDiagnostic', () => {
  it('surfaces live-gesture payload failures with stable codes', () => {
    const load = blueprintFailureDiagnostic('no-body', 'Txt2Img', 'my.pack')!
    expect(load.severity).toBe('error')
    expect(load.origin).toBe('import')
    expect(load.code).toBe('blueprint.loadFailed')
    expect(load.message).toContain('Txt2Img')
    expect(load.message).toContain('my.pack')

    const insert = blueprintFailureDiagnostic('materialize-failed', 'Txt2Img', 'my.pack')!
    expect(insert.code).toBe('blueprint.insertFailed')
    expect(insert.severity).toBe('error')
  })

  it('stale refusals, rejections, and success stay silent', () => {
    for (const outcome of ['inserted', 'rejected', 'stale-tab', 'stale-graph', 'stale-owner', 'graph-missing'] as const) {
      expect(blueprintFailureDiagnostic(outcome, 'bp', 'p')).toBeUndefined()
    }
  })
})
