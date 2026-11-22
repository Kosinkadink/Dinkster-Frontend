import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { canvasSideLayout, type CanvasBox, type CanvasSideLayout, type CanvasSideSize } from '@dinkster/ui'

/** A row's field box on the canvas, in world coordinates. */
export interface RowBox {
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly look: 'original' | 'flat-title'
  /** World y of the node's top and bottom edges, for a side part placed over or under the node. */
  readonly nodeTop: number
  readonly nodeBottom: number
}

export interface RowPlacement extends CanvasSideLayout {
  /** Width of the box at normal size. */
  readonly rowWidth: number
  readonly screen: CanvasBox
  readonly scale: number
}

/**
 * Where an open field, or a row the keyboard is on, sits on screen and where
 * its side part goes. In the flat-title look the box is the row's field
 * grown by one pixel on every side, so its outline sits half in the gap
 * between rows. It keeps its normal size when zoomed out and scales with the
 * canvas when zoomed in. `bounds` is the visible canvas, in the same
 * coordinates as the viewport.
 */
export function rowPlacement(
  row: RowBox,
  viewport: { readonly x: number; readonly y: number; readonly scale: number },
  bounds: CanvasBox,
  side: CanvasSideSize,
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
  // From the box's top to the node's edges, at the box's normal size.
  const local = scale / zoom
  return {
    rowWidth,
    screen,
    scale,
    ...canvasSideLayout(screen, bounds, side, scale,
      (row.nodeBottom - row.rect.y) * local + grow,
      (row.rect.y - row.nodeTop) * local - grow),
  }
}

/**
 * The part of a canvas element the user can see, in its own coordinates,
 * kept current as it resizes: whatever the window's visible area, such as
 * an on-screen keyboard, cuts off is left out.
 */
export function visibleCanvas(element: HTMLElement | undefined): Accessor<CanvasBox> {
  const measure = (): CanvasBox => {
    if (element === undefined) return { x: 0, y: 0, width: Infinity, height: Infinity }
    const box = element.getBoundingClientRect()
    const view = window.visualViewport
    const top = Math.max(0, (view?.offsetTop ?? 0) - box.top)
    const bottom = Math.min(box.height, (view ? view.offsetTop + view.height : window.innerHeight) - box.top)
    return { x: 0, y: top, width: box.width, height: Math.max(0, bottom - top) }
  }
  const [bounds, setBounds] = createSignal(measure(), {
    equals: (a, b) => a.y === b.y && a.width === b.width && a.height === b.height,
  })
  if (element !== undefined) {
    const update = (): void => { setBounds(measure()) }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    onCleanup(() => {
      observer.disconnect()
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
    })
  }
  return bounds
}

/** Puts an element at a placement's top left, scaled when zoomed in. */
export function placeRow(element: HTMLElement, placement: RowPlacement): void {
  element.style.left = `${placement.screen.x}px`
  element.style.top = `${placement.screen.y}px`
  element.style.transform = placement.scale > 1 ? `scale(${placement.scale})` : ''
}
