import { describe, expect, it } from 'vitest'

import { canvasSemanticTokens } from '@dinkster/core'

import { CANVAS_DETAIL_MIN_SCALE, canvasDetailLevel, defaultTokens, presentedType, typeColor, typeDisplayAliases, typeExprCanonicalLabel, typeIdDisplayLabel } from '../src/tokens.js'

describe('defaultTokens', () => {
  it('projects matching canvas semantic roles from core', () => {
    expect(defaultTokens).toMatchObject({
      fontFamily: canvasSemanticTokens.type.fontFamily,
      colors: {
        canvasBackground: canvasSemanticTokens.surface.canvas,
        gridDot: canvasSemanticTokens.border.subtle,
        nodeBody: canvasSemanticTokens.surface.raised,
        nodeHeader: canvasSemanticTokens.surface.panel,
        nodeOutline: canvasSemanticTokens.border.strong,
        nodeBorder: canvasSemanticTokens.border.subtle,
        nodeSelectedBorder: canvasSemanticTokens.border.selected,
        groupDefault: canvasSemanticTokens.border.strong,
        title: canvasSemanticTokens.text.primary,
        label: canvasSemanticTokens.text.secondary,
        value: canvasSemanticTokens.text.primary,
        widgetBackground: canvasSemanticTokens.surface.inset,
        widgetAffordance: canvasSemanticTokens.text.disabled,
        widgetAffordanceActive: canvasSemanticTokens.meaning.accent.border,
        widgetRangeFill: canvasSemanticTokens.interaction.selectedOverlay,
        linkDefault: canvasSemanticTokens.text.muted,
        selection: canvasSemanticTokens.meaning.accent.border,
        dropTarget: canvasSemanticTokens.border.selected,
        modifiedIndicator: canvasSemanticTokens.meaning.warning.border,
        companionValue: canvasSemanticTokens.text.secondary,
        companionUnproven: canvasSemanticTokens.meaning.info.foreground,
        error: canvasSemanticTokens.meaning.danger.border,
        blockingWarning: canvasSemanticTokens.meaning.warning.border,
      },
      stateColors: {
        running: canvasSemanticTokens.meaning.info.border,
        done: canvasSemanticTokens.meaning.success.border,
        error: canvasSemanticTokens.meaning.danger.border,
        skipped: canvasSemanticTokens.text.muted,
      },
      progressBar: canvasSemanticTokens.meaning.info.border,
    })
  })

  it('keeps geometry and text measurement byte-equivalent', () => {
    expect(CANVAS_DETAIL_MIN_SCALE).toBe(0.5)
    expect(CANVAS_DETAIL_MIN_SCALE).toBeLessThan(defaultTokens.mediaControlMinScale)
    expect(JSON.stringify({
      rowHeight: defaultTokens.rowHeight,
      headerHeight: defaultTokens.headerHeight,
      padX: defaultTokens.padX,
      padBottom: defaultTokens.padBottom,
      previewDefaultHeight: defaultTokens.previewDefaultHeight,
      previewMinHeight: defaultTokens.previewMinHeight,
      previewCaptionHeight: defaultTokens.previewCaptionHeight,
      previewGap: defaultTokens.previewGap,
      mediaTransportHeight: defaultTokens.mediaTransportHeight,
      mediaControlMinScale: defaultTokens.mediaControlMinScale,
      nodeMinWidth: defaultTokens.nodeMinWidth,
      nodeMaxAutoWidth: defaultTokens.nodeMaxAutoWidth,
      pinRadius: defaultTokens.pinRadius,
      cornerRadius: defaultTokens.cornerRadius,
      fontFamily: defaultTokens.fontFamily,
      fontSize: defaultTokens.fontSize,
      titleFontSize: defaultTokens.titleFontSize,
      multilineText: defaultTokens.multilineText,
    })).toBe('{"rowHeight":24,"headerHeight":28,"padX":10,"padBottom":8,"previewDefaultHeight":180,"previewMinHeight":40,"previewCaptionHeight":22,"previewGap":6,"mediaTransportHeight":64,"mediaControlMinScale":0.75,"nodeMinWidth":140,"nodeMaxAutoWidth":420,"pinRadius":5.5,"cornerRadius":6,"fontFamily":"system-ui, sans-serif","fontSize":12,"titleFontSize":13,"multilineText":{"fontSize":14,"lineHeight":20,"padding":6,"labelHeight":18,"scrollbarWidth":6,"scrollbarInset":2}}')
  })

  it('owns the low-zoom detail boundaries', () => {
    expect(canvasDetailLevel(0.49, defaultTokens.mediaControlMinScale)).toBe('overview')
    expect(canvasDetailLevel(0.5, defaultTokens.mediaControlMinScale)).toBe('content')
    expect(canvasDetailLevel(0.74, defaultTokens.mediaControlMinScale)).toBe('content')
    expect(canvasDetailLevel(0.75, defaultTokens.mediaControlMinScale)).toBe('controls')
  })

  it('retains the shared mutable adapter and type language', () => {
    expect(Object.isFrozen(defaultTokens)).toBe(false)
    expect(Object.isFrozen(defaultTokens.typeColors)).toBe(false)
    expect(typeColor(defaultTokens, 'MODEL')).toBe('#B39DDB')
    expect(typeColor(defaultTokens, 'asset<list<comfy.MODEL>>')).toBe('#B39DDB')
    expect(typeColor(defaultTokens, 'core.combo')).toBe('#5D4037')
    expect(typeColor(defaultTokens, 'unknown.custom')).toBe('hsl(29 45% 62%)')
  })

  it('aliases native dinkster boundary types to ComfyUI colors', () => {
    expect(typeColor(defaultTokens, 'dinkster.model')).toBe('#B39DDB')
    expect(typeColor(defaultTokens, 'dinkster.conditioning')).toBe('#FFA931')
    expect(typeColor(defaultTokens, 'dinkster.latent')).toBe('#FF9CF9')
    expect(typeColor(defaultTokens, 'dinkster.control')).toBe('#6EE7B7')
    expect(typeColor(defaultTokens, 'dinkster.clip')).toBe('#FFD500')
    expect(typeColor(defaultTokens, 'dinkster.vae')).toBe('#FF6E6E')
    expect(typeColor(defaultTokens, 'dinkster.sampler')).toBe('#ECB4B4')
    expect(typeColor(defaultTokens, 'dinkster.sigmas')).toBe('#CDFFCD')
    expect(typeColor(defaultTokens, 'dinkster.guider')).toBe('#66FFFF')
    expect(typeColor(defaultTokens, 'dinkster.noise')).toBe('#B0B0B0')
    expect(typeColor(defaultTokens, 'dinkster.image')).toBe('#64B5F6')
    expect(typeColor(defaultTokens, 'dinkster.mask')).toBe('#81C784')
    expect(typeColor(defaultTokens, 'comfy.MASK')).toBe('#81C784')
    // Pre-rename spellings still alias for older backends.
    expect(typeColor(defaultTokens, 'dinkster.text_encoder')).toBe('#FFD500')
    expect(typeColor(defaultTokens, 'dinkster.codec')).toBe('#FF6E6E')
    // Nested structures color as their aliased base element.
    expect(typeColor(defaultTokens, 'asset<list<dinkster.model>>')).toBe('#B39DDB')
    expect(typeColor(defaultTokens, 'list<dinkster.latent>')).toBe('#FF9CF9')
    // Unaliased dinkster types keep the deterministic fallback.
    expect(typeColor(defaultTokens, 'dinkster.brand_new')).toMatch(/^hsl\(/)
  })

  it('presents aliased dinkster types with the ComfyUI name and the canonical id in the tooltip', () => {
    const presented = presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.clip' })
    expect(presented.label).toBe('CLIP')
    expect(presented.color).toBe('#FFD500')
    expect(presented.tooltip).toBe('CLIP (dinkster.clip)')
    expect(presented.canonicalName).toBe('dinkster.clip')
    expect(presentedType(defaultTokens, { kind: 'union', names: ['dinkster.model', 'dinkster.vae'] }).label).toBe('MODEL | VAE')
    const sampler = presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.sampler' })
    expect(sampler.label).toBe('SAMPLER')
    expect(sampler.color).toBe('#ECB4B4')
    expect(sampler.tooltip).toBe('SAMPLER (dinkster.sampler)')
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.sigmas' }).label).toBe('SIGMAS')
    const image = presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.image' })
    expect(image.label).toBe('IMAGE')
    expect(image.tooltip).toBe('IMAGE (dinkster.image)')
    // The interchangeable comfy spelling presents identically, so a solver
    // resolution canonicalized to comfy.IMAGE never surfaces a raw id.
    const comfyImage = presentedType(defaultTokens, { kind: 'concrete', name: 'comfy.IMAGE' })
    expect(comfyImage.label).toBe('IMAGE')
    expect(comfyImage.color).toBe('#64B5F6')
    expect(comfyImage.tooltip).toBe('IMAGE (comfy.IMAGE)')
    // The interchangeable mask pair presents the same way.
    const mask = presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.mask' })
    expect(mask.label).toBe('MASK')
    expect(mask.color).toBe('#81C784')
    expect(mask.tooltip).toBe('MASK (dinkster.mask)')
    const comfyMask = presentedType(defaultTokens, { kind: 'concrete', name: 'comfy.MASK' })
    expect(comfyMask.label).toBe('MASK')
    expect(comfyMask.color).toBe('#81C784')
    expect(comfyMask.tooltip).toBe('MASK (comfy.MASK)')
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.guider' }).label).toBe('GUIDER')
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.noise' }).label).toBe('NOISE')
    // Pre-rename spellings present identically.
    const legacy = presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.text_encoder' })
    expect(legacy.label).toBe('CLIP')
    expect(legacy.color).toBe('#FFD500')
    expect(legacy.tooltip).toBe('CLIP (dinkster.text_encoder)')
    // Unaliased types keep their raw label and plain tooltip.
    const plain = presentedType(defaultTokens, { kind: 'concrete', name: 'dinkster.brand_new' })
    expect(plain.label).toBe('dinkster.brand_new')
    expect(plain.tooltip).toBe('dinkster.brand_new')
    // Alias-table completeness is enforced structurally by
    // native-type-audit.test.ts, not by a count.
  })

  it('never treats inherited object members as aliases', () => {
    // The table has a null prototype, so names like 'constructor' fall back
    // to hash colors and raw labels instead of Object.prototype members.
    expect(typeDisplayAliases['constructor']).toBeUndefined()
    expect(typeDisplayAliases['toString']).toBeUndefined()
    expect(typeColor(defaultTokens, 'constructor')).toMatch(/^hsl\(/)
    expect(presentedType(defaultTokens, { kind: 'concrete', name: 'toString' }).label).toBe('toString')
  })

  it('aliases canonical type-id strings for display while keeping wrappers', () => {
    expect(typeIdDisplayLabel('dinkster.model')).toBe('MODEL')
    expect(typeIdDisplayLabel('list<dinkster.latent>')).toBe('list<LATENT>')
    expect(typeIdDisplayLabel('asset<list<dinkster.codec>>')).toBe('asset<list<VAE>>')
    expect(typeIdDisplayLabel('custom.thing')).toBe('custom.thing')
    expect(typeIdDisplayLabel('constructor')).toBe('constructor')
  })

  it('renders canonical TypeExpr labels without display aliases', () => {
    expect(typeExprCanonicalLabel({ kind: 'concrete', name: 'dinkster.text_encoder' })).toBe('dinkster.text_encoder')
    expect(typeExprCanonicalLabel({ kind: 'union', names: ['dinkster.model', 'dinkster.codec'] })).toBe('dinkster.model | dinkster.codec')
    expect(typeExprCanonicalLabel({ kind: 'list', element: { kind: 'concrete', name: 'dinkster.latent' } })).toBe('list<dinkster.latent>')
  })
})
