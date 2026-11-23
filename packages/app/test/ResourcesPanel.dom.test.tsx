import { createSignal as coreSignal } from '@dinkster/core'
import type { ConnectionStatus, DinksterConnection, MemoryStatus } from '@dinkster/client'
import { createSignal } from 'solid-js'
import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { ResourcesPanel } from '../src/ResourcesPanel.js'
import { MemoryStatusController } from '../src/memory-status.js'

const payload: MemoryStatus = {
  devices: {}, queue: { queued: 3, running: ['job-1'], maxRunningJobs: 2, paused: false },
  memoryGovernor: { 'vram:cuda:0': {
    budgetBytes: 8e9, reservedBytes: 0, consumerFootprintBytes: 3e9, availableBytes: 5e9,
    measured: { freeBytes: 5e9, totalBytes: 12e9, torchReservedBytes: 4e9, torchAllocatedBytes: 3.5e9, gpuName: 'Measured GPU' },
    consumers: { models: 3e9 },
  } },
  leases: null,
  consumerDetails: { models: [{ itemId: 'm1', displayName: 'Flux model', bytesByResidency: { 'vram:cuda:0': 3e9, ram: 1e9 } }] },
}

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it('rejects a base response superseded by push and details invalidated by closing', async () => {
  const status = coreSignal<ConnectionStatus>('connected')
  let push: ((next: MemoryStatus) => void) | undefined
  let resolveBase: ((value: MemoryStatus) => void) | undefined
  let resolveDetail: ((value: MemoryStatus) => void) | undefined
  const accepted: MemoryStatus[] = []
  const controller = new MemoryStatusController({ status,
    onMemoryStatus: (listener) => { push = listener; return () => {} },
    fetchMemoryStatus: (details = false) => new Promise((resolve) => { if (details) resolveDetail = resolve; else resolveBase = resolve }),
  }, (next) => accepted.push(next), () => {}, (() => 1) as never, (() => {}) as never, () => 1000)
  push!(payload)
  resolveBase!({ ...payload, queue: { ...payload.queue, queued: 99 } })
  await flush()
  controller.setExpanded('resources', true)
  controller.setExpanded('resources', false)
  resolveDetail!(payload)
  await flush()
  expect(accepted).toEqual([payload])
  controller.dispose()
})

it('ends initial loading after a telemetry failure, including after dismissal and recovery', async () => {
  let reject: ((reason: Error) => void) | undefined
  let push: ((next: MemoryStatus) => void) | undefined
  const connection = {
    status: coreSignal<ConnectionStatus>('connected'),
    fetchMemoryStatus: () => new Promise<MemoryStatus>((_resolve, rejectRequest) => { reject = rejectRequest }),
    onMemoryStatus: (listener: (next: MemoryStatus) => void) => { push = listener; return () => {} },
    fetchRuntimeSettings: async () => ({ categories: { granted: [], available: [] }, settings: {} }),
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <ResourcesPanel backends={[{ id: 'local', label: 'Local', connection }]} activeBackendId="local" />, root)
  expect(root.textContent).toContain('Loading resources...')
  reject!(new Error('Telemetry unavailable.')); await flush()
  expect(root.textContent).toContain('Telemetry unavailable.')
  expect(root.textContent).not.toContain('Loading resources...')
  root.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
  expect(root.textContent).not.toContain('Telemetry unavailable.')
  expect(root.textContent).not.toContain('Loading resources...')
  push!(payload); await flush()
  expect(root.textContent).toContain('Measured GPU')
  expect(root.textContent).not.toContain('Loading resources...')
  unmount()
})

it.each([
  { models: true, allocator: false, inconsistent: false, expected: 'Models: 3.0 GB, Other memory: 4.0 GB' },
  { models: false, allocator: true, inconsistent: false, expected: 'Held, unused: 0.5 GB, Other memory: 6.5 GB' },
  { models: false, allocator: false, inconsistent: false, expected: 'Used: 7.0 GB' },
  { models: true, allocator: true, inconsistent: true, expected: 'Used: 7.0 GB' },
])('draws only independently reported parts: $expected', async ({ models, allocator, inconsistent, expected }) => {
  const measured = { freeBytes: 5e9, totalBytes: 12e9, ...(allocator ? { torchReservedBytes: inconsistent ? 12e9 : 4e9, torchAllocatedBytes: 3.5e9 } : {}) }
  const { consumerDetails: _details, ...base } = payload
  const status: MemoryStatus = { ...base, ...(models ? { consumerDetails: payload.consumerDetails! } : {}), memoryGovernor: { 'vram:cuda:0': { ...payload.memoryGovernor!['vram:cuda:0']!, measured } } }
  const connection = { status: coreSignal<ConnectionStatus>('connected'), fetchMemoryStatus: async () => status, onMemoryStatus: () => () => {}, fetchRuntimeSettings: async () => ({ categories: { granted: ['memory-headroom'], available: ['memory-headroom'] }, settings: { 'memory-headroom': { value: 1e9, writable: true } } }) } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <ResourcesPanel backends={[{ id: 'local', label: 'Local', connection }]} activeBackendId="local" />, root)
  await flush()
  expect(root.querySelector('svg.dinkster-resource-bar')!.getAttribute('aria-label')).toBe(expected)
  expect(root.querySelector('[role="slider"][aria-label="Always keep free"]')!.getAttribute('aria-valuenow')).toBe('1000000000')
  unmount()
})

it('preserves non-card and unmeasured budgets with exact sizes and automatic removal', async () => {
  const configured = { 'vram:cuda:0': 8e9, ram: 10e9, disk: 25e9, 'vram:cuda:1': 6e9, custom: 123456789 }
  const status: MemoryStatus = { ...payload, memoryGovernor: { ...payload.memoryGovernor, ram: { ...payload.memoryGovernor!['vram:cuda:0']!, measured: null }, 'vram:cuda:1': { ...payload.memoryGovernor!['vram:cuda:0']!, measured: null } } }
  const updateRuntimeSetting = vi.fn(async (_category: string, value: unknown) => ({ value, writable: true }))
  const connection = { status: coreSignal<ConnectionStatus>('connected'), fetchMemoryStatus: async () => status, onMemoryStatus: () => () => {}, fetchRuntimeSettings: async () => ({ categories: { granted: ['memory-budgets'], available: ['memory-budgets'] }, settings: { 'memory-budgets': { value: configured, writable: true } } }), updateRuntimeSetting } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <ResourcesPanel backends={[{ id: 'local', label: 'Local', connection }]} activeBackendId="local" />, root)
  await flush()
  const field = (name: string) => {
    const label = [...root.querySelectorAll('label')].find((label) => label.textContent === name)!
    return root.querySelector<HTMLInputElement>(`[id="${label.htmlFor}"]`)!
  }
  expect(field('System memory').value).toBe('10.0 GB')
  expect(field('Disk').value).toBe('25.0 GB')
  expect(field('vram:cuda:1').value).toBe('6.0 GB')
  expect(root.querySelectorAll('.dinkster-resource-card')).toHaveLength(1)
  expect(field('custom').value).toBe('0.123456789 GB')
  expect(root.querySelectorAll('[role="slider"]')).toHaveLength(1)
  const input = (name: string, value: string) => { const element = field(name); element.value = value; element.dispatchEvent(new Event('input', { bubbles: true })) }
  const form = field('Disk').closest('form')!
  const apply = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
  expect(apply.disabled).toBe(true)
  input('System memory', '9.0 GB')
  expect(apply.disabled).toBe(false)
  input('System memory', '10.0 GB')
  expect(apply.disabled).toBe(true)
  input('System memory', '1.75 GB'); input('custom', '7G'); input('vram:cuda:1', '987654321')
  field('Disk').parentElement!.querySelector('button')!.click()
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush()
  expect(updateRuntimeSetting).toHaveBeenLastCalledWith('memory-budgets', { 'vram:cuda:0': 8e9, ram: 1.75e9, 'vram:cuda:1': 987654321, custom: '7G' })
  expect(field('System memory').value).toBe('1.75 GB')
  updateRuntimeSetting.mockRejectedValueOnce(new Error('Exact budget rejected.'))
  input('System memory', 'bad size'); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await flush()
  expect(root.textContent).toContain('Exact budget rejected.')
  expect(field('System memory').value).toBe('bad size')
  unmount()
})

it('offers measured-card limits without inventing a reported budget and unloads unmeasured residency', async () => {
  const status: MemoryStatus = { ...payload, memoryGovernor: {
    'vram:cuda:0': { ...payload.memoryGovernor!['vram:cuda:0']!, budgetBytes: null },
    ram: { ...payload.memoryGovernor!['vram:cuda:0']!, measured: null },
  } }
  const updateRuntimeSetting = vi.fn(async (_category: string, value: unknown) => ({ value, writable: true }))
  const unloadMemory = vi.fn(async () => ({ requestedBytes: 3e9, freedBytes: 3e9 }))
  const connection = { status: coreSignal<ConnectionStatus>('connected'), fetchMemoryStatus: async () => status, onMemoryStatus: () => () => {}, fetchRuntimeSettings: async () => ({ categories: { granted: ['memory-budgets'], available: ['memory-budgets'] }, settings: { 'memory-budgets': { value: {}, writable: true } } }), updateRuntimeSetting, unloadMemory } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <ResourcesPanel backends={[{ id: 'local', label: 'Local', connection }]} activeBackendId="local" />, root)
  await flush()
  const slider = root.querySelector('[role="slider"]')!
  expect(slider.getAttribute('aria-valuemax')).toBe('12000000000')
  expect(slider.getAttribute('aria-valuenow')).toBe('12000000000')
  expect(slider.parentElement!.textContent).toContain('Automatic')
  expect(root.querySelector('.dinkster-resource-limit')).toBeNull()
  expect(updateRuntimeSetting).not.toHaveBeenCalled()
  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await flush()
  expect(updateRuntimeSetting).toHaveBeenLastCalledWith('memory-budgets', { 'vram:cuda:0': 11945377792 })
  const all = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Unload all')!
  all.click(); await flush()
  expect(unloadMemory).not.toHaveBeenCalled()
  const confirm = [...root.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'Unload').at(-1)!
  confirm.click(); await flush()
  expect(unloadMemory.mock.calls).toEqual([['vram:cuda:0'], ['ram']])
  unmount()
})

it('targets a backend repeatedly without collapsing other backends', async () => {
  const connection = {
    status: coreSignal<ConnectionStatus>('connected'),
    fetchMemoryStatus: async () => ({ ...payload, memoryGovernor: null }),
    onMemoryStatus: () => () => {},
    fetchRuntimeSettings: async () => ({ categories: { granted: [], available: [] }, settings: {} }),
  } as unknown as DinksterConnection
  const [focusBackend, setFocusBackend] = createSignal<{ id: string }>()
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <ResourcesPanel backends={[{ id: 'local', label: 'Local', connection }, { id: 'studio', label: 'Studio', connection }]} activeBackendId="local" focusBackend={focusBackend()} />, root)
  const row = (id: string) => root.querySelector(`[data-backend="${id}"]`)!
  const button = (id: string) => row(id).querySelector('button')!
  await flush()
  expect(button('local').getAttribute('aria-expanded')).toBe('true')
  expect(button('studio').getAttribute('aria-expanded')).toBe('false')
  setFocusBackend({ id: 'studio' }); await flush()
  expect(button('studio').getAttribute('aria-expanded')).toBe('true')
  expect(button('local').getAttribute('aria-expanded')).toBe('true')
  button('studio').click(); await flush()
  expect(button('studio').getAttribute('aria-expanded')).toBe('false')
  setFocusBackend({ id: 'studio' }); await flush()
  expect(button('studio').getAttribute('aria-expanded')).toBe('true')
  expect(row('studio').textContent).toContain('Queued3')
  expect(row('studio').textContent).not.toContain('Limits')
  unmount()
})

it('preserves focused model rows across snapshots and confirms per-card unloads', async () => {
  let push: ((next: MemoryStatus) => void) | undefined
  const unloadMemory = vi.fn(async () => ({ requestedBytes: 3e9, freedBytes: 3e9 }))
  const connection = {
    status: coreSignal<ConnectionStatus>('connected'),
    fetchMemoryStatus: async () => payload,
    onMemoryStatus: (listener: (next: MemoryStatus) => void) => { push = listener; return () => {} },
    fetchRuntimeSettings: async () => ({ categories: { granted: ['memory-budgets'], available: ['memory-budgets'] }, settings: { 'memory-budgets': { value: {}, writable: true } } }),
    updateRuntimeSetting: async () => { throw new Error('Server refused the memory limit.') },
    unloadMemory,
  } as unknown as DinksterConnection
  const root = document.createElement('div'); document.body.append(root)
  const unmount = render(() => <ResourcesPanel backends={[{ id: 'local', label: 'Local', connection }]} activeBackendId="local" />, root)
  await flush()
  expect(root.textContent).toContain('7.0 GB of 12.0 GB')
  expect(root.querySelector('svg.dinkster-resource-bar')!.getAttribute('aria-label')).toBe('Models: 3.0 GB, Held, unused: 0.5 GB, Other memory: 3.5 GB')
  expect(root.querySelector('.dinkster-resource-model')!.textContent).toContain('3.0 GB')
  const unload = root.querySelector<HTMLButtonElement>('[aria-label="Unload Flux model"]')!
  unload.focus()
  push!({ ...payload }); await flush()
  expect(document.activeElement).toBe(unload)
  unload.click(); await flush()
  expect(unloadMemory).not.toHaveBeenCalled()
  const confirm = [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Unload' && button !== unload)!
  confirm.click(); await flush()
  expect(unloadMemory).toHaveBeenCalledWith('vram:cuda:0', 'models', 'm1')
  expect(root.textContent).toContain('Resources updated.')
  const slider = root.querySelector('[role="slider"]')!
  slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await flush()
  expect(root.textContent).toContain('Server refused the memory limit.')
  expect(slider.getAttribute('aria-valuenow')).toBe('8000000000')
  push!({ ...payload }); await flush()
  expect(root.textContent).toContain('Server refused the memory limit.')
  unmount()
})
