import { Show, createUniqueId, onCleanup, onMount, type JSX } from 'solid-js'
import { Check, CircleAlert, Info, X } from 'lucide-solid'
import {
  ProductButton,
  ProductIcon,
  ProductIconButton,
  type ProductRole,
} from './controls.js'
import rules from '@dinkster/branding/rules' with { type: 'json' }

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
  return (
    <div class="dinkster-message" data-kind="error" role="alert">
      <ProductIcon icon={CircleAlert} />
      <span class="dinkster-message-copy">{props.children}</span>
      <ProductIconButton
        icon={X}
        label="Dismiss error"
        onClick={props.onDismiss}
      />
    </div>
  )
}

export function ProductToast(props: {
  children: JSX.Element
  onDismiss: () => void
}) {
  onMount(() => {
    const timer = window.setTimeout(
      props.onDismiss,
      rules.messages.success.timeoutMs,
    )
    onCleanup(() => window.clearTimeout(timer))
  })
  return (
    <div
      class="dinkster-toast dinkster-message"
      data-kind="success"
      role="status"
    >
      <ProductIcon icon={Check} />
      <span class="dinkster-message-copy">{props.children}</span>
      <ProductIconButton
        icon={X}
        label="Dismiss notification"
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
  onConfirm: () => void
  onCancel: () => void
}) {
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
          loading={props.pending === true}
          onClick={props.onConfirm}
        >
          {props.actionLabel}
        </ProductButton>
        <ProductButton disabled={props.pending} onClick={props.onCancel}>
          Cancel
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
        if (!retired) props.onDismiss()
      }}
    >
      <div class="dinkster-stack">
        <header class="dinkster-dialog-header">
          <h2 id={id} class="dinkster-heading">
            {props.title}
          </h2>
          <ProductIconButton
            icon={X}
            label={`Close ${props.title}`}
            disabled={props.pending === true}
            onClick={() => dialog.close()}
          />
        </header>
        {props.children}
      </div>
    </dialog>
  )
}
