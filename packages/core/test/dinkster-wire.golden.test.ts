import { describe, expect, it } from 'vitest'
import {
  DINKSTER_SCHEMA_WIRE_VERSION,
  parseDinksterNodes,
  parseDinksterSchema,
} from '../src/schema/dinkster-wire.js'
import { inputsOf } from '../src/schema/model.js'

const concrete = (name: string) => ({ kind: 'concrete', types: [name] })

describe('Dinkster schema wire', () => {
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
      interface: [
        { role: 'input', id: 'asset', type: concrete('dinkster.asset'), required: true, widget: { type: 'ASSET', accept: ['image/png'], kind: 'media/image' } },
        { role: 'input', id: 'save', type: concrete('dinkster.save_target'), required: true, widget: { type: 'SAVE_TARGET', suffix: '.png' } },
        { role: 'input', id: 'combo', type: concrete('core.combo'), required: true, default: 'a', widget: { type: 'COMBO', options: ['a'] } },
        { role: 'input', id: 'multi', type: { kind: 'list', element: concrete('core.combo') }, required: true, default: ['a'], widget: { type: 'MULTI_COMBO', options: ['a'] } },
        { role: 'input', id: 'boolean', type: concrete('core.boolean'), required: true, default: true, widget: { type: 'BOOLEAN', labelOn: 'On' } },
        { role: 'input', id: 'number', type: concrete('core.float'), required: true, default: 0.5, widget: { type: 'NUMBER', min: 0, max: 1 } },
        { role: 'input', id: 'string', type: concrete('core.string'), required: true, default: '', widget: { type: 'STRING', multiline: true } },
        { role: 'input', id: 'color', type: concrete('core.string'), required: true, default: '#000000', widget: { type: 'COLOR' } },
        { role: 'input', id: 'curve', type: concrete('dinkster.curve'), required: true, widget: { type: 'CURVE' } },
        { role: 'input', id: 'compositor', type: concrete('dinkster.compositor'), required: true, widget: { type: 'COMPOSITOR' } },
      ],
    })

    expect(result.diagnostics).toEqual([])
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
    ])
  })

  it('decodes current structural entries and rejects malformed current schemas', () => {
    const result = parseDinksterSchema('Structural', {
      schemaVersion: 1,
      interface: [
        { role: 'inputFamily', id: 'values', memberPrefix: 'value', minMembers: 1, template: [
          { role: 'input', id: 'value', type: concrete('core.float'), required: false },
        ] },
        { role: 'dynamicCombo', id: 'mode', default: 'on', options: [
          { key: 'on', inputs: [{ role: 'input', id: 'strength', type: concrete('core.float'), required: false }] },
        ] },
        { role: 'dynamicSlot', id: 'source', required: false, slotType: concrete('dinkster.image'), inputs: [] },
        { role: 'outputFamily', id: 'outputs', type: concrete('dinkster.image'), minMembers: 0 },
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
