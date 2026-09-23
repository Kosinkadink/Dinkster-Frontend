import { createEffect, createSignal, createUniqueId, For, onCleanup, onMount, Show } from 'solid-js'
import { formatDate } from '@dinkster/core'
import type { ConnectionStatus, DinksterConnection, MemoryGovernorDevice, MemoryStatus } from '@dinkster/client'
import { ProductNotice } from './ProductForm.js'
import { RuntimeSettingsPanel } from './RuntimeSettingsPanel.js'
import {
  appendMemorySample,
  deviceBarSegments,
  diffHeatmapFlags,
  liveMemorySamples,
  memoryDetailKey,
  overBudgetBytes,
  PAGE_PULSE_TICKS,
  pageFlagRanges,
  pageIsResident,
  residencySegments,
  updateHeatmapState,
  type BarSegment,
  type HeatmapCell,
  type MemorySample,
} from './memory-visualization.js'

type MemoryConnection = Pick<DinksterConnection, 'status' | 'fetchMemoryStatus' | 'onMemoryStatus' | 'fetchRuntimeSettings' | 'updateRuntimeSetting'>
type Timer = ReturnType<typeof setInterval>
type TelemetryPresentationState = 'loading' | 'live' | 'stale' | 'disconnected'

const STALE_AFTER_MS = 6000

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return 'Not reported'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  const sign = bytes < 0 ? '-' : ''
  let value = Math.abs(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${sign}${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

export function leaseSeconds(initialSeconds: number, receivedAt: number, now: number): number {
  return Math.max(0, Math.ceil(initialSeconds - (now - receivedAt) / 1000))
}

export interface DeviceProjection {
  readonly device: string
  readonly execution: string
  readonly governor?: MemoryGovernorDevice
}

export function projectDevices(status: MemoryStatus): readonly DeviceProjection[] {
  const names = new Set([...Object.keys(status.devices), ...Object.keys(status.memoryGovernor ?? {})])
  return [...names].sort().map((device) => {
    const lane = status.devices[device]
    return {
      device,
      execution: lane ? `${lane.executionInUse}/${lane.executionCapacity} execution slots` : 'No execution lane',
      ...(status.memoryGovernor?.[device] ? { governor: status.memoryGovernor[device] } : {}),
    }
  })
}

export function telemetryPresentationState(
  status: MemoryStatus | undefined,
  connection: ConnectionStatus,
  receivedAt: number,
  now: number,
): TelemetryPresentationState {
  if (status === undefined) return 'loading'
  if (connection !== 'connected') return 'disconnected'
  return now - receivedAt > STALE_AFTER_MS ? 'stale' : 'live'
}

/** Owns push/poll selection and detail-fetch lifetime; timers are injectable for unit tests. */
export class MemoryStatusController {
  private pollTimer: Timer | undefined
  private detailTimer: Timer | undefined
  private readonly expanded = new Set<string>()
  private readonly disposers: (() => void)[]
  private lastPushAt = -Infinity
  private pushVersion = 0
  private detailGeneration = 0
  private baseRequestGeneration = 0
  private detailRequestGeneration = 0
  private disposed = false

  constructor(
    private readonly connection: MemoryConnection,
    private readonly accept: (status: MemoryStatus, details: boolean) => void,
    private readonly fail: (error: unknown, details: boolean) => void,
    private readonly every: (fn: () => void, ms: number) => Timer = (fn, ms) => setInterval(fn, ms),
    private readonly stopTimer: (timer: Timer) => void = (timer) => clearInterval(timer),
    private readonly now: () => number = Date.now,
  ) {
    this.disposers = [
      connection.onMemoryStatus((status) => {
        if (this.disposed) return
        this.lastPushAt = this.now()
        this.pushVersion++
        this.baseRequestGeneration++
        this.detailGeneration++
        this.accept(status, false)
      }),
      connection.status.subscribe((state) => { if (state !== 'connected') this.request(false) }),
    ]
    this.request(false)
    this.pollTimer = this.every(() => {
      if (this.connection.status.get() !== 'connected' || this.now() - this.lastPushAt > STALE_AFTER_MS) this.request(false)
    }, 5000)
  }

  private request(details: boolean): void {
    const requestGeneration = details ? ++this.detailRequestGeneration : ++this.baseRequestGeneration
    const pushVersion = this.pushVersion
    const detailGeneration = this.detailGeneration
    void this.connection.fetchMemoryStatus(details).then((status) => {
      if (this.disposed || requestGeneration !== (details ? this.detailRequestGeneration : this.baseRequestGeneration) ||
        (details ? detailGeneration !== this.detailGeneration : pushVersion !== this.pushVersion)) return
      this.accept(status, details)
    }, (error) => {
      if (!this.disposed && requestGeneration === (details ? this.detailRequestGeneration : this.baseRequestGeneration) &&
        (details ? detailGeneration === this.detailGeneration : pushVersion === this.pushVersion)) this.fail(error, details)
    })
  }

  setExpanded(consumer: string, expanded: boolean): void {
    this.detailGeneration++
    if (expanded) this.expanded.add(consumer)
    else this.expanded.delete(consumer)
    if (this.expanded.size > 0) {
      this.request(true)
      if (this.detailTimer === undefined) this.detailTimer = this.every(() => this.request(true), 10000)
    } else if (this.detailTimer !== undefined) {
      this.stopTimer(this.detailTimer)
      this.detailTimer = undefined
    }
  }

  refreshDetails(): void {
    if (this.expanded.size === 0) return
    this.detailGeneration++
    this.request(true)
  }

  retainExpanded(valid: ReadonlySet<string>): void {
    let changed = false
    for (const key of [...this.expanded]) if (!valid.has(key)) { this.expanded.delete(key); changed = true }
    if (!changed) return
    this.detailGeneration++
    if (this.expanded.size > 0) this.request(true)
    else if (this.detailTimer !== undefined) {
      this.stopTimer(this.detailTimer)
      this.detailTimer = undefined
    }
  }

  dispose(): void {
    this.disposed = true
    this.detailGeneration++
    if (this.pollTimer !== undefined) this.stopTimer(this.pollTimer)
    if (this.detailTimer !== undefined) this.stopTimer(this.detailTimer)
    this.disposers.forEach((dispose) => dispose())
  }
}

function SegmentBar(props: { readonly segments: readonly BarSegment[]; readonly class?: string }) {
  return <>
    <div class={`memory-stack ${props.class ?? ''}`}>
      <For each={props.segments}>{(item) => <span class={`memory-tone-${item.tone}`} style={{ width: `${item.fraction * 100}%` }} tabindex={item.fraction > 0 ? '0' : undefined} aria-label={`${item.label}: ${formatBytes(item.bytes)}`} data-tooltip-label={`${item.label}: ${formatBytes(item.bytes)}`} />}</For>
    </div>
    <dl class="memory-legend">
      <For each={props.segments}>{(item) => <div><dt><i class={`memory-tone-${item.tone}`} />{item.label}</dt><dd>{formatBytes(item.bytes)}</dd></div>}</For>
    </dl>
  </>
}

function cssColor(host: HTMLElement, name: string): string {
  return getComputedStyle(host).getPropertyValue(name).trim()
}

function MemoryGraph(props: { readonly samples: readonly MemorySample[] }) {
  let host: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined
  const [hover, setHover] = createSignal<MemorySample>()
  const draw = (): void => {
    if (canvas === undefined || host === undefined) return
    const context = canvas.getContext('2d')
    if (context === null) return
    const width = Math.max(240, host.clientWidth || canvas.clientWidth || 600)
    const height = 96
    const ratio = window.devicePixelRatio || 1
    canvas.width = width * ratio; canvas.height = height * ratio
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.fillStyle = cssColor(host, '--dinkster-surface-inset'); context.fillRect(0, 0, width, height)
    const samples = liveMemorySamples(props.samples)
    if (samples.length === 0) return
    const capacity = Math.max(1, ...samples.map((sample) => sample.capacityBytes))
    const x = (index: number): number => samples.length === 1 ? width : index * width / (samples.length - 1)
    const y = (bytes: number): number => height - Math.min(1, Math.max(0, bytes / capacity)) * (height - 8)
    const area = (value: (sample: MemorySample) => number, color: string, alpha: number): void => {
      context.beginPath(); context.moveTo(0, height)
      samples.forEach((sample, index) => context.lineTo(x(index), y(value(sample))))
      context.lineTo(width, height); context.closePath(); context.globalAlpha = alpha; context.fillStyle = color; context.fill(); context.globalAlpha = 1
    }
    area((sample) => sample.footprintBytes + sample.reservedBytes, cssColor(host, '--dinkster-success-border'), .34)
    area((sample) => sample.footprintBytes, cssColor(host, '--dinkster-warning-border'), .62)
    context.beginPath(); samples.forEach((sample, index) => index === 0 ? context.moveTo(x(index), y(sample.footprintBytes + sample.reservedBytes)) : context.lineTo(x(index), y(sample.footprintBytes + sample.reservedBytes)))
    context.strokeStyle = cssColor(host, '--dinkster-text-primary'); context.lineWidth = 1; context.stroke()
    context.setLineDash([4, 3]); context.beginPath(); context.moveTo(0, y(samples.at(-1)!.capacityBytes)); context.lineTo(width, y(samples.at(-1)!.capacityBytes)); context.strokeStyle = cssColor(host, '--dinkster-text-muted'); context.stroke(); context.setLineDash([])
    const selected = hover()
    if (selected !== undefined) {
      const index = samples.indexOf(selected); context.beginPath(); context.moveTo(x(index), 0); context.lineTo(x(index), height); context.strokeStyle = cssColor(host, '--dinkster-border-focus'); context.stroke()
    }
  }
  createEffect(draw)
  onMount(() => {
    if (host === undefined || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw); observer.observe(host)
    onCleanup(() => observer.disconnect())
  })
  const move = (event: MouseEvent): void => {
    const samples = liveMemorySamples(props.samples)
    if (samples.length === 0 || canvas === undefined) return
    const fraction = Math.min(1, Math.max(0, (event.clientX - canvas.getBoundingClientRect().left) / Math.max(1, canvas.getBoundingClientRect().width)))
    setHover(samples[Math.round(fraction * (samples.length - 1))]); draw()
  }
  const visibleSamples = () => liveMemorySamples(props.samples)
  const graphLabel = () => visibleSamples().length === 0 ? 'Memory usage history: no samples' : `Memory usage history: ${visibleSamples().length} samples, latest ${formatBytes(visibleSamples().at(-1)!.footprintBytes)} footprint and ${formatBytes(visibleSamples().at(-1)!.reservedBytes)} reserved`
  return <div class="memory-graph" ref={host}>
    <div class="memory-graph-frame">
      <canvas ref={canvas} role="img" aria-label={graphLabel()} data-samples={visibleSamples().length} onMouseMove={move} onMouseLeave={() => { setHover(undefined); draw() }} />
    </div>
    <p>{hover() === undefined ? 'Footprint, reservations, and capacity' : `${formatDate(hover()!.timestamp, { timeStyle: 'medium' })} - ${formatBytes(hover()!.footprintBytes)} footprint, ${formatBytes(hover()!.reservedBytes)} reserved`}</p>
    <details class="memory-data-disclosure">
      <summary>History data ({visibleSamples().length} {visibleSamples().length === 1 ? 'sample' : 'samples'})</summary>
      <div class="memory-table-scroll" tabindex="0" aria-label="Memory history table">
        <table><thead><tr><th>Time</th><th>Footprint</th><th>Reserved</th><th>Capacity</th></tr></thead><tbody>
          <For each={visibleSamples()}>{(sample) => <tr><td>{formatDate(sample.timestamp, { timeStyle: 'medium' })}</td><td>{formatBytes(sample.footprintBytes)}</td><td>{formatBytes(sample.reservedBytes)}</td><td>{formatBytes(sample.capacityBytes)}</td></tr>}</For>
        </tbody></table>
      </div>
    </details>
  </div>
}

function PageHeatmap(props: { readonly pageBytes: number; readonly pageCount: number; readonly flags: readonly number[]; readonly cells: readonly HeatmapCell[]; readonly retained: boolean }) {
  let host: HTMLDivElement | undefined
  let canvas: HTMLCanvasElement | undefined
  const draw = (): void => {
    if (canvas === undefined || host === undefined) return
    const context = canvas.getContext('2d')
    if (context === null) return
    const width = Math.max(120, host.clientWidth || canvas.clientWidth || 480)
    const pitch = 7; const columns = Math.max(1, Math.floor((width + 1) / pitch)); const height = Math.ceil(props.cells.length / columns) * pitch
    const ratio = window.devicePixelRatio || 1
    canvas.width = width * ratio; canvas.height = height * ratio; canvas.style.height = `${height}px`
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height)
    props.cells.forEach((cell, index) => {
      const progress = cell.age / PAGE_PULSE_TICKS
      const base = cell.resident ? cssColor(host, '--dinkster-warning-border') : cssColor(host, '--dinkster-border-subtle')
      const pulse = cell.pulse === 'in' ? cssColor(host, '--dinkster-border-focus') : cell.pulse === 'out' ? cssColor(host, '--dinkster-danger-border') : base
      context.globalAlpha = cell.pulse === 'none' ? 1 : Math.max(.35, progress)
      context.fillStyle = pulse
      context.fillRect(index % columns * pitch, Math.floor(index / columns) * pitch, 6, 6)
    })
    context.globalAlpha = 1
  }
  createEffect(draw)
  onMount(() => {
    if (host === undefined || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(draw)
    observer.observe(host); onCleanup(() => observer.disconnect())
  })
  const resident = () => props.flags.filter(pageIsResident).length
  const ranges = () => pageFlagRanges(props.flags, props.cells)
  const transitionLabel = (pulse: HeatmapCell['pulse']): string => pulse === 'in' ? 'Moved in' : pulse === 'out' ? 'Moved out' : 'No change'
  return <div class="memory-heatmap" ref={host}>
    <canvas ref={canvas} role="img" aria-label={`Page residency heatmap: ${resident()} of ${props.pageCount} pages resident, ${props.cells.filter((cell) => cell.pulse === 'in').length} moved in, ${props.cells.filter((cell) => cell.pulse === 'out').length} moved out${props.retained ? ', retained telemetry' : ''}`} data-page-in={props.cells.filter((cell) => cell.pulse === 'in').length} data-page-out={props.cells.filter((cell) => cell.pulse === 'out').length} />
    <p>{resident()}/{props.pageCount} resident pages - {formatBytes(resident() * props.pageBytes)} resident / {formatBytes(props.pageCount * props.pageBytes)} total{props.retained ? ' - retained telemetry' : ''}</p>
    <details class="memory-data-disclosure">
      <summary>Page flag data ({ranges().length} ranges)</summary>
      <div class="memory-table-scroll" tabindex="0" aria-label="Page flag ranges table">
        <table><thead><tr><th>Pages</th><th>Resident</th><th>Transition</th><th>Server flag</th></tr></thead><tbody>
          <For each={ranges()}>{(range) => <tr><td>{range.first === range.last ? range.first : `${range.first}-${range.last}`}</td><td>{range.resident ? 'Yes' : 'No'}</td><td>{transitionLabel(range.pulse)}</td><td>{range.flag}</td></tr>}</For>
        </tbody></table>
      </div>
    </details>
  </div>
}

const identityKey = (...parts: readonly string[]): string => encodeURIComponent(JSON.stringify(parts))
const consumerKey = (device: string, consumer: string): string => identityKey(device, consumer)
const collapsedStorageKey = (backend: string, device: string, consumer: string): string => `dinkster.memory.consumer.${identityKey(backend, device, consumer)}.collapsed`

export function MemoryPanel(props: { readonly connection: MemoryConnection; readonly backendId?: string; readonly label: string; readonly now?: () => number }) {
  const [status, setStatus] = createSignal<MemoryStatus>()
  const [details, setDetails] = createSignal<MemoryStatus['consumerDetails']>()
  const [detailState, setDetailState] = createSignal<'idle' | 'loading' | 'loaded' | 'failed'>('idle')
  const [detailReady, setDetailReady] = createSignal<ReadonlySet<string>>(new Set())
  const [baseError, setBaseError] = createSignal('')
  const [detailError, setDetailError] = createSignal('')
  const [connectionState, setConnectionState] = createSignal(props.connection.status.get())
  const [receivedAt, setReceivedAt] = createSignal(0)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [clock, setClock] = createSignal(props.now?.() ?? Date.now())
  const [history, setHistory] = createSignal<Readonly<Record<string, readonly MemorySample[]>>>({})
  const [heatmaps, setHeatmaps] = createSignal<Readonly<Record<string, readonly HeatmapCell[]>>>({})
  let controller: MemoryStatusController | undefined
  let statusDisposer: (() => void) | undefined
  const panelId = createUniqueId()
  const backendId = () => props.backendId ?? props.label
  let clockTimer: ReturnType<typeof setInterval> | undefined
  const initializedCollapseKeys = new Set<string>()
  const autoOpenedKeys = new Set<string>()
  const accept = (next: MemoryStatus, isDetails: boolean): void => {
    if (isDetails) {
      setDetails(next.consumerDetails); setDetailState('loaded'); setDetailError('')
      setDetailReady(new Set(expanded()))
      setHeatmaps((previous) => updateHeatmapState(previous, next.consumerDetails))
      return
    }
    const timestamp = props.now?.() ?? Date.now()
    setStatus(next); setReceivedAt(timestamp); setBaseError('')
    if (props.connection.status.get() === 'connected') setHistory((previous) => Object.fromEntries(Object.entries(next.memoryGovernor ?? {}).filter(([, governor]) => governor.budgetBytes !== null || governor.measured !== null).map(([device, governor]) => [device, appendMemorySample(previous[device] ?? [], {
      timestamp,
      footprintBytes: governor.consumerFootprintBytes,
      reservedBytes: governor.reservedBytes,
      capacityBytes: governor.budgetBytes ?? governor.measured?.totalBytes ?? Math.max(1, governor.consumerFootprintBytes + governor.reservedBytes),
    })])))
    const consumers = Object.entries(next.memoryGovernor ?? {}).flatMap(([device, item]) => Object.keys(item.consumers).map((consumer) => ({ device, consumer, key: consumerKey(device, consumer) })))
    const valid = new Set(consumers.map((item) => item.key))
    const retained = new Set([...expanded()].filter((key) => valid.has(key)))
    const restoredKeys: string[] = []
    for (const key of initializedCollapseKeys) if (!valid.has(key)) initializedCollapseKeys.delete(key)
    setDetailReady((previous) => new Set([...previous].filter((key) => valid.has(key))))
    for (const { device, consumer, key } of consumers) {
      if (initializedCollapseKeys.has(key)) continue
      initializedCollapseKeys.add(key)
      try {
        const collapsed = localStorage.getItem(collapsedStorageKey(backendId(), device, consumer))
        if (collapsed === 'false' || (collapsed === null && !autoOpenedKeys.has(key))) {
          retained.add(key); restoredKeys.push(key); autoOpenedKeys.add(key)
        }
      } catch {
        if (!autoOpenedKeys.has(key)) { retained.add(key); restoredKeys.push(key); autoOpenedKeys.add(key) }
      }
    }
    if (restoredKeys.length > 0 && details() === undefined) setDetailState('loading')
    if (retained.size !== expanded().size || [...retained].some((key) => !expanded().has(key))) setExpanded(retained)
    controller?.retainExpanded(valid)
    for (const key of restoredKeys) controller?.setExpanded(key, true)
    if (restoredKeys.length === 0 && retained.size > 0) controller?.refreshDetails()
  }
  onMount(() => {
    statusDisposer = props.connection.status.subscribe(setConnectionState)
    controller = new MemoryStatusController(props.connection, accept, (cause, isDetails) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      if (isDetails) { setDetailState('failed'); setDetailError(message) }
      else setBaseError(message)
    })
    clockTimer = setInterval(() => setClock(props.now?.() ?? Date.now()), 1000)
  })
  onCleanup(() => { controller?.dispose(); statusDisposer?.(); if (clockTimer !== undefined) clearInterval(clockTimer) })
  const presentationState = () => telemetryPresentationState(status(), connectionState(), receivedAt(), clock())
  const retained = () => presentationState() === 'stale' || presentationState() === 'disconnected'
  const toggle = (device: string, consumer: string): void => {
    const key = consumerKey(device, consumer)
    const next = new Set(expanded())
    if (next.has(key)) next.delete(key); else next.add(key)
    setDetailReady((previous) => new Set([...previous].filter((item) => item !== key)))
    setDetailError('')
    if (next.has(key)) setDetailState('loading')
    else if (next.size === 0) setDetailState('idle')
    setExpanded(next)
    try { localStorage.setItem(collapsedStorageKey(backendId(), device, consumer), String(!next.has(key))) } catch { /* Storage is optional. */ }
    controller?.setExpanded(key, next.has(key))
  }

  return <section class="memory-panel" data-testid="memory-panel" data-backend={backendId()}>
    <header class="memory-panel-header">
      <div><span class="memory-eyebrow">Backend</span><h2>{props.label}</h2></div>
      <span class="memory-telemetry-state" data-state={presentationState()} role="status">
        <span aria-hidden="true" />{presentationState() === 'loading' ? 'Loading' : presentationState() === 'live' ? 'Live' : presentationState() === 'stale' ? 'Stale' : 'Disconnected'}
      </span>
    </header>
    <Show when={presentationState() === 'stale'}><ProductNotice tone="warning">Telemetry is stale. Retained values remain visible while polling retries.</ProductNotice></Show>
    <Show when={presentationState() === 'disconnected'}><ProductNotice tone="error">Backend disconnected. All visible telemetry is retained from the last update.</ProductNotice></Show>
    <Show when={baseError()}>{(message) => <ProductNotice tone="error"><span>Memory telemetry request failed: {message()}.</span><Show when={status() !== undefined}> Retained values remain visible.</Show></ProductNotice>}</Show>
    <Show when={status()} fallback={<div class="memory-loading-state" role="status"><strong>Waiting for memory telemetry</strong><span>Queue, device, lease, and consumer facts will appear when the backend responds.</span></div>}>{(data) => <>
      <Show when={data().memoryGovernor === null}><ProductNotice tone="warning">Memory governor telemetry is unsupported on this backend. Execution occupancy remains available.</ProductNotice></Show>
      <div class="memory-devices">
        <For each={projectDevices(data())} fallback={<div class="memory-empty-state"><strong>No devices reported</strong><span>The backend returned no execution or memory device facts.</span></div>}>{(row) => <article class="memory-device" data-device={row.device}>
          <header><div><span class="memory-eyebrow">Device</span><h3>{row.device}</h3></div><span class="memory-execution-fact">{row.execution}</span></header>
          <Show when={row.governor}>{(governor) => <>
            <Show when={governor().budgetBytes === null}><ProductNotice tone={governor().measured === null ? 'warning' : 'info'}>{governor().measured === null ? 'Budget and device measurement are unavailable.' : 'No governor budget is reported. The visualization uses measured device memory only.'}</ProductNotice></Show>
            <Show when={overBudgetBytes(governor()) > 0}><ProductNotice tone="error"><strong>Over budget by {formatBytes(overBudgetBytes(governor()))}</strong></ProductNotice></Show>
            <Show when={governor().budgetBytes !== null || governor().measured !== null}><SegmentBar segments={deviceBarSegments(governor())} class="memory-device-stack" /></Show>
            <section class="memory-consumers" aria-label={`${row.device} memory consumers`}>
              <header><div><span class="memory-eyebrow">Residency</span><h4>Consumers</h4></div><span>{Object.keys(governor().consumers).length} reported</span></header>
              <For each={Object.entries(governor().consumers)} fallback={<div class="memory-empty-state"><strong>No consumers</strong><span>This device currently reports no resident memory consumers.</span></div>}>{([consumer, bytes]) => {
                const key = consumerKey(row.device, consumer)
                const detailId = `${panelId}-memory-consumer-${identityKey(row.device, consumer)}`
                return <section class="memory-consumer" data-consumer={consumer}>
                  <button type="button" aria-expanded={expanded().has(key)} aria-controls={detailId} onClick={() => toggle(row.device, consumer)}><span><i aria-hidden="true">{expanded().has(key) ? 'v' : '>'}</i><span>{consumer}</span></span><strong>{formatBytes(bytes)}</strong></button>
                  <Show when={expanded().has(key)}><div id={detailId} class="memory-consumer-details">
                    <Show when={detailState() === 'loading' && !detailReady().has(key)}><ProductNotice tone="status">Loading item details...</ProductNotice></Show>
                    <Show when={detailError()}>{(message) => <ProductNotice tone="error">Item details failed to refresh: {message()}.{detailReady().has(key) ? ' Retained details remain visible.' : ''}</ProductNotice>}</Show>
                    <Show when={detailReady().has(key)}>
                      <Show when={details() !== undefined && Object.prototype.hasOwnProperty.call(details(), consumer)} fallback={<ProductNotice tone="info">Detail telemetry is unsupported for this consumer.</ProductNotice>}>
                        <For each={details()![consumer] ?? []} fallback={<div class="memory-empty-state"><strong>No item details</strong><span>The backend supports details but returned no items for this consumer.</span></div>}>{(item) => <article class="memory-consumer-item">
                          <header><strong>{item.displayName}</strong><span>{formatBytes(Object.values(item.bytesByResidency).reduce((sum, value) => sum + value, 0))}</span></header>
                          <SegmentBar segments={residencySegments(item.bytesByResidency)} />
                          <Show when={item.pages}>{(pages) => <PageHeatmap pageBytes={pages().pageBytes} pageCount={pages().pageCount} flags={pages().flags} cells={heatmaps()[memoryDetailKey(consumer, item.itemId)] ?? diffHeatmapFlags(undefined, pages().flags)} retained={retained() || detailState() === 'failed'} />}</Show>
                        </article>}</For>
                      </Show>
                    </Show>
                  </div></Show>
                </section>
              }}</For>
            </section>
            <dl class="memory-device-facts">
              <div><dt>Budget</dt><dd>{formatBytes(governor().budgetBytes)}</dd></div>
              <div><dt>Footprint</dt><dd>{formatBytes(governor().consumerFootprintBytes)}</dd></div>
              <div><dt>Reserved</dt><dd>{formatBytes(governor().reservedBytes)}</dd></div>
              <div><dt>Available</dt><dd>{formatBytes(governor().availableBytes)}</dd></div>
              <div><dt>Raw capacity</dt><dd>{formatBytes(governor().measured?.totalBytes)}</dd></div>
              <div><dt>Aimdo-corrected free</dt><dd>{formatBytes(governor().measured?.freeBytes)}</dd></div>
            </dl>
            <Show when={governor().budgetBytes !== null || governor().measured !== null}><MemoryGraph samples={history()[row.device] ?? []} /></Show>
          </>}</Show>
          <Show when={!row.governor}><ProductNotice tone="info">Governor metrics are unavailable for this device. Execution occupancy is still authoritative.</ProductNotice></Show>
        </article>}</For>
      </div>
      <dl class="memory-queue-facts" data-testid="memory-queue">
        <div><dt>Queued</dt><dd>{data().queue.queued}</dd></div>
        <div><dt>Running</dt><dd>{data().queue.running.length} / {data().queue.maxRunningJobs}</dd></div>
        <div><dt>Queue state</dt><dd>{data().queue.paused ? 'Paused' : 'Accepting work'}</dd></div>
      </dl>
      <section class="memory-controls" aria-label={`${props.label} memory and Aimdo settings`}>
        <header><div><span class="memory-eyebrow">Server settings</span><h3>Memory and Aimdo controls</h3></div></header>
        <p>Budget and headroom changes apply live. Aimdo policy applies to workers started after the change.</p>
        <RuntimeSettingsPanel connection={props.connection} backendLabel={props.label} categories={['memory-budgets', 'memory-headroom', 'aimdo-policy']} alwaysOpen memoryControls showGrantWarnings />
      </section>
      <section class="memory-leases" aria-label="Active memory leases">
        <header><div><span class="memory-eyebrow">Reservations</span><h3>Active leases</h3></div><Show when={data().leases !== null}><span>{data().leases!.length} active</span></Show></header>
        <Show when={data().leases !== null} fallback={<ProductNotice tone="info">Lease telemetry is unsupported on this backend.</ProductNotice>}>
          <div class="memory-lease-list"><For each={data().leases ?? []} fallback={<div class="memory-empty-state"><strong>No active leases</strong><span>No temporary memory reservations are reported.</span></div>}>{(lease) => <article class="memory-lease">
            <div><strong>{lease.device}</strong><code>{lease.reservationId}</code></div><span>{formatBytes(lease.bytes)}</span><span>{leaseSeconds(lease.expiresInSeconds, receivedAt(), clock())}s remaining</span>
          </article>}</For></div>
        </Show>
      </section>
    </>}</Show>
  </section>
}
