import { Show, createEffect, createSignal, createUniqueId, onCleanup } from 'solid-js'
import { ProductButton, ProductField, ProductSelect, ProductTextInput } from './controls.js'
import { ProductDialog, ProductErrorBanner } from './messages.js'
import { useProductStrings } from './strings.js'

/** Mount only while open. contextKey identifies both account and host. */
export function ProductSecretDialog(props: {
  name: string
  contextKey: string
  canManageDeployment: boolean
  onSave: (value: string, scope: 'account' | 'deployment') => Promise<void>
  onSaved: () => void
  onCancel: () => void
}) {
  const strings = useProductStrings()
  const formId = createUniqueId()
  const [value, setValue] = createSignal('')
  const [scope, setScope] = createSignal<'account' | 'deployment'>('account')
  const [pending, setPending] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
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
    setFailed(false)
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
    setFailed(false)
    try {
      await props.onSave(value(), scope())
      if (attempt !== generation) return
      clear()
      props.onSaved()
    } catch {
      // Neither server responses nor exceptions may echo a credential here.
      if (attempt === generation) setFailed(true)
    } finally {
      if (attempt === generation) setPending(false)
    }
  }
  return (
    <ProductDialog title={strings.setSecretTitle.replace('{name}', props.name)} onDismiss={cancel} pending={pending()} size="confirmation"
      action={<ProductButton type="submit" form={formId} fill="solid" disabled={value().length === 0} pending={pending()}>
        {pending() ? strings.secretSaving : failed() ? strings.tryAgain : strings.secretSave}
      </ProductButton>}>
      <form id={formId} class="dinkster-stack" autocomplete="off" noValidate onSubmit={save} aria-busy={pending()}>
        <Show when={failed()}>
          <ProductErrorBanner onDismiss={() => setFailed(false)}>{strings.secretSaveFailed}</ProductErrorBanner>
        </Show>
        <p class="dinkster-description">{strings.secretHostOnly}</p>
        <ProductField label={strings.secretScope}>
          {(attributes) => <ProductSelect {...attributes} value={scope()} disabled={pending()} onChange={(event) => {
            setScope(event.currentTarget.value === 'deployment' && props.canManageDeployment ? 'deployment' : 'account')
          }}>
            <option value="account">{strings.secretAccountScope}</option>
            <Show when={props.canManageDeployment}><option value="deployment">{strings.secretDeploymentScope}</option></Show>
          </ProductSelect>}
        </ProductField>
        <ProductField label={strings.secretValue}>
          {(attributes) => <ProductTextInput {...attributes} ref={input} type="password" autocomplete="off" spellcheck={false}
            value={value()} disabled={pending()} onInput={(event) => setValue(event.currentTarget.value)} />}
        </ProductField>
      </form>
    </ProductDialog>
  )
}
