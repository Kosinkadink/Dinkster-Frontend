import { createEffect, createSignal, onCleanup, Show, untrack } from 'solid-js'
import { X } from 'lucide-solid'
import type { DinksterConnection, ModelProviderSignIn, ModelProviderStatus } from '@dinkster/client'
import { ProductButton, ProductTextInput } from './ProductControls.js'
import { ProductField, ProductNotice } from './ProductForm.js'
import { useAppMessage } from './locale.js'

export type ModelProviderConnection = Pick<DinksterConnection, 'fetchModelProvider' | 'saveModelProviderToken' |
  'forgetModelProvider' | 'startModelProviderSignIn' | 'pollModelProviderSignIn' | 'cancelModelProviderSignIn'>

export function ModelProvider(props: { readonly connection: ModelProviderConnection; readonly backendUrl?: string; readonly onChanged?: () => void }) {
  const message = useAppMessage()
  const [status, setStatus] = createSignal<ModelProviderStatus>()
  const [flow, setFlow] = createSignal<ModelProviderSignIn>()
  const [busy, setBusy] = createSignal(false)
  const [fallback, setFallback] = createSignal(false)
  const [token, setToken] = createSignal('')
  const [forgetting, setForgetting] = createSignal(false)
  const [error, setError] = createSignal(false)
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let active: ModelProviderSignIn | undefined
  let connection: ModelProviderConnection
  const stop = () => {
    clearTimeout(timer)
    const previous = active
    active = undefined
    setFlow(undefined)
    if (previous) void connection.cancelModelProviderSignIn(previous.flowId).catch(() => undefined)
  }
  const poll = (current: ModelProviderSignIn, owner: number, interval: number) => {
    timer = setTimeout(async () => {
      if (owner !== generation || active !== current) return
      try {
        const result = await connection.pollModelProviderSignIn(current.flowId)
        if (owner !== generation || active !== current) return
        if (result.status === 'pending') { poll(current, owner, result.interval ?? interval); return }
        const next = await connection.fetchModelProvider()
        if (owner !== generation || active !== current) return
        active = undefined
        setFlow(undefined)
        setStatus(next)
        props.onChanged?.()
      } catch {
        if (owner === generation && active === current) { stop(); setError(true) }
      }
    }, interval * 1000)
  }
  createEffect(() => {
    const next = props.connection
    const backend = props.backendUrl
    void backend
    generation++
    const owner = generation
    connection = next
    setStatus(undefined); setToken(''); setFlow(undefined); setBusy(true); setError(false); setFallback(false); setForgetting(false)
    untrack(() => { void next.fetchModelProvider().then((value) => { if (owner === generation) setStatus(value) }).catch(() => { if (owner === generation) setError(true) }).finally(() => { if (owner === generation) setBusy(false) }) })
    onCleanup(() => { generation++; stop(); setToken('') })
  })
  const perform = async (action: () => Promise<ModelProviderStatus>) => {
    if (busy() || active) return
    const owner = generation
    setBusy(true); setError(false)
    try {
      const value = await action()
      if (owner !== generation) return
      setStatus(value); setForgetting(false); setFallback(false); props.onChanged?.()
    } catch { if (owner === generation) setError(true) }
    finally { if (owner === generation) setBusy(false) }
  }
  const refresh = () => { void perform(() => connection.fetchModelProvider()) }
  const signIn = async () => {
    if (busy() || active) return
    const owner = generation
    const target = connection
    setBusy(true); setError(false); setToken('')
    const url = new URL(props.backendUrl || '/', window.location.href)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
    try {
      const next = await target.startModelProviderSignIn(local ? 'pkce' : 'device')
      if (owner !== generation) { void target.cancelModelProviderSignIn(next.flowId).catch(() => undefined); return }
      active = next; setFlow(next)
      poll(next, owner, next.method === 'device' ? next.interval : 2)
    } catch { if (owner === generation) setError(true) }
    finally { if (owner === generation) setBusy(false) }
  }
  const cancel = async () => {
    const current = active
    if (!current || busy()) return
    const owner = generation
    setBusy(true)
    try {
      await connection.cancelModelProviderSignIn(current.flowId)
      if (owner !== generation || active !== current) return
      clearTimeout(timer); active = undefined; setFlow(undefined)
    } catch { if (owner === generation) setError(true) }
    finally { if (owner === generation) setBusy(false) }
  }
  const save = () => {
    const value = token()
    setToken('')
    void perform(() => connection.saveModelProviderToken(value))
  }
  return <section class="model-provider" data-testid="model-provider">
    <h4>{message('modelProvider.title')}</h4>
    <Show when={error()}><ProductNotice tone="error">{message('modelProvider.error')} <ProductButton size="compact" aria-label={message('modelProvider.dismiss')} onClick={() => setError(false)}><X size={14} aria-hidden="true" /></ProductButton></ProductNotice></Show>
    <ProductNotice tone="info">{message('modelProvider.privacy')}</ProductNotice>
    <p role="status">{message(status()?.expired ? 'modelProvider.expired' : status()?.configured ? 'modelProvider.connected' : 'modelProvider.disconnected')}</p>
    <Show when={flow()}>{(current) => <>
      <ProductNotice tone="info">{message('modelProvider.pending')}</ProductNotice>
      <Show when={current().method === 'device'}><ProductField controlId="model-provider-code" label={message('modelProvider.code')} layout="stack"><code id="model-provider-code">{current().method === 'device' ? (current() as Extract<ModelProviderSignIn, { method: 'device' }>).userCode : ''}</code></ProductField></Show>
      <a class="product-button" href={current().method === 'pkce' ? (current() as Extract<ModelProviderSignIn, { method: 'pkce' }>).authorizationUrl : (current() as Extract<ModelProviderSignIn, { method: 'device' }>).verificationUri} target="_blank" rel="noopener noreferrer">{message('modelProvider.open')}</a>
      <ProductButton disabled={busy()} onClick={() => void cancel()}>{message('modelProvider.cancel')}</ProductButton>
    </>}</Show>
    <Show when={!flow()}><div class="project-folder-actions">
      <ProductButton disabled={busy()} onClick={refresh}>{message('modelProvider.refresh')}</ProductButton>
      <ProductButton disabled={busy()} onClick={() => void signIn()}>{message('modelProvider.signIn')}</ProductButton>
      <ProductButton disabled={busy()} onClick={() => { setFallback(!fallback()); setToken(''); setForgetting(false) }}>{message('modelProvider.fallback')}</ProductButton>
      <Show when={status()?.configured || status()?.expired}><ProductButton disabled={busy()} onClick={() => { setForgetting(true); setFallback(false); setToken('') }}>{message('modelProvider.forget')}</ProductButton></Show>
    </div></Show>
    <Show when={fallback() && !flow()}><div class="model-provider-token">
      <ProductField controlId="model-provider-token" label={message('modelProvider.token')} layout="stack"><ProductTextInput id="model-provider-token" type="password" autocomplete="off" value={token()} disabled={busy()} onInput={(event) => setToken(event.currentTarget.value)} /></ProductField>
      <ProductButton variant="primary" disabled={busy() || !token().trim()} onClick={save}>{message('modelProvider.save')}</ProductButton>
    </div></Show>
    <Show when={forgetting()}><div class="project-folder-removal"><ProductNotice tone="warning">{message('modelProvider.forgetNotice')}</ProductNotice>
      <ProductButton disabled={busy()} onClick={() => setForgetting(false)}>{message('modelProvider.cancel')}</ProductButton>
      <ProductButton variant="danger" disabled={busy()} onClick={() => void perform(() => connection.forgetModelProvider())}>{message('modelProvider.forget')}</ProductButton>
    </div></Show>
  </section>
}
