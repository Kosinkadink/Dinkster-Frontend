import { Show, createMemo, createSignal, type JSX } from 'solid-js'
import { ProductButton } from './controls.js'
import { ProductErrorBanner } from './messages.js'
import { useProductStrings } from './strings.js'

export type ProductFormValues = Record<string, string | boolean>

/** The editable shape of initial values: an initial `false` is a boolean
 * field, not a field that can only hold `false`. */
export type ProductFormFields<I extends ProductFormValues> = {
  [K in keyof I]: I[K] extends boolean ? boolean : string
}

export interface ProductFormState<T> {
  values: () => T
  setValue: <K extends keyof T>(key: K, value: T[K]) => void
  dirty: () => boolean
  pending: () => boolean
}

export function ProductForm<I extends ProductFormValues>(props: {
  initialValues: I
  /** Resolve to save. Resolve `false` to keep the edits without the general
   * error, when the caller shows the reason under a field. Reject for a
   * failure that belongs to no field. */
  onSave: (values: ProductFormFields<I>) => Promise<void | false>
  children: (state: ProductFormState<ProductFormFields<I>>) => JSX.Element
}) {
  type T = ProductFormFields<I>
  const strings = useProductStrings()
  const initial = () => ({ ...props.initialValues }) as unknown as T
  const [baseline, setBaseline] = createSignal(initial())
  const [values, setValues] = createSignal(initial())
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
      if ((await props.onSave(snapshot)) === false) return
      setBaseline(() => snapshot)
      setError(false)
    } catch {
      setError(true)
    } finally {
      setPending(false)
    }
  }
  return (
    // Field problems are shown by ProductField, not the browser's own bubble.
    <form
      class="dinkster-stack"
      noValidate
      onSubmit={save}
      aria-busy={pending()}
    >
      <Show when={error()}>
        <ProductErrorBanner onDismiss={() => setError(false)}>
          {strings.saveFailed}
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
          fill="solid"
          disabled={!dirty()}
          pending={pending()}
        >
          {strings.save}
        </ProductButton>
        <ProductButton
          disabled={!dirty() || pending()}
          onClick={() => setValues(() => ({ ...baseline() }))}
        >
          {strings.undoChanges}
        </ProductButton>
      </div>
    </form>
  )
}
