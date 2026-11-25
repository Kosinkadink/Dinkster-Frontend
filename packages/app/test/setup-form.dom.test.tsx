// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import '../src/locale.js'
import { SetupForm } from '../src/SetupForm.js'
import { EditorFirstRunSetup } from '../src/EditorFirstRunSetup.js'
import type { SetupJob, SetupPlan } from '../src/setup-job.js'

const plan: SetupPlan = {
  id: 'plan-1', root: '/install/nightly', channel: 'nightly', variant: 'linux-nvidia',
  buildLabel: 'NVIDIA graphics card build', buildReason: 'Supported graphics card',
  engineRelease: 'release-1', baseId: 'base-1', detectedCards: [], choices: [], gpus: ['0'],
  downloadBytes: null, runtimeDownloadBytes: 2048, freeBytes: 9000, refusal: null,
}
const job: SetupJob = { id: 'job-1', root: plan.root, channel: plan.channel, variant: plan.variant!,
  state: 'running', progress: null, error: null, installation: null }
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === label)!
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers() })

it.each(['projects', 'editor'] as const)('starts the same process-owned job from the %s form and waits for cancellation cleanup', async (surface) => {
  vi.useFakeTimers()
  let current = job
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return answer(current, 202)
    if (init?.method === 'DELETE') { current = { ...job, state: 'cancelling' }; return answer(current, 202) }
    return answer(_url.includes('/job-1') ? current : { plan, activeJob: null })
  })
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <SetupForm surface={surface} />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain('NVIDIA graphics card build')
  expect(document.body.textContent).toContain('At least 2 kB for the runtime')
  button('Set up').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe('{"planId":"plan-1"}')
  expect(document.body.textContent).toContain('Setting up Dinkster')
  button('Cancel').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain('Cancelling and cleaning up')
  expect(button('Cancel').disabled).toBe(true)
  expect([...document.querySelectorAll('button')].some((node) => node.textContent === 'Set up')).toBe(false)
  current = { ...job, state: 'cancelled' }
  await vi.advanceTimersByTimeAsync(750)
  expect(document.body.textContent).toContain('Setup cancelled')
  expect(button('Set up').disabled).toBe(false)
})

it('never presents unknown hardware or downloads as none, and refuses a held library before POST', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => answer({ plan: { ...plan, variant: null, buildLabel: null,
    buildReason: null, detectedCards: null, choices: null, runtimeDownloadBytes: null,
    refusal: { code: 'library-held', message: 'The shared library is held.' } }, activeJob: null }))
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain('Size not available')
  expect(document.body.textContent).toContain('Stop the other installation')
  expect(button('Set up').disabled).toBe(true)
  button('Set up').click()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('delays the first loading sign and keeps it for the minimum before revealing facts', async () => {
  vi.useFakeTimers()
  let resolve!: (response: Response) => void
  vi.stubGlobal('fetch', () => new Promise<Response>((done) => { resolve = done }))
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(199)
  expect(document.body.textContent).toBe('')
  await vi.advanceTimersByTimeAsync(1)
  expect(document.body.textContent).toBe('Checking this computer')
  resolve(answer({ plan, activeJob: null }))
  await vi.advanceTimersByTimeAsync(299)
  expect(document.body.textContent).toBe('Checking this computer')
  await vi.advanceTimersByTimeAsync(1)
  expect(document.body.textContent).toContain('NVIDIA graphics card build')
})

it.each(['unavailable', 'installed', 'remote', 'unknown'] as const)('does not offer local setup for an %s editor backend', async (state) => {
  vi.useFakeTimers()
  const fetch = vi.fn(async (url: string) => answer(url.includes('installations')
    ? state === 'unknown' ? {} : { installations: [{ root: '/existing' }] }
    : { state: 'ready' }, state === 'unavailable' ? 404 : 200))
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <EditorFirstRunSetup backendUrl={state === 'remote' ? 'https://elsewhere.invalid/' : ''} />, document.body)
  await vi.advanceTimersByTimeAsync(1000)
  expect(document.body.textContent).toBe('')
  expect(fetch.mock.calls.some(([url]) => url.startsWith('/supervisor/setup'))).toBe(false)
})

it('offers the editor form only after a confirmed empty supervisor and leaves it after completion', async () => {
  vi.useFakeTimers()
  const completed = { ...job, state: 'completed', installation: { root: job.root, engine: 'main' } }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return answer(completed, 202)
    if (url.startsWith('/supervisor/setup')) return answer({ plan, activeJob: null })
    return answer(url.includes('installations') ? { installations: [] } : { state: 'stopped' })
  }))
  dispose = render(() => <EditorFirstRunSetup backendUrl="" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain('Set up Dinkster on this computer')
  button('Set up').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('[data-testid="setup-form"]')).toBeNull()
})

it('uses the Desktop native picker and reviews the returned folder before starting', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('dinksterDesktop', {
    fileCapabilities: async () => ({ nativeFolderChoice: true }),
    chooseDirectory: async () => '/native/selected folder',
  })
  const fetch = vi.fn(async (url: string) => {
    const root = new URL(url, location.href).searchParams.get('root') ?? plan.root
    return answer({ plan: { ...plan, root, id: root === plan.root ? 'plan-1' : 'plan-2' }, activeJob: null })
  })
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  button('Choose another folder').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('dialog')).toBeNull()
  expect(document.body.textContent).toContain('/native/selected folder')
  expect(fetch.mock.calls.some(([url]) => url.includes('root=%2Fnative%2Fselected+folder'))).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(2)
})
