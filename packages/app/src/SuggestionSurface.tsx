import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import { semanticDesignTokens } from '@dinkster/core'
import { placeFloatingSurface } from './floating-surface.js'

export interface SuggestionSurfaceItem {
  readonly id: string
  readonly label: string
  readonly detail?: string
}

export type SuggestionSurfaceState<T extends SuggestionSurfaceItem> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly items: readonly T[] }
  | { readonly status: 'empty' }
  | { readonly status: 'error'; readonly message: string }

export interface SuggestionInteraction<T extends SuggestionSurfaceItem> {
  readonly listboxId: string
  readonly statusId: string
  readonly activeIndex: () => number
  readonly optionId: (index: number) => string
  readonly activeOptionId: (items: readonly T[]) => string | undefined
  readonly reset: () => void
  readonly activate: (index: number) => void
  readonly onKeyDown: (
    event: KeyboardEvent,
    items: readonly T[],
    anchor: HTMLElement,
    onAccept: (item: T, index: number) => void,
    onDismiss: () => void,
  ) => boolean
  readonly accept: (
    index: number,
    items: readonly T[],
    anchor: HTMLElement,
    onAccept: (item: T, index: number) => void,
  ) => void
}

const restoreFocus = (anchor: HTMLElement): void => {
  queueMicrotask(() => {
    if (anchor.isConnected) anchor.focus()
  })
}

export function createSuggestionInteraction<T extends SuggestionSurfaceItem>(): SuggestionInteraction<T> {
  const instanceId = createUniqueId()
  const listboxId = `suggestion-listbox-${instanceId}`
  const [activeIndex, setActiveIndex] = createSignal(0)
  const optionId = (index: number): string => `${listboxId}-option-${index}`
  const activeOptionId = (items: readonly T[]): string | undefined =>
    items[activeIndex()] === undefined ? undefined : optionId(activeIndex())
  const activate = (index: number): void => { setActiveIndex(Math.max(0, index)) }
  const reset = (): void => { setActiveIndex(0) }
  const accept = (
    index: number,
    items: readonly T[],
    anchor: HTMLElement,
    onAccept: (item: T, index: number) => void,
  ): void => {
    const item = items[index]
    if (item === undefined) return
    onAccept(item, index)
    restoreFocus(anchor)
  }
  const onKeyDown = (
    event: KeyboardEvent,
    items: readonly T[],
    anchor: HTMLElement,
    onAccept: (item: T, index: number) => void,
    onDismiss: () => void,
  ): boolean => {
    if (event.isComposing) return false
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
      restoreFocus(anchor)
      return true
    }
    if (items.length === 0) return false
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex((activeIndex() + direction + items.length) % items.length)
      return true
    }
    if (event.key === 'Tab' || event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      accept(activeIndex(), items, anchor, onAccept)
      return true
    }
    return false
  }
  return {
    listboxId,
    statusId: `${listboxId}-status`,
    activeIndex,
    optionId,
    activeOptionId,
    reset,
    activate,
    onKeyDown,
    accept,
  }
}

export function SuggestionSurface<T extends SuggestionSurfaceItem>(props: {
  readonly ariaLabel: string
  readonly anchor: HTMLElement
  readonly boundary?: HTMLElement
  readonly state: SuggestionSurfaceState<T>
  readonly interaction: SuggestionInteraction<T>
  readonly alert?: { readonly id: string; readonly message: string }
  readonly onAccept: (item: T, index: number) => void
}) {
  const margin = semanticDesignTokens.space[8]
  const gap = semanticDesignTokens.space[4]
  const [position, setPosition] = createSignal<{
    readonly left: number
    readonly top: number
    readonly width: number
    readonly maxHeight: number
  }>({ left: margin, top: margin, width: 0, maxHeight: 0 })
  let surface!: HTMLDivElement
  let resizeObserver: ResizeObserver | undefined
  let placementFrame: number | undefined
  const items = (): readonly T[] => props.state.status === 'ready' ? props.state.items : []

  const place = (): void => {
    if (!surface || !props.anchor.isConnected || (props.boundary != null && !props.boundary.isConnected)) return
    const rect = props.anchor.getBoundingClientRect()
    const boundary = props.boundary?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
    const heightLimit = Math.max(0, boundary.height * 0.4)
    const preferredHeight = Math.min(surface.scrollHeight || heightLimit, heightLimit)
    const preferredWidth = Math.max(rect.width, Math.min(rect.width * 3, 480))
    const placed = placeFloatingSurface({
      surface: { width: preferredWidth, height: surface.scrollHeight },
      anchor: rect,
      bounds: boundary,
      direction: 'block',
      margin,
      gap,
      maxHeight: heightLimit,
      preferredHeight,
    })
    const current = position()
    if (current.left !== placed.left || current.top !== placed.top || current.width !== placed.width ||
      current.maxHeight !== placed.maxHeight) {
      setPosition(placed)
    }
  }

  createEffect(() => {
    props.state.status
    items().length
    const index = props.interaction.activeIndex()
    queueMicrotask(() => {
      place()
      surface?.querySelector<HTMLElement>(`#${CSS.escape(props.interaction.optionId(index))}`)
        ?.scrollIntoView({ block: 'nearest' })
    })
  })

  onMount(() => {
    const reposition = (): void => place()
    const followAnchor = (): void => {
      place()
      placementFrame = requestAnimationFrame(followAnchor)
    }
    window.addEventListener('resize', reposition)
    window.addEventListener('scroll', reposition, true)
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(reposition)
      resizeObserver.observe(props.anchor)
      if (props.boundary != null) resizeObserver.observe(props.boundary)
      resizeObserver.observe(surface)
    }
    placementFrame = requestAnimationFrame(followAnchor)
    onCleanup(() => {
      resizeObserver?.disconnect()
      if (placementFrame !== undefined) cancelAnimationFrame(placementFrame)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    })
  })

  const status = (): string => {
    if (props.state.status === 'loading') return 'Loading suggestions...'
    if (props.state.status === 'empty') return 'No suggestions.'
    if (props.state.status === 'error') return `Suggestions unavailable: ${props.state.message}`
    const count = props.state.items.length
    const summary = `${count} ${count === 1 ? 'suggestion' : 'suggestions'} available.`
    const item = props.state.items[props.interaction.activeIndex()]
    return item === undefined
      ? summary
      : `${summary} ${props.interaction.activeIndex() + 1} of ${count} active: ${item.label}.`
  }

  const visibleStatus = (): string => {
    if (props.state.status !== 'ready') return status()
    const count = props.state.items.length
    return `${count} ${count === 1 ? 'suggestion' : 'suggestions'} | Up/Down | Enter/Tab | Esc`
  }

  return (
    <Portal>
      <div
        ref={surface}
        class="suggestion-surface floating-surface"
        data-testid="suggestion-surface"
        style={{
          left: `${position().left}px`,
          top: `${position().top}px`,
          width: `${position().width}px`,
          'max-height': `${position().maxHeight}px`,
        }}
      >
        <Show when={props.alert}>{(alert) => (
          <div id={alert().id} class="suggestion-surface-alert" role="alert">
            {alert().message}
          </div>
        )}</Show>
        <div
          id={props.interaction.listboxId}
          class="suggestion-surface-listbox"
          data-testid="suggestion-listbox"
          role="listbox"
          aria-label={props.ariaLabel}
          aria-busy={props.state.status === 'loading'}
          onPointerDown={(event) => event.preventDefault()}
        >
          <For each={items()}>{(item, index) => (
            <div
              id={props.interaction.optionId(index())}
              class="suggestion-surface-option"
              classList={{ active: index() === props.interaction.activeIndex() }}
              data-testid="suggestion-option"
              role="option"
              aria-selected={index() === props.interaction.activeIndex()}
              onPointerMove={() => props.interaction.activate(index())}
              onClick={() => props.interaction.accept(index(), items(), props.anchor, props.onAccept)}
            >
              <span class="suggestion-surface-label">{item.label}</span>
              {item.detail === undefined ? null : <small class="suggestion-surface-detail">{item.detail}</small>}
            </div>
          )}</For>
        </div>
        <div
          id={props.interaction.statusId}
          class="suggestion-surface-status"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span class="suggestion-surface-announcement">{status()}</span>
          <span aria-hidden="true">{visibleStatus()}</span>
        </div>
      </div>
    </Portal>
  )
}
