import { describe, expect, it } from 'vitest'
import { asConnectionId, checkDocument, compile, diag, DocumentStore, loadDocument, planClipboardPaste, serializeSelection, documentResolver, coreCommandRegistry, createLocalSession, type CommandOutcome, type Diagnostic, type NodeSchema, type WorkflowDocument, boundaryOf, boundaryItems } from '@dinkster/core'
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
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
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
    ;(doc as any).graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, boundary: boundaryOf([], []), nextOrdinal: 0 }
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
            links: {}, nets: {}, reroutes: {},
            boundary: {
              body: [
                { kind: 'input', id: 'item', binds: { kind: 'port', node: 'n0', port: 'item' } },
                { kind: 'output', id: 'result', binds: { kind: 'port', node: 'n0', port: 'result' } },
              ],
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
    doc.graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, boundary: boundaryOf([], []), nextOrdinal: 0 }
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
    doc.graphs.body = { id: 'body', name: 'Body', nodes: {}, links: {}, nets: {}, reroutes: {}, boundary: boundaryOf([], []), nextOrdinal: 0 }
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

describe('whole constructs shown on a subgraph node through two levels', () => {
  const IMAGE = { kind: 'concrete', name: 'IMAGE' } as const
  const FLOAT = { kind: 'concrete', name: 'FLOAT' } as const
  const STRING = { kind: 'concrete', name: 'STRING' } as const
  const node = (type: string, body: NodeSchema['body']): NodeSchema => ({
    type, displayName: type, category: 'test', source: 'v3', isOutputNode: true, body,
  })
  const floatField = (id: string, def: number) => ({
    kind: 'input', id, type: FLOAT, optional: true, widget: { widgetType: 'FLOAT', options: {}, default: def },
  }) as const
  const schemas: Record<string, NodeSchema> = {
    Src: node('Src', [{ kind: 'output', id: 'out', type: IMAGE }]),
    Sink: node('Sink', [{ kind: 'input', id: 'in', type: IMAGE, optional: false }]),
    Weigh: node('Weigh', [
      { kind: 'group', id: 'weights', value: floatField('w', 0.5), keys: { kind: 'numbered', prefix: 'w', start: 0, pad: 0 }, grows: 'link', minMembers: 0, maxMembers: 8 },
      { kind: 'output', id: 'out', type: IMAGE },
    ]),
    Batch: node('Batch', [
      { kind: 'group', id: 'images', value: { kind: 'input', id: 'image', type: IMAGE, optional: true }, keys: { kind: 'numbered', prefix: 'image', start: 0, pad: 0 }, grows: 'link', minMembers: 0, maxMembers: 8 },
    ]),
    Mode: node('Mode', [{
      kind: 'choice', id: 'mode', required: true, shared: [],
      options: [
        { key: 'image', rows: [floatField('strength', 0.3)] },
        { key: 'text', rows: [{ kind: 'input', id: 'words', type: STRING, optional: false, widget: { widgetType: 'STRING', options: {}, default: '' } }] },
      ],
    }]),
  }
  const resolveSchema = (type: string) => schemas[type]
  const empty = { links: {}, nets: {}, reroutes: {}, nextOrdinal: 100 }
  const construct = (id: string, node: string, port: string) => ({ id, binds: { kind: 'construct', node, port } })
  const fixture = (mode: 'active' | 'muted' | 'bypassed' = 'active'): WorkflowDocument => ({
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'lineage' as never, root: 'root' as never,
    graphs: {
      root: {
        id: 'root' as never, name: 'Root', ...empty,
        nodes: {
          a: { id: 'a' as never, type: 'Src', values: {} },
          first: {
            id: 'first' as never, type: '#portrait', ...(mode === 'active' ? {} : { mode }),
            dynamic: { mix: { members: ['w0', 'w1'] }, pics: { members: ['image0'] }, look: { selected: 'text' } },
            values: { 'mix.w0': 0.2, 'mix.w1': 0.8, 'look.words': 'portrait' },
          },
          second: { id: 'second' as never, type: '#portrait', dynamic: { mix: { members: ['w0'] } }, values: { 'mix.w0': 0.9 } },
          k: { id: 'k' as never, type: 'Sink', values: {} },
        },
        links: {
          l1: { id: 'l1' as never, from: { node: 'a', port: 'out' } as never, to: { node: 'first', port: 'pics.image0' } as never },
          l2: { id: 'l2' as never, from: { node: 'first', port: 'out' } as never, to: { node: 'k', port: 'in' } as never },
        },
      },
      portrait: {
        id: 'portrait' as never, name: 'Portrait fix', ...empty,
        nodes: {
          d: {
            id: 'd' as never, type: '#detail',
            dynamic: { weights: { members: ['w0'] }, mode: { selected: 'image' } },
            values: { 'weights.w0': 0.6, 'mode.strength': 0.6 },
          },
        },
        boundary: {
          body: [
            { kind: 'input', ...construct('mix', 'd', 'weights') },
            { kind: 'input', ...construct('pics', 'd', 'imgs') },
            { kind: 'input', ...construct('look', 'd', 'mode') },
            { kind: 'output', id: 'out', binds: { kind: 'port', node: 'd', port: 'out' } },
          ],
        } as never,
      },
      detail: {
        id: 'detail' as never, name: 'Detail pass', ...empty,
        nodes: {
          n: { id: 'n' as never, type: 'Weigh', dynamic: { weights: { members: ['w0', 'w1'] } }, values: { 'weights.w0': 0.1, 'weights.w1': 0.15 } },
          b: { id: 'b' as never, type: 'Batch', values: {} },
          m: { id: 'm' as never, type: 'Mode', dynamic: { mode: { selected: 'image' } }, values: { 'mode.strength': 0.4, 'mode.words': 'kept' } },
        },
        boundary: {
          body: [
            { kind: 'input', ...construct('weights', 'n', 'weights') },
            { kind: 'input', ...construct('imgs', 'b', 'images') },
            { kind: 'input', ...construct('mode', 'm', 'mode') },
            { kind: 'output', id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } },
          ],
        } as never,
      },
    },
    view: { graphs: {
      root: { nodes: { a: { position: { x: 0, y: 0 } }, first: { position: { x: 200, y: 0 } }, second: { position: { x: 200, y: 300 } }, k: { position: { x: 500, y: 0 } } } },
      portrait: { nodes: { d: { position: { x: 0, y: 0 } } } },
      detail: { nodes: { n: { position: { x: 0, y: 0 } }, b: { position: { x: 0, y: 200 } }, m: { position: { x: 0, y: 400 } } } },
    } },
  })

  /** Each run node by type, with wires named by their source's type and output, sorted: prompt ids change on flatten. */
  const runOf = (doc: WorkflowDocument) => {
    const result = compile({
      document: doc, revision: 1, resolve: resolveSchema, scope: { kind: 'full' },
      connection: asConnectionId('c0'), schemaHash: 'test',
    })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const prompt = result.artifact.prompt
    return Object.values(prompt).map((entry) => JSON.stringify({
      ...entry,
      inputs: Object.fromEntries(Object.entries(entry.inputs).map(([key, value]) =>
        [key, Array.isArray(value) ? [prompt[value[0] as string]!.class_type, value[1]] : value])),
    })).sort()
  }

  const flatten = async (doc: WorkflowDocument, graphId: string, instancePath: readonly string[], nodeId: string) => {
    const session = createLocalSession(doc, coreCommandRegistry(), { schemaResolverFor: () => documentResolver(doc, resolveSchema) })
    const reports: Diagnostic[] = []
    const ok = await flattenSubgraphThroughBridge({
      document: doc, graphId, instancePath, nodeId,
      occurrence: { id: nodeId, kind: 'node', x: 200, y: 0, width: 140, height: 120 },
      resolveSchema, seedControllerEnabled: true,
      measure: (text) => text.length * 7, widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
      report: (diagnostic) => reports.push(diagnostic),
      dispatch: (invocation) => session.dispatch(invocation),
      selectNodes: () => {},
    })
    return { ok, reports, session }
  }

  it('flattening the outer subgraph node keeps every run input, member order and pick', async () => {
    const doc = fixture()
    const before = runOf(doc)
    // The first node's weights: the inner definition's two, the middle one's, then its own two.
    expect(before.filter((entry) => entry.includes('"class_type":"Weigh"'))).toContainEqual(expect.stringContaining('"weights.w0":0.1,"weights.w1":0.15,"weights.w2":0.6,"weights.w3":0.2,"weights.w4":0.8'))
    const { ok, reports, session } = await flatten(doc, 'root', [], 'first')
    expect(ok, JSON.stringify(reports)).toBe(true)
    expect(checkDocument(session.doc)).toEqual([])
    const flattened = Object.values(session.doc.graphs.root!.nodes).find((entry) => entry.type === '#detail')!
    // The middle definition's member first, then the outer node's, renumbered past it.
    expect(flattened.dynamic?.['weights']?.members).toEqual(['w0', 'w1', 'w2'])
    expect(flattened.values).toEqual({ 'weights.w0': 0.6, 'weights.w1': 0.2, 'weights.w2': 0.8, 'mode.strength': 0.6, 'mode.words': 'portrait' })
    expect(flattened.dynamic?.['mode']?.selected).toBe('text')
    expect(Object.values(session.doc.graphs.root!.links).map((entry) => entry.to)).toContainEqual({ node: flattened.id, port: 'imgs.image0' })
    expect(runOf(session.doc)).toEqual(before)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs).toEqual({ ...doc.graphs, root: { ...doc.graphs.root, nextOrdinal: session.doc.graphs.root!.nextOrdinal } })
  })

  it('flattening the middle node rewrites the outer boundary and keeps both uses running the same', async () => {
    const doc = fixture()
    const before = runOf(doc)
    const { ok, reports, session } = await flatten(doc, 'portrait', ['first'], 'd')
    expect(ok, JSON.stringify(reports)).toBe(true)
    expect(checkDocument(session.doc)).toEqual([])
    const portrait = session.doc.graphs.portrait!
    const weigh = Object.values(portrait.nodes).find((entry) => entry.type === 'Weigh')!
    expect(boundaryItems(portrait.boundary, 'inputs')[0]!.binds).toEqual({ kind: 'construct', node: weigh.id, port: 'weights' })
    expect(weigh.dynamic?.['weights']?.members).toEqual(['w0', 'w1', 'w2'])
    expect(weigh.values).toEqual({ 'weights.w0': 0.1, 'weights.w1': 0.15, 'weights.w2': 0.6 })
    expect(runOf(session.doc)).toEqual(before)
  })

  it('a muted subgraph node flattens to the same run, and a bypassed one is refused', async () => {
    const muted = fixture('muted')
    const before = runOf(muted)
    const flattened = await flatten(muted, 'root', [], 'first')
    expect(flattened.ok, JSON.stringify(flattened.reports)).toBe(true)
    expect(Object.values(flattened.session.doc.graphs.root!.nodes).find((entry) => entry.type === '#detail')!.mode).toBe('muted')
    expect(runOf(flattened.session.doc)).toEqual(before)

    const bypassed = fixture('bypassed')
    const refused = await flatten(bypassed, 'root', [], 'first')
    expect(refused.ok).toBe(false)
    expect(refused.session.doc).toEqual(bypassed)
    expect(refused.session.canUndo).toBe(false)
  })

  it('extracting the inner nodes inside the definition keeps them shown whole through the new subgraph node', () => {
    const doc = fixture()
    const before = runOf(doc)
    const geometry = [
      { id: 'n', kind: 'node' as const, x: 0, y: 0, width: 140, height: 120 },
      { id: 'm', kind: 'node' as const, x: 0, y: 400, width: 140, height: 80 },
    ]
    const invocation = extractInvocation(doc, 'detail', ['first', 'd'], { nodeIds: ['n', 'm'], geometry }, 'Inner', resolveSchema)!
    const session = createLocalSession(doc, coreCommandRegistry([], (type) => documentResolver(session.doc, resolveSchema)(type)))
    const outcome = session.dispatch(invocation)
    expect(outcome.ok, JSON.stringify(!outcome.ok && outcome.diagnostics)).toBe(true)
    expect(checkDocument(session.doc)).toEqual([])
    const detail = session.doc.graphs.detail!
    const occurrence = Object.values(detail.nodes).find((entry) => entry.type.startsWith('#'))!
    const inner = session.doc.graphs[occurrence.type.slice(1)]!
    expect(boundaryItems(detail.boundary, 'inputs').map((item) => item.binds)).toEqual([
      { kind: 'construct', node: occurrence.id, port: expect.any(String) },
      { kind: 'construct', node: 'b', port: 'images' },
      { kind: 'construct', node: occurrence.id, port: expect.any(String) },
    ])
    expect(boundaryItems(inner.boundary, 'inputs').map((item) => item.binds.kind)).toEqual(['construct', 'construct'])
    expect(runOf(session.doc)).toEqual(before)
  })

  it('extracting a node whose shown construct also takes a wire from outside the selection is refused', () => {
    const doc = fixture()
    const detail = doc.graphs.detail!
    const wired: WorkflowDocument = { ...doc, graphs: { ...doc.graphs, detail: {
      ...detail,
      nodes: { ...detail.nodes, src: { id: 'src' as never, type: 'Src', values: {} } },
      links: { w: { id: 'w' as never, from: { node: 'src', port: 'out' } as never, to: { node: 'b', port: 'images.image0' } as never } },
    } }, view: { graphs: { ...doc.view.graphs, detail: { nodes: { ...doc.view.graphs.detail!.nodes, src: { position: { x: -300, y: 200 } } } } } } }
    const geometry = [{ id: 'b', kind: 'node' as const, x: 0, y: 200, width: 140, height: 80 }]
    const invocation = extractInvocation(wired, 'detail', ['first', 'd'], { nodeIds: ['b'], geometry }, 'Inner', resolveSchema)
    const session = createLocalSession(wired, coreCommandRegistry([], (type) => documentResolver(session.doc, resolveSchema)(type)))
    const outcome = invocation === undefined ? undefined : session.dispatch(invocation)
    expect(outcome?.ok ?? false).toBe(false)
    expect(session.doc).toEqual(wired)
  })

  it('a saved and reopened document, and a pasted copy in a new one, run the same', () => {
    const doc = fixture()
    const before = runOf(doc)
    const reopened = loadDocument(JSON.parse(JSON.stringify(doc)))
    expect(reopened.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([])
    expect(runOf(reopened.document!)).toEqual(before)

    const envelope = serializeSelection(doc, 'root', { nodes: ['a', 'first', 'k'], reroutes: [] })!
    const target: WorkflowDocument = {
      ...doc,
      lineage: 'other' as never,
      graphs: { root: { ...doc.graphs.root!, nodes: {}, links: {} } },
      view: { graphs: { root: { nodes: {} } } },
    }
    const store = new DocumentStore(target, coreCommandRegistry())
    expect(store.dispatch(planClipboardPaste(target, 'root', envelope, { x: 0, y: 0 })!.invocation).ok).toBe(true)
    expect(checkDocument(store.doc)).toEqual([])
    // Only the first node was copied, so the run is the original's without the second node's nodes.
    const second = runOf({ ...doc, graphs: { ...doc.graphs, root: { ...doc.graphs.root!, nodes: Object.fromEntries(Object.entries(doc.graphs.root!.nodes).filter(([id]) => id !== 'second')) } } })
    expect(runOf(store.doc)).toEqual(second)
  })

  it('detaching one use keeps the other use and its definition unchanged', () => {
    const doc = fixture()
    const before = runOf(doc)
    const session = createLocalSession(doc, coreCommandRegistry())
    expect(session.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    const detached = session.doc.graphs.root!.nodes.first!.type
    expect(detached).not.toBe('#portrait')
    expect(session.doc.graphs.root!.nodes.second!.type).toBe('#portrait')
    expect(session.doc.graphs.portrait).toEqual(doc.graphs.portrait)
    expect(runOf(session.doc)).toEqual(before)
    // An edit to the detached copy reaches only the first node's run.
    const copy = detached.slice(1)
    expect(session.dispatch({ command: 'node.setValue', params: { graphId: copy, nodeId: 'd', inputId: 'weights.w0', value: 0.7 } }).ok).toBe(true)
    const after = runOf(session.doc)
    expect(after.filter((entry) => entry.includes('"weights.w2":0.7'))).toHaveLength(1)
    expect(after.filter((entry) => entry.includes('"weights.w2":0.6'))).toHaveLength(1)
  })
})
