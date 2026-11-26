import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import Ellipsis from 'lucide-solid/icons/ellipsis'
import { ProductButton, ProductConfirmation, ProductErrorBanner, ProductFacts, ProductList, ProductListRow, ProductMenu, ProductNotice, ProductTextButton } from '@dinkster/ui'
import type { AppState, Backend } from './app-state.js'
import { backendConnectionStatus, canonicalBackendUrl } from './app-state.js'
import { ConnectionCredentialControls, createConnectionProfiles } from './ConnectionProfiles.js'
import { validProfileUrl } from './connection-profiles.js'
import { useAppMessage } from './locale.js'
import { ProductField, productFieldIds } from './ProductForm.js'
import { ProductTextInput } from './ProductControls.js'
import { useSignal } from './solid-adapter.js'

function BackendAddress(props: { readonly value: string }) {
  const address = createMemo(() => props.value.match(/^(https?:\/\/)(\[[^\]]+\]|[^/:]+)(:\d+)?(.*)$/i))
  const path = () => (address()?.[4] ?? props.value).split(/(?=\/)/).filter(Boolean)
  return <code class="backend-address">
    <Show when={address()}>{(parts) => <>
      <span class="backend-address-host"><For each={`${parts()[1]}${parts()[2]}`.split(/(?<=\.)/)}>{(part) => <span>{part}</span>}</For></span>
      <Show when={parts()[3]}>{(port) => <span>{port()}</span>}</Show>
    </>}</Show>
    <For each={path()}>{(part) => <span>{part}</span>}</For>
  </code>
}

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
  readonly removing: boolean
  readonly onRemove: () => void
  readonly onCancelRemove: () => void
}) {
  const message = useAppMessage()
  const [busy, setBusy] = createSignal(false)
  const [editingToken, setEditingToken] = createSignal(false)
  const [error, setError] = createSignal('')
  const [connectFailed, setConnectFailed] = createSignal(false)
  const [opened, setOpened] = createSignal(props.backend?.id === (props.activeBackendId ?? props.defaultBackend.id))
  const status = () => { props.tick(); return props.backend ? backendConnectionStatus(props.backend) : 'disconnected' }
  const connectionStatus = () => { props.tick(); return props.backend?.connection.status.get() ?? 'disconnected' }
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
    props.onCancelRemove()
  }
  const summary = () => {
    if (status() === 'connecting' || status() === 'reconnecting') return message(`backendsPanel.connection.${status()}`)
    if (schemaState()?.status === 'error') return message('backendsPanel.schema.failed')
    if (status() === 'disconnected') return message('backendsPanel.connection.disconnected')
    const kind = message('backendsPanel.protocol.dinkster')
    return registry() ? `${kind}, ${message('backendsPanel.schema.available', { count: registry()!.schemas.size })}` : kind
  }
  const problem = () => status() === 'reconnecting' || schemaState()?.status === 'error'
  return <ProductListRow testId="backend-row" dataAttributes={{ 'data-connection': props.backend?.id ?? props.url, 'data-status': status() }}
    title={<span class="backend-row-identity"><strong>{props.name}</strong><span class="backend-row-summary" data-problem={problem() || undefined}>{summary()}</span></span>}
    leading={<span class="backend-state-dot" role="img" aria-label={message(`backendsPanel.connection.${status()}`)} data-status={status()} data-problem={problem() || undefined} />}
    expanded={opened()} onToggle={(value) => { if (!props.removing || !(busy() || props.connections.busy())) setOpened(value) }}
    action={<Show when={!props.removing && (props.backend !== props.defaultBackend || (validProfileUrl(props.url) && props.connections.custody()))}><ProductMenu icon={Ellipsis} iconOnly fill="quiet" label={message('backendsPanel.aria.actions', { backend: props.name })}
      items={[
        ...(validProfileUrl(props.url) && props.connections.custody() ? [{ label: message('backendsPanel.action.changeToken'), disabled: props.connections.busy(), onSelect: () => { setOpened(true); setEditingToken(true) } }] : []),
        ...(props.backend && props.backend !== props.defaultBackend && connectionStatus() !== 'disconnected' ? [{ label: message('backendsPanel.action.disconnect'), disabled: busy() || props.connections.busy(), onSelect: () => props.app.disconnectBackend(props.backend!) }] : []),
        ...(props.backend !== props.defaultBackend && ((validProfileUrl(props.url) && props.connections.custody()) || (props.backend && connectionStatus() !== 'disconnected')) ? ['separator' as const] : []),
        ...(props.backend !== props.defaultBackend ? [{ label: message('backendsPanel.action.remove'), intent: 'remove' as const, disabled: props.connections.busy(), onSelect: () => { setOpened(true); props.onRemove() } }] : []),
      ]} /></Show>}
  >
    <Show when={!props.removing && (error() || connectFailed())}><ProductErrorBanner onDismiss={() => { setError(''); setConnectFailed(false) }}>{connectFailed() ? message('connectionProfiles.error.connect', { name: props.name }) : error()}</ProductErrorBanner></Show>
    <Show when={props.removing} fallback={<>
          <Show when={schemaState()?.status === 'error'}><ProductNotice tone="warning">
            {message('backendsPanel.notice.schemaFailed', { message: (schemaState() as { message: string }).message })}{' '}
            <ProductTextButton disabled={busy()} onClick={() => { void perform(() => props.app.refreshBackendSchemas(props.backend!)) }} data-testid="backend-schema-retry" label={message('backendsPanel.action.retrySchemas')} />
          </ProductNotice></Show>
          <ProductFacts label={props.name} items={[
            { label: message('backendsPanel.fact.address'), value: props.url ? <BackendAddress value={props.url} /> : message('backendsPanel.sameOrigin') },
            ...(supervisor() ? [{ label: message('backendsPanel.engine.label'), value: <><span>{message(`backendsPanel.engine.${supervisor()!.state}`)}</span><Show when={supervisor()!.detail}><span class="dinkster-metadata">{supervisor()!.detail}</span></Show></> }] : []),
          ]} />
          <div class="backend-row-actions">
            <Show when={connectionStatus() === 'disconnected'}>
              <ProductTextButton data-testid="profile-connect" intent="add" disabled={busy() || props.connections.busy()} onClick={() => { void perform(connect) }} label={message(busy() ? 'connectionProfiles.action.connecting' : 'connectionProfiles.action.connect')} />
            </Show>
            <Show when={props.backend} keyed>{(backend) => <>
              <Show when={supervisor() !== undefined}><ProductTextButton disabled={busy()} onClick={() => { void perform(() => props.app.restartEngine(backend)) }} data-testid="backend-engine-restart" label={message(busy() ? 'backendsPanel.action.restarting' : 'backendsPanel.action.restart')} /></Show>
              <div class="backend-row-destinations">
                <Show when={props.onOpenStorage}><ProductTextButton onClick={() => props.onOpenStorage?.(backend)} label={message('storagePanel.title')} /></Show>
                <Show when={props.onOpenResources}><ProductTextButton onClick={() => props.onOpenResources?.(backend)} label={message('backendsPanel.resources')} /></Show>
                <Show when={props.onOpenSettings}><ProductTextButton onClick={() => props.onOpenSettings?.(backend)} label={message('shell.panel.settings.title')} /></Show>
              </div>
            </>}</Show>
          </div>
          <Show when={editingToken()}><ConnectionCredentialControls connections={props.connections} url={props.url} name={props.name} onClose={() => setEditingToken(false)} /></Show>
    </>}>
      <ProductConfirmation title={message('backendsPanel.removeTitle', { backend: props.name })} consequence={message('backendsPanel.removeNotice', { backend: props.name })}
        error={error() || props.connections.error() ? message('backendsPanel.removeFailed', { backend: props.name, reason: error() || props.connections.error() }) : undefined}
        actionLabel={message('backendsPanel.action.remove')} intent="remove" pending={busy() || props.connections.busy()} onCancel={props.onCancelRemove} onConfirm={() => { void perform(remove) }} />
    </Show>
  </ProductListRow>
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
  const [removingUrl, setRemovingUrl] = createSignal<string>()
  const addresses = createMemo(() => [...new Set([...backends().map((backend) => canonicalBackendUrl(backend.baseUrl)), ...connections.profiles().map((profile) => canonicalBackendUrl(profile.url))])])
  const [adding, setAdding] = createSignal(false)
  const [url, setUrl] = createSignal('')
  const [name, setName] = createSignal('')
  const [token, setToken] = createSignal('')
  const [discovering, setDiscovering] = createSignal(false)
  const [addError, setAddError] = createSignal('')
  let panel!: HTMLElement
  onMount(() => {
    const fit = () => {
      if (!panel.isConnected) return
      delete panel.dataset['stackedRows']
      if ([...panel.querySelectorAll<HTMLElement>('.backend-row-identity')].some((identity) => identity.scrollWidth > identity.clientWidth)) {
        panel.dataset['stackedRows'] = ''
      }
    }
    const resize = new ResizeObserver(fit)
    const mutation = new MutationObserver(fit)
    resize.observe(panel)
    mutation.observe(panel.querySelector('.dinkster-list')!, { subtree: true, childList: true, characterData: true })
    document.fonts?.addEventListener('loadingdone', fit)
    fit()
    onCleanup(() => {
      resize.disconnect()
      mutation.disconnect()
      document.fonts?.removeEventListener('loadingdone', fit)
    })
  })
  const nameHint = () => validProfileUrl(url().trim()) ? new URL(url().trim()).host : ''
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
  return <section ref={panel} class="backends-panel" data-testid="backends-panel" aria-label={message('backendsPanel.title')}>
    <div class="backend-toolbar">
      <span class="dinkster-metadata">{message('backendsPanel.count', { count: addresses().length })}</span>
      <ProductButton intent="add" aria-expanded={adding()} disabled={discovering()} onClick={() => setAdding(!adding())}>{message('backendsPanel.addBackend')}</ProductButton>
    </div>
    <Show when={!removingUrl() && connections.error()}><ProductErrorBanner onDismiss={connections.dismissError}>{connections.error()}</ProductErrorBanner></Show>
    <Show when={adding()}><form class="backend-add-form" onSubmit={(event) => { event.preventDefault(); void add() }}>
      <ProductField controlId="backend-address" label={message('backendsPanel.label.address')} description={message('backendsPanel.help.address')} layout="stack" invalid={addError() !== ''}>
        <ProductTextInput id="backend-address" data-testid="backend-url-input" inputmode="url" autocomplete="url"
          placeholder={message('backendsPanel.placeholder.address')} value={url()} invalid={addError() !== ''} disabled={discovering()}
          aria-describedby={`${productFieldIds('backend-address').description}${addError() ? ' backend-add-error' : ''}`}
          onInput={(event) => { setUrl(event.currentTarget.value); setAddError('') }} />
      </ProductField>
      <Show when={addError()}><p id="backend-add-error" class="dinkster-field-error" role="alert">{message(addError())}</p></Show>
      <ProductField controlId="backend-name" label={message('connectionProfiles.label.name')} metadata={message('backendsPanel.optional')} layout="stack">
        <ProductTextInput id="backend-name" data-testid="profile-name-input" placeholder={nameHint()} value={name()} disabled={discovering()} onInput={(event) => setName(event.currentTarget.value)} />
      </ProductField>
      <Show when={connections.custody()}><ProductField controlId="backend-token" label={message('connectionProfiles.label.accessToken')} metadata={message('backendsPanel.optional')} layout="stack">
        <ProductTextInput id="backend-token" data-testid="profile-token-input" type="password" autocomplete="off" value={token()} disabled={discovering()} onInput={(event) => setToken(event.currentTarget.value)} />
      </ProductField></Show>
      <div class="dinkster-actions">
        <ProductButton data-testid="backend-add" type="submit" intent="add" fill="solid" pending={discovering()} disabled={!url().trim() || connections.busy()}>{message(discovering() ? 'connectionProfiles.action.connecting' : 'connectionProfiles.action.connect')}</ProductButton>
        <ProductTextButton label={message('common.cancel')} disabled={discovering()} onClick={() => { setAdding(false); setUrl(''); setName(''); setToken(''); setAddError('') }} />
      </div>
    </form></Show>
    <ProductList label={message('backendsPanel.title')} variant="grouped">
      <For each={addresses()}>{(address) => {
        const backend = () => backends().find((backend) => canonicalBackendUrl(backend.baseUrl) === address)
        const label = () => backend()?.label ?? connections.matching(address)[0]?.name ?? address
        return <BackendRow app={props.app} url={address} name={label()} backend={backend()} defaultBackend={backends()[0]!} connections={connections} activeBackendId={props.activeBackendId} tick={tick}
          removing={removingUrl() === address} onRemove={() => { connections.dismissError(); setRemovingUrl(address) }} onCancelRemove={() => { connections.dismissError(); setRemovingUrl(undefined) }}
          onOpenStorage={props.onOpenStorage} onOpenResources={props.onOpenResources} onOpenSettings={props.onOpenSettings} />
      }}</For>
    </ProductList>
  </section>
}
