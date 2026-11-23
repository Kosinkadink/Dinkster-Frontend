/**
 * The node's problem box in the editor: the product's ProblemBox with the
 * app's wording. The host owns where it hangs, when it opens and closes, and
 * what an action does.
 */

import { ProblemBox, type ProblemBoxViewLine } from '@dinkster/ui'
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
  const actionLabel = (action: ProblemBoxAction): string => action === 'edit-field'
    ? message('problemBox.editField')
    : message('problems.action.locateAsset')
  // A required input never given a value or a wire reads as the row's own sentence.
  const lineText = (line: ProblemBoxLine): string =>
    line.problem.diagnostic.code === 'compile.input.missing' && line.rowName !== undefined
      ? message('problemBox.required', { label: line.rowName.charAt(0).toUpperCase() + line.rowName.slice(1) })
      : line.message
  const viewLines = (): readonly ProblemBoxViewLine[] => props.lines.map((line) => ({
    key: line.key,
    kind: line.kind,
    ...(line.row === undefined ? {} : { row: line.row }),
    ...(line.rowName === undefined ? {} : { rowName: line.rowName }),
    message: lineText(line),
    actions: line.actions.map((action) => ({ id: action, label: actionLabel(action) })),
  }))
  const lineOf = (view: ProblemBoxViewLine | undefined): ProblemBoxLine | undefined =>
    view === undefined ? undefined : props.lines.find((line) => line.key === view.key)
  return (
    <ProblemBox
      nodeId={props.nodeId}
      label={message('problemBox.label', { node: props.nodeTitle })}
      lines={viewLines()}
      {...(props.highlighted === undefined ? {} : { highlighted: props.highlighted })}
      x={props.x}
      y={props.y}
      onPointLine={(view) => props.onPointLine(lineOf(view))}
      onAction={(view, action) => {
        const line = lineOf(view)
        if (line !== undefined) props.onAction(line, action as ProblemBoxAction)
      }}
      {...(props.ref === undefined ? {} : { ref: props.ref })}
    />
  )
}
