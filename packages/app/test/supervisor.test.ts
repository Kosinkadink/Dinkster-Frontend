/**
 * Supervisor poll loop tests for the "Dinkster is starting" lifecycle.
 * Injected probe + scheduler make every case
 * deterministic: absent stops for good, unreachable retries slowly only
 * while the WS is also down, starting/failed/stopped keep narrating,
 * ready states remain watched for later engine death, and the ready
 * transition fires onReady exactly once so the
 * app can retry a 503-gated schema fetch.
 */
import { describe, expect, it } from 'vitest'
import type { SupervisorProbe, SupervisorStatus } from '@dinkster/client'
import { POLL_MS, pollSupervisor } from '../src/supervisor-poll.js'

/** Let pending probe promises settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const status = (state: SupervisorStatus['state'], extra?: Partial<SupervisorStatus>): SupervisorProbe => ({
  kind: 'status',
  status: { protocol: 1, state, ...extra },
})

interface Harness {
  readonly set: SupervisorStatus | undefined
  readonly scheduled: { fn: () => void; ms: number }[]
  readonly readyCalls: number
  readonly probes: number
  cancel: () => void
  /** Run the next scheduled poll step and settle it. */
  tick: () => Promise<void>
}

const harness = (
  results: SupervisorProbe[],
  opts?: { connected?: () => boolean },
): Harness => {
  const state = {
    set: undefined as SupervisorStatus | undefined,
    scheduled: [] as { fn: () => void; ms: number }[],
    readyCalls: 0,
    probes: 0,
    cancel: () => {},
    tick: async () => {
      const next = state.scheduled.shift()
      if (!next) throw new Error('nothing scheduled')
      next.fn()
      await flush()
    },
  }
  state.cancel = pollSupervisor({
    probe: async () => {
      state.probes += 1
      const probe = results.shift()
      if (!probe) throw new Error('probe called past the scripted results')
      return probe
    },
    connected: opts?.connected ?? (() => false),
    get: () => state.set,
    set: (s) => {
      state.set = s
    },
    onReady: () => {
      state.readyCalls += 1
    },
    schedule: (fn, ms) => {
      state.scheduled.push({ fn, ms })
      return state.scheduled.length
    },
    cancel: () => {},
  })
  return state
}

describe('pollSupervisor', () => {
  it('absent (standalone dinkster-serve): clears and stops for good', async () => {
    const h = harness([{ kind: 'absent' }])
    await flush()
    expect(h.set).toBeUndefined()
    expect(h.scheduled).toHaveLength(0)
    expect(h.probes).toBe(1)
  })

  it('unreachable while disconnected: keeps a slow probe going', async () => {
    const h = harness([
      { kind: 'unreachable', error: 'ECONNREFUSED' },
      status('starting', { detail: 'spawning engine' }),
    ])
    await flush()
    expect(h.scheduled[0]?.ms).toBe(POLL_MS.unreachable)
    await h.tick()
    expect(h.set?.state).toBe('starting')
    expect(h.set?.detail).toBe('spawning engine')
  })

  it('unreachable while the WS is connected: stops (no supervisor to find)', async () => {
    const h = harness([{ kind: 'unreachable', error: 'nope' }], { connected: () => true })
    await flush()
    expect(h.set).toBeUndefined()
    expect(h.scheduled).toHaveLength(0)
  })

  it('FR10 rejected probe is contained and the poll keeps running', async () => {
    const scheduled: { fn: () => void; ms: number }[] = []
    let probes = 0
    let current: SupervisorStatus | undefined
    pollSupervisor({
      probe: async () => {
        probes += 1
        if (probes === 1) throw new Error('unexpected probe bug')
        return status('starting')
      },
      connected: () => false,
      get: () => current,
      set: (value) => { current = value },
      onReady: () => {},
      schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length },
      cancel: () => {},
    })
    await flush()
    expect(scheduled[0]?.ms).toBe(POLL_MS.unreachable)
    scheduled.shift()!.fn()
    await flush()
    expect(probes).toBe(2)
    expect(current?.state).toBe('starting')
  })

  it('FR10 a rejected probe while connected clears status like unreachable', async () => {
    const scheduled: { fn: () => void; ms: number }[] = []
    let current: SupervisorStatus | undefined = { protocol: 1, state: 'ready' }
    pollSupervisor({
      probe: async () => { throw new Error('unexpected probe bug') },
      connected: () => true,
      get: () => current,
      set: (value) => { current = value },
      onReady: () => {},
      schedule: (fn, ms) => { scheduled.push({ fn, ms }); return scheduled.length },
      cancel: () => {},
    })
    await flush()
    expect(current).toBeUndefined()
    expect(scheduled).toHaveLength(0)
  })

  it('starting -> ready without progress: fires onReady and keeps watching', async () => {
    const h = harness([status('starting'), status('ready'), status('ready')])
    await flush()
    expect(h.set?.state).toBe('starting')
    expect(h.scheduled[0]?.ms).toBe(POLL_MS.starting)
    await h.tick()
    expect(h.set?.state).toBe('ready')
    expect(h.readyCalls).toBe(1)
    expect(h.scheduled[0]?.ms).toBe(POLL_MS.ready)
    await h.tick()
    expect(h.readyCalls).toBe(1)
  })

  it('ready with progress: keeps polling until composition clears', async () => {
    const h = harness([
      status('ready', { progress: { done: 2, total: 5, phase: 'packs' } }),
      status('ready', { progress: { done: 4, total: 5 } }),
      status('ready'),
    ])
    await flush()
    expect(h.set?.progress).toEqual({ done: 2, total: 5, phase: 'packs' })
    expect(h.readyCalls).toBe(1)
    await h.tick()
    expect(h.set?.progress).toEqual({ done: 4, total: 5 })
    expect(h.readyCalls).toBe(1) // still the same ready, not a new transition
    await h.tick()
    expect(h.set?.progress).toBeUndefined()
    expect(h.scheduled[0]?.ms).toBe(POLL_MS.ready)
  })

  it('failed: slow cadence, and a later ready fires onReady again', async () => {
    const h = harness([
      status('failed', { detail: 'engine exited during startup (exit code 3)' }),
      status('starting'),
      status('ready'),
    ])
    await flush()
    expect(h.set?.state).toBe('failed')
    expect(h.scheduled[0]?.ms).toBe(POLL_MS.failed)
    await h.tick()
    expect(h.set?.state).toBe('starting')
    await h.tick()
    expect(h.set?.state).toBe('ready')
    expect(h.readyCalls).toBe(1)
  })

  it('stopped: keeps narrating at the slow cadence', async () => {
    const h = harness([status('stopped'), status('stopped')])
    await flush()
    expect(h.set?.state).toBe('stopped')
    expect(h.scheduled[0]?.ms).toBe(POLL_MS.stopped)
    await h.tick()
    expect(h.scheduled[0]?.ms).toBe(POLL_MS.stopped)
  })

  it('ready -> failed -> starting -> ready surfaces death and recovery', async () => {
    const h = harness([
      status('ready'),
      status('failed', { detail: 'engine exited with code 3' }),
      status('starting'),
      status('ready'),
    ])
    await flush()
    expect(h.set?.state).toBe('ready')
    await h.tick()
    expect(h.set).toMatchObject({ state: 'failed', detail: 'engine exited with code 3' })
    await h.tick()
    expect(h.set?.state).toBe('starting')
    await h.tick()
    expect(h.set?.state).toBe('ready')
    expect(h.readyCalls).toBe(2)
  })

  it('cancel stops future steps, including one already scheduled', async () => {
    const h = harness([status('starting'), status('ready')])
    await flush()
    expect(h.scheduled).toHaveLength(1)
    h.cancel()
    h.scheduled[0]!.fn() // fires, but the loop is cancelled
    await flush()
    expect(h.set?.state).toBe('starting') // never advanced to ready
    expect(h.readyCalls).toBe(0)
  })

  it('cancel during an in-flight probe drops the answer', async () => {
    let resolve!: (p: SupervisorProbe) => void
    const gate = new Promise<SupervisorProbe>((r) => {
      resolve = r
    })
    let set: SupervisorStatus | undefined
    const cancel = pollSupervisor({
      probe: () => gate,
      connected: () => false,
      get: () => set,
      set: (s) => {
        set = s
      },
      onReady: () => {},
      schedule: () => 0,
      cancel: () => {},
    })
    cancel()
    resolve({ kind: 'status', status: { protocol: 1, state: 'ready' } })
    await flush()
    expect(set).toBeUndefined()
  })
})
