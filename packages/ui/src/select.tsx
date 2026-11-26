import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  splitProps,
  type JSX,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import { Check, ChevronDown } from 'lucide-solid'
import { placeFloatingSurface } from '@dinkster/core/floating-surface'
import { semanticDesignTokens } from '@dinkster/core'
import { useFieldFocus } from './field-focus.js'

export interface ProductSelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export function ProductSelect(
  props: Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    | 'class'
    | 'style'
    | 'children'
    | 'value'
    | 'onChange'
    | 'onClick'
    | 'onKeyDown'
    | 'type'
    | 'name'
  > & {
    readonly options: readonly ProductSelectOption[]
    readonly value?: string | undefined
    readonly onChange?: (value: string) => void
    readonly name?: string
  },
) {
  useFieldFocus()
  const [local, button] = splitProps(props, [
    'options',
    'value',
    'onChange',
    'name',
    'id',
    'disabled',
    'ref',
  ])
  const id = createUniqueId()
  const triggerId = () => local.id ?? `select-${id}`
  const listId = `select-list-${id}`
  const optionId = (index: number) => `${listId}-${index}`
  const [chosen, setChosen] = createSignal<string>()
  const value = () =>
    local.value ??
    chosen() ??
    local.options.find((option) => !option.disabled)?.value ??
    ''
  const [open, setOpen] = createSignal(false)
  const [active, setActive] = createSignal(-1)
  let trigger!: HTMLButtonElement
  let list!: HTMLDivElement
  let typed = ''
  let typedAt = 0
  const enabled = (index: number) =>
    local.options[index] !== undefined && !local.options[index]!.disabled
  const initial = () => {
    const selected = local.options.findIndex(
      (option) => option.value === value(),
    )
    return enabled(selected)
      ? selected
      : local.options.findIndex((option) => !option.disabled)
  }
  const place = () => {
    if (!trigger || !list) return
    const rect = trigger.getBoundingClientRect()
    const placed = placeFloatingSurface({
      anchor: rect,
      surface: { width: rect.width, height: list.scrollHeight + 2 },
      bounds: {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      },
      direction: 'block',
      margin: semanticDesignTokens.space[8],
      gap: semanticDesignTokens.space[4],
      maxHeight: 280,
      preferredHeight: 160,
    })
    Object.assign(list.style, {
      left: `${placed.left}px`,
      top: `${placed.top}px`,
      width: `${placed.width}px`,
      maxHeight: `${placed.maxHeight}px`,
    })
  }
  const close = () => {
    setOpen(false)
    typed = ''
  }
  const show = (index = initial()) => {
    if (local.disabled || !local.options.length) return
    setActive(index)
    setOpen(true)
    queueMicrotask(place)
  }
  const pick = (index: number) => {
    if (local.disabled || !enabled(index)) return
    const next = local.options[index]!.value
    const previous = value()
    setChosen(next)
    close()
    trigger.focus()
    if (next !== previous) local.onChange?.(next)
  }
  const move = (delta: -1 | 1) => {
    const count = local.options.length
    const start = open() ? active() : initial()
    for (let offset = 1; offset <= count; offset++) {
      const next = (start + delta * offset + count) % count
      if (enabled(next)) {
        if (!open()) show(next)
        else setActive(next)
        return
      }
    }
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key === 'Tab') {
      close()
      return
    }
    if (event.key === 'Escape' && open()) {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const last = [...local.options]
        .reverse()
        .findIndex((option) => !option.disabled)
      const next =
        event.key === 'Home'
          ? local.options.findIndex((option) => !option.disabled)
          : last < 0
            ? -1
            : local.options.length - 1 - last
      if (!open()) show(next)
      else setActive(next)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open()) pick(active())
      else show()
      return
    }
    if (
      event.key.length !== 1 ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey
    )
      return
    event.preventDefault()
    const now = performance.now()
    typed = (now - typedAt > 500 ? '' : typed) + event.key.toLocaleLowerCase()
    typedAt = now
    const start = open() ? active() : initial()
    for (let offset = 1; offset <= local.options.length; offset++) {
      const index = (start + offset) % local.options.length
      if (
        enabled(index) &&
        local.options[index]!.label.toLocaleLowerCase().startsWith(typed)
      ) {
        if (!open()) show(index)
        else setActive(index)
        break
      }
    }
  }
  createEffect(() => {
    const options = local.options
    const selected = value()
    if (local.disabled) close()
    if (!open()) return
    if (!enabled(active())) setActive(initial())
    void [options, selected]
    queueMicrotask(() => {
      place()
      const row = list?.querySelector<HTMLElement>(
        `#${CSS.escape(optionId(active()))}`,
      )
      if (!row) return
      if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop
      else if (
        row.offsetTop + row.offsetHeight >
        list.scrollTop + list.clientHeight
      )
        list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight
    })
  })
  onMount(() => {
    const outside = (event: Event) => {
      if (
        open() &&
        event.target instanceof Node &&
        !trigger.contains(event.target) &&
        !list.contains(event.target)
      )
        close()
    }
    const follow = () => {
      if (open()) place()
    }
    const observer = new ResizeObserver(follow)
    observer.observe(trigger)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', follow)
      window.removeEventListener('scroll', follow, true)
    })
  })
  return (
    <>
      <Show when={local.name}>
        <input
          type="hidden"
          name={local.name}
          value={value()}
          disabled={local.disabled}
        />
      </Show>
      <button
        {...button}
        ref={(element) => {
          trigger = element
          ;(local.ref as ((element: HTMLButtonElement) => void) | undefined)?.(
            element,
          )
        }}
        id={triggerId()}
        class="dinkster-input dinkster-select-trigger"
        type="button"
        disabled={local.disabled}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open()}
        aria-controls={open() ? listId : undefined}
        aria-activedescendant={
          open() && active() >= 0 ? optionId(active()) : undefined
        }
        onClick={() => (open() ? close() : show())}
        onKeyDown={keydown}
      >
        <span class="dinkster-canvas-list-label">
          {local.options.find((option) => option.value === value())?.label ??
            value()}
        </span>
        <ChevronDown class="dinkster-icon" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <Portal mount={trigger.closest('dialog') ?? document.body}>
          <div
            ref={list}
            id={listId}
            role="listbox"
            class="floating-surface dinkster-select-list"
            aria-label={button['aria-label']}
            aria-labelledby={
              button['aria-labelledby'] ??
              (button['aria-label'] ? undefined : triggerId())
            }
          >
            <For each={local.options}>
              {(option, index) => (
                <div
                  id={optionId(index())}
                  role="option"
                  class="dinkster-canvas-list-option"
                  aria-selected={option.value === value()}
                  aria-disabled={option.disabled === true}
                  data-active={index() === active()}
                  onPointerDown={(event) => event.preventDefault()}
                  onPointerMove={() => {
                    if (enabled(index())) setActive(index())
                  }}
                  onClick={() => pick(index())}
                >
                  <span class="dinkster-canvas-list-copy">
                    <span class="dinkster-canvas-list-label">
                      {option.label}
                    </span>
                  </span>
                  <Show when={option.value === value()}>
                    <Check
                      class="dinkster-canvas-list-check"
                      aria-hidden="true"
                    />
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  )
}
