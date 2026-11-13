import { describe, expect, it } from 'vitest'

import { defaultTokens, presentedType, typeColor, typeDisplayAliases, typeExprCanonicalLabel } from '../src/tokens.js'

describe('defaultTokens', () => {

  it('presents canonical types and the ComfyUI image and mask bridges', () => {
    const comfyImage = presentedType(defaultTokens, { kind: 'concrete', name: 'comfy.IMAGE' })
    expect(comfyImage.label).toBe('IMAGE')
    expect(comfyImage.tooltip).toBe('IMAGE (comfy.IMAGE)')
    const comfyMask = presentedType(defaultTokens, { kind: 'concrete', name: 'comfy.MASK' })
    expect(comfyMask.label).toBe('MASK')
    expect(comfyMask.tooltip).toBe('MASK (comfy.MASK)')
    // Unaliased types keep their raw label and plain tooltip.
    const plain = presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.brand_new' })
    expect(plain.label).toBe('dinkster.brand_new')
    expect(plain.tooltip).toBe('dinkster.brand_new')
  })

  it('never treats inherited object members as aliases', () => {
    // The table has a null prototype, so names like 'constructor' fall back
    // to hash colors and raw labels instead of Object.prototype members.
    expect(typeDisplayAliases['constructor']).toBeUndefined()
    expect(typeDisplayAliases['toString']).toBeUndefined()
    expect(typeColor(defaultTokens, 'constructor')).toMatch(/^hsl\(/)
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'toString' }).label).toBe('toString')
  })

  it('renders canonical TypeExpr labels', () => {
    expect(typeExprCanonicalLabel({ kind: 'concrete', name: 'CLIP' })).toBe('CLIP')
    expect(typeExprCanonicalLabel({ kind: 'union', names: ['MODEL', 'VAE'] })).toBe('MODEL | VAE')
    expect(typeExprCanonicalLabel({ kind: 'list', element: { kind: 'concrete', name: 'LATENT' } })).toBe('list<LATENT>')
  })
})
