/**
 * Structured search filters: kind:/in:/out: token parsing, structural
 * type-token matching (the "one generic node, many forms" rule: variables
 * consult allowed sets instead of enumerating concrete forms), and schema
 * port matching across dynamic interfaces (autogrow, dynamicCombo,
 * dynamicSlot).
 */
import { describe, expect, it } from 'vitest'
import {
  autoConnectTarget,
  hintsMatchLinkDrop,
  hintsMatchPortFilters,
  parseSearchFilters,
  schemaMatchesLinkDrop,
  schemaMatchesAnyPortFilters,
  schemaMatchesPortFilters,
  typeMatchesToken,
  type InputSpec,
  type NodeSchema,
  type TypeExpr,
} from '../src/index.js'

const concrete = (name: string): TypeExpr => ({ kind: 'concrete', name })

const input = (id: string, type: TypeExpr, extra?: Partial<InputSpec>): InputSpec => ({
  kind: 'input',
  id,
  type,
  optional: false,
  ...extra,
})

const schema = (items: NodeSchema['items']): NodeSchema => ({
  type: 'test.node',
  displayName: 'Test',
  category: 'test',
  source: 'v3',
  items,
  isOutputNode: false,
})

describe('parseSearchFilters', () => {
  it('splits filter tokens from residual text', () => {
    const f = parseSearchFilters('resize in:image kind:node out:latent big')
    expect(f.text).toBe('resize big')
    expect([...f.kinds!]).toEqual(['node'])
    expect(f.inputs).toEqual(['image'])
    expect(f.outputs).toEqual(['latent'])
  })

  it('is case-insensitive on prefixes and lowercases values', () => {
    const f = parseSearchFilters('IN:IMAGE Kind:Subgraph')
    expect(f.inputs).toEqual(['image'])
    expect([...f.kinds!]).toEqual(['subgraph'])
  })

  it('an incomplete filter (empty value) is a no-op, not a text token', () => {
    const f = parseSearchFilters('resize in:')
    expect(f.text).toBe('resize')
    expect(f.inputs).toBeUndefined()
  })

  it('unknown prefixes stay in the text', () => {
    const f = parseSearchFilters('pack:vhs video')
    expect(f.text).toBe('pack:vhs video')
    expect(f.kinds).toBeUndefined()
  })

  it('no filters at all: everything is text, filter fields absent', () => {
    const f = parseSearchFilters('load image')
    expect(f).toEqual({ text: 'load image' })
  })
})

describe('typeMatchesToken', () => {
  it('concrete atoms match by full id or last dot-segment', () => {
    expect(typeMatchesToken(concrete('IMAGE'), 'image')).toBe(true)
    expect(typeMatchesToken(concrete('IMAGE'), 'IMAGE')).toBe(true)
    expect(typeMatchesToken(concrete('IMAGE'), 'image')).toBe(true) // V1
    expect(typeMatchesToken(concrete('IMAGE'), 'IMAGE')).toBe(true)
    expect(typeMatchesToken(concrete('IMAGE'), 'IMAGE')).toBe(true)
    expect(typeMatchesToken(concrete('IMAGE'), 'latent')).toBe(false)
    // Suffix matching is per-segment, never substring.
    expect(typeMatchesToken(concrete('core.imagery'), 'image')).toBe(false)
  })

  it('variables consult allowedTypes; unconstrained matches everything', () => {
    const constrained: TypeExpr = {
      kind: 'variable',
      templateId: 'T',
      allowedTypes: [concrete('IMAGE'), concrete('LATENT')],
    }
    expect(typeMatchesToken(constrained, 'image')).toBe(true)
    expect(typeMatchesToken(constrained, 'latent')).toBe(true)
    expect(typeMatchesToken(constrained, 'mask')).toBe(false)
    expect(typeMatchesToken({ kind: 'variable', templateId: 'T' }, 'anything')).toBe(true)
  })

  it('unions match any member; wildcards match everything', () => {
    const union: TypeExpr = { kind: 'union', names: ['IMAGE', 'MASK'] }
    expect(typeMatchesToken(union, 'mask')).toBe(true)
    expect(typeMatchesToken(union, 'latent')).toBe(false)
    expect(typeMatchesToken({ kind: 'wildcard' }, 'whatever')).toBe(true)
  })

  it('base tokens discover recursively wrapped types while structured tokens stay exact', () => {
    const listOfImage: TypeExpr = { kind: 'list', element: concrete('IMAGE') }
    const nestedAsset: TypeExpr = { kind: 'asset', element: listOfImage }
    expect(typeMatchesToken(listOfImage, 'image')).toBe(true)
    expect(typeMatchesToken(nestedAsset, 'image')).toBe(true)
    expect(typeMatchesToken(listOfImage, 'list<image>')).toBe(true)
    expect(typeMatchesToken(listOfImage, 'list<latent>')).toBe(false)
    expect(typeMatchesToken(concrete('IMAGE'), 'list<image>')).toBe(false)
    expect(typeMatchesToken(nestedAsset, 'asset<list<image>>')).toBe(true)
  })
})

describe('schemaMatchesPortFilters', () => {
  const resize = schema([
    input('value', {
      kind: 'variable',
      templateId: 'T',
      allowedTypes: [concrete('IMAGE'), concrete('LATENT'), concrete('MASK')],
    }),
    input('width', concrete('INT')),
    { kind: 'output', id: 'out', type: { kind: 'variable', templateId: 'T', allowedTypes: [concrete('IMAGE'), concrete('LATENT'), concrete('MASK')] } },
  ])

  it('one generic node matches every form its variable allows', () => {
    for (const t of ['image', 'latent', 'mask']) {
      expect(schemaMatchesPortFilters(resize, { inputs: [t] })).toBe(true)
      expect(schemaMatchesPortFilters(resize, { outputs: [t] })).toBe(true)
    }
    expect(schemaMatchesPortFilters(resize, { inputs: ['audio'] })).toBe(false)
  })

  it('every token must land (AND semantics across filters)', () => {
    expect(schemaMatchesPortFilters(resize, { inputs: ['image', 'int'] })).toBe(true)
    expect(schemaMatchesPortFilters(resize, { inputs: ['image', 'audio'] })).toBe(false)
    expect(schemaMatchesPortFilters(resize, { inputs: ['image'], outputs: ['latent'] })).toBe(true)
  })

  it('empty filters match everything', () => {
    expect(schemaMatchesPortFilters(resize, {})).toBe(true)
  })

  it('does not expose hidden compatibility inputs to filters or auto-connect', () => {
    const hiddenOnly = schema([
      input('provider', concrete('COMBO'), { hidden: true }),
    ])
    expect(schemaMatchesPortFilters(hiddenOnly, { inputs: ['combo'] })).toBe(false)
    expect(schemaMatchesAnyPortFilters(hiddenOnly, { inputs: ['combo'] })).toBe(false)
    expect(schemaMatchesLinkDrop(hiddenOnly, concrete('COMBO'), 'in')).toBe(false)
    expect(autoConnectTarget(hiddenOnly, concrete('COMBO'), 'in')).toBeUndefined()
  })

  it('sees through dynamicCombo option sets', () => {
    const s = schema([
      input('mode', concrete('COMBO'), {
        dynamic: {
          kind: 'dynamicCombo',
          options: [
            { key: 'a', inputs: [input('strength', concrete('FLOAT'))] },
            { key: 'b', inputs: [input('mask', concrete('MASK'))] },
          ],
        },
      }),
    ])
    expect(schemaMatchesPortFilters(s, { inputs: ['mask'] })).toBe(true)
    expect(schemaMatchesPortFilters(s, { inputs: ['float'] })).toBe(true)
    expect(schemaMatchesPortFilters(s, { inputs: ['image'] })).toBe(false)
  })

  it('sees through dynamicSlot slot types and dependents', () => {
    const s = schema([
      input('slot', { kind: 'wildcard' }, {
        dynamic: {
          kind: 'dynamicSlot',
          slotType: concrete('core.conditioning'),
          inputs: [input('strength', concrete('FLOAT'))],
        },
      }),
    ])
    expect(schemaMatchesPortFilters(s, { inputs: ['conditioning'] })).toBe(true)
    expect(schemaMatchesPortFilters(s, { inputs: ['float'] })).toBe(true)
  })

  it('sees through autogrow templates', () => {
    const s = schema([
      input('images', concrete('IMAGE'), {
        dynamic: {
          kind: 'autogrow',
          template: [input('image', concrete('IMAGE'))],
          naming: { kind: 'prefix', prefix: 'image' },
        },
      }),
    ])
    expect(schemaMatchesPortFilters(s, { inputs: ['image'] })).toBe(true)
  })

  it('out: only consults outputs, in: only inputs', () => {
    const s = schema([
      input('pixels', concrete('IMAGE')),
      { kind: 'output', id: 'latent', type: concrete('LATENT') },
    ])
    expect(schemaMatchesPortFilters(s, { inputs: ['latent'] })).toBe(false)
    expect(schemaMatchesPortFilters(s, { outputs: ['latent'] })).toBe(true)
    expect(schemaMatchesPortFilters(s, { outputs: ['image'] })).toBe(false)
  })
})

describe('schemaMatchesAnyPortFilters', () => {
  const convert = schema([
    input('image', concrete('IMAGE')),
    { kind: 'output', id: 'mask', type: concrete('MASK') },
  ])

  it('ORs selections within a direction and ANDs the input/output groups', () => {
    expect(schemaMatchesAnyPortFilters(convert, { inputs: ['audio', 'image'] })).toBe(true)
    expect(schemaMatchesAnyPortFilters(convert, { inputs: ['IMAGE'] })).toBe(true)
    expect(schemaMatchesAnyPortFilters(convert, { outputs: ['latent', 'mask'] })).toBe(true)
    expect(schemaMatchesAnyPortFilters(convert, { inputs: ['audio', 'image'], outputs: ['latent'] })).toBe(false)
  })
})

describe('hintsMatchPortFilters (blueprint boundary hints)', () => {
  const hints = { inputs: ['core.text'], outputs: ['IMAGE'] }

  it('matches by full id or last dot-segment, case-insensitive', () => {
    expect(hintsMatchPortFilters(hints, { inputs: ['text'] })).toBe(true)
    expect(hintsMatchPortFilters(hints, { inputs: ['core.text'] })).toBe(true)
    expect(hintsMatchPortFilters(hints, { outputs: ['image'] })).toBe(true)
    expect(hintsMatchPortFilters(hints, { inputs: ['image'] })).toBe(false)
    expect(hintsMatchPortFilters(hints, { outputs: ['text'] })).toBe(false)
  })

  it('every requested filter must be satisfied', () => {
    expect(hintsMatchPortFilters(hints, { inputs: ['text'], outputs: ['image'] })).toBe(true)
    expect(hintsMatchPortFilters(hints, { inputs: ['text', 'latent'] })).toBe(false)
  })

  it('undeclared hints exclude the entry when a port filter is active', () => {
    expect(hintsMatchPortFilters({}, { inputs: ['image'] })).toBe(false)
    expect(hintsMatchPortFilters({}, {})).toBe(true) // no filter, no exclusion
  })
})

describe('schemaMatchesLinkDrop (noodle-drop compatibility)', () => {
  const decode = schema([
    input('samples', concrete('LATENT')),
    input('vae', concrete('core.vae')),
    { kind: 'output', id: 'image', type: concrete('IMAGE') },
  ])

  it("seeking 'in': the anchor (a source) must feed some input", () => {
    expect(schemaMatchesLinkDrop(decode, concrete('LATENT'), 'in')).toBe(true)
    expect(schemaMatchesLinkDrop(decode, concrete('IMAGE'), 'in')).toBe(false)
  })

  it("seeking 'out': some output must feed the anchor (an input)", () => {
    expect(schemaMatchesLinkDrop(decode, concrete('IMAGE'), 'out')).toBe(true)
    expect(schemaMatchesLinkDrop(decode, concrete('LATENT'), 'out')).toBe(false)
  })

  it('one generic node matches every form its variable allows - never expanded', () => {
    const variable: TypeExpr = {
      kind: 'variable',
      templateId: 'T',
      allowedTypes: [concrete('IMAGE'), concrete('LATENT')],
    }
    const resize = schema([input('value', variable), { kind: 'output', id: 'out', type: variable }])
    expect(schemaMatchesLinkDrop(resize, concrete('IMAGE'), 'in')).toBe(true)
    expect(schemaMatchesLinkDrop(resize, concrete('LATENT'), 'in')).toBe(true)
    expect(schemaMatchesLinkDrop(resize, concrete('MASK'), 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(resize, concrete('LATENT'), 'out')).toBe(true)
  })

  it('fails closed when the dangling end has no proven type', () => {
    expect(schemaMatchesLinkDrop(decode, { kind: 'wildcard' }, 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(decode, { kind: 'wildcard' }, 'out')).toBe(false)
    expect(schemaMatchesLinkDrop(decode, { kind: 'variable', templateId: 'unknown' }, 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(decode, { kind: 'variable', templateId: 'unknown' }, 'out')).toBe(false)
    expect(schemaMatchesLinkDrop(decode, {
      kind: 'variable', templateId: 'mixed',
      allowedTypes: [concrete('LATENT'), { kind: 'wildcard' }],
    }, 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(decode, {
      kind: 'list', element: { kind: 'variable', templateId: 'open' },
    }, 'in')).toBe(false)
  })

  it('cardinality is structural: a list anchor never feeds a scalar input', () => {
    const listAnchor: TypeExpr = { kind: 'list', element: concrete('IMAGE') }
    expect(schemaMatchesLinkDrop(decode, listAnchor, 'in')).toBe(false)
    const batch = schema([input('images', { kind: 'list', element: concrete('IMAGE') })])
    expect(schemaMatchesLinkDrop(batch, listAnchor, 'in')).toBe(true)
  })

  it('sees through dynamic surfaces (autogrow template inputs)', () => {
    const s = schema([
      input('images', concrete('IMAGE'), {
        dynamic: {
          kind: 'autogrow',
          template: [input('image', concrete('IMAGE'))],
          naming: { kind: 'prefix', prefix: 'image' },
        },
      }),
      input('mode', concrete('COMBO'), {
        dynamic: {
          kind: 'dynamicCombo',
          options: [{ key: 'a', inputs: [input('mask', concrete('MASK'))] }],
        },
      }),
    ])
    expect(schemaMatchesLinkDrop(s, concrete('MASK'), 'in')).toBe(true)
  })

  it('matches concrete batch families and a constrained shared family exactly', () => {
    const family = (name: string) => schema([
      input('values', concrete(name), {
        dynamic: {
          kind: 'autogrow',
          template: [input('value', concrete(name))],
          naming: { kind: 'prefix', prefix: 'value', min: 1, max: 50 },
        },
      }),
      { kind: 'output', id: 'value', type: concrete(name) },
    ])
    const allowed = ['comfy.IMAGE', 'comfy.MASK', 'comfy.LATENT'].map(concrete)
    const matchType: TypeExpr = { kind: 'variable', templateId: 'MatchType', allowedTypes: allowed }
    const combined = schema([
      input('values', matchType, {
        dynamic: {
          kind: 'autogrow',
          template: [input('value', matchType)],
          naming: { kind: 'prefix', prefix: 'value', min: 1, max: 50 },
        },
      }),
      { kind: 'output', id: 'value', type: matchType },
    ])

    for (const name of ['comfy.IMAGE', 'comfy.MASK', 'comfy.LATENT']) {
      for (const seeking of ['in', 'out'] as const) {
        expect(schemaMatchesLinkDrop(family(name), concrete(name), seeking)).toBe(true)
        expect(schemaMatchesLinkDrop(family(name), concrete('AUDIO'), seeking)).toBe(false)
        expect(schemaMatchesLinkDrop(combined, concrete(name), seeking)).toBe(true)
      }
    }
    expect(schemaMatchesLinkDrop(combined, concrete('AUDIO'), 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(combined, concrete('AUDIO'), 'out')).toBe(false)
  })
})

describe('autoConnectTarget (link-drop auto-connect target)', () => {
  const decode = schema([
    input('samples', concrete('LATENT')),
    input('vae', concrete('core.vae')),
    { kind: 'output', id: 'image', type: concrete('IMAGE') },
    { kind: 'output', id: 'image2', type: concrete('IMAGE') },
  ])

  it('returns the first compatible port, interface order', () => {
    expect(autoConnectTarget(decode, concrete('core.vae'), 'in')).toEqual({ port: 'vae' })
    expect(autoConnectTarget(decode, concrete('IMAGE'), 'out')).toEqual({ port: 'image' })
    expect(autoConnectTarget(decode, concrete('MASK'), 'in')).toBeUndefined()
  })

  it('rejects unknown anchors but preserves intentional generic targets as fallbacks', () => {
    const genericInput = schema([input('value', { kind: 'variable', templateId: 'T' })])
    const genericOutput = schema([{ kind: 'output', id: 'value', type: { kind: 'wildcard' } }])
    expect(autoConnectTarget(decode, { kind: 'wildcard' }, 'in')).toBeUndefined()
    expect(autoConnectTarget(decode, { kind: 'variable', templateId: 'unknown' }, 'out')).toBeUndefined()
    expect(autoConnectTarget(genericInput, concrete('comfy.IMAGE'), 'in')).toEqual({ port: 'value' })
    expect(autoConnectTarget(genericOutput, concrete('comfy.IMAGE'), 'out')).toEqual({ port: 'value' })
    expect(autoConnectTarget(schema([input('value', {
      kind: 'variable', templateId: 'mixed',
      allowedTypes: [concrete('comfy.IMAGE'), { kind: 'wildcard' }],
    })]), concrete('comfy.IMAGE'), 'in')).toEqual({ port: 'value' })
  })

  it('prefers a compatible closed target over an earlier generic target', () => {
    const target = schema([
      input('generic', { kind: 'wildcard' }),
      input('image', concrete('comfy.IMAGE')),
    ])
    expect(autoConnectTarget(target, concrete('comfy.IMAGE'), 'in')).toEqual({ port: 'image' })
    expect(autoConnectTarget(target, concrete('comfy.MASK'), 'in')).toEqual({ port: 'generic' })
  })

  it('an autogrow family member is a target, with its materialize frames', () => {
    // Mirrors std.list.make: family 'items', single template slot 'items',
    // variable-typed. A fresh node's first (synthetic) member must be
    // auto-connectable - the palette path parity of the ghost-pin drop.
    const itemType: TypeExpr = { kind: 'variable', templateId: 'T' }
    const make = schema([
      input('items', itemType, {
        dynamic: {
          kind: 'autogrow',
          template: [input('items', itemType)],
          naming: { kind: 'prefix', prefix: 'item', min: 1 },
        },
      }),
      { kind: 'output', id: 'list', type: { kind: 'list', element: itemType } },
    ])
    expect(autoConnectTarget(make, concrete('IMAGE'), 'in')).toEqual({
      port: 'items.items',
      members: ['m0'],
      materialize: [{ construct: 'items', members: ['m0'] }],
    })
  })

  it('a DynamicCombo default-branch input is a target; the selector row never is', () => {
    const s = schema([
      input('mode', concrete('COMBO'), {
        dynamic: {
          kind: 'dynamicCombo',
          options: [{ key: 'a', inputs: [input('mask', concrete('MASK'))] }],
        },
      }),
    ])
    expect(schemaMatchesLinkDrop(s, concrete('MASK'), 'in')).toBe(true)
    // The default branch's input is a real addressable port on a fresh node.
    expect(autoConnectTarget(s, concrete('MASK'), 'in')).toEqual({ port: 'mode.[a].mask' })
    // Unknown anchor metadata cannot choose a branch input or selector row.
    expect(autoConnectTarget(s, { kind: 'wildcard' }, 'in')).toBeUndefined()
  })
})

describe('v14 COMBO link-drop compatibility', () => {
  const comboWidget = { widgetType: 'COMBO', options: { options: ['a', 'b'] }, default: 'a' }
  const comboConsumer = schema([input('mode', concrete('COMBO'), { widget: comboWidget })])
  const comboProducer = schema([{ kind: 'output', id: 'choice', type: concrete('COMBO') }])
  const stringConsumer = schema([input('text', concrete('STRING'))])
  const stringProducer = schema([{ kind: 'output', id: 'text', type: concrete('STRING') }])

  it('hard-rejects direct string-to-combo and combo-to-string matches', () => {
    expect(schemaMatchesLinkDrop(comboConsumer, concrete('STRING'), 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(stringConsumer, concrete('COMBO'), 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(stringProducer, concrete('COMBO'), 'out')).toBe(false)
    expect(schemaMatchesLinkDrop(comboProducer, concrete('STRING'), 'out')).toBe(false)
  })

  it('keeps the string/combo boundary hard through list and asset constructors', () => {
    const listCombo = { kind: 'list' as const, element: concrete('COMBO') }
    const listString = { kind: 'list' as const, element: concrete('STRING') }
    const assetCombo = { kind: 'asset' as const, element: concrete('COMBO') }
    const assetString = { kind: 'asset' as const, element: concrete('STRING') }
    expect(schemaMatchesLinkDrop(schema([input('items', listCombo)]), listString, 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(schema([input('items', listString)]), listCombo, 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(schema([input('asset', assetCombo)]), assetString, 'in')).toBe(false)
    expect(schemaMatchesLinkDrop(schema([input('asset', assetString)]), assetCombo, 'in')).toBe(false)
  })

  it('declared wildcard targets and unions explicitly containing COMBO accept it', () => {
    expect(schemaMatchesLinkDrop(schema([input('any', { kind: 'wildcard' })]), concrete('COMBO'), 'in')).toBe(true)
    expect(schemaMatchesLinkDrop(
      schema([input('choice', { kind: 'union', names: ['STRING', 'COMBO'] })]),
      concrete('COMBO'),
      'in',
    )).toBe(true)
  })

  it('matches and auto-connects combo-to-combo without inspecting choices', () => {
    expect(schemaMatchesLinkDrop(comboConsumer, concrete('COMBO'), 'in')).toBe(true)
    expect(autoConnectTarget(comboConsumer, concrete('COMBO'), 'in')).toEqual({ port: 'mode' })
    expect(schemaMatchesLinkDrop(comboProducer, concrete('COMBO'), 'out')).toBe(true)
    expect(autoConnectTarget(comboProducer, concrete('COMBO'), 'out')).toEqual({ port: 'choice' })
  })

  it('pins the converter endpoints as the one explicit string bridge', () => {
    const stringToCombo = schema([
      input('string', concrete('STRING')),
      { kind: 'output', id: 'choice', type: concrete('COMBO') },
    ])
    const comboToString = schema([
      input('choice', concrete('COMBO')),
      { kind: 'output', id: 'text', type: concrete('STRING') },
    ])
    expect(stringToCombo.items.map((item) => item.kind === 'section' ? undefined : item.type)).toEqual([
      concrete('STRING'), concrete('COMBO'),
    ])
    expect(comboToString.items.map((item) => item.kind === 'section' ? undefined : item.type)).toEqual([
      concrete('COMBO'), concrete('STRING'),
    ])
  })
})

describe('SAVE_TARGET link-drop compatibility', () => {
  const saveTarget = concrete('SAVE_TARGET')
  const consumer = schema([input('target', saveTarget, {
    widget: { widgetType: 'SAVE_TARGET', options: {}, default: { mount: 'comfy-output', prefix: 'ComfyUI' } },
  })])
  const producer = schema([{ kind: 'output', id: 'target', type: saveTarget }])
  const stringConsumer = schema([input('text', concrete('STRING'))])
  const stringProducer = schema([{ kind: 'output', id: 'text', type: concrete('STRING') }])

  it('offers and auto-connects exact typed producers and consumers', () => {
    expect(schemaMatchesLinkDrop(consumer, saveTarget, 'in')).toBe(true)
    expect(autoConnectTarget(consumer, saveTarget, 'in')).toEqual({ port: 'target' })
    expect(schemaMatchesLinkDrop(producer, saveTarget, 'out')).toBe(true)
    expect(autoConnectTarget(producer, saveTarget, 'out')).toEqual({ port: 'target' })
  })

  it('refuses STRING in both directions instead of offering an implicit conversion', () => {
    expect(schemaMatchesLinkDrop(consumer, concrete('STRING'), 'in')).toBe(false)
    expect(autoConnectTarget(consumer, concrete('STRING'), 'in')).toBeUndefined()
    expect(schemaMatchesLinkDrop(stringConsumer, saveTarget, 'in')).toBe(false)
    expect(autoConnectTarget(stringConsumer, saveTarget, 'in')).toBeUndefined()
    expect(schemaMatchesLinkDrop(producer, concrete('STRING'), 'out')).toBe(false)
    expect(autoConnectTarget(producer, concrete('STRING'), 'out')).toBeUndefined()
    expect(schemaMatchesLinkDrop(stringProducer, saveTarget, 'out')).toBe(false)
    expect(autoConnectTarget(stringProducer, saveTarget, 'out')).toBeUndefined()
  })
})

describe('hintsMatchLinkDrop (blueprint descriptor hints vs anchors)', () => {
  const hints = { inputs: ['core.text'], outputs: ['IMAGE', 'IMAGE'] }

  it('matches the seeking side by full id or last segment, case-insensitive', () => {
    expect(hintsMatchLinkDrop(hints, concrete('core.text'), 'in')).toBe(true)
    expect(hintsMatchLinkDrop(hints, concrete('TEXT'), 'in')).toBe(true)
    expect(hintsMatchLinkDrop(hints, concrete('IMAGE'), 'out')).toBe(true)
    expect(hintsMatchLinkDrop(hints, concrete('IMAGE'), 'in')).toBe(false)
    expect(hintsMatchLinkDrop(hints, concrete('LATENT'), 'out')).toBe(false)
  })

  it('no hints on the seeking side excludes the blueprint', () => {
    expect(hintsMatchLinkDrop({ outputs: ['IMAGE'] }, concrete('IMAGE'), 'in')).toBe(false)
    expect(hintsMatchLinkDrop({}, concrete('IMAGE'), 'out')).toBe(false)
  })

  it('an unconstrained anchor matches no declared surface', () => {
    expect(hintsMatchLinkDrop(hints, { kind: 'wildcard' }, 'in')).toBe(false)
    expect(hintsMatchLinkDrop(hints, { kind: 'variable', templateId: 'T' }, 'out')).toBe(false)
  })

  it('union anchors match when any member name lines up', () => {
    const union: TypeExpr = { kind: 'union', names: ['LATENT', 'IMAGE'] }
    expect(hintsMatchLinkDrop(hints, union, 'out')).toBe(true)
  })
})
