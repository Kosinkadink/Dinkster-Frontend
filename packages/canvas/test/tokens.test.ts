import { describe, expect, it } from 'vitest'

import { canvasColorsForTheme, canvasTypePaintForTheme, defaultTokens, previousCanvasTypePaint, presentedType, typeColor, typeDisplayAliases, typeExprCanonicalLabel } from '../src/tokens.js'

const channels = (color: string): number[] => {
  if (color.startsWith('#')) return color.slice(1).match(/../g)!.map((value) => parseInt(value, 16) / 255)
  const [hue, saturation, lightness] = color.match(/[\d.]+/g)!.map(Number)
  const s = saturation! / 100
  const l = lightness! / 100
  const a = s * Math.min(l, 1 - l)
  return [0, 8, 4].map((offset) => {
    const k = (offset + hue! / 30) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  })
}
const luminance = (color: string): number => channels(color)
  .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0)
const contrast = (a: string, b: string): number =>
  (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
const hue = (color: string): number => {
  const [r, g, b] = channels(color) as [number, number, number]
  const max = Math.max(r, g, b)
  const delta = max - Math.min(r, g, b)
  if (delta === 0) return 0
  return ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360
}

describe('defaultTokens', () => {
  it('darkens value fields independently of the canvas while retaining light fields', () => {
    const dark = canvasColorsForTheme('dark')
    expect(dark.canvasBackground).toBe('#0E1414')
    expect(dark.widgetBackground).toBe('#0B1111')
    const light = canvasColorsForTheme('light')
    expect(light.canvasBackground).toBe('#F7F8FA')
    expect(light.widgetBackground).toBe('#F7F8FA')
  })

  it('keeps named and unknown type hues while meeting contrast in production theme palettes', () => {
    const previousTokens = { ...defaultTokens, ...previousCanvasTypePaint }
    expect(defaultTokens.typeColors).toEqual(canvasTypePaintForTheme('dark').typeColors)
    for (const theme of ['dark', 'light'] as const) {
      const tokens = { ...defaultTokens, colors: canvasColorsForTheme(theme), ...canvasTypePaintForTheme(theme) }
      for (const name of Object.keys(defaultTokens.typeColors)) {
        const previous = typeColor(previousTokens, name)
        const color = typeColor(tokens, name)
        expect(contrast(color, tokens.colors.nodeBody), `${theme} ${name}`).toBeGreaterThanOrEqual(3)
        const difference = Math.abs(hue(color) - hue(previous))
        expect(Math.min(difference, 360 - difference), name).toBeLessThan(1.5)
        if (contrast(previous, tokens.colors.nodeBody) >= 3) expect(color).toBe(previous)
        expect(typeColor(tokens, `list<asset<${name}>>`)).toBe(color)
      }
      const hues = new Set<number>()
      for (let index = 0; hues.size < 360 && index < 100000; index++) {
        const name = `gallery.unknown_${index}`
        const previous = typeColor(previousTokens, name)
        const color = typeColor(tokens, name)
        hues.add(hue(color))
        expect(hue(color)).toBeCloseTo(hue(previous))
        expect(contrast(color, tokens.colors.nodeBody), `${theme} ${color}`).toBeGreaterThanOrEqual(3)
      }
      expect(hues.size).toBe(360)
    }
  })

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
