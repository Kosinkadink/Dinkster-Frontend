import { Show, type JSX } from 'solid-js'
import { CircleAlert, LoaderCircle, Search, SearchX, X } from 'lucide-solid'
import { Icon } from './Icon.js'

export function SearchInput(props: {
  readonly value: string
  readonly placeholder: string
  readonly controls: string
  readonly describedBy: string
  readonly activeDescendant?: string | undefined
  readonly busy: boolean
  readonly ariaLabel: string
  readonly testId?: string | undefined
  readonly clearTestId?: string | undefined
  readonly variant?: 'surface' | 'toolbar' | undefined
  readonly inputRef?: ((element: HTMLInputElement) => void) | undefined
  readonly onClear?: (() => void) | undefined
  readonly onInput: JSX.EventHandler<HTMLInputElement, InputEvent>
  readonly onKeyDown: JSX.EventHandler<HTMLInputElement, KeyboardEvent>
}) {
  let input: HTMLInputElement | undefined
  return (
    <div class="search-input-shell" data-variant={props.variant ?? 'surface'}>
      <Icon icon={Search} />
      <input
        ref={(element) => {
          input = element
          props.inputRef?.(element)
        }}
        class="search-input"
        data-testid={props.testId}
        type="search"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-autocomplete="list"
        aria-expanded="true"
        aria-haspopup="listbox"
        aria-controls={props.controls}
        aria-describedby={props.describedBy}
        aria-activedescendant={props.activeDescendant}
        aria-busy={props.busy}
        autocomplete="off"
        spellcheck={false}
        value={props.value}
        placeholder={props.placeholder}
        onInput={props.onInput}
        onKeyDown={props.onKeyDown}
      />
      <Show when={props.onClear !== undefined && props.value !== ''}>
        <button
          type="button"
          class="search-input-clear"
          data-testid={props.clearTestId}
          aria-label={`Clear ${props.ariaLabel.toLocaleLowerCase()}`}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            props.onClear?.()
            queueMicrotask(() => input?.focus())
          }}
        >
          <Icon icon={X} />
        </button>
      </Show>
    </div>
  )
}

export function SearchResultGroup(props: {
  readonly id: string
  readonly providerId?: string | undefined
  readonly label: string
  readonly count?: number | undefined
  readonly role?: 'group' | 'region' | undefined
  readonly children: JSX.Element
}) {
  const headingId = `${props.id}-heading`
  return (
    <section
      class="search-result-group"
      data-provider={props.providerId}
      role={props.role ?? 'group'}
      aria-labelledby={headingId}
    >
      <header class="search-result-group-header">
        <h2 id={headingId}>{props.label}</h2>
        <Show when={props.count !== undefined}>
          <span aria-label={`${props.count} results`}>{props.count}</span>
        </Show>
      </header>
      {props.children}
    </section>
  )
}

export function SearchResultRow(props: {
  readonly id: string
  readonly selected: boolean
  readonly title: string
  readonly detail?: string | undefined
  readonly description?: string | undefined
  readonly badge?: string | undefined
  readonly describedBy?: string | undefined
  readonly onHighlight: () => void
  readonly onActivate: () => void
}) {
  return (
    <button
      id={props.id}
      class="search-result-row"
      classList={{ active: props.selected }}
      data-testid="search-result-row"
      type="button"
      role="option"
      aria-selected={props.selected}
      aria-describedby={props.describedBy}
      tabindex="-1"
      onPointerDown={(event) => event.preventDefault()}
      onPointerMove={props.onHighlight}
      onClick={props.onActivate}
    >
      <span class="search-result-row-copy">
        <span class="search-result-row-title">{props.title}</span>
        <Show when={props.detail}>
          {(detail) => <span class="search-result-row-detail">{detail()}</span>}
        </Show>
        <Show when={props.description}>
          {(description) => <span class="search-result-row-description">{description()}</span>}
        </Show>
      </span>
      <Show when={props.badge}>
        {(badge) => <span class="search-result-row-badge">{badge()}</span>}
      </Show>
    </button>
  )
}

export type SearchStateKind = 'loading' | 'empty' | 'error'

export function SearchState(props: {
  readonly kind: SearchStateKind
  readonly title: string
  readonly detail: string
}) {
  const icon = () => props.kind === 'loading' ? LoaderCircle : props.kind === 'error' ? CircleAlert : SearchX
  return (
    <div class="search-state" classList={{ [`search-state-${props.kind}`]: true }} data-search-state={props.kind}>
      <span class="search-state-icon"><Icon icon={icon()} /></span>
      <span class="search-state-copy">
        <strong>{props.title}</strong>
        <span>{props.detail}</span>
      </span>
    </div>
  )
}
