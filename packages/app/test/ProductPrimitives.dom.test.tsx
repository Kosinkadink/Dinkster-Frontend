
import type { JSX } from 'solid-js'
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

})
