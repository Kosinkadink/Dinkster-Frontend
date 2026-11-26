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
import type { BoundaryItem, GraphDef, Json, NodeData, WorkflowDocument } from '../src/format/document.js'
import { compile } from '../src/compile/compile.js'
import { asConnectionId, asNodeId, asPortId } from '../src/ids.js'
import { deriveBoundarySchema, type SchemaResolver } from '../src/schema/derive-boundary.js'
import { elaborateInterface, elabInputsOf } from '../src/schema/elaborate.js'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { inputsOf, outputsOf, type GroupSpec, type NodeSchema } from '../src/schema/model.js'
import { boundaryOf } from '../src/format/document.js'
import { MAX_GROUP_MEMBERS, memberLimitOf } from '../src/schema/body.js'
import { boundarySample, boundarySampleSchema, resolveBoundarySample } from './fixtures/boundary-sample.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { documentResolver } from '../src/compile/compile.js'
import { loadDocument } from '../src/format/migrate.js'
import { lifecycleSelectionFingerprint, planFlattenBoundaryRoutes } from '../src/lifecycle/planner.js'

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
      boundary: { body: [{ kind: 'output', id: 'seedValue', binds: { kind: 'widgetTap', node: 'n0', tap: 'seed' } }] },
    })
    const valid = deriveBoundarySchema(tapped, (type) => innerSchemas[type])
    expect(outputsOf(valid.schema!)).toEqual([
      expect.objectContaining({ id: 'seedValue', type: { kind: 'concrete', name: 'INT' } }),
    ])
    expect(valid.diagnostics).toEqual([])

    const missing = asDef({
      ...tapped,
      boundary: { body: [{ kind: 'output', id: 'missing', binds: { kind: 'widgetTap', node: 'n0', tap: 'unknown' } }] },
    })
    const invalid = deriveBoundarySchema(missing, (type) => innerSchemas[type])
    expect(outputsOf(invalid.schema!)[0]!.unavailable?.code).toBe('boundary.tapMissing')
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
        boundary: { body: [{ kind: 'output', id: 'invalid', binds: { kind: 'widgetTap', node: 'n0', tap } }] },
      })
      const result = deriveBoundarySchema(malformedDef, () => malformedSchema as NodeSchema)
      expect(outputsOf(result.schema!)[0]!.unavailable?.code).toBe(code)
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
      boundary: { body: [{ kind: 'output', id: 'second', binds: { kind: 'widgetTap', node: 'n0', tap: 'seeds.seed1' } }] },
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
      boundary: boundaryOf([], []),
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
      boundary: boundaryOf([], []),
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
    boundary: boundaryOf([{ id: 'seed', binds: { kind: 'port', node: 'n0', port: 'seed' }, ...(promoted ? { promoted: true } : {}) } as never], []),
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
      } }, links: {}, nets: {}, nextOrdinal: 1, boundary: {
        body: [
          { kind: 'input', id: 'menu', promoted: true,
            binds: { kind: 'port', node: 'n0', port: nested ? 'items.item1' : 'choice' },
          },
        ],
      } })
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
      body: [
        { kind: 'input', id: 'a', binds: { kind: 'port', node: 'n0', port: 'input.input0' } },
        { kind: 'input', id: 'b', binds: { kind: 'port', node: 'n1', port: 'input.input0' } },
        { kind: 'output', id: 'outA', binds: { kind: 'port', node: 'n0', port: 'out0' } },
        { kind: 'output', id: 'outB', binds: { kind: 'port', node: 'n1', port: 'out0' } },
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
      boundary: boundaryOf(inputs as BoundaryItem[], outputs as BoundaryItem[]),
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
      boundary: { body: [{ kind: 'input', id: 'size', binds: { kind: 'port', node: 'n0', port: 'mode.longer_size' }, promoted: true }] },
    })
    const result = deriveBoundarySchema(def, () => schema)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)).toEqual([expect.objectContaining({
      id: 'size', type: { kind: 'concrete', name: 'INT' }, widget: expect.objectContaining({ default: 1024 }),
    })])
    const inactive = deriveBoundarySchema(asDef({
      ...def,
      boundary: { body: [{ kind: 'input', id: 'size', binds: { kind: 'port', node: 'n0', port: 'mode.width' }, promoted: true }] },
    }), () => schema)
    expect(elabInputsOf(elaborateInterface(inactive.schema!, { values: {} }))).toEqual([])
    const kept = elabInputsOf(elaborateInterface(inactive.schema!, { values: {} }, {
      isInputConnected: () => true, isOutputConnected: () => false,
    }))
    expect(kept[0]!.apiName).toBeUndefined()
    expect(kept[0]!.spec.type).toEqual({ kind: 'concrete', name: 'INT' })
    expect(kept[0]!.kept).toContain('not a row of the chosen option')
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
      boundary: boundaryOf([{ id: 'in', binds: binding }], [{ id: 'out', binds: binding }]),
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
      boundary: { body: ['inputs', 'outputs'].flatMap((side) =>
        labels.map(({ id }, index) => ({
          kind: side === 'inputs' ? 'input' : 'output',
          id: `${side}_${index}`,
          ...(id === 'fourth' ? { displayName: 'Custom_name_m7' } : {}),
          binds: { kind: 'port', node: 'n0', port: id },
        })),
      ) },
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
      boundary: { body: [{ kind: 'input', id: 'images.images_m0', binds: { kind: 'port', node: 'n0', port: 'latent_image' } }] },
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
      boundary: { body: ids.map((id) => ({ kind: 'input', id, binds: { kind: 'port', node: id, port: 'model.strength' } })) },
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
        body: [
          { kind: 'input', id: 'copy', binds: { kind: 'port', node: 'matched', port: 'source.copy' } },
          { kind: 'output', id: 'out', binds: { kind: 'port', node: 'matched', port: 'out' } },
          { kind: 'output', id: 'batch', binds: { kind: 'port', node: 'matched', port: 'batch' } },
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
    asDef({ id: 'gW', name: 'whole', nodes, links: {}, nets: {}, boundary: boundaryOf(inputs as BoundaryItem[], outputs as BoundaryItem[]), nextOrdinal: 1 })
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
      boundary: { body: [{ kind: 'input', id: 'again', binds: { kind: 'construct', node: 's0', port: 'stack' } }] },
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

  it("a field's lookup on a subgraph node two levels out reads that node's rows, else the definition's values", () => {
    const { schema: picker } = parseDinksterSchema('Picker', { body: [
      { kind: 'input', id: 'category', type: { kind: 'concrete', types: ['COMBO'] }, pin: false, sent: false, widget: { type: 'COMBO', options: ['sd', 'sdxl'] } },
      { kind: 'input', id: 'lora', type: { kind: 'concrete', types: ['COMBO'] }, widget: { type: 'COMBO', options: { lookup: 'pack.loras', args: ['category'] } } },
    ] } as never)
    const port = (id: string, node: string, at: string) => ({ id, binds: { kind: 'port', node, port: at }, promoted: true })
    const inner = defWith({ p0: { id: 'p0', type: 'Picker', values: { category: 'sd' } } }, [port('kind', 'p0', 'category'), port('pick', 'p0', 'lora')])
    const innerSchema = deriveBoundarySchema(inner, (type) => (type === 'Picker' ? picker : resolve(type))).schema!
    const outerOf = (shown: readonly unknown[]) => deriveBoundarySchema(asDef({
      id: 'gO', name: 'outer', links: {}, nets: {}, nextOrdinal: 1,
      nodes: { s0: { id: 's0', type: '#gW', values: { kind: 'sdxl' } } },
      boundary: boundaryOf(shown as BoundaryItem[], []),
    }), (type) => (type === '#gW' ? innerSchema : resolve(type))).schema!
    const callOf = (schema: NodeSchema, values: Record<string, Json>, wired: readonly string[] = []) => {
      const elab = elaborateInterface(schema, { values }, {
        isInputConnected: (id) => wired.includes(id), isOutputConnected: () => false, inputPorts: () => [...wired], outputPorts: () => [],
      }, { lookupAnswers: () => undefined })
      return elabInputsOf(elab).find((input) => input.spec.id === 'list')!.looked!.options
    }
    const both = outerOf([port('category', 's0', 'kind'), port('list', 's0', 'pick')])
    // Two instances with their own category each ask for their own list; the face's row ids differ from the inner node's.
    expect(callOf(both, { category: 'sd' })).toMatchObject({ state: 'loading', call: { args: ['sd'] } })
    expect(callOf(both, { category: 'sdxl' })).toMatchObject({ state: 'loading', call: { args: ['sdxl'] } })
    // A wire into the category from outside is not known, so nothing is called.
    expect(callOf(both, { category: 'sd' }, ['category'])).toMatchObject({ state: 'waiting' })
    // Not shown on this node: the inner subgraph node's stored category is used.
    expect(callOf(outerOf([port('list', 's0', 'pick')]), {})).toMatchObject({ state: 'loading', call: { args: ['sdxl'] } })
  })

  it('an automatic field shown on a subgraph node is worked out in the inner node with this instance\'s values', () => {
    const float = (id: string, extra: Record<string, unknown> = {}) =>
      ({ kind: 'input', id, type: { kind: 'concrete', types: ['FLOAT'] }, default: 1, widget: { type: 'FLOAT' }, ...extra })
    const { schema: retime } = parseDinksterSchema('Retime', { body: [
      float('rate', { default: 48 }),
      float('fps', { default: 24, automatic: { formula: 'rate / 4' } }),
    ] } as never)
    const port = (id: string, node: string, at: string) => ({ id, binds: { kind: 'port', node, port: at }, promoted: true })
    const withRetime: SchemaResolver = (type) => (type === 'Retime' ? retime : resolve(type))
    const faceOf = (stored: Record<string, Json>, shown: readonly unknown[], links: Record<string, unknown> = {}, nodes: Record<string, unknown> = {}) =>
      deriveBoundarySchema(asDef({
        id: 'gW', name: 'whole', links, nets: {}, nextOrdinal: 1, boundary: boundaryOf(shown as BoundaryItem[], []),
        nodes: { r0: { id: 'r0', type: 'Retime', values: stored }, ...nodes },
      }), withRetime).schema!
    const fpsOf = (schema: NodeSchema, values: Record<string, Json>) => {
      const elab = elaborateInterface(schema, { values })
      return { row: elabInputsOf(elab).find((input) => input.spec.id === 'speed')!, warned: elab.diagnostics.some((d) => d.code === 'automatic.default') }
    }
    const both = faceOf({}, [port('pace', 'r0', 'rate'), port('speed', 'r0', 'fps')])
    // Two instances each work out their own value from their own rate.
    expect(fpsOf(both, { pace: 100 }).row.automatic).toEqual({ value: 25, state: 'worked-out' })
    expect(fpsOf(both, { pace: 60 }).row.automatic).toEqual({ value: 15, state: 'worked-out' })
    // A value on the instance is fixed; emptying it would give this instance's value.
    const fixed = fpsOf(both, { pace: 100, speed: 30 }).row
    expect(fixed.automatic).toBeUndefined()
    expect(fixed.automaticIfEmptied).toEqual({ value: 25, state: 'worked-out' })
    // Compiled, an instance with the field left out sends its inner node
    // without it; that node, worked out as a plain node, gives the row's value.
    const shownBoth = [port('pace', 'r0', 'rate'), port('speed', 'r0', 'fps')]
    const compiled = compile({
      document: {
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'automatic-instances', root: 'g0',
        graphs: {
          g0: { id: 'g0', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 3, nodes: {
            a: { id: 'a', type: '#gW', values: { pace: 100 } },
            b: { id: 'b', type: '#gW', values: { pace: 60 } },
            c: { id: 'c', type: '#gW', values: { pace: 60, speed: 30 } },
          } },
          gW: { id: 'gW', name: 'whole', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
            nodes: { r0: { id: 'r0', type: 'Retime', values: {} } }, boundary: boundaryOf(shownBoth as BoundaryItem[], []) },
        },
        view: { graphs: {} },
      } as never,
      revision: 1, resolve: withRetime, scope: { kind: 'full' }, connection: asConnectionId('c0'), schemaHash: 'test',
    })
    expect(compiled.ok).toBe(true)
    if (!compiled.ok) return
    for (const [instance, pace] of [['a', 100], ['b', 60]] as const) {
      const inputs = compiled.artifact.prompt[`${instance}.r0`]!.inputs
      expect(inputs).not.toHaveProperty('fps')
      const plain = elabInputsOf(elaborateInterface(retime!, { values: inputs as Record<string, Json> }))
      expect(plain.find((input) => input.spec.id === 'fps')!.automatic).toEqual(fpsOf(both, { pace }).row.automatic)
    }
    expect(compiled.artifact.prompt['c.r0']!.inputs).toMatchObject({ fps: 30 })
    // A rate not shown on the subgraph node is the definition's.
    expect(fpsOf(faceOf({ rate: 80 }, [port('speed', 'r0', 'fps')]), {}).row.automatic).toEqual({ value: 20, state: 'worked-out' })
    // A value the definition stores is the row's value, not automatic.
    const stored = fpsOf(faceOf({ fps: 12 }, [port('speed', 'r0', 'fps')]), {}).row
    expect(stored.automatic).toBeUndefined()
    expect(stored.spec.widget?.default).toBe(12)
    // A rate wired inside the definition is not known: the default, with the warning.
    const wired = fpsOf(faceOf({}, [port('speed', 'r0', 'fps')],
      { l0: { id: 'l0', from: { node: 'n0', port: 'out' }, to: { node: 'r0', port: 'rate' } } },
      { n0: { id: 'n0', type: 'Retime', values: {} } }), {})
    expect(wired.row.automatic).toMatchObject({ value: 24, state: 'default' })
    expect(wired.warned).toBe(true)
    // Two levels out, the outer subgraph node's rate decides.
    const outer = deriveBoundarySchema(asDef({
      id: 'gO', name: 'outer', links: {}, nets: {}, nextOrdinal: 1,
      nodes: { s0: { id: 's0', type: '#gW', values: {} } },
      boundary: boundaryOf([port('tempo', 's0', 'pace'), port('speed', 's0', 'speed')] as BoundaryItem[], []),
    }), (type) => (type === '#gW' ? both : withRetime(type))).schema!
    expect(fpsOf(outer, { tempo: 200 }).row.automatic).toEqual({ value: 50, state: 'worked-out' })
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
      boundary: { body: [{ kind: 'input', id: 'again', binds: { kind: 'construct', node: 's0', port: 'stack' } }] },
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
    boundary: boundaryOf([], []),
    nextOrdinal: 1,
  })

  it('binds a concrete input beneath the chosen option of a choice', () => {
    const result = deriveBoundarySchema(asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: 'ComboNode', values: {} } },
      boundary: { body: [{ kind: 'input', id: 'x', binds: { kind: 'port', node: 'n0', port: 'mode.x' } }] },
    }), resolve)
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.body[0]).toMatchObject({ kind: 'input', id: 'x', optional: false })
  })

  it('nested subgraph instance types resolve through the resolver', () => {
    const nested: GraphDef = asDef({
      ...base,
      nodes: { n0: { id: 'n0', type: '#gInner', values: {} } },
      boundary: boundaryOf([], []),
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

describe('Boundary sample acceptance compilation', () => {
  const prompt = (doc: WorkflowDocument) => {
    const result = compile({ document: doc, revision: 1, resolve: resolveBoundarySample,
      scope: { kind: 'full' }, connection: asConnectionId('boundary-grid'), schemaHash: 'boundary-sample' })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    return result.artifact.prompt
  }
  const storeFor = (doc: WorkflowDocument) => new DocumentStore(doc, coreCommandRegistry(), 200, undefined,
    () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolveBoundarySample) }))
  it('keeps a broken middle binding inert without blocking or changing unrelated rows', () => {
    const doc = boundarySample(2)
    const store = storeFor(doc)
    const before = store.doc.graphs.detail!.boundary!.body
    const changed = store.dispatch({ command: 'boundary.unbind', params: {
      graphId: 'detail', side: 'inputs', itemId: 'strength', node: 'sample', port: 'strength',
    } })
    expect(changed.ok).toBe(true)
    const schema = documentResolver(store.doc, resolveBoundarySample)('#portrait')!
    const rows = elabInputsOf(elaborateInterface(schema, store.doc.graphs.root!.nodes.first!))
    expect(rows.find((row) => row.spec.id === 'strength')).toMatchObject({
      kept: expect.stringContaining('strength'), spec: { unavailable: { code: 'boundary.unknownPort' } },
    })
    expect(rows.find((row) => row.spec.id === 'strength')!.apiName).toBeUndefined()
    expect(rows.find((row) => row.spec.id === 'radius')!.spec.widget?.default).toBe(0.1)
    expect(prompt(store.doc)['first.detail.sample']!.inputs.strength).toBe(0.3)
    expect(prompt(store.doc)['second.detail.sample']!.inputs.strength).toBe(0.3)
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.detail!.boundary!.body).toEqual(before)
    expect(prompt(store.doc)['first.detail.sample']!.inputs.strength).toBe(0.2)
    expect(prompt(store.doc)['second.detail.sample']!.inputs.strength).toBe(0.8)

    const detail = structuredClone(store.doc.graphs.detail!)
    Object.assign(detail, { boundary: { body: detail.boundary!.body.map((row) =>
      'id' in row && row.id === 'strength' ? { ...row, alsoBinds: [{ kind: 'port', node: 'missing', port: 'strength' }] } : row) } })
    const broken: WorkflowDocument = { ...store.doc, graphs: { ...store.doc.graphs, detail } }
    const reopened = loadDocument(JSON.parse(JSON.stringify(broken)))
    expect(reopened.document, JSON.stringify(reopened.diagnostics)).toBeDefined()
    expect(prompt(reopened.document!)['first.detail.sample']!.inputs.strength).toBe(0.3)
    expect(prompt(broken)['first.detail.sample']!.inputs.strength).toBe(0.3)
    expect(prompt(broken)['first.detail.sample']!.inputs.count).toBe(3)
    expect(prompt(broken)['second.detail.sample']!.inputs.count).toBe(2)
    const linked = structuredClone(broken)
    Object.assign(linked.graphs.root!.links, { bad: { id: 'bad', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'strength' } } })
    const refused = compile({ document: linked, revision: 1, resolve: resolveBoundarySample,
      scope: { kind: 'full' }, connection: asConnectionId('boundary-grid'), schemaHash: 'boundary-sample' })
    expect(refused.ok).toBe(false)
    expect(!refused.ok && refused.diagnostics.some((d) => d.code === 'boundary.danglingNode')).toBe(true)
  })
  const edit = (store: DocumentStore, command: string, params: Record<string, Json>) => {
    const before = store.doc
    const result = store.dispatch({ command, params })
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    const after = store.doc
    expect(store.undo()).toBe(true)
    // Allocation cursors are monotonic across undo; endpoints and values are not.
    const undone = structuredClone(store.doc)
    for (const [id, graph] of Object.entries(undone.graphs)) {
      expect(graph.nextOrdinal).toBe(after.graphs[id]!.nextOrdinal)
      Object.assign(graph, { nextOrdinal: before.graphs[id]!.nextOrdinal })
    }
    expect(undone).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(after)
    const loaded = loadDocument(JSON.parse(JSON.stringify(after)))
    expect(loaded.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(prompt(loaded.document!)).toEqual(prompt(after))
  }

  it('boundary/row-flags carries leaf formulas, pinless unsent fields and port policies through renamed rows', () => {
    const resolve: SchemaResolver = (type) => type === 'Boundary sample' ? {
      ...boundarySampleSchema, body: boundarySampleSchema.body.map((row) =>
        row.kind === 'input' && row.id === 'strength'
          ? { ...row, visible: { formula: 'radius > 0.5' }, labelFormula: { formula: '"Mix " + fixed(radius, 1)' },
            ext: { 'fixture.row': { inherited: 'strength' } },
            widget: { ...row.widget!, controller: 'after_generate' } }
          : row.kind === 'input' && row.id === 'radius' ? { ...row, sent: false, socketless: true }
            : row.kind === 'input' && row.id === 'mask' ? { ...row, onAbsent: 'fail', acceptsStorage: true, acceptsStream: true, maskPolarity: 'transparency' }
              : row.kind === 'output' && row.id === 'result' ? { ...row, alphaPolicy: 'drop', tooltip: 'Result help',
                preview: true, optional: true, knownValue: { input: 'strength' } } : row),
    } : resolveBoundarySample(type)
    const source = boundarySample(2)
    const detail = source.graphs.detail!
    const portrait = source.graphs.portrait!
    const doc: WorkflowDocument = { ...source, graphs: { ...source.graphs,
      detail: { ...detail, boundary: { body: detail.boundary!.body.map((row) => row.kind === 'input' && row.id === 'radius'
        ? { ...row, id: 'threshold' } : row) } },
      portrait: { ...portrait, boundary: { body: portrait.boundary!.body.map((row) => row.kind === 'input' && row.id === 'radius'
        ? { ...row, id: 'control', binds: { kind: 'port' as const, node: asNodeId('detail'), port: asPortId('threshold') } } : row) } },
    } }
    const store = new DocumentStore(doc, coreCommandRegistry(), 200, undefined,
      () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolve) }))
    const extraction = store.dispatch({ command: 'subgraph.extract', params: {
      graphId: 'detail', instancePath: ['first', 'detail'], selection: { nodeIds: ['sample'] },
      selectionFingerprint: lifecycleSelectionFingerprint(doc, 'detail', { nodeIds: ['sample'] })!,
      specializedSlotRoots: [], widgetTapSources: [], placementCenter: { x: 0, y: 0 },
      resolvedGeometry: [{ id: 'sample', kind: 'node', x: 0, y: 0, width: 400, height: 600 }], name: 'Extracted sample',
    } })
    expect(extraction.ok, JSON.stringify(extraction.diagnostics)).toBe(true)
    const extracted = store.doc
    expect(extracted.graphs.detail!.nodes.sample).toBeUndefined()
    const shell = Object.values(extracted.graphs.detail!.nodes)[0]!
    expect(shell.type.startsWith('#')).toBe(true)
    const created = extracted.graphs[shell.type.slice(1)]!
    expect(Object.keys(extracted.graphs)).toHaveLength(Object.keys(doc.graphs).length + 1)
    expect(Object.values(created.nodes)).toMatchObject([{ type: 'Boundary sample', values: doc.graphs.detail!.nodes.sample!.values }])
    expect(extracted.graphs.detail!.boundary!.body.find((row) => row.kind === 'input' && row.id === 'strength')).toMatchObject({
      binds: { kind: 'port', node: shell.id, port: 'strength' },
    })
    expect(store.undo()).toBe(true)
    expect(store.doc.graphs.detail!.nodes).toEqual(doc.graphs.detail!.nodes)
    expect(store.doc.graphs.detail!.boundary).toEqual(doc.graphs.detail!.boundary)
    expect(store.doc.graphs[created.id]).toBeUndefined()
    expect(store.redo()).toBe(true)
    expect(store.doc).toEqual(extracted)
    const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc)))
    expect(reopened.document).toBeDefined()
    const extractedRun = compile({ document: reopened.document!, revision: 1, resolve, scope: { kind: 'full' },
      connection: asConnectionId('boundary-grid'), schemaHash: 'boundary-sample' })
    expect(extractedRun.ok, JSON.stringify(!extractedRun.ok && extractedRun.diagnostics)).toBe(true)
    if (!extractedRun.ok) throw new Error('extracted row fixture did not compile')
    const samples = Object.values(extractedRun.artifact.prompt).filter((node) => node.class_type === 'Boundary sample')
    expect(samples.map((node) => node.inputs.strength).sort()).toEqual([0.2, 0.8])
    for (const node of samples) expect(node.inputs).not.toHaveProperty('radius')
    const plan = planFlattenBoundaryRoutes(doc.graphs.portrait!, documentResolver(doc, resolve),
      doc.graphs.root!.nodes.first!, doc.graphs.root!)
    expect(plan.statePlan.status).toBe('ready')
    for (const [route, schema] of [
      ['derive', documentResolver(doc, resolve)('#portrait')!],
      ['extract', documentResolver(reopened.document!, resolve)('#portrait')!],
      ['planner', deriveBoundarySchema(doc.graphs.portrait!, (type) => plan.schemaSnapshot[type]).schema!],
    ] as const) {
      for (const control of [0.2, 0.8]) {
        const elab = elaborateInterface(schema, { values: { control, strength: 0.9 } })
        const fields = elabInputsOf(elab)
        const mix = fields.find((row) => row.spec.id === 'strength')!
        expect(mix.spec.hidden === true, route).toBe(control < 0.5)
        expect(mix.spec.displayName).toBe(`Mix ${control}`)
        expect(mix.spec.tooltip).toBe('Mix strength')
        expect(mix.spec.ext).toEqual({ 'fixture.row': { inherited: 'strength' } })
        expect(mix.spec.widget?.controller).toBe('after_generate')
        expect(fields.find((row) => row.spec.id === 'control')).toMatchObject({ spec: { socketless: true, sent: false } })
        expect(fields.find((row) => row.spec.id === 'mask')).toMatchObject({ spec: {
          onAbsent: 'fail', acceptsStorage: true, acceptsStream: true, maskPolarity: 'transparency',
        } })
        const output = elab.items.find((row) => row.kind === 'output' && row.spec.id === 'result')
        expect(output).toMatchObject({ spec: { alphaPolicy: 'drop', tooltip: 'Result help',
          preview: true, optional: true, knownValue: { input: 'strength' } } })
      }
    }
    const first = doc.graphs.root!.nodes.first!
    const compiled = compile({ document: { ...doc, graphs: { ...doc.graphs, root: { ...doc.graphs.root!, nodes: {
      ...doc.graphs.root!.nodes, first: { ...first, values: { ...first.values, control: 0.8 } },
    } } } }, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('boundary-grid'), schemaHash: 'boundary-sample' })
    expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
    if (!compiled.ok) throw new Error('complete row fixture did not compile')
    expect(compiled.artifact.prompt['first.detail.sample']!.inputs).not.toHaveProperty('radius')
    expect(compiled.artifact.prompt['first.detail.sample']!.inputs.strength).toBe(0.2)
  })

  it('boundary/formulas reads unexposed active choice defaults without reading dormant or wired fields', () => {
    for (const [dependency, selected, wired, expected] of [
      ['mix', 'image', false, 0.3], ['private', 'text', false, 0.7],
      ['private', 'image', false, undefined], ['mix', 'image', true, undefined],
      ['signal', 'image', true, undefined], ['signal', 'image', false, undefined],
      ['pending', 'image', false, undefined], ['stored', 'image', false, 0.9],
      ['calculated', 'image', false, 0.7], ['failed', 'image', false, 0.3],
      ['pick', 'image', false, null],
      ['led', 'image', false, null], ['threshold', 'image', false, 0.3],
      ['storedState', 'image', false, 0.9], ['threshold', 'text', false, undefined],
    ] as const) for (const exposeInnerChoice of wired ? [false] : [false, true]) {
      const inner: NodeSchema = { ...boundarySampleSchema, body: boundarySampleSchema.body.map((row) =>
        row.kind === 'input' && row.id === 'strength'
          ? { ...row, visible: { formula: dependency === 'signal' ? 'linked(mode.signal)' : dependency === 'pick' || dependency === 'led' ? `mode.${dependency} == "y"` : `mode.${dependency} > 0.5` },
            labelFormula: { formula: dependency === 'signal' ? '"Signal connected" if linked(mode.signal) else "Signal empty"' : dependency === 'pick' || dependency === 'led' ? `"Pick y" if mode.${dependency} == "y" else "Pick empty"` : `"Mix " + fixed(mode.${dependency}, 1)` } }
          : row.kind === 'choice' && row.id === 'mode' ? { ...row, shared: [...row.shared,
            { kind: 'input' as const, id: 'signal', type: { kind: 'concrete' as const, name: 'FLOAT' }, optional: true },
            ...['pending', 'stored', 'calculated', 'failed'].map((id) => ({ kind: 'input' as const, id, type: { kind: 'concrete' as const, name: 'FLOAT' }, optional: false,
              widget: { widgetType: 'FLOAT', options: {}, default: 0.3 },
              automatic: id === 'calculated' || id === 'failed' ? { formula: id === 'calculated' ? '0.7' : '1 / 0' } : { lookup: 'pack.mix', args: [] } })),
          ], options: row.options.map((option) => option.key === 'text'
            ? { ...option, rows: [...option.rows, { kind: 'input' as const, id: 'private', type: { kind: 'concrete' as const, name: 'FLOAT' }, optional: false,
              widget: { widgetType: 'FLOAT', options: {}, default: 0.7 } }] }
            : { ...option, rows: [...option.rows, ...['signal', 'pending', 'stored', 'calculated', 'failed'].map((id) => ({ kind: 'use' as const, id })),
              { kind: 'choice' as const, id: 'pick', required: false, shared: [], options: [{ key: 'x', rows: [] }, { key: 'y', rows: [] }] },
              { kind: 'choice' as const, id: 'led', required: true, leader: '"x"', shared: [], options: [{ key: 'x', rows: [] }, { key: 'y', rows: [] }] },
              ...['threshold', 'storedState'].map((id) => ({ kind: 'state' as const, id, type: { kind: 'concrete' as const, name: 'FLOAT' }, default: 0.3, partOfRun: false })),
            ] }) } : row) }
      const source = boundarySample(2)
      const detail = source.graphs.detail!
      const sample = detail.nodes.sample!
      const doc: WorkflowDocument = { ...source, graphs: { ...source.graphs, detail: { ...detail,
        nodes: { ...detail.nodes, sample: { ...sample,
          values: { ...sample.values, 'mode.stored': 0.9, 'mode.storedState': 0.9, ...(dependency === 'private' && selected === 'image' ? { 'mode.private': 0.9 } : {}) },
          dynamic: { ...sample.dynamic, mode: { selected } } } },
        links: wired ? { wire: { id: 'wire', from: { node: 'sample', port: 'output91' }, to: { node: 'sample', port: `mode.${dependency}` } } } as never : {},
        boundary: { body: [{ kind: 'input', id: 'amount', promoted: true, binds: { kind: 'port', node: 'sample', port: 'strength' } },
          ...(exposeInnerChoice ? [{ kind: 'input', id: 'mode', binds: { kind: 'construct', node: 'sample', port: 'mode' } }] : [])] } as never,
      }, portrait: { ...source.graphs.portrait!, boundary: { body: [
        { kind: 'input', id: 'mix', promoted: true, binds: { kind: 'port', node: 'detail', port: 'amount' } },
      ] } as never } } }
      const resolve: SchemaResolver = (type) => type === 'Boundary sample' ? inner : resolveBoundarySample(type)
      for (const [schema, id] of [[documentResolver(doc, resolve)('#detail')!, 'amount'], [documentResolver(doc, resolve)('#portrait')!, 'mix']] as const) {
        const field = elabInputsOf(elaborateInterface(schema, { values: {} })).find((row) => row.spec.id === id)!
        expect(field.spec.displayName).toBe(dependency === 'signal' ? wired ? 'Signal connected' : 'Signal empty' : dependency === 'pick' || dependency === 'led' ? 'Pick empty' : expected === undefined ? id : `Mix ${expected}`)
        expect(field.spec.hidden === true).toBe(dependency === 'signal' ? !wired : expected === null || expected !== undefined && expected < 0.5)
      }
    }
  })

  it('boundary/formulas recalculates unexposed dependencies from renamed occurrence fields at both depths', () => {
    for (const stored of [false, true]) {
      const inner: NodeSchema = { ...boundarySampleSchema, body: boundarySampleSchema.body.map((row) =>
        row.kind === 'input' && row.id === 'strength' ? { ...row,
          visible: { formula: 'mode.calculated > 0.5 and mode.pick == "y" and mode.pick.amount > 0.5' },
          labelFormula: { formula: '"Mix " + fixed(mode.calculated, 1)' },
        } : row.kind === 'choice' && row.id === 'mode' ? { ...row, options: row.options.map((option) => option.key !== 'image' ? option : { ...option, rows: [...option.rows,
          { kind: 'input' as const, id: 'calculated', type: { kind: 'concrete' as const, name: 'FLOAT' }, optional: false,
            widget: { widgetType: 'FLOAT', options: {}, default: 0.1 }, automatic: { formula: 'radius' } },
          { kind: 'choice' as const, id: 'pick', required: true, leader: '"y" if radius > 0.5 else "x"', shared: [],
            options: ['x', 'y'].map((key) => ({ key, rows: [{ kind: 'state' as const, id: 'amount', type: { kind: 'concrete' as const, name: 'FLOAT' }, default: key === 'x' ? 0.2 : 0.8, partOfRun: false }] })) },
        ] }) } : row) }
      const source = boundarySample(2)
      const detail = source.graphs.detail!
      const sample = detail.nodes.sample!
      const document = { ...source, graphs: { ...source.graphs,
        detail: { ...detail, nodes: { ...detail.nodes, sample: { ...sample,
          values: { ...sample.values, radius: 0.1, ...(stored ? { 'mode.calculated': 0.9 } : {}) },
          dynamic: { ...sample.dynamic, mode: { selected: 'image' } },
        } }, boundary: { body: [
          { kind: 'input', id: 'amount', promoted: true, binds: { kind: 'port', node: asNodeId('sample'), port: asPortId('strength') } },
          { kind: 'input', id: 'threshold', promoted: true, binds: { kind: 'port', node: asNodeId('sample'), port: asPortId('radius') } },
        ] } },
        portrait: { ...source.graphs.portrait!, boundary: { body: [
          { kind: 'input', id: 'mix', promoted: true, binds: { kind: 'port', node: asNodeId('detail'), port: asPortId('amount') } },
          { kind: 'input', id: 'control', promoted: true, binds: { kind: 'port', node: asNodeId('detail'), port: asPortId('threshold') } },
        ] } },
      } } as WorkflowDocument
      const resolve: SchemaResolver = (type) => type === 'Boundary sample' ? inner : resolveBoundarySample(type)
      for (const [type, control, amount] of [['#detail', 'threshold', 'amount'], ['#portrait', 'control', 'mix']] as const) {
        const schema = documentResolver(document, resolve)(type)!
        for (const value of [0.2, 0.8, 0.2]) {
          const field = elabInputsOf(elaborateInterface(schema, { values: { [control]: value } })).find((row) => row.spec.id === amount)!
          expect(field.spec.displayName).toBe(`Mix ${stored ? 0.9 : value}`)
          expect(field.spec.hidden === true).toBe(value < 0.5)
        }
      }
    }
  })

  it('boundary/formulas preserves node-specific schemas when inner nodes share a type', () => {
    const schema = (value: number): NodeSchema => ({
      type: 'Treatment', source: 'v3', displayName: 'Treatment', category: 'test', isOutputNode: false,
      body: [
        { kind: 'input', id: 'radius', type: { kind: 'concrete', name: 'FLOAT' }, optional: false, widget: { widgetType: 'FLOAT', options: {}, default: value } },
        { kind: 'input', id: 'calculated', type: { kind: 'concrete', name: 'FLOAT' }, optional: false, widget: { widgetType: 'FLOAT', options: {}, default: 0 }, automatic: { formula: 'radius' } },
        { kind: 'input', id: 'strength', type: { kind: 'concrete', name: 'FLOAT' }, optional: false, widget: { widgetType: 'FLOAT', options: {}, default: 0.4 }, labelFormula: { formula: '"Mix " + fixed(calculated, 1)' } },
      ],
    })
    const source = boundarySample(1).graphs.detail!
    const graph: GraphDef = { ...source, nodes: {
      a: { ...source.nodes.sample!, id: asNodeId('a'), type: 'Treatment', values: {}, dynamic: {} },
      b: { ...source.nodes.sample!, id: asNodeId('b'), type: 'Treatment', values: {}, dynamic: {} },
      constructor: { id: asNodeId('constructor'), type: 'Missing', values: {} },
    }, boundary: boundaryOf([
      { id: 'amount', promoted: true, binds: { kind: 'port', node: asNodeId('a'), port: asPortId('strength') } },
      { id: 'other', promoted: true, binds: { kind: 'port', node: asNodeId('b'), port: asPortId('strength') } },
      { id: 'unavailable', binds: { kind: 'port', node: asNodeId('constructor'), port: asPortId('missing') } },
    ], []) }
    const resolveNode = (node: NodeData) => node.type === 'Missing' ? undefined : schema(node.id === 'a' ? 0.1 : 0.9)
    const derived = deriveBoundarySchema(graph, (type) => type === 'Missing' ? undefined : schema(0.1), undefined, resolveNode)
    const fields = elabInputsOf(elaborateInterface(derived.schema!, { values: {} }))
    expect(fields.slice(0, 2).map((field) => field.spec.displayName)).toEqual(['Mix 0.1', 'Mix 0.9'])
    expect(fields[2]!.spec.unavailable?.code).toBe('boundary.unresolvedSchema')
  })

  it('boundary/show-hide uses boundary names for a whole choice through renamed nested boundaries', () => {
    const source = boundarySample(2)
    const detail = source.graphs.detail!
    const document = { ...source, graphs: { ...source.graphs, detail: { ...detail, boundary: {
      body: detail.boundary!.body.map((row) => row.kind === 'input' && row.id === 'image' ? { ...row, id: 'photo' } : row),
    } }, portrait: { ...source.graphs.portrait!, boundary: {
      body: source.graphs.portrait!.boundary!.body.map((row) => row.kind === 'input' && row.id === 'image'
        ? { ...row, id: 'picture', binds: { kind: 'port' as const, node: asNodeId('detail'), port: asPortId('photo') } }
        : row.kind === 'input' && row.id === 'mode' ? { ...row, id: 'treatment' } : row),
    } } } }
    const store = storeFor(document)
    edit(store, 'boundary.setVisible', { graphId: 'detail', itemId: 'mode', formula: 'linked(photo)' })
    for (const [type, input, choice] of [['#detail', 'photo', 'mode'], ['#portrait', 'picture', 'treatment']]) {
      const schema = documentResolver(store.doc, resolveBoundarySample)(type!)!
      const hidden = elabInputsOf(elaborateInterface(schema, { values: {} })).find((row) => row.spec.id === `${choice}.mix`)
      expect(hidden?.spec.hidden).toBe(true)
      const shown = elabInputsOf(elaborateInterface(schema, { values: {} }, { isInputConnected: (id) => id === input, isOutputConnected: () => false }))
        .find((row) => row.spec.id === `${choice}.mix`)
      expect(shown).toBeDefined()
      expect(shown?.spec.hidden).not.toBe(true)
    }
    edit(store, 'boundary.setVisible', { graphId: 'portrait', itemId: 'treatment', formula: 'linked(mask)' })
    const outer = documentResolver(store.doc, resolveBoundarySample)('#portrait')!
    for (const linked of [['mask'], ['picture'], ['mask', 'picture']]) {
      const mix = elabInputsOf(elaborateInterface(outer, { values: {} }, {
        isInputConnected: (id) => linked.includes(id), isOutputConnected: () => false,
      })).find((row) => row.spec.id === 'treatment.mix')!
      expect(mix.spec.hidden === true).toBe(linked.length !== 2)
    }
    edit(store, 'boundary.setVisible', { graphId: 'portrait', itemId: 'treatment', formula: null })
    const inherited = documentResolver(store.doc, resolveBoundarySample)('#portrait')!
    const mix = elabInputsOf(elaborateInterface(inherited, { values: {} }, {
      isInputConnected: (id) => id === 'picture', isOutputConnected: () => false,
    })).find((row) => row.spec.id === 'treatment.mix')!
    expect(mix.spec.hidden).not.toBe(true)
    for (const formula of ['mode == "text"', 'mode.mix > 0.5', 'len(nested) > 0']) {
      edit(store, 'boundary.setVisible', { graphId: 'detail', itemId: 'layers', formula })
      const sibling = documentResolver(store.doc, resolveBoundarySample)('#portrait')!
      for (const selected of ['image', 'text', 'image']) {
        const layer = elabInputsOf(elaborateInterface(sibling, {
          values: { 'treatment.mix': selected === 'text' ? 0.8 : 0.2 },
          dynamic: { treatment: { selected }, layers: { members: ['layer0'] }, nested: { members: selected === 'text' ? ['n0'] : [] } },
        })).find((row) => row.spec.id === 'layers.layer0.strength')!
        expect(layer.spec.hidden === true).toBe(selected !== 'text')
      }
    }
  })

  it('boundary/whole-choice/fan-out forwards one owner and unbinds only the selected target', () => {
    const source = boundarySample(1)
    const sample = source.graphs.detail!.nodes.sample!
    const document = { ...source, graphs: { ...source.graphs, detail: {
      ...source.graphs.detail!, nodes: { ...source.graphs.detail!.nodes,
        extra: { ...sample, id: asNodeId('extra'), values: { ...sample.values, 'mode.mix': 0.17 } },
      },
    } } } as WorkflowDocument
    const store = storeFor(document)
    edit(store, 'boundary.addBinding', { graphId: 'detail', itemId: 'mode', node: 'extra', port: 'mode' })
    edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
    edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.mix', value: 0.84 })
    expect(prompt(store.doc)['first.sample']!.inputs['mode.mix']).toBe(0.84)
    expect(prompt(store.doc)['first.extra']!.inputs['mode.mix']).toBe(0.84)
    expect(prompt(store.doc)['second.extra']!.inputs['mode.mix']).toBe(0.17)
    const beforeRefusal = store.doc
    const refused = store.dispatch({ command: 'boundary.addBinding', params: { graphId: 'detail', itemId: 'mode', node: 'extra', port: 'nested' } })
    expect(!refused.ok && refused.diagnostics.some((d) => d.code === 'boundary.constructShapeMismatch')).toBe(true)
    expect(store.doc).toBe(beforeRefusal)
    edit(store, 'boundary.unbind', { graphId: 'detail', side: 'inputs', itemId: 'mode', kind: 'construct', node: 'sample', port: 'mode' })
    expect(prompt(store.doc)['first.sample']!.inputs['mode.mix']).toBe(0.3)
    expect(prompt(store.doc)['first.extra']!.inputs['mode.mix']).toBe(0.84)
    expect(prompt(store.doc)['second.extra']!.inputs['mode.mix']).toBe(0.17)
  })

  it('boundary/whole-group/fan-out shares capacity and names, refusing targets that strand existing members', () => {
    for (const named of [false, true]) {
      const keys = Array.from({ length: 8 }, (_, index) => `layer${index}`)
      const resolve: SchemaResolver = (type) => type === 'Boundary sample' && named ? {
        ...boundarySampleSchema, body: boundarySampleSchema.body.map((row) => row.kind === 'group' && row.id === 'layers'
          ? { ...row, keys: { kind: 'named', names: keys } } : row),
      } : resolveBoundarySample(type)
      const source = boundarySample(2)
      const detail = source.graphs.detail!
      const sample = detail.nodes.sample!
      const document = { ...source, graphs: { ...source.graphs, detail: { ...detail, nodes: { ...detail.nodes,
        extra: { ...sample, id: asNodeId('extra'), dynamic: { ...sample.dynamic, layers: { members: keys.slice(1, 7) } } },
      } } } }
      const store = new DocumentStore(document, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolve) }))
      const dispatch = (command: string, params: Record<string, Json>) => store.dispatch({ command, params })
      const materialize = (members: string[]) => dispatch('dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [{ construct: 'layers', members }] })
      expect(materialize(named ? ['layer6', 'layer7'] : ['layer0', 'layer1', 'layer2']).ok).toBe(true)
      const before = store.doc
      const target = { graphId: 'detail', itemId: 'layers', node: 'extra', port: 'layers' }
      const refused = dispatch('boundary.addBinding', target)
      expect(refused.ok).toBe(false)
      expect(refused.diagnostics.some((d) => d.code === (named ? 'elab.autogrow.badMember' : 'elab.autogrow.overMax'))).toBe(true)
      expect(store.doc).toBe(before)
      expect(store.undo()).toBe(true)
      expect(dispatch('boundary.addBinding', target).ok).toBe(true)
      const schema = documentResolver(store.doc, resolve)('#portrait')!
      const layers = schema.body.find((row) => row.kind === 'group' && row.id === 'layers') as GroupSpec
      expect(memberLimitOf(layers)).toBe(named ? 1 : 2)
      expect(materialize(named ? ['layer7'] : ['layer0', 'layer1']).ok).toBe(true)
      const result = compile({ document: store.doc, revision: 1, resolve,
        scope: { kind: 'full' }, connection: asConnectionId('boundary-grid'), schemaHash: 'boundary-sample' })
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (!result.ok) throw new Error('group fan-out did not compile')
      expect(result.artifact.prompt['first.detail.extra']!.outputMembers?.layers)
        .toEqual(named ? ['layer1', 'layer2', 'layer3', 'layer4', 'layer5', 'layer6', 'layer7']
          : ['layer1', 'layer2', 'layer3', 'layer4', 'layer5', 'layer6', 'layer7', 'layer8'])
      expect(result.artifact.prompt['second.detail.extra']!.outputMembers?.layers).toEqual(keys.slice(1, 7))
    }
  })

  for (const [context, level, path] of [
    ['one-level', 1, 'first.sample'], ['two-levels', 2, 'first.detail.sample'],
  ] as const) {
    it(`boundary/plain-field/${context}`, () => {
      const store = storeFor(boundarySample(level))
      expect(prompt(boundarySample(0)).first!.inputs.strength).toBe(0.2)
      expect(prompt(store.doc)[path]!.inputs.strength).toBe(0.2)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'strength', value: 0.9 })
      expect(prompt(store.doc)[path]!.inputs.strength).toBe(0.9)
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc)[second]!.inputs.strength).toBe(0.8)
      expect(store.doc.graphs.detail!.nodes.sample!.values.strength).toBe(0.3)
      if (level === 2) expect(store.doc.graphs.portrait!.nodes.detail!.values.strength).toBe(0.6)
      expect(store.undo()).toBe(true)
      expect(prompt(store.doc)[path]!.inputs.strength).toBe(0.2)
      expect(store.redo()).toBe(true)
      const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(prompt(loaded)[path]!.inputs.strength).toBe(0.9)
      expect(prompt(loaded)[second]!.inputs.strength).toBe(0.8)
      const first = loaded.graphs.root!.nodes.first!
      const absentOuter = { ...loaded, graphs: { ...loaded.graphs, root: { ...loaded.graphs.root!, nodes: {
        ...loaded.graphs.root!.nodes, first: { ...first, values: {} },
      } } } }
      expect(prompt(absentOuter)[path]!.inputs.strength).toBe(level === 1 ? 0.3 : 0.6)
      if (level === 2) {
        const middle = loaded.graphs.portrait!.nodes.detail!
        const absentMiddle = { ...absentOuter, graphs: { ...absentOuter.graphs, portrait: { ...loaded.graphs.portrait!,
          nodes: { detail: { ...middle, values: {} } },
        } } }
        expect(prompt(absentMiddle)[path]!.inputs.strength).toBe(0.3)
        expect(prompt(absentMiddle)[second]!.inputs.strength).toBe(0.8)
      }
    })

    it(`boundary/plain-pin/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'image' } })
      expect(prompt(store.doc)[path]!.inputs.image).toEqual(['imageA', 0])
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'maskB', port: 'mask' }, to: { node: 'first', port: 'mask' } })
      expect(prompt(store.doc)[path]!.inputs.mask).toEqual(['maskB', 0])
      expect(prompt(store.doc)[path]!.inputs.image).toEqual(['imageA', 0])
    })

    it(`boundary/output/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'output91' }, to: { node: 'sink', port: 'number' } })
      // Two definition member outputs, three counted outputs, result, then 91.
      expect(prompt(store.doc).sink!.inputs.number).toEqual([path, 6])
    })

    it(`boundary/whole-choice/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.text', value: 'outer dormant text' })
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('outer dormant text')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'image' })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.text')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('outer dormant text')
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc)[second]!.inputs['mode.text']).toBe('second text')
    })

    it(`boundary/counted-outputs/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'outputs.o2' }, to: { node: 'sink', port: 'number' } })
      expect(prompt(store.doc).sink!.inputs.number).toEqual([path, 4])
      const wired = store.doc
      const result = store.dispatch({ command: 'node.setValue', params: { graphId: 'root', nodeId: 'first', inputId: 'count', value: 1 } })
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(Object.values(store.doc.graphs.root!.links)).toEqual([])
      expect(prompt(store.doc).sink!.inputs).not.toHaveProperty('number')
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(wired)
      expect(prompt(store.doc).sink!.inputs.number).toEqual([path, 4])
      expect(store.redo()).toBe(true)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'count', value: 3 })
      expect(Object.values(store.doc.graphs.root!.links)).toEqual([])
      expect(prompt(store.doc).sink!.inputs).not.toHaveProperty('number')
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc)[second]!.inputs.count).toBe(2)
    })

    it(`boundary/whole-group/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [{ construct: 'layers', members: ['layer0', 'layer1'] }] })
      edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: { 'layers.layer0.strength': 0.2, 'layers.layer1.strength': 0.8 } })
      expect(prompt(store.doc)[path]!.inputs).toMatchObject({
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
        'layers.layer2.strength': 0.2, 'layers.layer3.strength': 0.8,
      })
      expect(prompt(store.doc)[path]!.outputMembers?.layers).toEqual(['layer0', 'layer1', 'layer2', 'layer3'])
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc)[second]!.outputMembers?.layers).toEqual(['layer0', 'layer1'])
    })

    it(`boundary/multi-row-member/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [{ construct: 'layers', members: ['layer0'] }] })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'layers.layer0.strength', value: 0.8 })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'layers.layer0.image' } })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'layers.layer0.result' }, to: { node: 'sink', port: 'number' } })
      const compiled = prompt(store.doc)
      expect(compiled[path]!.inputs['layers.layer2.image']).toEqual(['imageA', 0])
      expect(compiled[path]!.inputs['layers.layer2.strength']).toBe(0.8)
      expect(compiled.sink!.inputs.number).toEqual([path, 2])
    })

    it(`boundary/nested-group/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'node.setValues', { graphId: 'detail', nodeId: 'sample', values: {
        'nested.n0.weights.w0': 0.2, 'nested.n1.weights.w0': 0.8, 'nested.n1.weights.w1': 0.9,
      } })
      expect(prompt(store.doc)[path]!.inputs).toMatchObject({
        'nested.n0.weights.w0': 0.2, 'nested.n1.weights.w0': 0.8, 'nested.n1.weights.w1': 0.9,
      })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('nested.n0.weights.w1')
    })

    it(`boundary/type-choice/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'dynamic.specializeSlot', { graphId: 'root', nodeId: 'first', construct: 'source', variant: 'mask' })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'source.gain', value: 0.8 })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'maskB', port: 'mask' }, to: { node: 'first', port: 'source' } })
      expect(prompt(store.doc)[path]!.slotVariants).toEqual({ mode: 'image', source: 'mask' })
      expect(prompt(store.doc)[path]!.inputs).toMatchObject({ source: ['maskB', 0], 'source.gain': 0.8 })
    })

    it(`boundary/described-inputs/${context}`, () => {
      const store = storeFor(boundarySample(level))
      const description = '{"entries":[{"id":"text","label":"Caption A","kind":"text"}]}'
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'description', value: description })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'description.text', value: 'outer caption' })
      expect(prompt(store.doc)[path]!.inputs).toMatchObject({ description, 'description.text': 'outer caption' })
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc)[second]!.inputs).not.toHaveProperty('description.text')
    })

    it(`boundary/active-option-row/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.mix', value: 0.8 })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'mode.picture' } })
      expect(prompt(store.doc)[path]!.inputs).toMatchObject({ 'mode.mix': 0.8, 'mode.picture': ['imageA', 0] })
    })

    it(`boundary/inactive-option-row/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.text', value: 'retained text' })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.text')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('retained text')
    })

    it(`boundary/described-outputs/${context}`, () => {
      const store = storeFor(boundarySample(level))
      const description = '{"entries":[{"id":"number","label":"Result B","kind":"number"}]}'
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'description', value: description })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'description.number' }, to: { node: 'sink', port: 'number' } })
      expect(prompt(store.doc).sink!.inputs.number).toEqual([path, 2])
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'description', value: '{"entries":[{"id":"number","label":"Renamed B","kind":"number"}]}' })
      expect(prompt(store.doc).sink!.inputs.number).toEqual([path, 2])
    })

    it(`boundary/one-member/${context}`, () => {
      const doc = boundarySample(level)
      // Expose a definition member, rather than giving its group a second owner.
      const detail = doc.graphs.detail!
      const body = detail.boundary!.body.filter((row) => !('id' in row && row.id === 'layers'))
      const member = { kind: 'input', id: 'memberStrength', promoted: true,
        binds: { kind: 'port', node: 'sample', port: 'layers.layer1.strength' } }
      Object.assign(detail, { boundary: { body: [...body, member] } })
      if (level === 2) {
        const portrait = doc.graphs.portrait!
        Object.assign(portrait, { boundary: { body: [
          ...portrait.boundary!.body.filter((row) => !('id' in row && row.id === 'layers')),
          { ...member, binds: { kind: 'port', node: 'detail', port: 'memberStrength' } },
        ] } })
      }
      const store = storeFor(doc)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'memberStrength', value: 0.8 })
      expect(prompt(store.doc)[path]!.inputs['layers.layer1.strength']).toBe(0.8)
      edit(store, 'dynamic.moveMember', { graphId: 'detail', nodeId: 'sample', construct: 'layers', member: 'layer1', index: 0 })
      expect(prompt(store.doc)[path]!.inputs['layers.layer1.strength']).toBe(0.8)
      expect(prompt(store.doc)[path]!.outputMembers?.layers).toEqual(['layer1', 'layer0'])
    })

    for (const feature of ['sections', 'shared-lines'] as const) {
      it(`boundary/${feature}/${context}`, () => {
        const store = storeFor(boundarySample(level))
        const before = prompt(store.doc)
        const graphId = level === 1 ? 'detail' : 'portrait'
        const fields = ['strength', 'radius', 'feather', 'balance']
        const rest = store.doc.graphs[graphId]!.boundary!.body
          .filter((row) => !('id' in row && fields.includes(row.id)))
          .map((row) => ({ kind: row.kind, id: (row as { id: string }).id }))
        const rows = fields.map((id) => ({ kind: 'input', id }))
        const layout: Json = feature === 'sections'
          ? { kind: 'section', id: 'look', collapsedByDefault: true, rows: [
            { kind: 'section', id: 'detailLook', rows },
          ] }
          : { kind: 'line', rows }
        edit(store, 'boundary.arrange', { graphId, body: [...rest, layout] })
        expect(prompt(store.doc)).toEqual(before)
      })
    }
  }

  it('boundary/plain-field/two-instances', () => {
    const store = storeFor(boundarySample(2))
    expect(prompt(store.doc)['first.detail.sample']!.inputs.strength).toBe(0.2)
    expect(prompt(store.doc)['second.detail.sample']!.inputs.strength).toBe(0.8)
    edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'strength', value: 0.9 })
    expect(prompt(store.doc)['first.detail.sample']!.inputs.strength).toBe(0.9)
    expect(prompt(store.doc)['second.detail.sample']!.inputs.strength).toBe(0.8)
    expect(store.doc.graphs.portrait!.nodes.detail!.values.strength).toBe(0.6)
    expect(store.doc.graphs.detail!.nodes.sample!.values.strength).toBe(0.3)
  })

  it('boundary/plain-field/linked-outside', () => {
    for (const level of [1, 2] as const) for (const [type, port, expected] of [
      ['dinkster.utilities.primitive_float', 'value', 0.9], ['FloatSource', 'number', ['outside', 0]],
    ] as const) {
      const doc = boundarySample(level)
      const first = level === 1 ? 'first.sample' : 'first.detail.sample'
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      Object.assign(doc.graphs.root!.nodes, { outside: { id: 'outside', type, values: { value: 0.9 } } })
      const store = storeFor(doc)
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'outside', port }, to: { node: 'first', port: 'strength' } })
      expect(prompt(store.doc)[first]!.inputs.strength).toEqual(expected)
      expect(prompt(store.doc)[second]!.inputs.strength).toBe(0.8)
      const link = Object.values(store.doc.graphs.root!.links).find((item) => 'port' in item.to && item.to.node === 'first' && item.to.port === 'strength')!
      edit(store, 'link.disconnect', { graphId: 'root', linkId: link.id })
      expect(prompt(store.doc)[first]!.inputs.strength).toBe(0.2)
      expect(store.undo()).toBe(true)
      expect(prompt(store.doc)[first]!.inputs.strength).toEqual(expected)
      expect(store.redo()).toBe(true)
      const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(prompt(loaded)[first]!.inputs.strength).toBe(0.2)
      expect(prompt(loaded)[second]!.inputs.strength).toBe(0.8)
    }
  })

  it('boundary/plain-field/fan-out', () => {
    const doc = boundarySample(1)
    Object.assign(doc.graphs.detail!.nodes, { other: { ...structuredClone(doc.graphs.detail!.nodes.sample!), id: 'other' } })
    const store = storeFor(doc)
    edit(store, 'boundary.addBinding', { graphId: 'detail', itemId: 'strength', node: 'other', port: 'strength' })
    edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'strength', value: 0.9 })
    expect(prompt(store.doc)['first.sample']!.inputs.strength).toBe(0.9)
    expect(prompt(store.doc)['first.other']!.inputs.strength).toBe(0.9)
    expect(prompt(store.doc)['second.sample']!.inputs.strength).toBe(0.8)
    expect(prompt(store.doc)['second.other']!.inputs.strength).toBe(0.8)
  })

  it('boundary/counted-outputs/linked-outside', () => {
    const doc = boundarySample(2)
    Object.assign(doc.graphs.root!.nodes, { outside: { id: 'outside', type: 'IntSource', values: {} } })
    const store = storeFor(doc)
    const before = structuredClone(store.doc)
    const result = store.dispatch({ command: 'link.connect', params: { graphId: 'root', from: { node: 'outside', port: 'number' }, to: { node: 'first', port: 'count' } } })
    expect(result.ok).toBe(false)
    expect(store.doc).toEqual(before)
  })
})
