/**
 * Node badges: small header chips (subgraph marker, execution error, ...)
 * drawn by the renderer and hit-tested BEFORE any other gesture so a badge
 * click never starts a drag. One typed layer for every badge kind - core and
 * extensions contribute the same plain data, the host decides what a click
 * shows. Badges are pure view state; they never touch the document.
 */

import type { Scene, SceneNode } from './scene.js'
import { canvasPaintTokens, defaultTokens, type DesignTokens } from './tokens.js'
import type { CanvasIconName } from './toolbox.js'

export interface NodeBadge {
  /** Stable namespaced id ('core.subgraph', 'core.error', 'vhs.timeline'). */
  readonly id: string
  /** Glyph or short status word drawn in the chip. */
  readonly glyph: string
  /** Glyph used when icon painting fails and the visible label has another meaning. */
  readonly fallbackGlyph?: string
  /** Label chips grow to fit status wording; compact is the default. */
  readonly variant?: 'label'
  /** Policy tabs use a quieter solid color than observed execution state. */
  readonly appearance?: 'policy'
  /**
   * Chips outside the node body: 'above' tabs sit flush on the top edge
   * (right-aligned), 'below' tabs sit flush on the bottom edge
   * (left-aligned). Omitted = header lane inside the title row.
   */
  readonly placement?: 'above' | 'below'
  /** False for presentation-only chips that must not intercept node gestures. */
  readonly interactive?: false
  /** Chip fill color. */
  readonly color: string
  /** Core vector icon drawn instead of, or beside, the fallback glyph. */
  readonly icon?: CanvasIconName
}

/** node id -> badges; index 0 renders rightmost in the header. */
export type BadgeMap = Readonly<Record<string, readonly NodeBadge[]>>

/** Strongest document problem anchored to each exact input pin id. */
export type PortProblemKind = 'error' | 'blocking-warning' | 'warning'
export type PortProblemMap = Readonly<Record<string, Readonly<Record<string, PortProblemKind>>>>

export const BADGE_SIZE = canvasPaintTokens.badge.size
/** Horizontal distance between badge origins. */
export const BADGE_STRIDE = canvasPaintTokens.badge.stride
const BADGE_GAP = BADGE_STRIDE - BADGE_SIZE
/** Right inset of the FIRST badge from the node's right edge. */
export const BADGE_RIGHT_INSET = canvasPaintTokens.badge.rightInset
export const SUBGRAPH_BADGE: NodeBadge = { id: 'core.subgraph', glyph: 'S', icon: 'boxes', color: canvasPaintTokens.badge.colors.subgraph }
export const subgraphBadge = (occurrences: number): NodeBadge => occurrences >= 2
  ? { ...SUBGRAPH_BADGE, glyph: String(occurrences), fallbackGlyph: SUBGRAPH_BADGE.glyph, variant: 'label' }
  : SUBGRAPH_BADGE
export const ERROR_BADGE: NodeBadge = { id: 'core.error', glyph: 'Error', variant: 'label', color: canvasPaintTokens.badge.colors.executionError }
/**
 * Runtime error tab on the node's bottom edge - the ONE visual for the job
 * error report (never a log level). Count > 1 surfaces multiple diagnostics
 * anchored to the node.
 */
export const executionErrorBadge = (count: number): NodeBadge => ({
  ...ERROR_BADGE,
  placement: 'below',
  glyph: count > 1 ? `Error ${count}` : 'Error',
  fallbackGlyph: ERROR_BADGE.glyph,
})
/** One engine explanation for the root absence that blocked this node. */
export const executionBlockedBadge = (message: string): NodeBadge => ({
  id: 'core.execution.blocked',
  glyph: `Blocked: ${message}`,
  variant: 'label',
  placement: 'below',
  interactive: false,
  color: canvasPaintTokens.badge.colors.warning,
})
/** Runtime work created under a parent node during this execution. */
export const executionExpandedBadge = (childCount: number): NodeBadge => ({
  id: 'core.execution.expanded',
  glyph: `${childCount} child${childCount === 1 ? '' : 'ren'}`,
  variant: 'label',
  placement: 'below',
  interactive: false,
  color: canvasPaintTokens.badge.colors.expanded,
})
/** Bottom tab counting the node's warning log records this run. */
export const logWarningBadge = (count: number): NodeBadge => ({
  id: 'core.log.warning',
  glyph: count > 1 ? `Warning ${count}` : 'Warning',
  fallbackGlyph: 'Warning',
  variant: 'label',
  placement: 'below',
  color: canvasPaintTokens.badge.colors.warning,
})
/** Bottom dot marking that the node produced runtime messages this run. */
export const LOG_INFO_BADGE: NodeBadge = {
  id: 'core.log.info',
  glyph: 'i',
  placement: 'below',
  color: canvasPaintTokens.badge.colors.info,
}
export const MUTED_BADGE: NodeBadge = {
  id: 'core.mode.muted',
  glyph: 'Muted',
  variant: 'label',
  interactive: false,
  color: defaultTokens.colors.mutedBadge,
}
export const BYPASSED_BADGE: NodeBadge = {
  id: 'core.mode.bypassed',
  glyph: 'Bypassed',
  variant: 'label',
  interactive: false,
  color: defaultTokens.colors.bypassedBadge,
}
/** Document diagnostic badges, separate from the runtime ERROR_BADGE. */
export const PROBLEM_ERROR_BADGE: NodeBadge = {
  id: 'core.problem.error',
  glyph: 'Error',
  variant: 'label',
  color: canvasPaintTokens.badge.colors.documentError,
}
export const PROBLEM_BLOCKING_WARNING_BADGE: NodeBadge = {
  id: 'core.problem.blocking-warning',
  glyph: '!',
  color: defaultTokens.colors.blockingWarning,
}
export const PROBLEM_WARNING_BADGE: NodeBadge = { id: 'core.problem.warning', glyph: 'W', color: canvasPaintTokens.badge.colors.warning }
/** Deprecated node type; popover shows the successor + apply-replacement. */
export const DEPRECATED_BADGE: NodeBadge = { id: 'core.deprecated', glyph: 'D', color: canvasPaintTokens.badge.colors.warning }

export interface BadgeRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const badgeWidth = (badge: NodeBadge): number =>
  badge.variant === 'label' ? Math.ceil(badge.glyph.length * canvasPaintTokens.badge.characterWidth) + canvasPaintTokens.badge.labelPadding + (badge.icon === undefined ? 0 : canvasPaintTokens.badge.iconWidth) : BADGE_SIZE

/** Width reserved beside a minimized title for badges inside the header. */
export const headerBadgeLaneWidth = (badges: readonly NodeBadge[], tokens: DesignTokens = defaultTokens): number => {
  const headerBadges = badges.filter((badge) => badge.placement === undefined)
  return headerBadges.reduce((total, badge) => total + (tokens.badgeLayout === 'tabs' ? BADGE_SIZE : badgeWidth(badge)), 0) +
    Math.max(0, headerBadges.length - 1) * BADGE_GAP
}

/** World-space rect of the badge at `index` (0 = rightmost in its lane) on a node. */
export function badgeRect(
  node: SceneNode,
  index: number,
  badges?: readonly NodeBadge[],
): BadgeRect {
  const badge = badges?.[index]
  const width = badge === undefined ? BADGE_SIZE : badgeWidth(badge)
  const placement = badge?.placement
  const precedingWidth = badges === undefined
    ? index * BADGE_STRIDE
    : badges.slice(0, index)
        .filter((preceding) => preceding.placement === placement)
        .reduce((total, preceding) => total + badgeWidth(preceding) + BADGE_GAP, 0)
  return {
    x: placement === 'above'
      ? node.x + node.layout.width - width - precedingWidth
      : placement === 'below'
        ? node.x + precedingWidth
        : node.x + node.layout.width - BADGE_RIGHT_INSET + BADGE_SIZE - width - precedingWidth,
    y: placement === 'above'
      ? node.y - BADGE_SIZE
      : placement === 'below'
        ? node.y + node.layout.height
        : node.y + node.layout.headerHeight / 2 - BADGE_SIZE / 2,
    width,
    height: BADGE_SIZE,
  }
}

export interface BadgePlacement extends BadgeRect {
  readonly badge: NodeBadge
  readonly compact: boolean
  /** Original badges behind an overflow tab, in priority order. */
  readonly overflow?: readonly NodeBadge[]
}

export interface BadgeLayoutOptions {
  readonly tokens: DesignTokens
  /** Outer painted outline edge, in world units from the node body. */
  readonly outset?: number
  readonly hoveredId?: string
}

/** Shared placement for paint, pointer targets and conservative visual bounds. */
export function layoutNodeBadges(
  node: SceneNode,
  badges: readonly NodeBadge[],
  options: BadgeLayoutOptions,
): readonly BadgePlacement[] {
  if (options.tokens.badgeLayout === 'chips') return badges.map((badge, index) => ({
    ...badgeRect(node, index, badges), badge, compact: badge.variant !== 'label',
  }))
  const paint = canvasPaintTokens.badge.tab
  const inset = Math.min(paint.inset, node.layout.width / 2)
  const available = Math.max(0, node.layout.width - inset * 2)
  const strip = paint.padding * 2 + paint.iconSize
  const fullWidth = (badge: NodeBadge): number => Math.min(available,
    paint.padding * 2 + paint.iconSize + paint.iconGap + Math.min(paint.maxLabelWidth, badge.glyph.length * paint.fontSize))
  const result: BadgePlacement[] = []
  const header = badges.filter((badge) => badge.placement === undefined)
  const headerCount = Math.min(header.length, Math.floor((available + BADGE_GAP) / BADGE_STRIDE))
  const headerOverflow = header.length > headerCount ? header.slice(Math.max(0, headerCount - 1)) : []
  for (let index = 0; index < headerCount; index++) {
    const folded = headerOverflow.length > 0 && index === headerCount - 1
    result.push({
      ...badgeRect(node, index),
      badge: folded ? {
        id: 'core.badges.overflow.header', glyph: '+', color: options.tokens.colors.nodeBorder,
      } : header[index]!,
      compact: true,
      ...(folded ? { overflow: headerOverflow } : {}),
    })
  }
  for (const placement of ['above', 'below'] as const) {
    const lane = badges.filter((badge) => badge.placement === placement)
    if (lane.length === 0 || available <= 0) continue
    const total = (widths: readonly number[]) => widths.reduce((sum, width) => sum + width, 0) + Math.max(0, widths.length - 1) * paint.gap
    let visible = lane
    let widths = lane.map(fullWidth)
    let overflow: readonly NodeBadge[] = []
    if (total(widths) > available) {
      const count = Math.max(1, Math.floor((available + paint.gap) / (strip + paint.gap)))
      if (lane.length > count) {
        overflow = lane.slice(count - 1)
        visible = [...lane.slice(0, count - 1), {
          id: `core.badges.overflow.${placement}`, glyph: `+${overflow.length}`,
          placement, variant: 'label', color: options.tokens.colors.nodeBorder,
        }]
      }
      widths = visible.map((badge, index) => Math.min(available,
        overflow.length > 0 && index === visible.length - 1
          ? paint.padding * 2 + badge.glyph.length * paint.fontSize : strip))
      // Reserve the overflow count before returning words to priority tabs.
      while (visible.length > 1 && total(widths) > available) {
        overflow = lane.slice(visible.length - 2)
        visible = [...visible.slice(0, -2), { ...visible[visible.length - 1]!, glyph: `+${overflow.length}` }]
        widths = visible.map((badge, index) => index === visible.length - 1
          ? Math.min(available, paint.padding * 2 + badge.glyph.length * paint.fontSize) : strip)
      }
      for (let index = 0; index < visible.length - (overflow.length > 0 ? 1 : 0); index++) {
        const trial = [...widths]
        trial[index] = fullWidth(visible[index]!)
        if (total(trial) <= available) widths = trial
      }
    }
    const outset = options.outset ?? 0
    const y = placement === 'above'
      ? node.y - outset - paint.height + paint.overlap
      : node.y + node.layout.height + outset - paint.overlap
    let x = node.x + inset
    const entries = visible.map((badge, index): BadgePlacement => {
      const width = widths[index]!
      const folded = overflow.length > 0 && index === visible.length - 1
      const entry = {
        x, y, width, height: paint.height, badge,
        compact: !folded && width < fullWidth(badge),
        ...(folded ? { overflow } : {}),
      }
      x += width + paint.gap
      return entry
    })
    const hovered = entries.find((entry) => entry.badge.id === options.hoveredId)
    if (hovered && !hovered.overflow) {
      const width = fullWidth(hovered.badge)
      result.push(...entries.filter((entry) => entry !== hovered), {
        ...hovered, width, compact: false,
        x: Math.min(hovered.x, node.x + node.layout.width - inset - width),
      })
    } else result.push(...entries)
  }
  return result
}

/** Includes hovered expansion; callers apply live resize/drag geometry first. */
export function nodeBadgeBounds(node: SceneNode, badges: readonly NodeBadge[], options: BadgeLayoutOptions): BadgeRect {
  const entries = layoutNodeBadges(node, badges, options)
  const bleed = options.tokens.badgeLayout === 'tabs' ? canvasPaintTokens.badge.tab.hoverStroke / 2 : 0
  const left = Math.min(node.x, ...entries.map((entry) => entry.x - bleed))
  const top = Math.min(node.y, ...entries.map((entry) => entry.y - bleed))
  return {
    x: left, y: top,
    width: Math.max(node.x + node.layout.width, ...entries.map((entry) => entry.x + entry.width + bleed)) - left,
    height: Math.max(node.y + node.layout.height, ...entries.map((entry) => entry.y + entry.height + bleed)) - top,
  }
}

export interface BadgeHit {
  readonly node: SceneNode
  readonly badge: NodeBadge
  readonly rect: BadgeRect
  readonly overflow?: readonly NodeBadge[]
}

/** Topmost badge under a world point (nodes drawn later win, like hitTest). */
export function hitTestBadge(scene: Scene, badges: BadgeMap, wx: number, wy: number,
  layout?: (node: SceneNode, badges: readonly NodeBadge[]) => readonly BadgePlacement[],
): BadgeHit | undefined {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const node = scene.nodes[i]!
    const list = badges[node.id]
    if (list) {
      const entries = layout?.(node, list)
      for (let index = 0; index < (entries?.length ?? list.length); index++) {
        const entry = entries?.[entries.length - 1 - index]
        const badge = entry?.badge ?? list[index]!
        if (badge.interactive === false) continue
        const rect = entry ? { x: entry.x, y: entry.y, width: entry.width, height: entry.height }
          : badgeRect(node, index, list)
        if (wx >= rect.x && wx <= rect.x + rect.width && wy >= rect.y && wy <= rect.y + rect.height) {
          return { node, badge, rect, ...(entry?.overflow ? { overflow: entry.overflow } : {}) }
        }
      }
    }
    // A later-drawn node body occludes badges belonging to nodes below it.
    if (wx >= node.x && wx <= node.x + node.layout.width && wy >= node.y && wy <= node.y + node.layout.height) return undefined
  }
  return undefined
}
