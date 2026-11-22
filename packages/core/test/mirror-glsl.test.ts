
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GraphDef, ValueSourceData } from '../src/format/document.js'
import { asGraphDefId, asLinkId, asNodeId, asPortId, asValueSourceId } from '../src/ids.js'
import { deriveGlslMirrorBindings } from '../src/mirror/glsl.js'
import { DINKSTER_SCHEMA_WIRE_VERSION, parseDinksterNodes } from '../src/schema/dinkster-wire.js'
import type { InputSpec, MirrorSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'

/**
 * Exact serialization of the dinkster.image.adjust schema
 * (dinkster_schema.wire.schema_to_wire), including its declared glsl mirror.
 * Vendored so binding derivation and the e2e GPU parity suite exercise the
 * real shipped shader; regenerate from the engine serializer.
 */
const adjustWire = JSON.parse(
  readFileSync(new URL('./fixtures/image_adjust.json', import.meta.url), 'utf8'),
) as { mirror: { source: string; tolerance: { perChannel: number } } }

/**
 * Decodes a vendored wire schema on first use, so a fixture that no longer
 * decodes fails only the tests that read it.
 */
const vendoredSchema = (type: string, wire: unknown): (() => NodeSchema) => {
  let schema: NodeSchema | undefined
  return () => {
    if (schema !== undefined) return schema
    const parsed = parseDinksterNodes({ schemaVersion: DINKSTER_SCHEMA_WIRE_VERSION, nodes: { [type]: wire } })
    expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    schema = parsed.schemas.get(type)
    expect(schema).toBeDefined()
    return schema!
  }
}

const adjustSchema = vendoredSchema('dinkster.image.adjust', adjustWire)

/**
 * Exact serialization of the dinkster.image.filter schema
 * (dinkster_schema.wire.schema_to_wire), including its scoped glsl mirror.
 * Vendored so binding derivation and the e2e GPU parity suite exercise the
 * real shipped shader; regenerate from the engine serializer.
 */
const filterWire = JSON.parse(
  readFileSync(new URL('./fixtures/image_filter.json', import.meta.url), 'utf8'),
) as { mirror: { source: string; tolerance: { perChannel: number }; applies: Record<string, readonly string[]> } }

const filterSchema = vendoredSchema('dinkster.image.filter', filterWire)

const output = (id: string, type: string): OutputSpec => ({
  kind: 'output',
  id,
  type: { kind: 'concrete', name: type },
})

/** Producer with one image output plus a float widget input (tap source). */
const imageSourceSchema: NodeSchema = {
  type: 'ImageSource',
  displayName: 'Image Source',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: [
    {
      kind: 'input',
      id: 'level',
      type: { kind: 'concrete', name: 'FLOAT' },
      optional: false,
      widget: { widgetType: 'NUMBER', options: {}, default: 0.75 },
    },
    output('out', 'IMAGE'),
    output('scalar', 'FLOAT'),
  ],
}

const GLSL_MIRROR: MirrorSpec = {
  kind: 'glsl',
  precision: 'bounded',
  tolerance: { perChannel: 1 / 255 },
  source: 'void main() {}',
}

/** Hand-built mirrored schema exercising int/bool/structured-combo inputs. */
const gateSchema = (mirror: MirrorSpec | null = GLSL_MIRROR): NodeSchema => ({
  type: 'test.gate',
  displayName: 'Gate',
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  ...(mirror ? { mirror } : {}),
  body: [
    { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false } as InputSpec,
    {
      kind: 'input',
      id: 'steps',
      type: { kind: 'concrete', name: 'INT' },
      optional: false,
      widget: { widgetType: 'INT', options: {}, default: 4 },
    },
    {
      kind: 'input',
      id: 'enabled',
      type: { kind: 'concrete', name: 'BOOLEAN' },
      optional: false,
      widget: { widgetType: 'TOGGLE', options: {}, default: true },
    },
    {
      kind: 'input',
      id: 'mode',
      type: { kind: 'concrete', name: 'COMBO' },
      optional: false,
      widget: {
        widgetType: 'COMBO',
        options: { options: [{ value: 'soft', label: 'Soft' }, { value: 'hard', label: 'Hard' }] },
        default: 'soft',
      },
    },
    output('image', 'IMAGE'),
  ],
})

const schemas = new Map<string, NodeSchema>([
  ['ImageSource', imageSourceSchema],
  ['test.gate', gateSchema()],
])
const resolve = (type: string): NodeSchema | undefined =>
  type === 'dinkster.image.adjust' ? adjustSchema()
    : type === 'dinkster.image.filter' ? filterSchema()
      : schemas.get(type)

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const tap = (node: string, inputId: string) => ({ node: asNodeId(node), tap: asPortId(inputId) })
const vsrc = (id: string) => ({ valueSource: asValueSourceId(id) })
const source = (id: string, value: unknown): ValueSourceData =>
  ({ id: asValueSourceId(id), value }) as ValueSourceData
const link = (id: string, from: object, to: object) =>
  ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]
const node = (id: string, type: string, values: Record<string, unknown> = {}) =>
  ({ id: asNodeId(id), type, values }) as GraphDef['nodes'][string]

function graph(partial: Omit<Partial<GraphDef>, 'id'> & { id: string }): GraphDef {
  return {
    name: 'g',
    nodes: {},
    links: {},
    nets: {},
    reroutes: {},
    nextOrdinal: 100,
    ...partial,
    id: asGraphDefId(partial.id),
  }
}

const bindingOf = (def: GraphDef, nodeId = 'a1') => deriveGlslMirrorBindings(def, resolve).get(nodeId)

/** Choice keys stored on a node, as the editor stores them. */
const chosen = (keys: Record<string, string>) =>
  ({ dynamic: Object.fromEntries(Object.entries(keys).map(([id, selected]) => [id, { selected }])) })

/** Adjust node on `operation`, fed by the producer's image output; values as given. */
const adjustNode = (operation: string, values: Record<string, unknown> = {}) =>
  ({ ...node('a1', 'dinkster.image.adjust', values), ...chosen({ operation }) }) as GraphDef['nodes'][string]

const adjustGraph = (operation: string, values: Record<string, unknown> = {}, extra?: Partial<GraphDef>) =>
  graph({
    id: 'g0',
    nodes: { src: node('src', 'ImageSource'), a1: adjustNode(operation, values) },
    ...extra,
    links: {
      l1: link('l1', port('src', 'out'), port('a1', 'image')),
      ...extra?.links,
    },
  })

describe('deriveGlslMirrorBindings', () => {
  it('binds the choice as its option index and the chosen option\'s rows by declared id', () => {
    // contrast is the fourth option and places the shared factor row by Use;
    // the start option is brightness, so a binding from the start key differs.
    const def = adjustGraph('contrast', { 'operation.factor': 2.5 })
    expect(bindingOf(def)).toEqual({
      source: adjustSchema().mirror!.source,
      images: [{ name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } }],
      scalars: [
        { name: 'operation', glslType: 'int', value: 3 },
        { name: 'factor', glslType: 'float', value: 2.5 },
      ],
    })
  })

  it('falls back to declared widget defaults for unset scalars', () => {
    expect(bindingOf(adjustGraph('normalize'))?.scalars).toEqual([
      { name: 'operation', glslType: 'int', value: 1 },
      { name: 'mean', glslType: 'float', value: 0.5 },
      { name: 'standard_deviation', glslType: 'float', value: 0.5 },
    ])
  })

  it('yields no binding for a required choice without a stored key', () => {
    // The run refuses such a node, so there is nothing to estimate.
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'dinkster.image.adjust') },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('resolves value-source literals driving a scalar input', () => {
    const def = adjustGraph('brightness', {}, {
      valueSources: { v1: source('v1', 0.25) },
      links: { l2: link('l2', vsrc('v1'), port('a1', 'operation.factor')) },
    })
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.25 })
  })

  it('resolves widget taps through stored values and widget defaults', () => {
    const def = adjustGraph('brightness', {}, {
      links: { l2: link('l2', tap('src', 'level'), port('a1', 'operation.factor')) },
    })
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.75 })
    ;(def.nodes['src']!.values as Record<string, unknown>)['level'] = 0.1
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.1 })
  })

  it('yields no binding when a scalar is driven by a producer output', () => {
    const def = adjustGraph('brightness', {}, {
      links: { l2: link('l2', port('src', 'scalar'), port('a1', 'operation.factor')) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('binds an image input fed through a graph net', () => {
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: adjustNode('invert') },
      nets: {
        n1: { id: 'n1', name: 'imagery', source: port('src', 'out'), sinks: [port('a1', 'image')] },
      } as unknown as GraphDef['nets'],
    })
    expect(bindingOf(def)?.images).toEqual([
      { name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } },
    ])
  })

  it('binds an image input fed through a reroute chain', () => {
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: adjustNode('invert') },
      reroutes: { r1: { id: 'r1' } } as unknown as GraphDef['reroutes'],
      links: {
        l1: link('l1', port('src', 'out'), { reroute: 'r1' }),
        l2: link('l2', { reroute: 'r1' }, port('a1', 'image')),
      },
    })
    expect(bindingOf(def)?.images).toEqual([
      { name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } },
    ])
  })

  it('yields no binding when a scalar is fed through a graph net', () => {
    const def = adjustGraph('brightness', {}, {
      nets: {
        n1: { id: 'n1', name: 'levels', source: port('src', 'scalar'), sinks: [port('a1', 'operation.factor')] },
      } as unknown as GraphDef['nets'],
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding without a producer-driven image input', () => {
    const def = graph({
      id: 'g0',
      nodes: { a1: adjustNode('invert') },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding when the image input is fed by a value source', () => {
    const def = graph({
      id: 'g0',
      nodes: { a1: adjustNode('invert') },
      valueSources: { v1: source('v1', 'not-an-image') },
      links: { l1: link('l1', vsrc('v1'), port('a1', 'image')) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding for a stored key the choice does not declare', () => {
    expect(bindingOf(adjustGraph('sharpen'))).toBeUndefined()
  })

  it('yields no binding for non-finite or non-integer-int scalars', () => {
    for (const values of [{ steps: 1.5 }, { steps: Number.NaN }, { enabled: 'yes' }]) {
      const def = graph({
        id: 'g0',
        nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.gate', values) },
        links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
      })
      expect(bindingOf(def)).toBeUndefined()
    }
  })

  it('binds int, bool, and structured combo options by value', () => {
    const def = graph({
      id: 'g0',
      nodes: {
        src: node('src', 'ImageSource'),
        a1: node('a1', 'test.gate', { steps: 7, enabled: false, mode: 'hard' }),
      },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(bindingOf(def)?.scalars).toEqual([
      { name: 'steps', glslType: 'int', value: 7 },
      { name: 'enabled', glslType: 'bool', value: false },
      { name: 'mode', glslType: 'int', value: 1 },
    ])
  })

})

/**
 * Filter node fed by the producer's image output. `operation` is the stored
 * choice key; `values` holds the chosen option's scalars under their
 * flattened ids ('operation.radius').
 */
const filterGraph = (operation?: string, values: Record<string, unknown> = {}) =>
  graph({
    id: 'g0',
    nodes: {
      src: node('src', 'ImageSource'),
      f1: {
        ...node('f1', 'dinkster.image.filter', values),
        ...(operation !== undefined ? { dynamic: { operation: { selected: operation } } } : {}),
      } as GraphDef['nodes'][string],
    },
    links: { l1: link('l1', port('src', 'out'), port('f1', 'image')) },
  })

describe('applies-scoped binding derivation', () => {
  it('binds only while the stored choice key is covered', () => {
    const scoped: NodeSchema = {
      type: 'test.scoped',
      displayName: 'Scoped',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      mirror: { ...GLSL_MIRROR, applies: { operation: ['blur'] } },
      body: [
        { kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: false },
        {
          kind: 'choice',
          id: 'operation',
          required: true,
          default: 'blur',
          shared: [],
          options: [
            { key: 'blur', rows: [{ kind: 'input', id: 'radius', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {}, default: 1 } }] },
            { key: 'noise', rows: [{ kind: 'input', id: 'strength', type: { kind: 'concrete', name: 'FLOAT' }, optional: false, widget: { widgetType: 'NUMBER', options: {}, default: 0.5 } }] },
          ],
        },
        output('image', 'IMAGE'),
      ],
    }
    const local = (t: string) => (t === 'test.scoped' ? scoped : resolve(t))
    const scopedGraph = (selected: string, values: Record<string, unknown>) => graph({
      id: 'g0',
      nodes: {
        src: node('src', 'ImageSource'),
        a1: { ...node('a1', 'test.scoped', values), dynamic: { operation: { selected } } } as GraphDef['nodes'][string],
      },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(deriveGlslMirrorBindings(scopedGraph('blur', { 'operation.radius': 3 }), local).get('a1')?.scalars).toEqual([
      { name: 'operation', glslType: 'int', value: 0 },
      { name: 'radius', glslType: 'int', value: 3 },
    ])
    expect(deriveGlslMirrorBindings(scopedGraph('noise', { 'operation.strength': 0.25 }), local).get('a1')).toBeUndefined()

    // An optional choice on "none" would read as the first option, so it
    // binds nothing; on an option it binds that option's index.
    const optional: NodeSchema = {
      ...scoped,
      type: 'test.optional',
      mirror: GLSL_MIRROR,
      body: scoped.body.map((row) => {
        if (row.kind !== 'choice') return row
        const { default: _start, ...rest } = row
        return { ...rest, required: false }
      }),
    }
    const withOptional = (t: string) => (t === 'test.scoped' ? optional : resolve(t))
    const none = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.scoped') },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(deriveGlslMirrorBindings(none, withOptional).get('a1')).toBeUndefined()
    expect(deriveGlslMirrorBindings(scopedGraph('noise', { 'operation.strength': 0.25 }), withOptional).get('a1')?.scalars).toEqual([
      { name: 'operation', glslType: 'int', value: 1 },
      { name: 'strength', glslType: 'float', value: 0.25 },
    ])
  })

  it('binds a covered operation from dynamic state and stored branch values', () => {
    const binding = deriveGlslMirrorBindings(
      filterGraph('gaussian_blur', { 'operation.radius': 2, 'operation.sigma': 1.5 }), resolve).get('f1')
    expect(binding).toEqual({
      source: filterSchema().mirror!.source,
      images: [{ name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } }],
      scalars: [
        { name: 'operation', glslType: 'int', value: 0 },
        { name: 'radius', glslType: 'int', value: 2 },
        { name: 'sigma', glslType: 'float', value: 1.5 },
      ],
    })
  })

  it('binds the second covered operation with its extra input', () => {
    const binding = deriveGlslMirrorBindings(filterGraph('sharpen'), resolve).get('f1')
    expect(binding?.scalars).toEqual([
      { name: 'operation', glslType: 'int', value: 1 },
      { name: 'radius', glslType: 'int', value: 1 },
      { name: 'sigma', glslType: 'float', value: 1.0 },
      { name: 'strength', glslType: 'float', value: 1.0 },
    ])
  })

  it.each(['noise', 'quantize', 'erode', 'dilate'])('yields no binding for uncovered operation %s', (operation) => {
    // Without the applies gate, noise would derive a binding (its strength
    // and seed inputs resolve fine) and the shader would run its sharpen
    // else-branch: a wrong estimate, not a missing one.
    expect(deriveGlslMirrorBindings(filterGraph(operation), resolve).get('f1')).toBeUndefined()
  })

  it('yields no binding when an applies key names no choice of the node', () => {
    const scoped = gateSchema({ ...GLSL_MIRROR, applies: { missing: ['soft'] } })
    const local = new Map(schemas)
    local.set('test.gate', scoped)
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.gate', { mode: 'soft' }) },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(deriveGlslMirrorBindings(def, (t) => local.get(t)).get('a1')).toBeUndefined()
  })

  it('yields no binding when an applies key names an input rather than a choice', () => {
    const scoped = gateSchema({ ...GLSL_MIRROR, applies: { steps: ['4'] } })
    const local = new Map(schemas)
    local.set('test.gate', scoped)
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'test.gate', {}) },
      links: { l1: link('l1', port('src', 'out'), port('a1', 'image')) },
    })
    expect(deriveGlslMirrorBindings(def, (t) => local.get(t)).get('a1')).toBeUndefined()
  })
})
