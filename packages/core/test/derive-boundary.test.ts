/**
 * Boundary -> NodeSchema derivation tests. The contract under test is the
 * architecture's core subgraph guarantee: a definition's boundary derives the
 * SAME NodeSchema model backend nodes get, with widget promotion, optionality
 * and type variables (dynamic types) flowing through unchanged.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { deriveBoundarySchema, resolveBoundaryRoute, type SchemaResolver } from '../src/schema/derive-boundary.js'
import { elaborateInterface, elabInputsOf } from '../src/schema/elaborate.js'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { inputsOf, outputCountInputsOf, outputsOf, type NodeSchema } from '../src/schema/model.js'

/** Build a GraphDef from a plain literal (branded ids make literals noisy). */
const asDef = (d: unknown): GraphDef => d as GraphDef

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflows')
const subgraphDoc = (): WorkflowDocument =>
  JSON.parse(readFileSync(join(fixturesDir, 'subgraph.json'), 'utf8')) as WorkflowDocument

// Minimal hand-built inner schemas for the fixture's node types.
const innerSchemas: Record<string, NodeSchema> = {
  KSampler: {
    type: 'KSampler',
    displayName: 'KSampler',
    category: 'sampling',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'seed',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'INT', options: { min: 0 }, default: 0, controller: 'after_generate' },
      },
      { kind: 'input', id: 'latent_image', displayName: 'Latent', type: { kind: 'concrete', name: 'LATENT' }, optional: false },
      { kind: 'output', id: 'out0', type: { kind: 'concrete', name: 'LATENT' } },
    ],
  },
  VAEDecode: {
    type: 'VAEDecode',
    displayName: 'VAE Decode',
    category: 'latent',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'samples', type: { kind: 'concrete', name: 'LATENT' }, optional: false },
      { kind: 'output', id: 'out0', displayName: 'IMAGE', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  ImpactSwitch: {
    type: 'ImpactSwitch',
    displayName: 'Switch',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'select',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'INT', options: {} },
      },
      {
        kind: 'input',
        id: 'input',
        type: { kind: 'variable', templateId: 'T' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [
            {
              kind: 'input',
              id: 'input',
              type: { kind: 'variable', templateId: 'T' },
              optional: true,
            },
          ],
          naming: { kind: 'prefix', prefix: 'input' },
        },
      },
      { kind: 'output', id: 'out0', type: { kind: 'variable', templateId: 'T' } },
    ],
  },
  // Nested dynamics: autogrow 'items' whose template groups a widget slot
  // with a NESTED autogrow slot 'sub' (Autogrow-in-Autogrow).
  Stack: {
    type: 'Stack',
    displayName: 'Stack',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'items',
        type: { kind: 'variable', templateId: 'T' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [
            {
              kind: 'input',
              id: 'name',
              type: { kind: 'concrete', name: 'STRING' },
              optional: true,
              widget: { widgetType: 'STRING', options: {} },
            },
            {
              kind: 'input',
              id: 'sub',
              type: { kind: 'variable', templateId: 'T' },
              optional: true,
              dynamic: {
                kind: 'autogrow',
                template: [{ kind: 'input', id: 'w', type: { kind: 'variable', templateId: 'T' }, optional: true }],
                naming: { kind: 'prefix', prefix: 'sub', max: 4 },
              },
            },
          ],
          naming: { kind: 'prefix', prefix: 'item', min: 1, max: 5 },
        },
      },
      { kind: 'output', id: 'out0', type: { kind: 'variable', templateId: 'T' } },
    ],
  },
  NamedGrow: {
    type: 'NamedGrow',
    displayName: 'Named Grow',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'ins',
        type: { kind: 'concrete', name: 'IMAGE' },
        optional: false,
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'ins', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
          naming: { kind: 'names', names: ['a', 'b', 'c'], min: 2 },
        },
      },
    ],
  },
  MultiOut: {
    type: 'MultiOut',
    displayName: 'Multi Out',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      { kind: 'input', id: 'src', type: { kind: 'variable', templateId: 'T' }, optional: false },
      {
        kind: 'output',
        id: 'outs',
        type: { kind: 'variable', templateId: 'T' },
        isList: true,
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'outs', type: { kind: 'variable', templateId: 'T' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'out', max: 6 },
        },
      },
    ],
  },
  CountOut: {
    type: 'CountOut',
    displayName: 'Count Out',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'count',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'INT', options: {}, default: 0 },
      },
      {
        kind: 'output',
        id: 'images',
        type: { kind: 'concrete', name: 'IMAGE' },
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
          count: { input: 'count', suffix: 'index' },
        },
      },
      { kind: 'output', id: 'done', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  WideCountOut: {
    type: 'WideCountOut',
    displayName: 'Wide Count Out',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'count',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'INT', options: {}, default: 0 },
      },
      {
        kind: 'output',
        id: 'images',
        type: { kind: 'concrete', name: 'IMAGE' },
        dynamic: {
          kind: 'autogrow',
          template: [{ kind: 'input', id: 'image', type: { kind: 'concrete', name: 'IMAGE' }, optional: true }],
          naming: { kind: 'prefix', prefix: 'image', min: 0, max: Number.MAX_SAFE_INTEGER },
          count: { input: 'count', suffix: 'index' },
        },
      },
      { kind: 'output', id: 'done', type: { kind: 'concrete', name: 'IMAGE' } },
    ],
  },
  ComboNode: {
    type: 'ComboNode',
    displayName: 'Combo',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    items: [
      {
        kind: 'input',
        id: 'mode',
        type: { kind: 'concrete', name: 'COMBO' },
        optional: false,
        dynamic: {
          kind: 'dynamicCombo',
          options: [
            { key: 'a', inputs: [{ kind: 'input', id: 'x', type: { kind: 'concrete', name: 'INT' }, optional: false }] },
          ],
        },
      },
    ],
  },
  PlainSlotNode: {
    type: 'PlainSlotNode', displayName: 'Plain slot', category: 'util', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'model', type: { kind: 'concrete', name: 'MODEL' }, optional: true,
      dynamic: { kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'MODEL' }, inputs: [] },
    }],
  },
  SpecializedSlotNode: {
    type: 'SpecializedSlotNode', displayName: 'Specialized slot', category: 'util', source: 'v3', isOutputNode: false,
    items: [{
      kind: 'input', id: 'model', type: { kind: 'concrete', name: 'MODEL' }, optional: true,
      dynamic: {
        kind: 'dynamicSlot', slotType: { kind: 'concrete', name: 'MODEL' }, inputs: [],
        variants: [{
          key: 'special', type: { kind: 'variable', templateId: 'V' },
          inputs: [{ kind: 'input', id: 'strength', type: { kind: 'variable', templateId: 'V' }, optional: false }],
        }],
      },
    }],
  },
  MatchedSlotNode: {
    type: 'MatchedSlotNode', displayName: 'Matched slot', category: 'util', source: 'v3', isOutputNode: false,
    items: [
      {
        kind: 'input', id: 'source', type: { kind: 'union', names: ['IMAGE', 'MASK'] }, optional: false,
        dynamic: {
          kind: 'dynamicSlot', slotType: { kind: 'union', names: ['IMAGE', 'MASK'] }, inputs: [], typeTemplateId: 'T',
          variants: [
            {
              key: 'image', type: { kind: 'concrete', name: 'IMAGE' },
              inputs: [{ kind: 'input', id: 'copy', type: { kind: 'variable', templateId: 'T' }, optional: false }],
            },
            { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, inputs: [] },
          ],
        },
      },
      { kind: 'output', id: 'out', type: { kind: 'variable', templateId: 'T' } },
      { kind: 'output', id: 'batch', type: { kind: 'list', element: { kind: 'variable', templateId: 'T' } } },
    ],
  },
}

const resolve: SchemaResolver = (type) => innerSchemas[type]

describe('deriveBoundarySchema on the subgraph fixture', () => {
  const def = subgraphDoc().graphs['g1'] as GraphDef
  const { schema, diagnostics } = deriveBoundarySchema(def, resolve)

  it('derives a socket for connection-backed inner inputs', () => {
    const latent = inputsOf(schema!).find((i) => i.id === 'latent')!
    expect(latent.type).toEqual({ kind: 'concrete', name: 'LATENT' })
    expect(latent.optional).toBe(false)
    expect(latent.widget).toBeUndefined()
    expect(latent.displayName).toBe('Latent') // boundary displayName wins
  })

  it('promotes widgets onto the instance, controller included', () => {
    const seed = inputsOf(schema!).find((i) => i.id === 'seed')!
    expect(seed.widget).toBeDefined()
    expect(seed.widget!.widgetType).toBe('INT')
    expect(seed.widget!.controller).toBe('after_generate')
    // Widget-backed => satisfiable without a connection.
    expect(seed.optional).toBe(true)
  })

  it('derives outputs with inner types', () => {
    const outs = outputsOf(schema!)
    expect(outs).toHaveLength(1)
    expect(outs[0]!.id).toBe('image')
    expect(outs[0]!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
  })

  it('derives a widget output from one exact static widget-backed input and fails closed otherwise', () => {
    const tapped = asDef({
      ...def,
      boundary: {
        inputs: [],
        outputs: [{ id: 'seedValue', binds: { kind: 'widgetTap', node: 'n0', tap: 'seed' } }],
      },
    })
    const valid = deriveBoundarySchema(tapped, (type) => innerSchemas[type])
    expect(outputsOf(valid.schema!)).toEqual([
      expect.objectContaining({ id: 'seedValue', type: { kind: 'concrete', name: 'INT' } }),
    ])
    expect(valid.diagnostics).toEqual([])

    const missing = asDef({
      ...tapped,
      boundary: {
        inputs: [],
        outputs: [{ id: 'missing', binds: { kind: 'widgetTap', node: 'n0', tap: 'unknown' } }],
      },
    })
    const invalid = deriveBoundarySchema(missing, (type) => innerSchemas[type])
    expect(invalid.schema).toBeUndefined()
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: 'boundary.tapMissing' }))

    const seed = innerSchemas.KSampler!.items[0]!
    const malformed = [
      {
        code: 'boundary.tapAmbiguous',
        tap: 'seed',
        schema: { ...innerSchemas.KSampler!, items: [...innerSchemas.KSampler!.items, seed] },
      },
      {
        code: 'boundary.tapUnsupported',
        tap: 'latent_image',
        schema: innerSchemas.KSampler!,
      },
      {
        code: 'boundary.tapUnsupported',
        tap: 'seed',
        schema: {
          ...innerSchemas.KSampler!,
          items: [{
            ...seed,
            dynamic: {
              kind: 'autogrow',
              template: [seed],
              naming: { kind: 'prefix', prefix: 'seed' },
            },
          }],
        },
      },
    ] as const
    for (const { code, tap, schema: malformedSchema } of malformed) {
      const malformedDef = asDef({
        ...tapped,
        boundary: {
          inputs: [],
          outputs: [{ id: 'invalid', binds: { kind: 'widgetTap', node: 'n0', tap } }],
        },
      })
      const result = deriveBoundarySchema(malformedDef, () => malformedSchema as NodeSchema)
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }))
    }
  })

  it('aggregates emitsPreviews from any inner node, nested instances included', () => {
    const flagged: SchemaResolver = (type) =>
      type === 'KSampler' ? { ...innerSchemas['KSampler']!, emitsPreviews: true } : innerSchemas[type]
    const direct = deriveBoundarySchema(def, flagged)
    expect(direct.schema!.emitsPreviews).toBe(true)

    // A nested instance whose derived schema carries the flag propagates it.
    const outer = asDef({
      id: 'g2',
      name: 'outer',
      nodes: { inst: { id: 'inst', type: '#g1', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: { inputs: [], outputs: [] },
    })
    const nested = deriveBoundarySchema(outer, (type) => type === '#g1' ? direct.schema : flagged(type))
    expect(nested.schema!.emitsPreviews).toBe(true)
    expect(deriveBoundarySchema(outer, (type) => type === '#g1' ? schema : resolve(type)).schema!.emitsPreviews)
      .toBeUndefined()
  })

  it('aggregates mayExpandGraph from nested instances', () => {
    const flagged: SchemaResolver = (type) =>
      type === 'KSampler' ? { ...innerSchemas['KSampler']!, mayExpandGraph: true } : innerSchemas[type]
    const direct = deriveBoundarySchema(def, flagged)
    expect(direct.schema!.mayExpandGraph).toBe(true)

    const outer = asDef({
      id: 'g2',
      name: 'outer',
      nodes: { inst: { id: 'inst', type: '#g1', values: {} } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: { inputs: [], outputs: [] },
    })
    const nested = deriveBoundarySchema(outer, (type) => type === '#g1' ? direct.schema : flagged(type))
    expect(nested.schema!.mayExpandGraph).toBe(true)
    expect(deriveBoundarySchema(outer, (type) => type === '#g1' ? schema : resolve(type)).schema!.mayExpandGraph)
      .toBeUndefined()
  })
})

describe('widget promotion vs socket-only', () => {
  const def = (promoted: boolean): GraphDef => asDef({
    id: 'gX',
    name: 'x',
    nodes: {
      n0: { id: 'n0', type: 'KSampler', values: { seed: 5 } },
    },
    links: {},
    nets: {},
    boundary: {
      inputs: [{ id: 'seed', binds: { kind: 'port', node: 'n0', port: 'seed' }, ...(promoted ? { promoted: true } : {}) } as never],
      outputs: [],
    },
    nextOrdinal: 1,
  })

  it('non-promoted widget-backed inputs become forced sockets, still optional', () => {
    const { schema } = deriveBoundarySchema(def(false), resolve)
    const seed = inputsOf(schema!)[0]!
    expect(seed.widget).toBeUndefined()
    expect(seed.forceInput).toBe(true)
    expect(seed.optional).toBe(true) // inner stored value applies when unconnected
  })

  it.each([false, true])('inherits authored editable menus at the promoted scope, nested=%s', (nested) => {
    for (const choices of [[], [false, 0, 'same', 'same']]) {
      const menu = { kind: 'input' as const, id: 'choice', type: { kind: 'concrete' as const, name: 'COMBO' }, optional: false,
        widget: { widgetType: 'COMBO', editableOptions: true as const, options: { options: ['schema'] } } }
      const inner: NodeSchema = { type: 'Menu', displayName: 'Menu', category: 'test', source: 'v3', isOutputNode: false,
        items: nested ? [{ kind: 'input', id: 'items', type: menu.type, optional: false,
          dynamic: { kind: 'autogrow', template: [menu], naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 } } }] : [menu] }
      const graph = asDef({ id: 'sub', name: 'sub', nodes: { n0: {
        id: 'n0', type: 'Menu', values: { choice: 'outside' },
        dynamic: nested ? { items: { members: ['m0', 'm1'], memberState: {
          m0: { 'items.choice': { options: ['sibling'] } }, m1: { 'items.choice': { options: choices } },
        } } } : { choice: { options: choices } },
      } }, links: {}, nets: {}, nextOrdinal: 1, boundary: { inputs: [{ id: 'menu', promoted: true,
        binds: { kind: 'port', node: 'n0', port: nested ? 'items.choice' : 'choice', ...(nested ? { members: ['m1'] } : {}) },
      }], outputs: [] } })
      const before = JSON.stringify(graph)
      const { schema, diagnostics } = deriveBoundarySchema(graph, (type) => type === inner.type ? inner : undefined)
      expect(diagnostics.filter((item) => item.severity === 'error')).toEqual([])
      expect(inputsOf(schema!)[0]!.widget!.options.options).toEqual(choices)
      const instance = { values: { menu: 'outside' }, dynamic: { menu: { options: ['override'] } } }
      expect(elabInputsOf(elaborateInterface(schema!, instance))[0]!.spec.widget!.options.options).toEqual(['override'])
      expect(instance.values).toEqual({ menu: 'outside' })
      expect(JSON.stringify(graph)).toBe(before)
    }
  })
})

describe('type variables cross the boundary', () => {
  const def: GraphDef = asDef({
    id: 'gT',
    name: 'generic',
    nodes: {
      n0: { id: 'n0', type: 'ImpactSwitch', values: { select: 1 } },
      n1: { id: 'n1', type: 'ImpactSwitch', values: { select: 1 } },
    },
    links: {},
    nets: {},
    boundary: {
      // Family members bind via the stamped slot path ('<family>.<slotId>')
      // plus the member id - the derived port carries the template slot.
      inputs: [
        { id: 'a', binds: { kind: 'port', node: 'n0', port: 'input.input', members: ['m0'] } },
        { id: 'b', binds: { kind: 'port', node: 'n1', port: 'input.input', members: ['m0'] } },
      ],
      outputs: [
        { id: 'outA', binds: { kind: 'port', node: 'n0', port: 'out0' } },
        { id: 'outB', binds: { kind: 'port', node: 'n1', port: 'out0' } },
      ],
    },
    nextOrdinal: 2,
  })
  const { schema, diagnostics } = deriveBoundarySchema(def, resolve)

  it('keeps one inner node\'s template shared between its boundary ports', () => {
    const a = inputsOf(schema!).find((i) => i.id === 'a')!
    const outA = outputsOf(schema!).find((o) => o.id === 'outA')!
    expect(a.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(outA.type).toEqual(a.type) // solving outA's type solves a's
  })

  it('keeps unrelated inner templates distinct', () => {
    const a = inputsOf(schema!).find((i) => i.id === 'a')!
    const b = inputsOf(schema!).find((i) => i.id === 'b')!
    expect(a.type).not.toEqual(b.type)
    expect(b.type).toEqual({ kind: 'variable', templateId: 'n1:T' })
  })
})

describe('whole-family forwarding derives boundary autogrow families', () => {
  const defWith = (
    nodes: Record<string, unknown>,
    inputs: readonly unknown[],
    outputs: readonly unknown[] = [],
  ): GraphDef =>
    asDef({
      id: 'gW',
      name: 'fwd',
      nodes,
      links: {},
      nets: {},
      boundary: { inputs, outputs },
      nextOrdinal: 1,
    })

  const inputItem = (schema: NodeSchema, id: string) => inputsOf(schema).find((i) => i.id === id)!
  const outputItem = (schema: NodeSchema, id: string) => outputsOf(schema).find((o) => o.id === id)!

  it.each([0, 1, 2])('preserves positional requiredness through a forwarded prefix of %s', (prefix) => {
    const inner = parseDinksterSchema('Positional', { interface: [{
      role: 'inputFamily', id: 'items', minMembers: 2, maxMembers: 4,
      memberPrefix: 'item', optionalAfterMinimum: true,
      template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['IMAGE'] }, required: true }],
    }] }).schema!
    const def = defWith({ n0: { id: 'n0', type: 'Positional', values: {}, dynamic: {
      items: { members: Array.from({ length: prefix }, (_, index) => `item${index}`) },
    } } }, [{ id: 'pics', binds: { kind: 'family', node: 'n0', port: 'items' } }])
    const result = deriveBoundarySchema(def, () => inner)
    expect(result.diagnostics).toEqual([])
    expect(inputItem(result.schema!, 'pics').dynamic).toMatchObject({ optionalAfterMinimum: true, materialization: 'wire15' })
    const inputs = elabInputsOf(elaborateInterface(result.schema!, {
      values: {}, dynamic: { pics: { members: ['item2'] } },
    })).filter((input) => input.origin.kind !== 'member' || !input.origin.ghost)
    expect(inputs.map((input) => [input.apiName, input.spec.optional])).toEqual(
      Array.from({ length: 3 - prefix }, (_, index) => [`pics.item${prefix + index}`, prefix + index >= 2]),
    )
  })

  it('forwards a top-level input family with a recursively freshened template', () => {
    const def = defWith({ n0: { id: 'n0', type: 'ImpactSwitch', values: {} } }, [
      { id: 'pics', binds: { kind: 'family', node: 'n0', port: 'input' } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const pics = inputItem(schema!, 'pics')
    // The declaring slot's type variable is namespaced by inner node id, so
    // the boundary family shares dynamic typing with the inner one.
    expect(pics.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(pics.dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'input', max: 10 },
    })
    expect(pics.dynamic).not.toHaveProperty('ordinalOffset')
    const spec = pics.dynamic as Extract<NonNullable<typeof pics.dynamic>, { kind: 'autogrow' }>
    expect(spec.template).toHaveLength(1)
    expect(spec.template[0]!.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
  })

  it('definition prefix members reduce capacity and set the ordinal offset', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'ImpactSwitch', values: {}, dynamic: { input: { members: ['m0', 'm1'] } } } },
      [{ id: 'pics', binds: { kind: 'family', node: 'n0', port: 'input' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'pics').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'input', max: 8 },
      ordinalOffset: 2,
    })
  })

  it('definition prefix satisfies the family minimum for instances', () => {
    // Stack 'items' has min 1: with no prefix the derived family keeps
    // min 1; one definition-local member satisfies it, so instances owe 0.
    const bare = defWith({ n0: { id: 'n0', type: 'Stack', values: {} } }, [
      { id: 'stack', binds: { kind: 'family', node: 'n0', port: 'items' } },
    ])
    const bareSchema = deriveBoundarySchema(bare, resolve).schema!
    expect(inputItem(bareSchema, 'stack').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'item', min: 1, max: 5 },
    })

    const seeded = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'] } } } },
      [{ id: 'stack', binds: { kind: 'family', node: 'n0', port: 'items' } }],
    )
    const seededSchema = deriveBoundarySchema(seeded, resolve).schema!
    const seededSpec = inputItem(seededSchema, 'stack').dynamic
    expect(seededSpec).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'item', max: 4 }, ordinalOffset: 1 })
    expect((seededSpec as Extract<NonNullable<typeof seededSpec>, { kind: 'autogrow' }>).naming).not.toHaveProperty('min')
  })

  it('names-list forwarding slices the remaining names', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'NamedGrow', values: {}, dynamic: { ins: { members: ['m0'] } } } },
      [{ id: 'more', binds: { kind: 'family', node: 'n0', port: 'ins' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'more').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'names', names: ['b', 'c'], min: 1 },
      ordinalOffset: 1,
    })
  })

  it('forwards an output family, carrying isList from the top-level item', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'MultiOut', values: {} } },
      [{ id: 'src', binds: { kind: 'port', node: 'n0', port: 'src' } }],
      [{ id: 'outs', binds: { kind: 'family', node: 'n0', port: 'outs' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const outs = outputItem(schema!, 'outs')
    expect(outs.isList).toBe(true)
    expect(outs.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(outs.dynamic).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'out', max: 6 } })
    // Both boundary items bind n0, so its 'T' stays shared across them.
    expect(inputItem(schema!, 'src').type).toEqual({ kind: 'variable', templateId: 'n0:T' })
  })

  it('projects a count-bound output family with a fixed definition count', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'CountOut', values: { count: 3 } } },
      [],
      [{ id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const pictures = outputItem(schema!, 'pictures')
    expect(pictures.dynamic).toMatchObject({
      kind: 'autogrow',
      count: {
        input: 'count',
        suffix: 'index',
        boundaryProjection: { fallback: 3, fixed: true },
      },
    })
    expect(outputCountInputsOf(schema!)).toEqual([])
    expect(elaborateInterface(schema!, { values: {} }).outputMembers).toEqual({ pictures: ['0', '1', '2'] })
  })

  it('projects a promoted output count as occurrence-local instance state', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'CountOut', values: { count: 3 } } },
      [{ id: 'amount', binds: { kind: 'port', node: 'n0', port: 'count' }, promoted: true }],
      [{ id: 'pictures', binds: { kind: 'family', node: 'n0', port: 'images' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(outputItem(schema!, 'pictures').dynamic).toMatchObject({
      count: {
        input: 'amount',
        suffix: 'index',
        boundaryProjection: { fallback: 3 },
      },
    })
    expect(outputCountInputsOf(schema!)).toEqual(['amount'])
    expect(elaborateInterface(schema!, { values: { amount: 2 } }).outputMembers).toEqual({ pictures: ['0', '1'] })
    expect(elaborateInterface(schema!, { values: {} }).outputMembers).toEqual({ pictures: ['0', '1', '2'] })
    const invalid = elaborateInterface(schema!, { values: { amount: null } })
    expect(invalid.outputMembers).toBeUndefined()
    expect(invalid.diagnostics).toContainEqual(expect.objectContaining({ code: 'elab.outputFamily.badCount' }))
  })

  it('forwards a nested family through an enclosing concrete member path', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'] } } } },
      [{ id: 'subs', binds: { kind: 'family', node: 'n0', port: 'items.sub', members: ['m0'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const subs = inputItem(schema!, 'subs')
    expect(subs.dynamic).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'sub', max: 4 } })
    expect(subs.dynamic).not.toHaveProperty('ordinalOffset')
    const spec = subs.dynamic as Extract<NonNullable<typeof subs.dynamic>, { kind: 'autogrow' }>
    expect(spec.template[0]!.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
  })

  it('nested definition prefix state scopes to the crossed member (hazard N4)', () => {
    // Member m0 holds one 'sub' member; sibling m1 holds two. Forwarding
    // m0's family must see prefix 1, never m1's state.
    const def = defWith(
      {
        n0: {
          id: 'n0',
          type: 'Stack',
          values: {},
          dynamic: {
            items: {
              members: ['m0', 'm1'],
              memberState: {
                m0: { 'items.sub': { members: ['s0'] } },
                m1: { 'items.sub': { members: ['x0', 'x1'] } },
              },
            },
          },
        },
      },
      [{ id: 'subs', binds: { kind: 'family', node: 'n0', port: 'items.sub', members: ['m0'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(inputItem(schema!, 'subs').dynamic).toMatchObject({
      kind: 'autogrow',
      naming: { kind: 'prefix', prefix: 'sub', max: 3 },
      ordinalOffset: 1,
    })
  })

  it('concrete nested member binding (depth 2) derives a plain port', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'], memberState: { m0: { 'items.sub': { members: ['s0'] } } } } } } },
      [{ id: 'w', binds: { kind: 'port', node: 'n0', port: 'items.sub.w', members: ['m0', 's0'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const w = inputItem(schema!, 'w')
    expect(w.type).toEqual({ kind: 'variable', templateId: 'n0:T' })
    expect(w.dynamic).toBeUndefined()
  })

  it('widget promotion works on a nested member slot', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['m0'] } } } },
      [{ id: 'label', binds: { kind: 'port', node: 'n0', port: 'items.name', members: ['m0'] }, promoted: true }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const label = inputItem(schema!, 'label')
    expect(label.widget).toEqual({ widgetType: 'STRING', options: {} })
    expect(label.optional).toBe(true)
  })

  // Chained forwarding: forwarding an ALREADY-DERIVED '#def' schema whose
  // family carries a sliced names list / ordinalOffset must compose - offset
  // additive, names re-sliced, bounds re-reduced. Load-bearing for nested
  // subgraphs (hazard F4).

})

describe('boundary structural identity and presentation', () => {
  it('promotes the selected materialized combo branch without exposing inactive inputs', () => {
    const schema: NodeSchema = {
      type: 'Resize', displayName: 'Resize', category: 'test', source: 'v3', isOutputNode: false,
      items: [{ kind: 'input', id: 'mode', type: { kind: 'concrete', name: 'COMBO' }, optional: false,
        dynamic: { kind: 'dynamicCombo', materialization: 'wire15', options: [
          { key: 'width', inputs: [{ kind: 'input', id: 'width', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {}, default: 512 } }] },
          { key: 'longer', inputs: [{ kind: 'input', id: 'longer_size', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {}, default: 512 } }] },
        ] },
      }],
    }
    const def = asDef({
      id: 'gResize', name: 'Resize', links: {}, nets: {}, nextOrdinal: 1,
      nodes: { n0: { id: 'n0', type: 'Resize', values: { 'mode.longer_size': 1024 }, dynamic: { mode: { selected: 'longer' } } } },
      boundary: { inputs: [{ id: 'size', binds: { kind: 'port', node: 'n0', port: 'mode.longer_size' }, promoted: true }], outputs: [] },
    })
    const result = deriveBoundarySchema(def, () => schema)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)).toEqual([expect.objectContaining({
      id: 'size', type: { kind: 'concrete', name: 'INT' }, widget: expect.objectContaining({ default: 1024 }),
    })])
    expect(resolveBoundaryRoute(schema, { kind: 'port', node: 'n0' as never, port: 'mode.width' as never }, 'input', {}, def.nodes['n0']!.dynamic))
      .toMatchObject({ ok: false, code: 'boundary.unknownPort' })
  })

  it('resolves same-id input and output ports by the boundary side', () => {
    const schema: NodeSchema = {
      type: 'dinkster.float',
      displayName: 'Float',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'value',
          type: { kind: 'concrete', name: 'FLOAT' },
          optional: false,
          widget: { widgetType: 'NUMBER', options: { step: 0.1 }, default: 0 },
        },
        { kind: 'output', id: 'value', type: { kind: 'concrete', name: 'FLOAT' } },
      ],
    }
    const binding = { kind: 'port' as const, node: 'n0' as never, port: 'value' as never }
    const def = asDef({
      id: 'gSameId',
      name: 'same id',
      nodes: { n0: { id: 'n0', type: schema.type, values: {} } },
      links: {},
      nets: {},
      boundary: {
        inputs: [{ id: 'in', binds: binding }],
        outputs: [{ id: 'out', binds: binding }],
      },
      nextOrdinal: 1,
    })

    const result = deriveBoundarySchema(def, (type) => type === schema.type ? schema : undefined)

    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)).toEqual([expect.objectContaining({ id: 'in', kind: 'input' })])
    expect(outputsOf(result.schema!)).toEqual([expect.objectContaining({ id: 'out', kind: 'output' })])
  })

  it('prefers the bound schema label without changing a dotted boundary id', () => {
    const def = asDef({
      id: 'gIdentity',
      name: 'identity',
      nodes: { n0: { id: 'n0', type: 'KSampler', values: {} } },
      links: {},
      nets: {},
      boundary: {
        inputs: [{ id: 'images.images_m0', binds: { kind: 'port', node: 'n0', port: 'latent_image' } }],
        outputs: [],
      },
      nextOrdinal: 1,
    })

    const result = deriveBoundarySchema(def, resolve)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]).toMatchObject({
      id: 'images.images_m0',
      displayName: 'Latent',
    })
  })
})

describe('slot-selective forwarding (binds.slots, hazard F10)', () => {
  const img = { kind: 'concrete', name: 'IMAGE' } as const
  const mask = { kind: 'concrete', name: 'MASK' } as const
  const localSchemas: Record<string, NodeSchema> = {
    // Grouped template: required socket-only 'image', optional 'mask',
    // required-but-widget-backed 'label'.
    Pair: {
      type: 'Pair',
      displayName: 'Pair',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'pairs',
          type: img,
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'image', type: img, optional: false },
              { kind: 'input', id: 'mask', type: mask, optional: true },
              { kind: 'input', id: 'label', type: { kind: 'concrete', name: 'STRING' }, optional: false, widget: { widgetType: 'STRING', options: {} } },
            ],
            naming: { kind: 'prefix', prefix: 'pair', max: 6 },
          },
        },
        { kind: 'output', id: 'out0', type: img },
      ],
    },
    // Grouped template whose 'req' slot is a min-1 nested autogrow holding a
    // required socket-only slot: omitting 'req' starves min-filled members.
    NestReq: {
      type: 'NestReq',
      displayName: 'Nest Req',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'groups',
          type: img,
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'tag', type: { kind: 'concrete', name: 'STRING' }, optional: true, widget: { widgetType: 'STRING', options: {} } },
              {
                kind: 'input',
                id: 'req',
                type: img,
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  template: [{ kind: 'input', id: 'x', type: img, optional: false }],
                  naming: { kind: 'prefix', prefix: 'r', min: 1, max: 3 },
                },
              },
            ],
            naming: { kind: 'prefix', prefix: 'g', max: 4 },
          },
        },
      ],
    },
    // Grouped template with a THREE-slot min-0 nested autogrow for nested
    // (dotted) selection: optional 's'/'t' and required socket-only 'r'.
    NestSel: {
      type: 'NestSel',
      displayName: 'Nest Sel',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        {
          kind: 'input',
          id: 'groups',
          type: img,
          optional: false,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'tag', type: { kind: 'concrete', name: 'STRING' }, optional: true, widget: { widgetType: 'STRING', options: {} } },
              {
                kind: 'input',
                id: 'sub',
                type: img,
                optional: true,
                dynamic: {
                  kind: 'autogrow',
                  template: [
                    { kind: 'input', id: 's', type: img, optional: true },
                    { kind: 'input', id: 't', type: mask, optional: true },
                    { kind: 'input', id: 'r', type: img, optional: false },
                  ],
                  naming: { kind: 'prefix', prefix: 'k', max: 3 },
                },
              },
            ],
            naming: { kind: 'prefix', prefix: 'g', max: 4 },
          },
        },
      ],
    },
    // Grouped OUTPUT family: starvation checks are input-side only.
    OutPair: {
      type: 'OutPair',
      displayName: 'Out Pair',
      category: 'util',
      source: 'v3',
      isOutputNode: false,
      items: [
        { kind: 'input', id: 'src', type: img, optional: false },
        {
          kind: 'output',
          id: 'outs',
          type: img,
          dynamic: {
            kind: 'autogrow',
            template: [
              { kind: 'input', id: 'main', type: img, optional: false },
              { kind: 'input', id: 'aux', type: mask, optional: true },
            ],
            naming: { kind: 'prefix', prefix: 'o', max: 4 },
          },
        },
      ],
    },
  }
  const resolveLocal: SchemaResolver = (t) => localSchemas[t] ?? innerSchemas[t]

  const defWith = (nodes: Record<string, unknown>, inputs: readonly unknown[], outputs: readonly unknown[] = []): GraphDef =>
    asDef({ id: 'gS', name: 'sel', nodes, links: {}, nets: {}, boundary: { inputs, outputs }, nextOrdinal: 1 })
  const pairNode = (dynamic?: unknown) => ({ n0: { id: 'n0', type: 'Pair', values: {}, ...(dynamic ? { dynamic } : {}) } })
  const specOf = (schema: NodeSchema, id: string) => {
    const item = [...inputsOf(schema), ...outputsOf(schema)].find((i) => i.id === id)!
    return item.dynamic as Extract<NonNullable<typeof item.dynamic>, { kind: 'autogrow' }>
  }

  it('filters the derived template in TEMPLATE order, not listing order', () => {
    const def = defWith(pairNode(), [
      { id: 'p', binds: { kind: 'family', node: 'n0', port: 'pairs', slots: ['label', 'image'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'p').template.map((s) => s.id)).toEqual(['image', 'label'])
  })

  it('selecting the nested autogrow slot forwards it whole, widget-backed sibling omitted', () => {
    const def = defWith({ n0: { id: 'n0', type: 'NestReq', values: {} } }, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['req'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const template = specOf(schema!, 'g').template
    expect(template.map((s) => s.id)).toEqual(['req'])
    expect(template[0]!.dynamic).toMatchObject({ kind: 'autogrow', naming: { kind: 'prefix', prefix: 'r' } })
  })

  it('output families select symmetrically without starvation checks', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'OutPair', values: {} } },
      [],
      [{ id: 'o', binds: { kind: 'family', node: 'n0', port: 'outs', slots: ['aux'] } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(specOf(schema!, 'o').template.map((s) => s.id)).toEqual(['aux'])
  })

  const nestSelNode = { n0: { id: 'n0', type: 'NestSel', values: {} } }

  it('a dotted path narrows a nested autogrow construct, in TEMPLATE order at both levels', () => {
    const def = defWith(nestSelNode, [
      { id: 'g', binds: { kind: 'family', node: 'n0', port: 'groups', slots: ['sub.r', 'sub.s', 'tag'] } },
    ])
    const { schema, diagnostics } = deriveBoundarySchema(def, resolveLocal)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const template = specOf(schema!, 'g').template
    expect(template.map((s) => s.id)).toEqual(['tag', 'sub'])
    const nested = template[1]!.dynamic as Extract<NonNullable<(typeof template)[1]['dynamic']>, { kind: 'autogrow' }>
    expect(nested.template.map((s) => s.id)).toEqual(['s', 'r'])
    // Narrowing filters the nested template ONLY - capacity and naming stay.
    expect(nested.naming).toMatchObject({ kind: 'prefix', prefix: 'k', max: 3 })
  })

})

describe('dynamicSlot boundary bindings', () => {
  const specializedDef = (options: { selected?: boolean; connected?: boolean; two?: boolean } = {}): GraphDef => {
    const ids = options.two ? ['a', 'b'] : ['a']
    return asDef({
      id: 'gSlot', name: 'slots',
      nodes: Object.fromEntries([
        ['src', { id: 'src', type: 'KSampler', values: {} }],
        ...ids.map((id) => [id, {
          id, type: 'SpecializedSlotNode', values: {},
          dynamic: { model: options.selected === false ? {} : { selected: 'special' } },
        }]),
      ]),
      links: options.connected === false ? {} : Object.fromEntries(ids.map((id) => [`link-${id}`, {
        id: `link-${id}`, from: { node: 'src', port: 'out0' }, to: { node: id, port: 'model' },
      }])),
      nets: {},
      boundary: {
        inputs: ids.map((id) => ({ id, binds: { kind: 'port', node: id, port: 'model.[special].strength' } })),
        outputs: [],
      },
      nextOrdinal: 3,
    })
  }

  it('projects a selected slot type through dependent inputs and matched outputs', () => {
    const result = deriveBoundarySchema(asDef({
      id: 'gMatched', name: 'matched slot',
      nodes: {
        src: { id: 'src', type: 'VAEDecode', values: {} },
        matched: { id: 'matched', type: 'MatchedSlotNode', values: {}, dynamic: { source: { selected: 'image' } } },
      },
      links: {
        source: { id: 'source', from: { node: 'src', port: 'out0' }, to: { node: 'matched', port: 'source' } },
      },
      nets: {},
      boundary: {
        inputs: [{ id: 'copy', binds: { kind: 'port', node: 'matched', port: 'source.[image].copy' } }],
        outputs: [
          { id: 'out', binds: { kind: 'port', node: 'matched', port: 'out' } },
          { id: 'batch', binds: { kind: 'port', node: 'matched', port: 'batch' } },
        ],
      },
      nextOrdinal: 2,
    }), resolve)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]!.type).toEqual({ kind: 'concrete', name: 'IMAGE' })
    expect(outputsOf(result.schema!).map((output) => output.type)).toEqual([
      { kind: 'concrete', name: 'IMAGE' },
      { kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } },
    ])
  })

  it('binds a selected variant dependent when its slot is connected inside the definition', () => {
    const result = deriveBoundarySchema(specializedDef(), resolve)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]).toMatchObject({ id: 'a', type: { kind: 'variable', templateId: 'a:V' }, optional: false })
  })

})

describe('derivation failures produce diagnostics, never partial schemas', () => {
  const base: GraphDef = asDef({
    id: 'gE',
    name: 'bad',
    nodes: { n0: { id: 'n0', type: 'KSampler', values: {} } },
    links: {},
    nets: {},
    boundary: { inputs: [], outputs: [] },
    nextOrdinal: 1,
  })

  it('forwards a dynamicCombo selector with empty branch templates', () => {
    const result = deriveBoundarySchema(asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: 'ComboNode', values: {} } },
      boundary: { inputs: [{ id: 'mode', binds: { kind: 'port', node: 'n0', port: 'mode' } }], outputs: [] },
    }), resolve)
    expect(result.diagnostics).toEqual([{ severity: 'warning', origin: 'schema', code: 'boundary.selectorOnly', message: 'gE.mode: selector forwarding does not include branch inputs', refs: [{ graphId: 'gE', portId: 'mode', direction: 'input' }] }])
    const input = result.schema?.items[0]
    expect(input?.kind).toBe('input')
    if (input?.kind !== 'input') return
    expect(input.dynamic).toEqual({ kind: 'dynamicCombo', options: [{ key: 'a', inputs: [] }], defaultOption: 'a' })
  })

  it('binds a concrete input beneath the active combo branch', () => {
    const result = deriveBoundarySchema(asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: 'ComboNode', values: {} } },
      boundary: { inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'mode.[a].x' } }], outputs: [] },
    }), resolve)
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.items[0]).toMatchObject({ kind: 'input', id: 'x', optional: false })
  })

  it('nested subgraph instance types resolve through the resolver', () => {
    const nested: GraphDef = asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: '#gInner', values: {} } },
      boundary: { inputs: [], outputs: [] },
    })
    const resolveNested: SchemaResolver = (t) =>
      t === '#gInner'
        ? {
            type: '#gInner',
            displayName: 'inner',
            category: 'subgraph',
            source: 'subgraph',
            isOutputNode: true,
            items: [],
          }
        : innerSchemas[t]
    const { schema } = deriveBoundarySchema(nested, resolveNested)
    // Output-node status propagates through nested instances.
    expect(schema!.isOutputNode).toBe(true)
  })
})
