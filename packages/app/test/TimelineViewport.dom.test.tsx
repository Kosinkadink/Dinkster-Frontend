import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineLane, TimelineViewport } from '../src/TimelineViewport.js'

let root: HTMLDivElement
let dispose: (() => void) | undefined
beforeEach(() => { root = document.createElement('div'); document.body.append(root) })
afterEach(() => { dispose?.(); dispose = undefined; root.remove() })

describe('TimelineViewport', () => {
  it('is controlled by its caller and passes scale to document-rendered lanes', () => {
    const [time, setTime] = createSignal(0)
    const seek = vi.fn()
    dispose = render(() => <TimelineViewport duration={12} frameDuration={1001 / 30000} time={time()} onSeek={seek}>
      {(scale) => <TimelineLane label="Video" description="Asset-backed source"><span data-scale={scale.pixelsPerSecond}>Caller content</span></TimelineLane>}
    </TimelineViewport>, root)
    const ruler = root.querySelector('[role="slider"]')!
    ruler.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    expect(seek).toHaveBeenCalledExactlyOnceWith(1001 / 30000)
    expect(ruler.getAttribute('aria-valuenow')).toBe('0')
    setTime(2)
    expect(ruler.getAttribute('aria-valuenow')).toBe('2')
    expect(root.textContent).toContain('Asset-backed source')
    setTime(1001 / 30000)
    expect(root.querySelector('input')!.value).toBe('0.033367')
    expect(Number(ruler.getAttribute('aria-valuenow'))).toBe(1001 / 30000)
    const before = Number(root.querySelector('[data-scale]')!.getAttribute('data-scale'))
    root.querySelector<HTMLButtonElement>('[aria-label="Zoom in timeline"]')!.click()
    expect(Number(root.querySelector('[data-scale]')!.getAttribute('data-scale'))).toBe(before * 2)
    expect(seek).toHaveBeenCalledTimes(1)
  })

  it('stops navigation shortcuts at the ruler and clamps boundary seeks', () => {
    const seek = vi.fn()
    const outer = vi.fn()
    root.addEventListener('keydown', outer)
    dispose = render(() => <TimelineViewport duration={12} frameDuration={0.04} time={0} onSeek={seek}>{() => null}</TimelineViewport>, root)
    const ruler = root.querySelector('[role="slider"]')!
    for (const key of ['ArrowLeft', 'End', 'Home']) ruler.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    expect(seek.mock.calls).toEqual([[0], [12], [0]])
    expect(outer).not.toHaveBeenCalled()
  })

  it.each([[0, '-1'], [12, '13'], [2, '']] as const)(
    'restores caller time %s after entering %s without changing the position', (initial, entered) => {
      const [time, setTime] = createSignal<number>(initial)
      dispose = render(() => <TimelineViewport duration={12} frameDuration={0.04} time={time()} onSeek={setTime}>{() => null}</TimelineViewport>, root)
      const input = root.querySelector('input')!
      input.value = entered
      input.dispatchEvent(new Event('change', { bubbles: true }))
      expect(time()).toBe(initial)
      expect(input.value).toBe(String(initial))
      expect(input.validity.valid).toBe(true)
    },
  )

  it('clears lanes and refuses seeking when the execution owner becomes unavailable', () => {
    const [unavailable, setUnavailable] = createSignal<string>()
    const seek = vi.fn()
    dispose = render(() => <TimelineViewport duration={12} frameDuration={0.04} time={0} onSeek={seek}
      {...(unavailable() === undefined ? {} : { unavailable: unavailable()! })}>{() => <TimelineLane label="Video">Recorded content</TimelineLane>}</TimelineViewport>, root)
    expect(root.textContent).toContain('Recorded content')
    setUnavailable('Execution owner unavailable. Timeline document cannot be loaded.')
    expect(root.querySelector('[role="status"]')?.textContent).toContain('Execution owner unavailable')
    expect(root.textContent).not.toContain('Recorded content')
    expect(root.querySelector('input')!.disabled).toBe(true)
    expect(root.querySelector('[role="slider"]')).toBeNull()
    expect(seek).not.toHaveBeenCalled()
  })

  it('does not substitute a duration or frame rate when timing is absent', () => {
    const children = vi.fn()
    dispose = render(() => <TimelineViewport duration={undefined} frameDuration={undefined} time={0} onSeek={vi.fn()}>{children}</TimelineViewport>, root)
    expect(root.textContent).toContain('Timeline timing unavailable')
    expect(children).not.toHaveBeenCalled()
    expect(root.querySelector('input')!.disabled).toBe(true)
  })
})
