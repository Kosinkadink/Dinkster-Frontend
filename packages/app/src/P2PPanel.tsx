import { createEffect, createMemo, createSignal, createUniqueId, For, onCleanup, Show } from 'solid-js'
import { decodeP2PSettings } from '@dinkster/client'
import type {
  DinksterConnection,
  P2PSeedAuthorization,
  P2PSettings,
  P2PStatus,
  P2PTransferAction,
  P2PTransferActivity,
  RuntimeSettings,
} from '@dinkster/client'
import { ProductCheckbox } from './ProductControls.js'
import { ProductActionFooter, ProductField, ProductNotice, productFieldIds } from './ProductForm.js'
import { ProductNumberInput } from './ProductNumberInput.js'
import { ProductSelect } from './ProductSelect.js'
import { useAppMessageGroup } from './locale.js'

type P2PConnection = Pick<DinksterConnection, 'fetchRuntimeSettings' | 'updateRuntimeSetting' | 'fetchP2PStatus' | 'performP2PTransferAction'>
type CapKey = 'internetUploadBytesPerSecond' | 'internetDownloadBytesPerSecond' | 'lanUploadBytesPerSecond' | 'lanDownloadBytesPerSecond'
type NumericKey = CapKey | 'internetSeedRatio' | 'internetSeedTimeSeconds' | 'stagingBudgetBytes'

const MIB = 1024 ** 2
const GIB = 1024 ** 3
const MAX_INTEGER_SETTING = 2_147_483_647

function asP2PSettings(value: unknown): P2PSettings | undefined {
  return decodeP2PSettings(value) ? value : undefined
}

const sameSettings = (left: P2PSettings, right: P2PSettings): boolean =>
  Object.entries(left).every(([key, value]) => value === right[key as keyof P2PSettings])

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

const formatRate = (bytes: number): string => `${formatBytes(bytes)}/s`
const compactDigest = (digest: string): string => `${digest.slice(0, 15)}...${digest.slice(-6)}`
const compactId = (value: string): string => `${value.slice(0, 10)}...${value.slice(-6)}`
const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  return `${(seconds / 3600).toFixed(1)} h`
}

export function P2PPanel(props: { readonly connection: P2PConnection; readonly backendId?: string; readonly backendLabel?: string }) {
  const idPrefix = `p2p-${createUniqueId()}`
  const id = (name: string): string => `${idPrefix}-${name}`
  const m = useAppMessageGroup('p2p')
  const [runtime, setRuntime] = createSignal<RuntimeSettings>()
  const [draft, setDraft] = createSignal<P2PSettings>()
  const [status, setStatus] = createSignal<P2PStatus>()
  const [loading, setLoading] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [notice, setNotice] = createSignal('')
  const [error, setError] = createSignal('')
  const [invalid, setInvalid] = createSignal<ReadonlySet<NumericKey>>(new Set<NumericKey>())
  let generation = 0
  onCleanup(() => { generation += 1 })

  const section = () => runtime()?.settings['p2p']
  const saved = () => asP2PSettings(section()?.value)
  const writable = () => section()?.writable === true && runtime()?.categories.granted.includes('p2p') === true
  const enabled = () => saved()?.downloadsEnabled === true || saved()?.seedingEnabled === true
  const dirty = () => {
    const current = saved()
    const candidate = draft()
    return current !== undefined && candidate !== undefined && !sameSettings(current, candidate)
  }

  createEffect(() => {
    const current = saved()
    if (current !== undefined) {
      setDraft({ ...current })
      setInvalid(new Set<NumericKey>())
    }
  })

  const showError = (cause: unknown): void => {
    setNotice('')
    setError(cause instanceof Error ? cause.message : m().error)
  }

  const loadStatus = async (): Promise<void> => {
    if (!enabled()) {
      setStatus(undefined)
      return
    }
    const current = generation
    setBusy(true)
    setError('')
    try {
      const activity = await props.connection.fetchP2PStatus()
      if (current === generation) setStatus(activity)
    } catch (cause) {
      if (current === generation) showError(cause)
    } finally {
      if (current === generation) setBusy(false)
    }
  }

  const load = async (): Promise<void> => {
    const current = ++generation
    setLoading(true)
    setError('')
    setStatus(undefined)
    setRuntime(undefined)
    try {
      const result = await props.connection.fetchRuntimeSettings()
      if (current !== generation) return
      setRuntime(result)
      const initial = asP2PSettings(result.settings['p2p']?.value)
      setDraft(initial === undefined ? undefined : { ...initial })
      if (initial?.downloadsEnabled === true || initial?.seedingEnabled === true) {
        setBusy(true)
        try {
          const activity = await props.connection.fetchP2PStatus()
          if (current === generation) setStatus(activity)
        } catch (cause) {
          if (current === generation) showError(cause)
        } finally {
          if (current === generation) setBusy(false)
        }
      }
    } catch (cause) {
      if (current === generation) showError(cause)
    } finally {
      if (current === generation) {
        setBusy(false)
        setLoading(false)
      }
    }
  }
  createEffect(() => {
    void load()
  })

  const patch = <K extends keyof P2PSettings>(key: K, value: P2PSettings[K]): void => {
    setDraft((current) => current === undefined ? current : { ...current, [key]: value })
    setNotice('')
    setError('')
  }

  const changeNumber = (key: NumericKey, raw: string, scale = 1): void => {
    const parsed = Number(raw)
    const scaled = parsed * scale
    const valid = raw.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
      && (key === 'internetSeedRatio' || (Number.isSafeInteger(scaled)
        && scaled <= (key === 'stagingBudgetBytes' ? Number.MAX_SAFE_INTEGER : MAX_INTEGER_SETTING)))
    setInvalid((current) => {
      const next = new Set(current)
      if (valid) next.delete(key)
      else next.add(key)
      return next
    })
    if (valid) patch(key, scaled)
  }

  const applyCaps = (values: Pick<P2PSettings, CapKey>): void => {
    setDraft((current) => current === undefined ? current : { ...current, ...values })
    setInvalid((current) => new Set([...current].filter((key) => !(
      key === 'internetUploadBytesPerSecond' || key === 'internetDownloadBytesPerSecond'
      || key === 'lanUploadBytesPerSecond' || key === 'lanDownloadBytesPerSecond'
    ))))
    setNotice('')
    setError('')
  }

  const reset = (): void => {
    const current = saved()
    if (current !== undefined) setDraft({ ...current })
    setInvalid(new Set<NumericKey>())
    setNotice('')
    setError('')
  }

  const save = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault()
    const candidate = draft()
    if (candidate === undefined || !writable() || !dirty() || invalid().size > 0 || busy()) return
    const current = generation
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const updated = await props.connection.updateRuntimeSetting('p2p', candidate)
      if (current !== generation) return
      setRuntime((current) => current === undefined
        ? current
        : { ...current, settings: { ...current.settings, p2p: updated } })
      setNotice(m().saved)
      if (candidate.downloadsEnabled || candidate.seedingEnabled) {
        const activity = await props.connection.fetchP2PStatus()
        if (current === generation) setStatus(activity)
      } else {
        setStatus(undefined)
      }
    } catch (cause) {
      if (current === generation) showError(cause)
    } finally {
      if (current === generation) setBusy(false)
    }
  }

  const act = async (digest: string, action: P2PTransferAction): Promise<void> => {
    if (!writable() || busy()) return
    const current = generation
    if (action === 'reset-budget' || action === 'continuous-seed') {
      const transfer = status()?.sidecar?.transfers.find((item) => item.digest === digest)
      if (saved()?.seedingEnabled !== true
        || transfer?.seedAuthorizations.some((authorization) => authorization.state === 'active') !== true) return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await props.connection.performP2PTransferAction(digest, action)
      if (current !== generation) return
      const activity = await props.connection.fetchP2PStatus()
      if (current === generation) setStatus(activity)
    } catch (cause) {
      if (current === generation) showError(cause)
    } finally {
      if (current === generation) setBusy(false)
    }
  }

  const localizedState = (value: P2PTransferActivity['state'] | NonNullable<P2PStatus['sidecar']>['state'] | P2PStatus['state']): string => {
    const key: Readonly<Record<string, keyof ReturnType<typeof m> | undefined>> = {
      disabled: 'stopped',
      stopped: 'stopped',
      starting: 'starting',
      restarting: 'starting',
      running: 'running',
      crashed: 'crashed',
      failed: 'crashed',
      queued: 'queued',
      downloading: 'downloading',
      seeding: 'seedingState',
      paused: 'paused',
      complete: 'complete',
      error: 'failed',
    }
    return m()[key[value] ?? 'unknown']
  }

  const sidecarState = (activity: P2PStatus): Parameters<typeof localizedState>[0] =>
    activity.sidecar?.state ?? activity.state

  const localizedCost = (value: P2PStatus['network']['system']): string => m()[value]
  const localizedAuthorization = (value: P2PSeedAuthorization['state']): string => m()[({
    active: 'authorizationActive',
    inactive: 'authorizationInactive',
    revoked: 'authorizationRevoked',
  } as const)[value]]
  const localizedEvidence = (value: NonNullable<P2PSeedAuthorization['grant']>['evidenceType']): string => m()[({
    'public-acquisition-receipt': 'acquisitionReceipt',
    'provider-enumeration': 'providerEnumeration',
    'consented-set': 'consentedSet',
    'manual-attestation': 'manualAttestation',
  } as const)[value]]

  const canChangeSeedPolicy = (transfer: P2PTransferActivity): boolean =>
    saved()?.seedingEnabled === true
    && transfer.seedAuthorizations.some((authorization) => authorization.state === 'active')

  const numberField = (key: NumericKey, label: string, value: number, scale = 1, step = 1) => {
    const controlId = id(key)
    const ids = productFieldIds(controlId)
    const hasError = () => invalid().has(key)
    return <ProductField
      controlId={controlId}
      label={label}
      layout="stack"
      invalid={hasError()}
      message={hasError() ? m().invalidNumber : undefined}
    >
      <ProductNumberInput
        id={controlId}
        ariaLabelledBy={ids.label}
        ariaDescribedBy={hasError() ? ids.message : undefined}
        ariaInvalid={hasError()}
        disabled={!writable() || busy()}
        min={0}
        max={key === 'internetSeedRatio' ? undefined : (key === 'stagingBudgetBytes' ? Number.MAX_SAFE_INTEGER : MAX_INTEGER_SETTING) / scale}
        step={step}
        value={value / scale}
        onCommit={(raw) => changeNumber(key, raw, scale)}
      />
    </ProductField>
  }

  return (
    <section class="p2p-panel" data-testid="p2p-panel" data-backend={props.backendId} aria-labelledby={id('title')}>
      <header class="p2p-heading">
        <div>
          <h2 id={id('title')}>{m().title}</h2>
          <Show when={props.backendLabel}><p class="p2p-backend-label">{props.backendLabel}</p></Show>
          <p class="p2p-disclosure">{m().disclosure}</p>
        </div>
      </header>

      <Show when={!loading()} fallback={<p role="status">{m().loading}</p>}>
        <Show when={draft()} fallback={<ProductNotice tone="error">{error() || m().error}</ProductNotice>}>
          {(settings) => <>
            <Show when={!writable()}><ProductNotice tone="warning">{m().readOnly}</ProductNotice></Show>
            <Show when={writable()} fallback={<dl class="p2p-card p2p-readonly-summary">
              <div><dt>{m().downloads}</dt><dd>{settings().downloadsEnabled ? m().enabled : m().disabled}</dd></div>
              <div><dt>{m().seeding}</dt><dd>{settings().seedingEnabled ? m().enabled : m().disabled}</dd></div>
              <div><dt>{m().scope}</dt><dd>{settings().scope === 'lan-only' ? m().lanOnly : m().internet}</dd></div>
              <div><dt>{m().meteredPause}</dt><dd>{settings().pauseOnMetered ? m().enabled : m().disabled}</dd></div>
              <div><dt>{m().seedMode}</dt><dd>{settings().seedMode === 'budgeted' ? m().budgeted : m().continuous}</dd></div>
              <div><dt>{m().stagingBudget}</dt><dd>{settings().stagingBudgetBytes / GIB}</dd></div>
            </dl>}>
            <form onSubmit={(event) => void save(event)}>
            <fieldset class="p2p-card p2p-sharing" disabled={!writable() || busy()}>
              <legend>{m().sharingLegend}</legend>
              <ProductField
                controlId={id('enabled')}
                label={m().sharing}
                metadata={<span class="p2p-setting-state">{settings().downloadsEnabled || settings().seedingEnabled ? m().enabled : m().disabled}</span>}
              >
                <ProductCheckbox
                  id={id('enabled')}
                  ariaLabel={m().sharing}
                  checked={settings().downloadsEnabled || settings().seedingEnabled}
                  onChange={(value) => setDraft((current) => current === undefined ? current : {
                    ...current,
                    downloadsEnabled: value,
                    seedingEnabled: value,
                  })}
                />
              </ProductField>
              <p class="p2p-help">{saved()?.seedingEnabled ? m().sharingHelpOn : m().sharingHelpOff}</p>
              <ProductNotice tone="info" class="p2p-upload-disclosure">{m().uploadDisclosure}</ProductNotice>
              <ProductField controlId={id('scope')} label={m().scope} layout="stack">
                <ProductSelect
                  id={id('scope')}
                  ariaLabel={m().scope}
                  disabled={!writable() || busy()}
                  selectedId={settings().scope}
                  options={[
                    { id: 'lan-only', label: m().lanOnly, value: 'lan-only' as const },
                    { id: 'lan-and-internet', label: m().internet, value: 'lan-and-internet' as const },
                  ]}
                  onSelect={(option) => patch('scope', option.value)}
                />
              </ProductField>
            </fieldset>

            <div class="p2p-settings-grid">
              <fieldset class="p2p-card p2p-limits">
                <legend>{m().limitsLegend}</legend>
                <p class="p2p-help">{m().capsHelp}</p>
                <div class="p2p-number-grid">
                  {numberField('lanDownloadBytesPerSecond', m().lanDownloadCap, settings().lanDownloadBytesPerSecond, MIB)}
                  {numberField('lanUploadBytesPerSecond', m().lanUploadCap, settings().lanUploadBytesPerSecond, MIB)}
                  {numberField('internetDownloadBytesPerSecond', m().internetDownloadCap, settings().internetDownloadBytesPerSecond, MIB)}
                  {numberField('internetUploadBytesPerSecond', m().internetUploadCap, settings().internetUploadBytesPerSecond, MIB)}
                </div>
                <div class="p2p-presets" role="group" aria-label={m().presets}>
                  <button type="button" disabled={!writable() || busy()} onClick={() => applyCaps({
                    lanDownloadBytesPerSecond: 0,
                    lanUploadBytesPerSecond: 0,
                    internetDownloadBytesPerSecond: settings().internetDownloadBytesPerSecond,
                    internetUploadBytesPerSecond: settings().internetUploadBytesPerSecond,
                  })}>{m().lanUnlimited}</button>
                  <button type="button" disabled={!writable() || busy()} onClick={() => applyCaps({
                    lanDownloadBytesPerSecond: 0,
                    lanUploadBytesPerSecond: 0,
                    internetDownloadBytesPerSecond: 0,
                    internetUploadBytesPerSecond: 5 * MIB,
                  })}>{m().balancedInternet}</button>
                  <button type="button" disabled={!writable() || busy()} onClick={() => applyCaps({
                    lanDownloadBytesPerSecond: 5 * MIB,
                    lanUploadBytesPerSecond: MIB,
                    internetDownloadBytesPerSecond: 5 * MIB,
                    internetUploadBytesPerSecond: MIB,
                  })}>{m().lowBandwidth}</button>
                </div>
              </fieldset>

              <fieldset class="p2p-card">
                <legend>{m().diskLegend}</legend>
                {numberField('stagingBudgetBytes', m().stagingBudget, settings().stagingBudgetBytes, GIB, 0.5)}
                <p class="p2p-help">{m().stagingHelp}</p>
              </fieldset>

              <fieldset class="p2p-card">
                <legend>{m().networkLegend}</legend>
                <ProductField controlId={id('metered')} label={m().meteredPause}>
                  <ProductCheckbox
                    id={id('metered')}
                    ariaLabel={m().meteredPause}
                    disabled={!writable() || busy()}
                    checked={settings().pauseOnMetered}
                    onChange={(value) => patch('pauseOnMetered', value)}
                  />
                </ProductField>
                <ProductField controlId={id('network-override')} label={m().override} layout="stack">
                  <ProductSelect
                    id={id('network-override')}
                    ariaLabel={m().override}
                    disabled={!writable() || busy()}
                    selectedId={settings().networkCostOverride}
                    options={[
                      { id: 'auto', label: m().auto, value: 'auto' as const },
                      { id: 'metered', label: m().metered, value: 'metered' as const },
                      { id: 'unmetered', label: m().unmetered, value: 'unmetered' as const },
                    ]}
                    onSelect={(option) => patch('networkCostOverride', option.value)}
                  />
                </ProductField>
              </fieldset>

              <fieldset class="p2p-card">
                <legend>{m().seedLegend}</legend>
                <ProductField controlId={id('seed-mode')} label={m().seedMode} layout="stack">
                  <ProductSelect
                    id={id('seed-mode')}
                    ariaLabel={m().seedMode}
                    disabled={!writable() || busy()}
                    selectedId={settings().seedMode}
                    options={[
                      { id: 'budgeted', label: m().budgeted, value: 'budgeted' as const },
                      { id: 'continuous', label: m().continuous, value: 'continuous' as const },
                    ]}
                    onSelect={(option) => patch('seedMode', option.value)}
                  />
                </ProductField>
                <Show when={settings().seedMode === 'budgeted'}>
                  {numberField('internetSeedRatio', m().ratio, settings().internetSeedRatio, 1, 0.1)}
                  {numberField('internetSeedTimeSeconds', m().hours, settings().internetSeedTimeSeconds, 3600, 0.5)}
                  <p class="p2p-help">{m().seedDefault}</p>
                </Show>
              </fieldset>
            </div>

            <ProductActionFooter status={busy() ? m().working : dirty() ? m().unsavedChanges : m().noChanges}>
              <button type="button" disabled={!dirty() || busy()} onClick={reset}>{m().resetChanges}</button>
              <button type="submit" class="primary" disabled={!writable() || !dirty() || invalid().size > 0 || busy()}>{m().save}</button>
            </ProductActionFooter>
            </form>
            </Show>
          </>}
        </Show>
      </Show>

      <Show when={notice()}><ProductNotice tone="status">{notice()}</ProductNotice></Show>
      <Show when={error()}><ProductNotice tone="error">{error()}</ProductNotice></Show>

      <Show when={enabled()}>
        <section class="p2p-runtime" aria-labelledby={id('runtime-title')}>
          <header class="p2p-runtime-heading">
            <h3 id={id('runtime-title')}>{m().status}</h3>
            <button type="button" disabled={busy()} onClick={() => void loadStatus()}>{m().refresh}</button>
          </header>
          <Show when={status()}>
            {(activity) => <>
              <div class="p2p-summary-grid">
                <article class="p2p-summary-card">
                  <span>{m().sidecar}</span>
                  <strong>{localizedState(sidecarState(activity()))}</strong>
                </article>
                <article class="p2p-summary-card">
                  <span>{m().systemCost}</span>
                  <strong>{localizedCost(activity().network.system)}</strong>
                </article>
                <article class="p2p-summary-card">
                  <span>{m().effectiveCost}</span>
                  <strong>{localizedCost(activity().network.effective)}</strong>
                </article>
              </div>
              <ProductNotice tone={activity().network.paused ? 'warning' : 'status'}>
                {activity().network.paused ? m().allPaused : m().lanAllowed}
              </ProductNotice>
              <Show when={activity().sidecar?.global}>{(global) => <ProductNotice tone={global().active ? 'status' : 'info'}>
                {global().active ? m().globalActive : `${m().globalClosed} ${global().closureReason ?? m().unknown}`}
              </ProductNotice>}</Show>
              <div class="p2p-total-bar" aria-label={m().totals}>
                <strong>{m().totals}</strong>
                <span>{m().downloaded}: {formatBytes(activity().sidecar?.totals.downloadedBytes ?? 0)}</span>
                <span>{m().uploaded}: {formatBytes(activity().sidecar?.totals.uploadedBytes ?? 0)}</span>
              </div>
              <h4>{m().transfers}</h4>
              <Show when={(activity().sidecar?.transfers.length ?? 0) > 0} fallback={<p>{m().noTransfers}</p>}>
                <div class="p2p-transfer-list">
                  <For each={activity().sidecar?.transfers ?? []}>{(transfer) => <article class="p2p-transfer" data-testid="p2p-transfer">
                    <header>
                      <code title={transfer.digest} aria-label={transfer.digest}>{compactDigest(transfer.digest)}</code>
                      <span class="p2p-state" data-state={transfer.state}>{localizedState(transfer.state)}</span>
                    </header>
                    <dl class="p2p-transfer-details">
                      <div><dt>{m().size}</dt><dd>{formatBytes(transfer.sizeBytes)}</dd></div>
                      <div><dt>{m().peers}</dt><dd>{transfer.peers}</dd></div>
                      <div><dt>{m().rates}</dt><dd>{formatRate(transfer.downloadRateBytesPerSecond)} {m().down} / {formatRate(transfer.uploadRateBytesPerSecond)} {m().up}</dd></div>
                      <div><dt>{m().transferTotals}</dt><dd>{formatBytes(transfer.downloadedBytes)} / {formatBytes(transfer.uploadedBytes)}</dd></div>
                      <div><dt>{m().partialDisk}</dt><dd>{formatBytes(transfer.partialBytes)}</dd></div>
                      <div><dt>{m().seedAuthorization}</dt><dd>
                        <Show when={transfer.seedAuthorizations.length > 0} fallback={m().noSeedAuthorization}>
                          <ul class="p2p-authorization-list">
                            <For each={transfer.seedAuthorizations}>{(authorization) => <li class="p2p-authorization" data-state={authorization.state}>
                              <strong>{localizedAuthorization(authorization.state)}</strong>
                              <span>{m().grant}: <code title={authorization.grantId} aria-label={authorization.grantId}>{compactId(authorization.grantId)}</code></span>
                              <Show when={authorization.grant}>{(grant) => <>
                                <span>{m().source}: {grant().sourceType} {grant().sourceId}</span>
                                <span>{m().license}: {grant().license || m().licenseUnspecified}</span>
                                <span>{m().evidence}: {localizedEvidence(grant().evidenceType)} <code title={grant().evidenceId} aria-label={grant().evidenceId}>{compactId(grant().evidenceId)}</code></span>
                              </>}</Show>
                            </li>}</For>
                          </ul>
                        </Show>
                      </dd></div>
                      <div><dt>{m().remainingBudget}</dt><dd>{transfer.remainingSeedRatio === null && transfer.remainingSeedTimeSeconds === null
                        ? m().noBudget
                        : [
                            transfer.remainingSeedRatio === null ? undefined : `${transfer.remainingSeedRatio.toFixed(2)} ${m().ratioRemaining}`,
                            transfer.remainingSeedTimeSeconds === null ? undefined : `${formatDuration(transfer.remainingSeedTimeSeconds)} ${m().timeRemaining}`,
                          ].filter(Boolean).join(' / ')}</dd></div>
                    </dl>
                    <Show when={writable()}><footer class="p2p-transfer-actions">
                      <Show when={transfer.state === 'paused' || transfer.state === 'stopped' || transfer.state === 'error'}>
                        <button type="button" disabled={busy()} onClick={() => void act(transfer.digest, 'resume')}>{m().resume}</button>
                      </Show>
                      <Show when={transfer.state === 'queued' || transfer.state === 'downloading' || transfer.state === 'seeding'}>
                        <button type="button" disabled={busy()} onClick={() => void act(transfer.digest, 'pause')}>{m().pause}</button>
                      </Show>
                      <Show when={transfer.state !== 'stopped' && transfer.state !== 'complete'}>
                        <button type="button" disabled={busy()} onClick={() => void act(transfer.digest, 'stop')}>{m().stop}</button>
                      </Show>
                      <Show when={transfer.partialBytes > 0 && transfer.state !== 'downloading' && transfer.state !== 'seeding'}>
                        <button type="button" disabled={busy()} onClick={() => void act(transfer.digest, 'remove-partial')}>{m().removePartial}</button>
                      </Show>
                      <Show when={canChangeSeedPolicy(transfer) && (transfer.remainingSeedRatio !== null || transfer.remainingSeedTimeSeconds !== null)}>
                        <button type="button" disabled={busy()} onClick={() => void act(transfer.digest, 'reset-budget')}>{m().resetBudget}</button>
                        <button type="button" disabled={busy()} onClick={() => void act(transfer.digest, 'continuous-seed')}>{m().continuousSeed}</button>
                      </Show>
                    </footer></Show>
                  </article>}</For>
                </div>
              </Show>
            </>}
          </Show>
        </section>
      </Show>
    </section>
  )
}
