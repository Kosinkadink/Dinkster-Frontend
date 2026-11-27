import { formatByteSize, parseByteSize } from '@dinkster/core'
import {
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  splitProps,
  type ComponentProps,
} from 'solid-js'
import { CircleAlert } from 'lucide-solid'
import { ProductIcon, ProductTextInput } from './controls.js'
import { useProductStrings } from './strings.js'

export function ProductByteSizeInput(
  props: Omit<
    ComponentProps<typeof ProductTextInput>,
    'value' | 'onInput' | 'onChange' | 'onBlur' | 'onKeyDown' | 'ref'
  > & {
    readonly value: number
    readonly onCommit: (bytes: number) => void
    readonly minimum?: number | undefined
    readonly error?: string | undefined
  },
) {
  const [local, input] = splitProps(props, [
    'value',
    'onCommit',
    'minimum',
    'error',
    'disabled',
    'aria-describedby',
    'aria-invalid',
  ])
  const strings = useProductStrings()
  const errorId = `${createUniqueId()}-size-error`
  const [draft, setDraft] = createSignal('')
  const [invalid, setInvalid] = createSignal<string>()
  let unchanged = ''
  const restore = () => {
    unchanged = formatByteSize(local.value, 'GB')
    setDraft(unchanged)
    setInvalid(undefined)
  }
  createEffect(() => {
    local.value
    local.disabled
    local.error
    restore()
  })
  const commit = () => {
    if (local.disabled || draft() === unchanged) return
    const bytes = parseByteSize(draft())
    if (bytes === undefined) {
      setInvalid(strings.byteSizeInvalid)
      return
    }
    if (bytes < (local.minimum ?? 0)) {
      setInvalid(
        strings.byteSizeMinimum.replace(
          '{size}',
          formatByteSize(local.minimum ?? 0),
        ),
      )
      return
    }
    unchanged = formatByteSize(bytes, 'GB')
    setDraft(unchanged)
    setInvalid(undefined)
    if (bytes !== local.value) local.onCommit(bytes)
  }
  const error = () => invalid() || local.error
  return (
    <div class="dinkster-stack">
      <ProductTextInput
        {...input}
        disabled={local.disabled}
        value={draft()}
        aria-invalid={error() ? 'true' : local['aria-invalid']}
        aria-describedby={
          [local['aria-describedby'], error() ? errorId : undefined]
            .filter(Boolean)
            .join(' ') || undefined
        }
        onInput={(event) => {
          setDraft(event.currentTarget.value)
          setInvalid(undefined)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.isComposing) return
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            restore()
          }
        }}
      />
      <Show when={error()}>
        {(message) => (
          <p id={errorId} class="dinkster-field-error" role="alert">
            <ProductIcon icon={CircleAlert} />
            {message()}
          </p>
        )}
      </Show>
    </div>
  )
}
