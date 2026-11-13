/**
 * Compiler tests. The golden pairs are the primary oracle: both expected
 * prompts were executed successfully on a real ComfyUI server.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { compile, scopeClosure, type CompileInput } from '../src/compile/compile.js'
import { semanticHashOf, sha256Hex } from '../src/compile/hash.js'
import type { ExecutionScope } from '../src/compile/artifact.js'
import type { WorkflowDocument } from '../src/format/document.js'
import { loadDocument } from '../src/format/migrate.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import { historicalSchemas as schemas } from './fixtures/historical-schemas.js'
import { parseDinksterSchema, type DinksterWireSchema } from '../src/schema/dinkster-wire.js'
import { DINKSTER_GRAPH_FEATURE_DECIMAL_INT } from '../src/compile/dinkster-graph.js'
import { coreVirtualNodeKind } from '../src/virtual-node.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'))

const backendResolve = (type: string) => schemas.get(type)

const loadWorkflow = (name: string): WorkflowDocument =>
  loadDocument(readJson(`fixtures/workflows/${name}.json`)).document!

const compileInput = (
  doc: WorkflowDocument,
  scope: ExecutionScope = { kind: 'full' },
  resolve: CompileInput['resolve'] = backendResolve,
): CompileInput => ({
  document: doc,
  revision: 1,
  resolve,
  scope,
  connection: asConnectionId('c0'),
  schemaHash: 'test-schema-hash',
})

describe('golden pairs', () => {
  it.each([25, 29.97, undefined])('stamps numeric-union widget value %s without changing concrete numerics', (value) => {
    const schema = parseDinksterSchema('Numeric', {
      outputNode: true,
      interface: [
        { role: 'input', id: 'frame_rate', type: { kind: 'union', types: ['FLOAT', 'INT'] }, required: true, default: 23.976, widget: { type: 'NUMBER', step: 0.01 } },
        { role: 'input', id: 'count', type: { kind: 'concrete', types: ['INT'] }, required: true, widget: { type: 'NUMBER', min: 0 } },
      ],
    }).schema!
    expect(schema).toBeDefined()
    const base = loadWorkflow('minimal')
    const document: WorkflowDocument = { ...base, graphs: { [base.root]: {
      ...base.graphs[base.root]!, links: {}, nodes: {
        n0: { id: asNodeId('n0'), type: 'Numeric', values: { count: 7, ...(value === undefined ? {} : { frame_rate: value }) } },
      },
    } } }
    const before = structuredClone(document)
    const input = compileInput(document, { kind: 'full' }, () => schema)
    const supported = compile({ ...input, graphFeatures: ['regions', 'typedLiteral'] })
    expect(supported.ok, JSON.stringify(!supported.ok && supported.diagnostics)).toBe(true)
    if (supported.ok) expect(supported.artifact.dinksterGraph?.nodes.n0).toEqual({
      nodeType: 'Numeric', inputs: { frame_rate: { $typed: { type: 'FLOAT', value: value ?? 23.976 } }, count: 7 },
    })
    expect(compile({ ...input, graphFeatures: ['regions'] }).ok).toBe(false)
    const legacy = compile(input)
    expect(legacy.ok).toBe(true)
    if (legacy.ok) expect(legacy.artifact.prompt.n0!.inputs).toEqual({ frame_rate: value ?? 23.976, count: 7 })
    expect(document).toEqual(before)
  })

  it('requires explicit supported type stamps for nonconcrete additional literals', () => {
    const schema = parseDinksterSchema('Authored', {
      outputNode: true, additionalInputs: { kind: 'wildcard' }, interface: [],
    }).schema!
    const base = loadWorkflow('minimal')
    for (const [value, features, accepted] of [
      [7, ['typedLiteral'], false],
      [{ $typed: { type: 'INT', value: 7 } }, [], false],
      [{ $typed: { type: 'INT', value: 7 } }, ['typedLiteral'], true],
    ] as const) {
      const document: WorkflowDocument = { ...base, graphs: { [base.root]: {
        ...base.graphs[base.root]!, links: {}, nodes: {
          n0: { id: asNodeId('n0'), type: 'Authored', values: { index: value }, additionalInputs: ['index'] },
        },
      } } }
      const result = compile({ ...compileInput(document, { kind: 'full' }, () => schema), graphFeatures: features })
      expect(result.ok).toBe(accepted)
      if (!result.ok) expect(result.diagnostics.map((item) => item.code)).toContain('compile.value.additionalInputType')
      else expect(result.artifact.prompt.n0!.inputs.index).toEqual({ $typed: { type: 'INT', value: 7 } })
    }
  })

  it('compiles explicit extra membership without deriving ports from dormant values', () => {
    const schema = parseDinksterSchema('Authored', {
      outputNode: true,
      additionalInputs: { kind: 'concrete', types: ['INT'] },
      interface: [{ role: 'input', id: 'choice', type: { kind: 'concrete', types: ['COMBO'] }, widget: { type: 'COMBO', editableOptions: true, options: [] } }],
    }).schema!
    const base = loadWorkflow('minimal')
    const document = (additionalInputs: readonly string[]): WorkflowDocument => ({
      ...base,
      graphs: { [base.root]: {
        ...base.graphs[base.root]!, links: {},
        nodes: { n0: { id: asNodeId('n0'), type: 'Authored', values: { choice: 'outside', index: 7, unused: 42 }, additionalInputs,
          dynamic: { choice: { options: ['same', 'same'] } } } },
      } },
    })
    const withIndex = document(['index'])
    const withoutIndex = document([])
    const result = compile(compileInput(withIndex, { kind: 'full' }, () => schema))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.artifact.prompt['n0']!.inputs).toEqual({ choice: 'outside', index: 7 })
    const omitted = compile(compileInput(withoutIndex, { kind: 'full' }, () => schema))
    expect(omitted.ok).toBe(true)
    if (omitted.ok) expect(omitted.artifact.prompt['n0']!.inputs).toEqual({ choice: 'outside' })
    expect(semanticHashOf(withIndex)).not.toBe(semanticHashOf(withoutIndex))
  })

  it('strips virtual notes without changing the execution prompt or semantic hash', () => {
    const base = loadWorkflow('exec-basic')
    const graph = base.graphs[base.root]!
    const withNote: WorkflowDocument = {
      ...base,
      graphs: {
        ...base.graphs,
        [base.root]: {
          ...graph,
          nodes: {
            ...graph.nodes,
            note: {
              id: asNodeId('note'),
              type: 'dinkster.note',
              virtual: true,
              values: { text: 'not executable' },
            },
          },
        },
      },
    }
    const resolve = (type: string) => coreVirtualNodeKind(type)?.schema ?? backendResolve(type)
    const expected = compile(compileInput(base, { kind: 'full' }, resolve))
    const actual = compile(compileInput(withNote, { kind: 'full' }, resolve))
    expect(expected.ok).toBe(true)
    expect(actual.ok).toBe(true)
    if (!expected.ok || !actual.ok) return
    expect(actual.artifact.prompt).toEqual(expected.artifact.prompt)
    const isVirtualType = (type: string) => resolve(type)?.virtual === true
    expect(semanticHashOf(withNote, isVirtualType)).toBe(semanticHashOf(base, isVirtualType))
  })

  it.each(['exec-basic', 'exec-subgraph'] as const)('%s compiles to the expected prompt', (name) => {
    const doc = loadWorkflow(name)
    const expected = readJson(`fixtures/prompts/${name}.expected.json`)
    const result = compile(compileInput(doc))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.fromEntries(Object.entries(result.artifact.prompt)
      .map(([id, { outputIds, ...node }]) => {
        expect(outputIds).toEqual(['out0'])
        return [id, node]
      }))).toEqual(expected)
    expect(result.artifact.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
  })

  it('provenance maps runtime ids back to occurrences (subgraph)', () => {
    const result = compile(compileInput(loadWorkflow('exec-subgraph')))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.provenance.toSource['n0.n0']).toBe('n0.n0')
    expect(result.artifact.provenance.fromSource['n1']).toEqual(['n1'])
  })

})

// ---------------------------------------------------------------------------
// Document surgery helpers (fixtures are readonly; tests build variants)
// ---------------------------------------------------------------------------

type Mutable = Record<string, unknown>
const clone = <T>(v: T): T => structuredClone(v)
/** Deep-clone a fixture as an untyped JSON tree for surgical mutation. */
const mutableWorkflow = (name: string): Mutable =>
  clone(loadWorkflow(name)) as unknown as Mutable

describe('modes', () => {
  it('muted nodes and their links are omitted, with a warning', () => {
    const doc = mutableWorkflow('exec-basic')
    ;((doc['graphs'] as Mutable)['g0'] as Mutable)['nodes'] = {
      ...(((doc['graphs'] as Mutable)['g0'] as Mutable)['nodes'] as Mutable),
      n1: { id: 'n1', type: 'PreviewImage', values: {}, mode: 'muted' },
    }
    const result = compile(compileInput(doc as unknown as WorkflowDocument))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt)).toEqual(['n0'])
    expect(result.artifact.diagnostics.some((d) => d.code === 'compile.link.dropped')).toBe(true)
  })

})

describe('named nets', () => {
  it('nets expand to direct links', () => {
    const doc = mutableWorkflow('exec-basic')
    const g0 = (doc['graphs'] as Mutable)['g0'] as Mutable
    g0['links'] = {}
    g0['nets'] = {
      net0: {
        id: 'net0',
        name: 'img',
        source: { node: 'n0', port: 'out0' },
        sinks: [{ node: 'n1', port: 'images' }],
      },
    }
    const result = compile(compileInput(doc as unknown as WorkflowDocument))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['n1']!.inputs['images']).toEqual(['n0', 0])
  })
})

describe('partial execution scope', () => {
  const withDisconnectedInvalidNode = (): WorkflowDocument => {
    const doc = mutableWorkflow('exec-basic')
    const nodes = ((doc['graphs'] as Mutable)['g0'] as Mutable)['nodes'] as Mutable
    nodes['invalid'] = { id: 'invalid', type: 'PreviewImage', values: {} }
    return doc as unknown as WorkflowDocument
  }

  it('includes only the upstream closure and sets partialTargets', () => {
    // exec-basic + a second, disconnected branch that must be excluded.
    const doc = mutableWorkflow('exec-basic')
    const g0 = (doc['graphs'] as Mutable)['g0'] as Mutable
    const nodes = g0['nodes'] as Mutable
    nodes['n3'] = { id: 'n3', type: 'EmptyImage', values: { width: 8, height: 8, batch_size: 1, color: 0 } }
    nodes['n4'] = { id: 'n4', type: 'PreviewImage', values: {} }
    ;(g0['links'] as Mutable)['l5'] = { id: 'l5', from: { node: 'n3', port: 'out0' }, to: { node: 'n4', port: 'images' } }
    const scope: ExecutionScope = {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    }
    const result = compile(compileInput(doc as unknown as WorkflowDocument, scope))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['n0', 'n1'])
    expect(result.artifact.partialTargets).toEqual(['n1'])
  })

  it('ignores a missing required input outside the partial closure', () => {
    const result = compile(compileInput(withDisconnectedInvalidNode(), {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.diagnostics.filter((d) => d.code === 'compile.input.missing')).toEqual([])
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['n0', 'n1'])
  })

  it('compiles an acyclic partial closure with an unrelated plain-link cycle', () => {
    const doc = mutableWorkflow('exec-basic')
    const g0 = (doc['graphs'] as Mutable)['g0'] as Mutable
    const nodes = g0['nodes'] as Mutable
    const links = g0['links'] as Mutable
    nodes['cycleA'] = { id: 'cycleA', type: 'ImageInvert', values: {} }
    nodes['cycleB'] = { id: 'cycleB', type: 'ImageInvert', values: {} }
    links['cycleAB'] = { id: 'cycleAB', from: { node: 'cycleA', port: 'out0' }, to: { node: 'cycleB', port: 'image' } }
    links['cycleBA'] = { id: 'cycleBA', from: { node: 'cycleB', port: 'out0' }, to: { node: 'cycleA', port: 'image' } }
    const result = compile(compileInput(doc as unknown as WorkflowDocument, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('n1') }],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['n0', 'n1'])
    expect(result.artifact.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
  })

  it('full compile still reports a disconnected node missing a required input', () => {
    const result = compile(compileInput(withDisconnectedInvalidNode()))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const missing = result.artifact.diagnostics.filter((d) => d.code === 'compile.input.missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.anchor?.occurrence?.node).toBe('invalid')
    expect(missing[0]?.blocksExecution).toBe(true)
  })

  it('a missing required input inside the partial closure still blocks execution', () => {
    const result = compile(compileInput(withDisconnectedInvalidNode(), {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('invalid') }],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const missing = result.artifact.diagnostics.filter((d) => d.code === 'compile.input.missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]?.anchor?.occurrence?.node).toBe('invalid')
    expect(missing[0]?.blocksExecution).toBe(true)
  })

  it('scopeClosure agrees with compile', () => {
    const doc = loadWorkflow('exec-subgraph')
    const closure = scopeClosure(compileInput(doc))
    expect(closure).toBeDefined()
    expect([...closure!.included].sort()).toEqual(['n0.n0', 'n1'])
  })

  it('scopeClosure with multiple partial targets unions their upstream closures', () => {
    // exec-basic + a disconnected branch; targeting BOTH sinks includes both
    // chains, still excluding nothing that feeds neither.
    const doc = mutableWorkflow('exec-basic')
    const g0 = (doc['graphs'] as Mutable)['g0'] as Mutable
    const nodes = g0['nodes'] as Mutable
    nodes['n3'] = { id: 'n3', type: 'EmptyImage', values: { width: 8, height: 8, batch_size: 1, color: 0 } }
    nodes['n4'] = { id: 'n4', type: 'PreviewImage', values: {} }
    nodes['n5'] = { id: 'n5', type: 'PreviewImage', values: {} }
    ;(g0['links'] as Mutable)['l5'] = { id: 'l5', from: { node: 'n3', port: 'out0' }, to: { node: 'n4', port: 'images' } }
    const scope: ExecutionScope = {
      kind: 'partial',
      targets: [
        { instancePath: [], node: asNodeId('n1') },
        { instancePath: [], node: asNodeId('n4') },
      ],
    }
    const closure = scopeClosure(compileInput(doc as unknown as WorkflowDocument, scope))
    expect(closure).toBeDefined()
    expect([...closure!.included].sort()).toEqual(['n0', 'n1', 'n3', 'n4'])
  })
})

describe('value handling', () => {
  it('unknown value keys warn and are dropped', () => {
    const doc = mutableWorkflow('exec-basic')
    const nodes = ((doc['graphs'] as Mutable)['g0'] as Mutable)['nodes'] as Mutable
    ;((nodes['n0'] as Mutable)['values'] as Mutable)['not_an_input'] = 42
    const result = compile(compileInput(doc as unknown as WorkflowDocument))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['n0']!.inputs['not_an_input']).toBeUndefined()
    expect(result.artifact.diagnostics.some((d) => d.code === 'compile.value.unknownInput')).toBe(true)
  })

  it('missing widget values fall back to schema defaults', () => {
    const doc = mutableWorkflow('exec-basic')
    const nodes = ((doc['graphs'] as Mutable)['g0'] as Mutable)['nodes'] as Mutable
    ;(nodes['n0'] as Mutable)['values'] = { width: 64, height: 64 } // drop batch_size + color
    const result = compile(compileInput(doc as unknown as WorkflowDocument))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const inputs = result.artifact.prompt['n0']!.inputs
    expect(inputs['batch_size']).toBeDefined()
    expect(inputs['color']).toBeDefined()
  })
})

describe('semantic hash', () => {
  it('ignores view state and titles, tracks values', () => {
    const doc = loadWorkflow('exec-basic')
    const h0 = semanticHashOf(doc)

    const retitled = clone(doc) as unknown as Mutable
    const nodes = ((retitled['graphs'] as Mutable)['g0'] as Mutable)['nodes'] as Mutable
    ;(nodes['n0'] as Mutable)['title'] = 'My source'
    ;(retitled['view'] as Mutable)['graphs'] = {}
    expect(semanticHashOf(retitled as unknown as WorkflowDocument)).toBe(h0)

    const changed = clone(doc) as unknown as Mutable
    const cn = ((changed['graphs'] as Mutable)['g0'] as Mutable)['nodes'] as Mutable
    ;((cn['n0'] as Mutable)['values'] as Mutable)['width'] = 128
    expect(semanticHashOf(changed as unknown as WorkflowDocument)).not.toBe(h0)
  })

  it('sha256Hex matches FIPS 180-2 vectors for string and byte input', () => {
    // Insecure-context fallback for crypto.subtle: correctness is pinned to
    // the published SHA-256 test vectors, including a multi-block input.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'))
  })
})

// ---------------------------------------------------------------------------
// Dynamic interfaces (dynamic interface implementation compile integration)
//
// The compiler resolves values/links by elaborated document identity
// ({port, members} / elaborated key) and emits wire names (apiName) and
// non-ghost output indexes. These tests pin that contract with synthetic
// dynamic schemas (the object_info fixture is static-only).
// ---------------------------------------------------------------------------

import type { InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const dynInput = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const dynOutput = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })
const dynSchemaOf = (type: string, items: (InputSpec | OutputSpec)[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true, // keeps every test node in full scope without sinks
  items,
})

const wire15SchemaOf = (type: string, interfaceItems: readonly Record<string, unknown>[]): NodeSchema => {
  const parsed = parseDinksterSchema(type, { schemaVersion: 1, interface: interfaceItems } as never)
  if (!parsed.schema || parsed.diagnostics.length > 0) throw new Error(`bad test schema ${type}: ${JSON.stringify(parsed.diagnostics)}`)
  return { ...parsed.schema, isOutputNode: true }
}

const dynSchemas: Record<string, NodeSchema> = {
  ImageSrc: dynSchemaOf('ImageSrc', [dynOutput('out')]),
  BooleanSrc: {
    ...dynSchemaOf('BooleanSrc', [{ kind: 'output', id: 'out', type: { kind: 'concrete', name: 'BOOLEAN' } }]),
    isOutputNode: false,
  },
  MountSrc: dynSchemaOf('MountSrc', [{ kind: 'output', id: 'mount', type: { kind: 'concrete', name: 'STRING' } }]),
  MountSink: dynSchemaOf('MountSink', [dynInput('mount', {
    type: { kind: 'concrete', name: 'STRING' },
    optional: true,
    widget: {
      widgetType: 'MOUNT',
      options: {},
      default: null,
    },
  })]),
  ComfyImageSrc: dynSchemaOf('ComfyImageSrc', [{
    kind: 'output', id: 'image', type: { kind: 'concrete', name: 'comfy.IMAGE' },
  }]),
  NonOutputImageSrc: { ...dynSchemaOf('NonOutputImageSrc', [dynOutput('out')]), isOutputNode: false },
  Passthrough: dynSchemaOf('Passthrough', [dynInput('in'), dynOutput('out')]),
  TapWidget: dynSchemaOf('TapWidget', [dynInput('value', { widget: { widgetType: 'IMAGE', options: {} } })]),
  Sink: dynSchemaOf('Sink', [dynInput('in')]),
  NonOutputSink: { ...dynSchemaOf('NonOutputSink', [dynInput('in')]), isOutputNode: false },
  AssetLiteral: dynSchemaOf('AssetLiteral', [dynInput('in', {
    widget: { widgetType: 'ASSET', options: {} },
  })]),
  // Single-slot autogrow (connectable): wire names images.image0, image1...
  Batcher: dynSchemaOf('Batcher', [
    {
      ...dynInput('images'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('image')],
        naming: { kind: 'prefix', prefix: 'image', min: 1, max: 2 },
      },
    },
    dynOutput('out'),
  ]),
  // Widget-backed autogrow: member values live under member elab keys.
  Weigher: dynSchemaOf('Weigher', [
    {
      ...dynInput('weights'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('w', { widget: { widgetType: 'FLOAT', options: {}, default: 0.5 } })],
        naming: { kind: 'prefix', prefix: 'w', min: 0, max: 4 },
      },
    },
  ]),
  NamedRoute: dynSchemaOf('NamedRoute', [
    {
      ...dynInput('values'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('value', { optional: true })],
        naming: { kind: 'prefix', prefix: 'value', min: 0, max: 4 },
      },
    },
    dynInput('name', {
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'COMBO', options: {}, optionSource: { inputFamily: 'values' } },
    }),
    dynOutput('out'),
  ]),
  // Autogrow OUTPUT family followed by a static output (index arithmetic).
  Splitter: dynSchemaOf('Splitter', [
    {
      ...dynOutput('outs'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('o')],
        naming: { kind: 'prefix', prefix: 'o', min: 0, max: 4 },
      },
    } as OutputSpec,
    dynOutput('last'),
  ]),
  // Output autogrow with a MINIMUM: a fresh node min-fills synthetic members.
  SplitterMin: dynSchemaOf('SplitterMin', [
    {
      ...dynOutput('outs'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('o')],
        naming: { kind: 'prefix', prefix: 'o', min: 1, max: 4 },
      },
    } as OutputSpec,
  ]),
  CountSplitter: dynSchemaOf('CountSplitter', [
    dynInput('count', {
      type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: {}, default: 0 },
    }),
    {
      ...dynOutput('images'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('image')],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    } as OutputSpec,
  ]),
  CountMultiSplitter: dynSchemaOf('CountMultiSplitter', [
    dynInput('count', {
      type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: {}, default: 0 },
    }),
    dynOutput('before'),
    {
      ...dynOutput('images'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('image')],
        naming: { kind: 'prefix', prefix: 'image', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    } as OutputSpec,
    dynOutput('after'),
    {
      ...dynOutput('masks'),
      dynamic: {
        kind: 'autogrow',
        template: [dynInput('mask')],
        naming: { kind: 'prefix', prefix: 'mask', min: 0, max: 4 },
        count: { input: 'count', suffix: 'index' },
      },
    } as OutputSpec,
  ]),
  // Unknown dynamic kinds elaborate as inert placeholders (forward compat).
  WeirdIn: dynSchemaOf('WeirdIn', [
    { ...dynInput('myst'), dynamic: { kind: 'mystery' } as never },
  ]),
  WeirdOut: dynSchemaOf('WeirdOut', [
    { ...dynOutput('myst'), dynamic: { kind: 'mystery' } as never } as OutputSpec,
    dynOutput('last'),
  ]),
  // Schema-level id collisions: the compiler must reject, never overwrite.
  DupIn: dynSchemaOf('DupIn', [dynInput('x'), dynInput('x')]),
  DupOut: dynSchemaOf('DupOut', [dynOutput('y'), dynOutput('y')]),
  // Static ids containing '#'/'%': elaborated spec.id is escaped, but the
  // document keys values by the RAW schema id.
  Odd: dynSchemaOf('Odd', [
    dynInput('a#b', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
    dynInput('c%d', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
  ]),
  // One input's RAW id equals another's ESCAPED elaborated id ('a#b'
  // elaborates to spec.id 'a%23b'). Value keys are RAW for statics, so both
  // route unambiguously - this pins that no spec.id-keyed lookup shadows it.
  OddClash: dynSchemaOf('OddClash', [
    dynInput('a#b', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
    dynInput('a%23b', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
  ]),
  ExactInteger: dynSchemaOf('ExactInteger', [
    dynInput('seed', {
      type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: { min: 0, max: '18446744073709551615' }, default: 0 },
    }),
  ]),
  HiddenProvider: dynSchemaOf('HiddenProvider', [
    dynInput('provider', {
      type: { kind: 'concrete', name: 'COMBO' },
      optional: true,
      widget: {
        widgetType: 'COMBO',
        options: { options: ['vision.depth.v2'] },
        default: 'vision.depth.v2',
      },
      hidden: true,
    }),
  ]),
  DecimalIntegerWildcardSink: dynSchemaOf('DecimalIntegerWildcardSink', [
    dynInput('value', { type: { kind: 'wildcard' } }),
  ]),
  DecimalIntegerFloatSink: dynSchemaOf('DecimalIntegerFloatSink', [
    dynInput('value', { type: { kind: 'concrete', name: 'FLOAT' } }),
  ]),
  // DynamicCombo: selector value is dynamic state; branch values branch-local.
  Modal: dynSchemaOf('Modal', [
    {
      ...dynInput('mode'),
      dynamic: {
        kind: 'dynamicCombo',
        options: [
          { key: 'simple', inputs: [dynInput('strength', { widget: { widgetType: 'FLOAT', options: {}, default: 1 } })] },
          {
            key: 'advanced',
            inputs: [
              dynInput('strength', { widget: { widgetType: 'FLOAT', options: {}, default: 1 } }),
              dynInput('bias', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
            ],
          },
        ],
      },
    },
  ]),
  SpecializedSlot: dynSchemaOf('SpecializedSlot', [{
    ...dynInput('slot', { optional: true }),
    dynamic: {
      kind: 'dynamicSlot', slotType: IMAGE, inputs: [],
      variants: [
        { key: 'selected', type: IMAGE, inputs: [dynInput('x', { widget: { widgetType: 'FLOAT', options: {}, default: 1 } })] },
        { key: 'other', type: IMAGE, inputs: [dynInput('x', { widget: { widgetType: 'FLOAT', options: {}, default: 2 } })] },
        { key: 'empty', type: IMAGE, inputs: [] },
      ],
    },
  }]),
  CropImage: dynSchemaOf('CropImage', [
    {
      ...dynInput('source'),
      dynamic: {
        kind: 'dynamicCombo',
        options: [
          { key: 'coordinates', inputs: [] },
          {
            key: 'region',
            inputs: [{
              ...dynInput('region'),
              dynamic: {
                kind: 'dynamicSlot',
                materialization: 'wire15',
                slotType: IMAGE,
                inputs: [],
                variants: [{ key: 'mask', type: IMAGE, inputs: [] }],
              },
            }],
          },
        ],
      },
    },
    dynOutput('image'),
  ]),
  Wire15Family: dynSchemaOf('Wire15Family', [{
    ...dynInput('items', { optional: true }),
    dynamic: {
      kind: 'autogrow', materialization: 'wire15',
      template: [dynInput('value', { optional: true })],
      naming: { kind: 'prefix', prefix: 'item', min: 0, max: 4 },
    },
  }]),
  Wire15Names: wire15SchemaOf('Wire15Names', [{
    role: 'inputFamily', id: 'args', memberNames: ['a', 'b'], minMembers: 1,
    template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['IMAGE'] }, required: false }],
  }]),
  Wire15RequiredMin: wire15SchemaOf('Wire15RequiredMin', [{
    role: 'inputFamily', id: 'items', memberPrefix: 'item', minMembers: 2, maxMembers: 4,
    template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['IMAGE'] }, required: true }],
  }]),
  Wire15Grouped: wire15SchemaOf('Wire15Grouped', [{
    role: 'inputFamily', id: 'pairs', memberPrefix: 'pair', minMembers: 0, maxMembers: 3,
    template: [
      { role: 'input', id: 'left', type: { kind: 'concrete', types: ['IMAGE'] }, required: false },
      { role: 'input', id: 'right', type: { kind: 'concrete', types: ['IMAGE'] }, required: false },
    ],
  }]),
  Wire15ComboFamily: wire15SchemaOf('Wire15ComboFamily', [{
    role: 'inputFamily', id: 'items', memberPrefix: 'item', minMembers: 0, maxMembers: 3,
    template: [{
      role: 'dynamicCombo', id: 'mode', options: [
        { key: 'a', inputs: [{
          role: 'input', id: 'amount', type: { kind: 'concrete', types: ['IMAGE'] }, required: false,
        }] },
        { key: 'b', inputs: [] },
      ],
    }],
  }]),
  Wire15Recursive: wire15SchemaOf('Wire15Recursive', [{
    role: 'dynamicCombo', id: 'mode', options: [
      { key: 'none', inputs: [] },
      { key: 'batch', inputs: [
        {
          role: 'inputFamily', id: 'frames', memberPrefix: 'frame', minMembers: 0, maxMembers: 4,
          template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['IMAGE'] }, required: false }],
        },
        { role: 'dynamicCombo', id: 'quality', options: [
          { key: 'draft', inputs: [] },
          { key: 'full', inputs: [{ role: 'input', id: 'steps', type: { kind: 'concrete', types: ['IMAGE'] }, required: false }] },
        ] },
      ] },
    ],
  }]),
  Wire15PunctuationCombo: wire15SchemaOf('Wire15PunctuationCombo', [{
    role: 'dynamicCombo', id: 'mode', options: [
      { key: 'Flux.2 [pro]', inputs: [
        { role: 'input', id: 'scale', type: { kind: 'concrete', types: ['IMAGE'] }, required: false },
      ] },
      { key: 'Flux.2 [max]', inputs: [] },
    ], default: 'Flux.2 [pro]',
  }]),
  Wire15NonFirstDefault: wire15SchemaOf('Wire15NonFirstDefault', [{
    role: 'dynamicCombo', id: 'mode', options: [
      { key: 'first', inputs: [
        { role: 'input', id: 'scale', type: { kind: 'concrete', types: ['IMAGE'] }, required: false },
      ] },
      { key: 'descriptor default', inputs: [] },
    ], default: 'descriptor default',
  }]),
  Wire15OpenSlot: wire15SchemaOf('Wire15OpenSlot', [{
    role: 'dynamicSlot', id: 'model', slotType: { kind: 'concrete', types: ['IMAGE'] }, required: false,
    inputs: [{ role: 'input', id: 'weight', type: { kind: 'concrete', types: ['IMAGE'] }, required: false }],
  }]),
  LazySelector: {
    ...dynSchemaOf('LazySelector', [
      dynInput('switch', { type: { kind: 'concrete', name: 'BOOLEAN' }, widget: { widgetType: 'BOOLEAN', options: {} } }),
      dynInput('on_false'),
      dynInput('on_true'),
      dynOutput('result'),
    ]),
    selector: { input: 'switch', branches: { false: 'on_false', true: 'on_true' } },
  },
  LazySelectorOdd: {
    ...dynSchemaOf('LazySelectorOdd', [
      dynInput('switch#id', { type: { kind: 'concrete', name: 'BOOLEAN' }, widget: { widgetType: 'BOOLEAN', options: {} } }),
      dynInput('on_false'),
      dynInput('on_true'),
      dynOutput('result'),
    ]),
    selector: { input: 'switch#id', branches: { false: 'on_false', true: 'on_true' } },
  },
  CreateList14: dynSchemaOf('CreateList14', [{
    ...dynInput('items', { optional: true }),
    dynamic: {
      kind: 'autogrow', template: [dynInput('value', { optional: true })],
      naming: { kind: 'prefix', prefix: 'items', min: 1, max: 3 },
    },
  }]),
  CreateList15: wire15SchemaOf('CreateList15', [{
    role: 'inputFamily', id: 'items', memberPrefix: 'items', minMembers: 1, maxMembers: 3, required: false,
    template: [{ role: 'input', id: 'value', type: { kind: 'concrete', types: ['IMAGE'] }, required: false }],
  }]),
  'comfy.ResizeImageMaskNode': parseDinksterSchema(
    'comfy.ResizeImageMaskNode',
    { ...readJson('fixtures/dinkster-resize-image-mask-wire16.json') as DinksterWireSchema, schemaVersion: 1 },
  ).schema!,
}
const dynResolve = (type: string) => dynSchemas[type]

type DynNode = {
  type: string
  values?: Record<string, unknown>
  dynamic?: Record<string, unknown>
  mode?: 'active' | 'muted' | 'bypassed'
}
type DynEnd =
  | [node: string, port: string, members?: string[]]
  | { reroute: string }
  | { node: string; tap: string }
  | { valueSource: string }
const dynDoc = (parts: {
  nodes: Record<string, DynNode>
  links?: [from: DynEnd, to: DynEnd][]
  reroutes?: string[]
  valueSources?: Record<string, unknown>
  nets?: [name: string, source: [node: string, port: string], sinks: [node: string, port: string][]][]
  boundary?: { inputs?: unknown[]; outputs?: unknown[] }
  subgraphs?: Record<string, {
    nodes: Record<string, DynNode>
    links?: [from: DynEnd, to: DynEnd][]
    reroutes?: string[]
    valueSources?: Record<string, unknown>
    boundary: { inputs?: unknown[]; outputs?: unknown[] }
  }>
}): WorkflowDocument => {
  const end = (e: DynEnd) => Array.isArray(e)
    ? { node: e[0], port: e[1], ...(e[2] ? { members: e[2] } : {}) }
    : e
  const defOf = (
    id: string,
    nodes: Record<string, DynNode>,
    links: [DynEnd, DynEnd][],
    boundary?: { inputs?: unknown[]; outputs?: unknown[] },
    reroutes: readonly string[] = [],
    valueSources: Record<string, unknown> = {},
  ): unknown => ({
    id,
    name: id,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([nid, n]) => [
        nid,
        { id: nid, type: n.type, values: n.values ?? {}, ...(n.dynamic ? { dynamic: n.dynamic } : {}), ...(n.mode ? { mode: n.mode } : {}) },
      ]),
    ),
    links: Object.fromEntries(links.map((l, i) => [`l${i}`, { id: `l${i}`, from: end(l[0]), to: end(l[1]) }])),
    nets: id === 'g0' ? Object.fromEntries((parts.nets ?? []).map(([name, source, sinks]) => [name, {
      name, source: end(source), sinks: sinks.map((sink) => end(sink)),
    }])) : {},
    reroutes: Object.fromEntries(reroutes.map((reroute) => [reroute, { id: reroute }])),
    valueSources: Object.fromEntries(Object.entries(valueSources).map(([sourceId, value]) => [sourceId, {
      id: sourceId,
      value,
      spec: { widgetType: 'IMAGE' },
    }])),
    nextOrdinal: 100,
    ...(boundary ? { boundary: { inputs: boundary.inputs ?? [], outputs: boundary.outputs ?? [] } } : {}),
  })
  const graphs: Record<string, unknown> = {
    g0: defOf('g0', parts.nodes, parts.links ?? [], undefined, parts.reroutes, parts.valueSources),
  }
  for (const [id, sub] of Object.entries(parts.subgraphs ?? {})) {
    graphs[id] = defOf(id, sub.nodes, sub.links ?? [], sub.boundary, sub.reroutes, sub.valueSources)
  }
  return {
    format: 'dinkster-workflow',
    formatVersion: 1,
    lineage: 'test-lineage',
    root: 'g0',
    graphs,
    view: { graphs: {} },
  } as unknown as WorkflowDocument
}

const dynCompile = (doc: WorkflowDocument, scope: ExecutionScope = { kind: 'full' }) =>
  compile({ ...compileInput(doc, scope), resolve: dynResolve })

describe('dynamic interfaces', () => {
  it('keeps input-family labels out of execution while submitting the stable member id', () => {
    const document = dynDoc({ nodes: { route: {
      type: 'NamedRoute',
      values: { name: 'm7', 'values.value#m7': 4 },
      dynamic: { values: { members: ['m7'], memberLabels: { m7: 'Background' } } },
    } } })
    const labeled = dynCompile(document)
    const unlabeled = dynCompile({
      ...document,
      graphs: {
        ...document.graphs,
        g0: {
          ...document.graphs.g0!,
          nodes: {
            ...document.graphs.g0!.nodes,
            route: { ...document.graphs.g0!.nodes.route!, dynamic: { values: { members: ['m7'] } } },
          },
        },
      },
    })

    expect(labeled.ok, JSON.stringify(!labeled.ok && labeled.diagnostics)).toBe(true)
    expect(unlabeled.ok, JSON.stringify(!unlabeled.ok && unlabeled.diagnostics)).toBe(true)
    if (!labeled.ok || !unlabeled.ok) return
    expect(labeled.artifact.prompt.route?.inputs).toEqual({ name: 'm7', 'values.value0': 4 })
    expect(labeled.artifact.prompt).toEqual(unlabeled.artifact.prompt)
    expect(labeled.artifact.semanticHash).toBe(unlabeled.artifact.semanticHash)
    expect(JSON.stringify(labeled.artifact.prompt)).not.toContain('Background')
  })

  it('lowers an unsafe integer through $int only when the backend advertises decimalInt', () => {
    const document = dynDoc({
      nodes: { target: { type: 'ExactInteger', values: { seed: '18446744073709551615' } } },
    })
    const supported = compile({
      ...compileInput(document),
      resolve: dynResolve,
      graphFeatures: [DINKSTER_GRAPH_FEATURE_DECIMAL_INT],
    })
    expect(supported.ok, JSON.stringify(!supported.ok && supported.diagnostics)).toBe(true)
    if (supported.ok) expect(supported.artifact.prompt.target?.inputs.seed).toEqual({ $int: '18446744073709551615' })

    const unsupported = dynCompile(document)
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) {
      expect(unsupported.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.value.decimalIntUnsupported')
    }
  })

  it('preserves $int when a widget tap bakes an unsafe integer into INT', () => {
    const document = dynDoc({
      nodes: {
        source: { type: 'ExactInteger', values: { seed: '18446744073709551615' } },
        target: { type: 'ExactInteger' },
      },
      links: [[{ node: 'source', tap: 'seed' }, ['target', 'seed']]],
    })
    const supported = compile({
      ...compileInput(document),
      resolve: dynResolve,
      graphFeatures: [DINKSTER_GRAPH_FEATURE_DECIMAL_INT],
    })
    expect(supported.ok, JSON.stringify(!supported.ok && supported.diagnostics)).toBe(true)
    if (supported.ok) expect(supported.artifact.prompt.target?.inputs.seed).toEqual({ $int: '18446744073709551615' })

    const unsupported = dynCompile(document)
    expect(unsupported.ok).toBe(false)
    if (!unsupported.ok) {
      expect(unsupported.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.value.decimalIntUnsupported')
    }
  })

  it('compiles a STRING producer into a mount widget as an ordinary link without changing dormant values', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        producer: { type: 'MountSrc' },
        consumer: {
          type: 'MountSink',
          values: { mount: 'archive' },
        },
      },
      links: [[['producer', 'mount'], ['consumer', 'mount']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.consumer?.inputs.mount).toEqual(['producer', 0])
    expect(result.artifact.snapshot.graphs.g0!.nodes.consumer!.values.mount).toBe('archive')
  })

  it('submits a link-fed lazy-switch decision and keeps both branches neutral in would-run', () => {
    const doc = dynDoc({
      nodes: {
        decisionSource: { type: 'BooleanSrc' },
        falseSource: { type: 'NonOutputImageSrc' },
        trueSource: { type: 'NonOutputImageSrc' },
        selector: { type: 'LazySelector', values: { switch: false } },
      },
      links: [
        [['decisionSource', 'out'], ['selector', 'switch']],
        [['falseSource', 'out'], ['selector', 'on_false']],
        [['trueSource', 'out'], ['selector', 'on_true']],
      ],
    })
    const result = dynCompile(doc)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.diagnostics).toEqual([])
    expect(result.artifact.prompt).toEqual({
      decisionSource: { class_type: 'BooleanSrc', inputs: {}, outputIds: ['out'] },
      falseSource: { class_type: 'NonOutputImageSrc', inputs: {}, outputIds: ['out'] },
      trueSource: { class_type: 'NonOutputImageSrc', inputs: {}, outputIds: ['out'] },
      selector: {
        class_type: 'LazySelector',
        outputIds: ['result'],
        inputs: {
          switch: ['decisionSource', 0],
          on_false: ['falseSource', 0],
          on_true: ['trueSource', 0],
        },
      },
    })
    const closure = scopeClosure({ ...compileInput(doc), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual(['decisionSource', 'falseSource', 'selector', 'trueSource'])
    expect(closure.inactiveExclusive.size).toBe(0)
  })

  it('submits a stored lazy-switch decision and both branch inputs unchanged', () => {
    const valued = dynCompile(dynDoc({
      nodes: {
        falseSource: { type: 'ImageSrc' },
        trueSource: { type: 'ImageSrc' },
        selector: { type: 'LazySelector', values: { switch: true } },
      },
      links: [
        [['falseSource', 'out'], ['selector', 'on_false']],
        [['trueSource', 'out'], ['selector', 'on_true']],
      ],
    }))
    expect(valued.ok).toBe(true)
    if (valued.ok) {
      expect(valued.artifact.prompt.selector?.inputs.switch).toBe(true)
      expect(valued.artifact.prompt.selector?.inputs.on_false).toEqual(['falseSource', 0])
      expect(valued.artifact.prompt.selector?.inputs.on_true).toEqual(['trueSource', 0])
      expect(Object.keys(valued.artifact.prompt).sort()).toEqual(['falseSource', 'selector', 'trueSource'])
    }
  })

  it('projects a stored lazy-switch choice without changing exact prompt bytes', () => {
    const doc = dynDoc({
      nodes: {
        falseSource: { type: 'ImageSrc' },
        trueSource: { type: 'ImageSrc' },
        selector: { type: 'LazySelector', values: { switch: true } },
      },
      links: [
        [['falseSource', 'out'], ['selector', 'on_false']],
        [['trueSource', 'out'], ['selector', 'on_true']],
      ],
    })
    const scope: ExecutionScope = {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('selector') }],
    }
    const exact = dynCompile(doc, scope)
    expect(exact.ok).toBe(true)
    if (!exact.ok) return
    expect(exact.artifact.prompt.selector?.inputs).toMatchObject({
      switch: true,
      on_false: ['falseSource', 0],
      on_true: ['trueSource', 0],
    })
    expect(Object.keys(exact.artifact.prompt).sort()).toEqual(['falseSource', 'selector', 'trueSource'])
    const exactBytes = JSON.stringify(exact.artifact.prompt)
    const exactHash = exact.artifact.semanticHash

    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual(['selector', 'trueSource'])
    expect([...closure.inactiveExclusive.get('selector') ?? []]).toEqual(['falseSource'])
    const afterProjection = dynCompile(doc, scope)
    expect(afterProjection.ok).toBe(true)
    if (afterProjection.ok) {
      expect(JSON.stringify(afterProjection.artifact.prompt)).toBe(exactBytes)
      expect(afterProjection.artifact.semanticHash).toBe(exactHash)
    }
  })

  it.each([
    [true, 'selectedSource', 'inactiveSource', ['selected-route']],
    [false, 'inactiveSource', 'selectedSource', []],
  ] as const)('composes lazy choice %s with bypass on either branch, net, reroute, and recursive wire-15 destination', (choice, liveSource, dimmedSource, reroutes) => {
    const doc = dynDoc({
      nodes: {
        inactiveSource: { type: 'ImageSrc' },
        selectedSource: { type: 'ImageSrc' },
        bypass: { type: 'Passthrough', mode: 'bypassed' },
        selector: { type: 'LazySelector', values: { switch: choice } },
        target: { type: 'Wire15Family' },
      },
      reroutes: ['selected-route'],
      nets: [['inactive-feed', ['inactiveSource', 'out'], [['bypass', 'in']]]],
      links: [
        [['bypass', 'out'], ['selector', 'on_false']],
        [['selectedSource', 'out'], { reroute: 'selected-route' }],
        [{ reroute: 'selected-route' }, ['selector', 'on_true']],
        [['selector', 'result'], ['target', 'items.result']],
      ],
    })
    const scope: ExecutionScope = {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('target') }],
    }
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual([liveSource, 'selector', 'target'].sort())
    expect([...closure.inactiveExclusive.get('selector') ?? []]).toEqual([dimmedSource])
    expect([...closure.structural.get('g0')?.reroutes ?? []]).toEqual(reroutes)
  })

  it('keeps lazy-switch inactive cones occurrence-qualified inside subgraphs', () => {
    const doc = dynDoc({
      nodes: { left: { type: '#branch' }, right: { type: '#branch' } },
      subgraphs: {
        branch: {
          nodes: {
            falseSource: { type: 'ImageSrc' },
            trueSource: { type: 'ImageSrc' },
            selector: { type: 'LazySelector', values: { switch: true } },
          },
          links: [
            [['falseSource', 'out'], ['selector', 'on_false']],
            [['trueSource', 'out'], ['selector', 'on_true']],
          ],
          boundary: { inputs: [], outputs: [] },
        },
      },
    })
    const scope: ExecutionScope = {
      kind: 'partial',
      targets: [{ instancePath: [asNodeId('left')], node: asNodeId('selector') }],
    }
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual(['left.selector', 'left.trueSource'])
    expect([...closure.inactiveExclusive.keys()]).toEqual(['left.selector'])
    expect([...closure.inactiveExclusive.get('left.selector') ?? []]).toEqual(['left.falseSource'])
  })

  it('uses occurrence-promoted booleans and keeps promoted null neutral', () => {
    const doc = dynDoc({
      nodes: {
        decided: { type: '#branch', values: { decision: false } },
        neutral: { type: '#branch', values: { decision: null } },
      },
      subgraphs: {
        branch: {
          nodes: {
            falseSource: { type: 'ImageSrc' },
            trueSource: { type: 'ImageSrc' },
            selector: { type: 'LazySelector', values: { switch: true } },
          },
          links: [
            [['falseSource', 'out'], ['selector', 'on_false']],
            [['trueSource', 'out'], ['selector', 'on_true']],
          ],
          boundary: {
            inputs: [{ id: 'decision', binds: { kind: 'port', node: 'selector', port: 'switch' } }],
            outputs: [],
          },
        },
      },
    })
    const scope: ExecutionScope = { kind: 'partial', targets: [
      { instancePath: [asNodeId('decided')], node: asNodeId('selector') },
      { instancePath: [asNodeId('neutral')], node: asNodeId('selector') },
    ] }
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual([
      'decided.falseSource', 'decided.selector',
      'neutral.falseSource', 'neutral.selector', 'neutral.trueSource',
    ])
    expect([...closure.inactiveExclusive.keys()]).toEqual(['decided.selector'])
    expect([...closure.inactiveExclusive.get('decided.selector') ?? []]).toEqual(['decided.trueSource'])
  })

  it('composes nested lazy-switch inactive-exclusive projections', () => {
    const doc = dynDoc({
      nodes: {
        outerOff: { type: 'ImageSrc' },
        innerOn: { type: 'ImageSrc' },
        innerOff: { type: 'ImageSrc' },
        inner: { type: 'LazySelector', values: { switch: false } },
        outer: { type: 'LazySelector', values: { switch: true } },
      },
      links: [
        [['innerOn', 'out'], ['inner', 'on_false']],
        [['innerOff', 'out'], ['inner', 'on_true']],
        [['outerOff', 'out'], ['outer', 'on_false']],
        [['inner', 'result'], ['outer', 'on_true']],
      ],
    })
    const scope: ExecutionScope = { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('outer') }] }
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual(['inner', 'innerOn', 'outer'])
    expect([...closure.inactiveExclusive.get('outer') ?? []]).toEqual(['outerOff'])
    expect([...closure.inactiveExclusive.get('inner') ?? []]).toEqual(['innerOff'])
  })

  it.each([
    ['missing', {}],
    ['non-boolean', { switch: 'true' }],
  ])('keeps %s lazy-switch state neutral', (_name, values) => {
    const doc = dynDoc({
      nodes: {
        falseSource: { type: 'ImageSrc' },
        trueSource: { type: 'ImageSrc' },
        selector: { type: 'LazySelector', values },
      },
      links: [
        [['falseSource', 'out'], ['selector', 'on_false']],
        [['trueSource', 'out'], ['selector', 'on_true']],
      ],
    })
    const scope: ExecutionScope = {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('selector') }],
    }
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual(['falseSource', 'selector', 'trueSource'])
    expect(closure.inactiveExclusive.size).toBe(0)
  })

  it('rewires a wire-15 destination after its producer becomes bypassed', () => {
    const clean = dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        modeNode: { type: 'Passthrough' },
        target: { type: 'Wire15Family' },
      },
      links: [[['source', 'out'], ['modeNode', 'in']], [['modeNode', 'out'], ['target', 'items.stable']]],
    })
    const before = dynCompile(clean)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    if (before.ok) expect(before.artifact.prompt['target']!.inputs).toEqual({ 'items.stable': ['modeNode', 0] })
    const changed = structuredClone(clean) as unknown as Mutable
    const graphs = changed['graphs'] as Mutable
    const root = graphs['g0'] as Mutable
    const nodes = root['nodes'] as Mutable
    ;(nodes['modeNode'] as Mutable)['mode'] = 'bypassed'
    const after = dynCompile(changed as unknown as WorkflowDocument)
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (after.ok) {
      expect(after.artifact.prompt['target']!.inputs).toEqual({ 'items.stable': ['source', 0] })
      expect(Object.keys(after.artifact.prompt)).not.toContain('modeNode')
    }
  })

  it('lowers recursive wire-15 family values at stable materialized paths', () => {
    const result = dynCompile(dynDoc({
      nodes: { target: { type: 'Wire15Family', values: { 'items.stable': 7 }, dynamic: { items: { members: ['stable'] } } } },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']!.inputs).toEqual({ 'items.stable': 7 })
  })

  it('lowers names-form members by semantic suffix and enforces minimum membership', () => {
    const lowered = dynCompile(dynDoc({
      nodes: { target: { type: 'Wire15Names', values: { 'args.b': 9 }, dynamic: { args: { members: ['b'] } } } },
    }))
    expect(lowered.ok, JSON.stringify(!lowered.ok && lowered.diagnostics)).toBe(true)
    if (lowered.ok) expect(lowered.artifact.prompt['target']!.inputs).toEqual({ 'args.b': 9 })

    const missing = dynCompile(dynDoc({ nodes: { target: { type: 'Wire15Names' } } }))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain('elab.autogrow.underMin')
  })

  it('appends grouped-template leaf ids without submitting member vocabulary keys', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15Grouped',
      values: { 'pairs.stable.left': 1, 'pairs.stable.right': 2 },
      dynamic: { pairs: { members: ['stable'] } },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']!.inputs).toEqual({
      'pairs.stable.left': 1,
      'pairs.stable.right': 2,
    })
  })

  it('carries member-addressed wire-15 choices under materialized paths', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15ComboFamily',
      dynamic: {
        items: { members: ['left', 'right'] },
        'items.left.mode': { selected: 'a' },
        'items.right.mode': { selected: 'b' },
      },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.target).toEqual({
      class_type: 'Wire15ComboFamily',
      outputIds: [],
      inputs: {
        'items.left.mode': 'a',
        'items.right.mode': 'b',
      },
      slotVariants: {
        'items.left.mode': 'a',
        'items.right.mode': 'b',
      },
    })
  })

  it('lowers nested combo selectors and only the active recursive paths', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15Recursive',
      values: { 'mode.frames.stable': 1, 'mode.quality.steps': 2, 'mode.inactive': 3 },
      dynamic: {
        mode: { selected: 'batch' },
        'mode.frames': { members: ['stable'] },
        'mode.quality': { selected: 'full' },
      },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({
      class_type: 'Wire15Recursive',
      outputIds: [],
      inputs: {
        mode: 'batch',
        'mode.frames.stable': 1,
        'mode.quality': 'full',
        'mode.quality.steps': 2,
      },
      slotVariants: { mode: 'batch', 'mode.quality': 'full' },
    })
  })

  it('rejects a missing nested wire-15 choice instead of deriving the first option', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15Recursive',
      dynamic: { mode: { selected: 'batch' }, 'mode.frames': { members: [] } },
    } } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'compile.combo.missingChoice',
      message: expect.stringContaining("DynamicCombo 'mode.quality' has no stored choice"),
    }))
  })

  it('lowers the Flux.2 [pro] wire-15 combo selection and active branch verbatim', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15PunctuationCombo',
      values: { 'mode.scale': 2 },
      dynamic: { mode: { selected: 'Flux.2 [pro]' } },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']!.inputs).toEqual({
      mode: 'Flux.2 [pro]',
      'mode.scale': 2,
    })
  })

  it('rejects an invalid stored wire-15 choice without falling back', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15Recursive',
      dynamic: { mode: { selected: 'gone' } },
    } } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('prompt.bad_dynamic_choice')
  })

  it('submits an explicitly stored first wire-15 option rather than a descriptor default', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15NonFirstDefault',
      values: { 'mode.scale': 3 },
      dynamic: { mode: { selected: 'first' } },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({
      class_type: 'Wire15NonFirstDefault',
      outputIds: [],
      inputs: { mode: 'first', 'mode.scale': 3 },
      slotVariants: { mode: 'first' },
    })
  })

  it('compiles a persisted-first ResizeImageMaskNode with its selector and widget values', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          source: { type: 'ComfyImageSrc' },
          target: {
            type: 'comfy.ResizeImageMaskNode',
            values: {
              scale_method: 'bicubic',
              'resize_type.width': 640,
              'resize_type.height': 480,
              'resize_type.crop': 'disabled',
            },
            dynamic: { resize_type: { selected: 'scale dimensions' } },
          },
          excluded: { type: 'Wire15PunctuationCombo' },
        },
        links: [[['source', 'image'], ['target', 'input']]],
      }),
      { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('target') }] },
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.target).toEqual({
      class_type: 'comfy.ResizeImageMaskNode',
      outputIds: ['resized'],
      inputs: {
        input: ['source', 0],
        scale_method: 'bicubic',
        resize_type: 'scale dimensions',
        'resize_type.width': 640,
        'resize_type.height': 480,
        'resize_type.crop': 'disabled',
      },
      slotVariants: { resize_type: 'scale dimensions' },
    })
    expect(result.artifact.prompt.excluded).toBeUndefined()
  })

  it('lowers open-slot values, links, and dependents only while the slot is active', () => {
    const valued = dynCompile(dynDoc({ nodes: { target: {
      type: 'Wire15OpenSlot', values: { model: 'value', 'model.weight': 0.5 },
    } } }))
    expect(valued.ok, JSON.stringify(!valued.ok && valued.diagnostics)).toBe(true)
    if (valued.ok) expect(valued.artifact.prompt['target']!.inputs).toEqual({ model: 'value', 'model.weight': 0.5 })

    const linked = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, target: { type: 'Wire15OpenSlot', values: { 'model.weight': 0.75 } } },
      links: [[['source', 'out'], ['target', 'model']]],
    }))
    expect(linked.ok, JSON.stringify(!linked.ok && linked.diagnostics)).toBe(true)
    if (linked.ok) expect(linked.artifact.prompt['target']!.inputs).toEqual({ model: ['source', 0], 'model.weight': 0.75 })

    const inactive = dynCompile(dynDoc({ nodes: { target: { type: 'Wire15OpenSlot', values: { 'model.weight': 0.5 } } } }))
    expect(inactive.ok).toBe(false)
    if (!inactive.ok) expect(inactive.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.value.unknownInput')

    const absent = dynCompile(dynDoc({ nodes: { target: { type: 'Wire15OpenSlot' } } }))
    expect(absent.ok).toBe(true)
    if (absent.ok) expect(absent.artifact.prompt['target']!.inputs).toEqual({})
  })

  it('keeps muted wire-15 link evidence structural but omits its dead delivery', () => {
    const live = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, target: { type: 'Wire15Family' } },
      links: [[['source', 'out'], ['target', 'items.linked']]],
    }))
    expect(live.ok, JSON.stringify(!live.ok && live.diagnostics)).toBe(true)
    if (live.ok) expect(live.artifact.prompt['target']!.inputs).toEqual({ 'items.linked': ['source', 0] })

    const dead = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc', mode: 'muted' }, target: { type: 'Wire15Family' } },
      links: [[['source', 'out'], ['target', 'items.dead']]],
    }))
    expect(dead.ok, JSON.stringify(!dead.ok && dead.diagnostics)).toBe(true)
    if (dead.ok) {
      expect(dead.artifact.prompt['target']!.inputs).toEqual({})
      expect(dead.artifact.diagnostics.map((diagnostic) => diagnostic.code)).toContain('compile.link.dropped')
    }
  })

  it('shares reroute, net, and bypass delivery semantics with wire-15 evidence', () => {
    const rerouted = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, target: { type: 'Wire15Family' } },
      reroutes: ['r'],
      links: [[['source', 'out'], { reroute: 'r' }], [{ reroute: 'r' }, ['target', 'items.rerouted']]],
    }))
    expect(rerouted.ok, JSON.stringify(!rerouted.ok && rerouted.diagnostics)).toBe(true)
    if (rerouted.ok) expect(rerouted.artifact.prompt['target']!.inputs).toEqual({ 'items.rerouted': ['source', 0] })

    const net = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, target: { type: 'Wire15Family' } },
      nets: [['images', ['source', 'out'], [['target', 'items.net']]]],
    }))
    expect(net.ok, JSON.stringify(!net.ok && net.diagnostics)).toBe(true)
    if (net.ok) expect(net.artifact.prompt['target']!.inputs).toEqual({ 'items.net': ['source', 0] })

    const bypassed = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        pass: { type: 'Passthrough', mode: 'bypassed' },
        target: { type: 'Wire15Family' },
      },
      links: [[['source', 'out'], ['pass', 'in']], [['pass', 'out'], ['target', 'items.bypassed']]],
    }))
    expect(bypassed.ok, JSON.stringify(!bypassed.ok && bypassed.diagnostics)).toBe(true)
    if (bypassed.ok) expect(bypassed.artifact.prompt['target']!.inputs).toEqual({ 'items.bypassed': ['source', 0] })
  })

  it('projects wire-15 live-link materialization per subgraph occurrence', () => {
    const result = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, linked: { type: '#sub' }, absent: { type: '#sub' } },
      links: [[['source', 'out'], ['linked', 'model']]],
      subgraphs: {
        sub: {
          nodes: { inner: { type: 'Wire15OpenSlot' } },
          boundary: { inputs: [{ id: 'model', binds: { kind: 'port', node: 'inner', port: 'model' } }] },
        },
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['linked.inner']!.inputs).toEqual({ model: ['source', 0] })
    expect(result.artifact.prompt['absent.inner']!.inputs).toEqual({})
  })

  it('lowers a linked selected DynamicSlot variant input construct-locally with a slotVariants entry', () => {
    // Settled contract (Dinkster c2ac572, wire v6): dependents submit under
    // '<slotId>.<local>' and the stored choice travels once per node as
    // slotVariants - the backend elaborates the interface from that choice.
    const result = dynCompile(dynDoc({
      nodes: {
        slotSource: { type: 'ImageSrc' },
        valueSource: { type: 'ImageSrc' },
        target: { type: 'SpecializedSlot', dynamic: { slot: { selected: 'selected' } } },
      },
      links: [
        [['slotSource', 'out'], ['target', 'slot']],
        [['valueSource', 'out'], ['target', 'slot.[selected].x']],
      ],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({
      class_type: 'SpecializedSlot',
      outputIds: [],
      inputs: { slot: ['slotSource', 0], 'slot.x': ['valueSource', 0] },
      slotVariants: { slot: 'selected' },
    })
  })

  it('lowers a stored value on a selected DynamicSlot variant input', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        target: {
          type: 'SpecializedSlot',
          dynamic: { slot: { selected: 'selected' } },
          values: { 'slot.[selected].x': 3 },
        },
      },
      links: [[['source', 'out'], ['target', 'slot']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({
      class_type: 'SpecializedSlot',
      outputIds: [],
      inputs: { slot: ['source', 0], 'slot.x': 3 },
      slotVariants: { slot: 'selected' },
    })
  })

  it('emits slotVariants for a connected zero-dependent variant (choice travels even with no dependents)', () => {
    // Settled contract (c2ac572): the elaborated schema's slotChoices join
    // the backend schema signature, so switching variants is a cache miss
    // even when the variant contributes no dependent inputs. The choice must
    // therefore travel whenever the slot participates in the prompt,
    // independent of dependent count.
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        target: { type: 'SpecializedSlot', dynamic: { slot: { selected: 'empty' } } },
      },
      links: [[['source', 'out'], ['target', 'slot']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({
      class_type: 'SpecializedSlot',
      outputIds: [],
      inputs: { slot: ['source', 0] },
      slotVariants: { slot: 'empty' },
    })
  })

  it('rejects a connected DynamicSlot storing an unknown variant key', () => {
    // Unknown/stale keys are deterministic elaboration-failed errors on the
    // backend; surface them early and anchored instead of submitting.
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        target: { type: 'SpecializedSlot', dynamic: { slot: { selected: 'gone' } } },
      },
      links: [[['source', 'out'], ['target', 'slot']]],
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    const d = result.diagnostics.find((c) => c.code === 'compile.slot.missingVariant')
    expect(d?.message).toBe("SpecializedSlot.slot: unknown slot variant 'gone'")
  })

  it('rejects a connected variant-bearing DynamicSlot without a stored choice', () => {
    // The backend elaborates the interface FROM the stored choice; a
    // connected slot with none (or an unknown key) is a deterministic
    // elaboration failure there, surfaced early here.
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        target: { type: 'SpecializedSlot' },
      },
      links: [[['source', 'out'], ['target', 'slot']]],
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.some((d) => d.code === 'compile.slot.missingVariant')).toBe(true)
  })

  it('scopes DynamicSlot variant validation to the partial closure', () => {
    const doc = dynDoc({
      nodes: {
        selectedSource: { type: 'ImageSrc' },
        selected: { type: 'Sink' },
        invalidSource: { type: 'ImageSrc' },
        invalid: { type: 'SpecializedSlot' },
      },
      links: [
        [['selectedSource', 'out'], ['selected', 'in']],
        [['invalidSource', 'out'], ['invalid', 'slot']],
      ],
    })
    const partial = dynCompile(doc, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('selected') }],
    })
    expect(partial.ok, JSON.stringify(!partial.ok && partial.diagnostics)).toBe(true)
    if (partial.ok) {
      expect(partial.artifact.diagnostics.some((d) => d.code === 'compile.slot.missingVariant')).toBe(false)
      expect(Object.keys(partial.artifact.prompt).sort()).toEqual(['selected', 'selectedSource'])
    }

    const full = dynCompile(doc)
    expect(full.ok).toBe(false)
    if (!full.ok) expect(full.diagnostics.some((d) => d.code === 'compile.slot.missingVariant')).toBe(true)
  })

  it('keeps structural route errors that break an included partial path', () => {
    const doc = dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        selected: { type: 'Sink' },
      },
      links: [[['source', 'missing'], ['selected', 'in']]],
    })
    const result = dynCompile(doc, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('selected') }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.diagnostics.some((diagnostic) => diagnostic.code === 'compile.port.unknownOutput')).toBe(true)
  })

  it('scopes staged value diagnostics to the partial closure', () => {
    const assetRef = {
      digest: `blake3:${'a'.repeat(64)}`,
      name: 'cat.png',
      size: 3,
      mediaType: 'image/png',
      virtualPath: '',
    }
    const doc = dynDoc({
      nodes: {
        selectedSource: { type: 'ImageSrc' },
        selected: { type: 'Sink' },
        staleValue: { type: 'Sink', values: { removed: 1 } },
        unsupportedAsset: { type: 'AssetLiteral', values: { in: assetRef } },
      },
      links: [[['selectedSource', 'out'], ['selected', 'in']]],
    })
    const partial = dynCompile(doc, {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('selected') }],
    })
    expect(partial.ok, JSON.stringify(!partial.ok && partial.diagnostics)).toBe(true)
    if (!partial.ok) return
    expect(partial.artifact.diagnostics.some((d) => d.code === 'compile.value.unknownInput')).toBe(false)
    expect(partial.artifact.diagnostics.some((d) => d.code === 'compile.value.assetSourceUnsupported')).toBe(false)

    const full = dynCompile(doc)
    expect(full.ok).toBe(false)
    if (!full.ok) {
      expect(full.diagnostics.some((d) => d.code === 'compile.value.unknownInput')).toBe(true)
      expect(full.diagnostics.some((d) => d.code === 'compile.value.assetSourceUnsupported')).toBe(true)
    }
  })

  it('keeps a disconnected DynamicSlot choice inert: no slotVariants, no error', () => {
    const result = dynCompile(dynDoc({
      nodes: { target: { type: 'SpecializedSlot', dynamic: { slot: { selected: 'selected' } } } },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({ class_type: 'SpecializedSlot', inputs: {}, outputIds: [] })
  })

  it('autogrow members: links resolve by member identity, prompt keys are positional wire names', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          a: { type: 'ImageSrc' },
          b: { type: 'ImageSrc' },
          g: { type: 'Batcher', dynamic: { images: { members: ['m0', 'm1'] } } },
        },
        links: [
          [['a', 'out'], ['g', 'images.image', ['m0']]],
          [['b', 'out'], ['g', 'images.image', ['m1']]],
        ],
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['g']!.inputs).toEqual({
      'images.image0': ['a', 0],
      'images.image1': ['b', 0],
    })
    expect(result.artifact.provenance.inputSources?.['g']).toEqual({
      'images.image0': { node: 'g', port: 'images.image', members: ['m0'] },
      'images.image1': { node: 'g', port: 'images.image', members: ['m1'] },
    })
  })

  it('member values compile under wire names; unset persisted members take the template default; ghosts never compile', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          g: {
            type: 'Weigher',
            values: { 'weights.w#m0': 2 },
            dynamic: { weights: { members: ['m0', 'm1'] } },
          },
        },
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    // Exactly the two persisted members: the trailing ghost has no apiName.
    expect(result.artifact.prompt['g']!.inputs).toEqual({ 'weights.w0': 2, 'weights.w1': 0.5 })
    expect(result.artifact.diagnostics).toEqual([])
  })

  it('member reordering follows identity, not position', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          g: {
            type: 'Weigher',
            values: { 'weights.w#m0': 1, 'weights.w#m1': 2 },
            dynamic: { weights: { members: ['m1', 'm0'] } }, // m1 now first
          },
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['g']!.inputs).toEqual({ 'weights.w0': 2, 'weights.w1': 1 })
  })

  it('dynamic output families: link indexes count non-ghost elaborated outputs', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          s: { type: 'Splitter', dynamic: { outs: { members: ['a', 'b'] } } },
          k0: { type: 'Sink' },
          k1: { type: 'Sink' },
        },
        links: [
          [['s', 'outs.o', ['b']], ['k0', 'in']],
          [['s', 'last'], ['k1', 'in']],
        ],
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['s']).toEqual({
      class_type: 'Splitter',
      inputs: {},
      outputIds: ['outs.o#a', 'outs.o#b', 'last'],
      outputMembers: { outs: ['a', 'b'] },
    })
    expect(result.artifact.prompt['k0']!.inputs).toEqual({ in: ['s', 1] })
    // 'last' sits after members a(0), b(1); the ghost is skipped in wiring.
    expect(result.artifact.prompt['k1']!.inputs).toEqual({ in: ['s', 2] })
  })

  it('count-bound output families compile canonical members and link member 1', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        s: { type: 'CountSplitter', values: { count: 3 } },
        k: { type: 'Sink' },
      },
      links: [[['s', 'images', ['1']], ['k', 'in']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.s).toEqual({
      class_type: 'CountSplitter',
      inputs: { count: 3 },
      outputIds: ['images.0', 'images.1', 'images.2'],
      outputMembers: { images: ['0', '1', '2'] },
    })
    expect(result.artifact.prompt.k!.inputs).toEqual({ in: ['s', 1] })
    const restored = dynCompile(loadDocument(JSON.parse(JSON.stringify(result.artifact.snapshot))).document!)
    expect(restored.ok).toBe(true)
    if (restored.ok) expect(restored.artifact.prompt).toEqual(result.artifact.prompt)
  })

  it('rejects a linked output count even when the node retains a stored literal', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        splitter: { type: 'CountSplitter', values: { count: 2 } },
      },
      links: [[['source', 'out'], ['splitter', 'count']]],
    }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        code: 'elab.outputFamily.linkedCount',
        severity: 'error',
      }))
    }
  })

  it('keeps static output positions around families that share one count input', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'CountMultiSplitter', values: { count: 2 } },
        before: { type: 'Sink' },
        image: { type: 'Sink' },
        after: { type: 'Sink' },
        mask: { type: 'Sink' },
      },
      links: [
        [['source', 'before'], ['before', 'in']],
        [['source', 'images', ['1']], ['image', 'in']],
        [['source', 'after'], ['after', 'in']],
        [['source', 'masks', ['0']], ['mask', 'in']],
      ],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.source?.outputMembers).toEqual({
      images: ['0', '1'],
      masks: ['0', '1'],
    })
    expect(result.artifact.prompt.before?.inputs.in).toEqual(['source', 0])
    expect(result.artifact.prompt.image?.inputs.in).toEqual(['source', 2])
    expect(result.artifact.prompt.after?.inputs.in).toEqual(['source', 3])
    expect(result.artifact.prompt.mask?.inputs.in).toEqual(['source', 4])
  })

  it('combo: selector compiles from dynamic state, active branch values keep branch-local identity, dormant values never warn', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          m: {
            type: 'Modal',
            values: {
              'mode.[advanced].strength': 0.7,
              'mode.[simple].strength': 0.3, // dormant: preserved, not compiled, no warning
            },
            dynamic: { mode: { selected: 'advanced' } },
          },
        },
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['m']!.inputs).toEqual({
      mode: 'advanced',
      'mode.strength': 0.7,
      'mode.bias': 0, // branch widget default
    })
    expect(result.artifact.diagnostics).toEqual([])
  })

  it('boundary items bind individual family members through subgraphs', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          a: { type: 'ImageSrc' },
          s0: { type: '#sub' },
        },
        links: [[['a', 'out'], ['s0', 'first']]],
        subgraphs: {
          sub: {
            nodes: { b: { type: 'Batcher', dynamic: { images: { members: ['m0'] } } } },
            boundary: {
              inputs: [{ id: 'first', binds: { kind: 'port', node: 'b', port: 'images.image', members: ['m0'] } }],
            },
          },
        },
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['s0.b']!.inputs).toEqual({ 'images.image0': ['a', 0] })
  })
})

// ---------------------------------------------------------------------------
// Wireability, synthetic members, duplicates, and muted endpoints.
// ---------------------------------------------------------------------------

describe('dynamic wireability and interface integrity', () => {

  it('duplicate elaborated input ids/wire names are compile errors, not overwrites', () => {
    const result = dynCompile(dynDoc({ nodes: { d: { type: 'DupIn' } } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    const codes = result.diagnostics.map((d) => d.code)
    expect(codes).toContain('compile.interface.duplicatePort')
    expect(codes).toContain('compile.interface.duplicateApiName')
  })

  it('static input ids containing #/% compile stored raw-keyed values', () => {
    const result = dynCompile(
      dynDoc({ nodes: { o: { type: 'Odd', values: { 'a#b': 1, 'c%d': 2 } } } }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    // Wire names are the RAW schema ids; neither value warns nor drops.
    expect(result.artifact.prompt['o']!.inputs).toEqual({ 'a#b': 1, 'c%d': 2 })
    expect(result.artifact.diagnostics.some((d) => d.code === 'compile.value.unknownInput')).toBe(false)
  })

})

describe('muted endpoints skip port validation', () => {
  const droppedOnly = (result: ReturnType<typeof dynCompile>): void => {
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const codes = result.artifact.diagnostics.map((d) => d.code)
    expect(codes).toContain('compile.link.dropped')
    // The consumer's required input legitimately goes unfilled once the link
    // is dropped - but NO schema/port validation error may surface.
    const allowed = new Set(['compile.link.dropped', 'compile.input.missing'])
    expect(codes.filter((c) => c.startsWith('compile.') && !allowed.has(c))).toEqual([])
  }

  it('a muted producer of an UNKNOWN type only drops the link', () => {
    droppedOnly(
      dynCompile(
        dynDoc({
          nodes: { u: { type: 'NoSuchType', mode: 'muted' }, k: { type: 'Sink' } },
          links: [[['u', 'out'], ['k', 'in']]],
        }),
      ),
    )
  })

})

describe('unresolved nodes outside the executed scope', () => {
  const unknownDiags = (diagnostics: readonly { code: string; severity: string }[]) =>
    diagnostics.filter((diagnostic) => diagnostic.code === 'compile.schema.unknown')

  it('a disconnected unresolved node does not block a full compile and stays out of the prompt', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        src: { type: 'ImageSrc' },
        sink: { type: 'Sink' },
        ghost: { type: 'NotARealNode' },
      },
      links: [[['src', 'out'], ['sink', 'in']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['sink', 'src'])
    const unknown = unknownDiags(result.artifact.diagnostics)
    expect(unknown).toHaveLength(1)
    expect(unknown[0]!.severity).toBe('warning')
  })

  it('partial execution of a valid selection succeeds while an unresolved node exists elsewhere', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        src: { type: 'ImageSrc' },
        sink: { type: 'Sink' },
        ghost: { type: 'NotARealNode' },
        orphan: { type: 'NonOutputSink' },
      },
      links: [
        [['src', 'out'], ['sink', 'in']],
        [['ghost', 'out'], ['orphan', 'in']],
      ],
    }), { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('sink') }] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['sink', 'src'])
    const unknown = unknownDiags(result.artifact.diagnostics)
    expect(unknown.length).toBeGreaterThan(0)
    for (const diagnostic of unknown) expect(diagnostic.severity).toBe('warning')
  })

  it('still fails a full compile when the unresolved node feeds an output node', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        ghost: { type: 'NotARealNode' },
        sink: { type: 'Sink' },
      },
      links: [[['ghost', 'out'], ['sink', 'in']]],
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(unknownDiags(result.diagnostics).some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
  })

  it('still fails partial execution when the unresolved node feeds the executed scope', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        src: { type: 'ImageSrc' },
        ghost: { type: 'NotARealNode' },
        sink: { type: 'Sink' },
      },
      links: [
        [['ghost', 'out'], ['sink', 'in']],
      ],
    }), { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('sink') }] })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(unknownDiags(result.diagnostics).some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
  })

})
