/**
 * The node's problem box: one line per problem, each starting with its row's
 * name, with the line's actions on their own line under its message. It hangs
 * below the node at one screen size; the caller places it.
 */
import { createEffect, For, Show } from 'solid-js'
import { ProductButton } from './controls.js'

export type ProblemBoxKind = 'error' | 'warning'

export interface ProblemBoxViewAction {
  readonly id: string
  readonly label: string
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
  /** Key of the line drawn highlighted. */
  readonly highlighted?: string
  /** Top-left corner in the positioned parent's px. */
  readonly x: number
  readonly y: number
  readonly onPointLine?: (line: ProblemBoxViewLine | undefined) => void
  readonly onAction?: (line: ProblemBoxViewLine, action: string) => void
  readonly ref?: (element: HTMLDivElement) => void
}) {
  let element: HTMLDivElement | undefined
  createEffect(() => {
    if (element === undefined) return
    element.style.left = `${props.x}px`
    element.style.top = `${props.y}px`
  })
  const strongest = (): ProblemBoxKind =>
    props.lines.some((line) => line.kind === 'error') ? 'error' : 'warning'
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
      <For each={props.lines}>
        {(line) => (
          <div
            class="problem-box-line"
            data-testid="problem-box-line"
            data-kind={line.kind}
            data-row={line.row}
            data-highlighted={props.highlighted === line.key ? 'true' : undefined}
            onPointerEnter={() => props.onPointLine?.(line)}
          >
            <p class="problem-box-text">
              <Show when={line.rowName}>
                {(name) => <span class="problem-box-row">{name()}: </span>}
              </Show>
              <span class="problem-box-message">{line.message}</span>
            </p>
            <For each={line.actions}>
              {(action) => (
                <ProductButton
                  type="button"
                  data-testid={`problem-box-${action.id}`}
                  onClick={() => props.onAction?.(line, action.id)}
                >
                  {action.label}
                </ProductButton>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}
