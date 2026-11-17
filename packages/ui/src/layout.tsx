import { For, Show, createSignal, type JSX } from 'solid-js'
import { Menu, type LucideIcon } from 'lucide-solid'
import symbolUrl from '../../../branding/svg/dinkster-symbol-color.svg?url'
import { ProductIcon, ProductSpinner } from './controls.js'

export function ProductBrandMark() {
  return <img class="dinkster-brand-mark" src={symbolUrl} alt="" />
}

export interface ProductNavigationItem {
  label: string
  href: string
  icon: LucideIcon
}

export function ProductShell(props: {
  title: string
  navigation: readonly ProductNavigationItem[]
  currentHref: string
  onNavigate: (href: string) => void
  account?: JSX.Element
  children: JSX.Element
}) {
  const [open, setOpen] = createSignal(false)
  let navigationToggle!: HTMLButtonElement
  return (
    <div
      class="dinkster-shell"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open()) {
          event.preventDefault()
          setOpen(false)
          navigationToggle.focus()
        }
      }}
    >
      <header class="dinkster-topbar">
        <div class="dinkster-brand">
          <button
            type="button"
            class="dinkster-button dinkster-mobile-nav"
            aria-label="Toggle navigation"
            ref={navigationToggle}
            aria-expanded={open()}
            aria-controls="dinkster-navigation"
            onClick={() => setOpen(!open())}
          >
            <ProductIcon icon={Menu} />
          </button>
          <ProductBrandMark />
          <strong class="dinkster-brand-title">{props.title}</strong>
        </div>
        {props.account}
      </header>
      <aside class="dinkster-sidebar" data-open={open()}>
        <nav
          id="dinkster-navigation"
          class="dinkster-nav"
          aria-label="Main navigation"
        >
          <For each={props.navigation}>
            {(item) => (
              <a
                class="dinkster-nav-item"
                href={item.href}
                aria-current={
                  props.currentHref === item.href ? 'page' : undefined
                }
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.ctrlKey ||
                    event.metaKey ||
                    event.altKey ||
                    event.shiftKey
                  )
                    return
                  event.preventDefault()
                  props.onNavigate(item.href)
                  setOpen(false)
                }}
              >
                <ProductIcon icon={item.icon} />
                {item.label}
              </a>
            )}
          </For>
        </nav>
      </aside>
      <main class="dinkster-page">{props.children}</main>
    </div>
  )
}

export function ProductPage(props: {
  title: string
  description?: string
  table?: boolean
  children: JSX.Element
}) {
  return (
    <div
      class="dinkster-content dinkster-stack"
      data-width={props.table ? 'table' : undefined}
    >
      <header class="dinkster-stack">
        <h1 class="dinkster-title">{props.title}</h1>
        <Show when={props.description}>
          <p class="dinkster-description">{props.description}</p>
        </Show>
      </header>
      {props.children}
    </div>
  )
}

export function ProductList(props: { label: string; children: JSX.Element }) {
  return (
    <ul class="dinkster-list" aria-label={props.label}>
      {props.children}
    </ul>
  )
}

export function ProductListRow(props: {
  title: string
  description?: string
  action?: JSX.Element
}) {
  return (
    <li class="dinkster-row">
      <div class="dinkster-row-copy">
        <span>{props.title}</span>
        <Show when={props.description}>
          <span class="dinkster-metadata">{props.description}</span>
        </Show>
      </div>
      {props.action}
    </li>
  )
}

export function ProductTable<T>(props: {
  label: string
  columns: readonly { label: string; cell: (row: T) => JSX.Element }[]
  rows: readonly T[]
}) {
  return (
    <div
      class="dinkster-table-scroll"
      role="region"
      aria-label={props.label}
      tabindex="0"
    >
      <table class="dinkster-table">
        <caption class="dinkster-visually-hidden">{props.label}</caption>
        <thead>
          <tr>
            <For each={props.columns}>
              {(column) => <th scope="col">{column.label}</th>}
            </For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows}>
            {(row) => (
              <tr>
                <For each={props.columns}>
                  {(column) => <td>{column.cell(row)}</td>}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

export function ProductEmptyState(props: {
  message: string
  action?: JSX.Element
}) {
  return (
    <div class="dinkster-empty">
      <ProductBrandMark />
      <p class="dinkster-description">{props.message}</p>
      {props.action}
    </div>
  )
}

export function ProductLoading(props: { label: string }) {
  return (
    <div class="dinkster-actions" role="status">
      <ProductSpinner />
      <span>{props.label}</span>
    </div>
  )
}
