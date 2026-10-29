import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  canvasSemanticTokens,
  semanticCssRoot,
  semanticCssVariables,
  semanticDesignTokens,
  semanticTokensForTheme,
} from '../src/ui/tokens.js'

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
  it('loads both palettes through native Node ESM without a bundler', () => {
    const url = new URL('../src/ui/tokens.ts', import.meta.url).href
    const output = execFileSync(process.execPath, [
      '--input-type=module',
      '--eval',
      `const { semanticTokensForTheme } = await import(${JSON.stringify(url)});
       console.log(JSON.stringify(['dark', 'light'].map(theme =>
         semanticTokensForTheme(theme).surface.canvas)));`,
    ], { encoding: 'utf8' })
    expect(JSON.parse(output)).toEqual(['#111316', '#F7F8FA'])
  })

  it('pins the approved spacing and type scales', () => {
    expect(Object.values(semanticDesignTokens.space)).toEqual([4, 8, 12, 16, 24, 32])
    expect(semanticDesignTokens.type).toMatchObject({
      metadata: { fontSize: 11, lineHeight: 16, fontWeight: 400 },
      body: { fontSize: 13, lineHeight: 20, fontWeight: 400 },
      section: { fontSize: 15, lineHeight: 20, fontWeight: 500 },
      title: { fontSize: 18, lineHeight: 24, fontWeight: 600 },
      weight: { regular: 400, medium: 500, semibold: 600 },
    })
  })

  it('projects one source into host CSS variables', () => {
    expect(semanticCssVariables['--dinkster-space-12']).toBe(`${semanticDesignTokens.space[12]}px`)
    expect(semanticCssVariables['--dinkster-surface-panel']).toBe(semanticDesignTokens.surface.panel)
    expect(semanticCssVariables['--dinkster-danger-border']).toBe(semanticDesignTokens.meaning.danger.border)
    expect(semanticCssVariables['--dinkster-motion-reduced']).toBe('0ms')
    expect(Object.entries(semanticCssVariables).every(([name, value]) => name.startsWith('--dinkster-') && value.length > 0)).toBe(true)
    expect({
      metadata: semanticCssVariables['--dinkster-type-metadata-weight'],
      body: semanticCssVariables['--dinkster-type-body-weight'],
      section: semanticCssVariables['--dinkster-type-section-weight'],
      title: semanticCssVariables['--dinkster-type-title-weight'],
    }).toEqual({
      metadata: String(semanticDesignTokens.type.metadata.fontWeight),
      body: String(semanticDesignTokens.type.body.fontWeight),
      section: String(semanticDesignTokens.type.section.fontWeight),
      title: String(semanticDesignTokens.type.title.fontWeight),
    })
  })

  it('emits every CSS variable for both themes', () => {
    const projectedNames = [...semanticCssRoot.matchAll(/(--dinkster-[\w-]+):/g)].map((match) => match[1])
    expect(projectedNames).toEqual([...Object.keys(semanticCssVariables), ...Object.keys(semanticCssVariables)])
    expect(semanticTokensForTheme('dark').surface.canvas).toBe('#111316')
    expect(semanticTokensForTheme('light').surface.canvas).toBe('#F7F8FA')
    expect(semanticTokensForTheme('light').meaning.danger.foreground).toBe('#B93630')
    expect(semanticTokensForTheme('light').action.primaryBg).toBe('#32E6C5')
  })

  it('projects the Canvas subset without a second token source', () => {
    expect(canvasSemanticTokens.space).toBe(semanticDesignTokens.space)
    expect(canvasSemanticTokens.surface).toBe(semanticDesignTokens.surface)
    expect(canvasSemanticTokens.text).toBe(semanticDesignTokens.text)
    expect(canvasSemanticTokens.border).toBe(semanticDesignTokens.border)
    expect(canvasSemanticTokens.meaning).toBe(semanticDesignTokens.meaning)
    expect(canvasSemanticTokens.type.body).toBe(semanticDesignTokens.type.body)
    expect(canvasSemanticTokens.interaction.focusRingWidth).toBe(semanticDesignTokens.interaction.focusRingWidth)
  })

  it('limits shape, motion, and elevation choices', () => {
    expect(semanticDesignTokens.shape).toEqual({ small: 4, control: 6, card: 8, capsule: 999 })
    expect(semanticDesignTokens.motion.reduced).toBe(0)
    expect(Object.keys(semanticDesignTokens.elevation)).toEqual(['low', 'high'])
  })

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

  it('freezes semantic tokens and both projections recursively', () => {
    const expectDeepFrozen = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return
      expect(Object.isFrozen(value)).toBe(true)
      for (const nested of Object.values(value)) expectDeepFrozen(nested)
    }

    expectDeepFrozen(semanticDesignTokens)
    expectDeepFrozen(canvasSemanticTokens)
    expectDeepFrozen(semanticCssVariables)
  })
})
