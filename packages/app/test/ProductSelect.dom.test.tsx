// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductSelect } from '../src/ProductSelect.js'

const key = (target: Element, value: string): KeyboardEvent => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('ProductSelect', () => {
  it('exposes combobox state and commits only an explicit keyboard selection', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductSelect
      ariaLabel="Flavor"
      options={[
        { id: 'alpha', label: 'Alpha', value: 'alpha' },
        { id: 'beta', label: 'Beta', value: 'beta' },
        { id: 'gamma', label: 'Gamma', value: 'gamma' },
      ]}
      selectedId="alpha"
      onSelect={(option) => commits(option.value)}
    />, root)

    const trigger = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    key(trigger, 'ArrowDown')
    expect(commits).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
    key(trigger, 'End')
    expect(commits).not.toHaveBeenCalled()
    key(trigger, 'Enter')
    expect(commits).toHaveBeenCalledOnce()
    expect(commits).toHaveBeenCalledWith('gamma')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
  })

  it('supports typeahead, disabled options, Home, Space, and Escape without commit', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductSelect
      ariaLabel="Mount"
      options={[
        { id: 'old', label: 'Old (unavailable)', value: 'old', disabled: true },
        { id: 'output', label: 'Output', value: 'output' },
        { id: 'scratch', label: 'Scratch', value: 'scratch' },
      ]}
      selectedId="old"
      onSelect={(option) => commits(option.value)}
    />, root)

    const trigger = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
    trigger.click()
    expect(document.querySelector('[role="option"][aria-selected="true"]')?.getAttribute('aria-disabled')).toBe('true')
    key(trigger, 's')
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.getAttribute('data-option-id')).toBe('scratch')
    key(trigger, 'Escape')
    expect(commits).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    key(trigger, 'Home')
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.getAttribute('data-option-id')).toBe('output')
    key(trigger, 'Escape')
    key(trigger, 'ArrowDown')
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.getAttribute('data-option-id')).toBe('output')
    key(trigger, ' ')
    expect(commits).toHaveBeenCalledWith('output')
  })

  it('scrolls each keyboard-active option into the visible list tail', async () => {
    const revealed: Element[] = []
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      revealed.push(this)
    })
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductSelect
      ariaLabel="Long inventory"
      options={Array.from({ length: 12 }, (_, index) => ({
        id: String(index),
        label: `Option ${index}`,
        value: index,
      }))}
      selectedId="0"
      onSelect={() => undefined}
    />, root)

    const trigger = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
    trigger.click()
    await Promise.resolve()
    revealed.length = 0
    key(trigger, 'End')
    await Promise.resolve()

    expect(revealed.at(-1)?.getAttribute('data-option-id')).toBe('11')
    scroll.mockRestore()
  })

  it('keeps trigger identity and reflects controlled option updates', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const [selected, setSelected] = createSignal('one')
    const [options, setOptions] = createSignal([
      { id: 'one', label: 'One', value: 'one' },
      { id: 'two', label: 'Two', value: 'two' },
    ])
    render(() => <ProductSelect options={options()} selectedId={selected()} onSelect={(option) => { commits(option.value); setSelected(option.value) }} />, root)
    const trigger = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
    trigger.focus()
    trigger.click()
    key(trigger, 'End')
    setOptions([{ id: 'one', label: 'One', value: 'one' }, { id: 'three', label: 'Three', value: 'three' }])
    expect(root.querySelector('[role="combobox"]')).toBe(trigger)
    expect(document.activeElement).toBe(trigger)
    expect(document.getElementById(trigger.getAttribute('aria-activedescendant')!)?.getAttribute('data-option-id')).toBe('one')
    key(trigger, 'Enter')
    expect(commits).not.toHaveBeenCalled()
  })

  it('contains listbox pointerdown inside a dialog', () => {
    const outside = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <dialog onPointerDown={outside}>
      <ProductSelect
        options={[{ id: 'one', label: 'One', value: 'one' }, { id: 'two', label: 'Two', value: 'two' }]}
        selectedId="one"
        onSelect={() => undefined}
      />
    </dialog>, root)

    root.querySelector<HTMLButtonElement>('[role="combobox"]')!.click()
    document.querySelector('[role="option"]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
    expect(outside).not.toHaveBeenCalled()
  })

  it('supports an action selector whose committed choice remains unselected', () => {
    const commits = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    render(() => <ProductSelect
      ariaLabel="Bind group to surface"
      options={[
        { id: '', label: 'Bind group...', value: '', disabled: true },
        { id: 'group-1', label: 'Group 1', value: 'group-1' },
      ]}
      selectedId=""
      onSelect={(option) => commits(option.value)}
    />, root)

    const trigger = root.querySelector<HTMLButtonElement>('[role="combobox"]')!
    expect(trigger.textContent).toContain('Bind group...')
    for (let invocation = 0; invocation < 2; invocation += 1) {
      trigger.click()
      key(trigger, 'End')
      key(trigger, 'Enter')
      expect(trigger.textContent).toContain('Bind group...')
      expect(document.activeElement).toBe(trigger)
    }
    expect(commits).toHaveBeenCalledTimes(2)
    expect(commits).toHaveBeenNthCalledWith(1, 'group-1')
    expect(commits).toHaveBeenNthCalledWith(2, 'group-1')
  })

  it('restores the exact trigger after a synchronous caller remount', async () => {
    const firstRoot = document.createElement('div')
    const actionRoot = document.createElement('div')
    document.body.append(firstRoot, actionRoot)
    const options = [
      { id: '', label: 'Bind group...', value: '', disabled: true },
      { id: 'group-1', label: 'Group 1', value: 'group-1' },
    ]
    render(() => <ProductSelect
      ariaLabel="Bind group to surface"
      options={options}
      selectedId=""
      onSelect={() => undefined}
    />, firstRoot)
    const mountAction = (): void => {
      render(() => <ProductSelect
        testId={'surface-action-\0'}
        ariaLabel="Bind group to surface"
        options={options}
        selectedId=""
        onSelect={() => {
          actionRoot.replaceChildren()
          mountAction()
        }}
      />, actionRoot)
    }
    mountAction()

    const action = actionRoot.querySelector<HTMLButtonElement>('[role="combobox"]')!
    action.focus()
    action.click()
    key(action, 'End')
    key(action, 'Enter')
    await Promise.resolve()
    expect(action.isConnected).toBe(false)
    expect(document.activeElement).toBe(actionRoot.querySelector('[role="combobox"]'))
    expect(document.activeElement).not.toBe(firstRoot.querySelector('[role="combobox"]'))
  })

  it('never focuses another control through an ambiguous fallback attribute', async () => {
    const firstRoot = document.createElement('div')
    const secondRoot = document.createElement('div')
    document.body.append(firstRoot, secondRoot)
    const options = [
      { id: '', label: 'Bind group...', value: '', disabled: true },
      { id: 'group-1', label: 'Group 1', value: 'group-1' },
    ]
    render(() => <ProductSelect
      testId="shared-combo"
      ariaLabel="First action"
      options={options}
      selectedId=""
      onSelect={() => undefined}
    />, firstRoot)
    const mountSecond = (): void => {
      render(() => <ProductSelect
        testId="shared-combo"
        ariaLabel="Second action"
        options={options}
        selectedId=""
        onSelect={() => {
          secondRoot.replaceChildren()
          mountSecond()
        }}
      />, secondRoot)
    }
    mountSecond()

    const second = secondRoot.querySelector<HTMLButtonElement>('[role="combobox"]')!
    second.focus()
    second.click()
    key(second, 'End')
    key(second, 'Enter')
    await Promise.resolve()
    expect(second.isConnected).toBe(false)
    expect(document.activeElement).toBe(secondRoot.querySelector('[role="combobox"]'))
    expect(document.activeElement).not.toBe(firstRoot.querySelector('[role="combobox"]'))
  })
})
