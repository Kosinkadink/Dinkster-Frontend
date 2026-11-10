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
  const [commandsCopied, setCommandsCopied] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [status, setStatus] = createSignal(props.app.nodeInstallUncertain.has(props.request.backendId) ? message('search.installUnknown') : '')
  const [applied, setApplied] = createSignal(false)
  const [uncertain, updateUncertain] = createSignal(props.app.nodeInstallUncertain.has(props.request.backendId))
  const setUncertain = (value: boolean) => {
    if (value) props.app.nodeInstallUncertain.set(props.request.backendId, props.request.schema.type)
    else props.app.nodeInstallUncertain.delete(props.request.backendId)
    updateUncertain(value)
  }
  let controller: AbortController | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let expiresAt = 0
  let disposed = false
  onCleanup(() => { disposed = true; controller?.abort(); clearTimeout(expiryTimer) })
  const close = () => { props.app.nodeInstallRequest.set(undefined) }
  const expire = () => {
    setPlan(undefined)
    setStatus(message('search.installExpired'))
  }
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
    if (busy() || applied() || uncertain()) return
    controller = new AbortController()
    clearTimeout(expiryTimer)
    setCommandsCopied(false)
    setBusy(true); setPlan(undefined); setStatus('')
    try {
      const target = backend()
      const started = Date.now()
      const result = await target.connection.planPackInstall([{ pack: props.request.pack.name, version: props.request.pack.version }], controller.signal)
      backend()
      if (!disposed) {
        expiresAt = started + result.expiresInSeconds * 1000
        if (Date.now() >= expiresAt) expire()
        else {
          setPlan(result)
          expiryTimer = setTimeout(expire, Math.min(expiresAt - Date.now(), 2_147_483_647))
        }
      }
    } catch (error) { failure(error) }
    finally { if (!disposed) setBusy(false) }
  }
  const install = async () => {
    const confirmed = plan()
    if (busy() || applied() || uncertain() || confirmed?.confirmation === undefined) return
    if (Date.now() >= expiresAt) { expire(); return }
    clearTimeout(expiryTimer)
    controller = new AbortController()
    setBusy(true); setPlan(undefined); setStatus('')
    try {
      const target = backend()
      setUncertain(true)
      await target.connection.applyPackInstall(confirmed.confirmation, controller.signal)
      if (disposed) return
      setUncertain(false)
      setApplied(true)
      await props.app.refreshBackendSchemas(target)
      backend()
      if (!disposed) setStatus(target.registry.get()?.resolve(props.request.schema.type) === undefined
        ? message('search.installRefreshPending') : message('search.installComplete'))
    } catch (error) {
      if (!disposed) {
        const rejected = error instanceof PackInstallError && (
          [400, 401, 403, 404].includes(error.status)
          || (error.status === 409 && ['invalid-confirmation', 'plan-stale', 'install-in-progress', 'composition-in-progress'].includes(String(error.body?.['error']))))
        if (rejected) setUncertain(false)
        if (uncertain()) setStatus(message('search.installUnknown'))
        else failure(error)
      }
    }
    finally { if (!disposed) setBusy(false) }
  }
  const copyCommands = async (reviewed: PackInstallPlan) => {
    if (reviewed.commands === undefined || plan() !== reviewed) return
    if (Date.now() >= expiresAt) { expire(); return }
    setCommandsCopied(false); setStatus('')
    try {
      backend()
      let copied = true
      try { await navigator.clipboard.writeText(reviewed.commands.join('\n')) }
      catch { copied = false }
      backend()
      if (!disposed && plan() === reviewed) {
        if (copied) setCommandsCopied(true)
        else setStatus(message('search.installCopyFailed'))
      }
    } catch (error) {
      if (!disposed && plan() === reviewed) {
        setPlan(undefined); clearTimeout(expiryTimer)
        failure(error)
      }
    }
  }
  const refresh = async () => {
    if (busy()) return
    setBusy(true)
    try {
      const target = backend()
      await props.app.refreshBackendSchemas(target)
      backend()
      const pendingType = props.app.nodeInstallUncertain.get(props.request.backendId) ?? props.request.schema.type
      if (!disposed && target.schemaState.get().status === 'ready' && target.registry.get()?.resolve(pendingType) !== undefined) {
        setUncertain(false)
        const installed = target.registry.get()?.resolve(props.request.schema.type) !== undefined
        setApplied(installed); setStatus(installed ? message('search.installComplete') : '')
        if (installed) { setPlan(undefined); clearTimeout(expiryTimer) }
      }
    } catch (error) { failure(error) }
    finally { if (!disposed) setBusy(false) }
  }
  return <ModalSurface title={message('search.installTitle')} modalId="node-install" onRequestClose={close}>
    <div class="search-result-preview">
      <h2>{props.request.schema.displayName}</h2>
      <p>{props.request.pack.displayName} - {props.request.pack.version} - {message(uncertain() ? 'search.installUnknownTitle' : applied() ? 'search.installed' : 'search.notInstalled')}</p>
      <SchemaPreview schema={props.request.schema} widgets={props.app.widgetRegistryForTab(props.app.activeTab())} />
      <p>{props.request.schema.description}</p>
      <dl><div><dt>{message('search.platforms')}</dt><dd>{props.request.pack.platforms.join(', ')}</dd></div></dl>
      <Show when={!applied() && !uncertain()}><p>{message('search.installRequired')}</p></Show>
      <Show when={plan()} keyed>{(value) => <>
        <pre class="node-install-review">{value.review}</pre>
        <Show when={value.commands} fallback={
          <ProductButton variant="primary" disabled={busy()} onClick={() => { void install() }}>{message('search.installConfirm')}</ProductButton>
        }>{(commands) => <>
          <p>{message('search.installTerminalHint')}</p>
          <pre class="node-install-review" data-testid="node-install-commands">{commands().join('\n')}</pre>
          <ProductButton disabled={busy()} onClick={() => { void copyCommands(value) }}>{message(commandsCopied() ? 'search.installCopied' : 'search.installCopyCommands')}</ProductButton>
        </>}</Show>
      </>}</Show>
      <Show when={!applied() && !uncertain()}><ProductButton disabled={busy()} onClick={() => { void review() }}>{message('search.installReview')}</ProductButton></Show>
      <Show when={(uncertain() || plan()?.commands !== undefined) && !busy()}><ProductButton onClick={() => { void refresh() }}>{message('search.installRefresh')}</ProductButton></Show>
      <p role="status">{busy() ? message('search.installWorking') : status()}</p>
      <Show when={busy() && uncertain()}><p>{message('search.installCancelWarning')}</p></Show>
      <ProductButton onClick={close}>{message(busy() ? 'search.installCancelWaiting' : 'search.close')}</ProductButton>
    </div>
  </ModalSurface>
}
