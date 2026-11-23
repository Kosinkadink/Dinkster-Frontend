/**
 * Boundary forwarding lowering.
 *
 * Contract under test: a subgraph boundary item forwards one inner input or
 * output by its flattened id (a static port or one member of a group), per
 * occurrence; chained boundaries, promoted values, reroutes, value sources,
 * bypassed shells and partial execution compose through it. Every test
 * asserts EXACT prompt wiring or output indexes, not just `ok`.
 */
import { describe, expect, it } from 'vitest'
import type { ExecutionScope } from '../src/compile/artifact.js'
import { compile, documentResolver, type CompileInput } from '../src/compile/compile.js'
import { definitionPick, occurrenceDynamicView } from '../src/compile/occurrence-view.js'
import { elaborateInterface } from '../src/schema/elaborate.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import type { BodyRow, ChoiceSpec, GroupSpec, InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const input = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const output = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })
const schemaOf = (type: string, items: BodyRow[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true, // keeps every node in full scope without sinks
  body: items,
})
const floatWidget = (def: number): Pick<InputSpec, 'widget'> => ({
  widget: { widgetType: 'FLOAT', options: {}, default: def },
})

const group = (id: string, prefix: string, value: InputSpec | OutputSpec): GroupSpec => ({
  kind: 'group', id, value, keys: { kind: 'numbered', prefix, start: 0, pad: 0 }, grows: 'link', minMembers: 0, maxMembers: 8,
})

const schemas: Record<string, NodeSchema> = {
  Src: schemaOf('Src', [output('out')]),
  Sink: schemaOf('Sink', [input('in')]),
  OptSink: schemaOf('OptSink', [input('in', { optional: true })]),
  IntSource: schemaOf('IntSource', [{ ...output('out'), type: { kind: 'concrete', name: 'INT' } }]),
  IntValue: schemaOf('IntValue', [input('value', {
    type: { kind: 'concrete', name: 'INT' },
    widget: { widgetType: 'INT', options: {}, default: 0 },
  })]),
  IntSink: schemaOf('IntSink', [input('in', { type: { kind: 'concrete', name: 'INT' } })]),
  // A group of pins: flattened ids images.image0, images.image1, ...
  Batch: schemaOf('Batch', [group('images', 'image', input('image', { optional: true })), output('out')]),
  // A group of fields: member values and member defaults.
  Weigh: schemaOf('Weigh', [group('weights', 'w', input('w', { optional: true, ...floatWidget(0.5) })), output('out')]),
  // A group of outputs followed by a static output (index arithmetic).
  Split: schemaOf('Split', [input('src', { optional: true }), group('outs', 'o', output('o')), output('last')]),
  FallbackRelay: schemaOf('FallbackRelay', [input('fallback', { optional: true }), output('out')]),
}
const resolve = (type: string) => schemas[type]

// ---------------------------------------------------------------------------
// Document builder (subgraph links, reroutes, value sources, nets)
// ---------------------------------------------------------------------------

type End =
  | [node: string, port: string]
  | { reroute: string }
  | { valueSource: string }
  | { node: string; tap: string }
type NodeSpec = {
  type: string
  values?: Record<string, unknown>
  dynamic?: Record<string, unknown>
  mode?: 'active' | 'muted' | 'bypassed'
}
type GraphSpec = {
  nodes: Record<string, NodeSpec>
  links?: [from: End, to: End][]
  reroutes?: string[]
  valueSources?: Record<string, unknown>
  nets?: Record<string, { source: End; sinks: End[] }>
  boundary?: { inputs?: unknown[]; outputs?: unknown[] }
}

const end = (e: End): unknown =>
  Array.isArray(e) ? { node: e[0], port: e[1] } : e

const docOf = (graphs: Record<string, GraphSpec>): WorkflowDocument => {
  const defs: Record<string, unknown> = {}
  for (const [id, g] of Object.entries(graphs)) {
    defs[id] = {
      id,
      name: id,
      nodes: Object.fromEntries(
        Object.entries(g.nodes).map(([nid, n]) => [
          nid,
          {
            id: nid,
            type: n.type,
            values: n.values ?? {},
            ...(n.dynamic ? { dynamic: n.dynamic } : {}),
            ...(n.mode ? { mode: n.mode } : {}),
          },
        ]),
      ),
      links: Object.fromEntries(
        (g.links ?? []).map((l, i) => [`l${i}`, { id: `l${i}`, from: end(l[0]), to: end(l[1]) }]),
      ),
      nets: Object.fromEntries(
        Object.entries(g.nets ?? {}).map(([name, n]) => [
          name,
          { name, source: end(n.source), sinks: n.sinks.map(end) },
        ]),
      ),
      reroutes: Object.fromEntries((g.reroutes ?? []).map((r) => [r, { id: r }])),
      ...(g.valueSources
        ? {
            valueSources: Object.fromEntries(
              Object.entries(g.valueSources).map(([vid, value]) => [vid, { id: vid, value }]),
            ),
          }
        : {}),
      nextOrdinal: 100,
      ...(g.boundary ? { boundary: { inputs: g.boundary.inputs ?? [], outputs: g.boundary.outputs ?? [] } } : {}),
    }
  }
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'test-lineage',
    root: 'g0',
    graphs: defs,
    view: { graphs: {} },
  } as unknown as WorkflowDocument
}

const inputOf = (doc: WorkflowDocument, scope: ExecutionScope = { kind: 'full' }): CompileInput => ({
  document: doc,
  revision: 1,
  resolve,
  scope,
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})
const run = (doc: WorkflowDocument, scope?: ExecutionScope) => compile(inputOf(doc, scope))
const okPrompt = (doc: WorkflowDocument) => {
  const result = run(doc)
  expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
  if (!result.ok) throw new Error('unreachable')
  return result.artifact.prompt
}

// ---------------------------------------------------------------------------
// Focused lowering behavior
// ---------------------------------------------------------------------------

describe('widget output boundary lowering', () => {
  const leaf = (value: number): GraphSpec => ({
    nodes: { n: { type: 'IntValue', values: { value } } },
    boundary: {
      inputs: [{ id: 'value', promoted: true, binds: { kind: 'port', node: 'n', port: 'value' } }],
      outputs: [{ id: 'valueOut', binds: { kind: 'widgetTap', node: 'n', tap: 'value' } }],
    },
  })

  it('bakes the inner widget value through a nested ordinary output boundary', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: { middle: { type: '#middle' }, sink: { type: 'IntSink' } },
        links: [[['middle', 'valueOut'], ['sink', 'in']]],
      },
      middle: {
        nodes: { leaf: { type: '#leaf' } },
        boundary: {
          outputs: [{ id: 'valueOut', binds: { kind: 'port', node: 'leaf', port: 'valueOut' } }],
        },
      },
      leaf: leaf(7),
    }))

    expect(prompt['sink']!.inputs.in).toBe(7)
  })

  it('forwards the real driver of the tapped widget input instead of its stored fallback', () => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: {
          source: { type: 'IntSource' },
          value: { type: '#leaf', values: { value: 99 } },
          sink: { type: 'IntSink' },
        },
        links: [
          [['source', 'out'], ['value', 'value']],
          [['value', 'valueOut'], ['sink', 'in']],
        ],
      },
      leaf: leaf(3),
    }))

    expect(prompt['sink']!.inputs.in).toEqual(['source', 0])
  })
})

describe('boundary address matching (dotted ids, ambiguity)', () => {
  it('a concrete boundary input with a dotted id resolves exactly', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { a: { type: 'Src' }, s: { type: '#sub' }, k: { type: 'Sink' } },
          links: [
            [['a', 'out'], ['s', 'in.image']],
            [['s', 'out.image'], ['k', 'in']],
          ],
        },
        sub: {
          nodes: { b: { type: 'Sink' }, o: { type: 'Src' } },
          boundary: {
            inputs: [{ id: 'in.image', binds: { kind: 'port', node: 'b', port: 'in' } }],
            outputs: [{ id: 'out.image', binds: { kind: 'port', node: 'o', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.b']!.inputs).toEqual({ in: ['a', 0] })
    expect(prompt['k']!.inputs).toEqual({ in: ['s.o', 0] })
  })

})

describe('promoted values', () => {
  it('chained concrete promotion: the outer instance value wins (first-write outside-in)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { s: { type: '#outer', values: { gain: 3 } } },
        },
        outer: {
          nodes: { i: { type: '#inner', values: { gain: 2 } } },
          boundary: {
            inputs: [{ id: 'gain', binds: { kind: 'port', node: 'i', port: 'gain' }, promoted: true }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'i', port: 'out' } }],
          },
        },
        inner: {
          nodes: { n: { type: 'Weigh', dynamic: { weights: { members: ['w0'] } }, values: { 'weights.w0': 1 } } },
          boundary: {
            inputs: [{ id: 'gain', binds: { kind: 'port', node: 'n', port: 'weights.w0' }, promoted: true }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.i.n']!.inputs).toEqual({ 'weights.w0': 3 })
  })

  it('a field shown without a wire takes the value set on each subgraph node, as a wired one does', () => {
    const promptFor = (wireHidden: boolean) => okPrompt(docOf({
      g0: { nodes: { a: { type: '#sub', values: { value: 5 } }, b: { type: '#sub' } } },
      sub: {
        nodes: { n: { type: 'IntValue', values: { value: 2 } } },
        boundary: {
          inputs: [{ id: 'value', binds: { kind: 'port', node: 'n', port: 'value' }, promoted: true, ...(wireHidden ? { wireHidden: true } : {}) }],
        },
      },
    }))
    const hidden = promptFor(true)
    expect(hidden['a.n']!.inputs).toEqual({ value: 5 })
    expect(hidden['b.n']!.inputs).toEqual({ value: 2 })
    expect(hidden).toEqual(promptFor(false))
  })

  it.each([false, true])('a wire into the field on the subgraph node wins over its typed value (wire hidden inside: %s)', (wireHidden) => {
    const prompt = okPrompt(docOf({
      g0: {
        nodes: { src: { type: 'IntSource' }, a: { type: '#sub', values: { value: 5 } } },
        links: [[['src', 'out'], ['a', 'value']]],
      },
      sub: {
        nodes: { n: { type: 'IntValue', values: { value: 2 } } },
        boundary: {
          inputs: [{ id: 'value', binds: { kind: 'port', node: 'n', port: 'value' }, promoted: true, ...(wireHidden ? { wireHidden: true } : {}) }],
        },
      },
    }))
    expect(prompt['a.n']!.inputs).toEqual({ value: ['src', 0] })
  })
})

describe('failure safety', () => {
  it('bypass routes through chained boundaries, a bypassed shell and sibling occurrences stay occurrence-correct', () => {
    const result = run(docOf({
      g0: {
        nodes: {
          activeSource: { type: 'Src' },
          mutedSource: { type: 'Src', mode: 'muted' },
          left: { type: '#middle' },
          right: { type: '#middle' },
          bypassedShell: { type: '#inner', mode: 'bypassed' },
          mutedShell: { type: '#inner', mode: 'muted' },
          leftTarget: { type: 'OptSink' },
          rightTarget: { type: 'OptSink' },
          shellTarget: { type: 'OptSink' },
          mutedTarget: { type: 'OptSink' },
        },
        links: [
          [['activeSource', 'out'], ['left', 'fallback']],
          [['left', 'out'], ['leftTarget', 'in']],
          [['mutedSource', 'out'], ['right', 'fallback']],
          [['right', 'out'], ['rightTarget', 'in']],
          [['activeSource', 'out'], ['bypassedShell', 'fallback']],
          [['bypassedShell', 'out'], ['shellTarget', 'in']],
          [['activeSource', 'out'], ['mutedShell', 'fallback']],
          [['mutedShell', 'out'], ['mutedTarget', 'in']],
        ],
      },
      middle: {
        nodes: { inner: { type: '#inner' } },
        boundary: {
          inputs: [{ id: 'fallback', binds: { kind: 'port', node: 'inner', port: 'fallback' } }],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'inner', port: 'out' } }],
        },
      },
      inner: {
        nodes: { relay: { type: 'FallbackRelay', mode: 'bypassed' } },
        boundary: {
          inputs: [{ id: 'fallback', binds: { kind: 'port', node: 'relay', port: 'fallback' } }],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'relay', port: 'out' } }],
        },
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.leftTarget!.inputs['in']).toEqual(['activeSource', 0])
    expect(result.artifact.prompt.rightTarget!.inputs['in']).toBeUndefined()
    expect(result.artifact.prompt.shellTarget!.inputs['in']).toEqual(['activeSource', 0])
    expect(result.artifact.prompt.mutedTarget!.inputs['in']).toBeUndefined()
    const warning = result.artifact.diagnostics.find((diagnostic) =>
      diagnostic.code === 'compile.bypass.structuralRouteDropped')
    expect(warning?.anchor?.occurrence).toEqual({ instancePath: ['right', 'inner'], node: 'relay' })
    expect(warning?.message).toBe('relay.fallback: selected bypass route has no value')
    expect(warning?.data?.['inputIndex']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Mixed integration: reroutes + value sources + forwarding + partial
// execution composed in single documents.
// ---------------------------------------------------------------------------

describe('mixed integration', () => {
  it('value source -> reroute chain -> a forwarded group member (baked, beats the member default)', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { s: { type: '#sub' } },
          reroutes: ['r0', 'r1'],
          valueSources: { v0: 0.75 },
          links: [
            [{ valueSource: 'v0' }, { reroute: 'r0' }],
            [{ reroute: 'r0' }, { reroute: 'r1' }],
            [{ reroute: 'r1' }, ['s', 'w']],
          ],
        },
        sub: {
          nodes: { n: { type: 'Weigh', dynamic: { weights: { members: ['w0'] } } } },
          boundary: {
            inputs: [{ id: 'w', binds: { kind: 'port', node: 'n', port: 'weights.w0' } }],
            outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
          },
        },
      }),
    )
    expect(prompt['s.n']!.inputs).toEqual({ 'weights.w0': 0.75 })
  })

  it('a forwarded group output member -> reroute -> consumer', () => {
    const prompt = okPrompt(
      docOf({
        g0: {
          nodes: { s: { type: '#sub' }, k: { type: 'Sink' } },
          reroutes: ['r0'],
          links: [
            [['s', 'o'], { reroute: 'r0' }],
            [{ reroute: 'r0' }, ['k', 'in']],
          ],
        },
        sub: {
          nodes: { n: { type: 'Split', dynamic: { outs: { members: ['o0', 'o1'] } } } },
          boundary: {
            outputs: [{ id: 'o', binds: { kind: 'port', node: 'n', port: 'outs.o1' } }],
          },
        },
      }),
    )
    expect(prompt['k']!.inputs).toEqual({ in: ['s.n', 1] })
  })

  it('partial execution scopes through a forwarded group member and reroutes', () => {
    const doc = docOf({
      g0: {
        nodes: {
          a: { type: 'Src' },
          b: { type: 'Src' },
          s: { type: '#sub' },
          other: { type: 'Sink' },
        },
        reroutes: ['r0'],
        links: [
          [['a', 'out'], { reroute: 'r0' }],
          [{ reroute: 'r0' }, ['s', 'image']],
          [['b', 'out'], ['other', 'in']],
        ],
      },
      sub: {
        nodes: { n: { type: 'Batch', dynamic: { images: { members: ['image0'] } } } },
        boundary: {
          inputs: [{ id: 'image', binds: { kind: 'port', node: 'n', port: 'images.image0' } }],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
        },
      },
    })
    const result = run(doc, { kind: 'partial', targets: [{ instancePath: [asNodeId('s')], node: asNodeId('n') }] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    // Upstream closure of the inner node: itself + the Src feeding the
    // forwarded member (through the reroute). The unrelated branch is out.
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 's.n'])
    expect(result.artifact.prompt['s.n']!.inputs).toEqual({ 'images.image0': ['a', 0] })
  })
})

describe('whole constructs shown on a subgraph node', () => {
  const FLOAT: TypeExpr = { kind: 'concrete', name: 'FLOAT' }
  const STRING: TypeExpr = { kind: 'concrete', name: 'STRING' }
  const INT: TypeExpr = { kind: 'concrete', name: 'INT' }
  const constructSchemas: Record<string, NodeSchema> = {
    ...schemas,
    Mode: schemaOf('Mode', [{
      kind: 'choice',
      id: 'mode',
      required: true,
      shared: [],
      options: [
        { key: 'image', rows: [input('pixels', { optional: true }), input('strength', { type: FLOAT, ...floatWidget(0.3) })] },
        { key: 'text', rows: [input('words', { type: STRING, widget: { widgetType: 'STRING', options: {}, default: '' } })] },
      ],
    }, output('out')]),
    // A type choice: what is plugged in picks the variant, each with its own field.
    Feather: schemaOf('Feather', [{
      kind: 'typeChoice', id: 'src', required: false, rows: [],
      variants: [
        { key: 'image', type: IMAGE, rows: [input('sharpen', { type: FLOAT, optional: true, ...floatWidget(1) })] },
        { key: 'mask', type: { kind: 'concrete', name: 'MASK' }, rows: [input('feather', { type: FLOAT, optional: true, ...floatWidget(2) })] },
      ],
    }, output('out')]),
    MaskSrc: schemaOf('MaskSrc', [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'MASK' } }]),
    // A described row: its stored description lists the fields it has.
    Mixer: schemaOf('Mixer', [{
      kind: 'described', id: 'layers', minEntries: 0, maxEntries: 8, fixedIds: false,
      kinds: [input('amount', { type: FLOAT, optional: true, ...floatWidget(0.5) })],
    }, output('out')]),
    CountSplit: schemaOf('CountSplit', [
      input('n', { type: INT, socketless: true, widget: { widgetType: 'INT', options: {}, default: 1 } }),
      { kind: 'group', id: 'outs', value: output('o'), keys: { kind: 'numbered', prefix: 'o', start: 0, pad: 0 }, grows: { count: 'n' }, minMembers: 0, maxMembers: 8 },
      output('spare'),
    ]),
  }
  const okConstructPrompt = (doc: WorkflowDocument) => {
    const result = compile({ ...inputOf(doc), resolve: (type: string) => constructSchemas[type] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    return result.artifact.prompt
  }

  // Detail pass shows Weigh's whole group; Portrait fix shows Detail pass's.
  // Each level holds members of its own, and each outer node adds its own after them.
  const twoLevels = (roots: Record<string, NodeSpec>, links: GraphSpec['links'] = []): WorkflowDocument => docOf({
    g0: { nodes: { ...roots, a: { type: 'Src' } }, links },
    portrait: {
      nodes: { d: { type: '#detail', dynamic: { weights: { members: ['w0'] } }, values: { 'weights.w0': 0.6 } } },
      boundary: {
        inputs: [{ id: 'mix', binds: { kind: 'construct', node: 'd', port: 'weights' } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'd', port: 'out' } }],
      },
    },
    detail: {
      nodes: { n: { type: 'Weigh', dynamic: { weights: { members: ['w0', 'w1'] } }, values: { 'weights.w0': 0.1, 'weights.w1': 0.15 } } },
      boundary: {
        inputs: [{ id: 'weights', binds: { kind: 'construct', node: 'n', port: 'weights' } }],
        outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
      },
    },
  })

  it('whole input and output groups keep independent members through two boundaries', () => {
    const prompt = okConstructPrompt(twoLevels({
      first: { type: '#portrait', dynamic: { mix: { members: ['w0', 'w1'] } }, values: { 'mix.w0': 0.2, 'mix.w1': 0.8 } },
      second: { type: '#portrait', dynamic: { mix: { members: ['w0'] } }, values: { 'mix.w0': 0.9 } },
    }))
    // The definitions' members come first, then each outer node's own, in order.
    expect(prompt['first.d.n']!.inputs).toEqual({ 'weights.w0': 0.1, 'weights.w1': 0.15, 'weights.w2': 0.6, 'weights.w3': 0.2, 'weights.w4': 0.8 })
    expect(prompt['second.d.n']!.inputs).toEqual({ 'weights.w0': 0.1, 'weights.w1': 0.15, 'weights.w2': 0.6, 'weights.w3': 0.9 })
  })

  it('a wire into an outer member reaches the same member inside, and reordering follows the key', () => {
    const doc = docOf({
      g0: {
        nodes: { a: { type: 'Src' }, s: { type: '#sub', dynamic: { imgs: { members: ['image1', 'image0'] } } }, k: { type: 'Sink' } },
        links: [[['a', 'out'], ['s', 'imgs.image0']], [['s', 'out'], ['k', 'in']]],
      },
      sub: {
        nodes: { n: { type: 'Batch', dynamic: { images: { members: ['image0'] } } } },
        boundary: {
          inputs: [{ id: 'imgs', binds: { kind: 'construct', node: 'n', port: 'images' } }],
          outputs: [{ id: 'out', binds: { kind: 'port', node: 'n', port: 'out' } }],
        },
      },
    })
    const prompt = okConstructPrompt(doc)
    // The outer member image0 is the inner member past the definition's one.
    expect(prompt['s.n']!.inputs).toEqual({ 'images.image1': ['a', 0] })
    expect(prompt['s.n']!.outputMembers?.['images']).toEqual(['image0', 'image2', 'image1'])
  })

  it('a whole choice keeps per-instance picks and dormant option values through two boundaries', () => {
    const doc = (outer: Record<string, NodeSpec>) => docOf({
      g0: { nodes: outer },
      fix: {
        nodes: { d: { type: '#detail', dynamic: { mode: { selected: 'image' } }, values: { 'mode.strength': 0.6 } } },
        boundary: { inputs: [{ id: 'look', binds: { kind: 'construct', node: 'd', port: 'mode' } }] },
      },
      detail: {
        nodes: { n: { type: 'Mode', dynamic: { mode: { selected: 'image' } }, values: { 'mode.strength': 0.4, 'mode.words': 'kept' } } },
        boundary: { inputs: [{ id: 'mode', binds: { kind: 'construct', node: 'n', port: 'mode' } }] },
      },
    })
    const prompt = okConstructPrompt(doc({
      first: { type: '#fix', dynamic: { look: { selected: 'text' } }, values: { 'look.words': 'portrait', 'look.strength': 0.2 } },
      second: { type: '#fix', dynamic: { look: { selected: 'image' } }, values: { 'look.strength': 0.8 } },
      third: { type: '#fix', dynamic: { look: { selected: 'image' } } },
    }))
    expect(prompt['first.d.n']!.inputs).toEqual({ 'mode.words': 'portrait' })
    expect(prompt['first.d.n']!.slotVariants).toEqual({ mode: 'text' })
    expect(prompt['second.d.n']!.inputs).toEqual({ 'mode.strength': 0.8 })
    // Nothing stored outside: the middle definition's value wins over the inner one.
    expect(prompt['third.d.n']!.inputs).toEqual({ 'mode.strength': 0.6 })
  })

  it('matching input group fanout preserves one member order and one owner per target', () => {
    const doc = docOf({
      g0: {
        nodes: { a: { type: 'Src' }, b: { type: 'Src' }, s: { type: '#sub', dynamic: { imgs: { members: ['image1', 'image0'] } } } },
        links: [[['a', 'out'], ['s', 'imgs.image0']], [['b', 'out'], ['s', 'imgs.image1']]],
      },
      sub: {
        nodes: {
          first: { type: 'Batch', dynamic: { images: { members: ['image0'] } } },
          second: { type: 'Batch' },
        },
        boundary: {
          inputs: [{ id: 'imgs', binds: { kind: 'construct', node: 'first', port: 'images' }, alsoBinds: [{ kind: 'construct', node: 'second', port: 'images' }] }],
        },
      },
    })
    const prompt = okConstructPrompt(doc)
    // Each target keeps its own definition members first; the outer stream follows in one order.
    expect(prompt['s.first']!.inputs).toEqual({ 'images.image1': ['a', 0], 'images.image2': ['b', 0] })
    expect(prompt['s.first']!.outputMembers?.['images']).toEqual(['image0', 'image2', 'image1'])
    expect(prompt['s.second']!.inputs).toEqual({ 'images.image0': ['a', 0], 'images.image1': ['b', 0] })
    expect(prompt['s.second']!.outputMembers?.['images']).toEqual(['image1', 'image0'])
  })

  it('a counted output group follows the outer count, and its third output reaches the sink', () => {
    const doc = docOf({
      g0: {
        nodes: { s: { type: '#split', values: { count: 3 } }, k: { type: 'Sink' } },
        links: [[['s', 'outs.o2'], ['k', 'in']]],
      },
      split: {
        nodes: { n: { type: 'CountSplit', values: { n: 1 } } },
        boundary: {
          inputs: [{ id: 'count', promoted: true, binds: { kind: 'port', node: 'n', port: 'n' } }],
          outputs: [{ id: 'outs', binds: { kind: 'construct', node: 'n', port: 'outs' } }, { id: 'spare', binds: { kind: 'port', node: 'n', port: 'spare' } }],
        },
      },
    })
    const prompt = okConstructPrompt(doc)
    expect(prompt['s.n']!.inputs).toEqual({ n: 3 })
    expect(prompt['k']!.inputs).toEqual({ in: ['s.n', 2] })
  })

  it('a whole type choice keeps each instance\'s variant and field through two boundaries', () => {
    const doc = docOf({
      g0: {
        nodes: {
          a: { type: 'MaskSrc' },
          b: { type: 'Src' },
          first: { type: '#outer', dynamic: { pick: { selected: 'mask' } }, values: { 'pick.feather': 4 } },
          second: { type: '#outer', dynamic: { pick: { selected: 'image' } } },
        },
        links: [[['a', 'out'], ['first', 'pick']], [['b', 'out'], ['second', 'pick']]],
      },
      outer: {
        nodes: { d: { type: '#inner', dynamic: { src: { selected: 'image' } }, values: { 'src.sharpen': 3 } } },
        boundary: { inputs: [{ id: 'pick', binds: { kind: 'construct', node: 'd', port: 'src' } }] },
      },
      inner: {
        nodes: { n: { type: 'Feather', dynamic: { src: { selected: 'image' } }, values: { 'src.feather': 9 } } },
        boundary: { inputs: [{ id: 'src', binds: { kind: 'construct', node: 'n', port: 'src' } }] },
      },
    })
    const prompt = okConstructPrompt(doc)
    expect(prompt['first.d.n']!.inputs).toEqual({ src: ['a', 0], 'src.feather': 4 })
    expect(prompt['first.d.n']!.slotVariants).toEqual({ src: 'mask' })
    // Nothing stored outside: the middle definition's value is used.
    expect(prompt['second.d.n']!.inputs).toEqual({ src: ['b', 0], 'src.sharpen': 3 })
    expect(prompt['second.d.n']!.slotVariants).toEqual({ src: 'image' })    // A subgraph node that stores no variant shows, and runs, the one its definition picks.
    const third = { ...doc, graphs: { ...doc.graphs, g0: { ...doc.graphs.g0!, links: {}, nodes: { third: { id: asNodeId('third'), type: '#outer', values: {} } } } } }
    const shown = documentResolver(third, (type) => constructSchemas[type])('#outer')!
    expect(elaborateInterface(shown, { values: {} }).choices).toEqual({ pick: 'image' })
    expect(okConstructPrompt(third)['third.d.n']!.slotVariants).toEqual({ src: 'image' })
  })

  it('a whole described row keeps each instance\'s description and values through two boundaries', () => {
    const description = (...ids: string[]) => JSON.stringify({ entries: ids.map((id) => ({ id, label: id.toUpperCase(), kind: 'amount' })) })
    const doc = docOf({
      g0: {
        nodes: {
          first: { type: '#outer', values: { mix: description('base', 'glow'), 'mix.glow': 0.7 } },
          second: { type: '#outer' },
        },
      },
      outer: {
        nodes: { d: { type: '#inner', values: { layers: description('base'), 'layers.base': 0.25 } } },
        boundary: { inputs: [{ id: 'mix', binds: { kind: 'construct', node: 'd', port: 'layers' } }] },
      },
      inner: {
        nodes: { n: { type: 'Mixer', values: { layers: description('rim'), 'layers.rim': 0.9 } } },
        boundary: { inputs: [{ id: 'layers', binds: { kind: 'construct', node: 'n', port: 'layers' } }] },
      },
    })
    const prompt = okConstructPrompt(doc)
    // The description travels with the run, as on a plain node; base has no
    // outer value, so the middle definition's is used.
    expect(prompt['first.d.n']!.inputs).toEqual({ layers: description('base', 'glow'), 'layers.base': 0.25, 'layers.glow': 0.7 })
    // Nothing stored outside: the middle definition's description and value.
    expect(prompt['second.d.n']!.inputs).toEqual({ layers: description('base'), 'layers.base': 0.25 })
  })

  it('a wire to a counted output past the outer count fails as it does on the plain node', () => {
    const codes = (doc: WorkflowDocument): readonly string[] => {
      const result = compile({ ...inputOf(doc), resolve: (type: string) => constructSchemas[type] })
      return result.ok ? [] : result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code)
    }
    const plain = codes(docOf({
      g0: { nodes: { n: { type: 'CountSplit', values: { n: 1 } }, k: { type: 'Sink' } }, links: [[['n', 'outs.o2'], ['k', 'in']]] },
    }))
    const shown = codes(docOf({
      g0: {
        nodes: { s: { type: '#split', values: { count: 1 } }, k: { type: 'Sink' } },
        links: [[['s', 'outs.o2'], ['k', 'in']]],
      },
      split: {
        nodes: { n: { type: 'CountSplit', values: { n: 3 } } },
        boundary: {
          inputs: [{ id: 'count', promoted: true, binds: { kind: 'port', node: 'n', port: 'n' } }],
          outputs: [{ id: 'outs', binds: { kind: 'construct', node: 'n', port: 'outs' } }],
        },
      },
    }))
    expect(plain).toEqual(['compile.port.unknownOutput'])
    expect(shown).toEqual(plain)
  })

  it('a subgraph node that stores no pick for an optional choice runs the definition\'s pick, through two levels', () => {
    const optional = { ...(constructSchemas.Mode!.body[0] as ChoiceSpec), required: false }
    const resolveOptional = (type: string) => type === 'OptMode' ? schemaOf('OptMode', [optional, output('out')]) : constructSchemas[type]
    const sub = (selected?: string) => ({
      nodes: { n: { type: 'OptMode', ...(selected !== undefined ? { dynamic: { mode: { selected } } } : {}), values: { 'mode.strength': 0.4 } } },
      boundary: { inputs: [{ id: 'look', binds: { kind: 'construct', node: 'n', port: 'mode' } }] },
    })
    const doc = docOf({
      g0: { nodes: {
        fresh: { type: '#sub' },
        text: { type: '#sub', dynamic: { look: { selected: 'text' } } },
        nested: { type: '#fix' },
        unpicked: { type: '#bare' },
      } },
      fix: {
        nodes: { d: { type: '#sub' } },
        boundary: { inputs: [{ id: 'outer', binds: { kind: 'construct', node: 'd', port: 'look' } }] },
      },
      sub: sub('image'),
      bare: sub(),
    })
    const result = compile({ ...inputOf(doc), resolve: resolveOptional })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.artifact.prompt['fresh.n']!.slotVariants).toEqual({ mode: 'image' })
    expect(result.artifact.prompt['text.n']!.slotVariants).toEqual({ mode: 'text' })
    expect(result.artifact.prompt['nested.d.n']!.slotVariants).toEqual({ mode: 'image' })
    // Where the definition picked nothing, the subgraph node runs none.
    expect(result.artifact.prompt['unpicked.n']!.slotVariants?.['mode']).toBeUndefined()
    // What the editor asks before it offers a "none" it could not keep.
    expect(definitionPick(doc, 'sub', 'look', resolveOptional)).toBe('image')
    expect(definitionPick(doc, 'fix', 'outer', resolveOptional)).toBe('image')
    expect(definitionPick(doc, 'bare', 'look', resolveOptional)).toBeUndefined()
  })

  it('a bypassed inner node passes on a wire that reaches it through a whole group', () => {
    const doc = docOf({
      g0: {
        nodes: { a: { type: 'Src' }, s: { type: '#sub', dynamic: { imgs: { members: ['image0'] } } } },
        links: [[['a', 'out'], ['s', 'imgs.image0']]],
      },
      sub: {
        nodes: { n: { type: 'Batch', mode: 'bypassed', dynamic: { images: { members: ['image0'] } } }, k: { type: 'Sink' } },
        links: [[['n', 'out'], ['k', 'in']]],
        boundary: { inputs: [{ id: 'imgs', binds: { kind: 'construct', node: 'n', port: 'images' } }] },
      },
    })
    expect(okConstructPrompt(doc)['s.k']!.inputs).toEqual({ in: ['a', 0] })
  })

  // Weigh shows its group, Seeded its choice and a field beside it. The
  // definition keeps a stale value past its one member.
  const entered = (): WorkflowDocument => docOf({
    g0: { nodes: {
      s: { type: '#sub', dynamic: { mix: { members: ['w0'] }, look: { selected: 'image' } }, values: { seed: 7, 'look.strength': 0.9 } },
    } },
    sub: {
      nodes: {
        n: { type: 'Weigh', dynamic: { weights: { members: ['w0'] } }, values: { 'weights.w0': 0.1, 'weights.w1': 0.77 } },
        m: { type: 'Seeded', dynamic: { mode: { selected: 'image' } }, values: { seed: 1, 'mode.strength': 0.4 } },
      },
      boundary: { inputs: [
        { id: 'mix', binds: { kind: 'construct', node: 'n', port: 'weights' } },
        { id: 'seed', promoted: true, binds: { kind: 'port', node: 'm', port: 'seed' } },
        { id: 'look', binds: { kind: 'construct', node: 'm', port: 'mode' } },
      ] },
    },
  })
  const seededSchemas: Record<string, NodeSchema> = {
    ...constructSchemas,
    Seeded: schemaOf('Seeded', [input('seed', { type: INT, widget: { widgetType: 'INT', options: {}, default: 0 } }), constructSchemas.Mode!.body[0]!]),
  }

  it('inside the subgraph, every row of a shown construct is the subgraph node\'s, stored there or not', () => {
    const doc = entered()
    const view = occurrenceDynamicView(doc, documentResolver(doc, (type) => seededSchemas[type]), ['s'])
    const owner = (node: string, key: string) => view.valueOwners.get(node)?.get(key)
    // The subgraph node's own member, stored nowhere yet, and its stored choice field.
    expect(owner('n', 'weights.w1')).toEqual({ graphId: 'g0', nodeId: 's', valueKey: 'mix.w0' })
    expect(owner('m', 'mode.strength')).toEqual({ graphId: 'g0', nodeId: 's', valueKey: 'look.strength' })
    // The definition's member stays the definition's.
    expect(owner('n', 'weights.w0')).toBeUndefined()
    // The node's value beside its field wins over the definition's, and the
    // stale value inside is not the subgraph node's member.
    expect(view.values.get('m')).toMatchObject({ seed: 7, 'mode.strength': 0.9 })
    expect(view.values.get('n')).toEqual({ 'weights.w0': 0.1 })

    const result = compile({ ...inputOf(doc), resolve: (type: string) => seededSchemas[type] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.artifact.prompt['s.m']!.inputs).toEqual({ seed: 7, 'mode.strength': 0.9 })
    expect(result.artifact.prompt['s.n']!.inputs['weights.w1']).not.toBe(0.77)
  })
})
