import { Show, type JSX } from 'solid-js'
import { ProductShortcutText } from '@dinkster/ui'
import TriangleAlert from 'lucide-solid/icons/triangle-alert'
import { Icon } from './Icon.js'

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
        <Show when={props.description}>{(text) => <span id={ids.description} class="product-field-description"><ProductShortcutText text={text()} /></span>}</Show>
        <Show when={props.metadata}><span class="product-field-metadata">{props.metadata}</span></Show>
      </div>
      <div class="product-field-control">{props.children}</div>
      <Show when={props.actions}><div class="product-field-actions">{props.actions}</div></Show>
      <Show when={props.message}><ProductFieldMessage id={ids.message} testId={props.messageTestId} tone={tone()}>{props.message}</ProductFieldMessage></Show>
    </div>
  )
}

export function ProductFieldMessage(props: {
  readonly id: string
  readonly testId?: string | undefined
  readonly tone: 'error' | 'warning' | 'status'
  readonly children: JSX.Element
}) {
  return <p
    id={props.id}
    class="product-field-message"
    data-testid={props.testId}
    data-tone={props.tone}
    role={props.tone === 'status' ? 'status' : 'alert'}
    aria-live={props.tone === 'status' ? 'polite' : undefined}
  ><Show when={props.tone === 'warning'}><Icon icon={TriangleAlert} /></Show>{props.children}</p>
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
