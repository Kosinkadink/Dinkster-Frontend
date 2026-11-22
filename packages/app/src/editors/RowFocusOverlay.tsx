import { createEffect, createMemo, createSignal } from 'solid-js'
import { CanvasRowFocus, CanvasSidePart } from '@dinkster/ui'
import { placeRow, rowPlacement, type RowBox } from './row-placement.js'

/** A row the keyboard is on while nothing is open. */
export interface RowFocusState extends RowBox {
  readonly tabId: string
  readonly graphId: string
  readonly nodeId: string
  readonly valueKey: string
  /** The declared default, as the row shows it. */
  readonly defaultText?: string
  readonly help?: string
}

/**
 * Draws the open field's outline around the row the keyboard is on, with a
 * side part holding the row's default and help text. Nothing opens; the
 * canvas keeps the focus and still draws the row.
 */
export function RowFocusOverlay(props: {
  focus: RowFocusState
  viewport: () => { x: number; y: number; scale: number }
  boundary: HTMLElement
}) {
  const [sideWidth, setSideWidth] = createSignal(0)
  const placement = createMemo(() => rowPlacement(
    props.focus,
    props.viewport(),
    { width: props.boundary.clientWidth, height: props.boundary.clientHeight },
    sideWidth(),
  ))
  const side = createMemo(() => {
    const { defaultText, help } = props.focus
    if (defaultText === undefined && help === undefined) return undefined
    return (
      <CanvasSidePart
        facts={defaultText === undefined ? [] : [{ key: 'default', value: defaultText }]}
        {...(help === undefined ? {} : { help })}
      />
    )
  })
  let frame!: HTMLDivElement
  createEffect(() => placeRow(frame, placement()))
  return (
    <div class="palette-layer widget-popover-layer" data-testid="row-focus">
      <div ref={frame} class="widget-row-focus">
        <CanvasRowFocus
          rowWidth={placement().rowWidth}
          look={props.focus.look}
          zoomed={placement().scale > 1}
          place={placement().place}
          sideTop={placement().sideTop}
          onSideSize={(size) => setSideWidth(size.width)}
          {...(side() === undefined ? {} : { side: side()! })}
        />
      </div>
    </div>
  )
}
