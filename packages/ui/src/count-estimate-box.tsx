import { createEffect, Show } from 'solid-js'
import { Info } from 'lucide-solid'
import { ProductButton } from './controls.js'

/** A neutral offer below a node, independent of its layout and problem box. */
export function CountEstimateBox(props: {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly message: string
  readonly action?: string
  readonly disabled?: boolean
  readonly onAction?: () => void
  readonly ref?: (element: HTMLDivElement) => void
}) {
  let element!: HTMLDivElement
  createEffect(() => {
    element.style.left = `${props.x}px`
    element.style.top = `${props.y}px`
    element.style.width = `${props.width}px`
  })
  return (
    <div class="button-box count-estimate-box" data-tone="info" data-testid="count-estimate-box" role="status"
      ref={(el) => { element = el; props.ref?.(el) }}>
      <span class="button-box-icon" aria-hidden="true"><Info size={14} /></span>
      <div class="button-box-lines">
        <span>{props.message}</span>
        <Show when={props.action}>{(label) => <span class="count-estimate-action">
          <ProductButton disabled={props.disabled} onClick={() => props.onAction?.()}>{label()}</ProductButton>
        </span>}</Show>
      </div>
    </div>
  )
}
