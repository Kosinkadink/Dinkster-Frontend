import { createSignal, type JSX } from 'solid-js'
import { ProductByteSizeInput, ProductField } from '@dinkster/ui'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductButton } from '../src/ProductControls.js'

function mount(view: () => JSX.Element): HTMLElement {
  const root = document.createElement('div')
  document.body.append(root)
  render(view, root)
  return root
}

afterEach(() => document.body.replaceChildren())

describe('product control primitives', () => {
  it('preserves native button activation while loading is disabled and announced', () => {
    const activate = vi.fn()
    const root = mount(() => (
      <>
        <ProductButton variant="danger" onClick={activate}>
          Delete
        </ProductButton>
        <ProductButton loading onClick={activate}>
          Saving
        </ProductButton>
      </>
    ))
    const [danger, loading] = [
      ...root.querySelectorAll<HTMLButtonElement>('button'),
    ]
    danger!.click()
    loading!.click()
    expect(activate).toHaveBeenCalledOnce()
    expect(danger!.dataset['variant']).toBe('danger')
    expect(loading!.disabled).toBe(true)
    expect(loading!.getAttribute('aria-busy')).toBe('true')
  })

  it('commits shared sizes without rounding untouched bytes or saving invalid drafts', async () => {
    const [value, setValue] = createSignal(10000000000)
    const [disabled, setDisabled] = createSignal(false)
    const [error, setError] = createSignal<string>()
    const [minimum, setMinimum] = createSignal(1)
    const [budget, setBudget] = createSignal<number | string>()
    const budgetCommit = vi.fn((next: number | string | undefined) =>
      setBudget(next),
    )
    const commit = vi.fn()
    const root = document.createElement('div')
    document.body.append(root)
    const dispose = render(
      () => (
        <>
          <ProductField label="Keep at most" description="Output limit">
            {(attributes) => (
              <ProductByteSizeInput
                {...attributes}
                minimum={minimum()}
                value={value()}
                disabled={disabled()}
                error={error()}
                onCommit={commit}
              />
            )}
          </ProductField>
          <ProductField label="Memory budget">
            {(attributes) => (
              <ProductByteSizeInput
                {...attributes}
                allowExpressions
                value={budget()}
                placeholder="Automatic"
                onCommit={budgetCommit}
              />
            )}
          </ProductField>
        </>
      ),
      root,
    )
    const input = root.querySelector('input')!
    const enter = () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    const blur = () => input.dispatchEvent(new FocusEvent('blur'))
    const type = (text: string) => {
      input.value = text
      input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }
    const flush = async () => {
      await Promise.resolve()
    }
    try {
      expect(input.value).toBe('9.3 GB')
      blur()
      enter()
      expect(commit).not.toHaveBeenCalled()
      setValue(4097)
      await flush()
      expect(input.value).toBe('0 GB')
      blur()
      expect(commit).not.toHaveBeenCalled()
      setValue(129385889793)
      await flush()
      expect(input.value).toBe('120.5 GB')
      blur()
      enter()
      expect(commit).not.toHaveBeenCalled()
      type('1.5')
      enter()
      blur()
      expect(commit.mock.calls).toEqual([[1610612736]])
      expect(input.value).toBe('1.5 GB')
      setValue(1610612736)
      await flush()
      for (const text of ['bad', '-1 GB', '0 GB']) {
        type(text)
        enter()
        expect(input.getAttribute('aria-invalid')).toBe('true')
        const message = root.querySelector('[role="alert"]')!
        expect(input.getAttribute('aria-describedby')).toContain(message.id)
        expect(message.textContent).toMatch(/Enter a size/)
      }
      expect(commit.mock.calls).toEqual([[1610612736]])
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
      expect(input.value).toBe('1.5 GB')
      expect(root.querySelector('[role="alert"]')).toBeNull()
      type('2 KB')
      blur()
      expect(commit.mock.calls).toEqual([[1610612736], [2048]])
      setError('Server refused the change')
      await flush()
      expect(input.value).toBe('1.5 GB')
      expect(root.querySelector('[role="alert"]')!.textContent).toContain(
        'Server refused the change',
      )
      setDisabled(true)
      await flush()
      type('3 GB')
      enter()
      blur()
      expect(commit.mock.calls).toEqual([[1610612736], [2048]])
      expect(input.disabled).toBe(true)
      setError(undefined)
      setValue(8193)
      setDisabled(false)
      await flush()
      blur()
      expect(commit.mock.calls).toEqual([[1610612736], [2048]])
      setMinimum(0)
      type('0 B')
      blur()
      expect(commit.mock.calls).toEqual([[1610612736], [2048], [0]])
      const expression = root.querySelectorAll('input')[1]!
      const commitBudget = (text: string) => {
        expression.value = text
        expression.dispatchEvent(new InputEvent('input', { bubbles: true }))
        expression.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        )
        expression.dispatchEvent(new FocusEvent('blur'))
      }
      expect(expression.value).toBe('')
      expect(expression.placeholder).toBe('Automatic')
      expression.dispatchEvent(new FocusEvent('blur'))
      expect(budgetCommit).not.toHaveBeenCalled()
      setBudget(129385889793)
      await flush()
      expect(expression.value).toBe('120.5 GB')
      expression.dispatchEvent(new FocusEvent('blur'))
      expect(budget()).toBe(129385889793)
      expect(budgetCommit).not.toHaveBeenCalled()
      commitBudget(' total * 0.75 ')
      expect(budget()).toBe('total * 0.75')
      expect(budgetCommit.mock.calls).toEqual([['total * 0.75']])
      expression.dispatchEvent(new FocusEvent('blur'))
      expect(budgetCommit).toHaveBeenCalledTimes(1)
      commitBudget('1.25 GB')
      expect(budget()).toBe(1342177280)
      expect(expression.value).toBe('1.3 GB')
      commitBudget('')
      expect(budget()).toBeUndefined()
      expect(expression.value).toBe('')
      expect(budgetCommit.mock.calls).toEqual([
        ['total * 0.75'],
        [1342177280],
        [undefined],
      ])
      setBudget('total - 1G')
      await flush()
      expression.dispatchEvent(new FocusEvent('blur'))
      expect(budgetCommit).toHaveBeenCalledTimes(3)
      expression.value = '2 GB'
      expression.dispatchEvent(new InputEvent('input', { bubbles: true }))
      expression.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
      expect(expression.value).toBe('total - 1G')
      expression.dispatchEvent(new FocusEvent('blur'))
      expect(budgetCommit).toHaveBeenCalledTimes(3)
    } finally {
      dispose()
    }
  })
})
