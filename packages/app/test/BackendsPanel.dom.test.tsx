// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionStatus } from '@dinkster/client'
import { registerCatalog, setLocale, type Signal } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { BackendsPanel } from '../src/BackendsPanel.js'

const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

function mount(app = new AppState({ defaultProtocol: 'dinkster' })) {
  const root = document.createElement('div')
  document.body.append(root)
  const unmount = render(() => <BackendsPanel app={app} />, root)
  return { app, root, unmount }
}

afterEach(() => {
  setLocale('en')
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('BackendsPanel', () => {
  it('shows agent permissions for a Dinkster backend that exposes principals', async () => {
    const app = new AppState({ defaultProtocol: 'dinkster' })
    const backend = app.backends.get()[0]!
    if (backend.protocol !== 'dinkster') throw new Error('expected a Dinkster backend')
    vi.spyOn(backend.connection, 'fetchPrincipals').mockResolvedValue([
      { principalId: 'agent-one', kind: 'agent', categories: { edit: true } },
    ])
    const { root } = mount(app)
    await flush()

    expect(root.querySelector('[data-testid="agent-permissions"]')?.textContent).toContain('agent-one')
  })

  it('presents isolated backend identity, default ownership, long content, and backend-specific actions', async () => {
    const { app, root } = mount()
    const label = 'A backend with a deliberately very long name that must wrap without covering its actions'
    const extra = app.addBackend('http://example.test/a/very/long/backend/path/that/must/wrap', label, false, 'dinkster')!
    extra.schemaState.set({ status: 'error', message: 'catalog decode refused at node 418' })
    extra.supervisor.set({ protocol: 1, state: 'failed', detail: 'worker exited', engine: { exitCode: 2 } })

    expect(root.querySelectorAll('[data-testid="backend-row"]')).toHaveLength(2)
    expect(root.querySelector('[data-connection="local"]')?.textContent).toContain('Default')
    expect(root.querySelector('[data-connection="local"] [data-testid="backend-remove"]')).toBeNull()
    const card = root.querySelector(`[data-connection="${extra.id}"]`)!
    expect(card.textContent).toContain(label)
    expect(card.textContent).toContain('catalog decode refused at node 418')
    expect(card.querySelector('[aria-label="Restart A backend with a deliberately very long name that must wrap without covering its actions engine"]')).not.toBeNull()
    expect(card.querySelector('[aria-label="Retry schemas for A backend with a deliberately very long name that must wrap without covering its actions"]')).not.toBeNull()
    expect(card.querySelector('[aria-label="Remove A backend with a deliberately very long name that must wrap without covering its actions"]')).not.toBeNull()
    expect(card.querySelector('[aria-label$="runtime settings"]')).not.toBeNull()
    expect(root.querySelector('[data-connection="local"]')?.textContent).toContain('Not loaded')

    card.querySelector<HTMLButtonElement>('[data-testid="backend-remove"]')!.click()
    await flush()
    expect(app.backendFor(extra.id)).toBeUndefined()
  })

  it('renders reconnect and server-authoritative composition progress', () => {
    const { app, root } = mount()
    const backend = app.backends.get()[0]!
    ;(backend.connection.status as Signal<ConnectionStatus>).set('reconnecting')
    backend.supervisor.set({ protocol: 1, state: 'ready', detail: 'engine healthy', progress: { done: 3, total: 8, phase: 'Loading packs' } })

    expect(root.textContent).toContain('reconnecting automatically')
    const progress = root.querySelector<HTMLProgressElement>('[aria-label="Local composition progress"]')!
    expect(progress.value).toBe(3)
    expect(progress.max).toBe(8)
    expect(root.textContent).toContain('Composing')
    expect(root.textContent).toContain('Loading packs')
    expect(root.textContent).toContain('3 of 8')
  })

  it('reacts when a schema request state changes', async () => {
    const { app, root } = mount()
    app.backends.get()[0]!.schemaState.set({ status: 'error', message: 'schema request refused' })
    await flush()

    expect(root.textContent).toContain('Schema request failed: schema request refused')
  })

  it('relabels mounted chrome without translating backend facts or resetting in-flight actions', async () => {
    registerCatalog('de-DE', {
      'backendsPanel.action.restarting': '[RESTARTING]',
      'backendsPanel.action.restart': '[RESTART ENGINE]',
      'backendsPanel.action.retrying': '[RETRYING]',
      'backendsPanel.action.retrySchemas': '[RETRY SCHEMAS]',
      'backendsPanel.connection.reconnecting': '[RECONNECTING]',
      'backendsPanel.notice.schemaFailed': '[SCHEMA FAILED: {message}]',
      'backendsPanel.title': '[BACKEND CONNECTIONS]',
      'http://raw.example.test:9000/path': '[TRANSLATED URL]',
      'raw.engine.detail': '[TRANSLATED ENGINE DETAIL]',
      'raw.schema.failure': '[TRANSLATED SCHEMA FAILURE]',
      'Raw backend label': '[TRANSLATED BACKEND LABEL]',
    })
    const app = new AppState({ defaultProtocol: 'dinkster' })
    const backend = app.addBackend('http://raw.example.test:9000/path', 'Raw backend label', false, 'dinkster')!
    ;(backend.connection.status as Signal<ConnectionStatus>).set('reconnecting')
    backend.schemaState.set({ status: 'error', message: 'raw.schema.failure' })
    backend.supervisor.set({ protocol: 1, state: 'failed', detail: 'raw.engine.detail', engine: { exitCode: 2 } })
    let finishRetry!: () => void
    let finishRestart!: () => void
    const retry = vi.spyOn(app, 'refreshBackendSchemas').mockImplementation(() => new Promise((resolve) => { finishRetry = resolve }))
    const restart = vi.spyOn(app, 'restartEngine').mockImplementation(() => new Promise((resolve) => { finishRestart = resolve }))
    const add = vi.spyOn(app, 'addBackendByUrl')
    const { root } = mount(app)
    const panel = root.querySelector<HTMLElement>('[data-testid="backends-panel"]')!
    const card = root.querySelector<HTMLElement>(`[data-connection="${backend.id}"]`)!
    const input = root.querySelector<HTMLInputElement>('[data-testid="backend-url-input"]')!
    const retryButton = card.querySelector<HTMLButtonElement>('[data-testid="backend-schema-retry"]')!
    const restartButton = card.querySelector<HTMLButtonElement>('[data-testid="backend-engine-restart"]')!
    input.value = 'http://entered.example.test:7000/raw'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.focus()
    retryButton.click()
    restartButton.click()
    expect(retryButton.disabled).toBe(true)
    expect(restartButton.disabled).toBe(true)

    setLocale('de-DE')
    await flush()

    expect(root.querySelector('[data-testid="backends-panel"]')).toBe(panel)
    expect(root.querySelector(`[data-connection="${backend.id}"]`)).toBe(card)
    expect(card.querySelector('[data-testid="backend-schema-retry"]')).toBe(retryButton)
    expect(card.querySelector('[data-testid="backend-engine-restart"]')).toBe(restartButton)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('http://entered.example.test:7000/raw')
    expect(panel.getAttribute('aria-label')).toBe('[BACKEND CONNECTIONS]')
    expect(panel.querySelector('h2')?.textContent).toBe('[BACKEND CONNECTIONS]')
    expect(card.textContent).toContain('[RECONNECTING]')
    expect(card.textContent).toContain('[SCHEMA FAILED: raw.schema.failure]')
    expect(card.textContent).toContain('raw.engine.detail')
    expect(card.textContent).toContain('Raw backend label')
    expect(card.textContent).toContain('http://raw.example.test:9000/path')
    expect(card.textContent).not.toContain('[TRANSLATED ENGINE DETAIL]')
    expect(card.textContent).not.toContain('[TRANSLATED SCHEMA FAILURE]')
    expect(card.textContent).not.toContain('[TRANSLATED BACKEND LABEL]')
    expect(card.textContent).not.toContain('[TRANSLATED URL]')
    expect(retryButton.textContent).toBe('[RETRYING]')
    expect(restartButton.textContent).toBe('[RESTARTING]')
    expect(retry).toHaveBeenCalledTimes(1)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(add).not.toHaveBeenCalled()

    finishRetry()
    finishRestart()
    await flush()
    expect(retryButton.textContent).toBe('[RETRY SCHEMAS]')
    expect(restartButton.textContent).toBe('[RESTART ENGINE]')
    card.querySelector<HTMLButtonElement>('[data-testid="backend-remove"]')!.click()
    expect(app.backendFor(backend.id)).toBeUndefined()
  })

  it('shows discovery while pending and refuses a duplicate before probing', async () => {
    const { app, root } = mount()
    let finish!: () => void
    const discover = vi.spyOn(app, 'addBackendByUrl').mockImplementation(() => new Promise((resolve) => {
      finish = () => resolve(undefined)
    }))
    const input = root.querySelector<HTMLInputElement>('[data-testid="backend-url-input"]')!
    input.value = '/'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('.backend-add-surface form')!.requestSubmit()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('That backend is already connected.')
    expect(discover).not.toHaveBeenCalled()

    input.value = 'http://new.test:9000'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('.backend-add-surface form')!.requestSubmit()
    expect(root.textContent).toContain('Discovering http://new.test:9000')
    expect(root.querySelector<HTMLButtonElement>('[data-testid="backend-add"]')!.disabled).toBe(true)
    finish()
    await flush()
    expect(root.textContent).toContain('could not be added')

    input.value = 'http://new.test:9000'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    discover.mockImplementationOnce(async () => app.addBackend('http://new.test:9000', 'New', false, 'dinkster'))
    root.querySelector<HTMLFormElement>('.backend-add-surface form')!.requestSubmit()
    await flush()
    input.value = 'http://new.test:9000/'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    root.querySelector<HTMLFormElement>('.backend-add-surface form')!.requestSubmit()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('That backend is already connected.')
    expect(discover).toHaveBeenCalledTimes(2)
  })
})
