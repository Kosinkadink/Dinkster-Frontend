// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerCatalog, setLocale } from '@dinkster/core'
import { DesktopManagementDialog, type DesktopMountConnection } from '../src/DesktopManagementDialog.js'
import type { DesktopInfo, DinksterDesktopBridge } from '../src/desktop-bridge.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

const info: DesktopInfo = {
  appVersion: '0.2.0',
  engineCommit: '1234567890abcdef',
  remoteWorkerProtocol: 8,
  variant: 'cuda',
  storageBytes: 2 * 1024 * 1024 * 1024,
  releases: [
    { commit: '1234567890abcdef', variant: 'cuda', bytes: 1024, active: true },
    { commit: 'fedcba0987654321', variant: 'mps', bytes: 2048, active: false },
  ],
  update: { state: 'current', detail: 'Dinkster Desktop is up to date' },
}

function mount(connection?: DesktopMountConnection, overrides: Partial<DinksterDesktopBridge> = {}) {
  const selectEngine = vi.fn(async () => undefined)
  const exportSupportReport = vi.fn(async () => 'C:\\reports\\dinkster.json')
  const saveRemoteWorker = vi.fn(async () => undefined)
  const removeRemoteWorker = vi.fn(async () => undefined)
  const bridge: DinksterDesktopBridge = {
    locale: vi.fn(async () => 'en-US'),
    status: vi.fn(),
    retry: vi.fn(),
    info: vi.fn(async () => info),
    selectEngine,
    checkForUpdates: vi.fn(async () => undefined),
    installUpdate: vi.fn(async () => undefined),
    chooseDirectory: vi.fn(async () => 'D:\\Shared Models'),
    revealFile: vi.fn(async () => undefined),
    exportSnapshot: vi.fn(async () => 'C:\\snapshots\\dinkster.json'),
    importSnapshot: vi.fn(async () => ({ format: 1 })),
    systemCheck: vi.fn(async () => ({
      platform: 'win32', architecture: 'x64', freeBytes: 10 * 1024 ** 3, totalBytes: 20 * 1024 ** 3,
      engineReady: true, engineDetail: 'Locked cuda environment is installed',
      gpu: { available: true, name: 'Test GPU', driver: '600.1', memoryMiB: 12288 },
    })),
    clearCache: vi.fn(async () => undefined),
    exportSupportReport,
    windowContext: vi.fn(async () => ({ id: 'primary' as const, kind: 'primary' as const })),
    windowLayout: vi.fn(async () => ({ windows: [{ id: 'primary' as const, kind: 'primary' as const }] })),
    openWorkflowWindow: vi.fn(async () => undefined),
    openPanelWindow: vi.fn(async () => undefined),
    redockWindow: vi.fn(async () => undefined),
    switchProject: vi.fn(async () => undefined),
    openProjectWindow: vi.fn(async () => undefined),
    setConnectionCredential: vi.fn(async () => undefined),
    retireConnectionProfile: vi.fn(async () => undefined),
    connectionCredentials: vi.fn(async () => ({ custody: true, profiles: [] })),
    remoteWorkers: vi.fn(async () => []),
    saveRemoteWorker,
    removeRemoteWorker,
    chooseRemoteWorkerFile: vi.fn(async () => undefined),
    takeDeepLinks: vi.fn(async () => []),
    onStatus: vi.fn(() => () => undefined),
    onLog: vi.fn(() => () => undefined),
    onInfo: vi.fn(() => () => undefined),
    onWindowLayout: vi.fn(() => () => undefined),
    onDeepLinkPending: vi.fn(() => () => undefined),
    ...overrides,
  }
  window.dinksterDesktop = bridge
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <DesktopManagementDialog connection={connection} />, root)
  return { root, selectEngine, exportSupportReport, saveRemoteWorker, removeRemoteWorker, bridge, unmount }
}

function enter(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  control.value = value
  control.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
}

function choose(control: HTMLSelectElement, value: string): void {
  control.value = value
  control.dispatchEvent(new Event('change', { bubbles: true }))
}

afterEach(() => {
  setLocale('en')
  delete window.dinksterDesktop
  document.body.replaceChildren()
})

describe('DesktopManagementDialog', () => {
  it('shows release, storage, update, and rollback controls', async () => {
    const { root, selectEngine } = mount()
    await flush()
    expect(root.textContent).toContain('Version 0.2.0')
    expect(root.textContent).toContain('2.0 GB')
    expect(root.textContent).toContain('Dinkster Desktop is up to date')
    const restore = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Restore') as HTMLButtonElement
    restore.click()
    await flush()
    expect(selectEngine).toHaveBeenCalledWith('fedcba0987654321', 'mps')
  })

  it('switches hardware environments and exports a support report', async () => {
    const { root, selectEngine, exportSupportReport } = mount()
    await flush()
    const buttons = [...root.querySelectorAll('button')]
    expect(['Use CPU', 'Use CUDA', 'Use MPS', 'Use ROCm', 'Use XPU'].every((label) =>
      buttons.some((button) => button.textContent?.trim() === label))).toBe(true)
    ;(buttons.find((button) => button.textContent?.trim() === 'Use ROCm') as HTMLButtonElement).click()
    await flush()
    expect(selectEngine).toHaveBeenCalledWith('1234567890abcdef', 'rocm')
    ;(buttons.find((button) => button.textContent === 'Export report') as HTMLButtonElement).click()
    await flush()
    expect(exportSupportReport).toHaveBeenCalledOnce()
    expect(root.textContent).toContain('Support report saved')
  })

  it('grants an existing model folder without copying and exposes diagnostics', async () => {
    const addMount = vi.fn(async () => ({ id: 'shared-models', mode: 'read' as const, state: 'pending' }))
    const fetchMountSettings = vi.fn()
      .mockResolvedValueOnce({ mounts: [], mountChangesAllowed: true })
      .mockResolvedValueOnce({ mounts: [{ id: 'shared-models', mode: 'read', state: 'pending' }], mountChangesAllowed: true })
    const { root, unmount } = mount({ addMount, fetchMountSettings })
    await flush()
    const choose = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Choose folder') as HTMLButtonElement
    choose.click()
    await flush()
    expect(root.textContent).toContain('D:\\Shared Models')
    root.querySelector<HTMLFormElement>('.desktop-mount-form')!.requestSubmit()
    await flush()
    expect(addMount).toHaveBeenCalledWith('shared-models', 'D:\\Shared Models', 'read')
    expect(root.textContent).toContain('Test GPU')
    expect(root.textContent).toContain('10.0 GB free of 20.0 GB')
    unmount()
  })

  it('guides a complete remote-worker profile through the desktop bridge', async () => {
    const remoteWorkers = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: 'C:\\Dinkster\\worker.token',
        nodes: ['sampler.custom', 'image.decode'],
        memory: [{ device: 'ram', size: '24G' }, { device: 'vram:cuda:0', size: '20G' }],
      }])
    const chooseRemoteWorkerFile = vi.fn(async () => ({ path: 'C:\\Dinkster\\worker.token', grant: 'token-grant' }))
    const saveRemoteWorker = vi.fn(async () => undefined)
    const { root } = mount(undefined, { remoteWorkers, chooseRemoteWorkerFile, saveRemoteWorker })
    await flush()
    expect(root.textContent).toContain('protocol 8 from matching Dinkster engine revision 1234567890ab')
    ;([...root.querySelectorAll('button')].find((button) => button.textContent === 'Add worker') as HTMLButtonElement).click()
    const form = root.querySelector<HTMLFormElement>('.desktop-worker-form')!
    const inputs = form.querySelectorAll<HTMLInputElement>('input')
    const textareas = form.querySelectorAll<HTMLTextAreaElement>('textarea')
    enter(inputs[0]!, 'render-box')
    enter(inputs[1]!, 'worker.example.test:5151')
    ;([...form.querySelectorAll('button')].find((button) => button.textContent === 'Choose') as HTMLButtonElement).click()
    await flush()
    choose(form.querySelector<HTMLSelectElement>('[aria-label="Node routing policy"]')!, 'allowlist')
    enter(textareas[0]!, 'sampler.custom, image.decode')
    enter(textareas[1]!, 'ram=24G\nvram:cuda:0=20G')
    form.requestSubmit()
    await vi.waitFor(() => expect(saveRemoteWorker).toHaveBeenCalledOnce())
    expect(saveRemoteWorker).toHaveBeenCalledWith({
      name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: 'C:\\Dinkster\\worker.token',
      tokenFileGrant: 'token-grant',
      nodes: ['sampler.custom', 'image.decode'],
      memory: [{ device: 'ram', size: '24G' }, { device: 'vram:cuda:0', size: '20G' }],
    })
    await vi.waitFor(() => expect(root.textContent).toContain('render-box'))
    expect(root.textContent).toContain('2 allowed node types')
    expect(root.textContent).toContain('2 memory budgets')
    expect(root.textContent).toContain('local engine restarted')
  })

  it('preserves raw worker and memory names through the desktop bridge', async () => {
    const chooseRemoteWorkerFile = vi.fn(async () => ({ path: 'C:\\Dinkster\\worker.token', grant: 'token-grant' }))
    const saveRemoteWorker = vi.fn(async () => undefined)
    const { root } = mount(undefined, { chooseRemoteWorkerFile, saveRemoteWorker })
    await flush()
    ;([...root.querySelectorAll('button')].find((button) => button.textContent === 'Add worker') as HTMLButtonElement).click()
    const form = root.querySelector<HTMLFormElement>('.desktop-worker-form')!
    const inputs = form.querySelectorAll<HTMLInputElement>('input')
    enter(inputs[0]!, '\uFEFFrender-box\uFEFF')
    enter(inputs[1]!, 'worker.example.test:5151')
    ;([...form.querySelectorAll('button')].find((button) => button.textContent === 'Choose') as HTMLButtonElement).click()
    await flush()
    enter(form.querySelectorAll<HTMLTextAreaElement>('textarea')[1]!, '\uFEFFram\uFEFF=24G\n\uFEFF=1G')
    form.requestSubmit()

    await vi.waitFor(() => expect(saveRemoteWorker).toHaveBeenCalledOnce())
    expect(saveRemoteWorker).toHaveBeenCalledWith({
      name: '\uFEFFrender-box\uFEFF',
      endpoint: 'worker.example.test:5151',
      tokenFile: 'C:\\Dinkster\\worker.token',
      tokenFileGrant: 'token-grant',
      memory: [{ device: '\uFEFFram\uFEFF', size: '24G' }, { device: '\uFEFF', size: '1G' }],
    })
  })

  it('renders and preserves an explicit empty node allowlist', async () => {
    const worker = {
      name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: 'C:\\Dinkster\\worker.token',
      nodes: [], memory: [],
    }
    const saveRemoteWorker = vi.fn(async () => undefined)
    const { root } = mount(undefined, {
      remoteWorkers: vi.fn(async () => [worker]),
      saveRemoteWorker,
    })
    await vi.waitFor(() => expect(root.textContent).toContain('No allowed node types'))
    ;([...root.querySelectorAll('button')].find((button) => button.textContent === 'Edit') as HTMLButtonElement).click()
    const form = root.querySelector<HTMLFormElement>('.desktop-worker-form')!
    expect(form.querySelector<HTMLSelectElement>('[aria-label="Node routing policy"]')!.value).toBe('allowlist')
    expect(form.querySelector<HTMLTextAreaElement>('[aria-label="Allowed node types"]')!.value).toBe('')
    expect(form.textContent).toContain('An empty list allows no node types')
    form.requestSubmit()

    await vi.waitFor(() => expect(saveRemoteWorker).toHaveBeenCalledOnce())
    expect(saveRemoteWorker).toHaveBeenCalledWith(worker)
  })

  it('refuses remote-worker changes for an installed engine with unknown worker compatibility', async () => {
    const { remoteWorkerProtocol, ...olderInfo } = info
    expect(remoteWorkerProtocol).toBe(8)
    const { root } = mount(undefined, {
      info: vi.fn(async () => ({ ...olderInfo, engineCommit: 'older-engine' })),
    })
    await flush()
    expect(root.textContent).toContain('Restore the packaged engine before changing remote workers.')
    const addWorker = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Add worker') as HTMLButtonElement
    expect(addWorker.disabled).toBe(true)
  })

  it('requires a fresh token-file grant before changing a worker transport', async () => {
    const worker = {
      name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: 'C:\\Dinkster\\worker.token', memory: [],
    }
    const chooseRemoteWorkerFile = vi.fn(async () => ({ path: worker.tokenFile, grant: 'retarget-grant' }))
    const { root } = mount(undefined, {
      remoteWorkers: vi.fn(async () => [worker]),
      chooseRemoteWorkerFile,
    })
    await vi.waitFor(() => expect(root.textContent).toContain('render-box'))
    ;([...root.querySelectorAll('button')].find((button) => button.textContent === 'Edit') as HTMLButtonElement).click()
    const form = root.querySelector<HTMLFormElement>('.desktop-worker-form')!
    enter(form.querySelectorAll<HTMLInputElement>('input')[1]!, 'replacement.example.test:5151')
    const save = [...form.querySelectorAll('button')].find((button) => button.textContent === 'Save and restart engine') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(form.textContent).toContain('Choose the token file again to authorize the changed address or TLS setting.')
    ;([...form.querySelectorAll('button')].find((button) => button.textContent === 'Choose') as HTMLButtonElement).click()
    await flush()
    expect(chooseRemoteWorkerFile).toHaveBeenCalledWith('token')
    expect(save.disabled).toBe(false)
  })

  it('requires confirmation before removing a remote worker', async () => {
    const worker = {
      name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: 'C:\\Dinkster\\worker.token', memory: [],
    }
    const remoteWorkers = vi.fn().mockResolvedValueOnce([worker]).mockResolvedValueOnce([])
    const removeRemoteWorker = vi.fn(async () => undefined)
    const { root } = mount(undefined, { remoteWorkers, removeRemoteWorker })
    await vi.waitFor(() => expect(root.textContent).toContain('render-box'))
    const remove = [...root.querySelectorAll('button')].find((button) => button.textContent === 'Remove') as HTMLButtonElement
    remove.click()
    expect(removeRemoteWorker).not.toHaveBeenCalled()
    expect(remove.textContent).toBe('Confirm remove')
    remove.click()
    await vi.waitFor(() => expect(removeRemoteWorker).toHaveBeenCalledWith('render-box'))
    await vi.waitFor(() => expect(root.textContent).toContain('No remote workers are configured'))
  })

  it('keeps every desktop action wired after switching to Chinese', async () => {
    const addMount = vi.fn(async () => ({ id: 'shared-models', mode: 'read' as const, state: 'pending' }))
    const fetchMountSettings = vi.fn(async () => ({ mounts: [], mountChangesAllowed: true }))
    const connection = { addMount, fetchMountSettings }
    const worker = {
      name: 'render-box', endpoint: 'worker.example.test:5151', tokenFile: 'C:\\Dinkster\\worker.token', memory: [],
    }
    const readyInfo: DesktopInfo = { ...info, update: { state: 'ready', detail: 'raw update detail' } }
    const { root, bridge } = mount(connection, {
      info: vi.fn(async () => readyInfo),
      remoteWorkers: vi.fn(async () => [worker]),
    })
    await vi.waitFor(() => expect(root.textContent).toContain('render-box'))
    setLocale('zh')
    await flush()
    const section = (title: string): HTMLElement => [...root.querySelectorAll<HTMLElement>('.desktop-management-section')]
      .find((candidate) => candidate.querySelector('h3')?.textContent === title)!
    const click = async (parent: ParentNode, label: string): Promise<void> => {
      const control = [...parent.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === label)
      if (!control) throw new Error(`Missing button ${label}`)
      control.click()
      await vi.waitFor(() => expect(control.disabled).toBe(false))
    }

    await click(section('\u5f15\u64ce\u73af\u5883'), '\u4f7f\u7528 MPS')
    expect(bridge.selectEngine).toHaveBeenCalledWith('1234567890abcdef', 'mps')
    await click(section('\u5b89\u88c5\u5feb\u7167'), '\u5bfc\u51fa\u5feb\u7167')
    expect(bridge.exportSnapshot).toHaveBeenCalledOnce()
    await click(section('\u5b89\u88c5\u5feb\u7167'), '\u6062\u590d\u5feb\u7167')
    expect(bridge.importSnapshot).toHaveBeenCalledOnce()
    await click(section('\u73b0\u6709\u6a21\u578b\u6587\u4ef6\u5939'), '\u9009\u62e9\u6587\u4ef6\u5939')
    await vi.waitFor(() => expect(root.querySelector('.desktop-mount-form')).not.toBeNull())
    root.querySelector<HTMLFormElement>('.desktop-mount-form')!.requestSubmit()
    await vi.waitFor(() => expect(addMount).toHaveBeenCalledWith('shared-models', 'D:\\Shared Models', 'read'))
    await vi.waitFor(() => expect([...section('\u8fdc\u7a0b\u5de5\u4f5c\u8282\u70b9').querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '\u79fb\u9664')?.disabled).toBe(false))
    await click(section('\u8fdc\u7a0b\u5de5\u4f5c\u8282\u70b9'), '\u79fb\u9664')
    await click(section('\u8fdc\u7a0b\u5de5\u4f5c\u8282\u70b9'), '\u786e\u8ba4\u79fb\u9664')
    expect(bridge.removeRemoteWorker).toHaveBeenCalledWith('render-box')
    await click(section('\u7cfb\u7edf\u68c0\u67e5\u5668'), '\u518d\u6b21\u8fd0\u884c')
    expect(bridge.systemCheck).toHaveBeenCalledTimes(2)
    await click(section('\u7cfb\u7edf\u68c0\u67e5\u5668'), '\u6e05\u9664 uv \u7f13\u5b58')
    expect(bridge.clearCache).toHaveBeenCalledOnce()
    await click(section('\u684c\u9762\u66f4\u65b0'), '\u68c0\u67e5\u66f4\u65b0')
    expect(bridge.checkForUpdates).toHaveBeenCalledOnce()
    await click(section('\u684c\u9762\u66f4\u65b0'), '\u91cd\u542f\u5e76\u5b89\u88c5')
    expect(bridge.installUpdate).toHaveBeenCalledOnce()
    await click(section('\u652f\u6301\u5305'), '\u5bfc\u51fa\u62a5\u544a')
    expect(bridge.exportSupportReport).toHaveBeenCalledOnce()
  })

  it('relabels mounted chrome without changing desktop state, raw facts, or requests', async () => {
    registerCatalog('de-DE', {
      'desktopManagement.summary.desktop': '[DESKTOP HOST]',
      'desktopManagement.summary.version': '[VERSION {version}]',
      'desktopManagement.system.title': '[SYSTEM CHECKER]',
      'desktopManagement.worker.confirmRemove': '[CONFIRM REMOVE]',
      'desktopManagement.worker.editTitle': '[EDIT {worker}]',
      'desktopManagement.worker.memoryInvalid': '[MEMORY {entry}]',
      'desktopManagement.worker.save': '[SAVE WORKER]',
      'desktopManagement.worker.title': '[REMOTE WORKERS]',
      'raw.engine.detail': '[TRANSLATED ENGINE DETAIL]',
      'raw.update.detail': '[TRANSLATED UPDATE DETAIL]',
      'raw-worker': '[TRANSLATED WORKER]',
      'raw.example.test:5151': '[TRANSLATED ENDPOINT]',
    })
    const worker = {
      name: 'raw-worker', endpoint: 'raw.example.test:5151', tokenFile: 'C:\\raw\\worker.token',
      nodes: ['raw.node'], memory: [{ device: 'raw-device', size: '24G' }],
    }
    const rawInfo: DesktopInfo = { ...info, update: { state: 'current', detail: 'raw.update.detail' } }
    const remoteWorkers = vi.fn(async () => [worker])
    const systemCheck = vi.fn(async () => ({
      platform: 'raw-platform', architecture: 'raw-architecture', freeBytes: 1024, totalBytes: 2048,
      engineReady: true, engineDetail: 'raw.engine.detail',
      gpu: { available: true, name: 'raw-gpu', driver: 'raw-driver', memoryMiB: 24576 },
    }))
    const saveRemoteWorker = vi.fn(async () => undefined)
    const { root, bridge } = mount(undefined, {
      info: vi.fn(async () => rawInfo),
      remoteWorkers,
      systemCheck,
      saveRemoteWorker,
    })
    await vi.waitFor(() => expect(root.textContent).toContain('raw-worker'))

    const dialog = root.querySelector<HTMLElement>('.desktop-management')!
    const card = root.querySelector<HTMLElement>('.desktop-worker-card')!
    ;([...card.querySelectorAll('button')].find((button) => button.textContent === 'Edit') as HTMLButtonElement).click()
    const form = root.querySelector<HTMLFormElement>('.desktop-worker-form')!
    const endpoint = form.querySelectorAll<HTMLInputElement>('input')[1]!
    const memory = form.querySelectorAll<HTMLTextAreaElement>('textarea')[1]!
    const save = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
    const remove = [...card.querySelectorAll('button')].find((button) => button.textContent === 'Remove') as HTMLButtonElement
    endpoint.focus()
    remove.click()
    enter(memory, 'invalid-memory')
    form.requestSubmit()
    await vi.waitFor(() => expect(root.querySelector('[role="status"]')?.textContent).toContain("Memory budget 'invalid-memory'"))
    expect(saveRemoteWorker).not.toHaveBeenCalled()
    const infoRequests = vi.mocked(bridge.info).mock.calls.length
    const systemRequests = systemCheck.mock.calls.length
    const workerRequests = remoteWorkers.mock.calls.length

    setLocale('de-DE')
    await flush()

    expect(root.querySelector('.desktop-management')).toBe(dialog)
    expect(root.querySelector('.desktop-worker-card')).toBe(card)
    expect(root.querySelector('.desktop-worker-form')).toBe(form)
    expect(form.querySelectorAll('input')[1]).toBe(endpoint)
    expect(form.querySelector('button[type="submit"]')).toBe(save)
    expect(document.activeElement).toBe(endpoint)
    expect(endpoint.value).toBe('raw.example.test:5151')
    expect(root.textContent).toContain('[DESKTOP HOST]')
    expect(root.textContent).toContain('[VERSION 0.2.0]')
    expect(root.textContent).toContain('[SYSTEM CHECKER]')
    expect(root.textContent).toContain('[REMOTE WORKERS]')
    expect(form.textContent).toContain('[EDIT raw-worker]')
    expect(remove.textContent).toBe('[CONFIRM REMOVE]')
    expect(save.textContent).toBe('[SAVE WORKER]')
    expect(root.querySelector('[role="status"]')?.textContent).toBe('[MEMORY invalid-memory]')
    expect(root.textContent).toContain('raw.engine.detail')
    expect(root.textContent).toContain('raw.update.detail')
    expect(root.textContent).toContain('raw-worker')
    expect(root.textContent).toContain('raw.example.test:5151')
    expect(root.textContent).not.toContain('[TRANSLATED ENGINE DETAIL]')
    expect(root.textContent).not.toContain('[TRANSLATED UPDATE DETAIL]')
    expect(root.textContent).not.toContain('[TRANSLATED WORKER]')
    expect(root.textContent).not.toContain('[TRANSLATED ENDPOINT]')
    expect(vi.mocked(bridge.info)).toHaveBeenCalledTimes(infoRequests)
    expect(systemCheck).toHaveBeenCalledTimes(systemRequests)
    expect(remoteWorkers).toHaveBeenCalledTimes(workerRequests)

    enter(memory, 'raw-device=24G')
    form.requestSubmit()
    await vi.waitFor(() => expect(saveRemoteWorker).toHaveBeenCalledOnce())
    expect(saveRemoteWorker).toHaveBeenCalledWith(worker)
  })
})
