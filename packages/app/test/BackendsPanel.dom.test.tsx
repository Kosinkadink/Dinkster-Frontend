// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionStatus } from '@dinkster/client'
import { registerCatalog, setLocale, type Signal } from '@dinkster/core'
import { AppState } from '../src/app-state.js'
import { BackendsPanel } from '../src/BackendsPanel.js'

const disposers: (() => void)[] = []
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
const button = (root: Element, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === text)!

function mount(app = new AppState()) {
  const root = document.createElement('div')
  document.body.append(root)
  disposers.push(render(() => <BackendsPanel app={app} />, root))
  return { app, root }
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  setLocale('en')
  document.body.replaceChildren()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('BackendsPanel', () => {
  it('keeps each server in one disclosure without folders and confirms removal of a non-default server', async () => {
    const { app, root } = mount()
    const label = 'A backend with a deliberately long descriptive name'
    const extra = app.addBackend('http://example.test/a/long/backend/path', label, false, 'dinkster')!
    ;(extra.connection.status as Signal<ConnectionStatus>).set('reconnecting')
    extra.schemaState.set({ status: 'error', message: 'catalog decode refused at node 418' })
    extra.supervisor.set({ protocol: 1, state: 'failed', detail: 'worker exited', engine: { exitCode: 2 } })

    expect(root.querySelectorAll('[data-testid="backend-row"]')).toHaveLength(2)
    const local = root.querySelector('[data-connection="local"]')!
    expect(local.querySelector('[aria-haspopup="menu"]')).toBeNull()
    expect(local.querySelector('[data-testid="connection-profiles"]')).toBeNull()
    const card = root.querySelector(`[data-connection="${extra.id}"]`)!
    expect(card.querySelector('summary')?.textContent).toContain(`Reconnecting - ${label} - Dinkster`)
    expect(card.querySelector('details')?.open).toBe(false)
    expect(card.querySelector('code.backend-address')?.textContent).toBe(extra.baseUrl)
    expect(root.querySelector('[data-testid="model-settings"]')).toBeNull()
    expect(root.querySelector('[data-testid="output-mount-settings"]')).toBeNull()
    expect(button(card, 'Storage')).toBeDefined()
    expect(button(card, 'Resources')).toBeDefined()
    expect(button(card, 'Settings')).toBeDefined()
    expect(root.querySelector('[data-testid="backend-url-input"]')).toBeNull()

    card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click()
    button(card, 'Remove backend').click()
    expect(app.backendFor(extra.id)).toBeDefined()
    button(card, 'Cancel').click()
    expect(app.backendFor(extra.id)).toBeDefined()
    card.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!.click()
    button(card, 'Remove backend').click()
    button(card, 'Remove backend').click()
    await flush()
    expect(app.backendFor(extra.id)).toBeUndefined()
  })

  it('relabels mounted chrome without translating server facts or resetting a pending restart', async () => {
    registerCatalog('de-DE', {
      'backendsPanel.action.restarting': '[RESTARTING]',
      'backendsPanel.action.restart': '[RESTART ENGINE]',
      'backendsPanel.connection.reconnecting': '[RECONNECTING]',
      'backendsPanel.notice.schemaFailed': '[SCHEMA FAILED: {message}]',
      'backendsPanel.title': '[BACKEND CONNECTIONS]',
      'raw.engine.detail': '[TRANSLATED ENGINE DETAIL]',
      'Raw backend label': '[TRANSLATED BACKEND LABEL]',
    })
    const app = new AppState()
    const backend = app.addBackend('http://raw.example.test:9000/path', 'Raw backend label', false, 'dinkster')!
    ;(backend.connection.status as Signal<ConnectionStatus>).set('reconnecting')
    backend.schemaState.set({ status: 'error', message: 'raw.schema.failure' })
    backend.supervisor.set({ protocol: 1, state: 'failed', detail: 'raw.engine.detail', engine: { exitCode: 2 } })
    let finish!: () => void
    vi.spyOn(app, 'restartEngine').mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const { root } = mount(app)
    button(root, 'Add backend').click()
    const input = root.querySelector<HTMLInputElement>('[data-testid="backend-url-input"]')!
    input.value = 'http://entered.example.test:7000/raw'
    input.dispatchEvent(new InputEvent('input', { bubbles: true }))
    input.focus()
    const card = root.querySelector(`[data-connection="${backend.id}"]`)!
    const restart = card.querySelector<HTMLButtonElement>('[data-testid="backend-engine-restart"]')!
    restart.click()
    expect(restart.disabled).toBe(true)
    setLocale('de-DE')
    await flush()
    expect(root.querySelector(`[data-connection="${backend.id}"]`)).toBe(card)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('http://entered.example.test:7000/raw')
    expect(card.textContent).toContain('[RECONNECTING]')
    expect(card.textContent).toContain('[SCHEMA FAILED: raw.schema.failure]')
    expect(card.textContent).toContain('raw.engine.detail')
    expect(card.textContent).toContain('Raw backend label')
    expect(card.textContent).not.toContain('[TRANSLATED ENGINE DETAIL]')
    expect(card.textContent).not.toContain('[TRANSLATED BACKEND LABEL]')
    expect(restart.textContent).toBe('[RESTARTING]')
    finish()
    await flush()
    expect(restart.textContent).toBe('[RESTART ENGINE]')
  })

  it('opens the address form explicitly, reports discovery and refuses duplicate addresses', async () => {
    const { app, root } = mount()
    let finish!: () => void
    const discover = vi.spyOn(app, 'addBackendByUrl').mockImplementation(() => new Promise((resolve) => { finish = () => resolve(undefined) }))
    expect(root.querySelector('[data-testid="backend-url-input"]')).toBeNull()
    button(root, 'Add backend').click()
    const input = root.querySelector<HTMLInputElement>('[data-testid="backend-url-input"]')!
    const enter = (value: string) => { input.value = value; input.dispatchEvent(new InputEvent('input', { bubbles: true })) }
    enter('/')
    input.closest('form')!.requestSubmit()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('already connected')
    expect(discover).not.toHaveBeenCalled()
    enter('http://new.test:9000')
    input.closest('form')!.requestSubmit()
    expect(root.querySelector('[data-testid="backend-add"]')?.getAttribute('aria-disabled')).toBe('true')
    input.closest('form')!.requestSubmit()
    expect(discover).toHaveBeenCalledTimes(1)
    expect(root.textContent).toContain('Discovering...')
    finish()
    await flush()
    expect(root.textContent).toContain('could not be added')
    discover.mockImplementationOnce(async () => app.addBackend('http://new.test:9000', 'New', false, 'dinkster'))
    enter('http://new.test:9000')
    input.closest('form')!.requestSubmit()
    await flush()
    expect(root.querySelector('[data-testid="backend-url-input"]')).toBeNull()
    button(root, 'Add backend').click()
    const next = root.querySelector<HTMLInputElement>('[data-testid="backend-url-input"]')!
    next.value = 'http://new.test:9000/'
    next.dispatchEvent(new InputEvent('input', { bubbles: true }))
    next.closest('form')!.requestSubmit()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('already connected')
    expect(discover).toHaveBeenCalledTimes(2)
  })
})
