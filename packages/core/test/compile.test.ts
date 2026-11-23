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
import type { Diagnostic } from '../src/diagnostics.js'
import { loadDocument } from '../src/format/migrate.js'
import { asConnectionId, asNodeId } from '../src/ids.js'
import { historicalSchemas as schemas } from './fixtures/historical-schemas.js'
import { parseDinksterSchema, type DinksterWireSchema } from '../src/schema/dinkster-wire.js'
import { DINKSTER_GRAPH_FEATURE_DECIMAL_INT } from '../src/compile/dinkster-graph.js'
import { coreVirtualNodeKind } from '../src/virtual-node.js'
import { coreCommandRegistry } from '../src/commands/core-commands.js'
import { DocumentStore } from '../src/commands/store.js'

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
  it('preserves a host refusal and anchors the unavailable node before submit', () => {
    const reason = "Pack 'example' requires a writable mount that was not granted."
    const resolve: CompileInput['resolve'] = (type) => {
      const schema = backendResolve(type)
      return schema === undefined ? undefined : {
        ...schema,
        ...(type === 'CLIPTextEncode' ? { unavailableReason: reason } : {}),
      }
    }
    const result = compile({ ...compileInput(loadWorkflow('minimal'), { kind: 'full' }, resolve), graphFeatures: ['regions', 'typedLiteral'] })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const problem = result.diagnostics.find((diagnostic) => diagnostic.code === 'dinksterGraph.nodeUnavailable')
      expect(problem?.message).toBe(reason)
      expect(problem?.anchor?.occurrence?.node).toBe('n1')
    }
  })
  it.each([false, true])('checks resident process affinity before submit (shared=%s)', (shared) => {
    const document = loadWorkflow('minimal')
    const resolve: CompileInput['resolve'] = (type) => {
      const schema = backendResolve(type)
      if (!schema) return undefined
      return {
        ...schema,
        residentAffinity: {
          types: ['MODEL', 'CLIP', 'VAE', 'CONDITIONING'],
          routes: [{ process: shared || type === 'CheckpointLoaderSimple' ? 'shared' : 'isolated',
            pack: type === 'CheckpointLoaderSimple' ? 'models' : 'conditioning', worker: 'local' }],
        },
      }
    }
    const result = compile({ ...compileInput(document, { kind: 'full' }, resolve), graphFeatures: ['regions', 'typedLiteral'] })
    expect(result.ok).toBe(shared)
    if (!result.ok) {
      const problem = result.diagnostics.find((diagnostic) => diagnostic.code === 'dinksterGraph.residentProcessBoundary')
      expect(problem?.message).toBe("Pack 'conditioning' cannot receive a resident value from pack 'models' in another process; admit the pack to the shared inference process or use the owner's node through an engine-run node on a reference.")
      expect(problem?.anchor?.occurrence?.node).toBe('n1')
      expect(problem?.anchor?.port?.port).toBe('clip')
    }
  })
  it.each([false, true])('honors explicit producer placement instead of an unused compatible route (placed=%s)', (placed) => {
    const resolve: CompileInput['resolve'] = (type) => {
      const schema = backendResolve(type)
      if (!schema) return undefined
      return { ...schema, residentAffinity: {
        types: ['MODEL', 'CLIP', 'VAE', 'CONDITIONING'],
        routes: type === 'CheckpointLoaderSimple' ? [
          { process: 'isolated', pack: 'models', worker: 'local' },
          { process: 'shared', pack: 'models', worker: 'remote', unplaced: false },
        ] : [{ process: 'shared', pack: 'conditioning', worker: 'local' }],
      } }
    }
    const result = compile({ ...compileInput(loadWorkflow('minimal'), { kind: 'full' }, resolve),
      graphFeatures: ['regions', 'typedLiteral'], ...(placed ? { placement: { n0: 'remote' } } : {}),
    })
    expect(result.ok).toBe(placed)
    if (!result.ok) expect(result.diagnostics.some((problem) => problem.code === 'dinksterGraph.residentProcessBoundary')).toBe(true)
  })
  it.each([25, 29.97, undefined])('stamps numeric-union widget value %s without changing concrete numerics', (value) => {
    const schema = parseDinksterSchema('Numeric', {
      schemaVersion: 2,
      nodeType: 'Numeric',
      outputNode: true,
      body: [
        { kind: 'input', id: 'frame_rate', type: { kind: 'union', types: ['FLOAT', 'INT'] }, required: true, default: 23.976, widget: { type: 'NUMBER', step: 0.01 } },
        { kind: 'input', id: 'count', type: { kind: 'concrete', types: ['INT'] }, required: true, widget: { type: 'NUMBER', min: 0 } },
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

  it('refuses a run on a failed rule without a fix, runs with a warning when it has one, and names the node and its one field', () => {
    const schemaWith = (fix: unknown[]) => parseDinksterSchema('Ruled', {
      schemaVersion: 2,
      nodeType: 'Ruled',
      outputNode: true,
      body: [
        { kind: 'input', id: 'w', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 3, widget: { type: 'NUMBER', min: 0 } },
        { kind: 'input', id: 'h', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 3, widget: { type: 'NUMBER', min: 0 } },
      ],
      validate: [
        { check: { formula: 'w <= 6' }, message: 'Width must be 6 or less', fix },
        { check: { formula: 'w + h <= 10' }, message: 'Too big', fix },
      ],
    } as never).schema!
    const base = loadWorkflow('minimal')
    const document: WorkflowDocument = { ...base, graphs: { [base.root]: {
      ...base.graphs[base.root]!, links: {}, nodes: { n0: { id: asNodeId('n0'), type: 'Ruled', values: { w: 7, h: 4 } } },
    } } }
    const rules = (diagnostics: readonly Diagnostic[]) => diagnostics.filter((item) => item.code === 'node.rule.failed')
      .map((item) => [item.severity, item.refs, item.data])

    const refused = compile(compileInput(document, { kind: 'full' }, () => schemaWith([])))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(rules(refused.diagnostics)).toEqual([
      ['error', [{ graphId: base.root, nodeId: 'n0', portId: 'w', valueKey: 'w', direction: 'input' }], { rule: 0, hasFix: false, fields: ['w'] }],
      ['error', [{ graphId: base.root, nodeId: 'n0' }], { rule: 1, hasFix: false, fields: ['w', 'h'] }],
    ])
    const warned = compile(compileInput(document, { kind: 'full' }, () => schemaWith([{ step: 'Set', row: 'w', value: { value: 6 } }])))
    expect(warned.ok).toBe(true)
    if (warned.ok) expect(rules(warned.artifact.diagnostics).map(([severity]) => severity)).toEqual(['warning', 'warning'])
  })

  it('requires explicit supported type stamps for nonconcrete additional literals', () => {
    const schema = parseDinksterSchema('Authored', {
      schemaVersion: 2, nodeType: 'Authored', outputNode: true, additionalInputs: { kind: 'wildcard' }, body: [],
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
      schemaVersion: 2,
      nodeType: 'Authored',
      outputNode: true,
      additionalInputs: { kind: 'concrete', types: ['INT'] },
      body: [{ kind: 'input', id: 'choice', type: { kind: 'concrete', types: ['COMBO'] }, widget: { type: 'COMBO', editableOptions: true, options: [] } }],
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
  it('loads saved values by input id after reordering and fills added inputs without changing the node id', () => {
    const base = loadWorkflow('minimal')
    const saved: WorkflowDocument = { ...base, graphs: { [base.root]: {
      ...base.graphs[base.root]!, links: {}, nodes: {
        n0: { id: asNodeId('n0'), type: 'Evolving', values: { width: 37, height: 91, mode: 'nearest' } },
      },
    } } }
    const loaded = loadDocument(JSON.parse(JSON.stringify(saved)))
    expect(loaded.document).toBeDefined()
    for (const expanded of [false, true]) {
      const schema = parseDinksterSchema('Evolving', {
        schemaVersion: 2,
        nodeType: 'Evolving',
        outputNode: true,
        body: [
          { kind: 'input', id: 'mode', type: { kind: 'concrete', types: ['COMBO'] }, required: true,
            default: 'linear', widget: { type: 'COMBO', options: expanded ? ['linear', 'cubic', 'nearest'] : ['linear', 'nearest'] } },
          { kind: 'input', id: 'height', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 512, widget: { type: 'NUMBER', min: 1 } },
          ...(expanded ? [{ kind: 'input', id: 'batch', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 3, widget: { type: 'NUMBER', min: 1 } }] : []),
          { kind: 'input', id: 'width', type: { kind: 'concrete', types: ['INT'] }, required: true, default: 512, widget: { type: 'NUMBER', min: 1 } },
        ],
      }).schema!
      expect(schema).toBeDefined()
      const result = compile(compileInput(loaded.document!, { kind: 'full' }, () => schema))
      expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
      if (!result.ok) throw new Error('saved additive workflow must compile')
      expect(result.artifact.prompt.n0!.class_type).toBe('Evolving')
      expect(result.artifact.prompt.n0!.inputs).toEqual({
        width: 37, height: 91, mode: 'nearest', ...(expanded ? { batch: 3 } : {}),
      })
    }
    expect(loaded.document!.graphs[base.root]!.nodes.n0!.values).toEqual({ width: 37, height: 91, mode: 'nearest' })
  })

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
// Dynamic interfaces (groups, choices and type choices in compile)
//
// The compiler resolves values and links by flattened id, submits each input
// under it, sends choice keys as slotVariants and member order as
// outputMembers, and wires outputs by non-ghost output index. These tests pin
// that contract with synthetic schemas (the object_info fixture is
// static-only).
// ---------------------------------------------------------------------------

import type { BodyRow, ChoiceSpec, GroupSpec, InputSpec, NodeSchema, OutputSpec, TypeExpr } from '../src/schema/model.js'

const IMAGE: TypeExpr = { kind: 'concrete', name: 'IMAGE' }
const INT: TypeExpr = { kind: 'concrete', name: 'INT' }
const dynInput = (id: string, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type: IMAGE,
  optional: false,
  ...extra,
})
const PICK = { kind: 'union', names: ['INT', 'BOOLEAN'] } as const
const BRANCHES = { branch: { members: ['on_false', 'on_true'] } }
const dynOutput = (id: string): OutputSpec => ({ kind: 'output', id, type: IMAGE })
const dynSchemaOf = (type: string, items: BodyRow[]): NodeSchema => ({
  type,
  displayName: type,
  category: 'test',
  source: 'v3',
  isOutputNode: true, // keeps every test node in full scope without sinks
  body: items,
})

const numbered = (prefix: string): GroupSpec['keys'] => ({ kind: 'numbered', prefix, start: 0, pad: 0 })
const group = (id: string, prefix: string, rows: Pick<GroupSpec, 'value' | 'member'>, extra: Partial<GroupSpec> = {}): GroupSpec => ({
  kind: 'group', id, ...rows, keys: numbered(prefix), grows: 'link', minMembers: 0, maxMembers: 4, ...extra,
})
const choice = (id: string, options: ChoiceSpec['options'], extra: Partial<ChoiceSpec> = {}): ChoiceSpec => ({
  kind: 'choice', id, options, shared: [], required: true, ...extra,
})

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
  // A group of pins: flattened ids images.image0, images.image1...
  Batcher: dynSchemaOf('Batcher', [
    group('images', 'image', { value: dynInput('image') }, { minMembers: 1, maxMembers: 2 }),
    dynOutput('out'),
  ]),
  // A group of fields: member values live under their flattened ids.
  Weigher: dynSchemaOf('Weigher', [
    group('weights', 'w', { value: dynInput('w', { widget: { widgetType: 'FLOAT', options: {}, default: 0.5 } }) }, { grows: 'filled' }),
  ]),
  NamedRoute: dynSchemaOf('NamedRoute', [
    group('values', 'value', { value: dynInput('value', { optional: true }) }),
    dynOutput('out'),
  ]),
  // A group of outputs followed by a static output (index arithmetic).
  Splitter: dynSchemaOf('Splitter', [
    group('outs', 'o', { value: dynOutput('o') }),
    dynOutput('last'),
  ]),
  CountSplitter: dynSchemaOf('CountSplitter', [
    dynInput('count', {
      type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: {}, default: 0 },
    }),
    group('images', '', { value: dynOutput('image') }, { grows: { count: 'count' } }),
  ]),
  CountMultiSplitter: dynSchemaOf('CountMultiSplitter', [
    dynInput('count', {
      type: { kind: 'concrete', name: 'INT' },
      widget: { widgetType: 'INT', options: {}, default: 0 },
    }),
    dynOutput('before'),
    group('images', '', { value: dynOutput('image') }, { grows: { count: 'count' } }),
    dynOutput('after'),
    group('masks', '', { value: dynOutput('mask') }, { grows: { count: 'count' } }),
  ]),
  // Schema-level id collisions: the compiler must reject, never overwrite.
  DupIn: dynSchemaOf('DupIn', [dynInput('x'), dynInput('x')]),
  DupOut: dynSchemaOf('DupOut', [dynOutput('y'), dynOutput('y')]),
  // Static ids containing '#'/'%': the document keys values by the raw id.
  Odd: dynSchemaOf('Odd', [
    dynInput('a#b', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
    dynInput('c%d', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
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
  // A choice: its key is stored state; option rows flatten as mode.<row>.
  Modal: dynSchemaOf('Modal', [
    choice('mode', [
      { key: 'simple', rows: [dynInput('strength', { widget: { widgetType: 'FLOAT', options: {}, default: 1 } })] },
      {
        key: 'advanced',
        rows: [
          dynInput('strength', { widget: { widgetType: 'FLOAT', options: {}, default: 1 } }),
          dynInput('bias', { widget: { widgetType: 'FLOAT', options: {}, default: 0 } }),
        ],
      },
    ]),
  ]),
  SpecializedSlot: dynSchemaOf('SpecializedSlot', [{
    kind: 'typeChoice',
    id: 'slot',
    variants: [
      { key: 'selected', type: IMAGE, rows: [dynInput('x', { widget: { widgetType: 'FLOAT', options: {}, default: 1 } })] },
      { key: 'other', type: IMAGE, rows: [dynInput('x', { widget: { widgetType: 'FLOAT', options: {}, default: 2 } })] },
      { key: 'empty', type: IMAGE, rows: [] },
    ],
    rows: [],
    required: false,
  }]),
  ItemGroup: dynSchemaOf('ItemGroup', [group('items', 'item', { value: dynInput('value', { optional: true }) })]),
  OrderedGroup: dynSchemaOf('OrderedGroup', [group('items', 'item', { value: dynInput('value', { optional: true }) }, { reorderable: true })]),
  NamedGroup: dynSchemaOf('NamedGroup', [{
    kind: 'group', id: 'args', value: dynInput('value'), keys: { kind: 'named', names: ['a', 'b'] }, grows: 'link', minMembers: 1,
  }]),
  RecordGroup: dynSchemaOf('RecordGroup', [
    group('pairs', 'pair', { member: [dynInput('left', { optional: true }), dynInput('right', { optional: true })] }, { maxMembers: 3 }),
  ]),
  ChoiceGroup: dynSchemaOf('ChoiceGroup', [
    group('items', 'item', { member: [choice('mode', [
      { key: 'a', rows: [dynInput('amount', { optional: true })] },
      { key: 'b', rows: [] },
    ])] }, { maxMembers: 3 }),
  ]),
  NestedChoice: dynSchemaOf('NestedChoice', [
    choice('mode', [
      { key: 'none', rows: [] },
      { key: 'batch', rows: [
        group('frames', 'frame', { value: dynInput('value', { optional: true }) }),
        choice('quality', [
          { key: 'draft', rows: [] },
          { key: 'full', rows: [dynInput('steps', { optional: true })] },
        ]),
      ] },
    ]),
  ]),
  PunctuationChoice: dynSchemaOf('PunctuationChoice', [
    choice('mode', [
      { key: 'Flux.2 [pro]', rows: [dynInput('scale', { optional: true })] },
      { key: 'Flux.2 [max]', rows: [] },
    ], { default: 'Flux.2 [pro]' }),
  ]),
  NonFirstDefaultChoice: dynSchemaOf('NonFirstDefaultChoice', [
    choice('mode', [
      { key: 'first', rows: [dynInput('scale', { optional: true })] },
      { key: 'descriptor default', rows: [] },
    ], { default: 'descriptor default' }),
  ]),
  OpenSlot: dynSchemaOf('OpenSlot', [{
    kind: 'typeChoice', id: 'model', type: IMAGE, rows: [dynInput('weight', { optional: true })], required: false,
  }]),
  LazySelector: {
    ...dynSchemaOf('LazySelector', [
      dynInput('switch', { type: PICK, optional: true }),
      { kind: 'group', id: 'branch', value: dynInput('value', { optional: true, lazy: true }), keys: { kind: 'named', names: ['on_false', 'on_true'] }, grows: 'button', minMembers: 1 },
      dynOutput('result'),
    ]),
    selector: { input: 'switch', group: 'branch' },
  },
  Primitive: {
    ...dynSchemaOf('Primitive', [
      dynInput('value', { type: INT, widget: { widgetType: 'INT', options: {}, default: 0, controller: 'after_generate' } }),
      { kind: 'output', id: 'INT', type: INT, knownValue: { input: 'value' } },
    ]),
    isOutputNode: false,
  },
  VarPrimitive: {
    ...dynSchemaOf('VarPrimitive', [
      dynInput('value', { type: { kind: 'variable', templateId: 'T' } }),
      { kind: 'output', id: 'out', type: { kind: 'variable', templateId: 'T' }, knownValue: { input: 'value' } },
    ]),
    isOutputNode: false,
  },
  Choice: {
    ...dynSchemaOf('Choice', [
      dynInput('value', { type: { kind: 'concrete', name: 'COMBO' }, widget: { widgetType: 'COMBO', options: { options: ['euler', 'dpm'] } } }),
      { kind: 'output', id: 'COMBO', type: { kind: 'concrete', name: 'COMBO' }, knownValue: { input: 'value' } },
    ]),
    isOutputNode: false,
  },
  SamplerSink: dynSchemaOf('SamplerSink', [dynInput('sampler', { type: { kind: 'concrete', name: 'COMBO' }, widget: { widgetType: 'COMBO', options: { options: ['euler', 'dpm'] } } })]),
  IntSrc: { ...dynSchemaOf('IntSrc', [{ kind: 'output', id: 'out', type: INT }]), isOutputNode: false },
  IntSink: dynSchemaOf('IntSink', [dynInput('steps', { type: INT, widget: { widgetType: 'INT', options: {}, default: 20 } })]),
  Switch: {
    ...dynSchemaOf('Switch', [
      dynInput('pick', { type: PICK, optional: true }),
      { kind: 'group', id: 'branch', value: dynInput('value', { optional: true, lazy: true }), keys: { kind: 'named', names: ['a', 'b', 'c'] }, grows: 'button', minMembers: 1 },
      dynOutput('result'),
    ]),
    selector: { input: 'pick', group: 'branch' },
  },
  ModeSwitch: {
    ...dynSchemaOf('ModeSwitch', [
      dynInput('pick', { type: PICK, optional: true, widget: { widgetType: 'COMBO', options: {}, controller: 'after_generate', controllerInitial: 'fixed' } }),
      { kind: 'group', id: 'branch', value: dynInput('value', { optional: true, lazy: true }), keys: { kind: 'named', names: ['a', 'b'] }, grows: 'button', minMembers: 1 },
      dynOutput('result'),
    ]),
    selector: { input: 'pick', group: 'branch' },
  },
  'comfy.ResizeImageMaskNode': parseDinksterSchema(
    'comfy.ResizeImageMaskNode',
    { ...readJson('fixtures/dinkster-resize-image-mask-wire16.json') as DinksterWireSchema, schemaVersion: 2 },
  ).schema!,
}
const dynResolve = (type: string) => dynSchemas[type]

type DynNode = {
  type: string
  values?: Record<string, unknown>
  dynamic?: Record<string, unknown>
  controllers?: Record<string, string>
  mode?: 'active' | 'muted' | 'bypassed'
}
type DynEnd =
  | [node: string, port: string]
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
    ? { node: e[0], port: e[1] }
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
        { id: nid, type: n.type, values: n.values ?? {}, ...(n.dynamic ? { dynamic: n.dynamic } : {}), ...(n.controllers ? { controllers: n.controllers } : {}), ...(n.mode ? { mode: n.mode } : {}) },
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
  it('keeps member labels out of execution while submitting the member key', () => {
    const document = dynDoc({ nodes: { route: {
      type: 'NamedRoute',
      values: { 'values.value7': 4 },
      dynamic: { values: { members: ['value7'], memberLabels: { value7: 'Background' } } },
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
            route: { ...document.graphs.g0!.nodes.route!, dynamic: { values: { members: ['value7'] } } },
          },
        },
      },
    })

    expect(labeled.ok, JSON.stringify(!labeled.ok && labeled.diagnostics)).toBe(true)
    expect(unlabeled.ok, JSON.stringify(!unlabeled.ok && unlabeled.diagnostics)).toBe(true)
    if (!labeled.ok || !unlabeled.ok) return
    expect(labeled.artifact.prompt.route?.inputs).toEqual({ 'values.value7': 4 })
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
        selector: { type: 'LazySelector', values: { switch: false }, dynamic: BRANCHES },
      },
      links: [
        [['decisionSource', 'out'], ['selector', 'switch']],
        [['falseSource', 'out'], ['selector', 'branch.on_false']],
        [['trueSource', 'out'], ['selector', 'branch.on_true']],
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
        outputMembers: { branch: ['on_false', 'on_true'] },
        inputs: {
          switch: ['decisionSource', 0],
          'branch.on_false': ['falseSource', 0],
          'branch.on_true': ['trueSource', 0],
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
        selector: { type: 'LazySelector', values: { switch: true }, dynamic: BRANCHES },
      },
      links: [
        [['falseSource', 'out'], ['selector', 'branch.on_false']],
        [['trueSource', 'out'], ['selector', 'branch.on_true']],
      ],
    }))
    expect(valued.ok, JSON.stringify(!valued.ok && valued.diagnostics)).toBe(true)
    if (valued.ok) {
      expect(valued.artifact.prompt.selector?.inputs.switch).toBe(true)
      expect(valued.artifact.prompt.selector?.inputs['branch.on_false']).toEqual(['falseSource', 0])
      expect(valued.artifact.prompt.selector?.inputs['branch.on_true']).toEqual(['trueSource', 0])
      expect(Object.keys(valued.artifact.prompt).sort()).toEqual(['falseSource', 'selector', 'trueSource'])
    }
  })

  it('projects a stored lazy-switch choice without changing exact prompt bytes', () => {
    const doc = dynDoc({
      nodes: {
        falseSource: { type: 'ImageSrc' },
        trueSource: { type: 'ImageSrc' },
        selector: { type: 'LazySelector', values: { switch: true }, dynamic: BRANCHES },
      },
      links: [
        [['falseSource', 'out'], ['selector', 'branch.on_false']],
        [['trueSource', 'out'], ['selector', 'branch.on_true']],
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
      'branch.on_false': ['falseSource', 0],
      'branch.on_true': ['trueSource', 0],
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
  ] as const)('composes lazy choice %s with bypass on either branch, net, reroute, and a group member destination', (choice, liveSource, dimmedSource, reroutes) => {
    const doc = dynDoc({
      nodes: {
        inactiveSource: { type: 'ImageSrc' },
        selectedSource: { type: 'ImageSrc' },
        bypass: { type: 'Passthrough', mode: 'bypassed' },
        selector: { type: 'LazySelector', values: { switch: choice }, dynamic: BRANCHES },
        target: { type: 'ItemGroup', dynamic: { items: { members: ['item0'] } } },
      },
      reroutes: ['selected-route'],
      nets: [['inactive-feed', ['inactiveSource', 'out'], [['bypass', 'in']]]],
      links: [
        [['bypass', 'out'], ['selector', 'branch.on_false']],
        [['selectedSource', 'out'], { reroute: 'selected-route' }],
        [{ reroute: 'selected-route' }, ['selector', 'branch.on_true']],
        [['selector', 'result'], ['target', 'items.item0']],
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
            selector: { type: 'LazySelector', values: { switch: true }, dynamic: BRANCHES },
          },
          links: [
            [['falseSource', 'out'], ['selector', 'branch.on_false']],
            [['trueSource', 'out'], ['selector', 'branch.on_true']],
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

  it('uses occurrence-promoted picks and keeps a promoted pick outside the branches neutral', () => {
    const doc = dynDoc({
      nodes: {
        decided: { type: '#branch', values: { decision: false } },
        neutral: { type: '#branch', values: { decision: 2 } },
      },
      subgraphs: {
        branch: {
          nodes: {
            falseSource: { type: 'ImageSrc' },
            trueSource: { type: 'ImageSrc' },
            selector: { type: 'LazySelector', values: { switch: true }, dynamic: BRANCHES },
          },
          links: [
            [['falseSource', 'out'], ['selector', 'branch.on_false']],
            [['trueSource', 'out'], ['selector', 'branch.on_true']],
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
        inner: { type: 'LazySelector', values: { switch: false }, dynamic: BRANCHES },
        outer: { type: 'LazySelector', values: { switch: true }, dynamic: BRANCHES },
      },
      links: [
        [['innerOn', 'out'], ['inner', 'branch.on_false']],
        [['innerOff', 'out'], ['inner', 'branch.on_true']],
        [['outerOff', 'out'], ['outer', 'branch.on_false']],
        [['inner', 'result'], ['outer', 'branch.on_true']],
      ],
    })
    const scope: ExecutionScope = { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('outer') }] }
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual(['inner', 'innerOn', 'outer'])
    expect([...closure.inactiveExclusive.get('outer') ?? []]).toEqual(['outerOff'])
    expect([...closure.inactiveExclusive.get('inner') ?? []]).toEqual(['innerOff'])
  })

  it.each([
    ['out-of-range', { switch: 2 }],
    ['fractional', { switch: 0.5 }],
  ])('keeps %s lazy-switch state neutral', (_name, values) => {
    const doc = dynDoc({
      nodes: {
        falseSource: { type: 'ImageSrc' },
        trueSource: { type: 'ImageSrc' },
        selector: { type: 'LazySelector', values, dynamic: BRANCHES },
      },
      links: [
        [['falseSource', 'out'], ['selector', 'branch.on_false']],
        [['trueSource', 'out'], ['selector', 'branch.on_true']],
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

  it.each([
    ['a stored key by id, not position', 'a', 'sourceA', ['sourceB', 'sourceC']],
    ['a removed key as the first member', 'gone', 'sourceC', ['sourceA', 'sourceB']],
    ['no pick as the first member', undefined, 'sourceC', ['sourceA', 'sourceB']],
    ['a position in stored order', 2, 'sourceB', ['sourceA', 'sourceC']],
  ] as const)('projects %s among three branches', (_name, pick, live, dimmed) => {
    const doc = dynDoc({
      nodes: {
        sourceA: { type: 'ImageSrc' },
        sourceB: { type: 'ImageSrc' },
        sourceC: { type: 'ImageSrc' },
        selector: {
          type: 'Switch',
          values: pick === undefined ? {} : { pick },
          dynamic: { branch: { members: ['c', 'a', 'b'] } },
        },
      },
      links: [
        [['sourceA', 'out'], ['selector', 'branch.a']],
        [['sourceB', 'out'], ['selector', 'branch.b']],
        [['sourceC', 'out'], ['selector', 'branch.c']],
      ],
    })
    const scope: ExecutionScope = {
      kind: 'partial',
      targets: [{ instancePath: [], node: asNodeId('selector') }],
    }
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual([live, 'selector'].sort())
    expect([...closure.inactiveExclusive.get('selector') ?? []].sort()).toEqual(dimmed)
  })

  it('rewires a group member destination after its producer becomes bypassed', () => {
    const clean = dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        modeNode: { type: 'Passthrough' },
        target: { type: 'ItemGroup', dynamic: { items: { members: ['item0'] } } },
      },
      links: [[['source', 'out'], ['modeNode', 'in']], [['modeNode', 'out'], ['target', 'items.item0']]],
    })
    const before = dynCompile(clean)
    expect(before.ok, JSON.stringify(!before.ok && before.diagnostics)).toBe(true)
    if (before.ok) expect(before.artifact.prompt['target']!.inputs).toEqual({ 'items.item0': ['modeNode', 0] })
    const changed = structuredClone(clean) as unknown as Mutable
    const graphs = changed['graphs'] as Mutable
    const root = graphs['g0'] as Mutable
    const nodes = root['nodes'] as Mutable
    ;(nodes['modeNode'] as Mutable)['mode'] = 'bypassed'
    const after = dynCompile(changed as unknown as WorkflowDocument)
    expect(after.ok, JSON.stringify(!after.ok && after.diagnostics)).toBe(true)
    if (after.ok) {
      expect(after.artifact.prompt['target']!.inputs).toEqual({ 'items.item0': ['source', 0] })
      expect(Object.keys(after.artifact.prompt)).not.toContain('modeNode')
    }
  })

  it('lowers group member values at their flattened ids', () => {
    const result = dynCompile(dynDoc({
      nodes: { target: { type: 'ItemGroup', values: { 'items.item0': 7 }, dynamic: { items: { members: ['item0'] } } } },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']!.inputs).toEqual({ 'items.item0': 7 })
    expect(result.artifact.prompt['target']!.outputMembers).toEqual({ items: ['item0'] })
  })

  it('sends the member order a move leaves, with each value and wire still on its member', () => {
    const store = new DocumentStore(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        target: { type: 'OrderedGroup', values: { 'items.item0': 1, 'items.item2': 3 }, dynamic: { items: { members: ['item0', 'item1', 'item2'], seq: 3 } } },
      },
      links: [[['source', 'out'], ['target', 'items.item1']]],
    }), coreCommandRegistry(), 200, undefined, () => ({ kind: 'initial', schemaResolverFor: () => dynResolve }))
    expect(store.dispatch({ command: 'dynamic.moveMember', params: { graphId: 'g0', nodeId: 'target', construct: 'items', member: 'item2', index: 0 } }).ok).toBe(true)
    const result = dynCompile(store.doc)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']!.outputMembers).toEqual({ items: ['item2', 'item0', 'item1'] })
    expect(result.artifact.prompt['target']!.inputs).toEqual({ 'items.item0': 1, 'items.item1': ['source', 0], 'items.item2': 3 })
  })

  it('lowers named members by their names and enforces minimum membership', () => {
    const lowered = dynCompile(dynDoc({
      nodes: { target: { type: 'NamedGroup', values: { 'args.b': 9 }, dynamic: { args: { members: ['b'] } } } },
    }))
    expect(lowered.ok, JSON.stringify(!lowered.ok && lowered.diagnostics)).toBe(true)
    if (lowered.ok) expect(lowered.artifact.prompt['target']!.inputs).toEqual({ 'args.b': 9 })

    const missing = dynCompile(dynDoc({ nodes: { target: { type: 'NamedGroup' } } }))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain('elab.autogrow.underMin')
  })

  it('submits record member rows at <group>.<key>.<row>', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'RecordGroup',
      values: { 'pairs.pair0.left': 1, 'pairs.pair0.right': 2 },
      dynamic: { pairs: { members: ['pair0'] } },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']!.inputs).toEqual({
      'pairs.pair0.left': 1,
      'pairs.pair0.right': 2,
    })
  })

  it('carries the choices of group members as slotVariants under their flattened ids', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'ChoiceGroup',
      values: { 'items.item0.mode.amount': 5 },
      dynamic: {
        items: { members: ['item0', 'item1'] },
        'items.item0.mode': { selected: 'a' },
        'items.item1.mode': { selected: 'b' },
      },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.target).toEqual({
      class_type: 'ChoiceGroup',
      outputIds: [],
      inputs: { 'items.item0.mode.amount': 5 },
      outputMembers: { items: ['item0', 'item1'] },
      slotVariants: {
        'items.item0.mode': 'a',
        'items.item1.mode': 'b',
      },
    })
  })

  it('lowers nested choices and only the rows of chosen options', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'NestedChoice',
      values: { 'mode.frames.frame0': 1, 'mode.quality.steps': 2 },
      dynamic: {
        mode: { selected: 'batch' },
        'mode.frames': { members: ['frame0'] },
        'mode.quality': { selected: 'full' },
      },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({
      class_type: 'NestedChoice',
      outputIds: [],
      inputs: {
        'mode.frames.frame0': 1,
        'mode.quality.steps': 2,
      },
      outputMembers: { 'mode.frames': ['frame0'] },
      slotVariants: { mode: 'batch', 'mode.quality': 'full' },
    })
  })

  it('rejects a required nested choice with nothing stored instead of deriving the first option', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'NestedChoice',
      dynamic: { mode: { selected: 'batch' }, 'mode.frames': { members: [] } },
    } } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      message: expect.stringContaining("required choice 'mode.quality' has no stored option"),
    }))
  })

  it('carries the Flux.2 [pro] option key verbatim and lowers its rows', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'PunctuationChoice',
      values: { 'mode.scale': 2 },
      dynamic: { mode: { selected: 'Flux.2 [pro]' } },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']!.inputs).toEqual({ 'mode.scale': 2 })
    expect(result.artifact.prompt['target']!.slotVariants).toEqual({ mode: 'Flux.2 [pro]' })
  })

  it('submits the start option when a stored choice names an option the pack no longer has', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'NestedChoice',
      dynamic: { mode: { selected: 'gone' } },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.target).toEqual({
      class_type: 'NestedChoice', inputs: {}, slotVariants: { mode: 'none' }, outputIds: [],
    })
  })

  it('submits an explicitly stored first option rather than the declared default', () => {
    const result = dynCompile(dynDoc({ nodes: { target: {
      type: 'NonFirstDefaultChoice',
      values: { 'mode.scale': 3 },
      dynamic: { mode: { selected: 'first' } },
    } } }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['target']).toEqual({
      class_type: 'NonFirstDefaultChoice',
      outputIds: [],
      inputs: { 'mode.scale': 3 },
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
          excluded: { type: 'PunctuationChoice' },
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
      type: 'OpenSlot', values: { model: 'value', 'model.weight': 0.5 },
    } } }))
    expect(valued.ok, JSON.stringify(!valued.ok && valued.diagnostics)).toBe(true)
    if (valued.ok) expect(valued.artifact.prompt['target']!.inputs).toEqual({ model: 'value', 'model.weight': 0.5 })

    const linked = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, target: { type: 'OpenSlot', values: { 'model.weight': 0.75 } } },
      links: [[['source', 'out'], ['target', 'model']]],
    }))
    expect(linked.ok, JSON.stringify(!linked.ok && linked.diagnostics)).toBe(true)
    if (linked.ok) expect(linked.artifact.prompt['target']!.inputs).toEqual({ model: ['source', 0], 'model.weight': 0.75 })

    // A dependent's value is kept while the slot is inactive, never compiled and never warned about.
    const inactive = dynCompile(dynDoc({ nodes: { target: { type: 'OpenSlot', values: { 'model.weight': 0.5 } } } }))
    expect(inactive.ok, JSON.stringify(!inactive.ok && inactive.diagnostics)).toBe(true)
    if (inactive.ok) {
      expect(inactive.artifact.prompt['target']!.inputs).toEqual({})
      expect(inactive.artifact.diagnostics.map((diagnostic) => diagnostic.code)).not.toContain('compile.value.unknownInput')
    }

    const absent = dynCompile(dynDoc({ nodes: { target: { type: 'OpenSlot' } } }))
    expect(absent.ok).toBe(true)
    if (absent.ok) expect(absent.artifact.prompt['target']!.inputs).toEqual({})
  })

  it('delivers into a group member through a reroute, a net, and a bypassed node', () => {
    const rerouted = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, target: { type: 'ItemGroup', dynamic: { items: { members: ['item0'] } } } },
      reroutes: ['r'],
      links: [[['source', 'out'], { reroute: 'r' }], [{ reroute: 'r' }, ['target', 'items.item0']]],
    }))
    expect(rerouted.ok, JSON.stringify(!rerouted.ok && rerouted.diagnostics)).toBe(true)
    if (rerouted.ok) expect(rerouted.artifact.prompt['target']!.inputs).toEqual({ 'items.item0': ['source', 0] })

    const net = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, target: { type: 'ItemGroup', dynamic: { items: { members: ['item0'] } } } },
      nets: [['images', ['source', 'out'], [['target', 'items.item0']]]],
    }))
    expect(net.ok, JSON.stringify(!net.ok && net.diagnostics)).toBe(true)
    if (net.ok) expect(net.artifact.prompt['target']!.inputs).toEqual({ 'items.item0': ['source', 0] })

    const bypassed = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        pass: { type: 'Passthrough', mode: 'bypassed' },
        target: { type: 'ItemGroup', dynamic: { items: { members: ['item0'] } } },
      },
      links: [[['source', 'out'], ['pass', 'in']], [['pass', 'out'], ['target', 'items.item0']]],
    }))
    expect(bypassed.ok, JSON.stringify(!bypassed.ok && bypassed.diagnostics)).toBe(true)
    if (bypassed.ok) expect(bypassed.artifact.prompt['target']!.inputs).toEqual({ 'items.item0': ['source', 0] })
  })

  it('activates an open type choice per subgraph occurrence from its live link', () => {
    const result = dynCompile(dynDoc({
      nodes: { source: { type: 'ImageSrc' }, linked: { type: '#sub' }, absent: { type: '#sub' } },
      links: [[['source', 'out'], ['linked', 'model']]],
      subgraphs: {
        sub: {
          nodes: { inner: { type: 'OpenSlot' } },
          boundary: { inputs: [{ id: 'model', binds: { kind: 'port', node: 'inner', port: 'model' } }] },
        },
      },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['linked.inner']!.inputs).toEqual({ model: ['source', 0] })
    expect(result.artifact.prompt['absent.inner']!.inputs).toEqual({})
  })

  it('lowers a linked input of the chosen variant at its flattened id with a slotVariants entry', () => {
    // Rows of the chosen variant submit under '<slotId>.<row>' and the stored
    // key travels once per node as slotVariants.
    const result = dynCompile(dynDoc({
      nodes: {
        slotSource: { type: 'ImageSrc' },
        valueSource: { type: 'ImageSrc' },
        target: { type: 'SpecializedSlot', dynamic: { slot: { selected: 'selected' } } },
      },
      links: [
        [['slotSource', 'out'], ['target', 'slot']],
        [['valueSource', 'out'], ['target', 'slot.x']],
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

  it('lowers a stored value on an input of the chosen variant', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        target: {
          type: 'SpecializedSlot',
          dynamic: { slot: { selected: 'selected' } },
          values: { 'slot.x': 3 },
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

  it('emits slotVariants for a connected variant with no rows (the key travels even with no dependents)', () => {
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

  it('rejects a connected type choice whose stored variant the pack no longer has', () => {
    // A removed variant is no pick, so a connected type choice still needs
    // one before a run, as with no stored key.
    const result = dynCompile(dynDoc({
      nodes: {
        source: { type: 'ImageSrc' },
        target: { type: 'SpecializedSlot', dynamic: { slot: { selected: 'gone' } } },
      },
      links: [[['source', 'out'], ['target', 'slot']]],
    }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics.find((c) => c.code === 'elab.slot.removedVariant')?.severity).toBe('warning')
    expect(result.diagnostics.some((d) => d.code === 'compile.slot.missingVariant')).toBe(true)
  })

  it('rejects a connected type choice with variants and no stored key', () => {
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

  it('scopes type choice variant validation to the partial closure', () => {
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

  it('group members: links and prompt keys use the flattened id', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          a: { type: 'ImageSrc' },
          b: { type: 'ImageSrc' },
          g: { type: 'Batcher', dynamic: { images: { members: ['image0', 'image1'] } } },
        },
        links: [
          [['a', 'out'], ['g', 'images.image0']],
          [['b', 'out'], ['g', 'images.image1']],
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
      'images.image0': { node: 'g', port: 'images.image0' },
      'images.image1': { node: 'g', port: 'images.image1' },
    })
  })

  it('member values compile under flattened ids; unset stored members take the member default; ghosts never compile', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          g: {
            type: 'Weigher',
            values: { 'weights.w0': 2 },
            dynamic: { weights: { members: ['w0', 'w1'] } },
          },
        },
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    // Exactly the two stored members: the spare ghost has no apiName.
    expect(result.artifact.prompt['g']!.inputs).toEqual({ 'weights.w0': 2, 'weights.w1': 0.5 })
    expect(result.artifact.diagnostics).toEqual([])
  })

  it('member order travels in outputMembers; values stay with their keys', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          g: {
            type: 'Weigher',
            values: { 'weights.w0': 1, 'weights.w1': 2 },
            dynamic: { weights: { members: ['w1', 'w0'] } }, // w1 now first
          },
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['g']!.inputs).toEqual({ 'weights.w0': 1, 'weights.w1': 2 })
    expect(result.artifact.prompt['g']!.outputMembers).toEqual({ weights: ['w1', 'w0'] })
  })

  it('output groups: link indexes count non-ghost elaborated outputs', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          s: { type: 'Splitter', dynamic: { outs: { members: ['o0', 'o1'] } } },
          k0: { type: 'Sink' },
          k1: { type: 'Sink' },
        },
        links: [
          [['s', 'outs.o1'], ['k0', 'in']],
          [['s', 'last'], ['k1', 'in']],
        ],
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['s']).toEqual({
      class_type: 'Splitter',
      inputs: {},
      outputIds: ['outs.o0', 'outs.o1', 'last'],
      outputMembers: { outs: ['o0', 'o1'] },
    })
    expect(result.artifact.prompt['k0']!.inputs).toEqual({ in: ['s', 1] })
    // 'last' sits after members o0(0), o1(1); the ghost is skipped in wiring.
    expect(result.artifact.prompt['k1']!.inputs).toEqual({ in: ['s', 2] })
  })

  it('count groups of outputs compile their positional members and link member 1', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        s: { type: 'CountSplitter', values: { count: 3 } },
        k: { type: 'Sink' },
      },
      links: [[['s', 'images.1'], ['k', 'in']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.s).toEqual({
      class_type: 'CountSplitter',
      inputs: { count: 3 },
      outputIds: ['images.0', 'images.1', 'images.2'],
    })
    expect(result.artifact.prompt.k!.inputs).toEqual({ in: ['s', 1] })
    const restored = dynCompile(loadDocument(JSON.parse(JSON.stringify(result.artifact.snapshot))).document!)
    expect(restored.ok).toBe(true)
    if (restored.ok) expect(restored.artifact.prompt).toEqual(result.artifact.prompt)
  })

  it('keeps static output positions around count groups that share one count input', () => {
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
        [['source', 'images.1'], ['image', 'in']],
        [['source', 'after'], ['after', 'in']],
        [['source', 'masks.0'], ['mask', 'in']],
      ],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt.source?.outputIds).toEqual(['before', 'images.0', 'images.1', 'after', 'masks.0', 'masks.1'])
    expect(result.artifact.prompt.source?.outputMembers).toBeUndefined()
    expect(result.artifact.prompt.before?.inputs.in).toEqual(['source', 0])
    expect(result.artifact.prompt.image?.inputs.in).toEqual(['source', 2])
    expect(result.artifact.prompt.after?.inputs.in).toEqual(['source', 3])
    expect(result.artifact.prompt.mask?.inputs.in).toEqual(['source', 4])
  })

  it('choice: the stored key travels in slotVariants, chosen option values submit, values of other options never warn', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          m: {
            type: 'Modal',
            values: { 'mode.strength': 0.7 },
            dynamic: { mode: { selected: 'advanced' } },
          },
        },
      }),
    )
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['m']!.inputs).toEqual({
      'mode.strength': 0.7,
      'mode.bias': 0, // option widget default
    })
    expect(result.artifact.prompt['m']!.slotVariants).toEqual({ mode: 'advanced' })
    expect(result.artifact.diagnostics).toEqual([])

    const simple = dynCompile(dynDoc({ nodes: { m: {
      type: 'Modal',
      values: { 'mode.strength': 0.3, 'mode.bias': 5 }, // bias: kept, not compiled, no warning
      dynamic: { mode: { selected: 'simple' } },
    } } }))
    expect(simple.ok, JSON.stringify(!simple.ok && simple.diagnostics)).toBe(true)
    if (!simple.ok) return
    expect(simple.artifact.prompt['m']!.inputs).toEqual({ 'mode.strength': 0.3 })
    expect(simple.artifact.prompt['m']!.slotVariants).toEqual({ mode: 'simple' })
    expect(simple.artifact.diagnostics).toEqual([])
  })

  it('boundary items bind individual group members through subgraphs', () => {
    const result = dynCompile(
      dynDoc({
        nodes: {
          a: { type: 'ImageSrc' },
          s0: { type: '#sub' },
        },
        links: [[['a', 'out'], ['s0', 'first']]],
        subgraphs: {
          sub: {
            nodes: { b: { type: 'Batcher', dynamic: { images: { members: ['image0'] } } } },
            boundary: {
              inputs: [{ id: 'first', binds: { kind: 'port', node: 'b', port: 'images.image0' } }],
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

  it('duplicate elaborated input ids are compile errors, not overwrites', () => {
    const result = dynCompile(dynDoc({ nodes: { d: { type: 'DupIn' } } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'error',
      code: 'elab.projectedNamespaceCollision',
    }))
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

describe('Primitive and Switch as ordinary nodes', () => {
  const soften = {
    nodes: {
      prim: { type: 'Primitive', values: { value: 4 } },
      sink: { type: 'IntSink', values: { steps: 3 } },
    },
    links: [[['prim', 'INT'], ['sink', 'steps']]] as [DynEnd, DynEnd][],
    boundary: { inputs: [{ id: 'amount', binds: { kind: 'port', node: 'prim', port: 'value' } }] },
  }

  it('bakes a known value into every field it feeds and does not run the Primitive', () => {
    const doc = dynDoc({
      nodes: {
        prim: { type: 'Primitive', values: { value: 11 } },
        a: { type: 'IntSink', values: { steps: 3 } },
        b: { type: 'IntSink', values: { steps: 5 } },
      },
      links: [[['prim', 'INT'], ['a', 'steps']], [['prim', 'INT'], ['b', 'steps']]],
    })
    const result = dynCompile(doc)
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['a', 'b'])
    expect(result.artifact.prompt['a']!.inputs).toEqual({ steps: 11 })
    expect(result.artifact.prompt['b']!.inputs).toEqual({ steps: 11 })
    expect(doc.graphs.g0!.nodes['a']!.values).toEqual({ steps: 3 })
  })

  it('bakes a known choice into the choice field it feeds', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        choice: { type: 'Choice', values: { value: 'dpm' } },
        sink: { type: 'SamplerSink', values: { sampler: 'euler' } },
      },
      links: [[['choice', 'COMBO'], ['sink', 'sampler']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt)).toEqual(['sink'])
    expect(result.artifact.prompt['sink']!.inputs).toEqual({ sampler: 'dpm' })
  })

  it('runs a Primitive typed by a type variable instead of baking its value', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        prim: { type: 'VarPrimitive', values: { value: { $typed: { type: 'INT', value: 7 } } } },
        sink: { type: 'IntSink', values: { steps: 3 } },
      },
      links: [[['prim', 'out'], ['sink', 'steps']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['prim', 'sink'])
    expect(result.artifact.prompt['sink']!.inputs).toEqual({ steps: ['prim', 0] })
  })

  it('advances the Primitive control only for consumers that run', () => {
    const doc = dynDoc({
      nodes: {
        prim: { type: 'Primitive', values: { value: 11 } },
        a: { type: 'IntSink', values: { steps: 3 } },
        b: { type: 'IntSink', values: { steps: 5 } },
      },
      links: [[['prim', 'INT'], ['a', 'steps']], [['prim', 'INT'], ['b', 'steps']]],
    })
    const result = dynCompile(doc, { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('a') }] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    const controllers = result.artifact.provenance.controllerInputs ?? []
    expect(controllers.map((controller) => [controller.runtimeId, controller.sources.map((source) => 'valueKey' in source && source.occurrence.node)])).toEqual([
      ['a', ['prim']],
    ])
  })

  it('gives each subgraph node its own promoted Primitive value', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        first: { type: '#soften', values: { amount: 11 } },
        second: { type: '#soften', values: { amount: 37 } },
      },
      subgraphs: { soften },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['first.sink', 'second.sink'])
    expect(result.artifact.prompt['first.sink']!.inputs).toEqual({ steps: 11 })
    expect(result.artifact.prompt['second.sink']!.inputs).toEqual({ steps: 37 })
  })

  it('passes the producer of a wired Primitive on, inside and across a subgraph boundary', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        counter: { type: 'IntSrc' },
        prim: { type: 'Primitive', values: { value: 11 } },
        sink: { type: 'IntSink', values: { steps: 3 } },
        outer: { type: 'IntSrc' },
        inst: { type: '#soften', values: { amount: 37 } },
      },
      links: [
        [['counter', 'out'], ['prim', 'value']],
        [['prim', 'INT'], ['sink', 'steps']],
        [['outer', 'out'], ['inst', 'amount']],
      ],
      subgraphs: { soften },
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.artifact.prompt).sort()).toEqual(['counter', 'inst.sink', 'outer', 'sink'])
    expect(result.artifact.prompt['sink']!.inputs).toEqual({ steps: ['counter', 0] })
    expect(result.artifact.prompt['inst.sink']!.inputs).toEqual({ steps: ['outer', 0] })
  })

  it('prunes by a pick that a known Primitive feeds, counting positions in stored order', () => {
    const doc = dynDoc({
      nodes: {
        prim: { type: 'Primitive', values: { value: 2 } },
        sourceA: { type: 'ImageSrc' },
        sourceB: { type: 'ImageSrc' },
        sourceC: { type: 'ImageSrc' },
        selector: { type: 'Switch', values: { pick: 'a' }, dynamic: { branch: { members: ['c', 'a', 'b'] } } },
      },
      links: [
        [['prim', 'INT'], ['selector', 'pick']],
        [['sourceA', 'out'], ['selector', 'branch.a']],
        [['sourceB', 'out'], ['selector', 'branch.b']],
        [['sourceC', 'out'], ['selector', 'branch.c']],
      ],
    })
    const scope: ExecutionScope = { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('selector') }] }
    const result = compile({ ...compileInput(doc, scope), resolve: dynResolve, graphFeatures: ['typedLiteral'] })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    const closure = scopeClosure({ ...compileInput(doc, scope), resolve: dynResolve, graphFeatures: ['typedLiteral'] })!
    expect([...closure.included].sort()).toEqual(['selector', 'sourceB'])
    if (result.ok) expect(result.artifact.prompt['selector']!.inputs['pick']).toEqual({ $typed: { type: 'INT', value: 2 } })
  })

  const routeBody = (extra: { nodes?: Record<string, DynNode>; links?: [DynEnd, DynEnd][]; controllers?: Record<string, string>; boundary?: { inputs?: unknown[] } } = {}) => ({
    nodes: {
      sourceA: { type: 'ImageSrc' },
      sourceB: { type: 'ImageSrc' },
      ...extra.nodes,
      selector: { type: 'ModeSwitch', values: { pick: 'a' }, controllers: extra.controllers ?? { pick: 'randomize' }, dynamic: { branch: { members: ['a', 'b'] } } },
    },
    links: [
      [['sourceA', 'out'], ['selector', 'branch.a']],
      [['sourceB', 'out'], ['selector', 'branch.b']],
      ...(extra.links ?? []),
    ] as [DynEnd, DynEnd][],
    boundary: extra.boundary ?? {},
  })
  const randomDoc = (route = routeBody(), outer: Record<string, DynNode> = { first: { type: '#route' }, second: { type: '#route' } }) =>
    dynDoc({ nodes: outer, subgraphs: { route } })
  const rollCompile = (doc: WorkflowDocument, rolls: number[], scope: ExecutionScope = { kind: 'full' }) =>
    compile({ ...compileInput(doc, scope), resolve: dynResolve, graphFeatures: ['typedLiteral'], pickCandidate: () => rolls.shift()! })

  it('rolls a random pick once per occurrence, records it and replays the record', () => {
    const rolled = rollCompile(randomDoc(), [0, 1])
    expect(rolled.ok, JSON.stringify(!rolled.ok && rolled.diagnostics)).toBe(true)
    if (!rolled.ok) return
    expect(rolled.artifact.prompt['first.selector']!.inputs['pick']).toBe('a')
    expect(rolled.artifact.prompt['second.selector']!.inputs['pick']).toBe('b')
    const choices = rolled.artifact.choices ?? []
    expect(choices).toEqual([
      { graph: 'route', selector: 'first.selector', policy: 'random', candidate: 'a' },
      { graph: 'route', selector: 'second.selector', policy: 'random', candidate: 'b' },
    ])
    expect((rolled.artifact.provenance.controllerInputs ?? []).filter((controller) => controller.terminal.valueKey === 'pick')).toEqual([])
    const replayed = compile({
      ...compileInput(randomDoc(), { kind: 'full' }),
      resolve: dynResolve,
      candidateOverride: ({ graph, selector }) => choices.find((choice) => choice.graph === graph && choice.selector === selector)?.candidate,
      pickCandidate: () => 0,
    })
    expect(replayed.ok && replayed.artifact.prompt['second.selector']!.inputs['pick']).toBe('b')
    const closure = scopeClosure({ ...compileInput(randomDoc(), { kind: 'partial', targets: [{ instancePath: [asNodeId('first')], node: asNodeId('selector') }] }), resolve: dynResolve })!
    expect([...closure.included].sort()).toEqual(['first.selector', 'first.sourceA', 'first.sourceB'])
  })

  it('rolls only Switches that run, and needs no chooser when none does', () => {
    const doc = randomDoc(routeBody(), { first: { type: '#route' }, other: { type: 'ImageSrc' } })
    const result = compile({ ...compileInput(doc, { kind: 'partial', targets: [{ instancePath: [], node: asNodeId('other') }] }), resolve: dynResolve })
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.choices).toBeUndefined()
  })

  it.each([
    ['a wired pick', routeBody({ nodes: { index: { type: 'IntSrc' } }, links: [[['index', 'out'], ['selector', 'pick']]] }), ['first.index', 0]],
    ['a pick a known Primitive feeds', routeBody({ nodes: { prim: { type: 'Primitive', values: { value: 1 } } }, links: [[['prim', 'INT'], ['selector', 'pick']]] }), { $typed: { type: 'INT', value: 1 } }],
    ['the Fixed mode the pick declares when none is stored', routeBody({ controllers: {} }), 'a'],
  ] as const)('does not roll %s', (_name, route, pick) => {
    const result = rollCompile(randomDoc(route, { first: { type: '#route' } }), [1])
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['first.selector']!.inputs['pick']).toEqual(pick)
    expect(result.artifact.choices).toBeUndefined()
  })

  it('takes Random mode from the subgraph node that promotes the pick', () => {
    const route = routeBody({ boundary: { inputs: [{ id: 'which', promoted: true, binds: { kind: 'port', node: 'selector', port: 'pick' } }] } })
    const result = rollCompile(randomDoc(route, {
      fixed: { type: '#route', values: { which: 'b' }, controllers: { which: 'fixed' } },
      random: { type: '#route', values: { which: 'a' }, controllers: { which: 'randomize' } },
    }), [1])
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (!result.ok) return
    expect(result.artifact.prompt['fixed.selector']!.inputs['pick']).toBe('b')
    expect(result.artifact.prompt['random.selector']!.inputs['pick']).toBe('b')
    expect(result.artifact.choices).toEqual([{ graph: 'route', selector: 'random.selector', policy: 'random', candidate: 'b' }])
  })

  it('drops a link into the Primitive from a muted node and passes the Primitive\'s own value on', () => {
    const result = dynCompile(dynDoc({
      nodes: {
        counter: { type: 'IntSrc', mode: 'muted' },
        prim: { type: 'Primitive', values: { value: 11 } },
        sink: { type: 'IntSink', values: { steps: 3 } },
      },
      links: [[['counter', 'out'], ['prim', 'value']], [['prim', 'INT'], ['sink', 'steps']]],
    }))
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(true)
    if (result.ok) expect(result.artifact.prompt['sink']!.inputs).toEqual({ steps: 11 })
  })
})

describe('a type variable fed two different types', () => {
  const T = { kind: 'variable', templateId: 'T' } as const
  const LATENT = { kind: 'concrete', name: 'LATENT' } as const
  const local: Record<string, NodeSchema> = {
    ImageSrc: dynSchemas['ImageSrc']!,
    LatentSrc: { ...dynSchemaOf('LatentSrc', [{ kind: 'output', id: 'out', type: LATENT }]), isOutputNode: false },
    IntSrc: dynSchemas['IntSrc']!,
    Primitive: dynSchemas['Primitive']!,
    Pair: dynSchemaOf('Pair', [dynInput('first', { type: T }), dynInput('second', { type: T }), { kind: 'output', id: 'out', type: T }]),
    AnySwitch: {
      ...dynSchemaOf('AnySwitch', [
        dynInput('pick', { type: PICK, optional: true }),
        { kind: 'group', id: 'branch', value: dynInput('value', { type: T, optional: true, lazy: true }), keys: { kind: 'named', names: ['a', 'b'] }, grows: 'button', minMembers: 1 },
        { kind: 'output', id: 'result', type: T },
      ]),
      selector: { input: 'pick', group: 'branch' },
    },
  }
  const run = (doc: WorkflowDocument, target: string) => compile({
    ...compileInput(doc, { kind: 'partial', targets: [{ instancePath: [], node: asNodeId(target) }] }),
    resolve: (type) => local[type],
    graphFeatures: ['regions', 'typedLiteral'],
  })
  const refusals = (result: ReturnType<typeof compile>) =>
    result.ok ? [] : result.diagnostics.filter((d) => d.code === 'compile.typeVariableConflict').map((d) => [d.message, d.anchor?.occurrence?.node])

  it('refuses the queue for a node whose inputs bring two types', () => {
    const result = run(dynDoc({
      nodes: { img: { type: 'ImageSrc' }, lat: { type: 'LatentSrc' }, pair: { type: 'Pair' } },
      links: [[['img', 'out'], ['pair', 'first']], [['lat', 'out'], ['pair', 'second']]],
    }), 'pair')
    expect(refusals(result)).toEqual([['These inputs must be the same type: first is IMAGE, second is LATENT.', 'pair']])
  })

  it.each([
    ['a run-time pick', 'IntSrc', false],
    ['a known pick', 'Primitive', true],
  ])('refuses a Switch with branches of two types only for %s', (_, pickType, ok) => {
    const result = run(dynDoc({
      nodes: {
        img: { type: 'ImageSrc' },
        lat: { type: 'LatentSrc' },
        pick: { type: pickType, values: { value: 1 } },
        sw: { type: 'AnySwitch', dynamic: { branch: { members: ['a', 'b'] } } },
      },
      links: [
        [['pick', pickType === 'IntSrc' ? 'out' : 'INT'], ['sw', 'pick']],
        [['img', 'out'], ['sw', 'branch.a']],
        [['lat', 'out'], ['sw', 'branch.b']],
      ],
    }), 'sw')
    expect(result.ok, JSON.stringify(!result.ok && result.diagnostics)).toBe(ok)
    if (!ok) expect(refusals(result)).toEqual([['These inputs must be the same type: a is IMAGE, b is LATENT.', 'sw']])
  })
})
