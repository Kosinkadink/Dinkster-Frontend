import { createSignal, For, Show } from 'solid-js'
import type { AppState, Backend } from './app-state.js'
import { canonicalBackendUrl } from './app-state.js'
import { ConnectionProfilesSection } from './ConnectionProfiles.js'
import { AgentPermissionsPanel } from './AgentPermissionsPanel.js'
import { useAppMessage } from './locale.js'
import { ProductNotice } from './ProductForm.js'
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel.js'
import { OutputMountSettings } from './OutputMountSettings.js'
import { useSignal } from './solid-adapter.js'

function BackendCard(props: {
  readonly app: AppState
  readonly backend: Backend
  readonly defaultBackend: Backend
  readonly tick: () => number
}) {
  const message = useAppMessage()
  const [restarting, setRestarting] = createSignal(false)
  const [retryingSchemas, setRetryingSchemas] = createSignal(false)
  const status = () => { props.tick(); return props.backend.connection.status.get() }
  const registry = () => { props.tick(); return props.backend.registry.get() }
  const schemaState = () => { props.tick(); return props.backend.schemaState.get() }
  const supervisor = () => { props.tick(); return props.backend.supervisor.get() }
  const progress = () => { props.tick(); return supervisor()?.progress ?? props.backend.composition.get() }
  const connectionLabel = (): string => message(`backendsPanel.connection.${status()}`)
  const schemaLabel = (): string => {
    const state = schemaState().status
    if (state === 'error') return message('backendsPanel.schema.unavailable')
    if (state === 'loading') return message('backendsPanel.schema.loading')
    if (state === 'waiting') return message('backendsPanel.schema.waiting')
    return message('backendsPanel.schema.notLoaded')
  }
  const engineStateLabel = (): string => {
    if (progress() !== undefined) return message('backendsPanel.engine.composing')
    const state = engine()?.state
    if (state === 'starting') return message('backendsPanel.engine.starting')
    if (state === 'failed') return message('backendsPanel.engine.failed')
    if (state === 'stopped') return message('backendsPanel.engine.stopped')
    return message('backendsPanel.engine.ready')
  }
  const restart = async (): Promise<void> => {
    if (restarting()) return
    setRestarting(true)
    try { await props.app.restartEngine(props.backend) }
    finally { setRestarting(false) }
  }
  const retrySchemas = async (): Promise<void> => {
    if (retryingSchemas()) return
    setRetryingSchemas(true)
    try { await props.app.refreshBackendSchemas(props.backend) }
    finally { setRetryingSchemas(false) }
  }
  const engine = () => supervisor()

  return (
    <article class="backend-card" data-testid="backend-row" data-connection={props.backend.id}>
      <header class="backend-card-header">
        <div class="backend-identity">
          <div class="backend-title-line">
            <h3>{props.backend.label}</h3>
            <Show when={props.backend === props.defaultBackend}>
              <span class="backend-badge">{message('backendsPanel.badge.default')}</span>
            </Show>
            <span class="backend-badge">{message(props.backend.protocol === 'dinkster' ? 'backendsPanel.protocol.dinkster' : 'backendsPanel.protocol.comfyUi')}</span>
          </div>
          <code class="backend-address">{props.backend.baseUrl || message('backendsPanel.sameOrigin')}</code>
        </div>
        <span class="backend-status" data-status={status()} role="status">
          <span class="backend-status-dot" aria-hidden="true" />
          {connectionLabel()}
        </span>
      </header>

      <dl class="backend-facts">
        <div>
          <dt>{message('backendsPanel.fact.schemas')}</dt>
          <dd>
            <Show when={registry()} fallback={
              schemaLabel()
            }>{(value) => message('backendsPanel.schema.available', { count: value().schemas.size })}</Show>
          </dd>
        </div>
        <div>
          <dt>{message('backendsPanel.fact.protocol')}</dt>
          <dd>{message(props.backend.protocol === 'dinkster' ? 'backendsPanel.protocol.nativeDinkster' : 'backendsPanel.protocol.comfyUiV1')}</dd>
        </div>
      </dl>

      <Show when={status() === 'reconnecting'}>
        <ProductNotice tone="warning">{message('backendsPanel.notice.reconnecting')}</ProductNotice>
      </Show>
      <Show when={status() === 'disconnected'}>
        <ProductNotice tone="error">{message('backendsPanel.notice.disconnected')}</ProductNotice>
      </Show>
      <Show when={schemaState().status === 'error'}>
        <ProductNotice tone="error" testId="backend-schema-error">
          {message('backendsPanel.notice.schemaFailed', { message: (schemaState() as { readonly status: 'error'; readonly message: string }).message })}
        </ProductNotice>
      </Show>

      <Show when={engine() !== undefined || progress() !== undefined}>
        <section class="backend-engine" data-state={engine()?.state ?? 'ready'} aria-label={message('backendsPanel.aria.engine', { backend: props.backend.label })}>
          <div class="backend-engine-heading">
            <div>
              <span class="backend-eyebrow">{message('backendsPanel.engine.label')}</span>
              <strong>{engineStateLabel()}</strong>
            </div>
            <Show when={engine()?.engine?.pid}><span class="backend-engine-pid">{message('backendsPanel.engine.pid', { pid: engine()!.engine!.pid! })}</span></Show>
          </div>
          <Show when={engine()?.detail}><p>{engine()!.detail}</p></Show>
          <Show when={progress()}>{(current) => (
            <div class="backend-progress">
              <div class="backend-progress-copy">
                <span>{current().phase || message('backendsPanel.progress.composing')}</span>
                <span>{message('backendsPanel.progress.count', { done: current().done, total: current().total })}</span>
              </div>
              <progress value={current().done} max={Math.max(1, current().total)} aria-label={message('backendsPanel.aria.progress', { backend: props.backend.label })} />
            </div>
          )}</Show>
        </section>
      </Show>

      <div class="backend-actions">
        <Show when={schemaState().status === 'error'}>
          <button type="button" disabled={retryingSchemas()} data-testid="backend-schema-retry" aria-label={message('backendsPanel.aria.retrySchemas', { backend: props.backend.label })} onClick={() => void retrySchemas()}>
            {message(retryingSchemas() ? 'backendsPanel.action.retrying' : 'backendsPanel.action.retrySchemas')}
          </button>
        </Show>
        <Show when={engine()?.state === 'failed' || engine()?.state === 'stopped'}>
          <button type="button" disabled={restarting()} data-testid="backend-engine-restart" aria-label={message('backendsPanel.aria.restart', { backend: props.backend.label })} onClick={() => void restart()}>
            {message(restarting() ? 'backendsPanel.action.restarting' : 'backendsPanel.action.restart')}
          </button>
        </Show>
        <Show when={props.backend !== props.defaultBackend}>
          <button type="button" class="danger" data-testid="backend-remove" aria-label={message('backendsPanel.aria.remove', { backend: props.backend.label })} onClick={() => props.app.removeBackend(props.backend.id)}>
            {message('backendsPanel.action.remove')}
          </button>
        </Show>
      </div>

      <Show when={props.backend.protocol === 'dinkster' ? props.backend : undefined}>
        {(native) => <>
          <OutputMountSettings connection={native().connection} />
          <RuntimeSettingsPanel connection={native().connection} backendLabel={props.backend.label} />
          <AgentPermissionsPanel connection={native().connection} backendLabel={props.backend.label} />
        </>}
      </Show>
    </article>
  )
}

export function BackendsPanel(props: { readonly app: AppState }) {
  const message = useAppMessage()
  const backends = useSignal(props.app.backends)
  const tick = useSignal(props.app.backendsTick)
  const [url, setUrl] = createSignal('')
  const [discovering, setDiscovering] = createSignal(false)
  const [addError, setAddError] = createSignal('')
  const add = async (): Promise<void> => {
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
      if (added) setUrl('')
      else setAddError('backendsPanel.error.addFailed')
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <section class="backends-panel" data-testid="backends-panel" aria-label={message('backendsPanel.title')}>
      <div class="backend-add-surface">
        <div>
          <h2>{message('backendsPanel.title')}</h2>
          <p>{message('backendsPanel.description')}</p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void add() }}>
          <label for="backend-address">{message('backendsPanel.label.address')}</label>
          <div class="backend-add-controls">
            <input
              id="backend-address"
              class="backend-url-input"
              data-testid="backend-url-input"
              inputmode="url"
              autocomplete="url"
              placeholder={message('backendsPanel.placeholder.address')}
              value={url()}
              aria-describedby={addError() ? 'backend-add-error' : 'backend-add-help'}
              onInput={(event) => { setUrl(event.currentTarget.value); setAddError('') }}
            />
            <button data-testid="backend-add" type="submit" disabled={discovering() || url().trim() === ''}>
              {message(discovering() ? 'backendsPanel.action.discovering' : 'backendsPanel.action.discover')}
            </button>
          </div>
          <span id="backend-add-help" class="backend-add-help">{message('backendsPanel.help.address')}</span>
          <Show when={addError()}>{(key) => <p id="backend-add-error" class="backend-add-error" role="alert">{message(key())}</p>}</Show>
        </form>
        <Show when={discovering()}><ProductNotice tone="status">{message('backendsPanel.notice.discovering', { address: url().trim() })}</ProductNotice></Show>
      </div>

      <div class="backend-list" aria-live="polite">
        <For each={backends()}>{(backend) => (
          <BackendCard app={props.app} backend={backend} defaultBackend={backends()[0]!} tick={tick} />
        )}</For>
      </div>

      <ConnectionProfilesSection app={props.app} />
    </section>
  )
}
