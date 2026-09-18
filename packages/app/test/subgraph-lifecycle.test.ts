import { describe, expect, it } from 'vitest'
import { diag, documentResolver, occurrenceDynamicView, coreCommandRegistry, createLocalSession, type CommandOutcome, type Diagnostic, type NodeSchema, type WorkflowDocument } from '@dinkster/core'
import { buildScene, defaultTokens } from '@dinkster/canvas'
import { AppState } from '../src/app-state.js'
import { extractSubgraphInvocationThroughBridge, flattenSubgraphThroughBridge, lifecycleOtherSelectionCount } from '../src/CanvasHost.js'
import { activateProblem } from '../src/ProblemsPanel.js'
import { commitExtract, extractInvocation, flattenInvocation, hasExtractSelection, isFlattenSelection } from '../src/subgraph-lifecycle.js'

;(globalThis as { location?: unknown }).location = { protocol: 'http:', host: 'test' }

const schema: NodeSchema = {
  type: 'Plain', displayName: 'Plain', category: 'test', source: 'v3', isOutputNode: false, items: [],
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
      items: [
        { kind: 'input', id: 'model', type: { kind: 'concrete', name: 'core.combo' }, optional: false, widget: { widgetType: 'COMBO', options: { options: ['Automatic'] } } },
        { kind: 'input', id: 'provider', type: { kind: 'concrete', name: 'core.combo' }, optional: true, widget: { widgetType: 'COMBO', options: { options: ['vision.depth.v2'] } }, hidden: true },
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

  it('counts a selected net view as other selection for flatten eligibility', () => {
    const empty = new Set<string>()
    const controller = {
      getLinkSelection: () => empty,
      getRerouteSelection: () => empty,
      getValueSourceSelection: () => empty,
      getSelectorSelection: () => empty,
      getGroupSelection: () => empty,
      getNetViewSelection: () => new Set(['get-view']),
    }
    expect(lifecycleOtherSelectionCount(controller)).toBe(1)
  })

  it('surfaces the real region flatten refusal with its anchored occurrence', () => {
    const app = new AppState()
    const backend = app.backends.get()[0]!
    backend.registry.set({
      connection: backend.id,
      hash: 'region-bridge-test',
      schemas: new Map([[schema.type, schema]]),
      diagnostics: [],
      resolve: (type) => type === schema.type ? schema : undefined,
    })
    expect(app.openDocument(document(), 'Region bridge')).toEqual([])
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
    const added = tab.store.dispatch({
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

    expect(flattenSubgraphThroughBridge({
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

  it('reports actionable bridge planning failures instead of swallowing them', () => {
    const doc = document() as any
    doc.graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 0 }
    doc.view.graphs.body = { nodes: {} }
    doc.graphs.root.nodes.inside.type = '#body'
    const reports: Diagnostic[] = []
    expect(flattenSubgraphThroughBridge({
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

  it('reports every flatten dispatch and post-commit failure arm', () => {
    const doc = document() as any
    doc.graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, boundary: { inputs: [], outputs: [] }, nextOrdinal: 0 }
    doc.view.graphs.body = { nodes: {} }
    doc.graphs.root.nodes.inside.type = '#body'
    const reports: Diagnostic[] = []
    const run = (dispatch: () => CommandOutcome, selectNodes: () => void = () => {}): boolean => flattenSubgraphThroughBridge({
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
    expect(run(() => ({ ok: false, diagnostics: [refusal] }))).toBe(false)
    expect(reports).toEqual([refusal])

    reports.length = 0
    expect(run(() => ({ ok: false, diagnostics: [] }))).toBe(false)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.flatten: command was refused without diagnostics',
    })])

    reports.length = 0
    expect(run(() => { throw new Error('transport exploded') })).toBe(false)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.boundaryUnresolved',
      message: 'subgraph.flatten: dispatch failed: transport exploded',
    })])

    reports.length = 0
    expect(run(
      () => ({ ok: true, doc, forward: [], inverse: [], diagnostics: [] }),
      () => { throw new Error('selection exploded') },
    )).toBe(true)
    expect(reports).toEqual([expect.objectContaining({
      code: 'subgraph.lifecycle.selectionUpdateFailed',
      message: 'subgraph.flatten: document committed but result selection failed: selection exploded',
    })])
  })

  it('commits immediately with the collision-safe default name and excludes an unrelated concurrent node from selection', () => {
    const doc = document()
    const geometry = [{ id: 'inside', kind: 'node' as const, x: 20, y: 20, width: 140, height: 80 }]
    const invocation = extractInvocation(doc, 'root', [], { nodeIds: ['inside'], geometry }, undefined, () => schema)!
    const dispatches: any[] = []

    const concurrent = structuredClone(doc) as any
    concurrent.graphs.root.nodes.foreign = { id: 'foreign', type: 'Plain', values: {} }
    concurrent.view.graphs.root.nodes.foreign = { position: { x: 700, y: 20 } }
    const session = createLocalSession(concurrent, coreCommandRegistry([], () => schema))
    const result = commitExtract({
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

  it('uses occurrence-resolved dynamic layout height when placing flattened body nodes', () => {
    const familySchema: NodeSchema = {
      type: 'Family', displayName: 'Family', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'items', type: { kind: 'concrete', name: 'STRING' }, optional: true,
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'value', type: { kind: 'concrete', name: 'STRING' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'item', min: 0, max: 8 },
        },
      }],
    }
    const doc = document() as any
    doc.graphs.root.nodes = { occurrence: { id: 'occurrence', type: '#body', values: {}, dynamic: { forwarded: { members: ['m0'] } } } }
    doc.graphs.root.nextOrdinal = 20
    doc.view.graphs.root.nodes = { occurrence: { position: { x: 500, y: 300 }, size: { width: 180, height: 100 } } }
    doc.graphs.body = {
      id: 'body', name: 'Body',
      nodes: { bodyNode: { id: 'bodyNode', type: 'Family', values: {} } },
      links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 1,
      boundary: { inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'bodyNode', port: 'items' } }], outputs: [] },
    }
    doc.view.graphs.body = { nodes: { bodyNode: { position: { x: 0, y: 0 } } } }
    const resolveSchema = (type: string) => type === 'Family' ? familySchema : undefined
    const resolve = documentResolver(doc, resolveSchema)
    const measure = (text: string) => text.length * 7
    const widgetMeasure = () => ({ viewId: 'core.line', rows: 1 })
    const definition = buildScene({ document: doc, graphId: 'body', resolve, tokens: defaultTokens, measure, widgetMeasure })
    const resolved = buildScene({
      document: doc, graphId: 'body', resolve, tokens: defaultTokens, measure, widgetMeasure,
      occurrenceView: occurrenceDynamicView(doc, resolve, ['occurrence']),
    })
    expect(resolved.nodes[0]!.layout.height).toBeGreaterThan(definition.nodes[0]!.layout.height)
    const occurrence = { id: 'occurrence', kind: 'node' as const, x: 410, y: 250, width: 180, height: 100 }
    const bodyGeometry = [{
      id: 'bodyNode', kind: 'node' as const, x: resolved.nodes[0]!.x, y: resolved.nodes[0]!.y,
      width: resolved.nodes[0]!.layout.width, height: resolved.nodes[0]!.layout.height,
    }]
    const invocation = flattenInvocation(doc, 'root', [], 'occurrence', occurrence, bodyGeometry, resolveSchema)!
    const session = createLocalSession(doc, coreCommandRegistry([], resolveSchema), {
      schemaResolverFor: (currentDoc) => documentResolver(currentDoc, resolveSchema),
    })
    expect(session.dispatch(invocation).ok).toBe(true)
    expect(session.doc.view.graphs.root!.nodes.n20!.position).toEqual({
      x: 500 - resolved.nodes[0]!.layout.width / 2,
      y: 300 - resolved.nodes[0]!.layout.height / 2,
    })
  })

  it('exports, reopens, and drills through a grouped forwarded autogrow member without changing identity', () => {
    const image = { kind: 'concrete', name: 'IMAGE' } as const
    const sourceSchema: NodeSchema = {
      type: 'Source', displayName: 'Source', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'output', id: 'out', type: image }],
    }
    const groupedSchema: NodeSchema = {
      type: 'Grouped', displayName: 'Grouped', category: 'test', source: 'v3', isOutputNode: false,
      items: [{
        kind: 'input', id: 'pairs', type: image, optional: true,
        dynamic: {
          kind: 'autogrow',
          template: [
            { kind: 'input', id: 'image', type: image, optional: true },
            { kind: 'input', id: 'mask', type: image, optional: true },
          ],
          naming: { kind: 'prefix', prefix: 'pair', min: 0, max: 4 },
        },
      }],
    }
    const schemas = new Map([[sourceSchema.type, sourceSchema], [groupedSchema.type, groupedSchema]])
    const configure = (app: AppState) => {
      const backend = app.backends.get()[0]!
      backend.registry.set({
        connection: backend.id, hash: 'autogrow-export-open', schemas, diagnostics: [],
        resolve: (type) => schemas.get(type),
      })
    }
    const doc = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'autogrow-export-open', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root',
          nodes: {
            source: { id: 'source', type: 'Source', values: {} },
            occurrence: { id: 'occurrence', type: '#body', values: {} },
          },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 1,
        },
        body: {
          id: 'body', name: 'Body',
          nodes: { grouped: { id: 'grouped', type: 'Grouped', values: {} } },
          links: {}, nets: {}, reroutes: {}, valueSources: {}, selectors: {}, nextOrdinal: 1,
          boundary: {
            inputs: [{ id: 'forwarded', binds: { kind: 'family', node: 'grouped', port: 'pairs' } }],
            outputs: [],
          },
        },
      },
      view: { graphs: { root: { nodes: {} }, body: { nodes: {} } } },
    } as unknown as WorkflowDocument

    const app = new AppState()
    configure(app)
    expect(app.openDocument(doc, 'Autogrow export')).toEqual([])
    const tab = app.activeTab()!
    expect(tab.store.dispatch({
      command: 'batch',
      params: { invocations: [
        {
          command: 'dynamic.materialize',
          params: { graphId: 'root', nodeId: 'occurrence', frames: [{ construct: 'forwarded', members: ['m0'] }] },
        },
        {
          command: 'link.connect',
          params: {
            graphId: 'root', from: { node: 'source', port: 'out' },
            to: { node: 'occurrence', port: 'forwarded.image', members: ['m0'] },
          },
        },
      ] },
    } as any).ok).toBe(true)

    const exported = app.exportDocument(tab.id)!
    const reopenedApp = new AppState()
    configure(reopenedApp)
    expect(reopenedApp.openDocument(JSON.parse(JSON.stringify(exported)), 'Autogrow reopened')).toEqual([])
    const reopened = reopenedApp.activeTab()!
    expect(reopened.store.doc.graphs.root!.nodes.occurrence!.dynamic).toEqual({
      forwarded: { members: ['m0'], seq: 1 },
    })
    expect(Object.values(reopened.store.doc.graphs.root!.links)[0]!.to).toEqual({
      node: 'occurrence', port: 'forwarded.image', members: ['m0'],
    })

    const resolver = documentResolver(reopened.store.doc, (type) => schemas.get(type))
    const rootScene = buildScene({
      document: reopened.store.doc, graphId: 'root', resolve: resolver, tokens: defaultTokens,
      measure: (text) => text.length * 7, widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
    })
    const drilledScene = buildScene({
      document: reopened.store.doc, graphId: 'body', resolve: resolver, tokens: defaultTokens,
      measure: (text) => text.length * 7, widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
      occurrenceView: occurrenceDynamicView(reopened.store.doc, resolver, ['occurrence']),
    })
    expect(rootScene.nodes.find((node) => node.id === 'occurrence')!.layout.pins
      .some((pin) => pin.address.members?.[0] === 'm0' && !pin.ghost)).toBe(true)
    expect(drilledScene.nodes.find((node) => node.id === 'grouped')!.layout.pins
      .some((pin) => pin.address.members?.[0] === '\u0000m0' && !pin.ghost)).toBe(true)
    expect(Object.values(reopened.store.doc.graphs.root!.links)[0]!.to).toMatchObject({ members: ['m0'] })
  })
})
