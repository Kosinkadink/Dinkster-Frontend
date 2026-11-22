/**
 * A subgraph's row settings in the Boundary panel: help text, limits and the
 * "Show" condition. Each is one command and one undo step, survives save and
 * load, reaches every instance through derivation, and never changes what a
 * run sends.
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { compile, documentResolver } from '../src/compile/compile.js'
import type { BoundaryItem, GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { asConnectionId } from '../src/ids.js'
import { deriveBoundarySchema } from '../src/schema/derive-boundary.js'
import { inputsOf, type InputSpec, type NodeSchema } from '../src/schema/model.js'

const schemaOf = (type: string, body: NodeSchema['body']): NodeSchema => ({
  type, displayName: type, category: 'test', source: 'v3', isOutputNode: true, body,
})
const IMAGE = { kind: 'concrete', name: 'IMAGE' } as const
const strengthInput = (min: number, max: number): InputSpec => ({
  kind: 'input', id: 'strength', displayName: 'strength', type: { kind: 'concrete', name: 'FLOAT' }, optional: false,
  widget: { widgetType: 'FLOAT', options: { min, max, step: 0.05 }, default: 0.5 },
})

function schemasWith(range: { min: number; max: number }) {
  const schemas: Record<string, NodeSchema> = {
    Blend: schemaOf('Blend', [
      { kind: 'input', id: 'image', type: IMAGE, optional: false },
      { kind: 'input', id: 'mask', type: { kind: 'concrete', name: 'MASK' }, optional: true },
      strengthInput(range.min, range.max),
      { kind: 'output', id: 'out', type: IMAGE },
    ]),
  }
  return (type: string): NodeSchema | undefined => schemas[type]
}

const item = (id: string, port: string, extra: Partial<BoundaryItem> = {}): BoundaryItem =>
  ({ id, binds: { kind: 'port', node: 'blend', port }, ...extra } as BoundaryItem)

function soften(inputs: BoundaryItem[], instanceValues: Record<string, Json> = {}): WorkflowDocument {
  const def = (id: string, partial: Partial<GraphDef>) => ({ id, name: id, nodes: {}, links: {}, nets: {}, reroutes: {}, nextOrdinal: 100, ...partial })
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'test-lineage',
    root: 'g0',
    graphs: {
      g0: def('g0', { nodes: { soft: { id: 'soft', type: '#sub', values: instanceValues } } }),
      sub: def('sub', {
        name: 'Soften',
        nodes: { blend: { id: 'blend', type: 'Blend', values: { strength: 0.45 } } },
        boundary: { inputs, outputs: [{ id: 'out', binds: { kind: 'port', node: 'blend', port: 'out' } }] },
      }),
    },
    view: { graphs: {} },
  } as unknown as WorkflowDocument
}

const baseInputs = (): BoundaryItem[] => [
  item('image', 'image'),
  item('mask', 'mask'),
  item('strength', 'strength', { promoted: true }),
]

function storeFor(document: WorkflowDocument, resolve = schemasWith({ min: 0, max: 1 })) {
  return new DocumentStore(document, coreCommandRegistry(), 200, undefined, () => ({
    kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, resolve),
  }))
}

const derivedStrength = (doc: WorkflowDocument, resolve = schemasWith({ min: 0, max: 1 })) => {
  const result = deriveBoundarySchema(doc.graphs['sub']!, documentResolver(doc, resolve))
  return { result, strength: inputsOf(result.schema!).find((input) => input.id === 'strength')! }
}

const rowOf = (doc: WorkflowDocument, id: string) => doc.graphs['sub']!.boundary!.inputs.find((input) => input.id === id)!

describe('boundary row settings', () => {
  it('keep help text, limits and a condition through save, load, undo and redo, and carry them to the instance', () => {
    const store = storeFor(soften(baseInputs()))
    const set = (command: string, params: Record<string, Json>) => {
      const outcome = store.dispatch({ command, params: { graphId: 'sub', ...params } })
      expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
    }
    set('boundary.setTooltip', { side: 'inputs', itemId: 'strength', tooltip: 'How much of the blur is mixed in' })
    set('boundary.setLimits', { itemId: 'strength', min: 0.1, max: 0.8 })
    set('boundary.setVisible', { itemId: 'strength', formula: 'linked(mask)' })

    const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(rowOf(loaded.document!, 'strength')).toMatchObject({
      tooltip: 'How much of the blur is mixed in',
      limits: { min: 0.1, max: 0.8 },
      visible: { formula: 'linked(mask)' },
    })
    const { result, strength } = derivedStrength(loaded.document!)
    expect(result.diagnostics.filter((d) => d.code.startsWith('boundary.'))).toEqual([])
    expect(strength.tooltip).toBe('How much of the blur is mixed in')
    expect(strength.widget?.options).toMatchObject({ min: 0.1, max: 0.8, step: 0.05 })

    // One undo step each, newest first.
    expect(store.undo()).toBe(true)
    expect(rowOf(store.doc, 'strength').visible).toBeUndefined()
    expect(rowOf(store.doc, 'strength').limits).toEqual({ min: 0.1, max: 0.8 })
    expect(store.undo()).toBe(true)
    expect(rowOf(store.doc, 'strength').limits).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(rowOf(store.doc, 'strength').tooltip).toBeUndefined()
    expect(derivedStrength(store.doc).strength.widget?.options).toMatchObject({ min: 0, max: 1 })
    expect(store.redo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(store.redo()).toBe(true)
    expect(rowOf(store.doc, 'strength')).toMatchObject({ tooltip: 'How much of the blur is mixed in', limits: { min: 0.1, max: 0.8 }, visible: { formula: 'linked(mask)' } })
  })

  it('refuses a limit wider than the inner field, naming its range, and accepts a narrower one', () => {
    const store = storeFor(soften(baseInputs()))
    const before = store.doc
    const wider = store.dispatch({ command: 'boundary.setLimits', params: { graphId: 'sub', itemId: 'strength', min: -0.5, max: 0.8 } })
    expect(wider.ok).toBe(false)
    expect(wider.diagnostics[0]?.message).toBe('Limits can narrow strength (0 to 1) and never widen it.')
    expect(store.doc).toBe(before)
    const above = store.dispatch({ command: 'boundary.setLimits', params: { graphId: 'sub', itemId: 'strength', min: null, max: 1.5 } })
    expect(above.ok).toBe(false)
    expect(store.dispatch({ command: 'boundary.setLimits', params: { graphId: 'sub', itemId: 'strength', min: null, max: 1 } }).ok).toBe(true)
    expect(rowOf(store.doc, 'strength').limits).toEqual({ max: 1 })
  })

  it('sends the same run with a condition, help text and limits as without them, value outside the limits included', () => {
    const run = (doc: WorkflowDocument) => {
      const result = compile({ document: doc, revision: 1, resolve: schemasWith({ min: 0, max: 1 }), scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'h' })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      return result.ok ? result.artifact.prompt : undefined
    }
    const plain = soften(baseInputs(), { strength: 0.9 })
    const set = soften([
      item('image', 'image'),
      item('mask', 'mask'),
      item('strength', 'strength', { promoted: true, tooltip: 'Mix', limits: { min: 0.1, max: 0.8 }, visible: { formula: 'linked(mask)' } }),
    ], { strength: 0.9 })
    const prompt = run(set)
    expect(prompt).toEqual(run(plain))
    expect(Object.values(prompt!).find((node) => node.class_type === 'Blend')?.inputs['strength']).toBe(0.9)
  })

  it('refuses a condition that names something other than an input, and reports one whose input was removed', () => {
    const store = storeFor(soften(baseInputs()))
    const refused = store.dispatch({ command: 'boundary.setVisible', params: { graphId: 'sub', itemId: 'strength', formula: 'linked(nope)' } })
    expect(refused.ok).toBe(false)
    expect(refused.diagnostics[0]?.code).toBe('boundary.visibleRefused')
    expect(store.dispatch({ command: 'boundary.setVisible', params: { graphId: 'sub', itemId: 'strength', formula: 'linked(mask)' } }).ok).toBe(true)
    expect(store.dispatch({ command: 'boundary.unbind', params: { graphId: 'sub', side: 'inputs', itemId: 'mask', node: 'blend', port: 'mask' } }).ok).toBe(true)
    const { result, strength } = derivedStrength(store.doc)
    expect(strength).toBeDefined()
    expect(result.diagnostics.find((d) => d.code === 'boundary.visibleBroken')?.refs).toEqual([{ graphId: 'sub', portId: 'strength' }])
  })

  it('reports limits the inner field no longer allows, and holds the instance inside the inner range', () => {
    const doc = soften([item('image', 'image'), item('mask', 'mask'), item('strength', 'strength', { promoted: true, limits: { min: 0.1, max: 0.8 } })])
    const { result, strength } = derivedStrength(doc, schemasWith({ min: 0, max: 0.5 }))
    expect(result.diagnostics.find((d) => d.code === 'boundary.limitsOutside')?.refs).toEqual([{ graphId: 'sub', portId: 'strength' }])
    expect(strength.widget?.options).toMatchObject({ min: 0.1, max: 0.5 })
  })

  it('reports limits on a field that is no longer a number, and lets them be cleared', () => {
    const textField: NodeSchema = schemaOf('Blend', [
      { kind: 'input', id: 'image', type: IMAGE, optional: false },
      { kind: 'input', id: 'mask', type: { kind: 'concrete', name: 'MASK' }, optional: true },
      { kind: 'input', id: 'strength', type: { kind: 'concrete', name: 'STRING' }, optional: false, widget: { widgetType: 'STRING', options: {}, default: '' } },
      { kind: 'output', id: 'out', type: IMAGE },
    ])
    const resolve = (type: string) => type === 'Blend' ? textField : undefined
    const store = storeFor(soften([item('image', 'image'), item('mask', 'mask'), item('strength', 'strength', { promoted: true, limits: { min: 0.1 } })]), resolve)
    expect(derivedStrength(store.doc, resolve).result.diagnostics.some((d) => d.code === 'boundary.limitsNotNumber')).toBe(true)
    expect(store.dispatch({ command: 'boundary.setLimits', params: { graphId: 'sub', itemId: 'strength', min: 0.2, max: null } }).diagnostics[0]?.code).toBe('boundary.limitsNotNumber')
    expect(store.dispatch({ command: 'boundary.setLimits', params: { graphId: 'sub', itemId: 'strength', min: null, max: null } }).ok).toBe(true)
    expect(rowOf(store.doc, 'strength').limits).toBeUndefined()
  })
})
