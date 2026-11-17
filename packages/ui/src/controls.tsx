import { Show, createUniqueId, splitProps, type JSX } from 'solid-js'
import { type LucideIcon } from 'lucide-solid'

export type ProductRole = 'add' | 'remove' | 'neutral'
export type ProductFill = 'solid' | 'outline'

export function ProductIcon(props: { icon: LucideIcon }) {
  return <props.icon class="dinkster-icon" aria-hidden="true" />
}

export function ProductButton(
  props: Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    'style' | 'class' | 'role'
  > & {
    intent?: ProductRole
    fill?: ProductFill
    loading?: boolean
  },
) {
  const [local, button] = splitProps(props, [
    'intent',
    'fill',
    'loading',
    'disabled',
    'children',
  ])
  return (
    <button
      {...button}
      type={button.type ?? 'button'}
      class="dinkster-button"
      data-role={local.intent ?? 'neutral'}
      data-fill={local.fill ?? 'outline'}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading || undefined}
    >
      <Show when={local.loading}>
        <span class="dinkster-spinner" aria-hidden="true" />
      </Show>
      {local.children}
    </button>
  )
}

export function ProductIconButton(props: {
  label: string
  icon: LucideIcon
  onClick: JSX.EventHandler<HTMLButtonElement, MouseEvent>
  disabled?: boolean
  intent?: ProductRole
}) {
  return (
    <button
      type="button"
      class="dinkster-button"
      data-fill="quiet"
      data-role={props.intent ?? 'neutral'}
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
    >
      <ProductIcon icon={props.icon} />
    </button>
  )
}

export function ProductSpinner(props: { label?: string }) {
  return (
    <span
      class="dinkster-spinner"
      role="status"
      aria-label={props.label ?? 'Loading'}
    />
  )
}

export function ProductTextInput(
  props: Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    'class' | 'style' | 'type'
  > & {
    type?: 'text' | 'email' | 'password' | 'url' | 'search' | 'tel'
  },
) {
  return <input {...props} class="dinkster-input" />
}

export function ProductTextArea(
  props: Omit<
    JSX.TextareaHTMLAttributes<HTMLTextAreaElement>,
    'class' | 'style'
  >,
) {
  return <textarea {...props} class="dinkster-input dinkster-textarea" />
}

export function ProductSelect(
  props: Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, 'class' | 'style'>,
) {
  return <select {...props} class="dinkster-input" />
}

export function ProductCheckbox(
  props: Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    'class' | 'style' | 'type'
  > & { label: string },
) {
  const [local, input] = splitProps(props, ['label', 'children'])
  return (
    <label class="dinkster-choice">
      <input {...input} type="checkbox" class="dinkster-check" />
      <span>{local.label}</span>
    </label>
  )
}

export function ProductRadio(
  props: Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    'class' | 'style' | 'type'
  > & { label: string },
) {
  const [local, input] = splitProps(props, ['label', 'children'])
  return (
    <label class="dinkster-choice">
      <input {...input} type="radio" class="dinkster-check" />
      <span>{local.label}</span>
    </label>
  )
}

export function ProductField(props: {
  label: string
  description?: string
  error?: string
  children: (attributes: {
    id: string
    'aria-describedby': string | undefined
    'aria-invalid': 'true' | undefined
  }) => JSX.Element
}) {
  const id = createUniqueId()
  return (
    <div class="dinkster-field">
      <label for={id}>{props.label}</label>
      {props.children({
        id,
        get 'aria-describedby'() {
          return props.error || props.description ? `${id}-message` : undefined
        },
        get 'aria-invalid'() {
          return props.error ? 'true' : undefined
        },
      })}
      <Show when={props.error || props.description}>
        <p
          id={`${id}-message`}
          class={props.error ? 'dinkster-field-error' : 'dinkster-description'}
          role={props.error ? 'alert' : undefined}
        >
          {props.error || props.description}
        </p>
      </Show>
    </div>
  )
}
