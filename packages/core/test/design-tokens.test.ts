
import { describe, expect, it } from 'vitest'
import { semanticTokensForTheme } from '../src/ui/tokens.js'

const luminance = (hex: string): number => {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

const contrast = (foreground: string, background: string): number => {
  const lighter = Math.max(luminance(foreground), luminance(background))
  const darker = Math.min(luminance(foreground), luminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('semantic design tokens', () => {

  it('keeps readable semantic text and meaning pairs', () => {
    for (const theme of ['dark', 'light'] as const) {
      const tokens = semanticTokensForTheme(theme)
      for (const surface of Object.values(tokens.surface)) {
        for (const color of [tokens.text.primary, tokens.text.secondary]) {
          expect(contrast(color, surface)).toBeGreaterThanOrEqual(4.5)
        }
      }
      for (const meaning of Object.values(tokens.meaning)) {
        expect(contrast(meaning.foreground, meaning.background)).toBeGreaterThanOrEqual(4.5)
      }
      expect(contrast(tokens.action.primaryText, tokens.action.primaryBg)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(tokens.text.onSelected, tokens.surface.selected)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(tokens.border.focus, tokens.surface.panel)).toBeGreaterThanOrEqual(3)
    }
  })

})
