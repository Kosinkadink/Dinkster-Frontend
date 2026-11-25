// @vitest-environment happy-dom

import { render } from 'solid-js/web'
import { afterEach, expect, it, vi } from 'vitest'
import '../src/locale.js'
import { SetupForm } from '../src/SetupForm.js'
import { EditorFirstRunSetup } from '../src/EditorFirstRunSetup.js'
import { processSource } from '../src/projects-page/ProjectsPage.js'
import type { SetupJob, SetupPlan } from '../src/setup-job.js'

const plan: SetupPlan = {
  id: 'plan-1', root: '/install/nightly', channel: 'nightly', variant: 'linux-nvidia',
  buildLabel: 'NVIDIA graphics card build', buildReason: 'Supported graphics card',
  engineRelease: 'release-1', baseId: 'base-1', detectedCards: [], choices: [{ variant: 'linux-nvidia', label: 'NVIDIA', reason: 'Detected card' }], gpus: ['0'],
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
  expect(document.body.textContent).toContain('At least 2 kB - 9 kB free')
  expect(button('Change build')).toBeUndefined()
  expect(document.body.textContent).not.toContain('Supported graphics card')
  button('Set up').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe('{"planId":"plan-1"}')
  expect(document.body.textContent).toContain('Setting up Dinkster')
  expect([...document.querySelectorAll('button')].some((node) => node.textContent === 'Choose another folder')).toBe(false)
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

it.each(['win-nvidia-cu126', 'unlisted-build'])('labels a running %s job without exposing identifiers and groups matching cards', async (variant) => {
  vi.useFakeTimers()
  const card = { id: '0', name: 'NVIDIA GeForce RTX 4090', driver: '595.84', computeCapability: '8.9', memoryMiB: 24564 }
  const current = { ...plan, detectedCards: [card, { ...card, id: '1', name: 'NVIDIA GeForce RTX 3090' }, { ...card, id: '2' }],
    choices: [...plan.choices!, { variant: 'win-nvidia-cu126', label: 'NVIDIA graphics, older drivers', reason: 'Needs NVIDIA driver 525 or newer.' }] }
  vi.stubGlobal('fetch', async () => answer({ plan: current, activeJob: { ...job, variant } }))
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  const facts = document.querySelector('.setup-facts')!
  expect([...facts.querySelectorAll('p')].map((node) => node.textContent)).toEqual(['2 x NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090'])
  expect(facts.textContent).not.toContain(variant)
  expect(facts.textContent).not.toContain(plan.buildLabel)
  expect(facts.textContent?.includes('NVIDIA graphics, older drivers')).toBe(variant === 'win-nvidia-cu126')
})

it('changes builds through a checked menu without adding a facts row', async () => {
  vi.useFakeTimers()
  const choices = [{ variant: 'win-nvidia', label: 'NVIDIA', reason: 'Detected card' }, { variant: 'win-nvidia-cu126', label: 'NVIDIA CUDA 12.6', reason: 'Compatible card' }]
  const fetch = vi.fn(async (_url: string) => answer({ plan: { ...plan, variant: 'win-nvidia', choices }, activeJob: null }))
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  button('Change build').click()
  expect(document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.textContent).toContain('NVIDIA')
  expect(document.querySelector('select')).toBeNull()
  expect(document.querySelectorAll('dt').length).toBe(3)
  const alternate = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((node) => node.textContent?.includes('CUDA 12.6'))!
  alternate.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.at(-1)?.[0]).toContain('variant=win-nvidia-cu126')
  expect(document.querySelector('[role="menu"]')).toBeNull()
})

it.each(['projects', 'editor'] as const)('keeps exact, estimated and minimum downloads distinct on %s', async (surface) => {
  vi.useFakeTimers()
  let current: SetupPlan = { ...plan, downloadEstimate: { kind: 'upper-bound', bytes: 7000000000, reason: 'Includes wheel alternatives' }, freeBytes: 5000000000 }
  vi.stubGlobal('fetch', async () => answer({ plan: current, activeJob: null }))
  dispose = render(() => <SetupForm surface={surface} />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain('About 7 GB - 5 GB free')
  expect(document.querySelector('[role="note"]')?.textContent).toBe('This needs about 7 GB and the disk has 5 GB free.')
  expect(button('Set up').disabled).toBe(false)
  for (const [update, expected] of [
    [{ freeBytes: 7000000000 }, 'About 7 GB - 7 GB free'],
    [{ downloadBytes: 3000000000 }, '3 GB - 7 GB free'],
    [{ downloadBytes: null, downloadEstimate: null }, 'At least 2 kB - 7 GB free'],
  ] as const) {
    current = { ...current, ...update }
    dispose!()
    document.body.replaceChildren()
    dispose = render(() => <SetupForm surface={surface} />, document.body)
    await vi.advanceTimersByTimeAsync(0)
    expect(document.body.textContent).toContain(expected)
    expect(document.querySelector('[role="note"]')).toBeNull()
    expect(button('Set up').disabled).toBe(false)
  }
})

it.each([false, true])('refuses a held library while preserving only known facts (metadata available: %s)', async (known) => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => answer({ plan: { ...plan, ...(known ? {} : { variant: null, buildLabel: null,
    buildReason: null, detectedCards: null, choices: null, runtimeDownloadBytes: null }),
    refusal: { code: 'library-held', message: 'The shared library is held.' } }, activeJob: null }))
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  if (known) {
    expect(document.body.textContent).toContain('NVIDIA graphics card build')
    expect(document.body.textContent).toContain('At least 2 kB - 9 kB free')
    expect(document.querySelectorAll('dt').length).toBe(3)
  } else expect(document.body.textContent).not.toContain('Download')
  expect(document.body.textContent).not.toContain('0 B')
  expect(document.querySelector('[role="note"]')?.textContent).toBe('Another Dinkster installation is running.Stop it, then check again.')
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(button('Set up')).toBeUndefined()
  expect(button('Check again').disabled).toBe(false)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([
  ['downloading', 'bytes', 2048, 4096, 'Downloading Dinkster - 2 kB of 4.1 kB'],
  ['checking-reviewed-inputs', 'items', 3, 12, 'Installing the standard node packs'],
  ['future-stage', 'bytes', 2048, null, 'Setting up - 2 kB'],
] as const)('shows plain progress for %s without raw stages or item counts', async (stage, unit, completed, total, expected) => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => answer({ plan, activeJob: { ...job, progress: { stage, unit, completed, total } } }))
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('[role="status"]')?.textContent).toContain(expected)
  expect(document.body.textContent).not.toContain(stage)
  expect(document.body.textContent).not.toContain('3 of 12')
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
  if (state !== 'installed') expect(fetch.mock.calls.some(([url]) => url.startsWith('/supervisor/setup'))).toBe(false)
})

it.each(['running', 'cancelling'] as const)('rediscovers a %s job after its installation was registered but before completion', async (state) => {
  vi.useFakeTimers()
  const current = { ...job, state }
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith('/supervisor/setup')) return answer({ plan, activeJob: current })
    return answer(url.includes('installations') ? { installations: [{ root: job.root }] } : { state: 'stopped' })
  })
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <EditorFirstRunSetup backendUrl="" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain(state === 'running' ? 'Setting up Dinkster' : 'Cancelling and cleaning up')
  expect(button('Cancel').disabled).toBe(state === 'cancelling')
  const installations = await processSource().installations()
  expect(installations.all.map((row) => row.root)).toEqual([job.root])
  expect(installations.settingUp).toBe(true)
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
