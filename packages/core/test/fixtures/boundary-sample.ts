import type { BoundaryEntry, GraphDef, WorkflowDocument } from '../../src/format/document.js'
import type { BodyRow, InputSpec, NodeSchema, TypeExpr } from '../../src/schema/model.js'
import { withPrimitives } from './primitive-schemas.js'

const type = (name: string): TypeExpr => ({ kind: 'concrete', name })
const field = (id: string, value = 0.3): InputSpec => ({
  kind: 'input', id, type: type('FLOAT'), optional: false,
  widget: { widgetType: 'FLOAT', options: { min: 0, max: 1 }, default: value },
})
const pin = (id: string, name: string): InputSpec => ({ kind: 'input', id, type: type(name), optional: true })
const out = (id: string, name = 'FLOAT'): BodyRow => ({ kind: 'output', id, type: type(name) })
const schema = (name: string, body: BodyRow[]): NodeSchema => ({
  type: name, displayName: name, category: 'test', source: 'v3', isOutputNode: true, body,
})

export const boundarySampleSchema = schema('Boundary sample', [
  pin('image', 'IMAGE'), pin('mask', 'MASK'),
  { ...field('strength'), tooltip: 'Mix strength', visible: { formula: 'true' } },
  field('radius', 0.1), field('feather', 0.4), field('balance', 0.7),
  { kind: 'group', id: 'layers', member: [pin('image', 'IMAGE'), field('strength'), out('result')],
    keys: { kind: 'numbered', prefix: 'layer', start: 0, pad: 0 }, grows: 'button', minMembers: 0, maxMembers: 8, reorderable: true },
  { kind: 'group', id: 'nested', member: [
    { kind: 'group', id: 'weights', value: field('weight'), keys: { kind: 'numbered', prefix: 'w', start: 0, pad: 0 }, grows: 'button', minMembers: 0, maxMembers: 4 },
  ], keys: { kind: 'numbered', prefix: 'n', start: 0, pad: 0 }, grows: 'button', minMembers: 0, maxMembers: 4 },
  { kind: 'choice', id: 'mode', required: true, default: 'image', shared: [field('mix')], options: [
    { key: 'image', rows: [pin('picture', 'IMAGE'), { kind: 'use', id: 'mix' }] },
    { key: 'text', rows: [{ kind: 'input', id: 'text', type: type('STRING'), optional: false,
      widget: { widgetType: 'STRING', options: {}, default: 'inner text' } }, { kind: 'use', id: 'mix' }] },
  ] },
  { kind: 'typeChoice', id: 'source', required: false, rows: [], variants: [
    { key: 'image', type: type('IMAGE'), rows: [field('gain', 0.1)] },
    { key: 'mask', type: type('MASK'), rows: [field('gain', 0.7)] },
  ] },
  { kind: 'described', id: 'description', minEntries: 0, maxEntries: 4, fixedIds: true, kinds: [
    { kind: 'input', id: 'text', type: type('STRING'), optional: false,
      widget: { widgetType: 'STRING', options: {}, default: 'description default' } },
    { kind: 'output', id: 'number', type: type('FLOAT') },
  ] },
  { ...field('count', 3), type: type('INT'), socketless: true,
    widget: { widgetType: 'INT', options: { min: 1, max: 4 }, default: 3 } },
  { kind: 'group', id: 'outputs', value: { kind: 'output', id: 'number', type: type('FLOAT') },
    keys: { kind: 'numbered', prefix: 'o', start: 0, pad: 0 }, grows: { count: 'count' }, minMembers: 0, maxMembers: 4 },
  out('result'), out('output91'),
])

const schemas: Record<string, NodeSchema> = {
  'Boundary sample': boundarySampleSchema,
  ImageSource: schema('ImageSource', [out('image', 'IMAGE')]),
  MaskSource: schema('MaskSource', [out('mask', 'MASK')]),
  FloatSource: schema('FloatSource', [out('number')]),
  NumberSink: schema('NumberSink', [pin('number', 'FLOAT')]),
}
export const resolveBoundarySample = withPrimitives((name) => schemas[name])

const bind = (node: string, port: string, kind = 'port') => ({ kind, node, port })
const leafRows = (): BoundaryEntry[] => [
  ...['image', 'mask', 'strength', 'radius', 'feather', 'balance', 'count'].map((id) => ({
    kind: 'input', id, binds: bind('sample', id), ...(!['image', 'mask'].includes(id) ? { promoted: true } : {}),
  })),
  ...['layers', 'nested', 'mode', 'source', 'description'].map((id) => ({ kind: 'input', id, binds: bind('sample', id, 'construct') })),
  { kind: 'output', id: 'outputs', binds: bind('sample', 'outputs', 'construct') },
  { kind: 'output', id: 'result', binds: bind('sample', 'result') },
  { kind: 'output', id: 'output91', binds: bind('sample', 'output91') },
] as BoundaryEntry[]

const graph = (id: string, name: string, nodes: Record<string, unknown>, body?: BoundaryEntry[]): GraphDef => ({
  id, name, nodes, links: {}, nets: {}, reroutes: {}, nextOrdinal: 100,
  ...(body ? { boundary: { body } } : {}),
}) as unknown as GraphDef

/** Same stored fixture at the plain node, Detail pass, and Portrait fix. */
export function boundarySample(level: 0 | 1 | 2 = 2): WorkflowDocument {
  const detail = graph('detail', 'Detail pass', {
    sample: { id: 'sample', type: 'Boundary sample', values: {
      strength: 0.3, count: 3, 'mode.text': 'dormant inner text',
      'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
    }, dynamic: {
      layers: { members: ['layer0', 'layer1'] },
      nested: { members: ['n0', 'n1'] },
      'nested.n0.weights': { members: ['w0'] },
      'nested.n1.weights': { members: ['w0', 'w1'] },
      mode: { selected: 'image' },
    } },
  }, leafRows())
  const portraitRows = leafRows().map((row) => ({ ...row, binds: bind('detail', (row as { id: string }).id,
    (row as { binds: { kind: string } }).binds.kind) })) as BoundaryEntry[]
  const portrait = graph('portrait', 'Portrait fix', {
    detail: { id: 'detail', type: '#detail', values: { strength: 0.6 } },
  }, portraitRows)
  const root = graph('root', 'Boundary sample acceptance', {
    first: { id: 'first', type: level === 2 ? '#portrait' : level === 1 ? '#detail' : 'Boundary sample', values: { strength: 0.2, count: 3 },
      ...(level === 0 ? { dynamic: structuredClone(detail.nodes.sample!.dynamic) } : {}) },
    second: { id: 'second', type: level === 2 ? '#portrait' : level === 1 ? '#detail' : 'Boundary sample', values: { strength: 0.8, count: 2, 'mode.text': 'second text' },
      dynamic: { ...(level === 0 ? structuredClone(detail.nodes.sample!.dynamic) : {}), mode: { selected: 'text' } } },
    imageA: { id: 'imageA', type: 'ImageSource', values: {} },
    maskB: { id: 'maskB', type: 'MaskSource', values: {} },
    sink: { id: 'sink', type: 'NumberSink', values: {} },
  })
  return {
    format: 'dinkster-workflow', formatVersion: 1, lineage: 'boundary-sample', root: 'root',
    graphs: { root, ...(level > 0 ? { detail } : {}), ...(level === 2 ? { portrait } : {}) },
    view: { graphs: {} },
  } as unknown as WorkflowDocument
}
