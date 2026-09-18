// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductSlider } from '../src/ProductSlider.js'

const key = (target: Element, value: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}

afterEach(() => document.body.replaceChildren())

describe('ProductSlider', () => {
  it('provides complete slider keyboard parity and emits every change', () => {
    const changes = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductSlider ariaLabel="Amount" value={50} min={0} max={100} step={5} onInput={changes} />, root)
    const slider = root.querySelector<HTMLElement>('[role="slider"]')!

    expect(slider.getAttribute('tabindex')).toBe('0')
    expect(slider.getAttribute('aria-orientation')).toBe('horizontal')
    key(slider, 'ArrowRight')
    key(slider, 'PageUp')
    key(slider, 'Home')
    key(slider, 'End')
    expect(changes.mock.calls.map(([value]) => value)).toEqual([55, 100, 0, 100])
  })

  it('maps pointer dragging to stepped values and contains pointer interaction', () => {
    const changes = vi.fn()
    const outside = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <div onPointerDown={outside}><ProductSlider value={0} min={0} max={10} step={1} onInput={changes} /></div>, root)
    const slider = root.querySelector<HTMLElement>('[role="slider"]')!
    slider.getBoundingClientRect = () => ({ left: 10, right: 110, top: 0, bottom: 32, width: 100, height: 32, x: 10, y: 0, toJSON: () => ({}) })
    slider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 60, bubbles: true, cancelable: true }))
    slider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 90, bubbles: true, cancelable: true }))
    expect(changes.mock.calls.map(([value]) => value)).toEqual([5, 8])
    expect(outside).not.toHaveBeenCalled()
  })

  it('commits a pointer gesture once while retaining input previews', () => {
    const changes = vi.fn()
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductSlider value={0} min={0} max={10} step={1} onInput={changes} onCommit={commits} />, root)
    const slider = root.querySelector<HTMLElement>('[role="slider"]')!
    slider.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 32, width: 100, height: 32, x: 0, y: 0, toJSON: () => ({}) })

    slider.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 20, bubbles: true, cancelable: true }))
    slider.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 70, bubbles: true, cancelable: true }))
    slider.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 70, bubbles: true, cancelable: true }))

    expect(changes.mock.calls.map(([value]) => value)).toEqual([2, 7])
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenCalledWith(7)
  })

  it('clamps its displayed value when reactive bounds change without emitting', () => {
    const changes = vi.fn()
    const [maximum, setMaximum] = createSignal(100)
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductSlider value={80} min={0} max={maximum()} step={10} onInput={changes} />, root)
    const slider = root.querySelector<HTMLElement>('[role="slider"]')!
    setMaximum(50)
    expect(slider.getAttribute('aria-valuemax')).toBe('50')
    expect(slider.getAttribute('aria-valuenow')).toBe('50')
    expect(changes).not.toHaveBeenCalled()
  })
})
