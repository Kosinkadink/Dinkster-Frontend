import type { JSX } from 'solid-js'
import { canvasSidePlace, type CanvasBox, type CanvasSidePlace } from '@dinkster/ui'

/** A row's field box on the canvas, in world coordinates. */
export interface RowBox {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly look: 'original' | 'flat-title'
  /** World y of the node's bottom edge, for a side part placed under the node. */
  readonly nodeBottom: number
}

export interface RowPlacement {
  /** Width of the box at normal size. */
  readonly rowWidth: number
  readonly screen: CanvasBox
  readonly scale: number
  readonly place: CanvasSidePlace
  readonly sideTop: number
}

/**
 * Where an open field, or a row the keyboard is on, sits on screen and where
 * its side part goes. In the flat-title look the box is the row's field
 * grown by one pixel on every side, so its outline sits half in the gap
 * between rows. It keeps its normal size when zoomed out and scales with the
 * canvas when zoomed in.
 */
export function rowPlacement(
  row: RowBox,
  viewport: { readonly x: number; readonly y: number; readonly scale: number },
  bounds: { readonly width: number; readonly height: number },
  sideWidth: number,
): RowPlacement {
  const grow = row.look === 'flat-title' ? 1 : 0
  const rowWidth = row.rect.width + grow * 2
  const scale = viewport.scale
  // Zoomed in, the whole box scales, its one-pixel growth included.
  const zoom = Math.max(1, scale)
  const screen = {
    x: row.rect.x * scale + viewport.x - grow * zoom,
    y: row.rect.y * scale + viewport.y - grow * zoom,
    width: rowWidth * zoom,
    height: (row.rect.height + grow * 2) * zoom,
  }
  return {
    rowWidth,
    screen,
    scale,
    place: canvasSidePlace(screen, { x: 0, y: 0, ...bounds }, sideWidth * zoom, scale),
    sideTop: (row.nodeBottom - row.rect.y) * scale + grow,
  }
}

/** The style that puts an element at a placement's top left, scaled when zoomed in. */
export function rowPlacementStyle(placement: RowPlacement): JSX.CSSProperties {
  return {
    position: 'absolute',
    left: `${placement.screen.x}px`,
    top: `${placement.screen.y}px`,
    'transform-origin': '0 0',
    ...(placement.scale > 1 ? { transform: `scale(${placement.scale})` } : {}),
  }
}
