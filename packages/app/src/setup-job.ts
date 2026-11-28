import { createEffect, createSignal, onCleanup } from 'solid-js'
import { createPageLoad } from '@dinkster/ui'
import { RequestFailure, requestFetch, requestFailure } from '@dinkster/client'
import { failureMessage } from './request-failure.js'

const fetchRequest = requestFetch((url, init) => fetch(url, init))

export interface SetupProblem {
  readonly code: string
  readonly message: string
}

export interface UnusableGraphicsCard {
  readonly id: string
  readonly name: string | null
  readonly vendor: 'nvidia' | 'amd' | 'intel' | null
  readonly reason: 'driver-too-old' | 'card-too-old' | 'detection-tool-missing' | 'detection-tool-failed' | 'no-published-build'
  readonly minimumDriver?: string
  readonly driver?: string | null
  readonly tool?: string
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
  readonly buildDetails?: {
    readonly python: string
    readonly pytorch: string
    readonly cuda: string | null
    readonly dinkster: string
  } | null
  readonly detectedCards: readonly {
    readonly id: string
    readonly name: string
    readonly vendor?: 'nvidia' | 'amd' | 'intel'
    readonly driver: string | null
    readonly computeCapability: string | null
    readonly memoryMiB: number | null
  }[] | null
  readonly unusableCards?: readonly UnusableGraphicsCard[]
  readonly system?: 'windows' | 'linux' | 'macos' | null
  readonly graphicsVendor?: 'nvidia' | 'amd' | 'intel' | null
  readonly choices: readonly {
    readonly variant: string
    readonly label: string
    readonly reason: string
    readonly vendor?: 'nvidia' | 'amd' | 'intel' | null
    readonly gpus?: readonly string[]
  }[] | null
  readonly gpus: readonly string[]
  readonly downloadBytes: number | null
  readonly downloadEstimate?: { readonly kind: 'upper-bound'; readonly bytes: number; readonly reason: string } | null
  readonly runtimeDownloadBytes: number | null
  readonly freeBytes: number
  readonly refusal: SetupProblem | null
}

export interface SetupJob {
  readonly id: string
  readonly root: string
  readonly operation?: 'setup' | 'update' | 'restore' | 'check' | 'cleanup'
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

class SetupRequestError extends RequestFailure {
  constructor(readonly code: string, failure: RequestFailure) {
    super(failure.method, failure.path, failure.status, failure.serverMessage)
  }
}

const problem = (error: unknown): SetupProblem => ({
  code: error instanceof SetupRequestError ? error.code : 'connection-failed',
  message: failureMessage(error),
})

export const setupJobActive = (job: SetupJob | null | undefined): boolean =>
  job?.state === 'running' || job?.state === 'cancelling'

/** Registration can precede completion; a listed installation may still be setting up. */
export async function setupInProgress(): Promise<boolean> {
  try {
    const response = await fetchRequest('/supervisor/setup/active', { cache: 'no-store' })
    if (!response.ok) return false
    const job = (await response.json()).activeJob as SetupJob | null
    return (!job?.operation || job.operation === 'setup') && setupJobActive(job)
  } catch {
    return false
  }
}

/** The same process-owned job is discovered by either first-run screen. */
export function createSetupController(options: {
  readonly onInstallation?: (installation: NonNullable<SetupJob['installation']>) => void
  readonly onLostJob?: () => void
} = {}) {
  const page = createPageLoad<SetupPlan>()
  const plan = page.value
  const [activeJob, setJob] = createSignal<SetupJob | null>(null)
  const job = () => {
    const current = activeJob()
    return current?.operation && current.operation !== 'setup' ? null : current
  }
  const planning = page.pending
  const [changing, setChanging] = createSignal(false)
  const [requestError, setError] = createSignal<SetupProblem>()
  const error = () => requestError() ?? (page.error() ? problem(page.error()) : undefined)
  let query: SetupQuery = {}
  let generation = 0
  let disposed = false
  const requests = new Set<AbortController>()
  const completed = new Set<string>()

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const abort = new AbortController()
    requests.add(abort)
    try {
      const response = await fetchRequest(`/supervisor/setup${path}`, { ...init, cache: 'no-store', signal: abort.signal })
      if (!response.ok) {
        const body = await response.clone().json().catch(() => undefined)
        throw new SetupRequestError(body?.error ?? 'connection-failed', await requestFailure(response))
      }
      const body = await response.json()
      return body as T
    } finally {
      requests.delete(abort)
    }
  }

  async function readPlan(next: SetupQuery = query): Promise<SetupPlan> {
    query = next
    const current = ++generation
    setError(undefined)
    const params = new URLSearchParams()
    if (next.root !== undefined) params.set('root', next.root)
    if (next.channel !== undefined) params.set('channel', next.channel)
    if (next.variant !== undefined) params.set('variant', next.variant)
    const result = await request<{ plan: SetupPlan; activeJob: SetupJob | null }>(`?${params}`)
    if (!disposed && current === generation) setJob(result.activeJob)
    return result.plan
  }

  const refresh = (next: SetupQuery = query) => page.load(() => readPlan(next))

  const canStart = () => !page.error() && !planning() && !changing() && !setupJobActive(activeJob()) &&
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
    const current = activeJob()
    const ownJob = !current?.operation || current.operation === 'setup'
    if (ownJob && current?.state === 'completed' && current.installation && !completed.has(current.id)) {
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
        if (ownJob) setError(problem(failure))
        if (failure instanceof SetupRequestError && failure.code === 'unknown-job') {
          setJob(null)
          if (ownJob) options.onLostJob?.()
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
  return { page, readPlan, plan, job, planning, changing, error, canStart, refresh, start, cancel }
}
