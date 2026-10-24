import { describe, expect, it } from 'vitest'
import { canonicalCompatTypeId, canonicalCompatTypeIdOf, typesCompatible } from '../src/schema/type-compatibility.js'
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

  it('treats SAVE_TARGET as an ordinary exact atom, never as STRING', () => {
    expect(typesCompatible(c('SAVE_TARGET'), c('SAVE_TARGET'))).toBe(true)
    expect(typesCompatible(c('STRING'), c('SAVE_TARGET'))).toBe(false)
    expect(typesCompatible(c('SAVE_TARGET'), c('STRING'))).toBe(false)
  })
})

describe('comfy-compat atoms', () => {
  it('comfy.IMAGE matches IMAGE in both directions', () => {
    expect(typesCompatible(c('IMAGE'), c('comfy.IMAGE'))).toBe(true)
    expect(typesCompatible(c('comfy.IMAGE'), c('IMAGE'))).toBe(true)
    expect(typesCompatible(c('IMAGE'), c('IMAGE'))).toBe(true)
  })

  it('canonicalization lifts through structured types', () => {
    expect(typesCompatible(list(c('IMAGE')), list(c('comfy.IMAGE')))).toBe(true)
    expect(typesCompatible(list(c('comfy.IMAGE')), list(c('IMAGE')))).toBe(true)
    // The single asset decode step also bridges the pair.
    expect(typesCompatible(asset(c('IMAGE')), c('comfy.IMAGE'))).toBe(true)
    expect(typesCompatible(asset(c('comfy.IMAGE')), c('IMAGE'))).toBe(true)
  })

  it('canonicalization applies inside unions and variable domains', () => {
    expect(typesCompatible(u('IMAGE', 'LATENT'), c('comfy.IMAGE'))).toBe(true)
    const imgVar: TypeExpr = { kind: 'variable', templateId: 'T', allowedTypes: [c('comfy.IMAGE')] }
    expect(typesCompatible(c('IMAGE'), imgVar)).toBe(true)
  })

  it('comfy.MASK matches MASK in both directions', () => {
    expect(typesCompatible(c('MASK'), c('comfy.MASK'))).toBe(true)
    expect(typesCompatible(c('comfy.MASK'), c('MASK'))).toBe(true)
    expect(typesCompatible(list(c('MASK')), list(c('comfy.MASK')))).toBe(true)
    expect(typesCompatible(asset(c('MASK')), c('comfy.MASK'))).toBe(true)
  })

  it('does not widen either id to unrelated atoms', () => {
    expect(typesCompatible(c('IMAGE'), c('comfy.MASK'))).toBe(false)
    expect(typesCompatible(c('comfy.MASK'), c('IMAGE'))).toBe(false)
    // The pairs canonicalize independently: image never crosses to mask.
    expect(typesCompatible(c('MASK'), c('comfy.IMAGE'))).toBe(false)
    expect(typesCompatible(c('MASK'), c('IMAGE'))).toBe(false)
  })

  it('canonicalCompatTypeId collapses spellings while keeping wrappers', () => {
    expect(canonicalCompatTypeId('IMAGE')).toBe('IMAGE')
    expect(canonicalCompatTypeId('comfy.IMAGE')).toBe('IMAGE')
    expect(canonicalCompatTypeId('MASK')).toBe('MASK')
    expect(canonicalCompatTypeId('comfy.MASK')).toBe('MASK')
    expect(canonicalCompatTypeId('list<IMAGE>')).toBe('list<IMAGE>')
    expect(canonicalCompatTypeId('asset<list<IMAGE>>')).toBe('asset<list<IMAGE>>')
    // Non-interchangeable ids pass through untouched.
    expect(canonicalCompatTypeId('LATENT')).toBe('LATENT')
    expect(canonicalCompatTypeId('list<LATENT>')).toBe('list<LATENT>')
  })

  it('canonicalCompatTypeIdOf resolves closed exprs and rejects open ones', () => {
    expect(canonicalCompatTypeIdOf(c('IMAGE'))).toBe('IMAGE')
    expect(canonicalCompatTypeIdOf(list(c('IMAGE')))).toBe('list<IMAGE>')
    expect(canonicalCompatTypeIdOf(c('LATENT'))).toBe('LATENT')
    expect(canonicalCompatTypeIdOf(wild)).toBeUndefined()
  })
})
