import palette from '../../../../branding/tokens/dinkster-colors.json'

export interface TypeToken {
  readonly fontSize: number
  readonly lineHeight: number
  readonly fontWeight: 400 | 500 | 600
}

export interface MeaningToken {
  readonly foreground: string
  readonly background: string
  readonly border: string
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested)
  Object.freeze(value)
  return value
}

export const brandColors = deepFreeze(palette.brand)

export interface SemanticDesignTokens {
  readonly space: {
    readonly 4: number
    readonly 8: number
    readonly 12: number
    readonly 16: number
    readonly 24: number
    readonly 32: number
  }
  readonly type: {
    readonly fontFamily: string
    readonly fontMono: string
    readonly metadata: TypeToken
    readonly body: TypeToken
    readonly section: TypeToken
    readonly title: TypeToken
    readonly weight: {
      readonly regular: 400
      readonly medium: 500
      readonly semibold: 600
    }
  }
  readonly surface: {
    readonly canvas: string
    readonly panel: string
    readonly inset: string
    readonly raised: string
    readonly selected: string
  }
  readonly text: {
    readonly primary: string
    readonly secondary: string
    readonly muted: string
    readonly disabled: string
    readonly inverse: string
    readonly onSelected: string
  }
  readonly border: {
    readonly subtle: string
    readonly strong: string
    readonly focus: string
    readonly selected: string
  }
  readonly meaning: {
    readonly accent: MeaningToken
    readonly success: MeaningToken
    readonly warning: MeaningToken
    readonly danger: MeaningToken
    readonly info: MeaningToken
  }
  readonly action: {
    readonly primaryBg: string
    readonly primaryText: string
  }
  readonly shape: {
    readonly small: number
    readonly control: number
    readonly card: number
    readonly capsule: number
  }
  readonly interaction: {
    readonly compactControlHeight: number
    readonly primaryInputHeight: number
    readonly focusRingWidth: number
    readonly hoverOverlay: string
    readonly pressedOverlay: string
    readonly selectedOverlay: string
    readonly disabledOpacity: number
  }
  readonly motion: {
    readonly fast: number
    readonly standard: number
    readonly reduced: number
    readonly easing: string
  }
  readonly elevation: {
    readonly low: string
    readonly high: string
  }
}

export const semanticTokensForTheme = (theme: 'dark' | 'light'): SemanticDesignTokens => {
  const colors = palette[theme]
  const meaning = (foreground: string): MeaningToken => ({
    foreground, background: colors.bg.surface, border: foreground,
  })
  return deepFreeze({
  space: {
    4: 4,
    8: 8,
    12: 12,
    16: 16,
    24: 24,
    32: 32,
  },
  type: {
    fontFamily: '"Noto Sans", sans-serif',
    fontMono: '"Noto Sans Mono", monospace',
    metadata: { fontSize: 11, lineHeight: 16, fontWeight: 400 },
    body: { fontSize: 13, lineHeight: 20, fontWeight: 400 },
    section: { fontSize: 15, lineHeight: 20, fontWeight: 500 },
    title: { fontSize: 18, lineHeight: 24, fontWeight: 600 },
    weight: { regular: 400, medium: 500, semibold: 600 },
  },
  surface: {
    canvas: colors.bg.canvas,
    panel: colors.bg.surface,
    inset: colors.bg.canvas,
    raised: colors.bg.raised,
    selected: colors.bg.hover,
  },
  text: {
    primary: colors.text.primary,
    secondary: colors.text.secondary,
    muted: colors.text.muted,
    disabled: colors.text.muted,
    inverse: colors.action.primaryText,
    onSelected: colors.text.primary,
  },
  border: {
    subtle: colors.border.default,
    strong: colors.text.muted,
    focus: colors.status.info,
    selected: colors.text.primary,
  },
  meaning: {
    accent: meaning(colors.status.info),
    success: meaning(colors.status.success),
    warning: meaning(colors.status.warning),
    danger: meaning(colors.status.danger),
    info: meaning(colors.status.info),
  },
  action: colors.action,
  shape: {
    small: 4,
    control: 6,
    card: 8,
    capsule: 999,
  },
  interaction: {
    compactControlHeight: 32,
    primaryInputHeight: 40,
    focusRingWidth: 2,
    hoverOverlay: colors.bg.hover,
    pressedOverlay: colors.bg.raised,
    selectedOverlay: colors.bg.hover,
    disabledOpacity: 0.45,
  },
  motion: {
    fast: 120,
    standard: 180,
    reduced: 0,
    easing: 'cubic-bezier(0.2, 0, 0, 1)',
  },
  elevation: {
    low: '0 4px 12px rgba(0, 0, 0, 0.28)',
    high: '0 12px 32px rgba(0, 0, 0, 0.42)',
  },
  } as const satisfies SemanticDesignTokens)
}

export const semanticDesignTokens = semanticTokensForTheme('dark')

export interface CanvasSemanticTokenProjection {
  readonly space: SemanticDesignTokens['space']
  readonly type: Pick<SemanticDesignTokens['type'], 'fontFamily' | 'metadata' | 'body' | 'weight'>
  readonly surface: SemanticDesignTokens['surface']
  readonly text: SemanticDesignTokens['text']
  readonly border: SemanticDesignTokens['border']
  readonly meaning: SemanticDesignTokens['meaning']
  readonly shape: SemanticDesignTokens['shape']
  readonly interaction: Pick<SemanticDesignTokens['interaction'], 'focusRingWidth' | 'selectedOverlay' | 'disabledOpacity'>
}

export const canvasSemanticTokens: CanvasSemanticTokenProjection = deepFreeze({
  space: semanticDesignTokens.space,
  type: {
    fontFamily: semanticDesignTokens.type.fontFamily,
    metadata: semanticDesignTokens.type.metadata,
    body: semanticDesignTokens.type.body,
    weight: semanticDesignTokens.type.weight,
  },
  surface: semanticDesignTokens.surface,
  text: semanticDesignTokens.text,
  border: semanticDesignTokens.border,
  meaning: semanticDesignTokens.meaning,
  shape: semanticDesignTokens.shape,
  interaction: {
    focusRingWidth: semanticDesignTokens.interaction.focusRingWidth,
    selectedOverlay: semanticDesignTokens.interaction.selectedOverlay,
    disabledOpacity: semanticDesignTokens.interaction.disabledOpacity,
  },
})

const px = (value: number): string => `${value}px`
const ms = (value: number): string => `${value}ms`

export type SemanticCssVariableName = `--dinkster-${string}`

export const semanticCssVariablesForTheme = (semanticDesignTokens: SemanticDesignTokens) => deepFreeze({
  '--dinkster-action-primary-bg': semanticDesignTokens.action.primaryBg,
  '--dinkster-action-primary-text': semanticDesignTokens.action.primaryText,
  '--dinkster-space-4': px(semanticDesignTokens.space[4]),
  '--dinkster-space-8': px(semanticDesignTokens.space[8]),
  '--dinkster-space-12': px(semanticDesignTokens.space[12]),
  '--dinkster-space-16': px(semanticDesignTokens.space[16]),
  '--dinkster-space-24': px(semanticDesignTokens.space[24]),
  '--dinkster-space-32': px(semanticDesignTokens.space[32]),
  '--dinkster-font-family': semanticDesignTokens.type.fontFamily,
  '--dinkster-font-mono': semanticDesignTokens.type.fontMono,
  '--dinkster-type-metadata-size': px(semanticDesignTokens.type.metadata.fontSize),
  '--dinkster-type-metadata-line': px(semanticDesignTokens.type.metadata.lineHeight),
  '--dinkster-type-metadata-weight': String(semanticDesignTokens.type.metadata.fontWeight),
  '--dinkster-type-body-size': px(semanticDesignTokens.type.body.fontSize),
  '--dinkster-type-body-line': px(semanticDesignTokens.type.body.lineHeight),
  '--dinkster-type-body-weight': String(semanticDesignTokens.type.body.fontWeight),
  '--dinkster-type-section-size': px(semanticDesignTokens.type.section.fontSize),
  '--dinkster-type-section-line': px(semanticDesignTokens.type.section.lineHeight),
  '--dinkster-type-section-weight': String(semanticDesignTokens.type.section.fontWeight),
  '--dinkster-type-title-size': px(semanticDesignTokens.type.title.fontSize),
  '--dinkster-type-title-line': px(semanticDesignTokens.type.title.lineHeight),
  '--dinkster-type-title-weight': String(semanticDesignTokens.type.title.fontWeight),
  '--dinkster-weight-regular': String(semanticDesignTokens.type.weight.regular),
  '--dinkster-weight-medium': String(semanticDesignTokens.type.weight.medium),
  '--dinkster-weight-semibold': String(semanticDesignTokens.type.weight.semibold),
  '--dinkster-surface-canvas': semanticDesignTokens.surface.canvas,
  '--dinkster-surface-panel': semanticDesignTokens.surface.panel,
  '--dinkster-surface-inset': semanticDesignTokens.surface.inset,
  '--dinkster-surface-raised': semanticDesignTokens.surface.raised,
  '--dinkster-surface-selected': semanticDesignTokens.surface.selected,
  '--dinkster-text-primary': semanticDesignTokens.text.primary,
  '--dinkster-text-secondary': semanticDesignTokens.text.secondary,
  '--dinkster-text-muted': semanticDesignTokens.text.muted,
  '--dinkster-text-disabled': semanticDesignTokens.text.disabled,
  '--dinkster-text-inverse': semanticDesignTokens.text.inverse,
  '--dinkster-text-on-selected': semanticDesignTokens.text.onSelected,
  '--dinkster-border-subtle': semanticDesignTokens.border.subtle,
  '--dinkster-border-strong': semanticDesignTokens.border.strong,
  '--dinkster-border-focus': semanticDesignTokens.border.focus,
  '--dinkster-border-selected': semanticDesignTokens.border.selected,
  '--dinkster-accent-foreground': semanticDesignTokens.meaning.accent.foreground,
  '--dinkster-accent-background': semanticDesignTokens.meaning.accent.background,
  '--dinkster-accent-border': semanticDesignTokens.meaning.accent.border,
  '--dinkster-success-foreground': semanticDesignTokens.meaning.success.foreground,
  '--dinkster-success-background': semanticDesignTokens.meaning.success.background,
  '--dinkster-success-border': semanticDesignTokens.meaning.success.border,
  '--dinkster-warning-foreground': semanticDesignTokens.meaning.warning.foreground,
  '--dinkster-warning-background': semanticDesignTokens.meaning.warning.background,
  '--dinkster-warning-border': semanticDesignTokens.meaning.warning.border,
  '--dinkster-danger-foreground': semanticDesignTokens.meaning.danger.foreground,
  '--dinkster-danger-background': semanticDesignTokens.meaning.danger.background,
  '--dinkster-danger-border': semanticDesignTokens.meaning.danger.border,
  '--dinkster-info-foreground': semanticDesignTokens.meaning.info.foreground,
  '--dinkster-info-background': semanticDesignTokens.meaning.info.background,
  '--dinkster-info-border': semanticDesignTokens.meaning.info.border,
  '--dinkster-radius-small': px(semanticDesignTokens.shape.small),
  '--dinkster-radius-control': px(semanticDesignTokens.shape.control),
  '--dinkster-radius-card': px(semanticDesignTokens.shape.card),
  '--dinkster-radius-capsule': px(semanticDesignTokens.shape.capsule),
  '--dinkster-control-compact-height': px(semanticDesignTokens.interaction.compactControlHeight),
  '--dinkster-input-primary-height': px(semanticDesignTokens.interaction.primaryInputHeight),
  '--dinkster-focus-ring-width': px(semanticDesignTokens.interaction.focusRingWidth),
  '--dinkster-interaction-hover': semanticDesignTokens.interaction.hoverOverlay,
  '--dinkster-interaction-pressed': semanticDesignTokens.interaction.pressedOverlay,
  '--dinkster-interaction-selected': semanticDesignTokens.interaction.selectedOverlay,
  '--dinkster-interaction-disabled-opacity': String(semanticDesignTokens.interaction.disabledOpacity),
  '--dinkster-motion-fast': ms(semanticDesignTokens.motion.fast),
  '--dinkster-motion-standard': ms(semanticDesignTokens.motion.standard),
  '--dinkster-motion-reduced': ms(semanticDesignTokens.motion.reduced),
  '--dinkster-motion-easing': semanticDesignTokens.motion.easing,
  '--dinkster-elevation-low': semanticDesignTokens.elevation.low,
  '--dinkster-elevation-high': semanticDesignTokens.elevation.high,
} as const satisfies Readonly<Record<SemanticCssVariableName, string>>)

export const semanticCssVariables = semanticCssVariablesForTheme(semanticDesignTokens)

const cssDeclarations = (theme: 'dark' | 'light') => Object.entries(semanticCssVariablesForTheme(semanticTokensForTheme(theme)))
  .map(([name, value]) => `  ${name}: ${value};`)
  .join('\n')

export const semanticCssRoot = `:root { color-scheme: dark;\n${cssDeclarations('dark')}\n}\n[data-theme="light"] { color-scheme: light;\n${cssDeclarations('light')}\n}`
