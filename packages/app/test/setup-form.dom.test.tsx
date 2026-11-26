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
  engineRelease: 'release-1', baseId: 'base-1', detectedCards: [], choices: [
    { variant: 'linux-nvidia', label: 'NVIDIA graphics', reason: 'Needs NVIDIA driver 580 or newer.' },
    { variant: 'linux-cpu', label: 'CPU only', reason: 'Does not use the graphics card and is much slower.' },
  ], gpus: ['0'],
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
  expect(button('Change build').disabled).toBe(false)
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

it('shows completed setup without changes or a note about setup running', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => answer({ plan, activeJob: { ...job, state: 'completed', installation: { root: plan.root, engine: 'main' } } }))
  dispose = render(() => <SetupForm surface="editor" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain('Dinkster is ready')
  expect(document.body.textContent).not.toContain('You can build a workflow while setup runs.')
  expect([...document.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('Change build')
  expect([...document.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('Choose another folder')
})

it.each(['win-nvidia-cu126', 'linux-cpu', 'unlisted-build'])('labels a running %s job without exposing identifiers and groups matching cards', async (variant) => {
  vi.useFakeTimers()
  const card = { id: '0', name: 'NVIDIA GeForce RTX 4090', driver: '595.84', computeCapability: '8.9', memoryMiB: 24564 }
  const current = { ...plan, detectedCards: [card, { ...card, id: '1', name: 'NVIDIA GeForce RTX 3090' }, { ...card, id: '2' }],
    choices: [...plan.choices!, { variant: 'win-nvidia-cu126', label: 'NVIDIA graphics, older drivers', reason: 'Needs NVIDIA driver 525 or newer.' }] }
  vi.stubGlobal('fetch', async () => answer({ plan: current, activeJob: { ...job, variant } }))
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  const facts = document.querySelector('.setup-facts')!
  expect([...facts.querySelectorAll('p')].map((node) => node.textContent)).toEqual(variant === 'linux-cpu' ? [] : ['2 x NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090'])
  expect(facts.textContent).not.toContain(variant)
  expect(facts.textContent).not.toContain(plan.buildLabel)
  expect(facts.textContent?.includes('NVIDIA graphics, older drivers')).toBe(variant === 'win-nvidia-cu126')
})

it.each([
  ['win-nvidia-cu126', 'NVIDIA graphics, older drivers'],
  ['win-cpu', 'CPU only'],
])('selects %s explicitly without changing the recommended default or adding a facts row', async (variant, label) => {
  vi.useFakeTimers()
  const choices = [
    { variant: 'win-nvidia', label: 'NVIDIA graphics', reason: 'Needs NVIDIA driver 580 or newer.' },
    { variant: 'win-nvidia-cu126', label: 'NVIDIA graphics, older drivers', reason: 'Needs NVIDIA driver 525 or newer.' },
    { variant: 'win-cpu', label: 'CPU only', reason: 'Does not use the graphics card and is much slower.' },
  ]
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return answer({ ...job, variant }, 202)
    const selected = choices.find((choice) => choice.variant === new URL(url, location.href).searchParams.get('variant')) ?? choices[0]!
    return answer({ plan: { ...plan, id: selected.variant, variant: selected.variant, buildLabel: selected.label, choices,
      detectedCards: [{ id: '0', name: 'NVIDIA GeForce RTX 4090', driver: '595.84', computeCapability: '8.9', memoryMiB: 24564 }],
      gpus: selected.variant === 'win-cpu' ? [] : ['0'] }, activeJob: null })
  })
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  button('Change build').click()
  expect([...document.querySelectorAll('[role="menuitemcheckbox"]')].map((node) => [node.getAttribute('aria-label'), node.getAttribute('aria-checked')])).toEqual([
    ['NVIDIA graphics', 'true'], ['NVIDIA graphics, older drivers', 'false'], ['CPU only', 'false'],
  ])
  for (const entry of document.querySelectorAll('[role="menuitemcheckbox"]')) {
    expect(document.getElementById(entry.getAttribute('aria-describedby')!)?.textContent).toBe(choices.find((choice) => choice.label === entry.getAttribute('aria-label'))?.reason)
  }
  expect(document.querySelector('select')).toBeNull()
  expect(document.querySelectorAll('dt').length).toBe(3)
  const alternate = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((node) => node.getAttribute('aria-label') === label)!
  alternate.click()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.at(-1)?.[0]).toContain(`variant=${variant}`)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.querySelector('.setup-facts')?.textContent).toContain(label)
  expect(document.querySelector('.setup-facts')?.textContent?.includes('NVIDIA GeForce RTX 4090')).toBe(variant !== 'win-cpu')
  button('Change build').click()
  expect(document.querySelector('[role="menuitemcheckbox"][aria-checked="true"]')?.getAttribute('aria-label')).toBe(label)
  document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  button('Set up').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe(JSON.stringify({ planId: variant }))
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
  ['downloading', 'bytes', 0, 4096, 'Downloading Dinkster - 0 byte of 4.1 kB'],
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
  expect(document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(unit === 'bytes' && total !== null ? String(completed / total) : null)
})

it('keeps a failed setup error visible without a dismiss action and removes active progress', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', async () => answer({ plan, activeJob: { ...job, state: 'failed', progress: { stage: 'downloading', completed: 200, total: 1000, unit: 'bytes' }, error: { code: 'download-failed', message: 'The download stopped. Try again.' } } }))
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('The download stopped. Try again.')
  expect(document.querySelector('[role="alert"] button')).toBeNull()
  expect(document.querySelector('[role="alert"]')?.nextElementSibling).toBe(document.querySelector('.setup-actions'))
  expect(document.querySelector('[role="progressbar"]')).toBeNull()
  expect(document.querySelector('.setup-job')?.textContent).toBe('Setup could not finish')
  expect(button('Set up').disabled).toBe(false)
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
