import { describe, expect, it } from 'vitest'
import { diag, documentResolver, coreCommandRegistry, createLocalSession, type CommandOutcome, type Diagnostic, type NodeSchema, type WorkflowDocument } from '@dinkster/core'
import { extractSubgraphInvocationThroughBridge, flattenSubgraphThroughBridge } from '../src/CanvasHost.js'
import { activateProblem } from '../src/ProblemsPanel.js'
import { commitExtract, extractInvocation, flattenInvocation, hasExtractSelection, isFlattenSelection } from '../src/subgraph-lifecycle.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const schema: NodeSchema = {
  type: 'Plain', displayName: 'Plain', category: 'test', source: 'v3', isOutputNode: false, body: [],
}

const document = (): WorkflowDocument => ({
  format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: 'root' as never,
  graphs: {
    root: {
      id: 'root' as never, name: 'Root',
      nodes: {
        inside: { id: 'inside' as never, type: 'Plain', values: {} },
        outside: { id: 'outside' as never, type: 'Plain', values: {} },
      },
      links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 10,
    },
  },
  view: { graphs: { root: {
    nodes: { inside: { position: { x: 20, y: 20 } }, outside: { position: { x: 400, y: 20 } } },
    groups: { selected: { id: 'selected', title: 'Selected', bounds: { x: 0, y: 0, width: 200, height: 150 } } },
  } } },
})

describe('subgraph lifecycle app plans', () => {
  it('snapshots selected group contents and creates the new occurrence', () => {
    const doc = document()
    const geometry = [
      { id: 'inside', kind: 'node' as const, x: 20, y: 20, width: 140, height: 80 },
      { id: 'outside', kind: 'node' as const, x: 400, y: 20, width: 140, height: 80 },
      { id: 'selected', kind: 'group' as const, x: 0, y: 0, width: 200, height: 150 },
    ]
    const invocation = extractInvocation(doc, 'root', [], { groupIds: ['selected'], geometry }, 'Grouped', () => schema)!
    expect(invocation.params).toMatchObject({
      name: 'Grouped',
      selection: { nodeIds: ['inside'], groupIds: ['selected'] },
      groupMemberships: [{ groupId: 'selected', nodeIds: ['inside'] }],
    })
    const session = createLocalSession(doc, coreCommandRegistry([], () => schema))
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.graphs.root!.nodes.n10).toMatchObject({ type: '#g0' })
  })

  it('does not offer hidden compatibility widgets as extracted boundary taps', () => {
    const providerSchema: NodeSchema = {
      ...schema,
      body: [
        { kind: 'input', id: 'model', type: { kind: 'concrete', name: 'COMBO' }, optional: false, widget: { widgetType: 'COMBO', options: { options: ['Automatic'] } } },
        { kind: 'input', id: 'provider', type: { kind: 'concrete', name: 'COMBO' }, optional: true, widget: { widgetType: 'COMBO', options: { options: ['vision.depth.v2'] } }, hidden: true },
      ],
    }
    const invocation = extractInvocation(
      document(),
      'root',
      [],
      { nodeIds: ['inside'], geometry: [{ id: 'inside', kind: 'node', x: 20, y: 20, width: 140, height: 80 }] },
      undefined,
      () => providerSchema,
    )!
    expect((invocation.params as Record<string, unknown>)['widgetTapSources']).toEqual([
      { node: 'inside', tap: 'model' },
      { node: 'outside', tap: 'model' },
    ])
  })

  it('gates empty extraction and flatten to exactly one occurrence', () => {
    const doc = document()
    expect(hasExtractSelection({ geometry: [] })).toBe(false)
    expect(hasExtractSelection({ groupIds: ['empty'], geometry: [{ id: 'empty', kind: 'group', x: 0, y: 0, width: 10, height: 10 }] })).toBe(false)
    expect(isFlattenSelection(doc, 'root', ['inside'], 0)).toBe(false)
    ;(doc as any).graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 0 }
    ;(doc as any).view.graphs.body = { nodes: {} }
    ;(doc as any).graphs.root.nodes.inside.type = '#body'
    expect(isFlattenSelection(doc, 'root', ['inside'], 0)).toBe(true)
    expect(isFlattenSelection(doc, 'root', ['inside'], 1)).toBe(false)
    expect(isFlattenSelection(doc, 'root', ['inside', 'outside'], 0)).toBe(false)
  })

  it('surfaces the real region flatten refusal with its anchored occurrence', async () => {
    const app = createWorkflowApp([schema])
    const backend = app.backends.get()[0]!
    backend.registry.set({
      connection: backend.id,
      hash: 'region-bridge-test',
      schemas: new Map([[schema.type, schema]]),
      diagnostics: [],
      resolve: (type) => type === schema.type ? schema : undefined,
    })
    expect((await app.openDocument(document(), 'Region bridge'))).toEqual([])
    const tab = app.activeTab()!
    const imported = tab.store.dispatch({
      command: 'subgraph.import',
      params: {
        graphs: {
          regionBody: {
            id: 'regionBody', name: 'Region Body',
            nodes: { n0: { id: 'n0', type: 'Plain', values: {} } },
            links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {},
            boundary: {
              inputs: [{ id: 'item', binds: { kind: 'port', node: 'n0', port: 'item' } }],
              outputs: [{ id: 'result', binds: { kind: 'port', node: 'n0', port: 'result' } }],
            },
            nextOrdinal: 1,
          },
        },
        view: { regionBody: { nodes: { n0: { position: { x: 100, y: 100 } } } } },
      },
    } as any)
    expect(imported.ok).toBe(true)
    const added = await app.dispatchTo(tab, {
      command: 'node.add',
      params: {
        graphId: 'root', type: '#regionBody', values: { item: [] },
        position: { x: 500, y: 300 },
        region: { kind: 'map', elementPorts: ['item'] },
      },
    } as any)
    expect(added.ok).toBe(true)
    const occurrenceId = Object.keys(tab.store.doc.graphs.root!.nodes).find((id) => tab.store.doc.graphs.root!.nodes[id]!.region !== undefined)!
    const selected: string[][] = []

    expect(await flattenSubgraphThroughBridge({
      document: tab.store.doc,
      graphId: 'root',
      instancePath: [],
      nodeId: occurrenceId,
      occurrence: undefined,
      resolveSchema: (type) => type === schema.type ? schema : undefined,
      seedControllerEnabled: true,
      measure: (text) => text.length * 7,
      widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
      report: (diagnostic) => app.reportProblems(tab.id, [diagnostic]),
      dispatch: (invocation) => app.dispatchTo(tab, invocation),
      selectNodes: (ids) => selected.push([...ids]),
    })).toBe(false)
    expect(selected).toEqual([])
    const refusal = app.problems.get().find((problem) => problem.code === 'subgraph.flatten.regionUnsupported')!
    expect(refusal).toMatchObject({
      owner: tab.id,
      code: 'subgraph.flatten.regionUnsupported',
      message: 'subgraph.flatten: occurrence shell mode or region contract cannot be flattened',
      refs: [{ graphId: 'root', nodeId: occurrenceId }],
      anchor: { occurrence: { instancePath: [], node: occurrenceId } },
    })
    activateProblem(app, refusal)
    expect(app.diagnosticFocus.get()).toMatchObject({
      tab,
      anchor: { occurrence: { instancePath: [], node: occurrenceId } },
    })
  })

  it('reports actionable bridge planning failures instead of swallowing them', async () => {
    const doc = document() as any
    doc.graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 0 }
    doc.view.graphs.body = { nodes: {} }
    doc.graphs.root.nodes.inside.type = '#body'
    const reports: Diagnostic[] = []
    expect(await flattenSubgraphThroughBridge({
      document: doc,
      graphId: 'root',
      instancePath: [],
      nodeId: 'inside',
      occurrence: undefined,
      resolveSchema: () => schema,
      seedControllerEnabled: true,
      measure: (text) => text.length * 7,
      widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
      report: (diagnostic) => reports.push(diagnostic),
      dispatch: () => { throw new Error('dispatch must not run') },
      selectNodes: () => { throw new Error('selection must not change') },
    })).toBe(false)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.flatten: occurrence geometry could not be resolved',
      refs: [{ graphId: 'root', nodeId: 'inside' }],
      anchor: { occurrence: { instancePath: [], node: 'inside' } },
    })])

    reports.length = 0
    expect(extractSubgraphInvocationThroughBridge({
      document: doc,
      graphId: 'root',
      instancePath: [],
      selection: {
        nodeIds: ['missing'],
        geometry: [{ id: 'missing', kind: 'node', x: 0, y: 0, width: 100, height: 50 }],
      },
      resolveSchema: () => schema,
      report: (diagnostic) => reports.push(diagnostic),
    })).toBeUndefined()
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.extract: selection geometry or schema plan could not be resolved',
    })])

    reports.length = 0
    const throwingDocument = new Proxy(doc, {
      get(target, property, receiver) {
        if (property === 'graphs') throw new Error('broken document view')
        return Reflect.get(target, property, receiver)
      },
    })
    expect(extractSubgraphInvocationThroughBridge({
      document: throwingDocument,
      graphId: 'root',
      instancePath: [],
      selection: { nodeIds: ['inside'], geometry: [{ id: 'inside', kind: 'node', x: 0, y: 0, width: 100, height: 50 }] },
      resolveSchema: () => schema,
      report: (diagnostic) => reports.push(diagnostic),
    })).toBeUndefined()
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.extract: selection planning failed: broken document view',
    })])
  })

  it('reports every flatten dispatch and post-commit failure arm', async () => {
    const doc = document() as any
    doc.graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 0 }
    doc.view.graphs.body = { nodes: {} }
    doc.graphs.root.nodes.inside.type = '#body'
    const reports: Diagnostic[] = []
    const run = (dispatch: () => CommandOutcome | Promise<CommandOutcome>, selectNodes: () => void = () => {}): Promise<boolean> => flattenSubgraphThroughBridge({
      document: doc,
      graphId: 'root',
      instancePath: [],
      nodeId: 'inside',
      occurrence: { id: 'inside', kind: 'node', x: 20, y: 20, width: 140, height: 80 },
      resolveSchema: () => schema,
      seedControllerEnabled: true,
      measure: (text) => text.length * 7,
      widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
      report: (diagnostic) => reports.push(diagnostic),
      dispatch,
      selectNodes,
    })

    const refusal = diag('error', 'command', 'test.refusal', 'named dispatch refusal')
    expect(await run(() => ({ ok: false, diagnostics: [refusal] }))).toBe(false)
    expect(reports).toEqual([refusal])

    reports.length = 0
    expect(await run(() => ({ ok: false, diagnostics: [] }))).toBe(false)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.flatten: command was refused without diagnostics',
    })])

    reports.length = 0
    expect(await run(() => { throw new Error('transport exploded') })).toBe(false)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.flatten: dispatch failed: transport exploded',
    })])

    reports.length = 0
    expect(await run(() => Promise.reject(new Error('async transport failed')))).toBe(false)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.flatten: dispatch failed: async transport failed',
    })])

    reports.length = 0
    expect(await run(
      () => ({ ok: true, doc, forward: [], inverse: [], diagnostics: [] }),
      () => { throw new Error('selection exploded') },
    )).toBe(true)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.selectionUpdateFailed',
      message: 'Flattened subgraph selection: selection exploded',
    })])
  })

  it('commits with the collision-safe default name and excludes an unrelated concurrent node from selection', async () => {
    const doc = document()
    const geometry = [{ id: 'inside', kind: 'node' as const, x: 20, y: 20, width: 140, height: 80 }]
    const invocation = extractInvocation(doc, 'root', [], { nodeIds: ['inside'], geometry }, undefined, () => schema)!
    const dispatches: any[] = []

    const concurrent = structuredClone(doc) as any
    concurrent.graphs.root.nodes.foreign = { id: 'foreign', type: 'Plain', values: {} }
    concurrent.view.graphs.root.nodes.foreign = { position: { x: 700, y: 20 } }
    const session = createLocalSession(concurrent, coreCommandRegistry([], () => schema))
    const result = await commitExtract({
      invocation,
      beforeNodeIds: new Set(['inside', 'outside', 'foreign']),
      graphId: 'root',
      dispatch: (value) => { dispatches.push(value); return session.dispatch(value) },
    })
    expect(result.status).toBe('committed')
    expect(result.selectedNodeIds).toEqual(['n10'])
    expect((dispatches[0]!.params as any).name).toBeUndefined()
    expect(result.status === 'committed' && result.outcome.doc.graphs.g0?.name).toBe('New Subgraph')
  })

  it.each([true, false])('awaits extraction acceptance=%s before returning committed ids', async (accepted) => {
    const doc = document()
    const session = createLocalSession(doc, coreCommandRegistry([], () => schema))
    const before = session.doc
    const invocation = extractInvocation(doc, 'root', [], {
      nodeIds: ['inside'], geometry: [{ id: 'inside', kind: 'node', x: 20, y: 20, width: 140, height: 80 }],
    }, undefined, () => schema)!
    let complete!: (outcome: CommandOutcome) => void
    let settled = false
    const pending = commitExtract({
      invocation, beforeNodeIds: new Set(['inside', 'outside']), graphId: 'root',
      dispatch: () => new Promise((resolve) => { complete = resolve }),
    }).then((result) => { settled = true; return result })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(session.doc).toBe(before)
    complete(accepted ? session.dispatch(invocation) : { ok: false, diagnostics: [] })
    const result = await pending
    expect(result.status).toBe(accepted ? 'committed' : 'refused')
    expect(result.selectedNodeIds).toEqual(accepted ? ['n10'] : [])
    expect(Object.keys(session.doc.graphs.root!.nodes).sort()).toEqual(accepted ? ['n10', 'outside'] : ['inside', 'outside'])
  })

  it.each([true, false])('awaits flatten acceptance=%s before selecting committed nodes', async (accepted) => {
    const doc = document()
    const session = createLocalSession(doc, coreCommandRegistry([], () => schema), {
      schemaResolverFor: (current) => documentResolver(current, () => schema),
    })
    const extract = extractInvocation(doc, 'root', [], {
      nodeIds: ['inside'], geometry: [{ id: 'inside', kind: 'node', x: 20, y: 20, width: 140, height: 80 }],
    }, undefined, () => schema)!
    expect(session.dispatch(extract).ok).toBe(true)
    const before = session.doc
    let complete!: (accepted: boolean) => void
    const selected: string[][] = []
    const reports: Diagnostic[] = []
    const pending = flattenSubgraphThroughBridge({
      document: before, graphId: 'root', instancePath: [], nodeId: 'n10',
      occurrence: { id: 'n10', kind: 'node', x: 20, y: 20, width: 140, height: 80 },
      resolveSchema: () => schema, seedControllerEnabled: true,
      measure: (text) => text.length * 7, widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
      report: (diagnostic) => reports.push(diagnostic),
      dispatch: (invocation) => new Promise((resolve) => {
        complete = (ok) => {
          const outcome = ok ? session.dispatch(invocation) : { ok: false as const, diagnostics: [] }
          if (ok) expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
          resolve(outcome)
        }
      }),
      selectNodes: (ids) => selected.push([...ids]),
    })
    await Promise.resolve()
    expect(selected).toEqual([])
    expect(reports).toEqual([])
    expect(session.doc).toBe(before)
    complete(accepted)
    expect(await pending).toBe(accepted)
    expect(selected).toEqual(accepted ? [['n11']] : [])
    expect(Object.keys(session.doc.graphs.root!.nodes).sort()).toEqual(accepted ? ['n11', 'outside'] : ['n10', 'outside'])
    expect(reports.length).toBe(accepted ? 0 : 1)
  })
})
