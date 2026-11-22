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

/**
 * Puts an element at a placement's top left, scaled when zoomed in. The
 * element sits on whole pixels and the fraction moves inside the scale: a
 * scaled element at a fractional position is drawn snapped to a whole
 * pixel, which would shift its text from where the canvas drew it.
 */
export function placeRow(element: HTMLElement, placement: RowPlacement): void {
  const { scale } = placement
  const parent = element.offsetParent?.getBoundingClientRect()
  const fx = parent ? parent.left - Math.round(parent.left) : 0
  const fy = parent ? parent.top - Math.round(parent.top) : 0
  const screen = { x: placement.screen.x - fx, y: placement.screen.y - fy }
  const x = scale > 1 ? Math.floor(screen.x) : screen.x
  const y = scale > 1 ? Math.floor(screen.y) : screen.y
  element.style.left = `${x}px`
  element.style.top = `${y}px`
  element.style.transform = scale > 1 ? `scale(${scale}) translate(${(screen.x - x) / scale}px, ${(screen.y - y) / scale}px)` : ''
}
