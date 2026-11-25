import { createEffect, createSignal, onCleanup } from 'solid-js'

export interface SetupProblem {
  readonly code: string
  readonly message: string
}

export interface SetupPlan {
  readonly id: string
  readonly root: string
  readonly channel: 'nightly' | 'stable'
  readonly variant: string | null
  readonly buildLabel: string | null
  readonly buildReason: string | null
  readonly engineRelease: string | null
  readonly baseId: string | null
  readonly detectedCards: readonly {
    readonly id: string
    readonly name: string
    readonly driver: string | null
    readonly computeCapability: string | null
    readonly memoryMiB: number | null
  }[] | null
  readonly choices: readonly { readonly variant: string; readonly label: string; readonly reason: string }[] | null
  readonly gpus: readonly string[]
  readonly downloadBytes: number | null
  readonly runtimeDownloadBytes: number | null
  readonly freeBytes: number
  readonly refusal: SetupProblem | null
}

export interface SetupJob {
  readonly id: string
  readonly root: string
  readonly channel: 'nightly' | 'stable'
  readonly variant: string
  readonly state: 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed'
  readonly progress: null | {
    readonly stage: string
    readonly completed: number
    readonly total: number | null
    readonly unit: 'bytes' | 'items'
  }
  readonly error: SetupProblem | null
  readonly installation: null | { readonly root: string; readonly engine: 'main' }
}

export interface SetupQuery {
  readonly root?: string
  readonly channel?: 'nightly' | 'stable'
  readonly variant?: string
}

class SetupRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

const problem = (error: unknown): SetupProblem => ({
  code: error instanceof SetupRequestError ? error.code : 'connection-failed',
  message: error instanceof Error ? error.message : String(error),
})

export const setupJobActive = (job: SetupJob | null | undefined): boolean =>
  job?.state === 'running' || job?.state === 'cancelling'

/** The same process-owned job is discovered by either first-run screen. */
export function createSetupController(options: {
  readonly onInstallation?: (installation: NonNullable<SetupJob['installation']>) => void
  readonly onLostJob?: () => void
} = {}) {
  const [plan, setPlan] = createSignal<SetupPlan>()
  const [job, setJob] = createSignal<SetupJob | null>(null)
  const [planning, setPlanning] = createSignal(false)
  const [changing, setChanging] = createSignal(false)
  const [reviewed, setReviewed] = createSignal(false)
  const [error, setError] = createSignal<SetupProblem>()
  let query: SetupQuery = {}
  let generation = 0
  let disposed = false
  const requests = new Set<AbortController>()
  const completed = new Set<string>()

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const abort = new AbortController()
    requests.add(abort)
    try {
      const response = await fetch(`/supervisor/setup${path}`, { ...init, cache: 'no-store', signal: abort.signal })
      const body = await response.json()
      if (!response.ok) throw new SetupRequestError(body.error, body.message)
      return body as T
    } finally {
      requests.delete(abort)
    }
  }

  async function refresh(next: SetupQuery = query): Promise<void> {
    query = next
    const current = ++generation
    setReviewed(false)
    setPlanning(true)
    setError(undefined)
    try {
      const params = new URLSearchParams()
      if (next.root !== undefined) params.set('root', next.root)
      if (next.channel !== undefined) params.set('channel', next.channel)
      if (next.variant !== undefined) params.set('variant', next.variant)
      const result = await request<{ plan: SetupPlan; activeJob: SetupJob | null }>(`?${params}`)
      if (disposed || current !== generation) return
      setPlan(result.plan)
      setJob(result.activeJob)
      setReviewed(true)
    } catch (failure) {
      if (!disposed && current === generation) setError(problem(failure))
    } finally {
      if (!disposed && current === generation) setPlanning(false)
    }
  }

  const canStart = () => reviewed() && !planning() && !changing() && !setupJobActive(job()) &&
    job()?.state !== 'completed' && plan()?.variant != null && plan()?.refusal === null

  async function start(): Promise<void> {
    if (!canStart()) return
    setChanging(true)
    setError(undefined)
    try {
      const result = await request<SetupJob>('', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ planId: plan()!.id }),
      })
      if (!disposed) setJob(result)
    } catch (failure) {
      // A lost reply may hide a successful start. Discover it; never repeat POST.
      if (!disposed) {
        await refresh()
        if (!disposed) setError(problem(failure))
      }
    } finally {
      if (!disposed) setChanging(false)
    }
  }

  async function cancel(): Promise<void> {
    const current = job()
    if (!current || !setupJobActive(current) || current.state === 'cancelling' || changing()) return
    setChanging(true)
    setError(undefined)
    try {
      const result = await request<SetupJob>(`/${encodeURIComponent(current.id)}`, { method: 'DELETE' })
      if (!disposed) setJob(result)
    } catch (failure) {
      if (!disposed) setError(problem(failure))
    } finally {
      if (!disposed) setChanging(false)
    }
  }

  createEffect(() => {
    const current = job()
    if (current?.state === 'completed' && current.installation && !completed.has(current.id)) {
      completed.add(current.id)
      options.onInstallation?.(current.installation)
    }
    if (!current || !setupJobActive(current) || changing() || planning()) return
    let stale = false
    const timer = setTimeout(() => {
      void request<SetupJob>(`/${encodeURIComponent(current.id)}`).then((result) => {
        if (!stale) setJob(result)
      }).catch((failure: unknown) => {
        if (stale) return
        setError(problem(failure))
        if (failure instanceof SetupRequestError && failure.code === 'unknown-job') {
          setJob(null)
          options.onLostJob?.()
          void refresh()
        } else {
          setJob({ ...current })
        }
      })
    }, 750)
    onCleanup(() => { stale = true; clearTimeout(timer) })
  })

  onCleanup(() => {
    disposed = true
    generation++
    for (const request of requests) request.abort()
  })
  void refresh()
  return { plan, job, planning, changing, error, canStart, refresh, start, cancel }
}
