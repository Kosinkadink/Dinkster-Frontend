import { describe, expect, it } from 'vitest'
import type { TypeExpr } from '@dinkster/core'
import { pinBaseAngle, pinShapeOf, pinSlices } from '../src/renderer.js'
import { defaultTokens, presentedType, typeColor } from '../src/tokens.js'

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
  it('resolves native namespaced Comfy types to the exact ComfyUI dark palette', () => {
    for (const [name, color] of Object.entries(COMFY_TYPE_COLORS)) {
      expect(typeColor(defaultTokens, `comfy.${name}`), name).toBe(color)
    }
  })

  it('normalizes bare case and core primitive namespaces through the renderer path', () => {
    expect(typeColor(defaultTokens, 'model')).toBe(COMFY_TYPE_COLORS.MODEL)
    expect(typeColor(defaultTokens, 'comfy.model')).toBe(COMFY_TYPE_COLORS.MODEL)
    expect(typeColor(defaultTokens, 'core.int')).toBe(defaultTokens.typeColors.INT)
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

describe('presentedType', () => {
  const stringType: TypeExpr = { kind: 'concrete', name: 'core.string' }
  const comboType: TypeExpr = { kind: 'concrete', name: 'core.combo' }

  it('presents concrete core.combo with the pinned COMBO identity', () => {
    expect(presentedType(defaultTokens, comboType)).toEqual({
      canonicalName: 'core.combo',
      label: 'COMBO',
      color: defaultTokens.typeColors['core.combo'],
      tooltip: 'COMBO (string with choices)',
    })
  })

  it('leaves an unmarked core.string presentation unchanged', () => {
    expect(presentedType(defaultTokens, stringType)).toEqual({
      canonicalName: 'core.string',
      label: 'core.string',
      color: defaultTokens.typeColors.STRING,
      tooltip: 'core.string',
    })
  })

  it('distinguishes an unconstrained match identity from independent Any', () => {
    expect(presentedType(defaultTokens, { kind: 'variable', templateId: 'T' })).toEqual({
      label: 'T',
      color: defaultTokens.colors.linkDefault,
      tooltip: 'Match type T; every T port on this node resolves together.',
    })
    expect(presentedType(defaultTokens, { kind: 'wildcard' })).toEqual({
      label: 'Any',
      color: defaultTokens.colors.linkDefault,
      tooltip: 'Any type; this port accepts values independently and does not determine other ports.',
    })
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

describe('pinBaseAngle', () => {
  it('points the first divider at the noodle side, perpendicular to the border', () => {
    expect(pinBaseAngle('in')).toBeCloseTo(Math.PI) // left border -> west
    expect(pinBaseAngle('out')).toBeCloseTo(0) // right border -> east
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

  it('rotates the split by direction so the divider stays horizontal on both borders', () => {
    const type: TypeExpr = { kind: 'union', names: ['IMAGE', 'MASK'] }
    const input = pinSlices(defaultTokens, type, 'in')
    const output = pinSlices(defaultTokens, type, 'out')
    // Two wedges: both dividers land on the horizontal axis either way, but
    // the FIRST divider points away from the node body (west for inputs on
    // the left border, east for outputs on the right).
    expect(input[0]!.startAngle).toBeCloseTo(Math.PI)
    expect(output[0]!.startAngle).toBeCloseTo(0)
    for (const slice of [...input, ...output]) {
      expect(Math.abs(Math.sin(slice.startAngle))).toBeCloseTo(0) // horizontal divider
    }
  })

  it('leaves solved concrete types to the ordinary single-color pin path', () => {
    expect(pinSlices(defaultTokens, { kind: 'concrete', name: 'IMAGE' })).toEqual([])
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
