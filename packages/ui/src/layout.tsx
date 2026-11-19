import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from 'solid-js'
import { Menu, type LucideIcon } from 'lucide-solid'
import symbolUrl from '../../../branding/svg/dinkster-symbol-color.svg?url'
import wordmarkUrl from '../../../branding/svg/dinkster-wordmark-color-dark.svg?url'
import { ProductIcon } from './controls.js'
import { useProductStrings } from './strings.js'

export function ProductBrandMark() {
  return <img class="dinkster-brand-mark" src={symbolUrl} alt="" />
}

export function ProductWordmark() {
  return <img class="dinkster-wordmark" src={wordmarkUrl} alt="Dinkster" />
}

/** A standalone site flow has no shell navigation or top bar. */
export function ProductAuthCard(props: {
  title: string
  children: JSX.Element
  footer?: JSX.Element
}) {
  return (
    <main class="dinkster-auth">
      <div class="dinkster-auth-column">
        <ProductWordmark />
        <section class="dinkster-auth-card" aria-label={props.title}>
          <h1 class="dinkster-title">{props.title}</h1>
          {props.children}
        </section>
        {props.footer}
      </div>
    </main>
  )
}

export function ProductPanel(props: { children: JSX.Element }) {
  return <div class="dinkster-panel">{props.children}</div>
}

export function ProductWindowChrome(props: {
  title: string
  platform: 'darwin' | 'win32' | 'linux'
}) {
  return (
    <header class="dinkster-window-chrome" data-platform={props.platform}>
      <ProductBrandMark />
      <span class="dinkster-brand-title">{props.title}</span>
    </header>
  )
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
  const strings = useProductStrings()
  const [open, setOpen] = createSignal(false)
  const navigationId = createUniqueId()
  let navigationToggle!: HTMLButtonElement
  let sidebar!: HTMLElement
  let main!: HTMLElement
  createEffect(() => {
    if (!open()) return
    const dismiss = (event: PointerEvent) => {
      if (
        !sidebar.contains(event.target as Node) &&
        !navigationToggle.contains(event.target as Node)
      )
        setOpen(false)
    }
    const resize = () => setOpen(false)
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', resize)
    onCleanup(() => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', resize)
    })
  })
  return (
    <div
      class="dinkster-shell"
      data-navigation={props.navigation.length > 0}
      onKeyDown={(event) => {
        // A dialog or menu that is handling Escape keeps it.
        if (
          event.key === 'Escape' &&
          open() &&
          !event.defaultPrevented &&
          !(event.target as Element).closest('dialog')
        ) {
          event.preventDefault()
          setOpen(false)
          navigationToggle.focus()
        }
      }}
    >
      <header class="dinkster-topbar">
        <div class="dinkster-topbar-inner">
          <div class="dinkster-brand">
            <Show when={props.navigation.length > 0}>
              <button
                type="button"
                class="dinkster-button dinkster-mobile-nav"
                data-icon-only=""
                aria-label={strings.toggleNavigation}
                ref={navigationToggle}
                aria-expanded={open()}
                aria-controls={navigationId}
                onClick={() => setOpen(!open())}
              >
                <ProductIcon icon={Menu} />
              </button>
            </Show>
            <ProductBrandMark />
            <ProductWordmark />
            <strong class="dinkster-brand-title">{props.title}</strong>
          </div>
          {props.account}
        </div>
      </header>
      <div class="dinkster-shell-body">
        <Show when={props.navigation.length > 0}>
          <aside class="dinkster-sidebar" data-open={open()} ref={sidebar}>
            <nav
              id={navigationId}
              class="dinkster-nav"
              aria-label={strings.mainNavigation}
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
                      const closing = open()
                      props.onNavigate(item.href)
                      setOpen(false)
                      if (closing) main.focus()
                    }}
                  >
                    <ProductIcon icon={item.icon} />
                    {item.label}
                  </a>
                )}
              </For>
            </nav>
          </aside>
        </Show>
        <main class="dinkster-page" tabindex="-1" ref={main}>
          {props.children}
        </main>
      </div>
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

export function ProductSection(props: {
  title: string
  description?: string
  children: JSX.Element
}) {
  const id = createUniqueId()
  return (
    <section class="dinkster-stack" aria-labelledby={id}>
      <h2 id={id} class="dinkster-heading">
        {props.title}
      </h2>
      <Show when={props.description}>
        <p class="dinkster-description">{props.description}</p>
      </Show>
      {props.children}
    </section>
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
      <span class="dinkster-spinner" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  )
}
