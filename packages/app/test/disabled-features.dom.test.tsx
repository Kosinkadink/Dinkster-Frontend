import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/App.js'
import { AppState } from '../src/app-state.js'

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
  app = new AppState({ defaultProtocol: 'dinkster' })
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
  app = new AppState({ defaultProtocol: 'dinkster' })
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
