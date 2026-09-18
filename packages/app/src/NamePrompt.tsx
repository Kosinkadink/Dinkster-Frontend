/**
 * Anchored single-line name prompt: the shared text popover behind the net
 * create/rename, group title, selector title, and boundary slot rename
 * actions.
 *
 * The host owns policy: what committing DOES (which command, trim/empty
 * semantics - the boundary prompt commits an empty string to CLEAR the
 * name, the others discard it) and when to force-close (tab or graph
 * navigation orphans the anchor). This component owns the input contract:
 * initial value selected on mount, Enter commits, Escape cancels, blur
 * cancels. Commit handlers close by clearing the host signal.
 */

export function NamePrompt(props: {
  x: number
  y: number
  /** Popover testid; the input gets `${testid}-input`. */
  testid: string
  placeholder: string
  initial: string
  onCommit: (value: string) => void
  onCancel: () => void
}) {
  return (
    <div class="net-prompt" data-testid={props.testid} style={{ left: `${props.x}px`, top: `${props.y}px` }}>
      <input
        data-testid={`${props.testid}-input`}
        placeholder={props.placeholder}
        ref={(el) =>
          queueMicrotask(() => {
            el.value = props.initial
            el.focus()
            el.select()
          })
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            props.onCommit(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onCancel()
          }
        }}
        onBlur={() => props.onCancel()}
      />
    </div>
  )
}
