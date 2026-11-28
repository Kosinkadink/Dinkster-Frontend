/**
 * Recursive list types (Dinkster schema wire v2, DESIGN 3.13). The contract:
 * - `list<T>` is ONE value on ONE edge; the canonical runtime identity of a
 *   closed list is the parametric string 'list<...>' (nesting composes)
 * - one schema representation: `{ kind: 'list' }`, never concrete('list<...>')
 * - cardinality is STRUCTURAL: definite list-vs-scalar edges are errors
 *   (solve.listIntoScalar / solve.scalarIntoList), unlike advisory atom
 *   mismatches which stay warnings
 * - closed lists behave as ordinary atoms in solver domains; open lists
 *   (variable below the constructor) peel the constructor and unify elements
 * - deliberate under-constraint: open list vs bare variable records nothing
 */
import { describe, expect, it } from 'vitest'
import { typesCompatible } from '../src/schema/type-relations.js'
import { asGraphDefId, asLineageId, asLinkId, asNodeId, asPortId, asRerouteId } from '../src/ids.js'
import type { GraphDef, WorkflowDocument } from '../src/format/document.js'
import { solveOccurrenceTypes } from '../src/compile/occurrence-solve.js'
import type { SchemaResolver } from '../src/schema/derive-boundary.js'
import { type GroupSpec, type InputSpec, type NodeSchema, type OutputSpec, type TypeExpr } from '../src/schema/model.js'
import { solveGraphTypes } from '../src/schema/solve.js'
import { parseDinksterSchema } from '../src/schema/dinkster-wire.js'

// ---------------------------------------------------------------------------
// Builders (house style of solve.test.ts)
// ---------------------------------------------------------------------------

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })
const list = (element: TypeExpr): TypeExpr => ({ kind: 'list', element })
const T = (templateId: string, allowed?: string[]): TypeExpr => ({
  kind: 'variable',
  templateId,
  ...(allowed ? { allowedTypes: allowed.map(concrete) } : {}),
})

const input = (id: string, type: TypeExpr): InputSpec => ({ kind: 'input', id, type, optional: false })
const output = (id: string, type: TypeExpr): OutputSpec => ({ kind: 'output', id, type })

const schemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: false,
  body: items,
})

const schemas: Record<string, NodeSchema> = {
  ImageSrc: schemaOf('ImageSrc', [output('out', concrete('IMAGE'))]),
  LatentSrc: schemaOf('LatentSrc', [output('out', concrete('LATENT'))]),
  ImageSink: schemaOf('ImageSink', [input('in', concrete('IMAGE'))]),
  ListImageSrc: schemaOf('ListImageSrc', [output('out', list(concrete('IMAGE')))]),
  ListLatentSrc: schemaOf('ListLatentSrc', [output('out', list(concrete('LATENT')))]),
  ListImageSink: schemaOf('ListImageSink', [input('in', list(concrete('IMAGE')))]),
  ListLatentSink: schemaOf('ListLatentSink', [input('in', list(concrete('LATENT')))]),
  NestedListSrc: schemaOf('NestedListSrc', [output('out', list(list(concrete('IMAGE'))))]),
  NestedListSink: schemaOf('NestedListSink', [input('in', list(list(concrete('IMAGE'))))]),
  // Open list: a Map-style node relating element types across the constructor
  ListMap: schemaOf('ListMap', [input('in', list(T('T'))), output('out', list(T('T')))]),
  // Element extractor: list<T> in, T out
  ListGet: schemaOf('ListGet', [input('in', list(T('T'))), output('out', T('T'))]),
  // Bare variable passthrough
  Switch: schemaOf('Switch', [input('in', T('T')), output('out', T('T'))]),
  // Append to List's list<T> plus one representative member from its T family.
  Append: schemaOf('Append', [input('list', list(T('T'))), input('item', T('T')), output('out', list(T('T')))]),
  AnySrc: schemaOf('AnySrc', [output('out', { kind: 'wildcard' })]),
  AnySink: schemaOf('AnySink', [input('in', { kind: 'wildcard' })]),
}
const resolve: SchemaResolver = (type) => schemas[type]

const defOf = (parts: {
  nodes: Record<string, { type: string }>
  links?: Record<string, { from: [string, string]; to: [string, string] }>
}): GraphDef =>
  ({
    id: 'g0',
    name: 'test',
    nodes: Object.fromEntries(
      Object.entries(parts.nodes).map(([id, node]) => [id, { id, type: node.type, values: {} }]),
    ),
    links: Object.fromEntries(
      Object.entries(parts.links ?? {}).map(([id, l]) => [
        id,
        { id, from: { node: l.from[0], port: l.from[1] }, to: { node: l.to[0], port: l.to[1] } },
      ]),
    ),
    nets: {},
    reroutes: {},
    nextOrdinal: 99,
  }) as unknown as GraphDef

const n = asNodeId

describe('declared list counts', () => {
  const strings = list(concrete('STRING'))
  const localSchemas: Record<string, NodeSchema> = {
    Four: schemaOf('Four', [{ ...output('out', strings), listCount: 4 }]),
    Unknown: schemaOf('Unknown', [output('out', strings)]),
    Empty: schemaOf('Empty', [{ ...output('out', strings), listCount: 0 }]),
    Scalar: schemaOf('Scalar', [output('out', concrete('STRING'))]),
    Preserve: schemaOf('Preserve', [input('in', strings), { ...output('out', strings), listCount: { input: 'in' } }]),
    Local: schemaOf('Local', [{
      ...input('in', strings),
      widget: { widgetType: 'LIST', options: {}, element: { widgetType: 'STRING', options: {} }, default: [] },
    }]),
    Join: {
      ...schemaOf('Join', []),
      body: [{
        kind: 'group', id: 'parts', value: { ...input('value', T('T')), acceptsList: true as const },
        keys: { kind: 'numbered', prefix: 'part', start: 0, pad: 0 },
        grows: 'link', minMembers: 0, maxMembers: 8,
      } satisfies GroupSpec, { ...output('out', strings), listCount: { input: 'value', group: 'parts' } }],
    },
  }
  const resolveCounts: SchemaResolver = (type) => localSchemas[type]

  it('admits an output count formula without inventing a known file count', () => {
    const concrete = (name: string) => ({ kind: 'concrete', types: [name] })
    const wire = { body: [
      { kind: 'input', id: 'video', type: { kind: 'asset', element: concrete('IMAGE') } },
      { kind: 'output', id: 'out', type: { kind: 'list', element: concrete('STRING') }, listCount: { formula: 'frames(video)' } },
    ] }
    const { schema, diagnostics } = parseDinksterSchema('Frames', wire as never)
    expect(diagnostics).toEqual([])
    expect(schema).toBeDefined()
    const graph = defOf({ nodes: { frames: { type: 'Frames' }, copy: { type: 'Preserve' } },
      links: { list: { from: ['frames', 'out'], to: ['copy', 'in'] } } })
    const resolve: SchemaResolver = (type) => type === 'Frames' ? schema : resolveCounts(type)
    const unknown = solveGraphTypes(graph, resolve)
    expect(unknown.listCountFactOf(n('copy'), 'output', 'out')).toBeUndefined()
    expect(unknown.portTypeOf(n('copy'), 'output', 'out')).toEqual(strings)
    const estimated = solveGraphTypes(graph, resolve, {
      outputListCountEstimateOf: (node) => node === n('frames') ? { kind: 'estimate', count: 17, sources: ['last-run'] } : undefined,
    })
    expect(estimated.listCountFactOf(n('copy'), 'output', 'out')).toEqual({ kind: 'estimate', count: 17, sources: ['last-run'] })
    expect(estimated.listCountOf(n('copy'), 'output', 'out')).toBeUndefined()
    for (const listCount of [{ formula: 'frames(missing)' }, { formula: 'frames(video)', input: 'video' }]) {
      expect(parseDinksterSchema('Bad', { body: [wire.body[0], { ...wire.body[1], listCount }] } as never).schema).toBeUndefined()
    }
  })

  it('adds joined item counts, traces nets and widget taps, and leaves type checking unchanged', () => {
    const base = defOf({
      nodes: { four: { type: 'Four' }, scalar: { type: 'Scalar' }, local: { type: 'Local' }, join: { type: 'Join' }, copy: { type: 'Preserve' } },
      links: {
        a: { from: ['four', 'out'], to: ['join', 'parts.part0'] },
        b: { from: ['scalar', 'out'], to: ['join', 'parts.part1'] },
      },
    })
    const graph: GraphDef = {
      ...base,
      nodes: {
        ...base.nodes,
        local: { ...base.nodes['local']!, values: { in: ['a', 'b', 'c'] } },
        join: { ...base.nodes['join']!, dynamic: { parts: { members: ['part0', 'part1', 'part2'] } } },
      },
      links: {
        ...base.links,
        tap: { id: asLinkId('tap'), from: { node: n('local'), tap: asPortId('in') }, to: { node: n('join'), port: asPortId('parts.part2') } },
      },
      nets: { net: { id: 'net' as never, name: 'joined', source: { node: n('join'), port: asPortId('out') }, sinks: [{ node: n('copy'), port: asPortId('in') }] } },
    }
    const solved = solveGraphTypes(graph, resolveCounts)
    expect(solved.listCountOf(n('join'), 'output', 'out')).toBe(8)
    expect(solved.listCountOf(n('copy'), 'output', 'out')).toBe(8)
    expect(solved.portTypeOf(n('copy'), 'output', 'out')).toEqual(strings)
    expect(solved.listCountOf(n('scalar'), 'output', 'out')).toBeUndefined()
    const unknown = solveGraphTypes({ ...graph, nodes: { ...graph.nodes, four: { ...graph.nodes['four']!, type: 'Unknown' } } }, resolveCounts)
    expect(unknown.listCountOf(n('join'), 'output', 'out')).toBeUndefined()
    expect(unknown.portTypeOf(n('copy'), 'output', 'out')).toEqual(strings)
  })

  it('keeps empty distinct from unknown and does not derive counts through cycles or muted nodes', () => {
    const graph = defOf({
      nodes: { empty: { type: 'Empty' }, copy: { type: 'Preserve' }, cycle: { type: 'Preserve' }, loose: { type: 'Preserve' } },
      links: {
        empty: { from: ['empty', 'out'], to: ['copy', 'in'] },
        cycle: { from: ['cycle', 'out'], to: ['cycle', 'in'] },
      },
    })
    const solved = solveGraphTypes(graph, resolveCounts)
    expect(solved.listCountOf(n('copy'), 'output', 'out')).toBe(0)
    expect(solved.listCountOf(n('cycle'), 'output', 'out')).toBeUndefined()
    expect(solved.listCountOf(n('loose'), 'output', 'out')).toBeUndefined()
    const muted = solveGraphTypes({ ...graph, nodes: { ...graph.nodes, empty: { ...graph.nodes['empty']!, mode: 'muted' } } }, resolveCounts)
    expect(muted.listCountOf(n('copy'), 'output', 'out')).toBeUndefined()
    const rerouted: GraphDef = {
      ...graph,
      reroutes: { r: { id: asRerouteId('r') } },
      links: {
        feed: { id: asLinkId('feed'), from: { node: n('empty'), port: asPortId('out') }, to: { reroute: asRerouteId('r') } },
        end: { id: asLinkId('end'), from: { reroute: asRerouteId('r') }, to: { node: n('copy'), port: asPortId('in') } },
      },
    }
    expect(solveGraphTypes(rerouted, resolveCounts).listCountOf(n('copy'), 'output', 'out')).toBe(0)
  })

  it('uses each occurrence producer count instead of an inner default, preserving unknown and conflicting arrivals', () => {
    const body = defOf({ nodes: { local: { type: 'Local' }, copy: { type: 'Preserve' } } })
    const graph: GraphDef = {
      ...body,
      nodes: { ...body.nodes, local: { ...body.nodes['local']!, values: { in: ['default'] } } },
      links: { tap: { id: asLinkId('tap'), from: { node: n('local'), tap: asPortId('in') }, to: { node: n('copy'), port: asPortId('in') } } },
    }
    const to = { node: n('local'), port: asPortId('in') }
    const project = (itemCount?: number) => ({ to, type: strings, ...(itemCount === undefined ? {} : { itemCount }) })
    const seven = solveGraphTypes(graph, resolveCounts, { projectedInputs: [project(7)] })
    const two = solveGraphTypes(graph, resolveCounts, { projectedInputs: [project(2)] })
    expect(seven.listCountOf(n('copy'), 'output', 'out')).toBe(7)
    expect(two.listCountOf(n('copy'), 'output', 'out')).toBe(2)
    expect(seven.listCountOf(n('copy'), 'output', 'out')).toBe(7)
    expect(seven.portTypeOf(n('copy'), 'output', 'out')).toEqual(strings)
    expect(solveGraphTypes(graph, resolveCounts).listCountOf(n('copy'), 'output', 'out')).toBe(1)
    expect(solveGraphTypes(graph, resolveCounts, { projectedInputs: [project(0)] }).listCountOf(n('copy'), 'output', 'out')).toBe(0)
    for (const projectedInputs of [[project()], [project(2), project(7)], [project(2), project()]]) {
      expect(solveGraphTypes(graph, resolveCounts, { projectedInputs }).listCountOf(n('copy'), 'output', 'out')).toBeUndefined()
    }
    expect(solveGraphTypes(graph, resolveCounts, {
      connectivityOf: (node) => ({ isInputConnected: (port) => node === to.node && port === to.port, isOutputConnected: () => false }),
    }).listCountOf(n('copy'), 'output', 'out')).toBeUndefined()
    expect(graph.nodes['local']!.values).toEqual({ in: ['default'] })
  })

  it('keeps metadata counts estimated through joins and pass-throughs without making them exact', () => {
    const base = defOf({
      nodes: { estimated: { type: 'Unknown' }, four: { type: 'Four' }, join: { type: 'Join' }, copy: { type: 'Preserve' }, cycle: { type: 'Preserve' } },
      links: {
        a: { from: ['estimated', 'out'], to: ['join', 'parts.part0'] },
        b: { from: ['four', 'out'], to: ['join', 'parts.part1'] },
        c: { from: ['join', 'out'], to: ['copy', 'in'] },
        loop: { from: ['cycle', 'out'], to: ['cycle', 'in'] },
      },
    })
    const graph = { ...base, nodes: { ...base.nodes, join: { ...base.nodes['join']!, dynamic: { parts: { members: ['part0', 'part1'] } } } } }
    for (const count of [0, 7]) {
      const solved = solveGraphTypes(graph, resolveCounts, {
        outputListCountEstimateOf: () => ({ kind: 'estimate', count, sources: ['last-run'] }),
      })
      expect(solved.listCountFactOf(n('copy'), 'output', 'out')).toEqual({ kind: 'estimate', count: count + 4, sources: ['last-run'] })
      expect(solved.listCountOf(n('copy'), 'output', 'out')).toBeUndefined()
      expect(solved.itemCountOf(n('copy'), 'output', 'out')).toBeUndefined()
      expect(solved.listCountFactOf(n('four'), 'output', 'out')).toEqual({ kind: 'known', count: 4 })
      expect(solved.listCountFactOf(n('cycle'), 'output', 'out')).toBeUndefined()
      expect(solved.portTypeOf(n('copy'), 'output', 'out')).toEqual(strings)
    }
    const unlinked = defOf({ nodes: { copy: { type: 'Preserve' } } })
    const projected = (count: number, source: 'asset' | 'last-run') => ({ type: strings,
      to: { node: n('copy'), port: asPortId('in') }, itemCountEstimate: { kind: 'estimate' as const, count, sources: [source] } })
    const same = solveGraphTypes(unlinked, resolveCounts, { projectedInputs: [projected(7, 'asset'), projected(7, 'last-run')] })
    expect(same.listCountFactOf(n('copy'), 'output', 'out')).toEqual({ kind: 'estimate', count: 7, sources: ['asset', 'last-run'] })
    expect(solveGraphTypes(unlinked, resolveCounts, { projectedInputs: [projected(7, 'asset'), projected(2, 'last-run')] }).listCountFactOf(n('copy'), 'output', 'out')).toBeUndefined()
    const known = solveGraphTypes(unlinked, resolveCounts, { projectedInputs: [projected(7, 'asset'), { type: strings, to: projected(7, 'asset').to, itemCount: 3 }] })
    expect(known.listCountFactOf(n('copy'), 'output', 'out')).toEqual({ kind: 'known', count: 3 })

    const root = defOf({ nodes: { aSource: { type: 'Unknown' }, bSource: { type: 'Unknown' }, a: { type: '#body' }, b: { type: '#body' } },
      links: { a: { from: ['aSource', 'out'], to: ['a', 'in'] }, b: { from: ['bSource', 'out'], to: ['b', 'in'] } } })
    const body: GraphDef = { ...unlinked, id: asGraphDefId('body'), boundary: { body: [
      { kind: 'input', id: 'in', binds: { kind: 'port', node: n('copy'), port: asPortId('in') } },
      { kind: 'output', id: 'out', binds: { kind: 'port', node: n('copy'), port: asPortId('out') } },
    ] } }
    const document: WorkflowDocument = { format: 'dinkster-workflow', formatVersion: 1, lineage: asLineageId('estimated-counts'), root: root.id,
      graphs: { g0: root, body }, view: { graphs: {} } }
    const estimateOf = (path: readonly string[], node: string) => path.length === 0 && node.endsWith('Source')
      ? { kind: 'estimate' as const, count: node === 'aSource' ? 7 : 2, sources: ['last-run' as const] } : undefined
    const outer = solveOccurrenceTypes(document, resolveCounts, 'g0', [], estimateOf)!
    for (const [node, count] of [['a', 7], ['b', 2]] as const) {
      expect(outer.listCountFactOf(n(node), 'output', 'out')).toEqual({ kind: 'estimate', count, sources: ['last-run'] })
      expect(outer.listCountOf(n(node), 'output', 'out')).toBeUndefined()
      const inner = solveOccurrenceTypes(document, resolveCounts, 'body', [n(node)], estimateOf)!
      expect(inner.listCountFactOf(n('copy'), 'output', 'out')).toEqual({ kind: 'estimate', count, sources: ['last-run'] })
    }
  })
})

// ---------------------------------------------------------------------------
// Advisory compatibility
// ---------------------------------------------------------------------------

describe('typesCompatible with lists', () => {
  it('same closed lists match; different elements do not; nesting is exact', () => {
    expect(typesCompatible(list(concrete('IMAGE')), list(concrete('IMAGE')))).toBe(true)
    expect(typesCompatible(list(concrete('IMAGE')), list(concrete('LATENT')))).toBe(false)
    expect(typesCompatible(list(list(concrete('IMAGE'))), list(concrete('IMAGE')))).toBe(false)
  })

  it('cardinality never coerces: list vs scalar is incompatible in both directions', () => {
    expect(typesCompatible(list(concrete('IMAGE')), concrete('IMAGE'))).toBe(false)
    expect(typesCompatible(concrete('IMAGE'), list(concrete('IMAGE')))).toBe(false)
  })

  it('open lists match structurally: wildcards/variables inside stay permissive', () => {
    expect(typesCompatible(list(T('T')), list(concrete('IMAGE')))).toBe(true)
    expect(typesCompatible(list({ kind: 'wildcard' }), list(concrete('IMAGE')))).toBe(true)
    expect(typesCompatible(list(T('T', ['IMAGE'])), list(concrete('LATENT')))).toBe(false)
    // Wildcard at the top matches anything, including lists.
    expect(typesCompatible({ kind: 'wildcard' }, list(concrete('IMAGE')))).toBe(true)
    // Unconstrained bare variable stays permissive against an open list.
    expect(typesCompatible(T('U'), list(T('T')))).toBe(true)
  })

  it('list<union> denotes one atom per member', () => {
    expect(typesCompatible(list({ kind: 'union', names: ['IMAGE', 'LATENT'] }), list(concrete('LATENT')))).toBe(true)
    expect(typesCompatible(list({ kind: 'union', names: ['IMAGE', 'LATENT'] }), list(concrete('MASK')))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

describe('solver: closed lists as atoms', () => {
  it('matching closed lists are ok; mismatched elements warn with type words', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, ok: { type: 'ListImageSink' }, bad: { type: 'ListLatentSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['ok', 'in'] },
        l1: { from: ['src', 'out'], to: ['bad', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
    const d = s.diagnostics.find((x) => x.code === 'solve.linkMismatch')
    expect(d?.severity).toBe('warning')
    expect(d?.message).toBe('ListLatentSink: In needs a list of latent values, but ListImageSrc sends a list of images.')
  })

  it('nested closed lists compare by exact canonical identity', () => {
    const def = defOf({
      nodes: { src: { type: 'NestedListSrc' }, ok: { type: 'NestedListSink' }, bad: { type: 'ListImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['ok', 'in'] },
        l1: { from: ['src', 'out'], to: ['bad', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('mismatch')
  })
})

describe('solver: structural cardinality errors', () => {
  it('list into scalar is an ERROR (not an advisory warning)', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, sink: { type: 'ImageSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    const d = s.diagnostics.find((x) => x.code === 'solve.listIntoScalar')
    expect(d?.severity).toBe('error')
    expect(d?.anchor?.link).toBe('l0')
  })

  it('scalar into list is an ERROR', () => {
    const def = defOf({
      nodes: { src: { type: 'ImageSrc' }, sink: { type: 'ListImageSink' } },
      links: { l0: { from: ['src', 'out'], to: ['sink', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(s.diagnostics.find((x) => x.code === 'solve.scalarIntoList')?.severity).toBe('error')
  })

  it('wildcards still impose nothing across cardinality', () => {
    const def = defOf({
      nodes: { any: { type: 'AnySrc' }, sink: { type: 'ListImageSink' }, src: { type: 'ListImageSrc' }, anySink: { type: 'AnySink' } },
      links: {
        l0: { from: ['any', 'out'], to: ['sink', 'in'] },
        l1: { from: ['src', 'out'], to: ['anySink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.diagnostics).toEqual([])
  })
})

describe('solver: open lists peel the constructor', () => {
  it.each(['ListMap', 'Switch'] as const)('preserves a heterogeneous runtime collection through %s', (type) => {
    const heterogeneous = list({ kind: 'wildcard' })
    const solved = solveGraphTypes(defOf({ nodes: { node: { type } } }), resolve, {
      projectedInputs: [{ type: heterogeneous, to: { node: n('node'), port: asPortId('in') } }],
    })
    expect(solved.portTypeOf(n('node'), 'output', 'out')).toEqual(heterogeneous)
    expect(solved.diagnostics).toEqual([])
  })

  it('projects nested list structure through a shared template without flattening it', () => {
    const def = defOf({ nodes: { map: { type: 'ListMap' } } })
    const solved = solveGraphTypes(def, resolve, {
      projectedInputs: [{
        type: list(concrete('IMAGE')),
        to: { node: n('map'), port: asPortId('in') },
      }],
    })
    expect(solved.resolutionOf(n('map'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.portTypeOf(n('map'), 'input', 'in')).toEqual(list(concrete('IMAGE')))
    expect(solved.portTypeOf(n('map'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
    expect(solved.diagnostics).toEqual([])
  })

  it('list<T> fed by a closed list resolves T to the element', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, map: { type: 'ListMap' } },
      links: { l0: { from: ['src', 'out'], to: ['map', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.resolutionOf(n('map'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    // Substitution rebuilds structure under the constructor.
    expect(s.portTypeOf(n('map'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
  })

  it('Append to List infers its items and output from the list input', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, append: { type: 'Append' } },
      links: { l0: { from: ['src', 'out'], to: ['append', 'list'] } },
    })
    const solved = solveGraphTypes(def, resolve)

    expect(solved.resolutionOf(n('append'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(solved.portTypeOf(n('append'), 'input', 'item')).toEqual(concrete('IMAGE'))
    expect(solved.portTypeOf(n('append'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
  })

  it('Append to List remains valid while its type is unconstrained', () => {
    const solved = solveGraphTypes(defOf({ nodes: { append: { type: 'Append' } } }), resolve)

    expect(solved.resolutionOf(n('append'), 'T')).toEqual({ kind: 'unconstrained' })
    expect(solved.portTypeOf(n('append'), 'input', 'list')).toEqual(list(T('T')))
    expect(solved.portTypeOf(n('append'), 'input', 'item')).toEqual(T('T'))
    expect(solved.portTypeOf(n('append'), 'output', 'out')).toEqual(list(T('T')))
    expect(solved.diagnostics).toEqual([])
  })

  it('Append to List infers its list and output from an item, including nested lists', () => {
    const scalar = solveGraphTypes(defOf({
      nodes: { src: { type: 'ImageSrc' }, append: { type: 'Append' } },
      links: { l0: { from: ['src', 'out'], to: ['append', 'item'] } },
    }), resolve)
    expect(scalar.portTypeOf(n('append'), 'input', 'list')).toEqual(list(concrete('IMAGE')))
    expect(scalar.portTypeOf(n('append'), 'output', 'out')).toEqual(list(concrete('IMAGE')))

    const nested = solveGraphTypes(defOf({
      nodes: { src: { type: 'ListImageSrc' }, append: { type: 'Append' } },
      links: { l0: { from: ['src', 'out'], to: ['append', 'item'] } },
    }), resolve)
    expect(nested.resolutionOf(n('append'), 'T')).toEqual({ kind: 'resolved', name: 'list<IMAGE>' })
    expect(nested.portTypeOf(n('append'), 'input', 'list')).toEqual(list(list(concrete('IMAGE'))))
    expect(nested.portTypeOf(n('append'), 'output', 'out')).toEqual(list(list(concrete('IMAGE'))))
  })

  it('Append to List reports conflicting list and item constraints', () => {
    const solved = solveGraphTypes(defOf({
      nodes: { images: { type: 'ListImageSrc' }, latent: { type: 'LatentSrc' }, append: { type: 'Append' } },
      links: {
        l0: { from: ['images', 'out'], to: ['append', 'list'] },
        l1: { from: ['latent', 'out'], to: ['append', 'item'] },
      },
    }), resolve)
    expect(solved.resolutionOf(n('append'), 'T')).toEqual({ kind: 'conflict' })
    expect(solved.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(solved.linkVerdicts.get('l1' as never)).toBe('mismatch')
    expect(solved.diagnostics.filter((diagnostic) => diagnostic.code === 'solve.varConflict')).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: 'Append: The inputs must be the same type, but the input list is an image and the input item is latent data.',
        anchor: { port: { node: 'append', port: 'item' }, link: 'l1' },
      }),
    ])
  })

  it('list<T> in, T out relates element to downstream scalar consumers', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, get: { type: 'ListGet' }, sink: { type: 'ImageSink' } },
      links: {
        l0: { from: ['src', 'out'], to: ['get', 'in'] },
        l1: { from: ['get', 'out'], to: ['sink', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.linkVerdicts.get('l0' as never)).toBe('ok')
    expect(s.linkVerdicts.get('l1' as never)).toBe('ok')
    expect(s.resolutionOf(n('get'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
  })

  it('conflicting element constraints mark every contributing edge', () => {
    const def = defOf({
      nodes: { a: { type: 'ListImageSrc' }, b: { type: 'ListLatentSrc' }, map: { type: 'ListMap' }, map2: { type: 'ListMap' } },
      links: {
        l0: { from: ['a', 'out'], to: ['map', 'in'] },
        // map -> map2 merges their element variables; b conflicts with a.
        l1: { from: ['map', 'out'], to: ['map2', 'in'] },
        l2: { from: ['b', 'out'], to: ['map2', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('map'), 'T')).toEqual({ kind: 'conflict' })
    expect(s.linkVerdicts.get('l0' as never)).toBe('mismatch')
    expect(s.linkVerdicts.get('l2' as never)).toBe('mismatch')
    expect(s.diagnostics.some((d) => d.code === 'solve.varConflict')).toBe(true)
  })

  it('a bare variable fed by a closed list resolves to the canonical id and renders structurally', () => {
    const def = defOf({
      nodes: { src: { type: 'ListImageSrc' }, sw: { type: 'Switch' } },
      links: { l0: { from: ['src', 'out'], to: ['sw', 'in'] } },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('sw'), 'T')).toEqual({ kind: 'resolved', name: 'list<IMAGE>' })
    // Never concrete('list<...>'): substitution rebuilds the structured form.
    expect(s.portTypeOf(n('sw'), 'output', 'out')).toEqual(list(concrete('IMAGE')))
  })

  it('two instances of one open-list schema resolve independently', () => {
    const def = defOf({
      nodes: { a: { type: 'ListImageSrc' }, b: { type: 'ListLatentSrc' }, m1: { type: 'ListMap' }, m2: { type: 'ListMap' } },
      links: {
        l0: { from: ['a', 'out'], to: ['m1', 'in'] },
        l1: { from: ['b', 'out'], to: ['m2', 'in'] },
      },
    })
    const s = solveGraphTypes(def, resolve)
    expect(s.resolutionOf(n('m1'), 'T')).toEqual({ kind: 'resolved', name: 'IMAGE' })
    expect(s.resolutionOf(n('m2'), 'T')).toEqual({ kind: 'resolved', name: 'LATENT' })
  })
})
