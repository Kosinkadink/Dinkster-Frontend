import {
  For,
  Show,
  createComputed,
  createSignal,
  createUniqueId,
  splitProps,
  type JSX,
} from 'solid-js'
import { ChevronDown, CircleAlert, Clock, LoaderCircle, type LucideIcon } from 'lucide-solid'
import { Dynamic } from 'solid-js/web'
import rules from '@dinkster/branding/rules' with { type: 'json' }
import { useProductStrings } from './strings.js'
import githubMark from '../../../branding/providers/github-mark.svg?url'
import googleMark from '../../../branding/providers/google-mark.svg?url'

export type ProductRole = keyof typeof rules.buttonRoles
export type ProductFill = Exclude<keyof typeof rules.buttonFills, 'quiet'>

type ButtonAttributes = Omit<
  JSX.ButtonHTMLAttributes<HTMLButtonElement>,
  'style' | 'class' | 'role'
>

/** Follows `icon`, so a control can swap its icon with its state, as Record becomes Stop. */
export function ProductIcon(props: { icon: LucideIcon }) {
  return <Dynamic component={props.icon} class="dinkster-icon" aria-hidden="true" />
}

export function ProductRunActivity(props: {
  readonly running: number
  readonly waiting: number
  readonly label: string
}) {
  return (
    <span class="dinkster-run-activity" role="img" aria-label={props.label}>
      <Show when={props.running > 0}>
        <span class="dinkster-run-activity-running" aria-hidden="true">
          <ProductIcon icon={LoaderCircle} />
          <span>{props.running}</span>
        </span>
      </Show>
      <Show when={props.waiting > 0}>
        <span class="dinkster-run-activity-waiting" aria-hidden="true">
          <ProductIcon icon={Clock} /><span>{props.waiting}</span>
        </span>
      </Show>
    </span>
  )
}

export function ProductRunIcon(props: {
  readonly icon: LucideIcon
  readonly running?: boolean | undefined
  readonly queued?: boolean | undefined
  readonly result?: 'finished' | 'failed' | undefined
}) {
  return (
    <span
      class="dinkster-run-icon"
      data-running={props.running ? '' : undefined}
      data-queued={props.queued ? '' : undefined}
      data-result={props.running || props.queued ? undefined : props.result}
      aria-hidden="true"
    >
      <ProductIcon icon={props.icon} />
    </span>
  )
}

function Button(
  props: ButtonAttributes & {
    intent: ProductRole | undefined
    fill: ProductFill | 'quiet'
    pending?: boolean | undefined
    iconOnly?: boolean
  },
) {
  const [local, button] = splitProps(props, [
    'intent',
    'fill',
    'pending',
    'iconOnly',
    'disabled',
    'onClick',
    'ref',
    'children',
  ])
  let element: HTMLButtonElement | undefined
  // The disabled attribute drops keyboard focus to the page. A button that is
  // pending, or that becomes unavailable while it holds focus (Save after a
  // successful save), stays focusable and is announced as unavailable until
  // focus leaves it.
  const [heldFocus, setHeldFocus] = createSignal(false)
  createComputed(() => {
    if (local.disabled && element && document.activeElement === element)
      setHeldFocus(true)
  })
  const focusable = () => local.pending === true || heldFocus()
  const unavailable = () => local.pending === true || local.disabled === true
  return (
    <button
      {...button}
      ref={(node) => {
        element = node
        node.addEventListener('blur', () => setHeldFocus(false))
        ;(local.ref as ((node: HTMLButtonElement) => void) | undefined)?.(node)
      }}
      type={button.type ?? 'button'}
      class="dinkster-button"
      data-role={local.intent ?? 'neutral'}
      data-fill={local.fill}
      data-icon-only={local.iconOnly ? '' : undefined}
      disabled={local.disabled === true && !focusable()}
      aria-disabled={unavailable() && focusable() ? 'true' : undefined}
      aria-busy={local.pending ? 'true' : undefined}
      onClick={(event) => {
        if (unavailable()) {
          event.preventDefault()
          return
        }
        const handler = local.onClick
        if (typeof handler === 'function') handler(event)
        else if (handler) handler[0](handler[1], event)
      }}
    >
      <Show when={local.pending}>
        <span class="dinkster-spinner" aria-hidden="true" />
      </Show>
      {local.children}
    </button>
  )
}

export function ProductButton(
  props: ButtonAttributes & {
    intent?: ProductRole
    fill?: ProductFill
    pending?: boolean
  },
) {
  const [local, button] = splitProps(props, ['intent', 'fill', 'pending'])
  return (
    <Button
      {...button}
      intent={local.intent}
      fill={local.fill ?? 'outline'}
      pending={local.pending}
    />
  )
}

export function ProductWindowAction(
  props: Omit<ButtonAttributes, 'children' | 'aria-label' | 'title'> & {
    label: string
    labelContent?: JSX.Element
    icon: LucideIcon
    shortcut?: string
    intent?: ProductRole
    pending?: boolean
  },
) {
  const [local, button] = splitProps(props, [
    'label',
    'labelContent',
    'icon',
    'shortcut',
    'intent',
    'pending',
  ])
  return (
    <span class="dinkster-window-action">
      <ProductButton
        {...button}
        intent={local.intent ?? 'neutral'}
        pending={local.pending ?? false}
        aria-label={local.label}
        title={
          local.shortcut ? `${local.label} (${local.shortcut})` : local.label
        }
      >
        <span class="dinkster-window-action-icon" aria-hidden="true">
          <ProductIcon icon={local.icon} />
        </span>
        <span class="dinkster-window-action-label">
          {local.labelContent ?? local.label}
        </span>
        <Show when={local.shortcut}>
          {(shortcut) => (
            <kbd class="dinkster-window-action-shortcut">{shortcut()}</kbd>
          )}
        </Show>
      </ProductButton>
    </span>
  )
}

export function ProductProviderButton(
  props: ButtonAttributes & {
    provider: 'github' | 'google'
    pending?: boolean
  },
) {
  const [local, button] = splitProps(props, ['provider', 'children'])
  return (
    <div class="dinkster-provider">
      <ProductButton {...button}>
        <img
          class="dinkster-provider-logo"
          src={local.provider === 'github' ? githubMark : googleMark}
          alt=""
        />
        {local.children}
      </ProductButton>
    </div>
  )
}

export function ProductIconButton(
  props: Omit<ButtonAttributes, 'children' | 'aria-label' | 'title'> & {
    label: string
    icon: LucideIcon
    intent?: ProductRole
    'data-tooltip-label'?: string
  },
) {
  const [local, button] = splitProps(props, ['label', 'icon', 'intent'])
  return (
    <Button
      {...button}
      intent={local.intent}
      fill="quiet"
      iconOnly
      aria-label={local.label}
      title={button['data-tooltip-label'] ? undefined : local.label}
    >
      <ProductIcon icon={local.icon} />
    </Button>
  )
}

/** A secondary action drawn as underlined text beside the value it acts on. */
export function ProductTextButton(
  props: Omit<ButtonAttributes, 'children'> & {
    label: string
    icon?: LucideIcon
    intent?: ProductRole
  },
) {
  const [local, button] = splitProps(props, ['label', 'icon', 'intent'])
  return (
    <button
      {...button}
      type="button"
      class="dinkster-text-button"
      data-role={local.intent ?? 'neutral'}
    >
      <Show when={local.icon}>{(icon) => <ProductIcon icon={icon()} />}</Show>
      {local.label}
    </button>
  )
}

/** One choice of a few, shown side by side. */
export function ProductSegmented(props: {
  label: string
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const name = createUniqueId()
  return (
    <div class="dinkster-segmented" role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option) => (
          <label class="dinkster-segment">
            <input
              type="radio"
              class="dinkster-visually-hidden"
              name={name}
              value={option.value}
              checked={props.value === option.value}
              onChange={() => props.onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        )}
      </For>
    </div>
  )
}

/**
 * A picture with a caption that opens what it shows, such as a workflow or
 * an output. Without a picture the tile keeps its size and shows `empty`.
 */
export function ProductTile(props: {
  label: string
  caption?: string
  detail?: string
  picture?: JSX.Element
  empty?: JSX.Element
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class="dinkster-tile"
      aria-label={props.caption ? undefined : props.label}
      onClick={() => props.onClick()}
    >
      <span class="dinkster-tile-picture">
        <Show
          when={props.picture}
          fallback={<span class="dinkster-tile-empty">{props.empty}</span>}
        >
          {props.picture}
        </Show>
      </span>
      <Show when={props.caption}>
        <span class="dinkster-tile-caption">
          <span class="dinkster-tile-name">{props.caption}</span>
          <Show when={props.detail}>
            <span class="dinkster-tile-detail">{props.detail}</span>
          </Show>
        </span>
      </Show>
    </button>
  )
}

export function ProductLink(
  props: Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, 'style' | 'class'>,
) {
  return <a {...props} class="dinkster-link" />
}

export function ProductSpinner(props: { label?: string }) {
  const strings = useProductStrings()
  return (
    <span class="dinkster-spinner-status" role="status">
      <span class="dinkster-spinner" aria-hidden="true" />
      <span class="dinkster-visually-hidden">
        {props.label ?? strings.loading}
      </span>
    </span>
  )
}

export function ProductTextInput(
  props: Omit<
    JSX.InputHTMLAttributes<HTMLInputElement>,
    'class' | 'style' | 'type'
  > & {
    type?: 'text' | 'email' | 'password' | 'url' | 'search' | 'tel'
    density?: 'canvas'
  },
) {
  const [local, input] = splitProps(props, ['density'])
  return (
    <input {...input} data-density={local.density} class="dinkster-input" />
  )
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
  return (
    <div class="dinkster-select">
      <select {...props} class="dinkster-input" />
      <ProductIcon icon={ChevronDown} />
    </div>
  )
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
          <Show when={props.error}>
            <ProductIcon icon={CircleAlert} />
          </Show>
          {props.error || props.description}
        </p>
      </Show>
    </div>
  )
}
