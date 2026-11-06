import { createSignal, onCleanup, Show } from 'solid-js'
import { PackInstallError, type PackInstallPlan } from '@dinkster/client'
import type { AppState } from './app-state.js'
import type { CatalogNode } from './node-catalog.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductButton } from './ProductControls.js'
import { SchemaPreview } from './SchemaPreview.js'
import { useAppMessage } from './locale.js'

export function NodeInstallPrompt(props: { readonly app: AppState; readonly request: CatalogNode & { readonly backendId: string } }) {
  const message = useAppMessage()
  const [plan, setPlan] = createSignal<PackInstallPlan>()
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal('')
  const [applied, setApplied] = createSignal(false)
  let disposed = false
  onCleanup(() => { disposed = true })
  const close = () => { props.app.nodeInstallRequest.set(undefined) }
  const backend = () => {
    const tab = props.app.activeTab()
    const current = tab === undefined ? undefined : props.app.backendForTab(tab)
    if (current?.id !== props.request.backendId || props.app.nodeInstallRequest.get() !== props.request) {
      throw new Error(message('search.installBackendChanged'))
    }
    return current
  }
  const failure = (error: unknown) => {
    if (!disposed) setStatus(error instanceof PackInstallError && error.status === 404
      ? message('search.installUnavailable') : error instanceof Error ? error.message : String(error))
  }
  const review = async () => {
    if (busy() || applied()) return
    setBusy(true); setPlan(undefined); setStatus('')
    try {
      const target = backend()
      const result = await target.connection.planPackInstall([{ pack: props.request.pack.name, version: props.request.pack.version }])
      backend()
      if (!disposed) setPlan(result)
    } catch (error) { failure(error) }
    finally { if (!disposed) setBusy(false) }
  }
  const install = async () => {
    const confirmed = plan()
    if (busy() || applied() || confirmed === undefined) return
    setBusy(true); setPlan(undefined); setStatus('')
    try {
      const target = backend()
      await target.connection.applyPackInstall(confirmed.confirmation)
      if (disposed) return
      setApplied(true)
      await props.app.refreshBackendSchemas(target)
      backend()
      if (!disposed) setStatus(target.registry.get()?.resolve(props.request.schema.type) === undefined
        ? message('search.installRefreshPending') : message('search.installComplete'))
    } catch (error) { failure(error) }
    finally { if (!disposed) setBusy(false) }
  }
  return <ModalSurface title={message('search.installTitle')} modalId="node-install" dismissBlocked={busy()} onRequestClose={close}>
    <div class="search-result-preview">
      <h2>{props.request.schema.displayName}</h2>
      <p>{props.request.pack.displayName} - {props.request.pack.version} - {message(applied() ? 'search.installed' : 'search.notInstalled')}</p>
      <SchemaPreview schema={props.request.schema} widgets={props.app.widgetRegistryForTab(props.app.activeTab())} />
      <p>{props.request.schema.description}</p>
      <dl><div><dt>{message('search.platforms')}</dt><dd>{props.request.pack.platforms.join(', ')}</dd></div></dl>
      <Show when={!applied()}><p>{message('search.installRequired')}</p></Show>
      <Show when={plan()} keyed>{(value) => <>
        <pre class="node-install-review">{value.review}</pre>
        <ProductButton variant="primary" disabled={busy()} onClick={() => { void install() }}>{message('search.installConfirm')}</ProductButton>
      </>}</Show>
      <Show when={!applied()}><ProductButton disabled={busy()} onClick={() => { void review() }}>{message('search.installReview')}</ProductButton></Show>
      <p role="status">{busy() ? message('search.installWorking') : status()}</p>
      <ProductButton disabled={busy()} onClick={close}>{message('search.close')}</ProductButton>
    </div>
  </ModalSurface>
}
