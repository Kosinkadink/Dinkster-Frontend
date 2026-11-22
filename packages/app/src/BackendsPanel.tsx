import { createSignal, For, Show } from 'solid-js'
import { ProductButton, ProductConfirmation, ProductDisclosure, ProductErrorBanner, ProductMenu, ProductNotice } from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { backendConnectionStatus, canonicalBackendUrl } from './app-state.js'
import { ConnectionProfilesSection } from './ConnectionProfiles.js'
import { useAppMessage } from './locale.js'
import { ProductField, productFieldIds } from './ProductForm.js'
import { ProductTextInput } from './ProductControls.js'
import { ProductPanelHeader } from './ProductSurfaces.js'
import { useSignal } from './solid-adapter.js'

function BackendRow(props: {
  readonly app: AppState
  readonly backend: Backend
  readonly defaultBackend: Backend
  readonly activeBackendId?: string | undefined
  readonly tick: () => number
  readonly onOpenStorage?: ((backend: Backend) => void) | undefined
  readonly onOpenResources?: ((backend: Backend) => void) | undefined
  readonly onOpenSettings?: ((backend: Backend) => void) | undefined
}) {
  const message = useAppMessage()
  const [busy, setBusy] = createSignal(false)
  const [removing, setRemoving] = createSignal(false)
  const [error, setError] = createSignal('')
  const status = () => { props.tick(); return backendConnectionStatus(props.backend) }
  const registry = () => { props.tick(); return props.backend.registry.get() }
  const schemaState = () => { props.tick(); return props.backend.schemaState.get() }
  const supervisor = () => { props.tick(); return props.backend.supervisor.get() }
  const perform = async (action: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const title = () => `${message(`backendsPanel.connection.${status()}`)} - ${props.backend.label} - ${message(props.backend.protocol === 'dinkster' ? 'backendsPanel.protocol.dinkster' : 'backendsPanel.protocol.comfyUi')}${registry() ? `, ${message('backendsPanel.schema.available', { count: registry()!.schemas.size })}` : ''}`
  return <article class="backend-server" data-testid="backend-row" data-connection={props.backend.id} data-status={status()}>
    <Show when={error()}><ProductErrorBanner onDismiss={() => setError('')}>{error()}</ProductErrorBanner></Show>
    <Show when={removing()} fallback={<>
      <div class="storage-folder-heading">
        <ProductDisclosure title={title()} open={props.backend.id === (props.activeBackendId ?? props.defaultBackend.id)}>
          <p class="dinkster-metadata" role="status">{message(`backendsPanel.connection.${status()}`)}</p>
          <code class="backend-address">{props.backend.baseUrl || message('backendsPanel.sameOrigin')}</code>
          <Show when={schemaState().status === 'error'}><ProductNotice tone="warning">{message('backendsPanel.notice.schemaFailed', { message: (schemaState() as { message: string }).message })}</ProductNotice></Show>
          <Show when={supervisor()?.detail}><p class="dinkster-metadata">{supervisor()!.detail}</p></Show>
          <div class="dinkster-actions">
            <Show when={supervisor() !== undefined}><ProductButton disabled={busy()} onClick={() => { void perform(() => props.app.restartEngine(props.backend)) }} data-testid="backend-engine-restart">{message(busy() ? 'backendsPanel.action.restarting' : 'backendsPanel.action.restart')}</ProductButton></Show>
            <Show when={schemaState().status === 'error'}><ProductButton disabled={busy()} onClick={() => { void perform(() => props.app.refreshBackendSchemas(props.backend)) }} data-testid="backend-schema-retry">{message('backendsPanel.action.retrySchemas')}</ProductButton></Show>
            <ProductButton onClick={() => props.onOpenStorage?.(props.backend)}>{message('storagePanel.title')}</ProductButton>
            <ProductButton onClick={() => props.onOpenResources?.(props.backend)}>{message('backendsPanel.resources')}</ProductButton>
            <Show when={props.backend.protocol === 'dinkster'}><ProductButton onClick={() => props.onOpenSettings?.(props.backend)}>{message('shell.panel.settings.title')}</ProductButton></Show>
          </div>
          <ConnectionProfilesSection app={props.app} compact backendUrl={props.backend.baseUrl} />
        </ProductDisclosure>
        <Show when={props.backend !== props.defaultBackend}><ProductMenu label={message('backendsPanel.aria.actions', { backend: props.backend.label })}
          items={[{ label: message('backendsPanel.action.remove'), intent: 'remove', onSelect: () => setRemoving(true) }]} /></Show>
      </div>
    </>}>
      <ProductConfirmation title={message('backendsPanel.action.remove')} consequence={message('backendsPanel.removeNotice', { backend: props.backend.label })}
        actionLabel={message('backendsPanel.action.remove')} intent="remove" onCancel={() => setRemoving(false)} onConfirm={() => props.app.removeBackend(props.backend.id)} />
    </Show>
  </article>
}

export function BackendsPanel(props: {
  readonly app: AppState
  readonly activeBackendId?: string | undefined
  readonly onOpenStorage?: (backend: Backend) => void
  readonly onOpenResources?: (backend: Backend) => void
  readonly onOpenSettings?: (backend: Backend) => void
}) {
  const message = useAppMessage()
  const backends = useSignal(props.app.backends)
  const tick = useSignal(props.app.backendsTick)
  const [adding, setAdding] = createSignal(false)
  const [url, setUrl] = createSignal('')
  const [discovering, setDiscovering] = createSignal(false)
  const [addError, setAddError] = createSignal('')
  const add = async () => {
    if (discovering()) return
    const candidate = canonicalBackendUrl(url())
    setAddError('')
    if (backends().some((backend) => canonicalBackendUrl(backend.baseUrl) === candidate)) {
      setAddError('backendsPanel.error.duplicate')
      return
    }
    if (!candidate) return
    setDiscovering(true)
    try {
      const added = await props.app.addBackendByUrl(candidate)
      if (added) { setUrl(''); setAdding(false) }
      else setAddError('backendsPanel.error.addFailed')
    } finally { setDiscovering(false) }
  }
  return <section class="backends-panel" data-testid="backends-panel" aria-label={message('backendsPanel.title')}>
    <ProductPanelHeader title={message('backendsPanel.title')} actions={<ProductButton intent="add" aria-expanded={adding()} onClick={() => setAdding(!adding())}>{message('backendsPanel.addBackend')}</ProductButton>} />
    <Show when={adding()}><form class="dinkster-stack" onSubmit={(event) => { event.preventDefault(); void add() }}>
      <ProductField controlId="backend-address" label={message('backendsPanel.label.address')} description={message('backendsPanel.help.address')} layout="stack" invalid={addError() !== ''}>
        <ProductTextInput id="backend-address" data-testid="backend-url-input" inputmode="url" autocomplete="url"
          placeholder={message('backendsPanel.placeholder.address')} value={url()} invalid={addError() !== ''}
          aria-describedby={`${productFieldIds('backend-address').description}${addError() ? ' backend-add-error' : ''}`}
          onInput={(event) => { setUrl(event.currentTarget.value); setAddError('') }} />
      </ProductField>
      <Show when={addError()}><p id="backend-add-error" class="dinkster-field-error" role="alert">{message(addError())}</p></Show>
      <ProductButton data-testid="backend-add" type="submit" intent="add" fill="solid" pending={discovering()} disabled={!url().trim()}>{message(discovering() ? 'backendsPanel.action.discovering' : 'backendsPanel.action.discover')}</ProductButton>
    </form></Show>
    <div class="backend-list" aria-live="polite">
      <For each={backends()}>{(backend) => <BackendRow app={props.app} backend={backend} defaultBackend={backends()[0]!} activeBackendId={props.activeBackendId} tick={tick}
        onOpenStorage={props.onOpenStorage} onOpenResources={props.onOpenResources} onOpenSettings={props.onOpenSettings} />}</For>
      <ConnectionProfilesSection app={props.app} compact showCreate={adding()} />
    </div>
  </section>
}
