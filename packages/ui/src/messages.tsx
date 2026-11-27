import { For, Show, createUniqueId, onCleanup, onMount, type JSX } from 'solid-js'
import { Check, CircleAlert, Info, TriangleAlert, X } from 'lucide-solid'
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
  tone?: 'info' | 'warning' | 'error'
}) {
  return (
    <div class="dinkster-message" data-kind={props.tone ?? 'info'} role={props.tone === 'error' ? 'alert' : 'note'}>
      <ProductIcon icon={props.tone === 'error' ? CircleAlert : props.tone === 'warning' ? TriangleAlert : Info} />
      <span class="dinkster-message-copy">{props.children}</span>
    </div>
  )
}

export function ProductProgress(props: { label: string; value?: number | undefined }) {
  return (
    <div
      class="dinkster-product-progress"
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={props.value}
      data-indeterminate={props.value === undefined ? '' : undefined}
    >
      <svg viewBox="0 0 100 1" preserveAspectRatio="none" aria-hidden="true">
        <rect width={props.value === undefined ? 100 : props.value * 100} height="1" />
      </svg>
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

export interface ProductConfirmationProps {
  title?: string
  consequence: string
  actionLabel: string
  intent: ProductRole
  items?: readonly { readonly name: string; readonly detail?: string; readonly outcome: string }[] | undefined
  children?: JSX.Element
  error?: string | undefined
  pending?: boolean
  disabled?: boolean
  onConfirm: () => void
  onCancel: () => void
}

function ConfirmationBody(props: ProductConfirmationProps) {
  const strings = useProductStrings()
  let cancel!: HTMLButtonElement
  onMount(() => queueMicrotask(() => {
    if (props.intent === 'remove' && !props.pending && cancel.isConnected) cancel.focus({ preventScroll: true })
  }))
  return (
    <>
      <p class="dinkster-description">{props.consequence}</p>
      <Show when={props.items?.length}>
        <ul class="dinkster-confirmation-items">
          <For each={props.items}>{(item) => <li>
            <span>{item.name}</span>
            <Show when={item.detail}><span class="dinkster-metadata">{item.detail}</span></Show>
            <span class="dinkster-confirmation-outcome">{item.outcome}</span>
          </li>}</For>
        </ul>
      </Show>
      {props.children}
      <Show when={props.error}><ProductNotice tone="error">{props.error}</ProductNotice></Show>
      <div class="dinkster-confirmation-actions">
        <ProductButton ref={cancel} autofocus={props.intent === 'remove'} disabled={props.pending} onClick={props.onCancel}>
          {strings.cancel}
        </ProductButton>
        <ProductButton
          fill="solid"
          intent={props.intent}
          disabled={props.disabled === true}
          pending={props.pending === true}
          onClick={props.onConfirm}
        >
          {props.actionLabel}
        </ProductButton>
      </div>
    </>
  )
}

export function ProductConfirmation(props: ProductConfirmationProps & { surface?: 'filled' | 'inherit' }) {
  return (
    <section class="dinkster-confirmation" data-surface={props.surface ?? 'filled'} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!props.pending) props.onCancel()
      }
    }}>
      <Show when={props.title}><h2 class="dinkster-heading">{props.title}</h2></Show>
      <ConfirmationBody {...props} />
    </section>
  )
}

export function ProductConfirmationDialog(props: ProductConfirmationProps & {
  title: string
  testId?: string | undefined
  modalId?: string | undefined
}) {
  return <ProductDialog title={props.title} pending={props.pending === true} onDismiss={props.onCancel}
    size="confirmation" testId={props.testId} modalId={props.modalId}>
    <ConfirmationBody {...props} />
  </ProductDialog>
}

export function ProductDialog(props: {
  title: string
  children: JSX.Element
  /** The footer action; the dialog owns its preceding Cancel and alignment. */
  action?: JSX.Element
  onDismiss: () => void
  pending?: boolean
  size?: 'default' | 'wide' | 'confirmation'
  testId?: string | undefined
  modalId?: string | undefined
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
      data-size={props.size ?? 'default'}
      data-testid={props.testId}
      data-modal={props.modalId}
      aria-labelledby={id}
      onPointerDown={(event) => {
        if (props.size !== 'confirmation') return
        const rect = dialog.getBoundingClientRect()
        if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom)) {
          event.preventDefault()
          if (!props.pending) dialog.close()
        }
      }}
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
        <Show when={props.action}>{(action) => (
          <footer class="dinkster-dialog-actions">
            <ProductButton disabled={props.pending === true} onClick={props.onDismiss}>{strings.cancel}</ProductButton>
            {action()}
          </footer>
        )}</Show>
      </div>
    </dialog>
  )
}
