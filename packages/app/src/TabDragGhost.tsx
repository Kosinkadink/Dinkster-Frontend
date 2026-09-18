import { Show, type Component } from 'solid-js'
import { Icon } from './Icon.js'

/** Offset keeps the ghost clear of the pointer hotspot and the grab cursor. */
export const TAB_DRAG_GHOST_OFFSET_X = 14
export const TAB_DRAG_GHOST_OFFSET_Y = 18

/**
 * Cursor-following miniature of a dragged tab (icon + title), shared by the
 * panel drag and the central workflow tab drag. Purely presentational: it is
 * non-interactive and adds to the existing target previews without changing
 * drop semantics.
 */
export function TabDragGhost(props: {
  readonly title: string
  readonly icon?: Component | undefined
  readonly x: number
  readonly y: number
  readonly refused?: boolean | undefined
}) {
  return (
    <div
      class="tab-drag-ghost"
      data-testid="tab-drag-ghost"
      data-refused={props.refused === true ? 'true' : 'false'}
      aria-hidden="true"
      style={{
        left: `${props.x + TAB_DRAG_GHOST_OFFSET_X}px`,
        top: `${props.y + TAB_DRAG_GHOST_OFFSET_Y}px`,
      }}
    >
      <Show when={props.icon} keyed>{(icon) => (
        <span class="tab-drag-ghost-icon"><Icon icon={icon} /></span>
      )}</Show>
      <span class="tab-drag-ghost-title">{props.title}</span>
    </div>
  )
}
