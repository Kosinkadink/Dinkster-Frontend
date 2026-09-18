import { onCleanup, onMount, type JSX } from 'solid-js'
import { X } from 'lucide-solid'
import { Icon } from './Icon.js'

/**
 * Product modal primitive. Native showModal supplies focus containment,
 * Escape handling, background inertness, and opener-focus restoration.
 */
export function ModalSurface(props: {
  readonly title: string
  readonly ariaLabel?: string
  readonly describedBy?: string
  readonly modalId: string
  readonly testId?: string
  readonly closeLabel?: string
  readonly dismissBlocked?: boolean
  readonly style?: JSX.CSSProperties
  readonly onRequestClose: () => void
  readonly onBackdropPointerDown?: (event: PointerEvent) => void
  readonly onKeyDown?: JSX.EventHandler<HTMLDialogElement, KeyboardEvent>
  readonly children: JSX.Element
}) {
  let dialogEl!: HTMLDialogElement
  let closeRequested = false
  onMount(() => dialogEl.showModal())
  onCleanup(() => {
    // Native close dispatches a close event. Retiring this instance must not
    // route that event through its stale callback after a successor mounts.
    closeRequested = true
    if (dialogEl.open) dialogEl.close()
  })

  const requestClose = (): boolean => {
    if (!props.dismissBlocked && !closeRequested) {
      closeRequested = true
      props.onRequestClose()
      return true
    }
    return false
  }

  return (
    <dialog
      class="modal-surface"
      ref={dialogEl}
      aria-modal="true"
      aria-label={props.ariaLabel ?? props.title}
      aria-describedby={props.describedBy}
      data-modal={props.modalId}
      data-testid={props.testId ?? 'modal-surface'}
      style={props.style}
      onKeyDown={props.onKeyDown}
      onClose={requestClose}
      onCancel={(event) => {
        if (props.dismissBlocked) event.preventDefault()
      }}
      onPointerDown={(event) => {
        const rect = dialogEl.getBoundingClientRect()
        if (
          event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom
        ) {
          event.preventDefault()
          const handoff = event.isTrusted && event.button === 0 && event.target === dialogEl
          if (requestClose() && handoff) props.onBackdropPointerDown?.(event)
        }
      }}
    >
      <header class="dock-header">
        <span class="dock-title">{props.title}</span>
        <button
          class="dock-close"
          data-testid="modal-close"
          aria-label={props.closeLabel ?? `Close ${props.title}`}
          disabled={props.dismissBlocked}
          onClick={requestClose}
        >
          <Icon icon={X} />
        </button>
      </header>
      <div class="modal-content">{props.children}</div>
    </dialog>
  )
}
