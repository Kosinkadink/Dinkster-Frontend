import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from 'solid-js'
import { ChevronDown, LogOut, type LucideIcon } from 'lucide-solid'
import { ProductIcon, type ProductRole } from './controls.js'
import { useProductStrings } from './strings.js'
import { placeFloatingSurface } from '@dinkster/core/floating-surface'
import tokens from '@dinkster/branding/components' with { type: 'json' }

export interface ProductMenuItem {
  label: string
  icon?: LucideIcon
  intent?: ProductRole
  disabled?: boolean
  onSelect: () => void
}

interface MenuIdentity {
  name: string
  email: string
}

function Menu(props: {
  triggerName: string
  menuName: string
  items: readonly ProductMenuItem[]
  identity: MenuIdentity | undefined
  account?: boolean
  children: JSX.Element
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
  const enabledItems = () => [
    ...menu.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    ),
  ]
  const show = (last = false) => {
    setOpen(true)
    queueMicrotask(() => {
      if (!open()) return
      const anchor = trigger.getBoundingClientRect()
      const surface = menu.getBoundingClientRect()
      const margin = tokens.space[8]
      // Left edges align; a trigger too near the right edge of the window
      // aligns right edges instead, before the shared clamp applies.
      const fitsFromLeft =
        anchor.left + surface.width <= window.innerWidth - margin
      const placement = placeFloatingSurface({
        surface,
        anchor: {
          left: fitsFromLeft ? anchor.left : anchor.right - surface.width,
          top: anchor.top,
          right: anchor.right,
          bottom: anchor.bottom,
        },
        bounds: {
          left: 0,
          top: 0,
          right: window.innerWidth,
          bottom: window.innerHeight,
        },
        direction: 'block',
        margin,
        gap: tokens.space[4],
      })
      // Coordinates are measured geometry; all visual styling stays in the stylesheet.
      menu.style.left = `${placement.left}px`
      menu.style.top = `${placement.top}px`
      menu.style.maxHeight = `${placement.maxHeight}px`
      const items = enabledItems()
      ;(items[last ? items.length - 1 : 0] ?? menu).focus()
    })
  }
  // Dismissal listeners exist only while the menu is open, so a page with
  // many menus does not run one handler per menu on every press.
  createEffect(() => {
    if (!open()) return
    const dismiss = () => close()
    const scroll = (event: Event) => {
      if (!menu?.contains(event.target as Node)) close()
    }
    const outside = (event: PointerEvent) => {
      if (!root.contains(event.target as Node)) close()
    }
    window.addEventListener('resize', dismiss)
    document.addEventListener('scroll', scroll, true)
    document.addEventListener('pointerdown', outside)
    onCleanup(() => {
      window.removeEventListener('resize', dismiss)
      document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('pointerdown', outside)
    })
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
        data-account={props.account ? '' : undefined}
        type="button"
        aria-haspopup="menu"
        aria-label={props.triggerName}
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
        {props.children}
        <ProductIcon icon={ChevronDown} />
      </button>
      <Show when={open()}>
        <div
          ref={menu}
          id={id}
          class="dinkster-menu dinkster-menu-popover"
          role="menu"
          tabindex="-1"
          aria-label={props.menuName}
          aria-describedby={props.identity ? `${id}-identity` : undefined}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              close(true)
            }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const items = enabledItems()
              const current = items.indexOf(
                document.activeElement as HTMLButtonElement,
              )
              const last = items.length - 1
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? last
                    : event.key === 'ArrowDown'
                      ? current === last
                        ? 0
                        : current + 1
                      : current <= 0
                        ? last
                        : current - 1
              items[next]?.focus()
            }
          }}
        >
          <Show when={props.identity}>
            {(identity) => (
              <div
                id={`${id}-identity`}
                class="dinkster-menu-identity"
                role="presentation"
              >
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

export function ProductMenu(props: {
  label: string
  items: readonly ProductMenuItem[]
  identity?: MenuIdentity
  icon?: LucideIcon
}) {
  return (
    <Menu
      triggerName={props.label}
      menuName={props.label}
      items={props.items}
      identity={props.identity}
    >
      <Show when={props.icon}>{(icon) => <ProductIcon icon={icon()} />}</Show>
      <span class="dinkster-menu-label" data-compact={!!props.icon}>
        {props.label}
      </span>
    </Menu>
  )
}

/** The signed-in person's menu: their initial and name on the trigger, then
 * name, email and Sign out, which acts at once. */
export function ProductAccountMenu(props: {
  name: string
  email: string
  onSignOut: () => void
}) {
  const strings = useProductStrings()
  return (
    <Menu
      triggerName={`${strings.accountMenu}: ${props.name}`}
      menuName={strings.accountMenu}
      account
      identity={{ name: props.name, email: props.email }}
      items={[
        {
          label: strings.signOut,
          icon: LogOut,
          intent: 'remove',
          onSelect: props.onSignOut,
        },
      ]}
    >
      <span
        class="dinkster-avatar"
        aria-hidden="true"
        // Drawn by the stylesheet so the initial is not part of the visible
        // label that the accessible name has to contain.
        data-initial={[...props.name.trim()][0]?.toLocaleUpperCase() ?? ''}
      />
      <span class="dinkster-menu-label" data-compact="true">
        {props.name}
      </span>
    </Menu>
  )
}
