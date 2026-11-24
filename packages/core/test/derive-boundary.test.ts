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
import { deriveBoundarySchema, type SchemaResolver } from '../src/schema/derive-boundary.js'
import { elaborateInterface, elabInputsOf } from '../src/schema/elaborate.js'
import { inputsOf, outputsOf, type GroupSpec, type NodeSchema } from '../src/schema/model.js'
import { MAX_GROUP_MEMBERS, memberLimitOf } from '../src/schema/body.js'

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
    body: [
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
    body: [
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
    body: [
      {
        kind: 'input',
        id: 'select',
        type: { kind: 'concrete', name: 'INT' },
        optional: false,
        widget: { widgetType: 'INT', options: {} },
      },
      {
        kind: 'group',
        id: 'input',
        value: { kind: 'input', id: 'input', type: { kind: 'variable', templateId: 'T' }, optional: true },
        keys: { kind: 'numbered', prefix: 'input', start: 0, pad: 0 },
        grows: 'link',
        minMembers: 0,
      },
      { kind: 'output', id: 'out0', type: { kind: 'variable', templateId: 'T' } },
    ],
  },
  // Nested groups: group 'items' whose member rows hold a widget field and
  // a NESTED group 'sub' (a group inside a group).
  Stack: {
    type: 'Stack',
    displayName: 'Stack',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    body: [
      {
        kind: 'group',
        id: 'items',
        member: [
          {
            kind: 'input',
            id: 'name',
            type: { kind: 'concrete', name: 'STRING' },
            optional: true,
            widget: { widgetType: 'STRING', options: {} },
          },
          {
            kind: 'group',
            id: 'sub',
            value: { kind: 'input', id: 'w', type: { kind: 'variable', templateId: 'T' }, optional: true },
            keys: { kind: 'numbered', prefix: 'sub', start: 0, pad: 0 },
            grows: 'link',
            minMembers: 0,
            maxMembers: 4,
          },
        ],
        keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
        grows: 'button',
        minMembers: 1,
        maxMembers: 5,
      },
      { kind: 'output', id: 'out0', type: { kind: 'variable', templateId: 'T' } },
    ],
  },
  ComboNode: {
    type: 'ComboNode',
    displayName: 'Combo',
    category: 'util',
    source: 'v3',
    isOutputNode: false,
    body: [
      {
        kind: 'choice',
        id: 'mode',
        required: true,
        shared: [],
        options: [
          { key: 'a', rows: [{ kind: 'input', id: 'x', type: { kind: 'concrete', name: 'INT' }, optional: false }] },
        ],
      },
    ],
  },
  SpecializedSlotNode: {
    type: 'SpecializedSlotNode', displayName: 'Specialized slot', category: 'util', source: 'v3', isOutputNode: false,
    body: [{
      kind: 'typeChoice', id: 'model', required: false, rows: [],
      variants: [{
        key: 'special', type: { kind: 'variable', templateId: 'V' },
        rows: [{ kind: 'input', id: 'strength', type: { kind: 'variable', templateId: 'V' }, optional: false }],
      }],
    }],
  },
  MatchedSlotNode: {
    type: 'MatchedSlotNode', displayName: 'Matched slot', category: 'util', source: 'v3', isOutputNode: false,
    body: [
      {
        kind: 'typeChoice', id: 'source', required: true, rows: [], typeVariable: 'T',
        variants: [
          {
            key: 'image', type: { kind: 'concrete', name: 'IMAGE' },
            rows: [{ kind: 'input', id: 'copy', type: { kind: 'variable', templateId: 'T' }, optional: false }],
          },
          { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, rows: [] },
        ],
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

  it('derives a widget output from one exact widget-backed input and fails closed otherwise', () => {
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

    const seed = innerSchemas.KSampler!.body[0]!
    const malformed = [
      {
        code: 'boundary.tapUnsupported',
        tap: 'latent_image',
        schema: innerSchemas.KSampler!,
      },
      {
        // A group is not an input, so a tap naming it finds no input.
        code: 'boundary.tapMissing',
        tap: 'seed',
        schema: {
          ...innerSchemas.KSampler!,
          body: [{
            kind: 'group',
            id: 'seed',
            value: seed,
            keys: { kind: 'numbered', prefix: 'seed', start: 0, pad: 0 },
            grows: 'filled',
            minMembers: 0,
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

  it("derives a widget output from a member field's output while the member is stored", () => {
    const seed = innerSchemas.KSampler!.body[0]!
    const grouped = { ...innerSchemas.KSampler!, body: [{
      kind: 'group', id: 'seeds', value: seed, keys: { kind: 'numbered', prefix: 'seed', start: 0, pad: 0 }, grows: 'hand', minMembers: 0,
    }] } as unknown as NodeSchema
    const withMembers = (members: string[]) => asDef({
      ...def,
      nodes: { ...def.nodes, n0: { ...def.nodes.n0!, dynamic: { seeds: { members } } } },
      boundary: { inputs: [], outputs: [{ id: 'second', binds: { kind: 'widgetTap', node: 'n0', tap: 'seeds.seed1' } }] },
    })
    const valid = deriveBoundarySchema(withMembers(['seed0', 'seed1']), () => grouped)
    expect(valid.diagnostics).toEqual([])
    expect(outputsOf(valid.schema!)).toEqual([expect.objectContaining({ id: 'second', type: { kind: 'concrete', name: 'INT' } })])
    const removed = deriveBoundarySchema(withMembers(['seed0']), () => grouped)
    expect(removed.diagnostics).toContainEqual(expect.objectContaining({ code: 'boundary.tapMissing' }))
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
        body: nested ? [{ kind: 'group', id: 'items', value: menu, keys: { kind: 'numbered', prefix: 'item', start: 0, pad: 0 },
          grows: 'filled', minMembers: 0, maxMembers: 4 }] : [menu] }
      const graph = asDef({ id: 'sub', name: 'sub', nodes: { n0: {
        id: 'n0', type: 'Menu', values: { choice: 'outside' },
        dynamic: nested ? {
          items: { members: ['item0', 'item1'] },
          'items.item0': { options: ['sibling'] }, 'items.item1': { options: choices },
        } : { choice: { options: choices } },
      } }, links: {}, nets: {}, nextOrdinal: 1, boundary: { inputs: [{ id: 'menu', promoted: true,
        binds: { kind: 'port', node: 'n0', port: nested ? 'items.item1' : 'choice' },
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
      n0: { id: 'n0', type: 'ImpactSwitch', values: { select: 1 }, dynamic: { input: { members: ['input0'] } } },
      n1: { id: 'n1', type: 'ImpactSwitch', values: { select: 1 }, dynamic: { input: { members: ['input0'] } } },
    },
    links: {},
    nets: {},
    boundary: {
      // Group members bind by flattened id ('<group>.<key>'); the derived
      // port carries the member's type.
      inputs: [
        { id: 'a', binds: { kind: 'port', node: 'n0', port: 'input.input0' } },
        { id: 'b', binds: { kind: 'port', node: 'n1', port: 'input.input0' } },
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

describe('group member forwarding', () => {
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

  it('concrete nested member binding (depth 2) derives a plain port', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['item0'] }, 'items.item0.sub': { members: ['sub0'] } } } },
      [{ id: 'w', binds: { kind: 'port', node: 'n0', port: 'items.item0.sub.sub0' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const w = inputItem(schema!, 'w')
    expect(w).toMatchObject({ kind: 'input', type: { kind: 'variable', templateId: 'n0:T' } })
  })

  it('widget promotion works on a nested member slot', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['item0'] } } } },
      [{ id: 'label', binds: { kind: 'port', node: 'n0', port: 'items.item0.name' }, promoted: true }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const label = inputItem(schema!, 'label')
    expect(label.widget).toEqual({ widgetType: 'STRING', options: {} })
    expect(label.optional).toBe(true)
  })
})

describe('boundary structural identity and presentation', () => {
  it('promotes the selected choice option row without exposing inactive rows', () => {
    const schema: NodeSchema = {
      type: 'Resize', displayName: 'Resize', category: 'test', source: 'v3', isOutputNode: false,
      body: [{ kind: 'choice', id: 'mode', required: true, shared: [], options: [
        { key: 'width', rows: [{ kind: 'input', id: 'width', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {}, default: 512 } }] },
        { key: 'longer', rows: [{ kind: 'input', id: 'longer_size', type: { kind: 'concrete', name: 'INT' }, optional: false, widget: { widgetType: 'INT', options: {}, default: 512 } }] },
      ] }],
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
    const inactive = deriveBoundarySchema(asDef({
      ...def,
      boundary: { inputs: [{ id: 'size', binds: { kind: 'port', node: 'n0', port: 'mode.width' }, promoted: true }], outputs: [] },
    }), () => schema)
    expect(inactive.schema).toBeUndefined()
    expect(inactive.diagnostics).toContainEqual(expect.objectContaining({ code: 'boundary.branchInactive' }))
  })

  it('resolves same-id input and output ports by the boundary side', () => {
    const schema: NodeSchema = {
      type: 'dinkster.float',
      displayName: 'Float',
      category: 'test',
      source: 'v3',
      isOutputNode: false,
      body: [
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

  it('preserves exact binding ids and explicit names on both sides without collision numbering', () => {
    const labels = [
      { id: 'positive_prompt' },
      { id: 'masks_m4' },
      { id: 'nested_cfg', displayName: 'nested.cfgScale' },
      { id: 'first', displayName: 'IMAGE' },
      { id: 'second', displayName: 'IMAGE' },
      { id: 'third', displayName: 'named_value_m4' },
      { id: 'fourth', displayName: 'Schema name' },
    ]
    const schema: NodeSchema = {
      ...innerSchemas.KSampler!,
      type: 'Exact names',
      body: labels.flatMap((label) => [
        { ...label, kind: 'input' as const, type: { kind: 'concrete' as const, name: 'IMAGE' }, optional: false },
        { ...label, kind: 'output' as const, type: { kind: 'concrete' as const, name: 'IMAGE' } },
      ]),
    }
    const def = asDef({
      id: 'gExact', name: 'Exact', nextOrdinal: 1,
      nodes: { n0: { id: 'n0', type: schema.type, values: {} } },
      links: {}, nets: {},
      boundary: Object.fromEntries(['inputs', 'outputs'].map((side) => [side,
        labels.map(({ id }, index) => ({
          id: `${side}_${index}`,
          ...(id === 'fourth' ? { displayName: 'Custom_name_m7' } : {}),
          binds: { kind: 'port', node: 'n0', port: id },
        })),
      ])),
    })
    const result = deriveBoundarySchema(def, (type) => type === schema.type ? schema : undefined)
    expect(result.diagnostics).toEqual([])
    for (const ports of [inputsOf(result.schema!), outputsOf(result.schema!)]) {
      expect(ports.map((port) => port.displayName)).toEqual([
        'positive_prompt', 'masks_m4', 'nested.cfgScale', 'IMAGE', 'IMAGE', 'named_value_m4', 'Custom_name_m7',
      ])
    }
    expect(inputsOf(result.schema!).map((port) => port.id)).toEqual(labels.map((_, index) => `inputs_${index}`))
    expect(outputsOf(result.schema!).map((port) => port.id)).toEqual(labels.map((_, index) => `outputs_${index}`))
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

describe('type choice boundary bindings', () => {
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
        inputs: ids.map((id) => ({ id, binds: { kind: 'port', node: id, port: 'model.strength' } })),
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
        inputs: [{ id: 'copy', binds: { kind: 'port', node: 'matched', port: 'source.copy' } }],
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

describe('whole constructs on the subgraph node', () => {
  const defWith = (nodes: Record<string, unknown>, inputs: readonly unknown[], outputs: readonly unknown[] = []): GraphDef =>
    asDef({ id: 'gW', name: 'whole', nodes, links: {}, nets: {}, boundary: { inputs, outputs }, nextOrdinal: 1 })
  const errors = (def: GraphDef) => deriveBoundarySchema(def, resolve).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)

  it('a whole group keeps its template, growth and the definition members inside, and nested members stay per member', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['item0', 'item1'] } } } },
      [{ id: 'stack', displayName: 'Stack rows', binds: { kind: 'construct', node: 'n0', port: 'items' } }],
    )
    const { schema, diagnostics } = deriveBoundarySchema(def, resolve)
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    const row = schema!.body[0]!
    // Five members at most and one at least: two stay in the definition.
    expect(row).toMatchObject({ kind: 'group', id: 'stack', displayName: 'Stack rows', grows: 'button', minMembers: 0, maxMembers: 3, interiorMembers: 2 })
    // A subgraph node with two members of its own, the first holding nested members.
    const elab = elaborateInterface(schema!, {
      values: { 'stack.item0.name': 'a' },
      dynamic: { stack: { members: ['item0', 'item1'] }, 'stack.item0.sub': { members: ['sub0', 'sub1'] } },
    })
    expect(elabInputsOf(elab).filter((input) => input.apiName !== undefined).map((input) => input.spec.id)).toEqual([
      'stack.item0.name', 'stack.item0.sub.sub0', 'stack.item0.sub.sub1', 'stack.item1.name',
    ])
    // Type variables in the template stay the inner node's own.
    expect(elabInputsOf(elab).find((input) => input.spec.id === 'stack.item0.sub.sub0')!.spec.type)
      .toEqual({ kind: 'variable', templateId: 'n0:T' })
    // The face numbers its own members from 1 and says nothing about the two inside.
    const names = (e: typeof elab) => elabInputsOf(e).filter((input) => input.spec.id.endsWith('.name')).map((input) => input.spec.displayName)
    expect(elab.items.filter((item) => item.kind === 'note')).toEqual([])
    expect(names(elab)).toEqual(['item 1 name', 'item 2 name'])
    // A label worked out by a formula reads the same numbering.
    const byFormula = elaborateInterface({ ...schema!, body: [{ ...row, memberLabel: { formula: 'str(index())' } } as typeof row, ...schema!.body.slice(1)] }, {
      values: {}, dynamic: { stack: { members: ['item0', 'item1'] } },
    })
    expect(names(byFormula)).toEqual(['0 name', '1 name'])
    // The header counts this node's members, and the add row stops at what it
    // may hold: the limit of five less the two inside.
    const header = (e: typeof elab) => e.items.find((item) => item.kind === 'box' && item.construct === 'stack')
    expect(header(elab)).toMatchObject({ members: 2 })
    expect(elab.items.some((item) => item.kind === 'growth')).toBe(true)
    const full = elaborateInterface(schema!, { values: {}, dynamic: { stack: { members: ['item0', 'item1', 'item2'] } } })
    expect(header(full)).toMatchObject({ members: 3 })
    expect(full.items.some((item) => item.kind === 'growth')).toBe(false)
  })

  it('a group shown again on an outer subgraph node keeps the limit through every level and numbers its own from 1', () => {
    const inner = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['item0', 'item1'] } } } },
      [{ id: 'stack', binds: { kind: 'construct', node: 'n0', port: 'items' } }],
    )
    const innerSchema = deriveBoundarySchema(inner, resolve).schema!
    const outer = asDef({
      id: 'gO', name: 'outer', links: {}, nets: {}, nextOrdinal: 1,
      nodes: { s0: { id: 's0', type: '#gW', values: {}, dynamic: { stack: { members: ['item0'] } } } },
      boundary: { inputs: [{ id: 'again', binds: { kind: 'construct', node: 's0', port: 'stack' } }], outputs: [] },
    })
    const { schema, diagnostics } = deriveBoundarySchema(outer, (type) => (type === '#gW' ? innerSchema : resolve(type)))
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    // Five at most: two in the definition and one on the inner subgraph node leave two.
    expect(schema!.body[0]).toMatchObject({ kind: 'group', maxMembers: 2, interiorMembers: 3 })
    const elab = elaborateInterface(schema!, { values: {}, dynamic: { again: { members: ['item0'] } } })
    // Each level counts its own members from 1.
    expect(elab.items.filter((item) => item.kind === 'note')).toEqual([])
    expect(elabInputsOf(elab).filter((input) => input.spec.id.endsWith('.name')).map((input) => input.spec.displayName))
      .toEqual(['item 1 name'])
  })

  it('a group with no declared maximum gets none on the subgraph node, and its members inside still share the cap', () => {
    const { maxMembers: _declared, ...items } = innerSchemas['Stack']!.body[0] as GroupSpec
    const open: SchemaResolver = (type) => (type === 'Stack' ? { ...innerSchemas['Stack']!, body: [items, ...innerSchemas['Stack']!.body.slice(1)] } : resolve(type))
    const inner = defWith(
      { n0: { id: 'n0', type: 'Stack', values: {}, dynamic: { items: { members: ['item0', 'item1'] } } } },
      [{ id: 'stack', binds: { kind: 'construct', node: 'n0', port: 'items' } }],
    )
    const innerRow = deriveBoundarySchema(inner, open).schema!.body[0] as GroupSpec
    // No maximum for a header to show; the add row stops where the run's cap does.
    expect(innerRow.maxMembers).toBeUndefined()
    expect(memberLimitOf(innerRow)).toBe(MAX_GROUP_MEMBERS - 2)
    const outer = asDef({
      id: 'gO', name: 'outer', links: {}, nets: {}, nextOrdinal: 1,
      nodes: { s0: { id: 's0', type: '#gW', values: {}, dynamic: { stack: { members: ['item0'] } } } },
      boundary: { inputs: [{ id: 'again', binds: { kind: 'construct', node: 's0', port: 'stack' } }], outputs: [] },
    })
    const innerSchema = deriveBoundarySchema(inner, open).schema!
    const outerRow = deriveBoundarySchema(outer, (type) => (type === '#gW' ? innerSchema : open(type))).schema!.body[0] as GroupSpec
    expect(outerRow.maxMembers).toBeUndefined()
    expect(memberLimitOf(outerRow)).toBe(MAX_GROUP_MEMBERS - 3)
  })

  it('a whole choice starts on the option the definition stores and carries every option', () => {
    const def = defWith(
      { n0: { id: 'n0', type: 'ComboNode', values: { 'mode.x': 4 }, dynamic: { mode: { selected: 'a' } } } },
      [{ id: 'look', binds: { kind: 'construct', node: 'n0', port: 'mode' } }],
    )
    const { schema } = deriveBoundarySchema(def, resolve)
    expect(schema!.body[0]).toMatchObject({ kind: 'choice', id: 'look', default: 'a', options: [{ key: 'a', rows: [{ id: 'x', ext: { default: 4 } }] }] })
  })

  it('refuses two owners of one construct, a row inside a construct shown whole, and a port binding to a construct', () => {
    const node = { n0: { id: 'n0', type: 'ComboNode', values: {}, dynamic: { mode: { selected: 'a' } } } }
    expect(errors(defWith(node, [
      { id: 'one', binds: { kind: 'construct', node: 'n0', port: 'mode' } },
      { id: 'two', binds: { kind: 'construct', node: 'n0', port: 'mode' } },
    ]))).toContain('boundary.constructConflict')
    expect(errors(defWith(node, [
      { id: 'look', binds: { kind: 'construct', node: 'n0', port: 'mode' } },
      { id: 'x', binds: { kind: 'port', node: 'n0', port: 'mode.x' } },
    ]))).toEqual(['boundary.constructOwned'])
    expect(errors(defWith(node, [{ id: 'look', binds: { kind: 'port', node: 'n0', port: 'mode' } }]))).toEqual(['boundary.familyBind'])
    expect(errors(defWith(node, [{ id: 'x', binds: { kind: 'construct', node: 'n0', port: 'mode.x' } }]))).toEqual(['boundary.notAConstruct'])
  })

  it('one row drives two constructs only when their shapes match', () => {
    const nodes = {
      n0: { id: 'n0', type: 'ComboNode', values: {}, dynamic: { mode: { selected: 'a' } } },
      n1: { id: 'n1', type: 'ComboNode', values: {}, dynamic: { mode: { selected: 'a' } } },
      n2: { id: 'n2', type: 'Stack', values: {} },
    }
    expect(errors(defWith(nodes, [{ id: 'look', binds: { kind: 'construct', node: 'n0', port: 'mode' }, alsoBinds: [{ kind: 'construct', node: 'n1', port: 'mode' }] }]))).toEqual([])
    expect(errors(defWith(nodes, [{ id: 'look', binds: { kind: 'construct', node: 'n0', port: 'mode' }, alsoBinds: [{ kind: 'construct', node: 'n2', port: 'items' }] }])))
      .toEqual(['boundary.constructShapeMismatch'])
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

  it('binds a concrete input beneath the chosen option of a choice', () => {
    const result = deriveBoundarySchema(asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: 'ComboNode', values: {} } },
      boundary: { inputs: [{ id: 'x', binds: { kind: 'port', node: 'n0', port: 'mode.x' } }], outputs: [] },
    }), resolve)
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.body[0]).toMatchObject({ kind: 'input', id: 'x', optional: false })
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
            body: [],
          }
        : innerSchemas[t]
    const { schema } = deriveBoundarySchema(nested, resolveNested)
    // Output-node status propagates through nested instances.
    expect(schema!.isOutputNode).toBe(true)
  })
})
