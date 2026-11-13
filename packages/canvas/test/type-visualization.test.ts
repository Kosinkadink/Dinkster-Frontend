import { describe, expect, it } from 'vitest'
import type { TypeExpr } from '@dinkster/core'
import { pinBaseAngle, pinShapeOf, pinSlices } from '../src/renderer.js'
import { defaultTokens, typeColor } from '../src/tokens.js'

const COMFY_TYPE_COLORS = {
  CLIP: '#FFD500',
  CLIP_VISION: '#A8DADC',
  CLIP_VISION_OUTPUT: '#ad7452',
  CONDITIONING: '#FFA931',
  CONTROL_NET: '#6EE7B7',
  IMAGE: '#64B5F6',
  LATENT: '#FF9CF9',
  MASK: '#81C784',
  MODEL: '#B39DDB',
  STYLE_MODEL: '#C2FFAE',
  VAE: '#FF6E6E',
  NOISE: '#B0B0B0',
  GUIDER: '#66FFFF',
  SAMPLER: '#ECB4B4',
  SIGMAS: '#CDFFCD',
  TAESD: '#DCC274',
} as const

describe('typeColor', () => {

  it('normalizes bare case and core primitive namespaces through the renderer path', () => {
    expect(typeColor(defaultTokens, 'model')).toBe(COMFY_TYPE_COLORS.MODEL)
    expect(typeColor(defaultTokens, 'comfy.model')).toBe(COMFY_TYPE_COLORS.MODEL)
    expect(typeColor(defaultTokens, 'INT')).toBe(defaultTokens.typeColors.INT)
  })

  it('colors structured values by their base type', () => {
    expect(typeColor(defaultTokens, 'list<MODEL>')).toBe(COMFY_TYPE_COLORS.MODEL)
    expect(typeColor(defaultTokens, 'asset<list<comfy.MODEL>>')).toBe(COMFY_TYPE_COLORS.MODEL)
  })

  it('gives unknown types a deterministic non-table fallback', () => {
    const color = typeColor(defaultTokens, 'vendor.UNKNOWN')
    expect(color).toBe(typeColor(defaultTokens, 'vendor.UNKNOWN'))
    expect(color).toMatch(/^hsl\(\d+ 45% 62%\)$/)
    expect(Object.values(defaultTokens.typeColors)).not.toContain(color)
  })
})

describe('pinShapeOf', () => {
  const variable: TypeExpr = { kind: 'variable', templateId: 'T' }

  it('uses the combined scalar/list shape only for unresolved generic inputs', () => {
    expect(pinShapeOf(variable, 'in')).toBe('scalar-list')
    expect(pinShapeOf(variable, 'out')).toBe('circle')
    expect(pinShapeOf({
      kind: 'variable',
      templateId: 'T',
      allowedTypes: [{ kind: 'concrete', name: 'IMAGE' }],
    }, 'in')).toBe('circle')
    expect(pinShapeOf({ kind: 'wildcard' }, 'in')).toBe('circle')
  })

  it('uses ordinary definite shapes after inference', () => {
    expect(pinShapeOf({ kind: 'concrete', name: 'IMAGE' }, 'in')).toBe('circle')
    expect(pinShapeOf({ kind: 'list', element: { kind: 'concrete', name: 'IMAGE' } }, 'in')).toBe('diamond')
  })
})

describe('pinSlices', () => {
  it('creates equal wedges for every finite-union member in declaration order', () => {
    const type: TypeExpr = { kind: 'union', names: ['IMAGE', 'MASK', 'LATENT', 'AUDIO'] }
    const slices = pinSlices(defaultTokens, type)

    expect(slices).toHaveLength(4)
    expect(slices.map((slice) => slice.color)).toEqual([
      typeColor(defaultTokens, 'IMAGE'),
      typeColor(defaultTokens, 'MASK'),
      typeColor(defaultTokens, 'LATENT'),
      typeColor(defaultTokens, 'AUDIO'),
    ])
    expect(slices[0]!.startAngle).toBeCloseTo(pinBaseAngle('out'))
    expect(slices[0]!.endAngle - slices[0]!.startAngle).toBeCloseTo((Math.PI * 2) / 4)
    expect(slices[3]!.endAngle).toBeCloseTo(pinBaseAngle('out') + Math.PI * 2)
  })

  it('uses the same member wedges for a constrained match type', () => {
    const type: TypeExpr = {
      kind: 'variable',
      templateId: 'T',
      allowedTypes: [
        { kind: 'concrete', name: 'IMAGE' },
        { kind: 'concrete', name: 'MASK' },
      ],
    }
    for (const direction of ['in', 'out'] as const) {
      expect(pinSlices(defaultTokens, type, direction).map((slice) => slice.color)).toEqual([
        typeColor(defaultTokens, 'IMAGE'),
        typeColor(defaultTokens, 'MASK'),
      ])
    }
  })

  it('colors union-of-list wedges by their element type (shape carries list-ness)', () => {
    const type: TypeExpr = { kind: 'union', names: ['list<IMAGE>', 'list<MASK>'] }
    const slices = pinSlices(defaultTokens, type)
    expect(slices.map((slice) => slice.color)).toEqual([
      typeColor(defaultTokens, 'IMAGE'),
      typeColor(defaultTokens, 'MASK'),
    ])
  })
})
