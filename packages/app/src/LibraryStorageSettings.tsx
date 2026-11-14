import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { DinksterConnection, LibraryStorage, LibraryStorageCleanup } from '@dinkster/client'
import { ProductButton, ProductCheckbox } from './ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from './ProductForm.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { useAppMessage } from './locale.js'

export function LibraryStorageSettings(props: {
  readonly connection: Pick<DinksterConnection, 'fetchLibraryStorage' | 'updateLibraryStorageLimit' | 'clearLibraryStorage'>
}) {
  const message = useAppMessage()
  const [status, setStatus] = createSignal<LibraryStorage>()
  const [limit, setLimit] = createSignal<number | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [clearing, setClearing] = createSignal(false)
  const [result, setResult] = createSignal<LibraryStorageCleanup>()
  const canClear = (): boolean => status()?.collectionEnabled === true && status()?.blocked.length === 0
  const blockedReason = (reason: string): string => reason === 'owner_completeness_unknown'
    ? message('storageSettings.ownerCompletenessUnknown')
    : message('storageSettings.backendBlocked', { reason: reason.replaceAll('_', ' ') })
  let current = true
  onCleanup(() => { current = false })
  const refresh = async (): Promise<void> => {
    if (busy()) return
    setBusy(true)
    setError('')
    try {
      const next = await props.connection.fetchLibraryStorage()
      if (!current) return
      setStatus(next)
      setLimit(next.limitBytes)
    } catch (cause) {
      if (current) {
        setStatus(undefined)
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (current) setBusy(false)
    }
  }
  onMount(() => { void refresh() })
  const save = async (): Promise<void> => {
    if (busy() || !status()?.policyAvailable || limit() === status()?.limitBytes) return
    setBusy(true)
    setError('')
    try {
      await props.connection.updateLibraryStorageLimit(limit())
      if (!current) return
      setStatus(undefined)
    } catch (cause) {
      if (current) setError(cause instanceof Error ? cause.message : String(cause))
      return
    } finally {
      if (current) setBusy(false)
    }
    if (current) await refresh()
  }
  const clear = async (): Promise<void> => {
    if (busy() || !canClear()) return
    setBusy(true)
    setClearing(true)
    setError('')
    setResult(undefined)
    try {
      const next = await props.connection.clearLibraryStorage()
      if (!current) return
      setResult(next)
      setStatus((previous) => previous === undefined ? undefined : {
        ...previous, collectionEnabled: next.collectionEnabled, blocked: next.blocked, reclaimableBytes: null,
      })
    } catch (cause) {
      if (current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current) {
        setClearing(false)
        setBusy(false)
      }
    }
    if (current && result()?.collectionEnabled) await refresh()
  }
  const ids = productFieldIds('library-storage-limit')
  const byteFields = ['temporaryBytes', 'vaultBytes', 'adoptedBytes', 'reclaimableBytes'] as const
  return <section class="runtime-settings library-storage-settings" data-testid="library-storage-settings">
    <div class="runtime-settings-body">
      <h2>{message('storageSettings.title')}</h2>
      <p>{message('storageSettings.description')}</p>
      <Show when={status() && !canClear()}><ProductNotice tone="info">{message('storageSettings.blocked')}</ProductNotice></Show>
      <Show when={clearing()}><ProductNotice tone="status">{message('storageSettings.clearing')}</ProductNotice></Show>
      <Show when={result()}>{(finished) => <ProductNotice tone="status">{message('storageSettings.cleared', {
        bytes: finished().reclaimedBytes, files: finished().reclaimedFiles,
      })}</ProductNotice>}</Show>
      <Show when={error()}>{(text) => <p role="alert">{text()}</p>}</Show>
      <Show when={status()} fallback={<p role="status">{message(busy() ? 'storageSettings.loading' : 'storageSettings.unavailable')}</p>}>
        {(loaded) => <>
          <For each={byteFields}>{(field) => <ProductField layout="compact" controlId={`library-storage-${field}`} label={message(`storageSettings.${field}`)}>
            <output id={`library-storage-${field}`}>{loaded()[field] === null ? message('storageSettings.unknown') : message('storageSettings.bytes', { count: loaded()[field]! })}</output>
          </ProductField>}</For>
          <Show when={loaded().blocked.length > 0}>
            <ul><For each={loaded().blocked}>{(reason) => <li>{blockedReason(reason)}</li>}</For></ul>
          </Show>
          <ProductField controlId="library-storage-unlimited" label={message('storageSettings.unlimited')}>
            <ProductCheckbox id="library-storage-unlimited" ariaLabel={message('storageSettings.unlimited')}
              checked={loaded().policyAvailable && limit() === null} disabled={busy() || !loaded().policyAvailable}
              onChange={(unlimited) => setLimit(unlimited ? null : loaded().limitBytes ?? 21474836480)} />
          </ProductField>
          <Show when={limit() !== null && loaded().policyAvailable}>
            <ProductField controlId="library-storage-limit" label={message('storageSettings.limit')}>
              <ProductNumberInput id="library-storage-limit" ariaLabelledBy={ids.label} value={limit()!}
                min={1} max={Number.MAX_SAFE_INTEGER} integer disabled={busy()}
                onCommit={(raw) => { const value = Number(raw); if (Number.isSafeInteger(value) && value > 0) setLimit(value) }} />
            </ProductField>
          </Show>
          <Show when={!loaded().policyAvailable}><p role="status">{message('storageSettings.policyUnavailable')}</p></Show>
        </>}
      </Show>
      <ProductActionFooter>
        <ProductButton disabled={busy()} onClick={() => { void refresh() }}>{message('storageSettings.refresh')}</ProductButton>
        <ProductButton disabled={busy() || !status()?.policyAvailable || limit() === status()?.limitBytes}
          onClick={() => { void save() }}>{message('storageSettings.apply')}</ProductButton>
        <ProductButton disabled={busy() || !canClear()} title={canClear() ? undefined : message('storageSettings.blocked')}
          onClick={() => { void clear() }}>{message('storageSettings.clear')}</ProductButton>
      </ProductActionFooter>
    </div>
  </section>
}
