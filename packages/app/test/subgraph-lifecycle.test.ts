import { describe, expect, it } from 'vitest'
import { asConnectionId, checkDocument, compile, diag, DocumentStore, elaborateInterface, elabInputsOf, loadDocument, occurrenceDynamicView, parseDinksterSchema, planClipboardPaste, serializeSelection, documentResolver, documentNodeResolver, runPress, coreCommandRegistry, createLocalSession, type ActionHost, type CommandOutcome, type Diagnostic, type Json, type NodeSchema, type WorkflowDocument, boundaryOf, boundaryItems } from '@dinkster/core'
import { extractSubgraphInvocationThroughBridge, flattenSubgraphThroughBridge } from '../src/CanvasHost.js'
import { buildParamRows } from '../src/app-view-rows.js'
import { activateProblem } from '../src/ProblemsPanel.js'
import { commitExtract, extractInvocation, flattenInvocation, hasExtractSelection, isFlattenSelection } from '../src/subgraph-lifecycle.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'
import { boundarySample, resolveBoundarySample } from '../../core/test/fixtures/boundary-sample.js'

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

  it.each([1, 2] as const)('keeps shared-line notes in their receiving scope through fan-out and separate lifecycle changes at depth %s', async (depth) => {
    const noted = node('Noted', [{ kind: 'choice', id: 'pack', required: true, default: 'a', shared: [], options: [{ key: 'a', rows: [
      { kind: 'row', rows: [floatField('seed', 3), floatField('other', 9),
        { kind: 'note', id: 'answer', text: { formula: 'fixed(seed * 2, 0)' }, unknown: 'Linked seed' }] },
      { kind: 'note', id: 'pending', text: { formula: 'str(1 // 0)' }, unknown: 'Waiting' },
      { kind: 'note', id: 'empty', text: '' },
    ] }] }])
    const resolve = (type: string) => type === 'Noted' ? noted : undefined
    const bind = (id: string, target: string, port: string) => ({ kind: 'input', id, binds: { kind: 'construct', node: target, port } })
    const key = depth === 1 ? 'bundle' : 'outer'
    const doc = { format: 'dinkster-workflow', formatVersion: 1, lineage: 'notes-lifecycle', root: 'root', graphs: {
      root: { id: 'root', name: 'Root', ...empty, nodes: Object.fromEntries([['first', 21, 4], ['second', 13, 7]].map(([id, seed, other]) => [id, {
        id, type: depth === 1 ? '#detail' : '#portrait', values: { [`${key}.seed`]: seed, [`${key}.other`]: other },
      }])) },
      detail: { id: 'detail', name: 'Detail', ...empty, nodes: {
        sample: { id: 'sample', type: 'Noted', values: { 'pack.seed': 5 }, dynamic: { pack: { selected: 'a' } } },
        other: { id: 'other', type: 'Noted', values: { 'pack.seed': 11, 'pack.other': 17 }, dynamic: { pack: { selected: 'a' } } },
      }, boundary: { body: [bind('bundle', 'sample', 'pack')] } },
      ...(depth === 2 ? { portrait: { id: 'portrait', name: 'Portrait', ...empty, nodes: {
        detail: { id: 'detail', type: '#detail', values: { 'bundle.seed': 7 } },
      }, boundary: { body: [bind('outer', 'detail', 'bundle')] } } } : {}),
    }, view: { graphs: {} } } as unknown as WorkflowDocument
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolve),
    }))
    const notes = (current: WorkflowDocument, runtimeId: string) => {
      const path = runtimeId.split('.')
      const nodeId = path.pop()!
      const graphId = path.reduce((graph, hop) => current.graphs[graph]!.nodes[hop]!.type.slice(1), current.root as string)
      const receiver = current.graphs[graphId]!.nodes[nodeId]!
      const view = occurrenceDynamicView(current, resolve, path)
      const dynamic = view.dynamic.get(nodeId) ?? receiver.dynamic
      return elaborateInterface(documentNodeResolver(current, resolve)(graphId, receiver)!, {
        ...receiver,
        values: view.values.get(nodeId) ?? receiver.values,
        ...(dynamic !== undefined ? { dynamic } : {}),
      }, {
        isInputConnected: (port) => view.inputPorts.get(nodeId)?.includes(port) ?? false,
        isOutputConnected: () => false,
        inputPorts: () => view.inputPorts.get(nodeId) ?? [],
      }).items.filter((item) => item.kind === 'note')
        .map((item) => [item.id, item.text, item.unknown ?? false, item.adjacentTo])
    }
    const expectedNotes = (prefix: string, seed: number) => [
      [`${prefix}.answer`, String(seed * 2), false, `${prefix}.other`],
      [`${prefix}.pending`, 'Waiting', true, undefined],
      [`${prefix}.empty`, '', false, undefined],
    ]
    const check = (current: WorkflowDocument, seeds: Readonly<Record<string, readonly [number, number]>>) => {
      const compiled = compile({ document: current, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('notes'), schemaHash: 'notes' })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('note workflow did not compile')
      expect(Object.keys(compiled.artifact.prompt).sort()).toEqual(Object.keys(seeds).sort())
      for (const [id, [seed, other]] of Object.entries(seeds)) {
        const inputs = compiled.artifact.prompt[id]!.inputs
        expect(inputs).toEqual({ 'pack.seed': seed, 'pack.other': other })
        expect(notes(current, id)).toEqual(expectedNotes('pack', seed))
        if (id.endsWith('.sample')) {
          const ancestors = id.split('.').slice(0, -1)
          for (let length = 1; length <= ancestors.length; length++) {
            const prefix = depth === 2 && length === 1 && ['first', 'second'].includes(ancestors[0]!) ? 'outer' : 'bundle'
            expect(notes(current, ancestors.slice(0, length).join('.'))).toEqual(expectedNotes(prefix, seed))
            if (length === 1) {
              const exposed = { ...current, ext: { 'dinkster.exposed': ['seed', 'answer', 'pending', 'empty'].map((part) => ({
                graphId: 'root', nodeId: ancestors[0]!, inputId: `${prefix}.${part}`,
              })) } }
              const rows = buildParamRows(exposed, resolve)
              expect(rows[0]).toMatchObject({ kind: 'live', value: seed, linked: false,
                entry: { graphId: 'root', nodeId: ancestors[0], inputId: `${prefix}.seed` } })
              expect(rows.slice(1).map((row) => row.kind)).toEqual(['stale', 'stale', 'stale'])
            }
          }
        }
      }
      return compiled.artifact.prompt
    }
    const suffix = depth === 1 ? '' : '.detail'
    const initial = { [`first${suffix}.sample`]: [21, 4], [`first${suffix}.other`]: [11, 17],
      [`second${suffix}.sample`]: [13, 7], [`second${suffix}.other`]: [11, 17] } as const
    check(store.doc, initial)
    expect(store.dispatch({ command: 'boundary.addBinding', params: { graphId: 'detail', itemId: 'bundle', node: 'other', port: 'pack' } }).ok).toBe(true)
    const joined = store.doc
    const fanout = { ...initial, [`first${suffix}.other`]: [21, 4], [`second${suffix}.other`]: [13, 7] } as const
    check(joined, fanout)
    expect(notes(joined, 'first')).toEqual(expectedNotes(key, 21))
    expect(store.dispatch({ command: 'boundary.addBinding', params: {
      graphId: 'detail', itemId: 'bundle', node: 'other', port: 'pack.seed',
    } }).ok).toBe(false)
    expect(store.doc).toBe(joined)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(doc)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(joined)
    expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: `${key}.seed`, value: 31 } }).ok).toBe(true)
    check(store.doc, { ...fanout, [`first${suffix}.sample`]: [31, 4], [`first${suffix}.other`]: [31, 4] })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(joined)
    expect(store.redo()).toBe(true)
    const edited = store.doc
    check(loadDocument(JSON.parse(JSON.stringify(edited))).document!, { ...fanout, [`first${suffix}.sample`]: [31, 4], [`first${suffix}.other`]: [31, 4] })
    expect(edited.graphs.detail).toEqual(joined.graphs.detail)
    expect(edited.graphs.portrait).toEqual(doc.graphs.portrait)
    const detached = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolve),
    }))
    expect(detached.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    const privateGraph = detached.doc.graphs.root!.nodes.first!.type.slice(1)
    expect(detached.dispatch({ command: 'node.setValue', params: { graphId: privateGraph,
      nodeId: depth === 1 ? 'sample' : 'detail', inputId: depth === 1 ? 'pack.seed' : 'bundle.seed', value: 19 } }).ok).toBe(true)
    const privateDoc = detached.doc
    check(privateDoc, initial)
    expect(detached.dispatch({ command: 'node.setValues', params: { graphId: 'root', nodeId: 'first', values: {}, unset: [`${key}.seed`] } }).ok).toBe(true)
    check(detached.doc, { ...initial, [`first${suffix}.sample`]: [19, 4] })
    check(loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!, { ...initial, [`first${suffix}.sample`]: [19, 4] })
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(privateDoc)
    expect(privateDoc.graphs.detail).toEqual(doc.graphs.detail)
    expect(privateDoc.graphs.portrait).toEqual(doc.graphs.portrait)
    expect(detached.undo()).toBe(true)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(doc)
    expect(detached.redo()).toBe(true)
    expect(detached.redo()).toBe(true)
    expect(detached.doc).toEqual(privateDoc)
    check(loadDocument(JSON.parse(JSON.stringify(privateDoc))).document!, initial)
    for (const mode of ['active', 'muted', 'bypassed', 'loop'] as const) {
      const before = { ...doc, graphs: { ...doc.graphs, root: { ...doc.graphs.root!, nodes: { ...doc.graphs.root!.nodes,
        first: { ...doc.graphs.root!.nodes.first!, ...(mode === 'loop' ? { region: { kind: 'map', elementPorts: [`${key}.seed`] } } : { mode }) },
      } } } } as WorkflowDocument
      const result = await flatten(before, 'root', [], 'first', resolve)
      if (mode === 'bypassed' || mode === 'loop') {
        expect(result.ok).toBe(false)
        expect(result.session.doc).toEqual(before)
        expect(result.session.canUndo).toBe(false)
        continue
      }
      expect(result.ok, JSON.stringify(result.reports)).toBe(true)
      const flattened = result.session.doc
      const replacements = Object.values(flattened.graphs.root!.nodes).filter((entry) => before.graphs.root!.nodes[entry.id] === undefined)
      const primary = replacements.find((entry) => depth === 2 || entry.values['pack.seed'] === 21)!
      const secondary = depth === 1 ? replacements.find((entry) => entry.id !== primary.id)!.id : `${primary.id}.other`
      const primaryId = depth === 1 ? primary.id : `${primary.id}.sample`
      for (const current of [flattened, loadDocument(JSON.parse(JSON.stringify(flattened))).document!]) {
        expect(notes(current, primaryId)).toEqual(expectedNotes('pack', 21))
        expect(notes(current, secondary)).toEqual(expectedNotes('pack', 11))
        if (depth === 2) expect(notes(current, primary.id)).toEqual(expectedNotes('bundle', 21))
      }
      check(flattened, { [`second${suffix}.sample`]: [13, 7], [`second${suffix}.other`]: [11, 17],
        ...(mode === 'active' ? { [depth === 1 ? primary.id : `${primary.id}.sample`]: [21, 4], [secondary]: [11, 17] } : {}) })
      expect(flattened.graphs.detail).toEqual(doc.graphs.detail)
      expect(flattened.graphs.portrait).toEqual(doc.graphs.portrait)
      expect(result.session.undo()).toBe(true)
      expect(result.session.doc.graphs).toEqual({ ...before.graphs, root: { ...before.graphs.root!, nextOrdinal: flattened.graphs.root!.nextOrdinal } })
      expect(result.session.redo()).toBe(true)
      expect(result.session.doc).toEqual(flattened)
      const reopened = loadDocument(JSON.parse(JSON.stringify(flattened))).document!
      expect(runOf(reopened, resolve)).toEqual(runOf(flattened, resolve))
      check(reopened, { [`second${suffix}.sample`]: [13, 7], [`second${suffix}.other`]: [11, 17],
        ...(mode === 'active' ? { [depth === 1 ? primary.id : `${primary.id}.sample`]: [21, 4], [secondary]: [11, 17] } : {}) })
    }
  })

  it.each([1, 2] as const)('keeps four shared fields independent through fan-out, App View and separate lifecycle changes at depth %s', async (depth) => {
    const fields = ['strength', 'radius', 'feather', 'balance']
    const fixture = boundarySample(depth)
    const leaf = fixture.graphs.detail!.nodes.sample!
    const doc = { ...fixture, graphs: { ...fixture.graphs, detail: { ...fixture.graphs.detail!, nodes: {
      ...fixture.graphs.detail!.nodes, other: { ...structuredClone(leaf), id: 'other' as never, values: {
        ...leaf.values, count: 4, strength: 0.11, radius: 0.12, feather: 0.13, balance: 0.14,
      } },
    } } } } as WorkflowDocument
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveBoundarySample),
    }))
    for (const [id, numbers] of [['first', [0.2, 0.17, 0.37, 0.57]], ['second', [0.8, 0.81, 0.61, 0.41]]] as const) {
      expect(store.dispatch({ command: 'node.setValues', params: { graphId: 'root', nodeId: id,
        values: Object.fromEntries(fields.map((field, index) => [field, numbers[index]!])) } }).ok).toBe(true)
    }
    const graphId = depth === 1 ? 'detail' : 'portrait'
    const body = store.doc.graphs[graphId]!.boundary!.body
    expect(store.dispatch({ command: 'boundary.arrange', params: { graphId, body: [
      ...body.filter((row) => !('id' in row && fields.includes(row.id))).map((row) => ({ kind: row.kind, id: (row as { id: string }).id })),
      { kind: 'line', rows: fields.map((id) => ({ kind: 'input', id })) },
    ] } }).ok).toBe(true)
    expect(store.dispatch({ command: 'link.connect', params: { graphId: 'root', from: { node: 'first', port: 'output91' },
      to: { node: 'sink', port: 'number' } } }).ok).toBe(true)
    const initial = store.doc
    for (const field of fields) expect(store.dispatch({ command: 'boundary.addBinding', params: {
      graphId: 'detail', itemId: field, node: 'other', port: field,
    } }).ok).toBe(true)
    const joined = store.doc
    const suffix = depth === 1 ? '' : '.detail'
    const promptOf = (current: WorkflowDocument) => {
      const result = compile({ document: current, revision: 1, resolve: resolveBoundarySample, scope: { kind: 'full' },
        connection: asConnectionId('shared-lifecycle'), schemaHash: 'shared-lifecycle' })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (!result.ok) throw new Error('shared-line lifecycle did not compile')
      return result.artifact.prompt
    }
    const check = (current: WorkflowDocument, first = [0.2, 0.17, 0.37, 0.57]) => {
      const prompt = promptOf(current)
      for (const [id, numbers] of [['first', first], ['second', [0.8, 0.81, 0.61, 0.41]]] as const) for (const target of ['sample', 'other']) {
        expect(fields.map((field) => prompt[`${id}${suffix}.${target}`]!.inputs[field])).toEqual(numbers)
      }
      expect(prompt.sink!.inputs.number).toEqual([`first${suffix}.sample`, 6])
      const exposed = { ...current, ext: { ...current.ext, 'dinkster.exposed': ['first', 'second'].flatMap((nodeId) => fields.map((inputId) => ({ graphId: 'root', nodeId, inputId }))) } }
      const rows = buildParamRows(exposed, resolveBoundarySample)
      expect(rows.map((row) => row.kind === 'live' ? [row.entry, row.valueKey, row.value, row.linked, row.derived] : row.reason))
        .toEqual(['first', 'second'].flatMap((nodeId) => fields.map((inputId, index) => [{ graphId: 'root', nodeId, inputId }, inputId,
          (nodeId === 'first' ? first : [0.8, 0.81, 0.61, 0.41])[index], false, false])))
      expect(current.graphs.root!.nodes.second).toEqual(initial.graphs.root!.nodes.second)
    }
    check(joined)
    expect(store.dispatch({ command: 'boundary.addBinding', params: { graphId: 'detail', itemId: 'strength', node: 'other', port: 'mask' } }).ok).toBe(false)
    expect(store.doc).toBe(joined)
    expect(store.undo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(joined)
    expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: 'feather', value: 0.93 } }).ok).toBe(true)
    const edited = store.doc
    check(edited, [0.2, 0.17, 0.93, 0.57])
    check(loadDocument(JSON.parse(JSON.stringify(edited))).document!, [0.2, 0.17, 0.93, 0.57])
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(joined)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(edited)
    expect(edited.graphs.detail).toEqual(joined.graphs.detail)
    expect(edited.graphs.portrait).toEqual(joined.graphs.portrait)
    const detached = new DocumentStore(joined, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveBoundarySample),
    }))
    expect(detached.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    const localized = detached.doc
    expect(detached.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: 'feather', value: 0.93 } }).ok).toBe(true)
    check(detached.doc, [0.2, 0.17, 0.93, 0.57])
    check(loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!, [0.2, 0.17, 0.93, 0.57])
    expect(detached.doc.graphs.detail).toEqual(joined.graphs.detail)
    expect(detached.doc.graphs.portrait).toEqual(joined.graphs.portrait)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(localized)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(joined)
    expect(detached.redo()).toBe(true)
    expect(detached.redo()).toBe(true)
    check(detached.doc, [0.2, 0.17, 0.93, 0.57])
    const beforePrivateEdit = detached.doc
    const privateGraph = detached.doc.graphs.root!.nodes.first!.type.slice(1)
    expect(detached.dispatch({ command: 'node.setValues', params: { graphId: privateGraph, nodeId: depth === 1 ? 'sample' : 'detail',
      values: { strength: 0.21, radius: 0.22, feather: 0.23, balance: 0.24 } } }).ok).toBe(true)
    const privateEdited = detached.doc
    check(privateEdited, [0.2, 0.17, 0.93, 0.57])
    expect(detached.dispatch({ command: 'node.setValues', params: { graphId: 'root', nodeId: 'first', values: {}, unset: fields } }).ok).toBe(true)
    const privateFallback = detached.doc
    for (const current of [privateFallback, loadDocument(JSON.parse(JSON.stringify(privateFallback))).document!]) {
      const prompt = promptOf(current)
      expect(fields.map((field) => prompt[`first${suffix}.sample`]!.inputs[field])).toEqual([0.21, 0.22, 0.23, 0.24])
      expect(fields.map((field) => prompt[`first${suffix}.other`]!.inputs[field]))
        .toEqual(depth === 1 ? [0.11, 0.12, 0.13, 0.14] : [0.21, 0.22, 0.23, 0.24])
      for (const target of ['sample', 'other']) expect(fields.map((field) => prompt[`second${suffix}.${target}`]!.inputs[field])).toEqual([0.8, 0.81, 0.61, 0.41])
      expect(current.graphs.root!.nodes.second).toEqual(joined.graphs.root!.nodes.second)
      expect([prompt[`second${suffix}.sample`]!.inputs.count, prompt[`second${suffix}.other`]!.inputs.count]).toEqual([2, 4])
      expect(current.graphs.detail).toEqual(joined.graphs.detail)
      expect(current.graphs.portrait).toEqual(joined.graphs.portrait)
      expect(prompt.sink!.inputs.number).toEqual([`first${suffix}.sample`, 6])
    }
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(privateEdited)
    expect(detached.undo()).toBe(true)
    expect(detached.doc).toEqual(beforePrivateEdit)
    expect(detached.redo()).toBe(true)
    expect(detached.redo()).toBe(true)
    expect(detached.doc).toEqual(privateFallback)
    for (const mode of ['active', 'muted', 'bypassed', 'loop'] as const) {
      const before = { ...joined, graphs: { ...joined.graphs, root: { ...joined.graphs.root!, nodes: { ...joined.graphs.root!.nodes,
        first: { ...joined.graphs.root!.nodes.first!, ...(mode === 'loop' ? { region: { kind: 'map', elementPorts: ['strength'] } } : { mode }) },
      } } } } as WorkflowDocument
      const result = await flatten(before, 'root', [], 'first', resolveBoundarySample)
      if (mode === 'bypassed' || mode === 'loop') {
        expect(result.ok).toBe(false)
        expect(result.session.doc).toEqual(before)
        expect(result.session.canUndo).toBe(false)
        continue
      }
      expect(result.ok, JSON.stringify(result.reports)).toBe(true)
      const flattened = result.session.doc
      const replacements = Object.values(flattened.graphs.root!.nodes).filter((node) => before.graphs.root!.nodes[node.id] === undefined)
      expect(replacements).toHaveLength(depth === 1 ? 2 : 1)
      const primary = depth === 1 ? replacements.find((node) => node.values.strength === 0.2 && node.values.count === 3)!
        : replacements[0]!
      const primaryId = depth === 1 ? primary.id : `${primary.id}.sample`
      const secondaryId = depth === 1 ? replacements.find((node) => node.id !== primary.id)!.id : `${primary.id}.other`
      for (const current of [flattened, loadDocument(JSON.parse(JSON.stringify(flattened))).document!]) {
        const prompt = promptOf(current)
        const receivers = Object.entries(prompt).filter(([id, node]) => node.class_type === 'Boundary sample' && !id.startsWith('second.'))
        expect(receivers.map(([id]) => id).sort()).toEqual(mode === 'active' ? [primaryId, secondaryId].sort() : [])
        if (mode === 'active') expect([prompt[primaryId]!.inputs.count, prompt[secondaryId]!.inputs.count]).toEqual([3, 4])
        for (const [, node] of receivers) expect(fields.map((field) => node.inputs[field])).toEqual([0.2, 0.17, 0.37, 0.57])
        for (const target of ['sample', 'other']) expect(fields.map((field) => prompt[`second${suffix}.${target}`]!.inputs[field])).toEqual([0.8, 0.81, 0.61, 0.41])
        expect(current.graphs.root!.nodes.second).toEqual(before.graphs.root!.nodes.second)
        expect([prompt[`second${suffix}.sample`]!.inputs.count, prompt[`second${suffix}.other`]!.inputs.count]).toEqual([2, 4])
        expect(prompt.sink!.inputs.number).toEqual(mode === 'active' ? [primaryId, 6] : undefined)
        expect(current.graphs.detail).toEqual(joined.graphs.detail)
        expect(current.graphs.portrait).toEqual(joined.graphs.portrait)
      }
      expect(result.session.undo()).toBe(true)
      expect(result.session.doc.graphs).toEqual({ ...before.graphs, root: { ...before.graphs.root!, nextOrdinal: flattened.graphs.root!.nextOrdinal } })
      expect(result.session.redo()).toBe(true)
      expect(result.session.doc).toEqual(flattened)
    }
  })

  it.each(([1, 2] as const).flatMap((depth) =>
    (['detach', 'active', 'muted', 'bypassed', 'loop'] as const).map((operation) => [depth, operation] as const)))
  ('keeps whole-group members and choice ownership at depth %s through %s', async (depth, operation) => {
    const doc = boundarySample(depth)
    Object.assign(doc.graphs.root!.nodes.first!, {
      values: { strength: 0.2, count: 3, 'layers.layer0.strength': 0.2, 'layers.layer1.strength': 0.8,
        'mode.mix': 0.6, 'mode.text': 'first text' },
      dynamic: { layers: { members: ['layer1', 'layer0'] }, mode: { selected: 'text' } },
    })
    Object.assign(doc.graphs.root!.nodes.second!, {
      values: { strength: 0.8, count: 2, 'layers.layer0.strength': 0.9, 'mode.mix': 0.8 },
      dynamic: { layers: { members: ['layer0'] }, mode: { selected: 'image' } },
    })
    Object.assign(doc.graphs.root!.links, {
      memberInput: { id: 'memberInput', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'layers.layer0.image' } },
      memberOutput: { id: 'memberOutput', from: { node: 'first', port: 'layers.layer0.result' }, to: { node: 'sink', port: 'number' } },
    })
    const suffix = depth === 1 ? '.sample' : '.detail.sample'
    const promptOf = (current: WorkflowDocument) => {
      const result = compile({ document: current, revision: 1, resolve: resolveBoundarySample, scope: { kind: 'full' },
        connection: asConnectionId('construct-lifecycle'), schemaHash: 'construct-lifecycle' })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (!result.ok) throw new Error('construct lifecycle did not compile')
      return result.artifact.prompt
    }
    const original = promptOf(doc)
    const first = original[`first${suffix}`]!
    expect(first.outputMembers?.layers).toEqual(['layer0', 'layer1', 'layer3', 'layer2'])
    expect(first.inputs).toMatchObject({ 'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
      'layers.layer2.strength': 0.2, 'layers.layer3.strength': 0.8, 'mode.mix': 0.6, 'mode.text': 'first text' })
    expect(first.slotVariants?.mode).toBe('text')
    expect(original[`second${suffix}`]!.outputMembers?.layers).toEqual(['layer0', 'layer1', 'layer2'])
    expect(original[`second${suffix}`]!.inputs['layers.layer2.strength']).toBe(0.9)
    expect(original[`second${suffix}`]!.slotVariants?.mode).toBe('image')
    expect(first.inputs['layers.layer2.image']).toEqual(['imageA', 0])
    expect(original.sink!.inputs.number).toEqual([`first${suffix}`, 3])
    if (operation === 'detach') {
      const detached = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
        kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveBoundarySample),
      }))
      expect(detached.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
      const localized = detached.doc
      expect(localized.graphs.root!.nodes.first!.type).not.toBe(doc.graphs.root!.nodes.first!.type)
      expect(promptOf(localized)).toEqual(original)
      expect(detached.dispatch({ command: 'node.setValues', params: { graphId: 'root', nodeId: 'first',
        values: { 'layers.layer0.strength': 0.7, 'mode.mix': 0.73 } } }).ok).toBe(true)
      const edited = detached.doc
      expect(detached.dispatch({ command: 'dynamic.selectOption', params: {
        graphId: 'root', nodeId: 'first', construct: 'mode', option: 'image',
      } }).ok).toBe(true)
      const selected = detached.doc
      for (const current of [selected, loadDocument(JSON.parse(JSON.stringify(selected))).document!]) {
        const prompt = promptOf(current)
        expect(prompt[`first${suffix}`]).toEqual({ ...first, slotVariants: { ...first.slotVariants, mode: 'image' },
          inputs: Object.fromEntries(Object.entries({ ...first.inputs, 'layers.layer2.strength': 0.7, 'mode.mix': 0.73 })
            .filter(([key]) => key !== 'mode.text')) })
        expect(prompt[`second${suffix}`]).toEqual(original[`second${suffix}`])
        expect(current.graphs.root!.nodes.first!.values['mode.text']).toBe('first text')
        expect(current.graphs.root!.nodes.second).toEqual(doc.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(doc.graphs.detail)
        expect(current.graphs.portrait).toEqual(doc.graphs.portrait)
      }
      expect(detached.dispatch({ command: 'node.setValues', params: { graphId: 'root', nodeId: 'first',
        values: {}, unset: ['mode.mix'] } }).ok).toBe(true)
      const outerCleared = detached.doc
      const privateGraph = selected.graphs.root!.nodes.first!.type.slice(1)
      expect(detached.dispatch({ command: 'node.setValues', params: {
        graphId: privateGraph, nodeId: depth === 1 ? 'sample' : 'detail', values: { 'mode.mix': 0.79 },
      } }).ok).toBe(true)
      const privateEdited = detached.doc
      for (const current of [privateEdited, loadDocument(JSON.parse(JSON.stringify(privateEdited))).document!]) {
        const prompt = promptOf(current)
        expect(prompt[`first${suffix}`]!.inputs['mode.mix']).toBe(0.79)
        expect(prompt[`second${suffix}`]).toEqual(original[`second${suffix}`])
        expect(current.graphs.root!.nodes.second).toEqual(doc.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(doc.graphs.detail)
        expect(current.graphs.portrait).toEqual(doc.graphs.portrait)
        expect(prompt.sink!.inputs.number).toEqual([`first${suffix}`, 3])
      }
      for (const expected of [outerCleared, selected, edited, localized, doc]) {
        expect(detached.undo()).toBe(true)
        expect(detached.doc).toEqual(expected)
      }
      expect(promptOf(detached.doc)).toEqual(original)
      for (let step = 0; step < 5; step++) expect(detached.redo()).toBe(true)
      expect(detached.doc).toEqual(privateEdited)
      expect(promptOf(loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!)).toEqual(promptOf(privateEdited))
    } else {
      const mode = operation
      const before = { ...doc, graphs: { ...doc.graphs, root: { ...doc.graphs.root!, nodes: { ...doc.graphs.root!.nodes,
        first: { ...doc.graphs.root!.nodes.first!, ...(mode === 'loop' ? { region: { kind: 'map', elementPorts: ['strength'] } } : { mode }) },
      } } } } as WorkflowDocument
      const result = await flatten(before, 'root', [], 'first', resolveBoundarySample)
      if (mode === 'bypassed' || mode === 'loop') {
        expect(result.ok).toBe(false)
        expect(result.reports.map((entry) => entry.code)).toContain(mode === 'bypassed'
          ? 'subgraph.flatten.modeUnsupported' : 'subgraph.flatten.regionUnsupported')
        expect(result.session.doc).toEqual(before)
        expect(result.session.canUndo).toBe(false)
        return
      }
      expect(result.ok, JSON.stringify(result.reports)).toBe(true)
      const flattened = result.session.doc
      const replacements = Object.values(flattened.graphs.root!.nodes).filter((entry) => before.graphs.root!.nodes[entry.id] === undefined)
      expect(replacements).toHaveLength(1)
      const receiver = depth === 1 ? replacements[0]!.id : `${replacements[0]!.id}.sample`
      for (const current of [flattened, loadDocument(JSON.parse(JSON.stringify(flattened))).document!]) {
        const prompt = promptOf(current)
        expect(Object.entries(prompt).filter(([id, entry]) => entry.class_type === 'Boundary sample' && !id.startsWith('second.'))
          .map(([id]) => id)).toEqual(mode === 'active' ? [receiver] : [])
        if (mode === 'active') expect(prompt[receiver]).toEqual(first)
        expect(prompt.sink!.inputs.number).toEqual(mode === 'active' ? [receiver, 3] : undefined)
        const awakened = { ...current, graphs: { ...current.graphs, root: { ...current.graphs.root!, nodes: {
          ...current.graphs.root!.nodes, [replacements[0]!.id]: { ...current.graphs.root!.nodes[replacements[0]!.id]!, mode: 'active' },
        } } } } as WorkflowDocument
        const awakePrompt = promptOf(awakened)
        expect(awakePrompt[receiver]).toEqual(first)
        expect(awakePrompt.sink!.inputs.number).toEqual([receiver, 3])
        expect(prompt[`second${suffix}`]).toEqual(original[`second${suffix}`])
        expect(current.graphs.root!.nodes.second).toEqual(doc.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(doc.graphs.detail)
        expect(current.graphs.portrait).toEqual(doc.graphs.portrait)
      }
      expect(result.session.undo()).toBe(true)
      expect(result.session.doc.graphs).toEqual({ ...before.graphs,
        root: { ...before.graphs.root!, nextOrdinal: flattened.graphs.root!.nextOrdinal } })
      expect(result.session.redo()).toBe(true)
      expect(result.session.doc).toEqual(flattened)
    }
  })

  it.each(([1, 2] as const).flatMap((depth) =>
    (['detach', 'active', 'muted', 'bypassed', 'loop'] as const).flatMap((operation) =>
      [false, true].map((allText) => [depth, operation, allText] as const))))
  ('keeps standalone option wires at depth %s through %s with all-text=%s', async (depth, operation, allText) => {
    const doc = boundarySample(depth)
    for (const id of ['detail', 'portrait']) {
      const graph = doc.graphs[id]
      if (graph !== undefined) Object.assign(graph, { boundary: { body: graph.boundary!.body
        .filter((row) => !('id' in row && row.id === 'mode')) } })
    }
    Object.assign(doc.graphs.detail!.nodes, { extra: {
      ...structuredClone(doc.graphs.detail!.nodes.sample!), id: 'extra',
      values: { ...doc.graphs.detail!.nodes.sample!.values, strength: 0.53,
        'mode.text': 'private extra caption', 'mode.mix': 0.73 },
    } })
    Object.assign(doc.graphs.root!.nodes, { captionRuntime: { id: 'captionRuntime', type: 'StringSource', values: {} } })
    const setup = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveBoundarySample),
    }))
    const edit = (command: string, params: Record<string, Json>) => {
      const result = setup.dispatch({ command, params })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    }
    edit('dynamic.selectOption', { graphId: 'detail', nodeId: 'sample', construct: 'mode', option: 'text' })
    if (allText) edit('dynamic.selectOption', { graphId: 'detail', nodeId: 'extra', construct: 'mode', option: 'text' })
    for (const [itemId, port] of [['caption', 'mode.text'], ['photo', 'mode.picture']] as const) {
      edit('boundary.addItem', { graphId: 'detail', side: 'inputs', itemId,
        node: 'sample', port, ...(itemId === 'caption' ? { promoted: true } : {}) })
      edit('boundary.addBinding', { graphId: 'detail', itemId, node: 'extra', port })
    }
    if (depth === 2) for (const [itemId, port] of [['heading', 'caption'], ['picture', 'photo']] as const) {
      edit('boundary.addItem', { graphId: 'portrait', side: 'inputs', itemId,
        node: 'detail', port, ...(itemId === 'heading' ? { promoted: true } : {}) })
    }
    const caption = depth === 1 ? 'caption' : 'heading'
    const picture = depth === 1 ? 'photo' : 'picture'
    edit('node.setValue', { graphId: 'root', nodeId: 'first', inputId: caption, value: 'first dormant caption' })
    edit('node.setValue', { graphId: 'root', nodeId: 'second', inputId: caption, value: 'sibling caption' })
    edit('link.connect', { graphId: 'root', from: { node: 'captionRuntime', port: 'text' }, to: { node: 'first', port: caption } })
    edit('link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: picture } })
    edit('link.connect', { graphId: 'root', from: { node: 'first', port: 'output91' }, to: { node: 'sink', port: 'number' } })
    const configured = setup.doc
    const promptOf = (current: WorkflowDocument) => {
      const result = compile({ document: current, revision: 1, resolve: resolveBoundarySample, scope: { kind: 'full' },
        connection: asConnectionId('standalone-lifecycle'), schemaHash: 'standalone-lifecycle' })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (!result.ok) throw new Error('Standalone option lifecycle did not compile')
      return result.artifact.prompt
    }
    const suffix = depth === 1 ? '' : '.detail'
    const original = promptOf(configured)
    const first = original[`first${suffix}.sample`]!
    const extra = original[`first${suffix}.extra`]!
    expect(first.inputs['mode.text']).toEqual(['captionRuntime', 0])
    expect(first.inputs).not.toHaveProperty('mode.picture')
    expect(first.slotVariants?.mode).toBe('text')
    expect(extra.inputs['mode.picture']).toEqual(allText ? undefined : ['imageA', 0])
    expect(extra.inputs['mode.text']).toEqual(allText ? ['captionRuntime', 0] : undefined)
    expect(extra.inputs.strength).toBe(0.53)
    expect(extra.inputs['mode.mix']).toBe(0.73)
    expect(extra.slotVariants?.mode).toBe(allText ? 'text' : 'image')
    expect(original[`second${suffix}.sample`]!.inputs['mode.text']).toBe('sibling caption')
    expect(original.sink!.inputs.number).toEqual([`first${suffix}.sample`, 6])
    if (operation === 'detach') {
      edit('occurrence.localize', { graphId: 'root', nodeId: 'first' })
      const detached = setup.doc
      expect(detached.graphs.root!.nodes.first!.type).not.toBe(configured.graphs.root!.nodes.first!.type)
      expect(promptOf(detached)).toEqual(original)
      const link = Object.values(detached.graphs.root!.links).find((entry) =>
        'port' in entry.to && entry.to.node === 'first' && entry.to.port === caption)!
      edit('link.disconnect', { graphId: 'root', linkId: link.id })
      edit('node.setValue', { graphId: 'root', nodeId: 'first', inputId: caption, value: 'detached caption' })
      const changed = setup.doc
      for (const current of [changed, loadDocument(JSON.parse(JSON.stringify(changed))).document!]) {
        const prompt = promptOf(current)
        expect(prompt).toEqual({ ...original, [`first${suffix}.sample`]: {
          ...first, inputs: { ...first.inputs, 'mode.text': 'detached caption' },
        }, ...(allText ? { [`first${suffix}.extra`]: {
          ...extra, inputs: { ...extra.inputs, 'mode.text': 'detached caption' },
        } } : {}) })
        expect(current.graphs.root!.nodes.second).toEqual(configured.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(configured.graphs.detail)
        expect(current.graphs.portrait).toEqual(configured.graphs.portrait)
      }
      for (let step = 0; step < 3; step++) expect(setup.undo()).toBe(true)
      expect(setup.doc).toEqual(configured)
      for (let step = 0; step < 3; step++) expect(setup.redo()).toBe(true)
      expect(setup.doc).toEqual(changed)
      return
    }
    const before = { ...configured, graphs: { ...configured.graphs, root: { ...configured.graphs.root!, nodes: {
      ...configured.graphs.root!.nodes, first: { ...configured.graphs.root!.nodes.first!,
        ...(operation === 'loop' ? { region: { kind: 'map', elementPorts: [caption] } } : { mode: operation }),
      },
    } } } } as WorkflowDocument
    const result = await flatten(before, 'root', [], 'first', resolveBoundarySample)
    if (operation === 'bypassed' || operation === 'loop') {
      expect(result.ok).toBe(false)
      expect(result.reports.map((entry) => entry.code)).toContain(operation === 'bypassed'
        ? 'subgraph.flatten.modeUnsupported' : 'subgraph.flatten.regionUnsupported')
      expect(result.session.doc).toEqual(before)
      expect(result.session.canUndo).toBe(false)
      return
    }
    expect(result.ok, JSON.stringify(result.reports)).toBe(true)
    const flattened = result.session.doc
    const replacements = Object.values(flattened.graphs.root!.nodes).filter((entry) => before.graphs.root!.nodes[entry.id] === undefined)
    expect(replacements).toHaveLength(depth === 1 ? 2 : 1)
    const primary = depth === 1 ? replacements.find((entry) => entry.values.strength === 0.2)! : replacements[0]!
    const primaryId = depth === 1 ? primary.id : `${primary.id}.sample`
    const extraId = depth === 1 ? replacements.find((entry) => entry.id !== primary.id)!.id : `${primary.id}.extra`
    for (const current of [flattened, loadDocument(JSON.parse(JSON.stringify(flattened))).document!]) {
      const prompt = promptOf(current)
      expect(prompt[primaryId]).toEqual(operation === 'active' ? first : undefined)
      expect(prompt[extraId]).toEqual(operation === 'active' ? extra : undefined)
      expect(prompt.sink!.inputs.number).toEqual(operation === 'active' ? [primaryId, 6] : undefined)
      const awake = { ...current, graphs: { ...current.graphs, root: { ...current.graphs.root!, nodes: {
        ...current.graphs.root!.nodes, ...Object.fromEntries(replacements.map((entry) => [entry.id, { ...entry, mode: 'active' }])),
      } } } } as WorkflowDocument
      const awakened = promptOf(awake)
      expect(awakened[primaryId]).toEqual(first)
      expect(awakened[extraId]).toEqual(extra)
      expect(awakened.sink!.inputs.number).toEqual([primaryId, 6])
      const revived = new DocumentStore(awake, coreCommandRegistry(), 200, undefined, () => ({
        kind: 'initial', schemaResolverFor: (document) => documentResolver(document, resolveBoundarySample),
      }))
      if (depth === 2) expect(revived.dispatch({ command: 'occurrence.localize', params: {
        graphId: 'root', nodeId: primary.id,
      } }).ok).toBe(true)
      const targetGraph = depth === 1 ? 'root' : revived.doc.graphs.root!.nodes[primary.id]!.type.slice(1)
      for (const [nodeId, option] of [[depth === 1 ? primary.id : 'sample', 'image'],
        [depth === 1 ? extraId : 'extra', allText ? 'image' : 'text']]) expect(revived.dispatch({ command: 'dynamic.selectOption', params: {
        graphId: targetGraph, nodeId: nodeId!, construct: 'mode', option: option!,
      } }).ok).toBe(true)
      for (const restored of [revived.doc, loadDocument(JSON.parse(JSON.stringify(revived.doc))).document!]) {
        const activePrompt = promptOf(restored)
        expect(activePrompt[primaryId]).toEqual({ ...first, slotVariants: { ...first.slotVariants, mode: 'image' },
          inputs: { ...Object.fromEntries(Object.entries(first.inputs).filter(([id]) => id !== 'mode.text')),
            'mode.picture': ['imageA', 0] },
        })
        expect(activePrompt[extraId]).toEqual({ ...extra, slotVariants: { ...extra.slotVariants, mode: allText ? 'image' : 'text' },
          inputs: { ...Object.fromEntries(Object.entries(extra.inputs).filter(([id]) => id !== (allText ? 'mode.text' : 'mode.picture'))),
            [allText ? 'mode.picture' : 'mode.text']: [allText ? 'imageA' : 'captionRuntime', 0] },
        })
        expect(activePrompt[`second${suffix}.sample`]).toEqual(original[`second${suffix}.sample`])
        expect(activePrompt[`second${suffix}.extra`]).toEqual(original[`second${suffix}.extra`])
      }
      expect(revived.undo()).toBe(true)
      expect(revived.undo()).toBe(true)
      if (depth === 2) expect(revived.undo()).toBe(true)
      expect(revived.doc).toEqual(awake)
      expect(prompt[`second${suffix}.sample`]).toEqual(original[`second${suffix}.sample`])
      expect(prompt[`second${suffix}.extra`]).toEqual(original[`second${suffix}.extra`])
      expect(current.graphs.root!.nodes.second).toEqual(configured.graphs.root!.nodes.second)
      expect(current.graphs.detail).toEqual(configured.graphs.detail)
      expect(current.graphs.portrait).toEqual(configured.graphs.portrait)
    }
    expect(result.session.undo()).toBe(true)
    expect(result.session.doc.graphs).toEqual({ ...before.graphs,
      root: { ...before.graphs.root!, nextOrdinal: flattened.graphs.root!.nextOrdinal } })
    expect(result.session.redo()).toBe(true)
    expect(result.session.doc).toEqual(flattened)
  })

  const calculator = node('Calculator', [floatField('seed', 3), floatField('bias', 7), {
    ...floatField('total', 5), automatic: { formula: 'seed * 2 + bias' },
    labelFormula: { formula: '"Total " + fixed(seed * 2 + bias, 0)' }, tooltip: 'Calculated in this receiver',
  }, { kind: 'output', id: 'result', type: FLOAT }])
  const lookupCalculator: NodeSchema = { ...calculator, type: 'LookupCalculator', body: calculator.body.map((row) =>
    row.kind === 'input' && row.id === 'total' ? { ...row, automatic: { lookup: 'calculate_total', args: ['seed', 'bias'] } } : row) }
  const formulaResolve = (type: string) => type === 'Calculator' ? calculator
    : type === 'LookupCalculator' ? lookupCalculator
    : type === 'OptionalValue' ? node(type, [{ kind: 'input', id: 'total', type: FLOAT, optional: true,
      widget: { widgetType: 'FLOAT', options: {} } }])
    : type === 'FormulaSink' ? node(type, [{ kind: 'input', id: 'value', type: FLOAT, optional: true }])
      : type === 'Text' ? { ...node(type, [{ kind: 'input', id: 'value', type: STRING, optional: true }]), isOutputNode: false } : undefined
  const formulaFixture = (depth: 1 | 2, calculation: 'formula' | 'lookup'): WorkflowDocument => {
    const bind = (id: string, target: string, port: string) => ({
      kind: 'input', id, promoted: true, binds: { kind: 'port', node: target, port },
    })
    return {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'formula-lifecycle', root: 'root',
      graphs: {
        root: { id: 'root', name: 'Root', ...empty, nodes: {
          first: { id: 'first', type: depth === 1 ? '#detail' : '#portrait', values: { [depth === 1 ? 'start' : 'control']: 21 } },
          second: { id: 'second', type: depth === 1 ? '#detail' : '#portrait', values: { [depth === 1 ? 'start' : 'control']: 13 } },
          sink: { id: 'sink', type: 'FormulaSink', values: {} },
        }, links: { wire: { id: 'wire', from: { node: 'first', port: depth === 1 ? 'out' : 'result' }, to: { node: 'sink', port: 'value' } } } },
        detail: { id: 'detail', name: 'Detail', ...empty, nodes: {
          sample: { id: 'sample', type: calculation === 'formula' ? 'Calculator' : 'LookupCalculator', values: { seed: 3, bias: 7 } },
          other: { id: 'other', type: calculation === 'formula' ? 'Calculator' : 'LookupCalculator', values: { seed: 11, bias: 13 } },
          text: { id: 'text', type: 'Text', values: {} },
        }, boundary: { body: [bind('start', 'sample', 'seed'), bind('total', 'sample', 'total'),
          { kind: 'output', id: 'out', binds: { kind: 'port', node: 'sample', port: 'result' } },
        ] } },
        ...(depth === 2 ? { portrait: { id: 'portrait', name: 'Portrait', ...empty,
          nodes: { detail: { id: 'detail', type: '#detail', values: { start: 7 } } },
          boundary: { body: [bind('control', 'detail', 'start'), bind('resultValue', 'detail', 'total'),
            { kind: 'output', id: 'result', binds: { kind: 'port', node: 'detail', port: 'out' } },
          ] },
        } } : {}),
      }, view: { graphs: { root: { nodes: {} }, detail: { nodes: {} }, portrait: { nodes: {} } } },
    } as unknown as WorkflowDocument
  }
  const formulaRun = (doc: WorkflowDocument) => {
    const lookupAnswers = (lookup: string, args: readonly unknown[]) => {
      expect(lookup).toBe('calculate_total')
      expect(args.every((value) => typeof value === 'number')).toBe(true)
      return { state: 'ready' as const, answer: Number(args[0]) * 2 + Number(args[1]) }
    }
    const result = compile({ document: doc, revision: 1, resolve: formulaResolve, scope: { kind: 'full' },
      connection: asConnectionId('formula-lifecycle'), schemaHash: 'formula-lifecycle', lookupAnswers })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('formula lifecycle document did not compile')
    const labels: Record<string, string | undefined> = {}
    const calculated = Object.fromEntries(Object.entries(result.artifact.prompt).filter(([, receiver]) =>
      receiver.class_type === 'Calculator' || receiver.class_type === 'LookupCalculator').map(([id, receiver]) => {
      const row = elabInputsOf(elaborateInterface(formulaResolve(receiver.class_type)!, { values: receiver.inputs as never },
        undefined, { lookupAnswers })).find((field) => field.spec.id === 'total')!
      const stored = Object.hasOwn(receiver.inputs, 'total')
      expect(row.automatic?.state).toBe(stored ? undefined : 'worked-out')
      labels[id] = row.spec.displayName
      return [id, stored ? receiver.inputs.total : row.automatic!.value]
    }))
    return { prompt: result.artifact.prompt, calculated, labels, automaticCalls: result.artifact.automaticCalls ?? [] }
  }

  it.each([[1, 'formula'], [2, 'formula'], [1, 'lookup'], [2, 'lookup']] as const)('automatic dependency fan-out at depth %s with %s keeps each receiver scope through edits and reload', (depth, calculation) => {
    const doc = formulaFixture(depth, calculation)
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, formulaResolve),
    }))
    const suffix = depth === 1 ? '' : '.detail'
    const check = (current: WorkflowDocument, seed: number, first: number, other: number) => {
      const { prompt, calculated, labels, automaticCalls } = formulaRun(current)
      expect(automaticCalls).toEqual(calculation === 'formula' ? [] : [
        { runtimeNodeId: `first${suffix}.sample`, inputId: 'total', lookup: 'calculate_total', args: [seed, 7] },
        { runtimeNodeId: `first${suffix}.other`, inputId: 'total', lookup: 'calculate_total', args: [seed, 13] },
        { runtimeNodeId: `second${suffix}.sample`, inputId: 'total', lookup: 'calculate_total', args: [13, 7] },
        { runtimeNodeId: `second${suffix}.other`, inputId: 'total', lookup: 'calculate_total', args: [13, 13] },
      ])
      expect(calculated).toEqual({
        [`first${suffix}.sample`]: first, [`first${suffix}.other`]: other,
        [`second${suffix}.sample`]: 33, [`second${suffix}.other`]: 39,
      })
      expect(labels).toEqual({
        [`first${suffix}.sample`]: `Total ${first}`, [`first${suffix}.other`]: `Total ${other}`,
        [`second${suffix}.sample`]: 'Total 33', [`second${suffix}.other`]: 'Total 39',
      })
      expect(prompt[`first${suffix}.sample`]!.inputs).toEqual({ seed, bias: 7 })
      expect(prompt[`first${suffix}.other`]!.inputs).toEqual({ seed, bias: 13 })
      expect(prompt[`second${suffix}.sample`]!.inputs).toEqual({ seed: 13, bias: 7 })
      expect(prompt[`second${suffix}.other`]!.inputs).toEqual({ seed: 13, bias: 13 })
      expect(prompt.sink!.inputs).toEqual({ value: [`first${suffix}.sample`, 0] })
      expect(current.graphs.detail).toEqual(joined.graphs.detail)
      expect(current.graphs.portrait).toEqual(doc.graphs.portrait)
    }
    expect(store.dispatch({ command: 'boundary.addBinding', params: {
      graphId: 'detail', itemId: 'start', node: 'other', port: 'seed',
    } }).ok).toBe(true)
    const joined = store.doc
    check(joined, 21, 49, 55)
    const refused = store.dispatch({ command: 'boundary.addBinding', params: {
      graphId: 'detail', itemId: 'start', node: 'text', port: 'value',
    } })
    expect(refused.ok).toBe(false)
    expect(refused.diagnostics.some((entry) => entry.code === 'boundary.fanoutTypeMismatch')).toBe(true)
    expect(store.doc).toBe(joined)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(doc)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(joined)
    expect(store.dispatch({ command: 'node.setValue', params: {
      graphId: 'root', nodeId: 'first', inputId: depth === 1 ? 'start' : 'control', value: 31,
    } }).ok).toBe(true)
    const edited = store.doc
    check(edited, 31, 69, 75)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(joined)
    check(store.doc, 21, 49, 55)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(edited)
    check(loadDocument(JSON.parse(JSON.stringify(edited))).document!, 31, 69, 75)
  })

  it.each([[1, 'formula'], [2, 'formula'], [1, 'lookup'], [2, 'lookup']] as const)('automatic detach and separate flatten modes at depth %s with %s preserve native scopes and output wires', async (depth, calculation) => {
    const doc = formulaFixture(depth, calculation)
    const calculatorType = calculation === 'formula' ? 'Calculator' : 'LookupCalculator'
    const suffix = depth === 1 ? '' : '.detail'
    const initial = formulaRun(doc)
    expect(initial.automaticCalls).toEqual(calculation === 'formula' ? [] : [
      { runtimeNodeId: `first${suffix}.sample`, inputId: 'total', lookup: 'calculate_total', args: [21, 7] },
      { runtimeNodeId: `first${suffix}.other`, inputId: 'total', lookup: 'calculate_total', args: [11, 13] },
      { runtimeNodeId: `second${suffix}.sample`, inputId: 'total', lookup: 'calculate_total', args: [13, 7] },
      { runtimeNodeId: `second${suffix}.other`, inputId: 'total', lookup: 'calculate_total', args: [11, 13] },
    ])
    expect(initial.calculated).toEqual({
      [`first${suffix}.sample`]: 49, [`first${suffix}.other`]: 35,
      [`second${suffix}.sample`]: 33, [`second${suffix}.other`]: 35,
    })
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({
      kind: 'initial', schemaResolverFor: (current) => documentResolver(current, formulaResolve),
    }))
    expect(store.dispatch({ command: 'occurrence.localize', params: { graphId: 'root', nodeId: 'first' } }).ok).toBe(true)
    const localized = store.doc
    expect(formulaRun(localized)).toEqual(initial)
    const privateGraph = localized.graphs.root!.nodes.first!.type.slice(1)
    expect(store.dispatch({ command: 'node.setValue', params: {
      graphId: privateGraph, nodeId: depth === 1 ? 'sample' : 'detail', inputId: depth === 1 ? 'bias' : 'total', value: 19,
    } }).ok).toBe(true)
    const privateDoc = store.doc
    const privateRun = formulaRun(privateDoc)
    expect(privateRun.automaticCalls).toEqual(calculation === 'formula' ? [] : [
      ...(depth === 1 ? [{ runtimeNodeId: `first${suffix}.sample`, inputId: 'total', lookup: 'calculate_total', args: [21, 19] }] : []),
      { runtimeNodeId: `first${suffix}.other`, inputId: 'total', lookup: 'calculate_total', args: [11, 13] },
      { runtimeNodeId: `second${suffix}.sample`, inputId: 'total', lookup: 'calculate_total', args: [13, 7] },
      { runtimeNodeId: `second${suffix}.other`, inputId: 'total', lookup: 'calculate_total', args: [11, 13] },
    ])
    expect(privateRun.calculated).toEqual({ ...initial.calculated, [`first${suffix}.sample`]: depth === 1 ? 61 : 19 })
    expect(privateRun.labels[`first${suffix}.sample`]).toBe(depth === 1 ? 'Total 61' : 'Total 49')
    expect(privateRun.prompt[`first${suffix}.sample`]!.inputs).toEqual(depth === 1
      ? { seed: 21, bias: 19 } : { seed: 21, bias: 7, total: 19 })
    expect(privateRun.prompt[`second${suffix}.sample`]!.inputs).toEqual({ seed: 13, bias: 7 })
    expect(privateDoc.graphs.detail).toEqual(doc.graphs.detail)
    expect(privateDoc.graphs.portrait).toEqual(doc.graphs.portrait)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(localized)
    expect(formulaRun(store.doc)).toEqual(initial)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(doc)
    expect(store.redo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(privateDoc)
    const reopened = loadDocument(JSON.parse(JSON.stringify(privateDoc))).document!
    expect(reopened).toEqual(privateDoc)
    expect(formulaRun(reopened)).toEqual(privateRun)

    for (const [mode, total, fanout, primaryTotal] of [
      ['active', undefined, false, undefined], ['active', 19, false, undefined],
      ['active', undefined, true, undefined], ['active', undefined, true, 17], ['active', 19, true, 17],
      ['muted', undefined, false, undefined], ['bypassed', undefined, false, undefined], ['loop', undefined, false, undefined],
    ] as const) {
      const original = doc.graphs.root!.nodes.first!
      const first = total === undefined ? original : { ...original, values: {
        ...original.values, [depth === 1 ? 'total' : 'resultValue']: total,
      } }
      const bodyId = depth === 1 ? 'detail' : 'portrait'
      const body = doc.graphs[bodyId]!
      const before: WorkflowDocument = { ...doc, graphs: { ...doc.graphs,
        ...(fanout ? { [bodyId]: { ...body, nodes: { ...body.nodes,
          optional: { id: 'optional', type: 'OptionalValue', values: {} },
          ...(primaryTotal === undefined ? {} : { [depth === 1 ? 'sample' : 'detail']: {
            ...body.nodes[depth === 1 ? 'sample' : 'detail']!,
            values: { ...body.nodes[depth === 1 ? 'sample' : 'detail']!.values, total: primaryTotal },
          } }),
          ...(depth === 1 ? { other: { ...body.nodes.other!, values: { seed: 11, bias: 13, total: 5 } } }
            : { extra: { id: 'extra', type: '#detail', values: { start: 11, total: 5 } } }),
        }, boundary: { body: body.boundary!.body.map((item) => 'id' in item && item.id === (depth === 1 ? 'total' : 'resultValue')
          ? { ...item, alsoBinds: [{ kind: 'port', node: depth === 1 ? 'other' : 'extra', port: 'total' },
            { kind: 'port', node: 'optional', port: 'total' }] } : item) } } } : {}),
        root: { ...doc.graphs.root!, nodes: {
        ...doc.graphs.root!.nodes, first: mode === 'loop' ? { ...first, region: { kind: 'map', elementPorts: [depth === 1 ? 'start' : 'control'] } }
          : { ...first, mode },
      } } } } as WorkflowDocument
      if (fanout) {
        const expected = formulaRun(before)
        expect(expected.prompt['first.optional']!.inputs).toEqual(total === undefined ? {} : { total })
        expect(expected.prompt[`first.${depth === 1 ? 'other' : 'extra.sample'}`]!.inputs.total).toBe(total ?? 5)
        expect(expected.prompt[`first${suffix}.sample`]!.inputs).toEqual({ seed: 21, bias: 7,
          ...(total === undefined && primaryTotal === undefined ? {} : { total: total ?? primaryTotal }),
        })
      }
      const result = await flatten(before, 'root', [], 'first', formulaResolve)
      if (mode === 'bypassed' || mode === 'loop') {
        expect(result.ok).toBe(false)
        expect(result.reports.map((entry) => entry.code)).toContain(mode === 'loop' ? 'subgraph.flatten.regionUnsupported' : 'subgraph.flatten.modeUnsupported')
        expect(result.session.doc).toEqual(before)
        expect(result.session.canUndo).toBe(false)
        continue
      }
      expect(result.ok, JSON.stringify(result.reports)).toBe(true)
      const flattened = result.session.doc
      const replacement = Object.values(flattened.graphs.root!.nodes).find((entry) =>
        depth === 1 ? entry.type === calculatorType && entry.values.seed === 21 : entry.type === '#detail')!
      expect(replacement.mode ?? 'active').toBe(mode)
      const receivingId = depth === 1 ? replacement.id : `${replacement.id}.sample`
      const run = formulaRun(flattened)
      const firstOther = depth === 1 ? Object.values(flattened.graphs.root!.nodes).find((entry) =>
        entry.type === calculatorType && entry.values.seed === 11)!.id : `${replacement.id}.other`
      const extraOther = fanout && depth === 2 ? `${Object.values(flattened.graphs.root!.nodes).find((entry) =>
        entry.type === '#detail' && entry.values.start === 11)!.id}.other` : undefined
      const calls = [
        ...(primaryTotal === undefined ? [{ runtimeNodeId: `second${suffix}.sample`, inputId: 'total', lookup: 'calculate_total', args: [13, 7] }] : []),
        ...(fanout && depth === 1 ? [] : [{ runtimeNodeId: `second${suffix}.other`, inputId: 'total', lookup: 'calculate_total', args: [11, 13] }]),
        ...(mode === 'active' && total === undefined && primaryTotal === undefined
          ? [{ runtimeNodeId: receivingId, inputId: 'total', lookup: 'calculate_total', args: [21, 7] }] : []),
        ...(mode === 'active' && !(fanout && depth === 1)
          ? [{ runtimeNodeId: firstOther, inputId: 'total', lookup: 'calculate_total', args: [11, 13] }] : []),
        ...(extraOther === undefined ? [] : [{ runtimeNodeId: extraOther, inputId: 'total', lookup: 'calculate_total', args: [11, 13] }]),
        ...(fanout && depth === 2 ? [{ runtimeNodeId: 'second.extra.other', inputId: 'total', lookup: 'calculate_total', args: [11, 13] }] : []),
      ]
      expect([...run.automaticCalls].sort((a, b) => a.runtimeNodeId.localeCompare(b.runtimeNodeId))).toEqual(
        calculation === 'formula' ? [] : calls.sort((a, b) => a.runtimeNodeId.localeCompare(b.runtimeNodeId)))
      expect(run.calculated[`second${suffix}.sample`]).toBe(primaryTotal ?? 33)
      expect(run.calculated[`second${suffix}.other`]).toBe(fanout && depth === 1 ? 5 : 35)
      if (mode === 'active') {
        expect(run.calculated[receivingId]).toBe(total ?? primaryTotal ?? 49)
        expect(run.prompt[receivingId]!.inputs).toEqual({ seed: 21, bias: 7,
          ...(total === undefined && primaryTotal === undefined ? {} : { total: total ?? primaryTotal }),
        })
        expect(run.labels[receivingId]).toBe('Total 49')
        expect(run.prompt.sink!.inputs).toEqual({ value: [receivingId, 0] })
        if (fanout) {
          const optional = Object.values(flattened.graphs.root!.nodes).find((entry) => entry.type === 'OptionalValue')!
          expect(run.prompt[optional.id]!.inputs).toEqual(total === undefined ? {} : { total })
          const secondary = Object.values(flattened.graphs.root!.nodes).find((entry) =>
            depth === 1 ? entry.type === calculatorType && entry.values.seed === 11 : entry.type === '#detail' && entry.values.start === 11)!
          expect(run.prompt[depth === 1 ? secondary.id : `${secondary.id}.sample`]!.inputs.total).toBe(total ?? 5)
          const inputs = (prompt: typeof run.prompt) => Object.values(prompt).filter((entry) => entry.class_type === calculatorType)
            .map((entry) => JSON.stringify(entry.inputs)).sort()
          expect(inputs(run.prompt)).toEqual(inputs(formulaRun(before).prompt))
        }
      } else {
        expect(Object.keys(run.calculated).sort()).toEqual([`second${suffix}.other`, `second${suffix}.sample`])
        expect(run.prompt.sink!.inputs).toEqual({})
      }
      expect(flattened.graphs.detail).toEqual(before.graphs.detail)
      expect(flattened.graphs.portrait).toEqual(before.graphs.portrait)
      expect(result.session.undo()).toBe(true)
      expect(result.session.doc).toEqual({ ...before, graphs: { ...before.graphs,
        root: { ...before.graphs.root!, nextOrdinal: flattened.graphs.root!.nextOrdinal },
      } })
      expect(result.session.redo()).toBe(true)
      expect(result.session.doc).toEqual(flattened)
      expect(formulaRun(loadDocument(JSON.parse(JSON.stringify(flattened))).document!)).toEqual(run)
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
    const after = session.doc
    expect(after.graphs.root!.nodes.second).toEqual(doc.graphs.root!.nodes.second)
    expect(after.graphs.detail).toEqual(doc.graphs.detail)
    expect(after.graphs.portrait).toEqual(doc.graphs.portrait)
    expect(runOf(loadDocument(JSON.parse(JSON.stringify(after))).document!)).toEqual(before)
    expect(session.undo()).toBe(true)
    expect(session.doc.graphs).toEqual({ ...doc.graphs, root: { ...doc.graphs.root, nextOrdinal: session.doc.graphs.root!.nextOrdinal } })
    expect(session.redo()).toBe(true)
    expect(session.doc).toEqual(after)
    expect(runOf(session.doc)).toEqual(before)
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
    const after = flattened.session.doc
    expect(after.graphs.root!.nodes.second).toEqual(muted.graphs.root!.nodes.second)
    expect(after.graphs.detail).toEqual(muted.graphs.detail)
    expect(after.graphs.portrait).toEqual(muted.graphs.portrait)
    expect(runOf(loadDocument(JSON.parse(JSON.stringify(after))).document!)).toEqual(before)
    expect(flattened.session.undo()).toBe(true)
    expect(flattened.session.doc.graphs).toEqual({ ...muted.graphs,
      root: { ...muted.graphs.root!, nextOrdinal: after.graphs.root!.nextOrdinal },
    })
    expect(flattened.session.redo()).toBe(true)
    expect(flattened.session.doc).toEqual(after)
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
    const localized = session.doc
    // An edit to the detached copy reaches only the first node's run.
    const copy = detached.slice(1)
    expect(session.dispatch({ command: 'node.setValues', params: { graphId: copy, nodeId: 'd',
      values: { 'weights.w0': 0.7, 'mode.strength': 0.73 } } }).ok).toBe(true)
    const privateEdited = session.doc
    const after = runOf(session.doc)
    expect(after.filter((entry) => entry.includes('"weights.w2":0.7'))).toHaveLength(1)
    expect(after.filter((entry) => entry.includes('"weights.w2":0.6'))).toHaveLength(1)
    expect(session.dispatch({ command: 'dynamic.selectOption', params: {
      graphId: 'root', nodeId: 'first', construct: 'look', option: 'image',
    } }).ok).toBe(true)
    const selected = session.doc
    const selectedRun = runOf(selected)
    for (const current of [selected, loadDocument(JSON.parse(JSON.stringify(selected))).document!]) {
      const compiled = compile({ document: current, revision: 1, resolve: resolveSchema,
        scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'test' })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('unreachable')
      expect(compiled.artifact.prompt['first.d.m']!.inputs['mode.strength']).toBe(0.73)
      expect(compiled.artifact.prompt['second.d.m']!.inputs['mode.strength']).toBe(0.6)
      expect(compiled.artifact.prompt['first.d.n']!.inputs['weights.w2']).toBe(0.7)
      expect(compiled.artifact.prompt['second.d.n']!.inputs['weights.w2']).toBe(0.6)
    }
    expect(selected.graphs.root!.nodes.first!.values['look.words']).toBe('portrait')
    expect(selected.graphs.root!.nodes.second).toEqual(doc.graphs.root!.nodes.second)
    expect(selected.graphs.detail).toEqual(doc.graphs.detail)
    expect(selected.graphs.portrait).toEqual(doc.graphs.portrait)
    expect(runOf(loadDocument(JSON.parse(JSON.stringify(selected))).document!)).toEqual(selectedRun)
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(privateEdited)
    expect(runOf(session.doc)).toEqual(after)
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(localized)
    expect(session.undo()).toBe(true)
    expect(session.doc).toEqual(doc)
    expect(session.redo()).toBe(true)
    expect(session.redo()).toBe(true)
    expect(session.redo()).toBe(true)
    expect(session.doc).toEqual(selected)
    expect(runOf(loadDocument(JSON.parse(JSON.stringify(session.doc))).document!)).toEqual(selectedRun)
  })
})
