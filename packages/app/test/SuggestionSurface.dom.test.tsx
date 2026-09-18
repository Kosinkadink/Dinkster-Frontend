import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSuggestionInteraction,
  SuggestionSurface,
  type SuggestionInteraction,
  type SuggestionSurfaceItem,
  type SuggestionSurfaceState,
} from '../src/SuggestionSurface.js'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const items: readonly SuggestionSurfaceItem[] = [
  { id: 'first', label: 'A long suggestion label that must remain contained', detail: 'Provider detail' },
  { id: 'second', label: 'Second suggestion' },
  { id: 'third', label: 'Third suggestion' },
]

function mountSurface(
  rect: DOMRect = new DOMRect(880, 700, 120, 40),
  initialState: SuggestionSurfaceState<SuggestionSurfaceItem> = { status: 'ready', items },
  boundaryRect: DOMRect = new DOMRect(72, 40, 960, 760),
) {
  const root = document.createElement('div')
  document.body.append(root)
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(boundaryRect)
  let anchor!: HTMLTextAreaElement
  let interaction!: SuggestionInteraction<SuggestionSurfaceItem>
  const onAccept = vi.fn()
  const [state, setState] = createSignal(initialState)
  dispose = render(() => {
    interaction = createSuggestionInteraction<SuggestionSurfaceItem>()
    return <>
      <textarea ref={anchor} />
      <SuggestionSurface
        ariaLabel="Proof suggestions"
        anchor={anchor}
        boundary={root}
        state={state()}
        interaction={interaction}
        onAccept={onAccept}
      />
    </>
  }, root)
  vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(rect)
  window.dispatchEvent(new Event('resize'))
  return { anchor, interaction, onAccept, setState }
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}

describe('SuggestionSurface', () => {
  it('renders host-owned listbox semantics, long content, and status announcements', async () => {
    const mounted = mountSurface()
    await flush()
    const surface = document.querySelector<HTMLElement>('[data-testid="suggestion-surface"]')!
    const listbox = surface.querySelector('[role="listbox"]')!
    const options = [...surface.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(surface.classList.contains('floating-surface')).toBe(true)
    expect(listbox.getAttribute('aria-label')).toBe('Proof suggestions')
    expect(options).toHaveLength(3)
    expect(options[0]?.textContent).toContain('A long suggestion label that must remain contained')
    expect(options[0]?.textContent).toContain('Provider detail')
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(surface.querySelector('[role="status"]')?.textContent).toContain('3 suggestions available. 1 of 3 active')

    mounted.anchor.focus()
    options[1]!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    options[1]!.click()
    await flush()
    expect(mounted.onAccept).toHaveBeenCalledWith(items[1], 1)
    expect(document.activeElement).toBe(mounted.anchor)
  })

  it('owns wrapped keyboard navigation, acceptance, Escape focus restoration, and IME refusal', async () => {
    const mounted = mountSurface()
    await flush()
    const accept = vi.fn()
    const dismiss = vi.fn()
    mounted.anchor.focus()

    const composing = new KeyboardEvent('keydown', { key: 'Tab', isComposing: true, cancelable: true })
    expect(mounted.interaction.onKeyDown(composing, items, mounted.anchor, accept, dismiss)).toBe(false)
    expect(composing.defaultPrevented).toBe(false)

    const up = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true })
    expect(mounted.interaction.onKeyDown(up, items, mounted.anchor, accept, dismiss)).toBe(true)
    expect(mounted.interaction.activeIndex()).toBe(2)
    expect(up.defaultPrevented).toBe(true)

    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    mounted.interaction.onKeyDown(enter, items, mounted.anchor, accept, dismiss)
    expect(accept).toHaveBeenCalledWith(items[2], 2)

    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    mounted.interaction.onKeyDown(escape, items, mounted.anchor, accept, dismiss)
    await flush()
    expect(dismiss).toHaveBeenCalledOnce()
    expect(document.activeElement).toBe(mounted.anchor)
  })

  it('renders and announces loading, empty, and provider error states', async () => {
    const mounted = mountSurface(undefined, { status: 'loading' })
    await flush()
    const listbox = document.querySelector('[role="listbox"]')!
    const status = document.querySelector('[role="status"]')!
    expect(listbox.getAttribute('aria-busy')).toBe('true')
    expect(status.textContent).toContain('Loading suggestions...')
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0)

    mounted.setState({ status: 'empty' })
    await flush()
    expect(listbox.getAttribute('aria-busy')).toBe('false')
    expect(status.textContent).toContain('No suggestions.')

    mounted.setState({ status: 'error', message: 'Catalog unavailable' })
    await flush()
    expect(status.textContent).toContain('Suggestions unavailable: Catalog unavailable')

    const dismiss = vi.fn()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    expect(mounted.interaction.onKeyDown(escape, [], mounted.anchor, vi.fn(), dismiss)).toBe(true)
    expect(dismiss).toHaveBeenCalledOnce()
    expect(escape.defaultPrevented).toBe(true)
  })

  it('flips above a low anchor and clamps within a narrow viewport', async () => {
    vi.stubGlobal('innerWidth', 240)
    vi.stubGlobal('innerHeight', 320)
    const mounted = mountSurface(
      new DOMRect(210, 280, 300, 32),
      { status: 'ready', items },
      new DOMRect(0, 0, 240, 320),
    )
    await flush()
    window.dispatchEvent(new Event('resize'))
    await flush()
    const surface = document.querySelector<HTMLElement>('[data-testid="suggestion-surface"]')!
    const left = Number.parseFloat(surface.style.left)
    const top = Number.parseFloat(surface.style.top)
    const width = Number.parseFloat(surface.style.width)
    const maxHeight = Number.parseFloat(surface.style.maxHeight)
    expect(left).toBeGreaterThanOrEqual(8)
    expect(left + width).toBeLessThanOrEqual(232)
    expect(top).toBeLessThan(280)
    expect(top).toBeGreaterThanOrEqual(8)
    expect(maxHeight).toBeGreaterThan(0)
    expect(mounted.interaction.activeOptionId(items)).toBe(document.querySelector('[aria-selected="true"]')?.id)
  })

  it('clamps to its boundary instead of overlapping adjacent chrome', async () => {
    mountSurface(
      new DOMRect(700, 320, 180, 40),
      { status: 'ready', items },
      new DOMRect(72, 40, 780, 720),
    )
    await flush()
    const surface = document.querySelector<HTMLElement>('[data-testid="suggestion-surface"]')!
    const left = Number.parseFloat(surface.style.left)
    const width = Number.parseFloat(surface.style.width)
    expect(left).toBeGreaterThanOrEqual(80)
    expect(left + width).toBeLessThanOrEqual(844)
  })

  it('does not magnify an already-wide zoomed editor', async () => {
    mountSurface(
      new DOMRect(400, 320, 500, 80),
      { status: 'ready', items },
      new DOMRect(0, 0, 1600, 900),
    )
    await flush()
    const surface = document.querySelector<HTMLElement>('[data-testid="suggestion-surface"]')!
    expect(Number.parseFloat(surface.style.width)).toBe(500)
  })
})
