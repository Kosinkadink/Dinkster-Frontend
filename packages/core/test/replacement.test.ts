/**
 * Deprecation + replacement engine tests. The contract under test:
 * - rules are validated DATA; the last case must be unconditional
 * - registry layers rules schema > pack > core, appending within a layer
 * - guards read document state only (values, links, net sinks)
 * - planning is pure; errors mean NO plan, warnings mean review-required
 * - unmapped connections are dropped EXPLICITLY (never silently)
 * - dynamic member connections are invisible to rules and always dropped
 * - node.replace applies a plan as ONE atomic, undoable transaction and
 *   rejects stale plans without mutating anything
 */
import { describe, expect, it } from 'vitest'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'
import type { GraphDef, Json, WorkflowDocument } from '../src/format/document.js'
import { netViewPositions } from '../src/format/net-views.js'
import { asDynamicMemberId, asGraphDefId, asLineageId, asLinkId, asNetId, asNodeId, asPortId } from '../src/ids.js'
import { checkDocument } from '../src/invariants.js'
import { isReplacementRule, type ReplacementRule } from '../src/replace/model.js'
import { planReplacement, REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY, type NodeReplacePlan } from '../src/replace/plan.js'
import { createReplacementRegistry } from '../src/replace/registry.js'
import { registerSchemaRules, replacementInvocation, scanReplacements } from '../src/replace/scan.js'
import type { InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }

const port = (node: string, portId: string) => ({ node: asNodeId(node), port: asPortId(portId) })
const mport = (node: string, portId: string, member: string) => ({
  node: asNodeId(node),
  port: asPortId(portId),
  members: [asDynamicMemberId(member)],
})

const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const widgetInput = (id: string, dflt?: unknown, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: { kind: 'concrete', name: 'FLOAT' },
  optional: false,
  widget: { widgetType: 'number', options: {}, ...(dflt !== undefined ? { default: dflt } : {}) },
  ...extra,
})
const output = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })

const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  items,
})

/** Old node: image in, strength widget, image out. */
const schemas: Record<string, NodeSchema> = {
  TapOld: schemaOf('TapOld', [widgetInput('amount', 0.5)]),
  TapSame: schemaOf('TapSame', [widgetInput('amount', 1)]),
  TapSameReordered: schemaOf('TapSameReordered', [widgetInput('amount', 1, {
    type: { name: 'FLOAT', kind: 'concrete' },
  })]),
  TapAmbiguous: schemaOf('TapAmbiguous', [widgetInput('amount', 1), widgetInput('amount', 2)]),
  TapWrongType: schemaOf('TapWrongType', [widgetInput('amount', 1, { type: IMAGE })]),
  TapForced: schemaOf('TapForced', [widgetInput('amount', 1, { forceInput: true })]),
  TapDynamic: schemaOf('TapDynamic', [widgetInput('amount', 1, {
    dynamic: { kind: 'dynamicCombo', options: [{ key: 'one', inputs: [widgetInput('amount', 1)] }] },
  })]),
  TapMaskOld: schemaOf('TapMaskOld', [widgetInput('amount', 0.5, { type: { kind: 'concrete', name: 'MASK' } })]),
  TapMaskComfy: schemaOf('TapMaskComfy', [widgetInput('amount', 1, { type: { kind: 'concrete', name: 'comfy.MASK' } })]),
  NewNode: schemaOf('NewNode', [
    input('image'),
    widgetInput('strength', 1.0),
    widgetInput('mode', undefined, {
      type: { kind: 'concrete', name: 'COMBO' },
      widget: { widgetType: 'combo', options: {}, default: 'bilinear' },
    }),
    output('image'),
  ]),
  RenamedPorts: schemaOf('RenamedPorts', [
    input('pixels'),
    widgetInput('scale', 2.0),
    output('result'),
  ]),
  SeededNode: schemaOf('SeededNode', [
    widgetInput('seed', 0, { widget: { widgetType: 'number', options: {}, default: 0, controller: 'after_generate' } }),
    output('image'),
  ]),
  NoWidgetTarget: schemaOf('NoWidgetTarget', [input('image'), output('image')]),
  SamePorts: schemaOf('SamePorts', [input('in_image'), output('out_image')]),
  TwoOut: schemaOf('TwoOut', [output('a'), output('b')]),
  ListPrimary: schemaOf('ListPrimary', [input('images'), output('items')]),
  ListJoin: schemaOf('ListJoin', [
    input('a'),
    input('b'),
    widgetInput('count', 1),
    widgetInput('scale', 1, {
      widget: { widgetType: 'number', options: {}, default: 1, controller: 'after_generate' },
    }),
    widgetInput('untouched', 7),
    output('items'),
  ]),
  ListSplit: schemaOf('ListSplit', [input('items'), output('first')]),
  LegacyColon: schemaOf('LegacyColon', [input('in:old'), output('out:old')]),
}
const resolve = (type: string): NodeSchema | undefined => schemas[type]

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

function doc(graphs: Record<string, GraphDef>, root = 'g0'): WorkflowDocument {
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: asLineageId('lin1'),
    root: asGraphDefId(root),
    graphs,
    view: { graphs: {} },
  }
}

const node = (id: string, type: string, values: Record<string, Json> = {}, extra?: object) => ({
  id: asNodeId(id),
  type,
  values,
  ...extra,
})

const link = (id: string, from: object, to: object) => ({ id: asLinkId(id), from, to }) as GraphDef['links'][string]
const net = (id: string, source: object, sinks: object[]) =>
  ({ id: asNetId(id), name: id, source, sinks }) as GraphDef['nets'][string]

/** OldNode instance wired: producer -> in_image, out_image -> consumer. */
function wiredDoc(): WorkflowDocument {
  return doc({
    g0: graph({
      id: 'g0',
      nodes: {
        src: node('src', 'Producer'),
        old: node('old', 'OldNode', { amount: 0.5 }),
        dst: node('dst', 'Consumer'),
      },
      links: {
        l1: link('l1', port('src', 'out'), port('old', 'in_image')),
        l2: link('l2', port('old', 'out_image'), port('dst', 'in')),
        l3: link('l3', port('old', 'out_image'), port('dst', 'in2')),
      },
    }),
  })
}

const basicRule: ReplacementRule = {
  from: 'OldNode',
  cases: [
    {
      to: 'NewNode',
      inputs: { image: { kind: 'copy', input: 'in_image' }, strength: { kind: 'value', input: 'amount' } },
      outputs: { image: 'out_image' },
    },
  ],
}

// ---------------------------------------------------------------------------
// Rule shape validation
// ---------------------------------------------------------------------------

describe('isReplacementRule', () => {

  it('rejects malformed predicates, transforms, and mappings', () => {
    expect(isReplacementRule({ from: 'A', cases: [{ when: { kind: 'nope' }, to: 'B' }] })).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{ to: 'B', inputs: { x: { kind: 'value', input: 'y', transform: { kind: 'wat' } } } }],
      }),
    ).toBe(false)
    expect(isReplacementRule({ from: 'A', cases: [{ to: 'B', inputs: { x: { kind: 'copy' } } }] })).toBe(false)
    expect(isReplacementRule({ from: 'A', cases: [] })).toBe(false)
    expect(isReplacementRule({ from: '', cases: [{ to: 'B' }] })).toBe(false)
  })

  it('rejects cyclic internal links, doubly-fed inputs, and malformed helper addresses', () => {
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          slotVariants: { mode: { kind: 'copy', input: 'legacy_mode' } },
          inputs: { mode: { kind: 'copy', input: 'legacy_mode' } },
        }],
      }),
    ).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          slotVariants: { mask: { kind: 'link', input: 'legacy_mask' } },
          links: [{ from: 'output', to: 'mask' }],
        }],
      }),
    ).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          nodes: { helper: { type: 'H' } },
          links: [
            { from: 'out', to: 'helper:in' },
            { from: 'helper:out', to: 'in' },
          ],
        }],
      }),
    ).toBe(false)
    expect(
      isReplacementRule({
        from: 'A',
        cases: [{
          to: 'B',
          nodes: { helper: { type: 'H' } },
          inputs: { 'helper:in': { kind: 'constant', value: 1 } },
          links: [{ from: 'out', to: 'helper:in' }],
        }],
      }),
    ).toBe(false)
    for (const address of ['missing:in', 'helper:in:extra', ':in', 'helper:']) {
      expect(
        isReplacementRule({
          from: 'A',
          cases: [{
            to: 'B',
            nodes: { helper: { type: 'H' } },
            inputs: { [address]: { kind: 'constant', value: 1 } },
          }],
        }),
      ).toBe(false)
    }
  })

})

// ---------------------------------------------------------------------------
// Guard selection
// ---------------------------------------------------------------------------

describe('planReplacement guards', () => {
  const guardedRule: ReplacementRule = {
    from: 'OldNode',
    cases: [
      { when: { kind: 'inputConnected', input: 'in_image' }, to: 'NoWidgetTarget', inputs: { image: { kind: 'link', input: 'in_image' } } },
      { when: { kind: 'valuePresent', input: 'amount' }, to: 'NewNode', inputs: { strength: { kind: 'value', input: 'amount' } } },
      { to: 'NewNode' },
    ],
  }

  it('selects the connected case when a link feeds the input', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode') },
        links: { l1: link('l1', port('src', 'out'), port('old', 'in_image')) },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', guardedRule, resolve)
    expect(out.plan?.to).toBe('NoWidgetTarget')
    expect(out.plan?.caseIndex).toBe(0)
  })

  it('a named-net sink counts as connected', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode') },
        nets: { net1: net('net1', port('src', 'out'), [port('old', 'in_image')]) },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', guardedRule, resolve)
    expect(out.plan?.caseIndex).toBe(0)
  })

})

// ---------------------------------------------------------------------------
// Value mapping
// ---------------------------------------------------------------------------

describe('planReplacement values', () => {

  it('constants and enum renames apply; missing enum mapping is fatal', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          to: 'NewNode',
          inputs: {
            strength: { kind: 'constant', value: 3 },
            mode: { kind: 'value', input: 'mode', transform: { kind: 'enumRename', map: { nearest: 'nearest-exact' } } },
          },
        },
      ],
    }
    const ok = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { mode: 'nearest' }) } }) })
    const out = planReplacement(ok, 'g0', 'old', rule, resolve)
    expect(out.plan!.values).toMatchObject({ strength: 3, mode: 'nearest-exact' })

    const bad = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { mode: 'mystery' }) } }) })
    const failed = planReplacement(bad, 'g0', 'old', rule, resolve)
    expect(failed.plan).toBeUndefined()
    expect(failed.diagnostics.some((d) => d.code === 'replace.transform.enum')).toBe(true)
  })

  it('scale transforms numbers and rejects non-numbers', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'NewNode', inputs: { strength: { kind: 'value', input: 'amount', transform: { kind: 'scale', factor: 100, offset: 1 } } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { amount: 0.25 }) } }) })
    expect(planReplacement(d, 'g0', 'old', rule, resolve).plan!.values.strength).toBe(26)

    const bad = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { amount: 'high' }) } }) })
    const failed = planReplacement(bad, 'g0', 'old', rule, resolve)
    expect(failed.plan).toBeUndefined()
    expect(failed.diagnostics.some((d) => d.code === 'replace.transform.scale')).toBe(true)
  })

  it('carries controller modes to the mapped target input', () => {
    const rule: ReplacementRule = {
      from: 'OldSeeded',
      cases: [{ to: 'SeededNode', inputs: { seed: { kind: 'value', input: 'noise_seed' } } }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'OldSeeded', { noise_seed: 42 }, { controllers: { noise_seed: 'randomize' } }) },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', rule, resolve)
    expect(out.plan!.values.seed).toBe(42)
    expect(out.plan!.controllers).toEqual({ seed: 'randomize' })
  })

  it('rejects value writes to a target input with no widget (except copy, which warns)', () => {
    const constantRule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'NoWidgetTarget', inputs: { image: { kind: 'constant', value: 1 } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const failed = planReplacement(d, 'g0', 'old', constantRule, resolve)
    expect(failed.plan).toBeUndefined()
    expect(failed.diagnostics.some((x) => x.code === 'replace.target.notWidget')).toBe(true)

    const copyRule: ReplacementRule = {
      from: 'OldNode',
      cases: [{ to: 'NoWidgetTarget', inputs: { image: { kind: 'copy', input: 'in_image' } } }],
    }
    const d2 = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode', { in_image: 'stored' }) } }) })
    const out = planReplacement(d2, 'g0', 'old', copyRule, resolve)
    expect(out.plan).toBeDefined()
    expect(out.diagnostics.some((x) => x.code === 'replace.value.dropped' && x.severity === 'warning')).toBe(true)
  })

  it('rejects unknown target inputs/outputs and dynamic member paths', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const badInput: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode', inputs: { nope: { kind: 'constant', value: 1 } } }] }
    expect(planReplacement(d, 'g0', 'old', badInput, resolve).diagnostics.some((x) => x.code === 'replace.target.inputMissing')).toBe(true)
    const badOutput: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode', outputs: { nope: 'out_image' } }] }
    expect(planReplacement(d, 'g0', 'old', badOutput, resolve).diagnostics.some((x) => x.code === 'replace.target.outputMissing')).toBe(true)
    const badPath: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode', inputs: { 'items.slot': { kind: 'constant', value: 1 } } }] }
    expect(planReplacement(d, 'g0', 'old', badPath, resolve).diagnostics.some((x) => x.code === 'replace.target.dynamicPath')).toBe(true)
  })

  it('rejects subgraph targets and unknown target types', () => {
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const sub: ReplacementRule = { from: 'OldNode', cases: [{ to: '#g1' }] }
    expect(planReplacement(d, 'g0', 'old', sub, resolve).diagnostics[0]!.code).toBe('replace.target.subgraph')
    const unknown: ReplacementRule = { from: 'OldNode', cases: [{ to: 'Nonexistent' }] }
    expect(planReplacement(d, 'g0', 'old', unknown, resolve).diagnostics[0]!.code).toBe('replace.target.unknown')
  })
})

// ---------------------------------------------------------------------------
// Graph rewires
// ---------------------------------------------------------------------------

describe('planReplacement rewires', () => {
  const tapRule = (to: string): ReplacementRule => ({ from: 'TapOld', cases: [{ to }] })
  const tapDoc = (): WorkflowDocument => doc({
    g0: graph({
      id: 'g0',
      nodes: {
        old: node('old', 'TapOld', { amount: 0.25 }),
        dst: node('dst', 'Consumer'),
      },
      links: {
        tapLink: link('tapLink', { node: asNodeId('old'), tap: asPortId('amount') }, port('dst', 'in')),
      },
    }),
  })

  it('preserves a compatible static widget tap through one-step undo and redo', () => {
    const before = tapDoc()
    const planned = planReplacement(before, 'g0', 'old', tapRule('TapSame'), resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan!.tapGuards).toEqual([{ link: 'tapLink', tap: 'amount' }])
    expect(planned.plan!.dropLinks).toEqual([])

    const store = new DocumentStore(before, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Record<string, Json> }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.type).toBe('TapSame')
    expect(store.doc.graphs.g0!.links.tapLink).toEqual(before.graphs.g0!.links.tapLink)
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.links.tapLink).toEqual(before.graphs.g0!.links.tapLink)
  })

  it.each([
    ['missing', 'NewNode'],
    ['incompatible type', 'TapWrongType'],
    ['forced socket', 'TapForced'],
    ['dynamic declaration', 'TapDynamic'],
    ['ambiguous elaboration', 'TapAmbiguous'],
  ])('routes an unsupported %s tap through dropped-link review', (_reason, to) => {
    const planned = planReplacement(tapDoc(), 'g0', 'old', tapRule(to), resolve)
    expect(planned.plan!.dropLinks).toEqual(['tapLink'])
    expect(planned.plan!.tapGuards).toEqual([{ link: 'tapLink', tap: 'amount' }])
    expect(planned.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning',
      code: 'replace.output.dropped',
    }))
  })

  it('two mappings consuming one source connection is fatal', () => {
    const rule: ReplacementRule = {
      from: 'OldNode',
      cases: [
        {
          to: 'NewNode',
          inputs: { image: { kind: 'link', input: 'in_image' }, strength: { kind: 'link', input: 'in_image' } },
        },
      ],
    }
    const out = planReplacement(wiredDoc(), 'g0', 'old', rule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 'replace.link.doubleConsume')).toBe(true)
  })

  it('unmapped connections drop explicitly with warnings (review-required)', () => {
    const rule: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode' }] }
    const out = planReplacement(wiredDoc(), 'g0', 'old', rule, resolve)
    const plan = out.plan!
    expect([...plan.dropLinks].sort()).toEqual(['l1', 'l2', 'l3'])
    expect(out.diagnostics.some((d) => d.code === 'replace.link.dropped')).toBe(true)
    expect(out.diagnostics.some((d) => d.code === 'replace.output.dropped')).toBe(true)
    expect(out.diagnostics.every((d) => d.severity === 'warning')).toBe(true)
  })

  it('reroute/selector/value-source feeds rewire by endpoint, untouched upstream', () => {
    // A link whose `from` is not a port endpoint (reroute ref) still rewires
    // its `to` side - the plan addresses link endpoints, not producers.
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { src: node('src', 'P'), old: node('old', 'OldNode') },
        reroutes: { r1: { id: 'r1' } as GraphDef['reroutes'][string] },
        links: {
          feed: link('feed', port('src', 'out'), { reroute: 'r1' }),
          l1: link('l1', { reroute: 'r1' }, port('old', 'in_image')),
        },
      }),
    })
    const out = planReplacement(d, 'g0', 'old', basicRule, resolve)
    expect(out.plan!.inputRewires).toEqual([{ link: 'l1', port: 'image' }])
    expect(out.plan!.dropLinks).toEqual([])
  })

  it('a bound port the rule does not map is a hard error, not a silent drop', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { inst: node('inst', '#g1') },
        }),
        g1: graph({
          id: 'g1',
          nodes: { old: node('old', 'OldNode') },
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('old', 'in_mask') } }],
            outputs: [],
          },
        }),
      },
      'g0',
    )
    const out = planReplacement(d, 'g1', 'old', basicRule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((x) => x.code === 'replace.boundary.unmapped')).toBe(true)
  })

})

// ---------------------------------------------------------------------------
// Dynamic input-family mappings
// ---------------------------------------------------------------------------

describe('input family replacement', () => {
  const familyInput = (id: string, names: readonly string[]): InputSpec => ({
    kind: 'input',
    id,
    type: { kind: 'wildcard' },
    optional: true,
    dynamic: {
      kind: 'autogrow',
      materialization: 'wire15',
      template: [widgetInput('value', 0, {
        widget: { widgetType: 'number', options: {}, default: 0, controller: 'after_generate' },
      })],
      naming: { kind: 'names', names, min: 1 },
    },
  })
  const familySchemas: Record<string, NodeSchema> = {
    FamilyOld: schemaOf('FamilyOld', [familyInput('operands', ['a', 'b'])]),
    FamilyNew: schemaOf('FamilyNew', [familyInput('values', ['a', 'b'])]),
    HelperFamily: schemaOf('HelperFamily', [familyInput('values', ['a', 'b'])]),
    PlainNew: schemaOf('PlainNew', []),
    ResizeTarget: schemaOf('ResizeTarget', [input('megapixels')]),
    PixelExpression: schemaOf('PixelExpression', [
      familyInput('values', ['a', 'b']),
      output('float'),
    ]),
    IntegerValue: schemaOf('IntegerValue', [widgetInput('value', 0), output('value')]),
    StaticOld: schemaOf('StaticOld', [widgetInput('a', false), widgetInput('b', false)]),
    PixelOld: schemaOf('PixelOld', [widgetInput('width', 512), widgetInput('height', 512)]),
    LogicNew: schemaOf('LogicNew', [
      widgetInput('operation', undefined, {
        type: { kind: 'concrete', name: 'STRING' },
        widget: { widgetType: 'STRING', options: {}, default: 'or' },
      }),
      {
        ...familyInput('values', []),
        dynamic: {
          kind: 'autogrow',
          materialization: 'wire15',
          template: [widgetInput('value', false)],
          naming: { kind: 'prefix', prefix: 'value', min: 1, max: 8 },
        },
      },
    ]),
  }
  const familyResolve = (type: string): NodeSchema | undefined => familySchemas[type]

  it.each([false, true].flatMap((flat) => [false, true].flatMap((named) =>
    (named ? [false] : [false, true]).flatMap((targetFlat) =>
      [false, true].map((sameType) => ({ flat, named, targetFlat, sameType }))),
  )))('maps authored family order to canonical target positions (flat=$flat, named=$named, targetFlat=$targetFlat, sameType=$sameType)', ({ flat, named, targetFlat, sameType }) => {
    const oldMembers = ['oldB', 'oldA', 'oldC']
    const newMembers = named ? ['head', 'middle', 'tail'] : ['item0', 'item1', 'item2']
    const source = schemaOf('OrderedOld', [{
      ...familyInput('source', oldMembers),
      dynamic: { kind: 'autogrow',
        ...(flat ? {} : { materialization: 'wire15' as const }),
        template: [widgetInput(flat ? 'source' : 'value', 0, {
          widget: { widgetType: 'number', options: {}, default: 0, controller: 'after_generate' },
        })],
        naming: { kind: 'prefix', prefix: 'old', min: 0, max: 5 },
      },
    }])
    const targetType = sameType ? 'OrderedOld' : 'OrderedNew'
    const target = schemaOf(targetType, [{
      ...familyInput('target', newMembers),
      dynamic: { kind: 'autogrow', ...(targetFlat ? {} : { materialization: 'wire15' as const, optionalAfterMinimum: true }),
        template: [widgetInput(targetFlat ? 'target' : 'value', 0, {
          widget: { widgetType: 'number', options: {}, default: 0, controller: 'after_generate' },
        })],
        naming: named ? { kind: 'names', names: newMembers, min: 1 } : { kind: 'prefix', prefix: 'item', min: 1, max: 3 },
      },
    }])
    const resolver = (type: string) => type === targetType ? target : type === 'OrderedOld' ? source : resolve(type)
    const oldEndpoint = (member: string) => flat ? mport('old', 'source.source', member) : port('old', `source.${member}`)
    const newEndpoint = (member: string) => targetFlat ? mport('old', 'target.target', member) : port('old', `target.${member}`)
    const original = doc({ g0: graph({ id: 'g0', nodes: {
      src: node('src', 'Producer'), dst: node('dst', 'Consumer'),
      old: node('old', 'OrderedOld', { 'source.oldB': 11, 'source.oldA': 29, 'source.oldC': 47 }, {
        controllers: { 'source.oldC': 'decrement' },
        dynamic: { source: { members: oldMembers, memberLabels: { oldB: 'First', oldC: 'Unconnected' } } },
      }),
    }, links: { linked: link('linked', port('src', 'out'), oldEndpoint('oldB')) },
    nets: { routed: net('routed', port('src', 'out'), [oldEndpoint('oldA'), port('dst', 'other')]) } }) })
    const rule = { from: 'OrderedOld',
      ...(sameType ? { migration: { historicalInputs: ['source.oldB', 'source.oldA', 'source.oldC'] } } : {}),
      cases: [{ to: targetType, inputFamilies: {
      target: { kind: 'copy', sourceFamily: 'source', memberIds: 'targetPositions',
        ...(sameType ? { sourceTemplate: { inputs: ['value'], ...(flat ? { memberPort: 'source.source' } : {}) } } : {}),
        inputs: { value: { kind: 'copy', input: 'value' } } },
    } }] } satisfies ReplacementRule
    expect(isReplacementRule(rule)).toBe(true)
    const planned = planReplacement(original, 'g0', 'old', rule, resolver)
    expect(planned.diagnostics).toEqual(sameType
      ? [expect.objectContaining({ severity: 'info', code: 'replace.migration.archived' })]
      : [])
    expect(planned.plan).toBeDefined()
    if (!planned.plan) return
    const store = new DocumentStore(original, coreCommandRegistry())
    const invocation = { command: 'node.replace', params: { plan: planned.plan } as unknown as Json }
    expect(store.dispatch(invocation).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old).toMatchObject({
      dynamic: { target: { members: newMembers, memberLabels: { [newMembers[0]!]: 'First', [newMembers[2]!]: 'Unconnected' } } },
      values: { [`target.${newMembers[0]}`]: 11, [`target.${newMembers[1]}`]: 29, [`target.${newMembers[2]}`]: 47 },
      controllers: { [`target.${newMembers[2]}`]: 'decrement' },
    })
    expect(store.doc.graphs.g0!.links.linked!.to).toEqual(newEndpoint(newMembers[0]!))
    expect(store.doc.graphs.g0!.nets.routed!.sinks).toEqual([newEndpoint(newMembers[1]!), port('dst', 'other')])
    if (sameType) expect(planReplacement(store.doc, 'g0', 'old', rule, resolver).plan).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(original)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.links.linked!.to).toEqual(newEndpoint(newMembers[0]!))
    const stale = structuredClone(original)
    ;(stale.graphs.g0!.links as Record<string, GraphDef['links'][string]>).linked = link('linked', port('src', 'out'), oldEndpoint('oldA'))
    const staleStore = new DocumentStore(stale, coreCommandRegistry())
    expect(staleStore.dispatch(invocation).ok).toBe(false)
    expect(staleStore.doc).toEqual(stale)
    const overflowTarget = schemaOf(targetType, [{
      ...familyInput('target', []),
      dynamic: { kind: 'autogrow', materialization: 'wire15',
        template: [widgetInput('value', 0)],
        naming: named ? { kind: 'names', names: ['head', 'middle'], min: 0 } : { kind: 'prefix', prefix: 'item', min: 0, max: 2 },
      },
    }])
    const overflow = planReplacement(original, 'g0', 'old', rule, (type) => type === targetType ? overflowTarget : resolver(type))
    expect(overflow.plan).toBeUndefined()
    expect(overflow.diagnostics.some((diagnostic) => diagnostic.code === 'replace.target.familyMembers')).toBe(true)
  })

  it.each([false, true])('preserves flat prefix links and net sinks with historical template=%s', (historical) => {
    const flatFamily = (type: string): NodeSchema => schemaOf(type, [{
      kind: 'input',
      id: 'refs',
      type: { kind: 'wildcard' },
      optional: true,
      dynamic: {
        kind: 'autogrow',
        template: [input('refs')],
        naming: { kind: 'prefix', prefix: 'ref', min: 1, max: 4 },
      },
    }])
    const schemas = { FlatOld: flatFamily('FlatOld'), FlatNew: flatFamily('FlatNew') }
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'FlatOld', {}, {
            dynamic: { refs: { members: ['ref0', 'ref1'] } },
          }),
        },
        links: {
          linked: link('linked', port('src', 'out'), mport('old', 'refs.refs', 'ref0')),
        },
        nets: {
          routed: net('routed', port('src', 'out'), [mport('old', 'refs.refs', 'ref1')]),
        },
      }),
    })
    const rule: ReplacementRule = {
      from: 'FlatOld',
      cases: [{
        to: 'FlatNew',
        inputFamilies: {
          refs: {
            kind: 'copy',
            sourceFamily: 'refs',
            ...(historical ? { sourceTemplate: { inputs: ['value'], memberPort: 'refs.refs' } } : {}),
            inputs: { value: { kind: 'copy', input: 'value' } },
          },
        },
      }],
    }

    const planned = planReplacement(original, 'g0', 'old', rule, (type) =>
      historical && type === 'FlatOld' ? undefined : schemas[type as keyof typeof schemas])
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan).toMatchObject({ inputRewires: [], dropLinks: [], netSinks: [] })

    const store = new DocumentStore(original, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.type).toBe('FlatNew')
    expect(store.doc.graphs.g0!.links.linked!.to).toEqual(mport('old', 'refs.refs', 'ref0'))
    expect(store.doc.graphs.g0!.nets.routed!.sinks).toEqual([mport('old', 'refs.refs', 'ref1')])
  })

  it('copies a differently named family with suffixes, order, values, controllers, links, and net sinks', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'FamilyOld', {
            'operands.b': 2,
            'operands.a': 1,
          }, {
            controllers: { 'operands.b': 'increment' },
            dynamic: { operands: { members: ['b', 'a'] } },
          }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          linked: link('linked', port('src', 'out'), port('old', 'operands.b')),
        },
        nets: {
          routed: net('routed', port('src', 'out'), [port('old', 'operands.a'), port('dst', 'other')]),
        },
      }),
    })
    const rule: ReplacementRule = {
      from: 'FamilyOld',
      cases: [{
        to: 'FamilyNew',
        inputFamilies: {
          values: {
            kind: 'copy',
            sourceFamily: 'operands',
            inputs: { value: { kind: 'copy', input: 'value' } },
          },
        },
      }],
    }
    expect(isReplacementRule(rule)).toBe(true)
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.dynamic).toEqual({ values: { members: ['b', 'a'] } })
    expect(planned.plan?.values).toEqual({ 'values.b': 2, 'values.a': 1 })
    expect(planned.plan?.controllers).toEqual({ 'values.b': 'increment' })
    expect(planned.plan?.inputRewires).toEqual([{ link: 'linked', port: 'values.b' }])
    expect(planned.plan?.netSinks).toEqual([
      { net: 'routed', sinks: [port('old', 'values.a'), port('dst', 'other')] },
    ])

    const store = new DocumentStore(original, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(true)
    expect(store.doc.graphs.g0!.nodes.old).toMatchObject({
      type: 'FamilyNew',
      dynamic: { values: { members: ['b', 'a'] } },
      values: { 'values.b': 2, 'values.a': 1 },
    })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(original)
  })

  it.each(['missing', 'available', 'same-type'] as const)(
    'copies partial grouped historical templates with predecessor %s', (predecessor) => {
      const sameType = predecessor === 'same-type'
      const sourceType = sameType ? 'FamilyNew' : 'HistoricalGroup'
      const original = doc({ g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', sourceType, { 'operands.b.right': 29, 'operands.a.right': 11 }, {
            dynamic: { operands: { members: ['b', 'a'], seq: 9 } },
            controllers: { 'operands.b.right': 'increment' },
          }),
        },
        links: { linked: link('linked', port('src', 'out'), port('old', 'operands.b.right')) },
        nets: { routed: net('routed', port('src', 'out'), [port('old', 'operands.a.right')]) },
      }) })
      const rule: ReplacementRule = {
        from: sourceType,
        ...(sameType ? { migration: { historicalInputs: ['operands.b.right', 'operands.a.right'] } } : {}),
        cases: [{ to: 'FamilyNew', inputFamilies: { values: {
          kind: 'copy', sourceFamily: 'operands',
          sourceTemplate: { inputs: ['left', 'right'] },
          inputs: { value: { kind: 'copy', input: 'right' } },
        } } }],
      }
      const oldSchema = schemaOf('HistoricalGroup', [{
        ...familyInput('operands', ['a', 'b']),
        dynamic: {
          kind: 'autogrow', materialization: 'wire15',
          template: [widgetInput('left', 0), widgetInput('right', 0)],
          naming: { kind: 'names', names: ['a', 'b'], min: 1 },
        },
      }])
      const resolve = (type: string) => type === 'HistoricalGroup'
        ? predecessor === 'available' ? oldSchema : undefined
        : familyResolve(type)
      expect(isReplacementRule(rule)).toBe(true)
      const planned = planReplacement(original, 'g0', 'old', rule, resolve)
      expect(planned.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
      expect(planned.plan?.values).toEqual({ 'values.b': 29, 'values.a': 11 })
      expect(planned.plan?.controllers).toEqual({ 'values.b': 'increment' })
      expect(planned.plan?.dynamic).toEqual({ values: { members: ['b', 'a'], seq: 9 } })
      const store = new DocumentStore(original, coreCommandRegistry())
      expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok).toBe(true)
      expect(store.doc.graphs.g0!.links.linked!.to).toEqual(port('old', 'values.b'))
      expect(store.doc.graphs.g0!.nets.routed!.sinks).toEqual([port('old', 'values.a')])
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(doc({ g0: graph({ ...original.graphs.g0!, nodes: {
        ...original.graphs.g0!.nodes,
        old: { ...original.graphs.g0!.nodes.old!, dynamic: {
          operands: { members: ['b', 'a'], seq: 9 }, values: { seq: 9 },
        } },
      } }) }))
      expect(store.redo()).toBe(true)
      expect(store.doc.graphs.g0!.nodes.old!.values).toEqual({ 'values.b': 29, 'values.a': 11 })

      for (const changes of [
        { values: { 'operands.b.right': 31, 'operands.a.right': 11 } },
        { dynamic: { operands: { members: ['a', 'b'], seq: 9 } } },
        { controllers: { 'operands.b.right': 'randomize' as const } },
      ]) {
        const changed = doc({ g0: graph({ ...original.graphs.g0!, nodes: {
          ...original.graphs.g0!.nodes,
          old: { ...original.graphs.g0!.nodes.old!, ...changes },
        } }) })
        const stale = new DocumentStore(changed, coreCommandRegistry())
        const result = stale.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json })
        expect(result.ok).toBe(false)
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
        expect(stale.doc).toEqual(changed)
      }
      for (const graphChanges of [
        { links: { ...original.graphs.g0!.links, added: link('added', port('src', 'other'), port('old', 'operands.a.right')) } },
        { nets: { routed: net('routed', port('src', 'other'), [port('old', 'operands.a.right')]) } },
      ]) {
        const changed = doc({ g0: graph({ ...original.graphs.g0!, ...graphChanges }) })
        const stale = new DocumentStore(changed, coreCommandRegistry())
        const result = stale.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json })
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
        expect(stale.doc).toEqual(changed)
      }
      if (predecessor === 'available') {
        for (const inputs of [['right'], ['right', 'left']]) {
          const mismatched: ReplacementRule = { ...rule, cases: [{
            to: 'FamilyNew', inputFamilies: { values: {
              kind: 'copy', sourceFamily: 'operands', sourceTemplate: { inputs },
              inputs: { value: { kind: 'copy', input: 'right' } },
            } },
          }] }
          const refused = planReplacement(original, 'g0', 'old', mismatched, resolve)
          expect(refused.plan).toBeUndefined()
          expect(refused.diagnostics)
            .toContainEqual(expect.objectContaining({ code: 'replace.source.familyTemplate' }))
        }
      }
    },
  )

  it('maps fixed source inputs to explicit ordered target members', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'StaticOld', { a: true, b: false }),
        },
        links: { linked: link('linked', port('src', 'out'), port('old', 'b')) },
      }),
    })
    const rule: ReplacementRule = {
      from: 'StaticOld',
      cases: [{
        to: 'LogicNew',
        inputs: { operation: { kind: 'constant', value: 'and' } },
        inputFamilies: {
          values: {
            kind: 'members',
            members: [
              { suffix: 'value1', inputs: { value: { kind: 'copy', input: 'a' } } },
              { suffix: 'value2', inputs: { value: { kind: 'copy', input: 'b' } } },
            ],
          },
        },
      }],
    }
    expect(isReplacementRule(rule)).toBe(true)
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.dynamic).toEqual({ values: { members: ['value1', 'value2'] } })
    expect(planned.plan?.values).toEqual({
      operation: 'and',
      'values.value1': true,
      'values.value2': false,
    })
    expect(planned.plan?.inputRewires).toEqual([{ link: 'linked', port: 'values.value2' }])
  })

  it('combines linked and literal dimensions through a helper input family', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'PixelOld', { width: 640, height: 768 }),
        },
        links: { linked: link('linked', port('src', 'out'), port('old', 'width')) },
      }),
    })
    const rule: ReplacementRule = {
      from: 'PixelOld',
      cases: [{
        to: 'ResizeTarget',
        nodes: {
          pixels: { type: 'PixelExpression' },
          height: { type: 'IntegerValue' },
        },
        inputs: {
          'height:value': { kind: 'value', input: 'height' },
        },
        inputFamilies: {
          'pixels:values': {
            kind: 'members',
            members: [
              { suffix: 'a', inputs: { value: { kind: 'link', input: 'width' } } },
              { suffix: 'b', inputs: { value: { kind: 'link', input: 'height' } } },
            ],
          },
        },
        links: [
          { from: 'height:value', to: 'pixels:values.b' },
          { from: 'pixels:float', to: 'megapixels' },
        ],
      }],
    }

    expect(isReplacementRule(rule)).toBe(true)
    const planned = planReplacement(original, 'g0', 'old', rule, familyResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.createdNodes).toEqual([
      expect.objectContaining({
        localId: 'pixels',
        dynamic: { values: { members: ['a', 'b'] } },
      }),
      expect.objectContaining({ localId: 'height', values: { value: 768 } }),
    ])
    expect(planned.plan?.inputRewires).toEqual([{
      link: 'linked',
      node: 'old:pixels',
      port: 'values.a',
    }])
    expect(planned.plan?.links).toEqual([
      { from: port('old:height', 'value'), to: port('old:pixels', 'values.b') },
      { from: port('old:pixels', 'float'), to: port('old', 'megapixels') },
    ])
  })

  it('refuses copied members outside the target vocabulary', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'FamilyOld', {}, { dynamic: { operands: { members: ['b', 'a'] } } }),
        },
      }),
    })
    const restricted = schemaOf('Restricted', [familyInput('values', ['a'])])
    const rule: ReplacementRule = {
      from: 'FamilyOld',
      cases: [{
        to: 'Restricted',
        inputFamilies: {
          values: {
            kind: 'copy',
            sourceFamily: 'operands',
            inputs: { value: { kind: 'copy', input: 'value' } },
          },
        },
      }],
    }
    const planned = planReplacement(
      original,
      'g0',
      'old',
      rule,
      (type) => type === restricted.type ? restricted : familyResolve(type),
    )
    expect(planned.plan).toBeUndefined()
    expect(planned.diagnostics.some((diagnostic) => diagnostic.code === 'replace.target.familyMembers'))
      .toBe(true)
  })

})

describe('output family replacement', () => {
  const countInput = (id: string): InputSpec => input(id, {
    type: { kind: 'concrete', name: 'INT' },
  })
  const outputFamily = (id: string, count: string, max = 512): OutputSpec => ({
    kind: 'output',
    id,
    type: IMAGE,
    dynamic: {
      kind: 'autogrow',
      materialization: 'wire15',
      template: [input('value')],
      naming: { kind: 'prefix', prefix: 'value', min: 0, max },
      count: { input: count, suffix: 'index' },
    },
  })
  const outputSchemas: Record<string, NodeSchema> = {
    FamilyOutputOld: schemaOf('FamilyOutputOld', [countInput('count'), outputFamily('results', 'count')]),
    FamilyOutputNew: schemaOf('FamilyOutputNew', [countInput('quantity'), outputFamily('items', 'quantity')]),
    CountSource: schemaOf('CountSource', [countInput('count')]),
    StaticOutputOld: schemaOf('StaticOutputOld', [output('left'), output('right')]),
    LargeSharedOutputNew: schemaOf('LargeSharedOutputNew', [
      countInput('count'),
      outputFamily('images', 'count'),
      outputFamily('masks', 'count'),
    ]),
  }
  const outputResolve = (type: string): NodeSchema | undefined => outputSchemas[type]

  const copyRule: ReplacementRule = {
    from: 'FamilyOutputOld',
    cases: [{
      to: 'FamilyOutputNew',
      inputs: { quantity: { kind: 'copy', input: 'count' } },
      outputFamilies: { items: { kind: 'copy', sourceFamily: 'results' } },
    }],
  }

  it.each([false, true])('copies output members with predecessor schema available=%s and preserves links and nets', (available) => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'FamilyOutputOld', { count: 2 }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          linked: link('linked', mport('old', 'results', '0'), port('dst', 'image')),
        },
        nets: {
          routed: net('routed', mport('old', 'results', '1'), [port('dst', 'mask')]),
        },
      }),
    })
    const resolve = (type: string) => type === 'FamilyOutputOld' && !available ? undefined : outputResolve(type)
    const planned = planReplacement(original, 'g0', 'old', copyRule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.values).toEqual({ quantity: 2 })
    expect(planned.plan?.sourceCountGuards).toEqual({ count: 2 })
    expect(planned.plan?.outputRewires).toEqual([{
      link: 'linked',
      port: 'items',
      members: ['0'],
      fromPort: 'results',
      fromMembers: ['0'],
    }])
    expect(planned.plan?.netSourceRewires).toEqual([{
      net: 'routed',
      port: 'items',
      members: ['1'],
      fromPort: 'results',
      fromMembers: ['1'],
    }])

    const store = new DocumentStore(original, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(true)
    expect(store.doc.graphs.g0!.links.linked!.from).toEqual(mport('old', 'items', '0'))
    expect(store.doc.graphs.g0!.nets.routed!.source).toEqual(mport('old', 'items', '1'))
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(original)
    expect(store.redo()).toBe(true)
    expect(store.doc.graphs.g0!.links.linked!.from).toEqual(mport('old', 'items', '0'))
  })

  it('requires an unchanged, admitted literal count when copying without a predecessor schema', () => {
    const resolve = (type: string) => type === 'FamilyOutputOld' ? undefined : outputResolve(type)
    for (const count of [-1, 1.5, '2', 513]) {
      const original = doc({ g0: graph({
        id: 'g0', nodes: { old: node('old', 'FamilyOutputOld', { count }) },
      }) })
      expect(planReplacement(original, 'g0', 'old', copyRule, resolve).plan).toBeUndefined()
    }
    const original = doc({ g0: graph({
      id: 'g0', nodes: { old: node('old', 'FamilyOutputOld', { count: 0 }) },
    }) })
    const planned = planReplacement(original, 'g0', 'old', copyRule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.values).toEqual({ quantity: 0 })
    expect(planned.plan?.sourceCountGuards).toEqual({ count: 0 })
    const transformed: ReplacementRule = {
      ...copyRule,
      cases: [{
        ...copyRule.cases[0]!,
        inputs: { quantity: { kind: 'constant', value: 0 } },
      }],
    }
    expect(planReplacement(original, 'g0', 'old', transformed, resolve).diagnostics)
      .toContainEqual(expect.objectContaining({ code: 'replace.outputFamily.countMapping' }))
  })

  it('maps ordinary source outputs to explicit canonical target members', () => {
    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          old: node('old', 'StaticOutputOld'),
          dst: node('dst', 'Consumer'),
        },
        links: {
          left: link('left', port('old', 'left'), port('dst', 'a')),
          right: link('right', port('old', 'right'), port('dst', 'b')),
        },
        nets: {
          routed: net('routed', port('old', 'right'), [port('dst', 'routed')]),
        },
      }),
    })
    const rule: ReplacementRule = {
      from: 'StaticOutputOld',
      cases: [{
        to: 'FamilyOutputNew',
        inputs: { quantity: { kind: 'constant', value: 2 } },
        outputFamilies: {
          items: {
            kind: 'members',
            members: [{ suffix: '0', output: 'left' }, { suffix: '1', output: 'right' }],
          },
        },
      }],
    }
    const planned = planReplacement(original, 'g0', 'old', rule, outputResolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan?.outputRewires).toEqual([
      { link: 'left', port: 'items', members: ['0'], fromPort: 'left' },
      { link: 'right', port: 'items', members: ['1'], fromPort: 'right' },
    ])
    expect(planned.plan?.netSourceRewires).toEqual([
      { net: 'routed', port: 'items', members: ['1'], fromPort: 'right' },
    ])
    const store = new DocumentStore(original, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(true)
    expect(store.doc.graphs.g0!.links.left!.from).toEqual(mport('old', 'items', '0'))
    expect(store.doc.graphs.g0!.links.right!.from).toEqual(mport('old', 'items', '1'))
    expect(store.doc.graphs.g0!.nets.routed!.source).toEqual(mport('old', 'items', '1'))
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(original)

    const baseGraph = original.graphs.g0!
    const staleLink = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          links: {
            ...baseGraph.links,
            left: link('left', port('old', 'right'), port('dst', 'a')),
          },
        },
      },
    }
    const staleLinkStore = new DocumentStore(staleLink, coreCommandRegistry())
    expect(staleLinkStore.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(false)
    expect(staleLinkStore.doc).toEqual(staleLink)

    const staleNet = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nets: {
            ...baseGraph.nets,
            routed: net('routed', port('old', 'left'), [port('dst', 'routed')]),
          },
        },
      },
    }
    const staleNetStore = new DocumentStore(staleNet, coreCommandRegistry())
    expect(staleNetStore.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Json }).ok)
      .toBe(false)
    expect(staleNetStore.doc).toEqual(staleNet)
  })

  it.each([false, true])('rejects linked counts and stale endpoints with predecessor schema available=%s', (available) => {
    const resolve = (type: string) => type === 'FamilyOutputOld' && !available ? undefined : outputResolve(type)
    const linkedCount = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'FamilyOutputOld', { count: 1 }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          count: link('count', port('src', 'out'), port('old', 'count')),
          result: link('result', mport('old', 'results', '0'), port('dst', 'in')),
        },
      }),
    })
    const rejected = planReplacement(linkedCount, 'g0', 'old', copyRule, resolve)
    expect(rejected.plan).toBeUndefined()
    expect(rejected.diagnostics).toContainEqual(expect.objectContaining({
      code: 'replace.source.outputFamilyInvalid',
    }))

    const original = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'FamilyOutputOld', { count: 2 }), dst: node('dst', 'Consumer') },
        links: { result: link('result', mport('old', 'results', '0'), port('dst', 'in')) },
      }),
    })
    const plan = planReplacement(original, 'g0', 'old', copyRule, resolve).plan!
    expect(plan.sourceCountGuards).toEqual({ count: 2 })
    const baseGraph = original.graphs.g0!
    const stale = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          links: { ...baseGraph.links, result: link('result', mport('old', 'results', '1'), port('dst', 'in')) },
        },
      },
    }
    const store = new DocumentStore(stale, coreCommandRegistry())
    const applied = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Json })
    expect(applied.ok).toBe(false)
    expect(applied.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
    expect(store.doc).toEqual(stale)

    const changedCount = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nodes: {
            ...baseGraph.nodes,
            old: { ...baseGraph.nodes.old!, values: { count: 1 } },
          },
        },
      },
    }
    const linkedAfterPlanning = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nodes: { ...baseGraph.nodes, src: node('src', 'Producer') },
          links: {
            ...baseGraph.links,
            count: link('count', port('src', 'out'), port('old', 'count')),
          },
        },
      },
    }
    const netAfterPlanning = {
      ...original,
      graphs: {
        ...original.graphs,
        g0: {
          ...baseGraph,
          nodes: { ...baseGraph.nodes, src: node('src', 'Producer') },
          nets: {
            ...baseGraph.nets,
            count: net('count', port('src', 'out'), [port('old', 'count')]),
          },
        },
      },
    }
    for (const current of [changedCount, linkedAfterPlanning, netAfterPlanning]) {
      const currentStore = new DocumentStore(current, coreCommandRegistry())
      const result = currentStore.dispatch({ command: 'node.replace', params: { plan } as unknown as Json })
      expect(result.ok).toBe(false)
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'replace.stale' }))
      expect(currentStore.doc).toEqual(current)
    }
  })

})

// ---------------------------------------------------------------------------
// node.replace command
// ---------------------------------------------------------------------------

describe('1-to-N replacement planning and apply', () => {
  const oneToNRule: ReplacementRule = {
    from: 'OldNode',
    note: 'expand around a list-native primary',
    cases: [{
      to: 'ListPrimary',
      nodes: {
        join: { type: 'ListJoin', values: { count: 2 } },
        split: { type: 'ListSplit' },
      },
      inputs: {
        'join:a': { kind: 'copy', input: 'in_image' },
        'join:b': { kind: 'copy', input: 'in_mask' },
        'join:scale': { kind: 'value', input: 'amount' },
      },
      links: [
        { from: 'join:items', to: 'images' },
        { from: 'items', to: 'split:items' },
      ],
      outputs: { 'split:first': 'out_image' },
    }],
  }

  function oneToNDoc(): WorkflowDocument {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          srcA: node('srcA', 'Producer'),
          srcB: node('srcB', 'Producer'),
          old: node('old', 'OldNode', { amount: 0.5 }, { controllers: { amount: 'increment' } }),
          dst: node('dst', 'Consumer'),
        },
        links: {
          l1: link('l1', port('srcA', 'out'), port('old', 'in_image')),
          l2: link('l2', port('srcB', 'out'), port('old', 'in_mask')),
          l3: link('l3', port('old', 'out_image'), port('dst', 'in')),
        },
      }),
    })
    return {
      ...d,
      view: { graphs: { g0: { nodes: { old: { position: { x: 40, y: 60 } } } } } },
    }
  }

  it('creates helpers, rewires helper addresses, records provenance, and places a deterministic view stack', () => {
    const before = oneToNDoc()
    const planned = planReplacement(before, 'g0', 'old', oneToNRule, resolve)
    expect(planned.diagnostics).toEqual([])
    expect(planned.plan!.createdNodes).toEqual([
      {
        nodeId: 'old:join',
        localId: 'join',
        type: 'ListJoin',
        values: { count: 2, scale: 0.5, untouched: 7 },
        controllers: { scale: 'increment' },
      },
      { nodeId: 'old:split', localId: 'split', type: 'ListSplit', values: {} },
    ])
    expect(planned.plan!.inputRewires).toEqual([
      { link: 'l1', node: 'old:join', port: 'a' },
      { link: 'l2', node: 'old:join', port: 'b' },
    ])
    expect(planned.plan!.outputRewires).toEqual([
      { link: 'l3', node: 'old:split', port: 'first' },
    ])
    expect(planned.plan!.links).toEqual([
      { from: port('old:join', 'items'), to: port('old', 'images') },
      { from: port('old', 'items'), to: port('old:split', 'items') },
    ])

    const store = new DocumentStore(before, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan: planned.plan! } as unknown as Record<string, Json> }).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nodes.old!.type).toBe('ListPrimary')
    expect(g.nodes['old:join']).toMatchObject({ type: 'ListJoin', values: { count: 2, scale: 0.5, untouched: 7 } })
    expect(g.nodes['old:split']).toMatchObject({ type: 'ListSplit', values: {} })
    expect(g.links.l1!.to).toEqual(port('old:join', 'a'))
    expect(g.links.l2!.to).toEqual(port('old:join', 'b'))
    expect(g.links.l3!.from).toEqual(port('old:split', 'first'))
    expect(g.links.l100).toMatchObject({ from: port('old:join', 'items'), to: port('old', 'images') })
    expect(g.links.l101).toMatchObject({ from: port('old', 'items'), to: port('old:split', 'items') })
    expect(store.doc.view.graphs.g0!.nodes['old:join']!.position).toEqual({ x: 360, y: 60 })
    expect(store.doc.view.graphs.g0!.nodes['old:split']!.position).toEqual({ x: 360, y: 240 })
    expect(checkDocument(store.doc)).toEqual([])
    expect(store.undo()).toBe(true)
    // Allocation cursors are monotonic across undo; all semantic/view state restores.
    expect(store.doc.graphs.g0!.nextOrdinal).toBe(102)
    expect({
      ...store.doc,
      graphs: { ...store.doc.graphs, g0: { ...store.doc.graphs.g0!, nextOrdinal: 100 } },
    }).toEqual(before)
  })

  it('rejects a helper-id collision while planning', () => {
    const d = oneToNDoc()
    const g = d.graphs.g0!
    const collided = {
      ...d,
      graphs: { ...d.graphs, g0: { ...g, nodes: { ...g.nodes, 'old:join': node('old:join', 'Other') } } },
    }
    const out = planReplacement(collided, 'g0', 'old', oneToNRule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 'replace.helper.collision')).toBe(true)
  })

  it('rejects unknown helper ports and boundary retargeting to a helper', () => {
    const badPort: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'ListPrimary',
        nodes: { join: { type: 'ListJoin' } },
        inputs: { 'join:nope': { kind: 'copy', input: 'in_image' } },
      }],
    }
    expect(
      planReplacement(oneToNDoc(), 'g0', 'old', badPort, resolve).diagnostics.some(
        (d) => d.code === 'replace.target.inputMissing',
      ),
    ).toBe(true)

    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { old: node('old', 'OldNode') },
        boundary: {
          inputs: [{ id: 'bound', binds: { kind: 'port' as const, ...port('old', 'in_image') } }],
          outputs: [],
        },
      }),
    })
    const boundaryRule: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'ListPrimary',
        nodes: { join: { type: 'ListJoin' } },
        inputs: { 'join:a': { kind: 'copy', input: 'in_image' } },
      }],
    }
    const out = planReplacement(d, 'g0', 'old', boundaryRule, resolve)
    expect(out.plan).toBeUndefined()
    expect(out.diagnostics.some((d) => d.code === 'replace.boundary.helper')).toBe(true)
  })

  it('rewires helper net sinks and sources without reordering unaffected sinks', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          old: node('old', 'OldNode'),
          dst: node('dst', 'Consumer'),
        },
        nets: {
          incoming: net('incoming', port('src', 'out'), [port('old', 'in_image'), port('dst', 'other')]),
          outgoing: net('outgoing', port('old', 'out_image'), [port('dst', 'in')]),
        },
      }),
    })
    const plan = planReplacement(d, 'g0', 'old', oneToNRule, resolve).plan!
    expect(plan.netSinks).toEqual([
      { net: 'incoming', sinks: [port('old:join', 'a'), port('dst', 'other')] },
    ])
    expect(plan.netSourceRewires).toEqual([
      { net: 'outgoing', node: 'old:split', port: 'first' },
    ])

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.incoming!.sinks).toEqual([
      port('old:join', 'a'),
      port('dst', 'other'),
    ])
    expect(store.doc.graphs.g0!.nets.outgoing!.source).toEqual(port('old:split', 'first'))
  })

  it('preserves both helper sinks when batched replacements share one net', () => {
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: {
          src: node('src', 'Producer'),
          a: node('a', 'OldNode'),
          b: node('b', 'OldNode'),
        },
        nets: {
          shared: net('shared', port('src', 'out'), [port('a', 'in_image'), port('b', 'in_image')]),
        },
      }),
    })
    const registry = createReplacementRegistry()
    expect(registry.register('core', oneToNRule)).toEqual([])
    const items = scanReplacements(d, registry, resolve)
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items, d, resolve)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nets.shared!.sinks).toEqual([
      port('a:join', 'a'),
      port('b:join', 'a'),
    ])
  })

})

describe('node.replace', () => {
  function storeWith(d: WorkflowDocument) {
    return new DocumentStore(d, coreCommandRegistry())
  }

  function planFor(store: DocumentStore, rule = basicRule): NodeReplacePlan {
    const out = planReplacement(store.doc, 'g0', 'old', rule, resolve)
    expect(out.plan).toBeDefined()
    return out.plan!
  }

  it('applies a plan atomically: node identity, values, links, one undo step', () => {
    const store = storeWith(
      doc({
        g0: graph({
          id: 'g0',
          nodes: {
            src: node('src', 'Producer'),
            old: node('old', 'OldNode', { amount: 0.5 }, { title: 'My Old', mode: 'muted', ext: { pack: { keep: true } }, dynamic: { items: { members: [] } } }),
            dst: node('dst', 'Consumer'),
          },
          links: {
            l1: link('l1', port('src', 'out'), port('old', 'in_image')),
            l2: link('l2', port('old', 'out_image'), port('dst', 'in')),
          },
        }),
      }),
    )
    const before = store.doc
    const plan = planFor(store)
    const out = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> })
    expect(out.ok).toBe(true)

    const g = store.doc.graphs.g0!
    const n = g.nodes.old!
    expect(n.type).toBe('NewNode')
    expect(n.values).toEqual({ strength: 0.5, mode: 'bilinear' })
    expect(n.title).toBe('My Old') // identity survives
    expect(n.mode).toBe('muted')
    expect(n.ext).toEqual({ pack: { keep: true } })
    expect(n.dynamic).toBeUndefined() // dynamic state dropped
    expect(g.links.l1!.to).toEqual(port('old', 'image'))
    expect(g.links.l2!.from).toEqual(port('old', 'image'))
    expect(checkDocument(store.doc)).toEqual([])

    // ONE undo restores the exact pre-replacement document.
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('applies net rewrites and drops, keeping invariants green', () => {
    const store = storeWith(
      {
        ...doc({
          g0: graph({
            id: 'g0',
            nodes: { src: node('src', 'P'), old: node('old', 'OldNode'), dst: node('dst', 'C') },
            nets: {
              netIn: net('netIn', port('src', 'out'), [port('old', 'in_image'), port('dst', 'other')]),
              netOut: net('netOut', port('old', 'out_image'), [port('dst', 'in')]),
            },
          }),
        }),
        ext: { 'dinkster.netViews': [
          { graphId: 'g0', netId: 'netIn', role: 'source', position: { x: 10, y: 20 } },
          { graphId: 'g0', netId: 'netIn', role: 'sink', to: { node: 'old', port: 'in_image' }, position: { x: 30, y: 40 } },
          { graphId: 'g0', netId: 'netIn', role: 'sink', to: { node: 'dst', port: 'other' }, position: { x: 50, y: 60 } },
          { graphId: 'g0', netId: 'netOut', role: 'source', position: { x: 70, y: 80 } },
        ] },
      },
    )
    const plan = planFor(store)
    expect(plan.netSinkEdits).toEqual([
      { net: 'netIn', from: port('old', 'in_image'), to: port('old', 'image') },
    ])
    expect(store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> }).ok).toBe(true)
    const g = store.doc.graphs.g0!
    expect(g.nets.netIn!.sinks).toEqual([port('old', 'image'), port('dst', 'other')])
    expect(g.nets.netOut!.source).toEqual(port('old', 'image'))
    expect(netViewPositions(store.doc, 'g0')).toEqual([
      { graphId: 'g0', netId: 'netIn', role: 'source', geometry: { kind: 'absolute', x: 10, y: 20 } },
      { graphId: 'g0', netId: 'netIn', role: 'sink', to: port('dst', 'other'), geometry: { kind: 'absolute', x: 50, y: 60 } },
      { graphId: 'g0', netId: 'netOut', role: 'source', geometry: { kind: 'absolute', x: 70, y: 80 } },
    ])
    expect(checkDocument(store.doc)).toEqual([])
  })

  it('replaces controllers wholesale (stale source controllers never linger)', () => {
    const rule: ReplacementRule = {
      from: 'OldSeeded',
      cases: [{ to: 'SeededNode', inputs: { seed: { kind: 'value', input: 'noise_seed' } } }],
    }
    const store = storeWith(
      doc({
        g0: graph({
          id: 'g0',
          nodes: { old: node('old', 'OldSeeded', { noise_seed: 7 }, { controllers: { noise_seed: 'increment' } }) },
        }),
      }),
    )
    const out = planReplacement(store.doc, 'g0', 'old', rule, resolve)
    expect(store.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> }).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.controllers).toEqual({ seed: 'increment' })
  })

  it('rejects a stale plan (type changed) without mutating', () => {
    const store = storeWith(wiredDoc())
    const plan = planFor(store)
    const stale = { ...plan, from: 'SomethingElse' }
    const out = store.dispatch({ command: 'node.replace', params: { plan: stale } as unknown as Record<string, Json> })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.revision).toBe(0)
    expect(store.doc).toEqual(wiredDoc())
  })

  it('rejects a stale plan (referenced link gone) without mutating', () => {
    const store = storeWith(wiredDoc())
    const plan = planFor(store)
    expect(store.dispatch({ command: 'link.disconnect', params: { graphId: 'g0', linkId: 'l1' } }).ok).toBe(true)
    const before = store.doc
    const out = store.dispatch({ command: 'node.replace', params: { plan } as unknown as Record<string, Json> })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.diagnostics[0]!.code).toBe('replace.stale')
    expect(store.doc).toBe(before)
  })

  /** Subgraph doc: root g0 holds an instance of g1; g1's boundary binds 'old'. */
  function boundDoc(): WorkflowDocument {
    return doc(
      {
        g0: graph({ id: 'g0', nodes: { inst: node('inst', '#g1') } }),
        g1: graph({
          id: 'g1',
          nodes: { keep: node('keep', 'Other'), old: node('old', 'OldNode', { amount: 0.5 }) },
          boundary: {
            inputs: [{
              id: 'bi',
              binds: { kind: 'port' as const, ...port('old', 'in_image') },
              promoted: false,
            }, {
              id: 'bi2',
              displayName: 'Fan out',
              binds: { kind: 'port' as const, ...port('keep', 'in_image') },
              alsoBinds: [{ kind: 'port' as const, ...port('old', 'in_image') }],
            }, {
              id: 'unused',
              binds: { kind: 'unbound', type: { kind: 'concrete', name: 'INT' } },
            }],
            outputs: [{ id: 'bo', binds: { kind: 'port' as const, ...port('old', 'out_image') } }],
          },
        }),
      },
      'g0',
    )
  }

  it('migrates boundary bindings atomically and restores them on undo', () => {
    const store = storeWith(boundDoc())
    const before = store.doc
    const out = planReplacement(store.doc, 'g1', 'old', basicRule, resolve)
    expect(out.plan!.boundaryRewires).toEqual([
      { item: 'bi', side: 'input', fromPort: 'in_image', port: 'image' },
      { item: 'bi2', side: 'input', fromPort: 'in_image', port: 'image', alsoIndex: 0 },
      { item: 'bo', side: 'output', fromPort: 'out_image', port: 'image' },
    ])
    expect(store.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> }).ok).toBe(true)

    const b = store.doc.graphs.g1!.boundary!
    expect(b.inputs[0]).toEqual({ id: 'bi', binds: { kind: 'port', ...port('old', 'image') }, promoted: false })
    expect(b.inputs[1]).toEqual({
      id: 'bi2',
      displayName: 'Fan out',
      binds: { kind: 'port', ...port('keep', 'in_image') }, // untouched: other node
      alsoBinds: [{ kind: 'port', ...port('old', 'image') }],
    })
    expect(b.inputs[2]).toEqual(before.graphs.g1!.boundary!.inputs[2])
    expect(b.outputs[0]).toEqual({ id: 'bo', binds: { kind: 'port', ...port('old', 'image') } })
    expect(store.doc.graphs.g1!.nodes.old!.type).toBe('NewNode')
    expect(checkDocument(store.doc)).toEqual([])

    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(before)
  })

  it('rejects a plan whose boundary binding was detached since planning', () => {
    const store = storeWith(boundDoc())
    const out = planReplacement(store.doc, 'g1', 'old', basicRule, resolve)
    // Simulate a concurrent boundary edit: 'bi' rebound to another node.
    const d = store.doc
    const g1 = d.graphs.g1!
    const mutated = {
      ...d,
      graphs: {
        ...d.graphs,
        g1: {
          ...g1,
          boundary: {
            inputs: [{ id: 'bi', binds: { kind: 'port' as const, ...port('keep', 'in_image') } }, g1.boundary!.inputs[1]!],
            outputs: g1.boundary!.outputs,
          },
        },
      },
    }
    const store2 = storeWith(mutated)
    const res = store2.dispatch({ command: 'node.replace', params: { plan: out.plan! } as unknown as Record<string, Json> })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.diagnostics[0]!.code).toBe('replace.stale')
    expect(store2.doc).toEqual(mutated)
  })

})

// ---------------------------------------------------------------------------
// Scan + apply orchestration
// ---------------------------------------------------------------------------

describe('registerSchemaRules', () => {

  it('skips malformed shipped rules, naming the shipping schema', () => {
    const reg = createReplacementRegistry()
    const bad = { from: 'X', cases: [] } as unknown as ReplacementRule
    const successor: NodeSchema = { ...schemas.NewNode!, replacements: [bad, basicRule] }
    const diags = registerSchemaRules(reg, [successor])
    expect(diags).toHaveLength(1)
    expect(diags[0]!.message).toContain("schema 'NewNode'")
    expect(reg.rulesFor('OldNode')).toEqual([basicRule])
  })
})

describe('scanReplacements', () => {
  function registryWith(...rules: ReplacementRule[]) {
    const reg = createReplacementRegistry()
    for (const r of rules) expect(reg.register('core', r)).toEqual([])
    return reg
  }

  it('finds every migratable node across graphs; skips others', () => {
    const d = doc(
      {
        g0: graph({
          id: 'g0',
          nodes: { old: node('old', 'OldNode'), keep: node('keep', 'NewNode'), inst: node('inst', '#g1') },
        }),
        g1: graph({ id: 'g1', nodes: { old2: node('old2', 'OldNode') } }),
      },
      'g0',
    )
    const items = scanReplacements(d, registryWith(basicRule), resolve)
    expect(items.map((i) => `${i.graphId}/${i.nodeId}`)).toEqual(['g0/old', 'g1/old2'])
    expect(items.every((i) => i.safe && i.plan !== undefined)).toBe(true)
  })

  it('a warned plan is not safe; an unplannable node reports its failures', () => {
    // Rule with no mappings: wired connections drop -> warnings.
    const lossy: ReplacementRule = { from: 'OldNode', cases: [{ to: 'NewNode' }] }
    const items = scanReplacements(wiredDoc(), registryWith(lossy), resolve)
    expect(items).toHaveLength(1)
    expect(items[0]!.plan).toBeDefined()
    expect(items[0]!.safe).toBe(false)

    const impossible: ReplacementRule = { from: 'OldNode', cases: [{ to: 'Nonexistent' }] }
    const failed = scanReplacements(wiredDoc(), registryWith(impossible), resolve)
    expect(failed[0]!.plan).toBeUndefined()
    expect(failed[0]!.safe).toBe(false)
    expect(failed[0]!.diagnostics.some((x) => x.code === 'replace.target.unknown')).toBe(true)
  })

  it('the first rule that plans wins; later rules are fallbacks only', () => {
    const broken: ReplacementRule = { from: 'OldNode', cases: [{ to: 'Nonexistent' }] }
    const items = scanReplacements(
      doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) }),
      registryWith(broken, basicRule),
      resolve,
    )
    expect(items[0]!.plan?.to).toBe('NewNode')
    expect(items[0]!.rule).toBe(basicRule)
  })

  it.each(['tap', 'net', 'archive', 'archive-link-only', 'archive-net-only'] as const)('composes %s deletion overlaps in either node order', (connection) => {
    const localSchemas: Record<string, NodeSchema> = {
      PreviousProducer: schemaOf('PreviousProducer', [widgetInput('oldAmount', 7), output('out')]),
      Producer: schemaOf('Producer', [widgetInput('amount', 7), output('out')]),
      Sink: schemaOf('Sink', [widgetInput('amount', 3)]),
    }
    const localResolve = (type: string) => localSchemas[type]
    const producerRule: ReplacementRule = { from: 'PreviousProducer', cases: [{ to: 'Producer', inputs: { amount: { kind: 'copy', input: 'oldAmount' } } }] }
    const archive = connection.startsWith('archive')
    const evidenceOnly = connection === 'archive-link-only' || connection === 'archive-net-only'
    const namedNet = connection === 'net' || connection === 'archive-net-only'
    const sinkRule: ReplacementRule = archive
      ? { from: 'Sink', migration: { historicalInputs: ['oldAmount'] }, cases: [{ to: 'Sink', inputs: { amount: { kind: 'copy', input: 'oldAmount' } } }] }
      : { from: 'PreviousSink', cases: [{ to: 'Sink', inputs: { amount: { kind: 'copy', input: 'oldAmount' } } }] }
    for (const producerFirst of [false, true]) {
      const producer = node('producer', 'PreviousProducer', { oldAmount: 11 })
      const sink = node('sink', archive ? 'Sink' : 'PreviousSink', evidenceOnly ? {} : { oldAmount: 29 })
      const expectedAmount = evidenceOnly ? 3 : 29
      const d = doc({ g0: graph({
        id: 'g0',
        nodes: producerFirst ? { producer, sink } : { sink, producer },
        links: namedNet ? {} : {
          shared: link('shared', connection === 'tap'
            ? { node: asNodeId('producer'), tap: asPortId('oldAmount') }
            : port('producer', 'out'), port('sink', archive ? 'oldAmount' : 'discarded')),
        },
        nets: namedNet ? { shared: net('shared', port('producer', 'out'), [port('sink', 'oldAmount')]) } : {},
      }) })
      const items = scanReplacements(d, registryWith(producerRule, sinkRule), localResolve)
      expect(items, JSON.stringify(items)).toHaveLength(2)
      expect(items.every((item) => item.hops.length === 1), JSON.stringify(items)).toBe(true)
      if (connection === 'tap') expect(items.find((item) => item.nodeId === 'producer')!.plan!.tapRewires).toHaveLength(1)
      const snapshot = structuredClone(d)
      const invocation = replacementInvocation(items, d, localResolve)!
      expect(d).toEqual(snapshot)
      const store = new DocumentStore(d, coreCommandRegistry())
      const result = store.dispatch(invocation)
      expect(result.ok, JSON.stringify({ producerFirst, diagnostics: result.diagnostics })).toBe(true)
      expect(store.doc.graphs.g0!.nodes.producer!.values).toEqual({ amount: 11 })
      expect(store.doc.graphs.g0!.nodes.sink!.values).toEqual({ amount: expectedAmount })
      expect(store.doc.graphs.g0!.links).toEqual({})
      expect(store.doc.graphs.g0!.nets).toEqual({})
      if (archive) {
        expect(store.doc.graphs.g0!.nodes.sink!.ext?.[REPLACEMENT_MIGRATION_ARCHIVE_EXT_KEY]).toMatchObject({
          node: snapshot.graphs.g0!.nodes.sink,
          links: snapshot.graphs.g0!.links,
          nets: snapshot.graphs.g0!.nets,
        })
        const changed = structuredClone(d)
        ;(changed.graphs.g0!.nodes.sink!.values as Record<string, Json>).oldAmount = 97
        expect(replacementInvocation(items, changed, localResolve)).toBeUndefined()
        const stale = new DocumentStore(changed, coreCommandRegistry())
        expect(stale.dispatch(invocation).ok).toBe(false)
        expect(stale.doc).toEqual(changed)
      }
      expect(store.revision).toBe(1)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(d)
      expect(store.canUndo).toBe(false)
      expect(store.redo()).toBe(true)
      expect(store.doc.graphs.g0!.nodes.sink!.values).toEqual({ amount: expectedAmount })
    }
  })

  it('preserves selected connected cases and their chains after peer disconnection', () => {
    const localSchemas: Record<string, NodeSchema> = {
      Producer: schemaOf('Producer', []),
      ConnectedSink: schemaOf('ConnectedSink', [widgetInput('amount', 3)]),
      DisconnectedSink: schemaOf('DisconnectedSink', [widgetInput('amount', 5)]),
      FinalSink: schemaOf('FinalSink', [widgetInput('amount', 7)]),
    }
    const localResolve = (type: string) => localSchemas[type]
    const rules: ReplacementRule[] = [
      { from: 'PreviousProducer', cases: [{ to: 'Producer' }] },
      { from: 'PreviousSink', cases: [
        { when: { kind: 'inputConnected', input: 'legacy' }, to: 'ConnectedSink', inputs: { amount: { kind: 'constant', value: 29 } } },
        { to: 'DisconnectedSink', inputs: { amount: { kind: 'constant', value: 97 } } },
      ] },
      { from: 'ConnectedSink', cases: [{ to: 'FinalSink', inputs: { amount: { kind: 'copy', input: 'amount' } } }] },
    ]
    for (const producerFirst of [false, true]) {
      const producer = node('producer', 'PreviousProducer')
      const sink = node('sink', 'PreviousSink')
      const d = doc({ g0: graph({ id: 'g0', nodes: producerFirst ? { producer, sink } : { sink, producer },
        links: { shared: link('shared', port('producer', 'out'), port('sink', 'legacy')) },
      }) })
      const items = scanReplacements(d, registryWith(...rules), localResolve)
      expect(items.find((item) => item.nodeId === 'sink')!.hops).toHaveLength(2)
      const forged = items.map((item) => item.nodeId !== 'sink' ? item : {
        ...item, hops: [{ ...item.hops[0]!, plan: { ...item.hops[0]!.plan, caseIndex: 1 } }],
      })
      expect(replacementInvocation(forged, d, localResolve)).toBeUndefined()
      const invocation = replacementInvocation(items, d, localResolve)
      expect(invocation).toBeDefined()
      const store = new DocumentStore(d, coreCommandRegistry())
      expect(store.dispatch(invocation!).ok).toBe(true)
      expect(store.doc.graphs.g0!.nodes.sink).toMatchObject({ type: 'FinalSink', values: { amount: 29 } })
      expect(store.doc.graphs.g0!.links).toEqual({})
      expect(store.revision).toBe(1)
      expect(store.undo()).toBe(true)
      expect(store.doc).toEqual(d)
      expect(store.redo()).toBe(true)
      expect(store.doc.graphs.g0!.nodes.sink!.values).toEqual({ amount: 29 })
    }
  })

  it('replacementInvocation batches several plans into one undo step', () => {
    const d = doc({
      g0: graph({ id: 'g0', nodes: { a: node('a', 'OldNode', { amount: 1 }), b: node('b', 'OldNode', { amount: 2 }) } }),
    })
    const items = scanReplacements(d, registryWith(basicRule), resolve)
    expect(items).toHaveLength(2)
    const inv = replacementInvocation(items, d, resolve)!
    expect(inv.command).toBe('batch')

    const store = new DocumentStore(d, coreCommandRegistry())
    const out = store.dispatch(inv)
    expect(out.ok).toBe(true)
    expect(store.revision).toBe(1)
    expect(store.doc.graphs.g0!.nodes.a!.type).toBe('NewNode')
    expect(store.doc.graphs.g0!.nodes.b!.type).toBe('NewNode')
    expect(store.doc.graphs.g0!.nodes.a!.values).toEqual({ strength: 1, mode: 'bilinear' })
    expect(store.undo()).toBe(true)
    expect(store.doc).toEqual(d)

    // Single plan dispatches node.replace directly; nothing planned -> undefined.
    expect(replacementInvocation([items[0]!], d, resolve)!.command).toBe('node.replace')
    expect(replacementInvocation([], d, resolve)).toBeUndefined()
  })

  it('does not re-plan helpers created during the same scan/apply pass', () => {
    const createHelper: ReplacementRule = {
      from: 'OldNode',
      cases: [{
        to: 'NewNode',
        nodes: { helper: { type: 'ListJoin' } },
      }],
    }
    const migrateHelper: ReplacementRule = {
      from: 'ListJoin',
      cases: [{ to: 'ListSplit' }],
    }
    const migratePrimary: ReplacementRule = {
      from: 'NewNode',
      cases: [{ to: 'SamePorts' }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { old: node('old', 'OldNode') } }) })
    const items = scanReplacements(
      d,
      registryWith(createHelper, migrateHelper, migratePrimary),
      resolve,
    )
    expect(items).toHaveLength(1)
    expect(items[0]!.nodeId).toBe('old')
    expect(items[0]!.hops.map((hop) => hop.plan.to)).toEqual(['NewNode', 'SamePorts'])

    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation(items, d, resolve)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.old!.type).toBe('SamePorts')
    expect(store.doc.graphs.g0!.nodes['old:helper']!.type).toBe('ListJoin')
  })
})

// ---------------------------------------------------------------------------
// Replacement chains (A -> B where B is itself migrated to C)
// ---------------------------------------------------------------------------

describe('replacement chains', () => {
  const chainSchemas: Record<string, NodeSchema> = {
    ChainA: schemaOf('ChainA', [widgetInput('x', 0), output('out')]),
    ChainB: schemaOf('ChainB', [widgetInput('y', 0), output('out')]),
    ChainC: schemaOf('ChainC', [widgetInput('z', 0), output('out')]),
    Consumer: schemaOf('Consumer', [input('in')]),
  }
  const chainResolve = (type: string): NodeSchema | undefined => chainSchemas[type]

  const ruleAB: ReplacementRule = {
    from: 'ChainA',
    cases: [{ to: 'ChainB', inputs: { y: { kind: 'value', input: 'x' } }, outputs: { out: 'out' } }],
  }

  function registryWith(...rules: ReplacementRule[]) {
    const reg = createReplacementRegistry()
    for (const r of rules) expect(reg.register('core', r)).toEqual([])
    return reg
  }

  it('a warning on a LATER hop makes the whole chain unsafe but keeps every hop', () => {
    // ruleBC without an output mapping: the wired link drops at hop 2.
    const lossyBC: ReplacementRule = {
      from: 'ChainB',
      cases: [{ to: 'ChainC', inputs: { z: { kind: 'value', input: 'y' } } }],
    }
    const d = doc({
      g0: graph({
        id: 'g0',
        nodes: { a: node('a', 'ChainA', { x: 1 }), dst: node('dst', 'Consumer') },
        links: { l1: link('l1', port('a', 'out'), port('dst', 'in')) },
      }),
    })
    const items = scanReplacements(d, registryWith(ruleAB, lossyBC), chainResolve)
    const item = items[0]!
    expect(item.status).toBe('terminal')
    expect(item.hops).toHaveLength(2)
    expect(item.hops[0]!.diagnostics).toEqual([])
    expect(item.hops[1]!.diagnostics.length).toBeGreaterThan(0)
    expect(item.safe).toBe(false)
  })

  it('a later hop that cannot plan blocks with the safe prefix intact', () => {
    const brokenBC: ReplacementRule = { from: 'ChainB', cases: [{ to: 'Nonexistent' }] }
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { x: 1 }) } }) })
    const items = scanReplacements(d, registryWith(ruleAB, brokenBC), chainResolve)
    const item = items[0]!
    expect(item.status).toBe('blocked')
    expect(item.hops).toHaveLength(1)
    expect(item.terminalType).toBe('ChainB')
    expect(item.safe).toBe(false)
    expect(item.diagnostics.some((x) => x.code === 'replace.target.unknown')).toBe(true)
    // Explicit review-apply still migrates the safe prefix.
    const store = new DocumentStore(d, coreCommandRegistry())
    expect(store.dispatch(replacementInvocation([item], d, chainResolve)!).ok).toBe(true)
    expect(store.doc.graphs.g0!.nodes.a!.type).toBe('ChainB')
  })

  it('a cycle stops before re-migrating to a visited type', () => {
    const ruleBA: ReplacementRule = {
      from: 'ChainB',
      cases: [{ to: 'ChainA', inputs: { x: { kind: 'value', input: 'y' } } }],
    }
    const d = doc({ g0: graph({ id: 'g0', nodes: { a: node('a', 'ChainA', { x: 1 }) } }) })
    const items = scanReplacements(d, registryWith(ruleAB, ruleBA), chainResolve)
    const item = items[0]!
    expect(item.status).toBe('cycle')
    expect(item.hops).toHaveLength(1)
    expect(item.terminalType).toBe('ChainB')
    expect(item.safe).toBe(false)
  })

})
