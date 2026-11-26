import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { DinksterConnection, LibraryStorage, LibraryStorageCleanup } from '@dinkster/client'
import { ProductConfirmation, ProductDialog, ProductErrorBanner, ProductSettingsSection, ProductSettingRow, ProductSwitch, ProductTextButton, ProductToast } from '@dinkster/ui'
import { ProductNumberInput } from './ProductNumberInput.js'
import { useAppMessage } from './locale.js'

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
  const [result, setResult] = createSignal<LibraryStorageCleanup>()
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
        setError(cause instanceof Error ? cause.message : String(cause))
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
        setSaveError({ id, text: cause instanceof Error ? cause.message : String(cause) })
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
    setError('')
    setResult(undefined)
    try {
      const next = await props.connection.clearLibraryStorage()
      if (!current) return
      setResult(next.collectionEnabled && next.blocked.length === 0 ? next : undefined)
      setStatus((previous) => previous === undefined ? undefined : {
        ...previous, collectionEnabled: next.collectionEnabled, blocked: next.blocked, reclaimableBytes: null,
      })
    } catch (cause) {
      if (current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (current) {
        setConfirmClear(false)
        setClearing(false)
        setBusy(false)
      }
    }
    if (current && result()?.collectionEnabled) await refresh()
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
        </ProductSettingsSection>
        <ProductSettingsSection title={message('storageSettings.limitSection')}>
          <For each={['library-storage-limited', ...(limit() !== null && loaded().policyAvailable ? ['library-storage-limit'] : [])]}>{(id) => {
            const label = () => message(id === 'library-storage-limited' ? 'storageSettings.limited' : 'storageSettings.limit')
            return <ProductSettingRow id={id} label={label()} modified={false} resetLabel="" resetDefaultLabel=""
              error={saveError()?.id === id ? saveError()?.text : undefined}
              menuLabel={message('settingsPage.actions', { name: label() })} copyIdLabel={message('runtimeSettings.page.copyId')}
              onReset={() => {}} onCopyId={() => props.onCopyId?.(id)} menuItems={[{ label: message('runtimeSettings.page.copyId'), description: id, disabled: !props.onCopyId, onSelect: () => props.onCopyId?.(id) }]}>
              <Show when={id === 'library-storage-limited'} fallback={<ProductNumberInput id={id} ariaLabel={label()} unit="B" value={limit()!}
                min={1} max={Number.MAX_SAFE_INTEGER} integer disabled={busy()} ariaInvalid={saveError()?.id === id} ariaDescribedBy={saveError()?.id === id ? `${id}-error` : undefined}
                onCommit={(raw) => { const next = Number(raw); if (Number.isSafeInteger(next) && next > 0) void save(next, id) }} />}>
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
    <ProductToast notification={result() ? { message: message('storageSettings.cleared', { bytes: result()!.reclaimedBytes, files: result()!.reclaimedFiles }) } : undefined} onDismiss={() => setResult(undefined)} />
  </section>
}
