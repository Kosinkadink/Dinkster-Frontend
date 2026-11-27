/**
 * App-view row resolution (app-view-rows.ts): exposed entries against live
 * graphs + schemas, with the graph's REAL connectivity.
 *
 * What must hold:
 * - `linked` covers link-driven inputs AND named-net sinks: both are
 *   connection-driven, so a form edit would write a dormant value
 * - elaboration receives connectivity (not EMPTY_CONNECTIVITY), matching
 *   what the canvas scene passes - the app view must resolve the same
 *   elaborated interface as the graph editor
 * - unresolvable entries are STALE rows with reasons, never dropped
 * - values resolve stored -> widget default, and rows keep declared order
 */

import { describe, expect, it } from 'vitest'
import { asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId, compile, coreCommandRegistry, DocumentStore, documentResolver, elaborateInterface, elabInputsOf, loadDocument, type GraphDef, type InputSpec, type Json, type LookupAnswerState, type NodeSchema, type OutputSpec, type TypeExpr, type WidgetRegistry, type WorkflowDocument } from '@dinkster/core'
import type { ExecutionState } from '@dinkster/client'
import { appViewQueueScope, appViewQueueTargetOptions, buildParamRows, buildPreviewRows, previewRuntimeMapping, type ParamRow } from '../src/app-view-rows.js'
import { boundarySample, resolveBoundarySample } from '../../core/test/fixtures/boundary-sample.js'

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }

const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  widget: { widgetType: 'INT', options: {}, default: 5 },
  ...extra,
})
const output = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })

const schemaOf = (type: string, body: NodeSchema['body']): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  Sink: schemaOf('Sink', [input('seed'), input('steps'), input('provider', { hidden: true })]),
  Preview: schemaOf('Preview', [input('image', {
    type: { kind: 'concrete', name: 'core.ASSET' },
    widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null },
  })]),
  Slot: schemaOf('Slot', [
    { kind: 'typeChoice', id: 'slot', type: IMAGE, rows: [input('gain')], required: false },
    output('out'),
  ]),
}
const resolve = (type: string): NodeSchema | undefined => schemas[type]

function doc(g: {
  values?: Record<string, Json>
  links?: GraphDef['links']
  nets?: GraphDef['nets']
  exposed?: Json
  exposedPreviews?: Json
}): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('rows'),
    root: asGraphDefId('g0'),
    graphs: {
      g0: {
        id: asGraphDefId('g0'),
        name: 'g',
        nodes: {
          src: { id: asNodeId('src'), type: 'Src', values: {} },
          sink: { id: asNodeId('sink'), type: 'Sink', values: g.values ?? {} },
          preview: { id: asNodeId('preview'), type: 'Preview', values: g.values ?? {} },
          dyn: { id: asNodeId('dyn'), type: 'Slot', values: {} },
        },
        links: g.links ?? {},
        nets: g.nets ?? {},
        reroutes: {},
        nextOrdinal: 10,
      },
    },
    view: { graphs: {} },
    ...(g.exposed !== undefined || g.exposedPreviews !== undefined
      ? { ext: {
          ...(g.exposed !== undefined ? { 'dinkster.exposed': g.exposed } : {}),
          ...(g.exposedPreviews !== undefined ? { 'dinkster.exposedPreviews': g.exposedPreviews } : {}),
        } }
      : {}),
  } as WorkflowDocument
}

const entry = (nodeId: string, inputId: string): Json => ({ graphId: 'g0', nodeId, inputId })
const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const live = (row: ParamRow): Extract<ParamRow, { kind: 'live' }> => {
  expect(row.kind).toBe('live')
  return row as Extract<ParamRow, { kind: 'live' }>
}

describe('buildParamRows', () => {
  it('boundary/primitive/app-view uses consumer-derived widgets on each renamed occurrence', () => {
    const INT = { kind: 'concrete', name: 'INT' } as const
    const field = (id: string, options: Record<string, number>): InputSpec => ({ kind: 'input', id, type: INT, optional: false,
      widget: { widgetType: 'INT', options, default: 0 } })
    const registry = [schemaOf('Int', [field('value', { min: -1000, max: 1000 }),
      { kind: 'output', id: 'INT', type: INT, knownValue: { input: 'value' } }]),
      schemaOf('Steps', [field('steps', { min: 0, max: 8 })]), schemaOf('Count', [field('count', { min: 4, max: 12 })])]
    const resolve = (type: string) => registry.find((schema) => schema.type === type)
    for (const depth of [1, 2]) {
      const graph = (id: string, node: string, type: string, inputId: string, target: string, outputId: string) => ({
        id, name: id, nodes: { [node]: { id: node, type, values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 10,
        boundary: { body: [
          { kind: 'input', id: inputId, promoted: true, binds: { kind: 'port', node, port: target } },
          { kind: 'output', id: 'number', binds: { kind: 'port', node, port: outputId } },
        ] },
      })
      const inputId = depth === 1 ? 'amount' : 'quantity'
      const document = { format: 'dinkster-workflow', formatVersion: 1, root: 'root', lineage: 'app-primitive', view: { graphs: {} },
        graphs: { root: { id: 'root', name: 'root', nextOrdinal: 10, nets: {}, reroutes: {}, nodes: {
          first: { id: 'first', type: depth === 1 ? '#detail' : '#portrait', values: { [inputId]: 6 } },
          second: { id: 'second', type: depth === 1 ? '#detail' : '#portrait', values: { [inputId]: 9 } },
          a: { id: 'a', type: 'Steps', values: {} }, b: { id: 'b', type: 'Count', values: {} },
        }, links: {
          firstLink: { id: 'firstLink', from: { node: 'first', port: 'number' }, to: { node: 'a', port: 'steps' } },
          secondLink: { id: 'secondLink', from: { node: 'second', port: 'number' }, to: { node: 'b', port: 'count' } },
        } }, detail: graph('detail', 'prim', 'Int', 'amount', 'value', 'INT'),
        ...(depth === 2 ? { portrait: graph('portrait', 'detail', '#detail', 'quantity', 'amount', 'number') } : {}) },
        ext: { 'dinkster.exposed': ['first', 'second'].map((nodeId) => ({ graphId: 'root', nodeId, inputId })) },
      } as unknown as WorkflowDocument
      const rows = buildParamRows(document, resolve).map(live)
      expect(rows.map((row) => [row.value, row.spec?.options['min'], row.spec?.options['max']])).toEqual([[6, 0, 8], [9, 4, 12]])
      const store = new DocumentStore(document, coreCommandRegistry())
      const first = rows[0]!
      const edited = store.dispatch({ command: 'node.setValue', params: {
        graphId: first.entry.graphId, nodeId: first.entry.nodeId, inputId: first.valueKey, value: 7,
      } })
      expect(edited.ok, JSON.stringify(edited.diagnostics)).toBe(true)
      expect(buildParamRows(store.doc, resolve).map((row) => live(row).value)).toEqual([7, 9])
      expect(store.undo()).toBe(true)
      expect(buildParamRows(store.doc, resolve).map((row) => live(row).value)).toEqual([6, 9])
      expect(store.redo()).toBe(true)
      const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(buildParamRows(reopened, resolve).map((row) => [live(row).value, live(row).spec?.options['max']])).toEqual([[7, 8], [9, 12]])
      const sourceResolve = (type: string) => type === 'RuntimeInt'
        ? schemaOf('RuntimeInt', [{ kind: 'output', id: 'INT', type: INT }]) : resolve(type)
      for (const runtime of [false, true]) {
        const wiredDocument: WorkflowDocument = { ...reopened, graphs: { ...reopened.graphs, root: {
          ...reopened.graphs.root!, nodes: { ...reopened.graphs.root!.nodes,
            source: { id: asNodeId('source'), type: runtime ? 'RuntimeInt' : 'Int', values: runtime ? {} : { value: 5 } },
          },
        } } }
        const wired = new DocumentStore(wiredDocument, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (doc) => documentResolver(doc, sourceResolve),
        }))
        expect(wired.dispatch({ command: 'link.connect', params: { graphId: 'root',
          from: { node: 'source', port: 'INT' }, to: { node: 'first', port: inputId },
        } }).ok).toBe(true)
        const states = (doc: WorkflowDocument) => buildParamRows(doc, sourceResolve).map((row) =>
          [live(row).value, live(row).linked])
        expect(states(wired.doc)).toEqual([[7, true], [9, false]])
        const receiving = (doc: WorkflowDocument) => {
          const projected = compile({ document: doc, revision: 1, resolve: sourceResolve, scope: { kind: 'full' },
            connection: 'test' as never, schemaHash: 'primitive-linked' })
          expect(projected.ok, JSON.stringify(!projected.ok && projected.diagnostics)).toBe(true)
          if (!projected.ok) throw new Error('primitive projection failed')
          return [projected.artifact.prompt.a!.inputs.steps, projected.artifact.prompt.b!.inputs.count]
        }
        const driven = [runtime ? ['source', 0] : 5, 9]
        expect(receiving(wired.doc)).toEqual(driven)
        expect(wired.undo()).toBe(true)
        expect(states(wired.doc)).toEqual([[7, false], [9, false]])
        expect(receiving(wired.doc)).toEqual([7, 9])
        expect(wired.redo()).toBe(true)
        expect(receiving(wired.doc)).toEqual(driven)
        const loaded = loadDocument(JSON.parse(JSON.stringify(wired.doc))).document!
        expect(states(loaded)).toEqual([[7, true], [9, false]])
        expect(receiving(loaded)).toEqual(driven)
      }
    }
  })

  it('keeps an unselected optional boundary choice read-only through one and two boundaries', () => {
    const resolveOptional = (type: string): NodeSchema | undefined => {
      const schema = resolveBoundarySample(type)
      return type !== 'Boundary sample' || schema === undefined ? schema : { ...schema, body: schema.body.map((row) =>
        row.kind === 'choice' && row.id === 'mode' ? { kind: 'choice', id: 'mode', required: false, shared: [], options: [
          { key: 'image', rows: [] }, { key: 'text', rows: [] },
        ] } : row) }
    }
    for (const depth of [1, 2] as const) {
      const source = boundarySample(depth)
      const detail = source.graphs.detail!
      const document: WorkflowDocument = { ...source, graphs: { ...source.graphs, detail: { ...detail, nodes: {
        ...detail.nodes, sample: { ...detail.nodes.sample!, dynamic: {} },
      } } }, ext: { 'dinkster.exposed': [{ graphId: 'root', nodeId: 'first', inputId: 'mode' }] } }
      const row = live(buildParamRows(document, resolveOptional)[0]!)
      expect(row.value).toBeUndefined()
      expect(row.derived).toBe(true)
      expect(document.graphs.root!.nodes.first!.values).not.toHaveProperty('mode')
    }
  })

  it('boundary/plain-field/app-view edits only the chosen outer occurrence through one and two boundaries', () => {
    for (const depth of [1, 2] as const) {
      const source = boundarySample(depth)
      const store = new DocumentStore({ ...source, ext: { 'dinkster.exposed': [
        { graphId: 'root', nodeId: 'first', inputId: 'strength' },
        { graphId: 'root', nodeId: 'second', inputId: 'strength' },
        { graphId: 'root', nodeId: 'second', inputId: 'mode.text' },
      ] } }, coreCommandRegistry())
      const rows = () => buildParamRows(store.doc, resolveBoundarySample)
      expect(rows().map((row) => live(row).value)).toEqual([0.2, 0.8, 'second text'])
      const chosen = live(rows()[0]!)
      expect(store.dispatch({ command: 'node.setValue', params: {
        graphId: chosen.entry.graphId, nodeId: chosen.entry.nodeId, inputId: chosen.valueKey, value: 0.4,
      } }).ok).toBe(true)
      expect(rows().map((row) => live(row).value)).toEqual([0.4, 0.8, 'second text'])
      expect(store.doc.graphs.detail!.nodes.sample!.values.strength).toBe(0.3)
      if (depth === 2) expect(store.doc.graphs.portrait!.nodes.detail!.values.strength).toBe(0.6)
      const compiled = compile({ document: store.doc, revision: 1, resolve: resolveBoundarySample,
        scope: { kind: 'full' }, connection: 'app-view' as never, schemaHash: 'boundary-sample' })
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
      const prefix = depth === 2 ? 'detail.' : ''
      expect(compiled.artifact.prompt[`first.${prefix}sample`]!.inputs.strength).toBe(0.4)
      expect(compiled.artifact.prompt[`second.${prefix}sample`]!.inputs.strength).toBe(0.8)
      expect(store.undo()).toBe(true)
      expect(rows().map((row) => live(row).value)).toEqual([0.2, 0.8, 'second text'])
      expect(store.redo()).toBe(true)
      expect(rows().map((row) => live(row).value)).toEqual([0.4, 0.8, 'second text'])
      const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(buildParamRows(reopened, resolveBoundarySample).map((row) => live(row).value)).toEqual([0.4, 0.8, 'second text'])
      const reopenedRun = compile({ document: reopened, revision: 1, resolve: resolveBoundarySample,
        scope: { kind: 'full' }, connection: 'app-view' as never, schemaHash: 'boundary-sample' })
      expect(reopenedRun.ok).toBe(true)
      if (!reopenedRun.ok) throw new Error(JSON.stringify(reopenedRun.diagnostics))
      expect(reopenedRun.artifact.prompt[`first.${prefix}sample`]!.inputs.strength).toBe(0.4)
      expect(reopenedRun.artifact.prompt[`second.${prefix}sample`]!.inputs.strength).toBe(0.8)
      expect(store.dispatch({ command: 'boundary.setVisible', params: {
        graphId: 'detail', itemId: 'strength', formula: 'strength < 0',
      } }).ok).toBe(true)
      expect(rows().map((row) => row.entry.inputId)).toEqual(['mode.text'])
      expect(store.dispatch({ command: 'link.connect', params: {
        graphId: 'root', from: port('first', 'result'), to: port('second', 'strength'),
      } }).ok).toBe(true)
      expect(rows().map((row) => row.entry.nodeId)).toEqual(['second', 'second'])
      expect(live(rows()[0]!).linked).toBe(true)
      expect(store.undo()).toBe(true)
      expect(rows().map((row) => row.entry.inputId)).toEqual(['mode.text'])
      expect(store.undo()).toBe(true)
      expect(rows().map((row) => live(row).value)).toEqual([0.4, 0.8, 'second text'])
      const pins = new DocumentStore({ ...reopened, ext: { 'dinkster.exposed': [
        { graphId: 'root', nodeId: 'first', inputId: 'image' },
        { graphId: 'root', nodeId: 'second', inputId: 'image' },
      ] } }, coreCommandRegistry())
      const pinRows = (document = pins.doc) => buildParamRows(document, resolveBoundarySample).map(live)
      expect(pinRows().map((row) => [row.entry.nodeId, row.spec, row.value, row.linked]))
        .toEqual([['first', undefined, undefined, false], ['second', undefined, undefined, false]])
      expect(pins.dispatch({ command: 'link.connect', params: {
        graphId: 'root', from: port('imageA', 'image'), to: port('first', 'image'),
      } }).ok).toBe(true)
      expect(pinRows().map((row) => [row.entry.nodeId, row.spec, row.value, row.linked]))
        .toEqual([['first', undefined, undefined, true], ['second', undefined, undefined, false]])
      expect(pins.undo()).toBe(true)
      expect(pinRows().map((row) => row.linked)).toEqual([false, false])
      expect(pins.redo()).toBe(true)
      const pinsReloaded = loadDocument(JSON.parse(JSON.stringify(pins.doc))).document!
      expect(pinRows(pinsReloaded).map((row) => [row.entry.nodeId, row.spec, row.linked]))
        .toEqual([['first', undefined, true], ['second', undefined, false]])
    }
  })

  it('boundary/construct-fields/app-view keeps member keys and occurrence edits through reorder and reload', () => {
    for (const depth of [1, 2] as const) {
      const source = boundarySample(depth)
      const store = new DocumentStore(source, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveBoundarySample) }))
      const dispatch = (command: string, params: Record<string, Json>) => {
        const result = store.dispatch({ command, params })
        expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      }
      for (const nodeId of ['first', 'second']) {
        dispatch('dynamic.materialize', { graphId: 'root', nodeId,
          frames: [{ construct: 'layers', members: nodeId === 'first' ? ['layer0', 'layer1'] : ['layer0'] }] })
        dispatch('dynamic.specializeSlot', { graphId: 'root', nodeId, construct: 'source', variant: 'mask' })
        dispatch('node.setValue', { graphId: 'root', nodeId, inputId: 'description',
          value: '{"entries":[{"id":"text","label":"Caption","kind":"text"}]}' })
      }
      dispatch('node.setValues', { graphId: 'root', nodeId: 'first', values: {
        'layers.layer0.strength': 0.2, 'layers.layer1.strength': 0.7, 'source.gain': 0.4,
        'description.text': 'first caption', 'mode.mix': 0.6,
      } })
      dispatch('node.setValues', { graphId: 'root', nodeId: 'second', values: {
        'layers.layer0.strength': 0.8, 'source.gain': 0.9,
        'description.text': 'second caption', 'mode.mix': 0.3,
      } })
      for (const nodeId of ['first', 'second']) for (const inputId of [
        'layers.layer0.strength', 'source.gain', 'description.text', 'mode.mix',
      ]) dispatch('params.expose', { graphId: 'root', nodeId, inputId })
      const rows = (document = store.doc) => buildParamRows(document, resolveBoundarySample)
      const values = () => rows().map((row) => live(row).value)
      expect(rows().filter((row) => row.kind === 'stale').map((row) => row.entry)).toEqual([
        { graphId: 'root', nodeId: 'first', inputId: 'source.gain' },
        { graphId: 'root', nodeId: 'second', inputId: 'source.gain' },
      ])
      for (const nodeId of ['first', 'second']) dispatch('link.connect', {
        graphId: 'root', from: port('maskB', 'mask'), to: port(nodeId, 'source'),
      })
      expect(values()).toEqual([0.2, 0.4, 'first caption', 0.6, 0.8, 0.9, 'second caption', 0.3])
      for (const [index, feature, inputId, value] of [
        [0, 'whole-group', 'layers.layer0.strength', 0.5],
        [1, 'type-choice', 'source.gain', 0.45],
        [2, 'described-inputs', 'description.text', 'edited first caption'],
        [3, 'active-option-row', 'mode.mix', 0.65],
      ] as const) {
        const chosen = live(rows()[index]!)
        expect(chosen.valueKey, `boundary/${feature}/app-view`).toBe(inputId)
        expect(chosen.linked).toBe(false)
        expect(chosen.derived).toBe(false)
        expect(chosen.spec?.widgetType).toBe(feature === 'described-inputs' ? 'STRING' : 'FLOAT')
        const before = values()
        dispatch('node.setValue', { graphId: chosen.entry.graphId, nodeId: chosen.entry.nodeId,
          inputId: chosen.valueKey, value })
        expect(values(), `boundary/${feature}/app-view`).toEqual(before.map((prior, i) => i === index ? value : prior))
        expect(store.undo()).toBe(true)
        expect(values()).toEqual(before)
        expect(store.redo()).toBe(true)
        expect(values()[index]).toBe(value)
      }
      dispatch('dynamic.moveMember', { graphId: 'root', nodeId: 'first', construct: 'layers', member: 'layer1', index: 0 })
      expect(values()).toEqual([0.5, 0.45, 'edited first caption', 0.65, 0.8, 0.9, 'second caption', 0.3])
      expect(live(rows()[0]!).valueKey).toBe('layers.layer0.strength')
      const compiled = compile({ document: store.doc, revision: 1, resolve: resolveBoundarySample,
        scope: { kind: 'full' }, connection: 'app-view' as never, schemaHash: 'boundary-sample' })
      expect(compiled.ok).toBe(true)
      if (!compiled.ok) throw new Error(JSON.stringify(compiled.diagnostics))
      const prefix = depth === 2 ? 'detail.' : ''
      expect(compiled.artifact.prompt[`first.${prefix}sample`]!.inputs).toMatchObject({
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
        'layers.layer2.strength': 0.5, 'layers.layer3.strength': 0.7,
        'source.gain': 0.45, 'description.text': 'edited first caption', 'mode.mix': 0.65,
      })
      expect(compiled.artifact.prompt[`first.${prefix}sample`]!.outputMembers?.layers).toEqual(['layer0', 'layer1', 'layer3', 'layer2'])
      expect(compiled.artifact.prompt[`second.${prefix}sample`]!.inputs).toMatchObject({
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4, 'layers.layer2.strength': 0.8,
        'source.gain': 0.9, 'description.text': 'second caption', 'mode.mix': 0.3,
      })
      expect(store.doc.graphs.detail!.nodes.sample!.values['layers.layer0.strength']).toBe(0.1)
      const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc)))
      expect(reopened.document, JSON.stringify(reopened.diagnostics)).toBeDefined()
      expect(rows(reopened.document!).map((row) => live(row).value)).toEqual(values())
      expect(reopened.document!.graphs.root!.nodes.first!.dynamic?.layers?.members).toEqual(['layer1', 'layer0'])
      const reopenedRun = compile({ document: reopened.document!, revision: 1, resolve: resolveBoundarySample,
        scope: { kind: 'full' }, connection: 'app-view' as never, schemaHash: 'boundary-sample' })
      expect(reopenedRun.ok).toBe(true)
      if (!reopenedRun.ok) throw new Error(JSON.stringify(reopenedRun.diagnostics))
      expect(reopenedRun.artifact.prompt).toEqual(compiled.artifact.prompt)
      dispatch('link.connect', { graphId: 'root', from: port('first', 'result'), to: port('second', 'layers.layer0.strength') })
      expect(live(rows()[0]!).linked).toBe(false)
      expect(live(rows()[4]!).linked).toBe(true)
      expect(store.undo()).toBe(true)
      expect(live(rows()[4]!).linked).toBe(false)
      expect(values()[4]).toBe(0.8)
    }
  })

  it('omits a hidden compatibility input while preserving its stored exposure', () => {
    const document = doc({
      values: { provider: 'vision.depth.v2' },
      exposed: [entry('sink', 'provider'), entry('sink', 'steps')],
    })
    expect(buildParamRows(document, resolve).map((row) => row.entry.inputId)).toEqual(['steps'])
    expect(document.ext?.['dinkster.exposed']).toEqual([entry('sink', 'provider'), entry('sink', 'steps')])
    expect(document.graphs.g0!.nodes.sink!.values.provider).toBe('vision.depth.v2')
  })

  it('resolves live rows in declared order: stored value, widget default fallback', () => {
    const rows = buildParamRows(
      doc({ values: { seed: 42 }, exposed: [entry('sink', 'steps'), entry('sink', 'seed')] }),
      resolve,
    )
    expect(rows.map((r) => r.entry.inputId)).toEqual(['steps', 'seed'])
    expect(live(rows[0]!).value).toBe(5) // widget default
    expect(live(rows[1]!).value).toBe(42) // stored
    expect(rows.map((r) => live(r).linked)).toEqual([false, false])
  })

  it.each(['formula', 'lookup'] as const)('recalculates an unstored automatic %s field for each renamed occurrence through edits, fallback and reload', (calculation) => {
    const INT: TypeExpr = { kind: 'concrete', name: 'INT' }
    const automatic: NodeSchema = { ...schemaOf('Sink', [input('seed', { type: INT }), input('steps', {
      type: INT, automatic: calculation === 'formula' ? { formula: 'seed * 2' } : { lookup: 'steps_for', args: ['seed'] },
      labelFormula: { formula: '"Steps " + str(seed * 2)' },
      tooltip: 'Calculated from this occurrence',
      readOnly: { formula: 'seed < 15' }, disabled: { formula: 'seed < 10' },
      disabledReason: { formula: '"Seed " + str(seed)' }, onAbsent: 'accept', lazy: true,
    })]), isOutputNode: true }
    let holding = false
    let firstHeld: LookupAnswerState | undefined
    const lookupAnswers = (lookup: string, args: readonly Json[]) => {
      expect(lookup).toBe('steps_for')
      expect(typeof args[0]).toBe('number')
      if (holding && args[0] === 31) return firstHeld
      return { state: 'ready' as const, answer: Number(args[0]) * 2 }
    }
    const resolveAutomatic = (type: string) => type === 'Sink' ? automatic : resolveBoundarySample(type)
    const binding = (id: string, node: string, port: string) => ({
      kind: 'input', id, promoted: true, binds: { kind: 'port', node, port },
    })
    for (const depth of [0, 1, 2] as const) {
      const original = boundarySample(depth)
      const seed = depth === 0 ? 'seed' : depth === 1 ? 'start' : 'control'
      const steps = depth === 0 ? 'steps' : depth === 1 ? 'total' : 'result'
      const document = { ...original, graphs: {
        root: { ...original.graphs.root!, nodes: Object.fromEntries(['first', 'second'].map((id) => [id, {
          id, type: depth === 0 ? 'Sink' : depth === 1 ? '#detail' : '#portrait', values: { [seed]: id === 'first' ? 21 : 13 },
        }])) },
        ...(depth > 0 ? { detail: { ...original.graphs.detail!, nodes: {
          sample: { id: 'sample', type: 'Sink', values: { seed: 3 } },
        }, boundary: { body: [binding('start', 'sample', 'seed'), binding('total', 'sample', 'steps')] } } } : {}),
        ...(depth === 2 ? { portrait: { ...original.graphs.portrait!, nodes: {
          detail: { id: 'detail', type: '#detail', values: { start: 7 } },
        }, boundary: { body: [binding('control', 'detail', 'start'), binding('result', 'detail', 'total')] } } } : {}),
      }, ext: { 'dinkster.exposed': ['first', 'second'].map((nodeId) => ({ graphId: 'root', nodeId, inputId: steps })) } } as unknown as WorkflowDocument
      const store = new DocumentStore(document, coreCommandRegistry(), 200, undefined, () => ({
        kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveAutomatic),
      }))
      const checkMetadata = (current: WorkflowDocument, firstSeed: number) => {
        const root = current.graphs.root!
        const plain = { ...current, graphs: { root: { ...root,
          nodes: { ...root.nodes, ...Object.fromEntries(['first', 'second'].map((id) => [id, {
            ...root.nodes[id]!, type: 'Sink', values: { seed: id === 'first' ? firstSeed : 13,
              ...(Object.hasOwn(root.nodes[id]!.values, steps) ? { steps: root.nodes[id]!.values[steps] } : {}),
            },
          }])) },
          links: Object.fromEntries(Object.entries(root.links).map(([id, link]) => [id, {
            ...link, to: 'port' in link.to ? { ...link.to, port: asPortId(link.to.port === seed ? 'seed' : 'steps') } : link.to,
          }])),
        } }, ext: { 'dinkster.exposed': ['first', 'second'].map((nodeId) => ({ graphId: 'root', nodeId, inputId: 'steps' })) } } as WorkflowDocument
        const reference = buildParamRows(plain, resolveAutomatic, lookupAnswers).map(live)
        const rows = buildParamRows(current, resolveAutomatic, lookupAnswers).map(live)
        rows.forEach((row, index) => {
          const expected = reference[index]!
          const { outer: _outer, lookupScope: _lookupScope, ...spec } = row.item.spec
          expect(spec).toEqual({ ...expected.item.spec, id: steps, optional: depth > 0,
            ...(expected.item.spec.displayName === 'steps' ? { displayName: steps } : {}),
          })
          const expectedAutomatic = (state: typeof expected.item.automatic) => state?.call === undefined || depth === 0 ? state : {
            ...state, call: { ...state.call, nodeType: 'Sink' },
          }
          expect([row.item.readOnly, row.item.disabled, row.item.disabledReason,
            row.item.automatic, row.item.automaticIfEmptied, row.derived, row.linked, row.value, row.label]).toEqual([
            expected.item.readOnly, expected.item.disabled, expected.item.disabledReason,
            expectedAutomatic(expected.item.automatic), expectedAutomatic(expected.item.automaticIfEmptied), expected.derived, expected.linked, expected.value,
            expected.label === 'steps' ? steps : expected.label,
          ])
        })
      }
      const check = (current: WorkflowDocument, firstSeed: number) => {
        checkMetadata(current, firstSeed)
        const rows = buildParamRows(current, resolveAutomatic, lookupAnswers).map(live)
        expect(rows.map((row) => [row.entry.graphId, row.entry.nodeId, row.valueKey, row.value, row.label, row.linked])).toEqual([
          ['root', 'first', steps, firstSeed * 2, `Steps ${firstSeed * 2}`, false],
          ['root', 'second', steps, 26, 'Steps 26', false],
        ])
        for (const row of rows) {
          expect(row.item.spec.tooltip).toBe('Calculated from this occurrence')
          expect(row.spec).toEqual(input('steps').widget)
          expect(row.node.values).not.toHaveProperty(steps)
        }
        const result = compile({ document: current, revision: 1, resolve: resolveAutomatic, scope: { kind: 'full' },
          connection: 'formula-occurrence' as never, schemaHash: 'formula-occurrence', lookupAnswers })
        expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
        if (!result.ok) throw new Error('automatic occurrence did not compile')
        const suffix = depth === 0 ? '' : depth === 1 ? '.sample' : '.detail.sample'
        expect(result.artifact.prompt).toEqual({
          [`first${suffix}`]: { class_type: 'Sink', inputs: { seed: firstSeed }, outputIds: [] },
          [`second${suffix}`]: { class_type: 'Sink', inputs: { seed: 13 }, outputIds: [] },
          ...(current.graphs.root!.nodes.outside?.type === 'IntSource'
            ? { outside: { class_type: 'IntSource', inputs: {}, outputIds: ['number'] } } : {}),
        })
        expect(result.artifact.automaticCalls ?? []).toEqual(calculation === 'formula' ? [] : [
          { runtimeNodeId: `first${suffix}`, inputId: 'steps', lookup: 'steps_for', args: [firstSeed] },
          { runtimeNodeId: `second${suffix}`, inputId: 'steps', lookup: 'steps_for', args: [13] },
        ])
        for (const [receiver, expected] of [[`first${suffix}`, firstSeed * 2], [`second${suffix}`, 26]] as const) {
          const native = elabInputsOf(elaborateInterface(automatic, {
            values: result.artifact.prompt[receiver]!.inputs as Record<string, Json>,
          }, undefined, { lookupAnswers })).find((row) => row.spec.id === 'steps')!
          expect(native.automatic).toEqual({ state: 'worked-out', value: expected,
            ...(calculation === 'formula' ? {} : { call: { lookup: 'steps_for', args: [expected / 2] } }),
          })
        }
        expect(current.graphs.detail).toEqual(document.graphs.detail)
        expect(current.graphs.portrait).toEqual(document.graphs.portrait)
      }
      check(store.doc, 21)
      expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: seed, value: 31 } }).ok).toBe(true)
      const edited = store.doc
      check(edited, 31)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(document)
      check(store.doc, 21)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(edited)
      check(loadDocument(JSON.parse(JSON.stringify(edited))).document!, 31)
      expect(store.dispatch({ command: 'node.setValues', params: { graphId: 'root', nodeId: 'first', values: {}, unset: [seed] } }).ok).toBe(true)
      check(store.doc, depth === 2 ? 7 : depth === 1 ? 3 : 5)
      check(loadDocument(JSON.parse(JSON.stringify(store.doc))).document!, depth === 2 ? 7 : depth === 1 ? 3 : 5)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(edited)
      check(store.doc, 31)
      expect(store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: steps, value: 19 } }).ok).toBe(true)
      for (const current of [store.doc, loadDocument(JSON.parse(JSON.stringify(store.doc))).document!]) {
        checkMetadata(current, 31)
        const rows = buildParamRows(current, resolveAutomatic, lookupAnswers).map(live)
        expect(rows.map((row) => row.value)).toEqual([19, 26])
        expect(rows[0]!.item.automatic).toBeUndefined()
        expect(rows[0]!.item.automaticIfEmptied).toEqual({ state: 'worked-out', value: 62,
          ...(calculation === 'formula' ? {} : { call: { lookup: 'steps_for', args: [31], ...(depth === 0 ? {} : { nodeType: 'Sink' }) } }),
        })
        const result = compile({ document: current, revision: 1, resolve: resolveAutomatic, scope: { kind: 'full' },
          connection: 'formula-occurrence' as never, schemaHash: 'formula-occurrence', lookupAnswers })
        expect(result.ok).toBe(true)
        if (!result.ok) throw new Error('stored formula override did not compile')
        const suffix = depth === 0 ? '' : depth === 1 ? '.sample' : '.detail.sample'
        expect(result.artifact.prompt[`first${suffix}`]!.inputs).toEqual({ seed: 31, steps: 19 })
        expect(result.artifact.prompt[`second${suffix}`]!.inputs).toEqual({ seed: 13 })
        expect(result.artifact.automaticCalls ?? []).toEqual(calculation === 'formula' ? [] : [
          { runtimeNodeId: `second${suffix}`, inputId: 'steps', lookup: 'steps_for', args: [13] },
        ])
      }
      const fixed = store.doc
      if (calculation === 'lookup') {
        for (const [held, expected] of [
          [undefined, { state: 'loading', value: 5 }],
          [{ state: 'loading', answer: 73 }, { state: 'worked-out', value: 73 }],
          [{ state: 'stale', answer: 71, reason: 'timeout' }, { state: 'worked-out', value: 71, kept: 'stale' }],
          [{ state: 'unavailable', reason: 'timeout' }, { state: 'default', value: 5, reason: 'lookup-timeout' }],
          [{ state: 'unavailable', reason: 'offline' }, { state: 'not-known', value: 5, reason: 'offline' }],
          [{ state: 'paused' }, { state: 'not-known', value: 5, reason: 'paused' }],
        ] as const) {
          holding = true
          firstHeld = held
          for (const stored of [false, true]) {
            const current = loadDocument(JSON.parse(JSON.stringify(stored ? fixed : edited))).document!
            const snapshot = JSON.stringify(current)
            checkMetadata(current, 31)
            const rows = buildParamRows(current, resolveAutomatic, lookupAnswers).map(live)
            expect(rows.map((row) => row.value)).toEqual([stored ? 19 : expected.value, 26])
            const first = stored ? rows[0]!.item.automaticIfEmptied : rows[0]!.item.automatic
            expect(first).toEqual({ ...expected,
              call: { lookup: 'steps_for', args: [31], ...(depth === 0 ? {} : { nodeType: 'Sink' }) },
            })
            const result = compile({ document: current, revision: 1, resolve: resolveAutomatic, scope: { kind: 'full' },
              connection: 'lookup-occurrence' as never, schemaHash: 'lookup-occurrence', lookupAnswers })
            expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
            if (!result.ok) throw new Error('held automatic lookup did not compile')
            const suffix = depth === 0 ? '' : depth === 1 ? '.sample' : '.detail.sample'
            expect(result.artifact.prompt[`first${suffix}`]!.inputs).toEqual({ seed: 31, ...(stored ? { steps: 19 } : {}) })
            expect(result.artifact.prompt[`second${suffix}`]!.inputs).toEqual({ seed: 13 })
            expect(result.artifact.automaticCalls).toEqual([
              ...(stored ? [] : [{ runtimeNodeId: `first${suffix}`, inputId: 'steps', lookup: 'steps_for', args: [31] }]),
              { runtimeNodeId: `second${suffix}`, inputId: 'steps', lookup: 'steps_for', args: [13] },
            ])
            expect(JSON.stringify(current)).toBe(snapshot)
          }
        }
        holding = false
      }
      expect(store.dispatch({ command: 'node.setValues', params: {
        graphId: 'root', nodeId: 'first', values: {}, unset: [steps],
      } }).ok).toBe(true)
      check(store.doc, 31)
      check(loadDocument(JSON.parse(JSON.stringify(store.doc))).document!, 31)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(fixed)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(edited)
      check(store.doc, 31)
      for (const literal of [true, false]) {
        const before: WorkflowDocument = { ...edited, graphs: { ...edited.graphs, root: { ...edited.graphs.root!, nodes: {
          ...edited.graphs.root!.nodes,
          outside: { id: asNodeId('outside'), type: literal ? 'dinkster.utilities.primitive_int' : 'IntSource',
            values: literal ? { value: 47 } : {} },
        } } } }
        const wired = new DocumentStore(before, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveAutomatic),
        }))
        expect(wired.dispatch({ command: 'link.connect', params: { graphId: 'root',
          from: port('outside', literal ? 'value' : 'number'), to: port('first', seed),
        } }).ok).toBe(true)
        const connected = wired.doc
        for (const current of [connected, loadDocument(JSON.parse(JSON.stringify(connected))).document!]) {
          checkMetadata(current, 31)
          const rows = buildParamRows(current, resolveAutomatic, lookupAnswers).map(live)
          expect(rows.map((row) => row.value)).toEqual([5, 26])
          expect(rows[0]!.item.automatic).toMatchObject({ state: 'default', value: 5 })
          expect(current.graphs.root!.nodes.first!.values).toEqual({ [seed]: 31 })
          const exposed = { ...current, ext: { 'dinkster.exposed': [{ graphId: 'root', nodeId: 'first', inputId: seed }] } }
          expect(live(buildParamRows(exposed, resolveAutomatic, lookupAnswers)[0]!).linked).toBe(true)
          const result = compile({ document: current, revision: 1, resolve: resolveAutomatic, scope: { kind: 'full' },
            connection: 'formula-occurrence' as never, schemaHash: 'formula-occurrence', lookupAnswers })
          expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
          if (!result.ok) throw new Error('linked formula dependency did not compile')
          const suffix = depth === 0 ? '' : depth === 1 ? '.sample' : '.detail.sample'
          expect(result.artifact.prompt[`first${suffix}`]!.inputs).toEqual({ seed: literal ? 47 : ['outside', 0] })
          expect(result.artifact.prompt[`second${suffix}`]!.inputs).toEqual({ seed: 13 })
          expect(result.artifact.automaticCalls ?? []).toEqual(calculation === 'formula' ? [] : [
            { runtimeNodeId: `second${suffix}`, inputId: 'steps', lookup: 'steps_for', args: [13] },
          ])
          expect(current.graphs.detail).toEqual(document.graphs.detail)
          expect(current.graphs.portrait).toEqual(document.graphs.portrait)
        }
        expect(wired.dispatch({ command: 'link.disconnect', params: {
          graphId: 'root', linkId: Object.keys(connected.graphs.root!.links)[0]!,
        } }).ok).toBe(true)
        check(wired.doc, 31)
        const disconnected = wired.doc
        expect(wired.undo()).toBe(true)
        expect(wired.doc).toEqual(connected)
        expect(buildParamRows(wired.doc, resolveAutomatic, lookupAnswers).map((row) => live(row).value)).toEqual([5, 26])
        expect(wired.redo()).toBe(true)
        expect(wired.doc).toEqual(disconnected)
        check(loadDocument(JSON.parse(JSON.stringify(disconnected))).document!, 31)

        const fixedWithSource: WorkflowDocument = { ...fixed, graphs: { ...fixed.graphs, root: { ...fixed.graphs.root!,
          nodes: { ...fixed.graphs.root!.nodes, outside: before.graphs.root!.nodes.outside! },
        } } }
        const resultWire = new DocumentStore(fixedWithSource, coreCommandRegistry(), 200, undefined, () => ({
          kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveAutomatic),
        }))
        expect(resultWire.dispatch({ command: 'link.connect', params: { graphId: 'root',
          from: port('outside', literal ? 'value' : 'number'), to: port('first', steps),
        } }).ok).toBe(true)
        const linkedResult = resultWire.doc
        for (const current of [linkedResult, loadDocument(JSON.parse(JSON.stringify(linkedResult))).document!]) {
          checkMetadata(current, 31)
          const rows = buildParamRows(current, resolveAutomatic, lookupAnswers).map(live)
          expect(rows.map((row) => [row.value, row.linked])).toEqual([[19, true], [26, false]])
          expect(current.graphs.root!.nodes.first!.values).toEqual({ [seed]: 31, [steps]: 19 })
          const compiled = compile({ document: current, revision: 1, resolve: resolveAutomatic, scope: { kind: 'full' },
            connection: 'automatic-result-wire' as never, schemaHash: 'automatic-result-wire', lookupAnswers })
          expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
          if (!compiled.ok) throw new Error('linked automatic result did not compile')
          const suffix = depth === 0 ? '' : depth === 1 ? '.sample' : '.detail.sample'
          expect(compiled.artifact.prompt[`first${suffix}`]!.inputs).toEqual({ seed: 31, steps: literal ? 47 : ['outside', 0] })
          expect(compiled.artifact.prompt[`second${suffix}`]!.inputs).toEqual({ seed: 13 })
          expect(compiled.artifact.automaticCalls ?? []).toEqual(calculation === 'formula' ? [] : [
            { runtimeNodeId: `second${suffix}`, inputId: 'steps', lookup: 'steps_for', args: [13] },
          ])
        }
        expect(resultWire.dispatch({ command: 'link.disconnect', params: {
          graphId: 'root', linkId: Object.keys(linkedResult.graphs.root!.links)[0]!,
        } }).ok).toBe(true)
        const dormant = resultWire.doc
        expect(buildParamRows(dormant, resolveAutomatic, lookupAnswers).map((row) => [live(row).value, live(row).linked])).toEqual([[19, false], [26, false]])
        expect(resultWire.undo()).toBe(true)
        expect(resultWire.doc).toEqual(linkedResult)
        expect(resultWire.redo()).toBe(true)
        expect(resultWire.doc).toEqual(dormant)
        expect(buildParamRows(loadDocument(JSON.parse(JSON.stringify(dormant))).document!, resolveAutomatic, lookupAnswers).map((row) => live(row).value)).toEqual([19, 26])
      }
    }
  })

  it('shows an automatic lookup field at the answer the editor holds, and its default before one arrives', () => {
    const INT: TypeExpr = { kind: 'concrete', name: 'INT' }
    const automatic: NodeSchema = schemaOf('Sink', [input('seed', { type: INT }), input('steps', { type: INT, automatic: { lookup: 'steps_for', args: ['seed'] } })])
    const rows = (answer: number | undefined) => buildParamRows(
      doc({ values: { seed: 21 }, exposed: [entry('sink', 'steps')] }),
      (type) => type === 'Sink' ? automatic : resolve(type),
      (lookup, args) => lookup === 'steps_for' && args[0] === 21 && answer !== undefined ? { state: 'ready', answer } : undefined,
    )
    expect(live(rows(30)[0]!).value).toBe(30)
    expect(live(rows(undefined)[0]!).value).toBe(5)
  })

  it('marks a link-driven input linked (read-only in the form)', () => {
    const rows = buildParamRows(
      doc({
        links: { l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('sink', 'seed') } } satisfies GraphDef['links'],
        exposed: [entry('sink', 'seed'), entry('sink', 'steps')],
      }),
      resolve,
    )
    expect(live(rows[0]!).linked).toBe(true)
    expect(live(rows[1]!).linked).toBe(false)
  })

  it('marks a named-net SINK linked: the net drives the input exactly like a link', () => {
    const rows = buildParamRows(
      doc({
        nets: {
          net1: { id: asNetId('net1'), name: 'imgs', source: port('src', 'out'), sinks: [port('sink', 'seed')] },
        } satisfies GraphDef['nets'],
        exposed: [entry('sink', 'seed'), entry('sink', 'steps')],
      }),
      resolve,
    )
    expect(live(rows[0]!).linked).toBe(true)
    expect(live(rows[1]!).linked).toBe(false)
  })

  it('renders unresolvable entries as stale rows with reasons, never dropping them', () => {
    const rows = buildParamRows(
      doc({
        exposed: [
          { graphId: 'gX', nodeId: 'sink', inputId: 'seed' },
          { graphId: 'g0', nodeId: 'ghost', inputId: 'seed' },
          { graphId: 'g0', nodeId: 'sink', inputId: 'nope' },
          entry('sink', 'seed'),
        ],
      }),
      resolve,
    )
    expect(rows.map((r) => r.kind)).toEqual(['stale', 'stale', 'stale', 'live'])
    expect(rows.slice(0, 3).map((r) => (r as Extract<ParamRow, { kind: 'stale' }>).reason)).toEqual([
      'graph no longer exists',
      'node no longer exists',
      "input 'nope' no longer exists",
    ])
  })

  it('resolves type choice rows through real connectivity: absent while the slot is disconnected, live once linked', () => {
    // Dependents exist only while the slot is CONNECTED (elaborate.ts): the
    // app view must feed elaboration the graph's real connectivity or the
    // exposed 'slot.gain' would diverge from what the canvas renders.
    const exposed = [{ graphId: 'g0', nodeId: 'dyn', inputId: 'slot.gain' }]
    const disconnected = buildParamRows(doc({ exposed }), resolve)
    expect(disconnected[0]!.kind).toBe('stale')
    expect((disconnected[0] as Extract<ParamRow, { kind: 'stale' }>).reason).toBe("input 'slot.gain' no longer exists")

    const connected = buildParamRows(
      doc({
        links: { l1: { id: asLinkId('l1'), from: port('src', 'out'), to: port('dyn', 'slot') } } satisfies GraphDef['links'],
        exposed,
      }),
      resolve,
    )
    const row = live(connected[0]!)
    expect(row.valueKey).toBe('slot.gain')
    expect(row.linked).toBe(false) // the SLOT is linked; the dependent itself is not
    expect(row.value).toBe(5) // widget default
  })

  it('renders every row stale when no schema resolver is available (registry not ready)', () => {
    const rows = buildParamRows(doc({ exposed: [entry('sink', 'seed')] }), undefined)
    expect(rows[0]!.kind).toBe('stale')
  })

})

describe('buildPreviewRows', () => {
  const rendererFor = ((channel: string) => channel === 'image/png'
    ? { id: 'test.image', mediaKind: 'image', canRender: () => true }
    : undefined) as WidgetRegistry['previewRendererFor']

  it('keeps each subgraph occurrence selected asset through renamed boundaries, edits and reload', () => {
    const asset = (digit: string) => ({ digest: `blake3:${digit.repeat(64)}`, name: `${digit}.png`,
      size: 10, mediaType: 'image/png', virtualPath: `${digit}.png` })
    for (const depth of [1, 2] as const) {
      const source = boundarySample(depth)
      const key = depth === 1 ? 'photo' : 'picture'
      for (const [id, digit] of [['first', '1'], ['second', '2']] as const) {
        Object.assign(source.graphs.root!.nodes[id]!.values, { [key]: asset(digit) })
      }
      const detail = source.graphs.detail!
      Object.assign(detail, { boundary: { body: detail.boundary!.body.map((row) => row.kind === 'input' && row.id === 'image'
        ? { ...row, id: 'photo', promoted: true } : row) } })
      if (depth === 2) {
        const portrait = source.graphs.portrait!
        Object.assign(portrait, { boundary: { body: portrait.boundary!.body.map((row) => row.kind === 'input' && row.id === 'image'
          ? { ...row, id: 'picture', promoted: true, binds: { kind: 'port', node: 'detail', port: 'photo' } } : row) } })
      }
      Object.assign(source, { ext: { 'dinkster.exposedPreviews': ['first', 'second'].map((nodeId) => ({ graphId: 'root', nodeId })) } })
      const sample = resolveBoundarySample('Boundary sample')!
      const resolveAssets = (type: string): NodeSchema | undefined => type !== sample.type ? resolveBoundarySample(type) : {
        ...sample, body: sample.body.map((row) => row.kind === 'input' && row.id === 'image' ? {
          ...row, type: { kind: 'concrete', name: 'ASSET' },
          widget: { widgetType: 'ASSET', options: { accept: ['image/png'] }, default: null },
        } : row),
      }
      const store = new DocumentStore(source, coreCommandRegistry())
      const selected = (document = store.doc) => buildPreviewRows(document, resolveAssets, rendererFor)
        .map((row) => row.kind === 'candidate' ? row.selectedAsset : undefined)
      const expected = (digit: string) => ({ digest: asset(digit).digest, name: `${digit}.png`, count: 1,
        mediaType: 'image/png', mediaKind: 'image' })
      expect(selected(), `boundary/asset-field/app-view depth ${depth}`).toEqual([expected('1'), expected('2')])
      const result = store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: key, value: asset('3') } })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(selected()).toEqual([expected('3'), expected('2')])
      expect(store.undo()).toBe(true)
      expect(selected()).toEqual([expected('1'), expected('2')])
      expect(store.redo()).toBe(true)
      const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(selected(reopened)).toEqual([expected('3'), expected('2')])
      const run = compile({ document: reopened, revision: 1, resolve: resolveAssets,
        scope: { kind: 'full' }, connection: 'asset-preview' as never, schemaHash: 'boundary-assets' })
      expect(run.ok, JSON.stringify(!run.ok && run.diagnostics)).toBe(true)
      if (!run.ok) throw new Error(JSON.stringify(run.diagnostics))
      const prefix = depth === 2 ? 'detail.' : ''
      expect(run.artifact.prompt[`first.${prefix}sample`]!.inputs.image).toEqual(asset('3'))
      expect(run.artifact.prompt[`second.${prefix}sample`]!.inputs.image).toEqual(asset('2'))
    }
  })

  it('preserves declared order, labels, and selected-asset preview metadata', () => {
    const asset = {
      digest: `blake3:${'1'.repeat(64)}`,
      name: 'preview.png',
      size: 10,
      mediaType: 'image/png',
      virtualPath: 'preview.png',
    }
    const rows = buildPreviewRows(doc({
      values: { image: [asset, { ...asset, digest: `blake3:${'2'.repeat(64)}` }] },
      exposedPreviews: [
        { graphId: 'g0', nodeId: 'preview', label: 'Result' },
        { graphId: 'g0', nodeId: 'sink' },
      ],
    }), resolve, rendererFor)

    expect(rows.map((row) => row.entry.nodeId)).toEqual(['preview', 'sink'])
    expect(rows[0]).toMatchObject({
      kind: 'candidate',
      label: 'Result',
      context: 'Preview',
      selectedAsset: {
        digest: asset.digest,
        name: 'preview.png',
        count: 2,
        mediaType: 'image/png',
        mediaKind: 'image',
      },
    })
  })

  it('retains entries for missing graphs and nodes as stale rows', () => {
    const rows = buildPreviewRows(doc({
      exposedPreviews: [
        { graphId: 'missing', nodeId: 'preview' },
        { graphId: 'g0', nodeId: 'missing' },
      ],
    }), resolve, rendererFor)

    expect(rows.map((row) => row.kind)).toEqual(['stale', 'stale'])
    expect(rows.map((row) => row.kind === 'stale' ? row.reason : '')).toEqual([
      'graph no longer exists',
      'node no longer exists',
    ])
  })
})

describe('previewRuntimeMapping', () => {
  it('aggregates nested occurrences of a shared definition without changing occurrence order', () => {
    const sharedDoc = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'shared-preview', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 4,
          nodes: {
            sharedA: { id: 'sharedA', type: '#shared', values: {} },
            sharedB: { id: 'sharedB', type: '#shared', values: {} },
            outer: { id: 'outer', type: '#outer', values: {} },
          },
        },
        outer: {
          id: 'outer', name: 'outer', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { inner: { id: 'inner', type: '#shared', values: {} } },
        },
        shared: {
          id: 'shared', name: 'shared', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3,
          nodes: {
            target: { id: 'target', type: 'Preview', values: {} },
            nested: { id: 'nested', type: '#leaf', values: {} },
          },
        },
        leaf: {
          id: 'leaf', name: 'leaf', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { deep: { id: 'deep', type: 'Preview', values: {} } },
        },
      },
      view: { graphs: {} },
    } as unknown as WorkflowDocument
    const runtimeIds = [
      'outer.inner.nested.deep',
      'sharedB.nested.deep',
      'sharedA.nested.deep',
      'outer.inner.nested',
      'sharedB.nested',
      'sharedA.nested',
      'outer.inner.target',
      'sharedB.target',
      'sharedA.target[2]',
      'sharedA.target',
      'unrelated.target',
    ]
    const execution = {
      nodes: Object.fromEntries(runtimeIds.map((runtimeId) => [runtimeId, { state: 'done' }])),
      outputs: { 'sharedA.target': {} },
      previews: {}, activities: [], artifacts: [],
    } as unknown as ExecutionState

    const mapping = previewRuntimeMapping(sharedDoc, execution, 'shared')!
    expect(mapping.own('target')).toEqual([
      'sharedA.target', 'sharedA.target[2]', 'sharedB.target', 'outer.inner.target',
    ])
    expect(mapping.own('nested')).toEqual([
      'sharedA.nested', 'sharedB.nested', 'outer.inner.nested',
    ])
    expect(mapping.all('nested')).toEqual([
      'sharedA.nested', 'sharedA.nested.deep',
      'sharedB.nested', 'sharedB.nested.deep',
      'outer.inner.nested', 'outer.inner.nested.deep',
    ])
  })
})

describe('App View queue targets', () => {
  it('expands one definition target across repeated nested occurrences and reports stale targets', () => {
    const sharedDoc = {
      format: 'dinkster-workflow', formatVersion: 1, lineage: 'shared-queue', root: 'root',
      graphs: {
        root: {
          id: 'root', name: 'Root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 4,
          nodes: {
            sharedA: { id: 'sharedA', type: '#shared', values: {} },
            sharedB: { id: 'sharedB', type: '#shared', values: {} },
            direct: { id: 'direct', type: 'Output', title: 'Direct result', values: {} },
          },
        },
        shared: {
          id: 'shared', name: 'Shared stage', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { target: { id: 'target', type: 'Output', title: 'Shared result', values: {} } },
        },
        orphan: {
          id: 'orphan', name: 'Unreachable stage', links: {}, nets: {}, reroutes: {}, nextOrdinal: 2,
          nodes: { target: { id: 'target', type: 'Output', title: 'Orphan result', values: {} } },
        },
      },
      view: { graphs: {} },
    } as unknown as WorkflowDocument

    expect(appViewQueueTargetOptions(sharedDoc)).toEqual([
      { graphId: 'root', nodeId: 'direct', label: 'Direct result', context: 'Root' },
      { graphId: 'shared', nodeId: 'target', label: 'Shared result', context: 'Shared stage' },
    ])
    expect(appViewQueueScope(sharedDoc, [
      { graphId: 'shared', nodeId: 'target' },
      { graphId: 'missing', nodeId: 'gone' },
    ])).toEqual({
      scope: {
        kind: 'partial',
        targets: [
          { instancePath: ['sharedA'], node: 'target' },
          { instancePath: ['sharedB'], node: 'target' },
        ],
      },
      missing: [{ graphId: 'missing', nodeId: 'gone' }],
    })
  })
})
