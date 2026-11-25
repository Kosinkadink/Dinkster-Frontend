import { Show, createUniqueId, onCleanup, onMount, type JSX } from 'solid-js'
import { Check, CircleAlert, Info, X } from 'lucide-solid'
import {
  ProductButton,
  ProductIcon,
  ProductIconButton,
  type ProductRole,
} from './controls.js'
import rules from '@dinkster/branding/rules' with { type: 'json' }
import { useProductStrings } from './strings.js'

export function ProductNotice(props: {
  children: JSX.Element
  tone?: 'info' | 'warning'
}) {
  return (
    <div class="dinkster-message" data-kind={props.tone ?? 'info'} role="note">
      <ProductIcon icon={Info} />
      <span class="dinkster-message-copy">{props.children}</span>
    </div>
  )
}

export function ProductErrorBanner(props: {
  children: JSX.Element
  onDismiss: () => void
}) {
  const strings = useProductStrings()
  return (
    <div class="dinkster-message" data-kind="error" role="alert">
      <ProductIcon icon={CircleAlert} />
      <span class="dinkster-message-copy">{props.children}</span>
      <ProductIconButton
        icon={X}
        label={strings.dismissError}
        onClick={props.onDismiss}
      />
    </div>
  )
}

/** The corner region for success feedback. Keep it mounted and pass each
 * success as a new object: the region exists before its text, which is what
 * lets assistive technology announce it, and a new object restarts the
 * lifetime even when the text repeats. */
export function ProductToast(props: {
  notification: { readonly message: string } | undefined
  onDismiss: () => void
}) {
  return (
    <div class="dinkster-toast" role="status">
      <Show when={props.notification} keyed>
        {(notification) => (
          <ToastMessage onDismiss={props.onDismiss}>
            {notification.message}
          </ToastMessage>
        )}
      </Show>
    </div>
  )
}

function ToastMessage(props: { children: JSX.Element; onDismiss: () => void }) {
  const strings = useProductStrings()
  let toast!: HTMLDivElement
  let timer: number | undefined
  let hovered = false
  let focused = false
  // The lifetime restarts when the pointer and keyboard focus have both left,
  // so the toast never disappears from under either.
  const schedule = () => {
    window.clearTimeout(timer)
    if (hovered || focused) return
    timer = window.setTimeout(
      () => props.onDismiss(),
      rules.messages.success.timeoutMs,
    )
  }
  onMount(schedule)
  onCleanup(() => window.clearTimeout(timer))
  return (
    <div
      ref={toast}
      class="dinkster-message"
      data-kind="success"
      onPointerEnter={() => {
        hovered = true
        schedule()
      }}
      onPointerLeave={() => {
        hovered = false
        schedule()
      }}
      onFocusIn={() => {
        focused = true
        schedule()
      }}
      onFocusOut={(event) => {
        focused = toast.contains(event.relatedTarget as Node | null)
        schedule()
      }}
    >
      <ProductIcon icon={Check} />
      <span class="dinkster-message-copy">{props.children}</span>
      <ProductIconButton
        icon={X}
        label={strings.dismissNotification}
        onClick={props.onDismiss}
      />
    </div>
  )
}

export function ProductConfirmation(props: {
  title?: string
  consequence: string
  actionLabel: string
  intent: ProductRole
  pending?: boolean
  disabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const strings = useProductStrings()
  return (
    <section class="dinkster-stack">
      <Show when={props.title}>
        <h2 class="dinkster-heading">{props.title}</h2>
      </Show>
      <p class="dinkster-description">{props.consequence}</p>
      <div class="dinkster-actions">
        <ProductButton
          fill="solid"
          intent={props.intent}
          disabled={props.disabled === true}
          pending={props.pending === true}
          onClick={props.onConfirm}
        >
          {props.actionLabel}
        </ProductButton>
        <ProductButton disabled={props.pending} onClick={props.onCancel}>
          {strings.cancel}
        </ProductButton>
      </div>
    </section>
  )
}

export function ProductDialog(props: {
  title: string
  children: JSX.Element
  onDismiss: () => void
  pending?: boolean
}) {
  const strings = useProductStrings()
  let dialog!: HTMLDialogElement
  const id = createUniqueId()
  let retired = false
  onMount(() => dialog.showModal())
  onCleanup(() => {
    retired = true
    if (dialog.open) dialog.close()
  })
  return (
    <dialog
      ref={dialog}
      class="dinkster-dialog"
      aria-labelledby={id}
      onKeyDown={(event) => {
        // Browsers stop honoring a cancelled `cancel` event after repeated
        // presses, so Escape itself is cancelled while an operation is pending.
        if (event.key === 'Escape' && props.pending) event.preventDefault()
        if (event.key !== 'Tab') return
        const focusable = [
          ...dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((element) => element.getClientRects().length > 0)
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!first) {
          event.preventDefault()
          dialog.focus()
          return
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }}
      onCancel={(event) => {
        if (props.pending) event.preventDefault()
      }}
      onClose={() => {
        if (retired) return
        if (props.pending) dialog.showModal()
        else props.onDismiss()
      }}
    >
      <div class="dinkster-stack">
        <header class="dinkster-dialog-header">
          <h2 id={id} class="dinkster-heading">
            {props.title}
          </h2>
          <ProductIconButton
            icon={X}
            label={strings.close}
            disabled={props.pending === true}
            onClick={() => dialog.close()}
          />
        </header>
        {props.children}
      </div>
    </dialog>
  )
}
