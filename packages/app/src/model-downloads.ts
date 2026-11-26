import { createSignal, type ReadonlySignal } from '@dinkster/core'
import { ModelDownloadBusyError, type DinksterConnection, type ModelDownloadJob, type ModelDownloadPlan, type ModelDownloadRequirement, type ModelDownloadSelection } from '@dinkster/client'

export interface ModelDownloadState {
  readonly requirement: ModelDownloadRequirement
  readonly source?: string
  readonly pending: boolean
  readonly queued?: boolean
  readonly plan?: ModelDownloadPlan
  readonly job?: ModelDownloadJob
  readonly interrupted?: boolean
  readonly error?: string
}

type Connection = Pick<DinksterConnection, 'planModelDownload' | 'startModelDownload' | 'fetchModelDownloads' | 'fetchModelDownload' | 'cancelModelDownload'>
const keyOf = (requirement: ModelDownloadRequirement): string => JSON.stringify([requirement.name, requirement.kind, requirement.asset?.digest])
const active = (job: ModelDownloadJob): boolean => !['completed', 'cancelled', 'failed'].includes(job.status)

/** Transfers belong to a connection/project, not to an open dialog or workflow. */
export class ModelDownloadsController {
  private readonly state = createSignal<readonly ModelDownloadState[]>([])
  readonly rows: ReadonlySignal<readonly ModelDownloadState[]> = this.state
  private readonly observation = new AbortController()
  private planning: Promise<void> = Promise.resolve()
  private readonly starting = new Map<ModelDownloadState, { invalidated: boolean }>()
  private pumping = false
  private poll: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly connection: Connection, private readonly project: string) {}

  ensure(requirements: readonly ModelDownloadRequirement[], missing = false): void {
    if (this.disposed) return
    if (missing) for (const requirement of requirements) {
      const row = this.row(requirement)
      if (row?.job?.status === 'completed' || row?.plan?.status === 'local') this.invalidate(requirement)
    }
    const keys = new Set(this.state.get().map((row) => keyOf(row.requirement)))
    const added = requirements.filter((requirement) => {
      const key = keyOf(requirement)
      if (keys.has(key)) return false
      keys.add(key)
      return true
    })
    if (added.length) this.state.update((rows) => [...rows, ...added.map((requirement) => ({ requirement, pending: false }))])
  }

  private row(requirement: ModelDownloadRequirement): ModelDownloadState | undefined {
    const key = keyOf(requirement)
    return this.state.get().find((row) => keyOf(row.requirement) === key)
  }

  private update(previous: ModelDownloadState, next: ModelDownloadState): boolean {
    if (this.disposed || this.row(previous.requirement) !== previous) return false
    this.state.update((rows) => rows.map((row) => row === previous ? next : row))
    return true
  }

  private matches(job: ModelDownloadSelection, requirement: ModelDownloadRequirement): boolean {
    return job.project === this.project && job.name === requirement.name && job.kind === requirement.kind &&
      job.digest === requirement.asset?.digest
  }

  setSource(requirement: ModelDownloadRequirement, source: string): void {
    const row = this.row(requirement)
    if (!row || row.pending || row.queued || (row.job && active(row.job))) return
    this.update(row, { requirement: row.requirement, source, pending: false,
      ...(row.plan?.status === 'picker-required' ? { plan: row.plan } : {}),
    })
  }

  invalidate(requirement: ModelDownloadRequirement): void {
    const row = this.row(requirement)
    if (!row) return
    const start = this.starting.get(row)
    if (start) { start.invalidated = true; return }
    if (row.job && active(row.job)) return
    this.update(row, { requirement: row.requirement, pending: false,
      ...(row.source === undefined ? {} : { source: row.source }),
    })
  }

  async enableLocation(requirement: ModelDownloadRequirement, location: string, enable: (location: string) => Promise<void>): Promise<void> {
    const row = this.row(requirement)
    if (!row || row.pending || row.queued || this.disposed || row.plan?.status !== 'folder-disabled' ||
      !row.plan.disabledLocations.includes(location) || (row.job && active(row.job))) return
    const pending = { ...row, pending: true }
    if (!this.update(row, pending)) return
    try {
      await enable(location)
      if (this.update(pending, { requirement: row.requirement, pending: false,
        ...(row.source === undefined ? {} : { source: row.source }),
      })) await this.review(requirement)
    } catch (error) {
      this.update(pending, { ...row, pending: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Plans serialize because the engine admits only one provider lookup at a time. */
  review(requirement: ModelDownloadRequirement): Promise<void> {
    const row = this.row(requirement)
    if (!row || row.pending || row.queued || this.disposed) return Promise.resolve()
    const pending = { ...row, pending: true }
    if (!this.update(row, pending)) return Promise.resolve()
    const action = async (): Promise<void> => {
      if (this.disposed || this.row(requirement) !== pending) return
      try {
        if (row.job && active(row.job)) {
          const job = await this.connection.fetchModelDownload(row.job.jobId, this.observation.signal)
          if (job && !this.matches(job, requirement)) throw new Error('Model job no longer matches the captured project and requirement')
          this.update(pending, { requirement: row.requirement, pending: false,
            ...(row.source === undefined ? {} : { source: row.source }),
            ...(job ? { job } : { interrupted: true }),
          })
          this.schedulePoll()
          return
        }
        const { jobs } = await this.connection.fetchModelDownloads(this.observation.signal)
        const job = [...jobs].reverse().find((job) => this.matches(job, requirement) && active(job))
        const base = { requirement: row.requirement, pending: false,
          ...(row.source === undefined ? {} : { source: row.source }),
        }
        if (job) this.update(pending, { ...base, job })
        else {
          const plan = await this.connection.planModelDownload(requirement, this.observation.signal, row.source || undefined)
          if (plan.status === 'consent-required' && !this.matches(plan, requirement))
            throw new Error('Model plan does not match the captured project and requirement')
          this.update(pending, { ...base, plan })
        }
      } catch (error) {
        this.update(pending, { requirement: row.requirement, pending: false,
          ...(row.source === undefined ? {} : { source: row.source }),
          ...(row.job && active(row.job) ? { job: row.job } : {}),
          error: error instanceof Error ? error.message : String(error),
        })
      }
      this.schedulePoll()
    }
    const next = this.planning.then(action)
    this.planning = next
    return next
  }

  download(requirements: readonly ModelDownloadRequirement[]): Promise<void> {
    for (const requirement of requirements) {
      const row = this.row(requirement)
      if (!row || row.pending || row.queued || row.plan?.status !== 'consent-required' || (row.job && active(row.job))) continue
      this.update(row, { ...row, queued: true })
    }
    return this.pump()
  }

  private async pump(observedJobs?: readonly ModelDownloadJob[]): Promise<void> {
    if (this.pumping || this.disposed) return
    this.pumping = true
    try {
      const jobs = observedJobs ?? (await this.connection.fetchModelDownloads(this.observation.signal)).jobs
      const running = jobs.filter(active)
      for (const queued of this.state.get()) {
        if (!queued.queued || queued.plan?.status !== 'consent-required') continue
        if (running.length >= 4) break
        const plan = queued.plan
        if (running.some((job) => (job.project === plan.project && job.mount === plan.mount) ||
          job.destination.replace(/[\\/][^\\/]*$/, '') === plan.destination.replace(/[\\/][^\\/]*$/, ''))) continue
        const pending = { ...queued, queued: false, pending: true }
        const start = { invalidated: false }
        this.starting.set(pending, start)
        if (!this.update(queued, pending)) { this.starting.delete(pending); continue }
        try {
          const job = await this.connection.startModelDownload(plan.planId, this.observation.signal)
          if (!this.matches(job, queued.requirement)) throw new Error('Model job does not match the captured project and requirement')
          running.push(job)
          this.update(pending, { requirement: queued.requirement, pending: false, job,
            ...(queued.source === undefined ? {} : { source: queued.source }),
          })
        } catch (error) {
          if (error instanceof ModelDownloadBusyError) {
            this.update(pending, start.invalidated ? { requirement: queued.requirement, pending: false,
              ...(queued.source === undefined ? {} : { source: queued.source }),
            } : queued)
            continue
          }
          // A failed start may have reached the server. A retry must discover jobs before planning again.
          this.update(pending, { requirement: queued.requirement, pending: false, interrupted: true,
            ...(queued.source === undefined ? {} : { source: queued.source }),
            error: error instanceof Error ? error.message : String(error),
          })
        } finally {
          this.starting.delete(pending)
        }
      }
    } catch {
      // Retain explicit queued consent on a failed observation; discovery must succeed before any start.
    } finally {
      this.pumping = false
      this.schedulePoll()
    }
  }

  async cancel(requirement: ModelDownloadRequirement): Promise<void> {
    const row = this.row(requirement)
    if (!row || row.pending || this.disposed) return
    if (row.queued) { this.update(row, { ...row, queued: false }); return }
    if (!row.job || !['starting', 'checking-existing', 'downloading'].includes(row.job.status)) return
    const pending = { ...row, pending: true }
    if (!this.update(row, pending)) return
    try {
      const job = await this.connection.cancelModelDownload(row.job.jobId, this.observation.signal)
      if (!this.matches(job, requirement)) throw new Error('Model job no longer matches the captured project and requirement')
      this.update(pending, { ...row, pending: false, job })
    } catch (error) {
      this.update(pending, { ...row, pending: false, error: error instanceof Error ? error.message : String(error) })
    }
    this.schedulePoll()
  }

  private schedulePoll(): void {
    clearTimeout(this.poll)
    if (!this.disposed && this.state.get().some((row) => row.queued || (row.job && active(row.job))))
      this.poll = setTimeout(() => { void this.refresh() }, 1000)
  }

  async refresh(): Promise<void> {
    if (this.disposed) return
    const observed = this.state.get()
    try {
      const { jobs } = await this.connection.fetchModelDownloads(this.observation.signal)
      for (const row of observed) {
        if (!row.job || row.pending || !active(row.job)) continue
        const job = jobs.find((entry) => entry.jobId === row.job!.jobId && this.matches(entry, row.requirement))
        this.update(row, job ? { ...row, job } : { requirement: row.requirement, pending: false, interrupted: true,
          ...(row.source === undefined ? {} : { source: row.source }),
          error: 'The engine no longer has this download. Try again to check the file.',
        })
      }
      await this.pump(jobs)
    } catch {
      // Keep the last observation on disconnect; never start another transfer until discovery succeeds.
    }
    this.schedulePoll()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.poll)
    this.observation.abort()
  }
}
