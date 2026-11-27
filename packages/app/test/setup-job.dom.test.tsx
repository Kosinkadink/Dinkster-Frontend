// @vitest-environment happy-dom

import { createRoot } from 'solid-js'
import { afterEach, expect, it, vi } from 'vitest'
import { createSetupController, type SetupJob, type SetupPlan } from '../src/setup-job.js'
import '../src/locale.js'

const plan: SetupPlan = {
  id: 'plan-1', root: '/install/nightly', channel: 'nightly', variant: 'linux-nvidia',
  buildLabel: 'NVIDIA graphics card build', buildReason: 'Supported graphics card',
  engineRelease: 'release-1', baseId: 'base-1', detectedCards: [], choices: [], gpus: ['0'],
  downloadBytes: null, runtimeDownloadBytes: 0, freeBytes: 9000, refusal: null,
}
const running: SetupJob = {
  id: 'job-1', root: plan.root, channel: 'nightly', variant: 'linux-nvidia',
  state: 'running', progress: null, error: null, installation: null,
}
const answer = (body: unknown, status = 200) => Response.json(body, { status })
const tick = async () => { await vi.advanceTimersByTimeAsync(0) }
let dispose: (() => void) | undefined
afterEach(() => { dispose?.(); vi.unstubAllGlobals(); vi.useRealTimers() })

function controller(options?: Parameters<typeof createSetupController>[0]) {
  return createRoot((stop) => { dispose = stop; return createSetupController(options) })
}

it('discovers the retained job even when planning is refused and preserves unknown facts', async () => {
  vi.useFakeTimers()
  const refused = { ...plan, runtimeDownloadBytes: null, detectedCards: null, choices: null,
    refusal: { code: 'library-held', message: 'Stop the other installation first.' } }
  vi.stubGlobal('fetch', vi.fn(async () => answer({ plan: refused, activeJob: running })))
  const setup = controller()
  await tick()
  expect(setup.plan()).toEqual(refused)
  expect(setup.job()).toEqual(running)
  expect(setup.canStart()).toBe(false)
  await setup.start()
  expect(setup.job()?.id).toBe('job-1')
})

it('replans a typed folder and never starts the old plan after a refused replan', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return answer(running, 202)
    return answer({ plan, activeJob: null })
  })
  vi.stubGlobal('fetch', fetch)
  const setup = controller()
  await tick()
  expect(setup.plan()?.runtimeDownloadBytes).toBe(0)
  fetch.mockImplementationOnce(async () => answer({ error: 'invalid-root', message: 'Use an absolute path.' }, 400))
  await setup.refresh({ root: 'relative' })
  expect(setup.error()?.code).toBe('invalid-root')
  expect(setup.error()?.message).toBe('The action could not be completed. Use an absolute path.')
  expect(setup.canStart()).toBe(false)
  await setup.start()
  expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  fetch.mockImplementationOnce(async () => answer({ plan: { ...plan, id: 'plan-2', root: '/new folder' }, activeJob: null }))
  await setup.refresh({ root: '/new folder' })
  expect(setup.plan()?.root).toBe('/new folder')
  expect(setup.canStart()).toBe(true)
  await setup.start()
  const start = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!
  expect(JSON.parse(start[1]!.body as string)).toEqual({ planId: 'plan-2' })
})

it('recovers a successful start with a lost reply without submitting another job', async () => {
  vi.useFakeTimers()
  let started = false
  let posts = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; started = true; throw new Error('Reply lost') }
    return answer({ plan, activeJob: started ? running : null })
  }))
  const setup = controller()
  await tick()
  await setup.start()
  expect(setup.job()).toEqual(running)
  expect(setup.error()?.message).toBe('The action could not be completed. The engine did not answer.')
  expect(setup.canStart()).toBe(false)
  await setup.start()
  expect(posts).toBe(1)
})

it.each(['completed', 'cancelled'] as const)('keeps cancellation pending until cleanup reports %s', async (terminal) => {
  vi.useFakeTimers()
  let state: SetupJob = running
  const installation = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') state = { ...running, state: 'cancelling' }
    return answer(url.includes('?') ? { plan, activeJob: state } : state)
  }))
  const setup = controller({ onInstallation: installation })
  await tick()
  await setup.cancel()
  expect(setup.job()?.state).toBe('cancelling')
  expect(setup.canStart()).toBe(false)
  await vi.advanceTimersByTimeAsync(750)
  expect(setup.job()?.state).toBe('cancelling')
  state = { ...running, state: terminal, installation: terminal === 'completed' ? { root: plan.root, engine: 'main' } : null }
  await vi.advanceTimersByTimeAsync(750)
  expect(setup.job()?.state).toBe(terminal)
  if (terminal === 'completed') {
    expect(installation).toHaveBeenCalledExactlyOnceWith({ root: plan.root, engine: 'main' })
    expect(setup.canStart()).toBe(false)
  } else expect(installation).not.toHaveBeenCalled()
  await setup.refresh()
  await tick()
  expect(installation).toHaveBeenCalledTimes(terminal === 'completed' ? 1 : 0)
})

it('ignores an older folder plan that arrives after the newest one', async () => {
  vi.useFakeTimers()
  let finishOld!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('root=old')) return new Promise<Response>(resolve => { finishOld = resolve })
    return answer({ plan: { ...plan, root: url.includes('root=new') ? '/new' : plan.root }, activeJob: null })
  }))
  const setup = controller()
  await tick()
  const old = setup.refresh({ root: 'old' })
  await setup.refresh({ root: 'new' })
  finishOld(answer({ plan: { ...plan, root: '/old' }, activeJob: null }))
  await old
  expect(setup.plan()?.root).toBe('/new')
  expect(setup.canStart()).toBe(true)
})
