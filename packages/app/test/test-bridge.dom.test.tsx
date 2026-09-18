import { createRoot, createSignal } from 'solid-js'
import { describe, expect, it } from 'vitest'
import type { CanvasTestHandles } from '../src/test-bridge.js'
import { bindFocusedCanvasTestBridge } from '../src/test-bridge.js'

const handles = (id: string): CanvasTestHandles => ({
  renderer: { id } as unknown as CanvasTestHandles['renderer'],
  controller: { id } as unknown as CanvasTestHandles['controller'],
  setOccurrencePlanner: () => {},
})

describe('focused canvas test bridge', () => {
  it('rebinds legacy handles when focus moves between editor groups', async () => {
    const bridge: Partial<CanvasTestHandles> = {}
    const first = handles('first')
    const second = handles('second')
    let focusFirst!: (focused: boolean) => void
    let focusSecond!: (focused: boolean) => void

    const dispose = createRoot((dispose) => {
      const [firstFocused, setFirstFocused] = createSignal(true)
      const [secondFocused, setSecondFocused] = createSignal(false)
      focusFirst = setFirstFocused
      focusSecond = setSecondFocused
      bindFocusedCanvasTestBridge(bridge, first, firstFocused)
      bindFocusedCanvasTestBridge(bridge, second, secondFocused)
      return dispose
    })
    await Promise.resolve()
    expect(bridge.renderer).toBe(first.renderer)
    expect(bridge.controller).toBe(first.controller)

    focusFirst(false)
    focusSecond(true)
    await Promise.resolve()
    expect(bridge.renderer).toBe(second.renderer)
    expect(bridge.controller).toBe(second.controller)

    dispose()
    expect(bridge.renderer).toBeUndefined()
    expect(bridge.controller).toBeUndefined()
  })
})
