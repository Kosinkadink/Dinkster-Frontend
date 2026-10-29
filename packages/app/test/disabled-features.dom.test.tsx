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
  app = new AppState({ defaultProtocol: 'dinkster' })
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
  expect(review.getAttribute('data-tooltip-label')).toBe('When on, deprecated nodes are never upgraded automatically on open - review each via its badge (debug aid).')
  expect(review.getAttribute('aria-pressed')).toBe('false')
  expect(review.hasAttribute('title')).toBe(false)
  review.click()
  expect(app.reviewReplacements.get()).toBe(true)
  expect(review.getAttribute('aria-pressed')).toBe('true')

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
