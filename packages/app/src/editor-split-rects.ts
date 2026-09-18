/**
 * Geometry for rendering the editor split tree (editor-layout.ts) in the
 * center region. The tree renders FLAT: every group pane and divider gets an
 * absolute pixel rect inside the region, so structural tree changes and
 * ratio drags restyle panes without remounting them (a remount would discard
 * live editor state such as the canvas viewport).
 *
 * Everything here is pure geometry; rendering and drag wiring live in the
 * shell.
 */

import {
  clampSplitRatio,
  type EditorLayoutNode,
  type SplitPath,
} from './editor-layout.js'

export interface SplitRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface GroupPaneRect {
  readonly id: string
  readonly rect: SplitRect
}

export interface SplitDividerRect {
  /** Path to the split node this divider belongs to (setSplitRatioAt key). */
  readonly path: SplitPath
  readonly direction: 'row' | 'column'
  readonly ratio: number
  /** The divider's own hit rect. */
  readonly rect: SplitRect
  /** The split node's full area; ratio drags resolve against it. */
  readonly area: SplitRect
}

export interface SplitRegionRects {
  readonly groups: readonly GroupPaneRect[]
  readonly dividers: readonly SplitDividerRect[]
}

/** Divider hit-area thickness in px; panes butt against either side. */
export const SPLIT_DIVIDER_THICKNESS = 6

/**
 * Compute pane and divider rects for a layout tree within `container`
 * (typically { x: 0, y: 0, width, height } of the region element).
 */
export function computeSplitRects(
  root: EditorLayoutNode,
  container: SplitRect,
  thickness = SPLIT_DIVIDER_THICKNESS,
): SplitRegionRects {
  const groups: GroupPaneRect[] = []
  const dividers: SplitDividerRect[] = []
  const walk = (node: EditorLayoutNode, rect: SplitRect, path: SplitPath): void => {
    if (node.kind === 'group') {
      groups.push({ id: node.id, rect })
      return
    }
    const ratio = clampSplitRatio(node.ratio)
    if (node.direction === 'row') {
      const usable = Math.max(0, rect.width - thickness)
      const firstWidth = Math.round(usable * ratio)
      walk(node.first, { ...rect, width: firstWidth }, [...path, 'first'])
      dividers.push({
        path,
        direction: 'row',
        ratio,
        rect: { x: rect.x + firstWidth, y: rect.y, width: thickness, height: rect.height },
        area: rect,
      })
      walk(
        node.second,
        { ...rect, x: rect.x + firstWidth + thickness, width: usable - firstWidth },
        [...path, 'second'],
      )
      return
    }
    const usable = Math.max(0, rect.height - thickness)
    const firstHeight = Math.round(usable * ratio)
    walk(node.first, { ...rect, height: firstHeight }, [...path, 'first'])
    dividers.push({
      path,
      direction: 'column',
      ratio,
      rect: { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: thickness },
      area: rect,
    })
    walk(
      node.second,
      { ...rect, y: rect.y + firstHeight + thickness, height: usable - firstHeight },
      [...path, 'second'],
    )
  }
  walk(root, container, [])
  return { groups, dividers }
}

/** The ratio a divider drag at client offset (x, y) resolves to. */
export function splitRatioAtPointer(
  divider: SplitDividerRect,
  x: number,
  y: number,
  thickness = SPLIT_DIVIDER_THICKNESS,
): number {
  const usable = divider.direction === 'row'
    ? divider.area.width - thickness
    : divider.area.height - thickness
  if (usable <= 0) return 0.5
  const offset = divider.direction === 'row' ? x - divider.area.x : y - divider.area.y
  return clampSplitRatio((offset - thickness / 2) / usable)
}

export type SplitDropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

export interface SplitDropTarget {
  readonly groupId: string
  readonly zone: SplitDropZone
}

/**
 * Which group pane and drop zone a dragged tab at (x, y) points at. Edge
 * bands claim the outer quarter of each axis (capped so tiny panes keep a
 * usable center); everything else is the center (move-into-group) zone.
 */
export function splitDropTargetAt(
  rects: SplitRegionRects,
  x: number,
  y: number,
): SplitDropTarget | undefined {
  for (const pane of rects.groups) {
    const { rect } = pane
    if (x < rect.x || x >= rect.x + rect.width || y < rect.y || y >= rect.y + rect.height) continue
    const bandX = Math.min(rect.width / 4, 160)
    const bandY = Math.min(rect.height / 4, 160)
    if (x < rect.x + bandX) return { groupId: pane.id, zone: 'left' }
    if (x >= rect.x + rect.width - bandX) return { groupId: pane.id, zone: 'right' }
    if (y < rect.y + bandY) return { groupId: pane.id, zone: 'top' }
    if (y >= rect.y + rect.height - bandY) return { groupId: pane.id, zone: 'bottom' }
    return { groupId: pane.id, zone: 'center' }
  }
  return undefined
}

/** The highlight rect previewing a drop: the claimed half, or the whole pane. */
export function splitDropPreviewRect(pane: SplitRect, zone: SplitDropZone): SplitRect {
  switch (zone) {
    case 'left': return { ...pane, width: pane.width / 2 }
    case 'right': return { ...pane, x: pane.x + pane.width / 2, width: pane.width / 2 }
    case 'top': return { ...pane, height: pane.height / 2 }
    case 'bottom': return { ...pane, y: pane.y + pane.height / 2, height: pane.height / 2 }
    case 'center': return pane
  }
}

/** How a drop zone translates into a layout operation. */
export function splitDropOperation(zone: SplitDropZone): {
  readonly kind: 'split'
  readonly direction: 'row' | 'column'
  readonly position: 'first' | 'second'
} | { readonly kind: 'move' } {
  switch (zone) {
    case 'left': return { kind: 'split', direction: 'row', position: 'first' }
    case 'right': return { kind: 'split', direction: 'row', position: 'second' }
    case 'top': return { kind: 'split', direction: 'column', position: 'first' }
    case 'bottom': return { kind: 'split', direction: 'column', position: 'second' }
    case 'center': return { kind: 'move' }
  }
}
