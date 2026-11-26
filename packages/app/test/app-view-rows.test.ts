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
import { asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId, compile, coreCommandRegistry, DocumentStore, documentResolver, loadDocument, type GraphDef, type InputSpec, type Json, type NodeSchema, type OutputSpec, type TypeExpr, type WidgetRegistry, type WorkflowDocument } from '@dinkster/core'
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

  it('shows an automatic field with nothing stored at the value it has in use, not its default', () => {
    const INT: TypeExpr = { kind: 'concrete', name: 'INT' }
    const automatic: NodeSchema = schemaOf('Sink', [input('seed', { type: INT }), input('steps', { type: INT, automatic: { formula: 'seed * 2' } })])
    const rows = buildParamRows(
      doc({ values: { seed: 21 }, exposed: [entry('sink', 'steps')] }),
      (type) => type === 'Sink' ? automatic : resolve(type),
    )
    expect(live(rows[0]!).value).toBe(42)
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
