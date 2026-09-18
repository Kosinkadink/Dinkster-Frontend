import { createEffect, createSignal, on, type JSX } from 'solid-js'
import { MAX_INTEGER_WIDGET_VALUE, MIN_INTEGER_WIDGET_VALUE } from '@dinkster/core'

type NumberValue = number | string | undefined

export function ProductNumberInput(props: {
  readonly value: NumberValue
  readonly min?: NumberValue
  readonly max?: NumberValue
  readonly step?: NumberValue
  readonly integer?: boolean
  readonly inputMode?: 'decimal' | 'numeric'
  readonly id?: string
  readonly class?: string
  readonly testId?: string
  readonly ariaLabel?: string
  readonly ariaLabelledBy?: string
  readonly ariaDescribedBy?: string | undefined
  readonly ariaInvalid?: boolean
  readonly disabled?: boolean
  /** Emit explicitly typed defaults when absence has distinct storage meaning. */
  readonly commitUnchanged?: boolean
  readonly onCommit?: (raw: string) => void
  readonly onInput?: (raw: string) => void
  readonly onRevert?: () => void
}) {
  const text = (value: NumberValue): string => value === undefined ? '' : String(value)
  const numeric = (value: NumberValue): number | undefined => {
    if (value === undefined || value === '' || value === 'any') return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const integer = (value: NumberValue): bigint | undefined => {
    if (value === undefined || value === '' || value === 'any') return undefined
    try {
      const parsed = BigInt(value)
      return String(parsed) === String(value) ? parsed : undefined
    } catch {
      return undefined
    }
  }
  const safeInteger = (value: NumberValue): number | undefined => {
    const parsed = integer(value)
    return parsed !== undefined
      && parsed >= BigInt(Number.MIN_SAFE_INTEGER)
      && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(parsed)
      : undefined
  }
  const [raw, setRaw] = createSignal(text(props.value))
  const [committed, setCommitted] = createSignal(text(props.value))
  let dirty = false

  createEffect(on(() => props.value, (value) => {
    const next = text(value)
    setCommitted(next)
    if (props.onCommit === undefined || !dirty) {
      dirty = false
      setRaw(next)
    }
  }))

  const valid = (value: string): boolean => props.integer === true
    ? integer(value) !== undefined
    : value.trim() !== '' && Number.isFinite(Number(value))
  const commit = (): void => {
    if (!dirty || props.onCommit === undefined) return
    dirty = false
    if (raw() === committed() && !props.commitUnchanged) return
    props.onCommit(raw())
  }
  const syncAndCommit = (value: string): void => {
    if (value !== raw()) {
      dirty = true
      setRaw(value)
    }
    commit()
  }
  const setStepped = (next: number): void => {
    const min = numeric(props.min)
    const max = numeric(props.max)
    const bounded = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, next))
    const value = String(Number(bounded.toFixed(12)))
    const changed = value !== committed()
    setRaw(value)
    dirty = false
    if (!changed) return
    setCommitted(value)
    if (props.onInput !== undefined) {
      props.onInput(value)
    } else props.onCommit?.(value)
  }
  const setIntegerStepped = (next: bigint): void => {
    const min = integer(props.min) ?? MIN_INTEGER_WIDGET_VALUE
    const max = integer(props.max) ?? MAX_INTEGER_WIDGET_VALUE
    const bounded = next < min ? min : next > max ? max : next
    const value = String(bounded)
    const changed = value !== committed()
    setRaw(value)
    dirty = false
    if (!changed) return
    setCommitted(value)
    if (props.onInput !== undefined) {
      props.onInput(value)
    } else props.onCommit?.(value)
  }
  const divideFloor = (value: bigint, divisor: bigint): bigint => {
    const quotient = value / divisor
    return value < 0n && value % divisor !== 0n ? quotient - 1n : quotient
  }
  const divideCeil = (value: bigint, divisor: bigint): bigint => {
    const quotient = value / divisor
    return value > 0n && value % divisor !== 0n ? quotient + 1n : quotient
  }
  const stepInteger = (multiple: number): void => {
    const current = integer(raw()) ?? integer(props.min) ?? 0n
    const declaredStep = integer(props.step)
    const amount = declaredStep !== undefined && declaredStep > 0n ? declaredStep : 1n
    const base = integer(props.min) ?? 0n
    const offset = current - base
    const aligned = offset % amount === 0n
    const index = aligned
      ? offset / amount + BigInt(multiple)
      : multiple > 0 ? divideFloor(offset, amount) + BigInt(multiple) : divideCeil(offset, amount) + BigInt(multiple)
    setIntegerStepped(base + index * amount)
  }
  const step = (multiple: number): void => {
    if (props.disabled === true) return
    if (props.integer === true) {
      stepInteger(multiple)
      return
    }
    const current = valid(raw()) ? Number(raw()) : numeric(props.min) ?? 0
    const amount = numeric(props.step) ?? 1
    const base = numeric(props.min) ?? 0
    const index = (current - base) / amount
    const aligned = Math.abs(index - Math.round(index)) < 1e-9
    const nextIndex = aligned
      ? Math.round(index) + multiple
      : multiple > 0 ? Math.floor(index) + multiple : Math.ceil(index) + multiple
    setStepped(base + nextIndex * amount)
  }
  const keydown: JSX.EventHandlerUnion<HTMLInputElement, KeyboardEvent> = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      dirty = false
      setRaw(committed())
      props.onRevert?.()
      return
    }
    if (event.key === 'Enter') {
      if (props.onCommit === undefined) return
      event.preventDefault()
      commit()
      return
    }
    const directions: Record<string, number | undefined> = {
      ArrowUp: 1,
      ArrowDown: -1,
      PageUp: 10,
      PageDown: -10,
    }
    const direction = directions[event.key]
    if (direction !== undefined) {
      event.preventDefault()
      step(direction)
      return
    }
    if (event.key === 'Home' && (props.integer === true ? integer(props.min) !== undefined : numeric(props.min) !== undefined)) {
      event.preventDefault()
      if (props.integer === true) setIntegerStepped(integer(props.min)!)
      else setStepped(numeric(props.min)!)
    } else if (event.key === 'End' && (props.integer === true ? integer(props.max) !== undefined : numeric(props.max) !== undefined)) {
      event.preventDefault()
      if (props.integer === true) setIntegerStepped(integer(props.max)!)
      else setStepped(numeric(props.max)!)
    }
  }
  const parsed = (): number | undefined => props.integer === true
    ? safeInteger(raw())
    : valid(raw()) ? Number(raw()) : undefined

  return (
    <span class={`product-number${props.class ? ` ${props.class}` : ''}`}>
      <input
        id={props.id}
        class="product-number-field"
        data-testid={props.testId}
        type="text"
        inputmode={props.inputMode ?? 'decimal'}
        role="spinbutton"
        aria-label={props.ariaLabel}
        aria-labelledby={props.ariaLabelledBy}
        aria-describedby={props.ariaDescribedBy}
        aria-invalid={props.ariaInvalid ? 'true' : undefined}
        aria-valuemin={props.integer === true ? safeInteger(props.min) : numeric(props.min)}
        aria-valuemax={props.integer === true ? safeInteger(props.max) : numeric(props.max)}
        aria-valuenow={parsed()}
        aria-valuetext={parsed() === undefined ? raw() : undefined}
        disabled={props.disabled}
        value={raw()}
        onInput={(event) => {
          const value = event.currentTarget.value
          dirty = true
          setRaw(value)
          if (props.onInput !== undefined && valid(value)) {
            setCommitted(value)
            dirty = false
            props.onInput(value)
          }
        }}
        onChange={(event) => syncAndCommit(event.currentTarget.value)}
        onBlur={(event) => syncAndCommit(event.currentTarget.value)}
        onKeyDown={keydown}
      />
      <span class="product-number-steppers">
        <button type="button" tabindex="-1" aria-label="Increase value" disabled={props.disabled} onPointerDown={(event) => event.preventDefault()} onClick={() => step(1)}>+</button>
        <button type="button" tabindex="-1" aria-label="Decrease value" disabled={props.disabled} onPointerDown={(event) => event.preventDefault()} onClick={() => step(-1)}>-</button>
      </span>
    </span>
  )
}
