// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductNumberInput } from '../src/ProductNumberInput.js'

const input = (root: HTMLElement): HTMLInputElement => root.querySelector('[role="spinbutton"]')!
const key = (target: Element, value: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}

afterEach(() => document.body.replaceChildren())

describe('ProductNumberInput', () => {
  it('commits typed text once on Enter and reverts an edit with Escape', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const [value, setValue] = createSignal('2')
    render(() => <ProductNumberInput value={value()} min={0} max={10} step={1} onCommit={(raw) => { commits(raw); setValue(raw) }} />, root)

    input(root).value = '4'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(commits).not.toHaveBeenCalled()
    key(input(root), 'Enter')
    expect(commits).toHaveBeenCalledTimes(1)
    expect(commits).toHaveBeenLastCalledWith('4')
    input(root).value = '9'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    key(input(root), 'Escape')
    expect(input(root).value).toBe('4')
    expect(commits).toHaveBeenCalledTimes(1)
  })

  it('reverts to the controlled value after a rejected commit', () => {
    const commits = vi.fn()
    const reverts = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductNumberInput value="5" min={0} max={10} step={1} onCommit={commits} onRevert={reverts} />, root)
    input(root).value = 'invalid'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    key(input(root), 'Enter')
    expect(commits).toHaveBeenCalledWith('invalid')
    key(input(root), 'Escape')
    expect(input(root).value).toBe('5')
    expect(reverts).toHaveBeenCalledOnce()
  })

  it('supports bounded keyboard stepping without committing navigation twice', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductNumberInput value="5" min={0} max={100} step={2} integer={true} onCommit={commits} />, root)

    expect(input(root).getAttribute('aria-valuemin')).toBe('0')
    expect(input(root).getAttribute('aria-valuemax')).toBe('100')
    expect(input(root).getAttribute('aria-valuenow')).toBe('5')
    expect(input(root).getAttribute('aria-valuetext')).toBeNull()
    key(input(root), 'ArrowUp')
    expect(input(root).value).toBe('6')
    expect(commits).toHaveBeenCalledTimes(1)
    key(input(root), 'PageUp')
    expect(input(root).value).toBe('26')
    key(input(root), 'Home')
    expect(input(root).value).toBe('0')
    key(input(root), 'End')
    expect(input(root).value).toBe('100')
    expect(commits).toHaveBeenCalledTimes(4)
  })

  it('steps from typed off-grid text and prevents stepper focus blur from adding a commit', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductNumberInput value="1" min={1} max={20} step={2} onCommit={commits} />, root)

    input(root).value = '6'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    key(input(root), 'ArrowUp')
    expect(input(root).value).toBe('7')
    expect(commits).toHaveBeenLastCalledWith('7')
    input(root).value = '10'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    const increase = root.querySelector<HTMLButtonElement>('[aria-label="Increase value"]')!
    const pointer = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    increase.dispatchEvent(pointer)
    expect(pointer.defaultPrevented).toBe(true)
    increase.click()
    expect(commits).toHaveBeenCalledTimes(2)
    expect(commits).toHaveBeenLastCalledWith('11')
  })

  it('emits every valid continuous input and exposes spinbutton values', () => {
    const values = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const [value, setValue] = createSignal('64')
    render(() => <ProductNumberInput value={value()} inputMode="numeric" min={0} step={64} onInput={(raw) => { values(raw); setValue(raw) }} />, root)

    expect(input(root).getAttribute('inputmode')).toBe('numeric')
    expect(input(root).getAttribute('aria-valuemin')).toBe('0')
    expect(input(root).getAttribute('aria-valuenow')).toBe('64')
    input(root).value = '128'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(values).toHaveBeenCalledWith('128')
    input(root).value = '-'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(values).toHaveBeenCalledTimes(1)
    expect(input(root).getAttribute('aria-valuetext')).toBe('-')
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    input(root).dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
  })

  it('does not emit unchanged typed or bounded stepped values', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductNumberInput value="10" min={0} max={10} step={1} onCommit={commits} />, root)
    input(root).value = '9'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    input(root).value = '10'
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    key(input(root), 'Enter')
    key(input(root), 'ArrowUp')
    expect(commits).not.toHaveBeenCalled()
  })

  it('can commit an explicitly typed default without committing untouched fields', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductNumberInput value="0" commitUnchanged onCommit={commits} />, root)
    key(input(root), 'Enter')
    expect(commits).not.toHaveBeenCalled()
    input(root).dispatchEvent(new InputEvent('input', { bubbles: true }))
    key(input(root), 'Enter')
    expect(commits).toHaveBeenCalledExactlyOnceWith('0')
    input(root).dispatchEvent(new FocusEvent('blur'))
    expect(commits).toHaveBeenCalledTimes(1)
  })

  it('edits and steps unsafe integers without number coercion', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductNumberInput value="18446744073709551614" min="0" max="18446744073709551615" step="1" integer={true} onCommit={commits} />, root)

    expect(input(root).value).toBe('18446744073709551614')
    expect(input(root).getAttribute('aria-valuemin')).toBe('0')
    expect(input(root).getAttribute('aria-valuemax')).toBeNull()
    expect(input(root).getAttribute('aria-valuenow')).toBeNull()
    expect(input(root).getAttribute('aria-valuetext')).toBe('18446744073709551614')
    key(input(root), 'ArrowUp')
    expect(input(root).value).toBe('18446744073709551615')
    expect(commits).toHaveBeenLastCalledWith('18446744073709551615')
    key(input(root), 'ArrowUp')
    expect(commits).toHaveBeenCalledTimes(1)
    key(input(root), 'Home')
    expect(commits).toHaveBeenLastCalledWith('0')
    key(input(root), 'End')
    expect(commits).toHaveBeenLastCalledWith('18446744073709551615')
  })

  it('keeps unbounded integer stepping inside the supported exact range', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductNumberInput value="18446744073709551615" step="1" integer={true} onCommit={commits} />, root)

    key(input(root), 'ArrowUp')
    expect(input(root).value).toBe('18446744073709551615')
    expect(commits).not.toHaveBeenCalled()
  })

  it('defaults nonpositive integer steps to one', () => {
    for (const step of ['0', '-2']) {
      const commits = vi.fn()
      const root = document.createElement('div')
      document.body.append(root)
      render(() => <ProductNumberInput value="5" min="0" max="10" step={step} integer={true} onCommit={commits} />, root)

      key(input(root), 'ArrowUp')
      expect(input(root).value).toBe('6')
      expect(commits).toHaveBeenLastCalledWith('6')
    }
  })
})
