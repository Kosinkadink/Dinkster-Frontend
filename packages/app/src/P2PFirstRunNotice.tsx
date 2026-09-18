import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, Show } from 'solid-js'
import { decodeP2PSettings, type DinksterConnection, type RuntimeSettings } from '@dinkster/client'
import { safeLocalStorage } from './collections.js'
import { useAppMessageGroup } from './locale.js'
import { ModalSurface } from './ModalSurface.js'
import { ProductActionFooter, ProductNotice } from './ProductForm.js'

export function P2PFirstRunNotice(props: {
  readonly connection: Pick<DinksterConnection, 'fetchRuntimeSettings' | 'updateRuntimeSetting'>
  readonly backendId: string
  readonly backendLabel: string
  readonly connected: boolean
  readonly onSettingsChanged: () => void
}) {
  const m = useAppMessageGroup('p2p')
  const modalId = `p2p-first-run-${createUniqueId()}`
  const descriptionId = `${modalId}-description`
  const storageKey = `dinkster.p2p-notice-dismissed.${props.backendId}`
  const storage = safeLocalStorage()
  let remembered = false
  try { remembered = storage?.getItem(storageKey) === '1' } catch { /* Storage is optional. */ }
  const [dismissed, setDismissed] = createSignal(remembered)
  const [runtime, setRuntime] = createSignal<RuntimeSettings>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  let generation = 0
  onCleanup(() => { generation += 1 })
  const settings = () => {
    const value = runtime()?.settings['p2p']?.value
    return decodeP2PSettings(value) ? value : undefined
  }
  const writable = () => runtime()?.categories.granted.includes('p2p') === true
    && runtime()?.settings['p2p']?.writable === true

  // Settings are sufficient to identify an enabled backend, even before its event socket opens.
  const connected = createMemo(() => props.connected)
  createEffect(on(connected, () => {
    if (dismissed() || busy()) return
    const current = ++generation
    void props.connection.fetchRuntimeSettings().then((result) => {
      if (current === generation) setRuntime(result)
    }).catch(() => { /* Retry on the next connection; the P2P panel reports request errors. */ })
  }))

  const dismiss = (): void => {
    if (busy()) return
    setDismissed(true)
    try { storage?.setItem(storageKey, '1') } catch { /* Remember for this session when storage is unavailable. */ }
  }
  const turnOff = async (): Promise<void> => {
    if (busy() || !writable()) return
    const current = ++generation
    setBusy(true)
    setError('')
    try {
      // Re-read to preserve current budgets/scope and recheck permission before writing.
      const latest = await props.connection.fetchRuntimeSettings()
      if (current !== generation) return
      setRuntime(latest)
      const value = latest.settings['p2p']?.value
      if (!writable()) throw new Error(m().readOnly)
      if (!decodeP2PSettings(value)) throw new Error(m().offFailed)
      const updated = await props.connection.updateRuntimeSetting('p2p', {
        ...value, downloadsEnabled: false, seedingEnabled: false,
      })
      if (current !== generation) return
      props.onSettingsChanged()
      if (current !== generation) return
      if (!decodeP2PSettings(updated.value) || updated.value.downloadsEnabled || updated.value.seedingEnabled) {
        throw new Error(m().offFailed)
      }
      setBusy(false)
      dismiss()
    } catch (cause) {
      if (current === generation) setError(cause instanceof Error ? cause.message : m().offFailed)
    } finally {
      if (current === generation) setBusy(false)
    }
  }

  return <Show when={!dismissed() && (settings()?.downloadsEnabled || settings()?.seedingEnabled)}>
    <ModalSurface title={m().noticeTitle} ariaLabel={`${m().noticeTitle}: ${props.backendLabel}`} modalId={modalId} testId="p2p-first-run-notice"
      describedBy={descriptionId} closeLabel={m().acknowledge} dismissBlocked={busy()} onRequestClose={dismiss}>
      <div class="p2p-first-run">
        <strong class="p2p-backend-label">{props.backendLabel}</strong>
        <p id={descriptionId}>{m().noticeIntro}</p>
        <ProductNotice tone="info">{m().disclosure}</ProductNotice>
        <p>{m().uploadDisclosure}</p>
        <dl class="p2p-card p2p-readonly-summary">
          <div><dt>{m().downloads}</dt><dd>{settings()?.downloadsEnabled ? m().enabled : m().disabled}</dd></div>
          <div><dt>{m().seeding}</dt><dd>{settings()?.seedingEnabled ? m().enabled : m().disabled}</dd></div>
          <div><dt>{m().scope}</dt><dd>{settings()?.scope === 'lan-only' ? m().lanOnly : m().internet}</dd></div>
          <div><dt>{m().stagingBudget}</dt><dd>{(settings()?.stagingBudgetBytes ?? 0) / 1024 ** 3}</dd></div>
        </dl>
        <p>{m().noticeBudgets}</p>
        <Show when={!writable()}><ProductNotice tone="warning">{m().readOnly}</ProductNotice></Show>
        <Show when={error()}><ProductNotice tone="error">{error()}</ProductNotice></Show>
        <p class="p2p-help">{m().acknowledgementHelp}</p>
      </div>
      <ProductActionFooter class="p2p-first-run-actions">
        <button type="button" disabled={busy() || !writable()} onClick={() => void turnOff()}>{m().turnOff}</button>
        <button type="button" class="primary" disabled={busy()} onClick={dismiss}>{m().acknowledge}</button>
      </ProductActionFooter>
    </ModalSurface>
  </Show>
}
