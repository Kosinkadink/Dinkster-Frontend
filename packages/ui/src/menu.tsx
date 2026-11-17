import {
  For,
  Show,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js'
import { ChevronDown, LogOut, User, type LucideIcon } from 'lucide-solid'
import { ProductIcon, type ProductRole } from './controls.js'

export interface ProductMenuItem {
  label: string
  icon?: LucideIcon
  intent?: ProductRole
  disabled?: boolean
  onSelect: () => void
}

export function ProductMenu(props: {
  label: string
  items: readonly ProductMenuItem[]
  identity?: { name: string; email: string }
  icon?: LucideIcon
}) {
  const [open, setOpen] = createSignal(false)
  const id = createUniqueId()
  let root!: HTMLDivElement
  let trigger!: HTMLButtonElement
  let menu!: HTMLDivElement
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.focus()
  }
  const focusItem = (last = false) => {
    const items = menu?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    )
    const item = items?.[last ? items.length - 1 : 0]
    item?.focus()
  }
  const show = (last = false) => {
    setOpen(true)
    queueMicrotask(() => {
      if (open()) focusItem(last)
    })
  }
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', outside)
    onCleanup(() => document.removeEventListener('pointerdown', outside))
  })
  return (
    <div
      class="dinkster-menu-anchor"
      ref={root}
      onFocusOut={(event) => {
        if (!root.contains(event.relatedTarget as Node | null)) close()
      }}
    >
      <button
        ref={trigger}
        class="dinkster-button dinkster-menu-trigger"
        type="button"
        aria-haspopup="menu"
        aria-label={props.label}
        aria-expanded={open()}
        aria-controls={open() ? id : undefined}
        onClick={() => (open() ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show(event.key === 'ArrowUp')
          }
        }}
      >
        <Show when={props.icon}>{(icon) => <ProductIcon icon={icon()} />}</Show>
        <span class="dinkster-menu-label" data-compact={!!props.icon}>
          {props.label}
        </span>
        <ProductIcon icon={ChevronDown} />
      </button>
      <Show when={open()}>
        <div
          ref={menu}
          id={id}
          class="dinkster-menu dinkster-menu-popover"
          role="menu"
          aria-label={props.label}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close(true)
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const items = [
                ...menu.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              ]
              const current = items.indexOf(
                document.activeElement as HTMLButtonElement,
              )
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (current +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        items.length) %
                      items.length
              items[next]?.focus()
            }
          }}
        >
          <Show when={props.identity}>
            {(identity) => (
              <div class="dinkster-menu-identity" role="presentation">
                <strong>{identity().name}</strong>
                <span class="dinkster-metadata">{identity().email}</span>
              </div>
            )}
          </Show>
          <For each={props.items}>
            {(item) => (
              <button
                type="button"
                role="menuitem"
                tabindex="-1"
                class="dinkster-menu-item"
                data-role={item.intent ?? 'neutral'}
                disabled={item.disabled}
                onClick={() => {
                  close(true)
                  item.onSelect()
                }}
              >
                <Show when={item.icon}>
                  {(icon) => <ProductIcon icon={icon()} />}
                </Show>
                {item.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

export function ProductAccountMenu(props: {
  name: string
  email: string
  onSignOut: () => void
}) {
  return (
    <ProductMenu
      label="Account menu"
      icon={User}
      identity={{ name: props.name, email: props.email }}
      items={[
        {
          label: 'Sign out',
          icon: LogOut,
          intent: 'remove',
          onSelect: props.onSignOut,
        },
      ]}
    />
  )
}
