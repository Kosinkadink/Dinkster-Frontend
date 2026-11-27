import { describe, expect, it } from 'vitest'
import { asConnectionId, checkDocument, compile, diag, DocumentStore, elaborateInterface, elabInputsOf, loadDocument, occurrenceDynamicView, parseDinksterSchema, planClipboardPaste, serializeSelection, documentResolver, documentNodeResolver, runPress, coreCommandRegistry, createLocalSession, type ActionHost, type CommandOutcome, type Diagnostic, type NodeSchema, type WorkflowDocument, boundaryOf, boundaryItems } from '@dinkster/core'
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
  const runOf = (doc: WorkflowDocument, resolve = resolveSchema) => {
    const result = compile({
      document: doc, revision: 1, resolve, scope: { kind: 'full' },
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

  const flatten = async (doc: WorkflowDocument, graphId: string, instancePath: readonly string[], nodeId: string, resolve = resolveSchema) => {
    const session = createLocalSession(doc, coreCommandRegistry(), { schemaResolverFor: () => documentResolver(doc, resolve) })
    const reports: Diagnostic[] = []
    const ok = await flattenSubgraphThroughBridge({
      document: doc, graphId, instancePath, nodeId,
      occurrence: { id: nodeId, kind: 'node', x: 200, y: 0, width: 140, height: 120 },
      resolveSchema: resolve, seedControllerEnabled: true,
      measure: (text) => text.length * 7, widgetMeasure: () => ({ viewId: 'core.line', rows: 1 }),
      report: (diagnostic) => reports.push(diagnostic),
      dispatch: (invocation) => session.dispatch(invocation),
      selectNodes: () => {},
    })
    return { ok, reports, session }
  }

  const { schema: picker } = parseDinksterSchema('Picker', { body: [
    { kind: 'input', id: 'category', type: { kind: 'concrete', types: ['COMBO'] }, pin: false, sent: false,
      widget: { type: 'COMBO', options: ['intrinsic', 'sd', 'sdxl', 'inner-other'] } },
    { kind: 'input', id: 'lora', type: { kind: 'concrete', types: ['COMBO'] },
      widget: { type: 'COMBO', options: { lookup: 'pack.loras', args: ['category'] } } },
    { kind: 'output', id: 'result', type: { kind: 'concrete', types: ['COMBO'] } },
  ] } as never)
  const remoteResolve = (type: string) => type === 'Picker' ? { ...picker!, isOutputNode: true }
    : type === 'AdapterSink' ? node('AdapterSink', [{ kind: 'input', id: 'adapter', type: { kind: 'concrete', name: 'COMBO' }, optional: true }])
      : type === 'Numeric' ? { ...node('Numeric', [floatField('amount', 0.3)]), isOutputNode: false } : undefined
  const remoteFixture = (depth: 1 | 2, fanout = false): WorkflowDocument => {
    const bind = (id: string, target: string, port: string) => ({
      kind: 'input', id, binds: { kind: 'port', node: target, port }, promoted: true,
    })
    const selection = depth === 1 ? 'pick' : 'list'
    const category = depth === 1 ? 'kind' : 'category'
    return {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'remote-lifecycle', root: 'root',
      graphs: {
        root: { id: 'root', name: 'Root', ...empty, nodes: {
          first: { id: 'first', type: depth === 1 ? '#detail' : '#portrait', values: { [category]: 'sd', [selection]: 'kept-first' } },
          second: { id: 'second', type: depth === 1 ? '#detail' : '#portrait', values: { [category]: 'sdxl', [selection]: 'kept-second' } },
          sink: { id: 'sink', type: 'AdapterSink', values: {} },
        }, links: { wire: { id: 'wire', from: { node: 'first', port: depth === 1 ? 'out' : 'result' }, to: { node: 'sink', port: 'adapter' } } } },
        detail: { id: 'detail', name: 'Detail', ...empty, nodes: {
          sample: { id: 'sample', type: 'Picker', values: { category: 'sd', lora: 'inner-selection' } },
          ...(fanout ? { other: { id: 'other', type: 'Picker', values: { category: 'inner-other', lora: 'other-selection' } },
            numeric: { id: 'numeric', type: 'Numeric', values: {} } } : {}),
        }, boundary: { body: [bind('kind', 'sample', 'category'), bind('pick', 'sample', 'lora'),
          { kind: 'output', id: 'out', binds: { kind: 'port', node: 'sample', port: 'result' } },
        ] } },
        ...(depth === 2 ? { portrait: { id: 'portrait', name: 'Portrait', ...empty,
          nodes: { detail: { id: 'detail', type: '#detail', values: { kind: 'sdxl', pick: 'middle-selection' } } },
          boundary: { body: [bind('category', 'detail', 'kind'), bind('list', 'detail', 'pick'),
            { kind: 'output', id: 'result', binds: { kind: 'port', node: 'detail', port: 'out' } },
          ] },
        } } : {}),
      }, view: { graphs: { root: { nodes: {} }, detail: { nodes: {} }, portrait: { nodes: {} } } },
    } as unknown as WorkflowDocument
  }
  const remotePrompt = (doc: WorkflowDocument, state: 'ready' | 'loading' | 'unavailable' = 'ready') => {
    const calls: unknown[] = []
    const result = compile({ document: doc, revision: 1, resolve: remoteResolve, scope: { kind: 'full' },
      connection: asConnectionId('remote-lifecycle'), schemaHash: 'remote-lifecycle', lookupAnswers: (lookup, args) => {
        calls.push([lookup, args])
        return state === 'ready' ? { state, answer: [`${args[0]}-option`] }
          : state === 'unavailable' ? { state, reason: 'offline' } : { state }
      } })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('remote option lifecycle document did not compile')
    return { prompt: result.artifact.prompt, calls }
  }
  const remoteSelection = (doc: WorkflowDocument, runtimeId: string) => {
    const path = runtimeId.split('.')
    const nodeId = path.pop()!
    const graphId = path.reduce((graph, hop) => doc.graphs[graph]!.nodes[hop]!.type.slice(1), doc.root as string)
    const current = doc.graphs[graphId]!.nodes[nodeId]!
    const view = occurrenceDynamicView(doc, remoteResolve, path)
    return elabInputsOf(elaborateInterface(picker!, { ...current, values: view.values.get(nodeId) ?? current.values }, undefined, {
      lookupAnswers: (_lookup, args) => ({ state: 'ready', answer: [`${args[0]}-option`] }),
    })).find((input) => input.spec.id === 'lora')!
  }

  it.each([1, 2] as const)('remote option fan-out at depth %s preserves both receivers and refuses an incompatible addition', (depth) => {
    const doc = remoteFixture(depth, true)
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, remoteResolve),
    }))
    const selection = depth === 1 ? 'pick' : 'list'
    const suffix = depth === 1 ? '' : '.detail'
    expect(store.dispatch({ command: 'boundary.addBinding', params: {
      graphId: 'detail', itemId: 'pick', node: 'other', port: 'lora',
    } }).ok).toBe(true)
    const joined = store.doc
    const check = (document: WorkflowDocument, first: string) => {
      for (const state of ['ready', 'loading', 'unavailable'] as const) {
        const { prompt, calls } = remotePrompt(document, state)
        expect(prompt[`first${suffix}.sample`]!.inputs).toEqual({ lora: first })
        expect(prompt[`first${suffix}.other`]!.inputs).toEqual({ lora: first })
        expect(prompt[`second${suffix}.sample`]!.inputs).toEqual({ lora: 'kept-second' })
        expect(prompt[`second${suffix}.other`]!.inputs).toEqual({ lora: 'kept-second' })
        expect(calls).toContainEqual(['pack.loras', ['sd']])
        expect(calls).toContainEqual(['pack.loras', ['sdxl']])
        expect(calls).toContainEqual(['pack.loras', ['inner-other']])
        expect(prompt.sink!.inputs.adapter).toEqual([`first${suffix}.sample`, 0])
      }
      for (const [receiver, category] of [
        [`first${suffix}.sample`, 'sd'], [`first${suffix}.other`, 'inner-other'],
        [`second${suffix}.sample`, 'sdxl'], [`second${suffix}.other`, 'inner-other'],
      ]) expect(remoteSelection(document, receiver!)).toMatchObject({
        looked: { options: { state: 'ready', call: { lookup: 'pack.loras', args: [category] } } },
        spec: { widget: { options: { options: [`${category}-option`] } } },
      })
    }
    check(joined, 'kept-first')
    const refused = store.dispatch({ command: 'boundary.addBinding', params: {
      graphId: 'detail', itemId: 'pick', node: 'numeric', port: 'amount',
    } })
    expect(refused.ok).toBe(false)
    expect(refused.diagnostics.some((entry) => entry.code === 'boundary.fanoutTypeMismatch')).toBe(true)
    expect(store.doc).toBe(joined)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(doc)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(joined)
    expect(store.dispatch({ command: 'node.setValue', params: {
      graphId: 'root', nodeId: 'first', inputId: selection, value: 'edited-first',
    } }).ok).toBe(true)
    check(store.doc, 'edited-first')
    expect(store.doc.graphs.detail).toEqual(joined.graphs.detail)
    expect(store.doc.graphs.portrait).toEqual(joined.graphs.portrait)
    const edited = store.doc
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(joined)
    check(store.doc, 'kept-first')
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(edited)
    check(loadDocument(JSON.parse(JSON.stringify(edited))).document!, 'edited-first')
  })

  it.each([1, 2] as const)('remote option detach and separate mode-specific flatten at depth %s retain selections, lookup arguments and output wires', async (depth) => {
    const doc = remoteFixture(depth)
    const selection = depth === 1 ? 'pick' : 'list'
    const suffix = depth === 1 ? '.sample' : '.detail.sample'
    const checkOptions = (current: WorkflowDocument, firstCategory = 'sd') => {
      for (const [receiver, category] of [[`first${suffix}`, firstCategory], [`second${suffix}`, 'sdxl']]) {
        expect(remoteSelection(current, receiver!)).toMatchObject({
          looked: { options: { state: 'ready', call: { lookup: 'pack.loras', args: [category] } } },
          spec: { widget: { options: { options: [`${category}-option`] } } },
        })
      }
    }
    const initial = remotePrompt(doc)
    expect(initial.prompt).toEqual({
      [`first${suffix}`]: { class_type: 'Picker', inputs: { lora: 'kept-first' }, outputIds: ['result'] },
      [`second${suffix}`]: { class_type: 'Picker', inputs: { lora: 'kept-second' }, outputIds: ['result'] },
      sink: { class_type: 'AdapterSink', inputs: { adapter: [`first${suffix}`, 0] }, outputIds: [] },
    })
    checkOptions(doc)
    const detached = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, remoteResolve),
    }))
    expect(detached.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    const localized = detached.doc
    expect(localized.graphs.root!.nodes.first!.type).not.toBe(doc.graphs.root!.nodes.first!.type)
    expect(localized.graphs.root!.nodes.second).toEqual(doc.graphs.root!.nodes.second)
    expect(remotePrompt(localized).prompt).toEqual(initial.prompt)
    checkOptions(localized)
    expect(detached.dispatch({ command: 'node.setValue', params: {
      graphId: 'root', nodeId: 'first', inputId: selection, value: 'detached-first',
    } }).ok).toBe(true)
    const edited = detached.doc
    const detachedPrompt = { ...initial.prompt,
      [`first${suffix}`]: { ...initial.prompt[`first${suffix}`]!, inputs: { lora: 'detached-first' } },
    }
    expect(remotePrompt(edited).prompt).toEqual(detachedPrompt)
    checkOptions(edited)
    expect(edited.graphs.detail).toEqual(doc.graphs.detail)
    expect(edited.graphs.portrait).toEqual(doc.graphs.portrait)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(localized)
    checkOptions(detached.doc)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(doc)
    checkOptions(detached.doc)
    expect(detached.redo()).toBe(true)
    expect(detached.redo()).toBe(true)
    expect(detached.doc).toEqual(edited)
    const reopenedDetached = loadDocument(JSON.parse(JSON.stringify(edited))).document!
    expect(remotePrompt(reopenedDetached).prompt).toEqual(detachedPrompt)
    checkOptions(reopenedDetached)

    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(localized)
    const privateGraph = localized.graphs.root!.nodes.first!.type.slice(1)
    expect(detached.dispatch({ command: 'node.setValues', params: {
      graphId: privateGraph, nodeId: depth === 1 ? 'sample' : 'detail',
      values: depth === 1 ? { category: 'inner-other', lora: 'private-selection' }
        : { kind: 'inner-other', pick: 'private-selection' },
    } }).ok).toBe(true)
    expect(remotePrompt(detached.doc).prompt).toEqual(initial.prompt)
    checkOptions(detached.doc)
    const privateDefaults = detached.doc
    expect(detached.dispatch({ command: 'node.setValues', params: {
      graphId: 'root', nodeId: 'first', values: {}, unset: [depth === 1 ? 'kind' : 'category', selection],
    } }).ok).toBe(true)
    const fallback = detached.doc
    const fallbackPrompt = { ...initial.prompt,
      [`first${suffix}`]: { ...initial.prompt[`first${suffix}`]!, inputs: { lora: 'private-selection' } },
    }
    for (const current of [fallback, loadDocument(JSON.parse(JSON.stringify(fallback))).document!]) {
      const { prompt, calls } = remotePrompt(current)
      expect(prompt).toEqual(fallbackPrompt)
      expect(calls).toContainEqual(['pack.loras', ['inner-other']])
      expect(calls).toContainEqual(['pack.loras', ['sdxl']])
      checkOptions(current, 'inner-other')
      expect(current.graphs.detail).toEqual(doc.graphs.detail)
      expect(current.graphs.portrait).toEqual(doc.graphs.portrait)
    }
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(privateDefaults)
    expect(remotePrompt(detached.doc).prompt).toEqual(initial.prompt)
    checkOptions(detached.doc)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(localized)
    expect(detached.redo()).toBe(true)
    expect(detached.redo()).toBe(true)
    expect(detached.doc).toEqual(fallback)
    expect(remotePrompt(detached.doc).prompt).toEqual(fallbackPrompt)
    checkOptions(detached.doc, 'inner-other')

    for (const mode of ['active', 'muted', 'bypassed', 'loop'] as const) {
      const first = doc.graphs.root!.nodes.first!
      const before: WorkflowDocument = { ...doc, graphs: { ...doc.graphs, root: { ...doc.graphs.root!, nodes: {
        ...doc.graphs.root!.nodes, first: mode === 'loop' ? { ...first, region: { kind: 'map', elementPorts: [selection] } }
          : { ...first, mode },
      } } } }
      const result = await flatten(before, 'root', [], 'first', remoteResolve)
      if (mode === 'bypassed' || mode === 'loop') {
        expect(result.ok).toBe(false)
        expect(result.reports.map((entry) => entry.code)).toContain(mode === 'loop' ? 'subgraph.flatten.regionUnsupported' : 'subgraph.flatten.modeUnsupported')
        expect(result.session.doc).toEqual(before)
        expect(result.session.canUndo).toBe(false)
        continue
      }
      expect(result.ok, JSON.stringify(result.reports)).toBe(true)
      const flattened = result.session.doc
      const replacement = Object.values(flattened.graphs.root!.nodes).find((entry) => !['second', 'sink'].includes(entry.id))!
      expect(replacement.mode ?? 'active').toBe(mode)
      const receivingId = depth === 1 ? replacement.id : `${replacement.id}.sample`
      for (const state of ['ready', 'loading', 'unavailable'] as const) {
        const { prompt, calls } = remotePrompt(flattened, state)
        expect(prompt).toEqual({
          ...(mode === 'active' ? { [receivingId]: { class_type: 'Picker', inputs: { lora: 'kept-first' }, outputIds: ['result'] } } : {}),
          [`second${suffix}`]: initial.prompt[`second${suffix}`],
          sink: { class_type: 'AdapterSink', inputs: mode === 'active' ? { adapter: [receivingId, 0] } : {}, outputIds: [] },
        })
        expect(calls).toContainEqual(['pack.loras', ['sdxl']])
        if (mode === 'active') expect(calls).toContainEqual(['pack.loras', ['sd']])
      }
      expect(flattened.graphs.detail).toEqual(doc.graphs.detail)
      expect(flattened.graphs.portrait).toEqual(doc.graphs.portrait)
      expect(result.session.undo()).toBe(true)
      expect(result.session.doc).toEqual({ ...before, graphs: { ...before.graphs,
        root: { ...before.graphs.root!, nextOrdinal: flattened.graphs.root!.nextOrdinal },
      } })
      expect(result.session.redo()).toBe(true)
      expect(result.session.doc).toEqual(flattened)
      const reopenedFlattened = loadDocument(JSON.parse(JSON.stringify(flattened))).document!
      expect(remotePrompt(reopenedFlattened).prompt).toEqual(remotePrompt(flattened).prompt)
      for (const current of [flattened, reopenedFlattened]) {
        for (const [receiver, category] of [
          ...(mode === 'active' ? [[receivingId, 'sd']] : []), [`second${suffix}`, 'sdxl'],
        ]) expect(remoteSelection(current, receiver!)).toMatchObject({
          looked: { options: { state: 'ready', call: { lookup: 'pack.loras', args: [category] } } },
          spec: { widget: { options: { options: [`${category}-option`] } } },
        })
      }
    }
  })

  it('keeps an enclosing button executable and instance-local after extracting and flattening its target', async () => {
    const buttonSchema = node('Counter', [floatField('amount', 3), floatField('delta', 7), {
      kind: 'button', id: 'increase', label: 'Increase',
      steps: [{ step: 'set', field: 'amount', value: { formula: 'amount + delta' } }],
    }])
    const resolve = (type: string) => type === 'Counter' ? buttonSchema : undefined
    const doc: WorkflowDocument = {
      ...fixture(), graphs: {
        root: { id: 'root' as never, name: 'Root', ...empty, nodes: {
          first: { id: 'first' as never, type: '#detail', values: { gain: 10 } },
          second: { id: 'second' as never, type: '#detail', values: { gain: 80 } },
        } },
        detail: { id: 'detail' as never, name: 'Detail', ...empty, nodes: {
          n: { id: 'n' as never, type: 'Counter', values: { amount: 3, delta: 7 } },
        }, boundary: { body: [
          { kind: 'input', id: 'gain' as never, promoted: true, binds: { kind: 'port', node: 'n' as never, port: 'amount' as never } },
          { kind: 'section', id: 'actions', rows: [{ kind: 'button', id: 'increase', node: 'n' as never, button: 'increase' }] },
        ] } },
      }, view: { graphs: { root: { nodes: {} }, detail: { nodes: { n: { position: { x: 0, y: 0 } } } } } },
    }
    const unavailable = async (): Promise<never> => { throw new Error('This button needs no host service.') }
    const host: ActionHost = {
      commands: coreCommandRegistry([], resolve), schemaResolverFor: (current) => documentResolver(current, resolve),
      schemaOf: (current, graphId, entry) => documentNodeResolver(current, resolve)(graphId, entry),
      lookup: unavailable, call: unavailable, pick: unavailable, ask: unavailable, openPicker: unavailable,
      editorFor: () => undefined, pasteImage: unavailable, copy: unavailable, download: unavailable,
      queue: unavailable, interrupt: unavailable, openLink: unavailable, random: () => 0.5,
    }
    const session = createLocalSession(doc, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    const invocation = extractInvocation(doc, 'detail', ['first'], {
      nodeIds: ['n'], geometry: [{ id: 'n', kind: 'node', x: 0, y: 0, width: 140, height: 120 }],
    }, 'Counter body', resolve)!
    const extracted = session.dispatch(invocation)
    expect(extracted.ok, JSON.stringify(!extracted.ok && extracted.diagnostics)).toBe(true)
    const shell = Object.values(session.doc.graphs.detail!.nodes)[0]!
    const target = { graphId: 'root', nodeId: 'first', button: 'increase' }
    const beforePress = session.doc
    expect(await runPress(session, target, host)).toMatchObject({ kind: 'done' })
    expect(session.doc.graphs.root!.nodes.first!.values.gain).toBe(17)
    expect(session.doc.graphs.root!.nodes.second!.values.gain).toBe(80)
    expect(session.doc.graphs.detail).toEqual(beforePress.graphs.detail)
    expect(session.doc.graphs[shell.type.slice(1)]).toEqual(beforePress.graphs[shell.type.slice(1)])
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(beforePress)
    const flattened = await flatten(session.doc, 'detail', ['first'], shell.id, resolve)
    expect(flattened.ok, JSON.stringify(flattened.reports)).toBe(true)
    const reopened = createLocalSession(JSON.parse(JSON.stringify(flattened.session.doc)), host.commands, { schemaResolverFor: host.schemaResolverFor! })
    const beforeReopenedPress = reopened.doc
    expect(await runPress(reopened, target, host)).toMatchObject({ kind: 'done' })
    expect(reopened.doc.graphs.root!.nodes.first!.values.gain).toBe(17)
    expect(reopened.doc.graphs.root!.nodes.second!.values.gain).toBe(80)
    expect(reopened.doc.graphs.detail).toEqual(beforeReopenedPress.graphs.detail)
    expect(reopened.undo()).toBe(true)
    expect(reopened.doc).toEqual(beforeReopenedPress)
    expect(flattened.session.undo()).toBe(true)
    expect(await runPress(flattened.session, target, host)).toMatchObject({ kind: 'done' })
    expect(flattened.session.doc.graphs.root!.nodes.first!.values.gain).toBe(17)
    const hidden = createLocalSession(beforePress, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    expect(hidden.dispatch({ command: 'boundary.hideButton', params: { graphId: shell.type.slice(1), itemId: 'increase' } }).ok).toBe(true)
    const beforeInertFlatten = runOf(hidden.doc, resolve)
    const inert = await flatten(hidden.doc, 'detail', ['first'], shell.id, resolve)
    expect(inert.ok, JSON.stringify(inert.reports)).toBe(true)
    expect(runOf(inert.session.doc, resolve)).toEqual(beforeInertFlatten)
    const inertDocument = inert.session.doc
    expect(await runPress(inert.session, target, host)).toMatchObject({ kind: 'failed' })
    expect(inert.session.doc).toEqual(inertDocument)
    expect(inert.session.undo()).toBe(true)
    expect(runOf(inert.session.doc, resolve)).toEqual(beforeInertFlatten)
    expect(hidden.undo()).toBe(true)
    expect(await runPress(hidden, target, host)).toMatchObject({ kind: 'done' })
    expect(hidden.doc.graphs.root!.nodes.first!.values.gain).toBe(17)
    const detached = createLocalSession(beforePress, host.commands, { schemaResolverFor: host.schemaResolverFor! })
    expect(detached.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    const beforeDetachedPress = detached.doc
    expect(await runPress(detached, target, host)).toMatchObject({ kind: 'done' })
    expect(detached.doc.graphs.root!.nodes.first!.values.gain).toBe(17)
    expect(detached.doc.graphs.root!.nodes.second).toEqual(beforePress.graphs.root!.nodes.second)
    expect(detached.doc.graphs.detail).toEqual(beforePress.graphs.detail)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(beforeDetachedPress)
    expect(detached.redo()).toBe(true)
    const detachedReload = createLocalSession(JSON.parse(JSON.stringify(detached.doc)), host.commands, { schemaResolverFor: host.schemaResolverFor! })
    expect(await runPress(detachedReload, target, host)).toMatchObject({ kind: 'done' })
    expect(detachedReload.doc.graphs.root!.nodes.first!.values.gain).toBe(24)
    expect(detachedReload.doc.graphs.root!.nodes.second!.values.gain).toBe(80)
    for (const mode of ['muted', 'bypassed'] as const) {
      const changed = createLocalSession(beforePress, host.commands, { schemaResolverFor: host.schemaResolverFor! })
      expect(changed.dispatch({ command: 'node.setMode', params: { graphId: 'detail', nodeIds: [shell.id], mode } }).ok).toBe(true)
      const beforeModeFlatten = changed.doc
      const result = await flatten(changed.doc, 'detail', ['first'], shell.id, resolve)
      if (mode === 'bypassed') {
        expect(result.ok).toBe(false)
        expect(result.session.doc).toEqual(beforeModeFlatten)
        expect(result.session.canUndo).toBe(false)
        continue
      }
      expect(result.ok, JSON.stringify(result.reports)).toBe(true)
      expect(Object.values(result.session.doc.graphs.detail!.nodes).find((entry) => entry.type === 'Counter')!.mode).toBe('muted')
      expect(runOf(result.session.doc, resolve)).toEqual(runOf(beforeModeFlatten, resolve))
      const mutedReload = createLocalSession(JSON.parse(JSON.stringify(result.session.doc)), host.commands, { schemaResolverFor: host.schemaResolverFor! })
      const beforeMutedPress = mutedReload.doc
      expect(await runPress(mutedReload, target, host)).toMatchObject({ kind: 'done' })
      expect(mutedReload.doc.graphs.root!.nodes.first!.values.gain).toBe(17)
      expect(mutedReload.doc.graphs.root!.nodes.second!.values.gain).toBe(80)
      expect(mutedReload.doc.graphs.detail).toEqual(beforeMutedPress.graphs.detail)
      expect(mutedReload.undo()).toBe(true)
      expect(mutedReload.doc).toEqual(beforeMutedPress)
      expect(result.session.undo()).toBe(true)
      expect(result.session.doc.graphs.detail!.nextOrdinal).toBe(beforeModeFlatten.graphs.detail!.nextOrdinal + 1)
      expect(result.session.doc).toEqual({ ...beforeModeFlatten, graphs: { ...beforeModeFlatten.graphs,
        detail: { ...beforeModeFlatten.graphs.detail!, nextOrdinal: result.session.doc.graphs.detail!.nextOrdinal },
      } })
    }
  })

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

  it('flattening a described construct retains its input state and output wires and named nets at both depths', async () => {
    const described = node('Mode', [...schemas.Mode!.body, {
      kind: 'described', id: 'description', minEntries: 0, maxEntries: 4, fixedIds: true,
      kinds: [floatField('amount', 0.4), { kind: 'output', id: 'result', type: FLOAT }],
    }])
    const sink = node('FloatSink', [{ kind: 'input', id: 'in', type: FLOAT, optional: false }])
    const resolve = (type: string) => type === 'Mode' ? described : type === 'FloatSink' ? sink : resolveSchema(type)
    const description = JSON.stringify({ entries: [
      { id: 'amount', label: 'Amount', kind: 'amount' }, { id: 'result', label: 'Result', kind: 'result' },
    ] })
    for (const route of ['whole', 'leaf', 'fanout', 'leaf-fanout'] as const) {
      const fanout = route.includes('fanout')
      const leaf = route.startsWith('leaf')
      const doc = fixture()
      const mutable = doc as any
      mutable.graphs.detail.boundary.body.push({ kind: 'input', ...construct('description', 'm', 'description'),
        ...(fanout ? { alsoBinds: [{ kind: 'construct', node: 'alias', port: 'description' }] } : {}),
      })
      if (fanout) mutable.graphs.detail.nodes.alias = {
        ...structuredClone(mutable.graphs.detail.nodes.m), id: 'alias',
        values: { 'mode.words': 'alias only' },
      }
      const port = leaf ? 'result' : 'report.result'
      if (leaf) {
        mutable.graphs.portrait.nodes.d.values.description = description
        mutable.graphs.portrait.nodes.d.values['description.amount'] = 0.7
        mutable.graphs.portrait.boundary.body.push({ kind: 'output', id: 'result', binds: { kind: 'port', node: 'd', port: 'description.result' } })
      } else {
        mutable.graphs.portrait.boundary.body.push({ kind: 'input', ...construct('report', 'd', 'description') })
        mutable.graphs.root.nodes.first.values.report = description
        mutable.graphs.root.nodes.first.values['report.amount'] = 0.7
      }
      mutable.graphs.root.nodes.direct = { id: 'direct', type: 'FloatSink', values: {} }
      mutable.graphs.root.nodes.named = { id: 'named', type: 'FloatSink', values: {} }
      mutable.graphs.root.links.report = {
        id: 'report', from: { node: 'first', port }, to: { node: 'direct', port: 'in' },
      }
      mutable.graphs.root.nets = { ...mutable.graphs.root.nets, reportNet: {
        id: 'reportNet', name: 'Report', source: { node: 'first', port }, sinks: [{ node: 'named', port: 'in' }],
      } }
      const before = runOf(doc, resolve)
      expect(before.filter((entry) => entry.includes('"class_type":"Mode"'))).toContainEqual(expect.stringContaining('"description.amount":0.7'))
      for (const [graphId, instancePath, nodeId] of [['root', [], 'first'], ['portrait', ['first'], 'd']] as const) {
        const { ok, reports, session } = await flatten(doc, graphId, instancePath, nodeId, resolve)
        expect(ok, `${route}: ${JSON.stringify(reports)}`).toBe(true)
        expect(runOf(session.doc, resolve)).toEqual(before)
        if (leaf && graphId === 'portrait') {
          const primary = Object.values(session.doc.graphs.portrait!.nodes).find((candidate) =>
            candidate.type === 'Mode' && candidate.values['mode.words'] !== 'alias only')!
          expect(boundaryItems(session.doc.graphs.portrait!.boundary, 'outputs').find((item) => item.id === 'result')!.binds)
            .toEqual({ kind: 'port', node: primary.id, port: 'description.result' })
        }
        expect(session.undo()).toBe(true)
        expect(runOf(session.doc, resolve)).toEqual(before)
        expect(session.redo()).toBe(true)
        expect(runOf(session.doc, resolve)).toEqual(before)
      }
      if (fanout) {
        const outer = await flatten(doc, 'root', [], 'first', resolve)
        expect(outer.ok, JSON.stringify(outer.reports)).toBe(true)
        const inner = Object.values(outer.session.doc.graphs.root!.nodes).find((candidate) => candidate.type === '#detail')!
        const flattened = await flatten(outer.session.doc, 'root', [], inner.id, resolve)
        expect(flattened.ok, JSON.stringify(flattened.reports)).toBe(true)
        expect(runOf(flattened.session.doc, resolve)).toEqual(before)
        const primary = Object.values(flattened.session.doc.graphs.root!.nodes).find((candidate) =>
          candidate.type === 'Mode' && candidate.values['mode.words'] !== 'alias only')!
        expect(flattened.session.doc.graphs.root!.links.report!.from).toEqual({ node: primary.id, port: 'description.result' })
        expect(flattened.session.doc.graphs.root!.nets.reportNet!.source).toEqual({ node: primary.id, port: 'description.result' })
      }
    }
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
