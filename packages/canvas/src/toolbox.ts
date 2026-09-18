/**
 * Selection toolbox: a strip of action buttons floating above the bounding
 * box of the selected nodes (the Nodes 2.0 pattern - the area above a node
 * is interactable chrome). Pure layout + hit-test over the Scene; the HOST
 * decides which buttons exist and what a click does - the canvas only
 * places, draws, and hit-tests them, exactly like node badges. Buttons are
 * pure view state; they never touch the document.
 */

import { boundarySceneId, type Scene } from './scene.js'

export type CanvasIconName =
  | 'volume-x' | 'ban' | 'play' | 'play-to' | 'play-from' | 'play-between'
  | 'trash-2' | 'circle' | 'ellipsis-vertical' | 'folder-open' | 'group' | 'ungroup' | 'boxes'
  | 'sliders-horizontal' | 'panel-top-close' | 'panel-top-open'

export interface ToolboxButton {
  /** Stable namespaced id ('core.mode.muted', 'core.delete'). */
  readonly id: string
  /** Core vector icon. */
  readonly icon?: CanvasIconName
  /** Optional accent for an icon, such as the selection's shared identity color. */
  readonly iconColor?: string
  /** 1-2 character fallback for extension-contributed buttons. */
  readonly glyph?: string
  /** Human name surfaced by the canvas tooltip provider. */
  readonly label: string
  /** Disabled buttons remain visible but cannot invoke actions or previews. */
  readonly disabled?: boolean
  /** Human-readable explanation surfaced by the canvas tooltip provider. */
  readonly reason?: string
  /**
   * Toggled-on state: drawn filled so mode toggles (mute/bypass) read at
   * a glance. Absent = plain action button (delete, open subgraph).
   */
  readonly active?: boolean
}

export interface PartialExecutionAvailability {
  readonly upTo?: string
  readonly between?: string
  readonly fromOnwards?: string
}

/** Partial actions in semantic before -> between -> after order. */
export function partialExecutionButtons(
  availability: PartialExecutionAvailability,
): readonly ToolboxButton[] {
  const button = (id: string, icon: NonNullable<ToolboxButton['icon']>, label: string, reason: string | undefined): ToolboxButton => ({
    id,
    icon,
    label,
    ...(reason !== undefined ? { disabled: true, reason } : {}),
  })
  return [
    button('core.queueUpToHere', 'play-to', 'Execute up to', availability.upTo),
    button('core.queueBetween', 'play-between', 'Execute between', availability.between),
    button('core.queueFromHere', 'play-from', 'Execute from onwards', availability.fromOnwards),
  ]
}

export type ToolboxEntry =
  | { readonly kind: 'button'; readonly button: ToolboxButton }
  | { readonly kind: 'separator' }

export type ToolboxRow = readonly ToolboxEntry[]

export const toolboxButton = (button: ToolboxButton): ToolboxEntry => ({ kind: 'button', button })
export const toolboxSeparator = (): ToolboxEntry => ({ kind: 'separator' })

/** Screen-pixel button square side, converted to world units by layout. */
export const TOOLBOX_BUTTON_SIZE = 28
/** Screen-pixel gap between adjacent entries and rows. */
export const TOOLBOX_GAP = 5
/** Screen-pixel strip padding around the rows. */
export const TOOLBOX_PAD = 6
/** Screen-pixel gap from the strip bottom to the painted selection outline. */
export const TOOLBOX_GAP_FROM_SELECTION = 16
export const TOOLBOX_GAP_FROM_ATTACHED_BADGE = 6
/** Screen-pixel separator width; its height is 60% of a button. */
export const TOOLBOX_SEPARATOR_WIDTH = 1
/** World-space ordinary-node selection outline outset and stroke width. */
export const NODE_SELECTION_OUTLINE_OUTSET = 3
export const SELECTION_OUTLINE_STROKE_WIDTH = 2
/** World-space boundary-node selection outline outset. */
export const BOUNDARY_SELECTION_OUTLINE_OUTSET = 2
/** Multi-selection union outline geometry: world-space pad, screen-pixel stroke. */
export const MULTI_SELECTION_OUTLINE_PAD = 8
export const MULTI_SELECTION_OUTLINE_STROKE_WIDTH = 1

export interface ToolboxButtonRect {
  readonly button: ToolboxButton
  readonly x: number
  readonly y: number
  readonly size: number
}

export interface ToolboxSeparatorRect {
  readonly kind: 'separator'
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type ToolboxEntryRect =
  | ({ readonly kind: 'button' } & ToolboxButtonRect)
  | ToolboxSeparatorRect

export interface ToolboxRowLayout {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /** Natural-width chrome behind this row; centered rows form the T silhouette. */
  readonly panel: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly entries: readonly ToolboxEntryRect[]
}

/** The whole strip in world coords; `buttons` remains a flattened compatibility view. */
export interface ToolboxLayout {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly rows: readonly ToolboxRowLayout[]
  readonly buttons: readonly ToolboxButtonRect[]
}

/**
 * Place the strip centered above the selected nodes' bounding box.
 * Chrome dimensions are specified in screen pixels and divided by camera
 * scale here because drawing and hit-testing both consume world coordinates.
 * Undefined when nothing renderable: no buttons, or the selection matches
 * no scene nodes (links/reroutes alone never grow a toolbox).
 */
export function toolboxLayout(
  scene: Scene,
  selection: ReadonlySet<string>,
  rows: readonly ToolboxRow[],
  scale: number,
  paintedOutlineTop?: number,
  clearanceScreenPx = TOOLBOX_GAP_FROM_SELECTION,
): ToolboxLayout | undefined {
  const renderableRows = rows.filter((row) => row.some((entry) => entry.kind === 'button'))
  if (renderableRows.length === 0 || selection.size === 0) return undefined
  let minX = Infinity
  let maxX = -Infinity
  let outlineTop = Infinity
  let selectedNodeCount = 0
  for (const node of scene.nodes) {
    if (!selection.has(node.id)) continue
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x + node.layout.width)
    outlineTop = Math.min(
      outlineTop,
      node.y - NODE_SELECTION_OUTLINE_OUTSET - SELECTION_OUTLINE_STROKE_WIDTH / 2,
    )
    selectedNodeCount++
  }
  for (const node of scene.boundaryNodes) {
    if (!selection.has(boundarySceneId(node.side))) continue
    minX = Math.min(minX, node.x)
    maxX = Math.max(maxX, node.x + node.layout.width)
    outlineTop = Math.min(
      outlineTop,
      node.y - BOUNDARY_SELECTION_OUTLINE_OUTSET - SELECTION_OUTLINE_STROKE_WIDTH / 2,
    )
    selectedNodeCount++
  }
  if (minX === Infinity) return undefined
  if (selectedNodeCount >= 2) {
    const selectedTop = Math.min(
      ...scene.nodes.filter((node) => selection.has(node.id)).map((node) => node.y),
      ...scene.boundaryNodes
        .filter((node) => selection.has(boundarySceneId(node.side)))
        .map((node) => node.y),
    )
    outlineTop = Math.min(
      outlineTop,
      selectedTop - MULTI_SELECTION_OUTLINE_PAD - MULTI_SELECTION_OUTLINE_STROKE_WIDTH / scale / 2,
    )
  }
  if (paintedOutlineTop !== undefined) outlineTop = Math.min(outlineTop, paintedOutlineTop)
  const buttonSize = TOOLBOX_BUTTON_SIZE / scale
  const gap = TOOLBOX_GAP / scale
  const pad = TOOLBOX_PAD / scale
  const selectionGap = clearanceScreenPx / scale
  const separatorWidth = TOOLBOX_SEPARATOR_WIDTH / scale
  const separatorHeight = buttonSize * 0.6
  const rowWidths = renderableRows.map((row) =>
    row.reduce((sum, entry) => sum + (entry.kind === 'button' ? buttonSize : separatorWidth), 0)
      + Math.max(0, row.length - 1) * gap,
  )
  const width = pad * 2 + Math.max(...rowWidths)
  const height = pad * 2 + renderableRows.length * buttonSize + (renderableRows.length - 1) * gap
  const x = (minX + maxX) / 2 - width / 2
  const y = outlineTop - selectionGap - height
  const buttons: ToolboxButtonRect[] = []
  const rowLayouts = renderableRows.map((row, rowIndex): ToolboxRowLayout => {
    const rowWidth = rowWidths[rowIndex]!
    const rowX = x + (width - rowWidth) / 2
    const rowY = y + pad + rowIndex * (buttonSize + gap)
    let entryX = rowX
    const entries = row.map((entry): ToolboxEntryRect => {
      if (entry.kind === 'button') {
        const rect: ToolboxEntryRect = {
          kind: 'button',
          button: entry.button,
          x: entryX,
          y: rowY,
          size: buttonSize,
        }
        buttons.push(rect)
        entryX += buttonSize + gap
        return rect
      }
      const rect: ToolboxSeparatorRect = {
        kind: 'separator',
        x: entryX,
        y: rowY + (buttonSize - separatorHeight) / 2,
        width: separatorWidth,
        height: separatorHeight,
      }
      entryX += separatorWidth + gap
      return rect
    })
    return {
      x: rowX,
      y: rowY,
      width: rowWidth,
      height: buttonSize,
      panel: { x: rowX - pad, y: rowY - pad, width: rowWidth + pad * 2, height: buttonSize + pad * 2 },
      entries,
    }
  })
  return { x, y, width, height, rows: rowLayouts, buttons }
}

/**
 * Button under a world point, or undefined. A point on the strip but
 * between buttons hits nothing - the CALLER still checks strip bounds to
 * claim the click (a click on toolbox chrome must never marquee through).
 */
export function hitTestToolbox(
  layout: ToolboxLayout,
  wx: number,
  wy: number,
): ToolboxButtonRect | undefined {
  for (const r of layout.buttons) {
    if (wx >= r.x && wx <= r.x + r.size && wy >= r.y && wy <= r.y + r.size) return r
  }
  return undefined
}

/** Whether a world point lands anywhere on the strip (chrome included). */
export const insideToolbox = (layout: ToolboxLayout, wx: number, wy: number): boolean =>
  layout.rows.some(({ panel }) =>
    wx >= panel.x && wx <= panel.x + panel.width && wy >= panel.y && wy <= panel.y + panel.height)
