import { render } from 'solid-js/web'
import { createSignal } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelProvider, type ModelProviderConnection } from '../src/ModelProvider.js'

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers() })

function fixture() {
  let configured = false
  const connection: ModelProviderConnection = {
    fetchModelProvider: async () => ({ provider: 'huggingface', configured }),
    saveModelProviderToken: async () => { configured = true; return { provider: 'huggingface', configured } },
    forgetModelProvider: async () => { configured = false; return { provider: 'huggingface', configured } },
    startModelProviderSignIn: async () => ({ method: 'device', flowId: 'owned', verificationUri: 'https://huggingface.co/device', userCode: 'TEST-CODE', interval: 5, expiresIn: 60 }),
    pollModelProviderSignIn: async () => ({ status: 'pending', interval: 5 }),
    cancelModelProviderSignIn: async () => ({ status: 'cancelled' }),
  }
  const root = document.createElement('div'); document.body.append(root)
  const button = (label: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((row) => row.textContent === label)!
  return { connection, root, button }
}

it('masks and clears private input, confirms forgetting, and never starts a model job', async () => {
  const { connection, root, button } = fixture()
  let supplied = ''
  const save = connection.saveModelProviderToken
  connection.saveModelProviderToken = async (token) => { supplied = token; return save(token) }
  const dispose = render(() => <ModelProvider connection={connection} backendUrl="https://remote.example" />, root)
  try {
    await vi.waitFor(() => expect(button('Use an access token instead').disabled).toBe(false))
    button('Use an access token instead').click()
    const input = root.querySelector<HTMLInputElement>('#model-provider-token')!
    expect(input.type).toBe('password')
    input.value = 'synthetic-private-canary'; input.dispatchEvent(new Event('input', { bubbles: true }))
    button('Save token').click()
    expect(input.value).toBe('')
    await vi.waitFor(() => expect(root.textContent).toContain('Signed in on this engine.'))
    expect(supplied).toBe('synthetic-private-canary')
    expect(root.innerHTML).not.toContain(supplied)
    button('Forget sign-in').click()
    expect(root.textContent).toContain('Pending model consent is invalidated')
    root.querySelector<HTMLButtonElement>('[data-variant="danger"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Not signed in on this engine.'))
  } finally { dispose() }
})

it('can forget expired credentials without replacing them', async () => {
  const { connection, root, button } = fixture()
  let expired = true
  connection.fetchModelProvider = async () => ({ provider: 'huggingface', configured: false, expired })
  connection.forgetModelProvider = async () => { expired = false; return { provider: 'huggingface', configured: false } }
  const dispose = render(() => <ModelProvider connection={connection} />, root)
  try {
    await vi.waitFor(() => expect(root.textContent).toContain('Sign-in expired.'))
    button('Forget sign-in').click()
    root.querySelector<HTMLButtonElement>('[data-variant="danger"]')!.click()
    await vi.waitFor(() => expect(root.textContent).toContain('Not signed in on this engine.'))
    expect(expired).toBe(false)
  } finally { dispose() }
})

it('uses a device code remotely and cancels its owned flow without acquiring a model', async () => {
  const { connection, root, button } = fixture()
  const start = vi.fn(connection.startModelProviderSignIn)
  const cancel = vi.fn(connection.cancelModelProviderSignIn)
  connection.startModelProviderSignIn = start; connection.cancelModelProviderSignIn = cancel
  const dispose = render(() => <ModelProvider connection={connection} backendUrl="https://remote.example" />, root)
  try {
    await vi.waitFor(() => expect(button('Sign in with Hugging Face').disabled).toBe(false))
    button('Sign in with Hugging Face').click()
    await vi.waitFor(() => expect(root.textContent).toContain('TEST-CODE'))
    expect(start).toHaveBeenCalledWith('device')
    expect(root.querySelector<HTMLAnchorElement>('a')!.href).toBe('https://huggingface.co/device')
    button('Cancel').click()
    await vi.waitFor(() => expect(root.textContent).not.toContain('TEST-CODE'))
    expect(cancel).toHaveBeenCalledWith('owned')
  } finally { dispose() }
})

it('disposes a late flow through its original engine after switching connections', async () => {
  const { connection, root, button } = fixture()
  let finish!: (flow: Awaited<ReturnType<ModelProviderConnection['startModelProviderSignIn']>>) => void
  connection.startModelProviderSignIn = () => new Promise((resolve) => { finish = resolve })
  const cancelled = vi.fn(connection.cancelModelProviderSignIn)
  connection.cancelModelProviderSignIn = cancelled
  const [current, setCurrent] = createSignal(connection)
  const dispose = render(() => <ModelProvider connection={current()} backendUrl="https://remote.example" />, root)
  try {
    await vi.waitFor(() => expect(button('Sign in with Hugging Face').disabled).toBe(false))
    button('Sign in with Hugging Face').click()
    setCurrent(fixture().connection)
    finish({ method: 'device', flowId: 'old-engine', verificationUri: 'https://huggingface.co/device', userCode: 'OLD-CODE', interval: 5, expiresIn: 60 })
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledWith('old-engine'))
    expect(root.textContent).not.toContain('OLD-CODE')
  } finally { dispose() }
})
