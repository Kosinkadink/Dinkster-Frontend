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
import { compile, type CompileInput } from '../src/compile/compile.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import type { BodyRow, GroupSpec, InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

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
  | [node: string, port: string, members?: string[]]
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
  Array.isArray(e) ? { node: e[0], port: e[1], ...(e[2] ? { members: e[2] } : {}) } : e

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
