import { Show, createEffect, createMemo, createSignal, createUniqueId, onCleanup } from 'solid-js'
import { ProductButton, ProductField, ProductTextInput } from './controls.js'
import { ProductSelect } from './select.js'
import { ProductConfirmation, ProductDialog, ProductErrorBanner } from './messages.js'
import { useProductStrings } from './strings.js'

/** Mount only while open. contextKey identifies both account and machine. */
export function ProductSecretDialog(props: {
  name: string
  names: readonly string[]
  contextKey: string
  canManageDeployment: boolean
  onRead: (name: string) => Promise<{ set: boolean; source: 'account' | 'deployment' | null; fallback: boolean }>
  /** Return a safe engine refusal reason; thrown exceptions are never displayed. */
  onSave: (value: string, scope: 'account' | 'deployment', name: string) => Promise<void | string>
  onUse: (name: string) => Promise<void>
  onRemove: (name: string) => Promise<void>
  onSaved: () => void
  onCancel: () => void
}) {
  const strings = useProductStrings()
  const formId = createUniqueId()
  const [name, setName] = createSignal(props.name)
  const [nameEdited, setNameEdited] = createSignal(false)
  const [value, setValue] = createSignal('')
  const [scope, setScope] = createSignal<'account' | 'deployment'>('account')
  const [pending, setPending] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [presence, setPresence] = createSignal<{ set: boolean; source: 'account' | 'deployment' | null; fallback: boolean }>()
  let generation = 0
  let input: HTMLInputElement | undefined
  const validName = () => name().length <= 128 && /^[A-Za-z_]/.test(name()) && !/[^A-Za-z0-9_.-]/.test(name())
  const nameError = () => !validName() && (nameEdited() || name() !== '') ? strings.secretNameInvalid : undefined
  const useSaved = () => value().length === 0 && presence()?.set === true && name() !== props.name
  const canSave = () => validName() && (value().length > 0 || useSaved())
  const clear = () => {
    setValue('')
    if (input) input.value = ''
  }
  const context = createMemo(() => [props.contextKey, props.name, props.canManageDeployment] as const,
    undefined, { equals: (before, after) => before.every((value, index) => value === after[index]) })
  createEffect(() => {
    context()
    generation++
    clear()
    setName(props.name)
    setNameEdited(false)
    setScope('account')
    setPending(false)
    setRemoving(false)
    setFailure(undefined)
  })
  createEffect(() => {
    const chosen = name()
    setPresence(undefined)
    if (!validName()) return
    let live = true
    onCleanup(() => { live = false })
    void props.onRead(chosen).then((answer) => {
      if (live) setPresence(answer)
    }).catch(() => {
      if (live) setFailure(strings.secretAccessFailed)
    })
  })
  onCleanup(() => { generation++; clear() })
  const cancel = () => {
    if (pending()) return
    clear()
    props.onCancel()
  }
  const save = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!canSave() || pending()) return
    const attempt = generation
    setPending(true)
    setFailure(undefined)
    try {
      const reason = useSaved() ? await props.onUse(name()) : await props.onSave(value(), scope(), name())
      if (attempt !== generation) return
      if (typeof reason === 'string') {
        setFailure(reason ? `${strings.secretSaveFailed} ${reason}` : strings.secretSaveFailed)
        return
      }
      clear()
      props.onSaved()
    } catch {
      if (attempt === generation) setFailure(strings.secretSaveFailed)
    } finally {
      if (attempt === generation) setPending(false)
    }
  }
  const remove = async () => {
    if (pending() || presence()?.source !== 'account') return
    const attempt = generation
    setPending(true)
    setFailure(undefined)
    try {
      await props.onRemove(name())
      if (attempt === generation) props.onSaved()
    } catch {
      if (attempt === generation) setFailure(strings.secretRemoveFailed)
    } finally {
      if (attempt === generation) setPending(false)
    }
  }
  return (
    <ProductDialog title={removing() ? strings.removeSecretTitle.replace('{name}', name()) : strings.setSecretTitle} onDismiss={cancel} pending={pending()} size="confirmation"
      secondaryAction={removing() || presence()?.source !== 'account' || scope() !== 'account' ? undefined :
        <ProductButton data-remove-on-hover disabled={pending()} onClick={() => {
          clear()
          setFailure(undefined)
          setRemoving(true)
        }}>{strings.secretRemove}</ProductButton>}
      action={removing() ? undefined : <ProductButton type="submit" form={formId} fill="solid" disabled={!canSave()} pending={pending()}>
        {pending() ? strings.secretSaving : failure() !== undefined ? strings.tryAgain : useSaved() ? strings.secretUse : strings.secretSave}
      </ProductButton>}>
      <Show when={removing()} fallback={<form id={formId} class="dinkster-stack" autocomplete="off" noValidate onSubmit={save} aria-busy={pending()}>
        <Show when={failure()}>
          <ProductErrorBanner onDismiss={() => setFailure(undefined)}>{failure()}</ProductErrorBanner>
        </Show>
        <ProductField label={strings.secretName} {...(nameError() === undefined ? {} : { error: nameError()! })}>
          {(attributes) => <ProductSelect {...attributes} editable autofocus={props.name === ''}
            value={name()} disabled={pending()} placeholder={strings.secretNamePlaceholder}
            options={props.names.map((value) => ({ value, label: value }))}
            onChange={(value) => { setNameEdited(true); setName(value); setFailure(undefined) }} />}
        </ProductField>
        <Show when={props.canManageDeployment}>
          <ProductField label={strings.secretScope}>
            {(attributes) => <ProductSelect {...attributes} value={scope()} disabled={pending()}
              options={[
                { value: 'account', label: strings.secretAccountScope },
                { value: 'deployment', label: strings.secretDeploymentScope },
              ]}
              onChange={(value) => setScope(value === 'deployment' ? 'deployment' : 'account')} />}
          </ProductField>
        </Show>
        <ProductField label={strings.secretValue}>
          {(attributes) => <ProductTextInput {...attributes} ref={input} type="password" autofocus={props.name !== ''} autocomplete="off" spellcheck={false}
            placeholder={presence()?.set ? strings.secretKeepValue : undefined}
            value={value()} disabled={pending()} onInput={(event) => setValue(event.currentTarget.value)} />}
        </ProductField>
      </form>}>
        <ProductConfirmation surface="inherit" consequence={presence()?.fallback ? strings.secretRemoveFallback : strings.secretRemoveMissing}
          actionLabel={strings.secretRemoveConfirm} intent="remove" pending={pending()} error={failure()}
          onCancel={() => { if (!pending()) { setFailure(undefined); setRemoving(false) } }}
          onConfirm={() => { void remove() }} />
      </Show>
    </ProductDialog>
  )
}
