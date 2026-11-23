import { onCleanup, onMount, Show, type JSX } from 'solid-js'
import { X } from 'lucide-solid'
import { Icon } from './Icon.js'

/**
 * Product modal primitive. Native showModal supplies focus containment,
 * Escape handling, background inertness, and opener-focus restoration.
 *
 * The `editor` variant is the surface of a full editor: it covers the
 * `bounds` element (the canvas area) instead of being centered, draws no
 * header of its own because the editor frame has one, and a press outside
 * it does nothing.
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
  readonly variant?: 'editor'
  /** The area an `editor` surface covers; the window when absent. */
  readonly bounds?: HTMLElement
  readonly onRequestClose: () => void
  readonly onKeyDown?: (event: KeyboardEvent) => void
  readonly children: JSX.Element
}) {
  let dialogEl!: HTMLDialogElement
  let closeRequested = false
  const editor = props.variant === 'editor'
  const cover = (): void => {
    const bounds = props.bounds
    const rect = bounds && bounds.isConnected ? bounds.getBoundingClientRect() : undefined
    const usable = rect !== undefined && rect.width > 0 && rect.height > 0
    dialogEl.style.left = `${usable ? rect.left : 0}px`
    dialogEl.style.top = `${usable ? rect.top : 0}px`
    dialogEl.style.width = `${usable ? rect.width : window.innerWidth}px`
    dialogEl.style.height = `${usable ? rect.height : window.innerHeight}px`
  }
  onMount(() => {
    if (editor) {
      cover()
      window.addEventListener('resize', cover)
      const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(cover)
      if (props.bounds) observer?.observe(props.bounds)
      onCleanup(() => {
        observer?.disconnect()
        window.removeEventListener('resize', cover)
      })
    }
    dialogEl.showModal()
  })
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
      // The editor frame is a design-system surface; its controls take their states from the root rules.
      classList={{ 'is-editor': editor, 'dinkster-root': editor }}
      ref={dialogEl}
      aria-modal="true"
      aria-label={props.ariaLabel ?? props.title}
      aria-describedby={props.describedBy}
      data-modal={props.modalId}
      data-testid={props.testId ?? 'modal-surface'}
      style={props.style}
      onKeyDown={(event) => {
        // Escape that ends a text composition belongs to the input method.
        if (event.key === 'Escape' && event.isComposing) event.preventDefault()
        // Browsers stop honoring a cancelled `cancel` after repeated presses,
        // so a blocked editor cancels Escape itself.
        if (event.key === 'Escape' && editor && props.dismissBlocked) event.preventDefault()
        props.onKeyDown?.(event)
      }}
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
          // A full editor keeps its draft: a press outside it neither closes
          // it nor reaches anything under it.
          if (!editor) requestClose()
        }
      }}
    >
      <Show when={!editor}>
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
      </Show>
      <div class="modal-content">{props.children}</div>
    </dialog>
  )
}
