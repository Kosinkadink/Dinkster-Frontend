import { Show, createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js'
import { ProductButton, ProductField, ProductSelect, ProductTextInput } from './controls.js'
import { ProductDialog, ProductErrorBanner } from './messages.js'
import { useProductStrings } from './strings.js'

/** Mount only while open. contextKey identifies both account and host. */
export function ProductSecretDialog(props: {
  name: string
  contextKey: string
  canManageDeployment: boolean
  /** Return a safe engine refusal reason; thrown exceptions are never displayed. */
  onSave: (value: string, scope: 'account' | 'deployment') => Promise<void | string>
  onSaved: () => void
  onCancel: () => void
}) {
  const strings = useProductStrings()
  const formId = createUniqueId()
  const [value, setValue] = createSignal('')
  const [scope, setScope] = createSignal<'account' | 'deployment'>('account')
  const [pending, setPending] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  let generation = 0
  let input: HTMLInputElement | undefined
  const clear = () => {
    setValue('')
    if (input) input.value = ''
  }
  createEffect(() => {
    props.contextKey
    props.name
    props.canManageDeployment
    generation++
    clear()
    setScope('account')
    setPending(false)
    setFailure(undefined)
  })
  onCleanup(() => {
    generation++
    clear()
  })
  const cancel = () => {
    if (pending()) return
    clear()
    props.onCancel()
  }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (value().length === 0 || pending()) return
    const attempt = generation
    setPending(true)
    setFailure(undefined)
    try {
      const reason = await props.onSave(value(), scope())
      if (attempt !== generation) return
      if (typeof reason === 'string') {
        setFailure(reason ? `${strings.secretSaveFailed} ${reason}` : strings.secretSaveFailed)
        return
      }
      clear()
      props.onSaved()
    } catch {
      // Neither server responses nor exceptions may echo a credential here.
      if (attempt === generation) setFailure(strings.secretSaveFailed)
    } finally {
      if (attempt === generation) setPending(false)
    }
  }
  return (
    <ProductDialog title={strings.setSecretTitle.replace('{name}', props.name)} onDismiss={cancel} pending={pending()} size="confirmation"
      action={<ProductButton type="submit" form={formId} fill="solid" disabled={value().length === 0} pending={pending()}>
        {pending() ? strings.secretSaving : failure() !== undefined ? strings.tryAgain : strings.secretSave}
      </ProductButton>}>
      <form id={formId} class="dinkster-stack" autocomplete="off" noValidate onSubmit={save} aria-busy={pending()}>
        <Show when={failure()}>
          <ProductErrorBanner onDismiss={() => setFailure(undefined)}>{failure()}</ProductErrorBanner>
        </Show>
        <Show when={props.canManageDeployment}>
          <ProductField label={strings.secretScope}>
            {(attributes) => <ProductSelect {...attributes} value={scope()} disabled={pending()} onChange={(event) => {
              setScope(event.currentTarget.value === 'deployment' ? 'deployment' : 'account')
            }}>
              <option value="account">{strings.secretAccountScope}</option>
              <option value="deployment">{strings.secretDeploymentScope}</option>
            </ProductSelect>}
          </ProductField>
        </Show>
        <ProductField label={strings.secretValue}>
          {(attributes) => <ProductTextInput {...attributes} ref={input} type="password" autocomplete="off" spellcheck={false}
            value={value()} disabled={pending()} onInput={(event) => setValue(event.currentTarget.value)} />}
        </ProductField>
      </form>
    </ProductDialog>
  )
}
