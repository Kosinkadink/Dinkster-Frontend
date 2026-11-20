import { render } from 'solid-js/web'
import { expect, it, vi } from 'vitest'
import { FrameRateStatus } from '../src/FrameRateStatus.js'

it('reports interval cadence and each sample maximum, excluding hidden-tab pauses', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let next = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++next, callback)
    return next
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const tick = (timestamp: number) => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(timestamp)
  }
  const root = document.createElement('div')
  document.body.append(root)
  const dispose = render(() => <FrameRateStatus />, root)
  try {
    expect(root.textContent).toBe('Measuring frame rate...')
    for (const timestamp of [0, 900, 930, 970, 1000]) tick(timestamp)
    expect(root.textContent).toBe('4 FPS / slowest 900.0 ms')
    for (const timestamp of [1250, 1500, 1750, 2000]) tick(timestamp)
    expect(root.textContent).toBe('4 FPS / slowest 250.0 ms')
    tick(2010)
    hidden.mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    tick(49000)
    expect(root.textContent).toBe('Measuring frame rate...')
    hidden.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    for (const timestamp of [50000, 50100, 51000]) tick(timestamp)
    expect(root.textContent).toBe('2 FPS / slowest 900.0 ms')
  } finally {
    dispose()
    root.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
