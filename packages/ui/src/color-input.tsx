import { placeFloatingSurface } from '@dinkster/core/floating-surface'
import { semanticDesignTokens } from '@dinkster/core'
import { hexToHsv, hsvToHex } from '@dinkster/widgets'
import {
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  onMount,
  splitProps,
  type JSX,
} from 'solid-js'
import { Portal } from 'solid-js/web'
import {
  CanvasColorPicker,
  CanvasColorSquare,
  type CanvasColorPoint,
} from './canvas-color.js'
import { ProductTextInput } from './controls.js'
import { useProductStrings } from './strings.js'
import { useFieldFocus } from './field-focus.js'

export function ProductColorInput(
  props: Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    | 'value'
    | 'onChange'
    | 'onClick'
    | 'onKeyDown'
    | 'children'
    | 'class'
    | 'style'
    | 'type'
    | 'ref'
  > & {
    readonly value: string
    readonly onChange: (color: string) => void
  },
) {
  useFieldFocus()
  const [local, button] = splitProps(props, [
    'value',
    'onChange',
    'disabled',
    'id',
  ])
  const strings = useProductStrings()
  const id = createUniqueId()
  const popupId = `color-${id}`
  const errorId = `${popupId}-error`
  const [open, setOpen] = createSignal(false)
  const [text, setText] = createSignal(local.value)
  const [invalid, setInvalid] = createSignal(false)
  const [hue, setHue] = createSignal(0)
  let trigger!: HTMLButtonElement
  let popup!: HTMLDivElement
  let field!: HTMLInputElement
  const point = (): CanvasColorPoint => {
    const hsv = hexToHsv(local.value) ?? { h: 0, s: 0, v: 0 }
    return { ...hsv, h: hsv.s === 0 ? hue() : hsv.h, a: 255 }
  }
  const choose = (value: string) => {
    if (local.disabled) return
    if (!/^#[0-9a-f]{6}$/i.test(value)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (value.toLowerCase() !== local.value.toLowerCase())
      local.onChange(value.toLowerCase())
    setText(local.value)
    field.value = local.value
  }
  const pick = (next: CanvasColorPoint) => {
    if (local.disabled) return
    setHue(next.h)
    choose(hsvToHex(next.h, next.s, next.v))
  }
  const close = (restoreFocus = false) => {
    setOpen(false)
    if (restoreFocus) trigger.focus()
  }
  const place = () => {
    if (!open() || !popup) return
    const placed = placeFloatingSurface({
      anchor: trigger.getBoundingClientRect(),
      surface: { width: popup.offsetWidth, height: popup.scrollHeight },
      bounds: {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
      },
      direction: 'block',
      margin: semanticDesignTokens.space[8],
      gap: semanticDesignTokens.space[4],
    })
    Object.assign(popup.style, {
      left: `${placed.left}px`,
      top: `${placed.top}px`,
      maxHeight: `${placed.maxHeight}px`,
    })
  }
  const show = () => {
    if (local.disabled) return
    setText(local.value)
    setInvalid(false)
    setOpen(true)
    queueMicrotask(() => {
      place()
      field.focus()
    })
  }
  createEffect(() => {
    setText(local.value)
    const hsv = hexToHsv(local.value)
    if (hsv && hsv.s > 0) setHue(hsv.h)
    if (local.disabled) close()
  })
  onMount(() => {
    const outside = (event: Event) => {
      if (
        open() &&
        event.target instanceof Node &&
        !trigger.contains(event.target) &&
        !popup.contains(event.target)
      )
        close()
    }
    const observer = new ResizeObserver(place)
    observer.observe(trigger)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    onCleanup(() => {
      observer.disconnect()
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    })
  })
  return (
    <>
      <button
        {...button}
        ref={trigger}
        id={local.id}
        type="button"
        class="dinkster-input dinkster-color-input"
        disabled={local.disabled}
        aria-haspopup="dialog"
        aria-expanded={open()}
        aria-controls={open() ? popupId : undefined}
        onClick={() => (open() ? close() : show())}
      >
        <CanvasColorSquare color={local.value} size={24} />
        <span>{local.value}</span>
      </button>
      <Show when={open()}>
        <Portal mount={trigger.closest('dialog') ?? document.body}>
          <div
            ref={popup}
            id={popupId}
            role="dialog"
            aria-label={strings.colorValue}
            class="floating-surface dinkster-color-popup"
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                close(true)
              }
            }}
          >
            <label class="dinkster-color-value">
              {strings.colorValue}
              <ProductTextInput
                ref={field}
                value={text()}
                spellcheck={false}
                disabled={local.disabled}
                aria-invalid={invalid()}
                aria-describedby={invalid() ? errorId : undefined}
                onInput={(event) => {
                  const value = event.currentTarget.value
                  setText(value)
                  setInvalid(!/^#[0-9a-f]{6}$/i.test(value))
                  if (/^#[0-9a-f]{6}$/i.test(value)) choose(value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.isComposing) {
                    event.preventDefault()
                    choose(text())
                  } else if (event.key === 'Tab' && event.shiftKey) {
                    event.preventDefault()
                    close(true)
                  }
                }}
              />
            </label>
            <Show when={invalid()}>
              <p id={errorId} class="dinkster-field-error">
                {strings.colorInvalid}
              </p>
            </Show>
            <CanvasColorPicker
              point={point()}
              opacity={false}
              hex={hsvToHex}
              swatches={[]}
              onPick={pick}
              disabled={local.disabled === true}
              onKeyDown={(event, control) => {
                if (event.key === 'Tab' && !event.shiftKey && control === 'hue')
                  close(true)
              }}
              controls={(controls) => {
                if (controls.square) controls.square.tabIndex = 0
                if (controls.hue) controls.hue.tabIndex = 0
              }}
            />
          </div>
        </Portal>
      </Show>
    </>
  )
}
