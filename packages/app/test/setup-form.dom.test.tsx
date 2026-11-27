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
  engineRelease: 'release-1', baseId: 'base-1', detectedCards: [], graphicsVendor: 'nvidia', choices: [
    { variant: 'linux-nvidia', vendor: 'nvidia', gpus: ['0'], label: 'NVIDIA graphics', reason: 'Needs NVIDIA driver 580 or newer.' },
    { variant: 'linux-cpu', vendor: null, gpus: [], label: 'CPU only', reason: 'Does not use the graphics card and is much slower.' },
  ], gpus: ['0'],
  downloadBytes: null, runtimeDownloadBytes: 2048, freeBytes: 9000, refusal: null,
}
const job: SetupJob = { id: 'job-1', root: plan.root, channel: plan.channel, variant: plan.variant!,
  state: 'running', progress: null, error: null, installation: null }
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === label)!
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers() })

it.each(['projects', 'editor'] as const)('requires an explicit CPU choice for repairable graphics and redetects repaired cards on %s', async (surface) => {
  vi.useFakeTimers()
  const unusable: SetupPlan['unusableCards'] = [
    { id: '0', name: 'NVIDIA Quadro P400', vendor: 'nvidia', reason: 'driver-too-old', minimumDriver: '580', driver: '535.12' },
    { id: '1', name: 'NVIDIA Quadro P400', vendor: 'nvidia', reason: 'driver-too-old', minimumDriver: '580', driver: '535.12' },
    { id: '0', name: 'Intel Arc A770', vendor: 'intel', reason: 'detection-tool-missing', tool: 'xpu-smi' },
    { id: '0', name: null, vendor: 'amd', reason: 'detection-tool-failed', tool: 'amd-smi' },
    { id: '3', name: 'NVIDIA Quadro P600', vendor: 'nvidia', reason: 'driver-too-old', minimumDriver: '580', driver: null },
  ]
  const cpu = { variant: 'linux-cpu', vendor: null, gpus: [], label: 'CPU only', reason: 'Does not use the graphics card and is much slower.' }
  const repairable: SetupPlan = { ...plan, variant: null, graphicsVendor: null, buildLabel: null, gpus: [], choices: [cpu],
    unusableCards: unusable, system: 'linux', runtimeDownloadBytes: null }
  let repaired = false
  let selectedPlan: SetupPlan = repairable
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return answer({ ...job, variant: selectedPlan.variant! }, 202)
    const variant = new URL(url, location.href).searchParams.get('variant')
    selectedPlan = variant === cpu.variant ? { ...repairable, id: 'explicit-cpu', variant: cpu.variant, buildLabel: cpu.label }
      : repaired ? { ...plan, id: 'repaired', graphicsVendor: 'nvidia', system: 'linux',
        detectedCards: [
          { id: '0', vendor: 'nvidia', name: 'NVIDIA Quadro P400', driver: '580.95', computeCapability: '6.1', memoryMiB: 2048 },
          { id: '1', vendor: 'nvidia', name: 'NVIDIA Quadro P400', driver: '580.95', computeCapability: '6.1', memoryMiB: 2048 },
          { id: '0', vendor: 'intel', name: 'Intel Arc A770', driver: null, computeCapability: null, memoryMiB: null },
        ],
        choices: [{ ...plan.choices![0]!, vendor: 'nvidia', gpus: ['0', '1'] }, cpu], gpus: ['0', '1'],
        unusableCards: [unusable[2]!, unusable[3]!, unusable[4]!,
          { id: '4', name: 'NVIDIA GeForce GTX 580', vendor: 'nvidia', reason: 'card-too-old' },
          { id: '2', name: 'Built-in graphics', vendor: 'amd', reason: 'no-published-build' }] }
      : repairable
    return answer({ plan: selectedPlan, activeJob: null })
  })
  vi.stubGlobal('fetch', fetch)
  dispose = render(() => <SetupForm surface={surface} />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('.setup-facts')?.textContent).toContain('Not chosen')
  expect(button('Change build')).toBeUndefined()
  expect(button('Set up')).toBeUndefined()
  const notice = document.querySelector('[role="note"]')!
  expect(notice.textContent).toBe([
    'Update or repair the graphics driver, then check again. Or use CPU only, which is much slower.',
    '2 x NVIDIA Quadro P400: needs NVIDIA driver 580 or newer, has 535.12.',
    'Intel Arc A770: xpu-smi is missing, so its driver cannot be checked.',
    'AMD graphics card: amd-smi failed, so its driver cannot be checked.',
    'NVIDIA Quadro P600: needs NVIDIA driver 580 or newer.',
  ].join(''))
  expect(document.querySelectorAll('[role="note"]')).toHaveLength(1)
  expect(notice.previousElementSibling).toBe(document.querySelector('.setup-facts'))
  expect(notice.nextElementSibling).toBe(document.querySelector('.setup-actions'))
  button('Use CPU only').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('.setup-facts')?.textContent).toContain('CPU only')
  expect(document.querySelector('[role="note"]')?.textContent).toContain('Dinkster will run on the CPU, which is much slower. Update or repair the graphics driver and check again to use the card.')
  expect(button('Use CPU only')).toBeUndefined()
  expect(button('Set up').disabled).toBe(false)
  repaired = true
  button('Check again').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('.setup-facts')?.textContent).toContain('NVIDIA graphics card build')
  expect(document.querySelector('[role="note"]')).toBeNull()
  expect([...document.querySelectorAll('.setup-facts p')].map((node) => node.textContent)).toEqual([
    '2 x NVIDIA Quadro P400', 'Not used: Intel Arc A770. Its driver could not be checked.',
    'Not used: AMD graphics card. Its driver could not be checked.',
    'Not used: NVIDIA Quadro P600. Needs NVIDIA driver 580 or newer.',
    'Not used: NVIDIA GeForce GTX 580. Too old for this build.',
  ])
  expect(document.body.textContent).not.toContain('Built-in graphics')
  button('Set up').click()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetch.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body).toBe('{"planId":"repaired"}')
})

it('keeps CPU selected for unfixable cards and explains grouped cards with unknown names', async () => {
  vi.useFakeTimers()
  const current: SetupPlan = { ...plan, variant: 'linux-cpu', graphicsVendor: null, buildLabel: 'CPU only', gpus: [], system: 'linux',
    choices: [plan.choices![1]!], unusableCards: [
      { id: '0', name: 'NVIDIA GeForce GTX 580', vendor: 'nvidia', reason: 'card-too-old' },
      { id: '0', name: null, vendor: 'intel', reason: 'no-published-build' },
      { id: '1', name: null, vendor: 'intel', reason: 'no-published-build' },
      { id: '2', name: null, vendor: null, reason: 'no-published-build' },
    ] }
  vi.stubGlobal('fetch', async () => answer({ plan: current, activeJob: null }))
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.querySelector('[role="note"]')?.textContent).toBe([
    'Dinkster will run on the CPU, which is much slower.',
    'NVIDIA GeForce GTX 580: too old for any build.',
    '2 x Intel graphics card: no build for Intel graphics on Linux yet.',
    'Graphics card: no build for it on Linux yet.',
  ].join(''))
  expect(button('Check again')).toBeUndefined()
  expect(button('Use CPU only')).toBeUndefined()
  expect(button('Set up').disabled).toBe(false)
})

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
  expect(document.body.textContent).toContain('At least 2 KB - 8.8 KB free')
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

it.each([false, true])('shows completed setup without changes or a note about setup running (CPU warning: %s)', async (cpuWarning) => {
  vi.useFakeTimers()
  const current: SetupPlan = cpuWarning ? { ...plan, variant: null, graphicsVendor: null, buildLabel: null, gpus: [],
    unusableCards: [{ id: '0', name: 'NVIDIA Quadro P400', vendor: 'nvidia', reason: 'driver-too-old', minimumDriver: '580', driver: '535.12' }] } : plan
  vi.stubGlobal('fetch', async () => answer({ plan: current, activeJob: { ...job, variant: cpuWarning ? 'linux-cpu' : job.variant,
    state: 'completed', installation: { root: plan.root, engine: 'main' } } }))
  dispose = render(() => <SetupForm surface="editor" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  expect(document.body.textContent).toContain('Dinkster is ready')
  expect(document.body.textContent).not.toContain('You can build a workflow while setup runs.')
  expect([...document.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('Change build')
  expect([...document.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('Choose another folder')
  expect(button('Check again')).toBeUndefined()
  expect(button('Use CPU only')).toBeUndefined()
  expect(button('Set up')).toBeUndefined()
})

it.each(['win-nvidia-cu126', 'linux-cpu', 'unlisted-build'])('labels a running %s job without exposing identifiers and groups matching cards', async (variant) => {
  vi.useFakeTimers()
  const card = { id: '0', name: 'NVIDIA GeForce RTX 4090', driver: '595.84', computeCapability: '8.9', memoryMiB: 24564 }
  const current = { ...plan, detectedCards: [card, { ...card, id: '1', name: 'NVIDIA GeForce RTX 3090' }, { ...card, id: '2' }],
    choices: [...plan.choices!, { variant: 'win-nvidia-cu126', vendor: 'nvidia', gpus: ['0', '1', '2'], label: 'NVIDIA graphics, older drivers', reason: 'Needs NVIDIA driver 525 or newer.' }] }
  vi.stubGlobal('fetch', async () => answer({ plan: current, activeJob: { ...job, variant } }))
  dispose = render(() => <SetupForm surface="projects" />, document.body)
  await vi.advanceTimersByTimeAsync(0)
  const facts = document.querySelector('.setup-facts')!
  expect([...facts.querySelectorAll('p')].map((node) => node.textContent)).toEqual(variant === 'win-nvidia-cu126' ? ['2 x NVIDIA GeForce RTX 4090', 'NVIDIA GeForce RTX 3090'] : [])
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
  expect(document.body.textContent).toContain('About 6.5 GB - 4.7 GB free')
  expect(document.querySelector('[role="note"]')?.textContent).toBe('This needs about 6.5 GB and the disk has 4.7 GB free.')
  expect(button('Set up').disabled).toBe(false)
  for (const [update, expected] of [
    [{ freeBytes: 7000000000 }, 'About 6.5 GB - 6.5 GB free'],
    [{ downloadBytes: 3000000000 }, '2.8 GB - 6.5 GB free'],
    [{ downloadBytes: null, downloadEstimate: null }, 'At least 2 KB - 6.5 GB free'],
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
    expect(document.body.textContent).toContain('At least 2 KB - 8.8 KB free')
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
  ['downloading', 'bytes', 0, 4096, 'Downloading Dinkster - 0 B of 4 KB'],
  ['downloading', 'bytes', 2048, 4096, 'Downloading Dinkster - 2 KB of 4 KB'],
  ['checking-reviewed-inputs', 'items', 3, 12, 'Installing the standard node packs'],
  ['future-stage', 'bytes', 2048, null, 'Setting up - 2 KB'],
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

it.each(['unavailable', 'installed', 'remote', 'unknown', 'standalone'] as const)('does not offer local setup for an %s editor backend', async (state) => {
  vi.useFakeTimers()
  const fetch = vi.fn(async (url: string) => answer(url.startsWith('/supervisor/setup')
    ? { plan, activeJob: null }
    : url.includes('installations')
    ? state === 'unknown' ? {} : { installations: state === 'standalone' ? [] : [{ root: '/existing' }] }
    : { state: 'ready', ...(state === 'standalone' ? {} : { role: 'home' }) }, state === 'unavailable' ? 404 : 200))
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
    return answer(url.includes('installations') ? { installations: [{ root: job.root }] } : { role: 'home', state: 'stopped' })
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
    return answer(url.includes('installations') ? { installations: [] } : { role: 'home', state: 'stopped' })
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
