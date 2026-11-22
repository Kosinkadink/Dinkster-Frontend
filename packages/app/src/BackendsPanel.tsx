import { createMemo, createSignal, For, Show } from 'solid-js'
import Ellipsis from 'lucide-solid/icons/ellipsis'
import { ProductButton, ProductConfirmation, ProductDisclosure, ProductErrorBanner, ProductMenu, ProductNotice } from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { backendConnectionStatus, canonicalBackendUrl } from './app-state.js'
import { ConnectionCredentialControls, createConnectionProfiles } from './ConnectionProfiles.js'
import { validProfileUrl } from './connection-profiles.js'
import { useAppMessage } from './locale.js'
import { ProductField, productFieldIds } from './ProductForm.js'
import { ProductTextInput } from './ProductControls.js'
import { ProductPanelHeader } from './ProductSurfaces.js'
import { useSignal } from './solid-adapter.js'

function BackendRow(props: {
  readonly app: AppState
  readonly url: string
  readonly name: string
  readonly backend: Backend | undefined
  readonly defaultBackend: Backend
  readonly connections: ReturnType<typeof createConnectionProfiles>
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
  const [connectFailed, setConnectFailed] = createSignal(false)
  const status = () => { props.tick(); return props.backend ? backendConnectionStatus(props.backend) : 'disconnected' }
  const registry = () => { props.tick(); return props.backend?.registry.get() }
  const schemaState = () => { props.tick(); return props.backend?.schemaState.get() }
  const supervisor = () => { props.tick(); return props.backend?.supervisor.get() }
  const perform = async (action: () => Promise<unknown>) => {
    if (busy() || props.connections.busy()) return
    setBusy(true)
    setError('')
    setConnectFailed(false)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const connect = async () => {
    if (props.backend) await props.app.startBackend(props.backend)
    else if (!await props.app.addBackendByUrl(props.url, { label: props.name })) setConnectFailed(true)
  }
  const remove = async () => {
    const backend = props.backend
    if (!await props.connections.remove(props.url)) return
    if (backend && props.app.backends.get().includes(backend)) props.app.removeBackend(backend.id)
    setRemoving(false)
  }
  const title = () => `${message(`backendsPanel.connection.${status()}`)} - ${props.name}${props.backend ? ` - ${message(props.backend.protocol === 'dinkster' ? 'backendsPanel.protocol.dinkster' : 'backendsPanel.protocol.comfyUi')}` : ''}${registry() ? `, ${message('backendsPanel.schema.available', { count: registry()!.schemas.size })}` : ''}`
  return <article class="backend-server" data-testid="backend-row" data-connection={props.backend?.id ?? props.url} data-status={status()}>
    <Show when={error() || connectFailed()}><ProductErrorBanner onDismiss={() => { setError(''); setConnectFailed(false) }}>{connectFailed() ? message('connectionProfiles.error.connect', { name: props.name }) : error()}</ProductErrorBanner></Show>
    <Show when={removing()} fallback={<>
      <div class="storage-folder-heading">
        <ProductDisclosure title={title()} open={props.backend?.id === (props.activeBackendId ?? props.defaultBackend.id)}>
          <p class="dinkster-metadata" role="status">{message(`backendsPanel.connection.${status()}`)}</p>
          <code class="backend-address">{props.url || message('backendsPanel.sameOrigin')}</code>
          <Show when={schemaState()?.status === 'error'}><ProductNotice tone="warning">{message('backendsPanel.notice.schemaFailed', { message: (schemaState() as { message: string }).message })}</ProductNotice></Show>
          <Show when={supervisor()?.detail}><p class="dinkster-metadata">{supervisor()!.detail}</p></Show>
          <div class="dinkster-actions">
            <Show when={status() === 'disconnected'} fallback={<ProductButton intent="remove" disabled={busy() || props.connections.busy()} onClick={() => props.backend && props.app.disconnectBackend(props.backend)}>{message('backendsPanel.action.disconnect')}</ProductButton>}>
              <ProductButton data-testid="profile-connect" disabled={busy() || props.connections.busy()} onClick={() => { void perform(connect) }}>{message(busy() ? 'connectionProfiles.action.connecting' : 'connectionProfiles.action.connect')}</ProductButton>
            </Show>
            <Show when={props.backend} keyed>{(backend) => <>
              <Show when={supervisor() !== undefined}><ProductButton disabled={busy()} onClick={() => { void perform(() => props.app.restartEngine(backend)) }} data-testid="backend-engine-restart">{message(busy() ? 'backendsPanel.action.restarting' : 'backendsPanel.action.restart')}</ProductButton></Show>
              <Show when={schemaState()?.status === 'error'}><ProductButton disabled={busy()} onClick={() => { void perform(() => props.app.refreshBackendSchemas(backend)) }} data-testid="backend-schema-retry">{message('backendsPanel.action.retrySchemas')}</ProductButton></Show>
              <ProductButton onClick={() => props.onOpenStorage?.(backend)}>{message('storagePanel.title')}</ProductButton>
              <ProductButton onClick={() => props.onOpenResources?.(backend)}>{message('backendsPanel.resources')}</ProductButton>
              <Show when={backend.protocol === 'dinkster'}><ProductButton onClick={() => props.onOpenSettings?.(backend)}>{message('shell.panel.settings.title')}</ProductButton></Show>
            </>}</Show>
          </div>
          <Show when={validProfileUrl(props.url)}><ConnectionCredentialControls connections={props.connections} url={props.url} name={props.name} /></Show>
        </ProductDisclosure>
        <Show when={props.backend !== props.defaultBackend}><ProductMenu icon={Ellipsis} iconOnly label={message('backendsPanel.aria.actions', { backend: props.name })}
          items={[{ label: message('backendsPanel.action.remove'), intent: 'remove', disabled: props.connections.busy(), onSelect: () => setRemoving(true) }]} /></Show>
      </div>
    </>}>
      <ProductConfirmation title={message('backendsPanel.action.remove')} consequence={message('backendsPanel.removeNotice', { backend: props.name })}
        actionLabel={message('backendsPanel.action.remove')} intent="remove" pending={busy() || props.connections.busy()} onCancel={() => setRemoving(false)} onConfirm={() => { void perform(remove) }} />
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
  const connections = createConnectionProfiles()
  const addresses = createMemo(() => [...new Set([...backends().map((backend) => canonicalBackendUrl(backend.baseUrl)), ...connections.profiles().map((profile) => canonicalBackendUrl(profile.url))])])
  const [adding, setAdding] = createSignal(false)
  const [url, setUrl] = createSignal('')
  const [name, setName] = createSignal('')
  const [token, setToken] = createSignal('')
  const [discovering, setDiscovering] = createSignal(false)
  const [addError, setAddError] = createSignal('')
  const add = async () => {
    if (discovering() || connections.busy()) return
    const candidate = canonicalBackendUrl(url())
    setAddError('')
    if (addresses().includes(candidate)) { setAddError('backendsPanel.error.duplicate'); return }
    if (!candidate) return
    if ((!candidate.startsWith('/') || token().trim()) && !validProfileUrl(candidate)) { setAddError('connectionProfiles.error.address'); return }
    setDiscovering(true)
    try {
      // Credential custody must succeed before discovery sends authenticated requests.
      // A failed probe keeps the new profile reachable for retry or token removal.
      if (token().trim() && !await connections.saveToken(candidate, name() || candidate, token().trim())) return
      const label = name().trim() || (validProfileUrl(candidate) ? new URL(candidate).host : candidate)
      const added = await props.app.addBackendByUrl(candidate, { label })
      if (added) { setUrl(''); setName(''); setToken(''); setAdding(false) }
      else setAddError('backendsPanel.error.addFailed')
    } catch { setAddError('backendsPanel.error.addFailed') }
    finally { setDiscovering(false) }
  }
  return <section class="backends-panel" data-testid="backends-panel" aria-label={message('backendsPanel.title')}>
    <ProductPanelHeader title={message('backendsPanel.title')} actions={<ProductButton intent="add" aria-expanded={adding()} disabled={discovering()} onClick={() => setAdding(!adding())}>{message('backendsPanel.addBackend')}</ProductButton>} />
    <Show when={connections.error()}><ProductErrorBanner onDismiss={connections.dismissError}>{connections.error()}</ProductErrorBanner></Show>
    <Show when={adding()}><form class="dinkster-stack" onSubmit={(event) => { event.preventDefault(); void add() }}>
      <ProductField controlId="backend-address" label={message('backendsPanel.label.address')} description={message('backendsPanel.help.address')} layout="stack" invalid={addError() !== ''}>
        <ProductTextInput id="backend-address" data-testid="backend-url-input" inputmode="url" autocomplete="url"
          placeholder={message('backendsPanel.placeholder.address')} value={url()} invalid={addError() !== ''} disabled={discovering()}
          aria-describedby={`${productFieldIds('backend-address').description}${addError() ? ' backend-add-error' : ''}`}
          onInput={(event) => { setUrl(event.currentTarget.value); setAddError('') }} />
      </ProductField>
      <Show when={addError()}><p id="backend-add-error" class="dinkster-field-error" role="alert">{message(addError())}</p></Show>
      <ProductField controlId="backend-name" label={message('backendsPanel.label.nameOptional')} layout="stack">
        <ProductTextInput id="backend-name" data-testid="profile-name-input" value={name()} disabled={discovering()} onInput={(event) => setName(event.currentTarget.value)} />
      </ProductField>
      <Show when={connections.custody()}><ProductField controlId="backend-token" label={message('connectionProfiles.label.accessTokenOptional')} layout="stack">
        <ProductTextInput id="backend-token" data-testid="profile-token-input" type="password" autocomplete="off" value={token()} disabled={discovering()} onInput={(event) => setToken(event.currentTarget.value)} />
      </ProductField></Show>
      <ProductButton data-testid="backend-add" type="submit" intent="add" fill="solid" pending={discovering()} disabled={!url().trim() || connections.busy()}>{message(discovering() ? 'connectionProfiles.action.connecting' : 'connectionProfiles.action.connect')}</ProductButton>
    </form></Show>
    <div class="backend-list" aria-live="polite">
      <For each={addresses()}>{(address) => {
        const backend = () => backends().find((backend) => canonicalBackendUrl(backend.baseUrl) === address)
        const label = () => backend()?.label ?? connections.matching(address)[0]?.name ?? address
        return <BackendRow app={props.app} url={address} name={label()} backend={backend()} defaultBackend={backends()[0]!} connections={connections} activeBackendId={props.activeBackendId} tick={tick}
          onOpenStorage={props.onOpenStorage} onOpenResources={props.onOpenResources} onOpenSettings={props.onOpenSettings} />
      }}</For>
    </div>
  </section>
}
