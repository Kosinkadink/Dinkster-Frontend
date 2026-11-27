import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import type { AccountProjectChoices, AccountStatus, DinksterConnection, LibraryProject } from '@dinkster/client'
import { ProductButton, ProductConfirmation, ProductDialog, ProductErrorBanner, ProductField, ProductLoading, ProductNotice, ProductSelect } from '@dinkster/ui'
import { useAppMessage } from './locale.js'

type AccountProjectConnection = Pick<DinksterConnection, 'getProject' | 'accountStatus' | 'accountProjects' | 'setProjectAccountLink'>

export function ProjectAccountLink(props: {
  readonly connection: AccountProjectConnection
  readonly projectId: string
  readonly onClose: () => void
  readonly onSaved: (project: LibraryProject) => void
}) {
  const message = useAppMessage()
  const currentConnection = createMemo(() => props.connection)
  const currentId = createMemo(() => props.projectId)
  const [project, setProject] = createSignal<LibraryProject>()
  const [status, setStatus] = createSignal<AccountStatus>()
  const [choices, setChoices] = createSignal<AccountProjectChoices>()
  const [selection, setSelection] = createSignal('')
  const [loading, setLoading] = createSignal(true)
  const [saving, setSaving] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  const [error, setError] = createSignal(false)
  const [reload, setReload] = createSignal(0)
  let lifetime: AbortController | undefined

  createEffect(() => {
    reload()
    const connection = currentConnection()
    const id = currentId()
    const controller = new AbortController()
    lifetime = controller
    onCleanup(() => controller.abort())
    setProject(undefined)
    setStatus(undefined)
    setChoices(undefined)
    setSelection('')
    setRemoving(false)
    setLoading(true)
    setSaving(false)
    setError(false)
    void (async () => {
      try {
        const [record, account] = await Promise.all([connection.getProject(id, controller.signal), connection.accountStatus(controller.signal)])
        const listed = account.available && account.signedIn && account.signIn !== 'pending'
          ? await connection.accountProjects(controller.signal) : undefined
        if (controller.signal.aborted) return
        setProject(record)
        setStatus(account)
        setChoices(listed)
        const link = record.accountProject
        setSelection(link && link.issuer === listed?.issuer && listed.projects.some((item) => item.id === link.id) ? link.id : '')
      } catch {
        if (!controller.signal.aborted) setError(true)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
  })

  const save = async (accountProject: string | null): Promise<void> => {
    const record = project()
    const controller = lifetime
    if (!record || loading() || saving() || !controller || controller.signal.aborted) return
    const connection = props.connection
    setSaving(true)
    setError(false)
    try {
      const current = await connection.getProject(record.id, controller.signal)
      if (controller.signal.aborted) return
      if (!record.uid || current.uid !== record.uid || current.revision !== record.revision) throw new Error('Project changed')
      const saved = await connection.setProjectAccountLink(record.id, accountProject, record.revision, controller.signal)
      if (!controller.signal.aborted) props.onSaved(saved)
    } catch {
      if (!controller.signal.aborted) {
        setError(true)
        if (!removing()) setProject(undefined)
      }
    } finally {
      if (!controller.signal.aborted) setSaving(false)
    }
  }
  const changed = () => {
    const link = project()?.accountProject
    return selection() !== '' && (link?.id !== selection() || link.issuer !== choices()?.issuer)
  }

  // The nested dialog must not trigger the Projects dialog's backdrop or shortcuts.
  return <div onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><ProductDialog title={message('projectAccount.title')} pending={saving()} onDismiss={props.onClose}
    action={!loading() && !removing() && choices()?.projects.length
      ? <ProductButton intent="add" fill="solid" pending={saving()} disabled={!changed() || !project()?.uid} onClick={() => { void save(selection()) }}>{message('projectAccount.save')}</ProductButton>
      : undefined}>
    <Show when={error() && !removing()}><ProductErrorBanner onDismiss={() => setError(false)}>{message('projectAccount.error')}</ProductErrorBanner></Show>
    <Show when={loading()} fallback={<>
      <Show when={project()}>{(record) => <>
        <p class="dinkster-description">{message('projectAccount.project', { name: record().name })}</p>
        <ProductNotice>{message('projectAccount.notice')}</ProductNotice>
        <Show when={record().accountProject} fallback={<p class="dinkster-description">{message('projectAccount.unlinked')}</p>}>
          {(link) => <div class="dinkster-stack"><p class="dinkster-description">{message('projectAccount.current')}</p><p class="dinkster-metadata">{link().issuer}</p><p class="dinkster-metadata">{link().id}</p></div>}
        </Show>
        <Show when={removing()} fallback={<>
          <Show when={status()?.signedIn && status()?.signIn !== 'pending'} fallback={<ProductNotice>{message('projectAccount.signIn')}</ProductNotice>}>
            <Show when={choices()?.projects.length} fallback={<ProductNotice>{message('projectAccount.empty')}</ProductNotice>}>
              <ProductField label={message('projectAccount.choice')}>{(attributes) =>
                <ProductSelect {...attributes} value={selection()} disabled={saving()} onChange={setSelection}
                  options={[{ value: '', label: message('projectAccount.choose'), disabled: true }, ...(choices()?.projects ?? []).map((item) => ({ value: item.id, label: item.displayName ?? item.id }))]} />
              }</ProductField>
            </Show>
          </Show>
          <div class="dinkster-actions">
            <Show when={record().accountProject}><ProductButton intent="remove" disabled={saving() || !record().uid} onClick={() => setRemoving(true)}>{message('projectAccount.unlink')}</ProductButton></Show>
          </div>
        </>}>
          <ProductConfirmation title={message('projectAccount.unlinkTitle', { name: record().name })} consequence={message('projectAccount.unlinkNotice')} error={error() ? message('projectAccount.error') : undefined} actionLabel={message('projectAccount.unlink')} intent="remove" pending={saving()} onCancel={() => { setError(false); setRemoving(false) }} onConfirm={() => { void save(null) }} />
        </Show>
      </>}</Show>
      <div class="dinkster-actions"><ProductButton disabled={saving()} onClick={() => setReload((value) => value + 1)}>{message('projectAccount.refresh')}</ProductButton></div>
    </>}><ProductLoading label={message('projectAccount.loading')} /></Show>
  </ProductDialog></div>
}
