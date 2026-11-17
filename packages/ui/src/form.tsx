import { Show, createMemo, createSignal, type JSX } from 'solid-js'
import { ProductButton } from './controls.js'
import { ProductErrorBanner } from './messages.js'

export interface ProductFormState<T extends Record<string, string>> {
  values: () => T
  setValue: <K extends keyof T>(key: K, value: T[K]) => void
  dirty: () => boolean
  pending: () => boolean
}

export function ProductForm<T extends Record<string, string>>(props: {
  initialValues: T
  onSave: (values: T) => Promise<void>
  children: (state: ProductFormState<T>) => JSX.Element
}) {
  const [baseline, setBaseline] = createSignal({ ...props.initialValues })
  const [values, setValues] = createSignal({ ...props.initialValues })
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal(false)
  const dirty = createMemo(() =>
    Object.keys(baseline()).some((key) => values()[key] !== baseline()[key]),
  )
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!dirty() || pending()) return
    const snapshot = { ...values() }
    setPending(true)
    try {
      await props.onSave(snapshot)
      setBaseline(() => snapshot)
      setError(false)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }
  return (
    <form class="dinkster-stack" onSubmit={save} aria-busy={pending()}>
      <Show when={error()}>
        <ProductErrorBanner onDismiss={() => setError(false)}>
          Changes could not be saved. Try again.
        </ProductErrorBanner>
      </Show>
      {props.children({
        values,
        setValue: (key, value) =>
          setValues((current) => ({ ...current, [key]: value })),
        dirty,
        pending,
      })}
      <div class="dinkster-actions">
        <ProductButton
          type="submit"
          intent="add"
          fill="solid"
          disabled={!dirty()}
          loading={pending()}
        >
          Save
        </ProductButton>
        <ProductButton
          disabled={!dirty() || pending()}
          onClick={() => setValues(() => ({ ...baseline() }))}
        >
          Undo changes
        </ProductButton>
      </div>
    </form>
  )
}
