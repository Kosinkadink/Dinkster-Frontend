/**
 * Node badges: tabs above and below a node (its run state, problems, mode,
 * deprecation, what a pack adds) and the subgraph mark in the title bar,
 * drawn by the renderer and hit-tested BEFORE any other gesture so a badge
 * click never starts a drag. One typed layer for every badge kind - core and
 * extensions contribute the same plain data, the host decides what a click
 * shows. Badges are pure view state; they never touch the document.
 */

import type { NodeProgress, NodeRunState } from '@dinkster/core'
import type { Scene, SceneNode } from './scene.js'
import { CANVAS_DETAIL_MIN_SCALE, canvasPaintTokens, defaultTokens, type DesignTokens } from './tokens.js'
import type { CanvasIconName } from './toolbox.js'

export interface NodeBadge {
  /** Stable namespaced id ('core.subgraph', 'core.error', 'vhs.timeline'). */
  readonly id: string
  /** The tab's words; a title mark shows only its icon and count. */
  readonly glyph: string
  /**
   * 'above' (the default): a tab over the node, the first one at its right
   * end. 'below': a tab under the node, the first one at its left end.
   * 'title': a mark at the right end of the title bar, which only core sets.
   */
  readonly placement?: 'above' | 'below' | 'title'
  /** False for presentation-only tabs that must not intercept node gestures. */
  readonly interactive?: false
  /** The tab's color: its line, icon and words, and a tint of it as its fill. */
  readonly color: string
  /** Vector icon before the words. */
  readonly icon?: CanvasIconName
  /** A number a title mark paints after its icon. */
  readonly count?: number
}

/** node id -> badges; each lane lays out in list order from its start. */
export type BadgeMap = Readonly<Record<string, readonly NodeBadge[]>>

const executionStateLabels: Readonly<Record<NodeRunState, { glyph: string; icon: CanvasIconName }>> = {
  pending: { glyph: 'Queued', icon: 'clock' },
  running: { glyph: 'Running', icon: 'play' },
  done: { glyph: 'Finished', icon: 'check' },
  cached: { glyph: 'Cached', icon: 'database' },
  skipped: { glyph: 'Skipped', icon: 'ban' },
  error: { glyph: 'Failed', icon: 'circle-x' },
}

/** Apply view visibility after runtime occurrences have been projected and aggregated. */
export function executionNodePresentation(
  projected: Readonly<Record<string, NodeProgress>>,
  frozen: boolean,
  tokens: DesignTokens,
): { states: Record<string, NodeProgress>; badges: BadgeMap } {
  const states: Record<string, NodeProgress> = {}
  const badges: Record<string, NodeBadge[]> = {}
  for (const [id, progress] of Object.entries(projected)) {
    if (!frozen && progress.state !== 'running' && progress.state !== 'error') continue
    states[id] = progress
    badges[id] = [{
      id: `core.execution.state.${progress.state}`,
      ...executionStateLabels[progress.state],
      placement: 'below',
      color: tokens.stateColors[progress.state],
    }]
  }
  return { states, badges }
}

/** A problem that stops a run is an error; every other problem is a warning. */
export type ProblemKind = 'error' | 'warning'
/**
 * Strongest problem per node per row. A row is keyed by its stored value key,
 * by its input port id for an input drawn without a field, or by
 * outputRowKey for an output.
 */
export type RowProblemMap = Readonly<Record<string, Readonly<Record<string, ProblemKind>>>>
/** The row key of an output, kept apart from an input with the same port id. */
export const outputRowKey = (portId: string): string => `\u0000output\u0000${portId}`

export const SUBGRAPH_BADGE: NodeBadge = { id: 'core.subgraph', glyph: 'Subgraph', icon: 'subgraph', placement: 'title', color: canvasPaintTokens.badge.colors.subgraph }
export const subgraphBadge = (occurrences: number): NodeBadge => occurrences >= 2
  ? { ...SUBGRAPH_BADGE, count: occurrences }
  : SUBGRAPH_BADGE
export const ERROR_BADGE: NodeBadge = { id: 'core.error', glyph: 'Error', icon: 'circle-x', placement: 'below', color: canvasPaintTokens.badge.colors.executionError }
/**
 * Runtime error tab on the node's bottom edge - the ONE visual for the job
 * error report (never a log level). Count > 1 surfaces multiple diagnostics
 * anchored to the node.
 */
export const executionErrorBadge = (count: number): NodeBadge => ({
  ...ERROR_BADGE,
  glyph: count > 1 ? `Error ${count}` : 'Error',
})
/**
 * The run's error tab once the node has changed since that run: drawn in the
 * theme's label gray with no count, opening the same runtime details.
 */
export const LAST_RUN_BADGE: NodeBadge = {
  id: 'core.error.lastRun',
  glyph: 'Last run',
  icon: 'circle-x',
  placement: 'below',
  color: defaultTokens.colors.label,
}
/** One engine explanation for the root absence that blocked this node. */
export const executionBlockedBadge = (message: string): NodeBadge => ({
  id: 'core.execution.blocked',
  glyph: `Blocked: ${message}`,
  icon: 'lock',
  placement: 'below',
  interactive: false,
  color: canvasPaintTokens.badge.colors.warning,
})
/** Runtime work created under a parent node during this execution. */
export const executionExpandedBadge = (childCount: number): NodeBadge => ({
  id: 'core.execution.expanded',
  glyph: `${childCount} child${childCount === 1 ? '' : 'ren'}`,
  icon: 'list-tree',
  placement: 'below',
  interactive: false,
  color: canvasPaintTokens.badge.colors.expanded,
})
/** Bottom tab counting the node's warning log records this run. */
export const logWarningBadge = (count: number): NodeBadge => ({
  id: 'core.log.warning',
  glyph: count > 1 ? `Warning ${count}` : 'Warning',
  icon: 'triangle-alert',
  placement: 'below',
  color: canvasPaintTokens.badge.colors.warning,
})
/** Bottom tab marking that the node produced runtime messages this run. */
export const LOG_INFO_BADGE: NodeBadge = {
  id: 'core.log.info',
  glyph: 'Log',
  icon: 'scroll-text',
  placement: 'below',
  color: canvasPaintTokens.badge.colors.info,
}
export const MUTED_BADGE: NodeBadge = {
  id: 'core.mode.muted',
  glyph: 'Muted',
  icon: 'volume-x',
  interactive: false,
  color: defaultTokens.colors.mutedBadge,
}
export const BYPASSED_BADGE: NodeBadge = {
  id: 'core.mode.bypassed',
  glyph: 'Bypassed',
  icon: 'forward',
  interactive: false,
  color: defaultTokens.colors.bypassedBadge,
}
/** Document diagnostic badges, separate from the runtime ERROR_BADGE. */
export const PROBLEM_ERROR_BADGE: NodeBadge = {
  id: 'core.problem.error',
  glyph: 'Error',
  icon: 'circle-x',
  placement: 'below',
  color: canvasPaintTokens.badge.colors.documentError,
}
/** A document error whose node cannot run here. */
export const UNAVAILABLE_BADGE: NodeBadge = { ...PROBLEM_ERROR_BADGE, glyph: 'Unavailable', icon: 'unplug' }
export const PROBLEM_WARNING_BADGE: NodeBadge = {
  id: 'core.problem.warning',
  glyph: 'Warning',
  icon: 'triangle-alert',
  placement: 'below',
  color: canvasPaintTokens.badge.colors.warning,
}
/** A problem tab that counts the separate causes behind it. */
export const problemBadge = (base: NodeBadge, count: number): NodeBadge => ({
  ...base,
  glyph: count > 1 ? `${base.glyph} ${count}` : base.glyph,
})
/** A media conversion that lost or reinterpreted data at one pin this run. */
export const mediaDiagnosticBadge = (id: string, glyph: string): NodeBadge => ({
  id,
  glyph,
  icon: 'triangle-alert',
  placement: 'below',
  interactive: false,
  color: canvasPaintTokens.badge.colors.warning,
})
/** Which pass of a repeating region the node's shown result came from. */
export const regionIterationBadge = (label: string): NodeBadge => ({
  id: 'core.region.iteration',
  glyph: label,
  icon: 'repeat',
  placement: 'below',
  interactive: false,
  color: canvasPaintTokens.badge.colors.expanded,
})
/** Deprecated node type; popover shows the successor + apply-replacement. */
export const DEPRECATED_BADGE: NodeBadge = { id: 'core.deprecated', glyph: 'Deprecated', icon: 'archive', color: canvasPaintTokens.badge.colors.warning }

export interface BadgeRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface BadgePlacement extends BadgeRect {
  readonly badge: NodeBadge
  /** A tab narrowed to its icon because its lane is full. */
  readonly compact: boolean
  /** Original badges behind an overflow tab, in priority order. */
  readonly overflow?: readonly NodeBadge[]
  /** Where a tab grown by hover rests; pointer targets use it before the grown rect. */
  readonly rest?: BadgeRect
}

export interface BadgeLayoutOptions {
  readonly tokens: DesignTokens
  /** Outer painted outline edge, in world units from the node body. */
  readonly outset?: number
  readonly hoveredId?: string
  /**
   * Width of a tab's text in the tab font. Paint, pointer targets and bounds
   * pass the same measure; without one a character counts as one font size.
   */
  readonly measureLabel?: (text: string) => number
}

/** Shared placement for paint, pointer targets and visual bounds. */
export function layoutNodeBadges(
  node: SceneNode,
  badges: readonly NodeBadge[],
  options: BadgeLayoutOptions,
): readonly BadgePlacement[] {
  const paint = { ...canvasPaintTokens.badge.tab, ...options.tokens.badgeTab }
  const mark = canvasPaintTokens.badge.mark
  const labelWidth = (text: string): number => Math.ceil(options.measureLabel?.(text) ?? text.length * paint.fontSize)
  const result: BadgePlacement[] = []

  // The mark sits as far from the node's right edge as from the bar's top and bottom.
  let markRight = node.x + node.layout.width - (node.layout.headerHeight - mark.size) / 2
  for (const badge of badges) {
    if (badge.placement !== 'title') continue
    const width = badge.count === undefined
      ? mark.size
      : mark.padding * 2 + mark.iconSize + mark.gap + labelWidth(String(badge.count))
    markRight -= width
    result.push({
      x: markRight, y: node.y + node.layout.headerHeight / 2 - mark.size / 2,
      width, height: mark.size, badge, compact: false,
    })
    markRight -= paint.gap
  }

  const inset = Math.min(paint.inset, node.layout.width / 2)
  const left = node.x + inset
  const right = node.x + node.layout.width - inset
  const available = Math.max(0, right - left)
  const strip = paint.padding * 2 + paint.iconSize
  const fullWidth = (badge: NodeBadge): number => Math.min(available, paint.padding * 2 +
    (badge.icon === undefined ? 0 : paint.iconSize + paint.iconGap) + Math.min(paint.maxLabelWidth, labelWidth(badge.glyph)))
  for (const placement of ['above', 'below'] as const) {
    const lane = badges.filter((badge) => (badge.placement ?? 'above') === placement)
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
          placement, color: options.tokens.colors.nodeBorder,
        }]
      }
      widths = visible.map((badge, index) => Math.min(available,
        overflow.length > 0 && index === visible.length - 1
          ? paint.padding * 2 + labelWidth(badge.glyph) : strip))
      // Reserve the overflow count before returning words to priority tabs.
      while (visible.length > 1 && total(widths) > available) {
        overflow = lane.slice(visible.length - 2)
        visible = [...visible.slice(0, -2), { ...visible[visible.length - 1]!, glyph: `+${overflow.length}` }]
        widths = visible.map((badge, index) => index === visible.length - 1
          ? Math.min(available, paint.padding * 2 + labelWidth(badge.glyph)) : strip)
      }
      for (let index = 0; index < visible.length - (overflow.length > 0 ? 1 : 0); index++) {
        const trial = [...widths]
        trial[index] = fullWidth(visible[index]!)
        if (total(trial) <= available) widths = trial
      }
    }
    const outset = options.outset ?? 0
    const y = placement === 'above'
      ? node.y - outset - paint.offset - paint.height
      : node.y + node.layout.height + outset + paint.offset
    // Top tabs grow leftward from the right end, bottom tabs rightward from the left end.
    let cursor = placement === 'above' ? right : left
    const entries = visible.map((badge, index): BadgePlacement => {
      const width = widths[index]!
      const folded = overflow.length > 0 && index === visible.length - 1
      const x = placement === 'above' ? cursor - width : cursor
      cursor = placement === 'above' ? x - paint.gap : x + width + paint.gap
      return {
        x, y, width, height: paint.height, badge,
        compact: !folded && width < fullWidth(badge),
        ...(folded ? { overflow } : {}),
      }
    })
    const hovered = entries.find((entry) => entry.badge.id === options.hoveredId)
    if (hovered && !hovered.overflow) {
      const width = fullWidth(hovered.badge)
      result.push(...entries.filter((entry) => entry !== hovered), {
        ...hovered, width, compact: false,
        rest: { x: hovered.x, y: hovered.y, width: hovered.width, height: hovered.height },
        x: placement === 'above'
          ? Math.max(left, hovered.x + hovered.width - width)
          : Math.min(hovered.x, right - width),
      })
    } else result.push(...entries)
  }
  return result
}

/** Includes hovered expansion; callers apply live resize/drag geometry first. */
export function nodeBadgeBounds(node: SceneNode, badges: readonly NodeBadge[], options: BadgeLayoutOptions): BadgeRect {
  const entries = layoutNodeBadges(node, badges, options)
  const left = Math.min(node.x, ...entries.map((entry) => entry.x))
  const top = Math.min(node.y, ...entries.map((entry) => entry.y))
  return {
    x: left, y: top,
    width: Math.max(node.x + node.layout.width, ...entries.map((entry) => entry.x + entry.width)) - left,
    height: Math.max(node.y + node.layout.height, ...entries.map((entry) => entry.y + entry.height)) - top,
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
  layout: (node: SceneNode, badges: readonly NodeBadge[]) => readonly BadgePlacement[],
): BadgeHit | undefined {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const node = scene.nodes[i]!
    const list = badges[node.id]
    if (list) {
      const entries = layout(node, list)
      // Tabs answer at their resting rects first, so the pointer passes from
      // tab to tab under a tab grown by hover; the grown rect only catches
      // points no resting tab covers.
      for (const grown of [false, true]) for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!
        if (entry.badge.interactive === false || (grown && !entry.rest)) continue
        const target = grown ? entry : entry.rest ?? entry
        // The title mark is drawn small; its target grows to the mark's hit size.
        const grow = entry.badge.placement === 'title'
          ? Math.max(0, (canvasPaintTokens.badge.mark.hitSize - Math.min(target.width, target.height)) / 2)
          : 0
        if (wx >= target.x - grow && wx <= target.x + target.width + grow && wy >= target.y - grow && wy <= target.y + target.height + grow) {
          const rect = { x: entry.x, y: entry.y, width: entry.width, height: entry.height }
          return { node, badge: entry.badge, rect, ...(entry.overflow ? { overflow: entry.overflow } : {}) }
        }
      }
    }
    // A later-drawn node body occludes badges belonging to nodes below it.
    if (wx >= node.x && wx <= node.x + node.layout.width && wy >= node.y && wy <= node.y + node.layout.height) return undefined
  }
  return undefined
}

/** Gap between the node's lowest tab and the box, in screen px. */
export const PROBLEM_BOX_GAP = canvasPaintTokens.badge.tab.problemBoxGap

/**
 * Where the box hangs, in canvas-pane px (the canvas element's own px): below the node and its tabs, as
 * wide as the node but never narrower than its floor, so it never covers the node, its pins or its wires.
 * Its lines wrap to that width. Undefined while the zoom is too low for tabs: the box returns with them.
 */
export function problemBoxPlacement(
  node: SceneNode,
  tabs: readonly BadgePlacement[],
  viewport: { readonly x: number; readonly y: number; readonly scale: number },
): { readonly x: number; readonly y: number; readonly width: number } | undefined {
  if (viewport.scale < CANVAS_DETAIL_MIN_SCALE) return undefined
  const below = tabs.filter((entry) => entry.badge.placement === 'below')
  const bottom = Math.max(node.y + node.layout.height, ...below.map((entry) => entry.y + entry.height))
  return {
    x: node.x * viewport.scale + viewport.x,
    y: bottom * viewport.scale + viewport.y + PROBLEM_BOX_GAP,
    width: Math.max(node.layout.width * viewport.scale, canvasPaintTokens.badge.tab.problemBoxMinWidth),
  }
}
