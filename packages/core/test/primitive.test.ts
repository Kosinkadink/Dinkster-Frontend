import { describe, expect, it } from 'vitest'
import { compile, documentNodeResolver, documentPrimitiveResolver, documentResolver } from '../src/compile/compile.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import type { CommandInvocation } from '../src/commands/contract.js'
import { DocumentStore } from '../src/commands/store.js'
import { lifecycleCanonicalHash, lifecycleFlattenFingerprint, planFlattenBoundaryRoutes } from '../src/lifecycle/planner.js'
import { planFlattenOccurrenceTopology } from '../src/compile/effective-topology.js'
import type { MenuActionItem, MenuContext, MenuItem } from '../src/menus/contract.js'
import { resetMenuContributions } from '../src/menus/reset-items.js'
import { primitiveForField } from '../src/primitive.js'
import type { NodeData, WorkflowDocument } from '../src/format/document.js'
import { inputsOf, type InputSpec, type NodeSchema, type TypeExpr, type WidgetSpec } from '../src/schema/model.js'
import { loadDocument } from '../src/format/migrate.js'

const INT: TypeExpr = { kind: 'concrete', name: 'INT' }
const COMBO: TypeExpr = { kind: 'concrete', name: 'COMBO' }
const input = (id: string, type: TypeExpr, widget?: WidgetSpec, extra: Partial<InputSpec> = {}): InputSpec =>
  ({ kind: 'input', id, type, ...(widget ? { widget } : {}), ...extra }) as InputSpec
const schemaOf = (type: string, body: NodeSchema['body'], extra: Partial<NodeSchema> = {}): NodeSchema =>
  ({ type, displayName: type, category: 'test', body, isOutputNode: true, ...extra }) as NodeSchema
const intWidget = (options: Record<string, unknown>, extra: Partial<WidgetSpec> = {}): WidgetSpec =>
  ({ widgetType: 'INT', options, ...extra })

const schemas: Record<string, NodeSchema> = {
  Int: schemaOf('Int', [
    input('value', INT, intWidget({ min: -1000, max: 1000 }, { default: 0 })),
    { kind: 'section', id: 'limits', rows: [
      input('minimum', INT, intWidget({}), { optional: true }),
      input('maximum', INT, intWidget({}), { optional: true }),
      input('step', INT, intWidget({}), { optional: true }),
      input('default', INT, intWidget({}), { optional: true }),
    ] },
    { kind: 'output', id: 'INT', type: INT, knownValue: { input: 'value', limits: { min: 'minimum', max: 'maximum', step: 'step', default: 'default' } } },
  ] as NodeSchema['body'], { isOutputNode: false }),
  Choice: schemaOf('Choice', [
    input('value', COMBO),
    { kind: 'output', id: 'COMBO', type: COMBO, knownValue: { input: 'value' } },
  ] as NodeSchema['body'], { isOutputNode: false }),
  Boolean: schemaOf('Boolean', [
    input('value', { kind: 'concrete', name: 'BOOLEAN' }, { widgetType: 'BOOLEAN', options: {} }),
    { kind: 'output', id: 'BOOLEAN', type: { kind: 'concrete', name: 'BOOLEAN' }, knownValue: { input: 'value' } },
  ] as NodeSchema['body'], { isOutputNode: false }),
  Steps: schemaOf('Steps', [input('steps', INT, intWidget({ min: 0, max: 8 }, { default: 4 }), { displayName: 'Steps' })]),
  Count: schemaOf('Count', [input('count', INT, intWidget({ min: 4, max: 12, step: 2 }, { default: 4 }), { displayName: 'Count' })]),
  Counter: schemaOf('Counter', [{ kind: 'output', id: 'INT', type: INT }] as NodeSchema['body'], { isOutputNode: false }),
  Switch: schemaOf('Switch', [
    input('pick', { kind: 'union', names: ['INT', 'BOOLEAN', 'STRING', 'COMBO'] }, undefined, { optional: true }),
    input('names', { kind: 'list', element: { kind: 'concrete', name: 'STRING' } }, undefined, { optional: true, hidden: true }),
    { kind: 'group', id: 'branch', value: input('branch', INT, undefined, { optional: true, lazy: true }), keys: { kind: 'named', names: ['a', 'b', 'c'] }, grows: 'button', minMembers: 1 },
    { kind: 'output', id: 'value', type: INT },
  ] as NodeSchema['body'], { selector: { input: 'pick', group: 'branch', names: 'names' } }),
  Primitive: schemaOf('Primitive', [
    input('value', { kind: 'variable', templateId: 'T' }),
    { kind: 'output', id: 'value', type: { kind: 'variable', templateId: 'T' }, knownValue: { input: 'value' } },
  ] as NodeSchema['body'], { isOutputNode: false }),
  Tint: schemaOf('Tint', [input('tint', { kind: 'concrete', name: 'STRING' }, { widgetType: 'COLOR', options: {}, default: '#ff0000' }, { displayName: 'tint' })]),
  Far: schemaOf('Far', [input('far', INT, intWidget({ min: 20, max: 30 }))]),
  Sampler: schemaOf('Sampler', [input('sampler', COMBO, { widgetType: 'COMBO', options: { options: ['euler', 'dpm', 'ddim'] } })]),
  Scheduler: schemaOf('Scheduler', [input('sampler', COMBO, { widgetType: 'COMBO', options: { options: ['ddim', 'dpm', 'lms'] } })]),
}
const resolve = (type: string): NodeSchema | undefined => schemas[type]

const docOf = (nodes: Record<string, { type: string; values?: Record<string, unknown> }>, links: [string, string, string, string][]): WorkflowDocument => ({
  format: 'dinkster-workflow',
  formatVersion: 1,
  lineage: 'test',
  root: 'g0',
  graphs: { g0: {
    id: 'g0', name: 'g0', nextOrdinal: 100, nets: {}, reroutes: {},
    nodes: Object.fromEntries(Object.entries(nodes).map(([id, node]) => [id, { id, type: node.type, values: node.values ?? {} }])),
    links: Object.fromEntries(links.map(([fromNode, fromPort, toNode, toPort], i) => [`l${i}`,
      { id: `l${i}`, from: { node: fromNode, port: fromPort }, to: { node: toNode, port: toPort } }])),
  } },
  view: { graphs: {} },
}) as unknown as WorkflowDocument

const effectiveOf = (doc: WorkflowDocument, nodeId: string) =>
  documentPrimitiveResolver(doc, resolve)('g0', doc.graphs['g0']!.nodes[nodeId] as NodeData, [])

describe('a primitive works out its value widget', () => {
  it('takes the range the fields it feeds share, with their shared label', () => {
    const doc = docOf({ prim: { type: 'Int', values: { value: 2 } }, a: { type: 'Steps' }, b: { type: 'Count' } },
      [['prim', 'INT', 'a', 'steps'], ['prim', 'INT', 'b', 'count']])
    const effective = effectiveOf(doc, 'prim')!
    expect(effective.spec?.options).toMatchObject({ min: 4, max: 8, step: 2 })
    expect([...effective.derived].sort()).toEqual(['default', 'max', 'min', 'step'])
    expect(effective.label).toBeUndefined()
    expect(effective.diagnostics).toEqual([])
    // Reset goes to the default of the first field it feeds, 4, and the empty Default field shows it dimmed.
    expect(effective.spec?.default).toBe(4)
    const drawn = documentNodeResolver(doc, resolve, documentPrimitiveResolver(doc, resolve))('g0', doc.graphs['g0']!.nodes['prim'] as NodeData, [])!
    expect(inputsOf(drawn).find((row) => row.id === 'default')!.widget).toMatchObject({ default: 4, automatic: true })
    // The value itself is never corrected by working out the range.
    expect(doc.graphs['g0']!.nodes['prim']!.values['value']).toBe(2)
  })

  it('lets its own limits win over the fed ones and draws them on the node', () => {
    const doc = docOf({ prim: { type: 'Int', values: { value: 6, minimum: 5, default: 7 } }, a: { type: 'Steps' } },
      [['prim', 'INT', 'a', 'steps']])
    const effective = effectiveOf(doc, 'prim')!
    expect(effective.spec?.options).toMatchObject({ min: 5, max: 8 })
    expect([...effective.derived]).toEqual(['max'])
    expect(effective.spec?.default).toBe(7)
    const node = doc.graphs['g0']!.nodes['prim'] as NodeData
    const drawn = documentNodeResolver(doc, resolve, documentPrimitiveResolver(doc, resolve))('g0', node, [])!
    const value = inputsOf(drawn).find((row) => row.id === 'value')!
    expect(value.widget?.options).toMatchObject({ min: 5, max: 8 })
    expect(value.displayName).toBe('Steps')
    // The empty Maximum shows the fed fields' 8 as an automatic value; the set Minimum does not.
    const limit = (id: string) => inputsOf(drawn).find((row) => row.id === id)!.widget
    expect(limit('maximum')).toMatchObject({ default: 8, automatic: true })
    expect(limit('minimum')?.automatic).toBeUndefined()
  })

  it('takes a limit arriving over a wire when its value is known before the run, and derives it otherwise', () => {
    // Minimum wired from another Int holding 5: an explicit limit of 5, not the fed field's 0.
    const known = docOf({ prim: { type: 'Int', values: { value: 6 } }, low: { type: 'Int', values: { value: 5 } }, a: { type: 'Steps' } },
      [['prim', 'INT', 'a', 'steps'], ['low', 'INT', 'prim', 'minimum']])
    const fromPrimitive = effectiveOf(known, 'prim')!
    expect(fromPrimitive.spec?.options).toMatchObject({ min: 5, max: 8 })
    expect([...fromPrimitive.derived].sort()).toEqual(['default', 'max'])
    // Minimum wired from a node that produces it while running: not set, so the fed field's 0 applies.
    const runtime = docOf({ prim: { type: 'Int', values: { value: 6, minimum: 3 } }, count: { type: 'Counter' }, a: { type: 'Steps' } },
      [['prim', 'INT', 'a', 'steps'], ['count', 'INT', 'prim', 'minimum']])
    const fromRun = effectiveOf(runtime, 'prim')!
    expect(fromRun.spec?.options).toMatchObject({ min: 0, max: 8 })
    expect([...fromRun.derived].sort()).toEqual(['default', 'max', 'min'])
  })

  it('reports fields that share no range and keeps the value and the wires', () => {
    const doc = docOf({ prim: { type: 'Int', values: { value: 6 } }, a: { type: 'Steps' }, b: { type: 'Far' } },
      [['prim', 'INT', 'a', 'steps'], ['prim', 'INT', 'b', 'far']])
    const effective = effectiveOf(doc, 'prim')!
    expect(effective.diagnostics.map((d) => d.code)).toEqual(['primitive.options.conflict'])
    expect(effective.diagnostics[0]!.message).toContain('a.Steps and b.far')
    expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(2)
  })

  it('offers a Choice the options every field it feeds offers', () => {
    const doc = docOf({ choice: { type: 'Choice' }, a: { type: 'Sampler' }, b: { type: 'Scheduler' } },
      [['choice', 'COMBO', 'a', 'sampler'], ['choice', 'COMBO', 'b', 'sampler']])
    const effective = effectiveOf(doc, 'choice')!
    expect(effective.spec?.widgetType).toBe('COMBO')
    expect(effective.spec?.options['options']).toEqual(['dpm', 'ddim'])
  })

  it('offers a Choice on a Switch\'s Pick the branch names, the ones both Switches have when it feeds two', () => {
    const doc = docOf({ choice: { type: 'Choice' }, s1: { type: 'Switch' }, s2: { type: 'Switch' } },
      [['choice', 'COMBO', 's1', 'pick'], ['choice', 'COMBO', 's2', 'pick']])
    const nodes = doc.graphs['g0']!.nodes as Record<string, NodeData>
    nodes['s1'] = { ...nodes['s1']!, dynamic: { branch: { members: ['a', 'b', 'c'], memberLabels: { a: 'Quick', b: 'Detailed', c: 'Final' } } } } as NodeData
    nodes['s2'] = { ...nodes['s2']!, dynamic: { branch: { members: ['a', 'b'], memberLabels: { a: 'Detailed', b: 'Quick' } } } } as NodeData
    const effective = effectiveOf(doc, 'choice')!
    expect(effective.spec?.widgetType).toBe('COMBO')
    expect(effective.spec?.options['options']).toEqual(['Quick', 'Detailed'])
    expect(effective.diagnostics).toEqual([])
  })

  it('keeps a Boolean on a Switch\'s Pick a Boolean without a conflict, and reports one on a number field', () => {
    const onPick = effectiveOf(docOf({ flag: { type: 'Boolean' }, s1: { type: 'Switch' } }, [['flag', 'BOOLEAN', 's1', 'pick']]), 'flag')!
    expect(onPick.spec?.widgetType).toBe('BOOLEAN')
    expect(onPick.diagnostics).toEqual([])
    const onSteps = effectiveOf(docOf({ flag: { type: 'Boolean' }, a: { type: 'Steps' } }, [['flag', 'BOOLEAN', 'a', 'steps']]), 'flag')!
    expect(onSteps.diagnostics.map((d) => d.code)).toEqual(['primitive.widgetType.conflict'])
  })

  it('gives the general Primitive the widget and label of the field it feeds, though it runs', () => {
    const doc = docOf({ prim: { type: 'Primitive', values: { value: '#00ff00' } }, t: { type: 'Tint' } }, [['prim', 'value', 't', 'tint']])
    const effective = effectiveOf(doc, 'prim')!
    expect(effective.spec).toMatchObject({ widgetType: 'COLOR', default: '#ff0000' })
    expect(effective.label).toBe('tint')
  })

  it('lets a Choice that feeds nothing be typed in as text', () => {
    const doc = docOf({ choice: { type: 'Choice' } }, [])
    expect(effectiveOf(doc, 'choice')?.spec?.widgetType).toBe('STRING')
  })

  it('keeps renamed known-value limits and literal delivery independent through one and two boundaries', () => {
    for (const depth of [1, 2]) {
      const field = depth === 1 ? 'amount' : 'quantity'
      const low = depth === 1 ? 'low' : 'floor'
      const boundary = (node: string, names: readonly string[], ports: readonly string[]) => ({ body: [
        ...names.map((id, index) => ({ kind: 'input', id, promoted: true,
          binds: { kind: 'port', node, port: ports[index] } })),
        { kind: 'output', id: 'number', binds: { kind: 'port', node, port: node === 'prim' ? 'INT' : 'number' } },
      ] })
      const source = docOf({
        first: { type: depth === 1 ? '#detail' : '#portrait', values: { [field]: 6, [low]: 5 } },
        second: { type: depth === 1 ? '#detail' : '#portrait', values: { [field]: 2, [low]: 1 } },
        a: { type: 'Steps' }, b: { type: 'Count' }, extra: { type: 'Count' },
        lower: { type: 'Int', values: { value: 4 } }, runtime: { type: 'Counter' },
      }, [['first', 'number', 'a', 'steps'], ['second', 'number', 'b', 'count']])
      const graph = (id: string, node: string, type: string, exposed: ReturnType<typeof boundary>) => ({
        id, name: id, nodes: { [node]: { id: node, type, values: {} } },
        links: {}, nets: {}, reroutes: {}, nextOrdinal: 10, boundary: exposed,
      })
      const document = { ...source, graphs: { ...source.graphs,
        detail: graph('detail', 'prim', 'Int', boundary('prim', ['amount', 'low', 'high'], ['value', 'minimum', 'maximum'])),
        ...(depth === 2 ? { portrait: graph('portrait', 'detail', '#detail',
          boundary('detail', ['quantity', 'floor', 'ceiling'], ['amount', 'low', 'high'])) } : {}),
      } } as unknown as WorkflowDocument
      const store = new DocumentStore(document, coreCommandRegistry())
      const effective = (current: WorkflowDocument, nodeId: string) =>
        documentPrimitiveResolver(current, resolve)('g0', current.graphs.g0!.nodes[nodeId]!, [])
      expect(effective(store.doc, 'first')?.spec?.options).toMatchObject({ min: 5, max: 8 })
      expect(effective(store.doc, 'first')?.derived.has('max')).toBe(true)
      expect(effective(store.doc, 'first')?.derived.has('min')).toBe(false)
      expect(effective(store.doc, 'second')?.spec?.options).toMatchObject({ min: 1, max: 12 })
      expect(effective(store.doc, 'second')?.derived.has('max')).toBe(true)
      for (const [nodeId, min, max] of [['first', 5, 8], ['second', 1, 12]] as const) {
        const drawn = documentNodeResolver(store.doc, resolve, documentPrimitiveResolver(store.doc, resolve))(
          'g0', store.doc.graphs.g0!.nodes[nodeId]!, [])!
        expect(inputsOf(drawn).find((row) => row.id === field)!.widget?.options).toMatchObject({ min, max })
      }
      const outcome = store.dispatch({ command: 'node.setValue', params: { graphId: 'g0', nodeId: 'first', inputId: low, value: 3 } })
      expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
      expect(effective(store.doc, 'first')?.spec?.options).toMatchObject({ min: 3, max: 8 })
      expect(effective(store.doc, 'second')?.spec?.options).toMatchObject({ min: 1, max: 12 })
      expect(store.undo()).toBe(true)
      expect(effective(store.doc, 'first')?.spec?.options).toMatchObject({ min: 5, max: 8 })
      expect(store.redo()).toBe(true)
      const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(effective(reopened, 'first')?.spec?.options).toMatchObject({ min: 3, max: 8 })
      expect(effective(reopened, 'second')?.spec?.options).toMatchObject({ min: 1, max: 12 })
      const run = compile({ document: reopened, revision: 1, resolve, scope: { kind: 'full' },
        connection: 'boundary-limits' as never, schemaHash: 'primitive' })
      expect(run.ok).toBe(true)
      if (!run.ok) throw new Error(JSON.stringify(run.diagnostics))
      expect(run.artifact.prompt.a!.inputs.steps).toBe(6)
      expect(run.artifact.prompt.b!.inputs.count).toBe(2)

      const detached = new DocumentStore(reopened, coreCommandRegistry())
      expect(detached.dispatch({ command: 'occurrence.localize', params: { graphId: 'g0', nodeId: 'first' } }).ok).toBe(true)
      const copyId = detached.doc.graphs.g0!.nodes.first!.type.slice(1)
      expect(copyId).not.toBe(depth === 1 ? 'detail' : 'portrait')
      expect(detached.dispatch({ command: 'node.setValue', params: {
        graphId: copyId, nodeId: depth === 1 ? 'prim' : 'detail', inputId: depth === 1 ? 'maximum' : 'high', value: 7,
      } }).ok).toBe(true)
      expect(effective(detached.doc, 'first')?.spec?.options).toMatchObject({ min: 3, max: 7 })
      expect(effective(detached.doc, 'second')?.spec?.options).toMatchObject({ min: 1, max: 12 })
      const detachedRun = compile({ document: detached.doc, revision: 2, resolve, scope: { kind: 'full' },
        connection: 'boundary-limits' as never, schemaHash: 'primitive' })
      expect(detachedRun.ok).toBe(true)
      if (!detachedRun.ok) throw new Error(JSON.stringify(detachedRun.diagnostics))
      expect(detachedRun.artifact.prompt.a!.inputs.steps).toBe(6)
      expect(detachedRun.artifact.prompt.b!.inputs.count).toBe(2)
      expect(detached.doc.graphs[depth === 1 ? 'detail' : 'portrait']).toEqual(reopened.graphs[depth === 1 ? 'detail' : 'portrait'])
      expect(detached.undo()).toBe(true)
      expect(detached.undo()).toBe(true)
      expect(detached.doc.graphs.g0!.nodes.first!.type).toBe(reopened.graphs.g0!.nodes.first!.type)
      expect(detached.redo()).toBe(true)
      expect(detached.redo()).toBe(true)
      const detachedReload = loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!
      expect(effective(detachedReload, 'first')?.spec?.options).toMatchObject({ min: 3, max: 7 })
      expect(effective(detachedReload, 'second')?.spec?.options).toMatchObject({ min: 1, max: 12 })

      for (const mode of ['active', 'muted', 'bypassed'] as const) {
        const flattened = new DocumentStore(reopened, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, resolve),
        }))
        if (mode !== 'active') expect(flattened.dispatch({ command: 'node.setMode', params: { graphId: 'g0', nodeIds: ['first'], mode } }).ok).toBe(true)
        const initial = flattened.doc
        const root = initial.graphs.g0!
        const node = root.nodes.first!
        const body = initial.graphs[node.type.slice(1)]!
        const resolver = documentResolver(initial, resolve)
        const plan = planFlattenBoundaryRoutes(body, resolver, node, root)
        const topology = planFlattenOccurrenceTopology(initial, resolver, { instancePath: [], node: node.id })
        const topologyParams = topology.plan === undefined ? {} : {
          occurrenceTopologyPlan: topology.plan, occurrenceTopologyPlanDigest: lifecycleCanonicalHash(topology.plan),
        }
        const outcome = flattened.dispatch({ command: 'subgraph.flatten', params: {
          graphId: 'g0', instancePath: [], nodeId: 'first', placementCenter: { x: 100, y: 100 },
          resolvedGeometry: {
            occurrence: { id: 'first', kind: 'node', x: 0, y: 0, width: 200, height: 200 },
            body: Object.keys(body.nodes).map((id) => ({ id, kind: 'node', x: 0, y: 0, width: 200, height: 200 })),
          },
          boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaSnapshot: plan.schemaSnapshot,
          schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams,
          selectionFingerprint: lifecycleFlattenFingerprint(initial, 'g0', 'first', {
            boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams,
          }),
        } } as unknown as CommandInvocation)
        if (mode === 'bypassed') {
          expect(outcome.ok).toBe(false)
          expect(outcome.diagnostics.map((entry) => entry.code)).toContain('subgraph.flatten.modeUnsupported')
          expect(flattened.doc).toBe(initial)
          continue
        }
        expect(outcome.ok, `boundary/primitive/flatten-detach ${mode} depth ${depth}: ${JSON.stringify(outcome.diagnostics)}`).toBe(true)
        const projected = compile({ document: flattened.doc, revision: 3, resolve, scope: { kind: 'full' },
          connection: 'boundary-limits' as never, schemaHash: 'primitive' })
        expect(projected.ok, JSON.stringify(!projected.ok && projected.diagnostics)).toBe(true)
        if (!projected.ok) throw new Error(JSON.stringify(projected.diagnostics))
        expect(projected.artifact.prompt.a!.inputs.steps).toBe(mode === 'active' ? 6 : 4)
        expect(projected.artifact.prompt.b!.inputs.count).toBe(2)
        expect(flattened.undo()).toBe(true)
        expect(flattened.doc.graphs.g0!.nodes.first!.type).toBe(node.type)
        expect(flattened.redo()).toBe(true)
        const reloaded = compile({ document: loadDocument(JSON.parse(JSON.stringify(flattened.doc))).document!, revision: 4,
          resolve, scope: { kind: 'full' }, connection: 'boundary-limits' as never, schemaHash: 'primitive' })
        expect(reloaded.ok, JSON.stringify(!reloaded.ok && reloaded.diagnostics)).toBe(true)
        if (!reloaded.ok) throw new Error(JSON.stringify(reloaded.diagnostics))
        expect(reloaded.artifact.prompt.a!.inputs.steps).toBe(mode === 'active' ? 6 : 4)
        expect(reloaded.artifact.prompt.b!.inputs.count).toBe(2)
      }

      const connect = (from: string, port: string, to: string, inputId: string) => {
        const outcome = store.dispatch({ command: 'link.connect', params: { graphId: 'g0',
          from: { node: from, port }, to: { node: to, port: inputId },
        } })
        expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
      }
      connect('lower', 'INT', 'first', low)
      expect(effective(store.doc, 'first')?.spec?.options, `boundary/primitive/linked-outside literal depth ${depth}`).toMatchObject({ min: 4, max: 8 })
      expect(effective(store.doc, 'first')?.derived.has('min')).toBe(false)
      expect(effective(store.doc, 'second')?.spec?.options).toMatchObject({ min: 1, max: 12 })
      expect(store.undo()).toBe(true)
      expect(effective(store.doc, 'first')?.spec?.options).toMatchObject({ min: 3, max: 8 })
      expect(store.redo()).toBe(true)
      connect('runtime', 'INT', 'first', low)
      expect(effective(store.doc, 'first')?.spec?.options, `boundary/primitive/linked-outside runtime depth ${depth}`).toMatchObject({ min: 0, max: 8 })
      expect(effective(store.doc, 'first')?.derived.has('min')).toBe(true)
      connect('first', 'number', 'extra', 'count')
      expect(effective(store.doc, 'first')?.spec?.options, `boundary/primitive/fan-out depth ${depth}`).toMatchObject({ min: 4, max: 8, step: 2 })
      expect(effective(store.doc, 'second')?.spec?.options).toMatchObject({ min: 1, max: 12 })
      const fanout = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(effective(fanout, 'first')?.spec?.options).toMatchObject({ min: 4, max: 8, step: 2 })
      const shared = compile({ document: fanout, revision: 2, resolve, scope: { kind: 'full' },
        connection: 'boundary-limits' as never, schemaHash: 'primitive' })
      expect(shared.ok, JSON.stringify(!shared.ok && shared.diagnostics)).toBe(true)
      if (!shared.ok) throw new Error(JSON.stringify(shared.diagnostics))
      expect(shared.artifact.prompt.a!.inputs.steps).toBe(6)
      expect(shared.artifact.prompt.extra!.inputs.count).toBe(6)
      expect(shared.artifact.prompt.b!.inputs.count).toBe(2)
      expect(store.undo()).toBe(true)
      expect(effective(store.doc, 'first')?.spec?.options).toMatchObject({ min: 0, max: 8 })
      expect(store.redo()).toBe(true)
      expect(effective(store.doc, 'first')?.spec?.options).toMatchObject({ min: 4, max: 8, step: 2 })
    }
  })

  it('preserves inner explicit limits unless an exposed field overrides them', () => {
    for (const [depth, exposed, narrowed] of [
      [1, false, false], [2, false, false], [1, true, false], [2, true, false],
      [1, false, true], [2, false, true], [1, true, true], [2, true, true],
    ] as const) {
      const graph = (id: string, node: string, type: string, value: string, target: string, output: string, values = {}) => ({
        id, name: id, nodes: { [node]: { id: node, type, values } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        boundary: { body: [
          { kind: 'input', id: value, promoted: true, binds: { kind: 'port', node, port: target },
            ...(narrowed && node === 'prim' ? { limits: { min: 6, max: 6 } } : {}) },
          ...(exposed ? [{ kind: 'input', id: 'low', promoted: true, binds: { kind: 'port', node, port: node === 'prim' ? 'minimum' : 'low' } }] : []),
          { kind: 'output', id: 'number', binds: { kind: 'port', node, port: output } },
        ] },
      })
      const field = depth === 1 ? 'amount' : 'quantity'
      const source = docOf({ first: { type: depth === 1 ? '#detail' : '#portrait', values: { [field]: 6, ...(exposed ? { low: 3 } : {}) } },
        a: { type: 'Steps' } }, [['first', 'number', 'a', 'steps']])
      const doc = { ...source, graphs: { ...source.graphs,
        detail: graph('detail', 'prim', 'Int', 'amount', 'value', 'INT', { value: 6, minimum: 5, maximum: 7, step: 2, default: 6 }),
        ...(depth === 2 ? { portrait: graph('portrait', 'detail', '#detail', 'quantity', 'amount', 'number') } : {}),
      } } as unknown as WorkflowDocument
      const primitive = documentPrimitiveResolver(doc, resolve)
      const effective = primitive('g0', doc.graphs.g0!.nodes.first!, [])!
      const expected = { options: { min: narrowed ? 6 : exposed ? 3 : 5, max: narrowed ? 6 : 7, step: 2 }, default: 6 }
      expect(effective.spec).toMatchObject(expected)
      expect([...effective.derived]).toEqual([])
      const drawn = documentNodeResolver(doc, resolve, primitive)('g0', doc.graphs.g0!.nodes.first!, [])!
      expect(inputsOf(drawn).find((row) => row.id === field)!.widget).toMatchObject(expected)
    }
  })

  it('draws a renamed general Primitive as the consumer widget through both boundary depths', () => {
    for (const depth of [1, 2]) {
      const graph = (id: string, node: string, type: string, input: string, target: string, output: string) => ({
        id, name: id, nodes: { [node]: { id: node, type, values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        boundary: { body: [
          { kind: 'input', id: input, promoted: true, binds: { kind: 'port', node, port: target } },
          { kind: 'output', id: 'number', binds: { kind: 'port', node, port: output } },
        ] },
      })
      const field = depth === 1 ? 'amount' : 'quantity'
      const source = docOf({ first: { type: depth === 1 ? '#detail' : '#portrait', values: { [field]: '#00ff00' } },
        t: { type: 'Tint' } }, [['first', 'number', 't', 'tint']])
      const doc = { ...source, graphs: { ...source.graphs,
        detail: graph('detail', 'prim', 'Primitive', 'amount', 'value', 'value'),
        ...(depth === 2 ? { portrait: graph('portrait', 'detail', '#detail', 'quantity', 'amount', 'number') } : {}),
      } } as unknown as WorkflowDocument
      const effective = effectiveOf(doc, 'first')!
      expect(effective.spec).toMatchObject({ widgetType: 'COLOR', default: '#ff0000' })
      expect(effective.label).toBe('tint')
      const drawn = documentNodeResolver(doc, resolve, documentPrimitiveResolver(doc, resolve))('g0', doc.graphs.g0!.nodes.first!, [])!
      expect(inputsOf(drawn).find((row) => row.id === field)!.widget).toMatchObject({ widgetType: 'COLOR', default: '#ff0000' })
    }
  })
})

describe('dragging a wire off a field', () => {
  const T: TypeExpr = { kind: 'variable', templateId: 'T' }
  const general = schemaOf('Primitive', [
    input('value', T),
    { kind: 'output', id: 'value', type: T, knownValue: { input: 'value' } },
  ] as NodeSchema['body'], { isOutputNode: false })
  const STRING = { kind: 'concrete', name: 'STRING' } as const
  const text = schemaOf('Text', [
    input('value', STRING, { widgetType: 'STRING', options: {} }),
    { kind: 'output', id: 'STRING', type: STRING, knownValue: { input: 'value' } },
  ] as NodeSchema['body'], { isOutputNode: false })
  const all = [...Object.values(schemas), general, text]
  const field = (type: string, widgetType = type): InputSpec => input('f', { kind: 'concrete', name: type }, { widgetType, options: {} })

  it('makes the primitive of the field\'s own type, and the general one for any other field', () => {
    expect(primitiveForField(all, field('INT'))?.type).toBe('Int')
    expect(primitiveForField(all, field('COMBO'))?.type).toBe('Choice')
    expect(primitiveForField(all, field('STRING'))?.type).toBe('Text')
    // A color is text drawn as a color picker; no fixed primitive draws one, so the general one takes it.
    expect(primitiveForField(all, field('STRING', 'COLOR'))?.type).toBe('Primitive')
  })
})

describe('renaming a Switch\'s branch', () => {
  const STRING = { kind: 'concrete', name: 'STRING' } as const
  const text = schemaOf('Text', [
    input('value', STRING, { widgetType: 'STRING', options: {} }),
    { kind: 'output', id: 'STRING', type: STRING, knownValue: { input: 'value' } },
  ] as NodeSchema['body'], { isOutputNode: false })
  const all = (type: string) => type === 'Text' ? text : resolve(type)
  const docWith = (nodes: Record<string, { type: string; values?: Record<string, unknown> }>, links: [string, string, string, string][],
    labels: Record<string, Record<string, string>>) => {
    const doc = docOf(nodes, links)
    for (const [id, memberLabels] of Object.entries(labels)) {
      const node = doc.graphs['g0']!.nodes[id] as NodeData
      ;(doc.graphs['g0']!.nodes as Record<string, NodeData>)[id] = { ...node, dynamic: { branch: { members: ['a', 'b'], memberLabels } } } as NodeData
    }
    return storeOf(doc)
  }
  const storeOf = (doc: WorkflowDocument) =>
    new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => all }))
  const rename = (store: DocumentStore, nodeId: string, member: string, label: string) =>
    store.dispatch({ command: 'dynamic.labelMember', params: { graphId: 'g0', nodeId, construct: 'branch', member, label } })
  const valueOf = (store: DocumentStore, nodeId: string) => store.doc.graphs['g0']!.nodes[nodeId]!.values['value']

  it('gives a Choice holding the old name the new one, in the same undo step', () => {
    const store = docWith({ choice: { type: 'Choice', values: { value: 'Detailed' } }, s1: { type: 'Switch' } },
      [['choice', 'COMBO', 's1', 'pick']], { s1: { a: 'Quick', b: 'Detailed' } })
    expect(rename(store, 's1', 'b', 'Final').ok).toBe(true)
    expect(valueOf(store, 'choice')).toBe('Final')
    expect(store.undo()).toBe(true)
    expect(valueOf(store, 'choice')).toBe('Detailed')
    expect(store.doc.graphs['g0']!.nodes['s1']!.dynamic?.['branch']?.memberLabels?.['b']).toBe('Detailed')
  })

  it.each(['reroute', 'named net'] as const)('gives a Choice that reaches Pick through a %s the new name', (route) => {
    const doc = docOf({ choice: { type: 'Choice', values: { value: 'Detailed' } }, s1: { type: 'Switch' } }, [])
    const graph = doc.graphs['g0'] as unknown as Record<string, unknown> & { nodes: Record<string, NodeData> }
    graph.nodes['s1'] = { ...graph.nodes['s1']!, dynamic: { branch: { members: ['a', 'b'], memberLabels: { a: 'Quick', b: 'Detailed' } } } } as NodeData
    if (route === 'reroute') {
      graph['reroutes'] = { r1: { id: 'r1' } }
      graph['links'] = {
        l0: { id: 'l0', from: { node: 'choice', port: 'COMBO' }, to: { reroute: 'r1' } },
        l1: { id: 'l1', from: { reroute: 'r1' }, to: { node: 's1', port: 'pick' } },
      }
    } else {
      graph['nets'] = { n1: { id: 'n1', name: 'mode', source: { node: 'choice', port: 'COMBO' }, sinks: [{ node: 's1', port: 'pick' }] } }
    }
    const store = storeOf(doc)
    expect(rename(store, 's1', 'b', 'Final').ok).toBe(true)
    expect(valueOf(store, 'choice')).toBe('Final')
    expect(store.undo()).toBe(true)
    expect(valueOf(store, 'choice')).toBe('Detailed')
  })

  it('keeps the old name when another Switch the Choice feeds has no branch with the new one', () => {
    const store = docWith({ choice: { type: 'Choice', values: { value: 'Detailed' } }, s1: { type: 'Switch' }, s2: { type: 'Switch' } },
      [['choice', 'COMBO', 's1', 'pick'], ['choice', 'COMBO', 's2', 'pick']],
      { s1: { a: 'Quick', b: 'Detailed' }, s2: { a: 'Detailed', b: 'Quick' } })
    expect(rename(store, 's1', 'b', 'Final').ok).toBe(true)
    expect(valueOf(store, 'choice')).toBe('Detailed')
    // Once both Switches call it Final, the Choice follows.
    expect(rename(store, 's2', 'a', 'Final').ok).toBe(true)
    expect(valueOf(store, 'choice')).toBe('Final')
  })

  it('leaves a Text primitive on Pick as it is', () => {
    const store = docWith({ label: { type: 'Text', values: { value: 'Detailed' } }, s1: { type: 'Switch' } },
      [['label', 'STRING', 's1', 'pick']], { s1: { a: 'Quick', b: 'Detailed' } })
    expect(rename(store, 's1', 'b', 'Final').ok).toBe(true)
    expect(valueOf(store, 'label')).toBe('Detailed')
  })
})

describe('plugging a primitive into a field', () => {
  const storeOf = (doc: WorkflowDocument) =>
    new DocumentStore(doc, coreCommandRegistry(), 200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => resolve }))
  const connect = (store: DocumentStore, to: string, port: string) =>
    store.dispatch({ command: 'link.connect', params: { graphId: 'g0', from: { node: 'prim', port: 'INT' }, to: { node: to, port } } })

  it('moves a value outside the new range to its nearest end in the same undo step', () => {
    const store = storeOf(docOf({ prim: { type: 'Int', values: { value: 2 } }, a: { type: 'Steps' }, b: { type: 'Count' } },
      [['prim', 'INT', 'a', 'steps']]))
    expect(connect(store, 'b', 'count').ok).toBe(true)
    expect(store.doc.graphs['g0']!.nodes['prim']!.values['value']).toBe(4)
    expect(Object.keys(store.doc.graphs['g0']!.links)).toHaveLength(2)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs['g0']!.nodes['prim']!.values['value']).toBe(2)
    expect(Object.keys(store.doc.graphs['g0']!.links)).toHaveLength(1)
  })

  it('leaves the value alone when the fields share no range', () => {
    const store = storeOf(docOf({ prim: { type: 'Int', values: { value: 2 } }, a: { type: 'Steps' }, b: { type: 'Far' } },
      [['prim', 'INT', 'a', 'steps']]))
    expect(connect(store, 'b', 'far').ok).toBe(true)
    expect(store.doc.graphs['g0']!.nodes['prim']!.values['value']).toBe(2)
  })
})

describe('a primitive\'s range from its menu', () => {
  const [widgetReset, , , primitiveRange] = resetMenuContributions(() => resolve)
  const menu = (doc: WorkflowDocument): MenuContext => ({
    doc, graphId: 'g0', target: { kind: 'widget', nodeId: 'prim', inputId: 'value' },
    selection: { nodes: [], links: [], reroutes: [] }, worldX: 0, worldY: 0,
  })
  const run = (store: DocumentStore, item: MenuItem) => {
    const action = (item as MenuActionItem).action
    if (action.kind !== 'command') throw new Error('expected a command')
    expect(store.dispatch(action.invocation).ok).toBe(true)
  }
  const storeOf = (values: Record<string, unknown>) => new DocumentStore(docOf(
    { prim: { type: 'Int', values }, a: { type: 'Steps' }, b: { type: 'Count' } },
    [['prim', 'INT', 'a', 'steps'], ['prim', 'INT', 'b', 'count']]), coreCommandRegistry())

  it('pins the worked-out range into its own limit fields in one step, and goes back to the fed fields', () => {
    const store = storeOf({ value: 6, maximum: 7 })
    const [pin] = primitiveRange!.resolve(menu(store.doc))
    run(store, pin!)
    expect(store.doc.graphs['g0']!.nodes['prim']!.values).toEqual({ value: 6, minimum: 4, maximum: 7, step: 2 })
    const [, useConnected] = primitiveRange!.resolve(menu(store.doc))
    run(store, useConnected!)
    expect(store.doc.graphs['g0']!.nodes['prim']!.values).toEqual({ value: 6 })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs['g0']!.nodes['prim']!.values).toEqual({ value: 6, minimum: 4, maximum: 7, step: 2 })
  })

  it('resets the value to its own Default, and otherwise to the default of the first field it feeds', () => {
    const withDefault = storeOf({ value: 6, default: 5 })
    run(withDefault, widgetReset!.resolve(menu(withDefault.doc))[0]!)
    expect(withDefault.doc.graphs['g0']!.nodes['prim']!.values['value']).toBe(5)
    const shared = storeOf({ value: 6 })
    run(shared, widgetReset!.resolve(menu(shared.doc))[0]!)
    expect(shared.doc.graphs['g0']!.nodes['prim']!.values['value']).toBe(4)
  })
})
