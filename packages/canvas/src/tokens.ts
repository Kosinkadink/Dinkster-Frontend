/**
 * Canvas paint tokens project shared semantic roles and own the fixed
 * geometry used together by drawing, layout and hit testing.
 */

import { canvasSemanticTokens, semanticTokensForTheme, canonicalTypeIdOf, parseAssetTypeId, parseListTypeId, type NodeRunState, type TypeExpr } from '@dinkster/core'

/** Fixed paint geometry shared with layout and hit testing. */
export const canvasPaintTokens = {
  detailMinScale: 0.5,
  badge: {
    size: 14,
    stride: 18,
    rightInset: 22,
    characterWidth: 5.5,
    labelPadding: 10,
    iconWidth: 10,
    radius: 3,
    iconInset: 1,
    fontSize: 9,
    textIconOffset: 5,
    baselineOffset: 0.5,
    colors: {
      subgraph: '#4a4a5e',
      executionError: '#b3402f',
      warning: '#8a6d1f',
      expanded: '#315d73',
      info: '#3a5a68',
      documentError: '#c13f32',
    },
  },
  controller: {
    edgeWidth: 12,
    glyphHalf: 3,
    verticalInset: canvasSemanticTokens.space[4],
    textGap: 6,
    fieldInset: 6,
  },
  dash: {
    anyPin: [2, 1.75],
    groupSelection: { world: [6, 4], screen: [4, 3] },
    ghost: { world: [6, 4], screen: [4, 3] },
    maybeAbsentLink: { world: [9, 5], screen: [5, 3] },
    netGuide: { world: [7, 5], screen: [7, 5] },
    selectionUnion: { world: [5, 4], screen: [4, 3] },
    marquee: { world: [4, 3], screen: [3, 2] },
    remote: [6, 4],
    blockingWarning: { world: [1, 3], screen: [1, 3] },
    growth: [3, 3],
    companionUnderline: [1, 2],
    running: { world: [13, 9], screen: [9, 6] },
    boundary: { world: [5, 3], screen: [4, 3] },
  },
  stateDash: {
    pending: { world: [2, 3], screen: [2, 3] },
    cached: { world: [7, 3], screen: [5, 3] },
    skipped: { world: [2, 4], screen: [2, 4] },
    error: { world: [4, 2], screen: [4, 2] },
    muted: { world: [2, 3], screen: [2, 3] },
    bypassed: { world: [8, 3], screen: [5, 3] },
  },
  node: {
    minimizedMinWidth: 80,
    widgetPinGap: canvasSemanticTokens.space[4],
    pinOverhang: canvasSemanticTokens.space[12],
    modeOpacity: canvasSemanticTokens.interaction.disabledOpacity,
    outline: { idle: 1.25, strong: 2.5, unrecognizedFactor: 3, screen: 1, strongScreen: 2 },
    identityBodyTint: 0.18,
    identityHeaderTint: 0.72,
    errorBodyTint: 0.2,
    errorHeaderTint: 0.35,
    titleBadgeGap: canvasSemanticTokens.space[4],
    drop: { outset: 2, opacity: 0.65, stroke: 1.5 },
    scope: { outset: 5, stroke: 2.5, minScreenStroke: 2 },
    progress: { height: 3, minScreenHeight: 1.5 },
    advancedGroup: { fill: 'rgba(255, 255, 255, 0.035)', stroke: 1, inset: 0.5 },
    section: {
      horizontalInset: 1,
      verticalInset: 2,
      glyphInset: canvasSemanticTokens.space[4],
      arrowBack: 2.5,
      arrowTip: 3.5,
      arrowHalfWidth: canvasSemanticTokens.space[4],
      labelOffset: 9,
      labelReserve: 13,
      modifiedInset: 3,
      modifiedRadius: 2.5,
    },
  },
  pin: {
    dividerScreen: 1,
    dividerMinWorld: 0.75,
    dividerMaxWorld: canvasSemanticTokens.space[4],
    diamondScale: 1.25,
    hoverScale: 1.35,
    statusRingGap: 3.5,
    statusRingStroke: canvasSemanticTokens.interaction.focusRingWidth,
    outlineStroke: 1,
    optionalMinRadius: 1.5,
    optionalRadiusRatio: 0.32,
    overviewMinRadius: 2,
    ghostStroke: 1.5,
    ghostMinScreenStroke: 1,
  },
  running: {
    pulsePeriodMs: 1400,
    reducedMotionPulse: 0.5,
    glowOpacity: 0.48,
    glowPulseOpacity: 0.22,
    glowOutset: 2,
    glowStroke: 4.5,
    glowMinScreenStroke: 3,
    glowBlur: canvasSemanticTokens.space[8],
    glowPulseBlur: 5,
    accentStroke: 1.5,
    accentMinScreenStroke: 1.5,
    dashSpeed: 0.032,
  },
  toolbox: {
    buttonSize: 28,
    gap: 5,
    padding: 6,
    selectionGap: canvasSemanticTokens.space[16],
    badgeGap: 6,
    separatorWidth: 1,
    nodeSelectionOutset: 3,
    selectionStroke: canvasSemanticTokens.interaction.focusRingWidth,
    boundarySelectionOutset: 2,
    multiSelectionPadding: canvasSemanticTokens.space[8],
    multiSelectionStroke: 1,
    panelRadius: canvasSemanticTokens.space[8],
    innerRadius: 3,
    borderStroke: 1,
    buttonRadius: 5,
    disabledOpacity: 0.4,
    glyphBaselineOffset: 0.5,
  },
  reroute: {
    radius: 13,
    socketGap: 8,
    socketRadius: 5,
    cullPadding: 6,
    stroke: 1,
    selectionOutset: 3,
    socketStroke: 2,
  },
  boundary: {
    stroke: 1.25,
    minScreenStroke: 1,
    dropOutset: 2,
    dropStroke: 2,
    labelPinGap: canvasSemanticTokens.space[4],
  },
  valueSource: {
    heightPadding: 8,
    minWidth: 90,
    badgeSize: 14,
    badgeInset: 6,
    stroke: 1,
    strongStroke: 2,
    badgeGap: canvasSemanticTokens.space[4],
    valueGap: canvasSemanticTokens.space[8],
    baselineOffset: 0.5,
    badgeRadiusInset: 2,
    badgeFontWeight: 700,
    badgeFontReduction: 2,
    badgeStroke: 1.5,
  },
  selector: {
    minWidth: 110,
    badgeSize: 14,
    badgeInset: 6,
    selectionOutset: 3,
    selectionStroke: 2,
    stroke: 1.25,
    minScreenStroke: 1,
    badgeGap: canvasSemanticTokens.space[4],
    badgeRadius: 3,
    badgeStroke: 1,
    badgeFontSize: 9,
    baselineOffset: 0.5,
    accentInset: 1.5,
    accentVerticalInset: 3,
    accentWidth: 2.5,
    labelPinGap: canvasSemanticTokens.space[4],
  },
  net: {
    gap: 10,
    height: 18,
    paddingX: 6,
    leadCullPadding: 1,
    leadStroke: 2,
    leadMinScreenStroke: 1,
    mismatchLeadStroke: 3,
    mismatchMinScreenStroke: 1.5,
    stroke: 1,
    mismatchStroke: 2,
    selectionOutset: 3,
    selectionStroke: 2,
    baselineOffset: 0.5,
  },
  overlay: {
    marqueeOpacity: 0.08,
    marqueeStroke: 1,
    ghostStroke: 1.5,
    placementOpacity: 0.6,
  },
  group: {
    headerHeight: 26,
    fillOpacity: 0.14,
    headerOpacity: 0.45,
    borderOpacity: 0.8,
    stroke: 1,
  },
  type: {
    semiboldWeight: 600,
    smallMinSize: 9,
    smallReduction: 1,
    adornmentMinSize: 8,
    adornmentReduction: 2,
  },
  adornment: {
    antialiasPadding: 2,
    boundsFontFactor: 2,
    linkOffsetY: -7,
    outputPinGap: canvasSemanticTokens.space[4],
    outputOffsetY: 10,
  },
  icon: { circleRadiusRatio: 0.22, paddingRatio: 0.2, viewBoxSize: 24, stroke: 2 },
  virtualNote: {
    verticalPadding: canvasSemanticTokens.space[8],
    bodyTint: 0.28,
    bodyInset: 1,
    minLineHeight: canvasSemanticTokens.space[16],
    lineGap: 5,
    headingSizeOffset: canvasSemanticTokens.space[4],
    boldWeight: 700,
    regularWeight: 400,
    listIndent: canvasSemanticTokens.space[16],
  },
  preview: {
    stroke: 1,
    minRadius: 2,
    radiusInset: 1,
    checkerSize: canvasSemanticTokens.space[16],
    placeholderOpacity: 0.65,
    labelPadding: canvasSemanticTokens.space[8],
    mediaBadgeMinWidth: 48,
    mediaBadgePadding: canvasSemanticTokens.space[12],
    mediaBadgeHeight: 20,
    provenancePosition: 0.25,
    metadataPosition: 0.75,
    outputPadding: canvasSemanticTokens.space[4],
    outputMaxLines: 6,
    staleStroke: 1,
    staleUnderlineOffset: 1,
  },
  lensAffordance: {
    rowMinSize: 10,
    rowMaxSize: 14,
    rowPadding: canvasSemanticTokens.space[8],
    previewSize: canvasSemanticTokens.space[16],
    previewInset: canvasSemanticTokens.space[8],
    disabledOpacity: 0.45,
    stroke: 1.5,
    radius: 3,
    check: { startX: 0.25, startY: 0.52, middleX: 0.43, middleY: 0.7, endX: 0.76, endY: 0.32 },
    plus: { start: 0.3, end: 0.7 },
  },
  dataPanel: {
    borderInset: 1,
    minHeight: 10,
    minWidth: 20,
    scrimOpacity: 0.92,
    rowHeight: 17,
    verticalPadding: 3,
    horizontalPaddingReduction: 2,
    labelRatio: 0.45,
    staleOpacity: 0.55,
    valueGap: canvasSemanticTokens.space[8],
  },
  opacity: {
    ghost: canvasSemanticTokens.interaction.disabledOpacity,
    scopeDim: 0.72,
  },
  link: {
    paintPadding: canvasSemanticTokens.space[4],
    stroke: 2.5,
    minScreenStroke: 1,
    selectedStroke: 5.5,
    selectedMinScreenStroke: 2,
    mismatchStroke: 3,
    mismatchMinScreenStroke: 1.5,
    guideCasingStroke: 4.5,
    guideCasingMinScreenStroke: 3,
    guideStroke: 2.5,
    guideMinScreenStroke: 1.5,
    cullMinPadding: 5,
    cullScreenPadding: 1,
    midpointRadius: 3.5,
    hoveredMidpointRadius: 5,
    midpointStroke: 1,
    hoveredMidpointStroke: 1.5,
    nameOffset: 3,
  },
  widget: {
    textPadding: 2,
    verticalInset: 2,
    radius: canvasSemanticTokens.space[4],
    labelWidthPadding: canvasSemanticTokens.space[12],
    labelClipPadding: canvasSemanticTokens.space[8],
    labelInset: 6,
    colorValueReserve: 32,
    structuredValueRatio: 0.55,
    valueWidthPadding: canvasSemanticTokens.space[16],
    swatchReserve: canvasSemanticTokens.space[16],
    toggleReserve: canvasSemanticTokens.space[12],
    toggle: {
      trailingInset: 22,
      halfHeight: 5,
      width: 20,
      height: 10,
      radius: 5,
      thumbInset: 1,
      checkedOffset: 11,
      thumbSize: canvasSemanticTokens.space[8],
      thumbRadius: canvasSemanticTokens.space[4],
    },
    chevron: { stroke: 1.5, topOffset: -2, bottomOffset: 1 },
    scrollbarMinThumbRatio: 2,
    inactiveOpacity: canvasSemanticTokens.interaction.disabledOpacity,
    connectedOpacity: canvasSemanticTokens.interaction.disabledOpacity,
    hoverOpacity: 0.12,
    diagnosticStroke: 1.5,
    connectedControllerOpacity: 0.5,
    connectedGlyphOpacity: 0.35,
    stepperStroke: 1.5,
    staleValueStroke: 1.5,
    companion: { stroke: 1, underlineOffset: canvasSemanticTokens.space[4] },
    fallbackValueWidthPadding: canvasSemanticTokens.space[8],
    fallback: { opacity: 0.75, textInset: 4, labelRatio: 0.45, valueRatio: 0.5 },
    growth: { stroke: 1, verticalInset: 3, textPadding: canvasSemanticTokens.space[8] },
  },
  minimap: {
    margin: canvasSemanticTokens.space[8],
    maxScale: 0.25,
    viewportInset: 2,
    linkStroke: 0.3,
    stateStroke: 0.3,
    minPointRadius: 0.5,
    minNodeSize: 2,
    bypassFill: 'rgba(75, 24, 75, 0.9)',
    remoteStroke: 1.5,
    remoteOpacity: 0.8,
    viewportFillOpacity: 0.2,
    viewportStrokeOpacity: 0.9,
    viewportStroke: canvasSemanticTokens.interaction.focusRingWidth,
    markerRadius: 7,
    markerInset: 1,
    markerFontWeight: 700,
    markerFontSize: 9,
  },
} as const

/** Minimum zoom for text detail and transient media DOM. */
export const CANVAS_DETAIL_MIN_SCALE = canvasPaintTokens.detailMinScale

/** Typed presentation density derived from the two shared Canvas thresholds. */
export type CanvasDetailLevel = 'overview' | 'content' | 'controls'

export function canvasDetailLevel(scale: number, mediaControlMinScale: number): CanvasDetailLevel {
  if (scale >= mediaControlMinScale) return 'controls'
  return scale >= CANVAS_DETAIL_MIN_SCALE ? 'content' : 'overview'
}

export interface DesignTokens {
  readonly rowHeight: number
  readonly headerHeight: number
  readonly padX: number
  readonly padBottom: number
  /** Media height the preview panel opens at before any manual resize. */
  readonly previewDefaultHeight: number
  /** Hard floor the media area can be shrunk to by resizing the node. */
  readonly previewMinHeight: number
  readonly previewCaptionHeight: number
  readonly previewGap: number
  readonly mediaTransportHeight: number
  readonly mediaControlMinScale: number
  readonly nodeMinWidth: number
  readonly nodeMaxAutoWidth: number
  readonly pinRadius: number
  readonly cornerRadius: number
  readonly fontFamily: string
  readonly fontSize: number
  readonly titleFontSize: number
  /** Spacious prompt typography; compact row metrics remain independent. */
  readonly multilineText: {
    readonly fontSize: number
    readonly lineHeight: number
    readonly padding: number
    /** Compact floating-label band, independent of the shared row height. */
    readonly labelHeight: number
    readonly scrollbarWidth: number
    /** Clear the rounded chrome edge without narrowing the scrollbar. */
    readonly scrollbarInset: number
  }
  readonly colors: {
    readonly canvasBackground: string
    readonly gridDot: string
    readonly nodeBody: string
    readonly nodeHeader: string
    /** Structural node/pseudo-node outline, stronger than inset chrome. */
    readonly nodeOutline: string
    readonly nodeBorder: string
    readonly nodeSelectedBorder: string
    /** Neutral group tint and border when the document supplies no color. */
    readonly groupDefault: string
    readonly title: string
    readonly label: string
    readonly value: string
    readonly widgetBackground: string
    /** Muted compact-control tracks and glyphs. */
    readonly widgetAffordance: string
    /** Active compact-control state. */
    readonly widgetAffordanceActive: string
    /** Low-contrast bounded-numeric value-zone fill. */
    readonly widgetRangeFill: string
    readonly linkDefault: string
    readonly selection: string
    /**
     * Compatible connection-target rings during a link drag. White, per the
     * same design-language contract as nodeSelectedBorder: "where you can
     * drop" must not read as the blue live-affordance accent.
     */
    readonly dropTarget: string
    /** Subtle dot marking non-default values hidden by a collapsed section. */
    readonly modifiedIndicator: string
    /**
     * Companion (propagated) value text: what a link-driven input WOULD
     * execute with, rendered read-only in neutral italic text in place of
     * the dormant stored value.
     */
    readonly companionValue: string
    /**
     * Stale/unproven companion text. Theme authors must keep this semantic
     * token AA-contrasting against widgetBackground; it is not an
     * interaction, progress, or data-type accent.
     */
    readonly companionUnproven: string
    /**
     * Mirror-estimate companion text: a value the frontend computed locally
     * from a schema-declared mirror, never recorded by an execution. Keep it
     * AA-contrasting against widgetBackground and distinct from both
     * companionValue and companionUnproven.
     */
    readonly companionEstimate: string
    /** Header chip naming a muted node's execution mode. */
    readonly mutedBadge: string
    /** Header chip naming a bypassed node's execution mode. */
    readonly bypassedBadge: string
    /**
     * Translucent wash over a BYPASSED node's body: bypass forwards values
     * through, so the purple tint (ComfyUI's convention) distinguishes it
     * from a muted node while both modes share the same dimming.
     */
    readonly bypassWash: string
    /**
     * Diagnostics paint: proven type-mismatch noodles and warned pins.
     * Distinct from stateColors.error (node RUN state) - this marks
     * document-level problems the solver proved, independent of execution.
     */
    readonly error: string
    /** Execution-blocking document warning, shared by its badge and outline. */
    readonly blockingWarning: string
  }
  /** Data-type -> pin/link color. Unknown types get a stable hashed hue. */
  readonly typeColors: Readonly<Record<string, string>>
  readonly stateColors: Readonly<Record<NodeRunState, string>>
  readonly progressBar: string
}

export const defaultTokens: DesignTokens = {
  rowHeight: 24,
  headerHeight: 28,
  padX: 10,
  padBottom: 8,
  previewDefaultHeight: 180,
  previewMinHeight: 40,
  previewCaptionHeight: 22,
  previewGap: 6,
  mediaTransportHeight: 64,
  mediaControlMinScale: 0.75,
  nodeMinWidth: 140,
  nodeMaxAutoWidth: 420,
  pinRadius: 5.5,
  cornerRadius: 6,
  fontFamily: canvasSemanticTokens.type.fontFamily,
  fontSize: 12,
  titleFontSize: 13,
  // Comfy-style prompt fields use 14px type with readable 20px leading and
  // 6px inset. Their 18px label band reduces dead space without changing
  // the independent 12px/24px compact-row rhythm.
  multilineText: {
    fontSize: 14,
    lineHeight: 20,
    padding: 6,
    labelHeight: 18,
    scrollbarWidth: 6,
    scrollbarInset: 2,
  },
  colors: canvasColorsForTheme('dark'),
  typeColors: {
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
    STRING: '#2E7D32',
    INT: '#7B1FA2',
    FLOAT: '#00838F',
    BOOLEAN: '#C2185B',
    'COMBO': '#5D4037',
    AUDIO: '#1565C0',
  },
  stateColors: {
    pending: '#5c5c5c',
    running: canvasSemanticTokens.meaning.info.border,
    cached: '#9575cd',
    done: canvasSemanticTokens.meaning.success.border,
    error: canvasSemanticTokens.meaning.danger.border,
    // Normal non-error state (first-class absence), visually calm - never red.
    skipped: canvasSemanticTokens.text.muted,
  },
  progressBar: canvasSemanticTokens.meaning.info.border,
}

export function canvasColorsForTheme(theme: 'dark' | 'light'): DesignTokens['colors'] {
  const tokens = semanticTokensForTheme(theme)
  return {
    canvasBackground: tokens.surface.canvas,
    gridDot: tokens.border.subtle,
    nodeBody: tokens.surface.raised,
    nodeHeader: tokens.surface.panel,
    nodeOutline: tokens.border.strong,
    nodeBorder: tokens.border.subtle,
    nodeSelectedBorder: tokens.border.selected,
    groupDefault: tokens.border.strong,
    title: tokens.text.primary,
    label: tokens.text.secondary,
    value: tokens.text.primary,
    widgetBackground: tokens.surface.inset,
    widgetAffordance: tokens.text.disabled,
    widgetAffordanceActive: tokens.border.focus,
    widgetRangeFill: tokens.interaction.selectedOverlay,
    // Link and execution-mode semantics do not change with shell themes.
    linkDefault: '#8d9aa5',
    mutedBadge: '#4a4a5e',
    bypassedBadge: '#69449a',
    bypassWash: 'rgba(147, 88, 220, 0.28)',
    selection: tokens.border.focus,
    dropTarget: tokens.border.selected,
    modifiedIndicator: tokens.meaning.warning.border,
    companionValue: tokens.text.secondary,
    companionUnproven: tokens.meaning.info.foreground,
    companionEstimate: tokens.meaning.success.foreground,
    error: tokens.meaning.danger.border,
    blockingWarning: tokens.meaning.warning.border,
  }
}

/**
 * Display aliases for the existing ComfyUI image and mask bridges.
 * Consulted by BOTH the label and the color lookup so name and color
 * can never disagree. Presentation only - never use these for compatibility
 * decisions; type ids in documents, wire payloads, and persistence are
 * unchanged.
 */
export const typeDisplayAliases: Readonly<Record<string, string>> = Object.freeze(
  // Null prototype so lookups by arbitrary type names (e.g. 'constructor')
  // can never resolve to inherited Object.prototype members.
  Object.assign(Object.create(null) as Record<string, string>, {
    'comfy.IMAGE': 'IMAGE',
    'comfy.MASK': 'MASK',
  }),
)

const EMPTY_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.create(null))

/**
 * Display label for a canonical type-id STRING: the base element is aliased
 * through typeDisplayAliases while list/asset wrappers are kept. Presentation
 * only - the input remains the canonical value for matching and persistence.
 */
export const typeIdDisplayLabel = (typeId: string): string => {
  const listInner = parseListTypeId(typeId)
  if (listInner !== undefined) return `list<${typeIdDisplayLabel(listInner)}>`
  const assetInner = parseAssetTypeId(typeId)
  if (assetInner !== undefined) return `asset<${typeIdDisplayLabel(assetInner)}>`
  return typeDisplayAliases[typeId] ?? typeId
}

/** Stable fallback color for unlisted data types. */
export function typeColor(tokens: DesignTokens, typeName: string): string {
  // A structured type colors as its base element type ('list<IMAGE>' and
  // 'asset<IMAGE>' -> IMAGE's color): users track WHAT data flows by color;
  // list-ness/asset-ness is a label/badge concern. Peeling nests until the
  // base element (single canonical parser, core-owned).
  let base = typeName
  for (let inner = parseListTypeId(base) ?? parseAssetTypeId(base); inner !== undefined; inner = parseListTypeId(base) ?? parseAssetTypeId(base)) base = inner
  base = typeDisplayAliases[base] ?? base
  const namespaced = base.startsWith('comfy.') || base.startsWith('core.')
    ? base.slice(base.indexOf('.') + 1)
    : base
  // Own-property reads only: typeColors is a plain object, so a type named
  // like an inherited member (e.g. 'constructor') must miss, not resolve.
  const colorOf = (key: string): string | undefined =>
    Object.hasOwn(tokens.typeColors, key) ? tokens.typeColors[key] : undefined
  const known = colorOf(base) ?? colorOf(namespaced.toUpperCase())
  if (known) return known
  let h = 0
  for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0
  // The hsl() form cannot exactly collide with any hex table entry.
  return `hsl(${h % 360} 45% 62%)`
}

export interface PresentedType {
  /** Canonical semantic identity, when the TypeExpr is recursively closed. */
  readonly canonicalName?: string
  /** Presentation label only. Never use this for compatibility decisions. */
  readonly label: string
  readonly color: string
  readonly tooltip: string
}

/** Display label for a TypeExpr without changing its semantic identity. */
const typeExprLabelWith = (type: TypeExpr, aliases: Readonly<Record<string, string>>): string => {
  switch (type.kind) {
    case 'concrete': return aliases[type.name] ?? type.name
    case 'union': return type.names.map((name) => aliases[name] ?? name).join(' | ')
    case 'wildcard': return 'Any'
    case 'tuple': return `tuple<${type.elements.map((element, index) => `${index}: ${typeExprLabelWith(element, aliases)}`).join(', ')}>`
    case 'family_tuple': return `tuple<${type.input}>`
    case 'tuple_element': return `${type.element === undefined ? type.input : typeExprLabelWith(type.element, aliases)}[${type.index}]`
    case 'variable':
      return type.allowedTypes !== undefined && type.allowedTypes.length > 0
        ? type.allowedTypes.map((allowed) => typeExprLabelWith(allowed, aliases)).join(' | ')
        : type.templateId
    case 'list': return `list<${typeExprLabelWith(type.element, aliases)}>`
    case 'asset': return `asset<${typeExprLabelWith(type.element, aliases)}>`
    case 'stream': return `stream<${typeExprLabelWith(type.element, aliases)}>`
  }
}

const typeExprLabel = (type: TypeExpr): string => typeExprLabelWith(type, typeDisplayAliases)

/**
 * Canonical (unaliased) rendering of a TypeExpr. Use for values that must
 * later match canonical type ids (e.g. search filter tokens), never for
 * user-facing labels.
 */
export const typeExprCanonicalLabel = (type: TypeExpr): string => typeExprLabelWith(type, EMPTY_ALIASES)

/**
 * One presentation boundary for pin labels, colors, and tooltip hints.
 * COMBO keeps a plain string payload while remaining its own socket type.
 */
export function presentedType(
  tokens: DesignTokens,
  type: TypeExpr,
): PresentedType {
  const canonicalName = canonicalTypeIdOf(type)
  if (canonicalName === 'COMBO') {
    return {
      ...(canonicalName !== undefined ? { canonicalName } : {}),
      label: 'COMBO',
      color: typeColor(tokens, 'COMBO'),
      tooltip: 'COMBO (string with choices)',
    }
  }
  if (type.kind === 'wildcard') {
    return {
      label: 'Any',
      color: tokens.colors.linkDefault,
      tooltip: 'Any type; this port accepts values independently and does not determine other ports.',
    }
  }
  if (type.kind === 'variable' && (type.allowedTypes === undefined || type.allowedTypes.length === 0)) {
    return {
      label: type.templateId,
      color: tokens.colors.linkDefault,
      tooltip: `Match type ${type.templateId}; every ${type.templateId} port on this node resolves together.`,
    }
  }
  const label = typeExprLabel(type)
  return {
    ...(canonicalName !== undefined ? { canonicalName } : {}),
    label,
    color: canonicalName === undefined ? tokens.colors.linkDefault : typeColor(tokens, canonicalName),
    // An aliased display name keeps the canonical id visible as secondary
    // technical detail so the underlying type is never hidden.
    tooltip: canonicalName !== undefined && typeDisplayAliases[canonicalName] !== undefined
      ? `${label} (${canonicalName})`
      : label,
  }
}
