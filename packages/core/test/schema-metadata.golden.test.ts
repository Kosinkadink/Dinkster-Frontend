import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveDeprecationPointer } from '../src/schema/deprecation.js'
import {
  parseDinksterNodes,
  searchVisibilityOf,
  type DinksterWireSchema,
  type NodeSchema,
} from '../src/index.js'

const loadGolden = (name: string) => {
  const raw = JSON.parse(readFileSync(
    new URL(`../fixtures/replacements/${name}.json`, import.meta.url), 'utf8',
  )) as { schemas: (DinksterWireSchema & { nodeType: string })[] }
  const result = parseDinksterNodes({
    schemaVersion: 1,
    nodes: Object.fromEntries(raw.schemas.map((schema) => [schema.nodeType, schema])),
  })
  expect(result.diagnostics, `${name}.json must decode clean`).toEqual([])
  return { raw: raw.schemas, schemas: result.schemas }
}

const vocabulary = loadGolden('vocabulary')
const chain = loadGolden('chain')
const combo = loadGolden('combo')

const schemaOf = (golden: typeof vocabulary, type: string): NodeSchema => {
  const schema = golden.schemas.get(type)
  expect(schema, `schema '${type}'`).toBeDefined()
  return schema!
}

describe('native schema metadata goldens', () => {
  it('native schema decoding ignores historical rules', () => {
    for (const golden of [vocabulary, chain, combo]) {
      for (const wire of golden.raw) {
        expect(golden.schemas.get(wire.nodeType)).not.toHaveProperty('replacements')
      }
    }
  })

  it('decodes COMBO and MULTI_COMBO presentation with exact list identity', () => {
    const schema = schemaOf(combo, 'fixture.combo-contract')
    const input = schema.items.find((item) => item.kind === 'input')
    const output = schema.items.find((item) => item.kind === 'output')
    expect(input).toMatchObject({
      type: { kind: 'concrete', name: 'COMBO' },
      widget: {
        widgetType: 'COMBO',
        options: {
          options: [
            { value: 'alpha', label: 'Alpha', info: 'Primary choice', folder: 'Featured' },
            'beta',
          ],
        },
        remote: { route: '/api/choices/fixture.combo', refreshButton: true },
        controller: 'after_generate',
        controllerInitial: 'randomize',
      },
    })
    expect(output).toMatchObject({ type: { kind: 'concrete', name: 'COMBO' } })
    expect(input).toMatchObject({ widget: { default: 'alpha' } })
    expect(typeof (input?.kind === 'input' ? input.widget?.default : undefined)).toBe('string')
    const prompt = schema.items.find((item) => item.kind === 'input' && item.id === 'prompt')
    const scale = schema.items.find((item) => item.kind === 'input' && item.id === 'scale')
    const color = schema.items.find((item) => item.kind === 'input' && item.id === 'color')
    expect(prompt).toMatchObject({
      type: { kind: 'concrete', name: 'STRING' },
      widget: {
        widgetType: 'STRING',
        options: { multiline: true, placeholder: 'Describe an image', dynamicPrompts: true },
        representations: {
          default: 'multiline',
          userSwitchable: true,
          representations: [
            { id: 'single-line', widget: { options: { multiline: false, placeholder: 'Describe an image', dynamicPrompts: false } } },
            { id: 'multiline', widget: { options: { multiline: true, placeholder: 'Describe an image', dynamicPrompts: true } } },
          ],
        },
      },
    })
    expect(scale).toMatchObject({ widget: { widgetType: 'FLOAT', options: { round: 0.001 } } })
    expect(color).toMatchObject({
      type: { kind: 'concrete', name: 'STRING' },
      widget: { widgetType: 'COLOR', options: {} },
    })
    const providers = schema.items.find((item) => item.kind === 'input' && item.id === 'providers')
    expect(providers).toEqual(expect.objectContaining({
      type: { kind: 'list', element: { kind: 'concrete', name: 'COMBO' } },
      widget: {
        widgetType: 'MULTI_COMBO',
        options: {
          options: [
            { value: 'beta', label: 'Beta provider', info: 'Preferred provider', folder: 'Providers/Featured' },
            'alpha',
            'beta',
          ],
          placeholder: 'Select providers',
          chip: false,
        },
        remote: {
          route: '/api/choices/fixture.providers',
          refreshButton: true,
          controlAfterRefresh: 'last',
          timeoutMs: 4096,
          maxRetries: 2,
          refreshMs: 0,
        },
        default: ['beta', 'alpha', 'beta'],
      },
    }))
    expect(providers?.kind === 'input' ? providers.widget?.default : undefined).toEqual(['beta', 'alpha', 'beta'])
    const providersOutput = schema.items.find((item) => item.kind === 'output' && item.id === 'providers')
    expect(providersOutput).toMatchObject({
      type: { kind: 'list', element: { kind: 'concrete', name: 'COMBO' } },
    })
    expect(JSON.stringify(combo.raw)).not.toContain('comboSource')
  })

  it('decodes message/since/pointer and explicit visibility', () => {
    const a = schemaOf(chain, 'fixture.chain-a')
    expect(a.deprecation).toEqual({
      message: 'chain-a is superseded; use chain-b',
      since: '1.2.0',
      replacement: 'fixture.chain-b',
    })
    expect(searchVisibilityOf(a)).toBe('deprecated')
    const b = schemaOf(chain, 'fixture.chain-b')
    expect(b.deprecation?.replacement).toBe('fixture.chain-c')
    expect(searchVisibilityOf(b)).toBe('hidden')
    expect(b).not.toHaveProperty('replacements')
    const c = schemaOf(chain, 'fixture.chain-c')
    expect(c.deprecation).toBeUndefined()
    expect(searchVisibilityOf(c)).toBe('normal')
  })

  it('resolves the A -> B -> C pointer chain to terminal C', () => {
    const resolved = resolveDeprecationPointer(
      schemaOf(chain, 'fixture.chain-a'), (type) => chain.schemas.get(type),
    )
    expect(resolved).toEqual({
      terminal: 'fixture.chain-c',
      path: ['fixture.chain-b', 'fixture.chain-c'],
      status: 'ok',
    })
  })
})
