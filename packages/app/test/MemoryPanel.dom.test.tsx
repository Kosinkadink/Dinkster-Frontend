// @vitest-environment happy-dom
import { createSignal } from '@dinkster/core'
import type { ConnectionStatus, MemoryStatus } from '@dinkster/client'
import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatBytes, leaseSeconds, MemoryPanel, MemoryStatusController, projectDevices, telemetryPresentationState } from '../src/MemoryPanel.js'
import { appendMemorySample, deviceBarSegments, diffHeatmapFlags, memoryDetailKey, overBudgetBytes, pageFlagRanges, pageIsResident, residencySegments, updateHeatmapState } from '../src/memory-visualization.js'

const payload: MemoryStatus = {
  devices: { 'cuda:0': { executionCapacity: 2, executionInUse: 1 } },
  queue: { queued: 3, running: ['job-1'], maxRunningJobs: 2, paused: false },
  memoryGovernor: { 'cuda:0': {
    budgetBytes: 8 * 1024 ** 3, reservedBytes: 2 * 1024 ** 3,
    consumerFootprintBytes: 3 * 1024 ** 3, availableBytes: 3 * 1024 ** 3,
    measured: { freeBytes: 5 * 1024 ** 3, totalBytes: 12 * 1024 ** 3 },
    consumers: { models: 3 * 1024 ** 3 },
  } },
  leases: [{ reservationId: 'r1', device: 'cuda:0', bytes: 1024 ** 3, expiresInSeconds: 12 }],
  consumerDetails: { models: [{ itemId: 'm1', displayName: 'Flux model', bytesByResidency: { device: 2 * 1024 ** 3, host: 1024 ** 3 }, pages: { pageBytes: 1024 ** 2, pageCount: 3, flags: [1, 1, 2] } }] },
}

afterEach(() => { document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals() })

describe('memory status projection', () => {
  it('formats bytes, derives sorted devices, and clamps lease countdowns', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(-1536)).toBe('-1.5 KiB')
    expect(formatBytes(null)).toBe('Not reported')
    expect(projectDevices(payload)).toMatchObject([{ device: 'cuda:0', execution: '1/2 execution slots' }])
    expect(leaseSeconds(10, 1000, 4500)).toBe(7)
    expect(leaseSeconds(2, 1000, 9000)).toBe(0)
    expect(telemetryPresentationState(undefined, 'connected', 0, 1000)).toBe('loading')
    expect(telemetryPresentationState(payload, 'connected', 1000, 7000)).toBe('live')
    expect(telemetryPresentationState(payload, 'connected', 1000, 7001)).toBe('stale')
    expect(telemetryPresentationState(payload, 'reconnecting', 1000, 1001)).toBe('disconnected')
  })

  it('polls only without push and fetches details only while at least one consumer is expanded', async () => {
    const status = createSignal<ConnectionStatus>('disconnected')
    const fetchMemoryStatus = vi.fn(async () => payload)
    const timers = new Map<number, () => void>(); let id = 0; let push: ((status: MemoryStatus) => void) | undefined; let now = 0
    const controller = new MemoryStatusController(
      { status, fetchMemoryStatus, onMemoryStatus: (listener) => { push = listener; return () => { push = undefined } }, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() },
      () => {}, () => {},
      ((fn: () => void) => { timers.set(++id, fn); return id }) as never,
      ((timer: number) => timers.delete(timer)) as never,
      () => now,
    )
    await Promise.resolve()
    expect(fetchMemoryStatus).toHaveBeenCalledWith(false)
    status.set('connected')
    expect(timers.size).toBe(1)
    push!(payload); now = 1000; timers.get(1)!(); await Promise.resolve()
    expect(fetchMemoryStatus).toHaveBeenCalledTimes(1)
    now = 7001; timers.get(1)!(); await Promise.resolve()
    expect(fetchMemoryStatus).toHaveBeenCalledTimes(2)
    controller.setExpanded('models', true); await Promise.resolve()
    expect(fetchMemoryStatus).toHaveBeenLastCalledWith(true)
    expect(timers.size).toBe(2)
    controller.setExpanded('cache', true)
    controller.setExpanded('models', false)
    expect(timers.size).toBe(2)
    controller.setExpanded('cache', false)
    expect(timers.size).toBe(1)
    controller.setExpanded('models', true)
    expect(timers.size).toBe(2)
    controller.setExpanded('cache', true)
    const detailRequests = fetchMemoryStatus.mock.calls.length
    controller.retainExpanded(new Set(['models']))
    expect(fetchMemoryStatus).toHaveBeenCalledTimes(detailRequests + 1)
    expect(fetchMemoryStatus).toHaveBeenLastCalledWith(true)
    controller.retainExpanded(new Set())
    expect(timers.size).toBe(1)
    controller.dispose()
    expect(timers.size).toBe(0)
    expect(push).toBeUndefined()
  })

  it('rejects base work superseded by push and detail work invalidated by disclosure changes', async () => {
    const status = createSignal<ConnectionStatus>('connected')
    let push: ((status: MemoryStatus) => void) | undefined
    let resolveBase: ((value: MemoryStatus) => void) | undefined
    let resolveDetail: ((value: MemoryStatus) => void) | undefined
    const fetchMemoryStatus = vi.fn((details = false) => new Promise<MemoryStatus>((resolve) => {
      if (details) resolveDetail = resolve
      else resolveBase = resolve
    }))
    const accepted: { readonly status: MemoryStatus; readonly details: boolean }[] = []
    const controller = new MemoryStatusController(
      { status, fetchMemoryStatus, onMemoryStatus: (listener) => { push = listener; return () => {} }, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() },
      (next, details) => accepted.push({ status: next, details }),
      () => {},
      (() => 1) as never,
      (() => {}) as never,
      () => 1000,
    )
    push!(payload)
    resolveBase!({ ...payload, queue: { ...payload.queue, queued: 99 } })
    await Promise.resolve()
    expect(accepted).toEqual([{ status: payload, details: false }])
    controller.setExpanded('cuda:0\u0000models', true)
    controller.setExpanded('cuda:0\u0000models', false)
    resolveDetail!(payload)
    await Promise.resolve()
    expect(accepted).toEqual([{ status: payload, details: false }])
    controller.dispose()
  })
})

describe('memory visualization logic', () => {
  it('samples graph history at most once per second and bounds the ring buffer', () => {
    const sample = (timestamp: number) => ({ timestamp, footprintBytes: timestamp, reservedBytes: 2, capacityBytes: 100 })
    let history = appendMemorySample([], sample(0), 3)
    history = appendMemorySample(history, sample(999), 3)
    expect(history.map((item) => item.timestamp)).toEqual([0])
    history = appendMemorySample(history, sample(1000), 3)
    history = appendMemorySample(history, sample(2000), 3)
    history = appendMemorySample(history, sample(3000), 3)
    expect(history.map((item) => item.timestamp)).toEqual([1000, 2000, 3000])
  })

  it('computes non-overlapping governed and measured stacked bar segments', () => {
    expect(deviceBarSegments(payload.memoryGovernor!['cuda:0']!).map(({ key, bytes, fraction }) => ({ key, bytes, fraction }))).toEqual([
      { key: 'footprint', bytes: 3 * 1024 ** 3, fraction: 3 / 8 },
      { key: 'reserved', bytes: 2 * 1024 ** 3, fraction: 2 / 8 },
      { key: 'available', bytes: 3 * 1024 ** 3, fraction: 3 / 8 },
    ])
    const measured = deviceBarSegments({ ...payload.memoryGovernor!['cuda:0']!, budgetBytes: null, availableBytes: null })
    expect(measured.map(({ key, bytes }) => ({ key, bytes }))).toEqual([
      { key: 'measured-used', bytes: 7 * 1024 ** 3 }, { key: 'measured-free', bytes: 5 * 1024 ** 3 },
    ])
    expect(residencySegments({ device: 3, pinned: 1 }).map((item) => item.fraction)).toEqual([.75, .25])
    const correctedFree = deviceBarSegments({ ...payload.memoryGovernor!['cuda:0']!, budgetBytes: null, availableBytes: null, measured: { totalBytes: 10, freeBytes: 12 } })
    expect(correctedFree.reduce((sum, item) => sum + item.fraction, 0)).toBe(1)
    const over = { ...payload.memoryGovernor!['cuda:0']!, budgetBytes: 1024, availableBytes: -2048 }
    expect(overBudgetBytes(over)).toBe(2048)
    expect(deviceBarSegments(over).reduce((sum, item) => sum + item.fraction, 0)).toBe(1)
  })

  it('maps page residency bits and classifies page-in and page-out pulses', () => {
    expect([0, 1, 2, 3].map(pageIsResident)).toEqual([false, true, false, true])
    const initial = diffHeatmapFlags(undefined, [0, 1, 2, 3])
    expect(initial.map((cell) => cell.pulse)).toEqual(['none', 'none', 'none', 'none'])
    const changed = diffHeatmapFlags(initial, [1, 0, 3, 2])
    expect(changed.map(({ resident, pulse, age }) => ({ resident, pulse, age }))).toEqual([
      { resident: true, pulse: 'in', age: 6 }, { resident: false, pulse: 'out', age: 6 },
      { resident: true, pulse: 'in', age: 6 }, { resident: false, pulse: 'out', age: 6 },
    ])
    expect(diffHeatmapFlags(changed, [1, 0, 3, 2])[0]).toEqual({ resident: true, pulse: 'in', age: 5 })
    const first = updateHeatmapState({}, payload.consumerDetails)
    const nextDetails = { models: [{ ...payload.consumerDetails!.models![0]!, pages: { pageBytes: 1024, pageCount: 3, flags: [0, 1, 3] } }] }
    const second = updateHeatmapState(first, nextDetails)
    expect(second[memoryDetailKey('models', 'm1')]?.map((cell) => cell.pulse)).toEqual(['out', 'none', 'in'])
    expect(pageFlagRanges([1, 1, 2, 2, 3])).toEqual([
      { first: 0, last: 1, flag: 1, resident: true, pulse: 'none' },
      { first: 2, last: 3, flag: 2, resident: false, pulse: 'none' },
      { first: 4, last: 4, flag: 3, resident: true, pulse: 'none' },
    ])
    expect(pageFlagRanges([1, 1], [{ resident: true, pulse: 'in', age: 6 }, { resident: true, pulse: 'none', age: 0 }]).map((range) => range.pulse)).toEqual(['in', 'none'])
  })
})

describe('MemoryPanel', () => {
  it('renders raw, Aimdo-corrected, governed, queue, lease, detail, and restart-policy labels', async () => {
    const status = createSignal<ConnectionStatus>('disconnected')
    const runtimeSection = (value: unknown, mutability: 'live' | 'on-worker-restart' = 'live') => ({ value, source: 'default' as const, mutability, writable: true, persistence: { available: true, persisted: true } })
    const updateRuntimeSetting = vi.fn(async (_category: string, value: unknown) => runtimeSection(value))
    const zeroSegmentPayload: MemoryStatus = { ...payload, memoryGovernor: { 'cuda:0': { ...payload.memoryGovernor!['cuda:0']!, reservedBytes: 0 } } }
    const connection = {
      status, fetchMemoryStatus: vi.fn(async () => zeroSegmentPayload), onMemoryStatus: () => () => {},
      fetchRuntimeSettings: vi.fn(async () => ({
        categories: { granted: ['memory-budgets', 'memory-headroom', 'aimdo-policy', 'jobs'], available: ['memory-budgets', 'memory-headroom', 'aimdo-policy', 'jobs'] },
        settings: { 'memory-budgets': runtimeSection({ 'cuda:0': '8G' }), 'memory-headroom': runtimeSection('256M'), 'aimdo-policy': runtimeSection('auto', 'on-worker-restart'), jobs: runtimeSection({ maxRunningJobs: 2 }) },
      })), updateRuntimeSetting,
    }
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={connection} label="Local GPU" now={() => 1000} />, root)
    await Promise.resolve(); await Promise.resolve()
    expect(root.textContent).toContain('Raw capacity12 GiB')
    expect(root.textContent).toContain('Aimdo-corrected free5.0 GiB')
    expect(root.textContent).toContain('Budget8.0 GiB')
    const segment = root.querySelector<HTMLElement>('.memory-stack [data-tooltip-label]')!
    expect(segment.getAttribute('data-tooltip-label')).toMatch(/: .*GiB/)
    expect(segment.getAttribute('aria-label')).toBe(segment.getAttribute('data-tooltip-label'))
    expect(segment.getAttribute('title')).toBeNull()
    const zeroSegments = [...root.querySelectorAll<HTMLElement>('.memory-stack [data-tooltip-label]')].filter((item) => item.style.width === '0%')
    expect(zeroSegments.length).toBeGreaterThan(0)
    expect(zeroSegments.every((item) => item.getAttribute('tabindex') === null)).toBe(true)
    expect(root.textContent).toContain('Queued3')
    expect(root.textContent).toContain('Running1 / 2')
    expect(root.textContent).toContain('12s remaining')
    expect(root.textContent).toContain('Aimdo policy applies to workers started after the change.')
    root.querySelector<HTMLButtonElement>('.memory-consumer button')!.click()
    await Promise.resolve()
    expect(root.textContent).toContain('Flux model')
    expect(root.textContent).toContain('2/3 resident pages')
    expect(root.querySelector('[aria-label="Memory history table"]')).not.toBeNull()
    expect(root.querySelector('[aria-label="Page flag ranges table"]')).not.toBeNull()
    expect(root.querySelector('[data-category="memory-budgets"]')).not.toBeNull()
    expect(root.querySelector('[data-category="jobs"]')).toBeNull()
    expect(root.querySelector('[data-category="aimdo-policy"]')?.textContent).toContain('Changes apply to workers started later.')
    const headroom = root.querySelector<HTMLInputElement>('[aria-label="Memory headroom"]')!
    headroom.value = '512'; headroom.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('form[data-category="memory-headroom"]')!.requestSubmit()
    await Promise.resolve(); await Promise.resolve()
    expect(updateRuntimeSetting).toHaveBeenCalledWith('memory-headroom', 512 * 1024 ** 2)
    const budgetSlider = root.querySelector<HTMLElement>('[aria-label="cuda:0 memory budget slider"]')!
    const initialMaximum = budgetSlider.getAttribute('aria-valuemax')
    const budget = root.querySelector<HTMLInputElement>('[aria-label="cuda:0 memory budget"]')!
    budget.value = '1024'; budget.dispatchEvent(new InputEvent('input', { bubbles: true }))
    expect(budgetSlider.getAttribute('aria-valuemax')).toBe(initialMaximum)
    unmount()
  })

  it('renders execution occupancy and honest unavailable states for an ungoverned server', async () => {
    const status = createSignal<ConnectionStatus>('connected')
    const root = document.createElement('div'); document.body.append(root)
    const { consumerDetails: _details, ...base } = payload
    const ungoverned: MemoryStatus = { ...base, memoryGovernor: null, leases: null }
    const unmount = render(() => <MemoryPanel connection={{ status, fetchMemoryStatus: vi.fn(async () => ungoverned), onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() }} label="CPU" />, root)
    await Promise.resolve(); await Promise.resolve()
    expect(root.textContent).toContain('1/2 execution slots')
    expect(root.textContent).toContain('Memory governor telemetry is unsupported')
    expect(root.textContent).toContain('Lease telemetry is unsupported')
    unmount()
  })

  it('does not fabricate a stack or graph without a device budget or measurement', async () => {
    const status = createSignal<ConnectionStatus>('connected')
    const absent: MemoryStatus = { ...payload, memoryGovernor: { 'cuda:0': { ...payload.memoryGovernor!['cuda:0']!, budgetBytes: null, availableBytes: null, measured: null } } }
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={{ status, fetchMemoryStatus: vi.fn(async () => absent), onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() }} label="Absent" />, root)
    await Promise.resolve(); await Promise.resolve()
    expect(root.textContent).toContain('Budget and device measurement are unavailable.')
    expect(root.querySelector('.memory-device .memory-stack')).toBeNull()
    expect(root.querySelector('.memory-device .memory-graph')).toBeNull()
    unmount()
  })

  it('keeps controls visible and names every missing writable server grant', async () => {
    const status = createSignal<ConnectionStatus>('connected')
    const runtimeSection = (value: unknown, writable: boolean) => ({ value, source: 'default' as const, mutability: 'live' as const, writable, persistence: { available: true, persisted: true } })
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={{
      status, fetchMemoryStatus: vi.fn(async () => payload), onMemoryStatus: () => () => {}, updateRuntimeSetting: vi.fn(),
      fetchRuntimeSettings: vi.fn(async () => ({ categories: { granted: ['memory-budgets'], available: ['memory-budgets', 'memory-headroom', 'aimdo-policy'] }, settings: {
        'memory-budgets': runtimeSection({ 'cuda:0': '8G' }, true), 'memory-headroom': runtimeSection('256M', true), 'aimdo-policy': runtimeSection('auto', false),
      } })),
    }} label="Read only" />, root)
    await Promise.resolve(); await Promise.resolve()
    expect(root.querySelector('.runtime-settings-toggle')).toBeNull()
    expect(root.querySelector<HTMLInputElement>('[aria-label="cuda:0 memory budget slider"]')).not.toBeNull()
    expect(root.querySelector('form[data-category="memory-headroom"]')).toBeNull()
    expect(root.textContent).toContain('Missing server grant: memory-headroom')
    expect(root.textContent).toContain('Missing server grant: aimdo-policy')
    unmount()
  })

  it('scopes adversarial consumer disclosure identities by device and panel', async () => {
    const status = createSignal<ConnectionStatus>('disconnected')
    const cuda = payload.memoryGovernor!['cuda:0']!
    const multi: MemoryStatus = {
      ...payload,
      devices: { gpu: { executionCapacity: 1, executionInUse: 0 }, ['gpu\u0000x']: { executionCapacity: 1, executionInUse: 0 } },
      memoryGovernor: { gpu: { ...cuda, consumers: { ['x\u0000models']: 1 } }, ['gpu\u0000x']: { ...cuda, consumers: { models: 1 } } },
    }
    const connection = { status, fetchMemoryStatus: vi.fn(async () => multi), onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() }
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <><MemoryPanel connection={connection} label="One" /><MemoryPanel connection={connection} label="Two" /></>, root)
    await Promise.resolve(); await Promise.resolve()
    const buttons = root.querySelectorAll<HTMLButtonElement>('.memory-consumer button')
    buttons[0]!.click()
    expect(buttons[0]!.getAttribute('aria-expanded')).toBe('true')
    expect(buttons[1]!.getAttribute('aria-expanded')).toBe('false')
    const ids = [...buttons].map((button) => button.getAttribute('aria-controls'))
    expect(new Set(ids).size).toBe(ids.length)
    unmount()
  })

  it('persists consumer collapse state by backend, device, and consumer identity', async () => {
    const status = createSignal<ConnectionStatus>('disconnected')
    const connection = { status, fetchMemoryStatus: vi.fn(async () => payload), onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() }
    const firstRoot = document.createElement('div'); document.body.append(firstRoot)
    const firstUnmount = render(() => <MemoryPanel connection={connection} backendId="backend-1" label="First" />, firstRoot)
    await Promise.resolve(); await Promise.resolve()
    firstRoot.querySelector<HTMLButtonElement>('.memory-consumer button')!.click()
    const storedKey = Object.keys(localStorage).find((key) => key.startsWith('dinkster.memory.consumer.'))
    expect(storedKey).toBeTruthy()
    expect(localStorage.getItem(storedKey!)).toBe('false')
    firstUnmount(); firstRoot.remove()
    const secondRoot = document.createElement('div'); document.body.append(secondRoot)
    const secondUnmount = render(() => <MemoryPanel connection={connection} backendId="backend-1" label="Second" />, secondRoot)
    await Promise.resolve(); await Promise.resolve()
    expect(secondRoot.querySelector('.memory-consumer button')?.getAttribute('aria-expanded')).toBe('true')
    expect(connection.fetchMemoryStatus).toHaveBeenCalledWith(true)
    secondUnmount()
  })

  it('restores a persisted expansion when its consumer arrives after an empty status', async () => {
    localStorage.setItem(`dinkster.memory.consumer.${encodeURIComponent(JSON.stringify(['Late', 'cuda:0', 'models']))}.collapsed`, 'false')
    const status = createSignal<ConnectionStatus>('connected')
    let push: ((next: MemoryStatus) => void) | undefined
    const empty: MemoryStatus = { ...payload, memoryGovernor: { 'cuda:0': { ...payload.memoryGovernor!['cuda:0']!, consumers: {} } } }
    const fetchMemoryStatus = vi.fn((details = false) => details ? new Promise<MemoryStatus>(() => {}) : Promise.resolve(empty))
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={{ status, fetchMemoryStatus, onMemoryStatus: (listener) => { push = listener; return () => {} }, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() }} label="Late" />, root)
    await Promise.resolve(); await Promise.resolve()
    expect(root.querySelector('.memory-consumer')).toBeNull()
    push!(payload); await Promise.resolve()
    expect(root.querySelector('.memory-consumer button')?.getAttribute('aria-expanded')).toBe('true')
    expect(root.textContent).toContain('Loading item details...')
    expect(fetchMemoryStatus).toHaveBeenCalledWith(true)
    unmount()
  })

  it('observes graph and heatmap resize and disconnects both observers', async () => {
    const observers = new Map<Element, ResizeObserverCallback>()
    let disconnects = 0
    vi.stubGlobal('ResizeObserver', class {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) { this.callback = callback }
      observe(element: Element): void { observers.set(element, this.callback) }
      disconnect(): void { disconnects++ }
      unobserve(): void {}
    })
    const status = createSignal<ConnectionStatus>('disconnected')
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={{ status, fetchMemoryStatus: vi.fn(async () => payload), onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn() }} label="Resize" />, root)
    await Promise.resolve(); await Promise.resolve()
    const graph = root.querySelector<HTMLCanvasElement>('[aria-label^="Memory usage history"]')!
    const graphHost = graph.closest('.memory-graph')!
    Object.defineProperty(graphHost, 'clientWidth', { configurable: true, value: 300 })
    observers.get(graphHost)!([], {} as ResizeObserver)
    expect(graph.width).toBe(300)
    root.querySelector<HTMLButtonElement>('.memory-consumer button')!.click(); await Promise.resolve(); await Promise.resolve()
    const heatmap = root.querySelector<HTMLCanvasElement>('[aria-label^="Page residency heatmap"]')!
    expect(observers.has(heatmap.parentElement!)).toBe(true)
    Object.defineProperty(heatmap.parentElement!, 'clientWidth', { configurable: true, value: 140 })
    observers.get(heatmap.parentElement!)!([], {} as ResizeObserver)
    unmount()
    expect(disconnects).toBe(2)
  })

  it('distinguishes unsupported detail telemetry from a supported empty consumer', async () => {
    const status = createSignal<ConnectionStatus>('disconnected')
    let supported = false
    const connection = {
      status, onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn(),
      fetchMemoryStatus: vi.fn(async (details = false): Promise<MemoryStatus> => details
        ? supported ? { ...payload, consumerDetails: { models: [] } } : (() => { const { consumerDetails: _omit, ...base } = payload; return base })()
        : payload),
    }
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={connection} label="Details" />, root)
    await Promise.resolve(); await Promise.resolve()
    root.querySelector<HTMLButtonElement>('.memory-consumer button')!.click(); await Promise.resolve()
    expect(root.textContent).toContain('Detail telemetry is unsupported for this consumer.')
    root.querySelector<HTMLButtonElement>('.memory-consumer button')!.click()
    supported = true
    root.querySelector<HTMLButtonElement>('.memory-consumer button')!.click(); await Promise.resolve()
    expect(root.textContent).toContain('No item details')
    unmount()
  })

  it('retains details only for disclosures that stayed open across a failed refresh', async () => {
    const status = createSignal<ConnectionStatus>('connected')
    let detailRequests = 0
    const twoConsumers: MemoryStatus = { ...payload, memoryGovernor: { 'cuda:0': { ...payload.memoryGovernor!['cuda:0']!, consumers: { models: 3, cache: 2 } } } }
    const connection = {
      status, onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn(),
      fetchMemoryStatus: vi.fn(async (details = false): Promise<MemoryStatus> => {
        if (details) {
          detailRequests++
          if (detailRequests > 1) throw new Error('detail offline')
          return twoConsumers
        }
        return twoConsumers
      }),
    }
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={connection} label="Retained" />, root)
    await Promise.resolve(); await Promise.resolve()
    const consumers = root.querySelectorAll<HTMLButtonElement>('.memory-consumer button')
    consumers[0]!.click(); await Promise.resolve(); await Promise.resolve()
    expect(root.textContent).toContain('Flux model')
    consumers[1]!.click(); await Promise.resolve(); await Promise.resolve()
    expect(root.textContent).toContain('Item details failed to refresh: detail offline. Retained details remain visible.')
    expect(root.textContent).toContain('Flux model')
    const cacheDetails = consumers[1]!.closest('.memory-consumer')!.querySelector('.memory-consumer-details')!
    expect(cacheDetails.textContent).toContain('Item details failed to refresh: detail offline.')
    expect(cacheDetails.textContent).not.toContain('Retained details remain visible.')
    expect(cacheDetails.textContent).not.toContain('unsupported')
    unmount()
  })

  it('keeps retained base telemetry visible with explicit disconnected and error labels', async () => {
    const status = createSignal<ConnectionStatus>('connected')
    let baseRequests = 0
    const connection = {
      status, onMemoryStatus: () => () => {}, fetchRuntimeSettings: vi.fn(), updateRuntimeSetting: vi.fn(),
      fetchMemoryStatus: vi.fn(async (): Promise<MemoryStatus> => {
        baseRequests++
        if (baseRequests > 1) throw new Error('base offline')
        return payload
      }),
    }
    const root = document.createElement('div'); document.body.append(root)
    const unmount = render(() => <MemoryPanel connection={connection} label="Retained" />, root)
    await Promise.resolve(); await Promise.resolve()
    status.set('disconnected'); await Promise.resolve(); await Promise.resolve()
    expect(root.querySelector('.memory-telemetry-state')?.getAttribute('data-state')).toBe('disconnected')
    expect(root.textContent).toContain('All visible telemetry is retained')
    expect(root.textContent).toContain('Memory telemetry request failed: base offline. Retained values remain visible.')
    expect(root.textContent).toContain('Budget8.0 GiB')
    unmount()
  })
})
