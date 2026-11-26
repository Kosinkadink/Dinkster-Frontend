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
interface RowFocusDetails extends RowBox {
  readonly tabId: string
  readonly graphId: string
  readonly nodeId: string
  /** The declared default, as the row shows it. */
  readonly defaultText?: string
  readonly help?: string
  readonly representation?: RowRepresentation
  readonly arriving?: JSX.Element
  readonly cancellation?: string
  readonly tooltipOnly?: boolean
  /**
   * Lines that explain a row which cannot be edited, such as a color a wire
   * brings. The row then shows them in a neutral side part with no outline
   * and no field, in place of its default and help.
   */
  readonly note?: JSX.Element
}

export type RowFocusState = RowFocusDetails & (
  | { readonly valueKey: string; readonly button?: never }
  | { readonly valueKey?: never; readonly button: { readonly id: string; readonly label: string; readonly disabled: boolean; readonly busy: boolean } }
)

/**
 * Draws the open field's outline around the row the keyboard is on, with a
 * side part holding the row's default and help text. The canvas still draws
 * the row; Buttons get a semantic focus target for their keyboard actions.
 */
export function RowFocusOverlay(props: {
  focus: RowFocusState
  viewport: () => { x: number; y: number; scale: number }
  boundary: HTMLElement
  /** Switch the row's look; called only with a choice other than the current one. */
  onRepresentation: (id: string) => void
  onClose: (restoreFocus: boolean) => void
  onKeyDown: (event: KeyboardEvent) => void
}) {
  const [sideSize, setSideSize] = createSignal({ width: 0, height: 0 })
  const bounds = visibleCanvas(props.boundary)
  const placement = createMemo(() => rowPlacement(
    props.focus,
    props.viewport(),
    bounds(),
    sideSize(),
  ))
  // A scene refresh updates inspection in place, without remounting its open list.
  const side = (
    <CanvasSidePart
      {...(props.focus.cancellation === undefined ? {} : { result: props.focus.cancellation })}
      facts={props.focus.note !== undefined || props.focus.arriving !== undefined || props.focus.defaultText === undefined ? [] : [{ key: 'default', value: props.focus.defaultText }]}
      {...(props.focus.note !== undefined || props.focus.help === undefined ? {} : { help: props.focus.help })}
      {...(props.focus.note !== undefined || props.focus.representation === undefined ? {} : { representation: {
        choices: props.focus.representation.choices,
        selected: props.focus.representation.selected,
        ...(props.focus.representation.note === undefined ? {} : { note: props.focus.representation.note }),
        onChoose: (id: string) => { if (id !== props.focus.representation?.selected) props.onRepresentation(id) },
      } })}
    >{props.focus.note ?? props.focus.arriving}</CanvasSidePart>
  )
  let layer!: HTMLDivElement
  let frame!: HTMLDivElement
  createEffect(() => placeRow(frame, placement()))
  createEffect(() => {
    if (props.focus.button === undefined) return
    // Buttons have a semantic focus target; fields keep their existing canvas focus.
    if (document.activeElement === props.boundary.querySelector('canvas') || document.activeElement === document.body) layer.focus()
  })
  return (
    <div ref={layer} class="palette-layer widget-popover-layer" data-testid="row-focus"
      role={props.focus.button === undefined ? undefined : 'button'}
      tabIndex={props.focus.button === undefined ? undefined : -1}
      aria-label={props.focus.button === undefined ? undefined : props.focus.button.busy ? `Cancel ${props.focus.button.label}` : props.focus.button.label}
      aria-disabled={props.focus.button?.disabled}
      aria-busy={props.focus.button?.busy}
      aria-description={props.focus.button === undefined ? undefined : props.focus.help}
      onFocusOut={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) props.onClose(false)
      }}
      onKeyDown={(event) => {
        if (event.isComposing) return
        if (props.focus.button !== undefined) { props.onKeyDown(event); return }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.onClose(true) }
      }}>
      <div ref={frame} class="widget-row-focus">
        <CanvasRowFocus
          rowWidth={placement().rowWidth}
          {...(props.focus.tooltipOnly ? { rowHeight: placement().screen.height / Math.max(1, placement().scale) } : {})}
          look={props.focus.look}
          neutral={props.focus.note !== undefined}
          zoomed={placement().scale > 1}
          place={placement().place}
          sideTop={placement().sideTop}
          {...(placement().sideMaxHeight === undefined ? {} : { sideMaxHeight: placement().sideMaxHeight! })}
          onSideSize={setSideSize}
          {...(props.focus.tooltipOnly || props.focus.defaultText === undefined && props.focus.help === undefined && props.focus.representation === undefined && props.focus.note === undefined && props.focus.arriving === undefined && props.focus.cancellation === undefined ? {} : { side })}
        />
      </div>
    </div>
  )
}
