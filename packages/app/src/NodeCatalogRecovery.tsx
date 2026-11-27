import { createResource, createSignal, onCleanup, Show } from 'solid-js'
import { ProductLoading, ProductRecoveryNotice } from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { activeProjectId } from './projects.js'
import { useAppMessage } from './locale.js'

export function NodeCatalogRecovery(props: {
  readonly app: AppState
  readonly backend: Backend
}) {
  const message = useAppMessage()
  const projectId = activeProjectId()
  const controller = new AbortController()
  onCleanup(() => controller.abort())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [facts] = createResource(async () => {
    const needs = await props.backend.connection.projectNeeds(projectId, controller.signal)
    if (needs.hasInstalledNodes === undefined) throw new Error(message('catalog.factsUnavailable'))
    return needs
  })
  const current = () => !controller.signal.aborted && activeProjectId() === projectId &&
    props.app.backends.get().includes(props.backend)
  const enable = async () => {
    const value = facts()
    if (!value || value.canWrite !== true || busy() || !current()) return
    setBusy(true)
    setError(undefined)
    try {
      const project = await props.backend.connection.getProject(projectId, controller.signal)
      if (!current()) return
      await props.backend.connection.enableAllInstalledProjectPacks(projectId, project.revision, controller.signal)
      if (!current()) return
      await props.app.refreshBackendSchemas(props.backend)
      const state = props.backend.schemaState.get()
      if (state.status === 'error') throw new Error(state.message)
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : String(cause))
    } finally { if (current()) setBusy(false) }
  }
  return <Show when={!facts.loading} fallback={<ProductLoading label={message('catalog.loading')} />}>
    <Show when={facts.error === undefined} fallback={<p class="dinkster-field-error" role="alert">{String(facts.error)}</p>}>
      <Show when={facts()}>{(value) => <ProductRecoveryNotice
        message={message(value().hasInstalledNodes ? 'catalog.noneEnabled' : 'catalog.noneInstalled')}
        {...(value().canWrite !== true ? {} : { action: {
          label: message(value().hasInstalledNodes ? 'catalog.enableAll' : 'catalog.setup'),
          pending: busy(),
          onSelect: () => { if (value().hasInstalledNodes) void enable(); else props.app.nodeCatalogSetupRequested.set(true) },
        } })}
        {...(error() === undefined ? {} : { error: error()! })}
      />}</Show>
    </Show>
  </Show>
}
