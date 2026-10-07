import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import { App } from '../src/App.js'
import { AppState } from '../src/app-state.js'

vi.mock('../src/CanvasHost.js', async (original) => ({
  ...await original<typeof import('../src/CanvasHost.js')>(),
  CanvasHost: () => <div data-testid="canvas-stub" />,
}))

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.replaceChildren()
  localStorage.clear()
})

it('does not register disabled P2P or template surfaces and withdraws enabled surfaces', async () => {
  const app = new AppState({ defaultProtocol: 'dinkster' })
  const backend = app.backends.get()[0]!
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <App app={app} />, host)

  const expectDisabled = () => {
    expect(app.panels.get('p2p')).toBeUndefined()
    expect(app.commands.get('workflow.openTemplateGallery')).toBeUndefined()
    expect(app.settings.list().some((setting) => setting.id === 'templates.registryUrl')).toBe(false)
    expect(host.querySelector('[data-testid="p2p-sidebar-toggle"]')).toBeNull()
    expect(host.querySelector('.template-gallery-open')).toBeNull()
    expect(host.querySelector('[data-testid="template-gallery"]')).toBeNull()
  }
  expectDisabled()
  backend.p2pEnabled.set(true)
  backend.templatesEnabled.set(true)
  await vi.waitFor(() => expect(app.panels.get('p2p')).toBeDefined())
  expect(app.commands.get('workflow.openTemplateGallery')).toBeDefined()
  expect(app.settings.list().some((setting) => setting.id === 'templates.registryUrl')).toBe(true)
  backend.p2pEnabled.set(false)
  backend.templatesEnabled.set(false)
  await vi.waitFor(expectDisabled)
})
