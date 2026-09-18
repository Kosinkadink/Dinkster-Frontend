import type { JSX } from 'solid-js'

export type ProductCheckboxState = boolean | 'mixed'

export function ProductCheckbox(props: {
  readonly checked: ProductCheckboxState
  readonly onChange: (checked: boolean) => void
  readonly id?: string
  readonly class?: string
  readonly testId?: string
  readonly ariaLabel?: string
  readonly ariaLabelledBy?: string
  readonly ariaDescribedBy?: string | undefined
  readonly ariaInvalid?: boolean
  readonly disabled?: boolean
  readonly enterActivates?: boolean
  readonly dataAttributes?: Readonly<Record<`data-${string}`, string | undefined>>
}) {
  const activate = (): void => {
    if (props.disabled !== true) props.onChange(props.checked !== true)
  }
  return (
    <button
      {...props.dataAttributes}
      id={props.id}
      type="button"
      class={`product-checkbox${props.class ? ` ${props.class}` : ''}`}
      data-testid={props.testId}
      role="checkbox"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      aria-labelledby={props.ariaLabelledBy}
      aria-describedby={props.ariaDescribedBy}
      aria-invalid={props.ariaInvalid ? 'true' : undefined}
      disabled={props.disabled}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        if (props.enterActivates === true) activate()
      }}
    >
      <span class="product-checkbox-mark" aria-hidden="true" />
    </button>
  )
}

export function ProductRadio(props: {
  readonly checked: boolean
  readonly onSelect: () => void
  readonly class?: string
  readonly ariaLabel?: string
  readonly ariaLabelledBy?: string
  readonly disabled?: boolean
  readonly children?: JSX.Element
}) {
  let control!: HTMLButtonElement
  const select = (): void => {
    if (props.disabled !== true && props.checked !== true) props.onSelect()
  }
  const move = (delta: -1 | 1): void => {
    const group = control.closest('[role="radiogroup"]')
    if (!group) return
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
    const current = radios.indexOf(control)
    for (let offset = 1; offset <= radios.length; offset += 1) {
      const next = radios[(current + delta * offset + radios.length) % radios.length]
      if (!next || next.disabled) continue
      next.focus()
      next.click()
      return
    }
  }
  return (
    <button
      ref={control}
      type="button"
      class={`product-radio${props.class ? ` ${props.class}` : ''}`}
      role="radio"
      aria-checked={props.checked}
      aria-label={props.ariaLabel}
      aria-labelledby={props.ariaLabelledBy}
      disabled={props.disabled}
      tabindex={props.checked ? 0 : -1}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          return
        }
        const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -1
            : undefined
        if (delta === undefined) return
        event.preventDefault()
        move(delta)
      }}
    >
      <span class="product-radio-mark" aria-hidden="true" />
      {props.children}
    </button>
  )
}
