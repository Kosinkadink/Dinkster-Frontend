import { Show, type JSX } from 'solid-js'

export interface ProductFieldIds {
  readonly label: string
  readonly description: string
  readonly message: string
}

export function productFieldIds(controlId: string): ProductFieldIds {
  return {
    label: `${controlId}-label`,
    description: `${controlId}-description`,
    message: `${controlId}-message`,
  }
}

export function ProductField(props: {
  readonly controlId: string
  readonly label: string
  readonly description?: string | undefined
  readonly metadata?: JSX.Element
  readonly message?: JSX.Element
  readonly messageTestId?: string
  readonly messageTone?: 'error' | 'warning' | 'status'
  readonly invalid?: boolean
  readonly layout?: 'row' | 'stack' | 'compact'
  readonly class?: string
  readonly actions?: JSX.Element
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string | undefined>>
  readonly children: JSX.Element
}) {
  const ids = productFieldIds(props.controlId)
  const tone = () => props.messageTone ?? 'error'
  return (
    <div
      {...props.dataAttributes}
      class={`product-field${props.class ? ` ${props.class}` : ''}`}
      classList={{ 'product-field-invalid': props.invalid === true }}
      data-layout={props.layout ?? 'row'}
      role="group"
      aria-labelledby={ids.label}
    >
      <div class="product-field-copy">
        <label id={ids.label} class="product-field-label" for={props.controlId}>{props.label}</label>
        <Show when={props.description}><span id={ids.description} class="product-field-description">{props.description}</span></Show>
        <Show when={props.metadata}><span class="product-field-metadata">{props.metadata}</span></Show>
      </div>
      <div class="product-field-control">{props.children}</div>
      <Show when={props.actions}><div class="product-field-actions">{props.actions}</div></Show>
      <Show when={props.message}>
        <p
          id={ids.message}
          class="product-field-message"
          data-testid={props.messageTestId}
          data-tone={tone()}
          role={tone() === 'status' ? 'status' : 'alert'}
          aria-live={tone() === 'status' ? 'polite' : undefined}
        >{props.message}</p>
      </Show>
    </div>
  )
}

export function ProductNotice(props: {
  readonly tone: 'info' | 'warning' | 'error' | 'status'
  readonly class?: string
  readonly testId?: string
  readonly children: JSX.Element
}) {
  const role = (): 'alert' | 'status' | undefined =>
    props.tone === 'error' || props.tone === 'warning' ? 'alert' : props.tone === 'status' ? 'status' : undefined
  return (
    <p
      class={`product-notice${props.class ? ` ${props.class}` : ''}`}
      data-testid={props.testId}
      data-tone={props.tone}
      role={role()}
      aria-live={props.tone === 'status' ? 'polite' : undefined}
    >{props.children}</p>
  )
}

export function ProductActionFooter(props: {
  readonly class?: string
  readonly status?: JSX.Element
  readonly children: JSX.Element
}) {
  return (
    <footer class={`product-action-footer${props.class ? ` ${props.class}` : ''}`}>
      <Show when={props.status}><div class="product-action-status">{props.status}</div></Show>
      <div class="product-action-buttons">{props.children}</div>
    </footer>
  )
}
