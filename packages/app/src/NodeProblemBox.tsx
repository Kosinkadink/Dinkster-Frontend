/**
 * The node's problem box: one line per cause, each starting with its row's
 * name, with the line's actions on their own line under its message. The
 * host owns where it hangs, when it opens and closes, and what an action does.
 */

import { createEffect, For, Show } from 'solid-js'
import { ProductButton } from './ProductControls.js'
import { useAppMessage } from './locale.js'
import type { ProblemBoxAction, ProblemBoxLine } from './problem-box.js'

export function NodeProblemBox(props: {
  readonly x: number
  readonly y: number
  readonly nodeId: string
  readonly nodeTitle: string
  readonly lines: readonly ProblemBoxLine[]
  /** The line whose row the pointer is on, or that Show on canvas picked. */
  readonly highlighted?: string | undefined
  readonly onPointLine: (line: ProblemBoxLine | undefined) => void
  readonly onAction: (line: ProblemBoxLine, action: ProblemBoxAction) => void
  readonly ref?: (element: HTMLDivElement) => void
}) {
  const message = useAppMessage()
  let element: HTMLDivElement | undefined
  createEffect(() => {
    if (element === undefined) return
    element.style.left = `${props.x}px`
    element.style.top = `${props.y}px`
  })
  const strongest = () => props.lines.some((line) => line.kind === 'error') ? 'error' : 'warning'
  const actionLabel = (action: ProblemBoxAction): string => action === 'edit-field'
    ? message('problemBox.editField')
    : message('problems.action.locateAsset')
  // A required input never given a value or a wire reads as the row's own sentence.
  const lineText = (line: ProblemBoxLine): string =>
    line.problem.diagnostic.code === 'compile.input.missing' && line.rowName !== undefined
      ? message('problemBox.required', { label: line.rowName.charAt(0).toUpperCase() + line.rowName.slice(1) })
      : line.message
  return (
    <div
      ref={(el) => { element = el; props.ref?.(el) }}
      class="problem-box"
      data-testid="problem-box"
      data-node={props.nodeId}
      data-kind={strongest()}
      role="dialog"
      aria-label={message('problemBox.label', { node: props.nodeTitle })}
      onPointerLeave={() => props.onPointLine(undefined)}
    >
      <For each={props.lines}>
        {(line) => (
          <div
            class="problem-box-line"
            data-testid="problem-box-line"
            data-kind={line.kind}
            data-row={line.row}
            data-highlighted={props.highlighted === line.key ? 'true' : undefined}
            onPointerEnter={() => props.onPointLine(line)}
          >
            <p class="problem-box-text">
              <Show when={line.rowName}>{(name) => <span class="problem-box-row">{name()}: </span>}</Show>
              <span class="problem-box-message">{lineText(line)}</span>
            </p>
            <For each={line.actions}>
              {(action) => (
                <ProductButton
                  type="button"
                  variant="secondary"
                  size="compact"
                  data-testid={`problem-box-${action}`}
                  onClick={() => props.onAction(line, action)}
                >
                  {actionLabel(action)}
                </ProductButton>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  )
}
