import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { createSignal, type SharedSessionStatus, type Signal } from '@dinkster/core'
import type { ConnectionStatus, DocsPage } from '@dinkster/client'
import { App } from '../src/App.js'
import { AppState, type CollabTabState } from '../src/app-state.js'

vi.mock('../src/CanvasHost.js', async (original) => ({
  ...await original<typeof import('../src/CanvasHost.js')>(),
  CanvasHost: () => <div data-testid="canvas-stub" />,
}))

let dispose: (() => void) | undefined
let app: AppState
afterEach(() => {
  dispose?.()
  dispose = undefined
  app.dispose()
  delete window.dinksterDesktop
  document.body.replaceChildren()
  localStorage.clear()
  delete window.dinksterDesktop
  vi.restoreAllMocks()
})

it('replaces Assets backend ownership and rejects pending old file locations when the tab target changes', async () => {
  app = new AppState()
  const old = app.backends.get()[0]!
  const next = app.addBackend('http://next.test:9000', 'Next workstation', false, 'dinkster')!
  if (old.protocol !== 'dinkster' || next.protocol !== 'dinkster') throw new Error('native backends required')
  const ref = (letter: string, name: string) => ({
    digest: `blake3:${letter.repeat(64)}`, name, size: 7,
    mediaType: 'application/octet-stream', virtualPath: `mounts/output/${name}`,
  })
  const first = ref('a', 'old.bin')
  const delayed = ref('b', 'delayed.bin')
  const current = ref('c', 'current.bin')
  let resolveOld!: (paths: string[]) => void
  const pending = new Promise<string[]>((resolve) => { resolveOld = resolve })
  for (const [backend, assets] of [[old, [first, delayed]], [next, [current]]] as const) {
    vi.spyOn(backend.connection, 'listMounts').mockResolvedValue([])
    vi.spyOn(backend.connection, 'listLocalAssets').mockResolvedValue({ assets: assets.map((asset) => ({ asset, aliases: [asset.name], observations: [] })) })
    vi.spyOn(backend.connection, 'checkAssetAvailability').mockResolvedValue(assets.map(({ digest }) => ({ digest, status: 'available' as const })))
  }
  vi.spyOn(old.connection, 'fetchAssetLocations').mockImplementation((digest) => digest === delayed.digest ? pending : Promise.resolve(['/old/output/old.bin']))
  vi.spyOn(next.connection, 'fetchAssetLocations').mockResolvedValue(['/next/output/current.bin'])
  const revealFile = vi.fn().mockResolvedValue(undefined)
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
  const host = document.createElement('div')
  document.body.append(host)
  window.dinksterDesktop = {
    fileCapabilities: async () => ({ nativeFolderChoice: false, reveal: true }),
    chooseDirectory: async () => undefined,
    resolveDroppedFile: async () => ({ status: 'refused', reason: 'not-resolvable' }),
    revealFile,
  }
  dispose = render(() => <App app={app} />, host)
  expect(host.querySelector('[data-testid="desktop-management-button"]')).toBeNull()
  host.querySelector<HTMLButtonElement>('[data-testid="assets-toggle"]')!.click()
  const select = (name: string) => [...host.querySelectorAll<HTMLElement>('[data-testid="collection-entry"]')].find((row) => row.textContent?.includes(name))!
  await vi.waitFor(() => expect(select(first.name)).toBeDefined())
  select(first.name).click()
  await vi.waitFor(() => expect(host.querySelector('[data-testid="asset-file-location"]')?.textContent).toContain('/old/output/old.bin'))
  select(delayed.name).click()
  await vi.waitFor(() => expect(old.connection.fetchAssetLocations).toHaveBeenCalledWith(delayed.digest))

  app.setTabTarget(app.activeTab()!.id, next.id)

  await vi.waitFor(() => expect(select(current.name)).toBeDefined())
  expect(select(first.name)).toBeUndefined()
  expect(host.querySelector('[data-testid="asset-file-location"]')).toBeNull()
  select(current.name).click()
  await vi.waitFor(() => expect(host.querySelector('[data-testid="asset-file-location"]')?.textContent).toContain('/next/output/current.bin'))
  resolveOld(['/old/output/delayed.bin'])
  await pending
  await Promise.resolve()
  const locations = host.querySelector('[data-testid="asset-file-location"]')!
  expect(locations.textContent).toContain('Next workstation')
  expect(locations.textContent).not.toContain('/old/')
  ;[...locations.querySelectorAll('button')].find((button) => button.textContent === 'Copy server path')!.click()
  await vi.waitFor(() => expect(copy).toHaveBeenCalledWith('/next/output/current.bin'))
  ;[...locations.querySelectorAll('button')].find((button) => button.textContent === 'Show file on this computer')!.click()
  await vi.waitFor(() => expect(revealFile).toHaveBeenCalledWith('http://next.test:9000/', { digest: current.digest, scope: 'local', project: 'default' }))
  expect(revealFile).toHaveBeenCalledTimes(1)
})

it('opens Resources for the status backend before mount and on repeated backend jumps', async () => {
  app = new AppState()
  const local = app.backends.get()[0]!
  const remote = app.addBackend('http://resources-focus.test', 'Remote workstation', false, 'dinkster')!
  for (const backend of [local, remote]) {
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue({ connection: backend.id, hash: 'focus-test', schemas: new Map(), diagnostics: [], resolve: () => undefined })
    vi.spyOn(backend.connection, 'fetchModelDownloads').mockResolvedValue({ instance: 'focus-test', jobs: [] })
    vi.spyOn(backend.connection, 'fetchMountSettings').mockRejectedValue(new Error('Unavailable in fixture'))
    vi.spyOn(backend.connection, 'fetchMemoryStatus').mockResolvedValue({
      devices: {}, queue: { queued: 0, running: [], maxRunningJobs: 1, paused: false }, leases: [],
      memoryGovernor: { 'vram:cuda:0': { budgetBytes: null, reservedBytes: 0, consumerFootprintBytes: 0, availableBytes: null, consumers: {}, measured: { totalBytes: 12e9, freeBytes: 5e9 } } },
    })
    ;(backend.connection.status as Signal<ConnectionStatus>).set('connected')
  }
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <App app={app} />, host)
  const jump = () => host.querySelector<HTMLButtonElement>('[data-testid="status-memory"]')!
  await vi.waitFor(() => expect(jump()).not.toBeNull())
  expect(host.querySelector('[data-testid="resources-panel"]')).toBeNull()
  jump().click()
  const toggle = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="resources-panel"] [data-backend="${id}"] > .dinkster-resource-backend-toggle button`)!
  await vi.waitFor(() => expect(toggle(local.id)?.getAttribute('aria-expanded')).toBe('true'))
  toggle(local.id).click()
  expect(toggle(local.id).getAttribute('aria-expanded')).toBe('false')
  app.setTabTarget(app.activeTab()!.id, remote.id)
  await vi.waitFor(() => expect(jump()?.getAttribute('aria-label')).toContain('Resources'))
  jump().click()
  await vi.waitFor(() => expect(toggle(remote.id).getAttribute('aria-expanded')).toBe('true'))
  expect(toggle(local.id).getAttribute('aria-expanded')).toBe('false')
  toggle(remote.id).click()
  expect(toggle(remote.id).getAttribute('aria-expanded')).toBe('false')
  jump().click()
  await vi.waitFor(() => expect(toggle(remote.id).getAttribute('aria-expanded')).toBe('true'))
  expect(toggle(local.id).getAttribute('aria-expanded')).toBe('false')
})

it('does not expose obsolete environment management when an older Desktop host supplies it', () => {
  app = new AppState()
  const host = document.createElement('div')
  document.body.append(host)
  const bridge = {
    locale: async () => 'en',
    status: async () => ({ phase: 'running' as const, detail: 'Ready' }),
    info: vi.fn(),
    exportSnapshot: vi.fn(),
    importSnapshot: vi.fn(),
    takeDeepLinks: async () => [],
    onWindowLayout: () => () => undefined,
    onDeepLinkPending: () => () => undefined,
  }
  window.dinksterDesktop = bridge as unknown as NonNullable<Window['dinksterDesktop']>
  dispose = render(() => <App app={app} />, host)

  expect(host.querySelector('[data-testid="desktop-management-button"]')).toBeNull()
  app.modalPanel.set('desktop-management')
  expect(host.querySelector('[data-modal="desktop-management"]')).toBeNull()
})

it('does not register disabled template surfaces and withdraws enabled surfaces', async () => {
  app = new AppState()
  const backend = app.backends.get()[0]!
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <App app={app} />, host)

  const expectDisabled = () => {
    expect(app.commands.get('workflow.openTemplateGallery')).toBeUndefined()
    expect(app.settings.list().some((setting) => setting.id === 'templates.registryUrl')).toBe(false)
    expect(host.querySelector('.template-gallery-open')).toBeNull()
    expect(host.querySelector('[data-testid="template-gallery"]')).toBeNull()
  }
  expectDisabled()
  backend.templatesEnabled.set(true)
  expect(app.commands.get('workflow.openTemplateGallery')).toBeDefined()
  expect(app.settings.list().some((setting) => setting.id === 'templates.registryUrl')).toBe(true)
  backend.templatesEnabled.set(false)
  await vi.waitFor(expectDisabled)
})

it('shows Learn for any connected guide catalog and rejects stale availability', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{"mounts":[]}', {
    headers: { 'Content-Type': 'application/json' },
  }))
  app = new AppState()
  const active = app.backends.get()[0]!
  const guides = app.addBackend('http://guides.test:9000', 'Guide server', false)!
  const guide = {
    kind: 'guide' as const, pack: 'guide-pack', id: 'first-guide', defaultLocale: 'en',
    locales: { en: { title: 'First guide', summary: 'Read this guide.', digest: `sha256:${'a'.repeat(64)}`, assets: {} } },
  }
  for (const backend of [active, guides]) {
    vi.spyOn(backend.connection, 'fetchSchemas').mockResolvedValue({
      connection: backend.id, hash: 'empty', schemas: new Map(), diagnostics: [], resolve: () => undefined,
    })
    vi.spyOn(backend.connection, 'listDocs').mockResolvedValue({ docs: [] })
  }
  const status = guides.connection.status as Signal<ConnectionStatus>
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <App app={app} />, host)
  const toggle = () => host.querySelector<HTMLButtonElement>('[data-testid="learn-toggle"]')
  expect(toggle()).toBeNull()
  status.set('connected')
  await vi.waitFor(() => expect(guides.schemaState.get().status).toBe('ready'))
  expect(toggle()).toBeNull()
  vi.mocked(guides.connection.listDocs).mockResolvedValue({ docs: [guide] })
  guides.refreshDiagnostics()
  await vi.waitFor(() => expect(toggle()).not.toBeNull())
  expect(app.backendForTab(app.activeTab()!)).toBe(active)

  let resolveOld!: (page: DocsPage) => void
  vi.mocked(guides.connection.listDocs).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
  guides.refreshDiagnostics()
  vi.mocked(guides.connection.listDocs).mockResolvedValue({ docs: [] })
  guides.refreshDiagnostics()
  await vi.waitFor(() => expect(toggle()).toBeNull())
  resolveOld({ docs: [guide] })
  await Promise.resolve()
  expect(toggle()).toBeNull()

  vi.mocked(guides.connection.listDocs).mockResolvedValue({ docs: [guide] })
  guides.refreshDiagnostics()
  await vi.waitFor(() => expect(toggle()).not.toBeNull())
  guides.refreshDiagnostics()
  status.set('disconnected')
  await Promise.resolve()
  expect(toggle()).toBeNull()
  expect(guides.guidesAvailable.get()).toBe(false)
})

it('renders backend targeting, review state and live shared-session tooltip hints', async () => {
  app = new AppState()
  const remote = app.addBackend('http://rendered.test:9000', 'Rendered backend', false, 'dinkster')!
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <App app={app} />, host)
  const target = host.querySelector<HTMLButtonElement>('[data-testid="tab-target"]')!
  expect(target.tagName).toBe('BUTTON')
  expect(target.getAttribute('role')).toBe('combobox')
  expect(target.getAttribute('aria-label')).toBe('Backend this tab queues to')
  expect(target.getAttribute('data-tooltip-label')).toBe('Backend this tab queues to')
  expect(target.hasAttribute('title')).toBe(false)
  target.click()
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === 'Rendered backend')!
  expect(option).toBeDefined()
  option.click()
  expect(app.tabTargets.get().get(app.activeTab()!.id)).toBe(remote.id)

  expect(host.querySelector('[data-testid="review-upgrades-toggle"]')).toBeNull()
  app.settingsOpenRequest.set({ category: 'execution', id: 'execution.reviewUpgrades' })
  app.modalPanel.set('settings')
  const review = host.querySelector<HTMLButtonElement>('#setting-execution\\.reviewUpgrades')!
  expect(review).not.toBeNull()
  expect(review.getAttribute('aria-checked')).toBe('false')
  review.click()
  expect(app.settings.get('execution.reviewUpgrades')).toBe(true)
  expect(review.getAttribute('aria-checked')).toBe('true')
  review.click()
  expect(app.settings.get('execution.reviewUpgrades')).toBe(false)
  app.modalPanel.set('')

  const backends = host.querySelector<HTMLButtonElement>('[data-testid="backends-sidebar-toggle"]')!
  expect(backends.getAttribute('aria-pressed')).toBe('false')
  expect(backends.getAttribute('data-tooltip-label')).toBe('Manage backend connections')
  backends.click()
  expect(backends.getAttribute('aria-pressed')).toBe('true')
  expect(backends.hasAttribute('data-tooltip-label')).toBe(false)
  backends.click()
  expect(backends.getAttribute('data-tooltip-label')).toBe('Manage backend connections')

  const status = createSignal<SharedSessionStatus>('live')
  app.collabTabs.set(new Map([[app.activeTab()!.id, { session: { status } } as unknown as CollabTabState]]))
  try {
    await vi.waitFor(() => expect(host.querySelector('[data-testid="tab-collab"]')?.getAttribute('data-tooltip-label')).toBe('Shared session (live)'))
    status.set('catching-up')
    const shared = host.querySelector<HTMLElement>('[data-testid="tab-collab"]')!
    expect(shared.getAttribute('aria-label')).toBe('Shared session (catching-up)')
    expect(shared.getAttribute('data-tooltip-label')).toBe('Shared session (catching-up)')
    expect(shared.tabIndex).toBe(0)
    expect(shared.hasAttribute('title')).toBe(false)
  } finally {
    app.collabTabs.set(new Map())
  }
})
