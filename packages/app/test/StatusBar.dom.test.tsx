// @vitest-environment happy-dom
import { render } from 'solid-js/web'
import { createSignal as solidSignal } from 'solid-js'
import { asPromptId, type Signal } from '@dinkster/core'
import type { ConnectionStatus, MemoryStatus } from '@dinkster/client'
import { afterEach, expect, it, vi } from 'vitest'
import { AppState } from '../src/app-state.js'
import { StatusBar } from '../src/StatusBar.js'
import { createWorkflowApp } from './fixtures/workflow-app.js'

let app: AppState
let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.(); app.dispose(); vi.restoreAllMocks(); document.body.replaceChildren(); localStorage.clear()
})

it('follows the active backend run and opens the explanatory panels without toggling them closed', async () => {
  app = createWorkflowApp(null)
  const backend = app.backends.get()[0]!
  const other = app.addBackend('/other-status-backend', 'Other backend', false, 'dinkster')!
  backend.schemaState.set({ status: 'ready' })
  vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue({ connection: backend.id, hash: 'status-test', schemas: new Map(), diagnostics: [], resolve: () => undefined })
  const status = backend.connection.status as Signal<ConnectionStatus>
  status.set('connected')
  const [problem, setProblem] = solidSignal<{ count: number; severity: 'error'; label: string }>()
  const opened: string[] = []
  const root = document.createElement('div')
  document.body.append(root)
  for (const owner of [backend, other]) {
    vi.spyOn(owner.connection, 'fetchModelDownloads').mockResolvedValue({ instance: 'test', jobs: [] })
    vi.spyOn(owner.connection, 'fetchMountSettings').mockRejectedValue(new Error('Unavailable in fixture'))
    vi.spyOn(owner.connection, 'fetchMemoryStatus').mockResolvedValue({ devices: {}, queue: { queued: 0, running: [], maxRunningJobs: 1, paused: false }, memoryGovernor: {}, leases: [] })
  }
  dispose = render(() => <StatusBar app={app} backend={() => backend} tab={() => app.activeTab()} problems={problem}
    context={() => '2 nodes, 1 selected'} visible={() => true} placement={() => undefined} transient={() => undefined}
    extensions={<span>Extension state</span>} openPanel={(id) => opened.push(id)} openRuns={(all) => opened.push(all ? 'all' : 'workflow')}
    openAppLog={() => opened.push('app-log')} />, root)
  expect(root.querySelector('[data-testid="status-run"]')?.textContent).toContain('Idle')
  expect(root.querySelector('[data-testid="status-problems"]')).toBeNull()
  const tab = app.activeTab()!
  const artifact = { snapshot: tab.store.doc, prompt: { first: {}, second: {} }, scope: { kind: 'full' }, provenance: { toSource: {}, toRuntime: {} }, schemaHash: 'test' }
  const ref = { connection: backend.id, prompt: asPromptId('own-run') }
  app.store.register(ref, artifact as never, 100)
  app.store.apply({ kind: 'started', execution: ref, timestamp: 101 })
  app.store.apply({ kind: 'nodeStates', execution: ref, timestamp: 102, snapshot: true, nodes: { first: { state: 'done' }, second: { state: 'running', value: 0.5 } } })
  app.store.register({ connection: backend.id, prompt: asPromptId('queued') }, artifact as never, 103)
  app.store.register({ connection: other.id, prompt: asPromptId('foreign-queued') }, artifact as never, 104)
  await vi.waitFor(() => expect(root.querySelector('[data-testid="status-run"]')?.textContent).toContain('75%'))
  expect(root.querySelector('[data-testid="status-run"]')?.textContent).toContain('1 queued')
  expect(root.querySelector('[data-testid="status-run"] .dinkster-run-icon')?.hasAttribute('data-running')).toBe(true)
  root.querySelector<HTMLButtonElement>('[data-testid="status-run"]')!.click()
  root.querySelector<HTMLButtonElement>('[data-testid="status-connection"]')!.click()
  root.querySelector<HTMLButtonElement>('[data-testid="status-connection"]')!.click()
  setProblem({ count: 3, severity: 'error', label: '3 problems, worst severity error' })
  root.querySelector<HTMLButtonElement>('[data-testid="status-problems"]')!.click()
  expect(opened).toEqual(['workflow', 'backends', 'backends', 'problems'])
  expect(root.textContent).toContain('Extension state')
  status.set('disconnected')
  app.backendsTick.update((value) => value + 1)
  expect(root.querySelector('[data-testid="status-connection"]')?.textContent).toContain('disconnected')
})

it('shows the fullest measured graphics card and omits CPU, unknown and disconnected readings', async () => {
  app = createWorkflowApp(null)
  const backend = app.backends.get()[0]!
  vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue({ connection: backend.id, hash: 'status-test', schemas: new Map(), diagnostics: [], resolve: () => undefined })
  const status = backend.connection.status as Signal<ConnectionStatus>
  status.set('connected')
  const governor = (total: number, free: number) => ({ budgetBytes: null, reservedBytes: 0, consumerFootprintBytes: 0, availableBytes: null, consumers: {}, measured: { totalBytes: total, freeBytes: free } })
  const memory: MemoryStatus = { devices: {}, queue: { queued: 0, running: [], maxRunningJobs: 1, paused: false }, leases: [], memoryGovernor: {
    'cuda:0': governor(1000, 700), 'cuda:1': governor(2000, 200), cpu: governor(10000, 0), 'cuda:2': { ...governor(1000, 0), measured: null },
  } }
  vi.spyOn(backend.connection, 'fetchMemoryStatus').mockResolvedValue(memory)
  vi.spyOn(backend.connection, 'fetchModelDownloads').mockResolvedValue({ instance: 'test', jobs: [] })
  vi.spyOn(backend.connection, 'fetchMountSettings').mockRejectedValue(new Error('Unavailable in fixture'))
  const opened: string[] = []
  const root = document.createElement('div')
  document.body.append(root)
  dispose = render(() => <StatusBar app={app} backend={() => backend} tab={() => undefined} problems={() => undefined}
    context={() => undefined} visible={() => true} placement={() => undefined} transient={() => undefined} extensions={null}
    openPanel={(id) => opened.push(id)} openRuns={() => {}} openAppLog={() => {}} />, root)
  await vi.waitFor(() => expect(root.querySelector('[data-testid="status-memory"]')).not.toBeNull())
  const memoryButton = root.querySelector<HTMLButtonElement>('[data-testid="status-memory"]')!
  expect(memoryButton.textContent).toContain('1.8 KiB / 2.0 KiB')
  expect(memoryButton.getAttribute('aria-label')).toContain('cuda:0')
  expect(memoryButton.getAttribute('aria-label')).toContain('cuda:1')
  expect(memoryButton.getAttribute('aria-label')).not.toContain('cuda:2')
  memoryButton.click()
  expect(opened).toEqual(['memory'])
  status.set('disconnected')
  expect(root.querySelector('[data-testid="status-memory"]')).toBeNull()
})
