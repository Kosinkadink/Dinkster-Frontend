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
