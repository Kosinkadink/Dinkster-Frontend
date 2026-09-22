import { Show, type JSX } from 'solid-js'

export function ProductPanelHeader(props: {
  readonly title: JSX.Element
  readonly count?: JSX.Element
  readonly actions?: JSX.Element
  readonly class?: string
  readonly testId?: string
}) {
  return (
    <header
      class={`product-panel-header${props.class ? ` ${props.class}` : ''}`}
      data-testid={props.testId}
    >
      <div class="product-panel-header-title">
        <h2>{props.title}</h2>
        <Show when={props.count !== undefined}>
          <span class="product-panel-header-count">{props.count}</span>
        </Show>
      </div>
      <Show when={props.actions !== undefined}>
        <div class="product-panel-header-actions">{props.actions}</div>
      </Show>
    </header>
  )
}

export type ProductEmptyStateTone = 'empty' | 'loading' | 'error'

export function ProductEmptyState(props: {
  readonly title: JSX.Element
  readonly hint?: JSX.Element
  readonly icon?: JSX.Element
  readonly action?: JSX.Element
  readonly tone?: ProductEmptyStateTone
  readonly class?: string
  readonly testId?: string
}) {
  const tone = (): ProductEmptyStateTone => props.tone ?? 'empty'
  return (
    <div
      class={`product-empty-state${props.class ? ` ${props.class}` : ''}`}
      data-tone={tone()}
      data-testid={props.testId}
      role={
        tone() === 'error'
          ? 'alert'
          : tone() === 'loading'
            ? 'status'
            : undefined
      }
      aria-live={tone() === 'loading' ? 'polite' : undefined}
    >
      <Show when={props.icon !== undefined}>
        <span class="product-empty-state-icon" aria-hidden="true">
          {props.icon}
        </span>
      </Show>
      <strong>{props.title}</strong>
      <Show when={props.hint !== undefined}>
        <span class="product-empty-state-hint">{props.hint}</span>
      </Show>
      <Show when={props.action !== undefined}>
        <div class="product-empty-state-action">{props.action}</div>
      </Show>
    </div>
  )
}

export function ProductListRow(props: {
  readonly primary: JSX.Element
  readonly secondary?: JSX.Element
  readonly leading?: JSX.Element
  readonly actions?: JSX.Element
  readonly selected?: boolean
  readonly class?: string
  readonly testId?: string
  readonly children?: JSX.Element
  readonly dataAttributes?: Readonly<
    Record<`data-${string}`, string | undefined>
  >
}) {
  return (
    <div
      {...props.dataAttributes}
      class={`product-list-row${props.class ? ` ${props.class}` : ''}`}
      classList={{ selected: props.selected === true }}
      data-testid={props.testId}
      role={props.selected !== undefined ? 'option' : undefined}
      aria-selected={props.selected}
    >
      <Show when={props.leading !== undefined}>
        <div class="product-list-row-leading">{props.leading}</div>
      </Show>
      <div class="product-list-row-copy">
        <div class="product-list-row-primary">{props.primary}</div>
        <Show when={props.secondary !== undefined}>
          <div class="product-list-row-secondary">{props.secondary}</div>
        </Show>
        {props.children}
      </div>
      <Show when={props.actions !== undefined}>
        <div class="product-list-row-actions">{props.actions}</div>
      </Show>
    </div>
  )
}

export function ProductTable(props: {
  readonly children: JSX.Element
  readonly caption?: JSX.Element
  readonly stickyHeader?: boolean
  readonly class?: string
  readonly testId?: string
  readonly ariaLabel?: string
}) {
  return (
    <div class="product-table-scroll" tabindex="0" aria-label={props.ariaLabel}>
      <table
        class={`product-table${props.class ? ` ${props.class}` : ''}`}
        classList={{ 'product-table-sticky': props.stickyHeader === true }}
        data-testid={props.testId}
      >
        <Show when={props.caption !== undefined}>
          <caption>{props.caption}</caption>
        </Show>
        {props.children}
      </table>
    </div>
  )
}
