// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import type { JSX } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ProductButton,
  ProductTextArea,
  ProductTextInput,
} from '../src/ProductControls.js'
import {
  ProductEmptyState,
  ProductListRow,
  ProductPanelHeader,
  ProductTable,
} from '../src/ProductSurfaces.js'

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

  it('retains labels, values, input events and invalid state', () => {
    const changed = vi.fn()
    const root = mount(() => (
      <>
        <label for="name">Name</label>
        <ProductTextInput id="name" name="name" invalid onInput={changed} />
        <label for="notes">Notes</label>
        <ProductTextArea id="notes" name="notes" invalid />
      </>
    ))
    const input = root.querySelector<HTMLInputElement>('input')!
    input.value = 'Ada'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(changed).toHaveBeenCalledOnce()
    expect(input.labels?.[0]?.textContent).toBe('Name')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(root.querySelector('textarea')?.getAttribute('aria-invalid')).toBe(
      'true',
    )
  })
})

describe('product surface primitives', () => {
  it('renders header, selected row and native table semantics', () => {
    const root = mount(() => (
      <>
        <ProductPanelHeader
          title="Problems"
          count={2}
          actions={<ProductButton>Clear</ProductButton>}
        />
        <ProductListRow selected primary="Failure" secondary="Details" />
        <ProductTable caption="Runs" ariaLabel="Execution runs">
          <thead>
            <tr>
              <th>Run</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>One</td>
            </tr>
          </tbody>
        </ProductTable>
      </>
    ))
    expect(root.querySelector('h2')?.textContent).toBe('Problems')
    expect(
      root.querySelector('[role="option"]')?.getAttribute('aria-selected'),
    ).toBe('true')
    expect(root.querySelector('caption')?.textContent).toBe('Runs')
    expect(
      root.querySelector('.product-table-scroll')?.getAttribute('aria-label'),
    ).toBe('Execution runs')
  })

  it('announces loading politely and errors assertively', () => {
    const [tone, setTone] = createSignal<'loading' | 'error'>('loading')
    const root = mount(() => (
      <ProductEmptyState
        title="Unavailable"
        hint="Try again"
        tone={tone()}
        action={<button onClick={() => setTone('error')}>Retry</button>}
      />
    ))
    const state = root.querySelector<HTMLElement>('.product-empty-state')!
    expect(state.getAttribute('role')).toBe('status')
    expect(state.getAttribute('aria-live')).toBe('polite')
    root.querySelector('button')!.click()
    expect(state.getAttribute('role')).toBe('alert')
    expect(state.getAttribute('aria-live')).toBeNull()
  })
})
