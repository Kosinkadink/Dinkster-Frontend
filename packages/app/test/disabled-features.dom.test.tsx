import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { createSignal, type SharedSessionStatus } from '@dinkster/core'
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

it('registers built-in editors at shell mount and withdraws the feature-gated App editor', async () => {
  app = new AppState()
  const host = document.createElement('div')
  document.body.append(host)
  expect(app.editors.kinds()).toEqual([])
  dispose = render(() => <App app={app} />, host)
  const kinds = () => app.editors.kinds().map((editor) => editor.id).sort()
  expect(kinds()).toEqual(['curve', 'glsl', 'graph', 'image'])
  expect(app.editors.get('graph')?.title).toBe('Graph')
  expect(app.editors.get('image')?.title).toBe('Image editor')
  expect(host.querySelector('[data-testid="canvas-stub"]')).not.toBeNull()

  app.settings.set('features.appView.enabled', true)
  await vi.waitFor(() => expect(kinds()).toEqual(['app', 'curve', 'glsl', 'graph', 'image']))
  expect(app.editors.get('app')?.title).toBe('App view')
  expect(app.commands.get('view.toggleAppView')).toBeDefined()
  app.settings.set('features.appView.enabled', false)
  await vi.waitFor(() => expect(kinds()).toEqual(['curve', 'glsl', 'graph', 'image']))
  expect(app.commands.get('view.toggleAppView')).toBeUndefined()

  dispose()
  dispose = undefined
  expect(app.editors.kinds()).toEqual([])
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

  const review = host.querySelector<HTMLButtonElement>('[data-testid="review-upgrades-toggle"]')!
  expect(review.getAttribute('aria-label')).toBe('Review upgrades')
  expect(review.textContent).toBe('Review upgrades')
  expect(review.getAttribute('aria-pressed')).toBe('false')
  expect(review.hasAttribute('title')).toBe(false)
  review.click()
  expect(app.reviewReplacements.get()).toBe(true)
  expect(review.getAttribute('aria-pressed')).toBe('true')
  review.click()
  expect(app.reviewReplacements.get()).toBe(false)
  expect(review.getAttribute('aria-pressed')).toBe('false')

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
