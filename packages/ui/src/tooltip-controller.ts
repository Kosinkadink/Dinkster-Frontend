export interface TooltipContent {
  readonly title?: string
  readonly lines: readonly string[]
  readonly note?: string
  readonly detail?: readonly string[]
  readonly shortcut?: string
  /** Refit whole readout items using the rendered width and available height. */
  readonly fit?: (lines: number, measure: (text: string) => number) => TooltipContent
}

export interface TooltipResolveOptions { readonly detailed: boolean }
export interface TooltipProvider {
  readonly id: string
  resolve(target: unknown, opts: TooltipResolveOptions): TooltipContent | undefined
}
/**
 * Where a tooltip opens. `element` is the target it sits beside; a painted
 * target has none, and gives `above`, the y the tooltip's bottom edge takes
 * when it does not fit below `y`.
 */
export interface TooltipAnchor {
  readonly x: number
  readonly y: number
  readonly above?: number
  readonly element?: HTMLElement
  readonly paintedRect?: () => DOMRectReadOnly
  readonly boundary?: HTMLElement
}
export interface VisibleTooltip extends TooltipContent, TooltipAnchor { readonly detailed: boolean }

/** One tooltip policy boundary shared by DOM chrome and the painted canvas. */
export class TooltipController {
  private readonly providers: TooltipProvider[] = []
  private listeners = new Set<() => void>()
  private pending: ReturnType<typeof setTimeout> | undefined
  private candidate: { target: unknown; anchor: TooltipAnchor; owner: unknown } | undefined
  private current: VisibleTooltip | undefined
  private currentTarget: unknown
  private currentOwner: unknown
  private detailed = false

  constructor(private readonly delayMs: () => number = () => 500) {}

  register(provider: TooltipProvider): () => void {
    if (this.providers.some((p) => p.id === provider.id)) throw new Error(`tooltip provider '${provider.id}' already registered`)
    this.providers.push(provider)
    return () => {
      const index = this.providers.indexOf(provider)
      if (index >= 0) this.providers.splice(index, 1)
    }
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  get visible(): VisibleTooltip | undefined { return this.current }

  show(target: unknown, anchor: TooltipAnchor, detailed = this.detailed, immediate = false, owner?: unknown): void {
    this.clearTimer()
    this.candidate = { target, anchor, owner }
    this.detailed = detailed
    if (detailed || immediate) this.resolveNow()
    else this.pending = setTimeout(() => this.resolveNow(), Math.max(0, this.delayMs()))
  }

  /** Update an owned visible session without reopening it after dismissal. */
  refreshTarget(previousTarget: unknown, target: unknown, owner: unknown): void {
    const candidate = this.candidate
    if (this.current === undefined || this.currentTarget !== previousTarget || this.currentOwner !== owner ||
        candidate === undefined || candidate.target !== previousTarget || candidate.owner !== owner) return
    this.candidate = { ...candidate, target }
    this.resolveNow()
  }

  /** Replace a target inside one hover session without restarting its initial delay. */
  showInSession(target: unknown, anchor: TooltipAnchor, detailed = this.detailed): void {
    if (this.current) {
      this.show(target, anchor, detailed, true)
      return
    }
    if (this.pending !== undefined) {
      this.candidate = { target, anchor, owner: undefined }
      this.detailed = detailed
      if (detailed) { this.clearTimer(); this.resolveNow() }
      return
    }
    this.show(target, anchor, detailed)
  }

  hide(): void {
    this.clearTimer()
    this.candidate = undefined
    this.currentTarget = undefined
    this.currentOwner = undefined
    if (this.current) { this.current = undefined; this.emit() }
  }

  /**
   * Hide only when the pending or visible tooltip's TARGET matches. Lets the
   * canvas invalidate its own scene-anchored tooltips (scene rebuilds, camera
   * moves) without cancelling DOM chrome tooltips that share this controller.
   * An owner limits invalidation to one producer on the shared surface.
   */
  hideMatching(predicate: (target: unknown) => boolean, owner?: unknown): void {
    const candidateMatches = this.candidate !== undefined &&
      (owner === undefined || this.candidate.owner === owner) && predicate(this.candidate.target)
    const currentMatches = this.current !== undefined &&
      (owner === undefined || this.currentOwner === owner) && predicate(this.currentTarget)
    if (candidateMatches) { this.clearTimer(); this.candidate = undefined }
    if (currentMatches) { this.current = undefined; this.currentTarget = undefined; this.currentOwner = undefined; this.emit() }
  }

  setDetailed(detailed: boolean): void {
    if (this.detailed === detailed) return
    this.detailed = detailed
    if (this.candidate) {
      this.clearTimer()
      // Alt is instant. Releasing Alt keeps the tooltip open but re-resolves basic content.
      this.resolveNow()
    }
  }

  private resolveNow(): void {
    const candidate = this.candidate
    if (!candidate) return
    const content = this.providers.map((p) => p.resolve(candidate.target, { detailed: this.detailed })).find(Boolean)
    this.current = content ? { ...content, ...candidate.anchor, detailed: this.detailed } : undefined
    this.currentTarget = content ? candidate.target : undefined
    this.currentOwner = content ? candidate.owner : undefined
    this.emit()
  }
  private clearTimer(): void { if (this.pending !== undefined) clearTimeout(this.pending); this.pending = undefined }
  private emit(): void { for (const listener of this.listeners) listener() }
}

export interface DomTooltipTarget { readonly kind: 'dom'; readonly label: string; readonly detail?: readonly string[]; readonly shortcut?: string }

/** Time a visible tooltip may bridge empty space inside one hover session. */
export const DOM_TOOLTIP_SESSION_GRACE_MS = 300

const isDomTooltipTarget = (target: unknown): target is DomTooltipTarget =>
  typeof target === 'object' && target !== null && (target as { kind?: unknown }).kind === 'dom'

/** Event-delegated opt-in for chrome: data-tooltip-label plus optional data-tooltip-detail. */
export function attachDomTooltips(root: HTMLElement, controller: TooltipController): () => void {
  let sessionGrace: ReturnType<typeof setTimeout> | undefined
  let hovered: HTMLElement | undefined
  let shown: HTMLElement | undefined
  let navigationFocus = false
  let keyboardFocused: HTMLElement | undefined
  // Stateful controls rewrite data-tooltip-label from click handlers that run
  // after the focus-driven show has already captured the old text. Watching
  // the shown element's tooltip attributes keeps the visible tooltip current.
  // Removal never fires an attribute mutation, so the tree is watched too:
  // a tooltip must not outlive its control. Unrelated tree churn is cheap
  // here (the observer only runs while a tooltip is pending or visible) and
  // must not re-resolve the tooltip, so only attribute mutations refresh.
  const labelObserver = new MutationObserver((mutations) => {
    if (shown === undefined) return
    if (!shown.isConnected) { hideNow(); return }
    if (mutations.some((mutation) => mutation.type === 'attributes')) refreshShown()
  })
  const observeShown = (element: HTMLElement): void => {
    if (shown === element) return
    shown = element
    labelObserver.disconnect()
    labelObserver.observe(element, { attributes: true, attributeFilter: ['data-tooltip-label', 'data-tooltip-detail', 'data-tooltip-shortcut', 'aria-expanded', 'aria-haspopup'] })
    labelObserver.observe(root, { childList: true, subtree: true })
  }
  const releaseShown = (): void => {
    shown = undefined
    labelObserver.disconnect()
  }
  const clearSessionGrace = (): void => {
    if (sessionGrace !== undefined) clearTimeout(sessionGrace)
    sessionGrace = undefined
  }
  const hideNow = (): void => {
    clearSessionGrace()
    releaseShown()
    controller.hide()
  }
  const hideAfterSessionGrace = (): void => {
    clearSessionGrace()
    if (controller.visible) {
      sessionGrace = setTimeout(() => {
        sessionGrace = undefined
        releaseShown()
        controller.hideMatching(isDomTooltipTarget)
      }, DOM_TOOLTIP_SESSION_GRACE_MS)
    } else {
      releaseShown()
      controller.hideMatching(isDomTooltipTarget)
    }
  }
  const tooltipTargetOf = (target: EventTarget | null) =>
    (target instanceof Element ? target : undefined)?.closest<HTMLElement>('[data-tooltip-label]')
  const elementAt = (event: Event) => tooltipTargetOf(event.target)
  const focusedElement = () => document.activeElement === keyboardFocused ? keyboardFocused : undefined
  const hasOpenSurface = (element: HTMLElement) => element.matches('[aria-haspopup]:not([aria-haspopup="false"])[aria-expanded="true"]')
  const hasVisibleLabel = (element: HTMLElement) => {
    const label = element.querySelector<HTMLElement>('[data-tooltip-visible-label]')
    if (label === null || label.textContent?.trim() !== element.dataset['tooltipLabel']) return false
    // Compact window actions clip their label to a 1px box.
    const rect = label.getBoundingClientRect()
    return rect.width > 1 && rect.height > 1
  }
  const sessionOf = (element: Element | null | undefined) => element?.closest<HTMLElement>('[data-tooltip-session]') ?? undefined
  const domTargetOf = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    const detail = element.dataset['tooltipDetail']?.split('|').filter(Boolean)
    const shortcut = element.dataset['tooltipShortcut']
    return {
      target: { kind: 'dom', label: element.dataset['tooltipLabel']!, ...(detail ? { detail } : {}), ...(shortcut ? { shortcut } : {}) },
      anchor: { x: rect.left + rect.width / 2, y: rect.bottom + 8, element },
    }
  }
  const showForElement = (element: HTMLElement, detailed?: boolean, immediate = false): void => {
    if (hasOpenSurface(element) || hasVisibleLabel(element)) { hideNow(); return }
    const { target, anchor } = domTargetOf(element)
    observeShown(element)
    controller.show(target, anchor, detailed, immediate)
  }
  const refreshShown = (): void => {
    const element = shown
    if (element === undefined) return
    if (!element.isConnected || element.dataset['tooltipLabel'] === undefined || hasOpenSurface(element) || hasVisibleLabel(element)) { hideNow(); return }
    if (hovered !== element && document.activeElement !== element) return
    const { target, anchor } = domTargetOf(element)
    controller.showInSession(target, anchor)
  }
  const enter = (event: PointerEvent) => {
    const element = elementAt(event)
    if (!element || (event.relatedTarget instanceof Node && element.contains(event.relatedTarget))) return
    hovered = element
    clearSessionGrace()
    if (hasOpenSurface(element) || hasVisibleLabel(element)) { hideNow(); return }
    const related = event.relatedTarget instanceof Element ? event.relatedTarget : undefined
    const session = sessionOf(element)
    const sharedSession = session !== undefined && session === sessionOf(related)
    const immediate = element.dataset['tooltipImmediate'] === 'true'
    if (sharedSession && !immediate) {
      const { target, anchor } = domTargetOf(element)
      observeShown(element)
      controller.showInSession(target, anchor, event.altKey)
    } else showForElement(element, event.altKey, immediate)
  }
  const leave = (event: PointerEvent) => {
    const element = elementAt(event)
    const related = event.relatedTarget instanceof Element ? event.relatedTarget : undefined
    if (!element) {
      const session = sessionOf(event.target instanceof Element ? event.target : undefined)
      if (session !== undefined && session !== sessionOf(related)) hideNow()
      return
    }
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return
    if (hovered === element) hovered = undefined
    if (element.dataset['tooltipTrigger'] === 'hover') { hideNow(); return }
    if (focusedElement() === element) return
    const focused = focusedElement()
    if (focused !== undefined) { showForElement(focused, undefined, true); return }
    const session = sessionOf(element)
    if (session === undefined || session !== sessionOf(related)) hideNow()
    else if (!tooltipTargetOf(event.relatedTarget)) hideAfterSessionGrace()
  }
  const focusIn = (event: FocusEvent) => {
    const arrivedByNavigation = navigationFocus
    navigationFocus = false
    const element = elementAt(event)
    keyboardFocused = arrivedByNavigation && element && event.target === element && element.dataset['tooltipTrigger'] !== 'hover' ? element : undefined
    if (keyboardFocused) { clearSessionGrace(); showForElement(keyboardFocused, undefined, true) }
  }
  const focusOut = (event: FocusEvent) => {
    const element = elementAt(event)
    if (!element || event.target !== element) return
    if (keyboardFocused === element) keyboardFocused = undefined
    if (hovered !== undefined) showForElement(hovered, undefined, true)
    else hideNow()
  }
  const down = () => { navigationFocus = false; keyboardFocused = undefined; hovered = undefined; hideNow() }
  const keydown = (event: KeyboardEvent) => {
    navigationFocus = !event.altKey && !event.ctrlKey && !event.metaKey &&
      ['Tab', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
    if (event.key === 'Alt') controller.setDetailed(true)
    if (event.key === 'Escape') { keyboardFocused = undefined; hideNow() }
  }
  const keyup = (event: KeyboardEvent) => {
    navigationFocus = false
    if (event.key === 'Alt') controller.setDetailed(false)
  }
  root.addEventListener('pointerover', enter)
  root.addEventListener('pointerout', leave)
  root.addEventListener('focusin', focusIn)
  root.addEventListener('focusout', focusOut)
  window.addEventListener('pointerdown', down, true)
  window.addEventListener('keydown', keydown, true)
  window.addEventListener('keyup', keyup)
  window.addEventListener('resize', refreshShown)
  return () => { clearSessionGrace(); releaseShown(); controller.hideMatching(isDomTooltipTarget); root.removeEventListener('pointerover', enter); root.removeEventListener('pointerout', leave); root.removeEventListener('focusin', focusIn); root.removeEventListener('focusout', focusOut); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', keydown, true); window.removeEventListener('keyup', keyup); window.removeEventListener('resize', refreshShown) }
}
