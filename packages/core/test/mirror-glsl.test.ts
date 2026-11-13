
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GraphDef, ValueSourceData } from '../src/format/document.js'
import { asGraphDefId, asLinkId, asNodeId, asPortId, asValueSourceId } from '../src/ids.js'
import { deriveGlslMirrorBindings } from '../src/mirror/glsl.js'
import { parseDinksterNodes } from '../src/schema/dinkster-wire.js'
import type { InputSpec, MirrorSpec, NodeSchema, OutputSpec } from '../src/schema/model.js'

/**
 * Exact wire-29 serialization of the backend's dinkster.image.adjust schema
 * (dinkster_schema.wire.schema_to_wire at Dinkster main), including its declared
 * glsl mirror. Vendored so binding derivation and the e2e GPU parity suite
 * exercise the real shipped shader; regenerate from the backend serializer.
 */
const adjustWire = JSON.parse(
  readFileSync(new URL('./fixtures/image_adjust_wire29.json', import.meta.url), 'utf8'),
) as { mirror: { source: string; tolerance: { perChannel: number } } }

const adjustSchema = ((): NodeSchema => {
  const parsed = parseDinksterNodes({ schemaVersion: 1, nodes: { 'dinkster.image.adjust': adjustWire } })
  expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  const schema = parsed.schemas.get('dinkster.image.adjust')
  expect(schema).toBeDefined()
  return schema!
})()

/**
 * Exact wire-30 serialization of the backend's dinkster.image.filter schema
 * (dinkster_schema.wire.schema_to_wire at Dinkster main), including its scoped
 * glsl mirror. Vendored so binding derivation and the e2e GPU parity suite
 * exercise the real shipped shader; regenerate from the backend serializer.
 */
const filterWire = JSON.parse(
  readFileSync(new URL('./fixtures/image_filter_wire30.json', import.meta.url), 'utf8'),
) as { mirror: { source: string; tolerance: { perChannel: number }; applies: Record<string, readonly string[]> } }

const filterSchema = ((): NodeSchema => {
  const parsed = parseDinksterNodes({ schemaVersion: 1, nodes: { 'dinkster.image.filter': filterWire } })
  expect(parsed.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  const schema = parsed.schemas.get('dinkster.image.filter')
  expect(schema).toBeDefined()
  return schema!
})()

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
  items: [
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
  items: [
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
  ['dinkster.image.adjust', adjustSchema],
  ['dinkster.image.filter', filterSchema],
  ['ImageSource', imageSourceSchema],
  ['test.gate', gateSchema()],
])
const resolve = (type: string): NodeSchema | undefined => schemas.get(type)

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

/** Adjust node fed by the producer's image output; values as given. */
const adjustGraph = (values: Record<string, unknown>, extra?: Partial<GraphDef>) =>
  graph({
    id: 'g0',
    nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'dinkster.image.adjust', values) },
    ...extra,
    links: {
      l1: link('l1', port('src', 'out'), port('a1', 'image')),
      ...extra?.links,
    },
  })

describe('deriveGlslMirrorBindings', () => {
  it('binds the wire-decoded adjust schema from stored widget values', () => {
    const def = adjustGraph({ operation: 'contrast', factor: 2.5 })
    expect(bindingOf(def)).toEqual({
      source: adjustSchema.mirror!.source,
      images: [{ name: 'u_image', inputId: 'image', driver: { node: 'src', output: 'out' } }],
      scalars: [
        { name: 'operation', glslType: 'int', value: 3 },
        { name: 'factor', glslType: 'float', value: 2.5 },
        { name: 'mean', glslType: 'float', value: 0.5 },
        { name: 'standard_deviation', glslType: 'float', value: 0.5 },
      ],
    })
  })

  it('falls back to declared widget defaults for unset scalars', () => {
    const binding = bindingOf(adjustGraph({}))
    expect(binding?.scalars).toEqual([
      { name: 'operation', glslType: 'int', value: 2 },
      { name: 'factor', glslType: 'float', value: 1.0 },
      { name: 'mean', glslType: 'float', value: 0.5 },
      { name: 'standard_deviation', glslType: 'float', value: 0.5 },
    ])
  })

  it('resolves value-source literals driving a scalar input', () => {
    const def = adjustGraph({ operation: 'brightness' }, {
      valueSources: { v1: source('v1', 0.25) },
      links: { l2: link('l2', vsrc('v1'), port('a1', 'factor')) },
    })
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.25 })
  })

  it('resolves widget taps through stored values and widget defaults', () => {
    const def = adjustGraph({ operation: 'brightness' }, {
      links: { l2: link('l2', tap('src', 'level'), port('a1', 'factor')) },
    })
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.75 })
    ;(def.nodes['src']!.values as Record<string, unknown>)['level'] = 0.1
    expect(bindingOf(def)?.scalars).toContainEqual({ name: 'factor', glslType: 'float', value: 0.1 })
  })

  it('yields no binding when a scalar is driven by a producer output', () => {
    const def = adjustGraph({}, {
      links: { l2: link('l2', port('src', 'scalar'), port('a1', 'factor')) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('binds an image input fed through a graph net', () => {
    const def = graph({
      id: 'g0',
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'dinkster.image.adjust', {}) },
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
      nodes: { src: node('src', 'ImageSource'), a1: node('a1', 'dinkster.image.adjust', {}) },
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
    const def = adjustGraph({}, {
      nets: {
        n1: { id: 'n1', name: 'levels', source: port('src', 'scalar'), sinks: [port('a1', 'factor')] },
      } as unknown as GraphDef['nets'],
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding without a producer-driven image input', () => {
    const def = graph({
      id: 'g0',
      nodes: { a1: node('a1', 'dinkster.image.adjust', { operation: 'invert' }) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding when the image input is fed by a value source', () => {
    const def = graph({
      id: 'g0',
      nodes: { a1: node('a1', 'dinkster.image.adjust', {}) },
      valueSources: { v1: source('v1', 'not-an-image') },
      links: { l1: link('l1', vsrc('v1'), port('a1', 'image')) },
    })
    expect(bindingOf(def)).toBeUndefined()
  })

  it('yields no binding for a combo value outside the declared options', () => {
    expect(bindingOf(adjustGraph({ operation: 'sharpen' }))).toBeUndefined()
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
 * Filter node fed by the producer's image output. `operation` selects the
 * DynamicCombo branch via node dynamic state (the selector's value home);
 * `values` holds branch scalars under their dotted value keys
 * ('operation.radius').
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
  it('binds a covered operation from dynamic state and stored branch values', () => {
    const binding = deriveGlslMirrorBindings(
      filterGraph('gaussian_blur', { 'operation.radius': 2, 'operation.sigma': 1.5 }), resolve).get('f1')
    expect(binding).toEqual({
      source: filterSchema.mirror!.source,
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

  it('binds the default operation when it is covered', () => {
    // Without dynamic state the default branch (gaussian_blur) materializes,
    // inside the scope.
    expect(deriveGlslMirrorBindings(filterGraph(), resolve).get('f1')).toBeDefined()
  })

  it.each(['noise', 'quantize', 'erode', 'dilate'])('yields no binding for uncovered operation %s', (operation) => {
    // Without the applies gate, noise would derive a binding (its strength
    // and seed inputs resolve fine) and the shader would run its sharpen
    // else-branch: a wrong estimate, not a missing one.
    expect(deriveGlslMirrorBindings(filterGraph(operation), resolve).get('f1')).toBeUndefined()
  })

  it('yields no binding when an applies key never surfaces as a combo input', () => {
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

  it('yields no binding when an applies key names a non-combo input', () => {
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
