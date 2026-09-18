import { createEffect, createSignal, createUniqueId, For, on, onCleanup, onMount, Show, type JSX } from 'solid-js'
import { Portal } from 'solid-js/web'
import { semanticDesignTokens } from '@dinkster/core'
import { placeFloatingSurface } from './floating-surface.js'

export interface ProductSelectOption<T> {
  readonly id: string
  readonly label: string
  readonly value: T
  readonly disabled?: boolean
}

export function ProductSelect<T>(props: {
  readonly options: readonly ProductSelectOption<T>[]
  readonly selectedId: string
  readonly onSelect: (option: ProductSelectOption<T>) => void
  readonly id?: string
  readonly class?: string
  readonly testId?: string
  readonly ariaLabel?: string
  readonly ariaLabelledBy?: string
  readonly ariaDescribedBy?: string | undefined
  readonly ariaInvalid?: boolean
  readonly disabled?: boolean
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string | undefined>>
  readonly onFocus?: JSX.EventHandlerUnion<HTMLButtonElement, FocusEvent>
  readonly onPointerDown?: JSX.EventHandlerUnion<HTMLButtonElement, PointerEvent>
}) {
  const instanceId = createUniqueId()
  const listboxId = `product-select-listbox-${instanceId}`
  const optionId = (index: number): string => `${listboxId}-option-${index}`
  const [open, setOpen] = createSignal(false)
  const [activeIndex, setActiveIndex] = createSignal(-1)
  const [position, setPosition] = createSignal({ left: 0, top: 0, width: 160, maxWidth: 160, maxHeight: 240 })
  let trigger: HTMLButtonElement | undefined
  let listbox: HTMLDivElement | undefined
  let typeahead = ''
  let typeaheadTimer: ReturnType<typeof setTimeout> | undefined

  const selectedIndex = (): number => props.options.findIndex((option) => option.id === props.selectedId)
  const selectedOption = (): ProductSelectOption<T> | undefined => props.options[selectedIndex()]
  const firstEnabled = (): number => props.options.findIndex((option) => option.disabled !== true)
  const lastEnabled = (): number => {
    for (let index = props.options.length - 1; index >= 0; index -= 1) {
      if (props.options[index]?.disabled !== true) return index
    }
    return -1
  }
  const nextEnabled = (from: number, delta: -1 | 1): number => {
    if (props.options.length === 0) return -1
    for (let offset = 1; offset <= props.options.length; offset += 1) {
      const index = (from + delta * offset + props.options.length) % props.options.length
      if (props.options[index]?.disabled !== true) return index
    }
    return -1
  }
  const initialActive = (): number => {
    const selected = selectedIndex()
    return selected >= 0 && props.options[selected]?.disabled !== true ? selected : firstEnabled()
  }

  const place = (): void => {
    if (!trigger) return
    const rect = trigger.getBoundingClientRect()
    const measuredWidth = Math.max(rect.width, listbox?.offsetWidth ?? 0, 160)
    setPosition(placeFloatingSurface({
      surface: { width: measuredWidth, height: listbox?.scrollHeight ?? 280 },
      anchor: rect,
      bounds: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
      direction: 'block',
      margin: semanticDesignTokens.space[8],
      gap: semanticDesignTokens.space[4],
      maxHeight: 280,
      preferredHeight: 160,
    }))
  }

  const focusTrigger = (): void => {
    if (trigger?.isConnected) {
      trigger.focus()
      return
    }
    queueMicrotask(() => {
      const attributes = [
        ['id', props.id],
        ['data-testid', props.testId],
        ['aria-label', props.ariaLabel],
      ] as const
      const candidates = Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="combobox"]'))
      for (const [name, value] of attributes) {
        if (value === undefined) continue
        const matches = candidates.filter((candidate) => candidate.getAttribute(name) === value)
        if (matches.length === 1) {
          matches[0]!.focus()
          return
        }
      }
    })
  }
  const close = (restoreFocus: boolean): void => {
    setOpen(false)
    setActiveIndex(-1)
    if (restoreFocus) focusTrigger()
  }
  const show = (index = initialActive()): void => {
    if (props.disabled === true || props.options.length === 0) return
    setActiveIndex(index)
    setOpen(true)
    queueMicrotask(() => {
      place()
    })
  }
  const choose = (index: number): void => {
    const option = props.options[index]
    if (!option || option.disabled === true) return
    if (option.id === props.selectedId) {
      close(true)
      return
    }
    props.onSelect(option)
    close(true)
  }
  const move = (delta: -1 | 1): void => {
    const selected = selectedIndex()
    const from = open() && activeIndex() >= 0
      ? activeIndex()
      : selected >= 0 && props.options[selected]?.disabled !== true
        ? selected
        : delta === 1 ? -1 : 0
    const next = nextEnabled(from, delta)
    if (!open()) show(next)
    else setActiveIndex(next)
  }
  const matchTypeahead = (key: string): void => {
    if (typeaheadTimer !== undefined) clearTimeout(typeaheadTimer)
    typeahead += key.toLocaleLowerCase()
    typeaheadTimer = setTimeout(() => { typeahead = '' }, 500)
    const from = open() ? Math.max(activeIndex(), -1) : Math.max(selectedIndex(), -1)
    for (let offset = 1; offset <= props.options.length; offset += 1) {
      const index = (from + offset) % props.options.length
      const option = props.options[index]
      if (option?.disabled !== true && option?.label.toLocaleLowerCase().startsWith(typeahead)) {
        if (!open()) show(index)
        else setActiveIndex(index)
        return
      }
    }
  }

  const keydown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab') {
      if (open()) close(false)
      return
    }
    if (event.key === 'Escape' && open()) {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const index = event.key === 'Home' ? firstEnabled() : lastEnabled()
      if (!open()) show(index)
      else setActiveIndex(index)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open()) choose(activeIndex())
      else show()
      return
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      matchTypeahead(event.key)
    }
  }

  createEffect(on(
    () => [props.options, props.selectedId] as const,
    () => {
      if (!open()) return
      const next = initialActive()
      setActiveIndex(next)
      queueMicrotask(() => {
        place()
      })
    },
    { defer: true },
  ))

  createEffect(() => {
    const index = activeIndex()
    if (!open() || index < 0) return
    queueMicrotask(() => {
      listbox?.querySelector<HTMLElement>(`#${CSS.escape(optionId(index))}`)?.scrollIntoView({ block: 'nearest' })
    })
  })

  onMount(() => {
    const outside = (event: PointerEvent): void => {
      if (!open()) return
      const target = event.target
      if (target instanceof Node && (trigger?.contains(target) === true || listbox?.contains(target) === true)) return
      close(false)
    }
    const reposition = (): void => { if (open()) place() }
    document.addEventListener('pointerdown', outside, true)
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    onCleanup(() => {
      document.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    })
  })
  onCleanup(() => { if (typeaheadTimer !== undefined) clearTimeout(typeaheadTimer) })

  return (
    <>
      <button
        {...props.dataAttributes}
        ref={trigger}
        id={props.id}
        type="button"
        class={`product-select${props.class ? ` ${props.class}` : ''}`}
        data-testid={props.testId}
        data-selected-id={props.selectedId}
        role="combobox"
        aria-label={props.ariaLabel}
        aria-labelledby={props.ariaLabelledBy}
        aria-describedby={props.ariaDescribedBy}
        aria-invalid={props.ariaInvalid ? 'true' : undefined}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open()}
        aria-activedescendant={open() && activeIndex() >= 0 ? optionId(activeIndex()) : undefined}
        disabled={props.disabled}
        onFocus={props.onFocus}
        onPointerDown={props.onPointerDown}
        onClick={() => open() ? close(true) : show()}
        onKeyDown={keydown}
      >
        <span class="product-select-value">{selectedOption()?.label ?? props.selectedId}</span>
        <span class="product-select-caret" aria-hidden="true" />
      </button>
      <Show when={open()}>
        <Portal mount={trigger?.closest('dialog') ?? document.body}>
          <div
            ref={listbox}
            id={listboxId}
            class="product-select-listbox floating-surface"
            role="listbox"
            aria-label={props.ariaLabel}
            aria-labelledby={props.ariaLabelledBy}
            style={{
              left: `${position().left}px`,
              top: `${position().top}px`,
              width: `${position().width}px`,
              'max-width': `${position().maxWidth}px`,
              'max-height': `${position().maxHeight}px`,
            }}
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <For each={props.options}>
              {(option, index) => (
                <div
                  id={optionId(index())}
                  classList={{
                    'product-select-option': true,
                    active: index() === activeIndex(),
                    selected: option.id === props.selectedId,
                    disabled: option.disabled === true,
                  }}
                  data-option-id={option.id}
                  role="option"
                  aria-selected={option.id === props.selectedId}
                  aria-disabled={option.disabled === true}
                  onPointerMove={() => { if (option.disabled !== true) setActiveIndex(index()) }}
                  onClick={() => choose(index())}
                >
                  {option.label}
                </div>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </>
  )
}
