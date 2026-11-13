import { describe, expect, it } from 'vitest'

import { defaultTokens, presentedType, typeColor, typeDisplayAliases, typeExprCanonicalLabel } from '../src/tokens.js'

describe('defaultTokens', () => {

  it('presents canonical types and the ComfyUI image and mask bridges', () => {
    const presented = presentedType(defaultTokens, { kind: 'concrete', name: 'CLIP' })
    expect(presented.label).toBe('CLIP')
    expect(presented.color).toBe('#FFD500')
    expect(presented.tooltip).toBe('CLIP')
    expect(presented.canonicalName).toBe('CLIP')
    expect(presentedType(defaultTokens, { kind: 'union', names: ['MODEL', 'VAE'] }).label).toBe('MODEL | VAE')
    const sampler = presentedType(defaultTokens, { kind: 'concrete', name: 'SAMPLER' })
    expect(sampler.label).toBe('SAMPLER')
    expect(sampler.color).toBe('#ECB4B4')
    expect(sampler.tooltip).toBe('SAMPLER')
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'SIGMAS' }).label).toBe('SIGMAS')
    const image = presentedType(defaultTokens, { kind: 'concrete', name: 'IMAGE' })
    expect(image.label).toBe('IMAGE')
    expect(image.tooltip).toBe('IMAGE')
    const comfyImage = presentedType(defaultTokens, { kind: 'concrete', name: 'comfy.IMAGE' })
    expect(comfyImage.label).toBe('IMAGE')
    expect(comfyImage.color).toBe('#64B5F6')
    expect(comfyImage.tooltip).toBe('IMAGE (comfy.IMAGE)')
    const mask = presentedType(defaultTokens, { kind: 'concrete', name: 'MASK' })
    expect(mask.label).toBe('MASK')
    expect(mask.color).toBe('#81C784')
    expect(mask.tooltip).toBe('MASK')
    const comfyMask = presentedType(defaultTokens, { kind: 'concrete', name: 'comfy.MASK' })
    expect(comfyMask.label).toBe('MASK')
    expect(comfyMask.color).toBe('#81C784')
    expect(comfyMask.tooltip).toBe('MASK (comfy.MASK)')
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'GUIDER' }).label).toBe('GUIDER')
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'NOISE' }).label).toBe('NOISE')
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
