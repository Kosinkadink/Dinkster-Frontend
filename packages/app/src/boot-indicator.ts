/**
 * Boot indicator while fonts and desktop setup load before the shell.
 *
 * Timing contract:
 * - The indicator appears only after `showDelayMs` (default 150ms). A fast
 *   boot that renders before then never flashes it.
 * - After `messageDelayMs` (default 3000ms) an extra line names what it is
 *   waiting on (application startup).
 * - `hide()` cancels both timers and removes the element. Calling it before
 *   the show timer fires is a no-op (no DOM was created).
 *
 * The timing logic is pure and testable via injected `schedule`/`cancel`
 * (matching supervisor-poll.ts); the DOM mount/unmount is presentation only
 * and covered by E2E, not unit tests.
 */

export interface BootIndicatorOptions {
  /** Schedule a callback after `ms`. Defaults to setTimeout. */
  readonly schedule?: (fn: () => void, ms: number) => unknown
  /** Cancel a handle returned by `schedule`. Defaults to clearTimeout. */
  readonly cancel?: (handle: unknown) => void
  /** Delay before the indicator appears (default 150ms). */
  readonly showDelayMs?: number
  /** Delay before the "waiting on" message appears (default 3000ms). */
  readonly messageDelayMs?: number
  /** Called when the indicator becomes visible. Creates the DOM. */
  readonly onShow?: () => void
  /** Called when the waiting message appears. Updates the DOM. */
  readonly onShowMessage?: () => void
  /** Called on hide if the indicator was shown. Removes the DOM. */
  readonly onHide?: () => void
}

/**
 * Start the boot indicator. Returns a `hide` function that must be called
 * the moment the real app renders (or immediately on a fast boot). It is
 * idempotent: calling it more than once is a no-op.
 */
export function startBootIndicator(opts: BootIndicatorOptions = {}): () => void {
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms))
  const cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  const showDelay = opts.showDelayMs ?? 150
  const messageDelay = opts.messageDelayMs ?? 3000

  let hidden = false
  let shown = false
  let showHandle: unknown
  let messageHandle: unknown

  showHandle = schedule(() => {
    if (hidden) return
    shown = true
    opts.onShow?.()
  }, showDelay)

  messageHandle = schedule(() => {
    if (hidden) return
    opts.onShowMessage?.()
  }, messageDelay)

  return () => {
    if (hidden) return
    hidden = true
    cancel(showHandle)
    cancel(messageHandle)
    if (shown) opts.onHide?.()
  }
}

/**
 * Create the boot indicator DOM element (not yet appended). Returns the
 * element and a function to reveal the startup
 * line. Used by main.tsx to wire `startBootIndicator` callbacks to real DOM.
 */
export function createBootIndicatorElement(): {
  el: HTMLElement
  showWaitingMessage: () => void
} {
  const el = document.createElement('div')
  el.className = 'boot-indicator'
  el.innerHTML = [
    '<div class="boot-indicator-inner">',
    '<img class="brand-symbol boot-indicator-pulse" src="/branding/svg/dinkster-symbol-color.svg" alt="" />',
    '<div class="brand-wordmark boot-indicator-name">',
    '<img class="brand-on-dark" src="/branding/svg/dinkster-wordmark-color-dark.svg" alt="Dinkster" />',
    '<img class="brand-on-light" src="/branding/svg/dinkster-wordmark-color-light.svg" alt="Dinkster" />',
    '</div>',
    '<div class="boot-indicator-waiting" hidden>Starting Dinkster...</div>',
    '</div>',
  ].join('')
  const waiting = el.querySelector<HTMLElement>('.boot-indicator-waiting')
  return {
    el,
    showWaitingMessage: () => {
      if (waiting) waiting.hidden = false
    },
  }
}
