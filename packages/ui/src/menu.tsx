import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from 'solid-js'
import { Check, ChevronDown, LogOut, User, type LucideIcon } from 'lucide-solid'
import { ProductIcon, type ProductRole } from './controls.js'
import { useProductStrings } from './strings.js'
import { placeFloatingSurface } from '@dinkster/core/floating-surface'
import tokens from '@dinkster/branding/components' with { type: 'json' }

/** A count that asks for attention, such as the problems in a panel. */
export interface ProductAttention {
  count: number
  tone: 'info' | 'warning' | 'problem'
  /** What the count means, read after the control's name. */
  label: string
}

export interface ProductMenuItem {
  label: string
  icon?: LucideIcon
  intent?: ProductRole
  disabled?: boolean
  checked?: boolean
  attention?: ProductAttention | undefined
  onSelect: () => void
}

function Attention(props: { attention: ProductAttention }) {
  return (
    <span
      class="dinkster-attention"
      data-tone={props.attention.tone}
      aria-hidden="true"
    >
      {props.attention.count > 99 ? '99+' : props.attention.count}
    </span>
  )
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
  iconOnly?: boolean | undefined
  busy?: boolean
  title?: string
  attention?: ProductAttention | undefined
  onTrigger?: (() => void) | undefined
  children: JSX.Element
}) {
  const strings = useProductStrings()
  const [open, setOpen] = createSignal(false)
  const id = createUniqueId()
  let root!: HTMLDivElement
  let trigger!: HTMLButtonElement
  let menu!: HTMLDivElement
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.focus()
  }
  createEffect(() => {
    props.busy
    close()
  })
  const enabledItems = () => [
    ...menu.querySelectorAll<HTMLButtonElement>(
      '[role^="menuitem"]:not(:disabled)',
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
          left:
            fitsFromLeft &&
            !(props.account && trigger.closest('[data-density="site"]'))
              ? anchor.left
              : anchor.right - surface.width,
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
        data-icon-only={props.iconOnly ? '' : undefined}
        type="button"
        aria-haspopup={props.onTrigger ? undefined : 'menu'}
        aria-label={
          props.attention
            ? `${props.triggerName}${strings.statusSeparator}${props.attention.label}`
            : props.triggerName
        }
        aria-busy={props.busy || undefined}
        title={props.title}
        aria-expanded={props.onTrigger ? undefined : open()}
        aria-controls={open() ? id : undefined}
        onClick={() =>
          props.onTrigger ? props.onTrigger() : open() ? close() : show()
        }
        onKeyDown={(event) => {
          if (
            !props.onTrigger &&
            (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          ) {
            event.preventDefault()
            show(event.key === 'ArrowUp')
          }
        }}
      >
        {props.children}
        <Show when={!props.iconOnly}><ProductIcon icon={ChevronDown} /></Show>
        <Show when={props.attention}>
          {(attention) => <Attention attention={attention()} />}
        </Show>
      </button>
      <Show when={open()}>
        <div
          ref={menu}
          id={id}
          class="dinkster-menu dinkster-menu-popover"
          data-account={props.account ? '' : undefined}
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
                <Show when={identity().email}>
                  <span class="dinkster-metadata">{identity().email}</span>
                </Show>
              </div>
            )}
          </Show>
          <For each={props.items}>
            {(item) => (
              <button
                type="button"
                role={
                  item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'
                }
                aria-checked={item.checked}
                tabindex="-1"
                aria-label={
                  item.attention
                    ? `${item.label}${strings.statusSeparator}${item.attention.label}`
                    : undefined
                }
                class="dinkster-menu-item"
                data-role={item.intent ?? 'neutral'}
                disabled={item.disabled}
                onClick={() => {
                  close(true)
                  item.onSelect()
                }}
              >
                <Show
                  when={item.checked !== undefined}
                  fallback={
                    <Show when={item.icon}>
                      {(icon) => <ProductIcon icon={icon()} />}
                    </Show>
                  }
                >
                  <ProductIcon icon={Check} />
                </Show>
                {item.label}
                <Show when={item.attention}>
                  {(attention) => <Attention attention={attention()} />}
                </Show>
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
  triggerName?: string
  items: readonly ProductMenuItem[]
  identity?: MenuIdentity
  icon?: LucideIcon
  iconOnly?: boolean
  /** Shown on the trigger's corner and read after its name. */
  attention?: ProductAttention | undefined
}) {
  return (
    <Menu
      triggerName={props.triggerName ?? props.label}
      menuName={props.label}
      items={props.items}
      identity={props.identity}
      iconOnly={props.iconOnly}
      attention={props.attention}
    >
      <Show when={props.icon}>{(icon) => <ProductIcon icon={icon()} />}</Show>
      <Show when={!props.iconOnly}><span class="dinkster-menu-label" data-compact={!!props.icon}>
        {props.label}
      </span></Show>
    </Menu>
  )
}

export function ProductSignInControl(props: {
  pending: boolean
  unavailableReason?: string
  onSignIn: () => void
  onCancel: () => void
  onOpenSignInPage?: (() => void) | undefined
}) {
  const strings = useProductStrings()
  const label = () => (props.pending ? strings.signingIn : strings.signIn)
  return (
    <span class="dinkster-sign-in">
      <Menu
        onTrigger={
          props.pending || props.unavailableReason ? undefined : props.onSignIn
        }
        triggerName={label()}
        menuName={label()}
        title={label()}
        busy={props.pending}
        identity={
          props.unavailableReason && !props.pending
            ? { name: props.unavailableReason, email: '' }
            : undefined
        }
        items={
          props.pending
            ? [
                ...(props.onOpenSignInPage
                  ? [
                      {
                        label: strings.openSignInPage,
                        onSelect: props.onOpenSignInPage,
                      },
                    ]
                  : []),
                { label: strings.cancelSignIn, onSelect: props.onCancel },
              ]
            : []
        }
      >
        <span class="dinkster-sign-in-circle" aria-hidden="true">
          <Show when={props.pending} fallback={<ProductIcon icon={User} />}>
            <span class="dinkster-spinner" />
          </Show>
        </span>
      </Menu>
    </span>
  )
}

/** Site triggers show a picture or initial; the menu identifies the session. */
export function ProductAccountMenu(props: {
  name?: string | null
  email?: string | null
  pictureSrc?: string | null
  onSignOut: () => void
}) {
  const strings = useProductStrings()
  const name = () => props.name?.trim() ?? ''
  const email = () => props.email?.trim() ?? ''
  const primary = () => name() || email() || strings.signedIn
  const secondary = () => (name() && email() !== name() ? email() : '')
  const [failed, setFailed] = createSignal(false)
  const picture = createMemo(() => {
    if (!props.pictureSrc) return undefined
    try {
      const url = new URL(props.pictureSrc, window.location.href)
      return url.origin === window.location.origin &&
        ['http:', 'https:'].includes(url.protocol)
        ? url.href
        : undefined
    } catch {
      return undefined
    }
  })
  createEffect(() => {
    picture()
    setFailed(false)
  })
  return (
    <Menu
      triggerName={`${strings.accountMenu}: ${primary()}`}
      menuName={strings.accountMenu}
      account
      identity={{ name: primary(), email: secondary() }}
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
        data-initial={[...(name() || email())][0]?.toLocaleUpperCase() ?? ''}
        data-picture={!!picture() && !failed()}
      >
        <Show
          when={picture() && !failed()}
          fallback={
            <Show when={!name() && !email()}>
              <ProductIcon icon={User} />
            </Show>
          }
        >
          <img src={picture()} alt="" onError={() => setFailed(true)} />
        </Show>
      </span>
      <span class="dinkster-menu-label" data-compact="true">
        {primary()}
      </span>
    </Menu>
  )
}
