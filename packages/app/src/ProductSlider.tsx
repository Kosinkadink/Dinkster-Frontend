import { createEffect, createSignal, on, type JSX } from 'solid-js'

export function ProductSlider(props: {
  readonly value: number
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly ariaLabel?: string
  readonly ariaLabelledBy?: string
  readonly class?: string
  readonly disabled?: boolean
  readonly onInput: (value: number) => void
  readonly onCommit?: (value: number) => void
}) {
  const [value, setValue] = createSignal(props.value)
  let track: HTMLDivElement | undefined
  let dragging = false
  let dragStartValue = props.value

  const unit = (): number => props.step && props.step > 0 ? props.step : 1
  const normalize = (candidate: number): number => {
    const bounded = Math.min(props.max, Math.max(props.min, candidate))
    const stepped = props.min + Math.round((bounded - props.min) / unit()) * unit()
    return Number(Math.min(props.max, Math.max(props.min, stepped)).toFixed(12))
  }
  createEffect(on(
    () => [props.value, props.min, props.max] as const,
    ([next]) => setValue(Math.min(props.max, Math.max(props.min, next))),
  ))
  const update = (candidate: number): number | undefined => {
    if (props.disabled === true) return undefined
    const next = normalize(candidate)
    if (next === value()) return undefined
    setValue(next)
    props.onInput(next)
    return next
  }
  const updatePointer = (event: PointerEvent): void => {
    if (!track) return
    const rect = track.getBoundingClientRect()
    if (rect.width <= 0) return
    update(props.min + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * (props.max - props.min))
  }
  const keydown: JSX.EventHandlerUnion<HTMLDivElement, KeyboardEvent> = (event) => {
    const changes: Record<string, number | undefined> = {
      ArrowRight: unit(),
      ArrowUp: unit(),
      ArrowLeft: -unit(),
      ArrowDown: -unit(),
      PageUp: unit() * 10,
      PageDown: -unit() * 10,
    }
    const change = changes[event.key]
    if (change !== undefined) {
      event.preventDefault()
      const next = update(value() + change)
      if (next !== undefined) props.onCommit?.(next)
    } else if (event.key === 'Home') {
      event.preventDefault()
      const next = update(props.min)
      if (next !== undefined) props.onCommit?.(next)
    } else if (event.key === 'End') {
      event.preventDefault()
      const next = update(props.max)
      if (next !== undefined) props.onCommit?.(next)
    }
  }
  const percent = (): number => props.max > props.min ? ((value() - props.min) / (props.max - props.min)) * 100 : 0

  return (
    <div
      ref={track}
      class={`product-slider${props.class ? ` ${props.class}` : ''}`}
      classList={{ disabled: props.disabled === true }}
      role="slider"
      tabindex={props.disabled ? undefined : 0}
      aria-label={props.ariaLabel}
      aria-labelledby={props.ariaLabelledBy}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      aria-valuenow={value()}
      aria-orientation="horizontal"
      aria-disabled={props.disabled}
      onKeyDown={keydown}
      onPointerDown={(event) => {
        event.preventDefault()
        event.stopPropagation()
        dragging = true
        dragStartValue = value()
        track?.setPointerCapture?.(event.pointerId)
        updatePointer(event)
        track?.focus()
      }}
      onPointerMove={(event) => { if (dragging) updatePointer(event) }}
      onPointerUp={(event) => {
        event.stopPropagation()
        dragging = false
        track?.releasePointerCapture?.(event.pointerId)
        if (value() !== dragStartValue) props.onCommit?.(value())
      }}
      onPointerCancel={() => {
        dragging = false
        if (props.onCommit !== undefined) setValue(props.value)
      }}
    >
      <span class="product-slider-rail" aria-hidden="true">
        <span class="product-slider-fill" style={{ width: `${percent()}%` }} />
        <span class="product-slider-thumb" style={{ left: `${percent()}%` }} />
      </span>
    </div>
  )
}
