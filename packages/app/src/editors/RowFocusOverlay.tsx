import { createEffect, createMemo, createSignal, type JSX } from 'solid-js'
import { CanvasRowFocus, CanvasSidePart } from '@dinkster/ui'
import { placeRow, rowPlacement, visibleCanvas, type RowBox } from './row-placement.js'

/**
 * A field's switchable looks for the side part's Representation control, and
 * the document address its choice is kept under.
 */
export interface RowRepresentation {
  readonly graphId: string
  readonly nodeId: string
  readonly inputId: string
  readonly choices: readonly { readonly id: string; readonly label: string }[]
  readonly selected: string
  readonly note?: string
}

/** A row the keyboard is on while nothing is open. */
export interface RowFocusState extends RowBox {
  readonly tabId: string
  readonly graphId: string
  readonly nodeId: string
  readonly valueKey: string
  /** The declared default, as the row shows it. */
  readonly defaultText?: string
  readonly help?: string
  readonly representation?: RowRepresentation
  /**
   * Lines that explain a row which cannot be edited, such as a color a wire
   * brings. The row then shows them in a neutral side part with no outline
   * and no field, in place of its default and help.
   */
  readonly note?: JSX.Element
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
  /** Switch the row's look; called only with a choice other than the current one. */
  onRepresentation: (id: string) => void
}) {
  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  const bounds = visibleCanvas(props.boundary)
  const placement = createMemo(() => rowPlacement(
    props.focus,
    props.viewport(),
    bounds(),
    sideSize(),
  ))
  const side = createMemo(() => {
    const { defaultText, help, representation, note } = props.focus
    if (note !== undefined) return <CanvasSidePart>{note}</CanvasSidePart>
    if (defaultText === undefined && help === undefined && representation === undefined) return undefined
    return (
      <CanvasSidePart
        facts={defaultText === undefined ? [] : [{ key: 'default', value: defaultText }]}
        {...(help === undefined ? {} : { help })}
        {...(representation === undefined ? {} : { representation: {
          choices: representation.choices,
          selected: representation.selected,
          ...(representation.note === undefined ? {} : { note: representation.note }),
          onChoose: (id: string) => { if (id !== representation.selected) props.onRepresentation(id) },
        } })}
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
          neutral={props.focus.note !== undefined}
          zoomed={placement().scale > 1}
          place={placement().place}
          sideTop={placement().sideTop}
          {...(placement().sideMaxHeight === undefined ? {} : { sideMaxHeight: placement().sideMaxHeight! })}
          onSideSize={setSideSize}
          {...(side() === undefined ? {} : { side: side()! })}
        />
      </div>
    </div>
  )
}
