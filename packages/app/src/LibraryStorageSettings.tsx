import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { DinksterConnection, LibraryStorage } from '@dinkster/client'
import { ProductByteSizeInput, ProductConfirmation, ProductDialog, ProductErrorBanner, ProductSettingsSection, ProductSettingRow, ProductSwitch, ProductTextButton } from '@dinkster/ui'
import { useAppMessage } from './locale.js'
import { failureMessage } from './request-failure.js'

export function LibraryStorageSettings(props: {
  readonly connection: Pick<DinksterConnection, 'fetchLibraryStorage' | 'updateLibraryStorageLimit' | 'clearLibraryStorage'>
  readonly onCopyId?: (id: string) => void
}) {
  const message = useAppMessage()
  const [status, setStatus] = createSignal<LibraryStorage>()
  const [limit, setLimit] = createSignal<number | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [saveError, setSaveError] = createSignal<{ id: string; text: string }>()
  const [clearing, setClearing] = createSignal(false)
  const [confirmClear, setConfirmClear] = createSignal(false)
  const [clearError, setClearError] = createSignal('')
  const canClear = (): boolean => status()?.collectionEnabled === true && status()?.blocked.length === 0 && (status()?.reclaimableBytes ?? 0) > 0
  const bytes = (value: number | null): string => value === null ? message('storageSettings.unknown') : message('storageSettings.bytes', { count: value })
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
        setError(failureMessage(cause))
      }
    } finally {
      if (current) setBusy(false)
    }
  }
  onMount(() => { void refresh() })
  const save = async (next: number | null, id: string): Promise<void> => {
    const previous = status()
    if (busy() || !previous?.policyAvailable || next === previous.limitBytes) return
    setLimit(next)
    setBusy(true)
    setSaveError(undefined)
    try {
      await props.connection.updateLibraryStorageLimit(next)
      if (!current) return
      setStatus({ ...previous, limitBytes: next })
    } catch (cause) {
      if (current) {
        setLimit(previous.limitBytes)
        setSaveError({ id, text: failureMessage(cause) })
      }
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
    setClearError('')
    let refreshAfterClear = false
    try {
      const next = await props.connection.clearLibraryStorage()
      if (!current) return
      refreshAfterClear = next.collectionEnabled && next.blocked.length === 0
      setStatus((previous) => previous === undefined ? undefined : {
        ...previous, collectionEnabled: next.collectionEnabled, blocked: next.blocked, reclaimableBytes: null,
      })
    } catch (cause) {
      if (current) setClearError(failureMessage(cause))
    } finally {
      if (current) {
        setConfirmClear(false)
        setClearing(false)
        setBusy(false)
      }
    }
    if (current && refreshAfterClear) await refresh()
  }
  const byteFields = ['temporaryBytes', 'adoptedBytes', 'reclaimableBytes'] as const
  return <section class="dinkster-stack" data-testid="library-storage-settings">
    <Show when={error()}>{(text) => <ProductErrorBanner onDismiss={() => setError('')}>{text()}</ProductErrorBanner>}</Show>
    <Show when={status()} fallback={<p role="status">{message(busy() ? 'storageSettings.loading' : 'storageSettings.unavailable')}</p>}>
      {(loaded) => <>
        <ProductSettingsSection title={message('storageSettings.title')}>
          <dl class="dinkster-settings-facts"><For each={byteFields}>{(field) => <div>
            <dt>{message(`storageSettings.${field}`)}</dt>
            <dd><output id={`library-storage-${field}`}>{bytes(loaded()[field])}</output>
              <Show when={field === 'reclaimableBytes'}><ProductTextButton label={message('storageSettings.clear')} disabled={busy() || !canClear()} onClick={() => setConfirmClear(true)} /></Show>
            </dd>
          </div>}</For></dl>
          <For each={loaded().blocked}>{(reason) => <p class="dinkster-settings-note">{blockedReason(reason)}</p>}</For>
          <Show when={clearError()}>{(reason) => <p class="dinkster-field-error" role="alert">{reason()}</p>}</Show>
        </ProductSettingsSection>
        <ProductSettingsSection title={message('storageSettings.limitSection')}>
          <For each={['library-storage-limited', ...(limit() !== null && loaded().policyAvailable ? ['library-storage-limit'] : [])]}>{(id) => {
            const label = () => message(id === 'library-storage-limited' ? 'storageSettings.limited' : 'storageSettings.limit')
            return <ProductSettingRow id={id} label={label()} modified={false} resetLabel=""
              error={saveError()?.id === id ? saveError()?.text : undefined}
              menuLabel={message('settingsPage.actions', { name: label() })} copyIdLabel={message('runtimeSettings.page.copyId')}
              onReset={() => {}} onCopyId={() => props.onCopyId?.(id)} menuItems={[{ label: message('runtimeSettings.page.copyId'), description: id, disabled: !props.onCopyId, onSelect: () => props.onCopyId?.(id) }]}>
              <Show when={id === 'library-storage-limited'} fallback={<ProductByteSizeInput id={id} aria-label={label()} value={limit()!}
                minimum={1} disabled={busy()} aria-invalid={saveError()?.id === id ? 'true' : undefined} aria-describedby={saveError()?.id === id ? `${id}-error` : undefined}
                onCommit={(next) => { void save(next, id) }} />}>
                <ProductSwitch id={id} label={label()} checked={loaded().policyAvailable && limit() !== null} disabled={busy() || !loaded().policyAvailable}
                  aria-describedby={saveError()?.id === id ? `${id}-error` : undefined} onChange={(limited) => { void save(limited ? 21474836480 : null, id) }} />
              </Show>
            </ProductSettingRow>
          }}</For>
          <Show when={limit() !== null && loaded().temporaryBytes !== null && loaded().temporaryBytes! > limit()!}><p class="dinkster-settings-note">{message('storageSettings.overLimit')}</p></Show>
          <Show when={!loaded().policyAvailable}><p class="dinkster-settings-note" role="status">{message('storageSettings.policyUnavailable')}</p></Show>
        </ProductSettingsSection>
      </>}
    </Show>
    <Show when={!status() || !status()?.policyAvailable}><ProductTextButton label={message('storageSettings.refresh')} disabled={busy()} onClick={() => { void refresh() }} /></Show>
    <Show when={confirmClear()}><ProductDialog title={message('storageSettings.confirmTitle')} pending={clearing()} onDismiss={() => setConfirmClear(false)}>
      <ProductConfirmation consequence={message('storageSettings.confirmDescription', { size: bytes(status()?.reclaimableBytes ?? null) })} actionLabel={message('storageSettings.clear')} intent="remove" pending={clearing()} disabled={!canClear()}
        onCancel={() => setConfirmClear(false)} onConfirm={() => { void clear() }} />
    </ProductDialog></Show>
  </section>
}
