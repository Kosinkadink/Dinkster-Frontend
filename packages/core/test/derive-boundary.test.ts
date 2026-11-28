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
import { elaborateInterface, elabInputsOf, type LookupAnswerState } from '../src/schema/elaborate.js'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'
import { inputsOf, outputsOf, type GroupSpec, type NodeSchema } from '../src/schema/model.js'
import { boundaryOf } from '../src/format/document.js'
import { MAX_GROUP_MEMBERS, memberLimitOf } from '../src/schema/body.js'
import { boundarySample, boundarySampleSchema, resolveBoundarySample } from './fixtures/boundary-sample.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import { documentResolver } from '../src/compile/compile.js'
import { loadDocument } from '../src/format/migrate.js'
import { lifecycleCanonicalHash, lifecycleFlattenFingerprint, lifecycleSelectionFingerprint, planFlattenBoundaryRoutes } from '../src/lifecycle/planner.js'
import { planFlattenOccurrenceTopology } from '../src/compile/effective-topology.js'

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

  it.each([0, 1, 2])('keeps group-key option order occurrence-local through %i boundaries', (depth) => {
    const { schema: picker, diagnostics } = parseDinksterSchema('GroupPicker', { body: [
      { kind: 'group', id: 'layers', grows: 'button', keys: { named: ['red', 'blue', 'gold'] },
        value: { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 } },
      { kind: 'input', id: 'pick', label: 'Selected layer', tooltip: 'Choose an existing member',
        required: false, onAbsent: 'omit', readOnly: false, disabled: false, disabledReason: 'Selection unavailable',
        acceptsStorage: true, acceptsStream: true, type: { kind: 'concrete', types: ['COMBO'] },
        widget: { type: 'COMBO', options: { formula: 'keys(layers)' } } },
    ] } as never)
    expect(diagnostics).toEqual([])
    const inner = asDef({ id: 'gW', name: 'Detail pass', nodes: { sample: { id: 'sample', type: 'GroupPicker', values: {}, dynamic: { layers: { members: [] } } } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: { body: [
        { kind: 'input', id: 'stack', binds: { kind: 'construct', node: 'sample', port: 'layers' } },
        { kind: 'input', id: 'selection', binds: { kind: 'port', node: 'sample', port: 'pick' }, promoted: true },
      ] } })
    const innerSchema = deriveBoundarySchema(inner, (type) => type === 'GroupPicker' ? picker : undefined).schema!
    const outer = asDef({ id: 'gO', name: 'Portrait fix', nodes: { detail: { id: 'detail', type: '#gW', values: {}, dynamic: { stack: { members: [] } } } },
      links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
      boundary: { body: [
        { kind: 'input', id: 'list', binds: { kind: 'construct', node: 'detail', port: 'stack' } },
        { kind: 'input', id: 'chosen', binds: { kind: 'port', node: 'detail', port: 'selection' }, promoted: true },
      ] } })
    const schema = depth === 0 ? picker! : depth === 1 ? innerSchema
      : deriveBoundarySchema(outer, (type) => type === '#gW' ? innerSchema : undefined).schema!
    const group = ['layers', 'stack', 'list'][depth]!
    const selection = ['pick', 'selection', 'chosen'][depth]!
    const first = { values: { [selection]: 'blue' }, dynamic: { [group]: { members: ['gold', 'red'] } } }
    const second = { values: { [selection]: 'gold' }, dynamic: { [group]: { members: ['red', 'blue'] } } }
    const options = (node: typeof first) => {
      const result = elaborateInterface(schema, node)
      expect(result.diagnostics).toEqual([])
      const { outer: _scope, lookupScope: _lookup, ...field } = elabInputsOf(result).find((row) => row.spec.id === selection)!.spec
      expect(field).toEqual({
        kind: 'input', id: selection, type: { kind: 'concrete', name: 'COMBO' }, optional: true,
        onAbsent: 'omit', displayName: 'Selected layer', tooltip: 'Choose an existing member',
        readOnly: false, disabled: false, disabledReason: 'Selection unavailable', acceptsStorage: true, acceptsStream: true,
        widget: { widgetType: 'COMBO', options: { options: node.dynamic[group]!.members },
          looked: { options: { formula: 'keys(layers)' } } },
      })
      return field.widget!.options['options']
    }
    expect(options(first)).toEqual(['gold', 'red'])
    expect(options(second)).toEqual(['red', 'blue'])
    first.dynamic[group]!.members = ['red', 'gold']
    expect(options(first)).toEqual(['red', 'gold'])
    first.dynamic[group]!.members = []
    expect(options(first)).toEqual([])
    expect(first.values[selection]).toBe('blue')
    expect(options(second)).toEqual(['red', 'blue'])
  })

  it.each([1, 2])('keeps definition-owned group options when only the picker crosses %i boundaries', (depth) => {
    for (const [members, selected] of [[['gold', 'red'], 'on'], [[], 'on'], [['blue'], 'off']] as const) {
      const { schema: picker } = parseDinksterSchema('PrivateGroupPicker', { body: [
        { kind: 'choice', id: 'mode', options: [
          { key: 'on', rows: [{ kind: 'group', id: 'layers', grows: 'button', keys: { named: ['red', 'blue', 'gold'] },
            value: { kind: 'input', id: 'value', type: { kind: 'concrete', types: ['INT'] }, default: 1 } }] },
          { key: 'off', rows: [] },
        ] },
        { kind: 'input', id: 'pick', type: { kind: 'concrete', types: ['COMBO'] }, widget: { type: 'COMBO', options: { formula: 'keys(mode.layers)' } } },
      ] } as never)
      const inner = asDef({ id: 'gW', name: 'Detail pass', nodes: { sample: { id: 'sample', type: 'PrivateGroupPicker', values: {},
        dynamic: { mode: { selected }, 'mode.layers': { members } } } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        boundary: { body: [{ kind: 'input', id: 'selection', binds: { kind: 'port', node: 'sample', port: 'pick' }, promoted: true }] } })
      const innerSchema = deriveBoundarySchema(inner, (type) => type === 'PrivateGroupPicker' ? picker : undefined).schema!
      const outer = asDef({ id: 'gO', name: 'Portrait fix', nodes: { detail: { id: 'detail', type: '#gW', values: {} } }, links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        boundary: { body: [{ kind: 'input', id: 'chosen', binds: { kind: 'port', node: 'detail', port: 'selection' }, promoted: true }] } })
      const schema = depth === 1 ? innerSchema : deriveBoundarySchema(outer, (type) => type === '#gW' ? innerSchema : undefined).schema!
      const result = elaborateInterface(schema, { values: { [depth === 1 ? 'selection' : 'chosen']: 'blue' } })
      expect(result.diagnostics).toEqual([])
      const row = elabInputsOf(result)[0]!
      expect(row.spec.widget!.options['options']).toEqual(selected === 'off' ? undefined : members)
    }
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

    for (const [depth, [schema, category, selection]] of ([
      [picker!, 'category', 'lora'], [innerSchema, 'kind', 'pick'], [both, 'category', 'list'],
    ] as const).entries()) {
      const first = { values: { [category]: 'sd', [selection]: 'kept-first.safetensors' } }
      const second = { values: { [category]: 'sdxl', [selection]: 'kept-second.safetensors' } }
      const snapshot = structuredClone([first, second])
      const run = (node: typeof first, held?: LookupAnswerState, wired = false) => {
        const calls: unknown[] = []
        const elaborated = elaborateInterface(schema, node, {
          isInputConnected: (id) => wired && id === category, isOutputConnected: () => false,
          inputPorts: () => wired ? [category] : [], outputPorts: () => [],
        }, { lookupAnswers: (lookup, args) => { calls.push([lookup, args]); return held } })
        return { row: elabInputsOf(elaborated).find((input) => input.spec.id === selection)!, calls }
      }
      for (const node of [first, second]) {
        const args = [node.values[category]!]
        const loading = run(node)
        expect(loading.row.looked!.options).toMatchObject({ state: 'loading', call: { lookup: 'pack.loras', args } })
        expect(loading.calls).toEqual([['pack.loras', args]])
        const ready = run(node, { state: 'ready', answer: ['available.safetensors'] })
        expect(ready.row.spec.widget!.options.options).toEqual(['available.safetensors'])
        expect(ready.row.looked!.options).toMatchObject({ state: 'ready', call: { args } })
        const stale = run(node, { state: 'stale', answer: ['old.safetensors'], reason: 'timeout' })
        expect(stale.row.spec.widget!.options.options).toEqual(['old.safetensors'])
        expect(stale.row.looked!.options).toMatchObject({ state: 'stale', reason: 'timeout', call: { args } })
        const failed = run(node, { state: 'unavailable', reason: 'offline' })
        expect(failed.row.looked!.options).toMatchObject({ state: 'unavailable', reason: 'offline', call: { args } })
        expect(failed.row.spec.widget!.options).not.toHaveProperty('options')
        const wired = run(node, { state: 'ready', answer: ['wrong-arguments.safetensors'] }, true)
        expect(wired.row.looked!.options).toMatchObject({ state: 'waiting' })
        expect(wired.calls).toEqual([])
      }
      expect([first, second]).toEqual(snapshot)
      first.values[category] = 'sdxl'
      expect(run(first).row.looked!.options).toMatchObject({ state: 'loading', call: { args: ['sdxl'] } })
      expect(second.values[selection]).toBe('kept-second.safetensors')
      expect(first.values[selection]).toBe('kept-first.safetensors')
      first.values[category] = 'sd'

      const outer = asDef({
        id: 'gO', name: 'outer', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1,
        nodes: { s0: { id: 's0', type: '#gW', values: { kind: 'sdxl' } } },
        boundary: boundaryOf([port('category', 's0', 'kind'), port('list', 's0', 'pick')] as BoundaryItem[], []),
      })
      const document = {
        format: 'dinkster-workflow', formatVersion: 1, lineage: 'remote-options', root: 'root', view: { graphs: {} },
        graphs: {
          root: asDef({ id: 'root', name: 'root', links: {}, nets: {}, reroutes: {}, nextOrdinal: 1, nodes: {
            first: { id: 'first', type: ['Picker', '#gW', '#gO'][depth], values: first.values },
            second: { id: 'second', type: ['Picker', '#gW', '#gO'][depth], values: second.values },
          } }),
          ...(depth > 0 ? { gW: { ...inner, reroutes: {} } } : {}), ...(depth > 1 ? { gO: outer } : {}),
        },
      } as unknown as WorkflowDocument
      const resolver: SchemaResolver = (type) => type === 'Picker' ? { ...picker!, isOutputNode: true } : undefined
      const store = new DocumentStore(document, coreCommandRegistry(), 200, undefined,
        () => ({ kind: 'initial', schemaResolverFor: (current) => documentResolver(current, resolver) }))
      const values = (doc: WorkflowDocument) => {
        const heldStates = [
          { state: 'loading' },
          { state: 'ready', answer: ['available.safetensors'] },
          { state: 'stale', answer: ['old.safetensors'], reason: 'timeout' },
          { state: 'unavailable', reason: 'offline' },
        ] as const
        const results = heldStates.map((held) => {
          const calls: unknown[] = []
          const compiled = compile({ document: doc, revision: 1, resolve: resolver,
            scope: { kind: 'full' }, connection: asConnectionId('lookup-grid'), schemaHash: 'lookup-grid',
            lookupAnswers: (lookup, args) => { calls.push([lookup, args]); return held } })
          expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
          if (!compiled.ok) throw new Error('Remote options document did not compile')
          expect(calls).toContainEqual(['pack.loras', ['sd']])
          expect(calls).toContainEqual(['pack.loras', ['sdxl']])
          const suffix = ['', '.p0', '.s0.p0'][depth]
          expect(Object.keys(compiled.artifact.prompt).sort()).toEqual([`first${suffix}`, `second${suffix}`])
          return ['first', 'second'].map((instance) => compiled.artifact.prompt[`${instance}${suffix}`]!.inputs.lora)
        })
        for (const result of results) expect(result).toEqual(results[0])
        return results[0]
      }
      expect(values(store.doc)).toEqual(['kept-first.safetensors', 'kept-second.safetensors'])
      const before = store.doc
      expect(store.dispatch({ command: 'node.setValue', params: {
        graphId: 'root', nodeId: 'first', inputId: selection, value: 'edited-first.safetensors',
      } }).ok).toBe(true)
      expect(values(store.doc)).toEqual(['edited-first.safetensors', 'kept-second.safetensors'])
      expect(store.doc.graphs.gW).toEqual(before.graphs.gW)
      expect(store.doc.graphs.gO).toEqual(before.graphs.gO)
      expect(store.undo()).toBe(true)
      expect(values(store.doc)).toEqual(['kept-first.safetensors', 'kept-second.safetensors'])
      expect(store.redo()).toBe(true)
      const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc)))
      expect(loaded.document, JSON.stringify(loaded.diagnostics)).toBeDefined()
      expect(values(loaded.document!)).toEqual(['edited-first.safetensors', 'kept-second.safetensors'])
    }
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

      const detached = storeFor(boundarySample(level))
      const shared = detached.doc
      edit(detached, 'occurrence.localize', { graphId: 'root', nodeId: 'first' })
      const copyId = detached.doc.graphs.root!.nodes.first!.type.slice(1)
      expect(copyId).not.toBe(level === 1 ? 'detail' : 'portrait')
      expect(prompt(detached.doc)[path]!.inputs.strength).toBe(0.2)
      edit(detached, 'node.setValue', {
        graphId: copyId, nodeId: level === 1 ? 'sample' : 'detail', inputId: 'strength', value: 0.55,
      })
      // The unique definition does not replace the occurrence's stored override.
      expect(prompt(detached.doc)[path]!.inputs.strength).toBe(0.2)
      edit(detached, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'strength', value: 0.7 })
      expect(prompt(detached.doc)[path]!.inputs.strength).toBe(0.7)
      expect(prompt(detached.doc)[second]!.inputs.strength).toBe(0.8)
      expect(detached.doc.graphs.detail).toEqual(shared.graphs.detail)
      if (level === 2) expect(detached.doc.graphs.portrait).toEqual(shared.graphs.portrait)
      expect(detached.undo()).toBe(true)
      expect(prompt(detached.doc)[path]!.inputs.strength).toBe(0.2)
      expect(detached.undo()).toBe(true)
      expect(detached.undo()).toBe(true)
      expect(detached.doc).toEqual(shared)
      expect(detached.redo()).toBe(true)
      expect(detached.redo()).toBe(true)
      expect(detached.redo()).toBe(true)
      const detachedReload = loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!
      expect(prompt(detachedReload)[path]!.inputs.strength).toBe(0.7)
      expect(prompt(detachedReload)[second]!.inputs.strength).toBe(0.8)
      expect(detachedReload.graphs[copyId]!.nodes[level === 1 ? 'sample' : 'detail']!.values.strength).toBe(0.55)
      expect(detachedReload.graphs.detail).toEqual(shared.graphs.detail)
      if (level === 2) expect(detachedReload.graphs.portrait).toEqual(shared.graphs.portrait)
      const detachedFirst = detachedReload.graphs.root!.nodes.first!
      const { strength: _strength, ...remainingValues } = detachedFirst.values
      const withoutOverride = { ...detachedReload, graphs: { ...detachedReload.graphs, root: {
        ...detachedReload.graphs.root!, nodes: { ...detachedReload.graphs.root!.nodes,
          first: { ...detachedFirst, values: remainingValues },
        },
      } } }
      expect(prompt(withoutOverride)[path]!.inputs.strength).toBe(0.55)
      expect(prompt(withoutOverride)[second]!.inputs.strength).toBe(0.8)
    })

    it(`boundary/plain-pin/${context}`, () => {
      const store = storeFor(boundarySample(level))
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      const shared = store.doc.graphs.detail
      const outerSchema = documentResolver(store.doc, resolveBoundarySample)(store.doc.graphs.root!.nodes.first!.type)!
      const exposed = inputsOf(outerSchema).find((row) => row.id === 'image')!
      expect(exposed.type).toEqual(inputsOf(boundarySampleSchema).find((row) => row.id === 'image')!.type)
      expect(exposed.optional).toBe(true)
      expect(exposed.widget).toBeUndefined()
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('image')
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mask')
      expect(prompt(boundarySample(0)).first!.inputs).not.toHaveProperty('image')
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'image' } })
      expect(prompt(store.doc)[path]!.inputs.image).toEqual(['imageA', 0])
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'maskB', port: 'mask' }, to: { node: 'first', port: 'mask' } })
      expect(prompt(store.doc)[path]!.inputs.mask).toEqual(['maskB', 0])
      expect(prompt(store.doc)[path]!.inputs.image).toEqual(['imageA', 0])
      expect(prompt(store.doc)[second]!.inputs).not.toHaveProperty('image')
      expect(prompt(store.doc)[second]!.inputs).not.toHaveProperty('mask')
      const imageLink = Object.values(store.doc.graphs.root!.links).find((link) => 'port' in link.to && link.to.port === 'image')!
      edit(store, 'link.disconnect', { graphId: 'root', linkId: imageLink.id })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('image')
      expect(prompt(store.doc)[path]!.inputs.mask).toEqual(['maskB', 0])
      expect(store.undo()).toBe(true)
      expect(prompt(store.doc)[path]!.inputs.image).toEqual(['imageA', 0])
      expect(store.redo()).toBe(true)
      const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(prompt(reopened)[path]!.inputs).not.toHaveProperty('image')
      expect(prompt(reopened)[path]!.inputs.mask).toEqual(['maskB', 0])
      expect(reopened.graphs.detail).toEqual(shared)
      expect(reopened.graphs.root!.nodes.first!.values).not.toHaveProperty('image')
      expect(reopened.graphs.root!.nodes.second!.values).not.toHaveProperty('image')

      const detached = storeFor(reopened)
      edit(detached, 'occurrence.localize', { graphId: 'root', nodeId: 'first' })
      const copyId = detached.doc.graphs.root!.nodes.first!.type.slice(1)
      edit(detached, 'node.add', { graphId: copyId, type: 'ImageSource', position: { x: 0, y: 0 } })
      const inside = Object.values(detached.doc.graphs[copyId]!.nodes).find((node) => node.type === 'ImageSource')!
      const beforeWire = prompt(detached.doc)
      edit(detached, 'link.connect', { graphId: copyId, from: { node: inside.id, port: 'image' },
        to: { node: level === 1 ? 'sample' : 'detail', port: 'image' } })
      expect(prompt(detached.doc)[path]!.inputs.image).toEqual([`first.${inside.id}`, 0])
      expect(prompt(detached.doc)[second]!.inputs).not.toHaveProperty('image')
      expect(detached.doc.graphs.detail).toEqual(shared)
      if (level === 2) expect(detached.doc.graphs.portrait).toEqual(reopened.graphs.portrait)
      expect(detached.undo()).toBe(true)
      expect(prompt(detached.doc)).toEqual(beforeWire)
      expect(detached.redo()).toBe(true)
      const rewired = loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!
      expect(prompt(rewired)[path]!.inputs.image).toEqual([`first.${inside.id}`, 0])
      expect(prompt(rewired)[second]!.inputs).not.toHaveProperty('image')
      expect(rewired.graphs.detail).toEqual(shared)
      expect(prompt(rewired)[path]!.inputs.mask).toEqual(['maskB', 0])
      edit(detached, 'node.add', { graphId: copyId, type: 'ImageSource', position: { x: 100, y: 0 } })
      const replacement = Object.values(detached.doc.graphs[copyId]!.nodes)
        .find((node) => node.type === 'ImageSource' && node.id !== inside.id)!
      edit(detached, 'link.connect', { graphId: copyId, from: { node: replacement.id, port: 'image' },
        to: { node: level === 1 ? 'sample' : 'detail', port: 'image' } })
      expect(prompt(detached.doc)[path]!.inputs.image).toEqual([`first.${replacement.id}`, 0])
      expect(prompt(detached.doc)[path]!.inputs.mask).toEqual(['maskB', 0])
      expect(detached.undo()).toBe(true)
      expect(prompt(detached.doc)[path]!.inputs.image).toEqual([`first.${inside.id}`, 0])
      expect(prompt(detached.doc)[path]!.inputs.mask).toEqual(['maskB', 0])
      expect(detached.redo()).toBe(true)
      expect(prompt(detached.doc)[path]!.inputs.image).toEqual([`first.${replacement.id}`, 0])
      expect(prompt(detached.doc)[path]!.inputs.mask).toEqual(['maskB', 0])
      expect(prompt(detached.doc)[second]!.inputs).not.toHaveProperty('image')
    })

    it(`boundary/plain-pin/${context} fan-out source isolation`, () => {
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      const fanoutDoc = boundarySample(level)
      Object.assign(fanoutDoc.graphs.detail!.nodes, { other: { ...structuredClone(fanoutDoc.graphs.detail!.nodes.sample!), id: 'other' } })
      Object.assign(fanoutDoc.graphs.root!.nodes, { imageSecond: { id: 'imageSecond', type: 'ImageSource', values: {} } })
      const fanout = storeFor(fanoutDoc)
      edit(fanout, 'boundary.addBinding', { graphId: 'detail', itemId: 'image', node: 'other', port: 'image' })
      const admitted = fanout.doc
      const refused = fanout.dispatch({ command: 'boundary.addBinding', params: {
        graphId: 'detail', itemId: 'image', node: 'other', port: 'strength',
      } })
      expect(refused.ok).toBe(false)
      expect(refused.diagnostics.some((entry) => entry.code === 'boundary.fanoutTypeMismatch')).toBe(true)
      expect(fanout.doc).toBe(admitted)
      expect(fanout.undo()).toBe(true)
      expect(fanout.doc.graphs.detail!.boundary).toEqual(fanoutDoc.graphs.detail!.boundary)
      expect(fanout.redo()).toBe(true)
      edit(fanout, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'image' } })
      const otherPath = level === 1 ? 'first.other' : 'first.detail.other'
      const otherSecond = level === 1 ? 'second.other' : 'second.detail.other'
      for (const target of [path, otherPath]) expect(prompt(fanout.doc)[target]!.inputs.image).toEqual(['imageA', 0])
      for (const target of [second, otherSecond]) expect(prompt(fanout.doc)[target]!.inputs).not.toHaveProperty('image')
      edit(fanout, 'link.connect', { graphId: 'root', from: { node: 'imageSecond', port: 'image' }, to: { node: 'second', port: 'image' } })
      for (const target of [path, otherPath]) expect(prompt(fanout.doc)[target]!.inputs.image).toEqual(['imageA', 0])
      for (const target of [second, otherSecond]) expect(prompt(fanout.doc)[target]!.inputs.image).toEqual(['imageSecond', 0])
      edit(fanout, 'boundary.unbind', { graphId: 'detail', side: 'inputs', itemId: 'image', node: 'sample', port: 'image' })
      expect(prompt(fanout.doc)[path]!.inputs).not.toHaveProperty('image')
      expect(prompt(fanout.doc)[otherPath]!.inputs.image).toEqual(['imageA', 0])
      expect(prompt(fanout.doc)[second]!.inputs).not.toHaveProperty('image')
      expect(prompt(fanout.doc)[otherSecond]!.inputs.image).toEqual(['imageSecond', 0])
      expect(fanout.undo()).toBe(true)
      expect(prompt(fanout.doc)[path]!.inputs.image).toEqual(['imageA', 0])
      expect(fanout.redo()).toBe(true)
      const fanoutReload = loadDocument(JSON.parse(JSON.stringify(fanout.doc))).document!
      expect(prompt(fanoutReload)[path]!.inputs).not.toHaveProperty('image')
      expect(prompt(fanoutReload)[otherPath]!.inputs.image).toEqual(['imageA', 0])
      expect(prompt(fanoutReload)[second]!.inputs).not.toHaveProperty('image')
      expect(prompt(fanoutReload)[otherSecond]!.inputs.image).toEqual(['imageSecond', 0])
    })

    it(`boundary/plain-pin/${context} literal and runtime delivery`, () => {
      // A FLOAT pin also accepts a known literal; IMAGE/MASK require runtime data.
      for (const literal of [true, false]) {
        const numericDoc = boundarySample(level)
        Object.assign(numericDoc.graphs.detail!.nodes, { receiver: { id: 'receiver', type: 'NumberSink', values: {} } })
        Object.assign(numericDoc.graphs.root!.nodes, { numericSource: { id: 'numericSource',
          type: literal ? 'dinkster.utilities.primitive_float' : 'FloatSource', values: literal ? { value: 0.65 } : {},
        }, numericSecond: { id: 'numericSecond',
          type: literal ? 'dinkster.utilities.primitive_float' : 'FloatSource', values: literal ? { value: 0.35 } : {},
        } })
        const numeric = storeFor(numericDoc)
        edit(numeric, 'boundary.addItem', { graphId: 'detail', side: 'inputs', itemId: 'number', node: 'receiver', port: 'number' })
        if (level === 2) edit(numeric, 'boundary.addItem', {
          graphId: 'portrait', side: 'inputs', itemId: 'amount', node: 'detail', port: 'number',
        })
        const field = level === 1 ? 'number' : 'amount'
        const receiver = level === 1 ? 'first.receiver' : 'first.detail.receiver'
        const receiverSecond = level === 1 ? 'second.receiver' : 'second.detail.receiver'
        expect(prompt(numeric.doc)[receiver]!.inputs).not.toHaveProperty('number')
        const input = inputsOf(documentResolver(numeric.doc, resolveBoundarySample)(numeric.doc.graphs.root!.nodes.first!.type)!)
          .find((row) => row.id === field)!
        expect(input.optional).toBe(true)
        expect(input.widget).toBeUndefined()
        edit(numeric, 'link.connect', { graphId: 'root', from: { node: 'numericSource', port: literal ? 'value' : 'number' },
          to: { node: 'first', port: field } })
        expect(prompt(numeric.doc)[receiver]!.inputs.number).toEqual(literal ? 0.65 : ['numericSource', 0])
        expect(prompt(numeric.doc)[receiverSecond]!.inputs).not.toHaveProperty('number')
        edit(numeric, 'link.connect', { graphId: 'root', from: { node: 'numericSecond', port: literal ? 'value' : 'number' },
          to: { node: 'second', port: field } })
        expect(prompt(numeric.doc)[receiver]!.inputs.number).toEqual(literal ? 0.65 : ['numericSource', 0])
        expect(prompt(numeric.doc)[receiverSecond]!.inputs.number).toEqual(literal ? 0.35 : ['numericSecond', 0])
        const numericLink = Object.values(numeric.doc.graphs.root!.links)[0]!
        edit(numeric, 'link.disconnect', { graphId: 'root', linkId: numericLink.id })
        expect(prompt(numeric.doc)[receiver]!.inputs).not.toHaveProperty('number')
        expect(prompt(numeric.doc)[receiverSecond]!.inputs.number).toEqual(literal ? 0.35 : ['numericSecond', 0])
        expect(numeric.undo()).toBe(true)
        expect(prompt(numeric.doc)[receiver]!.inputs.number).toEqual(literal ? 0.65 : ['numericSource', 0])
        expect(numeric.redo()).toBe(true)
        const numericReload = loadDocument(JSON.parse(JSON.stringify(numeric.doc))).document!
        expect(prompt(numericReload)[receiver]!.inputs).not.toHaveProperty('number')
        expect(prompt(numericReload)[receiverSecond]!.inputs.number).toEqual(literal ? 0.35 : ['numericSecond', 0])
      }
    })

    it(`boundary/plain-pin/${context} flatten history`, () => {
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      for (const mode of ['active', 'muted', 'bypassed'] as const) {
        const flat = storeFor(boundarySample(level))
        edit(flat, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'image' } })
        edit(flat, 'link.connect', { graphId: 'root', from: { node: 'maskB', port: 'mask' }, to: { node: 'first', port: 'mask' } })
        if (mode !== 'active') edit(flat, 'node.setMode', { graphId: 'root', nodeIds: ['first'], mode })
        const before = flat.doc
        const root = before.graphs.root!
        const occurrence = root.nodes.first!
        const body = before.graphs[occurrence.type.slice(1)]!
        const resolver = documentResolver(before, resolveBoundarySample)
        const plan = planFlattenBoundaryRoutes(body, resolver, occurrence, root)
        const topology = planFlattenOccurrenceTopology(before, resolver, { instancePath: [], node: asNodeId('first') })
        const topologyParams = topology.plan === undefined ? {} : {
          occurrenceTopologyPlan: topology.plan, occurrenceTopologyPlanDigest: lifecycleCanonicalHash(topology.plan),
        }
        const outcome = flat.dispatch({ command: 'subgraph.flatten', params: {
          graphId: 'root', instancePath: [], nodeId: 'first', placementCenter: { x: 100, y: 100 },
          resolvedGeometry: {
            occurrence: { id: 'first', kind: 'node', x: 0, y: 0, width: 200, height: 200 },
            body: Object.keys(body.nodes).map((id) => ({ id, kind: 'node', x: 0, y: 0, width: 200, height: 200 })),
          },
          boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaSnapshot: plan.schemaSnapshot,
          schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams,
          selectionFingerprint: lifecycleFlattenFingerprint(before, 'root', 'first', {
            boundaryPlan: plan.boundaryPlan, statePlan: plan.statePlan, schemaPlanDigest: plan.schemaPlanDigest, ...topologyParams,
          }),
        } } as never)
        if (mode === 'bypassed') {
          expect(outcome.ok).toBe(false)
          expect(outcome.diagnostics.map((entry) => entry.code)).toContain('subgraph.flatten.modeUnsupported')
          expect(flat.doc).toBe(before)
          expect(flat.undo()).toBe(true)
          expect(flat.doc.graphs.root!.nodes.first!.mode).not.toBe('bypassed')
          continue
        }
        expect(outcome.ok, JSON.stringify(outcome.diagnostics)).toBe(true)
        const replacement = Object.values(flat.doc.graphs.root!.nodes).find((node) =>
          root.nodes[node.id] === undefined && node.type === (level === 1 ? 'Boundary sample' : '#detail'))!
        expect(replacement).toBeDefined()
        const replacementPath = level === 1 ? replacement.id : `${replacement.id}.sample`
        const check = (doc: WorkflowDocument, firstPath: string) => {
          const compiled = prompt(doc)
          if (mode === 'active') {
            expect(compiled[firstPath]!.inputs.image).toEqual(['imageA', 0])
            expect(compiled[firstPath]!.inputs.mask).toEqual(['maskB', 0])
          } else expect(compiled[firstPath]).toBeUndefined()
          expect(compiled[second]!.inputs).not.toHaveProperty('image')
          expect(compiled[second]!.inputs).not.toHaveProperty('mask')
          expect(doc.graphs.detail).toEqual(before.graphs.detail)
          if (level === 2) expect(doc.graphs.portrait).toEqual(before.graphs.portrait)
        }
        check(flat.doc, replacementPath)
        const flattened = flat.doc
        const flattenedPrompt = prompt(flattened)
        expect(flat.undo()).toBe(true)
        const { nextOrdinal: _beforeOrdinal, ...beforeRoot } = root
        const { nextOrdinal: _undoneOrdinal, ...undoneRoot } = flat.doc.graphs.root!
        expect(undoneRoot).toEqual(beforeRoot)
        expect(flat.doc.view).toEqual(before.view)
        expect(flat.doc.graphs.root!.nextOrdinal).toBeGreaterThanOrEqual(flattened.graphs.root!.nextOrdinal)
        check(flat.doc, path)
        expect(flat.redo()).toBe(true)
        check(flat.doc, replacementPath)
        expect(flat.doc.graphs).toEqual(flattened.graphs)
        expect(flat.doc.view).toEqual(flattened.view)
        expect(prompt(flat.doc)).toEqual(flattenedPrompt)
        const reloaded = loadDocument(JSON.parse(JSON.stringify(flat.doc))).document!
        check(reloaded, replacementPath)
        expect(reloaded.graphs).toEqual(flattened.graphs)
        expect(reloaded.view).toEqual(flattened.view)
        expect(prompt(reloaded)).toEqual(flattenedPrompt)
      }
    })

    it(`boundary/output/${context}`, () => {
      const doc = boundarySample(level)
      Object.assign(doc.graphs.root!.nodes, {
        otherSink: { ...doc.graphs.root!.nodes.sink!, id: 'otherSink' },
        siblingSink: { ...doc.graphs.root!.nodes.sink!, id: 'siblingSink' },
      })
      const store = storeFor(doc)
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'output91' }, to: { node: 'sink', port: 'number' } })
      // Two definition member outputs, three counted outputs, result, then 91.
      expect(prompt(store.doc).sink!.inputs.number).toEqual([path, 6])
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'second', port: 'output91' }, to: { node: 'siblingSink', port: 'number' } })
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc).siblingSink!.inputs.number).toEqual([second, 5])
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'output91' }, to: { node: 'otherSink', port: 'number' } })
      expect(prompt(store.doc).otherSink!.inputs.number).toEqual([path, 6])
      const wired = store.doc
      for (const command of ['boundary.addItem', 'boundary.addBinding']) {
        const refused = store.dispatch({ command, params: {
          graphId: 'detail', side: 'outputs', itemId: 'output91', node: 'sample', port: 'result',
        } })
        expect(refused.ok).toBe(false)
        expect(refused.diagnostics.some((entry) => entry.code ===
          (command === 'boundary.addItem' ? 'boundary.duplicateId' : 'boundary.itemMissing'))).toBe(true)
        expect(store.doc).toBe(wired)
      }
      const malformed = JSON.parse(JSON.stringify(wired))
      malformed.graphs.detail.boundary.body.find((row: { id: string }) => row.id === 'output91')
        .alsoBinds = [{ kind: 'port', node: 'sample', port: 'result' }]
      const rejected = loadDocument(malformed)
      expect(rejected.document).toBeUndefined()
      expect(rejected.diagnostics.some((entry) => entry.message.includes('an output has exactly one source'))).toBe(true)
      expect(store.undo()).toBe(true)
      expect(prompt(store.doc).otherSink!.inputs).not.toHaveProperty('number')
      expect(prompt(store.doc).sink!.inputs.number).toEqual([path, 6])
      expect(store.redo()).toBe(true)
      const loaded = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      for (const target of ['sink', 'otherSink']) expect(prompt(loaded)[target]!.inputs.number).toEqual([path, 6])
      expect(prompt(loaded).siblingSink!.inputs.number).toEqual([second, 5])

      const detached = storeFor(loaded)
      edit(detached, 'occurrence.localize', { graphId: 'root', nodeId: 'first' })
      const copyId = detached.doc.graphs.root!.nodes.first!.type.slice(1)
      edit(detached, 'boundary.setBinding', { graphId: copyId, side: 'outputs', itemId: 'output91',
        node: level === 1 ? 'sample' : 'detail', port: 'result' })
      // Replacing one unique definition's source is not appending a second source.
      for (const target of ['sink', 'otherSink']) expect(prompt(detached.doc)[target]!.inputs.number).toEqual([path, 5])
      expect(prompt(detached.doc).siblingSink!.inputs.number).toEqual([second, 5])
      expect(detached.doc.graphs.detail).toEqual(loaded.graphs.detail)
      if (level === 2) expect(detached.doc.graphs.portrait).toEqual(loaded.graphs.portrait)
      expect(detached.undo()).toBe(true)
      expect(prompt(detached.doc).sink!.inputs.number).toEqual([path, 6])
      expect(detached.redo()).toBe(true)
      const detachedReload = loadDocument(JSON.parse(JSON.stringify(detached.doc))).document!
      expect(prompt(detachedReload).sink!.inputs.number).toEqual([path, 5])
      expect(prompt(detachedReload).otherSink!.inputs.number).toEqual([path, 5])
      expect(prompt(detachedReload).siblingSink!.inputs.number).toEqual([second, 5])
    })

    it(`boundary/whole-choice/${context}`, () => {
      const store = storeFor(boundarySample(level))
      const original = store.doc
      const native = boundarySampleSchema.body.find((row) => row.kind === 'choice' && row.id === 'mode')!
      const forwarded = documentResolver(original, resolveBoundarySample)(level === 1 ? '#detail' : '#portrait')!
        .body.find((row) => row.kind === 'choice' && row.id === 'mode')!
      if (native.kind !== 'choice' || forwarded.kind !== 'choice') throw new Error('choice fixture missing')
      const { outer: _choiceScope, ...choice } = forwarded
      expect(choice).toEqual({ ...native, options: native.options.map((option) => ({ ...option,
        rows: option.rows.map((row) => row.kind === 'input' && row.id === 'text'
          ? { ...row, widget: { ...row.widget!, default: 'dormant inner text' } } : row),
      })) })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.text', value: 'outer dormant text' })
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('outer dormant text')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'image' })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.text')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('outer dormant text')
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc)[second]!.inputs['mode.text']).toBe('second text')
      const selected = store.doc
      const plain = storeFor(boundarySample(0))
      edit(plain, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
      } })
      edit(plain, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.text', value: 'outer dormant text' })
      edit(plain, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      const reference = prompt(plain.doc).first!
      for (const current of [selected, loadDocument(JSON.parse(JSON.stringify(selected))).document!]) {
        const compiled = prompt(current)
        expect(compiled[path]).toEqual(reference)
        expect(compiled[path]!.slotVariants?.mode).toBe('text')
        expect(compiled[path]!.inputs['mode.mix']).toBe(0.3)
        expect(compiled[path]!.inputs['mode.text']).toBe('outer dormant text')
        expect(compiled[second]).toEqual(prompt(original)[second])
        expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(original.graphs.detail)
        expect(current.graphs.portrait).toEqual(original.graphs.portrait)
      }
      expect(store.undo()).toBe(true)
      expect(prompt(store.doc)[path]!.slotVariants?.mode).toBe('image')
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.text')
      expect(store.doc.graphs.root!.nodes.first!.values['mode.text']).toBe('outer dormant text')
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(selected)
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
      const original = store.doc
      const native = boundarySampleSchema.body.find((row) => row.kind === 'group' && row.id === 'layers')!
      const forwarded = documentResolver(original, resolveBoundarySample)(level === 1 ? '#detail' : '#portrait')!
        .body.find((row) => row.kind === 'group' && row.id === 'layers')!
      if (native.kind !== 'group' || forwarded.kind !== 'group') throw new Error('group fixture missing')
      const { outer: _groupScope, ...group } = forwarded
      expect(group).toEqual({ ...native, maxMembers: 6, interiorMembers: 2 })
      edit(store, 'dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [{ construct: 'layers', members: ['layer0', 'layer1'] }] })
      edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: { 'layers.layer0.strength': 0.2, 'layers.layer1.strength': 0.8 } })
      expect(prompt(store.doc)[path]!.inputs).toMatchObject({
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
        'layers.layer2.strength': 0.2, 'layers.layer3.strength': 0.8,
      })
      expect(prompt(store.doc)[path]!.outputMembers?.layers).toEqual(['layer0', 'layer1', 'layer2', 'layer3'])
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(prompt(store.doc)[second]!.outputMembers?.layers).toEqual(['layer0', 'layer1'])
      const beforeEdit = store.doc
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'layers.layer0.strength', value: 0.9 })
      const edited = store.doc
      const plain = storeFor(boundarySample(0))
      edit(plain, 'dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [{ construct: 'layers', members: ['layer0', 'layer1', 'layer2', 'layer3'] }] })
      edit(plain, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
        'layers.layer2.strength': 0.9, 'layers.layer3.strength': 0.8,
      } })
      const reference = prompt(plain.doc).first!
      for (const current of [edited, loadDocument(JSON.parse(JSON.stringify(edited))).document!]) {
        const compiled = prompt(current)
        expect(compiled[path]).toEqual(reference)
        expect(compiled[path]!.inputs).toMatchObject({
          'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
          'layers.layer2.strength': 0.9, 'layers.layer3.strength': 0.8,
        })
        expect(compiled[path]!.outputMembers?.layers).toEqual(['layer0', 'layer1', 'layer2', 'layer3'])
        expect(compiled[second]).toEqual(prompt(original)[second])
        expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(original.graphs.detail)
        expect(current.graphs.portrait).toEqual(original.graphs.portrait)
      }
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(beforeEdit)
      expect(prompt(store.doc)[path]!.inputs['layers.layer2.strength']).toBe(0.2)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(edited)
    })

    it(`boundary/whole-construct-fallback/${context}`, () => {
      const document = boundarySample(level)
      const detail = document.graphs.detail!
      Object.assign(detail, { boundary: { body: detail.boundary!.body.map((row) =>
        'id' in row && row.id === 'layers' ? { ...row, id: 'weights' }
          : 'id' in row && row.id === 'mode' ? { ...row, id: 'pick' } : row) } })
      Object.assign(detail.nodes.sample!.values, { 'mode.mix': 0.4 })
      if (level === 2) {
        const portrait = document.graphs.portrait!
        Object.assign(portrait, { boundary: { body: portrait.boundary!.body.map((row) =>
          'id' in row && row.id === 'layers' ? { ...row, id: 'strokes', binds: { kind: 'construct', node: 'detail', port: 'weights' } }
            : 'id' in row && row.id === 'mode' ? { ...row, id: 'treatment', binds: { kind: 'construct', node: 'detail', port: 'pick' } } : row) } })
        Object.assign(portrait.nodes.detail!, {
          values: { 'weights.layer0.strength': 0.6, 'pick.mix': 0.6, 'pick.text': 'middle text' },
          dynamic: { weights: { members: ['layer0'] }, pick: { selected: 'image' } },
        })
      }
      const group = level === 1 ? 'weights' : 'strokes'
      const choice = level === 1 ? 'pick' : 'treatment'
      for (const [nodeId, mix, text, members] of [
        ['first', 0.2, 'outer text', ['layer0', 'layer1']],
        ['second', 0.8, 'second text', ['layer0']],
      ] as const) Object.assign(document.graphs.root!.nodes[nodeId]!, {
        values: { [`${group}.layer0.strength`]: mix, [`${group}.layer1.strength`]: 0.9,
          [`${choice}.mix`]: mix, [`${choice}.text`]: text },
        dynamic: { [group]: { members }, [choice]: { selected: 'text' } },
      })
      const store = storeFor(document)
      const original = store.doc
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      const sibling = prompt(original)[second]
      const suffix = level === 1 ? 'layer2' : 'layer3'
      const check = (mix: number, text: string, strength: number) => {
        for (const current of [store.doc, loadDocument(JSON.parse(JSON.stringify(store.doc))).document!]) {
          const compiled = prompt(current)
          expect(compiled[path]!.inputs).toMatchObject({
            'mode.mix': mix, 'mode.text': text,
            'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
            [`layers.${suffix}.strength`]: strength,
            [`layers.layer${level === 1 ? 3 : 4}.strength`]: 0.9,
            ...(level === 2 ? { 'layers.layer2.strength': 0.6 } : {}),
          })
          expect(compiled[path]!.slotVariants?.mode).toBe('text')
          expect(compiled[path]!.outputMembers?.layers).toEqual(level === 1
            ? ['layer0', 'layer1', 'layer2', 'layer3'] : ['layer0', 'layer1', 'layer2', 'layer3', 'layer4'])
          expect(compiled[second]).toEqual(sibling)
          expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        }
      }
      check(0.2, 'outer text', 0.2)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: `${group}.layer0.strength`, value: 0.9 })
      check(0.2, 'outer text', 0.9)
      expect(store.doc.graphs.detail).toEqual(original.graphs.detail)
      expect(store.doc.graphs.portrait).toEqual(original.graphs.portrait)
      edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {},
        unset: [`${group}.layer0.strength`, `${choice}.mix`, `${choice}.text`] })
      check(level === 1 ? 0.4 : 0.6, level === 1 ? 'dormant inner text' : 'middle text', 0.3)
      expect(store.doc.graphs.detail).toEqual(original.graphs.detail)
      expect(store.doc.graphs.portrait).toEqual(original.graphs.portrait)
      if (level === 2) {
        edit(store, 'node.setValues', { graphId: 'portrait', nodeId: 'detail', values: {}, unset: ['pick.mix', 'pick.text'] })
        check(0.4, 'dormant inner text', 0.3)
      }
      edit(store, 'node.setValues', { graphId: 'detail', nodeId: 'sample', values: {}, unset: ['mode.mix', 'mode.text'] })
      check(0.3, 'inner text', 0.3)
      expect(store.undo()).toBe(true)
      check(0.4, 'dormant inner text', 0.3)
      expect(store.redo()).toBe(true)
      check(0.3, 'inner text', 0.3)
    })

    it(`boundary/whole-construct/linked-outside/${context}`, () => {
      for (const [construct, inputId, receivingId] of [
        ['layers', 'layers.layer0.strength', 'layers.layer2.strength'],
        ['mode', 'mode.mix', 'mode.mix'],
      ] as const) for (const [type, port, expected] of [
        ['dinkster.utilities.primitive_float', 'value', 0.65], ['FloatSource', 'number', ['outside', 0]],
      ] as const) {
        const document = boundarySample(level)
        Object.assign(document.graphs.root!.nodes, { outside: { id: 'outside', type, values: { value: 0.65 } } })
        const store = storeFor(document)
        if (construct === 'layers') for (const nodeId of ['first', 'second']) {
          edit(store, 'dynamic.materialize', { graphId: 'root', nodeId,
            frames: [{ construct, members: ['layer0'] }] })
        }
        edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId, value: 0.2 })
        edit(store, 'node.setValue', { graphId: 'root', nodeId: 'second', inputId, value: 0.8 })
        const original = store.doc
        const baseline = prompt(original)
        const second = level === 1 ? 'second.sample' : 'second.detail.sample'
        edit(store, 'link.connect', { graphId: 'root', from: { node: 'outside', port },
          to: { node: 'first', port: inputId } })
        const connected = store.doc
        const check = (current: WorkflowDocument, linked: boolean) => {
          const compiled = prompt(current)
          expect(compiled[path]).toEqual({ ...baseline[path]!, inputs: {
            ...baseline[path]!.inputs, [receivingId]: linked ? expected : 0.2,
          } })
          expect(compiled[second]).toEqual(baseline[second])
          expect(compiled[second]!.inputs[receivingId]).toBe(0.8)
          expect(current.graphs.root!.nodes.first!.values[inputId]).toBe(0.2)
          expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
          expect(current.graphs.detail).toEqual(original.graphs.detail)
          expect(current.graphs.portrait).toEqual(original.graphs.portrait)
        }
        check(connected, true)
        check(loadDocument(JSON.parse(JSON.stringify(connected))).document!, true)
        const link = Object.values(connected.graphs.root!.links).find((item) =>
          'port' in item.to && item.to.node === 'first' && item.to.port === inputId)!
        edit(store, 'link.disconnect', { graphId: 'root', linkId: link.id })
        check(store.doc, false)
        check(loadDocument(JSON.parse(JSON.stringify(store.doc))).document!, false)
        expect(store.undo()).toBe(true)
        check(store.doc, true)
        expect(store.redo()).toBe(true)
        check(store.doc, false)
      }
    })

    it(`boundary/multi-row-member/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [{ construct: 'layers', members: ['layer0', 'layer1'] }] })
      edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {
        'layers.layer0.strength': 0.8, 'layers.layer1.strength': 0.25,
      } })
      edit(store, 'dynamic.materialize', { graphId: 'root', nodeId: 'second', frames: [{ construct: 'layers', members: ['layer0'] }] })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'second', inputId: 'layers.layer0.strength', value: 0.6 })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'layers.layer0.image' } })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'layers.layer0.result' }, to: { node: 'sink', port: 'number' } })
      const original = store.doc
      const compiled = prompt(store.doc)
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      expect(compiled[path]!.inputs).toMatchObject({
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
        'layers.layer2.image': ['imageA', 0], 'layers.layer2.strength': 0.8, 'layers.layer3.strength': 0.25,
      })
      expect(Object.keys(compiled[path]!.inputs).filter((id) => id.startsWith('layers.') && id.endsWith('.image')))
        .toEqual(['layers.layer2.image'])
      expect(Object.keys(compiled[second]!.inputs).filter((id) => id.startsWith('layers.') && id.endsWith('.image')))
        .toEqual([])
      expect(compiled[second]!.inputs['layers.layer2.strength']).toBe(0.6)
      expect(compiled[second]!.outputMembers?.layers).toEqual(['layer0', 'layer1', 'layer2'])
      const check = (current: WorkflowDocument, reordered: boolean) => {
        expect(loadDocument(JSON.parse(JSON.stringify(current))).document).toEqual(current)
        const actual = prompt(current)
        expect(actual[path]).toEqual({ ...compiled[path]!,
          outputIds: [
            'layers.layer0.result', 'layers.layer1.result',
            ...(reordered ? ['layers.layer3.result', 'layers.layer2.result'] : ['layers.layer2.result', 'layers.layer3.result']),
            'outputs.o0', 'outputs.o1', 'outputs.o2', 'result', 'output91',
          ],
          outputMembers: { ...compiled[path]!.outputMembers,
            layers: reordered ? ['layer0', 'layer1', 'layer3', 'layer2'] : ['layer0', 'layer1', 'layer2', 'layer3'] },
        })
        expect(actual.sink!.inputs.number).toEqual([path, reordered ? 3 : 2])
        expect(actual[second]).toEqual(compiled[second])
        expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        expect(current.graphs.root!.links).toEqual(original.graphs.root!.links)
        expect(current.graphs.detail).toEqual(original.graphs.detail)
        expect(current.graphs.portrait).toEqual(original.graphs.portrait)
      }
      check(original, false)
      edit(store, 'dynamic.moveMember', { graphId: 'root', nodeId: 'first', construct: 'layers', member: 'layer1', index: 0 })
      const reordered = store.doc
      const expected = structuredClone(original)
      Object.assign(expected.graphs.root!.nodes.first!.dynamic!.layers!, { members: ['layer1', 'layer0'] })
      expect(reordered).toEqual(expected)
      check(reordered, true)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(original)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(reordered)
    })

    it(`boundary/nested-group/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'node.setValues', { graphId: 'detail', nodeId: 'sample', values: {
        'nested.n0.weights.w0': 0.2, 'nested.n1.weights.w0': 0.8, 'nested.n1.weights.w1': 0.9,
      } })
      edit(store, 'dynamic.materialize', { graphId: 'root', nodeId: 'first', frames: [
        { construct: 'nested', members: ['n0', 'n1'] },
        { construct: 'nested.n0.weights', members: ['w0', 'w1'] },
        { construct: 'nested.n1.weights', members: ['w0'] },
      ] })
      edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {
        'nested.n0.weights.w0': 0.25, 'nested.n0.weights.w1': 0.85, 'nested.n1.weights.w0': 0.65,
      } })
      edit(store, 'dynamic.materialize', { graphId: 'root', nodeId: 'second', frames: [
        { construct: 'nested', members: ['n0'] }, { construct: 'nested.n0.weights', members: ['w0'] },
      ] })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'second', inputId: 'nested.n0.weights.w0', value: 0.55 })
      const original = store.doc, compiled = prompt(original)
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      const prefix = {
        'nested.n0.weights.w0': 0.2, 'nested.n1.weights.w0': 0.8, 'nested.n1.weights.w1': 0.9,
      }
      const nestedInputs = (inputs: Record<string, unknown>) => Object.fromEntries(Object.entries(inputs).filter(([id]) => id.startsWith('nested.')))
      expect(nestedInputs(compiled[path]!.inputs)).toEqual({ ...prefix,
        'nested.n2.weights.w0': 0.25, 'nested.n2.weights.w1': 0.85, 'nested.n3.weights.w0': 0.65,
      })
      expect(nestedInputs(compiled[second]!.inputs)).toEqual({ ...prefix, 'nested.n2.weights.w0': 0.55 })
      expect(Object.fromEntries(Object.entries(compiled[path]!.outputMembers!).filter(([id]) => id === 'nested' || id.startsWith('nested.')))).toEqual({
        nested: ['n0', 'n1', 'n2', 'n3'], 'nested.n0.weights': ['w0'], 'nested.n1.weights': ['w0', 'w1'],
        'nested.n2.weights': ['w0', 'w1'], 'nested.n3.weights': ['w0'],
      })
      const check = (document: WorkflowDocument, removed: boolean) => {
        expect(loadDocument(JSON.parse(JSON.stringify(document))).document).toEqual(document)
        const current = prompt(document)
        const { 'nested.n2.weights.w0': _w0, 'nested.n2.weights.w1': _w1, ...remainingInputs } = compiled[path]!.inputs
        const { 'nested.n2.weights': _weights, ...remainingMembers } = compiled[path]!.outputMembers!
        expect(current[path]).toEqual(removed ? { ...compiled[path]!, inputs: remainingInputs,
          outputMembers: { ...remainingMembers, nested: ['n0', 'n1', 'n3'] },
        } : compiled[path])
        expect(current[path]!.outputMembers).toMatchObject({
          'nested.n0.weights': ['w0'], 'nested.n1.weights': ['w0', 'w1'],
          'nested.n3.weights': ['w0'],
        })
        expect(current[second]).toEqual(compiled[second])
        expect(current[second]!.outputMembers).toMatchObject({ nested: ['n0', 'n1', 'n2'], 'nested.n2.weights': ['w0'] })
        expect(document.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        expect(document.graphs.detail).toEqual(original.graphs.detail)
        expect(document.graphs.portrait).toEqual(original.graphs.portrait)
      }
      check(original, false)
      const refused = store.dispatch({ command: 'dynamic.moveMember', params: {
        graphId: 'root', nodeId: 'first', construct: 'nested', member: 'n1', index: 0,
      } })
      expect(refused.ok).toBe(false)
      expect(refused.diagnostics.map((entry) => entry.code)).toContain('dynamic.notReorderable')
      expect(store.doc).toBe(original)
      edit(store, 'dynamic.removeMember', { graphId: 'root', nodeId: 'first', construct: 'nested', member: 'n0' })
      const removed = store.doc
      check(removed, true)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(original)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(removed)
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
      const document = boundarySample(level)
      Object.assign(document.graphs.root!.nodes, { caption: {
        id: 'caption', type: 'dinkster.utilities.primitive_string', values: { value: 'literal outside caption' },
      } })
      const store = storeFor(document)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.mix', value: 0.8 })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.text', value: 'dormant occurrence caption' })
      const original = store.doc
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      const sibling = prompt(original)[second]
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'mode.picture' } })
      expect(prompt(store.doc)[path]!.inputs).toMatchObject({ 'mode.mix': 0.8, 'mode.picture': ['imageA', 0] })
      const imageLink = Object.values(store.doc.graphs.root!.links).find((link) =>
        'port' in link.to && link.to.node === 'first' && link.to.port === 'mode.picture')!
      edit(store, 'link.disconnect', { graphId: 'root', linkId: imageLink.id })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.picture')
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: 'mode.picture' } })
      const imageReceiver = prompt(store.doc)[path]!
      const retainedImage = Object.values(store.doc.graphs.root!.links).find((link) =>
        'port' in link.to && link.to.node === 'first' && link.to.port === 'mode.picture')!
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('dormant occurrence caption')
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'caption', port: 'value' }, to: { node: 'first', port: 'mode.text' } })
      const linked = store.doc
      for (const current of [linked, loadDocument(JSON.parse(JSON.stringify(linked))).document!]) {
        expect(prompt(current)[path]!.slotVariants?.mode).toBe('text')
        expect(prompt(current)[path]!.inputs).toMatchObject({ 'mode.text': 'literal outside caption', 'mode.mix': 0.8 })
        expect(prompt(current)[path]!.inputs).not.toHaveProperty('mode.picture')
        expect(current.graphs.root!.links[retainedImage.id]).toEqual(retainedImage)
        expect(prompt(current)[second]).toEqual(sibling)
        expect(current.graphs.root!.nodes.first!.values['mode.text']).toBe('dormant occurrence caption')
        expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(original.graphs.detail)
        expect(current.graphs.portrait).toEqual(original.graphs.portrait)
      }
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'image' })
      expect(store.doc.graphs.root!.links).toEqual(linked.graphs.root!.links)
      expect(prompt(store.doc)[path]!.slotVariants?.mode).toBe('image')
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.text')
      for (const current of [store.doc, loadDocument(JSON.parse(JSON.stringify(store.doc))).document!]) {
        expect(prompt(current)[path]).toEqual(imageReceiver)
        expect(prompt(current)[path]!.inputs['mode.picture']).toEqual(['imageA', 0])
        expect(prompt(current)[second]).toEqual(sibling)
        expect(current.graphs.root!.links).toEqual(linked.graphs.root!.links)
        expect(current.graphs.root!.nodes.first!.values['mode.text']).toBe('dormant occurrence caption')
        expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        expect(current.graphs.detail).toEqual(original.graphs.detail)
        expect(current.graphs.portrait).toEqual(original.graphs.portrait)
      }
      const malformed = structuredClone(store.doc)
      const staleLink = Object.values(malformed.graphs.root!.links).find((link) =>
        'port' in link.to && link.to.node === 'first' && link.to.port === 'mode.text')!
      Object.assign(staleLink, { to: { node: 'first', port: 'mode.undeclared' } })
      const rejected = compile({ document: malformed, revision: 1, resolve: resolveBoundarySample,
        scope: { kind: 'full' }, connection: asConnectionId('boundary-grid'), schemaHash: 'boundary-sample' })
      expect(rejected.ok).toBe(false)
      expect(!rejected.ok && rejected.diagnostics.some((diagnostic) => diagnostic.code === 'compile.port.unknownInput')).toBe(true)
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('literal outside caption')
      const refused = store.dispatch({ command: 'link.connect', params: { graphId: 'root',
        from: { node: 'caption', port: 'value' }, to: { node: 'first', port: 'mode' } } })
      expect(refused.ok).toBe(false)
      expect(store.doc).toEqual(linked)
      const textLink = Object.values(linked.graphs.root!.links).find((link) =>
        'port' in link.to && link.to.node === 'first' && link.to.port === 'mode.text')!
      edit(store, 'link.disconnect', { graphId: 'root', linkId: textLink.id })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('dormant occurrence caption')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'image' })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.text')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      const reopened = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      expect(prompt(reopened)[path]!.inputs['mode.text']).toBe('dormant occurrence caption')
      expect(prompt(reopened)[second]).toEqual(sibling)
      expect(reopened.graphs.detail).toEqual(original.graphs.detail)
      expect(reopened.graphs.portrait).toEqual(original.graphs.portrait)
    })

    it(`boundary/inactive-option-row/${context}`, () => {
      const store = storeFor(boundarySample(level))
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'mode.text', value: 'retained text' })
      expect(prompt(store.doc)[path]!.inputs).not.toHaveProperty('mode.text')
      edit(store, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('retained text')
    })

    for (const scenario of ['fallback', 'links', 'fan-out-text', 'fan-out-image'] as const) it(`boundary/standalone-option-rows/${context}/${scenario}`, () => {
      const document = boundarySample(level)
      for (const id of ['detail', 'portrait']) {
        const graph = document.graphs[id]
        if (graph !== undefined) Object.assign(graph, { boundary: { body: graph.boundary!.body
          .filter((row) => !('id' in row && row.id === 'mode')) } })
      }
      if (scenario.startsWith('fan-out')) Object.assign(document.graphs.detail!.nodes, { extra: {
        ...structuredClone(document.graphs.detail!.nodes.sample!), id: 'extra',
        values: { ...document.graphs.detail!.nodes.sample!.values, strength: 0.53,
          'mode.text': 'private extra caption', 'mode.mix': 0.73 },
      } })
      Object.assign(document.graphs.root!.nodes, { caption: {
        id: 'caption', type: 'dinkster.utilities.primitive_string', values: { value: 'literal caption' },
      }, captionRuntime: { id: 'captionRuntime', type: 'StringSource', values: {} } })
      const store = storeFor(document)
      edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'sample', construct: 'mode', option: 'text' })
      if (scenario.startsWith('fan-out')) edit(store, 'dynamic.selectOption', {
        graphId: 'detail', nodeId: 'extra', construct: 'mode', option: 'text',
      })
      edit(store, 'boundary.addItem', { graphId: 'detail', side: 'inputs', itemId: 'caption',
        node: 'sample', port: 'mode.text', promoted: true })
      edit(store, 'boundary.addItem', { graphId: 'detail', side: 'inputs', itemId: 'photo',
        node: 'sample', port: 'mode.picture' })
      if (level === 2) {
        edit(store, 'node.setValue', { graphId: 'portrait', nodeId: 'detail', inputId: 'caption', value: 'middle caption' })
        for (const [itemId, port] of [['heading', 'caption'], ['picture', 'photo']]) {
          edit(store, 'boundary.addItem', { graphId: 'portrait', side: 'inputs', itemId: itemId!,
            node: 'detail', port: port!, ...(itemId === 'heading' ? { promoted: true } : {}) })
        }
      }
      const caption = level === 1 ? 'caption' : 'heading'
      const picture = level === 1 ? 'photo' : 'picture'
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      const fallback = level === 1 ? 'dormant inner text' : 'middle caption'
      expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe(fallback)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: caption, value: 'first caption' })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'second', inputId: caption, value: 'sibling caption' })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'output91' }, to: { node: 'sink', port: 'number' } })
      const original = store.doc
      const baseline = prompt(original)
      expect(baseline[path]!.inputs['mode.text']).toBe('first caption')
      expect(baseline[second]!.inputs['mode.text']).toBe('sibling caption')
      expect(baseline.sink!.inputs.number).toEqual([path, 6])
      const plain = storeFor(boundarySample(0))
      edit(plain, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {
        'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4, 'mode.text': 'first caption',
      } })
      edit(plain, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: 'text' })
      expect(baseline[path]).toEqual(prompt(plain.doc).first)
      const schema = documentResolver(original, resolveBoundarySample)(original.graphs.root!.nodes.first!.type)!
      const fields = elabInputsOf(elaborateInterface(schema, original.graphs.root!.nodes.first!))
      const nativeText = boundarySampleSchema.body.find((row) => row.kind === 'choice' && row.id === 'mode')!
      expect(nativeText.kind).toBe('choice')
      if (nativeText.kind !== 'choice') throw new Error('Missing native choice')
      const nativeField = nativeText.options.find((option) => option.key === 'text')!.rows[0]!
      const { outer: _scope, ...field } = fields.find((row) => row.spec.id === caption)!.spec
      expect(field).toEqual({
        ...nativeField, id: caption, displayName: 'mode.text', optional: true,
        widget: { widgetType: 'STRING', options: {}, default: fallback },
      })
      expect(fields.some((row) => row.spec.id === picture)).toBe(false)
      if (scenario.startsWith('fan-out')) {
        const extra = level === 1 ? 'first.extra' : 'first.detail.extra'
        const otherExtra = level === 1 ? 'second.extra' : 'second.detail.extra'
        edit(plain, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {
          strength: 0.53, 'mode.text': 'private extra caption', 'mode.mix': 0.73,
        } })
        const privateExtra = prompt(plain.doc).first!
        expect(baseline[extra]).toEqual(privateExtra)
        expect(baseline[otherExtra]).toEqual(privateExtra)
        const text = scenario === 'fan-out-text'
        const itemId = text ? 'caption' : 'photo'
        const target = text ? 'mode.text' : 'mode.picture'
        const refused = store.dispatch({ command: 'boundary.addBinding', params: {
          graphId: 'detail', itemId, node: 'extra', port: text ? 'mode.picture' : 'mode.text',
        } })
        expect(refused.ok).toBe(false)
        expect(refused.diagnostics.map((item) => item.code)).toContain('boundary.fanoutTypeMismatch')
        expect(store.doc).toBe(original)
        edit(store, 'boundary.addBinding', { graphId: 'detail', itemId, node: 'extra', port: target })
        if (text) {
          const fanned = prompt(store.doc)
          expect(fanned[path]).toEqual(baseline[path])
          expect(fanned[extra]).toEqual({ ...privateExtra, inputs: { ...privateExtra.inputs, 'mode.text': 'first caption' } })
          expect(fanned[second]).toEqual(baseline[second])
          expect(fanned[otherExtra]).toEqual({ ...privateExtra, inputs: { ...privateExtra.inputs, 'mode.text': 'sibling caption' } })
          for (const [node, port, expected] of [
            ['caption', 'value', 'literal caption'], ['captionRuntime', 'text', ['captionRuntime', 0]],
          ] as const) {
            edit(store, 'link.connect', { graphId: 'root', from: { node, port }, to: { node: 'first', port: caption } })
            const compiled = prompt(store.doc)
            expect(compiled[path]).toEqual({ ...baseline[path], inputs: { ...baseline[path]!.inputs, 'mode.text': expected } })
            expect(compiled[extra]).toEqual({ ...privateExtra, inputs: { ...privateExtra.inputs, 'mode.text': expected } })
            expect(compiled[second]).toEqual(fanned[second])
            expect(compiled[otherExtra]).toEqual(fanned[otherExtra])
          }
        } else {
          for (const nodeId of ['sample', 'extra']) edit(store, 'dynamic.selectOption', {
            graphId: 'detail', nodeId, construct: 'mode', option: 'image',
          })
          const image = prompt(store.doc)
          edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: picture } })
          const linked = prompt(store.doc)
          for (const receiver of [path, extra]) expect(linked[receiver]).toEqual({
            ...image[receiver], inputs: { ...image[receiver]!.inputs, 'mode.picture': ['imageA', 0] },
          })
          expect(linked[second]).toEqual(image[second])
          expect(linked[otherExtra]).toEqual(image[otherExtra])
          edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'extra', construct: 'mode', option: 'text' })
          const inactive = prompt(store.doc)
          expect(inactive[path]).toEqual(linked[path])
          expect(inactive[extra]).toEqual(privateExtra)
          expect(inactive[otherExtra]).toEqual(privateExtra)
          expect(inactive[second]).toEqual(linked[second])
          edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'sample', construct: 'mode', option: 'text' })
          const bothInactive = prompt(store.doc)
          expect(bothInactive[path]).toEqual(baseline[path])
          expect(bothInactive[extra]).toEqual(privateExtra)
          const inactiveSchema = documentResolver(store.doc, resolveBoundarySample)(store.doc.graphs.root!.nodes.first!.type)!
          const retained = elabInputsOf(elaborateInterface(inactiveSchema, store.doc.graphs.root!.nodes.first!, {
            isInputConnected: (id) => id === picture, isOutputConnected: () => false,
          })).find((row) => row.spec.id === picture)!
          expect(retained.spec).toMatchObject({ type: { kind: 'concrete', name: 'IMAGE' },
            unavailable: { code: 'boundary.branchInactive', inactive: true } })
          expect(retained.apiName).toBeUndefined()
          edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'extra', construct: 'mode', option: 'image' })
          const secondaryActive = prompt(store.doc)
          expect(secondaryActive[path]).toEqual(baseline[path])
          expect(secondaryActive[extra]).toEqual(linked[extra])
          expect(secondaryActive[second]).toEqual(baseline[second])
          expect(secondaryActive[otherExtra]).toEqual(image[otherExtra])
          const activeSchema = documentResolver(store.doc, resolveBoundarySample)(store.doc.graphs.root!.nodes.first!.type)!
          const active = elabInputsOf(elaborateInterface(activeSchema, store.doc.graphs.root!.nodes.first!, {
            isInputConnected: (id) => id === picture, isOutputConnected: () => false,
          })).find((row) => row.spec.id === picture)!
          expect(active.apiName).toBe(picture)
          expect(active.kept).toBeUndefined()
          expect(active.spec.unavailable).toBeUndefined()
          edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'extra', construct: 'mode', option: 'text' })
        }
        const beforeUnbind = prompt(store.doc)
        edit(store, 'boundary.unbind', { graphId: 'detail', side: 'inputs', itemId,
          kind: 'port', node: 'extra', port: target })
        const unbound = prompt(store.doc)
        expect(unbound[extra]).toEqual(privateExtra)
        expect(unbound[otherExtra]).toEqual(privateExtra)
        expect(unbound[path]).toEqual(beforeUnbind[path])
        expect(unbound[second]).toEqual(beforeUnbind[second])
        expect(unbound.sink!.inputs.number).toEqual([path, 6])
        expect(store.doc.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        return
      }
      if (scenario === 'fallback') {
        edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {}, unset: [caption] })
        expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe(fallback)
        expect(prompt(store.doc)[second]).toEqual(baseline[second])
        if (level === 2) {
          edit(store, 'node.setValues', { graphId: 'portrait', nodeId: 'detail', values: {}, unset: ['caption'] })
          expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('dormant inner text')
          expect(prompt(store.doc)[second]).toEqual(baseline[second])
        }
        edit(store, 'node.setValues', { graphId: 'detail', nodeId: 'sample', values: {}, unset: ['mode.text'] })
        expect(prompt(store.doc)[path]!.inputs['mode.text']).toBe('inner text')
        expect(prompt(store.doc)[second]).toEqual(baseline[second])
        expect(store.undo()).toBe(true)
        if (level === 2) expect(store.undo()).toBe(true)
        expect(store.undo()).toBe(true)
        expect(store.doc).toEqual(original)
        return
      }
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'caption', port: 'value' }, to: { node: 'first', port: caption } })
      expect(prompt(store.doc)[path]).toEqual({ ...baseline[path], inputs: { ...baseline[path]!.inputs, 'mode.text': 'literal caption' } })
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'captionRuntime', port: 'text' }, to: { node: 'first', port: caption } })
      const linked = store.doc
      const retained = Object.values(linked.graphs.root!.links).find((link) =>
        'port' in link.to && link.to.node === 'first' && link.to.port === caption)!
      expect(prompt(linked)[path]).toEqual({ ...baseline[path], inputs: { ...baseline[path]!.inputs, 'mode.text': ['captionRuntime', 0] } })
      edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'sample', construct: 'mode', option: 'image' })
      for (const current of [store.doc, loadDocument(JSON.parse(JSON.stringify(store.doc))).document!]) {
        const compiled = prompt(current)
        const inactiveSchema = documentResolver(current, resolveBoundarySample)(current.graphs.root!.nodes.first!.type)!
        const rows = elabInputsOf(elaborateInterface(inactiveSchema, current.graphs.root!.nodes.first!, {
          isInputConnected: (id) => id === caption, isOutputConnected: () => false,
        }))
        expect(rows.find((row) => row.spec.id === caption)).toMatchObject({
          kept: expect.stringContaining('not a row of the chosen option'),
          spec: { type: { kind: 'concrete', name: 'STRING' }, unavailable: { code: 'boundary.branchInactive', inactive: true } },
        })
        expect(rows.find((row) => row.spec.id === caption)!.apiName).toBeUndefined()
        expect(current.graphs.root!.links[retained.id]).toEqual(retained)
        expect(current.graphs.root!.nodes.first!.values[caption]).toBe('first caption')
        expect(current.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
        expect(compiled[path]!.slotVariants?.mode).toBe('image')
        expect(compiled[path]!.inputs).not.toHaveProperty('mode.text')
        expect(compiled[second]!.inputs).not.toHaveProperty('mode.text')
        expect(compiled.sink!.inputs.number).toEqual([path, 6])
      }
      edit(store, 'link.connect', { graphId: 'root', from: { node: 'imageA', port: 'image' }, to: { node: 'first', port: picture } })
      expect(prompt(store.doc)[path]!.inputs['mode.picture']).toEqual(['imageA', 0])
      expect(prompt(store.doc)[second]!.inputs).not.toHaveProperty('mode.picture')
      const imageLinked = store.doc
      const imageLink = Object.values(imageLinked.graphs.root!.links).find((link) =>
        'port' in link.to && link.to.node === 'first' && link.to.port === picture)!
      edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'sample', construct: 'mode', option: 'text' })
      expect(store.doc.graphs.root).toEqual(imageLinked.graphs.root)
      expect(prompt(store.doc)[path]).toEqual({ ...baseline[path], inputs: { ...baseline[path]!.inputs, 'mode.text': ['captionRuntime', 0] } })
      expect(prompt(store.doc)[second]).toEqual(baseline[second])
      const inactiveImage = loadDocument(JSON.parse(JSON.stringify(store.doc))).document!
      const inactiveSchema = documentResolver(inactiveImage, resolveBoundarySample)(inactiveImage.graphs.root!.nodes.first!.type)!
      const keptImage = elabInputsOf(elaborateInterface(inactiveSchema, inactiveImage.graphs.root!.nodes.first!, {
        isInputConnected: (id) => id === caption || id === picture, isOutputConnected: () => false,
      })).find((row) => row.spec.id === picture)!
      expect(keptImage).toMatchObject({
        kept: expect.stringContaining('not a row of the chosen option'),
        spec: { type: { kind: 'concrete', name: 'IMAGE' }, unavailable: { code: 'boundary.branchInactive', inactive: true } },
      })
      expect(keptImage.apiName).toBeUndefined()
      expect(inactiveImage.graphs.root!.links[imageLink.id]).toEqual(imageLink)
      const restored = storeFor(inactiveImage)
      edit(restored, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'sample', construct: 'mode', option: 'image' })
      const revived = prompt(restored.doc)
      expect(revived).toEqual(prompt(imageLinked))
      expect(revived[path]!.inputs['mode.picture']).toEqual(['imageA', 0])
      expect(revived[path]!.inputs).not.toHaveProperty('mode.text')
      expect(revived[second]!.inputs).not.toHaveProperty('mode.picture')
      expect(revived.sink!.inputs.number).toEqual([path, 6])
      edit(store, 'link.disconnect', { graphId: 'root', linkId: retained.id })
      expect(prompt(store.doc)[path]).toEqual(baseline[path])
      expect(prompt(store.doc)[second]).toEqual(baseline[second])
      expect(store.doc.graphs.detail).toEqual(original.graphs.detail)
      expect(store.doc.graphs.portrait).toEqual(original.graphs.portrait)
      expect(store.doc.graphs.root!.nodes.second).toEqual(original.graphs.root!.nodes.second)
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
      const outerId = level === 1 ? 'memberStrength' : 'selectedStrength'
      if (level === 2) {
        const portrait = doc.graphs.portrait!
        Object.assign(portrait, { boundary: { body: [
          ...portrait.boundary!.body.filter((row) => !('id' in row && row.id === 'layers')),
          { ...member, id: outerId, binds: { kind: 'port', node: 'detail', port: 'memberStrength' } },
        ] } })
      }
      const store = storeFor(doc)
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: outerId, value: 0.2 })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'second', inputId: outerId, value: 0.8 })
      const original = store.doc
      const second = level === 1 ? 'second.sample' : 'second.detail.sample'
      const check = (current: WorkflowDocument, members: readonly string[]) => {
        const compiled = prompt(current)
        expect(compiled[path]!.inputs['layers.layer0.strength']).toBe(0.1)
        expect(compiled[second]!.inputs['layers.layer0.strength']).toBe(0.1)
        expect(compiled[path]!.outputMembers?.layers).toEqual(members)
        expect(compiled[second]!.outputMembers?.layers).toEqual(members)
        if (members.includes('layer1')) {
          expect(compiled[path]!.inputs['layers.layer1.strength']).toBe(0.2)
          expect(compiled[second]!.inputs['layers.layer1.strength']).toBe(0.8)
        } else {
          expect(compiled[path]!.inputs).not.toHaveProperty('layers.layer1.strength')
          expect(compiled[second]!.inputs).not.toHaveProperty('layers.layer1.strength')
        }
        expect(current.graphs.root).toEqual(original.graphs.root)
        expect(current.graphs.portrait).toEqual(original.graphs.portrait)
        expect(current.graphs.detail!.boundary).toEqual(original.graphs.detail!.boundary)
      }
      check(original, ['layer0', 'layer1'])
      edit(store, 'dynamic.moveMember', { graphId: 'detail', nodeId: 'sample', construct: 'layers', member: 'layer1', index: 0 })
      const reordered = store.doc
      check(reordered, ['layer1', 'layer0'])
      edit(store, 'dynamic.removeMember', { graphId: 'detail', nodeId: 'sample', construct: 'layers', member: 'layer1' })
      const removed = store.doc
      check(removed, ['layer0'])
      expect(loadDocument(JSON.parse(JSON.stringify(removed))).document).toEqual(removed)
      const missing = documentResolver(removed, resolveBoundarySample)(removed.graphs.root!.nodes.first!.type)!
      expect(elabInputsOf(elaborateInterface(missing, removed.graphs.root!.nodes.first!))
        .find((row) => row.spec.id === outerId)?.spec.unavailable?.code).toBe('boundary.memberMissing')
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(reordered)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(original)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(reordered)
      expect(store.redo()).toBe(true)
      expect(store.doc).toEqual(removed)
    })

    for (const feature of ['sections', 'shared-lines'] as const) {
      it(`boundary/${feature}/${context}`, () => {
        const store = storeFor(boundarySample(level))
        const graphId = level === 1 ? 'detail' : 'portrait'
        const fields = ['strength', 'radius', 'feather', 'balance']
        if (feature === 'shared-lines') {
          edit(store, 'node.setValues', { graphId: 'root', nodeId: 'first', values: { radius: 0.17, feather: 0.37, balance: 0.57 } })
          edit(store, 'node.setValues', { graphId: 'root', nodeId: 'second', values: { radius: 0.81, feather: 0.61, balance: 0.41 } })
          edit(store, 'link.connect', { graphId: 'root', from: { node: 'first', port: 'output91' }, to: { node: 'sink', port: 'number' } })
        }
        const before = prompt(store.doc)
        const original = store.doc
        const originalSchema = documentResolver(original, resolveBoundarySample)(`#${graphId}`)!
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
        if (feature === 'shared-lines') {
          const joined = store.doc
          const joinedSchema = documentResolver(joined, resolveBoundarySample)(`#${graphId}`)!
          expect(fields.map((id) => inputsOf(joinedSchema).find((field) => field.id === id)))
            .toEqual(fields.map((id) => inputsOf(originalSchema).find((field) => field.id === id)))
          expect(outputsOf(joinedSchema)).toEqual(outputsOf(originalSchema))
          expect(before.sink!.inputs.number).toEqual([path, 6])
          expect(fields.map((id) => before[path]!.inputs[id])).toEqual([0.2, 0.17, 0.37, 0.57])
          const sibling = level === 1 ? 'second.sample' : 'second.detail.sample'
          expect(fields.map((id) => before[sibling]!.inputs[id])).toEqual([0.8, 0.81, 0.61, 0.41])
          for (const badRows of [[rows[0]!, { kind: 'output', id: 'result' }], [...rows, { kind: 'input', id: 'count' }]]) {
            const excluded = new Set(badRows.map((row) => `${row.kind}:${row.id}`))
            const refused = store.dispatch({ command: 'boundary.arrange', params: { graphId,
              body: [...[...rest, ...rows].filter((row) => !excluded.has(`${row.kind}:${row.id}`)), { kind: 'line', rows: badRows }],
            } })
            expect(refused.ok).toBe(false)
            expect(refused.diagnostics.map((item) => item.code)).toContain('boundary.arrangeShape')
            expect(store.doc).toBe(joined)
          }
          expect(store.undo()).toBe(true)
          expect(store.doc).toEqual(original)
          expect(store.redo()).toBe(true)
          expect(store.doc).toEqual(joined)
          edit(store, 'boundary.arrange', { graphId, body: [...rest, ...rows] })
          expect(prompt(store.doc)).toEqual(before)
          expect(store.undo()).toBe(true)
          expect(store.doc).toEqual(joined)
          edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'feather', value: 0.93 })
          const changed = store.doc
          const reloaded = loadDocument(JSON.parse(JSON.stringify(changed))).document!
          expect(prompt(reloaded)[path]!.inputs).toEqual({ ...before[path]!.inputs, feather: 0.93 })
          expect(prompt(reloaded)[sibling]).toEqual(before[sibling])
          expect(prompt(reloaded).sink!.inputs.number).toEqual([path, 6])
          expect(reloaded.graphs.detail!.nodes).toEqual(original.graphs.detail!.nodes)
          if (level === 2) expect(reloaded.graphs.portrait!.nodes).toEqual(original.graphs.portrait!.nodes)
          expect(store.undo()).toBe(true)
          expect(store.doc).toEqual(joined)
          expect(store.redo()).toBe(true)
          expect(store.doc).toEqual(changed)
        }
      })
    }
  }

  it.each(['STRING', 'IMAGE'] as const)('boundary/standalone-option-rows/containing-level fan-out revives an inactive nested %s primary', (type) => {
    const document = boundarySample(2)
    const text = type === 'STRING'
    const nativePort = text ? 'mode.text' : 'mode.picture'
    const selected = text ? 'text' : 'image'
    const inactive = text ? 'image' : 'text'
    for (const id of ['detail', 'portrait']) Object.assign(document.graphs[id]!, { boundary: {
      body: document.graphs[id]!.boundary!.body.filter((row) => !('id' in row && row.id === 'mode')),
    } })
    Object.assign(document.graphs.portrait!.nodes, { extra: {
      ...structuredClone(document.graphs.detail!.nodes.sample!), id: 'extra',
      values: { ...document.graphs.detail!.nodes.sample!.values, strength: 0.53, 'mode.mix': 0.73 },
      dynamic: { ...document.graphs.detail!.nodes.sample!.dynamic, mode: { selected } },
    } })
    Object.assign(document.graphs.root!.nodes, { captionRuntime: { id: 'captionRuntime', type: 'StringSource', values: {} } })
    const store = storeFor(document)
    if (!text) edit(store, 'dynamic.selectOption', { graphId: 'detail', nodeId: 'sample', construct: 'mode', option: inactive })
    edit(store, 'boundary.addItem', { graphId: 'detail', side: 'inputs', itemId: 'leaf',
      node: 'sample', port: nativePort, ...(text ? { promoted: true } : {}) })
    edit(store, 'boundary.addItem', { graphId: 'portrait', side: 'inputs', itemId: 'exposed',
      node: 'detail', port: 'leaf', ...(text ? { promoted: true } : {}) })
    edit(store, 'boundary.addBinding', { graphId: 'portrait', itemId: 'exposed', node: 'extra', port: nativePort })
    if (text) {
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'first', inputId: 'exposed', value: 'outer caption' })
      edit(store, 'node.setValue', { graphId: 'root', nodeId: 'second', inputId: 'exposed', value: 'sibling caption' })
    }
    const schema = documentResolver(store.doc, resolveBoundarySample)('#portrait')!
    const row = elabInputsOf(elaborateInterface(schema, store.doc.graphs.root!.nodes.first!))
      .find((row) => row.spec.id === 'exposed')!
    expect(row.spec.type).toEqual({ kind: 'concrete', name: type })
    expect(row.spec.unavailable).toBeUndefined()
    expect(row.spec.sent).not.toBe(false)
    expect(row.apiName).toBe('exposed')
    expect(row.spec.widget).toEqual(text ? { widgetType: 'STRING', options: {}, default: 'dormant inner text' } : undefined)
    const beforeLink = prompt(store.doc)
    const source = text ? { node: 'captionRuntime', port: 'text' } : { node: 'imageA', port: 'image' }
    edit(store, 'link.connect', { graphId: 'root', from: source, to: { node: 'first', port: 'exposed' } })
    const linked = store.doc
    const compiled = prompt(linked)
    const plain = storeFor(boundarySample(0))
    edit(plain, 'node.setValues', { graphId: 'root', nodeId: 'first', values: {
      strength: 0.53, 'mode.mix': 0.73, 'mode.text': 'outer caption',
      'layers.layer0.strength': 0.1, 'layers.layer1.strength': 0.4,
    } })
    if (text) edit(plain, 'dynamic.selectOption', { graphId: 'root', nodeId: 'first', construct: 'mode', option: selected })
    const expected = prompt(plain.doc).first!
    expect(compiled['first.extra']).toEqual({ ...expected, inputs: { ...expected.inputs, [nativePort]: [source.node, 0] } })
    expect(compiled['first.detail.sample']).toEqual(beforeLink['first.detail.sample'])
    expect(compiled['second.extra']).toEqual(beforeLink['second.extra'])
    expect(compiled['second.detail.sample']).toEqual(beforeLink['second.detail.sample'])
    edit(store, 'dynamic.selectOption', { graphId: 'portrait', nodeId: 'extra', construct: 'mode', option: inactive })
    const inactiveSchema = documentResolver(store.doc, resolveBoundarySample)('#portrait')!
    const kept = elabInputsOf(elaborateInterface(inactiveSchema, store.doc.graphs.root!.nodes.first!, {
      isInputConnected: (id) => id === 'exposed', isOutputConnected: () => false,
    })).find((row) => row.spec.id === 'exposed')!
    expect(kept.apiName).toBeUndefined()
    expect(kept.spec.widget).toBeUndefined()
    expect(kept.spec.type).toEqual({ kind: 'concrete', name: type })
    expect(store.doc.graphs.root).toEqual(linked.graphs.root)
    edit(store, 'dynamic.selectOption', { graphId: 'portrait', nodeId: 'extra', construct: 'mode', option: selected })
    expect(prompt(store.doc)).toEqual(compiled)
  })

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
