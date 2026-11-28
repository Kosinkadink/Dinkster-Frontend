/**
 * The node's problem box, drawn as a part of the node: one row-high line per
 * problem with the kind's icon, its row's name, the message and its action at
 * the right end, the action drawn as a list status line's action. Only the
 * icon and the message take the problem's color. It hangs below the node
 * as wide as its longest line up to a limit, where its lines wrap; the caller
 * places it and sets the limit.
 */
import { createEffect, For, onCleanup, onMount, Show } from 'solid-js'
import { CircleX, Info, TriangleAlert } from 'lucide-solid'
import { canvasPaintTokens } from '@dinkster/canvas'
import { ProductTextButton } from './controls.js'

export type ProblemBoxKind = 'error' | 'warning' | 'info'

export interface ProblemBoxViewAction {
  readonly id: string
  readonly label: string
  readonly labels?: readonly string[]
  readonly disabled?: boolean
}

export interface ProblemBoxViewLine {
  /** Unique among the box's lines. */
  readonly key: string
  readonly kind: ProblemBoxKind
  /** The row the problem is on; absent for a problem of the node as a whole. */
  readonly row?: string
  /** The row's name as the node shows it. */
  readonly rowName?: string
  readonly message: string
  readonly actions: readonly ProblemBoxViewAction[]
}

export function ProblemBox(props: {
  readonly nodeId: string
  /** The box's accessible name, such as "Problems of Generate image". */
  readonly label: string
  readonly lines: readonly ProblemBoxViewLine[]
  readonly notice?: string
  /** Key of the line drawn highlighted. */
  readonly highlighted?: string
  /** Preferred top-left in the positioned parent's px; the box stays within its horizontal margins. */
  readonly x: number
  readonly y: number
  /** Widest the box gets in the same px, where its lines wrap; up to it, the box is as wide as its longest line. */
  readonly maxWidth: number
  /** Narrowest the box gets in the same px. */
  readonly minWidth: number
  readonly onPointLine?: (line: ProblemBoxViewLine | undefined) => void
  readonly onAction?: (line: ProblemBoxViewLine, action: string) => void
  readonly ref?: (element: HTMLDivElement) => void
}) {
  let element: HTMLDivElement | undefined
  const place = (): void => {
    if (element === undefined) return
    const parent = element.offsetParent
    const margin = canvasPaintTokens.badge.tab.problemBox.paneMargin
    const maxWidth = parent instanceof HTMLElement
      ? Math.min(props.maxWidth, Math.max(0, parent.clientWidth - 2 * margin)) : props.maxWidth
    element.style.top = `${props.y}px`
    element.style.maxWidth = `${maxWidth}px`
    element.style.minWidth = `${Math.min(props.minWidth, maxWidth)}px`
    element.style.left = `${parent instanceof HTMLElement
      ? Math.max(margin, Math.min(props.x, parent.clientWidth - element.offsetWidth - margin))
      : props.x}px`
  }
  createEffect(place)
  onMount(() => {
    if (element === undefined) return
    const observer = new ResizeObserver(place)
    observer.observe(element)
    if (element.offsetParent instanceof HTMLElement) observer.observe(element.offsetParent)
    onCleanup(() => observer.disconnect())
  })
  const strongest = (): ProblemBoxKind =>
    props.lines.some((line) => line.kind === 'error') ? 'error'
      : props.lines.some((line) => line.kind === 'warning') ? 'warning' : 'info'
  return (
    <div
      ref={(el) => {
        element = el
        props.ref?.(el)
      }}
      class="problem-box"
      data-testid="problem-box"
      data-node={props.nodeId}
      data-kind={strongest()}
      role="dialog"
      aria-label={props.label}
      onPointerLeave={() => props.onPointLine?.(undefined)}
    >
      <Show when={props.notice}>{(notice) => <p class="problem-box-notice">{notice()}</p>}</Show>
      <For each={props.lines}>
        {(line) => (
          <div
            class="problem-box-line"
            data-testid="problem-box-line"
            data-kind={line.kind}
            data-run={line.actions.some((action) => action.id === 'show-log') ? 'true' : undefined}
            data-stacked-actions={line.actions.length > 1 ? 'true' : undefined}
            data-row={line.row}
            data-highlighted={props.highlighted === line.key ? 'true' : undefined}
            onPointerEnter={() => props.onPointLine?.(line)}
          >
            <Show
              when={line.kind === 'error'}
              fallback={<Show when={line.kind === 'warning'} fallback={<Info class="problem-box-icon" aria-hidden="true" />}>
                <TriangleAlert class="problem-box-icon" aria-hidden="true" />
              </Show>}
            >
              <CircleX class="problem-box-icon" aria-hidden="true" />
            </Show>
            <p class="problem-box-text">
              <Show when={line.rowName}>
                {(name) => <span class="problem-box-row">{name()}: </span>}
              </Show>
              <span class="problem-box-message">{line.message}</span>
            </p>
            <Show when={line.actions.length > 0}>
              <div class="problem-box-actions">
                <For each={line.actions}>
                  {(action) => (
                    <ProductTextButton
                      label={action.label}
                      labels={action.labels}
                      data-testid={`problem-box-${action.id}`}
                      disabled={action.disabled}
                      onClick={() => props.onAction?.(line, action.id)}
                    />
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </For>
    </div>
  )
}
