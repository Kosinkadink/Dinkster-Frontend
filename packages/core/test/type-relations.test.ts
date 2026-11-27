import { describe, expect, it } from 'vitest'
import { typesCompatible } from '../src/schema/type-relations.js'
import type { TypeExpr } from '../src/schema/model.js'

const c = (name: string): TypeExpr => ({ kind: 'concrete', name })
const u = (...names: string[]): TypeExpr => ({ kind: 'union', names })
const list = (element: TypeExpr): TypeExpr => ({ kind: 'list', element })
const asset = (element: TypeExpr): TypeExpr => ({ kind: 'asset', element })
const wild: TypeExpr = { kind: 'wildcard' }

describe('typesCompatible', () => {
  it('matches equal concrete types and rejects different ones', () => {
    expect(typesCompatible(c('IMAGE'), c('IMAGE'))).toBe(true)
    expect(typesCompatible(c('IMAGE'), c('LATENT'))).toBe(false)
  })

  it('matches record fields directionally by stable identity or cross-record name without conversions', () => {
    const record = (name: string, fields: readonly [string, string, TypeExpr][]): TypeExpr => ({
      kind: 'record', name, fields: fields.map(([id, name, type]) => ({ id, name, type, optional: false })),
    })
    const source = record('producer.settings', [['seed-id', 'seed', c('INT')], ['text-id', 'label', c('STRING')]])
    const subset = record('consumer.settings', [['other-id', 'seed', c('INT')]])
    const renamed = record('producer.settings', [['seed-id', 'noise', c('INT')]])
    expect(typesCompatible(source, subset)).toBe(true)
    expect(typesCompatible(subset, source)).toBe(false)
    expect(typesCompatible(source, renamed)).toBe(true)
    expect(typesCompatible(renamed, subset)).toBe(false)
    expect(typesCompatible(source, record('producer.settings', [['new-id', 'seed', c('INT')]]))).toBe(false)
    expect(typesCompatible(source, record('consumer.settings', [['other-id', 'seed', c('FLOAT')]]))).toBe(false)
    expect(typesCompatible(record('producer.settings', [['seed-id', 'seed', asset(c('INT'))]]), subset)).toBe(false)
    expect(typesCompatible(list(source), list(subset))).toBe(true)
    expect(typesCompatible(list(subset), list(source))).toBe(false)
    expect(typesCompatible(record('producer.outer', [['a', 'settings', list(source)]]), record('consumer.outer', [['b', 'settings', list(subset)]]))).toBe(true)
    expect(typesCompatible(source, c('producer.settings'))).toBe(false)
    expect(typesCompatible(c('producer.settings'), source)).toBe(false)
    expect(typesCompatible(source, { kind: 'variable', templateId: 'T' })).toBe(true)
    expect(typesCompatible({ kind: 'variable', templateId: 'T' }, source)).toBe(true)
  })

  it('wildcard matches everything on either side', () => {
    expect(typesCompatible(wild, c('IMAGE'))).toBe(true)
    expect(typesCompatible(c('IMAGE'), wild)).toBe(true)
    expect(typesCompatible(wild, wild)).toBe(true)
  })

  it('unions intersect', () => {
    expect(typesCompatible(u('IMAGE', 'MASK'), c('MASK'))).toBe(true)
    expect(typesCompatible(u('IMAGE', 'MASK'), u('LATENT', 'MASK'))).toBe(true)
    expect(typesCompatible(u('IMAGE'), u('LATENT'))).toBe(false)
  })

  it('unconstrained variables match everything; constrained ones use allowed sets', () => {
    const anyVar: TypeExpr = { kind: 'variable', templateId: 'T' }
    const imgVar: TypeExpr = { kind: 'variable', templateId: 'T', allowedTypes: [c('IMAGE')] }
    expect(typesCompatible(anyVar, c('LATENT'))).toBe(true)
    expect(typesCompatible(imgVar, c('IMAGE'))).toBe(true)
    expect(typesCompatible(imgVar, c('LATENT'))).toBe(false)
  })

  it('does not alias prefixed names in atoms, structures, unions or variables', () => {
    for (const name of ['IMAGE', 'MASK']) {
      const native = c(name)
      const prefixed = c(`comfy.${name}`)
      for (const [from, to] of [[native, prefixed], [prefixed, native]] as const) {
        expect(typesCompatible(from, to)).toBe(false)
        expect(typesCompatible(list(from), list(to))).toBe(false)
        expect(typesCompatible(asset(from), to)).toBe(false)
        expect(typesCompatible({ kind: 'tuple', elements: [from] }, { kind: 'tuple', elements: [to] })).toBe(false)
        expect(typesCompatible(u(name, 'LATENT'), prefixed)).toBe(false)
        expect(typesCompatible(native, { kind: 'variable', templateId: 'T', allowedTypes: [prefixed] })).toBe(false)
      }
      expect(typesCompatible(list(native), list(native))).toBe(true)
      expect(typesCompatible(asset(native), native)).toBe(true)
    }
  })
})
