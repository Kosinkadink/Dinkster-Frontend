// @vitest-environment happy-dom

import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it } from 'vitest'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from '../src/ProductForm.js'

afterEach(() => document.body.replaceChildren())

describe('ProductForm', () => {
  it('associates a field label, help, validation message, and control state', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const ids = productFieldIds('form-value')
    const [message, setMessage] = createSignal<string>()
    render(() => (
      <ProductField
        controlId="form-value"
        label="Value"
        description="Enter a bounded value."
        metadata={<code>fixture.value</code>}
        message={message()}
        messageTestId="field-message"
        invalid={message() !== undefined}
        actions={<button type="button">Reset</button>}
      >
        <input
          id="form-value"
          aria-labelledby={ids.label}
          aria-describedby={`${ids.description}${message() === undefined ? '' : ` ${ids.message}`}`}
          aria-invalid={message() === undefined ? undefined : 'true'}
        />
      </ProductField>
    ), root)

    const field = root.querySelector<HTMLElement>('.product-field')!
    const input = root.querySelector<HTMLInputElement>('input')!
    expect(field.getAttribute('role')).toBe('group')
    expect(field.getAttribute('aria-labelledby')).toBe(ids.label)
    expect(root.querySelector('label')?.getAttribute('for')).toBe('form-value')
    expect(input.getAttribute('aria-describedby')).toBe(ids.description)
    expect(root.querySelector('.product-field-metadata')?.textContent).toBe('fixture.value')
    expect(root.querySelector('.product-field-actions button')?.textContent).toBe('Reset')

    setMessage('Enter a finite number.')
    expect(field.classList.contains('product-field-invalid')).toBe(true)
    expect(input.getAttribute('aria-describedby')).toBe(`${ids.description} ${ids.message}`)
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(root.querySelector('[data-testid="field-message"]')?.getAttribute('role')).toBe('alert')
    expect(root.querySelector('[data-testid="field-message"]')?.textContent).toBe('Enter a finite number.')

    setMessage(undefined)
    expect(field.classList.contains('product-field-invalid')).toBe(false)
    expect(input.getAttribute('aria-describedby')).toBe(ids.description)
    expect(root.querySelector('[data-testid="field-message"]')).toBeNull()
  })

  it('uses status and alert semantics and keeps actions in one footer', () => {
    const root = document.createElement('div')
    document.body.append(root)
    render(() => (
      <>
        <ProductNotice tone="status" testId="status">Saving...</ProductNotice>
        <ProductNotice tone="warning" testId="warning">Review this value.</ProductNotice>
        <ProductNotice tone="error" testId="error">Save failed.</ProductNotice>
        <ProductActionFooter status="2 changes">
          <button type="button">Cancel</button>
          <button type="button" class="primary">Apply</button>
        </ProductActionFooter>
      </>
    ), root)

    expect(root.querySelector('[data-testid="status"]')?.getAttribute('role')).toBe('status')
    expect(root.querySelector('[data-testid="status"]')?.getAttribute('aria-live')).toBe('polite')
    expect(root.querySelector('[data-testid="warning"]')?.getAttribute('role')).toBe('alert')
    expect(root.querySelector('[data-testid="error"]')?.getAttribute('role')).toBe('alert')
    expect(root.querySelector('.product-action-status')?.textContent).toBe('2 changes')
    expect([...root.querySelectorAll('.product-action-buttons button')].map((button) => button.textContent)).toEqual(['Cancel', 'Apply'])
  })
})
