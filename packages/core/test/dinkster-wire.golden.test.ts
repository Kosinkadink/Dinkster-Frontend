import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { compile } from '../src/compile/compile.js'
import { importLitegraph } from '../src/format/import-litegraph.js'
import { asConnectionId } from '../src/ids.js'
import {
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchema,
} from '../src/schema/dinkster-wire.js'
import { inputsOf, outputsOf } from '../src/schema/model.js'

const concrete = (name: string) => ({ kind: 'concrete', types: [name] })

describe('Dinkster schema wire', () => {
  it('preserves forced FLOATS numeric presentation without widening other socket domains', () => {
    const widget = { type: 'NUMBER', min: -1, step: 0.001 }
    const representations = { type: 'REPRESENTATIONS', default: 'number', userSwitchable: false,
      representations: [{ id: 'number', widget }] }
    for (const descriptor of [widget, representations]) {
      const entry = { role: 'input', id: 'strengths', type: concrete('FLOATS'), forceInput: true, default: -1, widget: descriptor }
      const decoded = parseDinksterSchema('ForcedFloats', { interface: [entry] })
      expect(decoded.diagnostics).toEqual([])
      expect(inputsOf(decoded.schema!)[0]).toMatchObject({
        type: { kind: 'concrete', name: 'FLOATS' }, forceInput: true,
        widget: { widgetType: 'FLOAT', default: -1, options: { min: -1, step: 0.001 } },
      })
      for (const invalid of [
        { ...entry, forceInput: false },
        { ...entry, forceInput: undefined },
        { ...entry, type: concrete('OtherFloats') },
        { ...entry, type: { kind: 'list', element: concrete('FLOATS') } },
        { ...entry, type: { kind: 'union', types: ['FLOATS', 'FLOAT'] } },
      ]) {
        const rejected = parseDinksterSchema('BadFloatsPresentation', { interface: [invalid] })
        expect(rejected.schema).toBeUndefined()
        expect(rejected.diagnostics.some((item) => item.severity === 'error')).toBe(true)
      }
    }
  })

  it('preserves COLOR and STRING color-widget sockets through decoding, import, and compilation', () => {
    for (const socket of ['COLOR', 'STRING']) {
      for (const represented of [false, true]) {
        const widget = represented ? {
          type: 'REPRESENTATIONS', default: 'color', userSwitchable: false,
          representations: [{ id: 'color', widget: { type: 'COLOR' } }],
        } : { type: 'COLOR' }
        const decoded = parseDinksterSchema('ColorToRGBInt', {
          schemaVersion: 1, outputNode: true,
          interface: [{ role: 'input', id: 'color', type: concrete(socket), required: true, default: '#ffffff', widget }],
        })
        expect(decoded.diagnostics).toEqual([])
        expect(inputsOf(decoded.schema!)[0]).toMatchObject({
          type: { kind: 'concrete', name: socket },
          widget: { widgetType: 'COLOR', default: '#ffffff' },
        })
        const resolve = (type: string) => type === 'ColorToRGBInt' ? decoded.schema : undefined
        const imported = importLitegraph({ version: 0.4, nodes: [{ id: 1, type: 'ColorToRGBInt', widgets_values: ['#12345678'] }], links: [] }, resolve)
        expect(imported.diagnostics).toEqual([])
        const compiled = compile({ document: imported.document!, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('color'), schemaHash: 'color' })
        expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
        if (!compiled.ok) throw new Error('color compilation failed')
        expect(compiled.artifact.prompt.n1!.inputs).toEqual({ color: '#12345678' })
      }
    }
    for (const type of [
      concrete('INT'), concrete('OtherColor'),
      { kind: 'list', element: concrete('COLOR') },
      { kind: 'union', types: ['COLOR', 'STRING'] },
    ]) {
      const rejected = parseDinksterSchema('InvalidColor', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'color', type, required: true, widget: { type: 'COLOR' } }],
      })
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('renders numeric-only unions as FLOAT without changing imported numeric values or socket types', () => {
    const fixture = JSON.parse(readFileSync(new URL('../fixtures/dinkster-nodes.json', import.meta.url), 'utf8'))
    const production = parseDinksterSchema('test.numeric_union', fixture.nodes['test.numeric_union'])
    expect(production.diagnostics).toEqual([])
    expect(inputsOf(production.schema!)[0]).toMatchObject({
      type: { kind: 'union', names: ['FLOAT', 'INT'] },
      widget: { widgetType: 'FLOAT', default: 25, options: { min: 1, max: 1000, step: 0.01, display: 'number' } },
    })
    const widget = { type: 'NUMBER', min: 1, max: 1000, step: 0.01, round: false, display: 'number' }
    for (const types of [['FLOAT', 'INT'], ['INT', 'FLOAT']]) {
      const decoded = parseDinksterSchema('NumericUnion', {
        schemaVersion: 1,
        outputNode: true,
        interface: [{ role: 'input', id: 'frame_rate', type: { kind: 'union', types }, required: true, default: 25, widget }],
      })
      expect(decoded.diagnostics).toEqual([])
      expect(inputsOf(decoded.schema!)[0]).toMatchObject({
        type: { kind: 'union', names: types },
        widget: { widgetType: 'FLOAT', default: 25, options: { min: 1, max: 1000, step: 0.01, round: false, display: 'number' } },
      })
      const resolve = (type: string) => type === 'NumericUnion' ? decoded.schema : undefined
      for (const value of [24, 23.976]) {
        for (const widgets_values of [[value], { frame_rate: value }]) {
          const imported = importLitegraph({ version: 0.4, nodes: [{ id: 1, type: 'NumericUnion', widgets_values }], links: [] }, resolve)
          expect(imported.diagnostics).toEqual([])
          const compiled = compile({ document: imported.document!, revision: 1, resolve, scope: { kind: 'full' }, connection: asConnectionId('numeric-union'), schemaHash: 'numeric-union' })
          expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
          if (!compiled.ok) throw new Error('numeric union compilation failed')
          expect(compiled.artifact.prompt.n1!.inputs).toEqual({ frame_rate: value })
        }
      }
      const represented = parseDinksterSchema('NumericUnion', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'frame_rate', type: { kind: 'union', types }, required: true, widget: {
          type: 'REPRESENTATIONS', default: 'number', userSwitchable: false,
          representations: [{ id: 'number', widget: { ...widget, round: 0.01 } }],
        } }],
      })
      expect(represented.diagnostics).toEqual([])
      expect(inputsOf(represented.schema!)[0]!.widget).toMatchObject({ widgetType: 'FLOAT', options: { round: 0.01 } })
    }
  })

  it('keeps numeric union widget support closed to the INT/FLOAT scalar domain', () => {
    for (const type of [
      { kind: 'union', types: ['FLOAT', 'STRING'] },
      { kind: 'union', types: ['FLOAT', 'INT', 'BOOLEAN'] },
      { kind: 'union', types: ['INT', 'BOOLEAN'] },
      { kind: 'list', element: { kind: 'union', types: ['INT', 'FLOAT'] } },
      { kind: 'wildcard' },
    ]) {
      const decoded = parseDinksterSchema('BadNumericUnion', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'value', type, required: true, widget: { type: 'NUMBER', min: 1, step: 0.01 } }],
      })
      expect(decoded.schema).toBeUndefined()
      expect(decoded.diagnostics.some((item) => item.severity === 'error')).toBe(true)
    }
  })

  it('binds primitive list widgets without changing their socket or scalar output', () => {
    for (const [name, widget] of [
      ['STRING', { type: 'STRING', multiline: false }],
      ['INT', { type: 'NUMBER', min: -7, max: 19 }],
      ['FLOAT', { type: 'NUMBER', round: false }],
    ] as const) {
      const result = parseDinksterSchema('ListConsumer', {
        schemaVersion: 1,
        interface: [
          { role: 'input', id: 'values', type: { kind: 'list', element: concrete(name) }, required: true, widget },
          { role: 'output', id: 'result', type: concrete(name) },
        ],
      })
      expect(result.diagnostics).toEqual([])
      const input = inputsOf(result.schema!)[0]!
      expect(input.type).toEqual({ kind: 'list', element: { kind: 'concrete', name } })
      expect(input.widget).toEqual({
        widgetType: 'LIST', options: {},
        element: { widgetType: name, options: name === 'STRING' ? { multiline: false } : name === 'INT' ? { min: -7, max: 19 } : { round: false } },
      })
      expect(outputsOf(result.schema!)[0]!.type).toEqual({ kind: 'concrete', name })
    }
  })

  it('preserves list widget arrays through positional and keyed workflow import and compilation', () => {
    const decoded = parseDinksterSchema('ListConsumer', {
      schemaVersion: 1,
      outputNode: true,
      interface: [
        { role: 'input', id: 'texts', type: { kind: 'list', element: concrete('STRING') }, required: true, widget: { type: 'STRING', multiline: false } },
        { role: 'input', id: 'tail', type: concrete('INT'), required: true, widget: { type: 'NUMBER', min: 0 } },
      ],
    })
    expect(decoded.diagnostics).toEqual([])
    const resolve = (type: string) => type === 'ListConsumer' ? decoded.schema : undefined
    const texts = ['one,two', '', 'line\nnext']
    for (const widgets_values of [[texts, 17], { texts, tail: 17 }]) {
      const imported = importLitegraph({
        version: 0.4,
        nodes: [{ id: 1, type: 'ListConsumer', widgets_values }],
        links: [],
      }, resolve)
      expect(imported.diagnostics).toEqual([])
      expect(imported.document!.graphs.g0!.nodes.n1!.values).toEqual({ texts, tail: 17 })
      const compiled = compile({
        document: imported.document!, revision: 1, resolve, scope: { kind: 'full' },
        connection: asConnectionId('list-test'), schemaHash: 'list-test',
      })
      expect(compiled.ok, JSON.stringify(!compiled.ok && compiled.diagnostics)).toBe(true)
      if (!compiled.ok) throw new Error('list workflow compilation failed')
      expect(compiled.artifact.prompt.n1!.inputs).toEqual({ texts, tail: 17 })
    }
  })

  it('rejects mismatched and nested primitive-list widget bindings', () => {
    for (const element of [concrete('INT'), { kind: 'list', element: concrete('STRING') }]) {
      const result = parseDinksterSchema('BadList', {
        schemaVersion: 1,
        interface: [{ role: 'input', id: 'values', type: { kind: 'list', element }, required: true, widget: { type: 'STRING', multiline: false } }],
      })
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true)
    }
  })

  it('accepts only wire version 1 at the envelope and entry boundaries', () => {
    expect(DINKSTER_SCHEMA_WIRE_VERSION).toBe(1)

    const current = parseDinksterNodes({
      schemaVersion: 1,
      nodes: { Current: { schemaVersion: 1, interface: [] } },
    })
    expect(current.diagnostics).toEqual([])
    expect([...current.schemas.keys()]).toEqual(['Current'])

    for (const schemaVersion of [0, 2, 44]) {
      const envelope = parseDinksterNodes({ schemaVersion, nodes: {} })
      expect(envelope.schemas.size).toBe(0)
      expect(envelope.diagnostics).toEqual([
        expect.objectContaining({ severity: 'error', code: 'schema.dinkster.wireVersion' }),
      ])
    }

    const entry = parseDinksterNodes({
      schemaVersion: 1,
      nodes: {
        Current: { schemaVersion: 1, interface: [] },
        Stale: { schemaVersion: 2, interface: [] },
      },
    })
    expect([...entry.schemas.keys()]).toEqual(['Current'])
    expect(entry.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.dinkster.wireVersion' }),
    ])
  })

  it('decodes every current widget descriptor through the single parser', () => {
    const result = parseDinksterSchema('WidgetCatalog', {
      schemaVersion: 1,
      editorRole: 'custom-editor',
      mayExpandGraph: true,
      interface: [
        { role: 'input', id: 'asset', type: concrete('ASSET'), required: true, widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image' } },
        { role: 'input', id: 'save', type: concrete('SAVE_TARGET'), required: true, widget: { type: 'SAVE_TARGET', suffix: '.png' } },
        { role: 'input', id: 'combo', type: concrete('COMBO'), required: true, default: 'a', widget: { type: 'COMBO', options: ['a'] } },
        { role: 'input', id: 'multi', type: { kind: 'list', element: concrete('COMBO') }, required: true, default: ['a'], widget: { type: 'MULTI_COMBO', options: ['a'] } },
        { role: 'input', id: 'boolean', type: concrete('BOOLEAN'), required: true, default: true, widget: { type: 'BOOLEAN', labelOn: 'On' } },
        { role: 'input', id: 'number', type: concrete('FLOAT'), required: true, default: 0.5, widget: { type: 'NUMBER', min: 0, max: 1 } },
        { role: 'input', id: 'string', type: concrete('STRING'), required: true, default: '', widget: { type: 'STRING', multiline: true } },
        { role: 'input', id: 'color', type: concrete('STRING'), required: true, default: '#000000', widget: { type: 'COLOR' } },
        { role: 'input', id: 'curve', type: concrete('CURVE'), required: true, widget: { type: 'CURVE' } },
        { role: 'input', id: 'compositor', type: concrete('COMPOSITOR'), required: true, widget: { type: 'COMPOSITOR' } },
        {
          role: 'input',
          id: 'representations',
          type: concrete('STRING'),
          required: true,
          default: '',
          widget: {
            type: 'REPRESENTATIONS',
            default: 'text',
            userSwitchable: true,
            representations: [
              { id: 'text', displayName: 'Text', widget: { type: 'STRING', multiline: true } },
              { id: 'color', displayName: 'Color', widget: { type: 'COLOR' } },
            ],
          },
        },
        { role: 'input', id: 'custom', type: concrete('extension.value'), required: false, widget: { type: 'extension.widget', nested: { enabled: true, values: [1, null, 'two'] } } },
      ],
    })

    expect(result.diagnostics).toEqual([])
    expect(result.schema?.editorRole).toBe('custom-editor')
    expect(result.schema?.mayExpandGraph).toBe(true)
    expect(inputsOf(result.schema!).map((input) => input.widget?.widgetType)).toEqual([
      'ASSET',
      'SAVE_TARGET',
      'COMBO',
      'MULTI_COMBO',
      'BOOLEAN',
      'FLOAT',
      'STRING',
      'COLOR',
      'CURVE',
      'COMPOSITOR',
      'STRING',
      'extension.widget',
    ])
    expect(inputsOf(result.schema!)[10]!.widget?.representations).toEqual({
      default: 'text',
      userSwitchable: true,
      representations: [
        expect.objectContaining({
          id: 'text',
          displayName: 'Text',
          widget: expect.objectContaining({ widgetType: 'STRING' }),
        }),
        expect.objectContaining({
          id: 'color',
          displayName: 'Color',
          widget: expect.objectContaining({ widgetType: 'COLOR' }),
        }),
      ],
    })
    expect(inputsOf(result.schema!).at(-1)?.widget?.options).toEqual({ nested: { enabled: true, values: [1, null, 'two'] } })
  })

  it('preserves exact integer constraints and rejects widgets on a different scalar domain', () => {
    const parse = (socket: string, widget: object) => parseDinksterSchema('Scalar', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: concrete(socket), required: true, widget }],
    })
    const integer = parse('INT', { type: 'NUMBER', min: '-9223372036854775808', max: '18446744073709551615', step: 1 })
    expect(integer.diagnostics).toEqual([])
    expect(inputsOf(integer.schema!)[0]?.widget).toMatchObject({
      widgetType: 'INT', options: { min: '-9223372036854775808', max: '18446744073709551615', step: 1 },
    })
    for (const [socket, widget] of [
      ['STRING', { type: 'NUMBER' }],
      ['FLOAT', { type: 'NUMBER', min: '-9223372036854775808' }],
      ['STRING', { type: 'COMBO', options: ['a'] }],
      ['COMBO', { type: 'STRING' }],
      ['INT', { type: 'BOOLEAN', labelOn: 'On' }],
      ['INT', { type: 'NUMBER' }],
    ] as const) {
      const rejected = parse(socket, widget)
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('preserves finite FLOAT constraints beyond the safe integer range without relaxing INT', () => {
    const parse = (socket: string, constraints: object) => parseDinksterSchema('PrimitiveFloat', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: concrete(socket), required: true, widget: { type: 'NUMBER', ...constraints } }],
    })
    const constraints = { min: -9223372036854776000, max: 1e20, step: 1e16 }
    const result = parse('FLOAT', constraints)
    expect(result.diagnostics).toEqual([])
    expect(inputsOf(result.schema!)[0]?.widget).toMatchObject({ widgetType: 'FLOAT', options: constraints })

    for (const [socket, invalid] of [
      ['INT', constraints],
      ['INT', { max: 1e20 }],
      ['INT', { step: 1e16 }],
      ['INT', { min: 0.5 }],
      ['FLOAT', { min: '-9223372036854775808' }],
      ['FLOAT', { max: '18446744073709551615' }],
      ['FLOAT', { step: '9007199254740992' }],
      ['FLOAT', { min: Number.NEGATIVE_INFINITY }],
      ['FLOAT', { max: Number.POSITIVE_INFINITY }],
      ['FLOAT', { step: Number.NaN }],
      ['FLOAT', { min: 1e20, max: 1e19 }],
      ['FLOAT', { step: 0 }],
      ['FLOAT', { step: -1e16 }],
    ] as const) {
      const rejected = parse(socket, invalid)
      expect(rejected.schema).toBeUndefined()
      expect(rejected.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('preserves disabled FLOAT rounding and rejects invalid precisions or INT rounding', () => {
    const parse = (socket: string, round: unknown) => parseDinksterSchema('Precision', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: concrete(socket), required: true, widget: { type: 'NUMBER', round } }],
    })
    for (const round of [false, 0.001]) {
      const result = parse('FLOAT', round)
      expect(result.diagnostics).toEqual([])
      expect(inputsOf(result.schema!)[0]?.widget).toMatchObject({ widgetType: 'FLOAT', options: { round } })
    }
    for (const [socket, round] of [
      ['FLOAT', true], ['FLOAT', null], ['FLOAT', 0], ['FLOAT', -0.001],
      ['FLOAT', 'false'], ['FLOAT', '0.001'], ['FLOAT', Number.NaN],
      ['FLOAT', Number.POSITIVE_INFINITY], ['FLOAT', Number.NEGATIVE_INFINITY],
      ['INT', false], ['INT', 0.001],
    ] as const) {
      const result = parse(socket, round)
      expect(result.schema).toBeUndefined()
      expect(result.diagnostics).toEqual([expect.objectContaining({ severity: 'error' })])
    }
  })

  it('rejects nested and mixed-domain widget representations', () => {
    const parse = (representations: readonly unknown[]) => parseDinksterSchema('Representations', {
      schemaVersion: 1,
      interface: [{
        role: 'input',
        id: 'value',
        type: concrete('STRING'),
        required: true,
        widget: {
          type: 'REPRESENTATIONS',
          default: 'first',
          userSwitchable: true,
          representations,
        },
      }],
    })

    const nested = parse([{
      id: 'first',
      displayName: 'Nested',
      widget: {
        type: 'REPRESENTATIONS',
        default: 'text',
        userSwitchable: true,
        representations: [
          { id: 'text', displayName: 'Text', widget: { type: 'STRING' } },
        ],
      },
    }])
    expect(nested.schema).toBeUndefined()
    expect(nested.diagnostics[0]?.message).toContain('nested widget representations are forbidden')

    const mixed = parse([
      { id: 'first', displayName: 'Text', widget: { type: 'STRING', multiline: true } },
      { id: 'second', displayName: 'Custom', widget: { type: 'pack.custom' } },
    ])
    expect(mixed.schema).toBeUndefined()
    expect(mixed.diagnostics[0]?.message).toContain('representations must share one canonical value domain')
  })

  it('decodes current structural entries and rejects malformed current schemas', () => {
    const result = parseDinksterSchema('Structural', {
      schemaVersion: 1,
      interface: [
        { role: 'inputFamily', id: 'values', memberPrefix: 'value', minMembers: 1, template: [
          { role: 'input', id: 'value', type: concrete('FLOAT'), required: false },
        ] },
        { role: 'dynamicCombo', id: 'mode', default: 'on', options: [
          { key: 'on', inputs: [{ role: 'input', id: 'strength', type: concrete('FLOAT'), required: false }] },
        ] },
        { role: 'dynamicSlot', id: 'source', required: false, slotType: concrete('IMAGE'), inputs: [] },
        { role: 'outputFamily', id: 'outputs', type: concrete('IMAGE'), minMembers: 0 },
      ],
    })
    expect(result.diagnostics).toEqual([])
    expect(result.schema?.items.map((item) => item.id)).toEqual(['values', 'mode', 'source', 'outputs'])

    const malformed = parseDinksterSchema('Malformed', {
      schemaVersion: 1,
      interface: [{ role: 'input', id: 'value', type: { kind: 'future' }, required: true }],
    })
    expect(malformed.schema).toBeUndefined()
    expect(malformed.diagnostics).toEqual([
      expect.objectContaining({ severity: 'error', code: 'schema.parse.threw' }),
    ])
  })
})
