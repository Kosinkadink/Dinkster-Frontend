// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductCheckbox, ProductRadio } from '../src/ProductControls.js'

afterEach(() => document.body.replaceChildren())

describe('ProductCheckbox', () => {
  it('exposes controlled boolean and mixed state with one activation callback', () => {
    const [checked, setChecked] = createSignal<false | true | 'mixed'>('mixed')
    const onChange = vi.fn((next: boolean) => setChecked(next))
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProductCheckbox checked={checked()} ariaLabel="Exposure" onChange={onChange} />, root)
    const control = root.querySelector<HTMLButtonElement>('[role="checkbox"]')!

    expect(control.getAttribute('aria-checked')).toBe('mixed')
    expect(control.getAttribute('aria-label')).toBe('Exposure')
    control.click()
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(true)
    expect(control.getAttribute('aria-checked')).toBe('true')
    control.click()
    expect(onChange).toHaveBeenCalledTimes(2)
    expect(onChange).toHaveBeenLastCalledWith(false)
    expect(control.getAttribute('aria-checked')).toBe('false')
    dispose()
  })

  it('uses a disabled button and preserves wrapping-label activation', () => {
    const onChange = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <label>Enabled <ProductCheckbox checked={false} disabled onChange={onChange} /></label>, root)
    const control = root.querySelector<HTMLButtonElement>('[role="checkbox"]')!

    expect(control.disabled).toBe(true)
    root.querySelector('label')!.click()
    expect(onChange).not.toHaveBeenCalled()
    dispose()
  })

  it('activates once when a wrapping row label is clicked', () => {
    const onChange = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <label>Enabled <ProductCheckbox checked={false} onChange={onChange} /></label>, root)

    root.querySelector('label')!.click()
    expect(onChange).toHaveBeenCalledOnce()
    expect(onChange).toHaveBeenCalledWith(true)
    dispose()
  })
})

describe('ProductRadio', () => {
  it('moves and selects with all four arrow keys while skipping disabled options', () => {
    const [selected, setSelected] = createSignal('first')
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => (
      <div role="radiogroup" aria-label="Choice">
        <ProductRadio checked={selected() === 'first'} onSelect={() => setSelected('first')} ariaLabel="First" />
        <ProductRadio checked={false} disabled onSelect={() => setSelected('disabled')} ariaLabel="Disabled" />
        <ProductRadio checked={selected() === 'last'} onSelect={() => setSelected('last')} ariaLabel="Last" />
      </div>
    ), root)
    const radios = root.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    radios[0]!.focus()
    radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    expect(selected()).toBe('last')
    expect(document.activeElement).toBe(radios[2])
    expect(radios[2]!.getAttribute('aria-checked')).toBe('true')

    radios[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    expect(selected()).toBe('first')
    expect(document.activeElement).toBe(radios[0])
    radios[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))
    expect(selected()).toBe('last')
    expect(document.activeElement).toBe(radios[2])
    radios[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    expect(selected()).toBe('first')
    expect(document.activeElement).toBe(radios[0])
    dispose()
  })

  it('keeps focus navigation mutation-free until an arrow or activation', () => {
    const onSelect = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <div role="radiogroup"><ProductRadio checked onSelect={onSelect} ariaLabel="Only" /></div>, root)
    const radio = root.querySelector<HTMLButtonElement>('[role="radio"]')!
    radio.focus()
    expect(onSelect).not.toHaveBeenCalled()
    dispose()
  })
})
