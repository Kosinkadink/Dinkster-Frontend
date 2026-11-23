import { describe, expect, it } from 'vitest'
import { documentNodeResolver, documentPrimitiveResolver } from '../src/compile/compile.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { NodeData, WorkflowDocument } from '../src/format/document.js'
import { inputsOf, type InputSpec, type NodeSchema, type TypeExpr, type WidgetSpec } from '../src/schema/model.js'

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
  Steps: schemaOf('Steps', [input('steps', INT, intWidget({ min: 0, max: 8 }, { default: 4 }), { displayName: 'Steps' })]),
  Count: schemaOf('Count', [input('count', INT, intWidget({ min: 4, max: 12, step: 2 }, { default: 4 }), { displayName: 'Count' })]),
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
    expect([...effective.derived].sort()).toEqual(['max', 'min', 'step'])
    expect(effective.label).toBeUndefined()
    expect(effective.diagnostics).toEqual([])
    // The fields share a default of 4, so Reset goes there.
    expect(effective.spec?.default).toBe(4)
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
    const drawn = documentNodeResolver(doc, resolve, undefined, documentPrimitiveResolver(doc, resolve))('g0', node, [])!
    const value = inputsOf(drawn).find((row) => row.id === 'value')!
    expect(value.widget?.options).toMatchObject({ min: 5, max: 8 })
    expect(value.displayName).toBe('Steps')
  })

  it('reports fields that share no range and keeps the value and the wires', () => {
    const doc = docOf({ prim: { type: 'Int', values: { value: 6 } }, a: { type: 'Steps' }, b: { type: 'Far' } },
      [['prim', 'INT', 'a', 'steps'], ['prim', 'INT', 'b', 'far']])
    const effective = effectiveOf(doc, 'prim')!
    expect(effective.diagnostics.map((d) => d.code)).toEqual(['primitive.options.conflict'])
    expect(Object.keys(doc.graphs['g0']!.links)).toHaveLength(2)
  })

  it('offers a Choice the options every field it feeds offers', () => {
    const doc = docOf({ choice: { type: 'Choice' }, a: { type: 'Sampler' }, b: { type: 'Scheduler' } },
      [['choice', 'COMBO', 'a', 'sampler'], ['choice', 'COMBO', 'b', 'sampler']])
    const effective = effectiveOf(doc, 'choice')!
    expect(effective.spec?.widgetType).toBe('COMBO')
    expect(effective.spec?.options['options']).toEqual(['dpm', 'ddim'])
  })

  it('lets a Choice that feeds nothing be typed in as text', () => {
    const doc = docOf({ choice: { type: 'Choice' } }, [])
    expect(effectiveOf(doc, 'choice')?.spec?.widgetType).toBe('STRING')
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
