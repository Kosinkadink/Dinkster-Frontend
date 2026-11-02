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
 * cancels. Final acceptance closes the prompt; refusal keeps its draft.
 */

import { createSignal, onCleanup, Show } from 'solid-js'
import type { CommandOutcome } from '@dinkster/core'
import { ProductNotice } from './ProductForm.js'

export function NamePrompt(props: {
  x: number
  y: number
  /** Popover testid; the input gets `${testid}-input`. */
  testid: string
  placeholder: string
  initial: string
  onCommit: (value: string) => CommandOutcome | undefined | Promise<CommandOutcome | undefined>
  onCancel: () => void
}) {
  let live = true
  onCleanup(() => { live = false })
  const [pending, setPending] = createSignal(false)
  const [refusal, setRefusal] = createSignal<string | undefined>(undefined)
  const commit = async (value: string): Promise<void> => {
    if (!live || pending()) return
    setPending(true)
    setRefusal(undefined)
    try {
      const outcome = await props.onCommit(value)
      if (!live) return
      if (outcome === undefined || outcome.ok) props.onCancel()
      else setRefusal(outcome.diagnostics[0]?.message)
    } finally {
      if (live) setPending(false)
    }
  }
  return (
    <div class="net-prompt" data-testid={props.testid} aria-busy={pending()} style={{ left: `${props.x}px`, top: `${props.y}px` }}>
      <input
        data-testid={`${props.testid}-input`}
        placeholder={props.placeholder}
        readOnly={pending()}
        aria-invalid={refusal() !== undefined}
        aria-describedby={refusal() === undefined ? undefined : `${props.testid}-refusal`}
        ref={(el) =>
          queueMicrotask(() => {
            if (!live) return
            el.value = props.initial
            el.focus()
            el.select()
          })
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit(e.currentTarget.value)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onCancel()
          }
        }}
        onBlur={() => props.onCancel()}
      />
      <Show when={refusal()}>{(text) => <div id={`${props.testid}-refusal`}><ProductNotice tone="error">{text()}</ProductNotice></div>}</Show>
    </div>
  )
}
