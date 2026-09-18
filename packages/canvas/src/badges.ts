/**
 * Node badges: small header chips (subgraph marker, execution error, ...)
 * drawn by the renderer and hit-tested BEFORE any other gesture so a badge
 * click never starts a drag. One typed layer for every badge kind - core and
 * extensions contribute the same plain data, the host decides what a click
 * shows. Badges are pure view state; they never touch the document.
 */

import type { Scene, SceneNode } from './scene.js'
import { defaultTokens } from './tokens.js'
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

export const BADGE_SIZE = 14
/** Horizontal distance between badge origins. */
export const BADGE_STRIDE = 18
const BADGE_GAP = BADGE_STRIDE - BADGE_SIZE
/** Right inset of the FIRST badge from the node's right edge. */
export const BADGE_RIGHT_INSET = 22
export const SUBGRAPH_BADGE: NodeBadge = { id: 'core.subgraph', glyph: 'S', icon: 'boxes', color: '#4a4a5e' }
export const subgraphBadge = (occurrences: number): NodeBadge => occurrences >= 2
  ? { ...SUBGRAPH_BADGE, glyph: String(occurrences), fallbackGlyph: SUBGRAPH_BADGE.glyph, variant: 'label' }
  : SUBGRAPH_BADGE
export const ERROR_BADGE: NodeBadge = { id: 'core.error', glyph: 'Error', variant: 'label', color: '#b3402f' }
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
/** Bottom tab counting the node's warning log records this run. */
export const logWarningBadge = (count: number): NodeBadge => ({
  id: 'core.log.warning',
  glyph: count > 1 ? `Warning ${count}` : 'Warning',
  fallbackGlyph: 'Warning',
  variant: 'label',
  placement: 'below',
  color: '#8a6d1f',
})
/** Bottom dot marking that the node produced runtime messages this run. */
export const LOG_INFO_BADGE: NodeBadge = {
  id: 'core.log.info',
  glyph: 'i',
  placement: 'below',
  color: '#3a5a68',
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
  color: '#c13f32',
}
export const PROBLEM_BLOCKING_WARNING_BADGE: NodeBadge = {
  id: 'core.problem.blocking-warning',
  glyph: '!',
  color: defaultTokens.colors.blockingWarning,
}
export const PROBLEM_WARNING_BADGE: NodeBadge = { id: 'core.problem.warning', glyph: 'W', color: '#8a6d1f' }
/** Deprecated node type; popover shows the successor + apply-replacement. */
export const DEPRECATED_BADGE: NodeBadge = { id: 'core.deprecated', glyph: 'D', color: '#8a6d1f' }

export interface BadgeRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

const badgeWidth = (badge: NodeBadge): number =>
  badge.variant === 'label' ? Math.ceil(badge.glyph.length * 5.5) + 10 + (badge.icon === undefined ? 0 : 10) : BADGE_SIZE

/** Width reserved beside a minimized title for badges inside the header. */
export const headerBadgeLaneWidth = (badges: readonly NodeBadge[]): number => {
  const headerBadges = badges.filter((badge) => badge.placement === undefined)
  return headerBadges.reduce((total, badge) => total + badgeWidth(badge), 0) +
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

export interface BadgeHit {
  readonly node: SceneNode
  readonly badge: NodeBadge
  readonly rect: BadgeRect
}

/** Topmost badge under a world point (nodes drawn later win, like hitTest). */
export function hitTestBadge(scene: Scene, badges: BadgeMap, wx: number, wy: number): BadgeHit | undefined {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const node = scene.nodes[i]!
    const list = badges[node.id]
    if (list) {
      for (const [index, badge] of list.entries()) {
        if (badge.interactive === false) continue
        const r = badgeRect(node, index, list)
        if (wx >= r.x && wx <= r.x + r.width && wy >= r.y && wy <= r.y + r.height) {
          return { node, badge, rect: r }
        }
      }
    }
    // A later-drawn node body occludes badges belonging to nodes below it.
    if (wx >= node.x && wx <= node.x + node.layout.width && wy >= node.y && wy <= node.y + node.layout.height) return undefined
  }
  return undefined
}
