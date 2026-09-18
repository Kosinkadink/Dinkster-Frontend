/**
 * Design tokens: the single style source shared by canvas rendering and
 * (later) DOM widgets, so in-canvas and DOM presentation match. Values are a
 * first pass; the token SET is the commitment, the values are tunable.
 */

import { canvasSemanticTokens, canonicalTypeIdOf, parseAssetTypeId, parseListTypeId, type NodeRunState, type TypeExpr } from '@dinkster/core'

/** Minimum zoom for text detail and transient media DOM. */
export const CANVAS_DETAIL_MIN_SCALE = 0.5

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
  colors: {
    canvasBackground: canvasSemanticTokens.surface.canvas,
    gridDot: canvasSemanticTokens.border.subtle,
    nodeBody: canvasSemanticTokens.surface.raised,
    nodeHeader: canvasSemanticTokens.surface.panel,
    nodeOutline: canvasSemanticTokens.border.strong,
    nodeBorder: canvasSemanticTokens.border.subtle,
    // Selection outlines/halos everywhere (nodes, selectors, reroutes,
    // noodles, value sources): white, so "selected" never reads as the blue
    // live-affordance accent below.
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
    companionEstimate: canvasSemanticTokens.meaning.success.foreground,
    mutedBadge: '#4a4a5e',
    bypassedBadge: '#69449a',
    bypassWash: 'rgba(147, 88, 220, 0.28)',
    // Same hue as stateColors.error so "problem" reads as one color family.
    error: canvasSemanticTokens.meaning.danger.border,
    blockingWarning: canvasSemanticTokens.meaning.warning.border,
  },
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
    'core.combo': '#5D4037',
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

/**
 * Display aliases mapping native dinkster boundary type ids to their ComfyUI
 * names. Consulted by BOTH the label and the color lookup so name and color
 * can never disagree. Presentation only - never use these for compatibility
 * decisions; type ids in documents, wire payloads, and persistence are
 * unchanged.
 */
export const typeDisplayAliases: Readonly<Record<string, string>> = Object.freeze(
  // Null prototype so lookups by arbitrary type names (e.g. 'constructor')
  // can never resolve to inherited Object.prototype members.
  Object.assign(Object.create(null) as Record<string, string>, {
    'dinkster.model': 'MODEL',
    'dinkster.conditioning': 'CONDITIONING',
    'dinkster.image': 'IMAGE',
    // comfy.IMAGE and dinkster.image are one value type (the backend registers
    // both ids with the same codec), and compatibility math canonicalizes to
    // the comfy spelling - so both spellings must present as the same IMAGE.
    // The same holds for the comfy.MASK/dinkster.mask pair.
    'comfy.IMAGE': 'IMAGE',
    'dinkster.mask': 'MASK',
    'comfy.MASK': 'MASK',
    'dinkster.latent': 'LATENT',
    'dinkster.control': 'CONTROL_NET',
    'dinkster.clip': 'CLIP',
    'dinkster.vae': 'VAE',
    'dinkster.sampler': 'SAMPLER',
    'dinkster.sigmas': 'SIGMAS',
    'dinkster.guider': 'GUIDER',
    'dinkster.noise': 'NOISE',
    // Pre-rename spellings of dinkster.clip/dinkster.vae: kept so a backend that
    // still serves the old ids presents the same label and color.
    'dinkster.text_encoder': 'CLIP',
    'dinkster.codec': 'VAE',
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
 * core.combo keeps a plain string payload while remaining its own socket type.
 */
export function presentedType(
  tokens: DesignTokens,
  type: TypeExpr,
): PresentedType {
  const canonicalName = canonicalTypeIdOf(type)
  if (canonicalName === 'core.combo') {
    return {
      ...(canonicalName !== undefined ? { canonicalName } : {}),
      label: 'COMBO',
      color: typeColor(tokens, 'core.combo'),
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
