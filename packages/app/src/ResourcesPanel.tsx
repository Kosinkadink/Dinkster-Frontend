import { For, Show, createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import type { DinksterConnection, MemoryGovernorDevice, MemoryStatus, RuntimeSettings } from '@dinkster/client'
import { ProductButton, ProductDisclosure, ProductErrorBanner, ProductFacts, ProductNotice, ProductResourceUsage, ProductToast, type ProductResourceSample, type ProductResourceSegment } from '@dinkster/ui'
import { MemoryStatusController } from './memory-status.js'
import { ProductSlider } from './ProductSlider.js'
import { useSignal } from './solid-adapter.js'
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel.js'
import { useAppMessage } from './locale.js'

interface ResourceBackend {
  readonly id: string
  readonly label: string
  readonly connection: DinksterConnection
}

const gb = (bytes: number): string => `${(bytes / 1_000_000_000).toFixed(1)} GB`
const cardUsed = (device: MemoryGovernorDevice): number | undefined => device.measured === null ? undefined : Math.max(0, device.measured.totalBytes - (device.measured.driverFreeBytes ?? device.measured.freeBytes))

export function ResourcesPanel(props: { readonly backends: readonly ResourceBackend[]; readonly activeBackendId: string; readonly focusBackend?: { readonly id: string } | undefined }) {
  return <div class="dinkster-resources" data-testid="resources-panel">
    <For each={props.backends}>{(backend) => <BackendResources backend={backend} initiallyOpen={backend.id === props.activeBackendId} focusBackend={props.focusBackend} />}</For>
  </div>
}

function BackendResources(props: { readonly backend: ResourceBackend; readonly initiallyOpen: boolean; readonly focusBackend: { readonly id: string } | undefined }) {
  const message = useAppMessage()
  const connection = () => props.backend.connection
  const connectionState = useSignal(connection().status)
  const [open, setOpen] = createSignal(props.initiallyOpen)
  const [status, setStatus] = createSignal<MemoryStatus>()
  const [details, setDetails] = createSignal<MemoryStatus['consumerDetails']>()
  const [settings, setSettings] = createSignal<RuntimeSettings>()
  const [error, setError] = createSignal('')
  const [telemetryError, setTelemetryError] = createSignal('')
  const [budgetDraft, setBudgetDraft] = createSignal<Readonly<Record<string, number>>>({})
  const [headroomDraft, setHeadroomDraft] = createSignal<number>()
  const [notification, setNotification] = createSignal<{ message: string }>()
  const [pending, setPending] = createSignal(false)
  const [clock, setClock] = createSignal(Date.now())
  const [receivedAt, setReceivedAt] = createSignal(0)
  const [history, setHistory] = createSignal<Readonly<Record<string, readonly ProductResourceSample[]>>>({})
  const [confirmUnload, setConfirmUnload] = createSignal<(() => Promise<unknown>)>()
  let controller: MemoryStatusController | undefined
  const stale = () => connectionState() !== 'connected' || clock() - receivedAt() > 6000
  const cards = () => Object.keys(status()?.memoryGovernor ?? {}).filter((device) => device.startsWith('vram:') || device.startsWith('cuda:'))
  const usedOfTotal = (used: number, total: number) => message('resources.usedOfTotal', { used: gb(used), total: gb(total) })
  const aggregate = () => {
    const rows = cards().map((device) => status()!.memoryGovernor![device]!)
    if (rows.length === 0 || rows.some((row) => cardUsed(row) === undefined)) return undefined
    return usedOfTotal(rows.reduce((sum, row) => sum + cardUsed(row)!, 0), rows.reduce((sum, row) => sum + row.measured!.totalBytes, 0))
  }
  const accept = (next: MemoryStatus, isDetails: boolean): void => {
    if (isDetails) { setDetails(next.consumerDetails); return }
    setStatus(next)
    setReceivedAt(Date.now())
    setClock(Date.now())
    setTelemetryError('')
    if (connectionState() !== 'connected') return
    setHistory((previous) => Object.fromEntries(Object.entries(next.memoryGovernor ?? {}).flatMap(([device, row]) => {
      const used = cardUsed(row)
      if (used === undefined) return []
      const samples = (previous[device] ?? []).filter((sample) => sample.timestamp > Date.now() - 120_000)
      if (Date.now() - (samples.at(-1)?.timestamp ?? 0) >= 1000) samples.push({ timestamp: Date.now(), used })
      return [[device, samples.slice(-120)]]
    })))
    if (open()) controller?.refreshDetails()
  }
  onMount(() => {
    controller = new MemoryStatusController(connection(), accept, (cause) => setTelemetryError(String(cause)))
    controller.setExpanded('resources', open())
    void connection().fetchRuntimeSettings().then(setSettings, () => {})
    const timer = setInterval(() => setClock(Date.now()), 1000)
    onCleanup(() => { controller?.dispose(); clearInterval(timer) })
  })
  createEffect(() => {
    if (props.focusBackend?.id !== props.backend.id) return
    setOpen(true)
    controller?.setExpanded('resources', true)
  })
  const toggle = () => {
    const next = !open()
    setOpen(next)
    controller?.setExpanded('resources', next)
  }
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    if (pending() || stale()) return
    setPending(true)
    setError('')
    try {
      await run()
      accept(await connection().fetchMemoryStatus(), false)
      controller?.refreshDetails()
      setNotification({ message: message('resources.updated') })
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setPending(false); setConfirmUnload(undefined) }
  }
  const granted = (category: string) => settings()?.categories.granted.includes(category) === true && settings()?.settings[category]?.writable === true
  const limit = (device: string) => status()?.acceleratorPolicy?.devices[device]?.governorAdmission.effectiveBudgetBytes ?? status()?.memoryGovernor?.[device]?.budgetBytes ?? undefined
  const update = async (category: string, value: unknown): Promise<void> => {
    await act(async () => {
      const section = await connection().updateRuntimeSetting(category, value)
      setSettings((current) => current ? { ...current, settings: { ...current.settings, [category]: section } } : current)
    })
    if (category === 'memory-budgets') setBudgetDraft({})
    if (category === 'memory-headroom') setHeadroomDraft(undefined)
  }
  const models = (device: string) => Object.entries(details() ?? {}).flatMap(([consumer, items]) => items.filter((item) => (item.bytesByResidency[device] ?? 0) > 0).map((item) => ({ key: JSON.stringify([consumer, item.itemId]), consumer, item, bytes: item.bytesByResidency[device]! })))
  const segments = (device: string): readonly ProductResourceSegment[] => {
    const row = status()!.memoryGovernor![device]!
    const used = cardUsed(row)
    if (used === undefined) return []
    const reserved = row.measured?.torchReservedBytes
    const allocated = row.measured?.torchAllocatedBytes
    const loaded = models(device).reduce((sum, model) => sum + model.bytes, 0)
    if (details() === undefined || reserved === undefined || allocated === undefined || allocated > reserved || reserved > used || loaded + reserved - allocated > used) return [{ label: message('resources.used'), value: used, tone: 'other' }]
    const held = reserved - allocated
    return [{ label: message('resources.models'), value: loaded, tone: 'models' }, { label: message('resources.heldUnused'), value: held, tone: 'held' }, { label: message('resources.otherMemory'), value: used - loaded - held, tone: 'other' }]
  }
  const unload = () => cards().filter((device) => Object.keys(status()?.memoryGovernor?.[device]?.consumers ?? {}).length > 0)
  return <section class="dinkster-resource-backend" data-backend={props.backend.id}>
    <div class="dinkster-resource-backend-toggle"><ProductButton disabled={connectionState() !== 'connected'} aria-expanded={connectionState() === 'connected' && open()} onClick={toggle}>
      <span>{connectionState() === 'connected' ? open() ? 'v' : '>' : ''} {props.backend.label}</span>
      <span class="dinkster-metadata">{connectionState() === 'connected' ? aggregate() : message('resources.disconnected')}</span>
    </ProductButton></div>
    <Show when={connectionState() === 'connected' && open()}>
      <div class="dinkster-stack">
        <Show when={error() || telemetryError()}><ProductErrorBanner onDismiss={() => { setError(''); setTelemetryError('') }}>{error() || telemetryError()}</ProductErrorBanner></Show>
        <Show when={!status()}><span class="dinkster-metadata" role="status">{message('resources.loading')}</span></Show>
        <Show when={status() && stale()}><ProductNotice>{message('resources.stale')}</ProductNotice></Show>
        <For each={cards()}>{(device, index) => {
          const row = () => status()!.memoryGovernor![device]!
          const name = () => row().measured?.gpuName ?? device
          return <section class="dinkster-resource-card" aria-label={name()}>
            <header class="dinkster-resource-card-heading"><strong>{name()}<Show when={cards().length > 1}><span class="dinkster-metadata"> {message('resources.cardPosition', { number: index() + 1, count: cards().length })}</span></Show></strong><Show when={cardUsed(row()) !== undefined}><span>{usedOfTotal(cardUsed(row())!, row().measured!.totalBytes)}</span></Show></header>
            <Show when={row().measured}>{(measured) => <ProductResourceUsage label={message('resources.cardMemory', { name: name() })} total={measured().totalBytes} segments={segments(device)} samples={history()[device] ?? []} now={clock()} {...(limit(device) === undefined ? {} : { limit: limit(device)! })} format={gb} historyLabel={message('resources.history')} limitLabel={message('resources.limit')} compact={cards().length > 1} />}</Show>
            <div class="dinkster-resource-live dinkster-metadata">
              <Show when={row().measured?.gpuUtilizationPercent !== undefined}><span>{message('resources.busy', { percent: row().measured!.gpuUtilizationPercent! })}</span></Show>
              <Show when={row().measured?.gpuTemperatureCelsius !== undefined}><span>{message('resources.temperature', { value: row().measured!.gpuTemperatureCelsius! })}</span></Show>
              <Show when={row().measured?.gpuPowerMilliwatts !== undefined}><span>{message('resources.power', { value: (row().measured!.gpuPowerMilliwatts! / 1000).toFixed(0) })}</span></Show>
            </div>
            <Show when={details() !== undefined && models(device).length > 0}>
              <div class="dinkster-metadata">{message('resources.loadedOnCard')}</div>
              <For each={models(device).map((model) => model.key)}>{(key) => {
                const model = () => models(device).find((entry) => entry.key === key)!
                return <div class="dinkster-resource-model"><span title={model().item.displayName}>{model().item.displayName}</span><span>{gb(model().bytes)}</span><ProductButton intent="remove" disabled={pending() || stale()} aria-label={message('memory.action.unloadModel', { model: model().item.displayName })} onClick={() => {
                  const selected = model()
                  setConfirmUnload(() => () => connection().unloadMemory(device, selected.consumer, selected.item.itemId))
                }}>{message('resources.unload')}</ProductButton></div>
              }}</For>
            </Show>
          </section>
        }}</For>
        <Show when={status() && cards().length === 0}><ProductFacts label={message('resources.work')} items={[{ label: message('resources.running'), value: status()!.queue.running.length }, { label: message('resources.queued'), value: status()!.queue.queued }]} /></Show>
        <Show when={cards().length > 0}>
          <ProductDisclosure title={message('resources.details')}>
            <For each={cards()}>{(device) => {
              const row = () => status()!.memoryGovernor![device]!
              return <div class="dinkster-stack">
                <Show when={cards().length > 1}><strong>{row().measured?.gpuName ?? device}</strong></Show>
                <ProductFacts label={message('resources.cardDetails', { device })} items={[
                  ...(row().peakUsedBytes === undefined || row().peakUsedBytes === null ? [] : [{ label: message('resources.peak'), value: <span class="dinkster-resource-peak"><ProductButton disabled={stale() || pending()} onClick={() => void act(() => connection().resetMemoryPeak(device))}>{message('resources.reset')}</ProductButton>{gb(row().peakUsedBytes!)}</span> }]),
                  ...(row().measured === null ? [] : [{ label: message('resources.freeOnCard'), value: gb(row().measured!.driverFreeBytes ?? row().measured!.freeBytes) }]),
                  ...(row().availableBytes === null ? [] : [{ label: message('resources.freeUnderLimit'), value: gb(row().availableBytes!) }]),
                  ...(row().measured?.torchReservedBytes === undefined ? [] : [{ label: message('resources.heldByBackend'), value: gb(row().measured!.torchReservedBytes!) }]),
                ]} />
              </div>
            }}</For>
            <For each={Object.keys(status()?.memoryGovernor ?? {}).filter((device) => device === 'ram')}>{(device) => {
              const measured = () => status()!.memoryGovernor![device]!.measured
              return <ProductFacts label={message('resources.systemMemory')} items={[
                ...(measured()?.processRssBytes === undefined ? [] : [{ label: message('resources.backendSystemMemory'), value: gb(measured()!.processRssBytes!) }]),
                ...(measured()?.pinnedHostBytes === undefined ? [] : [{ label: message('resources.lockedSystemMemory'), value: gb(measured()!.pinnedHostBytes!) }]),
              ]} />
            }}</For>
          </ProductDisclosure>
        </Show>
        <Show when={granted('memory-budgets') || granted('memory-headroom') || granted('aimdo-policy')}>
          <ProductDisclosure title={message('resources.limits')}>
            <Show when={granted('aimdo-policy')}><RuntimeSettingsPanel connection={connection()} backendLabel={props.backend.label} categories={['aimdo-policy']} alwaysOpen {...(status() === undefined ? {} : { memoryStatus: status()! })} /></Show>
            <Show when={granted('memory-budgets')}><For each={cards().filter((device) => limit(device) !== undefined && status()?.memoryGovernor?.[device]?.measured !== null)}>{(device) => <div class="dinkster-resource-limit-control"><span>{cards().length > 1 ? message('resources.cardLimit', { name: status()!.memoryGovernor![device]!.measured?.gpuName ?? device }) : message('resources.memoryLimit')}</span><ProductSlider ariaLabel={message('resources.cardLimit', { name: device })} min={0} max={status()!.memoryGovernor![device]!.measured!.totalBytes} step={64 * 1024 ** 2} value={budgetDraft()[device] ?? limit(device)!} disabled={pending() || stale()} onInput={(value) => setBudgetDraft((current) => ({ ...current, [device]: value }))} onCommit={(value) => void update('memory-budgets', { ...settings()!.settings['memory-budgets']!.value as Record<string, unknown>, [device]: value })} /><span>{gb(budgetDraft()[device] ?? limit(device)!)}</span></div>}</For></Show>
            <Show when={granted('memory-headroom') && status()?.acceleratorPolicy?.physicalHeadroomBytes !== undefined}><div class="dinkster-resource-limit-control"><span>{message('resources.keepFree')}</span><ProductSlider ariaLabel={message('resources.keepFree')} min={0} max={Math.max(...cards().map((device) => status()!.memoryGovernor![device]!.measured?.totalBytes ?? 0), 1024 ** 3)} step={64 * 1024 ** 2} value={headroomDraft() ?? status()!.acceleratorPolicy!.physicalHeadroomBytes} disabled={pending() || stale()} onInput={setHeadroomDraft} onCommit={(value) => void update('memory-headroom', value)} /><span>{gb(headroomDraft() ?? status()!.acceleratorPolicy!.physicalHeadroomBytes)}</span></div></Show>
          </ProductDisclosure>
        </Show>
        <Show when={unload().length > 0 && details() !== undefined}><ProductButton intent="remove" disabled={stale() || pending()} onClick={() => setConfirmUnload(() => async () => { for (const device of unload()) await connection().unloadMemory(device) })}>{message('memory.action.unloadAll')}</ProductButton></Show>
        <Show when={confirmUnload()}><div class="dinkster-stack"><span>{message('resources.confirmUnload')}</span><div class="dinkster-actions"><ProductButton intent="remove" fill="solid" pending={pending()} onClick={() => void act(confirmUnload()!)}>{message('resources.unload')}</ProductButton><ProductButton onClick={() => setConfirmUnload(undefined)}>{message('shell.action.cancel')}</ProductButton></div></div></Show>
      </div>
    </Show>
    <ProductToast notification={notification()} onDismiss={() => setNotification(undefined)} />
  </section>
}
