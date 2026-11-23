/**
 * Document loading + migration pipeline tests: golden fixtures load clean,
 * foreign formats are detected and rejected with targeted diagnostics, the
 * migration chain replays stepwise, and corrupted documents fail shape
 * validation with precise paths.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Diagnostic } from '../src/diagnostics.js'
import type { Json, JsonObject } from '../src/format/document.js'
import { detectFormat, loadDocument } from '../src/format/migrate.js'
import { validateDocumentShape } from '../src/format/validate.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/workflows')
const loadFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(fixturesDir, `${name}.json`), 'utf8'))

const errorsOf = (diags: readonly Diagnostic[]) => diags.filter((d) => d.severity === 'error')

describe('golden workflow fixtures', () => {
  for (const name of ['minimal', 'subgraph']) {
    it(`${name}.json loads without error diagnostics`, () => {
      const result = loadDocument(loadFixture(name))
      expect(errorsOf(result.diagnostics)).toEqual([])
      expect(result.document).toBeDefined()
    })
  }

  it('preserves extension data through load', () => {
    const result = loadDocument(loadFixture('subgraph'))
    const doc = result.document!
    expect(doc.ext).toEqual({ myPack: { custom: true } })
    expect(doc.graphs['g1']!.nodes['n0']!.ext).toEqual({ vhs: { note: 'extension data round-trips' } })
  })

  it('round-trips through JSON serialization unchanged', () => {
    const raw = loadFixture('subgraph')
    const result = loadDocument(raw)
    expect(JSON.parse(JSON.stringify(result.document))).toEqual(raw)
  })

  it('round-trips widget output boundary bindings without legacy port canonicalization', () => {
    const raw = structuredClone(loadFixture('subgraph')) as Record<string, unknown>
    const graph = (raw['graphs'] as Record<string, Record<string, unknown>>)['g1']!
    const boundary = graph['boundary'] as Record<string, Record<string, unknown>[]>
    boundary['body']![2]!['binds'] = { kind: 'widgetTap', node: 'n0', tap: 'seed' }
    const result = loadDocument(JSON.parse(JSON.stringify(raw)))
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(JSON.parse(JSON.stringify(result.document))).toEqual(raw)
  })

  it('round-trips rect and legacy viewport bookmarks through load', () => {
    const raw = structuredClone(loadFixture('minimal')) as Record<string, unknown>
    const view = raw['view'] as Record<string, unknown>
    view['bookmarks'] = {
      '1': { graphStack: ['g0'], instancePath: [], view: { x: -20, y: 10, width: 800, height: 600 } },
      '2': { graphStack: ['g0'], instancePath: [], viewport: { x: 5, y: 6, scale: 1.25 } },
    }
    const result = loadDocument(raw)
    expect(errorsOf(result.diagnostics)).toEqual([])
    expect(JSON.parse(JSON.stringify(result.document))).toEqual(raw)
  })

})

describe('foreign format detection', () => {
  it('detects and rejects legacy litegraph workflows', () => {
    const raw = loadFixture('legacy-litegraph')
    expect(detectFormat(raw)).toBe('litegraph-workflow')
    const result = loadDocument(raw)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]!.code).toBe('doc.foreign.litegraph')
  })

  it('detects and rejects Comfy API prompts', () => {
    const prompt = {
      '3': { class_type: 'KSampler', inputs: { seed: 5, model: ['4', 0] } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'x.safetensors' } },
    }
    expect(detectFormat(prompt)).toBe('comfy-api-prompt')
    expect(loadDocument(prompt).diagnostics[0]!.code).toBe('doc.foreign.apiPrompt')
  })

  it('rejects unrecognizable JSON', () => {
    for (const junk of [null, 42, [], { hello: 'world' }]) {
      const result = loadDocument(junk)
      expect(result.document).toBeUndefined()
      expect(result.diagnostics[0]!.code).toBe('doc.foreign.unknown')
    }
  })

})

describe('shape validation failures', () => {
  const corrupt = (mutate: (d: JsonObject) => JsonObject): unknown =>
    mutate(structuredClone(loadFixture('minimal')) as JsonObject)

  it('accepts boundary pseudo-node view state; rejects unknown sides and bad positions', () => {
    const withBoundary = (boundary: Json): unknown =>
      corrupt((d) => {
        const view = d['view'] as JsonObject
        const graphs = view['graphs'] as JsonObject
        const g0 = graphs['g0'] as JsonObject
        return { ...d, view: { ...view, graphs: { ...graphs, g0: { ...g0, boundary } } } }
      })

    const ok = loadDocument(withBoundary({ inputs: { position: { x: -100, y: 20 } } }))
    expect(errorsOf(ok.diagnostics)).toEqual([])
    expect(ok.document).toBeDefined()

    const badSide = loadDocument(withBoundary({ sideways: { position: { x: 0, y: 0 } } }))
    expect(badSide.document).toBeUndefined()
    expect(errorsOf(badSide.diagnostics).some((e) => e.message.includes('$.view.graphs.g0.boundary.sideways'))).toBe(
      true,
    )

    const badPos = loadDocument(withBoundary({ outputs: { position: { x: 'a' } } }))
    expect(badPos.document).toBeUndefined()
    expect(
      errorsOf(badPos.diagnostics).some((e) => e.message.includes('$.view.graphs.g0.boundary.outputs.position')),
    ).toBe(true)
  })

  const withN0Sections = (d: JsonObject, sections: unknown): JsonObject => {
    const view = d['view'] as JsonObject
    const graphs = view['graphs'] as JsonObject
    const g0 = graphs['g0'] as JsonObject
    const nodes = g0['nodes'] as JsonObject
    const n0 = nodes['n0'] as JsonObject
    return {
      ...d,
      view: {
        ...view,
        graphs: { ...graphs, g0: { ...g0, nodes: { ...nodes, n0: { ...n0, sections } } } },
      },
    } as JsonObject
  }

  it('accepts well-formed view section overrides', () => {
    const good = corrupt((d) => withN0Sections(d, { adv: { collapsed: true } }))
    expect(validateDocumentShape(good)).toEqual([])
    const result = loadDocument(good)
    expect(result.document?.view.graphs['g0']?.nodes['n0']?.sections).toEqual({ adv: { collapsed: true } })
  })

  it('still runs invariants after shape validation (dangling link)', () => {
    const bad = corrupt((d) => {
      const graphs = d['graphs'] as JsonObject
      const g0 = graphs['g0'] as JsonObject
      const links = g0['links'] as JsonObject
      const l2 = links['l2'] as JsonObject
      return {
        ...d,
        graphs: { g0: { ...g0, links: { l2: { ...l2, to: { node: 'n99', port: 'clip' } } } } },
      }
    })
    const result = loadDocument(bad)
    expect(result.document).toBeUndefined()
    expect(result.diagnostics.some((e) => e.code === 'doc.link.dangling')).toBe(true)
  })
})

describe('document shape rejection', () => {
  it('rejects a boundary binding without kind rather than guessing a port binding', () => {
    const raw = structuredClone(loadFixture('subgraph')) as JsonObject
    const graph = (raw['graphs'] as JsonObject)['g1'] as JsonObject
    const boundary = graph['boundary'] as JsonObject
    const binding = ((boundary['body'] as JsonObject[])[0]!['binds']) as Record<string, unknown>
    delete binding['kind']
    const result = loadDocument(raw)
    expect(result.document).toBeUndefined()
    expect(errorsOf(result.diagnostics)).toMatchObject([{
      code: 'doc.shape.invalid',
      message: expect.stringContaining('$.graphs.g1.boundary.body[0].binds.kind:'),
    }])
  })

  it('rejects nested flattened ids that do not resolve through persisted dynamic state', () => {
    const raw = structuredClone(loadFixture('subgraph')) as JsonObject
    const graph = (raw['graphs'] as JsonObject)['g1'] as JsonObject
    const link = (graph['links'] as JsonObject)['l3'] as Record<string, unknown>
    link['to'] = { node: 'n2', port: 'input.outer.inner' }
    const result = loadDocument(raw)
    expect(result.document).toBeUndefined()
    expect(errorsOf(result.diagnostics).map((diagnostic) => diagnostic.code)).toContain('doc.dynamic.memberMissing')
  })
})
