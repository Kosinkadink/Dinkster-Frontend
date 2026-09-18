// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductTabs, type ProductTab } from '../src/ProductTabs.js'

afterEach(() => document.body.replaceChildren())

const key = (target: Element, value: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }))
}

const tabs = (): readonly ProductTab[] => [
  { id: 'details', label: 'Details', panel: <p>Details panel</p> },
  { id: 'disabled', label: 'Disabled', panel: <p>Disabled panel</p>, disabled: true },
  { id: 'history', label: 'History', panel: <p>History panel</p> },
]

describe('ProductTabs', () => {
  it('wires labelled tabs and panels with one selected roving tab', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProductTabs tabs={tabs()} ariaLabel="Inspector" defaultSelectedId="details" />, root)
    const tablist = root.querySelector('[role="tablist"]')!
    const triggers = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    const panels = root.querySelectorAll<HTMLElement>('[role="tabpanel"]')

    expect(tablist.getAttribute('aria-label')).toBe('Inspector')
    expect(tablist.getAttribute('aria-orientation')).toBe('horizontal')
    expect(triggers[0]!.getAttribute('aria-selected')).toBe('true')
    expect(triggers[0]!.tabIndex).toBe(0)
    expect(triggers[1]!.disabled).toBe(true)
    expect(triggers[2]!.tabIndex).toBe(-1)
    expect(panels[0]!.hidden).toBe(false)
    expect(panels[1]!.hidden).toBe(true)
    for (const trigger of triggers) {
      expect(document.getElementById(trigger.getAttribute('aria-controls')!)).not.toBeNull()
    }
    for (const panel of panels) {
      expect(document.getElementById(panel.getAttribute('aria-labelledby')!)).not.toBeNull()
    }
    dispose()
  })

  it('automatically activates arrow, Home, and End focus while skipping disabled tabs', () => {
    const onSelect = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProductTabs tabs={tabs()} ariaLabel="Inspector" defaultSelectedId="details" onSelect={onSelect} />, root)
    const triggers = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')

    triggers[0]!.focus()
    key(triggers[0]!, 'ArrowRight')
    expect(document.activeElement).toBe(triggers[2])
    expect(triggers[2]!.getAttribute('aria-selected')).toBe('true')
    expect(onSelect).toHaveBeenLastCalledWith('history')
    key(triggers[2]!, 'Home')
    expect(document.activeElement).toBe(triggers[0])
    expect(triggers[0]!.getAttribute('aria-selected')).toBe('true')
    key(triggers[0]!, 'End')
    expect(document.activeElement).toBe(triggers[2])
    key(triggers[2]!, 'ArrowRight')
    expect(document.activeElement).toBe(triggers[0])
    dispose()
  })

  it('supports controlled selection and refuses disabled activation', () => {
    const [selected, setSelected] = createSignal('details')
    const onSelect = vi.fn((id: string) => setSelected(id))
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProductTabs tabs={tabs()} ariaLabel="Inspector" selectedId={selected()} onSelect={onSelect} />, root)
    const triggers = root.querySelectorAll<HTMLButtonElement>('[role="tab"]')

    triggers[2]!.click()
    expect(selected()).toBe('history')
    expect(triggers[2]!.getAttribute('aria-selected')).toBe('true')
    triggers[1]!.click()
    expect(selected()).toBe('history')
    expect(onSelect).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('selects and focuses the nearest enabled tab when the selected tab is removed', async () => {
    const [items, setItems] = createSignal(tabs())
    const onSelect = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProductTabs tabs={items()} ariaLabel="Inspector" defaultSelectedId="history" onSelect={onSelect} />, root)
    const history = root.querySelector<HTMLButtonElement>('[role="tab"][data-tab-id="history"]')!
    history.focus()

    setItems((current) => [{ ...current[0]! }, { id: 'activity', label: 'Activity', panel: <p>Activity panel</p> }])
    await Promise.resolve()
    const activity = root.querySelector<HTMLButtonElement>('[role="tab"][data-tab-id="activity"]')!
    expect(document.activeElement).toBe(activity)
    expect(activity.getAttribute('aria-selected')).toBe('true')
    expect(activity.tabIndex).toBe(0)
    expect(onSelect).toHaveBeenLastCalledWith('activity')

    setItems((current) => [...current.map((tab) => ({ ...tab })), { id: 'logs', label: 'Logs', panel: <p>Logs panel</p> }])
    await Promise.resolve()
    expect(activity.getAttribute('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(activity)
    dispose()
  })

  it('does not reclaim focus after the user leaves a tab before it is removed', async () => {
    const [items, setItems] = createSignal(tabs())
    const root = document.createElement('div')
    const outside = document.createElement('button')
    document.body.append(root, outside)
    const dispose = render(() => <ProductTabs tabs={items()} ariaLabel="Inspector" defaultSelectedId="history" />, root)
    root.querySelector<HTMLButtonElement>('[data-tab-id="history"]')!.focus()
    outside.focus()

    setItems((current) => current.filter((tab) => tab.id !== 'history').map((tab) => ({ ...tab })))
    await Promise.resolve()
    expect(document.activeElement).toBe(outside)
    dispose()
  })

  it('keeps controlled ownership for undefined, empty, and all-disabled selections', async () => {
    const [items, setItems] = createSignal<readonly ProductTab[]>([])
    const onSelect = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(() => <ProductTabs tabs={items()} ariaLabel="Inspector" selectedId={undefined} onSelect={onSelect} />, root)

    expect(root.querySelector('[role="tab"]')).toBeNull()
    setItems([{ id: 'blocked', label: 'Blocked', panel: 'Blocked', disabled: true }])
    await Promise.resolve()
    expect(onSelect).not.toHaveBeenCalled()
    setItems((current) => [...current, { id: 'ready', label: 'Ready', panel: 'Ready' }])
    await Promise.resolve()
    expect(onSelect).toHaveBeenCalledOnce()
    expect(onSelect).toHaveBeenCalledWith('ready')
    expect(root.querySelector('[data-tab-id="ready"]')?.getAttribute('aria-selected')).toBe('true')
    await Promise.resolve()
    expect(onSelect).toHaveBeenCalledOnce()
    dispose()
  })

  it('supports labelled-by naming, unique generated relationships, and rejects duplicate ids', () => {
    const label = document.createElement('h2')
    label.id = 'tabs-heading'
    label.textContent = 'Inspector'
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(label, first, second)
    const disposeFirst = render(() => <ProductTabs tabs={tabs()} ariaLabelledBy="tabs-heading" />, first)
    const disposeSecond = render(() => <ProductTabs tabs={tabs()} ariaLabel="Other inspector" />, second)

    expect(first.querySelector('[role="tablist"]')?.getAttribute('aria-labelledby')).toBe('tabs-heading')
    const ids = [...document.querySelectorAll<HTMLElement>('[role="tab"], [role="tabpanel"]')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    const duplicate = document.createElement('div')
    expect(() => render(() => <ProductTabs
      tabs={[{ id: 'same', label: 'One', panel: 'One' }, { id: 'same', label: 'Two', panel: 'Two' }]}
      ariaLabel="Duplicates"
    />, duplicate)).toThrow(/unique tab ids/)
    disposeFirst()
    disposeSecond()
  })
})
